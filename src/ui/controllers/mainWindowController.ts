// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * 主窗口控制器（1:1 移植自 app/ui/main_window.py）：
 * 编排登录与账号切换、网络可达性与访问态、分层加载进度与超时看门狗、
 * 家庭与房间筛选、自适应宽度卡片网格、快速开关与读数轮询、场景视图、
 * 灯光与摄像头子窗、小爱语音悬浮球及托盘联动。
 */

import { statSync } from "node:fs";
import * as accountStore from "../../core/accountStore.ts";
import { APP_NAME, trimWorkingSet } from "../../core/appMeta.ts";
import { MESSAGES, NetworkMonitor, speakerHint } from "../../core/availability.ts";
import * as banStore from "../../core/banStore.ts";
import * as deviceCache from "../../core/cache.ts";
import {
  TypedEmitter,
  type AccessState,
  type IJobExecutor,
  type IMijiaService,
  type Point,
  type Rect,
} from "../../core/contracts.ts";
import {
  hasDeviceDetails,
  isCamera,
  isLight,
  prepareDeviceCards,
  pruneTraySelection,
  supportsCardPower,
  trayEligible,
} from "../../core/deviceControls.ts";
import * as iconStore from "../../core/iconStore.ts";
import { isSpeaker, type DeviceInfo, type SceneInfo } from "../../core/models.ts";
import * as settingsStore from "../../core/settingsStore.ts";
import * as trayStore from "../../core/trayStore.ts";
import { LATEST_API, type ReleaseInfo, type UpdateChecker } from "../../core/updateChecker.ts";
import {
  BRAND_CAPTION_HEIGHT,
  RESIZE_MARGIN,
  SiColors,
  ThemeController,
  type ThemeName,
} from "../theme.ts";
import { CameraWindowController } from "./cameraPreviewController.ts";
import {
  CARD_FIXED_HEIGHT,
  CARD_FIXED_WIDTH,
  DeviceCardController,
} from "./deviceCardController.ts";
import { DiagnosticDialogController } from "./diagnosticDialogController.ts";
import { FooterBarController } from "./footerBarController.ts";
import { LightControlController } from "./lightControlController.ts";
import {
  buildRoomMenuEntries,
  RoomTabStripController,
  type RoomMenuModel,
} from "./roomTabsController.ts";
import { SettingsDialogController } from "./settingsDialogController.ts";
import { TrayManagerController } from "./trayManagerController.ts";
import { TrayController, type TrayMainHost } from "./trayQuickController.ts";
import { checkUpdate, type UpdateHost } from "./updateFlow.ts";
import {
  BOTTOM_RESERVED_HEIGHT,
  ToastLayoutController,
  VoiceFabController,
} from "./voiceFabController.ts";

// ---------- 业务常量 ----------

export const ALL_ROOMS = "全屋";
export const ALL_HOMES = "全部";
// 场景选项卡：位于「全屋」左侧的特殊房间值，选中后网格切换为场景视图
export const SCENE_TAB = "场景";
// 已屏蔽选项卡：独立展示被用户右键屏蔽（ban）的设备，不出现在常规智能控制列表
export const BANNED_TAB = "已屏蔽";

export const GRID_SPACING = 8;
// 外部（APP/语音）改状态后卡片靠轮询跟随；批量读一次请求
export const POLL_INTERVAL_MS = 5_000;
export const METRICS_INTERVAL_MS = 300_000;
export const LOAD_WATCHDOG_MS = 30_000;

export const DEFAULT_WINDOW_WIDTH = 1160;
export const DEFAULT_WINDOW_HEIGHT = 740;
export const MIN_WINDOW_WIDTH = 760;
export const MIN_WINDOW_HEIGHT = 520;

// Windows 原生窗口消息与命中测试代码
export const WM_NCCALCSIZE = 0x0083;
export const WM_NCHITTEST = 0x0084;
export const WM_NCLBUTTONDBLCLK = 0x00a3;
export const HTCLIENT = 1;
export const HTCAPTION = 2;
export const HTLEFT = 10;
export const HTRIGHT = 11;
export const HTTOP = 12;
export const HTTOPLEFT = 13;
export const HTTOPRIGHT = 14;
export const HTBOTTOM = 15;
export const HTBOTTOMLEFT = 16;
export const HTBOTTOMRIGHT = 17;

const ASCII_RE = /^[\x00-\x7f]*$/;
const RESIZE_DEBOUNCE_MS = 60;
const UPDATE_CHECK_DELAY_MS = 3_000;

// ---------- 纯辅助函数 ----------

/** 刷新结果通知文案：有增减报增减，无变化明确告知。 */
export function refreshSummary(total: number, added: number, removed: number): string {
  if (!added && !removed) {
    return `设备列表无变化（共 ${total} 台）`;
  }
  if (added && removed) {
    return `本次刷新：新增 ${added} 台，移除 ${removed} 台`;
  }
  if (added) {
    return `本次刷新：新增 ${added} 台设备`;
  }
  return `本次刷新：移除 ${removed} 台设备`;
}

/** 以最小卡片宽度计算列数，宽屏自动增加列数，不设单排上限。 */
export function columnsForWidth(viewportWidth: number, spacing: number = GRID_SPACING): number {
  const eff = Math.max(0, Math.trunc(viewportWidth));
  if (eff <= 0) {
    return 1;
  }
  const cols = Math.floor((eff + spacing) / (CARD_FIXED_WIDTH + spacing));
  return Math.max(1, cols);
}

/** 将整除余数像素分配到前若干列，保证整行卡片与外边距严格填满视口宽度。 */
export function gridCardWidth(
  viewportWidth: number,
  cols: number,
  column: number = 0,
  spacing: number = GRID_SPACING,
): number {
  const safeCols = Math.max(1, Math.trunc(cols));
  const totalCardsWidth = Math.trunc(viewportWidth) - (safeCols - 1) * spacing;
  const width = Math.floor(totalCardsWidth / safeCols);
  const remainder = totalCardsWidth - width * safeCols;
  return Math.max(CARD_FIXED_WIDTH, width + (column < remainder ? 1 : 0));
}

export interface NativeWindowMessage {
  message: number;
  wParam: number;
  lParam: number;
}

export interface NativeWindowHandlers {
  hitTest: (lParam: number) => number;
  toggleMaximized: () => void;
}

/**
 * Windows 无边框窗口原生消息分派：
 * - WM_NCCALCSIZE 交给平台插件处理，返回 [false, 0] 且不调用 hitTest；
 * - WM_NCHITTEST 转发给 hitTest 并返回 [true, code]；
 * - WM_NCLBUTTONDBLCLK 且命中标题栏 (HTCAPTION) 时切换最大化并返回 [true, 0]。
 */
export function handleNativeWindowEvent(
  msg: NativeWindowMessage,
  handlers: NativeWindowHandlers,
): [boolean, number] {
  if (msg.message === WM_NCCALCSIZE) {
    return [false, 0];
  }
  if (msg.message === WM_NCHITTEST) {
    return [true, handlers.hitTest(msg.lParam)];
  }
  if (msg.message === WM_NCLBUTTONDBLCLK && msg.wParam === HTCAPTION) {
    handlers.toggleMaximized();
    return [true, 0];
  }
  return [false, 0];
}

function lexCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isExistingFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function unrefHandle(handle: unknown): void {
  if (typeof handle === "object" && handle !== null && "unref" in handle) {
    (handle as { unref?: () => void }).unref?.();
  }
}

// ---------- 场景卡片控制器（自 app/ui/scene_card.py） ----------

export type SceneCardEvents = {
  executed: [string];
};

export class SceneCardController extends TypedEmitter<SceneCardEvents> {
  readonly scene: SceneInfo;
  readonly title: string;
  readonly subtitle: string;
  readonly height: number = CARD_FIXED_HEIGHT;

  busy = false;
  hovered = false;
  width: number = CARD_FIXED_WIDTH;
  disposed = false;

  constructor(scene: SceneInfo) {
    super();
    this.scene = scene;
    this.title = scene.name;
    this.subtitle = scene.home_name || "手动场景";
  }

  get backgroundColor(): string {
    return this.hovered ? SiColors.CARD_HOVER : SiColors.CARD;
  }

  setFixedWidth(width: number): void {
    this.width = width;
  }

  setBusy(busy: boolean): void {
    this.busy = Boolean(busy);
  }

  setHovered(hovered: boolean): void {
    this.hovered = Boolean(hovered);
  }

  clickRun(): void {
    if (!this.busy) {
      this.emit("executed", this.scene.scene_id);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.clear();
  }
}

// ---------- 定时器封装 ----------

export interface MainWindowTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

function defaultTimers(): MainWindowTimers {
  return {
    setTimeout: (fn, ms) => {
      const handle = setTimeout(fn, ms);
      unrefHandle(handle);
      return handle;
    },
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    setInterval: (fn, ms) => {
      const handle = setInterval(fn, ms);
      unrefHandle(handle);
      return handle;
    },
    clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  };
}

class ManagedTimer {
  private _handle: unknown | null = null;
  private _active = false;
  private readonly _repeating: boolean;
  private readonly _scheduleReal: boolean;
  private readonly _timers: MainWindowTimers;
  private readonly _defaultCallback?: () => void;

  constructor(
    repeating: boolean,
    scheduleReal: boolean,
    timers: MainWindowTimers,
    defaultCallback?: () => void,
  ) {
    this._repeating = repeating;
    this._scheduleReal = scheduleReal;
    this._timers = timers;
    this._defaultCallback = defaultCallback;
  }

  get active(): boolean {
    return this._active;
  }

  start(ms: number, callback?: () => void): void {
    this.stop();
    const fn = callback ?? this._defaultCallback;
    this._active = true;
    if (!this._scheduleReal || !fn) {
      return;
    }
    if (this._repeating) {
      this._handle = this._timers.setInterval(() => {
        fn();
      }, ms);
    } else {
      this._handle = this._timers.setTimeout(() => {
        this._handle = null;
        this._active = false;
        fn();
      }, ms);
    }
  }

  stop(): void {
    this._active = false;
    if (this._handle !== null) {
      if (this._repeating) {
        this._timers.clearInterval(this._handle);
      } else {
        this._timers.clearTimeout(this._handle);
      }
      this._handle = null;
    }
  }
}

// ---------- 主窗口辅助菜单类型 ----------

export interface HomeMenuOption {
  name: string;
  selected: boolean;
  trigger(): void;
}

export interface DeviceTrayMenuAction {
  label: string;
  selected: boolean;
  trigger(): void;
}

export interface DeviceBanMenuAction {
  label: string;
  banned: boolean;
  trigger(): void;
}

// ---------- 主窗口构造选项与事件 ----------

export interface MainWindowControllerOptions {
  service: IMijiaService;
  jobs: IJobExecutor;
  networkMonitor?: NetworkMonitor;
  themeCtrl?: ThemeController;
  tray?: TrayController | null;
  cacheLoader?: typeof deviceCache.load;
  cacheSaver?: typeof deviceCache.save;
  autoStartTimers?: boolean;
  timers?: Partial<MainWindowTimers>;
  viewportWidth?: number;
  initiallyVisible?: boolean;
  onLoginRequested?: () => Promise<boolean> | boolean | void;
  onPromptNewVersion?: (info: ReleaseInfo) => void;
  onShowSettings?: (dialog: SettingsDialogController) => void;
  onShowTrayManager?: (dialog: TrayManagerController) => void;
  onShowDiagnostics?: (dialog: DiagnosticDialogController) => void;
  onShowAbout?: (apiVersion: string) => void;
  onCriticalError?: (title: string, message: string) => void;
  onWarning?: (title: string, message: string) => void;
  onAppQuit?: () => void;
}

export type MainWindowEvents = {
  stateChanged: [];
  toastRequested: [text: string, durationMs: number];
  loginRequested: [];
  loginDialogActivated: [];
  updatePromptRequested: [info: ReleaseInfo];
  deviceTrayMenuRequested: [did: string, pos: Point];
  trayManagerOpened: [dialog: TrayManagerController];
  settingsOpened: [dialog: SettingsDialogController];
  diagnosticsOpened: [dialog: DiagnosticDialogController];
  aboutOpened: [apiVersion: string];
  restartRecommended: [];
  criticalError: [title: string, message: string];
  warning: [title: string, message: string];
  themeChanged: [theme: ThemeName];
  raised: [];
  activated: [];
  closed: [];
};

// ---------- 主窗口控制器 ----------

export class MainWindowController
  extends TypedEmitter<MainWindowEvents>
  implements TrayMainHost, UpdateHost
{
  readonly title: string = APP_NAME;
  readonly service: IMijiaService;
  readonly jobs: IJobExecutor;
  readonly networkMonitor: NetworkMonitor;
  readonly themeCtrl: ThemeController;
  readonly tray: TrayController | null;
  readonly footer: FooterBarController;
  readonly voiceFab: VoiceFabController;
  readonly roomStrip: RoomTabStripController;
  readonly toast: ToastLayoutController;
  readonly cards = new Map<string, DeviceCardController>();
  readonly sceneCards = new Map<string, SceneCardController>();
  readonly lightWindows = new Map<string, LightControlController>();
  readonly cameraWindows = new Map<string, CameraWindowController>();

  // 设备、家庭与房间视图状态
  allDevices: DeviceInfo[] = [];
  bannedDids: string[] = [];
  homes: string[] = [];
  currentHome = "";
  currentRoom = ALL_ROOMS;
  homeButtonText = "我的家庭";
  tabNames: string[] = [];
  knownPower: Record<string, boolean | null> = {};
  metrics: Record<string, string | null> = {};
  scenes: SceneInfo[] | null = null;
  sceneEmptyHint = "";

  // 加载与进度状态机
  loadingDevices = false;
  refreshButtonEnabled = true;
  refreshButtonAccessibleName = "刷新设备";
  refreshSpinning = false;
  loadGeneration = 0;
  loadActive = false;
  loadFullPage = false;
  loadShowFooter = false;
  loadValue = 0;
  loadPending = new Set<string>();
  loadHadFailure = false;
  loadingPageProgress = 0;
  loadingPageText = "正在准备设备…";
  activeContentView: "normal" | "loading" = "normal";
  footerVisible = true;

  // 访问与账号状态
  accountTransition = false;
  centralEnabled = true;
  loggedOut = true;
  loginDialogOpen = false;
  networkOnline: boolean;
  reconnecting = false;
  connectionFailed = false;
  updateCheckDone = false;

  // 轮询、布局与设置镜像
  pollInFlight = false;
  gridColumns = 0;
  gridDirty = false;
  viewportWidth: number;
  hideNoFunc: boolean;
  showSceneTab: boolean;
  loadingScenes = false;
  localizeBusy = false;
  voiceDid: string | null = null;

  // 顶栏与访问提示 UI 状态
  scrollVisible = false;
  homeBtnVisible = false;
  deviceSummaryVisible = false;
  roomStripVisible = false;
  roomMenuBtnVisible = false;
  accessHintText = "";
  accessHintVisible = false;
  countLabelText = "";
  onlineLabelText = "";
  summaryOnlineVisible = true;

  // 窗口可见性与几何状态
  visible: boolean;
  minimized = false;
  maximized = false;
  forceQuit = false;
  defaultSizeApplied = false;
  maxButtonGlyph = "\uE922";
  windowGeometry: Rect = {
    x: 0,
    y: 0,
    width: DEFAULT_WINDOW_WIDTH,
    height: DEFAULT_WINDOW_HEIGHT,
  };

  settingsDialog: SettingsDialogController | null = null;

  private readonly _cacheLoader: typeof deviceCache.load;
  private readonly _cacheSaver: typeof deviceCache.save;
  private readonly _autoStartTimers: boolean;
  private readonly _hasCustomTimers: boolean;
  private readonly _timers: MainWindowTimers;

  private readonly _resizeTimer: ManagedTimer;
  private readonly _pollTimer: ManagedTimer;
  private readonly _metricsTimer: ManagedTimer;
  private readonly _statusTimer: ManagedTimer;
  private readonly _loadWatchdog: ManagedTimer;
  private readonly _updateCheckTimer: ManagedTimer;

  private readonly _onLoginRequested?: () => Promise<boolean> | boolean | void;
  private readonly _onPromptNewVersion?: (info: ReleaseInfo) => void;
  private readonly _onShowSettings?: (dialog: SettingsDialogController) => void;
  private readonly _onShowTrayManager?: (dialog: TrayManagerController) => void;
  private readonly _onShowDiagnostics?: (dialog: DiagnosticDialogController) => void;
  private readonly _onShowAbout?: (apiVersion: string) => void;
  private readonly _onCriticalError?: (title: string, message: string) => void;
  private readonly _onWarning?: (title: string, message: string) => void;
  private readonly _onAppQuit?: () => void;

  private readonly _unsubscribers: Array<() => void> = [];
  private readonly _ownsNetworkMonitor: boolean;

  constructor(options: MainWindowControllerOptions) {
    super();
    this.service = options.service;
    this.jobs = options.jobs;
    this._cacheLoader = options.cacheLoader ?? deviceCache.load;
    this._cacheSaver = options.cacheSaver ?? deviceCache.save;
    this._autoStartTimers = options.autoStartTimers ?? false;
    this._hasCustomTimers = options.timers !== undefined;

    const defaults = defaultTimers();
    this._timers = {
      setTimeout: options.timers?.setTimeout ?? defaults.setTimeout,
      clearTimeout: options.timers?.clearTimeout ?? defaults.clearTimeout,
      setInterval: options.timers?.setInterval ?? defaults.setInterval,
      clearInterval: options.timers?.clearInterval ?? defaults.clearInterval,
    };

    const scheduleReal = this._autoStartTimers || this._hasCustomTimers;
    this._resizeTimer = new ManagedTimer(false, scheduleReal, this._timers, () =>
      this.onResizeSettled(),
    );
    this._pollTimer = new ManagedTimer(true, scheduleReal, this._timers, () => this.onPollTick());
    this._metricsTimer = new ManagedTimer(true, scheduleReal, this._timers, () => {
      this.refreshMetrics();
      this.pushTrayMetrics();
    });
    this._statusTimer = new ManagedTimer(false, scheduleReal, this._timers, () =>
      this.clearStatusHint(),
    );
    this._loadWatchdog = new ManagedTimer(false, scheduleReal, this._timers, () =>
      this.onLoadingTimeout(),
    );
    this._updateCheckTimer = new ManagedTimer(false, scheduleReal, this._timers);

    this._onLoginRequested = options.onLoginRequested;
    this._onPromptNewVersion = options.onPromptNewVersion;
    this._onShowSettings = options.onShowSettings;
    this._onShowTrayManager = options.onShowTrayManager;
    this._onShowDiagnostics = options.onShowDiagnostics;
    this._onShowAbout = options.onShowAbout;
    this._onCriticalError = options.onCriticalError;
    this._onWarning = options.onWarning;
    this._onAppQuit = options.onAppQuit;

    this.viewportWidth = options.viewportWidth ?? DEFAULT_WINDOW_WIDTH - 58;
    this.visible = options.initiallyVisible ?? true;
    this.hideNoFunc = settingsStore.getHideNoFuncDevices();
    this.showSceneTab = settingsStore.getShowSceneTab();
    this.bannedDids = banStore.load();

    // 网络与主题控制器
    this._ownsNetworkMonitor = options.networkMonitor === undefined;
    this.networkMonitor =
      options.networkMonitor ?? new NetworkMonitor({ autoStart: this._autoStartTimers });
    this.networkOnline = this.networkMonitor.online;

    this.themeCtrl = options.themeCtrl ?? new ThemeController();

    // 组合子控制器
    this.footer = new FooterBarController(BOTTOM_RESERVED_HEIGHT);
    this.voiceFab = new VoiceFabController({
      width: DEFAULT_WINDOW_WIDTH,
      height: DEFAULT_WINDOW_HEIGHT,
    });
    this.roomStrip = new RoomTabStripController();
    this.toast = new ToastLayoutController();

    // 系统托盘（显式传 null 时禁用；未传时自动创建并同步设置）
    if (options.tray !== undefined) {
      this.tray = options.tray;
    } else {
      try {
        this.tray = new TrayController(this.service, this.jobs, this);
        this.tray.setTrayVisible(settingsStore.getMinimizeToTray());
      } catch (err) {
        console.warn("[Tray] 创建失败:", err);
        this.tray = null;
      }
    }

    // 绑定事件
    this._unsubscribers.push(
      this.footer.on("checkRequested", () => {
        void this.checkFooterUpdate();
      }),
      this.footer.on("updateRequested", () => this.openFooterUpdate()),
      this.footer.on("accountRequested", () => this.changeAccount()),
      this.voiceFab.on("submitted", (text) => this.onVoiceCommand(text)),
      this.networkMonitor.on("changed", (online) => this.onNetworkChanged(online)),
      this.themeCtrl.on("themeChanged", (theme) => this.onThemeChanged(theme)),
      this.themeCtrl.on("systemSchemeChanged", (scheme) => this.onSystemSchemeChanged(scheme)),
    );

    this.syncAccessUi();
  }

  // ---------- 定时器状态只读视图 ----------

  get pollTimerActive(): boolean {
    return this._pollTimer.active;
  }

  get metricsTimerActive(): boolean {
    return this._metricsTimer.active;
  }

  get loadWatchdogActive(): boolean {
    return this._loadWatchdog.active;
  }

  get resizeTimerActive(): boolean {
    return this._resizeTimer.active;
  }

  get statusTimerActive(): boolean {
    return this._statusTimer.active;
  }

  // ---------- 分层加载生命周期 ----------

  beginLoading(fullPage = false, options: { showFooter?: boolean } = {}): void {
    const showFooter = options.showFooter ?? false;
    this.loadGeneration += 1;
    this.loadActive = true;
    this.loadFullPage = fullPage;
    this.loadShowFooter = showFooter && !fullPage;
    this.loadHadFailure = false;
    this.loadValue = 0;
    this.loadPending = new Set(["list"]);
    this._pollTimer.stop();
    this._metricsTimer.stop();
    this.footerVisible = !fullPage;
    if (fullPage) {
      this.voiceFab.collapse();
      this.voiceFab.setVisible(false);
      this.activeContentView = "loading";
    }
    this.onLoadingProgress(this.loadGeneration, 3, "正在准备设备…");
  }

  onLoadingProgress(generation: number, value: number, text: string): void {
    if (!this.loadActive || generation !== this.loadGeneration) {
      return;
    }
    this._loadWatchdog.start(LOAD_WATCHDOG_MS);
    this.loadValue = Math.max(this.loadValue, Math.min(100, value));
    this.loadingPageProgress = this.loadValue;
    this.loadingPageText = text;
    if (!this.loadShowFooter) {
      this.footer.setProgress(null);
      this.footer.setStatus("");
    } else {
      this.footer.setProgress(this.loadValue, text);
    }
    this.emitStateChanged();
  }

  prepareLoadingStates(): void {
    if (this.loadActive) {
      this.loadPending = new Set(["power", "metrics"]);
      this.onLoadingProgress(this.loadGeneration, 80, "正在读取设备状态…");
    }
  }

  loadTaskDone(
    task: string,
    options: { generation?: number | null; failed?: boolean } = {},
  ): void {
    const generation = options.generation ?? null;
    const failed = options.failed ?? false;
    if (
      !this.loadActive ||
      !this.loadPending.has(task) ||
      (generation !== null && generation !== this.loadGeneration)
    ) {
      return;
    }
    this.loadPending.delete(task);
    this.loadHadFailure = this.loadHadFailure || failed;
    if (this.loadPending.size > 0) {
      this.onLoadingProgress(this.loadGeneration, 90, "正在同步设备读数…");
    } else {
      this.finishLoading(true);
    }
  }

  finishLoading(success = true): void {
    if (!this.loadActive) {
      return;
    }
    if (success) {
      this.onLoadingProgress(this.loadGeneration, 100, "设备已就绪");
    }
    this.loadActive = false;
    this._loadWatchdog.stop();
    this._setRefreshBusy(false);
    this.loadGeneration += 1;
    this.loadPending.clear();
    this.activeContentView = "normal";
    this.footerVisible = true;
    this.footer.setProgress(null);
    this.clearStatusHint();
    this.updateVoiceFab();
    if (success && this.accessState() === "ready") {
      this._pollTimer.start(POLL_INTERVAL_MS);
      this._metricsTimer.start(METRICS_INTERVAL_MS);
    }
    if (success && this.loadHadFailure) {
      this.showStatus("设备已载入，部分状态暂未读取", 5000);
    }
    this.emitStateChanged();
  }

  onLoadingTimeout(): void {
    this.finishLoading(false);
    if (this.reconnecting) {
      this.connectionFailed = true;
      this.syncAccessUi();
    }
    this.showStatus("刷新超时，请检查网络后重试。", 8000);
  }

  acceptDeviceList(
    generation: number,
    resultOrOutcome?: DeviceInfo[] | { result?: DeviceInfo[]; error?: Error | null } | null,
    error?: Error | null,
  ): void {
    if (!this.loadActive || generation !== this.loadGeneration) {
      return;
    }
    let resolvedResult: DeviceInfo[] | null = null;
    let resolvedError: Error | null = error ?? null;
    if (
      resultOrOutcome !== null &&
      resultOrOutcome !== undefined &&
      !Array.isArray(resultOrOutcome)
    ) {
      resolvedResult = resultOrOutcome.result ?? null;
      resolvedError = resultOrOutcome.error ?? resolvedError;
    } else if (Array.isArray(resultOrOutcome)) {
      resolvedResult = resultOrOutcome;
    }

    if (resolvedError !== null) {
      this.onLoadError(resolvedError);
    } else {
      this.onDevicesLoaded(resolvedResult ?? []);
    }
  }

  // ---------- 访问态与网络可达性 ----------

  accessState(): AccessState {
    if (!this.networkOnline) {
      return "offline";
    }
    if (this.loggedOut) {
      return "signed_out";
    }
    if (this.reconnecting) {
      return this.connectionFailed ? "unavailable" : "loading";
    }
    return "ready";
  }

  syncAccessUi(): void {
    const state = this.accessState();
    const ready = state === "ready";
    const stateMessage = state === "ready" ? "" : MESSAGES[state];
    const hint = stateMessage || speakerHint(this.activeDevices());
    this.accessHintText = hint;
    this.accessHintVisible = Boolean(hint);
    this.scrollVisible = ready;
    this.homeBtnVisible = ready;
    this.deviceSummaryVisible = ready;
    this.roomStripVisible = ready;
    this.roomMenuBtnVisible = ready;
    this.service.setControlAccess(stateMessage);
    this.updateVoiceFab();
    if (this.tray !== null) {
      this.tray.quick.setAccessState(state);
    }
    if (!ready) {
      this.finishLoading(false);
      this._pollTimer.stop();
      this._metricsTimer.stop();
      for (const dialog of [...this.lightWindows.values()]) {
        if (dialog.alive()) {
          dialog.reject();
        }
      }
    }
    this.emitStateChanged();
  }

  onNetworkChanged(online: boolean): void {
    this.networkOnline = Boolean(online);
    if (this.networkOnline && !this.loggedOut) {
      this.reconnecting = true;
      this.connectionFailed = false;
      this.knownPower = {};
      this.metrics = {};
    }
    this.syncAccessUi();
    if (this.networkOnline) {
      if (this.loggedOut) {
        this.start();
      } else {
        this.loadDevices();
      }
    }
  }

  // ---------- 主题 ----------

  applyThemeMode(mode: string): ThemeName {
    return this.themeCtrl.setMode(mode);
  }

  applyThemeColor(color: string): ThemeName {
    return this.themeCtrl.setAccent(color);
  }

  onSystemSchemeChanged(scheme: ThemeName): void {
    if (this.tray !== null) {
      this.tray.applySystemIconTheme(scheme);
    }
  }

  onThemeChanged(theme: ThemeName): void {
    this.rebuildTabs();
    this.rebuildGrid();
    this.updateCountLabel();
    if (this.tray !== null) {
      // 托盘快捷窗口整窗重建后，立刻回填设备/开关/读数；
      // 若重建前窗口正显示，setMetrics 会自动重新呼出
      this.tray.retheme();
      this.updateTrayDevices();
      this.pushTrayMetrics();
    }
    if (this.allDevices.length > 0) {
      this.refreshPowerStates(false);
    }
    this.syncAccessUi();
    this.emit("themeChanged", theme);
  }

  // ---------- 状态提示、Toast 与版本更新 ----------

  showStatus(text: string, timeoutMs = 3000): void {
    this.footer.setStatus(this.loadActive && !this.loadShowFooter ? "" : text);
    this._statusTimer.stop();
    if (timeoutMs > 0) {
      this._statusTimer.start(timeoutMs, () => this.clearStatusHint());
    }
  }

  clearStatusHint(): void {
    this.footer.setStatus("");
  }

  showToast(text: string, durationMs = 4000): void {
    this.toast.show(
      text,
      { width: this.windowGeometry.width, height: this.windowGeometry.height },
      {
        fabState: {
          visible: this.voiceFab.visible,
          ballRect: this.voiceFab.ballRect,
        },
        durationMs,
      },
    );
    this.emit("toastRequested", text, durationMs);
  }

  checkFooterUpdate(
    options: {
      checker?: Pick<UpdateChecker, "on" | "check">;
      fetcher?: typeof fetch;
      currentVersion?: string;
    } = {},
  ): Promise<void> {
    return checkUpdate(this, { manual: true, ...options });
  }

  onUpdateAvailable(info: ReleaseInfo | null): void {
    this.footer.setRelease(info);
  }

  promptNewVersion(info: ReleaseInfo): void {
    this._onPromptNewVersion?.(info);
    this.emit("updatePromptRequested", info);
  }

  openFooterUpdate(): void {
    const info = this.footer.release;
    if (info !== null) {
      this.promptNewVersion(info);
    }
  }

  // ---------- 启动、登录与登出 ----------

  start(): void {
    if (!this.networkOnline) {
      this.syncAccessUi();
      return;
    }
    this.showStatus("正在检查登录状态…");
    this.jobs.submit(() => this.service.loginStatus(), {
      onSuccess: (loggedIn) => this.afterLoginCheck(Boolean(loggedIn)),
      onError: (exc) => {
        console.warn("登录状态检查失败:", exc.message);
        this.afterLoginCheck(false);
      },
    });
    this._maybeCheckUpdate();
  }

  private _maybeCheckUpdate(): void {
    if (this.updateCheckDone) {
      return;
    }
    this.updateCheckDone = true;
    if (!settingsStore.getCheckUpdateEnabled() || !LATEST_API) {
      return;
    }
    if (!this._autoStartTimers && !this._hasCustomTimers) {
      return;
    }
    this._updateCheckTimer.start(UPDATE_CHECK_DELAY_MS, () => {
      void checkUpdate(this, { manual: false });
    });
  }

  afterLoginCheck(loggedIn: boolean): void {
    if (loggedIn) {
      try {
        accountStore.activate(this.service.accountId());
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.showStatus(`无法读取账号配置：${message}`, 5000);
        return;
      }
      this.bannedDids = banStore.load();
      this.loggedOut = false;
      this.syncAccessUi();
      this.footer.setLoggedIn(true);
      this.startupLoad();
      return;
    }
    this.loggedOut = true;
    this.syncAccessUi();
    this.footer.setLoggedIn(false);
    this.clearStatusHint();
    this.loginAccount();
  }

  startupLoad(): void {
    this._pollTimer.start(POLL_INTERVAL_MS);
    this._metricsTimer.start(METRICS_INTERVAL_MS);
    const cached = this._cacheLoader();
    if (cached === null) {
      this.loadDevices({ fullPage: true });
      return;
    }
    this.beginLoading(true);
    const { devices, knownPower, metrics } = cached;
    Object.assign(this.knownPower, knownPower);
    Object.assign(this.metrics, metrics);
    this.showStatus("已从本地缓存加载，点击右上角刷新按钮可同步最新设备");
    this.prepareLoadingStates();
    this.applyDevices(devices);
  }

  loginAccount(): void {
    if (!this.networkOnline) {
      this.syncAccessUi();
      return;
    }
    if (this.loginDialogOpen) {
      this.emit("loginDialogActivated");
      return;
    }
    this.loginDialogOpen = true;
    this.emit("loginRequested");
    if (this._onLoginRequested) {
      Promise.resolve(this._onLoginRequested())
        .then((accepted) => {
          this.loginDialogOpen = false;
          if (accepted === true) {
            this.afterLoginCheck(true);
          }
        })
        .catch(() => {
          this.loginDialogOpen = false;
        });
    }
  }

  completeLogin(accepted: boolean): void {
    this.loginDialogOpen = false;
    if (accepted) {
      this.afterLoginCheck(true);
    }
  }

  changeAccount(): void {
    if (this.accountTransition) {
      return;
    }
    if (this.loggedOut) {
      this.loginAccount();
      return;
    }
    this.finishLoading(false);
    this.accountTransition = true;
    this._pollTimer.stop();
    this._metricsTimer.stop();
    this._resizeTimer.stop();
    this.voiceFab.collapse();
    this.voiceFab.setVisible(false);
    for (const win of [...this.cameraWindows.values()]) {
      win.close();
    }
    if (this.tray !== null) {
      this.tray.hideQuick();
      this.tray.setTrayVisible(false);
    }
    this.centralEnabled = false;
    this.showStatus("正在退出账号…", 0);
    this.jobs.cancelPending();
    this.jobs.submit(() => this.service.logout(), {
      onSuccess: () => this.accountSignedOut(),
      onError: (err) => this.accountChangeFailed(err),
    });
  }

  resumeAccountUi(): void {
    this.accountTransition = false;
    this.centralEnabled = true;
    if (this.tray !== null) {
      this.tray.setTrayVisible(settingsStore.getMinimizeToTray());
    }
    this.emitStateChanged();
  }

  accountChangeFailed(error: Error): void {
    this.resumeAccountUi();
    this._setRefreshBusy(false);
    this.pollInFlight = false;
    this.loadingScenes = false;
    this._pollTimer.start(POLL_INTERVAL_MS);
    this._metricsTimer.start(METRICS_INTERVAL_MS);
    this.updateVoiceFab();
    this.showStatus(`退出账号失败：${error.message}`, 5000);
  }

  accountSignedOut(): void {
    this.loggedOut = true;
    this.allDevices = [];
    this.bannedDids = banStore.load();
    this.knownPower = {};
    this.metrics = {};
    this.scenes = [];
    this.homes = [ALL_HOMES];
    this.currentHome = ALL_HOMES;
    this.currentRoom = ALL_ROOMS;
    this.homeButtonText = ALL_HOMES;
    this.pollInFlight = false;
    this.localizeBusy = false;
    this.loadingScenes = false;
    this.voiceDid = null;
    this._setRefreshBusy(false);
    this.rebuildTabs();
    this.rebuildGrid();
    this.updateCountLabel();
    if (this.tray !== null) {
      this.tray.retheme();
      this.tray.setDevices([], {});
    }
    this.footer.setLoggedIn(false);
    this.syncAccessUi();
    this.clearStatusHint();
    this.resumeAccountUi();
  }

  // ---------- 设备拉取与数据应用 ----------

  loadDevices(options: { fullPage?: boolean; manual?: boolean } = {}): void {
    const fullPage = options.fullPage ?? false;
    const manual = options.manual ?? false;
    if (!this.networkOnline) {
      this.syncAccessUi();
      return;
    }
    if (this.loggedOut) {
      this.loginAccount();
      return;
    }
    if (this.loadingDevices) {
      return;
    }
    this.beginLoading(fullPage, { showFooter: manual });
    this._setRefreshBusy(true);
    this.showStatus("正在获取设备列表…", 0);
    const generation = this.loadGeneration;
    const progress = (value: number, text: string): void => {
      this.onLoadingProgress(generation, value, text);
    };
    this.jobs.submit(() => this.service.listDevices(progress), {
      onSuccess: (result) => this.acceptDeviceList(generation, result),
      onError: (error) => this.acceptDeviceList(generation, null, error),
      priority: 0,
    });
  }

  onDevicesLoaded(devices: DeviceInfo[]): void {
    const showSummary = !(this.loadActive && this.loadFullPage);
    this.reconnecting = false;
    this.connectionFailed = false;
    if (this.networkOnline && !this.loggedOut) {
      if (!this.loadActive) {
        this._pollTimer.start(POLL_INTERVAL_MS);
        this._metricsTimer.start(METRICS_INTERVAL_MS);
      }
      this.service.setControlAccess();
    }
    // 对比要在替换前做：added/removed 以旧列表为基准
    const [added, removed] = this.diffDevices(devices);
    this.prepareLoadingStates();
    this.applyDevices(devices);
    this._cacheSaver(devices, this.knownPower, this.metrics);
    this._setRefreshBusy(false);
    this._statusTimer.stop();
    this.clearStatusHint();
    if (showSummary && (this.allDevices.length > 0 || added > 0 || removed > 0)) {
      this.showToast(refreshSummary(devices.length, added, removed));
    }
  }

  diffDevices(devices: DeviceInfo[]): [number, number] {
    const oldSet = new Set(this.allDevices.map((d) => d.did));
    const newSet = new Set(devices.map((d) => d.did));
    let added = 0;
    for (const id of newSet) {
      if (!oldSet.has(id)) {
        added += 1;
      }
    }
    let removed = 0;
    for (const id of oldSet) {
      if (!newSet.has(id)) {
        removed += 1;
      }
    }
    return [added, removed];
  }

  applyDevices(devices: DeviceInfo[]): void {
    prepareDeviceCards(devices);
    pruneTraySelection(devices);
    this.bannedDids = banStore.load();
    for (const device of devices) {
      if (!supportsCardPower(device) || !device.online) {
        this.knownPower[device.did] = null;
      }
    }
    this.allDevices = devices;
    const sortedHomes = [...new Set(devices.map((d) => d.home_name))].sort((a, b) => {
      const aUnknown = a === "未知" ? 1 : 0;
      const bUnknown = b === "未知" ? 1 : 0;
      if (aUnknown !== bUnknown) {
        return aUnknown - bUnknown;
      }
      return lexCompare(a, b);
    });
    this.homes = [ALL_HOMES, ...sortedHomes];
    if (!this.homes.includes(this.currentHome)) {
      this.currentHome = this.homes[0] ?? ALL_HOMES;
    }
    this.currentRoom = ALL_ROOMS;
    this.homeButtonText = this.currentHome;
    this.rebuildTabs();
    this.rebuildGrid();
    this.updateCountLabel();
    this.refreshPowerStates(false);
    // 先探测在线设备的开关能力，再对剩余无开关设备读取环境读数，
    // 避免冷刷新把每个开关/拆分子通道的无关属性都查一遍。
    if (!(this.loadActive && this.loadPending.has("power"))) {
      this.refreshMetrics();
    }
    this.updateVoiceFab();
    this.updateTrayDevices();
    this.loadCardIcons();
    this.syncAccessUi();
    // 场景入口开启时启动即预取场景列表，进场景页无需等待
    if (this.showSceneTab) {
      this.loadScenes();
    }
  }

  onLoadError(error: Error): void {
    this.finishLoading(false);
    this._setRefreshBusy(false);
    if (!this.networkOnline || this.reconnecting) {
      this.connectionFailed = true;
      this.syncAccessUi();
      return;
    }
    this.showStatus("加载失败", 4000);
    this._onCriticalError?.("加载失败", error.message);
    this.emit("criticalError", "加载失败", error.message);
  }

  // ---------- 设备图标与名称本地化 ----------

  loadCardIcons(): void {
    if (!this.networkOnline || this.loggedOut) {
      return;
    }
    const models = [...new Set(this.allDevices.map((d) => d.model).filter(Boolean))].sort(
      lexCompare,
    );
    if (models.length === 0) {
      return;
    }
    // One model per task lets a manual refresh run between network lookups.
    for (const model of models) {
      if (isExistingFile(iconStore.iconPath(model))) {
        continue;
      }
      this.jobs.submit(() => this.service.iconUrls([model]), {
        onSuccess: (urls) => this.onIconsReady(urls),
        priority: 20,
      });
    }
  }

  onIconsReady(urls: Record<string, string | null>): void {
    for (const [model, url] of Object.entries(urls)) {
      if (!url) {
        continue;
      }
      if (isExistingFile(iconStore.iconPath(model))) {
        continue;
      }
      this.jobs.submit(() => this.service.iconFile(model, url), {
        onSuccess: (filePath) => {
          if (filePath) {
            this.applyCardIcon(model, filePath);
          }
        },
        priority: 20,
      });
    }
  }

  applyCardIcon(model: string, filePath: string): void {
    if (!filePath) {
      return;
    }
    for (const card of this.cards.values()) {
      if (card.device.model === model) {
        card.setIcon(filePath);
      }
    }
  }

  maybeLocalizeNames(): void {
    if (this.allDevices.length === 0) {
      return;
    }
    let replacements: Record<string, string> = {};
    let asciiDevices: DeviceInfo[] = [];
    try {
      const namesNow: Record<string, string> = {};
      for (const d of this.allDevices) {
        namesNow[d.did] = d.name;
      }
      replacements = {
        ...this.service.localizedProductNames(Object.keys(namesNow), namesNow),
      };
      asciiDevices = this.allDevices.filter((d) => ASCII_RE.test(d.name) && Boolean(d.model));
      const models = [...new Set(asciiDevices.map((d) => d.model))].sort(lexCompare);
      if (models.length > 0) {
        const cachedNames = this.service.cachedProductPageNames(models);
        for (const [model, productName] of Object.entries(cachedNames)) {
          for (const d of asciiDevices) {
            if (d.model === model) {
              replacements[d.did] = productName;
            }
          }
        }
      }
    } catch (err) {
      console.warn("本地化设备名失败:", err);
      return;
    }

    if (Object.keys(replacements).length > 0) {
      if (this.applyDisplayNames(replacements)) {
        return;
      }
    }

    const pending = [
      ...new Set(
        asciiDevices
          .map((d) => d.model)
          .filter((model) => !this.service.hasProductPageName(model)),
      ),
    ].sort(lexCompare);

    if (pending.length > 0 && !this.localizeBusy) {
      this.localizeBusy = true;
      const remaining = new Set(pending);
      const completed = (model: string, error?: Error): void => {
        remaining.delete(model);
        if (error !== undefined) {
          console.warn("产品页名称查询失败:", error.message);
        }
        if (remaining.size === 0) {
          this.localizeBusy = false;
          this.maybeLocalizeNames();
        }
      };
      for (const model of pending) {
        this.jobs.submit(() => this.service.productPageName(model), {
          onSuccess: () => completed(model),
          onError: (err) => completed(model, err),
          priority: 20,
        });
      }
    }
  }

  applyDisplayNames(replacements: Record<string, string>): boolean {
    let changed = false;
    for (const d of this.allDevices) {
      const newName = replacements[d.did];
      if (newName && newName !== d.name) {
        d.name = newName;
        changed = true;
      }
    }
    if (!changed) {
      return false;
    }
    // 同型号多台替换后同名：追加 did 尾号区分（如 ·468）
    const byName = new Map<string, number>();
    for (const d of this.allDevices) {
      byName.set(d.name, (byName.get(d.name) ?? 0) + 1);
    }
    for (const d of this.allDevices) {
      if ((byName.get(d.name) ?? 0) > 1 && d.did in replacements) {
        d.name = `${d.name}·${d.did.slice(-3)}`;
      }
    }
    this.rebuildGrid();
    this.updateCountLabel();
    this.updateTrayDevices();
    return true;
  }

  // ---------- 开关轮询与环境读数 ----------

  onPollTick(): void {
    if (this.pollInFlight || this.allDevices.length === 0) {
      return;
    }
    this.refreshPowerStates(true);
  }

  refreshPowerStates(force: boolean): void {
    if (!this.networkOnline || this.loggedOut) {
      return;
    }
    if (this.currentRoom === BANNED_TAB) {
      if (this.loadActive) {
        this.loadTaskDone("power");
      }
      return;
    }
    const visible = this.visibleDevices();
    const onlineSet = new Set(this.activeDevices().filter((d) => d.online).map((d) => d.did));
    const didSet = new Set<string>();
    for (const d of visible) {
      if (d.online) {
        didSet.add(d.did);
      }
    }
    for (const d of visible) {
      if (d.online) {
        for (const child of d.switch_channels) {
          if (onlineSet.has(child)) {
            didSet.add(child);
          }
        }
      }
    }
    let dids = [...didSet];
    if (dids.length === 0) {
      if (this.loadActive) {
        this.loadTaskDone("power");
      }
      return;
    }
    if (!force && !this.loadActive) {
      dids = dids.filter((d) => this.knownPower[d] === undefined || this.knownPower[d] === null);
      if (dids.length === 0) {
        return;
      }
    }
    this.pollInFlight = true;
    const generation = this.loadGeneration;
    this.jobs.submit(() => this.service.powerStates(dids), {
      onSuccess: (states) => this.applyPowerStates(states, generation),
      onError: (error) => this.onPollError(error, generation),
      priority: this.loadActive ? 1 : 10,
    });
  }

  onPollError(error: Error, loadTicket?: number | null): void {
    this.pollInFlight = false;
    console.warn("轮询设备开关状态失败:", error.message);
    this.loadTaskDone("power", { generation: loadTicket ?? null, failed: true });
    if (this.loadActive && loadTicket === this.loadGeneration) {
      this.refreshMetrics();
    }
  }

  applyPowerStates(states: Record<string, boolean | null>, loadTicket?: number | null): void {
    this.pollInFlight = false;
    for (const [did, state] of Object.entries(states)) {
      this.applyPowerState(did, state);
    }
    this.maybeLocalizeNames();
    this.updateTrayDevices();
    this.loadTaskDone("power", { generation: loadTicket ?? null });
    if (this.loadActive && loadTicket === this.loadGeneration) {
      this.refreshMetrics();
    }
  }

  applyPowerState(did: string, state: boolean | null): void {
    // 离线设备的开关值不落记忆，避免云端缓存的旧值覆盖灰置状态
    const dev = this.allDevices.find((d) => d.did === did);
    if (dev !== undefined && !dev.online) {
      this.knownPower[did] = null;
      return;
    }
    this.knownPower[did] = state;
    const card = this.cards.get(did);
    if (card !== undefined && state !== null) {
      card.setPowerState(state);
    }
    this.updatePanelCards();
  }

  updatePanelCards(): void {
    for (const device of this.allDevices) {
      const card = this.cards.get(device.did);
      if (device.switch_channels.length > 0 && card !== undefined) {
        card.setPanelStates(this.knownPower);
      }
    }
  }

  refreshMetrics(): void {
    if (!this.networkOnline || this.loggedOut) {
      return;
    }
    if (this.currentRoom === BANNED_TAB) {
      this.loadTaskDone("metrics");
      return;
    }
    const dids = this.visibleDevices()
      .filter(
        (d) => d.online && (this.knownPower[d.did] === undefined || this.knownPower[d.did] === null),
      )
      .map((d) => d.did);
    if (dids.length === 0) {
      this.loadTaskDone("metrics");
      return;
    }
    const generation = this.loadGeneration;
    this.jobs.submit(() => this.service.readMetrics(dids), {
      onSuccess: (metrics) => this.applyMetrics(metrics, generation),
      onError: (error) => this.onMetricsError(error, generation),
      priority: this.loadActive ? 1 : 10,
    });
  }

  applyMetrics(metrics: Record<string, string | null>, loadTicket?: number | null): void {
    let dirty = false;
    for (const [did, text] of Object.entries(metrics)) {
      if (text) {
        if (this.metrics[did] !== text) {
          dirty = true;
        }
        this.metrics[did] = text;
      } else if (did in this.metrics) {
        delete this.metrics[did];
        dirty = true;
      }
      const card = this.cards.get(did);
      if (card !== undefined) {
        card.setMetrics(text);
      }
    }
    if (dirty && this.allDevices.length > 0) {
      this._cacheSaver(this.allDevices, this.knownPower, this.metrics);
    }
    this.maybeLocalizeNames();
    this.pushTrayMetrics();
    this.loadTaskDone("metrics", { generation: loadTicket ?? null });
  }

  onMetricsError(error: Error, generation?: number | null): void {
    console.warn("拉取温湿度读数失败:", error.message);
    this.loadTaskDone("metrics", { generation: generation ?? null, failed: true });
  }

  pushTrayMetrics(): void {
    if (this.tray !== null) {
      try {
        this.tray.setMetrics(this.metrics);
      } catch {
        // 托盘行可能在重建间隙销毁，同步失败可安全忽略
      }
    }
  }

  updateTrayDevices(): void {
    if (this.tray !== null) {
      this.tray.setDevices(this.displayedDevices(), this.knownPower);
    }
  }

  // ---------- 家庭、房间、屏蔽（Ban）与过滤 ----------

  deviceHasFunctions(device: DeviceInfo): boolean {
    const state = this.service.specHasPublishedFunctions(device.spec_type);
    return state !== false;
  }

  isDeviceBanned(did: string): boolean {
    return this.bannedDids.includes(did);
  }

  bannedDeviceIds(): string[] {
    return [...this.bannedDids];
  }

  activeDevices(): DeviceInfo[] {
    if (this.bannedDids.length === 0) {
      return this.allDevices;
    }
    const bannedSet = new Set(this.bannedDids);
    return this.allDevices.filter((d) => !bannedSet.has(d.did));
  }

  bannedDevices(): DeviceInfo[] {
    if (this.bannedDids.length === 0) {
      return [];
    }
    const bannedSet = new Set(this.bannedDids);
    return this.allDevices.filter((d) => bannedSet.has(d.did));
  }

  bannedDevicesInCurrentHome(): DeviceInfo[] {
    return this.bannedDevices().filter(
      (d) => this.currentHome === ALL_HOMES || d.home_name === this.currentHome,
    );
  }

  displayedDevices(): DeviceInfo[] {
    const active = this.activeDevices();
    if (!this.hideNoFunc) {
      return active;
    }
    return active.filter((d) => this.deviceHasFunctions(d));
  }

  visibleDevices(): DeviceInfo[] {
    if (this.currentRoom === SCENE_TAB) {
      return [];
    }
    if (this.currentRoom === BANNED_TAB) {
      return this.bannedDevicesInCurrentHome();
    }
    return this.displayedDevices().filter(
      (d) =>
        (this.currentHome === ALL_HOMES || d.home_name === this.currentHome) &&
        (this.currentRoom === ALL_ROOMS || d.room_name === this.currentRoom),
    );
  }

  buildHomeMenu(): HomeMenuOption[] {
    return this.homes.map((home) => ({
      name: home,
      selected: home === this.currentHome,
      trigger: () => this.selectHome(home),
    }));
  }

  selectHome(home: string): void {
    if (home === this.currentHome) {
      return;
    }
    this.currentHome = home;
    this.currentRoom = ALL_ROOMS;
    // 场景列表随家庭范围过滤，切家庭后旧缓存失效
    this.scenes = null;
    this.homeButtonText = home;
    this.rebuildTabs();
    this.rebuildGrid();
    this.updateCountLabel();
    this.refreshPowerStates(false);
    this.refreshMetrics();
    this.emitStateChanged();
  }

  rebuildTabs(): void {
    const roomSet = new Set<string>();
    for (const d of this.activeDevices()) {
      if (
        (this.currentHome === ALL_HOMES || d.home_name === this.currentHome) &&
        d.room_name &&
        d.room_name !== "未知"
      ) {
        roomSet.add(d.room_name);
      }
    }
    const sortedRooms = [...roomSet].sort(lexCompare);
    this.tabNames = [
      ...(this.showSceneTab ? [SCENE_TAB] : []),
      ALL_ROOMS,
      ...sortedRooms,
      BANNED_TAB,
    ];
    if (!this.tabNames.includes(this.currentRoom)) {
      this.currentRoom = ALL_ROOMS;
    }
    this.roomStrip.refresh();
  }

  selectRoom(room: string): void {
    this.currentRoom = room;
    this.rebuildGrid();
    if (room === SCENE_TAB) {
      if (this.scenes === null) {
        this.showStatus("正在加载场景…");
      }
      this.loadScenes();
      this.updateCountLabel();
      this.emitStateChanged();
      return;
    }
    if (room === BANNED_TAB) {
      this.updateCountLabel();
      this.emitStateChanged();
      return;
    }
    this.refreshPowerStates(false);
    this.updateCountLabel();
    this.emitStateChanged();
  }

  buildRoomMenu(): RoomMenuModel {
    const inHome = this.displayedDevices().filter(
      (d) => this.currentHome === ALL_HOMES || d.home_name === this.currentHome,
    );
    const bannedInHome = this.bannedDevicesInCurrentHome();
    const entries: Array<[string, number | null]> = this.tabNames.map((room) => {
      if (room === SCENE_TAB) {
        return [room, null];
      }
      if (room === BANNED_TAB) {
        return [room, bannedInHome.length];
      }
      if (room === ALL_ROOMS) {
        return [room, inHome.length];
      }
      return [room, inHome.filter((d) => d.room_name === room).length];
    });
    return buildRoomMenuEntries(entries, this.currentRoom, (room) => this.selectRoom(room));
  }

  updateCountLabel(): void {
    if (this.currentRoom === SCENE_TAB) {
      const count = (this.scenes ?? []).length;
      this.countLabelText = `共 ${count} 个场景`;
      this.summaryOnlineVisible = false;
      return;
    }
    if (this.currentRoom === BANNED_TAB) {
      const banned = this.bannedDevicesInCurrentHome();
      const online = banned.filter((d) => d.online).length;
      this.countLabelText = `已屏蔽 ${banned.length} 台设备`;
      this.onlineLabelText = `${online} 台设备在线`;
      this.summaryOnlineVisible = banned.length > 0;
      return;
    }
    const vis = this.visibleDevices();
    const subset =
      this.currentHome === ALL_HOMES ? vis : vis.filter((d) => d.home_name === this.currentHome);
    const total = subset.length;
    const online = subset.filter((d) => d.online).length;
    this.countLabelText = `共 ${total} 台设备`;
    this.onlineLabelText = `${online} 台设备在线`;
    this.summaryOnlineVisible = true;
  }

  // ---------- 卡片网格 ----------

  rebuildGrid(): void {
    if (!this.visible) {
      this.gridDirty = true;
      this.gridColumns = 0;
      return;
    }
    this.gridDirty = false;
    for (const card of this.cards.values()) {
      card.dispose();
    }
    this.cards.clear();
    for (const card of this.sceneCards.values()) {
      card.dispose();
    }
    this.sceneCards.clear();
    this.sceneEmptyHint = "";

    if (this.currentRoom === SCENE_TAB) {
      this._rebuildSceneGrid();
      this.emitStateChanged();
      return;
    }

    const visible = [...this.visibleDevices()].sort((a, b) => {
      const onlineDiff = (a.online ? 0 : 1) - (b.online ? 0 : 1);
      return onlineDiff !== 0 ? onlineDiff : lexCompare(a.name, b.name);
    });
    const cols = columnsForWidth(this.viewportWidth, GRID_SPACING);
    this.gridColumns = cols;

    visible.forEach((device, index) => {
      const card = new DeviceCardController(device);
      card.setPanelStates(this.knownPower);
      card.setFixedWidth(gridCardWidth(this.viewportWidth, cols, index % cols, GRID_SPACING));
      const known = this.knownPower[device.did];
      if (known !== undefined && known !== null) {
        card.setPowerState(known);
      }
      if (device.did in this.metrics) {
        card.setMetrics(this.metrics[device.did] ?? null);
      }
      const iconFile = iconStore.iconPath(device.model);
      if (isExistingFile(iconFile)) {
        card.setIcon(iconFile);
      }
      card.on("powerClicked", (did) => this.onPowerClicked(did));
      card.on("openRequested", (did) => this.openDevice(did));
      card.on("trayMenuRequested", (did, pos) => this.emit("deviceTrayMenuRequested", did, pos));
      this.cards.set(device.did, card);
    });
    this.emitStateChanged();
  }

  private _rebuildSceneGrid(): void {
    const scenes = [...(this.scenes ?? [])].sort((a, b) => lexCompare(a.name, b.name));
    if (scenes.length === 0) {
      this.sceneEmptyHint = "暂无场景，可在米家 APP「智能」中添加";
      return;
    }
    const cols = columnsForWidth(this.viewportWidth, GRID_SPACING);
    this.gridColumns = cols;
    scenes.forEach((scene, index) => {
      const card = new SceneCardController(scene);
      card.setFixedWidth(gridCardWidth(this.viewportWidth, cols, index % cols, GRID_SPACING));
      card.on("executed", (sceneId) => this.onSceneExecuted(sceneId));
      this.sceneCards.set(scene.scene_id, card);
    });
  }

  setViewportWidth(width: number): void {
    this.viewportWidth = Math.max(0, Math.trunc(width));
    if (this.visible) {
      this._resizeTimer.start(RESIZE_DEBOUNCE_MS);
    }
  }

  onResizeSettled(): void {
    const activeCards = this.currentRoom === SCENE_TAB ? this.sceneCards : this.cards;
    if (activeCards.size === 0) {
      return;
    }
    const nextCols = columnsForWidth(this.viewportWidth, GRID_SPACING);
    if (nextCols !== this.gridColumns) {
      this.rebuildGrid();
      return;
    }
    let index = 0;
    for (const card of activeCards.values()) {
      const width = gridCardWidth(this.viewportWidth, this.gridColumns, index % this.gridColumns, GRID_SPACING);
      if (card.width !== width) {
        card.setFixedWidth(width);
      }
      index += 1;
    }
    this.emitStateChanged();
  }

  // ---------- 快速开关 ----------

  onPowerClicked(did: string): void {
    if (this.isDeviceBanned(did)) {
      return;
    }
    const card = this.cards.get(did);
    if (!card) {
      return;
    }
    card.setBusy(true);
    this.jobs.submit(() => this.service.togglePower(did), {
      onSuccess: (newState) => this.onPowerDone(card, did, newState),
      onError: (err) => this.onPowerFailed(card, err),
    });
  }

  onPowerDone(card: DeviceCardController, did: string, newState: boolean): void {
    if (card.disposed) {
      return;
    }
    card.setBusy(false);
    card.setPowerState(newState);
    this.knownPower[did] = newState;
    this.updatePanelCards();
    this.updateTrayDevices();
    this.showToast(`已${newState ? "打开" : "关闭"}「${card.device.name}」`, 2500);
  }

  onPowerFailed(card: DeviceCardController, error: Error): void {
    if (card.disposed) {
      return;
    }
    card.setBusy(false);
    this._onWarning?.("操作失败", error.message);
    this.emit("warning", "操作失败", error.message);
  }

  // ---------- 场景（手动控制） ----------

  loadScenes(): void {
    if (!this.networkOnline || this.loggedOut || this.loadingScenes) {
      return;
    }
    this.loadingScenes = true;
    const homeScope = this.currentHome === ALL_HOMES ? null : this.currentHome;
    this.jobs.submit(() => this.service.sceneList(homeScope), {
      onSuccess: (scenes) => this.onScenesLoaded(scenes),
      onError: (error) => this.onScenesFailed(error),
    });
  }

  onScenesLoaded(scenes: SceneInfo[]): void {
    this.loadingScenes = false;
    this.scenes = scenes;
    if (this.currentRoom === SCENE_TAB) {
      this.rebuildGrid();
      this.updateCountLabel();
    }
  }

  onScenesFailed(error: Error): void {
    this.loadingScenes = false;
    console.warn("加载场景失败:", error.message);
    if (this.currentRoom !== SCENE_TAB) {
      return;
    }
    if (this.scenes === null) {
      this.showStatus("场景加载失败", 4000);
    } else {
      this.showToast(`场景刷新失败：${error.message}`, 4000);
    }
  }

  onSceneExecuted(sceneId: string): void {
    const scene = (this.scenes ?? []).find((s) => s.scene_id === sceneId);
    const card = this.sceneCards.get(sceneId);
    if (!scene || !card) {
      return;
    }
    card.setBusy(true);
    this.jobs.submit(() => this.service.runScene(scene), {
      onSuccess: () => {
        if (card.disposed) return;
        card.setBusy(false);
        this.showToast(`已执行场景「${scene.name}」`, 2500);
      },
      onError: (err) => {
        if (card.disposed) return;
        card.setBusy(false);
        this.showToast(`执行场景「${scene.name}」失败：${err.message}`, 4000);
      },
    });
  }

  // ---------- 设备详情（仅可调灯光与摄像头，无通用属性编辑器） ----------

  openDevice(did: string): void {
    if (this.isDeviceBanned(did)) {
      return;
    }
    const device = this.allDevices.find((d) => d.did === did);
    if (!device || !hasDeviceDetails(device) || !device.online) {
      return;
    }
    if (isLight(device)) {
      this.openLightWindow(device);
      return;
    }
    if (device.model.includes(".camera.") || isCamera(device)) {
      this.openCameraWindow(device);
    }
  }

  openLightWindow(device: DeviceInfo): LightControlController | null {
    if (!hasDeviceDetails(device) || this.accessState() !== "ready") {
      return null;
    }
    const current = this.lightWindows.get(device.did);
    if (current !== undefined && current.alive()) {
      current.show();
      return current;
    }
    const dialog = new LightControlController(this.service, this.jobs, device, {
      parentRect: this.windowGeometry,
    });
    this.lightWindows.set(device.did, dialog);
    dialog.events.on("powerChanged", (state) => {
      this.applyPowerState(device.did, state);
      this.updateTrayDevices();
    });
    dialog.events.on("diagnosticsRequested", (dev) => {
      this.showDeviceDiagnostics([dev]);
    });
    dialog.events.on("finished", () => {
      this.lightWindows.delete(device.did);
      this.refreshClosedDetail(device.did);
    });
    dialog.showCentered(this.windowGeometry);
    dialog.load();
    return dialog;
  }

  openCameraWindow(device: DeviceInfo): CameraWindowController {
    const current = this.cameraWindows.get(device.did);
    if (current !== undefined && !current.closed) {
      if (current.minimized) {
        current.showNormal();
      }
      current.show();
      return current;
    }
    const dialog = new CameraWindowController(this.service, this.jobs, device);
    this.cameraWindows.set(device.did, dialog);
    dialog.on("closed", () => {
      this.cameraWindows.delete(device.did);
      this.refreshClosedDetail(device.did);
    });
    dialog.load();
    dialog.show();
    return dialog;
  }

  refreshClosedDetail(did: string): void {
    if (this.cards.has(did)) {
      this.jobs.submit(() => this.service.powerState(did), {
        onSuccess: (state) => this.applyPowerState(did, state),
        onError: (exc) => {
          console.warn("详情关闭后回读开关失败:", exc.message);
        },
      });
    }
  }

  // ---------- 托盘成员与屏蔽右键菜单、管理对话框、设置、诊断与关于 ----------

  buildDeviceBanMenu(did: string): DeviceBanMenuAction | null {
    const device = this.allDevices.find((d) => d.did === did);
    if (!device) {
      return null;
    }
    const banned = this.isDeviceBanned(did);
    return {
      label: banned ? "取消屏蔽" : "屏蔽设备",
      banned,
      trigger: () => {
        this.setDeviceBanned(did, !banned);
      },
    };
  }

  setDeviceBanned(did: string, banned: boolean): boolean {
    const id = String(did ?? "").trim();
    if (!id) {
      return false;
    }
    const device = this.allDevices.find((d) => d.did === id);
    if (!device && banned) {
      return false;
    }
    const alreadyBanned = this.isDeviceBanned(id);
    this.bannedDids = banStore.setBanned(id, banned);
    if (!device && !alreadyBanned) {
      return false;
    }
    if (alreadyBanned === banned) {
      return true;
    }

    if (banned) {
      const lightWin = this.lightWindows.get(id);
      if (lightWin !== undefined && lightWin.alive()) {
        lightWin.reject();
      }
      const camWin = this.cameraWindows.get(id);
      if (camWin !== undefined && !camWin.closed) {
        camWin.close();
      }
    }

    this.rebuildTabs();
    this.rebuildGrid();
    this.updateCountLabel();
    this.updateTrayDevices();
    this.updateVoiceFab();
    if (this.tray !== null) {
      this.tray.refreshSpeaker();
    }
    this.syncAccessUi();
    if (!banned) {
      this.refreshPowerStates(false);
      this.refreshMetrics();
    }
    const label = device ? `「${device.name}」` : id;
    this.showToast(
      banned ? `已屏蔽${label}，已移至「${BANNED_TAB}」栏` : `已取消屏蔽${label}，已恢复至控制列表`,
      2200,
    );
    this.emitStateChanged();
    return true;
  }

  buildDeviceTrayMenu(did: string): DeviceTrayMenuAction | null {
    const device = this.allDevices.find((d) => d.did === did);
    if (!device || this.isDeviceBanned(did) || !trayEligible(device)) {
      return null;
    }
    const selected = trayStore.contains(did);
    return {
      label: selected ? "从托盘窗口移除" : "添加到托盘窗口",
      selected,
      trigger: () => this.setDeviceTrayMembership(did, !selected),
    };
  }

  setDeviceTrayMembership(did: string, selected: boolean): void {
    const device = this.allDevices.find((d) => d.did === did);
    if (!device || (selected && this.isDeviceBanned(did)) || !trayEligible(device)) {
      return;
    }
    trayStore.setDeviceSelected(did, selected);
    this.updateTrayDevices();
    this.showToast(selected ? "已添加到托盘窗口" : "已从托盘窗口移除", 1600);
  }

  removeTrayItem(kind: "device" | "scene", itemId: string): void {
    if (kind !== "device" && kind !== "scene") {
      return;
    }
    trayStore.removeItem(kind, itemId);
    this.updateTrayDevices();
  }

  showTrayManager(): TrayManagerController | null {
    if (this.allDevices.length === 0) {
      this.showToast("请先刷新获取设备列表", 2500);
      return null;
    }
    if (this.tray !== null) {
      this.tray.hideQuick();
    }
    const cached = this.currentHome === ALL_HOMES ? this.scenes : null;
    const dlg = new TrayManagerController(this.displayedDevices(), {
      scenes: cached,
      sceneLoader: this.showSceneTab ? () => this.service.sceneList(null) : null,
      jobs: this.jobs,
    });
    dlg.events.on("accepted", () => {
      const order = dlg.selectedOrder();
      const sceneById = new Map(dlg.selectedSceneData().map((s) => [s.scene_id, s]));
      const dids = order.filter((it) => it.type === "device").map((it) => it.id);
      const scenes = order
        .filter((it) => it.type === "scene" && sceneById.has(it.id))
        .map((it) => sceneById.get(it.id)!);
      trayStore.save(dids);
      trayStore.saveScenes(scenes);
      trayStore.saveOrder(order);
      this.updateTrayDevices();
      this.showToast("托盘项目已更新", 2000);
    });
    this._onShowTrayManager?.(dlg);
    this.emit("trayManagerOpened", dlg);
    return dlg;
  }

  showSettings(): SettingsDialogController {
    if (this.settingsDialog !== null && !this.settingsDialog.closed) {
      return this.settingsDialog;
    }
    const dlg = new SettingsDialogController({ devices: this.allDevices, host: this });
    this.settingsDialog = dlg;
    const syncAfterClose = (scaleChanged: boolean): void => {
      if (this.settingsDialog === dlg) {
        this.settingsDialog = null;
      }
      if (scaleChanged) {
        this.emit("restartRecommended");
      }
      if (this.tray !== null) {
        this.tray.setTrayVisible(settingsStore.getMinimizeToTray());
      }
      const newHide = settingsStore.getHideNoFuncDevices();
      if (newHide !== this.hideNoFunc) {
        this.hideNoFunc = newHide;
        this.rebuildTabs();
        this.rebuildGrid();
        this.updateCountLabel();
        this.updateTrayDevices();
      }
      const newShow = settingsStore.getShowSceneTab();
      if (newShow !== this.showSceneTab) {
        this.showSceneTab = newShow;
        if (!newShow && this.currentRoom === SCENE_TAB) {
          this.currentRoom = ALL_ROOMS;
        }
        this.rebuildTabs();
        this.rebuildGrid();
        this.updateCountLabel();
      }
      this.updateVoiceFab();
      if (this.tray !== null) {
        this.tray.refreshSpeaker();
      }
    };
    dlg.on("saved", ({ scaleChanged }) => syncAfterClose(scaleChanged));
    dlg.on("cancelled", () => syncAfterClose(false));
    this._onShowSettings?.(dlg);
    this.emit("settingsOpened", dlg);
    return dlg;
  }

  showDeviceDiagnostics(devices?: readonly DeviceInfo[]): DiagnosticDialogController {
    const dlg = new DiagnosticDialogController(
      this.service,
      this.jobs,
      devices ?? this.allDevices,
    );
    this._onShowDiagnostics?.(dlg);
    this.emit("diagnosticsOpened", dlg);
    return dlg;
  }

  showAbout(): void {
    const version = this.service.apiVersion();
    this._onShowAbout?.(version);
    this.emit("aboutOpened", version);
  }

  // ---------- 小爱语音悬浮球与指令 ----------

  updateVoiceFab(): void {
    if (this.loggedOut || !this.networkOnline || (this.loadActive && this.loadFullPage)) {
      this.voiceDid = null;
      this.voiceFab.collapse();
      this.voiceFab.setVisible(false);
      return;
    }
    const active = this.activeDevices();
    const pref = settingsStore.getDefaultSpeakerDid();
    let speaker =
      active.find((d) => d.did === pref && isSpeaker(d) && d.online) ?? null;
    if (speaker === null) {
      speaker = active.find((d) => isSpeaker(d) && d.online) ?? null;
    }
    this.voiceDid = speaker ? speaker.did : null;
    const show = settingsStore.getVoiceFabEnabled() && speaker !== null;
    this.voiceFab.setVisible(show);
    if (!show) {
      this.voiceFab.collapse();
    }
  }

  onVoiceCommand(text: string): void {
    const did = this.voiceDid;
    if (did === null) {
      return;
    }
    // 设置的默认音箱离线/不在列表 → 已回退：提示里说明并把偏好重置为自动
    const pref = settingsStore.getDefaultSpeakerDid();
    let fallbackNote = "";
    if (pref && pref !== did) {
      fallbackNote = "（首选音箱离线，已由当前在线音箱代答）";
      settingsStore.setDefaultSpeakerDid("");
    }
    this.jobs.submit(() => this.service.runAction(did, "execute-text-directive", [text]), {
      onSuccess: () => {
        if (this.tray !== null) {
          this.tray.refreshAudioAfterCommand(did);
        }
        this.showToast(`已告诉小爱同学：${text}${fallbackNote}`, 3000);
      },
      onError: (err) => {
        this.showToast(`执行失败：${err.message}`, 4000);
      },
    });
  }

  // ---------- 窗口状态、命中测试与退出 ----------

  devices(): DeviceInfo[] {
    return this.allDevices;
  }

  requestForceQuit(): void {
    this.forceQuit = true;
  }

  isVisible(): boolean {
    return this.visible;
  }

  isHidden(): boolean {
    return !this.visible;
  }

  isMinimized(): boolean {
    return this.minimized;
  }

  isMaximized(): boolean {
    return this.maximized;
  }

  show(): void {
    this.visible = true;
    this.minimized = false;
    if (this._autoStartTimers || this._hasCustomTimers) {
      void this.networkMonitor.checkNow();
    }
    if (!this.defaultSizeApplied) {
      this.defaultSizeApplied = true;
    }
    if (this.gridDirty) {
      this.rebuildGrid();
    }
    this.emitStateChanged();
  }

  hide(): void {
    this.visible = false;
    this.emitStateChanged();
  }

  showMinimized(): void {
    this.minimized = true;
    this.emitStateChanged();
  }

  showMaximized(): void {
    this.maximized = true;
    this.minimized = false;
    this.visible = true;
    this.maxButtonGlyph = "\uE923";
    this.emitStateChanged();
  }

  showNormal(): void {
    this.maximized = false;
    this.minimized = false;
    this.visible = true;
    this.maxButtonGlyph = "\uE922";
    if (this.gridDirty) {
      this.rebuildGrid();
    }
    this.emitStateChanged();
  }

  toggleMaximized(): void {
    if (this.maximized) {
      this.showNormal();
    } else {
      this.showMaximized();
    }
  }

  raise(): void {
    this.emit("raised");
  }

  activateWindow(): void {
    this.emit("activated");
  }

  resize(width: number, height: number): void {
    const w = Math.max(MIN_WINDOW_WIDTH, Math.trunc(width));
    const h = Math.max(MIN_WINDOW_HEIGHT, Math.trunc(height));
    this.windowGeometry = { ...this.windowGeometry, width: w, height: h };
    this.viewportWidth = Math.max(0, w - 58);
    this.voiceFab.reposition({ width: w, height: h });
    this._resizeTimer.start(RESIZE_DEBOUNCE_MS);
    this.emitStateChanged();
  }

  hitTestLogical(cx: number, cy: number, overTitleButton = false): number {
    if (!this.maximized) {
      const m = RESIZE_MARGIN;
      const onLeft = cx <= m;
      const onRight = cx >= this.windowGeometry.width - m;
      const onTop = cy <= m;
      const onBottom = cy >= this.windowGeometry.height - m;
      if (onTop && onLeft) return HTTOPLEFT;
      if (onTop && onRight) return HTTOPRIGHT;
      if (onBottom && onLeft) return HTBOTTOMLEFT;
      if (onBottom && onRight) return HTBOTTOMRIGHT;
      if (onLeft) return HTLEFT;
      if (onRight) return HTRIGHT;
      if (onTop) return HTTOP;
      if (onBottom) return HTBOTTOM;
    }
    if (cy <= BRAND_CAPTION_HEIGHT && !overTitleButton) {
      return HTCAPTION;
    }
    return HTCLIENT;
  }

  handleNativeEvent(
    msg: NativeWindowMessage,
    hitTest: (lParam: number) => number,
  ): [boolean, number] {
    return handleNativeWindowEvent(msg, {
      hitTest,
      toggleMaximized: () => this.toggleMaximized(),
    });
  }

  close(): boolean {
    if (settingsStore.getMinimizeToTray() && !this.forceQuit && this.tray !== null) {
      try {
        this.tray.setTrayVisible(true);
      } catch {
        // ignore tray visibility errors
      }
      this.hide();
      trimWorkingSet();
      return false;
    }

    // 真正退出：保存缓存、收起托盘、清理子窗与定时器
    if (this.allDevices.length > 0) {
      this._cacheSaver(this.allDevices, this.knownPower, this.metrics);
    }
    if (this.tray !== null) {
      try {
        this.tray.hideQuick();
        this.tray.setTrayVisible(false);
      } catch {
        // ignore tray cleanup errors
      }
    }
    this._stopAllTimers();
    for (const dialog of [...this.lightWindows.values()]) {
      if (dialog.alive()) {
        dialog.reject();
      }
    }
    for (const win of [...this.cameraWindows.values()]) {
      win.close();
    }
    void this.jobs.shutdown();
    this.visible = false;
    this._onAppQuit?.();
    this.emit("closed");
    return true;
  }

  dispose(): void {
    this._stopAllTimers();
    for (const unsub of this._unsubscribers) {
      unsub();
    }
    this._unsubscribers.length = 0;
    for (const card of this.cards.values()) {
      card.dispose();
    }
    this.cards.clear();
    for (const card of this.sceneCards.values()) {
      card.dispose();
    }
    this.sceneCards.clear();
    for (const dialog of [...this.lightWindows.values()]) {
      if (dialog.alive()) {
        dialog.reject();
      }
    }
    this.lightWindows.clear();
    for (const win of [...this.cameraWindows.values()]) {
      win.close();
    }
    this.cameraWindows.clear();
    this.voiceFab.dispose();
    this.toast.dismiss();
    if (this._ownsNetworkMonitor) {
      this.networkMonitor.stop();
    }
    if (this.tray !== null) {
      this.tray.dispose();
    }
    this.clear();
  }

  // ---------- 内部辅助 ----------

  private _setRefreshBusy(busy: boolean): void {
    this.loadingDevices = busy;
    this.refreshButtonEnabled = !busy;
    this.refreshButtonAccessibleName = busy ? "正在刷新…" : "刷新设备";
    this.refreshSpinning = busy;
  }

  private _stopAllTimers(): void {
    this._resizeTimer.stop();
    this._pollTimer.stop();
    this._metricsTimer.stop();
    this._statusTimer.stop();
    this._loadWatchdog.stop();
    this._updateCheckTimer.stop();
  }

  private emitStateChanged(): void {
    this.emit("stateChanged");
  }
}
