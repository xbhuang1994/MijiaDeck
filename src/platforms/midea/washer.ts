// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 美的洗衣机全品类协议编解码与多筒状态模型（0xD9 复式/三筒洗烘机、0xDB 滚筒洗衣机、0xDA 波轮洗衣机）
// 参考 Home Assistant midea-local (0xDB/0xDA 串口帧)、midea_auto_cloud 与 midea_smart_home (0xD9/0xDA/0xDB Lua 协议)

import type { PropEnumOption } from "../../core/models.ts";
import { buildMideaFrame, parseMideaFrame, type ParsedMideaFrame } from "./protocols.ts";

export type MideaWasherTypeCode = 0xd9 | 0xda | 0xdb;

export type MideaWasherDrumKey = "main" | "bottom" | "left" | "right" | "top";

export type MideaWasherDrumLayout = "single" | "triple-db" | "dual-db" | "stack-db-dc";

export type MideaWasherRunningStatus =
  | "off"
  | "idle"
  | "standby"
  | "start"
  | "pause"
  | "end"
  | "fault"
  | "delay";

export type MideaWasherProgressStage =
  | "idle"
  | "weight"
  | "pre_wash"
  | "soak"
  | "wash"
  | "rinse"
  | "spin"
  | "spin_high"
  | "dry"
  | "anti_wrinkle"
  | "cold_air"
  | "unknown";

export interface MideaWasherMeta {
  sn8?: string;
  modelNumber?: string;
}

export interface MideaWasherDrumSpec {
  readonly key: MideaWasherDrumKey;
  readonly label: string;
  readonly shortLabel: string;
  readonly bucket: "da" | "db" | "dc";
  readonly location: number;
  readonly hasSoftener: boolean;
  readonly hasDry: boolean;
}

export interface MideaWasherProfile {
  readonly deviceType: MideaWasherTypeCode;
  readonly layout: MideaWasherDrumLayout;
  readonly drums: readonly MideaWasherDrumSpec[];
  readonly defaultDrum: MideaWasherDrumKey;
}

export interface MideaWasherDrumState {
  key: MideaWasherDrumKey;
  label: string;
  shortLabel: string;
  bucket: "da" | "db" | "dc";
  location: number;
  isPanelSelected: boolean;
  power: boolean;
  running: boolean;
  runningStatus: MideaWasherRunningStatus;
  progress: MideaWasherProgressStage;
  program: string;
  mode: string;
  remainTime: number;
  washTime: number;
  soakTime: number;
  dehydrationTime: number;
  temperature: number;
  dehydrationSpeed: number;
  rinseCount: number;
  waterLevel: number;
  washLevel: number;
  rinseLevel: number;
  washStrength: number;
  dryMode: number;
  detergent: number;
  softener: number;
  childLock: boolean;
  nightlyWash: boolean;
  steamWash: boolean;
  fastCleanWash: boolean;
  beforehandWash: boolean;
  superCleanWash: boolean;
  cycleMemory: boolean;
  stains: number;
  freshAirTime: number;
  appointmentTime: number;
  voiceDnd: boolean;
  doorOpened: boolean;
  detergentLack: boolean;
  softenerLack: boolean;
  waterOverheating: boolean;
  dryingTunnelOverheating: boolean;
  remoteControlEnabled: boolean | null;
  errorCode: string;
  washTimeValue?: number;
  dehydrationTimeValue?: number;
}

export interface MideaWasherState {
  kind: "washer";
  deviceType: MideaWasherTypeCode;
  sn8?: string;
  modelNumber?: string;
  drumLayout: MideaWasherDrumLayout;
  activeDrum: MideaWasherDrumKey;
  activeDrumLocation: number;
  /** 用户显式切换过操作筒时保留选择，避免自动轮询把面板重置回默认筒 */
  userSelectedDrum?: boolean;
  power: boolean;
  running: boolean;
  runningStatus: MideaWasherRunningStatus;
  progress: MideaWasherProgressStage;
  program: string;
  mode: string;
  remainTime: number;
  washTime: number;
  soakTime: number;
  dehydrationTime: number;
  temperature: number;
  dehydrationSpeed: number;
  rinseCount: number;
  waterLevel: number;
  washLevel: number;
  rinseLevel: number;
  washStrength: number;
  dryMode: number;
  detergent: number;
  softener: number;
  childLock: boolean;
  nightlyWash: boolean;
  steamWash: boolean;
  fastCleanWash: boolean;
  beforehandWash: boolean;
  superCleanWash: boolean;
  cycleMemory: boolean;
  stains: number;
  freshAirTime: number;
  appointmentTime: number;
  voiceDnd: boolean;
  doorOpened: boolean;
  detergentLack: boolean;
  softenerLack: boolean;
  waterOverheating: boolean;
  dryingTunnelOverheating: boolean;
  remoteControlEnabled: boolean | null;
  errorCode: string;
  washTimeValue?: number;
  dehydrationTimeValue?: number;
  drums: Partial<Record<MideaWasherDrumKey, MideaWasherDrumState>>;
}

export interface MideaWasherLuaQueryPlan {
  readonly query: Record<string, unknown>;
  readonly drumKey: MideaWasherDrumKey;
  readonly location: number;
  readonly bucket: "da" | "db" | "dc";
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function isMideaWasherType(deviceType: number): deviceType is MideaWasherTypeCode {
  const code = deviceType & 0xff;
  return code === 0xd9 || code === 0xda || code === 0xdb;
}

// ---------- 型号与多筒配置解析 ----------

const TRIPLE_DB_38135636_DRUMS: readonly MideaWasherDrumSpec[] = [
  {
    key: "bottom",
    label: "下筒 · 主洗烘",
    shortLabel: "下筒",
    bucket: "db",
    location: 2,
    hasSoftener: true,
    hasDry: true,
  },
  {
    key: "left",
    label: "左筒 · 袜子筒",
    shortLabel: "左筒",
    bucket: "db",
    location: 3,
    hasSoftener: false,
    hasDry: true,
  },
  {
    key: "right",
    label: "右筒 · 内裤筒",
    shortLabel: "右筒",
    bucket: "db",
    location: 4,
    hasSoftener: false,
    hasDry: true,
  },
] as const;

const DUAL_DB_38138899_DRUMS: readonly MideaWasherDrumSpec[] = [
  {
    key: "left",
    label: "左筒",
    shortLabel: "左筒",
    bucket: "db",
    location: 3,
    hasSoftener: true,
    hasDry: true,
  },
  {
    key: "right",
    label: "右筒",
    shortLabel: "右筒",
    bucket: "db",
    location: 4,
    hasSoftener: true,
    hasDry: true,
  },
] as const;

const STACK_DB_DC_38206322_DRUMS: readonly MideaWasherDrumSpec[] = [
  {
    key: "bottom",
    label: "下筒 · 洗衣机",
    shortLabel: "下筒",
    bucket: "db",
    location: 2,
    hasSoftener: true,
    hasDry: false,
  },
  {
    key: "top",
    label: "上筒 · 干衣机",
    shortLabel: "上筒",
    bucket: "dc",
    location: 1,
    hasSoftener: false,
    hasDry: true,
  },
] as const;

const DEFAULT_DUAL_D9_DRUMS: readonly MideaWasherDrumSpec[] = [
  {
    key: "left",
    label: "左筒",
    shortLabel: "左筒",
    bucket: "db",
    location: 1,
    hasSoftener: true,
    hasDry: true,
  },
  {
    key: "right",
    label: "右筒",
    shortLabel: "右筒",
    bucket: "db",
    location: 2,
    hasSoftener: true,
    hasDry: true,
  },
] as const;

export function resolveMideaWasherProfile(
  deviceType: number,
  meta?: MideaWasherMeta,
): MideaWasherProfile {
  const code = (deviceType & 0xff) as MideaWasherTypeCode;
  const sn8 = (meta?.sn8 ?? "").trim();
  const modelNo = (meta?.modelNumber ?? "").trim();

  if (code === 0xd9) {
    if (sn8 === "38135636" || modelNo === "13363") {
      return {
        deviceType: 0xd9,
        layout: "triple-db",
        drums: TRIPLE_DB_38135636_DRUMS,
        defaultDrum: "bottom",
      };
    }
    if (sn8 === "38138899") {
      return {
        deviceType: 0xd9,
        layout: "dual-db",
        drums: DUAL_DB_38138899_DRUMS,
        defaultDrum: "left",
      };
    }
    if (sn8 === "38206322" || modelNo === "12856") {
      return {
        deviceType: 0xd9,
        layout: "stack-db-dc",
        drums: STACK_DB_DC_38206322_DRUMS,
        defaultDrum: "bottom",
      };
    }
    return {
      deviceType: 0xd9,
      layout: "dual-db",
      drums: DEFAULT_DUAL_D9_DRUMS,
      defaultDrum: "left",
    };
  }

  if (code === 0xda) {
    return {
      deviceType: 0xda,
      layout: "single",
      drums: [
        {
          key: "main",
          label: "波轮主筒",
          shortLabel: "主筒",
          bucket: "da",
          location: 1,
          hasSoftener: true,
          hasDry: false,
        },
      ],
      defaultDrum: "main",
    };
  }

  return {
    deviceType: 0xdb,
    layout: "single",
    drums: [
      {
        key: "main",
        label: "滚筒主筒",
        shortLabel: "主筒",
        bucket: "db",
        location: 1,
        hasSoftener: true,
        hasDry: true,
      },
    ],
    defaultDrum: "main",
  };
}

export function buildWasherLuaQueries(
  deviceType: number,
  meta?: MideaWasherMeta,
): MideaWasherLuaQueryPlan[] {
  const profile = resolveMideaWasherProfile(deviceType, meta);
  if (profile.deviceType !== 0xd9) {
    const main = profile.drums[0]!;
    return [
      {
        query: {},
        drumKey: main.key,
        location: main.location,
        bucket: main.bucket,
      },
    ];
  }
  return profile.drums.map((drum) => ({
    query:
      drum.bucket === "dc"
        ? { query_type: "dc", dc_location: drum.location }
        : drum.bucket === "da"
          ? { query_type: "da", da_location: drum.location }
          : { query_type: "db", db_location: drum.location },
    drumKey: drum.key,
    location: drum.location,
    bucket: drum.bucket,
  }));
}

// ---------- 程序字典与中英文映射 ----------

interface WasherProgramDef {
  readonly key: string;
  readonly zh: string;
  readonly en: string;
  readonly d9Wire?: string | number;
  readonly dbByte?: number;
  readonly daIndex?: number;
}

const WASHER_PROGRAMS: readonly WasherProgramDef[] = [
  // 滚筒 / 复式核心洗涤程序
  { key: "mixed_wash", zh: "混合洗", en: "Mixed Wash", d9Wire: "mixed_wash", dbByte: 0x03 },
  { key: "smart_wash_dry", zh: "智洗烘", en: "Smart Wash & Dry", d9Wire: 138 },
  { key: "cotton", zh: "棉麻", en: "Cotton", d9Wire: "cotton", dbByte: 0x00 },
  { key: "fast_wash", zh: "快洗15'", en: "Quick 15'", d9Wire: "fast_wash", dbByte: 0x02 },
  { key: "fast_wash_30", zh: "快洗30'", en: "Quick 30'", d9Wire: "fast_wash_30", dbByte: 0x17 },
  { key: "quick_wash", zh: "快洗45'", en: "Quick 45'", d9Wire: "quick_wash", dbByte: 0x12 },
  { key: "essence_wash", zh: "精华洗", en: "Essence Wash", d9Wire: 157 },
  { key: "intelligent", zh: "智能洗", en: "Intelligent", d9Wire: "intelligent", dbByte: 0x11 },
  { key: "eco", zh: "节能洗", en: "Eco", d9Wire: "eco", dbByte: 0x01 },
  { key: "eco_40_60", zh: "ECO 40-60", en: "Eco 40-60", d9Wire: "eco_40_60", dbByte: 0x6c },
  { key: "big", zh: "大件", en: "Bedding / Big", d9Wire: "big", dbByte: 0x0b },
  { key: "bulky", zh: "大件洗", en: "Bulky", d9Wire: "bulky", dbByte: 0x73 },
  { key: "down_jacket", zh: "羽绒服", en: "Down Jacket", d9Wire: "down_jacket", dbByte: 0x0f, daIndex: 7 },
  { key: "green_wool", zh: "羊毛", en: "Wool", d9Wire: "green_wool", dbByte: 0x67 },
  { key: "wool", zh: "羊毛洗", en: "Wool", d9Wire: "wool", dbByte: 0x05, daIndex: 3 },
  { key: "shirt", zh: "衬衫", en: "Shirt", d9Wire: "shirt", dbByte: 0x1c },
  { key: "jacket", zh: "冲锋衣", en: "Jacket", d9Wire: "jacket", dbByte: 0x3e },
  { key: "jean", zh: "牛仔", en: "Jeans", d9Wire: "jean", dbByte: 0x36 },
  { key: "fiber", zh: "化纤", en: "Synthetic", d9Wire: "fiber", dbByte: 0x04 },
  { key: "silk", zh: "真丝", en: "Silk", d9Wire: "silk", dbByte: 0x38 },
  { key: "sport_clothes", zh: "运动服", en: "Sportswear", d9Wire: "sport_clothes", dbByte: 0x08 },
  { key: "outdoor", zh: "户外服", en: "Outdoor", d9Wire: "outdoor", dbByte: 0x0d },
  { key: "baby_clothes", zh: "婴童服", en: "Baby Care", d9Wire: "baby_clothes", dbByte: 0x0c },
  { key: "kids", zh: "童装", en: "Kids", d9Wire: "kids", dbByte: 0x13 },
  { key: "color", zh: "护色洗", en: "Color Care", d9Wire: "color", dbByte: 0x10 },
  { key: "cold_wash", zh: "冷水洗", en: "Cold Wash", d9Wire: "cold_wash", dbByte: 0x2d },
  { key: "cook_wash", zh: "高温煮洗", en: "Boil Wash", d9Wire: "cook_wash", dbByte: 0x68 },
  { key: "steam_sterilize_wash", zh: "蒸汽除菌洗", en: "Steam Sterilize", d9Wire: "steam_sterilize_wash", dbByte: 0x6a },
  { key: "steam_care", zh: "蒸汽护理", en: "Steam Care", d9Wire: "steam_care", dbByte: 0x6d },
  { key: "allergy_care", zh: "防过敏洗", en: "Allergy Care", d9Wire: "allergy_care", dbByte: 0x6e },
  { key: "remove_mite_wash", zh: "除螨洗", en: "Mite Removal", d9Wire: "remove_mite_wash", dbByte: 0x2f },
  { key: "degerm", zh: "除菌螨", en: "Degerm", d9Wire: "degerm" },
  { key: "enzyme", zh: "加酶洗", en: "Enzyme", d9Wire: "enzyme", dbByte: 0x06 },
  { key: "clean_stains", zh: "特渍洗", en: "Stain Removal", d9Wire: "clean_stains" },
  { key: "steep", zh: "浸泡洗", en: "Soak Wash", d9Wire: "steep", dbByte: 0x1d },
  { key: "air_wash", zh: "空气洗", en: "Air Wash", d9Wire: "air_wash", dbByte: 0x0e },
  { key: "single_drying", zh: "单烘干", en: "Dry Only", d9Wire: "single_drying", dbByte: 0x15 },
  { key: "wash_drying_60", zh: "洗烘60'", en: "Wash & Dry 60'", d9Wire: "wash_drying_60", dbByte: 0x25 },
  { key: "rinsing_dehydration", zh: "漂+脱", en: "Rinse & Spin", d9Wire: "rinsing_dehydration", dbByte: 0x0a },
  { key: "single_dehytration", zh: "单脱水", en: "Spin Only", d9Wire: "single_dehytration", dbByte: 0x09 },
  { key: "ssp", zh: "筒自洁", en: "Drum Clean", d9Wire: "ssp", dbByte: 0x07 },
  { key: "deep_tub_self_clean", zh: "深度筒自洁", en: "Deep Drum Clean", d9Wire: 66 },
  { key: "self_wash_5", zh: "筒自洁", en: "Self Clean", d9Wire: "self_wash_5", dbByte: 0x26 },
  { key: "water_ssp", zh: "深度洁筒", en: "Deep Clean", d9Wire: "water_ssp", dbByte: 0x64 },
  { key: "detergent_box_clean", zh: "洗衣液盒清洁", en: "Detergent Box Clean", d9Wire: 160 },
  { key: "softener_box_clean", zh: "柔顺剂盒清洁", en: "Softener Box Clean", d9Wire: 161 },
  { key: "custom_detergent_box_clean", zh: "专洗盒清洁", en: "Special Box Clean", d9Wire: 159 },
  // 0xD9 小筒专属程序（可爱多三筒左/右小筒及双小筒）
  { key: "socks", zh: "袜子", en: "Socks", d9Wire: 148 },
  { key: "underpants", zh: "内裤", en: "Underpants", d9Wire: 156 },
  { key: "bra", zh: "文胸", en: "Bra", d9Wire: 144 },
  { key: "blood_stain_wash", zh: "净血渍", en: "Blood Stain Wash", d9Wire: 143 },
  { key: "oil_stains", zh: "油渍洗", en: "Oil Stain Wash", d9Wire: 142 },
  { key: "underwear", zh: "内衣", en: "Underwear", d9Wire: "underwear", dbByte: 0x22 },
  { key: "water_underwear", zh: "水韵内衣", en: "Underwear", d9Wire: "water_underwear", dbByte: 0x22 },
  { key: "baby_clothes_dry", zh: "婴童服烘", en: "Baby Dry", d9Wire: 151 },
  { key: "hot_wind_dry", zh: "热风暖衣", en: "Hot Wind Dry", d9Wire: 153 },
  { key: "fast_wash_d9", zh: "极速洗", en: "Fast Wash", d9Wire: 137 },
  { key: "fast_wash_drying", zh: "速洗烘", en: "Fast Wash & Dry", d9Wire: 165 },
  { key: "yoga_clothes", zh: "瑜伽服", en: "Yoga Wear", d9Wire: "yoga_clothes" },
  { key: "bath_towel", zh: "浴巾", en: "Bath Towel", d9Wire: "bath_towel", dbByte: 0x3f },
  { key: "new_clothes_wash", zh: "新衣洗", en: "New Clothes", d9Wire: "new_clothes_wash", dbByte: 0x37 },
  { key: "love", zh: "收藏程序", en: "Favorite", d9Wire: "love", dbByte: 0xfe },
  // 0xDA 波轮专属程序
  { key: "standard", zh: "标准洗", en: "Standard", d9Wire: "standard", dbByte: 0x66, daIndex: 0 },
  { key: "fast", zh: "速洗", en: "Fast", daIndex: 1 },
  { key: "blanket", zh: "家纺/毛毯", en: "Blanket", daIndex: 2 },
  { key: "embathe", zh: "浸洗", en: "Soak", daIndex: 4 },
  { key: "memory", zh: "记忆洗", en: "Memory", daIndex: 5 },
  { key: "child", zh: "童装", en: "Child", daIndex: 6 },
  { key: "stir", zh: "轻柔/搅洗", en: "Gentle", daIndex: 8 },
  { key: "mute", zh: "静音洗", en: "Quiet", daIndex: 9 },
  { key: "bucket_self_clean", zh: "桶自洁", en: "Tub Clean", daIndex: 10 },
  { key: "air_dry", zh: "风干", en: "Air Dry", daIndex: 11 },
  { key: "strong_wash", zh: "强力洗", en: "Heavy Duty" },
  // 0xDC 上筒干衣机程序（用于上下复式洗烘机）
  { key: "quick_dry", zh: "快烘", en: "Quick Dry", d9Wire: "quick_dry" },
  { key: "intelligent_dry", zh: "智能烘干", en: "Smart Dry", d9Wire: "intelligent_dry" },
  { key: "low_temp_dry", zh: "低温烘干", en: "Low Temp Dry", d9Wire: "low_temp_dry" },
  { key: "eco_dry", zh: "节能烘干", en: "Eco Dry", d9Wire: "eco_dry" },
  { key: "bedsheet", zh: "床单", en: "Bedsheet", d9Wire: "bedsheet" },
  { key: "fresh_air", zh: "空气清新", en: "Fresh Air", d9Wire: "fresh_air", dbByte: 0x3c },
];

const PROGRAM_BY_KEY = new Map<string, WasherProgramDef>();
const PROGRAM_BY_WIRE_NUM = new Map<number, WasherProgramDef>();
const PROGRAM_BY_DB_BYTE = new Map<number, WasherProgramDef>();
const PROGRAM_BY_DA_INDEX = new Map<number, WasherProgramDef>();

for (const def of WASHER_PROGRAMS) {
  PROGRAM_BY_KEY.set(def.key, def);
  if (typeof def.d9Wire === "number") {
    PROGRAM_BY_WIRE_NUM.set(def.d9Wire, def);
  }
  if (def.dbByte !== undefined && !PROGRAM_BY_DB_BYTE.has(def.dbByte)) {
    PROGRAM_BY_DB_BYTE.set(def.dbByte, def);
  }
  if (def.daIndex !== undefined && !PROGRAM_BY_DA_INDEX.has(def.daIndex)) {
    PROGRAM_BY_DA_INDEX.set(def.daIndex, def);
  }
}

const D9_38135636_BOTTOM_PROGRAMS: readonly string[] = [
  "mixed_wash",
  "smart_wash_dry",
  "cotton",
  "fast_wash",
  "fast_wash_30",
  "essence_wash",
  "intelligent",
  "big",
  "down_jacket",
  "green_wool",
  "shirt",
  "jacket",
  "kids",
  "cold_wash",
  "cook_wash",
  "steam_sterilize_wash",
  "remove_mite_wash",
  "steep",
  "air_wash",
  "single_drying",
  "rinsing_dehydration",
  "single_dehytration",
  "ssp",
  "deep_tub_self_clean",
  "detergent_box_clean",
  "softener_box_clean",
];

const D9_38135636_LEFT_PROGRAMS: readonly string[] = [
  "socks",
  "smart_wash_dry",
  "fast_wash",
  "fast_wash_30",
  "mixed_wash",
  "cook_wash",
  "remove_mite_wash",
  "air_wash",
  "single_drying",
  "rinsing_dehydration",
  "single_dehytration",
  "ssp",
];

const D9_38135636_RIGHT_PROGRAMS: readonly string[] = [
  "underpants",
  "bra",
  "blood_stain_wash",
  "smart_wash_dry",
  "fast_wash",
  "fast_wash_30",
  "mixed_wash",
  "cook_wash",
  "remove_mite_wash",
  "air_wash",
  "single_drying",
  "rinsing_dehydration",
  "single_dehytration",
  "ssp",
  "custom_detergent_box_clean",
];

const D9_DEFAULT_PROGRAMS: readonly string[] = [
  "standard",
  "mixed_wash",
  "smart_wash_dry",
  "fast_wash",
  "fast_wash_30",
  "cotton",
  "baby_clothes",
  "underwear",
  "underpants",
  "socks",
  "cook_wash",
  "cold_wash",
  "clean_stains",
  "single_drying",
  "rinsing_dehydration",
  "single_dehytration",
  "self_wash_5",
  "water_ssp",
];

const D9_DC_TOP_PROGRAMS: readonly string[] = [
  "mixed_wash",
  "cotton",
  "quick_dry",
  "intelligent_dry",
  "low_temp_dry",
  "eco_dry",
  "down_jacket",
  "wool",
  "bedsheet",
  "shirt",
  "baby_clothes",
  "fresh_air",
];

const DB_DEFAULT_PROGRAMS: readonly string[] = [
  "mixed_wash",
  "cotton",
  "fast_wash",
  "fast_wash_30",
  "quick_wash",
  "intelligent",
  "eco",
  "big",
  "down_jacket",
  "wool",
  "shirt",
  "jean",
  "fiber",
  "silk",
  "sport_clothes",
  "outdoor",
  "baby_clothes",
  "underwear",
  "color",
  "cold_wash",
  "cook_wash",
  "steam_sterilize_wash",
  "remove_mite_wash",
  "clean_stains",
  "steep",
  "air_wash",
  "single_drying",
  "wash_drying_60",
  "rinsing_dehydration",
  "single_dehytration",
  "ssp",
];

const DA_DEFAULT_PROGRAMS: readonly string[] = [
  "standard",
  "fast",
  "blanket",
  "wool",
  "embathe",
  "memory",
  "child",
  "strong_wash",
  "down_jacket",
  "stir",
  "mute",
  "bucket_self_clean",
  "air_dry",
];

export function formatWasherProgramLabel(programKey: string): string {
  const def = PROGRAM_BY_KEY.get(programKey);
  if (def) return def.zh;
  const num = Number(programKey);
  if (Number.isInteger(num) && PROGRAM_BY_WIRE_NUM.has(num)) {
    return PROGRAM_BY_WIRE_NUM.get(num)!.zh;
  }
  return programKey || "未知程序";
}

export function normalizeWasherProgram(raw: unknown, deviceType: number): string {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const intVal = Math.round(raw);
    const byWire = PROGRAM_BY_WIRE_NUM.get(intVal);
    if (byWire) return byWire.key;
    if ((deviceType & 0xff) === 0xda) {
      const byDa = PROGRAM_BY_DA_INDEX.get(intVal);
      if (byDa) return byDa.key;
    } else {
      const byDb = PROGRAM_BY_DB_BYTE.get(intVal);
      if (byDb) return byDb.key;
    }
    return String(intVal);
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return (deviceType & 0xff) === 0xda ? "standard" : "mixed_wash";
    if (PROGRAM_BY_KEY.has(trimmed)) return trimmed;
    const lower = trimmed.toLowerCase();
    if (PROGRAM_BY_KEY.has(lower)) return lower;
    if (/^\d+$/.test(trimmed)) {
      return normalizeWasherProgram(Number.parseInt(trimmed, 10), deviceType);
    }
    // 支持按中文名反向匹配
    for (const def of WASHER_PROGRAMS) {
      if (def.zh === trimmed) return def.key;
    }
    return trimmed;
  }
  return (deviceType & 0xff) === 0xda ? "standard" : "mixed_wash";
}

export function encodeWasherProgramForLua(
  programKey: string,
  deviceType: number,
  meta?: MideaWasherMeta,
): string | number {
  const normalized = normalizeWasherProgram(programKey, deviceType);
  const def = PROGRAM_BY_KEY.get(normalized);
  if ((deviceType & 0xff) === 0xd9) {
    // sn8 38135636 右筒内裤程序是 156、文胸是 144；其他型号保留各自映射
    if (meta?.sn8 === "38135636" || meta?.modelNumber === "13363") {
      if (normalized === "underwear") return 156;
    }
    if (def?.d9Wire !== undefined) {
      return def.d9Wire;
    }
    if (/^\d+$/.test(normalized)) {
      return Number.parseInt(normalized, 10);
    }
    return normalized;
  }
  return normalized;
}

export function getWasherProgramOptions(
  deviceType: number,
  drumKey?: MideaWasherDrumKey,
  meta?: MideaWasherMeta,
  currentProgram?: string,
): PropEnumOption[] {
  const code = deviceType & 0xff;
  let keys: readonly string[];

  if (code === 0xda) {
    keys = DA_DEFAULT_PROGRAMS;
  } else if (code === 0xd9) {
    const sn8 = (meta?.sn8 ?? "").trim();
    const modelNo = (meta?.modelNumber ?? "").trim();
    if (drumKey === "top") {
      keys = D9_DC_TOP_PROGRAMS;
    } else if (sn8 === "38135636" || modelNo === "13363") {
      if (drumKey === "left") keys = D9_38135636_LEFT_PROGRAMS;
      else if (drumKey === "right") keys = D9_38135636_RIGHT_PROGRAMS;
      else keys = D9_38135636_BOTTOM_PROGRAMS;
    } else {
      keys = D9_DEFAULT_PROGRAMS;
    }
  } else {
    keys = DB_DEFAULT_PROGRAMS;
  }

  const out: PropEnumOption[] = [];
  const seen = new Set<string>();
  const pushKey = (key: string): void => {
    if (!key || seen.has(key)) return;
    seen.add(key);
    const def = PROGRAM_BY_KEY.get(key);
    out.push({
      value: key,
      description: def?.en ?? key,
      desc_zh_cn: def?.zh ?? formatWasherProgramLabel(key),
    });
  };

  for (const k of keys) {
    pushKey(k);
  }
  if (currentProgram) {
    pushKey(currentProgram);
  }
  return out;
}

// ---------- 运行状态、阶段与参数编解码 ----------

export const WASHER_RUNNING_STATUS_OPTIONS: readonly PropEnumOption[] = [
  { value: "off", description: "Off", desc_zh_cn: "已关机" },
  { value: "idle", description: "Idle", desc_zh_cn: "空闲" },
  { value: "standby", description: "Standby", desc_zh_cn: "待机" },
  { value: "start", description: "Running", desc_zh_cn: "运行中" },
  { value: "pause", description: "Paused", desc_zh_cn: "已暂停" },
  { value: "end", description: "Finished", desc_zh_cn: "已完成" },
  { value: "delay", description: "Delayed", desc_zh_cn: "预约中" },
  { value: "fault", description: "Fault", desc_zh_cn: "故障" },
] as const;

export const WASHER_PROGRESS_OPTIONS: readonly PropEnumOption[] = [
  { value: "idle", description: "Idle", desc_zh_cn: "未运行" },
  { value: "weight", description: "Weighing", desc_zh_cn: "称重中" },
  { value: "pre_wash", description: "Pre-Wash", desc_zh_cn: "预洗中" },
  { value: "soak", description: "Soaking", desc_zh_cn: "浸泡中" },
  { value: "wash", description: "Washing", desc_zh_cn: "洗涤中" },
  { value: "rinse", description: "Rinsing", desc_zh_cn: "漂洗中" },
  { value: "spin", description: "Spinning", desc_zh_cn: "脱水中" },
  { value: "spin_high", description: "High-Speed Spin", desc_zh_cn: "高速脱水中" },
  { value: "dry", description: "Drying", desc_zh_cn: "烘干中" },
  { value: "anti_wrinkle", description: "Anti-Wrinkle", desc_zh_cn: "防皱中" },
  { value: "cold_air", description: "Cold Air", desc_zh_cn: "吹冷风中" },
  { value: "unknown", description: "Unknown", desc_zh_cn: "未知" },
] as const;

const RUNNING_STATUS_ZH: Readonly<Record<MideaWasherRunningStatus, string>> = {
  off: "已关机",
  idle: "空闲",
  standby: "待机",
  start: "运行中",
  pause: "已暂停",
  end: "已完成",
  delay: "预约中",
  fault: "故障",
};

const PROGRESS_STAGE_ZH: Readonly<Record<MideaWasherProgressStage, string>> = {
  idle: "未运行",
  weight: "称重中",
  pre_wash: "预洗中",
  soak: "浸泡中",
  wash: "洗涤中",
  rinse: "漂洗中",
  spin: "脱水中",
  spin_high: "高速脱水中",
  dry: "烘干中",
  anti_wrinkle: "防皱中",
  cold_air: "吹冷风中",
  unknown: "未知",
};

export function formatWasherRunningStatus(status: MideaWasherRunningStatus): string {
  return RUNNING_STATUS_ZH[status] ?? status;
}

export function formatWasherProgressStage(stage: MideaWasherProgressStage): string {
  return PROGRESS_STAGE_ZH[stage] ?? stage;
}

function parseBoolFlexible(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value !== 0;
  if (typeof value === "string") {
    const lower = value.trim().toLowerCase();
    if (lower === "on" || lower === "1" || lower === "true" || lower === "start") return true;
    if (lower === "off" || lower === "0" || lower === "false" || lower === "stop" || lower === "pause") {
      return false;
    }
  }
  return undefined;
}

function parseNumFlexible(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const n = trimmed.startsWith("0x") || trimmed.startsWith("0X")
      ? Number.parseInt(trimmed.slice(2), 16)
      : Number(trimmed);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

export function parseWasherRunningStatus(raw: unknown, power?: boolean): MideaWasherRunningStatus {
  if (typeof raw === "string") {
    const lower = raw.trim().toLowerCase();
    switch (lower) {
      case "off":
      case "power_off":
        return "off";
      case "idle":
        return "idle";
      case "standby":
        return "standby";
      case "start":
      case "running":
      case "run":
        return "start";
      case "pause":
      case "paused":
        return "pause";
      case "end":
      case "finish":
      case "finished":
      case "end_prevent_wrinkle":
        return "end";
      case "fault":
      case "error":
        return "fault";
      case "delay":
      case "delay_choosing":
      case "delay_pause":
        return "delay";
      default: {
        const asNum = parseNumFlexible(lower);
        if (asNum !== undefined) return parseWasherRunningStatus(asNum, power);
      }
    }
  } else if (typeof raw === "number" && Number.isFinite(raw)) {
    switch (Math.round(raw)) {
      case 0:
        return power === false ? "off" : "idle";
      case 1:
        return "standby";
      case 2:
        return "start";
      case 3:
        return "pause";
      case 4:
        return "end";
      case 5:
        return "fault";
      case 6:
        return "delay";
    }
  }
  return power === false ? "off" : "standby";
}

/**
 * 将美的洗衣机 progress 位码/枚举解析为规范阶段名称。
 * 注意：待机或关机时设备常上报 `32` 或 `1028` 等残留位码，非运行态统一归一为 `"idle"`。
 */
export function decodeWasherProgress(
  raw: unknown,
  runningStatus: MideaWasherRunningStatus,
  bucket: "da" | "db" | "dc",
): MideaWasherProgressStage {
  if (runningStatus !== "start") {
    return "idle";
  }
  if (typeof raw === "string") {
    const lower = raw.trim().toLowerCase();
    if (lower === "idle") return "idle";
    if (lower === "weighing" || lower === "weight") return "weight";
    if (lower === "pre_wash" || lower === "pre-wash") return "pre_wash";
    if (lower === "soak") return "soak";
    if (lower === "washing" || lower === "wash") return "wash";
    if (lower === "rinsing" || lower === "rinse") return "rinse";
    if (lower === "dehydrating" || lower === "spin") return "spin";
    if (lower === "high_speed_dehydrating" || lower === "spin_high") return "spin_high";
    if (lower === "drying" || lower === "dry") return "dry";
    if (lower === "anti-wrinkle" || lower === "anti_wrinkle") return "anti_wrinkle";
    if (lower === "cold_air") return "cold_air";
  }
  const num = parseNumFlexible(raw);
  if (num === undefined || num <= 0) {
    return "idle";
  }
  const intVal = Math.trunc(num);
  // 最低有效置位 bit 位置（1-based）：1=bit0, 2=bit1, 4=bit2, 8=bit3, 16=bit4, 32=bit5, 64=bit6
  let bitPos = 0;
  for (let i = 0; i < 16; i++) {
    if ((intVal & (1 << i)) !== 0) {
      bitPos = i + 1;
      break;
    }
  }
  if (bucket === "da") {
    const daMap: Record<number, MideaWasherProgressStage> = {
      0: "idle",
      1: "spin",
      2: "rinse",
      3: "wash",
      4: "weight",
      6: "dry",
      7: "soak",
    };
    return daMap[bitPos] ?? "unknown";
  }
  if (bucket === "dc") {
    const dcMap: Record<number, MideaWasherProgressStage> = {
      0: "idle",
      1: "dry",
      2: "anti_wrinkle",
      3: "cold_air",
    };
    return dcMap[bitPos] ?? "unknown";
  }
  const dbMap: Record<number, MideaWasherProgressStage> = {
    0: "idle",
    1: "spin",
    2: "rinse",
    3: "wash",
    4: "pre_wash",
    5: "dry",
    6: "weight",
    7: "spin_high",
  };
  return dbMap[bitPos] ?? "unknown";
}

// 温度档位映射：0xD9 / 0xDB 串口使用 1=冷水, 2=20°C, 3=30°C, 4=40°C, 5=60°C, 6=95°C, 7=70°C
const D9_TEMP_CODE_TO_C: Readonly<Record<number, number>> = {
  0: 0,
  1: 0,
  2: 20,
  3: 30,
  4: 40,
  5: 60,
  6: 95,
  7: 70,
};

function decodeTemperatureCelsius(raw: unknown, isIndexEncoded: boolean): number | undefined {
  if (typeof raw === "string") {
    const lower = raw.trim().toLowerCase();
    if (lower === "cold" || lower === "cold_water") return 0;
    const stripped = lower.replace(/°?c$/, "");
    const n = parseNumFlexible(stripped);
    if (n !== undefined) {
      return isIndexEncoded && n >= 0 && n <= 7 ? (D9_TEMP_CODE_TO_C[Math.round(n)] ?? 0) : Math.round(n);
    }
    return undefined;
  }
  const n = parseNumFlexible(raw);
  if (n === undefined) return undefined;
  const r = Math.round(n);
  if (isIndexEncoded && r >= 0 && r <= 7) {
    return D9_TEMP_CODE_TO_C[r] ?? 0;
  }
  return clamp(r, 0, 100);
}

function encodeTemperatureToIndex(celsius: number, zeroCode = 1): number {
  if (celsius <= 0) return zeroCode;
  if (celsius <= 20) return 2;
  if (celsius <= 30) return 3;
  if (celsius <= 40) return 4;
  if (celsius <= 60) return 5;
  if (celsius <= 75) return 7;
  return 6;
}

// 脱水转速档位映射：0xD9 / 0xDB 串口使用 0=0, 1=400, 2=600, 3=800, 4=1000, 5=1200, 6=1400, 7=1600, 8=1300
const SPIN_INDEX_TO_RPM: Readonly<Record<number, number>> = {
  0: 0,
  1: 400,
  2: 600,
  3: 800,
  4: 1000,
  5: 1200,
  6: 1400,
  7: 1600,
  8: 1300,
};

function decodeSpinRpm(raw: unknown, isIndexEncoded: boolean): number | undefined {
  if (typeof raw === "string") {
    const lower = raw.trim().toLowerCase();
    if (lower === "no_spin" || lower === "none" || lower === "off") return 0;
    const stripped = lower.replace(/rpm$/, "");
    const n = parseNumFlexible(stripped);
    if (n !== undefined) {
      return isIndexEncoded && n >= 0 && n <= 8 ? (SPIN_INDEX_TO_RPM[Math.round(n)] ?? 0) : Math.round(n);
    }
    return undefined;
  }
  const n = parseNumFlexible(raw);
  if (n === undefined) return undefined;
  const r = Math.round(n);
  if (isIndexEncoded && r >= 0 && r <= 8) {
    return SPIN_INDEX_TO_RPM[r] ?? 0;
  }
  return clamp(r, 0, 1600);
}

function encodeSpinRpmToIndex(rpm: number): number {
  if (rpm <= 0) return 0;
  if (rpm <= 400) return 1;
  if (rpm <= 600) return 2;
  if (rpm <= 800) return 3;
  if (rpm <= 1000) return 4;
  if (rpm <= 1200) return 5;
  if (rpm <= 1300) return 8;
  if (rpm <= 1400) return 6;
  return 7;
}

function decodeWaterLevel(raw: unknown): number | undefined {
  if (typeof raw === "string") {
    switch (raw.trim().toLowerCase()) {
      case "low":
      case "l1":
      case "1":
        return 1;
      case "mid":
      case "medium":
      case "l2":
      case "2":
        return 2;
      case "high":
      case "l3":
      case "3":
        return 3;
      case "l4":
      case "4":
        return 4;
      case "auto":
      case "5":
      case "default":
        return 5;
      default: {
        const n = parseNumFlexible(raw);
        return n !== undefined ? clamp(Math.round(n), 0, 8) : undefined;
      }
    }
  }
  const n = parseNumFlexible(raw);
  if (n === undefined) return undefined;
  if (n === 0xff) return 5;
  return clamp(Math.round(n), 0, 8);
}

function encodeDbWaterLevelForLua(level: number, rawSample?: unknown): string | number {
  if (typeof rawSample === "number") {
    return level;
  }
  switch (level) {
    case 1:
      return "low";
    case 2:
      return "mid";
    case 3:
      return "high";
    case 4:
      return "4";
    default:
      return "auto";
  }
}

// ---------- 默认状态工厂 ----------

function defaultDrumState(spec: MideaWasherDrumSpec, deviceType: MideaWasherTypeCode): MideaWasherDrumState {
  const defaultProgram =
    spec.bucket === "da"
      ? "standard"
      : spec.bucket === "dc"
        ? "mixed_wash"
        : spec.key === "left" && spec.location === 3
          ? "socks"
          : spec.key === "right" && spec.location === 4
            ? "underpants"
            : "mixed_wash";

  return {
    key: spec.key,
    label: spec.label,
    shortLabel: spec.shortLabel,
    bucket: spec.bucket,
    location: spec.location,
    isPanelSelected: false,
    power: false,
    running: false,
    runningStatus: "off",
    progress: "idle",
    program: defaultProgram,
    mode: "normal",
    remainTime: 0,
    washTime: 0,
    soakTime: 0,
    dehydrationTime: 0,
    temperature: deviceType === 0xda ? 0 : 40,
    dehydrationSpeed: 800,
    rinseCount: 2,
    waterLevel: 5,
    washLevel: 5,
    rinseLevel: 5,
    washStrength: 2,
    dryMode: 0,
    detergent: 0,
    softener: 0,
    childLock: false,
    nightlyWash: false,
    steamWash: false,
    fastCleanWash: false,
    beforehandWash: false,
    superCleanWash: false,
    cycleMemory: true,
    stains: 0,
    freshAirTime: 0,
    appointmentTime: 0,
    voiceDnd: false,
    doorOpened: false,
    detergentLack: false,
    softenerLack: false,
    waterOverheating: false,
    dryingTunnelOverheating: false,
    remoteControlEnabled: null,
    errorCode: "0",
  };
}

export function syncActiveDrumToTopLevel(state: MideaWasherState): MideaWasherState {
  const drum = state.drums[state.activeDrum];
  if (!drum) return state;
  const anyDrumPower = Object.values(state.drums).some((d) => Boolean(d?.power));
  return {
    ...state,
    activeDrumLocation: drum.location,
    power: state.drumLayout === "single" ? drum.power : anyDrumPower || drum.power,
    running: drum.running,
    runningStatus: drum.runningStatus,
    progress: drum.progress,
    program: drum.program,
    mode: drum.mode,
    remainTime: drum.remainTime,
    washTime: drum.washTime,
    soakTime: drum.soakTime,
    dehydrationTime: drum.dehydrationTime,
    temperature: drum.temperature,
    dehydrationSpeed: drum.dehydrationSpeed,
    rinseCount: drum.rinseCount,
    waterLevel: drum.waterLevel,
    washLevel: drum.washLevel,
    rinseLevel: drum.rinseLevel,
    washStrength: drum.washStrength,
    dryMode: drum.dryMode,
    detergent: drum.detergent,
    softener: drum.softener,
    childLock: drum.childLock,
    nightlyWash: drum.nightlyWash,
    steamWash: drum.steamWash,
    fastCleanWash: drum.fastCleanWash,
    beforehandWash: drum.beforehandWash,
    superCleanWash: drum.superCleanWash,
    cycleMemory: drum.cycleMemory,
    stains: drum.stains,
    freshAirTime: drum.freshAirTime,
    appointmentTime: drum.appointmentTime,
    voiceDnd: drum.voiceDnd,
    doorOpened: drum.doorOpened,
    detergentLack: drum.detergentLack,
    softenerLack: drum.softenerLack,
    waterOverheating: drum.waterOverheating,
    dryingTunnelOverheating: drum.dryingTunnelOverheating,
    remoteControlEnabled: drum.remoteControlEnabled,
    errorCode: drum.errorCode,
    ...(drum.washTimeValue !== undefined ? { washTimeValue: drum.washTimeValue } : {}),
    ...(drum.dehydrationTimeValue !== undefined
      ? { dehydrationTimeValue: drum.dehydrationTimeValue }
      : {}),
  };
}

export function defaultWasherState(
  deviceType: MideaWasherTypeCode = 0xdb,
  meta?: MideaWasherMeta,
): MideaWasherState {
  const profile = resolveMideaWasherProfile(deviceType, meta);
  const drums: Partial<Record<MideaWasherDrumKey, MideaWasherDrumState>> = {};
  for (const spec of profile.drums) {
    const ds = defaultDrumState(spec, profile.deviceType);
    if (spec.key === profile.defaultDrum) {
      ds.isPanelSelected = true;
    }
    drums[spec.key] = ds;
  }
  const activeSpec =
    profile.drums.find((d) => d.key === profile.defaultDrum) ?? profile.drums[0]!;
  const base: MideaWasherState = {
    kind: "washer",
    deviceType: profile.deviceType,
    ...(meta?.sn8 ? { sn8: meta.sn8 } : {}),
    ...(meta?.modelNumber ? { modelNumber: meta.modelNumber } : {}),
    drumLayout: profile.layout,
    activeDrum: activeSpec.key,
    activeDrumLocation: activeSpec.location,
    power: false,
    running: false,
    runningStatus: "off",
    progress: "idle",
    program: drums[activeSpec.key]!.program,
    mode: "normal",
    remainTime: 0,
    washTime: 0,
    soakTime: 0,
    dehydrationTime: 0,
    temperature: profile.deviceType === 0xda ? 0 : 40,
    dehydrationSpeed: 800,
    rinseCount: 2,
    waterLevel: 5,
    washLevel: 5,
    rinseLevel: 5,
    washStrength: 2,
    dryMode: 0,
    detergent: 0,
    softener: 0,
    childLock: false,
    nightlyWash: false,
    steamWash: false,
    fastCleanWash: false,
    beforehandWash: false,
    superCleanWash: false,
    cycleMemory: true,
    stains: 0,
    freshAirTime: 0,
    appointmentTime: 0,
    voiceDnd: false,
    doorOpened: false,
    detergentLack: false,
    softenerLack: false,
    waterOverheating: false,
    dryingTunnelOverheating: false,
    remoteControlEnabled: null,
    errorCode: "0",
    drums,
  };
  return syncActiveDrumToTopLevel(base);
}

// ---------- Lua JSON 状态解析 ----------

export interface ParseWasherLuaContext {
  meta?: MideaWasherMeta;
  drumKey?: MideaWasherDrumKey;
  bucket?: "da" | "db" | "dc";
  location?: number;
}

function matchDrumForD9Status(
  profile: MideaWasherProfile,
  raw: Record<string, unknown>,
  context?: ParseWasherLuaContext,
): MideaWasherDrumSpec {
  if (context?.drumKey) {
    const explicit = profile.drums.find((d) => d.key === context.drumKey);
    if (explicit) return explicit;
  }
  const bucketRaw = typeof raw["bucket"] === "string" ? raw["bucket"].trim().toLowerCase() : context?.bucket;
  if (bucketRaw === "dc" || "dc_running_status" in raw || "dc_power" in raw) {
    const dcDrum = profile.drums.find((d) => d.bucket === "dc");
    if (dcDrum) return dcDrum;
  }
  const locNum = parseNumFlexible(raw["db_location"] ?? context?.location);
  if (locNum !== undefined) {
    const byLoc = profile.drums.find((d) => d.bucket === "db" && d.location === Math.round(locNum));
    if (byLoc) return byLoc;
  }
  return profile.drums.find((d) => d.key === profile.defaultDrum) ?? profile.drums[0]!;
}

export function parseWasherLuaStatus(
  deviceType: number,
  raw: Record<string, unknown>,
  existing?: MideaWasherState | null,
  context?: ParseWasherLuaContext,
): MideaWasherState | null {
  if (Object.keys(raw).length === 0) return null;
  const code = (deviceType & 0xff) as MideaWasherTypeCode;
  const meta: MideaWasherMeta = {
    sn8: context?.meta?.sn8 ?? existing?.sn8,
    modelNumber: context?.meta?.modelNumber ?? existing?.modelNumber,
  };
  const profile = resolveMideaWasherProfile(code, meta);
  const base: MideaWasherState =
    existing && existing.deviceType === code
      ? {
          ...existing,
          ...(meta.sn8 ? { sn8: meta.sn8 } : {}),
          ...(meta.modelNumber ? { modelNumber: meta.modelNumber } : {}),
          drums: { ...existing.drums },
        }
      : defaultWasherState(code, meta);

  // 确保全部声明的筒都在 state.drums 中存在
  for (const spec of profile.drums) {
    if (!base.drums[spec.key]) {
      base.drums[spec.key] = defaultDrumState(spec, code);
    }
  }

  const targetSpec =
    code === 0xd9 ? matchDrumForD9Status(profile, raw, context) : profile.drums[0]!;
  const prevDrum = base.drums[targetSpec.key] ?? defaultDrumState(targetSpec, code);
  const prefix = code === 0xd9 ? `${targetSpec.bucket}_` : "";

  const getField = (...names: string[]): unknown => {
    for (const n of names) {
      if (prefix && `${prefix}${n}` in raw) return raw[`${prefix}${n}`];
      if (n in raw) return raw[n];
    }
    return undefined;
  };

  const powerRaw = getField("power");
  const runningRaw = getField("running_status");
  const controlRaw = getField("control_status");
  const programRaw = getField("program");
  const remainRaw = getField("remain_time");

  // 确认至少存在一个有效洗衣机状态字段
  if (
    powerRaw === undefined &&
    runningRaw === undefined &&
    programRaw === undefined &&
    remainRaw === undefined
  ) {
    return null;
  }

  const power = parseBoolFlexible(powerRaw) ?? prevDrum.power;
  let runningStatus =
    runningRaw !== undefined
      ? parseWasherRunningStatus(runningRaw, power)
      : controlRaw !== undefined
        ? parseBoolFlexible(controlRaw)
          ? "start"
          : power
            ? "pause"
            : "off"
        : power
          ? prevDrum.runningStatus === "off"
            ? "standby"
            : prevDrum.runningStatus
          : "off";
  if (!power && runningStatus !== "off" && runningStatus !== "fault") {
    runningStatus = "off";
  }
  const running = runningStatus === "start";

  const progressRaw = getField("progress", "dry_status");
  const progress =
    progressRaw !== undefined
      ? decodeWasherProgress(progressRaw, runningStatus, targetSpec.bucket)
      : running
        ? prevDrum.progress
        : "idle";

  const program =
    programRaw !== undefined ? normalizeWasherProgram(programRaw, code) : prevDrum.program;
  const modeRaw = getField("mode");
  const mode = typeof modeRaw === "string" && modeRaw.trim() ? modeRaw.trim() : prevDrum.mode;

  const remainNum = parseNumFlexible(remainRaw);
  const remainTime = remainNum !== undefined ? Math.max(0, Math.round(remainNum)) : prevDrum.remainTime;

  const isD9IndexEncoded = code === 0xd9 && targetSpec.bucket === "db";
  const tempVal = decodeTemperatureCelsius(getField("temperature"), isD9IndexEncoded);
  const spinVal = decodeSpinRpm(getField("dehydration_speed"), isD9IndexEncoded);
  const rinseVal = parseNumFlexible(getField("rinse_count", "soak_count"));
  const waterVal = decodeWaterLevel(getField("water_level"));
  const washLevelVal = parseNumFlexible(getField("wash_level"));
  const rinseLevelVal = parseNumFlexible(getField("rinse_level"));
  const washStrengthVal = parseNumFlexible(getField("wash_strength"));
  const dryVal = parseNumFlexible(getField("dry", "dryer"));
  const detergentVal = parseNumFlexible(getField("detergent"));
  const softenerVal = parseNumFlexible(getField("softener"));
  const washTimeVal = parseNumFlexible(getField("set_wash_time", "wash_time"));
  const soakTimeVal = parseNumFlexible(getField("soak_time"));
  const dewaterTimeVal = parseNumFlexible(getField("set_dewater_time", "dehydration_time"));
  const washTimeValueRaw = parseNumFlexible(getField("wash_time_value"));
  const dewaterTimeValueRaw = parseNumFlexible(getField("dehydration_time_value"));
  const stainsVal = parseNumFlexible(getField("stains", "stains_wash"));
  const freshAirVal = parseNumFlexible(getField("fresh_air_time"));
  const appointmentVal = parseNumFlexible(getField("appointment_time"));

  const childLock = parseBoolFlexible(getField("baby_lock", "lock")) ?? prevDrum.childLock;
  const nightlyWash = parseBoolFlexible(getField("nightly_wash", "nightly")) ?? prevDrum.nightlyWash;
  const steamWash = parseBoolFlexible(getField("steam_wash", "sterilize")) ?? prevDrum.steamWash;
  const fastCleanWash =
    parseBoolFlexible(getField("fast_clean_wash", "speedy")) ?? prevDrum.fastCleanWash;
  const beforehandWash =
    parseBoolFlexible(getField("beforehand_wash")) ?? prevDrum.beforehandWash;
  const superCleanWash =
    parseBoolFlexible(getField("super_clean_wash")) ?? prevDrum.superCleanWash;
  const cycleMemory = parseBoolFlexible(getField("cycle_memory")) ?? prevDrum.cycleMemory;
  const voiceDnd =
    parseBoolFlexible(getField("voice_not_disturb_switch")) ?? prevDrum.voiceDnd;

  const doorOpened = parseBoolFlexible(getField("door_opened", "door_status")) ?? prevDrum.doorOpened;
  const detergentLack =
    parseBoolFlexible(getField("detergent_needed", "detergent_lack")) ?? prevDrum.detergentLack;
  const softenerLack =
    parseBoolFlexible(getField("softener_needed", "softener_lack")) ?? prevDrum.softenerLack;
  const waterOverheating =
    parseBoolFlexible(getField("bucket_water_overheating")) ?? prevDrum.waterOverheating;
  const dryingTunnelOverheating =
    parseBoolFlexible(getField("drying_tunnel_overheating")) ?? prevDrum.dryingTunnelOverheating;
  const remoteRaw = getField("remote_control_flag");
  const remoteControlEnabled =
    remoteRaw !== undefined ? parseBoolFlexible(remoteRaw) ?? prevDrum.remoteControlEnabled : prevDrum.remoteControlEnabled;

  const errRaw = getField("error_code");
  const errorCode =
    errRaw !== undefined && errRaw !== null ? String(errRaw).trim() || "0" : prevDrum.errorCode;

  const positionNum = parseNumFlexible(raw["db_position"]);
  const isPanelSelected =
    code === 0xd9 && targetSpec.bucket === "db" && positionNum !== undefined
      ? positionNum === 1
      : prevDrum.isPanelSelected;

  const nextDrum: MideaWasherDrumState = {
    ...prevDrum,
    key: targetSpec.key,
    label: targetSpec.label,
    shortLabel: targetSpec.shortLabel,
    bucket: targetSpec.bucket,
    location: targetSpec.location,
    isPanelSelected,
    power,
    running,
    runningStatus,
    progress,
    program,
    mode,
    remainTime,
    washTime: washTimeVal !== undefined ? clamp(Math.round(washTimeVal), 0, 90) : prevDrum.washTime,
    soakTime: soakTimeVal !== undefined ? clamp(Math.round(soakTimeVal), 0, 60) : prevDrum.soakTime,
    dehydrationTime:
      dewaterTimeVal !== undefined ? clamp(Math.round(dewaterTimeVal), 0, 30) : prevDrum.dehydrationTime,
    temperature: tempVal !== undefined ? tempVal : prevDrum.temperature,
    dehydrationSpeed: spinVal !== undefined ? spinVal : prevDrum.dehydrationSpeed,
    rinseCount: rinseVal !== undefined ? clamp(Math.round(rinseVal), 0, 5) : prevDrum.rinseCount,
    waterLevel: waterVal !== undefined ? waterVal : prevDrum.waterLevel,
    washLevel: washLevelVal !== undefined ? clamp(Math.round(washLevelVal), 0, 8) : prevDrum.washLevel,
    rinseLevel:
      rinseLevelVal !== undefined ? clamp(Math.round(rinseLevelVal), 0, 8) : prevDrum.rinseLevel,
    washStrength:
      washStrengthVal !== undefined ? clamp(Math.round(washStrengthVal), 1, 4) : prevDrum.washStrength,
    dryMode: dryVal !== undefined ? clamp(Math.round(dryVal), 0, 15) : prevDrum.dryMode,
    detergent: detergentVal !== undefined ? clamp(Math.round(detergentVal), 0, 5) : prevDrum.detergent,
    softener: softenerVal !== undefined ? clamp(Math.round(softenerVal), 0, 5) : prevDrum.softener,
    childLock,
    nightlyWash,
    steamWash,
    fastCleanWash,
    beforehandWash,
    superCleanWash,
    cycleMemory,
    stains: stainsVal !== undefined ? Math.round(stainsVal) : prevDrum.stains,
    freshAirTime:
      freshAirVal !== undefined ? clamp(Math.round(freshAirVal), 0, 24) : prevDrum.freshAirTime,
    appointmentTime:
      appointmentVal !== undefined ? clamp(Math.round(appointmentVal), 0, 1440) : prevDrum.appointmentTime,
    voiceDnd,
    doorOpened,
    detergentLack,
    softenerLack,
    waterOverheating,
    dryingTunnelOverheating,
    remoteControlEnabled,
    errorCode,
    ...(washTimeValueRaw !== undefined
      ? { washTimeValue: Math.round(washTimeValueRaw) }
      : prevDrum.washTimeValue !== undefined
        ? { washTimeValue: prevDrum.washTimeValue }
        : {}),
    ...(dewaterTimeValueRaw !== undefined
      ? { dehydrationTimeValue: Math.round(dewaterTimeValueRaw) }
      : prevDrum.dehydrationTimeValue !== undefined
        ? { dehydrationTimeValue: prevDrum.dehydrationTimeValue }
        : {}),
  };

  base.drums[targetSpec.key] = nextDrum;

  // 若是首次加载且用户未手动切换筒，自动跟随面板选中的筒 (db_position === 1)
  if (code === 0xd9 && isPanelSelected && !base.userSelectedDrum) {
    base.activeDrum = targetSpec.key;
    base.activeDrumLocation = targetSpec.location;
  }

  return syncActiveDrumToTopLevel(base);
}

// ---------- Lua JSON 控制指令构造 ----------

function formatBoolForLua(value: boolean, sample: unknown, numericDefault = false): string | number {
  if (typeof sample === "number") return value ? 1 : 0;
  if (typeof sample === "string") {
    const trimmed = sample.trim().toLowerCase();
    if (trimmed === "0" || trimmed === "1") return value ? "1" : "0";
    return value ? "on" : "off";
  }
  return numericDefault ? (value ? 1 : 0) : value ? "on" : "off";
}

function formatNumForLua(value: number, sample: unknown, preferString = false): string | number {
  if (typeof sample === "string") return String(value);
  if (typeof sample === "number") return value;
  return preferString ? String(value) : value;
}

export function resolveWasherTargetDrum(
  state: MideaWasherState,
  propName?: string,
): { drumKey: MideaWasherDrumKey; baseProp: string; spec: MideaWasherDrumSpec } {
  const profile = resolveMideaWasherProfile(state.deviceType, {
    sn8: state.sn8,
    modelNumber: state.modelNumber,
  });
  const norm = (propName ?? "on").trim().toLowerCase().replaceAll("_", "-");
  const drumMatch = /^drum-(bottom|left|right|top|main)-(.+)$/.exec(norm);
  if (drumMatch) {
    const key = drumMatch[1] as MideaWasherDrumKey;
    const spec =
      profile.drums.find((d) => d.key === key) ??
      profile.drums.find((d) => d.key === state.activeDrum) ??
      profile.drums[0]!;
    return { drumKey: spec.key, baseProp: drumMatch[2]!, spec };
  }
  const spec =
    profile.drums.find((d) => d.key === state.activeDrum) ??
    profile.drums.find((d) => d.key === profile.defaultDrum) ??
    profile.drums[0]!;
  return { drumKey: spec.key, baseProp: norm, spec };
}

export function buildWasherLuaControlPayload(
  nextState: MideaWasherState,
  propName?: string,
  rawLuaStatus?: Record<string, unknown> | null,
): Record<string, unknown> | null {
  const { drumKey, baseProp, spec } = resolveWasherTargetDrum(nextState, propName);
  const drum = nextState.drums[drumKey] ?? nextState;
  const code = nextState.deviceType;
  const raw = rawLuaStatus ?? {};
  const meta: MideaWasherMeta = {
    sn8: nextState.sn8,
    modelNumber: nextState.modelNumber,
  };

  if (code === 0xd9) {
    const bucket = spec.bucket;
    const prefix = `${bucket}_`;
    const wrap = (fields: Record<string, unknown>): Record<string, unknown> => {
      if (bucket === "dc") {
        return { bucket: "dc", dc_location: spec.location, ...fields };
      }
      if (bucket === "da") {
        return { bucket: "da", da_location: spec.location, ...fields };
      }
      return { bucket: "db", db_location: spec.location, ...fields };
    };

    switch (baseProp) {
      case "on":
      case "power":
        return wrap({ [`${prefix}power`]: drum.power ? "on" : "off" });
      case "drum-location":
      case "location":
        return wrap({});
      case "control-status":
      case "start":
        return wrap({
          [`${prefix}control_status`]: drum.running ? "start" : "pause",
          ...(drum.running && !drum.power ? { [`${prefix}power`]: "on" } : {}),
        });
      case "program":
        return wrap({
          [`${prefix}program`]: encodeWasherProgramForLua(drum.program, code, meta),
        });
      case "temperature": {
        const zeroCode = raw["db_temperature"] === 0 ? 0 : 1;
        return wrap({
          [`${prefix}temperature`]: encodeTemperatureToIndex(drum.temperature, zeroCode),
        });
      }
      case "dehydration-speed":
        return wrap({
          [`${prefix}dehydration_speed`]: encodeSpinRpmToIndex(drum.dehydrationSpeed),
        });
      case "rinse-count":
        return wrap({ [`${prefix}rinse_count`]: clamp(Math.round(drum.rinseCount), 1, 5) });
      case "water-level":
        return wrap({ [`${prefix}water_level`]: clamp(Math.round(drum.waterLevel), 1, 5) });
      case "dry-mode":
      case "dry":
        return wrap({
          [`${prefix}dry`]: formatNumForLua(drum.dryMode, raw[`${prefix}dry`], false),
        });
      case "detergent":
        return wrap({ [`${prefix}detergent`]: clamp(Math.round(drum.detergent), 0, 4) });
      case "softener":
        return wrap({
          [`${prefix}softener`]: formatNumForLua(
            clamp(Math.round(drum.softener), 0, 4),
            raw[`${prefix}softener`],
            false,
          ),
        });
      case "child-lock":
      case "baby-lock":
        return wrap({ [`${prefix}baby_lock`]: drum.childLock ? 1 : 0 });
      case "nightly-wash":
        return wrap({ [`${prefix}nightly_wash`]: drum.nightlyWash ? 1 : 0 });
      case "steam-wash":
        return wrap({
          [bucket === "dc" ? "dc_sterilize" : `${prefix}steam_wash`]: drum.steamWash ? 1 : 0,
        });
      case "fast-clean-wash":
        return wrap({ [`${prefix}fast_clean_wash`]: drum.fastCleanWash ? 1 : 0 });
      case "cycle-memory":
        return wrap({ [`${prefix}cycle_memory`]: drum.cycleMemory ? 1 : 0 });
      case "fresh-air-time":
        return wrap({ [`${prefix}fresh_air_time`]: clamp(Math.round(drum.freshAirTime), 0, 8) });
      case "wash-time":
        return wrap({ [`${prefix}wash_time`]: clamp(Math.round(drum.washTime), 0, 90) });
      case "dehydration-time":
        return wrap({
          [`${prefix}dehydration_time`]: clamp(Math.round(drum.dehydrationTime), 0, 15),
        });
      case "voice-dnd":
        return wrap({ [`${prefix}voice_not_disturb_switch`]: drum.voiceDnd ? 1 : 0 });
      case "appointment-time": {
        const mins = clamp(Math.round(drum.appointmentTime), 0, 1440);
        if (mins <= 0) {
          return wrap({
            [`${prefix}control_status`]: "pause",
            [`${prefix}appointment`]: 0,
            [`${prefix}appointment_time`]: 0,
          });
        }
        return wrap({
          [`${prefix}control_status`]: "start",
          [`${prefix}appointment`]: 1,
          [`${prefix}appointment_time`]: mins,
        });
      }
      default:
        return null;
    }
  }

  if (code === 0xda) {
    switch (baseProp) {
      case "on":
      case "power":
        return { power: drum.power ? "on" : "off" };
      case "control-status":
      case "start":
        return { control_status: drum.running ? "start" : "pause" };
      case "program":
        return { program: encodeWasherProgramForLua(drum.program, code, meta) };
      case "mode":
        return { mode: drum.mode || "normal" };
      case "temperature":
        return { temperature: formatNumForLua(drum.temperature, raw["temperature"]) };
      case "wash-level":
        return { wash_level: clamp(Math.round(drum.washLevel), 0, 8) };
      case "rinse-level":
        return { rinse_level: clamp(Math.round(drum.rinseLevel), 0, 8) };
      case "wash-strength":
        return { wash_strength: clamp(Math.round(drum.washStrength), 1, 4) };
      case "wash-time":
        return { wash_time: clamp(Math.round(drum.washTime), 0, 20) };
      case "soak-time":
        return { soak_time: clamp(Math.round(drum.soakTime), 0, 40) };
      case "rinse-count":
        return { rinse_count: clamp(Math.round(drum.rinseCount), 0, 5) };
      case "dehydration-time":
        return { dehydration_time: clamp(Math.round(drum.dehydrationTime), 0, 9) };
      case "dehydration-speed":
        return {
          dehydration_speed: formatNumForLua(drum.dehydrationSpeed, raw["dehydration_speed"]),
        };
      case "detergent":
        return { detergent: clamp(Math.round(drum.detergent), 0, 5) };
      case "softener":
        return { softener: clamp(Math.round(drum.softener), 0, 5) };
      case "child-lock":
      case "lock":
        return { lock: formatBoolForLua(drum.childLock, raw["lock"]) };
      case "appointment-time": {
        const mins = clamp(Math.round(drum.appointmentTime), 0, 1440);
        return mins <= 0
          ? { control_status: "pause", appointment: "off", appointment_time: 0 }
          : { control_status: "start", appointment: "on", appointment_time: mins };
      }
      default:
        return null;
    }
  }

  // 0xDB 滚筒洗衣机
  switch (baseProp) {
    case "on":
    case "power":
      return { power: drum.power ? "on" : "off" };
    case "control-status":
    case "start":
      return { control_status: drum.running ? "start" : "pause" };
    case "program":
      return { program: encodeWasherProgramForLua(drum.program, code, meta) };
    case "mode":
      return { mode: drum.mode || "normal" };
    case "temperature":
      return { temperature: formatNumForLua(drum.temperature, raw["temperature"], true) };
    case "dehydration-speed":
      return {
        dehydration_speed: formatNumForLua(drum.dehydrationSpeed, raw["dehydration_speed"], true),
      };
    case "rinse-count": {
      const key = "rinse_count" in raw && !("soak_count" in raw) ? "rinse_count" : "soak_count";
      return { [key]: formatNumForLua(clamp(Math.round(drum.rinseCount), 1, 5), raw[key], true) };
    }
    case "water-level":
      return { water_level: encodeDbWaterLevelForLua(drum.waterLevel, raw["water_level"]) };
    case "dry-mode":
    case "dry":
      return { dryer: formatNumForLua(drum.dryMode, raw["dryer"], true) };
    case "detergent":
      return {
        detergent: formatNumForLua(clamp(Math.round(drum.detergent), 0, 5), raw["detergent"], true),
      };
    case "softener":
      return {
        softener: formatNumForLua(clamp(Math.round(drum.softener), 0, 5), raw["softener"], true),
      };
    case "child-lock":
    case "lock":
      return { lock: formatBoolForLua(drum.childLock, raw["lock"]) };
    case "nightly-wash":
      return { nightly: formatBoolForLua(drum.nightlyWash, raw["nightly"]) };
    case "steam-wash":
      return { steam_wash: formatBoolForLua(drum.steamWash, raw["steam_wash"]) };
    case "fast-clean-wash":
      return {
        speedy: formatBoolForLua(drum.fastCleanWash, raw["speedy"]),
        fast_clean_wash: formatBoolForLua(drum.fastCleanWash, raw["fast_clean_wash"]),
      };
    case "beforehand-wash":
      return { beforehand_wash: formatBoolForLua(drum.beforehandWash, raw["beforehand_wash"]) };
    case "super-clean-wash":
      return { super_clean_wash: formatBoolForLua(drum.superCleanWash, raw["super_clean_wash"]) };
    case "cycle-memory":
      return { cycle_memory: formatBoolForLua(drum.cycleMemory, raw["cycle_memory"]) };
    case "stains":
      return { stains: formatNumForLua(drum.stains, raw["stains"], true) };
    case "fresh-air-time":
      return { fresh_air_time: clamp(Math.round(drum.freshAirTime), 0, 8) };
    case "wash-time":
      return { wash_time: clamp(Math.round(drum.washTime), 0, 60) };
    case "dehydration-time":
      return { dehydration_time: clamp(Math.round(drum.dehydrationTime), 0, 15) };
    case "appointment-time": {
      const mins = clamp(Math.round(drum.appointmentTime), 0, 1440);
      if (mins <= 0) {
        return {
          control_status: "pause",
          appointment: "off",
          appointment_time: formatNumForLua(0, raw["appointment_time"], true),
        };
      }
      return {
        appointment: "on",
        appointment_time: formatNumForLua(mins, raw["appointment_time"], true),
      };
    }
    default:
      return null;
  }
}

// ---------- 0xAA 串口二进制协议（0xDB 滚筒 / 0xDA 波轮，对齐 midea-local） ----------

const DB_MODE_TO_BYTE: Readonly<Record<string, number>> = {
  normal: 0,
  factory_test: 1,
  service: 2,
  normal_continus: 3,
};

const DB_BYTE_TO_MODE: Readonly<Record<number, string>> = {
  0: "normal",
  1: "factory_test",
  2: "service",
  3: "normal_continus",
};

export function buildWasherQuery(deviceType: MideaWasherTypeCode = 0xdb): Buffer {
  const body = new Uint8Array([0x03]);
  return buildMideaFrame(deviceType, 0x03, body, { protocolVersion: 0x00, includeCrc8: false });
}

export function buildWasherSet(
  state: MideaWasherState,
  propName?: string,
): Buffer {
  const norm = (propName ?? "on").trim().toLowerCase().replaceAll("_", "-");
  const isPowerOnly = norm === "on" || norm === "power";

  if (state.deviceType === 0xda) {
    if (isPowerOnly) {
      const body = new Uint8Array([0x02, state.power ? 0x01 : 0x00, 0xff]);
      return buildMideaFrame(0xda, 0x02, body, { protocolVersion: 0x00, includeCrc8: false });
    }
    if (!state.running && (norm === "control-status" || norm === "start")) {
      const body = new Uint8Array([0x02, 0xff, 0x00]);
      return buildMideaFrame(0xda, 0x02, body, { protocolVersion: 0x00, includeCrc8: false });
    }
    const washingData = new Uint8Array(12).fill(0xff);
    const progDef = PROGRAM_BY_KEY.get(state.program);
    if (progDef?.daIndex !== undefined) {
      washingData[1] = progDef.daIndex;
    }
    washingData[2] = ((state.rinseLevel & 0x0f) << 4) | (state.washLevel & 0x0f);
    const daSpeedIdx =
      state.dehydrationSpeed <= 0
        ? 0
        : state.dehydrationSpeed <= 400
          ? 1
          : state.dehydrationSpeed <= 800
            ? 2
            : 3;
    washingData[3] = ((daSpeedIdx & 0x0f) << 4) | (clamp(state.washStrength, 0, 4) & 0x0f);
    washingData[5] = ((state.softener & 0x0f) << 4) | (state.detergent & 0x0f);
    washingData[6] = clamp(state.washTime, 0, 60);
    washingData[7] = ((clamp(state.dehydrationTime, 0, 15) & 0x0f) << 4) | (state.rinseCount & 0x0f);
    washingData[9] = clamp(state.soakTime, 0, 60);

    const body = new Uint8Array(3 + washingData.length);
    body[0] = 0x02;
    body[1] = 0xff;
    body[2] = state.running ? 0x01 : 0x00;
    body.set(washingData, 3);
    return buildMideaFrame(0xda, 0x02, body, { protocolVersion: 0x00, includeCrc8: false });
  }

  // 0xDB / 0xD9 串口回退
  const wireType = state.deviceType;
  if (isPowerOnly) {
    const body = new Uint8Array(22).fill(0xff);
    body[0] = 0x02;
    body[1] = state.power ? 0x01 : 0x00;
    return buildMideaFrame(wireType, 0x02, body, { protocolVersion: 0x00, includeCrc8: false });
  }
  if (!state.running && (norm === "control-status" || norm === "start")) {
    const body = new Uint8Array([0x02, 0xff, 0x00]);
    return buildMideaFrame(wireType, 0x02, body, { protocolVersion: 0x00, includeCrc8: false });
  }

  const washingData = new Uint8Array(13).fill(0xff);
  washingData[0] = DB_MODE_TO_BYTE[state.mode] ?? 0x00;
  const progDef = PROGRAM_BY_KEY.get(state.program);
  if (progDef?.dbByte !== undefined) {
    washingData[1] = progDef.dbByte;
  }
  washingData[2] = clamp(state.waterLevel, 1, 5);
  washingData[4] = encodeTemperatureToIndex(state.temperature, 1);
  washingData[5] = encodeSpinRpmToIndex(state.dehydrationSpeed);
  if (state.washTime > 0) washingData[6] = clamp(state.washTime, 0, 90);
  if (state.dehydrationTime > 0) washingData[7] = clamp(state.dehydrationTime, 0, 30);
  washingData[8] = clamp(state.detergent, 0, 5);
  washingData[9] = clamp(state.softener, 0, 5);

  const body = new Uint8Array(3 + washingData.length);
  body[0] = 0x02;
  body[1] = 0xff;
  body[2] = state.running ? 0x01 : 0x00;
  body.set(washingData, 3);
  return buildMideaFrame(wireType, 0x02, body, { protocolVersion: 0x00, includeCrc8: false });
}

export function buildWasherStatusResponseFrame(state: MideaWasherState): Buffer {
  const body = new Uint8Array(32).fill(0);
  body[0] = 0x03;
  body[1] = state.power ? 0x01 : 0x00;
  const statusMap: Record<MideaWasherRunningStatus, number> = {
    off: 0,
    idle: 0,
    standby: 1,
    start: 2,
    pause: 3,
    end: 4,
    fault: 5,
    delay: 6,
  };
  body[2] = statusMap[state.runningStatus] ?? (state.running ? 2 : state.power ? 1 : 0);

  if (state.deviceType === 0xda) {
    const progDef = PROGRAM_BY_KEY.get(state.program);
    body[4] = progDef?.daIndex ?? 0;
    body[5] = ((state.rinseLevel & 0x0f) << 4) | (state.washLevel & 0x0f);
    const daSpeedIdx =
      state.dehydrationSpeed <= 0
        ? 0
        : state.dehydrationSpeed <= 400
          ? 1
          : state.dehydrationSpeed <= 800
            ? 2
            : 3;
    body[6] = ((daSpeedIdx & 0x0f) << 4) | (state.washStrength & 0x0f);
    body[8] = ((state.softener & 0x0f) << 4) | (state.detergent & 0x0f);
    body[9] = clamp(state.washTime, 0, 60);
    body[10] = ((clamp(state.dehydrationTime, 0, 15) & 0x0f) << 4) | (state.rinseCount & 0x0f);
    body[12] = clamp(state.soakTime, 0, 60);
    const daProgressBit: Partial<Record<MideaWasherProgressStage, number>> = {
      spin: 1 << 1,
      rinse: 1 << 2,
      wash: 1 << 3,
      weight: 1 << 4,
      dry: 1 << 6,
      soak: 1 << 7,
    };
    body[16] = state.running ? (daProgressBit[state.progress] ?? 0) : 0;
    body[17] = state.remainTime % 60;
    body[18] = Math.floor(state.remainTime / 60);
    body[24] = Number.parseInt(state.errorCode, 10) || 0;
    return buildMideaFrame(0xda, 0x03, body, { protocolVersion: 0x00, includeCrc8: false });
  }

  // 0xDB / 0xD9
  body[3] = DB_MODE_TO_BYTE[state.mode] ?? 0;
  const progDef = PROGRAM_BY_KEY.get(state.program);
  body[4] = progDef?.dbByte ?? 0x03;
  body[5] = clamp(state.waterLevel, 1, 5);
  body[7] = encodeTemperatureToIndex(state.temperature, 1);
  body[8] = encodeSpinRpmToIndex(state.dehydrationSpeed);
  body[9] = clamp(state.washTime, 0, 90);
  body[10] = clamp(state.dehydrationTime, 0, 30);
  body[11] = clamp(state.detergent, 0, 5);
  body[12] = clamp(state.softener, 0, 5);
  const dbProgressBit: Partial<Record<MideaWasherProgressStage, number>> = {
    spin: 1 << 0,
    rinse: 1 << 1,
    wash: 1 << 2,
    pre_wash: 1 << 3,
    dry: 1 << 4,
    weight: 1 << 5,
    spin_high: 1 << 6,
  };
  body[16] = state.running ? (dbProgressBit[state.progress] ?? 0) : 0;
  body[17] = state.remainTime & 0xff;
  body[18] = (state.remainTime >> 8) & 0xff;
  body[26] = state.stains & 0xff;
  body[27] = state.washTimeValue ?? state.washTime;
  body[28] = state.dehydrationTimeValue ?? state.dehydrationTime;
  return buildMideaFrame(state.deviceType, 0x03, body, { protocolVersion: 0x00, includeCrc8: false });
}

export function parseWasherResponse(
  deviceType: MideaWasherTypeCode,
  frameOrRaw: ParsedMideaFrame | Uint8Array,
  existing?: MideaWasherState | null,
): MideaWasherState | null {
  const frame = frameOrRaw instanceof Uint8Array ? parseMideaFrame(frameOrRaw) : frameOrRaw;
  const body = frame.rawBody;
  if (body.length < 19) {
    return null;
  }

  const code = ((deviceType || frame.deviceType) & 0xff) as MideaWasherTypeCode;
  const base: MideaWasherState =
    existing && existing.deviceType === code
      ? { ...existing, drums: { ...existing.drums } }
      : defaultWasherState(code);

  const activeKey = base.activeDrum;
  const profile = resolveMideaWasherProfile(code, { sn8: base.sn8, modelNumber: base.modelNumber });
  const spec = profile.drums.find((d) => d.key === activeKey) ?? profile.drums[0]!;
  const prevDrum = base.drums[spec.key] ?? defaultDrumState(spec, code);

  const power = body[1]! > 0;
  const statusByte = body[2]!;
  const runningStatus = parseWasherRunningStatus(statusByte, power);
  const running = statusByte === 2 || statusByte === 6;

  if (code === 0xda) {
    const program = normalizeWasherProgram(body[4]!, 0xda);
    const rinseLevel = (body[5]! & 0xf0) >> 4;
    const washLevel = body[5]! & 0x0f;
    const speedIdx = (body[6]! & 0xf0) >> 4;
    const daSpeedTable = [0, 400, 800, 1200];
    const dehydrationSpeed = daSpeedTable[speedIdx] ?? 800;
    const washStrength = clamp(body[6]! & 0x0f, 1, 4);
    const softener = (body[8]! & 0xf0) >> 4;
    const detergent = body[8]! & 0x0f;
    const washTime = body[9]!;
    const dehydrationTime = (body[10]! & 0xf0) >> 4;
    const rinseCount = body[10]! & 0x0f;
    const soakTime = body[12]!;
    const progress = decodeWasherProgress(body[16]! >> 1, runningStatus, "da");
    const remainTime = power ? body[17]! + body[18]! * 60 : 0;
    const errorCode = body.length > 24 ? String(body[24]!) : prevDrum.errorCode;

    base.drums[spec.key] = {
      ...prevDrum,
      power,
      running,
      runningStatus,
      progress,
      program,
      remainTime,
      washLevel,
      rinseLevel,
      washStrength,
      dehydrationSpeed,
      detergent,
      softener,
      washTime,
      dehydrationTime,
      rinseCount,
      soakTime,
      errorCode,
    };
    return syncActiveDrumToTopLevel(base);
  }

  // 0xDB / 0xD9 串口回包
  const mode = DB_BYTE_TO_MODE[body[3]!] ?? "normal";
  const program = normalizeWasherProgram(body[4]!, code);
  const waterLevel = decodeWaterLevel(body[5]!) ?? prevDrum.waterLevel;
  const temperature = decodeTemperatureCelsius(body[7]!, true) ?? prevDrum.temperature;
  const dehydrationSpeed = decodeSpinRpm(body[8]!, true) ?? prevDrum.dehydrationSpeed;
  const washTime = body[9]!;
  const dehydrationTime = body[10]!;
  const detergent = body[11]!;
  const softener = body[12]!;
  const progress = decodeWasherProgress(body[16]!, runningStatus, "db");
  const remainTime = power ? body[17]! + (body[18]! << 8) : 0;
  const stains = body.length > 26 ? body[26]! : prevDrum.stains;
  const washTimeValue = body.length > 27 ? body[27]! : prevDrum.washTimeValue;
  const dehydrationTimeValue = body.length > 28 ? body[28]! : prevDrum.dehydrationTimeValue;

  base.drums[spec.key] = {
    ...prevDrum,
    power,
    running,
    runningStatus,
    progress,
    mode,
    program,
    waterLevel,
    temperature,
    dehydrationSpeed,
    washTime,
    dehydrationTime,
    detergent,
    softener,
    remainTime,
    stains,
    ...(washTimeValue !== undefined ? { washTimeValue } : {}),
    ...(dehydrationTimeValue !== undefined ? { dehydrationTimeValue } : {}),
  };
  return syncActiveDrumToTopLevel(base);
}
