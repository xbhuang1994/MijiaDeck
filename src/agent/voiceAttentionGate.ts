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

// 中文常见同音误识别映射（显著提高嘈杂环境与不同口音下的唤醒召回率）
const WAKE_HOMOPHONES: Readonly<Record<string, readonly string[]>> = {
  小派: ["小湃", "小π", "小拍", "小排", "小牌", "小佩"],
  派派: ["拍拍", "湃湃"],
  米家助手: ["米家主手", "迷家助手"],
};

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
 * 在句子中查找唤醒词（支持中英文边界保护与中文常见同音 ASR 纠错）。
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
    const homophones = WAKE_HOMOPHONES[w];
    if (!homophones) continue;
    for (const h of homophones) {
      const key = h.toLowerCase();
      if (!seenSurface.has(key)) {
        seenSurface.add(key);
        candidates.push({ canonical: w, surface: h, fuzzy: true });
      }
    }
  }

  for (const cand of candidates) {
    const isAscii = /^[a-z0-9]+$/i.test(cand.surface);
    const pattern = isAscii
      ? new RegExp(
          `(?:^|[\\s,，。!！?？、])((?:hey\\s+|hi\\s+|ok\\s+)?${escapeRegExp(cand.surface)})(?=$|[\\s,，。!！?？:：、\\u4e00-\\u9fff])`,
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
    const afterText = cleaned
      .slice(endIdx)
      .replace(LEADING_PUNCT_RE, "")
      .replace(/^(?:同学|你好|您好|在吗|请|帮我一下)?[\s,，。!！?？:：]*/i, "")
      .replace(TRAILING_PUNCT_RE, "")
      .trim();

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
    "- 若用户只是提到你的名字讨论/夸奖/抱怨/叫别人别管你（如“我刚跟朋友聊到小派挺好用的”、“你觉得小派怎么样”、“别管小派了吃饭吧”、“有人叫小派吗”），addressed=false！",
    "- 若处于连续对话窗口，但新句子明显是在和家人说话（如“晚饭吃什么”、“帮我拿双筷子”），addressed=false, inConversation=false！",
    "- 若只是在叫你的名字等待回应（如“小派在吗”、“嘿小派”），addressed=true 且 command 留空字符串。",
    "- 拿不准时宁可保守拒绝（addressed=false），避免误操作智能设备。",
    "",
    "请仅输出一个合法 JSON 对象，不要输出任何额外文字或 Markdown 代码块：",
    '{"addressed":true/false,"inConversation":true/false,"confidence":0.0-1.0,"reason":"简短中文判断理由","command":"若addressed为true则提取去掉唤醒词后的干净指令，纯唤醒或拒绝则为空字符串"}',
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

function isPureNonSpeechEvent(event?: string): boolean {
  if (!event) return false;
  const upper = event.toUpperCase();
  return (
    upper.includes("BGM") ||
    upper.includes("APPLAUSE") ||
    upper.includes("LAUGHTER") ||
    upper.includes("CRYING") ||
    upper.includes("SNEEZE") ||
    upper.includes("COUGH")
  );
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

  // 0B. TTS 自回声防护（避免电脑扬声器朗读的回复被麦克风重新收进当成指令）
  if (
    !input.bypassWakeWord &&
    input.lastSpokenReply &&
    input.lastSpokenAt &&
    now - input.lastSpokenAt <= 4500
  ) {
    const overlap = computeEchoOverlap(cleaned, input.lastSpokenReply);
    if (overlap >= 0.6) {
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

  const wakeSpan = findWakeWordSpan(cleaned, input.wakeWords);

  // 0C. 声学非语音事件过滤（如纯背景音乐/掌声/笑声且无明确唤醒词）
  if (!input.bypassWakeWord && !wakeSpan && isPureNonSpeechEvent(input.acousticEvent)) {
    return wrap({
      accept: false,
      wokeOnly: false,
      addressed: false,
      inConversation: Boolean(input.inConversation),
      confidence: 0.9,
      stage: "acoustic",
      reason: `识别为环境声学事件 (${input.acousticEvent})，非用户指令`,
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

    // A2. 句首明确呼唤 + 清晰控制指令（smart 模式下 0ms 快速通道，保证极速对话体验）
    if (
      input.attentionMode === "smart" &&
      hasVocativeStart &&
      !hasReferentialBefore &&
      !hasReferentialAfter &&
      looksDirectCommand
    ) {
      return wrap({
        accept: true,
        wokeOnly: false,
        addressed: true,
        inConversation: true,
        confidence: 0.94,
        stage: "fast-wake",
        reason: `句首明确呼唤「${wakeSpan.wakeWord}」并下达操作指令`,
        wakeWord: wakeSpan.wakeWord,
        command: cleanAfter,
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
                ? cleanAfter
                : cleanAfter || cleaned;
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

    // A4. 无 LLM（如本地引擎离线运行）时的确定性语用判别：拦截明显第三人称提及与讨论
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
      command: cleanAfter,
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
