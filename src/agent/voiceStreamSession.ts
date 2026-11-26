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

import type {
  EchoCancellationMode,
  VadSensitivityMode,
  VoicePipelineMode,
} from "../core/agentConfigStore.ts";
import { sanitizeAsrTranscript } from "./asrHallucinationGuard.ts";
import { computeRms, estimateSnrDb, hasAudibleAudioEnergy, resampleLinear } from "./audioPcm.ts";
import { AcousticEchoCanceller } from "./echoCanceller.ts";
import type {
  LocalVoiceEngine,
  OnlineDenoiserHandleLike,
  StreamingVadHandleLike,
} from "./localVoiceEngine.ts";
import type { OpenWakeWordStreamSession, WakeWordAcousticHit } from "./openWakeWordEngine.ts";
import {
  joinUtteranceFragments,
  looksLikeIncompleteUtterance,
  splitStreamingSentences,
  StreamingAsrHypothesisTracker,
  stripCommittedPrefix,
  type StreamingCommitReason,
  type StreamingPartialUpdate,
} from "./streamingAsrTracker.ts";
import {
  StreamingAutoGain,
  vadSensitivityToSeconds,
  VoiceCommandSegmenter,
  WakeWordCooldownGuard,
} from "./voiceCommandSegmenter.ts";
import type { ProcessAudioUploadResult } from "./voiceListenerController.ts";
import { listVoiceprintRefWavPaths } from "./voiceprintStore.ts";
import type { VoiceWsAsrStreamSession } from "./voiceWsAsrRuntime.ts";
import type { XfyunIatV2StreamSession } from "./xfyunIatV2Runtime.ts";

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
  /** 产出该分段的语音前端方案：legacy（本地原方案）或 xfyun（讯飞听写大模型 2.0 原始直推） */
  pipelineMode?: VoicePipelineMode;
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
   * - 未唤醒待机期仅持续写入循环录制缓冲区并运行轻量级 openWakeWord 声学唤醒检测，不执行实时流式 ASR / 分段转写；
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
  /** 是否启用实时流式字幕转写（默认 false 保持非流式兼容，服务端按配置透传） */
  streamingAsrEnabled?: boolean;
  /** 是否在说话中途按标点/短停顿提前拆分为多条句子下发（默认 false：等整段话说完后再一起发给 Pi Agent） */
  streamingSentenceSplit?: boolean;
  /** 语音前端方案：legacy（本地原方案）或 xfyun（讯飞语音听写大模型 2.0 原始直推） */
  voicePipelineMode?: VoicePipelineMode;
  /** 长语音额外停顿宽限（ms，说话累计 >= 3.0s 后自动放宽句中停顿，默认 350ms） */
  longUtteranceExtraSilenceMs?: number;
  /** 语义未闭合额外停顿宽限（ms，如句中停在“然后/把客厅灯”等未说完处，默认 650ms） */
  incompleteGraceMs?: number;
  /** 实时流式字幕增量更新回调 */
  onPartialTranscript?: (ev: StreamingPartialUpdate) => void;
  /** 流式假设刷新最小新音频步进（ms，默认 850ms） */
  streamingPollIntervalMs?: number;
  /** 句末标点+短停顿快速断句静音阈值（ms，仅在显式开启 streamingSentenceSplit 时生效，默认 320ms） */
  streamingPunctuationPauseMs?: number;
  /** 回声消除模式：auto / aggressive（启用服务端兜底参考 AEC）/ standard / off */
  echoCancellationMode?: EchoCancellationMode;
  /** 客户端浏览器 AudioWorklet 是否已启用实时参考信号 AEC（true 时服务端跳过重复声学消除，保留语义防回声） */
  clientAecActive?: boolean;
  /** 服务端兜底 AEC 实时遥测回调 */
  onAecTelemetry?: (telemetry: {
    active: boolean;
    erleDb: number;
    linearErleDb: number;
    estimatedDelayMs: number;
    doubleTalk: boolean;
    farEndActive: boolean;
  }) => void;
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
const DEFAULT_WAKE_RING_LOOKBACK_MS = 1800; // 唤醒后回溯循环录制缓冲区的默认窗口（完整覆盖唤醒词、前导呼唤与紧接词首）
const POST_WAKE_GAP_REPLAY_MAX_SAMPLES = Math.round(TARGET_SR * 1.6);
const MAX_UTTERANCE_SEC = 30.0; // 正常人声/对话/唤醒锚定单句安全上限（避免 3.8s 强行腰斩长语音）
const STANDBY_BGM_ROLL_SEC = 4.2; // 仅待机持续高底噪背景音乐时启用滚动切窗防积压
const CONV_AMBIENT_PROBE_SEC = 2.0; // 对话态连续无停顿时的 CED 声学背景探测窗长（区分真实人声长句 vs 持续歌曲/电视杂音）
const CONV_AMBIENT_PROBE_STEP_SEC = 1.5; // 对话态连续无停顿时的 CED 复检步进（避免因边界采样偏移错过电视群聊窗口）
const LONG_UTTERANCE_THRESHOLD_SEC = 3.0;
const DEFAULT_LONG_UTTERANCE_EXTRA_MS = 350;
const DEFAULT_INCOMPLETE_GRACE_MS = 650;
const OWW_WARMUP_SEED_SAMPLES = 5 * 1280; // 400ms (openWakeWord WARMUP_SUPPRESS_FRAMES=5)
const STANDBY_DPDF_ENGAGE_RMS = 0.014;
const STANDBY_DPDF_RELEASE_RMS = 0.008;
const STANDBY_DPDF_ENGAGE_SAMPLES = Math.round(TARGET_SR * 0.25);
const STANDBY_DPDF_RELEASE_SAMPLES = Math.round(TARGET_SR * 1.5);
const STANDBY_DPDF_PREROLL_SAMPLES = Math.round(TARGET_SR * 0.48);

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
  private _noiseMode: VoiceStreamSessionOptions["noiseMode"];
  private _onlineDenoiser: OnlineDenoiserHandleLike | null;
  private _denoiseEngine: string;
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

  // Legacy 模式下的待机强噪 DPDFNet4 按需增强通道（安静房间零开销，仅高环境噪时介入）
  private _standbyDpdfDenoiser: OnlineDenoiserHandleLike | null = null;
  private _standbyDpdfOww: OpenWakeWordStreamSession | null = null;
  private _standbyDpdfInitAttempted = false;
  private _standbyDpdfActive = false;
  private _standbyDpdfNoisySamples = 0;
  private _standbyDpdfQuietSamples = 0;

  // 实时流式转写与整句保护状态（默认只出实时字幕、不中途强拆多句，等说完统一发送给 Pi Agent）
  private _streamingAsrEnabled: boolean;
  private readonly _streamingSentenceSplit: boolean;
  private _voicePipelineMode: VoicePipelineMode;
  private _utteranceSilenceMs: number;
  private readonly _longUtteranceExtraSilenceMs: number;
  private readonly _incompleteGraceMs: number;
  private readonly _streamTracker: StreamingAsrHypothesisTracker;
  private _heldSegment: HeldLegacySegment | null = null;
  private _streamLastDecodeFullWindow = true;
  private _legacyFedUpToGlobalSample = 0;
  private _streamSpeechOriginSample: number | null = null;
  private _streamLastDecodedEndSample = 0;
  private _streamDecodeInFlight = false;
  private _streamAbort: AbortController | null = null;
  private _streamGen = 0;
  private _streamLastEngine = "";
  private _streamLastLatencyMs = 0;

  // 讯飞语音听写大模型 2.0 方案状态（openWakeWord 唤醒后直推原始 16kHz PCM 至讯飞 WebSocket，不做额外降噪与特殊处理）
  private _xfyunSession: XfyunIatV2StreamSession | null = null;
  private _xfyunGen = 0;
  private _xfyunWakeAnchored = false;
  private _xfyunWakeHit: WakeWordAcousticHit | null = null;
  private _xfyunStartGlobalSample = 0;
  private _xfyunFedUpToGlobalSample = 0;
  private _xfyunUtteranceDuringTts = false;
  private _xfyunRawChunks: Float32Array[] = [];
  private _xfyunRawBufferedSamples = 0;
  private _xfyunIdleNoiseFloor = 0.004;
  private _xfyunOnsetFrames = 0;
  private _xfyunFinishing = false;
  private _xfyunIdleResolvers: Array<() => void> = [];

  // 统一流式语音听写 WebSocket 网关方案状态（openWakeWord 唤醒后直推原始 16kHz PCM Binary 帧，服务端 CPU ONNX GTCRN+Silero VAD -> 流式 ASR）
  private _voiceWsSession: VoiceWsAsrStreamSession | null = null;
  private _voiceWsGen = 0;
  private _voiceWsWakeAnchored = false;
  private _voiceWsWakeHit: WakeWordAcousticHit | null = null;
  private _voiceWsStartGlobalSample = 0;
  private _voiceWsFedUpToGlobalSample = 0;
  private _voiceWsUtteranceDuringTts = false;
  private _voiceWsRawChunks: Float32Array[] = [];
  private _voiceWsRawBufferedSamples = 0;
  private _voiceWsIdleNoiseFloor = 0.004;
  private _voiceWsOnsetFrames = 0;
  private _voiceWsFinishing = false;
  private _voiceWsIdleResolvers: Array<() => void> = [];

  // 双轨时间对齐环形缓冲（Raw + Denoised 同步保留 35 秒，支撑唤醒词锚定极速切段与零重复降噪）
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
  private _lastConvAmbientProbeSample = 0;
  private _wakeAnchorSample: number | null = null;
  private _wakeAnchorHit: WakeWordAcousticHit | null = null;
  private _lastRawOverlap = new Float32Array(0);
  private _lastDenOverlap = new Float32Array(0);
  private _lastMatchedStartSec = -1;
  private _lastMatchedEndSec = -1;
  private _ttsSpeaking = false;
  private _ttsLastEndedAt = 0;
  /** 采集时刻级 TTS 重叠锁存（避免尾静音判停后 _isDuringTtsWindow() 过期丢失回声标记） */
  private _legacyUtteranceDuringTts = false;

  // 服务端兜底实时声学回声消除（仅当客户端 AudioWorklet AEC 未激活且有参考音频输入时介入，绝不与客户端重复消除）
  private _echoCancellationMode: EchoCancellationMode;
  private _clientAecActive: boolean;
  private _serverAec: AcousticEchoCanceller | null = null;
  private _serverAecRefQueue: Float32Array[] = [];
  private _serverAecRefHeadOffset = 0;
  private _serverAecRefQueuedSamples = 0;
  private _serverAecTailActive = false;
  private _serverAecTelemetryTick = 0;
  private _serverAecLastErleDb = 0;
  private _serverAecLastLinearErleDb = 0;
  private _serverAecLastDelayMs = 0;

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
    this._wakeWordEnabled =
      options.wakeWordEnabled !== undefined
        ? Boolean(options.wakeWordEnabled)
        : this._wakeWords.length > 0;
    this._owwEnabled = options.owwEnabled !== false;
    this._wakeGatedAsr = options.wakeGatedAsr !== false;
    this._echoCancellationMode = options.echoCancellationMode ?? "auto";
    this._clientAecActive = options.clientAecActive === true;
    const lookbackMs = Math.max(
      600,
      Math.min(6000, Math.round(options.wakeRingLookbackMs ?? DEFAULT_WAKE_RING_LOOKBACK_MS)),
    );
    this._wakeRingLookbackSamples = Math.round((TARGET_SR * lookbackMs) / 1000);
    this._streamingAsrEnabled = options.streamingAsrEnabled === true;
    this._streamingSentenceSplit = options.streamingSentenceSplit === true;
    this._voicePipelineMode =
      options.voicePipelineMode === "xfyun"
        ? "xfyun"
        : options.voicePipelineMode === "voice-ws"
          ? "voice-ws"
          : "legacy";
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
    this._streamTracker = new StreamingAsrHypothesisTracker({
      wakeWords: this._wakeWords,
      punctuationPauseMs: options.streamingPunctuationPauseMs ?? 320,
      splitMidUtterance: this._streamingSentenceSplit,
      enablePunctuationPauseCommit: this._streamingSentenceSplit,
    });

    this._noiseMode = options.noiseMode;
    const online = options.localEngine.createOnlineDenoiser(this._noiseMode);
    this._onlineDenoiser = online?.denoiser ?? null;
    this._denoiseEngine = online?.engine ?? (this._noiseMode === "off" ? "off" : "dsp");

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
    if (this._xfyunWakeAnchored) return true;
    if (this._xfyunSession !== null) return true;
    if (this._voiceWsWakeAnchored) return true;
    if (this._voiceWsSession !== null) return true;
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
   * 该状态下完全跳过实时流式转写与分段 ASR，待唤醒后再回放循环录制缓冲区及后续音频。
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
    // 唤醒瞬间立刻重置待机 DPDFNet4 通道，释放 CPU 给已唤醒转写管线
    this._resetStandbyDpdfState();

    if (this._voicePipelineMode === "xfyun") {
      if (this._xfyunSession && !this._xfyunFinishing) {
        this._xfyunWakeAnchored = true;
        if (hit && (!this._xfyunWakeHit || hit.score > this._xfyunWakeHit.score)) {
          this._xfyunWakeHit = hit;
          this._wakeAnchorHit = hit;
        }
        return;
      }
      this._activateXfyunFromWake(hit, replayMs);
      return;
    }

    if (this._voicePipelineMode === "voice-ws") {
      if (this._voiceWsSession && !this._voiceWsFinishing) {
        this._voiceWsWakeAnchored = true;
        if (hit && (!this._voiceWsWakeHit || hit.score > this._voiceWsWakeHit.score)) {
          this._voiceWsWakeHit = hit;
          this._wakeAnchorHit = hit;
        }
        return;
      }
      this._activateVoiceWsFromWake(hit, replayMs);
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

  get noiseMode(): VoiceStreamSessionOptions["noiseMode"] {
    return this._noiseMode;
  }

  /**
   * 运行期热切换环境降噪模式（auto / neural / dpdfnet / voxlock / dsp / off），无需重连 WebSocket。
   */
  setNoiseMode(mode: VoiceStreamSessionOptions["noiseMode"]): void {
    if (this._disposed || this._noiseMode === mode) return;
    this._noiseMode = mode;
    const online = this._opts.localEngine.createOnlineDenoiser(mode);
    this._onlineDenoiser = online?.denoiser ?? null;
    this._denoiseEngine = online?.engine ?? (mode === "off" ? "off" : "dsp");
    this._resetStandbyDpdfState(true);
  }

  /**
   * 运行期无缝热切换语音方案（原方案 legacy <-> 讯飞听写大模型 2.0 方案 xfyun <-> 统一流式语音听写网关 voice-ws），
   * 切换后立即清理挂起缓冲，无需断开或重连 WebSocket。
   */
  setVoicePipelineMode(mode: VoicePipelineMode): void {
    const next: VoicePipelineMode =
      mode === "xfyun" ? "xfyun" : mode === "voice-ws" ? "voice-ws" : "legacy";
    if (this._voicePipelineMode === next) return;
    this._voicePipelineMode = next;
    this._clearHeldLegacySegment();
    this._abortXfyunSession(true);
    this._abortVoiceWsSession(true);
    this._resetStandbyDpdfState();
    this._resetVadState();
    this._resetStreamingState(true);
    this._wakeAnchorSample = null;
    this._wakeAnchorHit = null;
    this._legacyUtteranceDuringTts = false;
    this._activeSegmentStartSample = null;
    this._denoisedPending = new Float32Array(0);
    this._segmenter.reset();
    this._xfyunFedUpToGlobalSample = this._rawTotalSamples;
    this._voiceWsFedUpToGlobalSample = this._rawTotalSamples;
    this._wasAwake = this.isAwake;
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
      this._resetStandbyDpdfState();
      if (this._voicePipelineMode === "xfyun") {
        this._xfyunFedUpToGlobalSample = this._rawTotalSamples;
        this._xfyunOnsetFrames = 0;
      } else if (this._voicePipelineMode === "voice-ws") {
        this._voiceWsFedUpToGlobalSample = this._rawTotalSamples;
        this._voiceWsOnsetFrames = 0;
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
      this._resetStandbyDpdfState(true);
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
        this._xfyunWakeAnchored ||
        this._voiceWsWakeAnchored ||
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
      this._resetStandbyDpdfState();
      const isManualEnter = reason === "ws_control" || reason === "manual";
      if (this._voicePipelineMode === "xfyun") {
        this._xfyunOnsetFrames = 0;
        if (isManualEnter) {
          this._xfyunFedUpToGlobalSample = this._rawTotalSamples;
        } else {
          this._replayPostWakeGapIfNeeded();
        }
      } else if (this._voicePipelineMode === "voice-ws") {
        this._voiceWsOnsetFrames = 0;
        if (isManualEnter) {
          this._voiceWsFedUpToGlobalSample = this._rawTotalSamples;
        } else {
          this._replayPostWakeGapIfNeeded();
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
    if (!explicitExit && this._heldSegment) {
      this._flushHeldLegacySegment();
    } else {
      this._clearHeldLegacySegment();
    }
    this._resetStreamingState(true);
    this._resetStandbyDpdfState();
    if (explicitExit) {
      this._abortXfyunSession(true);
      this._abortVoiceWsSession(true);
    } else {
      if (!this._xfyunSession) {
        this._xfyunWakeAnchored = false;
        this._xfyunWakeHit = null;
        this._xfyunUtteranceDuringTts = false;
        this._xfyunOnsetFrames = 0;
      }
      if (!this._voiceWsSession) {
        this._voiceWsWakeAnchored = false;
        this._voiceWsWakeHit = null;
        this._voiceWsUtteranceDuringTts = false;
        this._voiceWsOnsetFrames = 0;
      }
    }
    this._wakeAnchorSample = null;
    this._wakeAnchorHit = null;
    this._legacyUtteranceDuringTts = false;
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
      (this._xfyunSession !== null ||
        this._voiceWsSession !== null ||
        this._inFlight ||
        this._pendingWake.length > 0);
    if (!hasPendingWakeWork) {
      this._legacyFedUpToGlobalSample = this._rawTotalSamples;
      this._xfyunFedUpToGlobalSample = this._rawTotalSamples;
      this._voiceWsFedUpToGlobalSample = this._rawTotalSamples;
      if (explicitExit) {
        this._lastEmittedEndSample = Math.max(this._lastEmittedEndSample, this._rawTotalSamples);
      }
    }
    if (
      !this._inFlight &&
      this._pendingWake.length === 0 &&
      this._pendingNormalQueue.length === 0
    ) {
      const resolvers = this._idleResolvers;
      this._idleResolvers = [];
      for (const r of resolvers) r();
    }
  }

  // ---------------------------------------------------------------------------
  // 讯飞语音听写大模型 2.0 直推管线（openWakeWord 唤醒后直接推送原始 16kHz PCM，零额外降噪/特殊处理）
  // ---------------------------------------------------------------------------

  private _resolveXfyunIdle(): void {
    const resolvers = this._xfyunIdleResolvers;
    this._xfyunIdleResolvers = [];
    for (const r of resolvers) r();
  }

  private async _waitForXfyunIdle(): Promise<void> {
    if (!this._xfyunSession && !this._xfyunFinishing) {
      return;
    }
    await new Promise<void>((resolve) => {
      this._xfyunIdleResolvers.push(resolve);
    });
  }

  private _abortXfyunSession(clearWakeAnchor = true): void {
    this._xfyunGen += 1;
    const prev = this._xfyunSession;
    this._xfyunSession = null;
    this._xfyunFinishing = false;
    this._xfyunRawChunks = [];
    this._xfyunRawBufferedSamples = 0;
    this._xfyunUtteranceDuringTts = false;
    this._xfyunOnsetFrames = 0;
    if (clearWakeAnchor) {
      this._xfyunWakeAnchored = false;
      this._xfyunWakeHit = null;
    }
    if (prev) {
      try {
        prev.abort();
      } catch {
        // ignore
      }
      this._opts.onSpeechActivity?.(false);
    }
    this._resolveXfyunIdle();
  }

  private _activateXfyunFromWake(
    hit: WakeWordAcousticHit | null,
    replayMs?: number,
  ): void {
    const anchorEnd = hit && hit.sampleOffset > 0 ? hit.sampleOffset : this._rawTotalSamples;
    const replayStart = this._computeWakeReplayStartSample(anchorEnd, replayMs);

    this._xfyunWakeAnchored = true;
    this._xfyunWakeHit = hit;
    this._wakeAnchorSample = replayStart;
    this._wakeAnchorHit = hit;
    this._wasAwake = true;
    this._xfyunOnsetFrames = 0;

    const bufferedRaw = this._readRingRange(
      this._rawRing,
      this._rawTotalSamples,
      replayStart,
      this._rawTotalSamples,
    );
    this._xfyunFedUpToGlobalSample = this._rawTotalSamples;

    this._startXfyunStreamSession({
      startGlobalSample: replayStart,
      initialRawSamples: bufferedRaw,
      wakeAnchored: true,
      acousticWake: hit,
    });
  }

  private _startXfyunStreamSession(params: {
    startGlobalSample: number;
    initialRawSamples: Float32Array;
    wakeAnchored: boolean;
    acousticWake: WakeWordAcousticHit | null;
  }): void {
    if (this._disposed) return;
    const xfyun = this._opts.localEngine.xfyunIat;
    if (!xfyun || !xfyun.isConfigured()) {
      this._xfyunWakeAnchored = false;
      this._xfyunWakeHit = null;
      this._wakeAnchorSample = null;
      this._wakeAnchorHit = null;
      if (!this.isAwake) {
        this._wasAwake = false;
      }
      this._resolveXfyunIdle();
      return;
    }

    if (this._xfyunSession) {
      this._abortXfyunSession(false);
    }

    const gen = ++this._xfyunGen;
    this._xfyunStartGlobalSample = params.startGlobalSample;
    this._xfyunRawChunks = [];
    this._xfyunRawBufferedSamples = 0;
    this._xfyunFinishing = false;
    this._xfyunUtteranceDuringTts = this._isDuringTtsWindow();
    const eosMs = Math.max(600, Math.min(60_000, Math.round(this._utteranceSilenceMs || 1200)));

    this._opts.onSpeechActivity?.(true);

    let session: XfyunIatV2StreamSession;
    try {
      session = xfyun.createStreamSession({
        eosMs,
        dwa: true,
        onPartial: (ev) => {
          if (this._disposed || gen !== this._xfyunGen) return;
          const clean = sanitizeAsrTranscript(ev.text, { wakeWords: this._wakeWords });
          if (!clean) return;
          this._opts.onPartialTranscript?.({
            text: clean,
            stableText: ev.stableText,
            unstableText: ev.unstableText,
            engine: "xfyun-iat-v2",
            latencyMs: ev.latencyMs,
          });
        },
        onFinal: (ev) => {
          if (this._disposed || gen !== this._xfyunGen) return;
          const startGlobalSample = this._xfyunStartGlobalSample;
          const isWakeAnchored = Boolean(params.wakeAnchored || this._xfyunWakeAnchored);
          const wakeHit = this._xfyunWakeHit ?? params.acousticWake ?? this._wakeAnchorHit ?? null;
          const duringTts = this._xfyunUtteranceDuringTts || this._isDuringTtsWindow();

          const mergedRaw = new Float32Array(this._xfyunRawBufferedSamples);
          let off = 0;
          for (const chunk of this._xfyunRawChunks) {
            mergedRaw.set(chunk, off);
            off += chunk.length;
          }

          this._xfyunSession = null;
          this._xfyunFinishing = false;
          this._xfyunRawChunks = [];
          this._xfyunRawBufferedSamples = 0;
          this._xfyunWakeAnchored = false;
          this._xfyunWakeHit = null;
          this._xfyunUtteranceDuringTts = false;
          this._wakeAnchorSample = null;
          this._wakeAnchorHit = null;
          this._oww?.resetSegmentTracking();
          this._lastEmittedEndSample = Math.max(this._lastEmittedEndSample, this._rawTotalSamples);
          this._opts.onSpeechActivity?.(false);
          this._resolveXfyunIdle();

          const cleanedText = sanitizeAsrTranscript(ev.text, { wakeWords: this._wakeWords });
          if (!cleanedText) {
            if (!this.isAwake) {
              this._wasAwake = false;
            }
            return;
          }

          const inputSnrDb = mergedRaw.length > 0 ? estimateSnrDb(mergedRaw, TARGET_SR) : 0;
          const payload: VoiceStreamSegmentPayload = {
            rawSamples: mergedRaw,
            denoisedSamples: mergedRaw,
            denoiseEngine: "xfyun-raw-direct",
            inputSnrDb,
            outputSnrDb: inputSnrDb,
            snrGainDb: 0,
            startSec: Number((startGlobalSample / TARGET_SR).toFixed(2)),
            durationSec: Number((mergedRaw.length / TARGET_SR).toFixed(2)),
            forcedRoll: ev.reason === "max_duration",
            acousticWake: wakeHit,
            wakeAnchored: isWakeAnchored,
            duringTtsPlayback: duringTts,
            precomputedTranscript: cleanedText,
            precomputedAsrEngine: "xfyun-iat-v2",
            precomputedAsrMs: ev.durationMs,
            commitReason:
              ev.reason === "client_finish"
                ? "manual_flush"
                : ev.reason === "max_duration"
                  ? "max_duration"
                  : "vad_silence",
            pipelineMode: "xfyun",
          };
          this._enqueueSegment(payload);
        },
        onError: () => {
          if (this._disposed || gen !== this._xfyunGen) return;
          this._xfyunSession = null;
          this._xfyunFinishing = false;
          this._xfyunRawChunks = [];
          this._xfyunRawBufferedSamples = 0;
          this._xfyunWakeAnchored = false;
          this._xfyunWakeHit = null;
          this._xfyunUtteranceDuringTts = false;
          this._wakeAnchorSample = null;
          this._wakeAnchorHit = null;
          this._oww?.resetSegmentTracking();
          this._opts.onSpeechActivity?.(false);
          if (!this.isAwake) {
            this._wasAwake = false;
          }
          this._resolveXfyunIdle();
        },
      });
    } catch {
      this._xfyunSession = null;
      this._xfyunFinishing = false;
      this._xfyunWakeAnchored = false;
      this._xfyunWakeHit = null;
      this._wakeAnchorSample = null;
      this._wakeAnchorHit = null;
      this._opts.onSpeechActivity?.(false);
      if (!this.isAwake) {
        this._wasAwake = false;
      }
      this._resolveXfyunIdle();
      return;
    }

    this._xfyunSession = session;
    if (params.initialRawSamples.length > 0) {
      this._appendXfyunRawChunk(params.initialRawSamples);
      session.pushFloat32Samples(params.initialRawSamples);
    }
  }

  private _appendXfyunRawChunk(samples: Float32Array): void {
    const copy = new Float32Array(samples);
    this._xfyunRawChunks.push(copy);
    this._xfyunRawBufferedSamples += copy.length;
    const maxSamples = TARGET_SR * 60;
    while (this._xfyunRawBufferedSamples > maxSamples && this._xfyunRawChunks.length > 1) {
      const dropped = this._xfyunRawChunks.shift()!;
      this._xfyunRawBufferedSamples -= dropped.length;
    }
  }

  private _feedXfyunAudio(feedSlice: Float32Array, sliceStartGlobalSample: number): void {
    if (feedSlice.length === 0) return;

    if (this._xfyunSession && !this._xfyunFinishing) {
      if (this._isDuringTtsWindow() && computeRms(feedSlice) >= 0.005) {
        this._xfyunUtteranceDuringTts = true;
      }
      this._appendXfyunRawChunk(feedSlice);
      this._xfyunSession.pushFloat32Samples(feedSlice);
      return;
    }

    if (this._xfyunFinishing) {
      return;
    }

    // 单次说话（bypassWakeWord）直接建立讯飞流直推原始音频，不等待能量门限
    if (this._opts.bypassWakeWord) {
      const earliestAvailable = Math.max(0, this._rawTotalSamples - RAW_RING_CAPACITY);
      const preStart = Math.max(
        earliestAvailable,
        this._lastEmittedEndSample > 0 ? this._lastEmittedEndSample : 0,
        sliceStartGlobalSample - PRE_ROLL_SAMPLES,
      );
      const initialRaw = this._readRingRange(
        this._rawRing,
        this._rawTotalSamples,
        preStart,
        this._rawTotalSamples,
      );
      this._startXfyunStreamSession({
        startGlobalSample: preStart,
        initialRawSamples: initialRaw.length > 0 ? initialRaw : feedSlice,
        wakeAnchored: false,
        acousticWake: null,
      });
      return;
    }

    // 连续对话或免唤醒态：轻量原始音量起声检测触发新一轮讯飞直推（仅用于按需建连，推送给讯飞的始终是原始音频）
    const rawRms = computeRms(feedSlice);
    const threshold = Math.max(0.008, this._xfyunIdleNoiseFloor * 2.2);
    if (rawRms >= threshold) {
      this._xfyunOnsetFrames += 1;
      const enoughOnset = this._xfyunOnsetFrames >= 2 || feedSlice.length >= 1600;
      if (enoughOnset) {
        this._xfyunOnsetFrames = 0;
        const earliestAvailable = Math.max(0, this._rawTotalSamples - RAW_RING_CAPACITY);
        const preStart = Math.max(
          earliestAvailable,
          this._lastEmittedEndSample > 0 ? this._lastEmittedEndSample : 0,
          sliceStartGlobalSample - PRE_ROLL_SAMPLES,
        );
        const initialRaw = this._readRingRange(
          this._rawRing,
          this._rawTotalSamples,
          preStart,
          this._rawTotalSamples,
        );
        this._startXfyunStreamSession({
          startGlobalSample: preStart,
          initialRawSamples: initialRaw.length > 0 ? initialRaw : feedSlice,
          wakeAnchored: false,
          acousticWake: null,
        });
      }
    } else {
      this._xfyunOnsetFrames = 0;
      const rate = rawRms < this._xfyunIdleNoiseFloor ? 0.08 : 0.015;
      this._xfyunIdleNoiseFloor = Math.max(
        0.002,
        Math.min(0.025, this._xfyunIdleNoiseFloor * (1 - rate) + rawRms * rate),
      );
    }
  }

  // ---------------------------------------------------------------------------
  // 统一流式语音听写 WebSocket 网关直推管线（openWakeWord 唤醒后直推原始 16kHz PCM Binary 帧，服务端 CPU GTCRN+Silero VAD -> 流式 ASR）
  // ---------------------------------------------------------------------------

  private _resolveVoiceWsIdle(): void {
    const resolvers = this._voiceWsIdleResolvers;
    this._voiceWsIdleResolvers = [];
    for (const r of resolvers) r();
  }

  private async _waitForVoiceWsIdle(): Promise<void> {
    if (!this._voiceWsSession && !this._voiceWsFinishing) {
      return;
    }
    await new Promise<void>((resolve) => {
      this._voiceWsIdleResolvers.push(resolve);
    });
  }

  private _abortVoiceWsSession(clearWakeAnchor = true): void {
    this._voiceWsGen += 1;
    const prev = this._voiceWsSession;
    this._voiceWsSession = null;
    this._voiceWsFinishing = false;
    this._voiceWsRawChunks = [];
    this._voiceWsRawBufferedSamples = 0;
    this._voiceWsUtteranceDuringTts = false;
    this._voiceWsOnsetFrames = 0;
    if (clearWakeAnchor) {
      this._voiceWsWakeAnchored = false;
      this._voiceWsWakeHit = null;
    }
    if (prev) {
      try {
        prev.abort();
      } catch {
        // ignore
      }
      this._opts.onSpeechActivity?.(false);
    }
    this._resolveVoiceWsIdle();
  }

  private _activateVoiceWsFromWake(
    hit: WakeWordAcousticHit | null,
    replayMs?: number,
  ): void {
    const anchorEnd = hit && hit.sampleOffset > 0 ? hit.sampleOffset : this._rawTotalSamples;
    const replayStart = this._computeWakeReplayStartSample(anchorEnd, replayMs);

    this._voiceWsWakeAnchored = true;
    this._voiceWsWakeHit = hit;
    this._wakeAnchorSample = replayStart;
    this._wakeAnchorHit = hit;
    this._wasAwake = true;
    this._voiceWsOnsetFrames = 0;

    const bufferedRaw = this._readRingRange(
      this._rawRing,
      this._rawTotalSamples,
      replayStart,
      this._rawTotalSamples,
    );
    this._voiceWsFedUpToGlobalSample = this._rawTotalSamples;

    this._startVoiceWsStreamSession({
      startGlobalSample: replayStart,
      initialRawSamples: bufferedRaw,
      wakeAnchored: true,
      acousticWake: hit,
    });
  }

  private _startVoiceWsStreamSession(params: {
    startGlobalSample: number;
    initialRawSamples: Float32Array;
    wakeAnchored: boolean;
    acousticWake: WakeWordAcousticHit | null;
  }): void {
    if (this._disposed) return;
    const voiceWs = this._opts.localEngine.voiceWsAsr;
    if (!voiceWs || !voiceWs.isConfigured()) {
      this._voiceWsWakeAnchored = false;
      this._voiceWsWakeHit = null;
      this._wakeAnchorSample = null;
      this._wakeAnchorHit = null;
      if (!this.isAwake) {
        this._wasAwake = false;
      }
      this._resolveVoiceWsIdle();
      return;
    }

    if (this._voiceWsSession) {
      this._abortVoiceWsSession(false);
    }

    const gen = ++this._voiceWsGen;
    this._voiceWsStartGlobalSample = params.startGlobalSample;
    this._voiceWsRawChunks = [];
    this._voiceWsRawBufferedSamples = 0;
    this._voiceWsFinishing = false;
    this._voiceWsUtteranceDuringTts = this._isDuringTtsWindow();
    const minSilenceMs = Math.max(320, Math.min(5000, Math.round(this._utteranceSilenceMs || 640)));

    this._opts.onSpeechActivity?.(true);

    let session: VoiceWsAsrStreamSession;
    try {
      session = voiceWs.createStreamSession({
        stopOnFinal: true,
        vad: { minSilenceMs },
        onPartial: (ev) => {
          if (this._disposed || gen !== this._voiceWsGen) return;
          const clean = sanitizeAsrTranscript(ev.text, { wakeWords: this._wakeWords });
          if (!clean) return;
          this._opts.onPartialTranscript?.({
            text: clean,
            stableText: ev.stableText,
            unstableText: ev.unstableText,
            engine: "voice-ws-asr",
            latencyMs: ev.latencyMs,
          });
        },
        onFinal: (ev) => {
          if (this._disposed || gen !== this._voiceWsGen) return;
          const startGlobalSample = this._voiceWsStartGlobalSample;
          const isWakeAnchored = Boolean(params.wakeAnchored || this._voiceWsWakeAnchored);
          const wakeHit = this._voiceWsWakeHit ?? params.acousticWake ?? this._wakeAnchorHit ?? null;
          const duringTts = this._voiceWsUtteranceDuringTts || this._isDuringTtsWindow();

          const mergedRaw = new Float32Array(this._voiceWsRawBufferedSamples);
          let off = 0;
          for (const chunk of this._voiceWsRawChunks) {
            mergedRaw.set(chunk, off);
            off += chunk.length;
          }

          this._voiceWsSession = null;
          this._voiceWsFinishing = false;
          this._voiceWsRawChunks = [];
          this._voiceWsRawBufferedSamples = 0;
          this._voiceWsWakeAnchored = false;
          this._voiceWsWakeHit = null;
          this._voiceWsUtteranceDuringTts = false;
          this._wakeAnchorSample = null;
          this._wakeAnchorHit = null;
          this._oww?.resetSegmentTracking();
          this._lastEmittedEndSample = Math.max(this._lastEmittedEndSample, this._rawTotalSamples);
          this._opts.onSpeechActivity?.(false);
          this._resolveVoiceWsIdle();

          const cleanedText = sanitizeAsrTranscript(ev.text, { wakeWords: this._wakeWords });
          if (!cleanedText) {
            if (!this.isAwake) {
              this._wasAwake = false;
            }
            return;
          }

          const inputSnrDb = mergedRaw.length > 0 ? estimateSnrDb(mergedRaw, TARGET_SR) : 0;
          const denoiseTag = ev.denoiseEnabled ? "voice-ws-gtcrn" : "voice-ws-raw";
          const payload: VoiceStreamSegmentPayload = {
            rawSamples: mergedRaw,
            denoisedSamples: mergedRaw,
            denoiseEngine: denoiseTag,
            inputSnrDb,
            outputSnrDb: inputSnrDb,
            snrGainDb: 0,
            startSec: Number((startGlobalSample / TARGET_SR).toFixed(2)),
            durationSec: Number((mergedRaw.length / TARGET_SR).toFixed(2)),
            forcedRoll: ev.reason === "max_duration" || ev.reason === "max_utterance_sec",
            acousticWake: wakeHit,
            wakeAnchored: isWakeAnchored,
            duringTtsPlayback: duringTts,
            precomputedTranscript: cleanedText,
            precomputedAsrEngine: "voice-ws-asr",
            precomputedAsrMs: ev.asrMs || ev.durationMs,
            commitReason:
              ev.reason === "client_finish" || ev.reason === "commit"
                ? "manual_flush"
                : ev.reason === "max_duration" || ev.reason === "max_utterance_sec"
                  ? "max_duration"
                  : "vad_silence",
            pipelineMode: "voice-ws",
          };
          this._enqueueSegment(payload);
        },
        onError: () => {
          if (this._disposed || gen !== this._voiceWsGen) return;
          this._voiceWsSession = null;
          this._voiceWsFinishing = false;
          this._voiceWsRawChunks = [];
          this._voiceWsRawBufferedSamples = 0;
          this._voiceWsWakeAnchored = false;
          this._voiceWsWakeHit = null;
          this._voiceWsUtteranceDuringTts = false;
          this._wakeAnchorSample = null;
          this._wakeAnchorHit = null;
          this._oww?.resetSegmentTracking();
          this._opts.onSpeechActivity?.(false);
          if (!this.isAwake) {
            this._wasAwake = false;
          }
          this._resolveVoiceWsIdle();
        },
      });
    } catch {
      this._voiceWsSession = null;
      this._voiceWsFinishing = false;
      this._voiceWsWakeAnchored = false;
      this._voiceWsWakeHit = null;
      this._wakeAnchorSample = null;
      this._wakeAnchorHit = null;
      this._opts.onSpeechActivity?.(false);
      if (!this.isAwake) {
        this._wasAwake = false;
      }
      this._resolveVoiceWsIdle();
      return;
    }

    this._voiceWsSession = session;
    if (params.initialRawSamples.length > 0) {
      this._appendVoiceWsRawChunk(params.initialRawSamples);
      session.pushFloat32Samples(params.initialRawSamples);
    }
  }

  private _appendVoiceWsRawChunk(samples: Float32Array): void {
    const copy = new Float32Array(samples);
    this._voiceWsRawChunks.push(copy);
    this._voiceWsRawBufferedSamples += copy.length;
    const maxSamples = TARGET_SR * 60;
    while (this._voiceWsRawBufferedSamples > maxSamples && this._voiceWsRawChunks.length > 1) {
      const dropped = this._voiceWsRawChunks.shift()!;
      this._voiceWsRawBufferedSamples -= dropped.length;
    }
  }

  private _feedVoiceWsAudio(feedSlice: Float32Array, sliceStartGlobalSample: number): void {
    if (feedSlice.length === 0) return;

    if (this._voiceWsSession && !this._voiceWsFinishing) {
      if (this._isDuringTtsWindow() && computeRms(feedSlice) >= 0.005) {
        this._voiceWsUtteranceDuringTts = true;
      }
      this._appendVoiceWsRawChunk(feedSlice);
      this._voiceWsSession.pushFloat32Samples(feedSlice);
      return;
    }

    if (this._voiceWsFinishing) {
      return;
    }

    // 单次说话（bypassWakeWord）直接建立统一流式网关连接直推原始音频，不等待能量门限
    if (this._opts.bypassWakeWord) {
      const earliestAvailable = Math.max(0, this._rawTotalSamples - RAW_RING_CAPACITY);
      const preStart = Math.max(
        earliestAvailable,
        this._lastEmittedEndSample > 0 ? this._lastEmittedEndSample : 0,
        sliceStartGlobalSample - PRE_ROLL_SAMPLES,
      );
      const initialRaw = this._readRingRange(
        this._rawRing,
        this._rawTotalSamples,
        preStart,
        this._rawTotalSamples,
      );
      this._startVoiceWsStreamSession({
        startGlobalSample: preStart,
        initialRawSamples: initialRaw.length > 0 ? initialRaw : feedSlice,
        wakeAnchored: false,
        acousticWake: null,
      });
      return;
    }

    // 连续对话或免唤醒态：轻量原始音量起声检测触发新一轮统一流式直推（仅用于按需建连，推送给网关的始终是原始 PCM）
    const rawRms = computeRms(feedSlice);
    const threshold = Math.max(0.008, this._voiceWsIdleNoiseFloor * 2.2);
    if (rawRms >= threshold) {
      this._voiceWsOnsetFrames += 1;
      const enoughOnset = this._voiceWsOnsetFrames >= 2 || feedSlice.length >= 1600;
      if (enoughOnset) {
        this._voiceWsOnsetFrames = 0;
        const earliestAvailable = Math.max(0, this._rawTotalSamples - RAW_RING_CAPACITY);
        const preStart = Math.max(
          earliestAvailable,
          this._lastEmittedEndSample > 0 ? this._lastEmittedEndSample : 0,
          sliceStartGlobalSample - PRE_ROLL_SAMPLES,
        );
        const initialRaw = this._readRingRange(
          this._rawRing,
          this._rawTotalSamples,
          preStart,
          this._rawTotalSamples,
        );
        this._startVoiceWsStreamSession({
          startGlobalSample: preStart,
          initialRawSamples: initialRaw.length > 0 ? initialRaw : feedSlice,
          wakeAnchored: false,
          acousticWake: null,
        });
      }
    } else {
      this._voiceWsOnsetFrames = 0;
      const rate = rawRms < this._voiceWsIdleNoiseFloor ? 0.08 : 0.015;
      this._voiceWsIdleNoiseFloor = Math.max(
        0.002,
        Math.min(0.025, this._voiceWsIdleNoiseFloor * (1 - rate) + rawRms * rate),
      );
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
    if (this._voicePipelineMode === "xfyun") {
      const effectiveStart = Math.max(gapStart, this._xfyunFedUpToGlobalSample);
      if (this._xfyunSession || this._rawTotalSamples - effectiveStart < 512) {
        this._xfyunFedUpToGlobalSample = this._rawTotalSamples;
        return;
      }
      const gapAudio = this._readRingRange(
        this._rawRing,
        this._rawTotalSamples,
        effectiveStart,
        this._rawTotalSamples,
      );
      this._xfyunFedUpToGlobalSample = this._rawTotalSamples;
      if (gapAudio.length >= 512 && hasAudibleAudioEnergy(gapAudio, TARGET_SR)) {
        this._startXfyunStreamSession({
          startGlobalSample: effectiveStart,
          initialRawSamples: gapAudio,
          wakeAnchored: false,
          acousticWake: null,
        });
      }
      return;
    }
    if (this._voicePipelineMode === "voice-ws") {
      const effectiveStart = Math.max(gapStart, this._voiceWsFedUpToGlobalSample);
      if (this._voiceWsSession || this._rawTotalSamples - effectiveStart < 512) {
        this._voiceWsFedUpToGlobalSample = this._rawTotalSamples;
        return;
      }
      const gapAudio = this._readRingRange(
        this._rawRing,
        this._rawTotalSamples,
        effectiveStart,
        this._rawTotalSamples,
      );
      this._voiceWsFedUpToGlobalSample = this._rawTotalSamples;
      if (gapAudio.length >= 512 && hasAudibleAudioEnergy(gapAudio, TARGET_SR)) {
        this._startVoiceWsStreamSession({
          startGlobalSample: effectiveStart,
          initialRawSamples: gapAudio,
          wakeAnchored: false,
          acousticWake: null,
        });
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
    this._legacyUtteranceDuringTts = false;
    this._activeSegmentStartSample = null;
    this._denoisedPending = new Float32Array(0);
    this._lastRawOverlap = new Float32Array(0);
    this._lastDenOverlap = new Float32Array(0);
    this._segmenter.reset();
    this._resetVadState();
    this._resetStreamingState(true);
    this._abortXfyunSession(true);
    this._abortVoiceWsSession(true);
    this._xfyunFedUpToGlobalSample = this._rawTotalSamples;
    this._voiceWsFedUpToGlobalSample = this._rawTotalSamples;
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
    } else {
      if (this._vadDetected || this._activeSegmentStartSample !== null) {
        this._legacyUtteranceDuringTts = true;
      }
      if (this._xfyunSession && !this._xfyunFinishing) {
        this._xfyunUtteranceDuringTts = true;
      }
      if (this._voiceWsSession && !this._voiceWsFinishing) {
        this._voiceWsUtteranceDuringTts = true;
      }
    }
    const userCurrentlySpeaking =
      this._vadDetected ||
      this._wakeAnchorSample !== null ||
      this._xfyunWakeAnchored ||
      Boolean(this._xfyunSession && !this._xfyunFinishing) ||
      this._voiceWsWakeAnchored ||
      Boolean(this._voiceWsSession && !this._voiceWsFinishing);
    if (!userCurrentlySpeaking) {
      this._lastRawOverlap = new Float32Array(0);
      this._lastDenOverlap = new Float32Array(0);
    }
  }

  private _isDuringTtsWindow(): boolean {
    if (this._ttsSpeaking) return true;
    return this._ttsLastEndedAt > 0 && Date.now() - this._ttsLastEndedAt <= 1000;
  }

  // ---------------------------------------------------------------------------
  // 待机期降噪唤醒前端（零 ASR：仅送入 openWakeWord，绝不跑语音转文字）
  // ---------------------------------------------------------------------------

  private _resetStandbyDpdfState(disposeInstances = false): void {
    this._standbyDpdfActive = false;
    this._standbyDpdfNoisySamples = 0;
    this._standbyDpdfQuietSamples = 0;
    if (disposeInstances) {
      try {
        this._standbyDpdfOww?.reset();
      } catch {
        // ignore
      }
      this._standbyDpdfDenoiser = null;
      this._standbyDpdfOww = null;
      this._standbyDpdfInitAttempted = false;
    } else {
      try {
        this._standbyDpdfDenoiser?.reset();
      } catch {
        // ignore
      }
      try {
        this._standbyDpdfOww?.resetSegmentTracking();
      } catch {
        // ignore
      }
    }
  }

  /**
   * Legacy 模式下的待机强噪 DPDFNet4 按需增强通道：
   * - 安静环境完全不启用（零 CPU 开销）；
   * - 当环境噪声/音乐底噪持续偏高（RMS >= 0.014 持续 >= 250ms）时，自动启用 DPDFNet4 + 独立 OWW 流，
   *   显著提升强噪/伴奏场景唤醒召回率，仍保持待机零 ASR。
   */
  private _feedStandbyDpdfFallback(pcm16k: Float32Array, chunkStartGlobalSample: number): void {
    if (this._disposed || !this._oww || !this._owwEnabled) return;
    if (this._noiseMode !== "auto" && this._noiseMode !== "neural") return;
    if (this._denoiseEngine !== "gtcrn") return;
    const status = this._opts.localEngine.getStatus();
    if (!status.readyForDpdfnet) return;

    const rawRms = computeRms(pcm16k);
    if (!this._standbyDpdfActive) {
      if (rawRms >= STANDBY_DPDF_ENGAGE_RMS) {
        this._standbyDpdfNoisySamples += pcm16k.length;
        if (this._standbyDpdfNoisySamples < STANDBY_DPDF_ENGAGE_SAMPLES) {
          return;
        }
        if (!this._standbyDpdfInitAttempted) {
          this._standbyDpdfInitAttempted = true;
          const created = this._opts.localEngine.createOnlineDenoiser("dpdfnet");
          if (created && created.engine === "dpdfnet4") {
            this._standbyDpdfDenoiser = created.denoiser;
            const oww = this._opts.localEngine.createWakeWordStream(this._wakeWords, {
              threshold: this._owwThreshold,
              onSpot: (hit) => this._handleWakeSpot(hit),
            });
            if (oww) {
              const withFrameIdx = oww as { frameIndex?: number };
              if (
                typeof withFrameIdx.frameIndex === "number" &&
                chunkStartGlobalSample >= OWW_WARMUP_SEED_SAMPLES
              ) {
                try {
                  oww.pushSamples(new Float32Array(OWW_WARMUP_SEED_SAMPLES), chunkStartGlobalSample);
                  oww.resetSegmentTracking();
                } catch {
                  // ignore
                }
              }
              this._standbyDpdfOww = oww;
            }
          }
        }
        if (!this._standbyDpdfDenoiser || !this._standbyDpdfOww) {
          return;
        }
        this._standbyDpdfActive = true;
        this._standbyDpdfQuietSamples = 0;
        // 回灌 480ms 前导原始音频，防止切入瞬间切掉已说出的唤醒词首音节
        const preStart = Math.max(
          0,
          this._rawTotalSamples - RAW_RING_CAPACITY,
          chunkStartGlobalSample - STANDBY_DPDF_PREROLL_SAMPLES,
        );
        if (preStart < chunkStartGlobalSample) {
          const preRaw = this._readRingRange(
            this._rawRing,
            this._rawTotalSamples,
            preStart,
            chunkStartGlobalSample,
          );
          try {
            const preRes = this._standbyDpdfDenoiser.run({ samples: preRaw, sampleRate: TARGET_SR });
            const preDen =
              preRes.sampleRate === TARGET_SR
                ? preRes.samples
                : resampleLinear(preRes.samples, preRes.sampleRate, TARGET_SR);
            this._standbyDpdfOww.pushSamples(preDen, chunkStartGlobalSample);
          } catch {
            // ignore
          }
        }
      } else {
        this._standbyDpdfNoisySamples = 0;
        return;
      }
    } else if (rawRms < STANDBY_DPDF_RELEASE_RMS) {
      this._standbyDpdfQuietSamples += pcm16k.length;
      if (this._standbyDpdfQuietSamples >= STANDBY_DPDF_RELEASE_SAMPLES) {
        this._resetStandbyDpdfState(false);
        return;
      }
    } else {
      this._standbyDpdfQuietSamples = 0;
    }

    if (!this._standbyDpdfDenoiser || !this._standbyDpdfOww || !this.isWakeGatedStandby) {
      return;
    }
    try {
      const res = this._standbyDpdfDenoiser.run({ samples: pcm16k, sampleRate: TARGET_SR });
      const den =
        res.sampleRate === TARGET_SR
          ? res.samples
          : resampleLinear(res.samples, res.sampleRate, TARGET_SR);
      this._standbyDpdfOww.pushSamples(den, this._rawTotalSamples);
    } catch {
      // ignore
    }
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
      this._resetStandbyDpdfState(true);
      return;
    }
    if (!this._oww || thresholdChanged) {
      this._oww = this._opts.localEngine.createWakeWordStream(this._wakeWords, {
        threshold: this._owwThreshold,
        onSpot: (hit) => this._handleWakeSpot(hit),
      });
      this._resetStandbyDpdfState(true);
      return;
    }
    this._oww.reloadPrototypes(this._wakeWords);
    try {
      this._standbyDpdfOww?.reloadPrototypes(this._wakeWords);
    } catch {
      // ignore
    }
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
    if (this._voicePipelineMode === "xfyun") return "xfyun-raw-direct";
    if (this._voicePipelineMode === "voice-ws") {
      return this._opts.localEngine.voiceWsAsr.getStatus().denoiseEnabled
        ? "voice-ws-gtcrn"
        : "voice-ws-raw";
    }
    return this._denoiseEngine;
  }

  get droppedStaleCount(): number {
    return this._droppedStaleCount;
  }

  get droppedPureMusicCount(): number {
    return this._droppedPureMusicCount;
  }

  get clientAecActive(): boolean {
    return this._clientAecActive;
  }

  get serverAecActive(): boolean {
    return (
      !this._clientAecActive &&
      (this._echoCancellationMode === "auto" || this._echoCancellationMode === "aggressive") &&
      (this._serverAecRefQueuedSamples > 0 || this._serverAecTailActive)
    );
  }

  get serverAecErleDb(): number {
    return this._serverAecLastErleDb;
  }

  get serverAecEstimatedDelayMs(): number {
    return this._serverAecLastDelayMs;
  }

  setEchoCancellationMode(mode: EchoCancellationMode): void {
    this._echoCancellationMode = mode;
    if (this._serverAec) {
      this._serverAec.setAggressive(mode === "aggressive");
    }
    if (mode === "off" || mode === "standard") {
      this.clearFarEndReference();
    }
  }

  setClientAecActive(active: boolean): void {
    const next = Boolean(active);
    if (this._clientAecActive === next) return;
    this._clientAecActive = next;
    if (next) {
      // 客户端 AudioWorklet AEC 已接管，清空服务端兜底参考队列避免重复回声处理
      this.clearFarEndReference();
    }
  }

  /**
   * 推入服务端兜底 AEC 的 TTS 远端参考音频（16kHz 或任意采样率 Mono Float32 PCM）。
   * 仅在客户端未启用 AudioWorklet AEC 且 echoCancellationMode 为 auto / aggressive 时生效。
   */
  pushFarEndReference(samples: Float32Array, sampleRate = TARGET_SR): void {
    if (this._disposed || samples.length === 0) return;
    if (this._clientAecActive) return;
    if (this._echoCancellationMode === "off" || this._echoCancellationMode === "standard") return;

    const pcm16 = sampleRate === TARGET_SR ? samples.slice() : resampleLinear(samples, sampleRate, TARGET_SR);
    if (pcm16.length === 0) return;
    this._serverAecRefQueue.push(pcm16);
    this._serverAecRefQueuedSamples += pcm16.length;

    // 有界队列保护（最多保留最近 20 秒参考音频，防异常断流无限增长）
    const maxRefSamples = TARGET_SR * 20;
    while (this._serverAecRefQueuedSamples > maxRefSamples && this._serverAecRefQueue.length > 0) {
      const head = this._serverAecRefQueue[0]!;
      const avail = head.length - this._serverAecRefHeadOffset;
      const excess = this._serverAecRefQueuedSamples - maxRefSamples;
      if (avail <= excess) {
        this._serverAecRefQueue.shift();
        this._serverAecRefHeadOffset = 0;
        this._serverAecRefQueuedSamples -= avail;
      } else {
        this._serverAecRefHeadOffset += excess;
        this._serverAecRefQueuedSamples -= excess;
      }
    }
  }

  clearFarEndReference(): void {
    this._serverAecRefQueue = [];
    this._serverAecRefHeadOffset = 0;
    this._serverAecRefQueuedSamples = 0;
    this._serverAecTailActive = false;
  }

  private _dequeueServerAecReference(count: number): Float32Array {
    const out = new Float32Array(count);
    let written = 0;
    while (written < count && this._serverAecRefQueue.length > 0) {
      const head = this._serverAecRefQueue[0]!;
      const avail = head.length - this._serverAecRefHeadOffset;
      const take = Math.min(count - written, avail);
      out.set(
        head.subarray(this._serverAecRefHeadOffset, this._serverAecRefHeadOffset + take),
        written,
      );
      written += take;
      this._serverAecRefHeadOffset += take;
      this._serverAecRefQueuedSamples -= take;
      if (this._serverAecRefHeadOffset >= head.length) {
        this._serverAecRefQueue.shift();
        this._serverAecRefHeadOffset = 0;
      }
    }
    return out;
  }

  private _applyServerAecIfNeeded(mic16k: Float32Array, explicitRef16k?: Float32Array): Float32Array {
    if (this._echoCancellationMode === "off" || this._echoCancellationMode === "standard") {
      return mic16k;
    }
    if (!explicitRef16k) {
      if (this._clientAecActive) return mic16k;
      if (this._serverAecRefQueuedSamples === 0 && !this._serverAecTailActive) {
        return mic16k;
      }
    }

    if (!this._serverAec) {
      this._serverAec = new AcousticEchoCanceller({
        sampleRate: TARGET_SR,
        blockSize: 256,
        numPartitions: 16,
        aggressive: this._echoCancellationMode === "aggressive",
      });
    } else {
      this._serverAec.setAggressive(this._echoCancellationMode === "aggressive");
    }

    const refChunk = explicitRef16k ?? this._dequeueServerAecReference(mic16k.length);
    const res = this._serverAec.processStream(mic16k, refChunk);
    this._serverAecTailActive = res.farEndActive;
    this._serverAecLastErleDb = res.erleDb;
    this._serverAecLastLinearErleDb = res.linearErleDb ?? 0;
    this._serverAecLastDelayMs = res.estimatedDelayMs ?? 0;

    this._serverAecTelemetryTick += 1;
    if (res.farEndActive && this._serverAecTelemetryTick % 4 === 0) {
      this._opts.onAecTelemetry?.({
        active: true,
        erleDb: res.erleDb,
        linearErleDb: res.linearErleDb ?? 0,
        estimatedDelayMs: res.estimatedDelayMs ?? 0,
        doubleTalk: res.doubleTalk,
        farEndActive: res.farEndActive,
      });
    }

    return res.output;
  }

  /**
   * 同步双通道音频入口（麦克风 + 远端播报参考信号）：在送入 openWakeWord / VAD / ASR 之前
   * 直接执行实时延迟对齐双路径 PBFDAF + Hann-OLA RES 声学回声消除。
   */
  pushFrameWithReference(
    micSamples: Float32Array,
    refSamples: Float32Array,
    sampleRate = this._inputRate,
  ): void {
    if (this._disposed || micSamples.length === 0) return;
    const mic16k =
      sampleRate === TARGET_SR ? micSamples : resampleLinear(micSamples, sampleRate, TARGET_SR);
    const ref16kRaw =
      sampleRate === TARGET_SR ? refSamples : resampleLinear(refSamples, sampleRate, TARGET_SR);
    let ref16k = ref16kRaw;
    if (ref16kRaw.length !== mic16k.length) {
      ref16k = new Float32Array(mic16k.length);
      ref16k.set(ref16kRaw.subarray(0, Math.min(ref16kRaw.length, mic16k.length)), 0);
    }
    const cleaned = this._applyServerAecIfNeeded(mic16k, ref16k);
    if (cleaned.length > 0) {
      this._ingestPcm16k(cleaned);
    }
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
   * 写入 Float32 PCM 样本并实时驱动循环录制缓冲区 + 双层待机降噪唤醒检测（openWakeWord）：
   * - 第一层（极速快路径）：先降噪（GTCRN / DPDFNet4 / VoxLock / 流式 DSP）再 AGC -> 80ms 步进 openWakeWord，安静环境毫秒级响应；
   * - 第二层（强噪抗干扰路径，零 ASR）：Legacy 模式高噪时自动介入 DPDFNet4 增强通道 + 独立 openWakeWord；
   * - 未唤醒待机期绝不执行实时语音转文字（零流式预览、零分段 ASR），命中唤醒后再回放循环录制缓冲区与后续音频进入完整识别管线！
   */
  pushFloat32Samples(samples: Float32Array): void {
    if (this._disposed || samples.length === 0) return;
    const resampled =
      this._inputRate === TARGET_SR ? samples : resampleLinear(samples, this._inputRate, TARGET_SR);
    const pcm16k = this._applyServerAecIfNeeded(resampled);
    if (pcm16k.length === 0) return;
    this._ingestPcm16k(pcm16k);
  }

  private _ingestPcm16k(pcm16k: Float32Array): void {

    // 1. 无论新旧方案，始终持续写入时间对齐的 16kHz 原始循环录制缓冲区（零失真、供唤醒后完整回放）
    const chunkStartGlobalSample = this._rawTotalSamples;
    for (let i = 0; i < pcm16k.length; i += 1) {
      this._rawRing[(this._rawTotalSamples + i) % RAW_RING_CAPACITY] = pcm16k[i]!;
    }
    this._rawTotalSamples += pcm16k.length;

    // 2. Legacy 方案或启用了 openWakeWord 时，维护先降噪后 AGC 的实时快路径与声学唤醒检测
    // 注意：讯飞 2.0 / 统一流式语音听写网关方案在已唤醒/对话态完全跳过本地降噪与 AGC，原始 16kHz PCM 直推 WebSocket
    const isDirectWsPipeline =
      this._voicePipelineMode === "xfyun" || this._voicePipelineMode === "voice-ws";
    const needLightweightFrontEnd =
      this._voicePipelineMode === "legacy" ||
      (this._oww !== null && (!isDirectWsPipeline || this.isWakeGatedStandby));
    let denoisedChunk: Float32Array = pcm16k;
    if (needLightweightFrontEnd) {
      // 先在原始自然电平上运行在线降噪（避免先 AGC 把电视/环境底噪放大破坏降噪统计），再对干净语音做平滑 AGC
      const allowOnlineDenoiser = this._onlineDenoiser !== null && this._noiseMode !== "off";
      let postDenoise: Float32Array = pcm16k;
      if (allowOnlineDenoiser) {
        try {
          const res = this._onlineDenoiser!.run({ samples: pcm16k, sampleRate: TARGET_SR });
          postDenoise =
            res.sampleRate === TARGET_SR
              ? res.samples
              : resampleLinear(res.samples, res.sampleRate, TARGET_SR);
        } catch {
          postDenoise = pcm16k;
        }
      }
      denoisedChunk = this._agc ? this._agc.process(postDenoise) : postDenoise;

      for (let i = 0; i < denoisedChunk.length; i += 1) {
        this._denRing[(this._denTotalSamples + i) % RAW_RING_CAPACITY] = denoisedChunk[i]!;
      }
      this._denTotalSamples += denoisedChunk.length;

      // 实时流式 openWakeWord 声学唤醒检测（80ms 步进，静音自动快路径跳过，零 ASR 开销）
      // 注意：若本帧内命中唤醒词，_handleWakeSpot 会同步回放循环录制缓冲区并更新 _xfyunFedUpToGlobalSample / _wakeAnchorSample
      if (this._oww) {
        try {
          this._oww.pushSamples(denoisedChunk, this._rawTotalSamples);
        } catch {
          // 声学检测异常不得中断主音频流
        }
      }
    }

    // 3. 同步待机/唤醒状态跃迁，并在未唤醒门控待机期运行深度降噪唤醒通道后直接返回（零实时转写、零分段 ASR）
    const awakeNow = this.isAwake;
    if (!awakeNow && this._wasAwake) {
      this._wasAwake = false;
      this._onEnterStandby();
    } else if (awakeNow && !this._wasAwake) {
      this._wasAwake = true;
      this._resetStandbyDpdfState();
      if (this._opts.isInConversation?.()) {
        if (this._voicePipelineMode === "xfyun") {
          this._xfyunFedUpToGlobalSample = chunkStartGlobalSample;
          this._xfyunOnsetFrames = 0;
        } else if (this._voicePipelineMode === "voice-ws") {
          this._voiceWsFedUpToGlobalSample = chunkStartGlobalSample;
          this._voiceWsOnsetFrames = 0;
        } else {
          this._denoisedPending = new Float32Array(0);
          this._resetVadState(denoisedChunk.length);
        }
      }
    }

    if (this.isWakeGatedStandby) {
      // 待机期间维护轻量环境底噪估值（供唤醒后滞回分段器精准识别背景音乐底噪）
      const frameRms = computeRms(denoisedChunk);
      this._lastFrameRms = frameRms;
      this._segmenter.process(denoisedChunk.length / TARGET_SR, 0, frameRms);

      // 抗强噪待机深度降噪唤醒通道（严格零 ASR、零 UI 闪烁，仅喂入独立声学唤醒器）
      if (this._noiseMode !== "off") {
        this._feedStandbyDpdfFallback(pcm16k, chunkStartGlobalSample);
      }
      return;
    }

    // 4. 讯飞语音听写大模型 2.0 方案：openWakeWord 唤醒后直接推送原始 16kHz PCM 至讯飞 WebSocket，不做额外降噪与特殊处理
    if (this._voicePipelineMode === "xfyun") {
      if (this._xfyunFedUpToGlobalSample >= this._rawTotalSamples) {
        return;
      }
      let feedSlice = pcm16k;
      let sliceStartGlobal = chunkStartGlobalSample;
      if (this._xfyunFedUpToGlobalSample > chunkStartGlobalSample) {
        const skip = this._xfyunFedUpToGlobalSample - chunkStartGlobalSample;
        feedSlice = pcm16k.subarray(skip);
        sliceStartGlobal = this._xfyunFedUpToGlobalSample;
      }
      this._xfyunFedUpToGlobalSample = this._rawTotalSamples;
      this._feedXfyunAudio(feedSlice, sliceStartGlobal);
      return;
    }

    // 4a2. 统一流式语音听写 WebSocket 网关方案：openWakeWord 唤醒后直接推送原始 16kHz PCM Binary 帧，服务端 CPU ONNX 降噪+VAD -> 流式 ASR
    if (this._voicePipelineMode === "voice-ws") {
      if (this._voiceWsFedUpToGlobalSample >= this._rawTotalSamples) {
        return;
      }
      let feedSlice = pcm16k;
      let sliceStartGlobal = chunkStartGlobalSample;
      if (this._voiceWsFedUpToGlobalSample > chunkStartGlobalSample) {
        const skip = this._voiceWsFedUpToGlobalSample - chunkStartGlobalSample;
        feedSlice = pcm16k.subarray(skip);
        sliceStartGlobal = this._voiceWsFedUpToGlobalSample;
      }
      this._voiceWsFedUpToGlobalSample = this._rawTotalSamples;
      this._feedVoiceWsAudio(feedSlice, sliceStartGlobal);
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
      if (nowDetected && this._isDuringTtsWindow()) {
        this._legacyUtteranceDuringTts = true;
      }

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

      // 对话态持续无停顿（>= 2.0s）时，通过轻量 CED 声学场景探测（~20ms）精准区分“真实用户连续说话”与“持续背景音乐/电视群聊噪声”：
      // - 真实用户长句（speechProb 高且非纯音乐/电视噪声）绝不切窗、全程保活对话态；
      // - 仅在明确检出纯背景音乐（musicProb >= 0.50 且 speechProb < 0.15）或持续高噪电视群聊（noiseProb >= 0.14 且 crowdTvProb >= 0.14）时才滚窗交付注意力门控判拒。
      const currentFrameEndSample = this._rawTotalSamples - remainingAfterFrame;
      if (
        step.continuing &&
        !this._opts.bypassWakeWord &&
        this._opts.isInConversation?.() &&
        this._wakeAnchorSample === null &&
        this._activeSegmentStartSample !== null &&
        currentFrameEndSample - this._activeSegmentStartSample >= TARGET_SR * CONV_AMBIENT_PROBE_SEC &&
        currentFrameEndSample - this._lastConvAmbientProbeSample >= TARGET_SR * CONV_AMBIENT_PROBE_STEP_SEC
      ) {
        this._lastConvAmbientProbeSample = currentFrameEndSample;
        if (this._isConversationContinuousAmbientBackground()) {
          this._segmenter.reset();
          this._emitSegmenterWindow(true, remainingAfterFrame);
          offset += 512;
          continue;
        }
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
    const lastEngine = this._streamLastEngine || "sensevoice-stream";
    const lastLatencyMs = this._streamLastLatencyMs;
    const anchor = this._wakeAnchorSample;
    const anchorHit = this._wakeAnchorHit;
    const segDuringTts = this._legacyUtteranceDuringTts || this._isDuringTtsWindow();
    const origin =
      anchor ??
      this._streamSpeechOriginSample ??
      Math.max(0, this._rawTotalSamples - TARGET_SR * 2);

    this._wakeAnchorSample = null;
    this._wakeAnchorHit = null;
    this._legacyUtteranceDuringTts = false;
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
      duringTtsPlayback: segDuringTts,
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
   * 按自适应步进触发非阻塞流式假设解码（默认 ~850ms 步进），
   * 实时推送字幕并在显式启用句中拆分时按标点边界切分输出。
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
    // 待机持续高音量背景音乐下跳过投机流式解码，防止无谓占满 CPU
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

    const pollMs = this._opts.streamingPollIntervalMs ?? 850;
    const minAudioMs =
      this._opts.streamingPollIntervalMs !== undefined
        ? Math.min(320, pollMs)
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
    const energyCheckAudio = rawSlice.length >= 800 ? rawSlice : decodeAudio;
    if (!hasAudibleAudioEnergy(energyCheckAudio, TARGET_SR)) {
      this._streamDecodeInFlight = false;
      this._streamAbort = null;
      return;
    }
    const t0 = performance.now();

    try {
      const res = await this._opts.localEngine.transcribeLocal(decodeAudio, TARGET_SR, this.lang, {
        hotwords: this._wakeWords.length > 0 ? this._wakeWords : undefined,
        signal: abort.signal,
        onPartial: (partialRaw) => {
          if (this._disposed || gen !== this._streamGen || abort.signal.aborted) return;
          const sanitizedPartial = sanitizeAsrTranscript(partialRaw, {
            wakeWords: this._wakeWords,
          });
          if (!sanitizedPartial) return;
          const clean = stripCommittedPrefix(sanitizedPartial, this._streamTracker.committedPrefix);
          if (!clean) return;
          const stable = this._streamTracker.stableText;
          const stablePrefix = clean.startsWith(stable) ? stable : "";
          const unstable = stablePrefix ? clean.slice(stablePrefix.length) : clean;
          this._opts.onPartialTranscript?.({
            text: clean,
            stableText: stablePrefix,
            unstableText: unstable,
            engine: this._streamLastEngine || "sensevoice-stream",
            latencyMs: Math.round(performance.now() - t0),
          });
        },
      });

      if (this._disposed || gen !== this._streamGen || abort.signal.aborted) {
        return;
      }

      this._streamLastEngine = res.engine;
      this._streamLastLatencyMs = res.durationMs;

      const sanitizedFinal = sanitizeAsrTranscript(res.text, {
        wakeWords: this._wakeWords,
      });
      if (!sanitizedFinal) {
        return;
      }

      const ingested = this._streamTracker.ingestHypothesis(sanitizedFinal, {
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
              precomputedAsrEngine: lastEngine || "sensevoice-stream",
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
          precomputedAsrEngine: lastEngine || "sensevoice-stream",
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
    const segDuringTts = this._legacyUtteranceDuringTts || this._isDuringTtsWindow();
    this._wakeAnchorSample = null;
    this._wakeAnchorHit = null;
    this._legacyUtteranceDuringTts = false;
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

    const wakeEnergyAudio = rawSlice.length >= 800 ? rawSlice : denSlice;
    if (!hasAudibleAudioEnergy(wakeEnergyAudio, TARGET_SR)) {
      if (this._streamingAsrEnabled) {
        this._resetStreamingState(true);
      }
      return;
    }

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
        duringTtsPlayback: segDuringTts,
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
    const segDuringTts = this._legacyUtteranceDuringTts || this._isDuringTtsWindow();
    this._activeSegmentStartSample = null;
    this._legacyUtteranceDuringTts = false;
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

    const segWinEnergyAudio = rawSlice.length >= 800 ? rawSlice : denSlice;
    if (!hasAudibleAudioEnergy(segWinEnergyAudio, TARGET_SR)) {
      if (this._streamingAsrEnabled) {
        this._resetStreamingState(true);
      }
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
        duringTtsPlayback: segDuringTts,
      },
      rawStart,
      rawEnd,
      timedOut ? "max_duration" : "vad_silence",
    );
  }

  /**
   * 主动冲刷当前挂起尾音（用于单次说话松开/停止监听时立刻出结果）。
   * 若处于未唤醒门控待机态，绝不将未唤醒环境音送入 ASR。
   */
  async flush(): Promise<void> {
    if (this._disposed) return;
    if (this.isWakeGatedStandby) {
      await this.waitForIdle();
      return;
    }
    if (this._voicePipelineMode === "xfyun") {
      if (this._xfyunSession) {
        this._xfyunFinishing = true;
        await this._xfyunSession.finish("client_finish");
      }
      await this._waitForXfyunIdle();
      await this.waitForIdle();
      return;
    }
    if (this._voicePipelineMode === "voice-ws") {
      if (this._voiceWsSession) {
        this._voiceWsFinishing = true;
        await this._voiceWsSession.finish("client_finish");
      }
      await this._waitForVoiceWsIdle();
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

  private _isConversationContinuousAmbientBackground(): boolean {
    const sep = this._opts.localEngine.sourceSeparator;
    if (!sep || typeof sep.analyzeAudioScene !== "function") {
      return false;
    }
    const probeLen = Math.round(TARGET_SR * CONV_AMBIENT_PROBE_SEC);
    if (this._rawTotalSamples < probeLen) return false;
    const recentRaw = this._readRingTail(this._rawRing, this._rawTotalSamples, probeLen);
    try {
      const scene = sep.analyzeAudioScene(recentRaw, 12);
      const isPureMusic = scene.musicProb >= 0.5 && scene.speechProb < 0.15;
      const isNoisyTvChatter = scene.noiseProb >= 0.14 && scene.crowdTvProb >= 0.14;
      return isPureMusic || isNoisyTvChatter;
    } catch {
      return false;
    }
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

      // 静音/极微弱底噪早退：防止 AGC 放大微弱呼吸或电底噪触发 Silero VAD 后送入 ASR 产生幻觉词
      const vadEnergyAudio = rawSlice.length >= 800 ? rawSlice : denSlice;
      if (!hasAudibleAudioEnergy(vadEnergyAudio, TARGET_SR)) {
        this._lastEmittedEndSample = Math.max(this._lastEmittedEndSample, absEnd);
        if (this._streamingAsrEnabled) {
          this._resetStreamingState(true);
        }
        continue;
      }

      this._lastEmittedEndSample = Math.max(this._lastEmittedEndSample, absEnd);

      const inputSnrDb = estimateSnrDb(rawSlice, TARGET_SR);
      const outputSnrDb = estimateSnrDb(denSlice, TARGET_SR);
      const segDuringTts = this._legacyUtteranceDuringTts || this._isDuringTtsWindow();
      if (!this._vadDetected) {
        this._legacyUtteranceDuringTts = false;
      }
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
        duringTtsPlayback: segDuringTts,
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

    const denoised = this._opts.localEngine.denoise(merged, TARGET_SR, this._noiseMode);
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
        // （流式断句产出的独立分句已由 StreamingAsrHypothesisTracker 严格去重，豁免时间重叠拦截）
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

          if (
            this._lastMatchedEndSec >= 0 &&
            isOverlappingRange(this._lastMatchedStartSec, this._lastMatchedEndSec)
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
          // 唤醒段命中并切入连续对话后，立即回放在异步 ASR 间隙内写入循环录制缓冲区的续说音频，防止首字丢失
          if (this._opts.isInConversation?.()) {
            this._wasAwake = true;
            this._replayPostWakeGapIfNeeded();
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
    if (this._voicePipelineMode === "xfyun") {
      await this._waitForXfyunIdle();
    }
    if (this._voicePipelineMode === "voice-ws") {
      await this._waitForVoiceWsIdle();
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
    this.clearFarEndReference();
    this._serverAec?.reset();
    this._serverAec = null;
    this._clearHeldLegacySegment();
    this._abortXfyunSession(true);
    this._abortVoiceWsSession(true);
    this._resetStandbyDpdfState(true);
    this._resetStreamingState(true);
    this._pendingWake = [];
    this._pendingNormalQueue = [];
    this._wakeAnchorSample = null;
    this._wakeAnchorHit = null;
    this._legacyUtteranceDuringTts = false;
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
