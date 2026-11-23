// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * Pure Bun + TypeScript Xiaomi MIoT Cloud API v2 client
 * (compatible with mijiaAPI 5.x semantics and auth.json format).
 */

import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { QrLoginData } from "../core/contracts.ts";
import {
  boundedFetch,
  createBoundedFetch,
  isBoundedFetch,
  type BoundedFetch,
  type FetchLike,
  type TimeoutFetchOptions,
} from "../core/httpTimeout.ts";
import { decrypt, generateEncParams, genNonce, getSignedNonce } from "./crypto.ts";
import type { MijiaDeviceApi } from "./device.ts";
import { LoginError, MijiaApiError } from "./errors.ts";

export const MIJIA_API_VERSION = "5.0.0-ts";
export const DEFAULT_API_BASE_URL = "https://api.io.mi.com/app";

const XIAOMI_SERVICE_LOGIN_URL = "https://account.xiaomi.com/pass/serviceLogin";
const XIAOMI_QR_LOGIN_URL = "https://account.xiaomi.com/longPolling/loginUrl";
const XIAOMI_STS_CALLBACK = "https://sts.api.io.mi.com/sts";
const XIAOMI_JSON_PREFIX = "&&&START&&&";
const QR_LONG_POLL_TIMEOUT_MS = 120_000;
const ICON_REDIRECT_TIMEOUT_MS = 6_000;
const DEFAULT_LOCALE = "zh_CN";
const MAX_PAGINATION_PAGES = 50;
const MAX_STS_REDIRECTS = 5;

export interface AuthData {
  userId?: string | number;
  cUserId?: string;
  ssecurity?: string;
  serviceToken?: string;
  passToken?: string;
  deviceId?: string;
  ua?: string;
  saveTime?: number;
  expireTime?: number;
  [key: string]: unknown;
}

export interface MijiaApiClientOptions {
  authDataPath?: string;
  apiBaseUrl?: string;
  fetcher?: FetchLike;
}

export interface PostEncryptedOptions {
  timeoutMs?: number;
  rawResponse?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function generateDeviceId(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = randomBytes(16);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += alphabet[bytes[i]! % alphabet.length];
  }
  return out;
}

function defaultUserAgent(deviceId: string): string {
  return `Android-7.1.1-1.0.0-ONEPLUS A3010-136-${deviceId} APP/xiaomi.smarthome APPV/62830`;
}

function parseXiaomiJson(rawText: string): Record<string, unknown> {
  const trimmed = rawText.trim();
  const body = trimmed.startsWith(XIAOMI_JSON_PREFIX)
    ? trimmed.slice(XIAOMI_JSON_PREFIX.length)
    : trimmed;
  const parsed: unknown = JSON.parse(body);
  if (!isRecord(parsed)) {
    throw new LoginError("Unexpected non-object response from Xiaomi Account API");
  }
  return parsed;
}

function getSetCookieHeaders(headers: Headers): string[] {
  const maybeGetSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  if (typeof maybeGetSetCookie === "function") {
    const list = maybeGetSetCookie.call(headers);
    if (Array.isArray(list) && list.length > 0) {
      return list;
    }
  }
  const combined = headers.get("set-cookie");
  if (!combined) {
    return [];
  }
  // Split combined Set-Cookie header without splitting on comma inside Expires dates.
  return combined.split(/,(?=\s*[A-Za-z0-9_.-]+=)/);
}

function collectCookiesFromHeaders(headers: Headers, target: Record<string, string>): void {
  for (const rawCookie of getSetCookieHeaders(headers)) {
    const firstPart = rawCookie.split(";")[0]?.trim() ?? "";
    const eqIdx = firstPart.indexOf("=");
    if (eqIdx <= 0) {
      continue;
    }
    const name = firstPart.slice(0, eqIdx).trim();
    const value = firstPart.slice(eqIdx + 1).trim();
    if (name && value && value.toLowerCase() !== "existed") {
      target[name] = value;
    }
  }
}

function computeClientSign(nonce: unknown, ssecurity: string): string {
  return createHash("sha1")
    .update(`nonce=${String(nonce)}&${ssecurity}`, "utf8")
    .digest("base64");
}

function toNumericId(value: unknown): number | string {
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return value;
  }
  const str = String(value ?? "").trim();
  if (/^\d+$/.test(str)) {
    const num = Number(str);
    if (Number.isSafeInteger(num)) {
      return num;
    }
  }
  return str;
}

function writeAtomicJson(targetPath: string, data: Record<string, unknown>): void {
  const parent = dirname(targetPath);
  mkdirSync(parent, { recursive: true });
  const tmpPath = `${targetPath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf8");
    try {
      chmodSync(tmpPath, 0o600);
    } catch {
      // Best-effort POSIX permission restriction (no-op / ignored on Windows).
    }
    renameSync(tmpPath, targetPath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // ignore cleanup error
    }
    throw err;
  }
}

export class MijiaApiClient implements MijiaDeviceApi {
  authData: Record<string, unknown>;
  authDataPath: string;
  apiBaseUrl: string;

  private readonly fetcher: BoundedFetch;
  private closed = false;

  constructor(options?: MijiaApiClientOptions) {
    this.authDataPath =
      options?.authDataPath ?? join(homedir(), ".config", "mijia-api", "auth.json");
    this.apiBaseUrl = (options?.apiBaseUrl ?? DEFAULT_API_BASE_URL).replace(/\/+$/, "");
    this.fetcher = options?.fetcher
      ? isBoundedFetch(options.fetcher)
        ? options.fetcher
        : createBoundedFetch(options.fetcher)
      : boundedFetch;

    this.authData = {};
    if (existsSync(this.authDataPath)) {
      // Synchronous read; intentionally lets JSON SyntaxError / TypeError / FS errors
      // propagate so MijiaService._initApi can quarantine corrupt auth.json files.
      const rawText = readFileSync(this.authDataPath, "utf8");
      const parsed: unknown = JSON.parse(rawText);
      if (!isRecord(parsed)) {
        throw new TypeError(`Invalid auth.json format at ${this.authDataPath}: expected object`);
      }
      this.authData = parsed;
    }
  }

  get available(): boolean {
    if (this.closed) {
      return false;
    }
    const userId = this.authData["userId"];
    const ssecurity = this.authData["ssecurity"];
    const serviceToken = this.authData["serviceToken"];
    const hasUserId =
      (typeof userId === "string" && userId.trim().length > 0) ||
      (typeof userId === "number" && Number.isFinite(userId) && userId > 0);
    if (
      !hasUserId ||
      typeof ssecurity !== "string" ||
      !ssecurity.trim() ||
      typeof serviceToken !== "string" ||
      !serviceToken.trim()
    ) {
      return false;
    }
    const expireTime = this.authData["expireTime"];
    if (typeof expireTime === "number" && Number.isFinite(expireTime) && expireTime > 0) {
      const expireMs = expireTime < 1e12 ? expireTime * 1000 : expireTime;
      if (Date.now() >= expireMs) {
        return false;
      }
    }
    return true;
  }

  close(): void {
    this.closed = true;
  }

  private ensureDeviceMeta(): { deviceId: string; ua: string } {
    let deviceId =
      typeof this.authData["deviceId"] === "string" && this.authData["deviceId"].trim()
        ? this.authData["deviceId"].trim()
        : "";
    if (!deviceId) {
      deviceId = generateDeviceId();
    }
    let ua =
      typeof this.authData["ua"] === "string" && this.authData["ua"].trim()
        ? this.authData["ua"].trim()
        : "";
    if (!ua) {
      ua = defaultUserAgent(deviceId);
    }
    return { deviceId, ua };
  }

  private buildMiotHeaders(ssecurity?: string): Record<string, string> {
    const { ua } = this.ensureDeviceMeta();
    const userId = String(this.authData["userId"] ?? "");
    const cUserId = String(this.authData["cUserId"] ?? "");
    const serviceToken = String(this.authData["serviceToken"] ?? "");

    const cookies: string[] = [
      `userId=${userId}`,
      `yetAnotherServiceToken=${serviceToken}`,
      `serviceToken=${serviceToken}`,
      `locale=${DEFAULT_LOCALE}`,
      "timezone=GMT+08:00",
      "is_daylight=0",
      "dst_offset=0",
      "channel=MI_APP_STORE",
    ];
    if (cUserId) {
      cookies.push(`cUserId=${cUserId}`);
    }

    const headers: Record<string, string> = {
      "User-Agent": ua,
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept-Encoding": "identity",
      "x-xiaomi-protocal-flag-cli": "PROTOCAL-HTTP2",
      "MIOT-ENCRYPT-ALGORITHM": "ENCRYPT-RC4",
      Cookie: cookies.join("; "),
    };
    if (ssecurity !== undefined) {
      // Keep ssecurity out of headers; passed inside signed form params.
    }
    return headers;
  }

  private request(url: string, init?: TimeoutFetchOptions): Promise<Response> {
    if (this.closed) {
      return Promise.reject(new LoginError("MijiaApiClient has been closed"));
    }
    return this.fetcher(url, init);
  }

  private async exchangeLocationForTokens(
    location: string,
    ssecurity: string,
    nonce: unknown,
    ua: string,
    initialCookies?: Record<string, string>,
  ): Promise<Record<string, string>> {
    let targetUrl = location;
    if (nonce !== undefined && nonce !== null && !location.includes("clientSign=")) {
      const clientSign = computeClientSign(nonce, ssecurity);
      const sep = location.includes("?") ? "&" : "?";
      targetUrl = `${location}${sep}clientSign=${encodeURIComponent(clientSign)}`;
    }

    const cookies: Record<string, string> = { ...(initialCookies ?? {}) };
    let currentUrl = targetUrl;

    for (let hop = 0; hop < MAX_STS_REDIRECTS; hop++) {
      const res = await this.request(currentUrl, {
        method: "GET",
        headers: { "User-Agent": ua },
        redirect: "manual",
      });
      collectCookiesFromHeaders(res.headers, cookies);

      if (res.status >= 300 && res.status < 400) {
        const nextLocation = res.headers.get("location");
        if (nextLocation && !cookies["serviceToken"]) {
          currentUrl = new URL(nextLocation, currentUrl).toString();
          continue;
        }
        break;
      }

      if (!res.ok) {
        throw new LoginError(
          `Failed to exchange Xiaomi STS location: HTTP ${res.status}`,
          res.status,
        );
      }
      break;
    }

    if (!cookies["serviceToken"]) {
      throw new LoginError("Failed to obtain serviceToken from Xiaomi STS response");
    }
    return cookies;
  }

  private saveAuthData(): void {
    writeAtomicJson(this.authDataPath, this.authData);
  }

  async refreshToken(): Promise<boolean> {
    if (this.closed) {
      return false;
    }
    const passToken =
      typeof this.authData["passToken"] === "string" ? this.authData["passToken"].trim() : "";
    const userId = String(this.authData["userId"] ?? "").trim();
    if (!passToken || !userId) {
      return false;
    }

    const { deviceId, ua } = this.ensureDeviceMeta();
    const cUserId =
      typeof this.authData["cUserId"] === "string" ? this.authData["cUserId"].trim() : "";

    const reqCookies = [`passToken=${passToken}`, `userId=${userId}`, `deviceId=${deviceId}`];
    if (cUserId) {
      reqCookies.push(`cUserId=${cUserId}`);
    }

    try {
      const res = await this.request(`${XIAOMI_SERVICE_LOGIN_URL}?sid=xiaomiio&_json=true`, {
        method: "GET",
        headers: {
          "User-Agent": ua,
          Cookie: reqCookies.join("; "),
        },
      });
      if (!res.ok) {
        return false;
      }

      const initialCookies: Record<string, string> = {};
      collectCookiesFromHeaders(res.headers, initialCookies);

      const data = parseXiaomiJson(await res.text());
      const code = data["code"];
      const ssecurity = typeof data["ssecurity"] === "string" ? data["ssecurity"].trim() : "";
      const location = typeof data["location"] === "string" ? data["location"].trim() : "";
      if (code !== 0 || !ssecurity || !location) {
        return false;
      }

      const stsCookies = await this.exchangeLocationForTokens(
        location,
        ssecurity,
        data["nonce"],
        ua,
        initialCookies,
      );

      this.authData = {
        ...this.authData,
        userId: data["userId"] ?? stsCookies["userId"] ?? userId,
        cUserId:
          (typeof data["cUserId"] === "string" && data["cUserId"]) ||
          stsCookies["cUserId"] ||
          cUserId,
        ssecurity,
        serviceToken: stsCookies["serviceToken"],
        passToken:
          (typeof data["passToken"] === "string" && data["passToken"]) ||
          stsCookies["passToken"] ||
          passToken,
        deviceId,
        ua,
        saveTime: Date.now(),
      };
      delete this.authData["expireTime"];
      this.saveAuthData();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Step 1 of two-step QR login.
   * Attempts silent token refresh first; returns `{ refreshed: true, ... }` when refreshed,
   * otherwise requests a Xiaomi Account `longPolling/loginUrl` QR session.
   */
  async getQrLoginData(): Promise<QrLoginData> {
    if (await this.refreshToken()) {
      return { loginUrl: "", lp: "", refreshed: true };
    }

    const { deviceId, ua } = this.ensureDeviceMeta();
    const params = new URLSearchParams({
      _group: "DEFAULT",
      _qrsize: "240",
      qs: "%3Fsid%3Dxiaomiio%26_json%3Dtrue",
      bizDeviceType: "",
      callback: XIAOMI_STS_CALLBACK,
      _hasLogo: "false",
      theme: "",
      sid: "xiaomiio",
      needTheme: "false",
      showActiveX: "false",
      serviceParam: JSON.stringify({
        checkSafePhone: false,
        checkSafeAddress: false,
        lsrp_score: 0.0,
      }),
      _locale: DEFAULT_LOCALE,
      _sign: "",
      _dc: String(Date.now()),
    });

    const res = await this.request(`${XIAOMI_QR_LOGIN_URL}?${params.toString()}`, {
      method: "GET",
      headers: {
        "User-Agent": ua,
        Cookie: `deviceId=${deviceId}`,
      },
    });

    if (!res.ok) {
      throw new LoginError(
        `Failed to fetch QR login data: HTTP ${res.status}`,
        res.status,
      );
    }

    const data = parseXiaomiJson(await res.text());
    const code = data["code"];
    if (typeof code === "number" && code !== 0) {
      throw new LoginError(
        `Failed to fetch QR login data: ${String(data["desc"] ?? data["description"] ?? "unknown error")} (code ${code})`,
        code,
      );
    }

    const loginUrl = typeof data["loginUrl"] === "string" ? data["loginUrl"].trim() : "";
    const lp = typeof data["lp"] === "string" ? data["lp"].trim() : "";
    if (!loginUrl || !lp) {
      throw new LoginError("Xiaomi QR login response missing loginUrl or lp");
    }

    return {
      ...data,
      loginUrl,
      lp,
      ...(typeof data["qr"] === "string" ? { qr: data["qr"] } : {}),
    };
  }

  /**
   * Step 2 of two-step QR login.
   * Long-polls `loginData.lp` with an explicit 120-second timeout, exchanges the
   * returned STS location for `serviceToken` + `ssecurity`, and persists `auth.json`.
   */
  async completeQrLogin(loginData: QrLoginData): Promise<void> {
    const lp = typeof loginData?.lp === "string" ? loginData.lp.trim() : "";
    if (!lp) {
      throw new LoginError("Missing long-poll URL (lp) in QR login data");
    }

    const { deviceId, ua } = this.ensureDeviceMeta();
    const lpRes = await this.request(lp, {
      method: "GET",
      headers: {
        "User-Agent": ua,
        Cookie: `deviceId=${deviceId}`,
      },
      timeoutMs: QR_LONG_POLL_TIMEOUT_MS,
    });

    if (!lpRes.ok) {
      throw new LoginError(
        `QR login long-poll failed: HTTP ${lpRes.status}`,
        lpRes.status,
      );
    }

    const initialCookies: Record<string, string> = {};
    collectCookiesFromHeaders(lpRes.headers, initialCookies);

    const lpData = parseXiaomiJson(await lpRes.text());
    const code = lpData["code"];
    if (typeof code === "number" && code !== 0) {
      throw new LoginError(
        `QR login failed: ${String(lpData["desc"] ?? lpData["description"] ?? "unknown error")} (code ${code})`,
        code,
      );
    }

    const ssecurity =
      typeof lpData["ssecurity"] === "string" ? lpData["ssecurity"].trim() : "";
    const location =
      typeof lpData["location"] === "string" ? lpData["location"].trim() : "";
    if (!ssecurity || !location) {
      throw new LoginError("QR login response missing ssecurity or location");
    }

    const stsCookies = await this.exchangeLocationForTokens(
      location,
      ssecurity,
      lpData["nonce"],
      ua,
      initialCookies,
    );

    const userId = lpData["userId"] ?? stsCookies["userId"] ?? "";
    const cUserId =
      (typeof lpData["cUserId"] === "string" && lpData["cUserId"]) ||
      stsCookies["cUserId"] ||
      "";
    const passToken =
      (typeof lpData["passToken"] === "string" && lpData["passToken"]) ||
      stsCookies["passToken"] ||
      "";

    this.authData = {
      ...this.authData,
      userId,
      cUserId,
      ssecurity,
      serviceToken: stsCookies["serviceToken"],
      ...(passToken ? { passToken } : {}),
      deviceId,
      ua,
      saveTime: Date.now(),
    };
    delete this.authData["expireTime"];
    this.saveAuthData();
  }

  /**
   * Perform an RC4-drop1024 encrypted POST to the Xiaomi MIoT Cloud API v2.
   *
   * When `rawResponse` is false/omitted, validates `payload.code === 0` and returns
   * the parsed JSON response envelope. When `rawResponse` is true, returns the
   * decrypted parsed response envelope without throwing on non-zero MIoT `code`.
   */
  async postEncrypted(
    uri: string,
    data: Record<string, unknown>,
    options?: PostEncryptedOptions,
  ): Promise<unknown> {
    return this.postEncryptedInternal(uri, data, options, true);
  }

  private async postEncryptedInternal(
    uri: string,
    data: Record<string, unknown>,
    options: PostEncryptedOptions | undefined,
    allowRetryOn401: boolean,
  ): Promise<unknown> {
    const ssecurity =
      typeof this.authData["ssecurity"] === "string" ? this.authData["ssecurity"] : "";
    const serviceToken =
      typeof this.authData["serviceToken"] === "string" ? this.authData["serviceToken"] : "";
    const userId = this.authData["userId"];

    if (!ssecurity || !serviceToken || !userId) {
      throw new LoginError("Not logged in: missing MIoT credentials");
    }

    const nonce = genNonce();
    const signedNonce = getSignedNonce(ssecurity, nonce);
    const encParams = generateEncParams(
      uri,
      "POST",
      signedNonce,
      nonce,
      { data: JSON.stringify(data) },
      ssecurity,
    );

    const body = new URLSearchParams(encParams).toString();
    const reqInit: TimeoutFetchOptions = {
      method: "POST",
      headers: this.buildMiotHeaders(ssecurity),
      body,
      ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    };

    const res = await this.request(`${this.apiBaseUrl}${uri}`, reqInit);

    if (res.status === 401 && allowRetryOn401 && !options?.rawResponse) {
      if (await this.refreshToken()) {
        return this.postEncryptedInternal(uri, data, options, false);
      }
    }

    if (!res.ok) {
      throw new MijiaApiError(`MIoT API HTTP ${res.status} on ${uri}`, res.status);
    }

    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      const decrypted = decrypt(ssecurity, nonce, text);
      try {
        parsed = JSON.parse(decrypted);
      } catch (err) {
        if (options?.rawResponse) {
          return decrypted;
        }
        throw new MijiaApiError(
          `Failed to parse decrypted MIoT response from ${uri}`,
          undefined,
          { cause: err },
        );
      }
    }

    if (options?.rawResponse) {
      return parsed;
    }

    if (isRecord(parsed) && typeof parsed["code"] === "number" && parsed["code"] !== 0) {
      throw new MijiaApiError(
        `MIoT API error on ${uri}: ${String(parsed["message"] ?? "unknown error")} (code ${parsed["code"]})`,
        parsed["code"],
      );
    }

    return parsed;
  }

  async getHomesList(): Promise<Array<Record<string, unknown>>> {
    const res = await this.postEncrypted("/v2/homeroom/gethome", {
      fg: true,
      fetch_share: true,
      fetch_share_dev: true,
      limit: 300,
      app_ver: 7,
    });

    if (!isRecord(res) || !isRecord(res["result"])) {
      return [];
    }
    const result = res["result"];
    const homes: Array<Record<string, unknown>> = [];
    const seen = new Set<string>();

    for (const key of ["homelist", "share_home_list"] as const) {
      const list = result[key];
      if (!Array.isArray(list)) {
        continue;
      }
      for (const item of list) {
        if (!isRecord(item)) {
          continue;
        }
        const idKey = String(item["id"] ?? "");
        if (idKey && seen.has(idKey)) {
          continue;
        }
        if (idKey) {
          seen.add(idKey);
        }
        homes.push(item);
      }
    }
    return homes;
  }

  async getDevicesList(): Promise<Array<Record<string, unknown>>> {
    const homes = await this.getHomesList();
    const devices: Array<Record<string, unknown>> = [];
    const seen = new Set<string>();

    for (const home of homes) {
      const homeId = home["id"];
      const homeOwner = home["uid"] ?? this.authData["userId"];
      if (homeId === undefined || homeId === null || homeId === "") {
        continue;
      }

      let startDid = "";
      for (let page = 0; page < MAX_PAGINATION_PAGES; page++) {
        const res = await this.postEncrypted("/v2/home/home_device_list", {
          home_owner: toNumericId(homeOwner),
          home_id: toNumericId(homeId),
          limit: 200,
          start_did: startDid,
          get_split_device: true,
          support_smart_home: true,
          get_cariot_device: true,
          get_third_device: true,
        });

        if (!isRecord(res) || !isRecord(res["result"])) {
          break;
        }
        const result = res["result"];
        const list = Array.isArray(result["device_info"])
          ? result["device_info"]
          : Array.isArray(result["list"])
            ? result["list"]
            : [];

        for (const item of list) {
          if (!isRecord(item)) {
            continue;
          }
          const did = String(item["did"] ?? "");
          if (!did || seen.has(did)) {
            continue;
          }
          seen.add(did);
          devices.push(item);
        }

        const hasMore = Boolean(result["has_more"]);
        const nextStart =
          typeof result["next_start_did"] === "string" ? result["next_start_did"] : "";
        if (!hasMore || !nextStart || nextStart === startDid) {
          break;
        }
        startDid = nextStart;
      }
    }

    return devices;
  }

  async getSharedDevicesList(): Promise<Array<Record<string, unknown>>> {
    const res = await this.postEncrypted("/v2/share/receive_share_dev_list", {
      share_type: 1,
      limit: 200,
    });

    if (!isRecord(res) || !isRecord(res["result"])) {
      return [];
    }
    const result = res["result"];
    const rawList = Array.isArray(result["share_dev_list"])
      ? result["share_dev_list"]
      : Array.isArray(result["device_info"])
        ? result["device_info"]
        : Array.isArray(result["list"])
          ? result["list"]
          : [];

    const devices: Array<Record<string, unknown>> = [];
    for (const item of rawList) {
      if (isRecord(item)) {
        devices.push(item);
      }
    }
    return devices;
  }

  async getDevicesProp(
    queries: Record<string, unknown> | Array<Record<string, unknown>>,
  ): Promise<unknown> {
    const isSingle = !Array.isArray(queries);
    const items = isSingle ? [queries] : queries;
    if (items.length === 0) {
      return [];
    }

    const res = await this.postEncrypted("/miotspec/prop/get", { params: items });
    const result = isRecord(res) ? res["result"] : undefined;
    if (isSingle) {
      return Array.isArray(result) ? result[0] : result;
    }
    return Array.isArray(result) ? result : [];
  }

  async setDevicesProp(
    queries: Record<string, unknown> | Array<Record<string, unknown>>,
  ): Promise<unknown> {
    const isSingle = !Array.isArray(queries);
    const items = isSingle ? [queries] : queries;
    if (items.length === 0) {
      return [];
    }

    const res = await this.postEncrypted("/miotspec/prop/set", { params: items });
    const result = isRecord(res) ? res["result"] : undefined;
    if (isSingle) {
      return Array.isArray(result) ? result[0] : result;
    }
    return Array.isArray(result) ? result : [];
  }

  async runAction(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await this.postEncrypted("/miotspec/action", { params: payload });
    if (isRecord(res) && isRecord(res["result"])) {
      return res["result"];
    }
    return isRecord(res) ? res : {};
  }

  async getScenesList(homeId?: string | null): Promise<Array<Record<string, unknown>>> {
    const fetchForHome = async (hid: string): Promise<Array<Record<string, unknown>>> => {
      const res = await this.postEncrypted(
        "/appgateway/miot/appsceneservice/AppSceneService/GetSceneList",
        { home_id: hid },
      );
      if (!isRecord(res) || !isRecord(res["result"])) {
        return [];
      }
      const result = res["result"];
      const list = Array.isArray(result["scene_info_list"])
        ? result["scene_info_list"]
        : Array.isArray(result["list"])
          ? result["list"]
          : [];
      const scenes: Array<Record<string, unknown>> = [];
      for (const item of list) {
        if (!isRecord(item)) {
          continue;
        }
        scenes.push(item["home_id"] ? item : { ...item, home_id: hid });
      }
      return scenes;
    };

    if (homeId !== undefined && homeId !== null && homeId !== "") {
      return fetchForHome(String(homeId));
    }

    const homes = await this.getHomesList();
    const allScenes: Array<Record<string, unknown>> = [];
    for (const home of homes) {
      const hid = String(home["id"] ?? "");
      if (!hid) {
        continue;
      }
      const scenes = await fetchForHome(hid);
      allScenes.push(...scenes);
    }
    return allScenes;
  }

  async runScene(sceneId: string, homeId: string): Promise<boolean> {
    const payload: Record<string, unknown> = {
      scene_id: String(sceneId),
      trigger_key: "user.click",
    };
    if (homeId) {
      payload["home_id"] = String(homeId);
    }
    const res = await this.postEncrypted(
      "/appgateway/miot/appsceneservice/AppSceneService/RunScene",
      payload,
    );
    if (!isRecord(res)) {
      return false;
    }
    return Boolean(res["result"]);
  }

  /**
   * POST `/v2/productconfig/get_icon` with `redirect: "manual"`,
   * returning the `Location` header on HTTP 302 (or `null` otherwise).
   */
  async fetchIconRedirect(model: string): Promise<string | null> {
    if (this.closed || !model) {
      return null;
    }
    if (!this.available) {
      await this.refreshToken();
    }

    const ssecurity =
      typeof this.authData["ssecurity"] === "string" ? this.authData["ssecurity"] : "";
    const serviceToken =
      typeof this.authData["serviceToken"] === "string" ? this.authData["serviceToken"] : "";
    const userId = this.authData["userId"];
    if (!ssecurity || !serviceToken || !userId) {
      return null;
    }

    const uri = "/v2/productconfig/get_icon";
    const nonce = genNonce();
    const signedNonce = getSignedNonce(ssecurity, nonce);
    const encParams = generateEncParams(
      uri,
      "POST",
      signedNonce,
      nonce,
      { data: JSON.stringify({ icon_name: "icon_real", model }) },
      ssecurity,
    );

    const res = await this.request(`${this.apiBaseUrl}${uri}`, {
      method: "POST",
      headers: this.buildMiotHeaders(ssecurity),
      body: new URLSearchParams(encParams).toString(),
      redirect: "manual",
      timeoutMs: ICON_REDIRECT_TIMEOUT_MS,
    });

    if (res.status !== 302) {
      return null;
    }
    return res.headers.get("location") ?? null;
  }
}
