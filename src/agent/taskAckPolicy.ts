// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * 场景化即时简短应答词策略（Smart Immediate Task Ack Policy）。
 *
 * 收到用户语音或文字输入后，先由 SystemOne（karpo/karpo-decision-31b）快速判定输入场景，
 * 返回贴合语境的简短口语应答词（如“好的”“稍等我看一下”“让我想想”等），再进入后续工具/LLM 执行；
 * 当 SystemOne 关闭、离线、熔断或置信度不足时，自动平滑降级为本地轻量规则兜底，零阻塞。
 */

export const TASK_ACK_TEXT = "好的";

export const TASK_ACK_MIN_CONFIDENCE = 0.45;

export const TASK_ACK_SCENARIOS = [
  "execute_control",
  "query_status",
  "think_creative",
  "scene_routine",
  "troubleshoot",
  "urgent_cancel",
  "remember_rule",
  "safety_confirm",
  "greeting_chat",
] as const;

export type TaskAckScenario = (typeof TASK_ACK_SCENARIOS)[number];

export interface TaskAckScenarioSpec {
  id: TaskAckScenario;
  label: string;
  zh: string;
  en: string;
  criteria: string;
}

export const TASK_ACK_SCENARIO_CATALOG: Readonly<Record<TaskAckScenario, TaskAckScenarioSpec>> = {
  execute_control: {
    id: "execute_control",
    label: "常规控制执行",
    zh: TASK_ACK_TEXT,
    en: "Okay",
    criteria:
      "直接或隐式设备控制调节（开关/亮度/色温/温度/音量/洗衣/喂食/播放/删规则/太暗太热太吵）。",
  },
  query_status: {
    id: "query_status",
    label: "状态与信息查询",
    zh: "稍等我看一下",
    en: "Let me check",
    criteria:
      "仅查状态或信息不改设备（温湿度/设定温度/开关状态/剩余时间/离线盘点/天气/查规则）。",
  },
  think_creative: {
    id: "think_creative",
    label: "思考创作与问答",
    zh: "让我想想",
    en: "Let me think",
    criteria:
      "需思考创意或科普问答（笑话/故事/写诗/原理提问/吃什么/建议推荐/方案对比）。",
  },
  scene_routine: {
    id: "scene_routine",
    label: "场景与作息编排",
    zh: "马上安排",
    en: "On it",
    criteria:
      "多设备联动场景或作息模式（回家/离家/睡觉/起床/观影/全屋关灯）；单台家电归 execute_control。",
  },
  troubleshoot: {
    id: "troubleshoot",
    label: "故障排查与异常",
    zh: "我来排查一下",
    en: "Let me look into it",
    criteria:
      "反馈设备故障、质疑未生效或查异常原因（打不开/没反应/报错/刚才没关掉/离线）。",
  },
  urgent_cancel: {
    id: "urgent_cancel",
    label: "紧急停止与纠错",
    zh: "马上处理",
    en: "Right away",
    criteria:
      "紧急停止、中止播放或撤销纠正刚发生的误操作（快停下/别放了/搞错了/撤回操作）。",
  },
  remember_rule: {
    id: "remember_rule",
    label: "记住长期规则",
    zh: "明白，我记一下",
    en: "Got it, noting that",
    criteria:
      "交代记住长期个人习惯或默认条件规则（以后记得.../记住默认...）；查规则归 query_status。",
  },
  safety_confirm: {
    id: "safety_confirm",
    label: "高风险安全确认",
    zh: "先确认一下",
    en: "Let's check first",
    criteria:
      "安防隐私或破坏性高危操作（门锁开锁改密/关摄像头/恢复出厂/解童锁/断总电）。",
  },
  greeting_chat: {
    id: "greeting_chat",
    label: "打招呼与寒暄",
    zh: "在呢",
    en: "I'm here",
    criteria:
      "单纯打招呼、寒暄问候、道谢或问在吗，不含具体设备指令或问答。",
  },
};

/** 供本地 Matcha-TTS 启动预热的全部中文即时应答词（命中缓存 <2ms 零延迟播报）。 */
export const TASK_ACK_PREWARM_PHRASES_ZH: readonly string[] = [
  ...new Set(TASK_ACK_SCENARIOS.map((id) => TASK_ACK_SCENARIO_CATALOG[id].zh)),
];

export const TASK_ACK_QUESTION: {
  type: "choice";
  instructions: string;
  criteria: Record<TaskAckScenario, string>;
} = {
  type: "choice",
  instructions:
    "智能家居助手首次简短应答场景分类（中英文，结合 history 理解省略主语追问），选最贴切场景。",
  criteria: {
    execute_control: TASK_ACK_SCENARIO_CATALOG.execute_control.criteria,
    query_status: TASK_ACK_SCENARIO_CATALOG.query_status.criteria,
    think_creative: TASK_ACK_SCENARIO_CATALOG.think_creative.criteria,
    scene_routine: TASK_ACK_SCENARIO_CATALOG.scene_routine.criteria,
    troubleshoot: TASK_ACK_SCENARIO_CATALOG.troubleshoot.criteria,
    urgent_cancel: TASK_ACK_SCENARIO_CATALOG.urgent_cancel.criteria,
    remember_rule: TASK_ACK_SCENARIO_CATALOG.remember_rule.criteria,
    safety_confirm: TASK_ACK_SCENARIO_CATALOG.safety_confirm.criteria,
    greeting_chat: TASK_ACK_SCENARIO_CATALOG.greeting_chat.criteria,
  },
};

const RE_HAS_CJK = /[\u4e00-\u9fff]/;
const RE_HAS_ENGLISH_WORD = /[A-Za-z]{2,}/;

export function isEnglishOnlyUtterance(text?: string): boolean {
  if (!text) return false;
  return !RE_HAS_CJK.test(text) && RE_HAS_ENGLISH_WORD.test(text);
}

/**
 * 根据场景和用户语种返回简短首次应答词。
 */
export function resolveTaskAckPhrase(scenario: TaskAckScenario, utterance?: string): string {
  const spec = TASK_ACK_SCENARIO_CATALOG[scenario] ?? TASK_ACK_SCENARIO_CATALOG.execute_control;
  return isEnglishOnlyUtterance(utterance) ? spec.en : spec.zh;
}

// ==================== Lightweight Deterministic Offline Fallback ====================

const RE_FALLBACK_SAFETY =
  /(?:(?:打开|解开|解锁|改密|修改密码).{0,6}(?:智能)?门锁|(?:智能)?门锁.{0,6}(?:开锁|解锁|打开|改密)|(?:关闭|关掉|停用).{0,6}(?:监控|摄像头|移动侦测|安防)|恢复出厂|出厂设置|格式化|重置(?:设备|路由器|门锁)|解除童锁|全屋(?:总电源)?断电|\b(?:unlock\b.*\b(?:door|lock)|factory\s*reset|turn\s+off\b.*\bcamera)\b)/i;

const RE_FALLBACK_URGENT_CANCEL =
  /(?:^(?:停|停下|停一下|别放了|停止播放|快停|快关|赶紧停|赶紧关|立刻停|立刻关|马上停|马上关)|(?:不对|搞错了|说错了|弄错了)[，,。\s]*(?:我说的是|是|应该|关回去|换)|撤回|撤销(?:刚才|上一[步轮次])|取消刚才|\b(?:stop\s+(?:playing|now|it)|undo\s+that|cancel\s+that|wrong\s+(?:room|light|device))\b)/i;

const RE_FALLBACK_REMEMBER_RULE =
  /(?:(?<!(?:秒|分钟|小时|天))以后(?:记得|每次|默认|都|我说|凡是|只要)|记住(?:以后|每次|默认|下次)|帮我记住|记一下(?:以后|下次)|(?:设为|作为)(?:以后|长期)默认|\b(?:remember\s+to\s+always|from\s+now\s+on|always\s+default\s+to)\b)/i;

const RE_FALLBACK_TROUBLESHOOT =
  /(?:(?:为什么|为啥|怎么)(?:.*?(?:打不开|关不掉|没反应|没亮|没开|没关|不亮|不动|报错|失败|离线|掉线|连不上|用不了|不好使|不工作))|(?:刚才|刚刚).{0,6}(?:好像)?没(?:开|关|亮|停|调|生效)|是不是(?:离线|掉线|断网|坏了|没电了)|\b(?:why\s+(?:isn't|doesn't|didn't|won't)|not\s+working|stopped\s+working|error\s+code)\b)/i;

const RE_FALLBACK_THINK_CREATIVE =
  /(?:(?:讲|说|来)一?个?(?:冷)?笑话|(?:讲|说)一?个?(?:睡前)?故事|写一?(?:首诗|段话|个段子)|脑筋急转弯|猜谜语|出个?主意|给点?(?:建议|点子|灵感)|推荐(?:一?个|一下|点)|(?:今天|今晚|中午|晚上)吃什么|有什么区别|怎么选(?:比较好|合适)|(?:为什么|为啥)(?!.*(?:灯|空调|窗帘|洗衣|风扇|开关|插座|音箱|电视|扫地|除湿|净化|设备|打不开|关不掉|没反应|没亮|报错|离线))|什么是|\b(?:tell\s+(?:me\s+)?a\s+(?:joke|story)|write\s+a\s+poem|give\s+me\s+(?:an?\s+)?(?:idea|advice)|recommend|suggest|what\s+should\s+i\s+eat|why\s+(?:is|are|do|does))\b)/i;

const RE_FALLBACK_QUERY_STATUS =
  /(?:多少度|几度|温度(?:是)?多少|湿度(?:是)?多少|电量(?:是)?多少|PM\s*2\.?5|空气质量|还剩多久|还有多久|剩余时间|开着吗|关着吗|是不是开着|是不是关着|设置(?:的|了)?多少|调(?:的|了)?多少|当前状态|查一下|看一下|看看(?:.*?(?:状态|温度|湿度|电量|多少|有哪些|开着|关着|规则|发电|功率))|有哪些(?:灯|设备|规则|指令)|哪些(?:灯|设备).*(?:开着|关着|离线)|设备盘点|全屋巡检|天气怎么样|明天(?:会)?下雨吗|查(?:一下)?天气|\b(?:what\s+temp(?:erature)?|how\s+(?:warm|hot|cold|humid)|is\s+the\s+.*\b(?:on|off)|check\s+(?:the\s+)?(?:status|temp|temperature|humidity|weather|battery)|how\s+much\s+time\s+left)\b)/i;

const RE_FALLBACK_SCENE_ROUTINE =
  /(?:回家模式|离家模式|出门模式|观影模式|影院模式|睡眠模式|睡觉模式|起床模式|会客模式|午休模式|阅读模式|专注模式|开会模式|全屋(?:关灯|关闭|准备休息)|我要睡觉了|准备睡觉|我出门了|准备出门|我回家了|到家了|\b(?:movie\s+mode|sleep\s+mode|bedtime|leaving\s+home|i(?:'m|\s+am)\s+(?:home|going\s+to\s+(?:bed|sleep)))\b)/i;

const RE_FALLBACK_GREETING =
  /^(?:你好|您好|早上好|早安|上午好|中午好|下午好|晚上好|晚安|嗨|哈喽|嘿|在吗|在不在|辛苦了|辛苦啦|谢谢你?|多谢|陪我聊聊天|hi|hello|hey|good\s+(?:morning|afternoon|evening|night)|thanks?|thank\s+you)[呀啊哦呢啦吧吗!！?？。.\s~～]*$/i;

const RE_CLEAR_CONTROL_INTERROGATIVE_GUARD =
  /(?:[?？吗嘛么]\s*$|为什么|为啥|怎么(?:办|样|选|弄)|是不是|有没有|能不能|可不可以|好不好|适合.*吗|还是.*好)/;

// 自包含、无需额外设备名词即可确定属于 execute_control 的明确控制动作
const RE_SELF_CONTAINED_EXECUTE_CONTROL =
  /(?:开灯|关灯|熄灯|灭灯|亮灯|开空调|关空调|开风扇|关风扇|开电视|关电视|开窗帘|关窗帘|拉上?窗帘|拉开窗帘|开音箱|关音箱|开加湿器|关加湿器|开净化器|关净化器|开除湿机|关除湿机|开浴霸|关浴霸|开洗衣机|关洗衣机|开扫地机|关扫地机|开插座|关插座|放歌|放音乐|播音乐|播放(?:一点|点|一首|首|一下)?(?:音乐|歌)|切歌|换歌|换一首|换首歌|下一首|上一首|下一曲|上一曲|暂停播放|继续播放|停止播放|^(?:请|帮我|给我|麻烦)?(?:暂停|继续|静音|取消静音|解除静音|恢复声音|闭麦|开麦|关了吧|开一下|打开吧|大声一点|小声一点|大声点|小声点|调亮一点|调暗一点|亮一点|暗一点|再亮一点|再暗一点|稍微亮一点|稍微暗一点)(?:吧|一下)?$|调高音量|调低音量|调大音量|调小音量|调大声音|调小声音|声音大一点|声音小一点|大声一点|小声一点|大声点|小声点|调亮|调暗|洗(?:一下|个)?(?:衣服|袜子|内裤)|扫地|拖地|回充|出粮|投喂|喂猫|喂狗|浇花|删除.*(?:规则|指令)|(?:太暗|有点暗|太亮|有点亮|太刺眼|有点刺眼|太热|有点热|太冷|有点冷|太吵|有点吵|声音太大|声音太小|听不清)|\b(?:turn\s+(?:on|off)|switch\s+(?:on|off)|set\s+(?:the\s+)?(?:temp|temperature|brightness|volume|ac|light)|dim|brighten|play\s+(?:some\s+)?music|pause\s+music|mute|unmute|next\s+song|previous\s+song|too\s+(?:dark|bright|loud|hot|cold))\b)/i;

const RE_GENERAL_CONTROL_VERB =
  /(?:打开|关闭|关掉|关上|开启|启动|暂停|继续|停止|调高|调低|调大|调小|调到|调成|调为|调至|设为|设成|设到|设定|亮一点|暗一点|大一点|小一点|高一点|低一点|暖一点|冷一点|烘干|脱水)/i;

const RE_EXECUTE_CONTROL_DOMAIN =
  /(?:灯|照明|空调|风扇|窗帘|电视|投影|音箱|音响|小爱|音量|声音|音乐|歌|播放|静音|亮度|色温|暖光|冷光|洗衣|洗烘|烘干|袜子|内裤|扫地|拖地|加湿|除湿|净化|浴霸|热水器|插座|开关|喂食|出粮|喂猫|喂狗|浇花|规则|指令|\b(?:lights?|lamps?|ac|air\s*conditioner|fan|curtains?|tv|speaker|volume|music|washer|vacuum|brightness|temp|temperature)\b)/i;

const RE_CONTEXT_DEPENDENT_ACK_START =
  /^(?:那|这|它|再|还|也|刚才|刚刚|上面|上一个|那个|这个|为什么|为啥|怎么|那以后|以后|下次|但是|不过|可是|所以|对了|顺便|嗯+|好吧|行吧|算了|and\b|then\b|also\b|what\s+about\b|how\s+about\b|it\b|that\b)/i;

export interface DeterministicTaskAckMatch {
  scenario: TaskAckScenario;
  confidence: number;
}

/**
 * 0ms 高置信本地场景分类器（用于 `systemOneMode === "auto"` 跳过清晰明确指令的云端 SystemOne 往返）：
 * - 命中明确无歧义的常规控制/查询/创作/场景/排错/紧急停止/记规则/高危安全/问候时直接返回高置信场景；
 * - 对含糊、开放式或依赖上文语境的口语表达返回 `null`，交由 SystemOne 语义判定。
 */
export function classifyDeterministicTaskAck(utterance: string): DeterministicTaskAckMatch | null {
  const clean = utterance.trim();
  if (!clean) return null;

  if (RE_FALLBACK_SAFETY.test(clean)) return { scenario: "safety_confirm", confidence: 0.96 };
  if (RE_FALLBACK_URGENT_CANCEL.test(clean)) return { scenario: "urgent_cancel", confidence: 0.95 };
  if (RE_FALLBACK_REMEMBER_RULE.test(clean)) return { scenario: "remember_rule", confidence: 0.95 };
  if (RE_FALLBACK_TROUBLESHOOT.test(clean)) return { scenario: "troubleshoot", confidence: 0.92 };
  if (RE_FALLBACK_THINK_CREATIVE.test(clean)) return { scenario: "think_creative", confidence: 0.92 };
  if (RE_FALLBACK_QUERY_STATUS.test(clean)) return { scenario: "query_status", confidence: 0.92 };
  if (RE_FALLBACK_SCENE_ROUTINE.test(clean)) return { scenario: "scene_routine", confidence: 0.92 };
  if (RE_FALLBACK_GREETING.test(clean)) return { scenario: "greeting_chat", confidence: 0.95 };

  if (!RE_CLEAR_CONTROL_INTERROGATIVE_GUARD.test(clean)) {
    if (RE_SELF_CONTAINED_EXECUTE_CONTROL.test(clean)) {
      return { scenario: "execute_control", confidence: 0.92 };
    }
    if (RE_GENERAL_CONTROL_VERB.test(clean) && RE_EXECUTE_CONTROL_DOMAIN.test(clean)) {
      return { scenario: "execute_control", confidence: 0.92 };
    }
  }

  return null;
}

/**
 * 判断该输入用于 `classifyTaskAck` 缓存时是否语义自包含（不依赖上文历史），
 * 自包含指令可跨对话轮次共享短 TTL 缓存以消除重复 SystemOne 调用。
 */
export function isSelfContainedTaskAckUtterance(utterance: string): boolean {
  const clean = utterance.trim();
  if (clean.length < 4) return false;
  if (RE_CONTEXT_DEPENDENT_ACK_START.test(clean)) return false;
  return true;
}

/**
 * 当 SystemOne 不可用、关闭或置信度不足时的轻量离线兜底场景推断（<0.1ms）。
 * 无法明确归类时安全回落到 `execute_control`（“好的”）。
 */
export function inferFallbackTaskAckScenario(utterance: string): TaskAckScenario {
  const clean = utterance.trim();
  if (!clean) return "execute_control";

  if (RE_FALLBACK_SAFETY.test(clean)) return "safety_confirm";
  if (RE_FALLBACK_URGENT_CANCEL.test(clean)) return "urgent_cancel";
  if (RE_FALLBACK_REMEMBER_RULE.test(clean)) return "remember_rule";
  if (RE_FALLBACK_TROUBLESHOOT.test(clean)) return "troubleshoot";
  if (RE_FALLBACK_THINK_CREATIVE.test(clean)) return "think_creative";
  if (RE_FALLBACK_QUERY_STATUS.test(clean)) return "query_status";
  if (RE_FALLBACK_SCENE_ROUTINE.test(clean)) return "scene_routine";
  if (RE_FALLBACK_GREETING.test(clean)) return "greeting_chat";

  return "execute_control";
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 语音播报最终回复前，去除与刚刚播报过的简短应答词重复的句首前缀（例如避免连读两次“好的”或“稍等我看一下”）。
 * 当 `suppressPureMatch` 为 true（流式首句且后续仍有正文）时，若整句仅为重复应答词则直接返回空串跳过。
 */
export function stripDuplicatedAckPrefix(
  spokenText: string,
  emittedAckText?: string,
  options: { suppressPureMatch?: boolean } = {},
): string {
  const trimmed = spokenText.trim();
  if (!trimmed) return "";

  const candidates = new Set<string>();
  const cleanAck = emittedAckText?.trim();
  if (cleanAck) {
    candidates.add(cleanAck);
  }
  candidates.add(TASK_ACK_TEXT);

  for (const prefix of candidates) {
    const escaped = escapeRegExp(prefix);
    if (options.suppressPureMatch) {
      const pureRe = new RegExp(`^${escaped}[，,！!。.;；:：\\s~～]*$`, "i");
      if (pureRe.test(trimmed)) {
        return "";
      }
    }
    const leadRe = new RegExp(`^${escaped}[，,！!。.;；:：\\s~～]+`, "i");
    const stripped = trimmed.replace(leadRe, "").trim();
    if (stripped !== trimmed && stripped.length >= 2) {
      return stripped;
    }
  }
  return trimmed;
}
