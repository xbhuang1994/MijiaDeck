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
} from "./mapper.ts";
import { TuyaOpenApiClient, type TuyaOpenApiDevice } from "./openApiClient.ts";
import {
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
    return new TuyaSharingClient({
      clientId: this._config.clientId || TUYA_CLIENT_ID,
      schema: this._config.schema || TUYA_SCHEMA,
      authEndpoint: this._config.endpoint || TUYA_SHARING_AUTH_ENDPOINT,
      tokenSession: this._config.tokenSession ?? null,
      httpFetch: this._httpFetch,
      now: this._now,
      onTokenUpdate: (session: TuyaTokenSession) => {
        this._config = {
          ...this._config,
          tokenSession: { ...session },
          endpoint: session.endpoint || this._config.endpoint,
        };
        this._configStore.save(this._config);
      },
    });
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

  private _rebuildClients(): void {
    this._sharingClient = this._buildSharingClient();
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
    return Boolean(this._config.tokenSession?.accessToken);
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
    if (clearSecrets || raw.tokenSession === null) {
      nextTokenSession = null;
    } else if (isRecord(raw.tokenSession) && typeof raw.tokenSession.accessToken === "string") {
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

    this._config = this._configStore.save(updated);
    this._rebuildClients();
    this._records.clear();
    this._profiles.clear();
    this._lastError = null;
    this._openApiVerified = false;

    // 若启用了 OpenAPI 且已提供 Access ID / Secret，主动校验并换取 Token
    if (
      raw.verify !== false &&
      this._config.enabled &&
      (this._config.mode === "openapi" ||
        (this._config.mode === "hybrid" && !this._hasSharingCredentials())) &&
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
        this._lastError = this._sanitizeErrorText(err);
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
      this._config = this._configStore.save({
        ...this._config,
        userCode,
        clientId,
        schema,
        endpoint,
      });
      this._rebuildClients();
    }

    let qr: { token: string; qrContent: string };
    try {
      qr = await this._sharingClient.requestQrCode(userCode, clientId, schema);
    } catch (err) {
      const msg = this._sanitizeErrorText(err);
      this._lastError = msg;
      throw new ServiceError(`获取涂鸦登录二维码失败: ${msg}`);
    }

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
      this._rebuildClients();
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

        progress?.(45, `正在同步 ${rawDevices.length} 台涂鸦设备规格…`);
        const specs = await runWithConcurrency(rawDevices, SPEC_CONCURRENCY, async ({ dev }) => {
          const cached = this._specCache.get(dev.id);
          if (cached) return cached;
          try {
            const spec = await this._sharingClient.queryDeviceSpec(dev.id);
            this._specCache.set(dev.id, spec);
            return spec;
          } catch {
            return null;
          }
        });

        for (let i = 0; i < rawDevices.length; i += 1) {
          const { homeName, dev } = rawDevices[i]!;
          const spec = specs[i] ?? null;
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
            roomName: dev.roomName || dev.room_name || localEntry?.room || "默认房间",
            online: Boolean(dev.online),
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
        let defaultHomeName = "涂鸦家庭";
        try {
          const homes = await this._openApiClient.listHomes(uid);
          if (homes[0]?.name) defaultHomeName = homes[0].name;
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
          const category = dev.category || spec?.category || "";
          const { codeToDpId, dpIdToCode } = buildDpIdMaps(category, spec, localEntry);
          recordsById.set(dev.id, {
            id: dev.id,
            name: dev.name || dev.id,
            category,
            productId: dev.product_id,
            model: dev.model,
            homeName: defaultHomeName,
            roomName: localEntry?.room || "默认房间",
            online: Boolean(dev.online),
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

      for (const record of recordsById.values()) {
        const { cards, profiles } = mapTuyaDeviceToCards(record);
        allCards.push(...cards);
        for (const [did, profile] of profiles.entries()) {
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
    const shouldTryLocal =
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
    const shouldTryLocal =
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

  async deviceDetail(nativeDid: string): Promise<DeviceDetail> {
    const profile = await this._ensureProfile(nativeDid);
    return {
      ...profile.detail,
      props: profile.detail.props.map((p) => ({ ...p })),
      actions: profile.detail.actions.map((a) => ({ ...a })),
    };
  }

  async readProp(nativeDid: string, name: string): Promise<unknown> {
    const profile = await this._ensureProfile(nativeDid);
    const binding =
      profile.bindingsByPropName.get(name) ?? profile.bindingsByDpCode.get(name);
    const status = await this._fetchHardwareStatus(profile.hardwareId);
    if (!binding) {
      return name in status ? status[name] : null;
    }
    return tuyaRawValueToMijiaProp(binding, status[binding.dpCode]);
  }

  async readProps(nativeDid: string, names: string[]): Promise<Record<string, unknown>> {
    const profile = await this._ensureProfile(nativeDid);
    const status = await this._fetchHardwareStatus(profile.hardwareId);
    const out: Record<string, unknown> = {};
    for (const name of names) {
      const binding =
        profile.bindingsByPropName.get(name) ?? profile.bindingsByDpCode.get(name);
      if (binding) {
        out[name] = tuyaRawValueToMijiaProp(binding, status[binding.dpCode]);
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
    await this._sendHardwareCommand(profile.hardwareId, binding.dpCode, tuyaValue);
  }

  async runAction(nativeDid: string, name: string, params?: unknown): Promise<void> {
    this._requireControlAccess();
    const profile = await this._ensureProfile(nativeDid);
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
    if (!profile.powerDpCode) {
      throw new ServiceError("该涂鸦设备不支持快捷电源控制");
    }
    await this._sendHardwareCommand(profile.hardwareId, profile.powerDpCode, state);
  }

  async togglePower(nativeDid: string): Promise<boolean> {
    this._requireControlAccess();
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
      if (profile && !profile.isSplitParent && profile.powerDpCode) {
        hwIds.add(profile.hardwareId);
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
      if (!profile || profile.isSplitParent || !profile.powerDpCode) {
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
        dpCodes: Object.keys(record?.status ?? {}),
        propNames: profile?.detail.props.map((p) => p.name) ?? [],
      },
      configSummary: summarizeTuyaConfig(this._config),
      observation: observation ? redactSecrets(observation) : null,
    };
    return JSON.stringify(report, null, 2);
  }
}
