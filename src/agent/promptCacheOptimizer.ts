// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * Pi Agent Prompt KV-Cache 优化工具集：
 *
 * 1. 动静分离（Static System Prompt vs Per-Turn `<runtime_context>`）：
 *    将每分钟变动的本地时间、每轮变动的语音/声纹/意图元数据，以及每次控制和轮询都会变化的
 *    设备在线/电源/传感器读数，从 `messages[0]`（System Prompt）剥离到新追加的 User Message 尾部，
 *    确保 `tools` + `messages[0]` + 已提交历史消息前缀在连续任务与多步工具调用间 100% 字节稳定。
 * 2. 实时设备状态基准快照 + 增量 Delta 追踪：
 *    首轮（或重置/压缩后首轮）注入紧凑基准快照，后续连续任务仅发送发生变化的设备状态增量，
 *    同时降低单轮输入 Token 消耗并维持 100% 状态可见性。
 * 3. 缓存友好型高水位分批历史压缩（Watermark Batch Compaction）：
 *    替代每轮滑动窗口 `slice(-maxMsgs)`（后者在历史达上限后每轮前移起点，导致历史缓存命中率归零）；
 *    仅在任务边界且超过高水位时一次性按 `user` 轮次边界裁剪最旧批次，两次压缩之间保持严格 append-only。
 * 4. Prompt Cache 命中率实时遥测（`AgentUsageSummary` / `AgentPromptCacheStats`）。
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import type { DeviceInfo } from "../core/models.ts";
import { SILENT_REPLY_SENTINEL } from "./cavemanReplyPolicy.ts";

export const RUNTIME_CONTEXT_OPEN_TAG = "<runtime_context>";
export const RUNTIME_CONTEXT_CLOSE_TAG = "</runtime_context>";

export interface DeviceLiveStateEntry {
  did: string;
  name: string;
  online: boolean;
  power: "on" | "off" | null;
  metric: string;
  signature: string;
}

export interface TurnRuntimeVoiceMeta {
  speakerName?: string | null;
  speakerRole?: "owner" | "member" | null;
  intent?: string;
}

export interface BuildRuntimeContextInput {
  localTimeLine: string;
  source: "text" | "voice";
  voiceMeta?: TurnRuntimeVoiceMeta | null;
  currentHome?: string;
  currentStates: ReadonlyMap<string, DeviceLiveStateEntry>;
  previousStates: ReadonlyMap<string, DeviceLiveStateEntry> | null;
  /** 可选附加动态上下文段（如强化记忆实时门控状态、当前挂起的待确认提问等），仅注入尾部 User Message 不破坏前缀缓存 */
  extraSections?: readonly string[];
}

export interface AgentUsageSummary {
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalPromptTokens: number;
  /** Prompt 缓存命中率（0..1）：cacheReadTokens / (inputTokens + cacheReadTokens + cacheWriteTokens) */
  cacheHitRate: number;
}

export interface AgentPromptCacheStats extends AgentUsageSummary {
  sessionId: string;
  systemPromptRefreshes: number;
  historyCompactions: number;
  lastCallCacheHitRate: number | null;
}

/**
 * 剥离注入在 User Message 头部的 `<runtime_context>...</runtime_context>` 运行态块，
 * 还原纯净用户自然语言指令（供本地确定性规划器与历史意图提取复用）。
 */
export function stripRuntimeContextBlock(raw: string): string {
  if (!raw) return "";
  const openIdx = raw.indexOf(RUNTIME_CONTEXT_OPEN_TAG);
  if (openIdx === -1) return raw;
  const closeIdx = raw.indexOf(
    RUNTIME_CONTEXT_CLOSE_TAG,
    openIdx + RUNTIME_CONTEXT_OPEN_TAG.length,
  );
  if (closeIdx === -1) return raw;
  const before = raw.slice(0, openIdx).trim();
  const after = raw.slice(closeIdx + RUNTIME_CONTEXT_CLOSE_TAG.length).trim();
  if (!before) return after;
  if (!after) return before;
  return `${before}\n${after}`;
}

/**
 * 将当轮动态运行态上下文与用户自然语言指令封装为新追加的 User Message 文本。
 */
export function formatTurnUserPrompt(rawText: string, runtimeContext: string): string {
  const cleanCtx = runtimeContext.trim();
  if (!cleanCtx) return rawText;
  return `${RUNTIME_CONTEXT_OPEN_TAG}\n${cleanCtx}\n${RUNTIME_CONTEXT_CLOSE_TAG}\n${rawText}`;
}

/**
 * 确定性排序设备列表（按 did 字典序），避免多平台异步刷新顺序抖动破坏 System Prompt 静态台账前缀缓存。
 */
export function sortDevicesForStableCatalog(devices: readonly DeviceInfo[]): DeviceInfo[] {
  return [...devices].sort((a, b) => (a.did < b.did ? -1 : a.did > b.did ? 1 : 0));
}

/**
 * 采集设备目录的实时易变状态快照（online / power / metric），用于与上轮快照做增量 Diff。
 */
export function snapshotDeviceLiveStates(
  devices: readonly DeviceInfo[],
  knownPower: Readonly<Record<string, boolean | null>>,
  metrics: Readonly<Record<string, string | null>>,
  catalogLimit = 80,
): Map<string, DeviceLiveStateEntry> {
  const map = new Map<string, DeviceLiveStateEntry>();
  const ordered = sortDevicesForStableCatalog(devices).slice(0, catalogLimit);
  for (const d of ordered) {
    const pwRaw = knownPower[d.did];
    const power: "on" | "off" | null = typeof pwRaw === "boolean" ? (pwRaw ? "on" : "off") : null;
    const metric = (metrics[d.did] ?? "").trim();
    const online = Boolean(d.online);
    const signature = `${online ? "1" : "0"}|${power ?? ""}|${metric}`;
    map.set(d.did, {
      did: d.did,
      name: d.name,
      online,
      power,
      metric,
      signature,
    });
  }
  return map;
}

function formatStateFields(entry: DeviceLiveStateEntry, includeOnlineWhenTrue: boolean): string {
  const parts: string[] = [];
  if (!entry.online) {
    parts.push("离线");
  } else if (includeOnlineWhenTrue) {
    parts.push("在线");
  }
  if (entry.power === "on") {
    parts.push("电源:开");
  } else if (entry.power === "off") {
    parts.push("电源:关");
  }
  if (entry.metric) {
    parts.push(entry.metric);
  }
  return parts.join("，");
}

/**
 * 构建每轮动态 `<runtime_context>` 正文：
 * - 当前本地时间（精确到分钟，在 User 尾部注入，零前缀缓存破坏）
 * - 当前输入渠道、声纹身份与意图提示（Voice / Speaker / Intent hint）
 * - 实时设备状态（首次或压缩后输出紧凑基准快照，后续连续轮次仅输出增量变化）
 */
export function buildRuntimeContextBlock(input: BuildRuntimeContextInput): string {
  const lines: string[] = [];

  if (input.localTimeLine.trim()) {
    lines.push(input.localTimeLine.trim());
  }

  const vm = input.voiceMeta ?? null;
  const intentPart = vm?.intent ? ` Intent hint: ${vm.intent}.` : "";
  if (input.source === "voice") {
    const speakerName = vm?.speakerName?.trim() ?? "";
    const speakerPart = speakerName
      ? ` Speaker: ${speakerName}${vm?.speakerRole === "owner" ? " (owner)" : ""}.`
      : "";
    lines.push(
      `Voice: Plain speech only—no Markdown, emoji, or bullets.${speakerPart}${intentPart} If pure ambient side-talk not addressed to you, call no tools and output only ${SILENT_REPLY_SENTINEL}.`,
    );
  } else {
    lines.push(`Channel: text.${intentPart}`);
  }

  const trimmedHome = (input.currentHome ?? "").trim();
  if (trimmedHome && trimmedHome !== "全部") {
    lines.push(`当前界面筛选家庭：${trimmedHome}`);
  }

  const { currentStates, previousStates } = input;
  if (previousStates === null) {
    // 基准快照（首轮 / reset 后 / 历史分批压缩后）
    if (currentStates.size > 0) {
      const offlineList: string[] = [];
      const statefulLines: string[] = [];
      for (const entry of currentStates.values()) {
        if (!entry.online) {
          offlineList.push(`${entry.name}(${entry.did})`);
        }
        const detail = formatStateFields(entry, false);
        if (detail && (entry.power !== null || entry.metric.length > 0)) {
          statefulLines.push(`- ${entry.name}(${entry.did}): ${detail}`);
        }
      }
      if (offlineList.length > 0) {
        lines.push(`离线设备（其余 ${currentStates.size - offlineList.length} 台在线）：${offlineList.join("、")}`);
      } else {
        lines.push(`在线状态：清单内 ${currentStates.size} 台设备均在线`);
      }
      if (statefulLines.length > 0) {
        lines.push("实时设备状态（基准快照）：");
        lines.push(...statefulLines);
      }
    }
  } else {
    // 连续任务增量 Diff：仅发送状态变化的设备，未列出的设备沿用前文最新状态
    const changedLines: string[] = [];
    for (const [did, entry] of currentStates.entries()) {
      const prev = previousStates.get(did);
      if (!prev || prev.signature !== entry.signature) {
        const desc = formatStateFields(entry, true) || "在线";
        changedLines.push(`- ${entry.name}(${did}): ${desc}`);
      }
    }
    for (const [did, prev] of previousStates.entries()) {
      if (!currentStates.has(did)) {
        changedLines.push(`- ${prev.name}(${did}): 已从当前清单移除`);
      }
    }
    if (changedLines.length > 0) {
      lines.push("实时设备状态更新（未列出设备状态与前文一致）：");
      lines.push(...changedLines);
    } else if (currentStates.size > 0) {
      lines.push("实时设备状态：较上轮无变化");
    }
  }

  if (input.extraSections && input.extraSections.length > 0) {
    for (const sec of input.extraSections) {
      const trimmed = sec.trim();
      if (trimmed) {
        lines.push("", trimmed);
      }
    }
  }

  return lines.join("\n");
}

export interface HistoryCompactionResult {
  messages: AgentMessage[];
  compacted: boolean;
  droppedCount: number;
}

export function resolveHistoryWatermarks(maxHistoryTurns: number): {
  softLimit: number;
  highWatermark: number;
  targetRetained: number;
  emergencyLimit: number;
} {
  const turns = Math.max(2, Math.trunc(Number.isFinite(maxHistoryTurns) ? maxHistoryTurns : 12));
  const softLimit = Math.max(8, turns * 4);
  const highWatermark = softLimit + Math.max(8, Math.floor(softLimit * 0.25));
  const targetRetained = Math.max(4, Math.floor(softLimit * 0.6));
  const emergencyLimit = highWatermark * 2;
  return { softLimit, highWatermark, targetRetained, emergencyLimit };
}

function alignCutIndexToUserTurn(
  body: readonly AgentMessage[],
  desiredIdx: number,
  minIdx: number,
): number {
  const clampedDesired = Math.max(0, Math.min(desiredIdx, body.length));
  // 优先向后找最近的完整 user 轮次起点（保证压缩后首条非系统消息为 user，不留孤立 toolResult 或 assistant）
  for (let i = clampedDesired; i < body.length; i += 1) {
    if (body[i]!.role === "user") {
      return i;
    }
  }
  // 若尾部无 user（例如极长单轮工具循环），在安全下界内向前找最近 user
  const floor = Math.max(0, minIdx);
  for (let i = clampedDesired - 1; i >= floor; i -= 1) {
    if (body[i]!.role === "user") {
      return i;
    }
  }
  // 兜底：至少跳过孤立 toolResult
  let fallback = clampedDesired;
  while (fallback < body.length && body[fallback]!.role === "toolResult") {
    fallback += 1;
  }
  return fallback;
}

/**
 * 缓存友好型高水位分批历史压缩：
 * - 仅在非系统消息数超过 `highWatermark` 时触发（在任务边界调用，绝不在单任务工具循环中段触发）；
 * - 触发时一次性裁剪最旧批次至约 `60% * softLimit` 并严格对齐到 `user` 消息边界；
 * - 两次压缩之间历史严格 append-only，避免传统滑动窗口每轮前移导致的 0% 历史缓存命中。
 */
export function computeCacheFriendlyCompaction(
  messages: readonly AgentMessage[],
  maxHistoryTurns: number,
): HistoryCompactionResult {
  if (messages.length <= 1) {
    return { messages: [...messages], compacted: false, droppedCount: 0 };
  }
  const hasLeadingSystem = messages[0]!.role === "system";
  const head = hasLeadingSystem ? [messages[0]!] : [];
  const body = hasLeadingSystem ? messages.slice(1) : messages.slice();
  const { softLimit, highWatermark, targetRetained } = resolveHistoryWatermarks(maxHistoryTurns);

  if (body.length <= highWatermark) {
    return { messages: [...messages], compacted: false, droppedCount: 0 };
  }

  const desiredIdx = Math.max(0, body.length - targetRetained);
  const minIdx = Math.max(0, body.length - softLimit);
  const cutIdx = alignCutIndexToUserTurn(body, desiredIdx, minIdx);
  if (cutIdx <= 0 || cutIdx >= body.length) {
    return { messages: [...messages], compacted: false, droppedCount: 0 };
  }

  return {
    messages: [...head, ...body.slice(cutIdx)],
    compacted: true,
    droppedCount: cutIdx,
  };
}

/**
 * `prepareRequest` 极端安全兜底裁剪：仅在单次任务内异常产生超长工具循环超过 `emergencyLimit` 时触发，
 * 常规连续任务由任务边界的 `computeCacheFriendlyCompaction` 接管，保证请求前缀零抖动。
 */
export function computeEmergencyTrim(
  messages: readonly AgentMessage[],
  maxHistoryTurns: number,
): AgentMessage[] {
  if (messages.length <= 1) {
    return [...messages];
  }
  const hasLeadingSystem = messages[0]!.role === "system";
  const head = hasLeadingSystem ? [messages[0]!] : [];
  const body = hasLeadingSystem ? messages.slice(1) : messages.slice();
  const { highWatermark, emergencyLimit } = resolveHistoryWatermarks(maxHistoryTurns);
  if (body.length <= emergencyLimit) {
    return [...messages];
  }
  const desiredIdx = Math.max(0, body.length - highWatermark);
  const cutIdx = alignCutIndexToUserTurn(body, desiredIdx, Math.max(0, body.length - emergencyLimit));
  if (cutIdx <= 0 || cutIdx >= body.length) {
    return [...messages];
  }
  return [...head, ...body.slice(cutIdx)];
}

export function computeCacheHitRate(cacheReadTokens: number, totalPromptTokens: number): number {
  if (totalPromptTokens <= 0 || cacheReadTokens <= 0) {
    return 0;
  }
  const rate = cacheReadTokens / totalPromptTokens;
  return Number(Math.max(0, Math.min(1, rate)).toFixed(4));
}

export function createEmptyUsageSummary(): AgentUsageSummary {
  return {
    llmCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalPromptTokens: 0,
    cacheHitRate: 0,
  };
}

/**
 * 将单次 LLM 返回的 `usage` 累加到统计摘要中；返回本次调用的单次缓存命中率（若无有效 prompt token 则返回 null）。
 */
export function recordUsageIntoSummary(
  summary: AgentUsageSummary,
  usage: Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite"> | null | undefined,
): number | null {
  if (!usage) return null;
  const input = Math.max(0, Math.trunc(Number(usage.input) || 0));
  const output = Math.max(0, Math.trunc(Number(usage.output) || 0));
  const cacheRead = Math.max(0, Math.trunc(Number(usage.cacheRead) || 0));
  const cacheWrite = Math.max(0, Math.trunc(Number(usage.cacheWrite) || 0));
  const callPromptTokens = input + cacheRead + cacheWrite;
  if (callPromptTokens === 0 && output === 0) {
    return null;
  }
  summary.llmCalls += 1;
  summary.inputTokens += input;
  summary.outputTokens += output;
  summary.cacheReadTokens += cacheRead;
  summary.cacheWriteTokens += cacheWrite;
  summary.totalPromptTokens += callPromptTokens;
  summary.cacheHitRate = computeCacheHitRate(summary.cacheReadTokens, summary.totalPromptTokens);
  return callPromptTokens > 0 ? computeCacheHitRate(cacheRead, callPromptTokens) : null;
}
