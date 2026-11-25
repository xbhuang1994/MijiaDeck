// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * ClearVoice 准实时切片核心管线（动态语义分块 + 历史上下文缓冲 + 交叉淡入淡出）：
 *
 * 完整实现 4 阶段低延迟切片架构（端到端延迟 0.8s ~ 2.0s）：
 * 1. 音频采集与重采样：按 32ms（512 样本 @ 16kHz，或兼容 30ms）固定小帧输入 PCM，
 *    自动重采样至统一单声道采样率；
 * 2. 双触发切片器（Silero VAD + 环形缓冲区）：
 *    - 静音触发（优先）：持续累积音频帧，检测到人声后的静音停顿达到 250ms–300ms（默认 280ms）
 *      立即截断送入 GPU ClearVoice 推理队列，避免切断完整词语；
 *    - 超时强制触发（兜底）：若说话人语速极快不停顿，累积时长达到上限（默认 2.0s）强制切分；
 * 3. 带上下文的滑窗推理（Look-back Context）：
 *    - 每次切片推理前，从环形缓冲区拼接紧邻前 0.3s（300ms）原始音频到当前切片头部，
 *      为 MossFormer2 提供前文语境；
 *    - 推理完成后裁掉前 0.3s 历史缓冲输出，仅保留当前切片对应的新增部分；
 * 4. 边界平滑与输出（Cross-fade / Overlap-Add）：
 *    - 对连续强制切分或紧邻切片的交界处，利用 0.3s 历史窗末端与上一段输出的 20ms 重叠区
 *      执行线性淡入淡出（Overlap-Add），彻底消除拼接“咔哒”声与音量跳变。
 */

import { computeRms, resampleLinear } from "./audioPcm.ts";
import type { StreamingVadHandleLike } from "./localVoiceEngine.ts";

export type ClearVoiceTriggerReason = "silence" | "timeout" | "flush";

export interface ClearVoiceChunkerConfig {
  /** 内部 VAD 与输出采样率（默认 16000Hz，便于直接对接 Silero VAD 与 Qwen3-ASR） */
  sampleRate: number;
  /** 帧大小（ms，默认 32ms = 512 样本 @ 16kHz，对齐 Silero VAD 窗口） */
  frameSizeMs: number;
  /** 降噪切片静音触发阈值（ms，250–300ms，默认 280ms：仅触发增量 GPU 降噪切片，不等同于整句结束） */
  silenceTriggerMs: number;
  /** 整句结束静音判停阈值（ms，默认与 silenceTriggerMs 相同保持单测兼容；流会话按 vadSilenceMs 设为 ~1000–1200ms） */
  utteranceSilenceMs: number;
  /** 长语音耐心加成触发阈值（ms，累计有效人声达到该时长后自动放宽句中停顿容忍，默认 3000ms） */
  longUtteranceThresholdMs: number;
  /** 长语音额外句中停顿容忍时长（ms，仅在 utteranceSilenceMs > silenceTriggerMs 时生效，默认 350ms） */
  longUtteranceExtraSilenceMs: number;
  /** 语义未闭合提示额外等待时长（ms，如停在“然后/把客厅灯”等未说完处，默认 700ms） */
  incompleteGraceMs: number;
  /** 超时强制切分上限（ms，默认 2000ms = 2.0s） */
  maxChunkMs: number;
  /** 历史上下文缓冲时长（ms，默认 300ms = 0.3s） */
  lookbackMs: number;
  /** 边界交叉淡入淡出重叠区时长（ms，默认 20ms） */
  crossfadeMs: number;
  /** 句首前导缓冲时长（ms，默认 160ms，防切首字辅音） */
  preRollMs: number;
  /** 最短有效语音时长（ms，默认 160ms，过滤瞬态敲击） */
  minSpeechMs: number;
  /** 环形缓冲区总容量（ms，默认 12000ms = 12s） */
  ringCapacityMs: number;
}

export const DEFAULT_CLEARVOICE_CHUNKER_CONFIG: Readonly<ClearVoiceChunkerConfig> = {
  sampleRate: 16000,
  frameSizeMs: 32,
  silenceTriggerMs: 280,
  utteranceSilenceMs: 280,
  longUtteranceThresholdMs: 3000,
  longUtteranceExtraSilenceMs: 0,
  incompleteGraceMs: 0,
  maxChunkMs: 2000,
  lookbackMs: 300,
  crossfadeMs: 20,
  preRollMs: 160,
  minSpeechMs: 160,
  ringCapacityMs: 12000,
};

export interface ClearVoiceChunkDescriptor {
  /** 本次切片在当前话语中的序号（从 0 开始） */
  sliceIndex: number;
  /** 触发切分的原因：优先静音触发（silence）、兜底超时强制切分（timeout）或主动冲刷（flush） */
  triggerReason: ClearVoiceTriggerReason;
  /** 本切片是否标志当前话语自然结束（静音触发或 flush 为 true，超时强制切分为 false） */
  utteranceEnded: boolean;
  /** 当前切片新增原始音频（不含历史上下文） */
  rawNewSamples: Float32Array;
  /** 拼接了前 0.3s 历史上下文的完整推理输入：[lookbackRaw, rawNewSamples] */
  rawWithContext: Float32Array;
  /** 头部拼接的历史上下文样本数（0.3s = 4800 样本 @ 16kHz，首个切片若无历史则为实际可用样本数） */
  lookbackSamples: number;
  /** 是否需要与上一段输出做 20ms 线性交叉淡入淡出（超时强制切分或连续切段时为 true） */
  needsCrossfade: boolean;
  /** 全局绝对起止采样位置 */
  startSample: number;
  endSample: number;
  /** 当前切片新增音频时长（ms） */
  durationMs: number;
}

/**
 * 线性交叉淡入淡出（Overlap-Add Cross-fade）：
 * 在长度为 N 的重叠区内，将前一段尾部从 1 -> 0 线性淡出，后一段头部从 0 -> 1 线性淡入并相加。
 */
export function applyLinearCrossfade(
  prevTail: Float32Array,
  currHead: Float32Array,
): Float32Array {
  const n = Math.min(prevTail.length, currHead.length);
  const out = new Float32Array(n);
  if (n === 0) return out;
  if (n === 1) {
    out[0] = 0.5 * (prevTail[0]! + currHead[0]!);
    return out;
  }
  const denom = n - 1;
  for (let i = 0; i < n; i += 1) {
    const fadeIn = i / denom;
    const fadeOut = 1 - fadeIn;
    out[i] = prevTail[i]! * fadeOut + currHead[i]! * fadeIn;
  }
  return out;
}

export interface ClearVoiceAssembleInput {
  /** MossFormer2 GPU 推理返回的完整音频（对应 [lookback, new]） */
  enhancedWithContext: Float32Array;
  /** 本次送入 MossFormer2 时拼接在头部的 0.3s 历史上下文样本数 */
  lookbackSamples: number;
  /** 本次切片对应的新增样本数 */
  newSamples: number;
  /** 是否与上一段末尾执行 20ms 线性交叉淡入淡出 */
  applyCrossfade: boolean;
}

export interface ClearVoiceAssembleResult {
  /** 裁掉前 0.3s 历史缓冲并完成边界平滑后的本切片新增音频 */
  trimmedSlice: Float32Array;
  /** 本次是否实际执行了 20ms 交叉淡入淡出 */
  crossfadeApplied: boolean;
  /** 截至当前切片已无缝拼接的完整纯净话语音频 */
  stitchedTotalSamples: number;
}

/**
 * 阶段 3（裁掉 0.3s 历史上下文）+ 阶段 4（20ms 线性交叉淡入淡出拼接）输出装配器：
 *
 * 关键时间对齐设计：
 * - 上一段输出覆盖 [0, T)，其末尾 20ms 为 [T - 20ms, T)；
 * - 当前段输入包含前 300ms 历史上下文 [T - 300ms, T) 与新增段 [T, T_next)；
 * - 推理完成后，丢弃前 280ms 历史输出 [T - 300ms, T - 20ms)，
 *   取历史缓冲最末尾的 20ms [T - 20ms, T) 与上一段末尾 20ms 做线性 Overlap-Add 淡入淡出，
 *   精确覆盖同一时间区间，既彻底消除拼接爆音，又保证零时间漂移、零音节重复！
 */
export class ClearVoiceSliceAssembler {
  readonly sampleRate: number;
  readonly crossfadeSamples: number;

  private _chunks: Float32Array[] = [];
  private _totalSamples = 0;
  private _prevTail: Float32Array | null = null;
  private _sliceCount = 0;
  private _crossfadeCount = 0;

  constructor(options: { sampleRate?: number; crossfadeMs?: number } = {}) {
    this.sampleRate = options.sampleRate ?? DEFAULT_CLEARVOICE_CHUNKER_CONFIG.sampleRate;
    const cfMs = options.crossfadeMs ?? DEFAULT_CLEARVOICE_CHUNKER_CONFIG.crossfadeMs;
    this.crossfadeSamples = Math.max(0, Math.round((this.sampleRate * cfMs) / 1000));
  }

  get sliceCount(): number {
    return this._sliceCount;
  }

  get crossfadeCount(): number {
    return this._crossfadeCount;
  }

  get totalSamples(): number {
    return this._totalSamples;
  }

  appendEnhancedSlice(input: ClearVoiceAssembleInput): ClearVoiceAssembleResult {
    const { enhancedWithContext, lookbackSamples, newSamples, applyCrossfade } = input;
    const safeLookback = Math.max(0, Math.min(lookbackSamples, enhancedWithContext.length));
    const availableAfterLookback = Math.max(0, enhancedWithContext.length - safeLookback);
    const keepLen = Math.min(newSamples, availableAfterLookback);
    const body = enhancedWithContext.slice(safeLookback, safeLookback + keepLen);

    let crossfadeApplied = false;
    const cfN = this.crossfadeSamples;

    if (
      applyCrossfade &&
      cfN > 0 &&
      this._prevTail &&
      this._prevTail.length >= cfN &&
      safeLookback >= cfN &&
      this._chunks.length > 0
    ) {
      // 从当前切片历史缓冲最末尾取与上一段严格时间对齐的 20ms 重叠区
      const currOverlap = enhancedWithContext.subarray(safeLookback - cfN, safeLookback);
      const blended = applyLinearCrossfade(this._prevTail, currOverlap);
      this._overwriteTail(blended);
      crossfadeApplied = true;
      this._crossfadeCount += 1;
    } else if (
      applyCrossfade &&
      cfN > 0 &&
      this._prevTail &&
      this._prevTail.length >= cfN &&
      body.length >= cfN &&
      this._chunks.length > 0
    ) {
      // 兜底：若调用方未提供足够 lookback，直接在边界前 20ms 做平滑淡入淡出防爆音
      const blended = applyLinearCrossfade(this._prevTail, body.subarray(0, cfN));
      this._overwriteTail(blended);
      crossfadeApplied = true;
      this._crossfadeCount += 1;
    }

    if (body.length > 0) {
      this._chunks.push(body);
      this._totalSamples += body.length;
      if (cfN > 0) {
        this._prevTail =
          body.length >= cfN
            ? body.slice(body.length - cfN)
            : this._readTail(cfN);
      }
    }

    this._sliceCount += 1;
    return {
      trimmedSlice: body,
      crossfadeApplied,
      stitchedTotalSamples: this._totalSamples,
    };
  }

  private _overwriteTail(replacement: Float32Array): void {
    let remaining = replacement.length;
    let repPos = replacement.length;
    for (let idx = this._chunks.length - 1; idx >= 0 && remaining > 0; idx -= 1) {
      const chunk = this._chunks[idx]!;
      const take = Math.min(chunk.length, remaining);
      repPos -= take;
      chunk.set(replacement.subarray(repPos, repPos + take), chunk.length - take);
      remaining -= take;
    }
  }

  private _readTail(length: number): Float32Array | null {
    if (this._totalSamples < length || length <= 0) return null;
    const out = new Float32Array(length);
    let remaining = length;
    let outPos = length;
    for (let idx = this._chunks.length - 1; idx >= 0 && remaining > 0; idx -= 1) {
      const chunk = this._chunks[idx]!;
      const take = Math.min(chunk.length, remaining);
      outPos -= take;
      out.set(chunk.subarray(chunk.length - take), outPos);
      remaining -= take;
    }
    return out;
  }

  getStitchedAudio(): Float32Array {
    if (this._totalSamples === 0) return new Float32Array(0);
    const out = new Float32Array(this._totalSamples);
    let offset = 0;
    for (const c of this._chunks) {
      out.set(c, offset);
      offset += c.length;
    }
    return out;
  }

  reset(): void {
    this._chunks = [];
    this._totalSamples = 0;
    this._prevTail = null;
    this._sliceCount = 0;
    this._crossfadeCount = 0;
  }
}

/**
 * 计算两段等长（或取较短段）音频的归一化波形相关性（[-1, 1]）。
 */
export function computeNormalizedWaveformCorr(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  if (n < 16) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i += 1) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na * nb);
  return denom > 1e-10 ? dot / denom : 0;
}

/**
 * 计算两段音频的短时 RMS 包络相关性（20ms 窗，用于识别单人说话在双轨 BSS 中的镜像串音残影轨）。
 */
export function computeEnvelopeCorr(a: Float32Array, b: Float32Array, windowSamples = 320): number {
  const win = Math.max(32, windowSamples);
  const frames = Math.floor(Math.min(a.length, b.length) / win);
  if (frames < 2) return 0;
  const ea = new Float64Array(frames);
  const eb = new Float64Array(frames);
  let meanA = 0;
  let meanB = 0;
  for (let f = 0; f < frames; f += 1) {
    const off = f * win;
    let sa = 0;
    let sb = 0;
    for (let i = 0; i < win; i += 1) {
      const va = a[off + i]!;
      const vb = b[off + i]!;
      sa += va * va;
      sb += vb * vb;
    }
    ea[f] = Math.sqrt(sa / win);
    eb[f] = Math.sqrt(sb / win);
    meanA += ea[f]!;
    meanB += eb[f]!;
  }
  meanA /= frames;
  meanB /= frames;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let f = 0; f < frames; f += 1) {
    const da = ea[f]! - meanA;
    const db = eb[f]! - meanB;
    dot += da * db;
    na += da * da;
    nb += db * db;
  }
  const denom = Math.sqrt(na * nb);
  return denom > 1e-10 ? dot / denom : 0;
}

/**
 * 轻量相位无关的多频带短时谱包络相关性（4 频带 × 20ms 窗，零外部依赖）：
 * 用于识别单说话人经过 BSS+SE 出现微小相位偏移后的镜像串音残影轨，避免把同一人重复拆成两条假音轨，
 * 同时完整保留不同说话人/人声+歌声的真实多轨分离输出。
 */
export function computeSubbandSpectralCorr(a: Float32Array, b: Float32Array, windowSamples = 320): number {
  const win = Math.max(64, windowSamples);
  const frames = Math.floor(Math.min(a.length, b.length) / win);
  if (frames < 2) return 0;
  // 4 个近似中心频点 DFT 幅度（250Hz / 750Hz / 1600Hz / 3200Hz @ 16kHz）
  const binFreqs = [5, 15, 32, 64];
  const bands = binFreqs.length;
  const fa = new Float64Array(frames * bands);
  const fb = new Float64Array(frames * bands);
  let meanA = 0;
  let meanB = 0;
  for (let f = 0; f < frames; f += 1) {
    const off = f * win;
    for (let bi = 0; bi < bands; bi += 1) {
      const k = binFreqs[bi]!;
      const step = (2 * Math.PI * k) / win;
      let ra = 0;
      let ia = 0;
      let rb = 0;
      let ib = 0;
      for (let i = 0; i < win; i += 1) {
        const ang = step * i;
        const c = Math.cos(ang);
        const s = Math.sin(ang);
        const va = a[off + i]!;
        const vb = b[off + i]!;
        ra += va * c;
        ia -= va * s;
        rb += vb * c;
        ib -= vb * s;
      }
      const ma = Math.log1p(Math.hypot(ra, ia));
      const mb = Math.log1p(Math.hypot(rb, ib));
      const idx = f * bands + bi;
      fa[idx] = ma;
      fb[idx] = mb;
      meanA += ma;
      meanB += mb;
    }
  }
  const total = frames * bands;
  meanA /= total;
  meanB /= total;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < total; i += 1) {
    const da = fa[i]! - meanA;
    const db = fb[i]! - meanB;
    dot += da * db;
    na += da * da;
    nb += db * db;
  }
  const denom = Math.sqrt(na * nb);
  return denom > 1e-10 ? dot / denom : 0;
}

/**
 * 跨切片 PIT 置换对齐（Permutation Invariant Alignment）：
 * ClearVoice MossFormer2_SS_16K 对不同切片输出的音轨顺序可能发生对调（轨0/轨1互换），
 * 若不对齐直接拼接会把两名说话人混杂进同一音轨！
 * 本函数利用当前切片头部 0.3s 历史重叠区与各轨上一段末尾 0.3s 的归一化波形相关性，
 * 自动找出最优无混叠映射，确保每条音轨始终锁定同一声源、绝不串轨混杂。
 */
export function alignSeparatedTracksWithPrevTails(
  prevTails: ReadonlyArray<Float32Array>,
  currTracks: ReadonlyArray<Float32Array>,
  lookbackSamples: number,
): { aligned: Float32Array[]; swapped: boolean; permutation: number[] } {
  const count = currTracks.length;
  if (count <= 1 || prevTails.length < count || lookbackSamples < 32) {
    return {
      aligned: currTracks.map((t) => t),
      swapped: false,
      permutation: currTracks.map((_, i) => i),
    };
  }

  const ovLen = Math.min(
    lookbackSamples,
    ...prevTails.slice(0, count).map((p) => p.length),
    ...currTracks.map((c) => c.length),
  );
  if (ovLen < 32) {
    return {
      aligned: currTracks.map((t) => t),
      swapped: false,
      permutation: currTracks.map((_, i) => i),
    };
  }

  const prevSlice = prevTails.slice(0, count).map((p) => p.subarray(p.length - ovLen));
  const currSlice = currTracks.map((c) => c.subarray(0, ovLen));

  // 双轨精确全局最优匹配（覆盖 MossFormer2_SS_16K 的主场景）
  if (count === 2) {
    const scoreSame =
      computeNormalizedWaveformCorr(prevSlice[0]!, currSlice[0]!) +
      computeNormalizedWaveformCorr(prevSlice[1]!, currSlice[1]!);
    const scoreSwap =
      computeNormalizedWaveformCorr(prevSlice[0]!, currSlice[1]!) +
      computeNormalizedWaveformCorr(prevSlice[1]!, currSlice[0]!);
    if (scoreSwap > scoreSame + 1e-4) {
      return {
        aligned: [currTracks[1]!, currTracks[0]!],
        swapped: true,
        permutation: [1, 0],
      };
    }
    return {
      aligned: [currTracks[0]!, currTracks[1]!],
      swapped: false,
      permutation: [0, 1],
    };
  }

  // 多于 2 轨时执行贪心最优匹配
  const usedCurr = new Set<number>();
  const permutation = new Array<number>(count).fill(0);
  const aligned = new Array<Float32Array>(count);
  let swapped = false;
  for (let pIdx = 0; pIdx < count; pIdx += 1) {
    let bestC = -1;
    let bestScore = -Infinity;
    for (let cIdx = 0; cIdx < count; cIdx += 1) {
      if (usedCurr.has(cIdx)) continue;
      const sc = computeNormalizedWaveformCorr(prevSlice[pIdx]!, currSlice[cIdx]!);
      if (sc > bestScore) {
        bestScore = sc;
        bestC = cIdx;
      }
    }
    const chosen = bestC >= 0 ? bestC : pIdx;
    usedCurr.add(chosen);
    permutation[pIdx] = chosen;
    aligned[pIdx] = currTracks[chosen]!;
    if (chosen !== pIdx) swapped = true;
  }
  return { aligned, swapped, permutation };
}

export interface PrunedTrackItem {
  /** 1-based 展示序号 */
  trackIndex: number;
  /** 原始分离槽位索引（0-based） */
  sourceSlot: number;
  samples: Float32Array;
  rms: number;
  energyRatio: number;
}

export interface PruneTracksOptions {
  /** 绝对最小 RMS 门限（默认 0.0045） */
  minAbsoluteRms?: number;
  /** 相对最强轨最小 RMS 比值（默认 0.12，约 -18.4 dB） */
  minRelativeRmsRatio?: number;
  /** 判定镜像串音轨的波形相关性门限（默认 0.58） */
  duplicateWaveformCorr?: number;
  /** 判定镜像串音轨的能量包络相关性门限（默认 0.75） */
  duplicateEnvelopeCorr?: number;
}

export interface PruneTracksResult {
  tracks: PrunedTrackItem[];
  droppedCount: number;
  pairWcorr: number;
  pairEcorr: number;
}

/**
 * 过滤静音残余轨与单说话人镜像串音轨（严禁将多条独立音轨混杂合并！仅剔除无效空轨/镜像残影）：
 * - 单说话人输入 -> 保留主轨（1 轨），不产生重复假指令；
 * - 多说话人或人声+背景歌声 -> 保留全部独立有效音轨（2+ 轨），各自完整保留原始未混叠波形。
 */
export function pruneInactiveOrDuplicateTracks(
  tracks: ReadonlyArray<Float32Array>,
  options: PruneTracksOptions = {},
): PruneTracksResult {
  if (tracks.length === 0) {
    return { tracks: [], droppedCount: 0, pairWcorr: 0, pairEcorr: 0 };
  }
  const minAbsRms = options.minAbsoluteRms ?? 0.0045;
  const minRelRatio = options.minRelativeRmsRatio ?? 0.12;
  const dupWcorr = options.duplicateWaveformCorr ?? 0.58;
  const dupEcorr = options.duplicateEnvelopeCorr ?? 0.75;

  const rmsList = tracks.map((t) => computeRms(t));
  let strongestIdx = 0;
  let maxRms = rmsList[0] ?? 0;
  for (let i = 1; i < rmsList.length; i += 1) {
    if ((rmsList[i] ?? 0) > maxRms) {
      maxRms = rmsList[i]!;
      strongestIdx = i;
    }
  }

  let pairWcorr = 0;
  let pairEcorr = 0;
  if (tracks.length >= 2) {
    pairWcorr = Math.abs(computeNormalizedWaveformCorr(tracks[0]!, tracks[1]!));
    pairEcorr = computeEnvelopeCorr(tracks[0]!, tracks[1]!);
  }

  const keptSlots: number[] = [];
  for (let i = 0; i < tracks.length; i += 1) {
    const tr = tracks[i]!;
    if (tr.length === 0) continue;
    const r = rmsList[i] ?? 0;
    if (i === strongestIdx) {
      keptSlots.push(i);
      continue;
    }
    if (r < minAbsRms || (maxRms > 1e-6 && r < maxRms * minRelRatio)) {
      continue;
    }
    const wCorr = Math.abs(computeNormalizedWaveformCorr(tracks[strongestIdx]!, tr));
    const eCorr = computeEnvelopeCorr(tracks[strongestIdx]!, tr);
    const sCorr = computeSubbandSpectralCorr(tracks[strongestIdx]!, tr);
    const relRatio = maxRms > 1e-6 ? r / maxRms : 0;
    if (
      (wCorr >= dupWcorr && eCorr >= dupEcorr) ||
      (sCorr >= 0.72 && (wCorr >= 0.22 || eCorr >= 0.55 || relRatio <= 0.55))
    ) {
      continue;
    }
    keptSlots.push(i);
  }

  if (keptSlots.length === 0 && tracks[strongestIdx] && tracks[strongestIdx]!.length > 0) {
    keptSlots.push(strongestIdx);
  }

  const totalEnergy = keptSlots.reduce((acc, slot) => {
    const r = rmsList[slot] ?? 0;
    return acc + r * r;
  }, 0);

  const items: PrunedTrackItem[] = keptSlots.map((slot, outIdx) => {
    const r = rmsList[slot] ?? 0;
    const ratio = totalEnergy > 1e-12 ? (r * r) / totalEnergy : 1 / Math.max(1, keptSlots.length);
    return {
      trackIndex: outIdx + 1,
      sourceSlot: slot,
      samples: tracks[slot]!,
      rms: Number(r.toFixed(5)),
      energyRatio: Number(ratio.toFixed(4)),
    };
  });

  return {
    tracks: items,
    droppedCount: Math.max(0, tracks.length - items.length),
    pairWcorr: Number(pairWcorr.toFixed(4)),
    pairEcorr: Number(pairEcorr.toFixed(4)),
  };
}

export interface ClearVoiceMultiTrackSliceInput {
  /** ClearVoice 盲源分离 + 分轨降噪后的多轨切片（每条长度对应 [lookback, new]） */
  tracksWithContext: ReadonlyArray<Float32Array>;
  lookbackSamples: number;
  newSamples: number;
  applyCrossfade: boolean;
}

export interface ClearVoiceMultiTrackSliceResult {
  trackCount: number;
  swapped: boolean;
  crossfadeApplied: boolean;
  stitchedTotalSamples: number;
}

/**
 * 多轨独立切片装配器：
 * - 为每条盲源分离音轨维护完全独立的 ClearVoiceSliceAssembler（互不混叠、零串轨）；
 * - 每次追加新切片前，利用 0.3s 历史重叠区执行 PIT 置换对齐，防止 MossFormer2_SS 跨切片换轨；
 * - 每条音轨各自执行 20ms 线性交叉淡入淡出平滑拼接，绝不将多轨音轨混杂回单轨！
 */
export class ClearVoiceMultiTrackAssembler {
  readonly sampleRate: number;
  readonly crossfadeMs: number;
  readonly lookbackTailSamples: number;

  private _assemblers: ClearVoiceSliceAssembler[] = [];
  private _prevTails: Float32Array[] = [];
  private _sliceCount = 0;
  private _crossfadeCount = 0;
  private _permutationSwaps = 0;

  constructor(
    options: {
      sampleRate?: number;
      crossfadeMs?: number;
      lookbackMs?: number;
    } = {},
  ) {
    this.sampleRate = options.sampleRate ?? DEFAULT_CLEARVOICE_CHUNKER_CONFIG.sampleRate;
    this.crossfadeMs = options.crossfadeMs ?? DEFAULT_CLEARVOICE_CHUNKER_CONFIG.crossfadeMs;
    const lbMs = options.lookbackMs ?? DEFAULT_CLEARVOICE_CHUNKER_CONFIG.lookbackMs;
    this.lookbackTailSamples = Math.max(320, Math.round((this.sampleRate * Math.max(lbMs, 300)) / 1000));
  }

  get trackSlotCount(): number {
    return this._assemblers.length;
  }

  get sliceCount(): number {
    return this._sliceCount;
  }

  get crossfadeCount(): number {
    return this._crossfadeCount;
  }

  get permutationSwaps(): number {
    return this._permutationSwaps;
  }

  get totalSamples(): number {
    return this._assemblers.reduce((maxLen, a) => Math.max(maxLen, a.totalSamples), 0);
  }

  private _ensureSlots(slotCount: number): void {
    const existingSamples = this.totalSamples;
    while (this._assemblers.length < slotCount) {
      const asm = new ClearVoiceSliceAssembler({
        sampleRate: this.sampleRate,
        crossfadeMs: this.crossfadeMs,
      });
      if (existingSamples > 0) {
        asm.appendEnhancedSlice({
          enhancedWithContext: new Float32Array(existingSamples),
          lookbackSamples: 0,
          newSamples: existingSamples,
          applyCrossfade: false,
        });
      }
      this._assemblers.push(asm);
      this._prevTails.push(new Float32Array(0));
    }
  }

  appendSeparatedSlice(input: ClearVoiceMultiTrackSliceInput): ClearVoiceMultiTrackSliceResult {
    const rawTracks = input.tracksWithContext;
    if (rawTracks.length === 0) {
      return {
        trackCount: this._assemblers.length,
        swapped: false,
        crossfadeApplied: false,
        stitchedTotalSamples: this.totalSamples,
      };
    }

    const slotCount = Math.max(this._assemblers.length, rawTracks.length);
    this._ensureSlots(slotCount);

    // 若本片返回的轨数少于已有槽位数（如某片退回单轨），其余槽位补静音保持时间对齐且不污染主轨
    const normalizedTracks: Float32Array[] = [];
    const expectedSliceLen = rawTracks[0]!.length;
    for (let i = 0; i < slotCount; i += 1) {
      normalizedTracks.push(rawTracks[i] ?? new Float32Array(expectedSliceLen));
    }

    let alignedTracks = normalizedTracks;
    let swapped = false;
    if (this._sliceCount > 0 && slotCount > 1 && input.lookbackSamples > 0) {
      const aligned = alignSeparatedTracksWithPrevTails(
        this._prevTails,
        normalizedTracks,
        input.lookbackSamples,
      );
      alignedTracks = aligned.aligned;
      swapped = aligned.swapped;
      if (swapped) {
        this._permutationSwaps += 1;
      }
    }

    let anyCrossfade = false;
    let maxTotal = 0;
    for (let i = 0; i < slotCount; i += 1) {
      const asm = this._assemblers[i]!;
      const res = asm.appendEnhancedSlice({
        enhancedWithContext: alignedTracks[i]!,
        lookbackSamples: input.lookbackSamples,
        newSamples: input.newSamples,
        applyCrossfade: input.applyCrossfade,
      });
      if (res.crossfadeApplied) {
        anyCrossfade = true;
      }
      maxTotal = Math.max(maxTotal, res.stitchedTotalSamples);

      // 更新该音轨的最近 lookback 尾部，供下一切片做 PIT 置换对齐
      const fullTrack = asm.getStitchedAudio();
      const tailLen = Math.min(this.lookbackTailSamples, fullTrack.length);
      this._prevTails[i] = tailLen > 0 ? fullTrack.slice(fullTrack.length - tailLen) : new Float32Array(0);
    }

    if (anyCrossfade) {
      this._crossfadeCount += 1;
    }
    this._sliceCount += 1;

    return {
      trackCount: slotCount,
      swapped,
      crossfadeApplied: anyCrossfade,
      stitchedTotalSamples: maxTotal,
    };
  }

  getRawTracks(): Float32Array[] {
    return this._assemblers.map((a) => a.getStitchedAudio());
  }

  getTracks(options: { prune?: boolean } & PruneTracksOptions = {}): PruneTracksResult {
    const raw = this.getRawTracks();
    if (options.prune === false) {
      const rmsList = raw.map((t) => computeRms(t));
      const totalEnergy = rmsList.reduce((acc, r) => acc + r * r, 0);
      const tracks: PrunedTrackItem[] = raw.map((samples, idx) => {
        const r = rmsList[idx] ?? 0;
        const ratio = totalEnergy > 1e-12 ? (r * r) / totalEnergy : 1 / Math.max(1, raw.length);
        return {
          trackIndex: idx + 1,
          sourceSlot: idx,
          samples,
          rms: Number(r.toFixed(5)),
          energyRatio: Number(ratio.toFixed(4)),
        };
      });
      return {
        tracks,
        droppedCount: 0,
        pairWcorr: raw.length >= 2 ? Number(Math.abs(computeNormalizedWaveformCorr(raw[0]!, raw[1]!)).toFixed(4)) : 0,
        pairEcorr: raw.length >= 2 ? Number(computeEnvelopeCorr(raw[0]!, raw[1]!).toFixed(4)) : 0,
      };
    }
    return pruneInactiveOrDuplicateTracks(raw, options);
  }

  reset(): void {
    this._assemblers = [];
    this._prevTails = [];
    this._sliceCount = 0;
    this._crossfadeCount = 0;
    this._permutationSwaps = 0;
  }
}

export interface ClearVoiceRealtimeChunkerOptions extends Partial<ClearVoiceChunkerConfig> {
  /** 输入音频采样率（默认 16000Hz，非目标采样率将自动重采样） */
  inputSampleRate?: number;
  /** 可选外部 Silero VAD 实例（建议配置短静音阈值 ~60ms 以提供精准帧级语音态） */
  vad?: StreamingVadHandleLike | null;
  /** 当未注入 Silero VAD 时的能量兜底门限（默认 0.014） */
  fallbackRmsThreshold?: number;
  /** 实时语音活动状态变化回调 */
  onSpeechActivity?: (speaking: boolean) => void;
}

/**
 * 阶段 1 + 阶段 2 + 阶段 3（打包）双触发准实时切片器：
 * - 固定 32ms 帧驱动 Silero VAD + 环形缓冲区；
 * - 静音触发（250ms–300ms，默认 280ms）优先语义断块；
 * - 超时强制触发（默认 2.0s）兜底连续快语速；
 * - 每次切片自动前置 0.3s 原始历史上下文。
 */
export class ClearVoiceRealtimeChunker {
  readonly config: ClearVoiceChunkerConfig;
  private readonly _inputRate: number;
  private readonly _vad: StreamingVadHandleLike | null;
  private readonly _fallbackRmsThreshold: number;
  private readonly _onSpeechActivity?: (speaking: boolean) => void;

  private readonly _frameSamples: number;
  private readonly _lookbackSamples: number;
  private readonly _preRollSamples: number;
  private readonly _maxChunkSamples: number;
  private readonly _minSpeechSamples: number;
  private readonly _ringCapacity: number;

  private readonly _ring: Float32Array;
  private _totalSamples = 0;
  private _pending = new Float32Array(0);

  // 当前话语与切片状态
  private _speaking = false;
  private _inUtterance = false;
  private _waitingUtteranceEnd = false;
  private _utteranceSliceIndex = 0;
  private _utteranceSpeechSamples = 0;
  private _prevSliceForcedTimeout = false;
  private _sliceStartSample: number | null = null;
  private _lastSliceEndSample: number | null = null;
  private _speechAccumSamples = 0;
  private _consecutiveSilenceMs = 0;
  private _incompleteHint = false;
  private _adaptiveNoiseFloor = 0.006;

  constructor(options: ClearVoiceRealtimeChunkerOptions = {}) {
    const sampleRate = options.sampleRate ?? DEFAULT_CLEARVOICE_CHUNKER_CONFIG.sampleRate;
    const frameSizeMs = options.frameSizeMs ?? DEFAULT_CLEARVOICE_CHUNKER_CONFIG.frameSizeMs;
    const silenceTriggerMs = Math.max(
      180,
      Math.min(800, options.silenceTriggerMs ?? DEFAULT_CLEARVOICE_CHUNKER_CONFIG.silenceTriggerMs),
    );
    const utteranceSilenceMs =
      options.utteranceSilenceMs !== undefined
        ? Math.max(silenceTriggerMs, Math.min(5000, options.utteranceSilenceMs))
        : silenceTriggerMs;
    const decoupledUtteranceEnd = utteranceSilenceMs > silenceTriggerMs;
    const longUtteranceThresholdMs = Math.max(
      800,
      options.longUtteranceThresholdMs ?? DEFAULT_CLEARVOICE_CHUNKER_CONFIG.longUtteranceThresholdMs,
    );
    const longUtteranceExtraSilenceMs =
      options.longUtteranceExtraSilenceMs !== undefined
        ? Math.max(0, Math.min(1500, options.longUtteranceExtraSilenceMs))
        : decoupledUtteranceEnd
          ? 350
          : 0;
    const incompleteGraceMs =
      options.incompleteGraceMs !== undefined
        ? Math.max(0, Math.min(1800, options.incompleteGraceMs))
        : decoupledUtteranceEnd
          ? 700
          : 0;
    const maxChunkMs = Math.max(
      600,
      Math.min(5000, options.maxChunkMs ?? DEFAULT_CLEARVOICE_CHUNKER_CONFIG.maxChunkMs),
    );
    const lookbackMs = Math.max(
      0,
      Math.min(1000, options.lookbackMs ?? DEFAULT_CLEARVOICE_CHUNKER_CONFIG.lookbackMs),
    );
    const crossfadeMs = Math.max(
      0,
      Math.min(100, options.crossfadeMs ?? DEFAULT_CLEARVOICE_CHUNKER_CONFIG.crossfadeMs),
    );
    const preRollMs = Math.max(
      0,
      Math.min(500, options.preRollMs ?? DEFAULT_CLEARVOICE_CHUNKER_CONFIG.preRollMs),
    );
    const minSpeechMs = Math.max(
      64,
      Math.min(500, options.minSpeechMs ?? DEFAULT_CLEARVOICE_CHUNKER_CONFIG.minSpeechMs),
    );
    const ringCapacityMs = Math.max(
      maxChunkMs + lookbackMs + utteranceSilenceMs + 2000,
      options.ringCapacityMs ?? DEFAULT_CLEARVOICE_CHUNKER_CONFIG.ringCapacityMs,
    );

    this.config = {
      sampleRate,
      frameSizeMs,
      silenceTriggerMs,
      utteranceSilenceMs,
      longUtteranceThresholdMs,
      longUtteranceExtraSilenceMs,
      incompleteGraceMs,
      maxChunkMs,
      lookbackMs,
      crossfadeMs,
      preRollMs,
      minSpeechMs,
      ringCapacityMs,
    };

    this._inputRate = options.inputSampleRate ?? sampleRate;
    this._vad = options.vad ?? null;
    this._fallbackRmsThreshold = options.fallbackRmsThreshold ?? 0.014;
    this._onSpeechActivity = options.onSpeechActivity;

    this._frameSamples = Math.round((sampleRate * frameSizeMs) / 1000);
    this._lookbackSamples = Math.round((sampleRate * lookbackMs) / 1000);
    this._preRollSamples = Math.round((sampleRate * preRollMs) / 1000);
    this._maxChunkSamples = Math.round((sampleRate * maxChunkMs) / 1000);
    this._minSpeechSamples = Math.round((sampleRate * minSpeechMs) / 1000);
    this._ringCapacity = Math.round((sampleRate * ringCapacityMs) / 1000);
    this._ring = new Float32Array(this._ringCapacity);
  }

  get totalSamples(): number {
    return this._totalSamples;
  }

  get isSpeaking(): boolean {
    return this._speaking;
  }

  get inUtterance(): boolean {
    return this._inUtterance;
  }

  get waitingUtteranceEnd(): boolean {
    return this._waitingUtteranceEnd;
  }

  /**
   * 实时注入语义未闭合提示（如句中停在“然后/把客厅灯”等未说完处时自动延长尾静音宽限，防慢语速提前断句）。
   */
  setIncompleteUtteranceHint(incomplete: boolean): void {
    this._incompleteHint = Boolean(incomplete);
  }

  /**
   * 运行期热更新整句尾静音判停时长（用户在设置中调整 vadSilenceMs 后立即生效，无需重连 WebSocket）。
   */
  setUtteranceSilenceMs(utteranceSilenceMs: number): void {
    if (!Number.isFinite(utteranceSilenceMs)) return;
    this.config.utteranceSilenceMs = Math.max(
      this.config.silenceTriggerMs,
      Math.min(5000, Math.round(utteranceSilenceMs)),
    );
  }

  private _effectiveUtteranceSilenceMs(): number {
    let target = this.config.utteranceSilenceMs;
    if (target <= this.config.silenceTriggerMs) {
      return target;
    }
    const utteranceSpeechMs = (this._utteranceSpeechSamples / this.config.sampleRate) * 1000;
    if (utteranceSpeechMs >= this.config.longUtteranceThresholdMs) {
      target += this.config.longUtteranceExtraSilenceMs;
    }
    if (this._incompleteHint) {
      target += this.config.incompleteGraceMs;
    }
    return Math.min(5000, target);
  }

  /**
   * 喂入任意长度 PCM 音频（自动重采样到目标采样率并拆分为固定 32ms 帧），
   * 返回本批次触发切分的所有切片描述（包含 0.3s 历史上下文与跨边界标志）。
   */
  pushSamples(samples: Float32Array): ClearVoiceChunkDescriptor[] {
    if (samples.length === 0) return [];
    const sr = this.config.sampleRate;
    const normalized =
      this._inputRate === sr ? samples : resampleLinear(samples, this._inputRate, sr);

    const merged = new Float32Array(this._pending.length + normalized.length);
    merged.set(this._pending, 0);
    merged.set(normalized, this._pending.length);

    const emitted: ClearVoiceChunkDescriptor[] = [];
    let offset = 0;

    while (offset + this._frameSamples <= merged.length) {
      const frame = merged.subarray(offset, offset + this._frameSamples);
      const chunk = this._processFrame(frame);
      if (chunk) {
        emitted.push(chunk);
      }
      offset += this._frameSamples;
    }

    this._pending = offset < merged.length ? merged.slice(offset) : new Float32Array(0);
    return emitted;
  }

  /**
   * 主动冲刷当前尚未提交的尾部语音切片（例如停止监听或单次说话结束时）。
   */
  flush(): ClearVoiceChunkDescriptor | null {
    if (this._pending.length > 0) {
      this._writeRing(this._pending);
      this._pending = new Float32Array(0);
    }
    if (!this._inUtterance) {
      this._clearUtteranceState();
      return null;
    }
    // 已在 280ms 静音处送出尾部切片、正处于整句静默等待期时，无需重复送空白切片，清理状态由装配器直接提交
    if (this._waitingUtteranceEnd || this._sliceStartSample === null) {
      this._clearUtteranceState();
      return null;
    }
    const accumulated = this._totalSamples - this._sliceStartSample;
    if (accumulated < Math.min(this._minSpeechSamples, this._frameSamples * 2)) {
      this._clearUtteranceState();
      return null;
    }
    const chunk = this._buildChunk(this._sliceStartSample, this._totalSamples, "flush", true);
    this._clearUtteranceState();
    return chunk;
  }

  reset(): void {
    this._pending = new Float32Array(0);
    this._clearUtteranceState();
    if (this._vad) {
      try {
        while (!this._vad.isEmpty()) this._vad.pop();
        if (typeof this._vad.reset === "function") this._vad.reset();
        else this._vad.clear();
      } catch {
        // ignore
      }
    }
  }

  private _clearUtteranceState(): void {
    const wasSpeaking = this._speaking;
    this._speaking = false;
    this._inUtterance = false;
    this._waitingUtteranceEnd = false;
    this._utteranceSliceIndex = 0;
    this._utteranceSpeechSamples = 0;
    this._prevSliceForcedTimeout = false;
    this._sliceStartSample = null;
    this._lastSliceEndSample = null;
    this._speechAccumSamples = 0;
    this._consecutiveSilenceMs = 0;
    this._incompleteHint = false;
    if (wasSpeaking) {
      this._onSpeechActivity?.(false);
    }
  }

  private _writeRing(frame: Float32Array): void {
    const cap = this._ringCapacity;
    for (let i = 0; i < frame.length; i += 1) {
      this._ring[(this._totalSamples + i) % cap] = frame[i]!;
    }
    this._totalSamples += frame.length;
  }

  private _readRingRange(startSample: number, endSample: number): Float32Array {
    const cap = this._ringCapacity;
    const earliest = Math.max(0, this._totalSamples - cap);
    const s = Math.max(earliest, Math.min(this._totalSamples, startSample));
    const e = Math.max(s, Math.min(this._totalSamples, endSample));
    const len = e - s;
    const out = new Float32Array(len);
    for (let i = 0; i < len; i += 1) {
      out[i] = this._ring[(s + i) % cap]!;
    }
    return out;
  }

  private _detectVoiceInFrame(frame: Float32Array): boolean {
    if (this._vad) {
      try {
        this._vad.acceptWaveform(frame);
        // 清理 Silero 内部段队列防止长流内存增长，切片边界完全由双触发状态机精准把控
        while (!this._vad.isEmpty()) {
          this._vad.pop();
        }
        return this._vad.isDetected();
      } catch {
        // fallback to energy VAD
      }
    }
    const rms = computeRms(frame);
    const thresh = Math.max(this._fallbackRmsThreshold, this._adaptiveNoiseFloor * 2.4);
    const voice = rms >= thresh;
    if (!voice) {
      const rate = rms < this._adaptiveNoiseFloor ? 0.08 : 0.015;
      this._adaptiveNoiseFloor = Math.max(
        0.002,
        Math.min(0.03, this._adaptiveNoiseFloor * (1 - rate) + rms * rate),
      );
    }
    return voice;
  }

  private _processFrame(frame: Float32Array): ClearVoiceChunkDescriptor | null {
    this._writeRing(frame);
    const isVoice = this._detectVoiceInFrame(frame);

    if (isVoice) {
      this._consecutiveSilenceMs = 0;
      if (!this._inUtterance) {
        this._inUtterance = true;
        this._waitingUtteranceEnd = false;
        this._utteranceSliceIndex = 0;
        this._utteranceSpeechSamples = 0;
        this._prevSliceForcedTimeout = false;
        this._speechAccumSamples = 0;
        this._incompleteHint = false;
        this._lastSliceEndSample = null;
        // 句首保留 preRollMs，绝不截断唤醒词或辅音起音
        this._sliceStartSample = Math.max(
          0,
          this._totalSamples - this._frameSamples - this._preRollSamples,
        );
      } else if (this._waitingUtteranceEnd) {
        // 慢语速短停顿后用户继续说话：无缝续接同一条话语，严禁强拆为多条句子！
        this._waitingUtteranceEnd = false;
        this._speechAccumSamples = 0;
        const anchor =
          this._lastSliceEndSample ??
          Math.max(0, this._totalSamples - this._frameSamples - this._preRollSamples);
        const gapSamples = this._totalSamples - anchor;
        if (gapSamples > this._maxChunkSamples - this._frameSamples * 8) {
          // 停顿较长时跳过中段纯静音，保留续说前导 preRoll，保证单片不超过 maxChunkMs
          this._sliceStartSample = Math.max(
            anchor,
            this._totalSamples - this._frameSamples - this._preRollSamples,
          );
        } else {
          // 保持与上一段完全连续的时间轴，使 0.3s 历史窗与 20ms Overlap-Add 精确对齐
          this._sliceStartSample = anchor;
        }
      } else if (this._sliceStartSample === null) {
        this._sliceStartSample = Math.max(0, this._totalSamples - this._frameSamples);
      }
      this._speechAccumSamples += this._frameSamples;
      this._utteranceSpeechSamples += this._frameSamples;
      if (!this._speaking) {
        this._speaking = true;
        this._onSpeechActivity?.(true);
      }
    } else if (this._inUtterance) {
      this._consecutiveSilenceMs += this.config.frameSizeMs;
    }

    if (!this._inUtterance) {
      return null;
    }

    // 正处于“已送完增量降噪切片、等待整句真正说完”的静音观察期：
    // 只有连续静默达到完整整句判停阈值（含长语音与未闭合宽限）才结束整句并提交 ASR -> Pi Agent
    if (this._waitingUtteranceEnd) {
      if (!isVoice && this._consecutiveSilenceMs >= this._effectiveUtteranceSilenceMs()) {
        const endPos = this._totalSamples;
        const marker: ClearVoiceChunkDescriptor = {
          sliceIndex: this._utteranceSliceIndex,
          triggerReason: "silence",
          utteranceEnded: true,
          rawNewSamples: new Float32Array(0),
          rawWithContext: new Float32Array(0),
          lookbackSamples: 0,
          needsCrossfade: false,
          startSample: endPos,
          endSample: endPos,
          durationMs: 0,
        };
        this._clearUtteranceState();
        return marker;
      }
      return null;
    }

    if (this._sliceStartSample === null) {
      return null;
    }

    const sliceLen = this._totalSamples - this._sliceStartSample;

    // 触发规则 1（优先）：静音触发（检测到人声后的静音停顿 >= 250ms–300ms）
    // - 若整句判停阈值 > 切片静音阈值：先增量送 GPU ClearVoice 降噪（utteranceEnded=false），进入整句静默观察期；
    // - 若两者相等（单测直调模式）：直接收尾整句（utteranceEnded=true）。
    if (!isVoice && this._consecutiveSilenceMs >= this.config.silenceTriggerMs) {
      if (this._speechAccumSamples < this._minSpeechSamples && this._utteranceSliceIndex === 0) {
        // 极短瞬态杂音（< minSpeechMs），直接丢弃
        this._clearUtteranceState();
        return null;
      }
      const shouldEndNow = this._consecutiveSilenceMs >= this._effectiveUtteranceSilenceMs();
      const chunk = this._buildChunk(
        this._sliceStartSample,
        this._totalSamples,
        "silence",
        shouldEndNow,
      );
      if (shouldEndNow) {
        this._clearUtteranceState();
      } else {
        this._utteranceSliceIndex += 1;
        this._prevSliceForcedTimeout = false;
        this._lastSliceEndSample = this._totalSamples;
        this._sliceStartSample = null;
        this._speechAccumSamples = 0;
        this._waitingUtteranceEnd = true;
      }
      return chunk;
    }

    // 触发规则 2（兜底）：超时强制触发（连续讲话不停顿达到上限 2.0s 时强制切分给 GPU 增量降噪，绝不提前中断整句）
    if (sliceLen >= this._maxChunkSamples) {
      const chunk = this._buildChunk(this._sliceStartSample, this._totalSamples, "timeout", false);
      this._utteranceSliceIndex += 1;
      this._prevSliceForcedTimeout = true;
      this._lastSliceEndSample = this._totalSamples;
      this._sliceStartSample = this._totalSamples;
      this._speechAccumSamples = 0;
      this._consecutiveSilenceMs = 0;
      return chunk;
    }

    return null;
  }

  private _buildChunk(
    startSample: number,
    endSample: number,
    triggerReason: ClearVoiceTriggerReason,
    utteranceEnded: boolean,
  ): ClearVoiceChunkDescriptor {
    const rawNewSamples = this._readRingRange(startSample, endSample);

    // 阶段 3：历史上下文缓冲（拼接前 0.3s 原始音频到当前切片头部，供 MossFormer2 提供前文语境）
    const earliestAvailable = Math.max(0, this._totalSamples - this._ringCapacity);
    const contextStart = Math.max(earliestAvailable, startSample - this._lookbackSamples);
    const lookbackRaw =
      contextStart < startSample
        ? this._readRingRange(contextStart, startSample)
        : new Float32Array(0);

    const rawWithContext = new Float32Array(lookbackRaw.length + rawNewSamples.length);
    if (lookbackRaw.length > 0) {
      rawWithContext.set(lookbackRaw, 0);
    }
    rawWithContext.set(rawNewSamples, lookbackRaw.length);

    return {
      sliceIndex: this._utteranceSliceIndex,
      triggerReason,
      utteranceEnded,
      rawNewSamples,
      rawWithContext,
      lookbackSamples: lookbackRaw.length,
      needsCrossfade: this._prevSliceForcedTimeout || this._utteranceSliceIndex > 0,
      startSample,
      endSample,
      durationMs: Math.round((rawNewSamples.length / this.config.sampleRate) * 1000),
    };
  }
}
