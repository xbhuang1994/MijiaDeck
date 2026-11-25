// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 涂鸦 Home Assistant Device Sharing 客户端 (tuya-device-sharing-sdk 协议)

import { randomUUID } from "node:crypto";
import type { TuyaTokenSession } from "../configStore.ts";
import {
  TUYA_CLIENT_ID,
  TUYA_SCHEMA,
  TUYA_SHARING_AUTH_ENDPOINT,
  TUYA_SHARING_QR_PREFIX,
} from "./constants.ts";
import {
  tuyaSharingAesGcmDecrypt,
  tuyaSharingAesGcmEncrypt,
  tuyaSharingHashKey,
  tuyaSharingRestfulSign,
  tuyaSharingSecret,
} from "./crypto.ts";

export interface TuyaStatusItem {
  code: string;
  value: unknown;
}

export interface TuyaCommandItem {
  code: string;
  value: unknown;
}

export interface TuyaSpecFunctionItem {
  code: string;
  dp_id?: number;
  name?: string;
  desc?: string;
  type: string; // Boolean | Integer | Enum | String | Json | Raw
  values: string; // JSON string
}

export interface TuyaDeviceSpecification {
  category?: string;
  functions: TuyaSpecFunctionItem[];
  status: TuyaSpecFunctionItem[];
  status_range?: TuyaSpecFunctionItem[];
}

export interface TuyaSharingHome {
  ownerId: string;
  name: string;
  geoName?: string;
}

export interface TuyaSharingDevice {
  id: string;
  name: string;
  category: string;
  product_id?: string;
  productId?: string;
  product_name?: string;
  productName?: string;
  model?: string;
  online: boolean;
  local_key?: string;
  localKey?: string;
  ip?: string;
  room_name?: string;
  roomName?: string;
  home_id?: string;
  homeId?: string;
  home_name?: string;
  homeName?: string;
  icon?: string;
  status?: TuyaStatusItem[];
  dpStatusRelationDTOS?: Array<{
    dpId?: number;
    dpCode?: string;
    supportLocal?: boolean;
    valueType?: string;
    valueDesc?: string;
    statusCode?: string;
  }>;
}

export interface TuyaSharingScene {
  scene_id?: string;
  id?: string;
  name: string;
  home_id?: string;
  ownerId?: string;
  enabled?: boolean;
}

export interface TuyaQrCodeResponse {
  token: string;
  qrContent: string;
}

export interface TuyaQrPollResponse {
  success: boolean;
  pending?: boolean;
  expired?: boolean;
  tokenSession?: TuyaTokenSession;
  error?: string;
}

export class TuyaSharingApiError extends Error {
  readonly code?: string | number;

  constructor(message: string, code?: string | number, options?: ErrorOptions) {
    super(message, options);
    this.name = "TuyaSharingApiError";
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface TuyaSharingClientOptions {
  clientId?: string;
  schema?: string;
  authEndpoint?: string;
  tokenSession?: TuyaTokenSession | null;
  onTokenUpdate?: (session: TuyaTokenSession) => void;
  httpFetch?: typeof fetch;
  now?: () => number;
  uuidGenerator?: () => string;
  timeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeExpireTimestampMs(rawExpire: unknown, nowMs: number): number {
  const num = typeof rawExpire === "number" ? rawExpire : Number(rawExpire);
  if (!Number.isFinite(num) || num <= 0) {
    return nowMs + 7200 * 1000;
  }
  if (num < 1_000_000_000) {
    // TTL in seconds (e.g. 7200)
    return nowMs + num * 1000;
  }
  if (num < 10_000_000_000) {
    // Unix timestamp in seconds
    return num * 1000;
  }
  return num;
}

function isTokenExpiredError(code: unknown, msg: string): boolean {
  const codeStr = String(code ?? "");
  const lower = msg.toLowerCase();
  return (
    codeStr === "1010" ||
    codeStr === "2001" ||
    codeStr === "1004" ||
    lower.includes("token is invalid") ||
    lower.includes("token invalid") ||
    lower.includes("token expired")
  );
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export class TuyaSharingClient {
  private readonly _clientId: string;
  private readonly _schema: string;
  private readonly _authEndpoint: string;
  private readonly _fetch: typeof fetch;
  private readonly _now: () => number;
  private readonly _uuid: () => string;
  private readonly _timeoutMs: number;
  private readonly _onTokenUpdate?: (session: TuyaTokenSession) => void;

  private _tokenSession: TuyaTokenSession | null;
  private _refreshInFlight: Promise<TuyaTokenSession> | null = null;

  constructor(options: TuyaSharingClientOptions = {}) {
    this._clientId = options.clientId?.trim() || TUYA_CLIENT_ID;
    this._schema = options.schema?.trim() || TUYA_SCHEMA;
    this._authEndpoint = stripTrailingSlash(
      options.authEndpoint?.trim() || TUYA_SHARING_AUTH_ENDPOINT,
    );
    this._tokenSession = options.tokenSession ? { ...options.tokenSession } : null;
    this._onTokenUpdate = options.onTokenUpdate;
    this._fetch = options.httpFetch ?? fetch;
    this._now = options.now ?? (() => Date.now());
    this._uuid = options.uuidGenerator ?? (() => randomUUID());
    this._timeoutMs = options.timeoutMs ?? 15_000;
  }

  get tokenSession(): TuyaTokenSession | null {
    return this._tokenSession ? { ...this._tokenSession } : null;
  }

  setTokenSession(session: TuyaTokenSession | null): void {
    this._tokenSession = session ? { ...session } : null;
  }

  hasSession(): boolean {
    return Boolean(this._tokenSession?.accessToken);
  }

  /**
   * 申请 Home Assistant Device Sharing 扫码登录二维码 Token。
   * `POST /v1.0/m/life/home-assistant/qrcode/tokens?clientid=...&usercode=...&schema=...`
   */
  async requestQrCode(
    userCode: string,
    clientId = this._clientId,
    schema = this._schema,
  ): Promise<TuyaQrCodeResponse> {
    const trimmedUserCode = userCode.trim();
    if (!trimmedUserCode) {
      throw new TuyaSharingApiError("缺少涂鸦 App 用户码（userCode）");
    }
    const qs = new URLSearchParams({
      clientid: clientId,
      usercode: trimmedUserCode,
      schema,
    }).toString();
    const url = `${this._authEndpoint}/v1.0/m/life/home-assistant/qrcode/tokens?${qs}`;

    const resp = await this._fetchJson(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });

    if (resp.success === false) {
      throw new TuyaSharingApiError(
        String(resp.msg || "获取涂鸦扫码登录二维码失败"),
        resp.code as string | number | undefined,
      );
    }

    const result = resp.result;
    let token = "";
    if (typeof result === "string") {
      token = result.trim();
    } else if (isRecord(result)) {
      const candidate = result.qrcode ?? result.token;
      if (typeof candidate === "string") {
        token = candidate.trim();
      }
    }
    if (!token) {
      throw new TuyaSharingApiError("涂鸦网关未返回有效的二维码 Token");
    }

    return {
      token,
      qrContent: `${TUYA_SHARING_QR_PREFIX}${token}`,
    };
  }

  /**
   * 轮询 Home Assistant Device Sharing 扫码结果。
   * `GET /v1.0/m/life/home-assistant/qrcode/tokens/{token}?clientid=...&usercode=...`
   */
  async pollQrLogin(
    token: string,
    userCode: string,
    clientId = this._clientId,
  ): Promise<TuyaQrPollResponse> {
    const qs = new URLSearchParams({
      clientid: clientId,
      usercode: userCode.trim(),
    }).toString();
    const url = `${this._authEndpoint}/v1.0/m/life/home-assistant/qrcode/tokens/${encodeURIComponent(token)}?${qs}`;

    let resp: Record<string, unknown>;
    try {
      resp = await this._fetchJson(url, { method: "GET" });
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    if (resp.success !== true) {
      const msg = String(resp.msg ?? "");
      const code = String(resp.code ?? "");
      const lower = msg.toLowerCase();
      if (
        lower.includes("expired") ||
        lower.includes("timeout") ||
        code === "1107" ||
        code === "EXPIRED"
      ) {
        return {
          success: false,
          expired: true,
          error: msg || "二维码已过期，请重新生成",
        };
      }
      if (
        !msg ||
        lower.includes("not scan") ||
        lower.includes("waiting") ||
        lower.includes("pending") ||
        lower.includes("unscanned") ||
        code === "1106" ||
        code === "WAIT"
      ) {
        return {
          success: false,
          pending: true,
          error: msg || "等待手机端扫码确认…",
        };
      }
      return {
        success: false,
        error: msg || `扫码登录失败（错误码 ${code || "unknown"}）`,
      };
    }

    const result = isRecord(resp.result) ? resp.result : null;
    if (!result || typeof result.access_token !== "string" || !result.access_token) {
      return {
        success: false,
        pending: true,
        error: "等待手机端确认授权…",
      };
    }

    const nowMs = this._now();
    const session: TuyaTokenSession = {
      accessToken: String(result.access_token),
      refreshToken: typeof result.refresh_token === "string" ? result.refresh_token : "",
      expireTime: normalizeExpireTimestampMs(result.expire_time, nowMs),
      uid: typeof result.uid === "string" ? result.uid : "",
      endpoint: stripTrailingSlash(
        typeof result.endpoint === "string" && result.endpoint.trim()
          ? result.endpoint.trim()
          : this._authEndpoint,
      ),
      ...(typeof result.terminal_id === "string" && result.terminal_id
        ? { terminalId: result.terminal_id }
        : {}),
      ...(typeof result.username === "string" && result.username
        ? { username: result.username }
        : {}),
    };

    this._tokenSession = session;
    this._onTokenUpdate?.({ ...session });
    return {
      success: true,
      tokenSession: { ...session },
    };
  }

  /** 使用 refreshToken 刷新访问令牌：`/v1.0/m/token/{refreshToken}` */
  async refreshAccessToken(): Promise<TuyaTokenSession> {
    if (this._refreshInFlight) {
      return await this._refreshInFlight;
    }
    const run = this._doRefreshAccessToken();
    this._refreshInFlight = run;
    try {
      return await run;
    } finally {
      this._refreshInFlight = null;
    }
  }

  private async _doRefreshAccessToken(): Promise<TuyaTokenSession> {
    const current = this._tokenSession;
    if (!current || !current.refreshToken) {
      throw new TuyaSharingApiError("涂鸦会话缺少 refreshToken，请重新扫码登录");
    }

    const data = await this._signedRequest<Record<string, unknown>>(
      "GET",
      `/v1.0/m/token/${encodeURIComponent(current.refreshToken)}`,
      undefined,
      undefined,
      { skipAccessToken: true, allowAutoRefresh: false },
    );

    if (!isRecord(data) || typeof data.access_token !== "string" || !data.access_token) {
      throw new TuyaSharingApiError("刷新涂鸦访问令牌失败，请重新扫码登录");
    }

    const nowMs = this._now();
    const updated: TuyaTokenSession = {
      accessToken: data.access_token,
      refreshToken:
        typeof data.refresh_token === "string" && data.refresh_token
          ? data.refresh_token
          : current.refreshToken,
      expireTime: normalizeExpireTimestampMs(data.expire_time, nowMs),
      uid: typeof data.uid === "string" && data.uid ? data.uid : current.uid,
      endpoint: stripTrailingSlash(
        typeof data.endpoint === "string" && data.endpoint.trim()
          ? data.endpoint.trim()
          : current.endpoint || this._authEndpoint,
      ),
      ...(current.terminalId ? { terminalId: current.terminalId } : {}),
      ...(current.username ? { username: current.username } : {}),
    };

    this._tokenSession = updated;
    this._onTokenUpdate?.({ ...updated });
    return { ...updated };
  }

  private async _signedRequest<T>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    params?: Record<string, unknown>,
    body?: Record<string, unknown>,
    options: { skipAccessToken?: boolean; allowAutoRefresh?: boolean } = {},
  ): Promise<T> {
    const allowAutoRefresh = options.allowAutoRefresh !== false;
    if (!this._tokenSession) {
      throw new TuyaSharingApiError("尚未登录涂鸦账号，请先完成扫码授权");
    }

    // 过期前 60 秒主动刷新 Token
    if (
      allowAutoRefresh &&
      !options.skipAccessToken &&
      this._tokenSession.refreshToken &&
      this._tokenSession.expireTime > 0 &&
      this._now() >= this._tokenSession.expireTime - 60_000
    ) {
      await this.refreshAccessToken();
    }

    const execute = async (): Promise<T> => {
      const session = this._tokenSession!;
      const endpoint = stripTrailingSlash(session.endpoint || this._authEndpoint);
      const rid = this._uuid();
      const sid = "";
      const timestamp = String(this._now());
      const hashKey = tuyaSharingHashKey(rid, session.refreshToken);
      const secret = tuyaSharingSecret(rid, sid, hashKey);

      const queryEncdata =
        params && Object.keys(params).length > 0
          ? tuyaSharingAesGcmEncrypt(JSON.stringify(params), secret)
          : "";
      const bodyEncdata =
        body && Object.keys(body).length > 0
          ? tuyaSharingAesGcmEncrypt(JSON.stringify(body), secret)
          : "";

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "X-appKey": this._clientId,
        "X-requestId": rid,
        "X-sid": sid,
        "X-time": timestamp,
      };
      if (!options.skipAccessToken && session.accessToken) {
        headers["X-token"] = session.accessToken;
      }
      headers["X-sign"] = tuyaSharingRestfulSign(hashKey, queryEncdata, bodyEncdata, headers);

      const url = `${endpoint}${path}${
        queryEncdata ? `?encdata=${encodeURIComponent(queryEncdata)}` : ""
      }`;
      const resp = await this._fetchJson(url, {
        method,
        headers,
        ...(bodyEncdata ? { body: JSON.stringify({ encdata: bodyEncdata }) } : {}),
      });

      if (resp.success === false) {
        throw new TuyaSharingApiError(
          String(resp.msg || "涂鸦云端接口返回错误"),
          resp.code as string | number | undefined,
        );
      }

      const rawResult = resp.result;
      if (typeof rawResult === "string" && rawResult.length > 0) {
        const decryptedText = tuyaSharingAesGcmDecrypt(rawResult, secret);
        try {
          return JSON.parse(decryptedText) as T;
        } catch {
          return decryptedText as unknown as T;
        }
      }
      return rawResult as T;
    };

    try {
      return await execute();
    } catch (err) {
      if (
        allowAutoRefresh &&
        !options.skipAccessToken &&
        err instanceof TuyaSharingApiError &&
        this._tokenSession?.refreshToken &&
        isTokenExpiredError(err.code, err.message)
      ) {
        await this.refreshAccessToken();
        return await execute();
      }
      throw err;
    }
  }

  private async _fetchJson(url: string, init: RequestInit): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this._timeoutMs);
    try {
      const response = await this._fetch(url, {
        ...init,
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        throw new TuyaSharingApiError(
          `涂鸦云端 HTTP ${response.status}: ${text.slice(0, 180)}`,
          response.status,
        );
      }
      let parsed: unknown;
      try {
        parsed = text ? JSON.parse(text) : {};
      } catch {
        throw new TuyaSharingApiError("涂鸦云端返回了非 JSON 响应");
      }
      if (!isRecord(parsed)) {
        throw new TuyaSharingApiError("涂鸦云端返回格式异常");
      }
      return parsed;
    } catch (err) {
      if (err instanceof TuyaSharingApiError) {
        throw err;
      }
      if (err instanceof Error && err.name === "AbortError") {
        throw new TuyaSharingApiError("请求涂鸦云端超时，请检查网络连接", "TIMEOUT", { cause: err });
      }
      throw new TuyaSharingApiError(
        `请求涂鸦云端失败: ${err instanceof Error ? err.message : String(err)}`,
        undefined,
        { cause: err },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  // ---------- Device Sharing 业务接口 ----------

  async queryHomes(): Promise<TuyaSharingHome[]> {
    const res = await this._signedRequest<unknown>("GET", "/v1.0/m/life/users/homes");
    if (!Array.isArray(res)) return [];
    return res
      .filter(isRecord)
      .map((item) => ({
        ownerId: String(item.ownerId ?? item.home_id ?? item.id ?? ""),
        name: String(item.name ?? "默认家庭"),
        ...(typeof item.geoName === "string" ? { geoName: item.geoName } : {}),
      }))
      .filter((h) => h.ownerId.length > 0);
  }

  async queryDevicesByHome(homeId: string): Promise<TuyaSharingDevice[]> {
    const res = await this._signedRequest<unknown>("GET", "/v1.0/m/life/ha/home/devices", {
      homeId,
    });
    if (!Array.isArray(res)) return [];
    return res.filter(isRecord) as unknown as TuyaSharingDevice[];
  }

  async queryDeviceDetail(deviceIds: string[]): Promise<TuyaSharingDevice[]> {
    if (deviceIds.length === 0) return [];
    const res = await this._signedRequest<unknown>("GET", "/v1.0/m/life/ha/devices/detail", {
      devIds: deviceIds.join(","),
    });
    if (!Array.isArray(res)) return [];
    return res.filter(isRecord) as unknown as TuyaSharingDevice[];
  }

  async queryDeviceSpec(deviceId: string): Promise<TuyaDeviceSpecification> {
    const res = await this._signedRequest<unknown>(
      "GET",
      `/v1.1/m/life/${encodeURIComponent(deviceId)}/specifications`,
    );
    if (!isRecord(res)) {
      return { functions: [], status: [] };
    }
    const functions = Array.isArray(res.functions)
      ? (res.functions.filter(isRecord) as unknown as TuyaSpecFunctionItem[])
      : [];
    const status = Array.isArray(res.status)
      ? (res.status.filter(isRecord) as unknown as TuyaSpecFunctionItem[])
      : [];
    const statusRange = Array.isArray(res.status_range)
      ? (res.status_range.filter(isRecord) as unknown as TuyaSpecFunctionItem[])
      : undefined;
    return {
      ...(typeof res.category === "string" ? { category: res.category } : {}),
      functions,
      status,
      ...(statusRange ? { status_range: statusRange } : {}),
    };
  }

  async sendCommands(deviceId: string, commands: TuyaCommandItem[]): Promise<boolean> {
    const res = await this._signedRequest<unknown>(
      "POST",
      `/v1.1/m/thing/${encodeURIComponent(deviceId)}/commands`,
      undefined,
      { commands },
    );
    return res !== false;
  }

  async queryScenes(homeId: string): Promise<TuyaSharingScene[]> {
    const res = await this._signedRequest<unknown>("GET", "/v1.0/m/scene/ha/home/scenes", {
      homeId,
    });
    if (!Array.isArray(res)) return [];
    return res.filter(isRecord) as unknown as TuyaSharingScene[];
  }

  async triggerScene(homeId: string, sceneId: string): Promise<boolean> {
    const res = await this._signedRequest<unknown>(
      "POST",
      "/v1.0/m/scene/ha/trigger",
      undefined,
      { homeId, sceneId },
    );
    return res !== false;
  }
}
