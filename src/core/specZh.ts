// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors
/**
 * MIoT 属性/动作名 → 中文兜底表。
 *
 * 上游 5.x 起中文描述取自 miot-spec.org 的 comment 字段，部分品类
 * （音箱、温湿度计等）官方数据缺该字段，界面会退化成纯英文。这里按
 * 属性/动作短名兜底补全：表的属性部分来自 4.x 时代 home.miot-spec.com
 * 已验证的中文翻译（当时按型号抓取时逐条提取），动作部分是标准 SI
 * 动作的直译。匹配与设备型号无关，同名标准属性在所有设备上共用翻译。
 *
 * 匹配两级：先精确匹配（如 on-2 是"按键"，与 on"开关"语义不同，
 * 必须分开），未命中再去掉尾部数字后缀重试（如 on-10 → on）。
 */

// 属性短名 -> 中文；键含数字后缀的是历史去重名，语义可能与基名不同
export const PROPERTY_ZH: Record<string, string> = {
  "volume": "音量",
  "mute-2": "静音",
  "mute-4": "静音",
  "playing-state": "播放状态",
  "text-content": "文本内容",
  "silent-execution": "指令静默执行",
  "sleep-mode": "睡眠模式",
  "audio-id": "音频ID",
  "download-speed": "下载速度",
  "upload-speed": "上传速度",
  "connected-device-number": "连接设备数",
  "network-connection-type": "上网方式",
  "ip-address": "IP地址",
  "status": "工作状态",
  "fault": "故障",
  "ppp-username": "拨号上网用户名",
  "ppp-encrypted-password": "拨号上网加密密码",
  "static-ip-address": "静态IP上网IP地址",
  "subnet-mask": "子网掩码",
  "gateway-ip-address": "网关IP地址",
  "dns-ip-address": "DNS服务地址",
  "dns-auto-mode": "DNS自动配置",
  "access-mode": "接入方式",
  "rssi": "信号强度",
  "wifi-band-combine": "WiFi双频合一",
  "online-time": "在线时长",
  "wifi-ssid-3": "WiFi网络名称",
  "wifi-encrypted-password-3": "WiFi网络加密密码",
  "on-3": "开关",
  "wifi-ssid-hidden": "隐藏WiFi",
  "encrypted-strength-3": "加密强度",
  "signal-strength-3": "发射信号强度",
  "wifi-channel-3": "WiFi网络信道",
  "wifi-bandwidth-3": "WiFi信道带宽",
  "on-4": "开关",
  "wifi-ssid-4": "WiFi网络名称",
  "wifi-encrypted-password-4": "WiFi网络加密密码",
  "encrypted-strength-4": "加密强度",
  "signal-strength-4": "发射信号强度",
  "wifi-channel-4": "WiFi网络信道",
  "wifi-bandwidth-4": "WiFi信道带宽",
  "speed-control": "限速控制",
  "max-upload-speed": "最大上传速度",
  "max-download-speed": "最大下载速度",
  "on-5": "开关",
  "mode": "模式",
  "brightness": "亮度",
  "color": "颜色",
  "color-temperature": "色温",
  "flow": "流光功能",
  "saturability": "饱和度",
  "on": "开关",
  "default-power-on-state": "默认上电状态",
  "save-state": "恢复断电前灯光",
  "delay-time": "延时时间",
  "delay-off-countdown": "延时关灯倒计时",
  "delay-off-enable": "延时关灯功能开关",
  "kid-mode": "儿童模式控制开关",
  "double-click-enable": "自定义双击功能开关",
  "double-click": "定义双击触发的功能",
  "scene-mode": "切换灯上的模式",
  "pomodoro-enable": "专注模式开关",
  "work-minutes": "专注模式的工作时间",
  "break-minutes": "专注模式休息时间",
  "work-countdown-sec": "工作结束倒计时",
  "break-countdown-sec": "休息时间倒计时",
  "mode-one-bright": "模式1的亮度",
  "mode-one-ct": "模式1的色温",
  "mode-two-bright": "模式2亮度",
  "mode-two-ct": "模式2的色温",
  "mode-three-bright": "模式3的亮度",
  "mode-three-ct": "模式3的色温",
  "mode-four-bright": "模式4的亮度",
  "mode-four-ct": "模式4的色温",
  "double-click-mode": "双击启动的模式",
  "eco": "背光开关",
  "off-delay": "点动功能",
  "toggle": "切换",
  "temperature": "温度",
  "relative-humidity": "湿度",
  "battery-level": "电池电量",
  "on-2": "按键",
  "on-10": "开关",
  "version": "设备版本号",
  "mode-2": "模式",
  "anti-flicker": "防闪烁模式",
  "wiring-method": "接线方式",
  "mode-3": "模式",
  "mode-4": "模式",
  "mode-5": "模式",
  "power-consumption": "功耗参数",
  "electric-power": "电功率",
  "power-consumption-accumulation-way": "耗电量使用累加形式",
  "on-7": "开关",
  "pm2.5-density": "PM2.5 浓度",
  "pm10-density": "PM10 浓度",
  "co2-density": "二氧化碳浓度",
  "tvoc-density": "TVOC 浓度",
  "hcho-density": "甲醛浓度",
  "air-quality": "空气质量",
  "filter-life-level": "滤芯剩余寿命",
  "filter-used-time": "滤芯已使用时间",
  "filter-left-time": "滤芯剩余时间",
  "alarm": "提示音",
  "physical-controls-locked": "童锁",
  "fan-level": "风速档位",
  "favorite-level": "最爱风速",
  "anion": "负离子",
  "uv": "紫外线杀菌",
  "target-humidity": "目标湿度",
  "target-temperature": "目标温度",
  "water-level": "水位",
  "dry": "烘干模式",
  "horizontal-swing": "左右摆风",
  "vertical-swing": "上下摆风",
  "horizontal-angle": "左右摆风角度",
  "vertical-angle": "上下摆风角度",
  "pet-food-left-level": "宠物粮余量",
  "feeding-measure": "出粮份数",
  "feeding-type": "出粮方式",
  "desiccant-left-level": "干燥剂剩余",
  "desiccant-left-time": "干燥剂剩余天数",
  "plan-ctrl": "定时喂食计划",
  "feed-plan": "喂食计划",
  "skiped-plan": "今日跳过计划",
  "ringtone": "铃声",
  "play-loop-mode": "播放循环模式",
  "seek-time": "播放进度偏移",
  "motor-control": "电机控制",
  "current-position": "当前位置",
  "target-position": "目标位置",
  "door-state": "门状态",
  "lock-state": "门锁状态",
  "night-shot": "夜视模式",
  "motion-detection": "移动侦测",
  "motion-tracking": "移动追踪",
  "image-rollover": "画面翻转",
  "wdr-mode": "宽动态范围",
  "time-watermark": "时间水印",
  "storage-total-space": "存储卡总容量",
  "storage-free-space": "存储卡剩余容量",
  "storage-used-space": "存储卡已用容量",
  "left-time": "剩余时间",
  "eco-mode": "节能模式",
  "heater": "电辅热",
  "suction-level": "吸力档位",
  "sweep-type": "清扫模式",
  "humidity": "湿度",
  "illumination": "光照度",
  "occupancy": "有人状态",
  "contact-state": "开关门状态",
  "submersion-state": "浸水状态",
  "smoke-concentration": "烟雾浓度",
  "gas-concentration": "燃气浓度",
  "control-status": "启停控制",
  "running-status": "运行状态",
  "progress": "当前阶段",
  "remain-time": "剩余时间",
  "program": "洗涤程序",
  "drum-location": "当前操作筒",
  "dehydration-speed": "脱水转速",
  "rinse-count": "漂洗次数",
  "wash-level": "洗涤水位",
  "rinse-level": "漂洗水位",
  "wash-strength": "洗涤力度",
  "wash-time": "主洗时长",
  "soak-time": "浸泡时长",
  "dehydration-time": "脱水时长",
  "dry-mode": "烘干模式",
  "detergent": "洗衣液投放",
  "softener": "柔顺剂投放",
  "child-lock": "童锁",
  "steam-wash": "蒸汽除菌洗",
  "nightly-wash": "夜间静音洗",
  "fast-clean-wash": "加速洗",
  "beforehand-wash": "预洗",
  "super-clean-wash": "特渍强洗",
  "cycle-memory": "程序记忆",
  "stains": "特渍类型",
  "fresh-air-time": "新风祛味时长",
  "appointment-time": "预约完成时间",
  "voice-dnd": "语音免打扰",
  "door-opened": "舱门开启",
  "detergent-lack": "洗衣液不足",
  "softener-lack": "柔顺剂不足",
  "water-overheating": "水温过热告警",
  "drying-tunnel-overheating": "风道过热告警",
  "remote-control-flag": "远程控制权限",
  "error-code": "故障代码",
};

// 动作短名 -> 中文
export const ACTION_ZH: Record<string, string> = {
  "play": "播放",
  "pause": "暂停",
  "stop": "停止",
  "seek": "调整进度",
  "next": "下一首",
  "previous": "上一首",
  "play-text": "朗读文本",
  "play-music": "播放音乐",
  "play-radio": "播放电台",
  "execute-text-directive": "执行文本指令",
  "stop-alarm": "停止闹钟",
  "wake-up": "唤醒",
  "toggle": "切换",
  "toggle-mode": "切换模式",
  "turn-on": "开启",
  "turn-off": "关闭",
  "reboot": "重启",
  "set-default": "恢复默认",
  "apply-scene": "应用场景",
  "bright-circle": "亮度循环",
  "bright-increase": "调高亮度",
  "bright-decrease": "调低亮度",
  "bright-on-circle": "亮度循环开关",
  "ct-circle": "色温循环",
  "ct-increase": "调高色温",
  "ct-decrease": "调低色温",
  "ct-on-circle": "色温循环开关",
  "delay-off": "延时关灯",
  "fan-speed-up": "风速调高",
  "fan-speed-down": "风速调低",
  "temperature-up": "温度调高",
  "temperature-down": "温度调低",
  "reset-filter-life": "重置滤芯寿命",
  "reset-desiccant-life": "重置干燥剂寿命",
  "pet-food-out": "立即出粮",
  "weigh-manual-calibrate": "称重校准",
  "update": "更新喂食计划",
  "del": "删除喂食计划",
  "skip": "跳过今日计划",
  "re-open": "恢复今日计划",
  "start-sweep": "开始清扫",
  "stop-sweeping": "停止清扫",
  "start-charge": "返回充电",
  "identify": "查找设备",
  "format": "格式化存储卡",
  "pop-up": "弹出存储卡",
  "start-wash": "开始洗涤",
  "pause-wash": "暂停洗涤",
  "cancel-appointment": "取消预约",
};

// MIoT 服务短名 -> 中文分组标题
export const SERVICE_ZH: Record<string, string> = {
  "light": "灯光控制",
  "switch": "开关控制",
  "outlet": "插座控制",
  "air-purifier": "空气净化",
  "air-conditioner": "空调控制",
  "environment": "环境监测",
  "filter": "滤芯状态",
  "indicator-light": "指示灯",
  "alarm": "提示音",
  "physical-controls-locked": "物理童锁",
  "fan": "风扇控制",
  "humidifier": "加湿控制",
  "dehumidifier": "除湿控制",
  "heater": "取暖控制",
  "pet-feeder": "宠物喂食",
  "feed-plan": "喂食计划",
  "desiccant": "干燥剂",
  "battery": "电池电源",
  "speaker": "扬声器",
  "play-control": "播放控制",
  "microphone": "麦克风",
  "intelligent-speaker": "小爱语音",
  "clock": "闹钟提醒",
  "router": "路由网络",
  "wifi": "Wi-Fi 设置",
  "camera-control": "摄像机控制",
  "memory-card-management": "存储卡",
  "curtain": "窗帘控制",
  "television": "电视控制",
  "lock": "门锁状态",
  "washer": "洗衣机",
  "washer-status": "洗衣机控制",
  "washer-drum": "多筒管理",
  "washer-params": "洗涤参数",
  "washer-options": "附加功能",
  "washer-alerts": "耗材与安全",
  "vacuum": "扫地机",
  "screen": "屏幕显示",
  "power-consumption": "电量统计",
  "temperature-humidity-sensor": "温湿度监测",
  "motion-sensor": "人体感应",
  "magnet-sensor": "门窗感应",
};

export const UNIT_ZH: Record<string, string> = {
  "percentage": "%",
  "celsius": "°C",
  "fahrenheit": "°F",
  "kelvin": "K",
  "seconds": "秒",
  "minutes": "分钟",
  "hours": "小时",
  "days": "天",
  "watt": "W",
  "kwh": "kWh",
  "lux": "lx",
  "μg/m3": "μg/m³",
  "ug/m3": "μg/m³",
  "mg/m3": "mg/m³",
  "ppm": "ppm",
  "arcdegrees": "°",
  "rpm": "RPM",
  "db": "dB",
  "dbm": "dBm",
  "pascal": "Pa",
  "rgb": "",
};

const SENSITIVE_PROP_RE = /(?:password|passwd|secret|token|private[-_]?key)/i;
const DEBUG_PROP_RE = /(?:^|[-_])(dbg|debug)(?:$|[-_])|^moto-speed-rpm$/i;
const DANGEROUS_ACTION_RE =
  /^(?:reboot|reset[-_].+|set[-_]default|restore|factory[-_]reset|format|del|delete)$/i;

const NUM_SUFFIX_RE = /-\d+$/;
const CJK_RE = /[\u4e00-\u9fff]/;

function hasCjk(text: string): boolean {
  return CJK_RE.test(text);
}

/** 按名查中文：先精确匹配，未中再去掉尾部数字后缀重试。 */
export function lookupZh(name: string, table: Record<string, string>): string | null {
  if (Object.hasOwn(table, name)) {
    return table[name];
  }
  const stripped = name.replace(NUM_SUFFIX_RE, "");
  if (stripped !== name && Object.hasOwn(table, stripped)) {
    return table[stripped];
  }
  return null;
}

/**
 * 补一条描述的中文；已有中文、空描述或表未覆盖时原样返回。
 *
 * 描述统一为「英文 / 中文」格式，与上游数据格式保持一致，界面层
 * 无需感知来源。deviceDetail 的对象路径与 spec dict 路径共用它。
 */
export function backfillDescription(
  name: string,
  desc: string,
  table: Record<string, string>,
): string {
  const normalizedDesc = desc || "";
  if (hasCjk(normalizedDesc)) {
    return normalizedDesc;
  }
  const zh = lookupZh(name, table);
  if (!zh) {
    return normalizedDesc;
  }
  return normalizedDesc ? `${normalizedDesc} / ${zh}` : zh;
}

export function propDescZh(name: string, desc: string): string {
  return backfillDescription(name, desc, PROPERTY_ZH);
}

export function actionDescZh(name: string, desc: string): string {
  return backfillDescription(name, desc, ACTION_ZH);
}

export function serviceDescZh(name: string, desc: string): string {
  const zh = lookupZh(name, SERVICE_ZH);
  if (zh) {
    return zh;
  }
  const cleaned = (desc || "").trim();
  if (cleaned) {
    const slashParts = cleaned.split("/").map((p) => p.trim()).filter(Boolean);
    const cjkPart = slashParts.find((p) => hasCjk(p));
    if (cjkPart) {
      return cjkPart;
    }
    return cleaned;
  }
  return name;
}

export function unitLabelZh(unit: string | null | undefined): string {
  if (!unit) {
    return "";
  }
  const trimmed = unit.trim();
  if (!trimmed || trimmed.toLowerCase() === "none") {
    return "";
  }
  const mapped = UNIT_ZH[trimmed.toLowerCase()];
  return mapped !== undefined ? mapped : trimmed;
}

export function isSensitivePropertyName(name: string): boolean {
  return SENSITIVE_PROP_RE.test(name);
}

export function isDebugProperty(name: string, desc = ""): boolean {
  if (DEBUG_PROP_RE.test(name)) {
    return true;
  }
  return desc.includes("调试使用") || desc.includes("不对用户开放") || desc.includes("调试");
}

export function isDangerousAction(name: string): boolean {
  return DANGEROUS_ACTION_RE.test(name.replaceAll("_", "-"));
}

export interface SpecFallbackItem {
  name?: string;
  description?: string;
}

export interface SpecFallbackInfo {
  properties?: SpecFallbackItem[];
  actions?: SpecFallbackItem[];
}

/** 就地补齐 spec dict 中缺中文的描述（specsFor 内存缓存路径）。 */
export function applyFallback(info: SpecFallbackInfo): void {
  for (const item of info.properties ?? []) {
    item.description = propDescZh(String(item.name || ""), String(item.description || ""));
  }
  for (const item of info.actions ?? []) {
    item.description = actionDescZh(String(item.name || ""), String(item.description || ""));
  }
}
