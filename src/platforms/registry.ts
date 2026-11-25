// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 多平台注册表与统一聚合服务 (MultiPlatformService)

import type { IMijiaService, ProgressCallback, QrLoginData } from "../core/contracts.ts";
import { buildReport } from "../core/diagnostics.ts";
import {
  createDeviceInfo,
  createSceneInfo,
  type DeviceDetail,
  type DeviceInfo,
  type PlatformId,
  type SceneInfo,
} from "../core/models.ts";
import { ServiceError } from "../core/service.ts";
import {
  namespaceDid,
  namespaceSceneId,
  parseNamespacedDid,
  parseNamespacedSceneId,
} from "./configStore.ts";
import { MijiaPlatformProvider } from "./mijia/provider.ts";
import type {
  DiscoveredLocalDevice,
  IDevicePlatformProvider,
  IMultiPlatformService,
  PlatformQrAuthResult,
  PlatformQrAuthSession,
  PlatformStatus,
} from "./types.ts";

function compareStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function namespaceDevice(platform: PlatformId, device: DeviceInfo): DeviceInfo {
  if (platform === "mijia") {
    return device;
  }
  return createDeviceInfo({
    ...device,
    did: namespaceDid(platform, device.did),
    switch_channels: device.switch_channels.map((ch) => namespaceDid(platform, ch)),
    platform,
  });
}

function namespaceScene(platform: PlatformId, scene: SceneInfo): SceneInfo {
  if (platform === "mijia") {
    return scene;
  }
  return createSceneInfo({
    ...scene,
    scene_id: namespaceSceneId(platform, scene.scene_id),
    platform,
  });
}

/**
 * 平台插件注册表：管理所有已注册的智能家居平台提供者。
 */
export class PlatformRegistry {
  private readonly _providers = new Map<PlatformId, IDevicePlatformProvider>();

  register(provider: IDevicePlatformProvider): this {
    this._providers.set(provider.id, provider);
    return this;
  }

  unregister(id: PlatformId): boolean {
    return this._providers.delete(id);
  }

  get(id: PlatformId): IDevicePlatformProvider | null {
    return this._providers.get(id) ?? null;
  }

  all(): IDevicePlatformProvider[] {
    return [...this._providers.values()];
  }

  listStatuses(): PlatformStatus[] {
    return this.all().map((p) => p.status());
  }
}

export interface MultiPlatformServiceOptions {
  registry?: PlatformRegistry;
  providers?: IDevicePlatformProvider[];
  primaryMijia?: MijiaPlatformProvider;
}

/**
 * 多平台聚合服务：实现完整 IMijiaService + IMultiPlatformService 合约。
 *
 * 设计原则：
 * 1. 对上游（MainWindowController / Routes / PiAgent）完全透明，复用现有 UI/工具/轮询管线；
 * 2. 并行拉取各已连接平台设备、电源状态、指标与场景，单个平台故障严格隔离，不影响其他平台；
 * 3. 米家设备保持无前缀 DID，涂鸦/美的/德业使用 `tuya:` / `midea:` / `deye:` 命名空间精准路由；
 * 4. 只要任一已注册平台处于已连接状态，系统整体即视为已登录可用（支持纯涂鸦/美的/德业独立使用）。
 */
export class MultiPlatformService implements IMultiPlatformService {
  readonly registry: PlatformRegistry;
  private readonly _mijiaProvider: MijiaPlatformProvider | null;
  private _controlBlockReason = "";

  constructor(options: MultiPlatformServiceOptions = {}) {
    this.registry = options.registry ?? new PlatformRegistry();
    if (options.primaryMijia) {
      this.registry.register(options.primaryMijia);
    }
    if (options.providers) {
      for (const provider of options.providers) {
        this.registry.register(provider);
      }
    }
    const existingMijia = this.registry.get("mijia");
    this._mijiaProvider =
      options.primaryMijia ??
      (existingMijia instanceof MijiaPlatformProvider ? existingMijia : null);
  }

  private _mijiaService(): IMijiaService | null {
    return this._mijiaProvider?.innerService ?? null;
  }

  private _requireControlAccess(): void {
    if (this._controlBlockReason) {
      throw new ServiceError(this._controlBlockReason);
    }
  }

  private _resolveProviderForDid(did: string): {
    provider: IDevicePlatformProvider;
    platform: PlatformId;
    nativeDid: string;
  } {
    const { platform, nativeDid } = parseNamespacedDid(did);
    const provider = this.registry.get(platform);
    if (!provider) {
      throw new ServiceError(`未找到设备所属平台提供者：${platform}`);
    }
    return { provider, platform, nativeDid };
  }

  // ---------- 平台治理扩展 ----------

  listPlatforms(): PlatformStatus[] {
    return this.registry.listStatuses();
  }

  getPlatformStatus(id: PlatformId): PlatformStatus | null {
    return this.registry.get(id)?.status() ?? null;
  }

  getProvider(id: PlatformId): IDevicePlatformProvider | null {
    return this.registry.get(id);
  }

  async configurePlatform(
    id: PlatformId,
    config: Record<string, unknown>,
  ): Promise<PlatformStatus> {
    const provider = this.registry.get(id);
    if (!provider) {
      throw new ServiceError(`不支持的平台标识：${id}`);
    }
    return await provider.configure(config);
  }

  async disconnectPlatform(id: PlatformId): Promise<PlatformStatus> {
    const provider = this.registry.get(id);
    if (!provider) {
      throw new ServiceError(`不支持的平台标识：${id}`);
    }
    await provider.disconnect();
    return provider.status();
  }

  async beginPlatformQrAuth(
    id: PlatformId,
    params: Record<string, unknown> = {},
  ): Promise<PlatformQrAuthSession> {
    const provider = this.registry.get(id);
    if (!provider) {
      throw new ServiceError(`不支持的平台标识：${id}`);
    }
    if (typeof provider.beginQrAuth !== "function") {
      throw new ServiceError(`平台「${provider.metadata.displayName}」不支持二维码登录`);
    }
    return await provider.beginQrAuth(params);
  }

  async pollPlatformQrAuth(id: PlatformId, sessionId: string): Promise<PlatformQrAuthResult> {
    const provider = this.registry.get(id);
    if (!provider) {
      throw new ServiceError(`不支持的平台标识：${id}`);
    }
    if (typeof provider.pollQrAuth !== "function") {
      throw new ServiceError(`平台「${provider.metadata.displayName}」不支持二维码登录`);
    }
    return await provider.pollQrAuth(sessionId);
  }

  async discoverPlatformLocal(
    id: PlatformId,
    options?: { timeoutMs?: number },
  ): Promise<DiscoveredLocalDevice[]> {
    const provider = this.registry.get(id);
    if (!provider) {
      throw new ServiceError(`不支持的平台标识：${id}`);
    }
    if (typeof provider.discoverLocal !== "function") {
      throw new ServiceError(`平台「${provider.metadata.displayName}」不支持局域网发现`);
    }
    return await provider.discoverLocal(options);
  }

  // ---------- IMijiaService 实现 ----------

  setControlAccess(message = ""): void {
    this._controlBlockReason = message;
    for (const provider of this.registry.all()) {
      provider.setControlAccess?.(message);
    }
  }

  apiVersion(): string {
    const mijiaVer = this._mijiaService()?.apiVersion() ?? "multi-1.0";
    const activeExternal = this.registry
      .all()
      .filter((p) => p.id !== "mijia" && p.isEnabled())
      .map((p) => p.id);
    return activeExternal.length > 0 ? `${mijiaVer} (+${activeExternal.join(",")})` : mijiaVer;
  }

  accountId(): string {
    const mijiaId = this._mijiaService()?.accountId() ?? "";
    if (mijiaId) {
      return mijiaId;
    }
    const connected = this.registry
      .all()
      .filter((p) => p.id !== "mijia" && p.isEnabled() && p.status().connected)
      .map((p) => p.id);
    return connected.length > 0 ? `multi:${connected.join("+")}` : "";
  }

  async logout(): Promise<void> {
    const mijia = this._mijiaService();
    if (mijia && (await mijia.loginStatus())) {
      await mijia.logout();
      return;
    }
    // 若仅连接了第三方平台，则依次断开第三方平台
    const connectedExternals = this.registry
      .all()
      .filter((p) => p.id !== "mijia" && p.isEnabled() && p.status().connected);
    if (connectedExternals.length > 0) {
      await Promise.allSettled(connectedExternals.map((p) => p.disconnect()));
      return;
    }
    if (mijia) {
      await mijia.logout();
    }
  }

  async loginStatus(): Promise<boolean> {
    for (const provider of this.registry.all()) {
      if (!provider.isEnabled()) continue;
      try {
        if (await provider.isConnected()) {
          return true;
        }
      } catch {
        // ignore single provider check error
      }
    }
    return false;
  }

  async qrLoginBegin(): Promise<QrLoginData | null> {
    const mijia = this._mijiaService();
    if (!mijia) {
      throw new ServiceError("当前未启用米家平台提供者");
    }
    return await mijia.qrLoginBegin();
  }

  async qrLoginWait(loginData: QrLoginData): Promise<void> {
    const mijia = this._mijiaService();
    if (!mijia) {
      throw new ServiceError("当前未启用米家平台提供者");
    }
    await mijia.qrLoginWait(loginData);
  }

  async listDevices(progress?: ProgressCallback): Promise<DeviceInfo[]> {
    const candidates: IDevicePlatformProvider[] = [];
    for (const provider of this.registry.all()) {
      if (!provider.isEnabled()) continue;
      try {
        if (await provider.isConnected()) {
          candidates.push(provider);
        }
      } catch {
        // skip disconnected provider
      }
    }

    if (candidates.length === 0) {
      return [];
    }

    progress?.(12, `正在并行同步 ${candidates.length} 个平台设备…`);

    const results = await Promise.allSettled(
      candidates.map(async (provider) => {
        const subProgress: ProgressCallback | undefined =
          candidates.length === 1 && provider.id === "mijia" ? progress : undefined;
        const rawDevices = await provider.listDevices(subProgress);
        return rawDevices.map((d) => namespaceDevice(provider.id, d));
      }),
    );

    const aggregated: DeviceInfo[] = [];
    const errors: Error[] = [];
    for (let i = 0; i < results.length; i++) {
      const outcome = results[i]!;
      if (outcome.status === "fulfilled") {
        aggregated.push(...outcome.value);
      } else {
        const err =
          outcome.reason instanceof Error ? outcome.reason : new Error(String(outcome.reason));
        errors.push(err);
      }
    }

    // 仅当全部活跃平台均失败时向上抛错；单个平台异常隔离在各自 status.lastError 中
    if (aggregated.length === 0 && errors.length === candidates.length && errors.length > 0) {
      throw errors[0]!;
    }

    progress?.(78, `已聚合 ${aggregated.length} 台多平台设备…`);
    return aggregated.sort(
      (a, b) =>
        compareStr(a.home_name, b.home_name) ||
        compareStr(a.room_name, b.room_name) ||
        compareStr(a.name, b.name) ||
        compareStr(a.did, b.did),
    );
  }

  async deviceDetail(did: string): Promise<DeviceDetail> {
    const { provider, platform, nativeDid } = this._resolveProviderForDid(did);
    const detail = await provider.deviceDetail(nativeDid);
    return {
      ...detail,
      did: namespaceDid(platform, detail.did || nativeDid),
    };
  }

  async readProp(did: string, name: string): Promise<unknown> {
    const { provider, nativeDid } = this._resolveProviderForDid(did);
    return await provider.readProp(nativeDid, name);
  }

  async readProps(did: string, names: string[]): Promise<Record<string, unknown>> {
    const { provider, nativeDid } = this._resolveProviderForDid(did);
    return await provider.readProps(nativeDid, names);
  }

  async writeProp(did: string, name: string, value: unknown): Promise<void> {
    this._requireControlAccess();
    const { provider, nativeDid } = this._resolveProviderForDid(did);
    await provider.writeProp(nativeDid, name, value);
  }

  async runAction(did: string, name: string, params?: unknown): Promise<void> {
    this._requireControlAccess();
    const { provider, nativeDid } = this._resolveProviderForDid(did);
    await provider.runAction(nativeDid, name, params);
  }

  async powerState(did: string): Promise<boolean | null> {
    const { provider, nativeDid } = this._resolveProviderForDid(did);
    return await provider.powerState(nativeDid);
  }

  async togglePower(did: string): Promise<boolean> {
    this._requireControlAccess();
    const { provider, nativeDid } = this._resolveProviderForDid(did);
    return await provider.togglePower(nativeDid);
  }

  async setPowerState(did: string, state: boolean): Promise<void> {
    this._requireControlAccess();
    const { provider, nativeDid } = this._resolveProviderForDid(did);
    await provider.setPowerState(nativeDid, state);
  }

  async powerStates(dids: string[]): Promise<Record<string, boolean | null>> {
    const groups = new Map<PlatformId, Array<{ fullDid: string; nativeDid: string }>>();
    for (const did of dids) {
      const { platform, nativeDid } = parseNamespacedDid(did);
      let list = groups.get(platform);
      if (!list) {
        list = [];
        groups.set(platform, list);
      }
      list.push({ fullDid: did, nativeDid });
    }

    const result: Record<string, boolean | null> = {};
    await Promise.allSettled(
      [...groups.entries()].map(async ([platform, entries]) => {
        const provider = this.registry.get(platform);
        if (!provider || !provider.isEnabled()) {
          for (const e of entries) result[e.fullDid] = null;
          return;
        }
        try {
          const states = await provider.powerStates(entries.map((e) => e.nativeDid));
          for (const e of entries) {
            result[e.fullDid] = e.nativeDid in states ? (states[e.nativeDid] ?? null) : null;
          }
        } catch {
          for (const e of entries) result[e.fullDid] = null;
        }
      }),
    );
    return result;
  }

  async readMetrics(dids: string[]): Promise<Record<string, string | null>> {
    const groups = new Map<PlatformId, Array<{ fullDid: string; nativeDid: string }>>();
    for (const did of dids) {
      const { platform, nativeDid } = parseNamespacedDid(did);
      let list = groups.get(platform);
      if (!list) {
        list = [];
        groups.set(platform, list);
      }
      list.push({ fullDid: did, nativeDid });
    }

    const result: Record<string, string | null> = {};
    await Promise.allSettled(
      [...groups.entries()].map(async ([platform, entries]) => {
        const provider = this.registry.get(platform);
        if (!provider || !provider.isEnabled()) {
          for (const e of entries) result[e.fullDid] = null;
          return;
        }
        try {
          const metrics = await provider.readMetrics(entries.map((e) => e.nativeDid));
          for (const e of entries) {
            result[e.fullDid] = e.nativeDid in metrics ? (metrics[e.nativeDid] ?? null) : null;
          }
        } catch {
          for (const e of entries) result[e.fullDid] = null;
        }
      }),
    );
    return result;
  }

  async sceneList(homeName?: string | null): Promise<SceneInfo[]> {
    const providers = this.registry.all().filter((p) => p.isEnabled() && p.metadata.capabilities.scenes);
    const settled = await Promise.allSettled(
      providers.map(async (provider) => {
        if (!(await provider.isConnected())) return [];
        const list = await provider.sceneList(homeName);
        return list.map((sc) => namespaceScene(provider.id, sc));
      }),
    );
    const scenes: SceneInfo[] = [];
    for (const outcome of settled) {
      if (outcome.status === "fulfilled") {
        scenes.push(...outcome.value);
      }
    }
    return scenes.sort(
      (a, b) => compareStr(a.home_name, b.home_name) || compareStr(a.name, b.name),
    );
  }

  async runScene(scene: SceneInfo): Promise<void> {
    this._requireControlAccess();
    const { platform, nativeSceneId } = parseNamespacedSceneId(scene.scene_id);
    const targetPlatform = scene.platform ?? platform;
    const provider = this.registry.get(targetPlatform);
    if (!provider) {
      throw new ServiceError(`未找到场景所属平台：${targetPlatform}`);
    }
    await provider.runScene({
      ...scene,
      scene_id: nativeSceneId,
    });
  }

  async iconUrls(models: string[]): Promise<Record<string, string | null>> {
    const mijia = this._mijiaService();
    if (!mijia) return {};
    const mijiaModels = models.filter(
      (m) => !m.startsWith("tuya.") && !m.startsWith("midea.") && !m.startsWith("deye."),
    );
    if (mijiaModels.length === 0) return {};
    try {
      return await mijia.iconUrls(mijiaModels);
    } catch {
      return {};
    }
  }

  async iconFile(model: string, url: string): Promise<string | null> {
    const mijia = this._mijiaService();
    if (!mijia) return null;
    return await mijia.iconFile(model, url);
  }

  hasProductPageName(model: string): boolean {
    if (model.startsWith("tuya.") || model.startsWith("midea.") || model.startsWith("deye.")) {
      return true;
    }
    return this._mijiaService()?.hasProductPageName(model) ?? false;
  }

  cachedProductPageNames(models: string[]): Record<string, string> {
    return this._mijiaService()?.cachedProductPageNames(models) ?? {};
  }

  async productPageName(model: string): Promise<string | null> {
    if (model.startsWith("tuya.") || model.startsWith("midea.") || model.startsWith("deye.")) {
      return null;
    }
    return (await this._mijiaService()?.productPageName(model)) ?? null;
  }

  specHasPublishedFunctions(specType: string): boolean | null {
    if (
      specType.startsWith("urn:tuya:") ||
      specType.startsWith("urn:midea:") ||
      specType.startsWith("urn:deye:")
    ) {
      return true;
    }
    return this._mijiaService()?.specHasPublishedFunctions(specType) ?? null;
  }

  localizedProductNames(dids: string[], names: Record<string, string>): Record<string, string> {
    const mijiaDids = dids.filter((d) => parseNamespacedDid(d).platform === "mijia");
    if (mijiaDids.length === 0) return {};
    return this._mijiaService()?.localizedProductNames(mijiaDids, names) ?? {};
  }

  async prepareCameraSource(device: DeviceInfo): Promise<unknown> {
    this._requireControlAccess();
    const { platform } = parseNamespacedDid(device.did);
    if (platform !== "mijia") {
      throw new ServiceError("当前远程摄像机预览仅支持米家 CS2 摄像机");
    }
    const mijia = this._mijiaService();
    if (!mijia) {
      throw new ServiceError("未启用米家平台提供者");
    }
    return await mijia.prepareCameraSource(device);
  }

  recordDeviceObservation(did: string, observation: Record<string, unknown>): void {
    const { platform, nativeDid } = parseNamespacedDid(did);
    if (platform === "mijia") {
      this._mijiaService()?.recordDeviceObservation(nativeDid, observation);
    }
  }

  async deviceDiagnosticReport(
    device: DeviceInfo,
    observation?: Record<string, unknown> | null,
  ): Promise<string> {
    const { provider, platform, nativeDid } = this._resolveProviderForDid(device.did);
    if (typeof provider.diagnosticReport === "function") {
      return await provider.diagnosticReport({ ...device, did: nativeDid }, observation);
    }
    return buildReport(device, {
      specStatus: `platform:${platform}`,
      region: platform,
      observation: observation ?? {},
    });
  }

  async dispose(): Promise<void> {
    await Promise.allSettled(
      this.registry.all().map((provider) => Promise.resolve(provider.dispose?.())),
    );
  }
}
