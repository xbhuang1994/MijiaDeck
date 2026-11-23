// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * 主题中枢与编排：深/浅双调色板、自定义主题色 WCAG 对比度推导、
 * 动态 SiColors 代理、全局 CSS 生成、以及系统配色跟随控制器。
 */

import { TypedEmitter } from "../core/contracts.ts";
import { getThemeMode, normalizeThemeColor } from "../core/settingsStore.ts";

export type ThemeName = "dark" | "light";
export type ThemeMode = "system" | "light" | "dark";
export type PresetAccent = "green" | "pink" | "yellow" | "blue";
export type AccentTuple = readonly [string, string, string, string, string, string, string];

export interface ThemeColorMeta {
  label: string;
  hex: string;
}

export interface AccentRoles {
  THEME: string;
  THEME_HOVER: string;
  THEME_PRESSED: string;
  THEME_CHECKED_HOVER: string;
  THEME_DIM: string;
  ON_THEME_TEXT: string;
  SWITCH_THUMB: string;
  ACCENT_SURFACE: string;
  ACCENT_BORDER: string;
  CARD_HOVER: string;
  CARD_BORDER_HOVER: string;
}

export interface CaptionColorSet {
  ink: string;
  hover: string;
  pressed: string;
  active: string;
}

// ----------------------------------------------------------------------------
// 窗口标题栏常量（自 app/ui/window_caption.py）
// ----------------------------------------------------------------------------
export const CAPTION_HEIGHT = 34;
export const BRAND_CAPTION_HEIGHT = 48;
export const CAPTION_BUTTON_WIDTH = 46;
export const RESIZE_MARGIN = 6;

// ----------------------------------------------------------------------------
// 主题模式常量（自 app/ui/theme_service.py）
// ----------------------------------------------------------------------------
export const MODE_SYSTEM = "system" as const;
export const MODE_LIGHT = "light" as const;
export const MODE_DARK = "dark" as const;

// ----------------------------------------------------------------------------
// 与主题色无关的固定语义色
// ----------------------------------------------------------------------------
export const DANGER = "#c0392b";
export const DANGER_TEXT = "#e57373";
export const WHITE = "#ffffff";
export const ONLINE = "#3dbba4";

// ----------------------------------------------------------------------------
// 深/浅调色板：语义键 -> 色值。新增颜色一律进这里，不要在界面代码写死
// ----------------------------------------------------------------------------
export const PALETTES: Record<ThemeName, Record<string, string>> = {
  dark: {
    WINDOW_BG: "#1e1f24",
    TITLE_BAR_BG: "#1a1b20",
    TITLE_BAR_BORDER: "#252630",
    CARD: "#2a2c32",
    ACCENT_SURFACE: "#203c36",
    CARD_HOVER: "#333540",
    CARD_BORDER_HOVER: "#404252",
    SURFACE: "#2e2f36",
    FLOAT_SURFACE: "#424650",
    FLOAT_BORDER: "#606775",
    TRAY_CARD: "#393d46",
    TRAY_CARD_HOVER: "#454b56",
    CAMERA_TAG_BG: "#df2525",
    SURFACE_PRESSED: "#1f1f23",
    PRESSED: "#17171a",
    BTN_PRESSED: "#25262e",
    BTN_HOVER: "#3a3b44",
    LINE: "#35363f",
    SCROLLBAR: "#35363f",
    SCROLLBAR_HOVER: "#4a4b55",
    TEXT_PRIMARY: "#e8e8ea",
    INFO_TEXT: "#e8e8ea",
    TEXT_SECONDARY: "#8a8b93",
    TEXT_MUTED: "#7c7d83",
    TEXT_SUBTLE: "#9a9aa0",
    TEXT_DISABLED: "#555558",
    TEXT_FAINT: "#444448",
    OFFLINE_CARD: "#1a1b20",
    OFFLINE_TEXT: "#6e6e78",
    OFFLINE_SUB: "#5a5b64",
    ICON_DIM: "#7a7b83",
    ICON_MUTED: "#a0a0aa",
    HOME_HOVER: "#b9babf",
    HOME_PRESSED: "#85868b",
    THUMB: "#ffffff",
    STATE_OFF: "#40434f",
    POWER_OFF_BG: "#454b57",
    POWER_OFF_INK: "#d5dae3",
    POWER_OFF_HOVER: "#535d6c",
    STATE_UNKNOWN_BG: "#222227",
    STATE_UNKNOWN_BORDER: "#3a3a40",
    STATE_UNKNOWN_HOVER: "#2a2a30",
    ERROR_TEXT: "#e06060",
    DEL_TEXT: "#9a6a6a",
    DEL_BORDER: "#3a2f2f",
    DEL_BORDER_HOVER: "#6b2f2f",
    WARN_BG: "#3a2d12",
    WARN_BORDER: "#5a4220",
    WARN_TEXT: "#e8c87a",
  },
  light: {
    WINDOW_BG: "#f6f8fb",
    TITLE_BAR_BG: "#f6f8fb",
    TITLE_BAR_BORDER: "#e7edf4",
    CARD: "#ffffff",
    ACCENT_SURFACE: "#e6f5ef",
    CARD_HOVER: "#f0f7f6",
    CARD_BORDER_HOVER: "#b9dfd6",
    SURFACE: "#edf2f7",
    FLOAT_SURFACE: "#edf2f7",
    FLOAT_BORDER: "#dfe7f0",
    TRAY_CARD: "#edf2f7",
    TRAY_CARD_HOVER: "#e8eff5",
    CAMERA_TAG_BG: "#df2525",
    SURFACE_PRESSED: "#e4e6ea",
    PRESSED: "#d9dade",
    BTN_PRESSED: "#dfe1e6",
    BTN_HOVER: "#e8eff5",
    LINE: "#dfe7f0",
    SCROLLBAR: "#c9cbd2",
    SCROLLBAR_HOVER: "#b0b3bc",
    TEXT_PRIMARY: "#182431",
    INFO_TEXT: "#333333",
    TEXT_SECONDARY: "#687d93",
    TEXT_MUTED: "#8394a7",
    TEXT_SUBTLE: "#8394a7",
    TEXT_DISABLED: "#b4b6bc",
    TEXT_FAINT: "#c6c8ce",
    OFFLINE_CARD: "#f3f5f8",
    OFFLINE_TEXT: "#7e8c9b",
    OFFLINE_SUB: "#93a0ae",
    ICON_DIM: "#85878e",
    ICON_MUTED: "#9a9aa0",
    HOME_HOVER: "#55565c",
    HOME_PRESSED: "#75767c",
    THUMB: "#9a9ea6",
    STATE_OFF: "#c4c8d0",
    POWER_OFF_BG: "#edf2f7",
    POWER_OFF_INK: "#687d93",
    POWER_OFF_HOVER: "#e8eff5",
    STATE_UNKNOWN_BG: "#ececef",
    STATE_UNKNOWN_BORDER: "#c9cbd2",
    STATE_UNKNOWN_HOVER: "#e2e3e8",
    ERROR_TEXT: "#c62828",
    DEL_TEXT: "#b05a5a",
    DEL_BORDER: "#e8c5c5",
    DEL_BORDER_HOVER: "#e09b9b",
    WARN_BG: "#fdf3d8",
    WARN_BORDER: "#e8d49a",
    WARN_TEXT: "#8a6d1f",
  },
};

// 预设主题色标签与基准色值
export const THEME_COLORS: Record<PresetAccent, ThemeColorMeta> = {
  green: { label: "绿色", hex: "#00cc92" },
  pink: { label: "粉色", hex: "#db2777" },
  yellow: { label: "黄色", hex: "#eab308" },
  blue: { label: "蓝色", hex: "#2563eb" },
};

// 主色、悬停色、按下色、强调文字、浅底、选中边框、主色上的文字。
export const ACCENT_SCHEMES: Record<PresetAccent, Record<ThemeName, AccentTuple>> = {
  green: {
    light: ["#00cc92", "#00b883", "#00a375", "#00825d", "#e5faf3", "#80e5c8", "#ffffff"],
    dark: ["#00cc92", "#26d4a2", "#00b883", "#5ce0bb", "#12382e", "#26856a", "#ffffff"],
  },
  pink: {
    light: ["#db2777", "#be185d", "#9d174d", "#be185d", "#fce7f3", "#f0a6c4", "#ffffff"],
    dark: ["#db2777", "#be185d", "#9d174d", "#f9a8d4", "#3a1426", "#a34e75", "#ffffff"],
  },
  yellow: {
    light: ["#eab308", "#d5a207", "#bd9006", "#856404", "#fef3c7", "#e7c85a", "#ffffff"],
    dark: ["#eab308", "#d5a207", "#bd9006", "#fde047", "#332b0a", "#96771a", "#ffffff"],
  },
  blue: {
    light: ["#2563eb", "#1d4ed8", "#1e3a8a", "#1d4ed8", "#dbeafe", "#93b4f5", "#ffffff"],
    dark: ["#2563eb", "#1d4ed8", "#1e3a8a", "#93c5fd", "#132a4a", "#3b74b8", "#ffffff"],
  },
};

// 当前主题状态；启动时由 applyTheme 写定
let _current: ThemeName = "dark";
let _accent: string = "green";

// ----------------------------------------------------------------------------
// 色彩数学（WCAG 2.x 相对亮度与对比度）
// ----------------------------------------------------------------------------

function parseHexRgb(color: string): [number, number, number] {
  const cleaned = color.trim().replace(/^#/, "");
  if (cleaned.length === 3) {
    const r = parseInt(cleaned[0] + cleaned[0], 16);
    const g = parseInt(cleaned[1] + cleaned[1], 16);
    const b = parseInt(cleaned[2] + cleaned[2], 16);
    if (!Number.isNaN(r) && !Number.isNaN(g) && !Number.isNaN(b)) {
      return [r, g, b];
    }
  }
  if (cleaned.length === 6) {
    const r = parseInt(cleaned.slice(0, 2), 16);
    const g = parseInt(cleaned.slice(2, 4), 16);
    const b = parseInt(cleaned.slice(4, 6), 16);
    if (!Number.isNaN(r) && !Number.isNaN(g) && !Number.isNaN(b)) {
      return [r, g, b];
    }
  }
  throw new Error(`无效的 HEX 色值: ${color}`);
}

function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (n: number): string =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, "0");
  return `#${clamp(r)}${clamp(g)}${clamp(b)}`;
}

export function mixColor(first: string, second: string, amount: number): string {
  const a = parseHexRgb(first);
  const b = parseHexRgb(second);
  const r = a[0] * (1 - amount) + b[0] * amount;
  const g = a[1] * (1 - amount) + b[1] * amount;
  const bl = a[2] * (1 - amount) + b[2] * amount;
  return rgbToHex(r, g, bl);
}

export function luminance(color: string): number {
  const [r, g, b] = parseHexRgb(color);
  const channels = [r / 255, g / 255, b / 255];
  const linear = channels.map((c) =>
    c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4),
  );
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

export function contrast(first: string, second: string): number {
  const l1 = luminance(first);
  const l2 = luminance(second);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * 保留色相并调整强调文字亮度，避免极亮/极暗输入造成文字消失。
 */
export function readableInk(color: string, background: string): string {
  const target = luminance(background) < 0.2 ? "#ffffff" : "#111111";
  for (let step = 0; step <= 20; step += 1) {
    const candidate = mixColor(color, target, step / 20);
    if (contrast(candidate, background) >= 4.5) {
      return candidate;
    }
  }
  return target;
}

const CUSTOM_ACCENT_CACHE = new Map<string, AccentTuple>();
const CUSTOM_ACCENT_CACHE_MAX = 128;

export function customAccentColors(color: string, mode: ThemeName): AccentTuple {
  const normalized = color.trim().toLowerCase();
  const key = `${normalized}|${mode}`;
  const cached = CUSTOM_ACCENT_CACHE.get(key);
  if (cached) {
    // Refresh LRU order
    CUSTOM_ACCENT_CACHE.delete(key);
    CUSTOM_ACCENT_CACHE.set(key, cached);
    return cached;
  }

  const dark = mode === "dark";
  const backdrop = PALETTES[mode].CARD;
  // Preserve the exact selected color on solid controls in both modes.
  // Only supporting surfaces and foreground contrast are derived from it.
  const surface = mixColor(backdrop, normalized, dark ? 0.24 : 0.1);
  const border = mixColor(backdrop, normalized, dark ? 0.58 : 0.35);
  const ink = readableInk(normalized, surface);
  const main = normalized;
  const onColor = contrast("#ffffff", main) >= 4.5 ? "#ffffff" : "#000000";
  const hover = mixColor(main, "#111111", 0.12);
  const pressed = mixColor(main, "#111111", 0.22);
  const result: AccentTuple = [main, hover, pressed, ink, surface, border, onColor];

  if (CUSTOM_ACCENT_CACHE.size >= CUSTOM_ACCENT_CACHE_MAX) {
    const oldest = CUSTOM_ACCENT_CACHE.keys().next().value;
    if (oldest !== undefined) {
      CUSTOM_ACCENT_CACHE.delete(oldest);
    }
  }
  CUSTOM_ACCENT_CACHE.set(key, result);
  return result;
}

/**
 * 计算页脚背景色（精确还原 FooterBar.retheme 的亮度与暗化规则）。
 */
export function footerBackgroundColor(): string {
  const [r, g, b] = parseHexRgb(SiColors.WINDOW_BG);
  const lightness = Math.round((Math.max(r, g, b) + Math.min(r, g, b)) / 2);
  if (lightness >= 128) {
    return "#f0f2f5";
  }
  // Matches QColor.darker(115): divide HSV value by 1.15
  const factor = 100 / 115;
  return rgbToHex(r * factor, g * factor, b * factor);
}

/**
 * 窗口标题栏按钮配色（自 app/ui/window_caption.py）。
 */
export function captionColors(): CaptionColorSet {
  if (isDark()) {
    return { ink: "#A9B8CC", hover: "#16202C", pressed: "#1B2837", active: "#E9F0F8" };
  }
  return { ink: "#53657A", hover: "#E9EFF6", pressed: "#DDE7F2", active: "#17202B" };
}

// ----------------------------------------------------------------------------
// 主题与主题色状态存取
// ----------------------------------------------------------------------------

export function setAccent(accent: string): void {
  const normalized = normalizeThemeColor(accent);
  if (normalized === null) {
    throw new Error(`未知主题色: ${accent}`);
  }
  _accent = normalized;
}

export function currentAccent(): string {
  return _accent;
}

export function accentColors(): AccentRoles {
  const tuple: AccentTuple = _accent.startsWith("#")
    ? customAccentColors(_accent, _current)
    : ACCENT_SCHEMES[_accent as PresetAccent][_current];
  const [main, hover, pressed, ink, surface, border, onColor] = tuple;
  return {
    THEME: main,
    THEME_HOVER: hover,
    THEME_PRESSED: pressed,
    THEME_CHECKED_HOVER: hover,
    THEME_DIM: ink,
    ON_THEME_TEXT: onColor,
    SWITCH_THUMB: onColor,
    ACCENT_SURFACE: surface,
    ACCENT_BORDER: border,
    CARD_HOVER: surface,
    CARD_BORDER_HOVER: border,
  };
}

export function currentTheme(): ThemeName {
  return _current;
}

export function isDark(): boolean {
  return _current === "dark";
}

export function setTheme(theme: ThemeName): void {
  if (!(theme in PALETTES)) {
    throw new Error(`未知主题: ${String(theme)}`);
  }
  _current = theme;
}

export function palette(): Record<string, string> {
  return { ...PALETTES[_current], ...accentColors() };
}

// ----------------------------------------------------------------------------
// 动态 SiColors 代理
// ----------------------------------------------------------------------------

const STATIC_COLORS: Record<string, string> = {
  ONLINE,
  DANGER,
  DANGER_TEXT,
  WHITE,
};

export interface SiColorsProxy {
  readonly ONLINE: string;
  readonly DANGER: string;
  readonly DANGER_TEXT: string;
  readonly WHITE: string;
  readonly WINDOW_BG: string;
  readonly TITLE_BAR_BG: string;
  readonly TITLE_BAR_BORDER: string;
  readonly CARD: string;
  readonly ACCENT_SURFACE: string;
  readonly ACCENT_BORDER: string;
  readonly CARD_HOVER: string;
  readonly CARD_BORDER_HOVER: string;
  readonly SURFACE: string;
  readonly FLOAT_SURFACE: string;
  readonly FLOAT_BORDER: string;
  readonly TRAY_CARD: string;
  readonly TRAY_CARD_HOVER: string;
  readonly CAMERA_TAG_BG: string;
  readonly SURFACE_PRESSED: string;
  readonly PRESSED: string;
  readonly BTN_PRESSED: string;
  readonly BTN_HOVER: string;
  readonly LINE: string;
  readonly SCROLLBAR: string;
  readonly SCROLLBAR_HOVER: string;
  readonly TEXT_PRIMARY: string;
  readonly INFO_TEXT: string;
  readonly TEXT_SECONDARY: string;
  readonly TEXT_MUTED: string;
  readonly TEXT_SUBTLE: string;
  readonly TEXT_DISABLED: string;
  readonly TEXT_FAINT: string;
  readonly OFFLINE_CARD: string;
  readonly OFFLINE_TEXT: string;
  readonly OFFLINE_SUB: string;
  readonly ICON_DIM: string;
  readonly ICON_MUTED: string;
  readonly HOME_HOVER: string;
  readonly HOME_PRESSED: string;
  readonly THUMB: string;
  readonly STATE_OFF: string;
  readonly POWER_OFF_BG: string;
  readonly POWER_OFF_INK: string;
  readonly POWER_OFF_HOVER: string;
  readonly STATE_UNKNOWN_BG: string;
  readonly STATE_UNKNOWN_BORDER: string;
  readonly STATE_UNKNOWN_HOVER: string;
  readonly ERROR_TEXT: string;
  readonly DEL_TEXT: string;
  readonly DEL_BORDER: string;
  readonly DEL_BORDER_HOVER: string;
  readonly WARN_BG: string;
  readonly WARN_BORDER: string;
  readonly WARN_TEXT: string;
  readonly THEME: string;
  readonly THEME_HOVER: string;
  readonly THEME_PRESSED: string;
  readonly THEME_CHECKED_HOVER: string;
  readonly THEME_DIM: string;
  readonly ON_THEME_TEXT: string;
  readonly SWITCH_THUMB: string;
  readonly [key: string]: string;
}

const IGNORED_META_PROPS = new Set([
  "then",
  "catch",
  "finally",
  "toJSON",
  "valueOf",
  "toString",
  "constructor",
  "__esModule",
  "$$typeof",
]);

export const SiColors: SiColorsProxy = new Proxy(
  {} as SiColorsProxy,
  {
    get(_target, prop, receiver) {
      if (typeof prop === "symbol") {
        return Reflect.get(_target, prop, receiver);
      }
      if (prop in STATIC_COLORS) {
        return STATIC_COLORS[prop];
      }
      const current = palette();
      if (Object.prototype.hasOwnProperty.call(current, prop)) {
        return current[prop];
      }
      if (IGNORED_META_PROPS.has(prop)) {
        return undefined;
      }
      throw new Error(`SiColors 无此语义色: ${prop}，可用键见 PALETTES`);
    },
    has(_target, prop) {
      if (typeof prop !== "string") return false;
      return prop in STATIC_COLORS || Object.prototype.hasOwnProperty.call(palette(), prop);
    },
    ownKeys() {
      return Array.from(new Set([...Object.keys(STATIC_COLORS), ...Object.keys(palette())]));
    },
    getOwnPropertyDescriptor(_target, prop) {
      if (typeof prop !== "string") return undefined;
      const value =
        prop in STATIC_COLORS
          ? STATIC_COLORS[prop]
          : Object.prototype.hasOwnProperty.call(palette(), prop)
            ? palette()[prop]
            : undefined;
      if (value === undefined) return undefined;
      return {
        configurable: true,
        enumerable: true,
        value,
        writable: false,
      };
    },
  },
);

// ----------------------------------------------------------------------------
// 全局 CSS 生成：模板占位符 $KEY，由当前调色板填充
// ----------------------------------------------------------------------------

const _CSS_TEMPLATE = `
* {
  font-family: "Microsoft YaHei UI", "Segoe UI", system-ui, -apple-system, sans-serif;
  box-sizing: border-box;
}

html, body {
  margin: 0;
  padding: 0;
  background: $WINDOW_BG;
  color: $TEXT_PRIMARY;
  font-size: 13.33px;
}

.tooltip {
  font-size: 11px;
  font-weight: 400;
  color: $TEXT_PRIMARY;
  background: $CARD;
  border: 1px solid $LINE;
  border-radius: 4px;
  padding: 4px 7px;
}

.content-host, .grid-host {
  background: $WINDOW_BG;
}

/* ---------- 标题栏 ---------- */

.title-bar {
  background: $TITLE_BAR_BG;
  border-bottom: none;
}

.title-bar-text {
  font-size: 12px;
  font-weight: 600;
  color: $TEXT_SUBTLE;
  background: transparent;
}

.status-hint {
  color: $TEXT_SUBTLE;
  background: transparent;
  font-size: 12px;
  padding: 4px 0;
}

/* ---------- 顶栏家庭切换器 ---------- */

.home-switcher {
  background: transparent;
  border: none;
  padding: 2px 0;
  font-size: 27px;
  font-weight: 600;
  color: $TEXT_PRIMARY;
  text-align: left;
  cursor: pointer;
}

.home-switcher:hover {
  color: $HOME_HOVER;
}

.home-switcher:active {
  color: $HOME_PRESSED;
}

/* ---------- 设备卡片与详情页功能卡片 ---------- */

.device-card, .prop-card {
  background: $CARD;
  border: 1px solid $LINE;
  border-radius: 14px;
}

.device-card:hover, .prop-card:hover {
  background: $CARD_HOVER;
  border-color: $CARD_BORDER_HOVER;
}

.device-card.offline {
  background: $OFFLINE_CARD;
  color: $OFFLINE_TEXT;
}

.prop-card-toggle {
  background: transparent;
  border: none;
  color: $THEME;
  font-size: 12px;
  padding: 2px 6px;
}

.prop-card-toggle:hover {
  color: $THEME_HOVER;
}

/* ---------- 弹出菜单 ---------- */

.app-menu {
  background: $CARD;
  border: 1px solid $LINE;
  border-radius: 8px;
  padding: 4px;
}

.app-menu-item {
  padding: 5px 26px 5px 6px;
  border-radius: 6px;
  font-size: 13.33px;
  text-align: left;
  color: $TEXT_PRIMARY;
}

.app-menu-item:hover {
  background: $BTN_HOVER;
}

.app-menu-item.checked {
  color: $THEME;
}

/* ---------- 详情面板与输入控件 ---------- */

.panel-title {
  font-size: 20px;
  font-weight: 600;
  color: $TEXT_PRIMARY;
}

.panel-subtitle {
  color: $TEXT_SECONDARY;
  font-size: 12px;
}

input[type="number"], input[type="text"], select, textarea {
  background: $SURFACE;
  color: $TEXT_PRIMARY;
  border: 1px solid $LINE;
  border-radius: 8px;
  padding: 5px 10px;
}

input:focus, select:focus, textarea:focus {
  outline: none;
  border-color: $THEME;
}

/* ---------- 滚动条 ---------- */

::-webkit-scrollbar {
  width: 8px;
  height: 0;
  background: transparent;
}

::-webkit-scrollbar-thumb {
  background: $SCROLLBAR;
  border-radius: 4px;
  min-height: 30px;
}

::-webkit-scrollbar-thumb:hover {
  background: $SCROLLBAR_HOVER;
}

/* ---------- 通知浮层 ---------- */

.toast-card {
  background: $FLOAT_SURFACE;
  border: 1px solid $FLOAT_BORDER;
  border-radius: 10px;
  color: $TEXT_PRIMARY;
}

/* ---------- 小爱语音悬浮球 ---------- */

.voice-ball {
  background: $THEME;
  color: $ON_THEME_TEXT;
  border: none;
  border-radius: 50%;
}

.voice-ball:hover {
  background: $THEME_HOVER;
}

.voice-ball:active {
  background: $THEME_PRESSED;
}

.voice-panel {
  background: $FLOAT_SURFACE;
  border: 1px solid $FLOAT_BORDER;
  border-radius: 12px;
}

/* ---------- 房间选项卡与底栏 ---------- */

.room-tab {
  background: transparent;
  color: $TEXT_SECONDARY;
}

.room-tab.active {
  color: $THEME;
}

.reserved-footer {
  background: $FOOTER_BG;
  border-top: 1px solid $LINE;
  color: $TEXT_SECONDARY;
}

.reserved-footer .update-button {
  color: $THEME;
}

.reserved-footer .progress-track {
  background: $LINE;
}

.reserved-footer .progress-chunk {
  background: $THEME;
}

.primary-button {
  background: $THEME;
  color: $ON_THEME_TEXT;
  border: none;
  border-radius: 8px;
}

.primary-button:hover {
  background: $THEME_HOVER;
}

.danger-button:hover {
  background: $DANGER;
  color: $WHITE;
}

.online-dot {
  background: $ONLINE;
}

.camera-tag {
  background: $CAMERA_TAG_BG;
  color: $WHITE;
}

.warn-banner {
  background: $WARN_BG;
  border: 1px solid $WARN_BORDER;
  color: $WARN_TEXT;
}
`;

function toCssVarName(key: string): string {
  return `--md-${key.toLowerCase().replaceAll("_", "-")}`;
}

export function buildCss(): string {
  const values: Record<string, string> = {
    ...palette(),
    DANGER,
    DANGER_TEXT,
    WHITE,
    ONLINE,
    FOOTER_BG: footerBackgroundColor(),
  };

  const placeholderRegex = /\$([A-Z][A-Z0-9_]*)/g;
  const missing = new Set<string>();
  for (const match of _CSS_TEMPLATE.matchAll(placeholderRegex)) {
    const key = match[1];
    if (!(key in values)) {
      missing.add(key);
    }
  }
  if (missing.size > 0) {
    throw new Error(`CSS 模板占位符缺少调色板键: ${[...missing].join(", ")}`);
  }

  const rootVars = Object.entries(values)
    .map(([key, val]) => `  ${toCssVarName(key)}: ${val};`)
    .join("\n");

  const body = _CSS_TEMPLATE.replace(placeholderRegex, (_, key: string) => values[key]);
  return `:root {\n${rootVars}\n}\n${body}`;
}

// ----------------------------------------------------------------------------
// 主题编排与系统配色监听（自 app/ui/theme_service.py）
// ----------------------------------------------------------------------------

function detectSystemScheme(): ThemeName {
  try {
    const g = globalThis as { matchMedia?: (query: string) => { matches: boolean } };
    if (typeof g.matchMedia === "function") {
      if (g.matchMedia("(prefers-color-scheme: light)").matches) {
        return "light";
      }
    }
  } catch {
    // 非浏览器环境回退深色
  }
  return "dark";
}

/**
 * 把设置值解析为实际主题；跟随系统时参考系统色彩方案，未知回退深色。
 */
export function effectiveTheme(mode: string, systemScheme?: ThemeName): ThemeName {
  if (mode === "dark" || mode === "light") {
    return mode;
  }
  const scheme = systemScheme ?? detectSystemScheme();
  return scheme === "light" ? "light" : "dark";
}

/**
 * 应用主题设置并返回实际生效的主题名。
 */
export function applyTheme(
  mode: string,
  accent?: string | null,
  systemScheme?: ThemeName,
): ThemeName {
  const theme = effectiveTheme(mode, systemScheme);
  if (accent !== undefined && accent !== null) {
    setAccent(accent);
  }
  setTheme(theme);
  return theme;
}

export type ThemeControllerEvents = {
  themeChanged: [ThemeName];
  systemSchemeChanged: [ThemeName];
};

/**
 * 持有当前设置模式；跟随系统时监听系统配色变化并广播切换。
 *
 * 系统配色变化与应用主题是两件事：即使设置为固定深/浅色，
 * 托盘图标仍需跟随系统配色（任务栏底色由系统决定）。
 */
export class ThemeController extends TypedEmitter<ThemeControllerEvents> {
  private _mode: string;
  private _systemScheme: ThemeName;

  constructor(initialMode?: string, systemScheme?: ThemeName) {
    super();
    this._mode = initialMode ?? getThemeMode();
    this._systemScheme = systemScheme ?? detectSystemScheme();
  }

  mode(): string {
    return this._mode;
  }

  systemScheme(): ThemeName {
    return this._systemScheme;
  }

  /**
   * 切换设置模式并立即应用；返回实际生效主题。
   */
  setMode(mode: string): ThemeName {
    this._mode = mode;
    const theme = applyTheme(mode, undefined, this._systemScheme);
    this.emit("themeChanged", theme);
    return theme;
  }

  /**
   * 系统深浅色变化回调。
   */
  onSystemSchemeChanged(scheme: ThemeName): void {
    const normalized: ThemeName = scheme === "light" ? "light" : "dark";
    this._systemScheme = normalized;
    this.emit("systemSchemeChanged", normalized);
    if (this._mode !== MODE_SYSTEM) {
      return;
    }
    const theme = applyTheme(MODE_SYSTEM, undefined, normalized);
    this.emit("themeChanged", theme);
  }

  /**
   * 切换主题色并广播重建信号。
   */
  setAccent(accent: string): ThemeName {
    const theme = applyTheme(this._mode, accent, this._systemScheme);
    this.emit("themeChanged", theme);
    return theme;
  }
}
