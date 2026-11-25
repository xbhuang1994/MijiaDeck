// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 小米米家平台提供者（封装现有 MijiaService，保持 100% 向后兼容）

import type { IMijiaService, ProgressCallback, QrLoginData } from "../../core/contracts.ts";
import type { DeviceDetail, DeviceInfo, SceneInfo } from "../../core/models.ts";
import { MijiaService, type MijiaServiceOptions } from "../../core/service.ts";
import { renderQrSvg } from "../../ui/qrSvg.ts";
import type {
  IDevicePlatformProvider,
  PlatformMetadata,
  PlatformQrAuthResult,
  PlatformQrAuthSession,
  PlatformStatus,
} from "../types.ts";

export const MIJIA_PLATFORM_METADATA: PlatformMetadata = {
  id: "mijia",
  name: "米家",
  displayName: "小米米家 (MIoT)",
  badgeText: "米家",
  accentColor: "#00cc92",
  description: "原生 MIoT 云端协议，支持米家 App 扫码登录、全品类设备控制、小爱音箱与 CS2 摄像机预览",
  reference: "Do1e/mijia-api & Xiaomi Home (ha_xiaomi_home)",
  capabilities: {
    cloud: true,
    local: false,
    qrAuth: true,
    credentialsAuth: false,
    openApiAuth: false,
    lanDiscovery: false,
    scenes: true,
  },
};

export class MijiaPlatformProvider implements IDevicePlatformProvider {
  readonly id = "mijia" as const;
  readonly metadata = MIJIA_PLATFORM_METADATA;

  private readonly _service: IMijiaService;
  private _lastDeviceCount = 0;
  private _lastSceneCount = 0;
  private _lastSyncAt: number | null = null;
  private _lastError: string | null = null;
  private _pendingQr = new Map<string, QrLoginData>();

  constructor(service?: IMijiaService, options?: MijiaServiceOptions) {
    this._service = service ?? new MijiaService(options);
  }

  get innerService(): IMijiaService {
    return this._service;
  }

  setControlAccess(message = ""): void {
    this._service.setControlAccess(message);
  }

  isEnabled(): boolean {
    return true;
  }

  isConnected(): Promise<boolean> | boolean {
    return this._service.loginStatus();
  }

  status(): PlatformStatus {
    let connected = false;
    try {
      const st = this._service.loginStatus();
      connected = typeof st === "boolean" ? st : false;
    } catch {
      connected = false;
    }
    const accountId = this._service.accountId();
    return {
      ...this.metadata,
      enabled: true,
      connected,
      state: connected ? "connected" : this._lastError ? "error" : "disconnected",
      authMode: "qr",
      deviceCount: this._lastDeviceCount,
      sceneCount: this._lastSceneCount,
      lastSyncAt: this._lastSyncAt,
      lastError: this._lastError,
      configSummary: {
        loggedIn: connected,
        accountId: accountId ? `${accountId.slice(0, 3)}***` : "",
        apiVersion: this._service.apiVersion(),
      },
    };
  }

  async configure(_config: Record<string, unknown>): Promise<PlatformStatus> {
    return this.status();
  }

  async disconnect(): Promise<void> {
    await this._service.logout();
    this._lastDeviceCount = 0;
    this._lastSceneCount = 0;
    this._lastError = null;
  }

  async beginQrAuth(): Promise<PlatformQrAuthSession> {
    const data = await this._service.qrLoginBegin();
    if (!data) {
      return {
        platform: "mijia",
        sessionId: "already-logged-in",
        qrContent: "",
        expiresAt: Date.now() + 60_000,
        hint: "米家会话已自动刷新，无需重新扫码",
      };
    }
    const sessionId = `mijia-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this._pendingQr.set(sessionId, data);
    const qrContent = data.loginUrl || "";
    return {
      platform: "mijia",
      sessionId,
      qrContent,
      qrSvg: qrContent ? renderQrSvg(qrContent) : undefined,
      expiresAt: Date.now() + 120_000,
      hint: "请使用「米家 App」扫描二维码完成登录",
    };
  }

  async pollQrAuth(sessionId: string): Promise<PlatformQrAuthResult> {
    if (sessionId === "already-logged-in") {
      return {
        platform: "mijia",
        status: "success",
        message: "已登录米家账号",
        platformStatus: this.status(),
      };
    }
    const data = this._pendingQr.get(sessionId);
    if (!data) {
      return {
        platform: "mijia",
        status: "expired",
        message: "二维码会话已失效，请重新获取",
      };
    }
    try {
      await this._service.qrLoginWait(data);
      this._pendingQr.delete(sessionId);
      this._lastError = null;
      return {
        platform: "mijia",
        status: "success",
        message: "米家登录成功",
        platformStatus: this.status(),
      };
    } catch (err) {
      this._pendingQr.delete(sessionId);
      const msg = err instanceof Error ? err.message : String(err);
      this._lastError = msg;
      return {
        platform: "mijia",
        status: "error",
        message: msg,
        platformStatus: this.status(),
      };
    }
  }

  async listDevices(progress?: ProgressCallback): Promise<DeviceInfo[]> {
    try {
      const devices = await this._service.listDevices(progress);
      this._lastDeviceCount = devices.length;
      this._lastSyncAt = Date.now();
      this._lastError = null;
      return devices;
    } catch (err) {
      this._lastError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  deviceDetail(nativeDid: string): Promise<DeviceDetail> {
    return this._service.deviceDetail(nativeDid);
  }

  readProp(nativeDid: string, name: string): Promise<unknown> {
    return this._service.readProp(nativeDid, name);
  }

  readProps(nativeDid: string, names: string[]): Promise<Record<string, unknown>> {
    return this._service.readProps(nativeDid, names);
  }

  writeProp(nativeDid: string, name: string, value: unknown): Promise<void> {
    return this._service.writeProp(nativeDid, name, value);
  }

  runAction(nativeDid: string, name: string, params?: unknown): Promise<void> {
    return this._service.runAction(nativeDid, name, params);
  }

  powerState(nativeDid: string): Promise<boolean | null> {
    return this._service.powerState(nativeDid);
  }

  togglePower(nativeDid: string): Promise<boolean> {
    return this._service.togglePower(nativeDid);
  }

  setPowerState(nativeDid: string, state: boolean): Promise<void> {
    return this._service.setPowerState(nativeDid, state);
  }

  powerStates(nativeDids: string[]): Promise<Record<string, boolean | null>> {
    return this._service.powerStates(nativeDids);
  }

  readMetrics(nativeDids: string[]): Promise<Record<string, string | null>> {
    return this._service.readMetrics(nativeDids);
  }

  async sceneList(homeName?: string | null): Promise<SceneInfo[]> {
    const scenes = await this._service.sceneList(homeName);
    this._lastSceneCount = scenes.length;
    return scenes;
  }

  runScene(scene: SceneInfo): Promise<void> {
    return this._service.runScene(scene);
  }

  diagnosticReport(
    device: DeviceInfo,
    observation?: Record<string, unknown> | null,
  ): Promise<string> {
    return this._service.deviceDiagnosticReport(device, observation);
  }
}
