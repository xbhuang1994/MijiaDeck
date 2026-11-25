// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * Qwen3-ASR-0.6B 实时流式转写与智能断句引擎：
 *
 * 1. LocalAgreement 稳定前缀算法：连续两次流式假设取公共稳定前缀，防止实时字幕频繁跳动闪烁；
 * 2. 双语智能断句（Sentence Segmentation）：
 *    - 强句末标点断句（。！？!? 及非小数点句号 .），并内置唤醒词防拆保护（绝不把“Neo。打开客厅灯”拆成两句）；
 *    - 标点+短停顿快速收句（句尾已稳定带句末标点且静音 >= 320ms 即刻断句，比常规 650ms VAD 快一倍）；
 *    - 连续长语音超长上限保护（优先在分号/逗号/空格子句边界干净切分）；
 * 3. 无缝去重与兼容：
 *    - 句中切分后自动剥离已提交前缀，防止重叠窗口重复吐字；
 *    - 完整兼容 Qwen3-ASR GPU（SSE 逐 token 流式）、Qwen3-ASR CPU 与备用 SenseVoice。
 */

import { findWakeWordSpan, isWakeQueryText } from "./voiceAttentionGate.ts";

export type StreamingCommitReason =
  | "punctuation_split"
  | "punctuation_pause"
  | "vad_silence"
  | "max_duration"
  | "manual_flush";

export interface StreamingPartialUpdate {
  /** 当前展示的完整实时文本（稳定部分 + 未稳定尾部） */
  text: string;
  /** 已通过 LocalAgreement 锁定的稳定前缀 */
  stableText: string;
  /** 当前尚未锁定的尾部预测 */
  unstableText: string;
  engine: string;
  latencyMs: number;
}

export interface StreamingSentenceSplitResult {
  /** 已完整闭合、可立即下发处理的完整句子列表 */
  completed: string[];
  /** 尚未闭合的残余文本，留待后续音频继续拼接 */
  remainder: string;
}

const STRONG_PUNCT_SET = new Set(["。", "！", "？", "!", "?", "\n"]);
const CLAUSE_PUNCT_SET = new Set(["；", ";", "，", ",", "、", "：", ":"]);
const EDGE_PUNCT_RE = /^[\s,，。．.、!！?？:：;；\-—~～"'“”‘’]+|[\s,，。．.、!！?？:：;；\-—~～"'“”‘’]+$/g;
const TRAILING_SOFT_PUNCT_RE = /[\s,，。．.、!！?？:：;；…\-—~～]+$/;
const LEADING_VOCATIVE_RE = /^(?:嘿|嗨|喂|哎|你好|您好|hey|hi|ok|hello)[\s,，、!！。:：]*/i;
const MEANINGFUL_CHAR_RE = /[\u4e00-\u9fffA-Za-z0-9]/g;

export function countMeaningfulChars(text: string): number {
  return (text.match(MEANINGFUL_CHAR_RE) ?? []).length;
}

export function endsWithStrongSentencePunct(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const last = trimmed[trimmed.length - 1]!;
  if (STRONG_PUNCT_SET.has(last)) return true;
  if (last === ".") {
    // 排除省略号 "..." 或数字末尾小数点（如 "25."）
    const prev = trimmed.length >= 2 ? trimmed[trimmed.length - 2]! : "";
    return prev !== "." && !/\d/.test(prev);
  }
  return false;
}

/**
 * 判断一段带标点候选句是否仅仅是“独立唤醒词前缀”（如 "Neo。" / "嘿Neo！" / "小派？"）。
 * 流式断句中绝不可在此处提前断开，必须等待后面的设备指令拼接为完整一句。
 */
export function isStandaloneWakePrefix(
  candidate: string,
  wakeWords: readonly string[] = [],
): boolean {
  const trimmed = candidate.trim();
  if (!trimmed || wakeWords.length === 0) return false;
  const stripped = trimmed.replace(EDGE_PUNCT_RE, "").trim();
  if (!stripped) return false;

  const span = findWakeWordSpan(stripped, wakeWords);
  if (!span) return false;

  const beforeClean = span.beforeText.replace(LEADING_VOCATIVE_RE, "").replace(EDGE_PUNCT_RE, "").trim();
  const afterClean = span.afterText.replace(EDGE_PUNCT_RE, "").trim();
  if (beforeClean.length > 0) return false;
  // 纯唤醒词（无后续内容）时不能在中途提前切句
  return afterClean.length === 0;
}

/**
 * 计算两次相邻流式假设的 LocalAgreement 公共稳定前缀：
 * 忽略前一次假设最末尾可能随后续音节变化的标点（如“打开客厅灯。” -> “打开客厅灯，调到暖光”），
 * 并尽量在完整中文字符或英文词边界处对齐，避免半个英文单词抖动。
 */
export function longestCommonStablePrefix(prev: string, curr: string): string {
  const a = prev.trim().replace(TRAILING_SOFT_PUNCT_RE, "");
  const b = curr.trim();
  if (!a || !b) return "";

  const maxLen = Math.min(a.length, b.length);
  let i = 0;
  while (i < maxLen && a[i] === b[i]) {
    i += 1;
  }
  if (i === 0) return "";

  let prefix = b.slice(0, i);
  // 若切在英文单词中间（前后均为 ASCII 字母数字），回退到单词边界
  if (
    i < b.length &&
    /[A-Za-z0-9]/.test(b[i - 1]!) &&
    /[A-Za-z0-9]/.test(b[i]!)
  ) {
    const cut = prefix.replace(/[A-Za-z0-9]+$/, "");
    prefix = cut;
  }
  return prefix.trim();
}

/**
 * 当流式长语音在中途已切出并提交前半句后，从后续重叠窗口的新识别文本中剥离已提交前缀，
 * 防止同一句话被重复识别两次。
 */
export function stripCommittedPrefix(rawText: string, committedText: string): string {
  const text = rawText.trim();
  const committed = committedText.trim();
  if (!text || !committed) return text;

  if (text.startsWith(committed)) {
    return text.slice(committed.length).replace(/^[\s,，。．.、!！?？:：;；]+/, "").trim();
  }

  // 标点/大小写不敏感前缀对齐（容忍标点轻微变动，如“打开客厅吸顶灯。” vs “打开客厅吸顶灯，”）
  const normCommitted = committed
    .toLowerCase()
    .replace(/[\s,，。．.、!！?？:：;；"'“”‘’]+/g, "");
  if (!normCommitted) return text;

  let matchedNormIdx = 0;
  let cutPos = 0;
  for (let i = 0; i < text.length && matchedNormIdx < normCommitted.length; i += 1) {
    const ch = text[i]!;
    if (/[\s,，。．.、!！?？:：;；"'“”‘’]/.test(ch)) {
      cutPos = i + 1;
      continue;
    }
    if (ch.toLowerCase() === normCommitted[matchedNormIdx]) {
      matchedNormIdx += 1;
      cutPos = i + 1;
    } else {
      break;
    }
  }

  // 要求几乎完整命中已提交前缀（>= 85%）才执行剥离，避免误删新句子
  if (matchedNormIdx >= Math.max(2, Math.ceil(normCommitted.length * 0.85))) {
    return text.slice(cutPos).replace(/^[\s,，。．.、!！?？:：;；]+/, "").trim();
  }
  return text;
}

/**
 * 在超长无句号连说时按最近的子句标点（；;，,、）或词边界做平滑断句。
 */
export function splitAtClauseBoundary(
  text: string,
  maxChars = 48,
): StreamingSentenceSplitResult {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length <= maxChars) {
    return { completed: [], remainder: trimmed };
  }

  let cutIdx = -1;
  const searchEnd = Math.min(trimmed.length - 1, maxChars);
  for (let i = searchEnd; i >= Math.floor(maxChars * 0.45); i -= 1) {
    const ch = trimmed[i]!;
    if (STRONG_PUNCT_SET.has(ch) || CLAUSE_PUNCT_SET.has(ch)) {
      cutIdx = i + 1;
      break;
    }
  }
  if (cutIdx < 0) {
    for (let i = searchEnd; i >= Math.floor(maxChars * 0.6); i -= 1) {
      if (trimmed[i] === " ") {
        cutIdx = i + 1;
        break;
      }
    }
  }
  if (cutIdx < 0) {
    cutIdx = searchEnd;
  }

  const head = trimmed.slice(0, cutIdx).trim();
  const tail = trimmed.slice(cutIdx).trim();
  if (!head) {
    return { completed: [], remainder: trimmed };
  }
  return { completed: [head], remainder: tail };
}

/**
 * 双语流式智能断句器：
 * - 按强句末标点（。！？!? 以及英文句末 .）切分多句连说，保留数字小数点（如 25.5度）不断开；
 * - 保护句首唤醒词（如“Neo。打开客厅吸顶灯”绝不拆成两句）；
 * - `forceFlush=false`（说话中）：仅提交后面已紧跟新内容的已闭合完整句，末尾句留在 `remainder` 等待停顿确认；
 * - `forceFlush=true`（静音停顿/手动结束）：同时提交末尾已闭合或非空完整句。
 */
export function splitStreamingSentences(
  rawText: string,
  options: {
    wakeWords?: readonly string[];
    forceFlush?: boolean;
    maxCharsWithoutPunct?: number;
  } = {},
): StreamingSentenceSplitResult {
  const text = rawText.trim();
  if (!text) {
    return { completed: [], remainder: "" };
  }

  const wakeWords = options.wakeWords ?? [];
  const forceFlush = options.forceFlush === true;
  const maxChars = options.maxCharsWithoutPunct ?? 64;

  // 1. 找出所有合法强句末标点位置
  const segments: Array<{ text: string; terminated: boolean }> = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    let isTerminator = STRONG_PUNCT_SET.has(ch);
    if (!isTerminator && ch === ".") {
      const prev = i > 0 ? text[i - 1]! : "";
      const next = i + 1 < text.length ? text[i + 1]! : "";
      const isDecimal = /\d/.test(prev) && /\d/.test(next);
      const isEllipsis = prev === "." || next === ".";
      const isAcronym = /[A-Za-z]/.test(prev) && /[A-Za-z]/.test(next);
      const validAfter = next === "" || /[\s\u4e00-\u9fff"'”’）)]/.test(next);
      isTerminator = !isDecimal && !isEllipsis && !isAcronym && validAfter;
    }

    if (isTerminator) {
      // 吸收连续标点（如 "？！" / "!!"）
      let end = i + 1;
      while (end < text.length && STRONG_PUNCT_SET.has(text[end]!)) {
        end += 1;
      }
      const chunk = text.slice(start, end).trim();
      if (chunk) {
        segments.push({ text: chunk, terminated: true });
      }
      start = end;
      i = end - 1;
    }
  }
  const tail = text.slice(start).trim();
  if (tail) {
    segments.push({ text: tail, terminated: false });
  }

  if (segments.length === 0) {
    return { completed: [], remainder: "" };
  }

  // 2. 合并“独立唤醒词前缀”与其后紧跟的指令句（例如 ["Neo。", "打开客厅吸顶灯"] -> ["Neo。打开客厅吸顶灯"]）
  const merged: Array<{ text: string; terminated: boolean }> = [];
  for (let idx = 0; idx < segments.length; idx += 1) {
    const cur = segments[idx]!;
    if (
      cur.terminated &&
      idx + 1 < segments.length &&
      isStandaloneWakePrefix(cur.text, wakeWords)
    ) {
      const next = segments[idx + 1]!;
      const glue = /[A-Za-z0-9]$/.test(cur.text) && /^[A-Za-z0-9]/.test(next.text) ? " " : "";
      segments[idx + 1] = {
        text: `${cur.text}${glue}${next.text}`,
        terminated: next.terminated,
      };
      continue;
    }
    merged.push(cur);
  }

  // 3. 根据 forceFlush 决定哪些句子已闭合可提交
  const completed: string[] = [];
  let remainder = "";

  for (let i = 0; i < merged.length; i += 1) {
    const seg = merged[i]!;
    const isLast = i === merged.length - 1;

    if (!isLast) {
      if (countMeaningfulChars(seg.text) >= 2 || isWakeQueryText(seg.text)) {
        completed.push(seg.text);
      } else {
        // 极短碎片（如单字“啊。”）并入下一句防止碎句误触
        merged[i + 1] = {
          text: `${seg.text}${merged[i + 1]!.text}`,
          terminated: merged[i + 1]!.terminated,
        };
      }
      continue;
    }

    // 最后一段
    if (forceFlush) {
      if (countMeaningfulChars(seg.text) >= 1) {
        completed.push(seg.text);
      }
    } else if (seg.text.length > maxChars && !seg.terminated) {
      const clauseSplit = splitAtClauseBoundary(seg.text, maxChars);
      for (const c of clauseSplit.completed) {
        if (!isStandaloneWakePrefix(c, wakeWords) && countMeaningfulChars(c) >= 2) {
          completed.push(c);
        } else {
          remainder = `${c}${clauseSplit.remainder}`;
        }
      }
      if (!remainder) {
        remainder = clauseSplit.remainder;
      }
    } else {
      remainder = seg.text;
    }
  }

  return { completed, remainder };
}

export interface Qwen3StreamingHypothesisTrackerOptions {
  wakeWords?: readonly string[];
  /** 末尾带强句末标点后等待多少毫秒静音即触发快速断句（默认 320ms） */
  punctuationPauseMs?: number;
  /** 无标点连续讲话最长多少字符触发子句断句（默认 64） */
  maxCharsWithoutPunct?: number;
}

/**
 * 有状态的流式转写假设与断句状态机：
 * 追踪当前话语的 LocalAgreement 稳定前缀、已提交句子前缀与静音停顿计时，
 * 输出实时字幕更新事件与已闭合句子列表。
 */
export class Qwen3StreamingHypothesisTracker {
  private _wakeWords: string[];
  private readonly _punctuationPauseMs: number;
  private readonly _maxCharsWithoutPunct: number;

  private _prevHypothesis = "";
  private _stableText = "";
  private _latestText = "";
  private _committedPrefix = "";
  private _trailingSilenceMs = 0;

  constructor(options: Qwen3StreamingHypothesisTrackerOptions = {}) {
    this._wakeWords = [...(options.wakeWords ?? [])];
    this._punctuationPauseMs = options.punctuationPauseMs ?? 320;
    this._maxCharsWithoutPunct = options.maxCharsWithoutPunct ?? 64;
  }

  get latestText(): string {
    return this._latestText;
  }

  get stableText(): string {
    return this._stableText;
  }

  get committedPrefix(): string {
    return this._committedPrefix;
  }

  setWakeWords(wakeWords: readonly string[]): void {
    this._wakeWords = [...wakeWords];
  }

  /**
   * 喂入一次新的流式 ASR 假设，返回实时字幕状态以及（若中途检测到多句标点边界）立刻可提交的完整句子。
   */
  ingestHypothesis(
    rawHypothesis: string,
    meta: { engine: string; latencyMs: number },
  ): {
    partial: StreamingPartialUpdate | null;
    completedSentences: string[];
    commitReason: StreamingCommitReason | null;
  } {
    const cleaned = stripCommittedPrefix(rawHypothesis.trim(), this._committedPrefix);
    if (!cleaned) {
      return { partial: null, completedSentences: [], commitReason: null };
    }

    // 1. LocalAgreement 稳定前缀单调推进
    const agreed = longestCommonStablePrefix(this._prevHypothesis, cleaned);
    if (agreed.length > this._stableText.length) {
      this._stableText = agreed;
    } else if (!cleaned.startsWith(this._stableText)) {
      // 模型纠错改写了前缀（例如“你哦” -> “Neo”），同步到最新公共前缀避免残留错字
      this._stableText = agreed;
    }
    this._prevHypothesis = cleaned;
    this._latestText = cleaned;

    // 2. 检测流式句中多句标点断句（例如 “打开客厅吸顶灯。把空调调到”）
    const split = splitStreamingSentences(cleaned, {
      wakeWords: this._wakeWords,
      forceFlush: false,
      maxCharsWithoutPunct: this._maxCharsWithoutPunct,
    });

    if (split.completed.length > 0) {
      const committedBatch = split.completed.join("");
      this._committedPrefix = `${this._committedPrefix}${committedBatch}`.trim();
      this._prevHypothesis = split.remainder;
      this._stableText = split.remainder;
      this._latestText = split.remainder;
      this._trailingSilenceMs = 0;

      const partial: StreamingPartialUpdate | null = split.remainder
        ? {
            text: split.remainder,
            stableText: split.remainder,
            unstableText: "",
            engine: meta.engine,
            latencyMs: meta.latencyMs,
          }
        : null;
      return {
        partial,
        completedSentences: split.completed,
        commitReason: "punctuation_split",
      };
    }

    const unstableText = cleaned.startsWith(this._stableText)
      ? cleaned.slice(this._stableText.length)
      : cleaned;

    return {
      partial: {
        text: cleaned,
        stableText: this._stableText,
        unstableText,
        engine: meta.engine,
        latencyMs: meta.latencyMs,
      },
      completedSentences: [],
      commitReason: null,
    };
  }

  /**
   * 推进帧级语音/静音状态：当最新识别文本已带有完整句末标点（且非独立唤醒词前缀）且停顿达到 punctuationPauseMs，
   * 立即建议收句，大幅缩短句尾等待延迟！
   */
  advanceFrame(
    frameDurationMs: number,
    isSpeech: boolean,
  ): { shouldCommitByPunctPause: boolean } {
    if (isSpeech) {
      this._trailingSilenceMs = 0;
      return { shouldCommitByPunctPause: false };
    }
    if (!this._latestText) {
      this._trailingSilenceMs = 0;
      return { shouldCommitByPunctPause: false };
    }
    this._trailingSilenceMs += frameDurationMs;

    if (
      this._trailingSilenceMs >= this._punctuationPauseMs &&
      endsWithStrongSentencePunct(this._latestText) &&
      !isStandaloneWakePrefix(this._latestText, this._wakeWords) &&
      countMeaningfulChars(this._latestText) >= 2
    ) {
      return { shouldCommitByPunctPause: true };
    }
    return { shouldCommitByPunctPause: false };
  }

  /**
   * 静音判停、超长上限或手动 flush 时，取出当前未闭合文本并按标点干净切分输出，随后重置状态。
   */
  flush(finalHypothesis?: string): string[] {
    const source =
      finalHypothesis !== undefined
        ? stripCommittedPrefix(finalHypothesis.trim(), this._committedPrefix)
        : this._latestText;
    const split = splitStreamingSentences(source, {
      wakeWords: this._wakeWords,
      forceFlush: true,
      maxCharsWithoutPunct: this._maxCharsWithoutPunct,
    });
    this.reset();
    return split.completed;
  }

  reset(): void {
    this._prevHypothesis = "";
    this._stableText = "";
    this._latestText = "";
    this._committedPrefix = "";
    this._trailingSilenceMs = 0;
  }
}
