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
}

// ==================== Domain Types ====================

export interface SystemOneHistoryEntry {
  role: "user" | "assistant";
  text: string;
}

export type WakeAttentionDecision = "valid_wake" | "false_wake";
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

export interface WakeAttentionInput {
  utterance: string;
  wakeWords: readonly string[];
}

export interface WakeAttentionOptions {
  strict?: boolean;
}

export interface WakeAttentionResult {
  decision: WakeAttentionDecision;
  confidence: number;
  probabilities: Record<WakeAttentionDecision, number>;
  /** 非误听（确认有人在叫触发词且置信度达标），可直接进入下一流程 */
  accepted: boolean;
  /** 判定为误听/误唤醒（或置信度不足未放行） */
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
  totalCalls: number;
  cacheHits: number;
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

const UNSUPPORTED_COOLDOWN_MS = 10 * 60 * 1000; // 10 min
const AUTH_COOLDOWN_MS = 5 * 60 * 1000; // 5 min
const TRANSIENT_FAILURE_THRESHOLD = 2;
const TRANSIENT_BACKOFF_SCHEDULE_MS = [30_000, 60_000, 120_000, 300_000] as const;

const HISTORY_MAX_ENTRIES = 5;
const HISTORY_MAX_CHARS = 80;

// ==================== Calibrated Bilingual-Safe Question Schemas ====================

const WAKE_DECISION_QUESTION: SystemOneChoiceQuestion<WakeAttentionDecision> = {
  type: "choice",
  instructions:
    "仅判断当前语音转写文本 utterance 是否真的有人在呼唤触发词（wake_words，支持中英文及语音识别常见同音/音译误差），还是误听/误唤醒。不要评估后续内容是什么意图、是否属于智能家居控制，也不要做上下文或背景环境推断，只判断是不是误听有人在叫触发词。",
  criteria: {
    valid_wake:
      "确实有人在直接呼唤触发词（包括纯呼唤触发词、触发词后接任意说话内容，或因语音识别误差把触发词转写为近音/同音/音译词但明显是在叫触发词）。",
    false_wake:
      "误听或误唤醒：并没有人在叫触发词，包括把发音相近的普通日常词句/外语词/杂音碎片误听成触发词，或在与他人聊天、转述、评价、否定中顺带提及该词而并非在呼叫触发词。",
  },
};

const CONVERSATION_ACTION_QUESTION: SystemOneChoiceQuestion<ConversationActionChoice> = {
  type: "choice",
  instructions:
    "你是运行在电脑上的多平台智能家居控制助手，可控制家中各类智能设备（见 home_capabilities，含多筒洗衣机袜子筒/内裤筒、干衣机、扫地机、喂食器、智能灌溉等）与回答问题。当前处于连续对话模式（用户可省略唤醒词，若 acoustic_wake 非空表示刚刚检测到唤醒词，若 pending_confirmation 非空表示正在等用户确认）。请结合 home_capabilities、learned_triggers、pending_confirmation、acoustic_wake 与 history 判断最新 utterance 的性质。",
  criteria: {
    followup:
      "用户在继续与智能家居助手对话：下达显式或隐式设备控制/调节指令（凡命中 home_capabilities 或 learned_triggers 的请求如“帮我洗一下袜子”“洗内裤”“浇花”“扫地”“喂猫”均属此类）、回复 pending_confirmation 的肯定/否定/改选/消歧答复（如“嗯”“好”“对”“用下筒”“方寸别院那台”“不用了”）、保存或管理长期偏好规则、补充参数、纠正撤销、查询设备状态、环境抱怨反馈，或面向助手的自然追问。",
    side_talk:
      "用户在与旁边家人/朋友说话、自言自语、聊日常琐事或要求真人完成家中无任何联网设备支持的跑腿家务（如晚饭吃什么、帮我倒水、拿双筷子、洗碗做饭、去取快递），或纯背景歌词/环境噪声，未面向智能家居助手说话。",
    goodbye:
      "用户明确示意结束本次对话、道谢收尾或让助手退下/停止聆听（如“谢谢不用了”、“没事了”、“好了退下吧”、“再见”、“that's all thanks”、“goodbye”）。注意：当 pending_confirmation 存在时，用户回复“算了/取消/不用了”优先视作对确认请求的拒绝 followup 而非直接退出。",
  },
};

const COMMAND_INTENT_QUESTION: SystemOneChoiceQuestion<CommandIntentChoice> = {
  type: "choice",
  instructions: "判断用户对智能家居助手发出的指令或请求所属核心意图类别（支持中英文）。",
  criteria: {
    device_control:
      "直接控制或调节单个/多个智能家居设备（开关、亮度、色温、颜色、音量、空调温度、窗帘、喂食、播放/暂停，或隐式调节抱怨如太暗/太亮/太吵/太热）。",
    status_query:
      "查询设备当前状态、开关情况或室内外环境传感数据（温度、湿度、PM2.5、电量、某设备是否开启等）。",
    scene:
      "触发或切换智能联动场景、全屋模式或批量模式（如回家模式、离家模式、观影模式、睡眠模式、全屋关灯）。",
    general_chat:
      "非设备控制类普通闲聊、知识问答、打招呼、纯唤醒确认或无关内容。",
  },
};

const DUAL_TRACK_ASR_QUESTION: SystemOneChoiceQuestion<DualTrackAsrChoice> = {
  type: "choice",
  instructions:
    "对比双轨语音识别文本 track_a 与 track_b，结合 wake_words 与声学环境信息，选出最准确反映人类对智能家居助手说出的真实话语（支持中英文），避免误选歌词或噪声幻觉。",
  criteria: {
    track_a:
      "track_a 更通顺完整，更准确地保留了唤醒词、设备名称或有效智能家居指令。",
    track_b:
      "track_b 更通顺完整，相比 track_a 更有效去除背景噪声/歌词并准确保留了真实用户指令。",
    neither_noise:
      "track_a 与 track_b 都明显是背景音乐歌词、环境杂音、无意义识别碎片或非面向助手的杂音。",
  },
};

const ECHO_CHECK_QUESTION: SystemOneChoiceQuestion<EchoCheckChoice> = {
  type: "choice",
  instructions:
    "判断麦克风听到的 heard 是系统刚刚朗读的 last_spoken 的扬声器回声（含局部截断、吞字或谐音误差），还是用户新发出的控制指令或追问（支持中英文）。注意：若刚播报“已关闭客厅灯”，用户紧接着说“打开客厅灯”属于反向新指令 user_command，不是回声。",
  criteria: {
    echo: "heard 是 last_spoken 的重复、子串、截断残片或识别谐音误差，没有表达新的用户意图。",
    user_command:
      "heard 是用户新说出的指令、反向控制、参数调节、追问或新对话，即使包含相同设备名称也属此类。",
  },
};

const IMPLICIT_ACTION_QUESTION: SystemOneChoiceQuestion<ImplicitActionChoice> = {
  type: "choice",
  instructions:
    "根据用户的隐式表达或自然语言反馈（结合 history），判断其最直接对应的单一智能家居快捷动作，或是否应交由完整 LLM Agent 规划处理（支持中英文）。",
  criteria: {
    light_brighter:
      "嫌太暗、看不清或希望把灯调亮/提高亮度（如“有点暗”、“亮一点”、“too dark”）。",
    light_dimmer:
      "嫌太亮、刺眼或希望把灯调暗/降低亮度（如“太刺眼了”、“暗一点”、“too bright”）。",
    speaker_quieter:
      "嫌声音太大、太吵或希望调小音量/小声一点（如“太吵了”、“小声点”、“too loud”）。",
    speaker_louder:
      "嫌声音太小、听不清或希望调大音量/大声一点（如“听不清”、“大声点”、“turn it up”）。",
    power_off:
      "明确想关闭当前讨论或刚操作设备的电源（如“关了吧”、“太费电关掉”、“turn it off”）。",
    power_on:
      "明确想开启当前讨论或刚操作设备的电源（如“开一下”、“打开吧”、“turn it on”）。",
    query_status:
      "仅查询当前设备状态、温度、湿度等读数，不需要修改设备状态。",
    needs_llm_agent:
      "多步复合指令、具体数值/色温/定时、多设备编排、场景切换、喂食、普通问答或意图不明确，需交由 LLM Agent 处理。",
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

  // Circuit breaker state
  private _circuitState: SystemOneCircuitState = "closed";
  private _openReason: SystemOneOpenReason | null = null;
  private _openedUntilMs = 0;
  private _consecutiveFailures = 0;
  private _transientBackoffLevel = 0;
  private _halfOpenProbeInFlight = false;
  private _lastFailureKind: SystemOneFailureKind = "none";
  private _lastError: string | null = null;

  // Telemetry
  private _lastLatencyMs: number | null = null;
  private _totalCalls = 0;
  private _cacheHits = 0;

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

  /**
   * 预热到 SystemOne 网关的 TCP/TLS 连接（若运行时支持 `fetch.preconnect`）。
   */
  preconnect(): void {
    if (!this._enabled || !this._endpointOrigin) return;
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
   * 重置熔断器状态并清空负向结果 LRU 缓存。
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
    this._cache.clear();
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
      totalCalls: this._totalCalls,
      cacheHits: this._cacheHits,
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

  /**
   * 通用 SystemOne 决策调用。
   * 支持任意 `choice` / `score` / `noul` 问题组合的单次批量调用。
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

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (this._apiKey) {
      headers["Authorization"] = `Bearer ${this._apiKey}`;
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

    this._totalCalls += 1;
    const t0 = performance.now();

    try {
      const res = await this._fetch(this._endpoint, {
        method: "POST",
        headers,
        body,
        timeoutMs: effectiveTimeoutMs,
        ...(options?.signal ? { signal: options.signal } : {}),
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
          this._recordFailure("timeout", detail, isHalfOpenProbe);
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
      if (options?.signal?.aborted) {
        if (isHalfOpenProbe) {
          this._halfOpenProbeInFlight = false;
        }
        return null;
      }
      const msg = err instanceof Error ? err.message : String(err);
      const kind: Exclude<SystemOneFailureKind, "none"> = isTimeoutError(err)
        ? "timeout"
        : "network";
      this._recordFailure(kind, msg, isHalfOpenProbe);
      return null;
    }
  }

  /**
   * (a) 唤醒词触发后纯误唤醒校验（单问题二分类：`valid_wake | false_wake`）。
   * 仅判断是不是误听有人在叫触发词，不附带上下文/背景/设备能力/意图/双轨等其它判断；
   * 仅缓存负向误听判定（`false_wake`），绝不缓存正向放行判定（`valid_wake`）。
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

    const cacheKey = JSON.stringify([
      "wake",
      cleanUtterance.toLowerCase(),
      wakeWords.map((w) => w.toLowerCase()),
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

    const questions = {
      decision: WAKE_DECISION_QUESTION,
    };

    const t0 = performance.now();
    const res = await this.decide(state, questions);
    if (!res) return null;

    const latencyMs = Math.max(0, Math.round(performance.now() - t0));
    const decisionAns = res.answers.decision;
    const acceptThreshold = this._effectiveAcceptThreshold(strict);
    const decision = decisionAns.choice;
    const confidence = decisionAns.confidence;
    const accepted = decision === "valid_wake" && confidence >= acceptThreshold;
    const isFalseWake = !accepted;

    const result: WakeAttentionResult = {
      decision,
      confidence,
      probabilities: decisionAns.probabilities,
      accepted,
      isFalseWake,
      model: res.model,
      usage: res.usage,
      latencyMs,
      cached: false,
    };

    // 仅缓存误唤醒负向判定，绝不缓存正向放行判定
    if (decision === "false_wake") {
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
    if (wakeWords.length > 0) {
      state.wake_words = wakeWords;
    }
    if (lastSpoken) {
      state.last_spoken_reply = lastSpoken;
    }
    if (input.acousticEvent) state.acoustic_event = input.acousticEvent;
    if (input.speakerName) state.speaker = input.speakerName;
    if (input.acousticWake) {
      state.acoustic_wake = {
        wake_word: input.acousticWake.wakeWord,
        score: Number(input.acousticWake.score.toFixed(3)),
      };
    }
    if (input.homeCapabilities && input.homeCapabilities.length > 0) {
      state.home_capabilities = input.homeCapabilities.slice(0, 12);
    }
    if (input.learnedTriggers && input.learnedTriggers.length > 0) {
      state.learned_triggers = input.learnedTriggers.slice(0, 12);
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
    const accepted = action === "followup" && confidence >= acceptThreshold;
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

    const state: Record<string, unknown> = {
      last_spoken: truncateText(cleanLastSpoken, 160),
      heard: truncateText(cleanHeard, 160),
    };

    const t0 = performance.now();
    const res = await this.decide(state, {
      echo_check: ECHO_CHECK_QUESTION,
    });
    if (!res) return null;

    const latencyMs = Math.max(0, Math.round(performance.now() - t0));
    const ans = res.answers.echo_check;
    return {
      choice: ans.choice,
      isEcho: ans.choice === "echo" && ans.confidence >= this._confidenceThreshold,
      confidence: ans.confidence,
      probabilities: ans.probabilities,
      model: res.model,
      usage: res.usage,
      latencyMs,
    };
  }

  /**
   * (f) 隐式家居动作快速分类（`light_brighter | ... | needs_llm_agent`）。
   */
  async classifyImplicitAction(input: ImplicitActionInput): Promise<ImplicitActionResult | null> {
    if (!this._enabled) return null;
    const cleanUtterance = collapseWhitespace(input.utterance);
    if (!cleanUtterance) return null;

    const state: Record<string, unknown> = {
      utterance: cleanUtterance,
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
      implicit_action: IMPLICIT_ACTION_QUESTION,
    });
    if (!res) return null;

    const latencyMs = Math.max(0, Math.round(performance.now() - t0));
    const ans = res.answers.implicit_action;
    return {
      action: ans.choice,
      confidence: ans.confidence,
      probabilities: ans.probabilities,
      needsAgent: ans.choice === "needs_llm_agent" || ans.confidence < this._confidenceThreshold,
      model: res.model,
      usage: res.usage,
      latencyMs,
    };
  }

  /**
   * (g) 场景化即时简短应答词快速判定（`execute_control | query_status | think_creative | ...`）。
   */
  async classifyTaskAck(
    input: TaskAckInput,
    opts?: TaskAckOptions,
  ): Promise<TaskAckClassificationResult | null> {
    if (!this._enabled || opts?.signal?.aborted) return null;
    const cleanUtterance = collapseWhitespace(input.utterance);
    if (!cleanUtterance) return null;

    const state: Record<string, unknown> = {
      utterance: truncateText(cleanUtterance, 200),
    };
    if (input.source) {
      state.source = input.source;
    }
    const history = formatCompactHistory(
      input.recentHistory,
      HISTORY_MAX_ENTRIES,
      HISTORY_MAX_CHARS,
    );
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
      },
    );
    if (!res) return null;

    const latencyMs = Math.max(0, Math.round(performance.now() - t0));
    const ans = res.answers.task_ack;
    const minConfidence =
      typeof opts?.minConfidence === "number" && Number.isFinite(opts.minConfidence)
        ? clamp01(opts.minConfidence)
        : TASK_ACK_MIN_CONFIDENCE;
    const scenario = ans.choice;
    return {
      scenario,
      ackText: resolveTaskAckPhrase(scenario, cleanUtterance),
      confident: ans.confidence >= minConfidence,
      confidence: ans.confidence,
      probabilities: ans.probabilities,
      model: res.model,
      usage: res.usage,
      latencyMs,
    };
  }
}
