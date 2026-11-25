// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * 设置对话框控制器：管理「主题界面 / 应用功能」双页状态、即时主题预览、
 * 取消回滚、界面缩放无级解析、设备依赖置灰规则及全量落盘提交。
 * 精确 1:1 移植自 app/ui/settings_dialog.py。
 */

import { TypedEmitter } from "../../core/contracts.ts";
import { SCENES_FEATURE_ENABLED } from "../../core/featureFlags.ts";
import { type DeviceInfo, isSpeaker } from "../../core/models.ts";
import {
  UI_SCALES,
  UI_SCALE_MAX,
  UI_SCALE_MIN,
  autostartSupported,
  getAutostart,
  getCheckUpdateEnabled,
  getCustomThemeColor,
  getDefaultSpeakerDid,
  getHideNoFuncDevices,
  getMinimizeToTray,
  getShowSceneTab,
  getStartMinimized,
  getThemeColor,
  getThemeMode,
  getUiScale,
  getVoiceFabEnabled,
  normalizeThemeColor,
  setAutostart,
  setCheckUpdateEnabled,
  setCustomThemeColor,
  setDefaultSpeakerDid,
  setHideNoFuncDevices,
  setMinimizeToTray,
  setShowSceneTab,
  setStartMinimized,
  setThemeColor,
  setThemeMode,
  setUiScale,
  setVoiceFabEnabled,
} from "../../core/settingsStore.ts";
import { THEME_COLORS, type ThemeMode } from "../theme.ts";

export { THEME_COLORS };

export type SettingsTab = "appearance" | "features";

export const SETTINGS_TABS: ReadonlyArray<{ id: SettingsTab; title: string }> = [
  { id: "appearance", title: "主题界面" },
  { id: "features", title: "应用功能" },
];

export const THEME_MODE_LABELS: Record<ThemeMode, string> = {
  system: "跟随系统",
  light: "浅色模式",
  dark: "深色模式",
};

export const THEME_LABEL_TO_MODE: Record<string, ThemeMode> = {
  跟随系统: "system",
  浅色模式: "light",
  深色模式: "dark",
};

export interface SettingsThemeHost {
  applyThemeMode?: (mode: string) => void;
  applyThemeColor?: (color: string) => void;
}

export interface SettingsSpeakerOption {
  did: string;
  label: string;
}

export interface SettingsDialogOptions {
  devices?: readonly DeviceInfo[];
  host?: SettingsThemeHost | null;
}

export interface SettingsDialogState {
  currentTab: SettingsTab;
  themeMode: ThemeMode;
  themeModeLabel: string;
  themeColor: string;
  customThemeColor: string;
  customColorInput: string;
  customColorValid: boolean;
  customSwatchColor: string;
  customColorTooltip: string;
  uiScale: number;
  scaleText: string;
  scaleOptions: string[];
  scaleChanged: boolean;
  hasSpeaker: boolean;
  voiceFabEnabled: boolean;
  voiceFabInteractive: boolean;
  showSceneTab: boolean;
  autostartSupported: boolean;
  autostart: boolean;
  autostartDescription: string;
  speakerOptions: SettingsSpeakerOption[];
  defaultSpeakerDid: string;
  speakerSelectable: boolean;
  minimizeToTray: boolean;
  startMinimized: boolean;
  startMinimizedEnabled: boolean;
  hideNoFuncDevices: boolean;
  checkUpdateEnabled: boolean;
  accepted: boolean;
  closed: boolean;
}

export type SettingsDialogEvents = {
  changed: [SettingsDialogState];
  saved: [{ scaleChanged: boolean }];
  cancelled: [];
};

/**
 * 缩放值（小数）→ 百分比显示文本，保留小数并去尾零（1.375 -> "137.5%"，1.0 -> "100%"）。
 */
export function formatScalePercent(value: number): string {
  const pct = Number((value * 100).toPrecision(6));
  return `${pct}%`;
}

/**
 * 解析缩放百分比输入文本（如 "137.5%" 或 "137.5"），并钳制在 [UI_SCALE_MIN, UI_SCALE_MAX]。
 * 非法或空字符串返回 null。
 */
export function parseScaleText(rawText: string): number | null {
  const raw = rawText.trim().replace(/%+$/, "").trim();
  if (!raw) {
    return null;
  }
  const num = Number(raw);
  if (!Number.isFinite(num)) {
    return null;
  }
  const scale = num / 100.0;
  return Math.min(Math.max(scale, UI_SCALE_MIN), UI_SCALE_MAX);
}

function normalizeThemeMode(input: string): ThemeMode {
  if (input in THEME_LABEL_TO_MODE) {
    return THEME_LABEL_TO_MODE[input];
  }
  if (input === "system" || input === "light" || input === "dark") {
    return input;
  }
  return "system";
}

export class SettingsDialogController extends TypedEmitter<SettingsDialogEvents> {
  currentTab: SettingsTab = "appearance";

  readonly originalThemeMode: ThemeMode;
  pendingThemeMode: ThemeMode;
  readonly originalThemeColor: string;
  pendingThemeColor: string;
  customThemeColor: string;
  customColorInput: string;
  customColorValid: boolean = true;
  customSwatchColor: string;
  customColorTooltip: string = "";

  readonly originalUiScale: number;
  pendingUiScale: number;
  scaleText: string;
  readonly scaleOptions: string[];
  scaleChanged: boolean = false;

  readonly hasSpeaker: boolean;
  voiceFabEnabled: boolean;
  readonly voiceFabInteractive: boolean;
  showSceneTab: boolean;

  readonly autostartSupported: boolean;
  autostart: boolean;
  readonly autostartDescription: string;

  readonly speakerOptions: SettingsSpeakerOption[];
  defaultSpeakerDid: string;
  readonly speakerSelectable: boolean;

  minimizeToTray: boolean;
  startMinimized: boolean;
  startMinimizedEnabled: boolean;
  hideNoFuncDevices: boolean;
  checkUpdateEnabled: boolean;

  accepted: boolean = false;
  closed: boolean = false;

  private readonly _devices: DeviceInfo[];
  private readonly _host: SettingsThemeHost | null;

  constructor(options: SettingsDialogOptions = {}) {
    super();
    this._devices = [...(options.devices ?? [])];
    this._host = options.host ?? null;

    // 外观模式与主题色
    this.originalThemeMode = normalizeThemeMode(getThemeMode());
    this.pendingThemeMode = this.originalThemeMode;

    this.originalThemeColor = getThemeColor();
    this.pendingThemeColor = this.originalThemeColor;
    this.customThemeColor = this.pendingThemeColor.startsWith("#")
      ? this.pendingThemeColor
      : getCustomThemeColor();
    this.customColorInput = this.customThemeColor;
    this.customSwatchColor = this.customThemeColor;
    this._syncCustomTextState(this.customColorInput);

    // 界面缩放比例
    this.originalUiScale = getUiScale();
    this.pendingUiScale = this.originalUiScale;
    this.scaleOptions = [...UI_SCALES]
      .sort((a, b) => a - b)
      .map((s) => `${Math.round(s * 100)}%`);
    this.scaleText = formatScalePercent(this.pendingUiScale);

    // 小爱悬浮对话按钮与音箱判定（在线小爱音箱决定交互可用性）
    this.hasSpeaker = this._devices.some((d) => isSpeaker(d) && d.online);
    this.voiceFabInteractive = this.hasSpeaker;
    this.voiceFabEnabled = this.hasSpeaker ? getVoiceFabEnabled() : false;

    // 场景选项卡（场景功能屏蔽期间恒为 false）
    this.showSceneTab = SCENES_FEATURE_ENABLED ? getShowSceneTab() : false;

    // 开机自启动
    this.autostartSupported = autostartSupported();
    if (this.autostartSupported) {
      this.autostartDescription =
        "开启后，Windows 登录时自动启动米家（可与「以系统托盘方式启动」搭配静默运行）";
      this.autostart = getAutostart();
    } else {
      this.autostartDescription =
        "仅构建版（build.ps1 产物 dist/MijiaDeck.exe）支持；当前为源码运行模式，" +
        "保存设置时将清除残留的自启动注册项";
      this.autostart = false;
    }

    // 默认输出音箱（含离线音箱；在线优先排序）
    const speakers = this._devices
      .filter((d) => isSpeaker(d))
      .sort((a, b) => {
        const onlineDiff = (a.online ? 0 : 1) - (b.online ? 0 : 1);
        if (onlineDiff !== 0) return onlineDiff;
        const nameDiff = a.name.localeCompare(b.name);
        if (nameDiff !== 0) return nameDiff;
        return a.did.localeCompare(b.did);
      });
    this.speakerOptions = [
      { did: "", label: "自动（第一个在线音箱）" },
      ...speakers.map((d) => ({ did: d.did, label: `${d.name}（${d.room_name}）` })),
    ];
    this.speakerSelectable = this.hasSpeaker;
    const savedDid = getDefaultSpeakerDid();
    if (this.hasSpeaker && this.speakerOptions.some((opt) => opt.did === savedDid)) {
      this.defaultSpeakerDid = savedDid;
    } else {
      this.defaultSpeakerDid = "";
    }

    // 系统托盘与其余应用功能
    this.minimizeToTray = getMinimizeToTray();
    this.startMinimized = getStartMinimized();
    this.startMinimizedEnabled = this.minimizeToTray;
    this.hideNoFuncDevices = getHideNoFuncDevices();
    this.checkUpdateEnabled = getCheckUpdateEnabled();
  }

  // ---------- 分类切换 ----------

  selectTab(tab: SettingsTab): void {
    if (tab === this.currentTab) {
      return;
    }
    this.currentTab = tab;
    this.emit("changed", this.snapshot());
  }

  // ---------- 主题模式与主题色即时预览 ----------

  selectThemeMode(modeOrLabel: string): void {
    const mode = normalizeThemeMode(modeOrLabel);
    if (mode === this.pendingThemeMode) {
      return;
    }
    this.pendingThemeMode = mode;
    this._host?.applyThemeMode?.(mode);
    this.emit("changed", this.snapshot());
  }

  selectThemeColor(color: string): void {
    const target = color === "custom" ? this.customThemeColor : color;
    const normalized = normalizeThemeColor(target);
    if (normalized === null) {
      return;
    }
    if (normalized === this.pendingThemeColor) {
      return;
    }
    this.pendingThemeColor = normalized;
    if (normalized.startsWith("#")) {
      this.customThemeColor = normalized;
    }
    this._host?.applyThemeColor?.(normalized);
    this.emit("changed", this.snapshot());
  }

  setCustomColorText(text: string): void {
    this.customColorInput = text;
    const normalized = this._syncCustomTextState(text);
    if (normalized !== null) {
      this.customThemeColor = normalized;
      this.selectThemeColor(normalized);
      return;
    }
    this.emit("changed", this.snapshot());
  }

  commitCustomColor(): boolean {
    const normalized = normalizeThemeColor(this.customColorInput);
    if (!normalized || !normalized.startsWith("#")) {
      return false;
    }
    this.customThemeColor = normalized;
    this.customColorInput = normalized;
    this.customColorValid = true;
    this.customSwatchColor = normalized;
    this.customColorTooltip = "";
    if (this.pendingThemeColor !== normalized) {
      this.pendingThemeColor = normalized;
      this._host?.applyThemeColor?.(normalized);
    }
    this.emit("changed", this.snapshot());
    return true;
  }

  // ---------- 界面缩放 ----------

  selectScalePreset(indexOrLabel: number | string): boolean {
    const label =
      typeof indexOrLabel === "number" ? this.scaleOptions[indexOrLabel] : indexOrLabel;
    if (typeof label !== "string") {
      return false;
    }
    const parsed = parseScaleText(label);
    if (parsed === null) {
      return false;
    }
    this.pendingUiScale = parsed;
    this.scaleText = formatScalePercent(parsed);
    this.emit("changed", this.snapshot());
    return true;
  }

  editScaleText(rawText: string): boolean {
    const trimmed = rawText.trim().replace(/%+$/, "").trim();
    if (!trimmed) {
      this.scaleText = formatScalePercent(this.pendingUiScale);
      this.emit("changed", this.snapshot());
      return false;
    }
    const parsed = parseScaleText(rawText);
    if (parsed === null) {
      this.scaleText = formatScalePercent(this.pendingUiScale);
      this.emit("changed", this.snapshot());
      return false;
    }
    this.pendingUiScale = parsed;
    this.scaleText = formatScalePercent(parsed);
    this.emit("changed", this.snapshot());
    return true;
  }

  // ---------- 功能项切换 ----------

  setVoiceFabEnabled(enabled: boolean): void {
    if (!this.hasSpeaker) {
      return;
    }
    this.voiceFabEnabled = Boolean(enabled);
    this.emit("changed", this.snapshot());
  }

  setShowSceneTab(enabled: boolean): void {
    if (!SCENES_FEATURE_ENABLED) {
      return;
    }
    this.showSceneTab = Boolean(enabled);
    this.emit("changed", this.snapshot());
  }

  setAutostart(enabled: boolean): void {
    if (!this.autostartSupported) {
      return;
    }
    this.autostart = Boolean(enabled);
    this.emit("changed", this.snapshot());
  }

  setDefaultSpeakerDid(did: string): void {
    if (!this.hasSpeaker) {
      return;
    }
    if (!this.speakerOptions.some((opt) => opt.did === did)) {
      return;
    }
    this.defaultSpeakerDid = did;
    this.emit("changed", this.snapshot());
  }

  setMinimizeToTray(enabled: boolean): void {
    this.minimizeToTray = Boolean(enabled);
    this.startMinimizedEnabled = this.minimizeToTray;
    this.emit("changed", this.snapshot());
  }

  setStartMinimized(enabled: boolean): void {
    if (!this.minimizeToTray) {
      return;
    }
    this.startMinimized = Boolean(enabled);
    this.emit("changed", this.snapshot());
  }

  setHideNoFuncDevices(enabled: boolean): void {
    this.hideNoFuncDevices = Boolean(enabled);
    this.emit("changed", this.snapshot());
  }

  setCheckUpdateEnabled(enabled: boolean): void {
    this.checkUpdateEnabled = Boolean(enabled);
    this.emit("changed", this.snapshot());
  }

  // ---------- 提交 / 取消 ----------

  save(): boolean {
    if (this.pendingThemeColor.startsWith("#") && !this.commitCustomColor()) {
      return false;
    }

    setMinimizeToTray(this.minimizeToTray);
    // 子开关仅在父开关开启时有效，关闭时强制写入 false
    if (this.minimizeToTray) {
      setStartMinimized(this.startMinimized);
    } else {
      setStartMinimized(false);
    }

    if (this.speakerOptions.some((opt) => opt.did === this.defaultSpeakerDid)) {
      setDefaultSpeakerDid(this.defaultSpeakerDid);
    }

    // 语音悬浮球仅在带设备上下文时落盘，避免设备尚未加载完成时静默覆写为关闭
    if (this._devices.length > 0) {
      setVoiceFabEnabled(this.voiceFabEnabled);
    }

    setHideNoFuncDevices(this.hideNoFuncDevices);
    if (SCENES_FEATURE_ENABLED) {
      setShowSceneTab(this.showSceneTab);
    }
    setCheckUpdateEnabled(this.checkUpdateEnabled);
    setThemeMode(this.pendingThemeMode);
    setThemeColor(this.pendingThemeColor);
    setCustomThemeColor(this.customThemeColor);

    this.scaleChanged = Math.abs(this.pendingUiScale - this.originalUiScale) >= 1e-6;
    setUiScale(this.pendingUiScale);

    // 开机自启动写入失败不阻断其余设置保存；开发模式顺带清理残留注册项
    try {
      setAutostart(this.autostart);
    } catch {
      // ignore OS registry error
    }

    this.accepted = true;
    this.closed = true;
    this.emit("saved", { scaleChanged: this.scaleChanged });
    this.emit("changed", this.snapshot());
    return true;
  }

  /**
   * 取消并关闭：还原即时预览的主题色与外观模式，不持久化任何更改。
   */
  cancel(): void {
    if (this.closed) {
      return;
    }
    if (this.pendingThemeColor !== this.originalThemeColor) {
      this.pendingThemeColor = this.originalThemeColor;
      this._host?.applyThemeColor?.(this.originalThemeColor);
    }
    if (this.pendingThemeMode !== this.originalThemeMode) {
      this.pendingThemeMode = this.originalThemeMode;
      this._host?.applyThemeMode?.(this.originalThemeMode);
    }
    this.accepted = false;
    this.closed = true;
    this.emit("cancelled");
    this.emit("changed", this.snapshot());
  }

  snapshot(): SettingsDialogState {
    return {
      currentTab: this.currentTab,
      themeMode: this.pendingThemeMode,
      themeModeLabel: THEME_MODE_LABELS[this.pendingThemeMode],
      themeColor: this.pendingThemeColor,
      customThemeColor: this.customThemeColor,
      customColorInput: this.customColorInput,
      customColorValid: this.customColorValid,
      customSwatchColor: this.customSwatchColor,
      customColorTooltip: this.customColorTooltip,
      uiScale: this.pendingUiScale,
      scaleText: this.scaleText,
      scaleOptions: [...this.scaleOptions],
      scaleChanged: this.scaleChanged,
      hasSpeaker: this.hasSpeaker,
      voiceFabEnabled: this.voiceFabEnabled,
      voiceFabInteractive: this.voiceFabInteractive,
      showSceneTab: this.showSceneTab,
      autostartSupported: this.autostartSupported,
      autostart: this.autostart,
      autostartDescription: this.autostartDescription,
      speakerOptions: this.speakerOptions.map((o) => ({ ...o })),
      defaultSpeakerDid: this.defaultSpeakerDid,
      speakerSelectable: this.speakerSelectable,
      minimizeToTray: this.minimizeToTray,
      startMinimized: this.startMinimized,
      startMinimizedEnabled: this.startMinimizedEnabled,
      hideNoFuncDevices: this.hideNoFuncDevices,
      checkUpdateEnabled: this.checkUpdateEnabled,
      accepted: this.accepted,
      closed: this.closed,
    };
  }

  private _syncCustomTextState(text: string): string | null {
    const normalized = normalizeThemeColor(text);
    const valid = Boolean(normalized && normalized.startsWith("#"));
    this.customColorValid = valid;
    this.customSwatchColor = valid && normalized ? normalized : this.customThemeColor;
    this.customColorTooltip = valid ? "" : "请输入完整的 #RRGGBB，例如 #333333";
    return valid && normalized ? normalized : null;
  }
}
