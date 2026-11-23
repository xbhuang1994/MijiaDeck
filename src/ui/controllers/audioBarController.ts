// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/** 托盘快捷窗口顶部的简易音箱控制栏控制器。 */

import { TypedEmitter, type IJobExecutor, type IMijiaService } from "../../core/contracts.ts";
import type { DeviceDetail } from "../../core/models.ts";

export interface VolumeConfirmation {
  target: number;
  deadlineMs: number;
}

export interface AudioBarTimers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface AudioBarService {
  deviceDetail(did: string): DeviceDetail | Promise<DeviceDetail>;
  readProps(did: string, names: string[]): Record<string, unknown> | Promise<Record<string, unknown>>;
  writeProp(did: string, name: string, value: unknown): void | Promise<void>;
  runAction?(did: string, name: string, params?: unknown): void | Promise<void>;
}

export interface AudioBarEvents {
  [key: string]: unknown[];
  speakerRequested: [];
  toastRequested: [message: string, durationMs: number];
  stateChanged: [];
}

export interface AudioBarOptions {
  nowMs?: () => number;
  timers?: Partial<AudioBarTimers>;
  pollIntervalMs?: number;
  commandRefreshDelaysMs?: readonly number[];
  volumeConfirmationMs?: number;
  onToast?: (message: string, durationMs: number) => void;
}

export interface AudioBarSnapshot {
  did: string | null;
  speakerName: string;
  visible: boolean;
  enabled: boolean;
  prevEnabled: boolean;
  nextEnabled: boolean;
  playEnabled: boolean;
  volume: number | null;
  volumeLabel: string;
  sliderValue: number;
  sliderMin: number;
  sliderMax: number;
  sliderDown: boolean;
  sliderEnabled: boolean;
  muted: boolean | null;
  playAccessibleName: string;
  pendingVolume: number | null;
  mutePending: boolean;
  readInFlight: boolean;
  volumeConfirmation: VolumeConfirmation | null;
  pollActive: boolean;
  commandRefreshActive: boolean;
}

interface FetchedAudioState {
  volRange: readonly [number, number] | readonly [number, number, number];
  volName: string;
  muteName: string;
  vals: Record<string, unknown>;
}

const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_COMMAND_REFRESH_DELAYS_MS: readonly number[] = [700, 2200];
const DEFAULT_VOLUME_CONFIRMATION_MS = 6000;

function isPromiseLike<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as PromiseLike<T>).then === "function"
  );
}

function defaultTimers(): AudioBarTimers {
  return {
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * 托盘顶部的简易音箱控制栏控制器：上一首 / 静音(播放暂停) / 下一首 + 音量条。
 */
export class AudioBarController {
  readonly events = new TypedEmitter<AudioBarEvents>();

  did: string | null = null;
  speakerName = "小爱音箱";
  visible = false;
  enabled = true;
  prevEnabled = true;
  nextEnabled = true;
  playEnabled = true;
  volume: number | null = null;
  volumeLabel = "—";
  sliderValue = 0;
  sliderMin = 0;
  sliderMax = 100;
  sliderDown = false;
  sliderEnabled = true;
  muted: boolean | null = null;
  playAccessibleName = "播放";
  pendingVolume: number | null = null;
  mutePending = false;
  readInFlight = false;
  volumeConfirmation: VolumeConfirmation | null = null;

  private readonly service: AudioBarService;
  private readonly jobs: IJobExecutor;
  private readonly nowMs: () => number;
  private readonly timers: AudioBarTimers;
  private readonly pollIntervalMs: number;
  private readonly commandRefreshDelaysMs: readonly number[];
  private readonly volumeConfirmationMs: number;
  private readonly onToast?: (message: string, durationMs: number) => void;

  private speakerRevision = 0;
  private interactionRevision = 0;
  private muteName = "mute-2";
  private volName = "volume";
  private pollHandle: unknown | null = null;
  private commandRefreshHandles: Array<unknown | null>;
  private disposed = false;

  constructor(service: AudioBarService | IMijiaService, jobs: IJobExecutor, options: AudioBarOptions = {}) {
    this.service = service;
    this.jobs = jobs;
    this.nowMs = options.nowMs ?? (() => Date.now());
    const defaults = defaultTimers();
    this.timers = {
      setInterval: options.timers?.setInterval ?? defaults.setInterval,
      clearInterval: options.timers?.clearInterval ?? defaults.clearInterval,
      setTimeout: options.timers?.setTimeout ?? defaults.setTimeout,
      clearTimeout: options.timers?.clearTimeout ?? defaults.clearTimeout,
    };
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.commandRefreshDelaysMs = options.commandRefreshDelaysMs ?? DEFAULT_COMMAND_REFRESH_DELAYS_MS;
    this.volumeConfirmationMs = options.volumeConfirmationMs ?? DEFAULT_VOLUME_CONFIRMATION_MS;
    this.onToast = options.onToast;
    this.commandRefreshHandles = this.commandRefreshDelaysMs.map(() => null);
  }

  get pollActive(): boolean {
    return this.pollHandle !== null;
  }

  get commandRefreshActive(): boolean {
    return this.commandRefreshHandles.some((h) => h !== null);
  }

  get commandRefreshCount(): number {
    return this.commandRefreshHandles.filter((h) => h !== null).length;
  }

  get allCommandRefreshesActive(): boolean {
    return this.commandRefreshHandles.length > 0 && this.commandRefreshHandles.every((h) => h !== null);
  }

  // ---------- 对外：托盘刷新时调用 ----------

  setSpeaker(did: string | null, name = ""): void {
    this.speakerName = name || "小爱音箱";
    if (did === this.did && did !== null) {
      // 同一设备，仅刷新可见性
      if (!this.visible) {
        this.show();
      } else {
        this.emitStateChanged();
      }
      return;
    }
    this.did = did;
    this.speakerRevision += 1;
    this.readInFlight = false;
    this.mutePending = false;
    this.stopCommandRefreshTimers();
    this.volume = null;
    this.pendingVolume = null;
    this.volumeConfirmation = null;
    this.muted = null;
    if (!did) {
      this.hide();
      return;
    }
    const wasVisible = this.visible;
    this.visible = true;
    this.setEnabled(false);
    this.volumeLabel = "…";
    this.sliderEnabled = false;
    if (!wasVisible) {
      this.startPollTimer();
    }
    // 拉取音量范围与当前值
    this.refreshState();
    this.emitStateChanged();
  }

  show(): void {
    if (this.disposed) return;
    if (this.visible) return;
    this.visible = true;
    this.startPollTimer();
    if (this.did) {
      this.refreshState();
    }
    this.emitStateChanged();
  }

  hide(): void {
    this.stopPollTimer();
    this.stopCommandRefreshTimers();
    if (!this.visible) {
      return;
    }
    this.visible = false;
    this.emitStateChanged();
  }

  /** 宿主浮窗隐藏时停止轮询，不清除当前音箱显隐标记。 */
  stopTimers(): void {
    this.stopPollTimer();
    this.stopCommandRefreshTimers();
  }

  /** 宿主浮窗重新显示时，若音频栏可见且有音箱则恢复轮询并刷新。 */
  resumePollingIfVisible(): void {
    if (this.disposed || !this.visible) return;
    if (!this.pollActive) {
      this.startPollTimer();
    }
    if (this.did) {
      this.refreshState();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.stopPollTimer();
    this.stopCommandRefreshTimers();
  }

  private beginInteraction(): void {
    this.interactionRevision += 1;
  }

  refreshAfterCommand(did: string): void {
    if (did !== this.did || !this.visible) {
      return;
    }
    this.beginInteraction();
    this.volumeConfirmation = null;
    this.startCommandRefreshTimers();
    this.emitStateChanged();
  }

  refreshState(): void {
    if (
      this.disposed ||
      !this.did ||
      this.readInFlight ||
      this.sliderDown ||
      this.pendingVolume !== null ||
      this.mutePending
    ) {
      return;
    }
    this.readInFlight = true;
    const revision = this.interactionRevision;
    const did = this.did;

    const onSuccess = (data: FetchedAudioState | null): void => {
      this.readInFlight = false;
      if (
        revision === this.interactionRevision &&
        !this.sliderDown &&
        this.pendingVolume === null &&
        !this.mutePending
      ) {
        this.applyState(data);
      } else {
        this.emitStateChanged();
      }
    };

    const onError = (err: Error): void => {
      this.readInFlight = false;
      if (revision === this.interactionRevision) {
        this.onFetchError(err);
      } else {
        this.emitStateChanged();
      }
    };

    this.submitForSpeaker(() => this.fetchState(did), onSuccess, onError);
  }

  private submitForSpeaker<T>(
    fn: () => T | Promise<T>,
    onSuccess: (result: T) => void,
    onError: (error: Error) => void,
  ): void {
    const revision = this.speakerRevision;
    const deliverSuccess = (result: T): void => {
      if (!this.disposed && revision === this.speakerRevision) {
        onSuccess(result);
      }
    };
    const deliverError = (error: Error): void => {
      if (!this.disposed && revision === this.speakerRevision) {
        onError(error);
      }
    };
    this.jobs.submit(fn, {
      onSuccess: deliverSuccess,
      onError: deliverError,
    });
  }

  private fetchState(did: string | null): FetchedAudioState | null | Promise<FetchedAudioState | null> {
    const targetDid = did || this.did;
    if (!targetDid) {
      return null;
    }

    const continueWithDetail = (detail: DeviceDetail | null): FetchedAudioState | Promise<FetchedAudioState> => {
      let volRange: readonly [number, number] | readonly [number, number, number] = [0, 100, 1];
      let muteName = "mute-2";
      let volName = "volume";
      if (detail !== null) {
        // 不能在命中 mute-2 时 break：若它在 spec 里排在 volume
        // 前面，音量范围将永远读不到
        let mute2Found = false;
        for (const p of detail.props) {
          if (p.name === "volume" && p.range && p.range.length >= 2) {
            volRange = p.range;
            volName = p.name;
          }
          if (p.name === "mute-2") {
            mute2Found = true;
          }
        }
        // 未命中 mute-2，找首个非 mute-4 的 mute（排除麦克风）
        if (!mute2Found) {
          for (const p of detail.props) {
            if (p.name.startsWith("mute") && p.writable && p.name !== "mute-4") {
              muteName = p.name;
              break;
            }
          }
        }
      }

      const fallbackVals: Record<string, unknown> = {
        [volName]: null,
        [muteName]: null,
      };
      const buildResult = (vals: Record<string, unknown>): FetchedAudioState => ({
        volRange,
        volName,
        muteName,
        vals,
      });

      try {
        const readResult = this.service.readProps(targetDid, [volName, muteName]);
        if (isPromiseLike(readResult)) {
          return Promise.resolve(readResult)
            .then((vals) => buildResult(vals))
            .catch(() => buildResult(fallbackVals));
        }
        return buildResult(readResult);
      } catch {
        return buildResult(fallbackVals);
      }
    };

    try {
      const detailResult = this.service.deviceDetail(targetDid);
      if (isPromiseLike(detailResult)) {
        return Promise.resolve(detailResult)
          .then((detail) => continueWithDetail(detail))
          .catch(() => continueWithDetail(null));
      }
      return continueWithDetail(detailResult);
    } catch {
      return continueWithDetail(null);
    }
  }

  private applyState(data: FetchedAudioState | null): void {
    if (this.disposed || data === null || this.did === null) {
      return;
    }
    const volRange = data.volRange ?? [0, 100, 1];
    this.sliderMin = Math.trunc(volRange[0]);
    this.sliderMax = Math.trunc(volRange[1]);
    this.muteName = data.muteName || "mute-2";
    this.volName = data.volName || "volume";
    const vals = data.vals ?? {};

    let vol: unknown = vals[this.volName];
    const mute: unknown = vals[this.muteName];

    // 写入成功不代表云端读缓存立即更新。短暂保留刚设定的值，
    // 读到目标值即解除保护；超时后仍以设备实际读数为准。
    if (this.volumeConfirmation !== null && typeof vol === "number" && Number.isFinite(vol)) {
      const { target, deadlineMs } = this.volumeConfirmation;
      if (Math.trunc(vol) === target || this.nowMs() >= deadlineMs) {
        this.volumeConfirmation = null;
      } else {
        vol = null;
      }
    }

    if (typeof vol === "number" && Number.isFinite(vol)) {
      const intVol = Math.trunc(vol);
      this.sliderValue = Math.max(this.sliderMin, Math.min(this.sliderMax, intVol));
      this.volumeLabel = String(intVol);
      this.volume = intVol;
    } else if (this.volume === null) {
      this.volumeLabel = "—";
    }

    if (typeof mute === "boolean") {
      this.muted = mute;
    } else if (typeof mute === "number") {
      this.muted = Boolean(mute);
    }

    this.refreshPlayStyle();
    this.setEnabled(true);
    this.emitStateChanged();
  }

  private onFetchError(_err: Error): void {
    if (this.disposed) {
      return;
    }
    if (this.volume === null) {
      this.volumeLabel = "—";
    }
    this.setEnabled(this.did !== null);
    this.emitStateChanged();
  }

  private setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.prevEnabled = enabled;
    this.nextEnabled = enabled;
    this.playEnabled = enabled;
    this.sliderEnabled = enabled;
  }

  private refreshPlayStyle(): void {
    // 按钮点击切换静音：已静音显示「播放」（点击恢复），未静音显示「暂停」
    this.playAccessibleName = this.muted ? "播放" : "暂停";
  }

  // ---------- 交互 ----------

  requestSpeaker(): void {
    this.events.emit("speakerRequested");
  }

  setSliderValue(value: number): void {
    const clamped = Math.max(this.sliderMin, Math.min(this.sliderMax, Math.trunc(value)));
    this.sliderValue = clamped;
    this.volumeLabel = String(clamped);
    this.emitStateChanged();
  }

  previewSlider(value: number): void {
    this.setSliderValue(value);
  }

  setSliderDown(down: boolean): void {
    if (this.sliderDown === down) {
      return;
    }
    this.sliderDown = down;
    if (down) {
      this.beginInteraction();
      this.emitStateChanged();
    } else {
      this.commitSlider();
    }
  }

  commitSlider(): void {
    if (!this.did) {
      return;
    }
    const v = Math.trunc(this.sliderValue);
    this.beginInteraction();
    // 松手才下发，避免拖动连击
    this.pendingVolume = v;
    this.volumeConfirmation = null;
    this.sliderEnabled = false;
    const did = this.did;
    const prop = this.volName;
    this.emitStateChanged();

    this.submitForSpeaker(
      () => this.service.writeProp(did, prop, v),
      () => this.onVolumeWritten(v),
      (err) => this.onVolumeError(err),
    );
  }

  private onVolumeWritten(v: number): void {
    if (this.disposed) return;
    this.volume = v;
    this.pendingVolume = null;
    this.sliderEnabled = true;
    if (this.did) {
      this.refreshAfterCommand(this.did);
    }
    this.volumeConfirmation = {
      target: v,
      deadlineMs: this.nowMs() + this.volumeConfirmationMs,
    };
    this.emitStateChanged();
  }

  private onVolumeError(err: Error): void {
    if (this.disposed) return;
    this.pendingVolume = null;
    this.volumeConfirmation = null;
    this.sliderEnabled = true;
    // 回滚为旧值
    if (this.volume !== null) {
      this.sliderValue = Math.max(this.sliderMin, Math.min(this.sliderMax, Math.trunc(this.volume)));
      this.volumeLabel = String(Math.trunc(this.volume));
    }
    this.notifyToast(`音量设置失败：${toError(err).message}`, 2500);
    this.emitStateChanged();
  }

  toggleMute(): void {
    if (!this.did) {
      return;
    }
    this.beginInteraction();
    this.mutePending = true;
    // 若尚未读到状态，按切换为静音处理
    const newVal = typeof this.muted === "boolean" ? !this.muted : true;
    this.playEnabled = false;
    const did = this.did;
    const mn = this.muteName;
    this.emitStateChanged();

    this.submitForSpeaker(
      () => this.service.writeProp(did, mn, newVal),
      () => this.onMuteWritten(newVal),
      (err) => this.onMuteError(err),
    );
  }

  private onMuteWritten(newVal: boolean): void {
    if (this.disposed) return;
    this.muted = newVal;
    this.mutePending = false;
    this.refreshPlayStyle();
    this.playEnabled = true;
    if (this.did) {
      this.refreshAfterCommand(this.did);
    }
    this.emitStateChanged();
  }

  private onMuteError(err: Error): void {
    if (this.disposed) return;
    this.mutePending = false;
    this.playEnabled = true;
    this.notifyToast(`静音切换失败：${toError(err).message}`, 2500);
    this.emitStateChanged();
  }

  prev(): void {
    if (!this.did || !this.service.runAction) {
      return;
    }
    this.prevEnabled = false;
    const did = this.did;
    this.emitStateChanged();
    this.submitForSpeaker(
      () => this.service.runAction!(did, "previous"),
      () => {
        if (this.disposed) return;
        this.prevEnabled = true;
        this.emitStateChanged();
      },
      (err) => {
        if (this.disposed) return;
        this.prevEnabled = true;
        this.notifyToast(`操作失败：${toError(err).message}`, 2500);
        this.emitStateChanged();
      },
    );
  }

  next(): void {
    if (!this.did || !this.service.runAction) {
      return;
    }
    this.nextEnabled = false;
    const did = this.did;
    this.emitStateChanged();
    this.submitForSpeaker(
      () => this.service.runAction!(did, "next"),
      () => {
        if (this.disposed) return;
        this.nextEnabled = true;
        this.emitStateChanged();
      },
      (err) => {
        if (this.disposed) return;
        this.nextEnabled = true;
        this.notifyToast(`操作失败：${toError(err).message}`, 2500);
        this.emitStateChanged();
      },
    );
  }

  snapshot(): AudioBarSnapshot {
    return {
      did: this.did,
      speakerName: this.speakerName,
      visible: this.visible,
      enabled: this.enabled,
      prevEnabled: this.prevEnabled,
      nextEnabled: this.nextEnabled,
      playEnabled: this.playEnabled,
      volume: this.volume,
      volumeLabel: this.volumeLabel,
      sliderValue: this.sliderValue,
      sliderMin: this.sliderMin,
      sliderMax: this.sliderMax,
      sliderDown: this.sliderDown,
      sliderEnabled: this.sliderEnabled,
      muted: this.muted,
      playAccessibleName: this.playAccessibleName,
      pendingVolume: this.pendingVolume,
      mutePending: this.mutePending,
      readInFlight: this.readInFlight,
      volumeConfirmation: this.volumeConfirmation ? { ...this.volumeConfirmation } : null,
      pollActive: this.pollActive,
      commandRefreshActive: this.commandRefreshActive,
    };
  }

  // ---------- 定时器内部实现 ----------

  private startPollTimer(): void {
    this.stopPollTimer();
    this.pollHandle = this.timers.setInterval(() => {
      if (!this.disposed && this.visible) {
        this.refreshState();
      }
    }, this.pollIntervalMs);
  }

  private stopPollTimer(): void {
    if (this.pollHandle !== null) {
      this.timers.clearInterval(this.pollHandle);
      this.pollHandle = null;
    }
  }

  private startCommandRefreshTimers(): void {
    this.stopCommandRefreshTimers();
    this.commandRefreshHandles = this.commandRefreshDelaysMs.map((delay, idx) =>
      this.timers.setTimeout(() => {
        this.commandRefreshHandles[idx] = null;
        if (!this.disposed && this.visible) {
          this.refreshState();
        }
      }, delay),
    );
  }

  private stopCommandRefreshTimers(): void {
    for (let i = 0; i < this.commandRefreshHandles.length; i += 1) {
      const handle = this.commandRefreshHandles[i];
      if (handle !== null) {
        this.timers.clearTimeout(handle);
        this.commandRefreshHandles[i] = null;
      }
    }
  }

  private notifyToast(message: string, durationMs: number): void {
    this.events.emit("toastRequested", message, durationMs);
    this.onToast?.(message, durationMs);
  }

  private emitStateChanged(): void {
    this.events.emit("stateChanged");
  }
}
