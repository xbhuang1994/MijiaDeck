// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 美的设备模型与属性状态映射器（DeviceInfo / DeviceDetail / Metrics）

import {
  createDeviceInfo,
  createPropInfo,
  type ActionInfo,
  type DeviceDetail,
  type DeviceInfo,
  type PropInfo,
} from "../../core/models.ts";
import { ServiceError, formatMetricsText } from "../../core/service.ts";
import { getMideaApplianceType } from "./constants.ts";
import type {
  MideaAcMode,
  MideaApplianceState,
  MideaDehumidifierMode,
} from "./protocols.ts";

export interface MideaApplianceRecord {
  id: string;
  name: string;
  type: number;
  homeName: string;
  roomName: string;
  online: boolean;
  model?: string;
  sn?: string;
  sn8?: string;
  ip?: string;
  port?: number;
  protocolVersion: 2 | 3;
  token?: string;
  key?: string;
  source: "cloud" | "local" | "hybrid";
}

function normalizePropKey(name: string): string {
  return name.trim().toLowerCase().replaceAll("_", "-");
}

function coerceBoolean(value: unknown, propName: string): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const lower = value.trim().toLowerCase();
    if (lower === "true" || lower === "1" || lower === "on") return true;
    if (lower === "false" || lower === "0" || lower === "off") return false;
  }
  throw new ServiceError(`属性「${propName}」需要布尔值（true/false）`);
}

function coerceNumber(value: unknown, propName: string): number {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) {
    throw new ServiceError(`属性「${propName}」需要有效数字`);
  }
  return num;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function buildMideaModelString(typeCode: number): string {
  const info = getMideaApplianceType(typeCode);
  return `midea.${info.kind}.0x${info.hex}`;
}

export function buildMideaSpecType(typeCode: number): string {
  const info = getMideaApplianceType(typeCode);
  return `urn:midea:device:${info.kind}:0x${info.hex}:1`;
}

export function mapMideaDeviceToInfo(record: MideaApplianceRecord): DeviceInfo {
  const typeInfo = getMideaApplianceType(record.type);
  const firmwareParts: string[] = [`V${record.protocolVersion}`];
  if (record.sn8) {
    firmwareParts.push(record.sn8);
  } else if (record.model) {
    firmwareParts.push(record.model);
  }
  if (record.ip) {
    firmwareParts.push("LAN");
  }

  return createDeviceInfo({
    did: record.id,
    name: record.name || `美的${typeInfo.label}`,
    model: buildMideaModelString(record.type),
    home_name: record.homeName || "我的家",
    room_name: record.roomName || "默认房间",
    online: record.online,
    spec_type: buildMideaSpecType(record.type),
    switch_channels: [],
    light_features: [],
    metric_features: [...typeInfo.metricFeatures],
    firmware: firmwareParts.join(" · "),
    platform: "midea",
  });
}

function buildAcProps(): PropInfo[] {
  return [
    createPropInfo({
      name: "on",
      desc: "电源开关",
      type: "bool",
      readable: true,
      writable: true,
      service: "air-conditioner",
      service_desc: "空调控制",
    }),
    createPropInfo({
      name: "mode",
      desc: "运行模式",
      type: "uint",
      readable: true,
      writable: true,
      value_list: [
        { value: 1, description: "Auto", desc_zh_cn: "自动" },
        { value: 2, description: "Cool", desc_zh_cn: "制冷" },
        { value: 3, description: "Dry", desc_zh_cn: "除湿" },
        { value: 4, description: "Heat", desc_zh_cn: "制热" },
        { value: 5, description: "Fan", desc_zh_cn: "送风" },
      ],
      service: "air-conditioner",
      service_desc: "空调控制",
    }),
    createPropInfo({
      name: "target-temperature",
      desc: "目标温度",
      type: "float",
      readable: true,
      writable: true,
      range: [16, 30, 0.5],
      unit: "°C",
      service: "air-conditioner",
      service_desc: "空调控制",
    }),
    createPropInfo({
      name: "fan-speed",
      desc: "风速档位",
      type: "uint",
      readable: true,
      writable: true,
      value_list: [
        { value: 102, description: "Auto", desc_zh_cn: "自动" },
        { value: 20, description: "Silent", desc_zh_cn: "静音" },
        { value: 40, description: "Low", desc_zh_cn: "低风" },
        { value: 60, description: "Medium", desc_zh_cn: "中风" },
        { value: 80, description: "High", desc_zh_cn: "高风" },
        { value: 100, description: "Full", desc_zh_cn: "强劲" },
      ],
      service: "air-conditioner",
      service_desc: "空调控制",
    }),
    createPropInfo({
      name: "swing-vertical",
      desc: "上下扫风",
      type: "bool",
      readable: true,
      writable: true,
      service: "fan-control",
      service_desc: "扫风与功能",
    }),
    createPropInfo({
      name: "swing-horizontal",
      desc: "左右扫风",
      type: "bool",
      readable: true,
      writable: true,
      service: "fan-control",
      service_desc: "扫风与功能",
    }),
    createPropInfo({
      name: "eco",
      desc: "ECO 节能",
      type: "bool",
      readable: true,
      writable: true,
      service: "fan-control",
      service_desc: "扫风与功能",
    }),
    createPropInfo({
      name: "turbo",
      desc: "强劲模式",
      type: "bool",
      readable: true,
      writable: true,
      service: "fan-control",
      service_desc: "扫风与功能",
    }),
    createPropInfo({
      name: "aux-heat",
      desc: "电辅热",
      type: "bool",
      readable: true,
      writable: true,
      service: "fan-control",
      service_desc: "扫风与功能",
    }),
    createPropInfo({
      name: "screen-display",
      desc: "机身屏显",
      type: "bool",
      readable: true,
      writable: true,
      service: "fan-control",
      service_desc: "扫风与功能",
    }),
    createPropInfo({
      name: "temperature",
      desc: "室内温度",
      type: "float",
      readable: true,
      writable: false,
      unit: "°C",
      service: "environment",
      service_desc: "环境监测",
    }),
    createPropInfo({
      name: "outdoor-temperature",
      desc: "室外温度",
      type: "float",
      readable: true,
      writable: false,
      unit: "°C",
      service: "environment",
      service_desc: "环境监测",
    }),
  ];
}

function buildDehumidifierProps(): PropInfo[] {
  return [
    createPropInfo({
      name: "on",
      desc: "电源开关",
      type: "bool",
      readable: true,
      writable: true,
      service: "dehumidifier",
      service_desc: "除湿机控制",
    }),
    createPropInfo({
      name: "mode",
      desc: "除湿模式",
      type: "uint",
      readable: true,
      writable: true,
      value_list: [
        { value: 1, description: "Target Humidity", desc_zh_cn: "设定湿度" },
        { value: 2, description: "Continuous", desc_zh_cn: "连续除湿" },
        { value: 3, description: "Smart", desc_zh_cn: "智能除湿" },
        { value: 4, description: "Clothes Dry", desc_zh_cn: "干衣模式" },
      ],
      service: "dehumidifier",
      service_desc: "除湿机控制",
    }),
    createPropInfo({
      name: "target-humidity",
      desc: "目标湿度",
      type: "uint",
      readable: true,
      writable: true,
      range: [35, 85, 5],
      unit: "%",
      service: "dehumidifier",
      service_desc: "除湿机控制",
    }),
    createPropInfo({
      name: "fan-speed",
      desc: "风速档位",
      type: "uint",
      readable: true,
      writable: true,
      value_list: [
        { value: 40, description: "Low", desc_zh_cn: "低风" },
        { value: 60, description: "Medium", desc_zh_cn: "中风" },
        { value: 80, description: "High", desc_zh_cn: "高风" },
      ],
      service: "dehumidifier",
      service_desc: "除湿机控制",
    }),
    createPropInfo({
      name: "relative-humidity",
      desc: "当前湿度",
      type: "uint",
      readable: true,
      writable: false,
      unit: "%",
      service: "environment",
      service_desc: "环境监测",
    }),
    createPropInfo({
      name: "tank-full",
      desc: "水箱已满",
      type: "bool",
      readable: true,
      writable: false,
      service: "dehumidifier",
      service_desc: "除湿机控制",
    }),
    createPropInfo({
      name: "ion",
      desc: "负离子",
      type: "bool",
      readable: true,
      writable: true,
      service: "dehumidifier",
      service_desc: "除湿机控制",
    }),
    createPropInfo({
      name: "swing",
      desc: "摆风",
      type: "bool",
      readable: true,
      writable: true,
      service: "dehumidifier",
      service_desc: "除湿机控制",
    }),
    createPropInfo({
      name: "child-lock",
      desc: "童锁",
      type: "bool",
      readable: true,
      writable: true,
      service: "dehumidifier",
      service_desc: "除湿机控制",
    }),
  ];
}

function buildFanProps(): PropInfo[] {
  return [
    createPropInfo({
      name: "on",
      desc: "电源开关",
      type: "bool",
      readable: true,
      writable: true,
      service: "fan",
      service_desc: "风扇控制",
    }),
    createPropInfo({
      name: "fan-speed",
      desc: "风速档位",
      type: "uint",
      readable: true,
      writable: true,
      range: [1, 26, 1],
      service: "fan",
      service_desc: "风扇控制",
    }),
    createPropInfo({
      name: "oscillate",
      desc: "摇头开关",
      type: "bool",
      readable: true,
      writable: true,
      service: "fan",
      service_desc: "风扇控制",
    }),
    createPropInfo({
      name: "mode",
      desc: "送风模式",
      type: "uint",
      readable: true,
      writable: true,
      value_list: [
        { value: 0, description: "Normal", desc_zh_cn: "正常风" },
        { value: 1, description: "Natural", desc_zh_cn: "自然风" },
        { value: 2, description: "Sleep", desc_zh_cn: "睡眠风" },
        { value: 3, description: "Comfort", desc_zh_cn: "舒适风" },
      ],
      service: "fan",
      service_desc: "风扇控制",
    }),
  ];
}

function buildPurifierProps(): PropInfo[] {
  return [
    createPropInfo({
      name: "on",
      desc: "电源开关",
      type: "bool",
      readable: true,
      writable: true,
      service: "air-purifier",
      service_desc: "空气净化器",
    }),
    createPropInfo({
      name: "mode",
      desc: "净化模式",
      type: "uint",
      readable: true,
      writable: true,
      value_list: [
        { value: 0x10, description: "Auto", desc_zh_cn: "自动" },
        { value: 0x20, description: "Manual", desc_zh_cn: "手动" },
        { value: 0x30, description: "Sleep", desc_zh_cn: "睡眠" },
      ],
      service: "air-purifier",
      service_desc: "空气净化器",
    }),
    createPropInfo({
      name: "fan-speed",
      desc: "风速档位",
      type: "uint",
      readable: true,
      writable: true,
      value_list: [
        { value: 0, description: "Auto", desc_zh_cn: "自动" },
        { value: 20, description: "Silent", desc_zh_cn: "静音" },
        { value: 40, description: "Low", desc_zh_cn: "低风" },
        { value: 60, description: "Medium", desc_zh_cn: "中风" },
        { value: 80, description: "High", desc_zh_cn: "高风" },
      ],
      service: "air-purifier",
      service_desc: "空气净化器",
    }),
    createPropInfo({
      name: "pm2.5-density",
      desc: "PM2.5 浓度",
      type: "uint",
      readable: true,
      writable: false,
      unit: "μg/m³",
      service: "environment",
      service_desc: "环境监测",
    }),
    createPropInfo({
      name: "ion",
      desc: "负离子",
      type: "bool",
      readable: true,
      writable: true,
      service: "air-purifier",
      service_desc: "空气净化器",
    }),
    createPropInfo({
      name: "child-lock",
      desc: "童锁",
      type: "bool",
      readable: true,
      writable: true,
      service: "air-purifier",
      service_desc: "空气净化器",
    }),
  ];
}

function buildHumidifierProps(): PropInfo[] {
  return [
    createPropInfo({
      name: "on",
      desc: "电源开关",
      type: "bool",
      readable: true,
      writable: true,
      service: "humidifier",
      service_desc: "加湿器控制",
    }),
    createPropInfo({
      name: "target-humidity",
      desc: "目标湿度",
      type: "uint",
      readable: true,
      writable: true,
      range: [40, 80, 5],
      unit: "%",
      service: "humidifier",
      service_desc: "加湿器控制",
    }),
    createPropInfo({
      name: "relative-humidity",
      desc: "当前湿度",
      type: "uint",
      readable: true,
      writable: false,
      unit: "%",
      service: "environment",
      service_desc: "环境监测",
    }),
    createPropInfo({
      name: "fan-speed",
      desc: "加湿档位",
      type: "uint",
      readable: true,
      writable: true,
      range: [1, 100, 1],
      service: "humidifier",
      service_desc: "加湿器控制",
    }),
    createPropInfo({
      name: "tank-empty",
      desc: "缺水提醒",
      type: "bool",
      readable: true,
      writable: false,
      service: "humidifier",
      service_desc: "加湿器控制",
    }),
  ];
}

function buildWaterHeaterProps(): PropInfo[] {
  return [
    createPropInfo({
      name: "on",
      desc: "电源开关",
      type: "bool",
      readable: true,
      writable: true,
      service: "water-heater",
      service_desc: "热水器控制",
    }),
    createPropInfo({
      name: "target-temperature",
      desc: "目标水温",
      type: "uint",
      readable: true,
      writable: true,
      range: [30, 75, 1],
      unit: "°C",
      service: "water-heater",
      service_desc: "热水器控制",
    }),
    createPropInfo({
      name: "temperature",
      desc: "当前水温",
      type: "uint",
      readable: true,
      writable: false,
      unit: "°C",
      service: "environment",
      service_desc: "状态监测",
    }),
    createPropInfo({
      name: "heating",
      desc: "加热状态",
      type: "bool",
      readable: true,
      writable: false,
      service: "water-heater",
      service_desc: "热水器控制",
    }),
  ];
}

function buildGenericProps(): PropInfo[] {
  return [
    createPropInfo({
      name: "on",
      desc: "电源开关",
      type: "bool",
      readable: true,
      writable: true,
      service: "appliance",
      service_desc: "设备控制",
    }),
  ];
}

export function mapMideaDeviceToDetail(
  record: MideaApplianceRecord,
  _state?: MideaApplianceState | null,
): DeviceDetail {
  let props: PropInfo[];
  switch (record.type & 0xff) {
    case 0xac:
    case 0xcc:
      props = buildAcProps();
      break;
    case 0xa1:
      props = buildDehumidifierProps();
      break;
    case 0xfa:
      props = buildFanProps();
      break;
    case 0xfc:
      props = buildPurifierProps();
      break;
    case 0xfd:
      props = buildHumidifierProps();
      break;
    case 0xe2:
    case 0xe3:
      props = buildWaterHeaterProps();
      break;
    default:
      props = buildGenericProps();
      break;
  }

  const actions: ActionInfo[] = [
    {
      name: "toggle-power",
      desc: "切换电源开关",
      service: "device",
      service_desc: "快捷操作",
      in: [],
    },
    {
      name: "refresh-status",
      desc: "立即刷新设备状态",
      service: "device",
      service_desc: "快捷操作",
      in: [],
    },
  ];

  return {
    did: record.id,
    name: record.name,
    model: buildMideaModelString(record.type),
    props,
    actions,
  };
}

export function readMideaStateProp(state: MideaApplianceState, propName: string): unknown {
  const key = normalizePropKey(propName);
  if (key === "on" || key === "power") {
    return state.power;
  }

  switch (state.kind) {
    case "ac":
      switch (key) {
        case "mode":
          return state.mode;
        case "target-temperature":
          return state.targetTemperature;
        case "fan-speed":
          return state.fanSpeed;
        case "swing-vertical":
          return state.swingVertical;
        case "swing-horizontal":
          return state.swingHorizontal;
        case "eco":
          return state.eco;
        case "turbo":
          return state.turbo;
        case "aux-heat":
          return state.auxHeat;
        case "screen-display":
          return state.screenDisplay;
        case "temperature":
        case "indoor-temperature":
          return state.indoorTemperature ?? null;
        case "outdoor-temperature":
          return state.outdoorTemperature ?? null;
        default:
          return null;
      }
    case "dehumidifier":
      switch (key) {
        case "mode":
          return state.mode;
        case "target-humidity":
          return state.targetHumidity;
        case "relative-humidity":
        case "humidity":
        case "current-humidity":
          return state.currentHumidity ?? null;
        case "temperature":
          return state.currentTemperature ?? null;
        case "fan-speed":
          return state.fanSpeed;
        case "tank-full":
          return state.tankFull;
        case "ion":
          return state.ion;
        case "swing":
          return state.swing;
        case "child-lock":
          return state.childLock;
        default:
          return null;
      }
    case "fan":
      switch (key) {
        case "fan-speed":
        case "speed":
          return state.fanSpeed;
        case "oscillate":
        case "swing":
          return state.oscillate;
        case "mode":
          return state.mode;
        default:
          return null;
      }
    case "purifier":
      switch (key) {
        case "mode":
          return state.mode;
        case "fan-speed":
          return state.fanSpeed;
        case "pm2.5-density":
        case "pm25":
          return state.pm25 ?? null;
        case "ion":
          return state.ion;
        case "child-lock":
          return state.childLock;
        default:
          return null;
      }
    case "humidifier":
      switch (key) {
        case "target-humidity":
          return state.targetHumidity;
        case "relative-humidity":
        case "humidity":
          return state.currentHumidity ?? null;
        case "fan-speed":
          return state.fanSpeed;
        case "tank-empty":
          return state.tankEmpty;
        default:
          return null;
      }
    case "water-heater":
      switch (key) {
        case "target-temperature":
          return state.targetTemperature;
        case "temperature":
          return state.currentTemperature ?? null;
        case "heating":
          return state.heating;
        default:
          return null;
      }
    case "generic":
      return key === "raw-hex" ? state.rawHex : null;
  }
}

export function applyMideaStateProp(
  state: MideaApplianceState,
  propName: string,
  value: unknown,
): MideaApplianceState {
  const key = normalizePropKey(propName);

  if (key === "on" || key === "power") {
    return { ...state, power: coerceBoolean(value, propName) };
  }

  switch (state.kind) {
    case "ac": {
      switch (key) {
        case "mode": {
          const m = Math.round(coerceNumber(value, propName));
          if (m < 1 || m > 5) {
            throw new ServiceError("空调运行模式范围应为 1~5（自动/制冷/除湿/制热/送风）");
          }
          return { ...state, mode: m as MideaAcMode };
        }
        case "target-temperature": {
          const t = coerceNumber(value, propName);
          const snapped = clamp(Math.round(t * 2) / 2, 16, 30);
          return { ...state, targetTemperature: snapped };
        }
        case "fan-speed": {
          const s = clamp(Math.round(coerceNumber(value, propName)), 1, 102);
          return { ...state, fanSpeed: s };
        }
        case "swing-vertical":
          return { ...state, swingVertical: coerceBoolean(value, propName) };
        case "swing-horizontal":
          return { ...state, swingHorizontal: coerceBoolean(value, propName) };
        case "eco":
          return { ...state, eco: coerceBoolean(value, propName) };
        case "turbo":
          return { ...state, turbo: coerceBoolean(value, propName) };
        case "aux-heat":
          return { ...state, auxHeat: coerceBoolean(value, propName) };
        case "screen-display":
          return { ...state, screenDisplay: coerceBoolean(value, propName) };
        case "temperature":
        case "outdoor-temperature":
          throw new ServiceError(`属性「${propName}」为只读传感器读数，不可写入`);
        default:
          throw new ServiceError(`美的空调不支持属性「${propName}」`);
      }
    }
    case "dehumidifier": {
      switch (key) {
        case "mode": {
          const m = Math.round(coerceNumber(value, propName));
          if (m < 1 || m > 4) {
            throw new ServiceError("除湿机模式范围应为 1~4");
          }
          return { ...state, mode: m as MideaDehumidifierMode };
        }
        case "target-humidity":
          return {
            ...state,
            targetHumidity: clamp(Math.round(coerceNumber(value, propName)), 35, 85),
          };
        case "fan-speed":
          return {
            ...state,
            fanSpeed: clamp(Math.round(coerceNumber(value, propName)), 1, 102),
          };
        case "ion":
          return { ...state, ion: coerceBoolean(value, propName) };
        case "swing":
          return { ...state, swing: coerceBoolean(value, propName) };
        case "child-lock":
          return { ...state, childLock: coerceBoolean(value, propName) };
        case "relative-humidity":
        case "tank-full":
          throw new ServiceError(`属性「${propName}」为只读状态，不可写入`);
        default:
          throw new ServiceError(`美的除湿机不支持属性「${propName}」`);
      }
    }
    case "fan": {
      switch (key) {
        case "fan-speed":
        case "speed":
          return {
            ...state,
            fanSpeed: clamp(Math.round(coerceNumber(value, propName)), 1, 26),
          };
        case "oscillate":
        case "swing":
          return { ...state, oscillate: coerceBoolean(value, propName) };
        case "mode":
          return {
            ...state,
            mode: clamp(Math.round(coerceNumber(value, propName)), 0, 3),
          };
        default:
          throw new ServiceError(`美的风扇不支持属性「${propName}」`);
      }
    }
    case "purifier": {
      switch (key) {
        case "mode":
          return { ...state, mode: Math.round(coerceNumber(value, propName)) & 0xf0 };
        case "fan-speed":
          return { ...state, fanSpeed: clamp(Math.round(coerceNumber(value, propName)), 0, 102) };
        case "ion":
          return { ...state, ion: coerceBoolean(value, propName) };
        case "child-lock":
          return { ...state, childLock: coerceBoolean(value, propName) };
        case "pm2.5-density":
          throw new ServiceError(`属性「${propName}」为只读传感器读数，不可写入`);
        default:
          throw new ServiceError(`美的空气净化器不支持属性「${propName}」`);
      }
    }
    case "humidifier": {
      switch (key) {
        case "target-humidity":
          return {
            ...state,
            targetHumidity: clamp(Math.round(coerceNumber(value, propName)), 40, 80),
          };
        case "fan-speed":
          return { ...state, fanSpeed: clamp(Math.round(coerceNumber(value, propName)), 1, 100) };
        case "relative-humidity":
        case "tank-empty":
          throw new ServiceError(`属性「${propName}」为只读状态，不可写入`);
        default:
          throw new ServiceError(`美的加湿器不支持属性「${propName}」`);
      }
    }
    case "water-heater": {
      switch (key) {
        case "target-temperature":
          return {
            ...state,
            targetTemperature: clamp(Math.round(coerceNumber(value, propName)), 30, 75),
          };
        case "temperature":
        case "heating":
          throw new ServiceError(`属性「${propName}」为只读状态，不可写入`);
        default:
          throw new ServiceError(`美的热水器不支持属性「${propName}」`);
      }
    }
    case "generic":
      throw new ServiceError(`该美的设备暂不支持写入属性「${propName}」`);
  }
}

export function formatMideaMetrics(state: MideaApplianceState | null | undefined): string | null {
  if (!state) {
    return null;
  }
  switch (state.kind) {
    case "ac":
      return formatMetricsText(state.indoorTemperature ?? state.targetTemperature, null);
    case "dehumidifier":
      return formatMetricsText(
        state.currentTemperature ?? null,
        state.currentHumidity ?? state.targetHumidity,
      );
    case "humidifier":
      return formatMetricsText(null, state.currentHumidity ?? state.targetHumidity);
    case "purifier":
      return state.pm25 !== undefined ? `PM2.5 ${state.pm25} μg/m³` : null;
    case "water-heater":
      return formatMetricsText(state.currentTemperature ?? state.targetTemperature, null);
    default:
      return null;
  }
}
