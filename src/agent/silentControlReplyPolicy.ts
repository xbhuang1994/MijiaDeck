// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * 简单常规控制指令状态核验正常后的静默完成策略（Silent Simple Control Reply Policy）。
 *
 * 目标：
 * 1. 当用户下达简单常规设备控制指令（如开关灯、调亮度/色温/音量、暂停/停止播放、调空调/窗帘等），
 *    宿主在执行前已立刻给出简短应答词（如“好的”），并在执行后完成了真实设备状态核验；
 * 2. 若状态核验全部通过且无任何异常、重试、警告或需要向用户询问/确认的事项，
 *    则任务直接静默收尾（不再弹出二次确认回复气泡，也不再触发二次 TTS 语音播报）；
 * 3. 一旦存在任何异常状态（离线、未找到、不支持、状态未生效、部分失败、触发自愈重试、安全受限），
 *    或助手需要向用户询问/确认/提示信息，或属于查询/编排/规则/闲聊等非简单常规控制场景，
 *    则绝不静默，完整输出并播报回复。
 */

import type { DeviceInfo } from "../core/models.ts";
import { isSilentSentinel } from "./cavemanReplyPolicy.ts";
import {
  inferFallbackTaskAckScenario,
  type TaskAckScenario,
} from "./taskAckPolicy.ts";
import type {
  ExecutedToolTrace,
  TaskVerificationOutcome,
} from "./taskVerificationLoop.ts";

/** 核心常规控制类变更工具（均具备明确设备控制语义与状态核验能力）。 */
export const SIMPLE_ROUTINE_CONTROL_TOOLS = new Set<string>([
  "set_device_power",
  "control_light",
  "control_speaker",
  "set_device_property",
]);

/** 允许作为常规控制前置探测的只读工具（仅在变更调用之前且不涉及无关设备查询时放行）。 */
const PREREQUISITE_PROBE_TOOLS = new Set<string>([
  "get_device_detail",
  "list_devices",
]);

/** 简单可逆的常规设备动作白名单（如窗帘开合停、常见遥控开关/音量/播放键）。 */
const RE_SIMPLE_ROUTINE_ACTION =
  /^(?:power(?:on|off|_on|_off)?|on|off|toggle|open|close|stop|pause|play|play[-_]?pause|resume|next|prev(?:ious)?|mute|unmute|vol(?:ume)?[+-]?|ch(?:annel)?[+-]?|up|down|left|right|bright(?:ness)?[+-]?|dim|fan|swing|mode|sleep|开机|关机|开关|电源|打开|关闭|开|关|停止|暂停|播放|继续|上一首|下一首|静音|音量[+-]?|风速|摇头|模式)$/i;

/** 属于高危、不可逆或需汇报参数的动作（绝不静默）。 */
const RE_NON_ROUTINE_ACTION =
  /(?:reboot|restart|reset|default|restore|factory|format|delete|\bdel\b|calibrate|unlock|pet[-_]?food|manual[-_]?feed|start[-_]?wash|cancel[-_]?appointment|refresh[-_]?state|出粮|喂食|洗涤|重置|重启|恢复出厂|格式化|解锁)/i;

/** 涉及安防、网络基础设施、密码或定时的属性（变更后应明确回报确认，不静默）。 */
const RE_SENSITIVE_OR_SCHEDULE_PROP =
  /(?:password|passwd|pin|ssid|wifi|network|dns|child[-_]?lock|feed[-_]?plan|timer|countdown|delay|alarm|schedule|童锁|密码|倒计时|定时|闹钟|计划)/i;

/** 涉及安防或关键基础设施的设备关键词（控制后应明确汇报确认，不静默）。 */
const RE_SENSITIVE_DEVICE =
  /(?:门锁|智能锁|摄像头|摄像机|监控|移动侦测|隐私遮蔽|路由器|网关|总电源|鱼缸|冰箱|\bnas\b|\block\b|\bcamera\b|\brouter\b|\bgateway\b)/i;

/** 允许走静默完成的 Step 0 场景（常规控制与紧急停播/立即关闭类）。 */
const ALLOWED_SILENT_SCENARIOS = new Set<TaskAckScenario>([
  "execute_control",
  "urgent_cancel",
]);

/** 纠错/撤回类语句（用户纠正误操作时应简短确认已修正，不静默）。 */
const RE_CORRECTION_OR_UNDO =
  /(?:(?:不对|搞错了|说错了|弄错了|不是那个)[，,。\s]*(?:我说的是|我是说|是|应该|关回去|换)?|撤回|撤销(?:刚才|上一[步轮次])|取消刚才|\b(?:undo\s+that|cancel\s+that|wrong\s+(?:room|light|device))\b)/i;

/** 多设备作息/场景编排语义线索（即便离线兜底未归类为 scene_routine，也不按单步简单控制静默）。 */
const RE_SCENE_OR_ROUTINE_CUE =
  /(?:准备看电影|看电影|观影|影院模式|回家模式|离家模式|出门模式|睡眠模式|睡觉模式|起床模式|会客模式|午休模式|阅读模式|专注模式|开会模式|准备睡觉|我要睡觉|准备休息|准备出门|准备午休|\b(?:movie\s+(?:time|mode)|bedtime|sleep\s+mode|leaving\s+home)\b)/i;

/** 显式包含信息查询/状态汇报诉求的复合语句（如“打开客厅灯，顺便看看卧室多少度”）。 */
const RE_EXPLICIT_INFO_QUERY =
  /(?:多少度|几度|温度(?:是)?多少|湿度(?:是)?多少|电量(?:是)?多少|PM\s*2\.?5|空气质量|还剩多久|还有多久|剩余时间|开着吗|关着吗|是不是开着|是不是关着|设置(?:的|了)?多少|当前状态|查一下|查看一下|告诉我|汇报一下|有哪些(?:灯|设备|规则|指令)|哪些(?:灯|设备).*(?:开着|关着|离线)|设备盘点|全屋巡检|天气怎么样|明天(?:会)?下雨吗|查(?:一下)?天气|\b(?:what\s+temp(?:erature)?|how\s+(?:warm|hot|cold|humid)|is\s+the\s+.*\b(?:on|off)|check\s+(?:the\s+)?(?:status|temp|temperature|humidity|weather|battery)|how\s+much\s+time\s+left|tell\s+me\b)\b)/i;

/** 候选回复中包含向用户提问、确认、澄清或等待选择的语义信号。 */
const RE_REPLY_ASKS_QUESTION =
  /(?:[?？]|请问|请先?确认|二次确认|确定要|是否(?:需要|继续|打开|关闭|开启|执行|切换|设置|要)|要不要|需要我|要我|你想|您想|您要|想选|选哪|哪一?[个台路种]|请告诉我|请说明|请补充|请指定|\b(?:please\s+confirm|confirmation\s+required|are\s+you\s+sure|would\s+you\s+like|do\s+you\s+want|which\s+(?:one|room|device|mode)|let\s+me\s+know)\b)/i;

/** 候选回复中包含异常、失败、警告、受限、跳过或安全提示的语义信号。 */
const RE_REPLY_ANOMALY_OR_WARNING =
  /(?:异常|失败|离线|掉线|未找到|找不到|不支持|暂不支持|无法|不能|未能|没能|不可用|出错|错误|报错|故障|超时|水满|缺水|门未关|未关好|卡住|低电量|电量低|电量不足|安全提示|高风险|风险提示|警告|危险|不可逆|权限不足|暂未执行|已跳过|已屏蔽|尚未登录|扫码登录|网络不可用|抱歉|不好意思|对不起|不过|但是|(?<![一-龥])但(?=[，,\s]|检|卧|客|餐|书|阳|主|次|该|有|尚|目|部|仍|未|无|不)|注意|提示[：:]|\b(?:offline|failed|failure|error|unable|cannot|can't|couldn't|unsupported|not\s+found|warning|caution|danger|irreversible|safety\s+warning|permission\s+denied|timeout|timed\s+out|unfortunately|sorry|however|skipped|blocked|low\s+battery)\b)/i;

/** 工具详情附带提示/警告文案。 */
const RE_TOOL_NOTE_WARNING = /(?:提示[：:]|不支持|无法|失败|离线|警告|异常|报错)/;

export interface SilentControlReplyInput {
  /** 用户原始指令文本 */
  userText: string;
  /** Step 0 判定的场景类型 */
  ackScenario?: TaskAckScenario;
  /** 本轮最终执行的工具调用轨迹 */
  traces: readonly ExecutedToolTrace[];
  /** 执行后实时状态核验结果 */
  verification: TaskVerificationOutcome | null;
  /** 本轮消耗的自愈重试次数 */
  retriesUsed: number;
  /** 技能事件（新沉淀/更新技能需告知用户；复用技能零异常通过仍可静默） */
  skillEvent?: { kind: "created" | "updated" | "reused" } | null;
  /** 候选最终回复文本（用于识别询问、确认、警告与异常说明） */
  candidateReply?: string;
  /** 是否已向用户流式输出/播报过非 ack 正文 */
  alreadyEmittedReply?: boolean;
  /** 任务结束状态 */
  status?: "streaming" | "done" | "error" | "aborted";
  /** 可选设备清单（用于识别安防/基础设施等敏感设备） */
  devices?: readonly DeviceInfo[];
}

export interface SilentControlReplyDecision {
  silent: boolean;
  reason: string;
}

/**
 * 判断候选回复是否包含需要用户回答、澄清或二次确认的问题。
 */
export function replyNeedsUserAttention(reply?: string): boolean {
  const clean = reply?.trim() ?? "";
  if (!clean || isSilentSentinel(clean)) return false;
  return RE_REPLY_ASKS_QUESTION.test(clean);
}

/**
 * 判断候选回复是否包含异常状态、部分失败、受限说明或安全警告。
 */
export function replyReportsAnomalyOrWarning(reply?: string): boolean {
  const clean = reply?.trim() ?? "";
  if (!clean || isSilentSentinel(clean)) return false;
  return RE_REPLY_ANOMALY_OR_WARNING.test(clean);
}

/**
 * 判断用户指令是否显式包含信息/状态查询诉求（如复合指令“开灯顺便看看温度”）。
 */
export function hasExplicitInfoQueryIntent(userText: string): boolean {
  const clean = userText.trim();
  if (!clean) return false;
  return RE_EXPLICIT_INFO_QUERY.test(clean);
}

/**
 * 判断单条 `run_device_action` 调用是否属于简单可逆的常规控制动作。
 */
export function isSimpleRoutineDeviceAction(trace: ExecutedToolTrace): boolean {
  if (trace.name !== "run_device_action") return false;
  if (trace.isError) return false;
  if (trace.args.confirm_dangerous === true) return false;

  const d = trace.details ?? {};
  if (d.blockedDangerousAction === true || d.requiresConfirmation === true) return false;
  if (d.isFeederAction === true) return false;
  if (typeof d.controlWarning === "string" && d.controlWarning.trim().length > 0) return false;

  const actionRaw = typeof trace.args.action === "string" ? trace.args.action.trim() : "";
  const actionResolved = typeof d.action === "string" ? d.action.trim() : "";
  const actionLabel = typeof d.actionLabel === "string" ? d.actionLabel.trim() : "";
  const combined = [actionRaw, actionResolved, actionLabel].filter(Boolean).join(" ");
  if (!combined) return false;
  if (RE_NON_ROUTINE_ACTION.test(combined)) return false;

  return (
    (actionRaw.length > 0 && RE_SIMPLE_ROUTINE_ACTION.test(actionRaw)) ||
    (actionResolved.length > 0 && RE_SIMPLE_ROUTINE_ACTION.test(actionResolved)) ||
    (actionLabel.length > 0 && RE_SIMPLE_ROUTINE_ACTION.test(actionLabel))
  );
}

function collectTraceDids(trace: ExecutedToolTrace): string[] {
  const out: string[] = [];
  const d = trace.details ?? {};
  if (typeof d.did === "string" && d.did) {
    out.push(d.did);
  }
  if (Array.isArray(d.succeeded)) {
    for (const item of d.succeeded) {
      if (item && typeof item === "object" && typeof (item as { did?: unknown }).did === "string") {
        const did = (item as { did: string }).did;
        if (did) out.push(did);
      }
    }
  }
  return out;
}

function traceHasSensitiveDevice(
  trace: ExecutedToolTrace,
  deviceByDid: ReadonlyMap<string, DeviceInfo>,
): boolean {
  const d = trace.details ?? {};
  const names: string[] = [];
  if (typeof d.name === "string" && d.name) names.push(d.name);
  if (typeof trace.args.target === "string" && trace.args.target) names.push(trace.args.target);
  if (trace.args.category === "camera") return true;

  if (Array.isArray(d.succeeded)) {
    for (const item of d.succeeded) {
      if (item && typeof item === "object") {
        const rec = item as { name?: unknown; did?: unknown };
        if (typeof rec.name === "string" && rec.name) names.push(rec.name);
      }
    }
  }

  for (const did of collectTraceDids(trace)) {
    const dev = deviceByDid.get(did);
    if (dev) {
      names.push(dev.name, dev.model, dev.spec_type);
    }
  }

  return names.some((label) => RE_SENSITIVE_DEVICE.test(label));
}

function traceHasWarningOrPartialFailure(trace: ExecutedToolTrace): boolean {
  const d = trace.details ?? {};
  if (Array.isArray(d.failed) && d.failed.length > 0) return true;
  if (typeof d.controlWarning === "string" && d.controlWarning.trim().length > 0) return true;
  if (d.blockedDangerousAction === true || d.requiresConfirmation === true) return true;

  if (Array.isArray(d.succeeded)) {
    for (const item of d.succeeded) {
      if (item && typeof item === "object") {
        const note = (item as { note?: unknown }).note;
        if (typeof note === "string" && RE_TOOL_NOTE_WARNING.test(note)) {
          return true;
        }
      }
    }
  }

  if (trace.name === "control_speaker" && RE_TOOL_NOTE_WARNING.test(trace.text)) {
    return true;
  }

  return false;
}

function isSimpleControlMutatingTrace(
  trace: ExecutedToolTrace,
  deviceByDid: ReadonlyMap<string, DeviceInfo>,
): boolean {
  if (trace.isError) return false;
  if (traceHasWarningOrPartialFailure(trace)) return false;
  if (traceHasSensitiveDevice(trace, deviceByDid)) return false;

  if (trace.name === "set_device_property") {
    const propName =
      typeof trace.details?.property === "string"
        ? trace.details.property
        : typeof trace.args.property === "string"
          ? trace.args.property
          : "";
    const propLabel = typeof trace.details?.propLabel === "string" ? trace.details.propLabel : "";
    if (RE_SENSITIVE_OR_SCHEDULE_PROP.test(`${propName} ${propLabel}`)) {
      return false;
    }
    return true;
  }

  if (SIMPLE_ROUTINE_CONTROL_TOOLS.has(trace.name)) {
    return true;
  }

  if (trace.name === "run_device_action") {
    return isSimpleRoutineDeviceAction(trace);
  }

  return false;
}

/**
 * 综合判定：当前任务是否应在状态核验通过后保持静默（无需二次文字/语音回复）。
 *
 * 仅当同时满足全部 4 道护栏时返回 `silent: true`：
 * 1. 执行成功、零错误、零重试、未新沉淀技能，且实时状态核验已运行并全部通过；
 * 2. 场景与用户意图为简单常规控制（排除查询、创作、多设备场景编排、排错、记规则、高危确认、寒暄、纠错撤回及复合查询）；
 * 3. 工具轨迹严格由简单常规控制工具构成（允许变更前针对同一设备的前置只读探测，排除安防/定时/喂食/小爱转交/带警告调用）；
 * 4. 候选回复不包含向用户提问、确认、澄清、异常或警告信息。
 */
export function evaluateSilentControlReply(
  input: SilentControlReplyInput,
): SilentControlReplyDecision {
  // Gate 1: 任务与状态核验必须完全正常（零异常、零重试）
  if (input.status && input.status !== "done") {
    return { silent: false, reason: "non_done_status" };
  }
  if (input.alreadyEmittedReply) {
    return { silent: false, reason: "already_emitted_reply" };
  }
  if (input.retriesUsed > 0) {
    return { silent: false, reason: "recovery_retried" };
  }
  if (
    input.skillEvent &&
    (input.skillEvent.kind === "created" || input.skillEvent.kind === "updated")
  ) {
    return { silent: false, reason: "skill_created_or_updated" };
  }
  if (
    !input.verification ||
    !input.verification.checked ||
    !input.verification.passed ||
    input.verification.issues.length > 0 ||
    input.verification.checks.length === 0
  ) {
    return { silent: false, reason: "verification_not_clean_pass" };
  }
  if (input.traces.length === 0 || input.traces.some((t) => t.isError)) {
    return { silent: false, reason: "tool_error_or_empty" };
  }

  // Gate 2: 场景与用户意图必须是简单常规控制
  const userText = input.userText.trim();
  const effectiveScenario = input.ackScenario ?? inferFallbackTaskAckScenario(userText);
  if (!ALLOWED_SILENT_SCENARIOS.has(effectiveScenario)) {
    return { silent: false, reason: `disallowed_scenario:${effectiveScenario}` };
  }
  if (RE_CORRECTION_OR_UNDO.test(userText)) {
    return { silent: false, reason: "correction_or_undo" };
  }
  if (RE_SCENE_OR_ROUTINE_CUE.test(userText)) {
    return { silent: false, reason: "scene_or_routine_cue" };
  }
  if (hasExplicitInfoQueryIntent(userText)) {
    return { silent: false, reason: "user_requested_info_or_question" };
  }
  if (RE_SENSITIVE_DEVICE.test(userText)) {
    return { silent: false, reason: "sensitive_device_in_utterance" };
  }

  // Gate 3: 执行的工具必须严格属于简单常规控制（含变更前同设备前置探查）
  const deviceByDid = new Map<string, DeviceInfo>(
    (input.devices ?? []).map((d) => [d.did, d]),
  );

  const mutatingIndices: number[] = [];
  const mutatedDids = new Set<string>();

  for (let i = 0; i < input.traces.length; i += 1) {
    const tr = input.traces[i]!;
    if (PREREQUISITE_PROBE_TOOLS.has(tr.name)) {
      continue;
    }
    if (!isSimpleControlMutatingTrace(tr, deviceByDid)) {
      return { silent: false, reason: `non_simple_control_tool:${tr.name}` };
    }
    mutatingIndices.push(i);
    for (const did of collectTraceDids(tr)) {
      mutatedDids.add(did);
    }
  }

  if (mutatingIndices.length === 0) {
    return { silent: false, reason: "no_simple_control_tool" };
  }

  const firstMutatingIdx = mutatingIndices[0]!;
  const lastMutatingIdx = mutatingIndices[mutatingIndices.length - 1]!;

  for (let i = 0; i < input.traces.length; i += 1) {
    const tr = input.traces[i]!;
    if (!PREREQUISITE_PROBE_TOOLS.has(tr.name)) continue;

    if (tr.name === "list_devices") {
      // list_devices 仅允许在首个变更工具之前作为寻址探查
      if (i > firstMutatingIdx) {
        return { silent: false, reason: "post_control_list_devices" };
      }
      continue;
    }

    if (tr.name === "get_device_detail") {
      // get_device_detail 仅允许在变更之前作为同一被控设备的属性前置探查
      if (i > lastMutatingIdx) {
        return { silent: false, reason: "post_control_device_query" };
      }
      const probeDids = collectTraceDids(tr);
      if (probeDids.length === 0 || !probeDids.some((did) => mutatedDids.has(did))) {
        return { silent: false, reason: "unrelated_device_detail_query" };
      }
    }
  }

  // Gate 4: 候选回复绝不能吞掉任何向用户的询问、确认、警告或异常说明
  if (replyNeedsUserAttention(input.candidateReply)) {
    return { silent: false, reason: "reply_asks_question_or_confirmation" };
  }
  if (replyReportsAnomalyOrWarning(input.candidateReply)) {
    return { silent: false, reason: "reply_reports_anomaly_or_warning" };
  }

  return { silent: true, reason: "simple_control_verified_ok" };
}
