// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 美的智能 (Midea / 美的美居 / MSmartHome / NetHomePlus) 平台提供者

import type { ProgressCallback } from "../../core/contracts.ts";
import type { DeviceDetail, DeviceInfo, SceneInfo } from "../../core/models.ts";
import { ServiceError } from "../../core/service.ts";
import {
  defaultMideaConfig,
  loadPlatformSection,
  redactSecrets,
  savePlatformSection,
  summarizeMideaConfig,
  type MideaLocalDeviceEntry,
  type MideaPlatformConfig,
} from "../configStore.ts";
import type {
  DiscoveredLocalDevice,
  IDevicePlatformProvider,
  PlatformAuthMode,
  PlatformMetadata,
  PlatformStatus,
} from "../types.ts";
import {
  MideaCloudClient,
  type MideaTokenKeyPair,
} from "./cloudClient.ts";
import {
  MIDEA_LAN_TCP_PORT,
  formatMideaTypeHex,
  getMideaApplianceType,
  parseMideaTypeCode,
  type MideaCloudBrand,
} from "./constants.ts";
import {
  MideaLanClient,
  discoverMideaLanDevices,
  type IMideaLanTransport,
  type MideaLanDeviceEndpoint,
  type MideaLanDiscoveredDevice,
  type MideaLanDiscoveryOptions,
} from "./lanClient.ts";
import {
  applyMideaStateProp,
  formatMideaMetrics,
  mapMideaDeviceToDetail,
  mapMideaDeviceToInfo,
  readMideaStateProp,
  type MideaApplianceRecord,
} from "./mapper.ts";
import {
  buildApplianceQuery,
  buildApplianceSet,
  defaultApplianceState,
  parseApplianceResponse,
  type MideaApplianceState,
} from "./protocols.ts";

export const MIDEA_PLATFORM_METADATA: PlatformMetadata = {
  id: "midea",
  name: "美的智能",
  displayName: "美的智能 (美的美居 / MSmartHome)",
  badgeText: "美的",
  accentColor: "#0092d8",
  description: "支持美的美居、MSmartHome、NetHome Plus 云端发现及 V2/V3 局域网本地直控",
  reference: "georgezhao2010/midea_ac_lan & mill1000/midea-msmart",
  capabilities: {
    cloud: true,
    local: true,
    qrAuth: false,
    credentialsAuth: true,
    openApiAuth: false,
    lanDiscovery: true,
    scenes: false,
  },
};

export interface MideaPlatformProviderOptions {
  httpFetch?: typeof fetch;
  lanTransport?: IMideaLanTransport;
  discoverFn?: (options?: MideaLanDiscoveryOptions) => Promise<MideaLanDiscoveredDevice[]>;
  initialConfig?: Partial<MideaPlatformConfig>;
  skipLoadConfig?: boolean;
}

const MASKED_SECRET_RE = /^•+$/;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMaskedOrEmpty(value: unknown): boolean {
  if (typeof value !== "string") return true;
  const trimmed = value.trim();
  return !trimmed || MASKED_SECRET_RE.test(trimmed) || trimmed === "[REDACTED]";
}

function compareStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function resolveAuthMode(mode: MideaPlatformConfig["mode"]): PlatformAuthMode {
  if (mode === "local") return "local";
  if (mode === "hybrid") return "hybrid";
  return "credentials";
}

function parseBrand(raw: unknown, fallback: MideaCloudBrand): MideaCloudBrand {
  if (
    raw === "meiju" ||
    raw === "msmarthome" ||
    raw === "nethomeplus" ||
    raw === "midea_air"
  ) {
    return raw;
  }
  return fallback;
}

function parseMode(
  raw: unknown,
  fallback: MideaPlatformConfig["mode"],
): MideaPlatformConfig["mode"] {
  if (raw === "cloud" || raw === "local" || raw === "hybrid") {
    return raw;
  }
  return fallback;
}

function sanitizeErrorMessage(err: unknown, secrets: string[]): string {
  let msg = err instanceof Error ? err.message : String(err);
  for (const secret of secrets) {
    if (secret && secret.length >= 4 && msg.includes(secret)) {
      msg = msg.replaceAll(secret, "••••••••");
    }
  }
  return msg;
}

export class MideaPlatformProvider implements IDevicePlatformProvider {
  readonly id = "midea" as const;
  readonly metadata = MIDEA_PLATFORM_METADATA;

  private readonly _httpFetch?: typeof fetch;
  private readonly _lanTransport: IMideaLanTransport;
  private readonly _discoverFn: (
    options?: MideaLanDiscoveryOptions,
  ) => Promise<MideaLanDiscoveredDevice[]>;

  private _config: MideaPlatformConfig;
  private _cloudClient: MideaCloudClient | null = null;
  private _appliances = new Map<string, MideaApplianceRecord>();
  private _states = new Map<string, MideaApplianceState>();
  private _tokenCandidates = new Map<string, MideaTokenKeyPair[]>();

  private _controlBlockReason = "";
  private _authFailed = false;
  private _lastDeviceCount = 0;
  private _lastSyncAt: number | null = null;
  private _lastError: string | null = null;

  constructor(options: MideaPlatformProviderOptions = {}) {
    this._httpFetch = options.httpFetch;
    this._lanTransport = options.lanTransport ?? new MideaLanClient();
    this._discoverFn =
      options.discoverFn ??
      (this._lanTransport.discover
        ? (opts) => this._lanTransport.discover!(opts)
        : (opts) => discoverMideaLanDevices(opts));

    const loaded = options.skipLoadConfig ? defaultMideaConfig() : loadPlatformSection("midea");
    this._config = {
      ...loaded,
      ...(options.initialConfig ?? {}),
      localDevices: options.initialConfig?.localDevices
        ? [...options.initialConfig.localDevices]
        : [...loaded.localDevices],
    };

    if (this._config.enabled) {
      this._seedLocalAppliances();
    }
  }

  setControlAccess(message = ""): void {
    this._controlBlockReason = message;
  }

  private _requireControlAccess(): void {
    if (this._controlBlockReason) {
      throw new ServiceError(this._controlBlockReason);
    }
  }

  private _activeSecrets(): string[] {
    const secrets: string[] = [];
    if (this._config.password) secrets.push(this._config.password);
    const session = this._cloudClient?.session;
    if (session?.accessToken) secrets.push(session.accessToken);
    if (session?.sessionId) secrets.push(session.sessionId);
    for (const d of this._config.localDevices) {
      if (d.token) secrets.push(d.token);
      if (d.key) secrets.push(d.key);
    }
    return secrets;
  }

  private _hasCloudCredentials(cfg: MideaPlatformConfig = this._config): boolean {
    return Boolean(cfg.account.trim() && cfg.password);
  }

  private _seedLocalAppliances(): void {
    for (const entry of this._config.localDevices) {
      if (!this._appliances.has(entry.id)) {
        this._appliances.set(entry.id, {
          id: entry.id,
          name: entry.name || `美的${getMideaApplianceType(entry.type).label}`,
          type: entry.type,
          homeName: "本地网络",
          roomName: entry.room || "局域网",
          online: true,
          model: entry.model,
          ip: entry.ip,
          port: entry.port ?? MIDEA_LAN_TCP_PORT,
          protocolVersion: entry.protocolVersion,
          token: entry.token,
          key: entry.key,
          source: "local",
        });
      }
    }
  }

  private _ensureCloudClient(): MideaCloudClient | null {
    if (this._config.mode === "local" || !this._hasCloudCredentials()) {
      return null;
    }
    if (!this._cloudClient) {
      this._cloudClient = new MideaCloudClient({
        brand: this._config.cloudBrand,
        account: this._config.account,
        password: this._config.password,
        useChinaServer: this._config.useChinaServer,
        httpFetch: this._httpFetch,
      });
    }
    return this._cloudClient;
  }

  isEnabled(): boolean {
    return this._config.enabled;
  }

  isConnected(): boolean {
    if (!this._config.enabled || this._authFailed) {
      return false;
    }
    const hasCloud = this._hasCloudCredentials();
    const hasLocal = this._config.localDevices.length > 0 || this._appliances.size > 0;
    switch (this._config.mode) {
      case "cloud":
        return hasCloud;
      case "local":
        return hasLocal;
      case "hybrid":
        return hasCloud || hasLocal;
    }
  }

  status(): PlatformStatus {
    const connected = this.isConnected();
    return {
      ...this.metadata,
      enabled: this._config.enabled,
      connected,
      state: connected ? "connected" : this._lastError ? "error" : "disconnected",
      authMode: resolveAuthMode(this._config.mode),
      deviceCount: this._lastDeviceCount || this._appliances.size,
      sceneCount: 0,
      lastSyncAt: this._lastSyncAt,
      lastError: this._lastError,
      configSummary: summarizeMideaConfig(this._config),
    };
  }

  private _mergeLocalDevices(incoming: unknown): MideaLocalDeviceEntry[] {
    if (!Array.isArray(incoming)) {
      return this._config.localDevices.map((d) => ({ ...d }));
    }
    const existingById = new Map<string, MideaLocalDeviceEntry>(
      this._config.localDevices.map((d) => [d.id, d]),
    );
    const merged: MideaLocalDeviceEntry[] = [];
    for (const raw of incoming) {
      if (!isPlainRecord(raw)) continue;
      const id =
        typeof raw["id"] === "string" || typeof raw["id"] === "number"
          ? String(raw["id"]).trim()
          : "";
      const ip = typeof raw["ip"] === "string" ? raw["ip"].trim() : "";
      if (!id || !ip) continue;

      const prev = existingById.get(id);
      const type = parseMideaTypeCode(raw["type"], prev?.type ?? 0xac);
      const protocolVersion: 2 | 3 =
        raw["protocolVersion"] === 2 || raw["protocolVersion"] === "2" ? 2 : 3;
      const portRaw = Number(raw["port"]);
      const port = Number.isFinite(portRaw) && portRaw > 0 ? portRaw : prev?.port ?? MIDEA_LAN_TCP_PORT;
      const token = !isMaskedOrEmpty(raw["token"])
        ? String(raw["token"]).trim()
        : prev?.token;
      const key = !isMaskedOrEmpty(raw["key"])
        ? String(raw["key"]).trim()
        : prev?.key;

      merged.push({
        id,
        name:
          typeof raw["name"] === "string" && raw["name"].trim()
            ? raw["name"].trim()
            : prev?.name || `美的${getMideaApplianceType(type).label}`,
        ip,
        port,
        type,
        protocolVersion,
        ...(token ? { token } : {}),
        ...(key ? { key } : {}),
        ...(typeof raw["room"] === "string"
          ? { room: raw["room"].trim() }
          : prev?.room
            ? { room: prev.room }
            : {}),
        ...(typeof raw["model"] === "string"
          ? { model: raw["model"].trim() }
          : prev?.model
            ? { model: prev.model }
            : {}),
      });
    }
    return merged;
  }

  async configure(config: Record<string, unknown>): Promise<PlatformStatus> {
    const enabled =
      typeof config["enabled"] === "boolean" ? config["enabled"] : true;
    const mode = parseMode(config["mode"], this._config.mode);
    const cloudBrand = parseBrand(config["cloudBrand"], this._config.cloudBrand);
    const account =
      typeof config["account"] === "string"
        ? config["account"].trim()
        : this._config.account;
    const password = !isMaskedOrEmpty(config["password"])
      ? String(config["password"])
      : this._config.password;
    const useChinaServer =
      typeof config["useChinaServer"] === "boolean"
        ? config["useChinaServer"]
        : this._config.useChinaServer;
    const preferLocal =
      typeof config["preferLocal"] === "boolean"
        ? config["preferLocal"]
        : this._config.preferLocal;
    const localDevices = this._mergeLocalDevices(config["localDevices"]);

    const nextConfig: MideaPlatformConfig = {
      enabled,
      mode,
      cloudBrand,
      account,
      password,
      useChinaServer,
      preferLocal,
      localDevices,
    };

    if (enabled) {
      if (mode === "cloud" && !this._hasCloudCredentials(nextConfig)) {
        throw new ServiceError("美的云端模式需要填写账号与密码");
      }
      if (mode === "local" && nextConfig.localDevices.length === 0) {
        throw new ServiceError("美的本地模式请至少添加一台局域网设备（或先执行局域网扫描）");
      }
      if (
        mode === "hybrid" &&
        !this._hasCloudCredentials(nextConfig) &&
        nextConfig.localDevices.length === 0
      ) {
        throw new ServiceError("美的混合模式需要填写云端账号密码，或配置至少一台局域网设备");
      }
    }

    // 重置旧会话并按新配置校验云端登录
    this._cloudClient?.clearSession();
    this._cloudClient = null;
    this._appliances.clear();
    this._states.clear();
    this._tokenCandidates.clear();

    if (enabled && (mode === "cloud" || mode === "hybrid") && this._hasCloudCredentials(nextConfig)) {
      const testClient = new MideaCloudClient({
        brand: nextConfig.cloudBrand,
        account: nextConfig.account,
        password: nextConfig.password,
        useChinaServer: nextConfig.useChinaServer,
        httpFetch: this._httpFetch,
      });
      try {
        await testClient.login();
        this._cloudClient = testClient;
        this._authFailed = false;
        this._lastError = null;
      } catch (err) {
        this._authFailed = true;
        const safeMsg = sanitizeErrorMessage(err, [nextConfig.password]);
        this._lastError = safeMsg;
        throw new ServiceError(`美的云端登录验证失败：${safeMsg}`);
      }
    } else {
      this._authFailed = false;
      this._lastError = null;
    }

    this._config = savePlatformSection("midea", nextConfig);
    if (this._config.enabled) {
      this._seedLocalAppliances();
    }
    this._lastDeviceCount = this._appliances.size;
    return this.status();
  }

  async disconnect(): Promise<void> {
    this._cloudClient?.clearSession();
    this._cloudClient = null;
    this._lanTransport.close?.();
    this._appliances.clear();
    this._states.clear();
    this._tokenCandidates.clear();

    const cleared: MideaPlatformConfig = {
      ...this._config,
      enabled: false,
      password: "",
      localDevices: this._config.localDevices.map((d) => ({
        id: d.id,
        name: d.name,
        ip: d.ip,
        port: d.port,
        type: d.type,
        protocolVersion: d.protocolVersion,
        ...(d.room ? { room: d.room } : {}),
        ...(d.model ? { model: d.model } : {}),
      })),
    };
    this._config = savePlatformSection("midea", cleared);
    this._authFailed = false;
    this._lastDeviceCount = 0;
    this._lastError = null;
  }

  async discoverLocal(options?: { timeoutMs?: number }): Promise<DiscoveredLocalDevice[]> {
    const discovered = await this._discoverFn({ timeoutMs: options?.timeoutMs });
    return discovered.map((d) => {
      const typeInfo = getMideaApplianceType(d.type);
      return {
        platform: "midea",
        id: d.id,
        name: `美的${typeInfo.label} (${d.id.slice(-4)})`,
        ip: d.ip,
        port: d.port,
        protocolVersion: `V${d.protocolVersion}`,
        model: `midea.${typeInfo.kind}.0x${formatMideaTypeHex(d.type)}`,
        typeCode: `0x${formatMideaTypeHex(d.type).toUpperCase()}`,
        requiresCredentials: d.protocolVersion === 3,
        meta: {
          sn8: d.sn8,
          ...(d.ssid ? { ssid: d.ssid } : {}),
        },
      };
    });
  }

  async listDevices(progress?: ProgressCallback): Promise<DeviceInfo[]> {
    if (!this._config.enabled) {
      return [];
    }

    try {
      const merged = new Map<string, MideaApplianceRecord>();

      // 1. 预置本地手动配置设备
      for (const local of this._config.localDevices) {
        merged.set(local.id, {
          id: local.id,
          name: local.name || `美的${getMideaApplianceType(local.type).label}`,
          type: local.type,
          homeName: "本地网络",
          roomName: local.room || "局域网",
          online: true,
          model: local.model,
          ip: local.ip,
          port: local.port ?? MIDEA_LAN_TCP_PORT,
          protocolVersion: local.protocolVersion,
          token: local.token,
          key: local.key,
          source: "local",
        });
      }

      // 2. 云端发现家庭/房间/设备与 V3 token/key
      const cloudClient = this._ensureCloudClient();
      if (cloudClient) {
        progress?.(20, "正在登录美的云端并获取设备列表…");
        const cloudAppliances = await cloudClient.listAppliances();
        for (const item of cloudAppliances) {
          const existing = merged.get(item.id);
          let token = existing?.token;
          let key = existing?.key;

          if (
            this._config.mode === "hybrid" &&
            this._config.preferLocal &&
            (existing?.protocolVersion ?? item.protocolVersion) === 3 &&
            (!token || !key)
          ) {
            try {
              const pairs = await cloudClient.getTokens(item.id);
              if (pairs.length > 0) {
                this._tokenCandidates.set(item.id, pairs);
                token = pairs[0]!.token;
                key = pairs[0]!.key;
              }
            } catch {
              // 获取 V3 token 失败不影响云端透传控制
            }
          }

          merged.set(item.id, {
            id: item.id,
            name: item.name,
            type: item.type,
            homeName: item.homeName,
            roomName: item.roomName,
            online: item.online || Boolean(existing?.ip),
            model: item.modelNumber || existing?.model,
            sn: item.sn,
            sn8: item.sn8,
            ip: existing?.ip,
            port: existing?.port ?? MIDEA_LAN_TCP_PORT,
            protocolVersion: existing?.protocolVersion ?? item.protocolVersion,
            token,
            key,
            source: existing ? "hybrid" : "cloud",
          });
        }
      }

      // 3. 混合模式优先本地时，尝试局域网自动匹配未绑定 IP 的云端设备
      const needsLanMatch =
        this._config.mode === "hybrid" &&
        this._config.preferLocal &&
        [...merged.values()].some((r) => !r.ip);

      if (needsLanMatch) {
        progress?.(60, "正在扫描局域网以自动关联美的设备 IP…");
        try {
          const lanFound = await this._discoverFn({ timeoutMs: 1200 });
          for (const found of lanFound) {
            const rec = merged.get(found.id);
            if (rec) {
              rec.ip = found.ip;
              rec.port = found.port;
              rec.protocolVersion = found.protocolVersion;
              rec.source = "hybrid";
              if (!rec.sn && found.sn) rec.sn = found.sn;
              if (!rec.sn8 && found.sn8) rec.sn8 = found.sn8;
              rec.online = true;
            }
          }
        } catch {
          // 局域网扫描失败时静默回退云端控制
        }
      }

      this._appliances = merged;
      this._lastDeviceCount = merged.size;
      this._lastSyncAt = Date.now();
      this._lastError = null;
      this._authFailed = false;

      progress?.(90, `已同步 ${merged.size} 台美的设备…`);
      return [...merged.values()]
        .map((rec) => mapMideaDeviceToInfo(rec))
        .sort(
          (a, b) =>
            compareStr(a.home_name, b.home_name) ||
            compareStr(a.room_name, b.room_name) ||
            compareStr(a.name, b.name),
        );
    } catch (err) {
      const safeMsg = sanitizeErrorMessage(err, this._activeSecrets());
      this._lastError = safeMsg;
      throw new ServiceError(`获取美的设备列表失败：${safeMsg}`);
    }
  }

  private async _requireAppliance(nativeDid: string): Promise<MideaApplianceRecord> {
    let record = this._appliances.get(nativeDid);
    if (!record && this._appliances.size === 0 && this._config.enabled) {
      await this.listDevices();
      record = this._appliances.get(nativeDid);
    }
    if (!record) {
      throw new ServiceError(`未找到美的设备：${nativeDid}`);
    }
    return record;
  }

  private async _sendViaLan(record: MideaApplianceRecord, frame: Uint8Array): Promise<Buffer> {
    if (!record.ip) {
      throw new ServiceError(`美的设备「${record.name}」未配置局域网 IP`);
    }

    if (record.protocolVersion === 2) {
      const endpoint: MideaLanDeviceEndpoint = {
        id: record.id,
        ip: record.ip,
        port: record.port ?? MIDEA_LAN_TCP_PORT,
        type: record.type,
        protocolVersion: 2,
      };
      return await this._lanTransport.sendFrame(endpoint, frame);
    }

    // V3：先尝试已配置/已命中的 token+key，再尝试云端候选密钥对
    const candidates: Array<{ token?: string; key?: string }> = [];
    if (record.token && record.key) {
      candidates.push({ token: record.token, key: record.key });
    }
    const extraPairs = this._tokenCandidates.get(record.id) ?? [];
    for (const pair of extraPairs) {
      if (pair.token !== record.token || pair.key !== record.key) {
        candidates.push({ token: pair.token, key: pair.key });
      }
    }
    if (candidates.length === 0) {
      candidates.push({});
    }

    let lastErr: unknown;
    for (const cred of candidates) {
      try {
        const endpoint: MideaLanDeviceEndpoint = {
          id: record.id,
          ip: record.ip,
          port: record.port ?? MIDEA_LAN_TCP_PORT,
          type: record.type,
          protocolVersion: 3,
          ...(cred.token ? { token: cred.token } : {}),
          ...(cred.key ? { key: cred.key } : {}),
        };
        const reply = await this._lanTransport.sendFrame(endpoint, frame);
        if (cred.token && cred.key) {
          record.token = cred.token;
          record.key = cred.key;
        }
        return reply;
      } catch (err) {
        lastErr = err;
      }
    }

    throw lastErr instanceof Error
      ? lastErr
      : new Error(String(lastErr ?? "美的局域网 V3 通信失败"));
  }

  private async _sendFrame(record: MideaApplianceRecord, frame: Uint8Array): Promise<Buffer | null> {
    const canLan =
      Boolean(record.ip) &&
      (this._config.mode === "local" ||
        (this._config.mode === "hybrid" && this._config.preferLocal));
    const cloudClient = this._ensureCloudClient();

    if (canLan) {
      try {
        return await this._sendViaLan(record, frame);
      } catch (lanErr) {
        if (this._config.mode === "hybrid" && cloudClient) {
          return await cloudClient.sendTransparentCommand(record.id, frame);
        }
        const safeMsg = sanitizeErrorMessage(lanErr, this._activeSecrets());
        throw new ServiceError(`美的局域网控制失败：${safeMsg}`);
      }
    }

    if (cloudClient) {
      try {
        return await cloudClient.sendTransparentCommand(record.id, frame);
      } catch (cloudErr) {
        if (record.ip) {
          return await this._sendViaLan(record, frame);
        }
        const safeMsg = sanitizeErrorMessage(cloudErr, this._activeSecrets());
        throw new ServiceError(`美的云端控制失败：${safeMsg}`);
      }
    }

    throw new ServiceError(`美的设备「${record.name}」当前既无可用局域网地址，也未登录美的云端`);
  }

  private async _queryState(record: MideaApplianceRecord): Promise<MideaApplianceState> {
    const queryFrame = buildApplianceQuery(record.type);
    const reply = await this._sendFrame(record, queryFrame);
    if (reply) {
      try {
        const parsed = parseApplianceResponse(record.type, reply);
        if (parsed) {
          this._states.set(record.id, parsed);
          return parsed;
        }
      } catch {
        // 若响应解析失败，回退已有状态或默认状态
      }
    }
    const existing = this._states.get(record.id) ?? defaultApplianceState(record.type);
    this._states.set(record.id, existing);
    return existing;
  }

  private async _writeState(
    record: MideaApplianceRecord,
    nextState: MideaApplianceState,
  ): Promise<MideaApplianceState> {
    const setFrame = buildApplianceSet(record.type, nextState);
    const reply = await this._sendFrame(record, setFrame);
    if (reply) {
      try {
        const parsed = parseApplianceResponse(record.type, reply);
        if (parsed) {
          this._states.set(record.id, parsed);
          return parsed;
        }
      } catch {
        // 部分设备设置回包不是完整状态帧，保留已下发目标状态
      }
    }
    this._states.set(record.id, nextState);
    return nextState;
  }

  async deviceDetail(nativeDid: string): Promise<DeviceDetail> {
    const record = await this._requireAppliance(nativeDid);
    let state = this._states.get(record.id) ?? null;
    if (!state) {
      try {
        state = await this._queryState(record);
      } catch {
        state = defaultApplianceState(record.type);
      }
    }
    return mapMideaDeviceToDetail(record, state);
  }

  async readProp(nativeDid: string, name: string): Promise<unknown> {
    const record = await this._requireAppliance(nativeDid);
    const state = await this._queryState(record);
    return readMideaStateProp(state, name);
  }

  async readProps(nativeDid: string, names: string[]): Promise<Record<string, unknown>> {
    const record = await this._requireAppliance(nativeDid);
    const state = await this._queryState(record);
    const out: Record<string, unknown> = {};
    for (const name of names) {
      out[name] = readMideaStateProp(state, name);
    }
    return out;
  }

  async writeProp(nativeDid: string, name: string, value: unknown): Promise<void> {
    this._requireControlAccess();
    const record = await this._requireAppliance(nativeDid);
    let current = this._states.get(record.id);
    if (!current) {
      try {
        current = await this._queryState(record);
      } catch {
        current = defaultApplianceState(record.type);
      }
    }
    const nextState = applyMideaStateProp(current, name, value);
    await this._writeState(record, nextState);
  }

  async runAction(nativeDid: string, name: string, _params?: unknown): Promise<void> {
    this._requireControlAccess();
    const record = await this._requireAppliance(nativeDid);
    const normalized = name.trim().toLowerCase().replaceAll("_", "-");
    if (normalized === "refresh-status" || normalized === "refresh") {
      await this._queryState(record);
      return;
    }
    if (normalized === "toggle-power" || normalized === "toggle") {
      await this.togglePower(nativeDid);
      return;
    }
    throw new ServiceError(`美的设备不支持动作「${name}」`);
  }

  async powerState(nativeDid: string): Promise<boolean | null> {
    try {
      const record = await this._requireAppliance(nativeDid);
      const state = await this._queryState(record);
      return state.power;
    } catch {
      return null;
    }
  }

  async setPowerState(nativeDid: string, state: boolean): Promise<void> {
    await this.writeProp(nativeDid, "on", state);
  }

  async togglePower(nativeDid: string): Promise<boolean> {
    this._requireControlAccess();
    const record = await this._requireAppliance(nativeDid);
    let current = this._states.get(record.id);
    if (!current) {
      try {
        current = await this._queryState(record);
      } catch {
        current = defaultApplianceState(record.type);
      }
    }
    const targetPower = !current.power;
    const nextState = applyMideaStateProp(current, "on", targetPower);
    const applied = await this._writeState(record, nextState);
    return applied.power;
  }

  async powerStates(nativeDids: string[]): Promise<Record<string, boolean | null>> {
    const out: Record<string, boolean | null> = {};
    await Promise.allSettled(
      nativeDids.map(async (did) => {
        out[did] = await this.powerState(did);
      }),
    );
    return out;
  }

  async readMetrics(nativeDids: string[]): Promise<Record<string, string | null>> {
    const out: Record<string, string | null> = {};
    await Promise.allSettled(
      nativeDids.map(async (did) => {
        try {
          const record = await this._requireAppliance(did);
          const state = await this._queryState(record);
          out[did] = formatMideaMetrics(state);
        } catch {
          out[did] = null;
        }
      }),
    );
    return out;
  }

  async sceneList(_homeName?: string | null): Promise<SceneInfo[]> {
    return [];
  }

  async runScene(_scene: SceneInfo): Promise<void> {
    this._requireControlAccess();
    throw new ServiceError("美的平台暂不支持云端场景执行");
  }

  async diagnosticReport(
    device: DeviceInfo,
    observation?: Record<string, unknown> | null,
  ): Promise<string> {
    const record = this._appliances.get(device.did);
    const state = this._states.get(device.did) ?? null;
    const report = redactSecrets({
      platform: "midea",
      device: {
        did: device.did,
        name: device.name,
        model: device.model,
        spec_type: device.spec_type,
        online: device.online,
        home_name: device.home_name,
        room_name: device.room_name,
      },
      transport: record
        ? {
            source: record.source,
            protocolVersion: record.protocolVersion,
            hasLanIp: Boolean(record.ip),
            port: record.port ?? MIDEA_LAN_TCP_PORT,
            hasToken: Boolean(record.token),
            hasKey: Boolean(record.key),
            typeHex: `0x${formatMideaTypeHex(record.type)}`,
          }
        : null,
      state,
      configSummary: summarizeMideaConfig(this._config),
      observation: observation ?? {},
    });
    return JSON.stringify(report, null, 2);
  }

  dispose(): void {
    this._lanTransport.close?.();
  }
}
