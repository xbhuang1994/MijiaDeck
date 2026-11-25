// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 多平台智能家居接入核心合约 (Bun + TypeScript)

import type { IMijiaService, ProgressCallback } from "../core/contracts.ts";
import type { DeviceDetail, DeviceInfo, PlatformId, SceneInfo } from "../core/models.ts";

export type { PlatformId };

export const ALL_PLATFORM_IDS: readonly PlatformId[] = ["mijia", "tuya", "midea", "deye"] as const;

export type PlatformAuthMode = "qr" | "credentials" | "openapi" | "local" | "hybrid";

export type PlatformConnectionState = "connected" | "disconnected" | "configuring" | "error";

export interface PlatformCapabilities {
  cloud: boolean;
  local: boolean;
  qrAuth: boolean;
  credentialsAuth: boolean;
  openApiAuth: boolean;
  lanDiscovery: boolean;
  scenes: boolean;
}

export interface PlatformMetadata {
  id: PlatformId;
  name: string;
  displayName: string;
  badgeText: string;
  accentColor: string;
  description: string;
  reference: string;
  capabilities: PlatformCapabilities;
}

export interface PlatformQrAuthSession {
  platform: PlatformId;
  sessionId: string;
  qrContent: string;
  qrSvg?: string;
  expiresAt: number;
  hint: string;
  meta?: Record<string, unknown>;
}

export interface PlatformQrAuthResult {
  platform: PlatformId;
  status: "pending" | "success" | "expired" | "error";
  message?: string;
  platformStatus?: PlatformStatus;
}

export interface DiscoveredLocalDevice {
  platform: PlatformId;
  id: string;
  name: string;
  ip: string;
  port: number;
  protocolVersion: string;
  model?: string;
  typeCode?: string;
  mac?: string;
  requiresCredentials?: boolean;
  meta?: Record<string, unknown>;
}

export interface PlatformStatus {
  id: PlatformId;
  name: string;
  displayName: string;
  badgeText: string;
  accentColor: string;
  description: string;
  reference: string;
  enabled: boolean;
  connected: boolean;
  state: PlatformConnectionState;
  authMode: PlatformAuthMode;
  deviceCount: number;
  sceneCount: number;
  lastSyncAt: number | null;
  lastError: string | null;
  capabilities: PlatformCapabilities;
  /** 脱敏后的配置摘要（绝不包含密码、密钥或令牌明文）。 */
  configSummary: Record<string, unknown>;
}

/**
 * 统一的设备平台提供者合约（参考 Home Assistant Integration Coordinator 模式）。
 *
 * 每个平台模块（mijia / tuya / midea / deye）独立实现本接口，
 * 内部仅处理平台原生设备 ID（nativeDid）；跨平台命名空间前缀（如 `tuya:<id>`）
 * 与多平台并行聚合、故障隔离由 PlatformRegistry / MultiPlatformService 统一负责。
 */
export interface IDevicePlatformProvider {
  readonly id: PlatformId;
  readonly metadata: PlatformMetadata;

  setControlAccess?(message?: string): void;
  isEnabled(): boolean;
  isConnected(): Promise<boolean> | boolean;
  status(): PlatformStatus;

  /** 保存并验证平台配置；返回更新后的脱敏状态。 */
  configure(config: Record<string, unknown>): Promise<PlatformStatus>;
  /** 断开并清理当前平台会话或凭据。 */
  disconnect(): Promise<void>;

  /** 可选：启动二维码登录流程（如 Tuya Home Assistant Device Sharing QR）。 */
  beginQrAuth?(params: Record<string, unknown>): Promise<PlatformQrAuthSession>;
  /** 可选：轮询二维码扫码状态并在成功后自动持久化会话。 */
  pollQrAuth?(sessionId: string): Promise<PlatformQrAuthResult>;
  /** 可选：局域网设备广播发现（如 Tuya UDP 6666/6667、Midea UDP 6445）。 */
  discoverLocal?(options?: { timeoutMs?: number }): Promise<DiscoveredLocalDevice[]>;

  listDevices(progress?: ProgressCallback): Promise<DeviceInfo[]>;
  deviceDetail(nativeDid: string): Promise<DeviceDetail>;
  readProp(nativeDid: string, name: string): Promise<unknown>;
  readProps(nativeDid: string, names: string[]): Promise<Record<string, unknown>>;
  writeProp(nativeDid: string, name: string, value: unknown): Promise<void>;
  runAction(nativeDid: string, name: string, params?: unknown): Promise<void>;

  powerState(nativeDid: string): Promise<boolean | null>;
  togglePower(nativeDid: string): Promise<boolean>;
  setPowerState(nativeDid: string, state: boolean): Promise<void>;
  powerStates(nativeDids: string[]): Promise<Record<string, boolean | null>>;
  readMetrics(nativeDids: string[]): Promise<Record<string, string | null>>;

  sceneList(homeName?: string | null): Promise<SceneInfo[]>;
  runScene(scene: SceneInfo): Promise<void>;

  diagnosticReport?(device: DeviceInfo, observation?: Record<string, unknown> | null): Promise<string>;
  dispose?(): Promise<void> | void;
}

/**
 * 多平台聚合服务接口：完全向后兼容 IMijiaService，同时暴露平台治理与认证扩展能力。
 */
export interface IMultiPlatformService extends IMijiaService {
  listPlatforms(): PlatformStatus[];
  getPlatformStatus(id: PlatformId): PlatformStatus | null;
  getProvider(id: PlatformId): IDevicePlatformProvider | null;
  configurePlatform(id: PlatformId, config: Record<string, unknown>): Promise<PlatformStatus>;
  disconnectPlatform(id: PlatformId): Promise<PlatformStatus>;
  beginPlatformQrAuth(id: PlatformId, params?: Record<string, unknown>): Promise<PlatformQrAuthSession>;
  pollPlatformQrAuth(id: PlatformId, sessionId: string): Promise<PlatformQrAuthResult>;
  discoverPlatformLocal(id: PlatformId, options?: { timeoutMs?: number }): Promise<DiscoveredLocalDevice[]>;
  dispose?(): Promise<void> | void;
}

export function isMultiPlatformService(service: IMijiaService): service is IMultiPlatformService {
  return (
    typeof (service as Partial<IMultiPlatformService>).listPlatforms === "function" &&
    typeof (service as Partial<IMultiPlatformService>).configurePlatform === "function"
  );
}
