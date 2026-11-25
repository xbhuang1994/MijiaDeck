// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * 内置零 API Key 本地智能家居规划引擎（实现 Pi Agent 的 StreamFn 协议）。
 *
 * 运行在真实的 @earendil-works/pi-agent-core Agent 循环内：
 * - 第一轮：将自然语言（支持中文/英文、复合多步骤指令、上下文指代“它”）规划为标准 ToolCall 列表，
 *   交由 pi-agent-core 执行已注册的智能家居 AgentTool；
 * - 第二轮：根据 AgentLoop 回传的 ToolResultMessage 汇总生成自然简洁、适合语音播报的中文回复。
 */

import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type JsonObject,
  type Message,
  type Model,
  type TextContent,
  type ToolCall,
  type ToolResultMessage,
  type TranscriptContext,
  type Usage,
} from "@earendil-works/pi-ai";
import type { DeviceInfo, PropInfo, SceneInfo } from "../core/models.ts";
import { isLight } from "../core/deviceControls.ts";
import { isSpeaker } from "../core/models.ts";
import {
  DEFAULT_CAVEMAN_MODE,
  normalizeCavemanMode,
  sanitizeForVoiceTts,
  type CavemanReplyMode,
} from "./cavemanReplyPolicy.ts";

export type ImplicitActionLabel =
  | "light_brighter"
  | "light_dimmer"
  | "speaker_quieter"
  | "speaker_louder"
  | "power_off"
  | "power_on"
  | "query_status"
  | "needs_llm_agent";

export interface LocalPlannerDeps {
  getDevices(): readonly DeviceInfo[];
  getScenes(): readonly SceneInfo[];
  getKnownPower(): Readonly<Record<string, boolean | null>>;
  getCavemanMode?: () => CavemanReplyMode;
  classifyImplicitAction?: (utterance: string) => Promise<ImplicitActionLabel | null>;
}

export type LocalPlannerContextProvider = LocalPlannerDeps;

export interface PlannedCall {
  name: string;
  arguments: JsonObject;
}

const SMART_HOME_FAST_ENTITY_RE =
  /(?:设备|吸顶灯|吊灯|主灯|射灯|灯带|台灯|照明|电灯|灯光|灯|空调|风扇|窗帘|插座|开关|音箱|音响|小爱|电视|净化器|加湿器|除湿|扫地|摄像头|摄像机|监控|温湿度|温度|湿度|传感|喂食|出粮|场景|模式|房间|客厅|卧室|主卧|次卧|餐厅|书房|厨房|阳台|走廊|玄关|卫生间|浴室|家里|全屋|全部|所有|音量|声音|亮度|色温|音乐|歌曲|light|lamp|speaker|music|volume|device|room)/i;

/**
 * 借鉴 Home Assistant `assist_pipeline` `prefer_local_intents` 设计：
 * 在调用云端大模型前先以零延迟判断该指令是否可由确定性本地智能家居规则完整覆盖。
 * - 若所有子句均可确定性执行（开关、调光、音箱控制、喂食、场景、设备查询等），直接返回工具调用列表；
 * - 若包含任何非确定性/口语隐式/开放式问答子句，返回 null 交由云端大模型处理。
 */
export function planDeterministicLocalCalls(
  userText: string,
  deps: Pick<LocalPlannerDeps, "getDevices" | "getScenes">,
  recentTarget: string | null = null,
): PlannedCall[] | null {
  const trimmed = userText.trim();
  if (!trimmed || trimmed.length > 48 || isGreetingOrHelp(trimmed)) {
    return null;
  }

  const devices = deps.getDevices();
  const scenes = deps.getScenes();
  const clauses = splitCompoundClauses(trimmed);
  if (clauses.length === 0 || clauses.length > 3) {
    return null;
  }

  const planned: PlannedCall[] = [];
  for (const clause of clauses) {
    const call = planSingleClause(clause, devices, scenes, recentTarget);
    if (!call) {
      return null;
    }
    // 防止开放式中文问句（如“今天天气怎么样”）误落入 list_devices 或未知 target 的 set_device_power
    if (call.name === "list_devices" && !SMART_HOME_FAST_ENTITY_RE.test(clause)) {
      return null;
    }
    if (call.name === "set_device_power") {
      const hasKnownRoom = Boolean(call.arguments.room);
      const hasKnownCategory = Boolean(call.arguments.category);
      const targetStr = typeof call.arguments.target === "string" ? call.arguments.target : "";
      const matchedKnownDevice =
        Boolean(targetStr) &&
        (targetStr === recentTarget ||
          devices.some((d) => d.did === targetStr || d.name === targetStr));
      if (!matchedKnownDevice && !hasKnownRoom && !hasKnownCategory && !SMART_HOME_FAST_ENTITY_RE.test(clause)) {
        return null;
      }
    }
    planned.push(call);
  }

  return planned.length > 0 ? planned : null;
}

export function findRecentDeviceFromMessages(messages: readonly Message[]): string | null {
  return findRecentDeviceFromTranscript(messages);
}

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const CN_DIGIT_MAP: Record<string, number> = {
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
};

function parseChineseNumber(raw: string): number | null {
  const num = Number(raw);
  if (Number.isFinite(num)) return num;
  const trimmed = raw.trim();
  if (trimmed in CN_DIGIT_MAP) return CN_DIGIT_MAP[trimmed]!;
  const tenMatch = /^([一二两三四五六七八九])?十([一二三四五六七八九])?$/.exec(trimmed);
  if (tenMatch) {
    const tens = tenMatch[1] ? CN_DIGIT_MAP[tenMatch[1]] ?? 1 : 1;
    const ones = tenMatch[2] ? CN_DIGIT_MAP[tenMatch[2]] ?? 0 : 0;
    return tens * 10 + ones;
  }
  return null;
}

function extractUserText(msg: Message): string {
  if (msg.role !== "user") return "";
  if (typeof msg.content === "string") return msg.content;
  return msg.content
    .filter((b): b is TextContent => b.type === "text")
    .map((b) => b.text)
    .join(" ");
}

function extractToolResultText(msg: ToolResultMessage): string {
  return msg.content
    .filter((b): b is TextContent => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/[的\s\-_·.,，。！？!?“”"'`（）()]/g, "");
}

function findRecentDeviceFromTranscript(messages: readonly Message[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i]!;
    if (msg.role === "toolResult" && !msg.isError && msg.details && typeof msg.details === "object") {
      const details = msg.details as Record<string, unknown>;
      if (typeof details.did === "string" && details.did) return details.did;
      if (typeof details.name === "string" && details.name) return details.name;
      if (Array.isArray(details.succeeded) && details.succeeded.length > 0) {
        const first = details.succeeded[0] as Record<string, unknown>;
        if (typeof first.did === "string" && first.did) return first.did;
      }
    }
  }
  return null;
}

function splitCompoundClauses(input: string): string[] {
  const cleaned = input.trim().replace(/[。！!？?]+$/g, "");
  if (!cleaned) return [];
  // 先按中文/英文连接词拆分为独立子指令，避免误拆包含“和”的“温度和湿度”查询
  if (/温.*和.*湿|温度和湿度/.test(cleaned)) {
    return [cleaned];
  }
  const parts = cleaned
    .split(/(?:[，,;；]|(?:并且|而且|然后|同时|顺便|再把|再帮我|(?<!不要|别|不|没|无)再|并(?=[把将打关开调设执切给让停暂播继]))|\band\b|\bthen\b)/i)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return parts.length > 0 ? parts : [cleaned];
}

function detectRoom(clause: string, devices: readonly DeviceInfo[]): string | undefined {
  const rooms = [...new Set(devices.map((d) => d.room_name).filter(Boolean))].sort(
    (a, b) => b.length - a.length,
  );
  for (const room of rooms) {
    if (clause.includes(room)) {
      return room;
    }
  }
  return undefined;
}

function detectNamedDevice(clause: string, devices: readonly DeviceInfo[]): DeviceInfo | undefined {
  const normClause = normalize(clause);
  const sorted = [...devices].sort((a, b) => b.name.length - a.name.length);
  for (const d of sorted) {
    const normName = normalize(d.name);
    if (normName.length >= 2 && normClause.includes(normName)) {
      return d;
    }
  }
  // 常见简称匹配（如“客厅灯” -> “客厅吸顶灯”、“喂食器” -> “智能宠物喂食器”、“温湿度” -> “卧室米家温湿度计”）
  const room = detectRoom(clause, devices);
  if (/(吸顶灯|吊灯|主灯|射灯|灯带|台灯|照明|电灯|灯光|灯)/.test(clause)) {
    const roomLights = devices.filter(
      (d) =>
        (!room || d.room_name === room) &&
        (isLight(d) || (d.switch_channels.length === 0 && /灯/.test(d.name))),
    );
    if (roomLights.length === 1) return roomLights[0];
    const specific = roomLights.find((d) => {
      if (clause.includes("吸顶灯") && d.name.includes("吸顶灯")) return true;
      if (clause.includes("主灯") && d.name.includes("主灯")) return true;
      if (clause.includes("射灯") && d.name.includes("射灯")) return true;
      if (clause.includes("灯带") && d.name.includes("灯带")) return true;
      return false;
    });
    if (specific) return specific;
    if (roomLights.length > 0 && !/(全部|所有|全屋)/.test(clause)) {
      return roomLights.find((d) => isLight(d)) ?? roomLights[0];
    }
  }
  if (/(喂食器|喂食|出粮|猫粮|狗粮|宠粮)/.test(clause)) {
    return devices.find(
      (d) => d.model.includes("feeder") || d.spec_type.includes("feeder") || d.name.includes("喂食"),
    );
  }
  if (/(温湿度|温度计|湿度计|几度|温度|湿度)/.test(clause)) {
    const sensors = devices.filter(
      (d) =>
        (!room || d.room_name === room) &&
        ((Array.isArray(d.metric_features) && d.metric_features.length > 0) ||
          d.model.includes("sensor") ||
          d.name.includes("温湿度")),
    );
    if (sensors.length > 0) return sensors[0];
  }
  if (/(音箱|小爱|音响|音量|声音|静音|上一首|上一曲|下一首|下一曲|切歌|换一首|换首歌|暂停|播放|播报|朗读|音乐|歌曲|放歌)/.test(clause)) {
    const speakers = devices.filter((d) => isSpeaker(d));
    if (speakers.length > 0) {
      return speakers.find((d) => (!room || d.room_name === room) && d.online) ?? speakers[0];
    }
  }
  if (/(摄像头|摄像机|监控)/.test(clause)) {
    const cams = devices.filter(
      (d) =>
        (!room || d.room_name === room) &&
        (d.model.includes("camera") || d.spec_type.includes("camera") || d.name.includes("摄像")),
    );
    if (cams.length > 0) return cams[0];
  }
  return undefined;
}

function detectScene(clause: string, scenes: readonly SceneInfo[]): SceneInfo | undefined {
  const normClause = normalize(clause);
  const sorted = [...scenes].sort((a, b) => b.name.length - a.name.length);
  for (const sc of sorted) {
    const normName = normalize(sc.name);
    if (normName.length >= 2 && normClause.includes(normName)) {
      return sc;
    }
  }
  return undefined;
}

const RE_GREETING_OR_HELP =
  /^(?:你好|您好|hi|hello|你是谁|你能做什么|你会做什么|有什么功能|帮助|help|在吗|小派)[，,！!？?。\s]*$/i;

function isGreetingOrHelp(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  return RE_GREETING_OR_HELP.test(trimmed);
}

function findLatestUserText(messages: readonly Message[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i]!;
    if (msg.role === "user") {
      return extractUserText(msg).trim();
    }
  }
  return "";
}

function joinDeviceLabel(name: string, tail: string): string {
  if (!tail) return name;
  const needsSpace = /[A-Za-z0-9]$/.test(name) || /^[A-Za-z0-9]/.test(tail);
  return needsSpace ? `${name} ${tail}` : `${name}${tail}`;
}

function formatPropUnit(unit?: string | null): string {
  if (unit === "celsius") return "°C";
  if (unit === "percentage") return "%";
  if (unit === "kelvin") return "K";
  return unit ? ` ${unit}` : "";
}

function pickTargetLight(
  clause: string,
  devices: readonly DeviceInfo[],
  knownPower: Readonly<Record<string, boolean | null>>,
  recentTarget: string | null,
  preferState?: boolean,
): DeviceInfo | undefined {
  const lights = devices.filter(
    (d) => isLight(d) || (d.switch_channels.length === 0 && /灯/.test(d.name)),
  );
  if (lights.length === 0) return undefined;

  const named = detectNamedDevice(clause, lights);
  if (named) return named;

  const room = detectRoom(clause, lights);
  const roomPool = room ? lights.filter((d) => d.room_name === room) : lights;
  const pool = roomPool.length > 0 ? roomPool : lights;

  if (recentTarget) {
    const recent = pool.find((d) => (d.did === recentTarget || d.name === recentTarget) && d.online);
    if (recent) return recent;
  }
  if (preferState !== undefined) {
    const byState = pool.find((d) => d.online && isLight(d) && knownPower[d.did] === preferState)
      ?? pool.find((d) => d.online && knownPower[d.did] === preferState);
    if (byState) return byState;
  }
  return pool.find((d) => d.online && isLight(d)) ?? pool.find((d) => d.online) ?? pool[0];
}

function pickTargetSpeaker(
  clause: string,
  devices: readonly DeviceInfo[],
  recentTarget: string | null,
): DeviceInfo | undefined {
  const speakers = devices.filter((d) => isSpeaker(d));
  if (speakers.length === 0) return undefined;

  const named = detectNamedDevice(clause, speakers);
  if (named) return named;

  const room = detectRoom(clause, speakers);
  if (room) {
    const inRoom = speakers.find((d) => d.room_name === room && d.online)
      ?? speakers.find((d) => d.room_name === room);
    if (inRoom) return inRoom;
  }
  if (recentTarget) {
    const recent = speakers.find((d) => (d.did === recentTarget || d.name === recentTarget) && d.online);
    if (recent) return recent;
  }
  return speakers.find((d) => d.online) ?? speakers[0];
}

function mapImplicitActionToToolCall(
  label: ImplicitActionLabel,
  clause: string,
  devices: readonly DeviceInfo[],
  knownPower: Readonly<Record<string, boolean | null>>,
  recentTarget: string | null,
): PlannedCall | null {
  switch (label) {
    case "light_dimmer": {
      const light = pickTargetLight(clause, devices, knownPower, recentTarget, true);
      if (!light) return null;
      return { name: "control_light", arguments: { target: light.did, brightness: 35 } };
    }
    case "light_brighter": {
      const light = pickTargetLight(clause, devices, knownPower, recentTarget, false);
      if (!light) return null;
      return { name: "control_light", arguments: { target: light.did, on: true, brightness: 85 } };
    }
    case "speaker_quieter": {
      const spk = pickTargetSpeaker(clause, devices, recentTarget);
      return {
        name: "control_speaker",
        arguments: { ...(spk ? { target: spk.did } : {}), volume_delta: -15 },
      };
    }
    case "speaker_louder": {
      const spk = pickTargetSpeaker(clause, devices, recentTarget);
      return {
        name: "control_speaker",
        arguments: { ...(spk ? { target: spk.did } : {}), volume_delta: 15 },
      };
    }
    case "power_off":
    case "power_on": {
      const state = label === "power_off" ? "off" : "on";
      const named = detectNamedDevice(clause, devices);
      if (named) {
        return { name: "set_device_power", arguments: { target: named.did, state } };
      }
      const room = detectRoom(clause, devices);
      if (room) {
        return { name: "set_device_power", arguments: { room, state } };
      }
      if (recentTarget) {
        return { name: "set_device_power", arguments: { target: recentTarget, state } };
      }
      const light = pickTargetLight(clause, devices, knownPower, recentTarget, state === "off");
      if (light) {
        return { name: "set_device_power", arguments: { target: light.did, state } };
      }
      return { name: "set_device_power", arguments: { category: "light", state } };
    }
    case "query_status": {
      const named = detectNamedDevice(clause, devices);
      if (named) {
        return { name: "get_device_detail", arguments: { target: named.did } };
      }
      const room = detectRoom(clause, devices);
      const sensor = devices.find(
        (d) =>
          (!room || d.room_name === room) &&
          d.online &&
          ((Array.isArray(d.metric_features) && d.metric_features.length > 0) ||
            d.model.includes("sensor") ||
            d.name.includes("温湿度")),
      );
      if (sensor && /(冷|热|干|闷|潮|湿|暖|温)/.test(clause)) {
        return { name: "get_device_detail", arguments: { target: sensor.did } };
      }
      return { name: "list_devices", arguments: room ? { room } : {} };
    }
    case "needs_llm_agent":
    default:
      return null;
  }
}

function resolveSpeakerArg(clause: string, devices: readonly DeviceInfo[]): DeviceInfo | undefined {
  const speakers = devices.filter((d) => isSpeaker(d));
  if (speakers.length === 0) return undefined;
  const normClause = normalize(clause);
  const sorted = [...speakers].sort((a, b) => b.name.length - a.name.length);
  for (const s of sorted) {
    const normName = normalize(s.name);
    if (normName.length >= 2 && normClause.includes(normName)) {
      return s;
    }
  }
  const room = detectRoom(clause, speakers);
  if (room) {
    return (
      speakers.find((d) => d.room_name === room && d.online) ??
      speakers.find((d) => d.room_name === room)
    );
  }
  return undefined;
}

const RE_SPEAKER_CANCEL_PAUSE = /(?:取消暂停|解除暂停)/;

const RE_SPEAKER_STOP_PLAYBACK =
  /(?:(?:停止|终止|结束|停掉|停了|停一下|停下)(?:当前|正在)?(?:播放|放歌|放音乐|播歌|播音乐|听歌|听音乐|音乐|歌曲|唱歌|歌|(?:小爱|小米)?(?:音箱|音响)(?:播放)?|小爱播放)|(?:音乐|歌曲|播放|放歌|背景音乐|歌).{0,8}(?:停止|停掉|停了|停一下|停下|结束|终止|关掉|关闭|关了)|(?:关闭|关掉)(?:当前|正在播放的)?(?:音乐|歌曲|播放|放歌|背景音乐)|关了(?:当前|正在播放的)?(?:音乐|歌曲|背景音乐)|(?:不要|别|不再|不用|不想|不)(?:让(?:小爱|小米)?(?:音箱|音响)|让小爱)?(?:再)?(?:继续)?(?:播放|播歌|播音乐|放歌|放音乐|听歌|听音乐|(?:播|放)这首(?:歌)?|放了|播了)|(?:小爱|小米)?(?:音箱|音响)(?:停止|停掉|停了|停一下|停下)(?:播放)?|^(?:请|帮我|麻烦|先|现在|快)?(?:停止|停一下|停下|停了吧|停吧)(?:吧|呀|哦)?$|\b(?:stop\s+(?:the\s+)?(?:music|song|songs|playing|playback|audio|speaker)|turn\s+off\s+(?:the\s+)?music|shut\s+off\s+(?:the\s+)?music)\b|^(?:please\s+)?stop(?:\s+it|\s+now)?$)/i;

const RE_SPEAKER_PAUSE_PLAYBACK =
  /(?:暂停(?:当前|正在)?(?:播放|音乐|歌曲|放歌|放音乐|音箱|音响|小爱|一下)|(?:音乐|歌曲|播放|歌|音箱|音响).{0,6}暂停|^(?:请|帮我|麻烦|先|现在)?暂停(?:一下|吧|呀|哦)?$|\bpause\s+(?:the\s+)?(?:music|song|songs|playing|playback|audio|speaker)\b|^(?:please\s+)?pause(?:\s+it|\s+now)?$)/i;

const RE_SPEAKER_RESUME_PLAYBACK =
  /(?:取消暂停|解除暂停|继续播放|继续放歌|继续听歌|恢复播放|开始播放|播放音乐|播放歌曲|放歌|放音乐|播音乐|^(?:请|帮我|麻烦)?(?:继续|播放)(?:一下|吧|呀|哦)?$|^(?:please\s+)?(?:resume(?:\s+(?:the\s+)?(?:music|playback|playing))?|continue\s+playing|play(?:\s+(?:the\s+)?music)?)$)/i;

const RE_GENERIC_MUSIC_TARGET = /^(?:音乐|歌曲|歌|一下)?(?:吧|呀|哦|啊)?$/;

const RE_NEGATIVE_BEFORE_PLAY =
  /(?:停止|暂停|终止|结束|停掉|停了|关闭|关掉|不要|别|不再|不用|不想|不).{0,8}(?:播放|放一首|点一首|放首|来一首|放歌|放音乐|播音乐)/;

function planSingleClause(
  clause: string,
  devices: readonly DeviceInfo[],
  scenes: readonly SceneInfo[],
  recentTarget: string | null,
): PlannedCall | null {

  // 1. 明确转发小爱指令（排除“让小爱音箱/音响…”这类明确指定音箱设备的本地控制语句）
  const xiaoaiMatch = /^(?:让小爱(?!音箱|音响)|叫小爱(?!音箱|音响)|问小爱|对小爱说|小爱同学[,，:\s]*)(.+)$/.exec(clause);
  if (xiaoaiMatch && xiaoaiMatch[1]?.trim()) {
    return {
      name: "send_xiaoai_command",
      arguments: { text: xiaoaiMatch[1].trim() },
    };
  }

  // 2. 查看场景列表 / 执行场景
  if (/(有哪些场景|查看场景|列出场景|场景列表)/.test(clause)) {
    return { name: "list_scenes", arguments: {} };
  }
  const matchedScene = detectScene(clause, scenes);
  if (matchedScene && /(执行|启动|运行|开启|切换|打开|模式|场景|^)/.test(clause)) {
    // 防止“回家模式”等直接命中场景名
    if (/(执行|启动|运行|触发|模式|场景)/.test(clause) || normalize(clause) === normalize(matchedScene.name)) {
      return {
        name: "run_scene",
        arguments: { target: matchedScene.scene_id },
      };
    }
  }

  // 3. 宠物喂食器出粮
  if (/(喂食|出粮|喂猫|喂狗|投喂)/.test(clause)) {
    const feeder = detectNamedDevice(clause, devices);
    const portionMatch = /([0-9]+|[一二两三四五六七八九十]+)\s*份/.exec(clause);
    const parsedPortions = portionMatch ? parseChineseNumber(portionMatch[1]!) : 1;
    const portions = Math.max(1, Math.min(20, parsedPortions ?? 1));
    return {
      name: "run_device_action",
      arguments: {
        target: feeder?.did ?? "智能宠物喂食器",
        action: "pet-food-out",
        params: [portions],
      },
    };
  }

  // 4. 音箱播报 / 播放控制（切歌、停止、暂停优先于播放/点歌，避免“停止播放音乐”误命中“播放音乐”）/ 音量与静音
  const speakMatch = /(?:用音箱|用音响|让音箱|小爱)?(?:朗读|播报|念一下|说一句)[：:\s“"]*(.+?)[”"]*$/.exec(clause);
  if (speakMatch && speakMatch[1]?.trim()) {
    const spk = resolveSpeakerArg(clause, devices);
    return {
      name: "control_speaker",
      arguments: {
        ...(spk ? { target: spk.did } : {}),
        speak_text: speakMatch[1].trim(),
      },
    };
  }
  if (/(?:上一首|上一曲|^(?:play\s+)?(?:previous|prev)(?:\s+(?:song|track|music))?$)/i.test(clause)) {
    const spk = resolveSpeakerArg(clause, devices);
    return { name: "control_speaker", arguments: { ...(spk ? { target: spk.did } : {}), playback: "previous" } };
  }
  if (/(?:下一首|下一曲|切歌|换一首|换首歌|^(?:play\s+)?next(?:\s+(?:song|track|music))?$)/i.test(clause)) {
    const spk = resolveSpeakerArg(clause, devices);
    return { name: "control_speaker", arguments: { ...(spk ? { target: spk.did } : {}), playback: "next" } };
  }
  const isCancelPause = RE_SPEAKER_CANCEL_PAUSE.test(clause);
  if (!isCancelPause && RE_SPEAKER_STOP_PLAYBACK.test(clause)) {
    const spk = resolveSpeakerArg(clause, devices);
    return { name: "control_speaker", arguments: { ...(spk ? { target: spk.did } : {}), playback: "stop" } };
  }
  if (!isCancelPause && RE_SPEAKER_PAUSE_PLAYBACK.test(clause)) {
    const spk = resolveSpeakerArg(clause, devices);
    return { name: "control_speaker", arguments: { ...(spk ? { target: spk.did } : {}), playback: "pause" } };
  }
  const musicMatch = /(?:用(?:小米|小爱)?(?:音箱|音响)|让(?:小米|小爱)?(?:音箱|音响))?(?:播放|放一首|点一首|放首|来一首)\s*(.+)$/.exec(clause);
  if (
    musicMatch &&
    musicMatch[1]?.trim() &&
    !RE_NEGATIVE_BEFORE_PLAY.test(clause) &&
    !RE_GENERIC_MUSIC_TARGET.test(musicMatch[1].trim())
  ) {
    const spk = resolveSpeakerArg(clause, devices);
    return {
      name: "control_speaker",
      arguments: {
        ...(spk ? { target: spk.did } : {}),
        play_music: musicMatch[1].trim(),
      },
    };
  }
  if (!RE_NEGATIVE_BEFORE_PLAY.test(clause) && RE_SPEAKER_RESUME_PLAYBACK.test(clause)) {
    const spk = resolveSpeakerArg(clause, devices);
    return { name: "control_speaker", arguments: { ...(spk ? { target: spk.did } : {}), playback: "play" } };
  }
  if (/(取消静音|解除静音|恢复声音)/.test(clause)) {
    const spk = resolveSpeakerArg(clause, devices);
    return {
      name: "control_speaker",
      arguments: { ...(spk ? { target: spk.did } : {}), mute: false },
    };
  }
  if (/(静音|闭嘴|mute)/i.test(clause)) {
    const spk = resolveSpeakerArg(clause, devices);
    return {
      name: "control_speaker",
      arguments: { ...(spk ? { target: spk.did } : {}), mute: true },
    };
  }
  if (/(音量|声音)/.test(clause)) {
    const spk = resolveSpeakerArg(clause, devices);
    const numMatch = /(\d{1,3})\s*%?/.exec(clause);
    if (numMatch) {
      return {
        name: "control_speaker",
        arguments: {
          ...(spk ? { target: spk.did } : {}),
          volume: Math.max(0, Math.min(100, Number(numMatch[1]))),
        },
      };
    }
    if (/(大一点|调大|调高|提高|升高)/.test(clause)) {
      return {
        name: "control_speaker",
        arguments: { ...(spk ? { target: spk.did } : {}), volume_delta: 15 },
      };
    }
    if (/(小一点|调小|调低|降低)/.test(clause)) {
      return {
        name: "control_speaker",
        arguments: { ...(spk ? { target: spk.did } : {}), volume_delta: -15 },
      };
    }
    if (/(最大|满)/.test(clause)) {
      return {
        name: "control_speaker",
        arguments: { ...(spk ? { target: spk.did } : {}), volume: 100 },
      };
    }
    if (/(最小|最低)/.test(clause)) {
      return {
        name: "control_speaker",
        arguments: { ...(spk ? { target: spk.did } : {}), volume: 10 },
      };
    }
  }

  // 5. 灯光精细控制（亮度 / 色温 / 颜色 / 模式）
  const hasBrightness = /(亮度|调亮|调暗|亮一点|暗一点|最亮|最暗|brightness)/i.test(clause);
  const hasTemp = /(色温|暖光|暖色|冷光|冷色|白光|自然光|中性光|\d{4}\s*k)/i.test(clause);
  const colorMatch = /(红色|橙色|橘色|黄色|暖黄|绿色|青色|蓝色|紫色|粉色|白色|暖白|冷白|#[0-9a-f]{6})/i.exec(clause);
  const modeMatch = /(日光|月光|阅读|影院)(?:模式)?/.exec(clause);

  if (hasBrightness || hasTemp || colorMatch || modeMatch) {
    const lightDev =
      detectNamedDevice(clause, devices.filter((d) => isLight(d))) ??
      detectNamedDevice(clause, devices) ??
      (recentTarget ? devices.find((d) => d.did === recentTarget || d.name === recentTarget) : undefined) ??
      devices.find((d) => isLight(d) && d.online);

    const args: JsonObject = { target: lightDev?.did ?? lightDev?.name ?? "客厅吸顶灯" };

    if (hasBrightness) {
      const pctMatch = /(?:亮度|调到|调至|设为|设置为|到|至)\s*(\d{1,3})\s*%?/.exec(clause) ?? /(\d{1,3})\s*%/.exec(clause);
      if (pctMatch) {
        args.brightness = Math.max(1, Math.min(100, Number(pctMatch[1])));
      } else if (/(最亮|全亮|拉满)/.test(clause)) {
        args.brightness = 100;
      } else if (/(最暗|微亮|夜灯)/.test(clause)) {
        args.brightness = 10;
      } else if (/(亮一点|调亮|提高亮度)/.test(clause)) {
        args.brightness = 85;
      } else if (/(暗一点|调暗|降低亮度)/.test(clause)) {
        args.brightness = 35;
      }
    }

    if (hasTemp) {
      const kMatch = /(\d{4})\s*k?/i.exec(clause);
      if (kMatch) {
        args.color_temperature = Number(kMatch[1]);
      } else if (/(暖光|暖色|温馨)/.test(clause)) {
        args.temperature_preset = "warm";
      } else if (/(冷光|冷色|白光|明亮)/.test(clause)) {
        args.temperature_preset = "cool";
      } else if (/(自然光|中性光)/.test(clause)) {
        args.temperature_preset = "neutral";
      }
    }

    if (colorMatch) {
      args.color = colorMatch[1]!;
    }

    if (modeMatch) {
      args.mode = modeMatch[1]!;
    }

    return { name: "control_light", arguments: args };
  }

  // 6. 传感器 / 设备状态查询
  if (/(几度|多少度|温度|湿度|电量|状态|开着吗|关着吗|详情|参数|怎么样)/.test(clause) && !/(打开|关闭|关掉|开启|切换)/.test(clause)) {
    const dev = detectNamedDevice(clause, devices);
    if (dev) {
      return { name: "get_device_detail", arguments: { target: dev.did } };
    }
    const room = detectRoom(clause, devices);
    return { name: "list_devices", arguments: room ? { room } : {} };
  }

  if (/(有哪些设备|设备列表|查看设备|列出设备|所有设备|家里有什么|看看.*设备)/.test(clause)) {
    const room = detectRoom(clause, devices);
    const args: JsonObject = {};
    if (room) args.room = room;
    if (/(灯|照明)/.test(clause)) args.category = "light";
    else if (/(传感器|温湿度)/.test(clause)) args.category = "sensor";
    else if (/(音箱)/.test(clause)) args.category = "speaker";
    return { name: "list_devices", arguments: args };
  }

  // 7. 开关控制（单设备或按房间/类别批量开关）
  const isTurnOff = /(关闭|关掉|关上|关了|熄灭|休眠|关一下|\bturn\s+off\b|\bswitch\s+off\b|^关(?![于注]))/i.test(clause);
  const isTurnOn = /(打开|开启|开一下|开了|点亮|唤醒|\bturn\s+on\b|\bswitch\s+on\b|^开(?![始发]))/i.test(clause);
  const isToggle = /(切换|翻转|toggle)/i.test(clause);

  if (isTurnOff || isTurnOn || isToggle) {
    const state = isTurnOff ? "off" : isTurnOn ? "on" : "toggle";
    const room = detectRoom(clause, devices);
    const isBatchAll = /(全部|所有|全屋|都)/.test(clause);
    const mentionsLight = /(灯光?|电灯|照明|射灯|灯带|\blights?\b)/i.test(clause);

    // 批量控制：如“关闭餐厅所有灯”、“打开全部灯”、“关闭全屋设备”
    if (isBatchAll) {
      const args: JsonObject = { state };
      if (room) args.room = room;
      if (mentionsLight) args.category = "light";
      return { name: "set_device_power", arguments: args };
    }

    // 指代上一轮设备（“把它关了”/“打开它”）
    if (/(把它|将它|它)/.test(clause) && recentTarget) {
      return { name: "set_device_power", arguments: { target: recentTarget, state } };
    }

    const dev = detectNamedDevice(clause, devices);
    if (dev) {
      return { name: "set_device_power", arguments: { target: dev.did, state } };
    }

    if (room) {
      const args: JsonObject = { state, room };
      if (mentionsLight) args.category = "light";
      return { name: "set_device_power", arguments: args };
    }

    // 提取残余目标名称交由 set_device_power 模糊解析
    const stripped = clause
      .replace(/^(?:请|帮我|麻烦|把|将|给|我要|我想)?(?:打开|开启|关闭|关掉|关上|关了|切换|点亮|熄灭|turn\s+on|turn\s+off)\s*/i, "")
      .replace(/(?:打开|开启|关闭|关掉|关上|关了|一下|吧|哦|呀)$/g, "")
      .trim();
    if (stripped) {
      return { name: "set_device_power", arguments: { target: stripped, state } };
    }
  }

  // 8. 未命中确定性规则，交由上层判断问候/隐式意图分类/兜底
  return null;
}

function formatNaturalNameList(names: readonly string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]}和${names[1]}`;
  return `${names.slice(0, -1).join("、")}和${names[names.length - 1]}`;
}

function formatLightTempPresetZh(preset: unknown): string | null {
  if (preset === "warm") return "暖光";
  if (preset === "cool") return "冷白光";
  if (preset === "neutral") return "自然光";
  return null;
}

function formatSpeakerPowerNoteNatural(note: string, warm: boolean): string {
  if (note === "已静音暂停") return warm ? "已经暂停并静音了" : "已暂停并静音";
  if (note === "已唤醒") return warm ? "已经唤醒了" : "已唤醒";
  if (note === "已静音") return warm ? "已经静音了" : "已静音";
  if (note === "已暂停") return warm ? "已经暂停了" : "已暂停";
  return warm ? `${note.replace(/^已/, "已经")}了` : note;
}

interface SummarizedClause {
  text: string;
  isQuery: boolean;
  isError: boolean;
}

function summarizeSingleToolResult(
  res: ToolResultMessage,
  userText: string,
  mode: CavemanReplyMode,
): SummarizedClause {
  const raw = extractToolResultText(res);
  const d =
    res.details && typeof res.details === "object"
      ? (res.details as Record<string, unknown>)
      : null;

  const isUltra = mode === "ultra";
  const isWarm = mode === "lite" || mode === "off";

  if (res.isError) {
    const cleanErr = sanitizeForVoiceTts(raw) || "执行失败";
    if (isUltra) return { text: cleanErr, isQuery: false, isError: true };
    if (/^(抱歉|不好意思|对不起)/.test(cleanErr)) {
      return { text: cleanErr, isQuery: false, isError: true };
    }
    return {
      text: isWarm ? `抱歉，${cleanErr}` : cleanErr,
      isQuery: false,
      isError: true,
    };
  }

  // 1. 设备列表查询
  if (res.toolName === "list_devices" && d) {
    const items = Array.isArray(d.devices) ? (d.devices as Array<Record<string, unknown>>) : null;
    if (items) {
      if (items.length === 0) {
        return { text: isUltra ? "未找到设备" : "暂时没找到符合条件的设备", isQuery: true, isError: false };
      }
      const names = items.map((it) => String(it.name ?? "").trim()).filter(Boolean);
      if (isUltra) {
        if (names.length === 0) return { text: `共 ${items.length} 台设备`, isQuery: true, isError: false };
        const txt =
          names.length <= 4
            ? `共 ${items.length} 台：${names.join("、")}`
            : `共 ${items.length} 台：${names.slice(0, 3).join("、")}等`;
        return { text: txt, isQuery: true, isError: false };
      }
      if (names.length === 0) {
        return { text: `一共有${items.length}台设备`, isQuery: true, isError: false };
      }
      const listTxt =
        names.length <= 4
          ? formatNaturalNameList(names)
          : `${names.slice(0, 3).join("、")}等`;
      return {
        text: isWarm
          ? `一共找到${items.length}台设备，有${listTxt}`
          : `共有${items.length}台设备，包括${listTxt}`,
        isQuery: true,
        isError: false,
      };
    }
  }

  // 2. 场景列表查询
  if (res.toolName === "list_scenes" && d) {
    const items = Array.isArray(d.scenes) ? (d.scenes as Array<Record<string, unknown>>) : null;
    if (items) {
      if (items.length === 0) {
        return { text: isUltra ? "暂无手动场景" : "目前还没有可用的手动场景", isQuery: true, isError: false };
      }
      const names = items.map((it) => String(it.name ?? "").trim()).filter(Boolean);
      if (isUltra) {
        if (names.length === 0) return { text: `共 ${items.length} 个场景`, isQuery: true, isError: false };
        const txt =
          names.length <= 4
            ? `共 ${items.length} 个场景：${names.join("、")}`
            : `共 ${items.length} 个场景：${names.slice(0, 3).join("、")}等`;
        return { text: txt, isQuery: true, isError: false };
      }
      if (names.length === 0) {
        return { text: `共有${items.length}个手动场景`, isQuery: true, isError: false };
      }
      const listTxt =
        names.length <= 4
          ? formatNaturalNameList(names)
          : `${names.slice(0, 3).join("、")}等`;
      return {
        text: isWarm
          ? `现在有${items.length}个手动场景，分别是${listTxt}`
          : `共有${items.length}个场景，包括${listTxt}`,
        isQuery: true,
        isError: false,
      };
    }
  }

  // 3. 设备状态 / 传感器详情查询
  if (res.toolName === "get_device_detail" && d) {
    const name = typeof d.name === "string" && d.name.trim() ? d.name.trim() : "设备";
    const room = typeof d.room === "string" && d.room.trim() ? d.room.trim() : "";
    if (d.online === false) {
      return {
        text: isUltra ? joinDeviceLabel(name, "离线") : `${name}目前离线了`,
        isQuery: true,
        isError: false,
      };
    }
    const vals = (d.values && typeof d.values === "object" ? d.values : {}) as Record<string, unknown>;
    const props = Array.isArray(d.props) ? (d.props as PropInfo[]) : [];

    // 3.1 传感器温湿度摘要（仅当电量 < 20% 或用户明确询问电量时附带电量）
    const temp = vals["temperature"];
    const hum = vals["relative-humidity"] ?? vals["humidity"];
    const bat = vals["battery-level"] ?? vals["battery"];
    if (typeof temp === "number" || typeof hum === "number") {
      const askedBattery = /(电量|电池|还有多少电|剩多少电)/.test(userText);
      if (isUltra) {
        const sensorParts: string[] = [];
        if (typeof temp === "number") sensorParts.push(`${temp}°C`);
        if (typeof hum === "number") sensorParts.push(`湿度 ${hum}%`);
        if (typeof bat === "number" && (bat < 20 || askedBattery)) {
          sensorParts.push(`电量 ${bat}%`);
        }
        return { text: `${name} ${sensorParts.join("，")}`, isQuery: true, isError: false };
      }
      const subject = room && !askedBattery ? room : name;
      const sensorParts: string[] = [];
      if (typeof temp === "number") sensorParts.push(`温度${temp}°C`);
      if (typeof hum === "number") sensorParts.push(`湿度${hum}%`);
      if (typeof bat === "number" && (bat < 20 || askedBattery)) {
        sensorParts.push(bat < 20 && !askedBattery ? `另外电量偏低，只剩${bat}%了` : `电量${bat}%`);
      }
      const intro = isWarm ? `${subject}现在` : `${subject}当前`;
      return { text: `${intro}${sensorParts.join("，")}`, isQuery: true, isError: false };
    }

    // 3.2 灯具状态摘要
    const hasLightVals =
      typeof vals["brightness"] === "number" || typeof vals["color-temperature"] === "number";
    if (hasLightVals && typeof vals["on"] === "boolean") {
      if (isUltra) {
        if (!vals["on"]) return { text: joinDeviceLabel(name, "已关"), isQuery: true, isError: false };
        const lightParts: string[] = [];
        if (typeof vals["brightness"] === "number") lightParts.push(`亮度 ${vals["brightness"]}%`);
        if (typeof vals["color-temperature"] === "number") lightParts.push(`${vals["color-temperature"]}K`);
        return {
          text:
            lightParts.length > 0
              ? joinDeviceLabel(name, `已开，${lightParts.join("，")}`)
              : joinDeviceLabel(name, "已开"),
          isQuery: true,
          isError: false,
        };
      }
      if (!vals["on"]) {
        return { text: isWarm ? `${name}现在是关着的` : `${name}当前已关闭`, isQuery: true, isError: false };
      }
      const lightParts: string[] = [];
      if (typeof vals["brightness"] === "number") lightParts.push(`亮度${vals["brightness"]}%`);
      if (typeof vals["color-temperature"] === "number") lightParts.push(`色温${vals["color-temperature"]}K`);
      const onStr = isWarm ? `${name}现在是开着的` : `${name}当前已开启`;
      return {
        text: lightParts.length > 0 ? `${onStr}，${lightParts.join("，")}` : onStr,
        isQuery: true,
        isError: false,
      };
    }

    // 3.3 音箱 / 开关 / 通用设备摘要
    const speakerParts: string[] = [];
    if (typeof vals["volume"] === "number") {
      speakerParts.push(isUltra ? `音量 ${vals["volume"]}%` : `音量${vals["volume"]}%`);
    }
    if (vals["mute"] === true || vals["mute-2"] === true) {
      speakerParts.push(isWarm ? "目前处于静音状态" : "已静音");
    }
    if (speakerParts.length > 0) {
      return {
        text: isUltra
          ? `${name} ${speakerParts.join("，")}`
          : `${joinDeviceLabel(name, isWarm ? "现在" : "当前")}${speakerParts.join("，")}`,
        isQuery: true,
        isError: false,
      };
    }

    if (typeof vals["on"] === "boolean") {
      if (isUltra) return { text: joinDeviceLabel(name, vals["on"] ? "已开" : "已关"), isQuery: true, isError: false };
      return {
        text: vals["on"]
          ? isWarm
            ? `${name}现在是开着的`
            : `${name}当前已开启`
          : isWarm
            ? `${name}现在是关着的`
            : `${name}当前已关闭`,
        isQuery: true,
        isError: false,
      };
    }

    if (typeof bat === "number") {
      return {
        text: isUltra ? `${name} 电量 ${bat}%` : `${name}当前电量${bat}%`,
        isQuery: true,
        isError: false,
      };
    }

    if (typeof d.uiSummary === "string" && d.uiSummary.trim()) {
      return { text: sanitizeForVoiceTts(d.uiSummary), isQuery: true, isError: false };
    }

    const genericParts: string[] = [];
    for (const p of props) {
      const val = vals[p.name];
      if (val === undefined || val === null) continue;
      let formatted: string;
      if (typeof val === "boolean") {
        formatted = val ? "开" : "关";
      } else if (p.value_list) {
        const matchedOpt = p.value_list.find((o) => o.value === val);
        formatted = matchedOpt?.desc_zh_cn ?? matchedOpt?.description ?? String(val);
      } else {
        formatted = `${String(val)}${formatPropUnit(p.unit)}`;
      }
      genericParts.push(isUltra ? `${p.desc || p.name} ${formatted}` : `${p.desc || p.name}${formatted}`);
      if (genericParts.length >= 2) break;
    }
    if (genericParts.length > 0) {
      return {
        text: isUltra
          ? `${name} ${genericParts.join("，")}`
          : `${name}当前${genericParts.join("，")}`,
        isQuery: true,
        isError: false,
      };
    }
    return {
      text: isUltra ? joinDeviceLabel(name, "在线") : `${name}目前在线`,
      isQuery: true,
      isError: false,
    };
  }

  // 非 ultra 模式下，对控制类工具优先基于结构化 details 生成自然顺口的中文回复
  if (!isUltra && d) {
    // 4. 开关设备（单台 / 批量 / 音箱软开关）
    if (res.toolName === "set_device_power") {
      const succeeded = Array.isArray(d.succeeded)
        ? (d.succeeded as Array<{ name?: string; state?: boolean; note?: string }>)
        : [];
      const failed = Array.isArray(d.failed)
        ? (d.failed as Array<{ name?: string; reason?: string }>)
        : [];
      let okText = "";
      if (succeeded.length === 1) {
        const s = succeeded[0]!;
        const devName = s.name?.trim() || "设备";
        if (s.note) {
          okText = joinDeviceLabel(devName, formatSpeakerPowerNoteNatural(s.note, isWarm));
        } else if (s.state) {
          okText = isWarm ? `${devName}已经打开了` : `${devName}已打开`;
        } else {
          okText = isWarm ? `${devName}已经关掉了` : `${devName}已关闭`;
        }
      } else if (succeeded.length > 1) {
        const allPlain = succeeded.every((s) => !s.note);
        const allSameState = succeeded.every((s) => s.state === succeeded[0]!.state);
        const names = succeeded.map((s) => s.name?.trim() || "设备");
        if (allPlain && allSameState) {
          const isOn = Boolean(succeeded[0]!.state);
          const listStr =
            names.length <= 3
              ? formatNaturalNameList(names)
              : `${names.slice(0, 3).join("、")}等${names.length}台设备`;
          if (isWarm) {
            okText = isOn ? `已经打开${listStr}了` : `已经关掉${listStr}了`;
          } else {
            okText = isOn ? `已打开${listStr}` : `已关闭${listStr}`;
          }
        } else {
          const itemLabels = succeeded.slice(0, 3).map((s) => {
            const devName = s.name?.trim() || "设备";
            if (s.note) return joinDeviceLabel(devName, formatSpeakerPowerNoteNatural(s.note, false));
            return `${devName}${s.state ? "已打开" : "已关闭"}`;
          });
          okText =
            succeeded.length <= 3
              ? itemLabels.join("，")
              : `${itemLabels.join("，")}等${succeeded.length}台设备`;
        }
      }
      const failText =
        failed.length > 0
          ? failed
              .map((f) => {
                const devName = f.name?.trim() || "设备";
                if (f.reason === "离线" || f.reason === "设备已离线") {
                  return `${devName}当前离线`;
                }
                return `${devName}控制失败（${f.reason || "未知原因"}）`;
              })
              .join("，")
          : "";
      if (okText && failText) {
        return { text: `${okText}，不过${failText}`, isQuery: false, isError: false };
      }
      if (okText) {
        return { text: okText, isQuery: false, isError: false };
      }
      if (failText) {
        return { text: isWarm ? `抱歉，${failText}` : failText, isQuery: false, isError: true };
      }
    }

    // 5. 灯光精细控制（开关 / 亮度 / 色温预设或开尔文 / 颜色 / 模式）
    if (res.toolName === "control_light") {
      const name = typeof d.name === "string" && d.name.trim() ? d.name.trim() : "灯";
      if (d.on === false) {
        return {
          text: isWarm ? `${name}已经关掉了` : `${name}已关闭`,
          isQuery: false,
          isError: false,
        };
      }
      const turnedOn = d.turnedOn === true;
      const brightness = typeof d.brightness === "number" ? d.brightness : undefined;
      const presetLabel = formatLightTempPresetZh(d.temperaturePreset);
      const colorTemp = typeof d.colorTemperature === "number" ? d.colorTemperature : undefined;
      const color = typeof d.color === "string" && d.color.trim() ? d.color.trim() : undefined;
      const modeLabel = typeof d.mode === "string" && d.mode.trim() ? d.mode.trim() : undefined;

      const adjustClauses: string[] = [];
      if (brightness !== undefined) {
        adjustClauses.push(`亮度调到${brightness}%`);
      }
      if (presetLabel) {
        adjustClauses.push(`调成${presetLabel}`);
      } else if (colorTemp !== undefined) {
        adjustClauses.push(`色温调到${colorTemp}K`);
      }
      if (color) {
        adjustClauses.push(`调成${color}`);
      }
      if (modeLabel) {
        adjustClauses.push(`切到${modeLabel}`);
      }

      if (turnedOn && adjustClauses.length > 0) {
        const joined = adjustClauses.join("，");
        return {
          text: isWarm ? `已经打开${name}，并把${joined}了`.replace("并把调成", "并调成").replace("并把切到", "并切到") : `${name}已打开，${joined}`,
          isQuery: false,
          isError: false,
        };
      }
      if (turnedOn) {
        return {
          text: isWarm ? `${name}已经打开了` : `${name}已打开`,
          isQuery: false,
          isError: false,
        };
      }
      if (adjustClauses.length === 1) {
        const single = adjustClauses[0]!;
        if (brightness !== undefined) {
          return {
            text: isWarm ? `${name}亮度已经调到${brightness}%了` : `${name}亮度已调到${brightness}%`,
            isQuery: false,
            isError: false,
          };
        }
        if (presetLabel) {
          return {
            text: isWarm ? `${name}已经调成${presetLabel}了` : `${name}已调成${presetLabel}`,
            isQuery: false,
            isError: false,
          };
        }
        if (colorTemp !== undefined) {
          return {
            text: isWarm ? `${name}色温已经调到${colorTemp}K了` : `${name}色温已调到${colorTemp}K`,
            isQuery: false,
            isError: false,
          };
        }
        if (color) {
          return {
            text: isWarm ? `${name}已经调成${color}了` : `${name}已调成${color}`,
            isQuery: false,
            isError: false,
          };
        }
        if (modeLabel) {
          return {
            text: isWarm ? `${name}已经切到${modeLabel}了` : `${name}已切到${modeLabel}`,
            isQuery: false,
            isError: false,
          };
        }
        return {
          text: isWarm ? `${name}已经${single}了` : `${name}已${single}`,
          isQuery: false,
          isError: false,
        };
      }
      if (adjustClauses.length > 1) {
        const first = adjustClauses[0]!;
        const rest = adjustClauses.slice(1).join("，");
        if (isWarm) {
          const head = first.startsWith("亮度") || first.startsWith("色温")
            ? `${name}已经把${first}`
            : `${name}已经${first}`;
          return { text: `${head}，${rest}了`, isQuery: false, isError: false };
        }
        const head = first.startsWith("亮度") || first.startsWith("色温")
          ? `${name}${first.replace("调到", "已调到")}`
          : `${name}已${first}`;
        return { text: `${head}，${rest}`, isQuery: false, isError: false };
      }
    }

    // 6. 音箱控制
    if (res.toolName === "control_speaker") {
      const name = typeof d.name === "string" && d.name.trim() ? d.name.trim() : "音箱";
      const spkClauses: string[] = [];
      if (typeof d.powerNote === "string" && d.powerNote.trim()) {
        spkClauses.push(formatSpeakerPowerNoteNatural(d.powerNote.trim(), false));
      }
      if (typeof d.mute === "boolean") {
        spkClauses.push(d.mute ? "已静音" : "已取消静音");
      }
      if (typeof d.micMute === "boolean") {
        spkClauses.push(d.micMute ? "麦克风已静音" : "麦克风已开启");
      }
      if (typeof d.volume === "number") {
        spkClauses.push(`音量已调到${d.volume}%`);
      }
      if (typeof d.playMusic === "string" && d.playMusic.trim()) {
        spkClauses.push(isWarm ? `开始播放${d.playMusic.trim()}` : `正在播放${d.playMusic.trim()}`);
      }
      if (typeof d.playback === "string") {
        const pbMap: Record<string, string> = {
          play: "已继续播放",
          pause: "已暂停播放",
          stop: "已停止播放",
          next: "已切到下一首",
          previous: "已切到上一首",
        };
        spkClauses.push(pbMap[d.playback] ?? d.playback);
      }
      if (typeof d.speak_text === "string" && d.speak_text.trim()) {
        spkClauses.push("已完成播报");
      }
      if (spkClauses.length > 0) {
        const joined = spkClauses.join("，");
        if (!isWarm) {
          return { text: joinDeviceLabel(name, joined), isQuery: false, isError: false };
        }
        const warmJoined = joined
          .replace(/^已/, "已经")
          .replace(/^音量已/, "音量已经")
          .replace(/^麦克风已/, "麦克风已经");
        const suffix = warmJoined.endsWith("了") ? "" : "了";
        return { text: `${joinDeviceLabel(name, warmJoined)}${suffix}`, isQuery: false, isError: false };
      }
    }

    // 7. 场景执行
    if (res.toolName === "run_scene" && typeof d.name === "string" && d.name.trim()) {
      const sceneName = d.name.trim();
      return {
        text: isWarm ? `已经执行${sceneName}了` : `已执行${sceneName}`,
        isQuery: false,
        isError: false,
      };
    }

    // 8. 喂食器等设备动作
    if (res.toolName === "run_device_action") {
      const name = typeof d.name === "string" && d.name.trim() ? d.name.trim() : "设备";
      const paramsArr = Array.isArray(d.params) ? d.params : [];
      if (d.isFeederAction) {
        const portions = paramsArr[0];
        if (portions !== undefined && portions !== null) {
          return {
            text: isWarm ? `${name}已经出粮${portions}份了` : `${name}已出粮${portions}份`,
            isQuery: false,
            isError: false,
          };
        }
        return {
          text: isWarm ? `${name}已经出粮了` : `${name}已出粮`,
          isQuery: false,
          isError: false,
        };
      }
      if (typeof d.actionLabel === "string" && d.actionLabel.trim()) {
        return {
          text: isWarm
            ? `${name}已经执行${d.actionLabel.trim()}了`
            : `${name}已执行${d.actionLabel.trim()}`,
          isQuery: false,
          isError: false,
        };
      }
    }

    // 9. 转发小爱
    if (res.toolName === "send_xiaoai_command" && typeof d.text === "string" && d.text.trim()) {
      const directive = d.text.trim();
      return {
        text: isWarm ? `已经转告小爱${directive}了` : `已转告小爱${directive}`,
        isQuery: false,
        isError: false,
      };
    }

    // 10. 通用属性设置
    if (
      res.toolName === "set_device_property" &&
      typeof d.name === "string" &&
      typeof d.propLabel === "string" &&
      typeof d.displayVal === "string"
    ) {
      return {
        text: isWarm
          ? `${d.name}的${d.propLabel}已经设为${d.displayVal}了`
          : `${d.name}${d.propLabel}已设为${d.displayVal}`,
        isQuery: false,
        isError: false,
      };
    }
  }

  if (d && typeof d.uiSummary === "string" && d.uiSummary.trim()) {
    return { text: sanitizeForVoiceTts(d.uiSummary), isQuery: false, isError: false };
  }

  if (!raw) return { text: "", isQuery: false, isError: false };
  const cleaned = sanitizeForVoiceTts(raw);
  if (cleaned.length <= 160) return { text: cleaned, isQuery: false, isError: false };
  const firstClause = cleaned.split(/[。！？!?\n]/)[0]?.trim() ?? cleaned.slice(0, 140);
  return { text: firstClause.replace(/[:：]$/, ""), isQuery: false, isError: false };
}

export function summarizeToolResults(
  results: readonly ToolResultMessage[],
  userText = "",
  mode: CavemanReplyMode = DEFAULT_CAVEMAN_MODE,
): string {
  const effectiveMode = normalizeCavemanMode(mode, DEFAULT_CAVEMAN_MODE);
  const isUltra = effectiveMode === "ultra";
  const isWarm = effectiveMode === "lite" || effectiveMode === "off";

  if (results.length === 0) {
    return isWarm ? "好的，已经处理好了" : "已完成";
  }

  const clauses: SummarizedClause[] = [];
  for (const res of results) {
    const clause = summarizeSingleToolResult(res, userText, effectiveMode);
    if (clause.text.trim()) {
      clauses.push({ ...clause, text: clause.text.trim() });
    }
  }
  if (clauses.length === 0) {
    return isWarm ? "好的，已经处理好了" : "已完成";
  }

  const allNonQueryOk = clauses.every((c) => !c.isQuery && !c.isError);
  const lead = isWarm && allNonQueryOk ? "好的，" : "";

  if (clauses.length === 1) {
    const single = clauses[0]!.text;
    if (lead && !/^(好的|抱歉)/.test(single)) {
      return `${lead}${single}`;
    }
    return single;
  }

  const trimmedParts = clauses.map((c) => c.text.replace(/。+$/, ""));
  if (isUltra) {
    if (
      trimmedParts.length === 2 &&
      trimmedParts[0]!.length <= 18 &&
      trimmedParts[1]!.length <= 18 &&
      !trimmedParts[0]!.includes("；") &&
      !trimmedParts[1]!.includes("；") &&
      !trimmedParts[0]!.includes("，") &&
      !trimmedParts[1]!.includes("，")
    ) {
      return `${trimmedParts[0]}，${trimmedParts[1]}`;
    }
    return trimmedParts.join("；");
  }

  const joined =
    trimmedParts.length === 2 && !trimmedParts[0]!.includes("；") && !trimmedParts[1]!.includes("；")
      ? `${trimmedParts[0]}，${trimmedParts[1]}`
      : trimmedParts.join("；");
  return lead && !/^(好的|抱歉)/.test(joined) ? `${lead}${joined}` : joined;
}

function buildFinalReplyWithoutTools(
  userText: string,
  devices: readonly DeviceInfo[],
  mode: CavemanReplyMode,
  needsLlmHint = false,
): string {
  const effectiveMode = normalizeCavemanMode(mode, DEFAULT_CAVEMAN_MODE);
  if (needsLlmHint) {
    if (effectiveMode === "ultra") {
      return "本地引擎暂不支持，可切大模型处理";
    }
    if (effectiveMode === "full") {
      return "这条指令本地引擎暂时还处理不了，可以在设置里接入大模型试试。";
    }
    return "抱歉，这条指令本地引擎暂时还处理不了，你可以在设置里接入云端大模型后再试试。";
  }

  const trimmed = userText.trim();
  if (/^(你好|您好|hi|hello|在吗|小派)/i.test(trimmed)) {
    const onlineCount = devices.filter((d) => d.online).length;
    if (effectiveMode === "ultra") {
      return `在呢，${onlineCount}/${devices.length} 台设备在线，请说`;
    }
    if (effectiveMode === "full") {
      return `在呢，家里有${onlineCount}台设备在线，请说需要控制什么。`;
    }
    if (effectiveMode === "lite") {
      return `在呢，家里现在有${onlineCount}台设备在线，想控制什么直接告诉我。`;
    }
    return `你好呀！家里现在有${onlineCount}台设备在线（共${devices.length}台），直接说出想控制的设备就可以。`;
  }

  if (effectiveMode === "ultra") {
    return "支持开关、调光、音箱、喂食、场景和温湿度查询，请说指令";
  }
  if (effectiveMode === "full") {
    return "我可以帮你控制开关、调光调色、音箱、喂食器、场景和查温湿度，直接说指令就行。";
  }
  if (effectiveMode === "lite") {
    return "我可以帮你开关设备、调光调色、控制音箱、执行场景和查温湿度，直接告诉我你想做什么就行。";
  }
  return "我是 MijiaDeck 助手，可以帮你控制开关、调光调色、查温湿度、控制小爱音箱、喂食和执行场景；需要更复杂的对话也可以在设置里接入云端大模型。";
}

function pushTextStreamReply(
  stream: ReturnType<typeof createAssistantMessageEventStream>,
  model: Model<Api>,
  now: number,
  replyText: string,
): void {
  const partial: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "" }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: ZERO_USAGE,
    stopReason: "stop",
    timestamp: now,
  };
  stream.push({ type: "start", partial });
  stream.push({ type: "text_start", contentIndex: 0, partial });
  partial.content = [{ type: "text", text: replyText }];
  stream.push({ type: "text_delta", contentIndex: 0, delta: replyText, partial });
  stream.push({ type: "text_end", contentIndex: 0, content: replyText, partial });
  stream.push({ type: "done", reason: "stop", message: partial });
  stream.end();
}

/**
 * 创建内置本地规划引擎的 Pi Agent StreamFn。
 */
export function createLocalSmartHomeStreamFn(
  deps: LocalPlannerDeps,
): StreamFn {
  let callCounter = 0;

  return (model: Model<Api>, context: TranscriptContext) => {
    const stream = createAssistantMessageEventStream();

    queueMicrotask(() => {
      void (async () => {
        const now = Date.now();
        const messages = context.messages;
        const lastMsg = messages[messages.length - 1];
        const cavemanMode = normalizeCavemanMode(deps.getCavemanMode?.(), DEFAULT_CAVEMAN_MODE);

        // 情况 A：工具已执行完毕，根据本轮所有 toolResult 生成最终回复
        if (lastMsg && lastMsg.role === "toolResult") {
          const trailingResults: ToolResultMessage[] = [];
          for (let i = messages.length - 1; i >= 0; i -= 1) {
            const m = messages[i]!;
            if (m.role === "toolResult") {
              trailingResults.unshift(m);
            } else {
              break;
            }
          }

          const latestUserText = findLatestUserText(messages);
          const replyText = summarizeToolResults(trailingResults, latestUserText, cavemanMode);
          pushTextStreamReply(stream, model, now, replyText);
          return;
        }

        // 情况 B：收到新的用户指令，规划工具调用
        const userText = lastMsg ? extractUserText(lastMsg).trim() : "";
        const devices = deps.getDevices();
        const scenes = deps.getScenes();
        const knownPower = deps.getKnownPower();
        const recentTarget = findRecentDeviceFromTranscript(messages.slice(0, -1));

        if (isGreetingOrHelp(userText)) {
          const replyText = buildFinalReplyWithoutTools(userText, devices, cavemanMode, false);
          pushTextStreamReply(stream, model, now, replyText);
          return;
        }

        const clauses = splitCompoundClauses(userText);
        const planned: PlannedCall[] = [];
        let sawNeedsLlm = false;

        for (const clause of clauses) {
          const call = planSingleClause(clause, devices, scenes, recentTarget);
          if (call) {
            planned.push(call);
            continue;
          }
          if (isGreetingOrHelp(clause)) {
            continue;
          }
          if (deps.classifyImplicitAction) {
            let label: ImplicitActionLabel | null = null;
            try {
              label = await deps.classifyImplicitAction(clause);
            } catch {
              label = null;
            }
            if (label === "needs_llm_agent") {
              sawNeedsLlm = true;
            } else if (label) {
              const mapped = mapImplicitActionToToolCall(
                label,
                clause,
                devices,
                knownPower,
                recentTarget,
              );
              if (mapped) {
                planned.push(mapped);
              }
            }
          }
        }

        if (planned.length === 0) {
          if (sawNeedsLlm || isGreetingOrHelp(userText)) {
            const replyText = buildFinalReplyWithoutTools(userText, devices, cavemanMode, sawNeedsLlm);
            pushTextStreamReply(stream, model, now, replyText);
            return;
          }
          planned.push({ name: "list_devices", arguments: {} });
        }

        const toolCalls: ToolCall[] = planned.map((p) => {
          callCounter += 1;
          return {
            type: "toolCall",
            id: `local_call_${now}_${callCounter}`,
            name: p.name,
            arguments: p.arguments,
          };
        });

        const partial: AssistantMessage = {
          role: "assistant",
          content: [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: ZERO_USAGE,
          stopReason: "toolUse",
          timestamp: now,
        };
        stream.push({ type: "start", partial });

        toolCalls.forEach((tc, idx) => {
          partial.content = [...partial.content, tc];
          stream.push({ type: "toolcall_start", contentIndex: idx, partial });
          stream.push({
            type: "toolcall_delta",
            contentIndex: idx,
            delta: JSON.stringify(tc.arguments),
            partial,
          });
          stream.push({ type: "toolcall_end", contentIndex: idx, toolCall: tc, partial });
        });

        stream.push({ type: "done", reason: "toolUse", message: partial });
        stream.end();
      })().catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        const errMsg: AssistantMessage = {
          role: "assistant",
          content: [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: ZERO_USAGE,
          stopReason: "error",
          errorMessage: msg || "本地规划引擎执行异常",
          timestamp: Date.now(),
        };
        stream.push({ type: "error", reason: "error", error: errMsg });
        stream.end();
      });
    });

    return stream;
  };
}
