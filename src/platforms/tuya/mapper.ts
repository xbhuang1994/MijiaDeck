// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 涂鸦设备/规格/DP 到 MijiaDeck 统一模型的双向映射器

import { isLight, lightControls } from "../../core/deviceControls.ts";
import {
  createDeviceInfo,
  createPropInfo,
  type ActionInfo,
  type DeviceDetail,
  type DeviceInfo,
  type PropEnumOption,
  type PropInfo,
} from "../../core/models.ts";
import { formatMetricsText } from "../../core/service.ts";
import {
  TUYA_DP_DESC_ZH,
  TUYA_ENUM_DESC_ZH,
  TUYA_IR_AC_FAN_LABELS,
  TUYA_IR_AC_MODE_LABELS,
  TUYA_POWER_DP_CANDIDATES,
  isTuyaInfraredCategory,
  tuyaCategoryToKind,
  tuyaIrKeyDescZh,
} from "./constants.ts";
import type { TuyaDeviceSpecification, TuyaSpecFunctionItem } from "./sharingClient.ts";

const SPLIT_DID_RE = /^(.+)\.s([0-9]+)$/;
const SWITCH_CHANNEL_RE = /^switch_([1-9][0-9]*)$/;

const TEMP_DP_CODES = [
  "va_temperature",
  "temp_current",
  "temp_indoor",
  "indoor_temp",
  "temperature",
] as const;

const HUM_DP_CODES = [
  "va_humidity",
  "humidity_value",
  "humidity_indoor",
  "cur_humidity",
  "humidity",
] as const;

export interface TuyaIrRemoteKey {
  key: string;
  keyName?: string;
  keyId?: number;
  standardKey?: boolean;
  learningCode?: string;
}

export interface TuyaIrRemoteMeta {
  hubId: string;
  remoteId: string;
  categoryId?: number;
  remoteIndex?: number;
  brandName?: string;
  duplicatePower?: boolean;
  singleAir?: boolean;
  keys: TuyaIrRemoteKey[];
}

export interface TuyaDeviceRecord {
  id: string;
  name: string;
  category: string;
  productId?: string;
  model?: string;
  homeName?: string;
  roomName?: string;
  online: boolean;
  sub?: boolean;
  localKey?: string;
  ip?: string;
  status: Record<string, unknown>;
  spec?: TuyaDeviceSpecification | null;
  irRemote?: TuyaIrRemoteMeta | null;
  /** DP 代码 -> 局域网数字 DP ID（例如 "switch_led" -> "20"） */
  codeToDpId?: Record<string, string>;
  /** 局域网数字 DP ID -> DP 代码（例如 "20" -> "switch_led"） */
  dpIdToCode?: Record<string, string>;
  source: "sharing" | "openapi" | "local" | "hybrid";
}

export type TuyaBindingKind =
  | "power"
  | "ir-power"
  | "brightness"
  | "color-temperature"
  | "color-v2"
  | "color-v1"
  | "scaled-int"
  | "int-enum"
  | "bool"
  | "raw";

export interface TuyaPropBinding {
  propName: string;
  dpCode: string;
  /** 可选：读取状态时使用的 DP 代码（例如红外空调写入为 M/T/F，状态回传为 mode/temp/wind） */
  statusDpCode?: string;
  kind: TuyaBindingKind;
  min: number;
  max: number;
  step: number;
  scale: number;
  readable: boolean;
  writable: boolean;
}

export interface TuyaIrActionBinding {
  actionName: string;
  desc: string;
  dpCode: string;
  sendValue: unknown;
  hubId?: string;
  remoteId?: string;
  categoryId?: number;
  remoteIndex?: number;
  keyId?: number;
  standardKey?: boolean;
  learningCode?: string;
}

export type TuyaIrControlMode = "openapi-ir-hub" | "sharing-ac" | "sharing-limited";

export interface TuyaIrPowerConfig {
  onAction: TuyaIrActionBinding | null;
  offAction: TuyaIrActionBinding | null;
  toggleAction: TuyaIrActionBinding | null;
  statusDpCode: string | null;
  assumedState: boolean | null;
}

export interface TuyaDeviceProfile {
  did: string;
  hardwareId: string;
  channel: number | null;
  isSplitParent: boolean;
  isInfraredRemote: boolean;
  irControlMode: TuyaIrControlMode | null;
  info: DeviceInfo;
  detail: DeviceDetail;
  powerDpCode: string | null;
  tempDpCode: string | null;
  tempScale: number;
  humDpCode: string | null;
  humScale: number;
  bindingsByPropName: Map<string, TuyaPropBinding>;
  bindingsByDpCode: Map<string, TuyaPropBinding>;
  irActionsByName: Map<string, TuyaIrActionBinding>;
  irPower: TuyaIrPowerConfig | null;
  irRemote: TuyaIrRemoteMeta | null;
}

interface ParsedSpecValues {
  min?: number;
  max?: number;
  step?: number;
  scale?: number;
  unit?: string;
  enumRange?: string[];
  valueType?: string;
}

function clamp(val: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, val));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 解析多路开关拆分设备 ID（如 `bf12345.s2` -> `{ hardwareId: "bf12345", channel: 2 }`）。 */
export function parseTuyaSplitDid(nativeDid: string): { hardwareId: string; channel: number | null } {
  const m = SPLIT_DID_RE.exec(nativeDid);
  if (m) {
    return {
      hardwareId: m[1]!,
      channel: Number.parseInt(m[2]!, 10),
    };
  }
  return { hardwareId: nativeDid, channel: null };
}

// ============================================================================
// 灯光量纲与色彩空间双向转换 (Brightness / Color-Temp / RGB <-> HSV)
// ============================================================================

export function tuyaBrightnessToPercent(raw: number, min = 10, max = 1000): number {
  if (!Number.isFinite(raw)) return 1;
  if (max <= min) return 100;
  const clamped = clamp(raw, min, max);
  const pct = 1 + ((clamped - min) / (max - min)) * 99;
  return clamp(Math.round(pct), 1, 100);
}

export function percentToTuyaBrightness(percent: number, min = 10, max = 1000): number {
  if (!Number.isFinite(percent)) return min;
  if (max <= min) return min;
  const clamped = clamp(percent, 1, 100);
  const raw = min + ((clamped - 1) / 99) * (max - min);
  return clamp(Math.round(raw), min, max);
}

export function tuyaTempToKelvin(raw: number, min = 0, max = 1000): number {
  if (!Number.isFinite(raw)) return 4000;
  if (max <= min) return 2700;
  const clamped = clamp(raw, min, max);
  const kelvin = 2700 + ((clamped - min) / (max - min)) * (6500 - 2700);
  return clamp(Math.round(kelvin), 2700, 6500);
}

export function kelvinToTuyaTemp(kelvin: number, min = 0, max = 1000): number {
  if (!Number.isFinite(kelvin)) return min;
  if (max <= min) return min;
  const clamped = clamp(kelvin, 2700, 6500);
  const raw = min + ((clamped - 2700) / (6500 - 2700)) * (max - min);
  return clamp(Math.round(raw), min, max);
}

function rgbIntToHsvNorm(rgbInt: number): { h: number; s: number; v: number } {
  const clamped = clamp(Math.round(rgbInt), 0, 0xffffff);
  const r = ((clamped >> 16) & 0xff) / 255;
  const g = ((clamped >> 8) & 0xff) / 255;
  const b = (clamped & 0xff) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;

  let h = 0;
  if (delta > 0) {
    if (max === r) {
      h = 60 * (((g - b) / delta) % 6);
    } else if (max === g) {
      h = 60 * ((b - r) / delta + 2);
    } else {
      h = 60 * ((r - g) / delta + 4);
    }
    if (h < 0) h += 360;
  }

  const s = max === 0 ? 0 : delta / max;
  const v = max;
  return { h, s, v };
}

function hsvNormToRgbInt(hDeg: number, sNorm: number, vNorm: number): number {
  const h = ((hDeg % 360) + 360) % 360;
  const s = clamp(sNorm, 0, 1);
  const v = clamp(vNorm, 0, 1);

  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;

  let r1 = 0;
  let g1 = 0;
  let b1 = 0;
  if (h < 60) {
    r1 = c;
    g1 = x;
  } else if (h < 120) {
    r1 = x;
    g1 = c;
  } else if (h < 180) {
    g1 = c;
    b1 = x;
  } else if (h < 240) {
    g1 = x;
    b1 = c;
  } else if (h < 300) {
    r1 = x;
    b1 = c;
  } else {
    r1 = c;
    b1 = x;
  }

  const r = clamp(Math.round((r1 + m) * 255), 0, 255);
  const g = clamp(Math.round((g1 + m) * 255), 0, 255);
  const b = clamp(Math.round((b1 + m) * 255), 0, 255);
  return (r << 16) | (g << 8) | b;
}

/** 24 位 RGB 整数 -> Tuya `colour_data_v2` (`{ h: 0..360, s: 0..1000, v: 0..1000 }`) */
export function rgbIntToTuyaHsvV2(rgbInt: number): { h: number; s: number; v: number } {
  const { h, s, v } = rgbIntToHsvNorm(rgbInt);
  const hRounded = Math.round(h) % 360;
  return {
    h: hRounded,
    s: clamp(Math.round(s * 1000), 0, 1000),
    v: clamp(Math.round(v * 1000), 0, 1000),
  };
}

/** Tuya `colour_data_v2`（JSON 字符串或对象） -> 24 位 RGB 整数 `0xRRGGBB` */
export function tuyaHsvV2ToRgbInt(value: unknown): number | null {
  let obj: Record<string, unknown> | null = null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{")) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (isRecord(parsed)) obj = parsed;
      } catch {
        return null;
      }
    } else if (/^[0-9a-fA-F]{12}$/.test(trimmed)) {
      const h = Number.parseInt(trimmed.slice(0, 4), 16);
      const s = Number.parseInt(trimmed.slice(4, 8), 16);
      const v = Number.parseInt(trimmed.slice(8, 12), 16);
      return hsvNormToRgbInt(h, s / 1000, v / 1000);
    }
  } else if (isRecord(value)) {
    obj = value;
  }
  if (!obj) return null;
  const h = Number(obj.h);
  const s = Number(obj.s);
  const v = Number(obj.v);
  if (!Number.isFinite(h) || !Number.isFinite(s) || !Number.isFinite(v)) {
    return null;
  }
  return hsvNormToRgbInt(h, s / 1000, v / 1000);
}

/** 24 位 RGB 整数 -> Tuya `colour_data` v1 14 位十六进制串 `rrggbbhhhhssvv` */
export function rgbIntToTuyaColourV1Hex(rgbInt: number): string {
  const clamped = clamp(Math.round(rgbInt), 0, 0xffffff);
  const rgbHex = clamped.toString(16).padStart(6, "0");
  const { h, s, v } = rgbIntToHsvNorm(clamped);
  const hHex = (Math.round(h) % 360).toString(16).padStart(4, "0");
  const sHex = clamp(Math.round(s * 255), 0, 255).toString(16).padStart(2, "0");
  const vHex = clamp(Math.round(v * 255), 0, 255).toString(16).padStart(2, "0");
  return `${rgbHex}${hHex}${sHex}${vHex}`;
}

/** Tuya `colour_data` v1（14 位 `rrggbbhhhhssvv` 或 12 位 `hhhhssssvvvv`）-> 24 位 RGB 整数 */
export function tuyaColourV1HexToRgbInt(hex: string): number | null {
  const trimmed = hex.trim();
  if (/^[0-9a-fA-F]{14}$/.test(trimmed)) {
    return Number.parseInt(trimmed.slice(0, 6), 16);
  }
  if (/^[0-9a-fA-F]{12}$/.test(trimmed)) {
    const h = Number.parseInt(trimmed.slice(0, 4), 16);
    const s = Number.parseInt(trimmed.slice(4, 8), 16);
    const v = Number.parseInt(trimmed.slice(8, 12), 16);
    return hsvNormToRgbInt(h, s / 1000, v / 1000);
  }
  return null;
}

// ============================================================================
// Spec 解析与值转换
// ============================================================================

function parseSpecValues(rawValues: string | undefined): ParsedSpecValues {
  if (!rawValues) return {};
  try {
    const parsed: unknown = JSON.parse(rawValues);
    if (!isRecord(parsed)) return {};
    const out: ParsedSpecValues = {};
    if (typeof parsed.min === "number" && Number.isFinite(parsed.min)) out.min = parsed.min;
    if (typeof parsed.max === "number" && Number.isFinite(parsed.max)) out.max = parsed.max;
    if (typeof parsed.step === "number" && Number.isFinite(parsed.step)) out.step = parsed.step;
    if (typeof parsed.scale === "number" && Number.isFinite(parsed.scale)) out.scale = parsed.scale;
    if (typeof parsed.unit === "string" && parsed.unit.trim()) out.unit = parsed.unit.trim();
    if (typeof parsed.type === "string" && parsed.type.trim()) out.valueType = parsed.type.trim();
    if (Array.isArray(parsed.range)) {
      out.enumRange = parsed.range.map((v) => String(v));
    }
    return out;
  } catch {
    return {};
  }
}

function isIntegerRangeEnum(typeLower: string, values: ParsedSpecValues): boolean {
  return (
    typeLower === "enum" &&
    (!values.enumRange || values.enumRange.length === 0) &&
    values.min !== undefined &&
    values.max !== undefined
  );
}

function isInfraredKeyFunction(item: TuyaSpecFunctionItem): boolean {
  const typeLower = (item.type || "").trim().toLowerCase();
  const parsed = parseSpecValues(item.values);
  if (
    parsed.min !== undefined ||
    parsed.max !== undefined ||
    (parsed.enumRange && parsed.enumRange.length > 0)
  ) {
    return false;
  }
  return typeLower === "string" || typeLower === "boolean" || typeLower === "";
}

function resolveIrKeySendValue(item: TuyaSpecFunctionItem): string {
  const raw = typeof item.values === "string" ? item.values.trim() : "";
  if (raw && !raw.startsWith("{") && !raw.startsWith("[")) {
    return raw;
  }
  return item.code;
}

const IR_KEY_SORT_ORDER: Readonly<Record<string, number>> = {
  poweron: 10,
  power_on: 10,
  poweroff: 11,
  power_off: 11,
  power: 12,
  poweronoff: 12,
  standby: 13,
  "volume+": 20,
  "vol+": 20,
  volumeup: 20,
  volume_up: 20,
  "volume-": 21,
  "vol-": 21,
  volumedown: 21,
  volume_down: 21,
  mute: 22,
  previous: 30,
  prev: 30,
  previoustrack: 30,
  previous_track: 30,
  rewind: 31,
  rew: 31,
  play: 32,
  pause: 33,
  playpause: 34,
  "play/pause": 34,
  play_pause: 34,
  stop: 35,
  fastforward: 36,
  forward: 36,
  ff: 36,
  next: 37,
  nexttrack: 37,
  next_track: 37,
  up: 40,
  navigate_up: 40,
  down: 41,
  navigate_down: 41,
  left: 42,
  navigate_left: 42,
  right: 43,
  navigate_right: 43,
  ok: 44,
  enter: 44,
  select: 44,
  menu: 45,
  home: 46,
  homepage: 46,
  back: 47,
  return: 47,
  exit: 48,
  "channel+": 50,
  "ch+": 50,
  channelup: 50,
  channel_up: 50,
  "channel-": 51,
  "ch-": 51,
  channeldown: 51,
  channel_down: 51,
  source: 60,
  input: 61,
  signal: 62,
  mode: 63,
  eq: 64,
  bt: 65,
  bluetooth: 65,
  aux: 66,
  optical: 67,
  hdmi: 68,
  usb: 69,
};

function irKeyOrderWeight(code: string): number {
  const lower = code.trim().toLowerCase();
  if (lower in IR_KEY_SORT_ORDER) {
    return IR_KEY_SORT_ORDER[lower]!;
  }
  if (/^[1-9]$/.test(lower)) {
    return 80 + Number(lower);
  }
  if (lower === "0") {
    return 90;
  }
  if (lower === "-/--") {
    return 91;
  }
  return 75;
}

export function tuyaDpDescZh(code: string, fallback?: string): string {
  if (code in TUYA_DP_DESC_ZH) {
    return TUYA_DP_DESC_ZH[code]!;
  }
  const chMatch = SWITCH_CHANNEL_RE.exec(code);
  if (chMatch) {
    return `开关 ${chMatch[1]}`;
  }
  const cdMatch = /^countdown_([0-9]+)$/.exec(code);
  if (cdMatch) {
    return `开关 ${cdMatch[1]} 倒计时`;
  }
  if (fallback && fallback.trim()) {
    return fallback.trim();
  }
  return code;
}

function buildEnumOptions(range: string[]): PropEnumOption[] {
  return range.map((value) => {
    const zh = TUYA_ENUM_DESC_ZH[value.toLowerCase()];
    return {
      value,
      description: value,
      ...(zh ? { desc_zh_cn: zh } : {}),
    };
  });
}

interface MergedDpMeta {
  code: string;
  name?: string;
  type: string;
  values: ParsedSpecValues;
  readable: boolean;
  writable: boolean;
}

function collectMergedDps(record: TuyaDeviceRecord): Map<string, MergedDpMeta> {
  const map = new Map<string, MergedDpMeta>();

  const ingest = (items: TuyaSpecFunctionItem[] | undefined, rw: "r" | "w"): void => {
    if (!items) return;
    for (const item of items) {
      if (!item.code) continue;
      const parsed = parseSpecValues(item.values);
      const existing = map.get(item.code);
      if (existing) {
        if (rw === "r") existing.readable = true;
        if (rw === "w") existing.writable = true;
        if (!existing.name && (item.name || item.desc)) {
          existing.name = item.name || item.desc;
        }
        if (!existing.type && item.type) {
          existing.type = item.type;
        }
        existing.values = { ...existing.values, ...parsed };
      } else {
        map.set(item.code, {
          code: item.code,
          name: item.name || item.desc,
          type: item.type || "String",
          values: parsed,
          readable: true, // Tuya DPs are generally readable via status
          writable: rw === "w",
        });
      }
    }
  };

  ingest(record.spec?.status, "r");
  ingest(record.spec?.status_range, "r");
  ingest(record.spec?.functions, "w");

  // 若云端未返回 spec 或本地设备缺少 spec，从实时 status 推断基础 DP 能力
  for (const [code, value] of Object.entries(record.status)) {
    if (map.has(code)) continue;
    let inferredType = "String";
    let inferredValues: ParsedSpecValues = {};
    let writable = false;

    if (typeof value === "boolean") {
      inferredType = "Boolean";
      writable =
        (TUYA_POWER_DP_CANDIDATES as readonly string[]).includes(code) ||
        SWITCH_CHANNEL_RE.test(code) ||
        code === "child_lock" ||
        code === "anion" ||
        code === "uv" ||
        code === "sleep" ||
        code === "eco";
    } else if (typeof value === "number") {
      inferredType = "Integer";
      if (code === "bright_value_v2") {
        inferredValues = { min: 10, max: 1000, step: 1, scale: 0 };
        writable = true;
      } else if (code === "bright_value") {
        inferredValues = { min: 25, max: 255, step: 1, scale: 0 };
        writable = true;
      } else if (code === "temp_value_v2") {
        inferredValues = { min: 0, max: 1000, step: 1, scale: 0 };
        writable = true;
      } else if (code === "temp_value") {
        inferredValues = { min: 0, max: 255, step: 1, scale: 0 };
        writable = true;
      } else if (code === "va_temperature" || code === "temp_current") {
        inferredValues = { scale: Math.abs(value) > 60 ? 1 : 0, unit: "°C" };
      } else if (code === "va_humidity" || code === "humidity_value" || code === "humidity_indoor") {
        inferredValues = { scale: value > 100 ? 1 : 0, unit: "%" };
      } else if (code === "temp_set" || code === "humidity_set" || code === "dehumidify_set_value" || code === "percent_control") {
        writable = true;
      }
    } else if (typeof value === "string" || isRecord(value)) {
      if (code === "colour_data_v2" || code === "colour_data") {
        inferredType = "Json";
        writable = true;
      } else if (code === "work_mode" || code === "mode" || code === "fan_speed_enum" || code === "control") {
        inferredType = "Enum";
        writable = true;
      }
    }

    map.set(code, {
      code,
      type: inferredType,
      values: inferredValues,
      readable: true,
      writable,
    });
  }

  // 离线局域网设备在首次列表同步时 status 可能为空；按已知 DP 映射补齐主电源 DP，避免无法发起局域网控制
  if (record.source === "local" && map.size === 0 && record.dpIdToCode) {
    const knownCodes = new Set(Object.values(record.dpIdToCode));
    for (const candidate of TUYA_POWER_DP_CANDIDATES) {
      if (knownCodes.has(candidate)) {
        map.set(candidate, {
          code: candidate,
          type: "Boolean",
          values: {},
          readable: true,
          writable: true,
        });
        break;
      }
    }
  }

  return map;
}

/** 检测多路开关通道编号（仅 >= 2 路 `switch_1` / `switch_2` ... 时拆分）。 */
export function detectSwitchChannels(record: TuyaDeviceRecord): number[] {
  const channels = new Set<number>();
  const checkCode = (code: string): void => {
    const m = SWITCH_CHANNEL_RE.exec(code);
    if (m) {
      channels.add(Number.parseInt(m[1]!, 10));
    }
  };
  for (const item of record.spec?.functions ?? []) checkCode(item.code);
  for (const item of record.spec?.status ?? []) checkCode(item.code);
  for (const item of record.spec?.status_range ?? []) checkCode(item.code);
  for (const code of Object.keys(record.status)) checkCode(code);

  const sorted = [...channels].sort((a, b) => a - b);
  return sorted.length >= 2 ? sorted : [];
}

function findPrimaryPowerDp(dps: Map<string, MergedDpMeta>): string | null {
  for (const candidate of TUYA_POWER_DP_CANDIDATES) {
    const meta = dps.get(candidate);
    if (meta && meta.type.toLowerCase() === "boolean") {
      return candidate;
    }
  }
  for (const candidate of TUYA_POWER_DP_CANDIDATES) {
    if (dps.has(candidate)) {
      return candidate;
    }
  }
  return null;
}

function buildBindingAndPropForDp(
  meta: MergedDpMeta,
  canonicalPowerDp: string | null,
  isLightDevice: boolean,
  hasV2LightDps: { bright: boolean; temp: boolean; colour: boolean },
): { prop: PropInfo; binding: TuyaPropBinding } | null {
  const { code, values, readable, writable } = meta;

  // 1. Canonical power DP -> "on"
  if (canonicalPowerDp && code === canonicalPowerDp) {
    return {
      prop: createPropInfo({
        name: "on",
        desc: "开关",
        type: "bool",
        readable,
        writable: true,
        service: "power",
        service_desc: "电源",
      }),
      binding: {
        propName: "on",
        dpCode: code,
        kind: "power",
        min: 0,
        max: 1,
        step: 1,
        scale: 0,
        readable,
        writable: true,
      },
    };
  }

  // 2. Light canonical controls
  if (isLightDevice) {
    if (code === "bright_value_v2" || (code === "bright_value" && !hasV2LightDps.bright)) {
      const min = values.min ?? (code === "bright_value_v2" ? 10 : 25);
      const max = values.max ?? (code === "bright_value_v2" ? 1000 : 255);
      return {
        prop: createPropInfo({
          name: "brightness",
          desc: "亮度",
          type: "uint",
          readable,
          writable,
          range: [1, 100, 1],
          unit: "percentage",
          service: "light",
          service_desc: "灯光",
        }),
        binding: {
          propName: "brightness",
          dpCode: code,
          kind: "brightness",
          min,
          max,
          step: values.step ?? 1,
          scale: 0,
          readable,
          writable,
        },
      };
    }
    if (code === "temp_value_v2" || (code === "temp_value" && !hasV2LightDps.temp)) {
      const min = values.min ?? 0;
      const max = values.max ?? (code === "temp_value_v2" ? 1000 : 255);
      return {
        prop: createPropInfo({
          name: "color-temperature",
          desc: "色温",
          type: "uint",
          readable,
          writable,
          range: [2700, 6500, 1],
          unit: "kelvin",
          service: "light",
          service_desc: "灯光",
        }),
        binding: {
          propName: "color-temperature",
          dpCode: code,
          kind: "color-temperature",
          min,
          max,
          step: values.step ?? 1,
          scale: 0,
          readable,
          writable,
        },
      };
    }
    if (code === "colour_data_v2" || (code === "colour_data" && !hasV2LightDps.colour)) {
      return {
        prop: createPropInfo({
          name: "color",
          desc: "颜色",
          type: "uint",
          readable,
          writable,
          range: [0, 0xffffff, 1],
          value_list: null,
          service: "light",
          service_desc: "灯光",
        }),
        binding: {
          propName: "color",
          dpCode: code,
          kind: code === "colour_data_v2" ? "color-v2" : "color-v1",
          min: 0,
          max: 0xffffff,
          step: 1,
          scale: 0,
          readable,
          writable,
        },
      };
    }
  }

  // 3. Generic Tuya DP mapping
  const typeLower = meta.type.toLowerCase();
  const desc = tuyaDpDescZh(code, meta.name);

  if (typeLower === "boolean") {
    return {
      prop: createPropInfo({
        name: code,
        desc,
        type: "bool",
        readable,
        writable,
      }),
      binding: {
        propName: code,
        dpCode: code,
        kind: "bool",
        min: 0,
        max: 1,
        step: 1,
        scale: 0,
        readable,
        writable,
      },
    };
  }

  if (typeLower === "integer" || isIntegerRangeEnum(typeLower, values)) {
    const scale = values.scale ?? 0;
    const factor = 10 ** scale;
    const rawMin = values.min ?? 0;
    const rawMax = values.max ?? (values.min !== undefined ? values.min + 100 : 1000);
    const rawStep = values.step ?? 1;
    const hasBounds = values.min !== undefined && values.max !== undefined;
    const range: [number, number, number] | null = hasBounds
      ? [
          Number((rawMin / factor).toFixed(scale)),
          Number((rawMax / factor).toFixed(scale)),
          Number((rawStep / factor).toFixed(scale)) || 1,
        ]
      : null;

    return {
      prop: createPropInfo({
        name: code,
        desc: code === "C" ? "频道" : desc,
        type: scale > 0 ? "float" : rawMin >= 0 ? "uint" : "int",
        readable,
        writable,
        range,
        unit: values.unit ?? null,
      }),
      binding: {
        propName: code,
        dpCode: code,
        kind: "scaled-int",
        min: rawMin,
        max: rawMax,
        step: rawStep,
        scale,
        readable,
        writable,
      },
    };
  }

  if (typeLower === "enum") {
    const valueList =
      values.enumRange && values.enumRange.length > 0 ? buildEnumOptions(values.enumRange) : null;
    return {
      prop: createPropInfo({
        name: code,
        desc,
        type: "string",
        readable,
        writable,
        value_list: valueList,
      }),
      binding: {
        propName: code,
        dpCode: code,
        kind: "raw",
        min: 0,
        max: 0,
        step: 1,
        scale: 0,
        readable,
        writable,
      },
    };
  }

  return {
    prop: createPropInfo({
      name: code,
      desc,
      type: "string",
      readable,
      writable,
    }),
    binding: {
      propName: code,
      dpCode: code,
      kind: "raw",
      min: 0,
      max: 0,
      step: 1,
      scale: 0,
      readable,
      writable,
    },
  };
}

/** 将涂鸦原始 DP 值转换为 MijiaDeck 属性值。 */
export function tuyaRawValueToMijiaProp(binding: TuyaPropBinding, rawValue: unknown): unknown {
  if (rawValue === undefined || rawValue === null) return null;
  switch (binding.kind) {
    case "power":
    case "ir-power":
    case "bool":
      return Boolean(rawValue);
    case "brightness":
      return tuyaBrightnessToPercent(Number(rawValue), binding.min, binding.max);
    case "color-temperature":
      return tuyaTempToKelvin(Number(rawValue), binding.min, binding.max);
    case "color-v2":
      return tuyaHsvV2ToRgbInt(rawValue);
    case "color-v1":
      return typeof rawValue === "string" ? tuyaColourV1HexToRgbInt(rawValue) : null;
    case "int-enum": {
      const num = Number(rawValue);
      return Number.isFinite(num) ? Math.round(num) : null;
    }
    case "scaled-int": {
      const num = Number(rawValue);
      if (!Number.isFinite(num)) return null;
      if (binding.scale > 0) {
        return Number((num / 10 ** binding.scale).toFixed(binding.scale));
      }
      return num;
    }
    case "raw":
      return rawValue;
  }
}

/** 将 MijiaDeck 属性值转换为涂鸦设备命令所需的原始 DP 值。 */
export function mijiaPropValueToTuyaRaw(binding: TuyaPropBinding, userValue: unknown): unknown {
  switch (binding.kind) {
    case "power":
    case "ir-power":
    case "bool": {
      if (typeof userValue === "boolean") return userValue;
      if (typeof userValue === "number") return userValue !== 0;
      if (typeof userValue === "string") {
        const lower = userValue.trim().toLowerCase();
        return lower === "true" || lower === "1" || lower === "on";
      }
      return Boolean(userValue);
    }
    case "brightness":
      return percentToTuyaBrightness(Number(userValue), binding.min, binding.max);
    case "color-temperature":
      return kelvinToTuyaTemp(Number(userValue), binding.min, binding.max);
    case "color-v2":
      return JSON.stringify(rgbIntToTuyaHsvV2(Number(userValue)));
    case "color-v1":
      return rgbIntToTuyaColourV1Hex(Number(userValue));
    case "int-enum": {
      const num = Number(userValue);
      if (!Number.isFinite(num)) {
        throw new Error(`属性 ${binding.propName} 需要整数枚举值`);
      }
      const rounded = Math.round(num);
      return binding.max >= binding.min ? clamp(rounded, binding.min, binding.max) : rounded;
    }
    case "scaled-int": {
      const num = Number(userValue);
      if (!Number.isFinite(num)) {
        throw new Error(`属性 ${binding.propName} 需要数值参数`);
      }
      const scaled = Math.round(num * 10 ** binding.scale);
      if (binding.max > binding.min) {
        return clamp(scaled, binding.min, binding.max);
      }
      return scaled;
    }
    case "raw":
      return userValue;
  }
}

function resolveMetricDps(dps: Map<string, MergedDpMeta>): {
  tempDpCode: string | null;
  tempScale: number;
  humDpCode: string | null;
  humScale: number;
  metricFeatures: string[];
} {
  let tempDpCode: string | null = null;
  let tempScale = 0;
  for (const candidate of TEMP_DP_CODES) {
    const meta = dps.get(candidate);
    if (meta) {
      tempDpCode = candidate;
      tempScale = meta.values.scale ?? 0;
      break;
    }
  }

  let humDpCode: string | null = null;
  let humScale = 0;
  for (const candidate of HUM_DP_CODES) {
    const meta = dps.get(candidate);
    if (meta) {
      humDpCode = candidate;
      humScale = meta.values.scale ?? 0;
      break;
    }
  }

  const metricFeatures: string[] = [];
  if (tempDpCode) metricFeatures.push("temperature");
  if (humDpCode) metricFeatures.push("relative-humidity");
  if (metricFeatures.length === 0) {
    if (dps.has("pm25_value") || dps.has("pm25")) metricFeatures.push("pm25");
    if (dps.has("co2_value")) metricFeatures.push("co2");
    if (dps.has("cur_power")) metricFeatures.push("power");
  }

  return { tempDpCode, tempScale, humDpCode, humScale, metricFeatures };
}

/** 格式化涂鸦设备卡片实时指标文案（温湿度复用 MijiaDeck 核心 formatMetricsText）。 */
export function formatTuyaDeviceMetrics(
  profile: TuyaDeviceProfile,
  status: Record<string, unknown>,
): string | null {
  let temp: number | null = null;
  let hum: number | null = null;

  if (profile.tempDpCode && status[profile.tempDpCode] !== undefined && status[profile.tempDpCode] !== null) {
    const raw = Number(status[profile.tempDpCode]);
    if (Number.isFinite(raw)) {
      temp = profile.tempScale > 0 ? raw / 10 ** profile.tempScale : raw;
    }
  }

  if (profile.humDpCode && status[profile.humDpCode] !== undefined && status[profile.humDpCode] !== null) {
    const raw = Number(status[profile.humDpCode]);
    if (Number.isFinite(raw)) {
      hum = profile.humScale > 0 ? raw / 10 ** profile.humScale : raw;
    }
  }

  const primary = formatMetricsText(temp, hum);
  if (primary) {
    return primary;
  }

  const extras: string[] = [];
  const pm25Raw = status.pm25_value ?? status.pm25;
  if (pm25Raw !== undefined && pm25Raw !== null && Number.isFinite(Number(pm25Raw))) {
    extras.push(`PM2.5 ${Number(pm25Raw)}`);
  }
  if (status.co2_value !== undefined && status.co2_value !== null && Number.isFinite(Number(status.co2_value))) {
    extras.push(`CO₂ ${Number(status.co2_value)}ppm`);
  }
  if (status.cur_power !== undefined && status.cur_power !== null && Number.isFinite(Number(status.cur_power))) {
    const binding = profile.bindingsByDpCode.get("cur_power");
    const scale = binding?.scale ?? 1;
    const watts = Number(status.cur_power) / 10 ** scale;
    extras.push(`${watts.toFixed(1)}W`);
  }
  return extras.length > 0 ? extras.join(" ") : null;
}

function buildIrAcIntEnumOptions(
  min: number,
  max: number,
  step: number,
  labelMap: Readonly<Record<number, { description: string; desc_zh_cn: string }>>,
): PropEnumOption[] {
  const options: PropEnumOption[] = [];
  const safeStep = step > 0 ? step : 1;
  for (let v = min; v <= max; v += safeStep) {
    const meta = labelMap[v];
    options.push({
      value: v,
      description: meta?.description ?? String(v),
      ...(meta?.desc_zh_cn ? { desc_zh_cn: meta.desc_zh_cn } : {}),
    });
  }
  return options;
}

function mapInfraredRemoteDevice(
  record: TuyaDeviceRecord,
  category: string,
  baseKind: string,
  model: string,
  homeName: string,
  roomName: string,
): {
  cards: DeviceInfo[];
  profiles: Map<string, TuyaDeviceProfile>;
} {
  const specType = `urn:tuya:device:${baseKind}:1`;
  const props: PropInfo[] = [];
  const actions: ActionInfo[] = [];
  const bindingsByPropName = new Map<string, TuyaPropBinding>();
  const bindingsByDpCode = new Map<string, TuyaPropBinding>();
  const irActionsByName = new Map<string, TuyaIrActionBinding>();

  const statusCodes = new Set<string>([
    ...(record.spec?.status ?? []).map((s) => s.code),
    ...(record.spec?.status_range ?? []).map((s) => s.code),
    ...Object.keys(record.status),
  ]);

  const rawActions: Array<{ action: ActionInfo; binding: TuyaIrActionBinding; index: number }> = [];
  const consumedFuncCodes = new Set<string>();
  const consumedStatusCodes = new Set<string>();

  // 1. 识别 OpenAPI v2.0 权威按键表 vs 云端 specifications.functions 通用占位按键
  const functions = record.spec?.functions ?? [];
  const isIrAc = category === "infrared_ac";
  const hasAuthoritativeOpenApiKeys = Boolean(
    !isIrAc &&
      record.irRemote &&
      record.irRemote.hubId &&
      record.irRemote.remoteId &&
      record.irRemote.keys.length > 0,
  );

  // 非空调遥控器若已通过 OpenAPI IR Control Hub 拉取到真实按键表（标准键/配对规则键/DIY学习码），
  // 以真实按键表为准，避免保留 /specifications 中的通用占位按键（如真实遥控器仅有单键 Power 时残留无效 PowerOn/PowerOff）
  if (!hasAuthoritativeOpenApiKeys) {
    for (const fn of functions) {
      if (!fn.code) continue;
      if (isInfraredKeyFunction(fn)) {
        consumedFuncCodes.add(fn.code);
        const desc = tuyaIrKeyDescZh(fn.code, fn.name || fn.desc);
        const binding: TuyaIrActionBinding = {
          actionName: fn.code,
          desc,
          dpCode: fn.code,
          sendValue: resolveIrKeySendValue(fn),
        };
        rawActions.push({
          action: {
            name: fn.code,
            desc,
            service: "ir-remote",
            service_desc: "红外遥控",
          },
          binding,
          index: rawActions.length,
        });
      }
    }
  } else {
    // 仍标记所有键类 function 已消费，防止在步骤 5 中被渲染成无意义的文本输入属性
    for (const fn of functions) {
      if (fn.code && isInfraredKeyFunction(fn)) {
        consumedFuncCodes.add(fn.code);
      }
    }
  }

  // 2. 合并 OpenAPI v2.0 /v2.0/infrareds/{hubId}/remotes/{remoteId}/keys 返回的按键元数据（支持标准键/配对规则键/DIY学习码）
  if (record.irRemote) {
    const meta = record.irRemote;
    for (const k of meta.keys) {
      const keyCode = k.key.trim();
      if (!keyCode) continue;
      // 空调遥控器的 M/T/F 由下方步骤 4 映射为标准空调属性，避免重复作为普通按键展示
      if (isIrAc && (keyCode === "M" || keyCode === "T" || keyCode === "F")) {
        continue;
      }
      const existing = rawActions.find(
        (entry) => entry.binding.actionName.toLowerCase() === keyCode.toLowerCase(),
      );
      if (existing) {
        existing.binding.hubId = meta.hubId;
        existing.binding.remoteId = meta.remoteId;
        if (meta.categoryId !== undefined) existing.binding.categoryId = meta.categoryId;
        if (meta.remoteIndex !== undefined) existing.binding.remoteIndex = meta.remoteIndex;
        if (k.keyId !== undefined) existing.binding.keyId = k.keyId;
        if (k.standardKey !== undefined) existing.binding.standardKey = k.standardKey;
        if (k.learningCode) existing.binding.learningCode = k.learningCode;
        if (k.keyName && k.keyName.trim()) {
          const nextDesc = tuyaIrKeyDescZh(keyCode, k.keyName);
          if (existing.action.desc === existing.action.name || nextDesc !== keyCode) {
            existing.action.desc = nextDesc;
            existing.binding.desc = nextDesc;
          }
        }
      } else {
        const desc = tuyaIrKeyDescZh(keyCode, k.keyName);
        const binding: TuyaIrActionBinding = {
          actionName: keyCode,
          desc,
          dpCode: keyCode,
          sendValue: keyCode,
          hubId: meta.hubId,
          remoteId: meta.remoteId,
          ...(meta.categoryId !== undefined ? { categoryId: meta.categoryId } : {}),
          ...(meta.remoteIndex !== undefined ? { remoteIndex: meta.remoteIndex } : {}),
          ...(k.keyId !== undefined ? { keyId: k.keyId } : {}),
          ...(k.standardKey !== undefined ? { standardKey: k.standardKey } : {}),
          ...(k.learningCode ? { learningCode: k.learningCode } : {}),
        };
        rawActions.push({
          action: {
            name: keyCode,
            desc,
            service: "ir-remote",
            service_desc: "红外遥控",
          },
          binding,
          index: rawActions.length,
        });
      }
    }
  }

  // 按遥控器自然分区顺序排序（电源 -> 音量 -> 播放 -> 方向 -> 频道 -> 信号源 -> 自定义 -> 数字）
  rawActions.sort(
    (a, b) =>
      irKeyOrderWeight(a.action.name) - irKeyOrderWeight(b.action.name) || a.index - b.index,
  );
  for (const entry of rawActions) {
    actions.push(entry.action);
    irActionsByName.set(entry.binding.actionName, entry.binding);
  }

  // 3. 识别红外电源键（独立 PowerOn/PowerOff 或单键 Power/PowerOnOff），映射为标准可写 `on` 属性
  const findIrAction = (candidates: readonly string[]): TuyaIrActionBinding | null => {
    for (const c of candidates) {
      for (const binding of irActionsByName.values()) {
        if (binding.actionName.toLowerCase() === c) {
          return binding;
        }
      }
    }
    return null;
  };
  const onAction = findIrAction(["poweron", "power_on"]);
  const offAction = findIrAction(["poweroff", "power_off"]);
  const toggleAction = findIrAction(["power", "poweronoff", "power_toggle"]);
  const powerStatusDpCode = statusCodes.has("power") ? "power" : null;

  let irPower: TuyaIrPowerConfig | null = null;
  if (onAction || offAction || toggleAction) {
    const initialPower =
      powerStatusDpCode && typeof record.status[powerStatusDpCode] === "boolean"
        ? (record.status[powerStatusDpCode] as boolean)
        : null;
    irPower = {
      onAction,
      offAction,
      toggleAction,
      statusDpCode: powerStatusDpCode,
      assumedState: initialPower,
    };
    if (powerStatusDpCode) {
      consumedStatusCodes.add(powerStatusDpCode);
    }
    const powerBinding: TuyaPropBinding = {
      propName: "on",
      dpCode: onAction?.dpCode ?? toggleAction?.dpCode ?? powerStatusDpCode ?? "PowerOn",
      ...(powerStatusDpCode ? { statusDpCode: powerStatusDpCode } : {}),
      kind: "ir-power",
      min: 0,
      max: 1,
      step: 1,
      scale: 0,
      readable: Boolean(powerStatusDpCode),
      writable: true,
    };
    props.push(
      createPropInfo({
        name: "on",
        desc: "开关",
        type: "bool",
        readable: Boolean(powerStatusDpCode),
        writable: true,
        service: "power",
        service_desc: "电源",
      }),
    );
    bindingsByPropName.set("on", powerBinding);
    if (powerStatusDpCode) {
      bindingsByDpCode.set(powerStatusDpCode, powerBinding);
    }
  }

  // 4. 针对红外空调 (infrared_ac) 映射 M / T / F -> 标准 mode / target-temperature / fan-level
  if (isIrAc) {
    const funcByCode = new Map(functions.map((f) => [f.code, f]));

    const modeFn = funcByCode.get("M");
    if (modeFn) {
      consumedFuncCodes.add("M");
      const parsed = parseSpecValues(modeFn.values);
      const min = parsed.min ?? 0;
      const max = parsed.max ?? 4;
      const step = parsed.step ?? 1;
      const hasStatus = statusCodes.has("mode");
      if (hasStatus) consumedStatusCodes.add("mode");
      const binding: TuyaPropBinding = {
        propName: "mode",
        dpCode: "M",
        ...(hasStatus ? { statusDpCode: "mode" } : {}),
        kind: "int-enum",
        min,
        max,
        step,
        scale: 0,
        readable: hasStatus,
        writable: true,
      };
      props.push(
        createPropInfo({
          name: "mode",
          desc: "运行模式",
          type: "int",
          readable: hasStatus,
          writable: true,
          value_list: buildIrAcIntEnumOptions(min, max, step, TUYA_IR_AC_MODE_LABELS),
          service: "air-conditioner",
          service_desc: "空调控制",
        }),
      );
      bindingsByPropName.set("mode", binding);
      bindingsByDpCode.set("M", binding);
      bindingsByDpCode.set("mode", binding);
    }

    const tempFn = funcByCode.get("T");
    if (tempFn) {
      consumedFuncCodes.add("T");
      const parsed = parseSpecValues(tempFn.values);
      const min = parsed.min ?? 16;
      const max = parsed.max ?? 30;
      const step = parsed.step ?? 1;
      const hasStatus = statusCodes.has("temp");
      if (hasStatus) consumedStatusCodes.add("temp");
      const binding: TuyaPropBinding = {
        propName: "target-temperature",
        dpCode: "T",
        ...(hasStatus ? { statusDpCode: "temp" } : {}),
        kind: "scaled-int",
        min,
        max,
        step,
        scale: 0,
        readable: hasStatus,
        writable: true,
      };
      props.push(
        createPropInfo({
          name: "target-temperature",
          desc: "目标温度",
          type: "uint",
          readable: hasStatus,
          writable: true,
          range: [min, max, step],
          unit: "celsius",
          service: "air-conditioner",
          service_desc: "空调控制",
        }),
      );
      bindingsByPropName.set("target-temperature", binding);
      bindingsByDpCode.set("T", binding);
      bindingsByDpCode.set("temp", binding);
    }

    const fanFn = funcByCode.get("F");
    if (fanFn) {
      consumedFuncCodes.add("F");
      const parsed = parseSpecValues(fanFn.values);
      const min = parsed.min ?? 0;
      const max = parsed.max ?? 3;
      const step = parsed.step ?? 1;
      const hasStatus = statusCodes.has("wind");
      if (hasStatus) consumedStatusCodes.add("wind");
      const binding: TuyaPropBinding = {
        propName: "fan-level",
        dpCode: "F",
        ...(hasStatus ? { statusDpCode: "wind" } : {}),
        kind: "int-enum",
        min,
        max,
        step,
        scale: 0,
        readable: hasStatus,
        writable: true,
      };
      props.push(
        createPropInfo({
          name: "fan-level",
          desc: "风速",
          type: "int",
          readable: hasStatus,
          writable: true,
          value_list: buildIrAcIntEnumOptions(min, max, step, TUYA_IR_AC_FAN_LABELS),
          service: "air-conditioner",
          service_desc: "空调控制",
        }),
      );
      bindingsByPropName.set("fan-level", binding);
      bindingsByDpCode.set("F", binding);
      bindingsByDpCode.set("wind", binding);
    }
  }

  // 5. 保留其他非按键类可调参数（例如红外电视的 C 频道数值枚举 1-999）与其他只读状态
  const remainingDps = new Map<string, MergedDpMeta>();
  for (const item of record.spec?.status ?? []) {
    if (!item.code || consumedStatusCodes.has(item.code) || consumedFuncCodes.has(item.code)) continue;
    remainingDps.set(item.code, {
      code: item.code,
      name: item.name || item.desc,
      type: item.type || "String",
      values: parseSpecValues(item.values),
      readable: true,
      writable: false,
    });
  }
  for (const item of functions) {
    if (!item.code || consumedFuncCodes.has(item.code)) continue;
    const parsed = parseSpecValues(item.values);
    const existing = remainingDps.get(item.code);
    if (existing) {
      existing.writable = true;
      existing.values = { ...existing.values, ...parsed };
    } else {
      remainingDps.set(item.code, {
        code: item.code,
        name: item.name || item.desc,
        type: item.type || "String",
        values: parsed,
        readable: statusCodes.has(item.code),
        writable: true,
      });
    }
  }

  for (const meta of remainingDps.values()) {
    const built = buildBindingAndPropForDp(meta, null, false, {
      bright: false,
      temp: false,
      colour: false,
    });
    if (!built || bindingsByPropName.has(built.binding.propName)) continue;
    props.push(built.prop);
    bindingsByPropName.set(built.binding.propName, built.binding);
    bindingsByDpCode.set(built.binding.dpCode, built.binding);
  }

  const info = createDeviceInfo({
    did: record.id,
    name: record.name,
    model,
    home_name: homeName,
    room_name: roomName,
    online: record.online,
    spec_type: specType,
    switch_channels: [],
    light_features: [],
    metric_features: [],
    platform: "tuya",
  });

  const detail: DeviceDetail = {
    did: record.id,
    name: record.name,
    model,
    props,
    actions,
  };

  const irControlMode: TuyaIrControlMode =
    record.irRemote && record.irRemote.hubId && record.irRemote.remoteId
      ? "openapi-ir-hub"
      : isIrAc
        ? "sharing-ac"
        : "sharing-limited";

  const profiles = new Map<string, TuyaDeviceProfile>();
  profiles.set(record.id, {
    did: record.id,
    hardwareId: record.id,
    channel: null,
    isSplitParent: false,
    isInfraredRemote: true,
    irControlMode,
    info,
    detail,
    powerDpCode: null,
    tempDpCode: null,
    tempScale: 0,
    humDpCode: null,
    humScale: 0,
    bindingsByPropName,
    bindingsByDpCode,
    irActionsByName,
    irPower,
    irRemote: record.irRemote ?? null,
  });

  return { cards: [info], profiles };
}

/**
 * 将单台涂鸦设备映射为一个或多个 MijiaDeck `DeviceInfo` 卡片与 `TuyaDeviceProfile`：
 * - 多路开关（含 >=2 路 `switch_1`, `switch_2`, ...）自动拆分为父面板卡片 + `<id>.s1`, `<id>.s2`, ... 子卡片；
 * - 涂鸦红外虚拟遥控器（`infrared_*`）映射为按键动作集合与红外开关/空调控制模型。
 */
export function mapTuyaDeviceToCards(record: TuyaDeviceRecord): {
  cards: DeviceInfo[];
  profiles: Map<string, TuyaDeviceProfile>;
} {
  const category = (record.category || record.spec?.category || "").toLowerCase();
  const baseKind = tuyaCategoryToKind(category);
  const model = record.model?.startsWith("tuya.")
    ? record.model
    : `tuya.${category || "generic"}.${record.productId || "default"}`;
  const homeName = record.homeName?.trim() || "涂鸦家庭";
  const roomName = record.roomName?.trim() || "默认房间";

  if (isTuyaInfraredCategory(category) || Boolean(record.irRemote)) {
    return mapInfraredRemoteDevice(record, category, baseKind, model, homeName, roomName);
  }

  const mergedDps = collectMergedDps(record);
  const splitChannels = detectSwitchChannels(record);
  const profiles = new Map<string, TuyaDeviceProfile>();
  const cards: DeviceInfo[] = [];

  if (splitChannels.length >= 2) {
    const channelDids = splitChannels.map((n) => `${record.id}.s${n}`);
    const metrics = resolveMetricDps(mergedDps);

    // 1. Parent panel card (spec_type = switch so deviceControls.prepareDeviceCards preserves switch_channels)
    const parentProps: PropInfo[] = [];
    const parentByProp = new Map<string, TuyaPropBinding>();
    const parentByDp = new Map<string, TuyaPropBinding>();
    for (const meta of mergedDps.values()) {
      if (SWITCH_CHANNEL_RE.test(meta.code)) continue;
      const built = buildBindingAndPropForDp(meta, null, false, {
        bright: false,
        temp: false,
        colour: false,
      });
      if (!built) continue;
      parentProps.push(built.prop);
      parentByProp.set(built.binding.propName, built.binding);
      parentByDp.set(built.binding.dpCode, built.binding);
    }

    const parentInfo = createDeviceInfo({
      did: record.id,
      name: record.name,
      model,
      home_name: homeName,
      room_name: roomName,
      online: record.online,
      spec_type: "urn:tuya:device:switch:1",
      switch_channels: channelDids,
      light_features: [],
      metric_features: metrics.metricFeatures,
      platform: "tuya",
    });
    const parentDetail: DeviceDetail = {
      did: record.id,
      name: record.name,
      model,
      props: parentProps,
      actions: [],
    };
    cards.push(parentInfo);
    profiles.set(record.id, {
      did: record.id,
      hardwareId: record.id,
      channel: null,
      isSplitParent: true,
      isInfraredRemote: false,
      irControlMode: null,
      info: parentInfo,
      detail: parentDetail,
      powerDpCode: null,
      tempDpCode: metrics.tempDpCode,
      tempScale: metrics.tempScale,
      humDpCode: metrics.humDpCode,
      humScale: metrics.humScale,
      bindingsByPropName: parentByProp,
      bindingsByDpCode: parentByDp,
      irActionsByName: new Map(),
      irPower: null,
      irRemote: null,
    });

    // 2. Child switch channel cards: <id>.s1, <id>.s2, ...
    for (const ch of splitChannels) {
      const childDid = `${record.id}.s${ch}`;
      const dpCode = `switch_${ch}`;
      const switchMeta = mergedDps.get(dpCode) ?? {
        code: dpCode,
        type: "Boolean",
        values: {},
        readable: true,
        writable: true,
      };
      const childName = `${record.name} ${ch}路`;
      const childProps: PropInfo[] = [];
      const childByProp = new Map<string, TuyaPropBinding>();
      const childByDp = new Map<string, TuyaPropBinding>();

      const powerBuilt = buildBindingAndPropForDp(switchMeta, dpCode, false, {
        bright: false,
        temp: false,
        colour: false,
      });
      if (powerBuilt) {
        childProps.push(powerBuilt.prop);
        childByProp.set(powerBuilt.binding.propName, powerBuilt.binding);
        childByDp.set(powerBuilt.binding.dpCode, powerBuilt.binding);
      }

      const countdownCode = `countdown_${ch}`;
      const countdownMeta = mergedDps.get(countdownCode);
      if (countdownMeta) {
        const cdBuilt = buildBindingAndPropForDp(countdownMeta, null, false, {
          bright: false,
          temp: false,
          colour: false,
        });
        if (cdBuilt) {
          childProps.push(cdBuilt.prop);
          childByProp.set(cdBuilt.binding.propName, cdBuilt.binding);
          childByDp.set(cdBuilt.binding.dpCode, cdBuilt.binding);
        }
      }

      const childInfo = createDeviceInfo({
        did: childDid,
        name: childName,
        model,
        home_name: homeName,
        room_name: roomName,
        online: record.online,
        spec_type: "urn:tuya:device:switch:1",
        switch_channels: [],
        light_features: [],
        metric_features: [],
        platform: "tuya",
      });
      const childDetail: DeviceDetail = {
        did: childDid,
        name: childName,
        model,
        props: childProps,
        actions: [],
      };
      cards.push(childInfo);
      profiles.set(childDid, {
        did: childDid,
        hardwareId: record.id,
        channel: ch,
        isSplitParent: false,
        isInfraredRemote: false,
        irControlMode: null,
        info: childInfo,
        detail: childDetail,
        powerDpCode: dpCode,
        tempDpCode: null,
        tempScale: 0,
        humDpCode: null,
        humScale: 0,
        bindingsByPropName: childByProp,
        bindingsByDpCode: childByDp,
        irActionsByName: new Map(),
        irPower: null,
        irRemote: null,
      });
    }

    return { cards, profiles };
  }

  // Single-card device
  const specType = `urn:tuya:device:${baseKind}:1`;
  const tempInfo = createDeviceInfo({
    did: record.id,
    name: record.name,
    model,
    home_name: homeName,
    room_name: roomName,
    online: record.online,
    spec_type: specType,
    platform: "tuya",
  });
  const isLightDevice = baseKind === "light" || isLight(tempInfo);
  const powerDpCode = findPrimaryPowerDp(mergedDps);
  const hasV2LightDps = {
    bright: mergedDps.has("bright_value_v2"),
    temp: mergedDps.has("temp_value_v2"),
    colour: mergedDps.has("colour_data_v2"),
  };

  const props: PropInfo[] = [];
  const actions: ActionInfo[] = [];
  const bindingsByPropName = new Map<string, TuyaPropBinding>();
  const bindingsByDpCode = new Map<string, TuyaPropBinding>();

  // Put canonical power DP first if present
  const orderedMetas: MergedDpMeta[] = [];
  if (powerDpCode && mergedDps.has(powerDpCode)) {
    orderedMetas.push(mergedDps.get(powerDpCode)!);
  }
  for (const meta of mergedDps.values()) {
    if (meta.code === powerDpCode) continue;
    orderedMetas.push(meta);
  }

  for (const meta of orderedMetas) {
    const built = buildBindingAndPropForDp(meta, powerDpCode, isLightDevice, hasV2LightDps);
    if (!built) continue;
    if (bindingsByPropName.has(built.binding.propName)) continue;
    props.push(built.prop);
    bindingsByPropName.set(built.binding.propName, built.binding);
    bindingsByDpCode.set(built.binding.dpCode, built.binding);
  }

  const lightFeatures = isLightDevice ? Object.keys(lightControls(props)) : [];
  const metrics = resolveMetricDps(mergedDps);

  const info = createDeviceInfo({
    did: record.id,
    name: record.name,
    model,
    home_name: homeName,
    room_name: roomName,
    online: record.online,
    spec_type: specType,
    switch_channels: [],
    light_features: lightFeatures,
    metric_features: metrics.metricFeatures,
    platform: "tuya",
  });

  const detail: DeviceDetail = {
    did: record.id,
    name: record.name,
    model,
    props,
    actions,
  };

  cards.push(info);
  profiles.set(record.id, {
    did: record.id,
    hardwareId: record.id,
    channel: null,
    isSplitParent: false,
    isInfraredRemote: false,
    irControlMode: null,
    info,
    detail,
    powerDpCode,
    tempDpCode: metrics.tempDpCode,
    tempScale: metrics.tempScale,
    humDpCode: metrics.humDpCode,
    humScale: metrics.humScale,
    bindingsByPropName,
    bindingsByDpCode,
    irActionsByName: new Map(),
    irPower: null,
    irRemote: null,
  });

  return { cards, profiles };
}
