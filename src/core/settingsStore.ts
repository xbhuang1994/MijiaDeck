// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors
/**
 * 应用设置的本地持久化。
 *
 * 与 tray.json / workbench.json 同目录，单独文件 settings.json，
 * 保存用户在设置界面中调整的偏好。
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { APP_VERSION, isPackaged, runtimeEnv } from "./appMeta.ts";
import type { TrayPosition } from "./contracts.ts";
import { dataFile, readJson, writeJson } from "./jsonStore.ts";

export const SETTINGS_VERSION = 1;
// 界面缩放档位（设置页下拉选项），范围 50%–200%
export const UI_SCALES = [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0] as const;
export const UI_SCALE_MIN = 0.5;
export const UI_SCALE_MAX = 2.0;
export const UI_SCALE_DEFAULT = 1.0;

export type ThemeMode = "system" | "light" | "dark";

const FILENAME = "settings.json";
const THEME_MODES = new Set<string>(["system", "light", "dark"]);
const PRESET_THEME_COLORS = new Set<string>(["green", "pink", "yellow", "blue"]);
const HEX_COLOR_RE = /^#[0-9a-f]{6}$/;

const DEFAULTS: Record<string, unknown> = {
  version: SETTINGS_VERSION,
  minimize_to_tray: true,
  start_minimized: false,
  voice_fab_enabled: true,
  theme: "system", // system / light / dark
  theme_color: "green",
  custom_theme_color: "#333333",
  hide_no_func_devices: false,
  show_scene_tab: true, // 主页选项卡最左侧显示「场景」入口（手动场景一键执行）
  default_speaker_did: "", // 小爱指令默认输出音箱；空串=自动（第一个在线）
  ui_scale: 1.0, // 界面缩放个人微调乘数（叠加在系统 DPI 缩放之上），需重启生效
  tray_columns: 2, // 托盘快捷窗口卡片列数：1 或 2
  tray_position: null, // screen name and logical offsets within its work area
  check_update_enabled: true, // 启动时自动检查 GitHub 新版本
  tray_intro_seen: false, // First-use guidance for the click-only tray controls.
};

function readRaw(): Record<string, unknown> {
  const raw = readJson<Record<string, unknown>>(dataFile(FILENAME), { ...DEFAULTS });
  if (raw.version !== SETTINGS_VERSION) {
    return { ...DEFAULTS };
  }
  // 补全缺失字段
  for (const [k, v] of Object.entries(DEFAULTS)) {
    if (!(k in raw)) {
      raw[k] = v;
    }
  }
  return raw;
}

function writeRaw(raw: Record<string, unknown>): void {
  writeJson(dataFile(FILENAME), raw);
}

/** 关闭窗口时是否最小化到托盘，默认 true。 */
export function getMinimizeToTray(): boolean {
  return Boolean(readRaw().minimize_to_tray);
}

export function setMinimizeToTray(value: boolean): void {
  const raw = readRaw();
  raw.minimize_to_tray = Boolean(value);
  writeRaw(raw);
}

/** 启动时是否以托盘方式静默启动，不唤出主界面。默认 false。 */
export function getStartMinimized(): boolean {
  return Boolean(readRaw().start_minimized);
}

export function setStartMinimized(value: boolean): void {
  const raw = readRaw();
  raw.start_minimized = Boolean(value);
  writeRaw(raw);
}

export function getTrayIntroSeen(): boolean {
  return Boolean(readRaw().tray_intro_seen);
}

export function setTrayIntroSeen(value: boolean): void {
  const raw = readRaw();
  raw.tray_intro_seen = Boolean(value);
  writeRaw(raw);
}

export function shouldStartHidden(): boolean {
  return (
    getStartMinimized() &&
    getMinimizeToTray() &&
    getTrayIntroSeen() &&
    readRaw().last_started_version === APP_VERSION
  );
}

/** Remember a displayed startup without changing the user's tray preference. */
export function markVersionStarted(version?: string | null): void {
  const raw = readRaw();
  raw.last_started_version = version || APP_VERSION;
  writeRaw(raw);
}

/** 是否启用小爱同学悬浮对话按钮，默认 true。 */
export function getVoiceFabEnabled(): boolean {
  return Boolean(readRaw().voice_fab_enabled);
}

export function setVoiceFabEnabled(value: boolean): void {
  const raw = readRaw();
  raw.voice_fab_enabled = Boolean(value);
  writeRaw(raw);
}

/**
 * 小爱指令默认输出音箱的 did；空串表示自动（第一个在线音箱）。
 * 设备被移除或离线时不强制：调用方找不到该 did 时回退自动选择。
 */
export function getDefaultSpeakerDid(): string {
  const value = readRaw().default_speaker_did;
  return typeof value === "string" ? value : "";
}

export function setDefaultSpeakerDid(value: string): void {
  const raw = readRaw();
  raw.default_speaker_did = typeof value === "string" ? value : "";
  writeRaw(raw);
}

/** 是否隐藏无可控制功能的设备（无 spec / spec 无属性），默认关闭。 */
export function getHideNoFuncDevices(): boolean {
  return Boolean(readRaw().hide_no_func_devices);
}

export function setHideNoFuncDevices(value: boolean): void {
  const raw = readRaw();
  raw.hide_no_func_devices = Boolean(value);
  writeRaw(raw);
}

/** 是否在主页选项卡最左侧显示「场景」入口，默认开启。 */
export function getShowSceneTab(): boolean {
  return Boolean(readRaw().show_scene_tab);
}

export function setShowSceneTab(value: boolean): void {
  const raw = readRaw();
  raw.show_scene_tab = Boolean(value);
  writeRaw(raw);
}

function parseIntStrict(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? Math.trunc(value) : null;
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^[+-]?\d+$/.test(trimmed)) {
      return null;
    }
    return Number.parseInt(trimmed, 10);
  }
  return null;
}

/** 托盘快捷窗口卡片列数，仅认 1 / 2，其余值回退双列。 */
export function getTrayColumns(): 1 | 2 {
  const parsed = parseIntStrict(readRaw().tray_columns);
  return parsed === 1 || parsed === 2 ? parsed : 2;
}

export function setTrayColumns(value: number): void {
  const raw = readRaw();
  const parsed = parseIntStrict(value);
  raw.tray_columns = parsed === 1 || parsed === 2 ? parsed : 2;
  writeRaw(raw);
}

export function getTrayPosition(): TrayPosition | null {
  const value = readRaw().tray_position;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const rec = value as Record<string, unknown>;
  if (typeof rec.screen !== "string" || !Number.isInteger(rec.x) || !Number.isInteger(rec.y)) {
    return null;
  }
  return {
    screen: rec.screen,
    x: rec.x as number,
    y: rec.y as number,
  };
}

export function setTrayPosition(value: TrayPosition | null): void {
  const raw = readRaw();
  raw.tray_position = value;
  writeRaw(raw);
}

/** 启动时是否自动检查 GitHub 新版本，默认开启。 */
export function getCheckUpdateEnabled(): boolean {
  return Boolean(readRaw().check_update_enabled);
}

export function setCheckUpdateEnabled(value: boolean): void {
  const raw = readRaw();
  raw.check_update_enabled = Boolean(value);
  writeRaw(raw);
}

/**
 * 界面缩放个人微调乘数（叠加在系统 DPI 缩放之上），默认 100%。
 * 档位值直接用；手工改配置文件的任意值按范围收窄；非法值回退默认。
 */
export function getUiScale(): number {
  const rawVal = readRaw().ui_scale;
  let value: number;
  if (typeof rawVal === "number") {
    value = rawVal;
  } else if (typeof rawVal === "string" && rawVal.trim() !== "") {
    value = Number(rawVal);
  } else {
    return UI_SCALE_DEFAULT;
  }
  if (!Number.isFinite(value) || value <= 0) {
    return UI_SCALE_DEFAULT;
  }
  if ((UI_SCALES as readonly number[]).includes(value)) {
    return value;
  }
  return Math.min(Math.max(value, UI_SCALE_MIN), UI_SCALE_MAX);
}

export function setUiScale(value: number): void {
  const raw = readRaw();
  const num = Number(value);
  // 超出 50%-200% 范围的值钳制到边界
  raw.ui_scale = Number.isFinite(num)
    ? Math.min(Math.max(num, UI_SCALE_MIN), UI_SCALE_MAX)
    : UI_SCALE_DEFAULT;
  writeRaw(raw);
}

/** 主题配色设置：system（跟随系统）/ light / dark，默认 system。 */
export function getThemeMode(): ThemeMode {
  const value = String(readRaw().theme ?? "system");
  return THEME_MODES.has(value) ? (value as ThemeMode) : "system";
}

export function setThemeMode(value: string): void {
  const raw = readRaw();
  raw.theme = THEME_MODES.has(value) ? value : "system";
  writeRaw(raw);
}

export function normalizeThemeColor(value: string): string | null {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (PRESET_THEME_COLORS.has(normalized) || HEX_COLOR_RE.test(normalized)) {
    return normalized;
  }
  return null;
}

export function getThemeColor(): string {
  const value = String(readRaw().theme_color ?? "green");
  return normalizeThemeColor(value) ?? "green";
}

export function setThemeColor(value: string): void {
  const raw = readRaw();
  raw.theme_color = normalizeThemeColor(value) ?? "green";
  writeRaw(raw);
}

export function getCustomThemeColor(): string {
  const value = normalizeThemeColor(String(readRaw().custom_theme_color ?? "#333333"));
  return value && value.startsWith("#") ? value : "#333333";
}

export function setCustomThemeColor(value: string): void {
  const normalized = normalizeThemeColor(value);
  if (!normalized || !normalized.startsWith("#")) {
    throw new Error("请输入 #RRGGBB 格式的色值");
  }
  const raw = readRaw();
  raw.custom_theme_color = normalized;
  writeRaw(raw);
}

// ---------- 开机自启动（Windows 注册表 HKCU Run） ----------

export const AUTOSTART_RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
export const AUTOSTART_VALUE_NAME = "MijiaDeck";

export interface AutostartRegistryBackend {
  query(key: string, valueName: string): string | null;
  set(key: string, valueName: string, command: string): void;
  remove(key: string, valueName: string): void;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const windowsRegBackend: AutostartRegistryBackend = {
  query(key: string, valueName: string): string | null {
    const res = spawnSync("reg", ["query", key, "/v", valueName], {
      encoding: "utf-8",
      windowsHide: true,
    });
    if (res.error || res.status !== 0 || typeof res.stdout !== "string") {
      return null;
    }
    const pattern = new RegExp(`^\\s*${escapeRegExp(valueName)}\\s+REG_(?:EXPAND_)?SZ\\s*(.*)$`, "i");
    for (const line of res.stdout.split(/\r?\n/)) {
      const match = pattern.exec(line);
      if (match) {
        return match[1].trim();
      }
    }
    return null;
  },

  set(key: string, valueName: string, command: string): void {
    const res = spawnSync("reg", ["add", key, "/v", valueName, "/t", "REG_SZ", "/d", command, "/f"], {
      encoding: "utf-8",
      windowsHide: true,
    });
    if (res.error) {
      throw res.error;
    }
    if (res.status !== 0) {
      throw new Error((res.stderr || res.stdout || "reg add failed").trim());
    }
  },

  remove(key: string, valueName: string): void {
    if (this.query(key, valueName) === null) {
      return;
    }
    const res = spawnSync("reg", ["delete", key, "/v", valueName, "/f"], {
      encoding: "utf-8",
      windowsHide: true,
    });
    if (res.error) {
      throw res.error;
    }
    // 忽略值在并发删除时已不存在的情况
    if (res.status !== 0 && this.query(key, valueName) !== null) {
      throw new Error((res.stderr || res.stdout || "reg delete failed").trim());
    }
  },
};

let activeRegistryBackend: AutostartRegistryBackend = windowsRegBackend;

export function setAutostartRegistryBackend(backend: AutostartRegistryBackend | null): void {
  activeRegistryBackend = backend ?? windowsRegBackend;
}

/** 仅构建版（打包形态）且在 Windows 上支持开机自启动。 */
export function autostartSupported(): boolean {
  return isPackaged() && runtimeEnv.platform === "win32";
}

function autostartCommand(): string {
  const argv0 = runtimeEnv.argv[0] ?? "";
  const execPath = runtimeEnv.execPath ?? "";
  const lowerArgv0 = argv0.toLowerCase();
  const lowerExec = execPath.toLowerCase();
  const isBunArgv0 =
    !argv0 || lowerArgv0 === "bun" || lowerArgv0.endsWith("bun.exe") || lowerArgv0.endsWith("/bun");
  const isBunExec =
    !execPath || lowerExec.endsWith("bun.exe") || lowerExec.endsWith("/bun");
  const chosen = isBunArgv0 && !isBunExec ? execPath : argv0 || execPath;
  return `"${path.resolve(chosen)}"`;
}

/** 从 Run 条目命令里解析目标可执行文件路径；空引号 "" 显式拒绝。 */
export function parseCommandTarget(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith('"')) {
    const end = trimmed.indexOf('"', 1);
    if (end === -1) {
      return null;
    }
    const inner = trimmed.slice(1, end);
    // 空引号命令解析为当前目录，existsSync 恒真，需显式拒绝
    return inner ? inner : null;
  }
  const spaceIdx = trimmed.indexOf(" ");
  const bare = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
  return bare ? bare : null;
}

/**
 * 读取注册表实际状态（而非偏好文件），外部改动也能反映。
 * 目标文件已不存在的残留条目视为未开启（返回 false）。
 */
export function getAutostart(): boolean {
  if (runtimeEnv.platform !== "win32") {
    return false;
  }
  let value: string | null;
  try {
    value = activeRegistryBackend.query(AUTOSTART_RUN_KEY, AUTOSTART_VALUE_NAME);
  } catch {
    return false;
  }
  if (typeof value !== "string") {
    return false;
  }
  const target = parseCommandTarget(value);
  return target !== null && existsSync(target);
}

/** 开启自启动仅在构建版受支持；关闭（清理残留）任何形态都允许。 */
export function setAutostart(value: boolean): void {
  if (runtimeEnv.platform !== "win32") {
    return;
  }
  if (value && !autostartSupported()) {
    // 开发模式拒绝写入（调用方负责置灰开关并提示）
    return;
  }
  if (value) {
    activeRegistryBackend.set(AUTOSTART_RUN_KEY, AUTOSTART_VALUE_NAME, autostartCommand());
    return;
  }
  activeRegistryBackend.remove(AUTOSTART_RUN_KEY, AUTOSTART_VALUE_NAME);
}
