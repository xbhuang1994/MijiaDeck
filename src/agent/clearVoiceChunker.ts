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
  /** 静音触发阈值（ms，250–300ms，默认 280ms） */
  silenceTriggerMs: number;
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
  private _utteranceSliceIndex = 0;
  private _prevSliceForcedTimeout = false;
  private _sliceStartSample: number | null = null;
  private _speechAccumSamples = 0;
  private _consecutiveSilenceMs = 0;
  private _adaptiveNoiseFloor = 0.006;

  constructor(options: ClearVoiceRealtimeChunkerOptions = {}) {
    const sampleRate = options.sampleRate ?? DEFAULT_CLEARVOICE_CHUNKER_CONFIG.sampleRate;
    const frameSizeMs = options.frameSizeMs ?? DEFAULT_CLEARVOICE_CHUNKER_CONFIG.frameSizeMs;
    const silenceTriggerMs = Math.max(
      180,
      Math.min(800, options.silenceTriggerMs ?? DEFAULT_CLEARVOICE_CHUNKER_CONFIG.silenceTriggerMs),
    );
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
      maxChunkMs + lookbackMs + 2000,
      options.ringCapacityMs ?? DEFAULT_CLEARVOICE_CHUNKER_CONFIG.ringCapacityMs,
    );

    this.config = {
      sampleRate,
      frameSizeMs,
      silenceTriggerMs,
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
    if (this._sliceStartSample === null || !this._inUtterance) {
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
    this._utteranceSliceIndex = 0;
    this._prevSliceForcedTimeout = false;
    this._sliceStartSample = null;
    this._speechAccumSamples = 0;
    this._consecutiveSilenceMs = 0;
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
        this._utteranceSliceIndex = 0;
        this._prevSliceForcedTimeout = false;
        this._speechAccumSamples = 0;
        // 句首保留 preRollMs，绝不截断唤醒词或辅音起音
        this._sliceStartSample = Math.max(
          0,
          this._totalSamples - this._frameSamples - this._preRollSamples,
        );
      } else if (this._sliceStartSample === null) {
        this._sliceStartSample = Math.max(0, this._totalSamples - this._frameSamples);
      }
      this._speechAccumSamples += this._frameSamples;
      if (!this._speaking) {
        this._speaking = true;
        this._onSpeechActivity?.(true);
      }
    } else if (this._inUtterance) {
      this._consecutiveSilenceMs += this.config.frameSizeMs;
    }

    if (!this._inUtterance || this._sliceStartSample === null) {
      return null;
    }

    const sliceLen = this._totalSamples - this._sliceStartSample;

    // 触发规则 1（优先）：静音触发（检测到人声后的静音停顿 >= 250ms–300ms）
    if (!isVoice && this._consecutiveSilenceMs >= this.config.silenceTriggerMs) {
      if (this._speechAccumSamples < this._minSpeechSamples && this._utteranceSliceIndex === 0) {
        // 极短瞬态杂音（< minSpeechMs），直接丢弃
        this._clearUtteranceState();
        return null;
      }
      const chunk = this._buildChunk(this._sliceStartSample, this._totalSamples, "silence", true);
      this._clearUtteranceState();
      return chunk;
    }

    // 触发规则 2（兜底）：超时强制触发（连续讲话不停顿达到上限 2.0s 时强制切分）
    if (sliceLen >= this._maxChunkSamples) {
      const chunk = this._buildChunk(this._sliceStartSample, this._totalSamples, "timeout", false);
      this._utteranceSliceIndex += 1;
      this._prevSliceForcedTimeout = true;
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
