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
import type { DeviceInfo, SceneInfo } from "../core/models.ts";
import { isLight } from "../core/deviceControls.ts";
import { isSpeaker } from "../core/models.ts";

export interface LocalPlannerContextProvider {
  getDevices(): readonly DeviceInfo[];
  getScenes(): readonly SceneInfo[];
  getKnownPower(): Readonly<Record<string, boolean | null>>;
}

interface PlannedCall {
  name: string;
  arguments: JsonObject;
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
    .split(/(?:[，,;；]|(?:并且|而且|然后|同时|顺便|再把|再帮我|再|并(?=[把将打关开调设执切给让]))|\band\b|\bthen\b)/i)
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
  if (/(音箱|小爱|音响|音量|声音|静音|上一首|下一首|暂停|播放|播报|朗读)/.test(clause)) {
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

function planSingleClause(
  clause: string,
  devices: readonly DeviceInfo[],
  scenes: readonly SceneInfo[],
  recentTarget: string | null,
): PlannedCall | null {
  const lower = clause.toLowerCase();

  // 1. 明确转发小爱指令
  const xiaoaiMatch = /^(?:让小爱|叫小爱|问小爱|对小爱说|小爱同学[,，:\s]*)(.+)$/.exec(clause);
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

  // 4. 音箱播报 / 播放指定音乐 / 播放控制 / 音量与静音
  const speakMatch = /(?:用音箱|用音响|让音箱|小爱)?(?:朗读|播报|念一下|说一句)[：:\s“"]*(.+?)[”"]*$/.exec(clause);
  if (speakMatch && speakMatch[1]?.trim()) {
    const spk = detectNamedDevice(clause, devices);
    return {
      name: "control_speaker",
      arguments: {
        ...(spk ? { target: spk.did } : {}),
        speak_text: speakMatch[1].trim(),
      },
    };
  }
  const musicMatch = /(?:用(?:小米|小爱)?(?:音箱|音响)|让(?:小米|小爱)?(?:音箱|音响))?(?:播放|放一首|点一首|放首|来一首)\s*(.+)$/.exec(clause);
  if (musicMatch && musicMatch[1]?.trim() && !/^(音乐|一下)?$/.test(musicMatch[1].trim())) {
    const spk = detectNamedDevice(clause, devices);
    return {
      name: "control_speaker",
      arguments: {
        ...(spk ? { target: spk.did } : {}),
        play_music: musicMatch[1].trim(),
      },
    };
  }
  if (/(上一首|上一曲|previous)/i.test(clause)) {
    const spk = detectNamedDevice(clause, devices);
    return { name: "control_speaker", arguments: { ...(spk ? { target: spk.did } : {}), playback: "previous" } };
  }
  if (/(下一首|下一曲|切歌|next)/i.test(clause)) {
    const spk = detectNamedDevice(clause, devices);
    return { name: "control_speaker", arguments: { ...(spk ? { target: spk.did } : {}), playback: "next" } };
  }
  if (/(暂停播放|暂停音乐|暂停音箱|暂停音响|暂停一下|pause)/i.test(clause)) {
    const spk = detectNamedDevice(clause, devices);
    return { name: "control_speaker", arguments: { ...(spk ? { target: spk.did } : {}), playback: "pause" } };
  }
  if (/(继续播放|开始播放|播放音乐|恢复播放)/.test(clause)) {
    const spk = detectNamedDevice(clause, devices);
    return { name: "control_speaker", arguments: { ...(spk ? { target: spk.did } : {}), playback: "play" } };
  }
  if (/(取消静音|解除静音|恢复声音)/.test(clause)) {
    const spk = detectNamedDevice(clause, devices);
    return {
      name: "control_speaker",
      arguments: { ...(spk ? { target: spk.did } : {}), mute: false },
    };
  }
  if (/(静音|闭嘴|mute)/i.test(clause)) {
    const spk = detectNamedDevice(clause, devices);
    return {
      name: "control_speaker",
      arguments: { ...(spk ? { target: spk.did } : {}), mute: true },
    };
  }
  if (/(音量|声音)/.test(clause)) {
    const spk = detectNamedDevice(clause, devices);
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

  // 8. 兜底：若只是问候或能力询问，不调工具直接回复；否则查询设备列表帮助回答
  if (/^(你好|您好|hi|hello|你是谁|你能做什么|帮助|help|在吗|小派)/i.test(lower)) {
    return null;
  }

  return { name: "list_devices", arguments: {} };
}

function summarizeToolResults(results: readonly ToolResultMessage[]): string {
  if (results.length === 0) {
    return "已完成处理。";
  }
  const parts: string[] = [];
  for (const res of results) {
    const raw = extractToolResultText(res);
    if (!raw) continue;
    // 对传感器详情提取更口语化的温湿度摘要
    if (res.toolName === "get_device_detail" && !res.isError && res.details && typeof res.details === "object") {
      const d = res.details as Record<string, unknown>;
      const vals = (d.values && typeof d.values === "object" ? d.values : {}) as Record<string, unknown>;
      const name = typeof d.name === "string" ? d.name : "设备";
      const metrics: string[] = [];
      if (typeof vals["temperature"] === "number") metrics.push(`温度 ${vals["temperature"]}°C`);
      const hum = vals["relative-humidity"] ?? vals["humidity"];
      if (typeof hum === "number") metrics.push(`湿度 ${hum}%`);
      if (typeof vals["battery-level"] === "number") metrics.push(`电量 ${vals["battery-level"]}%`);
      if (typeof vals["on"] === "boolean") metrics.push(`开关${vals["on"] ? "已开启" : "已关闭"}`);
      if (typeof vals["brightness"] === "number") metrics.push(`亮度 ${vals["brightness"]}%`);
      if (typeof vals["color-temperature"] === "number") metrics.push(`色温 ${vals["color-temperature"]}K`);
      if (metrics.length > 0) {
        parts.push(`「${name}」当前${metrics.join("，")}。`);
        continue;
      }
    }
    const firstLine = raw.split(/\r?\n/)[0]?.trim() ?? raw;
    parts.push(raw.length <= 160 ? raw : firstLine);
  }
  return parts.join("\n") || "已执行完成。";
}

function buildFinalReplyWithoutTools(userText: string, devices: readonly DeviceInfo[]): string {
  if (/^(你好|您好|hi|hello|在吗|小派)/i.test(userText.trim())) {
    const onlineCount = devices.filter((d) => d.online).length;
    return `你好！我是 MijiaDeck 内置 Pi Agent，当前共有 ${devices.length} 台设备（${onlineCount} 台在线）。你可以直接语音或输入指令，例如“打开客厅吸顶灯”、“把亮度调到80%”或“查看卧室温度”。`;
  }
  return "我是 MijiaDeck 内置 Pi Agent，支持语音或文字控制米家设备：开关灯与插座、调节亮度/色温/颜色、查看温湿度、控制小爱音箱音量播放、给宠物喂食器出粮以及执行手动场景。若需要更复杂的自由对话推理，可在「设置 → 语音与 Pi Agent」中接入 DeepSeek、OpenAI、Claude、Gemini 或本地 Ollama 模型。";
}

/**
 * 创建内置本地规划引擎的 Pi Agent StreamFn。
 */
export function createLocalSmartHomeStreamFn(
  ctxProvider: LocalPlannerContextProvider,
): StreamFn {
  let callCounter = 0;

  return (model: Model<Api>, context: TranscriptContext) => {
    const stream = createAssistantMessageEventStream();

    queueMicrotask(() => {
      const now = Date.now();
      const messages = context.messages;
      const lastMsg = messages[messages.length - 1];

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

        const replyText = summarizeToolResults(trailingResults);
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
        return;
      }

      // 情况 B：收到新的用户指令，规划工具调用
      const userText = lastMsg ? extractUserText(lastMsg).trim() : "";
      const devices = ctxProvider.getDevices();
      const scenes = ctxProvider.getScenes();
      const recentTarget = findRecentDeviceFromTranscript(messages.slice(0, -1));
      const clauses = splitCompoundClauses(userText);

      const planned: PlannedCall[] = [];
      for (const clause of clauses) {
        const call = planSingleClause(clause, devices, scenes, recentTarget);
        if (call) {
          planned.push(call);
        }
      }

      if (planned.length === 0) {
        const replyText = buildFinalReplyWithoutTools(userText, devices);
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
        return;
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
    });

    return stream;
  };
}
