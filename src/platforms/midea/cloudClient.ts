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
import { MideaCloudSecurity } from "./security.ts";

export interface MideaCloudClientOptions {
  brand: MideaCloudBrand;
  account: string;
  password: string;
  useChinaServer?: boolean;
  httpFetch?: typeof fetch;
  timeoutMs?: number;
}

export interface MideaCloudSession {
  brand: MideaCloudBrand;
  uid: string;
  accessToken: string;
  sessionId: string;
  loggedInAt: number;
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
  online: boolean;
  homeId: string;
  homeName: string;
  roomName: string;
  protocolVersion: 2 | 3;
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

  constructor(message: string, code?: string | number, options?: ErrorOptions) {
    super(message, options);
    this.name = "MideaCloudError";
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

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
  // 格式 2：直接十六进制 0xAA 帧
  if (/^aa[0-9a-f]+$/i.test(trimmed) && trimmed.length % 2 === 0) {
    return Buffer.from(trimmed, "hex");
  }
  // 格式 3：AES 加密后的十六进制密文
  if (/^[0-9a-f]+$/i.test(trimmed) && trimmed.length >= 32 && trimmed.length % 32 === 0) {
    try {
      const decrypted = security.aesDecryptBytes(trimmed);
      if (decrypted.includes(0xaa)) {
        return decrypted;
      }
      const asText = decrypted.toString("utf-8").trim();
      if (/^[0-9a-f]+$/i.test(asText) && asText.length % 2 === 0) {
        return Buffer.from(asText, "hex");
      }
      if (asText.includes(",")) {
        return parseReplyToBuffer(asText, security);
      }
      return decrypted;
    } catch {
      return Buffer.from(trimmed, "hex");
    }
  }
  return null;
}

export class MideaCloudClient {
  readonly preset: MideaCloudPreset;
  readonly security: MideaCloudSecurity;
  private readonly _account: string;
  private readonly _password: string;
  private readonly _baseUrl: string;
  private readonly _httpFetch: typeof fetch;
  private readonly _timeoutMs: number;

  private _session: MideaCloudSession | null = null;

  constructor(options: MideaCloudClientOptions) {
    this.preset = MIDEA_CLOUD_PRESETS[options.brand];
    this.security = new MideaCloudSecurity(this.preset);
    this._account = options.account.trim();
    this._password = options.password;
    this._baseUrl =
      options.useChinaServer && this.preset.apiUrlChina
        ? this.preset.apiUrlChina
        : this.preset.apiUrl;
    this._httpFetch = options.httpFetch ?? fetch;
    this._timeoutMs = options.timeoutMs ?? 12_000;
  }

  get baseUrl(): string {
    return this._baseUrl;
  }

  get isLoggedIn(): boolean {
    return Boolean(this._session && (this._session.accessToken || this._session.sessionId));
  }

  get session(): MideaCloudSession | null {
    return this._session ? { ...this._session } : null;
  }

  clearSession(): void {
    this._session = null;
    this.security.clearAesKeys();
  }

  private async _requestMas(
    endpoint: string,
    payload: Record<string, unknown>,
    options?: { requireAuth?: boolean },
  ): Promise<Record<string, unknown>> {
    const url = `${this._baseUrl}${endpoint}`;
    const random = String(Math.floor(Date.now() / 1000));
    const bodyObj: Record<string, unknown> = {
      appId: this.preset.appId,
      format: 2,
      clientType: 1,
      language: "zh_CN",
      src: this.preset.appId,
      stamp: formatStamp(),
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
    if (options?.requireAuth !== false && this._session?.accessToken) {
      headers["accessToken"] = this._session.accessToken;
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
      const msg = typeof parsed["msg"] === "string" ? parsed["msg"] : "云端返回错误";
      throw new MideaCloudError(`美的云端错误 (${code}): ${msg}`, String(code));
    }

    return isRecord(parsed["data"]) ? parsed["data"] : parsed;
  }

  private async _requestLegacy(
    endpoint: string,
    payload: Record<string, unknown>,
    options?: { requireAuth?: boolean },
  ): Promise<Record<string, unknown>> {
    const url = `${this._baseUrl}${endpoint}`;
    const formObj: Record<string, unknown> = {
      appId: this.preset.appId,
      format: 2,
      clientType: 1,
      language: "en_US",
      src: this.preset.appId,
      stamp: formatStamp(),
      ...payload,
    };
    if (options?.requireAuth !== false && this._session?.sessionId) {
      formObj["sessionId"] = this._session.sessionId;
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
      const msg = typeof parsed["msg"] === "string" ? parsed["msg"] : "云端返回错误";
      throw new MideaCloudError(`美的云端错误 (${errCode}): ${msg}`, String(errCode));
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
    if (!this.isLoggedIn) {
      await this.login();
    }
  }

  /**
   * 登录美的云端账号（自动适配 Meiju / MSmartHome / NetHomePlus / MideaAir）。
   */
  async login(): Promise<MideaCloudSession> {
    if (!this._account || !this._password) {
      throw new MideaCloudError("请先填写美的账号与密码");
    }

    const deviceId = this.security.getDeviceId(this._account);

    if (this.preset.protocol === "mas") {
      const idData = await this._requestMas(
        "/v1/user/login/id/get",
        { loginAccount: this._account },
        { requireAuth: false },
      );
      const loginId = typeof idData["loginId"] === "string" ? idData["loginId"] : "";
      if (!loginId) {
        throw new MideaCloudError("美的云端登录失败：未获取到 loginId");
      }

      const iotData: Record<string, unknown> = {
        clientType: 1,
        deviceId,
        iampwd: this.security.encryptIamPassword(loginId, this._password),
        loginAccount: this._account,
        password: this.security.encryptPassword(loginId, this._password),
        pushToken: randomBytes(16).toString("hex"),
        reqId: createReqId(),
        src: this.preset.appId,
        stamp: formatStamp(),
      };
      if (this.preset.brand === "msmarthome") {
        iotData["appId"] = this.preset.appId;
      }

      const loginData = await this._requestMas(
        "/mj/user/login",
        {
          data: {
            platform: 3,
            deviceId,
          },
          iotData,
        },
        { requireAuth: false },
      );

      const mdata = isRecord(loginData["mdata"]) ? loginData["mdata"] : null;
      const accessToken =
        (mdata && typeof mdata["accessToken"] === "string" && mdata["accessToken"]) ||
        (typeof loginData["accessToken"] === "string" ? loginData["accessToken"] : "");
      if (!accessToken) {
        throw new MideaCloudError("美的云端登录失败：账号或密码错误，未返回访问令牌");
      }

      const uid =
        (typeof loginData["uid"] === "string" && loginData["uid"]) ||
        (mdata && typeof mdata["uid"] === "string" ? mdata["uid"] : "") ||
        this._account;

      const keySeed =
        (typeof loginData["key"] === "string" && loginData["key"]) ||
        (mdata && typeof mdata["key"] === "string" ? mdata["key"] : "");
      const ivSeed =
        (typeof loginData["iv"] === "string" && loginData["iv"]) ||
        (mdata && typeof mdata["iv"] === "string" ? mdata["iv"] : "");
      if (keySeed) {
        this.security.setAesKeys(keySeed, ivSeed || undefined);
      }

      this._session = {
        brand: this.preset.brand,
        uid,
        accessToken,
        sessionId: "",
        loggedInAt: Date.now(),
      };
      return { ...this._session };
    }

    // Legacy (NetHome Plus / Midea Air)
    const idData = await this._requestLegacy(
      "/v1/user/login/id/get",
      { loginAccount: this._account },
      { requireAuth: false },
    );
    const loginId = typeof idData["loginId"] === "string" ? idData["loginId"] : "";
    if (!loginId) {
      throw new MideaCloudError("美的旧版云端登录失败：未获取到 loginId");
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
      throw new MideaCloudError("美的旧版云端登录失败：未返回 sessionId");
    }
    const uid =
      (typeof loginData["userId"] === "string" && loginData["userId"]) ||
      (typeof loginData["uid"] === "string" && loginData["uid"]) ||
      this._account;

    this._session = {
      brand: this.preset.brand,
      uid,
      accessToken: "",
      sessionId,
      loggedInAt: Date.now(),
    };
    return { ...this._session };
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

    return {
      id,
      name,
      type,
      modelNumber,
      sn,
      sn8,
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
   */
  async sendTransparentCommand(
    applianceId: string,
    commandBytes: Uint8Array,
  ): Promise<Buffer | null> {
    await this._ensureLoggedIn();

    const signedOrder = Array.from(commandBytes)
      .map((b) => (b > 127 ? b - 256 : b))
      .join(",");
    const encryptedOrder = this.security.aesEncrypt(signedOrder);

    const payload: Record<string, unknown> = {
      applianceId: String(applianceId).trim(),
      order: encryptedOrder,
      funId: "0000",
    };

    const data =
      this.preset.protocol === "mas"
        ? await this._requestMas("/v1/appliance/transparent/send", payload)
        : await this._requestLegacy("/v1/appliance/transparent/send", payload);

    return parseReplyToBuffer(data["reply"] ?? data["result"], this.security);
  }
}
