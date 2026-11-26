// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * ASR 静音/低能量幻觉与热词 Prompt 回显防护（防御纵深）：
 *
 * 1. 识别并拦截生成式 ASR（如 Qwen3-ASR / Whisper）将配置唤醒词列表拼串回显的幻觉输出
 *    （例如 `嘿Neo 尼奥 鸟 嘿6 Neo`、`尼奥 鸟 嘿6`、`Neo 小派` 等多个不同唤醒词连续罗列）；
 * 2. 识别并拦截经典视频字幕静音幻觉（如“感谢观看”“字幕由…提供”“Thanks for watching”）
 *    与自回归无限重复解码环（如“啊啊啊啊啊啊”“谢谢 谢谢 谢谢 谢谢”）；
 * 3. 绝不误杀合法单字确认答复（“对/好/嗯”）、退出词（“谢谢/不用了”）、单个唤醒词（“Neo/嘿Neo”）
 *    或正常智能家居指令。
 */

const EDGE_SEP_RE = /^[\s,，。．.、!！?？:：;；\-—~～"'“”‘’()（）[\]【】♪🎵]+|[\s,，。．.、!！?？:：;；\-—~～"'“”‘’()（）[\]【】♪🎵]+$/g;
const SEP_CHAR_RE = /^[\s,，。．.、!！?？:：;；\-—~～"'“”‘’()（）[\]【】♪🎵]+/;
const MEANINGFUL_CHAR_RE = /[\p{L}\p{N}]/gu;
const LEADING_VOCATIVE_STRIP_RE = /^(?:嘿|嗨|喂|哎|唉|hey|hi|ok|yo)[\s,，。．.、!！?？:：;；\-—~～]*/i;
const VOCATIVE_GLUE_RE = /^(?:嘿|嗨|喂|hey|hi|ok)(?![a-z])/i;

// 仅作用于括号内非人声事件标注（如 [Music] / (Silence) / [噪声]）
const NON_SPEECH_BRACKET_TAG_RE =
  /(?:\[(?:music|silence|noise|applause|laughter|bgm|blank_audio|inaudible|音乐|背景音乐|静音|噪声|噪音|笑声|掌声|无人声)\]|\((?:music|silence|noise|applause|laughter|bgm|音乐|背景音乐|静音|噪声|噪音|笑声|掌声)\))/gi;

// 经典 Whisper / Qwen3-ASR 静音字幕幻觉（严格整句锚定，绝不误伤正常对话或“谢谢”退出词）
const KNOWN_ZH_SUBTITLE_HALLUCINATION_RE =
  /^(?:请不吝点赞订阅转发打赏支持.+|感谢(?:您的|大家)?(?:观看|收看|聆听|收听|支持(?:本频道)?)|谢谢(?:您的|大家)?(?:观看|收看|聆听|收听)|欢迎订阅(?:本频道|我的频道)?|订阅(?:本频道|我的频道)|字幕(?:由|提供|制作|组|整理).+|中文字幕(?:由.+)?|优优独播剧场.*|明镜与点点.*|本期视频就到这里.*|我们下期(?:再见|见).*|点个赞吧|点赞关注(?:不迷路)?|请订阅(?:本频道|我的频道))$/;

const KNOWN_EN_SUBTITLE_HALLUCINATION_RE =
  /^(?:thanks?\s+for\s+watching|thank\s+you(?:\s+very\s+much)?\s+for\s+watching|please\s+(?:like\s+and\s+)?subscribe(?:\s+to\s+(?:my|our|the)\s+channel)?|like\s+and\s+subscribe|subtitles?\s+by\b.*|captioned\s+by\b.*|transcribed\s+by\b.*|amara\.org.*|www\.[a-z0-9.-]+\.[a-z]{2,})$/i;

const KNOWN_CJK_BROADCAST_HALLUCINATION_RE =
  /^(?:ご視聴ありがとうございま(?:した|す)|チャンネル登録.*|MBC\s*뉴스.*|시청해\s*주셔서\s*감사합니다|구독과\s*좋아요.*)$/i;

// 同一非数字字符连续重复 >= 6 次（如“啊啊啊啊啊啊”“のののののの”）
const DEGENERATE_CHAR_REPEAT_RE = /([^\d\s,，。．.、!！?？:：;；\-—~～"'“”‘’])\1{5,}/u;

interface NormalizedWakeEntry {
  raw: string;
  compact: string;
  stem: string;
  isAsciiTail: boolean;
  isAsciiHead: boolean;
}

function normalizeWakeStem(word: string): string {
  const cleaned = word.trim().replace(EDGE_SEP_RE, "").toLowerCase();
  const stripped = cleaned.replace(LEADING_VOCATIVE_STRIP_RE, "").trim();
  const compact = (stripped || cleaned).replace(/[\s,，。．.、!！?？:：;；\-—~～]+/g, "");
  return compact || cleaned;
}

function compileWakeEntries(wakeWords: readonly string[]): NormalizedWakeEntry[] {
  const seen = new Set<string>();
  const out: NormalizedWakeEntry[] = [];
  for (const w of wakeWords) {
    const raw = w.trim().replace(EDGE_SEP_RE, "");
    if (!raw) continue;
    const compact = raw.toLowerCase().replace(/[\s,，。．.、!！?？:：;；\-—~～]+/g, "");
    if (!compact || seen.has(compact)) continue;
    seen.add(compact);
    out.push({
      raw,
      compact,
      stem: normalizeWakeStem(raw),
      isAsciiHead: /^[a-z]/i.test(compact),
      isAsciiTail: /[a-z]$/i.test(compact),
    });
  }
  out.sort((a, b) => b.compact.length - a.compact.length);
  return out;
}

/**
 * 尝试从 text[pos] 处按词条匹配一个配置唤醒词（允许词条内部出现被 ASR 插入的逗号/空格，如 `嘿，Neo` 匹配 `嘿Neo`）。
 */
function matchWakeEntryAt(
  textLower: string,
  pos: number,
  entry: NormalizedWakeEntry,
): number {
  if (entry.isAsciiHead && pos > 0 && /[a-z]/.test(textLower[pos - 1]!)) {
    return -1;
  }
  let ti = pos;
  let ei = 0;
  while (ei < entry.compact.length && ti < textLower.length) {
    const ch = textLower[ti]!;
    if (ch === entry.compact[ei]) {
      ti += 1;
      ei += 1;
      continue;
    }
    // 仅在已匹配至少 1 个字符后，容忍 ASR 在中英或词内插入的标点/空白（如“嘿，Neo” / “嘿 Neo”）
    if (ei > 0 && /[\s,，。．.、!！?？:：;；\-—~～]/.test(ch)) {
      ti += 1;
      continue;
    }
    return -1;
  }
  if (ei < entry.compact.length) {
    return -1;
  }
  if (entry.isAsciiTail && ti < textLower.length && /[a-z]/.test(textLower[ti]!)) {
    return -1;
  }
  return ti;
}

/**
 * 判断转写文本是否属于唤醒词/热词列表拼接回显幻觉：
 * - 整句剥离标点空白后完全由 >= 2 个不同词干的配置唤醒词组成（如 `嘿Neo 尼奥 鸟 嘿6 Neo`、`尼奥 鸟 嘿6`、`Neo 小派`）；
 * - 或句中任意位置出现连续 >= 3 个不同词干的配置唤醒词串（如 `你好呀，Neo 尼奥 鸟 嘿6 Neo。`）。
 *
 * 单个唤醒词（如 `Neo` / `嘿Neo`）或同一唤醒词重复（如 `嘿Neo，Neo`）返回 false，不误杀正常唤醒。
 */
export function isWakeWordPromptHallucination(
  rawText: string,
  wakeWords: readonly string[],
): boolean {
  const trimmed = rawText.trim();
  if (!trimmed || wakeWords.length < 2) return false;

  const entries = compileWakeEntries(wakeWords);
  if (entries.length < 2) return false;

  const textLower = trimmed.toLowerCase();
  const allDistinctStems = new Set<string>();
  let unmatchedChars = 0;
  let runStems = new Set<string>();
  let maxContiguousDistinctStems = 0;

  let i = 0;
  while (i < textLower.length) {
    const sepMatch = SEP_CHAR_RE.exec(textLower.slice(i));
    if (sepMatch) {
      i += sepMatch[0].length;
      continue;
    }

    let matchedEntry: NormalizedWakeEntry | null = null;
    let nextPos = -1;
    for (const entry of entries) {
      const end = matchWakeEntryAt(textLower, i, entry);
      if (end > i) {
        matchedEntry = entry;
        nextPos = end;
        break;
      }
    }

    if (matchedEntry && nextPos > i) {
      allDistinctStems.add(matchedEntry.stem);
      runStems.add(matchedEntry.stem);
      if (runStems.size > maxContiguousDistinctStems) {
        maxContiguousDistinctStems = runStems.size;
      }
      i = nextPos;
      continue;
    }

    // 允许独立呼唤词（如“嘿，”）作为唤醒词前导粘连词，前提是其后紧接一个已配置的唤醒词
    const vocMatch = VOCATIVE_GLUE_RE.exec(textLower.slice(i));
    if (vocMatch) {
      let probe = i + vocMatch[0].length;
      const probeSep = SEP_CHAR_RE.exec(textLower.slice(probe));
      if (probeSep) probe += probeSep[0].length;
      const followedByWake = entries.some((entry) => matchWakeEntryAt(textLower, probe, entry) > probe);
      if (followedByWake) {
        i = probe;
        continue;
      }
    }

    // 未命中唤醒词：记录有效字符并断开连续唤醒词串
    if (/[\p{L}\p{N}]/u.test(textLower[i]!)) {
      unmatchedChars += 1;
      runStems = new Set<string>();
    }
    i += 1;
  }

  // 规则 1：整句完全由 >= 2 个不同配置唤醒词拼接而成（无任何其他实质语义）
  if (unmatchedChars === 0 && allDistinctStems.size >= 2) {
    return true;
  }

  // 规则 2：句中存在连续 >= 3 个不同配置唤醒词串（典型 Prompt 上下文泄露尾巴）
  if (maxContiguousDistinctStems >= 3) {
    return true;
  }

  return false;
}

/**
 * 判断转写文本是否为经典静音字幕幻觉、纯非语音标签或自回归重复解码环。
 */
export function isKnownAsrSilenceHallucination(rawText: string): boolean {
  const trimmed = rawText.trim();
  if (!trimmed) return false;

  // 1. 剥离 [Music] / (Silence) 等纯非语音标签后无任何有效字符
  const withoutTags = trimmed.replace(NON_SPEECH_BRACKET_TAG_RE, " ").trim();
  const meaningful = withoutTags.match(MEANINGFUL_CHAR_RE) ?? [];
  if (meaningful.length === 0) {
    return true;
  }

  const normalizedSentence = withoutTags.replace(EDGE_SEP_RE, "").replace(/\s+/g, " ").trim();
  const compactZh = normalizedSentence.replace(/[\s,，。．.、!！?？:：;；\-—~～"'“”‘’]+/g, "");

  // 2. 经典视频字幕 / 播报静音幻觉（整句锚定）
  if (
    KNOWN_ZH_SUBTITLE_HALLUCINATION_RE.test(compactZh) ||
    KNOWN_EN_SUBTITLE_HALLUCINATION_RE.test(normalizedSentence) ||
    KNOWN_CJK_BROADCAST_HALLUCINATION_RE.test(normalizedSentence)
  ) {
    return true;
  }

  // 3. 自回归单字无限重复（>= 6 次相同非数字字符）
  if (DEGENERATE_CHAR_REPEAT_RE.test(compactZh)) {
    return true;
  }

  // 4. 整句由同一短词/短语重复 >= 4 次构成（排除纯数字串）
  const tokens = normalizedSentence
    .toLowerCase()
    .split(/[\s,，。．.、!！?？:：;；]+/)
    .filter(Boolean);
  if (tokens.length >= 4) {
    const first = tokens[0]!;
    if (!/^\d+$/.test(first) && first.length <= 8 && tokens.every((t) => t === first)) {
      return true;
    }
  }
  if (compactZh.length >= 8 && !/^\d+$/.test(compactZh)) {
    for (let unitLen = 1; unitLen <= 4; unitLen += 1) {
      if (compactZh.length % unitLen !== 0) continue;
      const repeats = compactZh.length / unitLen;
      if (repeats < 4) continue;
      const unit = compactZh.slice(0, unitLen);
      if (unit.repeat(repeats) === compactZh) {
        return true;
      }
    }
  }

  return false;
}

/**
 * 综合判定一段 ASR 转写文本是否为静音/热词回显幻觉。
 */
export function isAsrHallucinationText(
  rawText: string,
  wakeWords: readonly string[] = [],
): boolean {
  if (!rawText || !rawText.trim()) return false;
  if (isKnownAsrSilenceHallucination(rawText)) return true;
  if (wakeWords.length > 0 && isWakeWordPromptHallucination(rawText, wakeWords)) return true;
  return false;
}

/**
 * 清洗 ASR 转写输出：若命中静音幻觉或热词回显幻觉则返回空字符串，否则返回去首尾空白的原文本。
 */
export function sanitizeAsrTranscript(
  rawText: string,
  options: { wakeWords?: readonly string[] } = {},
): string {
  const trimmed = String(rawText ?? "").trim();
  if (!trimmed) return "";
  if (isAsrHallucinationText(trimmed, options.wakeWords ?? [])) {
    return "";
  }
  return trimmed;
}

/**
 * 当用户连续重复呼唤同一唤醒词（如 `Neo，Neo` / `嘿Neo，Neo`）时，剥离尾部重复的同词干唤醒词，
 * 避免把第二个 `Neo` 当成设备指令下发给 Pi Agent。
 */
export function stripRepeatedLeadingWakeWords(
  afterText: string,
  matchedWakeWord: string,
  wakeWords: readonly string[],
): string {
  let remaining = afterText.trim();
  if (!remaining) return "";
  const targetStem = normalizeWakeStem(matchedWakeWord);
  if (!targetStem) return remaining;

  const sameStemEntries = compileWakeEntries([matchedWakeWord, ...wakeWords]).filter(
    (entry) => entry.stem === targetStem,
  );
  if (sameStemEntries.length === 0) return remaining;

  let changed = true;
  while (changed && remaining.length > 0) {
    changed = false;
    const cleanedLead = remaining.replace(/^[\s,，。．.、!！?？:：;；\-—~～]+/, "");
    const lower = cleanedLead.toLowerCase();
    for (const entry of sameStemEntries) {
      const end = matchWakeEntryAt(lower, 0, entry);
      if (end > 0) {
        remaining = cleanedLead
          .slice(end)
          .replace(/^[\s,，。．.、!！?？:：;；\-—~～]+/, "")
          .trim();
        changed = true;
        break;
      }
    }
  }
  return remaining;
}
