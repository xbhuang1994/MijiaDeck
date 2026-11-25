// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * Pi Agent 技能沉淀与持久化仓库（agent_skills.json + agent_skills/<id>.md）。
 *
 * 当 Agent 执行任务遇到异常并通过思考-排错-状态核验闭环成功解决后，
 * 自动将「踩坑原因 + 经校验有效的执行步骤 + 状态校验规则」沉淀为可复用 Skill，
 * 下次收到同类任务时直接复用成熟流程，避免重复踩坑。
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dataDir, dataFile, readJson, writeJson } from "../core/jsonStore.ts";
import { isSpeaker, type DeviceInfo } from "../core/models.ts";

const SKILLS_FILENAME = "agent_skills.json";
const SKILLS_MD_DIRNAME = "agent_skills";
const SKILLS_STORE_VERSION = 1;
const MAX_STORED_SKILLS = 100;

export interface AgentSkillStep {
  toolName: string;
  args: Record<string, unknown>;
  note?: string;
}

export interface AgentSkillVerificationSpec {
  did?: string;
  deviceName?: string;
  toolName: string;
  expectedPower?: boolean;
  expectedProps?: Record<string, unknown>;
  note?: string;
}

export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  triggers: string[];
  normalizedIntentKey: string;
  /** 语义规范意图键（例如 speaker:stop_playback / power:on:<did>），用于同义表达复用与防重复沉淀 */
  canonicalIntentKey?: string;
  /** 经校验执行步骤的确定性结构签名，用于兜底去重避免相同流程重复沉淀 */
  stepsSignature?: string;
  targetDids: string[];
  pitfall: string;
  resolutionSummary: string;
  steps: AgentSkillStep[];
  verification: AgentSkillVerificationSpec[];
  createdFromRetry: boolean;
  useCount: number;
  retriesAvoided: number;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
  markdownFile?: string;
}

export interface SaveAgentSkillInput {
  name: string;
  description: string;
  triggerText: string;
  triggers?: string[];
  canonicalIntentKey?: string;
  /** 若本次排错源自已命中但失效的旧 Skill，优先原地升级该 Skill */
  replaceSkillId?: string;
  /** 可选当前可用设备清单，用于精准推导语义意图与目标设备校验 */
  activeDevices?: readonly DeviceInfo[];
  targetDids?: string[];
  pitfall: string;
  resolutionSummary: string;
  steps: AgentSkillStep[];
  verification?: AgentSkillVerificationSpec[];
  createdFromRetry?: boolean;
  enabled?: boolean;
}

export interface SaveAgentSkillResult {
  skill: AgentSkill;
  created: boolean;
  updated: boolean;
  stepsChanged: boolean;
  triggerAdded: boolean;
}

export interface CanonicalSkillIntent {
  actionKey: string;
  explicitTargetDid?: string;
  explicitDeviceKind?: "xiaoai" | "ir_audio";
  explicitRoom?: string;
}

interface AgentSkillFilePayload {
  version: number;
  skills: AgentSkill[];
}

const RE_EDGE_PUNCT = /^[\s,，。．.、!！?？:：;；\-—~～“”"'`（）()【】\[\]]+|[\s,，。．.、!！?？:：;；\-—~～“”"'`（）()【】\[\]]+$/g;
const RE_WAKE_OR_FILLER_PREFIX =
  /^(?:(?:嗨|嘿|喂|你好|您好|hey|hi|hello)[\s,，、]*?(?:neo|尼奥|小派|派派|米家助手)?|(?:neo|尼奥|小派|派派|米家助手|那个|嗯+|呃+|诶+))(?=[，,、\s]|请|麻烦|帮|给|替|把|将|停|暂|播|打|关|开)/i;
const RE_POLITE_PREFIX =
  /^(?:你好|您好|小派|派派|米家助手|请(?:你)?|麻烦(?:你)?|帮我|帮忙|你帮我|给我|你给我|替我|能不能(?:帮我)?|可以(?:帮我)?|赶紧|快点?|马上|立刻|现在|先|再|把|将|please\b)+[，,、\s]*/i;
const RE_POLITE_SUFFIX =
  /(?:一下|一下子|吧|呀|哦|啊|呢|嘛|啦|哈|呗|咯|噢|了|好了|好吗|可以吗|行吗|好不好|谢谢(?:你)?|感谢|多谢|please|thanks|thank\s*you)+$/i;

const COMMON_ROOM_NAMES: readonly string[] = [
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
  "室外",
];

const RE_COMPOUND_CLAUSE =
  /(?:[，,;；]|并且|而且|然后|同时|顺便|并(?=[把将打关开调设执切给让停暂播继])|\band\b|\bthen\b)/i;
const RE_NUMERIC_PARAM =
  /(?:\d|[一二两三四五六七八九十百]+(?:度|份|分钟?|秒钟?|小时|档|级|%|瓦|开尔文))/;
const RE_NON_SPEAKER_STOP_TARGET =
  /(?:洗衣机|洗烘|洗衣|洗涤|烘干|干衣机|扫地|拖地|吸尘|窗帘|纱帘|卷帘|灌溉|浇水|浇花|水阀|放水|排水|进水|空调|除湿|加湿|净化器|风扇|吸顶灯|台灯|吊灯|主灯|射灯|灯带|夜灯|灯光|电灯|开灯|关灯|灯|开关|插座|摄像头|摄像机|门锁|喂食器|出粮|猫粮|狗粮|宠粮|电视|投影|执行|任务|操作)/i;
const RE_SPEAKER_RESUME =
  /(?:取消暂停|解除暂停|继续播放|继续放歌|继续听歌|恢复播放|重新播放|开始播放|\b(?:resume(?:\s+(?:the\s+)?(?:music|playback|playing))?|continue\s+playing)\b)/i;
const RE_SPEAKER_STOP =
  /(?:(?:停止|终止|结束|停掉|停了?|停下)(?:当前|正在)?(?:(?:小爱|小米)?(?:音箱|音响)(?:play)?|小爱)?(?:的)?(?:播放|放歌|放音乐|播歌|播音乐|听歌|听音乐|音乐|歌曲|唱歌|歌)|(?:播放|放歌|音乐|歌曲|背景音乐|歌|声音).{0,6}(?:停止|停掉|停了?|停下|结束|终止|关掉|关闭|关了?)|(?:关闭|关掉|关了?)(?:当前|正在播放的?)?(?:播放|放歌|音乐|歌曲|背景音乐)|(?:不要|别|不再|不用|不想|不)(?:让(?:小爱|小米)?(?:音箱|音响)|让小爱)?(?:再)?(?:继续)?(?:播放|播歌|播音乐|放歌|放音乐|听歌|听音乐|(?:播|放)这首(?:歌)?|(?:放|播|听)$)|(?:让|叫)?(?:小爱(?:音箱)?(?:play)?|小米(?:音箱|音响)|音箱|音响)(?:停止|停掉|停了?|停下)(?:播放|音乐|歌曲|放歌)?|\b(?:stop\s+(?:the\s+)?(?:music|song|songs|playing|playback|audio|speaker)|turn\s+off\s+(?:the\s+)?music|shut\s+off\s+(?:the\s+)?music)\b)/i;
const RE_SPEAKER_PAUSE =
  /(?:暂停(?:当前|正在)?(?:播放|音乐|歌曲|放歌|放音乐|音箱|音响|小爱)?|(?:音乐|歌曲|播放|歌|音箱|音响).{0,6}暂停|\bpause(?:\s+(?:the\s+)?(?:music|song|songs|playing|playback|audio|speaker))?\b)/i;
const RE_SPEAKER_NEXT = /(?:下一首|下一曲|切歌|换一首(?:歌)?|换首歌|\bnext\s+(?:song|track)\b)/i;
const RE_SPEAKER_PREV = /(?:上一首|上一曲|前一首|\bprev(?:ious)?\s+(?:song|track)\b)/i;
const RE_SPEAKER_UNMUTE = /(?:取消静音|解除静音|恢复声音|\bunmute\b)/i;
const RE_SPEAKER_MUTE = /(?:静音|\bmute\b)/i;
const RE_SPEAKER_MIC_HINT = /(?:麦克风|闭麦|开麦|\bmic\b)/i;
const RE_POWER_DISQUALIFIER =
  /(?:全部|所有|全屋|全都|都|亮度|色温|颜色|暖光|冷光|模式|温度|湿度|风速|音量|播放|暂停|停止|静音|出粮|喂食|洗衣|洗涤|烘干|定时|倒计时|预约|查|看|状态|多少)/i;

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

function stableJsonStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableJsonStringify(v)).join(",")}]`;
  }
  const rec = value as Record<string, unknown>;
  const keys = Object.keys(rec)
    .filter((k) => rec[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJsonStringify(rec[k])}`).join(",")}}`;
}

/**
 * 计算技能执行步骤的确定性结构签名（忽略展示性 note 字段与对象键顺序）。
 */
export function computeSkillStepsSignature(steps: readonly AgentSkillStep[]): string {
  return stableJsonStringify(
    steps.map((s) => ({
      toolName: s.toolName.trim(),
      args: s.args ?? {},
    })),
  );
}

function extractNumericSignature(raw: string): string {
  const matches = String(raw ?? "")
    .toLowerCase()
    .match(/\d+(?:\.\d+)?(?:\s*(?:%|k|度|℃|°c|分钟?|秒钟?|小时|份|档|级))?/g);
  if (!matches || matches.length === 0) return "";
  return matches.map((m) => m.replace(/\s+/g, "")).join("|");
}

function stripPoliteWrappers(raw: string): string {
  let out = String(raw ?? "").trim().toLowerCase();
  if (!out) return "";
  for (let i = 0; i < 4; i += 1) {
    const before = out;
    out = out
      .replace(RE_EDGE_PUNCT, "")
      .replace(RE_WAKE_OR_FILLER_PREFIX, "")
      .replace(RE_EDGE_PUNCT, "")
      .replace(RE_POLITE_PREFIX, "")
      .replace(RE_EDGE_PUNCT, "")
      .replace(RE_POLITE_SUFFIX, "")
      .replace(RE_EDGE_PUNCT, "")
      .trim();
    if (out === before) break;
  }
  return out;
}

/**
 * 将自然语言指令规范化为稳定的技能意图签名：
 * 先剥离首尾标点与客套/唤醒前后缀（避免 ASR 句末标点阻断“一下/吧/了”剥离），
 * 同时严格保留全部数字、单位、否定词、动作词与设备名，
 * 避免“亮度调到85%”误命中“亮度调到30%”的技能。
 */
export function normalizeSkillIntentKey(raw: string): string {
  const out = stripPoliteWrappers(raw);
  if (!out) return "";
  return out
    .replace(/[的\s\-_·.,，。！？!?“”"'`（）()【】\[\]:：;；~～]/g, "")
    .trim();
}

function detectExplicitRoom(text: string): string | undefined {
  for (const room of COMMON_ROOM_NAMES) {
    if (text.includes(room)) return room;
  }
  return undefined;
}

function deviceMatchesRoom(device: DeviceInfo, room: string): boolean {
  const dr = (device.room_name ?? "").trim();
  if (dr && dr !== "未知" && dr !== "未分配" && dr !== "未分配房间") {
    if (dr === room || dr.includes(room) || room.includes(dr)) return true;
  }
  return device.name.includes(room);
}

/**
 * 将常见单意图智能家居口语指令归一为语义意图签名（CanonicalSkillIntent）。
 * 严格护栏：
 * - 复合多子句、含数字参数（亮度/温度/音量数值等）、批量控制一律返回 null，绝不误匹配；
 * - 显式设备名/设备类型（小爱音箱 vs 红外音响）/房间名均单独提取校验，绝不跨设备串台。
 */
export function resolveCanonicalSkillIntent(
  rawText: string,
  activeDevices: readonly DeviceInfo[] = [],
): CanonicalSkillIntent | null {
  const cleaned = stripPoliteWrappers(rawText).replace(
    /^(小爱同学|小爱音箱(?:play)?|小米音箱|小爱)[，,\s]+/i,
    "$1 ",
  );
  if (!cleaned) return null;
  if (RE_COMPOUND_CLAUSE.test(cleaned)) return null;
  if (RE_NUMERIC_PARAM.test(cleaned)) return null;

  // 去除句中客套词“一下/一下子”与空格，便于匹配“停止一下播放”“帮我停一下音乐”等自然表达
  const compact = cleaned
    .replace(/(?:一下子|一下)/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const compactNoSpace = compact.replace(/\s+/g, "");
  const explicitRoom = detectExplicitRoom(compactNoSpace);

  // 1. 音箱/音频播放控制规范意图
  if (!RE_NON_SPEAKER_STOP_TARGET.test(compactNoSpace)) {
    let audioAction: string | null = null;
    if (RE_SPEAKER_RESUME.test(compact)) {
      audioAction = "speaker:resume_playback";
    } else if (RE_SPEAKER_STOP.test(compact)) {
      audioAction = "speaker:stop_playback";
    } else if (RE_SPEAKER_PAUSE.test(compact)) {
      audioAction = "speaker:pause_playback";
    } else if (RE_SPEAKER_NEXT.test(compact)) {
      audioAction = "speaker:next_track";
    } else if (RE_SPEAKER_PREV.test(compact)) {
      audioAction = "speaker:previous_track";
    } else if (!RE_SPEAKER_MIC_HINT.test(compactNoSpace)) {
      if (RE_SPEAKER_UNMUTE.test(compact)) {
        audioAction = "speaker:unmute";
      } else if (RE_SPEAKER_MUTE.test(compact)) {
        audioAction = "speaker:mute";
      }
    }

    if (audioAction) {
      let explicitTargetDid: string | undefined;
      let explicitDeviceKind: "xiaoai" | "ir_audio" | undefined;

      const audioDevices = activeDevices.filter((d) => isSpeaker(d) || isIrAudioDevice(d));
      const sortedAudio = [...audioDevices].sort((a, b) => b.name.length - a.name.length);
      for (const dev of sortedAudio) {
        const normName = normalizeSkillIntentKey(dev.name);
        if (normName.length >= 2 && compactNoSpace.includes(normName)) {
          // 防止“小米音响/小爱音箱”被名为“音响”的涂鸦红外音响误吞
          if (isIrAudioDevice(dev) && /(?:小米|小爱)/.test(compactNoSpace)) {
            continue;
          }
          if (!explicitRoom || deviceMatchesRoom(dev, explicitRoom)) {
            explicitTargetDid = dev.did;
            explicitDeviceKind = isSpeaker(dev) ? "xiaoai" : "ir_audio";
            break;
          }
        }
      }

      if (!explicitDeviceKind) {
        if (/(?:红外音响|红外功放|功放|音响)/.test(compactNoSpace) && !/(?:小米|小爱)/.test(compactNoSpace)) {
          explicitDeviceKind = "ir_audio";
          const irList = activeDevices.filter(
            (d) => isIrAudioDevice(d) && (!explicitRoom || deviceMatchesRoom(d, explicitRoom)),
          );
          if (irList.length === 1) {
            explicitTargetDid = irList[0]!.did;
          }
        } else if (/(?:小爱|小米音箱|小爱音箱|小米音响)/.test(compactNoSpace)) {
          explicitDeviceKind = "xiaoai";
          const xiaoaiList = activeDevices.filter(
            (d) => isSpeaker(d) && (!explicitRoom || deviceMatchesRoom(d, explicitRoom)),
          );
          if (xiaoaiList.length === 1) {
            explicitTargetDid = xiaoaiList[0]!.did;
          }
        }
      }

      return {
        actionKey: audioAction,
        ...(explicitTargetDid ? { explicitTargetDid } : {}),
        ...(explicitDeviceKind ? { explicitDeviceKind } : {}),
        ...(explicitRoom ? { explicitRoom } : {}),
      };
    }
  }

  // 2. 单设备开关机规范意图（如“打开客厅吸顶灯”与“把客厅吸顶灯打开”归一）
  if (activeDevices.length > 0 && !RE_POWER_DISQUALIFIER.test(compactNoSpace)) {
    let powerState: "on" | "off" | null = null;
    let remainder = compactNoSpace;
    if (/^(?:打开|开启|开)/.test(remainder)) {
      powerState = "on";
      remainder = remainder.replace(/^(?:打开|开启|开)/, "");
    } else if (/(?:打开|开启|开)$/.test(remainder)) {
      powerState = "on";
      remainder = remainder.replace(/(?:打开|开启|开)$/, "");
    } else if (/^(?:关闭|关掉|关上|关)/.test(remainder)) {
      powerState = "off";
      remainder = remainder.replace(/^(?:关闭|关掉|关上|关)/, "");
    } else if (/(?:关闭|关掉|关上|关)$/.test(remainder)) {
      powerState = "off";
      remainder = remainder.replace(/(?:关闭|关掉|关上|关)$/, "");
    }

    const normRemainder = normalizeSkillIntentKey(remainder);
    if (powerState && normRemainder.length >= 2) {
      const matched = activeDevices.filter((d) => {
        const normName = normalizeSkillIntentKey(d.name);
        if (!normName) return false;
        if (normName === normRemainder) {
          return !explicitRoom || deviceMatchesRoom(d, explicitRoom);
        }
        if (explicitRoom && deviceMatchesRoom(d, explicitRoom)) {
          const roomPlusName = normalizeSkillIntentKey(`${explicitRoom}${d.name}`);
          if (roomPlusName === normRemainder) return true;
        }
        return false;
      });
      if (matched.length === 1) {
        const dev = matched[0]!;
        return {
          actionKey: `power:${powerState}:${dev.did}`,
          explicitTargetDid: dev.did,
          ...(explicitRoom ? { explicitRoom } : {}),
        };
      }
    }
  }

  return null;
}

function inferCanonicalIntentKeyForSkill(
  triggers: readonly string[],
  name: string,
  steps: readonly AgentSkillStep[],
  activeDevices: readonly DeviceInfo[] = [],
): string | undefined {
  for (const text of [...triggers, name]) {
    if (!text.trim()) continue;
    const hit = resolveCanonicalSkillIntent(text, activeDevices);
    if (hit) return hit.actionKey;
  }
  // 兜底：若步骤是明确通过小爱文本指令停止播放，自动归类为 speaker:stop_playback
  if (
    steps.length === 1 &&
    steps[0]!.toolName === "send_xiaoai_command" &&
    typeof steps[0]!.args.text === "string" &&
    RE_SPEAKER_STOP.test(steps[0]!.args.text)
  ) {
    return "speaker:stop_playback";
  }
  return undefined;
}

function sameDidSet(a: readonly string[], b: readonly string[]): boolean {
  const sa = new Set(a.map((x) => x.trim()).filter(Boolean));
  const sb = new Set(b.map((x) => x.trim()).filter(Boolean));
  if (sa.size !== sb.size) return false;
  for (const x of sa) {
    if (!sb.has(x)) return false;
  }
  return true;
}

function haveCompatibleTargets(a: readonly string[], b: readonly string[]): boolean {
  const sa = new Set(a.map((x) => x.trim()).filter(Boolean));
  const sb = new Set(b.map((x) => x.trim()).filter(Boolean));
  if (sa.size === 0 || sb.size === 0) return true;
  if (sa.size === sb.size) {
    let allEq = true;
    for (const x of sa) {
      if (!sb.has(x)) {
        allEq = false;
        break;
      }
    }
    if (allEq) return true;
  }
  // 兼容旧数据里 targetDids 混入了设备别名导致其中一方多出非 did 别名项的情况：
  // 只要双方存在交集 did（或一方是另一方子集）即视为同一目标
  let shared = 0;
  for (const x of sa) {
    if (sb.has(x)) shared += 1;
  }
  return shared > 0 && shared === Math.min(sa.size, sb.size);
}

function dedupeTriggers(triggers: readonly string[]): string[] {
  const out: string[] = [];
  const seenKeys = new Set<string>();
  for (const raw of triggers) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const key = normalizeSkillIntentKey(trimmed) || trimmed.toLowerCase();
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    out.push(trimmed);
    if (out.length >= 12) break;
  }
  return out;
}

function slugifySkillId(seed: string): string {
  const ascii = seed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 28);
  const hash = simpleHash(seed);
  return ascii ? `skill_${ascii}_${hash}` : `skill_${hash}`;
}

function simpleHash(input: string): string {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36).slice(0, 8);
}

function cloneArgs(args: Record<string, unknown>): Record<string, unknown> {
  try {
    return JSON.parse(JSON.stringify(args ?? {})) as Record<string, unknown>;
  } catch {
    return { ...(args ?? {}) };
  }
}

function sanitizeStep(raw: unknown): AgentSkillStep | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const toolName = typeof rec.toolName === "string" ? rec.toolName.trim() : "";
  if (!toolName) return null;
  const args =
    rec.args && typeof rec.args === "object" && !Array.isArray(rec.args)
      ? cloneArgs(rec.args as Record<string, unknown>)
      : {};
  const note = typeof rec.note === "string" && rec.note.trim() ? rec.note.trim().slice(0, 200) : undefined;
  return {
    toolName,
    args,
    ...(note ? { note } : {}),
  };
}

function sanitizeVerificationSpec(raw: unknown): AgentSkillVerificationSpec | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const toolName = typeof rec.toolName === "string" ? rec.toolName.trim() : "";
  if (!toolName) return null;
  const did = typeof rec.did === "string" && rec.did.trim() ? rec.did.trim() : undefined;
  const deviceName =
    typeof rec.deviceName === "string" && rec.deviceName.trim() ? rec.deviceName.trim() : undefined;
  const expectedPower = typeof rec.expectedPower === "boolean" ? rec.expectedPower : undefined;
  const expectedProps =
    rec.expectedProps && typeof rec.expectedProps === "object" && !Array.isArray(rec.expectedProps)
      ? cloneArgs(rec.expectedProps as Record<string, unknown>)
      : undefined;
  const note = typeof rec.note === "string" && rec.note.trim() ? rec.note.trim().slice(0, 200) : undefined;
  return {
    toolName,
    ...(did ? { did } : {}),
    ...(deviceName ? { deviceName } : {}),
    ...(expectedPower !== undefined ? { expectedPower } : {}),
    ...(expectedProps && Object.keys(expectedProps).length > 0 ? { expectedProps } : {}),
    ...(note ? { note } : {}),
  };
}

function sanitizeSkill(raw: unknown): AgentSkill | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const id = typeof rec.id === "string" ? rec.id.trim() : "";
  const name = typeof rec.name === "string" ? rec.name.trim() : "";
  const steps = Array.isArray(rec.steps)
    ? rec.steps.map(sanitizeStep).filter((s): s is AgentSkillStep => s !== null)
    : [];
  if (!id || !name || steps.length === 0) return null;

  const triggersRaw = Array.isArray(rec.triggers)
    ? rec.triggers.map((t) => String(t ?? "").trim()).filter(Boolean)
    : [];
  const triggers = dedupeTriggers(triggersRaw);
  const rawNorm =
    typeof rec.normalizedIntentKey === "string" && rec.normalizedIntentKey.trim()
      ? normalizeSkillIntentKey(rec.normalizedIntentKey.trim()) || rec.normalizedIntentKey.trim()
      : normalizeSkillIntentKey(triggers[0] ?? name);
  const normalizedIntentKey = rawNorm;
  if (!normalizedIntentKey) return null;

  const targetDids = Array.isArray(rec.targetDids)
    ? [...new Set(rec.targetDids.map((d) => String(d ?? "").trim()).filter(Boolean))]
    : [];
  const verification = Array.isArray(rec.verification)
    ? rec.verification
        .map(sanitizeVerificationSpec)
        .filter((v): v is AgentSkillVerificationSpec => v !== null)
    : [];

  const canonicalIntentKey =
    typeof rec.canonicalIntentKey === "string" && rec.canonicalIntentKey.trim()
      ? rec.canonicalIntentKey.trim()
      : inferCanonicalIntentKeyForSkill(triggers, name, steps);
  const stepsSignature = computeSkillStepsSignature(steps);

  const now = Date.now();
  return {
    id,
    name: name.slice(0, 80),
    description:
      typeof rec.description === "string" ? rec.description.trim().slice(0, 300) : name.slice(0, 80),
    triggers,
    normalizedIntentKey,
    ...(canonicalIntentKey ? { canonicalIntentKey } : {}),
    stepsSignature,
    targetDids,
    pitfall: typeof rec.pitfall === "string" ? rec.pitfall.trim().slice(0, 300) : "",
    resolutionSummary:
      typeof rec.resolutionSummary === "string" ? rec.resolutionSummary.trim().slice(0, 300) : "",
    steps,
    verification,
    createdFromRetry: rec.createdFromRetry !== false,
    useCount:
      typeof rec.useCount === "number" && Number.isFinite(rec.useCount)
        ? Math.max(0, Math.trunc(rec.useCount))
        : 0,
    retriesAvoided:
      typeof rec.retriesAvoided === "number" && Number.isFinite(rec.retriesAvoided)
        ? Math.max(0, Math.trunc(rec.retriesAvoided))
        : 0,
    enabled: rec.enabled !== false,
    createdAt: typeof rec.createdAt === "number" && Number.isFinite(rec.createdAt) ? rec.createdAt : now,
    updatedAt: typeof rec.updatedAt === "number" && Number.isFinite(rec.updatedAt) ? rec.updatedAt : now,
    lastUsedAt:
      typeof rec.lastUsedAt === "number" && Number.isFinite(rec.lastUsedAt) ? rec.lastUsedAt : null,
    ...(typeof rec.markdownFile === "string" && rec.markdownFile.trim()
      ? { markdownFile: rec.markdownFile.trim() }
      : {}),
  };
}

function skillsMarkdownDir(): string {
  return path.join(dataDir(), SKILLS_MD_DIRNAME);
}

function renderSkillMarkdown(skill: AgentSkill): string {
  const stepsLines = skill.steps.map((s, idx) => {
    const argsJson = JSON.stringify(s.args);
    return `${idx + 1}. \`${s.toolName}\` \`${argsJson}\`${s.note ? ` — ${s.note}` : ""}`;
  });
  const verifyLines =
    skill.verification.length > 0
      ? skill.verification.map((v, idx) => {
          const expectParts: string[] = [];
          if (typeof v.expectedPower === "boolean") {
            expectParts.push(`power=${v.expectedPower ? "on" : "off"}`);
          }
          if (v.expectedProps) {
            for (const [k, val] of Object.entries(v.expectedProps)) {
              expectParts.push(`${k}=${JSON.stringify(val)}`);
            }
          }
          const target = v.deviceName || v.did || v.toolName;
          return `${idx + 1}. ${target}: ${expectParts.join(", ") || v.note || "状态正常"}`;
        })
      : ["1. 执行完成后回读设备实时状态并核对目标值"];

  return [
    "---",
    `id: ${skill.id}`,
    `name: ${JSON.stringify(skill.name)}`,
    `description: ${JSON.stringify(skill.description)}`,
    `intent_key: ${JSON.stringify(skill.normalizedIntentKey)}`,
    ...(skill.canonicalIntentKey ? [`canonical_intent: ${JSON.stringify(skill.canonicalIntentKey)}`] : []),
    `enabled: ${skill.enabled}`,
    `created_from_retry: ${skill.createdFromRetry}`,
    `updated_at: ${new Date(skill.updatedAt).toISOString()}`,
    "---",
    "",
    `# ${skill.name}`,
    "",
    skill.description,
    "",
    "## 触发指令",
    ...skill.triggers.map((t) => `- ${t}`),
    "",
    "## 避坑记录（历史问题）",
    skill.pitfall || "（通过排错核验沉淀）",
    "",
    "## 有效解决策略",
    skill.resolutionSummary || "按以下经验证通过的步骤顺序执行。",
    "",
    "## 经验证的执行步骤",
    ...stepsLines,
    "",
    "## 执行后状态检查标准",
    ...verifyLines,
    "",
  ].join("\n");
}

function syncSkillMarkdownFile(skill: AgentSkill): string | undefined {
  try {
    const dir = skillsMarkdownDir();
    mkdirSync(dir, { recursive: true });
    const fileName = `${skill.id}.md`;
    const filePath = path.join(dir, fileName);
    writeFileSync(filePath, renderSkillMarkdown(skill), "utf-8");
    return path.join(SKILLS_MD_DIRNAME, fileName).replaceAll("\\", "/");
  } catch {
    return skill.markdownFile;
  }
}

function removeSkillMarkdownFile(skillId: string): void {
  try {
    const filePath = path.join(skillsMarkdownDir(), `${skillId}.md`);
    if (existsSync(filePath)) {
      rmSync(filePath, { force: true });
    }
  } catch {
    // ignore cleanup failure
  }
}

function persistSkills(skills: AgentSkill[]): void {
  const payload: AgentSkillFilePayload = {
    version: SKILLS_STORE_VERSION,
    skills: skills.slice(0, MAX_STORED_SKILLS),
  };
  writeJson(dataFile(SKILLS_FILENAME), payload as unknown as Record<string, unknown>);
}

function numericTokensCompatible(a: string, b: string): boolean {
  const na = extractNumericSignature(a);
  const nb = extractNumericSignature(b);
  if (!na && !nb) return true;
  return na === nb;
}

function skillsAreDuplicates(a: AgentSkill, b: AgentSkill): boolean {
  if (a.id === b.id) return true;
  if (a.normalizedIntentKey === b.normalizedIntentKey && haveCompatibleTargets(a.targetDids, b.targetDids)) {
    return true;
  }
  const canonA = a.canonicalIntentKey || inferCanonicalIntentKeyForSkill(a.triggers, a.name, a.steps);
  const canonB = b.canonicalIntentKey || inferCanonicalIntentKeyForSkill(b.triggers, b.name, b.steps);
  if (canonA && canonB && canonA === canonB && haveCompatibleTargets(a.targetDids, b.targetDids)) {
    return true;
  }
  const sigA = a.stepsSignature || computeSkillStepsSignature(a.steps);
  const sigB = b.stepsSignature || computeSkillStepsSignature(b.steps);
  if (
    a.targetDids.length > 0 &&
    b.targetDids.length > 0 &&
    sameDidSet(a.targetDids, b.targetDids) &&
    sigA === sigB &&
    numericTokensCompatible(a.triggers[0] ?? a.normalizedIntentKey, b.triggers[0] ?? b.normalizedIntentKey)
  ) {
    return true;
  }
  return false;
}

function deduplicateSkillsList(skills: readonly AgentSkill[]): {
  skills: AgentSkill[];
  removedIds: string[];
} {
  const sorted = [...skills].sort((a, b) => b.updatedAt - a.updatedAt || b.useCount - a.useCount);
  const kept: AgentSkill[] = [];
  const removedIds: string[] = [];

  for (const skill of sorted) {
    const existing = kept.find((k) => skillsAreDuplicates(k, skill));
    if (!existing) {
      kept.push(skill);
      continue;
    }
    existing.triggers = dedupeTriggers([...existing.triggers, ...skill.triggers]);
    existing.useCount += skill.useCount;
    existing.retriesAvoided += skill.retriesAvoided;
    existing.createdAt = Math.min(existing.createdAt, skill.createdAt);
    if (skill.lastUsedAt !== null) {
      existing.lastUsedAt =
        existing.lastUsedAt === null ? skill.lastUsedAt : Math.max(existing.lastUsedAt, skill.lastUsedAt);
    }
    if (!existing.canonicalIntentKey && skill.canonicalIntentKey) {
      existing.canonicalIntentKey = skill.canonicalIntentKey;
    }
    if (existing.targetDids.length === 0 && skill.targetDids.length > 0) {
      existing.targetDids = [...skill.targetDids];
    }
    if (skill.id !== existing.id) {
      removedIds.push(skill.id);
    }
  }

  return { skills: kept, removedIds };
}

export function loadAgentSkills(): AgentSkill[] {
  const raw = readJson<Partial<AgentSkillFilePayload>>(dataFile(SKILLS_FILENAME), {
    version: SKILLS_STORE_VERSION,
    skills: [],
  });
  if (!raw || !Array.isArray(raw.skills)) {
    return [];
  }
  const sanitized = raw.skills
    .map(sanitizeSkill)
    .filter((s): s is AgentSkill => s !== null);
  return deduplicateSkillsList(sanitized).skills;
}

function resolveCleanTargetDids(
  input: SaveAgentSkillInput,
  steps: readonly AgentSkillStep[],
): string[] {
  // 优先使用经工具真实回执解析出的精确 did（绝不用模糊 target 别名如“小爱”污染 targetDids）
  const verifiedDids = [
    ...(input.targetDids ?? []),
    ...(input.verification ?? []).map((v) => v.did ?? ""),
  ]
    .map((d) => d.trim())
    .filter(Boolean);

  if (verifiedDids.length > 0) {
    return [...new Set(verifiedDids)];
  }

  const fallbackFromSteps = steps
    .map((s) => {
      if (s.toolName === "send_xiaoai_command" && typeof s.args.speaker === "string") {
        return s.args.speaker.trim();
      }
      return typeof s.args.target === "string" ? s.args.target.trim() : "";
    })
    .filter(Boolean);
  return [...new Set(fallbackFromSteps)];
}

export function saveAgentSkill(input: SaveAgentSkillInput): SaveAgentSkillResult {
  const triggerText = input.triggerText.trim();
  const normalizedIntentKey = normalizeSkillIntentKey(triggerText || input.name);
  if (!normalizedIntentKey) {
    throw new Error("技能触发指令不能为空");
  }
  const steps = input.steps
    .map((s) => sanitizeStep(s))
    .filter((s): s is AgentSkillStep => s !== null);
  if (steps.length === 0) {
    throw new Error("技能必须包含至少一个有效执行步骤");
  }

  const now = Date.now();
  const activeDevices = input.activeDevices ?? [];
  const rawLoaded = loadAgentSkills();
  const { skills, removedIds: legacyRemovedIds } = deduplicateSkillsList(rawLoaded);

  const targetDids = resolveCleanTargetDids(input, steps);
  const stepsSignature = computeSkillStepsSignature(steps);
  const canonicalIntentKey =
    input.canonicalIntentKey?.trim() ||
    inferCanonicalIntentKeyForSkill(
      [triggerText, ...(input.triggers ?? [])],
      input.name,
      steps,
      activeDevices,
    );

  // 多层精准去重：
  // 0) 若源自失效旧 Skill 的原地升级，直接命中该 Skill；
  // 1) 规范意图键或已记录触发词命中；
  // 2) 同语义规范意图（如“停止播放”与“停止播放音乐/让小爱停止播放”）+ 兼容目标设备；
  // 3) 相同目标设备 + 完全相同的经验证执行步骤签名（兜底防止任意口语变体重复沉淀同一流程）。
  let existingIdx = -1;
  if (input.replaceSkillId) {
    existingIdx = skills.findIndex((s) => s.id === input.replaceSkillId);
  }
  if (existingIdx < 0) {
    existingIdx = skills.findIndex(
      (s) =>
        (s.normalizedIntentKey === normalizedIntentKey ||
          s.triggers.some((t) => normalizeSkillIntentKey(t) === normalizedIntentKey)) &&
        haveCompatibleTargets(s.targetDids, targetDids),
    );
  }
  if (existingIdx < 0 && canonicalIntentKey) {
    existingIdx = skills.findIndex((s) => {
      const sCanon =
        s.canonicalIntentKey ||
        inferCanonicalIntentKeyForSkill(s.triggers, s.name, s.steps, activeDevices);
      return Boolean(sCanon && sCanon === canonicalIntentKey && haveCompatibleTargets(s.targetDids, targetDids));
    });
  }
  if (existingIdx < 0 && targetDids.length > 0) {
    existingIdx = skills.findIndex((s) => {
      if (s.targetDids.length === 0 || !sameDidSet(s.targetDids, targetDids)) return false;
      const sSig = s.stepsSignature || computeSkillStepsSignature(s.steps);
      if (sSig !== stepsSignature) return false;
      return numericTokensCompatible(s.triggers[0] ?? s.normalizedIntentKey, triggerText);
    });
  }

  const verification = (input.verification ?? [])
    .map((v) => sanitizeVerificationSpec(v))
    .filter((v): v is AgentSkillVerificationSpec => v !== null);

  let saved: AgentSkill;
  let created: boolean;
  let stepsChanged: boolean;
  let triggerAdded: boolean;

  if (existingIdx >= 0) {
    const prev = skills[existingIdx]!;
    const prevSig = prev.stepsSignature || computeSkillStepsSignature(prev.steps);
    stepsChanged = prevSig !== stepsSignature;
    const prevTriggerKeys = new Set(
      prev.triggers.map((t) => normalizeSkillIntentKey(t) || t.trim().toLowerCase()),
    );
    const mergedTriggers = dedupeTriggers([
      ...prev.triggers,
      triggerText,
      ...(input.triggers ?? []),
    ]);
    triggerAdded = mergedTriggers.some((t) => {
      const k = normalizeSkillIntentKey(t) || t.trim().toLowerCase();
      return !prevTriggerKeys.has(k);
    });

    saved = {
      ...prev,
      // 仅当原名称为空或步骤真正升级且未指定保留原名时更新标题，避免同义词合并导致标题抖动
      name: prev.name || input.name.trim().slice(0, 80),
      description: stepsChanged
        ? input.description.trim().slice(0, 300) || prev.description
        : prev.description || input.description.trim().slice(0, 300),
      triggers: mergedTriggers,
      ...(canonicalIntentKey
        ? { canonicalIntentKey }
        : prev.canonicalIntentKey
          ? { canonicalIntentKey: prev.canonicalIntentKey }
          : {}),
      stepsSignature,
      targetDids: targetDids.length > 0 ? targetDids : prev.targetDids,
      pitfall: input.pitfall.trim().slice(0, 300) || prev.pitfall,
      resolutionSummary: input.resolutionSummary.trim().slice(0, 300) || prev.resolutionSummary,
      steps,
      verification: verification.length > 0 ? verification : prev.verification,
      createdFromRetry: input.createdFromRetry ?? prev.createdFromRetry,
      enabled: input.enabled ?? prev.enabled,
      updatedAt: now,
    };
    skills[existingIdx] = saved;
    created = false;
  } else {
    const mergedTriggers = dedupeTriggers([triggerText, ...(input.triggers ?? [])]);
    const id = slugifySkillId(`${canonicalIntentKey ?? normalizedIntentKey}_${steps.map((s) => s.toolName).join("_")}`);
    saved = {
      id,
      name: input.name.trim().slice(0, 80) || triggerText.slice(0, 40),
      description: input.description.trim().slice(0, 300) || `自动沉淀的稳定执行流程：${triggerText}`,
      triggers: mergedTriggers,
      normalizedIntentKey,
      ...(canonicalIntentKey ? { canonicalIntentKey } : {}),
      stepsSignature,
      targetDids,
      pitfall: input.pitfall.trim().slice(0, 300),
      resolutionSummary: input.resolutionSummary.trim().slice(0, 300),
      steps,
      verification,
      createdFromRetry: input.createdFromRetry !== false,
      useCount: 0,
      retriesAvoided: 0,
      enabled: input.enabled !== false,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null,
    };
    skills.unshift(saved);
    created = true;
    stepsChanged = true;
    triggerAdded = true;
  }

  const finalDedup = deduplicateSkillsList(skills);
  for (const staleId of [...legacyRemovedIds, ...finalDedup.removedIds]) {
    if (staleId !== saved.id) {
      removeSkillMarkdownFile(staleId);
    }
  }

  const finalSaved = finalDedup.skills.find((s) => s.id === saved.id) ?? saved;
  finalSaved.markdownFile = syncSkillMarkdownFile(finalSaved);
  finalDedup.skills.sort((a, b) => b.updatedAt - a.updatedAt);
  persistSkills(finalDedup.skills);
  return {
    skill: finalSaved,
    created,
    updated: created || stepsChanged || triggerAdded,
    stepsChanged,
    triggerAdded,
  };
}

function looksLikeStructuredDid(raw: string): boolean {
  const s = raw.trim();
  if (!s) return false;
  return (
    /^(?:tuya|midea|deye|miwifi)[:.]/i.test(s) ||
    /^demo[-_]/i.test(s) ||
    /^\d{5,}$/.test(s) ||
    /^[a-z0-9_-]{8,}$/i.test(s)
  );
}

function validateSkillTargetsAgainstDevices(
  skill: AgentSkill,
  activeDevices: readonly DeviceInfo[],
): { valid: boolean; matchedDevices: DeviceInfo[] } {
  if (skill.targetDids.length === 0 || activeDevices.length === 0) {
    return { valid: true, matchedDevices: [] };
  }

  const deviceByDid = new Map<string, DeviceInfo>(activeDevices.map((d) => [d.did, d]));
  const devicesByNormName = new Map<string, DeviceInfo[]>();
  for (const d of activeDevices) {
    const nk = normalizeSkillIntentKey(d.name);
    if (!nk) continue;
    const list = devicesByNormName.get(nk) ?? [];
    list.push(d);
    devicesByNormName.set(nk, list);
  }

  const matchedDevices: DeviceInfo[] = [];
  const unmatchedTargets: string[] = [];

  for (const target of skill.targetDids) {
    const byDid = deviceByDid.get(target);
    if (byDid) {
      matchedDevices.push(byDid);
      continue;
    }
    const normTarget = normalizeSkillIntentKey(target);
    const byName = normTarget ? devicesByNormName.get(normTarget) : undefined;
    if (byName && byName.length > 0) {
      matchedDevices.push(byName[0]!);
      continue;
    }
    unmatchedTargets.push(target);
  }

  if (unmatchedTargets.length === 0) {
    return { valid: true, matchedDevices };
  }

  // 兼容历史被旧版本写入的 targetDids 混合别名污染（如 ["504337266", "小爱"]）：
  // 仅当至少已有精确 did 命中且剩余项为非 did 的设备名子串时宽容放行；若真实 did 缺失（设备已屏蔽/移除）则严格拦截。
  if (matchedDevices.length > 0) {
    const allBenignAliases = unmatchedTargets.every((raw) => {
      if (looksLikeStructuredDid(raw)) return false;
      const nt = normalizeSkillIntentKey(raw);
      if (!nt) return false;
      return matchedDevices.some((d) => {
        const dn = normalizeSkillIntentKey(d.name);
        return dn.includes(nt) || (isSpeaker(d) && /(?:小爱|小米音箱|音箱|音响)/.test(nt));
      });
    });
    if (allBenignAliases) {
      return { valid: true, matchedDevices };
    }
  }

  return { valid: false, matchedDevices: [] };
}

function canonicalTargetsMatch(
  canonical: CanonicalSkillIntent,
  skill: AgentSkill,
  matchedDevices: readonly DeviceInfo[],
  activeDevices: readonly DeviceInfo[],
): boolean {
  if (canonical.explicitTargetDid) {
    const hasDid =
      skill.targetDids.includes(canonical.explicitTargetDid) ||
      matchedDevices.some((d) => d.did === canonical.explicitTargetDid);
    if (!hasDid) return false;
  }

  if (canonical.explicitDeviceKind && matchedDevices.length > 0) {
    if (canonical.explicitDeviceKind === "xiaoai" && !matchedDevices.some((d) => isSpeaker(d))) {
      return false;
    }
    if (canonical.explicitDeviceKind === "ir_audio" && !matchedDevices.some((d) => isIrAudioDevice(d))) {
      return false;
    }
  }

  if (canonical.explicitRoom && matchedDevices.length > 0) {
    if (!matchedDevices.some((d) => deviceMatchesRoom(d, canonical.explicitRoom!))) {
      return false;
    }
  }

  // 泛化音频指令（未显式点名红外音响）若当前存在在线小爱音箱，不误命中显式绑定红外音响的 Skill
  if (
    canonical.actionKey.startsWith("speaker:") &&
    !canonical.explicitTargetDid &&
    !canonical.explicitDeviceKind &&
    matchedDevices.length > 0 &&
    matchedDevices.every((d) => isIrAudioDevice(d)) &&
    activeDevices.some((d) => isSpeaker(d) && d.online)
  ) {
    const skillMentionsIr = skill.triggers.some((t) => /(?:红外|音响|功放)/.test(t));
    if (skillMentionsIr) return false;
  }

  return true;
}

/**
 * 为当前用户任务匹配已沉淀且启用的可复用 Skill。
 * 支持：
 * 1. 精确规范意图键与历史触发词命中（最高优先级）；
 * 2. 语义规范意图匹配（如“停止播放”命中“停止播放音乐/停止播放了/让小爱停止播放/别放了”），
 *    同时严格校对数字参数、设备边界、房间边界与可用设备清单（被屏蔽或移除自动跳过）。
 */
export function matchAgentSkill(
  userText: string,
  activeDevices: readonly DeviceInfo[],
): AgentSkill | null {
  const norm = normalizeSkillIntentKey(userText);
  if (!norm) return null;

  const canonical = resolveCanonicalSkillIntent(userText, activeDevices);
  const skills = loadAgentSkills();

  const scoredCandidates: Array<{ skill: AgentSkill; score: number }> = [];

  for (const skill of skills) {
    if (!skill.enabled || skill.steps.length === 0) continue;

    const targetCheck = validateSkillTargetsAgainstDevices(skill, activeDevices);
    if (!targetCheck.valid) continue;

    const exactMatch =
      skill.normalizedIntentKey === norm ||
      skill.triggers.some((t) => normalizeSkillIntentKey(t) === norm);
    if (exactMatch) {
      scoredCandidates.push({ skill, score: 2 });
      continue;
    }

    if (canonical) {
      const skillCanonical =
        skill.canonicalIntentKey ||
        inferCanonicalIntentKeyForSkill(skill.triggers, skill.name, skill.steps, activeDevices);
      if (
        skillCanonical === canonical.actionKey &&
        canonicalTargetsMatch(canonical, skill, targetCheck.matchedDevices, activeDevices)
      ) {
        scoredCandidates.push({ skill, score: 1 });
      }
    }
  }

  if (scoredCandidates.length === 0) return null;
  scoredCandidates.sort(
    (a, b) =>
      b.score - a.score ||
      b.skill.updatedAt - a.skill.updatedAt ||
      b.skill.useCount - a.skill.useCount,
  );
  return scoredCandidates[0]!.skill;
}

export function recordSkillUse(
  skillId: string,
  avoidedRetry = true,
  triggerText?: string,
): AgentSkill | null {
  const skills = loadAgentSkills();
  const hit = skills.find((s) => s.id === skillId);
  if (!hit) return null;
  hit.useCount += 1;
  if (avoidedRetry) {
    hit.retriesAvoided += 1;
  }
  hit.lastUsedAt = Date.now();
  // 若通过同义规范意图命中，静默补充该新触发表达以便后续精确命中（不改写 updatedAt 以免干扰附加指令时序判定）
  if (triggerText && triggerText.trim()) {
    const nextTriggers = dedupeTriggers([...hit.triggers, triggerText.trim()]);
    if (nextTriggers.length !== hit.triggers.length) {
      hit.triggers = nextTriggers;
      hit.markdownFile = syncSkillMarkdownFile(hit);
    }
  }
  persistSkills(skills);
  return hit;
}

export function setAgentSkillEnabled(skillId: string, enabled: boolean): AgentSkill | null {
  const skills = loadAgentSkills();
  const hit = skills.find((s) => s.id === skillId);
  if (!hit) return null;
  hit.enabled = Boolean(enabled);
  hit.updatedAt = Date.now();
  hit.markdownFile = syncSkillMarkdownFile(hit);
  persistSkills(skills);
  return hit;
}

export function deleteAgentSkill(skillId: string): boolean {
  const skills = loadAgentSkills();
  const next = skills.filter((s) => s.id !== skillId);
  if (next.length === skills.length) return false;
  persistSkills(next);
  removeSkillMarkdownFile(skillId);
  return true;
}

export function clearAgentSkills(): void {
  const prev = loadAgentSkills();
  for (const s of prev) {
    removeSkillMarkdownFile(s.id);
  }
  persistSkills([]);
}

/**
 * 构建注入系统提示词的紧凑 Skill 避坑参考段（供云端大模型参考已有经验）。
 */
export function buildSkillsPromptSection(skills: readonly AgentSkill[], maxItems = 8): string {
  const enabled = skills.filter((s) => s.enabled && s.steps.length > 0).slice(0, maxItems);
  if (enabled.length === 0) return "";
  const lines = [
    "已沉淀技能（Skills · 经真实状态校验通过的避坑流程；遇到对应设备的同类或同义任务时，必须优先采用以下已验证步骤覆盖常规默认参数，避免重蹈历史报错）：",
    ...enabled.map((s) => {
      const stepDesc = s.steps
        .slice(0, 3)
        .map((st) => `${st.toolName}(${JSON.stringify(st.args)})`)
        .join(" -> ");
      const trigPart =
        s.triggers.length > 0 ? ` | 触发:${s.triggers.slice(0, 3).join("/")}` : "";
      const pitfallPart = s.pitfall ? ` | 曾踩坑:${s.pitfall}` : "";
      return `- ${s.name}${trigPart}${pitfallPart} | 验证步骤:${stepDesc}`;
    }),
  ];
  return lines.join("\n");
}
