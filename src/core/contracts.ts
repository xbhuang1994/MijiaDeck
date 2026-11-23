// SPDX-License-Identifier: GPL-3.0-or-later
// Shared cross-module TypeScript contracts for MijiaDeck

import type { DeviceDetail, DeviceInfo, SceneInfo } from "./models.ts";

export interface JobSubmitOptions<T> {
  onSuccess?: (result: T) => void;
  onError?: (error: Error) => void;
  priority?: number;
}

export interface IJobExecutor {
  submit<T>(fn: () => T | Promise<T>, options?: JobSubmitOptions<T>): void;
  cancelPending(): void;
  shutdown(): Promise<void> | void;
}

export type AccessState = "ready" | "offline" | "signed_out" | "loading" | "unavailable";

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ScreenInfo {
  name: string;
  availableGeometry: Rect;
}

export interface TrayOrderItem {
  type: "device" | "scene";
  id: string;
}

export interface TraySceneSnapshot {
  scene_id: string;
  name: string;
  home_id: string;
  home_name: string;
}

export interface TrayPosition {
  screen: string;
  x: number;
  y: number;
}

export interface QrLoginData {
  loginUrl: string;
  lp: string;
  qr?: string;
  refreshed?: boolean;
  [key: string]: unknown;
}

export interface ProgressCallback {
  (percent: number, message: string): void;
}

export interface IMijiaService {
  setControlAccess(message?: string): void;
  apiVersion(): string;
  accountId(): string;
  logout(): Promise<void> | void;
  loginStatus(): Promise<boolean> | boolean;
  qrLoginBegin(): Promise<QrLoginData | null>;
  qrLoginWait(loginData: QrLoginData): Promise<void>;
  listDevices(progress?: ProgressCallback): Promise<DeviceInfo[]>;
  deviceDetail(did: string): Promise<DeviceDetail>;
  readProp(did: string, name: string): Promise<unknown>;
  readProps(did: string, names: string[]): Promise<Record<string, unknown>>;
  writeProp(did: string, name: string, value: unknown): Promise<void>;
  runAction(did: string, name: string, params?: unknown): Promise<void>;
  powerState(did: string): Promise<boolean | null>;
  togglePower(did: string): Promise<boolean>;
  setPowerState(did: string, state: boolean): Promise<void>;
  powerStates(dids: string[]): Promise<Record<string, boolean | null>>;
  readMetrics(dids: string[]): Promise<Record<string, string | null>>;
  sceneList(homeName?: string | null): Promise<SceneInfo[]>;
  runScene(scene: SceneInfo): Promise<void>;
  iconUrls(models: string[]): Promise<Record<string, string | null>>;
  iconFile(model: string, url: string): Promise<string | null>;
  hasProductPageName(model: string): boolean;
  cachedProductPageNames(models: string[]): Record<string, string>;
  productPageName(model: string): Promise<string | null>;
  specHasPublishedFunctions(specType: string): boolean | null;
  localizedProductNames(dids: string[], names: Record<string, string>): Record<string, string>;
  prepareCameraSource(device: DeviceInfo): Promise<unknown>;
  recordDeviceObservation(did: string, observation: Record<string, unknown>): void;
  deviceDiagnosticReport(device: DeviceInfo, observation?: Record<string, unknown> | null): Promise<string>;
}

export class TypedEmitter<Events extends Record<string, unknown[]>> {
  private listeners = new Map<keyof Events, Set<(...args: unknown[]) => void>>();

  on<K extends keyof Events>(event: K, listener: (...args: Events[K]) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    const wrapped = listener as (...args: unknown[]) => void;
    set.add(wrapped);
    return () => {
      set?.delete(wrapped);
    };
  }

  off<K extends keyof Events>(event: K, listener: (...args: Events[K]) => void): void {
    this.listeners.get(event)?.delete(listener as (...args: unknown[]) => void);
  }

  clear(event?: keyof Events): void {
    if (event !== undefined) {
      this.listeners.delete(event);
    } else {
      this.listeners.clear();
    }
  }

  emit<K extends keyof Events>(event: K, ...args: Events[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const fn of [...set]) {
      fn(...args);
    }
  }
}
