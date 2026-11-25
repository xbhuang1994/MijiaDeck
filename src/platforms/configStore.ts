// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 多平台凭据与配置持久化存储 + 命名空间路由辅助

import { dataFile, readJson, writeJson, writeJsonStrict } from "../core/jsonStore.ts";
import { ALL_PLATFORM_IDS, type PlatformId } from "./types.ts";

export const PLATFORMS_CONFIG_FILENAME = "platforms.json";
export const PLATFORMS_CONFIG_VERSION = 1;

export interface TuyaLocalDeviceEntry {
  id: string;
  name: string;
  ip: string;
  port?: number;
  localKey: string;
  version: "3.1" | "3.3" | "3.4" | "3.5";
  category?: string;
  room?: string;
  dpsMap?: Record<string, string>;
}

export interface TuyaTokenSession {
  accessToken: string;
  refreshToken: string;
  expireTime: number;
  uid: string;
  endpoint: string;
  terminalId?: string;
  username?: string;
}

export interface TuyaPlatformConfig {
  enabled: boolean;
  mode: "sharing" | "openapi" | "local" | "hybrid";
  /** Home Assistant Device Sharing (Smart Life / 涂鸦智能 App 扫码登录) */
  userCode: string;
  clientId: string;
  schema: string;
  endpoint: string;
  tokenSession?: TuyaTokenSession | null;
  /** Tuya Cloud OpenAPI v2.0 */
  region: "cn" | "us" | "eu" | "in";
  accessId: string;
  accessSecret: string;
  uid: string;
  /** Local LAN (LocalTuya / TinyTuya) */
  preferLocal: boolean;
  localDevices: TuyaLocalDeviceEntry[];
}

export interface MideaLocalDeviceEntry {
  id: string;
  name: string;
  ip: string;
  port?: number;
  type: number; // e.g. 0xAC (172), 0xA1 (161), 0xFA (250)
  protocolVersion: 2 | 3;
  token?: string;
  key?: string;
  room?: string;
  model?: string;
}

export interface MideaPlatformConfig {
  enabled: boolean;
  mode: "cloud" | "local" | "hybrid";
  cloudBrand: "meiju" | "msmarthome" | "nethomeplus" | "midea_air";
  account: string;
  password: string;
  useChinaServer: boolean;
  preferLocal: boolean;
  localDevices: MideaLocalDeviceEntry[];
}

export interface DeyeSolarmanInverterEntry {
  id: string;
  name: string;
  ip: string;
  port?: number;
  serial: number;
  slaveId?: number;
  room?: string;
}

export interface DeyePlatformConfig {
  enabled: boolean;
  mode: "cloud" | "solarman" | "hybrid";
  username: string;
  password: string;
  authToken?: string;
  endpoint: string;
  solarmanInverters: DeyeSolarmanInverterEntry[];
}

export interface PlatformsConfigFile extends Record<string, unknown> {
  version: number;
  tuya: TuyaPlatformConfig;
  midea: MideaPlatformConfig;
  deye: DeyePlatformConfig;
}

const VALID_PLATFORM_SET = new Set<string>(ALL_PLATFORM_IDS);
const EXTERNAL_PLATFORM_RE = /^(tuya|midea|deye):(.+)$/;

const SECRET_KEY_RE =
  /(secret|password|passwd|token|localKey|accessKey|authToken|refreshToken|^key$)/i;

export function isPlatformId(value: unknown): value is PlatformId {
  return typeof value === "string" && VALID_PLATFORM_SET.has(value);
}

/**
 * 为设备 ID 添加平台命名空间前缀。
 * - 米家设备保持原始 DID（无前缀），确保历史缓存、托盘选择、音频与测试 100% 兼容。
 * - 第三方平台统一采用 `<platform>:<nativeDid>`，自动保留 `.sN` 多路拆分后缀。
 */
export function namespaceDid(platform: PlatformId, nativeDid: string): string {
  if (platform === "mijia") {
    return nativeDid;
  }
  const prefix = `${platform}:`;
  return nativeDid.startsWith(prefix) ? nativeDid : `${prefix}${nativeDid}`;
}

export function parseNamespacedDid(did: string): { platform: PlatformId; nativeDid: string } {
  const match = EXTERNAL_PLATFORM_RE.exec(did);
  if (match) {
    return {
      platform: match[1] as PlatformId,
      nativeDid: match[2]!,
    };
  }
  return {
    platform: "mijia",
    nativeDid: did,
  };
}

export function namespaceSceneId(platform: PlatformId, nativeSceneId: string): string {
  if (platform === "mijia") {
    return nativeSceneId;
  }
  const prefix = `${platform}:`;
  return nativeSceneId.startsWith(prefix) ? nativeSceneId : `${prefix}${nativeSceneId}`;
}

export function parseNamespacedSceneId(sceneId: string): {
  platform: PlatformId;
  nativeSceneId: string;
} {
  const match = EXTERNAL_PLATFORM_RE.exec(sceneId);
  if (match) {
    return {
      platform: match[1] as PlatformId,
      nativeSceneId: match[2]!,
    };
  }
  return {
    platform: "mijia",
    nativeSceneId: sceneId,
  };
}

export function defaultTuyaConfig(): TuyaPlatformConfig {
  return {
    enabled: false,
    mode: "sharing",
    userCode: process.env.TUYA_USER_CODE?.trim() ?? "",
    clientId: "HA_3y9q4ak7g4ephrvke",
    schema: "haauthorize",
    endpoint: "https://apigw.iotbing.com",
    tokenSession: null,
    region: (process.env.TUYA_REGION?.trim().toLowerCase() as TuyaPlatformConfig["region"]) || "cn",
    accessId: process.env.TUYA_ACCESS_ID?.trim() ?? "",
    accessSecret: process.env.TUYA_ACCESS_SECRET?.trim() ?? "",
    uid: process.env.TUYA_UID?.trim() ?? "",
    preferLocal: true,
    localDevices: [],
  };
}

export function defaultMideaConfig(): MideaPlatformConfig {
  return {
    enabled: false,
    mode: "hybrid",
    cloudBrand: "meiju",
    account: process.env.MIDEA_ACCOUNT?.trim() ?? "",
    password: process.env.MIDEA_PASSWORD ?? "",
    useChinaServer: true,
    preferLocal: true,
    localDevices: [],
  };
}

export function defaultDeyeConfig(): DeyePlatformConfig {
  return {
    enabled: false,
    mode: "cloud",
    username: process.env.DEYE_USERNAME?.trim() ?? "",
    password: process.env.DEYE_PASSWORD ?? "",
    authToken: "",
    endpoint: "https://api.deye.com.cn/v3/enduser",
    solarmanInverters: [],
  };
}

export function defaultPlatformsConfig(): PlatformsConfigFile {
  return {
    version: PLATFORMS_CONFIG_VERSION,
    tuya: defaultTuyaConfig(),
    midea: defaultMideaConfig(),
    deye: defaultDeyeConfig(),
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeTuyaConfig(raw: unknown): TuyaPlatformConfig {
  const base = defaultTuyaConfig();
  if (!isPlainRecord(raw)) return base;
  const mode = raw.mode;
  const region = raw.region;
  const tokenRaw = isPlainRecord(raw.tokenSession) ? raw.tokenSession : null;
  const localDevices: TuyaLocalDeviceEntry[] = Array.isArray(raw.localDevices)
    ? raw.localDevices
        .filter(isPlainRecord)
        .filter((d) => typeof d.id === "string" && typeof d.ip === "string")
        .map((d) => ({
          id: String(d.id).trim(),
          name: typeof d.name === "string" && d.name.trim() ? d.name.trim() : String(d.id),
          ip: String(d.ip).trim(),
          port: typeof d.port === "number" && Number.isFinite(d.port) ? d.port : 6668,
          localKey: typeof d.localKey === "string" ? d.localKey : "",
          version:
            d.version === "3.1" || d.version === "3.3" || d.version === "3.4" || d.version === "3.5"
              ? d.version
              : "3.3",
          ...(typeof d.category === "string" ? { category: d.category } : {}),
          ...(typeof d.room === "string" ? { room: d.room } : {}),
          ...(isPlainRecord(d.dpsMap)
            ? {
                dpsMap: Object.fromEntries(
                  Object.entries(d.dpsMap).map(([k, v]) => [String(k), String(v)]),
                ),
              }
            : {}),
        }))
    : [];

  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : base.enabled,
    mode:
      mode === "sharing" || mode === "openapi" || mode === "local" || mode === "hybrid"
        ? mode
        : base.mode,
    userCode: typeof raw.userCode === "string" ? raw.userCode.trim() : base.userCode,
    clientId:
      typeof raw.clientId === "string" && raw.clientId.trim()
        ? raw.clientId.trim()
        : base.clientId,
    schema:
      typeof raw.schema === "string" && raw.schema.trim() ? raw.schema.trim() : base.schema,
    endpoint:
      typeof raw.endpoint === "string" && raw.endpoint.trim()
        ? raw.endpoint.trim()
        : base.endpoint,
    tokenSession:
      tokenRaw &&
      ((typeof tokenRaw.accessToken === "string" && tokenRaw.accessToken) ||
        (typeof tokenRaw.refreshToken === "string" && tokenRaw.refreshToken))
        ? {
            accessToken: typeof tokenRaw.accessToken === "string" ? tokenRaw.accessToken : "",
            refreshToken: typeof tokenRaw.refreshToken === "string" ? tokenRaw.refreshToken : "",
            expireTime:
              typeof tokenRaw.expireTime === "number" && Number.isFinite(tokenRaw.expireTime)
                ? tokenRaw.expireTime
                : 0,
            uid: typeof tokenRaw.uid === "string" ? tokenRaw.uid : "",
            endpoint:
              typeof tokenRaw.endpoint === "string" && tokenRaw.endpoint
                ? tokenRaw.endpoint
                : base.endpoint,
            ...(typeof tokenRaw.terminalId === "string"
              ? { terminalId: tokenRaw.terminalId }
              : {}),
            ...(typeof tokenRaw.username === "string" ? { username: tokenRaw.username } : {}),
          }
        : null,
    region:
      region === "cn" || region === "us" || region === "eu" || region === "in"
        ? region
        : base.region,
    accessId: typeof raw.accessId === "string" ? raw.accessId.trim() : base.accessId,
    accessSecret: typeof raw.accessSecret === "string" ? raw.accessSecret : base.accessSecret,
    uid: typeof raw.uid === "string" ? raw.uid.trim() : base.uid,
    preferLocal: typeof raw.preferLocal === "boolean" ? raw.preferLocal : base.preferLocal,
    localDevices,
  };
}

function normalizeMideaConfig(raw: unknown): MideaPlatformConfig {
  const base = defaultMideaConfig();
  if (!isPlainRecord(raw)) return base;
  const mode = raw.mode;
  const brand = raw.cloudBrand;
  const localDevices: MideaLocalDeviceEntry[] = Array.isArray(raw.localDevices)
    ? raw.localDevices
        .filter(isPlainRecord)
        .filter((d) => (typeof d.id === "string" || typeof d.id === "number") && typeof d.ip === "string")
        .map((d) => ({
          id: String(d.id).trim(),
          name: typeof d.name === "string" && d.name.trim() ? d.name.trim() : `美的设备 ${d.id}`,
          ip: String(d.ip).trim(),
          port: typeof d.port === "number" && Number.isFinite(d.port) ? d.port : 6444,
          type: typeof d.type === "number" && Number.isFinite(d.type) ? d.type : 0xac,
          protocolVersion: d.protocolVersion === 2 ? 2 : 3,
          ...(typeof d.token === "string" && d.token ? { token: d.token } : {}),
          ...(typeof d.key === "string" && d.key ? { key: d.key } : {}),
          ...(typeof d.room === "string" ? { room: d.room } : {}),
          ...(typeof d.model === "string" ? { model: d.model } : {}),
        }))
    : [];

  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : base.enabled,
    mode: mode === "cloud" || mode === "local" || mode === "hybrid" ? mode : base.mode,
    cloudBrand:
      brand === "meiju" ||
      brand === "msmarthome" ||
      brand === "nethomeplus" ||
      brand === "midea_air"
        ? brand
        : base.cloudBrand,
    account: typeof raw.account === "string" ? raw.account.trim() : base.account,
    password: typeof raw.password === "string" ? raw.password : base.password,
    useChinaServer:
      typeof raw.useChinaServer === "boolean" ? raw.useChinaServer : base.useChinaServer,
    preferLocal: typeof raw.preferLocal === "boolean" ? raw.preferLocal : base.preferLocal,
    localDevices,
  };
}

function normalizeDeyeConfig(raw: unknown): DeyePlatformConfig {
  const base = defaultDeyeConfig();
  if (!isPlainRecord(raw)) return base;
  const mode = raw.mode;
  const solarmanInverters: DeyeSolarmanInverterEntry[] = Array.isArray(raw.solarmanInverters)
    ? raw.solarmanInverters
        .filter(isPlainRecord)
        .filter((d) => typeof d.ip === "string" && (typeof d.serial === "number" || typeof d.serial === "string"))
        .map((d) => {
          const serialNum = Number(d.serial);
          return {
            id: typeof d.id === "string" && d.id.trim() ? d.id.trim() : `inv_${serialNum}`,
            name: typeof d.name === "string" && d.name.trim() ? d.name.trim() : `德业逆变器 ${serialNum}`,
            ip: String(d.ip).trim(),
            port: typeof d.port === "number" && Number.isFinite(d.port) ? d.port : 8899,
            serial: Number.isFinite(serialNum) ? serialNum : 0,
            slaveId: typeof d.slaveId === "number" && Number.isFinite(d.slaveId) ? d.slaveId : 1,
            ...(typeof d.room === "string" ? { room: d.room } : {}),
          };
        })
    : [];

  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : base.enabled,
    mode: mode === "cloud" || mode === "solarman" || mode === "hybrid" ? mode : base.mode,
    username: typeof raw.username === "string" ? raw.username.trim() : base.username,
    password: typeof raw.password === "string" ? raw.password : base.password,
    authToken: typeof raw.authToken === "string" ? raw.authToken : base.authToken,
    endpoint:
      typeof raw.endpoint === "string" && raw.endpoint.trim()
        ? raw.endpoint.trim()
        : base.endpoint,
    solarmanInverters,
  };
}

export function loadPlatformsConfig(): PlatformsConfigFile {
  const raw = readJson<Record<string, unknown>>(dataFile(PLATFORMS_CONFIG_FILENAME), {});
  return {
    version: PLATFORMS_CONFIG_VERSION,
    tuya: normalizeTuyaConfig(raw.tuya),
    midea: normalizeMideaConfig(raw.midea),
    deye: normalizeDeyeConfig(raw.deye),
  };
}

export function savePlatformsConfig(config: PlatformsConfigFile, strict = false): void {
  const payload: PlatformsConfigFile = {
    version: PLATFORMS_CONFIG_VERSION,
    tuya: normalizeTuyaConfig(config.tuya),
    midea: normalizeMideaConfig(config.midea),
    deye: normalizeDeyeConfig(config.deye),
  };
  if (strict) {
    writeJsonStrict(dataFile(PLATFORMS_CONFIG_FILENAME), payload);
  } else {
    writeJson(dataFile(PLATFORMS_CONFIG_FILENAME), payload);
  }
}

export function loadPlatformSection<K extends "tuya" | "midea" | "deye">(
  platform: K,
): PlatformsConfigFile[K] {
  return loadPlatformsConfig()[platform];
}

export function savePlatformSection<K extends "tuya" | "midea" | "deye">(
  platform: K,
  section: PlatformsConfigFile[K],
): PlatformsConfigFile[K] {
  const full = loadPlatformsConfig();
  full[platform] = section;
  savePlatformsConfig(full);
  return loadPlatformsConfig()[platform];
}

/** 递归脱敏敏感字段，防止向前端或诊断报告泄露任何密钥/密码/令牌。 */
export function redactSecrets<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item)) as unknown as T;
  }
  if (!isPlainRecord(value)) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_KEY_RE.test(k)) {
      if (typeof v === "string") {
        out[k] = v.length > 0 ? "••••••••" : "";
      } else if (v !== null && v !== undefined) {
        out[k] = "[REDACTED]";
      } else {
        out[k] = v;
      }
    } else {
      out[k] = redactSecrets(v);
    }
  }
  return out as T;
}

export function summarizeTuyaConfig(cfg: TuyaPlatformConfig): Record<string, unknown> {
  return {
    enabled: cfg.enabled,
    mode: cfg.mode,
    userCode: cfg.userCode,
    endpoint: cfg.tokenSession?.endpoint || cfg.endpoint,
    region: cfg.region,
    accessId: cfg.accessId,
    hasAccessSecret: Boolean(cfg.accessSecret),
    uid: cfg.uid || cfg.tokenSession?.uid || "",
    hasTokenSession: Boolean(cfg.tokenSession?.accessToken || cfg.tokenSession?.refreshToken),
    username: cfg.tokenSession?.username || "",
    preferLocal: cfg.preferLocal,
    localDevices: cfg.localDevices.map((d) => ({
      id: d.id,
      name: d.name,
      ip: d.ip,
      port: d.port ?? 6668,
      version: d.version,
      category: d.category ?? "",
      room: d.room ?? "",
      hasLocalKey: Boolean(d.localKey),
    })),
  };
}

export function summarizeMideaConfig(cfg: MideaPlatformConfig): Record<string, unknown> {
  return {
    enabled: cfg.enabled,
    mode: cfg.mode,
    cloudBrand: cfg.cloudBrand,
    account: cfg.account,
    hasPassword: Boolean(cfg.password),
    useChinaServer: cfg.useChinaServer,
    preferLocal: cfg.preferLocal,
    localDevices: cfg.localDevices.map((d) => ({
      id: d.id,
      name: d.name,
      ip: d.ip,
      port: d.port ?? 6444,
      type: d.type,
      protocolVersion: d.protocolVersion,
      hasToken: Boolean(d.token),
      hasKey: Boolean(d.key),
      room: d.room ?? "",
      model: d.model ?? "",
    })),
  };
}

export function summarizeDeyeConfig(cfg: DeyePlatformConfig): Record<string, unknown> {
  return {
    enabled: cfg.enabled,
    mode: cfg.mode,
    username: cfg.username,
    hasPassword: Boolean(cfg.password),
    hasAuthToken: Boolean(cfg.authToken),
    endpoint: cfg.endpoint,
    solarmanInverters: cfg.solarmanInverters.map((inv) => ({
      id: inv.id,
      name: inv.name,
      ip: inv.ip,
      port: inv.port ?? 8899,
      serial: inv.serial,
      slaveId: inv.slaveId ?? 1,
      room: inv.room ?? "",
    })),
  };
}
