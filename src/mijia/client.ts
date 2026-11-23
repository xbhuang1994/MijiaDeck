// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * Pure Bun + TypeScript Xiaomi MIoT Cloud API v2 client
 * (protocol-compatible with Do1e/mijia-api 5.x and ~/.config/mijia-api/auth.json).
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
export const DEFAULT_API_BASE_URL = "https://api.mijia.tech/app";

const XIAOMI_SERVICE_LOGIN_URL = "https://account.xiaomi.com/pass/serviceLogin";
const XIAOMI_QR_LOGIN_URL = "https://account.xiaomi.com/longPolling/loginUrl";
const XIAOMI_JSON_PREFIX = "&&&START&&&";
const QR_LONG_POLL_TIMEOUT_MS = 120_000;
const ICON_REDIRECT_TIMEOUT_MS = 6_000;
const DEFAULT_LOCALE = "zh_CN";
const AUTH_EXPIRE_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_PAGINATION_PAGES = 50;
const MAX_STS_REDIRECTS = 10;

export interface AuthData {
  userId?: string | number;
  cUserId?: string;
  ssecurity?: string;
  psecurity?: string;
  nonce?: string | number;
  serviceToken?: string;
  passToken?: string;
  deviceId?: string;
  pass_o?: string;
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

function randomFromAlphabet(alphabet: string, length: number): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += alphabet[bytes[i]! % alphabet.length];
  }
  return out;
}

function generateDeviceId(): string {
  return randomFromAlphabet(
    "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_-",
    16,
  );
}

function generatePassO(): string {
  return randomFromAlphabet("0123456789abcdef", 16);
}

function defaultUserAgent(passO: string, locale = DEFAULT_LOCALE): string {
  const hexUpper = "0123456789ABCDEF";
  const uaId1 = randomFromAlphabet(hexUpper, 40);
  const uaId2 = randomFromAlphabet(hexUpper, 32);
  const uaId3 = randomFromAlphabet(hexUpper, 32);
  const uaId4 = randomFromAlphabet(hexUpper, 40);
  const country = locale.split("_")[1] || "CN";
  return (
    `Android-15-11.0.701-Xiaomi-23046RP50C-OS2.0.212.0.VMYCNXM-` +
    `${uaId1}-${country}-${uaId3}-${uaId2}-SmartHome-MI_APP_STORE-` +
    `${uaId1}|${uaId4}|${passO}-64`
  );
}

function formatTimezoneOffset(): string {
  const offsetMin = -new Date().getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `GMT${sign}${hh}:${mm}`;
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
  // Split combined Set-Cookie header without splitting on commas inside Expires dates.
  return combined.split(/,(?=\s*[A-Za-z0-9_.-]+=)/);
}

interface CookieJarEntry {
  name: string;
  value: string;
  domain: string;
  hostOnly: boolean;
}

function isClearingCookie(rawCookie: string, value: string): boolean {
  const lowerVal = value.toLowerCase();
  if (!value || lowerVal === "existed" || lowerVal === "deleted" || lowerVal === "expired") {
    return true;
  }
  const attrs = rawCookie.split(";").slice(1);
  for (const attr of attrs) {
    const eqIdx = attr.indexOf("=");
    if (eqIdx <= 0) {
      continue;
    }
    const k = attr.slice(0, eqIdx).trim().toLowerCase();
    const v = attr.slice(eqIdx + 1).trim();
    if (k === "max-age" && v !== "" && Number(v) <= 0) {
      return true;
    }
    if (k === "expires" && v !== "") {
      const ts = Date.parse(v);
      if (Number.isFinite(ts) && ts <= Date.now()) {
        return true;
      }
    }
  }
  return false;
}

function extractCookieDomain(rawCookie: string, requestUrl: string): { domain: string; hostOnly: boolean } {
  let defaultHost = "";
  try {
    defaultHost = new URL(requestUrl).hostname.toLowerCase();
  } catch {
    defaultHost = "";
  }
  const attrs = rawCookie.split(";").slice(1);
  for (const attr of attrs) {
    const eqIdx = attr.indexOf("=");
    if (eqIdx <= 0) {
      continue;
    }
    const k = attr.slice(0, eqIdx).trim().toLowerCase();
    if (k === "domain") {
      const rawDomain = attr.slice(eqIdx + 1).trim().toLowerCase().replace(/^\.+/, "");
      if (rawDomain) {
        return { domain: rawDomain, hostOnly: false };
      }
    }
  }
  return { domain: defaultHost, hostOnly: true };
}

function cookieMatchesHost(entry: CookieJarEntry, hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (!entry.domain || !host) {
    return true;
  }
  if (entry.hostOnly) {
    return host === entry.domain;
  }
  return host === entry.domain || host.endsWith(`.${entry.domain}`);
}

function collectCookiesIntoJar(
  headers: Headers,
  requestUrl: string,
  jar: CookieJarEntry[],
): void {
  for (const rawCookie of getSetCookieHeaders(headers)) {
    const firstPart = rawCookie.split(";")[0]?.trim() ?? "";
    const eqIdx = firstPart.indexOf("=");
    if (eqIdx <= 0) {
      continue;
    }
    const name = firstPart.slice(0, eqIdx).trim();
    let value = firstPart.slice(eqIdx + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    if (!name || isClearingCookie(rawCookie, value)) {
      continue;
    }
    const { domain, hostOnly } = extractCookieDomain(rawCookie, requestUrl);
    const existingIdx = jar.findIndex(
      (c) => c.name === name && c.domain === domain && c.hostOnly === hostOnly,
    );
    const entry: CookieJarEntry = { name, value, domain, hostOnly };
    if (existingIdx >= 0) {
      jar.splice(existingIdx, 1);
    }
    jar.push(entry);
  }
}

function formatCookieHeaderForUrl(jar: readonly CookieJarEntry[], targetUrl: string): string {
  let host = "";
  try {
    host = new URL(targetUrl).hostname.toLowerCase();
  } catch {
    host = "";
  }
  const byName = new Map<string, string>();
  for (const entry of jar) {
    if (entry.value !== "" && cookieMatchesHost(entry, host)) {
      byName.set(entry.name, entry.value);
    }
  }
  return Array.from(byName.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

function flattenCookieJar(jar: readonly CookieJarEntry[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of jar) {
    if (entry.value !== "") {
      out[entry.name] = entry.value;
    }
  }
  return out;
}

function extractServiceToken(cookies: Record<string, string>): string {
  if (cookies["serviceToken"]) {
    return cookies["serviceToken"];
  }
  if (cookies["yetAnotherServiceToken"]) {
    return cookies["yetAnotherServiceToken"];
  }
  for (const [k, v] of Object.entries(cookies)) {
    if (v && k.toLowerCase() === "servicetoken") {
      return v;
    }
  }
  for (const [k, v] of Object.entries(cookies)) {
    if (v && k.toLowerCase().endsWith("servicetoken")) {
      return v;
    }
  }
  return "";
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
  private homeOwnersCache = new Map<string, number | string>();

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
    this.homeOwnersCache.clear();
  }

  private ensureDeviceMeta(): { deviceId: string; passO: string; ua: string } {
    let deviceId =
      typeof this.authData["deviceId"] === "string" && this.authData["deviceId"].trim()
        ? this.authData["deviceId"].trim()
        : "";
    if (!deviceId) {
      deviceId = generateDeviceId();
      this.authData["deviceId"] = deviceId;
    }

    let passO =
      typeof this.authData["pass_o"] === "string" && this.authData["pass_o"].trim()
        ? this.authData["pass_o"].trim()
        : "";
    if (!passO) {
      passO = generatePassO();
      this.authData["pass_o"] = passO;
    }

    let ua =
      typeof this.authData["ua"] === "string" && this.authData["ua"].trim()
        ? this.authData["ua"].trim()
        : "";
    if (!ua) {
      ua = defaultUserAgent(passO);
      this.authData["ua"] = ua;
    }
    return { deviceId, passO, ua };
  }

  private buildMiotHeaders(ssecurity?: string): Record<string, string> {
    const { deviceId, ua } = this.ensureDeviceMeta();
    const userId = String(this.authData["userId"] ?? "");
    const cUserId = String(this.authData["cUserId"] ?? "");
    const serviceToken = String(this.authData["serviceToken"] ?? "");
    const country = DEFAULT_LOCALE.split("_")[1] || "CN";

    const cookies: string[] = [];
    if (cUserId) {
      cookies.push(`cUserId=${cUserId}`);
    }
    if (userId) {
      cookies.push(`userId=${userId}`);
    }
    const timezoneId = Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai";
    cookies.push(
      `yetAnotherServiceToken=${serviceToken}`,
      `serviceToken=${serviceToken}`,
      `timezone_id=${timezoneId}`,
      `timezone=${formatTimezoneOffset()}`,
      "is_daylight=0",
      "dst_offset=0",
      "channel=MI_APP_STORE",
      `countryCode=${country}`,
      `PassportDeviceId=${deviceId}`,
      `locale=${DEFAULT_LOCALE}`,
    );

    const headers: Record<string, string> = {
      "User-Agent": ua,
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept-Encoding": "identity",
      "miot-accept-encoding": "GZIP",
      "miot-encrypt-algorithm": "ENCRYPT-RC4",
      "x-xiaomi-protocal-flag-cli": "PROTOCAL-HTTP2",
      Cookie: cookies.join("; "),
    };
    if (ssecurity !== undefined) {
      // ssecurity stays in signed form params, never in HTTP headers.
    }
    return headers;
  }

  private request(url: string, init?: TimeoutFetchOptions): Promise<Response> {
    if (this.closed) {
      return Promise.reject(new LoginError("MijiaApiClient has been closed"));
    }
    return this.fetcher(url, init);
  }

  /**
   * Follow a Xiaomi STS callback URL with a session cookie jar across all redirect hops.
   *
   * Matches `Do1e/mijia-api`: requests `location` as-is first (since `sid=mijia` QR login
   * already returns a fully signed STS callback URL) and forwards accumulated cookies across
   * hops. Only falls back to appending `clientSign` if the untouched URL fails to yield a
   * `serviceToken` (backward compatibility with legacy `xiaomiio` STS flows).
   */
  private async followStsUrl(
    startUrl: string,
    ua: string,
    seedJar: readonly CookieJarEntry[],
  ): Promise<{
    cookies: Record<string, string>;
    stsCookies: Record<string, string>;
    ok: boolean;
    lastStatus: number;
  }> {
    const jar: CookieJarEntry[] = seedJar.map((entry) => ({ ...entry }));
    const stsJar: CookieJarEntry[] = [];
    let currentUrl = startUrl;
    let lastStatus = 0;

    for (let hop = 0; hop < MAX_STS_REDIRECTS; hop++) {
      const headers: Record<string, string> = {
        "User-Agent": ua,
        "Content-Type": "application/x-www-form-urlencoded",
        Connection: "keep-alive",
      };
      const cookieHeader = formatCookieHeaderForUrl(jar, currentUrl);
      if (cookieHeader) {
        headers["Cookie"] = cookieHeader;
      }

      const res = await this.request(currentUrl, {
        method: "GET",
        headers,
        redirect: "manual",
      });
      lastStatus = res.status;
      collectCookiesIntoJar(res.headers, currentUrl, jar);
      collectCookiesIntoJar(res.headers, currentUrl, stsJar);

      if (res.status >= 300 && res.status < 400) {
        const nextLocation = res.headers.get("location");
        if (nextLocation) {
          currentUrl = new URL(nextLocation, currentUrl).toString();
          continue;
        }
        break;
      }

      return {
        cookies: flattenCookieJar(jar),
        stsCookies: flattenCookieJar(stsJar),
        ok: res.ok,
        lastStatus,
      };
    }

    return {
      cookies: flattenCookieJar(jar),
      stsCookies: flattenCookieJar(stsJar),
      ok: lastStatus >= 200 && lastStatus < 400,
      lastStatus,
    };
  }

  private async exchangeLocationForTokens(
    location: string,
    ssecurity: string,
    nonce: unknown,
    ua: string,
    initialJar?: readonly CookieJarEntry[],
  ): Promise<Record<string, string>> {
    const seed = initialJar ?? [];

    // Primary path (mijia-api 5.x `sid=mijia`): request `location` as returned by Xiaomi.
    const primary = await this.followStsUrl(location, ua, seed);
    const primaryToken = extractServiceToken(primary.stsCookies);
    if (primaryToken) {
      primary.cookies["serviceToken"] = primaryToken;
      return primary.cookies;
    }

    // Fallback path (legacy `xiaomiio` STS endpoints that require an explicit clientSign param).
    if (nonce !== undefined && nonce !== null && !location.includes("clientSign=")) {
      const clientSign = computeClientSign(nonce, ssecurity);
      const sep = location.includes("?") ? "&" : "?";
      const signedUrl = `${location}${sep}clientSign=${encodeURIComponent(clientSign)}`;
      const fallback = await this.followStsUrl(signedUrl, ua, seed);
      const fallbackToken = extractServiceToken(fallback.stsCookies);
      if (fallbackToken) {
        fallback.cookies["serviceToken"] = fallbackToken;
        return fallback.cookies;
      }
      if (!fallback.ok && fallback.lastStatus > 0) {
        throw new LoginError(
          `Failed to exchange Xiaomi STS location: HTTP ${fallback.lastStatus}`,
          fallback.lastStatus,
        );
      }
    }

    const seedToken = extractServiceToken(primary.cookies);
    if (seedToken && primary.ok) {
      primary.cookies["serviceToken"] = seedToken;
      return primary.cookies;
    }

    if (!primary.ok && primary.lastStatus > 0) {
      throw new LoginError(
        `Failed to exchange Xiaomi STS location: HTTP ${primary.lastStatus}`,
        primary.lastStatus,
      );
    }

    throw new LoginError("Failed to obtain serviceToken from Xiaomi STS response");
  }

  /**
   * Call Xiaomi Account `pass/serviceLogin?_json=true&sid=mijia&_locale=zh_CN`.
   *
   * - If existing `passToken`/`userId` cookies are still valid (`code === 0`), refreshes
   *   `serviceToken` via the returned STS `location` and returns `{ refreshed: true }`.
   * - Otherwise (`code === 70016` etc.), extracts the signed login query parameters
   *   (`_sign`, `qs`, `callback`, `sid`, `serviceParam`, ...) from `serviceData.location`
   *   for the subsequent `longPolling/loginUrl` QR code request.
   */
  private async getLocation(): Promise<
    { refreshed: true } | { refreshed: false; locationData: Record<string, string> }
  > {
    const { deviceId, passO, ua } = this.ensureDeviceMeta();
    const passToken =
      typeof this.authData["passToken"] === "string" ? this.authData["passToken"].trim() : "";
    const userId = String(this.authData["userId"] ?? "").trim();
    const cUserId =
      typeof this.authData["cUserId"] === "string" ? this.authData["cUserId"].trim() : "";

    const reqCookie =
      `deviceId=${deviceId};` +
      `pass_o=${passO};` +
      `passToken=${passToken};` +
      `userId=${userId};` +
      `cUserId=${cUserId};` +
      `uLocale=${DEFAULT_LOCALE};`;

    const serviceUrl = `${XIAOMI_SERVICE_LOGIN_URL}?_json=true&sid=mijia&_locale=${DEFAULT_LOCALE}`;
    const res = await this.request(serviceUrl, {
      method: "GET",
      headers: {
        "User-Agent": ua,
        Connection: "keep-alive",
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: reqCookie,
      },
    });
    if (!res.ok) {
      throw new LoginError(
        `Failed to query Xiaomi serviceLogin: HTTP ${res.status}`,
        res.status,
      );
    }

    const initialCookies: CookieJarEntry[] = [];
    collectCookiesIntoJar(res.headers, serviceUrl, initialCookies);

    const serviceData = parseXiaomiJson(await res.text());
    const location = typeof serviceData["location"] === "string" ? serviceData["location"].trim() : "";
    if (!location) {
      throw new LoginError("Xiaomi serviceLogin response missing location");
    }

    const code = serviceData["code"];
    const ssecurity =
      typeof serviceData["ssecurity"] === "string" ? serviceData["ssecurity"].trim() : "";

    if (code === 0 && ssecurity) {
      try {
        const stsCookies = await this.exchangeLocationForTokens(
          location,
          ssecurity,
          serviceData["nonce"],
          ua,
          initialCookies,
        );
        this.authData = {
          ...this.authData,
          ...stsCookies,
          userId: serviceData["userId"] ?? stsCookies["userId"] ?? userId,
          cUserId:
            (typeof serviceData["cUserId"] === "string" && serviceData["cUserId"]) ||
            stsCookies["cUserId"] ||
            cUserId,
          ssecurity,
          serviceToken: stsCookies["serviceToken"],
          passToken:
            (typeof serviceData["passToken"] === "string" && serviceData["passToken"]) ||
            stsCookies["passToken"] ||
            passToken,
          deviceId,
          pass_o: passO,
          ua,
          expireTime: Date.now() + AUTH_EXPIRE_DAYS_MS,
          saveTime: Date.now(),
        };
        this.saveAuthData();
        return { refreshed: true };
      } catch {
        // Fall through to fresh QR login if silent STS exchange fails.
      }
    }

    const parsedLocation = new URL(location);
    const locationData: Record<string, string> = {};
    for (const [key, value] of parsedLocation.searchParams.entries()) {
      if (!(key in locationData)) {
        locationData[key] = value;
      }
    }
    return { refreshed: false, locationData };
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
    try {
      const result = await this.getLocation();
      return result.refreshed;
    } catch {
      return false;
    }
  }

  /**
   * Step 1 of two-step QR login (matching `Do1e/mijia-api._get_qr_login_data`).
   * Calls `serviceLogin?sid=mijia` first: returns `{ refreshed: true }` when existing
   * credentials silently refreshed, otherwise uses the server-signed location params
   * (`_sign`, `qs`, `callback`, `sid=mijia`, `serviceParam`) to fetch QR login data.
   */
  async getQrLoginData(): Promise<QrLoginData> {
    const locResult = await this.getLocation();
    if (locResult.refreshed) {
      return { loginUrl: "", lp: "", refreshed: true };
    }

    const { ua } = this.ensureDeviceMeta();
    const params = new URLSearchParams({
      ...locResult.locationData,
      theme: "",
      bizDeviceType: "",
      _hasLogo: "false",
      _qrsize: "240",
      _dc: String(Date.now()),
    });

    const res = await this.request(`${XIAOMI_QR_LOGIN_URL}?${params.toString()}`, {
      method: "GET",
      headers: {
        "User-Agent": ua,
        "Content-Type": "application/x-www-form-urlencoded",
        Connection: "keep-alive",
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
   * Step 2 of two-step QR login (matching `Do1e/mijia-api._complete_qr_login`).
   * Long-polls `loginData.lp` with an explicit 120-second timeout, exchanges the
   * returned STS `location` using the session cookie jar, and persists `auth.json`.
   */
  async completeQrLogin(loginData: QrLoginData): Promise<void> {
    const lp = typeof loginData?.lp === "string" ? loginData.lp.trim() : "";
    if (!lp) {
      throw new LoginError("Missing long-poll URL (lp) in QR login data");
    }

    const { deviceId, passO, ua } = this.ensureDeviceMeta();
    const lpRes = await this.request(lp, {
      method: "GET",
      headers: {
        "User-Agent": ua,
        "Content-Type": "application/x-www-form-urlencoded",
        Connection: "keep-alive",
      },
      timeoutMs: QR_LONG_POLL_TIMEOUT_MS,
    });

    if (!lpRes.ok) {
      throw new LoginError(
        `QR login long-poll failed: HTTP ${lpRes.status}`,
        lpRes.status,
      );
    }

    const sessionCookies: CookieJarEntry[] = [];
    collectCookiesIntoJar(lpRes.headers, lp, sessionCookies);

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
      sessionCookies,
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
    const psecurity =
      typeof lpData["psecurity"] === "string" ? lpData["psecurity"] : undefined;

    this.authData = {
      ...this.authData,
      ...stsCookies,
      ...(psecurity !== undefined ? { psecurity } : {}),
      ...(lpData["nonce"] !== undefined ? { nonce: lpData["nonce"] } : {}),
      userId,
      cUserId,
      ssecurity,
      serviceToken: stsCookies["serviceToken"],
      ...(passToken ? { passToken } : {}),
      deviceId,
      pass_o: passO,
      ua,
      expireTime: Date.now() + AUTH_EXPIRE_DAYS_MS,
      saveTime: Date.now(),
    };
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
        `MIoT API error on ${uri}: ${String(parsed["message"] ?? parsed["desc"] ?? "unknown error")} (code ${parsed["code"]})`,
        parsed["code"],
      );
    }

    return parsed;
  }

  private async getHomeOwner(homeId: string): Promise<number | string> {
    const key = String(homeId);
    const cached = this.homeOwnersCache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const homes = await this.getHomesList();
    for (const home of homes) {
      const id = String(home["id"] ?? "");
      if (id === key && home["uid"] !== undefined && home["uid"] !== null) {
        const owner = toNumericId(home["uid"]);
        this.homeOwnersCache.set(key, owner);
        return owner;
      }
    }
    return toNumericId(this.authData["userId"] ?? "");
  }

  async getHomesList(): Promise<Array<Record<string, unknown>>> {
    const res = await this.postEncrypted("/v2/homeroom/gethome_merged", {
      fg: true,
      fetch_share: true,
      fetch_share_dev: true,
      fetch_cariot: true,
      limit: 300,
      app_ver: 7,
      plat_form: 0,
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
          if (item["uid"] !== undefined && item["uid"] !== null) {
            this.homeOwnersCache.set(idKey, toNumericId(item["uid"]));
          }
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
        const res = await this.postEncrypted("/home/home_device_list", {
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
          devices.push(item["home_id"] ? item : { ...item, home_id: String(homeId) });
        }

        const hasMore = Boolean(result["has_more"]);
        const nextStart =
          typeof result["max_did"] === "string" && result["max_did"]
            ? result["max_did"]
            : typeof result["next_start_did"] === "string"
              ? result["next_start_did"]
              : "";
        if (!hasMore || !nextStart || nextStart === startDid) {
          break;
        }
        startDid = nextStart;
      }
    }

    return devices;
  }

  async getSharedDevicesList(): Promise<Array<Record<string, unknown>>> {
    const res = await this.postEncrypted("/v2/home/device_list_page", {
      ssid: "<unknown ssid>",
      bssid: "02:00:00:00:00:00",
      getVirtualModel: true,
      getHuamiDevices: 1,
      get_split_device: true,
      support_smart_home: true,
      get_cariot_device: true,
      get_third_device: true,
      get_phone_device: true,
      get_miwear_device: true,
    });

    if (!isRecord(res) || !isRecord(res["result"])) {
      return [];
    }
    const result = res["result"];
    const rawList = Array.isArray(result["list"])
      ? result["list"]
      : Array.isArray(result["share_dev_list"])
        ? result["share_dev_list"]
        : Array.isArray(result["device_info"])
          ? result["device_info"]
          : [];

    const devices: Array<Record<string, unknown>> = [];
    for (const item of rawList) {
      if (isRecord(item) && Boolean(item["owner"])) {
        devices.push({ ...item, home_id: "shared" });
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

    const res = await this.postEncrypted("/miotspec/prop/get", {
      params: items,
      datasource: 1,
    });
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
    const fetchForHome = async (
      hid: string,
      ownerUid?: number | string,
    ): Promise<Array<Record<string, unknown>>> => {
      const owner = ownerUid ?? (await this.getHomeOwner(hid));
      const res = await this.postEncrypted(
        "/appgateway/miot/appsceneservice/AppSceneService/GetSimpleSceneList",
        {
          app_version: 12,
          get_type: 2,
          home_id: String(hid),
          owner_uid: toNumericId(owner),
        },
      );
      if (!isRecord(res) || !isRecord(res["result"])) {
        return [];
      }
      const result = res["result"];
      const list = Array.isArray(result["manual_scene_info_list"])
        ? result["manual_scene_info_list"]
        : Array.isArray(result["scene_info_list"])
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
      const owner =
        home["uid"] !== undefined && home["uid"] !== null ? toNumericId(home["uid"]) : undefined;
      const scenes = await fetchForHome(hid, owner);
      allScenes.push(...scenes);
    }
    return allScenes;
  }

  async runScene(sceneId: string, homeId: string): Promise<boolean> {
    const owner = homeId ? await this.getHomeOwner(homeId) : toNumericId(this.authData["userId"] ?? "");
    const res = await this.postEncrypted(
      "/appgateway/miot/appsceneservice/AppSceneService/NewRunScene",
      {
        scene_id: String(sceneId),
        scene_type: 2,
        phone_id: "null",
        home_id: String(homeId),
        owner_uid: toNumericId(owner),
      },
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
