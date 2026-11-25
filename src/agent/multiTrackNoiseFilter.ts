// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * 多轨语音分离场景下的背景音/旁白/噪音/电视音轨识别与对话级屏蔽管理器。
 *
 * 规则：
 * 1. 仅在存在多轨（trackCount > 1）时启用；单轨场景永不屏蔽唯一音轨；
 * 2. 当多轨转换出来的有效文字累计或单次超出 20 个字（> 20，剔除空白与标点符号）后，
 *    调用 SystemOne 单次批量判别每一条待评估音轨是否属于背景音、旁白、噪音或电视；
 * 3. 被判为背景音/旁白/噪音/电视的音轨在**当前对话内**立即屏蔽：
 *    - 后续流式切片与后续话语直接跳过该音轨的语音转文字（ASR）与一切下游触发；
 *    - 当前批次亦直接阻断其注意力门控与 Pi Agent 执行；
 * 4. 当前对话结束（退出对话/超时回待机/停止监听/清空历史）时自动解除全部音轨屏蔽。
 */

import type {
  MultiTrackNoiseTrackInput,
  SystemOneClient,
  SystemOneHistoryEntry,
  TrackNoiseClassChoice,
} from "./systemOneClient.ts";

export const MULTITRACK_NOISE_CHECK_MIN_CHARS = 20;
const MAX_ACCUMULATED_TRACK_CHARS = 240;
const RECHECK_GROWTH_CHARS = 20;
const MAX_CHECKS_PER_TRACK = 3;

export interface TrackIdentityRef {
  trackId?: string;
  trackIndex: number;
  sourceSlot?: number;
}

export interface MutedTrackRecord {
  trackKey: string;
  trackId: string;
  trackIndex: number;
  sourceSlot?: number;
  choice: TrackNoiseClassChoice;
  confidence: number;
  reason: string;
  sampleText: string;
  mutedAt: number;
}

export interface TrackTranscriptCandidate extends TrackIdentityRef {
  trackId: string;
  text: string;
  speakerName?: string | null;
  acousticEvent?: string;
}

export interface EvaluateMultiTrackNoiseOptions {
  /** 当前批次总分离音轨数（必须 > 1 才会执行多轨屏蔽评估） */
  totalTracksInBatch: number;
  /** preview: 同一话语流式增量预览（覆盖当句草稿）；final: 话语收尾正式转写（提交并累积） */
  mode: "preview" | "final";
  systemOneClient: SystemOneClient | null | undefined;
  wakeWords?: readonly string[];
  recentHistory?: ReadonlyArray<SystemOneHistoryEntry>;
  minChars?: number;
  minConfidence?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  now?: number;
  /** 可选对话轮次守卫：异步 SystemOne 返回前若轮次已变化（已退出原对话），放弃落盘陈旧屏蔽 */
  isStale?: () => boolean;
}

export interface EvaluateMultiTrackNoiseOutcome {
  evaluated: boolean;
  totalEffectiveChars: number;
  newlyMuted: MutedTrackRecord[];
  latencyMs: number;
  model?: string;
}

interface TrackAccumulationState {
  trackKey: string;
  trackId: string;
  trackIndex: number;
  sourceSlot?: number;
  committedText: string;
  currentUtteranceText: string;
  lastEvaluatedChars: number;
  lastEvaluatedText: string;
  checkCount: number;
}

/**
 * 统计转写文本中的有效字数（去除空白、标点与符号），用于判断“超出 20 个字”。
 */
export function countTrackTranscriptChars(text: string): number {
  if (!text) return 0;
  return text.replace(/[\s\p{P}\p{S}]+/gu, "").length;
}

/**
 * 生成多轨屏蔽追踪键：
 * 优先使用盲源分离 PIT 对齐后的 `sourceSlot`，无槽位信息时退化为 `trackId` / `trackIndex`。
 */
export function resolveTrackMuteKey(track: TrackIdentityRef): string {
  if (
    typeof track.sourceSlot === "number" &&
    Number.isInteger(track.sourceSlot) &&
    track.sourceSlot >= 0
  ) {
    return `slot:${track.sourceSlot}`;
  }
  const cleanId = track.trackId?.trim();
  if (cleanId) {
    return `id:${cleanId}`;
  }
  return `idx:${track.trackIndex}`;
}

function collapseText(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

function appendBounded(base: string, addition: string, maxLen = MAX_ACCUMULATED_TRACK_CHARS): string {
  const cleanBase = collapseText(base);
  const cleanAdd = collapseText(addition);
  if (!cleanAdd) return cleanBase;
  if (!cleanBase) {
    return cleanAdd.length > maxLen ? cleanAdd.slice(-maxLen) : cleanAdd;
  }
  const joined = `${cleanBase} ${cleanAdd}`;
  return joined.length > maxLen ? joined.slice(-maxLen) : joined;
}

function composeEffectiveText(state: TrackAccumulationState): string {
  return appendBounded(state.committedText, state.currentUtteranceText);
}

/**
 * 当前对话级多轨噪音/电视音轨屏蔽状态管理器。
 */
export class ConversationTrackMuteManager {
  private readonly _muted = new Map<string, MutedTrackRecord>();
  private readonly _accumulated = new Map<string, TrackAccumulationState>();
  private _generation = 0;

  get mutedCount(): number {
    return this._muted.size;
  }

  getMutedTracks(): MutedTrackRecord[] {
    return Array.from(this._muted.values()).map((rec) => ({ ...rec }));
  }

  /**
   * 查询某音轨在当前对话中是否已被屏蔽。
   * 严格要求 `totalTracksInBatch > 1`（存在多轨），避免单轨场景误屏蔽唯一真实用户音轨。
   */
  getMutedRecord(
    track: TrackIdentityRef,
    totalTracksInBatch: number,
  ): MutedTrackRecord | null {
    if (totalTracksInBatch <= 1 || this._muted.size === 0) {
      return null;
    }
    const key = resolveTrackMuteKey(track);
    const direct = this._muted.get(key);
    if (direct) return direct;

    const cleanId = track.trackId?.trim();
    for (const rec of this._muted.values()) {
      if (typeof track.sourceSlot === "number" && typeof rec.sourceSlot === "number") {
        // 双方均带有 PIT 对齐槽位号时严格按槽位匹配，避免跨槽位误伤
        continue;
      }
      if (cleanId && rec.trackId === cleanId) return rec;
      if (rec.trackIndex === track.trackIndex) return rec;
    }
    return null;
  }

  isTrackMuted(track: TrackIdentityRef, totalTracksInBatch: number): boolean {
    return this.getMutedRecord(track, totalTracksInBatch) !== null;
  }

  /**
   * 将当前流式预览草稿提交为已完成话语（供独立 VoiceStreamSession 在不经由控制器时收尾）。
   */
  commitActiveUtterance(): void {
    for (const st of this._accumulated.values()) {
      if (st.currentUtteranceText) {
        st.committedText = appendBounded(st.committedText, st.currentUtteranceText);
        st.currentUtteranceText = "";
      }
    }
  }

  /**
   * 退出当前对话时清空所有音轨屏蔽与文字累积状态。
   */
  reset(): void {
    this._generation += 1;
    this._muted.clear();
    this._accumulated.clear();
  }

  /**
   * 记录多轨转写文本；若存在多轨且有效文字超出 20 字，调用 SystemOne 判别每条音轨是否为背景音/旁白/噪音/电视，
   * 命中者立即在当前对话中屏蔽。
   */
  async evaluateTracks(
    candidates: ReadonlyArray<TrackTranscriptCandidate>,
    options: EvaluateMultiTrackNoiseOptions,
  ): Promise<EvaluateMultiTrackNoiseOutcome> {
    const minChars = options.minChars ?? MULTITRACK_NOISE_CHECK_MIN_CHARS;
    if (options.totalTracksInBatch <= 1 || candidates.length === 0) {
      return {
        evaluated: false,
        totalEffectiveChars: 0,
        newlyMuted: [],
        latencyMs: 0,
      };
    }

    const genAtStart = this._generation;
    const activeEntries: Array<{
      candidate: TrackTranscriptCandidate;
      state: TrackAccumulationState;
      effectiveText: string;
      effectiveChars: number;
    }> = [];

    for (const cand of candidates) {
      if (this.isTrackMuted(cand, options.totalTracksInBatch)) {
        continue;
      }
      const cleanText = collapseText(cand.text);
      if (!cleanText) continue;

      const key = resolveTrackMuteKey(cand);
      let state = this._accumulated.get(key);
      if (!state) {
        state = {
          trackKey: key,
          trackId: cand.trackId,
          trackIndex: cand.trackIndex,
          ...(typeof cand.sourceSlot === "number" ? { sourceSlot: cand.sourceSlot } : {}),
          committedText: "",
          currentUtteranceText: "",
          lastEvaluatedChars: 0,
          lastEvaluatedText: "",
          checkCount: 0,
        };
        this._accumulated.set(key, state);
      } else {
        state.trackId = cand.trackId;
        state.trackIndex = cand.trackIndex;
        if (typeof cand.sourceSlot === "number") {
          state.sourceSlot = cand.sourceSlot;
        }
      }

      if (options.mode === "preview") {
        state.currentUtteranceText = cleanText;
      } else {
        // 正式话语收尾：用最终转写替换同句预览草稿并并入对话累计，绝不重复叠加预览与终稿
        state.committedText = appendBounded(state.committedText, cleanText);
        state.currentUtteranceText = "";
      }

      const effectiveText = composeEffectiveText(state);
      const effectiveChars = countTrackTranscriptChars(effectiveText);
      if (effectiveChars <= 0) continue;

      activeEntries.push({
        candidate: cand,
        state,
        effectiveText,
        effectiveChars,
      });
    }

    const totalEffectiveChars = activeEntries.reduce((acc, item) => acc + item.effectiveChars, 0);
    if (totalEffectiveChars <= minChars) {
      return {
        evaluated: false,
        totalEffectiveChars,
        newlyMuted: [],
        latencyMs: 0,
      };
    }

    const client = options.systemOneClient;
    if (!client || !client.enabled) {
      return {
        evaluated: false,
        totalEffectiveChars,
        newlyMuted: [],
        latencyMs: 0,
      };
    }

    const dueKeys = new Set<string>();
    for (const item of activeEntries) {
      const st = item.state;
      if (item.effectiveText === st.lastEvaluatedText && st.lastEvaluatedChars > 0) {
        continue;
      }
      const neverChecked = st.lastEvaluatedChars === 0;
      const crossedIndividualThreshold =
        st.lastEvaluatedChars <= minChars && item.effectiveChars > minChars;
      const grewSignificantly =
        item.effectiveChars >= st.lastEvaluatedChars + RECHECK_GROWTH_CHARS &&
        st.checkCount < MAX_CHECKS_PER_TRACK;
      if (neverChecked || crossedIndividualThreshold || grewSignificantly) {
        dueKeys.add(st.trackKey);
      }
    }

    if (dueKeys.size === 0) {
      return {
        evaluated: false,
        totalEffectiveChars,
        newlyMuted: [],
        latencyMs: 0,
      };
    }

    const reqTracks: MultiTrackNoiseTrackInput[] = activeEntries.map((item) => ({
      trackId: item.candidate.trackId,
      trackIndex: item.candidate.trackIndex,
      text: item.effectiveText,
      speakerName: item.candidate.speakerName ?? null,
      acousticEvent: item.candidate.acousticEvent,
      evaluate: dueKeys.has(item.state.trackKey),
    }));

    const res = await client.classifyMultiTrackNoise(
      {
        tracks: reqTracks,
        wakeWords: options.wakeWords,
        recentHistory: options.recentHistory,
      },
      {
        timeoutMs: options.timeoutMs,
        signal: options.signal,
        minConfidence: options.minConfidence,
      },
    );

    if (!res) {
      return {
        evaluated: false,
        totalEffectiveChars,
        newlyMuted: [],
        latencyMs: 0,
      };
    }

    // 异步返回期间若对话已退出/重置，直接丢弃陈旧判别结果
    if (this._generation !== genAtStart || options.isStale?.()) {
      return {
        evaluated: true,
        totalEffectiveChars,
        newlyMuted: [],
        latencyMs: res.latencyMs,
        model: res.model,
      };
    }

    const entryByTrackId = new Map(activeEntries.map((e) => [e.candidate.trackId, e]));
    const nowMs = options.now ?? Date.now();
    const newlyMuted: MutedTrackRecord[] = [];

    for (const verdict of res.verdicts) {
      const entry =
        entryByTrackId.get(verdict.trackId) ??
        activeEntries.find((e) => e.candidate.trackIndex === verdict.trackIndex);
      if (!entry) continue;

      entry.state.lastEvaluatedChars = entry.effectiveChars;
      entry.state.lastEvaluatedText = entry.effectiveText;
      entry.state.checkCount += 1;

      if (verdict.shouldMute) {
        const pct = Math.round(verdict.confidence * 100);
        const rec: MutedTrackRecord = {
          trackKey: entry.state.trackKey,
          trackId: entry.candidate.trackId,
          trackIndex: entry.candidate.trackIndex,
          ...(typeof entry.candidate.sourceSlot === "number"
            ? { sourceSlot: entry.candidate.sourceSlot }
            : {}),
          choice: verdict.choice,
          confidence: verdict.confidence,
          reason: `SystemOne 判定音轨 ${entry.candidate.trackIndex} 为背景音/旁白/噪音/电视 (${pct}%)，当前对话已屏蔽该音轨`,
          sampleText: entry.effectiveText.slice(0, 120),
          mutedAt: nowMs,
        };
        this._muted.set(rec.trackKey, rec);
        newlyMuted.push(rec);
      }
    }

    return {
      evaluated: true,
      totalEffectiveChars,
      newlyMuted,
      latencyMs: res.latencyMs,
      model: res.model,
    };
  }
}
