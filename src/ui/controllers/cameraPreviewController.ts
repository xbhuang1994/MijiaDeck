// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * Headless controllers for the camera canvas, preview panel, and standalone camera window.
 * Preserves 100% of business semantics from app/ui/camera_canvas.py,
 * app/ui/camera_preview.py, and app/ui/device_dialog.py.
 */

import type { CameraSource } from "../../core/cameraAccess.ts";
import {
  CAMERA_ERRORS,
  CameraPreviewError,
  CameraSession,
  type CameraCommandName,
  type CameraSessionStartOptions,
} from "../../core/cameraPreview.ts";
import {
  TypedEmitter,
  type IJobExecutor,
  type Point,
  type Rect,
} from "../../core/contracts.ts";
import { isCamera } from "../../core/deviceControls.ts";
import type { DeviceInfo } from "../../core/models.ts";

export const RESIZE_MARGIN = 6;
export const CAPTION_HEIGHT = 34;
export const CAPTION_BUTTON_WIDTH = 46;
export const PTZ_SUPPORTED_MODEL = "chuangmi.camera.029a02";
export const DEFAULT_ASPECT_RATIO = 16 / 9;

/**
 * Aspect-preserving video bounds calculation (port of AspectVideoLayout.setGeometry).
 * Always stays contained within `bounds`.
 */
export function computeVideoRect(bounds: Rect, ratio: number = DEFAULT_ASPECT_RATIO): Rect {
  const r = Number.isFinite(ratio) && ratio > 0 ? ratio : DEFAULT_ASPECT_RATIO;
  const availW = Math.max(0, bounds.width);
  const availH = Math.max(0, bounds.height);
  const width = Math.max(0, Math.min(availW, Math.round(availH * r)));
  const height = Math.min(availH, Math.max(0, Math.round(width / r)));
  const x = bounds.x + Math.floor((availW - width) / 2);
  const y = bounds.y;
  return { x, y, width, height };
}

export type CanvasCursor = "arrow" | "open-hand" | "closed-hand" | "busy";

export interface CameraFrame {
  width: number;
  height: number;
  valid: boolean;
  data?: unknown;
}

export interface CameraCanvasEvents extends Record<string, unknown[]> {
  retry: [];
  dragged: [direction: number];
  muteClicked: [];
  qualityClicked: [];
  fullscreenClicked: [];
  changed: [];
}

export interface CameraCanvasOptions {
  clock?: () => number;
}

export class CameraCanvasController extends TypedEmitter<CameraCanvasEvents> {
  private readonly _clock: () => number;
  private _frame: CameraFrame | null = null;
  private _press: Point | null = null;
  private _dragAnchor: Point | null = null;
  private _dragEnabled = false;
  private _dragBusy = false;
  private _gestureSent = false;
  private _lastDragStepMs: number | null = null;

  private _notice = "";
  private _sleeping = false;
  private _muted = true;
  private _muteTooltip = "开启声音";
  private _fullscreen = false;
  private _fullscreenTooltip = "全屏观看";
  private _muteEnabled = false;
  private _qualityEnabled = false;
  private _fullscreenEnabled = true;
  private _qualityText = "流畅";
  private _qualityTooltip = "切换画质";
  private _cursor: CanvasCursor = "arrow";

  constructor(options: CameraCanvasOptions = {}) {
    super();
    this._clock = options.clock ?? (() => performance.now());
    this.message("正在读取摄像头状态…");
    this.setControlsEnabled(false);
  }

  get dragEnabled(): boolean {
    return this._dragEnabled;
  }

  set dragEnabled(enabled: boolean) {
    const next = Boolean(enabled);
    if (this._dragEnabled === next) {
      return;
    }
    this._dragEnabled = next;
    this._press = null;
    this._dragAnchor = null;
    this._cursor = next ? "open-hand" : "arrow";
    this.emit("changed");
  }

  get dragBusy(): boolean {
    return this._dragBusy;
  }

  get hasFrame(): boolean {
    return this._frame !== null;
  }

  get frame(): CameraFrame | null {
    return this._frame;
  }

  get notice(): string {
    return this._notice;
  }

  get noticeVisible(): boolean {
    return Boolean(this._notice);
  }

  get sleeping(): boolean {
    return this._sleeping;
  }

  get muted(): boolean {
    return this._muted;
  }

  get muteTooltip(): string {
    return this._muteTooltip;
  }

  get muteIcon(): string {
    return this._muted ? "mdi.volume-off" : "mdi.volume-high";
  }

  get fullscreen(): boolean {
    return this._fullscreen;
  }

  get fullscreenTooltip(): string {
    return this._fullscreenTooltip;
  }

  get fullscreenIcon(): string {
    return this._fullscreen ? "mdi.fullscreen-exit" : "mdi.fullscreen";
  }

  get muteEnabled(): boolean {
    return this._muteEnabled;
  }

  get qualityEnabled(): boolean {
    return this._qualityEnabled;
  }

  get fullscreenEnabled(): boolean {
    return this._fullscreenEnabled;
  }

  get qualityText(): string {
    return this._qualityText;
  }

  get qualityTooltip(): string {
    return this._qualityTooltip;
  }

  get cursor(): CanvasCursor {
    return this._cursor;
  }

  message(text: string, options: { clear?: boolean; sleeping?: boolean } = {}): void {
    const clear = options.clear ?? true;
    const sleeping = options.sleeping ?? false;
    if (clear) {
      this._frame = null;
    }
    this._notice = text;
    this._sleeping = sleeping;
    this.emit("changed");
  }

  setFrame(frame: CameraFrame): void {
    this._frame = frame;
    this._notice = "";
    this._sleeping = false;
    this.emit("changed");
  }

  setMuted(muted: boolean): void {
    this._muted = Boolean(muted);
    this._muteTooltip = this._muted ? "开启声音" : "静音";
    this.emit("changed");
  }

  setMuteTooltip(tooltip: string): void {
    this._muteTooltip = tooltip;
    this.emit("changed");
  }

  setFullscreen(fullscreen: boolean): void {
    this._fullscreen = Boolean(fullscreen);
    this._fullscreenTooltip = this._fullscreen ? "退出全屏（Esc）" : "全屏观看";
    this.emit("changed");
  }

  setControlsEnabled(enabled: boolean): void {
    const flag = Boolean(enabled);
    this._muteEnabled = flag;
    this._qualityEnabled = flag;
    this._fullscreenEnabled = true;
    this.emit("changed");
  }

  setQualityText(text: string): void {
    this._qualityText = text;
    this.emit("changed");
  }

  setQualityTooltip(tooltip: string): void {
    this._qualityTooltip = tooltip;
    this.emit("changed");
  }

  setDragBusy(busy: boolean): void {
    this._dragBusy = Boolean(busy);
    if (this._dragBusy) {
      // Discard the held gesture; unlocking never replays queued movement.
      this._press = null;
      this._dragAnchor = null;
    }
    this._cursor = this._dragBusy
      ? "busy"
      : this._dragEnabled
        ? "open-hand"
        : "arrow";
    this.emit("changed");
  }

  clickMute(): void {
    if (this._muteEnabled) {
      this.emit("muteClicked");
    }
  }

  clickQuality(): void {
    if (this._qualityEnabled) {
      this.emit("qualityClicked");
    }
  }

  clickFullscreen(): void {
    if (this._fullscreenEnabled) {
      this.emit("fullscreenClicked");
    }
  }

  mousePress(point: Point): void {
    if (this._dragBusy) {
      return;
    }
    this._press = { x: point.x, y: point.y };
    this._dragAnchor = { x: point.x, y: point.y };
    this._gestureSent = false;
    this._lastDragStepMs = null;
    if (this._dragEnabled) {
      this._cursor = "closed-hand";
      this.emit("changed");
    }
  }

  private _sendDragStep(point: Point, nowMs?: number): void {
    if (!this._dragEnabled || this._dragBusy || this._gestureSent || this._dragAnchor === null) {
      return;
    }
    const dx = point.x - this._dragAnchor.x;
    const dy = point.y - this._dragAnchor.y;
    const now = nowMs ?? this._clock();
    if (
      Math.max(Math.abs(dx), Math.abs(dy)) < 12 ||
      (this._lastDragStepMs !== null && now - this._lastDragStepMs < 400)
    ) {
      return;
    }
    const direction =
      Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 2 : 1) : dy > 0 ? 4 : 3;
    this._dragAnchor = { x: point.x, y: point.y };
    this._lastDragStepMs = now;
    this._gestureSent = true;
    this.emit("dragged", direction);
  }

  mouseMove(point: Point, leftButtonHeld: boolean, nowMs?: number): void {
    if (this._press !== null && leftButtonHeld) {
      this._sendDragStep(point, nowMs);
    }
  }

  mouseRelease(point: Point, nowMs?: number): void {
    if (this._press === null) {
      return;
    }
    const dx = point.x - this._press.x;
    const dy = point.y - this._press.y;
    this._sendDragStep(point, nowMs);
    this._press = null;
    this._dragAnchor = null;
    this._cursor = this._dragBusy
      ? "busy"
      : this._dragEnabled
        ? "open-hand"
        : "arrow";
    this.emit("changed");
    if (!this._gestureSent && !this.hasFrame && Math.max(Math.abs(dx), Math.abs(dy)) < 12) {
      this.emit("retry");
    }
  }
}

export interface ICameraSession {
  readonly cancelled: boolean;
  start(source: CameraSource, options?: CameraSessionStartOptions): Promise<string> | string;
  command(name: CameraCommandName, value: number): boolean;
  stop(): void;
}

export type PlayerErrorCategory =
  | "NoError"
  | "ResourceError"
  | "FormatError"
  | "NetworkError"
  | "AccessDeniedError"
  | string;

export interface ICameraPlayer {
  setSource(url: string): void;
  play(): void;
  stop(): void;
}

export interface IAudioOutput {
  start(rate: number): void;
  write(data: Uint8Array): void;
  stop(): void;
}

export interface IScheduler {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface ICameraService {
  powerState(did: string): Promise<boolean | null> | boolean | null;
  setPowerState(did: string, state: boolean): Promise<void> | void;
  prepareCameraSource(device: DeviceInfo): Promise<unknown> | unknown;
  recordDeviceObservation?(did: string, observation: Record<string, unknown>): void;
  deviceDiagnosticReport?(
    device: DeviceInfo,
    observation?: Record<string, unknown> | null,
  ): Promise<string> | string;
}

export interface DiagnosticTimelineEntry {
  stage: string;
  code: string | null;
  elapsed_ms: number;
}

export interface CameraDiagnosticState {
  attempted: boolean;
  stage: string;
  elapsed_ms?: number;
  error_code?: string;
  power_readable?: boolean;
  video_received?: boolean;
  video_codec?: "H264" | "H265";
  gop_bootstrap?: boolean;
  width?: number;
  height?: number;
  player_error?: number;
  timeline: DiagnosticTimelineEntry[];
  [key: string]: unknown;
}

export interface QualityMenuItem {
  value: 0 | 1 | 2;
  label: string;
  checked: boolean;
}

export interface CameraPreviewControllerOptions {
  sessionFactory?: () => ICameraSession;
  player?: ICameraPlayer;
  audioOutput?: IAudioOutput;
  clock?: () => number;
  scheduler?: IScheduler;
  visible?: boolean;
}

export interface CameraPreviewEvents extends Record<string, unknown[]> {
  changed: [];
  fullscreenChanged: [fullscreen: boolean];
}

const DEFAULT_SCHEDULER: IScheduler = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

function createNoopPlayer(): ICameraPlayer {
  return {
    setSource: () => {},
    play: () => {},
    stop: () => {},
  };
}

const PHASE_STAGE_MAP: Readonly<Record<string, string>> = {
  "PHASE RELAY": "relay",
  "PHASE AUTH": "session_auth",
  "PHASE MEDIA": "media",
};

const PHASE_TEXT_MAP: Readonly<Record<string, string>> = {
  "PHASE RELAY": "正在连接摄像头公网中继…",
  "PHASE AUTH": "中继已连接，正在验证视频会话…",
  "PHASE MEDIA": "视频授权已完成，正在等待摄像头画面…",
};

const PLAYER_ERROR_MAP: Readonly<Record<string, { code: string; message: string; numeric: number }>> = {
  ResourceError: {
    code: "PLAYER_RESOURCE",
    message: "播放器未能读取本地视频流，请点击画面重试。",
    numeric: 1,
  },
  FormatError: {
    code: "PLAYER_FORMAT",
    message: "播放器无法识别当前视频格式，请点击画面重试。",
    numeric: 2,
  },
  NetworkError: {
    code: "PLAYER_NETWORK",
    message: "播放器连接本地视频流失败，请点击画面重试。",
    numeric: 3,
  },
  AccessDeniedError: {
    code: "PLAYER_ACCESS",
    message: "播放器访问视频流被拒绝，请点击画面重试。",
    numeric: 4,
  },
};

const QUALITY_SHORT_LABELS: Readonly<Record<0 | 1 | 2, string>> = {
  0: "自动",
  1: "流畅",
  2: "高清",
};

export class CameraPreviewController extends TypedEmitter<CameraPreviewEvents> {
  readonly device: DeviceInfo;
  readonly canvas: CameraCanvasController;
  readonly dragHintText = "拖拽画面可调整摄像头角度";

  private readonly _service: ICameraService;
  private readonly _jobs: Pick<IJobExecutor, "submit">;
  private readonly _sessionFactory: () => ICameraSession;
  private readonly _player: ICameraPlayer;
  private readonly _audioOutput: IAudioOutput | null;
  private readonly _clock: () => number;
  private readonly _scheduler: IScheduler;

  private _diagnosticSinceMs: number;
  private _diagnostic: CameraDiagnosticState = {
    attempted: false,
    stage: "idle",
    timeline: [],
  };
  private _session: ICameraSession | null = null;
  private _generation = 0;
  private _playing = false;
  private _loaded = false;
  private _visible: boolean;
  private _minimized = false;
  private _disposed = false;
  private _readPending = false;
  private _powerBusy = false;
  private _powerVisible = true;
  private _powerState: boolean | null = null;
  private _powerTooltip = "摄像头开关";
  private _powerDeadlineMs = 0;
  private _attempted = false;
  private _quality: 0 | 1 | 2 = 1; // Fresh page always starts with smooth stream; never persisted.
  private _muted = true;
  private _audioActive = false;
  private _fullscreen = false;
  private _canvasHost: "panel" | "fullscreen" = "panel";
  private _dragReadyAtMs = 0;
  private _url = "";
  private _switchingQuality = false;
  private _videoRatio = DEFAULT_ASPECT_RATIO;

  private _timeoutHandle: unknown = null;
  private _pollHandle: unknown = null;
  private _reopenHandle: unknown = null;

  constructor(
    service: ICameraService,
    jobs: Pick<IJobExecutor, "submit">,
    device: DeviceInfo,
    options: CameraPreviewControllerOptions = {},
  ) {
    super();
    this._service = service;
    this._jobs = jobs;
    this.device = device;
    this._sessionFactory = options.sessionFactory ?? (() => new CameraSession());
    this._player = options.player ?? createNoopPlayer();
    this._audioOutput = options.audioOutput ?? null;
    this._clock = options.clock ?? (() => performance.now());
    this._scheduler = options.scheduler ?? DEFAULT_SCHEDULER;
    this._visible = options.visible ?? true;
    this._diagnosticSinceMs = this._clock();

    this.canvas = new CameraCanvasController({ clock: this._clock });
    this.canvas.on("retry", () => this.retry());
    this.canvas.on("muteClicked", () => this.toggleMute());
    this.canvas.on("fullscreenClicked", () => this.toggleFullscreen());
    this.canvas.on("dragged", (direction) => this.drag(direction));
  }

  get session(): ICameraSession | null {
    return this._session;
  }

  get generation(): number {
    return this._generation;
  }

  get playing(): boolean {
    return this._playing;
  }

  get loaded(): boolean {
    return this._loaded;
  }

  get visible(): boolean {
    return this._visible;
  }

  get minimized(): boolean {
    return this._minimized;
  }

  get attempted(): boolean {
    return this._attempted;
  }

  get quality(): 0 | 1 | 2 {
    return this._quality;
  }

  get muted(): boolean {
    return this._muted;
  }

  get fullscreen(): boolean {
    return this._fullscreen;
  }

  get canvasHost(): "panel" | "fullscreen" {
    return this._canvasHost;
  }

  get switchingQuality(): boolean {
    return this._switchingQuality;
  }

  get url(): string {
    return this._url;
  }

  get timeoutActive(): boolean {
    return this._timeoutHandle !== null;
  }

  get pollActive(): boolean {
    return this._pollHandle !== null;
  }

  get powerState(): boolean | null {
    return this._powerState;
  }

  get powerVisible(): boolean {
    return this._powerVisible;
  }

  get powerBusy(): boolean {
    return this._powerBusy;
  }

  get powerTooltip(): string {
    return this._powerTooltip;
  }

  get dragHintVisible(): boolean {
    return this.device.model === PTZ_SUPPORTED_MODEL;
  }

  get videoRatio(): number {
    return this._videoRatio;
  }

  get player(): ICameraPlayer {
    return this._player;
  }

  /**
   * Convenience helper for restoring or injecting an active session state in tests.
   */
  attachSession(
    session: ICameraSession | null,
    state: { playing?: boolean; url?: string; muted?: boolean; attempted?: boolean; loaded?: boolean; powerState?: boolean | null } = {},
  ): void {
    this._session = session;
    if (state.playing !== undefined) this._playing = state.playing;
    if (state.url !== undefined) this._url = state.url;
    if (state.muted !== undefined) {
      this._muted = state.muted;
      this.canvas.setMuted(state.muted);
    }
    if (state.attempted !== undefined) this._attempted = state.attempted;
    if (state.loaded !== undefined) this._loaded = state.loaded;
    if (state.powerState !== undefined) this._powerState = state.powerState;
  }

  diagnosticSnapshot(): CameraDiagnosticState {
    return {
      ...this._diagnostic,
      timeline: this._diagnostic.timeline.map((entry) => ({ ...entry })),
    };
  }

  private _recordDiagnostic(
    stage: string,
    code: string | null = null,
    values: Record<string, unknown> = {},
  ): void {
    const elapsedMs = Math.max(0, Math.round(this._clock() - this._diagnosticSinceMs));
    this._diagnostic = {
      ...this._diagnostic,
      ...values,
      stage,
      elapsed_ms: elapsedMs,
    };
    if (code !== null) {
      this._diagnostic.error_code = code;
    }
    const nextTimeline = [
      ...this._diagnostic.timeline,
      { stage, code, elapsed_ms: elapsedMs },
    ].slice(-24);
    this._diagnostic.timeline = nextTimeline;

    if (typeof this._service.recordDeviceObservation === "function") {
      this._service.recordDeviceObservation(this.device.did, this.diagnosticSnapshot());
    }
  }

  private _startTimeout(ms: number): void {
    this._clearTimeoutTimer();
    this._timeoutHandle = this._scheduler.setTimeout(() => {
      this._timeoutHandle = null;
      this.onTimeout();
    }, ms);
  }

  private _clearTimeoutTimer(): void {
    if (this._timeoutHandle !== null) {
      this._scheduler.clearTimeout(this._timeoutHandle);
      this._timeoutHandle = null;
    }
  }

  private _clearReopenTimer(): void {
    if (this._reopenHandle !== null) {
      this._scheduler.clearTimeout(this._reopenHandle);
      this._reopenHandle = null;
    }
  }

  private _startPoll(): void {
    if (this._pollHandle !== null) {
      return;
    }
    this._pollHandle = this._scheduler.setInterval(() => {
      this.refreshPower();
    }, 5000);
  }

  private _stopPoll(): void {
    if (this._pollHandle !== null) {
      this._scheduler.clearInterval(this._pollHandle);
      this._pollHandle = null;
    }
  }

  private _setVideoRatio(width: number, height: number): void {
    if (width > 0 && height > 0) {
      const ratio = width / height;
      if (Math.abs(ratio - this._videoRatio) > 0.001) {
        this._videoRatio = ratio;
      }
    }
  }

  load(): void {
    this._loaded = true;
    this.refreshPower();
    if (this._visible) {
      this._startPoll();
    }
  }

  refreshPower(): void {
    if (this._readPending || this._powerBusy || !this.device.online) {
      if (!this.device.online) {
        this.canvas.message("摄像头已离线");
      }
      return;
    }
    this._readPending = true;
    const onSuccess = (state: boolean | null) => {
      if (this._disposed) {
        return;
      }
      this._readPending = false;
      if (
        this._powerBusy ||
        (this._clock() < this._powerDeadlineMs && state !== this._powerState)
      ) {
        return;
      }
      if (state === null || state === undefined) {
        if (!this._attempted) {
          this._recordDiagnostic("power", "POWER_UNKNOWN", { power_readable: false });
        }
        this.continueWithoutPowerState();
        return;
      }
      this.applyPower(Boolean(state));
    };
    const onError = () => {
      if (this._disposed) {
        return;
      }
      this._readPending = false;
      if (!this._attempted) {
        this._recordDiagnostic("power", "POWER_READ_FAILED", { power_readable: false });
      }
      this.continueWithoutPowerState();
    };
    this._jobs.submit(() => this._service.powerState(this.device.did), {
      onSuccess,
      onError,
    });
  }

  continueWithoutPowerState(): void {
    // A camera may expose video without a readable/writable MIoT power
    // property. Unknown power must not prevent independent video auth.
    if (this._powerState === null) {
      this._powerVisible = false;
      this.emit("changed");
      if (this._visible && !this._attempted && this._session === null) {
        this.start();
      }
    }
  }

  applyPower(state: boolean): void {
    this._diagnostic.power_readable = true;
    this._powerVisible = true;
    const previous = this._powerState;
    this._powerState = state;
    this._powerTooltip = state ? "让摄像头休眠" : "唤醒摄像头";
    if (!state) {
      this.stop();
      this._attempted = false;
      this.canvas.message("摄像机已休眠", { sleeping: true });
    } else {
      if (previous !== true) {
        this._attempted = false;
      }
      if (this._visible && !this._attempted && this._session === null) {
        this.start();
      }
    }
    this.emit("changed");
  }

  togglePower(): void {
    if (this._powerBusy) {
      return;
    }
    if (this._powerState === null) {
      this.refreshPower();
      return;
    }
    const target = !this._powerState;
    this._powerBusy = true;
    this.emit("changed");

    const onSuccess = () => {
      if (this._disposed) {
        return;
      }
      this._powerBusy = false;
      this._powerDeadlineMs = this._clock() + 5000;
      this.applyPower(target);
    };
    const onError = () => {
      if (this._disposed) {
        return;
      }
      this._powerBusy = false;
      this.canvas.message("摄像头开关操作失败，请重试", { clear: false });
      this.emit("changed");
    };
    this._jobs.submit(() => this._service.setPowerState(this.device.did, target), {
      onSuccess,
      onError,
    });
  }

  retry(): void {
    if (this._powerState !== false && this._session === null) {
      this.start();
    }
  }

  start(): void {
    if (!this.device.online || this._powerState === false) {
      if (!this.device.online) {
        this._recordDiagnostic("idle", "OFFLINE");
      }
      this.canvas.message(!this.device.online ? "摄像头已离线" : "摄像机已休眠", {
        sleeping: this._powerState === false,
      });
      return;
    }

    this.stop();
    this._diagnosticSinceMs = this._clock();
    const power = this._diagnostic.power_readable;
    this._diagnostic = {
      attempted: true,
      stage: "idle",
      video_received: false,
      error_code: "NONE",
      timeline: [],
    };
    if (typeof power === "boolean") {
      this._diagnostic.power_readable = power;
    }
    this._recordDiagnostic("authorization");
    this._attempted = true;

    const session = this._sessionFactory();
    this._session = session;
    const generation = this._generation;
    this.canvas.message("正在申请视频连接…");
    this._startTimeout(100_000);

    const prepare = (): unknown | Promise<unknown> => {
      if (session.cancelled) {
        throw new CameraPreviewError("预览已取消。");
      }
      try {
        const result = this._service.prepareCameraSource(this.device);
        if (result instanceof Promise) {
          return result.catch((err: unknown) => {
            if (err instanceof CameraPreviewError) {
              throw err;
            }
            throw new CameraPreviewError("摄像头视频授权失败，请重试。");
          });
        }
        return result;
      } catch (err) {
        if (err instanceof CameraPreviewError) {
          throw err;
        }
        throw new CameraPreviewError("摄像头视频授权失败，请重试。");
      }
    };

    const onSuccess = (source: unknown) => {
      if (this._disposed || generation !== this._generation) {
        session.stop();
        return;
      }
      const connectRelay = async () => {
        try {
          const url = await session.start(source as CameraSource, {
            quality: this._quality,
            onProgress: (value) => {
              if (!this._disposed) {
                this.onProgress(generation, value);
              }
            },
            onAudio: (rate, data) => {
              if (!this._disposed) {
                this.onPcm(generation, rate, data);
              }
            },
          });
          if (session.cancelled || this._disposed) {
            session.stop();
          } else {
            this.onConnected(generation, url);
          }
        } catch (err) {
          session.stop();
          if (!this._disposed) {
            const safe =
              err instanceof CameraPreviewError
                ? err
                : new CameraPreviewError("远程视频连接失败，请重试。");
            this.onFailed(generation, safe);
          }
        }
      };
      void connectRelay();
    };

    const onError = (error: Error) => {
      session.stop();
      if (!this._disposed) {
        this.onFailed(generation, error);
      }
    };

    this._jobs.submit(prepare, { onSuccess, onError });
  }

  onConnected(generation: number, url: string): void {
    if (generation !== this._generation || this._session === null) {
      return;
    }
    this._recordDiagnostic("decode");
    this.canvas.message("正在载入画面…");
    this._url = url;
    this._startTimeout(25_000);
    this._player.setSource(url);
    this._player.play();
    if (!this._muted) {
      this._session.command("AUDIO", 1);
    }
    this.emit("changed");
  }

  onFailed(generation: number, error: unknown): void {
    if (generation !== this._generation) {
      return;
    }
    const code =
      error instanceof CameraPreviewError
        ? error.code
        : typeof error === "object" &&
            error !== null &&
            "code" in error &&
            typeof (error as { code?: unknown }).code === "string"
          ? (error as { code: string }).code
          : "UNKNOWN";
    this._recordDiagnostic(this._diagnostic.stage || "idle", code);
    this.stop();
    const safe =
      error instanceof CameraPreviewError
        ? error.message
        : "视频连接失败，请点击画面重试";
    this.canvas.message(safe);
    this.emit("changed");
  }

  onProgress(generation: number, message: string): void {
    if (generation !== this._generation) {
      return;
    }
    if (message.startsWith("ERROR ")) {
      const key = message.slice(6);
      this.onFailed(
        generation,
        new CameraPreviewError(CAMERA_ERRORS[key] ?? "远程视频连接中断，请重试。", key),
      );
    } else if (message === "INFO VIDEO_CODEC H264" || message === "INFO VIDEO_CODEC H265") {
      const codec = message.slice(message.lastIndexOf(" ") + 1) as "H264" | "H265";
      this._recordDiagnostic(this._diagnostic.stage || "media", null, { video_codec: codec });
    } else if (message === "INFO GOP_BOOTSTRAP") {
      this._recordDiagnostic(this._diagnostic.stage || "media", null, { gop_bootstrap: true });
    } else if (message === "NOTICE AUDIO_UNSUPPORTED") {
      this._recordDiagnostic(this._diagnostic.stage || "media", "AUDIO_UNSUPPORTED");
      this._muted = true;
      this.stopAudio();
      this.canvas.setMuted(true);
      this.canvas.setMuteTooltip("此设备的音频编码暂不支持");
    } else if (message === "NOTICE CONTROL_FAILED") {
      this._recordDiagnostic(this._diagnostic.stage || "playing", "CONTROL_FAILED");
      this.canvas.message("摄像头未能执行控制指令，请重试", { clear: false });
    } else {
      const stage = PHASE_STAGE_MAP[message];
      if (stage) {
        this._recordDiagnostic(stage);
      }
      const text = PHASE_TEXT_MAP[message];
      if (text) {
        this.canvas.message(text);
      }
    }
  }

  onFrame(frame: CameraFrame): void {
    if (
      this._session === null ||
      this._switchingQuality ||
      !frame.valid ||
      frame.width <= 0 ||
      frame.height <= 0
    ) {
      return;
    }
    if (
      !this._diagnostic.video_received ||
      this._diagnostic.width !== frame.width ||
      this._diagnostic.height !== frame.height
    ) {
      this._recordDiagnostic("playing", null, {
        video_received: true,
        width: frame.width,
        height: frame.height,
      });
    }
    this._playing = true;
    this._clearTimeoutTimer();
    this.canvas.setFrame(frame);
    this._setVideoRatio(frame.width, frame.height);
    this.canvas.setControlsEnabled(true);
    this.canvas.dragEnabled = this.device.model === PTZ_SUPPORTED_MODEL;
    // No motor-completion acknowledgement is available. Require both a
    // settling interval and a subsequent decoded frame before another drag.
    if (this.canvas.dragBusy && this._clock() >= this._dragReadyAtMs) {
      this.canvas.setDragBusy(false);
    }
    const label =
      this._quality === 0 ? "自动" : frame.height > 1080 ? "2K" : `${frame.height}P`;
    this.canvas.setQualityText(label);
    this.canvas.setQualityTooltip(`切换画质 · 当前 ${frame.width} × ${frame.height}`);
    this.emit("changed");
  }

  onPlayerError(category: PlayerErrorCategory, _rawMessage?: string): void {
    void _rawMessage;
    if (this._session === null || this._switchingQuality || category === "NoError") {
      return;
    }
    const mapped = PLAYER_ERROR_MAP[category];
    this._diagnostic.player_error = mapped ? mapped.numeric : -1;
    const code = mapped?.code ?? "UNKNOWN";
    const message = mapped?.message ?? "视频播放失败，请点击画面重试。";
    // Never copy arbitrary backend/player error text: it may include a media URL/path.
    this.onFailed(this._generation, new CameraPreviewError(message, code));
  }

  onTimeout(): void {
    this._recordDiagnostic(this._diagnostic.stage || "idle", "TIMEOUT");
    this.stop();
    this.canvas.message("远程预览超时，请点击画面重试");
    this.emit("changed");
  }

  buildQualityMenu(): QualityMenuItem[] {
    const known = this.device.model === PTZ_SUPPORTED_MODEL;
    return [
      { value: 0, label: "自动", checked: this._quality === 0 },
      { value: 1, label: known ? "360P 流畅" : "流畅", checked: this._quality === 1 },
      { value: 2, label: known ? "2K 高清" : "高清", checked: this._quality === 2 },
    ];
  }

  selectQuality(quality: 0 | 1 | 2): void {
    if (quality === this._quality) {
      return;
    }
    if (this._session && this._session.command("QUALITY", quality)) {
      this._quality = quality;
      this.canvas.setQualityText(QUALITY_SHORT_LABELS[quality]);
      // Reopen only the local viewer so its TS header/decoder matches a codec
      // change (some cameras use a different codec for their SD stream).
      if (this._url) {
        this._switchingQuality = true;
        this._player.stop();
        this._player.setSource("");
        this.canvas.message("正在切换画质…", { clear: false });
        const generation = this._generation;
        this._clearReopenTimer();
        this._reopenHandle = this._scheduler.setTimeout(() => {
          this._reopenHandle = null;
          if (generation === this._generation && this._session !== null && !this._disposed) {
            this._switchingQuality = false;
            this._startTimeout(25_000);
            this._player.setSource(this._url);
            this._player.play();
            this.emit("changed");
          }
        }, 900);
      }
      this.emit("changed");
    }
  }

  toggleMute(): void {
    if (!this._session || !this._playing) {
      return;
    }
    const target = !this._muted;
    if (this._session.command("AUDIO", target ? 0 : 1)) {
      this._muted = target;
      this.canvas.setMuted(target);
      if (target) {
        this.stopAudio();
      }
      this.emit("changed");
    }
  }

  onPcm(generation: number, rate: number, data: Uint8Array): void {
    if (generation !== this._generation || this._muted || !this._playing) {
      return;
    }
    if (!this._audioActive) {
      this._audioOutput?.start(rate);
      this._audioActive = true;
    }
    this._audioOutput?.write(data);
  }

  stopAudio(): void {
    if (this._audioActive) {
      this._audioOutput?.stop();
      this._audioActive = false;
    }
  }

  drag(direction: number): void {
    if (
      this._session &&
      this._playing &&
      this.canvas.dragEnabled &&
      !this.canvas.dragBusy &&
      !this._switchingQuality
    ) {
      if (this._session.command("PTZ", direction)) {
        this._dragReadyAtMs = this._clock() + 1500;
        this.canvas.setDragBusy(true);
      }
    }
  }

  toggleFullscreen(): void {
    if (this._fullscreen) {
      this.exitFullscreen();
      return;
    }
    this._fullscreen = true;
    this._canvasHost = "fullscreen";
    this.canvas.setFullscreen(true);
    this.emit("fullscreenChanged", true);
    this.emit("changed");
  }

  exitFullscreen(): void {
    if (!this._fullscreen) {
      return;
    }
    this._fullscreen = false;
    this._canvasHost = "panel";
    this.canvas.setFullscreen(false);
    this.emit("fullscreenChanged", false);
    this.emit("changed");
  }

  handleKeyPress(key: string): boolean {
    if (key === "Escape" && this._fullscreen) {
      this.exitFullscreen();
      return true;
    }
    return false;
  }

  stop(): void {
    this._generation += 1;
    this._clearTimeoutTimer();
    this._clearReopenTimer();
    this._playing = false;
    this._switchingQuality = false;
    this._url = "";
    const session = this._session;
    this._session = null;
    this._player.stop();
    this._player.setSource("");
    this.stopAudio();
    if (session !== null) {
      session.stop();
    }
    this.canvas.dragEnabled = false;
    this._dragReadyAtMs = 0;
    this.canvas.setDragBusy(false);
    this.canvas.message("");
    this.canvas.setControlsEnabled(false);
    this.emit("changed");
  }

  show(): void {
    this._visible = true;
    this._minimized = false;
    if (this._loaded) {
      this._startPoll();
      this.refreshPower();
    }
    this.emit("changed");
  }

  onMinimize(): void {
    // Minimizing is still an active viewing session. Keep the relay,
    // decoder and any pending authorization alive for instant restore.
    this._minimized = true;
    this.emit("changed");
  }

  hide(minimized = false): void {
    if (minimized) {
      this.onMinimize();
      return;
    }
    this._visible = false;
    this._minimized = false;
    this._stopPoll();
    this._attempted = false;
    if (this._fullscreen) {
      this.exitFullscreen();
    }
    this.stop();
    this.emit("changed");
  }

  close(): void {
    // Explicit close releases the session even if already minimized,
    // and never powers off the physical camera.
    this._visible = false;
    this._minimized = false;
    this._stopPoll();
    this._attempted = false;
    if (this._fullscreen) {
      this.exitFullscreen();
    }
    this.stop();
    this.emit("changed");
  }

  dispose(): void {
    this._disposed = true;
    this.close();
  }
}

export interface CameraHitTestOptions {
  width: number;
  height: number;
  maximized: boolean;
  headerBottom: number;
  overButton: boolean;
  resizeMargin?: number;
}

/**
 * Logical coordinates hit test for frameless standalone camera windows.
 * Returns Windows WM_NCHITTEST constants:
 * 13=HTTOPLEFT, 14=HTTOPRIGHT, 16=HTBOTTOMLEFT, 17=HTBOTTOMRIGHT,
 * 10=HTLEFT, 11=HTRIGHT, 12=HTTOP, 15=HTBOTTOM, 2=HTCAPTION, 1=HTCLIENT.
 */
export function cameraHitTest(x: number, y: number, opts: CameraHitTestOptions): number {
  const margin = opts.resizeMargin ?? RESIZE_MARGIN;
  if (!opts.maximized) {
    const left = x <= margin;
    const right = x >= opts.width - margin;
    const top = y <= margin;
    const bottom = y >= opts.height - margin;
    if (top && left) return 13;
    if (top && right) return 14;
    if (bottom && left) return 16;
    if (bottom && right) return 17;
    if (left) return 10;
    if (right) return 11;
    if (top) return 12;
    if (bottom) return 15;
  }
  if (y < opts.headerBottom && !opts.overButton) {
    return 2; // HTCAPTION: drag title / double-click maximize.
  }
  return 1; // HTCLIENT
}

export interface CameraWindowOptions extends CameraPreviewControllerOptions {
  screenAvailableGeometry?: Rect;
}

export interface CameraWindowEvents extends Record<string, unknown[]> {
  closed: [did: string];
  stateChanged: [];
}

const DEFAULT_SCREEN_GEOMETRY: Rect = { x: 0, y: 0, width: 1920, height: 1040 };

export class CameraWindowController extends TypedEmitter<CameraWindowEvents> {
  readonly device: DeviceInfo;
  readonly modal = false;
  readonly overlay = false;
  readonly title: string;
  readonly minimumSize = { width: 480, height: 360 } as const;
  readonly captionHeight = CAPTION_HEIGHT;
  readonly captionButtonWidth = CAPTION_BUTTON_WIDTH;
  readonly bodyMargins = { left: 20, top: 8, right: 20, bottom: 16 } as const;
  readonly camera: CameraPreviewController;

  private _screenAvailableGeometry: Rect;
  private _geometry: Rect = { x: 0, y: 0, width: 900, height: 600 };
  private _restoreGeometry: Rect | null = null;
  private _positioned = false;
  private _visible = false;
  private _minimized = false;
  private _maximized = false;
  private _closed = false;

  constructor(
    service: ICameraService,
    jobs: Pick<IJobExecutor, "submit">,
    device: DeviceInfo,
    options: CameraWindowOptions = {},
  ) {
    super();
    if (!isCamera(device)) {
      throw new Error("Only cameras use this preview window");
    }
    this.device = device;
    this.title = device.room_name ? `${device.name} - ${device.room_name}` : device.name;
    this._screenAvailableGeometry = options.screenAvailableGeometry
      ? { ...options.screenAvailableGeometry }
      : { ...DEFAULT_SCREEN_GEOMETRY };
    this.camera = new CameraPreviewController(service, jobs, device, {
      ...options,
      visible: options.visible ?? false,
    });
  }

  get panel(): CameraPreviewController {
    return this.camera;
  }

  get visible(): boolean {
    return this._visible;
  }

  get minimized(): boolean {
    return this._minimized;
  }

  get maximized(): boolean {
    return this._maximized;
  }

  get closed(): boolean {
    return this._closed;
  }

  get geometry(): Rect {
    return { ...this._geometry };
  }

  get screenAvailableGeometry(): Rect {
    return { ...this._screenAvailableGeometry };
  }

  setScreenAvailableGeometry(rect: Rect): void {
    this._screenAvailableGeometry = { ...rect };
  }

  load(): void {
    this.camera.load();
  }

  show(): void {
    if (!this._positioned) {
      this._positioned = true;
      const avail = this._screenAvailableGeometry;
      const margin = 24;
      const width = Math.max(this.minimumSize.width, Math.min(900, avail.width - margin * 2));
      const height = Math.max(this.minimumSize.height, Math.min(600, avail.height - margin * 2));
      const x = avail.x + Math.floor((avail.width - width) / 2);
      const y = avail.y + Math.floor((avail.height - height) / 2);
      this._geometry = { x, y, width, height };
    }
    this._visible = true;
    this._minimized = false;
    this._closed = false;
    this.camera.show();
    this.emit("stateChanged");
  }

  showMinimized(): void {
    this._minimized = true;
    this.camera.onMinimize();
    this.emit("stateChanged");
  }

  showMaximized(): void {
    if (!this._maximized) {
      this._restoreGeometry =
        this._minimized && this._restoreGeometry !== null
          ? { ...this._restoreGeometry }
          : { ...this._geometry };
      this._geometry = { ...this._screenAvailableGeometry };
    }
    this._maximized = true;
    this._minimized = false;
    this._visible = true;
    this.camera.show();
    this.emit("stateChanged");
  }

  showNormal(): void {
    const restore = this._maximized ? this._restoreGeometry : null;
    this._maximized = false;
    this._minimized = false;
    this._visible = true;
    if (restore !== null) {
      this._geometry = { ...restore };
      this._restoreGeometry = null;
    }
    this.camera.show();
    this.emit("stateChanged");
  }

  toggleMaximized(): void {
    if (this._maximized) {
      this.showNormal();
    } else {
      this.showMaximized();
    }
  }

  resize(width: number, height: number): void {
    this._geometry = {
      ...this._geometry,
      width: Math.max(this.minimumSize.width, width),
      height: Math.max(this.minimumSize.height, height),
    };
    this.emit("stateChanged");
  }

  onLeave(): void {
    // Non-modal standalone camera windows stay open on pointer leave.
  }

  onDeactivate(): void {
    // Non-modal standalone camera windows stay open when deactivated.
  }

  hide(): void {
    this._visible = false;
    this._minimized = false;
    this.camera.hide(false);
    this.emit("stateChanged");
  }

  close(): void {
    if (this._closed) {
      return;
    }
    this._closed = true;
    this._visible = false;
    this._minimized = false;
    this.camera.close();
    this.emit("stateChanged");
    this.emit("closed", this.device.did);
  }

  reject(): void {
    this.close();
  }

  hitTest(
    x: number,
    y: number,
    options: Partial<Pick<CameraHitTestOptions, "headerBottom" | "overButton" | "resizeMargin">> = {},
  ): number {
    return cameraHitTest(x, y, {
      width: this._geometry.width,
      height: this._geometry.height,
      maximized: this._maximized,
      headerBottom: options.headerBottom ?? this.captionHeight + 68,
      overButton: options.overButton ?? false,
      resizeMargin: options.resizeMargin,
    });
  }

  computeCanvasRect(): Rect {
    // Panel inner body bounds after 1px frame border, caption, header, margins, and AspectVideoLayout margins (49, 12, 49, 0).
    const bodyWidth = Math.max(0, this._geometry.width - 2 - this.bodyMargins.left - this.bodyMargins.right);
    const bodyHeight = Math.max(
      0,
      this._geometry.height - 2 - this.captionHeight - this.bodyMargins.top - this.bodyMargins.bottom - 72,
    );
    const videoBounds: Rect = {
      x: 49,
      y: 12,
      width: Math.max(0, bodyWidth - 98),
      height: Math.max(0, bodyHeight - 12),
    };
    return computeVideoRect(videoBounds, this.camera.videoRatio);
  }
}
