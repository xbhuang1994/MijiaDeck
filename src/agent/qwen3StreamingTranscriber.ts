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

export interface StreamingPartialTrack {
  trackId: string;
  trackIndex: number;
  text: string;
  energyRatio?: number;
}

export interface StreamingPartialUpdate {
  /** 当前展示的完整实时文本（稳定部分 + 未稳定尾部） */
  text: string;
  /** 已通过 LocalAgreement 锁定的稳定前缀 */
  stableText: string;
  /** 当前尚未锁定的尾部预测 */
  unstableText: string;
  engine: string;
  latencyMs: number;
  /** ClearVoice 多轨盲源分离场景下的各轨独立实时字幕（绝不混杂成一条音轨） */
  tracks?: StreamingPartialTrack[];
}

export interface StreamingSentenceSplitResult {
  /** 已完整闭合、可立即下发处理的完整句子列表 */
  completed: string[];
  /** 尚未闭合的残余文本，留待后续音频继续拼接 */
  remainder: string;
}

const STRONG_PUNCT_SET = new Set(["。", "！", "？", "!", "?", "\n"]);
const CLAUSE_PUNCT_SET = new Set(["；", ";", "，", ",", "、", "：", ":"]);
const CONTINUATION_TRAILING_PUNCT_RE = /[,，、;；:：…—\-~～]\s*$/;
const EDGE_PUNCT_RE = /^[\s,，。．.、!！?？:：;；\-—~～"'“”‘’]+|[\s,，。．.、!！?？:：;；\-—~～"'“”‘’]+$/g;
const TRAILING_SOFT_PUNCT_RE = /[\s,，。．.、!！?？:：;；…\-—~～]+$/;
const LEADING_VOCATIVE_RE = /^(?:嘿|嗨|喂|哎|你好|您好|hey|hi|ok|hello)[\s,，、!！。:：]*/i;
const MEANINGFUL_CHAR_RE = /[\u4e00-\u9fffA-Za-z0-9]/g;

// 中文/英文句中停顿或未说完信号（即使 ASR 乐观地在尾部补了句号“。”，仍极可能是慢语速思考停顿）
const ZH_INCOMPLETE_ENDING_RE =
  /(?:然后再|顺便再|顺便把|顺便帮我|帮我再|给我再|再把|然后|顺便|还有|并且|而且|以及|另外|此外|不过|但是|可是|然而|如果|要是|假如|因为|所以|因此|或者|还是|接着|紧接着|随后|同时|比如|比如说|例如|就是说|也就是说|换句话说|就是|对了|首先|其次|第一|第二|第三|帮我把|给我把|请把|麻烦把|能不能把|帮我|给我|请你|麻烦你|麻烦|我想|我要|我想要|我打算|我准备|我需要|能不能|可不可以|可以帮我|帮我看一下|想问一下|把|将|被|给|向|对|对于|关于|从|往|朝|在|到|的|得|地|和|跟|与|同|嗯+|呃+|额+|啊+|那个|这个|怎么说呢|我想想|让我想想)$/;
const EN_INCOMPLETE_ENDING_RE =
  /\b(?:and|or|but|then|also|because|so|if|when|while|that|which|with|without|to|for|from|into|about|the|a|an|my|our|your|please|um|uh|well)\s*$/i;
// 句尾出现“把/将 + 对象”却尚未说出动作谓语（如“帮我把客厅吸顶灯” / “把卧室空调”）
// 先屏蔽“空调/开关/洗衣机/扫地机”等内置动字的复合设备名词，防止“空调”里的“调”被误判为谓语
const ZH_BA_OBJECT_TAIL_RE = /(?:把|将)([^，。！？；,.!?;]{1,18})$/;
const ZH_BA_DEVICE_NOUN_MASK_RE =
  /(?:空气净化器|扫地机器人|洗烘一体机|智洗烘|抽油烟机|智能门锁|监控摄像头|空调|开关|洗衣机|洗碗机|烘干机|扫地机|拖地机|除湿机|加湿器|净化器|吹风机|电风扇|落地扇|循环扇|喂食器|吸顶灯|台灯|落地灯|射灯|灯带|门锁|窗帘)/g;
const ZH_BA_PREDICATE_RE =
  /(?:开|关|调|设|改|换|切|停|放|播|降|升|提|加|减|亮|暗|暖|冷|静音|闭麦|出粮|喂|洗|烘|清|扫|拉|推|锁|解|查|看|读|说|发|删|退|回|定|变|弄|搞|处理|解决|拟定|安排|运行|启动|暂停|继续|恢复|重启|重置|关闭|打开|熄灭|点亮|灭|turn|open|close|set|dim|bright|stop|play|pause|start|off|on)/i;
const ZH_CONTINUATION_HEAD_RE = /^(?:的|得|地|了|着|过|到|成|为|给|在|里|上|下|中|吧|吗|呢|啊|呀|调|开|关|设|改|换|切|停|放|播|亮|暗|暖|冷|大|小|高|低)/;

export function countMeaningfulChars(text: string): number {
  return (text.match(MEANINGFUL_CHAR_RE) ?? []).length;
}

/**
 * 判断一段实时转写文本是否明显处于“话还没说完”的句中停顿态：
 * - 末尾带逗号/顿号/分号/冒号/省略号等非终结标点；
 * - 末尾落在连词、介词、犹豫词、起手短语（如“然后”“顺便”“帮我”“把”“那个”“的”等）；
 * - 出现“把/将 + 设备目标”但尚未说出具体动作谓语（如“帮我把客厅的吸顶灯”）。
 *
 * 显式排除独立唤醒词（如“Neo” / “小派”）与已完整闭合的短命令（如“打开客厅吸顶灯”）。
 */
export function looksLikeIncompleteUtterance(
  rawText: string,
  wakeWords: readonly string[] = [],
): boolean {
  const trimmed = rawText.trim();
  if (!trimmed) return false;
  if (isStandaloneWakePrefix(trimmed, wakeWords) || isWakeQueryText(trimmed)) {
    return false;
  }

  // 剥离句首唤醒词以聚焦真实话语主体
  let body = trimmed;
  if (wakeWords.length > 0) {
    const span = findWakeWordSpan(trimmed, wakeWords);
    if (span && span.beforeText.replace(LEADING_VOCATIVE_RE, "").replace(EDGE_PUNCT_RE, "").trim().length === 0) {
      body = span.afterText.trim();
    }
  }
  if (!body) return false;

  // 规则 1：显式以非终结停顿标点结尾（，、；：…—）
  if (CONTINUATION_TRAILING_PUNCT_RE.test(trimmed)) {
    return true;
  }

  // 规则 2：尾部剥离标点后落入典型未闭合连词/介词/犹豫词/“把+对象无谓语”
  const endsWithQuestionOrExcl = /[？?！!]\s*$/.test(body);
  const bodyNoPunct = body.replace(/[\s,，。．.、!！?？:：;；…\-—~～"'“”‘’]+$/g, "").trim();
  if (!bodyNoPunct) return false;

  if (ZH_INCOMPLETE_ENDING_RE.test(bodyNoPunct)) {
    return true;
  }
  if (EN_INCOMPLETE_ENDING_RE.test(bodyNoPunct)) {
    return true;
  }
  if (!endsWithQuestionOrExcl) {
    const baMatch = ZH_BA_OBJECT_TAIL_RE.exec(bodyNoPunct);
    if (baMatch && baMatch[1]) {
      const maskedTail = baMatch[1].replace(ZH_BA_DEVICE_NOUN_MASK_RE, "");
      if (!ZH_BA_PREDICATE_RE.test(maskedTail)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * 将慢语速停顿后前后两段连续话语平滑拼接为一句完整提示，自动消除重复前缀与人工句中句号。
 */
export function joinUtteranceFragments(prevText: string, nextText: string): string {
  const prev = prevText.trim();
  const next = nextText.trim();
  if (!prev) return next;
  if (!next) return prev;

  const dedupedNext = stripCommittedPrefix(next, prev);
  if (!dedupedNext) return prev;

  let left = prev;
  // 若前段结尾被 ASR 乐观补上了“。”，但去掉“。”明显未说完或后段以紧接谓语/助词开头，则去掉人工句号避免硬断语义
  if (/[。.]$/.test(left)) {
    const leftWithoutDot = left.slice(0, -1).trim();
    if (
      leftWithoutDot &&
      (looksLikeIncompleteUtterance(leftWithoutDot) || ZH_CONTINUATION_HEAD_RE.test(dedupedNext))
    ) {
      left = leftWithoutDot;
    }
  }

  const lastChar = left[left.length - 1] ?? "";
  const firstChar = dedupedNext[0] ?? "";
  const needsSpace = /[A-Za-z0-9]$/.test(lastChar) && /^[A-Za-z0-9]/.test(firstChar);
  return `${left}${needsSpace ? " " : ""}${dedupedNext}`;
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
  /** 末尾带强句末标点后等待多少毫秒静音即触发快速断句（仅在开启 enablePunctuationPauseCommit 时生效，默认 320ms） */
  punctuationPauseMs?: number;
  /** 无标点连续讲话最长多少字符触发子句断句（仅在开启 splitMidUtterance 时生效，默认 64） */
  maxCharsWithoutPunct?: number;
  /** 是否在说话中途按句末标点/超长字数强制拆分为多条句子下发（默认 false：等整段话说完一起发送） */
  splitMidUtterance?: boolean;
  /** 是否在句尾带强标点+短停顿时提前截断收句（默认 false：等待完整尾静音判停防慢语速误拆） */
  enablePunctuationPauseCommit?: boolean;
}

/**
 * 有状态的流式转写假设与整句稳定字幕状态机：
 * 追踪当前话语的 LocalAgreement 稳定前缀、语义未闭合提示与可选句中拆分，
 * 默认等用户整段话说完后再统一提交，避免慢语速长语音被提前拆碎。
 */
export class Qwen3StreamingHypothesisTracker {
  private _wakeWords: string[];
  private readonly _punctuationPauseMs: number;
  private readonly _maxCharsWithoutPunct: number;
  private readonly _splitMidUtterance: boolean;
  private readonly _enablePunctuationPauseCommit: boolean;

  private _prevHypothesis = "";
  private _stableText = "";
  private _latestText = "";
  private _committedPrefix = "";
  private _trailingSilenceMs = 0;

  constructor(options: Qwen3StreamingHypothesisTrackerOptions = {}) {
    this._wakeWords = [...(options.wakeWords ?? [])];
    this._punctuationPauseMs = options.punctuationPauseMs ?? 320;
    this._maxCharsWithoutPunct = options.maxCharsWithoutPunct ?? 64;
    this._splitMidUtterance = options.splitMidUtterance === true;
    this._enablePunctuationPauseCommit = options.enablePunctuationPauseCommit === true;
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

  get isLatestIncomplete(): boolean {
    return looksLikeIncompleteUtterance(this._latestText, this._wakeWords);
  }

  setWakeWords(wakeWords: readonly string[]): void {
    this._wakeWords = [...wakeWords];
  }

  /**
   * 喂入一次新的流式 ASR 假设，返回实时字幕状态；
   * 仅当显式开启 `splitMidUtterance` 时才在句中按标点提前拆分提交，默认保留完整话语直至说完。
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

    // 2. 仅在显式启用句中拆分模式时才按句末标点提前拆句下发
    if (this._splitMidUtterance) {
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
   * 推进帧级语音/静音状态：仅在显式开启 `enablePunctuationPauseCommit` 时，
   * 当最新识别文本已带有完整句末标点（且非独立唤醒词前缀、非未闭合停顿）且停顿达到 punctuationPauseMs 才提前收句。
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
      this._enablePunctuationPauseCommit &&
      this._trailingSilenceMs >= this._punctuationPauseMs &&
      endsWithStrongSentencePunct(this._latestText) &&
      !isStandaloneWakePrefix(this._latestText, this._wakeWords) &&
      !looksLikeIncompleteUtterance(this._latestText, this._wakeWords) &&
      countMeaningfulChars(this._latestText) >= 2
    ) {
      return { shouldCommitByPunctPause: true };
    }
    return { shouldCommitByPunctPause: false };
  }

  /**
   * 静音判停、超长上限或手动 flush 时，取出当前完整话语文本并重置状态：
   * - 默认整句模式（splitMidUtterance=false）：返回合并后的单条完整文本，绝不强拆多句；
   * - 显式分句模式（splitMidUtterance=true）：按强标点拆分为句子列表。
   */
  flush(finalHypothesis?: string): string[] {
    const source = (
      finalHypothesis !== undefined
        ? stripCommittedPrefix(finalHypothesis.trim(), this._committedPrefix)
        : this._latestText
    ).trim();
    this.reset();
    if (!source || countMeaningfulChars(source) < 1) {
      return [];
    }
    if (!this._splitMidUtterance) {
      return [source];
    }
    const split = splitStreamingSentences(source, {
      wakeWords: this._wakeWords,
      forceFlush: true,
      maxCharsWithoutPunct: this._maxCharsWithoutPunct,
    });
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
