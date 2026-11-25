// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 涂鸦 IoT Cloud OpenAPI v2.0 客户端

import { randomUUID } from "node:crypto";
import { TUYA_OPENAPI_ENDPOINTS, type TuyaOpenApiRegion } from "./constants.ts";
import { tuyaOpenApiSign } from "./crypto.ts";
import type {
  TuyaCommandItem,
  TuyaDeviceSpecification,
  TuyaSpecFunctionItem,
  TuyaStatusItem,
} from "./sharingClient.ts";

export interface TuyaOpenApiTokenResult {
  accessToken: string;
  refreshToken: string;
  expireTime: number; // Unix ms
  uid: string;
}

export interface TuyaOpenApiDevice {
  id: string;
  name: string;
  category: string;
  product_id?: string;
  product_name?: string;
  model?: string;
  online: boolean;
  sub?: boolean;
  local_key?: string;
  ip?: string;
  uid?: string;
  icon?: string;
  room_name?: string;
  roomName?: string;
  status?: TuyaStatusItem[];
}

export interface TuyaOpenApiHome {
  home_id: string;
  name: string;
  geo_name?: string;
}

export interface TuyaOpenApiRoom {
  room_id: string;
  name: string;
}

export interface TuyaOpenApiScene {
  scene_id: string;
  name: string;
  home_id?: string;
  enabled?: boolean;
}

export interface TuyaOpenApiIrRemote {
  remote_id: string;
  remote_name: string;
  category_id: number;
  remote_index?: number;
  brand_id?: number;
  brand_name?: string;
}

export interface TuyaOpenApiIrKey {
  key: string;
  key_id?: number;
  key_name?: string;
  standard_key?: boolean;
}

export interface TuyaOpenApiIrRemoteKeysResult {
  category_id?: number;
  remote_index?: number;
  brand_id?: number;
  key_list: TuyaOpenApiIrKey[];
}

export interface TuyaOpenApiIrLearningCode {
  id?: number;
  key: string;
  key_name?: string;
  code: string;
}

export class TuyaOpenApiError extends Error {
  readonly code?: number | string;

  constructor(message: string, code?: number | string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TuyaOpenApiError";
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface TuyaOpenApiClientOptions {
  accessId: string;
  accessSecret: string;
  region?: TuyaOpenApiRegion;
  endpoint?: string;
  httpFetch?: typeof fetch;
  now?: () => number;
  nonceGenerator?: () => string;
  timeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export class TuyaOpenApiClient {
  private readonly _accessId: string;
  private readonly _accessSecret: string;
  private readonly _endpoint: string;
  private readonly _fetch: typeof fetch;
  private readonly _now: () => number;
  private readonly _nonceGenerator: () => string;
  private readonly _timeoutMs: number;

  private _token: TuyaOpenApiTokenResult | null = null;
  private _tokenInFlight: Promise<TuyaOpenApiTokenResult> | null = null;

  constructor(options: TuyaOpenApiClientOptions) {
    this._accessId = options.accessId.trim();
    this._accessSecret = options.accessSecret;
    const region: TuyaOpenApiRegion = options.region ?? "cn";
    this._endpoint = stripTrailingSlash(
      options.endpoint?.trim() || TUYA_OPENAPI_ENDPOINTS[region] || TUYA_OPENAPI_ENDPOINTS.cn,
    );
    this._fetch = options.httpFetch ?? fetch;
    this._now = options.now ?? (() => Date.now());
    this._nonceGenerator = options.nonceGenerator ?? (() => randomUUID().replaceAll("-", ""));
    this._timeoutMs = options.timeoutMs ?? 15_000;
  }

  get endpoint(): string {
    return this._endpoint;
  }

  get cachedToken(): TuyaOpenApiTokenResult | null {
    return this._token ? { ...this._token } : null;
  }

  clearToken(): void {
    this._token = null;
  }

  async getAccessToken(forceRefresh = false): Promise<TuyaOpenApiTokenResult> {
    if (
      !forceRefresh &&
      this._token &&
      this._token.accessToken &&
      this._now() < this._token.expireTime - 60_000
    ) {
      return { ...this._token };
    }
    if (this._tokenInFlight) {
      return await this._tokenInFlight;
    }
    const run = this._fetchAccessToken();
    this._tokenInFlight = run;
    try {
      return await run;
    } finally {
      this._tokenInFlight = null;
    }
  }

  private async _fetchAccessToken(): Promise<TuyaOpenApiTokenResult> {
    if (!this._accessId || !this._accessSecret) {
      throw new TuyaOpenApiError("缺少涂鸦 OpenAPI Access ID 或 Access Secret");
    }
    const raw = await this._rawRequest<Record<string, unknown>>(
      "GET",
      "/v1.0/token?grant_type=1",
      undefined,
      "",
    );
    if (!isRecord(raw) || typeof raw.access_token !== "string" || !raw.access_token) {
      throw new TuyaOpenApiError("获取涂鸦 OpenAPI Access Token 失败");
    }
    const expireSec =
      typeof raw.expire_time === "number" && Number.isFinite(raw.expire_time)
        ? raw.expire_time
        : 7200;
    const token: TuyaOpenApiTokenResult = {
      accessToken: raw.access_token,
      refreshToken: typeof raw.refresh_token === "string" ? raw.refresh_token : "",
      expireTime: this._now() + expireSec * 1000,
      uid: typeof raw.uid === "string" ? raw.uid : "",
    };
    this._token = token;
    return { ...token };
  }

  private async _authorizedRequest<T>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    pathWithQuery: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const token = await this.getAccessToken(false);
    try {
      return await this._rawRequest<T>(method, pathWithQuery, body, token.accessToken);
    } catch (err) {
      if (
        err instanceof TuyaOpenApiError &&
        (String(err.code) === "1010" || err.message.toLowerCase().includes("token invalid"))
      ) {
        const refreshed = await this.getAccessToken(true);
        return await this._rawRequest<T>(method, pathWithQuery, body, refreshed.accessToken);
      }
      throw err;
    }
  }

  private async _rawRequest<T>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    pathWithQuery: string,
    body: Record<string, unknown> | undefined,
    accessToken: string,
  ): Promise<T> {
    const bodyStr = body !== undefined ? JSON.stringify(body) : "";
    const t = String(this._now());
    const nonce = this._nonceGenerator();
    const { sign, canonicalUrl } = tuyaOpenApiSign({
      clientId: this._accessId,
      secret: this._accessSecret,
      method,
      url: pathWithQuery,
      body: bodyStr,
      accessToken,
      t,
      nonce,
    });

    const headers: Record<string, string> = {
      client_id: this._accessId,
      sign,
      t,
      sign_method: "HMAC-SHA256",
    };
    if (nonce) {
      headers["nonce"] = nonce;
    }
    if (accessToken) {
      headers["access_token"] = accessToken;
    }
    if (bodyStr) {
      headers["Content-Type"] = "application/json";
    }

    const url = `${this._endpoint}${canonicalUrl}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this._timeoutMs);
    try {
      const response = await this._fetch(url, {
        method,
        headers,
        ...(bodyStr ? { body: bodyStr } : {}),
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        throw new TuyaOpenApiError(
          `涂鸦 OpenAPI HTTP ${response.status}: ${text.slice(0, 180)}`,
          response.status,
        );
      }
      let parsed: unknown;
      try {
        parsed = text ? JSON.parse(text) : {};
      } catch {
        throw new TuyaOpenApiError("涂鸦 OpenAPI 返回了非 JSON 响应");
      }
      if (!isRecord(parsed)) {
        throw new TuyaOpenApiError("涂鸦 OpenAPI 响应结构异常");
      }
      if (parsed.success === false) {
        throw new TuyaOpenApiError(
          String(parsed.msg || "涂鸦 OpenAPI 调用失败"),
          parsed.code as number | string | undefined,
        );
      }
      return parsed.result as T;
    } catch (err) {
      if (err instanceof TuyaOpenApiError) {
        throw err;
      }
      if (err instanceof Error && err.name === "AbortError") {
        throw new TuyaOpenApiError("请求涂鸦 OpenAPI 超时，请检查网络连接", "TIMEOUT", {
          cause: err,
        });
      }
      throw new TuyaOpenApiError(
        `请求涂鸦 OpenAPI 失败: ${err instanceof Error ? err.message : String(err)}`,
        undefined,
        { cause: err },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  // ---------- OpenAPI v2.0 业务方法 ----------

  async listUserDevices(uid: string): Promise<TuyaOpenApiDevice[]> {
    const trimmedUid = uid.trim();
    if (!trimmedUid) {
      throw new TuyaOpenApiError("缺少涂鸦用户 UID，请在配置中填写 UID");
    }
    const res = await this._authorizedRequest<unknown>(
      "GET",
      `/v1.0/users/${encodeURIComponent(trimmedUid)}/devices`,
    );
    if (!Array.isArray(res)) return [];
    return res.filter(isRecord) as unknown as TuyaOpenApiDevice[];
  }

  async getDeviceStatus(id: string): Promise<TuyaStatusItem[]> {
    const res = await this._authorizedRequest<unknown>(
      "GET",
      `/v1.0/devices/${encodeURIComponent(id)}/status`,
    );
    if (!Array.isArray(res)) return [];
    return res
      .filter(isRecord)
      .filter((item) => typeof item.code === "string")
      .map((item) => ({ code: String(item.code), value: item.value }));
  }

  async getDeviceSpecification(id: string): Promise<TuyaDeviceSpecification> {
    const res = await this._authorizedRequest<unknown>(
      "GET",
      `/v1.0/devices/${encodeURIComponent(id)}/specifications`,
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

  async sendDeviceCommands(id: string, commands: TuyaCommandItem[]): Promise<boolean> {
    const res = await this._authorizedRequest<unknown>(
      "POST",
      `/v1.0/devices/${encodeURIComponent(id)}/commands`,
      { commands },
    );
    return res !== false;
  }

  async listHomes(uid: string): Promise<TuyaOpenApiHome[]> {
    const trimmedUid = uid.trim();
    if (!trimmedUid) return [];
    const res = await this._authorizedRequest<unknown>(
      "GET",
      `/v1.0/users/${encodeURIComponent(trimmedUid)}/homes`,
    );
    if (!Array.isArray(res)) return [];
    return res
      .filter(isRecord)
      .map((item) => ({
        home_id: String(item.home_id ?? item.id ?? ""),
        name: String(item.name ?? "默认家庭"),
        ...(typeof item.geo_name === "string" ? { geo_name: item.geo_name } : {}),
      }))
      .filter((h) => h.home_id.length > 0);
  }

  async listHomeRooms(homeId: string): Promise<TuyaOpenApiRoom[]> {
    const trimmedHomeId = homeId.trim();
    if (!trimmedHomeId) return [];
    const res = await this._authorizedRequest<unknown>(
      "GET",
      `/v1.0/homes/${encodeURIComponent(trimmedHomeId)}/rooms`,
    );
    const rawRooms = Array.isArray(res)
      ? res
      : isRecord(res) && Array.isArray(res.rooms)
        ? res.rooms
        : [];
    return rawRooms
      .filter(isRecord)
      .map((item) => ({
        room_id: String(item.room_id ?? item.id ?? "").trim(),
        name: String(item.name ?? item.room_name ?? "").trim(),
      }))
      .filter((r) => r.room_id.length > 0 && r.name.length > 0);
  }

  async listRoomDevices(homeId: string, roomId: string): Promise<TuyaOpenApiDevice[]> {
    const trimmedHomeId = homeId.trim();
    const trimmedRoomId = roomId.trim();
    if (!trimmedHomeId || !trimmedRoomId) return [];
    const res = await this._authorizedRequest<unknown>(
      "GET",
      `/v1.0/homes/${encodeURIComponent(trimmedHomeId)}/rooms/${encodeURIComponent(trimmedRoomId)}/devices`,
    );
    if (!Array.isArray(res)) return [];
    return res.filter(isRecord) as unknown as TuyaOpenApiDevice[];
  }

  async listHomeScenes(homeId: string): Promise<TuyaOpenApiScene[]> {
    const res = await this._authorizedRequest<unknown>(
      "GET",
      `/v1.0/homes/${encodeURIComponent(homeId)}/scenes`,
    );
    if (!Array.isArray(res)) return [];
    return res
      .filter(isRecord)
      .map((item) => ({
        scene_id: String(item.scene_id ?? item.id ?? ""),
        name: String(item.name ?? ""),
        home_id: homeId,
        ...(typeof item.enabled === "boolean" ? { enabled: item.enabled } : {}),
      }))
      .filter((s) => s.scene_id.length > 0);
  }

  async triggerScene(homeId: string, sceneId: string): Promise<boolean> {
    const res = await this._authorizedRequest<unknown>(
      "POST",
      `/v1.0/homes/${encodeURIComponent(homeId)}/scenes/${encodeURIComponent(sceneId)}/trigger`,
    );
    return res !== false;
  }

  // ---------- OpenAPI v2.0 红外遥控器 (IR Control Hub) 业务方法 ----------

  async listInfraredRemotes(infraredId: string): Promise<TuyaOpenApiIrRemote[]> {
    const trimmed = infraredId.trim();
    if (!trimmed) return [];
    const res = await this._authorizedRequest<unknown>(
      "GET",
      `/v2.0/infrareds/${encodeURIComponent(trimmed)}/remotes`,
    );
    if (!Array.isArray(res)) return [];
    return res
      .filter(isRecord)
      .map((item) => ({
        remote_id: String(item.remote_id ?? "").trim(),
        remote_name: String(item.remote_name ?? item.remote_id ?? "").trim(),
        category_id: Number(item.category_id ?? 0),
        ...(typeof item.remote_index === "number" ? { remote_index: item.remote_index } : {}),
        ...(typeof item.brand_id === "number" ? { brand_id: item.brand_id } : {}),
        ...(typeof item.brand_name === "string" ? { brand_name: item.brand_name } : {}),
      }))
      .filter((r) => r.remote_id.length > 0);
  }

  async getInfraredRemoteKeys(
    infraredId: string,
    remoteId: string,
  ): Promise<TuyaOpenApiIrRemoteKeysResult | null> {
    const res = await this._authorizedRequest<unknown>(
      "GET",
      `/v2.0/infrareds/${encodeURIComponent(infraredId)}/remotes/${encodeURIComponent(remoteId)}/keys`,
    );
    if (!isRecord(res)) return null;
    const rawList = Array.isArray(res.key_list) ? res.key_list : [];
    const key_list: TuyaOpenApiIrKey[] = rawList
      .filter(isRecord)
      .filter((k) => typeof k.key === "string" && k.key.trim().length > 0)
      .map((k) => ({
        key: String(k.key).trim(),
        ...(typeof k.key_id === "number" ? { key_id: k.key_id } : {}),
        ...(typeof k.key_name === "string" ? { key_name: k.key_name } : {}),
        ...(typeof k.standard_key === "boolean" ? { standard_key: k.standard_key } : {}),
      }));
    return {
      ...(typeof res.category_id === "number" ? { category_id: res.category_id } : {}),
      ...(typeof res.remote_index === "number" ? { remote_index: res.remote_index } : {}),
      ...(typeof res.brand_id === "number" ? { brand_id: res.brand_id } : {}),
      key_list,
    };
  }

  async listInfraredLearningCodes(
    infraredId: string,
    remoteId: string,
  ): Promise<TuyaOpenApiIrLearningCode[]> {
    const res = await this._authorizedRequest<unknown>(
      "GET",
      `/v2.0/infrareds/${encodeURIComponent(infraredId)}/remotes/${encodeURIComponent(remoteId)}/learning-codes`,
    );
    if (!Array.isArray(res)) return [];
    return res
      .filter(isRecord)
      .filter((item) => typeof item.code === "string" && item.code.trim().length > 0)
      .map((item) => ({
        ...(typeof item.id === "number" ? { id: item.id } : {}),
        key: String(item.key ?? item.key_name ?? item.id ?? "").trim(),
        ...(typeof item.key_name === "string" ? { key_name: item.key_name } : {}),
        code: String(item.code).trim(),
      }))
      .filter((item) => item.key.length > 0);
  }

  async getInfraredAcStatus(infraredId: string, remoteId: string): Promise<Record<string, unknown>> {
    const res = await this._authorizedRequest<unknown>(
      "GET",
      `/v2.0/infrareds/${encodeURIComponent(infraredId)}/remotes/${encodeURIComponent(remoteId)}/ac/status`,
    );
    return isRecord(res) ? { ...res } : {};
  }

  async sendInfraredRawCommand(
    infraredId: string,
    remoteId: string,
    payload: {
      category_id: number;
      remote_index?: number;
      key: string;
      key_id?: number;
    },
  ): Promise<boolean> {
    const body: Record<string, unknown> = {
      category_id: payload.category_id,
      key: payload.key,
    };
    if (payload.remote_index !== undefined) body.remote_index = payload.remote_index;
    if (payload.key_id !== undefined) body.key_id = payload.key_id;
    const res = await this._authorizedRequest<unknown>(
      "POST",
      `/v2.0/infrareds/${encodeURIComponent(infraredId)}/remotes/${encodeURIComponent(remoteId)}/raw/command`,
      body,
    );
    return res !== false;
  }

  async sendInfraredLearningCode(
    infraredId: string,
    remoteId: string,
    code: string,
  ): Promise<boolean> {
    const res = await this._authorizedRequest<unknown>(
      "POST",
      `/v2.0/infrareds/${encodeURIComponent(infraredId)}/remotes/${encodeURIComponent(remoteId)}/learning-codes`,
      { code },
    );
    return res !== false;
  }

  async sendInfraredAcCommand(
    infraredId: string,
    remoteId: string,
    payload: { power?: number; mode?: number; temp?: number; wind?: number },
  ): Promise<boolean> {
    const body: Record<string, unknown> = {};
    if (payload.power !== undefined) body.power = payload.power;
    if (payload.mode !== undefined) body.mode = payload.mode;
    if (payload.temp !== undefined) body.temp = payload.temp;
    if (payload.wind !== undefined) body.wind = payload.wind;
    const res = await this._authorizedRequest<unknown>(
      "POST",
      `/v2.0/infrareds/${encodeURIComponent(infraredId)}/air-conditioners/${encodeURIComponent(remoteId)}/scenes/command`,
      body,
    );
    return res !== false;
  }
}
