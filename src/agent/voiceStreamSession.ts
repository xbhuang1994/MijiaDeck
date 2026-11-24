// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * 服务端连续实时音频流会话（抗强噪与背景音乐播放核心管线）：
 *
 * 彻底解决传统浏览器端 RMS 门限 VAD 在背景音乐/嘈杂环境下的两大死穴：
 * 1. 音乐拉高浏览器噪声底噪导致门限飙升、人声被静音吞掉；
 * 2. 持续音乐无 750ms 静音间隙导致录音卡死 15 秒才上报。
 *
 * 工作流：
 * Browser AudioWorklet (128ms 16kHz Int16 PCM 二进制帧 via /ws)
 *   -> Track A: 原始 16kHz 高通环形缓冲（保留完整爆破音与数字，零降噪伪影）
 *   -> Track B: OnlineSpeechDenoiser (GTCRN / DPDFNet4 / VoxLock) -> 流式 Silero VAD (maxSpeech=4.2s)
 *   -> 命中语音段（或在持续歌声下触发 4.2s 滚动窗口 + 1.2s 尾部重叠防截断）
 *   -> 双轨 SenseVoice 融合识别 + 3D-Speaker 声纹 + 抗歌词唤醒词注意力门控 -> Pi Agent
 */

import { estimateSnrDb, resampleLinear } from "./audioPcm.ts";
import type {
  LocalVoiceEngine,
  OnlineDenoiserHandleLike,
  StreamingVadHandleLike,
} from "./localVoiceEngine.ts";
import type { OpenWakeWordStreamSession, WakeWordAcousticHit } from "./openWakeWordEngine.ts";
import type { ProcessAudioUploadResult } from "./voiceListenerController.ts";

export interface VoiceStreamSegmentPayload {
  rawSamples: Float32Array;
  denoisedSamples: Float32Array;
  denoiseEngine: string;
  inputSnrDb: number;
  outputSnrDb: number;
  snrGainDb: number;
  startSec: number;
  durationSec: number;
  forcedRoll: boolean;
  acousticWake?: WakeWordAcousticHit | null;
}

export interface VoiceStreamSessionOptions {
  localEngine: LocalVoiceEngine;
  noiseMode: "auto" | "neural" | "dpdfnet" | "voxlock" | "dsp" | "off";
  vadThreshold?: number;
  vadSilenceMs?: number;
  sampleRate?: number;
  bypassWakeWord?: boolean;
  lang?: string;
  engine?: "auto" | "local" | "whisper";
  wakeWords?: readonly string[];
  owwEnabled?: boolean;
  owwThreshold?: number;
  onWakeWordSpot?: (hit: WakeWordAcousticHit) => void;
  onSpeechActivity?: (speaking: boolean) => void;
  onSegmentReady: (
    seg: VoiceStreamSegmentPayload,
  ) => Promise<ProcessAudioUploadResult | null>;
}

const TARGET_SR = 16000;
const RAW_RING_CAPACITY = TARGET_SR * 20; // 20 秒对齐环形缓冲
const PRE_ROLL_SAMPLES = Math.round(TARGET_SR * 0.35);
const POST_ROLL_SAMPLES = Math.round(TARGET_SR * 0.18);
const ROLLING_OVERLAP_SAMPLES = Math.round(TARGET_SR * 1.2); // 持续音乐强制切窗时保留 1.2s 重叠防止切半个唤醒词

/**
 * 将浏览器发送的 Little-Endian Int16 PCM 二进制帧解码为 Float32Array（[-1, 1]）。
 */
export function decodeInt16PcmBuffer(bytes: Uint8Array): Float32Array {
  const count = Math.floor(bytes.byteLength / 2);
  const out = new Float32Array(count);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < count; i += 1) {
    out[i] = view.getInt16(i * 2, true) / 32768;
  }
  return out;
}

export class VoiceStreamSession {
  private readonly _opts: VoiceStreamSessionOptions;
  private readonly _inputRate: number;
  private readonly _onlineDenoiser: OnlineDenoiserHandleLike | null;
  private readonly _denoiseEngine: string;
  private readonly _vad: StreamingVadHandleLike | null;
  private _oww: OpenWakeWordStreamSession | null;
  private _wakeWords: string[];
  private _owwThreshold: number | undefined;

  // 单调递增样本索引 + 环形原始音频缓存（用于按 Silero VAD 精确起止位置反取零伪影原始人声）
  private readonly _rawRing = new Float32Array(RAW_RING_CAPACITY);
  private _rawTotalSamples = 0;
  private _denoisedPending = new Float32Array(0);
  private _vadDetected = false;
  private _activeSpeechStartSample: number | null = null;
  private _lastRawOverlap = new Float32Array(0);
  private _lastDenOverlap = new Float32Array(0);

  // 无 Silero VAD 时的纯 TS 兜底窗口缓冲
  private _fallbackChunks: Float32Array[] = [];
  private _fallbackTotal = 0;

  // 串行处理队列：音频采集绝不阻塞，识别结果按序进入注意力门控与 Pi Agent
  private _queue: Promise<void> = Promise.resolve();
  private _disposed = false;

  constructor(options: VoiceStreamSessionOptions) {
    this._opts = options;
    this._inputRate = options.sampleRate ?? TARGET_SR;
    this._wakeWords = [...(options.wakeWords ?? [])];
    this._owwThreshold = options.owwThreshold;

    const online = options.localEngine.createOnlineDenoiser(options.noiseMode);
    this._onlineDenoiser = online?.denoiser ?? null;
    this._denoiseEngine = online?.engine ?? (options.noiseMode === "off" ? "off" : "dsp");

    const minSilenceSec = Math.max(0.35, Math.min(0.85, (options.vadSilenceMs ?? 600) / 1000));
    this._vad = options.localEngine.createStreamingVad({
      threshold: options.vadThreshold ?? 0.4,
      minSilenceDuration: minSilenceSec,
      minSpeechDuration: 0.18,
      maxSpeechDuration: 4.2,
    });

    this._oww =
      options.owwEnabled !== false
        ? options.localEngine.createWakeWordStream(this._wakeWords, {
            threshold: this._owwThreshold,
            onSpot: options.onWakeWordSpot,
          })
        : null;
  }

  /**
   * 热刷新实时流式会话的唤醒词原型与阈值（配置更新或新录制样本后立即生效，无需重连 WebSocket）。
   */
  reloadWakeWords(wakeWords: readonly string[], threshold?: number): void {
    if (this._disposed) return;
    this._wakeWords = [...wakeWords];
    const thresholdChanged = threshold !== undefined && threshold !== this._owwThreshold;
    if (threshold !== undefined) {
      this._owwThreshold = threshold;
    }
    if (this._opts.owwEnabled === false) {
      this._oww = null;
      return;
    }
    if (!this._oww || thresholdChanged) {
      this._oww = this._opts.localEngine.createWakeWordStream(this._wakeWords, {
        threshold: this._owwThreshold,
        onSpot: this._opts.onWakeWordSpot,
      });
      return;
    }
    this._oww.reloadPrototypes(this._wakeWords);
  }

  get bypassWakeWord(): boolean {
    return Boolean(this._opts.bypassWakeWord);
  }

  get lang(): string {
    return this._opts.lang || "zh-CN";
  }

  get engine(): "auto" | "local" | "whisper" {
    return this._opts.engine ?? "auto";
  }

  get denoiseEngine(): string {
    return this._denoiseEngine;
  }

  /**
   * 写入一帧来自浏览器 AudioWorklet 的 Int16 PCM 二进制数据（通常 128ms = 4096 字节）。
   */
  pushInt16Frame(bytes: Uint8Array): void {
    if (this._disposed || bytes.byteLength < 2) return;
    const f32 = decodeInt16PcmBuffer(bytes);
    this.pushFloat32Samples(f32);
  }

  /**
   * 写入 Float32 PCM 样本并实时驱动在线降噪 + 流式 Silero VAD。
   */
  pushFloat32Samples(samples: Float32Array): void {
    if (this._disposed || samples.length === 0) return;
    const pcm16k =
      this._inputRate === TARGET_SR ? samples : resampleLinear(samples, this._inputRate, TARGET_SR);

    // 1. 写入时间对齐的 Raw 环形缓冲
    for (let i = 0; i < pcm16k.length; i += 1) {
      this._rawRing[(this._rawTotalSamples + i) % RAW_RING_CAPACITY] = pcm16k[i]!;
    }
    this._rawTotalSamples += pcm16k.length;

    // 2. 实时在线神经降噪（在进 Silero VAD 之前先剥离稳态噪声与音乐伴奏！）
    let denoisedChunk: Float32Array;
    if (this._onlineDenoiser) {
      try {
        const res = this._onlineDenoiser.run({ samples: pcm16k, sampleRate: TARGET_SR });
        denoisedChunk =
          res.sampleRate === TARGET_SR
            ? res.samples
            : resampleLinear(res.samples, res.sampleRate, TARGET_SR);
      } catch {
        denoisedChunk = pcm16k;
      }
    } else {
      denoisedChunk = pcm16k;
    }

    // 2.5 实时流式 openWakeWord 声学唤醒检测（80ms 步进，静音自动快路径跳过）
    if (this._oww) {
      try {
        this._oww.pushSamples(denoisedChunk, this._rawTotalSamples);
      } catch {
        // 声学检测异常不得中断主音频流
      }
    }

    // 3. 送入流式 Silero VAD（512 采样窗口 = 32ms）
    if (this._vad) {
      const merged = new Float32Array(this._denoisedPending.length + denoisedChunk.length);
      merged.set(this._denoisedPending, 0);
      merged.set(denoisedChunk, this._denoisedPending.length);

      let offset = 0;
      while (offset + 512 <= merged.length) {
        this._vad.acceptWaveform(merged.subarray(offset, offset + 512));
        offset += 512;
      }
      this._denoisedPending = merged.subarray(offset);

      const nowDetected = this._vad.isDetected();
      if (nowDetected !== this._vadDetected) {
        this._vadDetected = nowDetected;
        if (nowDetected) {
          this._activeSpeechStartSample = this._rawTotalSamples;
        } else {
          this._activeSpeechStartSample = null;
        }
        this._opts.onSpeechActivity?.(nowDetected);
      }

      this._drainVadSegments(false);
    } else {
      // 无 Silero VAD 模型时按 3.5 秒滚动窗口处理
      this._fallbackChunks.push(pcm16k);
      this._fallbackTotal += pcm16k.length;
      if (this._fallbackTotal >= TARGET_SR * 3.5) {
        this._flushFallbackBuffer();
      }
    }
  }

  /**
   * 主动冲刷当前挂起尾音（用于单次说话松开/停止监听时立刻出结果）。
   */
  async flush(): Promise<void> {
    if (this._disposed) return;
    if (this._onlineDenoiser) {
      try {
        const tail = this._onlineDenoiser.flush();
        if (tail.samples.length > 0) {
          if (this._oww) {
            try {
              this._oww.pushSamples(tail.samples, this._rawTotalSamples);
            } catch {
              // ignore
            }
          }
          if (this._vad) {
            const merged = new Float32Array(this._denoisedPending.length + tail.samples.length);
            merged.set(this._denoisedPending, 0);
            merged.set(tail.samples, this._denoisedPending.length);
            let off = 0;
            while (off + 512 <= merged.length) {
              this._vad.acceptWaveform(merged.subarray(off, off + 512));
              off += 512;
            }
            this._denoisedPending = new Float32Array(0);
          }
        }
      } catch {
        // ignore
      }
    }
    if (this._vad) {
      this._vad.flush();
      this._drainVadSegments(true);
    } else if (this._fallbackTotal >= TARGET_SR * 0.4) {
      this._flushFallbackBuffer();
    }
    await this._queue;
  }

  private _readRawRange(startSample: number, endSample: number): Float32Array {
    const earliestAvailable = Math.max(0, this._rawTotalSamples - RAW_RING_CAPACITY);
    const clampedStart = Math.max(earliestAvailable, Math.min(this._rawTotalSamples, startSample));
    const clampedEnd = Math.max(clampedStart, Math.min(this._rawTotalSamples, endSample));
    const len = clampedEnd - clampedStart;
    const out = new Float32Array(len);
    for (let i = 0; i < len; i += 1) {
      out[i] = this._rawRing[(clampedStart + i) % RAW_RING_CAPACITY]!;
    }
    return out;
  }

  private _drainVadSegments(isManualFlush: boolean): void {
    if (!this._vad) return;

    while (!this._vad.isEmpty()) {
      const seg = this._vad.front();
      this._vad.pop();
      if (!seg || !seg.samples || seg.samples.length < TARGET_SR * 0.18) {
        continue;
      }

      const rawStart = Math.max(0, seg.start - PRE_ROLL_SAMPLES);
      const rawEnd = Math.min(this._rawTotalSamples, seg.start + seg.samples.length + POST_ROLL_SAMPLES);
      let rawSlice = this._readRawRange(rawStart, rawEnd);
      let denSlice = new Float32Array(seg.samples);

      // 判断是否为持续音乐/歌声导致的强制 maxSpeechDuration 切段
      const forcedRoll = !isManualFlush && seg.samples.length >= TARGET_SR * 4.0;

      // 若上一段是持续音乐强制切段，拼接上一段末尾 1.2s 重叠防止唤醒词被切两半
      if (this._lastRawOverlap.length > 0) {
        const joinedRaw = new Float32Array(this._lastRawOverlap.length + rawSlice.length);
        joinedRaw.set(this._lastRawOverlap, 0);
        joinedRaw.set(rawSlice, this._lastRawOverlap.length);
        rawSlice = joinedRaw;

        const joinedDen = new Float32Array(this._lastDenOverlap.length + denSlice.length);
        joinedDen.set(this._lastDenOverlap, 0);
        joinedDen.set(denSlice, this._lastDenOverlap.length);
        denSlice = joinedDen;
      }

      if (forcedRoll) {
        const rawTailLen = Math.min(ROLLING_OVERLAP_SAMPLES, rawSlice.length);
        const denTailLen = Math.min(ROLLING_OVERLAP_SAMPLES, denSlice.length);
        this._lastRawOverlap = rawSlice.slice(rawSlice.length - rawTailLen);
        this._lastDenOverlap = denSlice.slice(denSlice.length - denTailLen);
      } else {
        this._lastRawOverlap = new Float32Array(0);
        this._lastDenOverlap = new Float32Array(0);
      }

      const acousticWake = this._oww?.getHeadPeakHit(22) ?? this._oww?.getPeakHit() ?? null;
      this._oww?.resetSegmentTracking();

      const inputSnrDb = estimateSnrDb(rawSlice, TARGET_SR);
      const outputSnrDb = estimateSnrDb(denSlice, TARGET_SR);
      const payload: VoiceStreamSegmentPayload = {
        rawSamples: rawSlice,
        denoisedSamples: denSlice,
        denoiseEngine: this._denoiseEngine,
        inputSnrDb,
        outputSnrDb,
        snrGainDb: Number((outputSnrDb - inputSnrDb).toFixed(2)),
        startSec: Number((seg.start / TARGET_SR).toFixed(2)),
        durationSec: Number((rawSlice.length / TARGET_SR).toFixed(2)),
        forcedRoll,
        acousticWake,
      };

      this._enqueueSegment(payload);
    }
  }

  private _flushFallbackBuffer(): void {
    const merged = new Float32Array(this._fallbackTotal);
    let off = 0;
    for (const c of this._fallbackChunks) {
      merged.set(c, off);
      off += c.length;
    }
    this._fallbackChunks = [];
    this._fallbackTotal = 0;

    const acousticWake = this._oww?.getHeadPeakHit(22) ?? this._oww?.getPeakHit() ?? null;
    this._oww?.resetSegmentTracking();

    const denoised = this._opts.localEngine.denoise(merged, TARGET_SR, this._opts.noiseMode);
    this._enqueueSegment({
      rawSamples: merged,
      denoisedSamples: denoised.samples,
      denoiseEngine: denoised.engine,
      inputSnrDb: denoised.inputSnrDb,
      outputSnrDb: denoised.outputSnrDb,
      snrGainDb: denoised.snrGainDb,
      startSec: 0,
      durationSec: Number((merged.length / TARGET_SR).toFixed(2)),
      forcedRoll: false,
      acousticWake,
    });
  }

  private _enqueueSegment(payload: VoiceStreamSegmentPayload): void {
    this._queue = this._queue
      .then(async () => {
        if (this._disposed) return;
        await this._opts.onSegmentReady(payload);
      })
      .catch(() => {
        // 单个音频分段异常不中断连续流会话
      });
  }

  async waitForIdle(): Promise<void> {
    await this._queue;
  }

  dispose(): void {
    this._disposed = true;
    try {
      this._vad?.clear();
    } catch {
      // ignore
    }
    try {
      this._oww?.reset();
    } catch {
      // ignore
    }
    this._oww = null;
    this._fallbackChunks = [];
    this._fallbackTotal = 0;
    this._lastRawOverlap = new Float32Array(0);
    this._lastDenOverlap = new Float32Array(0);
  }
}
