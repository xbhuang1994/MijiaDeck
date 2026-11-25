// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 涂鸦智能 (Tuya Smart / Smart Life) 协议常量与品类映射

import { createHash } from "node:crypto";

/** Home Assistant Device Sharing SDK 默认参数（参考 tuya-device-sharing-sdk） */
export const TUYA_CLIENT_ID = "HA_3y9q4ak7g4ephrvke";
export const TUYA_SCHEMA = "haauthorize";
export const TUYA_SHARING_AUTH_ENDPOINT = "https://apigw.iotbing.com";
export const TUYA_SHARING_QR_PREFIX = "tuyaSmart--qrLogin?token=";

/** HA Device Sharing AES-GCM 随机 12 字节 ASCII Nonce 字符表 */
export const TUYA_SHARING_NONCE_ALPHABET = "ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678";

/** HA Device Sharing 参与 HMAC-SHA256 请求签名的有序 Header 列表 */
export const TUYA_SHARING_SIGN_HEADERS = [
  "X-appKey",
  "X-requestId",
  "X-sid",
  "X-time",
  "X-token",
] as const;

/** Tuya Cloud OpenAPI v2.0 区域接入点 */
export type TuyaOpenApiRegion = "cn" | "us" | "eu" | "in";

export const TUYA_OPENAPI_ENDPOINTS: Readonly<Record<TuyaOpenApiRegion, string>> = {
  cn: "https://openapi.tuyacn.com",
  us: "https://openapi.tuyaus.com",
  eu: "https://openapi.tuyaeu.com",
  in: "https://openapi.tuyain.com",
};

/** 涂鸦设备品类代码 -> MijiaDeck 标准设备种类（对齐 deviceControls.ts） */
export const TUYA_CATEGORY_KIND_MAP: Readonly<Record<string, string>> = {
  // Lights
  dj: "light",
  dd: "light",
  fwd: "light",
  tgq: "light",
  xdd: "light",
  dc: "light",
  fsd: "light",
  gyd: "light",
  tyndj: "light",
  ykq: "light",

  // Switches
  kg: "switch",
  tdq: "switch",
  cjkg: "switch",
  wxkg: "switch",

  // Outlets / Plugs
  cz: "outlet",
  pc: "outlet",

  // Climate / HVAC
  kt: "air-conditioner",
  ktkzq: "air-conditioner",
  wk: "thermostat",
  qn: "heater",
  rs: "water-heater",

  // Air treatment & fans
  cs: "dehumidifier",
  jsq: "humidifier",
  kj: "air-purifier",
  fs: "fan",

  // Curtains / Covers
  cl: "curtain",
  clkg: "curtain",

  // Sensors
  wsdcg: "temperature-humidity-sensor",
  pir: "motion-sensor",
  mcs: "contact-sensor",
  sj: "water-leak-sensor",
  ywbj: "smoke-sensor",
  rqbj: "gas-sensor",
  co2bj: "air-monitor",
  pm25: "air-monitor",
  hjjcy: "air-monitor",

  // Vacuum / Pet Feeder / Camera
  sd: "vacuum",
  cwwsq: "pet-feeder",
  sp: "camera",

  // Infrared Hub & Virtual IR Remotes (涂鸦万能红外遥控器及其虚拟红外子设备)
  wnykq: "ir-hub",
  infrared_ac: "air-conditioner",
  infrared_tv: "television",
  infrared_amplifier: "amplifier",
  infrared_audio: "amplifier",
  infrared_soundbar: "amplifier",
  infrared_speaker: "amplifier",
  infrared_fan: "fan",
  infrared_air_purifier: "air-purifier",
  infrared_purifier: "air-purifier",
  infrared_heater: "heater",
  infrared_water_heater: "water-heater",
  infrared_humidifier: "humidifier",
  infrared_dehumidifier: "dehumidifier",
  infrared_stb: "set-top-box",
  infrared_box: "set-top-box",
  infrared_tv_box: "set-top-box",
  infrared_projector: "projector",
  infrared_dvd: "dvd-player",
  infrared_diy: "ir-remote",
};

export function isTuyaInfraredCategory(category?: string | null): boolean {
  if (!category) return false;
  return category.trim().toLowerCase().startsWith("infrared_");
}

export function isTuyaIrHubCategory(category?: string | null): boolean {
  if (!category) return false;
  const key = category.trim().toLowerCase();
  return key === "wnykq" || key === "qt";
}

export function tuyaCategoryToKind(category?: string | null): string {
  if (!category) return "device";
  const key = category.trim().toLowerCase();
  if (key in TUYA_CATEGORY_KIND_MAP) {
    return TUYA_CATEGORY_KIND_MAP[key]!;
  }
  if (key.startsWith("infrared_")) {
    return "ir-remote";
  }
  return "device";
}

/** LocalTuya / TinyTuya 局域网帧头帧尾魔数 */
export const TUYA_PREFIX_55AA = 0x000055aa;
export const TUYA_SUFFIX_AA55 = 0x0000aa55;
export const TUYA_PREFIX_6699 = 0x00006699;
export const TUYA_SUFFIX_9966 = 0x00009966;

export const TUYA_LOCAL_DEFAULT_PORT = 6668;
export const TUYA_UDP_PORT_V31 = 6666;
export const TUYA_UDP_PORT_V33 = 6667;

/** LocalTuya / TinyTuya 命令码 */
export const TUYA_LOCAL_CMD = {
  UDP: 0x00,
  AP_CONFIG: 0x01,
  ACTIVE: 0x02,
  SESS_KEY_NEG_START: 0x03,
  SESS_KEY_NEG_RESP: 0x04,
  SESS_KEY_NEG_FINISH: 0x05,
  UNBIND: 0x06,
  CONTROL: 0x07,
  STATUS: 0x08,
  HEART_BEAT: 0x09,
  DP_QUERY: 0x0a,
  QUERY_WIFI: 0x0b,
  TOKEN_BIND: 0x0c,
  CONTROL_NEW: 0x0d,
  ENABLE_WIFI: 0x0e,
  WIFI_INFO: 0x0f,
  DP_QUERY_NEW: 0x10,
  SCENE_EXECUTE: 0x11,
  UPDATEDPS: 0x12,
  UDP_NEW: 0x13,
  AP_CONFIG_NEW: 0x14,
  BOARDCAST_LPV34: 0x23,
  LAN_EXT_STREAM: 0x40,
} as const;

export type TuyaLocalCommand = (typeof TUYA_LOCAL_CMD)[keyof typeof TUYA_LOCAL_CMD];

/** 涂鸦局域网 UDP 广播固定加密密钥: md5("yGAdlopoPVldABfn") */
export const TUYA_UDP_KEY_SEED = "yGAdlopoPVldABfn";
export const UDP_BROADCAST_KEY: Buffer = createHash("md5").update(TUYA_UDP_KEY_SEED).digest();

/** 主电源 DP 候选顺序（单路开关/灯具/电器） */
export const TUYA_POWER_DP_CANDIDATES = [
  "switch_led",
  "switch",
  "switch_1",
  "power",
  "Switch",
  "switch_go",
  "power_go",
] as const;

/** 常见涂鸦品类局域网默认 DP 编号 -> DP 代码映射（无云端规格时兜底） */
export const TUYA_DEFAULT_LOCAL_DPS_BY_CATEGORY: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  dj: {
    "20": "switch_led",
    "21": "work_mode",
    "22": "bright_value_v2",
    "23": "temp_value_v2",
    "24": "colour_data_v2",
  },
  dd: {
    "20": "switch_led",
    "21": "work_mode",
    "22": "bright_value_v2",
    "23": "temp_value_v2",
    "24": "colour_data_v2",
  },
  xdd: {
    "20": "switch_led",
    "21": "work_mode",
    "22": "bright_value_v2",
    "23": "temp_value_v2",
    "24": "colour_data_v2",
  },
  cz: {
    "1": "switch_1",
    "9": "countdown_1",
    "18": "cur_current",
    "19": "cur_power",
    "20": "cur_voltage",
  },
  pc: {
    "1": "switch_1",
    "2": "switch_2",
    "3": "switch_3",
    "4": "switch_4",
  },
  kg: {
    "1": "switch_1",
    "2": "switch_2",
    "3": "switch_3",
    "4": "switch_4",
  },
  kt: {
    "1": "switch",
    "2": "temp_set",
    "3": "temp_current",
    "4": "mode",
    "5": "fan_speed_enum",
  },
  cs: {
    "1": "switch",
    "2": "dehumidify_set_value",
    "4": "fan_speed_enum",
    "5": "mode",
    "6": "humidity_indoor",
    "103": "temp_indoor",
  },
  wsdcg: {
    "1": "va_temperature",
    "2": "va_humidity",
    "4": "battery_percentage",
  },
  cl: {
    "1": "control",
    "2": "percent_control",
    "3": "percent_state",
  },
};

/** 常见涂鸦 DP 代码 -> 中文属性名称 */
export const TUYA_DP_DESC_ZH: Readonly<Record<string, string>> = {
  on: "开关",
  switch: "开关",
  Switch: "开关",
  power: "开关",
  switch_led: "开关",
  switch_1: "开关 1",
  switch_2: "开关 2",
  switch_3: "开关 3",
  switch_4: "开关 4",
  switch_5: "开关 5",
  switch_6: "开关 6",
  switch_all: "总开关",
  switch_go: "启动/暂停",
  power_go: "清扫开关",
  brightness: "亮度",
  bright_value: "亮度",
  bright_value_v2: "亮度",
  "color-temperature": "色温",
  temp_value: "色温",
  temp_value_v2: "色温",
  color: "颜色",
  colour_data: "颜色",
  colour_data_v2: "颜色",
  work_mode: "工作模式",
  mode: "工作模式",
  scene_data: "情景模式",
  scene_data_v2: "情景模式",
  temp_set: "目标温度",
  temp_current: "当前温度",
  temp_current_f: "当前温度 (°F)",
  temp_indoor: "室内温度",
  va_temperature: "当前温度",
  indoor_temp: "室内温度",
  humidity_set: "目标湿度",
  dehumidify_set_value: "目标湿度",
  va_humidity: "当前湿度",
  humidity_value: "当前湿度",
  humidity_indoor: "当前湿度",
  humidity: "当前湿度",
  fan_speed_enum: "风速",
  fan_speed: "风速",
  windspeed: "风速",
  fan_speed_percent: "风速百分比",
  countdown: "倒计时",
  countdown_1: "开关 1 倒计时",
  countdown_2: "开关 2 倒计时",
  countdown_3: "开关 3 倒计时",
  countdown_4: "开关 4 倒计时",
  countdown_set: "定时关机",
  child_lock: "童锁",
  control: "窗帘控制",
  mach_operate: "窗帘控制",
  percent_control: "窗帘目标位置",
  percent_state: "窗帘当前位置",
  position: "窗帘位置",
  cur_power: "当前功率",
  cur_current: "当前电流",
  cur_voltage: "当前电压",
  add_ele: "累计用电量",
  battery_percentage: "电池电量",
  va_battery: "电池电量",
  battery_state: "电量状态",
  pm25: "PM2.5",
  pm25_value: "PM2.5",
  co2_value: "二氧化碳浓度",
  tvoc_value: "TVOC",
  ch2o_value: "甲醛浓度",
  anion: "负离子",
  uv: "紫外线杀菌",
  pump: "水泵",
  sleep: "睡眠模式",
  eco: "节能模式",
  dry: "干燥模式",
  swing: "摆风",
  switch_vertical: "上下摆风",
  switch_horizontal: "左右摆风",
  relay_status: "通电状态",
  light_mode: "指示灯模式",
  pir: "人体移动状态",
  doorcontact_state: "门窗状态",
  watersensor_state: "水浸状态",
  smoke_sensor_status: "烟雾状态",
  gas_sensor_status: "燃气状态",
  suction: "吸力档位",
  cistern: "水量档位",
  manual_feed: "手动出粮",
  feed_report: "出粮份数",
  tank_full: "水满提示",
  filter_life: "滤芯剩余寿命",
  filter_reset: "重置滤芯",
};

/** 常见涂鸦枚举值 -> 中文展示文案 */
export const TUYA_ENUM_DESC_ZH: Readonly<Record<string, string>> = {
  auto: "自动",
  cold: "制冷",
  cool: "制冷",
  hot: "制热",
  heat: "制热",
  wet: "除湿",
  dehumidify: "除湿",
  dry: "干衣",
  wind: "送风",
  fan: "送风",
  sleep: "睡眠",
  strong: "强力",
  eco: "节能",
  manual: "手动",
  low: "低",
  mid: "中",
  middle: "中",
  high: "高",
  max: "最大",
  mute: "静音",
  white: "白光",
  colour: "彩光",
  color: "彩光",
  scene: "情景",
  music: "音乐",
  open: "打开",
  close: "关闭",
  stop: "暂停",
  continue: "继续",
  on: "开启",
  off: "关闭",
  memory: "断电记忆",
  relay: "跟随开关",
  pos: "指示位置",
  none: "关闭指示灯",
  pir: "有人移动",
  normal: "正常",
  alarm: "告警",
  continuous: "连续除湿",
  smart: "智能模式",
  gentle: "轻柔",
  chargego: "回充",
  standby: "待机",
  cleaning: "清扫中",
};

/** 涂鸦红外遥控器标准按键代码 -> 中文展示文案（小写索引，大小写不敏感匹配） */
export const TUYA_IR_KEY_DESC_ZH: Readonly<Record<string, string>> = {
  power: "电源",
  poweron: "开机",
  power_on: "开机",
  poweroff: "关机",
  power_off: "关机",
  poweronoff: "电源开关",
  standby: "待机",
  "volume+": "音量+",
  "vol+": "音量+",
  volumeup: "音量+",
  volume_up: "音量+",
  "volume-": "音量-",
  "vol-": "音量-",
  volumedown: "音量-",
  volume_down: "音量-",
  mute: "静音",
  play: "播放",
  pause: "暂停",
  playpause: "播放/暂停",
  "play/pause": "播放/暂停",
  play_pause: "播放/暂停",
  stop: "停止",
  next: "下一首",
  nexttrack: "下一首",
  next_track: "下一首",
  previous: "上一首",
  prev: "上一首",
  previoustrack: "上一首",
  previous_track: "上一首",
  fastforward: "快进",
  ff: "快进",
  rewind: "快退",
  rew: "快退",
  "channel+": "频道+",
  "ch+": "频道+",
  channelup: "频道+",
  channel_up: "频道+",
  "channel-": "频道-",
  "ch-": "频道-",
  channeldown: "频道-",
  channel_down: "频道-",
  up: "上",
  down: "下",
  left: "左",
  right: "右",
  ok: "确认",
  enter: "确认",
  select: "确认",
  menu: "菜单",
  home: "主页",
  back: "返回",
  return: "返回",
  exit: "退出",
  source: "信号源",
  input: "输入源",
  signal: "信号源",
  mode: "模式",
  eq: "音效",
  soundmode: "音效模式",
  bt: "蓝牙",
  bluetooth: "蓝牙",
  aux: "AUX",
  optical: "光纤",
  coaxial: "同轴",
  hdmi: "HDMI",
  usb: "USB",
  av: "AV",
  "bass+": "低音+",
  "bass-": "低音-",
  "treble+": "高音+",
  "treble-": "高音-",
  sleep: "定时睡眠",
  timer: "定时",
  swing: "摆风",
  oscillate: "摇头",
  speed: "风速",
  fanspeed: "风速",
  windspeed: "风速",
  light: "灯光",
  lamp: "灯光",
  "-/--": "-/--",
};

export function tuyaIrKeyDescZh(code: string, fallback?: string): string {
  const trimmed = code.trim();
  const key = trimmed.toLowerCase();
  if (key in TUYA_IR_KEY_DESC_ZH) {
    return TUYA_IR_KEY_DESC_ZH[key]!;
  }
  if (/^[0-9]$/.test(trimmed)) {
    return trimmed;
  }
  if (fallback && fallback.trim() && fallback.trim() !== trimmed) {
    return fallback.trim();
  }
  return trimmed;
}

/** 涂鸦红外空调 (infrared_ac) M（模式）与 F（风速）标准数值映射（对齐 Tuya IR AC 规范） */
export const TUYA_IR_AC_MODE_LABELS: Readonly<Record<number, { description: string; desc_zh_cn: string }>> = {
  0: { description: "cool", desc_zh_cn: "制冷" },
  1: { description: "heat", desc_zh_cn: "制热" },
  2: { description: "auto", desc_zh_cn: "自动" },
  3: { description: "fan", desc_zh_cn: "送风" },
  4: { description: "dry", desc_zh_cn: "除湿" },
};

export const TUYA_IR_AC_FAN_LABELS: Readonly<Record<number, { description: string; desc_zh_cn: string }>> = {
  0: { description: "auto", desc_zh_cn: "自动" },
  1: { description: "low", desc_zh_cn: "低速" },
  2: { description: "medium", desc_zh_cn: "中速" },
  3: { description: "high", desc_zh_cn: "高速" },
};
