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
