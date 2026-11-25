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

import type { VadSensitivityMode, VoicePipelineMode } from "../core/agentConfigStore.ts";
import { computeRms, estimateSnrDb, resampleLinear } from "./audioPcm.ts";
import {
  ClearVoiceMultiTrackAssembler,
  ClearVoiceRealtimeChunker,
  type ClearVoiceChunkDescriptor,
  type ClearVoiceTriggerReason,
} from "./clearVoiceChunker.ts";
import type {
  LocalVoiceEngine,
  OnlineDenoiserHandleLike,
  StreamingVadHandleLike,
} from "./localVoiceEngine.ts";
import type { OpenWakeWordStreamSession, WakeWordAcousticHit } from "./openWakeWordEngine.ts";
import {
  joinUtteranceFragments,
  looksLikeIncompleteUtterance,
  Qwen3StreamingHypothesisTracker,
  splitStreamingSentences,
  stripCommittedPrefix,
  type StreamingCommitReason,
  type StreamingPartialUpdate,
} from "./qwen3StreamingTranscriber.ts";
import {
  StreamingAutoGain,
  vadSensitivityToSeconds,
  VoiceCommandSegmenter,
  WakeWordCooldownGuard,
} from "./voiceCommandSegmenter.ts";
import type { ProcessAudioUploadResult } from "./voiceListenerController.ts";
import { listVoiceprintRefWavPaths } from "./voiceprintStore.ts";

export interface VoiceStreamSeparatedTrack {
  trackId: string;
  trackIndex: number;
  sourceSlot: number;
  samples: Float32Array;
  sampleRate: number;
  rms: number;
  energyRatio: number;
  outputSnrDb: number;
  snrGainDb: number;
}

export interface VoiceStreamSegmentPayload {
  rawSamples: Float32Array;
  denoisedSamples: Float32Array;
  /** ClearVoice 盲源分离 + 分轨降噪去背景音产出的独立多轨音频（严禁混回单轨！） */
  separatedTracks?: VoiceStreamSeparatedTrack[];
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
  /** 流式转写开启时预计算的完整单句文本（干净环境可直接复用免二次解码） */
  precomputedTranscript?: string;
  /** 流式转写使用的 ASR 引擎标识 */
  precomputedAsrEngine?: string;
  /** 流式转写耗时（ms） */
  precomputedAsrMs?: number;
  /** 句中已通过流式断句提交的前缀，供完整重解码时去重防重复执行 */
  stripCommittedPrefixHint?: string;
  /** 流式智能断句触发原因 */
  commitReason?: StreamingCommitReason;
  /** 产出该分段的语音前端方案：legacy（原方案）或 clearvoice（新方案 GPU 盲源分离 + 分轨降噪） */
  pipelineMode?: VoicePipelineMode;
  /** ClearVoice 准实时切片与盲源分离元数据（切片数、20ms 交叉淡入淡出次数、轨数、PIT 换轨次数等） */
  clearVoiceMeta?: {
    sliceCount: number;
    crossfadeCount: number;
    triggerReason: ClearVoiceTriggerReason;
    denoiseMs: number;
    ssMs?: number;
    seMs?: number;
    trackCount?: number;
    bssUsed?: boolean;
    permutationSwaps?: number;
    gpuName?: string | null;
  };
  /** 该分段是否在 TTS 播报活跃期或刚结束尾窗内采集（供服务端回声防护增强判定） */
  duringTtsPlayback?: boolean;
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
  /** 是否启用 Qwen3-ASR 实时流式字幕转写（默认 false 保持非流式兼容，服务端按配置透传） */
  streamingAsrEnabled?: boolean;
  /** 是否在说话中途按标点/短停顿提前拆分为多条句子下发（默认 false：等整段话说完后再一起发给 Pi Agent） */
  streamingSentenceSplit?: boolean;
  /** 语音前端方案：legacy（原方案）或 clearvoice（新方案 ClearVoice GPU 准实时切片 -> Qwen3-ASR） */
  voicePipelineMode?: VoicePipelineMode;
  /** ClearVoice 切片参数覆写（默认 280ms 静音增量降噪切片 / 2000ms 超时切分 / 300ms 历史上下文 / 20ms 交叉淡入淡出） */
  clearVoiceSilenceMs?: number;
  /** ClearVoice 整句结束静音判停阈值（ms，默认继承 vadSilenceMs / vadSensitivity，绝不用 280ms 切片停顿提前断句） */
  clearVoiceUtteranceSilenceMs?: number;
  /** ClearVoice 单条连续话语安全上限（ms，默认 30000ms = 30s，保障慢语速长语音不被提前切段） */
  clearVoiceMaxUtteranceMs?: number;
  clearVoiceMaxChunkMs?: number;
  clearVoiceLookbackMs?: number;
  clearVoiceCrossfadeMs?: number;
  /** 长语音额外停顿宽限（ms，说话累计 >= 3.0s 后自动放宽句中停顿，默认 350ms） */
  longUtteranceExtraSilenceMs?: number;
  /** 语义未闭合额外停顿宽限（ms，如句中停在“然后/把客厅灯”等未说完处，默认 650ms） */
  incompleteGraceMs?: number;
  /** 实时流式字幕增量更新回调 */
  onPartialTranscript?: (ev: StreamingPartialUpdate) => void;
  /** 流式假设刷新最小新音频步进（ms，默认 GPU 360ms / CPU 850ms） */
  streamingPollIntervalMs?: number;
  /** 句末标点+短停顿快速断句静音阈值（ms，仅在显式开启 streamingSentenceSplit 时生效，默认 320ms） */
  streamingPunctuationPauseMs?: number;
  onWakeWordSpot?: (hit: WakeWordAcousticHit) => void;
  onSpeechActivity?: (speaking: boolean) => void;
  onSegmentReady: (
    seg: VoiceStreamSegmentPayload,
  ) => Promise<ProcessAudioUploadResult | null>;
}

interface HeldLegacySegment {
  payload: VoiceStreamSegmentPayload;
  rawStartSample: number;
  rawEndSample: number;
  holdSilenceSamples: number;
  accumulatedSilenceSamples: number;
  timer: ReturnType<typeof setTimeout> | null;
}

const TARGET_SR = 16000;
const RAW_RING_CAPACITY = TARGET_SR * 35; // 35 秒对齐环形缓冲（完整容纳 30s 慢语速长语音）
const PRE_ROLL_SAMPLES = Math.round(TARGET_SR * 0.32);
const POST_ROLL_SAMPLES = Math.round(TARGET_SR * 0.16);
const ROLLING_OVERLAP_SAMPLES = Math.round(TARGET_SR * 1.0); // 持续音乐强制切窗时保留 1.0s 重叠防止切半个唤醒词
const MAX_UTTERANCE_SEC = 30.0; // 正常人声/对话/唤醒锚定单句安全上限（避免 3.8s 强行腰斩长语音）
const STANDBY_BGM_ROLL_SEC = 4.2; // 仅待机持续高底噪背景音乐时启用滚动切窗防积压
const LONG_UTTERANCE_THRESHOLD_SEC = 3.0;
const DEFAULT_LONG_UTTERANCE_EXTRA_MS = 350;
const DEFAULT_INCOMPLETE_GRACE_MS = 650;
const DEFAULT_CLEARVOICE_MAX_UTTERANCE_MS = 30_000;

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

  // 实时流式转写与整句保护状态（默认只出实时字幕、不中途强拆多句，等说完统一发送给 Pi Agent）
  private _streamingAsrEnabled: boolean;
  private readonly _streamingSentenceSplit: boolean;
  private _voicePipelineMode: VoicePipelineMode;
  private _utteranceSilenceMs: number;
  private readonly _clearVoiceMaxUtteranceSamples: number;
  private readonly _longUtteranceExtraSilenceMs: number;
  private readonly _incompleteGraceMs: number;
  private readonly _streamTracker: Qwen3StreamingHypothesisTracker;
  private _heldSegment: HeldLegacySegment | null = null;
  private _streamLastDecodeFullWindow = true;

  // ClearVoice GPU 多轨盲源分离 + 分轨降噪准实时切片管线状态（按需惰性初始化，支持运行期无缝热切换）
  private _cvChunker: ClearVoiceRealtimeChunker | null = null;
  private _cvAssembler: ClearVoiceMultiTrackAssembler | null = null;
  private _cvSliceQueue: ClearVoiceChunkDescriptor[] = [];
  private _cvInFlight = false;
  private _cvIdleResolvers: Array<() => void> = [];
  private _cvRawChunks: Float32Array[] = [];
  private _cvTotalDenoiseMs = 0;
  private _cvTotalSsMs = 0;
  private _cvTotalSeMs = 0;
  private _cvBssUsed = false;
  private _cvServerSwaps = 0;
  private _cvLastEngine = "clearvoice-mossformer2-gpu";
  private _cvLastGpuName: string | null = null;
  private _cvUtteranceStartSample: number | null = null;
  private _cvGen = 0;
  private _streamSpeechOriginSample: number | null = null;
  private _streamLastDecodedEndSample = 0;
  private _streamDecodeInFlight = false;
  private _streamAbort: AbortController | null = null;
  private _streamGen = 0;
  private _streamLastEngine = "";
  private _streamLastLatencyMs = 0;

  // 双轨时间对齐环形缓冲（Raw + Denoised 同步保留 20 秒，支撑唤醒词锚定极速切段与零重复降噪）
  private readonly _rawRing = new Float32Array(RAW_RING_CAPACITY);
  private readonly _denRing = new Float32Array(RAW_RING_CAPACITY);
  private _rawTotalSamples = 0;
  private _denTotalSamples = 0;
  private _vadSamplesFed = 0;
  private _vadSampleBase = 0;
  private _lastEmittedEndSample = -1;
  private _denoisedPending = new Float32Array(0);
  private _vadDetected = false;
  private _lastFrameRms = 0;
  private _activeSegmentStartSample: number | null = null;
  private _wakeAnchorSample: number | null = null;
  private _wakeAnchorHit: WakeWordAcousticHit | null = null;
  private _lastRawOverlap = new Float32Array(0);
  private _lastDenOverlap = new Float32Array(0);
  private _lastMatchedStartSec = -1;
  private _lastMatchedEndSec = -1;
  private _ttsSpeaking = false;
  private _ttsLastEndedAt = 0;

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
    this._streamingAsrEnabled = options.streamingAsrEnabled === true;
    this._streamingSentenceSplit = options.streamingSentenceSplit === true;
    this._voicePipelineMode = options.voicePipelineMode === "clearvoice" ? "clearvoice" : "legacy";
    this._longUtteranceExtraSilenceMs =
      options.vadSensitivity === "aggressive"
        ? 0
        : Math.max(
            0,
            Math.min(1500, options.longUtteranceExtraSilenceMs ?? DEFAULT_LONG_UTTERANCE_EXTRA_MS),
          );
    this._incompleteGraceMs =
      options.vadSensitivity === "aggressive"
        ? 0
        : Math.max(0, Math.min(1800, options.incompleteGraceMs ?? DEFAULT_INCOMPLETE_GRACE_MS));
    this._clearVoiceMaxUtteranceSamples = Math.round(
      TARGET_SR *
        (Math.max(5000, Math.min(60_000, options.clearVoiceMaxUtteranceMs ?? DEFAULT_CLEARVOICE_MAX_UTTERANCE_MS)) /
          1000),
    );
    this._streamTracker = new Qwen3StreamingHypothesisTracker({
      wakeWords: this._wakeWords,
      punctuationPauseMs: options.streamingPunctuationPauseMs ?? 320,
      splitMidUtterance: this._streamingSentenceSplit,
      enablePunctuationPauseCommit: this._streamingSentenceSplit,
    });

    const online = options.localEngine.createOnlineDenoiser(options.noiseMode);
    this._onlineDenoiser = online?.denoiser ?? null;
    this._denoiseEngine = online?.engine ?? (options.noiseMode === "off" ? "off" : "dsp");

    const minSilenceSec = vadSensitivityToSeconds(options.vadSensitivity, options.vadSilenceMs);
    this._utteranceSilenceMs = Math.round(minSilenceSec * 1000);
    this._segmenter = new VoiceCommandSegmenter({
      silenceSeconds: minSilenceSec,
      timeoutSeconds: MAX_UTTERANCE_SEC,
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
      maxSpeechDuration: MAX_UTTERANCE_SEC,
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
      if (this._heldSegment) {
        this._flushHeldLegacySegment();
      }
      const anchorEnd = hit.sampleOffset > 0 ? hit.sampleOffset : this._rawTotalSamples;
      this._wakeAnchorSample = Math.max(0, anchorEnd - Math.round(TARGET_SR * 0.85));
      this._wakeAnchorHit = hit;
      this._lastRawOverlap = new Float32Array(0);
      this._lastDenOverlap = new Float32Array(0);
      if (this._vad) {
        try {
          while (!this._vad.isEmpty()) {
            this._vad.pop();
          }
        } catch {
          // ignore
        }
      }
      this._segmenter.forceStartCommand(Math.max(this._lastFrameRms, 0.05));
      if (this._streamingAsrEnabled) {
        this._resetStreamingState(true);
        this._streamSpeechOriginSample = this._wakeAnchorSample;
        this._streamLastDecodedEndSample = this._wakeAnchorSample ?? this._rawTotalSamples;
      }
    }
  }

  private _abortStreamingDecode(): void {
    const abort = this._streamAbort;
    this._streamAbort = null;
    if (abort) {
      try {
        abort.abort();
      } catch {
        // ignore
      }
    }
    this._streamDecodeInFlight = false;
  }

  private _resetStreamingState(abortInFlight = true): void {
    this._streamGen += 1;
    if (abortInFlight) {
      this._abortStreamingDecode();
    }
    this._streamTracker.reset();
    this._streamSpeechOriginSample = null;
    this._streamLastDecodedEndSample = this._rawTotalSamples;
    this._streamLastDecodeFullWindow = true;
    this._streamLastEngine = "";
    this._streamLastLatencyMs = 0;
  }

  private _clearHeldLegacySegment(): void {
    const held = this._heldSegment;
    this._heldSegment = null;
    if (held?.timer) {
      clearTimeout(held.timer);
      held.timer = null;
    }
  }

  private _flushHeldLegacySegment(): void {
    const held = this._heldSegment;
    if (!held) return;
    this._heldSegment = null;
    if (held.timer) {
      clearTimeout(held.timer);
      held.timer = null;
    }
    if (!this._disposed) {
      this._enqueueSegment(held.payload);
    }
  }

  private _stitchHeldLegacySegment(
    held: HeldLegacySegment,
    nextPayload: VoiceStreamSegmentPayload,
    nextRawStart: number,
    nextRawEnd: number,
  ): { payload: VoiceStreamSegmentPayload; rawStartSample: number; rawEndSample: number } {
    const concatPcm = (
      a: Float32Array,
      gap: Float32Array,
      b: Float32Array,
      skipB: number,
    ): Float32Array => {
      const safeSkip = Math.max(0, Math.min(b.length, skipB));
      const bTail = safeSkip > 0 ? b.subarray(safeSkip) : b;
      const out = new Float32Array(a.length + gap.length + bTail.length);
      out.set(a, 0);
      if (gap.length > 0) out.set(gap, a.length);
      if (bTail.length > 0) out.set(bTail, a.length + gap.length);
      return out;
    };

    const overlapSamples = Math.max(0, held.rawEndSample - nextRawStart);
    const gapSamples = Math.max(0, nextRawStart - held.rawEndSample);
    const maxGapSamples = Math.round(TARGET_SR * 3.0);
    const gapRaw =
      gapSamples > 0 && gapSamples <= maxGapSamples
        ? this._readRingRange(this._rawRing, this._rawTotalSamples, held.rawEndSample, nextRawStart)
        : new Float32Array(0);
    const gapDen =
      gapRaw.length > 0
        ? this._readRingRange(
            this._denRing,
            this._denTotalSamples,
            Math.max(0, this._denTotalSamples - Math.max(0, this._rawTotalSamples - held.rawEndSample)),
            Math.max(0, this._denTotalSamples - Math.max(0, this._rawTotalSamples - nextRawStart)),
          )
        : new Float32Array(0);

    const rawSlice = concatPcm(held.payload.rawSamples, gapRaw, nextPayload.rawSamples, overlapSamples);
    const denSlice = concatPcm(
      held.payload.denoisedSamples,
      gapDen.length === gapRaw.length ? gapDen : new Float32Array(gapRaw.length),
      nextPayload.denoisedSamples,
      overlapSamples,
    );

    const inputSnrDb = estimateSnrDb(rawSlice, TARGET_SR);
    const outputSnrDb = estimateSnrDb(denSlice, TARGET_SR);
    const mergedPrecomputed =
      held.payload.precomputedTranscript && nextPayload.precomputedTranscript
        ? joinUtteranceFragments(held.payload.precomputedTranscript, nextPayload.precomputedTranscript)
        : undefined;

    const merged: VoiceStreamSegmentPayload = {
      ...nextPayload,
      rawSamples: rawSlice,
      denoisedSamples: denSlice,
      inputSnrDb,
      outputSnrDb,
      snrGainDb: Number((outputSnrDb - inputSnrDb).toFixed(2)),
      startSec: held.payload.startSec,
      durationSec: Number((rawSlice.length / TARGET_SR).toFixed(2)),
      forcedRoll: Boolean(nextPayload.forcedRoll),
      acousticWake: held.payload.acousticWake ?? nextPayload.acousticWake,
      wakeAnchored: Boolean(held.payload.wakeAnchored || nextPayload.wakeAnchored),
      precomputedTranscript: mergedPrecomputed,
      stripCommittedPrefixHint: undefined,
      duringTtsPlayback: Boolean(held.payload.duringTtsPlayback || nextPayload.duringTtsPlayback),
    };

    return {
      payload: merged,
      rawStartSample: Math.min(held.rawStartSample, nextRawStart),
      rawEndSample: Math.max(held.rawEndSample, nextRawEnd),
    };
  }

  /**
   * 运行期热更新 VAD 尾静音判停时长（用户在设置中调整 vadSilenceMs / vadSensitivity 后立即生效，无需重连 WebSocket）。
   */
  updateVadTiming(options: { vadSilenceMs?: number; vadSensitivity?: VadSensitivityMode }): void {
    if (this._disposed) return;
    if (options.vadSilenceMs === undefined && options.vadSensitivity === undefined) return;
    const nextSec = vadSensitivityToSeconds(
      options.vadSensitivity ?? this._opts.vadSensitivity,
      options.vadSilenceMs ?? this._opts.vadSilenceMs,
    );
    this._utteranceSilenceMs = Math.round(nextSec * 1000);
    this._segmenter.setSilenceSeconds(nextSec);
    if (this._cvChunker && this._opts.clearVoiceUtteranceSilenceMs === undefined) {
      this._cvChunker.setUtteranceSilenceMs(this._utteranceSilenceMs);
    }
  }

  /**
   * 运行期热切换流式转写开关（在设置中打开/关闭后无需重连 WebSocket 立即生效）。
   */
  setStreamingAsrEnabled(enabled: boolean): void {
    const next = Boolean(enabled);
    if (this._streamingAsrEnabled === next) return;
    this._streamingAsrEnabled = next;
    this._resetStreamingState(true);
  }

  get streamingAsrEnabled(): boolean {
    return this._streamingAsrEnabled;
  }

  get voicePipelineMode(): VoicePipelineMode {
    return this._voicePipelineMode;
  }

  /**
   * 运行期无缝热切换新旧语音方案（原方案 legacy <-> 新方案 clearvoice GPU 准实时切片），
   * 切换后立即清理挂起缓冲，无需断开或重连 WebSocket。
   */
  setVoicePipelineMode(mode: VoicePipelineMode): void {
    const next: VoicePipelineMode = mode === "clearvoice" ? "clearvoice" : "legacy";
    if (this._voicePipelineMode === next) return;
    this._voicePipelineMode = next;
    this._clearHeldLegacySegment();
    this._resetClearVoiceState();
    this._resetVadState();
    this._resetStreamingState(true);
    this._wakeAnchorSample = null;
    this._wakeAnchorHit = null;
    this._activeSegmentStartSample = null;
    this._denoisedPending = new Float32Array(0);
    this._segmenter.reset();
    if (next === "clearvoice") {
      this._ensureClearVoicePipeline();
    }
  }

  private _ensureClearVoicePipeline(): void {
    if (!this._cvChunker) {
      // ClearVoice 专用 Silero VAD：极短 minSilenceDuration (64ms) 使 isDetected() 实时反映帧级语音/静音，
      // 由 ClearVoiceRealtimeChunker 的解耦双触发状态机分别把控：
      // - 280ms 短停顿 / 2.0s 上限触发 GPU MossFormer2 增量切片降噪；
      // - 完整 utteranceSilenceMs（默认继承 vadSilenceMs，含长语音与未闭合语义宽限）才结束整句并交付 ASR -> Pi Agent！
      const cvVad = this._opts.localEngine.createStreamingVad({
        threshold: this._opts.vadThreshold ?? 0.4,
        minSilenceDuration: 0.064,
        minSpeechDuration: 0.064,
        maxSpeechDuration: MAX_UTTERANCE_SEC,
      });
      const sliceSilenceMs = this._opts.clearVoiceSilenceMs ?? 280;
      const utteranceSilenceMs = Math.max(
        sliceSilenceMs,
        this._opts.clearVoiceUtteranceSilenceMs ?? this._utteranceSilenceMs,
      );
      this._cvChunker = new ClearVoiceRealtimeChunker({
        sampleRate: TARGET_SR,
        inputSampleRate: TARGET_SR,
        frameSizeMs: 32,
        silenceTriggerMs: sliceSilenceMs,
        utteranceSilenceMs,
        longUtteranceThresholdMs: Math.round(LONG_UTTERANCE_THRESHOLD_SEC * 1000),
        longUtteranceExtraSilenceMs: this._longUtteranceExtraSilenceMs,
        incompleteGraceMs: this._incompleteGraceMs,
        maxChunkMs: this._opts.clearVoiceMaxChunkMs ?? 2000,
        lookbackMs: this._opts.clearVoiceLookbackMs ?? 300,
        crossfadeMs: this._opts.clearVoiceCrossfadeMs ?? 20,
        vad: cvVad,
        onSpeechActivity: (speaking) => {
          this._opts.onSpeechActivity?.(speaking);
        },
      });
    }
    if (!this._cvAssembler) {
      this._cvAssembler = new ClearVoiceMultiTrackAssembler({
        sampleRate: TARGET_SR,
        crossfadeMs: this._opts.clearVoiceCrossfadeMs ?? 20,
        lookbackMs: this._opts.clearVoiceLookbackMs ?? 300,
      });
    }
  }

  private _resetClearVoiceState(): void {
    this._cvGen += 1;
    this._cvSliceQueue = [];
    this._cvRawChunks = [];
    this._cvTotalDenoiseMs = 0;
    this._cvTotalSsMs = 0;
    this._cvTotalSeMs = 0;
    this._cvBssUsed = false;
    this._cvServerSwaps = 0;
    this._cvUtteranceStartSample = null;
    this._cvChunker?.setIncompleteUtteranceHint(false);
    this._cvChunker?.reset();
    this._cvAssembler?.reset();
    if (!this._cvInFlight) {
      const resolvers = this._cvIdleResolvers;
      this._cvIdleResolvers = [];
      for (const r of resolvers) r();
    }
  }

  private _enqueueClearVoiceSlice(chunk: ClearVoiceChunkDescriptor): void {
    if (this._disposed) return;
    if (this._cvSliceQueue.length >= 16) {
      this._cvSliceQueue.shift();
      this._droppedStaleCount += 1;
    }
    this._cvSliceQueue.push(chunk);
    this._pumpClearVoiceQueue();
  }

  private _pumpClearVoiceQueue(): void {
    if (this._cvInFlight || this._disposed) return;
    const next = this._cvSliceQueue.shift();
    if (!next) {
      const resolvers = this._cvIdleResolvers;
      this._cvIdleResolvers = [];
      for (const r of resolvers) r();
      return;
    }

    this._cvInFlight = true;
    const gen = this._cvGen;
    void Promise.resolve()
      .then(async () => {
        if (this._disposed || gen !== this._cvGen) return;
        this._ensureClearVoicePipeline();
        const assembler = this._cvAssembler!;

        // 整句静默观察期结束信号（音频已在 280ms 切片时完成 GPU 盲源分离与分轨降噪拼接，零额外 GPU 推理开销直接交付）
        if (next.rawNewSamples.length === 0 && next.utteranceEnded) {
          this._emitClearVoiceUtterance(next.triggerReason);
          return;
        }

        if (this._cvUtteranceStartSample === null) {
          this._cvUtteranceStartSample = next.startSample;
        }

        // 阶段 3：带 0.3s 历史上下文送入 GPU ClearVoice（MossFormer2_SS_16K 多轨盲源分离 + 分轨 MossFormer2_SE_48K 降噪去背景音）
        // 绝不将多轨音轨混回单轨！流式切片阶段保留全部槽位（pruneTracks=false），由多轨装配器执行 PIT 置换对齐。
        let separatedSliceTracks: Float32Array[];
        let sliceDenoiseMs = 0;
        let sliceSsMs = 0;
        let sliceSeMs = 0;
        let sliceSwaps = 0;
        const cvGpu = this._opts.localEngine.clearVoiceGpu;
        const canUseCvGpu = cvGpu.getStatus().ready && !cvGpu.isInFailureCooldown();

        if (canUseCvGpu) {
          try {
            const res = await cvGpu.separateSlice(next.rawWithContext, {
              inputSampleRate: TARGET_SR,
              outputSampleRate: TARGET_SR,
              pruneTracks: false,
              applyDenoise: true,
            });
            separatedSliceTracks =
              res.tracks.length > 0 ? res.tracks.map((t) => t.samples) : [next.rawWithContext];
            sliceDenoiseMs = res.durationMs;
            sliceSsMs = res.ssMs;
            sliceSeMs = res.seMs;
            sliceSwaps = res.swaps;
            if (res.ssUsed) {
              this._cvBssUsed = true;
              this._cvLastEngine =
                res.device === "gpu"
                  ? "clearvoice-mossformer2-bss-se-gpu"
                  : "clearvoice-mossformer2-bss-se-cpu";
            } else {
              this._cvLastEngine =
                res.device === "gpu" ? "clearvoice-mossformer2-gpu" : "clearvoice-mossformer2-cpu";
            }
            this._cvLastGpuName = res.gpuName;
          } catch {
            // GPU ClearVoice 服务临时失败时优雅回退本地降噪，保证语音链路不断流
            const fb = this._opts.localEngine.denoise(
              next.rawWithContext,
              TARGET_SR,
              this._opts.noiseMode,
            );
            separatedSliceTracks = [fb.samples];
            sliceDenoiseMs = fb.durationMs;
            this._cvLastEngine = `clearvoice-fallback-${fb.engine}`;
          }
        } else {
          const fb = this._opts.localEngine.denoise(
            next.rawWithContext,
            TARGET_SR,
            this._opts.noiseMode,
          );
          separatedSliceTracks = [fb.samples];
          sliceDenoiseMs = fb.durationMs;
          this._cvLastEngine = `clearvoice-fallback-${fb.engine}`;
        }

        if (this._disposed || gen !== this._cvGen) return;
        this._cvTotalDenoiseMs += sliceDenoiseMs;
        this._cvTotalSsMs += sliceSsMs;
        this._cvTotalSeMs += sliceSeMs;
        this._cvServerSwaps += sliceSwaps;
        this._cvRawChunks.push(next.rawNewSamples);

        // 阶段 3（跨切片 PIT 置换对齐 + 裁掉前 0.3s 历史输出）+ 阶段 4（每轨独立 20ms 线性交叉淡入淡出 Overlap-Add）
        assembler.appendSeparatedSlice({
          tracksWithContext: separatedSliceTracks,
          lookbackSamples: next.lookbackSamples,
          newSamples: next.rawNewSamples.length,
          applyCrossfade: next.needsCrossfade,
        });

        // 若话语仍在继续（2.0s 增量切片或 280ms 短停顿增量降噪切片）：
        // 1) 在 GPU 就绪或无积压时，对每条有效分离音轨独立做实时流式字幕预览（严禁混轨！）；
        // 2) 仅当累计超长达到 30s 安全上限时才兜底提交，绝不中途腰斩正常长语音。
        if (!next.utteranceEnded) {
          if (this._streamingAsrEnabled && assembler.totalSamples >= TARGET_SR * 0.4) {
            try {
              const status = this._opts.localEngine.getStatus();
              const allowPreview =
                status.readyForLocalAsr &&
                (status.activeQwen3Device === "gpu" || this._cvSliceQueue.length === 0);
              if (allowPreview) {
                const prunedPreview = assembler.getTracks({ prune: true });
                const previewTracks: Array<{
                  trackId: string;
                  trackIndex: number;
                  text: string;
                  energyRatio?: number;
                }> = [];
                let primaryPartial: StreamingPartialUpdate | null = null;
                let anyIncomplete = false;
                let previewEngine = "qwen3-asr-stream";
                let previewLatencyMs = 0;

                for (const tr of prunedPreview.tracks) {
                  if (tr.samples.length < TARGET_SR * 0.35) continue;
                  const asrRes = await this._opts.localEngine.transcribeLocal(
                    tr.samples,
                    TARGET_SR,
                    this.lang,
                    {
                      hotwords: this._wakeWords.length > 0 ? this._wakeWords : undefined,
                    },
                  );
                  if (this._disposed || gen !== this._cvGen) return;
                  previewEngine = asrRes.engine;
                  previewLatencyMs += asrRes.durationMs;
                  const cleanedText = asrRes.text.trim();
                  if (!cleanedText) continue;
                  previewTracks.push({
                    trackId: `cv_track_${tr.trackIndex}`,
                    trackIndex: tr.trackIndex,
                    text: cleanedText,
                    energyRatio: tr.energyRatio,
                  });
                  if (looksLikeIncompleteUtterance(cleanedText, this._wakeWords)) {
                    anyIncomplete = true;
                  }
                  if (primaryPartial === null) {
                    const ingested = this._streamTracker.ingestHypothesis(cleanedText, {
                      engine: asrRes.engine,
                      latencyMs: asrRes.durationMs,
                    });
                    if (this._streamTracker.isLatestIncomplete) {
                      anyIncomplete = true;
                    }
                    if (ingested.partial) {
                      primaryPartial = ingested.partial;
                    }
                  }
                }

                this._cvChunker?.setIncompleteUtteranceHint(anyIncomplete);
                if (previewTracks.length > 0) {
                  const lead = previewTracks[0]!;
                  const partialPayload: StreamingPartialUpdate = primaryPartial
                    ? {
                        ...primaryPartial,
                        latencyMs: previewLatencyMs || primaryPartial.latencyMs,
                        tracks: previewTracks,
                      }
                    : {
                        text: lead.text,
                        stableText: "",
                        unstableText: lead.text,
                        engine: previewEngine,
                        latencyMs: previewLatencyMs,
                        tracks: previewTracks,
                      };
                  this._opts.onPartialTranscript?.(partialPayload);
                }
              }
            } catch {
              // 句中预览识别失败忽略，交由话语收尾完整转写兜底
            }
          }

          // 安全上限：单条连续话语达到上限（默认 30s）时自动提交独立多轨音频
          if (assembler.totalSamples >= this._clearVoiceMaxUtteranceSamples) {
            this._emitClearVoiceUtterance("timeout");
          }
          return;
        }

        // 整句静音判停或 flush：将每条独立拼接完成的纯净音轨分别送交后续独立声纹/ASR/逻辑判定
        this._emitClearVoiceUtterance(next.triggerReason);
      })
      .catch(() => {
        // 单个切片异常不中断连续流会话
      })
      .finally(() => {
        this._cvInFlight = false;
        this._pumpClearVoiceQueue();
      });
  }

  private _emitClearVoiceUtterance(triggerReason: ClearVoiceTriggerReason): void {
    const assembler = this._cvAssembler;
    this._cvChunker?.setIncompleteUtteranceHint(false);
    if (!assembler || assembler.totalSamples < Math.round(TARGET_SR * 0.14)) {
      this._cvAssembler?.reset();
      this._cvRawChunks = [];
      this._cvTotalDenoiseMs = 0;
      this._cvTotalSsMs = 0;
      this._cvTotalSeMs = 0;
      this._cvBssUsed = false;
      this._cvServerSwaps = 0;
      this._cvUtteranceStartSample = null;
      this._streamTracker.reset();
      return;
    }

    const pruned = assembler.getTracks({ prune: true });
    const rawLen = this._cvRawChunks.reduce((acc, c) => acc + c.length, 0);
    const rawSlice = new Float32Array(rawLen);
    let rawOff = 0;
    for (const c of this._cvRawChunks) {
      rawSlice.set(c, rawOff);
      rawOff += c.length;
    }

    const sliceCount = assembler.sliceCount;
    const crossfadeCount = assembler.crossfadeCount;
    const permutationSwaps = assembler.permutationSwaps + this._cvServerSwaps;
    const denoiseMs = Math.round(this._cvTotalDenoiseMs);
    const ssMs = Math.round(this._cvTotalSsMs);
    const seMs = Math.round(this._cvTotalSeMs);
    const bssUsed = this._cvBssUsed;
    const startSample = this._cvUtteranceStartSample ?? 0;

    assembler.reset();
    this._cvRawChunks = [];
    this._cvTotalDenoiseMs = 0;
    this._cvTotalSsMs = 0;
    this._cvTotalSeMs = 0;
    this._cvBssUsed = false;
    this._cvServerSwaps = 0;
    this._cvUtteranceStartSample = null;
    this._streamTracker.reset();

    if (pruned.tracks.length === 0) {
      return;
    }

    const inputSnrDb = estimateSnrDb(rawSlice, TARGET_SR);
    const separatedTracks: VoiceStreamSeparatedTrack[] = pruned.tracks.map((tr) => {
      const outSnr = estimateSnrDb(tr.samples, TARGET_SR);
      return {
        trackId: `cv_track_${tr.trackIndex}`,
        trackIndex: tr.trackIndex,
        sourceSlot: tr.sourceSlot,
        samples: tr.samples,
        sampleRate: TARGET_SR,
        rms: tr.rms,
        energyRatio: tr.energyRatio,
        outputSnrDb: outSnr,
        snrGainDb: Number((outSnr - inputSnrDb).toFixed(2)),
      };
    });

    // denoisedSamples 严格仅指向第 1 条独立音轨以兼容单轨消费者，绝不将多轨音轨相加混杂！
    const primaryTrack = separatedTracks[0]!;
    const payload: VoiceStreamSegmentPayload = {
      rawSamples: rawSlice,
      denoisedSamples: primaryTrack.samples,
      separatedTracks,
      denoiseEngine: this._cvLastEngine,
      inputSnrDb,
      outputSnrDb: primaryTrack.outputSnrDb,
      snrGainDb: primaryTrack.snrGainDb,
      startSec: Number((startSample / TARGET_SR).toFixed(2)),
      durationSec: Number((primaryTrack.samples.length / TARGET_SR).toFixed(2)),
      forcedRoll: triggerReason === "timeout",
      acousticWake: null,
      wakeAnchored: false,
      commitReason:
        triggerReason === "flush"
          ? "manual_flush"
          : triggerReason === "timeout"
            ? "max_duration"
            : "vad_silence",
      pipelineMode: "clearvoice",
      clearVoiceMeta: {
        sliceCount,
        crossfadeCount,
        triggerReason,
        denoiseMs,
        ssMs,
        seMs,
        trackCount: separatedTracks.length,
        bssUsed,
        permutationSwaps,
        gpuName: this._cvLastGpuName,
      },
    };
    this._enqueueSegment(payload);
  }

  private async _waitForClearVoiceIdle(): Promise<void> {
    if (!this._cvInFlight && this._cvSliceQueue.length === 0) {
      return;
    }
    await new Promise<void>((resolve) => {
      this._cvIdleResolvers.push(resolve);
    });
  }

  /**
   * 完整重置 Silero VAD 内部语音状态与残余队列，并记录采样原点偏移 `_vadSampleBase`，
   * 彻底杜绝 `vad.clear()` 仅清空已出队段却保留正在进行中的语音缓冲导致“一句话二次识别”！
   */
  private _resetVadState(): void {
    if (!this._vad) return;
    try {
      while (!this._vad.isEmpty()) {
        this._vad.pop();
      }
      if (typeof this._vad.reset === "function") {
        this._vad.reset();
        this._vadSampleBase = this._vadSamplesFed;
      } else {
        this._vad.clear();
      }
    } catch {
      try {
        this._vad.clear();
      } catch {
        // ignore
      }
    }
    if (this._vadDetected) {
      this._vadDetected = false;
      this._opts.onSpeechActivity?.(false);
    }
  }

  /**
   * TTS 播报开始/结束切换时清理挂起状态与残余 VAD 缓冲（兼容传统半双工模式与单测调用）。
   */
  resetAfterTts(): void {
    if (this._disposed) return;
    this._clearHeldLegacySegment();
    this._wakeAnchorSample = null;
    this._wakeAnchorHit = null;
    this._activeSegmentStartSample = null;
    this._denoisedPending = new Float32Array(0);
    this._lastRawOverlap = new Float32Array(0);
    this._lastDenOverlap = new Float32Array(0);
    this._segmenter.reset();
    this._resetVadState();
    this._resetStreamingState(true);
    this._resetClearVoiceState();
    this._oww?.resetSegmentTracking();
    this._lastEmittedEndSample = Math.max(this._lastEmittedEndSample, this._rawTotalSamples);
  }

  /**
   * 全双工异步模式下的非破坏性 TTS 播报状态同步：
   * - 绝不强行清空正在进行中的用户说话（VAD 活跃 / 已命中唤醒锚点），保障播报与对话完全并行不截断；
   * - 仅更新播报时间标记以便给后续切段打上 `duringTtsPlayback` 标记，并在无说话时清除滚窗噪声重叠。
   */
  notifyTtsState(speaking: boolean): void {
    if (this._disposed) return;
    const now = Date.now();
    this._ttsSpeaking = Boolean(speaking);
    if (!speaking) {
      this._ttsLastEndedAt = now;
    }
    const userCurrentlySpeaking = this._vadDetected || this._wakeAnchorSample !== null;
    if (!userCurrentlySpeaking) {
      this._lastRawOverlap = new Float32Array(0);
      this._lastDenOverlap = new Float32Array(0);
    }
  }

  private _isDuringTtsWindow(): boolean {
    if (this._ttsSpeaking) return true;
    return this._ttsLastEndedAt > 0 && Date.now() - this._ttsLastEndedAt <= 900;
  }

  /**
   * 热刷新实时流式会话的唤醒词原型与阈值（配置更新或新录制样本后立即生效，无需重连 WebSocket）。
   */
  reloadWakeWords(wakeWords: readonly string[], threshold?: number): void {
    if (this._disposed) return;
    this._wakeWords = [...wakeWords];
    this._streamTracker.setWakeWords(this._wakeWords);
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
    return this._voicePipelineMode === "clearvoice" ? this._cvLastEngine : this._denoiseEngine;
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

    // 新方案：ClearVoice GPU 准实时切片（32ms 帧 -> Silero VAD 双触发 + 环形缓冲 -> 0.3s 历史上下文 GPU MossFormer2 -> 20ms Cross-fade -> Qwen3-ASR）
    if (this._voicePipelineMode === "clearvoice") {
      this._ensureClearVoicePipeline();
      const chunks = this._cvChunker!.pushSamples(pcm16k);
      for (const ch of chunks) {
        this._enqueueClearVoiceSlice(ch);
      }
      return;
    }

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
        this._vadSamplesFed += 512;
        const nowDetected = this._vad.isDetected();

        if (nowDetected !== this._vadDetected) {
          this._vadDetected = nowDetected;
          this._opts.onSpeechActivity?.(nowDetected);
          if (nowDetected && this._streamingAsrEnabled && this._streamSpeechOriginSample === null) {
            this._streamSpeechOriginSample = Math.max(
              this._lastEmittedEndSample > 0 ? this._lastEmittedEndSample : 0,
              this._rawTotalSamples - PRE_ROLL_SAMPLES,
            );
            this._streamLastDecodedEndSample = this._streamSpeechOriginSample;
            this._streamTracker.reset();
          }
        }

        // 慢语速/未闭合句尾保护：在暂存观察期内若用户继续开口则取消计时等待无缝拼接，
        // 若持续静音帧达到宽限样本数则确定性立即交付（兼顾实时音频流与同步单测）。
        if (this._heldSegment) {
          if (nowDetected) {
            if (this._heldSegment.timer) {
              clearTimeout(this._heldSegment.timer);
              this._heldSegment.timer = null;
            }
            this._heldSegment.accumulatedSilenceSamples = 0;
          } else {
            this._heldSegment.accumulatedSilenceSamples += 512;
            if (
              this._heldSegment.accumulatedSilenceSamples >= this._heldSegment.holdSilenceSamples
            ) {
              this._flushHeldLegacySegment();
            }
          }
        }

        // 仅当显式开启 streamingSentenceSplit 时，才按句末强标点+短停顿提前截断收句；
        // 默认关闭，等待完整尾静音判停以防慢语速句中停顿被提前强拆。
        if (this._streamingAsrEnabled && this._streamingSentenceSplit) {
          const punctSilenceFloor = Math.max(0.008, this._segmenter.ambientRmsFloor * 1.45);
          const frameHasVoice = nowDetected && frameRms >= punctSilenceFloor;
          const { shouldCommitByPunctPause } = this._streamTracker.advanceFrame(32, frameHasVoice);
          if (
            shouldCommitByPunctPause &&
            !this._streamDecodeInFlight &&
            (this._wakeAnchorSample !== null || this._streamSpeechOriginSample !== null)
          ) {
            this._commitStreamingByPunctPause();
            offset += 512;
            continue;
          }
        }

        // 安静房间唤醒锚定快路径：Silero VAD 已完成整句尾静音判定并产段时立即收尾发包并 reset VAD，
        // 避免滞回分段器重复再等一遍 minSilenceSec 且彻底杜绝二次重复出段。
        if (
          this._wakeAnchorSample !== null &&
          !nowDetected &&
          !this._vad.isEmpty() &&
          this._segmenter.ambientRmsFloor < 0.015 &&
          this._rawTotalSamples - this._wakeAnchorSample >= TARGET_SR * 0.65
        ) {
          this._emitWakeAnchoredSegment(false);
          offset += 512;
          continue;
        }

        // 0.72 既高于常规 inCommandThreshold(0.48)，又低于高音乐底噪回落门限(0.78)，
        // 从而让前景说话结束回落到背景音乐电平时立即推进尾静音倒计时；正常安静/对话长语音放宽至 30s 上限。
        const step = this._segmenter.process(512 / TARGET_SR, nowDetected ? 0.72 : 0.05, frameRms);
        if (step.justStarted && this._activeSegmentStartSample === null) {
          // 回溯 speechSeconds(~0.2s) 避免切掉开声首字
          this._activeSegmentStartSample = Math.max(
            0,
            this._rawTotalSamples - Math.round(TARGET_SR * this._segmenter.speechSeconds),
          );
        }

        // 仅在待机态且持续高背景音乐底噪时按 4.2s 滚动切窗防队列积压，绝不腰斩正常人声/对话长语音！
        const isStandbyLoudBgm =
          !this._opts.bypassWakeWord &&
          !this._opts.isInConversation?.() &&
          this._wakeAnchorSample === null &&
          this._segmenter.ambientRmsFloor >= 0.015;
        if (
          step.continuing &&
          isStandbyLoudBgm &&
          this._activeSegmentStartSample !== null &&
          this._rawTotalSamples - this._activeSegmentStartSample >= TARGET_SR * STANDBY_BGM_ROLL_SEC
        ) {
          this._segmenter.reset();
          this._emitSegmenterWindow(true);
          offset += 512;
          continue;
        }

        if (!step.continuing) {
          if (this._wakeAnchorSample !== null) {
            this._emitWakeAnchoredSegment(step.timedOut);
          } else if (this._activeSegmentStartSample !== null) {
            const activeLen = this._rawTotalSamples - this._activeSegmentStartSample;
            // 仅在达到安全上限(30s)或高背景音乐中前景长语音回落(>=1.8s)时主动接管切段；
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

      if (this._streamingAsrEnabled && (this._vadDetected || this._wakeAnchorSample !== null)) {
        this._maybeTriggerStreamingDecode();
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

  /**
   * 标点+短停顿快速断句（例如说出“打开客厅吸顶灯。”后停顿 ~320ms 即刻断句提交，延迟减半）。
   */
  private _commitStreamingByPunctPause(): void {
    const sentences = this._streamTracker.flush();
    const lastEngine = this._streamLastEngine || "qwen3-asr-stream";
    const lastLatencyMs = this._streamLastLatencyMs;
    const anchor = this._wakeAnchorSample;
    const anchorHit = this._wakeAnchorHit;
    const origin =
      anchor ??
      this._streamSpeechOriginSample ??
      Math.max(0, this._rawTotalSamples - TARGET_SR * 2);

    this._wakeAnchorSample = null;
    this._wakeAnchorHit = null;
    this._activeSegmentStartSample = null;
    this._segmenter.reset();
    this._resetVadState();
    this._resetStreamingState(true);
    this._oww?.resetSegmentTracking();
    this._lastRawOverlap = new Float32Array(0);
    this._lastDenOverlap = new Float32Array(0);

    if (sentences.length === 0) return;

    const rawStart = Math.max(0, origin - PRE_ROLL_SAMPLES);
    const rawEnd = this._rawTotalSamples;
    if (rawEnd - rawStart < TARGET_SR * 0.16) return;

    const rawSlice = this._readRingRange(this._rawRing, this._rawTotalSamples, rawStart, rawEnd);
    const denSlice = this._readRingTail(this._denRing, this._denTotalSamples, rawSlice.length);
    this._lastEmittedEndSample = Math.max(this._lastEmittedEndSample, rawEnd);

    const inputSnrDb = estimateSnrDb(rawSlice, TARGET_SR);
    const outputSnrDb = estimateSnrDb(denSlice, TARGET_SR);
    const basePayload: VoiceStreamSegmentPayload = {
      rawSamples: rawSlice,
      denoisedSamples: denSlice,
      denoiseEngine: this._denoiseEngine,
      inputSnrDb,
      outputSnrDb,
      snrGainDb: Number((outputSnrDb - inputSnrDb).toFixed(2)),
      startSec: Number((rawStart / TARGET_SR).toFixed(2)),
      durationSec: Number((rawSlice.length / TARGET_SR).toFixed(2)),
      forcedRoll: false,
      acousticWake: anchorHit,
      wakeAnchored: anchor !== null,
      precomputedAsrEngine: lastEngine,
      precomputedAsrMs: lastLatencyMs,
      commitReason: "punctuation_pause",
    };

    for (const sentence of sentences) {
      this._enqueueSegment({
        ...basePayload,
        precomputedTranscript: sentence,
      });
    }
  }

  /**
   * 按自适应步进触发非阻塞流式假设解码（GPU ~360ms 步进 + SSE 逐 token，CPU ~850ms 步进），
   * 实时推送字幕并在句中检测到多句标点边界时立即切分输出。
   */
  private _maybeTriggerStreamingDecode(): void {
    if (!this._streamingAsrEnabled || this._disposed || this._streamDecodeInFlight || this._inFlight) {
      return;
    }
    if (this._opts.engine === "whisper") {
      return;
    }
    const status = this._opts.localEngine.getStatus();
    if (!status.readyForLocalAsr) {
      return;
    }
    // 待机持续高音量背景音乐下跳过投机流式解码，防止无谓占满 GPU/CPU
    if (
      !this._opts.bypassWakeWord &&
      !this._opts.isInConversation?.() &&
      this._wakeAnchorSample === null &&
      this._segmenter.ambientRmsFloor >= 0.025
    ) {
      return;
    }

    const origin =
      this._wakeAnchorSample ?? this._streamSpeechOriginSample ?? this._activeSegmentStartSample;
    if (origin === null) return;

    const isGpu = status.activeQwen3Device === "gpu";
    const pollMs = this._opts.streamingPollIntervalMs ?? (isGpu ? 360 : 850);
    const minAudioMs =
      this._opts.streamingPollIntervalMs !== undefined
        ? Math.min(320, pollMs)
        : isGpu
          ? 480
          : 700;

    const windowSamples = this._rawTotalSamples - origin;
    const newSamples = this._rawTotalSamples - this._streamLastDecodedEndSample;
    if (
      windowSamples < Math.round(TARGET_SR * (minAudioMs / 1000)) ||
      newSamples < Math.round(TARGET_SR * (pollMs / 1000))
    ) {
      return;
    }

    void this._runSpeculativeStreamingDecode(origin, this._rawTotalSamples);
  }

  private async _runSpeculativeStreamingDecode(
    originSample: number,
    endSample: number,
  ): Promise<void> {
    if (this._disposed || !this._streamingAsrEnabled || this._streamDecodeInFlight) return;
    const clampedOrigin = Math.max(originSample, endSample - TARGET_SR * MAX_UTTERANCE_SEC);
    const sliceLen = endSample - clampedOrigin;
    if (sliceLen < Math.round(TARGET_SR * 0.2)) return;

    const gen = this._streamGen;
    const abort = new AbortController();
    this._streamAbort = abort;
    this._streamDecodeInFlight = true;
    this._streamLastDecodedEndSample = endSample;
    this._streamLastDecodeFullWindow = clampedOrigin === originSample;

    const rawSlice = this._readRingRange(this._rawRing, this._rawTotalSamples, clampedOrigin, endSample);
    const denSlice = this._readRingTail(this._denRing, this._denTotalSamples, rawSlice.length);
    const decodeAudio = denSlice.length >= 3200 ? denSlice : rawSlice;
    const t0 = performance.now();

    try {
      const res = await this._opts.localEngine.transcribeLocal(decodeAudio, TARGET_SR, this.lang, {
        hotwords: this._wakeWords.length > 0 ? this._wakeWords : undefined,
        signal: abort.signal,
        onPartial: (partialRaw) => {
          if (this._disposed || gen !== this._streamGen || abort.signal.aborted) return;
          const clean = stripCommittedPrefix(partialRaw, this._streamTracker.committedPrefix);
          if (!clean) return;
          const stable = this._streamTracker.stableText;
          const stablePrefix = clean.startsWith(stable) ? stable : "";
          const unstable = stablePrefix ? clean.slice(stablePrefix.length) : clean;
          this._opts.onPartialTranscript?.({
            text: clean,
            stableText: stablePrefix,
            unstableText: unstable,
            engine: this._streamLastEngine || "qwen3-asr-stream",
            latencyMs: Math.round(performance.now() - t0),
          });
        },
      });

      if (this._disposed || gen !== this._streamGen || abort.signal.aborted) {
        return;
      }

      this._streamLastEngine = res.engine;
      this._streamLastLatencyMs = res.durationMs;

      const ingested = this._streamTracker.ingestHypothesis(res.text, {
        engine: res.engine,
        latencyMs: res.durationMs,
      });

      if (ingested.partial) {
        this._opts.onPartialTranscript?.(ingested.partial);
      }

      if (ingested.completedSentences.length > 0) {
        const inputSnrDb = estimateSnrDb(rawSlice, TARGET_SR);
        const outputSnrDb = estimateSnrDb(denSlice, TARGET_SR);
        const basePayload: VoiceStreamSegmentPayload = {
          rawSamples: rawSlice,
          denoisedSamples: denSlice,
          denoiseEngine: this._denoiseEngine,
          inputSnrDb,
          outputSnrDb,
          snrGainDb: Number((outputSnrDb - inputSnrDb).toFixed(2)),
          startSec: Number((clampedOrigin / TARGET_SR).toFixed(2)),
          durationSec: Number((rawSlice.length / TARGET_SR).toFixed(2)),
          forcedRoll: false,
          acousticWake: this._wakeAnchorHit,
          wakeAnchored: this._wakeAnchorSample !== null,
          precomputedAsrEngine: res.engine,
          precomputedAsrMs: res.durationMs,
          commitReason: ingested.commitReason ?? "punctuation_split",
        };
        for (const sentence of ingested.completedSentences) {
          this._enqueueSegment({
            ...basePayload,
            precomputedTranscript: sentence,
          });
        }
        // 若切句后无残余尾部，顺滑推进流式窗起点，避免连续长说音频窗无限增长
        if (!ingested.partial) {
          this._streamSpeechOriginSample = endSample;
          this._streamTracker.reset();
        }
      }
    } catch {
      // 流式投机解码被取消或单次失败时静默忽略，交由句尾正式分段兜底
    } finally {
      if (this._streamAbort === abort) {
        this._streamAbort = null;
        this._streamDecodeInFlight = false;
      }
    }
  }

  /**
   * 结束当前语音段时将流式追踪状态合并至出队段，并按需执行慢语速/未闭合句尾无缝拼接：
   * - 默认整句模式（streamingSentenceSplit=false）：绝不按句末标点将单次长语音强拆成多条发送；
   * - 若先前有因慢语速停顿暂存的前半段，直接无缝拼接音频为一个完整分段统一识别并一次性发送给 Pi Agent；
   * - 若当前段明显未说完（如停在“然后/把客厅灯”）或已属长语音（>= 3.0s），短幅暂存等待续说，无续说则立即交付。
   */
  private _enqueueWithStreamingHandoff(
    basePayload: VoiceStreamSegmentPayload,
    rawStartSample: number,
    rawEndSample: number,
    commitReason: StreamingCommitReason,
  ): void {
    const committedPrefix = this._streamingAsrEnabled ? this._streamTracker.committedPrefix : "";
    const latestText = this._streamingAsrEnabled ? this._streamTracker.latestText : "";
    const lastEngine = this._streamLastEngine;
    const lastLatencyMs = this._streamLastLatencyMs;
    const lastDecodedEnd = this._streamLastDecodedEndSample;
    const decodedFullWindow = this._streamLastDecodeFullWindow;
    if (this._streamingAsrEnabled) {
      this._resetStreamingState(true);
    }

    // 显式开启旧版句中拆分模式时保持按标点拆句行为
    if (this._streamingAsrEnabled && this._streamingSentenceSplit) {
      const tailUndecodedSamples = rawEndSample - lastDecodedEnd;
      if (
        latestText &&
        decodedFullWindow &&
        !basePayload.forcedRoll &&
        tailUndecodedSamples <= Math.round(TARGET_SR * 0.28)
      ) {
        const split = splitStreamingSentences(latestText, {
          wakeWords: this._wakeWords,
          forceFlush: true,
        });
        if (split.completed.length > 0) {
          for (const sentence of split.completed) {
            this._enqueueSegment({
              ...basePayload,
              precomputedTranscript: sentence,
              precomputedAsrEngine: lastEngine || "qwen3-asr-stream",
              precomputedAsrMs: lastLatencyMs,
              commitReason,
            });
          }
          return;
        }
      }

      this._enqueueSegment({
        ...basePayload,
        ...(committedPrefix ? { stripCommittedPrefixHint: committedPrefix } : {}),
        commitReason,
      });
      return;
    }

    // 默认整句模式：优先复用已覆盖句尾的完整流式假设（绝不强拆多句！）
    let candidatePayload: VoiceStreamSegmentPayload = {
      ...basePayload,
      commitReason,
    };
    if (this._streamingAsrEnabled) {
      const tailUndecodedSamples = rawEndSample - lastDecodedEnd;
      if (
        latestText &&
        decodedFullWindow &&
        !basePayload.forcedRoll &&
        tailUndecodedSamples <= Math.round(TARGET_SR * 0.28)
      ) {
        candidatePayload = {
          ...candidatePayload,
          precomputedTranscript: latestText.trim(),
          precomputedAsrEngine: lastEngine || "qwen3-asr-stream",
          precomputedAsrMs: lastLatencyMs,
        };
      } else if (committedPrefix) {
        candidatePayload = {
          ...candidatePayload,
          stripCommittedPrefixHint: committedPrefix,
        };
      }
    }

    // 若上一半段因慢语速停顿仍在暂存观察期，无缝拼接两段音频为一个完整整句
    let effectiveStartSample = rawStartSample;
    let effectiveEndSample = rawEndSample;
    if (this._heldSegment) {
      const held = this._heldSegment;
      this._clearHeldLegacySegment();
      const stitched = this._stitchHeldLegacySegment(
        held,
        candidatePayload,
        rawStartSample,
        rawEndSample,
      );
      candidatePayload = stitched.payload;
      effectiveStartSample = stitched.rawStartSample;
      effectiveEndSample = stitched.rawEndSample;
    }

    const isStandbyLoudBgm =
      !this._opts.bypassWakeWord &&
      !this._opts.isInConversation?.() &&
      !candidatePayload.wakeAnchored &&
      this._segmenter.ambientRmsFloor >= 0.015;

    let holdMs = 0;
    if (
      commitReason !== "manual_flush" &&
      commitReason !== "max_duration" &&
      !candidatePayload.forcedRoll &&
      !isStandbyLoudBgm &&
      candidatePayload.durationSec < MAX_UTTERANCE_SEC - 1.0
    ) {
      const textToCheck = candidatePayload.precomputedTranscript || latestText;
      if (
        this._streamingAsrEnabled &&
        textToCheck &&
        looksLikeIncompleteUtterance(textToCheck, this._wakeWords)
      ) {
        holdMs = this._incompleteGraceMs;
      } else if (candidatePayload.durationSec >= LONG_UTTERANCE_THRESHOLD_SEC) {
        holdMs = this._longUtteranceExtraSilenceMs;
      }
    }

    if (holdMs > 0) {
      const holdSilenceSamples = Math.round((TARGET_SR * holdMs) / 1000);
      const heldRecord: HeldLegacySegment = {
        payload: candidatePayload,
        rawStartSample: effectiveStartSample,
        rawEndSample: effectiveEndSample,
        holdSilenceSamples,
        accumulatedSilenceSamples: 0,
        timer: null,
      };
      heldRecord.timer = setTimeout(() => {
        if (this._heldSegment === heldRecord) {
          this._flushHeldLegacySegment();
        }
      }, holdMs + 120);
      (heldRecord.timer as { unref?: () => void }).unref?.();
      this._heldSegment = heldRecord;
      return;
    }

    this._enqueueSegment(candidatePayload);
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

    this._resetVadState();
    this._oww?.resetSegmentTracking();
    this._lastRawOverlap = new Float32Array(0);
    this._lastDenOverlap = new Float32Array(0);
    this._lastEmittedEndSample = Math.max(this._lastEmittedEndSample, rawEnd);

    const inputSnrDb = estimateSnrDb(rawSlice, TARGET_SR);
    const outputSnrDb = estimateSnrDb(denSlice, TARGET_SR);
    this._enqueueWithStreamingHandoff(
      {
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
      },
      rawStart,
      rawEnd,
      timedOut ? "max_duration" : "vad_silence",
    );
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

    this._resetVadState();

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

    this._lastEmittedEndSample = Math.max(this._lastEmittedEndSample, rawEnd);

    const inputSnrDb = estimateSnrDb(rawSlice, TARGET_SR);
    const outputSnrDb = estimateSnrDb(denSlice, TARGET_SR);
    this._enqueueWithStreamingHandoff(
      {
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
      },
      rawStart,
      rawEnd,
      timedOut ? "max_duration" : "vad_silence",
    );
  }

  /**
   * 主动冲刷当前挂起尾音（用于单次说话松开/停止监听时立刻出结果）。
   */
  async flush(): Promise<void> {
    if (this._disposed) return;
    if (this._voicePipelineMode === "clearvoice") {
      const tailChunk = this._cvChunker?.flush();
      if (tailChunk) {
        this._enqueueClearVoiceSlice(tailChunk);
      }
      await this._waitForClearVoiceIdle();
      // 若之前仅触发了超时切分或静音观察期未收尾，主动提交残余已降噪语音
      if (this._cvAssembler && this._cvAssembler.totalSamples > 0) {
        this._emitClearVoiceUtterance("flush");
      }
      await this.waitForIdle();
      return;
    }
    if (this._streamingAsrEnabled) {
      this._abortStreamingDecode();
    }
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
              this._vadSamplesFed += 512;
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
    // 立即提交任何仍处于慢语速观察期的暂存段，绝不让 flush 阻塞等待
    if (this._heldSegment) {
      this._flushHeldLegacySegment();
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
      const absStart = this._vadSampleBase + seg.start;
      const absEnd = absStart + seg.samples.length;

      // 去重：若该 Silero 段与刚发出的唤醒锚定段/分段器窗口高度重叠，直接丢弃防一句话识别两次
      if (!isManualFlush && this._lastEmittedEndSample > 0) {
        const overlapSamples = Math.min(absEnd, this._lastEmittedEndSample) - absStart;
        const segLen = Math.max(1, absEnd - absStart);
        if (
          absEnd <= this._lastEmittedEndSample + Math.round(TARGET_SR * 0.25) ||
          (overlapSamples > 0 && overlapSamples / segLen >= 0.6)
        ) {
          this._droppedStaleCount += 1;
          continue;
        }
      }

      this._activeSegmentStartSample = null;
      this._segmenter.reset();

      const rawStart = Math.max(0, absStart - PRE_ROLL_SAMPLES);
      const rawEnd = Math.min(this._rawTotalSamples, absEnd + POST_ROLL_SAMPLES);
      let rawSlice = this._readRingRange(this._rawRing, this._rawTotalSamples, rawStart, rawEnd);
      let denSlice = new Float32Array(seg.samples);

      // 判断是否为持续音乐/歌声或超长上限导致的强制切段（VAD 仍在活跃态就吐段，或已达单句时长上限）
      const forcedRoll =
        !isManualFlush &&
        (this._vad.isDetected() || seg.samples.length >= TARGET_SR * (MAX_UTTERANCE_SEC - 0.2));

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

      this._lastEmittedEndSample = Math.max(this._lastEmittedEndSample, absEnd);

      const inputSnrDb = estimateSnrDb(rawSlice, TARGET_SR);
      const outputSnrDb = estimateSnrDb(denSlice, TARGET_SR);
      const payload: VoiceStreamSegmentPayload = {
        rawSamples: rawSlice,
        denoisedSamples: denSlice,
        denoiseEngine: this._denoiseEngine,
        inputSnrDb,
        outputSnrDb,
        snrGainDb: Number((outputSnrDb - inputSnrDb).toFixed(2)),
        startSec: Number((absStart / TARGET_SR).toFixed(2)),
        durationSec,
        forcedRoll,
        acousticWake,
        wakeAnchored: false,
      };

      this._enqueueWithStreamingHandoff(
        payload,
        rawStart,
        rawEnd,
        isManualFlush ? "manual_flush" : forcedRoll ? "max_duration" : "vad_silence",
      );
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
    const enrichedPayload: VoiceStreamSegmentPayload =
      payload.duringTtsPlayback !== undefined
        ? payload
        : { ...payload, duringTtsPlayback: this._isDuringTtsWindow() };
    const isPriorityWake = Boolean(enrichedPayload.wakeAnchored || enrichedPayload.acousticWake?.matched);
    if (isPriorityWake) {
      if (this._pendingWake.length >= 2) {
        this._pendingWake.shift();
        this._droppedStaleCount += 1;
      }
      this._pendingWake.push(enrichedPayload);
    } else {
      // 有界反压：非唤醒待处理队列最多保留最新 2 段（流式多句切分放宽至 6 句防吞掉连续指令），彻底防止持续背景音乐下队列无限积压！
      const maxQueue = enrichedPayload.precomputedTranscript ? 6 : 2;
      if (this._pendingNormalQueue.length >= maxQueue) {
        this._pendingNormalQueue.shift();
        this._droppedStaleCount += 1;
      }
      this._pendingNormalQueue.push(enrichedPayload);
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
      if (this._heldSegment !== null) {
        return;
      }
      const resolvers = this._idleResolvers;
      this._idleResolvers = [];
      for (const r of resolvers) r();
      return;
    }

    this._inFlight = true;
    void Promise.resolve()
      .then(async () => {
        if (this._disposed) return;
        // 若上一条刚成功命中并执行指令，跳过紧随其后的重叠残尾段/滚窗，彻底防止同一句话触发二次执行
        // （流式断句产出的独立分句已由 Qwen3StreamingHypothesisTracker 严格去重，豁免时间重叠拦截）
        if (!next.wakeAnchored && !next.precomputedTranscript && this._lastMatchedEndSec >= 0) {
          const nextStart = next.startSec;
          const nextEnd = next.startSec + next.durationSec;
          const overlapStart = Math.max(nextStart, Math.max(0, this._lastMatchedStartSec));
          const overlapEnd = Math.min(nextEnd, this._lastMatchedEndSec);
          const overlapSec = Math.max(0, overlapEnd - overlapStart);
          const overlapRatio = next.durationSec > 0 ? overlapSec / next.durationSec : 0;
          if (
            (next.forcedRoll && nextStart < this._lastMatchedEndSec) ||
            overlapRatio >= 0.5 ||
            (nextStart < this._lastMatchedEndSec && nextEnd <= this._lastMatchedEndSec + 0.35)
          ) {
            this._droppedStaleCount += 1;
            return;
          }
        }
        const res = await this._opts.onSegmentReady(next);
        if (res?.matched) {
          this._lastMatchedStartSec = next.startSec;
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
    if (this._voicePipelineMode === "clearvoice") {
      await this._waitForClearVoiceIdle();
    }
    if (
      !this._inFlight &&
      this._pendingWake.length === 0 &&
      this._pendingNormalQueue.length === 0 &&
      this._heldSegment === null
    ) {
      return;
    }
    await new Promise<void>((resolve) => {
      this._idleResolvers.push(resolve);
    });
  }

  dispose(): void {
    this._disposed = true;
    this._clearHeldLegacySegment();
    this._resetClearVoiceState();
    this._cvChunker = null;
    this._cvAssembler = null;
    this._resetStreamingState(true);
    this._pendingWake = [];
    this._pendingNormalQueue = [];
    this._wakeAnchorSample = null;
    this._wakeAnchorHit = null;
    this._activeSegmentStartSample = null;
    this._resetVadState();
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
