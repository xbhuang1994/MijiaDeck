// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 美的云端客户端（支持美的美居 Meiju / MSmartHome / NetHome Plus / Midea Air）

import { randomBytes } from "node:crypto";
import {
  MIDEA_CLOUD_PRESETS,
  MIDEA_DEFAULT_FALLBACK_KEYPAIR,
  parseMideaTypeCode,
  type MideaCloudBrand,
  type MideaCloudPreset,
} from "./constants.ts";
import { mideaChecksum } from "./protocols.ts";
import { MideaCloudSecurity } from "./security.ts";

export interface MideaCloudClientOptions {
  brand: MideaCloudBrand;
  account: string;
  password: string;
  useChinaServer?: boolean;
  httpFetch?: typeof fetch;
  timeoutMs?: number;
  nowMs?: () => number;
  /** 可选：预加载的持久化云端会话，用于跨重启免重复登录 */
  initialSession?: Partial<MideaCloudSession> | null;
  /** 会话更新（登录成功）或清空（失效/登出）时的回调，用于持久化缓存 */
  onSessionChange?: (session: MideaCloudSession | null) => void;
  /** 自动重登最小冷却时间（毫秒，默认 60 秒） */
  reloginCooldownMs?: number;
  /** 风控锁定或登录设备超限（7610 / 65027）时的退避时间（毫秒，默认 5 分钟） */
  lockoutCooldownMs?: number;
  /** 持久化会话无服务端过期时间时的最大可信时长（毫秒，默认 30 天） */
  sessionMaxAgeMs?: number;
}

export interface MideaCloudLoginOptions {
  /** 为 true 时即使当前已有未过期会话也强制重新登录 */
  force?: boolean;
}

export interface MideaCloudSession {
  brand: MideaCloudBrand;
  account?: string;
  useChinaServer?: boolean;
  baseUrl?: string;
  uid: string;
  accessToken: string;
  sessionId: string;
  aesKeyHex?: string;
  aesIvHex?: string;
  deviceId?: string;
  loggedInAt: number;
  expiresAt?: number;
}

export interface MideaCloudHome {
  homeId: string;
  name: string;
  isDefault: boolean;
}

export interface MideaCloudAppliance {
  id: string;
  name: string;
  type: number;
  modelNumber: string;
  sn: string;
  sn8: string;
  manufacturerCode?: string;
  online: boolean;
  homeId: string;
  homeName: string;
  roomName: string;
  protocolVersion: 2 | 3;
}

export interface MideaLuaApplianceMeta {
  deviceType?: number;
  sn?: string;
  modelNumber?: string;
  manufacturerCode?: string;
}

export interface MideaTransparentSendOptions {
  /** 允许 1306（异步应答缺失）视作已下发并返回 null，常用于写控制指令。 */
  allowAsyncReplyMissing?: boolean;
}

export interface MideaTokenKeyPair {
  token: string;
  key: string;
  method?: number;
  udpId?: string;
  isDefaultFallback?: boolean;
}

export class MideaCloudError extends Error {
  readonly code?: string | number;
  readonly isAuthError: boolean;
  readonly isCooldownError: boolean;

  constructor(
    message: string,
    code?: string | number,
    options?: ErrorOptions & { isAuthError?: boolean; isCooldownError?: boolean },
  ) {
    super(message, options);
    this.name = "MideaCloudError";
    this.code = code;
    this.isAuthError = Boolean(options?.isAuthError);
    this.isCooldownError = Boolean(options?.isCooldownError);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

const DEFAULT_RELOGIN_COOLDOWN_MS = 60_000;
const DEFAULT_LOCKOUT_COOLDOWN_MS = 5 * 60_000;
const DEFAULT_SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const EXPIRY_SAFETY_MARGIN_MS = 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatStamp(date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}` +
    `${pad(date.getMonth() + 1)}` +
    `${pad(date.getDate())}` +
    `${pad(date.getHours())}` +
    `${pad(date.getMinutes())}` +
    `${pad(date.getSeconds())}`
  );
}

function createReqId(): string {
  return randomBytes(16).toString("hex");
}

function parseOnlineFlag(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") {
    const lower = value.trim().toLowerCase();
    return lower === "1" || lower === "true" || lower === "online";
  }
  return false;
}

function parseProtocolVersion(raw: Record<string, unknown>): 2 | 3 {
  const proto = raw["protocolVersion"] ?? raw["protocol"] ?? raw["supportLocal"];
  if (proto === 2 || proto === "2" || proto === "v2") {
    return 2;
  }
  return 3;
}

function isValidPlainMideaFrame(buf: Buffer): boolean {
  if (buf.length < 12 || buf[0] !== 0xaa) {
    return false;
  }
  const totalLen = buf[1]! + 1;
  if (totalLen < 12 || totalLen > buf.length) {
    return false;
  }
  return mideaChecksum(buf.subarray(1, totalLen - 1)) === buf[totalLen - 1];
}

function isLoginEndpoint(endpoint: string): boolean {
  return endpoint.includes("/user/login") || endpoint.includes("/unitcenter/router/");
}

function isTokenInvalidError(code: string, msg: string): boolean {
  if (
    code === "40002" ||
    code === "7400" ||
    code === "40001" ||
    code === "3106" ||
    code === "3144"
  ) {
    return true;
  }
  const lower = msg.toLowerCase();
  return (
    lower.includes("user token not exist") ||
    lower.includes("user does not exist") ||
    lower.includes("token invalid") ||
    lower.includes("token expired") ||
    (lower.includes("token") && lower.includes("not exist")) ||
    msg.includes("token校验不通过") ||
    msg.includes("登录失效") ||
    msg.includes("会话失效")
  );
}

function isPermanentAuthFailureCode(code: string): boolean {
  return code === "3101" || code === "3102";
}

function isLockoutOrDeviceLimitCode(code: string): boolean {
  return code === "7610" || code === "65027";
}

function extractSessionExpiresAt(
  loginData: Record<string, unknown>,
  mdata: Record<string, unknown> | null,
  nowMs: number,
): number | undefined {
  const tokenPwdInfo = mdata && isRecord(mdata["tokenPwdInfo"]) ? mdata["tokenPwdInfo"] : null;
  const absoluteCandidates: unknown[] = [
    mdata?.["expiredDate"],
    mdata?.["expireTime"],
    tokenPwdInfo?.["expiredDate"],
    loginData["expiredDate"],
    loginData["expireTime"],
  ];
  for (const raw of absoluteCandidates) {
    const num = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
    if (!Number.isFinite(num) || num <= 0) continue;
    const tsMs = num < 1_000_000_000_000 ? num * 1000 : num;
    if (tsMs > nowMs + EXPIRY_SAFETY_MARGIN_MS) {
      return tsMs;
    }
  }
  const relRaw = mdata?.["expiresIn"] ?? loginData["expiresIn"] ?? loginData["expireIn"];
  const relSec =
    typeof relRaw === "number" ? relRaw : typeof relRaw === "string" ? Number(relRaw) : NaN;
  if (Number.isFinite(relSec) && relSec > 60) {
    return nowMs + relSec * 1000;
  }
  return undefined;
}

function unwrapLuaResponseData(
  data: Record<string, unknown>,
  context: string,
): Record<string, unknown> {
  const innerCode = data["code"];
  if (innerCode !== undefined && String(innerCode) !== "0") {
    const codeStr = String(innerCode);
    const msg =
      typeof data["msg"] === "string" && data["msg"].trim()
        ? data["msg"].trim()
        : `${context}返回错误`;
    throw new MideaCloudError(`美的云端错误 (${codeStr}): ${msg}`, codeStr);
  }
  if (isRecord(data["status"])) {
    return data["status"];
  }
  return data;
}

function parseReplyToBuffer(reply: unknown, security: MideaCloudSecurity): Buffer | null {
  if (typeof reply !== "string") {
    return null;
  }
  const trimmed = reply.trim();
  if (!trimmed) {
    return null;
  }
  // 格式 1：逗号分隔字节列表（部分美的透传接口返回有符号或无符号十进制字节）
  if (trimmed.includes(",")) {
    const nums = trimmed
      .split(",")
      .map((s) => Number.parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n))
      .map((n) => n & 0xff);
    return nums.length > 0 ? Buffer.from(nums) : null;
  }
  if (/^[0-9a-f]+$/i.test(trimmed) && trimmed.length % 2 === 0) {
    const rawBuf = Buffer.from(trimmed, "hex");
    // 格式 2：直接十六进制 0xAA 明文帧（校验长度与校验和，避免 AES 密文偶发以 0xAA 开头被误判）
    if (isValidPlainMideaFrame(rawBuf)) {
      return rawBuf;
    }
    // 格式 3：AES 加密后的十六进制密文
    if (trimmed.length >= 32 && trimmed.length % 32 === 0) {
      try {
        const decrypted = security.aesDecryptBytes(trimmed);
        const asText = decrypted.toString("utf-8").trim();
        if (asText.includes(",")) {
          const parsedCsv = parseReplyToBuffer(asText, security);
          if (parsedCsv) {
            return parsedCsv;
          }
        }
        if (/^[0-9a-f]+$/i.test(asText) && asText.length % 2 === 0) {
          return Buffer.from(asText, "hex");
        }
        if (decrypted.includes(0xaa)) {
          return decrypted;
        }
        return decrypted;
      } catch {
        return rawBuf;
      }
    }
    if (rawBuf[0] === 0xaa) {
      return rawBuf;
    }
  }
  return null;
}

export class MideaCloudClient {
  readonly preset: MideaCloudPreset;
  readonly security: MideaCloudSecurity;
  private readonly _account: string;
  private readonly _password: string;
  private readonly _useChinaServer: boolean;
  private readonly _baseUrl: string;
  private readonly _httpFetch: typeof fetch;
  private readonly _timeoutMs: number;
  private readonly _nowMs: () => number;
  private readonly _reloginCooldownMs: number;
  private readonly _lockoutCooldownMs: number;
  private readonly _sessionMaxAgeMs: number;

  private _onSessionChange?: (session: MideaCloudSession | null) => void;
  private _session: MideaCloudSession | null = null;
  private _inFlightLogin: Promise<MideaCloudSession> | null = null;
  private _autoLoginBlockedUntil = 0;
  private _permanentAuthError: MideaCloudError | null = null;
  private _consecutiveLoginFailures = 0;
  private _lastAutoReloginAt = Number.NEGATIVE_INFINITY;
  private _consecutiveAutoRelogins = 0;

  constructor(options: MideaCloudClientOptions) {
    this.preset = MIDEA_CLOUD_PRESETS[options.brand];
    this.security = new MideaCloudSecurity(this.preset);
    this._account = options.account.trim();
    this._password = options.password;
    this._useChinaServer = Boolean(options.useChinaServer);
    this._baseUrl =
      this._useChinaServer && this.preset.apiUrlChina
        ? this.preset.apiUrlChina
        : this.preset.apiUrl;
    this._httpFetch = options.httpFetch ?? fetch;
    this._timeoutMs = options.timeoutMs ?? 12_000;
    this._nowMs = options.nowMs ?? (() => Date.now());
    this._onSessionChange = options.onSessionChange;
    this._reloginCooldownMs = Math.max(0, options.reloginCooldownMs ?? DEFAULT_RELOGIN_COOLDOWN_MS);
    this._lockoutCooldownMs = Math.max(
      this._reloginCooldownMs,
      options.lockoutCooldownMs ?? DEFAULT_LOCKOUT_COOLDOWN_MS,
    );
    this._sessionMaxAgeMs = Math.max(60_000, options.sessionMaxAgeMs ?? DEFAULT_SESSION_MAX_AGE_MS);

    if (options.initialSession) {
      this.restoreSession(options.initialSession, { notify: false });
    }
  }

  get baseUrl(): string {
    return this._baseUrl;
  }

  get supportsLuaCloud(): boolean {
    return this.preset.protocol === "mas";
  }

  private _hasSessionCredential(session: MideaCloudSession | null): boolean {
    if (!session) return false;
    return this.preset.protocol === "mas"
      ? Boolean(session.accessToken)
      : Boolean(session.sessionId);
  }

  private _activeCredentialToken(): string {
    if (!this._session) return "";
    return this.preset.protocol === "mas" ? this._session.accessToken : this._session.sessionId;
  }

  private _isSessionExpired(session: MideaCloudSession): boolean {
    const now = this._nowMs();
    if (
      typeof session.expiresAt === "number" &&
      Number.isFinite(session.expiresAt) &&
      session.expiresAt > 0 &&
      now >= session.expiresAt - EXPIRY_SAFETY_MARGIN_MS
    ) {
      return true;
    }
    if (
      typeof session.loggedInAt === "number" &&
      Number.isFinite(session.loggedInAt) &&
      session.loggedInAt > 0 &&
      now - session.loggedInAt >= this._sessionMaxAgeMs
    ) {
      return true;
    }
    return false;
  }

  get isLoggedIn(): boolean {
    return Boolean(
      this._session &&
        this._hasSessionCredential(this._session) &&
        !this._isSessionExpired(this._session),
    );
  }

  get session(): MideaCloudSession | null {
    return this.exportSession();
  }

  exportSession(): MideaCloudSession | null {
    if (!this._session) return null;
    const aes = this.security.exportAesKeys();
    return {
      ...this._session,
      ...(aes?.keyHex ? { aesKeyHex: aes.keyHex } : {}),
      ...(aes?.ivHex ? { aesIvHex: aes.ivHex } : {}),
    };
  }

  setSessionChangeListener(listener?: (session: MideaCloudSession | null) => void): void {
    this._onSessionChange = listener;
  }

  private _notifySessionChange(session: MideaCloudSession | null): void {
    if (!this._onSessionChange) return;
    try {
      this._onSessionChange(session ? { ...session } : null);
    } catch {
      // 会话持久化回调异常不应中断主请求链路
    }
  }

  /**
   * 从持久化缓存恢复已登录会话，避免进程重启或配置保存后重复触发 `/mj/user/login`。
   */
  restoreSession(
    raw: Partial<MideaCloudSession> | null | undefined,
    options?: { notify?: boolean },
  ): boolean {
    if (!raw || raw.brand !== this.preset.brand) {
      return false;
    }
    if (raw.account && this._account && raw.account.trim() !== this._account) {
      return false;
    }
    if (raw.useChinaServer !== undefined && raw.useChinaServer !== this._useChinaServer) {
      return false;
    }
    if (raw.baseUrl && raw.baseUrl !== this._baseUrl) {
      return false;
    }
    const accessToken = typeof raw.accessToken === "string" ? raw.accessToken.trim() : "";
    const sessionId = typeof raw.sessionId === "string" ? raw.sessionId.trim() : "";
    const candidate: MideaCloudSession = {
      brand: this.preset.brand,
      account: this._account,
      useChinaServer: this._useChinaServer,
      baseUrl: this._baseUrl,
      uid: (typeof raw.uid === "string" && raw.uid.trim()) || this._account,
      accessToken,
      sessionId,
      ...(typeof raw.aesKeyHex === "string" && raw.aesKeyHex.trim()
        ? { aesKeyHex: raw.aesKeyHex.trim().toLowerCase() }
        : {}),
      ...(typeof raw.aesIvHex === "string" && raw.aesIvHex.trim()
        ? { aesIvHex: raw.aesIvHex.trim().toLowerCase() }
        : {}),
      deviceId:
        (typeof raw.deviceId === "string" && raw.deviceId.trim()) ||
        this.security.getDeviceId(this._account),
      loggedInAt:
        typeof raw.loggedInAt === "number" && Number.isFinite(raw.loggedInAt) && raw.loggedInAt > 0
          ? raw.loggedInAt
          : this._nowMs(),
      ...(typeof raw.expiresAt === "number" && Number.isFinite(raw.expiresAt) && raw.expiresAt > 0
        ? { expiresAt: raw.expiresAt }
        : {}),
    };

    if (!this._hasSessionCredential(candidate) || this._isSessionExpired(candidate)) {
      return false;
    }

    this.security.clearAesKeys();
    if (candidate.aesKeyHex) {
      this.security.restoreAesKeys(candidate.aesKeyHex, candidate.aesIvHex);
    }
    this._session = candidate;
    this._permanentAuthError = null;
    if (options?.notify) {
      this._notifySessionChange(this.exportSession());
    }
    return true;
  }

  clearSession(options?: { notify?: boolean }): void {
    const hadSession = this._session !== null;
    this._session = null;
    this.security.clearAesKeys();
    if (hadSession && options?.notify !== false) {
      this._notifySessionChange(null);
    }
  }

  private _computeAutoReloginCooldownMs(): number {
    if (this._reloginCooldownMs <= 0) return 0;
    const step = Math.max(0, Math.min(this._consecutiveAutoRelogins - 1, 2));
    return Math.min(this._reloginCooldownMs * 2 ** step, this._lockoutCooldownMs);
  }

  private _checkAutoLoginGate(reason: "ensure" | "relogin"): void {
    if (this._permanentAuthError) {
      throw this._permanentAuthError;
    }
    const now = this._nowMs();
    if (now < this._autoLoginBlockedUntil) {
      const remainSec = Math.max(1, Math.ceil((this._autoLoginBlockedUntil - now) / 1000));
      const hint =
        reason === "relogin"
          ? `美的云端会话重登冷却中（约 ${remainSec} 秒后自动恢复，避免频繁登录触发美居风控/互踢）`
          : `美的云端登录冷却中（约 ${remainSec} 秒后自动重试）`;
      throw new MideaCloudError(hint, "LOGIN_COOLDOWN", {
        isAuthError: true,
        isCooldownError: true,
      });
    }
  }

  private _startInFlightLogin(): Promise<MideaCloudSession> {
    if (!this._inFlightLogin) {
      this._inFlightLogin = this._executeLogin().finally(() => {
        this._inFlightLogin = null;
      });
    }
    return this._inFlightLogin;
  }

  private async _reloginAfterInvalidToken(failedToken: string): Promise<void> {
    // 1. 已有登录请求在途：直接复用同一单飞登录，不重复发起登录
    if (this._inFlightLogin) {
      await this._inFlightLogin;
      return;
    }

    // 2. 并发场景下其他请求已完成重登并换出新令牌：直接复用新令牌重试，严禁抹掉刚换到的会话
    const currentToken = this._activeCredentialToken();
    if (currentToken && currentToken !== failedToken && this.isLoggedIn) {
      return;
    }

    // 3. 确认当前令牌确实已失效，先清空并通知持久化层移除失效缓存
    this.clearSession({ notify: true });

    // 4. 校验永久认证错误与冷却窗口，防止轮询或 App 互踢引发登录风暴
    this._checkAutoLoginGate("relogin");

    const now = this._nowMs();
    const elapsedSinceLastRelogin = now - this._lastAutoReloginAt;
    const resetWindowMs = Math.max(this._lockoutCooldownMs, this._reloginCooldownMs * 5);

    if (this._reloginCooldownMs > 0 && Number.isFinite(elapsedSinceLastRelogin)) {
      const requiredWaitMs = this._computeAutoReloginCooldownMs();
      if (elapsedSinceLastRelogin < requiredWaitMs) {
        this._autoLoginBlockedUntil = Math.max(
          this._autoLoginBlockedUntil,
          this._lastAutoReloginAt + requiredWaitMs,
        );
        const remainSec = Math.max(1, Math.ceil((this._autoLoginBlockedUntil - now) / 1000));
        throw new MideaCloudError(
          `美的云端会话刚重登即失效，冷却 ${remainSec} 秒后再试以避免频繁重复登录（如手机美居 App 同时在线触发互踢，建议使用独立小号共享设备）`,
          "RELOGIN_COOLDOWN",
          { isAuthError: true, isCooldownError: true },
        );
      }
      if (elapsedSinceLastRelogin >= resetWindowMs) {
        this._consecutiveAutoRelogins = 0;
      }
    }

    this._lastAutoReloginAt = now;
    this._consecutiveAutoRelogins += 1;
    await this._startInFlightLogin();
  }

  private async _requestMas(
    endpoint: string,
    payload: Record<string, unknown>,
    options?: { requireAuth?: boolean; _retriedAfterLogin?: boolean },
  ): Promise<Record<string, unknown>> {
    const now = this._nowMs();
    const url = `${this._baseUrl}${endpoint}`;
    const random = String(Math.floor(now / 1000));
    const bodyObj: Record<string, unknown> = {
      appId: this.preset.appId,
      format: 2,
      clientType: 1,
      language: "zh_CN",
      src: this.preset.appId,
      stamp: formatStamp(new Date(now)),
      reqId: createReqId(),
      ...payload,
    };
    const jsonBody = JSON.stringify(bodyObj);
    const sign = this.security.sign(endpoint, jsonBody, random);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      secretVersion: "1",
      sign,
      random,
    };
    const usedAccessToken = options?.requireAuth !== false ? (this._session?.accessToken ?? "") : "";
    if (this.preset.brand === "msmarthome") {
      headers["x-recipe-app"] = this.preset.appId;
      headers["authorization"] = `Basic ${Buffer.from(
        `${this.preset.appKey}:${this.preset.iotKey ?? ""}`,
        "ascii",
      ).toString("base64")}`;
      if (options?.requireAuth !== false && this._session?.uid) {
        headers["uid"] = this._session.uid;
      }
    }
    if (usedAccessToken) {
      headers["accessToken"] = usedAccessToken;
    }

    let response: Response;
    try {
      response = await this._httpFetch(url, {
        method: "POST",
        headers,
        body: jsonBody,
        signal: AbortSignal.timeout(this._timeoutMs),
      });
    } catch (err) {
      throw new MideaCloudError(
        `请求美的云端接口 ${endpoint} 失败：网络不可达或超时`,
        undefined,
        { cause: err },
      );
    }

    if (!response.ok) {
      throw new MideaCloudError(`美的云端接口 ${endpoint} 返回 HTTP ${response.status}`, response.status);
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch (err) {
      throw new MideaCloudError(`美的云端接口 ${endpoint} 返回非 JSON 响应`, undefined, {
        cause: err,
      });
    }

    if (!isRecord(parsed)) {
      throw new MideaCloudError(`美的云端接口 ${endpoint} 响应结构异常`);
    }

    const code = parsed["code"];
    if (code !== undefined && String(code) !== "0") {
      const codeStr = String(code);
      const msg = typeof parsed["msg"] === "string" ? parsed["msg"] : "云端返回错误";
      if (
        options?.requireAuth !== false &&
        !options?._retriedAfterLogin &&
        !isLoginEndpoint(endpoint) &&
        isTokenInvalidError(codeStr, msg)
      ) {
        await this._reloginAfterInvalidToken(usedAccessToken);
        return await this._requestMas(endpoint, payload, {
          ...options,
          _retriedAfterLogin: true,
        });
      }
      throw new MideaCloudError(`美的云端错误 (${codeStr}): ${msg}`, codeStr, {
        isAuthError:
          isPermanentAuthFailureCode(codeStr) ||
          isLockoutOrDeviceLimitCode(codeStr) ||
          isTokenInvalidError(codeStr, msg),
        isCooldownError: isLockoutOrDeviceLimitCode(codeStr),
      });
    }

    return isRecord(parsed["data"]) ? parsed["data"] : parsed;
  }

  private async _requestLegacy(
    endpoint: string,
    payload: Record<string, unknown>,
    options?: { requireAuth?: boolean; _retriedAfterLogin?: boolean },
  ): Promise<Record<string, unknown>> {
    const now = this._nowMs();
    const url = `${this._baseUrl}${endpoint}`;
    const usedSessionId = options?.requireAuth !== false ? (this._session?.sessionId ?? "") : "";
    const formObj: Record<string, unknown> = {
      appId: this.preset.appId,
      format: 2,
      clientType: 1,
      language: "en_US",
      src: this.preset.appId,
      stamp: formatStamp(new Date(now)),
      ...payload,
    };
    if (usedSessionId) {
      formObj["sessionId"] = usedSessionId;
    }
    formObj["sign"] = this.security.sign(url, formObj);

    const formBody = new URLSearchParams();
    for (const [k, v] of Object.entries(formObj)) {
      if (v !== undefined && v !== null) {
        formBody.set(k, String(v));
      }
    }

    let response: Response;
    try {
      response = await this._httpFetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: formBody.toString(),
        signal: AbortSignal.timeout(this._timeoutMs),
      });
    } catch (err) {
      throw new MideaCloudError(
        `请求美的旧版云端接口 ${endpoint} 失败：网络不可达或超时`,
        undefined,
        { cause: err },
      );
    }

    if (!response.ok) {
      throw new MideaCloudError(
        `美的旧版云端接口 ${endpoint} 返回 HTTP ${response.status}`,
        response.status,
      );
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch (err) {
      throw new MideaCloudError(`美的旧版云端接口 ${endpoint} 返回非 JSON 响应`, undefined, {
        cause: err,
      });
    }

    if (!isRecord(parsed)) {
      throw new MideaCloudError(`美的旧版云端接口 ${endpoint} 响应结构异常`);
    }

    const errCode = parsed["errorCode"] ?? parsed["code"];
    if (errCode !== undefined && String(errCode) !== "0") {
      const codeStr = String(errCode);
      const msg = typeof parsed["msg"] === "string" ? parsed["msg"] : "云端返回错误";
      if (
        options?.requireAuth !== false &&
        !options?._retriedAfterLogin &&
        !isLoginEndpoint(endpoint) &&
        isTokenInvalidError(codeStr, msg)
      ) {
        await this._reloginAfterInvalidToken(usedSessionId);
        return await this._requestLegacy(endpoint, payload, {
          ...options,
          _retriedAfterLogin: true,
        });
      }
      throw new MideaCloudError(`美的云端错误 (${codeStr}): ${msg}`, codeStr, {
        isAuthError:
          isPermanentAuthFailureCode(codeStr) ||
          isLockoutOrDeviceLimitCode(codeStr) ||
          isTokenInvalidError(codeStr, msg),
        isCooldownError: isLockoutOrDeviceLimitCode(codeStr),
      });
    }

    if (isRecord(parsed["result"])) {
      return parsed["result"];
    }
    if (isRecord(parsed["data"])) {
      return parsed["data"];
    }
    return parsed;
  }

  private async _ensureLoggedIn(): Promise<void> {
    if (this.isLoggedIn) {
      return;
    }
    if (this._inFlightLogin) {
      await this._inFlightLogin;
      return;
    }
    // 已有会话但已过期时先清理并通知缓存层
    if (this._session) {
      this.clearSession({ notify: true });
    }
    this._checkAutoLoginGate("ensure");
    // 若本次是由先前失效冷却结束后恢复的自动登录，记录时间以便继续触发退避防护
    if (this._consecutiveAutoRelogins > 0) {
      const now = this._nowMs();
      const resetWindowMs = Math.max(this._lockoutCooldownMs, this._reloginCooldownMs * 5);
      if (now - this._lastAutoReloginAt >= resetWindowMs) {
        this._consecutiveAutoRelogins = 0;
      } else {
        this._lastAutoReloginAt = now;
        this._consecutiveAutoRelogins += 1;
      }
    }
    await this._startInFlightLogin();
  }

  private async _executeLogin(): Promise<MideaCloudSession> {
    if (!this._account || !this._password) {
      throw new MideaCloudError("请先填写美的账号与密码", undefined, { isAuthError: true });
    }

    const deviceId = this.security.getDeviceId(this._account);

    try {
      if (this.preset.protocol === "mas") {
        const idData = await this._requestMas(
          "/v1/user/login/id/get",
          { loginAccount: this._account },
          { requireAuth: false },
        );
        const loginId = typeof idData["loginId"] === "string" ? idData["loginId"] : "";
        if (!loginId) {
          throw new MideaCloudError("美的云端登录失败：未获取到 loginId", undefined, {
            isAuthError: true,
          });
        }

        const stamp = formatStamp(new Date(this._nowMs()));
        const iotData: Record<string, unknown> = {
          clientType: 1,
          deviceId,
          iampwd: this.security.encryptIamPassword(loginId, this._password),
          iotAppId: this.preset.appId,
          loginAccount: this._account,
          password: this.security.encryptPassword(loginId, this._password),
          reqId: createReqId(),
          src: this.preset.appId,
          stamp,
        };
        if (this.preset.brand === "msmarthome") {
          iotData["appId"] = this.preset.appId;
        }

        const loginData = await this._requestMas(
          "/mj/user/login",
          {
            data: {
              appKey: this.preset.appKey,
              deviceId,
              platform: 2,
            },
            iotData,
            timestamp: stamp,
            stamp,
          },
          { requireAuth: false },
        );

        const mdata = isRecord(loginData["mdata"]) ? loginData["mdata"] : null;
        const accessToken =
          (mdata && typeof mdata["accessToken"] === "string" && mdata["accessToken"]) ||
          (typeof loginData["accessToken"] === "string" ? loginData["accessToken"] : "");
        if (!accessToken) {
          throw new MideaCloudError("美的云端登录失败：账号或密码错误，未返回访问令牌", undefined, {
            isAuthError: true,
          });
        }

        const uid =
          (typeof loginData["uid"] === "string" && loginData["uid"]) ||
          (mdata && typeof mdata["uid"] === "string" ? mdata["uid"] : "") ||
          this._account;

        const keySeed =
          (typeof loginData["key"] === "string" && loginData["key"]) ||
          (mdata && typeof mdata["key"] === "string" ? mdata["key"] : "") ||
          (this.preset.brand === "msmarthome" &&
          mdata &&
          typeof mdata["accessToken"] === "string" &&
          typeof loginData["accessToken"] === "string"
            ? loginData["accessToken"]
            : "");
        const ivSeed =
          (typeof loginData["iv"] === "string" && loginData["iv"]) ||
          (mdata && typeof mdata["iv"] === "string" ? mdata["iv"] : "") ||
          (this.preset.brand === "msmarthome" && typeof loginData["randomData"] === "string"
            ? loginData["randomData"]
            : "");
        this.security.clearAesKeys();
        if (keySeed) {
          this.security.setAesKeys(keySeed, ivSeed || undefined);
        }

        const now = this._nowMs();
        const aes = this.security.exportAesKeys();
        const expiresAt = extractSessionExpiresAt(loginData, mdata, now);
        this._session = {
          brand: this.preset.brand,
          account: this._account,
          useChinaServer: this._useChinaServer,
          baseUrl: this._baseUrl,
          uid,
          accessToken,
          sessionId: "",
          ...(aes?.keyHex ? { aesKeyHex: aes.keyHex } : {}),
          ...(aes?.ivHex ? { aesIvHex: aes.ivHex } : {}),
          deviceId,
          loggedInAt: now,
          ...(expiresAt !== undefined ? { expiresAt } : {}),
        };
      } else {
        // Legacy (NetHome Plus / Midea Air)
        const idData = await this._requestLegacy(
          "/v1/user/login/id/get",
          { loginAccount: this._account },
          { requireAuth: false },
        );
        const loginId = typeof idData["loginId"] === "string" ? idData["loginId"] : "";
        if (!loginId) {
          throw new MideaCloudError("美的旧版云端登录失败：未获取到 loginId", undefined, {
            isAuthError: true,
          });
        }

        const loginData = await this._requestLegacy(
          "/v1/user/login",
          {
            loginAccount: this._account,
            password: this.security.encryptPassword(loginId, this._password),
            deviceId,
          },
          { requireAuth: false },
        );
        const sessionId =
          typeof loginData["sessionId"] === "string" ? loginData["sessionId"] : "";
        if (!sessionId) {
          throw new MideaCloudError("美的旧版云端登录失败：未返回 sessionId", undefined, {
            isAuthError: true,
          });
        }
        const uid =
          (typeof loginData["userId"] === "string" && loginData["userId"]) ||
          (typeof loginData["uid"] === "string" && loginData["uid"]) ||
          this._account;

        const now = this._nowMs();
        const expiresAt = extractSessionExpiresAt(loginData, null, now);
        this._session = {
          brand: this.preset.brand,
          account: this._account,
          useChinaServer: this._useChinaServer,
          baseUrl: this._baseUrl,
          uid,
          accessToken: "",
          sessionId,
          deviceId,
          loggedInAt: now,
          ...(expiresAt !== undefined ? { expiresAt } : {}),
        };
      }

      this._consecutiveLoginFailures = 0;
      this._autoLoginBlockedUntil = 0;
      this._permanentAuthError = null;
      const exported = this.exportSession()!;
      this._notifySessionChange(exported);
      return exported;
    } catch (err) {
      const codeStr =
        err instanceof MideaCloudError && err.code !== undefined ? String(err.code) : "";
      const now = this._nowMs();

      if (isPermanentAuthFailureCode(codeStr)) {
        const authErr = new MideaCloudError(
          `美的云端认证失败 (${codeStr})：账号或密码不正确，请检查配置后重新保存`,
          codeStr,
          { cause: err, isAuthError: true },
        );
        this._permanentAuthError = authErr;
        throw authErr;
      }

      if (codeStr === "65027") {
        this._autoLoginBlockedUntil = now + this._lockoutCooldownMs;
        throw new MideaCloudError(
          "美的账号在线登录设备已达上限 (65027)，已暂停自动重登 5 分钟；建议退出多余端或改用独立小号共享设备",
          codeStr,
          { cause: err, isAuthError: true, isCooldownError: true },
        );
      }

      if (codeStr === "7610") {
        this._autoLoginBlockedUntil = now + this._lockoutCooldownMs;
        throw new MideaCloudError(
          "美的账号触发登录频率风控 (7610)，已暂停自动重登 5 分钟后恢复",
          codeStr,
          { cause: err, isAuthError: true, isCooldownError: true },
        );
      }

      this._consecutiveLoginFailures += 1;
      if (this._reloginCooldownMs > 0) {
        const step = Math.min(this._consecutiveLoginFailures - 1, 3);
        const backoffMs = Math.min(this._reloginCooldownMs * 2 ** step, this._lockoutCooldownMs);
        this._autoLoginBlockedUntil = now + backoffMs;
      }
      throw err;
    }
  }

  /**
   * 登录美的云端账号（自动适配 Meiju / MSmartHome / NetHomePlus / MideaAir）。
   * 若当前已持有有效未过期会话且未传入 `{ force: true }`，直接复用现有会话，避免无谓重登。
   */
  async login(options?: MideaCloudLoginOptions): Promise<MideaCloudSession> {
    if (!options?.force && this.isLoggedIn) {
      return this.exportSession()!;
    }
    // 显式手动登录时清除自动退避门控，允许用户修复凭据或重试
    this._permanentAuthError = null;
    this._autoLoginBlockedUntil = 0;
    if (options?.force && !this._inFlightLogin) {
      this.clearSession({ notify: false });
    }
    return await this._startInFlightLogin();
  }

  /**
   * 获取美的云端家庭列表（`/v1/homegroup/list/get`）。
   */
  async listHomes(): Promise<MideaCloudHome[]> {
    await this._ensureLoggedIn();
    if (this.preset.protocol === "legacy") {
      return [{ homeId: "default", name: "我的家", isDefault: true }];
    }

    const data = await this._requestMas("/v1/homegroup/list/get", {});
    const rawList = Array.isArray(data["homeList"]) ? data["homeList"] : [];
    const homes: MideaCloudHome[] = [];
    for (const item of rawList) {
      if (!isRecord(item)) continue;
      const homeId = String(item["homegroupId"] ?? item["homeId"] ?? item["id"] ?? "").trim();
      if (!homeId) continue;
      const name = String(item["name"] ?? item["homeName"] ?? "我的家").trim() || "我的家";
      const isDefault = Boolean(item["isDefault"] === "1" || item["isDefault"] === true || item["roleId"] === "1001");
      homes.push({ homeId, name, isDefault });
    }
    return homes;
  }

  private _parseApplianceEntry(
    item: Record<string, unknown>,
    homeId: string,
    homeName: string,
    roomName: string,
  ): MideaCloudAppliance | null {
    const id = String(item["applianceCode"] ?? item["id"] ?? item["applianceId"] ?? "").trim();
    if (!id) {
      return null;
    }
    const type = parseMideaTypeCode(item["type"] ?? item["applianceType"], 0xac);
    const rawSn = typeof item["sn"] === "string" ? item["sn"] : "";
    const sn = rawSn ? this.security.tryDecryptSn(rawSn) : "";
    const sn8 =
      (typeof item["sn8"] === "string" && item["sn8"].trim()) ||
      (sn.length >= 17 ? sn.slice(9, 17) : "");
    const modelNumber = String(item["modelNumber"] ?? item["model"] ?? sn8 ?? "").trim();
    const name = String(item["name"] ?? item["applianceName"] ?? `美的设备 ${id}`).trim();
    const online = parseOnlineFlag(item["onlineStatus"] ?? item["online"]);
    const resolvedRoom =
      String(item["roomName"] ?? roomName ?? "").trim() || "默认房间";

    const manufacturerCode =
      String(item["enterpriseCode"] ?? item["manufacturerCode"] ?? "0000").trim() || "0000";

    return {
      id,
      name,
      type,
      modelNumber,
      sn,
      sn8,
      manufacturerCode,
      online,
      homeId,
      homeName: homeName || "我的家",
      roomName: resolvedRoom,
      protocolVersion: parseProtocolVersion(item),
    };
  }

  /**
   * 获取指定家庭（或全部家庭）下的设备列表，自动解密 `sn` 并填充家庭与房间名称。
   */
  async listAppliances(homeId?: string): Promise<MideaCloudAppliance[]> {
    await this._ensureLoggedIn();

    if (this.preset.protocol === "legacy") {
      const data = await this._requestLegacy("/v1/appliance/user/list/get", {});
      const list = Array.isArray(data["list"]) ? data["list"] : [];
      const appliances: MideaCloudAppliance[] = [];
      for (const raw of list) {
        if (!isRecord(raw)) continue;
        const parsed = this._parseApplianceEntry(raw, "default", "我的家", "默认房间");
        if (parsed) appliances.push(parsed);
      }
      return appliances;
    }

    const targetHomes: MideaCloudHome[] = homeId
      ? [{ homeId, name: "我的家", isDefault: true }]
      : await this.listHomes();

    const queryHomes =
      targetHomes.length > 0 ? targetHomes : [{ homeId: "", name: "我的家", isDefault: true }];
    const appliances = new Map<string, MideaCloudAppliance>();

    for (const home of queryHomes) {
      const payload: Record<string, unknown> = home.homeId ? { homegroupId: home.homeId } : {};
      const data = await this._requestMas("/v1/appliance/home/list/get", payload);

      const homeList = Array.isArray(data["homeList"]) ? data["homeList"] : [];
      for (const h of homeList) {
        if (!isRecord(h)) continue;
        const resolvedHomeId = String(h["homegroupId"] ?? h["id"] ?? home.homeId).trim();
        const resolvedHomeName =
          String(h["name"] ?? h["homeName"] ?? home.name).trim() || "我的家";

        const roomList = Array.isArray(h["roomList"]) ? h["roomList"] : [];
        for (const room of roomList) {
          if (!isRecord(room)) continue;
          const roomName = String(room["name"] ?? room["roomName"] ?? "默认房间").trim() || "默认房间";
          const list = Array.isArray(room["applianceList"]) ? room["applianceList"] : [];
          for (const raw of list) {
            if (!isRecord(raw)) continue;
            const parsed = this._parseApplianceEntry(raw, resolvedHomeId, resolvedHomeName, roomName);
            if (parsed) appliances.set(parsed.id, parsed);
          }
        }

        const directList = Array.isArray(h["applianceList"]) ? h["applianceList"] : [];
        for (const raw of directList) {
          if (!isRecord(raw)) continue;
          const parsed = this._parseApplianceEntry(raw, resolvedHomeId, resolvedHomeName, "默认房间");
          if (parsed && !appliances.has(parsed.id)) appliances.set(parsed.id, parsed);
        }
      }

      const flatList = Array.isArray(data["applianceList"]) ? data["applianceList"] : [];
      for (const raw of flatList) {
        if (!isRecord(raw)) continue;
        const parsed = this._parseApplianceEntry(raw, home.homeId, home.name, "默认房间");
        if (parsed && !appliances.has(parsed.id)) appliances.set(parsed.id, parsed);
      }
    }

    return [...appliances.values()];
  }

  /**
   * 拉取 V3 局域网认证所需的 `token` / `key` 候选列表（`/v1/iot/secure/getToken`）。
   * 自动尝试 UDP ID 方法 1、2、0 及原始 `applianceCode`，并附加 `default_keys[99]` 作为最终回退。
   */
  async getTokens(applianceId: string | bigint): Promise<MideaTokenKeyPair[]> {
    await this._ensureLoggedIn();

    const idStr = String(applianceId).trim();
    const idBigInt = BigInt(idStr);
    const methodOrder: Array<1 | 2 | 0> = [1, 2, 0];
    const udpToMethod = new Map<string, number>();
    const udpIds: string[] = [];

    for (const method of methodOrder) {
      const udpId = MideaCloudSecurity.getUdpId(idBigInt, method);
      if (udpId && !udpToMethod.has(udpId)) {
        udpToMethod.set(udpId, method);
        udpIds.push(udpId);
      }
    }

    const pairs: MideaTokenKeyPair[] = [];
    const seen = new Set<string>();
    const pushPair = (pair: MideaTokenKeyPair): void => {
      const fingerprint = `${pair.token.toLowerCase()}:${pair.key.toLowerCase()}`;
      if (!pair.token || !pair.key || seen.has(fingerprint)) return;
      seen.add(fingerprint);
      pairs.push(pair);
    };

    try {
      const reqPayload = {
        udplist: udpIds,
        applianceCodes: [idStr],
      };
      const data =
        this.preset.protocol === "mas"
          ? await this._requestMas("/v1/iot/secure/getToken", reqPayload)
          : await this._requestLegacy("/v1/iot/secure/getToken", {
              udpid: udpIds[0] ?? "",
              applianceCode: idStr,
            });

      const tokenList = Array.isArray(data["tokenlist"])
        ? data["tokenlist"]
        : Array.isArray(data["tokenList"])
          ? data["tokenList"]
          : [];
      for (const entry of tokenList) {
        if (!isRecord(entry)) continue;
        const token = typeof entry["token"] === "string" ? entry["token"].trim() : "";
        const key = typeof entry["key"] === "string" ? entry["key"].trim() : "";
        const udpId = typeof entry["udpId"] === "string" ? entry["udpId"].trim() : undefined;
        if (token && key) {
          pushPair({
            token,
            key,
            udpId,
            method: udpId ? udpToMethod.get(udpId) : undefined,
          });
        }
      }

      if (typeof data["token"] === "string" && typeof data["key"] === "string") {
        pushPair({ token: data["token"].trim(), key: data["key"].trim() });
      }
    } catch {
      // 云端获取 token 失败时仍提供默认回退密钥对
    }

    pushPair({
      token: MIDEA_DEFAULT_FALLBACK_KEYPAIR.token,
      key: MIDEA_DEFAULT_FALLBACK_KEYPAIR.key,
      isDefaultFallback: true,
    });

    return pairs;
  }

  /**
   * 通过美的云端透传接口下发 0xAA 串口帧（`/v1/appliance/transparent/send`）。
   * - MAS v5（Meiju / MSmartHome）要求传入 `applianceCode`、`timestamp`、`isFull`（而非 `applianceId`），
   *   否则云端会返回 `(1001): Invalid param wrong format: null`。
   * - 旧版协议（NetHome Plus / Midea Air）仍使用 `applianceId` + `funId`。
   */
  async sendTransparentCommand(
    applianceId: string,
    commandBytes: Uint8Array,
    options?: MideaTransparentSendOptions,
  ): Promise<Buffer | null> {
    await this._ensureLoggedIn();

    const applianceCode = String(applianceId).trim();
    const signedOrder = Array.from(commandBytes)
      .map((b) => (b > 127 ? b - 256 : b))
      .join(",");
    const encryptedOrder = this.security.aesEncrypt(signedOrder);

    try {
      let data: Record<string, unknown>;
      if (this.preset.protocol === "mas") {
        const payload: Record<string, unknown> = {
          applianceCode,
          order: encryptedOrder,
          timestamp: "true",
          isFull: "false",
        };
        if (this.preset.brand === "msmarthome") {
          payload["deviceId"] = this.security.getDeviceId(this._account);
        }
        data = await this._requestMas("/v1/appliance/transparent/send", payload);
      } else {
        const payload: Record<string, unknown> = {
          applianceId: applianceCode,
          order: encryptedOrder,
          funId: "0000",
        };
        data = await this._requestLegacy("/v1/appliance/transparent/send", payload);
      }

      return parseReplyToBuffer(data["reply"] ?? data["result"], this.security);
    } catch (err) {
      if (
        options?.allowAsyncReplyMissing &&
        err instanceof MideaCloudError &&
        String(err.code) === "1306"
      ) {
        return null;
      }
      throw err;
    }
  }

  /**
   * 通过美的云端 Lua 接口查询设备结构化实时状态：
   * - Meiju: `/mjl/v1/device/status/lua/get`
   * - MSmartHome: `/v1/device/status/lua/get`
   */
  async getLuaStatus(
    applianceId: string,
    query: Record<string, unknown> = {},
    meta?: MideaLuaApplianceMeta,
  ): Promise<Record<string, unknown>> {
    await this._ensureLoggedIn();
    const applianceCode = String(applianceId).trim();

    if (this.preset.brand === "meiju") {
      const data = await this._requestMas("/mjl/v1/device/status/lua/get", {
        applianceCode,
        command: { query },
      });
      return unwrapLuaResponseData(data, "Lua 状态查询");
    }

    if (this.preset.brand === "msmarthome") {
      const typeHex = `0x${((meta?.deviceType ?? 0xac) & 0xff).toString(16).toUpperCase().padStart(2, "0")}`;
      const encryptedSn = meta?.sn
        ? this.security.aesEncryptWithFixedKey(Buffer.from(meta.sn, "ascii"))
        : "";
      const data = await this._requestMas("/v1/device/status/lua/get", {
        deviceId: this.security.getDeviceId(this._account),
        iotAppId: this.preset.appId,
        applianceMFCode: meta?.manufacturerCode || "0000",
        applianceType: typeHex,
        modelNumber: meta?.modelNumber || "0",
        applianceSn: encryptedSn,
        version: "0",
        "encryptedType ": "2",
        applianceCode,
        command: { query },
      });
      return unwrapLuaResponseData(data, "Lua 状态查询");
    }

    throw new MideaCloudError("当前美的云端品牌协议不支持 Lua 状态查询");
  }

  /**
   * 通过美的云端 Lua 接口下发结构化控制指令：
   * - Meiju: `/mjl/v1/device/lua/control`
   * - MSmartHome: `/v1/device/lua/control`
   */
  async sendLuaControl(
    applianceId: string,
    control: Record<string, unknown>,
    options?: { status?: Record<string, unknown>; meta?: MideaLuaApplianceMeta },
  ): Promise<Record<string, unknown>> {
    await this._ensureLoggedIn();
    const applianceCode = String(applianceId).trim();
    const command: Record<string, unknown> = { control };
    if (options?.status && Object.keys(options.status).length > 0) {
      command["status"] = options.status;
    }

    if (this.preset.brand === "meiju") {
      const data = await this._requestMas("/mjl/v1/device/lua/control", {
        applianceCode,
        command,
      });
      return unwrapLuaResponseData(data, "Lua 控制");
    }

    if (this.preset.brand === "msmarthome") {
      const meta = options?.meta;
      const typeHex = `0x${((meta?.deviceType ?? 0xac) & 0xff).toString(16).toUpperCase().padStart(2, "0")}`;
      const encryptedSn = meta?.sn
        ? this.security.aesEncryptWithFixedKey(Buffer.from(meta.sn, "ascii"))
        : "";
      const data = await this._requestMas("/v1/device/lua/control", {
        deviceId: this.security.getDeviceId(this._account),
        iotAppId: this.preset.appId,
        applianceMFCode: meta?.manufacturerCode || "0000",
        applianceType: typeHex,
        modelNumber: meta?.modelNumber || "0",
        applianceSn: encryptedSn,
        version: "0",
        "encryptedType ": "2",
        applianceCode,
        command,
      });
      return unwrapLuaResponseData(data, "Lua 控制");
    }

    throw new MideaCloudError("当前美的云端品牌协议不支持 Lua 控制");
  }
}
