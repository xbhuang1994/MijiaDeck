// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 美的智能 (Midea / 美的美居 / MSmartHome / NetHomePlus) 协议常量定义

export type MideaCloudBrand = "meiju" | "msmarthome" | "nethomeplus" | "midea_air";

export type MideaCloudProtocol = "mas" | "legacy";

export interface MideaCloudPreset {
  readonly brand: MideaCloudBrand;
  readonly label: string;
  readonly protocol: MideaCloudProtocol;
  readonly appId: string;
  readonly appKey: string;
  readonly loginKey: string;
  readonly iotKey?: string;
  readonly hmacKey?: string;
  readonly apiUrl: string;
  readonly apiUrlChina?: string;
  readonly fixedKey?: bigint;
  readonly fixedIv?: bigint;
}

/**
 * 美的系 App 云端预设（忠实对齐 Home Assistant `midea_ac_lan` 与 `mill1000/midea-msmart`）。
 */
export const MIDEA_CLOUD_PRESETS: Readonly<Record<MideaCloudBrand, MideaCloudPreset>> = {
  meiju: {
    brand: "meiju",
    label: "美的美居 (Meiju)",
    protocol: "mas",
    appId: "900",
    appKey: "46579c15",
    loginKey: "ad0ee21d48a64bf49f4fb583ab76e799",
    iotKey: "prod_secret123@muc",
    hmacKey: "PROD_VnoClJI9aikS8dyy",
    apiUrl: "https://mp-prod.smartmidea.net/mas/v5/app/proxy?alias=",
    fixedKey: 10864842703515613082n,
  },
  msmarthome: {
    brand: "msmarthome",
    label: "MSmartHome",
    protocol: "mas",
    appId: "1010",
    appKey: "ac21b9f9cbfe4ca5a88562ef25e2b768",
    loginKey: "ac21b9f9cbfe4ca5a88562ef25e2b768",
    iotKey: "meicloud",
    hmacKey: "PROD_VnoClJI9aikS8dyy",
    apiUrl: "https://mp-prod.appsmb.com/mas/v5/app/proxy?alias=",
    apiUrlChina: "https://mp-prod.smartmidea.net/mas/v5/app/proxy?alias=",
    fixedKey: 13101328926877700970n,
    fixedIv: 16429062708050928556n,
  },
  nethomeplus: {
    brand: "nethomeplus",
    label: "NetHome Plus",
    protocol: "legacy",
    appId: "1017",
    appKey: "3742e9e5842d4ad59c2db887e12449f9",
    loginKey: "3742e9e5842d4ad59c2db887e12449f9",
    apiUrl: "https://mapp.appsmb.com",
  },
  midea_air: {
    brand: "midea_air",
    label: "Midea Air",
    protocol: "legacy",
    appId: "1117",
    appKey: "ff0cf6f5f0c3471de36341cab3f7a9af",
    loginKey: "ff0cf6f5f0c3471de36341cab3f7a9af",
    apiUrl: "https://mapp.appsmb.com",
  },
} as const;

export interface MideaDefaultKeyPair {
  readonly token: string;
  readonly key: string;
}

/**
 * 美的 V3 局域网默认回退密钥对（对应 `midea_ac_lan` 的 `default_keys[99]`）。
 */
export const MIDEA_DEFAULT_KEYS: Readonly<Record<number, MideaDefaultKeyPair>> = {
  99: {
    token:
      "ee755a84a115703768bcc7c6c13d3d629aa416f1e2fd798beb9f78cbb1381d091cc245d7b063aad2a900e5b498fbd936c811f5d504b2e656d4f33b3bbc6d1da3",
    key: "ed37bd31558a4b039aaf4e7a7a59aa7a75fd9101682045f69baf45d28380ae5c",
  },
} as const;

export const MIDEA_DEFAULT_FALLBACK_KEYPAIR: MideaDefaultKeyPair = MIDEA_DEFAULT_KEYS[99]!;

export const MIDEA_LAN_TCP_PORT = 6444;
export const MIDEA_DISCOVERY_PORTS: readonly number[] = [6445, 20086] as const;

export interface MideaApplianceTypeInfo {
  readonly code: number;
  readonly hex: string;
  readonly kind: string;
  readonly label: string;
  readonly supportsMetrics: boolean;
  readonly metricFeatures: readonly string[];
}

/**
 * 美的家电品类注册表：映射十六进制设备类型码到 MijiaDeck `kind`、中文名称与指标能力。
 */
export const MIDEA_APPLIANCE_TYPES: Readonly<Record<number, MideaApplianceTypeInfo>> = {
  0xac: {
    code: 0xac,
    hex: "ac",
    kind: "air-conditioner",
    label: "空调",
    supportsMetrics: true,
    metricFeatures: ["temperature", "target-temperature"],
  },
  0xa1: {
    code: 0xa1,
    hex: "a1",
    kind: "dehumidifier",
    label: "除湿机",
    supportsMetrics: true,
    metricFeatures: ["relative-humidity", "target-humidity"],
  },
  0xfa: {
    code: 0xfa,
    hex: "fa",
    kind: "fan",
    label: "风扇",
    supportsMetrics: false,
    metricFeatures: [],
  },
  0xfc: {
    code: 0xfc,
    hex: "fc",
    kind: "air-purifier",
    label: "空气净化器",
    supportsMetrics: true,
    metricFeatures: ["pm2.5-density"],
  },
  0xfd: {
    code: 0xfd,
    hex: "fd",
    kind: "humidifier",
    label: "加湿器",
    supportsMetrics: true,
    metricFeatures: ["relative-humidity", "target-humidity"],
  },
  0xe2: {
    code: 0xe2,
    hex: "e2",
    kind: "water-heater",
    label: "电热水器",
    supportsMetrics: true,
    metricFeatures: ["temperature", "target-temperature"],
  },
  0xe3: {
    code: 0xe3,
    hex: "e3",
    kind: "water-heater",
    label: "燃气热水器",
    supportsMetrics: true,
    metricFeatures: ["temperature", "target-temperature"],
  },
  0xdb: {
    code: 0xdb,
    hex: "db",
    kind: "washing-machine",
    label: "滚筒洗衣机",
    supportsMetrics: false,
    metricFeatures: [],
  },
  0xdc: {
    code: 0xdc,
    hex: "dc",
    kind: "dryer",
    label: "干衣机",
    supportsMetrics: false,
    metricFeatures: [],
  },
  0xcc: {
    code: 0xcc,
    hex: "cc",
    kind: "air-conditioner",
    label: "中央空调",
    supportsMetrics: true,
    metricFeatures: ["temperature", "target-temperature"],
  },
  0xcf: {
    code: 0xcf,
    hex: "cf",
    kind: "heater",
    label: "热泵",
    supportsMetrics: true,
    metricFeatures: ["temperature", "target-temperature"],
  },
  0xea: {
    code: 0xea,
    hex: "ea",
    kind: "rice-cooker",
    label: "电饭煲",
    supportsMetrics: false,
    metricFeatures: [],
  },
  0x13: {
    code: 0x13,
    hex: "13",
    kind: "light",
    label: "照明灯",
    supportsMetrics: false,
    metricFeatures: [],
  },
} as const;

export function formatMideaTypeHex(typeCode: number): string {
  return (typeCode & 0xff).toString(16).padStart(2, "0");
}

export function getMideaApplianceType(typeCode: number): MideaApplianceTypeInfo {
  const normalized = typeCode & 0xff;
  const known = MIDEA_APPLIANCE_TYPES[normalized];
  if (known) {
    return known;
  }
  return {
    code: normalized,
    hex: formatMideaTypeHex(normalized),
    kind: "appliance",
    label: "智能设备",
    supportsMetrics: false,
    metricFeatures: [],
  };
}

/**
 * 解析字符串或数字形式的美的功能类型码（如 `"0xAC"`, `"AC"`, `"172"`, `0xAC`）。
 */
export function parseMideaTypeCode(raw: unknown, fallback = 0xac): number {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw & 0xff;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return fallback;
    if (/^0x[0-9a-f]+$/i.test(trimmed)) {
      return Number.parseInt(trimmed.slice(2), 16) & 0xff;
    }
    if (/^[0-9a-f]{2}$/i.test(trimmed) && /[a-f]/i.test(trimmed)) {
      return Number.parseInt(trimmed, 16) & 0xff;
    }
    const asDec = Number.parseInt(trimmed, 10);
    if (Number.isFinite(asDec)) {
      return asDec & 0xff;
    }
  }
  return fallback;
}

/**
 * 标准 104 字节 `0x5A5A` 局域网广播发现帧（40 字节包头 + 48 字节 AES-128-ECB 密文 + 16 字节加盐 MD5）。
 */
export const DISCOVERY_MSG = new Uint8Array([
  0x5a, 0x5a, 0x01, 0x11, 0x68, 0x00, 0x92, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x3b, 0x92, 0xed, 0x30, 0x1c, 0x2c, 0x98, 0x6e,
  0x93, 0xed, 0x40, 0xe7, 0xc6, 0xfb, 0xff, 0x49,
  0x4b, 0xdf, 0xb3, 0xe1, 0x6e, 0x33, 0xd8, 0x87,
  0x68, 0xcc, 0x4c, 0x3d, 0x06, 0x58, 0x93, 0x7d,
  0x91, 0x5c, 0x61, 0x8b, 0x02, 0xed, 0x27, 0x47,
  0xfa, 0xd7, 0x3f, 0x2f, 0xfa, 0x0d, 0xb1, 0xd3,
  0xa4, 0xbc, 0xa9, 0x62, 0xe1, 0x66, 0x5e, 0x90,
  0x6a, 0xb0, 0xe1, 0x47, 0xe7, 0xfc, 0xbd, 0xe2,
]);

/**
 * 兼容旧版 Wi-Fi 模组的 72 字节 `0x5A5A` 局域网广播发现帧（`midea_ac_lan` `BROADCAST_MSG`）。
 */
export const DISCOVERY_MSG_LEGACY = new Uint8Array([
  0x5a, 0x5a, 0x01, 0x11, 0x48, 0x00, 0x92, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x7f, 0x75, 0xbd, 0x6b, 0x3e, 0x4f, 0x8b, 0x76,
  0x2e, 0x84, 0x9c, 0x6e, 0x57, 0x8d, 0x65, 0x90,
  0x03, 0x6e, 0x9d, 0x43, 0x42, 0xa5, 0x0f, 0x1f,
  0x56, 0x9e, 0xb8, 0xec, 0x91, 0x8e, 0x92, 0xe5,
]);
