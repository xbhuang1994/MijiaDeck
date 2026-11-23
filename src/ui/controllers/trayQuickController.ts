// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/** 托盘左键快捷窗口与系统托盘控制器：设备/场景行、音频栏、小爱语音条、内嵌灯光控制与点击编排。 */

import { MESSAGES, speakerHint } from "../../core/availability.ts";
import {
  TypedEmitter,
  type AccessState,
  type IJobExecutor,
  type IMijiaService,
  type Point,
  type Rect,
  type ScreenInfo,
  type TrayOrderItem,
  type TraySceneSnapshot,
} from "../../core/contracts.ts";
import {
  deviceSubtitle,
  deviceTitle,
  hasDeviceDetails,
  isCamera,
  isLight,
  supportsCardPower,
  trayEligible,
} from "../../core/deviceControls.ts";
import { createSceneInfo, isSpeaker, type DeviceDetail, type DeviceInfo, type SceneInfo } from "../../core/models.ts";
import * as settingsStore from "../../core/settingsStore.ts";
import * as trayStore from "../../core/trayStore.ts";
import { AudioBarController, type AudioBarService, type AudioBarTimers } from "./audioBarController.ts";
import { LightControlController, type LightControlService } from "./lightControlController.ts";

export const SHADOW_PAD = 6;
export const PANEL_WIDTH = 400;
export const CARD_HEIGHT = 58;
export const LIST_HEIGHT = 310;
export const TRAY_TOOLTIP = "单击图标打开浮窗控制设备";
export const VOICE_HINT_FULL = "对小爱输入“打开卧室灯”，回车执行";
export const EMPTY_TRAY_TEXT = "暂无卡片\n点击右上角编辑图标添加";

export type TrayActivationReason = "trigger" | "double_click" | "context";

export type DragSurface =
  | "drag_header"
  | "drag_title"
  | "audio_drag_header"
  | "audio_drag_handle"
  | "quick_drag_handle"
  | "audio_top_padding"
  | "window"
  | "panel"
  | "audio_bar"
  | "light_header"
  | "light_title"
  | "light_power_text"
  | "speaker_button";

export interface TrayQuickRow {
  type: "device" | "scene";
  id: string;
  title: string;
  subtitle: string;
  online: boolean;
  hasPowerBtn: boolean;
  powerState: boolean | null;
  powerBusy: boolean;
  hasPlayBtn: boolean;
  playBtnEnabled: boolean;
  hasCameraTag: boolean;
  hasLightTag: boolean;
  hasSceneRunBtn: boolean;
  sceneRunBusy: boolean;
  clickable: boolean;
  cursor: "pointer" | "default";
  rowIndex: number;
  colIndex: number;
}

export interface TrayMenuAction {
  label: string;
  enabled: boolean;
  checked?: boolean;
  separator?: boolean;
  trigger(): void;
}

export interface SpeakerMenuOption {
  did: string;
  label: string;
  enabled: boolean;
  checked: boolean;
  trigger(): void;
}

export interface TrayQuickEnv {
  screens(): ScreenInfo[];
  primaryScreen(): ScreenInfo | null;
  screenAt(point: Point): ScreenInfo | null;
  cursorPos(): Point;
  isWindowActive(): boolean;
  isUnderMouse(): boolean;
  hasOtherActiveAppWindow(): boolean;
  hasActivePopup(): boolean;
  hasMouseButtonsPressed(): boolean;
  startDragDistance(): number;
}

export interface TrayQuickService {
  deviceDetail?(did: string): DeviceDetail | Promise<DeviceDetail>;
  readProps?(did: string, names: string[]): Record<string, unknown> | Promise<Record<string, unknown>>;
  writeProp?(did: string, name: string, value: unknown): void | Promise<void>;
  runAction?(did: string, name: string, params?: unknown): void | Promise<void>;
  powerStates?(dids: string[]): Record<string, boolean | null> | Promise<Record<string, boolean | null>>;
  togglePower?(did: string): boolean | Promise<boolean>;
  readMetrics?(dids: string[]): Record<string, string | null> | Promise<Record<string, string | null>>;
  runScene?(scene: SceneInfo): void | Promise<void>;
}

export interface TrayQuickWindowEvents {
  [key: string]: unknown[];
  manageRequested: [];
  speakerChanged: [];
  openDeviceRequested: [did: string];
  removeTrayItemRequested: [kind: "device" | "scene", id: string];
  toastRequested: [message: string, durationMs: number];
  stateChanged: [];
}

export interface TrayQuickWindowOptions {
  env?: Partial<TrayQuickEnv>;
  nowMs?: () => number;
  timers?: Partial<AudioBarTimers>;
  onToast?: (message: string, durationMs: number) => void;
}

export interface TrayMainHost {
  devices(): DeviceInfo[];
  show(): void;
  showNormal?(): void;
  raise?(): void;
  activateWindow?(): void;
  isMinimized?(): boolean;
  close?(): void;
  requestForceQuit?(): void;
  showTrayManager(): void;
  showSettings(): void;
  loginAccount?(): void;
  openCameraWindow?(device: DeviceInfo): void;
  openLightWindow?(device: DeviceInfo): void;
  removeTrayItem?(kind: "device" | "scene", id: string): void;
  updateVoiceFab?(): void;
  accessState?(): AccessState;
  networkOnline?: boolean;
  loggedOut?: boolean;
  networkMonitor?: { checkNow(): void } | null;
}

export interface TrayControllerOptions {
  nowMs?: () => number;
  doubleClickIntervalMs?: number;
  scheduleNextTick?: (fn: () => void) => void;
  quickOptions?: TrayQuickWindowOptions;
  quickFactory?: () => TrayQuickWindowController;
  onQuitApp?: () => void;
  systemTrayAvailable?: boolean;
  initialColorScheme?: "light" | "dark";
}

const DEFAULT_SCREEN: ScreenInfo = {
  name: "primary",
  availableGeometry: { x: 0, y: 0, width: 1920, height: 1040 },
};

const DEFAULT_DRAG_DISTANCE = 10;

function defaultEnv(): TrayQuickEnv {
  return {
    screens: () => [DEFAULT_SCREEN],
    primaryScreen: () => DEFAULT_SCREEN,
    screenAt: () => DEFAULT_SCREEN,
    cursorPos: () => ({ x: 1850, y: 1020 }),
    isWindowActive: () => false,
    isUnderMouse: () => false,
    hasOtherActiveAppWindow: () => false,
    hasActivePopup: () => false,
    hasMouseButtonsPressed: () => false,
    startDragDistance: () => DEFAULT_DRAG_DISTANCE,
  };
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

function adaptAudioService(service: TrayQuickService): AudioBarService {
  return {
    deviceDetail: (did) => {
      if (!service.deviceDetail) {
        return { did, name: "", model: "", props: [], actions: [] };
      }
      return service.deviceDetail(did);
    },
    readProps: (did, names) => {
      if (!service.readProps) {
        return {};
      }
      return service.readProps(did, names);
    },
    writeProp: (did, name, value) => {
      if (!service.writeProp) {
        return;
      }
      return service.writeProp(did, name, value);
    },
    runAction: service.runAction
      ? (did, name, params) => service.runAction!(did, name, params)
      : undefined,
  };
}

function adaptLightService(service: TrayQuickService): LightControlService {
  return {
    deviceDetail: (did) => {
      if (!service.deviceDetail) {
        return { did, name: "", model: "", props: [], actions: [] };
      }
      return service.deviceDetail(did);
    },
    readProps: (did, names) => {
      if (!service.readProps) {
        return {};
      }
      return service.readProps(did, names);
    },
    writeProp: (did, name, value) => {
      if (!service.writeProp) {
        return;
      }
      return service.writeProp(did, name, value);
    },
  };
}

/**
 * 托盘左键弹出的快捷操作面板控制器。
 */
export class TrayQuickWindowController {
  readonly events = new TypedEmitter<TrayQuickWindowEvents>();
  readonly audioBar: AudioBarController;

  devices: DeviceInfo[] = [];
  accessState: AccessState = "ready";
  knownPower: Record<string, boolean | null> = {};
  metrics: Record<string, string | null> = {};
  columns: 1 | 2;
  colsTooltip = "";
  rows: TrayQuickRow[] = [];
  emptyVisible = false;
  emptyText = EMPTY_TRAY_TEXT;
  listVisible = true;
  dragHeaderVisible = true;
  separatorVisible = false;
  quickDragHandleVisible = true;
  voiceBarVisible = false;
  voiceText = "";
  speakerHintText = "";
  speakerHintVisible = false;
  visible = false;
  explicitlyVisible = false;
  position: Point = { x: 0, y: 0 };
  size: { width: number; height: number } = {
    width: PANEL_WIDTH + 2 * SHADOW_PAD,
    height: 480 + 2 * SHADOW_PAD,
  };
  minHeight = 280 + 2 * SHADOW_PAD;
  dragging = false;
  pointerHasEntered = false;
  leaveTimerIntervalMs = 300;
  lightControl: LightControlController | null = null;
  overviewPageHidden = false;
  overviewPageEnabled = true;
  overviewPageUpdatesEnabled = true;
  overviewPageDetached = false;
  currentPage: "overview" | "light" = "overview";
  targetPos: Point | null = null;

  private readonly service: TrayQuickService;
  private readonly jobs: IJobExecutor;
  private readonly nowMs: () => number;
  private readonly timers: AudioBarTimers;
  private readonly onToast?: (message: string, durationMs: number) => void;
  private env: TrayQuickEnv;

  private trayDids: string[] | null = null;
  private trayScenes: TraySceneSnapshot[] | null = null;
  private trayOrder: TrayOrderItem[] | null = null;
  private sceneLookup = new Map<string, SceneInfo>();
  private dragStartGlobal: Point | null = null;
  private dragStartPos: Point | null = null;
  private leaveTimerHandle: unknown | null = null;
  private disposed = false;

  constructor(
    service: TrayQuickService | IMijiaService,
    jobs: IJobExecutor,
    options: TrayQuickWindowOptions = {},
  ) {
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
    this.onToast = options.onToast;
    const envDefaults = defaultEnv();
    this.env = {
      screens: options.env?.screens ?? envDefaults.screens,
      primaryScreen: options.env?.primaryScreen ?? envDefaults.primaryScreen,
      screenAt: options.env?.screenAt ?? envDefaults.screenAt,
      cursorPos: options.env?.cursorPos ?? envDefaults.cursorPos,
      isWindowActive: options.env?.isWindowActive ?? envDefaults.isWindowActive,
      isUnderMouse: options.env?.isUnderMouse ?? envDefaults.isUnderMouse,
      hasOtherActiveAppWindow: options.env?.hasOtherActiveAppWindow ?? envDefaults.hasOtherActiveAppWindow,
      hasActivePopup: options.env?.hasActivePopup ?? envDefaults.hasActivePopup,
      hasMouseButtonsPressed: options.env?.hasMouseButtonsPressed ?? envDefaults.hasMouseButtonsPressed,
      startDragDistance: options.env?.startDragDistance ?? envDefaults.startDragDistance,
    };

    const cols = settingsStore.getTrayColumns();
    this.columns = cols === 1 ? 1 : 2;
    this.refreshColsTooltip();

    this.audioBar = new AudioBarController(adaptAudioService(service), jobs, {
      nowMs: this.nowMs,
      timers: this.timers,
      onToast: (msg, dur) => this.notifyToast(msg, dur),
    });

    this.trayDids = trayStore.load();
  }

  get audioBarVisible(): boolean {
    return this.audioBar.visible;
  }

  get leaveTimerActive(): boolean {
    return this.leaveTimerHandle !== null;
  }

  get geometry(): Rect {
    return {
      x: this.position.x,
      y: this.position.y,
      width: this.size.width,
      height: this.size.height,
    };
  }

  setEnv(partial: Partial<TrayQuickEnv>): void {
    this.env = { ...this.env, ...partial };
  }

  isExplicitlyVisible(): boolean {
    return this.explicitlyVisible;
  }

  move(point: Point): void {
    this.position = { x: point.x, y: point.y };
  }

  resize(width: number, height: number): void {
    this.size = { width, height };
  }

  private refreshColsTooltip(): void {
    this.colsTooltip = this.columns === 1 ? "单列显示，点击切换双列" : "双列显示，点击切换单列";
  }

  toggleColumns(): void {
    this.columns = this.columns === 2 ? 1 : 2;
    settingsStore.setTrayColumns(this.columns);
    this.refreshColsTooltip();
    this.rebuild();
    this.emitStateChanged();
  }

  requestManage(): void {
    this.events.emit("manageRequested");
  }

  setDevices(devices: DeviceInfo[], knownPower: Record<string, boolean | null>): void {
    this.devices = devices.filter((d) => trayEligible(d));
    if (
      this.lightControl !== null &&
      !this.devices.some((d) => d.did === this.lightControl!.device.did && d.online)
    ) {
      this.lightControl.reject();
    }
    this.knownPower = { ...knownPower };
    this.trayDids = trayStore.load();
    this.trayScenes = trayStore.loadScenes();
    this.trayOrder = trayStore.loadOrder();
    this.updateAudioBar();
    this.updateVoiceBar();
    if (this.visible) {
      this.rebuild();
    }
    this.emitStateChanged();
  }

  setAccessState(state: AccessState): void {
    this.accessState = state;
    if (state !== "ready" && this.lightControl !== null) {
      this.lightControl.reject();
    }
    this.dragHeaderVisible = state === "ready";
    this.updateAudioBar();
    this.updateVoiceBar();
    this.rebuild();
    this.emitStateChanged();
  }

  setMetrics(metrics: Record<string, string | null>): void {
    if (this.disposed) {
      return;
    }
    this.metrics = { ...metrics };
    for (const [did, text] of Object.entries(metrics)) {
      const row = this.rows.find((r) => r.type === "device" && r.id === did);
      if (!row) continue;
      const dev = this.devices.find((d) => d.did === did);
      if (!dev) continue;
      row.subtitle = deviceSubtitle(dev, text, this.knownPower);
    }
    this.emitStateChanged();
  }

  updateVoiceBar(): void {
    const ready = this.accessState === "ready";
    const hasSpeaker = ready && this.devices.some((d) => isSpeaker(d) && d.online);
    const hint = ready ? speakerHint(this.devices) : "";
    this.speakerHintText = hint;
    this.speakerHintVisible = Boolean(hint);
    this.voiceBarVisible = hasSpeaker;
    this.syncTrayHeight();
  }

  pickSpeaker(): DeviceInfo | null {
    if (this.accessState !== "ready") {
      return null;
    }
    const pref = settingsStore.getDefaultSpeakerDid();
    if (pref) {
      const preferred = this.devices.find((d) => d.did === pref && isSpeaker(d) && d.online);
      if (preferred) {
        return preferred;
      }
    }
    return this.devices.find((d) => isSpeaker(d) && d.online) ?? null;
  }

  updateAudioBar(): void {
    const speaker = this.pickSpeaker();
    if (speaker !== null) {
      this.audioBar.setSpeaker(speaker.did, speaker.name);
      if (!this.visible) {
        this.audioBar.stopTimers();
      }
    } else {
      this.audioBar.setSpeaker(null);
    }
    this.quickDragHandleVisible = speaker === null;
    this.syncTrayHeight();
  }

  buildSpeakerMenu(): SpeakerMenuOption[] {
    const pref = settingsStore.getDefaultSpeakerDid();
    const speakers = this.devices
      .filter((d) => isSpeaker(d))
      .sort((a, b) => {
        const onlineDiff = (a.online ? 0 : 1) - (b.online ? 0 : 1);
        if (onlineDiff !== 0) return onlineDiff;
        if (a.name !== b.name) return a.name < b.name ? -1 : 1;
        return a.did < b.did ? -1 : a.did > b.did ? 1 : 0;
      });
    const options: SpeakerMenuOption[] = [
      {
        did: "",
        label: "自动（第一个在线音箱）",
        enabled: true,
        checked: pref === "",
        trigger: () => this.selectSpeaker(""),
      },
    ];
    for (const d of speakers) {
      options.push({
        did: d.did,
        label: `${d.name}（${d.room_name}）${d.online ? "" : " · 离线"}`,
        enabled: d.online,
        checked: d.did === pref,
        trigger: () => this.selectSpeaker(d.did),
      });
    }
    return options;
  }

  selectSpeaker(did: string): void {
    if (did && !this.devices.some((d) => d.did === did && isSpeaker(d) && d.online)) {
      return;
    }
    settingsStore.setDefaultSpeakerDid(did);
    this.updateAudioBar();
    this.events.emit("speakerChanged");
    this.emitStateChanged();
  }

  emitVoice(text?: string): void {
    const command = (text ?? this.voiceText).trim();
    if (!command) {
      return;
    }
    const speaker = this.pickSpeaker();
    if (speaker === null) {
      return;
    }
    const pref = settingsStore.getDefaultSpeakerDid();
    let fallbackNote = "";
    if (pref && pref !== speaker.did) {
      fallbackNote = `（首选音箱离线，已由「${speaker.name}」代答）`;
      settingsStore.setDefaultSpeakerDid("");
    }
    this.voiceText = "";
    if (!this.service.runAction) {
      return;
    }
    const did = speaker.did;
    this.jobs.submit(() => this.service.runAction!(did, "execute-text-directive", [command]), {
      onSuccess: () => {
        if (this.disposed) return;
        this.audioBar.refreshAfterCommand(did);
        this.notifyToast(`已告诉小爱同学：${command}${fallbackNote}`, 3000);
      },
      onError: (err) => {
        if (this.disposed) return;
        this.notifyToast(`执行失败：${toError(err).message}`, 4000);
      },
    });
  }

  syncTrayHeight(): void {
    if (this.lightControl !== null) {
      return;
    }
    if (this.accessState !== "ready") {
      this.minHeight = 140 + 2 * SHADOW_PAD;
      this.resize(this.size.width, 140 + 2 * SHADOW_PAD);
      return;
    }
    this.minHeight = 280 + 2 * SHADOW_PAD;
    this.separatorVisible = this.audioBar.visible;
    const audioH = this.audioBar.visible ? 136 + 1 : 0;
    const voiceH = this.voiceBarVisible ? 36 + 8 : 0;
    const topMargin = this.audioBar.visible ? 4 : 8;
    const rootH = 26 + LIST_HEIGHT + topMargin + 10 + 16;
    let h = audioH + rootH + voiceH + (this.speakerHintVisible ? 36 : 0) + 2 * SHADOW_PAD;
    const screen = this.env.primaryScreen();
    if (screen !== null) {
      const maxH = screen.availableGeometry.height - 20;
      h = Math.min(h, maxH);
    }
    h = Math.max(h, this.minHeight);
    if (Math.abs(h - this.size.height) < 2) {
      return;
    }
    if (this.explicitlyVisible) {
      const oldH = this.size.height;
      this.resize(this.size.width, h);
      const delta = h - oldH;
      this.move({ x: this.position.x, y: this.position.y - delta });
    } else {
      this.resize(this.size.width, h);
    }
  }

  // ---------- 拖拽与位置持久化 ----------

  private isDragSurfaceValid(surface: DragSurface, localY?: number): boolean {
    if (surface === "speaker_button") {
      return false;
    }
    if (this.lightControl !== null) {
      return surface === "light_header" || surface === "light_title" || surface === "light_power_text";
    }
    if (
      surface === "drag_header" ||
      surface === "drag_title" ||
      surface === "audio_drag_header" ||
      surface === "audio_drag_handle" ||
      surface === "quick_drag_handle" ||
      surface === "audio_top_padding"
    ) {
      return true;
    }
    if (surface === "window" || surface === "panel" || surface === "audio_bar") {
      const headerBottom = this.audioBar.visible ? 48 : 36;
      return (
        this.dragStartGlobal !== null ||
        (localY !== undefined && localY >= SHADOW_PAD && localY <= headerBottom)
      );
    }
    return false;
  }

  beginDrag(surface: DragSurface, globalPoint: Point, localY?: number): boolean {
    if (!this.isDragSurfaceValid(surface, localY)) {
      return false;
    }
    this.dragStartGlobal = { x: globalPoint.x, y: globalPoint.y };
    this.dragStartPos = { x: this.position.x, y: this.position.y };
    this.stopLeaveTimer();
    return true;
  }

  updateDrag(globalPoint: Point, leftButtonDown = true): boolean {
    if (!this.dragStartGlobal || !this.dragStartPos || !leftButtonDown) {
      return false;
    }
    const dx = globalPoint.x - this.dragStartGlobal.x;
    const dy = globalPoint.y - this.dragStartGlobal.y;
    const manhattan = Math.abs(dx) + Math.abs(dy);
    if (this.dragging || manhattan >= this.env.startDragDistance()) {
      this.dragging = true;
      const screen = this.env.screenAt(globalPoint) ?? this.currentScreen();
      const next = this.clampPosition(
        { x: this.dragStartPos.x + dx, y: this.dragStartPos.y + dy },
        screen,
      );
      this.move(next);
    }
    return true;
  }

  endDrag(): boolean {
    if (!this.dragStartGlobal) {
      return false;
    }
    if (this.dragging) {
      this.savePosition();
    }
    this.dragStartGlobal = null;
    this.dragStartPos = null;
    this.dragging = false;
    return true;
  }

  clampPosition(point: Point, screen: ScreenInfo | null): Point {
    if (screen === null) {
      return { x: point.x, y: point.y };
    }
    const geo = screen.availableGeometry;
    return {
      x: Math.max(geo.x, Math.min(point.x, geo.x + geo.width - this.size.width)),
      y: Math.max(geo.y, Math.min(point.y, geo.y + geo.height - this.size.height)),
    };
  }

  popupPosition(): Point {
    const saved = settingsStore.getTrayPosition();
    const screens = this.env.screens();
    const matched = saved ? screens.find((s) => s.name === saved.screen) ?? null : null;
    const screen = matched ?? this.env.screenAt(this.env.cursorPos()) ?? this.env.primaryScreen();
    if (screen === null) {
      return { x: this.position.x, y: this.position.y };
    }
    const geo = screen.availableGeometry;
    const point: Point = saved
      ? { x: geo.x + saved.x, y: geo.y + saved.y }
      : { x: geo.x + geo.width - this.size.width, y: geo.y + geo.height - this.size.height };
    return this.clampPosition(point, screen);
  }

  savePosition(): void {
    const center: Point = {
      x: this.position.x + Math.floor(this.size.width / 2),
      y: this.position.y + Math.floor(this.size.height / 2),
    };
    const screen = this.env.screenAt(center) ?? this.currentScreen();
    if (screen === null) {
      return;
    }
    const point = this.clampPosition(this.position, screen);
    this.move(point);
    this.targetPos = { ...point };
    const geo = screen.availableGeometry;
    settingsStore.setTrayPosition({
      screen: screen.name,
      x: point.x - geo.x,
      y: point.y - geo.y,
    });
  }

  resetPosition(): void {
    settingsStore.setTrayPosition(null);
    if (this.visible) {
      this.targetPos = this.popupPosition();
      this.move(this.targetPos);
      this.emitStateChanged();
    }
  }

  private currentScreen(): ScreenInfo | null {
    const center: Point = {
      x: this.position.x + Math.floor(this.size.width / 2),
      y: this.position.y + Math.floor(this.size.height / 2),
    };
    return this.env.screenAt(center) ?? this.env.primaryScreen();
  }

  // ---------- 显隐与自动隐藏 ----------

  show(): void {
    if (this.disposed) return;
    this.visible = true;
    this.audioBar.resumePollingIfVisible();
    this.emitStateChanged();
  }

  showNearTray(): void {
    if (this.accessState !== "ready") {
      this.setAccessState(this.accessState);
      this.showImmediately();
      return;
    }
    this.trayDids = trayStore.load();
    this.trayScenes = trayStore.loadScenes();
    this.trayOrder = trayStore.loadOrder();
    this.rebuild();
    this.updateAudioBar();
    this.updateVoiceBar();
    if (this.service.readMetrics && this.trayDids) {
      const dids = this.trayDids.filter((d) => this.metrics[d] == null);
      if (dids.length > 0) {
        try {
          this.jobs.submit(() => this.service.readMetrics!(dids), {
            onSuccess: (m) => {
              const merged: Record<string, string | null> = { ...this.metrics };
              for (const [k, v] of Object.entries(m)) {
                if (v) {
                  merged[k] = v;
                }
              }
              this.setMetrics(merged);
            },
            onError: () => {
              // ignore metric errors
            },
          });
        } catch {
          // ignore
        }
      }
    }
    this.showImmediately();
  }

  showImmediately(): void {
    this.syncTrayHeight();
    this.targetPos = this.popupPosition();
    this.pointerHasEntered = false;
    this.stopLeaveTimer();
    this.leaveTimerIntervalMs = 3000;
    this.move(this.targetPos);
    this.explicitlyVisible = true;
    this.visible = true;
    this.audioBar.resumePollingIfVisible();
    this.emitStateChanged();
  }

  hide(): void {
    if (this.lightControl !== null) {
      this.lightControl.reject();
    }
    this.visible = false;
    this.explicitlyVisible = false;
    this.dragStartGlobal = null;
    this.dragStartPos = null;
    this.dragging = false;
    this.pointerHasEntered = false;
    this.stopLeaveTimer();
    this.audioBar.stopTimers();
    this.emitStateChanged();
  }

  onPointerEnter(): void {
    this.pointerHasEntered = true;
    this.stopLeaveTimer();
    this.leaveTimerIntervalMs = 300;
  }

  onPointerLeave(): void {
    if (this.pointerHasEntered && !this.dragging) {
      this.startLeaveTimer();
    }
  }

  hideAfterPointerLeave(): void {
    if (this.lightControl !== null) {
      // Adjusting a light stays open until Return or outside activation.
      return;
    }
    if (!this.visible || this.dragging || this.containsPoint(this.env.cursorPos())) {
      return;
    }
    if (this.env.hasActivePopup()) {
      this.startLeaveTimer();
      return;
    }
    if (this.env.hasMouseButtonsPressed()) {
      this.startLeaveTimer();
      return;
    }
    this.hide();
  }

  maybeHideOnDeactivate(): void {
    if (this.disposed || !this.visible || this.dragging) {
      return;
    }
    if (this.env.isWindowActive() || this.env.isUnderMouse()) {
      return;
    }
    if (this.env.hasOtherActiveAppWindow()) {
      return;
    }
    if (!this.pointerHasEntered) {
      if (!this.leaveTimerActive) {
        this.startLeaveTimer();
      }
      return;
    }
    this.hide();
  }

  maybeHideOnFocusOut(): void {
    this.maybeHideOnDeactivate();
  }

  private containsPoint(pt: Point): boolean {
    return (
      pt.x >= this.position.x &&
      pt.x < this.position.x + this.size.width &&
      pt.y >= this.position.y &&
      pt.y < this.position.y + this.size.height
    );
  }

  private startLeaveTimer(): void {
    this.stopLeaveTimer();
    this.leaveTimerHandle = this.timers.setTimeout(() => {
      this.leaveTimerHandle = null;
      this.hideAfterPointerLeave();
    }, this.leaveTimerIntervalMs);
  }

  private stopLeaveTimer(): void {
    if (this.leaveTimerHandle !== null) {
      this.timers.clearTimeout(this.leaveTimerHandle);
      this.leaveTimerHandle = null;
    }
  }

  // ---------- 内嵌灯光控制 ----------

  showLightControls(device: DeviceInfo): void {
    if (this.accessState !== "ready" || !device.online || !isLight(device) || !hasDeviceDetails(device)) {
      return;
    }
    if (this.lightControl !== null) {
      this.lightControl.reject();
    }
    const pane = new LightControlController(adaptLightService(this.service), this.jobs, device, {
      embedded: true,
      timers: this.timers,
    });
    pane.resize(this.size.width - 2 * SHADOW_PAD, this.size.height - 2 * SHADOW_PAD);
    pane.setBackdrop({
      capturedFrom: "overview",
      width: this.size.width - 2 * SHADOW_PAD,
      height: this.size.height - 2 * SHADOW_PAD,
    });
    pane.show();

    this.lightControl = pane;
    this.overviewPageEnabled = false;
    this.overviewPageUpdatesEnabled = false;
    this.overviewPageHidden = true;
    this.overviewPageDetached = true;
    this.currentPage = "light";

    pane.events.on("powerChanged", (state) => {
      this.applyPower({ [device.did]: state });
    });
    pane.events.on("finished", () => {
      if (this.lightControl === pane) {
        this.lightControl = null;
        this.overviewPageDetached = false;
        this.overviewPageHidden = false;
        this.overviewPageUpdatesEnabled = true;
        this.overviewPageEnabled = true;
        this.currentPage = "overview";
        this.emitStateChanged();
      }
    });

    this.stopLeaveTimer();
    pane.load();
    this.emitStateChanged();
  }

  // ---------- 电源与列表构建 ----------

  refreshPower(dids: string[]): void {
    if (dids.length === 0 || !this.service.powerStates) {
      return;
    }
    this.jobs.submit(() => this.service.powerStates!(dids), {
      onSuccess: (states) => this.applyPower(states),
      onError: () => {
        // ignore background power errors
      },
    });
  }

  applyPower(states: Record<string, boolean | null>): void {
    if (this.disposed) {
      return;
    }
    for (const [did, st] of Object.entries(states)) {
      this.knownPower[did] = st;
    }
    for (const dev of this.devices) {
      if (dev.switch_channels.length > 0) {
        const row = this.rows.find((r) => r.type === "device" && r.id === dev.did);
        if (row) {
          row.subtitle = deviceSubtitle(dev, this.metrics[dev.did] ?? null, this.knownPower);
        }
      }
    }
    for (const [did, st] of Object.entries(states)) {
      const row = this.rows.find((r) => r.type === "device" && r.id === did);
      if (row && row.hasPowerBtn) {
        row.powerState = st;
      }
    }
    this.emitStateChanged();
  }

  makeRow(dev: DeviceInfo, index = 0): TrayQuickRow {
    const known = supportsCardPower(dev) ? (this.knownPower[dev.did] ?? null) : null;
    const cam = isCamera(dev);
    const adjustableLight = isLight(dev) && hasDeviceDetails(dev);
    const clickable = hasDeviceDetails(dev) && dev.online;
    return {
      type: "device",
      id: dev.did,
      title: deviceTitle(dev),
      subtitle: deviceSubtitle(dev, this.metrics[dev.did] ?? null, this.knownPower),
      online: dev.online,
      hasPowerBtn: known !== null,
      powerState: known,
      powerBusy: false,
      hasPlayBtn: cam,
      playBtnEnabled: cam && dev.online,
      hasCameraTag: cam,
      hasLightTag: !cam && adjustableLight,
      hasSceneRunBtn: false,
      sceneRunBusy: false,
      clickable,
      cursor: clickable ? "pointer" : "default",
      rowIndex: Math.floor(index / this.columns),
      colIndex: index % this.columns,
    };
  }

  makeSceneRow(scene: SceneInfo, index = 0): TrayQuickRow {
    return {
      type: "scene",
      id: scene.scene_id,
      title: scene.name,
      subtitle: scene.home_name || "手动场景",
      online: true,
      hasPowerBtn: false,
      powerState: null,
      powerBusy: false,
      hasPlayBtn: false,
      playBtnEnabled: false,
      hasCameraTag: false,
      hasLightTag: false,
      hasSceneRunBtn: true,
      sceneRunBusy: false,
      clickable: false,
      cursor: "default",
      rowIndex: Math.floor(index / this.columns),
      colIndex: index % this.columns,
    };
  }

  rebuild(): void {
    this.rows = [];
    this.sceneLookup.clear();

    if (this.accessState !== "ready") {
      this.emptyText = MESSAGES[this.accessState] ?? "";
      this.emptyVisible = true;
      this.listVisible = false;
      return;
    }

    this.emptyText = EMPTY_TRAY_TEXT;
    const dids = this.trayDids ?? (this.trayDids = trayStore.load());
    const sceneData = this.trayScenes ?? (this.trayScenes = trayStore.loadScenes());
    const order = this.trayOrder ?? (this.trayOrder = trayStore.loadOrder());

    const lookup = new Map<string, DeviceInfo>(this.devices.map((d) => [d.did, d]));
    const didSet = new Set<string>(dids);
    for (const s of sceneData) {
      this.sceneLookup.set(s.scene_id, createSceneInfo(s));
    }

    const built: TrayQuickRow[] = [];
    const seen = new Set<string>();
    const markKey = (type: "device" | "scene", id: string): string => `${type}:${id}`;

    for (const item of order) {
      if (item.type === "device" && didSet.has(item.id) && lookup.has(item.id)) {
        built.push(this.makeRow(lookup.get(item.id)!, built.length));
        seen.add(markKey("device", item.id));
      } else if (item.type === "scene" && this.sceneLookup.has(item.id)) {
        built.push(this.makeSceneRow(this.sceneLookup.get(item.id)!, built.length));
        seen.add(markKey("scene", item.id));
      }
    }

    for (const d of dids) {
      if (!seen.has(markKey("device", d)) && lookup.has(d)) {
        built.push(this.makeRow(lookup.get(d)!, built.length));
        seen.add(markKey("device", d));
      }
    }

    for (const s of sceneData) {
      const sid = s.scene_id;
      if (!seen.has(markKey("scene", sid)) && this.sceneLookup.has(sid)) {
        built.push(this.makeSceneRow(this.sceneLookup.get(sid)!, built.length));
        seen.add(markKey("scene", sid));
      }
    }

    if (built.length === 0) {
      this.emptyVisible = true;
      this.listVisible = false;
      return;
    }

    this.rows = built;
    this.emptyVisible = false;
    this.listVisible = true;

    const onlineDidSet = new Set<string>();
    for (const d of dids) {
      const dev = lookup.get(d);
      if (dev && dev.online && this.knownPower[d] == null) {
        onlineDidSet.add(d);
      }
    }
    for (const d of dids) {
      const dev = lookup.get(d);
      if (dev && dev.online) {
        for (const child of dev.switch_channels) {
          const childDev = lookup.get(child);
          if (childDev && childDev.online) {
            onlineDidSet.add(child);
          }
        }
      }
    }
    const onlineDids = [...onlineDidSet];
    if (onlineDids.length > 0) {
      this.refreshPower(onlineDids);
    }
  }

  // ---------- 行交互与右键移除菜单 ----------

  clickRow(did: string): void {
    const row = this.rows.find((r) => r.type === "device" && r.id === did);
    if (!row || !row.clickable) {
      return;
    }
    this.events.emit("openDeviceRequested", did);
  }

  clickCameraPlay(did: string): void {
    const row = this.rows.find((r) => r.type === "device" && r.id === did);
    if (row) {
      if (!row.hasPlayBtn || !row.playBtnEnabled) {
        return;
      }
      this.events.emit("openDeviceRequested", did);
      return;
    }
    // Fallback for single-row tests created via makeRow(dev)
    const dev = this.devices.find((d) => d.did === did);
    if (dev && isCamera(dev) && dev.online) {
      this.events.emit("openDeviceRequested", did);
    }
  }

  toggleRowPower(did: string): void {
    const row = this.rows.find((r) => r.type === "device" && r.id === did);
    if (!row || !row.hasPowerBtn || !this.service.togglePower) {
      return;
    }
    row.powerBusy = true;
    this.emitStateChanged();
    this.jobs.submit(() => this.service.togglePower!(did), {
      onSuccess: (nextState) => {
        if (this.disposed) return;
        this.knownPower[did] = nextState;
        this.applyPower({ [did]: nextState });
        row.powerState = nextState;
        row.powerBusy = false;
        this.emitStateChanged();
      },
      onError: () => {
        if (this.disposed) return;
        row.powerBusy = false;
        this.emitStateChanged();
      },
    });
  }

  runScene(sceneId: string): void {
    const row = this.rows.find((r) => r.type === "scene" && r.id === sceneId);
    const scene = this.sceneLookup.get(sceneId);
    if (!row || !scene || !this.service.runScene) {
      return;
    }
    row.sceneRunBusy = true;
    this.emitStateChanged();
    this.jobs.submit(() => this.service.runScene!(scene), {
      onSuccess: () => {
        if (this.disposed) return;
        row.sceneRunBusy = false;
        this.notifyToast(`已执行场景「${scene.name}」`, 2200);
        this.emitStateChanged();
      },
      onError: (err) => {
        if (this.disposed) return;
        row.sceneRunBusy = false;
        this.notifyToast(`执行场景「${scene.name}」失败：${toError(err).message}`, 4000);
        this.emitStateChanged();
      },
    });
  }

  buildRemoveMenu(kind: "device" | "scene", id: string): TrayMenuAction[] {
    return [
      {
        label: "从托盘窗口移除",
        enabled: true,
        trigger: () => {
          this.events.emit("removeTrayItemRequested", kind, id);
        },
      },
    ];
  }

  dispose(): void {
    this.disposed = true;
    if (this.lightControl !== null) {
      this.lightControl.reject();
    }
    this.stopLeaveTimer();
    this.audioBar.dispose();
  }

  private notifyToast(message: string, durationMs: number): void {
    this.events.emit("toastRequested", message, durationMs);
    this.onToast?.(message, durationMs);
  }

  private emitStateChanged(): void {
    this.events.emit("stateChanged");
  }
}

/**
 * 系统托盘图标控制器：常驻图标 + 快捷窗口 + 右键菜单。
 */
export class TrayController {
  readonly tooltip = TRAY_TOOLTIP;
  readonly hasHoverPopup = false;

  quick!: TrayQuickWindowController;
  trayVisible = true;
  iconFile = "app/ui/tray_icon.png";

  private readonly service: TrayQuickService;
  private readonly jobs: IJobExecutor;
  private readonly main: TrayMainHost;
  private readonly nowMs: () => number;
  private readonly doubleClickIntervalMs: number;
  private readonly scheduleNextTick: (fn: () => void) => void;
  private readonly quickOptions: TrayQuickWindowOptions;
  private readonly quickFactory?: () => TrayQuickWindowController;
  private readonly onQuitApp?: () => void;
  private readonly systemTrayAvailable: boolean;

  private pendingShow = false;
  private lastTrayClickMs: number | null = null;
  private quickUnsubscribers: Array<() => void> = [];

  constructor(
    service: TrayQuickService | IMijiaService,
    jobs: IJobExecutor,
    mainWindow: TrayMainHost,
    options: TrayControllerOptions = {},
  ) {
    this.service = service;
    this.jobs = jobs;
    this.main = mainWindow;
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.doubleClickIntervalMs = options.doubleClickIntervalMs ?? 400;
    this.scheduleNextTick = options.scheduleNextTick ?? ((fn) => {
      setTimeout(fn, 0);
    });
    this.quickOptions = options.quickOptions ?? {};
    this.quickFactory = options.quickFactory;
    this.onQuitApp = options.onQuitApp;
    this.systemTrayAvailable = options.systemTrayAvailable ?? true;

    this.createQuickWindow();
    this.applySystemIconTheme(options.initialColorScheme ?? "dark");
  }

  applySystemIconTheme(scheme: "light" | "dark"): void {
    this.iconFile = scheme === "light" ? "app/ui/tray_icon_light.png" : "app/ui/tray_icon.png";
  }

  private createQuickWindow(): void {
    for (const unsub of this.quickUnsubscribers) {
      unsub();
    }
    this.quickUnsubscribers = [];

    this.quick = this.quickFactory
      ? this.quickFactory()
      : new TrayQuickWindowController(this.service, this.jobs, this.quickOptions);

    let state: AccessState =
      this.main.networkOnline === false
        ? "offline"
        : this.main.loggedOut
          ? "signed_out"
          : "ready";
    if (typeof this.main.accessState === "function") {
      state = this.main.accessState();
    }
    this.quick.setAccessState(state);

    this.quickUnsubscribers.push(
      this.quick.events.on("manageRequested", () => this.onManage()),
      this.quick.events.on("openDeviceRequested", (did) => this.onOpenDevice(did)),
      this.quick.events.on("removeTrayItemRequested", (kind, id) => {
        this.main.removeTrayItem?.(kind, id);
      }),
      this.quick.events.on("speakerChanged", () => {
        this.main.updateVoiceFab?.();
      }),
    );
  }

  buildContextMenu(): TrayMenuAction[] {
    return [
      { label: "显示主窗口", enabled: true, trigger: () => this.showMain() },
      { label: "编辑卡片", enabled: true, trigger: () => this.emitManage() },
      { label: "设置", enabled: true, trigger: () => this.onSettings() },
      { label: "托盘悬浮窗位置还原", enabled: true, trigger: () => this.resetQuickPosition() },
      { label: "", enabled: false, separator: true, trigger: () => {} },
      { label: "退出", enabled: true, trigger: () => this.quit() },
    ];
  }

  refreshSpeaker(): void {
    this.quick.updateAudioBar();
  }

  refreshAudioAfterCommand(did: string): void {
    this.quick.audioBar.refreshAfterCommand(did);
  }

  emitManage(): void {
    this.quick.events.emit("manageRequested");
  }

  onActivated(reason: TrayActivationReason): void {
    if (reason !== "trigger" && reason !== "double_click") {
      return;
    }
    // 第一下立即响应，双击和它随后的松开通知不再切换第二次。
    const now = this.nowMs();
    if (this.lastTrayClickMs !== null && now - this.lastTrayClickMs < this.doubleClickIntervalMs) {
      if (reason === "double_click") {
        this.lastTrayClickMs = now;
      }
      return;
    }
    this.lastTrayClickMs = now;

    this.main.networkMonitor?.checkNow();
    if (this.main.loggedOut && (this.main.networkOnline ?? true)) {
      this.showMain();
      this.scheduleNextTick(() => {
        this.main.loginAccount?.();
      });
      return;
    }

    const visible = this.quick.visible || this.quick.isExplicitlyVisible();
    if (visible) {
      this.quick.hide();
    } else {
      this.quick.showNearTray();
    }
  }

  showMain(): void {
    this.quick.hide();
    this.main.show();
    this.main.raise?.();
    this.main.activateWindow?.();
    if (this.main.isMinimized?.()) {
      this.main.showNormal?.();
    }
  }

  quit(): void {
    this.trayVisible = false;
    this.main.requestForceQuit?.();
    this.main.close?.();
    this.onQuitApp?.();
  }

  onManage(): void {
    this.main.showTrayManager();
  }

  onSettings(): void {
    // Settings belongs to the main window, not the auto-hiding quick popup.
    this.quick.hide();
    if (this.main.isMinimized?.()) {
      this.main.showNormal?.();
    } else {
      this.main.show();
    }
    this.main.raise?.();
    this.main.activateWindow?.();
    // Finish dismissing the tray context menu before entering the modal layer.
    this.scheduleNextTick(() => {
      this.main.showSettings();
    });
  }

  resetQuickPosition(): void {
    this.quick.resetPosition();
  }

  onOpenDevice(did: string): void {
    // Lights stay inside the quick window; cameras use their preview window.
    const dev = this.main.devices().find((d) => d.did === did);
    if (!dev) {
      return;
    }
    if (!hasDeviceDetails(dev) || !dev.online) {
      return;
    }
    if (isLight(dev)) {
      this.quick.showLightControls(dev);
      return;
    }
    this.quick.hide();
    if (dev.model.includes(".camera.") || isCamera(dev)) {
      this.main.openCameraWindow?.(dev);
    }
  }

  setDevices(devices: DeviceInfo[], knownPower: Record<string, boolean | null>): void {
    this.quick.setDevices(devices, knownPower);
  }

  setAccessState(state: AccessState): void {
    this.quick.setAccessState(state);
  }

  setMetrics(metrics: Record<string, string | null>): void {
    this.quick.setMetrics(metrics);
    if (this.pendingShow) {
      // 重建前窗口正显示着：设备填充完毕后再呼出，避免空窗口闪现
      this.pendingShow = false;
      this.quick.showNearTray();
    }
  }

  retheme(): void {
    const wasVisible = this.quick.visible || this.quick.isExplicitlyVisible();
    this.quick.hide();
    this.quick.dispose();
    this.createQuickWindow();
    this.pendingShow = wasVisible;
  }

  hideQuick(): void {
    this.quick.hide();
  }

  setTrayVisible(visible: boolean): void {
    this.trayVisible = visible;
  }

  isAvailable(): boolean {
    return this.systemTrayAvailable;
  }

  dispose(): void {
    for (const unsub of this.quickUnsubscribers) {
      unsub();
    }
    this.quickUnsubscribers = [];
    this.quick.dispose();
  }
}
