// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/** Network availability and shared UI wording; probes never use account data. */

import { TypedEmitter } from "./contracts.ts";
import { isSpeaker, type DeviceInfo } from "./models.ts";

export const MESSAGES = {
  signed_out: "请先登录小米账号，登录后即可控制设备",
  offline: "网络异常，请连接网络后重试。",
  loading: "正在同步设备，请稍候…",
  unavailable: "网络异常，请连接网络后重试。",
} as const;

export const PROBE_URL = "https://api.io.mi.com/";
export const PROBE_TIMEOUT_MS = 2_500;
export const PROBE_INTERVAL_MS = 5_000;

export type Reachability = "unknown" | "disconnected" | "local" | "site" | "online";

export function speakerHint(devices: DeviceInfo[]): string {
  const speakers = devices.filter((device) => isSpeaker(device));
  if (speakers.length === 0) {
    return "当前你还没有添加任何智能音箱";
  }
  return speakers.some((device) => device.online) ? "" : "智能音箱当前离线";
}

export interface NetworkMonitorOptions {
  initialReachability?: Reachability;
  fetcher?: typeof fetch;
  intervalMs?: number;
  timeoutMs?: number;
  probeUrl?: string;
  autoStart?: boolean;
}

type NetworkMonitorEvents = {
  changed: [boolean];
};

export class NetworkMonitor extends TypedEmitter<NetworkMonitorEvents> {
  online: boolean;

  private readonly _fetcher: typeof fetch;
  private readonly _intervalMs: number;
  private readonly _timeoutMs: number;
  private readonly _probeUrl: string;
  private _timer: ReturnType<typeof setInterval> | null = null;
  private _inFlight: Promise<boolean> | null = null;
  private _abortController: AbortController | null = null;
  private _probeId = 0;

  constructor(options: NetworkMonitorOptions = {}) {
    super();
    this._fetcher = options.fetcher ?? fetch;
    this._intervalMs = options.intervalMs ?? PROBE_INTERVAL_MS;
    this._timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
    this._probeUrl = options.probeUrl ?? PROBE_URL;
    this.online = NetworkMonitor.isReachabilityOnline(options.initialReachability ?? "unknown");
    if (options.autoStart ?? false) {
      this.start();
    }
  }

  static isReachabilityOnline(reachability: Reachability): boolean {
    // Unknown/backend unavailable is not proof of disconnection. Actual
    // request failures still surface normally; never infer logout from them.
    return reachability === "unknown" || reachability === "online";
  }

  onSystemReachabilityChanged(reachability: Reachability): void {
    // A VPN/virtual adapter can leave Windows reporting Online after Wi-Fi
    // is disconnected. Only a fresh HTTPS result can restore availability.
    if (!NetworkMonitor.isReachabilityOnline(reachability)) {
      this._setOnline(false);
    }
    void this.checkNow();
  }

  start(): void {
    if (this._timer !== null) {
      return;
    }
    this._timer = setInterval(() => {
      void this.checkNow();
    }, this._intervalMs);
    (this._timer as { unref?: () => void }).unref?.();
    void this.checkNow();
  }

  stop(): void {
    if (this._timer !== null) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this._probeId += 1;
    if (this._abortController !== null) {
      this._abortController.abort();
      this._abortController = null;
    }
    this._inFlight = null;
  }

  checkNow(): Promise<boolean> {
    if (this._inFlight !== null) {
      return this._inFlight;
    }
    const probeId = ++this._probeId;
    const controller = new AbortController();
    this._abortController = controller;
    const deadline = setTimeout(() => {
      controller.abort(new DOMException("Network probe timed out", "TimeoutError"));
    }, this._timeoutMs);
    (deadline as { unref?: () => void }).unref?.();

    // HEAD has no body, credentials or device identifiers. An actual HTTP
    // response (even 401/404) proves transport works; never reuse disk cache.
    const task = (async (): Promise<boolean> => {
      let reachable = false;
      try {
        const response = await this._fetcher(this._probeUrl, {
          method: "HEAD",
          cache: "no-store",
          signal: controller.signal,
        });
        await response.body?.cancel?.().catch(() => {});
        reachable =
          typeof response.status === "number" && response.status >= 200 && response.status < 500;
      } catch {
        reachable = false;
      } finally {
        clearTimeout(deadline);
        if (this._probeId === probeId) {
          this._inFlight = null;
          this._abortController = null;
        }
      }
      if (this._probeId === probeId) {
        this._setOnline(reachable);
      }
      return this.online;
    })();

    this._inFlight = task;
    return task;
  }

  private _setOnline(online: boolean): void {
    if (online !== this.online) {
      this.online = online;
      this.emit("changed", online);
    }
  }
}
