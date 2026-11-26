// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * 注册到内置 Pi Agent (@earendil-works/pi-agent-core) 的米家智能家居工具集。
 * 所有工具通过真实的 IMijiaService + JobExecutor 执行设备控制并实时同步回主窗口和 WebSocket。
 */

import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { arr, bool, num, obj, oneOf, opt, str, unknown } from "@earendil-works/pi-schema";
import { speakerHint } from "../core/availability.ts";
import type { IJobExecutor, IMijiaService } from "../core/contracts.ts";
import {
  isCamera,
  isLight,
  isSwitch,
  lightControls,
  supportsCardPower,
} from "../core/deviceControls.ts";
import {
  coercePropWriteValue,
  deviceCategoryLabel,
  formatWasherCardMetrics,
  isWasherDevice,
  resolveEnumLabel,
} from "../core/deviceDetailModel.ts";
import { SCENES_FEATURE_ENABLED } from "../core/featureFlags.ts";
import { JobExecutor } from "../core/jobs.ts";
import {
  createSceneInfo,
  isSpeaker,
  type ActionInfo,
  type DeviceInfo,
  type PropInfo,
  type SceneInfo,
} from "../core/models.ts";
import { formatMetricsText, ServiceError } from "../core/service.ts";
import type * as settingsStoreModule from "../core/settingsStore.ts";
import { isDangerousAction, isSensitivePropertyName } from "../core/specZh.ts";
import { isMultiPlatformService } from "../platforms/index.ts";
import type { MainWindowController } from "../ui/controllers/mainWindowController.ts";
import {
  addCustomInstruction,
  clearCustomInstructions,
  deleteCustomInstruction,
  deleteCustomInstructionsByQuery,
  deleteLatestCustomInstruction,
  detectCustomInstructionConflicts,
  loadCustomInstructions,
  type CustomInstructionSource,
} from "./customInstructionStore.ts";
import {
  buildHomeCapabilityDigest,
  canonicalizeImplicitIntent,
  probeImplicitCapabilities,
  type HomeCapabilityDigest,
} from "./intentCanonicalizer.ts";
import {
  clearReinforcementMemories,
  computeRetention,
  computeUiTrustStage,
  deleteReinforcementMemory,
  evaluateReinforcementGate,
  findMatchingReinforcementMemory,
  getReinforcementNow,
  listReinforcementMemories,
  resetReinforcementMemory,
  type MemoryActionBinding,
  type PendingConfirmation,
  type PendingConfirmationOrigin,
} from "./reinforcementMemoryStore.ts";
import {
  classifyActionRisk,
  computeActionFingerprint,
  probeWasherRuntimeSafety,
  resolveSpeakerPrincipal,
  type RiskLevel,
  type SafetyConfirmationRegistry,
  type SpeakerPrincipal,
} from "./safetyGate.ts";

const PLATFORM_LABELS_ZH: Readonly<Record<string, string>> = {
  mijia: "米家",
  tuya: "涂鸦",
  midea: "美的",
  deye: "德业",
};

function devicePlatformId(device: Pick<DeviceInfo, "did" | "platform">): string {
  if (device.platform) return device.platform;
  if (device.did.startsWith("tuya:")) return "tuya";
  if (device.did.startsWith("midea:")) return "midea";
  if (device.did.startsWith("deye:")) return "deye";
  return "mijia";
}

export interface SmartHomeToolDeps {
  service: IMijiaService;
  jobs: IJobExecutor;
  mainWindow: MainWindowController;
  settingsStore: typeof settingsStoreModule;
  broadcastState: () => void;
  getActivePromptSource?: () => "text" | "voice";
  getActivePromptRawText?: () => string;
  onCustomInstructionsChanged?: () => void;
  /** 宿主独占的安全确认票据表（PiAgentService 自动注入；单元测试直调时省略保持向后兼容） */
  safetyConfirmRegistry?: SafetyConfirmationRegistry;
  /** 返回当前请求说话人身份与权限 */
  getActiveSpeakerPrincipal?: () => SpeakerPrincipal;
  /** 返回当前家庭设备能力摘要 */
  getCapabilityDigest?: () => HomeCapabilityDigest;
  /** 由大模型工具发起结构化待确认提问 */
  openPendingConfirmation?: (
    input: Omit<PendingConfirmation, "id" | "createdAt" | "expiresAt" | "promptEndedAt" | "consumed">,
  ) => PendingConfirmation;
  /** 强化记忆变更回调 */
  onMemoriesChanged?: () => void;
  /** 可注入时钟 */
  now?: () => number;
}

function runJob<T>(jobs: IJobExecutor, fn: () => T | Promise<T>, priority = 1): Promise<T> {
  if (jobs instanceof JobExecutor && jobs.isClosed) {
    return Promise.reject(new ServiceError("后台任务执行器已关闭"));
  }
  return new Promise<T>((resolve, reject) => {
    jobs.submit(fn, {
      priority,
      onSuccess: (res) => resolve(res),
      onError: (err) => reject(err),
    });
  });
}

function textResult<T = Record<string, unknown>>(
  text: string,
  details: T,
  isError = false,
): AgentToolResult<T> {
  return {
    content: [{ type: "text", text }],
    details,
    ...(isError ? { isError: true } : {}),
  };
}

function normalizeQuery(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[的\s\-_·.,，。！？!?“”"'`（）()]/g, "");
}

function isIrAudioDevice(device: Pick<DeviceInfo, "model" | "spec_type">): boolean {
  if (isSpeaker(device)) return false;
  const m = (device.model ?? "").toLowerCase();
  const st = (device.spec_type ?? "").toLowerCase();
  return (
    m.includes("infrared_amplifier") ||
    m.includes("infrared_audio") ||
    m.includes("infrared_soundbar") ||
    st.includes(":device:amplifier:")
  );
}

function deviceMatchesCategory(device: DeviceInfo, category: string): boolean {
  const cat = category.trim().toLowerCase();
  if (!cat || cat === "all" || cat === "全部") {
    return true;
  }
  if (cat === "light" || cat === "灯" || cat === "灯光" || cat === "照明") {
    if (isLight(device)) return true;
    // 多路开关子路名称含“灯”时（如餐厅主灯、吧台射灯、餐边灯带）也归类为灯光控制目标
    if (device.switch_channels.length === 0 && /灯/.test(device.name)) {
      return true;
    }
    return false;
  }
  if (cat === "switch" || cat === "开关" || cat === "插座") {
    return isSwitch(device) || device.model.includes("plug") || device.model.includes("outlet");
  }
  if (cat === "sensor" || cat === "传感器" || cat === "温湿度") {
    return (
      (Array.isArray(device.metric_features) && device.metric_features.length > 0) ||
      device.model.includes("sensor") ||
      device.spec_type.includes("sensor")
    );
  }
  if (cat === "小爱") {
    return isSpeaker(device);
  }
  if (cat === "speaker" || cat === "音箱" || cat === "音响") {
    return isSpeaker(device) || isIrAudioDevice(device);
  }
  if (cat === "camera" || cat === "摄像头" || cat === "摄像机") {
    return isCamera(device);
  }
  if (cat === "feeder" || cat === "喂食器") {
    return device.model.includes("feeder") || device.spec_type.includes("feeder") || device.name.includes("喂食");
  }
  if (cat === "ac" || cat === "air-conditioner" || cat === "空调") {
    return (
      device.model.includes("air-conditioner") ||
      device.model.includes("aircondition") ||
      device.spec_type.includes("air-conditioner") ||
      device.name.includes("空调")
    );
  }
  if (cat === "dehumidifier" || cat === "除湿机") {
    return (
      device.model.includes("dehumidifier") ||
      device.spec_type.includes("dehumidifier") ||
      device.name.includes("除湿")
    );
  }
  if (cat === "washer" || cat === "washing-machine" || cat === "洗衣机" || cat === "洗烘") {
    return (
      isWasherDevice(device) ||
      device.name.includes("洗衣") ||
      device.name.includes("洗烘")
    );
  }
  if (cat === "dryer" || cat === "干衣机" || cat === "烘干机") {
    const s = `${device.name} ${device.model} ${device.spec_type}`.toLowerCase();
    return /dryer|干衣机|烘干机|0xdc/.test(s);
  }
  if (cat === "vacuum" || cat === "扫地机" || cat === "扫地机器人" || cat === "拖地") {
    const s = `${device.name} ${device.model} ${device.spec_type}`.toLowerCase();
    return /vacuum|扫地|拖地|扫拖/.test(s);
  }
  if (cat === "irrigation" || cat === "灌溉" || cat === "浇花" || cat === "水阀") {
    const s = `${device.name} ${device.model} ${device.spec_type}`.toLowerCase();
    return /irrigation|valve|灌溉|浇花|浇水|水阀/.test(s);
  }
  if (cat === "inverter" || cat === "solar-inverter" || cat === "逆变器" || cat === "光伏") {
    return (
      device.model.includes("inverter") ||
      device.spec_type.includes("inverter") ||
      device.name.includes("逆变") ||
      device.name.includes("光伏")
    );
  }
  if (cat === "appliance" || cat === "家电") {
    return supportsCardPower(device) && !isLight(device) && !isSwitch(device);
  }
  return deviceCategoryLabel(device).toLowerCase().includes(cat);
}

const COMMON_ROOM_KEYWORDS: readonly string[] = [
  "儿童房",
  "老人房",
  "衣帽间",
  "卫生间",
  "洗手间",
  "客厅",
  "主卧",
  "次卧",
  "卧室",
  "餐厅",
  "书房",
  "厨房",
  "阳台",
  "浴室",
  "厕所",
  "走廊",
  "过道",
  "玄关",
  "门厅",
  "车库",
];

function extractRoomHint(normTarget: string, devices: readonly DeviceInfo[]): string | null {
  const knownRooms = [
    ...new Set(
      devices
        .map((d) => normalizeQuery(d.room_name))
        .filter((r) => r.length > 0 && r !== "未知" && r !== "未分配" && r !== "未分配房间"),
    ),
  ].sort((a, b) => b.length - a.length);
  for (const room of knownRooms) {
    if (normTarget.includes(room)) return room;
  }
  for (const room of COMMON_ROOM_KEYWORDS) {
    if (normTarget.includes(room)) return room;
  }
  return null;
}

/**
 * 按 did / 名称 / 房间 / 类别灵活解析目标设备（支持单个精确匹配与多设备筛选）。
 */
export function resolveDevices(
  devices: readonly DeviceInfo[],
  options: { target?: string; room?: string; category?: string; controllableOnly?: boolean } = {},
): DeviceInfo[] {
  const roomFilter = options.room?.trim() ?? "";
  const category = options.category?.trim() ?? "";
  const target = options.target?.trim() ?? "";

  let pool = [...devices];
  if (roomFilter && roomFilter !== "全屋" && roomFilter !== "全部") {
    const normRoom = normalizeQuery(roomFilter);
    pool = pool.filter((d) => {
      const dr = normalizeQuery(d.room_name);
      return dr === normRoom || dr.includes(normRoom) || normRoom.includes(dr);
    });
  }

  if (category && category !== "all" && category !== "全部") {
    pool = pool.filter((d) => deviceMatchesCategory(d, category));
  }

  if (options.controllableOnly) {
    pool = pool.filter(
      (d) =>
        d.switch_channels.length === 0 &&
        (supportsCardPower(d) || isCamera(d)),
    );
  }

  if (!target) {
    return pool;
  }

  // 1. 精确 did 匹配
  const byDid = pool.find((d) => d.did === target);
  if (byDid) return [byDid];

  // 2. 精确名称匹配
  const normTarget = normalizeQuery(target);
  const exactName = pool.filter((d) => normalizeQuery(d.name) === normTarget);
  if (exactName.length > 0) return exactName;

  // 3. 批量关键词（全部/所有灯/房间全部设备）
  const isAllLights = /^(全部|所有|全屋)?(灯光?|电灯|照明)$/.test(normTarget);
  if (isAllLights) {
    return pool.filter((d) => deviceMatchesCategory(d, "light"));
  }
  if (/^(全部|所有|全屋)(设备|开关|电器)?$/.test(normTarget)) {
    return pool;
  }

  // 4. “房间名 + 设备关键词” 组合匹配（如“客厅吸顶灯”、“客厅的灯”、“餐厅所有灯”）
  const targetRoomHint = extractRoomHint(normTarget, devices);
  const scored: Array<{ device: DeviceInfo; score: number }> = [];
  for (const d of pool) {
    const dName = normalizeQuery(d.name);
    const dRoom = normalizeQuery(d.room_name);
    const dCat = normalizeQuery(deviceCategoryLabel(d));
    const combined = `${dRoom}${dName}`;
    let score = 0;

    const roomHit = dRoom.length > 0 && dRoom !== "未知" && dRoom !== "未分配" && normTarget.includes(dRoom);
    const hasConflictingRoom = Boolean(
      targetRoomHint &&
        !roomHit &&
        !dName.includes(targetRoomHint) &&
        !(dRoom && (dRoom.includes(targetRoomHint) || targetRoomHint.includes(dRoom))),
    );

    if (combined === normTarget) {
      score = 100;
    } else if (!hasConflictingRoom && /(小米|小爱)/.test(normTarget) && isSpeaker(d) && /(音箱|音响|小爱)/.test(normTarget)) {
      score = 92;
    } else if (!hasConflictingRoom && dName.includes(normTarget)) {
      score = 85;
    } else if (!hasConflictingRoom && normTarget.includes(dName) && dName.length >= 2) {
      score = 80;
    } else {
      const rest = roomHit
        ? normTarget.replace(dRoom, "").replace(/^(?:里面|里边|里头|里|中|内)?(?:所有|全部)?/, "")
        : normTarget;
      const lightHit =
        /^(?:灯|灯光|电灯|照明|吸顶灯|吊灯|主灯|台灯|落地灯|射灯|灯带|壁灯|夜灯|筒灯)$/.test(rest) &&
        deviceMatchesCategory(d, "light");
      const speakerHit =
        (rest.includes("音箱") || rest.includes("小爱") || rest.includes("音响")) && isSpeaker(d);
      const sensorHit =
        (rest.includes("温度") || rest.includes("湿度") || rest.includes("温湿度") || rest.includes("传感器")) &&
        deviceMatchesCategory(d, "sensor");
      const feederHit =
        (rest.includes("喂食") || rest.includes("猫粮") || rest.includes("狗粮") || rest.includes("宠粮")) &&
        deviceMatchesCategory(d, "feeder");
      const cameraHit =
        (rest.includes("摄像") || rest.includes("监控") || rest.includes("相机")) && isCamera(d);
      const washerHit =
        (rest.includes("洗衣") ||
          rest.includes("洗烘") ||
          rest.includes("滚筒") ||
          rest.includes("波轮") ||
          rest.includes("可爱多")) &&
        deviceMatchesCategory(d, "washer");

      if (
        roomHit &&
        (!rest || rest === "设备" || lightHit || speakerHit || sensorHit || feederHit || cameraHit || washerHit)
      ) {
        score = 75;
      } else if (roomHit && rest.length >= 1 && dName.includes(rest)) {
        score = 82;
      } else if (
        !roomHit &&
        !hasConflictingRoom &&
        (lightHit || speakerHit || sensorHit || feederHit || cameraHit || washerHit)
      ) {
        score = 65;
      } else if (!hasConflictingRoom && dCat && (dCat.includes(normTarget) || normTarget.includes(dCat))) {
        score = 60;
      }
    }

    if (score > 0) {
      scored.push({ device: d, score });
    }
  }

  if (scored.length === 0) {
    return [];
  }

  scored.sort((a, b) => b.score - a.score);
  const topScore = scored[0]!.score;
  // 若有高分精确/子串命中且明显优于其他候选，则只返回高分组；若是同类批量（如“餐厅所有灯”）返回同分项
  if (topScore >= 80) {
    return scored.filter((s) => s.score >= topScore - 5).map((s) => s.device);
  }
  return scored.filter((s) => s.score === topScore).map((s) => s.device);
}

function resolveSingleDevice(devices: readonly DeviceInfo[], target: string): DeviceInfo | null {
  const matched = resolveDevices(devices, { target });
  if (matched.length === 0) return null;
  // 优先在线设备
  return matched.find((d) => d.online) ?? matched[0] ?? null;
}

/**
 * 带跨家庭/同名在线设备歧义检测的单设备解析：
 * 当 target 不是精确 did 且存在多台同名在线设备位于不同家庭/房间时，显式返回 ambiguous 候选供消歧，避免静默误控另一套房子的同名设备。
 */
function resolveSingleDeviceChecked(
  devices: readonly DeviceInfo[],
  target: string,
): { device: DeviceInfo | null; ambiguous: DeviceInfo[] } {
  const trimmed = target.trim();
  const exactDid = devices.find((d) => d.did === trimmed);
  if (exactDid) {
    return { device: exactDid, ambiguous: [] };
  }
  const matched = resolveDevices(devices, { target: trimmed });
  if (matched.length === 0) {
    return { device: null, ambiguous: [] };
  }
  const onlineMatched = matched.filter((d) => d.online);
  if (onlineMatched.length > 1) {
    const normTarget = normalizeQuery(trimmed);
    // 若目标明确包含某个家庭名，优先收窄到该家庭
    const homeFiltered = onlineMatched.filter(
      (d) => d.home_name && normTarget.includes(normalizeQuery(d.home_name)),
    );
    if (homeFiltered.length === 1) {
      return { device: homeFiltered[0]!, ambiguous: [] };
    }
    const distinctHomes = new Set(onlineMatched.map((d) => d.home_name || ""));
    const distinctRooms = new Set(onlineMatched.map((d) => `${d.home_name || ""}/${d.room_name || ""}`));
    if (distinctHomes.size > 1 || distinctRooms.size > 1) {
      return { device: null, ambiguous: onlineMatched };
    }
  }
  return { device: onlineMatched[0] ?? matched[0] ?? null, ambiguous: [] };
}

function findPowerProp(props: readonly PropInfo[]): PropInfo | null {
  return (
    props.find(
      (p) =>
        p.type === "bool" &&
        p.writable &&
        (p.name === "on" || p.name.startsWith("on-") || p.name.startsWith("on_")),
    ) ?? null
  );
}

const NAMED_COLORS: Readonly<Record<string, number>> = {
  红: 0xff3b30,
  红色: 0xff3b30,
  red: 0xff3b30,
  橙: 0xff9500,
  橙色: 0xff9500,
  橘色: 0xff9500,
  orange: 0xff9500,
  黄: 0xffcc00,
  黄色: 0xffcc00,
  暖黄: 0xffb86c,
  yellow: 0xffcc00,
  绿: 0x34c759,
  绿色: 0x34c759,
  green: 0x34c759,
  青: 0x00c7be,
  青色: 0x00c7be,
  cyan: 0x00c7be,
  蓝: 0x007aff,
  蓝色: 0x007aff,
  blue: 0x007aff,
  紫: 0xaf52de,
  紫色: 0xaf52de,
  purple: 0xaf52de,
  粉: 0xff2d55,
  粉色: 0xff2d55,
  pink: 0xff2d55,
  白: 0xffffff,
  白色: 0xffffff,
  white: 0xffffff,
  暖白: 0xffe4b5,
  冷白: 0xe6f2ff,
};

export function parseColorToRgbInt(raw: string): number | null {
  const cleaned = raw.trim().toLowerCase();
  if (!cleaned) return null;
  if (cleaned in NAMED_COLORS) {
    return NAMED_COLORS[cleaned]!;
  }
  const hexMatch = /^#?([0-9a-f]{6})$/i.exec(cleaned);
  if (hexMatch) {
    return Number.parseInt(hexMatch[1]!, 16) & 0xffffff;
  }
  return null;
}

function clampToPropRange(prop: PropInfo, value: number): number {
  let out = value;
  if (prop.range && prop.range.length >= 2) {
    const [low, high, step] = prop.range;
    out = Math.max(low, Math.min(high, out));
    if (step && step > 0) {
      out = low + Math.round((out - low) / step) * step;
      out = Math.max(low, Math.min(high, out));
    }
  }
  return prop.type === "float" ? Number(out.toFixed(2)) : Math.round(out);
}

function formatDeviceSummary(d: DeviceInfo, mw: MainWindowController): Record<string, unknown> {
  const power = mw.knownPower[d.did];
  const metric = mw.metrics[d.did];
  const platform = devicePlatformId(d);
  return {
    did: d.did,
    name: d.name,
    platform,
    platform_name: PLATFORM_LABELS_ZH[platform] ?? platform,
    room: d.room_name || "未分配房间",
    home: d.home_name || "",
    category: deviceCategoryLabel(d),
    model: d.model,
    online: d.online,
    power: typeof power === "boolean" ? (power ? "on" : "off") : null,
    metrics: metric ?? null,
    light_features: d.light_features,
    switch_channels: d.switch_channels,
  };
}

function ensureAccessReady(deps: SmartHomeToolDeps): string | null {
  const state = deps.mainWindow.accessState();
  if (state === "offline" || state === "unavailable") {
    return "当前网络不可用，无法连接米家设备服务。";
  }
  if (state === "signed_out") {
    return "尚未登录小米账号，请先在 MijiaDeck 中扫码登录后再控制设备。";
  }
  return null;
}

function findSpeakerAudioProps(props: readonly PropInfo[]): {
  volumeProp: PropInfo | null;
  speakerMuteProp: PropInfo | null;
  micMuteProp: PropInfo | null;
} {
  const volumeProp =
    props.find((p) => p.name === "volume" && p.writable) ??
    props.find((p) => p.name.startsWith("volume") && p.writable) ??
    null;

  const speakerMuteProp =
    props.find((p) => p.service === "speaker" && p.name.startsWith("mute") && p.writable) ??
    props.find((p) => p.name === "mute-2" && p.writable) ??
    props.find((p) => p.name === "mute" && p.writable) ??
    props.find((p) => p.name.startsWith("mute") && p.writable && p.name !== "mute-4") ??
    null;

  const micMuteProp =
    props.find((p) => p.service === "microphone" && p.name.startsWith("mute") && p.writable) ??
    props.find((p) => p.name === "mute-4" && p.writable) ??
    null;

  return { volumeProp, speakerMuteProp, micMuteProp };
}

function formatPropUnitSuffix(unit?: string | null): string {
  if (unit === "celsius") return "°C";
  if (unit === "percentage") return "%";
  if (unit === "kelvin") return "K";
  return unit ? ` ${unit}` : "";
}

function joinDeviceLabel(name: string, tail: string): string {
  if (!tail) return name;
  const needsSpace = /[A-Za-z0-9]$/.test(name) || /^[A-Za-z0-9]/.test(tail);
  return needsSpace ? `${name} ${tail}` : `${name}${tail}`;
}

function formatDeviceDetailUiSummary(
  device: DeviceInfo,
  values: Record<string, unknown>,
  props: readonly PropInfo[],
): string {
  if (!device.online) {
    return joinDeviceLabel(device.name, "离线");
  }

  if (isWasherDevice(device, props)) {
    const parts: string[] = [];
    const drumProp = props.find((p) => p.name === "drum-location");
    const drumLabel = resolveEnumLabel(values["drum-location"], drumProp?.value_list);
    if (drumLabel) {
      parts.push(drumLabel.split("·")[0]?.trim() || drumLabel);
    }
    const statusProp = props.find((p) => p.name === "running-status");
    const statusLabel = resolveEnumLabel(values["running-status"], statusProp?.value_list);
    if (statusLabel) {
      parts.push(statusLabel);
    } else if (typeof values["on"] === "boolean") {
      parts.push(values["on"] ? "已开" : "已关");
    }
    const programProp = props.find((p) => p.name === "program");
    const programLabel = resolveEnumLabel(values["program"], programProp?.value_list);
    if (programLabel) {
      parts.push(programLabel);
    }
    const remain = values["remain-time"];
    if (typeof remain === "number" && remain > 0 && values["running-status"] === "start") {
      parts.push(`剩 ${Math.round(remain)} 分`);
    }
    return parts.length > 0 ? `${device.name} ${parts.join(" · ")}` : joinDeviceLabel(device.name, "在线");
  }

  const temp = values["temperature"];
  const hum = values["relative-humidity"] ?? values["humidity"];
  const bat = values["battery-level"] ?? values["battery"];
  if (typeof temp === "number" || typeof hum === "number") {
    const sensorParts: string[] = [];
    if (typeof temp === "number") sensorParts.push(`${temp}°C`);
    if (typeof hum === "number") sensorParts.push(`湿度 ${hum}%`);
    if (typeof bat === "number" && bat < 20) sensorParts.push(`电量 ${bat}%`);
    return `${device.name} ${sensorParts.join("，")}`;
  }

  const hasLightVal =
    isLight(device) ||
    typeof values["brightness"] === "number" ||
    typeof values["color-temperature"] === "number";
  if (hasLightVal && typeof values["on"] === "boolean") {
    if (!values["on"]) {
      return joinDeviceLabel(device.name, "已关");
    }
    const parts: string[] = [];
    if (typeof values["brightness"] === "number") parts.push(`亮度 ${values["brightness"]}%`);
    if (typeof values["color-temperature"] === "number") parts.push(`${values["color-temperature"]}K`);
    return parts.length > 0
      ? joinDeviceLabel(device.name, `已开，${parts.join("，")}`)
      : joinDeviceLabel(device.name, "已开");
  }

  if (isSpeaker(device)) {
    const parts: string[] = [];
    if (typeof values["volume"] === "number") parts.push(`音量 ${values["volume"]}%`);
    const muted = values["mute"] === true || values["mute-2"] === true;
    if (muted) parts.push("已静音");
    return parts.length > 0 ? `${device.name} ${parts.join("，")}` : joinDeviceLabel(device.name, "在线");
  }

  if (typeof values["on"] === "boolean") {
    return joinDeviceLabel(device.name, values["on"] ? "已开" : "已关");
  }

  const propParts: string[] = [];
  for (const p of props) {
    if (isSensitivePropertyName(p.name)) continue;
    const val = values[p.name];
    if (val === undefined || val === null) continue;
    let formatted: string;
    if (typeof val === "boolean") {
      formatted = val ? "开" : "关";
    } else if (p.value_list) {
      const optItem = p.value_list.find((o) => o.value === val);
      formatted = optItem?.desc_zh_cn ?? optItem?.description ?? String(val);
    } else {
      formatted = `${String(val)}${formatPropUnitSuffix(p.unit)}`;
    }
    propParts.push(`${p.desc || p.name} ${formatted}`);
    if (propParts.length >= 2) break;
  }

  return propParts.length > 0
    ? `${device.name} ${propParts.join("，")}`
    : joinDeviceLabel(device.name, "在线");
}

function formatListUiSummary(names: readonly string[], unitLabel: string): string {
  if (names.length === 0) return `未找到${unitLabel}`;
  if (names.length <= 4) {
    return `共 ${names.length} ${unitLabel}：${names.join("、")}`;
  }
  return `共 ${names.length} ${unitLabel}：${names.slice(0, 3).join("、")}等`;
}

function findSpeakerPlaybackAction(
  actions: readonly ActionInfo[],
  target: "play" | "pause" | "stop" | "next" | "previous",
): ActionInfo | null {
  return (
    actions.find((a) => a.name === target && (!a.service || a.service === "play-control")) ??
    actions.find((a) => a.name === target) ??
    actions.find(
      (a) => a.service === "play-control" && a.name.replace(/-\d+$/, "") === target,
    ) ??
    null
  );
}

async function executeSpeakerPlayback(
  deps: SmartHomeToolDeps,
  did: string,
  actions: readonly ActionInfo[],
  pb: "play" | "pause" | "stop" | "next" | "previous",
): Promise<string> {
  // 兼容极简 mock（detail.actions 为空时直接透传动作名）
  if (actions.length === 0) {
    await runJob(deps.jobs, () => deps.service.runAction(did, pb), 1);
    return pb;
  }

  const primary = findSpeakerPlaybackAction(actions, pb);
  const fallbackAction =
    pb === "stop"
      ? findSpeakerPlaybackAction(actions, "pause")
      : pb === "pause"
        ? findSpeakerPlaybackAction(actions, "stop")
        : null;

  if (primary) {
    try {
      await runJob(deps.jobs, () => deps.service.runAction(did, primary.name), 1);
      return primary.name;
    } catch (err) {
      if (fallbackAction && fallbackAction.name !== primary.name) {
        await runJob(deps.jobs, () => deps.service.runAction(did, fallbackAction.name), 1);
        return fallbackAction.name;
      }
      throw err;
    }
  }

  if (fallbackAction) {
    await runJob(deps.jobs, () => deps.service.runAction(did, fallbackAction.name), 1);
    return fallbackAction.name;
  }

  // 部分音箱型号规格未暴露 stop/pause 时，通过静默文本指令兜底
  if (
    (pb === "stop" || pb === "pause") &&
    actions.some((a) => a.name === "execute-text-directive")
  ) {
    const directive = pb === "stop" ? "停止播放" : "暂停播放";
    await runJob(
      deps.jobs,
      () => deps.service.runAction(did, "execute-text-directive", [directive, 1]),
      1,
    );
    return "execute-text-directive";
  }

  await runJob(deps.jobs, () => deps.service.runAction(did, pb), 1);
  return pb;
}

async function applySpeakerPower(
  deps: SmartHomeToolDeps,
  device: DeviceInfo,
  state: "on" | "off" | "toggle",
): Promise<{ on: boolean; note: string; values: Record<string, unknown> }> {
  const detail = await runJob(deps.jobs, () => deps.service.deviceDetail(device.did), 2);
  const { speakerMuteProp } = findSpeakerAudioProps(detail.props);

  let targetOn: boolean;
  if (state === "toggle") {
    let currentlyMuted = false;
    if (speakerMuteProp?.readable) {
      try {
        const vals = await runJob(
          deps.jobs,
          () => deps.service.readProps(device.did, [speakerMuteProp.name]),
          2,
        );
        currentlyMuted = vals[speakerMuteProp.name] === true;
      } catch {
        currentlyMuted = false;
      }
    }
    targetOn = currentlyMuted;
  } else {
    targetOn = state === "on";
  }

  let paused = false;
  let muted = false;
  if (!targetOn) {
    // 关闭小爱音箱：暂停/停止播放并开启扬声器静音（智能音箱无物理断电开关，采用暂停+静音待机）
    const pauseAction =
      findSpeakerPlaybackAction(detail.actions, "pause") ??
      findSpeakerPlaybackAction(detail.actions, "stop");
    if (pauseAction) {
      try {
        await runJob(deps.jobs, () => deps.service.runAction(device.did, pauseAction.name), 1);
        paused = true;
      } catch {
        // 未在播放时暂停可能报错，不阻断静音
      }
    }
    if (speakerMuteProp) {
      await runJob(deps.jobs, () => deps.service.writeProp(device.did, speakerMuteProp.name, true), 1);
      muted = true;
    }
  } else {
    // 打开小爱音箱：解除扬声器静音，并唤醒/恢复
    if (speakerMuteProp) {
      await runJob(deps.jobs, () => deps.service.writeProp(device.did, speakerMuteProp.name, false), 1);
    }
    const wakeAction =
      detail.actions.find((a) => a.name === "wake-up") ??
      detail.actions.find((a) => a.name === "play");
    if (wakeAction) {
      try {
        await runJob(deps.jobs, () => deps.service.runAction(device.did, wakeAction.name), 1);
      } catch {
        // 唤醒或播放失败不影响取消静音成功
      }
    }
  }

  let values: Record<string, unknown> = {};
  const toRead = ["volume", speakerMuteProp?.name, "playing-state"].filter((n): n is string => Boolean(n));
  if (toRead.length > 0) {
    try {
      values = await runJob(deps.jobs, () => deps.service.readProps(device.did, toRead), 2);
    } catch {
      values = {};
    }
  }

  if (deps.mainWindow.tray) {
    deps.mainWindow.tray.refreshAudioAfterCommand(device.did);
  }
  const note = targetOn
    ? "已唤醒"
    : muted && paused
      ? "已静音暂停"
      : muted
        ? "已静音"
        : paused
          ? "已暂停"
          : "已静音暂停";
  return { on: targetOn, note, values };
}

/**
 * 构建完整智能家居 Pi Agent 工具列表。
 */
export function createSmartHomeTools(deps: SmartHomeToolDeps): AgentTool<any>[] {
  const listDevicesTool: AgentTool<any> = {
    name: "list_devices",
    label: "查看设备列表",
    description:
      "查询 MijiaDeck 中已同步的智能设备列表（涵盖米家、涂鸦智能、美的智能、德业智能），支持按平台、房间、家庭、名称关键词、设备类型或在线状态过滤。",
    parameters: obj({
      platform: opt(
        oneOf(["all", "mijia", "tuya", "midea", "deye"] as const, {
          description: "平台过滤：mijia（米家）、tuya（涂鸦）、midea（美的）、deye（德业）",
        }),
      ),
      room: opt(str({ description: "房间名称过滤，例如：客厅、卧室、餐厅、阳台" })),
      home: opt(str({ description: "家庭名称过滤（可选）" })),
      keyword: opt(str({ description: "设备名称或型号关键词（可选）" })),
      category: opt(
        oneOf(
          [
            "all",
            "light",
            "switch",
            "sensor",
            "speaker",
            "camera",
            "feeder",
            "appliance",
            "ac",
            "dehumidifier",
            "washer",
            "inverter",
          ] as const,
          {
            description: "设备类型筛选",
          },
        ),
      ),
      online_only: opt(bool({ description: "是否仅返回在线设备" })),
    }),
    execute: async (_toolCallId, params) => {
      const blocked = ensureAccessReady(deps);
      if (blocked) return textResult(blocked, { ok: false, error: blocked }, true);

      let list = deps.mainWindow.activeDevices();
      if (params.platform && params.platform !== "all") {
        list = list.filter((d) => devicePlatformId(d) === params.platform);
      }
      if (params.home) {
        const h = normalizeQuery(params.home);
        list = list.filter((d) => normalizeQuery(d.home_name).includes(h));
      }
      list = resolveDevices(list, {
        target: params.keyword,
        room: params.room,
        category: params.category,
      });
      if (params.online_only) {
        list = list.filter((d) => d.online);
      }
      const items = list.map((d) => formatDeviceSummary(d, deps.mainWindow));
      const uiSummary =
        items.length === 0
          ? "未找到匹配设备"
          : formatListUiSummary(
              items.map((it) => String(it.name)),
              "台",
            );
      const summary =
        items.length === 0
          ? "未找到符合条件的智能设备。"
          : `共找到 ${items.length} 台设备：\n` +
            items
              .map(
                (it) =>
                  `- ${it.name}（${it.room} · ${it.category} · ${it.online ? "在线" : "离线"}${
                    it.power ? ` · 开关:${it.power === "on" ? "开" : "关"}` : ""
                  }${it.metrics ? ` · ${it.metrics}` : ""}）[did=${it.did}]`,
              )
              .join("\n");
      return textResult(summary, { ok: true, count: items.length, devices: items, uiSummary });
    },
  };

  const getDeviceDetailTool: AgentTool<any> = {
    name: "get_device_detail",
    label: "读取设备详情与状态",
    description:
      "读取指定设备的完整实时状态、温湿度/电量等传感器读数、可写属性和可执行动作列表。",
    parameters: obj({
      target: str({ description: "设备 did 或设备名称（支持模糊匹配，如“卧室米家温湿度计”、“客厅吸顶灯”）" }),
    }),
    execute: async (_toolCallId, params) => {
      const blocked = ensureAccessReady(deps);
      if (blocked) return textResult(blocked, { ok: false, error: blocked }, true);

      const resolved = resolveSingleDeviceChecked(deps.mainWindow.activeDevices(), params.target);
      if (resolved.ambiguous.length > 1) {
        const choices = resolved.ambiguous
          .map((d) => `${d.home_name ? `${d.home_name}/` : ""}${d.room_name}/${d.name}`)
          .join("、");
        const msg = `存在多台同名在线设备（${choices}），请明确指定家庭或具体设备后再查看详情。`;
        return textResult(
          msg,
          {
            ok: false,
            ambiguousDevices: true,
            candidates: resolved.ambiguous.map((d) => ({
              did: d.did,
              name: d.name,
              home: d.home_name,
              room: d.room_name,
            })),
            uiSummary: msg,
          },
          true,
        );
      }
      const device = resolved.device;
      if (!device) {
        const msg = `未找到设备：${params.target}`;
        return textResult(msg, { ok: false, uiSummary: msg }, true);
      }

      const detail = await runJob(deps.jobs, () => deps.service.deviceDetail(device.did), 2);
      const readableNames = detail.props
        .filter((p) => p.readable && !isSensitivePropertyName(p.name))
        .map((p) => p.name);

      let values: Record<string, unknown> = {};
      if (device.online && readableNames.length > 0) {
        try {
          values = await runJob(deps.jobs, () => deps.service.readProps(device.did, readableNames), 2);
        } catch {
          values = {};
        }
      }

      // 同步回主窗口状态
      let mutated = false;
      const powerProp = findPowerProp(detail.props);
      if (powerProp && typeof values[powerProp.name] === "boolean") {
        const nextPower = values[powerProp.name] as boolean;
        if (deps.mainWindow.knownPower[device.did] !== nextPower) {
          deps.mainWindow.applyPowerState(device.did, nextPower);
          deps.mainWindow.updateTrayDevices();
          mutated = true;
        }
      }
      const isWasher = isWasherDevice(device, detail.props, detail.actions);
      const freshMetrics = isWasher
        ? formatWasherCardMetrics(detail.props, values)
        : formatMetricsText(
            values["temperature"],
            values["relative-humidity"] ?? values["humidity"],
          );
      if (freshMetrics && deps.mainWindow.metrics[device.did] !== freshMetrics) {
        deps.mainWindow.metrics[device.did] = freshMetrics;
        mutated = true;
      } else if (isWasher && !freshMetrics && deps.mainWindow.metrics[device.did]) {
        delete deps.mainWindow.metrics[device.did];
        mutated = true;
      }
      if (mutated) {
        deps.broadcastState();
      }

      const readableLines = detail.props
        .filter((p) => !isSensitivePropertyName(p.name))
        .map((p) => {
          const val = values[p.name];
          let formattedVal = val === undefined || val === null ? "—" : String(val);
          if (p.value_list && val !== undefined && val !== null) {
            const matchedOpt = p.value_list.find((optItem) => optItem.value === val);
            if (matchedOpt) {
              formattedVal = `${matchedOpt.desc_zh_cn ?? matchedOpt.description ?? val}(${val})`;
            }
          }
          if (typeof val === "boolean") {
            formattedVal = val ? "开启" : "关闭";
          }
          const unit =
            p.unit === "celsius"
              ? "°C"
              : p.unit === "percentage"
                ? "%"
                : p.unit === "kelvin"
                  ? "K"
                  : p.unit
                    ? ` ${p.unit}`
                    : "";
          return `- ${p.desc || p.name} (${p.name}): ${formattedVal}${unit}${p.writable ? " [可写]" : ""}`;
        });

      const actionLines = detail.actions.map(
        (a) => `- ${a.desc || a.name} (${a.name})${a.in?.length ? ` 参数: ${a.in.map((i) => `${i.desc || i.name}:${i.type}`).join(", ")}` : ""}`,
      );

      const publicProps = detail.props.filter((p) => !isSensitivePropertyName(p.name));
      const uiSummary = formatDeviceDetailUiSummary(device, values, publicProps);

      const text = [
        `设备：${device.name}（${device.room_name} · ${deviceCategoryLabel(device)} · ${device.online ? "在线" : "离线"}）[did=${device.did}]`,
        readableLines.length > 0 ? `属性状态：\n${readableLines.join("\n")}` : "无公开属性。",
        actionLines.length > 0 ? `可执行动作：\n${actionLines.join("\n")}` : "",
      ]
        .filter(Boolean)
        .join("\n");

      return textResult(text, {
        ok: true,
        did: device.did,
        name: device.name,
        room: device.room_name,
        category: deviceCategoryLabel(device),
        online: device.online,
        values,
        props: publicProps,
        actions: detail.actions,
        uiSummary,
      });
    },
  };

    const setDevicePowerTool: AgentTool<any> = {
    name: "set_device_power",
    label: "开关设备",
    description:
      "打开、关闭或切换一个或多个智能设备的电源开关。支持按设备名、did、房间或设备类别（如关闭餐厅所有灯）批量操作；若目标为小爱/小米音箱，会自动切换音箱播放与静音待机状态。",
    parameters: obj({
      state: oneOf(["on", "off", "toggle"] as const, {
        description: "目标开关状态：on 打开、off 关闭、toggle 切换",
      }),
      target: opt(str({ description: "目标设备名称、did 或关键词，例如：客厅吸顶灯、餐厅主灯、小米音箱、全部灯" })),
      room: opt(str({ description: "可选房间名，例如：客厅、餐厅、卧室" })),
      category: opt(
        oneOf(["all", "light", "switch", "appliance", "camera", "speaker"] as const, {
          description: "可选类别过滤，批量开关时推荐使用",
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const blocked = ensureAccessReady(deps);
      if (blocked) return textResult(blocked, { ok: false, error: blocked }, true);

      let candidates = resolveDevices(deps.mainWindow.activeDevices(), {
        target: params.target,
        room: params.room,
        category: params.category,
        controllableOnly: true,
      });

      // 若用户明确点名了音箱/音响（如“关闭小米音响”、“打开小爱音箱”），允许通过软开关控制音箱（关闭=暂停+静音，打开=取消静音+播放/唤醒）
      if (candidates.length === 0 && (params.target || params.category === "speaker")) {
        const speakerCandidates = resolveDevices(deps.mainWindow.activeDevices(), {
          target: params.target,
          room: params.room,
          category: "speaker",
        }).filter((d) => isSpeaker(d));
        if (speakerCandidates.length > 0) {
          candidates = speakerCandidates;
        }
      }

      if (candidates.length === 0) {
        const categoryLabels: Readonly<Record<string, string>> = {
          light: "灯具",
          switch: "开关",
          appliance: "家电",
          camera: "摄像头",
          speaker: "音箱",
        };
        const catLabel = params.category ? (categoryLabels[params.category] ?? params.category) : "";
        const desc = [params.room, params.target, catLabel].filter(Boolean).join("") || "指定条件";
        const msg = `未找到可控设备：${desc}`;
        return textResult(msg, { ok: false, uiSummary: msg }, true);
      }

      // 确定性安全闸门：批量关断 all/switch/camera 或单台高危设备（门锁/安防/开启灌溉水阀/关键基建断电）
      if (deps.safetyConfirmRegistry) {
        const speaker = deps.getActiveSpeakerPrincipal?.() ?? resolveSpeakerPrincipal({ source: "web" });
        if (
          params.state === "off" &&
          candidates.length > 1 &&
          (params.category === "all" || params.category === "switch" || params.category === "camera")
        ) {
          const batchRisk = classifyActionRisk(
            {
              toolName: "batch_control_devices",
              category: params.category,
              power: "off",
            },
            speaker,
          );
          if (batchRisk.safetyLocked) {
            const fp = computeActionFingerprint({
              toolName: "batch_control_devices",
              category: params.category,
              power: "off",
            });
            if (!speaker.canExecuteL3WithConfirm) {
              const msg = `权限不足：${batchRisk.reasons.join("；")}，需主人本人确认或通过客户端操作，暂未执行。`;
              return textResult(msg, { ok: false, safetyGateBlocked: true, riskLevel: batchRisk.riskLevel, uiSummary: msg }, true);
            }
            if (!deps.safetyConfirmRegistry.consumeMatching({ fingerprint: fp, toolName: "batch_control_devices" })) {
              const msg = `安全提示：${batchRisk.reasons.join("；")}，暂未执行。请先向用户确认具体设备后再操作。`;
              return textResult(msg, { ok: false, safetyGateBlocked: true, requiresConfirmation: true, riskLevel: batchRisk.riskLevel, uiSummary: msg }, true);
            }
          }
        }
      }

      const succeeded: Array<{ did: string; name: string; state: boolean; note?: string }> = [];
      const failed: Array<{ did: string; name: string; reason: string }> = [];

      for (const dev of candidates) {
        if (!dev.online) {
          failed.push({ did: dev.did, name: dev.name, reason: "离线" });
          continue;
        }
        if (deps.safetyConfirmRegistry) {
          const speaker = deps.getActiveSpeakerPrincipal?.() ?? resolveSpeakerPrincipal({ source: "web" });
          const targetPower: "on" | "off" = params.state === "off" ? "off" : "on";
          const risk = classifyActionRisk(
            {
              toolName: "set_device_power",
              did: dev.did,
              device: dev,
              power: targetPower,
              value: targetPower === "on",
            },
            speaker,
          );
          if (risk.safetyLocked) {
            const fp = computeActionFingerprint({
              toolName: "set_device_power",
              did: dev.did,
              power: targetPower,
            });
            if (!speaker.canExecuteL3WithConfirm) {
              const msg = `权限不足：${dev.name}（${risk.reasons.join("；")}）需主人确认后才可执行，暂未执行。`;
              return textResult(msg, { ok: false, safetyGateBlocked: true, riskLevel: risk.riskLevel, did: dev.did, uiSummary: msg }, true);
            }
            if (!deps.safetyConfirmRegistry.consumeMatching({ fingerprint: fp, did: dev.did, toolName: "set_device_power" })) {
              const msg = `安全提示：${dev.name}（${risk.reasons.join("；")}），暂未执行。请先向用户二次确认后再执行。`;
              return textResult(msg, { ok: false, safetyGateBlocked: true, requiresConfirmation: true, riskLevel: risk.riskLevel, did: dev.did, uiSummary: msg }, true);
            }
          }
        }
        try {
          if (isSpeaker(dev)) {
            const spRes = await applySpeakerPower(deps, dev, params.state);
            succeeded.push({ did: dev.did, name: dev.name, state: spRes.on, note: spRes.note });
            continue;
          }
          let newState: boolean;
          if (params.state === "toggle") {
            newState = await runJob(deps.jobs, () => deps.service.togglePower(dev.did), 1);
          } else {
            const targetBool = params.state === "on";
            await runJob(deps.jobs, () => deps.service.setPowerState(dev.did, targetBool), 1);
            newState = targetBool;
          }
          deps.mainWindow.applyPowerState(dev.did, newState);
          succeeded.push({ did: dev.did, name: dev.name, state: newState });
        } catch (err) {
          failed.push({
            did: dev.did,
            name: dev.name,
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (succeeded.length > 0) {
        deps.mainWindow.updateTrayDevices();
        deps.broadcastState();
      }

      let okSummary = "";
      if (succeeded.length === 1) {
        const s = succeeded[0]!;
        okSummary = s.note ? `${s.name} ${s.note}` : joinDeviceLabel(s.name, s.state ? "已开" : "已关");
      } else if (succeeded.length > 1) {
        const allPlain = succeeded.every((s) => !s.note);
        const allSameState = succeeded.every((s) => s.state === succeeded[0]!.state);
        if (allPlain && allSameState) {
          const verb = succeeded[0]!.state ? "已开" : "已关";
          if (succeeded.length <= 3) {
            okSummary = `${verb}：${succeeded.map((s) => s.name).join("、")}`;
          } else {
            okSummary = `${verb} ${succeeded.length} 台（${succeeded.slice(0, 3).map((s) => s.name).join("、")}等）`;
          }
        } else {
          const itemLabels = succeeded.map((s) =>
            s.note ? `${s.name} ${s.note}` : joinDeviceLabel(s.name, s.state ? "已开" : "已关"),
          );
          okSummary =
            itemLabels.length <= 3
              ? itemLabels.join("，")
              : `${itemLabels.slice(0, 3).join("，")}等 ${itemLabels.length} 台`;
        }
      }

      const failSummary = failed
        .map((f) =>
          f.reason === "离线" || f.reason === "设备已离线"
            ? joinDeviceLabel(f.name, "离线")
            : `${f.name}失败（${f.reason}）`,
        )
        .join("，");

      const summary = [okSummary, failSummary].filter(Boolean).join("；") || "未执行任何开关操作";

      return textResult(
        summary,
        {
          ok: succeeded.length > 0,
          succeeded,
          failed,
          ...(params.room ? { room: params.room } : {}),
          ...(params.category ? { category: params.category } : {}),
          uiSummary: summary,
        },
        succeeded.length === 0,
      );
    },
  };

  const controlLightTool: AgentTool<any> = {
    name: "control_light",
    label: "调光调色控制",
    description:
      "调节智能灯具的开关、亮度（1-100%）、色温（开尔文 K 或 warm/neutral/cool）、颜色（#RRGGBB 或中文颜色名）或灯光模式。",
    parameters: obj({
      target: str({ description: "目标灯具的 did 或名称，例如：客厅吸顶灯" }),
      on: opt(bool({ description: "是否开启或关闭灯光" })),
      brightness: opt(num({ description: "目标亮度百分比（1-100）", minimum: 1, maximum: 100 })),
      color_temperature: opt(num({ description: "目标色温（K），常见范围 2700-6500" })),
      temperature_preset: opt(
        oneOf(["warm", "neutral", "cool"] as const, {
          description: "快捷色温预设：warm 暖光(~3000K)、neutral 自然光(~4300K)、cool 冷白光(~6000K)",
        }),
      ),
      color: opt(str({ description: "目标颜色，支持 #RRGGBB 或中文/英文颜色名（如 红色、蓝色、暖白）" })),
      mode: opt(str({ description: "灯光模式名称或编号（如 日光、月光、阅读、影院）" })),
    }),
    execute: async (_toolCallId, params) => {
      const blocked = ensureAccessReady(deps);
      if (blocked) return textResult(blocked, { ok: false, error: blocked }, true);

      const allDevices = deps.mainWindow.activeDevices();
      const rawTarget = params.target.trim();
      const normTarget = normalizeQuery(rawTarget);
      const device = rawTarget
        ? (resolveSingleDevice(allDevices.filter((d) => isLight(d)), rawTarget) ??
            resolveSingleDevice(allDevices.filter((d) => deviceMatchesCategory(d, "light")), rawTarget) ??
            // 仅当调用方按精确 did 或精确名称点名时才允许回退到非灯具设备，避免“客厅”等泛称误命中空气净化器等家电
            allDevices.find((d) => d.did === rawTarget) ??
            (normTarget ? allDevices.find((d) => normalizeQuery(d.name) === normTarget) : undefined) ??
            null)
        : null;

      if (!device) {
        const msg = `未找到灯具：${params.target}`;
        return textResult(msg, { ok: false, uiSummary: msg }, true);
      }
      if (!device.online) {
        const msg = `${joinDeviceLabel(device.name, "离线")}，无法调节`;
        return textResult(msg, { ok: false, uiSummary: msg }, true);
      }

      const detail = await runJob(deps.jobs, () => deps.service.deviceDetail(device.did), 2);
      const controls = lightControls(detail.props);
      const powerProp = findPowerProp(detail.props);
      const changes: string[] = [];

      // 若指定调亮度/色温/颜色/模式且未明确要求关灯，先确保开灯
      const hasVisualAdjust =
        params.brightness !== undefined ||
        params.color_temperature !== undefined ||
        params.temperature_preset !== undefined ||
        params.color !== undefined ||
        params.mode !== undefined;

      // 在执行任何开关机写操作前，先校验目标设备是否具备所请求的灯具能力，
      // 防止不支持调光/调色的设备（如普通开关或误传的非灯具家电）先被误开机再报错。
      const hasAnyLightControl = Boolean(controls.brightness || controls.temperature || controls.color);
      if (params.on !== false) {
        if (params.brightness !== undefined && !controls.brightness) {
          const msg = `${device.name}不支持亮度调节`;
          return textResult(msg, { ok: false, uiSummary: msg }, true);
        }
        if ((params.color_temperature !== undefined || params.temperature_preset !== undefined) && !controls.temperature) {
          const msg = `${device.name}不支持色温调节`;
          return textResult(msg, { ok: false, uiSummary: msg }, true);
        }
        if (params.color !== undefined) {
          if (!controls.color) {
            const msg = `${device.name}不支持颜色调节`;
            return textResult(msg, { ok: false, uiSummary: msg }, true);
          }
          if (parseColorToRgbInt(params.color) === null) {
            const msg = `无法识别颜色：${params.color}，请使用常见颜色名或 #RRGGBB`;
            return textResult(msg, { ok: false, uiSummary: msg }, true);
          }
        }
      }
      if (!deviceMatchesCategory(device, "light") && !hasAnyLightControl) {
        const msg = `${device.name}不是灯具设备`;
        return textResult(msg, { ok: false, uiSummary: msg }, true);
      }

      if (params.on === false) {
        await runJob(deps.jobs, () => deps.service.setPowerState(device.did, false), 1);
        deps.mainWindow.applyPowerState(device.did, false);
        deps.mainWindow.updateTrayDevices();
        deps.broadcastState();
        const msg = joinDeviceLabel(device.name, "已关");
        return textResult(msg, { ok: true, did: device.did, name: device.name, on: false, uiSummary: msg });
      }

      let turnedOn = false;
      if (params.on === true || (hasVisualAdjust && deps.mainWindow.knownPower[device.did] === false)) {
        await runJob(deps.jobs, () => deps.service.setPowerState(device.did, true), 1);
        deps.mainWindow.applyPowerState(device.did, true);
        turnedOn = true;
      }

      let appliedBrightness: number | undefined;
      if (params.brightness !== undefined) {
        const bProp = controls.brightness!;
        const high = bProp.range && bProp.range.length >= 2 ? bProp.range[1] : 100;
        const scaled = high === 100 ? params.brightness : (params.brightness / 100) * high;
        const val = clampToPropRange(bProp, scaled);
        await runJob(deps.jobs, () => deps.service.writeProp(device.did, bProp.name, val), 1);
        appliedBrightness = Math.round(params.brightness);
        changes.push(`亮度 ${appliedBrightness}%`);
      }

      let appliedColorTemp: number | undefined;
      if (params.color_temperature !== undefined || params.temperature_preset !== undefined) {
        const tProp = controls.temperature!;
        const low = tProp.range && tProp.range.length >= 2 ? tProp.range[0] : 2700;
        const high = tProp.range && tProp.range.length >= 2 ? tProp.range[1] : 6500;
        let targetK = params.color_temperature;
        if (targetK === undefined) {
          if (params.temperature_preset === "warm") targetK = Math.round(low + (high - low) * 0.12);
          else if (params.temperature_preset === "cool") targetK = Math.round(low + (high - low) * 0.88);
          else targetK = Math.round((low + high) / 2);
        }
        const val = clampToPropRange(tProp, targetK);
        await runJob(deps.jobs, () => deps.service.writeProp(device.did, tProp.name, val), 1);
        appliedColorTemp = val;
        changes.push(`色温 ${val}K`);
      }

      let appliedColor: string | undefined;
      if (params.color !== undefined) {
        const cProp = controls.color!;
        const rgb = parseColorToRgbInt(params.color)!;
        await runJob(deps.jobs, () => deps.service.writeProp(device.did, cProp.name, rgb), 1);
        appliedColor = params.color;
        changes.push(`颜色 ${params.color}`);
      }

      let appliedModeLabel: string | undefined;
      if (params.mode !== undefined) {
        const modeProp = detail.props.find((p) => p.name === "mode" && p.writable);
        if (modeProp) {
          let modeVal: number | string = params.mode;
          if (modeProp.value_list) {
            const normMode = normalizeQuery(params.mode);
            const found = modeProp.value_list.find(
              (o) =>
                String(o.value) === params.mode.trim() ||
                normalizeQuery(o.desc_zh_cn ?? "").includes(normMode) ||
                normalizeQuery(o.description ?? "").includes(normMode),
            );
            if (found) modeVal = found.value;
          }
          const coerced = coercePropWriteValue(modeProp, modeVal);
          if (coerced.ok) {
            await runJob(deps.jobs, () => deps.service.writeProp(device.did, modeProp.name, coerced.value), 1);
            const modeLabel = params.mode.endsWith("模式") ? params.mode : `${params.mode}模式`;
            appliedModeLabel = modeLabel;
            changes.push(modeLabel);
          }
        }
      }

      // 回读灯光状态并广播
      const toRead = [powerProp?.name, controls.brightness?.name, controls.temperature?.name, controls.color?.name].filter(
        (n): n is string => Boolean(n),
      );
      let readback: Record<string, unknown> = {};
      if (toRead.length > 0) {
        try {
          readback = await runJob(deps.jobs, () => deps.service.readProps(device.did, toRead), 2);
          if (powerProp && typeof readback[powerProp.name] === "boolean") {
            deps.mainWindow.applyPowerState(device.did, readback[powerProp.name] as boolean);
          }
        } catch {
          // ignore readback failure
        }
      }
      deps.mainWindow.updateTrayDevices();
      deps.broadcastState();

      const allChanges = turnedOn ? ["已开", ...changes] : changes;
      const msg =
        turnedOn && changes.length > 0
          ? joinDeviceLabel(device.name, `已开，${changes.join("，")}`)
          : turnedOn
            ? joinDeviceLabel(device.name, "已开")
            : changes.length > 0
              ? joinDeviceLabel(device.name, changes.join("，"))
              : `${device.name}未指定调节参数`;
      return textResult(msg, {
        ok: true,
        did: device.did,
        name: device.name,
        turnedOn,
        ...(appliedBrightness !== undefined ? { brightness: appliedBrightness } : {}),
        ...(params.temperature_preset !== undefined ? { temperaturePreset: params.temperature_preset } : {}),
        ...(appliedColorTemp !== undefined ? { colorTemperature: appliedColorTemp } : {}),
        ...(appliedColor !== undefined ? { color: appliedColor } : {}),
        ...(appliedModeLabel !== undefined ? { mode: appliedModeLabel } : {}),
        changes: allChanges,
        values: readback,
        uiSummary: msg,
      });
    },
  };

  const setDevicePropertyTool: AgentTool<any> = {
    name: "set_device_property",
    label: "设置设备属性",
    description:
      "修改任意智能设备的可写属性（如洗衣机的筒位 drum-location、程序 program、水温 temperature、脱水转速 dehydration-speed、烘干 dry-mode、预约 appointment-time、童锁 child-lock；音箱音量 volume、静音 mute；空调目标温度；风扇档位等）。",
    parameters: obj({
      target: str({ description: "设备 did 或名称" }),
      property: str({ description: "属性名（如 volume、mute、mode）或中文描述（如 音量、静音）" }),
      value: unknown({ description: "要设置的属性值（布尔、数值或字符串）" }),
    }),
    execute: async (_toolCallId, params) => {
      const blocked = ensureAccessReady(deps);
      if (blocked) return textResult(blocked, { ok: false, error: blocked }, true);

      const resolved = resolveSingleDeviceChecked(deps.mainWindow.activeDevices(), params.target);
      if (resolved.ambiguous.length > 1) {
        const choices = resolved.ambiguous
          .map((d) => `${d.home_name ? `${d.home_name}/` : ""}${d.room_name}/${d.name}`)
          .join("、");
        const msg = `存在多台同名在线设备（${choices}），请明确指定家庭或具体设备后再设置属性。`;
        return textResult(
          msg,
          {
            ok: false,
            ambiguousDevices: true,
            candidates: resolved.ambiguous.map((d) => ({
              did: d.did,
              name: d.name,
              home: d.home_name,
              room: d.room_name,
            })),
            uiSummary: msg,
          },
          true,
        );
      }
      const device = resolved.device;
      if (!device) {
        const msg = `未找到设备：${params.target}`;
        return textResult(msg, { ok: false, uiSummary: msg }, true);
      }
      if (!device.online) {
        const msg = `${joinDeviceLabel(device.name, "离线")}，无法设置属性`;
        return textResult(msg, { ok: false, uiSummary: msg }, true);
      }

      const detail = await runJob(deps.jobs, () => deps.service.deviceDetail(device.did), 2);
      const rawKey = params.property.trim();
      const normKey = normalizeQuery(rawKey);
      let prop: PropInfo | undefined;
      if (isSpeaker(device) && (normKey === "mute" || normKey === "静音" || normKey === "扬声器静音")) {
        prop = findSpeakerAudioProps(detail.props).speakerMuteProp ?? undefined;
      } else if (isSpeaker(device) && (normKey === "micmute" || normKey === "麦克风静音" || normKey === "闭麦")) {
        prop = findSpeakerAudioProps(detail.props).micMuteProp ?? undefined;
      }
      if (!prop) {
        prop =
          detail.props.find((p) => p.name === rawKey || p.name === rawKey.replaceAll("_", "-")) ??
          detail.props.find((p) => p.writable && (normalizeQuery(p.name) === normKey || normalizeQuery(p.desc) === normKey)) ??
          detail.props.find((p) => p.writable && (normalizeQuery(p.desc).includes(normKey) || normalizeQuery(p.name).includes(normKey)));
      }

      if (!prop) {
        const msg = `${device.name}未找到可写属性：${rawKey}`;
        return textResult(msg, { ok: false, uiSummary: msg }, true);
      }

      let rawVal = params.value;
      // 支持按中文枚举描述匹配 value_list
      if (prop.value_list && typeof rawVal === "string") {
        const normVal = normalizeQuery(rawVal);
        const optHit = prop.value_list.find(
          (o) =>
            normalizeQuery(o.desc_zh_cn ?? "") === normVal ||
            normalizeQuery(o.description ?? "") === normVal,
        );
        if (optHit) {
          rawVal = optHit.value;
        }
      }

      const coerced = coercePropWriteValue(prop, rawVal);
      if (!coerced.ok) {
        const msg = `属性 ${prop.desc || prop.name} 参数无效：${coerced.error}`;
        return textResult(msg, { ok: false, uiSummary: msg }, true);
      }

      if (deps.safetyConfirmRegistry) {
        const speaker = deps.getActiveSpeakerPrincipal?.() ?? resolveSpeakerPrincipal({ source: "web" });
        const risk = classifyActionRisk(
          {
            toolName: "set_device_property",
            did: device.did,
            device,
            propName: prop.name,
            value: coerced.value,
          },
          speaker,
        );
        // 洗衣机通过 control-status=true 启动时同样执行实时硬件安全探针
        if (isWasherDevice(device) && prop.name === "control-status" && coerced.value === true) {
          const probe = await probeWasherRuntimeSafety(deps.service, device.did);
          if (probe.status === "hard_block") {
            const msg = `安全提示：${probe.reasons.join("；")}，已硬阻断，暂未执行。`;
            return textResult(msg, { ok: false, safetyGateBlocked: true, hardBlocked: true, did: device.did, uiSummary: msg }, true);
          }
          if (probe.status === "require_confirm") {
            const fp = computeActionFingerprint({
              toolName: "set_device_property",
              did: device.did,
              propName: prop.name,
              value: coerced.value,
            });
            if (!deps.safetyConfirmRegistry.consumeMatching({ fingerprint: fp, did: device.did, toolName: "set_device_property" })) {
              const msg = `安全提示：${probe.reasons.join("；")}，暂未执行。请确认安全后再启动。`;
              return textResult(msg, { ok: false, safetyGateBlocked: true, requiresConfirmation: true, did: device.did, uiSummary: msg }, true);
            }
          }
        }
        if (risk.safetyLocked) {
          const fp = computeActionFingerprint({
            toolName: "set_device_property",
            did: device.did,
            propName: prop.name,
            value: coerced.value,
          });
          if (!speaker.canExecuteL3WithConfirm) {
            const msg = `权限不足：${device.name}（${risk.reasons.join("；")}）需主人确认，暂未执行。`;
            return textResult(msg, { ok: false, safetyGateBlocked: true, riskLevel: risk.riskLevel, did: device.did, uiSummary: msg }, true);
          }
          if (!deps.safetyConfirmRegistry.consumeMatching({ fingerprint: fp, did: device.did, toolName: "set_device_property" })) {
            const msg = `安全提示：${device.name}（${risk.reasons.join("；")}），暂未执行。请先向用户确认后再执行。`;
            return textResult(msg, { ok: false, safetyGateBlocked: true, requiresConfirmation: true, riskLevel: risk.riskLevel, did: device.did, uiSummary: msg }, true);
          }
        }
      }

      await runJob(deps.jobs, () => deps.service.writeProp(device.did, prop.name, coerced.value), 1);

      const powerProp = findPowerProp(detail.props);
      if (powerProp && prop.name === powerProp.name && typeof coerced.value === "boolean") {
        deps.mainWindow.applyPowerState(device.did, coerced.value);
        deps.mainWindow.updateTrayDevices();
      }
      if (deps.mainWindow.tray && deps.mainWindow.tray.quick.audioBar.did === device.did) {
        deps.mainWindow.tray.quick.audioBar.refreshAfterCommand(device.did);
      }
      deps.broadcastState();

      let displayVal: string;
      if (typeof coerced.value === "boolean") {
        displayVal = coerced.value ? "开" : "关";
      } else if (prop.value_list) {
        const matchedOpt = prop.value_list.find((o) => o.value === coerced.value);
        displayVal =
          matchedOpt?.desc_zh_cn ??
          matchedOpt?.description ??
          `${String(coerced.value)}${formatPropUnitSuffix(prop.unit)}`;
      } else {
        displayVal = `${String(coerced.value)}${formatPropUnitSuffix(prop.unit)}`;
      }
      const msg = joinDeviceLabel(device.name, `${prop.desc || prop.name}已设为 ${displayVal}`);

      return textResult(msg, {
        ok: true,
        did: device.did,
        name: device.name,
        property: prop.name,
        propLabel: prop.desc || prop.name,
        value: coerced.value,
        displayVal,
        uiSummary: msg,
      });
    },
  };

  const runDeviceActionTool: AgentTool<any> = {
    name: "run_device_action",
    label: "执行设备动作",
    description:
      "执行智能设备的动作或红外遥控按键，例如洗衣机开始洗涤（start-wash）、暂停洗涤（pause-wash）、取消预约（cancel-appointment，可选 params 传入筒位如 [\"left\"]），涂鸦红外遥控按键（PowerOn、PowerOff、Volume+ 等），宠物喂食器出粮（pet-food-out），音箱播放/暂停/朗读文本等。",
    parameters: obj({
      target: str({ description: "设备 did 或名称" }),
      action: str({ description: "动作名/红外按键名（如 PowerOn、Volume+、Play、pet-food-out）或中文描述（如 开机、音量+、播放、立即出粮、下一首）" }),
      params: opt(arr(unknown(), { description: "可选动作参数数组，例如出粮份数 [2]、红外重复按键次数 [3] 或朗读文本 [\"你好\"]" })),
      confirm_dangerous: opt(
        bool({
          description:
            "仅在用户已明确二次确认执行高危/不可逆动作（如 reboot、reset-*、set-default、restore、factory-reset、format、delete）后才可设为 true；未经用户明确确认严禁传入 true",
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const blocked = ensureAccessReady(deps);
      if (blocked) return textResult(blocked, { ok: false, error: blocked }, true);

      const resolved = resolveSingleDeviceChecked(deps.mainWindow.activeDevices(), params.target);
      if (resolved.ambiguous.length > 1) {
        const choices = resolved.ambiguous
          .map((d) => `${d.home_name ? `${d.home_name}/` : ""}${d.room_name}/${d.name}`)
          .join("、");
        const msg = `存在多台同名在线设备（${choices}），请明确指定家庭或具体设备后再设置属性。`;
        return textResult(
          msg,
          {
            ok: false,
            ambiguousDevices: true,
            candidates: resolved.ambiguous.map((d) => ({
              did: d.did,
              name: d.name,
              home: d.home_name,
              room: d.room_name,
            })),
            uiSummary: msg,
          },
          true,
        );
      }
      const device = resolved.device;
      if (!device) {
        const msg = `未找到设备：${params.target}`;
        return textResult(msg, { ok: false, uiSummary: msg }, true);
      }
      if (!device.online) {
        const msg = `${joinDeviceLabel(device.name, "离线")}，无法执行`;
        return textResult(msg, { ok: false, uiSummary: msg }, true);
      }

      const detail = await runJob(deps.jobs, () => deps.service.deviceDetail(device.did), 2);
      const rawAction = params.action.trim();
      const normAct = normalizeQuery(rawAction);
      const matched =
        detail.actions.find((a) => a.name === rawAction || a.name === rawAction.replaceAll("_", "-")) ??
        detail.actions.find(
          (a) =>
            normalizeQuery(a.desc) === normAct ||
            normalizeQuery(a.desc).includes(normAct) ||
            normalizeQuery(a.name).includes(normAct),
        );

      const actionName = matched?.name ?? rawAction;
      const actionLabel = matched?.desc || actionName;
      if ((isDangerousAction(actionName) || isDangerousAction(rawAction)) && params.confirm_dangerous !== true) {
        const msg = `安全提示：${device.name}的「${actionLabel}」属于高风险不可逆动作，暂未执行。请先向用户说明后果并获明确二次确认后，再携带 confirm_dangerous=true 调用。`;
        return textResult(
          msg,
          {
            ok: false,
            blockedDangerousAction: true,
            safetyGateBlocked: true,
            requiresConfirmation: true,
            did: device.did,
            name: device.name,
            action: actionName,
            actionLabel,
            uiSummary: msg,
          },
          true,
        );
      }

      if (deps.safetyConfirmRegistry) {
        const speaker = deps.getActiveSpeakerPrincipal?.() ?? resolveSpeakerPrincipal({ source: "web" });
        const drumParam =
          Array.isArray(params.params) && typeof params.params[0] === "string"
            ? params.params[0]
            : undefined;
        // 洗衣机启动动作执行实时物理安全探针（过热/故障直接硬阻断；门未关/童锁/高温残留升级确认）
        if (isWasherDevice(device) && (actionName === "start-wash" || actionName === "start_wash")) {
          const probe = await probeWasherRuntimeSafety(deps.service, device.did, drumParam);
          if (probe.status === "hard_block") {
            const msg = `安全提示：${probe.reasons.join("；")}，已硬阻断，暂未执行。`;
            return textResult(
              msg,
              {
                ok: false,
                safetyGateBlocked: true,
                hardBlocked: true,
                did: device.did,
                action: actionName,
                uiSummary: msg,
              },
              true,
            );
          }
          if (probe.status === "require_confirm") {
            const fp = computeActionFingerprint({
              toolName: "run_device_action",
              did: device.did,
              actionName,
              drumKey: drumParam,
            });
            if (
              !deps.safetyConfirmRegistry.consumeMatching({
                fingerprint: fp,
                did: device.did,
                toolName: "run_device_action",
              })
            ) {
              const msg = `安全提示：${probe.reasons.join("；")}，暂未执行。请确认后再启动洗衣机。`;
              return textResult(
                msg,
                {
                  ok: false,
                  safetyGateBlocked: true,
                  requiresConfirmation: true,
                  did: device.did,
                  action: actionName,
                  uiSummary: msg,
                },
                true,
              );
            }
          }
        }

        const risk = classifyActionRisk(
          {
            toolName: "run_device_action",
            did: device.did,
            device,
            actionName,
            params:
              Array.isArray(params.params) && params.params.length > 0
                ? { portions: params.params[0] }
                : undefined,
            drumKey: drumParam,
          },
          speaker,
        );
        if (risk.safetyLocked) {
          const fp = computeActionFingerprint({
            toolName: "run_device_action",
            did: device.did,
            actionName,
            drumKey: drumParam,
          });
          if (!speaker.canExecuteL3WithConfirm) {
            const msg = `权限不足：${device.name}的「${actionLabel}」（${risk.reasons.join("；")}）需主人确认后才可执行，暂未执行。`;
            return textResult(
              msg,
              { ok: false, safetyGateBlocked: true, riskLevel: risk.riskLevel, did: device.did, uiSummary: msg },
              true,
            );
          }
          if (
            !deps.safetyConfirmRegistry.consumeMatching({
              fingerprint: fp,
              did: device.did,
              toolName: "run_device_action",
            })
          ) {
            const msg = `安全提示：${device.name}的「${actionLabel}」（${risk.reasons.join("；")}），暂未执行。请先通过宿主向用户确认后再执行。`;
            return textResult(
              msg,
              {
                ok: false,
                safetyGateBlocked: true,
                requiresConfirmation: true,
                riskLevel: risk.riskLevel,
                did: device.did,
                action: actionName,
                uiSummary: msg,
              },
              true,
            );
          }
        }
      }
      await runJob(deps.jobs, () => deps.service.runAction(device.did, actionName, params.params), 1);

      if (deps.mainWindow.tray && deps.mainWindow.tray.quick.audioBar.did === device.did) {
        deps.mainWindow.tray.quick.audioBar.refreshAfterCommand(device.did);
      }
      deps.broadcastState();

      const isFeederAction = actionName === "pet-food-out" || normAct.includes("出粮");
      let msg: string;
      if (isFeederAction) {
        const portions = params.params?.[0];
        msg =
          portions !== undefined && portions !== null
            ? joinDeviceLabel(device.name, `已出粮 ${portions} 份`)
            : joinDeviceLabel(device.name, "已出粮");
      } else {
        const paramNote =
          params.params && params.params.length > 0 ? `（${params.params.join("、")}）` : "";
        msg = joinDeviceLabel(device.name, `已执行${actionLabel}${paramNote}`);
      }
      return textResult(msg, {
        ok: true,
        did: device.did,
        name: device.name,
        action: actionName,
        actionLabel,
        isFeederAction,
        params: params.params ?? [],
        uiSummary: msg,
      });
    },
  };

  const listScenesTool: AgentTool<any> = {
    name: "list_scenes",
    label: "查看手动场景",
    description: "列出米家 APP 中同步的手动场景列表，可用于确认场景名称后执行。",
    parameters: obj({
      home: opt(str({ description: "可选家庭名称筛选" })),
      keyword: opt(str({ description: "可选场景名称关键词" })),
    }),
    execute: async (_toolCallId, params) => {
      const blocked = ensureAccessReady(deps);
      if (blocked) return textResult(blocked, { ok: false, error: blocked }, true);

      let scenes: SceneInfo[] = deps.mainWindow.scenes ? [...deps.mainWindow.scenes] : [];
      if (scenes.length === 0) {
        try {
          scenes = await runJob(deps.jobs, () => deps.service.sceneList(), 2);
        } catch {
          scenes = [];
        }
      }
      if (params.home) {
        const h = normalizeQuery(params.home);
        scenes = scenes.filter((s) => normalizeQuery(s.home_name).includes(h));
      }
      if (params.keyword) {
        const kw = normalizeQuery(params.keyword);
        scenes = scenes.filter((s) => normalizeQuery(s.name).includes(kw));
      }

      const uiSummary =
        scenes.length === 0
          ? "暂无手动场景"
          : formatListUiSummary(
              scenes.map((s) => s.name),
              "个场景",
            );
      const text =
        scenes.length === 0
          ? "当前没有匹配的手动场景。"
          : `共有 ${scenes.length} 个手动场景：\n` +
            scenes.map((s) => `- ${s.name}${s.home_name ? `（${s.home_name}）` : ""} [id=${s.scene_id}]`).join("\n");
      return textResult(text, { ok: true, count: scenes.length, scenes, uiSummary });
    },
  };

  const runSceneTool: AgentTool<any> = {
    name: "run_scene",
    label: "执行手动场景",
    description: "按场景 ID 或名称执行指定的米家手动场景，并在执行后刷新设备开关状态。",
    parameters: obj({
      target: str({ description: "场景 scene_id 或场景名称，例如：回家模式、离家全关" }),
    }),
    execute: async (_toolCallId, params) => {
      const blocked = ensureAccessReady(deps);
      if (blocked) return textResult(blocked, { ok: false, error: blocked }, true);

      const scenes = deps.mainWindow.scenes ?? [];
      const raw = params.target.trim();
      const norm = normalizeQuery(raw);
      const found =
        scenes.find((s) => s.scene_id === raw) ??
        scenes.find((s) => normalizeQuery(s.name) === norm) ??
        scenes.find((s) => normalizeQuery(s.name).includes(norm) || norm.includes(normalizeQuery(s.name)));

      if (!found) {
        const msg = `未找到场景：${raw}`;
        return textResult(msg, { ok: false, uiSummary: msg }, true);
      }

      const scene = createSceneInfo(found);
      await runJob(deps.jobs, () => deps.service.runScene(scene), 1);

      const onlineDids = deps.mainWindow.activeDevices().filter((d) => d.online).map((d) => d.did);
      if (onlineDids.length > 0) {
        try {
          const states = await runJob(deps.jobs, () => deps.service.powerStates(onlineDids), 5);
          for (const [did, st] of Object.entries(states)) {
            if (typeof st === "boolean") {
              deps.mainWindow.applyPowerState(did, st);
            }
          }
          deps.mainWindow.updateTrayDevices();
        } catch {
          // ignore readback failure
        }
      }
      deps.broadcastState();

      const msg = `已执行：${scene.name}`;
      return textResult(msg, {
        ok: true,
        scene_id: scene.scene_id,
        name: scene.name,
        uiSummary: msg,
      });
    },
  };

  const sendXiaoAiTool: AgentTool<any> = {
    name: "send_xiaoai_command",
    label: "发送小爱语音指令",
    description:
      "将自然语言指令转发给在线小爱音箱执行（execute-text-directive），适合放歌、查询天气或小爱生态特有指令。",
    parameters: obj({
      text: str({ description: "发送给小爱同学的指令文本" }),
      speaker: opt(str({ description: "可选指定小爱音箱名称或 did；留空使用默认在线音箱" })),
      silent: opt(bool({ description: "是否静默执行（不让小爱音箱语音回复），默认 false；适用于后台自愈停播等场景" })),
    }),
    execute: async (_toolCallId, params) => {
      const blocked = ensureAccessReady(deps);
      if (blocked) return textResult(blocked, { ok: false, error: blocked }, true);

      const directive = params.text.trim();
      if (!directive) {
        return textResult("指令文本不能为空。", { ok: false }, true);
      }
      const devices = deps.mainWindow.activeDevices();
      const allSpeakers = devices.filter((d) => isSpeaker(d));
      const onlineSpeakers = allSpeakers.filter((d) => d.online);
      let targetSpeaker: DeviceInfo | null = null;
      const requestedSpeaker = params.speaker?.trim() ?? "";
      if (requestedSpeaker) {
        const normRequested = normalizeQuery(requestedSpeaker);
        const exactXiaoAi =
          allSpeakers.find((d) => d.did === requestedSpeaker) ??
          allSpeakers.find((d) => normalizeQuery(d.name) === normRequested) ??
          null;
        const exactNonXiaoAi = !exactXiaoAi
          ? (devices.find((d) => !isSpeaker(d) && d.did === requestedSpeaker) ??
              devices.find((d) => !isSpeaker(d) && normalizeQuery(d.name) === normRequested) ??
              null)
          : null;
        if (exactNonXiaoAi) {
          const msg = `${exactNonXiaoAi.name}不是小爱音箱，不支持转发小爱指令`;
          return textResult(
            msg,
            { ok: false, did: exactNonXiaoAi.did, name: exactNonXiaoAi.name, uiSummary: msg },
            true,
          );
        }
        const matchedSpeaker = exactXiaoAi ?? resolveSingleDevice(allSpeakers, requestedSpeaker);
        if (matchedSpeaker) {
          if (!matchedSpeaker.online) {
            const msg = `${joinDeviceLabel(matchedSpeaker.name, "离线")}，无法转发小爱指令`;
            return textResult(
              msg,
              { ok: false, did: matchedSpeaker.did, name: matchedSpeaker.name, uiSummary: msg },
              true,
            );
          }
          targetSpeaker = matchedSpeaker;
        } else {
          // 显式指定了 speaker 但未命中任何小爱音箱：严禁静默回退到其他在线小爱！
          const matchedOther =
            devices.find((d) => d.did === requestedSpeaker) ??
            resolveSingleDevice(devices, requestedSpeaker);
          if (matchedOther) {
            const msg = `${matchedOther.name}不是小爱音箱，不支持转发小爱指令`;
            return textResult(
              msg,
              { ok: false, did: matchedOther.did, name: matchedOther.name, uiSummary: msg },
              true,
            );
          }
          const msg = `未找到指定的小爱音箱：${requestedSpeaker}`;
          return textResult(msg, { ok: false, uiSummary: msg }, true);
        }
      } else {
        const prefDid = deps.settingsStore.getDefaultSpeakerDid();
        if (prefDid) {
          targetSpeaker = onlineSpeakers.find((d) => d.did === prefDid) ?? null;
        }
        if (!targetSpeaker) {
          targetSpeaker = onlineSpeakers[0] ?? null;
        }
      }
      if (!targetSpeaker) {
        return textResult(speakerHint(devices) || "当前没有可用的在线小爱音箱。", { ok: false }, true);
      }

      const directiveArgs = params.silent === true ? [directive, 1] : [directive];
      await runJob(
        deps.jobs,
        () => deps.service.runAction(targetSpeaker!.did, "execute-text-directive", directiveArgs),
        1,
      );
      if (deps.mainWindow.tray) {
        deps.mainWindow.tray.refreshAudioAfterCommand(targetSpeaker.did);
      }
      deps.broadcastState();

      const msg = `已发给小爱：${directive}`;
      return textResult(msg, {
        ok: true,
        did: targetSpeaker.did,
        speaker: targetSpeaker.name,
        text: directive,
        ...(params.silent === true ? { silent: true } : {}),
        uiSummary: msg,
      });
    },
  };

  const controlSpeakerTool: AgentTool<any> = {
    name: "control_speaker",
    label: "控制音箱/红外音响",
    description:
      "控制小米/小爱音箱或涂鸦红外遥控音响：支持开关机、调节或增减音量、静音、播放控制（播放/暂停/停止/上一首/下一首）；小爱音箱另支持点歌、绝对音量与文本播报。",
    parameters: obj({
      target: opt(str({ description: "目标音箱或红外音响名称/did；留空自动选择默认在线小爱/小米音箱" })),
      power: opt(
        oneOf(["on", "off", "toggle"] as const, {
          description: "开关音箱：on 打开，off 关闭，toggle 切换",
        }),
      ),
      play_music: opt(str({ description: "播放指定音乐、歌曲、歌手或歌单（仅小爱音箱），例如：周杰伦的晴天" })),
      playback: opt(
        oneOf(["play", "pause", "stop", "next", "previous"] as const, {
          description: "播放控制：play 播放、pause 暂停、stop 停止、next 下一首、previous 上一首",
        }),
      ),
      volume: opt(num({ description: "设置目标绝对音量（0-100，小爱音箱）", minimum: 0, maximum: 100 })),
      volume_delta: opt(
        num({
          description: "相对调整音量增减值，例如 +10 表示调大、-15 表示调小（红外音响会自动连发对应音量+/音量-按键）",
          minimum: -100,
          maximum: 100,
        }),
      ),
      mute: opt(bool({ description: "扬声器静音（true）或取消静音（false）" })),
      mic_mute: opt(bool({ description: "麦克风静音（true）或开启麦克风（false，仅小爱音箱）" })),
      speak_text: opt(str({ description: "让小爱音箱直接朗读指定文本内容" })),
    }),
    execute: async (_toolCallId, params) => {
      const blocked = ensureAccessReady(deps);
      if (blocked) return textResult(blocked, { ok: false, error: blocked }, true);

      const devices = deps.mainWindow.activeDevices();
      const allSpeakers = devices.filter((d) => isSpeaker(d));
      const allIrAudio = devices.filter((d) => isIrAudioDevice(d));
      const onlineSpeakers = allSpeakers.filter((d) => d.online);
      const onlineIrAudio = allIrAudio.filter((d) => d.online);
      let speaker: DeviceInfo | null = null;
      const requestedTarget = params.target?.trim() ?? "";
      if (requestedTarget) {
        const wantsXiaoAi = /小米|小爱/i.test(requestedTarget);
        if (wantsXiaoAi) {
          speaker =
            allSpeakers.find((d) => d.did === requestedTarget) ??
            resolveSingleDevice(allSpeakers, requestedTarget);
        } else {
          // 优先精确匹配 did / 精确设备名（让“音响”精准命中红外音响，而不误落到默认小爱）
          const normT = normalizeQuery(requestedTarget);
          const allPool = [...allIrAudio, ...allSpeakers];
          const exactDid = allPool.find((d) => d.did === requestedTarget);
          const exactNames = allPool.filter((d) => normalizeQuery(d.name) === normT);
          speaker =
            exactDid ??
            (exactNames.length > 0
              ? (exactNames.find((d) => d.online) ?? exactNames[0] ?? null)
              : resolveSingleDevice(allPool, requestedTarget));
        }

        if (!speaker) {
          // 显式指定了 target 但未命中音箱/红外音响：严禁静默回退到其他在线小爱！
          const matchedOther =
            devices.find((d) => d.did === requestedTarget) ??
            resolveSingleDevice(devices, requestedTarget);
          if (matchedOther && !isSpeaker(matchedOther) && !isIrAudioDevice(matchedOther)) {
            const msg = `${matchedOther.name}不是音箱或红外音响设备，请改用对应设备控制工具`;
            return textResult(
              msg,
              { ok: false, did: matchedOther.did, name: matchedOther.name, uiSummary: msg },
              true,
            );
          }
          const msg = `未找到指定的音箱或红外音响：${requestedTarget}`;
          return textResult(msg, { ok: false, uiSummary: msg }, true);
        }
        if (!speaker.online) {
          const msg = `${joinDeviceLabel(speaker.name, "离线")}，无法控制`;
          return textResult(
            msg,
            { ok: false, did: speaker.did, name: speaker.name, uiSummary: msg },
            true,
          );
        }
      } else {
        const prefDid = deps.settingsStore.getDefaultSpeakerDid();
        if (prefDid) {
          speaker = onlineSpeakers.find((d) => d.did === prefDid) ?? null;
        }
        if (!speaker) {
          speaker = onlineSpeakers[0] ?? onlineIrAudio[0] ?? null;
        }
      }
      if (!speaker) {
        return textResult(speakerHint(devices) || "当前没有可用的在线音箱或红外音响。", { ok: false }, true);
      }

      // 涂鸦红外遥控音响（infrared_amplifier 等）：通过红外按键动作执行开关/音量增减/静音/播放控制
      if (isIrAudioDevice(speaker)) {
        const detail = await runJob(deps.jobs, () => deps.service.deviceDetail(speaker!.did), 2);
        const findIrKey = (...candidates: string[]): ActionInfo | null => {
          for (const c of candidates) {
            const lower = c.toLowerCase();
            const found = detail.actions.find((a) => a.name.trim().toLowerCase() === lower);
            if (found) return found;
          }
          return null;
        };
        const changes: string[] = [];
        const unsupported: string[] = [];

        if (params.power) {
          let nextState: boolean;
          if (params.power === "toggle") {
            nextState = await runJob(deps.jobs, () => deps.service.togglePower(speaker!.did), 1);
          } else {
            nextState = params.power === "on";
            await runJob(deps.jobs, () => deps.service.setPowerState(speaker!.did, nextState), 1);
          }
          deps.mainWindow.applyPowerState(speaker.did, nextState);
          deps.mainWindow.updateTrayDevices();
          changes.push(nextState ? "已开机" : "已关机");
        }

        if (typeof params.mute === "boolean") {
          const muteKey = findIrKey("mute");
          if (muteKey) {
            await runJob(deps.jobs, () => deps.service.runAction(speaker!.did, muteKey.name), 1);
            changes.push("已发送静音键");
          } else {
            unsupported.push("静音按键");
          }
        }

        if (params.volume_delta !== undefined && params.volume_delta !== 0) {
          const up = Number(params.volume_delta) > 0;
          const key = up
            ? findIrKey("volume+", "vol+", "volumeup", "volume_up")
            : findIrKey("volume-", "vol-", "volumedown", "volume_down");
          if (key) {
            const steps = Math.max(1, Math.min(5, Math.round(Math.abs(Number(params.volume_delta)) / 10) || 1));
            await runJob(deps.jobs, () => deps.service.runAction(speaker!.did, key.name, [steps]), 1);
            changes.push(up ? `音量调大（${steps}次）` : `音量调小（${steps}次）`);
          } else {
            unsupported.push(up ? "音量+按键" : "音量-按键");
          }
        } else if (params.volume !== undefined) {
          unsupported.push("绝对音量设置（请使用调大/调小音量）");
        }

        if (params.playback) {
          const pb = params.playback;
          const map: Record<string, { keys: string[]; label: string }> = {
            play: { keys: ["play", "playpause", "play/pause", "play_pause"], label: "播放" },
            pause: { keys: ["pause", "playpause", "play/pause", "play_pause", "stop"], label: "暂停" },
            stop: { keys: ["stop", "pause", "playpause"], label: "停止" },
            next: { keys: ["next", "nexttrack", "next_track"], label: "下一首" },
            previous: { keys: ["previous", "prev", "previoustrack", "previous_track"], label: "上一首" },
          };
          const spec = map[pb];
          const key = spec ? findIrKey(...spec.keys) : null;
          if (key) {
            await runJob(deps.jobs, () => deps.service.runAction(speaker!.did, key.name), 1);
            changes.push(spec!.label);
          } else {
            unsupported.push(spec?.label ?? pb);
          }
        }

        if (params.play_music?.trim()) unsupported.push("语音点歌");
        if (params.speak_text?.trim()) unsupported.push("文本播报");
        if (typeof params.mic_mute === "boolean") unsupported.push("麦克风静音");

        deps.broadcastState();

        if (changes.length === 0) {
          const msg =
            unsupported.length > 0
              ? `${speaker.name}为红外遥控音响，暂不支持${unsupported.join("、")}`
              : `${speaker.name}未指定红外遥控操作`;
          return textResult(msg, { ok: false, did: speaker.did, name: speaker.name, uiSummary: msg }, true);
        }

        const msg = `${speaker.name} ${changes.join("，")}${
          unsupported.length > 0 ? `（不支持${unsupported.join("、")}）` : ""
        }`;
        return textResult(msg, {
          ok: true,
          did: speaker.did,
          name: speaker.name,
          changes,
          ...(detail.control_warning ? { controlWarning: detail.control_warning } : {}),
          uiSummary: msg,
        });
      }

      const detail = await runJob(deps.jobs, () => deps.service.deviceDetail(speaker!.did), 2);
      const { volumeProp, speakerMuteProp, micMuteProp } = findSpeakerAudioProps(detail.props);
      const changes: string[] = [];
      let powerNote: string | undefined;
      let appliedVolume: number | undefined;
      let appliedSong: string | undefined;
      let executedPlaybackAction: string | undefined;

      if (params.power) {
        const pwRes = await applySpeakerPower(deps, speaker, params.power);
        powerNote = pwRes.note;
        changes.push(pwRes.note);
      }

      if (typeof params.mute === "boolean") {
        if (!speakerMuteProp) {
          const msg = `${speaker.name}不支持静音控制`;
          return textResult(msg, { ok: false, uiSummary: msg }, true);
        }
        await runJob(deps.jobs, () => deps.service.writeProp(speaker!.did, speakerMuteProp.name, params.mute), 1);
        changes.push(params.mute ? "已静音" : "已取消静音");
      }

      if (typeof params.mic_mute === "boolean") {
        if (!micMuteProp) {
          const msg = `${speaker.name}不支持麦克风静音控制`;
          return textResult(msg, { ok: false, uiSummary: msg }, true);
        }
        await runJob(deps.jobs, () => deps.service.writeProp(speaker!.did, micMuteProp.name, params.mic_mute), 1);
        changes.push(params.mic_mute ? "麦克风已静音" : "麦克风已开启");
      }

      if (params.volume !== undefined || params.volume_delta !== undefined) {
        if (!volumeProp) {
          const msg = `${speaker.name}不支持音量调节`;
          return textResult(msg, { ok: false, uiSummary: msg }, true);
        }
        let targetVol: number;
        if (params.volume !== undefined) {
          targetVol = params.volume;
        } else {
          let curVol = 50;
          try {
            const cur = await runJob(deps.jobs, () => deps.service.readProp(speaker!.did, volumeProp.name), 2);
            if (typeof cur === "number" && Number.isFinite(cur)) {
              curVol = cur;
            }
          } catch {
            // fallback 50
          }
          targetVol = curVol + Number(params.volume_delta ?? 0);
        }
        const clamped = clampToPropRange(volumeProp, targetVol);
        await runJob(deps.jobs, () => deps.service.writeProp(speaker!.did, volumeProp.name, clamped), 1);
        appliedVolume = clamped;
        changes.push(`音量 ${clamped}%`);
      }

      if (params.play_music && params.play_music.trim()) {
        const song = params.play_music.trim();
        // 播放音乐前如处于静音，自动取消静音确保能听见
        if (speakerMuteProp && params.mute === undefined && params.power !== "off") {
          try {
            const mVal = await runJob(deps.jobs, () => deps.service.readProp(speaker!.did, speakerMuteProp.name), 2);
            if (mVal === true) {
              await runJob(deps.jobs, () => deps.service.writeProp(speaker!.did, speakerMuteProp.name, false), 1);
            }
          } catch {
            // ignore
          }
        }
        const songClean = song.replace(/^播放\s*/, "");
        const directive = /^播放/.test(song) ? song : `播放${song}`;
        await runJob(
          deps.jobs,
          () => deps.service.runAction(speaker!.did, "execute-text-directive", [directive, 0]),
          1,
        );
        appliedSong = songClean;
        changes.push(`播放${songClean}`);
      }

      if (params.playback) {
        const pb = params.playback;
        const labelMap: Record<string, string> = {
          play: "继续播放",
          pause: "已暂停",
          stop: "已停止",
          next: "下一首",
          previous: "上一首",
        };
        executedPlaybackAction = await executeSpeakerPlayback(deps, speaker.did, detail.actions, pb);
        changes.push(labelMap[pb] ?? pb);
      }

      if (params.speak_text && params.speak_text.trim()) {
        const txt = params.speak_text.trim();
        await runJob(deps.jobs, () => deps.service.runAction(speaker!.did, "play-text", [txt]), 1);
        changes.push("已播报");
      }

      // 回读音箱实时音量与静音状态
      const toRead = [volumeProp?.name, speakerMuteProp?.name, micMuteProp?.name, "playing-state"].filter(
        (n): n is string => Boolean(n),
      );
      let readback: Record<string, unknown> = {};
      if (toRead.length > 0) {
        try {
          readback = await runJob(deps.jobs, () => deps.service.readProps(speaker!.did, toRead), 2);
        } catch {
          readback = {};
        }
      }

      if (deps.mainWindow.tray) {
        deps.mainWindow.tray.refreshAudioAfterCommand(speaker.did);
      }
      deps.broadcastState();

      const summary =
        changes.length > 0
          ? `${speaker.name} ${changes.join("，")}`
          : `${speaker.name}未指定操作`;

      return textResult(summary, {
        ok: true,
        did: speaker.did,
        name: speaker.name,
        changes,
        values: readback,
        ...(powerNote ? { powerNote } : {}),
        ...(typeof params.mute === "boolean" ? { mute: params.mute } : {}),
        ...(typeof params.mic_mute === "boolean" ? { micMute: params.mic_mute } : {}),
        ...(appliedVolume !== undefined ? { volume: appliedVolume } : {}),
        ...(appliedSong ? { playMusic: appliedSong } : {}),
        ...(params.playback ? { playback: params.playback } : {}),
        ...(executedPlaybackAction ? { executedPlaybackAction } : {}),
        ...(params.speak_text?.trim() ? { speak_text: params.speak_text.trim() } : {}),
        uiSummary: summary,
      });
    },
  };

  const listPlatformsTool: AgentTool<any> = {
    name: "list_platforms",
    label: "查看已接入平台",
    description:
      "查询当前 MijiaDeck 已注册的多平台接入状态（米家、涂鸦智能、美的智能、德业智能），返回各平台连接状态与设备数量。",
    parameters: obj({}),
    execute: async () => {
      if (isMultiPlatformService(deps.service)) {
        const platforms = deps.service.listPlatforms();
        const connected = platforms.filter((p) => p.connected);
        const uiSummary =
          connected.length > 0
            ? `已接入 ${connected.length} 个平台：${connected.map((p) => `${p.name}(${p.deviceCount}台)`).join("、")}`
            : "当前暂无已连接的智能家居平台";
        return textResult(uiSummary, {
          ok: true,
          platforms: platforms.map((p) => ({
            id: p.id,
            name: p.name,
            displayName: p.displayName,
            connected: p.connected,
            enabled: p.enabled,
            state: p.state,
            deviceCount: p.deviceCount,
            ...(SCENES_FEATURE_ENABLED ? { sceneCount: p.sceneCount } : {}),
          })),
          uiSummary,
        });
      }
      const total = deps.mainWindow.activeDevices().length;
      const uiSummary = `当前运行单一/示例模式（米家 ${total} 台设备）`;
      return textResult(uiSummary, {
        ok: true,
        platforms: [{ id: "mijia", name: "米家", connected: !deps.mainWindow.loggedOut, deviceCount: total }],
        uiSummary,
      });
    },
  };

  const saveCustomInstructionTool: AgentTool<any> = {
    name: "save_custom_instruction",
    label: "保存附加指令",
    description:
      "持久化保存一条用户的长期附加指令/偏好规则（支持通过语音或文字保存多条规则；若多条规则存在冲突，系统自动以最新保存的规则为准）。当用户说出“以后记得……”“以后我说……你要……”“记住……”等长期偏好、默认模式或条件控制规则时必须调用此工具。",
    parameters: obj({
      content: str({
        description:
          "清晰完整的附加指令规则内容，例如：“洗衣默认用智洗烘模式”或“以后我说打开空调你要自己判断室外温度，根据室外温度自动选择对应正确的模式和温度”",
      }),
      topic: opt(
        str({
          description: "适用设备或场景主题标签（如：洗衣机、空调、灯光、音箱、通用；留空自动识别）",
        }),
      ),
    }),
    execute: async (_id, params: { content: string; topic?: string }) => {
      const content = String(params.content ?? "").trim();
      if (!content) {
        const msg = "附加指令内容不能为空";
        return textResult(msg, { ok: false, uiSummary: msg }, true);
      }
      const promptSource = deps.getActivePromptSource?.();
      const source: CustomInstructionSource =
        promptSource === "voice" ? "voice" : promptSource === "text" ? "text" : "manual";
      const rawText = deps.getActivePromptRawText?.()?.trim() || undefined;
      try {
        const saved = addCustomInstruction({
          content,
          rawText,
          topic: params.topic,
          source,
        });
        deps.onCustomInstructionsChanged?.();
        deps.broadcastState();

        const conflictCount = saved.conflictingRules.length;
        const uiSummary = saved.bumped
          ? `已将附加指令更新为最新优先（${saved.rule.topic}）：${saved.rule.content}`
          : conflictCount > 0
            ? `已保存第 ${saved.totalCount} 条附加指令（${saved.rule.topic} · 最新优先，冲突时覆盖较早规则）：${saved.rule.content}`
            : `已保存第 ${saved.totalCount} 条附加指令（${saved.rule.topic}）：${saved.rule.content}`;

        return textResult(uiSummary, {
          ok: true,
          created: saved.created,
          bumped: saved.bumped,
          rule: saved.rule,
          totalCount: saved.totalCount,
          enabledCount: saved.enabledCount,
          conflictCount,
          conflictingRuleIds: saved.conflictingRules.map((r) => r.id),
          uiSummary,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return textResult(msg, { ok: false, uiSummary: msg }, true);
      }
    },
  };

  const listCustomInstructionsTool: AgentTool<any> = {
    name: "list_custom_instructions",
    label: "查看附加指令",
    description:
      "查看当前已保存的全部用户附加指令规则（按最新保存顺序从新到旧排列；若多条规则冲突，序号靠前的最新规则优先）。",
    parameters: obj({
      topic: opt(str({ description: "按设备或场景主题过滤（可选，例如：洗衣机、空调、灯光）" })),
      include_disabled: opt(bool({ description: "是否包含已停用的规则，默认 true" })),
    }),
    execute: async (_id, params: { topic?: string; include_disabled?: boolean }) => {
      const all = loadCustomInstructions();
      const conflicts = detectCustomInstructionConflicts(all);
      const topicFilter = params.topic?.trim() ?? "";
      const includeDisabled = params.include_disabled !== false;
      const filtered = all.filter((r) => {
        if (!includeDisabled && !r.enabled) return false;
        if (topicFilter && !r.topic.includes(topicFilter) && !r.content.includes(topicFilter)) {
          return false;
        }
        return true;
      });
      if (filtered.length === 0) {
        const uiSummary = topicFilter
          ? `当前没有关于「${topicFilter}」的附加指令规则`
          : "当前尚未保存任何附加指令规则";
        return textResult(uiSummary, { ok: true, count: 0, rules: [], uiSummary });
      }
      const lines = filtered.map((r, idx) => {
        const rank = idx + 1;
        const status = !r.enabled
          ? "已停用"
          : rank === 1
            ? "最新优先"
            : conflicts.has(r.id)
              ? "冲突时以新规则为准"
              : "已启用";
        return `${rank}. [${r.topic} · ${status}] ${r.content}`;
      });
      const uiSummary = `已保存 ${filtered.length} 条附加指令（按最新优先）：${filtered
        .slice(0, 3)
        .map((r) => r.content)
        .join("；")}${filtered.length > 3 ? "等" : ""}`;
      return textResult(lines.join("\n"), {
        ok: true,
        count: filtered.length,
        rules: filtered.map((r) => ({
          ...r,
          conflict: conflicts.get(r.id) ?? null,
        })),
        uiSummary,
      });
    },
  };

  const deleteCustomInstructionTool: AgentTool<any> = {
    name: "delete_custom_instruction",
    label: "删除附加指令",
    description:
      "删除或清空已保存的用户附加指令规则。支持按规则 id、关键词/主题匹配删除，或删除最新一条（delete_latest=true），或清空全部（clear_all=true）。",
    parameters: obj({
      id: opt(str({ description: "要删除的规则 ID（可选）" })),
      query: opt(str({ description: "按内容或主题关键词匹配删除（例如：洗衣、空调）" })),
      delete_latest: opt(bool({ description: "是否删除最新保存的一条附加指令规则" })),
      clear_all: opt(bool({ description: "是否清空全部已保存的附加指令规则" })),
    }),
    execute: async (
      _id,
      params: { id?: string; query?: string; delete_latest?: boolean; clear_all?: boolean },
    ) => {
      if (params.clear_all) {
        const cleared = clearCustomInstructions();
        deps.onCustomInstructionsChanged?.();
        deps.broadcastState();
        const uiSummary =
          cleared > 0 ? `已清空全部 ${cleared} 条附加指令规则` : "当前没有已保存的附加指令规则";
        return textResult(uiSummary, { ok: true, deletedCount: cleared, cleared: true, uiSummary });
      }
      if (params.id?.trim()) {
        const removed = deleteCustomInstruction(params.id.trim());
        if (!removed) {
          const msg = "未找到指定 ID 的附加指令规则";
          return textResult(msg, { ok: false, uiSummary: msg }, true);
        }
        deps.onCustomInstructionsChanged?.();
        deps.broadcastState();
        const uiSummary = `已删除附加指令：${removed.content}`;
        return textResult(uiSummary, {
          ok: true,
          deletedCount: 1,
          deletedRules: [removed],
          uiSummary,
        });
      }
      if (params.delete_latest) {
        const removed = deleteLatestCustomInstruction();
        if (!removed) {
          const msg = "当前没有可删除的附加指令规则";
          return textResult(msg, { ok: false, uiSummary: msg }, true);
        }
        deps.onCustomInstructionsChanged?.();
        deps.broadcastState();
        const uiSummary = `已删除最新附加指令：${removed.content}`;
        return textResult(uiSummary, {
          ok: true,
          deletedCount: 1,
          deletedRules: [removed],
          uiSummary,
        });
      }
      if (params.query?.trim()) {
        const removedList = deleteCustomInstructionsByQuery(params.query.trim());
        if (removedList.length === 0) {
          const msg = `未找到与「${params.query.trim()}」相关的附加指令规则`;
          return textResult(msg, { ok: false, uiSummary: msg }, true);
        }
        deps.onCustomInstructionsChanged?.();
        deps.broadcastState();
        const uiSummary =
          removedList.length === 1
            ? `已删除附加指令：${removedList[0]!.content}`
            : `已删除 ${removedList.length} 条与「${params.query.trim()}」相关的附加指令`;
        return textResult(uiSummary, {
          ok: true,
          deletedCount: removedList.length,
          deletedRules: removedList,
          uiSummary,
        });
      }
      const msg = "请指定要删除的规则关键词、规则 ID，或选择删除最新一条 / 清空全部";
      return textResult(msg, { ok: false, uiSummary: msg }, true);
    },
  };

  const proposeConfirmationTool: AgentTool<any> = {
    name: "propose_confirmation",
    label: "发起渐进确认",
    description:
      "当遇到歧义/隐式请求尚未形成可信记忆、长期休眠需重确认、多台同名设备需消歧或涉及高安全风险操作时，调用此只读工具在宿主登记一条结构化待确认提问，以便用户口头答复「嗯/好/对/取消」或点击界面按钮直接确认执行，并在成功后自动总结记录强化记忆。",
    parameters: obj({
      question: str({ description: "向用户发出的简短明确中文确认问题（例如：确认一下，是要用阳台「美的可爱多」的左筒·袜子筒帮你洗袜子吗？）" }),
      summary: str({ description: "自动总结的决策规则摘要（例如：说「洗袜子」→ 启动阳台「美的可爱多」左筒·袜子筒）" }),
      target_did: str({ description: "拟执行的目标设备精确 did" }),
      capability_key: opt(str({ description: "设备能力键，如 did#left:socks" })),
      drum_key: opt(str({ description: "多筒洗衣机目标筒位（left/right/bottom/top/main）" })),
      program: opt(str({ description: "目标洗涤/运行程序名（如 socks/underpants/smart_wash_dry）" })),
      risk_level: opt(
        oneOf(["L1_LOW", "L2_MEDIUM_APPLIANCE", "L2_SEASONAL", "L3_HIGH_SAFETY"] as const, {
          description: "风险等级（默认 L2_MEDIUM_APPLIANCE）",
        }),
      ),
      origin: opt(
        oneOf(
          [
            "new_implicit",
            "learning_second_ask",
            "dormancy_reconfirm",
            "safety_required",
            "device_disambiguation",
            "tool_proposal",
          ] as const,
          { description: "触发确认的原因类型" },
        ),
      ),
      action_name: opt(str({ description: "确认后拟执行的动作名（如 start-wash、pet-food-out）" })),
      power_state: opt(oneOf(["on", "off"] as const, { description: "确认后拟设置的开关状态（可选）" })),
    }),
    execute: async (_id, params) => {
      const devices = deps.mainWindow.activeDevices();
      const targetDev = devices.find((d) => d.did === params.target_did) ?? resolveSingleDevice(devices, params.target_did);
      const rawUtterance = deps.getActivePromptRawText?.()?.trim() || params.summary;
      const digest = deps.getCapabilityDigest?.() ?? buildHomeCapabilityDigest(devices, deps.now?.());
      const intent = canonicalizeImplicitIntent(rawUtterance);
      const speaker = deps.getActiveSpeakerPrincipal?.() ?? resolveSpeakerPrincipal({ source: "web" });

      const steps: MemoryActionBinding["steps"] = [];
      const did = targetDev?.did ?? params.target_did;
      if (params.drum_key) {
        steps.push({ toolName: "set_device_property", did, propName: "drum-location", value: params.drum_key });
      }
      if (params.program) {
        steps.push({ toolName: "set_device_property", did, propName: "program", value: params.program });
      }
      if (params.action_name) {
        steps.push({ toolName: "run_device_action", did, actionName: params.action_name });
      } else if (params.power_state) {
        steps.push({ toolName: "set_device_power", did, power: params.power_state });
      }

      const binding: MemoryActionBinding = {
        did,
        deviceName: targetDev?.name ?? params.target_did,
        homeName: targetDev?.home_name,
        roomName: targetDev?.room_name,
        capabilityKey:
          params.capability_key ||
          `${did}#${params.drum_key || "main"}:${params.program || params.action_name || params.power_state || "default"}`,
        drumKey: params.drum_key,
        program: params.program,
        steps,
      };

      const riskLevel: RiskLevel = (params.risk_level as RiskLevel | undefined) ?? "L2_MEDIUM_APPLIANCE";
      const pending = deps.openPendingConfirmation?.({
        origin: (params.origin as PendingConfirmationOrigin | undefined) ?? "tool_proposal",
        canonicalKey: intent.canonicalKey,
        originalUtterance: rawUtterance,
        questionText: params.question.trim(),
        summary: params.summary.trim(),
        binding,
        riskLevel,
        topologyHash: digest.topologyHash,
        conflictDomains: [],
        speakerScope:
          speaker.role === "verified_member" && riskLevel !== "L1_LOW" ? speaker.speakerId : "global",
      });

      const uiSummary = params.question.trim();
      return textResult(uiSummary, {
        ok: true,
        awaitingConfirmation: true,
        pendingConfirmationId: pending?.id ?? null,
        question: uiSummary,
        summary: params.summary.trim(),
        uiSummary,
      });
    },
  };

  const resolveDecisionMemoryTool: AgentTool<any> = {
    name: "resolve_decision_memory",
    label: "查询强化决策记忆",
    description:
      "查询某句口语/隐式指令对应的强化决策记忆与渐进确认状态（返回是否可直接免确认执行、剩余确认次数、记忆保留率或是否因休眠/安全需再次确认）。",
    parameters: obj({
      utterance: str({ description: "用户原话或规范化意图短语（例如：帮我洗一下袜子）" }),
    }),
    execute: async (_id, params: { utterance: string }) => {
      const devices = deps.mainWindow.activeDevices();
      const nowMs = deps.now?.() ?? getReinforcementNow();
      const digest = deps.getCapabilityDigest?.() ?? buildHomeCapabilityDigest(devices, nowMs);
      const speaker = deps.getActiveSpeakerPrincipal?.() ?? resolveSpeakerPrincipal({ source: "web" });
      const intent = canonicalizeImplicitIntent(params.utterance);
      const { memory, borrowedOwnerHint } = findMatchingReinforcementMemory(intent.canonicalKey, speaker);
      const capProbe = probeImplicitCapabilities(params.utterance, digest);

      if (!memory) {
        const uiSummary = capProbe
          ? `未找到已沉淀记忆，探测到候选能力：${capProbe.matchedCapabilityLabel}，建议向用户确认`
          : "未找到匹配的强化记忆规则";
        return textResult(uiSummary, {
          ok: true,
          found: false,
          canonicalKey: intent.canonicalKey,
          borrowedOwnerHint: borrowedOwnerHint ? { id: borrowedOwnerHint.id, summary: borrowedOwnerHint.summary } : null,
          capabilityProbe: capProbe
            ? {
                ambiguousDevices: capProbe.ambiguousDevices,
                matchedCapabilityLabel: capProbe.matchedCapabilityLabel,
                suggestedQuestion: capProbe.suggestedQuestion,
              }
            : null,
          uiSummary,
        });
      }

      const gate = evaluateReinforcementGate(memory, {
        nowMs,
        currentTopologyHash: digest.topologyHash,
        speaker,
      });
      const uiSummary = `${memory.summary}｜裁决：${gate.decision === "execute_directly" ? "直接执行" : "需确认"}（${gate.reasonText}）`;
      return textResult(uiSummary, {
        ok: true,
        found: true,
        memory,
        gate,
        uiSummary,
      });
    },
  };

  const listDecisionMemoriesTool: AgentTool<any> = {
    name: "list_decision_memories",
    label: "查看强化决策记忆",
    description:
      "列出所有通过渐进确认自动总结记录的强化决策记忆（含已确认次数、信任阶段、记忆保留率、安全锁状态与摘要）。",
    parameters: obj({
      include_disabled: opt(bool({ description: "是否包含已停用或被覆盖的记忆，默认 false" })),
    }),
    execute: async (_id, params: { include_disabled?: boolean }) => {
      const nowMs = deps.now?.() ?? getReinforcementNow();
      const digest = deps.getCapabilityDigest?.() ?? buildHomeCapabilityDigest(deps.mainWindow.activeDevices(), nowMs);
      const list = listReinforcementMemories({ includeDisabled: Boolean(params.include_disabled) });
      if (list.length === 0) {
        const uiSummary = "当前还没有自动学习的强化决策记忆";
        return textResult(uiSummary, { ok: true, count: 0, memories: [], uiSummary });
      }
      const enriched = list.map((m) => ({
        ...m,
        retention: Number(computeRetention(m, nowMs).toFixed(2)),
        uiStage: computeUiTrustStage(m, nowMs, digest.topologyHash),
      }));
      const lines = enriched.map(
        (m, idx) =>
          `${idx + 1}. [${m.uiStage} · ${m.confirmCount}/${m.confirmThreshold} · 保留${Math.round(m.retention * 100)}%] ${m.summary}`,
      );
      const uiSummary = `共有 ${enriched.length} 条强化决策记忆`;
      return textResult(lines.join("\n"), {
        ok: true,
        count: enriched.length,
        memories: enriched,
        uiSummary,
      });
    },
  };

  const forgetDecisionMemoryTool: AgentTool<any> = {
    name: "forget_decision_memory",
    label: "遗忘/重置强化记忆",
    description:
      "删除、重置或清空已学习的强化决策记忆（支持按 id、关键词删除或重置确认次数，或清空全部）。",
    parameters: obj({
      id: opt(str({ description: "记忆 ID" })),
      query: opt(str({ description: "按摘要或触发词关键词匹配" })),
      reset_only: opt(bool({ description: "true 表示仅重置确认次数回学习态（下次重新问），false 表示直接删除" })),
      clear_all: opt(bool({ description: "是否清空全部强化记忆" })),
    }),
    execute: async (
      _id,
      params: { id?: string; query?: string; reset_only?: boolean; clear_all?: boolean },
    ) => {
      if (params.clear_all) {
        const count = clearReinforcementMemories();
        deps.onMemoriesChanged?.();
        deps.broadcastState();
        const uiSummary = count > 0 ? `已清空全部 ${count} 条强化决策记忆` : "当前没有强化决策记忆";
        return textResult(uiSummary, { ok: true, cleared: count, uiSummary });
      }
      let targetId = params.id?.trim() || "";
      if (!targetId && params.query?.trim()) {
        const q = params.query.trim().toLowerCase();
        const hit = listReinforcementMemories({ includeDisabled: true }).find(
          (m) =>
            m.summary.toLowerCase().includes(q) ||
            m.canonicalKey.toLowerCase().includes(q) ||
            m.sampleUtterances.some((u) => u.toLowerCase().includes(q)),
        );
        targetId = hit?.id ?? "";
      }
      if (!targetId) {
        const msg = "未找到匹配的强化决策记忆";
        return textResult(msg, { ok: false, uiSummary: msg }, true);
      }
      if (params.reset_only) {
        const updated = resetReinforcementMemory(targetId);
        deps.onMemoriesChanged?.();
        deps.broadcastState();
        const uiSummary = updated ? `已重置强化记忆「${updated.summary}」，下次将重新确认` : "未找到指定记忆";
        return textResult(uiSummary, { ok: Boolean(updated), memory: updated, uiSummary }, !updated);
      }
      const ok = deleteReinforcementMemory(targetId);
      deps.onMemoriesChanged?.();
      deps.broadcastState();
      const uiSummary = ok ? "已删除该条强化决策记忆" : "未找到指定记忆";
      return textResult(uiSummary, { ok, uiSummary }, !ok);
    },
  };

  return [
    listDevicesTool,
    listPlatformsTool,
    getDeviceDetailTool,
    setDevicePowerTool,
    controlLightTool,
    controlSpeakerTool,
    setDevicePropertyTool,
    runDeviceActionTool,
    ...(SCENES_FEATURE_ENABLED ? [listScenesTool, runSceneTool] : []),
    sendXiaoAiTool,
    saveCustomInstructionTool,
    listCustomInstructionsTool,
    deleteCustomInstructionTool,
    proposeConfirmationTool,
    resolveDecisionMemoryTool,
    listDecisionMemoriesTool,
    forgetDecisionMemoryTool,
  ];
}
