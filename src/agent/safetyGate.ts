// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 确定性安全风险分级、运行时物理安全探针与不可绕过安全闸门
// Copyright (C) 2026 MiHome-Windows contributors

import type { IMijiaService } from "../core/contracts.ts";
import type { DeviceInfo } from "../core/models.ts";
import { isDangerousAction } from "../core/specZh.ts";

export type RiskLevel = "L1_LOW" | "L2_MEDIUM_APPLIANCE" | "L2_SEASONAL" | "L3_HIGH_SAFETY";

export type SpeakerRole =
  | "desktop_owner"
  | "verified_owner"
  | "verified_member"
  | "unidentified_enrolled"
  | "unenrolled_default";

export interface SpeakerPrincipal {
  role: SpeakerRole;
  speakerId: string;
  speakerName?: string;
  /** 本条请求是否允许在记忆达成信任阈值后跳过确认 */
  canSkipConfirmationOnTrusted: boolean;
  /** 本条请求是否允许推进共享/本人记忆计数 */
  canPromoteMemory: boolean;
  /** 本条请求是否允许执行 L3 高安全风险操作（经过明确二次确认后） */
  canExecuteL3WithConfirm: boolean;
}

export interface SpeakerIdentityInput {
  source?: "web" | "voice" | "api";
  speakerId?: string | null;
  speakerName?: string | null;
  matched?: boolean;
  enrolledCount?: number;
  /** 可选：标记该声纹 ID 是否为家庭主人（默认首位注册或明确标注 owner） */
  isOwner?: boolean;
}

/**
 * 根据请求来源与声纹上下文解析说话人主体与权限边界。
 */
export function resolveSpeakerPrincipal(input?: SpeakerIdentityInput | null): SpeakerPrincipal {
  if (!input || input.source === "web" || input.source === "api") {
    return {
      role: "desktop_owner",
      speakerId: "owner:desktop",
      speakerName: "桌面主人",
      canSkipConfirmationOnTrusted: true,
      canPromoteMemory: true,
      canExecuteL3WithConfirm: true,
    };
  }

  const enrolledCount = Number.isFinite(input.enrolledCount) ? Math.max(0, Number(input.enrolledCount)) : 0;
  if (enrolledCount <= 0) {
    return {
      role: "unenrolled_default",
      speakerId: "household:default",
      speakerName: "默认家庭语音",
      canSkipConfirmationOnTrusted: true,
      canPromoteMemory: true,
      canExecuteL3WithConfirm: true,
    };
  }

  if (!input.matched || !input.speakerId) {
    return {
      role: "unidentified_enrolled",
      speakerId: "voice:unidentified",
      speakerName: "未识别访客",
      canSkipConfirmationOnTrusted: false,
      canPromoteMemory: false,
      canExecuteL3WithConfirm: false,
    };
  }

  // 默认：若明确 isOwner === false 则为成员，否则若声纹已匹配且未标注非主人，视为已认证主人
  if (input.isOwner === false) {
    return {
      role: "verified_member",
      speakerId: `member:${input.speakerId}`,
      speakerName: input.speakerName || input.speakerId,
      canSkipConfirmationOnTrusted: true,
      canPromoteMemory: true,
      canExecuteL3WithConfirm: false,
    };
  }

  return {
    role: "verified_owner",
    speakerId: `owner:${input.speakerId}`,
    speakerName: input.speakerName || input.speakerId,
    canSkipConfirmationOnTrusted: true,
    canPromoteMemory: true,
    canExecuteL3WithConfirm: true,
  };
}

export interface ActionRiskAssessment {
  riskLevel: RiskLevel;
  /** true 表示无论记忆确认多少次，都不可免确认自动执行 */
  safetyLocked: boolean;
  /** true 表示处于硬件告警/故障状态，直接阻断执行 */
  hardBlocked: boolean;
  reasons: string[];
  /** 可选的用户提示文案 */
  warningText?: string;
}

export interface ProposedToolAction {
  toolName:
    | "set_device_power"
    | "set_device_property"
    | "run_device_action"
    | "batch_control_devices"
    | "run_scene";
  did?: string;
  device?: DeviceInfo | null;
  propName?: string;
  actionName?: string;
  value?: unknown;
  params?: Record<string, unknown>;
  /** 可选：来自 batch_control_devices 的类别或动作 */
  category?: string;
  power?: "on" | "off";
  /** 可选：如果是洗衣机多筒控制，显式指定筒位 */
  drumKey?: string;
}

const HIGH_HEAT_WASHER_PROGRAMS = new Set([
  "cook_wash",
  "steam_sterilize_wash",
  "single_drying",
  "wash_drying_60",
  "fast_wash_drying",
  "deep_tub_self_clean",
  "water_ssp",
  "ssp",
  "self_wash_5",
]);

const INFRA_DEVICE_RE =
  /(?:路由器|网关|中枢|光猫|交换机|门锁|智能锁|摄像头|摄像机|监控|喂食器|逆变器|冰箱|冰柜|制氧机|router|gateway|hub|lock|camera|feeder|inverter|fridge)/i;

const SECURITY_DEVICE_RE = /(?:门锁|智能锁|摄像头|摄像机|监控|报警|烟感|气感|水浸|lock|camera|alarm)/i;
const IRRIGATION_DEVICE_RE = /(?:灌溉|浇花|浇水|喷灌|滴灌|水阀|电磁阀|irrigation|valve)/i;
const DRYER_DEVICE_RE = /(?:干衣机|烘干机|dryer|0xdc)/i;
const WATER_HEATER_RE = /(?:热水器|water[-_]?heater|0xe2|0xe3)/i;
const WASHER_DEVICE_RE = /(?:洗衣机|洗烘|可爱多|washer|0xd9|0xda|0xdb)/i;
const SEASONAL_DEVICE_RE = /(?:空调|除湿机|加湿器|电暖器|取暖器|air[-_]?condition|dehumidifier|heater|0xac|0xa1)/i;
const FEEDER_DEVICE_RE = /(?:喂食器|feeder)/i;
const VACUUM_DEVICE_RE = /(?:扫地|拖地|扫拖|vacuum)/i;

function deviceMetaText(device?: DeviceInfo | null): string {
  if (!device) return "";
  return `${device.name} ${device.model} ${device.spec_type} ${device.room_name}`.toLowerCase();
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function asBool(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1" || value === "true" || value === "on") return true;
  if (value === 0 || value === "0" || value === "false" || value === "off") return false;
  return null;
}

/**
 * 纯函数确定性风险分类器（代码级安全红线，独立于 LLM 提示词）。
 *
 * 原则：
 * - L3_HIGH_SAFETY：物理安全、涉水开启、高温/烘干/除菌、安防/门锁/监控关闭、关键基建断电、危险动作、越界参数。
 *   特例：关闭涉水阀/紧急停机属于安全降级操作，定为 L1_LOW（零确认快速放行）。
 * - L2_SEASONAL：空调、除湿机、取暖器等强季节敏感设备。
 * - L2_MEDIUM_APPLIANCE：洗衣机常规洗（如袜子洗/快洗）、扫地机、喂食器正常出粮。
 * - L1_LOW：普通灯光、窗帘、风扇、音箱正常音量、关水阀/暂停。
 */
export function classifyActionRisk(
  action: ProposedToolAction,
  speaker?: SpeakerPrincipal | null,
): ActionRiskAssessment {
  const reasons: string[] = [];
  const meta = deviceMetaText(action.device);
  const prop = (action.propName ?? "").trim().toLowerCase().replaceAll("_", "-");
  const act = (action.actionName ?? "").trim().toLowerCase().replaceAll("_", "-");

  // 1. 危险动作名直接 L3
  if (action.toolName === "run_device_action" && act && isDangerousAction(act)) {
    reasons.push(`危险设备动作「${action.actionName}」`);
  }

  // 2. 门锁 / 安防摄像头 / 隐私监控
  if (SECURITY_DEVICE_RE.test(meta)) {
    const isCameraOff =
      (action.toolName === "set_device_power" && (action.power === "off" || asBool(action.value) === false)) ||
      (action.toolName === "set_device_property" &&
        /(?:^on$|power|motion|detect|record|privacy|sleep|guard|alarm)/.test(prop) &&
        asBool(action.value) === false);
    const isLockMutate =
      /(?:门锁|智能锁|lock)/i.test(meta) &&
      (action.toolName === "run_device_action" ||
        action.toolName === "set_device_property" ||
        action.toolName === "set_device_power");
    if (isCameraOff) {
      reasons.push("关闭安防摄像头/告警或移动侦测");
    } else if (isLockMutate) {
      reasons.push("涉及门锁解锁或安防配置变更");
    }
  }

  // 3. 涉水灌溉设备：开启涉水必须 L3；关闭止水明确 L1 快速放行
  if (IRRIGATION_DEVICE_RE.test(meta)) {
    const turnOff =
      (action.toolName === "set_device_power" && (action.power === "off" || asBool(action.value) === false)) ||
      (action.toolName === "set_device_property" && /(?:^on$|power|valve|switch)/.test(prop) && asBool(action.value) === false) ||
      (action.toolName === "run_device_action" && /(?:stop|close|off|pause)/.test(act));
    if (turnOff) {
      return {
        riskLevel: "L1_LOW",
        safetyLocked: false,
        hardBlocked: false,
        reasons: ["紧急关闭涉水阀门（安全降级免确认）"],
      };
    }
    const turnOn =
      (action.toolName === "set_device_power" && (action.power === "on" || asBool(action.value) === true)) ||
      (action.toolName === "set_device_property" && /(?:^on$|power|valve|switch)/.test(prop) && asBool(action.value) === true) ||
      (action.toolName === "run_device_action" && /(?:start|open|on|water|irrigate)/.test(act));
    if (turnOn) {
      reasons.push("开启户外/室内灌溉水阀（存在持续出水与漏水风险）");
    }
  }

  // 4. 独立干衣机（0xDC）加热启动 -> L3；关闭/暂停 -> L1
  if (DRYER_DEVICE_RE.test(meta)) {
    const isStop =
      (action.toolName === "set_device_power" && (action.power === "off" || asBool(action.value) === false)) ||
      (action.toolName === "run_device_action" && /(?:pause|stop|off)/.test(act));
    if (!isStop) {
      reasons.push("干衣机涉及持续高温加热");
    }
  }

  // 5. 洗衣机高温 / 烘干 / 蒸汽除菌 / 解锁童锁
  if (WASHER_DEVICE_RE.test(meta)) {
    if (prop === "child-lock" && asBool(action.value) === false) {
      reasons.push("关闭洗衣机童锁");
    }
    if (prop === "temperature") {
      const temp = asNumber(action.value);
      if (temp !== null && temp >= 60) {
        reasons.push(`洗衣机高温洗涤（${temp}°C >= 60°C）`);
      }
    }
    if (prop === "dry-mode") {
      const dm = asNumber(action.value);
      if (dm !== null && dm > 0) {
        reasons.push("开启洗衣机高温烘干模式");
      }
    }
    if (prop === "steam-wash" && asBool(action.value) === true) {
      reasons.push("开启洗衣机蒸汽高温除菌");
    }
    if ((prop === "program" || /^drum-[a-z]+-program$/.test(prop)) && typeof action.value === "string") {
      const prog = action.value.trim().toLowerCase();
      if (HIGH_HEAT_WASHER_PROGRAMS.has(prog)) {
        reasons.push(`洗衣机高温/烘干程序「${prog}」`);
      }
    }
  }

  // 6. 热水器高温设置
  if (WATER_HEATER_RE.test(meta) && /temp/.test(prop)) {
    const temp = asNumber(action.value);
    const isGas = /燃气|gas|0xe3/i.test(meta);
    if (temp !== null && ((isGas && temp > 50) || (!isGas && temp > 65))) {
      reasons.push(`热水器高温设定（${temp}°C，存在烫伤风险）`);
    }
  }

  // 7. 关键基础设施断电 / 批量关断全部或插座/安防设备
  if (action.toolName === "set_device_power" && (action.power === "off" || asBool(action.value) === false)) {
    if (INFRA_DEVICE_RE.test(meta)) {
      reasons.push(`关闭关键基础设施电源「${action.device?.name ?? action.did ?? ""}」`);
    }
  }
  if (action.toolName === "batch_control_devices") {
    const cat = (action.category ?? "").toLowerCase();
    if (action.power === "off" && (cat === "all" || cat === "switch" || cat === "camera" || cat === "lock")) {
      reasons.push(`批量关闭「${cat}」类别设备（可能波及网络/安防/常供电设备）`);
    }
  }

  // 8. 异常参数阈值保护（喂食器过量出粮、音箱超高音量、空调极端温度）
  if (FEEDER_DEVICE_RE.test(meta)) {
    const portions =
      asNumber(action.value) ??
      asNumber(action.params?.portions) ??
      asNumber(action.params?.count) ??
      asNumber(action.params?.["pet-food-out"]);
    const limit = speaker?.role === "verified_member" ? 3 : 5;
    if (portions !== null && portions >= limit) {
      reasons.push(`喂食器单次出粮份数过高（${portions} 份）`);
    }
  }
  if (/(?:volume|音量)/.test(prop)) {
    const vol = asNumber(action.value);
    if (vol !== null && vol > 80) {
      reasons.push(`音量设定过高（${vol}% > 80%）`);
    }
  }
  if (SEASONAL_DEVICE_RE.test(meta) && /target-temperature|temperature/.test(prop)) {
    const t = asNumber(action.value);
    if (t !== null && (t < 18 || t > 29)) {
      reasons.push(`空调温度越界（${t}°C 超出 18~29°C 舒适安全区间）`);
    }
  }

  if (reasons.length > 0) {
    return {
      riskLevel: "L3_HIGH_SAFETY",
      safetyLocked: true,
      hardBlocked: false,
      reasons,
      warningText: `安全闸门拦截：${reasons.join("；")}，执行前必须明确确认。`,
    };
  }

  // 非 L3 级别细分
  if (SEASONAL_DEVICE_RE.test(meta)) {
    return {
      riskLevel: "L2_SEASONAL",
      safetyLocked: false,
      hardBlocked: false,
      reasons: [],
    };
  }

  if (WASHER_DEVICE_RE.test(meta) || VACUUM_DEVICE_RE.test(meta) || FEEDER_DEVICE_RE.test(meta)) {
    return {
      riskLevel: "L2_MEDIUM_APPLIANCE",
      safetyLocked: false,
      hardBlocked: false,
      reasons: [],
    };
  }

  return {
    riskLevel: "L1_LOW",
    safetyLocked: false,
    hardBlocked: false,
    reasons: [],
  };
}

export interface WasherRuntimeSafetyResult {
  status: "ok" | "require_confirm" | "hard_block";
  reasons: string[];
  snapshot: Record<string, unknown>;
}

/**
 * 洗衣机启动前实时安全探针：
 * 在 `start-wash` 或 `control-status=true` 执行前检查实时硬件状态，
 * 即使该记忆已处于 autonomous 状态，只要触发过热/故障直接硬阻断，
 * 只要舱门未关/童锁开启/筒内残留高温或烘干程序则强制升级为二次确认。
 *
 * 注：不以 `remote-control-flag === false` 作为前置硬阻断条件——
 * 美的 0xD9/0xDB 实机在关机待机态（即便已开启长期授权）、副筒
 * （如 38135636 左/右筒 `supportRemoteControlAgree=false`）及部分固件上
 * 均会上报 `0` 而实际可正常远程控制；真正未授权时由机身固件直接拒启，无物理安全风险。
 */
export async function probeWasherRuntimeSafety(
  service: IMijiaService,
  did: string,
  drumKey?: string,
): Promise<WasherRuntimeSafetyResult> {
  const prefix = drumKey && drumKey !== "main" ? `drum-${drumKey}-` : "";
  const propNames = [
    `${prefix}door-opened`,
    `${prefix}child-lock`,
    `${prefix}water-overheating`,
    `${prefix}drying-tunnel-overheating`,
    `${prefix}remote-control-flag`,
    `${prefix}error-code`,
    `${prefix}program`,
    `${prefix}temperature`,
    `${prefix}dry-mode`,
    `${prefix}steam-wash`,
    `${prefix}running-status`,
  ];

  let snapshot: Record<string, unknown> = {};
  try {
    snapshot = await service.readProps(did, propNames);
  } catch {
    // 某些模拟设备或非美的洗衣机可能不支持全部属性，安全降级不阻断但记录空快照
    return { status: "ok", reasons: [], snapshot };
  }

  const getVal = (field: string): unknown => {
    const prefixed = `${prefix}${field}`;
    if (snapshot[prefixed] !== undefined && snapshot[prefixed] !== null) {
      return snapshot[prefixed];
    }
    return snapshot[field];
  };

  const hardReasons: string[] = [];
  const confirmReasons: string[] = [];

  if (getVal("water-overheating") === true) {
    hardReasons.push("洗衣机存在水温过热告警");
  }
  if (getVal("drying-tunnel-overheating") === true) {
    hardReasons.push("洗衣机存在烘干风道过热告警");
  }
  const errorCode = String(getVal("error-code") ?? "").trim();
  if (errorCode && errorCode !== "0" && errorCode.toLowerCase() !== "none" && errorCode.toLowerCase() !== "ok") {
    hardReasons.push(`洗衣机报告硬件故障码（${errorCode}）`);
  }

  if (hardReasons.length > 0) {
    return { status: "hard_block", reasons: hardReasons, snapshot };
  }

  if (getVal("door-opened") === true) {
    confirmReasons.push("检测到洗衣机舱门处于开启状态，请确认已关好舱门");
  }
  if (getVal("child-lock") === true) {
    confirmReasons.push("检测到洗衣机童锁已开启");
  }
  const curTemp = asNumber(getVal("temperature"));
  if (curTemp !== null && curTemp >= 60) {
    confirmReasons.push(`当前筒位残留高温设置（${curTemp}°C）`);
  }
  const curDry = asNumber(getVal("dry-mode"));
  if (curDry !== null && curDry > 0) {
    confirmReasons.push("当前筒位已勾选烘干模式");
  }
  if (getVal("steam-wash") === true) {
    confirmReasons.push("当前筒位已开启蒸汽除菌高温模式");
  }
  const curProg = String(getVal("program") ?? "").trim().toLowerCase();
  if (curProg && HIGH_HEAT_WASHER_PROGRAMS.has(curProg)) {
    confirmReasons.push(`当前筒位程序为高温/烘干模式（${curProg}）`);
  }

  if (confirmReasons.length > 0) {
    return { status: "require_confirm", reasons: confirmReasons, snapshot };
  }

  return { status: "ok", reasons: [], snapshot };
}

/**
 * 附加指令反越狱检查：拒绝试图通过“永久记住/不要问/直接执行”绕过 L3 高安全风险操作确认的规则。
 */
const SAFETY_BYPASS_PHRASE_RE =
  /(?:不要问|别问|不用问|无需确认|免确认|跳过确认|直接执行|不再确认|永远直接|不用再确认|自动跳过)/;

const SAFETY_SENSITIVE_TARGET_RE =
  /(?:门锁|智能锁|开锁|解锁|摄像头|监控|移动侦测|报警|灌溉|水阀|浇花|浇水|烘干|干衣机|高温|煮洗|蒸汽除菌|热水器|童锁|出厂设置|恢复出厂|重启|格式化|删除|所有设备|全部断电|安全确认|所有操作)/;

export function detectSafetyBypassInstruction(content: string): { blocked: boolean; reason?: string } {
  const s = String(content ?? "").trim();
  if (!s) return { blocked: false };
  if (SAFETY_BYPASS_PHRASE_RE.test(s) && SAFETY_SENSITIVE_TARGET_RE.test(s)) {
    return {
      blocked: true,
      reason:
        "安全策略不允许通过自定义指令跳过高安全风险操作（门锁/安防/涉水/高温烘干/危险控制）的二次确认。",
    };
  }
  return { blocked: false };
}

/**
 * 计算待执行动作的稳定指纹，用于宿主侧一次性确认票据的严格绑定（防止 LLM 借 A 确认执行 B）。
 */
export function computeActionFingerprint(input: {
  toolName: string;
  did?: string;
  propName?: string;
  actionName?: string;
  value?: unknown;
  drumKey?: string;
  category?: string;
  power?: string;
}): string {
  const normalized = [
    input.toolName,
    input.did ?? "",
    input.drumKey ?? "",
    (input.propName ?? "").toLowerCase().replaceAll("_", "-"),
    (input.actionName ?? "").toLowerCase().replaceAll("_", "-"),
    input.category ?? "",
    input.power ?? "",
    input.value === undefined ? "" : JSON.stringify(input.value),
  ].join("|");
  return normalized;
}

export interface SafetyConfirmationTicket {
  id: string;
  fingerprint: string;
  did?: string;
  toolName: string;
  createdAt: number;
  expiresAt: number;
  used: boolean;
}

/**
 * 宿主独占的一次性安全确认票据表：
 * 只有用户明确确认了对应的 PendingConfirmation，宿主才会签发短时单次有效票据；
 * LLM 无法仅靠伪造 `confirm_dangerous: true` 绕过 L3 安全闸门。
 */
export class SafetyConfirmationRegistry {
  private readonly tickets = new Map<string, SafetyConfirmationTicket>();
  private readonly now: () => number;

  constructor(now?: () => number) {
    this.now = now ?? (() => Date.now());
  }

  grant(
    input: {
      fingerprint: string;
      did?: string;
      toolName: string;
      ttlMs?: number;
    },
  ): SafetyConfirmationTicket {
    const nowMs = this.now();
    this.prune(nowMs);
    const id = `sc_${nowMs.toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const ticket: SafetyConfirmationTicket = {
      id,
      fingerprint: input.fingerprint,
      did: input.did,
      toolName: input.toolName,
      createdAt: nowMs,
      expiresAt: nowMs + (input.ttlMs ?? 90_000),
      used: false,
    };
    this.tickets.set(id, ticket);
    return ticket;
  }

  /**
   * 校验并原子消费匹配票据（按 fingerprint 精确匹配，或同 did+toolName 匹配）。
   */
  consumeMatching(input: { fingerprint: string; did?: string; toolName: string }): boolean {
    const nowMs = this.now();
    this.prune(nowMs);
    for (const ticket of this.tickets.values()) {
      if (ticket.used || ticket.expiresAt < nowMs) continue;
      if (
        ticket.fingerprint === input.fingerprint ||
        (ticket.fingerprint === "*" && ticket.did === input.did)
      ) {
        ticket.used = true;
        return true;
      }
    }
    return false;
  }

  hasValid(fingerprint: string): boolean {
    const nowMs = this.now();
    this.prune(nowMs);
    for (const ticket of this.tickets.values()) {
      if (!ticket.used && ticket.expiresAt >= nowMs && ticket.fingerprint === fingerprint) {
        return true;
      }
    }
    return false;
  }

  clear(): void {
    this.tickets.clear();
  }

  private prune(nowMs: number): void {
    for (const [id, ticket] of this.tickets.entries()) {
      if (ticket.used || ticket.expiresAt < nowMs) {
        this.tickets.delete(id);
      }
    }
  }
}
