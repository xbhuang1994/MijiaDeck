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

import type { VadSensitivityMode } from "../core/agentConfigStore.ts";
import { computeRms, estimateSnrDb, resampleLinear } from "./audioPcm.ts";
import type {
  LocalVoiceEngine,
  OnlineDenoiserHandleLike,
  StreamingVadHandleLike,
} from "./localVoiceEngine.ts";
import type { OpenWakeWordStreamSession, WakeWordAcousticHit } from "./openWakeWordEngine.ts";
import {
  StreamingAutoGain,
  vadSensitivityToSeconds,
  VoiceCommandSegmenter,
  WakeWordCooldownGuard,
} from "./voiceCommandSegmenter.ts";
import type { ProcessAudioUploadResult } from "./voiceListenerController.ts";
import { listVoiceprintRefWavPaths } from "./voiceprintStore.ts";

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
  /** 是否由流式 openWakeWord 锚定并由滞回分段器极速截断 */
  wakeAnchored?: boolean;
}

export interface VoiceStreamSessionOptions {
  localEngine: LocalVoiceEngine;
  noiseMode: "auto" | "neural" | "dpdfnet" | "voxlock" | "dsp" | "off";
  vadThreshold?: number;
  vadSilenceMs?: number;
  vadSensitivity?: VadSensitivityMode;
  sampleRate?: number;
  bypassWakeWord?: boolean;
  isInConversation?: () => boolean;
  autoGainEnabled?: boolean;
  wakeWordCooldownMs?: number;
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
const PRE_ROLL_SAMPLES = Math.round(TARGET_SR * 0.32);
const POST_ROLL_SAMPLES = Math.round(TARGET_SR * 0.16);
const ROLLING_OVERLAP_SAMPLES = Math.round(TARGET_SR * 1.0); // 持续音乐强制切窗时保留 1.0s 重叠防止切半个唤醒词
const MAX_SPEECH_SEC = 3.8;

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
  private readonly _segmenter: VoiceCommandSegmenter;
  private readonly _agc: StreamingAutoGain | null;
  private readonly _cooldownGuard: WakeWordCooldownGuard;
  private _oww: OpenWakeWordStreamSession | null;
  private _wakeWords: string[];
  private _owwThreshold: number | undefined;

  // 双轨时间对齐环形缓冲（Raw + Denoised 同步保留 20 秒，支撑唤醒词锚定极速切段与零重复降噪）
  private readonly _rawRing = new Float32Array(RAW_RING_CAPACITY);
  private readonly _denRing = new Float32Array(RAW_RING_CAPACITY);
  private _rawTotalSamples = 0;
  private _denTotalSamples = 0;
  private _denoisedPending = new Float32Array(0);
  private _vadDetected = false;
  private _lastFrameRms = 0;
  private _activeSegmentStartSample: number | null = null;
  private _wakeAnchorSample: number | null = null;
  private _wakeAnchorHit: WakeWordAcousticHit | null = null;
  private _lastRawOverlap = new Float32Array(0);
  private _lastDenOverlap = new Float32Array(0);
  private _lastMatchedEndSec = -1;

  // 无 Silero VAD 时的纯 TS 兜底窗口缓冲
  private _fallbackChunks: Float32Array[] = [];
  private _fallbackTotal = 0;

  // 有界反压串行处理队列：优先保障唤醒锚定段，非唤醒队列最多保留最新 2 段防持续音乐下队列雪崩
  private _inFlight = false;
  private _pendingWake: VoiceStreamSegmentPayload[] = [];
  private _pendingNormalQueue: VoiceStreamSegmentPayload[] = [];
  private _droppedStaleCount = 0;
  private _droppedPureMusicCount = 0;
  private _idleResolvers: Array<() => void> = [];
  private _disposed = false;

  constructor(options: VoiceStreamSessionOptions) {
    this._opts = options;
    this._inputRate = options.sampleRate ?? TARGET_SR;
    this._wakeWords = [...(options.wakeWords ?? [])];
    this._owwThreshold = options.owwThreshold;

    const online = options.localEngine.createOnlineDenoiser(options.noiseMode);
    this._onlineDenoiser = online?.denoiser ?? null;
    this._denoiseEngine = online?.engine ?? (options.noiseMode === "off" ? "off" : "dsp");

    const minSilenceSec = vadSensitivityToSeconds(options.vadSensitivity, options.vadSilenceMs);
    this._segmenter = new VoiceCommandSegmenter({
      silenceSeconds: minSilenceSec,
      timeoutSeconds: MAX_SPEECH_SEC,
      resetSeconds: 0.24,
    });
    this._agc =
      options.autoGainEnabled !== false
        ? new StreamingAutoGain({ targetRms: 0.085, maxGain: 3.5, minActiveRms: 0.0045 })
        : null;
    this._cooldownGuard = new WakeWordCooldownGuard(options.wakeWordCooldownMs ?? 1800);

    this._vad = options.localEngine.createStreamingVad({
      threshold: options.vadThreshold ?? 0.4,
      minSilenceDuration: minSilenceSec,
      minSpeechDuration: 0.16,
      maxSpeechDuration: MAX_SPEECH_SEC,
    });

    this._oww =
      options.owwEnabled !== false
        ? options.localEngine.createWakeWordStream(this._wakeWords, {
            threshold: this._owwThreshold,
            onSpot: (hit) => this._handleWakeSpot(hit),
          })
        : null;
  }

  private _handleWakeSpot(hit: WakeWordAcousticHit): void {
    if (this._disposed) return;
    if (!this._cooldownGuard.tryAccept(hit.wakeWord, Date.now())) {
      return;
    }
    this._opts.onWakeWordSpot?.(hit);

    // 借鉴 Home Assistant WAKE_WORD -> STT 切换：
    // 命中声学唤醒词后立即锁定唤醒词起止位置并激活滞回指令分段器，
    // 即便背景音乐持续播放，说完指令停顿 ~550ms 即可立即截断送识别，无需苦等 4 秒滚窗！
    if (!this._opts.bypassWakeWord && this._wakeAnchorSample === null) {
      const anchorEnd = hit.sampleOffset > 0 ? hit.sampleOffset : this._rawTotalSamples;
      this._wakeAnchorSample = Math.max(0, anchorEnd - Math.round(TARGET_SR * 0.85));
      this._wakeAnchorHit = hit;
      this._lastRawOverlap = new Float32Array(0);
      this._lastDenOverlap = new Float32Array(0);
      this._segmenter.forceStartCommand(Math.max(this._lastFrameRms, 0.05));
    }
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
        onSpot: (hit) => this._handleWakeSpot(hit),
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

  get droppedStaleCount(): number {
    return this._droppedStaleCount;
  }

  get droppedPureMusicCount(): number {
    return this._droppedPureMusicCount;
  }

  /**
   * 写入一帧来自浏览器 AudioWorklet 的 Int16 PCM 二进制数据（64ms = 2048 字节）。
   */
  pushInt16Frame(bytes: Uint8Array): void {
    if (this._disposed || bytes.byteLength < 2) return;
    const f32 = decodeInt16PcmBuffer(bytes);
    this.pushFloat32Samples(f32);
  }

  /**
   * 写入 Float32 PCM 样本并实时驱动软限幅 AGC + 在线降噪 + 流式 openWakeWord + Silero 滞回 VAD。
   */
  pushFloat32Samples(samples: Float32Array): void {
    if (this._disposed || samples.length === 0) return;
    const pcm16k =
      this._inputRate === TARGET_SR ? samples : resampleLinear(samples, this._inputRate, TARGET_SR);

    // 1. 写入时间对齐的原始 Raw 环形缓冲（零失真）
    for (let i = 0; i < pcm16k.length; i += 1) {
      this._rawRing[(this._rawTotalSamples + i) % RAW_RING_CAPACITY] = pcm16k[i]!;
    }
    this._rawTotalSamples += pcm16k.length;

    // 1.5 软限幅流式 AGC（拉升远场轻声语音，对高电平音乐保持线性不削波）
    const enhancedInput = this._agc ? this._agc.process(pcm16k) : pcm16k;

    // 2. 实时在线神经降噪（1 线程 GTCRN，延迟低且不与 ASR 争抢多核）
    let denoisedChunk: Float32Array;
    if (this._onlineDenoiser) {
      try {
        const res = this._onlineDenoiser.run({ samples: enhancedInput, sampleRate: TARGET_SR });
        denoisedChunk =
          res.sampleRate === TARGET_SR
            ? res.samples
            : resampleLinear(res.samples, res.sampleRate, TARGET_SR);
      } catch {
        denoisedChunk = enhancedInput;
      }
    } else {
      denoisedChunk = enhancedInput;
    }

    // 2.2 写入同步降噪环形缓冲（供唤醒锚定与预降噪复用）
    for (let i = 0; i < denoisedChunk.length; i += 1) {
      this._denRing[(this._denTotalSamples + i) % RAW_RING_CAPACITY] = denoisedChunk[i]!;
    }
    this._denTotalSamples += denoisedChunk.length;

    // 2.5 实时流式 openWakeWord 声学唤醒检测（80ms 步进，静音自动快路径跳过）
    if (this._oww) {
      try {
        this._oww.pushSamples(denoisedChunk, this._rawTotalSamples);
      } catch {
        // 声学检测异常不得中断主音频流
      }
    }

    // 3. 送入流式 Silero VAD + Home Assistant 风格滞回指令分段器（512 采样窗口 = 32ms）
    if (this._vad) {
      const merged = new Float32Array(this._denoisedPending.length + denoisedChunk.length);
      merged.set(this._denoisedPending, 0);
      merged.set(denoisedChunk, this._denoisedPending.length);

      let offset = 0;
      while (offset + 512 <= merged.length) {
        const frame = merged.subarray(offset, offset + 512);
        const frameRms = computeRms(frame);
        this._lastFrameRms = frameRms;
        this._vad.acceptWaveform(frame);
        const nowDetected = this._vad.isDetected();

        if (nowDetected !== this._vadDetected) {
          this._vadDetected = nowDetected;
          this._opts.onSpeechActivity?.(nowDetected);
        }

        // 0.72 既高于常规 inCommandThreshold(0.48)，又低于高音乐底噪回落门限(0.78)，
        // 从而让前景说话结束回落到背景音乐电平时立即推进尾静音倒计时，并严格保证 3.8s 硬上限绝不堆出 7s+ 巨段！
        const step = this._segmenter.process(512 / TARGET_SR, nowDetected ? 0.72 : 0.05, frameRms);
        if (step.justStarted && this._activeSegmentStartSample === null) {
          // 回溯 speechSeconds(~0.2s) 避免切掉开声首字
          this._activeSegmentStartSample = Math.max(
            0,
            this._rawTotalSamples - Math.round(TARGET_SR * this._segmenter.speechSeconds),
          );
        }

        if (!step.continuing) {
          if (this._wakeAnchorSample !== null) {
            this._emitWakeAnchoredSegment(step.timedOut);
          } else if (this._activeSegmentStartSample !== null) {
            const activeLen = this._rawTotalSamples - this._activeSegmentStartSample;
            // 仅在超时(3.8s硬上限，防 Silero 堆积 7s+ 巨段)或高背景音乐中前景长语音回落(>=1.8s)时主动接管切段；
            // 普通安静环境交由 Silero VAD 自然切段，避免音乐节拍起伏被误切为碎段
            if (step.timedOut || (activeLen >= TARGET_SR * 1.8 && this._segmenter.ambientRmsFloor >= 0.015)) {
              this._emitSegmenterWindow(step.timedOut);
            } else {
              this._activeSegmentStartSample = null;
            }
          }
        }

        offset += 512;
      }
      this._denoisedPending = merged.subarray(offset);

      if (this._wakeAnchorSample === null) {
        this._drainVadSegments(false);
      } else {
        // 唤醒词锚定捕获期间抑制 Silero 提前产出半截段，等待完整指令结束统一发包
        while (!this._vad.isEmpty()) {
          this._vad.pop();
        }
      }
    } else {
      // 无 Silero VAD 模型时按 3.2 秒滚动窗口处理
      this._fallbackChunks.push(pcm16k);
      this._fallbackTotal += pcm16k.length;
      if (this._fallbackTotal >= TARGET_SR * 3.2) {
        this._flushFallbackBuffer();
      }
    }
  }

  private _emitWakeAnchoredSegment(timedOut: boolean): void {
    const anchor = this._wakeAnchorSample;
    const anchorHit = this._wakeAnchorHit;
    this._wakeAnchorSample = null;
    this._wakeAnchorHit = null;
    this._activeSegmentStartSample = null;
    this._segmenter.reset();

    if (anchor === null) return;

    const rawStart = Math.max(0, anchor - PRE_ROLL_SAMPLES);
    const rawEnd = this._rawTotalSamples;
    const sliceLen = rawEnd - rawStart;
    if (sliceLen < TARGET_SR * 0.25) return;

    const rawSlice = this._readRingRange(this._rawRing, this._rawTotalSamples, rawStart, rawEnd);
    const denSlice = this._readRingTail(this._denRing, this._denTotalSamples, rawSlice.length);

    try {
      this._vad?.clear();
    } catch {
      // ignore
    }
    this._oww?.resetSegmentTracking();
    this._lastRawOverlap = new Float32Array(0);
    this._lastDenOverlap = new Float32Array(0);

    const inputSnrDb = estimateSnrDb(rawSlice, TARGET_SR);
    const outputSnrDb = estimateSnrDb(denSlice, TARGET_SR);
    this._enqueueSegment({
      rawSamples: rawSlice,
      denoisedSamples: denSlice,
      denoiseEngine: this._denoiseEngine,
      inputSnrDb,
      outputSnrDb,
      snrGainDb: Number((outputSnrDb - inputSnrDb).toFixed(2)),
      startSec: Number((rawStart / TARGET_SR).toFixed(2)),
      durationSec: Number((rawSlice.length / TARGET_SR).toFixed(2)),
      forcedRoll: timedOut,
      acousticWake: anchorHit,
      wakeAnchored: true,
    });
  }

  /**
   * 由 Home Assistant 滞回分段器驱动的切段（解决持续背景音乐下 Silero VAD 忽略 maxSpeechDuration 堆积 7s+ 长段的问题）。
   */
  private _emitSegmenterWindow(timedOut: boolean): void {
    const segStart = this._activeSegmentStartSample;
    this._activeSegmentStartSample = null;
    if (segStart === null) return;

    const rawStart = Math.max(0, segStart - PRE_ROLL_SAMPLES);
    const rawEnd = this._rawTotalSamples;
    if (rawEnd - rawStart < TARGET_SR * 0.22) return;

    let rawSlice = this._readRingRange(this._rawRing, this._rawTotalSamples, rawStart, rawEnd);
    let denSlice = this._readRingTail(this._denRing, this._denTotalSamples, rawSlice.length);

    try {
      this._vad?.clear();
    } catch {
      // ignore
    }

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

    if (timedOut) {
      const rawTailLen = Math.min(ROLLING_OVERLAP_SAMPLES, rawSlice.length);
      const denTailLen = Math.min(ROLLING_OVERLAP_SAMPLES, denSlice.length);
      this._lastRawOverlap = rawSlice.slice(rawSlice.length - rawTailLen);
      this._lastDenOverlap = denSlice.slice(denSlice.length - denTailLen);
    } else {
      this._lastRawOverlap = new Float32Array(0);
      this._lastDenOverlap = new Float32Array(0);
    }

    const durationSec = Number((rawSlice.length / TARGET_SR).toFixed(2));
    const acousticWake = this._resolveBestOwwHit(timedOut, durationSec);
    this._oww?.resetSegmentTracking();

    if (this._shouldDropStandbyPureMusic(rawSlice, timedOut, acousticWake)) {
      this._droppedPureMusicCount += 1;
      return;
    }

    const inputSnrDb = estimateSnrDb(rawSlice, TARGET_SR);
    const outputSnrDb = estimateSnrDb(denSlice, TARGET_SR);
    this._enqueueSegment({
      rawSamples: rawSlice,
      denoisedSamples: denSlice,
      denoiseEngine: this._denoiseEngine,
      inputSnrDb,
      outputSnrDb,
      snrGainDb: Number((outputSnrDb - inputSnrDb).toFixed(2)),
      startSec: Number((rawStart / TARGET_SR).toFixed(2)),
      durationSec,
      forcedRoll: timedOut,
      acousticWake,
      wakeAnchored: false,
    });
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
          for (let i = 0; i < tail.samples.length; i += 1) {
            this._denRing[(this._denTotalSamples + i) % RAW_RING_CAPACITY] = tail.samples[i]!;
          }
          this._denTotalSamples += tail.samples.length;
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
    if (this._wakeAnchorSample !== null) {
      this._emitWakeAnchoredSegment(false);
    } else if (this._vad) {
      this._vad.flush();
      this._drainVadSegments(true);
    } else if (this._fallbackTotal >= TARGET_SR * 0.4) {
      this._flushFallbackBuffer();
    }
    await this.waitForIdle();
  }

  private _readRingRange(
    ring: Float32Array,
    totalSamples: number,
    startSample: number,
    endSample: number,
  ): Float32Array {
    const earliestAvailable = Math.max(0, totalSamples - RAW_RING_CAPACITY);
    const clampedStart = Math.max(earliestAvailable, Math.min(totalSamples, startSample));
    const clampedEnd = Math.max(clampedStart, Math.min(totalSamples, endSample));
    const len = clampedEnd - clampedStart;
    const out = new Float32Array(len);
    for (let i = 0; i < len; i += 1) {
      out[i] = ring[(clampedStart + i) % RAW_RING_CAPACITY]!;
    }
    return out;
  }

  private _readRingTail(ring: Float32Array, totalSamples: number, desiredLen: number): Float32Array {
    const len = Math.min(desiredLen, Math.min(totalSamples, RAW_RING_CAPACITY));
    const start = Math.max(0, totalSamples - len);
    return this._readRingRange(ring, totalSamples, start, totalSamples);
  }

  private _resolveBestOwwHit(forcedRoll: boolean, durationSec: number): WakeWordAcousticHit | null {
    if (!this._oww) return null;
    const headHit = this._oww.getHeadPeakHit(22);
    const fullHit = this._oww.getPeakHit();
    // 持续音乐滚动窗或长段中，唤醒词可能出现在窗口中后段，禁止仅看前 1.76s 漏掉句中唤醒！
    if (fullHit) {
      if (
        fullHit.matched ||
        forcedRoll ||
        durationSec > 2.2 ||
        !headHit ||
        fullHit.score > headHit.score + 0.04
      ) {
        return fullHit;
      }
    }
    return headHit ?? fullHit ?? null;
  }

  private _shouldDropStandbyPureMusic(
    rawSlice: Float32Array,
    forcedRoll: boolean,
    acousticWake: WakeWordAcousticHit | null,
  ): boolean {
    if (this._opts.bypassWakeWord) return false;
    if (this._opts.isInConversation?.()) return false;
    if (acousticWake && acousticWake.score >= 0.35) return false;
    // 仅在持续音乐滚动切段或背景底噪显著升高（持续放歌）时激活 15~65ms 纯歌曲快速过滤
    if (!forcedRoll && this._segmenter.ambientRmsFloor < 0.015) return false;

    const sep = this._opts.localEngine.sourceSeparator;
    const scene = sep.analyzeAudioScene(rawSlice, 12);
    if (scene.musicProb >= 0.62 && scene.speechProb < 0.08 && scene.singingProb >= 0.05) {
      if (this._inFlight && scene.speechProb < 0.05) {
        return true;
      }
      const ownerRefs = listVoiceprintRefWavPaths().map((r) => ({
        id: r.role === "owner" ? "owner" : r.id,
        wavPath: r.wavPath,
      }));
      if (ownerRefs.length === 0) {
        return true;
      }
      const presence = sep.checkRegisteredSpeakerPresence(rawSlice, ownerRefs, 0.36);
      return !presence.present;
    }
    return false;
  }

  private _drainVadSegments(isManualFlush: boolean): void {
    if (!this._vad) return;

    while (!this._vad.isEmpty()) {
      const seg = this._vad.front();
      this._vad.pop();
      if (!seg || !seg.samples || seg.samples.length < TARGET_SR * 0.16) {
        continue;
      }
      this._activeSegmentStartSample = null;
      this._segmenter.reset();

      const rawStart = Math.max(0, seg.start - PRE_ROLL_SAMPLES);
      const rawEnd = Math.min(this._rawTotalSamples, seg.start + seg.samples.length + POST_ROLL_SAMPLES);
      let rawSlice = this._readRingRange(this._rawRing, this._rawTotalSamples, rawStart, rawEnd);
      let denSlice = new Float32Array(seg.samples);

      // 判断是否为持续音乐/歌声导致的强制 maxSpeechDuration 切段
      const forcedRoll = !isManualFlush && seg.samples.length >= TARGET_SR * (MAX_SPEECH_SEC - 0.2);

      // 若上一段是持续音乐强制切段，拼接上一段末尾 1.0s 重叠防止唤醒词被切两半
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

      const durationSec = Number((rawSlice.length / TARGET_SR).toFixed(2));
      const acousticWake = this._resolveBestOwwHit(forcedRoll, durationSec);
      this._oww?.resetSegmentTracking();

      // 待机纯背景音乐快速过滤（15~65ms 放行零负担，彻底杜绝持续放歌时 CPU 跑满与识别队列雪崩）
      if (this._shouldDropStandbyPureMusic(rawSlice, forcedRoll, acousticWake)) {
        this._droppedPureMusicCount += 1;
        continue;
      }

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
        durationSec,
        forcedRoll,
        acousticWake,
        wakeAnchored: false,
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

    const durationSec = Number((merged.length / TARGET_SR).toFixed(2));
    const acousticWake = this._resolveBestOwwHit(false, durationSec);
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
      durationSec,
      forcedRoll: false,
      acousticWake,
      wakeAnchored: false,
    });
  }

  private _enqueueSegment(payload: VoiceStreamSegmentPayload): void {
    if (this._disposed) return;
    const isPriorityWake = Boolean(payload.wakeAnchored || payload.acousticWake?.matched);
    if (isPriorityWake) {
      if (this._pendingWake.length >= 2) {
        this._pendingWake.shift();
        this._droppedStaleCount += 1;
      }
      this._pendingWake.push(payload);
    } else {
      // 有界反压：非唤醒待处理队列最多保留最新 2 段，既不丢相邻语句又彻底防止持续背景音乐下队列无限积压！
      if (this._pendingNormalQueue.length >= 2) {
        this._pendingNormalQueue.shift();
        this._droppedStaleCount += 1;
      }
      this._pendingNormalQueue.push(payload);
    }
    this._pumpQueue();
  }

  private _pumpQueue(): void {
    if (this._inFlight || this._disposed) return;
    const next =
      this._pendingWake.length > 0
        ? this._pendingWake.shift()!
        : this._pendingNormalQueue.length > 0
          ? this._pendingNormalQueue.shift()!
          : null;

    if (!next) {
      const resolvers = this._idleResolvers;
      this._idleResolvers = [];
      for (const r of resolvers) r();
      return;
    }

    this._inFlight = true;
    void Promise.resolve()
      .then(async () => {
        if (this._disposed) return;
        // 若上一条刚成功命中并执行指令，跳过紧随其后的纯重叠残尾滚窗防止重复触发残缺指令
        if (
          !next.wakeAnchored &&
          next.forcedRoll &&
          this._lastMatchedEndSec >= 0 &&
          next.startSec < this._lastMatchedEndSec
        ) {
          this._droppedStaleCount += 1;
          return;
        }
        const res = await this._opts.onSegmentReady(next);
        if (res?.matched) {
          this._lastMatchedEndSec = next.startSec + next.durationSec;
          this._lastRawOverlap = new Float32Array(0);
          this._lastDenOverlap = new Float32Array(0);
        }
      })
      .catch(() => {
        // 单个音频分段异常不中断连续流会话
      })
      .finally(() => {
        this._inFlight = false;
        this._pumpQueue();
      });
  }

  async waitForIdle(): Promise<void> {
    if (!this._inFlight && this._pendingWake.length === 0 && this._pendingNormalQueue.length === 0) {
      return;
    }
    await new Promise<void>((resolve) => {
      this._idleResolvers.push(resolve);
    });
  }

  dispose(): void {
    this._disposed = true;
    this._pendingWake = [];
    this._pendingNormalQueue = [];
    this._wakeAnchorSample = null;
    this._wakeAnchorHit = null;
    this._activeSegmentStartSample = null;
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
    const resolvers = this._idleResolvers;
    this._idleResolvers = [];
    for (const r of resolvers) r();
  }
}
