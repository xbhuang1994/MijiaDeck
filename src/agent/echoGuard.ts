// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * 服务端多语段实时 TTS 回声防护与双讲回声剥离引擎（TtsEchoGuard）：
 *
 * 彻底解决全双工异步播报期间的回声痛点：
 * 1. 精准播放时间轴账本：维护正在播报 + 最近 12 条播报语段的真实扬声器起止时间（由浏览器端回传），
 *    解决队列排队多句播报时服务端“发射时间戳过早失效”导致后段回声漏网的问题；
 * 2. 口语/数字/单位等价归一化：自动对齐「85%」↔「百分之八十五」、「26°C」↔「二十六度」与常见 ASR 近音偏差；
 * 3. 多维度回声评分：结合子串包含率、最长公共子串覆盖率、Bigram 重叠与短确认词专属护栏；
 * 4. 反向指令与唤醒词安全护栏：绝不将用户紧接其后下达的反向指令（如刚播报“客厅吸顶灯已关闭”，用户说“打开客厅吸顶灯”）误杀为回声；
 * 5. 双讲回声残片剥离：当用户在播报尾音重叠说话导致 ASR 拼出“<播报尾音><真实指令>”时，
 *    自动剥离前后回声残片并完整保留真实用户指令继续执行！
 */

import type { EchoCancellationMode } from "../core/agentConfigStore.ts";
import type { VoiceprintIdentifyResult } from "./voiceprintStore.ts";

export interface EchoUtteranceRecord {
  id: string;
  text: string;
  normalized: string;
  enqueuedAt: number;
  startedAt: number | null;
  endedAt: number | null;
  estimatedDurationMs: number;
  active: boolean;
  priority?: "ack" | "normal" | "result" | "system";
  taskId?: string;
  /** 标记该播报属于向用户发出的确认提问，触发严格反回声自确认保护 */
  isConfirmationPrompt?: boolean;
}

export interface EchoEvaluateOptions {
  transcript: string;
  now?: number;
  mode?: EchoCancellationMode;
  duringTtsPlayback?: boolean;
  hasWakeWord?: boolean;
  looksDirectCommand?: boolean;
  voiceprint?: VoiceprintIdentifyResult | null;
  /** 兼容旧单句输入（如单元测试直接传 lastSpokenReply + lastSpokenAt） */
  legacyLastSpokenReply?: string;
  legacyLastSpokenAt?: number;
  /** 可选直接传入近期播报语段快照 */
  recentUtterances?: ReadonlyArray<EchoUtteranceRecord>;
  /** 外部告知当前是否有活跃播报 */
  ttsActive?: boolean;
  /** 处于待确认提问播报或刚播完状态：锁定严格回声阈值，防止 TTS 复述触发自确认 */
  strictConfirmationGuard?: boolean;
  /** 当前待确认提问入队时间：早于此时间的短 ACK（如“好的”）不再误杀用户的真实确认回复 */
  confirmationPromptEnqueuedAt?: number;
}

export interface EchoEvaluationResult {
  isEcho: boolean;
  grayZone: boolean;
  score: number;
  matchedUtterance: string;
  /** 若检测到双讲混合（播报残片 + 用户新指令），返回剥离回声后的干净用户文本 */
  strippedTranscript?: string;
  duringActiveTts: boolean;
  reason: string;
}

const ECHO_TAIL_WINDOW_MS = 5500;
const SHORT_ACK_TAIL_WINDOW_MS = 3200;
const DISTORTED_RESIDUAL_TAIL_WINDOW_MS = 2600;
const MAX_LEDGER_ENTRIES = 16;
/** 经扬声器+AEC/ClearVoice 失真后极易被 ASR 误拼出的单字拟声/尾音残片（绝不包含“好/嗯/对/是/开/关/一/二/不”等有效回复） */
const TTS_RESIDUAL_NOISE_CHAR_RE = /^[呀啊哦喔噢呃额哈呵啦呢嘛哎唉哟咦呜嘿哇哒啪咔咚嗡哼嘶嘘噗喂]$/;
/** 有效单字用户回复/确认/数字集合，播报期间即使声纹偏低也不走失真回声兜底误杀 */
const VALID_SINGLE_CHAR_USER_REPLY_RE = /^[好嗯对是行要开关停不没别算一二三四五六七八九十两零0-9]$/;

const ZH_DIGIT_MAP: Readonly<Record<string, number>> = {
  零: 0,
  〇: 0,
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
};

/**
 * 将中文口语数字（0~999，含小数如“二十六点五”）转为阿拉伯数字，便于对比 TTS 文本与 ASR 输出。
 */
function parseSimpleZhNumber(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  if (s.includes("点")) {
    const [intPart, fracPart] = s.split("点", 2);
    const intStr = intPart ? parseSimpleZhNumber(intPart) : "0";
    if (!intStr || !fracPart) return null;
    let frac = "";
    for (const ch of fracPart) {
      const d = ZH_DIGIT_MAP[ch];
      if (d === undefined) return null;
      frac += String(d);
    }
    return `${intStr}.${frac}`;
  }
  if (/^[零〇一二两三四五六七八九]+$/.test(s)) {
    return Array.from(s, (ch) => String(ZH_DIGIT_MAP[ch] ?? ch)).join("");
  }
  const m = /^(?:([一二两三四五六七八九])百)?(?:([零〇]))?(?:([一二两三四五六七八九])?十)?([一二两三四五六七八九])?$/.exec(
    s,
  );
  if (!m) return null;
  if (!m[1] && !s.includes("十")) return null;
  let total = 0;
  if (m[1]) {
    total += (ZH_DIGIT_MAP[m[1]] ?? 0) * 100;
  }
  if (s.includes("十")) {
    const tens = m[3] ? (ZH_DIGIT_MAP[m[3]] ?? 1) : 1;
    total += tens * 10;
  }
  if (m[4]) {
    total += ZH_DIGIT_MAP[m[4]] ?? 0;
  }
  return String(total);
}

/**
 * 统一回声比对归一化：
 * - 对齐 Matcha-TTS 读法与 ASR 转写（「85%」↔「百分之八十五」、「26°C」↔「26度」↔「二十六度」）
 * - 对齐极短应答近音（「恩」↔「嗯」、「好哒/好滴」↔「好的」）
 * - 去除所有标点、空白与 Markdown 符号
 */
export function normalizeTextForEchoMatch(raw: string): string {
  let s = String(raw ?? "")
    .toLowerCase()
    .replace(/\[did=[^\]]*\]/gi, "")
    .replace(/\[id=[^\]]*\]/gi, "")
    .replace(/°\s*c|℃|摄氏度/gi, "度")
    .replace(/百分之\s*([0-9]+(?:\.[0-9]+)?)/g, "$1%")
    .replace(/百分之([零〇一二两三四五六七八九十百点]+)/g, (_m, num: string) => {
      const parsed = parseSimpleZhNumber(num);
      return parsed ? `${parsed}%` : `百分之${num}`;
    })
    .replace(/([零〇一二两三四五六七八九十百]+(?:点[零〇一二两三四五六七八九]+)?)(?=[度%份秒分时个台路档])/g, (_m, num: string) => {
      return parseSimpleZhNumber(num) ?? num;
    })
    .replace(/好哒|好滴|好嘞|好咧/g, "好的")
    .replace(/恩/g, "嗯")
    .replace(/小湃|小π/g, "小派")
    .replace(/尼奥|尼欧|妮奥|妮欧/g, "neo");

  s = s.replace(/[\s,，。．.、!！?？:：;；\-—~～"'`“”‘’()（）[\]【】*#•·]+/g, "");
  return s;
}

const POLARITY_GROUPS: ReadonlyArray<[RegExp, RegExp]> = [
  [/(?:打开|开启|开灯|亮灯|开机|开空调|开风扇|开窗|开电视|开音箱|开音响|全开|开一下|已开|已经打开|已打开)/, /(?:关闭|关掉|关上|关灯|熄灯|灭灯|关机|关空调|关风扇|关窗|关电视|关音箱|关音响|全关|关一下|已关|已经关闭|已关闭)/],
  [/(?:调大|调高|调亮|亮一点|大一点|高一点|升一点|升温|加一点)/, /(?:调小|调低|调暗|暗一点|小一点|低一点|降一点|降温|减一点)/],
  [/(?:播放|继续|放歌|放音乐|取消静音|解除静音|恢复声音)/, /(?:暂停|停止|停一下|停掉|别放|不要放|静音)/],
  [/(?:调暖|暖光|暖一点)/, /(?:调冷|冷光|白光|冷一点)/],
];

const IMPERATIVE_PREFIX_RE =
  /^(?:请|帮我|给我|麻烦|再|稍微|还是|那就|把|将|快|赶紧|顺便|打开|开启|关闭|关掉|关上|开灯|关灯|调|设置|设定|设为|改成|换成|切换|播放|暂停|停止|静音|取消静音|亮一点|暗一点|大一点|小一点|查|查看|查询|看看|出粮|喂食|喂猫|喂狗)/i;

const SHORT_ACK_ECHO_SET = new Set([
  "嗯",
  "嗯嗯",
  "好的",
  "好",
  "在呢",
  "我在",
  "已待机",
  "待机",
  "收到",
  "好的收到",
  "嗯好的",
]);

function hasOppositeActionPolarity(heardNorm: string, spokenNorm: string): boolean {
  for (const [posRe, negRe] of POLARITY_GROUPS) {
    const heardPos = posRe.test(heardNorm);
    const heardNeg = negRe.test(heardNorm);
    const spokenPos = posRe.test(spokenNorm);
    const spokenNeg = negRe.test(spokenNorm);
    if ((heardPos && !heardNeg && spokenNeg && !spokenPos) || (heardNeg && !heardPos && spokenPos && !spokenNeg)) {
      return true;
    }
  }
  return false;
}

function longestCommonSubstringLen(a: string, b: string): number {
  if (!a || !b) return 0;
  // 限制最大比对长度保证 O(1) 极低耗时
  const sa = a.length > 160 ? a.slice(0, 160) : a;
  const sb = b.length > 260 ? b.slice(0, 260) : b;
  const prev = new Uint16Array(sb.length + 1);
  let best = 0;
  for (let i = 1; i <= sa.length; i += 1) {
    let diag = 0;
    const ca = sa.charCodeAt(i - 1);
    for (let j = 1; j <= sb.length; j += 1) {
      const saved = prev[j]!;
      if (ca === sb.charCodeAt(j - 1)) {
        const val = diag + 1;
        prev[j] = val;
        if (val > best) best = val;
      } else {
        prev[j] = 0;
      }
      diag = saved;
    }
  }
  return best;
}

/**
 * 计算听到的识别文本与播报文本之间的增强回声重叠率（[0, 1]）。
 * 同时支持口语数字/单位归一化、子串包含、Bigram 命中与最长公共子串覆盖。
 */
export function computeEnhancedEchoOverlap(transcript: string, spoken: string): number {
  const a = normalizeTextForEchoMatch(transcript);
  const b = normalizeTextForEchoMatch(spoken);
  if (!a || !b) return 0;
  if (a.length < 2) {
    return a === b ? 1 : 0;
  }
  if (b.includes(a)) return 1;
  if (a.includes(b) && b.length >= 4) {
    return Math.min(1, b.length / a.length);
  }

  // 1. Bigram containment ratio (of heard text covered by spoken text)
  const bigramsB = new Set<string>();
  for (let i = 0; i < b.length - 1; i += 1) {
    bigramsB.add(b.slice(i, i + 2));
  }
  let bigramHits = 0;
  const totalBigramsA = Math.max(1, a.length - 1);
  for (let i = 0; i < a.length - 1; i += 1) {
    if (bigramsB.has(a.slice(i, i + 2))) bigramHits += 1;
  }
  const bigramRatio = bigramHits / totalBigramsA;

  // 2. Longest common substring ratio (catches contiguous leaked tail/head echo)
  const lcsLen = longestCommonSubstringLen(a, b);
  const lcsRatio = lcsLen / a.length;

  // 3. Unigram multiset coverage (helps when ASR drops 1-2 chars inside an echo phrase)
  const countsB = new Map<string, number>();
  for (const ch of b) {
    countsB.set(ch, (countsB.get(ch) ?? 0) + 1);
  }
  let charHits = 0;
  for (const ch of a) {
    const left = countsB.get(ch) ?? 0;
    if (left > 0) {
      charHits += 1;
      countsB.set(ch, left - 1);
    }
  }
  const charCoverage = charHits / a.length;

  // 综合评分：以 Bigram 与 LCS 为主，高字符覆盖率适度补强
  const combined = Math.max(bigramRatio, lcsRatio * 0.96, bigramRatio * 0.65 + charCoverage * 0.35);
  return Number(Math.min(1, Math.max(0, combined)).toFixed(4));
}

/**
 * 尝试从双讲混合文本中剥离首部或尾部的 TTS 播报回声残片，保留真实用户指令。
 * 例如：播报「客厅吸顶灯已打开」，用户重叠说「把卧室灯关了」，ASR 输出「客厅吸顶灯已打开，把卧室灯关了」
 * -> 剥离后返回「把卧室灯关了」。
 */
export function stripEchoContamination(
  rawTranscript: string,
  spokenTexts: readonly string[],
): string | null {
  const trimmed = rawTranscript.trim();
  if (trimmed.length < 5 || spokenTexts.length === 0) return null;

  // 策略 1：按自然标点子句切分，过滤掉纯回声子句，保留清晰非回声子句
  const clauses = trimmed
    .split(/([，,。！？!?;；\n]+)/)
    .map((c) => c.trim())
    .filter((c) => c.length > 0 && !/^[，,。！？!?;；\n]+$/.test(c));

  if (clauses.length >= 2) {
    const kept: string[] = [];
    let droppedAny = false;
    for (const clause of clauses) {
      let maxOv = 0;
      let matchedSpokenNorm = "";
      for (const sp of spokenTexts) {
        const ov = computeEnhancedEchoOverlap(clause, sp);
        if (ov > maxOv) {
          maxOv = ov;
          matchedSpokenNorm = normalizeTextForEchoMatch(sp);
        }
      }
      const clauseNorm = normalizeTextForEchoMatch(clause);
      const isOpposite = hasOppositeActionPolarity(clauseNorm, matchedSpokenNorm);
      const isPureShortAck =
        SHORT_ACK_ECHO_SET.has(clauseNorm) &&
        spokenTexts.some((sp) => normalizeTextForEchoMatch(sp).includes(clauseNorm));
      if (!isOpposite && (isPureShortAck || (maxOv >= 0.72 && clauseNorm.length >= 2))) {
        droppedAny = true;
      } else {
        kept.push(clause);
      }
    }
    if (droppedAny && kept.length > 0) {
      const candidate = kept.join("，").trim();
      if (candidate.length >= 2 && candidate !== trimmed) {
        return candidate;
      }
    }
  }

  // 策略 2：无标点粘连（如「客厅吸顶灯已打开把卧室灯关了」或「已打开把卧室灯关了」）
  for (const sp of spokenTexts) {
    const spClean = sp
      .replace(/[\s,，。．.、!！?？:：;；\-—~～"'`“”‘’()（）[\]【】]+/g, "")
      .trim();
    if (spClean.length < 3) continue;

    // 检查前缀匹配（完整或播报尾部的 >= 3 字残片出现在听写开头）
    const maxCheck = Math.min(spClean.length, trimmed.length - 2);
    for (let len = maxCheck; len >= 3; len -= 1) {
      const prefixCandidate = trimmed.slice(0, len);
      const prefixNorm = normalizeTextForEchoMatch(prefixCandidate);
      const spNorm = normalizeTextForEchoMatch(spClean);
      if (prefixNorm.length >= 3 && spNorm.endsWith(prefixNorm)) {
        const rest = trimmed
          .slice(len)
          .replace(/^[\s,，。．.、!！?？:：;；\-—~～]+/, "")
          .trim();
        if (rest.length >= 2 && !hasOppositeActionPolarity(prefixNorm, spNorm)) {
          return rest;
        }
      }
    }

    // 检查尾部匹配（播报开头的 >= 3 字残片粘连在听写结尾）
    for (let len = maxCheck; len >= 3; len -= 1) {
      const suffixCandidate = trimmed.slice(trimmed.length - len);
      const suffixNorm = normalizeTextForEchoMatch(suffixCandidate);
      const spNorm = normalizeTextForEchoMatch(spClean);
      if (suffixNorm.length >= 3 && spNorm.startsWith(suffixNorm)) {
        const head = trimmed
          .slice(0, trimmed.length - len)
          .replace(/[\s,，。．.、!！?？:：;；\-—~～]+$/, "")
          .trim();
        if (head.length >= 2 && !hasOppositeActionPolarity(suffixNorm, spNorm)) {
          return head;
        }
      }
    }
  }

  return null;
}

export class TtsEchoGuard {
  private _ledger: EchoUtteranceRecord[] = [];
  private _seq = 0;
  private _suppressedCount = 0;
  private _strippedCount = 0;
  private _clientSpeaking = false;
  private _clientDucked = false;
  private _clientQueueLength = 0;
  private _activeUtteranceId: string | null = null;
  private _activeUtteranceText: string | null = null;
  private _aecActive = false;
  private _erleDb = 0;
  private _doubleTalkActive = false;

  get suppressedCount(): number {
    return this._suppressedCount;
  }

  get strippedCount(): number {
    return this._strippedCount;
  }

  get isSpeaking(): boolean {
    return this._clientSpeaking || this._ledger.some((u) => u.active);
  }

  get clientDucked(): boolean {
    return this._clientDucked;
  }

  get clientQueueLength(): number {
    return this._clientQueueLength;
  }

  get activeUtteranceId(): string | null {
    return this._activeUtteranceId;
  }

  get activeUtteranceText(): string | null {
    return this._activeUtteranceText;
  }

  get aecActive(): boolean {
    return this._aecActive;
  }

  get erleDb(): number {
    return this._erleDb;
  }

  get doubleTalkActive(): boolean {
    return this._doubleTalkActive;
  }

  recordSuppressed(): void {
    this._suppressedCount += 1;
  }

  recordStripped(): void {
    this._strippedCount += 1;
  }

  /**
   * 在服务端派发一段 TTS 播报时登记到回声账本，返回唯一 utteranceId 供前后端对齐。
   */
  registerUtterance(
    text: string,
    options: {
      utteranceId?: string;
      now?: number;
      priority?: "ack" | "normal" | "result" | "system";
      taskId?: string;
      isConfirmationPrompt?: boolean;
    } = {},
  ): EchoUtteranceRecord {
    const now = options.now ?? Date.now();
    const cleaned = text.trim();
    const id = options.utteranceId || `tts_${now}_${++this._seq}`;
    const estimatedDurationMs = Math.max(900, Math.min(20_000, cleaned.length * 240 + 450));
    const rec: EchoUtteranceRecord = {
      id,
      text: cleaned,
      normalized: normalizeTextForEchoMatch(cleaned),
      enqueuedAt: now,
      startedAt: null,
      endedAt: null,
      estimatedDurationMs,
      active: false,
      priority: options.priority,
      taskId: options.taskId,
      isConfirmationPrompt: options.isConfirmationPrompt,
    };
    this._ledger.push(rec);
    if (this._ledger.length > MAX_LEDGER_ENTRIES) {
      this._ledger = this._ledger.slice(-MAX_LEDGER_ENTRIES);
    }
    return rec;
  }

  /**
   * 接收浏览器端真实扬声器播报状态与实时 AEC 指标。
   */
  updateClientPlaybackState(patch: {
    speaking?: boolean;
    phase?: "start" | "end" | "cancel" | "duck" | "unduck" | "telemetry";
    utteranceId?: string | null;
    text?: string | null;
    queueLength?: number;
    ducked?: boolean;
    aecActive?: boolean;
    erleDb?: number;
    doubleTalk?: boolean;
    now?: number;
  }): void {
    const now = patch.now ?? Date.now();

    if (typeof patch.aecActive === "boolean") this._aecActive = patch.aecActive;
    if (typeof patch.erleDb === "number" && Number.isFinite(patch.erleDb)) {
      this._erleDb = Number(Math.max(0, Math.min(50, patch.erleDb)).toFixed(1));
    }
    if (typeof patch.doubleTalk === "boolean") this._doubleTalkActive = patch.doubleTalk;
    if (typeof patch.queueLength === "number" && Number.isFinite(patch.queueLength)) {
      this._clientQueueLength = Math.max(0, Math.round(patch.queueLength));
    }
    if (typeof patch.ducked === "boolean") {
      this._clientDucked = patch.ducked;
    } else if (patch.phase === "duck") {
      this._clientDucked = true;
    } else if (patch.phase === "unduck") {
      this._clientDucked = false;
    }

    if (patch.phase === "start" || (patch.speaking === true && patch.phase !== "telemetry")) {
      this._clientSpeaking = true;
      const uttId = patch.utteranceId?.trim() || null;
      const uttText = patch.text?.trim() || null;
      if (uttId) {
        this._activeUtteranceId = uttId;
      }
      if (uttText) {
        this._activeUtteranceText = uttText;
      }

      let found = uttId ? this._ledger.find((u) => u.id === uttId) : undefined;
      if (!found && uttText) {
        const norm = normalizeTextForEchoMatch(uttText);
        found = [...this._ledger]
          .reverse()
          .find((u) => u.normalized === norm && now - u.enqueuedAt < 25_000);
      }
      if (found) {
        found.startedAt = found.startedAt ?? now;
        found.endedAt = null;
        found.active = true;
        this._activeUtteranceId = found.id;
        this._activeUtteranceText = found.text;
      } else if (uttText) {
        const added = this.registerUtterance(uttText, { utteranceId: uttId ?? undefined, now });
        added.startedAt = now;
        added.active = true;
        this._activeUtteranceId = added.id;
        this._activeUtteranceText = added.text;
      }
      return;
    }

    if (patch.phase === "end" || patch.phase === "cancel" || patch.speaking === false) {
      const uttId = patch.utteranceId?.trim() || null;
      if (uttId) {
        const target = this._ledger.find((u) => u.id === uttId);
        if (target) {
          target.active = false;
          target.endedAt = now;
        }
      }
      if (patch.speaking === false || patch.phase === "cancel") {
        this._clientSpeaking = false;
        this._clientDucked = false;
        this._activeUtteranceId = null;
        this._activeUtteranceText = null;
        if (patch.phase === "cancel") {
          this._clientQueueLength = 0;
        }
        for (const rec of this._ledger) {
          if (rec.active) {
            rec.active = false;
            rec.endedAt = now;
          }
        }
      }
    }
  }

  /**
   * 获取当前处于活跃或回声尾窗内的所有 TTS 语段。
   */
  getRecentUtterances(now = Date.now(), tailWindowMs = ECHO_TAIL_WINDOW_MS): EchoUtteranceRecord[] {
    const out: EchoUtteranceRecord[] = [];
    for (const u of this._ledger) {
      if (!u.text) continue;
      if (u.active) {
        out.push({ ...u });
        continue;
      }
      if (u.endedAt !== null) {
        const effTail = u.isConfirmationPrompt ? Math.max(tailWindowMs, 8500) : tailWindowMs;
        if (now >= u.endedAt && now - u.endedAt <= effTail) {
          out.push({ ...u });
        }
        continue;
      }
      // 尚未收到前端播放完毕回执时，以 enqueuedAt + estimatedDurationMs + tailWindowMs 作为兜底有效窗
      const approxEnd = (u.startedAt ?? u.enqueuedAt) + u.estimatedDurationMs;
      const effTail = u.isConfirmationPrompt ? Math.max(tailWindowMs, 8500) : tailWindowMs;
      if (now >= u.enqueuedAt && now <= approxEnd + effTail) {
        out.push({ ...u });
      }
    }
    return out;
  }

  /**
   * 返回兼容旧接口的最近播报文本摘要（供 SystemOne 上下文和向后兼容使用）。
   */
  getLegacyLastSpoken(now = Date.now()): { text: string; at: number } {
    const recent = this.getRecentUtterances(now);
    if (recent.length === 0) {
      const last = this._ledger[this._ledger.length - 1];
      if (!last) return { text: "", at: 0 };
      return { text: last.text, at: last.endedAt ?? last.startedAt ?? last.enqueuedAt };
    }
    const latest = recent[recent.length - 1]!;
    const joined = recent
      .slice(-3)
      .map((u) => u.text)
      .join(" ")
      .slice(-300);
    const refAt = latest.active
      ? now
      : (latest.endedAt ?? latest.startedAt ?? latest.enqueuedAt);
    return { text: joined, at: refAt };
  }

  reset(): void {
    this._ledger = [];
    this._clientSpeaking = false;
    this._clientDucked = false;
    this._clientQueueLength = 0;
    this._activeUtteranceId = null;
    this._activeUtteranceText = null;
    this._doubleTalkActive = false;
  }

  evaluate(options: EchoEvaluateOptions): EchoEvaluationResult {
    return evaluateTtsEcho({
      ...options,
      recentUtterances: options.recentUtterances ?? this.getRecentUtterances(options.now ?? Date.now()),
      ttsActive: options.ttsActive ?? this.isSpeaking,
    });
  }
}

/**
 * 纯函数多语段 TTS 回声评估器（支持账本快照与旧 lastSpokenReply 兼容）。
 */
export function evaluateTtsEcho(options: EchoEvaluateOptions): EchoEvaluationResult {
  const mode = options.mode ?? "auto";
  if (mode === "off") {
    return {
      isEcho: false,
      grayZone: false,
      score: 0,
      matchedUtterance: "",
      duringActiveTts: false,
      reason: "回声语义过滤已关闭",
    };
  }

  const now = options.now ?? Date.now();
  const cleaned = options.transcript.trim();
  const heardNorm = normalizeTextForEchoMatch(cleaned);
  if (!heardNorm) {
    return {
      isEcho: false,
      grayZone: false,
      score: 0,
      matchedUtterance: "",
      duringActiveTts: Boolean(options.ttsActive || options.duringTtsPlayback),
      reason: "",
    };
  }

  const tailWindowMs = mode === "aggressive" ? 7500 : ECHO_TAIL_WINDOW_MS;
  const candidates: EchoUtteranceRecord[] = [];

  if (options.recentUtterances && options.recentUtterances.length > 0) {
    for (const u of options.recentUtterances) {
      if (!u.text) continue;
      // 确认提问发出后，忽略早于提问的短 ACK（如“好的”），避免误杀用户针对该提问的真实“好的/嗯”肯定答复
      if (
        options.confirmationPromptEnqueuedAt &&
        u.priority === "ack" &&
        u.enqueuedAt < options.confirmationPromptEnqueuedAt
      ) {
        continue;
      }
      if (u.active) {
        candidates.push(u);
        continue;
      }
      const refEnd = u.endedAt ?? (u.startedAt ?? u.enqueuedAt) + u.estimatedDurationMs;
      const effectiveTail =
        options.strictConfirmationGuard || u.isConfirmationPrompt
          ? Math.max(tailWindowMs, 8500)
          : tailWindowMs;
      if (now >= u.enqueuedAt - 200 && now <= refEnd + effectiveTail) {
        candidates.push(u);
      }
    }
  }

  // 兼容旧测试/调用路径：仅传入 legacyLastSpokenReply + legacyLastSpokenAt
  if (
    candidates.length === 0 &&
    options.legacyLastSpokenReply &&
    options.legacyLastSpokenAt &&
    now >= options.legacyLastSpokenAt &&
    now - options.legacyLastSpokenAt <= (options.strictConfirmationGuard ? Math.max(tailWindowMs, 8500) : tailWindowMs)
  ) {
    candidates.push({
      id: "legacy",
      text: options.legacyLastSpokenReply,
      normalized: normalizeTextForEchoMatch(options.legacyLastSpokenReply),
      enqueuedAt: options.legacyLastSpokenAt,
      startedAt: options.legacyLastSpokenAt,
      endedAt: options.legacyLastSpokenAt,
      estimatedDurationMs: 0,
      active: false,
    });
  }

  const duringActiveTts = Boolean(
    options.ttsActive || options.duringTtsPlayback || candidates.some((c) => c.active),
  );

  if (candidates.length === 0) {
    return {
      isEcho: false,
      grayZone: false,
      score: 0,
      matchedUtterance: "",
      duringActiveTts,
      reason: "",
    };
  }

  // 构造单条候选 + 合并最近语段窗口（覆盖跨句拼接回声）
  const spokenTexts = candidates.map((c) => c.text);
  const combinedSpoken = spokenTexts.slice(-4).join(" ");
  const allTargets = [...spokenTexts, ...(spokenTexts.length > 1 ? [combinedSpoken] : [])];

  let bestScore = 0;
  let bestTarget = "";
  let bestTargetNorm = "";
  for (const t of allTargets) {
    const sc = computeEnhancedEchoOverlap(cleaned, t);
    if (sc > bestScore) {
      bestScore = sc;
      bestTarget = t;
      bestTargetNorm = normalizeTextForEchoMatch(t);
    }
  }

  const strictConfirmationActive = Boolean(
    options.strictConfirmationGuard || candidates.some((c) => c.isConfirmationPrompt),
  );

  // 1. 极短应答回声保护（如播报“嗯?”、“好的”、“在呢”、“已待机”后 3.2s 内回收到 1~2 字残片）
  // 特例：若提问已发出且早前的“好的”短 ACK 早于该确认提问，则绝不误杀用户针对该提问说出的真实“好的/嗯”！
  const shortAckMatched = candidates.some((c) => {
    if (
      options.confirmationPromptEnqueuedAt &&
      c.priority === "ack" &&
      c.enqueuedAt < options.confirmationPromptEnqueuedAt
    ) {
      return false;
    }
    const elapsed = c.active ? 0 : Math.max(0, now - (c.endedAt ?? c.enqueuedAt));
    if (elapsed > SHORT_ACK_TAIL_WINDOW_MS) return false;
    if (heardNorm.length < 1 || heardNorm.length > 2) return false;
    if (!c.normalized) return false;
    if (heardNorm === c.normalized) return true;
    if (c.normalized.length <= 6 && c.normalized.includes(heardNorm)) return true;
    if (SHORT_ACK_ECHO_SET.has(heardNorm) && SHORT_ACK_ECHO_SET.has(c.normalized)) return true;
    return false;
  });

  if (shortAckMatched && !options.hasWakeWord) {
    return {
      isEcho: true,
      grayZone: false,
      score: 0.96,
      matchedUtterance: bestTarget || candidates[candidates.length - 1]!.text,
      duringActiveTts,
      reason: "检测到系统短应答播报回声，已自动抑制",
    };
  }

  // 2. 反向祈使指令保护（如刚播报“已关闭客厅吸顶灯”，用户紧接着说“打开客厅吸顶灯”）
  const looksDirect = Boolean(options.looksDirectCommand || IMPERATIVE_PREFIX_RE.test(cleaned));
  const oppositePolarity = hasOppositeActionPolarity(heardNorm, bestTargetNorm);
  if (!strictConfirmationActive && oppositePolarity && (looksDirect || options.hasWakeWord)) {
    return {
      isEcho: false,
      grayZone: false,
      score: bestScore,
      matchedUtterance: bestTarget,
      duringActiveTts,
      reason: "检测到与播报状态相反的用户控制指令，放行执行",
    };
  }

  // 3. 确定动态回声判定门槛（综合播报活跃态、声纹身份、唤醒词与模式灵敏度）
  const ownerVoiceMatched = Boolean(
    options.voiceprint?.evaluated && options.voiceprint.matched && options.voiceprint.score >= 0.45,
  );
  const nonOwnerDuringTts = Boolean(
    duringActiveTts &&
      options.voiceprint?.evaluated &&
      options.voiceprint.enrolledCount > 0 &&
      !options.voiceprint.matched,
  );

  // 2.5 播报期/紧邻尾音失真单字回声残片保护：
  // 扬声器回声经硬件 AEC / ClearVoice 强降噪后常畸变为单字拟声残片（如“好的”→“呀。”、“啊。”），
  // 文本与原播报字面零重合且常呈现低置信未知声纹；在不影响“好/嗯/对/是/开/关/一/二/不”等有效单字答复前提下直接按回声抑制。
  if (!options.hasWakeWord && !looksDirect && heardNorm.length === 1 && !ownerVoiceMatched) {
    const hasRecentShortTailTts =
      duringActiveTts ||
      candidates.some((c) => {
        if (
          options.confirmationPromptEnqueuedAt &&
          c.priority === "ack" &&
          c.enqueuedAt < options.confirmationPromptEnqueuedAt
        ) {
          return false;
        }
        const elapsed = c.active ? 0 : Math.max(0, now - (c.endedAt ?? c.enqueuedAt));
        return elapsed <= DISTORTED_RESIDUAL_TAIL_WINDOW_MS;
      });
    const isDistortedFiller = hasRecentShortTailTts && TTS_RESIDUAL_NOISE_CHAR_RE.test(heardNorm);
    const isNonOwnerActiveSyllable =
      nonOwnerDuringTts && !VALID_SINGLE_CHAR_USER_REPLY_RE.test(heardNorm);
    if (isDistortedFiller || isNonOwnerActiveSyllable) {
      return {
        isEcho: true,
        grayZone: false,
        score: 0.92,
        matchedUtterance: bestTarget || candidates[candidates.length - 1]!.text,
        duringActiveTts,
        reason: "检测到播报期间/尾音失真单字回声残片，已自动抑制",
      };
    }
  }

  let echoThreshold = options.hasWakeWord || looksDirect ? 0.86 : 0.58;
  if (strictConfirmationActive && !options.hasWakeWord) {
    // 确认提问播报完毕后，用户说出 1~2 字极短回复（如“好的/是的/对的/嗯/好”）不应因含助词“的”
    // 与长确认问句（如“要用洗衣机的袜子筒吗”）产生 50% 单字重合而被误杀！
    if (!duringActiveTts && heardNorm.length <= 2 && bestTargetNorm.length >= 8) {
      return {
        isEcho: false,
        grayZone: false,
        score: bestScore,
        matchedUtterance: bestTarget,
        duringActiveTts,
        reason: "",
      };
    }
    // 确认提问播报与尾窗期间锁定严格回声阈值，禁止 looksDirect/声纹加分抬高门槛导致 TTS 自确认
    echoThreshold = 0.42;
  } else {
    if (duringActiveTts && !options.hasWakeWord) {
      echoThreshold -= 0.06;
    }
    if (mode === "aggressive") {
      echoThreshold -= 0.08;
    } else if (mode === "standard") {
      echoThreshold += 0.04;
    }
    if (ownerVoiceMatched) {
      echoThreshold += 0.1;
    } else if (nonOwnerDuringTts) {
      echoThreshold -= 0.08;
    }
    echoThreshold = Math.max(0.42, Math.min(0.95, echoThreshold));
  }

  if (bestScore >= echoThreshold) {
    return {
      isEcho: true,
      grayZone: false,
      score: bestScore,
      matchedUtterance: bestTarget,
      duringActiveTts,
      reason: strictConfirmationActive
        ? "确认提问播报期间检测到疑似扬声器回声，已拦截防自确认"
        : duringActiveTts
          ? "全双工播报期间检测到扬声器回声，已自动抑制"
          : "检测到系统语音播报回声，已自动抑制",
    };
  }

  // 4. 双讲回声残片剥离：用户说话与播报重叠导致 ASR 拼接“<播报尾音><真实指令>”
  // 确认提问防护期间禁止残片剥离放行，防止确认问句尾部残片被当作新命令或肯定确认
  if (!strictConfirmationActive && (bestScore >= 0.22 || duringActiveTts)) {
    const stripped = stripEchoContamination(cleaned, spokenTexts);
    if (stripped) {
      const strippedScore = Math.max(
        0,
        ...spokenTexts.map((t) => computeEnhancedEchoOverlap(stripped, t)),
      );
      if (strippedScore < 0.55) {
        return {
          isEcho: false,
          grayZone: false,
          score: bestScore,
          matchedUtterance: bestTarget,
          strippedTranscript: stripped,
          duringActiveTts,
          reason: "已自动剥离混入的播报回声残片，保留用户指令",
        };
      }
    }
  }

  // 5. 灰区交由 SystemOne 语义二分类复核
  const grayFloor = duringActiveTts ? 0.34 : 0.4;
  const grayZone = bestScore >= grayFloor && bestScore < echoThreshold;
  return {
    isEcho: false,
    grayZone,
    score: bestScore,
    matchedUtterance: bestTarget,
    duringActiveTts,
    reason: "",
  };
}
