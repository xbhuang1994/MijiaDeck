// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 涂鸦智能 (Tuya Smart / Smart Life) 统一平台提供者 (IDevicePlatformProvider)

import type { ProgressCallback } from "../../core/contracts.ts";
import { prepareDeviceCards } from "../../core/deviceControls.ts";
import {
  createSceneInfo,
  type DeviceDetail,
  type DeviceInfo,
  type SceneInfo,
} from "../../core/models.ts";
import { ServiceError } from "../../core/service.ts";
import { renderQrSvg } from "../../ui/qrSvg.ts";
import {
  defaultTuyaConfig,
  loadPlatformSection,
  redactSecrets,
  savePlatformSection,
  summarizeTuyaConfig,
  type TuyaLocalDeviceEntry,
  type TuyaPlatformConfig,
  type TuyaTokenSession,
} from "../configStore.ts";
import type {
  DiscoveredLocalDevice,
  IDevicePlatformProvider,
  PlatformAuthMode,
  PlatformMetadata,
  PlatformQrAuthResult,
  PlatformQrAuthSession,
  PlatformStatus,
} from "../types.ts";
import {
  TUYA_CLIENT_ID,
  TUYA_DEFAULT_LOCAL_DPS_BY_CATEGORY,
  TUYA_LOCAL_DEFAULT_PORT,
  TUYA_SCHEMA,
  TUYA_SHARING_AUTH_ENDPOINT,
  isTuyaInfraredCategory,
  isTuyaIrHubCategory,
} from "./constants.ts";
import { discoverTuyaLanDevices, TuyaLocalClient } from "./localClient.ts";
import {
  formatTuyaDeviceMetrics,
  mapTuyaDeviceToCards,
  mijiaPropValueToTuyaRaw,
  parseTuyaSplitDid,
  tuyaRawValueToMijiaProp,
  type TuyaDeviceProfile,
  type TuyaDeviceRecord,
  type TuyaIrActionBinding,
  type TuyaIrRemoteMeta,
  type TuyaPropBinding,
} from "./mapper.ts";
import { TuyaOpenApiClient, TuyaOpenApiError, type TuyaOpenApiDevice } from "./openApiClient.ts";
import {
  isTuyaSharingAuthError,
  TuyaSharingApiError,
  TuyaSharingClient,
  type TuyaDeviceSpecification,
  type TuyaSharingDevice,
  type TuyaStatusItem,
} from "./sharingClient.ts";

export const TUYA_PLATFORM_METADATA: PlatformMetadata = {
  id: "tuya",
  name: "涂鸦智能",
  displayName: "涂鸦智能 / Smart Life",
  badgeText: "涂鸦",
  accentColor: "#ff6a00",
  description:
    "支持 Home Assistant Device Sharing App 扫码登录、Tuya Cloud OpenAPI v2.0 与 LocalTuya 局域网直连（v3.3/v3.4/v3.5）",
  reference: "Home Assistant tuya + tuya-device-sharing-sdk + localtuya / tinytuya",
  capabilities: {
    cloud: true,
    local: true,
    qrAuth: true,
    credentialsAuth: false,
    openApiAuth: true,
    lanDiscovery: true,
    scenes: true,
  },
};

export interface TuyaLocalTransport {
  queryDps(
    device: TuyaLocalDeviceEntry,
    options?: { timeoutMs?: number },
  ): Promise<Record<string, unknown>>;
  setDps(
    device: TuyaLocalDeviceEntry,
    dps: Record<string, unknown>,
    options?: { timeoutMs?: number },
  ): Promise<Record<string, unknown>>;
  discover?(options?: { timeoutMs?: number }): Promise<DiscoveredLocalDevice[]>;
}

export interface TuyaConfigStoreAdapter {
  load(): TuyaPlatformConfig;
  save(config: TuyaPlatformConfig): TuyaPlatformConfig;
}

export interface TuyaProviderOptions {
  httpFetch?: typeof fetch;
  localTransport?: TuyaLocalTransport;
  configStore?: TuyaConfigStoreAdapter;
  initialConfig?: Partial<TuyaPlatformConfig>;
  now?: () => number;
}

interface PendingQrSession {
  token: string;
  userCode: string;
  clientId: string;
  expiresAt: number;
}

const MASK_PLACEHOLDER = "••••••••";
const SPEC_CONCURRENCY = 6;
const IR_REPEAT_DELAY_MS = 180;

const IR_ACTION_ALIASES: Readonly<Record<string, readonly string[]>> = {
  poweron: ["poweron", "power_on", "开机", "打开", "开启"],
  poweroff: ["poweroff", "power_off", "关机", "关闭", "关掉"],
  power: ["power", "poweronoff", "电源", "开关", "电源开关"],
  "volume+": ["volume+", "vol+", "volumeup", "volume_up", "volume-up", "音量+", "音量加", "调大音量", "声音大"],
  "volume-": ["volume-", "vol-", "volumedown", "volume_down", "volume-down", "音量-", "音量减", "调小音量", "声音小"],
  mute: ["mute", "静音", "取消静音"],
  play: ["play", "播放", "继续播放", "恢复播放"],
  pause: ["pause", "暂停", "暂停播放"],
  playpause: ["playpause", "play/pause", "play_pause", "play-pause", "播放/暂停"],
  stop: ["stop", "停止", "停止播放"],
  next: ["next", "nexttrack", "next_track", "next-track", "下一首", "下一曲", "切歌"],
  previous: ["previous", "prev", "previoustrack", "previous_track", "previous-track", "上一首", "上一曲"],
  "channel+": ["channel+", "ch+", "channelup", "channel_up", "channel-up", "频道+", "频道加", "下一个频道"],
  "channel-": ["channel-", "ch-", "channeldown", "channel_down", "channel-down", "频道-", "频道减", "上一个频道"],
  up: ["up", "navigate_up", "上"],
  down: ["down", "navigate_down", "下"],
  left: ["left", "navigate_left", "左"],
  right: ["right", "navigate_right", "右"],
  ok: ["ok", "enter", "select", "确认", "确定"],
  menu: ["menu", "菜单"],
  home: ["home", "homepage", "主页", "首页"],
  back: ["back", "return", "返回"],
  source: ["source", "input", "signal", "信号源", "输入源"],
};

const TUYA_IR_FALLBACK_ERROR_CODES = new Set(["2050", "2008", "1109", "500", "2006"]);

function isRecoverableIrProtocolError(err: unknown): boolean {
  if (err instanceof TuyaOpenApiError) {
    const code = String(err.code ?? "");
    if (TUYA_IR_FALLBACK_ERROR_CODES.has(code)) return true;
    const msg = err.message.toLowerCase();
    return msg.includes("not support") || msg.includes("illegal") || msg.includes("not exist");
  }
  return false;
}

function formatIrOpenApiErrorZh(err: unknown, sanitize: (e: unknown) => string): string {
  if (err instanceof TuyaOpenApiError) {
    const code = String(err.code ?? "");
    if (code === "28841002" || err.message.toLowerCase().includes("trial")) {
      return "涂鸦云项目 IoT Core / 红外开放能力试用已到期（28841002）";
    }
    if (code === "28841105" || code === "28841106" || code === "1106") {
      return `涂鸦云项目未开通 IR Control Hub（万能红外开放能力）或未关联涂鸦 App 账号（${code}）`;
    }
    if (code === "1004" || code === "2009" || code === "2017") {
      return `涂鸦 OpenAPI Access ID / Secret 校验失败（${code}）`;
    }
  }
  return sanitize(err);
}

function normalizeIrActionToken(raw: string): string {
  return raw.trim().toLowerCase().replace(/[\s]+/g, "");
}

function parseIrRepeatCount(params: unknown): number {
  let raw: unknown = undefined;
  if (typeof params === "number") {
    raw = params;
  } else if (Array.isArray(params) && params.length === 1 && typeof params[0] === "number") {
    raw = params[0];
  } else if (isRecord(params) && typeof params.repeat === "number") {
    raw = params.repeat;
  }
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.max(1, Math.min(5, Math.round(raw)));
  }
  return 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isBlankOrMask(value: unknown): boolean {
  if (typeof value !== "string") return true;
  const trimmed = value.trim();
  return trimmed.length === 0 || trimmed === MASK_PLACEHOLDER;
}

function statusArrayToRecord(items?: TuyaStatusItem[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!Array.isArray(items)) return out;
  for (const item of items) {
    if (item && typeof item.code === "string") {
      out[item.code] = item.value;
    }
  }
  return out;
}

async function runWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runWorker = async (): Promise<void> => {
    while (cursor < items.length) {
      const idx = cursor;
      cursor += 1;
      results[idx] = await worker(items[idx]!);
    }
  };
  const count = Math.min(Math.max(1, limit), items.length);
  await Promise.all(Array.from({ length: count }, () => runWorker()));
  return results;
}

function buildDpIdMaps(
  category: string,
  spec: TuyaDeviceSpecification | null | undefined,
  localEntry?: TuyaLocalDeviceEntry,
  relations?: TuyaSharingDevice["dpStatusRelationDTOS"],
): { codeToDpId: Record<string, string>; dpIdToCode: Record<string, string> } {
  const dpIdToCode: Record<string, string> = {};
  const codeToDpId: Record<string, string> = {};

  const register = (dpId: string | number | undefined, code: string | undefined): void => {
    if (dpId === undefined || dpId === null || !code) return;
    const idStr = String(dpId).trim();
    const codeStr = code.trim();
    if (!idStr || !codeStr) return;
    dpIdToCode[idStr] = codeStr;
    codeToDpId[codeStr] = idStr;
  };

  // 1. Category defaults (lowest priority)
  const catDefaults = TUYA_DEFAULT_LOCAL_DPS_BY_CATEGORY[category.toLowerCase()];
  if (catDefaults) {
    for (const [idStr, codeStr] of Object.entries(catDefaults)) {
      register(idStr, codeStr);
    }
  }

  // 2. Cloud spec dp_id declarations
  for (const fn of spec?.status ?? []) register(fn.dp_id, fn.code);
  for (const fn of spec?.functions ?? []) register(fn.dp_id, fn.code);

  // 3. Sharing API dpStatusRelationDTOS
  for (const rel of relations ?? []) {
    register(rel.dpId, rel.dpCode || rel.statusCode);
  }

  // 4. Explicit local config dpsMap (highest priority)
  if (localEntry?.dpsMap) {
    for (const [idStr, codeStr] of Object.entries(localEntry.dpsMap)) {
      register(idStr, codeStr);
    }
  }

  return { codeToDpId, dpIdToCode };
}

function createDefaultLocalTransport(): TuyaLocalTransport {
  return {
    async queryDps(device, options) {
      const client = TuyaLocalClient.fromEntry(device, options?.timeoutMs ?? 4000);
      return await client.queryDps(options?.timeoutMs);
    },
    async setDps(device, dps, options) {
      const client = TuyaLocalClient.fromEntry(device, options?.timeoutMs ?? 4000);
      return await client.setDps(dps, options?.timeoutMs);
    },
    async discover(options) {
      return await discoverTuyaLanDevices(options?.timeoutMs ?? 3000);
    },
  };
}

function createDefaultConfigStore(): TuyaConfigStoreAdapter {
  return {
    load: () => loadPlatformSection("tuya"),
    save: (cfg) => savePlatformSection("tuya", cfg),
  };
}

export class TuyaPlatformProvider implements IDevicePlatformProvider {
  readonly id = "tuya" as const;
  readonly metadata = TUYA_PLATFORM_METADATA;

  private readonly _httpFetch?: typeof fetch;
  private readonly _localTransport: TuyaLocalTransport;
  private readonly _configStore: TuyaConfigStoreAdapter;
  private readonly _now: () => number;

  private _config: TuyaPlatformConfig;
  private _sharingClient: TuyaSharingClient;
  private _sharingSessionGen = 0;
  private _openApiClient: TuyaOpenApiClient | null = null;
  private _openApiVerified = false;
  private _controlBlockReason = "";

  private _records = new Map<string, TuyaDeviceRecord>();
  private _profiles = new Map<string, TuyaDeviceProfile>();
  private _specCache = new Map<string, TuyaDeviceSpecification>();
  private _pendingQr = new Map<string, PendingQrSession>();

  private _lastDeviceCount = 0;
  private _lastSceneCount = 0;
  private _lastSyncAt: number | null = null;
  private _lastError: string | null = null;
  private _lastIrOpenApiError: string | null = null;

  constructor(options: TuyaProviderOptions = {}) {
    this._httpFetch = options.httpFetch;
    this._localTransport = options.localTransport ?? createDefaultLocalTransport();
    this._configStore = options.configStore ?? createDefaultConfigStore();
    this._now = options.now ?? (() => Date.now());

    const loaded = this._configStore.load();
    this._config = options.initialConfig
      ? {
          ...defaultTuyaConfig(),
          ...loaded,
          ...options.initialConfig,
          localDevices: options.initialConfig.localDevices
            ? options.initialConfig.localDevices.map((d) => ({ ...d }))
            : loaded.localDevices.map((d) => ({ ...d })),
        }
      : loaded;

    this._sharingClient = this._buildSharingClient();
    this._openApiClient = this._buildOpenApiClient();
  }

  private _buildSharingClient(): TuyaSharingClient {
    const gen = this._sharingSessionGen;
    const client = new TuyaSharingClient({
      clientId: this._config.clientId || TUYA_CLIENT_ID,
      schema: this._config.schema || TUYA_SCHEMA,
      // 二维码认证固定走 Tuya HA 共享网关 apigw.iotbing.com；
      // 登录后数据请求会自动使用 tokenSession.endpoint（如 apigw.tuyacn.com）
      authEndpoint: TUYA_SHARING_AUTH_ENDPOINT,
      tokenSession: this._config.tokenSession ?? null,
      httpFetch: this._httpFetch,
      now: this._now,
      onTokenUpdate: (session: TuyaTokenSession) => {
        if (gen !== this._sharingSessionGen) {
          return;
        }
        this._config = {
          ...this._config,
          tokenSession: { ...session },
          endpoint: session.endpoint || this._config.endpoint,
        };
        this._configStore.save(this._config);
        if (this._sharingClient && this._sharingClient !== client) {
          this._sharingClient.setTokenSession(session);
        }
      },
    });
    return client;
  }

  private _buildOpenApiClient(): TuyaOpenApiClient | null {
    if (!this._config.accessId || !this._config.accessSecret) {
      return null;
    }
    return new TuyaOpenApiClient({
      accessId: this._config.accessId,
      accessSecret: this._config.accessSecret,
      region: this._config.region,
      httpFetch: this._httpFetch,
      now: this._now,
    });
  }

  private _rebuildClients(options: { resetSharingClient?: boolean } = {}): void {
    if (options.resetSharingClient !== false) {
      this._sharingSessionGen += 1;
      this._sharingClient = this._buildSharingClient();
    }
    this._openApiClient = this._buildOpenApiClient();
  }

  private _sanitizeErrorText(err: unknown): string {
    let text = err instanceof Error ? err.message : String(err);
    const secrets = [
      this._config.accessSecret,
      this._config.tokenSession?.accessToken,
      this._config.tokenSession?.refreshToken,
      ...this._config.localDevices.map((d) => d.localKey),
    ].filter((s): s is string => typeof s === "string" && s.length >= 6);

    for (const secret of secrets) {
      if (text.includes(secret)) {
        text = text.replaceAll(secret, "[REDACTED]");
      }
    }
    return text;
  }

  private _wrapError(err: unknown, context: string): ServiceError {
    if (err instanceof ServiceError) {
      return new ServiceError(this._sanitizeErrorText(err));
    }
    if (
      (err instanceof TuyaSharingApiError || err instanceof TuyaOpenApiError) &&
      String(err.code ?? "") === "2050"
    ) {
      return new ServiceError(`${context}: 当前模式不支持该红外参数组合（红外码库无对应指令，错误码 2050）`);
    }
    if (err instanceof TuyaSharingApiError && isTuyaSharingAuthError(err.code, err.message)) {
      const safe = this._sanitizeErrorText(err);
      return new ServiceError(
        safe.includes("重新扫码")
          ? `${context}: ${safe}`
          : `${context}: 涂鸦登录授权已失效（${safe}），请在「设置 → 多平台接入 → 涂鸦智能」重新扫码授权`,
      );
    }
    return new ServiceError(`${context}: ${this._sanitizeErrorText(err)}`);
  }

  private _requireControlAccess(): void {
    if (this._controlBlockReason) {
      throw new ServiceError(this._controlBlockReason);
    }
  }

  private _resolveAuthMode(): PlatformAuthMode {
    switch (this._config.mode) {
      case "sharing":
        return "qr";
      case "openapi":
        return "openapi";
      case "local":
        return "local";
      case "hybrid":
        return "hybrid";
    }
  }

  private _hasSharingCredentials(): boolean {
    return Boolean(
      this._config.tokenSession?.accessToken || this._config.tokenSession?.refreshToken,
    );
  }

  private _hasOpenApiCredentials(): boolean {
    return Boolean(this._config.accessId && this._config.accessSecret);
  }

  private _hasLocalDevices(): boolean {
    return this._config.localDevices.length > 0;
  }

  private _localEntryById(hardwareId: string): TuyaLocalDeviceEntry | undefined {
    return this._config.localDevices.find((d) => d.id === hardwareId);
  }

  private _computeConnected(): boolean {
    if (!this._config.enabled) return false;
    switch (this._config.mode) {
      case "sharing":
        return this._hasSharingCredentials();
      case "openapi":
        return this._hasOpenApiCredentials() && (this._openApiVerified || this._lastError === null);
      case "local":
        return this._hasLocalDevices();
      case "hybrid":
        return (
          this._hasSharingCredentials() ||
          this._hasOpenApiCredentials() ||
          this._hasLocalDevices()
        );
    }
  }

  // ---------- IDevicePlatformProvider 生命周期与状态 ----------

  setControlAccess(message = ""): void {
    this._controlBlockReason = message;
  }

  isEnabled(): boolean {
    return this._config.enabled;
  }

  isConnected(): boolean {
    return this._computeConnected();
  }

  status(): PlatformStatus {
    const connected = this._computeConnected();
    let state: PlatformStatus["state"] = "disconnected";
    if (this._config.enabled) {
      if (connected) {
        state = "connected";
      } else if (this._lastError) {
        state = "error";
      } else if (this._config.mode === "sharing" && this._config.userCode) {
        state = "configuring";
      }
    }

    return {
      ...this.metadata,
      enabled: this._config.enabled,
      connected,
      state,
      authMode: this._resolveAuthMode(),
      deviceCount: this._lastDeviceCount,
      sceneCount: this._lastSceneCount,
      lastSyncAt: this._lastSyncAt,
      lastError: this._lastError,
      configSummary: summarizeTuyaConfig(this._config),
    };
  }

  async configure(raw: Record<string, unknown>): Promise<PlatformStatus> {
    const prev = this._config;
    const modeRaw = raw.mode;
    const mode: TuyaPlatformConfig["mode"] =
      modeRaw === "sharing" || modeRaw === "openapi" || modeRaw === "local" || modeRaw === "hybrid"
        ? modeRaw
        : prev.mode;

    const regionRaw = raw.region;
    const region: TuyaPlatformConfig["region"] =
      regionRaw === "cn" || regionRaw === "us" || regionRaw === "eu" || regionRaw === "in"
        ? regionRaw
        : prev.region;

    // 保留已有秘钥：若前端回传空串或脱敏占位符，则继续沿用原密钥
    const clearSecrets = raw.clearSecrets === true;
    const nextAccessSecret = clearSecrets
      ? ""
      : isBlankOrMask(raw.accessSecret)
        ? prev.accessSecret
        : String(raw.accessSecret);

    const prevLocalById = new Map(prev.localDevices.map((d) => [d.id, d]));
    let nextLocalDevices = prev.localDevices;
    if (Array.isArray(raw.localDevices)) {
      nextLocalDevices = raw.localDevices
        .filter(isRecord)
        .filter((d) => typeof d.id === "string" && typeof d.ip === "string")
        .map((d) => {
          const id = String(d.id).trim();
          const existing = prevLocalById.get(id);
          const localKey = clearSecrets
            ? ""
            : isBlankOrMask(d.localKey)
              ? (existing?.localKey ?? "")
              : String(d.localKey);
          const ver = d.version;
          const version: TuyaLocalDeviceEntry["version"] =
            ver === "3.1" || ver === "3.3" || ver === "3.4" || ver === "3.5"
              ? ver
              : (existing?.version ?? "3.3");
          return {
            id,
            name:
              typeof d.name === "string" && d.name.trim()
                ? d.name.trim()
                : (existing?.name ?? id),
            ip: String(d.ip).trim(),
            port:
              typeof d.port === "number" && Number.isFinite(d.port)
                ? d.port
                : (existing?.port ?? TUYA_LOCAL_DEFAULT_PORT),
            localKey,
            version,
            ...(typeof d.category === "string"
              ? { category: d.category }
              : existing?.category
                ? { category: existing.category }
                : {}),
            ...(typeof d.room === "string"
              ? { room: d.room }
              : existing?.room
                ? { room: existing.room }
                : {}),
            ...(isRecord(d.dpsMap)
              ? {
                  dpsMap: Object.fromEntries(
                    Object.entries(d.dpsMap).map(([k, v]) => [String(k), String(v)]),
                  ),
                }
              : existing?.dpsMap
                ? { dpsMap: { ...existing.dpsMap } }
                : {}),
          };
        });
    }

    let nextTokenSession = prev.tokenSession ?? null;
    let tokenSessionExplicitlyChanged = false;
    if (clearSecrets || raw.tokenSession === null) {
      nextTokenSession = null;
      tokenSessionExplicitlyChanged = true;
    } else if (isRecord(raw.tokenSession) && typeof raw.tokenSession.accessToken === "string") {
      tokenSessionExplicitlyChanged = true;
      nextTokenSession = {
        accessToken: raw.tokenSession.accessToken,
        refreshToken:
          typeof raw.tokenSession.refreshToken === "string"
            ? raw.tokenSession.refreshToken
            : (prev.tokenSession?.refreshToken ?? ""),
        expireTime:
          typeof raw.tokenSession.expireTime === "number"
            ? raw.tokenSession.expireTime
            : (prev.tokenSession?.expireTime ?? 0),
        uid:
          typeof raw.tokenSession.uid === "string"
            ? raw.tokenSession.uid
            : (prev.tokenSession?.uid ?? ""),
        endpoint:
          typeof raw.tokenSession.endpoint === "string" && raw.tokenSession.endpoint
            ? raw.tokenSession.endpoint
            : prev.endpoint,
        ...(typeof raw.tokenSession.terminalId === "string"
          ? { terminalId: raw.tokenSession.terminalId }
          : {}),
        ...(typeof raw.tokenSession.username === "string"
          ? { username: raw.tokenSession.username }
          : {}),
      };
    }

    const updated: TuyaPlatformConfig = {
      enabled: typeof raw.enabled === "boolean" ? raw.enabled : prev.enabled,
      mode,
      userCode: typeof raw.userCode === "string" ? raw.userCode.trim() : prev.userCode,
      clientId:
        typeof raw.clientId === "string" && raw.clientId.trim()
          ? raw.clientId.trim()
          : prev.clientId || TUYA_CLIENT_ID,
      schema:
        typeof raw.schema === "string" && raw.schema.trim()
          ? raw.schema.trim()
          : prev.schema || TUYA_SCHEMA,
      endpoint:
        typeof raw.endpoint === "string" && raw.endpoint.trim()
          ? raw.endpoint.trim()
          : prev.endpoint || TUYA_SHARING_AUTH_ENDPOINT,
      tokenSession: nextTokenSession,
      region,
      accessId: typeof raw.accessId === "string" ? raw.accessId.trim() : prev.accessId,
      accessSecret: nextAccessSecret,
      uid: typeof raw.uid === "string" ? raw.uid.trim() : prev.uid,
      preferLocal: typeof raw.preferLocal === "boolean" ? raw.preferLocal : prev.preferLocal,
      localDevices: nextLocalDevices,
    };

    const shouldResetSharingClient =
      tokenSessionExplicitlyChanged ||
      updated.clientId !== prev.clientId ||
      updated.schema !== prev.schema;

    this._config = this._configStore.save(updated);
    this._rebuildClients({ resetSharingClient: shouldResetSharingClient });
    this._records.clear();
    this._profiles.clear();
    this._lastError = null;
    this._lastIrOpenApiError = null;
    this._openApiVerified = false;

    // 若启用了 OpenAPI 或混合模式且已提供 Access ID / Secret，主动校验并换取 Token
    if (
      raw.verify !== false &&
      this._config.enabled &&
      (this._config.mode === "openapi" || this._config.mode === "hybrid") &&
      this._openApiClient
    ) {
      try {
        const token = await this._openApiClient.getAccessToken(true);
        this._openApiVerified = true;
        if (!this._config.uid && token.uid) {
          this._config = this._configStore.save({ ...this._config, uid: token.uid });
        }
      } catch (err) {
        this._openApiVerified = false;
        const msg = formatIrOpenApiErrorZh(err, (e) => this._sanitizeErrorText(e));
        this._lastIrOpenApiError = msg;
        if (this._config.mode === "openapi" || !this._hasSharingCredentials()) {
          this._lastError = this._sanitizeErrorText(err);
        }
      }
    }

    return this.status();
  }

  async disconnect(): Promise<void> {
    this._pendingQr.clear();
    this._records.clear();
    this._profiles.clear();
    this._specCache.clear();
    this._openApiVerified = false;
    this._lastDeviceCount = 0;
    this._lastSceneCount = 0;
    this._lastError = null;
    this._lastIrOpenApiError = null;

    this._config = this._configStore.save({
      ...this._config,
      enabled: false,
      tokenSession: null,
      accessSecret: "",
    });
    this._rebuildClients();
  }

  dispose(): void {
    this._pendingQr.clear();
  }

  // ---------- 二维码扫码登录 (HA Device Sharing) ----------

  async beginQrAuth(params: Record<string, unknown> = {}): Promise<PlatformQrAuthSession> {
    const userCode =
      typeof params.userCode === "string" && params.userCode.trim()
        ? params.userCode.trim()
        : this._config.userCode.trim();
    if (!userCode) {
      throw new ServiceError(
        "请先填写「涂鸦智能 / Smart Life」App 中的用户码（设置 → 账号与安全 → 用户码）",
      );
    }

    const clientId =
      typeof params.clientId === "string" && params.clientId.trim()
        ? params.clientId.trim()
        : this._config.clientId || TUYA_CLIENT_ID;
    const schema =
      typeof params.schema === "string" && params.schema.trim()
        ? params.schema.trim()
        : this._config.schema || TUYA_SCHEMA;
    const endpoint =
      typeof params.endpoint === "string" && params.endpoint.trim()
        ? params.endpoint.trim()
        : this._config.endpoint || TUYA_SHARING_AUTH_ENDPOINT;

    if (
      userCode !== this._config.userCode ||
      clientId !== this._config.clientId ||
      schema !== this._config.schema ||
      endpoint !== this._config.endpoint
    ) {
      const shouldResetSharing =
        clientId !== this._config.clientId || schema !== this._config.schema;
      this._config = this._configStore.save({
        ...this._config,
        userCode,
        clientId,
        schema,
        endpoint,
      });
      this._rebuildClients({ resetSharingClient: shouldResetSharing });
    }

    let qr: { token: string; qrContent: string };
    try {
      qr = await this._sharingClient.requestQrCode(userCode, clientId, schema);
    } catch (err) {
      const msg = this._sanitizeErrorText(err);
      this._lastError = msg;
      throw new ServiceError(`获取涂鸦登录二维码失败: ${msg}`);
    }
    this._lastError = null;

    const sessionId = `tuya-qr-${this._now()}-${Math.random().toString(36).slice(2, 8)}`;
    const expiresAt = this._now() + 180_000;
    this._pendingQr.set(sessionId, {
      token: qr.token,
      userCode,
      clientId,
      expiresAt,
    });

    return {
      platform: "tuya",
      sessionId,
      qrContent: qr.qrContent,
      qrSvg: renderQrSvg(qr.qrContent),
      expiresAt,
      hint: "请使用「涂鸦智能」或「Smart Life」App 扫一扫确认授权",
      meta: { userCode },
    };
  }

  async pollQrAuth(sessionId: string): Promise<PlatformQrAuthResult> {
    const pending = this._pendingQr.get(sessionId);
    if (!pending) {
      return {
        platform: "tuya",
        status: "expired",
        message: "二维码会话不存在或已失效，请重新获取",
      };
    }
    if (this._now() > pending.expiresAt) {
      this._pendingQr.delete(sessionId);
      return {
        platform: "tuya",
        status: "expired",
        message: "二维码已过期，请重新获取",
      };
    }

    const res = await this._sharingClient.pollQrLogin(
      pending.token,
      pending.userCode,
      pending.clientId,
    );

    if (res.success && res.tokenSession) {
      this._pendingQr.delete(sessionId);
      this._lastError = null;
      const nextMode: TuyaPlatformConfig["mode"] =
        this._config.mode === "hybrid" ? "hybrid" : "sharing";
      this._config = this._configStore.save({
        ...this._config,
        enabled: true,
        mode: nextMode,
        userCode: pending.userCode,
        endpoint: res.tokenSession.endpoint || this._config.endpoint,
        tokenSession: { ...res.tokenSession },
      });
      this._rebuildClients({ resetSharingClient: false });
      return {
        platform: "tuya",
        status: "success",
        message: "涂鸦账号扫码授权成功",
        platformStatus: this.status(),
      };
    }

    if (res.expired) {
      this._pendingQr.delete(sessionId);
      return {
        platform: "tuya",
        status: "expired",
        message: res.error || "二维码已过期，请重新获取",
      };
    }

    if (res.pending) {
      return {
        platform: "tuya",
        status: "pending",
        message: res.error || "等待手机端扫码确认…",
      };
    }

    const safeErr = this._sanitizeErrorText(res.error || "扫码登录失败");
    this._lastError = safeErr;
    return {
      platform: "tuya",
      status: "error",
      message: safeErr,
      platformStatus: this.status(),
    };
  }

  // ---------- 局域网设备发现 ----------

  async discoverLocal(options?: { timeoutMs?: number }): Promise<DiscoveredLocalDevice[]> {
    if (this._localTransport.discover) {
      return await this._localTransport.discover(options);
    }
    return await discoverTuyaLanDevices(options?.timeoutMs ?? 3000);
  }

  // ---------- 设备同步与模型构建 ----------

  async listDevices(progress?: ProgressCallback): Promise<DeviceInfo[]> {
    if (!this._config.enabled) {
      return [];
    }

    try {
      const recordsById = new Map<string, TuyaDeviceRecord>();
      const mode = this._config.mode;
      this._lastIrOpenApiError = null;

      const useSharing =
        (mode === "sharing" || mode === "hybrid") && this._hasSharingCredentials();
      const useOpenApi =
        (mode === "openapi" || (mode === "hybrid" && !useSharing)) &&
        this._hasOpenApiCredentials() &&
        this._openApiClient !== null;

      if (useSharing) {
        progress?.(15, "正在获取涂鸦家庭与设备列表…");
        const homes = await this._sharingClient.queryHomes();
        const homeDeviceLists = await Promise.all(
          homes.map(async (home) => {
            const list = await this._sharingClient.queryDevicesByHome(home.ownerId);
            return { home, list };
          }),
        );

        const rawDevices: Array<{ homeName: string; dev: TuyaSharingDevice }> = [];
        const seen = new Set<string>();
        for (const { home, list } of homeDeviceLists) {
          for (const dev of list) {
            if (!dev.id || seen.has(dev.id)) continue;
            seen.add(dev.id);
            rawDevices.push({ homeName: dev.homeName || dev.home_name || home.name, dev });
          }
        }

        progress?.(45, `正在同步 ${rawDevices.length} 台涂鸦设备规格与房间…`);
        const deviceMeta = await runWithConcurrency(rawDevices, SPEC_CONCURRENCY, async ({ dev }) => {
          const inlineRoom = (dev.roomName || dev.room_name || "").trim();
          const [spec, roomName] = await Promise.all([
            (async (): Promise<TuyaDeviceSpecification | null> => {
              const cached = this._specCache.get(dev.id);
              if (cached) return cached;
              try {
                const s = await this._sharingClient.queryDeviceSpec(dev.id);
                this._specCache.set(dev.id, s);
                return s;
              } catch {
                return null;
              }
            })(),
            (async (): Promise<string> => {
              if (inlineRoom) return inlineRoom;
              try {
                const room = await this._sharingClient.queryRoomByDevice(dev.id);
                return room?.name?.trim() || "";
              } catch {
                return "";
              }
            })(),
          ]);
          return { spec, roomName };
        });

        for (let i = 0; i < rawDevices.length; i += 1) {
          const { homeName, dev } = rawDevices[i]!;
          const { spec, roomName: resolvedRoom } = deviceMeta[i] ?? { spec: null, roomName: "" };
          const localEntry = this._localEntryById(dev.id);
          const category = dev.category || spec?.category || "";
          const { codeToDpId, dpIdToCode } = buildDpIdMaps(
            category,
            spec,
            localEntry,
            dev.dpStatusRelationDTOS,
          );
          recordsById.set(dev.id, {
            id: dev.id,
            name: dev.name || dev.id,
            category,
            productId: dev.productId || dev.product_id,
            model: dev.model,
            homeName,
            roomName: resolvedRoom || localEntry?.room?.trim() || "默认房间",
            online: Boolean(dev.online),
            ...(typeof dev.sub === "boolean" ? { sub: dev.sub } : {}),
            localKey: localEntry?.localKey || dev.localKey || dev.local_key,
            ip: localEntry?.ip || dev.ip,
            status: statusArrayToRecord(dev.status),
            spec,
            codeToDpId,
            dpIdToCode,
            source: localEntry && mode === "hybrid" ? "hybrid" : "sharing",
          });
        }
      } else if (useOpenApi && this._openApiClient) {
        progress?.(15, "正在通过涂鸦 OpenAPI 获取设备列表…");
        const token = await this._openApiClient.getAccessToken();
        this._openApiVerified = true;
        const uid = this._config.uid || token.uid;
        if (!uid) {
          throw new ServiceError("涂鸦 OpenAPI 模式缺少用户 UID，请在平台配置中填写 UID");
        }
        const rawDevices: TuyaOpenApiDevice[] = await this._openApiClient.listUserDevices(uid);
        const deviceLocationById = new Map<string, { homeName: string; roomName: string }>();
        let defaultHomeName = "涂鸦家庭";
        try {
          const homes = await this._openApiClient.listHomes(uid);
          if (homes[0]?.name) defaultHomeName = homes[0].name;
          await Promise.all(
            homes.map(async (home) => {
              try {
                const rooms = await this._openApiClient!.listHomeRooms(home.home_id);
                await runWithConcurrency(rooms, SPEC_CONCURRENCY, async (room) => {
                  try {
                    const roomDevs = await this._openApiClient!.listRoomDevices(
                      home.home_id,
                      room.room_id,
                    );
                    for (const rd of roomDevs) {
                      if (rd.id && room.name) {
                        deviceLocationById.set(rd.id, {
                          homeName: home.name || defaultHomeName,
                          roomName: room.name,
                        });
                      }
                    }
                  } catch {
                    // individual room device lookup is best-effort
                  }
                });
              } catch {
                // rooms endpoint is optional in some OpenAPI project scopes
              }
            }),
          );
        } catch {
          // homes endpoint is optional in some OpenAPI project scopes
        }

        progress?.(45, `正在同步 ${rawDevices.length} 台涂鸦 OpenAPI 设备规格…`);
        const specs = await runWithConcurrency(rawDevices, SPEC_CONCURRENCY, async (dev) => {
          const cached = this._specCache.get(dev.id);
          if (cached) return cached;
          try {
            const spec = await this._openApiClient!.getDeviceSpecification(dev.id);
            this._specCache.set(dev.id, spec);
            return spec;
          } catch {
            return null;
          }
        });

        for (let i = 0; i < rawDevices.length; i += 1) {
          const dev = rawDevices[i]!;
          const spec = specs[i] ?? null;
          const localEntry = this._localEntryById(dev.id);
          const loc = deviceLocationById.get(dev.id);
          const category = dev.category || spec?.category || "";
          const { codeToDpId, dpIdToCode } = buildDpIdMaps(category, spec, localEntry);
          recordsById.set(dev.id, {
            id: dev.id,
            name: dev.name || dev.id,
            category,
            productId: dev.product_id,
            model: dev.model,
            homeName: loc?.homeName || defaultHomeName,
            roomName:
              dev.roomName?.trim() ||
              dev.room_name?.trim() ||
              loc?.roomName ||
              localEntry?.room?.trim() ||
              "默认房间",
            online: Boolean(dev.online),
            ...(typeof dev.sub === "boolean" ? { sub: dev.sub } : {}),
            localKey: localEntry?.localKey || dev.local_key,
            ip: localEntry?.ip || dev.ip,
            status: statusArrayToRecord(dev.status),
            spec,
            codeToDpId,
            dpIdToCode,
            source: localEntry && mode === "hybrid" ? "hybrid" : "openapi",
          });
        }
      }

      // OpenAPI v2.0 (openapi 或 hybrid 模式，即使主设备列表来自扫码共享也执行)：
      // 若存在万能红外遥控器网关 (wnykq/qt)，通过 IR Control Hub v2.0 补全虚拟红外遥控器的权威按键、标准键标记与 DIY 学习码
      if (this._canUseOpenApiIr()) {
        await this._enrichOpenApiIrRemotes(recordsById);
      }

      // Local-only 或 Hybrid 中的独立局域网设备
      if (mode === "local" || mode === "hybrid") {
        const localOnly = this._config.localDevices.filter((d) => !recordsById.has(d.id));
        if (localOnly.length > 0) {
          progress?.(65, `正在探测 ${localOnly.length} 台局域网涂鸦设备…`);
          await Promise.all(
            localOnly.map(async (entry) => {
              const category = entry.category || "cz";
              const { codeToDpId, dpIdToCode } = buildDpIdMaps(category, null, entry);
              let online = false;
              const status: Record<string, unknown> = {};
              try {
                const rawDps = await this._localTransport.queryDps(entry, { timeoutMs: 2500 });
                online = true;
                for (const [dpId, val] of Object.entries(rawDps)) {
                  const code = dpIdToCode[dpId] ?? dpId;
                  status[code] = val;
                }
              } catch {
                online = false;
              }
              recordsById.set(entry.id, {
                id: entry.id,
                name: entry.name || entry.id,
                category,
                homeName: "本地局域网",
                roomName: entry.room || "局域网",
                online,
                localKey: entry.localKey,
                ip: entry.ip,
                status,
                spec: null,
                codeToDpId,
                dpIdToCode,
                source: "local",
              });
            }),
          );
        }
      }

      const allCards: DeviceInfo[] = [];
      const nextProfiles = new Map<string, TuyaDeviceProfile>();
      const prevProfiles = this._profiles;

      for (const record of recordsById.values()) {
        const { cards, profiles } = mapTuyaDeviceToCards(record);
        allCards.push(...cards);
        for (const [did, profile] of profiles.entries()) {
          // 跨刷新保留单向红外遥控器的会话推断电源状态（云端未上报实时状态时）
          const prev = prevProfiles.get(did);
          if (
            profile.irPower &&
            profile.irPower.assumedState === null &&
            prev?.irPower &&
            prev.irPower.assumedState !== null
          ) {
            profile.irPower.assumedState = prev.irPower.assumedState;
          }
          nextProfiles.set(did, profile);
        }
      }

      prepareDeviceCards(allCards);

      this._records = recordsById;
      this._profiles = nextProfiles;
      this._lastDeviceCount = allCards.length;
      this._lastSyncAt = this._now();
      this._lastError = null;

      progress?.(90, `已加载 ${allCards.length} 台涂鸦设备`);
      return allCards.sort(
        (a, b) =>
          compareStr(a.home_name, b.home_name) ||
          compareStr(a.room_name, b.room_name) ||
          compareStr(a.name, b.name),
      );
    } catch (err) {
      const wrapped = this._wrapError(err, "获取涂鸦设备列表失败");
      this._lastError = wrapped.message;
      throw wrapped;
    }
  }

  private async _enrichOpenApiIrRemotes(recordsById: Map<string, TuyaDeviceRecord>): Promise<void> {
    const client = this._openApiClient;
    if (!client) return;
    const hubs = [...recordsById.values()].filter(
      (r) => !r.sub && isTuyaIrHubCategory(r.category),
    );
    if (hubs.length === 0) return;

    await Promise.all(
      hubs.map(async (hub) => {
        let remotes;
        try {
          remotes = await client.listInfraredRemotes(hub.id);
        } catch (err) {
          // 记录 IR Control Hub OpenAPI 失败原因（如未开通红外服务/试用期到期），供详情页告警与诊断报告展示
          this._lastIrOpenApiError = formatIrOpenApiErrorZh(err, (e) => this._sanitizeErrorText(e));
          return;
        }
        await runWithConcurrency(remotes, SPEC_CONCURRENCY, async (remote) => {
          const target = recordsById.get(remote.remote_id);
          if (!target) return;
          try {
            const keysRes = await client.getInfraredRemoteKeys(hub.id, remote.remote_id);
            const rawKeys = keysRes?.key_list ?? [];
            const isIrAc = target.category.toLowerCase() === "infrared_ac";
            const needsLearning =
              !isIrAc &&
              (remote.category_id === 999 ||
                remote.category_id === 99 ||
                target.category.toLowerCase() === "infrared_diy" ||
                rawKeys.length === 0 ||
                rawKeys.some((k) => k.standard_key === false));
            const learningByKey = new Map<string, string>();
            const learningById = new Map<number, string>();
            const learnedList: Array<{ id?: number; learn_id?: number; key: string; key_name?: string; code: string }> = [];
            if (needsLearning) {
              try {
                const learned = await client.listInfraredLearningCodes(hub.id, remote.remote_id);
                for (const lc of learned) {
                  learnedList.push(lc);
                  learningByKey.set(lc.key.toLowerCase(), lc.code);
                  if (lc.id !== undefined) learningById.set(lc.id, lc.code);
                  if (lc.learn_id !== undefined) learningById.set(lc.learn_id, lc.code);
                }
              } catch {
                // learning-codes endpoint is best-effort
              }
            }
            const mergedKeys: NonNullable<TuyaIrRemoteMeta["keys"]> = rawKeys.map((k) => {
              const learningCode =
                (k.key_id !== undefined ? learningById.get(k.key_id) : undefined) ??
                learningByKey.get(k.key.toLowerCase());
              return {
                key: k.key,
                ...(k.key_name ? { keyName: k.key_name } : {}),
                ...(k.key_id !== undefined ? { keyId: k.key_id } : {}),
                ...(k.standard_key !== undefined ? { standardKey: k.standard_key } : {}),
                ...(learningCode ? { learningCode } : {}),
              };
            });
            const seenKeys = new Set(mergedKeys.map((k) => k.key.toLowerCase()));
            const seenIds = new Set(
              mergedKeys.filter((k) => k.keyId !== undefined).map((k) => k.keyId!),
            );
            for (const lc of learnedList) {
              const lcId = lc.id ?? lc.learn_id;
              if (
                seenKeys.has(lc.key.toLowerCase()) ||
                (lcId !== undefined && seenIds.has(lcId))
              ) {
                continue;
              }
              seenKeys.add(lc.key.toLowerCase());
              if (lcId !== undefined) seenIds.add(lcId);
              mergedKeys.push({
                key: lc.key,
                ...(lc.key_name ? { keyName: lc.key_name } : {}),
                ...(lcId !== undefined ? { keyId: lcId } : {}),
                standardKey: false,
                learningCode: lc.code,
              });
            }
            const irMeta: TuyaIrRemoteMeta = {
              hubId: hub.id,
              remoteId: remote.remote_id,
              categoryId: keysRes?.category_id ?? remote.category_id,
              ...(keysRes?.remote_index !== undefined || remote.remote_index !== undefined
                ? { remoteIndex: keysRes?.remote_index ?? remote.remote_index }
                : {}),
              ...(remote.brand_name ? { brandName: remote.brand_name } : {}),
              ...(keysRes?.duplicate_power !== undefined ? { duplicatePower: keysRes.duplicate_power } : {}),
              ...(keysRes?.single_air !== undefined ? { singleAir: keysRes.single_air } : {}),
              keys: mergedKeys,
            };
            target.irRemote = irMeta;

            if (target.category.toLowerCase() === "infrared_ac") {
              try {
                const acStatus = await client.getInfraredAcStatus(hub.id, remote.remote_id);
                if (Object.keys(acStatus).length > 0) {
                  target.status = { ...target.status, ...acStatus };
                }
              } catch {
                // ac/status is best-effort
              }
            }
          } catch (err) {
            if (!this._lastIrOpenApiError) {
              this._lastIrOpenApiError = formatIrOpenApiErrorZh(err, (e) => this._sanitizeErrorText(e));
            }
          }
        });
      }),
    );
  }

  private _canUseOpenApiIr(): boolean {
    return Boolean(
      this._openApiClient &&
        (this._config.mode === "openapi" || this._config.mode === "hybrid"),
    );
  }

  private _resolveIrActionBinding(
    profile: TuyaDeviceProfile,
    name: string,
  ): TuyaIrActionBinding | null {
    if (profile.irActionsByName.size === 0) return null;
    const trimmed = name.trim();
    if (!trimmed) return null;

    const exact = profile.irActionsByName.get(trimmed);
    if (exact) return exact;

    const norm = normalizeIrActionToken(trimmed);
    for (const binding of profile.irActionsByName.values()) {
      if (
        normalizeIrActionToken(binding.actionName) === norm ||
        normalizeIrActionToken(binding.desc) === norm
      ) {
        return binding;
      }
    }

    // 别名匹配（兼容音量加/减、上下曲、开关机等中英文表达）
    for (const [canonical, aliases] of Object.entries(IR_ACTION_ALIASES)) {
      if (aliases.some((alias) => normalizeIrActionToken(alias) === norm)) {
        for (const binding of profile.irActionsByName.values()) {
          const bNorm = normalizeIrActionToken(binding.actionName);
          if (
            bNorm === canonical ||
            aliases.some((alias) => normalizeIrActionToken(alias) === bNorm)
          ) {
            return binding;
          }
        }
      }
    }

    // 子串回退匹配
    for (const binding of profile.irActionsByName.values()) {
      const bDesc = normalizeIrActionToken(binding.desc);
      if (bDesc.length >= 2 && (bDesc.includes(norm) || norm.includes(bDesc))) {
        return binding;
      }
    }
    return null;
  }

  private async _dispatchOpenApiIrKey(
    client: TuyaOpenApiClient,
    action: TuyaIrActionBinding,
  ): Promise<boolean> {
    const hubId = action.hubId!;
    const remoteId = action.remoteId!;
    const categoryId = action.categoryId!;

    const tryStandardV2 = async (): Promise<boolean> =>
      await client.sendInfraredStandardCommand(hubId, remoteId, {
        category_id: categoryId,
        ...(action.remoteIndex !== undefined && action.remoteIndex > 0
          ? { remote_index: action.remoteIndex }
          : {}),
        key: action.dpCode,
      });

    const tryRawV2 = async (): Promise<boolean> =>
      await client.sendInfraredRawCommand(hubId, remoteId, {
        category_id: categoryId,
        key: action.dpCode,
        ...(action.keyId !== undefined ? { key_id: action.keyId } : {}),
      });

    const tryStandardV1 = async (): Promise<boolean> =>
      await client.sendInfraredV1StandardCommand(hubId, remoteId, action.dpCode);

    // 涂鸦 IR Control Hub 标准遥控器协议：
    // - standard_key=true 优先走「标准命令下发」/v2.0/infrareds/{hub}/remotes/{remote}/command，失败时按配对规则 /raw/command 与 v1.0 /command 兜底
    // - standard_key=false（配对规则/扩展按键）优先走「按键命令下发」/v2.0/infrareds/{hub}/remotes/{remote}/raw/command，失败时尝试标准接口兜底
    const chain: Array<() => Promise<boolean>> =
      action.standardKey === true
        ? [
            tryStandardV2,
            ...(action.keyId !== undefined ? [tryRawV2] : []),
            tryStandardV1,
          ]
        : [
            tryRawV2,
            tryStandardV2,
            tryStandardV1,
          ];

    let lastErr: unknown = null;
    for (let i = 0; i < chain.length; i += 1) {
      const attempt = chain[i]!;
      try {
        const ok = await attempt();
        if (ok) return true;
        if (i === chain.length - 1) return false;
      } catch (err) {
        lastErr = err;
        if (!isRecoverableIrProtocolError(err) || i === chain.length - 1) {
          throw err;
        }
      }
    }
    if (lastErr) throw lastErr;
    return false;
  }

  private async _sendIrAction(
    profile: TuyaDeviceProfile,
    action: TuyaIrActionBinding,
  ): Promise<void> {
    if (this._canUseOpenApiIr() && this._openApiClient && action.hubId && action.remoteId) {
      try {
        if (action.learningCode) {
          const ok = await this._openApiClient.sendInfraredLearningCode(
            action.hubId,
            action.remoteId,
            action.learningCode,
          );
          if (!ok) {
            throw new ServiceError(`涂鸦 OpenAPI 拒绝了红外学习按键「${action.desc}」`);
          }
        } else if (action.categoryId !== undefined) {
          const ok = await this._dispatchOpenApiIrKey(this._openApiClient, action);
          if (!ok) {
            throw new ServiceError(`涂鸦 OpenAPI 拒绝了红外按键「${action.desc}」`);
          }
        } else {
          await this._sendHardwareCommand(profile.hardwareId, action.dpCode, action.sendValue);
        }
      } catch (err) {
        throw this._wrapError(err, `发送涂鸦红外按键「${action.desc}」失败`);
      }
    } else {
      await this._sendHardwareCommand(profile.hardwareId, action.dpCode, action.sendValue);
    }

    // 同步单向红外电源状态
    if (profile.irPower) {
      const record = this._records.get(profile.hardwareId);
      if (profile.irPower.onAction?.actionName === action.actionName) {
        profile.irPower.assumedState = true;
        if (record && profile.irPower.statusDpCode) {
          record.status[profile.irPower.statusDpCode] = true;
        }
      } else if (profile.irPower.offAction?.actionName === action.actionName) {
        profile.irPower.assumedState = false;
        if (record && profile.irPower.statusDpCode) {
          record.status[profile.irPower.statusDpCode] = false;
        }
      } else if (profile.irPower.toggleAction?.actionName === action.actionName) {
        const next = profile.irPower.assumedState === true ? false : true;
        profile.irPower.assumedState = next;
        if (record && profile.irPower.statusDpCode) {
          record.status[profile.irPower.statusDpCode] = next;
        }
      }
    }
  }

  private async _ensureProfile(nativeDid: string): Promise<TuyaDeviceProfile> {
    let profile = this._profiles.get(nativeDid);
    if (!profile) {
      await this.listDevices();
      profile = this._profiles.get(nativeDid);
    }
    if (!profile) {
      throw new ServiceError(`未找到涂鸦设备: ${nativeDid}`);
    }
    return profile;
  }

  private async _fetchHardwareStatus(hardwareId: string): Promise<Record<string, unknown>> {
    const record = this._records.get(hardwareId);
    const localEntry = this._localEntryById(hardwareId);
    const isVirtualIr = Boolean(record && (record.sub || isTuyaInfraredCategory(record.category)));
    const shouldTryLocal =
      !isVirtualIr &&
      Boolean(localEntry && localEntry.ip && localEntry.localKey) &&
      (this._config.mode === "local" ||
        (this._config.mode === "hybrid" && this._config.preferLocal));

    if (shouldTryLocal && localEntry) {
      try {
        const rawDps = await this._localTransport.queryDps(localEntry, { timeoutMs: 3500 });
        const dpIdToCode = record?.dpIdToCode ?? localEntry.dpsMap ?? {};
        const merged: Record<string, unknown> = { ...(record?.status ?? {}) };
        for (const [dpId, val] of Object.entries(rawDps)) {
          const code = dpIdToCode[dpId] ?? dpId;
          merged[code] = val;
        }
        if (record) {
          record.status = merged;
          record.online = true;
        }
        return merged;
      } catch (err) {
        if (this._config.mode === "local") {
          throw this._wrapError(err, `读取局域网涂鸦设备 ${hardwareId} 状态失败`);
        }
        // hybrid 模式下局域网不可达时自动回退云端
      }
    }

    // 红外空调若已具备 OpenAPI IR Control Hub 通道（openapi 或 hybrid），优先拉取 /ac/status 精确状态
    if (
      this._canUseOpenApiIr() &&
      this._openApiClient &&
      record &&
      record.category.toLowerCase() === "infrared_ac" &&
      record.irRemote?.hubId &&
      record.irRemote?.remoteId
    ) {
      try {
        const acStatus = await this._openApiClient.getInfraredAcStatus(
          record.irRemote.hubId,
          record.irRemote.remoteId,
        );
        if (acStatus && Object.keys(acStatus).length > 0) {
          const fresh: Record<string, unknown> = { ...record.status };
          if (acStatus.power !== undefined) {
            fresh.power = String(acStatus.power) === "1" || String(acStatus.power) === "true";
          }
          if (acStatus.mode !== undefined && Number.isFinite(Number(acStatus.mode))) {
            fresh.mode = Number(acStatus.mode);
          }
          if (acStatus.temp !== undefined && Number.isFinite(Number(acStatus.temp))) {
            fresh.temp = Number(acStatus.temp);
          }
          if (acStatus.wind !== undefined && Number.isFinite(Number(acStatus.wind))) {
            fresh.wind = Number(acStatus.wind);
          }
          record.status = fresh;
          return fresh;
        }
      } catch {
        // fall through to sharing / generic status
      }
    }

    // 云端状态拉取
    if (this._hasSharingCredentials() && (this._config.mode === "sharing" || this._config.mode === "hybrid")) {
      try {
        const details = await this._sharingClient.queryDeviceDetail([hardwareId]);
        const matched = details.find((d) => d.id === hardwareId) ?? details[0];
        if (matched && Array.isArray(matched.status)) {
          const fresh = { ...(record?.status ?? {}), ...statusArrayToRecord(matched.status) };
          if (record) {
            record.status = fresh;
            if (typeof matched.online === "boolean") {
              record.online = matched.online;
            }
          }
          return fresh;
        }
      } catch {
        // 若 detail 接口暂不可用，回退到最近一次同步的缓存状态
      }
      return { ...(record?.status ?? {}) };
    }

    if (this._openApiClient && (this._config.mode === "openapi" || this._config.mode === "hybrid")) {
      if (
        record &&
        record.category.toLowerCase() === "infrared_ac" &&
        record.irRemote?.hubId &&
        record.irRemote?.remoteId
      ) {
        try {
          const acStatus = await this._openApiClient.getInfraredAcStatus(
            record.irRemote.hubId,
            record.irRemote.remoteId,
          );
          if (acStatus) {
            const fresh: Record<string, unknown> = { ...record.status };
            if (acStatus.power !== undefined) {
              fresh.power = String(acStatus.power) === "1" || String(acStatus.power) === "true";
            }
            if (acStatus.mode !== undefined && Number.isFinite(Number(acStatus.mode))) {
              fresh.mode = Number(acStatus.mode);
            }
            if (acStatus.temp !== undefined && Number.isFinite(Number(acStatus.temp))) {
              fresh.temp = Number(acStatus.temp);
            }
            if (acStatus.wind !== undefined && Number.isFinite(Number(acStatus.wind))) {
              fresh.wind = Number(acStatus.wind);
            }
            record.status = fresh;
            return fresh;
          }
        } catch {
          // fall back to generic getDeviceStatus below
        }
      }
      try {
        const items = await this._openApiClient.getDeviceStatus(hardwareId);
        const fresh = { ...(record?.status ?? {}), ...statusArrayToRecord(items) };
        if (record) {
          record.status = fresh;
        }
        return fresh;
      } catch (err) {
        if (record && Object.keys(record.status).length > 0) {
          return { ...record.status };
        }
        throw this._wrapError(err, `读取涂鸦设备 ${hardwareId} 状态失败`);
      }
    }

    return { ...(record?.status ?? {}) };
  }

  private async _sendHardwareCommand(
    hardwareId: string,
    dpCode: string,
    tuyaValue: unknown,
  ): Promise<void> {
    const record = this._records.get(hardwareId);
    const localEntry = this._localEntryById(hardwareId);
    const isVirtualIr = Boolean(record && (record.sub || isTuyaInfraredCategory(record.category)));
    const shouldTryLocal =
      !isVirtualIr &&
      Boolean(localEntry && localEntry.ip && localEntry.localKey) &&
      (this._config.mode === "local" ||
        (this._config.mode === "hybrid" && this._config.preferLocal));

    if (shouldTryLocal && localEntry) {
      const dpId =
        record?.codeToDpId?.[dpCode] ??
        Object.entries(localEntry.dpsMap ?? {}).find(([, code]) => code === dpCode)?.[0] ??
        (/^[0-9]+$/.test(dpCode) ? dpCode : undefined);

      if (dpId) {
        try {
          await this._localTransport.setDps(localEntry, { [dpId]: tuyaValue }, { timeoutMs: 4000 });
          if (record) {
            record.status[dpCode] = tuyaValue;
            record.online = true;
          }
          return;
        } catch (err) {
          if (this._config.mode === "local") {
            throw this._wrapError(err, `局域网控制涂鸦设备 ${hardwareId} 失败`);
          }
          // hybrid 模式下局域网发送失败自动回退云端
        }
      } else if (this._config.mode === "local") {
        throw new ServiceError(`局域网设备 ${hardwareId} 缺少 DP「${dpCode}」对应的数字编号映射`);
      }
    }

    // 云端命令下发
    if (this._hasSharingCredentials() && (this._config.mode === "sharing" || this._config.mode === "hybrid")) {
      try {
        const ok = await this._sharingClient.sendCommands(hardwareId, [
          { code: dpCode, value: tuyaValue },
        ]);
        if (!ok) {
          throw new ServiceError(`涂鸦云端拒绝了属性 ${dpCode} 的控制指令`);
        }
        if (record) {
          record.status[dpCode] = tuyaValue;
        }
        return;
      } catch (err) {
        throw this._wrapError(err, `控制涂鸦设备 ${hardwareId} 失败`);
      }
    }

    if (this._openApiClient && (this._config.mode === "openapi" || this._config.mode === "hybrid")) {
      try {
        const ok = await this._openApiClient.sendDeviceCommands(hardwareId, [
          { code: dpCode, value: tuyaValue },
        ]);
        if (!ok) {
          throw new ServiceError(`涂鸦 OpenAPI 拒绝了属性 ${dpCode} 的控制指令`);
        }
        if (record) {
          record.status[dpCode] = tuyaValue;
        }
        return;
      } catch (err) {
        throw this._wrapError(err, `通过 OpenAPI 控制涂鸦设备 ${hardwareId} 失败`);
      }
    }

    throw new ServiceError("涂鸦平台尚未连接可用的云端或局域网通道");
  }

  // ---------- 设备详情与属性读写 ----------

  private _resolveIrControlWarning(profile: TuyaDeviceProfile): string | null {
    if (!profile.isInfraredRemote || profile.irControlMode !== "sharing-limited") {
      return null;
    }
    if (this._lastIrOpenApiError) {
      return `涂鸦 OpenAPI 红外控制不可用（${this._lastIrOpenApiError}）；当前回退为扫码共享接口，非空调红外按键可能无法真实发射。`;
    }
    return "当前为涂鸦扫码共享模式，非空调红外遥控器（如音响/电视/DIY遥控）的按键无法通过共享接口可靠触发。请在「设置 → 多平台接入 → 涂鸦智能」切换为「云端+局域网混合」模式，保留扫码登录并补充 OpenAPI 凭据（需在涂鸦云项目开通 IR Control Hub 万能红外开放能力），以启用标准遥控器协议真实发射红外码。";
  }

  async deviceDetail(nativeDid: string): Promise<DeviceDetail> {
    const profile = await this._ensureProfile(nativeDid);
    const controlWarning = this._resolveIrControlWarning(profile);
    return {
      ...profile.detail,
      props: profile.detail.props.map((p) => ({ ...p })),
      actions: profile.detail.actions.map((a) => ({ ...a })),
      ...(controlWarning ? { control_warning: controlWarning } : {}),
    };
  }

  private _readBindingValue(
    profile: TuyaDeviceProfile,
    binding: TuyaPropBinding,
    status: Record<string, unknown>,
  ): unknown {
    if (binding.kind === "ir-power") {
      if (binding.statusDpCode && status[binding.statusDpCode] !== undefined && status[binding.statusDpCode] !== null) {
        return Boolean(status[binding.statusDpCode]);
      }
      return profile.irPower?.assumedState ?? null;
    }
    const readCode = binding.statusDpCode ?? binding.dpCode;
    const raw = readCode in status ? status[readCode] : status[binding.dpCode];
    return tuyaRawValueToMijiaProp(binding, raw);
  }

  private _hasReadableStatus(profile: TuyaDeviceProfile): boolean {
    if (!profile.isInfraredRemote) return true;
    return profile.detail.props.some((p) => p.readable);
  }

  async readProp(nativeDid: string, name: string): Promise<unknown> {
    const profile = await this._ensureProfile(nativeDid);
    const binding =
      profile.bindingsByPropName.get(name) ?? profile.bindingsByDpCode.get(name);
    const status = this._hasReadableStatus(profile)
      ? await this._fetchHardwareStatus(profile.hardwareId)
      : { ...(this._records.get(profile.hardwareId)?.status ?? {}) };
    if (!binding) {
      return name in status ? status[name] : null;
    }
    return this._readBindingValue(profile, binding, status);
  }

  async readProps(nativeDid: string, names: string[]): Promise<Record<string, unknown>> {
    const profile = await this._ensureProfile(nativeDid);
    const status = this._hasReadableStatus(profile)
      ? await this._fetchHardwareStatus(profile.hardwareId)
      : { ...(this._records.get(profile.hardwareId)?.status ?? {}) };
    const out: Record<string, unknown> = {};
    for (const name of names) {
      const binding =
        profile.bindingsByPropName.get(name) ?? profile.bindingsByDpCode.get(name);
      if (binding) {
        out[name] = this._readBindingValue(profile, binding, status);
      } else {
        out[name] = name in status ? status[name] : null;
      }
    }
    return out;
  }

  async writeProp(nativeDid: string, name: string, value: unknown): Promise<void> {
    this._requireControlAccess();
    const profile = await this._ensureProfile(nativeDid);
    if (profile.isSplitParent && name === "on") {
      throw new ServiceError("面板本体仅展示信息，请操作对应开关通道");
    }
    const binding =
      profile.bindingsByPropName.get(name) ?? profile.bindingsByDpCode.get(name);
    if (!binding) {
      throw new ServiceError(`涂鸦设备 ${profile.info.name} 不支持属性「${name}」`);
    }
    if (!binding.writable) {
      throw new ServiceError(`涂鸦设备属性「${name}」为只读状态，不可写入`);
    }
    let tuyaValue: unknown;
    try {
      tuyaValue = mijiaPropValueToTuyaRaw(binding, value);
    } catch (err) {
      throw this._wrapError(err, `属性 ${name} 参数无效`);
    }

    if (binding.kind === "ir-power") {
      await this.setPowerState(nativeDid, Boolean(tuyaValue));
      return;
    }

    const record = this._records.get(profile.hardwareId);
    const isIrAc = record?.category.toLowerCase() === "infrared_ac";
    if (
      isIrAc &&
      this._canUseOpenApiIr() &&
      this._openApiClient &&
      profile.irRemote?.hubId &&
      profile.irRemote?.remoteId
    ) {
      const curMode = Number(record?.status.mode ?? record?.status.M ?? 0);
      const curTemp = Number(record?.status.temp ?? record?.status.T ?? 24);
      const curWind = Number(record?.status.wind ?? record?.status.F ?? 0);
      const payload = {
        power: 1,
        mode: binding.dpCode === "M" ? Number(tuyaValue) : Number.isFinite(curMode) ? curMode : 0,
        temp: binding.dpCode === "T" ? Number(tuyaValue) : Number.isFinite(curTemp) ? curTemp : 24,
        wind: binding.dpCode === "F" ? Number(tuyaValue) : Number.isFinite(curWind) ? curWind : 0,
      };
      try {
        const ok = await this._openApiClient.sendInfraredAcCommand(
          profile.irRemote.hubId,
          profile.irRemote.remoteId,
          payload,
        );
        if (!ok) {
          throw new ServiceError(`涂鸦 OpenAPI 拒绝了红外空调属性 ${name} 的控制指令`);
        }
      } catch (err) {
        throw this._wrapError(err, `控制涂鸦红外空调 ${profile.info.name} 失败`);
      }
    } else {
      await this._sendHardwareCommand(profile.hardwareId, binding.dpCode, tuyaValue);
    }

    if (record && binding.statusDpCode) {
      record.status[binding.statusDpCode] = tuyaValue;
    }
    if (isIrAc && profile.irPower) {
      // 涂鸦红外空调写入模式/温度/风速会携带开机状态发射完整红外帧
      profile.irPower.assumedState = true;
      if (record && profile.irPower.statusDpCode) {
        record.status[profile.irPower.statusDpCode] = true;
      }
    }
  }

  async runAction(nativeDid: string, name: string, params?: unknown): Promise<void> {
    this._requireControlAccess();
    const profile = await this._ensureProfile(nativeDid);

    const irAction = this._resolveIrActionBinding(profile, name);
    if (irAction) {
      const repeatCount = parseIrRepeatCount(params);
      for (let i = 0; i < repeatCount; i += 1) {
        if (i > 0) {
          await new Promise((resolve) => setTimeout(resolve, IR_REPEAT_DELAY_MS));
        }
        await this._sendIrAction(profile, irAction);
      }
      return;
    }

    const binding =
      profile.bindingsByPropName.get(name) ?? profile.bindingsByDpCode.get(name);
    if (binding && binding.writable) {
      const val = params !== undefined ? params : binding.kind === "bool" || binding.kind === "power" ? true : 1;
      await this.writeProp(nativeDid, name, val);
      return;
    }
    throw new ServiceError(`涂鸦设备 ${profile.info.name} 不支持动作「${name}」`);
  }

  // ---------- 电源快捷控制与批量指标 ----------

  async powerState(nativeDid: string): Promise<boolean | null> {
    const states = await this.powerStates([nativeDid]);
    return states[nativeDid] ?? null;
  }

  async setPowerState(nativeDid: string, state: boolean): Promise<void> {
    this._requireControlAccess();
    const profile = await this._ensureProfile(nativeDid);
    if (profile.isSplitParent) {
      throw new ServiceError("面板本体仅展示信息，请操作对应开关通道");
    }
    if (profile.irPower) {
      const record = this._records.get(profile.hardwareId);
      const isIrAc = record?.category.toLowerCase() === "infrared_ac";
      if (
        isIrAc &&
        this._canUseOpenApiIr() &&
        this._openApiClient &&
        profile.irRemote?.hubId &&
        profile.irRemote?.remoteId
      ) {
        const payload = state
          ? {
              power: 1,
              mode: Number.isFinite(Number(record?.status.mode ?? record?.status.M))
                ? Number(record?.status.mode ?? record?.status.M)
                : 0,
              temp: Number.isFinite(Number(record?.status.temp ?? record?.status.T))
                ? Number(record?.status.temp ?? record?.status.T)
                : 24,
              wind: Number.isFinite(Number(record?.status.wind ?? record?.status.F))
                ? Number(record?.status.wind ?? record?.status.F)
                : 0,
            }
          : { power: 0 };
        try {
          const ok = await this._openApiClient.sendInfraredAcCommand(
            profile.irRemote.hubId,
            profile.irRemote.remoteId,
            payload,
          );
          if (!ok) {
            throw new ServiceError(`涂鸦 OpenAPI 拒绝了红外空调开关指令`);
          }
          profile.irPower.assumedState = state;
          if (record && profile.irPower.statusDpCode) {
            record.status[profile.irPower.statusDpCode] = state;
          }
          return;
        } catch (err) {
          throw this._wrapError(err, `控制涂鸦红外空调 ${profile.info.name} 开关失败`);
        }
      }

      const action = state
        ? (profile.irPower.onAction ?? profile.irPower.toggleAction)
        : (profile.irPower.offAction ?? profile.irPower.toggleAction);
      if (!action) {
        throw new ServiceError(`涂鸦红外设备「${profile.info.name}」缺少对应的${state ? "开机" : "关机"}按键`);
      }
      await this._sendIrAction(profile, action);
      profile.irPower.assumedState = state;
      if (record && profile.irPower.statusDpCode) {
        record.status[profile.irPower.statusDpCode] = state;
      }
      return;
    }
    if (!profile.powerDpCode) {
      throw new ServiceError("该涂鸦设备不支持快捷电源控制");
    }
    await this._sendHardwareCommand(profile.hardwareId, profile.powerDpCode, state);
  }

  async togglePower(nativeDid: string): Promise<boolean> {
    this._requireControlAccess();
    const profile = await this._ensureProfile(nativeDid);
    if (profile.irPower) {
      const current = await this.powerState(nativeDid);
      const next = current === true ? false : true;
      await this.setPowerState(nativeDid, next);
      return next;
    }
    const current = await this.powerState(nativeDid);
    if (current === null) {
      throw new ServiceError("设备不支持开关控制或已离线");
    }
    const next = !current;
    await this.setPowerState(nativeDid, next);
    return next;
  }

  async powerStates(nativeDids: string[]): Promise<Record<string, boolean | null>> {
    if (nativeDids.length === 0) return {};
    if (this._profiles.size === 0 && this._config.enabled) {
      await this.listDevices();
    }

    const hwIds = new Set<string>();
    for (const did of nativeDids) {
      const profile = this._profiles.get(did);
      if (profile && !profile.isSplitParent) {
        if (profile.powerDpCode) {
          hwIds.add(profile.hardwareId);
        } else if (profile.irPower?.statusDpCode) {
          hwIds.add(profile.hardwareId);
        }
      } else if (!profile) {
        hwIds.add(parseTuyaSplitDid(did).hardwareId);
      }
    }

    const statusByHw = new Map<string, Record<string, unknown>>();
    await Promise.all(
      [...hwIds].map(async (hwId) => {
        try {
          statusByHw.set(hwId, await this._fetchHardwareStatus(hwId));
        } catch {
          const cached = this._records.get(hwId)?.status;
          if (cached) statusByHw.set(hwId, cached);
        }
      }),
    );

    const out: Record<string, boolean | null> = {};
    for (const did of nativeDids) {
      const profile = this._profiles.get(did);
      if (!profile || profile.isSplitParent) {
        out[did] = null;
        continue;
      }
      if (profile.irPower) {
        const statusCode = profile.irPower.statusDpCode;
        const status = statusCode ? statusByHw.get(profile.hardwareId) : undefined;
        if (status && statusCode && typeof status[statusCode] === "boolean") {
          out[did] = status[statusCode] as boolean;
        } else {
          out[did] = profile.irPower.assumedState;
        }
        continue;
      }
      if (!profile.powerDpCode) {
        out[did] = null;
        continue;
      }
      const status = statusByHw.get(profile.hardwareId);
      if (!status || status[profile.powerDpCode] === undefined || status[profile.powerDpCode] === null) {
        out[did] = null;
        continue;
      }
      out[did] = Boolean(status[profile.powerDpCode]);
    }
    return out;
  }

  async readMetrics(nativeDids: string[]): Promise<Record<string, string | null>> {
    if (nativeDids.length === 0) return {};
    if (this._profiles.size === 0 && this._config.enabled) {
      await this.listDevices();
    }

    const hwIds = new Set<string>();
    for (const did of nativeDids) {
      const profile = this._profiles.get(did);
      if (profile && (profile.info.metric_features?.length ?? 0) > 0) {
        hwIds.add(profile.hardwareId);
      }
    }

    const statusByHw = new Map<string, Record<string, unknown>>();
    await Promise.all(
      [...hwIds].map(async (hwId) => {
        try {
          statusByHw.set(hwId, await this._fetchHardwareStatus(hwId));
        } catch {
          const cached = this._records.get(hwId)?.status;
          if (cached) statusByHw.set(hwId, cached);
        }
      }),
    );

    const out: Record<string, string | null> = {};
    for (const did of nativeDids) {
      const profile = this._profiles.get(did);
      if (!profile) {
        out[did] = null;
        continue;
      }
      const status = statusByHw.get(profile.hardwareId) ?? this._records.get(profile.hardwareId)?.status;
      out[did] = status ? formatTuyaDeviceMetrics(profile, status) : null;
    }
    return out;
  }

  // ---------- 场景联动 ----------

  async sceneList(homeName?: string | null): Promise<SceneInfo[]> {
    if (!this._config.enabled) return [];

    const scenes: SceneInfo[] = [];
    const targetHome = homeName?.trim() || "";

    if (
      (this._config.mode === "sharing" || this._config.mode === "hybrid") &&
      this._hasSharingCredentials()
    ) {
      try {
        const homes = await this._sharingClient.queryHomes();
        const filteredHomes = targetHome
          ? homes.filter((h) => h.name === targetHome)
          : homes;
        const lists = await Promise.all(
          filteredHomes.map(async (home) => {
            const list = await this._sharingClient.queryScenes(home.ownerId);
            return { home, list };
          }),
        );
        for (const { home, list } of lists) {
          for (const sc of list) {
            const sid = sc.scene_id || sc.id || "";
            if (!sid) continue;
            scenes.push(
              createSceneInfo({
                scene_id: sid,
                name: sc.name || sid,
                home_id: sc.home_id || sc.ownerId || home.ownerId,
                home_name: home.name,
                platform: "tuya",
              }),
            );
          }
        }
      } catch (err) {
        throw this._wrapError(err, "获取涂鸦场景列表失败");
      }
    } else if (
      (this._config.mode === "openapi" || this._config.mode === "hybrid") &&
      this._openApiClient
    ) {
      try {
        const token = await this._openApiClient.getAccessToken();
        const uid = this._config.uid || token.uid;
        if (uid) {
          const homes = await this._openApiClient.listHomes(uid);
          const filteredHomes = targetHome
            ? homes.filter((h) => h.name === targetHome)
            : homes;
          const lists = await Promise.all(
            filteredHomes.map(async (home) => {
              const list = await this._openApiClient!.listHomeScenes(home.home_id);
              return { home, list };
            }),
          );
          for (const { home, list } of lists) {
            for (const sc of list) {
              scenes.push(
                createSceneInfo({
                  scene_id: sc.scene_id,
                  name: sc.name || sc.scene_id,
                  home_id: sc.home_id || home.home_id,
                  home_name: home.name,
                  platform: "tuya",
                }),
              );
            }
          }
        }
      } catch (err) {
        throw this._wrapError(err, "获取涂鸦 OpenAPI 场景列表失败");
      }
    }

    this._lastSceneCount = scenes.length;
    return scenes.sort(
      (a, b) => compareStr(a.home_name, b.home_name) || compareStr(a.name, b.name),
    );
  }

  async runScene(scene: SceneInfo): Promise<void> {
    this._requireControlAccess();
    if (!scene.scene_id) {
      throw new ServiceError("缺少涂鸦场景 ID");
    }
    if (!scene.home_id) {
      throw new ServiceError("缺少涂鸦场景所属家庭 ID");
    }

    if (
      (this._config.mode === "sharing" || this._config.mode === "hybrid") &&
      this._hasSharingCredentials()
    ) {
      try {
        const ok = await this._sharingClient.triggerScene(scene.home_id, scene.scene_id);
        if (!ok) {
          throw new ServiceError(`执行涂鸦场景「${scene.name}」被云端拒绝`);
        }
        return;
      } catch (err) {
        throw this._wrapError(err, `执行涂鸦场景「${scene.name}」失败`);
      }
    }

    if (
      (this._config.mode === "openapi" || this._config.mode === "hybrid") &&
      this._openApiClient
    ) {
      try {
        const ok = await this._openApiClient.triggerScene(scene.home_id, scene.scene_id);
        if (!ok) {
          throw new ServiceError(`执行涂鸦 OpenAPI 场景「${scene.name}」被拒绝`);
        }
        return;
      } catch (err) {
        throw this._wrapError(err, `执行涂鸦 OpenAPI 场景「${scene.name}」失败`);
      }
    }

    throw new ServiceError("纯局域网模式不支持执行云端场景联动");
  }

  // ---------- 诊断报告 ----------

  async diagnosticReport(
    device: DeviceInfo,
    observation?: Record<string, unknown> | null,
  ): Promise<string> {
    const { hardwareId } = parseTuyaSplitDid(device.did);
    const record = this._records.get(hardwareId);
    const profile = this._profiles.get(device.did);
    const report = {
      platform: "tuya",
      mode: this._config.mode,
      device: {
        did: device.did,
        name: device.name,
        model: device.model,
        home_name: device.home_name,
        room_name: device.room_name,
        spec_type: device.spec_type,
        online: device.online,
        light_features: device.light_features,
        metric_features: device.metric_features,
        switch_channels: device.switch_channels,
      },
      tuya: {
        category: record?.category ?? "",
        source: record?.source ?? "",
        hasLocalMapping: Boolean(this._localEntryById(hardwareId)),
        isInfraredRemote: Boolean(profile?.isInfraredRemote),
        irControlMode: profile?.irControlMode ?? null,
        hasIrPower: Boolean(profile?.irPower),
        irHubId: profile?.irRemote?.hubId ?? null,
        irCategoryId: profile?.irRemote?.categoryId ?? null,
        irRemoteIndex: profile?.irRemote?.remoteIndex ?? null,
        irStandardKeyCount: profile
          ? [...profile.irActionsByName.values()].filter((a) => a.standardKey === true).length
          : 0,
        irNonStandardKeyCount: profile
          ? [...profile.irActionsByName.values()].filter((a) => a.standardKey === false && !a.learningCode).length
          : 0,
        irLearnedKeyCount: profile
          ? [...profile.irActionsByName.values()].filter((a) => Boolean(a.learningCode)).length
          : 0,
        irOpenApiError: this._lastIrOpenApiError,
        irActionCodes: profile ? [...profile.irActionsByName.keys()] : [],
        dpCodes: Object.keys(record?.status ?? {}),
        propNames: profile?.detail.props.map((p) => p.name) ?? [],
      },
      configSummary: summarizeTuyaConfig(this._config),
      observation: observation ? redactSecrets(observation) : null,
    };
    return JSON.stringify(report, null, 2);
  }
}
