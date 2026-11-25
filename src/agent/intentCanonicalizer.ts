// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 隐式指令规范化、设备能力摘要与多筒/专能设备探查
// Copyright (C) 2026 MiHome-Windows contributors

import type { DeviceInfo } from "../core/models.ts";
import {
  getWasherProgramOptions,
  resolveMideaWasherProfile,
  type MideaWasherDrumKey,
  type MideaWasherTypeCode,
} from "../platforms/midea/washer.ts";

/**
 * 强否定：明显是人类手工/家务/离线行为且不可能由任何联网设备执行的短语。
 * 在 SystemOne 前置与隐式能力匹配前做负向护栏，防止误触发。
 */
export const NON_DEVICE_CHORE_VETO_RE =
  /(?:洗碗|刷碗|刷锅|洗菜|切菜|做饭|炒菜|煮面|烧菜|洗水果|擦桌子|擦窗户|叠衣服|晾衣服|晒衣服|收衣服|熨衣服|手洗|倒垃圾|扔垃圾|收拾屋子|整理房间|铺床|叠被子|遛狗|铲屎|换猫砂|拿快递|取快递|点外卖|买菜|下楼|帮我拿|帮我递|帮我找|给我倒杯水|倒水|泡茶|帮我记一下|写作业|去洗澡|洗个澡|洗头|洗脸|刷牙|洗手|洗车)/;

/** 仅聊天/回忆/讨论语境（非面向 AI 的即时控制请求），用于拦截纯叙事旁白。 */
export const NARRATIVE_NON_COMMAND_RE =
  /(?:昨天|前天|上周|上个月|刚才|刚刚|明天|后天|下周|周末|以后|改天|下次|记得明天|要买|买了|新买|还没买|坏了|修好了|好贵|便宜|多少钱|怎么样|好用吗|真好用|不错|推荐|评测|视频|看着|听说|别人|朋友|同事|老板|妈妈|爸爸|老婆|老公|儿子|女儿|孩子)(?:.*(?:袜子|内衣|内裤|洗衣机|洗衣服|烘干|扫地|拖地|浇花|喂猫|喂狗))?/;

export interface HomeCapabilityEntry {
  did: string;
  name: string;
  homeName: string;
  roomName: string;
  online: boolean;
  category:
    | "washer"
    | "dryer"
    | "vacuum"
    | "irrigation"
    | "feeder"
    | "ac"
    | "dehumidifier"
    | "curtain"
    | "lock"
    | "camera"
    | "water_heater";
  /** 例如 `midea:xxx#left:socks`、`midea:xxx#right:underpants` 或 `did#action` */
  capabilityKey: string;
  drumKey?: MideaWasherDrumKey;
  drumLabel?: string;
  program?: string;
  programLabel?: string;
  /** 面向 SystemOne / Prompt 展示的一行短摘要 */
  summary: string;
  /** 隐式语义触发词（如 袜子、内裤、文胸、浇花、扫地、喂猫、烘干） */
  affordanceTokens: string[];
  /** 配套动作动词（与 affordanceTokens 搭配判断隐式请求） */
  verbTokens: string[];
  /** 需要明确主语/能力映射的动作（用于区分高风险或容易误判的隐式请求） */
  implicitOnly?: boolean;
}

export interface HomeCapabilityDigest {
  generatedAt: number;
  topologyHash: string;
  /** 紧凑的设备特殊能力摘要行（适合直接注入 SystemOne / Prompt） */
  summaryLines: string[];
  /** 全量可匹配的设备能力项 */
  entries: HomeCapabilityEntry[];
  /** 同名在线设备分布在不同家庭或房间时的消歧提示 */
  duplicateNameGroups: Record<string, Array<{ did: string; homeName: string; roomName: string; name: string }>>;
}

export interface CanonicalIntent {
  rawText: string;
  cleanedText: string;
  /** 稳定且去口语化的意图签名，如 `implicit:wash:socks` 或 `implicit:water:plants` */
  canonicalKey: string;
  /** 可读摘要短语，如 `帮我洗袜子` */
  normalizedPhrase: string;
  /** 隐式领域标签，如 `laundry`、`irrigation`、`vacuum`、`feeder`、`dryer`、`climate` */
  domain: string;
  /** 提取出的核心动词与宾语 */
  action: string;
  target: string;
  /** 若句子中显式指定了房间或家庭 */
  roomHint: string | null;
  homeHint: string | null;
  /** 是否显式提到了具体设备名或筒位（例如“洗衣机左筒”） */
  hasExplicitDeviceOrDrum: boolean;
  /** 是否被强家务/非设备规则否决 */
  vetoedByNonDeviceChore: boolean;
  /** 是否属于明显过去/未来叙事而非即时指令 */
  looksNarrative: boolean;
}

export interface ImplicitCapabilityMatch {
  intent: CanonicalIntent;
  matchedEntries: HomeCapabilityEntry[];
  /** 存在多台跨家庭/跨房间同名候选设备，需要用户消歧 */
  ambiguousDevices: boolean;
  /** 推荐默认候选（当只有唯一在线匹配时非空） */
  primaryCandidate: HomeCapabilityEntry | null;
  /** 建议向用户确认的简短问题 */
  suggestedQuestion: string;
  /** 面向日志/观测的简短能力标签 */
  matchedCapabilityLabel: string;
}

const COMMON_ROOMS = [
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
  "院子",
  "花园",
  "露台",
  "浴室",
  "厕所",
  "走廊",
  "玄关",
  "门厅",
] as const;

const FILLER_PREFIX_RE =
  /^(?:(?:你好|嗨|嘿|喂|那个|那个啥|诶|哎|嗯+|啊+|哦+|呃+|对了|话说|麻烦(?:你)?|劳驾|请你?|帮我|给我|替我|能不能(?:帮我)?|可以(?:帮我)?|可不可以(?:帮我)?|顺便(?:帮我)?|赶紧|快点|现在|立刻|马上|稍微|去|来)[\s,，。、!！?？]*)+/;

const FILLER_SUFFIX_RE =
  /[\s,，。、!！?？]*(?:好吗|好不好|行吗|行不行|可以吗|成吗|吧|呗|呀|啊|呢|哈|啦|哦|嘛|一下|一哈|咯)+[\s,，。、!！?？]*$/;

export function fnv1aHash(input: string): string {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36).padStart(7, "0");
}

/**
 * 从 DeviceInfo.firmware / model 中提取美的设备型号码（如 `0xd9`）与 `sn8`（如 `38135636`）。
 */
export function extractMideaWasherMeta(device: DeviceInfo): {
  typeCode: MideaWasherTypeCode;
  sn8?: string;
} | null {
  const modelLower = (device.model || "").toLowerCase();
  const specLower = (device.spec_type || "").toLowerCase();
  const combined = `${modelLower} ${specLower}`;

  let typeCode: MideaWasherTypeCode | null = null;
  if (combined.includes("0xd9")) typeCode = 0xd9;
  else if (combined.includes("0xdb")) typeCode = 0xdb;
  else if (combined.includes("0xda")) typeCode = 0xda;
  else if (
    (device.platform === "midea" || modelLower.startsWith("midea.")) &&
    (combined.includes("washer") || device.name.includes("洗衣") || device.name.includes("可爱多"))
  ) {
    typeCode = 0xd9;
  }

  if (typeCode === null) return null;

  const fw = device.firmware || "";
  const sn8Match = /\b(\d{8})\b/.exec(fw);
  return {
    typeCode,
    sn8: sn8Match?.[1],
  };
}

function isWasherDevice(d: DeviceInfo): boolean {
  const s = `${d.name} ${d.model} ${d.spec_type}`.toLowerCase();
  return /washer|洗衣机|洗烘|可爱多|0xd9|0xda|0xdb/.test(s);
}

function isDryerDevice(d: DeviceInfo): boolean {
  const s = `${d.name} ${d.model} ${d.spec_type}`.toLowerCase();
  return /dryer|干衣机|烘干机|0xdc/.test(s);
}

function isVacuumDevice(d: DeviceInfo): boolean {
  const s = `${d.name} ${d.model} ${d.spec_type}`.toLowerCase();
  return /vacuum|扫地|拖地|扫拖/.test(s);
}

function isIrrigationDevice(d: DeviceInfo): boolean {
  const s = `${d.name} ${d.model} ${d.spec_type}`.toLowerCase();
  return /灌溉|浇花|浇水|喷灌|滴灌|水阀|irrigation|valve/.test(s);
}

function isFeederDevice(d: DeviceInfo): boolean {
  const s = `${d.name} ${d.model} ${d.spec_type}`.toLowerCase();
  return /feeder|喂食器|投喂|出粮/.test(s);
}

function isAcDevice(d: DeviceInfo): boolean {
  const s = `${d.name} ${d.model} ${d.spec_type}`.toLowerCase();
  return /air-conditioner|aircondition|air_condition|空调|0xac/.test(s);
}

function isDehumidifierDevice(d: DeviceInfo): boolean {
  const s = `${d.name} ${d.model} ${d.spec_type}`.toLowerCase();
  return /dehumidifier|除湿机|0xa1/.test(s);
}

function isCurtainDevice(d: DeviceInfo): boolean {
  const s = `${d.name} ${d.model} ${d.spec_type}`.toLowerCase();
  return /curtain|窗帘/.test(s);
}

function isWaterHeaterDevice(d: DeviceInfo): boolean {
  const s = `${d.name} ${d.model} ${d.spec_type}`.toLowerCase();
  return /water-heater|water_heater|热水器|0xe2|0xe3/.test(s);
}

/**
 * 构建家庭设备特殊能力摘要（支持美的 0xD9 三筒/双筒/叠放洗烘机、干衣机、灌溉、扫地机、喂食器等）。
 * 计算确定性 `topologyHash` 供强化记忆检测设备拓扑漂移，并生成面向 SystemOne 的紧凑能力清单。
 */
export function buildHomeCapabilityDigest(
  devices: readonly DeviceInfo[],
  nowMs = Date.now(),
): HomeCapabilityDigest {
  const entries: HomeCapabilityEntry[] = [];
  const summaryLines: string[] = [];
  const nameBuckets = new Map<string, Array<{ did: string; homeName: string; roomName: string; name: string }>>();

  const sorted = [...devices].sort((a, b) => a.did.localeCompare(b.did));

  for (const device of sorted) {
    if (device.online) {
      const key = device.name.trim().toLowerCase();
      if (key) {
        const list = nameBuckets.get(key) ?? [];
        list.push({
          did: device.did,
          homeName: device.home_name || "",
          roomName: device.room_name || "",
          name: device.name,
        });
        nameBuckets.set(key, list);
      }
    }

    const locPrefix = [device.home_name, device.room_name].filter(Boolean).join("/");
    const displayName = locPrefix ? `${locPrefix}/${device.name}` : device.name;

    // 1. 洗衣机（重点识别美的 0xD9 三筒：袜子筒/内裤筒/主洗烘筒）
    const mideaWasher = extractMideaWasherMeta(device);
    if (mideaWasher) {
      const profile = resolveMideaWasherProfile(mideaWasher.typeCode, { sn8: mideaWasher.sn8 });
      const drumSummaries: string[] = [];

      for (const drum of profile.drums) {
        const opts = getWasherProgramOptions(mideaWasher.typeCode, drum.key, { sn8: mideaWasher.sn8 });
        const optValues = new Set(opts.map((o) => String(o.value)));

        if (drum.label.includes("袜子") || optValues.has("socks")) {
          entries.push({
            did: device.did,
            name: device.name,
            homeName: device.home_name || "",
            roomName: device.room_name || "",
            online: device.online,
            category: "washer",
            capabilityKey: `${device.did}#${drum.key}:socks`,
            drumKey: drum.key,
            drumLabel: drum.label,
            program: "socks",
            programLabel: "袜子洗",
            summary: `${displayName} 有「${drum.label}」（程序 socks，支持自动洗袜子）`,
            affordanceTokens: ["袜子", "臭袜子", "长袜", "短袜", "船袜", "丝袜", "运动袜", "socks"],
            verbTokens: ["洗", "清洗", "开启", "启动", "打开", "开", "洗一下", "洗洗", "洗个", "洗一洗"],
          });
          drumSummaries.push(`${drum.label}(socks)`);
        }

        if (drum.label.includes("内裤") || optValues.has("underpants") || optValues.has("bra")) {
          entries.push({
            did: device.did,
            name: device.name,
            homeName: device.home_name || "",
            roomName: device.room_name || "",
            online: device.online,
            category: "washer",
            capabilityKey: `${device.did}#${drum.key}:underpants`,
            drumKey: drum.key,
            drumLabel: drum.label,
            program: "underpants",
            programLabel: "内裤洗",
            summary: `${displayName} 有「${drum.label}」（程序 underpants/bra，支持洗内裤/内衣/文胸）`,
            affordanceTokens: ["内裤", "内衣", "文胸", "胸罩", "小裤裤", "底裤", "贴身衣物", "bra", "underpants"],
            verbTokens: ["洗", "清洗", "开启", "启动", "打开", "开", "洗一下", "洗洗", "洗个"],
          });
          drumSummaries.push(`${drum.label}(underpants/bra)`);
        }

        if (drum.key === "bottom" || drum.key === "main") {
          entries.push({
            did: device.did,
            name: device.name,
            homeName: device.home_name || "",
            roomName: device.room_name || "",
            online: device.online,
            category: "washer",
            capabilityKey: `${device.did}#${drum.key}:laundry`,
            drumKey: drum.key,
            drumLabel: drum.label,
            program: optValues.has("smart_wash_dry") ? "smart_wash_dry" : "mixed_wash",
            programLabel: optValues.has("smart_wash_dry") ? "智洗烘" : "混合洗",
            summary: `${displayName}「${drum.label}」支持常规洗衣/洗烘`,
            affordanceTokens: ["衣服", "衣物", "床单", "被套", "外套", "羽绒服", "衬衫", "牛仔裤", "洗衣服"],
            verbTokens: ["洗", "清洗", "开启", "启动", "洗烘", "烘干", "甩干", "脱水"],
          });
          drumSummaries.push(`${drum.label}`);
        }
      }

      if (device.online && drumSummaries.length > 0) {
        summaryLines.push(`洗衣机「${displayName}」[${drumSummaries.join(" / ")}]`);
      }
      continue;
    }

    if (isWasherDevice(device)) {
      entries.push({
        did: device.did,
        name: device.name,
        homeName: device.home_name || "",
        roomName: device.room_name || "",
        online: device.online,
        category: "washer",
        capabilityKey: `${device.did}#main:laundry`,
        drumKey: "main",
        drumLabel: "主筒",
        summary: `${displayName} 支持洗衣控制`,
        affordanceTokens: ["衣服", "衣物", "床单", "被套", "袜子", "内衣", "洗衣服"],
        verbTokens: ["洗", "清洗", "开启", "启动", "脱水", "甩干"],
      });
      if (device.online) {
        summaryLines.push(`洗衣机「${displayName}」`);
      }
      continue;
    }

    // 2. 独立干衣机
    if (isDryerDevice(device)) {
      entries.push({
        did: device.did,
        name: device.name,
        homeName: device.home_name || "",
        roomName: device.room_name || "",
        online: device.online,
        category: "dryer",
        capabilityKey: `${device.did}#dryer`,
        summary: `${displayName} 支持烘干衣物/床品`,
        affordanceTokens: ["衣服", "衣物", "被子", "毛巾", "床单", "袜子", "干衣", "烘干"],
        verbTokens: ["烘", "烘干", "烘一下", "弄干", "吹干", "烤干", "开", "启动"],
      });
      if (device.online) {
        summaryLines.push(`干衣机「${displayName}」支持烘干衣物`);
      }
      continue;
    }

    // 3. 扫地/拖地机器人
    if (isVacuumDevice(device)) {
      entries.push({
        did: device.did,
        name: device.name,
        homeName: device.home_name || "",
        roomName: device.room_name || "",
        online: device.online,
        category: "vacuum",
        capabilityKey: `${device.did}#vacuum`,
        summary: `${displayName} 支持自动扫地/拖地/清扫地板`,
        affordanceTokens: ["地", "地板", "地面", "扫地", "拖地", "吸尘", "清扫", "客厅地", "卧室地"],
        verbTokens: ["扫", "拖", "吸", "清扫", "打扫", "清理", "擦地", "开", "启动"],
      });
      if (device.online) {
        summaryLines.push(`扫地机器人「${displayName}」支持扫地/拖地`);
      }
      continue;
    }

    // 4. 智能灌溉/浇花水阀
    if (isIrrigationDevice(device)) {
      entries.push({
        did: device.did,
        name: device.name,
        homeName: device.home_name || "",
        roomName: device.room_name || "",
        online: device.online,
        category: "irrigation",
        capabilityKey: `${device.did}#irrigation`,
        summary: `${displayName} 支持自动浇花/浇水/灌溉`,
        affordanceTokens: ["花", "花草", "盆栽", "植物", "菜", "院子", "草坪", "灌溉", "浇花", "浇水"],
        verbTokens: ["浇", "浇一下", "浇点水", "浇水", "灌溉", "喷水", "开", "关", "停"],
      });
      if (device.online) {
        summaryLines.push(`智能灌溉「${displayName}」支持浇花/浇水`);
      }
      continue;
    }

    // 5. 智能宠物喂食器
    if (isFeederDevice(device)) {
      entries.push({
        did: device.did,
        name: device.name,
        homeName: device.home_name || "",
        roomName: device.room_name || "",
        online: device.online,
        category: "feeder",
        capabilityKey: `${device.did}#feeder`,
        summary: `${displayName} 支持自动喂猫/喂狗/出粮`,
        affordanceTokens: ["猫", "猫咪", "小猫", "狗", "狗狗", "小狗", "宠物", "主子", "猫粮", "狗粮", "粮", "喂食"],
        verbTokens: ["喂", "喂一下", "投喂", "放粮", "出粮", "加粮", "来份", "给点"],
      });
      if (device.online) {
        summaryLines.push(`智能喂食器「${displayName}」支持自动喂猫/喂狗/出粮`);
      }
      continue;
    }

    // 6. 除湿机 / 空调 / 窗帘 / 热水器（用于隐式环境体感意图）
    if (isDehumidifierDevice(device)) {
      entries.push({
        did: device.did,
        name: device.name,
        homeName: device.home_name || "",
        roomName: device.room_name || "",
        online: device.online,
        category: "dehumidifier",
        capabilityKey: `${device.did}#dehumidifier`,
        summary: `${displayName} 支持除湿/干衣模式`,
        affordanceTokens: ["潮湿", "好潮", "太潮", "湿气", "回南天", "除湿", "发霉"],
        verbTokens: ["除", "抽", "降", "太", "好", "有点", "开", "关"],
        implicitOnly: true,
      });
      if (device.online) summaryLines.push(`除湿机「${displayName}」`);
    } else if (isAcDevice(device)) {
      entries.push({
        did: device.did,
        name: device.name,
        homeName: device.home_name || "",
        roomName: device.room_name || "",
        online: device.online,
        category: "ac",
        capabilityKey: `${device.did}#ac`,
        summary: `${displayName} 支持制冷/制热/调温`,
        affordanceTokens: ["太热", "好热", "有点热", "太冷", "好冷", "有点冷", "闷热"],
        verbTokens: ["太", "好", "有点", "凉快", "暖和", "开", "关"],
        implicitOnly: true,
      });
    } else if (isCurtainDevice(device)) {
      entries.push({
        did: device.did,
        name: device.name,
        homeName: device.home_name || "",
        roomName: device.room_name || "",
        online: device.online,
        category: "curtain",
        capabilityKey: `${device.did}#curtain`,
        summary: `${displayName} 支持开关窗帘/遮光`,
        affordanceTokens: ["太晒", "好晒", "刺眼", "阳光太强", "遮阳", "遮光", "透透气"],
        verbTokens: ["拉", "遮", "挡", "开", "关", "太", "好"],
        implicitOnly: true,
      });
    } else if (isWaterHeaterDevice(device)) {
      entries.push({
        did: device.did,
        name: device.name,
        homeName: device.home_name || "",
        roomName: device.room_name || "",
        online: device.online,
        category: "water_heater",
        capabilityKey: `${device.did}#water_heater`,
        summary: `${displayName} 支持烧热水/预热`,
        affordanceTokens: ["热水", "洗澡水", "烧水", "热水器"],
        verbTokens: ["烧", "加热", "预热", "开", "关", "调"],
      });
      if (device.online) summaryLines.push(`热水器「${displayName}」`);
    }
  }

  const duplicateNameGroups: HomeCapabilityDigest["duplicateNameGroups"] = {};
  for (const [key, list] of nameBuckets.entries()) {
    if (list.length > 1) {
      duplicateNameGroups[key] = list;
    }
  }

  const hashSeed = entries
    .map((e) => `${e.capabilityKey}:${e.homeName}:${e.roomName}:${e.online ? 1 : 0}`)
    .sort()
    .join("|");

  return {
    generatedAt: nowMs,
    topologyHash: fnv1aHash(hashSeed || "empty"),
    summaryLines: summaryLines.slice(0, 14),
    entries,
    duplicateNameGroups,
  };
}

/**
 * 将自然语言口语指令规范化为稳定的 CanonicalIntent（供记忆匹配、去重与 SystemOne 协同）。
 */
export function canonicalizeImplicitIntent(rawText: string, homeNames: readonly string[] = []): CanonicalIntent {
  const original = String(rawText ?? "").trim();
  const stripped = original
    .replace(FILLER_PREFIX_RE, "")
    .replace(FILLER_SUFFIX_RE, "")
    .replace(/[。！!？?，,、；;：:"'“”‘’]+/g, "")
    .replace(/\s+/g, "")
    .trim();

  const vetoedByNonDeviceChore = NON_DEVICE_CHORE_VETO_RE.test(original);
  const looksNarrative =
    !/(?:帮我|给我|替我|请你?|麻烦|开启|启动|打开|关闭|关掉|停掉|开始)/.test(original) &&
    NARRATIVE_NON_COMMAND_RE.test(original);

  let roomHint: string | null = null;
  for (const room of COMMON_ROOMS) {
    if (original.includes(room)) {
      roomHint = room;
      break;
    }
  }

  let homeHint: string | null = null;
  for (const home of homeNames) {
    const trimmed = home.trim();
    if (trimmed && original.includes(trimmed)) {
      homeHint = trimmed;
      break;
    }
  }

  const hasExplicitDeviceOrDrum =
    /(?:洗衣机|可爱多|左筒|右筒|下筒|上筒|袜子筒|内裤筒|干衣机|烘干机|扫地机|扫地机器人|喂食器|灌溉|水阀|空调|除湿机|窗帘|热水器)/.test(
      original,
    );

  // 规则化映射到稳定的 canonicalKey（保证“帮我洗一下袜子”/“洗个袜子”/“袜子洗一下”归并到同一键）
  const rules: Array<{
    test: RegExp;
    domain: string;
    action: string;
    target: string;
    phrase: string;
  }> = [
    {
      test: /(?:洗|清洗|洗一下|洗洗|洗个|开启|启动).*(?:袜子|臭袜子|长袜|短袜|船袜|运动袜)|(?:袜子|臭袜子|长袜|短袜).*(?:洗|清洗|洗一下|洗洗)/,
      domain: "laundry",
      action: "wash",
      target: "socks",
      phrase: "洗袜子",
    },
    {
      test: /(?:洗|清洗|洗一下|洗洗|洗个|开启|启动).*(?:内裤|小裤裤|底裤)|(?:内裤|小裤裤|底裤).*(?:洗|清洗|洗一下|洗洗)/,
      domain: "laundry",
      action: "wash",
      target: "underpants",
      phrase: "洗内裤",
    },
    {
      test: /(?:洗|清洗|洗一下|洗洗|洗个|开启|启动).*(?:文胸|胸罩|内衣|贴身衣物)|(?:文胸|胸罩|内衣|贴身衣物).*(?:洗|清洗|洗一下|洗洗)/,
      domain: "laundry",
      action: "wash",
      target: "bra",
      phrase: "洗内衣",
    },
    {
      test: /(?:烘|烘干|烘一下|弄干|吹干).*(?:衣服|衣物|床单|被套|毛巾|袜子)|(?:衣服|衣物|床单|被套|毛巾|袜子).*(?:烘干|烘一下)/,
      domain: "dryer",
      action: "dry",
      target: "clothes",
      phrase: "烘干衣物",
    },
    {
      test: /(?:洗|清洗|洗一下|洗洗).*(?:衣服|衣物|床单|被套|外套|羽绒服|衬衫|牛仔裤)|(?:衣服|衣物|床单|被套).*(?:洗|洗一下)/,
      domain: "laundry",
      action: "wash",
      target: "clothes",
      phrase: "洗衣服",
    },
    {
      test: /(?:扫地|拖地|擦地|吸尘|打扫(?:一下)?(?:地|地板|地面|客厅|卧室|房间)|清扫(?:一下)?(?:地|地板|地面|客厅|卧室|房间)|(?:扫|拖)(?:一下)?(?:地|地板|地面))/,
      domain: "vacuum",
      action: "clean",
      target: "floor",
      phrase: "扫地拖地",
    },
    {
      test: /(?:停|关|关闭|关掉|停止).*(?:浇花|浇水|灌溉|水阀)|(?:浇花|浇水|灌溉|水阀).*(?:停|关|关闭|关掉|停止)/,
      domain: "irrigation",
      action: "stop_water",
      target: "plants",
      phrase: "停止浇花",
    },
    {
      test: /(?:浇花|浇水|灌溉|(?:浇|喷)(?:一下|点水)?(?:花|花草|盆栽|植物|菜|院子|草坪)|给(?:花|盆栽|植物|菜|草坪)浇(?:一下)?水)/,
      domain: "irrigation",
      action: "water",
      target: "plants",
      phrase: "浇花",
    },
    {
      test: /(?:喂猫|喂狗|喂宠物|喂主子|喂一下(?:猫|狗|宠物|主子)|给(?:猫|猫咪|小猫|狗|狗狗|小狗|宠物|主子)(?:喂|放|出|加|来)(?:一下|点|份)?(?:粮|饭|吃的)?|(?:出|放)点?(?:猫|狗)?粮)/,
      domain: "feeder",
      action: "feed",
      target: "pet",
      phrase: "喂宠物",
    },
    {
      test: /(?:太潮|好潮|有点潮|湿气(?:太|好)?重|回南天|屋里太湿|房间太潮)/,
      domain: "climate",
      action: "dehumidify",
      target: "room",
      phrase: "房间除湿",
    },
    {
      test: /(?:太热|好热|有点热|闷热|热死了)/,
      domain: "climate",
      action: "cool",
      target: "room",
      phrase: "房间降温",
    },
    {
      test: /(?:太冷|好冷|有点冷|冷死了)/,
      domain: "climate",
      action: "heat",
      target: "room",
      phrase: "房间升温",
    },
    {
      test: /(?:太晒|好晒|阳光太(?:强|刺眼)|有点刺眼)/,
      domain: "curtain",
      action: "close",
      target: "sunlight",
      phrase: "拉窗帘遮光",
    },
  ];

  for (const rule of rules) {
    if (rule.test.test(original)) {
      const scopeSuffix = [homeHint, roomHint].filter(Boolean).join(":");
      const canonicalKey = scopeSuffix
        ? `implicit:${rule.domain}:${rule.action}:${rule.target}@${scopeSuffix}`
        : `implicit:${rule.domain}:${rule.action}:${rule.target}`;
      return {
        rawText: original,
        cleanedText: stripped,
        canonicalKey,
        normalizedPhrase: scopeSuffix ? `${scopeSuffix}${rule.phrase}` : rule.phrase,
        domain: rule.domain,
        action: rule.action,
        target: rule.target,
        roomHint,
        homeHint,
        hasExplicitDeviceOrDrum,
        vetoedByNonDeviceChore,
        looksNarrative,
      };
    }
  }

  const fallbackKey = stripped.toLowerCase().slice(0, 32) || fnv1aHash(original);
  return {
    rawText: original,
    cleanedText: stripped,
    canonicalKey: `utterance:${fallbackKey}`,
    normalizedPhrase: stripped || original,
    domain: "general",
    action: "unknown",
    target: "unknown",
    roomHint,
    homeHint,
    hasExplicitDeviceOrDrum,
    vetoedByNonDeviceChore,
    looksNarrative,
  };
}

/**
 * 同步快速判断：一句话是否命中当前家庭设备的真实能力（用于 VoiceAttentionGate、AudioSourceSeparator 与 SystemOne 协同）。
 * 严格拒绝非设备家务（洗碗/做饭/倒垃圾）及明显过去/未来闲聊叙事。
 */
export function probeImplicitCapabilities(
  text: string,
  digest: HomeCapabilityDigest | null | undefined,
): ImplicitCapabilityMatch | null {
  if (!digest || digest.entries.length === 0) return null;
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 80) return null;

  const homeNames = Array.from(new Set(digest.entries.map((e) => e.homeName).filter(Boolean)));
  const intent = canonicalizeImplicitIntent(trimmed, homeNames);

  if (intent.vetoedByNonDeviceChore || intent.looksNarrative) {
    return null;
  }

  // 仅考虑在线设备；若所有匹配设备都离线，返回 null 避免语音闸门误放行无意义的闲聊
  const onlineEntries = digest.entries.filter((e) => e.online);
  if (onlineEntries.length === 0) return null;

  // 先按 canonical intent 精准路由
  let matched: HomeCapabilityEntry[] = [];
  if (intent.canonicalKey.startsWith("implicit:")) {
    if (intent.domain === "laundry" && intent.target === "socks") {
      // 优先选择具有专用袜子筒/socks 程序的洗衣机；若家中仅有普通洗衣机，也作为备选
      const dedicated = onlineEntries.filter(
        (e) => e.category === "washer" && (e.program === "socks" || e.drumLabel?.includes("袜子")),
      );
      matched = dedicated.length > 0 ? dedicated : onlineEntries.filter((e) => e.category === "washer");
    } else if (intent.domain === "laundry" && (intent.target === "underpants" || intent.target === "bra")) {
      const dedicated = onlineEntries.filter(
        (e) =>
          e.category === "washer" &&
          (e.program === "underpants" || e.program === "bra" || e.drumLabel?.includes("内裤")),
      );
      matched = dedicated.length > 0 ? dedicated : onlineEntries.filter((e) => e.category === "washer");
    } else if (intent.domain === "laundry" && intent.target === "clothes") {
      matched = onlineEntries.filter(
        (e) => e.category === "washer" && (e.drumKey === "bottom" || e.drumKey === "main"),
      );
    } else if (intent.domain === "dryer") {
      matched = onlineEntries.filter((e) => e.category === "dryer");
    } else if (intent.domain === "vacuum") {
      matched = onlineEntries.filter((e) => e.category === "vacuum");
    } else if (intent.domain === "irrigation") {
      matched = onlineEntries.filter((e) => e.category === "irrigation");
    } else if (intent.domain === "feeder") {
      matched = onlineEntries.filter((e) => e.category === "feeder");
    } else if (intent.domain === "climate" && intent.action === "dehumidify") {
      matched = onlineEntries.filter((e) => e.category === "dehumidifier");
    } else if (intent.domain === "climate" && (intent.action === "cool" || intent.action === "heat")) {
      matched = onlineEntries.filter((e) => e.category === "ac");
    } else if (intent.domain === "curtain") {
      matched = onlineEntries.filter((e) => e.category === "curtain");
    }
  } else {
    // 兜底：词项共现（必须同时命中 affordanceToken 和 verbToken，且排除纯陈述/疑问）
    const lower = trimmed.toLowerCase();
    matched = onlineEntries.filter((e) => {
      if (e.implicitOnly) return false;
      const hasAffordance = e.affordanceTokens.some((tok) => lower.includes(tok.toLowerCase()));
      if (!hasAffordance) return false;
      return e.verbTokens.some((v) => lower.includes(v.toLowerCase()));
    });
  }

  if (matched.length === 0) return null;

  // 若句子中带家庭/房间提示，先收窄候选集
  if (intent.homeHint) {
    const byHome = matched.filter((e) => e.homeName === intent.homeHint);
    if (byHome.length > 0) matched = byHome;
  }
  if (intent.roomHint) {
    const byRoom = matched.filter((e) => e.roomName.includes(intent.roomHint!));
    if (byRoom.length > 0) matched = byRoom;
  }

  // 按 did 去重（同一设备可能有多个筒）
  const uniqueDids = Array.from(new Set(matched.map((e) => e.did)));
  const ambiguousDevices = uniqueDids.length > 1;
  const primaryCandidate = ambiguousDevices ? null : matched[0] ?? null;

  const suggestedQuestion = buildSuggestedConfirmationQuestion(intent, matched, ambiguousDevices);
  const matchedCapabilityLabel = primaryCandidate
    ? `${primaryCandidate.name}${primaryCandidate.drumLabel ? `·${primaryCandidate.drumLabel}` : ""}`
    : matched.map((e) => `${e.homeName ? `${e.homeName}/` : ""}${e.name}`).slice(0, 2).join(" / ");

  return {
    intent,
    matchedEntries: matched,
    ambiguousDevices,
    primaryCandidate,
    suggestedQuestion,
    matchedCapabilityLabel,
  };
}

function formatEntryDisplay(entry: HomeCapabilityEntry, includeHome: boolean): string {
  const loc = includeHome
    ? [entry.homeName, entry.roomName].filter(Boolean).join("的")
    : entry.roomName;
  const base = loc ? `${loc}「${entry.name}」` : `「${entry.name}」`;
  return entry.drumLabel ? `${base}的${entry.drumLabel}` : base;
}

function buildSuggestedConfirmationQuestion(
  intent: CanonicalIntent,
  matched: HomeCapabilityEntry[],
  ambiguousDevices: boolean,
): string {
  if (ambiguousDevices) {
    const distinctHomes = new Set(matched.map((e) => e.homeName).filter(Boolean));
    const includeHome = distinctHomes.size > 1;
    const labels = matched.slice(0, 3).map((e) => formatEntryDisplay(e, includeHome));
    return `家里有多台可用设备（${labels.join("、")}），确认一下你想用哪一台${intent.normalizedPhrase}？`;
  }

  const c = matched[0];
  if (!c) return `确认一下，需要为你执行「${intent.normalizedPhrase}」吗？`;

  const display = formatEntryDisplay(c, false);
  if (c.category === "washer" && c.program === "socks") {
    return `确认一下，是要用${display}（袜子洗程序）帮你洗袜子吗？`;
  }
  if (c.category === "washer" && (c.program === "underpants" || c.program === "bra")) {
    return `确认一下，是要用${display}帮你${intent.normalizedPhrase}吗？`;
  }
  if (c.category === "irrigation" && intent.action === "water") {
    return `确认一下，要开启${display}开始浇水吗？（涉及出水，执行前需确认）`;
  }
  if (c.category === "dryer") {
    return `确认一下，要启动${display}烘干衣物吗？（涉及加热，执行前需确认）`;
  }
  if (c.category === "vacuum") {
    return `确认一下，要让${display}开始清扫地面吗？`;
  }
  if (c.category === "feeder") {
    return `确认一下，要用${display}出粮投喂吗？`;
  }
  return `确认一下，是要用${display}为你${intent.normalizedPhrase}吗？`;
}

/**
 * 布尔快捷判断：文本是否匹配家庭真实设备能力（用于语音闸门与音频分离器）。
 */
export function matchesCapabilityAffordance(
  text: string,
  digest: HomeCapabilityDigest | null | undefined,
): boolean {
  return probeImplicitCapabilities(text, digest) !== null;
}
