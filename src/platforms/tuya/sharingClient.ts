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

export interface TuyaSharingRoom {
  id: string;
  name: string;
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
  sub?: boolean;
  node_id?: string;
  local_key?: string;
  localKey?: string;
  ip?: string;
  room_id?: string | number;
  roomId?: string | number;
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

const PROACTIVE_REFRESH_MARGIN_MS = 5 * 60_000;
const PROACTIVE_REFRESH_FAILURE_COOLDOWN_MS = 60_000;
const CLOCK_SKEW_THRESHOLD_MS = 30_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstNonEmptyString(...values: unknown[]): string {
  for (const val of values) {
    if (typeof val === "string") {
      const trimmed = val.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
    }
  }
  return "";
}

interface ExtractedTokenFields {
  accessToken: string;
  refreshToken: string;
  rawExpire: unknown;
  uid: string;
  endpoint: string;
  terminalId: string;
  username: string;
}

/**
 * 兼容涂鸦不同接口的令牌字段命名：
 * - 扫码登录接口 `/v1.0/m/life/home-assistant/qrcode/tokens/{token}` 返回 snake_case (`access_token`, `refresh_token`, `expire_time`, `terminal_id`)；
 * - 令牌刷新接口 `/v1.0/m/token/{refreshToken}` 返回 camelCase (`accessToken`, `refreshToken`, `expireTime`, `uid`)。
 */
function extractTokenFields(data: Record<string, unknown>): ExtractedTokenFields {
  return {
    accessToken: firstNonEmptyString(data.accessToken, data.access_token),
    refreshToken: firstNonEmptyString(data.refreshToken, data.refresh_token),
    rawExpire: data.expireTime ?? data.expire_time,
    uid: firstNonEmptyString(data.uid),
    endpoint: firstNonEmptyString(data.endpoint),
    terminalId: firstNonEmptyString(data.terminalId, data.terminal_id),
    username: firstNonEmptyString(data.username),
  };
}

function normalizeExpireTimestampMs(
  rawExpire: unknown,
  nowMs: number,
  clockOffsetMs = 0,
): number {
  const num = typeof rawExpire === "number" ? rawExpire : Number(rawExpire);
  if (!Number.isFinite(num) || num <= 0) {
    return nowMs + 7200 * 1000;
  }
  if (num < 1_000_000_000) {
    // TTL in seconds (e.g. 7200)
    return nowMs + num * 1000;
  }
  if (num < 10_000_000_000) {
    // Unix timestamp in seconds (server clock) -> normalize into local clock coordinates
    return num * 1000 - clockOffsetMs;
  }
  return num - clockOffsetMs;
}

export function isTuyaSharingAuthError(code: unknown, msg: string): boolean {
  const codeStr = String(code ?? "").trim();
  const lower = msg.toLowerCase();
  return (
    codeStr === "-9999999" ||
    codeStr === "1010" ||
    codeStr === "1011" ||
    codeStr === "2001" ||
    codeStr === "1004" ||
    lower.includes("sign invalid") ||
    lower.includes("invalid sign") ||
    lower.includes("token is invalid") ||
    lower.includes("token invalid") ||
    lower.includes("token is expired") ||
    lower.includes("token expired") ||
    lower.includes("token is not exist")
  );
}

function isClockSkewError(code: unknown, msg: string): boolean {
  const codeStr = String(code ?? "").trim();
  const lower = msg.toLowerCase();
  return (
    codeStr === "1013" ||
    lower.includes("request time is invalid") ||
    lower.includes("time is invalid") ||
    lower.includes("request time")
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
  private _proactiveRefreshRetryAt = 0;
  private _clockOffsetMs = 0;
  private _sessionGeneration = 0;

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
    this._sessionGeneration += 1;
    this._tokenSession = session ? { ...session } : null;
    this._proactiveRefreshRetryAt = 0;
  }

  hasSession(): boolean {
    return Boolean(this._tokenSession?.accessToken || this._tokenSession?.refreshToken);
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
    });

    if (resp.success === false) {
      const code = String(resp.code ?? "");
      const rawMsg = String(resp.msg ?? "");
      const lower = rawMsg.toLowerCase();
      if (
        code.toUpperCase() === "USERCODE_INCORRECT" ||
        lower.includes("user code incorrect") ||
        lower.includes("usercode")
      ) {
        throw new TuyaSharingApiError(
          "涂鸦用户码不正确，请在「涂鸦智能 / Smart Life App → 我的 → 设置 → 账号与安全 → 用户码」中核对后重试",
          resp.code as string | number | undefined,
        );
      }
      throw new TuyaSharingApiError(
        rawMsg || "获取涂鸦扫码登录二维码失败",
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
      const msg = String(resp.msg ?? "").trim();
      const code = String(resp.code ?? "").trim();
      const upperCode = code.toUpperCase();
      const lower = msg.toLowerCase();

      // 1. 明确的二维码过期状态
      if (
        lower.includes("expired") ||
        lower.includes("timeout") ||
        upperCode === "1107" ||
        upperCode === "E0020002" ||
        upperCode === "EXPIRED" ||
        upperCode === "QRCODE_EXPIRED" ||
        upperCode === "QR_CODE_EXPIRED" ||
        upperCode === "TOKEN_EXPIRED"
      ) {
        return {
          success: false,
          expired: true,
          error: "二维码已过期，请重新获取",
        };
      }

      // 2. 明确的用户码/参数错误或手机端主动拒绝授权
      if (
        upperCode === "USERCODE_INCORRECT" ||
        upperCode === "INVALID_PARAM" ||
        upperCode === "ILLEGAL_PARAM" ||
        lower.includes("user code") ||
        lower.includes("usercode") ||
        lower.includes("incorrect") ||
        lower.includes("invalid client")
      ) {
        return {
          success: false,
          error: "涂鸦用户码不正确，请核对后重试",
        };
      }
      if (
        lower.includes("reject") ||
        lower.includes("cancel") ||
        lower.includes("denied") ||
        lower.includes("refuse")
      ) {
        return {
          success: false,
          error: "手机端已取消授权，请重新获取二维码",
        };
      }

      // 3. 涂鸦 Home Assistant Device Sharing 接口在用户尚未扫码确认前
      // 会直接返回 { success: false, code: "E0020003", msg: "login failed" }，
      // 必须归类为 pending 继续等待扫码，绝不能提前报错中断。
      if (
        !msg ||
        upperCode === "E0020003" ||
        upperCode === "LOGIN_FAILED" ||
        upperCode === "1106" ||
        upperCode === "2001" ||
        upperCode === "WAIT" ||
        upperCode === "WAITING" ||
        upperCode === "PENDING" ||
        upperCode === "NOT_SCAN" ||
        upperCode === "UNSCANNED" ||
        lower.includes("login failed") ||
        lower.includes("please scan") ||
        lower.includes("not scan") ||
        lower.includes("unscanned") ||
        lower.includes("waiting") ||
        lower.includes("pending") ||
        lower.includes("not confirm")
      ) {
        return {
          success: false,
          pending: true,
          error: "等待涂鸦智能 / Smart Life App 扫码并点击确认…",
        };
      }

      return {
        success: false,
        error: msg || `扫码登录失败（错误码 ${code || "unknown"}）`,
      };
    }

    const result = isRecord(resp.result) ? resp.result : null;
    const parsed = result ? extractTokenFields(result) : null;
    if (!parsed || !parsed.accessToken) {
      return {
        success: false,
        pending: true,
        error: "等待手机端确认授权…",
      };
    }

    const nowMs = this._now();
    const session: TuyaTokenSession = {
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken,
      expireTime: normalizeExpireTimestampMs(parsed.rawExpire, nowMs, this._clockOffsetMs),
      uid: parsed.uid,
      endpoint: stripTrailingSlash(parsed.endpoint || this._authEndpoint),
      ...(parsed.terminalId ? { terminalId: parsed.terminalId } : {}),
      ...(parsed.username ? { username: parsed.username } : {}),
    };

    this._sessionGeneration += 1;
    this._tokenSession = session;
    this._proactiveRefreshRetryAt = 0;
    this._onTokenUpdate?.({ ...session });
    return {
      success: true,
      tokenSession: { ...session },
    };
  }

  /**
   * 使用 refreshToken 刷新访问令牌：`GET /v1.0/m/token/{refreshToken}`。
   * - 并发刷新共享同一在途 Promise（单飞锁）；
   * - 若传入 `staleSnapshot` 且会话已被其他并发请求刷新，直接复用新会话避免重复轮换。
   */
  async refreshAccessToken(
    staleSnapshot?: { accessToken?: string; refreshToken?: string },
  ): Promise<TuyaTokenSession> {
    if (this._refreshInFlight) {
      return await this._refreshInFlight;
    }
    if (staleSnapshot && this._tokenSession && this._hasSessionRotatedSince(staleSnapshot)) {
      return { ...this._tokenSession };
    }
    const run = this._doRefreshAccessToken();
    this._refreshInFlight = run;
    try {
      return await run;
    } finally {
      if (this._refreshInFlight === run) {
        this._refreshInFlight = null;
      }
    }
  }

  private _hasSessionRotatedSince(snapshot: {
    accessToken?: string;
    refreshToken?: string;
  }): boolean {
    if (!this._tokenSession) return false;
    return (
      (snapshot.accessToken !== undefined &&
        this._tokenSession.accessToken !== snapshot.accessToken) ||
      (snapshot.refreshToken !== undefined &&
        this._tokenSession.refreshToken !== snapshot.refreshToken)
    );
  }

  private _syncClockOffsetFromResponse(resp: Record<string, unknown>): void {
    const rawT = resp.t;
    const serverMs = typeof rawT === "number" ? rawT : Number(rawT);
    if (!Number.isFinite(serverMs) || serverMs <= 1_000_000_000_000) {
      return;
    }
    const delta = serverMs - this._now();
    this._clockOffsetMs = Math.abs(delta) > CLOCK_SKEW_THRESHOLD_MS ? delta : 0;
  }

  private async _doRefreshAccessToken(): Promise<TuyaTokenSession> {
    const startGen = this._sessionGeneration;
    const current = this._tokenSession ? { ...this._tokenSession } : null;
    if (!current || !current.refreshToken) {
      throw new TuyaSharingApiError("涂鸦会话缺少 refreshToken，请重新扫码登录");
    }

    const refreshPath = `/v1.0/m/token/${encodeURIComponent(current.refreshToken)}`;
    let data: Record<string, unknown>;
    try {
      // 刷新请求默认省略 X-token（对齐 tuya-device-sharing-sdk PR #74/#82），
      // 防止已过期的 accessToken 被涂鸦网关校验触发 sign invalid (-9999999)
      data = await this._signedRequest<Record<string, unknown>>(
        "GET",
        refreshPath,
        undefined,
        undefined,
        { skipAccessToken: true, allowAutoRefresh: false, sessionOverride: current },
      );
    } catch (err) {
      // 兜底兼容：若某些网关节点要求刷新请求携带 X-token 且无 X-token 时拒签（服务端不会轮换令牌），
      // 在存在 accessToken 时自动携带 X-token 重试一次
      if (
        err instanceof TuyaSharingApiError &&
        current.accessToken &&
        isTuyaSharingAuthError(err.code, err.message) &&
        this._sessionGeneration === startGen
      ) {
        data = await this._signedRequest<Record<string, unknown>>(
          "GET",
          refreshPath,
          undefined,
          undefined,
          { skipAccessToken: false, allowAutoRefresh: false, sessionOverride: current },
        );
      } else {
        throw err;
      }
    }

    const parsed = isRecord(data) ? extractTokenFields(data) : null;
    if (!parsed || !parsed.accessToken) {
      throw new TuyaSharingApiError("刷新涂鸦访问令牌失败，请重新扫码登录");
    }

    if (this._sessionGeneration !== startGen) {
      if (this._tokenSession) {
        return { ...this._tokenSession };
      }
      throw new TuyaSharingApiError("涂鸦会话已重置，请重新扫码登录");
    }

    const nowMs = this._now();
    const updated: TuyaTokenSession = {
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken || current.refreshToken,
      expireTime: normalizeExpireTimestampMs(parsed.rawExpire, nowMs, this._clockOffsetMs),
      uid: parsed.uid || current.uid,
      endpoint: stripTrailingSlash(parsed.endpoint || current.endpoint || this._authEndpoint),
      ...(parsed.terminalId || current.terminalId
        ? { terminalId: parsed.terminalId || current.terminalId }
        : {}),
      ...(parsed.username || current.username
        ? { username: parsed.username || current.username }
        : {}),
    };

    this._tokenSession = updated;
    this._proactiveRefreshRetryAt = 0;
    this._onTokenUpdate?.({ ...updated });
    return { ...updated };
  }

  private async _ensureFreshSessionBeforeRequest(): Promise<void> {
    // 若已有并发刷新在途，先等待其落盘完成，避免后续请求用旧 refreshToken 签名触发 sign invalid
    if (this._refreshInFlight) {
      try {
        await this._refreshInFlight;
        return;
      } catch (err) {
        const cur = this._tokenSession;
        const stillValid = Boolean(
          cur && cur.accessToken && cur.expireTime > 0 && this._now() < cur.expireTime,
        );
        if (stillValid) {
          return;
        }
        throw err;
      }
    }

    const cur = this._tokenSession;
    if (!cur || !cur.refreshToken) {
      return;
    }

    const nowMs = this._now();
    const isHardExpired = !cur.accessToken || (cur.expireTime > 0 && nowMs >= cur.expireTime);
    const isNearExpiry =
      cur.expireTime > 0 && nowMs >= cur.expireTime - PROACTIVE_REFRESH_MARGIN_MS;

    if (isHardExpired) {
      await this.refreshAccessToken({
        accessToken: cur.accessToken,
        refreshToken: cur.refreshToken,
      });
      return;
    }

    if (isNearExpiry && nowMs >= this._proactiveRefreshRetryAt) {
      try {
        await this.refreshAccessToken({
          accessToken: cur.accessToken,
          refreshToken: cur.refreshToken,
        });
      } catch {
        // 令牌尚未硬过期：进入冷却期，继续使用当前仍有效的令牌避免临时限流/抖动中断业务
        this._proactiveRefreshRetryAt = this._now() + PROACTIVE_REFRESH_FAILURE_COOLDOWN_MS;
      }
    }
  }

  private async _signedRequest<T>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    params?: Record<string, unknown>,
    body?: Record<string, unknown>,
    options: {
      skipAccessToken?: boolean;
      allowAutoRefresh?: boolean;
      sessionOverride?: TuyaTokenSession;
    } = {},
  ): Promise<T> {
    const allowAutoRefresh = options.allowAutoRefresh !== false;
    if (!options.sessionOverride && !this._tokenSession) {
      throw new TuyaSharingApiError("尚未登录涂鸦账号，请先完成扫码授权");
    }

    if (allowAutoRefresh && !options.skipAccessToken && !options.sessionOverride) {
      await this._ensureFreshSessionBeforeRequest();
    }

    const getSnapshot = (): TuyaTokenSession => {
      const src = options.sessionOverride ?? this._tokenSession;
      if (!src) {
        throw new TuyaSharingApiError("尚未登录涂鸦账号，请先完成扫码授权");
      }
      return { ...src };
    };

    const execute = async (session: TuyaTokenSession): Promise<T> => {
      const endpoint = stripTrailingSlash(session.endpoint || this._authEndpoint);
      const rid = this._uuid();
      const sid = "";
      const timestamp = String(this._now() + this._clockOffsetMs);
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
      if (typeof rawResult === "string" && rawResult.trim().length > 0) {
        const decryptedText = tuyaSharingAesGcmDecrypt(rawResult, secret);
        if (!decryptedText.trim()) {
          return "" as unknown as T;
        }
        try {
          return JSON.parse(decryptedText) as T;
        } catch {
          return decryptedText as unknown as T;
        }
      }
      return rawResult as T;
    };

    const executeWithClockRetry = async (session: TuyaTokenSession): Promise<T> => {
      const prevOffset = this._clockOffsetMs;
      try {
        return await execute(session);
      } catch (err) {
        if (
          err instanceof TuyaSharingApiError &&
          isClockSkewError(err.code, err.message) &&
          this._clockOffsetMs !== prevOffset
        ) {
          return await execute(session);
        }
        throw err;
      }
    };

    const usedSession = getSnapshot();
    try {
      return await executeWithClockRetry(usedSession);
    } catch (err) {
      if (
        allowAutoRefresh &&
        !options.skipAccessToken &&
        !options.sessionOverride &&
        err instanceof TuyaSharingApiError &&
        this._tokenSession?.refreshToken &&
        isTuyaSharingAuthError(err.code, err.message)
      ) {
        await this.refreshAccessToken({
          accessToken: usedSession.accessToken,
          refreshToken: usedSession.refreshToken,
        });
        return await executeWithClockRetry(getSnapshot());
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
      this._syncClockOffsetFromResponse(parsed);
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

  /**
   * 查询设备所属房间（对齐 tuya-device-sharing-sdk `HomeRepository.query_room_by_device`）：
   * `GET /v1.0/m/thing/ha/{deviceId}/room`
   * 未分配房间的设备会返回空字符串或空对象，此时返回 `null`。
   */
  async queryRoomByDevice(deviceId: string): Promise<TuyaSharingRoom | null> {
    const trimmedId = deviceId.trim();
    if (!trimmedId) return null;
    const res = await this._signedRequest<unknown>(
      "GET",
      `/v1.0/m/thing/ha/${encodeURIComponent(trimmedId)}/room`,
    );
    if (!isRecord(res)) return null;
    const rawName = res.name ?? res.roomName ?? res.room_name;
    const name = typeof rawName === "string" ? rawName.trim() : "";
    if (!name) return null;
    const rawId = res.id ?? res.roomId ?? res.room_id;
    const id =
      typeof rawId === "string" || typeof rawId === "number" ? String(rawId).trim() : "";
    return { id, name };
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
