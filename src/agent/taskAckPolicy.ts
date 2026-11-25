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
      "明确且直接的常规设备控制或家电执行指令（如打开/关闭灯光、调亮度/色温/音量、调空调温度或模式、开关窗帘、帮我洗一下衣服/启动洗衣机、宠物喂食、播放或切歌、设闹钟、删除已有规则等），以及隐式体感调节需求（如太暗了、太刺眼、太热了、太吵了）。",
  },
  query_status: {
    id: "query_status",
    label: "状态与信息查询",
    zh: "稍等我看一下",
    en: "Let me check",
    criteria:
      "仅查询或询问信息、不要求立即修改设备状态（如空调设置的多少度、客厅现在温湿度多少、某设备是否开着、洗衣机还剩多久、哪些灯开着/离线、全屋设备盘点、天气查询、或查看已保存的偏好规则）。",
  },
  think_creative: {
    id: "think_creative",
    label: "思考创作与问答",
    zh: "让我想想",
    en: "Let me think",
    criteria:
      "需要动脑思考、创意生成、知识科普、出主意或趣味互动的请求（如给我讲个笑话、讲个故事、写诗、脑筋急转弯、百科原理提问、晚上吃什么、生活建议、方案推荐或比较不同模式区别）。",
  },
  scene_routine: {
    id: "scene_routine",
    label: "场景与作息编排",
    zh: "马上安排",
    en: "On it",
    criteria:
      "涉及多设备联动编排、生活作息模式或整屋场景切换（如回家模式、离家、准备睡觉、起床、观影模式、会客、午休、下雨联动、全屋准备休息等需统筹多台设备的安排）；单台常规家电控制（如打开灯光、帮我洗一下衣服）归入 execute_control。",
  },
  troubleshoot: {
    id: "troubleshoot",
    label: "故障排查与异常",
    zh: "我来排查一下",
    en: "Let me look into it",
    criteria:
      "反馈设备故障、质疑上次控制未生效或询问异常原因（如灯怎么打不开、为什么空调没反应、洗衣机报错了、刚才好像没关掉、设备是不是离线或断网了）。",
  },
  urgent_cancel: {
    id: "urgent_cancel",
    label: "紧急停止与纠错",
    zh: "马上处理",
    en: "Right away",
    criteria:
      "要求紧急停止、立即中止播放或出水、撤销或纠正刚发生的误操作（如快停下、别放了、赶紧关掉、不对我说的是卧室的灯、搞错了撤回刚才的操作）。",
  },
  remember_rule: {
    id: "remember_rule",
    label: "记住长期规则",
    zh: "明白，我记一下",
    en: "Got it, noting that",
    criteria:
      "用户明确交代以后要长期记住的个人习惯、默认参数或条件规则（如“以后记得洗衣默认用智洗烘模式”“记住以后开空调先看室外温度”）；仅查询规则归入 query_status，删除规则归入 execute_control。",
  },
  safety_confirm: {
    id: "safety_confirm",
    label: "高风险安全确认",
    zh: "先确认一下",
    en: "Let's check first",
    criteria:
      "涉及安防隐私或破坏性高风险操作，需谨慎核实后再执行（如智能门锁开锁/改密、关闭监控摄像头、设备恢复出厂设置/格式化/重置、解除童锁、全屋总电源断电等）；普通开关灯、调空调、洗衣服不属于此类。",
  },
  greeting_chat: {
    id: "greeting_chat",
    label: "打招呼与寒暄",
    zh: "在呢",
    en: "I'm here",
    criteria:
      "单纯打招呼、寒暄问候、表达感谢或确认助手是否在线（如你好、早上好、晚安、在吗、辛苦了、谢谢你），不包含具体设备指令、状态查询或需要思考解答的问题。",
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
    "你是智能家居语音与对话助手。收到用户输入后、开始执行工具或组织正式回复之前，请快速判断该输入属于哪一类场景，以便立刻给出最自然贴切的简短首次应答词（例如：打开灯光/帮我洗一下衣服->execute_control，空调设置的多少度->query_status，给我讲个笑话->think_creative）。支持中英文，可结合 history 理解省略主语的追问。",
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
