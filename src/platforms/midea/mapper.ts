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
  MideaWasherDrumKey,
  MideaWasherDrumState,
  MideaWasherState,
  MideaWasherTypeCode,
} from "./protocols.ts";
import {
  WASHER_PROGRESS_OPTIONS,
  WASHER_RUNNING_STATUS_OPTIONS,
  defaultWasherState,
  formatWasherProgressStage,
  getWasherProgramOptions,
  isMideaWasherType,
  normalizeWasherProgram,
  resolveMideaWasherProfile,
  resolveWasherTargetDrum,
  syncActiveDrumToTopLevel,
} from "./washer.ts";

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
  manufacturerCode?: string;
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

function buildWasherProps(
  record: MideaApplianceRecord,
  state?: MideaWasherState | null,
): PropInfo[] {
  const code = (record.type & 0xff) as MideaWasherTypeCode;
  const meta = {
    sn8: record.sn8 ?? state?.sn8,
    modelNumber: record.model ?? state?.modelNumber,
  };
  const profile = resolveMideaWasherProfile(code, meta);
  const activeDrumKey = state?.activeDrum ?? profile.defaultDrum;
  const activeSpec =
    profile.drums.find((d) => d.key === activeDrumKey) ?? profile.drums[0]!;
  const isDcDryer = activeSpec.bucket === "dc";

  const props: PropInfo[] = [
    createPropInfo({
      name: "on",
      desc: "电源开关",
      type: "bool",
      readable: true,
      writable: true,
      service: "washer-status",
      service_desc: "洗衣机控制",
    }),
    createPropInfo({
      name: "control-status",
      desc: "启停控制",
      type: "bool",
      readable: true,
      writable: true,
      service: "washer-status",
      service_desc: "洗衣机控制",
    }),
    createPropInfo({
      name: "running-status",
      desc: "运行状态",
      type: "string",
      readable: true,
      writable: false,
      value_list: [...WASHER_RUNNING_STATUS_OPTIONS],
      service: "washer-status",
      service_desc: "洗衣机控制",
    }),
    createPropInfo({
      name: "progress",
      desc: "当前阶段",
      type: "string",
      readable: true,
      writable: false,
      value_list: [...WASHER_PROGRESS_OPTIONS],
      service: "washer-status",
      service_desc: "洗衣机控制",
    }),
    createPropInfo({
      name: "remain-time",
      desc: "剩余时间",
      type: "uint",
      readable: true,
      writable: false,
      unit: "分钟",
      service: "washer-status",
      service_desc: "洗衣机控制",
    }),
    createPropInfo({
      name: "program",
      desc: isDcDryer ? "烘干程序" : "洗涤程序",
      type: "string",
      readable: true,
      writable: true,
      value_list: getWasherProgramOptions(code, activeSpec.key, meta, state?.program),
      service: "washer-status",
      service_desc: "洗衣机控制",
    }),
  ];

  // 0xD9 多筒机型：暴露筒位切换与各筒实时状态/程序属性
  if (profile.drums.length > 1) {
    props.push(
      createPropInfo({
        name: "drum-location",
        desc: "当前操作筒",
        type: "string",
        readable: true,
        writable: true,
        value_list: profile.drums.map((drum) => ({
          value: drum.key,
          description: drum.key,
          desc_zh_cn: drum.label,
        })),
        service: "washer-drum",
        service_desc: "多筒管理",
      }),
    );
    for (const drum of profile.drums) {
      const drumState = state?.drums[drum.key];
      props.push(
        createPropInfo({
          name: `drum-${drum.key}-status`,
          desc: `${drum.shortLabel}运行状态`,
          type: "string",
          readable: true,
          writable: false,
          value_list: [...WASHER_RUNNING_STATUS_OPTIONS],
          service: "washer-drum",
          service_desc: "多筒管理",
        }),
        createPropInfo({
          name: `drum-${drum.key}-program`,
          desc: `${drum.shortLabel}程序`,
          type: "string",
          readable: true,
          writable: true,
          value_list: getWasherProgramOptions(code, drum.key, meta, drumState?.program),
          service: "washer-drum",
          service_desc: "多筒管理",
        }),
        createPropInfo({
          name: `drum-${drum.key}-remain-time`,
          desc: `${drum.shortLabel}剩余时间`,
          type: "uint",
          readable: true,
          writable: false,
          unit: "分钟",
          service: "washer-drum",
          service_desc: "多筒管理",
        }),
        createPropInfo({
          name: `drum-${drum.key}-progress`,
          desc: `${drum.shortLabel}阶段`,
          type: "string",
          readable: true,
          writable: false,
          value_list: [...WASHER_PROGRESS_OPTIONS],
          service: "washer-drum",
          service_desc: "多筒管理",
        }),
        createPropInfo({
          name: `drum-${drum.key}-detergent-lack`,
          desc: `${drum.shortLabel}洗衣液不足`,
          type: "bool",
          readable: true,
          writable: false,
          service: "washer-drum",
          service_desc: "多筒管理",
        }),
      );
    }
  }

  // 洗涤参数
  if (code === 0xda) {
    props.push(
      createPropInfo({
        name: "mode",
        desc: "洗涤模式",
        type: "string",
        readable: true,
        writable: true,
        value_list: [
          { value: "normal", description: "Normal", desc_zh_cn: "常规" },
          { value: "fast", description: "Fast", desc_zh_cn: "快速" },
          { value: "heavy", description: "Heavy", desc_zh_cn: "强力" },
          { value: "gentle", description: "Gentle", desc_zh_cn: "轻柔" },
        ],
        service: "washer-params",
        service_desc: "洗涤参数",
      }),
      createPropInfo({
        name: "wash-level",
        desc: "洗涤水位",
        type: "uint",
        readable: true,
        writable: true,
        range: [1, 8, 1],
        service: "washer-params",
        service_desc: "洗涤参数",
      }),
      createPropInfo({
        name: "rinse-level",
        desc: "漂洗水位",
        type: "uint",
        readable: true,
        writable: true,
        range: [1, 8, 1],
        service: "washer-params",
        service_desc: "洗涤参数",
      }),
      createPropInfo({
        name: "wash-strength",
        desc: "洗涤力度",
        type: "uint",
        readable: true,
        writable: true,
        value_list: [
          { value: 1, description: "Gentle", desc_zh_cn: "轻柔" },
          { value: 2, description: "Standard", desc_zh_cn: "标准" },
          { value: 3, description: "Strong", desc_zh_cn: "强劲" },
          { value: 4, description: "Extra Strong", desc_zh_cn: "超强" },
        ],
        service: "washer-params",
        service_desc: "洗涤参数",
      }),
      createPropInfo({
        name: "wash-time",
        desc: "洗涤时长",
        type: "uint",
        readable: true,
        writable: true,
        range: [0, 20, 1],
        unit: "分钟",
        service: "washer-params",
        service_desc: "洗涤参数",
      }),
      createPropInfo({
        name: "soak-time",
        desc: "浸泡时长",
        type: "uint",
        readable: true,
        writable: true,
        range: [0, 40, 5],
        unit: "分钟",
        service: "washer-params",
        service_desc: "洗涤参数",
      }),
      createPropInfo({
        name: "rinse-count",
        desc: "漂洗次数",
        type: "uint",
        readable: true,
        writable: true,
        range: [0, 5, 1],
        unit: "次",
        service: "washer-params",
        service_desc: "洗涤参数",
      }),
      createPropInfo({
        name: "dehydration-time",
        desc: "脱水时长",
        type: "uint",
        readable: true,
        writable: true,
        range: [0, 9, 1],
        unit: "分钟",
        service: "washer-params",
        service_desc: "洗涤参数",
      }),
      createPropInfo({
        name: "dehydration-speed",
        desc: "脱水转速",
        type: "uint",
        readable: true,
        writable: true,
        unit: "RPM",
        value_list: [
          { value: 0, description: "No Spin", desc_zh_cn: "免脱水" },
          { value: 400, description: "400 RPM", desc_zh_cn: "400 转" },
          { value: 800, description: "800 RPM", desc_zh_cn: "800 转" },
          { value: 1200, description: "1200 RPM", desc_zh_cn: "1200 转" },
        ],
        service: "washer-params",
        service_desc: "洗涤参数",
      }),
      createPropInfo({
        name: "detergent",
        desc: "洗衣液投放",
        type: "uint",
        readable: true,
        writable: true,
        value_list: [
          { value: 0, description: "Off", desc_zh_cn: "关闭" },
          { value: 1, description: "Low", desc_zh_cn: "少量" },
          { value: 2, description: "Standard", desc_zh_cn: "标准" },
          { value: 3, description: "High", desc_zh_cn: "较多" },
          { value: 4, description: "Auto", desc_zh_cn: "智能投放" },
        ],
        service: "washer-params",
        service_desc: "洗涤参数",
      }),
      createPropInfo({
        name: "softener",
        desc: "柔顺剂投放",
        type: "uint",
        readable: true,
        writable: true,
        value_list: [
          { value: 0, description: "Off", desc_zh_cn: "关闭" },
          { value: 1, description: "Low", desc_zh_cn: "少量" },
          { value: 2, description: "Standard", desc_zh_cn: "标准" },
          { value: 3, description: "High", desc_zh_cn: "较多" },
          { value: 4, description: "Auto", desc_zh_cn: "智能投放" },
        ],
        service: "washer-params",
        service_desc: "洗涤参数",
      }),
    );
  } else {
    if (!isDcDryer) {
      props.push(
        createPropInfo({
          name: "temperature",
          desc: "洗涤水温",
          type: "uint",
          readable: true,
          writable: true,
          unit: "°C",
          value_list: [
            { value: 0, description: "Cold", desc_zh_cn: "冷水" },
            { value: 20, description: "20°C", desc_zh_cn: "20°C" },
            { value: 30, description: "30°C", desc_zh_cn: "30°C" },
            { value: 40, description: "40°C", desc_zh_cn: "40°C" },
            { value: 60, description: "60°C", desc_zh_cn: "60°C" },
            { value: 70, description: "70°C", desc_zh_cn: "70°C" },
            { value: 95, description: "95°C", desc_zh_cn: "95°C" },
          ],
          service: "washer-params",
          service_desc: "洗涤参数",
        }),
        createPropInfo({
          name: "dehydration-speed",
          desc: "脱水转速",
          type: "uint",
          readable: true,
          writable: true,
          unit: "RPM",
          value_list: [
            { value: 0, description: "No Spin", desc_zh_cn: "免脱水" },
            { value: 400, description: "400 RPM", desc_zh_cn: "400 转" },
            { value: 600, description: "600 RPM", desc_zh_cn: "600 转" },
            { value: 800, description: "800 RPM", desc_zh_cn: "800 转" },
            { value: 1000, description: "1000 RPM", desc_zh_cn: "1000 转" },
            { value: 1200, description: "1200 RPM", desc_zh_cn: "1200 转" },
            { value: 1400, description: "1400 RPM", desc_zh_cn: "1400 转" },
          ],
          service: "washer-params",
          service_desc: "洗涤参数",
        }),
        createPropInfo({
          name: "rinse-count",
          desc: "漂洗次数",
          type: "uint",
          readable: true,
          writable: true,
          range: [1, 5, 1],
          unit: "次",
          service: "washer-params",
          service_desc: "洗涤参数",
        }),
        createPropInfo({
          name: "water-level",
          desc: "洗涤水位",
          type: "uint",
          readable: true,
          writable: true,
          value_list: [
            { value: 1, description: "Low", desc_zh_cn: "低水位" },
            { value: 2, description: "Medium", desc_zh_cn: "中水位" },
            { value: 3, description: "High", desc_zh_cn: "高水位" },
            { value: 4, description: "Extra High", desc_zh_cn: "超高水位" },
            { value: 5, description: "Auto", desc_zh_cn: "自动水位" },
          ],
          service: "washer-params",
          service_desc: "洗涤参数",
        }),
      );
    }

    if (activeSpec.hasDry) {
      props.push(
        createPropInfo({
          name: "dry-mode",
          desc: "烘干模式",
          type: "uint",
          readable: true,
          writable: true,
          value_list: [
            { value: 0, description: "Off", desc_zh_cn: "不烘干" },
            { value: 1, description: "Smart Dry", desc_zh_cn: "智能烘" },
            { value: 2, description: "Strong Dry", desc_zh_cn: "强力烘" },
            { value: 3, description: "Extra Dry", desc_zh_cn: "超干即穿" },
            { value: 4, description: "Low Temp", desc_zh_cn: "低温柔烘" },
            { value: 5, description: "30 min", desc_zh_cn: "定时 30 分钟" },
            { value: 6, description: "60 min", desc_zh_cn: "定时 60 分钟" },
            { value: 7, description: "90 min", desc_zh_cn: "定时 90 分钟" },
            { value: 8, description: "120 min", desc_zh_cn: "定时 120 分钟" },
          ],
          service: "washer-params",
          service_desc: "洗涤参数",
        }),
      );
    }

    if (!isDcDryer) {
      props.push(
        createPropInfo({
          name: "detergent",
          desc: "洗衣液投放",
          type: "uint",
          readable: true,
          writable: true,
          value_list: [
            { value: 0, description: "Off", desc_zh_cn: "关闭" },
            { value: 1, description: "Low", desc_zh_cn: "少量" },
            { value: 2, description: "Standard", desc_zh_cn: "标准" },
            { value: 3, description: "High", desc_zh_cn: "较多" },
            { value: 4, description: "Auto", desc_zh_cn: "智能投放" },
          ],
          service: "washer-params",
          service_desc: "洗涤参数",
        }),
      );
      if (activeSpec.hasSoftener) {
        props.push(
          createPropInfo({
            name: "softener",
            desc: "柔顺剂投放",
            type: "uint",
            readable: true,
            writable: true,
            value_list: [
              { value: 0, description: "Off", desc_zh_cn: "关闭" },
              { value: 1, description: "Low", desc_zh_cn: "少量" },
              { value: 2, description: "Standard", desc_zh_cn: "标准" },
              { value: 3, description: "High", desc_zh_cn: "较多" },
              { value: 4, description: "Auto", desc_zh_cn: "智能投放" },
            ],
            service: "washer-params",
            service_desc: "洗涤参数",
          }),
        );
      }
      props.push(
        createPropInfo({
          name: "wash-time",
          desc: "主洗时长",
          type: "uint",
          readable: true,
          writable: true,
          range: [0, 60, 1],
          unit: "分钟",
          service: "washer-params",
          service_desc: "洗涤参数",
        }),
        createPropInfo({
          name: "dehydration-time",
          desc: "脱水时长",
          type: "uint",
          readable: true,
          writable: true,
          range: [0, 15, 1],
          unit: "分钟",
          service: "washer-params",
          service_desc: "洗涤参数",
        }),
      );
    }
  }

  props.push(
    createPropInfo({
      name: "appointment-time",
      desc: "预约完成时间",
      type: "uint",
      readable: true,
      writable: true,
      range: [0, 1440, 30],
      unit: "分钟",
      service: "washer-params",
      service_desc: "洗涤参数",
    }),
  );

  // 附加功能
  props.push(
    createPropInfo({
      name: "child-lock",
      desc: "童锁",
      type: "bool",
      readable: true,
      writable: true,
      service: "washer-options",
      service_desc: "附加功能",
    }),
  );

  if (code !== 0xda) {
    props.push(
      createPropInfo({
        name: "steam-wash",
        desc: isDcDryer ? "除菌护理" : "蒸汽除菌洗",
        type: "bool",
        readable: true,
        writable: true,
        service: "washer-options",
        service_desc: "附加功能",
      }),
    );
    if (!isDcDryer) {
      props.push(
        createPropInfo({
          name: "nightly-wash",
          desc: "夜间静音洗",
          type: "bool",
          readable: true,
          writable: true,
          service: "washer-options",
          service_desc: "附加功能",
        }),
        createPropInfo({
          name: "fast-clean-wash",
          desc: "加速洗",
          type: "bool",
          readable: true,
          writable: true,
          service: "washer-options",
          service_desc: "附加功能",
        }),
        createPropInfo({
          name: "cycle-memory",
          desc: "程序记忆",
          type: "bool",
          readable: true,
          writable: true,
          service: "washer-options",
          service_desc: "附加功能",
        }),
        createPropInfo({
          name: "fresh-air-time",
          desc: "新风祛味时长",
          type: "uint",
          readable: true,
          writable: true,
          range: [0, 8, 1],
          unit: "小时",
          service: "washer-options",
          service_desc: "附加功能",
        }),
      );
    }
    if (code === 0xd9) {
      props.push(
        createPropInfo({
          name: "voice-dnd",
          desc: "语音免打扰",
          type: "bool",
          readable: true,
          writable: true,
          service: "washer-options",
          service_desc: "附加功能",
        }),
      );
    }
    if (code === 0xdb) {
      props.push(
        createPropInfo({
          name: "beforehand-wash",
          desc: "预洗",
          type: "bool",
          readable: true,
          writable: true,
          service: "washer-options",
          service_desc: "附加功能",
        }),
        createPropInfo({
          name: "super-clean-wash",
          desc: "特渍强洗",
          type: "bool",
          readable: true,
          writable: true,
          service: "washer-options",
          service_desc: "附加功能",
        }),
        createPropInfo({
          name: "stains",
          desc: "特渍类型",
          type: "uint",
          readable: true,
          writable: true,
          value_list: [
            { value: 0, description: "None", desc_zh_cn: "关闭" },
            { value: 1, description: "Blood", desc_zh_cn: "血渍" },
            { value: 2, description: "Sweat", desc_zh_cn: "汗渍" },
            { value: 3, description: "Oil", desc_zh_cn: "油渍" },
            { value: 4, description: "Mud", desc_zh_cn: "泥渍" },
            { value: 5, description: "Juice", desc_zh_cn: "果汁渍" },
            { value: 6, description: "Milk", desc_zh_cn: "奶渍" },
          ],
          service: "washer-options",
          service_desc: "附加功能",
        }),
      );
    }
  }

  // 耗材与安全状态
  props.push(
    createPropInfo({
      name: "door-opened",
      desc: "舱门开启",
      type: "bool",
      readable: true,
      writable: false,
      service: "washer-alerts",
      service_desc: "耗材与安全",
    }),
    createPropInfo({
      name: "detergent-lack",
      desc: "洗衣液不足",
      type: "bool",
      readable: true,
      writable: false,
      service: "washer-alerts",
      service_desc: "耗材与安全",
    }),
  );

  if (activeSpec.hasSoftener) {
    props.push(
      createPropInfo({
        name: "softener-lack",
        desc: "柔顺剂不足",
        type: "bool",
        readable: true,
        writable: false,
        service: "washer-alerts",
        service_desc: "耗材与安全",
      }),
    );
  }

  if (code !== 0xda) {
    props.push(
      createPropInfo({
        name: "water-overheating",
        desc: "水温过热告警",
        type: "bool",
        readable: true,
        writable: false,
        service: "washer-alerts",
        service_desc: "耗材与安全",
      }),
    );
    if (code === 0xd9 && activeSpec.hasDry) {
      props.push(
        createPropInfo({
          name: "drying-tunnel-overheating",
          desc: "风道过热告警",
          type: "bool",
          readable: true,
          writable: false,
          service: "washer-alerts",
          service_desc: "耗材与安全",
        }),
      );
    }
    if (activeSpec.supportsRemoteControlAgree !== false) {
      props.push(
        createPropInfo({
          name: "remote-control-flag",
          desc: "远程控制权限",
          type: "bool",
          readable: true,
          writable: false,
          service: "washer-alerts",
          service_desc: "耗材与安全",
        }),
      );
    }
  }

  props.push(
    createPropInfo({
      name: "error-code",
      desc: "故障代码",
      type: "string",
      readable: true,
      writable: false,
      service: "washer-alerts",
      service_desc: "耗材与安全",
    }),
  );

  return props;
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
  state?: MideaApplianceState | null,
): DeviceDetail {
  const typeCode = record.type & 0xff;
  const isWasher = isMideaWasherType(typeCode);
  let props: PropInfo[];
  switch (typeCode) {
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
    case 0xd9:
    case 0xda:
    case 0xdb:
      props = buildWasherProps(record, state?.kind === "washer" ? state : null);
      break;
    default:
      props = buildGenericProps();
      break;
  }

  const actions: ActionInfo[] = [];
  if (isWasher) {
    actions.push(
      {
        name: "start-wash",
        desc: "开始洗涤",
        service: "washer-status",
        service_desc: "洗衣机控制",
        in: [],
      },
      {
        name: "pause-wash",
        desc: "暂停洗涤",
        service: "washer-status",
        service_desc: "洗衣机控制",
        in: [],
      },
      {
        name: "cancel-appointment",
        desc: "取消预约",
        service: "washer-status",
        service_desc: "洗衣机控制",
        in: [],
      },
    );
  }
  actions.push(
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
  );

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
    case "washer":
      return readWasherStateProp(state, key);
    case "generic":
      return key === "raw-hex" ? state.rawHex : null;
  }
}

function readWasherDrumField(drum: MideaWasherDrumState, field: string): unknown {
  switch (field) {
    case "on":
    case "power":
      return drum.power;
    case "control-status":
    case "running":
    case "start":
      return drum.running;
    case "status":
    case "running-status":
      return drum.runningStatus;
    case "progress":
      return drum.progress;
    case "remain-time":
      return drum.remainTime;
    case "program":
      return drum.program;
    case "mode":
      return drum.mode;
    case "temperature":
      return drum.temperature;
    case "dehydration-speed":
      return drum.dehydrationSpeed;
    case "rinse-count":
      return drum.rinseCount;
    case "water-level":
      return drum.waterLevel;
    case "wash-level":
      return drum.washLevel;
    case "rinse-level":
      return drum.rinseLevel;
    case "wash-strength":
      return drum.washStrength;
    case "dry-mode":
    case "dry":
      return drum.dryMode;
    case "detergent":
      return drum.detergent;
    case "softener":
      return drum.softener;
    case "wash-time":
      return drum.washTime;
    case "soak-time":
      return drum.soakTime;
    case "dehydration-time":
      return drum.dehydrationTime;
    case "child-lock":
    case "baby-lock":
    case "lock":
      return drum.childLock;
    case "nightly-wash":
      return drum.nightlyWash;
    case "steam-wash":
      return drum.steamWash;
    case "fast-clean-wash":
      return drum.fastCleanWash;
    case "beforehand-wash":
      return drum.beforehandWash;
    case "super-clean-wash":
      return drum.superCleanWash;
    case "cycle-memory":
      return drum.cycleMemory;
    case "stains":
      return drum.stains;
    case "fresh-air-time":
      return drum.freshAirTime;
    case "appointment-time":
      return drum.appointmentTime;
    case "voice-dnd":
      return drum.voiceDnd;
    case "door-opened":
      return drum.doorOpened;
    case "detergent-lack":
      return drum.detergentLack;
    case "softener-lack":
      return drum.softenerLack;
    case "water-overheating":
      return drum.waterOverheating;
    case "drying-tunnel-overheating":
      return drum.dryingTunnelOverheating;
    case "remote-control-flag":
      return drum.remoteControlEnabled;
    case "error-code":
      return drum.errorCode;
    default:
      return null;
  }
}

function readWasherStateProp(state: MideaWasherState, key: string): unknown {
  if (key === "drum-location" || key === "location") {
    return state.activeDrum;
  }
  const drumMatch = /^drum-(bottom|left|right|top|main)-(.+)$/.exec(key);
  if (drumMatch) {
    const drumKey = drumMatch[1] as MideaWasherDrumKey;
    const field = drumMatch[2]!;
    const drum = state.drums[drumKey];
    return drum ? readWasherDrumField(drum, field) : null;
  }
  const activeDrum = state.drums[state.activeDrum];
  if (activeDrum) {
    return readWasherDrumField(activeDrum, key);
  }
  return null;
}

function applyWasherPowerProp(
  state: MideaWasherState,
  targetPower: boolean,
  targetDrumKey?: MideaWasherDrumKey,
): MideaWasherState {
  const profile = resolveMideaWasherProfile(state.deviceType, {
    sn8: state.sn8,
    modelNumber: state.modelNumber,
  });
  const base =
    Object.keys(state.drums).length > 0
      ? state
      : defaultWasherState(state.deviceType, {
          sn8: state.sn8,
          modelNumber: state.modelNumber,
        });
  const nextDrums: Partial<Record<MideaWasherDrumKey, MideaWasherDrumState>> = {
    ...base.drums,
  };
  const focusKey = targetDrumKey ?? base.activeDrum;
  const focusSpec =
    profile.drums.find((d) => d.key === focusKey) ?? profile.drums[0]!;

  // 复式三筒/双筒共享同 bucket 电源总线；上下洗烘分开控制 db/dc 电源
  const affectedKeys: MideaWasherDrumKey[] = targetDrumKey
    ? [focusSpec.key]
    : base.drumLayout === "stack-db-dc"
      ? [focusSpec.key]
      : profile.drums
          .filter((d) => d.bucket === focusSpec.bucket)
          .map((d) => d.key);

  for (const k of affectedKeys) {
    const existing = nextDrums[k];
    if (!existing) continue;
    nextDrums[k] = {
      ...existing,
      power: targetPower,
      running: targetPower ? existing.running : false,
      runningStatus: targetPower
        ? existing.runningStatus === "off"
          ? "standby"
          : existing.runningStatus
        : "off",
      progress: targetPower ? existing.progress : "idle",
      remoteControlEnabled: targetPower
        ? existing.remoteControlEnabled
        : existing.remoteControlEnabled === true
          ? true
          : null,
    };
  }

  return syncActiveDrumToTopLevel({
    ...base,
    drums: nextDrums,
  });
}

function applyWasherStateProp(
  state: MideaWasherState,
  propName: string,
  key: string,
  value: unknown,
): MideaWasherState {
  const meta = { sn8: state.sn8, modelNumber: state.modelNumber };
  const profile = resolveMideaWasherProfile(state.deviceType, meta);

  if (key === "drum-location" || key === "location") {
    const rawStr = String(value ?? "").trim();
    const lower = rawStr.toLowerCase();
    const asNum = Number(rawStr);
    const matched = profile.drums.find(
      (d) =>
        d.key === lower ||
        d.label === rawStr ||
        d.shortLabel === rawStr ||
        (Number.isFinite(asNum) && rawStr !== "" && d.location === Math.round(asNum)),
    );
    if (!matched) {
      const allowed = profile.drums.map((d) => `${d.key}(${d.shortLabel})`).join(" / ");
      throw new ServiceError(`无效的筒位「${rawStr}」，当前机型支持：${allowed}`);
    }
    return syncActiveDrumToTopLevel({
      ...state,
      activeDrum: matched.key,
      activeDrumLocation: matched.location,
      userSelectedDrum: true,
    });
  }

  const { drumKey, baseProp } = resolveWasherTargetDrum(state, key);
  if (baseProp === "on" || baseProp === "power") {
    return applyWasherPowerProp(state, coerceBoolean(value, propName), drumKey);
  }

  const existingDrum = state.drums[drumKey];
  if (!existingDrum) {
    throw new ServiceError(`洗衣机未找到目标筒「${drumKey}」`);
  }

  const updateDrum = (patch: Partial<MideaWasherDrumState>): MideaWasherState => {
    const nextDrums: Partial<Record<MideaWasherDrumKey, MideaWasherDrumState>> = {
      ...state.drums,
      [drumKey]: {
        ...existingDrum,
        ...patch,
      },
    };
    return syncActiveDrumToTopLevel({
      ...state,
      drums: nextDrums,
    });
  };

  switch (baseProp) {
    case "control-status":
    case "start":
    case "running": {
      const start = coerceBoolean(value, propName);
      return updateDrum({
        power: start ? true : existingDrum.power,
        running: start,
        runningStatus: start ? "start" : existingDrum.power ? "pause" : "off",
        progress: start ? (existingDrum.progress === "idle" ? "wash" : existingDrum.progress) : "idle",
      });
    }
    case "program": {
      const rawStr = typeof value === "number" ? String(value) : String(value ?? "").trim();
      if (!rawStr) {
        throw new ServiceError("洗涤程序不能为空");
      }
      return updateDrum({
        program: normalizeWasherProgram(rawStr, state.deviceType),
      });
    }
    case "mode": {
      const rawStr = String(value ?? "").trim();
      if (!rawStr) {
        throw new ServiceError("洗涤模式不能为空");
      }
      return updateDrum({ mode: rawStr });
    }
    case "temperature":
      return updateDrum({
        temperature: clamp(Math.round(coerceNumber(value, propName)), 0, 95),
      });
    case "dehydration-speed":
      return updateDrum({
        dehydrationSpeed: clamp(Math.round(coerceNumber(value, propName)), 0, 1600),
      });
    case "rinse-count":
      return updateDrum({
        rinseCount: clamp(Math.round(coerceNumber(value, propName)), 0, 5),
      });
    case "water-level":
      return updateDrum({
        waterLevel: clamp(Math.round(coerceNumber(value, propName)), 1, 5),
      });
    case "wash-level":
      return updateDrum({
        washLevel: clamp(Math.round(coerceNumber(value, propName)), 0, 8),
      });
    case "rinse-level":
      return updateDrum({
        rinseLevel: clamp(Math.round(coerceNumber(value, propName)), 0, 8),
      });
    case "wash-strength":
      return updateDrum({
        washStrength: clamp(Math.round(coerceNumber(value, propName)), 1, 4),
      });
    case "dry-mode":
    case "dry":
      return updateDrum({
        dryMode: clamp(Math.round(coerceNumber(value, propName)), 0, 15),
      });
    case "detergent":
      return updateDrum({
        detergent: clamp(Math.round(coerceNumber(value, propName)), 0, 5),
      });
    case "softener":
      return updateDrum({
        softener: clamp(Math.round(coerceNumber(value, propName)), 0, 5),
      });
    case "wash-time":
      return updateDrum({
        washTime: clamp(Math.round(coerceNumber(value, propName)), 0, 90),
      });
    case "soak-time":
      return updateDrum({
        soakTime: clamp(Math.round(coerceNumber(value, propName)), 0, 60),
      });
    case "dehydration-time":
      return updateDrum({
        dehydrationTime: clamp(Math.round(coerceNumber(value, propName)), 0, 30),
      });
    case "child-lock":
    case "baby-lock":
    case "lock":
      return updateDrum({ childLock: coerceBoolean(value, propName) });
    case "nightly-wash":
      return updateDrum({ nightlyWash: coerceBoolean(value, propName) });
    case "steam-wash":
      return updateDrum({ steamWash: coerceBoolean(value, propName) });
    case "fast-clean-wash":
      return updateDrum({ fastCleanWash: coerceBoolean(value, propName) });
    case "beforehand-wash":
      return updateDrum({ beforehandWash: coerceBoolean(value, propName) });
    case "super-clean-wash":
      return updateDrum({ superCleanWash: coerceBoolean(value, propName) });
    case "cycle-memory":
      return updateDrum({ cycleMemory: coerceBoolean(value, propName) });
    case "stains":
      return updateDrum({
        stains: clamp(Math.round(coerceNumber(value, propName)), 0, 15),
      });
    case "fresh-air-time":
      return updateDrum({
        freshAirTime: clamp(Math.round(coerceNumber(value, propName)), 0, 24),
      });
    case "appointment-time": {
      const mins = clamp(Math.round(coerceNumber(value, propName)), 0, 1440);
      return updateDrum({
        appointmentTime: mins,
        runningStatus:
          mins > 0
            ? "delay"
            : existingDrum.runningStatus === "delay"
              ? existingDrum.power
                ? "standby"
                : "off"
              : existingDrum.runningStatus,
      });
    }
    case "voice-dnd":
      return updateDrum({ voiceDnd: coerceBoolean(value, propName) });
    case "running-status":
    case "status":
    case "progress":
    case "remain-time":
    case "door-opened":
    case "detergent-lack":
    case "softener-lack":
    case "water-overheating":
    case "drying-tunnel-overheating":
    case "remote-control-flag":
    case "error-code":
      throw new ServiceError(`属性「${propName}」为只读状态，不可写入`);
    default:
      throw new ServiceError(`美的洗衣机不支持属性「${propName}」`);
  }
}

export function applyMideaStateProp(
  state: MideaApplianceState,
  propName: string,
  value: unknown,
): MideaApplianceState {
  const key = normalizePropKey(propName);

  if (key === "on" || key === "power") {
    const targetPower = coerceBoolean(value, propName);
    if (state.kind === "washer") {
      return applyWasherPowerProp(state, targetPower);
    }
    return { ...state, power: targetPower };
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
    case "washer":
      return applyWasherStateProp(state, propName, key, value);
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
    case "washer": {
      if (state.drumLayout !== "single") {
        const drums = Object.values(state.drums).filter(
          (d): d is MideaWasherDrumState => Boolean(d),
        );
        const runningDrums = drums.filter((d) => d.runningStatus === "start");
        if (runningDrums.length > 0) {
          return runningDrums
            .map((d) =>
              d.remainTime > 0 ? `${d.shortLabel} ${d.remainTime}分` : `${d.shortLabel} 运行中`,
            )
            .join(" · ");
        }
        const pausedDrum = drums.find((d) => d.runningStatus === "pause");
        if (pausedDrum) {
          return pausedDrum.remainTime > 0
            ? `${pausedDrum.shortLabel} 暂停 · 剩${pausedDrum.remainTime}分`
            : `${pausedDrum.shortLabel} 已暂停`;
        }
        const delayDrum = drums.find((d) => d.runningStatus === "delay");
        if (delayDrum) {
          return `${delayDrum.shortLabel} 预约中`;
        }
        const endDrum = drums.find((d) => d.runningStatus === "end");
        if (endDrum) {
          return `${endDrum.shortLabel} 已完成`;
        }
        return null;
      }
      if (state.runningStatus === "start") {
        const stage = state.progress !== "idle" ? formatWasherProgressStage(state.progress) : "运行中";
        return state.remainTime > 0 ? `${stage} · 剩 ${state.remainTime} 分` : stage;
      }
      if (state.runningStatus === "pause") {
        return state.remainTime > 0 ? `已暂停 · 剩 ${state.remainTime} 分` : "已暂停";
      }
      if (state.runningStatus === "delay") {
        return state.appointmentTime > 0 ? `预约中 · ${state.appointmentTime} 分` : "预约中";
      }
      if (state.runningStatus === "end") {
        return "已完成";
      }
      if (state.runningStatus === "fault") {
        return state.errorCode && state.errorCode !== "0" ? `故障 ${state.errorCode}` : "故障告警";
      }
      return null;
    }
    default:
      return null;
  }
}
