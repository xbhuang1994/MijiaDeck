// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 多平台智能家居接入管理面板控制器 (Browser-safe, zero external deps)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * 模块化多平台接入管理面板（小米米家 / 涂鸦智能 / 美的智能 / 德业智能）。
 *
 * 严格遵循浏览器安全约束：
 * - 零 node:* 或服务端模块运行时依赖，仅使用 `import type` 与纯浏览器模块 `../ui/qrSvg.ts`；
 * - 全部 DOM 通过 `document.createElement` / `textContent` 构建，不使用不安全的 `innerHTML`；
 * - 密码、密钥与令牌输入框留空时从请求体省略，确保服务端已保存凭据不被意外覆盖。
 */

import type {
  DiscoveredLocalDevice,
  PlatformAuthMode,
  PlatformCapabilities,
  PlatformConnectionState,
  PlatformId,
  PlatformQrAuthResult,
  PlatformQrAuthSession,
  PlatformStatus,
} from "../platforms/types.ts";
import { SCENES_FEATURE_ENABLED } from "../core/featureFlags.ts";
import { renderQrSvg } from "../ui/qrSvg.ts";

// ---------------------------------------------------------------------------
// Public Browser-Safe UI Types
// ---------------------------------------------------------------------------

export type UiPlatformId = PlatformId;
export type UiPlatformAuthMode = PlatformAuthMode;
export type UiPlatformConnectionState = PlatformConnectionState;
export type UiPlatformCapabilities = PlatformCapabilities;
export type UiPlatformStatus = PlatformStatus;
export type UiPlatformQrSession = PlatformQrAuthSession;
export type UiPlatformQrResult = PlatformQrAuthResult;
export type UiDiscoveredLocalDevice = DiscoveredLocalDevice;

export type UiTuyaMode = "sharing" | "openapi" | "local" | "hybrid";
export type UiTuyaRegion = "cn" | "us" | "eu" | "in";
export type UiTuyaLocalVersion = "3.1" | "3.3" | "3.4" | "3.5";

export type UiMideaMode = "cloud" | "local" | "hybrid";
export type UiMideaBrand = "meiju" | "msmarthome" | "nethomeplus" | "midea_air";

export type UiDeyeMode = "cloud" | "solarman" | "hybrid";

export interface PlatformDisplayMeta {
  readonly id: UiPlatformId;
  readonly badgeText: string;
  readonly shortLabel: string;
  readonly displayName: string;
  readonly color: string;
  readonly iconGlyph: string;
  readonly description: string;
  readonly reference: string;
}

export interface PlatformBadgeInfo {
  readonly platform: UiPlatformId;
  readonly badgeText: string;
  readonly shortLabel: string;
  readonly color: string;
  readonly iconGlyph: string;
  readonly isExternal: boolean;
}

export interface UiTuyaLocalDeviceInput {
  id: string;
  name: string;
  ip: string;
  port?: number;
  version: UiTuyaLocalVersion;
  localKey?: string;
  hasLocalKey?: boolean;
  category?: string;
  room?: string;
}

export interface UiTuyaLocalDevicePayload {
  id: string;
  name: string;
  ip: string;
  port: number;
  version: UiTuyaLocalVersion;
  localKey?: string;
  category?: string;
  room?: string;
}

export interface UiTuyaFormState {
  enabled?: boolean;
  mode: UiTuyaMode;
  userCode: string;
  endpoint?: string;
  region: UiTuyaRegion;
  accessId: string;
  accessSecret?: string;
  hasAccessSecret?: boolean;
  hasTokenSession?: boolean;
  username?: string;
  uid: string;
  preferLocal: boolean;
  localDevices: UiTuyaLocalDeviceInput[];
}

export interface UiTuyaConfigPayload {
  enabled: boolean;
  mode: UiTuyaMode;
  userCode: string;
  endpoint?: string;
  region: UiTuyaRegion;
  accessId: string;
  accessSecret?: string;
  uid: string;
  preferLocal: boolean;
  localDevices: UiTuyaLocalDevicePayload[];
}

export interface UiMideaLocalDeviceInput {
  id: string;
  name: string;
  ip: string;
  port?: number;
  type: number;
  protocolVersion: 2 | 3;
  token?: string;
  key?: string;
  hasToken?: boolean;
  hasKey?: boolean;
  room?: string;
  model?: string;
}

export interface UiMideaLocalDevicePayload {
  id: string;
  name: string;
  ip: string;
  port: number;
  type: number;
  protocolVersion: 2 | 3;
  token?: string;
  key?: string;
  room?: string;
  model?: string;
}

export interface UiMideaFormState {
  enabled?: boolean;
  mode: UiMideaMode;
  cloudBrand: UiMideaBrand;
  account: string;
  password?: string;
  hasPassword?: boolean;
  useChinaServer: boolean;
  preferLocal: boolean;
  localDevices: UiMideaLocalDeviceInput[];
}

export interface UiMideaConfigPayload {
  enabled: boolean;
  mode: UiMideaMode;
  cloudBrand: UiMideaBrand;
  account: string;
  password?: string;
  useChinaServer: boolean;
  preferLocal: boolean;
  localDevices: UiMideaLocalDevicePayload[];
}

export interface UiDeyeInverterInput {
  id?: string;
  name: string;
  ip: string;
  port?: number;
  serial: number | string;
  slaveId?: number;
  room?: string;
}

export interface UiDeyeInverterPayload {
  id: string;
  name: string;
  ip: string;
  port: number;
  serial: number;
  slaveId: number;
  room?: string;
}

export interface UiDeyeFormState {
  enabled?: boolean;
  mode: UiDeyeMode;
  username: string;
  password?: string;
  hasPassword?: boolean;
  authToken?: string;
  hasAuthToken?: boolean;
  endpoint: string;
  solarmanInverters: UiDeyeInverterInput[];
}

export interface UiDeyeConfigPayload {
  enabled: boolean;
  mode: UiDeyeMode;
  username: string;
  password?: string;
  authToken?: string;
  endpoint: string;
  solarmanInverters: UiDeyeInverterPayload[];
}

export type ParsedLocalDevicesResult<T = Record<string, unknown>> =
  | { ok: true; devices: T[] }
  | { ok: false; devices: []; error: string };

export interface PlatformsPanelOptions {
  container: HTMLElement;
  onPlatformsChanged?: (platforms: UiPlatformStatus[]) => void;
  onToast?: (message: string, durationMs?: number) => void;
  onOpenMijiaLogin?: () => void;
  onMijiaDisconnect?: () => Promise<void> | void;
  apiGet?: <T>(url: string) => Promise<T>;
  apiPost?: <T>(url: string, body?: unknown) => Promise<T>;
  fetchImpl?: typeof fetch;
  qrPollIntervalMs?: number;
}

// ---------------------------------------------------------------------------
// Constants & Metadata
// ---------------------------------------------------------------------------

export const UI_PLATFORM_ORDER: readonly UiPlatformId[] = [
  "mijia",
  "tuya",
  "midea",
  "deye",
] as const;

export const DEFAULT_DEYE_ENDPOINT = "https://api.deye.com.cn/v3/enduser";

export const PLATFORM_DISPLAY_META: Readonly<Record<UiPlatformId, PlatformDisplayMeta>> = {
  mijia: {
    id: "mijia",
    badgeText: "米家",
    shortLabel: "米家",
    displayName: "小米米家 (MIoT)",
    color: "#00cc92",
    iconGlyph: "米",
    description: "原生 MIoT 云端协议，支持米家 App 扫码登录、全品类设备控制、小爱音箱与摄像机预览",
    reference: "Do1e/mijia-api & Xiaomi Home",
  },
  tuya: {
    id: "tuya",
    badgeText: "涂鸦",
    shortLabel: "涂鸦智能",
    displayName: "涂鸦智能 (Tuya / Smart Life)",
    color: "#ff6a00",
    iconGlyph: "涂",
    description: "支持 Home Assistant 扫码授权、Tuya IoT Cloud OpenAPI 与 LocalTuya 局域网直连",
    reference: "tuya-device-sharing-sdk & LocalTuya",
  },
  midea: {
    id: "midea",
    badgeText: "美的",
    shortLabel: "美的智能",
    displayName: "美的智能 (美的美居 / MSmartHome)",
    color: "#0092d8",
    iconGlyph: "美",
    description: "支持美的美居 / MSmartHome 云端发现与 M-Smart V2/V3 局域网直连控制空调、除湿机与风扇",
    reference: "midea_ac_lan & midea-beautiful-air",
  },
  deye: {
    id: "deye",
    badgeText: "德业",
    shortLabel: "德业智能",
    displayName: "德业智能 (Deye Smart / Solarman)",
    color: "#5b6ef5",
    iconGlyph: "德",
    description: "支持德业智能云（除湿机/空气净化器）与 Solarman V5 局域网光伏逆变器直连",
    reference: "Deye Cloud v3 & Solarman V5 (Modbus)",
  },
};

export interface MideaDeviceTypeOption {
  readonly code: number;
  readonly hex: string;
  readonly label: string;
}

export const MIDEA_DEVICE_TYPES: ReadonlyArray<MideaDeviceTypeOption> = [
  { code: 0xac, hex: "0xAC", label: "空调 (0xAC)" },
  { code: 0xa1, hex: "0xA1", label: "除湿机 (0xA1)" },
  { code: 0xfa, hex: "0xFA", label: "风扇 (0xFA)" },
  { code: 0xfc, hex: "0xFC", label: "空气净化器 (0xFC)" },
  { code: 0xe2, hex: "0xE2", label: "热水器 (0xE2)" },
  { code: 0xe3, hex: "0xE3", label: "燃气热水器 (0xE3)" },
  { code: 0xfd, hex: "0xFD", label: "加湿器 (0xFD)" },
  { code: 0xcc, hex: "0xCC", label: "中央空调 (0xCC)" },
];

const TUYA_MODES: ReadonlyArray<{ value: UiTuyaMode; label: string }> = [
  { value: "sharing", label: "Home Assistant 扫码登录 (推荐)" },
  { value: "openapi", label: "Tuya IoT Cloud OpenAPI" },
  { value: "local", label: "LocalTuya 局域网直连" },
  { value: "hybrid", label: "云端+局域网混合" },
];

const TUYA_REGIONS: ReadonlyArray<{ value: UiTuyaRegion; label: string }> = [
  { value: "cn", label: "中国区 (openapi.tuyacn.com)" },
  { value: "us", label: "美区 (openapi.tuyaus.com)" },
  { value: "eu", label: "欧区 (openapi.tuyaeu.com)" },
  { value: "in", label: "印度区 (openapi.tuyain.com)" },
];

const TUYA_VERSIONS: readonly UiTuyaLocalVersion[] = ["3.1", "3.3", "3.4", "3.5"] as const;

const MIDEA_MODES: ReadonlyArray<{ value: UiMideaMode; label: string }> = [
  { value: "hybrid", label: "云端发现 + 局域网直连 (推荐)" },
  { value: "cloud", label: "仅云端" },
  { value: "local", label: "仅局域网直连" },
];

const MIDEA_BRANDS: ReadonlyArray<{ value: UiMideaBrand; label: string }> = [
  { value: "meiju", label: "美的美居 (中国区)" },
  { value: "msmarthome", label: "MSmartHome" },
  { value: "nethomeplus", label: "NetHome Plus" },
  { value: "midea_air", label: "Midea Air" },
];

const DEYE_MODES: ReadonlyArray<{ value: UiDeyeMode; label: string }> = [
  { value: "cloud", label: "德业智能云 (除湿机/空净)" },
  { value: "solarman", label: "Solarman V5 局域网逆变器" },
  { value: "hybrid", label: "云端 + 逆变器混合" },
];

const SAFE_HEX_COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;
const EXTERNAL_DID_PREFIX_RE = /^(tuya|midea|deye):/;
const SECRET_PARAM_RE =
  /\b(access_?secret|access_?token|refresh_?token|auth_?token|password|passwd|local_?key|secret|token|key)\s*[:=]\s*([^\s,&;"']+)/gi;

const SAFE_SVG_TAGS = new Set([
  "svg",
  "rect",
  "path",
  "g",
  "circle",
  "polygon",
  "line",
  "polyline",
  "title",
]);

const SAFE_SVG_ATTRS = new Set([
  "xmlns",
  "viewbox",
  "width",
  "height",
  "fill",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "d",
  "x",
  "y",
  "rx",
  "ry",
  "cx",
  "cy",
  "r",
  "points",
  "x1",
  "y1",
  "x2",
  "y2",
  "shape-rendering",
  "role",
  "aria-label",
  "transform",
]);

// ---------------------------------------------------------------------------
// Pure Helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUiPlatformId(value: unknown): value is UiPlatformId {
  return value === "mijia" || value === "tuya" || value === "midea" || value === "deye";
}

function asNonEmptyTrimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function clampPort(value: unknown, fallback: number): number {
  const num = typeof value === "number" ? value : Number(String(value ?? "").trim());
  if (!Number.isFinite(num)) return fallback;
  const intVal = Math.trunc(num);
  return intVal >= 1 && intVal <= 65535 ? intVal : fallback;
}

function clampSlaveId(value: unknown, fallback = 1): number {
  const num = typeof value === "number" ? value : Number(String(value ?? "").trim());
  if (!Number.isFinite(num)) return fallback;
  const intVal = Math.trunc(num);
  return intVal >= 1 && intVal <= 247 ? intVal : fallback;
}

function parsePositiveSerial(value: unknown): number | null {
  if (typeof value === "number") {
    const intVal = Math.trunc(value);
    return Number.isSafeInteger(intVal) && intVal > 0 ? intVal : null;
  }
  if (typeof value === "string") {
    const cleaned = value.trim();
    if (!/^\d+$/.test(cleaned)) return null;
    const num = Number(cleaned);
    return Number.isSafeInteger(num) && num > 0 ? num : null;
  }
  return null;
}

function normalizeTuyaVersion(raw: unknown): UiTuyaLocalVersion {
  if (raw === "3.1" || raw === "3.3" || raw === "3.4" || raw === "3.5") {
    return raw;
  }
  if (typeof raw === "string") {
    const cleaned = raw.trim().replace(/^v/i, "");
    if (cleaned === "3.1" || cleaned === "3.3" || cleaned === "3.4" || cleaned === "3.5") {
      return cleaned;
    }
  }
  return "3.3";
}

function normalizeMideaProtocolVersion(raw: unknown): 2 | 3 {
  if (raw === 2) return 2;
  if (raw === 3) return 3;
  if (typeof raw === "string") {
    const cleaned = raw.trim().toLowerCase().replace(/^v/, "");
    if (cleaned === "2" || cleaned.startsWith("2.")) return 2;
  }
  return 3;
}

export function parseMideaTypeCode(raw: number | string | undefined): number {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const intVal = Math.trunc(raw);
    return intVal > 0 && intVal <= 0xff ? intVal : 0xac;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim().toLowerCase();
    if (!trimmed) return 0xac;
    if (trimmed.startsWith("0x")) {
      const parsed = Number.parseInt(trimmed.slice(2), 16);
      if (Number.isFinite(parsed) && parsed > 0 && parsed <= 0xff) return parsed;
    }
    if (/^[0-9a-f]{2}$/.test(trimmed) && /[a-f]/.test(trimmed)) {
      const parsed = Number.parseInt(trimmed, 16);
      if (Number.isFinite(parsed) && parsed > 0 && parsed <= 0xff) return parsed;
    }
    if (/^\d+$/.test(trimmed)) {
      const parsed = Number.parseInt(trimmed, 10);
      if (Number.isFinite(parsed) && parsed > 0 && parsed <= 0xff) return parsed;
    }
    // Common alias strings
    if (trimmed.includes("ac") || trimmed.includes("air_condition") || trimmed.includes("空调")) {
      return 0xac;
    }
    if (trimmed.includes("dehum") || trimmed.includes("除湿")) return 0xa1;
    if (trimmed.includes("fan") || trimmed.includes("风扇")) return 0xfa;
    if (trimmed.includes("purif") || trimmed.includes("净化")) return 0xfc;
    if (trimmed.includes("water") || trimmed.includes("热水")) return 0xe2;
    if (trimmed.includes("humid") || trimmed.includes("加湿")) return 0xfd;
  }
  return 0xac;
}

export function formatMideaTypeLabel(code: number): string {
  const found = MIDEA_DEVICE_TYPES.find((item) => item.code === code);
  if (found) return found.label;
  const hex = `0x${Math.max(0, Math.min(0xff, Math.trunc(code)))
    .toString(16)
    .toUpperCase()
    .padStart(2, "0")}`;
  return `美的设备 (${hex})`;
}

/**
 * 从设备对象的 `platform` 字段或 `did` 命名空间前缀推断所属平台。
 */
export function inferPlatformId(device: { did: string; platform?: string }): UiPlatformId {
  const explicit = typeof device.platform === "string" ? device.platform.trim().toLowerCase() : "";
  if (explicit === "tuya" || explicit === "midea" || explicit === "deye") {
    return explicit;
  }
  const did = typeof device.did === "string" ? device.did.trim() : "";
  const prefixMatch = EXTERNAL_DID_PREFIX_RE.exec(did);
  if (prefixMatch) {
    return prefixMatch[1] as UiPlatformId;
  }
  if (explicit === "mijia") {
    return "mijia";
  }
  return "mijia";
}

/**
 * 推断设备在卡片/列表中显示的平台徽章信息（米家 / 涂鸦 / 美的 / 德业）。
 */
export function platformBadgeInfo(device: { did: string; platform?: string }): PlatformBadgeInfo {
  const platform = inferPlatformId(device);
  const meta = PLATFORM_DISPLAY_META[platform];
  return {
    platform,
    badgeText: meta.badgeText,
    shortLabel: meta.shortLabel,
    color: meta.color,
    iconGlyph: meta.iconGlyph,
    isExternal: platform !== "mijia",
  };
}

/**
 * 脱敏错误文案，防止意外泄露令牌、密码或密钥。
 */
export function sanitizePlatformErrorMessage(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : error === null || error === undefined
          ? ""
          : String(error);
  const cleaned = raw
    .replace(/\s+/g, " ")
    .trim()
    .replace(SECRET_PARAM_RE, "$1=[REDACTED]");
  if (cleaned.length > 160) {
    return `${cleaned.slice(0, 159)}…`;
  }
  return cleaned;
}

export function platformStatusTone(status: UiPlatformStatus): {
  label: string;
  tone: "connected" | "disconnected" | "configuring" | "error";
} {
  if (status.state === "configuring") {
    return { label: "连接中", tone: "configuring" };
  }
  if (status.state === "error" || (!status.connected && Boolean(status.lastError?.trim()))) {
    return { label: "异常", tone: "error" };
  }
  if (status.connected || status.state === "connected") {
    return { label: "已连接", tone: "connected" };
  }
  return { label: "未接入", tone: "disconnected" };
}

/**
 * 格式化平台一行状态摘要，例如：
 * - `"已连接 · 4 台设备"`
 * - `"已连接 · 4 台设备 · 2 个场景"`
 * - `"未接入"`
 * - `"正在连接…"`
 * - `"连接异常：认证已过期"`
 */
export function formatPlatformSummaryLine(status: UiPlatformStatus): string {
  if (status.state === "configuring") {
    return "正在连接…";
  }
  const errText = sanitizePlatformErrorMessage(status.lastError ?? "");
  if (status.state === "error" || (!status.connected && errText)) {
    return errText ? `连接异常：${errText}` : "连接异常";
  }
  if (status.connected || status.state === "connected") {
    const devCount = Math.max(0, Math.trunc(Number(status.deviceCount) || 0));
    const sceneCount = SCENES_FEATURE_ENABLED
      ? Math.max(0, Math.trunc(Number(status.sceneCount) || 0))
      : 0;
    return sceneCount > 0
      ? `已连接 · ${devCount} 台设备 · ${sceneCount} 个场景`
      : `已连接 · ${devCount} 台设备`;
  }
  return "未接入";
}

function safeAccentColor(status: UiPlatformStatus): string {
  const candidate = typeof status.accentColor === "string" ? status.accentColor.trim() : "";
  if (SAFE_HEX_COLOR_RE.test(candidate)) {
    return candidate;
  }
  return PLATFORM_DISPLAY_META[status.id].color;
}

function defaultPlatformStatus(id: UiPlatformId): UiPlatformStatus {
  const meta = PLATFORM_DISPLAY_META[id];
  return {
    id,
    name: meta.badgeText,
    displayName: meta.displayName,
    badgeText: meta.badgeText,
    accentColor: meta.color,
    description: meta.description,
    reference: meta.reference,
    enabled: id === "mijia",
    connected: false,
    state: "disconnected",
    authMode: id === "mijia" ? "qr" : id === "tuya" ? "qr" : id === "midea" ? "hybrid" : "credentials",
    deviceCount: 0,
    sceneCount: 0,
    lastSyncAt: null,
    lastError: null,
    capabilities: {
      cloud: true,
      local: id !== "mijia",
      qrAuth: id === "mijia" || id === "tuya",
      credentialsAuth: id === "midea" || id === "deye",
      openApiAuth: id === "tuya",
      lanDiscovery: id === "tuya" || id === "midea",
      scenes: SCENES_FEATURE_ENABLED && (id === "mijia" || id === "tuya"),
    },
    configSummary: {},
  };
}

// ---------------------------------------------------------------------------
// Local Device Normalization, JSON Parsing & LAN Discovery Merge Helpers
// ---------------------------------------------------------------------------

export function normalizeTuyaLocalDevices(items: readonly unknown[]): UiTuyaLocalDeviceInput[] {
  const result: UiTuyaLocalDeviceInput[] = [];
  const indexById = new Map<string, number>();

  for (const raw of items) {
    if (!isRecord(raw)) continue;
    const id = asNonEmptyTrimmed(raw.id ?? raw.devId ?? raw.gwId);
    const ip = asNonEmptyTrimmed(raw.ip ?? raw.host);
    if (!id || !ip) continue;

    const name = asNonEmptyTrimmed(raw.name) || id;
    const port = clampPort(raw.port, 6668);
    const version = normalizeTuyaVersion(raw.version ?? raw.protocolVersion);
    const localKey = asNonEmptyTrimmed(raw.localKey ?? raw.local_key);
    const hasLocalKey = Boolean(raw.hasLocalKey) || localKey.length > 0;
    const category = asNonEmptyTrimmed(raw.category);
    const room = asNonEmptyTrimmed(raw.room);

    const entry: UiTuyaLocalDeviceInput = {
      id,
      name,
      ip,
      port,
      version,
      ...(localKey ? { localKey } : {}),
      ...(hasLocalKey ? { hasLocalKey: true } : {}),
      ...(category ? { category } : {}),
      ...(room ? { room } : {}),
    };

    const existingIdx = indexById.get(id);
    if (existingIdx !== undefined) {
      result[existingIdx] = entry;
    } else {
      indexById.set(id, result.length);
      result.push(entry);
    }
  }
  return result;
}

export function normalizeMideaLocalDevices(items: readonly unknown[]): UiMideaLocalDeviceInput[] {
  const result: UiMideaLocalDeviceInput[] = [];
  const indexById = new Map<string, number>();

  for (const raw of items) {
    if (!isRecord(raw)) continue;
    const rawId = raw.id ?? raw.deviceId;
    const id =
      typeof rawId === "number" && Number.isFinite(rawId)
        ? String(Math.trunc(rawId))
        : asNonEmptyTrimmed(rawId);
    const ip = asNonEmptyTrimmed(raw.ip ?? raw.host);
    if (!id || !ip) continue;

    const name = asNonEmptyTrimmed(raw.name) || `美的设备 ${id}`;
    const port = clampPort(raw.port, 6444);
    const type = parseMideaTypeCode(
      typeof raw.type === "number" || typeof raw.type === "string"
        ? raw.type
        : typeof raw.typeCode === "string"
          ? raw.typeCode
          : undefined,
    );
    const protocolVersion = normalizeMideaProtocolVersion(raw.protocolVersion ?? raw.version);
    const token = asNonEmptyTrimmed(raw.token);
    const key = asNonEmptyTrimmed(raw.key);
    const hasToken = Boolean(raw.hasToken) || token.length > 0;
    const hasKey = Boolean(raw.hasKey) || key.length > 0;
    const room = asNonEmptyTrimmed(raw.room);
    const model = asNonEmptyTrimmed(raw.model);

    const entry: UiMideaLocalDeviceInput = {
      id,
      name,
      ip,
      port,
      type,
      protocolVersion,
      ...(token ? { token } : {}),
      ...(key ? { key } : {}),
      ...(hasToken ? { hasToken: true } : {}),
      ...(hasKey ? { hasKey: true } : {}),
      ...(room ? { room } : {}),
      ...(model ? { model } : {}),
    };

    const existingIdx = indexById.get(id);
    if (existingIdx !== undefined) {
      result[existingIdx] = entry;
    } else {
      indexById.set(id, result.length);
      result.push(entry);
    }
  }
  return result;
}

export function normalizeDeyeInverters(items: readonly unknown[]): UiDeyeInverterInput[] {
  const result: UiDeyeInverterInput[] = [];
  const indexByKey = new Map<string, number>();

  for (const raw of items) {
    if (!isRecord(raw)) continue;
    const ip = asNonEmptyTrimmed(raw.ip ?? raw.host);
    const serial = parsePositiveSerial(raw.serial ?? raw.loggerSerial);
    if (!ip || serial === null) continue;

    const id = asNonEmptyTrimmed(raw.id) || `inv_${serial}`;
    const name = asNonEmptyTrimmed(raw.name) || `德业逆变器 ${serial}`;
    const port = clampPort(raw.port, 8899);
    const slaveId = clampSlaveId(raw.slaveId ?? raw.slave_id, 1);
    const room = asNonEmptyTrimmed(raw.room);

    const entry: UiDeyeInverterInput = {
      id,
      name,
      ip,
      port,
      serial,
      slaveId,
      ...(room ? { room } : {}),
    };

    const dedupeKey = `${serial}@${ip}`;
    const existingIdx = indexByKey.get(dedupeKey);
    if (existingIdx !== undefined) {
      result[existingIdx] = entry;
    } else {
      indexByKey.set(dedupeKey, result.length);
      result.push(entry);
    }
  }
  return result;
}

export function parseLocalDevicesJson(
  jsonText: string,
  platform: "tuya",
): ParsedLocalDevicesResult<UiTuyaLocalDeviceInput>;
export function parseLocalDevicesJson(
  jsonText: string,
  platform: "midea",
): ParsedLocalDevicesResult<UiMideaLocalDeviceInput>;
export function parseLocalDevicesJson(
  jsonText: string,
  platform: "deye",
): ParsedLocalDevicesResult<UiDeyeInverterInput>;
export function parseLocalDevicesJson(
  jsonText: string,
): ParsedLocalDevicesResult<Record<string, unknown>>;
export function parseLocalDevicesJson(
  jsonText: string,
  platform?: "tuya" | "midea" | "deye",
): ParsedLocalDevicesResult<unknown> {
  const trimmed = typeof jsonText === "string" ? jsonText.trim() : "";
  if (!trimmed) {
    return { ok: true, devices: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, devices: [], error: "本地设备列表 JSON 格式无效" };
  }

  let rawList: unknown[];
  if (Array.isArray(parsed)) {
    rawList = parsed;
  } else if (isRecord(parsed)) {
    const candidate =
      parsed.localDevices ?? parsed.devices ?? parsed.solarmanInverters ?? parsed.inverters;
    if (Array.isArray(candidate)) {
      rawList = candidate;
    } else if (typeof parsed.ip === "string" || typeof parsed.id === "string") {
      rawList = [parsed];
    } else {
      return { ok: false, devices: [], error: "JSON 须为设备对象数组" };
    }
  } else {
    return { ok: false, devices: [], error: "JSON 须为设备对象数组" };
  }

  if (platform === "tuya") {
    return { ok: true, devices: normalizeTuyaLocalDevices(rawList) };
  }
  if (platform === "midea") {
    return { ok: true, devices: normalizeMideaLocalDevices(rawList) };
  }
  if (platform === "deye") {
    return { ok: true, devices: normalizeDeyeInverters(rawList) };
  }

  const plainEntries = rawList.filter(isRecord);
  return { ok: true, devices: plainEntries };
}

/**
 * 将局域网发现到的涂鸦设备合并进本地设备列表（纯函数；若已存在同 ID 设备则保留既有 Local Key）。
 */
export function mergeDiscoveredTuyaDevice(
  existing: readonly UiTuyaLocalDeviceInput[],
  discovered: UiDiscoveredLocalDevice,
): UiTuyaLocalDeviceInput[] {
  const id = asNonEmptyTrimmed(discovered.id);
  const ip = asNonEmptyTrimmed(discovered.ip);
  if (!id || !ip) return [...existing];

  const version = normalizeTuyaVersion(discovered.protocolVersion);
  const port = clampPort(discovered.port, 6668);
  const fallbackName = asNonEmptyTrimmed(discovered.name) || `涂鸦设备 ${id.slice(-6)}`;

  const next = existing.map((item) => ({ ...item }));
  const idx = next.findIndex((item) => item.id.trim() === id);
  if (idx >= 0) {
    const prev = next[idx]!;
    next[idx] = {
      ...prev,
      id,
      ip,
      port,
      version,
      name: prev.name.trim() ? prev.name : fallbackName,
    };
    return next;
  }

  next.push({
    id,
    name: fallbackName,
    ip,
    port,
    version,
    localKey: "",
    hasLocalKey: false,
  });
  return next;
}

/**
 * 将局域网发现到的美的设备合并进本地设备列表（纯函数；若已存在同 ID 设备则保留既有 Token/Key）。
 */
export function mergeDiscoveredMideaDevice(
  existing: readonly UiMideaLocalDeviceInput[],
  discovered: UiDiscoveredLocalDevice,
): UiMideaLocalDeviceInput[] {
  const id = asNonEmptyTrimmed(discovered.id);
  const ip = asNonEmptyTrimmed(discovered.ip);
  if (!id || !ip) return [...existing];

  const port = clampPort(discovered.port, 6444);
  const type = parseMideaTypeCode(discovered.typeCode);
  const protocolVersion = normalizeMideaProtocolVersion(discovered.protocolVersion);
  const fallbackName = asNonEmptyTrimmed(discovered.name) || `美的设备 ${id.slice(-6)}`;
  const model = asNonEmptyTrimmed(discovered.model);

  const next = existing.map((item) => ({ ...item }));
  const idx = next.findIndex((item) => item.id.trim() === id);
  if (idx >= 0) {
    const prev = next[idx]!;
    next[idx] = {
      ...prev,
      id,
      ip,
      port,
      type: discovered.typeCode ? type : prev.type,
      protocolVersion,
      name: prev.name.trim() ? prev.name : fallbackName,
      ...(model ? { model } : {}),
    };
    return next;
  }

  next.push({
    id,
    name: fallbackName,
    ip,
    port,
    type,
    protocolVersion,
    token: "",
    key: "",
    hasToken: false,
    hasKey: false,
    ...(model ? { model } : {}),
  });
  return next;
}

/**
 * 将发现到的 Solarman V5 逆变器合并进德业本地逆变器列表（纯函数）。
 */
export function mergeDiscoveredDeyeInverter(
  existing: readonly UiDeyeInverterInput[],
  discovered: UiDiscoveredLocalDevice,
): UiDeyeInverterInput[] {
  const ip = asNonEmptyTrimmed(discovered.ip);
  const metaSerial = isRecord(discovered.meta) ? discovered.meta.serial : undefined;
  const serial = parsePositiveSerial(metaSerial ?? discovered.id);
  if (!ip || serial === null) return [...existing];

  const id = `inv_${serial}`;
  const port = clampPort(discovered.port, 8899);
  const fallbackName = asNonEmptyTrimmed(discovered.name) || `德业逆变器 ${serial}`;

  const next = existing.map((item) => ({ ...item }));
  const idx = next.findIndex((item) => parsePositiveSerial(item.serial) === serial);
  if (idx >= 0) {
    const prev = next[idx]!;
    next[idx] = {
      ...prev,
      id: prev.id?.trim() || id,
      ip,
      port,
      serial,
      name: prev.name.trim() ? prev.name : fallbackName,
    };
    return next;
  }

  next.push({
    id,
    name: fallbackName,
    ip,
    port,
    serial,
    slaveId: 1,
  });
  return next;
}

// ---------------------------------------------------------------------------
// Pure Config Payload Builders (Omitting Blank Secrets!)
// ---------------------------------------------------------------------------

export function buildTuyaConfigPayload(form: UiTuyaFormState): UiTuyaConfigPayload {
  const mode: UiTuyaMode =
    form.mode === "sharing" ||
    form.mode === "openapi" ||
    form.mode === "local" ||
    form.mode === "hybrid"
      ? form.mode
      : "sharing";
  const region: UiTuyaRegion =
    form.region === "cn" || form.region === "us" || form.region === "eu" || form.region === "in"
      ? form.region
      : "cn";

  const localDevices: UiTuyaLocalDevicePayload[] = [];
  const seenIds = new Map<string, number>();

  for (const row of form.localDevices) {
    const id = asNonEmptyTrimmed(row.id);
    const ip = asNonEmptyTrimmed(row.ip);
    if (!id || !ip) continue;

    const name = asNonEmptyTrimmed(row.name) || id;
    const port = clampPort(row.port, 6668);
    const version = normalizeTuyaVersion(row.version);
    const localKey = asNonEmptyTrimmed(row.localKey);
    const category = asNonEmptyTrimmed(row.category);
    const room = asNonEmptyTrimmed(row.room);

    const entry: UiTuyaLocalDevicePayload = {
      id,
      name,
      ip,
      port,
      version,
      ...(localKey ? { localKey } : {}),
      ...(category ? { category } : {}),
      ...(room ? { room } : {}),
    };

    const existingIdx = seenIds.get(id);
    if (existingIdx !== undefined) {
      localDevices[existingIdx] = entry;
    } else {
      seenIds.set(id, localDevices.length);
      localDevices.push(entry);
    }
  }

  const endpoint = asNonEmptyTrimmed(form.endpoint);
  const accessSecret = asNonEmptyTrimmed(form.accessSecret);

  const payload: UiTuyaConfigPayload = {
    enabled: form.enabled ?? true,
    mode,
    userCode: asNonEmptyTrimmed(form.userCode),
    region,
    accessId: asNonEmptyTrimmed(form.accessId),
    uid: asNonEmptyTrimmed(form.uid),
    preferLocal: form.preferLocal ?? (mode === "local" || mode === "hybrid"),
    localDevices,
  };

  if (endpoint) {
    payload.endpoint = endpoint;
  }
  if (accessSecret) {
    payload.accessSecret = accessSecret;
  }

  return payload;
}

export function buildMideaConfigPayload(form: UiMideaFormState): UiMideaConfigPayload {
  const mode: UiMideaMode =
    form.mode === "cloud" || form.mode === "local" || form.mode === "hybrid"
      ? form.mode
      : "hybrid";
  const cloudBrand: UiMideaBrand =
    form.cloudBrand === "meiju" ||
    form.cloudBrand === "msmarthome" ||
    form.cloudBrand === "nethomeplus" ||
    form.cloudBrand === "midea_air"
      ? form.cloudBrand
      : "meiju";

  const localDevices: UiMideaLocalDevicePayload[] = [];
  const seenIds = new Map<string, number>();

  for (const row of form.localDevices) {
    const id = asNonEmptyTrimmed(row.id);
    const ip = asNonEmptyTrimmed(row.ip);
    if (!id || !ip) continue;

    const name = asNonEmptyTrimmed(row.name) || `美的设备 ${id}`;
    const port = clampPort(row.port, 6444);
    const type = parseMideaTypeCode(row.type);
    const protocolVersion = normalizeMideaProtocolVersion(row.protocolVersion);
    const token = asNonEmptyTrimmed(row.token);
    const key = asNonEmptyTrimmed(row.key);
    const room = asNonEmptyTrimmed(row.room);
    const model = asNonEmptyTrimmed(row.model);

    const entry: UiMideaLocalDevicePayload = {
      id,
      name,
      ip,
      port,
      type,
      protocolVersion,
      ...(token ? { token } : {}),
      ...(key ? { key } : {}),
      ...(room ? { room } : {}),
      ...(model ? { model } : {}),
    };

    const existingIdx = seenIds.get(id);
    if (existingIdx !== undefined) {
      localDevices[existingIdx] = entry;
    } else {
      seenIds.set(id, localDevices.length);
      localDevices.push(entry);
    }
  }

  const passwordRaw = typeof form.password === "string" ? form.password : "";
  const hasNonBlankPassword = passwordRaw.trim().length > 0;

  const payload: UiMideaConfigPayload = {
    enabled: form.enabled ?? true,
    mode,
    cloudBrand,
    account: asNonEmptyTrimmed(form.account),
    useChinaServer: form.useChinaServer ?? true,
    preferLocal: form.preferLocal ?? mode !== "cloud",
    localDevices,
  };

  if (hasNonBlankPassword) {
    payload.password = passwordRaw;
  }

  return payload;
}

export function buildDeyeConfigPayload(form: UiDeyeFormState): UiDeyeConfigPayload {
  const mode: UiDeyeMode =
    form.mode === "cloud" || form.mode === "solarman" || form.mode === "hybrid"
      ? form.mode
      : "cloud";

  const solarmanInverters: UiDeyeInverterPayload[] = [];
  const seenKey = new Map<string, number>();

  for (const row of form.solarmanInverters) {
    const ip = asNonEmptyTrimmed(row.ip);
    const serial = parsePositiveSerial(row.serial);
    if (!ip || serial === null) continue;

    const id = asNonEmptyTrimmed(row.id) || `inv_${serial}`;
    const name = asNonEmptyTrimmed(row.name) || `德业逆变器 ${serial}`;
    const port = clampPort(row.port, 8899);
    const slaveId = clampSlaveId(row.slaveId, 1);
    const room = asNonEmptyTrimmed(row.room);

    const entry: UiDeyeInverterPayload = {
      id,
      name,
      ip,
      port,
      serial,
      slaveId,
      ...(room ? { room } : {}),
    };

    const dedupeKey = `${serial}@${ip}`;
    const existingIdx = seenKey.get(dedupeKey);
    if (existingIdx !== undefined) {
      solarmanInverters[existingIdx] = entry;
    } else {
      seenKey.set(dedupeKey, solarmanInverters.length);
      solarmanInverters.push(entry);
    }
  }

  const endpoint = asNonEmptyTrimmed(form.endpoint) || DEFAULT_DEYE_ENDPOINT;
  const passwordRaw = typeof form.password === "string" ? form.password : "";
  const authToken = asNonEmptyTrimmed(form.authToken);

  const payload: UiDeyeConfigPayload = {
    enabled: form.enabled ?? true,
    mode,
    username: asNonEmptyTrimmed(form.username),
    endpoint,
    solarmanInverters,
  };

  if (passwordRaw.trim().length > 0) {
    payload.password = passwordRaw;
  }
  if (authToken) {
    payload.authToken = authToken;
  }

  return payload;
}

// ---------------------------------------------------------------------------
// Config Summary -> Form State Hydrators
// ---------------------------------------------------------------------------

export function tuyaFormStateFromSummary(
  summary: Record<string, unknown> | undefined,
): UiTuyaFormState {
  const rec = isRecord(summary) ? summary : {};
  const mode = rec.mode;
  const region = rec.region;
  return {
    enabled: typeof rec.enabled === "boolean" ? rec.enabled : false,
    mode:
      mode === "sharing" || mode === "openapi" || mode === "local" || mode === "hybrid"
        ? mode
        : "sharing",
    userCode: asNonEmptyTrimmed(rec.userCode),
    endpoint: asNonEmptyTrimmed(rec.endpoint),
    region:
      region === "cn" || region === "us" || region === "eu" || region === "in" ? region : "cn",
    accessId: asNonEmptyTrimmed(rec.accessId),
    accessSecret: "",
    hasAccessSecret: Boolean(rec.hasAccessSecret),
    hasTokenSession: Boolean(rec.hasTokenSession),
    username: asNonEmptyTrimmed(rec.username),
    uid: asNonEmptyTrimmed(rec.uid),
    preferLocal: typeof rec.preferLocal === "boolean" ? rec.preferLocal : true,
    localDevices: Array.isArray(rec.localDevices)
      ? normalizeTuyaLocalDevices(rec.localDevices)
      : [],
  };
}

export function mideaFormStateFromSummary(
  summary: Record<string, unknown> | undefined,
): UiMideaFormState {
  const rec = isRecord(summary) ? summary : {};
  const mode = rec.mode;
  const brand = rec.cloudBrand;
  return {
    enabled: typeof rec.enabled === "boolean" ? rec.enabled : false,
    mode: mode === "cloud" || mode === "local" || mode === "hybrid" ? mode : "hybrid",
    cloudBrand:
      brand === "meiju" ||
      brand === "msmarthome" ||
      brand === "nethomeplus" ||
      brand === "midea_air"
        ? brand
        : "meiju",
    account: asNonEmptyTrimmed(rec.account),
    password: "",
    hasPassword: Boolean(rec.hasPassword),
    useChinaServer: typeof rec.useChinaServer === "boolean" ? rec.useChinaServer : true,
    preferLocal: typeof rec.preferLocal === "boolean" ? rec.preferLocal : true,
    localDevices: Array.isArray(rec.localDevices)
      ? normalizeMideaLocalDevices(rec.localDevices)
      : [],
  };
}

export function deyeFormStateFromSummary(
  summary: Record<string, unknown> | undefined,
): UiDeyeFormState {
  const rec = isRecord(summary) ? summary : {};
  const mode = rec.mode;
  return {
    enabled: typeof rec.enabled === "boolean" ? rec.enabled : false,
    mode: mode === "cloud" || mode === "solarman" || mode === "hybrid" ? mode : "cloud",
    username: asNonEmptyTrimmed(rec.username),
    password: "",
    hasPassword: Boolean(rec.hasPassword),
    authToken: "",
    hasAuthToken: Boolean(rec.hasAuthToken),
    endpoint: asNonEmptyTrimmed(rec.endpoint) || DEFAULT_DEYE_ENDPOINT,
    solarmanInverters: Array.isArray(rec.solarmanInverters)
      ? normalizeDeyeInverters(rec.solarmanInverters)
      : [],
  };
}

// ---------------------------------------------------------------------------
// Safe SVG Sanitizer (DOMParser + Whitelist, Zero innerHTML)
// ---------------------------------------------------------------------------

function sanitizeSvgNode(doc: Document, source: Element): SVGElement | null {
  const tag = source.tagName.toLowerCase();
  if (!SAFE_SVG_TAGS.has(tag)) return null;

  const clean = doc.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const attr of Array.from(source.attributes)) {
    const lowerName = attr.name.toLowerCase();
    if (lowerName === "xmlns" || lowerName.startsWith("xmlns:")) continue;
    if (!SAFE_SVG_ATTRS.has(lowerName)) continue;
    if (lowerName.startsWith("on")) continue;
    const val = attr.value;
    if (/javascript\s*:/i.test(val)) continue;
    clean.setAttribute(attr.name, val);
  }
  for (const child of Array.from(source.children)) {
    const cleanChild = sanitizeSvgNode(doc, child);
    if (cleanChild) {
      clean.appendChild(cleanChild);
    }
  }
  if (tag === "title" && source.textContent) {
    clean.textContent = source.textContent;
  }
  return clean;
}

function renderSafeQrInto(container: HTMLElement, qrContent: string, fallbackSvg?: string): void {
  container.replaceChildren();
  let svgMarkup = "";
  if (qrContent.trim()) {
    try {
      svgMarkup = renderQrSvg(qrContent.trim(), 196, "M");
    } catch {
      svgMarkup = fallbackSvg ?? "";
    }
  } else if (fallbackSvg) {
    svgMarkup = fallbackSvg;
  }

  if (!svgMarkup || typeof DOMParser === "undefined") {
    const fallback = document.createElement("span");
    fallback.className = "pf-qr-placeholder";
    fallback.textContent = "二维码渲染失败";
    container.appendChild(fallback);
    return;
  }

  const parser = new DOMParser();
  const parsedDoc = parser.parseFromString(svgMarkup, "image/svg+xml");
  const svgEl = parsedDoc.querySelector("svg");
  if (!svgEl) {
    const fallback = document.createElement("span");
    fallback.className = "pf-qr-placeholder";
    fallback.textContent = "二维码格式异常";
    container.appendChild(fallback);
    return;
  }

  const sanitized = sanitizeSvgNode(document, svgEl);
  if (sanitized) {
    container.appendChild(sanitized);
  } else {
    const fallback = document.createElement("span");
    fallback.className = "pf-qr-placeholder";
    fallback.textContent = "二维码校验未通过";
    container.appendChild(fallback);
  }
}

// ---------------------------------------------------------------------------
// Scoped Panel Stylesheet (CSS Variables Only — Light & Dark Theme Ready)
// ---------------------------------------------------------------------------

const PANEL_STYLE_ID = "md-platforms-panel-styles";
const PANEL_STYLES_CSS = `
.pf-root {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.pf-topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 2px 2px 0 2px;
}

.pf-topbar-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.pf-topbar-title {
  font-size: 13px;
  font-weight: 700;
  color: var(--c-theme-dim);
  letter-spacing: 0.2px;
}

.pf-topbar-sub {
  font-size: 11.5px;
  color: var(--c-text-secondary);
}

.pf-overview-strip {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
}

@media (max-width: 660px) {
  .pf-overview-strip {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

.pf-overview-tile {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 11px;
  border-radius: 10px;
  border: 1px solid var(--c-line);
  background: var(--c-card);
  text-align: left;
  transition: border-color 0.14s ease, background 0.14s ease, transform 0.12s ease;
}

.pf-overview-tile:hover {
  background: var(--c-card-hover);
  border-color: var(--c-card-border-hover);
}

.pf-overview-tile.is-expanded {
  border-color: var(--c-accent-border);
  background: var(--c-card-hover);
}

.pf-overview-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}

.pf-brand-chip {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}

.pf-glyph {
  width: 24px;
  height: 24px;
  border-radius: 7px;
  background: var(--platform-accent, var(--c-theme));
  color: #ffffff;
  font-size: 12px;
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.pf-glyph-lg {
  width: 30px;
  height: 30px;
  border-radius: 8px;
  font-size: 13.5px;
}

.pf-overview-name {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--c-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pf-overview-meta {
  font-size: 11px;
  color: var(--c-text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pf-status-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 10.5px;
  font-weight: 600;
  border: 1px solid var(--c-line);
  background: var(--c-surface);
  color: var(--c-text-secondary);
  flex-shrink: 0;
}

.pf-status-pill.is-connected {
  color: var(--c-online);
  background: var(--c-accent-surface);
  border-color: var(--c-accent-border);
}

.pf-status-pill.is-error {
  color: var(--c-error-text);
  background: rgba(224, 96, 96, 0.12);
  border-color: rgba(224, 96, 96, 0.38);
}

.pf-status-pill.is-configuring {
  color: var(--c-warn-text);
  background: var(--c-warn-bg);
  border-color: var(--c-warn-border);
}

.pf-cards-stack {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.pf-card {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 0;
  padding: 0;
  border: 1px solid var(--c-line);
  overflow: hidden;
}

.pf-card.is-expanded {
  border-color: var(--c-card-border-hover);
}

.pf-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 14px;
  background: transparent;
  border: none;
  width: 100%;
  text-align: left;
  transition: background 0.14s ease;
}

.pf-card-header:hover {
  background: var(--c-card-hover);
}

.pf-card-head-left {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  flex: 1;
}

.pf-card-titles {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.pf-card-title-row {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
}

.pf-card-title {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--c-text-primary);
}

.pf-card-ref {
  font-size: 10.5px;
  color: var(--c-text-muted);
  padding: 1px 6px;
  border-radius: 5px;
  background: var(--c-surface);
  border: 1px solid var(--c-line);
}

.pf-card-summary {
  font-size: 11.5px;
  color: var(--c-text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pf-card-head-right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.pf-toggle-label {
  font-size: 11.5px;
  color: var(--c-theme-dim);
  font-weight: 500;
}

.pf-error-banner {
  margin: 0 14px 10px 14px;
  padding: 8px 10px;
  border-radius: 8px;
  font-size: 11.5px;
  line-height: 1.45;
  color: var(--c-error-text);
  background: rgba(224, 96, 96, 0.1);
  border: 1px solid rgba(224, 96, 96, 0.3);
  word-break: break-word;
}

.pf-card-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px 14px 14px 14px;
  border-top: 1px solid var(--c-line);
}

.pf-card-desc {
  font-size: 11.5px;
  color: var(--c-text-secondary);
  line-height: 1.45;
}

.pf-section-box {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 11px 12px;
  border-radius: 9px;
  background: var(--c-surface);
  border: 1px solid var(--c-line);
}

.pf-section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}

.pf-section-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--c-text-primary);
}

.pf-form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

@media (max-width: 600px) {
  .pf-form-grid {
    grid-template-columns: 1fr;
  }
}

.pf-field {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}

.pf-field-full {
  grid-column: 1 / -1;
}

.pf-field-label-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}

.pf-field-label {
  font-size: 11.5px;
  font-weight: 500;
  color: var(--c-text-secondary);
}

.pf-saved-pill {
  font-size: 10.5px;
  font-weight: 600;
  color: var(--c-theme-dim);
  background: var(--c-accent-surface);
  border: 1px solid var(--c-accent-border);
  border-radius: 999px;
  padding: 1px 7px;
  flex-shrink: 0;
}

.pf-hint {
  font-size: 11px;
  color: var(--c-text-muted);
  line-height: 1.45;
}

.pf-switch-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 4px 0;
}

.pf-switch-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.pf-inline-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.pf-qr-panel {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 10px 12px;
  border-radius: 9px;
  background: var(--c-card);
  border: 1px solid var(--c-accent-border);
  flex-wrap: wrap;
}

.pf-qr-box {
  width: 168px;
  height: 168px;
  padding: 8px;
  border-radius: 10px;
  background: #ffffff;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.16);
}

.pf-qr-box svg {
  width: 100%;
  height: 100%;
  display: block;
}

.pf-qr-placeholder {
  font-size: 12px;
  color: #555555;
  text-align: center;
}

.pf-qr-info {
  flex: 1;
  min-width: 180px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.pf-qr-hint {
  font-size: 12.5px;
  font-weight: 500;
  color: var(--c-text-primary);
  line-height: 1.45;
}

.pf-qr-countdown {
  font-size: 11.5px;
  color: var(--c-theme-dim);
  font-variant-numeric: tabular-nums;
}

.pf-qr-status-err {
  font-size: 11.5px;
  color: var(--c-error-text);
}

.pf-discovered-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.pf-discovered-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--c-card);
  border: 1px solid var(--c-line);
}

.pf-discovered-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.pf-discovered-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--c-text-primary);
}

.pf-discovered-sub {
  font-size: 11px;
  color: var(--c-text-secondary);
  font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
}

.pf-local-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.pf-local-row {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border-radius: 8px;
  background: var(--c-card);
  border: 1px solid var(--c-line);
}

.pf-local-row-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  align-items: end;
}

.pf-local-row-grid-4 {
  grid-template-columns: repeat(4, minmax(0, 1fr));
}

.pf-local-row-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.pf-local-row-idx {
  font-size: 11px;
  font-weight: 600;
  color: var(--c-text-muted);
}

.pf-empty-local {
  font-size: 11.5px;
  color: var(--c-text-muted);
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px dashed var(--c-line);
  text-align: center;
}

.pf-actions-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding-top: 4px;
  flex-wrap: wrap;
}

.pf-actions-group {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.pf-danger-btn {
  color: var(--c-error-text);
}

.pf-mijia-stats {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}

.pf-stat-box {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 9px 11px;
  border-radius: 8px;
  background: var(--c-surface);
  border: 1px solid var(--c-line);
}

.pf-stat-label {
  font-size: 11px;
  color: var(--c-text-secondary);
}

.pf-stat-val {
  font-size: 13px;
  font-weight: 600;
  color: var(--c-text-primary);
}
`;

function ensurePanelStyles(): void {
  if (typeof document === "undefined" || !document.head) return;
  if (document.getElementById(PANEL_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = PANEL_STYLE_ID;
  style.textContent = PANEL_STYLES_CSS;
  document.head.appendChild(style);
}

// ---------------------------------------------------------------------------
// Internal REST Response Shapes
// ---------------------------------------------------------------------------

interface PlatformsListResponse {
  ok?: boolean;
  platforms?: UiPlatformStatus[];
}

interface PlatformMutationResponse {
  ok?: boolean;
  platform?: UiPlatformStatus;
  platforms?: UiPlatformStatus[];
  message?: string;
}

interface PlatformQrBeginResponse {
  ok?: boolean;
  session?: UiPlatformQrSession;
}

interface PlatformQrPollResponse {
  ok?: boolean;
  result?: UiPlatformQrResult;
  platforms?: UiPlatformStatus[];
}

interface PlatformDiscoverResponse {
  ok?: boolean;
  devices?: UiDiscoveredLocalDevice[];
}

interface ActiveTuyaQrState {
  session: UiPlatformQrSession;
  statusMessage: string;
  errorMessage: string | null;
}

interface CardDomRefs {
  card: HTMLElement;
  headerBtn: HTMLButtonElement;
  glyph: HTMLElement;
  summaryEl: HTMLElement;
  pillEl: HTMLElement;
  toggleLabel: HTMLElement;
  errorEl: HTMLElement;
  bodyEl: HTMLElement;
}

interface OverviewDomRefs {
  tile: HTMLButtonElement;
  glyph: HTMLElement;
  pillEl: HTMLElement;
  metaEl: HTMLElement;
}

// ---------------------------------------------------------------------------
// PlatformsPanelController
// ---------------------------------------------------------------------------

export class PlatformsPanelController {
  private readonly options: PlatformsPanelOptions;
  private readonly container: HTMLElement;
  private readonly qrPollIntervalMs: number;

  private statuses = new Map<UiPlatformId, UiPlatformStatus>();
  private expandedPlatform: UiPlatformId | null = "tuya";
  private dirtyFlags: Record<UiPlatformId, boolean> = {
    mijia: false,
    tuya: false,
    midea: false,
    deye: false,
  };
  private hydratedFlags: Record<UiPlatformId, boolean> = {
    mijia: false,
    tuya: false,
    midea: false,
    deye: false,
  };
  private busyAction: Record<UiPlatformId, string | null> = {
    mijia: null,
    tuya: null,
    midea: null,
    deye: null,
  };
  private refreshingAll = false;

  private tuyaForm: UiTuyaFormState = tuyaFormStateFromSummary(undefined);
  private mideaForm: UiMideaFormState = mideaFormStateFromSummary(undefined);
  private deyeForm: UiDeyeFormState = deyeFormStateFromSummary(undefined);

  private discoveredDevices: Record<"tuya" | "midea", UiDiscoveredLocalDevice[]> = {
    tuya: [],
    midea: [],
  };

  private activeTuyaQr: ActiveTuyaQrState | null = null;
  private qrSessionGen = 0;
  private qrPollTimer: ReturnType<typeof setTimeout> | null = null;
  private qrCountdownTimer: ReturnType<typeof setInterval> | null = null;
  private qrCountdownEl: HTMLElement | null = null;
  private qrPollInFlight = false;
  private qrTransientErrors = 0;

  private disposed = false;
  private refreshBtn: HTMLButtonElement | null = null;
  private overviewRefs = new Map<UiPlatformId, OverviewDomRefs>();
  private cardRefs = new Map<UiPlatformId, CardDomRefs>();

  constructor(options: PlatformsPanelOptions) {
    this.options = options;
    this.container = options.container;
    this.qrPollIntervalMs = Math.max(500, options.qrPollIntervalMs ?? 3000);

    for (const id of UI_PLATFORM_ORDER) {
      this.statuses.set(id, defaultPlatformStatus(id));
    }

    ensurePanelStyles();
    this.mountSkeleton();
    this.syncAllHeadersAndOverview();
    this.renderAllCardBodies(true);
  }

  // ---------- Public Lifecycle API ----------

  getPlatforms(): UiPlatformStatus[] {
    return UI_PLATFORM_ORDER.map((id) => this.statuses.get(id) ?? defaultPlatformStatus(id));
  }

  expandPlatform(id: UiPlatformId): void {
    if (this.disposed) return;
    this.expandedPlatform = id;
    this.syncAllHeadersAndOverview();
    this.renderAllCardBodies(false);
  }

  update(platforms: UiPlatformStatus[]): void {
    if (this.disposed) return;
    const incoming = new Map<UiPlatformId, UiPlatformStatus>();
    for (const st of platforms) {
      if (isUiPlatformId(st.id)) {
        incoming.set(st.id, st);
      }
    }

    for (const id of UI_PLATFORM_ORDER) {
      const nextStatus = incoming.get(id);
      if (!nextStatus) continue;
      this.statuses.set(id, nextStatus);

      const shouldHydrate = !this.dirtyFlags[id] || !this.hydratedFlags[id];
      if (shouldHydrate) {
        this.hydrateFormFromStatus(id, nextStatus);
        this.hydratedFlags[id] = true;
        this.renderCardBody(id, false);
      }
    }

    this.syncAllHeadersAndOverview();
  }

  async refresh(): Promise<UiPlatformStatus[]> {
    if (this.disposed) return this.getPlatforms();
    this.refreshingAll = true;
    this.updateRefreshBtnState();
    try {
      const res = await this.apiGet<PlatformsListResponse>("/api/platforms");
      if (this.disposed) return this.getPlatforms();
      const list = Array.isArray(res?.platforms) ? res.platforms : [];
      if (list.length > 0) {
        this.update(list);
      }
      const snapshot = this.getPlatforms();
      this.options.onPlatformsChanged?.(snapshot);
      return snapshot;
    } catch (err) {
      if (!this.disposed) {
        this.notifyToast(`刷新平台状态失败：${sanitizePlatformErrorMessage(err)}`, 3200);
      }
      return this.getPlatforms();
    } finally {
      this.refreshingAll = false;
      this.updateRefreshBtnState();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.stopQrPolling();
    this.qrCountdownEl = null;
  }

  // ---------- Network Helpers ----------

  private async requestJson<T>(method: "GET" | "POST", url: string, body?: unknown): Promise<T> {
    if (method === "GET" && this.options.apiGet) {
      return await this.options.apiGet<T>(url);
    }
    if (method === "POST" && this.options.apiPost) {
      return await this.options.apiPost<T>(url, body ?? {});
    }

    const fetchFn = this.options.fetchImpl ?? globalThis.fetch;
    if (typeof fetchFn !== "function") {
      throw new Error("当前环境缺少 fetch 实现");
    }

    const init: RequestInit = {
      method,
      headers: { Accept: "application/json" },
      cache: "no-store",
    };
    if (body !== undefined) {
      init.headers = {
        Accept: "application/json",
        "Content-Type": "application/json",
      };
      init.body = JSON.stringify(body);
    }

    const resp = await fetchFn(url, init);
    const text = await resp.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!resp.ok) {
      const rec = isRecord(parsed) ? parsed : null;
      const errMsg =
        asNonEmptyTrimmed(rec?.error ?? rec?.message ?? rec?.detail) ||
        (typeof parsed === "string" && parsed.trim()) ||
        `请求失败 (${resp.status})`;
      throw new Error(sanitizePlatformErrorMessage(errMsg));
    }

    if (isRecord(parsed) && parsed.ok === false) {
      const errMsg = asNonEmptyTrimmed(parsed.error ?? parsed.message ?? parsed.detail) || "操作失败";
      throw new Error(sanitizePlatformErrorMessage(errMsg));
    }

    return parsed as T;
  }

  private apiGet<T>(url: string): Promise<T> {
    return this.requestJson<T>("GET", url);
  }

  private apiPost<T>(url: string, body?: unknown): Promise<T> {
    return this.requestJson<T>("POST", url, body ?? {});
  }

  private notifyToast(message: string, durationMs = 2800): void {
    this.options.onToast?.(message, durationMs);
  }

  // ---------- Form Hydration ----------

  private hydrateFormFromStatus(id: UiPlatformId, status: UiPlatformStatus): void {
    if (id === "tuya") {
      this.tuyaForm = tuyaFormStateFromSummary(status.configSummary);
    } else if (id === "midea") {
      this.mideaForm = mideaFormStateFromSummary(status.configSummary);
    } else if (id === "deye") {
      this.deyeForm = deyeFormStateFromSummary(status.configSummary);
    }
  }

  // ---------- Skeleton DOM Construction ----------

  private mountSkeleton(): void {
    this.container.replaceChildren();
    this.overviewRefs.clear();
    this.cardRefs.clear();

    const root = document.createElement("div");
    root.className = "pf-root";

    // Top bar
    const topbar = document.createElement("div");
    topbar.className = "pf-topbar";

    const topbarInfo = document.createElement("div");
    topbarInfo.className = "pf-topbar-info";
    const title = document.createElement("div");
    title.className = "pf-topbar-title";
    title.textContent = "多平台智能家居接入";
    const sub = document.createElement("div");
    sub.className = "pf-topbar-sub";
    sub.textContent = "统一接入小米米家、涂鸦智能、美的美居与德业智能，单平台故障自动隔离";
    topbarInfo.append(title, sub);

    const refreshBtn = document.createElement("button");
    refreshBtn.type = "button";
    refreshBtn.className = "secondary-button btn-compact";
    refreshBtn.textContent = "刷新状态";
    refreshBtn.addEventListener("click", () => {
      void this.refresh();
    });
    this.refreshBtn = refreshBtn;

    topbar.append(topbarInfo, refreshBtn);

    // Top Overview Strip
    const overviewStrip = document.createElement("div");
    overviewStrip.className = "pf-overview-strip";
    overviewStrip.setAttribute("role", "list");
    overviewStrip.setAttribute("aria-label", "已支持的智能家居平台概览");

    for (const id of UI_PLATFORM_ORDER) {
      const meta = PLATFORM_DISPLAY_META[id];
      const tile = document.createElement("button");
      tile.type = "button";
      tile.className = "pf-overview-tile";
      tile.setAttribute("role", "listitem");
      tile.dataset.platformId = id;

      const topRow = document.createElement("div");
      topRow.className = "pf-overview-top";

      const brandChip = document.createElement("span");
      brandChip.className = "pf-brand-chip";

      const glyph = document.createElement("span");
      glyph.className = "pf-glyph";
      glyph.textContent = meta.iconGlyph;
      glyph.style.setProperty("--platform-accent", meta.color);

      const nameEl = document.createElement("span");
      nameEl.className = "pf-overview-name";
      nameEl.textContent = meta.shortLabel;

      brandChip.append(glyph, nameEl);

      const pillEl = document.createElement("span");
      pillEl.className = "pf-status-pill";
      pillEl.textContent = "未接入";

      topRow.append(brandChip, pillEl);

      const metaEl = document.createElement("div");
      metaEl.className = "pf-overview-meta";
      metaEl.textContent = "未接入";

      tile.append(topRow, metaEl);
      tile.addEventListener("click", () => {
        this.toggleExpand(id, true);
      });

      overviewStrip.appendChild(tile);
      this.overviewRefs.set(id, { tile, glyph, pillEl, metaEl });
    }

    // Platform Cards Stack
    const cardsStack = document.createElement("div");
    cardsStack.className = "pf-cards-stack";

    for (const id of UI_PLATFORM_ORDER) {
      const meta = PLATFORM_DISPLAY_META[id];
      const card = document.createElement("section");
      card.className = "setting-card pf-card";
      card.dataset.platformCard = id;

      const headerBtn = document.createElement("button");
      headerBtn.type = "button";
      headerBtn.className = "pf-card-header";
      headerBtn.setAttribute("aria-expanded", "false");

      const left = document.createElement("div");
      left.className = "pf-card-head-left";

      const glyph = document.createElement("span");
      glyph.className = "pf-glyph pf-glyph-lg";
      glyph.textContent = meta.iconGlyph;
      glyph.style.setProperty("--platform-accent", meta.color);

      const titles = document.createElement("div");
      titles.className = "pf-card-titles";

      const titleRow = document.createElement("div");
      titleRow.className = "pf-card-title-row";

      const titleEl = document.createElement("span");
      titleEl.className = "pf-card-title";
      titleEl.textContent = meta.displayName;

      const refEl = document.createElement("span");
      refEl.className = "pf-card-ref";
      refEl.textContent = meta.reference;

      titleRow.append(titleEl, refEl);

      const summaryEl = document.createElement("div");
      summaryEl.className = "pf-card-summary";
      summaryEl.textContent = "未接入";

      titles.append(titleRow, summaryEl);
      left.append(glyph, titles);

      const right = document.createElement("div");
      right.className = "pf-card-head-right";

      const pillEl = document.createElement("span");
      pillEl.className = "pf-status-pill";
      pillEl.textContent = "未接入";

      const toggleLabel = document.createElement("span");
      toggleLabel.className = "pf-toggle-label";
      toggleLabel.textContent = "配置";

      right.append(pillEl, toggleLabel);
      headerBtn.append(left, right);
      headerBtn.addEventListener("click", () => {
        this.toggleExpand(id, false);
      });

      const errorEl = document.createElement("div");
      errorEl.className = "pf-error-banner";
      errorEl.hidden = true;

      const bodyEl = document.createElement("div");
      bodyEl.className = "pf-card-body";
      bodyEl.hidden = true;

      card.append(headerBtn, errorEl, bodyEl);
      cardsStack.appendChild(card);

      this.cardRefs.set(id, {
        card,
        headerBtn,
        glyph,
        summaryEl,
        pillEl,
        toggleLabel,
        errorEl,
        bodyEl,
      });
    }

    root.append(topbar, overviewStrip, cardsStack);
    this.container.appendChild(root);
  }

  private toggleExpand(id: UiPlatformId, forceOpen: boolean): void {
    const next = forceOpen ? id : this.expandedPlatform === id ? null : id;
    this.expandedPlatform = next;
    this.syncAllHeadersAndOverview();
    this.renderAllCardBodies(false);
    if (next) {
      const ref = this.cardRefs.get(next);
      if (ref && typeof ref.card.scrollIntoView === "function") {
        ref.card.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    }
  }

  private updateRefreshBtnState(): void {
    if (!this.refreshBtn) return;
    this.refreshBtn.disabled = this.refreshingAll;
    this.refreshBtn.textContent = this.refreshingAll ? "刷新中…" : "刷新状态";
  }

  private syncAllHeadersAndOverview(): void {
    for (const id of UI_PLATFORM_ORDER) {
      const status = this.statuses.get(id) ?? defaultPlatformStatus(id);
      const toneInfo = platformStatusTone(status);
      const summary = formatPlatformSummaryLine(status);
      const accent = safeAccentColor(status);
      const isExpanded = this.expandedPlatform === id;

      const ov = this.overviewRefs.get(id);
      if (ov) {
        ov.tile.classList.toggle("is-expanded", isExpanded);
        ov.glyph.style.setProperty("--platform-accent", accent);
        ov.pillEl.className = `pf-status-pill is-${toneInfo.tone}`;
        ov.pillEl.textContent = toneInfo.label;
        ov.metaEl.textContent = status.connected
          ? `${Math.max(0, Math.trunc(status.deviceCount || 0))} 台设备`
          : summary;
      }

      const card = this.cardRefs.get(id);
      if (card) {
        card.card.classList.toggle("is-expanded", isExpanded);
        card.headerBtn.setAttribute("aria-expanded", String(isExpanded));
        card.glyph.style.setProperty("--platform-accent", accent);
        card.summaryEl.textContent = summary;
        card.pillEl.className = `pf-status-pill is-${toneInfo.tone}`;
        card.pillEl.textContent = toneInfo.label;
        card.toggleLabel.textContent = isExpanded ? "收起" : "配置";

        const errText = sanitizePlatformErrorMessage(status.lastError ?? "");
        if (errText) {
          card.errorEl.textContent = `最近异常：${errText}`;
          card.errorEl.hidden = false;
        } else {
          card.errorEl.textContent = "";
          card.errorEl.hidden = true;
        }
        card.bodyEl.hidden = !isExpanded;
      }
    }
  }

  private renderAllCardBodies(force: boolean): void {
    for (const id of UI_PLATFORM_ORDER) {
      this.renderCardBody(id, force);
    }
  }

  private renderCardBody(id: UiPlatformId, force: boolean): void {
    const ref = this.cardRefs.get(id);
    if (!ref) return;

    const isExpanded = this.expandedPlatform === id;
    ref.bodyEl.hidden = !isExpanded;
    if (!isExpanded && !force) return;

    // Avoid stealing focus from active form controls on passive status updates.
    if (
      !force &&
      typeof document !== "undefined" &&
      document.activeElement &&
      ref.bodyEl.contains(document.activeElement)
    ) {
      return;
    }

    if (id === "mijia") {
      this.renderMijiaBody(ref.bodyEl);
    } else if (id === "tuya") {
      this.renderTuyaBody(ref.bodyEl);
    } else if (id === "midea") {
      this.renderMideaBody(ref.bodyEl);
    } else if (id === "deye") {
      this.renderDeyeBody(ref.bodyEl);
    }
  }

  // ---------- Card 1: 小米米家 ----------

  private renderMijiaBody(bodyEl: HTMLElement): void {
    bodyEl.replaceChildren();
    const status = this.statuses.get("mijia") ?? defaultPlatformStatus("mijia");
    const summary = isRecord(status.configSummary) ? status.configSummary : {};
    const accountId = asNonEmptyTrimmed(summary.accountId);
    const apiVersion = asNonEmptyTrimmed(summary.apiVersion);
    const busy = this.busyAction.mijia !== null;

    const desc = document.createElement("div");
    desc.className = "pf-card-desc";
    desc.textContent = status.description || PLATFORM_DISPLAY_META.mijia.description;

    const stats = document.createElement("div");
    stats.className = "pf-mijia-stats";

    stats.append(
      this.createStatBox(
        "登录状态",
        status.connected ? (accountId ? `已登录 (${accountId})` : "已登录小米账号") : "未登录",
      ),
      this.createStatBox("同步设备", `${Math.max(0, Math.trunc(status.deviceCount || 0))} 台`),
      SCENES_FEATURE_ENABLED
        ? this.createStatBox(
            "手动场景 / 协议",
            apiVersion
              ? `${Math.max(0, Math.trunc(status.sceneCount || 0))} 个 · ${apiVersion}`
              : `${Math.max(0, Math.trunc(status.sceneCount || 0))} 个场景`,
          )
        : this.createStatBox("协议版本", apiVersion || "MIoT"),
    );

    const actions = document.createElement("div");
    actions.className = "pf-actions-bar";

    const leftGroup = document.createElement("div");
    leftGroup.className = "pf-actions-group";

    const loginBtn = document.createElement("button");
    loginBtn.type = "button";
    loginBtn.className = status.connected ? "secondary-button btn-compact" : "primary-button btn-compact";
    loginBtn.textContent = status.connected ? "重新扫码登录" : "打开米家扫码登录";
    loginBtn.disabled = busy;
    loginBtn.addEventListener("click", () => {
      if (this.options.onOpenMijiaLogin) {
        this.options.onOpenMijiaLogin();
      } else {
        this.notifyToast("请在主界面打开米家扫码登录弹窗");
      }
    });
    leftGroup.appendChild(loginBtn);

    if (status.connected) {
      const logoutBtn = document.createElement("button");
      logoutBtn.type = "button";
      logoutBtn.className = "secondary-button btn-compact pf-danger-btn";
      logoutBtn.textContent = this.busyAction.mijia === "disconnecting" ? "正在退出…" : "退出米家登录";
      logoutBtn.disabled = busy;
      logoutBtn.addEventListener("click", () => {
        void this.handleMijiaDisconnect();
      });
      leftGroup.appendChild(logoutBtn);
    }

    actions.appendChild(leftGroup);
    bodyEl.append(desc, stats, actions);
  }

  private async handleMijiaDisconnect(): Promise<void> {
    this.busyAction.mijia = "disconnecting";
    this.renderCardBody("mijia", true);
    try {
      if (this.options.onMijiaDisconnect) {
        await this.options.onMijiaDisconnect();
        await this.refresh();
      } else {
        const res = await this.apiPost<PlatformMutationResponse>("/api/platforms/mijia/disconnect");
        this.applyMutationResponse("mijia", res, "已退出米家账号");
      }
    } catch (err) {
      this.notifyToast(`退出米家登录失败：${sanitizePlatformErrorMessage(err)}`, 3200);
    } finally {
      this.busyAction.mijia = null;
      if (!this.disposed) {
        this.renderCardBody("mijia", true);
      }
    }
  }

  // ---------- Card 2: 涂鸦智能 (Tuya Smart / Smart Life) ----------

  private renderTuyaBody(bodyEl: HTMLElement): void {
    bodyEl.replaceChildren();
    this.qrCountdownEl = null;

    const status = this.statuses.get("tuya") ?? defaultPlatformStatus("tuya");
    const form = this.tuyaForm;
    const busy = this.busyAction.tuya !== null;

    const desc = document.createElement("div");
    desc.className = "pf-card-desc";
    desc.textContent = status.description || PLATFORM_DISPLAY_META.tuya.description;
    bodyEl.appendChild(desc);

    // Mode selector
    const modeRow = document.createElement("div");
    modeRow.className = "pf-form-grid";
    const modeField = this.createField("接入模式", true);
    const modeSelect = this.createSelect(TUYA_MODES, form.mode, "涂鸦智能接入模式");
    modeSelect.addEventListener("change", () => {
      form.mode = modeSelect.value as UiTuyaMode;
      this.dirtyFlags.tuya = true;
      this.renderCardBody("tuya", true);
    });
    modeField.appendChild(modeSelect);
    modeRow.appendChild(modeField);
    bodyEl.appendChild(modeRow);

    // Section A: Home Assistant QR Sharing (sharing / hybrid)
    if (form.mode === "sharing" || form.mode === "hybrid") {
      const qrSection = document.createElement("div");
      qrSection.className = "pf-section-box";

      const head = document.createElement("div");
      head.className = "pf-section-head";
      const secTitle = document.createElement("span");
      secTitle.className = "pf-section-title";
      secTitle.textContent = "Home Assistant 设备分享扫码授权";
      head.appendChild(secTitle);
      if (form.hasTokenSession) {
        const badge = document.createElement("span");
        badge.className = "pf-saved-pill";
        badge.textContent = form.username
          ? `已授权：${form.username}`
          : form.uid
            ? `已保存会话 (${form.uid.slice(0, 6)}…)`
            : "已保存扫码授权会话";
        head.appendChild(badge);
      }
      qrSection.appendChild(head);

      const userCodeField = this.createField("涂鸦 App 用户码 (User Code)", true);
      const codeRow = document.createElement("div");
      codeRow.className = "pf-inline-row";

      const userCodeInput = this.createTextInput(
        form.userCode,
        "输入涂鸦智能 / Smart Life App 用户码",
        "涂鸦用户码",
      );
      userCodeInput.addEventListener("input", () => {
        form.userCode = userCodeInput.value;
        this.dirtyFlags.tuya = true;
      });

      const qrBtn = document.createElement("button");
      qrBtn.type = "button";
      qrBtn.className = "primary-button btn-compact";
      qrBtn.textContent =
        this.busyAction.tuya === "qrLoading" ? "正在获取二维码…" : "获取授权二维码";
      qrBtn.disabled = busy;
      qrBtn.addEventListener("click", () => {
        void this.handleTuyaBeginQr();
      });

      codeRow.append(userCodeInput, qrBtn);
      const hint = document.createElement("div");
      hint.className = "pf-hint";
      hint.textContent = "在「涂鸦智能 / Smart Life App」→ 我的 → 设置 → 账号与安全 → 用户码";

      userCodeField.append(codeRow, hint);
      qrSection.appendChild(userCodeField);

      if (form.mode === "sharing") {
        const irSharingHint = document.createElement("div");
        irSharingHint.className = "pf-hint";
        irSharingHint.textContent =
          "提示：涂鸦扫码共享接口不开放红外标准遥控器协议。如需控制音响、电视、DIY 等非空调红外遥控设备，请切换为「云端 + 局域网混合」模式并补充涂鸦 OpenAPI 凭据。";
        qrSection.appendChild(irSharingHint);
      }

      // Active QR Panel
      if (this.activeTuyaQr) {
        const qrState = this.activeTuyaQr;
        const qrPanel = document.createElement("div");
        qrPanel.className = "pf-qr-panel";

        const qrBox = document.createElement("div");
        qrBox.className = "pf-qr-box";
        renderSafeQrInto(qrBox, qrState.session.qrContent, qrState.session.qrSvg);

        const qrInfo = document.createElement("div");
        qrInfo.className = "pf-qr-info";

        const qrHint = document.createElement("div");
        qrHint.className = "pf-qr-hint";
        qrHint.textContent =
          qrState.session.hint || "请使用「涂鸦智能 / Smart Life App」扫描此二维码并确认授权";

        const countdownEl = document.createElement("div");
        countdownEl.className = "pf-qr-countdown";
        countdownEl.textContent = this.formatQrCountdown(qrState);
        this.qrCountdownEl = countdownEl;

        qrInfo.append(qrHint, countdownEl);

        if (qrState.errorMessage) {
          const errLine = document.createElement("div");
          errLine.className = "pf-qr-status-err";
          errLine.textContent = qrState.errorMessage;
          qrInfo.appendChild(errLine);
        }

        const qrBtns = document.createElement("div");
        qrBtns.className = "pf-inline-row";

        const confirmQrBtn = document.createElement("button");
        confirmQrBtn.type = "button";
        confirmQrBtn.className = "primary-button btn-compact";
        confirmQrBtn.textContent = "我已扫码，立即确认";
        confirmQrBtn.disabled = this.qrPollInFlight || Date.now() >= qrState.session.expiresAt;
        confirmQrBtn.addEventListener("click", () => {
          void this.pollTuyaQrNow(this.qrSessionGen, qrState.session, true);
        });

        const cancelQrBtn = document.createElement("button");
        cancelQrBtn.type = "button";
        cancelQrBtn.className = "secondary-button btn-compact";
        cancelQrBtn.textContent = "取消扫码";
        cancelQrBtn.addEventListener("click", () => {
          this.stopQrPolling();
          this.activeTuyaQr = null;
          this.renderCardBody("tuya", true);
        });
        qrBtns.append(confirmQrBtn, cancelQrBtn);
        qrInfo.appendChild(qrBtns);

        qrPanel.append(qrBox, qrInfo);
        qrSection.appendChild(qrPanel);
      }

      bodyEl.appendChild(qrSection);
    }

    // Section B: Tuya IoT Cloud OpenAPI (openapi / hybrid)
    if (form.mode === "openapi" || form.mode === "hybrid") {
      const openSection = document.createElement("div");
      openSection.className = "pf-section-box";

      const head = document.createElement("div");
      head.className = "pf-section-head";
      const secTitle = document.createElement("span");
      secTitle.className = "pf-section-title";
      secTitle.textContent = "Tuya IoT Cloud OpenAPI v2.0 凭据";
      head.appendChild(secTitle);
      openSection.appendChild(head);

      const grid = document.createElement("div");
      grid.className = "pf-form-grid";

      const regionField = this.createField("数据中心区域");
      const regionSelect = this.createSelect(TUYA_REGIONS, form.region, "涂鸦云端区域");
      regionSelect.addEventListener("change", () => {
        form.region = regionSelect.value as UiTuyaRegion;
        this.dirtyFlags.tuya = true;
      });
      regionField.appendChild(regionSelect);

      const accessIdField = this.createField("Access ID (Client ID)");
      const accessIdInput = this.createTextInput(
        form.accessId,
        "输入涂鸦云项目 Access ID",
        "Tuya Access ID",
      );
      accessIdInput.addEventListener("input", () => {
        form.accessId = accessIdInput.value;
        this.dirtyFlags.tuya = true;
      });
      accessIdField.appendChild(accessIdInput);

      const secretField = this.createField(
        "Access Secret",
        false,
        form.hasAccessSecret ? "已保存，留空保持不变" : undefined,
      );
      const secretInput = this.createPasswordInput(
        form.accessSecret ?? "",
        form.hasAccessSecret ? "已保存（留空保持不变）" : "输入 Access Secret",
        "Tuya Access Secret",
      );
      secretInput.addEventListener("input", () => {
        form.accessSecret = secretInput.value;
        this.dirtyFlags.tuya = true;
      });
      secretField.appendChild(secretInput);

      const uidField = this.createField("涂鸦账号 UID");
      const uidInput = this.createTextInput(
        form.uid,
        "输入关联 App 账号的 UID",
        "Tuya UID",
      );
      uidInput.addEventListener("input", () => {
        form.uid = uidInput.value;
        this.dirtyFlags.tuya = true;
      });
      uidField.appendChild(uidInput);

      grid.append(regionField, accessIdField, secretField, uidField);
      openSection.appendChild(grid);

      const irOpenApiHint = document.createElement("div");
      irOpenApiHint.className = "pf-hint";
      irOpenApiHint.textContent =
        form.mode === "hybrid"
          ? "红外标准遥控器协议：混合模式会保留上方扫码授权，仅需填写 Access ID 与 Access Secret（UID 可留空）并在涂鸦云开发平台开通「IR Control Hub（红外遥控）」服务，即可对音响、电视、DIY 等红外子设备读取真实按键并下发标准/配对/学习码指令。"
          : "红外标准遥控器协议：音响、电视、DIY 等红外子设备将自动调用涂鸦 OpenAPI v2.0（IR Control Hub）标准命令与按键命令接口，请确保云项目已订阅「IR Control Hub」并关联涂鸦 App 账号。";
      openSection.appendChild(irOpenApiHint);

      bodyEl.appendChild(openSection);
    }

    // Section C: LocalTuya LAN Devices (local / hybrid)
    if (form.mode === "local" || form.mode === "hybrid") {
      const localSection = document.createElement("div");
      localSection.className = "pf-section-box";

      const head = document.createElement("div");
      head.className = "pf-section-head";
      const secTitle = document.createElement("span");
      secTitle.className = "pf-section-title";
      secTitle.textContent = "LocalTuya 局域网直连设备";

      const headBtns = document.createElement("div");
      headBtns.className = "pf-inline-row";

      const discoverBtn = document.createElement("button");
      discoverBtn.type = "button";
      discoverBtn.className = "secondary-button btn-compact";
      discoverBtn.textContent =
        this.busyAction.tuya === "discovering" ? "正在扫描…" : "扫描局域网涂鸦设备";
      discoverBtn.disabled = busy;
      discoverBtn.addEventListener("click", () => {
        void this.handleDiscoverLocal("tuya");
      });

      const addRowBtn = document.createElement("button");
      addRowBtn.type = "button";
      addRowBtn.className = "secondary-button btn-compact";
      addRowBtn.textContent = "+ 添加本地设备";
      addRowBtn.addEventListener("click", () => {
        form.localDevices.push({
          id: "",
          name: "",
          ip: "",
          port: 6668,
          version: "3.3",
          localKey: "",
          hasLocalKey: false,
        });
        this.dirtyFlags.tuya = true;
        this.renderCardBody("tuya", true);
      });

      headBtns.append(discoverBtn, addRowBtn);
      head.append(secTitle, headBtns);
      localSection.appendChild(head);

      if (form.mode === "hybrid") {
        localSection.appendChild(
          this.createSwitchRow(
            "优先局域网直连",
            "已配置 Local Key 的设备优先走局域网控制，离线或失败时自动回退云端",
            form.preferLocal,
            (checked) => {
              form.preferLocal = checked;
              this.dirtyFlags.tuya = true;
            },
          ),
        );
      }

      // Discovered LAN devices
      if (this.discoveredDevices.tuya.length > 0) {
        const discWrap = document.createElement("div");
        discWrap.className = "pf-discovered-list";
        const discHint = document.createElement("div");
        discHint.className = "pf-hint";
        discHint.textContent = `局域网广播发现 ${this.discoveredDevices.tuya.length} 台涂鸦设备：`;
        discWrap.appendChild(discHint);

        for (const dev of this.discoveredDevices.tuya) {
          const item = document.createElement("div");
          item.className = "pf-discovered-item";

          const meta = document.createElement("div");
          meta.className = "pf-discovered-meta";
          const t = document.createElement("div");
          t.className = "pf-discovered-title";
          t.textContent = dev.name || dev.id;
          const s = document.createElement("div");
          s.className = "pf-discovered-sub";
          s.textContent = `ID: ${dev.id} · ${dev.ip}:${dev.port} · v${dev.protocolVersion || "3.3"}`;
          meta.append(t, s);

          const addBtn = document.createElement("button");
          addBtn.type = "button";
          addBtn.className = "secondary-button btn-compact";
          addBtn.textContent = "添加到本地列表";
          addBtn.addEventListener("click", () => {
            this.tuyaForm.localDevices = mergeDiscoveredTuyaDevice(this.tuyaForm.localDevices, dev);
            this.dirtyFlags.tuya = true;
            this.renderCardBody("tuya", true);
            this.notifyToast(`已添加涂鸦设备 ${dev.ip}`, 2000);
          });

          item.append(meta, addBtn);
          discWrap.appendChild(item);
        }
        localSection.appendChild(discWrap);
      }

      // Editable Local Devices List
      const listWrap = document.createElement("div");
      listWrap.className = "pf-local-list";

      if (form.localDevices.length === 0) {
        const empty = document.createElement("div");
        empty.className = "pf-empty-local";
        empty.textContent = "暂无本地涂鸦设备，可点击「扫描局域网涂鸦设备」或「+ 添加本地设备」";
        listWrap.appendChild(empty);
      } else {
        form.localDevices.forEach((dev, idx) => {
          const row = document.createElement("div");
          row.className = "pf-local-row";

          const rowHead = document.createElement("div");
          rowHead.className = "pf-local-row-head";
          const rowIdx = document.createElement("span");
          rowIdx.className = "pf-local-row-idx";
          rowIdx.textContent = `本地设备 #${idx + 1}`;
          const delBtn = document.createElement("button");
          delBtn.type = "button";
          delBtn.className = "secondary-button btn-compact pf-danger-btn";
          delBtn.textContent = "删除";
          delBtn.addEventListener("click", () => {
            form.localDevices.splice(idx, 1);
            this.dirtyFlags.tuya = true;
            this.renderCardBody("tuya", true);
          });
          rowHead.append(rowIdx, delBtn);

          const grid1 = document.createElement("div");
          grid1.className = "pf-local-row-grid";

          const idF = this.createField("设备 ID");
          const idIn = this.createTextInput(dev.id, "如 bf1234567890abcd", "涂鸦设备 ID");
          idIn.addEventListener("input", () => {
            dev.id = idIn.value;
            this.dirtyFlags.tuya = true;
          });
          idF.appendChild(idIn);

          const nameF = this.createField("设备名称");
          const nameIn = this.createTextInput(dev.name, "如 客厅插座", "涂鸦设备名称");
          nameIn.addEventListener("input", () => {
            dev.name = nameIn.value;
            this.dirtyFlags.tuya = true;
          });
          nameF.appendChild(nameIn);

          const ipF = this.createField("IP 地址");
          const ipIn = this.createTextInput(dev.ip, "192.168.1.50", "涂鸦设备 IP");
          ipIn.addEventListener("input", () => {
            dev.ip = ipIn.value;
            this.dirtyFlags.tuya = true;
          });
          ipF.appendChild(ipIn);

          grid1.append(idF, nameF, ipF);

          const grid2 = document.createElement("div");
          grid2.className = "pf-local-row-grid";

          const verF = this.createField("协议版本");
          const verSel = this.createSelect(
            TUYA_VERSIONS.map((v) => ({ value: v, label: `v${v}` })),
            dev.version,
            "涂鸦协议版本",
          );
          verSel.addEventListener("change", () => {
            dev.version = verSel.value as UiTuyaLocalVersion;
            this.dirtyFlags.tuya = true;
          });
          verF.appendChild(verSel);

          const portF = this.createField("端口");
          const portIn = this.createNumberInput(dev.port ?? 6668, 1, 65535, "涂鸦端口");
          portIn.addEventListener("input", () => {
            dev.port = clampPort(portIn.value, 6668);
            this.dirtyFlags.tuya = true;
          });
          portF.appendChild(portIn);

          const keyF = this.createField(
            "Local Key",
            false,
            dev.hasLocalKey ? "已保存" : undefined,
          );
          const keyIn = this.createPasswordInput(
            dev.localKey ?? "",
            dev.hasLocalKey ? "已保存（留空保持不变）" : "16 位 Local Key",
            "涂鸦 Local Key",
          );
          keyIn.addEventListener("input", () => {
            dev.localKey = keyIn.value;
            this.dirtyFlags.tuya = true;
          });
          keyF.appendChild(keyIn);

          grid2.append(verF, portF, keyF);
          row.append(rowHead, grid1, grid2);
          listWrap.appendChild(row);
        });
      }

      localSection.appendChild(listWrap);
      bodyEl.appendChild(localSection);
    }

    bodyEl.appendChild(
      this.createPlatformActionsBar(
        "tuya",
        () => void this.handleSaveTuya(),
        () => void this.handleDisconnectPlatform("tuya", "已断开涂鸦智能连接"),
      ),
    );
  }

  private async handleTuyaBeginQr(): Promise<void> {
    const userCode = this.tuyaForm.userCode.trim();
    if (!userCode) {
      this.notifyToast("请先填写涂鸦 App 用户码（我的 → 设置 → 账号与安全 → 用户码）", 3200);
      return;
    }

    this.stopQrPolling();
    const gen = ++this.qrSessionGen;
    this.busyAction.tuya = "qrLoading";
    this.renderCardBody("tuya", true);

    try {
      const res = await this.apiPost<PlatformQrBeginResponse>("/api/platforms/tuya/qr/begin", {
        userCode,
      });
      if (this.disposed || gen !== this.qrSessionGen) return;

      const session = res?.session;
      if (!session || !session.sessionId) {
        throw new Error("未获取到有效的涂鸦授权二维码");
      }

      this.activeTuyaQr = {
        session,
        statusMessage: "等待手机扫码确认…",
        errorMessage: null,
      };
      this.busyAction.tuya = null;
      this.renderCardBody("tuya", true);
      this.startTuyaQrPolling(gen, session);
    } catch (err) {
      if (this.disposed || gen !== this.qrSessionGen) return;
      this.busyAction.tuya = null;
      this.renderCardBody("tuya", true);
      this.notifyToast(`获取涂鸦二维码失败：${sanitizePlatformErrorMessage(err)}`, 3400);
    }
  }

  private formatQrCountdown(qrState: ActiveTuyaQrState): string {
    const remainingSec = Math.max(0, Math.ceil((qrState.session.expiresAt - Date.now()) / 1000));
    if (remainingSec <= 0) {
      return "二维码已过期，请重新点击「获取授权二维码」";
    }
    return `${qrState.statusMessage}（剩余 ${remainingSec} 秒）`;
  }

  private startTuyaQrPolling(gen: number, session: UiPlatformQrSession): void {
    this.clearQrTimersOnly();
    this.qrTransientErrors = 0;

    this.qrCountdownTimer = setInterval(() => {
      if (this.disposed || gen !== this.qrSessionGen || !this.activeTuyaQr) {
        this.clearQrTimersOnly();
        return;
      }
      if (this.qrCountdownEl) {
        this.qrCountdownEl.textContent = this.formatQrCountdown(this.activeTuyaQr);
      }
      if (Date.now() >= session.expiresAt) {
        this.activeTuyaQr.errorMessage = "二维码已过期，请重新获取";
        this.clearQrTimersOnly();
        this.renderCardBody("tuya", true);
      }
    }, 1000);

    this.scheduleNextTuyaQrPoll(gen, session);
  }

  private scheduleNextTuyaQrPoll(gen: number, session: UiPlatformQrSession): void {
    if (this.disposed || gen !== this.qrSessionGen || !this.activeTuyaQr) return;
    if (this.qrPollTimer !== null) {
      clearTimeout(this.qrPollTimer);
      this.qrPollTimer = null;
    }
    this.qrPollTimer = setTimeout(() => {
      this.qrPollTimer = null;
      void this.pollTuyaQrNow(gen, session, false);
    }, this.qrPollIntervalMs);
  }

  private async pollTuyaQrNow(
    gen: number,
    session: UiPlatformQrSession,
    manual: boolean,
  ): Promise<void> {
    if (this.disposed || gen !== this.qrSessionGen || !this.activeTuyaQr) return;
    if (Date.now() >= session.expiresAt) {
      this.activeTuyaQr.errorMessage = "二维码已过期，请重新获取";
      this.clearQrTimersOnly();
      this.renderCardBody("tuya", true);
      return;
    }
    if (this.qrPollInFlight) return;
    if (this.qrPollTimer !== null) {
      clearTimeout(this.qrPollTimer);
      this.qrPollTimer = null;
    }

    this.qrPollInFlight = true;
    if (manual && this.activeTuyaQr) {
      this.activeTuyaQr.statusMessage = "正在确认扫码结果…";
      this.activeTuyaQr.errorMessage = null;
      if (this.qrCountdownEl) {
        this.qrCountdownEl.textContent = this.formatQrCountdown(this.activeTuyaQr);
      }
    }

    try {
      const res = await this.apiPost<PlatformQrPollResponse>("/api/platforms/tuya/qr/poll", {
        sessionId: session.sessionId,
      });
      if (this.disposed || gen !== this.qrSessionGen) return;

      this.qrTransientErrors = 0;
      const result = res?.result;
      if (!result || result.status === "pending") {
        if (this.activeTuyaQr) {
          this.activeTuyaQr.statusMessage = manual
            ? "尚未检测到手机端确认，请先在 App 中点击「确认登录」"
            : "等待手机扫码确认…";
          this.activeTuyaQr.errorMessage = null;
          if (this.qrCountdownEl) {
            this.qrCountdownEl.textContent = this.formatQrCountdown(this.activeTuyaQr);
          }
        }
        this.scheduleNextTuyaQrPoll(gen, session);
        return;
      }

      if (result.status === "success") {
        this.stopQrPolling();
        this.activeTuyaQr = null;
        this.dirtyFlags.tuya = false;
        if (Array.isArray(res.platforms) && res.platforms.length > 0) {
          this.update(res.platforms);
          this.options.onPlatformsChanged?.(this.getPlatforms());
        } else if (result.platformStatus) {
          this.statuses.set("tuya", result.platformStatus);
          this.hydrateFormFromStatus("tuya", result.platformStatus);
          this.syncAllHeadersAndOverview();
          this.options.onPlatformsChanged?.(this.getPlatforms());
        } else {
          await this.refresh();
        }
        this.renderCardBody("tuya", true);
        this.notifyToast(result.message || "涂鸦智能扫码授权成功", 3000);
        return;
      }

      // expired or genuine error (e.g. USERCODE_INCORRECT / rejected)
      this.stopQrPolling();
      if (this.activeTuyaQr) {
        this.activeTuyaQr.errorMessage =
          sanitizePlatformErrorMessage(result.message) ||
          (result.status === "expired" ? "二维码已过期，请重新获取" : "扫码授权失败，请重试");
      }
      this.renderCardBody("tuya", true);
    } catch (err) {
      if (this.disposed || gen !== this.qrSessionGen) return;
      this.qrTransientErrors += 1;
      if (this.qrTransientErrors < 3) {
        if (this.activeTuyaQr) {
          this.activeTuyaQr.statusMessage = "网络波动，正在继续等待手机扫码确认…";
          if (this.qrCountdownEl) {
            this.qrCountdownEl.textContent = this.formatQrCountdown(this.activeTuyaQr);
          }
        }
        this.scheduleNextTuyaQrPoll(gen, session);
        return;
      }
      this.stopQrPolling();
      if (this.activeTuyaQr) {
        this.activeTuyaQr.errorMessage = `轮询扫码状态失败：${sanitizePlatformErrorMessage(err)}`;
      }
      this.renderCardBody("tuya", true);
    } finally {
      this.qrPollInFlight = false;
    }
  }

  private clearQrTimersOnly(): void {
    if (this.qrPollTimer !== null) {
      clearTimeout(this.qrPollTimer);
      this.qrPollTimer = null;
    }
    if (this.qrCountdownTimer !== null) {
      clearInterval(this.qrCountdownTimer);
      this.qrCountdownTimer = null;
    }
  }

  private stopQrPolling(): void {
    this.qrSessionGen += 1;
    this.clearQrTimersOnly();
  }

  private async handleSaveTuya(): Promise<void> {
    const payload = buildTuyaConfigPayload({
      ...this.tuyaForm,
      enabled: true,
    });
    await this.savePlatformConfig("tuya", payload, "涂鸦智能配置已保存并连接");
  }

  // ---------- Card 3: 美的智能 (Midea / 美的美居) ----------

  private renderMideaBody(bodyEl: HTMLElement): void {
    bodyEl.replaceChildren();
    const status = this.statuses.get("midea") ?? defaultPlatformStatus("midea");
    const form = this.mideaForm;
    const busy = this.busyAction.midea !== null;

    const desc = document.createElement("div");
    desc.className = "pf-card-desc";
    desc.textContent = status.description || PLATFORM_DISPLAY_META.midea.description;
    bodyEl.appendChild(desc);

    // Mode selector
    const modeGrid = document.createElement("div");
    modeGrid.className = "pf-form-grid";

    const modeField = this.createField("接入模式", form.mode === "local");
    const modeSelect = this.createSelect(MIDEA_MODES, form.mode, "美的智能接入模式");
    modeSelect.addEventListener("change", () => {
      form.mode = modeSelect.value as UiMideaMode;
      this.dirtyFlags.midea = true;
      this.renderCardBody("midea", true);
    });
    modeField.appendChild(modeSelect);
    modeGrid.appendChild(modeField);

    if (form.mode === "hybrid" || form.mode === "cloud") {
      const brandField = this.createField("云端 App 品牌");
      const brandSelect = this.createSelect(MIDEA_BRANDS, form.cloudBrand, "美的云端品牌");
      brandSelect.addEventListener("change", () => {
        form.cloudBrand = brandSelect.value as UiMideaBrand;
        this.dirtyFlags.midea = true;
      });
      brandField.appendChild(brandSelect);
      modeGrid.appendChild(brandField);
    }

    bodyEl.appendChild(modeGrid);

    // Section A: Cloud credentials (hybrid / cloud)
    if (form.mode === "hybrid" || form.mode === "cloud") {
      const cloudSection = document.createElement("div");
      cloudSection.className = "pf-section-box";

      const head = document.createElement("div");
      head.className = "pf-section-head";
      const secTitle = document.createElement("span");
      secTitle.className = "pf-section-title";
      secTitle.textContent = "美的云端账号认证";
      head.appendChild(secTitle);
      cloudSection.appendChild(head);

      const grid = document.createElement("div");
      grid.className = "pf-form-grid";

      const accField = this.createField("美的账号（手机号 / 邮箱）");
      const accInput = this.createTextInput(
        form.account,
        "输入美的美居 / MSmartHome 账号",
        "美的账号",
      );
      accInput.addEventListener("input", () => {
        form.account = accInput.value;
        this.dirtyFlags.midea = true;
      });
      accField.appendChild(accInput);

      const pwdField = this.createField(
        "密码",
        false,
        form.hasPassword ? "已保存，留空保持不变" : undefined,
      );
      const pwdInput = this.createPasswordInput(
        form.password ?? "",
        form.hasPassword ? "已保存（留空保持不变）" : "输入账号密码",
        "美的账号密码",
      );
      pwdInput.addEventListener("input", () => {
        form.password = pwdInput.value;
        this.dirtyFlags.midea = true;
      });
      pwdField.appendChild(pwdInput);

      grid.append(accField, pwdField);
      cloudSection.appendChild(grid);

      cloudSection.appendChild(
        this.createSwitchRow(
          "中国大陆服务器",
          "美的美居中国区账号请保持开启；海外 MSmartHome 账号可关闭切换国际节点",
          form.useChinaServer,
          (checked) => {
            form.useChinaServer = checked;
            this.dirtyFlags.midea = true;
          },
        ),
      );

      if (form.mode === "hybrid") {
        cloudSection.appendChild(
          this.createSwitchRow(
            "优先局域网直连",
            "云端自动获取设备 Token/Key 后优先局域网毫秒级控制，失败自动回退云端",
            form.preferLocal,
            (checked) => {
              form.preferLocal = checked;
              this.dirtyFlags.midea = true;
            },
          ),
        );
      }

      bodyEl.appendChild(cloudSection);
    }

    // Section B: LAN Discovery & Editable Local Devices (hybrid / local)
    if (form.mode === "hybrid" || form.mode === "local") {
      const localSection = document.createElement("div");
      localSection.className = "pf-section-box";

      const head = document.createElement("div");
      head.className = "pf-section-head";
      const secTitle = document.createElement("span");
      secTitle.className = "pf-section-title";
      secTitle.textContent = "局域网美的设备 (M-Smart V2/V3)";

      const headBtns = document.createElement("div");
      headBtns.className = "pf-inline-row";

      const discoverBtn = document.createElement("button");
      discoverBtn.type = "button";
      discoverBtn.className = "secondary-button btn-compact";
      discoverBtn.textContent =
        this.busyAction.midea === "discovering"
          ? "正在扫描…"
          : "扫描局域网美的设备 (UDP 6445)";
      discoverBtn.disabled = busy;
      discoverBtn.addEventListener("click", () => {
        void this.handleDiscoverLocal("midea");
      });

      const addRowBtn = document.createElement("button");
      addRowBtn.type = "button";
      addRowBtn.className = "secondary-button btn-compact";
      addRowBtn.textContent = "+ 添加本地设备";
      addRowBtn.addEventListener("click", () => {
        form.localDevices.push({
          id: "",
          name: "",
          ip: "",
          port: 6444,
          type: 0xac,
          protocolVersion: 3,
          token: "",
          key: "",
          hasToken: false,
          hasKey: false,
        });
        this.dirtyFlags.midea = true;
        this.renderCardBody("midea", true);
      });

      headBtns.append(discoverBtn, addRowBtn);
      head.append(secTitle, headBtns);
      localSection.appendChild(head);

      // Discovered Midea devices
      if (this.discoveredDevices.midea.length > 0) {
        const discWrap = document.createElement("div");
        discWrap.className = "pf-discovered-list";
        const discHint = document.createElement("div");
        discHint.className = "pf-hint";
        discHint.textContent = `UDP 6445 广播发现 ${this.discoveredDevices.midea.length} 台美的设备：`;
        discWrap.appendChild(discHint);

        for (const dev of this.discoveredDevices.midea) {
          const item = document.createElement("div");
          item.className = "pf-discovered-item";

          const meta = document.createElement("div");
          meta.className = "pf-discovered-meta";
          const t = document.createElement("div");
          t.className = "pf-discovered-title";
          const typeLabel = formatMideaTypeLabel(parseMideaTypeCode(dev.typeCode));
          t.textContent = `${dev.name || dev.id} · ${typeLabel}`;
          const s = document.createElement("div");
          s.className = "pf-discovered-sub";
          s.textContent = `ID: ${dev.id} · ${dev.ip}:${dev.port} · V${normalizeMideaProtocolVersion(dev.protocolVersion)}`;
          meta.append(t, s);

          const addBtn = document.createElement("button");
          addBtn.type = "button";
          addBtn.className = "secondary-button btn-compact";
          addBtn.textContent = "添加到本地列表";
          addBtn.addEventListener("click", () => {
            this.mideaForm.localDevices = mergeDiscoveredMideaDevice(
              this.mideaForm.localDevices,
              dev,
            );
            this.dirtyFlags.midea = true;
            this.renderCardBody("midea", true);
            this.notifyToast(`已添加美的设备 ${dev.ip}`, 2000);
          });

          item.append(meta, addBtn);
          discWrap.appendChild(item);
        }
        localSection.appendChild(discWrap);
      }

      // Editable Local Devices List
      const listWrap = document.createElement("div");
      listWrap.className = "pf-local-list";

      if (form.localDevices.length === 0) {
        const empty = document.createElement("div");
        empty.className = "pf-empty-local";
        empty.textContent = "暂无手动配置的本地美的设备（混合模式下可自动通过云端发现，也可扫描局域网添加）";
        listWrap.appendChild(empty);
      } else {
        form.localDevices.forEach((dev, idx) => {
          const row = document.createElement("div");
          row.className = "pf-local-row";

          const rowHead = document.createElement("div");
          rowHead.className = "pf-local-row-head";
          const rowIdx = document.createElement("span");
          rowIdx.className = "pf-local-row-idx";
          rowIdx.textContent = `美的设备 #${idx + 1}`;
          const delBtn = document.createElement("button");
          delBtn.type = "button";
          delBtn.className = "secondary-button btn-compact pf-danger-btn";
          delBtn.textContent = "删除";
          delBtn.addEventListener("click", () => {
            form.localDevices.splice(idx, 1);
            this.dirtyFlags.midea = true;
            this.renderCardBody("midea", true);
          });
          rowHead.append(rowIdx, delBtn);

          const grid1 = document.createElement("div");
          grid1.className = "pf-local-row-grid";

          const idF = this.createField("设备 ID");
          const idIn = this.createTextInput(dev.id, "数字设备 ID", "美的设备 ID");
          idIn.addEventListener("input", () => {
            dev.id = idIn.value;
            this.dirtyFlags.midea = true;
          });
          idF.appendChild(idIn);

          const nameF = this.createField("设备名称");
          const nameIn = this.createTextInput(dev.name, "如 卧室空调", "美的设备名称");
          nameIn.addEventListener("input", () => {
            dev.name = nameIn.value;
            this.dirtyFlags.midea = true;
          });
          nameF.appendChild(nameIn);

          const ipF = this.createField("IP 地址");
          const ipIn = this.createTextInput(dev.ip, "192.168.1.80", "美的设备 IP");
          ipIn.addEventListener("input", () => {
            dev.ip = ipIn.value;
            this.dirtyFlags.midea = true;
          });
          ipF.appendChild(ipIn);

          grid1.append(idF, nameF, ipF);

          const grid2 = document.createElement("div");
          grid2.className = "pf-local-row-grid pf-local-row-grid-4";

          const typeF = this.createField("品类");
          const typeOptions = MIDEA_DEVICE_TYPES.map((t) => ({
            value: String(t.code),
            label: t.label,
          }));
          if (!MIDEA_DEVICE_TYPES.some((t) => t.code === dev.type)) {
            typeOptions.push({ value: String(dev.type), label: formatMideaTypeLabel(dev.type) });
          }
          const typeSel = this.createSelect(typeOptions, String(dev.type), "美的设备品类");
          typeSel.addEventListener("change", () => {
            dev.type = parseMideaTypeCode(typeSel.value);
            this.dirtyFlags.midea = true;
          });
          typeF.appendChild(typeSel);

          const protoF = this.createField("协议");
          const protoSel = this.createSelect(
            [
              { value: "3", label: "V3 (8370 加密)" },
              { value: "2", label: "V2 (AES-ECB)" },
            ],
            String(dev.protocolVersion),
            "美的协议版本",
          );
          protoSel.addEventListener("change", () => {
            dev.protocolVersion = protoSel.value === "2" ? 2 : 3;
            this.dirtyFlags.midea = true;
          });
          protoF.appendChild(protoSel);

          const tokenF = this.createField("Token (V3)", false, dev.hasToken ? "已保存" : undefined);
          const tokenIn = this.createPasswordInput(
            dev.token ?? "",
            dev.hasToken ? "已保存（留空不变）" : "十六进制 Token",
            "美的设备 Token",
          );
          tokenIn.addEventListener("input", () => {
            dev.token = tokenIn.value;
            this.dirtyFlags.midea = true;
          });
          tokenF.appendChild(tokenIn);

          const keyF = this.createField("Key (V3)", false, dev.hasKey ? "已保存" : undefined);
          const keyIn = this.createPasswordInput(
            dev.key ?? "",
            dev.hasKey ? "已保存（留空不变）" : "十六进制 Key",
            "美的设备 Key",
          );
          keyIn.addEventListener("input", () => {
            dev.key = keyIn.value;
            this.dirtyFlags.midea = true;
          });
          keyF.appendChild(keyIn);

          grid2.append(typeF, protoF, tokenF, keyF);
          row.append(rowHead, grid1, grid2);
          listWrap.appendChild(row);
        });
      }

      localSection.appendChild(listWrap);
      bodyEl.appendChild(localSection);
    }

    bodyEl.appendChild(
      this.createPlatformActionsBar(
        "midea",
        () => void this.handleSaveMidea(),
        () => void this.handleDisconnectPlatform("midea", "已断开美的智能连接"),
      ),
    );
  }

  private async handleSaveMidea(): Promise<void> {
    const payload = buildMideaConfigPayload({
      ...this.mideaForm,
      enabled: true,
    });
    await this.savePlatformConfig("midea", payload, "美的智能配置已保存并连接");
  }

  // ---------- Card 4: 德业智能 (Deye Smart) ----------

  private renderDeyeBody(bodyEl: HTMLElement): void {
    bodyEl.replaceChildren();
    const status = this.statuses.get("deye") ?? defaultPlatformStatus("deye");
    const form = this.deyeForm;

    const desc = document.createElement("div");
    desc.className = "pf-card-desc";
    desc.textContent = status.description || PLATFORM_DISPLAY_META.deye.description;
    bodyEl.appendChild(desc);

    // Mode selector
    const modeRow = document.createElement("div");
    modeRow.className = "pf-form-grid";
    const modeField = this.createField("接入模式", true);
    const modeSelect = this.createSelect(DEYE_MODES, form.mode, "德业智能接入模式");
    modeSelect.addEventListener("change", () => {
      form.mode = modeSelect.value as UiDeyeMode;
      this.dirtyFlags.deye = true;
      this.renderCardBody("deye", true);
    });
    modeField.appendChild(modeSelect);
    modeRow.appendChild(modeField);
    bodyEl.appendChild(modeRow);

    // Section A: Deye Cloud (cloud / hybrid)
    if (form.mode === "cloud" || form.mode === "hybrid") {
      const cloudSection = document.createElement("div");
      cloudSection.className = "pf-section-box";

      const head = document.createElement("div");
      head.className = "pf-section-head";
      const secTitle = document.createElement("span");
      secTitle.className = "pf-section-title";
      secTitle.textContent = "德业智能云 (除湿机 / 空气净化器)";
      head.appendChild(secTitle);
      if (form.hasAuthToken) {
        const badge = document.createElement("span");
        badge.className = "pf-saved-pill";
        badge.textContent = "已缓存登录令牌";
        head.appendChild(badge);
      }
      cloudSection.appendChild(head);

      const grid = document.createElement("div");
      grid.className = "pf-form-grid";

      const userField = this.createField("德业账号（手机号 / 邮箱）");
      const userInput = this.createTextInput(
        form.username,
        "输入德业智能 App 账号",
        "德业云账号",
      );
      userInput.addEventListener("input", () => {
        form.username = userInput.value;
        this.dirtyFlags.deye = true;
      });
      userField.appendChild(userInput);

      const pwdField = this.createField(
        "密码",
        false,
        form.hasPassword ? "已保存，留空保持不变" : undefined,
      );
      const pwdInput = this.createPasswordInput(
        form.password ?? "",
        form.hasPassword ? "已保存（留空保持不变）" : "输入账号密码",
        "德业云密码",
      );
      pwdInput.addEventListener("input", () => {
        form.password = pwdInput.value;
        this.dirtyFlags.deye = true;
      });
      pwdField.appendChild(pwdInput);

      const epField = this.createField("自定义云端端点 (Endpoint)", true);
      const epInput = this.createTextInput(
        form.endpoint,
        DEFAULT_DEYE_ENDPOINT,
        "德业云端端点",
      );
      epInput.addEventListener("input", () => {
        form.endpoint = epInput.value;
        this.dirtyFlags.deye = true;
      });
      epField.appendChild(epInput);

      grid.append(userField, pwdField, epField);
      cloudSection.appendChild(grid);
      bodyEl.appendChild(cloudSection);
    }

    // Section B: Local Solarman V5 Inverters (solarman / hybrid)
    if (form.mode === "solarman" || form.mode === "hybrid") {
      const invSection = document.createElement("div");
      invSection.className = "pf-section-box";

      const head = document.createElement("div");
      head.className = "pf-section-head";
      const secTitle = document.createElement("span");
      secTitle.className = "pf-section-title";
      secTitle.textContent = "Solarman V5 局域网逆变器 (TCP 8899)";

      const addInvBtn = document.createElement("button");
      addInvBtn.type = "button";
      addInvBtn.className = "secondary-button btn-compact";
      addInvBtn.textContent = "+ 添加逆变器";
      addInvBtn.addEventListener("click", () => {
        form.solarmanInverters.push({
          id: "",
          name: "",
          ip: "",
          port: 8899,
          serial: "",
          slaveId: 1,
        });
        this.dirtyFlags.deye = true;
        this.renderCardBody("deye", true);
      });

      head.append(secTitle, addInvBtn);
      invSection.appendChild(head);

      const listWrap = document.createElement("div");
      listWrap.className = "pf-local-list";

      if (form.solarmanInverters.length === 0) {
        const empty = document.createElement("div");
        empty.className = "pf-empty-local";
        empty.textContent = "暂无 Solarman V5 逆变器，点击「+ 添加逆变器」填写局域网 IP 与采集器序列号";
        listWrap.appendChild(empty);
      } else {
        form.solarmanInverters.forEach((inv, idx) => {
          const row = document.createElement("div");
          row.className = "pf-local-row";

          const rowHead = document.createElement("div");
          rowHead.className = "pf-local-row-head";
          const rowIdx = document.createElement("span");
          rowIdx.className = "pf-local-row-idx";
          rowIdx.textContent = `逆变器 #${idx + 1}`;
          const delBtn = document.createElement("button");
          delBtn.type = "button";
          delBtn.className = "secondary-button btn-compact pf-danger-btn";
          delBtn.textContent = "删除";
          delBtn.addEventListener("click", () => {
            form.solarmanInverters.splice(idx, 1);
            this.dirtyFlags.deye = true;
            this.renderCardBody("deye", true);
          });
          rowHead.append(rowIdx, delBtn);

          const grid1 = document.createElement("div");
          grid1.className = "pf-form-grid";

          const nameF = this.createField("逆变器名称");
          const nameIn = this.createTextInput(inv.name, "如 屋顶储能逆变器", "逆变器名称");
          nameIn.addEventListener("input", () => {
            inv.name = nameIn.value;
            this.dirtyFlags.deye = true;
          });
          nameF.appendChild(nameIn);

          const ipF = this.createField("IP 地址");
          const ipIn = this.createTextInput(inv.ip, "192.168.1.90", "逆变器 IP");
          ipIn.addEventListener("input", () => {
            inv.ip = ipIn.value;
            this.dirtyFlags.deye = true;
          });
          ipF.appendChild(ipIn);

          grid1.append(nameF, ipF);

          const grid2 = document.createElement("div");
          grid2.className = "pf-local-row-grid";

          const serialF = this.createField("采集器序列号 (Serial)");
          const serialIn = this.createTextInput(
            inv.serial ? String(inv.serial) : "",
            "如 2712345678",
            "采集器序列号",
          );
          serialIn.addEventListener("input", () => {
            inv.serial = serialIn.value;
            this.dirtyFlags.deye = true;
          });
          serialF.appendChild(serialIn);

          const portF = this.createField("端口");
          const portIn = this.createNumberInput(inv.port ?? 8899, 1, 65535, "Solarman 端口");
          portIn.addEventListener("input", () => {
            inv.port = clampPort(portIn.value, 8899);
            this.dirtyFlags.deye = true;
          });
          portF.appendChild(portIn);

          const slaveF = this.createField("从站地址 (Slave ID)");
          const slaveIn = this.createNumberInput(inv.slaveId ?? 1, 1, 247, "Modbus 从站地址");
          slaveIn.addEventListener("input", () => {
            inv.slaveId = clampSlaveId(slaveIn.value, 1);
            this.dirtyFlags.deye = true;
          });
          slaveF.appendChild(slaveIn);

          grid2.append(serialF, portF, slaveF);
          row.append(rowHead, grid1, grid2);
          listWrap.appendChild(row);
        });
      }

      invSection.appendChild(listWrap);
      bodyEl.appendChild(invSection);
    }

    bodyEl.appendChild(
      this.createPlatformActionsBar(
        "deye",
        () => void this.handleSaveDeye(),
        () => void this.handleDisconnectPlatform("deye", "已断开德业智能连接"),
      ),
    );
  }

  private async handleSaveDeye(): Promise<void> {
    // Warn if user entered an inverter IP with an invalid/empty serial
    const invalidInv = this.deyeForm.solarmanInverters.find(
      (inv) => inv.ip.trim().length > 0 && parsePositiveSerial(inv.serial) === null,
    );
    if (invalidInv) {
      this.notifyToast("请为局域网逆变器填写有效的纯数字采集器序列号 (Serial)", 3200);
      return;
    }

    const payload = buildDeyeConfigPayload({
      ...this.deyeForm,
      enabled: true,
    });
    await this.savePlatformConfig("deye", payload, "德业智能配置已保存并连接");
  }

  // ---------- Shared Platform Actions ----------

  private async savePlatformConfig(
    id: "tuya" | "midea" | "deye",
    payload: UiTuyaConfigPayload | UiMideaConfigPayload | UiDeyeConfigPayload,
    fallbackSuccessMsg: string,
  ): Promise<void> {
    this.busyAction[id] = "saving";
    this.renderCardBody(id, true);
    try {
      const res = await this.apiPost<PlatformMutationResponse>(
        `/api/platforms/${id}/config`,
        payload,
      );
      if (this.disposed) return;
      this.dirtyFlags[id] = false;
      this.applyMutationResponse(id, res, res?.message || fallbackSuccessMsg);
    } catch (err) {
      if (!this.disposed) {
        this.notifyToast(`保存配置失败：${sanitizePlatformErrorMessage(err)}`, 3400);
      }
    } finally {
      this.busyAction[id] = null;
      if (!this.disposed) {
        this.renderCardBody(id, true);
      }
    }
  }

  private async handleDisconnectPlatform(
    id: "tuya" | "midea" | "deye",
    fallbackSuccessMsg: string,
  ): Promise<void> {
    if (id === "tuya") {
      this.stopQrPolling();
      this.activeTuyaQr = null;
    }
    this.busyAction[id] = "disconnecting";
    this.renderCardBody(id, true);
    try {
      const res = await this.apiPost<PlatformMutationResponse>(`/api/platforms/${id}/disconnect`);
      if (this.disposed) return;
      this.dirtyFlags[id] = false;
      this.applyMutationResponse(id, res, res?.message || fallbackSuccessMsg);
    } catch (err) {
      if (!this.disposed) {
        this.notifyToast(`断开连接失败：${sanitizePlatformErrorMessage(err)}`, 3400);
      }
    } finally {
      this.busyAction[id] = null;
      if (!this.disposed) {
        this.renderCardBody(id, true);
      }
    }
  }

  private applyMutationResponse(
    id: UiPlatformId,
    res: PlatformMutationResponse | undefined,
    toastMessage: string,
  ): void {
    if (Array.isArray(res?.platforms) && res.platforms.length > 0) {
      this.update(res.platforms);
    } else if (res?.platform && isUiPlatformId(res.platform.id)) {
      this.statuses.set(res.platform.id, res.platform);
      this.hydrateFormFromStatus(res.platform.id, res.platform);
      this.syncAllHeadersAndOverview();
    } else {
      void this.refresh();
    }
    this.renderCardBody(id, true);
    this.options.onPlatformsChanged?.(this.getPlatforms());
    this.notifyToast(toastMessage, 2800);
  }

  private async handleDiscoverLocal(id: "tuya" | "midea"): Promise<void> {
    this.busyAction[id] = "discovering";
    this.renderCardBody(id, true);
    try {
      const res = await this.apiPost<PlatformDiscoverResponse>(`/api/platforms/${id}/discover`, {
        timeoutMs: 3500,
      });
      if (this.disposed) return;
      const devices = Array.isArray(res?.devices) ? res.devices : [];
      this.discoveredDevices[id] = devices;
      this.notifyToast(
        devices.length > 0
          ? `局域网扫描完成，发现 ${devices.length} 台设备`
          : "未在局域网扫描到设备，请确认设备与本机处于同一网段",
        3000,
      );
    } catch (err) {
      if (!this.disposed) {
        this.notifyToast(`局域网扫描失败：${sanitizePlatformErrorMessage(err)}`, 3400);
      }
    } finally {
      this.busyAction[id] = null;
      if (!this.disposed) {
        this.renderCardBody(id, true);
      }
    }
  }

  // ---------- Reusable Safe DOM Element Builders ----------

  private createStatBox(label: string, value: string): HTMLElement {
    const box = document.createElement("div");
    box.className = "pf-stat-box";
    const lbl = document.createElement("span");
    lbl.className = "pf-stat-label";
    lbl.textContent = label;
    const val = document.createElement("span");
    val.className = "pf-stat-val";
    val.textContent = value;
    box.append(lbl, val);
    return box;
  }

  private createField(labelText: string, fullWidth = false, savedText?: string): HTMLElement {
    const field = document.createElement("div");
    field.className = fullWidth ? "pf-field pf-field-full" : "pf-field";

    const row = document.createElement("div");
    row.className = "pf-field-label-row";
    const label = document.createElement("span");
    label.className = "pf-field-label";
    label.textContent = labelText;
    row.appendChild(label);

    if (savedText) {
      const pill = document.createElement("span");
      pill.className = "pf-saved-pill";
      pill.textContent = savedText;
      row.appendChild(pill);
    }

    field.appendChild(row);
    return field;
  }

  private createTextInput(
    value: string,
    placeholder: string,
    ariaLabel: string,
  ): HTMLInputElement {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "md-text-input";
    input.value = value;
    input.placeholder = placeholder;
    input.spellcheck = false;
    input.autocomplete = "off";
    input.setAttribute("aria-label", ariaLabel);
    return input;
  }

  private createPasswordInput(
    value: string,
    placeholder: string,
    ariaLabel: string,
  ): HTMLInputElement {
    const input = document.createElement("input");
    input.type = "password";
    input.className = "md-text-input";
    input.value = value;
    input.placeholder = placeholder;
    input.spellcheck = false;
    input.autocomplete = "new-password";
    input.setAttribute("aria-label", ariaLabel);
    return input;
  }

  private createNumberInput(
    value: number,
    min: number,
    max: number,
    ariaLabel: string,
  ): HTMLInputElement {
    const input = document.createElement("input");
    input.type = "number";
    input.className = "md-text-input";
    input.value = String(value);
    input.min = String(min);
    input.max = String(max);
    input.setAttribute("aria-label", ariaLabel);
    return input;
  }

  private createSelect(
    options: ReadonlyArray<{ value: string; label: string }>,
    selectedValue: string,
    ariaLabel: string,
  ): HTMLSelectElement {
    const select = document.createElement("select");
    select.className = "md-select";
    select.setAttribute("aria-label", ariaLabel);
    for (const opt of options) {
      const optionEl = document.createElement("option");
      optionEl.value = opt.value;
      optionEl.textContent = opt.label;
      if (opt.value === selectedValue) {
        optionEl.selected = true;
      }
      select.appendChild(optionEl);
    }
    return select;
  }

  private createSwitchRow(
    title: string,
    description: string,
    checked: boolean,
    onChange: (checked: boolean) => void,
  ): HTMLElement {
    const row = document.createElement("div");
    row.className = "pf-switch-row";

    const textCol = document.createElement("div");
    textCol.className = "pf-switch-text";
    const lbl = document.createElement("span");
    lbl.className = "pf-field-label";
    lbl.textContent = title;
    const desc = document.createElement("span");
    desc.className = "pf-hint";
    desc.textContent = description;
    textCol.append(lbl, desc);

    const sw = document.createElement("label");
    sw.className = "md-switch";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = checked;
    input.setAttribute("aria-label", title);
    input.addEventListener("change", () => {
      onChange(input.checked);
    });
    const track = document.createElement("span");
    track.className = "md-switch-track";
    sw.append(input, track);

    row.append(textCol, sw);
    return row;
  }

  private createPlatformActionsBar(
    id: "tuya" | "midea" | "deye",
    onSave: () => void,
    onDisconnect: () => void,
  ): HTMLElement {
    const busy = this.busyAction[id];
    const bar = document.createElement("div");
    bar.className = "pf-actions-bar";

    const note = document.createElement("span");
    note.className = "pf-hint";
    note.textContent = "密钥与密码仅保存在本机，留空将保留已保存凭据";

    const group = document.createElement("div");
    group.className = "pf-actions-group";

    const disconnectBtn = document.createElement("button");
    disconnectBtn.type = "button";
    disconnectBtn.className = "secondary-button btn-compact pf-danger-btn";
    disconnectBtn.textContent = busy === "disconnecting" ? "正在断开…" : "断开连接";
    disconnectBtn.disabled = busy !== null;
    disconnectBtn.addEventListener("click", onDisconnect);

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "primary-button btn-compact";
    saveBtn.textContent = busy === "saving" ? "正在连接…" : "保存并连接";
    saveBtn.disabled = busy !== null;
    saveBtn.addEventListener("click", onSave);

    group.append(disconnectBtn, saveBtn);
    bar.append(note, group);
    return bar;
  }
}
