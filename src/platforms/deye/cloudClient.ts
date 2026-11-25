// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 德业智能云端 API 客户端（忠实对应 stackia/libdeye cloud_api.py）

import { Buffer } from "node:buffer";

import {
  DEYE_API_END_USER_ENDPOINT,
  DEYE_LOGIN_PARAM_APP_ID,
  DEYE_LOGIN_PARAM_EXTEND,
  type DeyeIotPlatform,
} from "./constants.ts";

export class DeyeCloudApiError extends Error {
  readonly code?: number;

  constructor(message: string, options?: { code?: number; cause?: unknown }) {
    super(message, { cause: options?.cause });
    this.name = "DeyeCloudApiError";
    this.code = options?.code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class DeyeCloudApiInvalidAuthError extends DeyeCloudApiError {
  constructor(message = "德业智能账号认证失败或登录令牌已失效", options?: { code?: number; cause?: unknown }) {
    super(message, options);
    this.name = "DeyeCloudApiInvalidAuthError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class DeyeCloudApiCannotConnectError extends DeyeCloudApiError {
  constructor(message = "无法连接到德业智能云端服务器", options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DeyeCloudApiCannotConnectError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface DeyeJwtPayload {
  enduserid: string;
  exp: number;
  [key: string]: unknown;
}

export interface DeyeApiResponseMeta {
  code: number;
  message: string;
}

export interface DeyeApiResponseEnvelope<T = unknown> {
  meta: DeyeApiResponseMeta;
  data: T;
}

export interface DeyeCloudDeviceInfo {
  producttype_id?: number;
  device_name: string;
  product_name: string;
  platform: DeyeIotPlatform | number;
  mac: string;
  protocol_version: string;
  gatewaytype?: number;
  is_combo: boolean;
  alias?: string;
  deviceid?: string;
  product_id: string;
  role?: number;
  device_id: string;
  product_icon?: string;
  online: boolean;
  product_type?: string;
  payload?: unknown;
  picture_v3?: string;
  work_time?: number;
  user_count?: number;
}

export interface DeyeProductDefinition {
  productid: string;
  pname: string;
  brand: string;
  model: string;
  picture?: string;
  picture_v3?: string | null;
  config_guide?: string;
  status?: number;
  configType?: number;
}

export interface DeyeProductType {
  ptype: string;
  ptypename: string;
  pdata: DeyeProductDefinition[];
}

export interface DeyeClassicMqttInfo {
  password: string;
  loginname: string;
  mqtthost: string;
  mqttport: number;
  clientid: string;
  endpoint: string;
  sslport: number;
}

export interface DeyeFogMqttTopics {
  all: string[];
  pub: string[];
  sub: string[];
}

export interface DeyeFogMqttInfo {
  username: string;
  clientid: string;
  password: string;
  mqtt_host: string;
  ws_port: string;
  ssl_port: string;
  topic: DeyeFogMqttTopics;
  expire: number;
}

export type DeyeFogDeviceProperties = Record<string, unknown>;

export interface DeyeCloudClientOptions {
  username?: string;
  password?: string;
  authToken?: string;
  endpoint?: string;
  httpFetch?: typeof fetch;
  timeoutMs?: number;
  nowMs?: () => number;
  onAuthTokenRefreshed?: (token: string) => void;
}

const TOKEN_REFRESH_THRESHOLD_SEC = 24 * 60 * 60;
const DEFAULT_TIMEOUT_MS = 12_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 纯 Base64URL 解码 JWT 载荷（不依赖外部 JWT 库），提取 `enduserid` 与 `exp`。
 */
export function decodeJwtPayload(token: string): DeyeJwtPayload {
  const parts = token.trim().split(".");
  if (parts.length !== 3 || !parts[1]) {
    throw new DeyeCloudApiInvalidAuthError("德业 JWT 令牌格式无效");
  }
  try {
    const base64Url = parts[1];
    const base64 = base64Url.replaceAll("-", "+").replaceAll("_", "/");
    const padLen = (4 - (base64.length % 4)) % 4;
    const padded = base64 + "=".repeat(padLen);
    const decodedText = Buffer.from(padded, "base64").toString("utf8");
    const parsed: unknown = JSON.parse(decodedText);
    if (!isRecord(parsed)) {
      throw new DeyeCloudApiInvalidAuthError("德业 JWT 载荷不是有效对象");
    }
    const enduserid = parsed["enduserid"];
    const exp = parsed["exp"];
    if (
      (typeof enduserid !== "string" && typeof enduserid !== "number") ||
      typeof exp !== "number" ||
      !Number.isFinite(exp)
    ) {
      throw new DeyeCloudApiInvalidAuthError("德业 JWT 载荷缺少 enduserid 或 exp 字段");
    }
    return {
      ...parsed,
      enduserid: String(enduserid),
      exp,
    };
  } catch (err) {
    if (err instanceof DeyeCloudApiInvalidAuthError) {
      throw err;
    }
    throw new DeyeCloudApiInvalidAuthError("解析德业 JWT 令牌失败", { cause: err });
  }
}

function ensureValidResponseEnvelope<T>(raw: unknown): DeyeApiResponseEnvelope<T> {
  if (!isRecord(raw) || !isRecord(raw["meta"]) || typeof raw["meta"]["code"] !== "number") {
    throw new DeyeCloudApiCannotConnectError("德业云端返回了无法识别的响应格式");
  }
  const code = raw["meta"]["code"];
  const message = typeof raw["meta"]["message"] === "string" ? raw["meta"]["message"] : "";
  if (code !== 0) {
    throw new DeyeCloudApiInvalidAuthError(
      message ? `德业云端拒绝请求（错误码 ${code}）：${message}` : `德业云端拒绝请求（错误码 ${code}）`,
      { code },
    );
  }
  return {
    meta: { code, message },
    data: raw["data"] as T,
  };
}

export class DeyeCloudClient {
  private _username: string;
  private _password: string;
  private _authToken: string | null = null;
  private _userId: string | null = null;
  private _authTokenExp: number | null = null;
  private readonly _endpoint: string;
  private readonly _httpFetch: typeof fetch;
  private readonly _timeoutMs: number;
  private readonly _nowMs: () => number;
  onAuthTokenRefreshed?: (token: string) => void;

  constructor(options: DeyeCloudClientOptions = {}) {
    this._username = options.username?.trim() ?? "";
    this._password = options.password ?? "";
    this._endpoint = (options.endpoint?.trim() || DEYE_API_END_USER_ENDPOINT).replace(/\/+$/, "");
    this._httpFetch = options.httpFetch ?? fetch;
    this._timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this._nowMs = options.nowMs ?? (() => Date.now());
    this.onAuthTokenRefreshed = options.onAuthTokenRefreshed;

    if (options.authToken && options.authToken.trim()) {
      this.setAuthToken(options.authToken.trim());
    }
  }

  get endpoint(): string {
    return this._endpoint;
  }

  get authToken(): string | null {
    return this._authToken;
  }

  get userId(): string | null {
    return this._userId;
  }

  get authTokenExp(): number | null {
    return this._authTokenExp;
  }

  setCredentials(username: string, password: string): void {
    this._username = username.trim();
    this._password = password;
  }

  setAuthToken(token: string | null): void {
    if (!token || !token.trim()) {
      this._authToken = null;
      this._userId = null;
      this._authTokenExp = null;
      return;
    }
    const trimmed = token.trim();
    const payload = decodeJwtPayload(trimmed);
    this._authToken = trimmed;
    this._userId = payload.enduserid;
    this._authTokenExp = payload.exp;
  }

  /** 检查令牌是否已过期或距离过期不足阈值（默认 24 小时） */
  isTokenNearExpiry(thresholdSec = TOKEN_REFRESH_THRESHOLD_SEC): boolean {
    if (!this._authToken || this._authTokenExp === null) {
      return true;
    }
    const nowSec = this._nowMs() / 1000;
    return this._authTokenExp - nowSec <= thresholdSec;
  }

  private async _fetchJson<T>(
    url: string,
    init: RequestInit,
  ): Promise<DeyeApiResponseEnvelope<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this._timeoutMs);
    try {
      const response = await this._httpFetch(url, {
        ...init,
        signal: controller.signal,
      });
      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch (err) {
        if (!response.ok) {
          throw new DeyeCloudApiCannotConnectError(
            `德业云端接口 HTTP ${response.status} 请求失败`,
            { cause: err },
          );
        }
        throw new DeyeCloudApiCannotConnectError("德业云端响应 JSON 解析失败", { cause: err });
      }
      return ensureValidResponseEnvelope<T>(parsed);
    } catch (err) {
      if (err instanceof DeyeCloudApiError) {
        throw err;
      }
      throw new DeyeCloudApiCannotConnectError(
        `德业云端网络请求异常：${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /** 使用德业账号密码登录获取 JWT 令牌 */
  async authenticate(username?: string, password?: string): Promise<string> {
    const loginname = (username ?? this._username).trim();
    const pwd = password ?? this._password;
    if (!loginname || !pwd) {
      throw new DeyeCloudApiInvalidAuthError("请提供有效的德业智能账号与密码");
    }
    this._username = loginname;
    this._password = pwd;

    const result = await this._fetchJson<{ token?: unknown }>(`${this._endpoint}/login/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        appid: DEYE_LOGIN_PARAM_APP_ID,
        extend: DEYE_LOGIN_PARAM_EXTEND,
        pushtype: "Ali",
        loginname,
        password: pwd,
      }),
    });

    const token = isRecord(result.data) && typeof result.data["token"] === "string"
      ? result.data["token"]
      : "";
    if (!token) {
      throw new DeyeCloudApiInvalidAuthError("德业登录响应未返回有效令牌");
    }
    this.setAuthToken(token);
    return token;
  }

  /**
   * 距离过期不足 24 小时（或 force=true）时自动调用 `/refreshToken/` 刷新令牌；
   * 若刷新令牌被云端拒绝则回退使用账号密码重新登录。
   */
  async refreshTokenIfNearExpiry(force = false): Promise<void> {
    if (!this._authToken || this._authTokenExp === null) {
      if (this._username && this._password) {
        const token = await this.authenticate();
        this.onAuthTokenRefreshed?.(token);
        return;
      }
      throw new DeyeCloudApiInvalidAuthError("尚未登录德业智能账号");
    }

    if (!force && !this.isTokenNearExpiry(TOKEN_REFRESH_THRESHOLD_SEC)) {
      return;
    }

    try {
      const result = await this._fetchJson<{ token?: unknown }>(
        `${this._endpoint}/refreshToken/`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ token: this._authToken }),
        },
      );
      const refreshed =
        isRecord(result.data) && typeof result.data["token"] === "string"
          ? result.data["token"]
          : "";
      if (!refreshed) {
        throw new DeyeCloudApiInvalidAuthError("德业刷新令牌接口未返回新令牌");
      }
      this.setAuthToken(refreshed);
      this.onAuthTokenRefreshed?.(refreshed);
    } catch (err) {
      if (err instanceof DeyeCloudApiInvalidAuthError && this._username && this._password) {
        const token = await this.authenticate();
        this.onAuthTokenRefreshed?.(token);
        return;
      }
      throw err;
    }
  }

  private async _requestAuthenticated<T>(
    method: "GET" | "POST",
    path: string,
    body?: Record<string, unknown>,
  ): Promise<DeyeApiResponseEnvelope<T>> {
    await this.refreshTokenIfNearExpiry();

    const headers: Record<string, string> = {};
    if (this._authToken) {
      headers["Authorization"] = `JWT ${this._authToken}`;
    }
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    const cleanPath = path.replace(/^\/+/, "");
    return await this._fetchJson<T>(`${this._endpoint}/${cleanPath}`, init);
  }

  /** 获取当前账号下的全部设备列表 */
  async getDeviceList(): Promise<DeyeCloudDeviceInfo[]> {
    const result = await this._requestAuthenticated<DeyeCloudDeviceInfo[]>(
      "GET",
      "deviceList/?app=new",
    );
    return Array.isArray(result.data) ? result.data : [];
  }

  /** 获取德业全品类产品定义目录 */
  async getProductList(): Promise<DeyeProductType[]> {
    const result = await this._requestAuthenticated<{ result?: DeyeProductType[] }>(
      "GET",
      "productlist/?app=new",
    );
    return isRecord(result.data) && Array.isArray(result.data["result"])
      ? result.data["result"]
      : [];
  }

  /** 获取 Classic / Combo 平台 MQTT 连接信息 */
  async getClassicMqttInfo(): Promise<DeyeClassicMqttInfo> {
    const result = await this._requestAuthenticated<DeyeClassicMqttInfo>("GET", "mqttInfo/");
    return result.data;
  }

  /** 获取 Fog 平台 MQTT 连接信息 */
  async getFogMqttInfo(): Promise<DeyeFogMqttInfo> {
    const rand = encodeURIComponent(String(Math.random()));
    const result = await this._requestAuthenticated<DeyeFogMqttInfo>(
      "GET",
      `fogmqttinfo/?random=${rand}`,
    );
    return result.data;
  }

  /** 读取 Fog 平台设备属性 */
  async getFogDeviceProperties(deviceId: string): Promise<DeyeFogDeviceProperties> {
    const query = new URLSearchParams({
      device_id: deviceId,
      random: String(Math.random()),
    });
    const result = await this._requestAuthenticated<{ properties?: DeyeFogDeviceProperties }>(
      "GET",
      `get/properties/?${query.toString()}`,
    );
    if (isRecord(result.data) && isRecord(result.data["properties"])) {
      return result.data["properties"];
    }
    return isRecord(result.data) ? result.data : {};
  }

  /** 触发 Fog 设备主动上报最新实时数据（RealData: 1） */
  async pollFogDeviceProperties(deviceId: string): Promise<void> {
    await this._requestAuthenticated("POST", "set/properties/", {
      device_id: deviceId,
      params: { RealData: 1 },
    });
  }

  /** 写入 Fog 平台设备控制属性 */
  async setFogDeviceProperties(
    deviceId: string,
    params: Record<string, number>,
  ): Promise<void> {
    await this._requestAuthenticated("POST", "set/properties/", {
      device_id: deviceId,
      params,
    });
  }
}
