// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * Caveman 极简回复策略与确定性后处理（参考 juliusbrussee/caveman v4.2.0）。
 *
 * 目标：
 * 1. 为云端 / 本地大模型注入紧凑、双语安全（ZH/EN）的回复风格约束（<= 210 tokens）；
 * 2. 提供 <0.2ms 同步确定性后处理器，剔除客套开场白与收尾寒暄、清理语音播报禁用符号；
 * 3. 通过硬性数据完整性护栏（preservesCriticalTokens）保证数字/单位与关键否定词零丢失；
 * 4. 在错误、确认与安全警告场景自动启用 Auto-Clarity 回退为完整清晰语句。
 */

import {
  DEFAULT_CAVEMAN_MODE,
  normalizeCavemanMode,
  type CavemanReplyMode,
} from "../core/agentConfigStore.ts";

export { DEFAULT_CAVEMAN_MODE, normalizeCavemanMode, type CavemanReplyMode };

export const SILENT_REPLY_SENTINEL = "[SILENT]";

export interface CavemanPromptOptions {
  isVoice?: boolean;
  speakerName?: string | null;
  speakerRole?: "owner" | "member" | null;
}

export interface CavemanCompressOptions {
  isError?: boolean;
  preserveEmptyFiller?: boolean;
}

export interface CavemanSpeakChunkState {
  emittedAny: boolean;
}

// ---------------------------------------------------------------------------
// 预编译正则表达式（确保同步后处理 <0.2ms 且无回溯风险）
// ---------------------------------------------------------------------------

const RE_SILENT_WRAPPER = /^[\s"'`“”‘’「」()（）【】]*\[SILENT\][\s"'`“”‘’「」()（）【】.。!！?？]*$/i;

// Auto-Clarity 安全 / 确认 / 风险警告短语检测
const RE_AUTO_CLARITY_ZH =
  /(?:请先?确认|二次确认|确定要|是否继续|危险|警告|不可逆|安全提示|高风险|风险提示|注意安全|API\s*Key|尚未登录|扫码登录|网络不可用|权限不足)/i;
const RE_AUTO_CLARITY_EN =
  /\b(?:please\s+confirm|confirmation\s+required|are\s+you\s+sure|warning|caution|danger|irreversible|destructive|safety\s+warning|proceed\?)\b/i;

// Fenced code blocks (used only when !isVoice)
const RE_FENCED_CODE = /```[\s\S]*?```/g;

// TTS 语音清洗正则
const RE_INTERNAL_ID_TAG = /\s*\[(?:did|id)=[^\]]*\]/gi;
const RE_MD_FENCE_OPEN = /```[a-zA-Z0-9_-]*\r?\n?/g;
const RE_MD_IMAGE = /!\[([^\]]*)\]\([^)]*\)/g;
const RE_MD_LINK = /\[([^\]]+)\]\([^)]*\)/g;
const RE_MD_HEADING = /^[ \t]*#{1,6}[ \t]+/gm;
const RE_MD_BLOCKQUOTE = /^[ \t]*>[ \t]?/gm;
const RE_MD_LIST_PREFIX = /^[ \t]*(?:[-*•·▪▸►]+|\d+[.)、])[ \t]+/gm;
const RE_MD_BOLD_STAR = /\*\*([^*\n]+?)\*\*/g;
const RE_MD_BOLD_UNDER = /__([^_\n]+?)__/g;
const RE_MD_STRIKE = /~~([^~\n]+?)~~/g;
const RE_MD_ITALIC_STAR = /\*([^*\n]+?)\*/g;
const RE_MD_ITALIC_UNDER = /(^|[\s(（[「])_([^_\n]+?)_(?=$|[\s.,!?;:，。！？；：)）\]」])/gm;
const RE_MD_INLINE_CODE = /`([^`\n]+?)`/g;
const RE_CJK_CORNER_BRACKETS = /[「」『』]/g;
const RE_ARROWS = /\s*(?:->|=>|→|➜|➔)\s*/g;
const RE_DECORATIVE_EMOJI = /[\p{Extended_Pictographic}\uFE0E\uFE0F\u200D\u20E3]/gu;

// 客套开场白（ZH / EN）
const ZH_OPENER_PATTERNS: readonly RegExp[] = [
  /^(?:好的|好哒|好嘞|好的呢|好呀|没问题|当然|当然可以|明白|收到|了解|太好了|太棒了|非常乐意|很乐意|很高兴为您服务|不客气|客气了|您好|你好|嗨|哈喽|嘿)[，,！!。.\s~～]+/,
  /^(?:根据|按照)(?:您的|你的)?(?:要求|指令|指示|需求|查询(?:结果)?)[，,：:\s]+/,
  /^(?:为您|为你)?(?:查询|查看|执行|操作)结果(?:如下)?[：:，,\s]+/,
  /^(?:我)?(?:已经|已)?(?:为您|为你|帮您|帮你)(?:查询到|查到|查询了|查看了|获取到|读取到|确认到|检查到)[：:，,\s]*/,
];

const EN_OPENER_PATTERNS: readonly RegExp[] = [
  /^(?:sure|of course|certainly|absolutely|got it|no problem|alright|all right|okay|ok|great|awesome|hello|hi|hey)[!.,:\s]+/i,
  /^(?:i(?:'d| would) be (?:happy|glad|delighted) to(?:\s+help(?:\s+you)?(?:\s+with\s+that)?)?|happy to help|glad to help)[!.,:\s]*/i,
  /^(?:i(?:'ve| have) gone ahead and|i went ahead and|i(?:'ve| have) just|i have successfully|i've successfully)\s+/i,
  /^(?:here(?:'s| is) (?:what i found|the (?:status|result|update|info)))[:—–\-\s]+/i,
];

// 客套收尾语（ZH / EN）
const ZH_CLOSER_PATTERNS: readonly RegExp[] = [
  /(?:[，,。！!；;\s]+|^)(?:请问)?(?:您|你)?还有(?:什么|其他|别的)(?:需要|可以|能)?(?:帮您|帮你|为您|为你|协助(?:您|你)?)?(?:做|处理|控制)?的(?:地方|问题)?吗[？?！!。~\s]*$/,
  /(?:[，,。！!；;\s]+|^)(?:如果|若)(?:您|你)?(?:还)?有(?:什么|其他|任何)(?:需要|问题|需求)[，,\s]*(?:请)?(?:随时)?(?:告诉我|叫我|喊我|联系我|吩咐)[。！!~\s]*$/,
  /(?:[，,。！!；;\s]+|^)(?:还)?需要(?:我)?(?:再)?帮(?:您|你)(?:做|处理|控制)?(?:什么|点什么|别的)吗[？?！!。~\s]*$/,
  /(?:[，,。！!；;\s]+|^)祝(?:您|你)(?:使用|生活|今天|今晚)?(?:愉快|开心|顺利|好梦|晚安|安好)[。！!~\s]*$/,
  /(?:[，,。！!；;\s]+|^)(?:希望(?:这)?(?:能)?帮到(?:您|你)|很高兴(?:能)?帮到(?:您|你)|随时为您服务|随时为你服务|有需要随时叫我)[。！!~\s]*$/,
];

const EN_CLOSER_PATTERNS: readonly RegExp[] = [
  /(?:[.!?,;\s]+|^)(?:please\s+)?let me know if (?:you need|there(?:'s| is)) anything else[.!?\s]*$/i,
  /(?:[.!?,;\s]+|^)(?:is there\s+)?anything else(?:\s+i can (?:help|do|assist)(?:\s+you)?(?:\s+with)?)?[?!.\s]*$/i,
  /(?:[.!?,;\s]+|^)(?:feel free to ask|just let me know|happy to help|hope that helps|have a (?:great|nice|good) (?:day|evening|night))[.!?\s]*$/i,
];

// 流式纯客套分句判定
const RE_PURE_OPENER_ZH =
  /^(?:好的|好哒|好嘞|好的呢|好呀|没问题|当然|当然可以|明白|收到|了解|太好了|太棒了|非常乐意|很乐意|很高兴为您服务|不客气|客气了)[，,！!。.\s~～]*$/;
const RE_PURE_OPENER_EN =
  /^(?:sure|of course|certainly|absolutely|got it|no problem|alright|all right|okay|ok|happy to help|glad to help|i(?:'d| would) be (?:happy|glad) to help(?:\s+you)?)[!.,\s]*$/i;

const RE_PURE_CLOSER_ZH =
  /^(?:请问)?(?:您|你)?(?:还有(?:什么|其他|别的)(?:需要|可以|能)?(?:帮您|帮你|为您|为你|协助(?:您|你)?)?(?:做|处理|控制)?的(?:地方|问题)?吗|(?:如果|若)(?:您|你)?(?:还)?有(?:什么|其他|任何)(?:需要|问题|需求)[，,\s]*(?:请)?(?:随时)?(?:告诉我|叫我|喊我|联系我|吩咐)|(?:还)?需要(?:我)?(?:再)?帮(?:您|你)(?:做|处理|控制)?(?:什么|点什么|别的)吗|祝(?:您|你)(?:使用|生活|今天|今晚)?(?:愉快|开心|顺利|好梦|晚安|安好)|希望(?:这)?(?:能)?帮到(?:您|你)|很高兴(?:能)?帮到(?:您|你)|随时为您服务|随时为你服务|有需要随时叫我)[？?！!。~\s]*$/;
const RE_PURE_CLOSER_EN =
  /^(?:(?:please\s+)?let me know if (?:you need|there(?:'s| is)) anything else|(?:is there\s+)?anything else(?:\s+i can (?:help|do|assist)(?:\s+you)?(?:\s+with)?)?|feel free to ask|just let me know|happy to help|hope that helps|have a (?:great|nice|good) (?:day|evening|night))[?!.\s]*$/i;

// 数据完整性护栏：数字+单位 与 关键操作否定词
const RE_NUMBER_UNIT_TOKEN =
  /(?:#[0-9a-f]{6}\b|-?\d+(?:\.\d+)?(?:\s*(?:%|°[CF]|℃|K\b|份|台|个|度|分钟|小时|秒))?)/gi;

const CRITICAL_ZH_NEGATIONS: readonly string[] = [
  "离线",
  "失败",
  "未找到",
  "不支持",
  "无法",
  "不能",
  "关闭",
  "未连接",
  "不可用",
  "出错",
  "错误",
  "异常",
  "无效",
  "超时",
];

const RE_CRITICAL_EN_NEGATIONS =
  /\b(?:offline|failed|not\s+found|cannot|can't|couldn't|unable|error|off|not|never|isn't|aren't|doesn't|didn't|won't)\b/gi;

const RE_HAS_CJK = /[\u4e00-\u9fff]/;

// ---------------------------------------------------------------------------
// 公开 API
// ---------------------------------------------------------------------------

/**
 * 判断文本是否为环境旁白静默哨兵 `[SILENT]`。
 */
export function isSilentSentinel(text: string): boolean {
  if (!text) return false;
  return RE_SILENT_WRAPPER.test(text.trim());
}

/**
 * 构建紧凑（<= 210 tokens）、双语安全的 Caveman 回复风格系统提示块。
 */
export function buildCavemanPromptBlock(
  mode: CavemanReplyMode,
  options: CavemanPromptOptions = {},
): string {
  const effectiveMode = normalizeCavemanMode(mode, DEFAULT_CAVEMAN_MODE);
  const lines: string[] = [];

  switch (effectiveMode) {
    case "ultra":
      lines.push(
        "Reply Style [caveman:ultra]: Match user language (ZH/EN). Telegraphic fragments only; drop copulas, articles, ceremony, closers. <=12 ZH chars / <=10 EN words.",
      );
      lines.push(
        "Ex: 客厅灯已开，亮度80% / 卧室 23.6°C，湿度 54% / Living room light on, 80%.",
      );
      break;
    case "full":
      lines.push(
        "Reply Style [caveman:full]: Match user language (ZH/EN). Answer first; zero ceremony, closers, or tool chatter. <=20 ZH chars / <=15 EN words.",
      );
      lines.push(
        "Ex: 客厅吸顶灯已开，亮度80%。 / 卧室灯离线，无法打开。 / Bedroom: 23.6°C, humidity 54%.",
      );
      break;
    case "lite":
      lines.push(
        "Reply Style [caveman:lite]: Match user language (ZH/EN). Complete natural sentences; zero filler, flattery, or closers.",
      );
      lines.push(
        "Ex: 已打开客厅吸顶灯，亮度调至80%。 / Turned on living room light at 80%.",
      );
      break;
    case "off":
      lines.push(
        "Reply Style [normal]: Match user language (ZH/EN). Concise, natural baseline (1-2 sentences).",
      );
      break;
  }

  lines.push(
    "Rules: NEVER drop negations (不/没/未/无法/离线/失败/not/never/no/only). NEVER alter exact numbers, units, or device names. NEVER output internal did/id. Auto-Clarity: use clear full sentences for errors, confirmations, or safety warnings.",
  );

  if (options.isVoice) {
    const speakerPart = options.speakerName?.trim()
      ? ` Speaker: ${options.speakerName.trim()}${options.speakerRole === "owner" ? " (owner)" : ""}.`
      : "";
    lines.push(
      `Voice: Plain speech only—no Markdown, emoji, or bullets.${speakerPart} If pure ambient side-talk not addressed to you, call no tools and output only ${SILENT_REPLY_SENTINEL}.`,
    );
  }

  return lines.join("\n");
}

/**
 * 清洗文本使其适合实时 TTS 语音播报：
 * 去除 `[did=...]`/`[id=...]`、Markdown 语法、`「」`、箭头、装饰性 emoji、列表前缀，
 * 并平滑合并多行同时保留结构逗号与小数点。
 */
export function sanitizeForVoiceTts(text: string): string {
  if (!text) return "";
  if (isSilentSentinel(text)) return SILENT_REPLY_SENTINEL;

  let out = text
    .replace(RE_INTERNAL_ID_TAG, "")
    .replace(RE_MD_FENCE_OPEN, "")
    .replace(/```/g, "")
    .replace(RE_MD_IMAGE, "$1")
    .replace(RE_MD_LINK, "$1")
    .replace(RE_MD_HEADING, "")
    .replace(RE_MD_BLOCKQUOTE, "")
    .replace(RE_MD_LIST_PREFIX, "")
    .replace(RE_MD_BOLD_STAR, "$1")
    .replace(RE_MD_BOLD_UNDER, "$1")
    .replace(RE_MD_STRIKE, "$1")
    .replace(RE_MD_ITALIC_STAR, "$1")
    .replace(RE_MD_ITALIC_UNDER, "$1$2")
    .replace(RE_MD_INLINE_CODE, "$1")
    .replace(RE_CJK_CORNER_BRACKETS, "")
    .replace(RE_ARROWS, "，")
    .replace(RE_DECORATIVE_EMOJI, "");

  const rawLines = out
    .split(/\r?\n+/)
    .map((line) => line.replace(/[ \t]{2,}/g, " ").trim())
    .filter((line) => line.length > 0);

  if (rawLines.length === 0) {
    return "";
  }

  let joined = rawLines[0]!;
  for (let i = 1; i < rawLines.length; i += 1) {
    const next = rawLines[i]!;
    if (/[。！？!?;；,，:：]$/.test(joined)) {
      const needsSpace = !RE_HAS_CJK.test(joined.slice(-1)) && !RE_HAS_CJK.test(next[0] ?? "");
      joined += needsSpace ? ` ${next}` : next;
    } else {
      const useZhComma = RE_HAS_CJK.test(joined) || RE_HAS_CJK.test(next);
      joined += useZhComma ? `，${next}` : `, ${next}`;
    }
  }

  return normalizePunctuationAndSpacing(joined);
}

/**
 * 校验压缩后的文本是否完整保留了原文本中的全部数字/单位与关键操作否定词。
 */
export function preservesCriticalTokens(original: string, compressed: string): boolean {
  const origNorm = normalizeTokensSurface(original);
  const compNorm = normalizeTokensSurface(compressed);

  // 1. 数字 + 单位（含 #RRGGBB）数量严格不减
  const origNumCounts = countMatches(origNorm, RE_NUMBER_UNIT_TOKEN);
  if (origNumCounts.size > 0) {
    const compNumCounts = countMatches(compNorm, RE_NUMBER_UNIT_TOKEN);
    for (const [tok, count] of origNumCounts) {
      if ((compNumCounts.get(tok) ?? 0) < count) {
        return false;
      }
    }
  }

  // 2. 中文关键操作否定/异常词严格保留
  for (const kw of CRITICAL_ZH_NEGATIONS) {
    const origCount = countSubstring(original, kw);
    if (origCount > 0 && countSubstring(compressed, kw) < origCount) {
      return false;
    }
  }

  // 3. 英文关键操作否定/异常词严格保留
  const origEnNeg = countMatches(original, RE_CRITICAL_EN_NEGATIONS, (m) =>
    m.toLowerCase().replace(/\s+/g, " "),
  );
  if (origEnNeg.size > 0) {
    const compEnNeg = countMatches(compressed, RE_CRITICAL_EN_NEGATIONS, (m) =>
      m.toLowerCase().replace(/\s+/g, " "),
    );
    for (const [tok, count] of origEnNeg) {
      if ((compEnNeg.get(tok) ?? 0) < count) {
        return false;
      }
    }
  }

  return true;
}

/**
 * 确定性、低延迟（<0.2ms）Caveman 回复后处理器。
 */
export function compressCavemanReply(
  text: string,
  mode: CavemanReplyMode,
  isVoice: boolean,
  options: CavemanCompressOptions = {},
): string {
  const raw = text ?? "";
  if (!raw.trim()) return "";
  if (isSilentSentinel(raw)) return SILENT_REPLY_SENTINEL;

  const effectiveMode = normalizeCavemanMode(mode, DEFAULT_CAVEMAN_MODE);
  const baseText = isVoice ? sanitizeForVoiceTts(raw) : raw.trim();
  if (!baseText) return "";

  // Auto-Clarity / error / off 模式：旁路压缩（语音模式仍做 TTS 清洗）
  if (effectiveMode === "off" || options.isError || isAutoClarityText(baseText)) {
    return baseText;
  }

  // 非语音模式保护 fenced code blocks 原样不被改动
  const codeBlocks: string[] = [];
  let working = isVoice
    ? baseText
    : baseText.replace(RE_FENCED_CODE, (match) => {
        const idx = codeBlocks.length;
        codeBlocks.push(match);
        return `\uE000CF${idx}\uE001`;
      });

  // 1. 剥离客套开场白与收尾语（lite / full / ultra 均执行）
  working = stripOpeners(working);
  working = stripClosers(working);

  // 2. 处理常见中文客套动词前缀（“我已经为您打开了...” / “已为你把...”）
  working = tightenPoliteVerbPrefixes(working, effectiveMode);

  // 3. full / ultra 模式进一步精简冗余表达
  if (effectiveMode === "full" || effectiveMode === "ultra") {
    working = tightenFullPhrasing(working);
  }
  if (effectiveMode === "ultra") {
    working = tightenUltraPhrasing(working);
  }

  // 4. 清理标点与空白，并恢复受保护的代码块
  working = normalizePunctuationAndSpacing(working);
  if (codeBlocks.length > 0) {
    working = working.replace(/\uE000CF(\d+)\uE001/g, (_m, idxStr: string) => {
      return codeBlocks[Number(idxStr)] ?? "";
    });
  }

  // 若全部是纯客套且被剥空：默认保留原文本，仅在 preserveEmptyFiller === false 时返回空串
  const preserveEmptyFiller = options.preserveEmptyFiller ?? true;
  if (!working) {
    return preserveEmptyFiller ? baseText : "";
  }

  // 硬性数据完整性护栏：校验所有数字/单位与操作否定词原样存活，否则安全回退
  if (!preservesCriticalTokens(baseText, working)) {
    return baseText;
  }

  return working;
}

/**
 * 流式语音播报分句过滤器：
 * - 抑制 `[SILENT]`
 * - 尚未播报任何实质内容时抑制独立客套开场分句（“好的！”、“Sure!”）
 * - 抑制独立客套收尾分句（“还有什么需要帮您的吗？”）
 * - 对实质内容执行语音清洗与 Caveman 压缩并保护小数/否定词
 */
export function compressCavemanSpeakChunk(
  chunk: string,
  mode: CavemanReplyMode,
  state: CavemanSpeakChunkState,
): string {
  const raw = chunk ?? "";
  if (!raw.trim()) return "";
  if (isSilentSentinel(raw)) return "";

  const effectiveMode = normalizeCavemanMode(mode, DEFAULT_CAVEMAN_MODE);
  const cleaned = sanitizeForVoiceTts(raw);
  if (!cleaned || isSilentSentinel(cleaned)) return "";

  if (effectiveMode === "off") {
    state.emittedAny = true;
    return cleaned;
  }

  if (!state.emittedAny && isPureOpenerChunk(cleaned)) {
    return "";
  }

  if (isPureCloserChunk(cleaned)) {
    return "";
  }

  const compressed = compressCavemanReply(cleaned, effectiveMode, true, {
    preserveEmptyFiller: state.emittedAny,
  });

  if (!compressed || isSilentSentinel(compressed)) {
    return "";
  }

  state.emittedAny = true;
  return compressed;
}

/**
 * 生成唤醒应答语（绝不使用 1 字“在”，避免蓝牙/USB 音频起播 100ms 截断）。
 */
export function formatWakeAck(mode: CavemanReplyMode, speakerName?: string | null): string {
  const effectiveMode = normalizeCavemanMode(mode, DEFAULT_CAVEMAN_MODE);
  const speaker = speakerName?.trim() ?? "";
  let base: string;
  switch (effectiveMode) {
    case "ultra":
    case "full":
      base = "在呢";
      break;
    case "lite":
      base = "我在，请说";
      break;
    case "off":
      base = "我在，请说指令";
      break;
  }
  return speaker ? `${speaker}，${base}` : base;
}

/**
 * 生成退出连续对话 / 回到待机的极简提示语。
 */
export function formatExitConversationAck(mode: CavemanReplyMode): string {
  const effectiveMode = normalizeCavemanMode(mode, DEFAULT_CAVEMAN_MODE);
  return effectiveMode === "off" ? "好的，已回到待机" : "已待机";
}

// ---------------------------------------------------------------------------
// 内部辅助函数
// ---------------------------------------------------------------------------

function isAutoClarityText(text: string): boolean {
  return RE_AUTO_CLARITY_ZH.test(text) || RE_AUTO_CLARITY_EN.test(text);
}

function isPureOpenerChunk(text: string): boolean {
  const trimmed = text.trim();
  return RE_PURE_OPENER_ZH.test(trimmed) || RE_PURE_OPENER_EN.test(trimmed);
}

function isPureCloserChunk(text: string): boolean {
  const trimmed = text.trim();
  return RE_PURE_CLOSER_ZH.test(trimmed) || RE_PURE_CLOSER_EN.test(trimmed);
}

function stripOpeners(input: string): string {
  let out = input.trim();
  for (let pass = 0; pass < 4; pass += 1) {
    const before = out;
    for (const re of ZH_OPENER_PATTERNS) {
      out = out.replace(re, "").trim();
    }
    for (const re of EN_OPENER_PATTERNS) {
      out = out.replace(re, "").trim();
    }
    if (out === before) break;
  }
  return out;
}

function stripClosers(input: string): string {
  let out = input.trim();
  for (let pass = 0; pass < 3; pass += 1) {
    const before = out;
    for (const re of ZH_CLOSER_PATTERNS) {
      out = out.replace(re, "").trim();
    }
    for (const re of EN_CLOSER_PATTERNS) {
      out = out.replace(re, "").trim();
    }
    if (out === before) break;
  }
  return out;
}

function tightenPoliteVerbPrefixes(input: string, mode: CavemanReplyMode): string {
  let out = input;

  // “我已经为您把...” / “已为你将...”
  if (mode === "lite") {
    out = out.replace(/^(?:我)?(?:已经|已)(?:为您|为你|帮您|帮你)(把|将)/, "已$1");
    out = out.replace(/^(?:我)?(?:已经|已)(?:为您|为你|帮您|帮你)(?!把|将)/, "已");
  } else {
    out = out.replace(/^(?:我)?(?:已经|已)?(?:为您|为你|帮您|帮你)(?:把|将)/, "");
    out = out.replace(/^(?:我)?(?:已经|已)(?:为您|为你|帮您|帮你)(?!把|将)/, "已");
    out = out.replace(/^已(?:经)?(?:把|将)/, "");
  }

  // 去除“已打开了”中的冗余“了”
  out = out.replace(/已(打开|关闭|开启|调[整节至到暗亮高低]|设[置定]|执行|切换|静音|暂停|停止|播放|播报|出粮|发送)了/g, "已$1");
  out = out.replace(/已已/g, "已");

  // 英文句首剥掉 “I've gone ahead and ” 后首字母大写
  if (/^[a-z]/.test(out)) {
    out = out[0]!.toUpperCase() + out.slice(1);
  }

  return out;
}

function tightenFullPhrasing(input: string): string {
  let out = input;

  // 中文常见冗长表述精简（不触碰任何否定词）
  out = out
    .replace(RE_CJK_CORNER_BRACKETS, "")
    .replace(/^(?:抱歉|不好意思|对不起)[，,！!\s]+/, "")
    .replace(/(?<!无法|不能|未能|没能|不可)(?:为您|为你|帮您|帮你)/g, "")
    .replace(/(?:已经)?成功(?:地)?/g, "已")
    .replace(/已已/g, "已")
    .replace(/，并将/g, "，")
    .replace(/，并且将/g, "，")
    .replace(/，并把/g, "，")
    .replace(/([^，,。；;\n]{1,22}?)(打开|开启|关闭)了(?=[，,。；;\n]|$)/g, "$1已$2")
    .replace(/已已/g, "已")
    .replace(/当前离线/g, "离线")
    .replace(/当前(温度|湿度|亮度|色温|音量|电量)(?:为|是)\s*/g, "$1 ")
    .replace(/(温度|湿度|亮度|色温|音量|电量)(?:为|是)\s*(?=-?\d)/g, "$1 ")
    .replace(/已将/g, "")
    .replace(/已把/g, "");

  // 英文精简
  out = out
    .replace(
      /^(?:I(?:'ve| have)\s+)?(?:successfully\s+)?(?=(?:turned|switched|set|adjusted|dimmed|brightened|muted|unmuted|paused|resumed|started|stopped|executed|ran|sent|checked|found|opened|closed|dispensed)\b)/i,
      "",
    )
    .replace(/\bsuccessfully\s+/gi, "")
    .replace(/\bhas been\s+(?=[a-z]+)/gi, "")
    .replace(/\bhave been\s+(?=[a-z]+)/gi, "");

  if (/^[a-z]/.test(out)) {
    out = out[0]!.toUpperCase() + out.slice(1);
  }

  return out;
}

function tightenUltraPhrasing(input: string): string {
  let out = input;

  // 中文极简（保留“关闭”等所有否定词原样不动）
  out = out
    .replace(/已打开/g, "已开")
    .replace(/已开启/g, "已开")
    .replace(/([\u4e00-\u9fffA-Za-z0-9])的(亮度|色温|音量|温度|湿度|电量|颜色)/g, "$1$2")
    .replace(/当前离线/g, "离线");

  // 英文电报体精简
  out = out
    .replace(/^(?:The|A|An)\s+/i, "")
    .replace(/\bis\s+now\s+/gi, "");

  if (/^[a-z]/.test(out)) {
    out = out[0]!.toUpperCase() + out.slice(1);
  }

  // 单句超短电报体去掉末尾句号
  if (out.length <= 24 && !/[！？!?]/.test(out) && out.endsWith("。")) {
    out = out.slice(0, -1);
  }

  return out;
}

function normalizePunctuationAndSpacing(input: string): string {
  return input
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([，。！？；：,.;!?])/g, "$1")
    .replace(/([，。！？；：])\s+(?=[\u4e00-\u9fff])/g, "$1")
    .replace(/，{2,}/g, "，")
    .replace(/,{2,}/g, ",")
    .replace(/，([。！？；])/g, "$1")
    .replace(/^[，,;；、.\s]+/, "")
    .trim();
}

function normalizeTokensSurface(text: string): string {
  return text.replace(/(-?\d+(?:\.\d+)?)\s+(%|°[CF]|℃|K\b|份|台|个|度|分钟|小时|秒)/gi, "$1$2");
}

function countMatches(
  text: string,
  pattern: RegExp,
  transform: (match: string) => string = (m) => m.toLowerCase(),
): Map<string, number> {
  const counts = new Map<string, number>();
  pattern.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) {
    const key = transform(m[0]);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (m[0].length === 0) pattern.lastIndex += 1;
  }
  pattern.lastIndex = 0;
  return counts;
}

function countSubstring(text: string, sub: string): number {
  let count = 0;
  let pos = 0;
  while ((pos = text.indexOf(sub, pos)) !== -1) {
    count += 1;
    pos += sub.length;
  }
  return count;
}
