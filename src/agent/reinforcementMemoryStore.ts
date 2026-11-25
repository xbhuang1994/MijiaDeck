// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 强化决策记忆仓库、混合艾宾浩斯时间衰减模型与渐进确认状态机
// Copyright (C) 2026 MiHome-Windows contributors

import { dataFile, readJson, writeJson } from "../core/jsonStore.ts";
import {
  canonicalizeImplicitIntent,
  fnv1aHash,
  type CanonicalIntent,
} from "./intentCanonicalizer.ts";
import {
  type RiskLevel,
  type SpeakerPrincipal,
} from "./safetyGate.ts";

export const REINFORCEMENT_MEMORIES_FILENAME = "reinforcement_memories.json";
export const REINFORCEMENT_MEMORIES_STORE_VERSION = 1;
export const MAX_REINFORCEMENT_MEMORIES = 120;
export const DEFAULT_CONFIRM_THRESHOLD = 2;

const DAY_MS = 24 * 60 * 60 * 1000;

let clockOverride: (() => number) | null = null;

export function getReinforcementNow(): number {
  return clockOverride ? clockOverride() : Date.now();
}

/** 仅供测试注入确定性时钟（模拟 +30d / +90d / +180d 休眠回退）。 */
export function setReinforcementClockOverride(fn: (() => number) | null): void {
  clockOverride = fn;
}

export type MemoryLifecycleStatus =
  | "learning"
  | "autonomous"
  | "stale_reconfirm"
  | "safety_locked"
  | "cooldown"
  | "revoked"
  | "superseded";

export type UiTrustStage =
  | "learning"
  | "autonomous"
  | "stale"
  | "safety_locked"
  | "disabled";

export interface MemoryActionBinding {
  did: string;
  deviceName: string;
  homeName?: string;
  roomName?: string;
  capabilityKey: string;
  drumKey?: string;
  drumLabel?: string;
  program?: string;
  programLabel?: string;
  /** 建议执行的工具步骤（可供本地引擎与云端模型直接复用） */
  steps: Array<{
    toolName: "set_device_power" | "set_device_property" | "run_device_action";
    did: string;
    propName?: string;
    actionName?: string;
    value?: unknown;
    power?: "on" | "off";
  }>;
}

export interface MemoryBindingRevision {
  binding: MemoryActionBinding;
  summary: string;
  changedAt: number;
  reason: string;
}

export interface ReinforcementMemory {
  id: string;
  /** 规范化意图键，例如 `implicit:laundry:wash:socks` */
  canonicalKey: string;
  /** 面向展示与回溯的触发语样本 */
  sampleUtterances: string[];
  /** 设备能力键，如 `midea:210006741790988#left:socks`（子筒独立衰减隔离） */
  capabilityKey: string;
  /** 说话人作用域：`global` 或 `member:<speakerId>` */
  speakerScope: string;
  /** 自动总结的人类可读决策规则，例如：`说“帮我洗袜子” -> 启动阳台「美的可爱多」左筒·袜子筒（socks）` */
  summary: string;
  /** 领域冲突标签（与 custom_instructions 冲突域兼容） */
  conflictDomains: string[];
  binding: MemoryActionBinding;
  previousBindings: MemoryBindingRevision[];

  riskLevel: RiskLevel;
  safetyLocked: boolean;
  seasonalSensitive: boolean;

  /** 已累计有效用户确认次数（默认达到 2 次后第 3 次免确认直接执行） */
  confirmCount: number;
  confirmThreshold: number;
  /** 历史累计免确认自动执行次数 */
  autoExecCount: number;
  /** 显式拒绝次数 / 修改次数 */
  rejectCount: number;
  modifyCount: number;
  /** 若短期内频繁修改（>=2次/30天），锁定为易变规则需每次确认 */
  volatileLocked: boolean;

  status: MemoryLifecycleStatus;
  enabled: boolean;

  /** 混合艾宾浩斯时间衰减参数 */
  stabilityDays: number;
  maxStabilityDays: number;
  growthAlpha: number;
  retentionThreshold: number;
  hardDormancyDays: number;

  /** 拓扑哈希与季节记录 */
  topologyHash: string;
  lastSeason: "spring" | "summer" | "autumn" | "winter";

  /** 防污染与幂等字段 */
  lastConfirmedTaskId?: string;
  lastConfirmedAt: number | null;
  lastExecutedAt: number | null;
  lastReinforcedAt: number | null;
  taintedUntil: number | null;
  cooldownUntil: number | null;

  createdAt: number;
  updatedAt: number;
}

interface ReinforcementStorePayload {
  version: number;
  memories: ReinforcementMemory[];
}

export interface DecayProfile {
  s0: number;
  sMax: number;
  alpha: number;
  thetaR: number;
  hardDormancyDays: number;
  seasonalSensitive: boolean;
}

export function getDecayProfile(riskLevel: RiskLevel): DecayProfile {
  switch (riskLevel) {
    case "L1_LOW":
      return {
        s0: 45,
        sMax: 180,
        alpha: 0.35,
        thetaR: 0.35,
        hardDormancyDays: 180,
        seasonalSensitive: false,
      };
    case "L2_SEASONAL":
      return {
        s0: 21,
        sMax: 60,
        alpha: 0.25,
        thetaR: 0.4,
        hardDormancyDays: 75,
        seasonalSensitive: true,
      };
    case "L2_MEDIUM_APPLIANCE":
      return {
        s0: 21,
        sMax: 75,
        alpha: 0.3,
        thetaR: 0.4,
        hardDormancyDays: 90,
        seasonalSensitive: false,
      };
    case "L3_HIGH_SAFETY":
      return {
        s0: 14,
        sMax: 14,
        alpha: 0,
        thetaR: 1.0,
        hardDormancyDays: 1,
        seasonalSensitive: false,
      };
  }
}

export function getSeasonForTimestamp(ts: number): "spring" | "summer" | "autumn" | "winter" {
  const month = new Date(ts).getMonth() + 1;
  if (month >= 3 && month <= 5) return "spring";
  if (month >= 6 && month <= 8) return "summer";
  if (month >= 9 && month <= 11) return "autumn";
  return "winter";
}

export function computeRetention(memory: ReinforcementMemory, nowMs = getReinforcementNow()): number {
  const anchor = Math.max(memory.lastExecutedAt ?? 0, memory.lastConfirmedAt ?? 0, memory.createdAt);
  const elapsedDays = Math.max(0, (nowMs - anchor) / DAY_MS);
  const stability = Math.max(1, memory.stabilityDays);
  return Math.exp(-elapsedDays / stability);
}

export function computeDaysSinceLastUse(memory: ReinforcementMemory, nowMs = getReinforcementNow()): number {
  const anchor = Math.max(memory.lastExecutedAt ?? 0, memory.lastConfirmedAt ?? 0, memory.createdAt);
  return Math.max(0, (nowMs - anchor) / DAY_MS);
}

export function computeUiTrustStage(
  memory: ReinforcementMemory,
  nowMs = getReinforcementNow(),
  currentTopologyHash?: string,
): UiTrustStage {
  if (!memory.enabled || memory.status === "revoked" || memory.status === "superseded") {
    return "disabled";
  }
  if (memory.safetyLocked || memory.riskLevel === "L3_HIGH_SAFETY") {
    return "safety_locked";
  }
  const gate = evaluateReinforcementGate(memory, { nowMs, currentTopologyHash });
  if (gate.decision === "execute_directly") {
    return "autonomous";
  }
  if (
    gate.reasonCode === "dormancy_hard_cap" ||
    gate.reasonCode === "retention_decayed" ||
    gate.reasonCode === "topology_drifted" ||
    gate.reasonCode === "seasonal_shift" ||
    memory.status === "stale_reconfirm"
  ) {
    return "stale";
  }
  return "learning";
}

export interface GateEvaluationContext {
  nowMs?: number;
  currentTopologyHash?: string;
  speaker?: SpeakerPrincipal | null;
  /** 若检测到新的运行时风险（例如洗衣机门未关），强制要求确认 */
  runtimeHazardReasons?: string[];
  /** 若存在多台候选设备冲突 */
  ambiguousDevices?: boolean;
}

export type GateReasonCode =
  | "trusted_autonomous"
  | "safety_locked"
  | "runtime_hazard"
  | "speaker_unverified"
  | "disabled_or_revoked"
  | "cooldown_active"
  | "tainted_after_undo"
  | "volatile_locked"
  | "ambiguous_devices"
  | "learning_threshold_not_met"
  | "dormancy_hard_cap"
  | "retention_decayed"
  | "topology_drifted"
  | "seasonal_shift";

export interface ReinforcementGateDecision {
  decision: "execute_directly" | "ask_confirmation";
  reasonCode: GateReasonCode;
  reasonText: string;
  retention: number;
  daysSinceLastUse: number;
  remainingConfirmations: number;
  /** 当为 true 时，用户只需再确认 1 次即可立即恢复 autonomous（休眠唤醒 1-confirm 恢复） */
  singleConfirmRecovery: boolean;
}

/**
 * 确定性渐进确认决策门：
 * 1. L3 安全锁 / 运行时危险 -> 永不跳过确认
 * 2. 未识别声纹 / 污染回滚 / 冷却 / 易变锁 / 多设备歧义 -> 必须确认
 * 3. confirmCount < confirmThreshold（默认 2 次） -> 必须确认（第 1、2 次）
 * 4. 时间衰减（艾宾浩斯保留率 < θ 或超过硬休眠上限 D_hard） / 设备拓扑变化 / 换季（>=14天） -> 必须再次确认，但只需 1 次确认即恢复自主执行
 * 5. 其余情况（第 3 次及以后在有效期内） -> 直接执行不打扰
 */
export function evaluateReinforcementGate(
  memory: ReinforcementMemory,
  ctx: GateEvaluationContext = {},
): ReinforcementGateDecision {
  const nowMs = ctx.nowMs ?? getReinforcementNow();
  const retention = computeRetention(memory, nowMs);
  const daysSinceLastUse = computeDaysSinceLastUse(memory, nowMs);

  if (memory.safetyLocked || memory.riskLevel === "L3_HIGH_SAFETY") {
    return {
      decision: "ask_confirmation",
      reasonCode: "safety_locked",
      reasonText: "该操作涉及高安全风险（L3），每次执行前必须再次确认。",
      retention,
      daysSinceLastUse,
      remainingConfirmations: 1,
      singleConfirmRecovery: false,
    };
  }

  if (ctx.runtimeHazardReasons && ctx.runtimeHazardReasons.length > 0) {
    return {
      decision: "ask_confirmation",
      reasonCode: "runtime_hazard",
      reasonText: `设备实时状态异常：${ctx.runtimeHazardReasons.join("；")}`,
      retention,
      daysSinceLastUse,
      remainingConfirmations: 1,
      singleConfirmRecovery: false,
    };
  }

  if (ctx.speaker && !ctx.speaker.canSkipConfirmationOnTrusted) {
    return {
      decision: "ask_confirmation",
      reasonCode: "speaker_unverified",
      reasonText: "当前声纹未通过主人认证，需要二次确认。",
      retention,
      daysSinceLastUse,
      remainingConfirmations: 1,
      singleConfirmRecovery: false,
    };
  }

  if (!memory.enabled || memory.status === "revoked" || memory.status === "superseded") {
    return {
      decision: "ask_confirmation",
      reasonCode: "disabled_or_revoked",
      reasonText: "该记忆规则已停用或被覆盖，需重新确认。",
      retention,
      daysSinceLastUse,
      remainingConfirmations: Math.max(1, memory.confirmThreshold - memory.confirmCount),
      singleConfirmRecovery: false,
    };
  }

  if (memory.cooldownUntil !== null && nowMs < memory.cooldownUntil) {
    return {
      decision: "ask_confirmation",
      reasonCode: "cooldown_active",
      reasonText: "该映射近期被用户拒绝，处于冷却期，需要重新确认。",
      retention,
      daysSinceLastUse,
      remainingConfirmations: Math.max(1, memory.confirmThreshold),
      singleConfirmRecovery: false,
    };
  }

  if (memory.taintedUntil !== null && nowMs < memory.taintedUntil) {
    return {
      decision: "ask_confirmation",
      reasonCode: "tainted_after_undo",
      reasonText: "该规则此前执行后被撤销，安全降级为需要重新确认。",
      retention,
      daysSinceLastUse,
      remainingConfirmations: Math.max(1, memory.confirmThreshold - memory.confirmCount),
      singleConfirmRecovery: false,
    };
  }

  if (memory.volatileLocked) {
    return {
      decision: "ask_confirmation",
      reasonCode: "volatile_locked",
      reasonText: "该指令对应的目标近期多次变更，暂保持每次确认。",
      retention,
      daysSinceLastUse,
      remainingConfirmations: 1,
      singleConfirmRecovery: false,
    };
  }

  if (ctx.ambiguousDevices) {
    return {
      decision: "ask_confirmation",
      reasonCode: "ambiguous_devices",
      reasonText: "检测到多台同名在线设备，需要确认目标设备。",
      retention,
      daysSinceLastUse,
      remainingConfirmations: 1,
      singleConfirmRecovery: false,
    };
  }

  const threshold = Math.max(1, memory.confirmThreshold || DEFAULT_CONFIRM_THRESHOLD);
  if (memory.confirmCount < threshold) {
    const remaining = threshold - memory.confirmCount;
    return {
      decision: "ask_confirmation",
      reasonCode: "learning_threshold_not_met",
      reasonText: `尚在学习阶段（已确认 ${memory.confirmCount}/${threshold} 次），需再确认。`,
      retention,
      daysSinceLastUse,
      remainingConfirmations: remaining,
      singleConfirmRecovery: false,
    };
  }

  // 以下四项属于“曾经可信但发生时间/环境漂移” -> 触发 stale_reconfirm（1 次确认即可恢复自主执行）
  if (daysSinceLastUse >= memory.hardDormancyDays) {
    return {
      decision: "ask_confirmation",
      reasonCode: "dormancy_hard_cap",
      reasonText: `距离上次使用已超过 ${Math.floor(daysSinceLastUse)} 天（上限 ${memory.hardDormancyDays} 天），需重新确认。`,
      retention,
      daysSinceLastUse,
      remainingConfirmations: 1,
      singleConfirmRecovery: true,
    };
  }

  if (retention < memory.retentionThreshold) {
    return {
      decision: "ask_confirmation",
      reasonCode: "retention_decayed",
      reasonText: `长期未使用导致记忆保留率降至 ${(retention * 100).toFixed(0)}%（阈值 ${(memory.retentionThreshold * 100).toFixed(0)}%），需重新确认。`,
      retention,
      daysSinceLastUse,
      remainingConfirmations: 1,
      singleConfirmRecovery: true,
    };
  }

  if (ctx.currentTopologyHash && memory.topologyHash && ctx.currentTopologyHash !== memory.topologyHash) {
    return {
      decision: "ask_confirmation",
      reasonCode: "topology_drifted",
      reasonText: "家庭设备列表或目标能力配置发生变化，需重新确认。",
      retention,
      daysSinceLastUse,
      remainingConfirmations: 1,
      singleConfirmRecovery: true,
    };
  }

  if (memory.seasonalSensitive && daysSinceLastUse >= 14) {
    const currentSeason = getSeasonForTimestamp(nowMs);
    if (currentSeason !== memory.lastSeason) {
      return {
        decision: "ask_confirmation",
        reasonCode: "seasonal_shift",
        reasonText: `已跨季节（${memory.lastSeason} -> ${currentSeason}），需确认环境设备偏好。`,
        retention,
        daysSinceLastUse,
        remainingConfirmations: 1,
        singleConfirmRecovery: true,
      };
    }
  }

  return {
    decision: "execute_directly",
    reasonCode: "trusted_autonomous",
    reasonText: `已稳定记住该偏好（已确认 ${memory.confirmCount} 次，保留率 ${(retention * 100).toFixed(0)}%），直接执行。`,
    retention,
    daysSinceLastUse,
    remainingConfirmations: 0,
    singleConfirmRecovery: false,
  };
}

// ============================================================================
// 持久化读写与 CRUD
// ============================================================================

export function getReinforcementMemoriesPath(): string {
  return dataFile(REINFORCEMENT_MEMORIES_FILENAME);
}

function loadPayload(): ReinforcementStorePayload {
  const raw = readJson<Partial<ReinforcementStorePayload>>(getReinforcementMemoriesPath(), {
    version: REINFORCEMENT_MEMORIES_STORE_VERSION,
    memories: [],
  });
  const memories = Array.isArray(raw?.memories) ? raw.memories.filter((m) => m && typeof m.id === "string") : [];
  return {
    version: REINFORCEMENT_MEMORIES_STORE_VERSION,
    memories,
  };
}

function savePayload(payload: ReinforcementStorePayload): void {
  const trimmed = payload.memories.slice(0, MAX_REINFORCEMENT_MEMORIES);
  writeJson(getReinforcementMemoriesPath(), {
    version: REINFORCEMENT_MEMORIES_STORE_VERSION,
    memories: trimmed,
  });
}

export function listReinforcementMemories(opts?: { includeDisabled?: boolean }): ReinforcementMemory[] {
  const { memories } = loadPayload();
  const filtered = opts?.includeDisabled
    ? memories
    : memories.filter((m) => m.status !== "superseded");
  return filtered.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getReinforcementMemoryById(id: string): ReinforcementMemory | null {
  const { memories } = loadPayload();
  return memories.find((m) => m.id === id) ?? null;
}

/**
 * 依据规范化意图键与说话人作用域查找最匹配的强化记忆。
 * - `verified_owner` / `desktop_owner` / `unenrolled_default` 使用 `global` 作用域；
 * - `verified_member` 优先查找自己的 `member:<id>` 记忆；若不存在且为 L1 低风险可复用 `global`。
 */
export function findMatchingReinforcementMemory(
  canonicalKey: string,
  speaker?: SpeakerPrincipal | null,
): { memory: ReinforcementMemory | null; borrowedOwnerHint: ReinforcementMemory | null } {
  const { memories } = loadPayload();
  const active = memories.filter((m) => m.status !== "superseded" && m.status !== "revoked");

  const isMember = speaker?.role === "verified_member";
  const memberScope = isMember ? speaker.speakerId : "global";

  // 精确匹配 canonicalKey；兼容带/不带房间后缀的降级匹配
  const baseKey = canonicalKey.split("@")[0]!;

  const matchByScope = (scope: string): ReinforcementMemory | null => {
    const exact = active.find((m) => m.canonicalKey === canonicalKey && m.speakerScope === scope);
    if (exact) return exact;
    return active.find((m) => m.canonicalKey.split("@")[0] === baseKey && m.speakerScope === scope) ?? null;
  };

  if (isMember) {
    const own = matchByScope(memberScope);
    if (own) return { memory: own, borrowedOwnerHint: null };
    const globalMem = matchByScope("global");
    if (globalMem && globalMem.riskLevel === "L1_LOW") {
      return { memory: globalMem, borrowedOwnerHint: null };
    }
    return { memory: null, borrowedOwnerHint: globalMem };
  }

  return { memory: matchByScope("global"), borrowedOwnerHint: null };
}

export interface RecordConfirmationInput {
  canonicalKey: string;
  sampleUtterance: string;
  summary: string;
  binding: MemoryActionBinding;
  riskLevel: RiskLevel;
  topologyHash: string;
  conflictDomains?: string[];
  speaker?: SpeakerPrincipal | null;
  taskId?: string;
  nowMs?: number;
  /** 防抖最小间隔，默认 3000ms（测试可显式设为 0 或自定义值） */
  minConfirmGapMs?: number;
  /** 是否处于休眠唤醒恢复（1-confirm recovery） */
  singleConfirmRecovery?: boolean;
}

export interface RecordConfirmationResult {
  memory: ReinforcementMemory;
  promotedToAutonomous: boolean;
  deduplicated: boolean;
}

/**
 * 记录一次经过真实用户确认（并验证执行成功）的强化记忆：
 * - 自动去重同一 taskId 或极短时间内重复提交；
 * - 第 1 次 confirmCount = 1（learning）；
 * - 第 2 次 confirmCount = 2（若非 L3/易变锁 -> 晋升为 autonomous，第 3 次起免确认直接执行）；
 * - 若为休眠后重确认（singleConfirmRecovery），1 次确认即立即恢复 autonomous 并更新 S <- max(S0, 0.7 * S_prev)。
 */
export function recordReinforcementConfirmation(
  input: RecordConfirmationInput,
): RecordConfirmationResult {
  const nowMs = input.nowMs ?? getReinforcementNow();
  const payload = loadPayload();
  const speakerScope =
    input.speaker?.role === "verified_member" && input.riskLevel !== "L1_LOW"
      ? input.speaker.speakerId
      : "global";

  const existingIdx = payload.memories.findIndex(
    (m) =>
      m.canonicalKey === input.canonicalKey &&
      m.speakerScope === speakerScope &&
      m.status !== "superseded",
  );

  const profile = getDecayProfile(input.riskLevel);
  const safetyLocked = input.riskLevel === "L3_HIGH_SAFETY";
  const minGap = input.minConfirmGapMs ?? 3_000;

  if (existingIdx >= 0) {
    const mem = payload.memories[existingIdx]!;
    // 幂等防污染：同一 taskId 或极短突发抖动不重复累加
    if (
      (input.taskId && mem.lastConfirmedTaskId === input.taskId) ||
      (minGap > 0 && mem.lastConfirmedAt !== null && nowMs - mem.lastConfirmedAt < minGap)
    ) {
      return { memory: mem, promotedToAutonomous: false, deduplicated: true };
    }

    const prevStatus = mem.status;
    const bindingChanged =
      mem.binding.capabilityKey !== input.binding.capabilityKey ||
      mem.binding.did !== input.binding.did ||
      mem.binding.drumKey !== input.binding.drumKey ||
      mem.binding.program !== input.binding.program;

    if (bindingChanged) {
      mem.previousBindings = [
        ...mem.previousBindings.slice(-4),
        {
          binding: mem.binding,
          summary: mem.summary,
          changedAt: nowMs,
          reason: "user_changed_target",
        },
      ];
      mem.binding = input.binding;
      mem.capabilityKey = input.binding.capabilityKey;
      mem.summary = input.summary;
      mem.modifyCount += 1;
      mem.confirmCount = 1;
      if (mem.modifyCount >= 2 && nowMs - mem.createdAt <= 30 * DAY_MS) {
        mem.volatileLocked = true;
      }
    } else if (input.singleConfirmRecovery || mem.status === "stale_reconfirm") {
      // 1-confirm 休眠唤醒恢复：保留已达门槛的确认计数并部分恢复记忆稳定度
      mem.confirmCount = Math.max(mem.confirmCount + 1, mem.confirmThreshold);
      mem.stabilityDays = Math.max(profile.s0, Math.min(profile.sMax, mem.stabilityDays * 0.7));
    } else {
      mem.confirmCount += 1;
      const elapsedDays = mem.lastReinforcedAt ? Math.max(0, (nowMs - mem.lastReinforcedAt) / DAY_MS) : 0;
      if (elapsedDays >= 0.5) {
        mem.stabilityDays = Math.min(
          mem.maxStabilityDays,
          mem.stabilityDays * (1 + mem.growthAlpha * Math.min(1, elapsedDays / Math.max(1, mem.stabilityDays))),
        );
      }
    }

    mem.riskLevel = input.riskLevel;
    mem.safetyLocked = safetyLocked;
    mem.seasonalSensitive = profile.seasonalSensitive;
    mem.summary = input.summary || mem.summary;
    mem.topologyHash = input.topologyHash || mem.topologyHash;
    mem.lastSeason = getSeasonForTimestamp(nowMs);
    mem.lastConfirmedAt = nowMs;
    mem.lastExecutedAt = nowMs;
    mem.lastReinforcedAt = nowMs;
    mem.lastConfirmedTaskId = input.taskId;
    mem.taintedUntil = null;
    mem.cooldownUntil = null;
    mem.enabled = true;
    if (input.conflictDomains?.length) {
      mem.conflictDomains = Array.from(new Set([...mem.conflictDomains, ...input.conflictDomains]));
    }
    if (input.sampleUtterance && !mem.sampleUtterances.includes(input.sampleUtterance)) {
      mem.sampleUtterances = [...mem.sampleUtterances.slice(-7), input.sampleUtterance];
    }

    if (safetyLocked) {
      mem.status = "safety_locked";
    } else if (mem.volatileLocked || mem.confirmCount < mem.confirmThreshold) {
      mem.status = "learning";
    } else {
      mem.status = "autonomous";
    }
    mem.updatedAt = nowMs;

    payload.memories[existingIdx] = mem;
    savePayload(payload);
    return {
      memory: mem,
      promotedToAutonomous: prevStatus !== "autonomous" && mem.status === "autonomous",
      deduplicated: false,
    };
  }

  const id = `rm_${fnv1aHash(`${input.canonicalKey}:${speakerScope}:${nowMs}`)}_${Math.random()
    .toString(36)
    .slice(2, 6)}`;

  const initialCount = 1;
  const status: MemoryLifecycleStatus = safetyLocked ? "safety_locked" : "learning";

  const created: ReinforcementMemory = {
    id,
    canonicalKey: input.canonicalKey,
    sampleUtterances: input.sampleUtterance ? [input.sampleUtterance] : [],
    capabilityKey: input.binding.capabilityKey,
    speakerScope,
    summary: input.summary,
    conflictDomains: input.conflictDomains ? [...input.conflictDomains] : [],
    binding: input.binding,
    previousBindings: [],
    riskLevel: input.riskLevel,
    safetyLocked,
    seasonalSensitive: profile.seasonalSensitive,
    confirmCount: initialCount,
    confirmThreshold: DEFAULT_CONFIRM_THRESHOLD,
    autoExecCount: 0,
    rejectCount: 0,
    modifyCount: 0,
    volatileLocked: false,
    status,
    enabled: true,
    stabilityDays: profile.s0,
    maxStabilityDays: profile.sMax,
    growthAlpha: profile.alpha,
    retentionThreshold: profile.thetaR,
    hardDormancyDays: profile.hardDormancyDays,
    topologyHash: input.topologyHash,
    lastSeason: getSeasonForTimestamp(nowMs),
    lastConfirmedTaskId: input.taskId,
    lastConfirmedAt: nowMs,
    lastExecutedAt: nowMs,
    lastReinforcedAt: nowMs,
    taintedUntil: null,
    cooldownUntil: null,
    createdAt: nowMs,
    updatedAt: nowMs,
  };

  payload.memories.unshift(created);
  savePayload(payload);
  return {
    memory: created,
    promotedToAutonomous: false,
    deduplicated: false,
  };
}

/**
 * 免确认自主执行成功后的正向强化（遵循最小间隔 12h 才增长稳定度，防止短时间刷频拉满记忆寿命）。
 */
export function recordReinforcementAutonomousExecution(
  memoryId: string,
  opts?: { nowMs?: number; sampleUtterance?: string; minReinforceGapMs?: number },
): ReinforcementMemory | null {
  const nowMs = opts?.nowMs ?? getReinforcementNow();
  const minGap = opts?.minReinforceGapMs ?? 12 * 60 * 60 * 1000;
  const payload = loadPayload();
  const idx = payload.memories.findIndex((m) => m.id === memoryId);
  if (idx < 0) return null;

  const mem = payload.memories[idx]!;
  mem.autoExecCount += 1;
  mem.lastExecutedAt = nowMs;
  mem.lastSeason = getSeasonForTimestamp(nowMs);

  if (opts?.sampleUtterance && !mem.sampleUtterances.includes(opts.sampleUtterance)) {
    mem.sampleUtterances = [...mem.sampleUtterances.slice(-7), opts.sampleUtterance];
  }

  const sinceLastReinforce = mem.lastReinforcedAt ? nowMs - mem.lastReinforcedAt : Infinity;
  if (sinceLastReinforce >= minGap) {
    const elapsedDays = mem.lastReinforcedAt ? Math.max(0, (nowMs - mem.lastReinforcedAt) / DAY_MS) : 1;
    const retention = Math.exp(-elapsedDays / Math.max(1, mem.stabilityDays));
    // 间隔效应：越接近遗忘边缘仍成功复用，稳定度增益越大
    const spacingFactor = 0.5 + 0.5 * (1 - retention);
    mem.stabilityDays = Math.min(
      mem.maxStabilityDays,
      mem.stabilityDays * (1 + mem.growthAlpha * spacingFactor),
    );
    mem.lastReinforcedAt = nowMs;
  }

  mem.updatedAt = nowMs;
  payload.memories[idx] = mem;
  savePayload(payload);
  return mem;
}

/**
 * 用户明确拒绝映射（"不是这个意思/别用袜子筒"）时重置进度并进入 14 天冷却；累计拒绝 >=3 次自动撤销。
 */
export function recordReinforcementRejection(
  memoryId: string,
  opts?: { explicitMappingRejection?: boolean; nowMs?: number },
): ReinforcementMemory | null {
  const nowMs = opts?.nowMs ?? getReinforcementNow();
  const payload = loadPayload();
  const idx = payload.memories.findIndex((m) => m.id === memoryId);
  if (idx < 0) return null;

  const mem = payload.memories[idx]!;
  if (opts?.explicitMappingRejection) {
    mem.rejectCount += 1;
    mem.confirmCount = 0;
    if (mem.rejectCount >= 3) {
      mem.status = "revoked";
      mem.enabled = false;
    } else {
      mem.status = "cooldown";
      mem.cooldownUntil = nowMs + 14 * DAY_MS;
    }
    mem.updatedAt = nowMs;
    payload.memories[idx] = mem;
    savePayload(payload);
  }
  return mem;
}

/**
 * 撤销/纠偏污染回滚（120s 内取消刚刚自动执行的记忆动作 -> confirmCount 归零，48h 内强制确认）。
 */
export function taintReinforcementMemory(
  memoryId: string,
  opts?: { nowMs?: number; taintDurationMs?: number },
): ReinforcementMemory | null {
  const nowMs = opts?.nowMs ?? getReinforcementNow();
  const payload = loadPayload();
  const idx = payload.memories.findIndex((m) => m.id === memoryId);
  if (idx < 0) return null;

  const mem = payload.memories[idx]!;
  mem.confirmCount = 0;
  mem.status = mem.safetyLocked ? "safety_locked" : "learning";
  mem.taintedUntil = nowMs + (opts?.taintDurationMs ?? 48 * 60 * 60 * 1000);
  mem.updatedAt = nowMs;
  payload.memories[idx] = mem;
  savePayload(payload);
  return mem;
}

/**
 * 当用户保存了更高优先级的显式自定义规则（custom_instructions.json）时，将同冲突域的强化记忆标记为 superseded。
 */
export function supersedeMemoriesByDomains(domains: readonly string[], nowMs = getReinforcementNow()): number {
  if (!domains.length) return 0;
  const domainSet = new Set(domains);
  const payload = loadPayload();
  let changed = 0;
  for (const mem of payload.memories) {
    if (mem.status === "superseded") continue;
    const overlaps = mem.conflictDomains.some((d) => domainSet.has(d));
    if (overlaps) {
      mem.status = "superseded";
      mem.enabled = false;
      mem.updatedAt = nowMs;
      changed += 1;
    }
  }
  if (changed > 0) savePayload(payload);
  return changed;
}

export function toggleReinforcementMemory(id: string, enabled?: boolean): ReinforcementMemory | null {
  const payload = loadPayload();
  const idx = payload.memories.findIndex((m) => m.id === id);
  if (idx < 0) return null;
  const mem = payload.memories[idx]!;
  mem.enabled = typeof enabled === "boolean" ? enabled : !mem.enabled;
  if (mem.enabled && (mem.status === "revoked" || mem.status === "superseded")) {
    mem.status = mem.safetyLocked
      ? "safety_locked"
      : mem.confirmCount >= mem.confirmThreshold
        ? "autonomous"
        : "learning";
  }
  mem.updatedAt = getReinforcementNow();
  payload.memories[idx] = mem;
  savePayload(payload);
  return mem;
}

export function resetReinforcementMemory(id: string): ReinforcementMemory | null {
  const payload = loadPayload();
  const idx = payload.memories.findIndex((m) => m.id === id);
  if (idx < 0) return null;
  const mem = payload.memories[idx]!;
  mem.confirmCount = 0;
  mem.autoExecCount = 0;
  mem.rejectCount = 0;
  mem.volatileLocked = false;
  mem.taintedUntil = null;
  mem.cooldownUntil = null;
  mem.status = mem.safetyLocked ? "safety_locked" : "learning";
  mem.enabled = true;
  mem.updatedAt = getReinforcementNow();
  payload.memories[idx] = mem;
  savePayload(payload);
  return mem;
}

export function deleteReinforcementMemory(id: string): boolean {
  const payload = loadPayload();
  const next = payload.memories.filter((m) => m.id !== id);
  if (next.length === payload.memories.length) return false;
  savePayload({ version: REINFORCEMENT_MEMORIES_STORE_VERSION, memories: next });
  return true;
}

export function clearReinforcementMemories(): number {
  const payload = loadPayload();
  const count = payload.memories.length;
  if (count > 0) {
    savePayload({ version: REINFORCEMENT_MEMORIES_STORE_VERSION, memories: [] });
  }
  return count;
}

/**
 * 构建注入 Pi Agent 系统提示词的强化记忆摘要段（包含代码侧已裁决的可信状态）。
 */
export function buildReinforcementMemoriesPromptSection(opts?: {
  nowMs?: number;
  currentTopologyHash?: string;
  speaker?: SpeakerPrincipal | null;
}): string {
  const memories = listReinforcementMemories({ includeDisabled: false }).filter((m) => m.enabled);
  if (memories.length === 0) return "";

  const nowMs = opts?.nowMs ?? getReinforcementNow();
  const lines: string[] = [
    "## 强化决策记忆（渐进确认已沉淀规则）",
    "以下规则来自用户既往对歧义/隐式请求的确认总结，系统已按「最多问两次、第三次直接执行；久未触发或涉安全必重问」完成代码级状态裁决：",
  ];

  for (const mem of memories.slice(0, 12)) {
    const verdict = evaluateReinforcementGate(mem, {
      nowMs,
      currentTopologyHash: opts?.currentTopologyHash,
      speaker: opts?.speaker,
    });
    const tag =
      verdict.decision === "execute_directly"
        ? "[已信任·可直接执行]"
        : mem.safetyLocked
          ? "[安全锁·每次必确认]"
          : verdict.singleConfirmRecovery
            ? "[休眠待重确认·确认1次恢复]"
            : `[学习中 ${mem.confirmCount}/${mem.confirmThreshold}·需确认]`;
    lines.push(
      `- ${tag} ${mem.summary}（触发示例：${mem.sampleUtterances.slice(0, 2).join(" / ") || mem.canonicalKey}；原因：${verdict.reasonText}）`,
    );
  }
  lines.push(
    "原则：遇到 [已信任·可直接执行] 且无实时硬件危险告警的请求直接执行，勿多余反问；遇到 [学习中] / [休眠待重确认] / [安全锁] 必须先调用 `propose_confirmation` 向用户确认，不得跳过确认直接执行。",
  );
  return lines.join("\n");
}

// ============================================================================
// 待确认挂起槽位（PendingConfirmationManager）与用户回复分类器
// ============================================================================

export type PendingConfirmationOrigin =
  | "new_implicit"
  | "learning_second_ask"
  | "dormancy_reconfirm"
  | "safety_required"
  | "device_disambiguation"
  | "tool_proposal";

export interface PendingConfirmation {
  id: string;
  origin: PendingConfirmationOrigin;
  canonicalKey: string;
  originalUtterance: string;
  questionText: string;
  summary: string;
  binding: MemoryActionBinding;
  /** 当存在多台候选设备时保存完整候选表，便于用户回答“方寸别院那台”直接消歧 */
  candidateBindings?: MemoryActionBinding[];
  riskLevel: RiskLevel;
  topologyHash: string;
  conflictDomains: string[];
  existingMemoryId?: string;
  singleConfirmRecovery?: boolean;
  speakerScope: string;
  createdAt: number;
  expiresAt: number;
  /** 提问 TTS 播放完毕时间（用于 450ms 反回声不应期护栏） */
  promptEndedAt: number | null;
  consumed: boolean;
}

export interface PendingConfirmationGateContext {
  id: string;
  questionText: string;
  summary: string;
  originalUtterance: string;
  createdAt: number;
  expiresAt: number;
  promptEndedAt: number | null;
}

export type ConfirmationReplyKind =
  | "affirm"
  | "reject_once"
  | "reject_mapping"
  | "modify"
  | "select_candidate"
  | "echo_suspected"
  | "unrelated_new_command";

export interface ConfirmationReplyClassification {
  kind: ConfirmationReplyKind;
  reason: string;
  selectedCandidateIndex?: number;
  modificationText?: string;
}

const AFFIRM_EXACT_RE =
  /^(?:嗯+|嗯嗯|嗯哼|对|对的|对呀|对啊|是的|是|好|好的|好呀|好啊|好嘞|好哒|可以|可以的|行|行的|行吧|要|要的|用|用吧|用那个|用它|就是它|没错|没问题|确认|确定|同意|开始吧?|开吧|洗吧|启动吧?|就用这个|就这样|就按这个来|ok|okay|yes|yep|sure)$/i;

const AFFIRM_PREFIX_RE =
  /^(?:嗯+|对|是的?|好的?|可以|行|没错|确认|确定|就用|用这个)[，,。\s!！]*(?:帮我)?(?:开|洗|启动|执行|来吧|吧|开始|弄|用.*筒)?$/;

const REJECT_MAPPING_RE =
  /(?:不是这个|不是这台|不是那个|别用.*筒|不要用.*筒|不是让你|我不是要|别记住|不要记住|记错了|理解错了|弄错了)/;

const REJECT_ONCE_RE =
  /^(?:不用|不用了|算了|取消|不|不要|别|别开了|别洗了|别启动|不洗了|先不用|先算了|暂不|暂停|停止|不行|不可以|no|nope|cancel|stop)$/i;

const MODIFY_HINT_RE =
  /(?:换成|改成|换个|改用|不用.+用|别用.+用|改一下|换一下|调成|下筒|左筒|右筒|上筒|主筒|快洗|智洗烘|混合洗|棉麻|轻柔|烘干|不烘干|度|分钟)/;

function extractCjkBigrams(text: string): Set<string> {
  const clean = text.replace(/[^\u4e00-\u9fffa-z0-9]/gi, "").toLowerCase();
  const grams = new Set<string>();
  if (clean.length <= 2) {
    if (clean) grams.add(clean);
    return grams;
  }
  for (let i = 0; i < clean.length - 1; i += 1) {
    grams.add(clean.slice(i, i + 2));
  }
  return grams;
}

function computePromptOverlap(reply: string, question: string): number {
  const rGrams = extractCjkBigrams(reply);
  const qGrams = extractCjkBigrams(question);
  if (rGrams.size === 0 || qGrams.size === 0) return 0;
  let hits = 0;
  for (const g of rGrams) {
    if (qGrams.has(g)) hits += 1;
  }
  return hits / rGrams.size;
}

/**
 * 分类用户对 PendingConfirmation 的回复：
 * - 优先检测疑似 TTS 回声自确认（与提问文本高度重合且不含独立肯定词）；
 * - 支持多设备消歧回复（如“用方寸别院那台” / “第一个”）；
 * - 区分明确肯定（affirm）、单次取消（reject_once）、映射否决（reject_mapping）、目标修改（modify）与全新无关指令（unrelated_new_command）。
 */
export function classifyConfirmationReply(
  replyText: string,
  pending: PendingConfirmation,
  opts?: { source?: "voice" | "web" | "api" },
): ConfirmationReplyClassification {
  const raw = String(replyText ?? "").trim();
  const clean = raw
    .replace(/^[，,。！？!?\s]+/, "")
    .replace(/[，,。！？!?\s]+$/, "")
    .trim();

  if (!clean) {
    return { kind: "unrelated_new_command", reason: "empty_reply" };
  }

  // 1. 语音渠道反回声自确认检测：回复文本与确认问题高度重合且并非简短肯定
  if (opts?.source === "voice" && !AFFIRM_EXACT_RE.test(clean) && !REJECT_ONCE_RE.test(clean)) {
    const overlap = computePromptOverlap(clean, pending.questionText);
    const hasExplicitConfirmWord = /^(?:嗯+|对|是的?|好的?|可以|行|确认|确定|同意)/.test(clean);
    if (clean.length >= 4 && overlap >= 0.35 && !hasExplicitConfirmWord) {
      return {
        kind: "echo_suspected",
        reason: `voice_reply_overlaps_prompt(${(overlap * 100).toFixed(0)}%)`,
      };
    }
  }

  // 2. 多候选设备消歧（如“方寸别院那台”、“红泥的家”、“第一台”）
  if (pending.candidateBindings && pending.candidateBindings.length > 1) {
    const ordinalMatch = /(?:第([一二三123])|([123])号)/.exec(clean);
    if (ordinalMatch) {
      const token = ordinalMatch[1] ?? ordinalMatch[2] ?? "";
      const map: Record<string, number> = { 一: 0, "1": 0, 二: 1, "2": 1, 三: 2, "3": 2 };
      const idx = map[token];
      if (idx !== undefined && idx < pending.candidateBindings.length) {
        return {
          kind: "select_candidate",
          reason: `ordinal_selection_${idx + 1}`,
          selectedCandidateIndex: idx,
        };
      }
    }
    for (let i = 0; i < pending.candidateBindings.length; i += 1) {
      const cand = pending.candidateBindings[i]!;
      const tokens = [cand.homeName, cand.roomName, cand.deviceName, cand.drumLabel]
        .filter((t): t is string => Boolean(t && t.trim()))
        .map((t) => t.trim());
      if (tokens.some((tok) => tok.length >= 2 && clean.includes(tok))) {
        // 避免只命中共有设备名（如两台都叫“美的可爱多”）而无法区分
        const matchedCount = pending.candidateBindings.filter((other) => {
          const otherTokens = [other.homeName, other.roomName, other.deviceName, other.drumLabel]
            .filter((t): t is string => Boolean(t && t.trim()));
          return otherTokens.some((tok) => tok.length >= 2 && clean.includes(tok));
        }).length;
        if (matchedCount === 1) {
          return {
            kind: "select_candidate",
            reason: `matched_unique_candidate_${i}`,
            selectedCandidateIndex: i,
          };
        }
      }
    }
  }

  // 3. 明确修改目标/参数（如“不用袜子筒，用下筒智洗烘” / “嗯，改用右筒”）
  if (MODIFY_HINT_RE.test(clean) && !AFFIRM_EXACT_RE.test(clean)) {
    // 若只是重复原提问中的目标并加了确认词（如“对，用袜子筒”），仍属于 affirm
    const mentionsCurrentDrum =
      pending.binding.drumLabel &&
      clean.includes(pending.binding.drumLabel.replace(/·.*/, "")) &&
      /^(?:嗯|对|是|好|可以|行|用|就用)/.test(clean) &&
      !/(?:不用|别用|换成|改成|换个|改用)/.test(clean);
    if (!mentionsCurrentDrum) {
      return {
        kind: "modify",
        reason: "user_modified_target_or_params",
        modificationText: clean,
      };
    }
  }

  // 4. 明确否决映射 vs 单次取消
  if (REJECT_MAPPING_RE.test(clean)) {
    return { kind: "reject_mapping", reason: "explicit_mapping_rejection" };
  }
  if (REJECT_ONCE_RE.test(clean)) {
    return { kind: "reject_once", reason: "one_time_cancel" };
  }

  // 5. 明确肯定确认
  if (AFFIRM_EXACT_RE.test(clean) || AFFIRM_PREFIX_RE.test(clean)) {
    return { kind: "affirm", reason: "explicit_affirmation" };
  }

  // 6. 语音再次复述完全相同的原指令且带“确认/直接/快”等意图
  const replyIntent = canonicalizeImplicitIntent(clean);
  if (replyIntent.canonicalKey === pending.canonicalKey && /(?:确认|快|直接|对|嗯|好)/.test(clean)) {
    return { kind: "affirm", reason: "restated_with_confirmation" };
  }

  return { kind: "unrelated_new_command", reason: "new_intent_replaces_pending" };
}

/**
 * 内存级待确认槽位管理器（单槽位原子 CAS，默认 90s TTL，防重复消费）。
 */
export class PendingConfirmationManager {
  private active: PendingConfirmation | null = null;
  private readonly now: () => number;
  private readonly defaultTtlMs: number;

  constructor(opts?: { now?: () => number; defaultTtlMs?: number }) {
    this.now = opts?.now ?? (() => getReinforcementNow());
    this.defaultTtlMs = opts?.defaultTtlMs ?? 90_000;
  }

  open(
    input: Omit<PendingConfirmation, "id" | "createdAt" | "expiresAt" | "promptEndedAt" | "consumed"> & {
      ttlMs?: number;
    },
  ): PendingConfirmation {
    const nowMs = this.now();
    const id = `pc_${nowMs.toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const pending: PendingConfirmation = {
      ...input,
      id,
      createdAt: nowMs,
      expiresAt: nowMs + (input.ttlMs ?? this.defaultTtlMs),
      promptEndedAt: null,
      consumed: false,
    };
    this.active = pending;
    return pending;
  }

  getActive(): PendingConfirmation | null {
    if (!this.active) return null;
    if (this.active.consumed || this.now() > this.active.expiresAt) {
      this.active = null;
      return null;
    }
    return this.active;
  }

  getGateContext(): PendingConfirmationGateContext | null {
    const cur = this.getActive();
    if (!cur) return null;
    return {
      id: cur.id,
      questionText: cur.questionText,
      summary: cur.summary,
      originalUtterance: cur.originalUtterance,
      createdAt: cur.createdAt,
      expiresAt: cur.expiresAt,
      promptEndedAt: cur.promptEndedAt,
    };
  }

  markPromptTtsEnded(id?: string): void {
    if (!this.active) return;
    if (id && this.active.id !== id) return;
    this.active.promptEndedAt = this.now();
  }

  /** 原子 CAS 消费当前待确认项，防止双击/并发语音回声重复执行 */
  consume(id?: string): PendingConfirmation | null {
    const cur = this.getActive();
    if (!cur) return null;
    if (id && cur.id !== id) return null;
    cur.consumed = true;
    this.active = null;
    return cur;
  }

  clear(id?: string): void {
    if (!this.active) return;
    if (id && this.active.id !== id) return;
    this.active.consumed = true;
    this.active = null;
  }
}

export function buildAutoDecisionSummary(
  intent: CanonicalIntent,
  binding: MemoryActionBinding,
): string {
  const loc = [binding.homeName, binding.roomName].filter(Boolean).join("/");
  const devLabel = loc ? `${loc}「${binding.deviceName}」` : `「${binding.deviceName}」`;
  const drumPart = binding.drumLabel ? `的${binding.drumLabel}` : "";
  const progPart = binding.programLabel
    ? `（${binding.programLabel}）`
    : binding.program
      ? `（${binding.program}）`
      : "";
  return `说「${intent.normalizedPhrase}」→ 启动${devLabel}${drumPart}${progPart}`;
}
