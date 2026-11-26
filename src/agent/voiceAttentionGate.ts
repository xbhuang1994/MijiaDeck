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

import type { EchoCancellationMode } from "../core/agentConfigStore.ts";
import {
  isAsrHallucinationText,
  stripRepeatedLeadingWakeWords,
} from "./asrHallucinationGuard.ts";
import { isCustomInstructionVoiceCommand } from "./customInstructionStore.ts";
import {
  computeEnhancedEchoOverlap,
  evaluateTtsEcho,
  type EchoUtteranceRecord,
} from "./echoGuard.ts";
import {
  probeImplicitCapabilities,
  type HomeCapabilityDigest,
} from "./intentCanonicalizer.ts";
import type { WakeWordAcousticHit } from "./openWakeWordEngine.ts";
import {
  classifyConfirmationReply,
  type PendingConfirmationGateContext,
} from "./reinforcementMemoryStore.ts";
import type { CommandIntentChoice, SystemOneClient } from "./systemOneClient.ts";
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
  dialogState?: "standby" | "conversation";
  altText?: string;
  acousticWake?: WakeWordAcousticHit | null;
  owwActiveForWord?: boolean;
  systemOneClient?: SystemOneClient | null;
  recentTurns?: readonly ConversationTurnContext[];
  lastSpokenReply?: string;
  lastSpokenAt?: number;
  /** 多语段实时 TTS 播报账本快照（由 TtsEchoGuard 维护，支持队列排队与活跃播放精准匹配） */
  recentSpokenUtterances?: ReadonlyArray<EchoUtteranceRecord>;
  /** 当前扬声器是否正在播报 TTS */
  ttsActive?: boolean;
  /** 该音频段是否在 TTS 播报期间或刚结束尾窗内采集 */
  duringTtsPlayback?: boolean;
  /** 回声消除策略 */
  echoCancellationMode?: EchoCancellationMode;
  now?: number;
  acousticEvent?: string;
  voiceprint?: VoiceprintIdentifyResult | null;
  voiceprintMode?: VoiceprintPolicyMode;
  /** 当前连续对话中已确认的活跃说话人姓名（用于同说话人声纹连续性信号） */
  conversationSpeakerName?: string | null;
  llmEvaluator?: AttentionLlmEvaluator;
  /** 当前家庭设备特殊能力摘要（支持袜子筒/内裤筒/扫地机/浇花/喂食器等隐式指令精准放行） */
  capabilityDigest?: HomeCapabilityDigest | null;
  /** 已学习的强化记忆触发示例短语 */
  learnedTriggers?: readonly string[];
  /** 当前正在等待用户回复的待确认槽位上下文 */
  pendingConfirmation?: PendingConfirmationGateContext | null;
}

export type AttentionPassSource =
  | "explicit_command"
  | "device_command"
  | "implicit_capability"
  | "pending_confirmation"
  | "acoustic_wake_recovery"
  | "conversation_followup_recovery"
  | "custom_instruction"
  | "systemone"
  | "llm"
  | "fallback";

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
    | "acoustic-veto"
    | "echo"
    | "exit"
    | "pending-confirm"
    | "fast-wake"
    | "fast-followup"
    | "pragmatic-reject"
    | "systemone-attention"
    | "llm-attention"
    | "noise-track-muted"
    | "no-wake";
  reason: string;
  wakeWord: string | null;
  command: string;
  usedLlm: boolean;
  latencyMs: number;
  exitConversation?: boolean;
  intent?: CommandIntentChoice;
  intentConfidence?: number;
  selectedText?: string;
  /** 双讲场景下从识别文本中自动剥离了混入的 TTS 回声残片 */
  echoStripped?: boolean;
  /** 放行来源遥测标签（用于 UI 展示隐式能力放行/待确认回复/声学唤醒恢复等） */
  passSource?: AttentionPassSource;
  /** 命中的家庭设备能力标签（例如 `美的可爱多·左筒 · 袜子筒`） */
  matchedCapability?: string;
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
    "你好",
    "你给",
    "你欧",
    "你哦",
    "你偶",
    "黑牛",
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
const AMBIGUOUS_ZH_NOISE_ALIASES = new Set<string>(["你有", "你又", "你好", "你给"]);

// 严禁单独作为纯唤醒询问触发的中文问候词（如“你好”“你好在吗”绝不能误唤醒，仅在“你好关灯”这类句首直连设备指令时兜底）
const COMMAND_ONLY_NOISE_ALIASES = new Set<string>(["你好", "你给"]);

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
  /^(?:请|帮我|给我|麻烦|快|赶紧|顺便|现在|把|将|打开|开启|开灯|关灯|熄灯|灭灯|亮灯|开机|关机|开空调|关空调|开风扇|关风扇|开窗|关窗|开电视|关电视|开音箱|关音箱|开音响|关音响|开插座|关插座|开开关|关开关|全开|全关|关掉|关闭|关上|开一下|关一下|调|设置|设定|设为|改成|换成|切换|播放|放一首|来一首|放歌|放音乐|播音乐|听歌|切歌|换歌|下一首|上一首|暂停|继续|停止|停一下|停掉|结束播放|(?:别|不要)(?:再)?(?:放|播)|静音|取消静音|闭麦|开麦|声音|音量|大一点|小一点|亮一点|暗一点|暖一点|冷一点|查|查看|查询|看看|告诉我|卧室|客厅|餐厅|书房|厨房|阳台|主卧|次卧|玄关|卫生间|全屋|所有|全部|小爱|小米|灯|吸顶灯|台灯|空调|风扇|插座|开关|窗帘|喂食器|出粮|喂食|喂猫|喂狗|喂|场景|模式|回家|离家|睡眠|观影|温度|湿度|空气|turn|open|close|set|play|pause|stop|mute|check|what)/i;

// 真实智能家居设备与控制领域语义词表（用于区分设备指令与 "你好，帮我递杯水" 等日常家务聊天）
const SMART_HOME_DOMAIN_RE =
  /(?:灯|吸顶灯|台灯|照明|空调|洗衣|洗衣机|洗烘|智洗烘|滚筒|波轮|烘干|温度|湿度|空气|净化器|加湿器|除湿|扫地|摄像头|摄像机|监控|传感|设备|风扇|窗帘|窗户|电视|音响|音箱|小爱|音量|声音|静音|闭麦|开麦|音乐|歌|播放|暂停|继续|停止|下一首|上一首|切歌|换歌|换一首|亮度|调亮|调暗|亮一点|暗一点|大一点|小一点|高一点|低一点|暖一点|冷一点|色温|暖光|冷光|白光|黄光|红光|蓝光|绿光|插座|开关|喂猫|喂狗|喂食|喂食器|出粮|投喂|场景|模式|观影|睡眠|回家|离家|全屋|客厅|卧室|书房|餐厅|厨房|阳台|走廊|浴室|主卧|次卧|玄关|卫生间|附加指令|自定义指令|指令规则|偏好规则|light|lamp|ac|air\s*conditioner|washer|laundry|fan|curtain|tv|speaker|volume|music|pause|play|mute|bright|dim|temp|humidity)/i;

// 严防声学唤醒覆盖第三人称讨论或否定呼唤语境（含噪声下 SenseVoice 把 "别管Neo" 听成 "别管你用/别管你了"）
const STRICT_THIRD_PERSON_NEO_RE =
  /(?:提到|聊到|说到|说起|讲到|谈到|听说|觉得|认为|喜欢|讨厌|别管|别理|不用管|不要管|没叫|没喊|谁叫|谁在叫|什么叫|叫做|名叫|名字叫|介绍|对比|评论|新闻里|同事|朋友).{0,8}(?:neo|小派|尼奥|尼欧|妮奥|妮欧|new|near|neil|你o|你用|你又|你有|你了|你呀|那个)/i;

const STRICT_THIRD_PERSON_NEO_AFTER_RE =
  /(?:neo|小派|尼奥|尼欧|妮奥|妮欧).{0,3}(?:这个|那个|的(?:界面|功能|名字|性能|芯片|声音|模型|反应|效果|设计)|好用|不错|挺快|挺聪明|挺有意思|怎么样|好不好用|芯片|软件|助手|项目)/i;

export function hasSmartHomeDomainIntent(text: string): boolean {
  return SMART_HOME_DOMAIN_RE.test(text);
}

export function isThirdPersonNeoMention(text: string): boolean {
  return STRICT_THIRD_PERSON_NEO_RE.test(text) || STRICT_THIRD_PERSON_NEO_AFTER_RE.test(text);
}

export function looksLikeDirectDeviceCommand(text: string): boolean {
  const trimmed = text.trim();
  return DIRECT_COMMAND_START_RE.test(trimmed) || isCustomInstructionVoiceCommand(trimmed);
}

// 自包含的明确控制设备动宾短语（句中任一分句出现即构成明确控制设备指令）
const SELF_CONTAINED_DEVICE_CONTROL_RE =
  /(?:开灯|关灯|熄灯|灭灯|亮灯|开空调|关空调|开风扇|关风扇|开电视|关电视|开音箱|关音箱|开音响|关音响|开插座|关插座|开开关|关开关|开窗帘|关窗帘|拉窗帘|拉上窗帘|拉开窗帘|开加湿器|关加湿器|开净化器|关净化器|开除湿机|关除湿机|开浴霸|关浴霸|开洗衣机|关洗衣机|开热水器|关热水器|开暖风机|关暖风机|开扫地机|关扫地机|全屋开灯|全屋关灯|全部开灯|全部关灯|放歌|放音乐|播音乐|切歌|换歌|换一首|换首歌|下一首|上一首|下一曲|上一曲|暂停播放|停止播放|结束播放|继续播放|取消静音|解除静音|恢复声音|闭麦|开麦|调亮|调暗|调高音量|调低音量|调大音量|调小音量|调大声音|调小声音|声音大一点|声音小一点|声音调大|声音调小|音量大一点|音量小一点|音量调大|音量调小|亮度调高|亮度调低|灯光调亮|灯光调暗|出粮|投喂|喂猫|喂狗|播放(?:一点|点|一首|首|一下)?音乐|播放(?:一首|首|一下)?歌|(?:别|不要)(?:再)?(?:放|播)(?:歌|音乐)|turn\s+(?:on|off)\s+(?:the\s+)?(?:[\w-]+\s+){0,3}(?:lights?|lamps?|ac|air\s*conditioner|fan|curtains?|tv|speaker|washer|heater|humidifier|purifier)|switch\s+(?:on|off)\s+(?:the\s+)?(?:[\w-]+\s+){0,3}(?:lights?|lamps?|ac|fan|curtains?|tv|speaker)|(?:play|pause|stop)\s+(?:the\s+)?music|(?:set|adjust)\s+(?:the\s+)?(?:ac|air\s*conditioner|temp|temperature|brightness|volume|light|lamp)\b)/i;

// 仅在独立短指令形态下认可的音箱/麦克风快捷控制（防“这个房间好静音”等描述句误触）
const STANDALONE_AUDIO_CONTROL_RE =
  /^(?:请|帮我|给我|麻烦|快|赶紧|现在)?(?:静音|取消静音|解除静音|恢复声音|闭麦|开麦)(?:吧|一下)?$/i;

// 明确指向智能家居控制对象的设备/媒介/模式名词（排除泛化词如“客厅/窗户”，防“你有打开窗户吗”“客厅挺舒服”误判）
const DEVICE_CONTROL_TARGET_RE =
  /(?:灯|吸顶灯|台灯|主灯|射灯|筒灯|吊灯|落地灯|床头灯|氛围灯|夜灯|灯带|照明|空调|冷气|暖气|洗衣机|洗烘|智洗烘|滚筒|波轮|烘干机|干衣机|净化器|加湿器|除湿机|除湿器|扫地机|扫拖|洗地机|风扇|电风扇|循环扇|落地扇|窗帘|纱帘|卷帘|电视|电视机|投影仪|音响|音箱|小爱|音量|声音|音乐|歌曲|插座|排插|插线板|开关|浴霸|热水器|暖风机|电暖器|喂食器|饮水机|猫砂盆|观影模式|睡眠模式|回家模式|离家模式|亮度|色温|暖光|冷光|白光|黄光|红光|蓝光|绿光|\blights?\b|\blamps?\b|\bac\b|air\s*conditioner|\bwasher\b|\bfan\b|\bcurtains?\b|\btv\b|\bspeaker\b|\bvolume\b|\bmusic\b|\bbrightness\b)/i;

// 明确祈使/调节控制动作词（须与 DEVICE_CONTROL_TARGET_RE 同时出现）
const EXPLICIT_CONTROL_VERB_RE =
  /(?:打开|开启|关闭|关掉|关上|关一下|开一下|开下|关下|开到|开成|启动|暂停|停止|停一下|停掉|继续|调到|调成|调为|调至|调高|调低|调大|调小|调亮|调暗|关小|关大|开大|开小|设为|设成|设到|设定|设置|改成|换成|切换|升高|降低|加一度|减一度|高一度|低一度|高两度|低两度|亮一点|暗一点|大一点|小一点|高一点|低一点|暖一点|冷一点|播放|放一首|来一首|点一首|拉上|拉开|拉起来|合上|收起|回充|回去充电|回基站|充电|清扫|拖地|扫地|烘干|脱水|静音|执行|开\s*\d+\s*度|调\s*\d+\s*度|turn\s+(?:on|off)|switch\s+(?:on|off)|dim|brighten|play|pause|stop|mute|unmute)/i;

// 把字句设备控制结构（如“把客厅灯关了”“把卧室空调开了”“把电视声音调小”）
const BA_DEVICE_CONTROL_RE =
  /把[^，,。！？?!]{1,14}(?:打开|开启|关闭|关掉|关上|关了|关了吧|关一下|关下|关小|关大|开了|开了吧|开一下|开下|开到|开大|开小|调|设|改|换|切|停|暂停|拉上|拉开|合上|收起|静音|送回)/i;

// 明显是非/疑问句护栏（屏蔽“你有打开窗户吗？”“客厅灯开了吗”“空调开着吗”“帮我问问有没有关灯”等非控制问句）
const DEVICE_CMD_INTERROGATIVE_END_RE = /[吗嘛么呢？?][\s。!！]*$/;
const DEVICE_CMD_INDIRECT_QUESTION_RE =
  /(?:有没有|是不是|是否|为什么|怎么(?:没|不|老|又|还)|什么时候|多少|几度|开着吗|关着吗|问问|谁(?:把|给|开|关))/;

// 单分句过去时/状态描述/转述/演示评价/否定不操作护栏（防“我刚才把灯关了”“打开客厅吸顶灯那个演示挺不错”“别关灯”“没关灯”“客厅灯打开了”误触）
const CLAUSE_PAST_OR_REPORTED_RE =
  /(?:(?:已经|刚才|刚刚|昨天|昨晚|刚才我|我已经|他已经|她已经|我都|忘记|忘了|记得|没记得|还没|以为|听说|据说|好像|大概|他说|她说|他们说|别人说|有人说|朋友说|同事说|喜欢|讨厌).{0,8}(?:打开|开启|关闭|关掉|关上|关了|开了|关灯|开灯|调|放|停|静音|洗|扫|拖)|(?:那个|这个)?(?:演示|功能|例子|示例|效果|视频|画面|感觉|项目).{0,8}(?:挺|很|真|还|不|好)|(?:开着呢|关着呢|坏了|很亮|太亮了|很好看|挺好用|真好用|挺不错|还不错|真不错|不好用|买了个|买了台)|^(?:如果|要是|假如|万一)|(?:别|不要|不用|不必|不需要|没|没有|未)(?:去|再)?(?:开灯|关灯|熄灯|开空调|关空调|开风扇|关风扇|开电视|关电视|开窗帘|关窗帘|打开|开启|关闭|关掉|关上|启动|调)|^(?!.*(?:把|帮我|给我|请|麻烦|快|赶紧)).*(?:打开|开启|关闭|启动|暂停|停止)了$)/;

const IMPLICIT_CAP_IMPERATIVE_RE =
  /(?:^|[\s,，])(?:请|帮我|给我|替我|麻烦|开启|启动|打开|关掉|关闭|暂停|停止|洗一下|洗个|烘一下|扫一下|拖一下|浇一下|喂一下|洗|烘|扫|拖|浇|喂)/;

function clauseHasExplicitDeviceControlCommand(
  clauseRaw: string,
  capabilityDigest?: HomeCapabilityDigest | null,
): boolean {
  const clause = clauseRaw.replace(LEADING_PUNCT_RE, "").replace(TRAILING_PUNCT_RE, "").trim();
  if (clause.length < 2) return false;
  if (DEVICE_CMD_INTERROGATIVE_END_RE.test(clause)) return false;
  if (DEVICE_CMD_INDIRECT_QUESTION_RE.test(clause)) return false;
  if (CLAUSE_PAST_OR_REPORTED_RE.test(clause)) return false;
  if (NON_COMMAND_CHAT_RE.test(clause)) return false;

  if (STANDALONE_AUDIO_CONTROL_RE.test(clause)) return true;
  if (SELF_CONTAINED_DEVICE_CONTROL_RE.test(clause)) return true;
  if (
    DEVICE_CONTROL_TARGET_RE.test(clause) &&
    (EXPLICIT_CONTROL_VERB_RE.test(clause) || BA_DEVICE_CONTROL_RE.test(clause))
  ) {
    return true;
  }
  if (
    capabilityDigest &&
    IMPLICIT_CAP_IMPERATIVE_RE.test(clause) &&
    probeImplicitCapabilities(clause, capabilityDigest)
  ) {
    return true;
  }
  return false;
}

/**
 * 判断文本中是否存在明确的智能家居控制设备指令（作为唤醒词判定的或条件：
 * 满足“是有效唤醒词 OR 存在控制设备指令”即放行不拦截）。
 * 严格屏蔽日常是非问句（如“你有打开窗户吗？”）、过去时陈述（“我刚才把灯关了”）、
 * 隐式抱怨（“我觉得客厅有点暗呢”）与闲聊旁白（“晚饭吃什么”“我刚才聊到Neo挺好用的”）。
 */
export function hasExplicitDeviceControlCommand(
  rawText: string,
  capabilityDigest?: HomeCapabilityDigest | null,
): boolean {
  const cleaned = rawText.replace(LEADING_PUNCT_RE, "").replace(TRAILING_PUNCT_RE, "").trim();
  if (cleaned.length < 2 || cleaned.length > 64) return false;
  if (DEVICE_CMD_INTERROGATIVE_END_RE.test(cleaned)) return false;
  if (DEVICE_CMD_INDIRECT_QUESTION_RE.test(cleaned)) return false;

  const clauses = cleaned
    .split(/[，,。！？!?;；]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (clauses.length === 0) return false;
  return clauses.some((clause) => clauseHasExplicitDeviceControlCommand(clause, capabilityDigest));
}

function stripLeadingControlFiller(text: string): string {
  const cleaned = text.replace(LEADING_PUNCT_RE, "").replace(TRAILING_PUNCT_RE, "").trim();
  const m = /^(?:嗯|啊|哦|喔|唉|哎|那个|然后|顺便)[\s,，、!！。:：]+(.+)$/.exec(cleaned);
  if (m && m[1]) {
    const rest = m[1].replace(LEADING_PUNCT_RE, "").replace(TRAILING_PUNCT_RE, "").trim();
    if (rest.length >= 2) return rest;
  }
  return cleaned;
}

/**
 * 在因“存在控制设备指令”或条件放行时，提取干净可执行的控制指令文本（绝不退化为空字符串）。
 */
function extractDeviceControlCommand(
  cleaned: string,
  wakeSpan: WakeSpanMatch | null,
  cleanBefore: string,
  cleanAfter: string,
  capabilityDigest?: HomeCapabilityDigest | null,
): string {
  if (wakeSpan) {
    if (cleanAfter && hasExplicitDeviceControlCommand(cleanAfter, capabilityDigest)) {
      return stripLeadingControlFiller(cleanAfter);
    }
    if (cleanBefore && hasExplicitDeviceControlCommand(cleanBefore, capabilityDigest)) {
      return stripLeadingControlFiller(cleanBefore);
    }
    if (cleanAfter && cleanAfter.length >= 2) {
      return stripLeadingControlFiller(cleanAfter);
    }
    if (cleanBefore && !VOCATIVE_PREFIX_RE.test(cleanBefore) && cleanBefore.length >= 2) {
      return stripLeadingControlFiller(cleanBefore);
    }
  }
  return stripLeadingControlFiller(cleaned);
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

const PURE_WAKE_FILLER_RE = /^(?:[你呢啊嗯哦喔哈嘿喂哟20oO]+|ok|hi|hey|yo)$/i;

export interface SuspectedWakeAliasHint {
  matchedSurface: string;
  targetWakeWord: string;
  substitutedUtterance: string;
}

const PAUSED_ACOUSTIC_WAKE_PREFIX_RE =
  /^(六|流|留|刘|溜|柳|略|呢|那|那哦|那我|你呀|您)[\s,，。!！?？:：、]+/;
const STANDALONE_ACOUSTIC_WAKE_SLIP_RE =
  /^(?:六|流|留|刘|溜|柳|略|呢|那|那哦|你呀|尼|妮|牛|妞|钮|纽)$/;
const MANGLED_ACOUSTIC_WAKE_PREFIX_RE =
  /^(你好|您好|你有|你又|你给|你欧|你哦|你奥|你o|你0|尼奥|尼欧|妮奥|妮欧|尼哦|呢哦|里奥|利奥|米奥|尼|妮|牛|妞|钮|纽|new|near|neil|neal|nio|no|ne)(?![a-z])[\s,，。!！?？:：、]*/i;

/**
 * 为唤醒词纯误听校验构造句首谐音/近音替换候选（如“你有播放点音乐吧”->“Neo，播放点音乐吧”、“六，我觉得客厅有点暗呢”->“Neo，我觉得客厅有点暗呢”），
 * 仅用于 SystemOne 对比“原句字面语义 vs 替换回触发词后的语义”，绝不引入对话上下文或背景环境信息。
 */
export function buildSuspectedWakeAliasHint(
  cleaned: string,
  wakeSpan: WakeSpanMatch | null,
  acousticWake?: WakeWordAcousticHit | null,
): SuspectedWakeAliasHint | null {
  if (wakeSpan) {
    if (!wakeSpan.fuzzy) return null;
    const prefix = wakeSpan.beforeText ? `${wakeSpan.beforeText} ` : "";
    const substitutedUtterance = wakeSpan.afterText
      ? `${prefix}${wakeSpan.wakeWord}，${wakeSpan.afterText}`
      : `${prefix}${wakeSpan.wakeWord}`;
    return {
      matchedSurface: wakeSpan.matchedSurface,
      targetWakeWord: wakeSpan.wakeWord,
      substitutedUtterance,
    };
  }

  if (!acousticWake?.matched) return null;
  const target = acousticWake.wakeWord.trim();
  const trimmed = cleaned.replace(LEADING_PUNCT_RE, "").replace(TRAILING_PUNCT_RE, "").trim();
  if (!target || !trimmed) return null;

  const aliases = [
    ...(WAKE_HOMOPHONES[target] ?? WAKE_HOMOPHONES[target.toLowerCase()] ?? []),
    ...(NOISE_ONLY_WAKE_ALIASES[target] ?? NOISE_ONLY_WAKE_ALIASES[target.toLowerCase()] ?? []),
  ].sort((a, b) => b.length - a.length);

  for (const alias of aliases) {
    const isAscii = /^[a-z0-9\s-]+$/i.test(alias);
    const re = isAscii
      ? new RegExp(`^(${escapeRegExp(alias)})(?![a-z])[\\s,，。!！?？:：、]*`, "i")
      : new RegExp(`^(${escapeRegExp(alias)})[\\s,，。!！?？:：、]*`, "i");
    const m = re.exec(trimmed);
    if (!m) continue;
    const rest = trimmed
      .slice(m[0].length)
      .replace(LEADING_PUNCT_RE, "")
      .replace(TRAILING_PUNCT_RE, "")
      .trim();
    return {
      matchedSurface: m[1] ?? alias,
      targetWakeWord: target,
      substitutedUtterance: rest ? `${target}，${rest}` : target,
    };
  }

  const pm = PAUSED_ACOUSTIC_WAKE_PREFIX_RE.exec(trimmed);
  if (pm && pm[1]) {
    const rest = trimmed
      .slice(pm[0].length)
      .replace(LEADING_PUNCT_RE, "")
      .replace(TRAILING_PUNCT_RE, "")
      .trim();
    return {
      matchedSurface: pm[1],
      targetWakeWord: target,
      substitutedUtterance: rest ? `${target}，${rest}` : target,
    };
  }

  if (STANDALONE_ACOUSTIC_WAKE_SLIP_RE.test(trimmed)) {
    return {
      matchedSurface: trimmed,
      targetWakeWord: target,
      substitutedUtterance: target,
    };
  }

  const mm = MANGLED_ACOUSTIC_WAKE_PREFIX_RE.exec(trimmed);
  if (mm && mm[1]) {
    const rest = trimmed
      .slice(mm[0].length)
      .replace(LEADING_PUNCT_RE, "")
      .replace(TRAILING_PUNCT_RE, "")
      .trim();
    return {
      matchedSurface: mm[1],
      targetWakeWord: target,
      substitutedUtterance: rest ? `${target}，${rest}` : target,
    };
  }

  return null;
}

/**
 * 当 openWakeWord 声学引擎或 en-head 英文句首探针已确认本段语音开头包含唤醒词（如快速说的 "Neo关灯"）时，
 * 从 SenseVoice 中文轨中精准剥离被误听的句首唤醒词残片（如 "你好关灯" / "你有关灯" / "你给开灯" / "钮关灯" / "new关灯"），
 * 完整保留后面的短指令（如 "关灯" / "开灯"），绝不把短指令误清空成纯唤醒！
 */
export function extractCommandAfterAcousticWake(rawText: string, wakeWord: string): string {
  const cleaned = rawText.replace(LEADING_PUNCT_RE, "").replace(TRAILING_PUNCT_RE, "").trim();
  if (!cleaned) return "";

  // 1. 若本身已直接是清晰设备指令（例如 SenseVoice 吞掉 Neo 只剩 "关灯" / "开灯" / "打开客厅吸顶灯"）
  if (looksLikeDirectDeviceCommand(cleaned)) {
    return cleaned;
  }
  if (isWakeQueryText(cleaned)) {
    return "";
  }

  // 2. 先尝试常规/同音/别名唤醒词切分（如 "你有关灯" / "new关灯" / "钮关灯" / "你好关灯"）
  const span = findWakeWordSpan(cleaned, [wakeWord]);
  if (span) {
    return span.afterText.replace(LEADING_PUNCT_RE, "").replace(TRAILING_PUNCT_RE, "").trim();
  }

  // 3. 声学已确认唤醒词存在：尝试剥离常见误识别前缀（你好/你有/你又/你给/你欧/你哦/尼/妮/牛/妞/钮/你 + 1~4 字母残片）
  const strippedVoc = stripLeadingVocativeOrFragment(cleaned);
  if (strippedVoc !== cleaned) {
    if (isWakeQueryText(strippedVoc)) return "";
    if (looksLikeDirectDeviceCommand(strippedVoc)) return strippedVoc;
  }

  const mangledPrefixRe =
    /^(?:你好|您好|你有|你又|你给|你欧|你哦|你奥|你o|你0|尼奥|尼欧|妮奥|妮欧|尼哦|呢哦|里奥|利奥|米奥|尼|妮|牛|妞|钮|纽|你|new|near|neil|neal|nio|no|ne|he|hey)[\s,，。!！?？:：、]*/i;
  const m = mangledPrefixRe.exec(cleaned);
  if (m) {
    const rest = cleaned.slice(m[0].length).replace(LEADING_PUNCT_RE, "").replace(TRAILING_PUNCT_RE, "").trim();
    if (!rest || isWakeQueryText(rest) || PURE_WAKE_FILLER_RE.test(rest)) {
      return "";
    }
    if (looksLikeDirectDeviceCommand(rest) || (rest.length >= 2 && !/[\u3040-\u30ff\uac00-\ud7af]/.test(rest))) {
      return rest;
    }
  }

  // 句首孤立近音单/双字后紧跟停顿标点（如中文 ASR 将 "Neo，我觉得客厅有点暗呢" 听成 "六，我觉得客厅有点暗呢" / "流，..." / "那哦，..."），
  // 必须要求紧跟标点或空白，绝不误伤 "六点叫我起床" 等正常数词短语。
  const pausedAliasPrefixRe =
    /^(?:六|流|留|刘|溜|柳|略|呢|那|那哦|那我|你呀|您)[\s,，。!！?？:：、]+/;
  const pm = pausedAliasPrefixRe.exec(cleaned);
  if (pm) {
    const rest = cleaned.slice(pm[0].length).replace(LEADING_PUNCT_RE, "").replace(TRAILING_PUNCT_RE, "").trim();
    if (!rest || isWakeQueryText(rest) || PURE_WAKE_FILLER_RE.test(rest)) {
      return "";
    }
    if (looksLikeDirectDeviceCommand(rest) || (rest.length >= 2 && !/[\u3040-\u30ff\uac00-\ud7af]/.test(rest))) {
      return rest;
    }
  }
  if (/^(?:六|流|留|刘|溜|柳|略|呢|那|那哦|你呀|尼|妮|牛|妞|钮|纽)$/.test(cleaned)) {
    return "";
  }

  // 4. 若整句仅是日韩假名乱码（"2お" / "ニ요" / "を"）或 1 字拟声残片 -> 判定为纯唤醒
  if (/[\u3040-\u30ff\uac00-\ud7af]/.test(cleaned) || PURE_WAKE_FILLER_RE.test(cleaned)) {
    return "";
  }
  if (strippedVoc && !isWakeQueryText(strippedVoc) && !PURE_WAKE_FILLER_RE.test(strippedVoc)) {
    return strippedVoc;
  }
  return "";
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
  const isCustomRule = isCustomInstructionVoiceCommand(command);
  const kept: string[] = [parts[0]!];
  for (let i = 1; i < parts.length; i += 1) {
    const seg = parts[i]!;
    if (
      DIRECT_COMMAND_START_RE.test(seg) ||
      /(?:亮度|色温|颜色|音量|声音|静音|暂停|停止|关闭|打开|调到|调成|调大|调小|温度|湿度|出粮|份|度|%)/.test(seg) ||
      (isCustomRule &&
        /(?:默认|模式|自动|选择|判断|优先|记得|记住|规则|指令|洗衣|洗烘|智洗烘|空调|灯光|室外|室内|不要|超过|低于)/.test(
          seg,
        ))
    ) {
      kept.push(seg);
    } else {
      break;
    }
  }
  return kept.join("，").trim();
}

// 对话延续中非常明确的短指令特征（不包含告别/退出词，告别词由 EXPLICIT_EXIT_RE 单独处理）
const CLEAR_FOLLOWUP_RE =
  /^(?:再|稍微|稍微再|还是|那就|帮我再|把它|把音量|把亮度|把色温|调大|调小|大一点|小一点|高一点|低一点|亮一点|暗一点|暖一点|冷一点|关了吧|关掉|打开|暂停|继续|停止|停一下|停掉|结束播放|(?:别|不要)(?:再)?(?:放|播)|静音|取消静音|下一首|上一首|换一首|再来一份|出粮)/i;

// 仅当整句（去除标点空白后）完全由结束/告别短语构成时才触发零延迟退出连续对话，绝不误伤“好了，再把台灯关了”
const SINGLE_EXIT_PHRASE_SRC =
  "(?:好的?谢谢(?:你|啦|了)?|谢谢(?:你|啦|了)?|算了|取消|不用了?|没事了?|退下(?:吧)?|休息吧|再见|拜拜|退出对话|结束对话|先这样(?:吧)?|可以了|好了|行了|闭嘴|安静)";
export const EXPLICIT_EXIT_RE = new RegExp(`^(?:${SINGLE_EXIT_PHRASE_SRC}){1,3}$`, "i");

function normalizeForExit(text: string): string {
  return text.replace(/[\s,，。．.、!！?？:：;；\-—~～"'“”‘’]+/g, "").trim();
}

export function isExplicitExitPhrase(text: string): boolean {
  const norm = normalizeForExit(text);
  return norm.length > 0 && EXPLICIT_EXIT_RE.test(norm);
}

// 连续对话中仅含极简敷衍/收尾语气词的短语（无实质内容，SystemOne 低置信度时不应误触发新一轮 Agent 调用）
const BARE_WEAK_CLOSING_TOKEN_SRC =
  "(?:嗯+|哦+|喔+|啊+|呃+|好吧|行吧|算了吧?|没事了?|没关系|不用了?|就这样吧?|先这样吧?|知道了?|明白了?|懂了|好的?|ok|okay|fine|alright|nevermind|forgetit)";
const BARE_WEAK_CLOSING_RE = new RegExp(`^(?:那)?(?:${BARE_WEAK_CLOSING_TOKEN_SRC}){1,2}$`, "i");

// 连续对话中面向助手的叮嘱、提醒、改进要求或纠错反馈（如“那以后不要出现这种情况了”“下次注意一点”“以后别再听错了”）
const CONTEXTUAL_FOLLOWUP_ADMONISH_RE =
  /(?:(?:那)?(?:以后|下次|下回|之后|今后|往后).{0,10}(?:不要|别|不能|别再|不要再|记得|注意|小心|听清|听清楚|反应|快一点|快点|准一点|准确|靠谱|改|改进|优化|解决|避免|记住|保持|尽量)|(?:不要|别|不能)(?:再)?(?:出现|发生|这样|那样|搞错|弄错|听错|漏掉|漏听|忘记|忘了|卡|延迟|没反应|忽略|无视)|(?:下次|下回|以后)注意|长点心|记住[了啊呀吧]|记好[了啊呀吧]|don'?t\s+(?:let\s+(?:this|that)|do\s+that)\s+happen\s+again|next\s+time\b|make\s+sure\s+you\b|be\s+more\s+careful)/i;

// 连续对话中承接上文的回指/追问/反馈连接结构（如“那你刚才听到什么了”“刚刚为什么没反应”“这种问题怎么避免”“原来是这样”）
const CONTEXTUAL_FOLLOWUP_DISCOURSE_RE =
  /(?:^(?:那(?:你|以后|下次|刚才|刚刚|为什|为啥|怎么|是不是|岂不是|应该|可能|也|还|就|再|如果|要是|不是)|所以(?:你|刚才|刚刚|才|就|以后|下次)|但是(?:你|刚才|刚刚|它|现在|还是)|不过(?:你|刚才|刚刚|它|现在|还是)|可是(?:你|刚才|刚刚|它|现在|还是)|对了[，,\s]|顺便|另外|还有就是).{2,}|(?:你(?:刚才|刚刚|前面|上次|这次|现在|怎么|为什么|为啥|是不是|有没有|听清|听见|听到|没听|反应|记住|记得|明白|知道|能不|可以|搞错|弄错|确定))|(?:(?:刚才|刚刚|上一次|前两次|这次).{0,10}(?:为什么|为啥|怎么|没开|没关|没亮|没反应|没听清|听错|慢|快|不对|错了|成功|好了|情况|问题))|(?:(?:这种|这个|那个|刚才那个|上面那个)(?:情况|问题|错误|bug|现象|失误))|(?:为什么|为啥)(?:会|没|不|刚才|刚刚|这么|那么|还|又|要)|(?:难怪|怪不得|原来如此|原来是这样|这就对了|这就好多了|总算好了)|(?:怎么回事|怎么办|啥意思|什么意思|真的吗|确定吗|对不对|行不行|好了吗|成功了吗|听清了吗|听见了吗|听到了吗|明白了吗|记住了吗)[？?呀啊呢吗吧]*$)/i;

/**
 * 判断语句是否为无实质跟进内容的极简敷衍/收尾短语（如“嗯好吧”“行吧”“那算了”）。
 */
export function isBareWeakClosingPhrase(text: string): boolean {
  const norm = normalizeForExit(text);
  return norm.length > 0 && BARE_WEAK_CLOSING_RE.test(norm);
}

/**
 * 判断语句在连续对话中是否包含清晰的承接上文跟进/叮嘱/反馈/追问语用特征
 * （仅用于辅助化解 SystemOne 灰区低置信度判定，严禁用于绕过 BGM/旁白/明确退出护栏）。
 */
export function isContextualConversationFollowup(rawText: string, acousticEvent?: string): boolean {
  const cmd = rawText.replace(LEADING_PUNCT_RE, "").replace(TRAILING_PUNCT_RE, "").trim();
  if (cmd.length < 2 || cmd.length > 80) return false;
  if (isExplicitExitPhrase(cmd) || isBareWeakClosingPhrase(cmd)) return false;
  if (isNoiseOrGarbledFragment(cmd, acousticEvent)) return false;
  if (OBVIOUS_SIDETALK_RE.test(cmd) || NON_COMMAND_CHAT_RE.test(cmd)) return false;
  if (isThirdPersonNeoMention(cmd)) return false;
  return CONTEXTUAL_FOLLOWUP_ADMONISH_RE.test(cmd) || CONTEXTUAL_FOLLOWUP_DISCOURSE_RE.test(cmd);
}

// 连续对话中可独立成立的简短设备/播放/喂食控制指令（无需再提设备名）
const STANDALONE_CONVERSATION_CMD_RE =
  /^(?:(?:请|帮我|给我|麻烦|再|稍微|稍微再|还是|那就|帮我再|把它|把(?:它|这个|那个)?|先|快|赶紧|顺便)?(?:打开|开启|开一下|关掉|关闭|关上|关了吧|关一下|停一下|停掉|停止|暂停|继续|结束播放|(?:别|不要)(?:再)?(?:放|播)(?:了|歌|音乐)?|静音|取消静音|解除静音|恢复声音|闭麦|开麦|下一首|上一首|下一曲|上一曲|换一首|换首歌|切歌|换歌|再来一份|出粮|投喂|调大|调小|调亮|调暗|调高|调低|大一点|小一点|亮一点|暗一点|高一点|低一点|暖一点|冷一点|开灯|关灯|熄灯|灭灯|亮灯|全开|全关))(?:吧|呀|啊|哦|呢|一下|一点|一些|了)?$/i;

// 连续对话中明确面向智能家居设备的控制/查询动作词（防止“非常累的时候就会站在阳台凑出”等纯描述/电视旁白被误放行）
const CONVERSATION_ACTION_OR_QUERY_RE =
  /(?:打开|开启|开灯|关灯|熄灯|灭灯|亮灯|开机|关机|开空调|关空调|开风扇|关风扇|开窗|关窗|开电视|关电视|开音箱|关音箱|开音响|关音响|开插座|关插座|开开关|关开关|全开|全关|关掉|关闭|关上|开一下|关一下|调|设置|设定|设为|改成|换成|切换|播放|放一首|点一首|放首|来一首|来首|想听|听一首|放歌|放音乐|播音乐|听歌|切歌|换歌|换一首|换首歌|下一首|上一首|下一曲|上一曲|暂停|继续|停止|停一下|停掉|结束播放|静音|取消静音|解除静音|闭麦|开麦|朗读|播报|念一下|亮一点|暗一点|大一点|小一点|高一点|低一点|暖一点|冷一点|查|查看|查询|看看|多少|几度|怎么样|开着吗|关着吗|在线吗|出粮|投喂|喂食|喂猫|喂狗|执行|启动|模式|场景|让小爱|叫小爱|问小爱|对小爱说|小爱同学|turn\s+(?:on|off)|open|close|set|play|pause|stop|mute|unmute|dim|bright|check|what)/i;

// 连续对话唤醒窗口内对助手本身的明确问候或能力/设备/场景列表查询
const EXPLICIT_ASSISTANT_QUERY_RE =
  /^(?:(?:你好|您好|在吗|你在吗|在不在|你是谁|你能做什么|你会做什么|有什么功能|帮助|help)|(?:查看|看看|列出)?(?:家里)?(?:有)?(?:哪些|什么|所有|全部)?(?:设备|场景)|(?:设备|场景)列表)$/i;

// 明显非设备控制的描述/家务旁白信号（避免电视旁白/家务聊天在唤醒或对话窗口内误触发）
const NON_COMMAND_CHAT_RE =
  /(?:晚饭|午饭|早饭|吃什么|吃饭|火锅|烤鱼|筷子|倒水|杯水|递过来|递一下|拿一下|快递|外卖|垃圾|收拾一下|加班|太累了|早点睡|接电话|雨伞|电影票|上班|地铁|泡茶|好像|有点松|修好之后|挺好的|挺好看|挺舒服|舒服多了|亮多了|真不错|很好听|什么时候买)/;

/**
 * 判断连续对话窗口中（无唤醒词）的语句是否为明确的智能家居控制/查询/助手指令，
 * 防止环境噪声、背景歌词、电视广播或咖啡馆杂音因含“现在/把/再/阳台”等泛化词被误当作指令并无限续期对话窗口。
 */
export function isClearConversationCommand(rawCmd: string): boolean {
  const cmd = rawCmd.replace(LEADING_PUNCT_RE, "").replace(TRAILING_PUNCT_RE, "").trim();
  if (cmd.length < 2) return false;
  if (isCustomInstructionVoiceCommand(cmd) && cmd.length <= 160) {
    return true;
  }
  if (cmd.length > 36) return false;
  if (NON_COMMAND_CHAT_RE.test(cmd)) return false;
  if (STANDALONE_CONVERSATION_CMD_RE.test(cmd)) return true;
  if (EXPLICIT_ASSISTANT_QUERY_RE.test(cmd)) return true;
  if (/^(?:让小爱|叫小爱|问小爱|对小爱说|小爱同学)/.test(cmd)) return true;
  if (hasSmartHomeDomainIntent(cmd) && CONVERSATION_ACTION_OR_QUERY_RE.test(cmd)) {
    return true;
  }
  return false;
}

/**
 * 判断无唤醒词文本是否为明显的噪声/BGM 识别幻觉碎片（如单字、纯停用词 "The."/"I."、或跨语种假名/韩文乱码）。
 */
export function isNoiseOrGarbledFragment(rawText: string, acousticEvent?: string): boolean {
  const cmd = rawText.replace(LEADING_PUNCT_RE, "").replace(TRAILING_PUNCT_RE, "").trim();
  const meaningful = cmd.replace(/[\s,，。．.、!！?？:：;；\-—~～"'“”‘’()（）[\]【】]/g, "");
  if (meaningful.length <= 1) return true;
  if (isPureNonSpeechEvent(acousticEvent, cmd)) return true;
  // 连续对话（无唤醒词）中出现日韩假名/谚文乱码且无智能家居意图 -> 典型 SenseVoice 噪声幻觉
  if (/[\u3040-\u30ff\uac00-\ud7af]/.test(cmd) && !hasSmartHomeDomainIntent(cmd)) {
    return true;
  }
  // 纯英文短停用词幻觉（如 BGM/键盘声被误听为 "The." / "You." / "So it"）
  if (/^[a-z0-9\s'.,!?-]+$/i.test(cmd)) {
    const tokens = cmd
      .toLowerCase()
      .replace(/[^a-z\s]/g, " ")
      .split(/\s+/)
      .filter(Boolean);
    if (
      tokens.length > 0 &&
      tokens.length <= 2 &&
      tokens.every((t) => t.length <= 2 || COMMON_EN_STOPWORDS.has(t)) &&
      !hasSmartHomeDomainIntent(cmd) &&
      !STANDALONE_CONVERSATION_CMD_RE.test(cmd) &&
      !EXPLICIT_EXIT_RE.test(normalizeForExit(cmd))
    ) {
      return true;
    }
  }
  return false;
}

// 明显是家庭/旁白聊天的负向模式（纯语气词必须整句锚定 `$`，避免误杀“嗯，用右筒”/“好的，开启袜子筒”）
const OBVIOUS_SIDETALK_RE =
  /^(?:(?:嗯+|啊+|哦+|呃+|哈哈+|呵呵+)[\s,，。！!？?]*$|(?:晚饭|午饭|早饭|吃什么|吃饭|喝水|拿一下|递一下|我去|你去|他去|待会出去|出门|快递|外卖|睡觉了吗|几点回来|明天上班))/i;

// 助手回复中包含待用户作答的开放问题/选项/澄清请求（用于 SystemOne 离线或不可用时的兜底判定）
const OPEN_ASSISTANT_QUESTION_RE =
  /(?:[?？]\s*$|请问|选哪个|选哪一个|选哪种|方案一[\s\S]{0,40}方案二|哪一台|哪个房间|哪个设备|要开吗|要关吗|需要我.{0,16}吗|是否需要|要不要|想选|你想.{0,12}吗|你希望|请确认|确认一下|告诉我|which\s+one|would\s+you\s+like|do\s+you\s+want|please\s+confirm)/i;

const POLITE_CLOSING_PROMPT_RE =
  /^(?:还有(?:什么|其他|别的)?(?:需要|可以)?(?:帮|协助).{0,10}[?？]?|还需要(?:什么|别的)吗[?？]?|anything\s+else\??)$/i;

const SHORT_QUESTION_REPLY_RE =
  /^(?:好|嗯|对|是|行|要|开|关|一|二|三|1|2|3|ok|yes|no)$/i;

/**
 * 判断助手最新一句回复是否明确包含等待用户作答的问题/选项/澄清。
 */
export function assistantReplyExpectsUserResponse(reply: string | undefined): boolean {
  const trimmed = (reply ?? "").trim();
  if (!trimmed) return false;
  const clauses = trimmed
    .split(/[。！!\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const tailClause = clauses[clauses.length - 1] ?? trimmed;
  if (POLITE_CLOSING_PROMPT_RE.test(tailClause)) {
    return false;
  }
  return OPEN_ASSISTANT_QUESTION_RE.test(trimmed);
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 计算当前识别文本与 MijiaDeck 刚刚播报的 TTS 文本的字符重叠度（用于抑制扬声器自回声，支持口语数字/单位对齐）。
 */
export function computeEchoOverlap(transcript: string, lastSpoken: string): number {
  return computeEnhancedEchoOverlap(transcript, lastSpoken);
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
        // 问候类别名（如 "你好" / "你给"）绝不可作为纯唤醒询问触发，且必须位于句首并紧跟明确智能家居控制指令（如 "你好关灯"，拦截 "你好，帮我递杯水"）
        if (COMMAND_ONLY_NOISE_ALIASES.has(cand.surface)) {
          if (
            beforeText.length > 0 ||
            isWakeQuery ||
            afterText.length < 2 ||
            !DIRECT_COMMAND_START_RE.test(afterText) ||
            !SMART_HOME_DOMAIN_RE.test(afterText)
          ) {
            continue;
          }
        }
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
        if (!isWakeQuery && (!afterText || !looksLikeDirectDeviceCommand(afterText))) {
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
          .slice(-5)
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
    "- 若用户直接呼唤你执行设备控制/查询/提问或保存/管理长期附加指令规则（如“小派，关灯”、“帮我把音量调大一点”、“那卧室灯也关掉”、“以后记得洗衣默认用智洗烘模式”、“以后我说打开空调你要自己判断室外温度”），或在连续对话中承接上文对你进行叮嘱、提醒、批评、反馈或自然追问（如“那以后不要出现这种情况了”、“下次注意一点”、“刚刚为什么没反应”），addressed=true。",
    "- 唤醒词判定或条件：若句子中存在明确的控制智能家居设备指令（如开关或调节灯光、空调、风扇、窗帘、电视、音箱/音乐、洗衣机、扫地机、加湿器/净化器、插座、喂食器、场景模式等），即使唤醒词被误听、吞字或位于句中，也判定 addressed=true 放行不拦截，并在 command 字段中提取干净的控制设备指令。",
    "- 注意背景音乐/电视干扰：如果环境中正在放歌，唤醒词前后可能混入无关歌词碎片（例如“也甘愿赴汤蹈火去走小派打开客厅吸顶灯，间走过这世间”）。只要唤醒词后紧跟明确的设备控制/查询指令，就判定 addressed=true，并在 command 字段中只提取干净的用户指令（去掉前后无关歌词）！",
    "- 若用户只是提到你的名字讨论/夸奖/抱怨/叫别人别管你（如“我刚跟朋友聊到小派挺好用的”、“你觉得小派怎么样”、“别管小派了吃饭吧”、“有人叫小派吗”），addressed=false！",
    "- 若处于连续对话窗口，但新句子明显是在和家人说话（如“晚饭吃什么”、“帮我拿双筷子”），或属于背景音乐歌词、电视广播对话、咖啡馆/环境杂音识别碎片，addressed=false, inConversation=false！",
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
  let cleaned = input.rawText.trim();
  const inConversationEffective =
    input.dialogState === "conversation" || Boolean(input.inConversation) || Boolean(input.awakeActive);
  let echoStripped = false;
  const wrap = (
    partial: Omit<AttentionDecision, "latencyMs">,
  ): AttentionDecision => ({
    ...partial,
    ...(echoStripped ? { echoStripped: true, selectedText: partial.selectedText ?? cleaned } : {}),
    latencyMs: Math.round(performance.now() - t0),
  });

  if (!cleaned) {
    return wrap({
      accept: false,
      wokeOnly: false,
      addressed: false,
      inConversation: inConversationEffective,
      confidence: 1,
      stage: "no-wake",
      reason: "识别结果为空",
      wakeWord: null,
      command: "",
      usedLlm: false,
    });
  }

  // 0. 静音/热词 Prompt 回显幻觉拦截（如 Qwen3-ASR 静音复读“嘿Neo 尼奥 鸟 嘿6 Neo”或“感谢观看”字幕幻觉）
  if (isAsrHallucinationText(cleaned, input.wakeWords)) {
    return wrap({
      accept: false,
      wokeOnly: false,
      addressed: false,
      inConversation: inConversationEffective,
      confidence: 0.96,
      stage: "acoustic",
      reason: "检测到 ASR 静音或热词回显幻觉，已自动忽略",
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

  let wakeSpan = findWakeWordSpan(cleaned, input.wakeWords);

  // 0B. 多语段实时 TTS 自回声防护 + 双讲回声残片剥离（兼容多条排队播报、口语数字单位对齐与声纹加权）
  // 注意：绝不把用户紧跟其后说出的反向控制指令或明确唤醒词指令误杀为自回声！
  const hasEchoContext = Boolean(
    (input.recentSpokenUtterances && input.recentSpokenUtterances.length > 0) ||
      (input.lastSpokenReply && input.lastSpokenAt),
  );
  if (!input.bypassWakeWord && hasEchoContext) {
    const echoEval = evaluateTtsEcho({
      transcript: cleaned,
      now,
      mode: input.echoCancellationMode ?? "auto",
      duringTtsPlayback: input.duringTtsPlayback,
      ttsActive: input.ttsActive,
      hasWakeWord: Boolean(wakeSpan),
      looksDirectCommand: DIRECT_COMMAND_START_RE.test(cleaned),
      voiceprint: input.voiceprint,
      recentUtterances: input.recentSpokenUtterances,
      legacyLastSpokenReply: input.lastSpokenReply,
      legacyLastSpokenAt: input.lastSpokenAt,
      strictConfirmationGuard: Boolean(input.pendingConfirmation),
      confirmationPromptEnqueuedAt: input.pendingConfirmation?.createdAt,
    });

    if (echoEval.isEcho) {
      return wrap({
        accept: false,
        wokeOnly: false,
        addressed: false,
        inConversation: inConversationEffective,
        confidence: Math.max(0.75, echoEval.score),
        stage: "echo",
        reason: echoEval.reason || "检测到系统语音播报回声，已自动抑制",
        wakeWord: null,
        command: "",
        usedLlm: false,
      });
    }

    // 双讲混入播报残片：剥离前后回声残片后，用干净的用户指令继续后续唤醒与注意力门控
    if (echoEval.strippedTranscript && echoEval.strippedTranscript !== cleaned) {
      cleaned = echoEval.strippedTranscript;
      echoStripped = true;
      wakeSpan = findWakeWordSpan(cleaned, input.wakeWords);
    } else if (echoEval.grayZone && input.systemOneClient?.enabled) {
      // 灰区：调用 SystemOne 判别是回声残片还是用户反向新指令
      const echoVerdict = await input.systemOneClient.classifyEchoOrCommand({
        lastSpoken: echoEval.matchedUtterance || input.lastSpokenReply || "",
        heard: cleaned,
      });
      if (echoVerdict?.isEcho) {
        return wrap({
          accept: false,
          wokeOnly: false,
          addressed: false,
          inConversation: inConversationEffective,
          confidence: echoVerdict.confidence,
          stage: "echo",
          reason: "SystemOne 判定为系统语音播报回声，已自动抑制",
          wakeWord: null,
          command: "",
          usedLlm: true,
        });
      }
    }
  }

  // 0C. 声学非语音事件过滤（仅拦截无有效指令文本的纯背景音乐/掌声/笑声）
  if (!input.bypassWakeWord && !wakeSpan && isPureNonSpeechEvent(input.acousticEvent, cleaned)) {
    return wrap({
      accept: false,
      wokeOnly: false,
      addressed: false,
      inConversation: inConversationEffective,
      confidence: 0.9,
      stage: "acoustic",
      reason: `识别为纯环境声学事件 (${input.acousticEvent})，非用户指令`,
      wakeWord: null,
      command: "",
      usedLlm: false,
    });
  }

  // 0C-bis. 待确认优先通道（PendingConfirmation Lane）：
  // 当系统刚向用户发出确认提问（如“要用洗衣机的袜子筒帮你洗袜子吗？”）时，
  // 必须抢在 EXPLICIT_EXIT_RE（算了/取消/不用了）与 isNoiseOrGarbledFragment（单字 嗯/好/对/是/要）之前处理！
  if (input.pendingConfirmation && now <= input.pendingConfirmation.expiresAt) {
    const pendingCtx = input.pendingConfirmation;
    // 反回声不应期护栏：确认提问 TTS 播报刚结束 450ms 内屏蔽非手动语音，防尾部回声误自确认
    if (
      !input.bypassWakeWord &&
      pendingCtx.promptEndedAt !== null &&
      now >= pendingCtx.promptEndedAt &&
      now - pendingCtx.promptEndedAt < 450
    ) {
      return wrap({
        accept: false,
        wokeOnly: false,
        addressed: false,
        inConversation: true,
        confidence: 0.94,
        stage: "echo",
        reason: "确认提问播报刚结束处于 450ms 防回声保护窗，已忽略",
        wakeWord: null,
        command: "",
        usedLlm: false,
      });
    }

    const replyCandidate = wakeSpan ? wakeSpan.afterText.trim() || cleaned : cleaned;
    const replyKind = classifyConfirmationReply(
      replyCandidate,
      {
        id: pendingCtx.id,
        origin: "new_implicit",
        canonicalKey: "",
        originalUtterance: pendingCtx.originalUtterance,
        questionText: pendingCtx.questionText,
        summary: pendingCtx.summary,
        binding: { did: "", deviceName: "", capabilityKey: "", steps: [] },
        riskLevel: "L2_MEDIUM_APPLIANCE",
        topologyHash: "",
        conflictDomains: [],
        speakerScope: "global",
        createdAt: pendingCtx.createdAt,
        expiresAt: pendingCtx.expiresAt,
        promptEndedAt: pendingCtx.promptEndedAt,
        consumed: false,
      },
      { source: input.bypassWakeWord ? "web" : "voice" },
    );

    if (replyKind.kind === "echo_suspected" && !input.bypassWakeWord) {
      return wrap({
        accept: false,
        wokeOnly: false,
        addressed: false,
        inConversation: true,
        confidence: 0.92,
        stage: "echo",
        reason: `疑似确认提问 TTS 回声（${replyKind.reason}），已拦截防自确认`,
        wakeWord: null,
        command: "",
        usedLlm: false,
      });
    }

    if (
      replyKind.kind === "affirm" ||
      replyKind.kind === "reject_once" ||
      replyKind.kind === "reject_mapping" ||
      replyKind.kind === "modify" ||
      replyKind.kind === "select_candidate"
    ) {
      const cmdClean = replyCandidate.replace(LEADING_PUNCT_RE, "").replace(TRAILING_PUNCT_RE, "").trim();
      return wrap({
        accept: true,
        wokeOnly: false,
        addressed: true,
        inConversation: true,
        confidence: 0.96,
        stage: "pending-confirm",
        passSource: "pending_confirmation",
        reason: `待确认会话收到用户回复（${replyKind.kind}）`,
        wakeWord: wakeSpan?.wakeWord ?? null,
        command: cmdClean || replyCandidate,
        usedLlm: false,
      });
    }
    // 若用户说了全新无关指令（unrelated_new_command），则自然落入后续正常唤醒/对话评估流程
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
    if (hasExplicitDeviceControlCommand(cleaned, input.capabilityDigest)) {
      const cmd = stripLeadingControlFiller(cleaned);
      return wrap({
        accept: true,
        wokeOnly: false,
        addressed: true,
        inConversation: true,
        confidence: 0.86,
        stage: "fast-wake",
        passSource: "device_command",
        reason: "未包含唤醒词，但检测到明确控制设备指令，放行不拦截",
        wakeWord: null,
        command: cmd,
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
      reason: "未包含唤醒词或控制设备指令",
      wakeWord: null,
      command: "",
      usedLlm: false,
    });
  }

  // ==================== 情况 A：句子中提到了唤醒词 ====================
  if (wakeSpan) {
    const cleanBefore = wakeSpan.beforeText;
    const cleanAfter = stripRepeatedLeadingWakeWords(
      wakeSpan.afterText,
      wakeSpan.wakeWord,
      input.wakeWords,
    );
    const hasVocativeStart =
      cleanBefore.length === 0 || VOCATIVE_PREFIX_RE.test(cleanBefore);
    const hasReferentialBefore =
      cleanBefore.length > 0 && REFERENTIAL_BEFORE_RE.test(cleanBefore);
    const hasReferentialAfter =
      cleanAfter.length > 0 && REFERENTIAL_AFTER_RE.test(cleanAfter);
    const looksDirectCommand =
      cleanAfter.length > 0 && looksLikeDirectDeviceCommand(cleanAfter);
    const wakeCapMatch =
      cleanAfter.length > 0 ? probeImplicitCapabilities(cleanAfter, input.capabilityDigest) : null;
    const isBgmContext = Boolean(input.acousticEvent?.toUpperCase().includes("BGM"));
    const trimmedCmd = isBgmContext ? trimTrailingMusicLyrics(cleanAfter) : cleanAfter;
    const hasExplicitDeviceCmd =
      hasExplicitDeviceControlCommand(cleanAfter, input.capabilityDigest) ||
      hasExplicitDeviceControlCommand(cleaned, input.capabilityDigest);
    const extractedDeviceCmd = hasExplicitDeviceCmd
      ? extractDeviceControlCommand(
          isBgmContext ? trimTrailingMusicLyrics(cleaned) : cleaned,
          wakeSpan,
          cleanBefore,
          trimmedCmd,
          input.capabilityDigest,
        )
      : "";

    // 混合 openWakeWord 声学否决：仅由模糊同音/噪声别名命中，且该唤醒词已启用本地声学原型但声学分低于门槛（用户实录原型 0.42 / TTS 零样本原型 0.32）时拦截；
    // 或条件：若存在明确控制设备指令，则不因声学否决误拦（smart 模式直接放行，strict 模式交由 SystemOne 复核）。
    const vetoFloor = input.acousticWake?.source === "tts-bootstrap" ? 0.32 : 0.42;
    if (
      wakeSpan.fuzzy &&
      input.owwActiveForWord === true &&
      (!input.acousticWake || input.acousticWake.score < vetoFloor)
    ) {
      if (!hasExplicitDeviceCmd) {
        return wrap({
          accept: false,
          wokeOnly: false,
          addressed: false,
          inConversation: inConversationEffective,
          confidence: 0.9,
          stage: "acoustic-veto",
          reason: `模糊唤醒词「${wakeSpan.matchedSurface}」未通过本地声学唤醒校验${
            input.acousticWake
              ? `（得分 ${(input.acousticWake.score * 100).toFixed(0)}% < ${Math.round(vetoFloor * 100)}%）`
              : "（无声学命中）"
          }，已拦截误触发`,
          wakeWord: wakeSpan.wakeWord,
          command: "",
          usedLlm: false,
        });
      }
      if (input.attentionMode !== "strict" || !input.systemOneClient?.enabled) {
        return wrap({
          accept: true,
          wokeOnly: false,
          addressed: true,
          inConversation: true,
          confidence: 0.88,
          stage: "fast-wake",
          passSource: "device_command",
          reason: "模糊唤醒词未达声学阈值，但检测到明确控制设备指令，放行不拦截",
          wakeWord: null,
          command: extractedDeviceCmd || trimmedCmd || cleaned,
          usedLlm: false,
        });
      }
    }

    // 若在连续对话中带唤醒词发出纯退出指令（如“小派，退下” / “小派，再见”）
    if (
      inConversationEffective &&
      hasVocativeStart &&
      !hasReferentialBefore &&
      cleanAfter.length > 0 &&
      EXPLICIT_EXIT_RE.test(normalizeForExit(cleanAfter))
    ) {
      return wrap({
        accept: false,
        exitConversation: true,
        wokeOnly: false,
        addressed: true,
        inConversation: false,
        confidence: 0.96,
        stage: "exit",
        reason: "用户主动结束对话，回到待机模式",
        wakeWord: wakeSpan.wakeWord,
        command: "",
        usedLlm: false,
      });
    }

    // A1. 精确非模糊纯呼唤（例如“小派”、“嘿，小派”、“小派在吗”）
    const wakeOnlyPhrase =
      hasVocativeStart &&
      !hasReferentialBefore &&
      (cleanAfter.length === 0 || /^(?:在吗|你在吗|在不在|你好|您好)$/i.test(cleanAfter));
    if (!wakeSpan.fuzzy && wakeOnlyPhrase && input.attentionMode !== "strict") {
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

    // A2. 精确非模糊句首呼唤 + 清晰控制指令或命中家庭设备隐式能力（smart 模式、无第三人称语境）-> 0ms 快速通道
    // 背景音乐下若后半句本身已命中明确智能家居域指令（如“Neo，停止播放音乐”），也 0ms 直通免等待云端往返
    if (
      !wakeSpan.fuzzy &&
      input.attentionMode === "smart" &&
      !hasReferentialBefore &&
      !hasReferentialAfter &&
      (looksDirectCommand || Boolean(wakeCapMatch)) &&
      hasVocativeStart &&
      (!isBgmContext || hasSmartHomeDomainIntent(trimmedCmd) || Boolean(wakeCapMatch))
    ) {
      return wrap({
        accept: true,
        wokeOnly: false,
        addressed: true,
        inConversation: true,
        confidence: isBgmContext ? 0.91 : 0.94,
        stage: "fast-wake",
        passSource: wakeCapMatch && !looksDirectCommand ? "implicit_capability" : "explicit_command",
        matchedCapability: wakeCapMatch?.matchedCapabilityLabel,
        reason:
          wakeCapMatch && !looksDirectCommand
            ? `句首呼唤「${wakeSpan.wakeWord}」并命中设备能力「${wakeCapMatch.matchedCapabilityLabel}」`
            : `句首明确呼唤「${wakeSpan.wakeWord}」并下达操作指令`,
        wakeWord: wakeSpan.wakeWord,
        command: trimmedCmd,
        usedLlm: false,
      });
    }

    // A2-bis. 强声学唤醒 + 句首谐音别名 + 明确非疑问智能家居指令双重确认（如 openWakeWord「Neo」0.80 + “你有播放点音乐吧。”）-> 0ms 直通
    const strongAcousticMatchForWake = Boolean(
      input.acousticWake?.matched &&
        input.acousticWake.wakeWord.toLowerCase() === wakeSpan.wakeWord.toLowerCase() &&
        input.acousticWake.score >= Math.max(0.72, input.acousticWake.threshold + 0.08),
    );
    const rawTailAfterWake = cleaned.slice(wakeSpan.endIndex).trim();
    const endsLikeQuestion = /[吗嘛么呢？?][\s。!！]*$/.test(rawTailAfterWake);
    if (
      wakeSpan.fuzzy &&
      strongAcousticMatchForWake &&
      input.attentionMode === "smart" &&
      hasVocativeStart &&
      !hasReferentialBefore &&
      !hasReferentialAfter &&
      !endsLikeQuestion &&
      cleanAfter.length >= 2 &&
      (looksDirectCommand || Boolean(wakeCapMatch)) &&
      (hasSmartHomeDomainIntent(trimmedCmd) || Boolean(wakeCapMatch))
    ) {
      return wrap({
        accept: true,
        wokeOnly: false,
        addressed: true,
        inConversation: true,
        confidence: Math.max(0.9, input.acousticWake!.score),
        stage: "fast-wake",
        passSource: wakeCapMatch && !looksDirectCommand ? "implicit_capability" : "acoustic_wake_recovery",
        matchedCapability: wakeCapMatch?.matchedCapabilityLabel,
        reason: `声学唤醒「${wakeSpan.wakeWord}」(${input.acousticWake!.score.toFixed(2)})与句首近音「${wakeSpan.matchedSurface}」双重确认，直接进入下一流程`,
        wakeWord: wakeSpan.wakeWord,
        command: trimmedCmd,
        usedLlm: false,
      });
    }

    // A3-1. 主通道：SystemOne 唤醒词判定（或条件：确认为触发词 OR 存在控制设备指令，满足任一即放行不拦截）
    let sysOneTransientFailure = false;
    if (input.systemOneClient?.enabled) {
      const aliasHint = buildSuspectedWakeAliasHint(cleaned, wakeSpan, input.acousticWake);
      const acousticSignal =
        aliasHint && input.acousticWake?.matched
          ? {
              wakeWord: input.acousticWake.wakeWord,
              score: input.acousticWake.score,
              matched: true,
            }
          : null;
      const s1 = await input.systemOneClient.evaluateWakeAttention(
        {
          utterance: cleaned,
          wakeWords: input.wakeWords,
          ...(aliasHint ? { suspectedWakeAlias: aliasHint } : {}),
          ...(acousticSignal ? { acousticWake: acousticSignal } : {}),
        },
        {
          strict: input.attentionMode === "strict",
        },
      );
      if (s1) {
        if (!s1.accepted) {
          return wrap({
            accept: false,
            wokeOnly: false,
            addressed: false,
            inConversation: inConversationEffective,
            confidence: s1.confidence,
            stage: "systemone-attention",
            reason:
              s1.decision === "false_wake"
                ? "SystemOne 判定为误听/误唤醒且无控制设备指令，未触发执行"
                : "SystemOne 唤醒与指令校验置信度低于阈值，已保守忽略",
            wakeWord: wakeSpan.wakeWord,
            command: "",
            usedLlm: true,
          });
        }

        const acceptedByDeviceCmd = s1.acceptedBy === "device_command";
        const extractedCmd = acceptedByDeviceCmd
          ? extractDeviceControlCommand(
              cleaned,
              wakeSpan,
              cleanBefore,
              cleanAfter,
              input.capabilityDigest,
            )
          : cleanAfter
            ? cleanAfter
            : cleanBefore &&
                !VOCATIVE_PREFIX_RE.test(cleanBefore) &&
                !REFERENTIAL_BEFORE_RE.test(cleanBefore)
              ? cleanBefore
              : "";

        return wrap({
          accept: true,
          wokeOnly: acceptedByDeviceCmd ? false : extractedCmd.length === 0,
          addressed: true,
          inConversation: true,
          confidence: acceptedByDeviceCmd ? s1.deviceCommand.confidence : s1.confidence,
          stage: "systemone-attention",
          passSource: acceptedByDeviceCmd ? "device_command" : "systemone",
          reason: acceptedByDeviceCmd
            ? "SystemOne 检测到控制设备指令，放行进入下一流程"
            : extractedCmd.length === 0
              ? `SystemOne 确认触发词「${wakeSpan.wakeWord}」非误听，进入下一流程`
              : `SystemOne 确认触发词「${wakeSpan.wakeWord}」非误听，直接进入下一流程`,
          wakeWord: wakeSpan.wakeWord,
          command: extractedCmd,
          usedLlm: true,
        });
      }
      const fk = input.systemOneClient.lastFailureKind;
      sysOneTransientFailure = fk === "timeout" || fk === "network";
    }

    // A3-2. 预算感知降级：仅当 SystemOne 未启用或返回 unsupported/auth 时才回退到生成式 llmEvaluator；
    // 若 SystemOne 已因 timeout/network 消耗延迟预算，直接进入 A4 零延迟确定性语用规则！
    if (input.llmEvaluator && !sysOneTransientFailure) {
      const prompt = buildAttentionPrompt({
        text: cleaned,
        wakeWords: input.wakeWords,
        wakeSpan,
        awakeActive: Boolean(input.awakeActive),
        inConversation: inConversationEffective,
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

    // A4. 无 LLM（如本地引擎离线运行或超时兜底）时的确定性语用判别：
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

    // 或条件：即使唤醒词位于句中或带第三人称前文，只要包含明确控制设备指令仍放行不拦截
    if (hasExplicitDeviceCmd) {
      return wrap({
        accept: true,
        wokeOnly: false,
        addressed: true,
        inConversation: true,
        confidence: 0.86,
        stage: "fast-wake",
        passSource: "device_command",
        reason: "检测到明确控制设备指令，放行进入下一流程",
        wakeWord: wakeSpan.wakeWord,
        command: extractedDeviceCmd || trimmedCmd || cleaned,
        usedLlm: false,
      });
    }

    if (hasReferentialBefore || hasReferentialAfter || !hasVocativeStart) {
      return wrap({
        accept: false,
        wokeOnly: false,
        addressed: false,
        inConversation: inConversationEffective,
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

  // ==================== 情况 B：无唤醒词，但处于连续对话状态或显式唤醒窗口 ====================
  if (inConversationEffective) {
    const cmd = cleaned.replace(LEADING_PUNCT_RE, "").replace(TRAILING_PUNCT_RE, "").trim();

    // B1. 纯独立结束对话口令 -> 0ms 退出连续对话并回到待机
    const normalizedExit = normalizeForExit(cmd);
    if (normalizedExit.length > 0 && EXPLICIT_EXIT_RE.test(normalizedExit)) {
      return wrap({
        accept: false,
        exitConversation: true,
        wokeOnly: false,
        addressed: true,
        inConversation: false,
        confidence: 0.96,
        stage: "exit",
        reason: "识别到明确结束对话口令，已回到待机模式",
        wakeWord: null,
        command: "",
        usedLlm: false,
      });
    }

    // B2. 明显是旁白/噪声幻觉碎片 -> 0ms 忽略并保留剩余对话窗口
    // 注意：若助手上一句刚刚向用户提出明确问题/选项，允许“好/嗯/对/一/二”等极短作答进入后续决策（绝不误杀为噪声）
    const isBgmConv = Boolean(input.acousticEvent?.toUpperCase().includes("BGM"));
    const latestTurn =
      input.recentTurns && input.recentTurns.length > 0
        ? input.recentTurns[input.recentTurns.length - 1]
        : null;
    const isShortReplyToAssistantQuestion = Boolean(
      !isBgmConv &&
        latestTurn?.role === "assistant" &&
        assistantReplyExpectsUserResponse(latestTurn.text) &&
        SHORT_QUESTION_REPLY_RE.test(cmd),
    );
    if (!isShortReplyToAssistantQuestion && isNoiseOrGarbledFragment(cmd, input.acousticEvent)) {
      return wrap({
        accept: false,
        wokeOnly: false,
        addressed: false,
        inConversation: true,
        confidence: 0.9,
        stage: "acoustic",
        reason: "识别为环境噪声/背景音识别碎片，未触发设备控制",
        wakeWord: null,
        command: "",
        usedLlm: false,
      });
    }
    if (!isShortReplyToAssistantQuestion && OBVIOUS_SIDETALK_RE.test(cmd)) {
      return wrap({
        accept: false,
        wokeOnly: false,
        addressed: false,
        inConversation: true,
        confidence: 0.88,
        stage: "pragmatic-reject",
        reason: "判定为非定向旁白/环境闲聊，未触发设备控制",
        wakeWord: null,
        command: "",
        usedLlm: false,
      });
    }

    // B2.5. 连续对话中的明确直接智能家居控制指令、语音附加指令规则或命中家庭设备隐式能力（smart 模式、非 BGM）：
    // 借鉴 Home Assistant 本地确定性意图优先原则，0ms 直通免等待云端 SystemOne 往返；
    // 隐式情感/无设备匹配语句与家庭闲聊仍交由 SystemOne 语义决策。
    const isClearDeviceCmd = isClearConversationCommand(cmd);
    const isCustomRuleCmd = isCustomInstructionVoiceCommand(cmd) && cmd.length <= 160;
    const convCapMatch = probeImplicitCapabilities(cmd, input.capabilityDigest);
    const strongImplicitCap = Boolean(
      convCapMatch &&
        (input.acousticWake?.matched ||
          /^(?:请|帮我|给我|替我|麻烦|开启|启动|打开|关|停|洗|烘|扫|拖|浇|喂)/.test(cmd) ||
          input.learnedTriggers?.some((t) => t && cmd.includes(t))),
    );
    if (
      input.attentionMode === "smart" &&
      !isBgmConv &&
      ((cmd.length <= 18 && DIRECT_COMMAND_START_RE.test(cmd) && isClearDeviceCmd) ||
        isCustomRuleCmd ||
        strongImplicitCap)
    ) {
      return wrap({
        accept: true,
        wokeOnly: false,
        addressed: true,
        inConversation: true,
        confidence: strongImplicitCap ? 0.93 : 0.92,
        stage: "fast-followup",
        passSource: isCustomRuleCmd
          ? "custom_instruction"
          : strongImplicitCap
            ? "implicit_capability"
            : "explicit_command",
        matchedCapability: convCapMatch?.matchedCapabilityLabel,
        reason: isCustomRuleCmd
          ? "识别到语音附加指令规则操作"
          : strongImplicitCap && convCapMatch
            ? `命中家庭设备能力「${convCapMatch.matchedCapabilityLabel}」，交由 Pi Agent 确认/执行`
            : input.awakeActive
              ? "唤醒窗口内明确设备控制指令"
              : "连续对话中明确设备控制指令（本地快速直通）",
        wakeWord: input.acousticWake?.matched ? input.acousticWake.wakeWord : null,
        command: cmd,
        usedLlm: false,
      });
    }

    // B3. 主通道：SystemOne 5 轮连续对话决策（karpo/karpo-decision-31b）
    let sysOneTransientFailure = false;
    if (input.systemOneClient?.enabled) {
      const recentHistory = (input.recentTurns ?? []).slice(-5).map((t) => ({
        role: t.role,
        text: t.text,
      }));
      const voiceprintMatched = Boolean(input.voiceprint?.evaluated && input.voiceprint.matched);
      const voiceprintRejectedOther = Boolean(
        input.voiceprint?.evaluated &&
          input.voiceprint.enrolledCount > 0 &&
          !input.voiceprint.matched,
      );
      const sameConversationSpeaker = Boolean(
        voiceprintMatched &&
          input.voiceprint?.speakerName &&
          input.conversationSpeakerName &&
          input.voiceprint.speakerName === input.conversationSpeakerName,
      );
      const s1 = await input.systemOneClient.evaluateConversationTurn(
        {
          utterance: cleaned,
          altUtterance: input.altText,
          recentHistory,
          wakeWords: input.wakeWords,
          lastSpokenReply: input.lastSpokenReply,
          acousticEvent: input.acousticEvent,
          speakerName: input.voiceprint?.speakerName ?? null,
          ...(sameConversationSpeaker ? { sameSpeaker: true } : {}),
          acousticWake: input.acousticWake
            ? { wakeWord: input.acousticWake.wakeWord, score: input.acousticWake.score }
            : null,
          homeCapabilities: input.capabilityDigest?.summaryLines,
          learnedTriggers: input.learnedTriggers,
          pendingConfirmation: input.pendingConfirmation
            ? {
                questionText: input.pendingConfirmation.questionText,
                summary: input.pendingConfirmation.summary,
              }
            : null,
          capabilityDigestHash: input.capabilityDigest?.topologyHash,
        },
        {
          includeIntent: true,
          strict: input.attentionMode === "strict",
        },
      );
      if (s1) {
        if (s1.asrBest?.choice === "neither_noise" && s1.asrBest.confidence >= 0.75) {
          return wrap({
            accept: false,
            wokeOnly: false,
            addressed: false,
            inConversation: true,
            confidence: s1.asrBest.confidence,
            stage: "systemone-attention",
            reason: "SystemOne 判定为背景噪声/歌词，保留对话窗口",
            wakeWord: null,
            command: "",
            usedLlm: true,
            selectedText: "",
          });
        }

        const selectedText =
          s1.asrBest &&
          (s1.asrBest.choice === "track_a" || s1.asrBest.choice === "track_b") &&
          s1.asrBest.selectedText
            ? s1.asrBest.selectedText
            : cleaned;
        const effectiveCmd = selectedText
          .replace(LEADING_PUNCT_RE, "")
          .replace(TRAILING_PUNCT_RE, "")
          .trim();
        const intentFields = s1.intent
          ? { intent: s1.intent.choice, intentConfidence: s1.intent.confidence }
          : {};
        const selectedFields = selectedText !== cleaned ? { selectedText } : {};

        if (s1.shouldExitConversation) {
          return wrap({
            accept: false,
            exitConversation: true,
            wokeOnly: false,
            addressed: true,
            inConversation: false,
            confidence: s1.confidence,
            stage: "systemone-attention",
            reason: "SystemOne 判定用户示意结束对话，已回到待机模式",
            wakeWord: null,
            command: "",
            usedLlm: true,
            ...intentFields,
            ...selectedFields,
          });
        }

        if (s1.accepted && effectiveCmd.length > 0) {
          return wrap({
            accept: true,
            wokeOnly: false,
            addressed: true,
            inConversation: true,
            confidence: s1.confidence,
            stage: "systemone-attention",
            reason: "SystemOne 确认正在继续与助手对话",
            wakeWord: null,
            command: effectiveCmd,
            usedLlm: true,
            ...intentFields,
            ...selectedFields,
          });
        }

        // 兜底挽救：即使 SystemOne 误判为 side_talk，只要同时具备真实声学唤醒命中 + 命中家中专能设备能力，绝不误拦
        if (input.acousticWake?.matched && convCapMatch && effectiveCmd.length > 0) {
          return wrap({
            accept: true,
            wokeOnly: false,
            addressed: true,
            inConversation: true,
            confidence: Math.max(0.82, input.acousticWake.score),
            stage: "fast-followup",
            passSource: "acoustic_wake_recovery",
            matchedCapability: convCapMatch.matchedCapabilityLabel,
            reason: `声学唤醒「${input.acousticWake.wakeWord}」且命中设备能力「${convCapMatch.matchedCapabilityLabel}」，已避免 SystemOne 误拦`,
            wakeWord: input.acousticWake.wakeWord,
            command: effectiveCmd,
            usedLlm: true,
            ...intentFields,
            ...selectedFields,
          });
        }

        // 连续对话低置信度跟进表达挽救（仅 smart 模式、非 BGM、非明确旁白/未匹配他人声纹，且存在活跃对话上下文）：
        // 避免“那以后不要出现这种情况了”“下次注意一点”等自然跟进表达在 3 分类（followup/side_talk/goodbye）灰区被误拦。
        const hasRecentTurns = recentHistory.length > 0;
        const pFollowup = s1.probabilities.followup ?? 0;
        const pSideTalk = s1.probabilities.side_talk ?? 0;
        const pGoodbye = s1.probabilities.goodbye ?? 0;
        const pDirected = pFollowup + pGoodbye;
        const marginOverSideTalk = pFollowup - pSideTalk;
        const contextualFollowup = isContextualConversationFollowup(
          effectiveCmd,
          input.acousticEvent,
        );
        const safeConversationFollowupCandidate =
          effectiveCmd.length >= 2 &&
          effectiveCmd.length <= 80 &&
          !isBgmConv &&
          !voiceprintRejectedOther &&
          !isExplicitExitPhrase(effectiveCmd) &&
          !isBareWeakClosingPhrase(effectiveCmd) &&
          !NON_COMMAND_CHAT_RE.test(effectiveCmd) &&
          !isThirdPersonNeoMention(effectiveCmd);

        if (
          input.attentionMode === "smart" &&
          safeConversationFollowupCandidate &&
          (hasRecentTurns || Boolean(input.awakeActive))
        ) {
          const recoverLowConfFollowup =
            s1.action === "followup" &&
            pSideTalk <= 0.38 &&
            pFollowup >= 0.45 &&
            marginOverSideTalk >= 0.12 &&
            (contextualFollowup ||
              (sameConversationSpeaker && pFollowup >= 0.5 && marginOverSideTalk >= 0.18) ||
              (voiceprintMatched && pDirected >= 0.7 && marginOverSideTalk >= 0.2) ||
              (hasRecentTurns &&
                pDirected >= 0.72 &&
                pSideTalk <= 0.28 &&
                marginOverSideTalk >= 0.22));

          const recoverSplitGoodbyeFollowup =
            s1.action === "goodbye" &&
            !s1.shouldExitConversation &&
            hasRecentTurns &&
            contextualFollowup &&
            pSideTalk <= 0.25 &&
            pDirected >= 0.72 &&
            pFollowup >= 0.25 &&
            marginOverSideTalk >= 0.1;

          if (recoverLowConfFollowup || recoverSplitGoodbyeFollowup) {
            return wrap({
              accept: true,
              wokeOnly: false,
              addressed: true,
              inConversation: true,
              confidence: Math.max(s1.confidence, pFollowup),
              stage: "systemone-attention",
              passSource: "conversation_followup_recovery",
              reason: recoverSplitGoodbyeFollowup
                ? "连续对话跟进反馈表达（非告别意图），已放行继续对话"
                : sameConversationSpeaker && !contextualFollowup
                  ? `连续对话同说话人「${input.conversationSpeakerName}」跟进表达，已放行继续对话`
                  : "连续对话上下文跟进表达，已放行继续对话",
              wakeWord: null,
              command: effectiveCmd,
              usedLlm: true,
              ...intentFields,
              ...selectedFields,
            });
          }
        }

        return wrap({
          accept: false,
          wokeOnly: false,
          addressed: false,
          inConversation: true,
          confidence: s1.confidence,
          stage: "systemone-attention",
          reason:
            s1.action === "side_talk"
              ? "SystemOne 判定为旁白/闲聊，保留当前对话窗口"
              : "SystemOne 置信度不足，已保守忽略并保留对话窗口",
          wakeWord: null,
          command: "",
          usedLlm: true,
          ...intentFields,
          ...selectedFields,
        });
      }
      const fk = input.systemOneClient.lastFailureKind;
      sysOneTransientFailure = fk === "timeout" || fk === "network";
    }

    // B4. SystemOne 未启用或降级链：仅放行明确智能家居续聊/控制指令或附加指令规则，防止泛化词/歌词/环境杂音在对话中误触发
    if (
      input.attentionMode === "smart" &&
      isClearDeviceCmd &&
      (input.awakeActive || cmd.length <= 18 || isCustomRuleCmd)
    ) {
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

    // 连续对话窗口内的不确定语句 -> 由 Pi Agent LLM 注意力门控判断是否仍在与助手对话
    if (input.llmEvaluator && !sysOneTransientFailure) {
      const prompt = buildAttentionPrompt({
        text: cleaned,
        wakeWords: input.wakeWords,
        wakeSpan: null,
        awakeActive: Boolean(input.awakeActive),
        inConversation: true,
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

    // 离线降级：严禁在无云端语义判别时因 awakeActive 盲目放行歌词/电视/咖啡馆杂音，仅放行明确设备/助手指令、家庭专能能力指令或对助手提问的直接短答
    if (isClearDeviceCmd || strongImplicitCap || isShortReplyToAssistantQuestion) {
      return wrap({
        accept: true,
        wokeOnly: false,
        addressed: true,
        inConversation: true,
        confidence: 0.84,
        stage: "fast-followup",
        passSource: strongImplicitCap ? "implicit_capability" : "fallback",
        matchedCapability: convCapMatch?.matchedCapabilityLabel,
        reason: strongImplicitCap && convCapMatch
          ? `命中设备能力「${convCapMatch.matchedCapabilityLabel}」`
          : isShortReplyToAssistantQuestion
            ? "对助手提问的简短回复"
            : input.awakeActive
              ? "唤醒窗口内明确控制指令"
              : "连续对话续聊指令",
        wakeWord: input.acousticWake?.matched ? input.acousticWake.wakeWord : null,
        command: cmd,
        usedLlm: false,
      });
    }

    return wrap({
      accept: false,
      wokeOnly: false,
      addressed: false,
      inConversation: true,
      confidence: 0.85,
      stage: isBgmConv ? "acoustic" : "pragmatic-reject",
      reason: isBgmConv
        ? "背景音乐/噪声中未识别为明确设备指令，已忽略"
        : "连续对话窗口内未识别为明确指令，已忽略并保留对话窗口",
      wakeWord: null,
      command: "",
      usedLlm: false,
    });
  }

  // ==================== 情况 C：待机态无文本唤醒词，但 openWakeWord 声学唤醒命中（ASR 吞掉或误听了“Neo”，如“六，我觉得客厅有点暗呢”） ====================
  if (input.acousticWake?.matched) {
    const cmd = cleaned.replace(LEADING_PUNCT_RE, "").replace(TRAILING_PUNCT_RE, "").trim();
    const extractedCmd = extractCommandAfterAcousticWake(cleaned, input.acousticWake.wakeWord);
    const effectiveCmd = extractedCmd || cmd;
    const isAmbiguousInterrogative =
      /^(?:你有|你又|你好|你给)/.test(cmd) &&
      /[吗嘛么呢？?][\s。!！]*$/.test(cleaned) &&
      !isWakeQueryText(extractedCmd);
    const standbyCapMatch =
      !isAmbiguousInterrogative && effectiveCmd
        ? probeImplicitCapabilities(effectiveCmd, input.capabilityDigest)
        : null;
    const standbyExplicitDeviceCmd =
      !isAmbiguousInterrogative &&
      effectiveCmd.length > 0 &&
      hasExplicitDeviceControlCommand(effectiveCmd, input.capabilityDigest);
    const standbyDirect =
      !isAmbiguousInterrogative &&
      effectiveCmd.length > 0 &&
      (looksLikeDirectDeviceCommand(effectiveCmd) ||
        standbyExplicitDeviceCmd ||
        isCustomInstructionVoiceCommand(effectiveCmd) ||
        Boolean(standbyCapMatch));
    if (standbyDirect && (input.attentionMode !== "strict" || !input.systemOneClient?.enabled)) {
      const cleanStandbyCmd = standbyExplicitDeviceCmd
        ? stripLeadingControlFiller(effectiveCmd)
        : effectiveCmd;
      return wrap({
        accept: true,
        wokeOnly: false,
        addressed: true,
        inConversation: true,
        confidence: Math.max(0.84, input.acousticWake.score),
        stage: "fast-wake",
        passSource: standbyCapMatch
          ? "implicit_capability"
          : standbyExplicitDeviceCmd && !looksLikeDirectDeviceCommand(effectiveCmd)
            ? "device_command"
            : "acoustic_wake_recovery",
        matchedCapability: standbyCapMatch?.matchedCapabilityLabel,
        reason: standbyCapMatch
          ? `声学唤醒「${input.acousticWake.wakeWord}」并命中设备能力「${standbyCapMatch.matchedCapabilityLabel}」`
          : standbyExplicitDeviceCmd && !looksLikeDirectDeviceCommand(effectiveCmd)
            ? `声学唤醒「${input.acousticWake.wakeWord}」且存在明确控制设备指令，放行进入下一流程`
            : `声学唤醒「${input.acousticWake.wakeWord}」且后接明确控制指令`,
        wakeWord: input.acousticWake.wakeWord,
        command: cleanStandbyCmd,
        usedLlm: false,
      });
    }

    // 声学唤醒已触发但未命中文本唤醒词：交由 SystemOne 校验（或条件：触发词非误听 OR 存在控制设备指令）
    if (input.systemOneClient?.enabled) {
      const wakeWordsForCheck =
        input.wakeWords.length > 0 ? input.wakeWords : [input.acousticWake.wakeWord];
      const aliasHint = buildSuspectedWakeAliasHint(cleaned, null, input.acousticWake);
      const s1 = await input.systemOneClient.evaluateWakeAttention(
        {
          utterance: cleaned,
          wakeWords: wakeWordsForCheck,
          ...(aliasHint
            ? {
                suspectedWakeAlias: aliasHint,
                acousticWake: {
                  wakeWord: input.acousticWake.wakeWord,
                  score: input.acousticWake.score,
                  matched: true,
                },
              }
            : {}),
        },
        {
          strict: input.attentionMode === "strict",
        },
      );
      if (s1) {
        if (!s1.accepted) {
          return wrap({
            accept: false,
            wokeOnly: false,
            addressed: false,
            inConversation: false,
            confidence: s1.confidence,
            stage: "systemone-attention",
            reason:
              s1.decision === "false_wake"
                ? "SystemOne 判定为误听/误唤醒且无控制设备指令，未触发执行"
                : "SystemOne 唤醒与指令校验置信度低于阈值，已保守忽略",
            wakeWord: input.acousticWake.wakeWord,
            command: "",
            usedLlm: true,
          });
        }
        const acceptedByDeviceCmd = s1.acceptedBy === "device_command";
        const finalCmd = acceptedByDeviceCmd
          ? stripLeadingControlFiller(extractedCmd || cmd)
          : extractedCmd;
        return wrap({
          accept: true,
          wokeOnly: acceptedByDeviceCmd ? false : finalCmd.length === 0,
          addressed: true,
          inConversation: true,
          confidence: acceptedByDeviceCmd ? s1.deviceCommand.confidence : s1.confidence,
          stage: "systemone-attention",
          passSource: acceptedByDeviceCmd ? "device_command" : "systemone",
          reason: acceptedByDeviceCmd
            ? "SystemOne 检测到控制设备指令，放行进入下一流程"
            : finalCmd.length === 0
              ? `SystemOne 确认触发词「${input.acousticWake.wakeWord}」非误听，进入下一流程`
              : `SystemOne 确认触发词「${input.acousticWake.wakeWord}」非误听，直接进入下一流程`,
          wakeWord: input.acousticWake.wakeWord,
          command: finalCmd,
          usedLlm: true,
        });
      }
      if (input.attentionMode === "strict") {
        return wrap({
          accept: false,
          wokeOnly: false,
          addressed: false,
          inConversation: false,
          confidence: 0.7,
          stage: "systemone-attention",
          reason: "SystemOne 唤醒校验暂不可用，严格模式下已保守忽略",
          wakeWord: input.acousticWake.wakeWord,
          command: "",
          usedLlm: false,
        });
      }
    }

    // 声学唤醒已命中但 SystemOne 未启用或暂不可用时的兜底：绝不再按“有效对话上下文”误拒，除明显第三人称提及或日常疑问句外直接放行进入下一流程；
    // 若存在明确控制设备指令，即便句含第三人称提及前文也放行不拦截。
    if (!standbyExplicitDeviceCmd && (isThirdPersonNeoMention(cleaned) || isAmbiguousInterrogative)) {
      return wrap({
        accept: false,
        wokeOnly: false,
        addressed: false,
        inConversation: false,
        confidence: 0.85,
        stage: "pragmatic-reject",
        reason: isAmbiguousInterrogative
          ? "判定为日常疑问句同音误触，非呼叫触发词"
          : `检测到对「${input.acousticWake.wakeWord}」的第三人称提及或讨论，判定为误唤醒`,
        wakeWord: input.acousticWake.wakeWord,
        command: "",
        usedLlm: false,
      });
    }
    return wrap({
      accept: true,
      wokeOnly: standbyExplicitDeviceCmd ? false : extractedCmd.length === 0,
      addressed: true,
      inConversation: true,
      confidence: Math.max(0.8, input.acousticWake.score),
      stage: "fast-wake",
      passSource: standbyExplicitDeviceCmd ? "device_command" : "acoustic_wake_recovery",
      reason: standbyExplicitDeviceCmd
        ? `声学唤醒「${input.acousticWake.wakeWord}」且存在明确控制设备指令，放行进入下一流程`
        : extractedCmd.length === 0
          ? `声学唤醒「${input.acousticWake.wakeWord}」命中，进入唤醒聆听`
          : `声学唤醒「${input.acousticWake.wakeWord}」命中，直接进入下一流程`,
      wakeWord: input.acousticWake.wakeWord,
      command: standbyExplicitDeviceCmd ? stripLeadingControlFiller(effectiveCmd) : extractedCmd,
      usedLlm: false,
    });
  }

  // ==================== 情况 D：待机态无文本/声学唤醒词 -> 或条件：判断是否存在控制设备指令，存在也放行不拦截 ====================
  const standbyText = cleaned.replace(LEADING_PUNCT_RE, "").replace(TRAILING_PUNCT_RE, "").trim();
  const isBgmStandby = Boolean(input.acousticEvent?.toUpperCase().includes("BGM"));
  const standbyExplicitDeviceCmd = hasExplicitDeviceControlCommand(
    standbyText,
    input.capabilityDigest,
  );
  if (standbyExplicitDeviceCmd) {
    const cleanDeviceCmd = stripLeadingControlFiller(
      isBgmStandby ? trimTrailingMusicLyrics(standbyText) : standbyText,
    );
    if (input.attentionMode === "strict" && input.systemOneClient?.enabled) {
      const s1 = await input.systemOneClient.evaluateWakeAttention(
        {
          utterance: cleaned,
          wakeWords: input.wakeWords,
        },
        { strict: true },
      );
      if (s1?.accepted) {
        const acceptedByDeviceCmd = s1.acceptedBy === "device_command";
        return wrap({
          accept: true,
          wokeOnly: false,
          addressed: true,
          inConversation: true,
          confidence: acceptedByDeviceCmd ? s1.deviceCommand.confidence : s1.confidence,
          stage: "systemone-attention",
          passSource: acceptedByDeviceCmd ? "device_command" : "systemone",
          reason: "SystemOne 检测到控制设备指令，放行进入下一流程",
          wakeWord: null,
          command: cleanDeviceCmd || standbyText,
          usedLlm: true,
        });
      }
      return wrap({
        accept: false,
        wokeOnly: false,
        addressed: false,
        inConversation: false,
        confidence: s1?.confidence ?? 0.75,
        stage: "systemone-attention",
        reason: s1
          ? "SystemOne 判定未包含唤醒词或有效控制设备指令"
          : "SystemOne 唤醒校验暂不可用，严格模式下已保守忽略",
        wakeWord: null,
        command: "",
        usedLlm: Boolean(s1),
      });
    }
    return wrap({
      accept: true,
      wokeOnly: false,
      addressed: true,
      inConversation: true,
      confidence: 0.88,
      stage: "fast-wake",
      passSource: "device_command",
      reason: "未检测到唤醒词，但存在明确控制设备指令，放行进入下一流程",
      wakeWord: null,
      command: cleanDeviceCmd || standbyText,
      usedLlm: false,
    });
  }

  // 待机态口语化/隐式设备控制候选（仅当包含明确智能家居领域/能力线索且非问句/闲聊/旁白时才请 SystemOne 复核，普通聊天/电视声零额外调用）
  if (
    input.systemOneClient?.enabled &&
    !isBgmStandby &&
    standbyText.length >= 2 &&
    standbyText.length <= 64 &&
    !DEVICE_CMD_INTERROGATIVE_END_RE.test(standbyText) &&
    !DEVICE_CMD_INDIRECT_QUESTION_RE.test(standbyText) &&
    !NON_COMMAND_CHAT_RE.test(standbyText) &&
    !OBVIOUS_SIDETALK_RE.test(standbyText) &&
    !isThirdPersonNeoMention(standbyText) &&
    !isNoiseOrGarbledFragment(standbyText, input.acousticEvent) &&
    ((hasSmartHomeDomainIntent(standbyText) && CONVERSATION_ACTION_OR_QUERY_RE.test(standbyText)) ||
      Boolean(probeImplicitCapabilities(standbyText, input.capabilityDigest)))
  ) {
    const s1 = await input.systemOneClient.evaluateWakeAttention(
      {
        utterance: cleaned,
        wakeWords: input.wakeWords,
      },
      { strict: input.attentionMode === "strict" },
    );
    if (s1?.accepted) {
      const acceptedByDeviceCmd = s1.acceptedBy === "device_command";
      return wrap({
        accept: true,
        wokeOnly: false,
        addressed: true,
        inConversation: true,
        confidence: acceptedByDeviceCmd ? s1.deviceCommand.confidence : s1.confidence,
        stage: "systemone-attention",
        passSource: acceptedByDeviceCmd ? "device_command" : "systemone",
        reason: "SystemOne 检测到控制设备指令，放行进入下一流程",
        wakeWord: null,
        command: stripLeadingControlFiller(standbyText),
        usedLlm: true,
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
    reason: "未检测到唤醒词或控制设备指令",
    wakeWord: null,
    command: "",
    usedLlm: false,
  });
}
