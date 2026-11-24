// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * 唤醒词注意力机制与设备定向语音检测（DDSD: Device-Directed Speech Detection）。
 *
 * 当用户提到唤醒词或处于多轮对话窗口中时，先判断：
 * 1. 是否为自播报回声 / 纯背景音乐噪声 / 未授权声纹；
 * 2. 提到唤醒词时，是真的在呼唤/指挥助手，还是第三人称提及、转述、讨论或对他人说话；
 * 3. 未提唤醒词但处于连续对话窗口时，当前句子是在继续与助手对话，还是旁白聊天；
 * 只有确定是在与助手对话/叫助手操作时，才放行进入 Pi Agent 工具执行！
 */

import type { VoiceprintIdentifyResult } from "./voiceprintStore.ts";

export type AttentionMode = "smart" | "strict" | "off";
export type VoiceprintPolicyMode = "off" | "tag" | "strict";

export interface ConversationTurnContext {
  role: "user" | "assistant";
  text: string;
  timestamp: number;
}

export interface LlmAttentionVerdict {
  addressed: boolean;
  inConversation: boolean;
  confidence: number;
  reason: string;
  command?: string;
}

export type AttentionLlmEvaluator = (prompt: string) => Promise<string>;

export interface EvaluateAttentionInput {
  rawText: string;
  wakeWordEnabled: boolean;
  wakeWords: readonly string[];
  attentionMode: AttentionMode;
  bypassWakeWord?: boolean;
  awakeActive?: boolean;
  inConversation?: boolean;
  recentTurns?: readonly ConversationTurnContext[];
  lastSpokenReply?: string;
  lastSpokenAt?: number;
  now?: number;
  acousticEvent?: string;
  voiceprint?: VoiceprintIdentifyResult | null;
  voiceprintMode?: VoiceprintPolicyMode;
  llmEvaluator?: AttentionLlmEvaluator;
}

export interface AttentionDecision {
  accept: boolean;
  wokeOnly: boolean;
  addressed: boolean;
  inConversation: boolean;
  confidence: number;
  stage:
    | "bypass"
    | "voiceprint"
    | "acoustic"
    | "echo"
    | "fast-wake"
    | "fast-followup"
    | "pragmatic-reject"
    | "llm-attention"
    | "no-wake";
  reason: string;
  wakeWord: string | null;
  command: string;
  usedLlm: boolean;
  latencyMs: number;
}

export interface WakeSpanMatch {
  matched: boolean;
  wakeWord: string;
  matchedSurface: string;
  index: number;
  endIndex: number;
  beforeText: string;
  afterText: string;
  fuzzy: boolean;
}

const LEADING_PUNCT_RE = /^[\s,，。．.、!！?？:：;；\-—~～"“”'‘’]+/;
const TRAILING_PUNCT_RE = /[\s,，。．.、!！?？:：;；"“”'‘’]+$/;

// 中英文常见同音/音译/SenseVoice 跨语种误识别映射（显著提高自定义英文唤醒词与嘈杂环境下的唤醒召回率）
const WAKE_HOMOPHONES: Readonly<Record<string, readonly string[]>> = {
  小派: ["小湃", "小π", "小拍", "小排", "小牌", "小佩", "肖派", "晓派", "校派", "小帕", "小怕"],
  派派: ["拍拍", "湃湃"],
  米家助手: ["米家主手", "迷家助手"],
  小爱: ["小艾", "晓爱", "小矮"],
  小度: ["小杜", "小肚"],
  小智: ["小志", "小治"],
  小艺: ["小易", "小意", "小翼"],
  // 英文唤醒词常见近音/中文音译/SenseVoice auto 语种滑移（如 Neo -> 2お / ニ요 / Neil / 尼奥 / 你o）
  neo: [
    "neil",
    "neal",
    "nio",
    "niyo",
    "neio",
    "neow",
    "newo",
    "niel",
    "kneel",
    "尼奥",
    "尼欧",
    "妮奥",
    "妮欧",
    "尼哦",
    "妮哦",
    "呢哦",
    "你o",
    "你0",
    "2お",
    "ニオ",
    "ネオ",
    "にお",
    "ニ요",
    "니오",
    "네오",
  ],
  jarvis: ["贾维斯", "查维斯", "加维斯", "jarves", "jrvis"],
  nova: ["诺瓦", "诺娃", "挪瓦", "nora"],
  luna: ["露娜", "卢娜", "路娜", "lunna", "lunar"],
  friday: ["星期五", "弗莱迪"],
  echo: ["艾可", "爱科", "eko"],
};

// 仅在后面紧跟明确智能家居控制指令（或唤醒询问“在吗”）时才启用的强噪/跨语种近音兜底（防止正常聊天误触）
const NOISE_ONLY_WAKE_ALIASES: Readonly<Record<string, readonly string[]>> = {
  小派: ["小开", "小块", "小买", "小败", "小拜"],
  pi: ["heyp", "hey p", "api", "pai"],
  neo: [
    "new",
    "near",
    "leo",
    "mio",
    "nero",
    "rio",
    "hey ne",
    "hei ne",
    "妞",
    "牛",
    "纽",
    "钮",
    "你有",
    "你又",
    "里奥",
    "利奥",
    "米奥",
  ],
};

// 常见英文高频停用词：禁止在动态模糊匹配中作为单独无指令的唤醒词触发（防误唤）
const COMMON_EN_STOPWORDS = new Set<string>([
  "no",
  "not",
  "now",
  "new",
  "near",
  "one",
  "two",
  "the",
  "and",
  "you",
  "he",
  "she",
  "it",
  "we",
  "me",
  "my",
  "hi",
  "hey",
  "ok",
  "yes",
  "are",
  "is",
  "do",
  "go",
  "so",
  "to",
  "on",
  "off",
  "in",
  "out",
  "up",
  "for",
  "how",
  "who",
  "why",
  "all",
  "can",
  "get",
  "let",
  "see",
  "say",
  "set",
  "put",
  "run",
  "our",
  "his",
  "her",
  "has",
  "had",
  "was",
  "did",
  "big",
  "bad",
  "red",
  "old",
  "own",
  "way",
  "day",
  "man",
  "boy",
  "top",
  "low",
  "end",
  "car",
  "cat",
  "dog",
  "need",
  "next",
  "nice",
  "name",
  "note",
]);

// 中文模糊前缀词中，容易与家庭日常问句混淆的词（如“你有打开窗户吗？”），需屏蔽句尾疑问助词“吗/嘛/么/呢”
const AMBIGUOUS_ZH_NOISE_ALIASES = new Set<string>(["你有", "你又"]);

const WAKE_QUERY_AFTER_RE = /^(?:在吗|你在吗|在不在|你好|您好)$/i;

// 句首自然呼唤前缀（属于正向呼叫，不视为第三人称）
const VOCATIVE_PREFIX_RE =
  /^(?:喂|嘿|嗨|哎|唉|哈喽|你好|您好|那个|麻烦|请|hey|hi|ok|yo|hello|excuse\s+me)[\s,，、!！。]*$/i;

// 第三人称 / 提及 / 否定 / 元讨论信号（表明用户很可能在“聊到唤醒词”而不是在叫助手）
const REFERENTIAL_BEFORE_RE =
  /(?:提到|聊到|说到|说起|讲到|谈到|关于|听说|觉得|认为|喜欢|讨厌|记得|忘了|叫做|名叫|名字叫|取名叫|别理|别管|不用管|不要管|不是叫|没叫|没喊|谁叫|谁在叫|什么叫|演示|测试一下|介绍|对比|比一比|不如|就像|好像|跟|和|把那个|刚才那个|今天那个|昨天那个)/i;

const REFERENTIAL_AFTER_RE =
  /^(?:是(?:个|一个|什么|谁|哪个|怎么|不是|真的|挺|很)|挺|真(?:的)?(?:好用|不错|聪明|笨|差|慢|快)|好不好用|好用吗|怎么样|这个(?:软件|助手|东西|项目|名字|功能|模型)|那个(?:软件|助手|东西|项目)|它|他|她|刚才|刚刚|昨天|今天(?:好像|居然|又)|的(?:名字|功能|原理|声音|模型|效果)|会不会|能不能被|怎么老是|别理|算了|没叫你)/i;

// 明确面向智能家居/助手的祈使或询问动词（搭配句首唤醒词可安全走 0ms 快速通道）
const DIRECT_COMMAND_START_RE =
  /^(?:请|帮我|给我|麻烦|快|赶紧|顺便|现在|把|将|打开|开启|关掉|关闭|关上|开一下|关一下|调|设置|设定|设为|改成|换成|切换|播放|放一首|来一首|暂停|继续|停止|静音|取消静音|声音|音量|大一点|小一点|亮一点|暗一点|暖一点|冷一点|查|查看|查询|看看|告诉我|现在|卧室|客厅|餐厅|书房|厨房|阳台|主卧|次卧|玄关|卫生间|全屋|所有|全部|小爱|小米|灯|吸顶灯|台灯|空调|风扇|插座|开关|窗帘|喂食器|出粮|喂|场景|模式|温度|湿度|空气|turn|open|close|set|play|pause|stop|mute|check|what)/i;

export function looksLikeDirectDeviceCommand(text: string): boolean {
  return DIRECT_COMMAND_START_RE.test(text.trim());
}

export function isWakeQueryText(text: string): boolean {
  const cleaned = text.replace(LEADING_PUNCT_RE, "").replace(TRAILING_PUNCT_RE, "").trim();
  return WAKE_QUERY_AFTER_RE.test(cleaned);
}

/**
 * 剥离句首自然呼唤前缀或 SenseVoice 中英混说残留的极短碎片（如 "你好，关闭卧室灯" / "he打开卧室灯" / "vis打开客厅吸顶灯"），
 * 便于与英文句首唤醒探针结果对齐重组。
 */
export function stripLeadingVocativeOrFragment(text: string): string {
  let s = text.replace(LEADING_PUNCT_RE, "").trim();
  // 先尝试剥离自然中文呼唤前缀（如 "你好，关闭卧室灯" -> "关闭卧室灯"）
  const vocMatch =
    /^(?:喂|嘿|嗨|哎|唉|哈喽|你好|您好|那个|hey|hi|ok|yo|hello)[\s,，、!！。:：]*(.+)$/i.exec(s);
  if (vocMatch && vocMatch[1]) {
    const rest = vocMatch[1].replace(LEADING_PUNCT_RE, "").trim();
    if (rest) s = rest;
  }
  // 再剥离紧贴中文指令前的 1~4 字母残留碎片（如 "he打开卧室灯" / "vis打开客厅吸顶灯" / "n关闭卧室灯"）
  const fragMatch = /^([a-z]{1,4})[\s,，。!！?？:：、]*(?=[\u4e00-\u9fff])/i.exec(s);
  if (fragMatch) {
    const rest = s.slice(fragMatch[0].length).replace(LEADING_PUNCT_RE, "").trim();
    if (rest && (looksLikeDirectDeviceCommand(rest) || isWakeQueryText(rest))) {
      s = rest;
    }
  }
  return s.replace(TRAILING_PUNCT_RE, "").trim();
}

function phoneticSkeleton(word: string): string {
  return word
    .toLowerCase()
    .replace(/[^a-z]/g, "")
    .replace(/^kn/, "n")
    .replace(/^wr/, "r")
    .replace(/ph/g, "f")
    .replace(/ck/g, "k")
    .replace(/qu/g, "kw")
    .replace(/x/g, "ks")
    .replace(/gh/g, "")
    .replace(/(?:ee|ea|ie|ei)/g, "i")
    .replace(/(?:oo|ou|ew)/g, "u")
    .replace(/(?:eo|io|iu|eu)/g, "io")
    .replace(/(?:ae|ai|ay)/g, "e")
    .replace(/(?:oa|ow)/g, "o")
    .replace(/(.)\1+/g, "$1");
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) prev[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    for (let j = 0; j <= b.length; j += 1) prev[j] = curr[j]!;
  }
  return prev[b.length]!;
}

/**
 * 判断英文单词 token 是否与配置的自定义英文唤醒词 wake 在拼写/发音上足够接近。
 */
function isPhoneticAsciiMatch(
  tokenRaw: string,
  wakeRaw: string,
  options: { allowStopwords?: boolean } = {},
): boolean {
  const token = tokenRaw.toLowerCase().replace(/[^a-z]/g, "");
  const wake = wakeRaw.toLowerCase().replace(/[^a-z]/g, "");
  if (wake.length < 3 || token.length < 2) return false;
  if (token === wake) return true;
  if (!options.allowStopwords && COMMON_EN_STOPWORDS.has(token)) return false;
  // 永远拒绝高频否定词 "no"（防止 "No, stop" 误触 "Neo"）
  if (token === "no" || token === "not" || token === "now") return false;
  if (Math.abs(token.length - wake.length) > 2) return false;

  const skToken = phoneticSkeleton(token);
  const skWake = phoneticSkeleton(wake);
  if (skToken === skWake && skToken.length >= 2) return true;

  const rawDist = levenshtein(token, wake);
  const skDist = levenshtein(skToken, skWake);

  if (wake.length <= 4) {
    // 短英文唤醒词（如 Neo / Nova / Luna）：要求首字母一致且编辑距离或音素距离 <= 1
    if (token[0] !== wake[0]) return false;
    return rawDist <= 1 || skDist <= 1;
  }
  return rawDist <= 2 || skDist <= 1;
}

/**
 * 供本地双轨 ASR 英文句首探针（headEn）复用：判断句首短英文转写是否命中了配置的英文唤醒词。
 */
export function matchEnglishHeadWakeWord(
  headText: string,
  wakeWords: readonly string[],
  options: { allowCommandGatedAliases?: boolean } = {},
): { wakeWord: string; matchedSurface: string; fuzzy: boolean } | null {
  const cleaned = headText.trim();
  if (!cleaned) return null;

  const asciiWakes = wakeWords
    .map((w) => w.trim())
    .filter((w) => /^[a-z][a-z0-9\s-]*$/i.test(w))
    .sort((a, b) => b.length - a.length);
  if (asciiWakes.length === 0) return null;

  // 1. 精确或内置同音表匹配
  const direct = findWakeWordSpan(cleaned, asciiWakes);
  if (direct && direct.index <= 6) {
    return {
      wakeWord: direct.wakeWord,
      matchedSurface: direct.matchedSurface,
      fuzzy: direct.fuzzy,
    };
  }

  // 剥离句首常见英文呼唤词 Hey / Hi / OK
  const stripped = cleaned
    .replace(LEADING_PUNCT_RE, "")
    .replace(/^(?:hey|hi|ok|yo|hello|嘿|喂|你好)[\s,，、!！。]*/i, "")
    .trim();

  // 2. 允许命令门控近音别名（用于中文完整命令已确认时的双语句首恢复，如 headEn="Near."/"New."/"Hey Ne."）
  if (options.allowCommandGatedAliases) {
    for (const w of asciiWakes) {
      const aliases = NOISE_ONLY_WAKE_ALIASES[w] ?? NOISE_ONLY_WAKE_ALIASES[w.toLowerCase()];
      if (!aliases) continue;
      for (const alias of aliases) {
        if (!/^[a-z0-9\s]+$/i.test(alias)) continue;
        const re = new RegExp(`(?<![a-z])(${escapeRegExp(alias)})(?![a-z])`, "i");
        const m = re.exec(cleaned);
        if (m && m.index <= 6) {
          return { wakeWord: w, matchedSurface: m[1] ?? m[0], fuzzy: true };
        }
      }
    }
  }

  // 3. 通用自定义英文唤醒词动态音素/编辑距离匹配（支持任意用户自定义英文名，如 Neo / Jarvis / Luna / Milo）
  const firstTokenMatch = /^([a-z]{2,16})(?![a-z])/i.exec(stripped);
  if (firstTokenMatch && firstTokenMatch[1]) {
    const token = firstTokenMatch[1];
    for (const w of asciiWakes) {
      if (
        isPhoneticAsciiMatch(token, w, {
          allowStopwords: Boolean(options.allowCommandGatedAliases),
        })
      ) {
        return { wakeWord: w, matchedSurface: token, fuzzy: true };
      }
    }
  }

  return null;
}

/**
 * 在背景音乐（<|BGM|>）场景下，裁掉紧跟完整设备指令后面的无关歌词尾段
 * 例如：“打开客厅吸顶灯，间走过这世间” -> “打开客厅吸顶灯”。
 */
export function trimTrailingMusicLyrics(command: string): string {
  const parts = command.split(/[，,。！？!?;；]/).map((s) => s.trim()).filter(Boolean);
  if (parts.length <= 1) return command.trim();
  const kept: string[] = [parts[0]!];
  for (let i = 1; i < parts.length; i += 1) {
    const seg = parts[i]!;
    if (
      DIRECT_COMMAND_START_RE.test(seg) ||
      /(?:亮度|色温|颜色|音量|声音|静音|暂停|停止|关闭|打开|调到|调成|调大|调小|温度|湿度|出粮|份|度|%)/.test(seg)
    ) {
      kept.push(seg);
    } else {
      break;
    }
  }
  return kept.join("，").trim();
}

// 对话延续中非常明确的短指令特征
const CLEAR_FOLLOWUP_RE =
  /^(?:再|稍微|稍微再|还是|那就|帮我再|把它|把音量|把亮度|把色温|调大|调小|大一点|小一点|高一点|低一点|亮一点|暗一点|暖一点|冷一点|关了吧|关掉|打开|暂停|继续|停止|静音|取消静音|下一首|上一首|换一首|再来一份|出粮|谢谢|好的谢谢|算了|取消|不用了|退下|休息吧)/i;

// 明显是家庭/旁白聊天的负向模式
const OBVIOUS_SIDETALK_RE =
  /^(?:嗯+|啊+|哦+|呃+|哈哈+|呵呵+|晚饭|午饭|早饭|吃什么|吃饭|喝水|拿一下|递一下|我去|你去|他去|待会出去|出门|快递|外卖|睡觉了吗|几点回来|明天上班)/i;

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeForEcho(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s,，。．.、!！?？:：;；\-—~～"'“”‘’()（）[\]【】]/g, "");
}

/**
 * 计算当前识别文本与 MijiaDeck 刚刚播报的 TTS 文本的字符重叠度（用于抑制扬声器自回声）。
 */
export function computeEchoOverlap(transcript: string, lastSpoken: string): number {
  const a = normalizeForEcho(transcript);
  const b = normalizeForEcho(lastSpoken);
  if (!a || !b || a.length < 2) return 0;
  if (b.includes(a)) return 1;
  if (a.includes(b) && b.length >= 4) return b.length / a.length;

  // Bigram 重叠率
  const bigramsB = new Set<string>();
  for (let i = 0; i < b.length - 1; i += 1) {
    bigramsB.add(b.slice(i, i + 2));
  }
  if (bigramsB.size === 0) return 0;
  let hits = 0;
  const totalA = Math.max(1, a.length - 1);
  for (let i = 0; i < a.length - 1; i += 1) {
    if (bigramsB.has(a.slice(i, i + 2))) hits += 1;
  }
  return hits / totalA;
}

/**
 * 在句子中查找唤醒词（支持中英文边界保护、中英同音/音译纠错与任意自定义英文唤醒词音素模糊容错）。
 */
export function findWakeWordSpan(
  rawText: string,
  wakeWords: readonly string[],
): WakeSpanMatch | null {
  const cleaned = rawText.trim();
  if (!cleaned) return null;

  interface Candidate {
    canonical: string;
    surface: string;
    fuzzy: boolean;
  }
  const candidates: Candidate[] = [];
  const seenSurface = new Set<string>();

  const sortedCanonical = [...wakeWords]
    .map((w) => w.trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);

  for (const w of sortedCanonical) {
    const key = w.toLowerCase();
    if (!seenSurface.has(key)) {
      seenSurface.add(key);
      candidates.push({ canonical: w, surface: w, fuzzy: false });
    }
  }
  for (const w of sortedCanonical) {
    const homophones = WAKE_HOMOPHONES[w] ?? WAKE_HOMOPHONES[w.toLowerCase()];
    if (!homophones) continue;
    for (const h of homophones) {
      const key = h.toLowerCase();
      if (!seenSurface.has(key)) {
        seenSurface.add(key);
        candidates.push({ canonical: w, surface: h, fuzzy: true });
      }
    }
  }

  const runCandidateList = (
    list: readonly Candidate[],
    requireDirectCmdAfter: boolean,
  ): WakeSpanMatch | null => {
    for (const cand of list) {
      const isAscii = /^[a-z0-9\s-]+$/i.test(cand.surface);
      // 英文边界使用 (?<![a-z]) / (?![a-z])：既防止 "pi" 误匹配 "api/pizza"、"neo" 误匹配 "neon/pioneer"，
      // 又允许中英无缝混说如 "嘿Neo，打开客厅吸顶灯"、"你好Neo关灯"、"Neo打开灯"、"Neo30"！
      const pattern = isAscii
        ? new RegExp(
            `(?<![a-z])((?:hey\\s+|hi\\s+|ok\\s+)?${escapeRegExp(cand.surface)})(?![a-z])`,
            "i",
          )
        : new RegExp(`(${escapeRegExp(cand.surface)})`, "i");

      const m = pattern.exec(cleaned);
      if (!m) continue;

      const surfaceStr = m[1] ?? m[0];
      const matchStart = cleaned.toLowerCase().indexOf(surfaceStr.toLowerCase(), m.index);
      const startIdx = matchStart >= 0 ? matchStart : m.index;
      const endIdx = startIdx + surfaceStr.length;

      const beforeText = cleaned.slice(0, startIdx).replace(TRAILING_PUNCT_RE, "").trim();
      const rawAfter = cleaned
        .slice(endIdx)
        .replace(LEADING_PUNCT_RE, "")
        .replace(TRAILING_PUNCT_RE, "")
        .trim();
      const isWakeQuery = WAKE_QUERY_AFTER_RE.test(rawAfter);
      const afterText = rawAfter
        .replace(/^(?:同学|你好|您好|在吗|你在吗|在不在|请|帮我一下)?[\s,，。!！?？:：]*/i, "")
        .replace(TRAILING_PUNCT_RE, "")
        .trim();

      if (requireDirectCmdAfter) {
        const surfaceLower = cand.surface.toLowerCase();
        // 对容易与家庭日常问句混淆的中文别名（如 "你有打开窗户吗？"），屏蔽非“在吗”类的问句尾助词
        if (
          AMBIGUOUS_ZH_NOISE_ALIASES.has(cand.surface) &&
          !isWakeQuery &&
          /[吗嘛么呢]$/.test(rawAfter)
        ) {
          continue;
        }
        // 对常见英文词（如 "new" / "near"），仅允许后面紧跟中文直接设备控制指令或唤醒询问（防 "New York" / "Near the door"）
        if (COMMON_EN_STOPWORDS.has(surfaceLower) && !isWakeQuery) {
          const hasChineseAfter = /[\u4e00-\u9fff]/.test(afterText);
          if (!hasChineseAfter || !DIRECT_COMMAND_START_RE.test(afterText)) {
            continue;
          }
        }
        if (!isWakeQuery && (!afterText || !DIRECT_COMMAND_START_RE.test(afterText))) {
          continue;
        }
      }

      return {
        matched: true,
        wakeWord: cand.canonical,
        matchedSurface: surfaceStr,
        index: startIdx,
        endIndex: endIdx,
        beforeText,
        afterText,
        fuzzy: cand.fuzzy,
      };
    }
    return null;
  };

  const primary = runCandidateList(candidates, false);
  if (primary) return primary;

  // 强噪/跨语种近音兜底：仅当后面紧跟明确设备控制指令或唤醒询问时才命中
  const noiseCands: Candidate[] = [];
  for (const w of sortedCanonical) {
    const aliases = NOISE_ONLY_WAKE_ALIASES[w] ?? NOISE_ONLY_WAKE_ALIASES[w.toLowerCase()];
    if (!aliases) continue;
    for (const a of aliases) {
      const key = a.toLowerCase();
      if (!seenSurface.has(key)) {
        seenSurface.add(key);
        noiseCands.push({ canonical: w, surface: a, fuzzy: true });
      }
    }
  }
  const noiseMatch = runCandidateList(noiseCands, true);
  if (noiseMatch) return noiseMatch;

  // 通用自定义英文唤醒词动态音素/编辑距离兜底（支持任意未内置于映射表的自定义英文唤醒词，如 Jarvis / Luna / Milo / Kiro）
  const asciiCanonical = sortedCanonical.filter((w) => /^[a-z][a-z0-9-]{2,}$/i.test(w));
  if (asciiCanonical.length > 0) {
    const leadMatch =
      /^((?:(?:喂|嘿|嗨|哎|唉|哈喽|你好|您好|那个|hey|hi|ok|yo|hello)[\s,，、!！。]*)?)([a-z]{2,16})(?![a-z])/i.exec(
        cleaned,
      );
    if (leadMatch && leadMatch[2]) {
      const prefixStr = leadMatch[1] ?? "";
      const token = leadMatch[2];
      const startIdx = prefixStr.length;
      const endIdx = startIdx + token.length;
      const beforeText = prefixStr.replace(TRAILING_PUNCT_RE, "").trim();
      const rawAfter = cleaned
        .slice(endIdx)
        .replace(LEADING_PUNCT_RE, "")
        .replace(TRAILING_PUNCT_RE, "")
        .trim();
      const isWakeQuery = WAKE_QUERY_AFTER_RE.test(rawAfter);
      const afterText = rawAfter
        .replace(/^(?:同学|你好|您好|在吗|你在吗|在不在|请|帮我一下)?[\s,，。!！?？:：]*/i, "")
        .replace(TRAILING_PUNCT_RE, "")
        .trim();

      const hasDirectCmd = afterText.length > 0 && DIRECT_COMMAND_START_RE.test(afterText);
      const isStandaloneWake = rawAfter.length === 0 || isWakeQuery;

      for (const w of asciiCanonical) {
        if (
          isStandaloneWake &&
          isPhoneticAsciiMatch(token, w, { allowStopwords: false })
        ) {
          return {
            matched: true,
            wakeWord: w,
            matchedSurface: token,
            index: startIdx,
            endIndex: endIdx,
            beforeText,
            afterText: "",
            fuzzy: true,
          };
        }
        if (
          hasDirectCmd &&
          isPhoneticAsciiMatch(token, w, {
            allowStopwords: /[\u4e00-\u9fff]/.test(afterText),
          })
        ) {
          return {
            matched: true,
            wakeWord: w,
            matchedSurface: token,
            index: startIdx,
            endIndex: endIdx,
            beforeText,
            afterText,
            fuzzy: true,
          };
        }
      }
    }
  }

  return null;
}

function buildAttentionPrompt(params: {
  text: string;
  wakeWords: readonly string[];
  wakeSpan: WakeSpanMatch | null;
  awakeActive: boolean;
  inConversation: boolean;
  recentTurns: readonly ConversationTurnContext[];
  speakerName?: string | null;
  speakerMatched?: boolean;
}): string {
  const historyLines =
    params.recentTurns.length > 0
      ? params.recentTurns
          .slice(-4)
          .map((t) => `- ${t.role === "user" ? "用户" : "助手"}: ${t.text.slice(0, 120)}`)
          .join("\n")
      : "（无近期对话）";

  const speakerLine = params.speakerName
    ? `声纹识别结果：已匹配「${params.speakerName}」`
    : params.speakerMatched === false
      ? "声纹识别结果：未匹配已注册说话人"
      : "声纹识别结果：未启用/无档案";

  return [
    "你是智能家居语音助手「MijiaDeck Pi Agent」的注意力门控器（Device-Directed Speech Detector）。",
    "在执行任何智能设备操作之前，你必须仔细思考两个问题：",
    "1. 如果句子里提到了唤醒词，说话人是在【呼唤/命令你】还是在【跟别人聊天时提到你、讨论你、否定叫你或转述】？",
    "2. 结合最近对话记录，说话人当前是不是正在【与你继续对话】，还是在自言自语/跟旁边人聊天？",
    "",
    `配置的唤醒词：${params.wakeWords.join("、")}`,
    `当前状态：${
      params.awakeActive
        ? "刚被唤醒，正等待用户说出指令"
        : params.inConversation
          ? "处于连续对话窗口内"
          : "日常持续监听待机中"
    }`,
    `是否检测到唤醒词：${
      params.wakeSpan
        ? `是（"${params.wakeSpan.matchedSurface}"，位于句中第 ${params.wakeSpan.index} 字，前文="${params.wakeSpan.beforeText}"，后文="${params.wakeSpan.afterText}"）`
        : "否"
    }`,
    speakerLine,
    "最近对话上下文：",
    historyLines,
    "",
    `最新听到的语音文本："""${params.text}"""`,
    "",
    "判定准则：",
    "- 若用户直接呼唤你执行设备控制/查询/提问（如“小派，关灯”、“帮我把音量调大一点”、“那卧室灯也关掉”），addressed=true。",
    "- 注意背景音乐/电视干扰：如果环境中正在放歌，唤醒词前后可能混入无关歌词碎片（例如“也甘愿赴汤蹈火去走小派打开客厅吸顶灯，间走过这世间”）。只要唤醒词后紧跟明确的设备控制/查询指令，就判定 addressed=true，并在 command 字段中只提取干净的用户指令（去掉前后无关歌词）！",
    "- 若用户只是提到你的名字讨论/夸奖/抱怨/叫别人别管你（如“我刚跟朋友聊到小派挺好用的”、“你觉得小派怎么样”、“别管小派了吃饭吧”、“有人叫小派吗”），addressed=false！",
    "- 若处于连续对话窗口，但新句子明显是在和家人说话（如“晚饭吃什么”、“帮我拿双筷子”），addressed=false, inConversation=false！",
    "- 若只是在叫你的名字等待回应（如“小派在吗”、“嘿小派”），addressed=true 且 command 留空字符串。",
    "- 拿不准时宁可保守拒绝（addressed=false），避免误操作智能设备。",
    "",
    "请仅输出一个合法 JSON 对象，不要输出任何额外文字或 Markdown 代码块：",
    '{"addressed":true/false,"inConversation":true/false,"confidence":0.0-1.0,"reason":"简短中文判断理由","command":"若addressed为true则提取去掉唤醒词及无关歌词后的干净指令，纯唤醒或拒绝则为空字符串"}',
  ].join("\n");
}

export function parseLlmAttentionJson(raw: string): LlmAttentionVerdict | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fenced ? fenced[1]!.trim() : trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1)) as Record<string, unknown>;
    if (typeof parsed.addressed !== "boolean") return null;
    const confidenceRaw = Number(parsed.confidence);
    const confidence = Number.isFinite(confidenceRaw)
      ? Math.max(0, Math.min(1, confidenceRaw))
      : parsed.addressed
        ? 0.8
        : 0.75;
    return {
      addressed: parsed.addressed,
      inConversation:
        typeof parsed.inConversation === "boolean" ? parsed.inConversation : parsed.addressed,
      confidence,
      reason: typeof parsed.reason === "string" && parsed.reason.trim() ? parsed.reason.trim() : "",
      command: typeof parsed.command === "string" ? parsed.command.trim() : undefined,
    };
  } catch {
    return null;
  }
}

function isPureNonSpeechEvent(event: string | undefined, cleanedText: string): boolean {
  if (!event) return false;
  const upper = event.toUpperCase();
  const nonSpeech =
    upper.includes("BGM") ||
    upper.includes("APPLAUSE") ||
    upper.includes("LAUGHTER") ||
    upper.includes("CRYING") ||
    upper.includes("SNEEZE") ||
    upper.includes("COUGH");
  if (!nonSpeech) return false;

  // 重要：当环境中有音乐播放时，SenseVoice 会给带人声的真实指令也标上 <|BGM|>！
  // 只有当文本为空、极短或纯拟声/哼唱词时才按纯背景音过滤，绝不误杀音乐下说出的有效中文指令。
  const meaningful = cleanedText.replace(/[\s,，。．.、!！?？:：;；\-—~～"'“”‘’]/g, "");
  if (meaningful.length <= 1) return true;
  if (/^(?:啦+|哼+|嗯+|啊+|哦+|喔+|哈+|呵+|噢+|嘿+|呜+|呀+)+$/.test(meaningful)) return true;
  return false;
}

/**
 * 主入口：综合声纹、声学事件、回声抑制、句法语用与 Pi Agent LLM 注意力门控，决定是否放行执行。
 */
export async function evaluateVoiceAttention(
  input: EvaluateAttentionInput,
): Promise<AttentionDecision> {
  const t0 = performance.now();
  const now = input.now ?? Date.now();
  const cleaned = input.rawText.trim();
  const wrap = (
    partial: Omit<AttentionDecision, "latencyMs">,
  ): AttentionDecision => ({
    ...partial,
    latencyMs: Math.round(performance.now() - t0),
  });

  if (!cleaned) {
    return wrap({
      accept: false,
      wokeOnly: false,
      addressed: false,
      inConversation: Boolean(input.inConversation),
      confidence: 1,
      stage: "no-wake",
      reason: "识别结果为空",
      wakeWord: null,
      command: "",
      usedLlm: false,
    });
  }

  // 0A. 声纹严格校验门控（非手动单次直说）
  if (
    !input.bypassWakeWord &&
    input.voiceprintMode === "strict" &&
    input.voiceprint &&
    input.voiceprint.evaluated &&
    input.voiceprint.enrolledCount > 0 &&
    !input.voiceprint.matched
  ) {
    return wrap({
      accept: false,
      wokeOnly: false,
      addressed: false,
      inConversation: false,
      confidence: 0.95,
      stage: "voiceprint",
      reason: `声纹未通过验证（最高相似度 ${(input.voiceprint.score * 100).toFixed(0)}% < 阈值 ${(input.voiceprint.threshold * 100).toFixed(0)}%）`,
      wakeWord: null,
      command: "",
      usedLlm: false,
    });
  }

  const wakeSpan = findWakeWordSpan(cleaned, input.wakeWords);

  // 0B. TTS 自回声防护（避免电脑扬声器朗读的回复被麦克风重新收进当成指令）
  // 注意：若用户刚刚关闭了“客厅吸顶灯”（助手播报“已关闭客厅吸顶灯”），随后立刻说“打开客厅吸顶灯”，
  // 设备名重叠率约 0.67，绝不能把明确反向控制指令或带唤醒词的语句误判为自回声！
  if (
    !input.bypassWakeWord &&
    input.lastSpokenReply &&
    input.lastSpokenAt &&
    now >= input.lastSpokenAt &&
    now - input.lastSpokenAt <= 4500
  ) {
    const overlap = computeEchoOverlap(cleaned, input.lastSpokenReply);
    const echoThreshold = wakeSpan || DIRECT_COMMAND_START_RE.test(cleaned) ? 0.88 : 0.6;
    if (overlap >= echoThreshold) {
      return wrap({
        accept: false,
        wokeOnly: false,
        addressed: false,
        inConversation: Boolean(input.inConversation),
        confidence: overlap,
        stage: "echo",
        reason: "检测到系统语音播报回声，已自动抑制",
        wakeWord: null,
        command: "",
        usedLlm: false,
      });
    }
  }

  // 0C. 声学非语音事件过滤（仅拦截无有效指令文本的纯背景音乐/掌声/笑声）
  if (!input.bypassWakeWord && !wakeSpan && isPureNonSpeechEvent(input.acousticEvent, cleaned)) {
    return wrap({
      accept: false,
      wokeOnly: false,
      addressed: false,
      inConversation: Boolean(input.inConversation),
      confidence: 0.9,
      stage: "acoustic",
      reason: `识别为纯环境声学事件 (${input.acousticEvent})，非用户指令`,
      wakeWord: null,
      command: "",
      usedLlm: false,
    });
  }

  // 0D. 手动单次说话（Alt+V / 点按单次说话）或关闭唤醒词
  if (input.bypassWakeWord || !input.wakeWordEnabled) {
    const cmd = cleaned.replace(LEADING_PUNCT_RE, "").replace(TRAILING_PUNCT_RE, "").trim();
    return wrap({
      accept: cmd.length > 0,
      wokeOnly: false,
      addressed: cmd.length > 0,
      inConversation: true,
      confidence: 1,
      stage: "bypass",
      reason: input.bypassWakeWord ? "单次手动触发直达" : "已关闭唤醒词过滤",
      wakeWord: null,
      command: cmd,
      usedLlm: false,
    });
  }

  // 注意力模式关闭时退回传统确定性规则
  if (input.attentionMode === "off") {
    if (input.awakeActive) {
      const cmd = cleaned.replace(LEADING_PUNCT_RE, "").replace(TRAILING_PUNCT_RE, "").trim();
      return wrap({
        accept: cmd.length > 0,
        wokeOnly: false,
        addressed: cmd.length > 0,
        inConversation: true,
        confidence: 0.9,
        stage: "fast-followup",
        reason: "处于唤醒窗口内（注意力门控已关闭）",
        wakeWord: null,
        command: cmd,
        usedLlm: false,
      });
    }
    if (wakeSpan) {
      return wrap({
        accept: true,
        wokeOnly: wakeSpan.afterText.length === 0,
        addressed: true,
        inConversation: true,
        confidence: 0.85,
        stage: "fast-wake",
        reason: `命中唤醒词「${wakeSpan.wakeWord}」`,
        wakeWord: wakeSpan.wakeWord,
        command: wakeSpan.afterText,
        usedLlm: false,
      });
    }
    return wrap({
      accept: false,
      wokeOnly: false,
      addressed: false,
      inConversation: false,
      confidence: 0.9,
      stage: "no-wake",
      reason: "未包含唤醒词",
      wakeWord: null,
      command: "",
      usedLlm: false,
    });
  }

  // ==================== 情况 A：句子中提到了唤醒词 ====================
  if (wakeSpan) {
    const cleanBefore = wakeSpan.beforeText;
    const cleanAfter = wakeSpan.afterText;
    const hasVocativeStart =
      cleanBefore.length === 0 || VOCATIVE_PREFIX_RE.test(cleanBefore);
    const hasReferentialBefore =
      cleanBefore.length > 0 && REFERENTIAL_BEFORE_RE.test(cleanBefore);
    const hasReferentialAfter =
      cleanAfter.length > 0 && REFERENTIAL_AFTER_RE.test(cleanAfter);
    const looksDirectCommand =
      cleanAfter.length > 0 && DIRECT_COMMAND_START_RE.test(cleanAfter);
    const isBgmContext = Boolean(input.acousticEvent?.toUpperCase().includes("BGM"));
    const trimmedCmd = isBgmContext ? trimTrailingMusicLyrics(cleanAfter) : cleanAfter;

    // A1. 纯呼唤（例如“小派”、“嘿，小派”、“小派在吗”）
    const wakeOnlyPhrase =
      hasVocativeStart &&
      !hasReferentialBefore &&
      (cleanAfter.length === 0 || /^(?:在吗|你在吗|在不在|你好|您好)$/i.test(cleanAfter));
    if (wakeOnlyPhrase && input.attentionMode !== "strict") {
      return wrap({
        accept: true,
        wokeOnly: true,
        addressed: true,
        inConversation: true,
        confidence: 0.95,
        stage: "fast-wake",
        reason: `句首明确呼唤「${wakeSpan.wakeWord}」，开启聆听对话窗口`,
        wakeWord: wakeSpan.wakeWord,
        command: "",
        usedLlm: false,
      });
    }

    // A2. 句首明确呼唤（或背景音乐歌词前缀后紧跟呼唤且无第三人称语境）+ 清晰控制指令
    // smart 模式下走快速通道，避免歌词前缀误杀或高延迟！
    if (
      input.attentionMode === "smart" &&
      !hasReferentialBefore &&
      !hasReferentialAfter &&
      looksDirectCommand &&
      (hasVocativeStart || (isBgmContext && trimmedCmd.length >= 2))
    ) {
      return wrap({
        accept: true,
        wokeOnly: false,
        addressed: true,
        inConversation: true,
        confidence: hasVocativeStart ? 0.94 : 0.89,
        stage: "fast-wake",
        reason: hasVocativeStart
          ? `句首明确呼唤「${wakeSpan.wakeWord}」并下达操作指令`
          : `音乐环境下识别到「${wakeSpan.wakeWord}」并紧跟明确控制指令（已剥离无关歌词）`,
        wakeWord: wakeSpan.wakeWord,
        command: trimmedCmd,
        usedLlm: false,
      });
    }

    // A3. 存在歧义（句中提及唤醒词、第三人称/讨论信号、不明确的指令，或处于 strict 严格思考模式）：
    // 先由 Pi Agent LLM 注意力门控认真思考“是不是在叫我”！
    if (input.llmEvaluator) {
      const prompt = buildAttentionPrompt({
        text: cleaned,
        wakeWords: input.wakeWords,
        wakeSpan,
        awakeActive: Boolean(input.awakeActive),
        inConversation: Boolean(input.inConversation),
        recentTurns: input.recentTurns ?? [],
        speakerName: input.voiceprint?.speakerName,
        speakerMatched: input.voiceprint?.evaluated ? input.voiceprint.matched : undefined,
      });
      try {
        const rawVerdict = await input.llmEvaluator(prompt);
        const verdict = parseLlmAttentionJson(rawVerdict);
        if (verdict) {
          if (!verdict.addressed) {
            return wrap({
              accept: false,
              wokeOnly: false,
              addressed: false,
              inConversation: verdict.inConversation,
              confidence: verdict.confidence,
              stage: "llm-attention",
              reason: verdict.reason || "虽提及唤醒词，但判定为非定向提及/旁白，不执行操作",
              wakeWord: wakeSpan.wakeWord,
              command: "",
              usedLlm: true,
            });
          }
          const extractedCmd =
            verdict.command !== undefined
              ? verdict.command
              : hasVocativeStart
                ? trimmedCmd
                : trimmedCmd || cleaned;
          return wrap({
            accept: true,
            wokeOnly: extractedCmd.length === 0,
            addressed: true,
            inConversation: true,
            confidence: verdict.confidence,
            stage: "llm-attention",
            reason: verdict.reason || "注意力思考确认正在呼唤助手",
            wakeWord: wakeSpan.wakeWord,
            command: extractedCmd,
            usedLlm: true,
          });
        }
      } catch {
        // LLM 评估超时或出错时降级到确定性语用判定
      }
    }

    // A4. 无 LLM（如本地引擎离线运行）时的确定性语用判别：
    // 若无第三人称语境且唤醒词后紧跟明确智能家居指令，即使句首混入少量背景噪声/歌词也放行！
    if (!hasReferentialBefore && !hasReferentialAfter && looksDirectCommand) {
      return wrap({
        accept: true,
        wokeOnly: false,
        addressed: true,
        inConversation: true,
        confidence: 0.86,
        stage: "fast-wake",
        reason: `识别到「${wakeSpan.wakeWord}」后紧跟明确设备控制指令`,
        wakeWord: wakeSpan.wakeWord,
        command: trimTrailingMusicLyrics(cleanAfter),
        usedLlm: false,
      });
    }

    if (hasReferentialBefore || hasReferentialAfter || !hasVocativeStart) {
      return wrap({
        accept: false,
        wokeOnly: false,
        addressed: false,
        inConversation: Boolean(input.inConversation),
        confidence: 0.82,
        stage: "pragmatic-reject",
        reason: hasReferentialBefore || hasReferentialAfter
          ? `检测到对「${wakeSpan.wakeWord}」的第三人称提及或讨论，判定不是在呼叫助手`
          : `「${wakeSpan.wakeWord}」出现在句中且缺乏直接呼唤语境，已忽略以防误触`,
        wakeWord: wakeSpan.wakeWord,
        command: "",
        usedLlm: false,
      });
    }

    return wrap({
      accept: true,
      wokeOnly: cleanAfter.length === 0,
      addressed: true,
      inConversation: true,
      confidence: 0.85,
      stage: "fast-wake",
      reason: `句首呼唤「${wakeSpan.wakeWord}」`,
      wakeWord: wakeSpan.wakeWord,
      command: trimmedCmd,
      usedLlm: false,
    });
  }

  // ==================== 情况 B：无唤醒词，但处于显式唤醒窗口或连续对话窗口 ====================
  if (input.awakeActive || input.inConversation) {
    const cmd = cleaned.replace(LEADING_PUNCT_RE, "").replace(TRAILING_PUNCT_RE, "").trim();

    // 明显是旁白/拟声词
    if (cmd.length <= 1 || OBVIOUS_SIDETALK_RE.test(cmd)) {
      return wrap({
        accept: false,
        wokeOnly: false,
        addressed: false,
        inConversation: Boolean(input.inConversation),
        confidence: 0.88,
        stage: "pragmatic-reject",
        reason: "判定为非定向旁白/环境闲聊，未触发设备控制",
        wakeWord: null,
        command: "",
        usedLlm: false,
      });
    }

    // 刚唤醒后的明确直接指令，或连续对话中极明确的续聊控制词
    const isClearDeviceCmd = DIRECT_COMMAND_START_RE.test(cmd) || CLEAR_FOLLOWUP_RE.test(cmd);
    if (input.attentionMode === "smart" && isClearDeviceCmd && (input.awakeActive || cmd.length <= 18)) {
      return wrap({
        accept: true,
        wokeOnly: false,
        addressed: true,
        inConversation: true,
        confidence: 0.9,
        stage: "fast-followup",
        reason: input.awakeActive ? "唤醒窗口内明确指令" : "连续对话中明确续聊控制指令",
        wakeWord: null,
        command: cmd,
        usedLlm: false,
      });
    }

    // 连续对话窗口内的不确定语句 -> 由 Pi Agent LLM 注意力门控判断是否仍在与助手对话！
    if (input.llmEvaluator) {
      const prompt = buildAttentionPrompt({
        text: cleaned,
        wakeWords: input.wakeWords,
        wakeSpan: null,
        awakeActive: Boolean(input.awakeActive),
        inConversation: Boolean(input.inConversation),
        recentTurns: input.recentTurns ?? [],
        speakerName: input.voiceprint?.speakerName,
        speakerMatched: input.voiceprint?.evaluated ? input.voiceprint.matched : undefined,
      });
      try {
        const rawVerdict = await input.llmEvaluator(prompt);
        const verdict = parseLlmAttentionJson(rawVerdict);
        if (verdict) {
          if (!verdict.addressed) {
            return wrap({
              accept: false,
              wokeOnly: false,
              addressed: false,
              inConversation: verdict.inConversation,
              confidence: verdict.confidence,
              stage: "llm-attention",
              reason: verdict.reason || "当前语句未面向助手（旁白对话），已忽略",
              wakeWord: null,
              command: "",
              usedLlm: true,
            });
          }
          return wrap({
            accept: true,
            wokeOnly: false,
            addressed: true,
            inConversation: true,
            confidence: verdict.confidence,
            stage: "llm-attention",
            reason: verdict.reason || "确认正在继续与助手对话",
            wakeWord: null,
            command: verdict.command || cmd,
            usedLlm: true,
          });
        }
      } catch {
        // fallback below
      }
    }

    // 离线降级：显式唤醒窗口放行，普通对话窗口仅放行明确控制词
    if (input.awakeActive || isClearDeviceCmd) {
      return wrap({
        accept: true,
        wokeOnly: false,
        addressed: true,
        inConversation: true,
        confidence: 0.8,
        stage: "fast-followup",
        reason: input.awakeActive ? "处于唤醒等待窗口内" : "连续对话续聊指令",
        wakeWord: null,
        command: cmd,
        usedLlm: false,
      });
    }
  }

  return wrap({
    accept: false,
    wokeOnly: false,
    addressed: false,
    inConversation: false,
    confidence: 0.92,
    stage: "no-wake",
    reason: "未检测到唤醒词或有效对话上下文",
    wakeWord: null,
    command: "",
    usedLlm: false,
  });
}
