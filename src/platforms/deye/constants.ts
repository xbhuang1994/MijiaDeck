// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 德业智能 (Deye Smart / libdeye + Solarman V5) 协议常量与产品能力表

/** Deye 智能云端用户 API 基地址（忠实对应 stackia/libdeye） */
export const DEYE_API_END_USER_ENDPOINT = "https://api.deye.com.cn/v3/enduser";

/** Deye Smart App 官方登录参数 */
export const DEYE_LOGIN_PARAM_APP_ID = "a774310e-a430-11e7-9d4c-00163e0c1b21";
export const DEYE_LOGIN_PARAM_EXTEND = '{"cid":"63d5b0df098443db906f857003f29d12","type":"1"}';

/** Combo 协议版本标识 */
export const COMBO_PROTOCOL_VERSION = "combo_V1.0";

/** Classic MQTT 设备状态查询载荷（0x00 0x01） */
export const QUERY_DEVICE_STATE_COMMAND_CLASSIC = new Uint8Array([0x00, 0x01]);

/**
 * 德业 IoT 平台类型（对应 DeviceListBean.platform）。
 * 官方 isFogPlatform() 为 platform === 2 || platform === 3；
 * 平台 3 (FogCombo) 走 Fog HTTP，而非 Combo MQTT 帧。
 */
export enum DeyeIotPlatform {
  Classic = 1,
  Fog = 2,
  FogCombo = 3,
}

/**
 * 德业设备传输路径（对应官方 CommandManger 路由规则）。
 * 规则：isFog -> FOG；else if is_combo && protocol_version === "combo_V1.0" -> COMBO；else CLASSIC。
 */
export enum DeyeDeviceTransport {
  CLASSIC = 1,
  FOG = 2,
  COMBO = 3,
}

export interface DeyeTransportDeviceHint {
  platform: DeyeIotPlatform | number;
  is_combo?: boolean;
  protocol_version?: string;
}

/** 判断设备是否走 Fog HTTP 平台 */
export function deviceUsesFogPlatform(device: Pick<DeyeTransportDeviceHint, "platform">): boolean {
  const platform = Number(device.platform);
  return platform === DeyeIotPlatform.Fog || platform === DeyeIotPlatform.FogCombo;
}

/** 判断设备是否使用 Combo 单属性 MQTT 帧协议 */
export function deviceUsesComboProtocol(
  device: Pick<DeyeTransportDeviceHint, "is_combo" | "protocol_version">,
): boolean {
  return Boolean(device.is_combo) && device.protocol_version === COMBO_PROTOCOL_VERSION;
}

/** 按官方 CommandManger 规则解析设备传输协议 */
export function transportForDevice(device: DeyeTransportDeviceHint): DeyeDeviceTransport {
  if (deviceUsesFogPlatform(device)) {
    return DeyeDeviceTransport.FOG;
  }
  if (deviceUsesComboProtocol(device)) {
    return DeyeDeviceTransport.COMBO;
  }
  return DeyeDeviceTransport.CLASSIC;
}

/** 德业除湿机/空气净化器工作模式枚举 */
export enum DeyeDeviceMode {
  MANUAL_MODE = 0,
  CLOTHES_DRYER_MODE = 1,
  AIR_PURIFIER_MODE = 2,
  AUTO_MODE = 3,
  TURBO_MODE = 4,
  UNKNOWN_MODE_2 = 5,
  SLEEP_MODE = 6,
  MANUAL_PURIFIER_MODE = 7,
  SLEEP_PURIFIER_MODE = 8,
  AUTO_PURIFIER_MODE = 9,
}

export const DEYE_MODE_LABELS: Readonly<Record<DeyeDeviceMode, string>> = {
  [DeyeDeviceMode.MANUAL_MODE]: "手动",
  [DeyeDeviceMode.CLOTHES_DRYER_MODE]: "干衣",
  [DeyeDeviceMode.AIR_PURIFIER_MODE]: "净化",
  [DeyeDeviceMode.AUTO_MODE]: "自动",
  [DeyeDeviceMode.TURBO_MODE]: "强力",
  [DeyeDeviceMode.UNKNOWN_MODE_2]: "其他模式",
  [DeyeDeviceMode.SLEEP_MODE]: "睡眠",
  [DeyeDeviceMode.MANUAL_PURIFIER_MODE]: "手动净化",
  [DeyeDeviceMode.SLEEP_PURIFIER_MODE]: "睡眠净化",
  [DeyeDeviceMode.AUTO_PURIFIER_MODE]: "自动净化",
};

/** 德业风速枚举 */
export enum DeyeFanSpeed {
  STOPPED = 0,
  LOW = 1,
  MIDDLE = 2,
  HIGH = 3,
  FULL = 4,
  AUTO = 5,
}

export const DEYE_FAN_SPEED_LABELS: Readonly<Record<DeyeFanSpeed, string>> = {
  [DeyeFanSpeed.STOPPED]: "停止",
  [DeyeFanSpeed.LOW]: "低风",
  [DeyeFanSpeed.MIDDLE]: "中风",
  [DeyeFanSpeed.HIGH]: "高风",
  [DeyeFanSpeed.FULL]: "强风",
  [DeyeFanSpeed.AUTO]: "自动",
};

export interface DeyeProductConfig {
  mode: DeyeDeviceMode[];
  fan_speed: DeyeFanSpeed[];
  min_target_humidity: number;
  max_target_humidity: number;
  anion: boolean;
  oscillating: boolean;
  water_pump: boolean;
  uv: boolean;
  prompt_sound: boolean;
  screen_display: boolean;
  timed_off: boolean;
}

export type DeyeProductPartialConfig = Partial<DeyeProductConfig>;

/** 未知型号兜底能力表（与 libdeye DeYeDehumidifierModel.json 保持一致） */
export const DEFAULT_PRODUCT_FEATURE_CONFIG: DeyeProductConfig = {
  mode: [
    DeyeDeviceMode.MANUAL_MODE,
    DeyeDeviceMode.AIR_PURIFIER_MODE,
    DeyeDeviceMode.CLOTHES_DRYER_MODE,
    DeyeDeviceMode.AUTO_MODE,
    DeyeDeviceMode.SLEEP_MODE,
  ],
  fan_speed: [DeyeFanSpeed.LOW, DeyeFanSpeed.MIDDLE, DeyeFanSpeed.HIGH, DeyeFanSpeed.FULL],
  min_target_humidity: 25,
  max_target_humidity: 80,
  anion: true,
  oscillating: false,
  water_pump: false,
  uv: false,
  prompt_sound: false,
  screen_display: false,
  timed_off: false,
};

/**
 * 德业常见除湿机与空净型号能力配置表（源自 stackia/libdeye const.py）。
 */
export const PRODUCT_FEATURE_CONFIG: Readonly<Record<string, DeyeProductPartialConfig>> = {
  // DYD-P40
  d71936c6951c11f0a8200242ac480009: {
    mode: [
      DeyeDeviceMode.AUTO_MODE,
      DeyeDeviceMode.CLOTHES_DRYER_MODE,
      DeyeDeviceMode.SLEEP_MODE,
      DeyeDeviceMode.AIR_PURIFIER_MODE,
      DeyeDeviceMode.TURBO_MODE,
    ],
    fan_speed: [DeyeFanSpeed.LOW, DeyeFanSpeed.MIDDLE, DeyeFanSpeed.HIGH, DeyeFanSpeed.AUTO],
    min_target_humidity: 40,
    max_target_humidity: 70,
    anion: true,
    oscillating: true,
    water_pump: false,
    uv: true,
    prompt_sound: true,
    screen_display: true,
    timed_off: false,
  },
  // 612S
  "07dddba41c3011e8829100163e0f811e": {
    mode: [],
    fan_speed: [DeyeFanSpeed.LOW, DeyeFanSpeed.HIGH],
    min_target_humidity: 30,
    max_target_humidity: 80,
    anion: true,
    oscillating: false,
    water_pump: false,
  },
  // 620S
  "775bd87e9bfc11eb9b040242ac480009": {
    mode: [],
    fan_speed: [DeyeFanSpeed.LOW, DeyeFanSpeed.HIGH],
    min_target_humidity: 30,
    max_target_humidity: 80,
    anion: true,
    oscillating: false,
    water_pump: false,
  },
  // 8220C
  "441480dcf29611eca05a0242ac480009": {
    mode: [DeyeDeviceMode.AUTO_MODE, DeyeDeviceMode.MANUAL_MODE],
    fan_speed: [DeyeFanSpeed.LOW, DeyeFanSpeed.HIGH],
    min_target_humidity: 26,
    max_target_humidity: 90,
    anion: false,
    oscillating: false,
    water_pump: false,
  },
  // B12A3
  e69a5f54983f11ec964d0242ac480009: {
    mode: [
      DeyeDeviceMode.MANUAL_MODE,
      DeyeDeviceMode.CLOTHES_DRYER_MODE,
      DeyeDeviceMode.AIR_PURIFIER_MODE,
      DeyeDeviceMode.SLEEP_MODE,
    ],
    fan_speed: [],
    min_target_humidity: 30,
    max_target_humidity: 80,
    anion: true,
    oscillating: false,
    water_pump: false,
  },
  // D50A3
  c56f9e0c7d2b11e9829100163e0f811e: {
    mode: [DeyeDeviceMode.MANUAL_MODE, DeyeDeviceMode.CLOTHES_DRYER_MODE, DeyeDeviceMode.SLEEP_MODE],
    fan_speed: [DeyeFanSpeed.LOW, DeyeFanSpeed.MIDDLE, DeyeFanSpeed.HIGH],
    min_target_humidity: 30,
    max_target_humidity: 80,
    anion: false,
    oscillating: false,
    water_pump: false,
  },
  // D50B3
  "86cec9fc5c9811e8829100163e0f811e": {
    mode: [DeyeDeviceMode.MANUAL_MODE, DeyeDeviceMode.CLOTHES_DRYER_MODE],
    fan_speed: [DeyeFanSpeed.LOW, DeyeFanSpeed.MIDDLE, DeyeFanSpeed.HIGH],
    min_target_humidity: 30,
    max_target_humidity: 80,
    anion: false,
    oscillating: false,
    water_pump: true,
  },
  // E12A3
  c2c2d92c049f11e8829100163e0f811e: {
    mode: [DeyeDeviceMode.MANUAL_MODE, DeyeDeviceMode.CLOTHES_DRYER_MODE],
    fan_speed: [],
    min_target_humidity: 30,
    max_target_humidity: 80,
    anion: false,
    oscillating: false,
    water_pump: false,
  },
  // G25A3
  "8d52bc78f38511e89d4c00163e0c1b21": {
    mode: [],
    fan_speed: [DeyeFanSpeed.LOW, DeyeFanSpeed.HIGH],
    min_target_humidity: 30,
    max_target_humidity: 80,
    anion: false,
    oscillating: true,
    water_pump: false,
  },
  // N20A3
  a3850ae49ea511e89d4c00163e0c1b21: {
    mode: [DeyeDeviceMode.AUTO_MODE, DeyeDeviceMode.MANUAL_MODE, DeyeDeviceMode.CLOTHES_DRYER_MODE],
    fan_speed: [DeyeFanSpeed.LOW, DeyeFanSpeed.MIDDLE, DeyeFanSpeed.HIGH],
    min_target_humidity: 40,
    max_target_humidity: 70,
    anion: true,
    oscillating: false,
    water_pump: false,
  },
  // L48A3
  "5ea0feae4b1111ebb73c0242ac480009": {
    mode: [DeyeDeviceMode.MANUAL_MODE, DeyeDeviceMode.CLOTHES_DRYER_MODE],
    fan_speed: [DeyeFanSpeed.LOW, DeyeFanSpeed.HIGH],
    min_target_humidity: 30,
    max_target_humidity: 80,
    anion: false,
    oscillating: false,
    water_pump: false,
  },
  // T22A3
  "2c4bd0861c3011e89d4c00163e0c1b21": {
    mode: [
      DeyeDeviceMode.AUTO_MODE,
      DeyeDeviceMode.MANUAL_MODE,
      DeyeDeviceMode.CLOTHES_DRYER_MODE,
      DeyeDeviceMode.AIR_PURIFIER_MODE,
    ],
    fan_speed: [DeyeFanSpeed.LOW, DeyeFanSpeed.MIDDLE, DeyeFanSpeed.HIGH],
    min_target_humidity: 30,
    max_target_humidity: 80,
    anion: true,
    oscillating: false,
    water_pump: false,
  },
  // TM208FC
  "6f97c340a43011e7829100163e0f811e": {
    mode: [
      DeyeDeviceMode.AUTO_MODE,
      DeyeDeviceMode.MANUAL_MODE,
      DeyeDeviceMode.CLOTHES_DRYER_MODE,
      DeyeDeviceMode.AIR_PURIFIER_MODE,
    ],
    fan_speed: [DeyeFanSpeed.LOW, DeyeFanSpeed.HIGH],
    min_target_humidity: 30,
    max_target_humidity: 80,
    anion: true,
    oscillating: true,
    water_pump: false,
  },
  // U20A3
  "20eae2ea268511e8829100163e0f811e": {
    mode: [
      DeyeDeviceMode.AUTO_MODE,
      DeyeDeviceMode.MANUAL_MODE,
      DeyeDeviceMode.CLOTHES_DRYER_MODE,
      DeyeDeviceMode.AIR_PURIFIER_MODE,
      DeyeDeviceMode.SLEEP_MODE,
    ],
    fan_speed: [DeyeFanSpeed.LOW, DeyeFanSpeed.MIDDLE, DeyeFanSpeed.HIGH, DeyeFanSpeed.FULL],
    min_target_humidity: 30,
    max_target_humidity: 80,
    anion: true,
    oscillating: false,
    water_pump: false,
  },
  // U20Air
  "363b686a31ee11efb7203b3cd9717242": {
    mode: [DeyeDeviceMode.MANUAL_MODE, DeyeDeviceMode.CLOTHES_DRYER_MODE, DeyeDeviceMode.SLEEP_MODE],
    fan_speed: [],
    min_target_humidity: 30,
    max_target_humidity: 80,
    anion: true,
    oscillating: false,
    water_pump: false,
  },
  // V58A3
  "2b770cba268611e89d4c00163e0c1b21": {
    mode: [
      DeyeDeviceMode.AUTO_MODE,
      DeyeDeviceMode.MANUAL_MODE,
      DeyeDeviceMode.CLOTHES_DRYER_MODE,
      DeyeDeviceMode.AIR_PURIFIER_MODE,
      DeyeDeviceMode.SLEEP_MODE,
    ],
    fan_speed: [DeyeFanSpeed.LOW, DeyeFanSpeed.MIDDLE, DeyeFanSpeed.HIGH, DeyeFanSpeed.FULL],
    min_target_humidity: 30,
    max_target_humidity: 80,
    anion: true,
    oscillating: false,
    water_pump: false,
  },
  // W20A3
  "17ab051af38611e89d4c00163e0c1b21": {
    mode: [DeyeDeviceMode.MANUAL_MODE, DeyeDeviceMode.CLOTHES_DRYER_MODE],
    fan_speed: [DeyeFanSpeed.LOW, DeyeFanSpeed.HIGH],
    min_target_humidity: 30,
    max_target_humidity: 80,
    anion: false,
    oscillating: false,
    water_pump: false,
  },
  // X20A3
  d74ab1167d9f11e8829100163e0f811e: {
    mode: [
      DeyeDeviceMode.AUTO_MODE,
      DeyeDeviceMode.MANUAL_MODE,
      DeyeDeviceMode.CLOTHES_DRYER_MODE,
      DeyeDeviceMode.SLEEP_MODE,
    ],
    fan_speed: [DeyeFanSpeed.LOW, DeyeFanSpeed.MIDDLE, DeyeFanSpeed.HIGH],
    min_target_humidity: 30,
    max_target_humidity: 80,
    anion: true,
    oscillating: false,
    water_pump: false,
  },
  // Z12A3
  ff71de22187111e99d4c00163e0c1b21: {
    mode: [DeyeDeviceMode.MANUAL_MODE, DeyeDeviceMode.CLOTHES_DRYER_MODE],
    fan_speed: [DeyeFanSpeed.LOW, DeyeFanSpeed.HIGH],
    min_target_humidity: 30,
    max_target_humidity: 80,
    anion: false,
    oscillating: false,
    water_pump: false,
  },
  // Z20B3
  "1b351ce6187211e99d4c00163e0c1b21": {
    mode: [DeyeDeviceMode.MANUAL_MODE, DeyeDeviceMode.CLOTHES_DRYER_MODE],
    fan_speed: [DeyeFanSpeed.LOW, DeyeFanSpeed.HIGH],
    min_target_humidity: 30,
    max_target_humidity: 80,
    anion: false,
    oscillating: false,
    water_pump: false,
  },
  // A10
  "744b6884fb294936b4f73f427507aaa3": {
    mode: [DeyeDeviceMode.MANUAL_MODE, DeyeDeviceMode.CLOTHES_DRYER_MODE, DeyeDeviceMode.SLEEP_MODE],
    fan_speed: [DeyeFanSpeed.LOW, DeyeFanSpeed.MIDDLE, DeyeFanSpeed.HIGH],
    min_target_humidity: 40,
    max_target_humidity: 70,
    anion: true,
    oscillating: false,
    water_pump: false,
    uv: false,
    prompt_sound: true,
    screen_display: true,
    timed_off: true,
  },
  // ES25A3
  be8f5e6a893111f0aebc0242ac480009: {
    mode: [
      DeyeDeviceMode.MANUAL_MODE,
      DeyeDeviceMode.CLOTHES_DRYER_MODE,
      DeyeDeviceMode.SLEEP_MODE,
      DeyeDeviceMode.AIR_PURIFIER_MODE,
    ],
    fan_speed: [DeyeFanSpeed.LOW, DeyeFanSpeed.MIDDLE, DeyeFanSpeed.HIGH],
    min_target_humidity: 40,
    max_target_humidity: 70,
    anion: true,
    oscillating: true,
    water_pump: false,
    uv: false,
    prompt_sound: true,
    screen_display: true,
    timed_off: true,
  },
  // P30
  "537ed2b4d4c111f080e00242ac480009": {
    mode: [DeyeDeviceMode.MANUAL_MODE, DeyeDeviceMode.CLOTHES_DRYER_MODE, DeyeDeviceMode.SLEEP_MODE],
    fan_speed: [DeyeFanSpeed.LOW, DeyeFanSpeed.MIDDLE, DeyeFanSpeed.HIGH],
    min_target_humidity: 40,
    max_target_humidity: 70,
    anion: false,
    oscillating: true,
    water_pump: false,
    uv: false,
    prompt_sound: true,
    screen_display: true,
    timed_off: true,
  },
  // C65DZ
  "7faf2a66c8b811efb3a50242ac480009": {
    mode: [DeyeDeviceMode.MANUAL_MODE, DeyeDeviceMode.AIR_PURIFIER_MODE],
    fan_speed: [DeyeFanSpeed.LOW, DeyeFanSpeed.HIGH],
    min_target_humidity: 26,
    max_target_humidity: 80,
    anion: false,
    oscillating: false,
    water_pump: false,
    uv: true,
    prompt_sound: false,
    screen_display: false,
    timed_off: false,
  },
};

export function getProductFeatureConfig(productId: string): DeyeProductConfig {
  const override = PRODUCT_FEATURE_CONFIG[productId];
  if (!override) {
    return {
      ...DEFAULT_PRODUCT_FEATURE_CONFIG,
      mode: [...DEFAULT_PRODUCT_FEATURE_CONFIG.mode],
      fan_speed: [...DEFAULT_PRODUCT_FEATURE_CONFIG.fan_speed],
    };
  }
  return {
    ...DEFAULT_PRODUCT_FEATURE_CONFIG,
    ...override,
    mode: override.mode ? [...override.mode] : [...DEFAULT_PRODUCT_FEATURE_CONFIG.mode],
    fan_speed: override.fan_speed
      ? [...override.fan_speed]
      : [...DEFAULT_PRODUCT_FEATURE_CONFIG.fan_speed],
  };
}

/**
 * Fog GET/MQTT 属性到 SET 属性的别名映射（TimedShutdownHourSetting -> TimedOffHour）。
 */
export const FOG_SETTABLE_PROPERTY_ALIASES: ReadonlyArray<readonly [string, string]> = [
  ["KeyLock", "KeyLock"],
  ["Mode", "Mode"],
  ["Power", "Power"],
  ["UV", "UV"],
  ["WindSpeed", "WindSpeed"],
  ["SetHumidity", "SetHumidity"],
  ["NegativeIon", "NegativeIon"],
  ["SwingingWind", "SwingingWind"],
  ["WaterPump", "WaterPump"],
  ["Sleep", "Sleep"],
  ["SetTemperature", "SetTemperature"],
  ["PromptSound", "PromptSound"],
  ["Screendisplay", "Screendisplay"],
  ["TimedShutdownHourSetting", "TimedOffHour"],
  ["TimedOffHour", "TimedOffHour"],
] as const;

export const FOG_SETTABLE_PROPERTY_ORDER: readonly string[] = [
  "KeyLock",
  "Mode",
  "Power",
  "UV",
  "WindSpeed",
  "SetHumidity",
  "NegativeIon",
  "SwingingWind",
  "WaterPump",
  "Sleep",
  "SetTemperature",
  "PromptSound",
  "Screendisplay",
  "TimedOffHour",
] as const;

/**
 * Fog ProtocolVersion === 0 伴随属性表（忠实对应 libdeye/mqtt_client.py FOG_PROTOCOL_V0_COMPANIONS）。
 * 旧版固件要求在写入单个主键时附带对应的伴随字段快照（例如 Power 不携带 SwingingWind）。
 */
export const FOG_PROTOCOL_V0_COMPANIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  Power: new Set([
    "KeyLock",
    "UV",
    "Mode",
    "SetHumidity",
    "WindSpeed",
    "NegativeIon",
    "WaterPump",
    "Sleep",
    "SetTemperature",
    "TimedOffHour",
  ]),
  WindSpeed: new Set([
    "UV",
    "KeyLock",
    "Mode",
    "SetHumidity",
    "Power",
    "NegativeIon",
    "WaterPump",
    "SwingingWind",
    "Sleep",
    "SetTemperature",
    "TimedOffHour",
  ]),
  Mode: new Set([
    "UV",
    "KeyLock",
    "Power",
    "SetHumidity",
    "WindSpeed",
    "NegativeIon",
    "WaterPump",
    "SwingingWind",
    "Sleep",
    "SetTemperature",
    "TimedOffHour",
  ]),
  SetHumidity: new Set([
    "UV",
    "KeyLock",
    "Power",
    "Mode",
    "WindSpeed",
    "NegativeIon",
    "WaterPump",
    "SwingingWind",
    "TimedOffHour",
  ]),
  SetTemperature: new Set([
    "KeyLock",
    "Power",
    "Mode",
    "WindSpeed",
    "NegativeIon",
    "WaterPump",
    "SwingingWind",
    "Sleep",
    "TimedOffHour",
  ]),
  KeyLock: new Set([
    "UV",
    "SetHumidity",
    "Power",
    "Mode",
    "WindSpeed",
    "NegativeIon",
    "WaterPump",
    "SwingingWind",
    "Sleep",
    "SetTemperature",
    "TimedOffHour",
  ]),
  NegativeIon: new Set([
    "UV",
    "SetHumidity",
    "Power",
    "Mode",
    "WindSpeed",
    "KeyLock",
    "WaterPump",
    "SwingingWind",
    "Sleep",
    "SetTemperature",
    "TimedOffHour",
  ]),
  UV: new Set([
    "NegativeIon",
    "SetHumidity",
    "Power",
    "Mode",
    "WindSpeed",
    "KeyLock",
    "WaterPump",
    "SwingingWind",
    "Sleep",
    "SetTemperature",
    "TimedOffHour",
  ]),
  SwingingWind: new Set([
    "UV",
    "SetHumidity",
    "Power",
    "Mode",
    "WindSpeed",
    "KeyLock",
    "WaterPump",
    "NegativeIon",
    "Sleep",
    "SetTemperature",
    "TimedOffHour",
  ]),
  WaterPump: new Set([
    "UV",
    "SetHumidity",
    "Power",
    "Mode",
    "WindSpeed",
    "KeyLock",
    "SwingingWind",
    "NegativeIon",
    "Sleep",
    "SetTemperature",
    "TimedOffHour",
  ]),
  Sleep: new Set([
    "SetHumidity",
    "Power",
    "Mode",
    "WindSpeed",
    "KeyLock",
    "SwingingWind",
    "NegativeIon",
    "WaterPump",
    "SetTemperature",
    "TimedOffHour",
  ]),
  Screendisplay: new Set<string>(),
  PromptSound: new Set<string>(),
  TimedOffHour: new Set<string>(),
};

/**
 * Solarman V5 德业混合逆变器标准 Modbus 保持寄存器映射
 * （源自 ha-solarman / StephanJoubert/home_assistant_solarman deye_hybrid.yaml）。
 */
export const DEYE_SOLARMAN_REGISTERS = {
  /** 运行状态 (0=待机, 1=自检, 2=正常, 3=故障) */
  RUNNING_STATUS: 0x003b,
  /** 逆变器 DC 温度 ((raw - 1000) * 0.1 °C) */
  DC_TEMPERATURE: 0x005a,
  /** 逆变器 AC 散热温度 ((raw - 1000) * 0.1 °C) */
  AC_TEMPERATURE: 0x005b,
  /** 累计光伏发电量低 16 位 (0.1 kWh) */
  TOTAL_PRODUCTION_LOW: 0x0060,
  /** 累计光伏发电量高 16 位 (0.1 kWh) */
  TOTAL_PRODUCTION_HIGH: 0x0061,
  /** 当日光伏发电量 (0.1 kWh) */
  DAILY_PRODUCTION: 0x006c,
  /** PV1 电压 (0.1 V) */
  PV1_VOLTAGE: 0x006d,
  /** PV1 电流 (0.1 A) */
  PV1_CURRENT: 0x006e,
  /** PV2 电压 (0.1 V) */
  PV2_VOLTAGE: 0x006f,
  /** PV2 电流 (0.1 A) */
  PV2_CURRENT: 0x0070,
  /** 电网总功率 (int16, W；正值购电/负值馈网) */
  GRID_POWER: 0x00a9,
  /** 负载总功率 (W) */
  LOAD_POWER: 0x00b2,
  /** 电池温度 ((raw - 1000) * 0.1 °C) */
  BATTERY_TEMPERATURE: 0x00b6,
  /** 电池电压 (0.01 V) */
  BATTERY_VOLTAGE: 0x00b7,
  /** 电池 SOC (%) */
  BATTERY_SOC: 0x00b8,
  /** PV1 功率 (W) */
  PV1_POWER: 0x00ba,
  /** PV2 功率 (W) */
  PV2_POWER: 0x00bb,
  /** 电池状态 (0=充电, 1=待机, 2=放电) */
  BATTERY_STATUS: 0x00bd,
  /** 电池功率 (int16, W) */
  BATTERY_POWER: 0x00be,
  /** 电池电流 (int16, 0.01 A) */
  BATTERY_CURRENT: 0x00bf,
} as const;

/** 两次批量读取即可覆盖所有关键光伏/电池/电网/负载/温度寄存器的区间定义 */
export const DEYE_SOLARMAN_READ_BLOCKS: ReadonlyArray<{ start: number; count: number }> = [
  { start: 0x003b, count: 54 }, // 0x003B..0x0070
  { start: 0x00a9, count: 23 }, // 0x00A9..0x00BF
] as const;

export const DEYE_INVERTER_STATUS_LABELS: Readonly<Record<number, string>> = {
  0: "待机",
  1: "自检",
  2: "正常运行",
  3: "故障",
};
