// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * Pure, browser-safe device detail classification, formatting, and validation helpers.
 * Shared across backend routes, desktop controllers, and browser web UI without Node-only imports.
 */

import type { ActionInfo, DeviceInfo, PropEnumOption, PropInfo } from "./models.ts";
import {
  isDangerousAction,
  isDebugProperty,
  isSensitivePropertyName,
  serviceDescZh,
  unitLabelZh,
} from "./specZh.ts";

export type LightPropKind = "brightness" | "temperature" | "color";

export type PropertyWidgetKind =
  | "switch"
  | "segmented"
  | "select"
  | "slider"
  | "color"
  | "number"
  | "text"
  | "readonly";

export interface DeviceChannelState {
  did: string;
  name: string;
  room_name: string;
  online: boolean;
  power: boolean | null;
}

export interface ClassifiedDeviceProps {
  powerProp: PropInfo | null;
  heroLight: Partial<Record<LightPropKind, PropInfo>>;
  telemetry: PropInfo[];
  controls: PropInfo[];
  advanced: PropInfo[];
  actionParams: PropInfo[];
}

export interface PropertyGroup {
  key: string;
  label: string;
  props: PropInfo[];
}

export interface FeedPlanItem {
  id: number;
  enabled: boolean;
  daysMask: number;
  hour: number;
  minute: number;
  portions: number;
}

export interface SkippedFeedPlans {
  year: number;
  month: number;
  day: number;
  dateText: string;
  skippedIds: number[];
}

export const FEED_WEEKDAYS: ReadonlyArray<{ bit: number; short: string; label: string }> = [
  { bit: 0x01, short: "一", label: "周一" },
  { bit: 0x02, short: "二", label: "周二" },
  { bit: 0x04, short: "三", label: "周三" },
  { bit: 0x08, short: "四", label: "周四" },
  { bit: 0x10, short: "五", label: "周五" },
  { bit: 0x20, short: "六", label: "周六" },
  { bit: 0x40, short: "日", label: "周日" },
];

const CJK_RE = /[\u4e00-\u9fff]/;
const SPEC_DEVICE_KIND_RE = /:device:([^:]+):/;

const CAMERA_KINDS: ReadonlySet<string> = new Set(["camera", "ip-camera"]);
const APPLIANCE_POWER_KINDS: ReadonlySet<string> = new Set([
  "television",
  "tv",
  "washer",
  "washing-machine",
  "dryer",
  "air-conditioner",
  "aircondition",
  "airconditioner",
  "fan",
  "air-purifier",
  "airpurifier",
  "purifier",
  "humidifier",
  "dehumidifier",
  "heater",
  "water-heater",
]);

const LIGHT_PROP_MAP = new Map<string, LightPropKind>([
  ["brightness", "brightness"],
  ["color-temperature", "temperature"],
  ["color", "color"],
  ["rgb", "color"],
]);

const DEVICE_CATEGORY_LABELS: ReadonlyArray<readonly [string, string]> = [
  ["air-purifier", "空气净化器"],
  ["airpurifier", "空气净化器"],
  ["purifier", "空气净化器"],
  ["pet-feeder", "宠物喂食器"],
  ["feeder", "宠物喂食器"],
  ["air-conditioner", "空调"],
  ["aircondition", "空调"],
  ["airconditioner", "空调"],
  ["humidifier", "加湿器"],
  ["dehumidifier", "除湿机"],
  ["fan", "风扇"],
  ["heater", "电暖器"],
  ["water-heater", "热水器"],
  ["camera", "智能摄像机"],
  ["ip-camera", "智能摄像机"],
  ["wifispeaker", "小爱音箱"],
  ["speaker", "智能音箱"],
  ["router", "路由器"],
  ["television", "智能电视"],
  ["tv", "智能电视"],
  ["lock", "智能门锁"],
  ["curtain", "智能窗帘"],
  ["washer", "洗衣机"],
  ["washing-machine", "洗衣机"],
  ["dryer", "烘干机"],
  ["vacuum", "扫地机器人"],
  ["temperature-humidity-sensor", "温湿度传感器"],
  ["sensor_ht", "温湿度传感器"],
  ["motion-sensor", "人体传感器"],
  ["occupancy-sensor", "人在传感器"],
  ["contact-sensor", "门窗传感器"],
  ["water-leak-sensor", "水浸卫士"],
  ["smoke-sensor", "烟雾报警器"],
  ["gas-sensor", "天然气报警器"],
  ["sensor", "传感器"],
  ["outlet", "智能插座"],
  ["plug", "智能插座"],
  ["switch", "智能开关"],
  ["light", "智能照明"],
  ["lamp", "智能台灯"],
  ["bulb", "智能灯泡"],
];

function extractDeviceKinds(device: DeviceInfo): Set<string> {
  const parts = new Set(device.model.toLowerCase().split("."));
  const match = SPEC_DEVICE_KIND_RE.exec(device.spec_type ?? "");
  if (match && match[1]) {
    parts.add(match[1]);
  }
  return parts;
}

function hasAny(kinds: Set<string>, targets: ReadonlySet<string>): boolean {
  for (const kind of kinds) {
    if (targets.has(kind)) {
      return true;
    }
  }
  return false;
}

function isLightDevice(device: DeviceInfo): boolean {
  if ((device.spec_type ?? "").includes(":device:light:")) {
    return true;
  }
  const parts = device.model.split(".");
  return parts.includes("light") || parts.includes("lamp") || parts.includes("bulb");
}

function isDirectPowerDevice(device: DeviceInfo): boolean {
  const specType = device.spec_type ?? "";
  if (specType.includes(":device:switch:") || device.model.includes(".switch.")) {
    return true;
  }
  const parts = device.model.split(".");
  if (parts.includes("plug") || parts.includes("outlet")) {
    return true;
  }
  return specType.includes(":device:outlet:");
}

function isCameraDevice(device: DeviceInfo): boolean {
  return hasAny(extractDeviceKinds(device), CAMERA_KINDS);
}

function supportsPowerDevice(device: DeviceInfo): boolean {
  if (device.switch_channels.length > 0) {
    return false;
  }
  if (isLightDevice(device) || isDirectPowerDevice(device)) {
    return true;
  }
  return hasAny(extractDeviceKinds(device), APPLIANCE_POWER_KINDS);
}

function pickLightControls(props: readonly PropInfo[]): Partial<Record<LightPropKind, PropInfo>> {
  const selected: Partial<Record<LightPropKind, PropInfo>> = {};
  for (const prop of props) {
    const normalized = prop.name.replaceAll("_", "-").replace(/-[0-9]+$/, "");
    const kind = LIGHT_PROP_MAP.get(normalized);
    if (!kind || !prop.writable || (prop.type !== "uint" && prop.type !== "int" && prop.type !== "float")) {
      continue;
    }
    if (kind !== "color" && (!prop.range || prop.range.length < 2 || prop.range[0] >= prop.range[1])) {
      continue;
    }
    if (kind === "color" && prop.type !== "uint" && prop.type !== "int") {
      continue;
    }
    if (
      kind === "color" &&
      ((prop.value_list !== null && prop.value_list.length > 0) ||
        (prop.range !== null && prop.range.length >= 2 && (prop.range[0] > 0 || prop.range[1] < 0xffffff)))
    ) {
      continue;
    }
    if (!(kind in selected)) {
      selected[kind] = prop;
    }
  }
  return selected;
}

/** 根据设备型号与 spec_type 返回友好的中文品类标签。 */
export function deviceCategoryLabel(device: DeviceInfo): string {
  if (device.switch_channels.length > 0) {
    return "多路开关面板";
  }
  const kinds = extractDeviceKinds(device);
  for (const [key, label] of DEVICE_CATEGORY_LABELS) {
    if (kinds.has(key)) {
      return label;
    }
  }
  return "智能设备";
}

/** 从「English / 中文」或纯中文描述中提取简洁主标题。 */
export function friendlyLabel(desc: string, fallbackName: string): string {
  const raw = (desc || "").trim();
  if (!raw) {
    return fallbackName;
  }
  const parts = raw
    .split("/")
    .map((p) => p.trim())
    .filter(Boolean);
  const cjk = parts.find((p) => CJK_RE.test(p));
  const chosen = cjk ?? parts[0] ?? raw;
  const short = chosen.split("，")[0]?.trim() || chosen;
  return short.length > 28 ? `${short.slice(0, 28)}…` : short;
}

/** 结合所属服务与设备品类返回更明确的属性展示名称（如区分指示灯开关与主电源）。 */
export function friendlyPropLabel(prop: PropInfo, device?: DeviceInfo): string {
  const base = friendlyLabel(prop.desc, prop.name);
  if (prop.name === "on" && base === "开关") {
    if (prop.service === "indicator-light") {
      return "指示灯开关";
    }
    if (device && isPetFeederDevice(device) && prop.siid !== 2) {
      return "指示灯开关";
    }
  }
  return base;
}

/** 根据属性元信息选择最适合的交互控件类型。 */
export function choosePropertyWidget(prop: PropInfo): PropertyWidgetKind {
  if (!prop.writable) {
    return "readonly";
  }
  if (prop.type === "bool") {
    return "switch";
  }
  if (prop.value_list && prop.value_list.length > 0) {
    return prop.value_list.length <= 5 ? "segmented" : "select";
  }
  const isNumeric = prop.type === "int" || prop.type === "uint" || prop.type === "float";
  if (isNumeric) {
    const norm = prop.name.replaceAll("_", "-").replace(/-\d+$/, "");
    if (
      (norm === "color" || norm === "rgb" || prop.unit?.toLowerCase() === "rgb") &&
      (prop.type === "uint" || prop.type === "int") &&
      (!prop.range || (prop.range[0] <= 0 && prop.range[1] >= 0xffffff))
    ) {
      return "color";
    }
    if (prop.range && prop.range.length >= 2 && prop.range[1] > prop.range[0]) {
      const step = prop.range.length >= 3 && prop.range[2] && prop.range[2] > 0 ? prop.range[2] : 1;
      const steps = (prop.range[1] - prop.range[0]) / step;
      if (steps <= 1200) {
        return "slider";
      }
    }
    return "number";
  }
  return "text";
}

/** 解析属性枚举值的中文展示文案。 */
export function resolveEnumLabel(
  value: unknown,
  valueList: readonly PropEnumOption[] | null | undefined,
): string | null {
  if (!valueList || valueList.length === 0 || value === null || value === undefined) {
    return null;
  }
  const matched = valueList.find((item) => item.value === value || String(item.value) === String(value));
  if (!matched) {
    return null;
  }
  const zh = matched.desc_zh_cn?.trim();
  if (zh) {
    return zh;
  }
  const desc = matched.description?.trim();
  if (desc) {
    return desc;
  }
  return String(matched.value);
}

/** 格式化属性当前值，自动处理布尔值、枚举值、数值精度与中文单位。 */
export function formatPropertyValue(prop: PropInfo, rawValue: unknown): string {
  if (rawValue === null || rawValue === undefined) {
    return "—";
  }
  if (isSensitivePropertyName(prop.name)) {
    return "••••••••";
  }
  const enumLabel = resolveEnumLabel(rawValue, prop.value_list);
  if (enumLabel !== null) {
    return enumLabel;
  }
  if (prop.type === "bool" || typeof rawValue === "boolean") {
    return rawValue ? "已开启" : "已关闭";
  }
  if (typeof rawValue === "number" && Number.isFinite(rawValue)) {
    const norm = prop.name.replaceAll("_", "-").replace(/-\d+$/, "");
    if (
      (norm === "color" || norm === "rgb" || prop.unit?.toLowerCase() === "rgb") &&
      rawValue >= 0 &&
      rawValue <= 0xffffff
    ) {
      return `#${Math.trunc(rawValue).toString(16).padStart(6, "0").toUpperCase()}`;
    }
    const unit = unitLabelZh(prop.unit);
    let displayNum = rawValue;
    if (norm === "temperature" && Math.abs(rawValue) > 60 && (!prop.range || prop.range[1] <= 100)) {
      displayNum = rawValue / 10;
    } else if ((norm === "relative-humidity" || norm === "humidity") && rawValue > 100) {
      displayNum = rawValue / 10;
    }
    const numStr = Number.isInteger(displayNum)
      ? String(displayNum)
      : Number(displayNum.toFixed(2)).toString();
    if (!unit) {
      return numStr;
    }
    if (unit === "%" || unit === "°C" || unit === "°F" || unit === "°") {
      return `${numStr}${unit}`;
    }
    return `${numStr} ${unit}`;
  }
  if (prop.name === "feed-plan" && typeof rawValue === "string") {
    const plans = parseFeedPlans(rawValue);
    if (plans.length > 0) {
      const preview = plans
        .slice(0, 3)
        .map((p) => `${formatFeedTime(p.hour, p.minute)} ${p.portions}份`)
        .join("、");
      return `${plans.length} 条计划（${preview}${plans.length > 3 ? "…" : ""}）`;
    }
    if (!rawValue.trim()) {
      return "无定时计划";
    }
  }
  if (prop.name === "skiped-plan" && typeof rawValue === "string") {
    const skipped = parseSkippedPlans(rawValue);
    if (skipped) {
      return skipped.skippedIds.length > 0
        ? `${skipped.dateText} · 跳过 #${skipped.skippedIds.join(", #")}`
        : `${skipped.dateText}（无跳过）`;
    }
  }
  const str = String(rawValue).trim();
  return str || "—";
}

/** 将设备属性列表分类为电源、灯光专属、实时指标、可写控制、高级/调试与纯动作参数。 */
export function classifyDeviceProps(
  device: DeviceInfo,
  props: readonly PropInfo[],
): ClassifiedDeviceProps {
  const canPower = supportsPowerDevice(device) || isCameraDevice(device);
  const powerProp = canPower
    ? props.find(
        (p) =>
          p.type === "bool" &&
          p.writable &&
          (p.name === "on" || p.name.startsWith("on-") || p.name.startsWith("on_")),
      ) ?? null
    : null;

  const heroLight = isLightDevice(device) ? pickLightControls(props) : {};
  const heroLightNames = new Set(
    Object.values(heroLight)
      .filter((p): p is PropInfo => Boolean(p))
      .map((p) => p.name),
  );

  const telemetry: PropInfo[] = [];
  const controls: PropInfo[] = [];
  const advanced: PropInfo[] = [];
  const actionParams: PropInfo[] = [];

  for (const prop of props) {
    if (!prop.readable && !prop.writable) {
      actionParams.push(prop);
      continue;
    }
    if (powerProp && prop.name === powerProp.name) {
      continue;
    }
    if (heroLightNames.has(prop.name)) {
      continue;
    }
    if (isSensitivePropertyName(prop.name) || isDebugProperty(prop.name, prop.desc)) {
      advanced.push(prop);
      continue;
    }
    if (prop.writable) {
      controls.push(prop);
    } else if (prop.readable) {
      telemetry.push(prop);
    }
  }

  return {
    powerProp,
    heroLight,
    telemetry,
    controls,
    advanced,
    actionParams,
  };
}

/** 按 MIoT 服务分组属性，保持原始顺序。 */
export function groupPropsByService(props: readonly PropInfo[]): PropertyGroup[] {
  const map = new Map<string, PropertyGroup>();
  for (const prop of props) {
    const key = prop.service || (prop.siid !== undefined ? `siid-${prop.siid}` : "general");
    const label =
      prop.service_desc ||
      (prop.service
        ? serviceDescZh(prop.service, "")
        : prop.siid !== undefined
          ? `功能组 ${prop.siid}`
          : "常用控制");
    let group = map.get(key);
    if (!group) {
      group = { key, label, props: [] };
      map.set(key, group);
    }
    group.props.push(prop);
  }
  return [...map.values()];
}

/** 判断属性是否适合以进度条可视化（0-100 百分比类读数，如电量、滤芯、干燥剂、湿度）。 */
export function percentageProgressFor(prop: PropInfo, rawValue: unknown): number | null {
  if (typeof rawValue !== "number" || !Number.isFinite(rawValue)) {
    return null;
  }
  const unit = (prop.unit ?? "").toLowerCase();
  const isPctUnit = unit === "percentage" || unit === "%";
  const isPctName =
    prop.name.includes("battery") ||
    prop.name.includes("life-level") ||
    prop.name.includes("left-level") ||
    prop.name.includes("humidity");
  if (!isPctUnit && !isPctName) {
    return null;
  }
  if (prop.value_list && prop.value_list.length > 0) {
    return null;
  }
  const adjusted = rawValue > 100 && prop.name.includes("humidity") ? rawValue / 10 : rawValue;
  if (adjusted < 0 || adjusted > 100) {
    return null;
  }
  return Math.round(adjusted);
}

/** 判断某动作是否需要二次确认保护（重启、重置滤芯/干燥剂、恢复默认、删除等）。 */
export function actionRequiresConfirmation(action: ActionInfo): boolean {
  return isDangerousAction(action.name);
}

/** 校验并转换即将写入的属性值。 */
export function coercePropWriteValue(
  prop: PropInfo | undefined,
  rawValue: unknown,
): { ok: true; value: unknown } | { ok: false; error: string } {
  if (!prop) {
    return { ok: true, value: rawValue };
  }
  if (!prop.writable) {
    return { ok: false, error: `属性「${friendlyLabel(prop.desc, prop.name)}」仅支持只读查看` };
  }
  if (prop.type === "bool") {
    if (typeof rawValue !== "boolean") {
      return { ok: false, error: `属性 ${prop.name} 需要布尔值` };
    }
    return { ok: true, value: rawValue };
  }
  if (prop.type === "int" || prop.type === "uint" || prop.type === "float") {
    const num = typeof rawValue === "number" ? rawValue : Number(rawValue);
    if (!Number.isFinite(num)) {
      return { ok: false, error: `属性 ${prop.name} 需要有效数字` };
    }
    const coerced = prop.type === "float" ? num : Math.round(num);
    if (prop.range && prop.range.length >= 2 && (coerced < prop.range[0] || coerced > prop.range[1])) {
      return {
        ok: false,
        error: `属性 ${prop.name} 超出允许范围 [${prop.range[0]}, ${prop.range[1]}]`,
      };
    }
    if (prop.value_list && prop.value_list.length > 0) {
      const valid = prop.value_list.some((opt) => opt.value === coerced);
      if (!valid) {
        return { ok: false, error: `属性 ${prop.name} 的取值不在支持列表中` };
      }
    }
    return { ok: true, value: coerced };
  }
  if (prop.type === "string") {
    if (typeof rawValue !== "string") {
      return { ok: false, error: `属性 ${prop.name} 需要字符串` };
    }
    return { ok: true, value: rawValue };
  }
  return { ok: true, value: rawValue };
}

/** 判断设备是否为宠物喂食器（兼容型号、MIoT spec_type 与动作特征）。 */
export function isPetFeederDevice(
  device: DeviceInfo,
  props?: readonly PropInfo[],
  actions?: readonly ActionInfo[],
): boolean {
  const kinds = extractDeviceKinds(device);
  if (kinds.has("pet-feeder") || kinds.has("feeder")) {
    return true;
  }
  if (actions?.some((a) => a.name === "pet-food-out" || a.name.startsWith("pet-food-out-"))) {
    return true;
  }
  if (props?.some((p) => p.name === "pet-food-left-level" || p.name === "feed-plan")) {
    return true;
  }
  return false;
}

function hexByte(value: number): string {
  return Math.max(0, Math.min(0xff, Math.round(value)))
    .toString(16)
    .padStart(2, "0")
    .toUpperCase();
}

/** 解析喂食机全量定时计划十六进制字符串（每条 12 位 HEX：ID、开关、星期掩码、时、分、份数）。 */
export function parseFeedPlans(raw: unknown): FeedPlanItem[] {
  if (typeof raw !== "string") {
    return [];
  }
  const cleaned = raw.replace(/\s+/g, "").toUpperCase();
  if (cleaned.length < 12 || !/^[0-9A-F]+$/.test(cleaned)) {
    return [];
  }
  const byId = new Map<number, FeedPlanItem>();
  const count = Math.floor(cleaned.length / 12);
  for (let i = 0; i < count; i++) {
    const chunk = cleaned.slice(i * 12, i * 12 + 12);
    const id = Number.parseInt(chunk.slice(0, 2), 16);
    const enabledByte = Number.parseInt(chunk.slice(2, 4), 16);
    const daysMask = Number.parseInt(chunk.slice(4, 6), 16) & 0x7f;
    const hour = Number.parseInt(chunk.slice(6, 8), 16);
    const minute = Number.parseInt(chunk.slice(8, 10), 16);
    const portions = Number.parseInt(chunk.slice(10, 12), 16);
    if (
      id < 1 ||
      id > 255 ||
      hour < 0 ||
      hour > 23 ||
      minute < 0 ||
      minute > 59 ||
      portions < 1 ||
      portions > 255
    ) {
      continue;
    }
    byId.set(id, {
      id,
      enabled: enabledByte !== 0,
      daysMask: daysMask || 0x7f,
      hour,
      minute,
      portions,
    });
  }
  return [...byId.values()].sort(
    (a, b) => a.hour * 60 + a.minute - (b.hour * 60 + b.minute) || a.id - b.id,
  );
}

/** 将单条定时喂食计划编码为 12 位大写十六进制字符串（供 `update` / `edit-plan` 使用）。 */
export function encodeFeedPlan(plan: FeedPlanItem, maxPortions = 60): string {
  const id = Math.max(1, Math.min(255, Math.round(plan.id)));
  const enabled = plan.enabled ? 1 : 0;
  const daysMask = (Math.round(plan.daysMask) & 0x7f) || 0x7f;
  const hour = Math.max(0, Math.min(23, Math.round(plan.hour)));
  const minute = Math.max(0, Math.min(59, Math.round(plan.minute)));
  const portions = Math.max(1, Math.min(Math.max(1, maxPortions), Math.round(plan.portions)));
  return (
    hexByte(id) +
    hexByte(enabled) +
    hexByte(daysMask) +
    hexByte(hour) +
    hexByte(minute) +
    hexByte(portions)
  );
}

/** 分配下一个未使用的计划编号（1–255）。 */
export function nextAvailableFeedPlanId(plans: readonly FeedPlanItem[]): number {
  const used = new Set(plans.map((p) => p.id));
  for (let id = 1; id <= 255; id++) {
    if (!used.has(id)) {
      return id;
    }
  }
  return 1;
}

/** 解析跳过的喂食计划记录（前 6 位 HEX 为 YYMMDD，后续每 2 位为一个计划 ID）。 */
export function parseSkippedPlans(raw: unknown): SkippedFeedPlans | null {
  if (typeof raw !== "string") {
    return null;
  }
  const cleaned = raw.replace(/\s+/g, "").toUpperCase();
  if (cleaned.length < 6 || cleaned.length % 2 !== 0 || !/^[0-9A-F]+$/.test(cleaned)) {
    return null;
  }
  const yy = Number.parseInt(cleaned.slice(0, 2), 16);
  const month = Number.parseInt(cleaned.slice(2, 4), 16);
  const day = Number.parseInt(cleaned.slice(4, 6), 16);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  const year = 2000 + yy;
  const ids = new Set<number>();
  for (let idx = 6; idx + 2 <= cleaned.length; idx += 2) {
    const id = Number.parseInt(cleaned.slice(idx, idx + 2), 16);
    if (id >= 1 && id <= 255) {
      ids.add(id);
    }
  }
  const dateText = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return {
    year,
    month,
    day,
    dateText,
    skippedIds: [...ids].sort((a, b) => a - b),
  };
}

/** 仅返回与指定日期（默认今天）匹配的已跳过计划编号集合。 */
export function skippedPlanIdsForDate(raw: unknown, now = new Date()): Set<number> {
  const parsed = parseSkippedPlans(raw);
  if (!parsed) {
    return new Set();
  }
  if (
    parsed.year !== now.getFullYear() ||
    parsed.month !== now.getMonth() + 1 ||
    parsed.day !== now.getDate()
  ) {
    return new Set();
  }
  return new Set(parsed.skippedIds);
}

/** 编码指定日期的跳过计划列表为十六进制字符串（YYMMDD + IDs）。 */
export function encodeSkippedPlans(date: Date, skippedIds: readonly number[]): string {
  const yy = date.getFullYear() % 100;
  const mm = date.getMonth() + 1;
  const dd = date.getDate();
  const unique = [...new Set(skippedIds.filter((n) => Number.isInteger(n) && n >= 1 && n <= 255))].sort(
    (a, b) => a - b,
  );
  return hexByte(yy) + hexByte(mm) + hexByte(dd) + unique.map(hexByte).join("");
}

/** 格式化定时喂食时间（HH:MM）。 */
export function formatFeedTime(hour: number, minute: number): string {
  return `${String(Math.max(0, Math.min(23, Math.round(hour)))).padStart(2, "0")}:${String(
    Math.max(0, Math.min(59, Math.round(minute))),
  ).padStart(2, "0")}`;
}

/** 将星期位掩码（0x01–0x7F）转换为易读中文周期文案。 */
export function formatFeedDaysLabel(daysMask: number): string {
  const mask = daysMask & 0x7f;
  if (mask === 0x7f) {
    return "每天";
  }
  if (mask === 0x1f) {
    return "工作日";
  }
  if (mask === 0x60) {
    return "周末";
  }
  const labels: string[] = [];
  for (const day of FEED_WEEKDAYS) {
    if ((mask & day.bit) !== 0) {
      labels.push(day.label);
    }
  }
  return labels.length > 0 ? labels.join("、") : "未设周期";
}
