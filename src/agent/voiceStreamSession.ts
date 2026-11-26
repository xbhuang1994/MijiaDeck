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
  ClearVoiceMultiTrackEndpointTracker,
  ClearVoiceRealtimeChunker,
  pruneInactiveOrDuplicateTracks,
  type ClearVoiceChunkDescriptor,
  type ClearVoiceReadyTrackSlot,
  type ClearVoiceTriggerReason,
} from "./clearVoiceChunker.ts";
import type {
  LocalVoiceEngine,
  OnlineDenoiserHandleLike,
  StreamingVadHandleLike,
} from "./localVoiceEngine.ts";
import {
  ConversationTrackMuteManager,
  type MutedTrackRecord,
} from "./multiTrackNoiseFilter.ts";
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
import type { SystemOneClient, SystemOneHistoryEntry } from "./systemOneClient.ts";
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
    /** 是否由多轨分轨独立判停提前出段（如音轨 1 已说完命令而音轨 2 电视仍在持续发声） */
    independentTrackEmit?: boolean;
    /** 独立出段时的原始分离槽位编号（0-based） */
    sourceSlot?: number;
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
  /** 是否启用唤醒词门控（未显式传入时，配置了 wakeWords 则默认 true） */
  wakeWordEnabled?: boolean;
  /**
   * 未唤醒时禁用实时语音转文字（默认 true）：
   * - 未唤醒待机期仅持续写入循环录制缓冲区并运行轻量级 openWakeWord 声学唤醒检测，不执行实时流式 ASR / ClearVoice 切片 / 分段转写；
   * - 命中唤醒后再将循环录制缓冲区与后续音频统一送入降噪与语音转文字管线。
   */
  wakeGatedAsr?: boolean;
  /** 唤醒后从循环录制缓冲区回溯并转写的历史窗口时长（ms，默认 1800ms，范围 600–6000ms） */
  wakeRingLookbackMs?: number;
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
  /** 可选多轨背景音/电视屏蔽管理器（通常与 VoiceListenerController 共享；未传入时会话内部独立维护） */
  trackMuteManager?: ConversationTrackMuteManager;
  /** 可选 SystemOne 客户端获取器（供多轨流式预览超 20 字时实时识别并屏蔽背景音/旁白/噪音/电视音轨） */
  getSystemOneClient?: () => SystemOneClient | null;
  /** 可选近期对话历史获取器（供 SystemOne 多轨噪音判别使用） */
  getRecentHistory?: () => ReadonlyArray<SystemOneHistoryEntry>;
  /** 可选对话轮次号获取器（防异步 SystemOne 返回前对话已退出导致陈旧屏蔽） */
  getDialogEpoch?: () => number;
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

interface ClearVoiceUtteranceMeta {
  wakeAnchored: boolean;
  acousticWake: WakeWordAcousticHit | null;
  endGlobalSample: number;
}

interface ClearVoiceQueuedSlice {
  chunk: ClearVoiceChunkDescriptor;
  startGlobalSample: number;
  wakeAuthorized: boolean;
  utteranceMeta?: ClearVoiceUtteranceMeta;
}

const TARGET_SR = 16000;
const RAW_RING_CAPACITY = TARGET_SR * 35; // 35 秒对齐环形缓冲（完整容纳 30s 慢语速长语音）
const PRE_ROLL_SAMPLES = Math.round(TARGET_SR * 0.32);
const POST_ROLL_SAMPLES = Math.round(TARGET_SR * 0.16);
const ROLLING_OVERLAP_SAMPLES = Math.round(TARGET_SR * 1.0); // 持续音乐强制切窗时保留 1.0s 重叠防止切半个唤醒词
const DEFAULT_WAKE_RING_LOOKBACK_MS = 1800; // 唤醒后回溯循环录制缓冲区的默认窗口（完整覆盖唤醒词、前导呼唤与紧接词首）
const POST_WAKE_GAP_REPLAY_MAX_SAMPLES = Math.round(TARGET_SR * 1.6);
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
  private _wakeWordEnabled: boolean;
  private _owwEnabled: boolean;
  private readonly _wakeGatedAsr: boolean;
  private readonly _wakeRingLookbackSamples: number;
  private _wasAwake = false;

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
  private _cvTrackTracker: ClearVoiceMultiTrackEndpointTracker | null = null;
  private _cvAnyTrackDrainedInUtterance = false;
  private readonly _trackMuteManager: ConversationTrackMuteManager;
  private readonly _ownsTrackMuteManager: boolean;
  private _cvSliceQueue: ClearVoiceQueuedSlice[] = [];
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
  private _cvWakeAnchored = false;
  private _cvWakeHit: WakeWordAcousticHit | null = null;
  private _cvBaseGlobalSample = 0;
  private _cvFedUpToGlobalSample = 0;
  private _cvPendingEmitCount = 0;
  private _cvGen = 0;
  private _legacyFedUpToGlobalSample = 0;
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
  private _lastMatchedBySlot = new Map<number, { startSec: number; endSec: number }>();
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
    this._ownsTrackMuteManager = !options.trackMuteManager;
    this._trackMuteManager = options.trackMuteManager ?? new ConversationTrackMuteManager();
    this._inputRate = options.sampleRate ?? TARGET_SR;
    this._wakeWords = [...(options.wakeWords ?? [])];
    this._owwThreshold = options.owwThreshold;
    this._wakeWordEnabled =
      options.wakeWordEnabled !== undefined
        ? Boolean(options.wakeWordEnabled)
        : this._wakeWords.length > 0;
    this._owwEnabled = options.owwEnabled !== false;
    this._wakeGatedAsr = options.wakeGatedAsr !== false;
    const lookbackMs = Math.max(
      600,
      Math.min(6000, Math.round(options.wakeRingLookbackMs ?? DEFAULT_WAKE_RING_LOOKBACK_MS)),
    );
    this._wakeRingLookbackSamples = Math.round((TARGET_SR * lookbackMs) / 1000);
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
      this._owwEnabled
        ? options.localEngine.createWakeWordStream(this._wakeWords, {
            threshold: this._owwThreshold,
            onSpot: (hit) => this._handleWakeSpot(hit),
          })
        : null;
    this._wasAwake = this.isAwake;
  }

  /**
   * 当前是否处于已唤醒/免唤醒态（允许执行降噪切片与实时/分段语音转文字）。
   */
  get isAwake(): boolean {
    if (this._opts.bypassWakeWord) return true;
    if (!this._wakeWordEnabled) return true;
    if (this._opts.isInConversation?.()) return true;
    if (this._wakeAnchorSample !== null) return true;
    if (this._cvWakeAnchored) return true;
    if (this._heldSegment !== null) return true;
    return false;
  }

  get wakeGatedAsr(): boolean {
    return this._wakeGatedAsr;
  }

  /**
   * 循环录制缓冲区当前已保留的 16kHz 样本数（上限 RAW_RING_CAPACITY = 35s）。
   */
  get ringBufferedSamples(): number {
    return Math.min(this._rawTotalSamples, RAW_RING_CAPACITY);
  }

  private _hasActiveAcousticWake(): boolean {
    if (!this._oww) return false;
    const withProtoFlag = this._oww as { hasActivePrototypes?: boolean };
    if (typeof withProtoFlag.hasActivePrototypes === "boolean") {
      return withProtoFlag.hasActivePrototypes;
    }
    return true;
  }

  /**
   * 当前是否处于“未唤醒仅循环录制缓冲 + 声学唤醒检测”待机态：
   * 该状态下完全跳过 ClearVoice GPU 切片、实时流式转写与分段 ASR，待唤醒后再回放循环录制缓冲区及后续音频。
   */
  get isWakeGatedStandby(): boolean {
    if (!this._wakeGatedAsr) return false;
    if (this.isAwake) return false;
    return this._hasActiveAcousticWake();
  }

  private _isStreamingAsrAllowed(): boolean {
    if (!this._streamingAsrEnabled) return false;
    if (this._wakeGatedAsr && !this.isAwake) return false;
    return true;
  }

  private _computeWakeReplayStartSample(anchorEnd: number, replayMs?: number): number {
    const lookbackSamples =
      replayMs !== undefined && Number.isFinite(replayMs)
        ? Math.round(TARGET_SR * (Math.max(400, Math.min(10_000, replayMs)) / 1000))
        : this._wakeRingLookbackSamples;
    const earliestAvailable = Math.max(0, this._rawTotalSamples - RAW_RING_CAPACITY);
    const minAfterLastEmitted = this._lastEmittedEndSample > 0 ? this._lastEmittedEndSample : 0;
    const effectiveEnd =
      anchorEnd > 0 ? Math.min(anchorEnd, this._rawTotalSamples) : this._rawTotalSamples;
    const desiredStart = Math.max(0, effectiveEnd - lookbackSamples);
    return Math.min(
      this._rawTotalSamples,
      Math.max(earliestAvailable, minAfterLastEmitted, desiredStart),
    );
  }

  /**
   * 主动唤醒当前会话并立即将循环录制缓冲区（含唤醒前导与已说部分）及后续音频送入语音转文字管线。
   */
  triggerWake(options: { hit?: WakeWordAcousticHit; replayMs?: number } = {}): void {
    if (this._disposed) return;
    const hit: WakeWordAcousticHit | null = options.hit ?? null;
    if (hit) {
      this._opts.onWakeWordSpot?.(hit);
    }
    this._activateWakeCapture(hit, options.replayMs);
  }

  private _handleWakeSpot(hit: WakeWordAcousticHit): void {
    if (this._disposed) return;
    if (!this._cooldownGuard.tryAccept(hit.wakeWord, Date.now())) {
      return;
    }
    this._opts.onWakeWordSpot?.(hit);

    if (!this._opts.bypassWakeWord) {
      this._activateWakeCapture(hit);
    }
  }

  private _activateWakeCapture(hit: WakeWordAcousticHit | null, replayMs?: number): void {
    if (this._disposed) return;

    if (this._voicePipelineMode === "clearvoice") {
      if (this._cvWakeAnchored && !this._opts.isInConversation?.()) {
        if (hit && (!this._cvWakeHit || hit.score > this._cvWakeHit.score)) {
          this._cvWakeHit = hit;
          this._wakeAnchorHit = hit;
        }
        return;
      }
      this._activateClearVoiceFromWake(hit, replayMs);
      return;
    }

    // Legacy 方案：命中唤醒后立即从循环录制缓冲区锚定回溯起点、激活滞回分段器，并立刻对缓冲区内容启动流式转写
    if (this._wakeAnchorSample !== null) {
      if (hit && (!this._wakeAnchorHit || hit.score > this._wakeAnchorHit.score)) {
        this._wakeAnchorHit = hit;
      }
      return;
    }

    if (this._heldSegment) {
      this._flushHeldLegacySegment();
    }
    const anchorEnd = hit && hit.sampleOffset > 0 ? hit.sampleOffset : this._rawTotalSamples;
    this._wakeAnchorSample = this._computeWakeReplayStartSample(anchorEnd, replayMs);
    this._wakeAnchorHit = hit;
    this._wasAwake = true;
    this._lastRawOverlap = new Float32Array(0);
    this._lastDenOverlap = new Float32Array(0);
    this._denoisedPending = new Float32Array(0);
    this._legacyFedUpToGlobalSample = this._rawTotalSamples;
    this._resetVadState();
    this._segmenter.forceStartCommand(Math.max(this._lastFrameRms, 0.05));
    if (this._isStreamingAsrAllowed()) {
      this._resetStreamingState(true);
      this._streamSpeechOriginSample = this._wakeAnchorSample;
      this._streamLastDecodedEndSample = this._wakeAnchorSample ?? this._rawTotalSamples;
      // 唤醒瞬间即刻对循环录制缓冲区中已积累的音频触发转写，无需干等后续帧
      this._maybeTriggerStreamingDecode();
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
    if (this._cvTrackTracker && this._opts.clearVoiceUtteranceSilenceMs === undefined) {
      this._cvTrackTracker.setUtteranceSilenceMs(this._utteranceSilenceMs);
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

  get mutedTracks(): MutedTrackRecord[] {
    return this._trackMuteManager.getMutedTracks();
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
    if (this._ownsTrackMuteManager) {
      this._trackMuteManager.reset();
    }
    this._resetVadState();
    this._resetStreamingState(true);
    this._wakeAnchorSample = null;
    this._wakeAnchorHit = null;
    this._cvWakeAnchored = false;
    this._cvWakeHit = null;
    this._activeSegmentStartSample = null;
    this._denoisedPending = new Float32Array(0);
    this._segmenter.reset();
    this._cvFedUpToGlobalSample = this._rawTotalSamples;
    this._wasAwake = this.isAwake;
    if (next === "clearvoice" && !this.isWakeGatedStandby) {
      this._prepareClearVoiceForLiveInput();
    }
  }

  /**
   * 运行期热更新唤醒词开关（关闭唤醒词后立即放开持续识别；重新开启后回到未唤醒循环缓冲待机）。
   */
  setWakeWordEnabled(enabled: boolean): void {
    if (this._disposed) return;
    const next = Boolean(enabled);
    if (this._wakeWordEnabled === next) return;
    this._wakeWordEnabled = next;
    const awakeNow = this.isAwake;
    if (!awakeNow && this._wasAwake) {
      this._wasAwake = false;
      this._onEnterStandby();
    } else if (awakeNow && !this._wasAwake) {
      this._wasAwake = true;
      if (this._voicePipelineMode === "clearvoice") {
        this._prepareClearVoiceForLiveInput();
      } else {
        this._denoisedPending = new Float32Array(0);
        this._resetVadState();
      }
    }
  }

  /**
   * 运行期热更新 openWakeWord 声学唤醒开关。
   */
  setOwwEnabled(enabled: boolean): void {
    if (this._disposed) return;
    const next = Boolean(enabled);
    if (this._owwEnabled === next) return;
    this._owwEnabled = next;
    if (!next) {
      try {
        this._oww?.reset();
      } catch {
        // ignore
      }
      this._oww = null;
      return;
    }
    if (!this._oww) {
      this._oww = this._opts.localEngine.createWakeWordStream(this._wakeWords, {
        threshold: this._owwThreshold,
        onSpot: (hit) => this._handleWakeSpot(hit),
      });
    }
  }

  /**
   * 同步服务端对话状态机跃迁（待机 <-> 连续对话）：
   * - 退出对话回归待机时，立即中止任何在途实时流式转写并清空挂起状态，回归零 ASR 循环录制待机；
   * - 唤醒后进入对话时，无缝回放在异步识别间隙内新写入循环录制缓冲区的音频，防止续说首字丢失。
   */
  syncDialogState(inConversation: boolean, reason?: string): void {
    if (this._disposed) return;
    if (!inConversation) {
      const keepActiveWake =
        this._opts.bypassWakeWord ||
        !this._wakeWordEnabled ||
        this._wakeAnchorSample !== null ||
        this._cvWakeAnchored ||
        Boolean(this._heldSegment?.payload.wakeAnchored);
      if (!keepActiveWake && (this._wasAwake || this._heldSegment !== null)) {
        this._wasAwake = false;
        this._onEnterStandby(true);
        return;
      }
    }
    const awakeNow = this.isAwake || inConversation;
    if (!awakeNow && this._wasAwake) {
      this._wasAwake = false;
      this._onEnterStandby(true);
      return;
    }
    if (inConversation && !this._wasAwake) {
      this._wasAwake = true;
      const isManualEnter = reason === "ws_control" || reason === "manual";
      if (this._voicePipelineMode === "clearvoice") {
        const isPostWakeTransition =
          !isManualEnter &&
          (reason === "wake_only" ||
            reason === "command_dispatched_async" ||
            reason === "command_running" ||
            reason === "command_done" ||
            (this._lastEmittedEndSample > 0 &&
              this._rawTotalSamples - this._lastEmittedEndSample <= POST_WAKE_GAP_REPLAY_MAX_SAMPLES));
        if (isPostWakeTransition) {
          this._replayPostWakeGapIfNeeded();
        } else {
          this._prepareClearVoiceForLiveInput();
        }
      } else {
        this._denoisedPending = new Float32Array(0);
        this._resetVadState();
        if (isManualEnter) {
          this._legacyFedUpToGlobalSample = this._rawTotalSamples;
        } else {
          this._replayPostWakeGapIfNeeded();
        }
      }
      return;
    }
    this._wasAwake = awakeNow;
  }

  private _onEnterStandby(explicitExit = false): void {
    if (explicitExit && this._ownsTrackMuteManager) {
      this._trackMuteManager.reset();
    }
    if (!explicitExit && this._heldSegment) {
      this._flushHeldLegacySegment();
    } else {
      this._clearHeldLegacySegment();
    }
    this._resetStreamingState(true);
    this._wakeAnchorSample = null;
    this._wakeAnchorHit = null;
    this._cvWakeAnchored = false;
    this._cvWakeHit = null;
    this._activeSegmentStartSample = null;
    this._denoisedPending = new Float32Array(0);
    this._lastRawOverlap = new Float32Array(0);
    this._lastDenOverlap = new Float32Array(0);
    this._pendingNormalQueue = [];
    this._fallbackChunks = [];
    this._fallbackTotal = 0;
    this._segmenter.reset();
    this._resetVadState();
    const hasPendingWakeWork =
      !explicitExit &&
      (this._cvPendingEmitCount > 0 || this._inFlight || this._pendingWake.length > 0);
    if (!hasPendingWakeWork) {
      this._cvFedUpToGlobalSample = this._rawTotalSamples;
      this._legacyFedUpToGlobalSample = this._rawTotalSamples;
      if (explicitExit) {
        this._lastEmittedEndSample = Math.max(this._lastEmittedEndSample, this._rawTotalSamples);
        this._lastMatchedBySlot.clear();
      }
    }
    if (this._cvPendingEmitCount === 0) {
      this._resetClearVoiceState();
    } else {
      this._cvChunker?.setIncompleteUtteranceHint(false);
      this._cvChunker?.reset();
    }
    if (
      this._cvPendingEmitCount === 0 &&
      !this._cvInFlight &&
      this._cvSliceQueue.length === 0 &&
      !this._inFlight &&
      this._pendingWake.length === 0 &&
      this._pendingNormalQueue.length === 0
    ) {
      const resolvers = this._idleResolvers;
      this._idleResolvers = [];
      for (const r of resolvers) r();
    }
  }

  private _prepareClearVoiceForLiveInput(): void {
    this._ensureClearVoicePipeline();
    const chunker = this._cvChunker!;
    if (this._cvPendingEmitCount === 0 && !this._cvInFlight && this._cvSliceQueue.length === 0) {
      this._resetClearVoiceState();
    } else if (!chunker.inUtterance) {
      chunker.setIncompleteUtteranceHint(false);
      chunker.reset();
    } else {
      return;
    }
    const lookbackCtxSamples = Math.round(
      TARGET_SR * ((this._opts.clearVoiceLookbackMs ?? 300) / 1000),
    );
    const earliest = Math.max(0, this._rawTotalSamples - RAW_RING_CAPACITY);
    const preStart = Math.max(earliest, this._rawTotalSamples - lookbackCtxSamples);
    const preContext =
      preStart < this._rawTotalSamples
        ? this._readRingRange(this._rawRing, this._rawTotalSamples, preStart, this._rawTotalSamples)
        : new Float32Array(0);
    this._cvBaseGlobalSample = this._rawTotalSamples - preContext.length - chunker.totalSamples;
    if (preContext.length > 0) {
      chunker.seedContext(preContext);
    }
    this._cvFedUpToGlobalSample = this._rawTotalSamples;
  }

  private _activateClearVoiceFromWake(
    hit: WakeWordAcousticHit | null,
    replayMs?: number,
  ): void {
    this._ensureClearVoicePipeline();
    const chunker = this._cvChunker!;
    const anchorEnd = hit && hit.sampleOffset > 0 ? hit.sampleOffset : this._rawTotalSamples;
    const replayStart = this._computeWakeReplayStartSample(anchorEnd, replayMs);

    // 若已处于连续对话态且 ClearVoice 正在持续收音同一话语，仅附加唤醒元数据，不打断已积累切片
    if (this._opts.isInConversation?.() && chunker.inUtterance) {
      this._cvWakeAnchored = true;
      if (hit) this._cvWakeHit = hit;
      this._wakeAnchorSample = this._wakeAnchorSample ?? replayStart;
      if (hit) this._wakeAnchorHit = hit;
      return;
    }

    if (this._cvPendingEmitCount === 0 && !this._cvInFlight && this._cvSliceQueue.length === 0) {
      this._resetClearVoiceState();
    } else {
      chunker.setIncompleteUtteranceHint(false);
      chunker.reset();
    }

    this._cvWakeAnchored = true;
    this._cvWakeHit = hit;
    this._wakeAnchorSample = replayStart;
    this._wakeAnchorHit = hit;
    this._wasAwake = true;

    const lookbackCtxSamples = Math.round(
      TARGET_SR * ((this._opts.clearVoiceLookbackMs ?? 300) / 1000),
    );
    const earliestAvailable = Math.max(0, this._rawTotalSamples - RAW_RING_CAPACITY);
    const preContextStart = Math.max(earliestAvailable, replayStart - lookbackCtxSamples);
    const preContext =
      preContextStart < replayStart
        ? this._readRingRange(this._rawRing, this._rawTotalSamples, preContextStart, replayStart)
        : new Float32Array(0);

    this._cvBaseGlobalSample = replayStart - preContext.length - chunker.totalSamples;
    if (preContext.length > 0) {
      chunker.seedContext(preContext);
    }

    const bufferedAudio = this._readRingRange(
      this._rawRing,
      this._rawTotalSamples,
      replayStart,
      this._rawTotalSamples,
    );
    this._cvFedUpToGlobalSample = this._rawTotalSamples;

    let emittedCount = 0;
    if (bufferedAudio.length > 0) {
      const chunks = chunker.pushSamples(bufferedAudio);
      emittedCount = chunks.length;
      this._handleClearVoiceChunks(chunks);
    }

    if (emittedCount === 0 && !chunker.inUtterance && bufferedAudio.length > 0) {
      chunker.ensureUtteranceActive(bufferedAudio.length);
    }
  }

  private _handleClearVoiceChunks(chunks: ClearVoiceChunkDescriptor[]): void {
    for (const ch of chunks) {
      const startGlobalSample = Math.max(0, this._cvBaseGlobalSample + ch.startSample);
      const endGlobalSample = Math.max(startGlobalSample, this._cvBaseGlobalSample + ch.endSample);
      let utteranceMeta: ClearVoiceUtteranceMeta | undefined;
      if (ch.utteranceEnded) {
        utteranceMeta = {
          wakeAnchored: this._cvWakeAnchored || this._wakeAnchorSample !== null,
          acousticWake: this._cvWakeHit ?? this._wakeAnchorHit ?? null,
          endGlobalSample,
        };
        this._cvPendingEmitCount += 1;
        this._cvWakeAnchored = false;
        this._cvWakeHit = null;
        this._wakeAnchorSample = null;
        this._wakeAnchorHit = null;
      }
      this._enqueueClearVoiceSlice({
        chunk: ch,
        startGlobalSample,
        wakeAuthorized: this.isAwake || Boolean(utteranceMeta?.wakeAnchored),
        utteranceMeta,
      });
    }
  }

  private _replayPostWakeGapIfNeeded(): void {
    if (this._disposed || !this._opts.isInConversation?.()) return;
    if (this._lastEmittedEndSample <= 0 || this._rawTotalSamples <= this._lastEmittedEndSample) {
      return;
    }
    const gapStart = Math.max(
      this._lastEmittedEndSample,
      this._rawTotalSamples - POST_WAKE_GAP_REPLAY_MAX_SAMPLES,
    );
    if (this._voicePipelineMode === "clearvoice") {
      const effectiveStart = Math.max(gapStart, this._cvFedUpToGlobalSample);
      if (this._rawTotalSamples - effectiveStart < 512) return;
      this._ensureClearVoicePipeline();
      const chunker = this._cvChunker!;
      if (!chunker.inUtterance) {
        const lookbackCtxSamples = Math.round(
          TARGET_SR * ((this._opts.clearVoiceLookbackMs ?? 300) / 1000),
        );
        const earliest = Math.max(0, this._rawTotalSamples - RAW_RING_CAPACITY);
        const preStart = Math.max(earliest, effectiveStart - lookbackCtxSamples);
        const preCtx =
          preStart < effectiveStart
            ? this._readRingRange(this._rawRing, this._rawTotalSamples, preStart, effectiveStart)
            : new Float32Array(0);
        this._cvBaseGlobalSample = effectiveStart - preCtx.length - chunker.totalSamples;
        if (preCtx.length > 0) {
          chunker.seedContext(preCtx);
        }
      }
      const gapAudio = this._readRingRange(
        this._rawRing,
        this._rawTotalSamples,
        effectiveStart,
        this._rawTotalSamples,
      );
      this._cvFedUpToGlobalSample = this._rawTotalSamples;
      if (gapAudio.length > 0) {
        const chunks = chunker.pushSamples(gapAudio);
        this._handleClearVoiceChunks(chunks);
      }
      return;
    }

    if (this._vad && !this._vadDetected && this._wakeAnchorSample === null) {
      const effectiveStart = Math.max(gapStart, this._legacyFedUpToGlobalSample);
      const gapLen = this._rawTotalSamples - effectiveStart;
      if (gapLen >= 512 && this._denTotalSamples >= gapLen) {
        const denGap = this._readRingTail(this._denRing, this._denTotalSamples, gapLen);
        this._denoisedPending = new Float32Array(0);
        this._legacyFedUpToGlobalSample = this._rawTotalSamples;
        this._resetVadState(denGap.length);
        this._processLegacyVadChunk(denGap);
      } else {
        this._legacyFedUpToGlobalSample = this._rawTotalSamples;
      }
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
    if (!this._cvTrackTracker) {
      const sliceSilenceMs = this._opts.clearVoiceSilenceMs ?? 280;
      const utteranceSilenceMs = Math.max(
        sliceSilenceMs,
        this._opts.clearVoiceUtteranceSilenceMs ?? this._utteranceSilenceMs,
      );
      this._cvTrackTracker = new ClearVoiceMultiTrackEndpointTracker({
        sampleRate: TARGET_SR,
        frameSizeMs: 32,
        utteranceSilenceMs,
        longUtteranceThresholdMs: Math.round(LONG_UTTERANCE_THRESHOLD_SEC * 1000),
        longUtteranceExtraSilenceMs: this._longUtteranceExtraSilenceMs,
        incompleteGraceMs: this._incompleteGraceMs,
        maxTrackUtteranceMs: Math.round((this._clearVoiceMaxUtteranceSamples / TARGET_SR) * 1000),
        maxChunkMs: this._opts.clearVoiceMaxChunkMs ?? 2000,
        vadFactory: () =>
          this._opts.localEngine.createStreamingVad({
            threshold: this._opts.vadThreshold ?? 0.4,
            minSilenceDuration: 0.064,
            minSpeechDuration: 0.064,
            maxSpeechDuration: MAX_UTTERANCE_SEC,
          }),
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
    this._cvPendingEmitCount = 0;
    this._cvAnyTrackDrainedInUtterance = false;
    this._cvChunker?.setIncompleteUtteranceHint(false);
    this._cvChunker?.setAdaptiveMaxChunkMs(null);
    this._cvChunker?.reset();
    this._cvAssembler?.reset();
    this._cvTrackTracker?.reset();
    if (!this._cvInFlight) {
      const resolvers = this._cvIdleResolvers;
      this._cvIdleResolvers = [];
      for (const r of resolvers) r();
    }
  }

  private _enqueueClearVoiceSlice(item: ClearVoiceQueuedSlice): void {
    if (this._disposed) return;
    if (this._cvSliceQueue.length >= 16) {
      const dropped = this._cvSliceQueue.shift();
      if (dropped?.chunk.utteranceEnded) {
        this._cvPendingEmitCount = Math.max(0, this._cvPendingEmitCount - 1);
      }
      this._droppedStaleCount += 1;
    }
    this._cvSliceQueue.push(item);
    this._pumpClearVoiceQueue();
  }

  private _pumpClearVoiceQueue(): void {
    if (this._cvInFlight || this._disposed) return;
    const item = this._cvSliceQueue.shift();
    if (!item) {
      const resolvers = this._cvIdleResolvers;
      this._cvIdleResolvers = [];
      for (const r of resolvers) r();
      return;
    }
    const next = item.chunk;

    this._cvInFlight = true;
    const gen = this._cvGen;
    void Promise.resolve()
      .then(async () => {
        if (this._disposed || gen !== this._cvGen) return;
        this._ensureClearVoicePipeline();
        const assembler = this._cvAssembler!;

        // 整句静默观察期结束信号（音频已在 280ms 切片时完成 GPU 盲源分离与分轨降噪拼接，零额外 GPU 推理开销直接交付）
        if (next.rawNewSamples.length === 0 && next.utteranceEnded) {
          this._emitClearVoiceUtterance(next.triggerReason, item.utteranceMeta);
          return;
        }

        if (this._cvUtteranceStartSample === null) {
          this._cvUtteranceStartSample = item.startGlobalSample;
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
                res.provider === "remote"
                  ? "clearvoice-mossformer2-bss-se-remote"
                  : res.device === "gpu"
                    ? "clearvoice-mossformer2-bss-se-gpu"
                    : "clearvoice-mossformer2-bss-se-cpu";
            } else {
              this._cvLastEngine =
                res.provider === "remote"
                  ? "clearvoice-mossformer2-remote"
                  : res.device === "gpu"
                    ? "clearvoice-mossformer2-gpu"
                    : "clearvoice-mossformer2-cpu";
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
        // 持续电视长时段播放期间限制原始混音分片缓冲上限，避免内存随播放时长无限增长
        const maxRawBufferedSamples = this._clearVoiceMaxUtteranceSamples + TARGET_SR * 4;
        let rawBuffered = 0;
        for (const chunk of this._cvRawChunks) {
          rawBuffered += chunk.length;
        }
        while (rawBuffered > maxRawBufferedSamples && this._cvRawChunks.length > 1) {
          const removed = this._cvRawChunks.shift()!;
          rawBuffered -= removed.length;
        }

        // 阶段 3（跨切片 PIT 置换对齐 + 裁掉前 0.3s 历史输出）+ 阶段 4（每轨独立 20ms 线性交叉淡入淡出 Overlap-Add）
        const appendRes = assembler.appendSeparatedSlice({
          tracksWithContext: separatedSliceTracks,
          lookbackSamples: next.lookbackSamples,
          newSamples: next.rawNewSamples.length,
          applyCrossfade: next.needsCrossfade,
        });

        const tracker = this._cvTrackTracker!;
        const slotStartLocalSamples = appendRes.trimmedSlices.map((sl, idx) =>
          Math.max(0, assembler.getSlotLength(idx) - sl.length),
        );

        // 若话语仍在继续（2.0s 增量切片或 280ms 短停顿增量降噪切片）：
        // 1) 推进分轨独立端点检测状态机：一旦某条音轨（如用户真实命令）已说完并达到尾静音判停，
        //    即便另一条音轨（如电视）仍在持续发声导致混合音频 VAD 无法结束，也立刻独立出段执行！
        // 2) 仅在已唤醒/授权态且无切片积压时，对仍在说话的分离音轨独立做实时流式字幕预览与分轨未闭合宽限提示；
        // 3) 单轨达到 30s 安全上限时兜底提交；多轨由分轨独立 30s 上限各自提交，绝不连带腰斩另一条活跃音轨。
        if (!next.utteranceEnded) {
          const trackStep = tracker.ingestAlignedSlices(appendRes.trimmedSlices, {
            sliceStartGlobalSample: item.startGlobalSample,
            slotStartLocalSamples,
          });

          // 多轨场景下另一条新说话人音轨刚刚开声（如持续电视背景中用户突然开始说指令）时，
          // 刷新说话活动通知，避免混合 VAD 长期常亮触发对话超时防截断过期。
          if (
            appendRes.trackCount > 1 &&
            assembler.sliceCount > 1 &&
            trackStep.newlyStartedSlots.some((slotIdx) => tracker.hasOtherActiveSpeech(slotIdx))
          ) {
            this._opts.onSpeechActivity?.(false);
            this._opts.onSpeechActivity?.(true);
          }

          // 分轨独立提前出段：先基于未 drain 的对齐多轨音频完成同时间窗反镜像串音校验，再逐轨独立 drain 并派发！
          if (trackStep.readySlots.length > 0) {
            const pendingEmitItems: Array<{
              ready: ClearVoiceReadyTrackSlot;
              audio: Float32Array;
              otherEnergySum: number;
              isGhost: boolean;
            }> = [];

            for (const ready of trackStep.readySlots) {
              const slotAudio = assembler.getSlotAudio(ready.slotIndex);
              const safeStart = Math.max(0, Math.min(slotAudio.length, ready.trimStartLocalSample));
              const safeEnd = Math.max(safeStart, Math.min(slotAudio.length, ready.trimEndLocalSample));
              const candidateAudio = slotAudio.slice(safeStart, safeEnd);
              const distFromEndStart = slotAudio.length - safeStart;
              const distFromEndEnd = slotAudio.length - safeEnd;
              let isGhost = false;
              let otherEnergySum = 0;

              for (let j = 0; j < assembler.trackSlotCount; j += 1) {
                if (j === ready.slotIndex) continue;
                const otherAudio = assembler.getSlotAudio(j);
                const jStart = otherAudio.length - distFromEndStart;
                const jEnd = otherAudio.length - distFromEndEnd;
                const clampedJStart = Math.max(0, jStart);
                const clampedJEnd = Math.min(otherAudio.length, jEnd);
                const overlapLen = clampedJEnd - clampedJStart;
                if (overlapLen >= 1600) {
                  const candOffset = clampedJStart - jStart;
                  const candOverlap = candidateAudio.subarray(
                    Math.max(0, candOffset),
                    Math.min(candidateAudio.length, candOffset + overlapLen),
                  );
                  const otherOverlap = otherAudio.subarray(
                    clampedJStart,
                    Math.min(clampedJEnd, clampedJStart + candOverlap.length),
                  );
                  if (candOverlap.length >= 1600 && otherOverlap.length >= 1600) {
                    const otherRms = computeRms(otherOverlap);
                    otherEnergySum += otherRms * otherRms;
                    const check = pruneInactiveOrDuplicateTracks([otherOverlap, candOverlap]);
                    const keptCandidate = check.tracks.some((t) => t.sourceSlot === 1);
                    if (!keptCandidate) {
                      isGhost = true;
                      break;
                    }
                  }
                }
              }

              pendingEmitItems.push({
                ready,
                audio: candidateAudio,
                otherEnergySum,
                isGhost,
              });
            }

            for (const em of pendingEmitItems) {
              assembler.drainTrackSlot(em.ready.slotIndex);
              tracker.resetSlot(em.ready.slotIndex);
              this._cvAnyTrackDrainedInUtterance = true;
              if (!em.isGhost && em.audio.length >= Math.round(TARGET_SR * 0.14)) {
                this._emitClearVoiceSingleTrack(em.ready, em.audio, em.otherEnergySum);
              }
            }
          }

          // 压缩长期空闲静音的槽位（仅保留 160ms pre-roll），防止持续电视期间空闲槽位堆积死静音
          if (appendRes.trackCount > 1) {
            const maxIdleSamples = tracker.preRollSamples * 4;
            for (let i = 0; i < assembler.trackSlotCount; i += 1) {
              const snap = tracker.getSlotSnapshot(i);
              if (snap && !snap.hasSpeech && assembler.getSlotLength(i) > maxIdleSamples) {
                const compactedLen = assembler.compactIdleSlot(i, tracker.preRollSamples);
                tracker.syncSlotLocalLength(i, compactedLen);
              }
            }
          }

          const previewAllowed =
            this._streamingAsrEnabled &&
            (!this._wakeGatedAsr || item.wakeAuthorized || this.isAwake);
          if (previewAllowed && assembler.totalSamples >= TARGET_SR * 0.4) {
            try {
              const status = this._opts.localEngine.getStatus();
              const allowPreview =
                status.readyForLocalAsr &&
                this._cvSliceQueue.length < 2 &&
                (status.activeQwen3Device === "gpu" ||
                  status.activeQwen3Device === "remote" ||
                  this._cvSliceQueue.length === 0);
              if (allowPreview) {
                const prunedPreview = assembler.getTracks({ prune: true });
                const totalPreviewTracks = prunedPreview.tracks.length;
                const rawPreviewEntries: Array<{
                  trackId: string;
                  trackIndex: number;
                  sourceSlot: number;
                  text: string;
                  energyRatio: number;
                  engine: string;
                  durationMs: number;
                  acousticEvent: string;
                }> = [];
                let previewEngine = "qwen3-asr-stream";
                let previewLatencyMs = 0;
                const maxPreviewSamples = TARGET_SR * 8;

                const effectivePreviewTrackCount = Math.max(
                  totalPreviewTracks,
                  assembler.trackSlotCount,
                );

                for (const tr of prunedPreview.tracks) {
                  const displayIndex =
                    this._cvAnyTrackDrainedInUtterance || assembler.trackSlotCount > 1
                      ? tr.sourceSlot + 1
                      : tr.trackIndex;
                  const trackId = `cv_track_${displayIndex}`;
                  // 当前对话内已被屏蔽的背景音/旁白/噪音/电视音轨：直接跳过语音转文字（零 ASR 开销）
                  if (
                    effectivePreviewTrackCount > 1 &&
                    this._trackMuteManager.isTrackMuted(
                      { trackId, trackIndex: displayIndex, sourceSlot: tr.sourceSlot },
                      effectivePreviewTrackCount,
                    )
                  ) {
                    tracker.setSlotIncompleteHint(tr.sourceSlot, false);
                    continue;
                  }
                  const slotSnap = tracker.getSlotSnapshot(tr.sourceSlot);
                  if (
                    this._cvAnyTrackDrainedInUtterance &&
                    slotSnap &&
                    !slotSnap.hasSpeech
                  ) {
                    continue;
                  }
                  const activeStart =
                    slotSnap?.hasSpeech && slotSnap.utteranceStartLocalSample !== null
                      ? Math.max(0, Math.min(tr.samples.length, slotSnap.utteranceStartLocalSample))
                      : 0;
                  const activeView = activeStart > 0 ? tr.samples.subarray(activeStart) : tr.samples;
                  if (activeView.length < TARGET_SR * 0.35) continue;
                  // 预览字幕限制至近 8 秒尾窗，避免 20s+ 持续电视轨拖慢实时切片队列
                  const previewAudio =
                    activeView.length > maxPreviewSamples
                      ? activeView.subarray(activeView.length - maxPreviewSamples)
                      : activeView;
                  const asrRes = await this._opts.localEngine.transcribeLocal(
                    previewAudio,
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
                  rawPreviewEntries.push({
                    trackId,
                    trackIndex: displayIndex,
                    sourceSlot: tr.sourceSlot,
                    text: cleanedText,
                    energyRatio: tr.energyRatio,
                    engine: asrRes.engine,
                    durationMs: asrRes.durationMs,
                    acousticEvent: asrRes.event,
                  });
                }

                // 多轨场景下转换出来的文字超出 20 字后，由 SystemOne 判别背景音/旁白/噪音/电视并即时在当前对话内屏蔽该音轨
                if (effectivePreviewTrackCount > 1 && rawPreviewEntries.length > 0) {
                  const preEpoch = this._opts.getDialogEpoch?.();
                  await this._trackMuteManager.evaluateTracks(
                    rawPreviewEntries.map((e) => ({
                      trackId: e.trackId,
                      trackIndex: e.trackIndex,
                      sourceSlot: e.sourceSlot,
                      text: e.text,
                      acousticEvent: e.acousticEvent,
                    })),
                    {
                      totalTracksInBatch: effectivePreviewTrackCount,
                      mode: "preview",
                      systemOneClient: this._opts.getSystemOneClient?.() ?? null,
                      wakeWords: this._wakeWords,
                      recentHistory: this._opts.getRecentHistory?.(),
                      isStale: () =>
                        this._disposed ||
                        gen !== this._cvGen ||
                        (preEpoch !== undefined && this._opts.getDialogEpoch?.() !== preEpoch),
                    },
                  );
                  if (this._disposed || gen !== this._cvGen) return;
                }

                const previewTracks: Array<{
                  trackId: string;
                  trackIndex: number;
                  text: string;
                  energyRatio?: number;
                }> = [];
                let primaryPartial: StreamingPartialUpdate | null = null;
                let anyIncomplete = false;

                for (const entry of rawPreviewEntries) {
                  if (
                    effectivePreviewTrackCount > 1 &&
                    this._trackMuteManager.isTrackMuted(
                      {
                        trackId: entry.trackId,
                        trackIndex: entry.trackIndex,
                        sourceSlot: entry.sourceSlot,
                      },
                      effectivePreviewTrackCount,
                    )
                  ) {
                    tracker.setSlotIncompleteHint(entry.sourceSlot, false);
                    continue;
                  }
                  previewTracks.push({
                    trackId: entry.trackId,
                    trackIndex: entry.trackIndex,
                    text: entry.text,
                    energyRatio: entry.energyRatio,
                  });
                  const trackIncomplete = looksLikeIncompleteUtterance(entry.text, this._wakeWords);
                  tracker.setSlotIncompleteHint(entry.sourceSlot, trackIncomplete);
                  if (trackIncomplete) {
                    anyIncomplete = true;
                  }
                  if (primaryPartial === null) {
                    const ingested = this._streamTracker.ingestHypothesis(entry.text, {
                      engine: entry.engine,
                      latencyMs: entry.durationMs,
                    });
                    if (this._streamTracker.isLatestIncomplete) {
                      tracker.setSlotIncompleteHint(entry.sourceSlot, true);
                      anyIncomplete = true;
                    }
                    if (ingested.partial) {
                      primaryPartial = ingested.partial;
                    }
                  }
                }

                // 单轨时保持原未闭合整句宽限；多轨时仅由各轨独立 incompleteHint 控制，防止电视未闭合语段拖延用户轨！
                this._cvChunker?.setIncompleteUtteranceHint(
                  assembler.trackSlotCount <= 1 ? anyIncomplete : false,
                );
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

          // 若已有某轨停说进入静默倒计时而另一条电视轨仍在发声，动态缩短下一切片步进以降低用户命令执行延迟
          this._cvChunker?.setAdaptiveMaxChunkMs(tracker.computeAdaptiveNextChunkMs());

          // 单轨安全上限：连续话语达到上限（默认 30s）时自动提交（多轨已由分轨独立 track_timeout 单独处理，绝不误斩另一轨）
          if (
            assembler.trackSlotCount <= 1 &&
            assembler.totalSamples >= this._clearVoiceMaxUtteranceSamples
          ) {
            const timeoutMeta: ClearVoiceUtteranceMeta = {
              wakeAnchored: this._cvWakeAnchored || this._wakeAnchorSample !== null,
              acousticWake: this._cvWakeHit ?? this._wakeAnchorHit ?? null,
              endGlobalSample: this._rawTotalSamples,
            };
            this._cvWakeAnchored = false;
            this._cvWakeHit = null;
            this._wakeAnchorSample = null;
            this._wakeAnchorHit = null;
            this._emitClearVoiceUtterance("timeout", timeoutMeta, false);
          }
          return;
        }

        // 整句静音判停或 flush：若此前曾有分轨独立出段，也推进本尾片分轨状态确保只提交尚未出段的有效音轨
        if (this._cvAnyTrackDrainedInUtterance) {
          tracker.ingestAlignedSlices(appendRes.trimmedSlices, {
            sliceStartGlobalSample: item.startGlobalSample,
            slotStartLocalSamples,
          });
        }
        this._emitClearVoiceUtterance(next.triggerReason, item.utteranceMeta);
      })
      .catch(() => {
        if (next.utteranceEnded) {
          this._cvPendingEmitCount = Math.max(0, this._cvPendingEmitCount - 1);
        }
        // 单个切片异常不中断连续流会话
      })
      .finally(() => {
        this._cvInFlight = false;
        this._pumpClearVoiceQueue();
      });
  }

  /**
   * 多轨场景下独立提交单条已说完（或达单轨上限）的分离音轨：
   * - 不重置 ClearVoiceMultiTrackAssembler 与其余仍在发声的音轨（如持续电视）；
   * - 保留待机唤醒锚定上下文，由 _pumpQueue 在命中有效指令或超时后统一清理。
   */
  private _emitClearVoiceSingleTrack(
    ready: ClearVoiceReadyTrackSlot,
    trackAudio: Float32Array,
    otherAlignedEnergySum: number,
  ): void {
    if (this._disposed || trackAudio.length < Math.round(TARGET_SR * 0.14)) {
      return;
    }
    const assembler = this._cvAssembler;
    const rawFromRing =
      ready.endGlobalSample > ready.startGlobalSample
        ? this._readRingRange(
            this._rawRing,
            this._rawTotalSamples,
            ready.startGlobalSample,
            ready.endGlobalSample,
          )
        : new Float32Array(0);
    const rawSlice =
      rawFromRing.length >= Math.round(TARGET_SR * 0.14) ? rawFromRing : trackAudio;

    const inputSnrDb = estimateSnrDb(rawSlice, TARGET_SR);
    const outSnr = estimateSnrDb(trackAudio, TARGET_SR);
    const rms = computeRms(trackAudio);
    const trEnergy = rms * rms;
    const totalEnergy = trEnergy + Math.max(0, otherAlignedEnergySum);
    const energyRatio = totalEnergy > 1e-12 ? trEnergy / totalEnergy : 1;
    const trackIndex = ready.slotIndex + 1;
    const trackId = `cv_track_${trackIndex}`;

    const separatedTrack: VoiceStreamSeparatedTrack = {
      trackId,
      trackIndex,
      sourceSlot: ready.slotIndex,
      samples: trackAudio,
      sampleRate: TARGET_SR,
      rms: Number(rms.toFixed(5)),
      energyRatio: Number(energyRatio.toFixed(4)),
      outputSnrDb: outSnr,
      snrGainDb: Number((outSnr - inputSnrDb).toFixed(2)),
    };

    const wakeAnchored = Boolean(this._cvWakeAnchored || this._wakeAnchorSample !== null);
    const acousticWake = this._cvWakeHit ?? this._wakeAnchorHit ?? null;
    const triggerReason: ClearVoiceTriggerReason =
      ready.reason === "track_timeout" ? "timeout" : "silence";

    this._lastEmittedEndSample = Math.max(this._lastEmittedEndSample, ready.endGlobalSample);

    const payload: VoiceStreamSegmentPayload = {
      rawSamples: rawSlice,
      denoisedSamples: trackAudio,
      separatedTracks: [separatedTrack],
      denoiseEngine: this._cvLastEngine,
      inputSnrDb,
      outputSnrDb: outSnr,
      snrGainDb: separatedTrack.snrGainDb,
      startSec: Number((ready.startGlobalSample / TARGET_SR).toFixed(2)),
      durationSec: Number((trackAudio.length / TARGET_SR).toFixed(2)),
      forcedRoll: ready.reason === "track_timeout",
      acousticWake,
      wakeAnchored,
      commitReason: ready.reason === "track_timeout" ? "max_duration" : "vad_silence",
      pipelineMode: "clearvoice",
      clearVoiceMeta: {
        sliceCount: assembler?.sliceCount ?? 1,
        crossfadeCount: assembler?.crossfadeCount ?? 0,
        triggerReason,
        denoiseMs: Math.round(this._cvTotalDenoiseMs),
        ssMs: Math.round(this._cvTotalSsMs),
        seMs: Math.round(this._cvTotalSeMs),
        trackCount: 1,
        bssUsed: this._cvBssUsed,
        permutationSwaps: (assembler?.permutationSwaps ?? 0) + this._cvServerSwaps,
        gpuName: this._cvLastGpuName,
        independentTrackEmit: true,
        sourceSlot: ready.slotIndex,
      },
    };
    this._enqueueSegment(payload);
  }

  private _emitClearVoiceUtterance(
    triggerReason: ClearVoiceTriggerReason,
    utteranceMeta?: ClearVoiceUtteranceMeta,
    decrementPendingCount = true,
  ): void {
    if (decrementPendingCount && utteranceMeta) {
      this._cvPendingEmitCount = Math.max(0, this._cvPendingEmitCount - 1);
    }
    const assembler = this._cvAssembler;
    const tracker = this._cvTrackTracker;
    const anyDrained = this._cvAnyTrackDrainedInUtterance;
    this._cvChunker?.setIncompleteUtteranceHint(false);
    this._cvChunker?.setAdaptiveMaxChunkMs(null);
    if (!assembler || assembler.totalSamples < Math.round(TARGET_SR * 0.14)) {
      this._cvAssembler?.reset();
      this._cvTrackTracker?.reset();
      this._cvAnyTrackDrainedInUtterance = false;
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

    const sliceCount = assembler.sliceCount;
    const crossfadeCount = assembler.crossfadeCount;
    const permutationSwaps = assembler.permutationSwaps + this._cvServerSwaps;
    const denoiseMs = Math.round(this._cvTotalDenoiseMs);
    const ssMs = Math.round(this._cvTotalSsMs);
    const seMs = Math.round(this._cvTotalSeMs);
    const bssUsed = this._cvBssUsed;
    let startSample = this._cvUtteranceStartSample ?? 0;

    interface FinalTrackDraft {
      trackIndex: number;
      sourceSlot: number;
      samples: Float32Array;
      rms: number;
      energyRatio: number;
    }
    let finalTracks: FinalTrackDraft[] = [];

    if (anyDrained && tracker) {
      // 已有音轨在本轮提前独立出段：仅提交剩余尚未出段且包含有效语音的音轨，彻底避免已执行音轨被重复触发！
      const minEmitSamples = Math.round(TARGET_SR * 0.14);
      const snapshots = tracker.getAllSlotSnapshots();
      const candidates: Array<{
        slotIndex: number;
        samples: Float32Array;
        startGlobalSample: number | null;
      }> = [];
      for (const snap of snapshots) {
        if (!snap.hasSpeech || snap.speechSamples < tracker.minSpeechSamples) {
          continue;
        }
        const slotAudio = assembler.getSlotAudio(snap.slotIndex);
        if (slotAudio.length < minEmitSamples) {
          continue;
        }
        const trimStart = Math.max(0, Math.min(slotAudio.length, snap.utteranceStartLocalSample ?? 0));
        const trimEnd = Math.max(
          trimStart,
          Math.min(
            slotAudio.length,
            triggerReason === "silence"
              ? snap.lastSpeechEndLocalSample + tracker.tailPadSamples
              : slotAudio.length,
          ),
        );
        const sliced = slotAudio.slice(trimStart, trimEnd);
        if (sliced.length >= minEmitSamples) {
          candidates.push({
            slotIndex: snap.slotIndex,
            samples: sliced,
            startGlobalSample: snap.utteranceStartGlobalSample,
          });
        }
      }

      if (candidates.length === 1) {
        const c = candidates[0]!;
        const r = computeRms(c.samples);
        finalTracks = [
          {
            trackIndex: c.slotIndex + 1,
            sourceSlot: c.slotIndex,
            samples: c.samples,
            rms: Number(r.toFixed(5)),
            energyRatio: 1,
          },
        ];
        if (c.startGlobalSample !== null) {
          startSample = c.startGlobalSample;
        }
      } else if (candidates.length >= 2) {
        const prunedRem = pruneInactiveOrDuplicateTracks(candidates.map((c) => c.samples));
        let earliestGlobal: number | null = null;
        finalTracks = prunedRem.tracks.map((tr) => {
          const orig = candidates[tr.sourceSlot]!;
          if (
            orig.startGlobalSample !== null &&
            (earliestGlobal === null || orig.startGlobalSample < earliestGlobal)
          ) {
            earliestGlobal = orig.startGlobalSample;
          }
          return {
            trackIndex: orig.slotIndex + 1,
            sourceSlot: orig.slotIndex,
            samples: tr.samples,
            rms: tr.rms,
            energyRatio: tr.energyRatio,
          };
        });
        if (earliestGlobal !== null) {
          startSample = earliestGlobal;
        }
      }
    } else {
      const pruned = assembler.getTracks({ prune: true });
      finalTracks = pruned.tracks.map((tr) => ({
        trackIndex: tr.trackIndex,
        sourceSlot: tr.sourceSlot,
        samples: tr.samples,
        rms: tr.rms,
        energyRatio: tr.energyRatio,
      }));
    }

    const rawLen = this._cvRawChunks.reduce((acc, c) => acc + c.length, 0);
    const endGlobalSample = utteranceMeta?.endGlobalSample ?? startSample + rawLen;
    let rawSlice: Float32Array;
    if (anyDrained && endGlobalSample > startSample) {
      const ranged = this._readRingRange(
        this._rawRing,
        this._rawTotalSamples,
        startSample,
        endGlobalSample,
      );
      rawSlice =
        ranged.length >= Math.round(TARGET_SR * 0.14)
          ? ranged
          : finalTracks[0]?.samples ?? new Float32Array(0);
    } else {
      rawSlice = new Float32Array(rawLen);
      let rawOff = 0;
      for (const c of this._cvRawChunks) {
        rawSlice.set(c, rawOff);
        rawOff += c.length;
      }
    }

    assembler.reset();
    tracker?.reset();
    this._cvAnyTrackDrainedInUtterance = false;
    this._cvRawChunks = [];
    this._cvTotalDenoiseMs = 0;
    this._cvTotalSsMs = 0;
    this._cvTotalSeMs = 0;
    this._cvBssUsed = false;
    this._cvServerSwaps = 0;
    this._cvUtteranceStartSample = null;
    this._streamTracker.reset();
    this._oww?.resetSegmentTracking();
    this._lastEmittedEndSample = Math.max(this._lastEmittedEndSample, endGlobalSample);
    if (this._ownsTrackMuteManager) {
      this._trackMuteManager.commitActiveUtterance();
    }

    if (finalTracks.length === 0) {
      return;
    }

    const inputSnrDb = estimateSnrDb(rawSlice, TARGET_SR);
    const separatedTracks: VoiceStreamSeparatedTrack[] = finalTracks.map((tr) => {
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
      acousticWake: utteranceMeta?.acousticWake ?? null,
      wakeAnchored: Boolean(utteranceMeta?.wakeAnchored),
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
        ...(anyDrained && separatedTracks.length === 1
          ? { sourceSlot: primaryTrack.sourceSlot }
          : {}),
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
   * 完整重置 Silero VAD 内部语音状态与残余队列，并精确同步采样原点偏移 `_vadSampleBase`，
   * 彻底杜绝 `vad.clear()` 仅清空已出队段却保留正在进行中的语音缓冲导致“一句话二次识别”，
   * 以及待机跳过 VAD 期间采样时钟偏移问题！
   */
  private _resetVadState(unfedTailSamples = 0): void {
    if (!this._vad) return;
    const globalOrigin = Math.max(0, this._rawTotalSamples - Math.max(0, unfedTailSamples));
    try {
      while (!this._vad.isEmpty()) {
        this._vad.pop();
      }
      if (typeof this._vad.reset === "function") {
        this._vad.reset();
        this._vadSampleBase = globalOrigin;
      } else {
        this._vad.clear();
        this._vadSampleBase = Math.max(0, globalOrigin - this._vadSamplesFed);
      }
    } catch {
      try {
        this._vad.clear();
        this._vadSampleBase = Math.max(0, globalOrigin - this._vadSamplesFed);
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
    this._cvWakeAnchored = false;
    this._cvWakeHit = null;
    this._activeSegmentStartSample = null;
    this._denoisedPending = new Float32Array(0);
    this._lastRawOverlap = new Float32Array(0);
    this._lastDenOverlap = new Float32Array(0);
    this._segmenter.reset();
    this._resetVadState();
    this._resetStreamingState(true);
    this._resetClearVoiceState();
    this._cvFedUpToGlobalSample = this._rawTotalSamples;
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
    const userCurrentlySpeaking =
      this._vadDetected || this._wakeAnchorSample !== null || this._cvWakeAnchored;
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
    if (!this._owwEnabled) {
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
   * 写入 Float32 PCM 样本并实时驱动循环录制缓冲区 + 轻量声学唤醒检测（openWakeWord）；
   * 未唤醒待机期绝不执行实时语音转文字（ClearVoice GPU 切片 / 流式预览 / 分段 ASR 均跳过），
   * 只有被唤醒后才将循环录制缓冲区与后续音频统一送入降噪与语音转文字管线！
   */
  pushFloat32Samples(samples: Float32Array): void {
    if (this._disposed || samples.length === 0) return;
    const pcm16k =
      this._inputRate === TARGET_SR ? samples : resampleLinear(samples, this._inputRate, TARGET_SR);

    // 1. 无论新旧方案，始终持续写入时间对齐的 16kHz 原始循环录制缓冲区（零失真、供唤醒后完整回放）
    const chunkStartGlobalSample = this._rawTotalSamples;
    for (let i = 0; i < pcm16k.length; i += 1) {
      this._rawRing[(this._rawTotalSamples + i) % RAW_RING_CAPACITY] = pcm16k[i]!;
    }
    this._rawTotalSamples += pcm16k.length;

    // 2. Legacy 方案或启用了 openWakeWord 时，维护轻量流式 AGC + 在线降噪轨与声学唤醒检测
    const needLightweightFrontEnd = this._voicePipelineMode === "legacy" || this._oww !== null;
    let denoisedChunk: Float32Array = pcm16k;
    if (needLightweightFrontEnd) {
      const enhancedInput = this._agc ? this._agc.process(pcm16k) : pcm16k;
      const allowOnlineDenoiser =
        this._onlineDenoiser !== null &&
        (this._voicePipelineMode === "legacy" || this._denoiseEngine === "gtcrn");
      if (allowOnlineDenoiser) {
        try {
          const res = this._onlineDenoiser!.run({ samples: enhancedInput, sampleRate: TARGET_SR });
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

      for (let i = 0; i < denoisedChunk.length; i += 1) {
        this._denRing[(this._denTotalSamples + i) % RAW_RING_CAPACITY] = denoisedChunk[i]!;
      }
      this._denTotalSamples += denoisedChunk.length;

      // 实时流式 openWakeWord 声学唤醒检测（80ms 步进，静音自动快路径跳过，零 ASR 开销）
      // 注意：若本帧内命中唤醒词，_handleWakeSpot 会同步回放循环录制缓冲区并更新 _cvFedUpToGlobalSample / _wakeAnchorSample
      if (this._oww) {
        try {
          this._oww.pushSamples(denoisedChunk, this._rawTotalSamples);
        } catch {
          // 声学检测异常不得中断主音频流
        }
      }
    }

    // 3. 同步待机/唤醒状态跃迁，并在未唤醒门控待机期直接返回（零实时转写、零 GPU 切片、零分段 ASR）
    const awakeNow = this.isAwake;
    if (!awakeNow && this._wasAwake) {
      this._wasAwake = false;
      this._onEnterStandby();
    } else if (awakeNow && !this._wasAwake) {
      this._wasAwake = true;
      if (this._opts.isInConversation?.()) {
        if (this._voicePipelineMode === "clearvoice") {
          this._prepareClearVoiceForLiveInput();
        } else {
          this._denoisedPending = new Float32Array(0);
          this._resetVadState(denoisedChunk.length);
        }
      }
    }

    if (this.isWakeGatedStandby) {
      // 待机期间仅维护轻量环境底噪估值（供唤醒后滞回分段器精准识别背景音乐底噪），绝不运行 VAD/ClearVoice/ASR
      const frameRms = computeRms(denoisedChunk);
      this._lastFrameRms = frameRms;
      this._segmenter.process(denoisedChunk.length / TARGET_SR, 0, frameRms);
      return;
    }

    // 4. 新方案（已唤醒或无声学唤醒兜底）：ClearVoice GPU 准实时切片 -> Qwen3-ASR
    if (this._voicePipelineMode === "clearvoice") {
      this._ensureClearVoicePipeline();
      // 若本帧刚触发唤醒并已把循环录制缓冲区（含本帧）完整回放至 _rawTotalSamples，避免重复喂入本帧！
      if (this._cvFedUpToGlobalSample >= this._rawTotalSamples) {
        return;
      }
      let feedSlice = pcm16k;
      if (this._cvFedUpToGlobalSample > chunkStartGlobalSample) {
        feedSlice = pcm16k.subarray(this._cvFedUpToGlobalSample - chunkStartGlobalSample);
      } else if (this._cvFedUpToGlobalSample === 0 && chunkStartGlobalSample === 0) {
        this._cvBaseGlobalSample = 0;
      } else if (this._cvFedUpToGlobalSample < chunkStartGlobalSample && !this._cvChunker!.inUtterance) {
        this._cvBaseGlobalSample = chunkStartGlobalSample - this._cvChunker!.totalSamples;
      }
      this._cvFedUpToGlobalSample = this._rawTotalSamples;
      if (feedSlice.length > 0) {
        const chunks = this._cvChunker!.pushSamples(feedSlice);
        this._handleClearVoiceChunks(chunks);
      }
      return;
    }

    // 5. 原方案（已唤醒或无声学唤醒兜底）：流式 Silero VAD + Home Assistant 滞回分段器 + 流式字幕
    if (this._vad) {
      this._legacyFedUpToGlobalSample = this._rawTotalSamples;
      this._processLegacyVadChunk(denoisedChunk);
    } else {
      // 无 Silero VAD 模型时按 3.2 秒滚动窗口处理
      this._fallbackChunks.push(pcm16k);
      this._fallbackTotal += pcm16k.length;
      if (this._fallbackTotal >= TARGET_SR * 3.2) {
        this._flushFallbackBuffer();
      }
    }
  }

  private _processLegacyVadChunk(denoisedChunk: Float32Array): void {
    if (!this._vad) return;
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
      const remainingAfterFrame = merged.length - (offset + 512);

      if (nowDetected !== this._vadDetected) {
        this._vadDetected = nowDetected;
        this._opts.onSpeechActivity?.(nowDetected);
        if (nowDetected && this._isStreamingAsrAllowed() && this._streamSpeechOriginSample === null) {
          this._streamSpeechOriginSample = Math.max(
            this._lastEmittedEndSample > 0 ? this._lastEmittedEndSample : 0,
            this._rawTotalSamples - remainingAfterFrame - PRE_ROLL_SAMPLES,
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

      // 仅当显式开启 streamingSentenceSplit 且已唤醒授权时，才按句末强标点+短停顿提前截断收句；
      // 默认关闭，等待完整尾静音判停以防慢语速句中停顿被提前强拆。
      if (this._isStreamingAsrAllowed() && this._streamingSentenceSplit) {
        const punctSilenceFloor = Math.max(0.008, this._segmenter.ambientRmsFloor * 1.45);
        const frameHasVoice = nowDetected && frameRms >= punctSilenceFloor;
        const { shouldCommitByPunctPause } = this._streamTracker.advanceFrame(32, frameHasVoice);
        if (
          shouldCommitByPunctPause &&
          !this._streamDecodeInFlight &&
          (this._wakeAnchorSample !== null || this._streamSpeechOriginSample !== null)
        ) {
          this._commitStreamingByPunctPause(remainingAfterFrame);
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
        this._emitWakeAnchoredSegment(false, remainingAfterFrame);
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
          this._rawTotalSamples - remainingAfterFrame - Math.round(TARGET_SR * this._segmenter.speechSeconds),
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
        this._emitSegmenterWindow(true, remainingAfterFrame);
        offset += 512;
        continue;
      }

      if (!step.continuing) {
        if (this._wakeAnchorSample !== null) {
          this._emitWakeAnchoredSegment(step.timedOut, remainingAfterFrame);
        } else if (this._activeSegmentStartSample !== null) {
          const activeLen = this._rawTotalSamples - this._activeSegmentStartSample;
          // 仅在达到安全上限(30s)或高背景音乐中前景长语音回落(>=1.8s)时主动接管切段；
          // 普通安静环境交由 Silero VAD 自然切段，避免音乐节拍起伏被误切为碎段
          if (step.timedOut || (activeLen >= TARGET_SR * 1.8 && this._segmenter.ambientRmsFloor >= 0.015)) {
            this._emitSegmenterWindow(step.timedOut, remainingAfterFrame);
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

    if (this._isStreamingAsrAllowed() && (this._vadDetected || this._wakeAnchorSample !== null)) {
      this._maybeTriggerStreamingDecode();
    }
  }

  /**
   * 标点+短停顿快速断句（例如说出“打开客厅吸顶灯。”后停顿 ~320ms 即刻断句提交，延迟减半）。
   */
  private _commitStreamingByPunctPause(unfedTailSamples = 0): void {
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
    this._cvWakeAnchored = false;
    this._cvWakeHit = null;
    this._activeSegmentStartSample = null;
    this._segmenter.reset();
    this._resetVadState(unfedTailSamples);
    this._resetStreamingState(true);
    this._oww?.resetSegmentTracking();
    this._lastRawOverlap = new Float32Array(0);
    this._lastDenOverlap = new Float32Array(0);

    if (sentences.length === 0) return;

    const rawStart = anchor !== null ? anchor : Math.max(0, origin - PRE_ROLL_SAMPLES);
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
    if (!this._isStreamingAsrAllowed() || this._disposed || this._streamDecodeInFlight || this._inFlight) {
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
    const isRemote = status.activeQwen3Device === "remote";
    const pollMs = this._opts.streamingPollIntervalMs ?? (isGpu ? 360 : isRemote ? 550 : 850);
    const minAudioMs =
      this._opts.streamingPollIntervalMs !== undefined
        ? Math.min(320, pollMs)
        : isGpu
          ? 480
          : isRemote
            ? 560
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
    if (this._disposed || !this._isStreamingAsrAllowed() || this._streamDecodeInFlight) return;
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

  private _emitWakeAnchoredSegment(timedOut: boolean, unfedTailSamples = 0): void {
    const anchor = this._wakeAnchorSample;
    const anchorHit = this._wakeAnchorHit;
    this._wakeAnchorSample = null;
    this._wakeAnchorHit = null;
    this._cvWakeAnchored = false;
    this._cvWakeHit = null;
    this._activeSegmentStartSample = null;
    this._segmenter.reset();

    if (anchor === null) return;

    const rawStart = anchor;
    const rawEnd = this._rawTotalSamples;
    const sliceLen = rawEnd - rawStart;
    if (sliceLen < TARGET_SR * 0.25) return;

    const rawSlice = this._readRingRange(this._rawRing, this._rawTotalSamples, rawStart, rawEnd);
    const denSlice = this._readRingTail(this._denRing, this._denTotalSamples, rawSlice.length);

    this._resetVadState(unfedTailSamples);
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
  private _emitSegmenterWindow(timedOut: boolean, unfedTailSamples = 0): void {
    const segStart = this._activeSegmentStartSample;
    this._activeSegmentStartSample = null;
    if (segStart === null) return;

    const rawStart = Math.max(0, segStart - PRE_ROLL_SAMPLES);
    const rawEnd = this._rawTotalSamples;
    if (rawEnd - rawStart < TARGET_SR * 0.22) return;

    let rawSlice = this._readRingRange(this._rawRing, this._rawTotalSamples, rawStart, rawEnd);
    let denSlice = this._readRingTail(this._denRing, this._denTotalSamples, rawSlice.length);

    this._resetVadState(unfedTailSamples);

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
   * 若处于未唤醒门控待机态，绝不冲刷未唤醒环境音到 ASR，仅等待既有队列完成。
   */
  async flush(): Promise<void> {
    if (this._disposed) return;
    if (this.isWakeGatedStandby) {
      await this.waitForIdle();
      return;
    }
    if (this._voicePipelineMode === "clearvoice") {
      const fallbackMeta: ClearVoiceUtteranceMeta = {
        wakeAnchored: this._cvWakeAnchored || this._wakeAnchorSample !== null,
        acousticWake: this._cvWakeHit ?? this._wakeAnchorHit ?? null,
        endGlobalSample: this._rawTotalSamples,
      };
      const tailChunk = this._cvChunker?.flush();
      if (tailChunk) {
        this._handleClearVoiceChunks([tailChunk]);
      } else {
        this._cvWakeAnchored = false;
        this._cvWakeHit = null;
        this._wakeAnchorSample = null;
        this._wakeAnchorHit = null;
      }
      await this._waitForClearVoiceIdle();
      // 若之前仅触发了超时切分或静音观察期未收尾，主动提交残余已降噪语音
      if (this._cvAssembler && this._cvAssembler.totalSamples > 0) {
        this._emitClearVoiceUtterance("flush", fallbackMeta, false);
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
        // （流式断句产出的独立分句已由 Qwen3StreamingHypothesisTracker 严格去重，豁免时间重叠拦截；
        // ClearVoice 多轨 BSS 仅在同槽位内做时间重叠拦截，严禁因音轨 1 命中而误杀时间重叠的音轨 2！）
        const isCvBssSegment =
          next.pipelineMode === "clearvoice" && Boolean(next.clearVoiceMeta?.bssUsed);
        const cvSlots: number[] = isCvBssSegment
          ? typeof next.clearVoiceMeta?.sourceSlot === "number"
            ? [next.clearVoiceMeta.sourceSlot]
            : next.separatedTracks && next.separatedTracks.length > 0
              ? next.separatedTracks.map((t, idx) => t.sourceSlot ?? idx)
              : [0]
          : [];

        if (!next.wakeAnchored && !next.precomputedTranscript) {
          const nextStart = next.startSec;
          const nextEnd = next.startSec + next.durationSec;
          const isOverlappingRange = (prevStart: number, prevEnd: number): boolean => {
            const overlapStart = Math.max(nextStart, Math.max(0, prevStart));
            const overlapEnd = Math.min(nextEnd, prevEnd);
            const overlapSec = Math.max(0, overlapEnd - overlapStart);
            const overlapRatio = next.durationSec > 0 ? overlapSec / next.durationSec : 0;
            return (
              (next.forcedRoll && nextStart < prevEnd) ||
              overlapRatio >= 0.5 ||
              (nextStart < prevEnd && nextEnd <= prevEnd + 0.35)
            );
          };

          if (isCvBssSegment) {
            if (
              cvSlots.length > 0 &&
              cvSlots.every((slot) => {
                const prev = this._lastMatchedBySlot.get(slot);
                return prev !== undefined && isOverlappingRange(prev.startSec, prev.endSec);
              })
            ) {
              this._droppedStaleCount += 1;
              return;
            }
          } else if (
            this._lastMatchedEndSec >= 0 &&
            isOverlappingRange(this._lastMatchedStartSec, this._lastMatchedEndSec)
          ) {
            this._droppedStaleCount += 1;
            return;
          }
        }

        const res = await this._opts.onSegmentReady(next);
        if (res?.matched) {
          if (isCvBssSegment) {
            const range = { startSec: next.startSec, endSec: next.startSec + next.durationSec };
            for (const slot of cvSlots) {
              this._lastMatchedBySlot.set(slot, range);
            }
          }
          if (!next.clearVoiceMeta?.independentTrackEmit) {
            this._lastMatchedStartSec = next.startSec;
            this._lastMatchedEndSec = next.startSec + next.durationSec;
          }
          this._lastRawOverlap = new Float32Array(0);
          this._lastDenOverlap = new Float32Array(0);
          // 独立分轨唤醒命中后释放待机唤醒锚定（若已切入连续对话则继续保持唤醒，若首句即退出则平稳回归待机）
          if (next.clearVoiceMeta?.independentTrackEmit && this._cvWakeAnchored) {
            this._cvWakeAnchored = false;
            this._cvWakeHit = null;
            this._wakeAnchorSample = null;
            this._wakeAnchorHit = null;
            if (!this.isAwake && this._wasAwake) {
              this._wasAwake = false;
              this._onEnterStandby(true);
            }
          }
          // 唤醒段命中并切入连续对话后，立即回放在异步 ASR 间隙内写入循环录制缓冲区的续说音频，防止首字丢失
          if (this._opts.isInConversation?.()) {
            this._wasAwake = true;
            this._replayPostWakeGapIfNeeded();
          }
        } else if (
          next.clearVoiceMeta?.independentTrackEmit &&
          this._cvWakeAnchored &&
          !this._opts.isInConversation?.() &&
          (next.forcedRoll ||
            (this._wakeAnchorSample !== null &&
              this._rawTotalSamples - this._wakeAnchorSample >= TARGET_SR * 10))
        ) {
          // 持续电视期间若待机声学误唤醒且超过 10s（或达单轨上限）仍无任何音轨命中指令，释放锚定回归待机
          this._cvWakeAnchored = false;
          this._cvWakeHit = null;
          this._wakeAnchorSample = null;
          this._wakeAnchorHit = null;
          if (!this.isAwake && this._wasAwake) {
            this._wasAwake = false;
            this._onEnterStandby(true);
          }
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
    if (this._ownsTrackMuteManager) {
      this._trackMuteManager.reset();
    }
    this._cvChunker = null;
    this._cvAssembler = null;
    this._cvTrackTracker = null;
    this._lastMatchedBySlot.clear();
    this._resetStreamingState(true);
    this._pendingWake = [];
    this._pendingNormalQueue = [];
    this._wakeAnchorSample = null;
    this._wakeAnchorHit = null;
    this._cvWakeAnchored = false;
    this._cvWakeHit = null;
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
