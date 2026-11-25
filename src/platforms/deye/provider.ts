// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 德业智能平台提供者（Deye Smart Cloud Classic/Fog/Combo + Solarman V5 本地逆变器）

import type { ProgressCallback } from "../../core/contracts.ts";
import type { DeviceDetail, DeviceInfo, SceneInfo } from "../../core/models.ts";
import { ServiceError } from "../../core/service.ts";
import {
  defaultDeyeConfig,
  loadPlatformSection,
  redactSecrets,
  savePlatformSection,
  summarizeDeyeConfig,
  type DeyePlatformConfig,
  type DeyeSolarmanInverterEntry,
} from "../configStore.ts";
import type {
  IDevicePlatformProvider,
  PlatformAuthMode,
  PlatformMetadata,
  PlatformStatus,
} from "../types.ts";
import {
  DeyeCloudApiError,
  DeyeCloudApiInvalidAuthError,
  DeyeCloudClient,
  type DeyeClassicMqttInfo,
  type DeyeCloudDeviceInfo,
} from "./cloudClient.ts";
import {
  DEYE_API_END_USER_ENDPOINT,
  DeyeDeviceTransport,
  getProductFeatureConfig,
  transportForDevice,
} from "./constants.ts";
import {
  commandToFogJsonDiff,
  encodeClassicCommand,
  fogComboFramesFromProperties,
  parseFogState,
  resolveFogCommandPayloads,
  type DeyeDeviceState,
} from "./deviceState.ts";
import {
  applyCloudPropWrite,
  buildCloudDeviceDetail,
  buildSolarmanInverterDetail,
  extractCloudPropValues,
  extractInverterPropValues,
  formatCloudDeviceMetrics,
  formatInverterMetrics,
  mapCloudDeviceToDeviceInfo,
  mapSolarmanInverterToDeviceInfo,
} from "./mapper.ts";
import {
  DeyeClassicMqttClient,
  type IDeyeClassicMqttTransport,
} from "./mqttClient.ts";
import {
  SOLARMAN_DEFAULT_PORT,
  SolarmanV5Client,
  type DeyeInverterTelemetry,
  type ISolarmanTransport,
} from "./solarmanClient.ts";

export const DEYE_PLATFORM_METADATA: PlatformMetadata = {
  id: "deye",
  name: "德业",
  displayName: "德业智能 (Deye Smart / Solarman)",
  badgeText: "德业",
  accentColor: "#0ea5e9",
  description:
    "支持德业智能云端除湿机/空净（Classic MQTT、Fog HTTP、Combo 协议）与 Solarman V5 本地光伏逆变器",
  reference: "stackia/libdeye (ha-deye-dehumidifier) & pysolarmanv5 / ha-solarman",
  capabilities: {
    cloud: true,
    local: true,
    qrAuth: false,
    credentialsAuth: true,
    openApiAuth: false,
    lanDiscovery: false,
    scenes: false,
  },
};

export interface DeyePlatformProviderOptions {
  config?: Partial<DeyePlatformConfig>;
  persistConfig?: boolean;
  httpFetch?: typeof fetch;
  mqttTransport?: IDeyeClassicMqttTransport;
  solarmanTransport?: ISolarmanTransport;
  nowMs?: () => number;
}

const MASKED_SECRET_RE = /^•+$/;
const TELEMETRY_CACHE_TTL_MS = 5_000;
const MQTT_INFO_TTL_MS = 30 * 60 * 1_000;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSecretPlaceholder(value: unknown): boolean {
  if (typeof value !== "string") {
    return true;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 || MASKED_SECRET_RE.test(trimmed);
}

function normalizeInverterEntries(raw: unknown): DeyeSolarmanInverterEntry[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const entries: DeyeSolarmanInverterEntry[] = [];
  for (const item of raw) {
    if (!isPlainRecord(item)) {
      continue;
    }
    const ip = typeof item["ip"] === "string" ? item["ip"].trim() : "";
    const serial = Number(item["serial"]);
    if (!ip || !Number.isFinite(serial) || serial <= 0) {
      continue;
    }
    const portRaw = Number(item["port"]);
    const slaveRaw = Number(item["slaveId"]);
    const id =
      typeof item["id"] === "string" && item["id"].trim()
        ? item["id"].trim()
        : `inv_${Math.trunc(serial)}`;
    const name =
      typeof item["name"] === "string" && item["name"].trim()
        ? item["name"].trim()
        : `德业逆变器 ${Math.trunc(serial)}`;
    const room = typeof item["room"] === "string" ? item["room"].trim() : undefined;

    entries.push({
      id,
      name,
      ip,
      port: Number.isFinite(portRaw) && portRaw > 0 ? Math.trunc(portRaw) : SOLARMAN_DEFAULT_PORT,
      serial: Math.trunc(serial),
      slaveId: Number.isFinite(slaveRaw) && slaveRaw > 0 ? Math.trunc(slaveRaw) : 1,
      ...(room ? { room } : {}),
    });
  }
  return entries;
}

function sanitizeErrorMessage(err: unknown, secrets: readonly string[]): string {
  let msg = err instanceof Error ? err.message : String(err);
  for (const secret of secrets) {
    if (secret && secret.length >= 4 && msg.includes(secret)) {
      msg = msg.replaceAll(secret, "••••••••");
    }
  }
  return msg;
}

export class DeyePlatformProvider implements IDevicePlatformProvider {
  readonly id = "deye" as const;
  readonly metadata = DEYE_PLATFORM_METADATA;

  private _config: DeyePlatformConfig;
  private readonly _persistConfig: boolean;
  private readonly _httpFetch?: typeof fetch;
  private readonly _mqttTransport: IDeyeClassicMqttTransport;
  private readonly _solarmanTransport: ISolarmanTransport;
  private readonly _nowMs: () => number;

  private _cloudClient: DeyeCloudClient | null = null;
  private _cloudDevices = new Map<string, DeyeCloudDeviceInfo>();
  private _cloudStates = new Map<string, DeyeDeviceState>();
  private _fogProtocolVersions = new Map<string, number>();
  private _fogRawProperties = new Map<string, Record<string, unknown>>();
  private _classicMqttInfoCache: { info: DeyeClassicMqttInfo; fetchedAt: number } | null = null;

  private _inverters = new Map<string, DeyeSolarmanInverterEntry>();
  private _inverterTelemetry = new Map<
    string,
    { data: DeyeInverterTelemetry; fetchedAt: number }
  >();

  private _controlBlockReason = "";
  private _lastDeviceCount = 0;
  private _lastSyncAt: number | null = null;
  private _lastError: string | null = null;

  constructor(options: DeyePlatformProviderOptions = {}) {
    this._persistConfig = options.persistConfig ?? true;
    this._httpFetch = options.httpFetch;
    this._mqttTransport = options.mqttTransport ?? new DeyeClassicMqttClient();
    this._solarmanTransport = options.solarmanTransport ?? new SolarmanV5Client();
    this._nowMs = options.nowMs ?? (() => Date.now());

    const stored = this._persistConfig ? loadPlatformSection("deye") : defaultDeyeConfig();
    this._config = {
      ...stored,
      ...(options.config ?? {}),
      solarmanInverters: options.config?.solarmanInverters
        ? normalizeInverterEntries(options.config.solarmanInverters)
        : [...stored.solarmanInverters],
    };

    this._rebuildIndexesAndClient();
  }

  private _secrets(extra: readonly string[] = []): string[] {
    return [this._config.password, this._config.authToken ?? "", ...extra].filter(Boolean);
  }

  private _wrapError(
    err: unknown,
    context: string,
    extraSecrets: readonly string[] = [],
  ): ServiceError {
    const secrets = this._secrets(extraSecrets);
    if (err instanceof ServiceError) {
      return new ServiceError(sanitizeErrorMessage(err, secrets), { cause: err });
    }
    const detail = sanitizeErrorMessage(err, secrets);
    return new ServiceError(`${context}：${detail}`, { cause: err });
  }

  private _requireControlAccess(): void {
    if (this._controlBlockReason) {
      throw new ServiceError(this._controlBlockReason);
    }
  }

  private _usesCloud(): boolean {
    return this._config.mode === "cloud" || this._config.mode === "hybrid";
  }

  private _usesSolarman(): boolean {
    return this._config.mode === "solarman" || this._config.mode === "hybrid";
  }

  private _saveConfig(): void {
    if (this._persistConfig) {
      this._config = savePlatformSection("deye", this._config);
    }
  }

  private _rebuildIndexesAndClient(): void {
    this._inverters.clear();
    for (const inv of this._config.solarmanInverters) {
      this._inverters.set(inv.id, inv);
    }

    if (this._usesCloud() && (this._config.authToken || this._config.username)) {
      let validToken: string | undefined;
      if (this._config.authToken) {
        validToken = this._config.authToken;
      }
      try {
        this._cloudClient = new DeyeCloudClient({
          username: this._config.username,
          password: this._config.password,
          authToken: validToken,
          endpoint: this._config.endpoint || DEYE_API_END_USER_ENDPOINT,
          httpFetch: this._httpFetch,
          nowMs: this._nowMs,
          onAuthTokenRefreshed: (newToken) => {
            this._config.authToken = newToken;
            this._saveConfig();
          },
        });
      } catch {
        // 已保存的旧令牌损坏时保留凭据客户端，待下次请求重新认证
        this._cloudClient = new DeyeCloudClient({
          username: this._config.username,
          password: this._config.password,
          endpoint: this._config.endpoint || DEYE_API_END_USER_ENDPOINT,
          httpFetch: this._httpFetch,
          nowMs: this._nowMs,
          onAuthTokenRefreshed: (newToken) => {
            this._config.authToken = newToken;
            this._saveConfig();
          },
        });
      }
    } else {
      this._cloudClient = null;
    }
  }

  setControlAccess(message = ""): void {
    this._controlBlockReason = message;
  }

  isEnabled(): boolean {
    return this._config.enabled;
  }

  isConnected(): boolean {
    if (!this._config.enabled) {
      return false;
    }
    const cloudReady =
      this._usesCloud() &&
      Boolean(
        this._cloudClient?.authToken ||
          (this._config.username && this._config.password),
      );
    const solarmanReady = this._usesSolarman() && this._config.solarmanInverters.length > 0;
    if (this._config.mode === "cloud") {
      return cloudReady;
    }
    if (this._config.mode === "solarman") {
      return solarmanReady;
    }
    return cloudReady || solarmanReady;
  }

  status(): PlatformStatus {
    const connected = this.isConnected();
    const authMode: PlatformAuthMode =
      this._config.mode === "solarman"
        ? "local"
        : this._config.mode === "hybrid"
          ? "hybrid"
          : "credentials";

    return {
      ...this.metadata,
      enabled: this._config.enabled,
      connected,
      state: connected ? "connected" : this._lastError ? "error" : "disconnected",
      authMode,
      deviceCount: this._lastDeviceCount,
      sceneCount: 0,
      lastSyncAt: this._lastSyncAt,
      lastError: this._lastError,
      configSummary: summarizeDeyeConfig(this._config),
    };
  }

  async configure(rawConfig: Record<string, unknown>): Promise<PlatformStatus> {
    const prev = this._config;
    const rawMode = rawConfig["mode"];
    const nextMode: DeyePlatformConfig["mode"] =
      rawMode === "cloud" || rawMode === "solarman" || rawMode === "hybrid"
        ? rawMode
        : prev.mode;

    const nextEnabled =
      typeof rawConfig["enabled"] === "boolean" ? rawConfig["enabled"] : true;
    const nextUsername =
      typeof rawConfig["username"] === "string" ? rawConfig["username"].trim() : prev.username;
    const usernameChanged = nextUsername !== prev.username;

    // 未传入或脱敏占位符时保留既有密码与令牌
    const nextPassword = isSecretPlaceholder(rawConfig["password"])
      ? prev.password
      : String(rawConfig["password"]);

    let nextAuthToken: string;
    if (!isSecretPlaceholder(rawConfig["authToken"])) {
      nextAuthToken = String(rawConfig["authToken"]).trim();
    } else if (usernameChanged) {
      nextAuthToken = "";
    } else {
      nextAuthToken = prev.authToken ?? "";
    }

    const nextEndpoint =
      typeof rawConfig["endpoint"] === "string" && rawConfig["endpoint"].trim()
        ? rawConfig["endpoint"].trim()
        : prev.endpoint || DEYE_API_END_USER_ENDPOINT;

    const nextInverters =
      "solarmanInverters" in rawConfig
        ? normalizeInverterEntries(rawConfig["solarmanInverters"])
        : [...prev.solarmanInverters];

    const candidate: DeyePlatformConfig = {
      enabled: nextEnabled,
      mode: nextMode,
      username: nextUsername,
      password: nextPassword,
      authToken: nextAuthToken,
      endpoint: nextEndpoint,
      solarmanInverters: nextInverters,
    };

    const usesCloud = candidate.mode === "cloud" || candidate.mode === "hybrid";
    const usesSolarman = candidate.mode === "solarman" || candidate.mode === "hybrid";

    if (candidate.enabled) {
      if (candidate.mode === "solarman" && candidate.solarmanInverters.length === 0) {
        const msg = "Solarman 本地模式至少需要配置一台逆变器（IP 与采集器序列号）";
        this._lastError = msg;
        throw new ServiceError(msg);
      }

      if (usesCloud && (candidate.username || candidate.authToken || candidate.mode === "cloud")) {
        if (!candidate.authToken && (!candidate.username || !candidate.password)) {
          if (candidate.mode === "cloud" || candidate.solarmanInverters.length === 0) {
            const msg = "请提供德业智能账号与密码（或有效授权令牌）";
            this._lastError = msg;
            throw new ServiceError(msg);
          }
        } else {
          try {
            const client = new DeyeCloudClient({
              username: candidate.username,
              password: candidate.password,
              authToken: candidate.authToken || undefined,
              endpoint: candidate.endpoint,
              httpFetch: this._httpFetch,
              nowMs: this._nowMs,
            });

            if (!client.authToken) {
              candidate.authToken = await client.authenticate(
                candidate.username,
                candidate.password,
              );
            } else {
              await client.refreshTokenIfNearExpiry();
              candidate.authToken = client.authToken ?? candidate.authToken;
            }
          } catch (err) {
            const wrapped = this._wrapError(err, "德业智能云端认证失败", [
              candidate.password,
              candidate.authToken ?? "",
            ]);
            this._lastError = wrapped.message;
            throw wrapped;
          }
        }
      }

      if (usesSolarman && candidate.solarmanInverters.length === 0 && !candidate.authToken && !candidate.username) {
        const msg = "混合模式请至少配置德业云端账号或一台 Solarman V5 本地逆变器";
        this._lastError = msg;
        throw new ServiceError(msg);
      }
    }

    this._config = candidate;
    this._cloudDevices.clear();
    this._cloudStates.clear();
    this._fogProtocolVersions.clear();
    this._fogRawProperties.clear();
    this._classicMqttInfoCache = null;
    this._inverterTelemetry.clear();
    this._lastError = null;
    this._rebuildIndexesAndClient();
    this._saveConfig();

    return this.status();
  }

  async disconnect(): Promise<void> {
    this._config = {
      ...this._config,
      enabled: false,
      password: "",
      authToken: "",
    };
    this._cloudClient = null;
    this._cloudDevices.clear();
    this._cloudStates.clear();
    this._fogProtocolVersions.clear();
    this._fogRawProperties.clear();
    this._classicMqttInfoCache = null;
    this._inverterTelemetry.clear();
    this._lastDeviceCount = 0;
    this._lastError = null;
    this._saveConfig();
  }

  private _ensureCloudClient(): DeyeCloudClient {
    if (!this._cloudClient) {
      this._rebuildIndexesAndClient();
    }
    if (!this._cloudClient) {
      throw new ServiceError("尚未配置德业智能云端账号");
    }
    return this._cloudClient;
  }

  private async _getClassicMqttInfo(forceRefresh = false): Promise<DeyeClassicMqttInfo> {
    const now = this._nowMs();
    if (
      !forceRefresh &&
      this._classicMqttInfoCache &&
      now - this._classicMqttInfoCache.fetchedAt < MQTT_INFO_TTL_MS
    ) {
      return this._classicMqttInfoCache.info;
    }
    const client = this._ensureCloudClient();
    const info = await client.getClassicMqttInfo();
    this._classicMqttInfoCache = { info, fetchedAt: now };
    return info;
  }

  private _cloudDidOf(device: DeyeCloudDeviceInfo): string {
    return device.device_id || device.deviceid || device.mac;
  }

  async listDevices(progress?: ProgressCallback): Promise<DeviceInfo[]> {
    if (!this._config.enabled) {
      return [];
    }

    progress?.(15, "正在读取德业智能设备列表…");

    const devices: DeviceInfo[] = [];
    const errors: Error[] = [];

    const tasks: Array<Promise<void>> = [];

    if (this._usesCloud() && (this._cloudClient?.authToken || (this._config.username && this._config.password))) {
      tasks.push(
        (async () => {
          try {
            const client = this._ensureCloudClient();
            const list = await client.getDeviceList();
            this._cloudDevices.clear();
            for (const item of list) {
              const did = this._cloudDidOf(item);
              this._cloudDevices.set(did, item);
              devices.push(mapCloudDeviceToDeviceInfo(item));
            }
          } catch (err) {
            errors.push(this._wrapError(err, "获取德业云端设备列表失败"));
          }
        })(),
      );
    }

    if (this._usesSolarman() && this._config.solarmanInverters.length > 0) {
      this._inverters.clear();
      for (const inv of this._config.solarmanInverters) {
        this._inverters.set(inv.id, inv);
      }
      tasks.push(
        (async () => {
          await Promise.all(
            this._config.solarmanInverters.map(async (entry) => {
              let online = false;
              try {
                const telemetry = await this._solarmanTransport.queryInverterTelemetry(entry);
                this._inverterTelemetry.set(entry.id, {
                  data: telemetry,
                  fetchedAt: this._nowMs(),
                });
                online = true;
              } catch {
                online = false;
              }
              devices.push(mapSolarmanInverterToDeviceInfo(entry, online));
            }),
          );
        })(),
      );
    }

    await Promise.all(tasks);

    if (devices.length === 0 && errors.length > 0) {
      this._lastError = errors[0]!.message;
      throw errors[0]!;
    }

    this._lastDeviceCount = devices.length;
    this._lastSyncAt = this._nowMs();
    this._lastError = errors.length > 0 ? errors[0]!.message : null;
    progress?.(80, `已同步 ${devices.length} 台德业设备…`);
    return devices;
  }

  private async _resolveTarget(
    nativeDid: string,
  ): Promise<
    | { kind: "inverter"; entry: DeyeSolarmanInverterEntry }
    | { kind: "cloud"; device: DeyeCloudDeviceInfo }
  > {
    const inv = this._inverters.get(nativeDid);
    if (inv) {
      return { kind: "inverter", entry: inv };
    }
    let cloudDev = this._cloudDevices.get(nativeDid);
    if (!cloudDev && this._usesCloud()) {
      const client = this._ensureCloudClient();
      const list = await client.getDeviceList();
      for (const item of list) {
        this._cloudDevices.set(this._cloudDidOf(item), item);
      }
      cloudDev = this._cloudDevices.get(nativeDid);
    }
    if (cloudDev) {
      return { kind: "cloud", device: cloudDev };
    }
    throw new ServiceError(`未找到德业设备：${nativeDid}`);
  }

  private async _queryCloudDeviceState(device: DeyeCloudDeviceInfo): Promise<DeyeDeviceState> {
    const did = this._cloudDidOf(device);
    const transport = transportForDevice(device);

    if (transport === DeyeDeviceTransport.FOG) {
      const client = this._ensureCloudClient();
      const props = await client.getFogDeviceProperties(did);
      this._fogRawProperties.set(did, { ...props });
      const state = parseFogState(props);
      if (state.protocolVersion !== null) {
        this._fogProtocolVersions.set(did, state.protocolVersion);
      }
      this._cloudStates.set(did, state);
      return state;
    }

    // Classic 或 Combo 设备均走 Classic MQTT 状态查询
    const mqttInfo = await this._getClassicMqttInfo();
    const state = await this._mqttTransport.queryDeviceState(
      mqttInfo,
      device.product_id,
      did,
    );
    this._cloudStates.set(did, state);
    return state;
  }

  private async _queryInverterTelemetryCached(
    entry: DeyeSolarmanInverterEntry,
    force = false,
  ): Promise<DeyeInverterTelemetry> {
    const cached = this._inverterTelemetry.get(entry.id);
    const now = this._nowMs();
    if (!force && cached && now - cached.fetchedAt < TELEMETRY_CACHE_TTL_MS) {
      return cached.data;
    }
    const data = await this._solarmanTransport.queryInverterTelemetry(entry);
    this._inverterTelemetry.set(entry.id, { data, fetchedAt: now });
    return data;
  }

  async deviceDetail(nativeDid: string): Promise<DeviceDetail> {
    const target = await this._resolveTarget(nativeDid);
    if (target.kind === "inverter") {
      return buildSolarmanInverterDetail(target.entry);
    }
    return buildCloudDeviceDetail(target.device);
  }

  async readProp(nativeDid: string, name: string): Promise<unknown> {
    const props = await this.readProps(nativeDid, [name]);
    return props[name];
  }

  async readProps(nativeDid: string, names: string[]): Promise<Record<string, unknown>> {
    const target = await this._resolveTarget(nativeDid);
    try {
      const allValues =
        target.kind === "inverter"
          ? extractInverterPropValues(await this._queryInverterTelemetryCached(target.entry))
          : extractCloudPropValues(await this._queryCloudDeviceState(target.device));

      const result: Record<string, unknown> = {};
      for (const name of names) {
        result[name] = name in allValues ? allValues[name] : null;
      }
      return result;
    } catch (err) {
      throw this._wrapError(err, `读取德业设备属性失败（${nativeDid}）`);
    }
  }

  async writeProp(nativeDid: string, name: string, value: unknown): Promise<void> {
    this._requireControlAccess();
    const target = await this._resolveTarget(nativeDid);
    if (target.kind === "inverter") {
      throw new ServiceError("德业 Solarman V5 光伏逆变器当前仅支持只读遥测监控");
    }

    const device = target.device;
    const did = this._cloudDidOf(device);
    const productCfg = getProductFeatureConfig(device.product_id);

    try {
      const currentState =
        this._cloudStates.get(did) ?? (await this._queryCloudDeviceState(device));
      const { command, nextState } = applyCloudPropWrite(name, value, currentState, productCfg);
      const transport = transportForDevice(device);

      if (transport === DeyeDeviceTransport.FOG) {
        const client = this._ensureCloudClient();
        const protocolVersion =
          this._fogProtocolVersions.get(did) ?? currentState.protocolVersion;
        const lastProperties =
          this._fogRawProperties.get(did) ?? currentState.rawFogProperties ?? null;
        const payloads = resolveFogCommandPayloads(command, {
          baseline: currentState,
          protocolVersion,
          lastProperties,
        });
        for (const payload of payloads) {
          await client.setFogDeviceProperties(did, payload);
        }
        if (nextState.rawFogProperties) {
          this._fogRawProperties.set(did, { ...nextState.rawFogProperties });
        }
      } else if (transport === DeyeDeviceTransport.COMBO) {
        const diff = commandToFogJsonDiff(command, currentState);
        const frames = fogComboFramesFromProperties(diff);
        if (frames.length > 0) {
          const mqttInfo = await this._getClassicMqttInfo();
          await this._mqttTransport.publishCommand(mqttInfo, device.product_id, did, frames);
        }
      } else {
        const frame = encodeClassicCommand(command);
        const mqttInfo = await this._getClassicMqttInfo();
        await this._mqttTransport.publishCommand(mqttInfo, device.product_id, did, [frame]);
      }

      this._cloudStates.set(did, nextState);
    } catch (err) {
      if (err instanceof ServiceError) {
        throw err;
      }
      if (err instanceof DeyeCloudApiInvalidAuthError || err instanceof DeyeCloudApiError) {
        throw this._wrapError(err, `写入德业设备属性失败（${name}）`);
      }
      throw this._wrapError(err, `写入德业设备属性失败（${name}）`);
    }
  }

  async runAction(nativeDid: string, name: string, _params?: unknown): Promise<void> {
    this._requireControlAccess();
    const target = await this._resolveTarget(nativeDid);
    if (name !== "refresh-state") {
      throw new ServiceError(`德业设备不支持动作：${name}`);
    }
    try {
      if (target.kind === "inverter") {
        await this._queryInverterTelemetryCached(target.entry, true);
        return;
      }
      const did = this._cloudDidOf(target.device);
      if (transportForDevice(target.device) === DeyeDeviceTransport.FOG) {
        const client = this._ensureCloudClient();
        await client.pollFogDeviceProperties(did);
      }
      await this._queryCloudDeviceState(target.device);
    } catch (err) {
      throw this._wrapError(err, `执行德业设备动作失败（${name}）`);
    }
  }

  async powerState(nativeDid: string): Promise<boolean | null> {
    const target = await this._resolveTarget(nativeDid);
    if (target.kind === "inverter") {
      return null;
    }
    try {
      const state = await this._queryCloudDeviceState(target.device);
      return state.powerSwitch;
    } catch {
      return null;
    }
  }

  async setPowerState(nativeDid: string, state: boolean): Promise<void> {
    await this.writeProp(nativeDid, "on", state);
  }

  async togglePower(nativeDid: string): Promise<boolean> {
    this._requireControlAccess();
    const target = await this._resolveTarget(nativeDid);
    if (target.kind === "inverter") {
      throw new ServiceError("德业光伏逆变器不支持开关切换");
    }
    const current = await this.powerState(nativeDid);
    const next = !(current === true);
    await this.setPowerState(nativeDid, next);
    return next;
  }

  async powerStates(nativeDids: string[]): Promise<Record<string, boolean | null>> {
    const result: Record<string, boolean | null> = {};
    await Promise.all(
      nativeDids.map(async (did) => {
        try {
          result[did] = await this.powerState(did);
        } catch {
          result[did] = null;
        }
      }),
    );
    return result;
  }

  async readMetrics(nativeDids: string[]): Promise<Record<string, string | null>> {
    const result: Record<string, string | null> = {};
    await Promise.all(
      nativeDids.map(async (did) => {
        try {
          const target = await this._resolveTarget(did);
          if (target.kind === "inverter") {
            const telemetry = await this._queryInverterTelemetryCached(target.entry);
            result[did] = formatInverterMetrics(telemetry);
          } else {
            const state = await this._queryCloudDeviceState(target.device);
            result[did] = formatCloudDeviceMetrics(state);
          }
        } catch {
          result[did] = null;
        }
      }),
    );
    return result;
  }

  async sceneList(_homeName?: string | null): Promise<SceneInfo[]> {
    return [];
  }

  async runScene(_scene: SceneInfo): Promise<void> {
    this._requireControlAccess();
    throw new ServiceError("德业智能平台暂不支持云端场景执行");
  }

  async diagnosticReport(
    device: DeviceInfo,
    observation?: Record<string, unknown> | null,
  ): Promise<string> {
    const cloudDev = this._cloudDevices.get(device.did);
    const inv = this._inverters.get(device.did);
    const report = {
      platform: "deye",
      generatedAt: new Date(this._nowMs()).toISOString(),
      device: {
        did: device.did,
        name: device.name,
        model: device.model,
        spec_type: device.spec_type,
        online: device.online,
        firmware: device.firmware,
      },
      transport: inv
        ? "solarman-v5"
        : cloudDev
          ? DeyeDeviceTransport[transportForDevice(cloudDev)]
          : "unknown",
      configSummary: summarizeDeyeConfig(this._config),
      observation: observation ? redactSecrets(observation) : null,
    };
    return JSON.stringify(report, null, 2);
  }

  dispose(): void {
    this._cloudDevices.clear();
    this._cloudStates.clear();
    this._fogProtocolVersions.clear();
    this._fogRawProperties.clear();
    this._classicMqttInfoCache = null;
    this._inverterTelemetry.clear();
  }
}
