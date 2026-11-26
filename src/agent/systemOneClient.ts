// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * SystemOne 决策模型客户端（POST {baseUrl}/systemone）。
 *
 * 面向唤醒词误听校验、连续对话判别、双轨 ASR 择优、TTS 回声判别、
 * 指令意图分类、隐式家居动作识别与场景化即时应答词分类，提供：
 * - 单次 HTTP 批量多问题决策（choice / score / noul）
 * - 每实例熔断器（404/405/501、401/403 即刻熔断；超时/5xx/429 连续 2 次指数退避）
 * - 负向结果短 TTL LRU 缓存（仅缓存非执行判定，绝不缓存 valid_wake / followup）
 * - 严格脱敏与健康快照（零密钥暴露）
 */

import {
  DEFAULT_SYSTEMONE_MODEL,
  resolveEffectiveSystemOneAuth,
  type AgentVoiceConfig,
} from "../core/agentConfigStore.ts";
import { createBoundedFetch, type BoundedFetch, type FetchLike } from "../core/httpTimeout.ts";
import {
  isSelfContainedTaskAckUtterance,
  TASK_ACK_MIN_CONFIDENCE,
  TASK_ACK_QUESTION,
  resolveTaskAckPhrase,
  type TaskAckScenario,
} from "./taskAckPolicy.ts";

export type { TaskAckScenario };

// ==================== Wire Protocol Types ====================

export type SystemOneState = string | Record<string, unknown> | readonly unknown[];

export interface SystemOneChoiceQuestion<K extends string = string> {
  type: "choice";
  instructions: string;
  criteria: Record<K, string>;
}

export interface SystemOneChoiceAnswer<K extends string = string> {
  type: "choice";
  choice: K;
  probabilities: Record<K, number>;
  confidence: number;
}

export interface SystemOneScoreQuestion {
  type: "score";
  instructions: string;
  criteria: readonly string[];
}

export interface SystemOneScoreAnswer {
  type: "score";
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface SystemOneNoulQuestion {
  type: "noul";
  instructions: string;
}

export interface SystemOneNoulAnswer {
  type: "noul";
  noul: number;
}

export type SystemOneQuestion =
  | SystemOneChoiceQuestion<string>
  | SystemOneScoreQuestion
  | SystemOneNoulQuestion;

export type SystemOneAnswerFor<Q extends SystemOneQuestion> =
  Q extends SystemOneChoiceQuestion<infer K>
    ? SystemOneChoiceAnswer<K>
    : Q extends SystemOneScoreQuestion
      ? SystemOneScoreAnswer
      : Q extends SystemOneNoulQuestion
        ? SystemOneNoulAnswer
        : never;

export interface SystemOneUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface SystemOneResponse<
  Q extends Record<string, SystemOneQuestion> = Record<string, SystemOneQuestion>,
> {
  model: string;
  answers: { [P in keyof Q]: SystemOneAnswerFor<Q[P]> };
  usage: SystemOneUsage;
}

export interface SystemOneDecideOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  cacheKey?: string;
  cacheable?: boolean;
  /** 为 true 时，本次超时仅静默降级而不计入熔断器连续失败（适用于即时应答词等非门禁弱依赖） */
  softTimeout?: boolean;
}

// ==================== Domain Types ====================

export interface SystemOneHistoryEntry {
  role: "user" | "assistant";
  text: string;
}

export type WakeAttentionDecision = "valid_wake" | "false_wake";
export type WakeDeviceCommandDecision = "has_device_command" | "no_device_command";
export type WakeAttentionAcceptBy = "wake_word" | "device_command" | "both" | "none";
export type ConversationActionChoice = "followup" | "side_talk" | "goodbye";
export type CommandIntentChoice = "device_control" | "status_query" | "scene" | "general_chat";
export type DualTrackAsrChoice = "track_a" | "track_b" | "neither_noise";
export type EchoCheckChoice = "echo" | "user_command";
export type ImplicitActionChoice =
  | "light_brighter"
  | "light_dimmer"
  | "speaker_quieter"
  | "speaker_louder"
  | "power_off"
  | "power_on"
  | "query_status"
  | "needs_llm_agent";

export interface WakeAttentionAliasHint {
  matchedSurface: string;
  targetWakeWord: string;
  substitutedUtterance: string;
}

export interface WakeAttentionInput {
  utterance: string;
  wakeWords: readonly string[];
  /** 可选：句首疑似被 ASR 谐音/近音误听的触发词候选（仅用于原句字面语义 vs 替换回触发词后的语义对比） */
  suspectedWakeAlias?: WakeAttentionAliasHint | null;
  /** 可选：本地声学唤醒命中信号（仅在声学唤醒已命中且伴随近音候选时提供） */
  acousticWake?: { wakeWord: string; score: number; matched?: boolean } | null;
}

export interface WakeAttentionOptions {
  strict?: boolean;
}

export interface WakeAttentionResult {
  decision: WakeAttentionDecision;
  confidence: number;
  probabilities: Record<WakeAttentionDecision, number>;
  /** 或条件：判断 utterance 中是否存在控制智能家居设备的指令 */
  deviceCommand: {
    choice: WakeDeviceCommandDecision;
    confidence: number;
    probabilities: Record<WakeDeviceCommandDecision, number>;
  };
  /** 存在明确控制设备指令且置信度达标 */
  hasDeviceCommand: boolean;
  /** 放行依据：唤醒词有效 / 存在控制设备指令 / 两者同时命中 / 未放行 */
  acceptedBy: WakeAttentionAcceptBy;
  /** 满足或条件（确认有人在叫触发词 OR 存在控制设备指令）且置信度达标，可直接进入下一流程 */
  accepted: boolean;
  /** 判定为误听/误唤醒且无控制设备指令（或置信度不足未放行） */
  isFalseWake: boolean;
  model: string;
  usage: SystemOneUsage;
  latencyMs: number;
  cached: boolean;
}

export interface ConversationTurnInput {
  utterance: string;
  altUtterance?: string;
  recentHistory: ReadonlyArray<SystemOneHistoryEntry>;
  wakeWords?: readonly string[];
  lastSpokenReply?: string;
  acousticEvent?: string;
  speakerName?: string | null;
  /** 当前说话人声纹是否与本轮连续对话中的活跃说话人一致 */
  sameSpeaker?: boolean;
  acousticWake?: { wakeWord: string; score: number } | null;
  /** 当前家庭设备的特殊能力清单 */
  homeCapabilities?: readonly string[];
  /** 已学习的强化决策记忆触发短语示例 */
  learnedTriggers?: readonly string[];
  /** 当前正在等待用户回复的待确认槽位 */
  pendingConfirmation?: { questionText: string; summary: string } | null;
  /** 设备能力拓扑哈希（隔离缓存） */
  capabilityDigestHash?: string;
}

export interface ConversationTurnOptions {
  includeIntent?: boolean;
  strict?: boolean;
}

export interface ConversationTurnResult {
  action: ConversationActionChoice;
  confidence: number;
  probabilities: Record<ConversationActionChoice, number>;
  accepted: boolean;
  shouldExitConversation: boolean;
  intent?: {
    choice: CommandIntentChoice;
    confidence: number;
    probabilities: Record<CommandIntentChoice, number>;
  };
  asrBest?: {
    choice: DualTrackAsrChoice;
    confidence: number;
    probabilities: Record<DualTrackAsrChoice, number>;
    selectedText: string;
  };
  model: string;
  usage: SystemOneUsage;
  latencyMs: number;
  cached: boolean;
}

export interface CommandIntentInput {
  command: string;
  recentHistory?: ReadonlyArray<SystemOneHistoryEntry>;
}

export interface CommandIntentResult {
  intent: CommandIntentChoice;
  confidence: number;
  probabilities: Record<CommandIntentChoice, number>;
  model: string;
  usage: SystemOneUsage;
  latencyMs: number;
}

export interface DualTrackSelectionInput {
  trackA: string;
  trackB: string;
  wakeWords: readonly string[];
  acousticEvent?: string;
  inputSnrDb?: number;
}

export interface DualTrackSelectionResult {
  choice: DualTrackAsrChoice;
  selectedText: string;
  confidence: number;
  probabilities: Record<DualTrackAsrChoice, number>;
  model: string;
  usage: SystemOneUsage;
  latencyMs: number;
  cached: boolean;
}

export interface EchoCheckInput {
  lastSpoken: string;
  heard: string;
}

export interface EchoCheckResult {
  choice: EchoCheckChoice;
  isEcho: boolean;
  confidence: number;
  probabilities: Record<EchoCheckChoice, number>;
  model: string;
  usage: SystemOneUsage;
  latencyMs: number;
  cached?: boolean;
}

export interface ImplicitActionInput {
  utterance: string;
  recentHistory?: ReadonlyArray<SystemOneHistoryEntry>;
}

export interface ImplicitActionResult {
  action: ImplicitActionChoice;
  confidence: number;
  probabilities: Record<ImplicitActionChoice, number>;
  needsAgent: boolean;
  model: string;
  usage: SystemOneUsage;
  latencyMs: number;
  cached?: boolean;
}

export interface TaskAckInput {
  utterance: string;
  recentHistory?: ReadonlyArray<SystemOneHistoryEntry>;
  source?: "text" | "voice";
}

export interface TaskAckOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  minConfidence?: number;
  /** 为 true 时，本次超时仅静默降级本地应答而不计入熔断器失败 */
  softTimeout?: boolean;
}

export interface TaskAckClassificationResult {
  scenario: TaskAckScenario;
  ackText: string;
  confident: boolean;
  confidence: number;
  probabilities: Record<TaskAckScenario, number>;
  model: string;
  usage: SystemOneUsage;
  latencyMs: number;
  cached?: boolean;
}

// ==================== Health & Circuit Breaker Types ====================

export type SystemOneCircuitState = "closed" | "open" | "half-open";
export type SystemOneOpenReason =
  | "unsupported-endpoint"
  | "auth-error"
  | "transient-failures";
export type SystemOneFailureKind = "none" | "unsupported" | "timeout" | "network" | "auth";

export interface SystemOneHealthSnapshot {
  enabled: boolean;
  model: string;
  endpointHost: string;
  circuitState: SystemOneCircuitState;
  openReason: SystemOneOpenReason | null;
  retryAfterMs: number;
  lastLatencyMs: number | null;
  avgLatencyMs?: number | null;
  totalCalls: number;
  cacheHits: number;
  coalescedCalls?: number;
  softTimeouts?: number;
  lastFailureKind: SystemOneFailureKind;
  lastError: string | null;
}

export interface SystemOneClientOptions {
  baseUrl: string;
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  confidenceThreshold?: number;
  fetcher?: FetchLike;
  now?: () => number;
  cacheMaxEntries?: number;
  cacheTtlMs?: number;
}

// ==================== Constants ====================

export const DEFAULT_SYSTEMONE_TIMEOUT_MS = 2_000;
export const DEFAULT_SYSTEMONE_CONFIDENCE_THRESHOLD = 0.65;
export const GOODBYE_CONFIDENCE_THRESHOLD = 0.65;
export const SYSTEMONE_CACHE_MAX_ENTRIES = 64;
export const SYSTEMONE_CACHE_TTL_MS = 10_000;
export const SYSTEMONE_TASK_ACK_CACHE_MAX_ENTRIES = 128;
export const SYSTEMONE_TASK_ACK_CACHE_TTL_MS = 5 * 60 * 1000;
const AUX_CACHE_MAX_ENTRIES = 64;
const AUX_CACHE_TTL_MS = 15_000;
const PRECONNECT_MIN_INTERVAL_MS = 15_000;
const CONGESTION_COOLDOWN_MS = 15_000;
const CONGESTION_EWMA_THRESHOLD_MS = 1_200;

const UNSUPPORTED_COOLDOWN_MS = 10 * 60 * 1000; // 10 min
const AUTH_COOLDOWN_MS = 5 * 60 * 1000; // 5 min
const TRANSIENT_FAILURE_THRESHOLD = 2;
const TRANSIENT_BACKOFF_SCHEDULE_MS = [30_000, 60_000, 120_000, 300_000] as const;

const HISTORY_MAX_ENTRIES = 5;
const HISTORY_MAX_CHARS = 80;
const TASK_ACK_HISTORY_MAX_ENTRIES = 3;
const TASK_ACK_HISTORY_MAX_CHARS = 60;

// ==================== Calibrated Compact Bilingual-Safe Question Schemas ====================

const WAKE_DECISION_QUESTION: SystemOneChoiceQuestion<WakeAttentionDecision> = {
  type: "choice",
  instructions:
    "唤醒词检测已触发，仅判断 utterance 是否在呼叫 wake_words（支持中英文及同音/近音误听），不做上下文或设备能力判断。同音替换检验：对比原句字面与 suspected_wake_alias.if_replaced（或把句首近音词换回触发词），若原句生硬不通顺而替换后自然（如“你有播放点音乐吧”→“Neo，播放点音乐吧”），尤其伴随 acoustic_wake 命中，判 valid_wake；若原句字面本就是自然问句/陈述句（如“你有打开窗户吗？”“六个苹果多少钱”）或聊天/转述/评价/否定中顺带提及触发词，判 false_wake。",
  criteria: {
    valid_wake:
      "真正在呼唤触发词：直呼触发词，或句首近音词按字面不通顺、按 if_replaced 替换回触发词后自然通顺。",
    false_wake:
      "误听/误唤醒：字面本就是自然日常问句/陈述句、纯杂音碎片，或在聊天/转述/评价/否定中顺带提及而非呼叫。",
  },
};

const WAKE_DEVICE_COMMAND_QUESTION: SystemOneChoiceQuestion<WakeDeviceCommandDecision> = {
  type: "choice",
  instructions:
    "或条件：仅判断 utterance 是否含明确智能家居设备控制指令（开关/调节灯、空调、风扇、窗帘、电视、音箱/播放/音量、洗衣/烘干/洗袜子内裤、扫地机、加湿/除湿/净化、浴霸/热水器、插座、喂食器、场景模式，支持中英文及轻微同音误差）。纯是非问句、闲聊/天气/家务跑腿、第三人称提及、纯呼唤或杂音判 no_device_command。",
  criteria: {
    has_device_command:
      "含明确控制或调节智能家居设备的祈使指令（即使无唤醒词或句首唤醒词被吞字/误听）。",
    no_device_command:
      "不含控制设备指令：日常问句（如“你有打开窗户吗？”）、闲聊问答、家务跑腿、第三人称提及、纯呼唤或杂音。",
  },
};

const CONVERSATION_ACTION_QUESTION: SystemOneChoiceQuestion<ConversationActionChoice> = {
  type: "choice",
  instructions:
    "你是多平台智能家居控制助手（能力见 home_capabilities，含多筒洗衣机袜子/内裤筒、干衣机、扫地机、喂食器、灌溉等），当前处于连续对话模式（可省唤醒词；参考 history、learned_triggers、pending_confirmation、acoustic_wake、same_speaker）判断最新 utterance 性质。承接 history 对助手的叮嘱、提醒、批评、反馈、追问或自然回应，即使未提设备名也判 followup。",
  criteria: {
    followup:
      "继续与助手对话：显式/隐式设备控制（含命中 home_capabilities 或 learned_triggers）、回复 pending_confirmation、设偏好规则、查状态、环境抱怨、追问，或承接上文叮嘱/批评/反馈（如“那以后不要出现这种情况了”“下次注意一点”）。",
    side_talk:
      "与旁人聊天、自言自语、无联网设备支持的家务跑腿（如晚饭吃什么、倒水、拿筷子、取快递）或背景歌词/电视/噪声，未面向助手且未承接 history。",
    goodbye:
      "明确示意结束对话、道谢收尾或退下（如“谢谢不用了”“先这样吧”“再见”）。pending_confirmation 存在时“算了/不用了”优先算 followup；对助手的叮嘱/批评/提醒属 followup，绝不是 goodbye。",
  },
};

const COMMAND_INTENT_QUESTION: SystemOneChoiceQuestion<CommandIntentChoice> = {
  type: "choice",
  instructions: "判断智能家居用户指令的核心意图类别（支持中英文）。",
  criteria: {
    device_control:
      "直接或隐式控制/调节智能设备（开关、亮度、色温、音量、温度、窗帘、喂食、播放等）。",
    status_query:
      "仅查询设备状态或环境传感读数（温湿度、PM2.5、电量、是否开启等）。",
    scene:
      "触发或切换多设备联动场景或全屋模式（回家/离家/观影/睡眠/全屋关灯）。",
    general_chat:
      "非设备控制类普通闲聊、知识问答、打招呼或纯唤醒确认。",
  },
};

const DUAL_TRACK_ASR_QUESTION: SystemOneChoiceQuestion<DualTrackAsrChoice> = {
  type: "choice",
  instructions:
    "对比双轨识别 track_a 与 track_b（结合 wake_words 与声学信息），选出最准确反映人类对助手真实话语的轨，避免歌词或噪声幻觉。",
  criteria: {
    track_a: "track_a 更通顺完整，更准确保留唤醒词、设备名或有效指令。",
    track_b: "track_b 更通顺完整，更有效去噪并保留真实用户指令。",
    neither_noise: "双轨均为背景歌词、环境杂音或无意义碎片。",
  },
};

const ECHO_CHECK_QUESTION: SystemOneChoiceQuestion<EchoCheckChoice> = {
  type: "choice",
  instructions:
    "判断 heard 是刚朗读 last_spoken 的扬声器回声（含截断/谐音误差）还是用户新指令（中英文）。刚播报“已关闭客厅灯”后用户说“打开客厅灯”属反向新指令 user_command。",
  criteria: {
    echo: "heard 是 last_spoken 的重复、子串、截断残片或谐音误差，无新意图。",
    user_command: "用户新指令、反向控制、参数调节或追问，即使含相同设备名。",
  },
};

const IMPLICIT_ACTION_QUESTION: SystemOneChoiceQuestion<ImplicitActionChoice> = {
  type: "choice",
  instructions:
    "结合 history 判断用户隐式表达最直接对应的单一智能家居快捷动作，或交由 LLM Agent 处理（中英文）。",
  criteria: {
    light_brighter: "嫌太暗或希望调亮灯光。",
    light_dimmer: "嫌太亮/刺眼或希望调暗灯光。",
    speaker_quieter: "嫌太吵或希望调小音量。",
    speaker_louder: "嫌听不清或希望调大音量。",
    power_off: "想关闭当前讨论设备电源。",
    power_on: "想开启当前讨论设备电源。",
    query_status: "仅查询当前设备状态或温湿度读数。",
    needs_llm_agent: "多步复合指令、具体数值/色温/定时、多设备、场景、喂食、问答或意图不明。",
  },
};

// ==================== Pure Helpers ====================

/**
 * 规范化 SystemOne 接口地址：
 * 去除尾部斜杠；若已以 `/systemone` 结尾则保持不变，否则拼接 `/systemone`。
 */
export function buildSystemOneEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) return "";
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "";
    }
    const cleanPath = parsed.pathname.replace(/\/+$/, "");
    const normalizedBase = `${parsed.origin}${cleanPath}`;
    if (/\/systemone$/i.test(normalizedBase)) {
      return normalizedBase;
    }
    return `${normalizedBase}/systemone`;
  } catch {
    return "";
  }
}

/**
 * 对任何错误文本进行严格脱敏，确保不泄露 `sk-...`、`Bearer ...` 或原始 apiKey。
 */
export function redactSystemOneError(raw: string, apiKey?: string): string {
  let out = raw;
  const trimmedKey = apiKey?.trim();
  if (trimmedKey && trimmedKey.length >= 4) {
    out = out.split(trimmedKey).join("[REDACTED]");
  }
  out = out
    .replace(/\bsk-[A-Za-z0-9_\-]{6,}/gi, "[REDACTED]")
    .replace(/\bBearer\s+[^\s,;'"&}]+/gi, "[REDACTED]")
    .replace(
      /\b(api[_-]?key|authorization|x-api-key|x-goog-api-key)\s*[:=]\s*[^\s,;'"&}]+/gi,
      "[REDACTED]",
    );
  return out.trim();
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncateText(text: string, maxChars: number): string {
  const clean = collapseWhitespace(text);
  if (clean.length <= maxChars) return clean;
  if (maxChars <= 1) return clean.slice(0, maxChars);
  return `${clean.slice(0, maxChars - 1)}…`;
}

/**
 * 将近期对话历史压缩为紧凑格式 `["U: ...", "A: ..."]`：
 * 最多保留最近 `maxEntries` 条（默认 5 条），每条总长度不超过 `maxChars`（默认 80 字符）。
 */
export function formatCompactHistory(
  recentHistory?: ReadonlyArray<SystemOneHistoryEntry>,
  maxEntries: number = HISTORY_MAX_ENTRIES,
  maxChars: number = HISTORY_MAX_CHARS,
): string[] {
  if (!recentHistory || recentHistory.length === 0 || maxEntries <= 0) {
    return [];
  }
  const nonEmpty: Array<{ role: "user" | "assistant"; text: string }> = [];
  for (const entry of recentHistory) {
    const clean = collapseWhitespace(entry.text ?? "");
    if (!clean) continue;
    nonEmpty.push({ role: entry.role, text: clean });
  }
  const slice = nonEmpty.slice(-maxEntries);
  return slice.map((entry) => {
    const prefix = entry.role === "user" ? "U: " : "A: ";
    const budget = Math.max(1, maxChars - prefix.length);
    return `${prefix}${truncateText(entry.text, budget)}`;
  });
}

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return Boolean(val) && typeof val === "object" && !Array.isArray(val);
}

function clamp01(val: number): number {
  if (!Number.isFinite(val)) return 0;
  return Math.max(0, Math.min(1, val));
}

function isTimeoutError(err: unknown): boolean {
  if (!err) return false;
  if (err instanceof DOMException && (err.name === "TimeoutError" || err.name === "AbortError")) {
    return true;
  }
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || err.name === "AbortError") return true;
    if (/\b(?:timed?\s*out|timeout|aborted)\b/i.test(err.message)) return true;
  }
  return false;
}

function validateAndNormalizeResponse<Q extends Record<string, SystemOneQuestion>>(
  parsed: unknown,
  questions: Q,
  fallbackModel: string,
): SystemOneResponse<Q> | null {
  if (!isPlainObject(parsed)) return null;
  const rawAnswers = parsed.answers;
  if (!isPlainObject(rawAnswers)) return null;

  const normalizedAnswers: Record<string, unknown> = {};

  for (const [qKey, qDef] of Object.entries(questions)) {
    const rawAns = rawAnswers[qKey];
    if (!isPlainObject(rawAns)) return null;

    if (qDef.type === "choice") {
      if (rawAns.type !== "choice") return null;
      if (typeof rawAns.choice !== "string") return null;
      if (!Object.prototype.hasOwnProperty.call(qDef.criteria, rawAns.choice)) return null;
      if (!isPlainObject(rawAns.probabilities)) return null;

      const rawProbs = rawAns.probabilities;
      const probs: Record<string, number> = {};
      for (const optionKey of Object.keys(qDef.criteria)) {
        const p = Number(rawProbs[optionKey]);
        probs[optionKey] = Number.isFinite(p) ? clamp01(p) : 0;
      }

      const confNum = Number(rawAns.confidence);
      if (!Number.isFinite(confNum)) return null;

      normalizedAnswers[qKey] = {
        type: "choice",
        choice: rawAns.choice,
        probabilities: probs,
        confidence: clamp01(confNum),
      };
    } else if (qDef.type === "score") {
      if (rawAns.type !== "score") return null;
      const scoreNum = Number(rawAns.score);
      const confNum = Number(rawAns.confidence);
      if (!Number.isFinite(scoreNum) || !Number.isFinite(confNum)) return null;
      if (!isPlainObject(rawAns.legend) || !isPlainObject(rawAns.probabilities)) return null;

      const legend: Record<string, string> = {};
      for (const [k, v] of Object.entries(rawAns.legend)) {
        legend[k] = String(v ?? "");
      }
      const probs: Record<string, number> = {};
      for (const [k, v] of Object.entries(rawAns.probabilities)) {
        const p = Number(v);
        probs[k] = Number.isFinite(p) ? clamp01(p) : 0;
      }

      normalizedAnswers[qKey] = {
        type: "score",
        score: scoreNum,
        legend,
        probabilities: probs,
        confidence: clamp01(confNum),
      };
    } else if (qDef.type === "noul") {
      if (rawAns.type !== "noul") return null;
      const noulNum = Number(rawAns.noul);
      if (!Number.isFinite(noulNum)) return null;
      normalizedAnswers[qKey] = {
        type: "noul",
        noul: noulNum,
      };
    } else {
      return null;
    }
  }

  const rawUsage = isPlainObject(parsed.usage) ? parsed.usage : {};
  const inputTokens = Number(rawUsage.input_tokens);
  const outputTokens = Number(rawUsage.output_tokens);

  const model =
    typeof parsed.model === "string" && parsed.model.trim().length > 0
      ? parsed.model.trim()
      : fallbackModel;

  return {
    model,
    answers: normalizedAnswers as { [P in keyof Q]: SystemOneAnswerFor<Q[P]> },
    usage: {
      input_tokens: Number.isFinite(inputTokens) && inputTokens >= 0 ? Math.round(inputTokens) : 0,
      output_tokens:
        Number.isFinite(outputTokens) && outputTokens >= 0 ? Math.round(outputTokens) : 0,
    },
  };
}

// ==================== Short-TTL LRU Cache ====================

interface LruCacheEntry<T> {
  value: T;
  storedAt: number;
}

class ShortTtlLruCache<T> {
  private readonly _map = new Map<string, LruCacheEntry<T>>();
  private readonly _maxEntries: number;
  private readonly _ttlMs: number;
  private readonly _now: () => number;

  constructor(maxEntries: number, ttlMs: number, now: () => number) {
    this._maxEntries = Math.max(1, maxEntries);
    this._ttlMs = Math.max(1, ttlMs);
    this._now = now;
  }

  get(key: string): T | undefined {
    const entry = this._map.get(key);
    if (!entry) return undefined;
    if (this._now() - entry.storedAt >= this._ttlMs) {
      this._map.delete(key);
      return undefined;
    }
    // 刷新 LRU 顺序（移至尾部）
    this._map.delete(key);
    this._map.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T): void {
    const nowMs = this._now();
    if (this._map.has(key)) {
      this._map.delete(key);
    }
    if (this._map.size >= this._maxEntries) {
      for (const [k, entry] of this._map) {
        if (nowMs - entry.storedAt >= this._ttlMs) {
          this._map.delete(k);
        }
      }
    }
    while (this._map.size >= this._maxEntries) {
      const oldestKey = this._map.keys().next().value;
      if (oldestKey === undefined) break;
      this._map.delete(oldestKey);
    }
    this._map.set(key, { value, storedAt: nowMs });
  }

  clear(): void {
    this._map.clear();
  }

  get size(): number {
    return this._map.size;
  }
}

// ==================== SystemOneClient ====================

interface InFlightRequestEntry {
  promise: Promise<SystemOneResponse<Record<string, SystemOneQuestion>> | null>;
  controller: AbortController;
  waiters: number;
  timeoutMs: number;
}

export class SystemOneClient {
  private readonly _enabled: boolean;
  private readonly _endpoint: string;
  private readonly _endpointOrigin: string;
  private readonly _endpointHost: string;
  private readonly _apiKey: string | undefined;
  private readonly _model: string;
  private readonly _timeoutMs: number;
  private readonly _confidenceThreshold: number;
  private readonly _fetch: BoundedFetch;
  private readonly _rawFetcher: FetchLike | undefined;
  private readonly _now: () => number;
  private readonly _cache: ShortTtlLruCache<unknown>;
  private readonly _taskAckCache: ShortTtlLruCache<TaskAckClassificationResult>;
  private readonly _auxCache: ShortTtlLruCache<unknown>;
  private readonly _inFlight = new Map<string, InFlightRequestEntry>();

  // Circuit breaker state
  private _circuitState: SystemOneCircuitState = "closed";
  private _openReason: SystemOneOpenReason | null = null;
  private _openedUntilMs = 0;
  private _consecutiveFailures = 0;
  private _transientBackoffLevel = 0;
  private _halfOpenProbeInFlight = false;
  private _lastFailureKind: SystemOneFailureKind = "none";
  private _lastError: string | null = null;

  // Telemetry & connection warmup
  private _lastLatencyMs: number | null = null;
  private _avgLatencyMs: number | null = null;
  private _totalCalls = 0;
  private _cacheHits = 0;
  private _coalescedCalls = 0;
  private _softTimeouts = 0;
  private _lastSoftTimeoutAtMs = 0;
  private _lastPreconnectAtMs = 0;

  constructor(options: SystemOneClientOptions) {
    this._endpoint = buildSystemOneEndpoint(options.baseUrl);
    this._enabled = this._endpoint.length > 0;
    if (this._enabled) {
      const parsed = new URL(this._endpoint);
      this._endpointOrigin = parsed.origin;
      this._endpointHost = parsed.host;
    } else {
      this._endpointOrigin = "";
      this._endpointHost = "";
    }

    this._apiKey = options.apiKey?.trim() || undefined;
    this._model = options.model?.trim() || DEFAULT_SYSTEMONE_MODEL;
    this._timeoutMs =
      typeof options.timeoutMs === "number" &&
      Number.isFinite(options.timeoutMs) &&
      options.timeoutMs > 0
        ? Math.round(options.timeoutMs)
        : DEFAULT_SYSTEMONE_TIMEOUT_MS;
    this._confidenceThreshold =
      typeof options.confidenceThreshold === "number" &&
      Number.isFinite(options.confidenceThreshold)
        ? Math.max(0.1, Math.min(0.99, options.confidenceThreshold))
        : DEFAULT_SYSTEMONE_CONFIDENCE_THRESHOLD;
    this._now = options.now ?? (() => Date.now());
    this._rawFetcher = options.fetcher;
    this._fetch = createBoundedFetch(options.fetcher, this._timeoutMs);
    this._cache = new ShortTtlLruCache<unknown>(
      options.cacheMaxEntries ?? SYSTEMONE_CACHE_MAX_ENTRIES,
      options.cacheTtlMs ?? SYSTEMONE_CACHE_TTL_MS,
      this._now,
    );
    this._taskAckCache = new ShortTtlLruCache<TaskAckClassificationResult>(
      SYSTEMONE_TASK_ACK_CACHE_MAX_ENTRIES,
      SYSTEMONE_TASK_ACK_CACHE_TTL_MS,
      this._now,
    );
    this._auxCache = new ShortTtlLruCache<unknown>(
      AUX_CACHE_MAX_ENTRIES,
      AUX_CACHE_TTL_MS,
      this._now,
    );
  }

  /**
   * 根据 `AgentVoiceConfig` 创建 `SystemOneClient`；若未启用或无有效凭据则返回 `null`。
   */
  static fromConfig(
    config: AgentVoiceConfig,
    fetcher?: FetchLike,
    options?: { now?: () => number },
  ): SystemOneClient | null {
    const auth = resolveEffectiveSystemOneAuth(config);
    if (!auth.enabled || !auth.baseUrl) {
      return null;
    }
    return new SystemOneClient({
      baseUrl: auth.baseUrl,
      apiKey: auth.apiKey,
      model: auth.model,
      timeoutMs: auth.timeoutMs,
      confidenceThreshold: auth.confidenceThreshold,
      fetcher,
      now: options?.now,
    });
  }

  get enabled(): boolean {
    return this._enabled;
  }

  get model(): string {
    return this._model;
  }

  get endpoint(): string {
    return this._endpoint;
  }

  get confidenceThreshold(): number {
    return this._confidenceThreshold;
  }

  get lastFailureKind(): SystemOneFailureKind {
    return this._lastFailureKind;
  }

  get avgLatencyMs(): number | null {
    return this._avgLatencyMs;
  }

  /**
   * 指示 SystemOne 当前是否处于高延迟/刚发生软超时拥塞窗口，供非门禁调用（如即时应答词分类）自动避峰降级。
   */
  get isCongestedForNonCritical(): boolean {
    if (this._circuitState === "open") {
      return this._now() < this._openedUntilMs;
    }
    if (
      this._lastSoftTimeoutAtMs > 0 &&
      this._now() - this._lastSoftTimeoutAtMs < CONGESTION_COOLDOWN_MS
    ) {
      return true;
    }
    return (
      this._avgLatencyMs !== null &&
      this._avgLatencyMs >= CONGESTION_EWMA_THRESHOLD_MS &&
      this._totalCalls >= 2
    );
  }

  /**
   * 预热到 SystemOne 网关的 TCP/TLS 连接（若运行时支持 `fetch.preconnect`）。
   * 内置节流窗口（默认 15s）以便在唤醒命中、开口说话与任务提交前安全高频调用。
   */
  preconnect(options?: { force?: boolean; minIntervalMs?: number }): void {
    if (!this._enabled || !this._endpointOrigin) return;
    const nowMs = this._now();
    const minInterval =
      typeof options?.minIntervalMs === "number" && options.minIntervalMs >= 0
        ? options.minIntervalMs
        : PRECONNECT_MIN_INTERVAL_MS;
    if (
      !options?.force &&
      this._lastPreconnectAtMs > 0 &&
      nowMs >= this._lastPreconnectAtMs &&
      nowMs - this._lastPreconnectAtMs < minInterval
    ) {
      return;
    }
    this._lastPreconnectAtMs = nowMs;
    try {
      if (this._rawFetcher) {
        const customPreconnect = (
          this._rawFetcher as FetchLike & { preconnect?: typeof fetch.preconnect }
        ).preconnect;
        if (typeof customPreconnect === "function") {
          customPreconnect.call(this._rawFetcher, this._endpointOrigin);
        }
        return;
      }
      globalThis.fetch.preconnect?.(this._endpointOrigin);
    } catch {
      // 忽略预连接失败，绝不影响主流程
    }
  }

  /**
   * 重置熔断器状态并清空所有结果缓存与在途合并索引。
   */
  reset(): void {
    this._circuitState = "closed";
    this._openReason = null;
    this._openedUntilMs = 0;
    this._consecutiveFailures = 0;
    this._transientBackoffLevel = 0;
    this._halfOpenProbeInFlight = false;
    this._lastFailureKind = "none";
    this._lastError = null;
    this._avgLatencyMs = null;
    this._lastSoftTimeoutAtMs = 0;
    this._lastPreconnectAtMs = 0;
    this._cache.clear();
    this._taskAckCache.clear();
    this._auxCache.clear();
    this._inFlight.clear();
  }

  /**
   * 返回脱敏后的客户端健康快照（绝不包含 API Key 或鉴权头）。
   */
  getStatus(): SystemOneHealthSnapshot {
    const nowMs = this._now();
    let effectiveState: SystemOneCircuitState = this._circuitState;
    let retryAfterMs = 0;

    if (this._circuitState === "open") {
      if (nowMs >= this._openedUntilMs) {
        effectiveState = "half-open";
        retryAfterMs = 0;
      } else {
        retryAfterMs = Math.max(0, this._openedUntilMs - nowMs);
      }
    }

    return {
      enabled: this._enabled,
      model: this._model,
      endpointHost: this._endpointHost,
      circuitState: effectiveState,
      openReason: effectiveState === "closed" ? null : this._openReason,
      retryAfterMs,
      lastLatencyMs: this._lastLatencyMs,
      avgLatencyMs: this._avgLatencyMs,
      totalCalls: this._totalCalls,
      cacheHits: this._cacheHits,
      coalescedCalls: this._coalescedCalls,
      softTimeouts: this._softTimeouts,
      lastFailureKind: this._lastFailureKind,
      lastError: this._lastError,
    };
  }

  private _effectiveAcceptThreshold(strict?: boolean): number {
    if (!strict) return this._confidenceThreshold;
    return Math.min(0.95, Math.max(0.75, Number((this._confidenceThreshold + 0.1).toFixed(2))));
  }

  private _recordSuccess(latencyMs: number): void {
    this._circuitState = "closed";
    this._openReason = null;
    this._openedUntilMs = 0;
    this._consecutiveFailures = 0;
    this._transientBackoffLevel = 0;
    this._halfOpenProbeInFlight = false;
    this._lastFailureKind = "none";
    this._lastError = null;
    this._lastLatencyMs = latencyMs;
    this._avgLatencyMs =
      this._avgLatencyMs === null
        ? latencyMs
        : Math.round(this._avgLatencyMs * 0.7 + latencyMs * 0.3);
  }

  private _recordFailure(
    kind: Exclude<SystemOneFailureKind, "none">,
    rawError: string,
    wasHalfOpen: boolean,
  ): void {
    const nowMs = this._now();
    this._halfOpenProbeInFlight = false;
    this._lastFailureKind = kind;
    this._lastError = redactSystemOneError(rawError, this._apiKey).slice(0, 200);
    this._consecutiveFailures += 1;

    if (kind === "unsupported") {
      this._circuitState = "open";
      this._openReason = "unsupported-endpoint";
      this._openedUntilMs = nowMs + UNSUPPORTED_COOLDOWN_MS;
      return;
    }

    if (kind === "auth") {
      this._circuitState = "open";
      this._openReason = "auth-error";
      this._openedUntilMs = nowMs + AUTH_COOLDOWN_MS;
      return;
    }

    // timeout / network / 429 / 5xx / invalid JSON
    if (wasHalfOpen || this._consecutiveFailures >= TRANSIENT_FAILURE_THRESHOLD) {
      const idx = Math.min(this._transientBackoffLevel, TRANSIENT_BACKOFF_SCHEDULE_MS.length - 1);
      const cooldownMs = TRANSIENT_BACKOFF_SCHEDULE_MS[idx]!;
      this._transientBackoffLevel = Math.min(
        this._transientBackoffLevel + 1,
        TRANSIENT_BACKOFF_SCHEDULE_MS.length - 1,
      );
      this._circuitState = "open";
      this._openReason = "transient-failures";
      this._openedUntilMs = nowMs + cooldownMs;
    }
  }

  private _awaitInFlight<Q extends Record<string, SystemOneQuestion>>(
    entry: InFlightRequestEntry,
    callerSignal?: AbortSignal,
  ): Promise<SystemOneResponse<Q> | null> {
    if (!callerSignal) {
      return entry.promise as Promise<SystemOneResponse<Q> | null>;
    }
    if (callerSignal.aborted) {
      entry.waiters = Math.max(0, entry.waiters - 1);
      if (entry.waiters === 0) {
        entry.controller.abort(callerSignal.reason);
      }
      return Promise.resolve(null);
    }
    return new Promise<SystemOneResponse<Q> | null>((resolve) => {
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        entry.waiters = Math.max(0, entry.waiters - 1);
        if (entry.waiters === 0) {
          entry.controller.abort(callerSignal.reason);
        }
        resolve(null);
      };
      callerSignal.addEventListener("abort", onAbort, { once: true });
      entry.promise.then(
        (res) => {
          if (settled) return;
          settled = true;
          callerSignal.removeEventListener("abort", onAbort);
          resolve(res as SystemOneResponse<Q> | null);
        },
        () => {
          if (settled) return;
          settled = true;
          callerSignal.removeEventListener("abort", onAbort);
          resolve(null);
        },
      );
    });
  }

  /**
   * 通用 SystemOne 决策调用。
   * 支持任意 `choice` / `score` / `noul` 问题组合的单次批量调用，
   * 并在闭路状态下自动合并并发相同请求以消除单 GPU 重复排队开销。
   */
  async decide<Q extends Record<string, SystemOneQuestion>>(
    state: SystemOneState,
    questions: Q,
    options?: SystemOneDecideOptions,
  ): Promise<SystemOneResponse<Q> | null> {
    if (!this._enabled) {
      return null;
    }
    if (options?.signal?.aborted) {
      return null;
    }
    if (Object.keys(questions).length === 0) {
      return null;
    }

    const cacheKey = options?.cacheable && options.cacheKey ? `decide:${options.cacheKey}` : null;
    if (cacheKey) {
      const cached = this._cache.get(cacheKey) as SystemOneResponse<Q> | undefined;
      if (cached) {
        this._cacheHits += 1;
        return cached;
      }
    }

    const nowMs = this._now();
    let isHalfOpenProbe = false;

    if (this._circuitState === "open") {
      if (nowMs < this._openedUntilMs) {
        return null;
      }
      this._circuitState = "half-open";
      this._halfOpenProbeInFlight = true;
      isHalfOpenProbe = true;
    } else if (this._circuitState === "half-open") {
      if (this._halfOpenProbeInFlight) {
        return null;
      }
      this._halfOpenProbeInFlight = true;
      isHalfOpenProbe = true;
    }

    const effectiveTimeoutMs =
      typeof options?.timeoutMs === "number" &&
      Number.isFinite(options.timeoutMs) &&
      options.timeoutMs > 0
        ? Math.round(options.timeoutMs)
        : this._timeoutMs;

    const body = JSON.stringify({
      model: this._model,
      state,
      questions,
    });

    const softTimeout = Boolean(options?.softTimeout);
    const canCoalesce = !isHalfOpenProbe && !softTimeout;
    if (canCoalesce) {
      const existing = this._inFlight.get(body);
      if (existing && existing.timeoutMs <= effectiveTimeoutMs) {
        existing.waiters += 1;
        this._coalescedCalls += 1;
        return this._awaitInFlight<Q>(existing, options?.signal);
      }
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (this._apiKey) {
      headers["Authorization"] = `Bearer ${this._apiKey}`;
    }

    const controller = new AbortController();
    const runRequest = async (): Promise<SystemOneResponse<Q> | null> => {
      this._totalCalls += 1;
      const t0 = performance.now();

      try {
        const res = await this._fetch(this._endpoint, {
          method: "POST",
          headers,
          body,
          timeoutMs: effectiveTimeoutMs,
          signal: controller.signal,
        });

        const elapsedMs = Math.max(0, Math.round(performance.now() - t0));
        const text = await res.text();

        if (!res.ok) {
          const snippet = text.slice(0, 240);
          const detail = snippet ? `HTTP ${res.status}: ${snippet}` : `HTTP ${res.status}`;
          if (res.status === 404 || res.status === 405 || res.status === 501) {
            this._recordFailure("unsupported", detail, isHalfOpenProbe);
          } else if (res.status === 401 || res.status === 403) {
            this._recordFailure("auth", detail, isHalfOpenProbe);
          } else if (res.status === 408 || res.status === 504) {
            if (softTimeout) {
              if (isHalfOpenProbe) this._halfOpenProbeInFlight = false;
              this._softTimeouts += 1;
              this._lastSoftTimeoutAtMs = this._now();
            } else {
              this._recordFailure("timeout", detail, isHalfOpenProbe);
            }
          } else {
            this._recordFailure("network", detail, isHalfOpenProbe);
          }
          return null;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this._recordFailure("network", `无效 JSON 响应: ${msg}`, isHalfOpenProbe);
          return null;
        }

        const validated = validateAndNormalizeResponse(parsed, questions, this._model);
        if (!validated) {
          this._recordFailure("network", "SystemOne 响应结构不合法或缺少预期答案字段", isHalfOpenProbe);
          return null;
        }

        this._recordSuccess(elapsedMs);
        if (cacheKey) {
          this._cache.set(cacheKey, validated);
        }
        return validated;
      } catch (err) {
        if (controller.signal.aborted) {
          if (isHalfOpenProbe) {
            this._halfOpenProbeInFlight = false;
          }
          return null;
        }
        const msg = err instanceof Error ? err.message : String(err);
        const isTimeout = isTimeoutError(err);
        if (softTimeout && isTimeout) {
          if (isHalfOpenProbe) {
            this._halfOpenProbeInFlight = false;
          }
          this._softTimeouts += 1;
          this._lastSoftTimeoutAtMs = this._now();
          return null;
        }
        const kind: Exclude<SystemOneFailureKind, "none"> = isTimeout ? "timeout" : "network";
        this._recordFailure(kind, msg, isHalfOpenProbe);
        return null;
      }
    };

    const promise = runRequest();
    const entry: InFlightRequestEntry = {
      promise: promise as Promise<SystemOneResponse<Record<string, SystemOneQuestion>> | null>,
      controller,
      waiters: 1,
      timeoutMs: effectiveTimeoutMs,
    };

    if (canCoalesce) {
      this._inFlight.set(body, entry);
      void promise.finally(() => {
        if (this._inFlight.get(body) === entry) {
          this._inFlight.delete(body);
        }
      });
    }

    return this._awaitInFlight<Q>(entry, options?.signal);
  }

  /**
   * (a) 唤醒词触发后校验（单次请求并行二分类：`decision` 唤醒词非误听 OR `device_command` 存在控制设备指令）。
   * 满足任一条件且置信度达标即放行不拦截，不附带上下文/背景/设备能力/双轨等其它字段；
   * 仅缓存完全未通过（既非唤醒词又无控制设备指令）的负向判定，绝不缓存任何放行判定。
   */
  async evaluateWakeAttention(
    input: WakeAttentionInput,
    opts?: WakeAttentionOptions,
  ): Promise<WakeAttentionResult | null> {
    if (!this._enabled) return null;

    const cleanUtterance = collapseWhitespace(input.utterance);
    if (!cleanUtterance) return null;

    const wakeWords = input.wakeWords.map((w) => w.trim()).filter(Boolean);
    const strict = Boolean(opts?.strict);
    const aliasHeard = input.suspectedWakeAlias?.matchedSurface
      ? collapseWhitespace(input.suspectedWakeAlias.matchedSurface)
      : "";
    const aliasTarget = input.suspectedWakeAlias?.targetWakeWord
      ? collapseWhitespace(input.suspectedWakeAlias.targetWakeWord)
      : "";
    const aliasReplaced = input.suspectedWakeAlias?.substitutedUtterance
      ? collapseWhitespace(input.suspectedWakeAlias.substitutedUtterance)
      : "";
    const hasAliasHint = Boolean(aliasHeard && aliasTarget && aliasReplaced);
    const matchedAcousticWake =
      hasAliasHint && input.acousticWake && input.acousticWake.matched !== false
        ? {
            wake_word: input.acousticWake.wakeWord.trim(),
            score: Number(input.acousticWake.score.toFixed(3)),
          }
        : null;

    const cacheKey = JSON.stringify([
      "wake",
      cleanUtterance.toLowerCase(),
      wakeWords.map((w) => w.toLowerCase()),
      hasAliasHint ? `${aliasHeard.toLowerCase()}->${aliasTarget.toLowerCase()}` : "",
      matchedAcousticWake
        ? `${matchedAcousticWake.wake_word.toLowerCase()}:${matchedAcousticWake.score.toFixed(2)}`
        : "",
      strict,
    ]);

    const cached = this._cache.get(cacheKey) as WakeAttentionResult | undefined;
    if (cached) {
      this._cacheHits += 1;
      return { ...cached, latencyMs: 0, cached: true };
    }

    const state: Record<string, unknown> = {
      utterance: cleanUtterance,
      wake_words: wakeWords,
    };
    if (hasAliasHint) {
      state.suspected_wake_alias = {
        heard: aliasHeard,
        target_wake_word: aliasTarget,
        if_replaced: aliasReplaced,
      };
    }
    if (matchedAcousticWake && matchedAcousticWake.wake_word) {
      state.acoustic_wake = matchedAcousticWake;
    }

    const questions = {
      decision: WAKE_DECISION_QUESTION,
      device_command: WAKE_DEVICE_COMMAND_QUESTION,
    };

    const t0 = performance.now();
    const res = await this.decide(state, questions);
    if (!res) return null;

    const latencyMs = Math.max(0, Math.round(performance.now() - t0));
    const decisionAns = res.answers.decision;
    const deviceCmdAns = res.answers.device_command;
    const acceptThreshold = this._effectiveAcceptThreshold(strict);
    const decision = decisionAns.choice;
    const confidence = decisionAns.confidence;
    const wakeAccepted = decision === "valid_wake" && confidence >= acceptThreshold;
    const hasDeviceCommand =
      deviceCmdAns.choice === "has_device_command" && deviceCmdAns.confidence >= acceptThreshold;
    const accepted = wakeAccepted || hasDeviceCommand;
    const isFalseWake = !accepted;
    const acceptedBy: WakeAttentionAcceptBy =
      wakeAccepted && hasDeviceCommand
        ? "both"
        : wakeAccepted
          ? "wake_word"
          : hasDeviceCommand
            ? "device_command"
            : "none";

    const result: WakeAttentionResult = {
      decision,
      confidence,
      probabilities: decisionAns.probabilities,
      deviceCommand: {
        choice: deviceCmdAns.choice,
        confidence: deviceCmdAns.confidence,
        probabilities: deviceCmdAns.probabilities,
      },
      hasDeviceCommand,
      acceptedBy,
      accepted,
      isFalseWake,
      model: res.model,
      usage: res.usage,
      latencyMs,
      cached: false,
    };

    // 仅缓存完全未通过（既非唤醒词又无控制设备指令）的负向判定，绝不缓存任何放行判定
    if (!accepted && decision === "false_wake" && deviceCmdAns.choice === "no_device_command") {
      this._cache.set(cacheKey, result);
    }

    return result;
  }

  /**
   * (b) 连续对话轮次评估（附带最近 5 条紧凑 `U:/A:` 历史，单次批量请求）。
   * 仅缓存非执行判定（`side_talk` / `goodbye`），绝不缓存 `followup`。
   */
  async evaluateConversationTurn(
    input: ConversationTurnInput,
    opts?: ConversationTurnOptions,
  ): Promise<ConversationTurnResult | null> {
    if (!this._enabled) return null;

    const cleanUtterance = collapseWhitespace(input.utterance);
    const cleanAlt = input.altUtterance ? collapseWhitespace(input.altUtterance) : "";
    if (!cleanUtterance && !cleanAlt) return null;

    const primaryText = cleanUtterance || cleanAlt;
    const hasDistinctAlt = Boolean(cleanUtterance && cleanAlt && cleanAlt !== cleanUtterance);
    const compactHistory = formatCompactHistory(
      input.recentHistory,
      HISTORY_MAX_ENTRIES,
      HISTORY_MAX_CHARS,
    );
    const wakeWords = (input.wakeWords ?? []).map((w) => w.trim()).filter(Boolean);
    const lastSpoken = input.lastSpokenReply ? truncateText(input.lastSpokenReply, HISTORY_MAX_CHARS) : "";
    const includeIntent = Boolean(opts?.includeIntent);
    const strict = Boolean(opts?.strict);

    const hasPendingConfirm = Boolean(input.pendingConfirmation?.questionText);
    const cacheKey = JSON.stringify([
      "conv",
      primaryText.toLowerCase(),
      hasDistinctAlt ? cleanAlt.toLowerCase() : "",
      compactHistory,
      wakeWords.map((w) => w.toLowerCase()),
      lastSpoken.toLowerCase(),
      input.acousticEvent ?? "",
      input.speakerName ?? "",
      input.sameSpeaker === true ? "same_spk" : "",
      input.acousticWake
        ? `${input.acousticWake.wakeWord.toLowerCase()}:${input.acousticWake.score.toFixed(2)}`
        : "",
      input.capabilityDigestHash ?? "",
      includeIntent,
      strict,
    ]);

    if (!hasPendingConfirm) {
      const cached = this._cache.get(cacheKey) as ConversationTurnResult | undefined;
      if (cached) {
        this._cacheHits += 1;
        return { ...cached, latencyMs: 0, cached: true };
      }
    }

    const state: Record<string, unknown> = {
      utterance: primaryText,
      history: compactHistory,
    };
    if (hasDistinctAlt) {
      state.track_a = primaryText;
      state.track_b = cleanAlt;
    }
    if (wakeWords.length > 0 && (hasDistinctAlt || input.acousticWake)) {
      state.wake_words = wakeWords.slice(0, 4);
    }
    const latestAssistantHistory = [...compactHistory]
      .reverse()
      .find((line) => line.startsWith("A: "));
    const lastSpokenAlreadyInHistory = Boolean(
      lastSpoken &&
        latestAssistantHistory &&
        latestAssistantHistory.slice(3).includes(lastSpoken.slice(0, 24)),
    );
    if (lastSpoken && !lastSpokenAlreadyInHistory) {
      state.last_spoken_reply = lastSpoken;
    }
    if (input.acousticEvent) state.acoustic_event = input.acousticEvent;
    if (input.speakerName) state.speaker = input.speakerName;
    if (input.sameSpeaker === true) state.same_speaker = true;
    if (input.acousticWake) {
      state.acoustic_wake = {
        wake_word: input.acousticWake.wakeWord,
        score: Number(input.acousticWake.score.toFixed(3)),
      };
    }
    if (input.homeCapabilities && input.homeCapabilities.length > 0) {
      state.home_capabilities = input.homeCapabilities
        .slice(0, 8)
        .map((line) => truncateText(line, 56));
    }
    if (input.learnedTriggers && input.learnedTriggers.length > 0) {
      state.learned_triggers = input.learnedTriggers
        .slice(0, 8)
        .map((line) => truncateText(line, 36));
    }
    if (hasPendingConfirm && input.pendingConfirmation) {
      state.pending_confirmation = {
        question: truncateText(input.pendingConfirmation.questionText, 120),
        summary: truncateText(input.pendingConfirmation.summary, 100),
      };
    }

    const questions: Record<string, SystemOneQuestion> = {
      conv_action: CONVERSATION_ACTION_QUESTION,
    };
    if (includeIntent) {
      questions.intent = COMMAND_INTENT_QUESTION;
    }
    if (hasDistinctAlt) {
      questions.asr_best = DUAL_TRACK_ASR_QUESTION;
    }

    const t0 = performance.now();
    const res = await this.decide(state, questions);
    if (!res) return null;

    const latencyMs = Math.max(0, Math.round(performance.now() - t0));
    const actionAns = res.answers.conv_action as SystemOneChoiceAnswer<ConversationActionChoice>;
    const acceptThreshold = this._effectiveAcceptThreshold(strict);
    const action = actionAns.choice;
    const confidence = actionAns.confidence;
    const pFollowup = actionAns.probabilities.followup ?? 0;
    const pSideTalk = actionAns.probabilities.side_talk ?? 0;
    const pGoodbye = actionAns.probabilities.goodbye ?? 0;
    const pDirected = pFollowup + pGoodbye;
    const marginOverSideTalk = pFollowup - pSideTalk;

    // 3 分类概率校准（仅非 strict 模式生效）：
    // SystemOne 的 confidence 为概率分布集中度指标，在 3 分类（followup/side_talk/goodbye）下，
    // 当 P(followup) 已达阈值或 P(followup)+P(goodbye) 高度指向助手且 P(side_talk) 极低时，
    // 集中度 confidence 仍可能略低于阈值，此处基于完整概率分布避免误拦自然跟进表达。
    const probabilityCalibratedFollowup =
      !strict &&
      action === "followup" &&
      ((pFollowup >= acceptThreshold && pSideTalk <= 0.25 && marginOverSideTalk >= 0.25) ||
        (pFollowup >= Math.max(0.45, Number((acceptThreshold - 0.2).toFixed(2))) &&
          pDirected >= Math.max(0.75, Number((acceptThreshold + 0.1).toFixed(2))) &&
          pSideTalk <= 0.22 &&
          marginOverSideTalk >= 0.25));

    const accepted =
      action === "followup" && (confidence >= acceptThreshold || probabilityCalibratedFollowup);
    const shouldExitConversation =
      action === "goodbye" && confidence >= GOODBYE_CONFIDENCE_THRESHOLD;

    const result: ConversationTurnResult = {
      action,
      confidence,
      probabilities: actionAns.probabilities,
      accepted,
      shouldExitConversation,
      model: res.model,
      usage: res.usage,
      latencyMs,
      cached: false,
    };

    if (includeIntent && res.answers.intent) {
      const intentAns = res.answers.intent as SystemOneChoiceAnswer<CommandIntentChoice>;
      result.intent = {
        choice: intentAns.choice,
        confidence: intentAns.confidence,
        probabilities: intentAns.probabilities,
      };
    }

    if (hasDistinctAlt && res.answers.asr_best) {
      const asrAns = res.answers.asr_best as SystemOneChoiceAnswer<DualTrackAsrChoice>;
      result.asrBest = {
        choice: asrAns.choice,
        confidence: asrAns.confidence,
        probabilities: asrAns.probabilities,
        selectedText:
          asrAns.choice === "track_a"
            ? primaryText
            : asrAns.choice === "track_b"
              ? cleanAlt
              : "",
      };
    }

    // 仅缓存非执行判定，绝不缓存 followup，且待确认状态下不写入负向缓存
    if (!hasPendingConfirm && (action === "side_talk" || action === "goodbye")) {
      this._cache.set(cacheKey, result);
    }

    return result;
  }

  /**
   * (c) 命令核心意图分类（`device_control | status_query | scene | general_chat`）。
   */
  async classifyCommandIntent(input: CommandIntentInput): Promise<CommandIntentResult | null> {
    if (!this._enabled) return null;
    const cleanCommand = collapseWhitespace(input.command);
    if (!cleanCommand) return null;

    const state: Record<string, unknown> = {
      command: cleanCommand,
    };
    const history = formatCompactHistory(
      input.recentHistory,
      HISTORY_MAX_ENTRIES,
      HISTORY_MAX_CHARS,
    );
    if (history.length > 0) {
      state.history = history;
    }

    const t0 = performance.now();
    const res = await this.decide(state, {
      intent: COMMAND_INTENT_QUESTION,
    });
    if (!res) return null;

    const latencyMs = Math.max(0, Math.round(performance.now() - t0));
    const intentAns = res.answers.intent;
    return {
      intent: intentAns.choice,
      confidence: intentAns.confidence,
      probabilities: intentAns.probabilities,
      model: res.model,
      usage: res.usage,
      latencyMs,
    };
  }

  /**
   * (d) 双轨 ASR 候选文本择优（`track_a | track_b | neither_noise`）。
   */
  async selectDualTrackAsr(
    input: DualTrackSelectionInput,
  ): Promise<DualTrackSelectionResult | null> {
    if (!this._enabled) return null;
    const cleanA = collapseWhitespace(input.trackA);
    const cleanB = collapseWhitespace(input.trackB);
    if (!cleanA && !cleanB) return null;

    const wakeWords = input.wakeWords.map((w) => w.trim()).filter(Boolean);
    const snrRounded =
      typeof input.inputSnrDb === "number" && Number.isFinite(input.inputSnrDb)
        ? Number(input.inputSnrDb.toFixed(1))
        : undefined;

    const cacheKey = JSON.stringify([
      "asr",
      cleanA.toLowerCase(),
      cleanB.toLowerCase(),
      wakeWords.map((w) => w.toLowerCase()),
      input.acousticEvent ?? "",
      snrRounded ?? "",
    ]);

    const cached = this._cache.get(cacheKey) as DualTrackSelectionResult | undefined;
    if (cached) {
      this._cacheHits += 1;
      return { ...cached, latencyMs: 0, cached: true };
    }

    const state: Record<string, unknown> = {
      track_a: cleanA,
      track_b: cleanB,
      wake_words: wakeWords,
    };
    if (input.acousticEvent) state.acoustic_event = input.acousticEvent;
    if (snrRounded !== undefined) state.input_snr_db = snrRounded;

    const t0 = performance.now();
    const res = await this.decide(state, {
      asr_best: DUAL_TRACK_ASR_QUESTION,
    });
    if (!res) return null;

    const latencyMs = Math.max(0, Math.round(performance.now() - t0));
    const asrAns = res.answers.asr_best;
    const choice = asrAns.choice;
    const result: DualTrackSelectionResult = {
      choice,
      selectedText: choice === "track_a" ? cleanA : choice === "track_b" ? cleanB : "",
      confidence: asrAns.confidence,
      probabilities: asrAns.probabilities,
      model: res.model,
      usage: res.usage,
      latencyMs,
      cached: false,
    };

    if (choice === "neither_noise") {
      this._cache.set(cacheKey, result);
    }

    return result;
  }

  /**
   * (e) TTS 播报自回声 vs 用户新指令判别（`echo | user_command`）。
   */
  async classifyEchoOrCommand(input: EchoCheckInput): Promise<EchoCheckResult | null> {
    if (!this._enabled) return null;
    const cleanLastSpoken = collapseWhitespace(input.lastSpoken);
    const cleanHeard = collapseWhitespace(input.heard);
    if (!cleanLastSpoken || !cleanHeard) return null;

    const spokenCompact = truncateText(cleanLastSpoken, 120);
    const heardCompact = truncateText(cleanHeard, 120);
    const cacheKey = JSON.stringify(["echo", spokenCompact.toLowerCase(), heardCompact.toLowerCase()]);
    const cached = this._auxCache.get(cacheKey) as EchoCheckResult | undefined;
    if (cached) {
      this._cacheHits += 1;
      return { ...cached, latencyMs: 0, cached: true };
    }

    const state: Record<string, unknown> = {
      last_spoken: spokenCompact,
      heard: heardCompact,
    };

    const t0 = performance.now();
    const res = await this.decide(state, {
      echo_check: ECHO_CHECK_QUESTION,
    });
    if (!res) return null;

    const latencyMs = Math.max(0, Math.round(performance.now() - t0));
    const ans = res.answers.echo_check;
    const result: EchoCheckResult = {
      choice: ans.choice,
      isEcho: ans.choice === "echo" && ans.confidence >= this._confidenceThreshold,
      confidence: ans.confidence,
      probabilities: ans.probabilities,
      model: res.model,
      usage: res.usage,
      latencyMs,
      cached: false,
    };
    this._auxCache.set(cacheKey, result);
    return result;
  }

  /**
   * (f) 隐式家居动作快速分类（`light_brighter | ... | needs_llm_agent`）。
   */
  async classifyImplicitAction(input: ImplicitActionInput): Promise<ImplicitActionResult | null> {
    if (!this._enabled) return null;
    const cleanUtterance = collapseWhitespace(input.utterance);
    if (!cleanUtterance) return null;

    const history = formatCompactHistory(
      input.recentHistory,
      TASK_ACK_HISTORY_MAX_ENTRIES,
      TASK_ACK_HISTORY_MAX_CHARS,
    );
    const cacheKey = JSON.stringify(["implicit", cleanUtterance.toLowerCase(), history]);
    const cached = this._auxCache.get(cacheKey) as ImplicitActionResult | undefined;
    if (cached) {
      this._cacheHits += 1;
      return { ...cached, latencyMs: 0, cached: true };
    }

    const state: Record<string, unknown> = {
      utterance: cleanUtterance,
    };
    if (history.length > 0) {
      state.history = history;
    }

    const t0 = performance.now();
    const res = await this.decide(state, {
      implicit_action: IMPLICIT_ACTION_QUESTION,
    });
    if (!res) return null;

    const latencyMs = Math.max(0, Math.round(performance.now() - t0));
    const ans = res.answers.implicit_action;
    const result: ImplicitActionResult = {
      action: ans.choice,
      confidence: ans.confidence,
      probabilities: ans.probabilities,
      needsAgent: ans.choice === "needs_llm_agent" || ans.confidence < this._confidenceThreshold,
      model: res.model,
      usage: res.usage,
      latencyMs,
      cached: false,
    };
    this._auxCache.set(cacheKey, result);
    return result;
  }

  /**
   * (g) 场景化即时简短应答词快速判定（`execute_control | query_status | think_creative | ...`）。
   * 置信度达标的结果缓存 5 分钟（自包含语句跨轮次共享缓存），高频常用指令 0ms 零往返命中。
   */
  async classifyTaskAck(
    input: TaskAckInput,
    opts?: TaskAckOptions,
  ): Promise<TaskAckClassificationResult | null> {
    if (!this._enabled || opts?.signal?.aborted) return null;
    const cleanUtterance = collapseWhitespace(input.utterance);
    if (!cleanUtterance) return null;

    const history = formatCompactHistory(
      input.recentHistory,
      TASK_ACK_HISTORY_MAX_ENTRIES,
      TASK_ACK_HISTORY_MAX_CHARS,
    );
    const minConfidence =
      typeof opts?.minConfidence === "number" && Number.isFinite(opts.minConfidence)
        ? clamp01(opts.minConfidence)
        : TASK_ACK_MIN_CONFIDENCE;
    const normUtterance = cleanUtterance
      .toLowerCase()
      .replace(/[。！!？?，,\s]+$/g, "")
      .trim();
    const selfContained = isSelfContainedTaskAckUtterance(cleanUtterance);
    const cacheKey = JSON.stringify([
      "task_ack",
      normUtterance || cleanUtterance.toLowerCase(),
      input.source ?? "",
      selfContained ? [] : history.slice(-2),
    ]);

    const cached = this._taskAckCache.get(cacheKey);
    if (cached && cached.confidence >= minConfidence) {
      this._cacheHits += 1;
      return {
        ...cached,
        ackText: resolveTaskAckPhrase(cached.scenario, cleanUtterance),
        confident: true,
        latencyMs: 0,
        cached: true,
      };
    }

    const state: Record<string, unknown> = {
      utterance: truncateText(cleanUtterance, 160),
    };
    if (input.source) {
      state.source = input.source;
    }
    if (history.length > 0) {
      state.history = history;
    }

    const t0 = performance.now();
    const res = await this.decide(
      state,
      {
        task_ack: TASK_ACK_QUESTION,
      },
      {
        timeoutMs: opts?.timeoutMs,
        signal: opts?.signal,
        softTimeout: opts?.softTimeout,
      },
    );
    if (!res) return null;

    const latencyMs = Math.max(0, Math.round(performance.now() - t0));
    const ans = res.answers.task_ack;
    const scenario = ans.choice;
    const confident = ans.confidence >= minConfidence;
    const result: TaskAckClassificationResult = {
      scenario,
      ackText: resolveTaskAckPhrase(scenario, cleanUtterance),
      confident,
      confidence: ans.confidence,
      probabilities: ans.probabilities,
      model: res.model,
      usage: res.usage,
      latencyMs,
      cached: false,
    };
    if (confident) {
      this._taskAckCache.set(cacheKey, result);
    }
    return result;
  }
}
