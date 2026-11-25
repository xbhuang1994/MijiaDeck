// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 德业智能设备与 Solarman V5 逆变器模型映射器

import {
  createDeviceInfo,
  createPropInfo,
  type ActionInfo,
  type DeviceDetail,
  type DeviceInfo,
  type PropInfo,
} from "../../core/models.ts";
import { ServiceError, formatMetricsText } from "../../core/service.ts";
import type { DeyeSolarmanInverterEntry } from "../configStore.ts";
import type { DeyeCloudDeviceInfo } from "./cloudClient.ts";
import {
  DEYE_FAN_SPEED_LABELS,
  DEYE_MODE_LABELS,
  DeyeDeviceMode,
  DeyeFanSpeed,
  getProductFeatureConfig,
  type DeyeProductConfig,
} from "./constants.ts";
import {
  stateToCommand,
  type DeyeDeviceCommand,
  type DeyeDeviceState,
} from "./deviceState.ts";
import type { DeyeInverterTelemetry } from "./solarmanClient.ts";

function sanitizeSlug(raw: string, fallback: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || fallback;
}

export function isAirPurifierCloudDevice(device: DeyeCloudDeviceInfo): boolean {
  const combined = `${device.product_type ?? ""} ${device.product_name ?? ""} ${device.device_name ?? ""}`.toLowerCase();
  return (
    combined.includes("purifier") ||
    combined.includes("空气净化") ||
    combined.includes("空净")
  );
}

export function resolveCloudDeviceKind(device: DeyeCloudDeviceInfo): "dehumidifier" | "air-purifier" {
  return isAirPurifierCloudDevice(device) ? "air-purifier" : "dehumidifier";
}

export function resolveCloudDeviceModel(device: DeyeCloudDeviceInfo): string {
  const kind = resolveCloudDeviceKind(device);
  const slugSource = device.product_name || device.product_id.slice(0, 8);
  const slug = sanitizeSlug(slugSource, "generic");
  return `deye.${kind}.${slug}`;
}

export function resolveCloudDeviceSpecType(device: DeyeCloudDeviceInfo): string {
  const kind = resolveCloudDeviceKind(device);
  const pid = sanitizeSlug(device.product_id, "unknown");
  return `urn:deye:device:${kind}:${pid}:1`;
}

export function resolveCloudDeviceDisplayName(device: DeyeCloudDeviceInfo): string {
  const alias = device.alias?.trim();
  if (alias) {
    return alias;
  }
  const devName = device.device_name?.trim();
  if (devName) {
    return devName;
  }
  const prodName = device.product_name?.trim();
  return prodName ? `德业 ${prodName}` : `德业设备 ${device.device_id}`;
}

const DEFAULT_DEYE_CLOUD_HOME_NAME = "德业智能";
const DEFAULT_DEYE_CLOUD_ROOM_NAME = "默认房间";

function pickNonEmptyString(...candidates: ReadonlyArray<unknown>): string | null {
  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      const trimmed = candidate.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
    }
  }
  return null;
}

function extractNestedRoomName(room: DeyeCloudDeviceInfo["room"]): string | null {
  if (typeof room === "string") {
    return pickNonEmptyString(room);
  }
  if (room && typeof room === "object" && !Array.isArray(room)) {
    return pickNonEmptyString(
      room.room_display_name,
      room.display_name,
      room.room_name,
      room.roomName,
      room.name,
    );
  }
  return null;
}

/** 解析德业云端设备所属家庭名称（默认归类到「德业智能」） */
export function resolveCloudDeviceHomeName(device: DeyeCloudDeviceInfo): string {
  return (
    pickNonEmptyString(
      device.home_name,
      device.homeName,
      device.family_name,
      device.familyName,
    ) ?? DEFAULT_DEYE_CLOUD_HOME_NAME
  );
}

/**
 * 解析德业云端设备所在房间名称。
 * 德业 `/v3/enduser/deviceList/` 实际返回 `has_room` 与 `room_display_name`；
 * 当 `has_room === false` 或未提供有效房间名时回退到「默认房间」。
 */
export function resolveCloudDeviceRoomName(device: DeyeCloudDeviceInfo): string {
  if (device.has_room === false) {
    return DEFAULT_DEYE_CLOUD_ROOM_NAME;
  }
  return (
    pickNonEmptyString(
      device.room_display_name,
      device.room_name,
      device.roomName,
      extractNestedRoomName(device.room),
    ) ?? DEFAULT_DEYE_CLOUD_ROOM_NAME
  );
}

/** 将德业云端设备列表项映射为 MijiaDeck DeviceInfo */
export function mapCloudDeviceToDeviceInfo(device: DeyeCloudDeviceInfo): DeviceInfo {
  const nativeDid = device.device_id || device.deviceid || device.mac;
  return createDeviceInfo({
    did: nativeDid,
    name: resolveCloudDeviceDisplayName(device),
    model: resolveCloudDeviceModel(device),
    home_name: resolveCloudDeviceHomeName(device),
    room_name: resolveCloudDeviceRoomName(device),
    online: Boolean(device.online),
    spec_type: resolveCloudDeviceSpecType(device),
    metric_features: ["temperature", "relative-humidity"],
    firmware: device.protocol_version || "",
    platform: "deye",
  });
}

/** 将 Solarman V5 本地光伏逆变器配置映射为 MijiaDeck DeviceInfo */
export function mapSolarmanInverterToDeviceInfo(
  entry: DeyeSolarmanInverterEntry,
  online = true,
): DeviceInfo {
  return createDeviceInfo({
    did: entry.id,
    name: entry.name || `德业逆变器 ${entry.serial}`,
    model: "deye.solar-inverter.v5",
    home_name: "德业光伏",
    room_name: entry.room?.trim() || "本地逆变器",
    online,
    spec_type: "urn:deye:device:solar-inverter:v5:1",
    metric_features: ["temperature", "electric-power"],
    firmware: `Solarman V5 (${entry.serial})`,
    platform: "deye",
  });
}

/** 为德业云端除湿机/空气净化器构建 MijiaDeck DeviceDetail（属性 + 动作定义） */
export function buildCloudDeviceDetail(device: DeyeCloudDeviceInfo): DeviceDetail {
  const nativeDid = device.device_id || device.deviceid || device.mac;
  const cfg = getProductFeatureConfig(device.product_id);
  const serviceName = resolveCloudDeviceKind(device);
  const serviceDesc = serviceName === "air-purifier" ? "空气净化器" : "除湿机";

  const props: PropInfo[] = [
    createPropInfo({
      name: "on",
      desc: "电源开关",
      type: "bool",
      readable: true,
      writable: true,
      service: serviceName,
      service_desc: serviceDesc,
    }),
    createPropInfo({
      name: "target-humidity",
      desc: "目标湿度",
      type: "uint",
      readable: true,
      writable: true,
      unit: "%",
      range: [cfg.min_target_humidity, cfg.max_target_humidity, 1],
      service: serviceName,
      service_desc: serviceDesc,
    }),
  ];

  if (cfg.mode.length > 0) {
    props.push(
      createPropInfo({
        name: "mode",
        desc: "工作模式",
        type: "uint",
        readable: true,
        writable: true,
        value_list: cfg.mode.map((m) => ({
          value: m,
          description: DeyeDeviceMode[m] ?? String(m),
          desc_zh_cn: DEYE_MODE_LABELS[m] ?? String(m),
        })),
        service: serviceName,
        service_desc: serviceDesc,
      }),
    );
  }

  if (cfg.fan_speed.length > 0) {
    props.push(
      createPropInfo({
        name: "fan-speed",
        desc: "风速",
        type: "uint",
        readable: true,
        writable: true,
        value_list: cfg.fan_speed.map((s) => ({
          value: s,
          description: DeyeFanSpeed[s] ?? String(s),
          desc_zh_cn: DEYE_FAN_SPEED_LABELS[s] ?? String(s),
        })),
        service: serviceName,
        service_desc: serviceDesc,
      }),
    );
  }

  if (cfg.anion) {
    props.push(
      createPropInfo({
        name: "anion",
        desc: "负离子",
        type: "bool",
        readable: true,
        writable: true,
        service: serviceName,
        service_desc: serviceDesc,
      }),
    );
  }

  if (cfg.oscillating) {
    props.push(
      createPropInfo({
        name: "oscillating",
        desc: "摆风",
        type: "bool",
        readable: true,
        writable: true,
        service: serviceName,
        service_desc: serviceDesc,
      }),
    );
  }

  props.push(
    createPropInfo({
      name: "child-lock",
      desc: "童锁",
      type: "bool",
      readable: true,
      writable: true,
      service: "physical-controls-locked",
      service_desc: "安全锁",
    }),
  );

  if (cfg.water_pump) {
    props.push(
      createPropInfo({
        name: "water-pump",
        desc: "水泵",
        type: "bool",
        readable: true,
        writable: true,
        service: serviceName,
        service_desc: serviceDesc,
      }),
    );
  }

  if (cfg.uv) {
    props.push(
      createPropInfo({
        name: "uv",
        desc: "UV 杀菌",
        type: "bool",
        readable: true,
        writable: true,
        service: serviceName,
        service_desc: serviceDesc,
      }),
    );
  }

  if (cfg.prompt_sound) {
    props.push(
      createPropInfo({
        name: "prompt-sound",
        desc: "提示音",
        type: "bool",
        readable: true,
        writable: true,
        service: serviceName,
        service_desc: serviceDesc,
      }),
    );
  }

  if (cfg.screen_display) {
    props.push(
      createPropInfo({
        name: "screen-display",
        desc: "屏幕显示",
        type: "bool",
        readable: true,
        writable: true,
        service: serviceName,
        service_desc: serviceDesc,
      }),
    );
  }

  if (cfg.timed_off) {
    props.push(
      createPropInfo({
        name: "timed-off-hour",
        desc: "定时关机",
        type: "uint",
        readable: true,
        writable: true,
        unit: "h",
        range: [0, 24, 1],
        service: serviceName,
        service_desc: serviceDesc,
      }),
    );
  }

  // 只读环境与运行状态传感器属性
  props.push(
    createPropInfo({
      name: "temperature",
      desc: "环境温度",
      type: "int",
      readable: true,
      writable: false,
      unit: "°C",
      service: "environment",
      service_desc: "环境传感器",
    }),
    createPropInfo({
      name: "relative-humidity",
      desc: "环境湿度",
      type: "uint",
      readable: true,
      writable: false,
      unit: "%",
      service: "environment",
      service_desc: "环境传感器",
    }),
    createPropInfo({
      name: "water-tank-full",
      desc: "水箱满状态",
      type: "bool",
      readable: true,
      writable: false,
      service: "status",
      service_desc: "运行状态",
    }),
    createPropInfo({
      name: "defrosting",
      desc: "除霜状态",
      type: "bool",
      readable: true,
      writable: false,
      service: "status",
      service_desc: "运行状态",
    }),
    createPropInfo({
      name: "fan-running",
      desc: "风机运行状态",
      type: "bool",
      readable: true,
      writable: false,
      service: "status",
      service_desc: "运行状态",
    }),
    createPropInfo({
      name: "coil-temperature",
      desc: "盘管温度",
      type: "int",
      readable: true,
      writable: false,
      unit: "°C",
      service: "status",
      service_desc: "运行状态",
    }),
    createPropInfo({
      name: "exhaust-temperature",
      desc: "排气温度",
      type: "int",
      readable: true,
      writable: false,
      unit: "°C",
      service: "status",
      service_desc: "运行状态",
    }),
  );

  const actions: ActionInfo[] = [
    {
      name: "refresh-state",
      desc: "刷新设备状态",
      service: serviceName,
      service_desc: serviceDesc,
    },
  ];

  return {
    did: nativeDid,
    name: resolveCloudDeviceDisplayName(device),
    model: resolveCloudDeviceModel(device),
    props,
    actions,
  };
}

/** 为 Solarman V5 光伏逆变器构建 MijiaDeck DeviceDetail */
export function buildSolarmanInverterDetail(entry: DeyeSolarmanInverterEntry): DeviceDetail {
  const props: PropInfo[] = [
    createPropInfo({
      name: "pv-power",
      desc: "光伏功率",
      type: "uint",
      readable: true,
      writable: false,
      unit: "W",
      service: "solar",
      service_desc: "光伏发电",
    }),
    createPropInfo({
      name: "pv1-power",
      desc: "PV1 功率",
      type: "uint",
      readable: true,
      writable: false,
      unit: "W",
      service: "solar",
      service_desc: "光伏发电",
    }),
    createPropInfo({
      name: "pv2-power",
      desc: "PV2 功率",
      type: "uint",
      readable: true,
      writable: false,
      unit: "W",
      service: "solar",
      service_desc: "光伏发电",
    }),
    createPropInfo({
      name: "battery-soc",
      desc: "电池电量",
      type: "uint",
      readable: true,
      writable: false,
      unit: "%",
      range: [0, 100, 1],
      service: "battery",
      service_desc: "储能电池",
    }),
    createPropInfo({
      name: "battery-voltage",
      desc: "电池电压",
      type: "float",
      readable: true,
      writable: false,
      unit: "V",
      service: "battery",
      service_desc: "储能电池",
    }),
    createPropInfo({
      name: "battery-current",
      desc: "电池电流",
      type: "float",
      readable: true,
      writable: false,
      unit: "A",
      service: "battery",
      service_desc: "储能电池",
    }),
    createPropInfo({
      name: "battery-power",
      desc: "电池功率",
      type: "int",
      readable: true,
      writable: false,
      unit: "W",
      service: "battery",
      service_desc: "储能电池",
    }),
    createPropInfo({
      name: "grid-power",
      desc: "电网功率",
      type: "int",
      readable: true,
      writable: false,
      unit: "W",
      service: "grid",
      service_desc: "电网与负载",
    }),
    createPropInfo({
      name: "load-power",
      desc: "负载功率",
      type: "uint",
      readable: true,
      writable: false,
      unit: "W",
      service: "grid",
      service_desc: "电网与负载",
    }),
    createPropInfo({
      name: "daily-production",
      desc: "日发电量",
      type: "float",
      readable: true,
      writable: false,
      unit: "kWh",
      service: "solar",
      service_desc: "光伏发电",
    }),
    createPropInfo({
      name: "total-production",
      desc: "累计发电量",
      type: "float",
      readable: true,
      writable: false,
      unit: "kWh",
      service: "solar",
      service_desc: "光伏发电",
    }),
    createPropInfo({
      name: "temperature",
      desc: "逆变器温度",
      type: "float",
      readable: true,
      writable: false,
      unit: "°C",
      service: "inverter",
      service_desc: "逆变器状态",
    }),
    createPropInfo({
      name: "running-status",
      desc: "运行状态",
      type: "string",
      readable: true,
      writable: false,
      service: "inverter",
      service_desc: "逆变器状态",
    }),
  ];

  const actions: ActionInfo[] = [
    {
      name: "refresh-state",
      desc: "刷新逆变器遥测",
      service: "inverter",
      service_desc: "逆变器状态",
    },
  ];

  return {
    did: entry.id,
    name: entry.name || `德业逆变器 ${entry.serial}`,
    model: "deye.solar-inverter.v5",
    props,
    actions,
  };
}

/** 将德业云端设备状态展开为 MijiaDeck 属性键值表 */
export function extractCloudPropValues(state: DeyeDeviceState): Record<string, unknown> {
  return {
    on: state.powerSwitch,
    "target-humidity": state.targetHumidity,
    mode: state.mode,
    "fan-speed": state.fanSpeed,
    anion: state.anionSwitch,
    oscillating: state.oscillatingSwitch,
    "child-lock": state.childLockSwitch,
    "water-pump": state.waterPumpSwitch,
    uv: state.uvSwitch,
    "prompt-sound": state.promptSound,
    "screen-display": state.screenDisplay,
    "timed-off-hour": state.timedOffHour,
    temperature: state.environmentTemperature,
    "relative-humidity": state.environmentHumidity,
    "water-tank-full": state.waterTankFull,
    defrosting: state.defrosting,
    "fan-running": state.fanRunning,
    "coil-temperature": state.coilTemperature,
    "exhaust-temperature": state.exhaustTemperature,
  };
}

/** 将 Solarman V5 逆变器遥测展开为 MijiaDeck 属性键值表 */
export function extractInverterPropValues(
  telemetry: DeyeInverterTelemetry,
): Record<string, unknown> {
  return {
    "pv-power": telemetry.pvPowerW,
    "pv1-power": telemetry.pv1PowerW,
    "pv2-power": telemetry.pv2PowerW,
    "battery-soc": telemetry.batterySocPct,
    "battery-voltage": telemetry.batteryVoltageV,
    "battery-current": telemetry.batteryCurrentA,
    "battery-power": telemetry.batteryPowerW,
    "grid-power": telemetry.gridPowerW,
    "load-power": telemetry.loadPowerW,
    "daily-production": telemetry.dailyProductionKwh,
    "total-production": telemetry.totalProductionKwh,
    temperature: telemetry.inverterTempC,
    "running-status": telemetry.runningStatus,
  };
}

/** 格式化德业除湿机/空净卡片指标文案（例如 "25.0°C 55%" 或 "25.0°C 55% · 水满"） */
export function formatCloudDeviceMetrics(state: DeyeDeviceState): string | null {
  const base = formatMetricsText(state.environmentTemperature, state.environmentHumidity);
  if (state.waterTankFull) {
    return base ? `${base} · 水满` : "水满";
  }
  return base;
}

/** 格式化德业光伏逆变器卡片指标文案（例如 "PV 3200W · 电池 85% · 负载 1200W"） */
export function formatInverterMetrics(telemetry: DeyeInverterTelemetry): string | null {
  const parts: string[] = [
    `PV ${Math.round(telemetry.pvPowerW)}W`,
    `电池 ${Math.round(telemetry.batterySocPct)}%`,
    `负载 ${Math.round(telemetry.loadPowerW)}W`,
  ];
  if (Number.isFinite(telemetry.inverterTempC) && telemetry.inverterTempC > -40) {
    parts.push(`${telemetry.inverterTempC.toFixed(1)}°C`);
  }
  return parts.join(" · ");
}

function parseBoolInput(value: unknown, propName: string): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number" && (value === 0 || value === 1)) {
    return value === 1;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1" || normalized === "on") {
      return true;
    }
    if (normalized === "false" || normalized === "0" || normalized === "off") {
      return false;
    }
  }
  throw new ServiceError(`属性「${propName}」需要布尔开关值`);
}

function parseIntInput(value: unknown, propName: string): number {
  const num =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value.trim())
        : Number.NaN;
  if (!Number.isFinite(num) || !Number.isInteger(num)) {
    throw new ServiceError(`属性「${propName}」需要整数值`);
  }
  return num;
}

/**
 * 将单次属性写入应用到当前设备状态，生成新的目标控制指令与乐观状态快照。
 */
export function applyCloudPropWrite(
  propName: string,
  value: unknown,
  currentState: DeyeDeviceState,
  productConfig: DeyeProductConfig,
): { command: DeyeDeviceCommand; nextState: DeyeDeviceState } {
  const nextState: DeyeDeviceState = {
    ...currentState,
    ...(currentState.rawFogProperties
      ? { rawFogProperties: { ...currentState.rawFogProperties } }
      : {}),
  };

  switch (propName) {
    case "on":
    case "power": {
      const boolVal = parseBoolInput(value, propName);
      nextState.powerSwitch = boolVal;
      if (nextState.rawFogProperties) {
        nextState.rawFogProperties["Power"] = boolVal ? 1 : 0;
      }
      break;
    }
    case "target-humidity": {
      const humidity = parseIntInput(value, propName);
      if (
        humidity < productConfig.min_target_humidity ||
        humidity > productConfig.max_target_humidity
      ) {
        throw new ServiceError(
          `目标湿度超出设备允许范围（${productConfig.min_target_humidity}% ~ ${productConfig.max_target_humidity}%）`,
        );
      }
      nextState.targetHumidity = humidity;
      if (nextState.rawFogProperties) {
        nextState.rawFogProperties["SetHumidity"] = humidity;
      }
      break;
    }
    case "mode": {
      const modeVal = parseIntInput(value, propName) as DeyeDeviceMode;
      if (productConfig.mode.length > 0 && !productConfig.mode.includes(modeVal)) {
        throw new ServiceError(`当前型号不支持工作模式值：${modeVal}`);
      }
      nextState.mode = modeVal;
      if (nextState.rawFogProperties) {
        nextState.rawFogProperties["Mode"] = modeVal;
      }
      break;
    }
    case "fan-speed": {
      const speedVal = parseIntInput(value, propName) as DeyeFanSpeed;
      if (productConfig.fan_speed.length > 0 && !productConfig.fan_speed.includes(speedVal)) {
        throw new ServiceError(`当前型号不支持风速档位值：${speedVal}`);
      }
      nextState.fanSpeed = speedVal;
      if (nextState.rawFogProperties) {
        nextState.rawFogProperties["WindSpeed"] = speedVal;
      }
      break;
    }
    case "anion": {
      const boolVal = parseBoolInput(value, propName);
      nextState.anionSwitch = boolVal;
      if (nextState.rawFogProperties) {
        nextState.rawFogProperties["NegativeIon"] = boolVal ? 1 : 0;
      }
      break;
    }
    case "oscillating": {
      const boolVal = parseBoolInput(value, propName);
      nextState.oscillatingSwitch = boolVal;
      if (nextState.rawFogProperties) {
        nextState.rawFogProperties["SwingingWind"] = boolVal ? 1 : 0;
      }
      break;
    }
    case "child-lock": {
      const boolVal = parseBoolInput(value, propName);
      nextState.childLockSwitch = boolVal;
      if (nextState.rawFogProperties) {
        nextState.rawFogProperties["KeyLock"] = boolVal ? 1 : 0;
      }
      break;
    }
    case "water-pump": {
      const boolVal = parseBoolInput(value, propName);
      nextState.waterPumpSwitch = boolVal;
      if (nextState.rawFogProperties) {
        nextState.rawFogProperties["WaterPump"] = boolVal ? 1 : 0;
      }
      break;
    }
    case "uv": {
      const boolVal = parseBoolInput(value, propName);
      nextState.uvSwitch = boolVal;
      if (nextState.rawFogProperties) {
        nextState.rawFogProperties["UV"] = boolVal ? 1 : 0;
      }
      break;
    }
    case "prompt-sound": {
      const boolVal = parseBoolInput(value, propName);
      nextState.promptSound = boolVal;
      if (nextState.rawFogProperties) {
        nextState.rawFogProperties["PromptSound"] = boolVal ? 1 : 0;
      }
      break;
    }
    case "screen-display": {
      const boolVal = parseBoolInput(value, propName);
      nextState.screenDisplay = boolVal;
      if (nextState.rawFogProperties) {
        nextState.rawFogProperties["Screendisplay"] = boolVal ? 1 : 0;
      }
      break;
    }
    case "timed-off-hour": {
      const hours = parseIntInput(value, propName);
      if (hours < 0 || hours > 24) {
        throw new ServiceError("定时关机小时数必须在 0 ~ 24 之间");
      }
      nextState.timedOffHour = hours;
      if (nextState.rawFogProperties) {
        nextState.rawFogProperties["TimedOffHour"] = hours;
      }
      break;
    }
    default:
      throw new ServiceError(`德业设备不支持写入属性「${propName}」`);
  }

  return {
    command: stateToCommand(nextState),
    nextState,
  };
}
