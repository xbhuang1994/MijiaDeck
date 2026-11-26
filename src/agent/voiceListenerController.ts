// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * 语音监听状态机、双级环境降噪（GTCRN/DSP）、Silero VAD、3D-Speaker 声纹识别、
 * 本地 SenseVoice / 云端 Whisper 转写、唤醒词注意力门控与 Pi Agent 协同调度管线。
 */

import {
  isLocalEndpointUrl,
  resolveEffectiveSttAuth,
  resolveEffectiveVoiceWsAsrAuth,
  resolveEffectiveXfyunAuth,
  type AgentVoiceConfig,
  type CavemanReplyMode,
  type EchoCancellationMode,
} from "../core/agentConfigStore.ts";
import { TypedEmitter } from "../core/contracts.ts";
import { createBoundedFetch, type FetchLike } from "../core/httpTimeout.ts";
import {
  isAsrHallucinationText,
  sanitizeAsrTranscript,
} from "./asrHallucinationGuard.ts";
import {
  decodeWavPcm,
  encodeWavPcm16,
  estimateSnrDb,
  hasAudibleAudioEnergy,
  isWavBuffer,
  resampleLinear,
} from "./audioPcm.ts";
import type { SeparatedAudioStreamInfo, SoundTypeTag } from "./audioSourceSeparator.ts";
import {
  formatExitConversationAck,
  resolveWakeAckReply,
} from "./cavemanReplyPolicy.ts";
import { TtsEchoGuard } from "./echoGuard.ts";
import { LocalVoiceEngine, type LocalVoiceEngineStatus } from "./localVoiceEngine.ts";
import type {
  OpenWakeWordBootstrapResult,
  OpenWakeWordEngineStatus,
  OpenWakeWordEnrollResult,
  WakeWordAcousticHit,
} from "./openWakeWordEngine.ts";
import type {
  AgentActiveTask,
  AgentToolCallRecord,
  PiAgentRunResult,
  PiAgentService,
} from "./piAgentService.ts";
import { stripCommittedPrefix } from "./streamingAsrTracker.ts";
import type {
  CommandIntentChoice,
  SystemOneClient,
  SystemOneHealthSnapshot,
  SystemOneHistoryEntry,
} from "./systemOneClient.ts";
import { TASK_ACK_PREWARM_PHRASES_ZH } from "./taskAckPolicy.ts";
import type { VoiceStreamSegmentPayload } from "./voiceStreamSession.ts";
import {
  evaluateVoiceAttention,
  findWakeWordSpan,
  hasExplicitDeviceControlCommand,
  type AttentionDecision,
  type AttentionLlmEvaluator,
} from "./voiceAttentionGate.ts";
import {
  deleteVoiceprint,
  enrollVoiceprint,
  identifyVoiceprint,
  listPublicVoiceprints,
  type PublicVoiceprintProfile,
  type VoiceprintIdentifyResult,
  type VoiceprintRole,
} from "./voiceprintStore.ts";
import {
  deleteWakeWordPrototypeById,
  deleteWakeWordPrototypesForWord,
  getPrototypesForWords,
  listWakeWordPrototypeSummaries,
  type WakeWordPrototypeSummary,
} from "./wakewordPrototypeStore.ts";

export type VoiceListenMode = "idle" | "listening" | "awake" | "processing" | "speaking" | "error";
export type VoiceDialogState = "standby" | "conversation";
export type VoiceRuntimeEngine = "local" | "browser" | "whisper" | "manual";

export interface VoiceListenerControllerOptions {
  fetcher?: FetchLike;
  localEngine?: LocalVoiceEngine;
}

export interface WakeWordSpotRecord extends WakeWordAcousticHit {
  timestamp: number;
}

export interface VoicePipelineTimings {
  denoiseMs?: number;
  vadMs?: number;
  voiceprintMs?: number;
  asrMs?: number;
  attentionMs?: number;
  agentMs?: number;
  totalMs: number;
}

export interface VoiceTranscriptEntry {
  id: string;
  text: string;
  matched: boolean;
  wokeOnly: boolean;
  command: string;
  reply?: string;
  error?: string;
  timestamp: number;
  speakerName?: string | null;
  speakerScore?: number;
  attentionStage?: AttentionDecision["stage"];
  attentionReason?: string;
  passSource?: AttentionDecision["passSource"];
  matchedCapability?: string;
  intent?: CommandIntentChoice;
  acousticWakeScore?: number;
  snrGainDb?: number;
  timings?: VoicePipelineTimings;
}

export interface VoiceLastMetrics {
  denoiseEngine?: string;
  snrGainDb?: number;
  vadEngine?: string;
  speechRatio?: number;
  asrEngine?: string;
  detectedSoundTypes?: SoundTypeTag[];
  detectedSpeakerCount?: number;
  separatedStreams?: SeparatedAudioStreamInfo[];
  voiceprint?: VoiceprintIdentifyResult | null;
  acousticWake?: WakeWordAcousticHit | null;
  intent?: CommandIntentChoice;
  attention?: AttentionDecision | null;
  timings?: VoicePipelineTimings | null;
  updatedAt: number;
}

export interface VoiceRuntimeLanes {
  conversation: {
    active: boolean;
    dialogState: VoiceDialogState;
    speechActive: boolean;
    fullDuplex: boolean;
  };
  execution: {
    active: boolean;
    activeCount: number;
    tasks: AgentActiveTask[];
  };
  speaking: {
    active: boolean;
    utteranceId: string | null;
    text: string | null;
    queueLength: number;
    ducked: boolean;
  };
  echo: {
    mode: EchoCancellationMode;
    activeAec: boolean;
    erleDb: number;
    doubleTalkActive: boolean;
    suppressedCount: number;
    strippedCount: number;
    activeTtsUtterances: number;
  };
}

export interface VoiceListenerSnapshot {
  active: boolean;
  mode: VoiceListenMode;
  dialogState: VoiceDialogState;
  dialogEpoch: number;
  serverNow: number;
  timerPaused: boolean;
  conversationRemainingMs: number;
  conversationWindowSec: number;
  maxConsecutiveSidetalk: number;
  consecutiveSidetalkCount: number;
  lastTransitionReason: string | null;
  engine: VoiceRuntimeEngine;
  voicePipelineMode: AgentVoiceConfig["voicePipelineMode"];
  xfyunEndpointUrl: string;
  xfyunAppId: string;
  effectiveXfyunConfigured: boolean;
  voiceWsAsrEndpointUrl: string;
  voiceWsAsrDenoise: boolean;
  voiceWsAsrLanguage: string;
  effectiveVoiceWsAsrConfigured: boolean;
  streamingAsrEnabled: boolean;
  asyncVoicePipeline: boolean;
  echoCancellationMode: EchoCancellationMode;
  bargeInDuckingEnabled: boolean;
  lanes: VoiceRuntimeLanes;
  interimTranscript: string;
  lastTranscript: string;
  lastCommand: string;
  awakeUntil: number | null;
  conversationUntil: number | null;
  error: string | null;
  wakeWordEnabled: boolean;
  wakeWords: string[];
  wakeAckPhrase: string;
  autoSpeakReply: boolean;
  ttsEngine: AgentVoiceConfig["ttsEngine"];
  ttsVoice: AgentVoiceConfig["ttsVoice"];
  ttsSpeed: number;
  attentionMode: AgentVoiceConfig["attentionMode"];
  noiseSuppressionMode: AgentVoiceConfig["noiseSuppressionMode"];
  voiceprintMode: AgentVoiceConfig["voiceprintMode"];
  cavemanMode: CavemanReplyMode;
  owwEnabled: boolean;
  owwThreshold: number;
  localEngine: LocalVoiceEngineStatus;
  openWakeWord: OpenWakeWordEngineStatus;
  wakeWordPrototypes: WakeWordPrototypeSummary[];
  lastWakeHit: WakeWordSpotRecord | null;
  systemOneHealth: SystemOneHealthSnapshot | null;
  systemOne: SystemOneHealthSnapshot | null;
  voiceprints: PublicVoiceprintProfile[];
  lastMetrics: VoiceLastMetrics | null;
  history: VoiceTranscriptEntry[];
}

export interface WakeMatchResult {
  matched: boolean;
  wokeOnly: boolean;
  wakeWord: string | null;
  command: string;
}

export interface HandleTranscriptOptions {
  isFinal?: boolean;
  bypassWakeWord?: boolean;
  engine?: VoiceRuntimeEngine;
  now?: number;
  segmentDurationMs?: number;
  acousticEvent?: string;
  altText?: string;
  acousticWake?: WakeWordAcousticHit | null;
  owwEvaluated?: boolean;
  owwActiveForWord?: boolean;
  voiceprint?: VoiceprintIdentifyResult | null;
  snrGainDb?: number;
  timingsBase?: Partial<VoicePipelineTimings>;
  llmAttentionOverride?: AttentionLlmEvaluator;
  precomputedAttention?: AttentionDecision;
  /** 开启异步非阻塞派发：命令确认后立即投递后台执行并返回，不阻塞语音监听与后续对话 */
  asyncDispatch?: boolean;
  /** 音频是否在 TTS 播报期间或刚结束的回声尾窗内采集 */
  duringTtsPlayback?: boolean;
}

export interface HandleTranscriptResult {
  ok: boolean;
  matched: boolean;
  wokeOnly: boolean;
  dispatchedAsync?: boolean;
  taskId?: string;
  entryId?: string;
  command: string;
  reply?: string;
  toolCalls?: AgentToolCallRecord[];
  attention?: AttentionDecision;
  voiceprint?: VoiceprintIdentifyResult | null;
  acousticWake?: WakeWordAcousticHit | null;
  timings?: VoicePipelineTimings;
  error?: string;
  voiceState: VoiceListenerSnapshot;
}

export interface ProcessAudioUploadResult extends HandleTranscriptResult {
  text: string;
  speechDetected: boolean;
  denoiseEngine: string;
  vadEngine: string;
  asrEngine: string;
  inputSnrDb?: number;
  outputSnrDb?: number;
  snrGainDb?: number;
  speechRatio?: number;
  acousticEvent?: string;
  detectedSoundTypes?: SoundTypeTag[];
  detectedSpeakerCount?: number;
  separatedStreams?: SeparatedAudioStreamInfo[];
}

export interface SpeakRequestMeta {
  utteranceId?: string;
  priority?: "ack" | "normal" | "result" | "system";
  taskId?: string;
  interrupt?: boolean;
}

export type VoiceListenerEvents = {
  stateChanged: [VoiceListenerSnapshot];
  speakRequested: [string, SpeakRequestMeta?];
  speakChunkRequested: [
    {
      text: string;
      final: boolean;
      utteranceId?: string;
      priority?: "ack" | "normal" | "result" | "system";
      taskId?: string;
    },
  ];
};

const LEADING_PUNCT_RE = /^[\s,，。．.、!！?？:：;；\-—~～]+/;
const TRAILING_PUNCT_RE = /[\s,，。．.、!！?？:：;；]+$/;
const CANCEL_RUNNING_TASK_RE =
  /^(?:停止执行|取消执行|取消任务|取消刚才的任务|取消刚才的操作|别执行了|不要执行了|停止刚才的操作|停止任务)$/i;
const MAX_SPEECH_GRACE_MS = 3500;
const CONTINUOUS_VAD_STALE_MS = 5000;
const TTS_PAUSE_WATCHDOG_MS = 30_000;

/**
 * 兼容式唤醒词提取器（供单元测试与轻量调用使用，现支持常见中文同音纠错）。
 */
export function extractWakeCommand(
  rawText: string,
  options: {
    wakeWordEnabled: boolean;
    wakeWords: readonly string[];
    bypassWakeWord?: boolean;
    awakeActive?: boolean;
  },
): WakeMatchResult {
  const cleaned = rawText.trim();
  if (!cleaned) {
    return { matched: false, wokeOnly: false, wakeWord: null, command: "" };
  }

  if (!options.wakeWordEnabled || options.bypassWakeWord || options.awakeActive) {
    const cmd = cleaned.replace(LEADING_PUNCT_RE, "").replace(TRAILING_PUNCT_RE, "").trim();
    return {
      matched: cmd.length > 0,
      wokeOnly: false,
      wakeWord: null,
      command: cmd,
    };
  }

  const span = findWakeWordSpan(cleaned, options.wakeWords);
  if (!span) {
    if (hasExplicitDeviceControlCommand(cleaned)) {
      const cmd = cleaned.replace(LEADING_PUNCT_RE, "").replace(TRAILING_PUNCT_RE, "").trim();
      return {
        matched: cmd.length > 0,
        wokeOnly: false,
        wakeWord: null,
        command: cmd,
      };
    }
    return { matched: false, wokeOnly: false, wakeWord: null, command: "" };
  }
  if (span.afterText.length > 0) {
    return {
      matched: true,
      wokeOnly: false,
      wakeWord: span.wakeWord,
      command: span.afterText,
    };
  }
  return {
    matched: true,
    wokeOnly: true,
    wakeWord: span.wakeWord,
    command: "",
  };
}

export class VoiceListenerController extends TypedEmitter<VoiceListenerEvents> {
  private readonly _agent: PiAgentService;
  private readonly _fetcher: FetchLike;
  private readonly _localEngine: LocalVoiceEngine;
  private readonly _echoGuard = new TtsEchoGuard();
  private readonly _unsubAgentSpeak: () => void;
  private readonly _unsubConfirmationPending: () => void;
  private _lastDedupPendingId: string | null = null;

  private _active = false;
  private _mode: VoiceListenMode = "idle";
  private _dialogState: VoiceDialogState = "standby";
  private _dialogEpoch = 0;
  private _conversationTimer: ReturnType<typeof setTimeout> | null = null;
  private _ttsPauseWatchdog: ReturnType<typeof setTimeout> | null = null;
  private _timerPaused = false;
  private _remainingConversationMs = 0;
  private _conversationBaseUntil: number | null = null;
  private _conversationHardUntil: number | null = null;
  private _speechInProgress = false;
  private _speechActivityStartedAt: number | null = null;
  private _speechGraceSuppressed = false;
  private _consecutiveAmbientNoiseCount = 0;
  private _consecutiveSidetalkCount = 0;
  private _conversationSpeakerName: string | null = null;
  private _lastTransitionReason: string | null = null;
  private _lastWakeHit: WakeWordSpotRecord | null = null;
  private _engine: VoiceRuntimeEngine = "local";
  private _interimTranscript = "";
  private _lastTranscript = "";
  private _lastCommand = "";
  private _awakeUntil: number | null = null;
  private _conversationUntil: number | null = null;
  private _lastSpokenReply = "";
  private _lastSpokenAt = 0;
  private _error: string | null = null;
  private _history: VoiceTranscriptEntry[] = [];
  private _lastMetrics: VoiceLastMetrics | null = null;
  private _lastDispatchedText = "";
  private _lastDispatchedNormText = "";
  private _lastDispatchedAt = 0;
  private _lastDispatchedCompletedAt = 0;
  private _seq = 0;

  constructor(
    agent: PiAgentService,
    options: VoiceListenerControllerOptions = {},
  ) {
    super();
    this._agent = agent;
    this._fetcher = options.fetcher ?? globalThis.fetch;
    this._localEngine = options.localEngine ?? new LocalVoiceEngine();
    this._syncLocalEngineConfig();
    const initLocalStatus = this._localEngine.getStatus();
    this._engine =
      initLocalStatus.readyForLocalAsr ||
      (this.config.voicePipelineMode === "xfyun" && initLocalStatus.readyForXfyunIat) ||
      (this.config.voicePipelineMode === "voice-ws" && initLocalStatus.readyForVoiceWsAsr)
        ? "local"
        : "browser";

    // 转发 Pi Agent 流式分句语音播报事件，并登记到多语段回声账本（带唯一 utteranceId 与确认提问标记）
    this._unsubAgentSpeak = this._agent.on(
      "speakChunk",
      ({ text, final, taskId, priority, isConfirmationPrompt }) => {
        if (!this.config.autoSpeakReply) return;
        const rec = this._recordSpoken(text, Date.now(), {
          priority,
          taskId,
          isConfirmationPrompt,
        });
        this.emit("speakChunkRequested", {
          text,
          final,
          utteranceId: rec?.id,
          priority,
          taskId,
        });
      },
    );

    // 当 Pi Agent 抛出结构化待确认提问时，保持至少 20s 固定倒计时连续对话窗口（即使 conversationWindowSec === 0）
    this._unsubConfirmationPending = this._agent.on("confirmationPending", () => {
      const keepMs = Math.max(20_000, this.config.conversationWindowSec * 1000);
      const nowMs = Date.now();
      this._dialogState = "conversation";
      this._consecutiveSidetalkCount = 0;
      this._consecutiveAmbientNoiseCount = 0;
      this._speechGraceSuppressed = false;
      this._lastTransitionReason = "confirmation_pending";
      const nextUntil = nowMs + keepMs;
      this._conversationUntil = nextUntil;
      this._awakeUntil = nextUntil;
      this._remainingConversationMs = keepMs;
      this._setConversationDeadlines(nextUntil, true);
      if (!this._timerPaused) {
        this._armConversationTimer(keepMs, this._dialogEpoch);
      }
      if (this._active) {
        this._mode = "awake";
      }
      this.emit("stateChanged", this.snapshot());
    });
  }

  get config(): AgentVoiceConfig {
    return this._agent.config;
  }

  get localEngine(): LocalVoiceEngine {
    return this._localEngine;
  }

  get echoGuard(): TtsEchoGuard {
    return this._echoGuard;
  }

  get dialogState(): VoiceDialogState {
    return this._dialogState;
  }

  get dialogEpoch(): number {
    return this._dialogEpoch;
  }

  get systemOneClient(): SystemOneClient | null {
    return this._agent.systemOneClient;
  }

  private _syncLocalEngineConfig(): void {
    const cfg = this.config;
    const xfyunAuth = resolveEffectiveXfyunAuth(cfg);
    const voiceWsAuth = resolveEffectiveVoiceWsAsrAuth(cfg);
    this._localEngine.setXfyunIatConfig?.({
      endpointUrl: xfyunAuth.endpointUrl,
      appId: xfyunAuth.appId,
      apiKey: xfyunAuth.apiKey,
      apiSecret: xfyunAuth.apiSecret,
    });
    this._localEngine.setVoiceWsAsrConfig?.({
      endpointUrl: voiceWsAuth.endpointUrl,
      authCode: voiceWsAuth.authCode,
      denoise: voiceWsAuth.denoise,
      language: voiceWsAuth.language,
    });
  }

  getRecentHistoryForSystemOne(limit = 5): SystemOneHistoryEntry[] {
    return this._agent.recentConversationTurns(limit).map((t) => ({
      role: t.role,
      text: t.text,
    }));
  }

  private _clearConversationTimer(): void {
    if (this._conversationTimer !== null) {
      clearTimeout(this._conversationTimer);
      this._conversationTimer = null;
    }
  }

  private _clearTtsPauseWatchdog(): void {
    if (this._ttsPauseWatchdog !== null) {
      clearTimeout(this._ttsPauseWatchdog);
      this._ttsPauseWatchdog = null;
    }
  }

  private _setConversationDeadlines(baseUntil: number | null, allowSpeechGrace = true): void {
    this._conversationBaseUntil = baseUntil;
    this._conversationHardUntil =
      baseUntil !== null ? baseUntil + (allowSpeechGrace ? MAX_SPEECH_GRACE_MS : 0) : null;
  }

  /**
   * 计算当前对话轮次还剩余多少“说话中防截断顺延”额度（严格有界，防止背景音乐/环境噪音驱动 VAD 无限续期）。
   */
  private _remainingSpeechGraceMs(now: number): number {
    if (
      this._dialogState !== "conversation" ||
      this._timerPaused ||
      !this._speechInProgress ||
      this._speechGraceSuppressed ||
      this._conversationHardUntil === null
    ) {
      return 0;
    }
    if (
      this._speechActivityStartedAt !== null &&
      now - this._speechActivityStartedAt > CONTINUOUS_VAD_STALE_MS
    ) {
      return 0;
    }
    return Math.max(0, this._conversationHardUntil - now);
  }

  /**
   * 记录连续对话期间收到一段纯背景噪音/背景音乐或被注意力门控拒绝的片段：
   * - 连续 >= 2 段纯背景音/音乐时抑制 VAD 说话顺延并回收已提前扩展的窗口；
   * - 若已超过基础对话截止时间（仅靠顺延等待中），立即退出对话模式。
   */
  private _noteNonConversationSegment(
    kind: "ambient_noise" | "rejected",
    now = Date.now(),
  ): boolean {
    if (this._dialogState !== "conversation" || this._timerPaused) {
      return false;
    }
    if (kind === "ambient_noise") {
      this._consecutiveAmbientNoiseCount += 1;
      if (this._consecutiveAmbientNoiseCount >= 2) {
        this._speechGraceSuppressed = true;
      }
    }

    if (this._conversationBaseUntil !== null && now >= this._conversationBaseUntil) {
      this.exitConversation("timeout", { speakAck: false, now });
      return true;
    }

    if (this._speechGraceSuppressed && this._conversationBaseUntil !== null) {
      this._conversationHardUntil = this._conversationBaseUntil;
      const currentDeadline = this._conversationUntil ?? this._awakeUntil;
      if (currentDeadline !== null && currentDeadline > this._conversationBaseUntil) {
        const clamped = this._conversationBaseUntil;
        if (this._conversationUntil !== null) {
          this._conversationUntil = clamped;
        } else if (this._awakeUntil !== null) {
          this._awakeUntil = clamped;
        }
        const remaining = clamped - now;
        if (remaining <= 0) {
          this.exitConversation("timeout", { speakAck: false, now });
          return true;
        }
        this._armConversationTimer(remaining, this._dialogEpoch);
        this.emit("stateChanged", this.snapshot());
      }
    }
    return false;
  }

  private _armConversationTimer(durationMs: number, epoch: number): void {
    this._clearConversationTimer();
    if (durationMs <= 0 || this._dialogState !== "conversation") {
      return;
    }
    this._remainingConversationMs = Math.max(0, Math.round(durationMs));
    if (this._timerPaused) {
      return;
    }
    this._conversationTimer = setTimeout(() => {
      this._conversationTimer = null;
      if (this._dialogState !== "conversation" || this._dialogEpoch !== epoch) {
        return;
      }
      if (this._timerPaused) {
        return;
      }
      const now = Date.now();
      const graceMs = this._remainingSpeechGraceMs(now);
      if (graceMs >= 250) {
        const extendMs = Math.min(MAX_SPEECH_GRACE_MS, graceMs);
        const nextUntil = now + extendMs;
        if (this._conversationUntil !== null) {
          this._conversationUntil = nextUntil;
        } else if (this._awakeUntil !== null) {
          this._awakeUntil = nextUntil;
        }
        this._armConversationTimer(extendMs, epoch);
        this.emit("stateChanged", this.snapshot());
        return;
      }
      this.exitConversation("timeout", { speakAck: false });
    }, Math.max(50, Math.round(durationMs)));
    (this._conversationTimer as { unref?: () => void }).unref?.();
  }

  /**
   * 显式进入连续对话状态（由服务端状态机托管固定秒数倒计时，到期自动推 WS 回归待机）。
   */
  enterConversation(
    reason: string,
    options: { speakAck?: boolean; now?: number; speakerName?: string | null } = {},
  ): VoiceListenerSnapshot {
    const now = options.now ?? Date.now();
    const cfg = this.config;
    const ack = resolveWakeAckReply(cfg.wakeAckPhrase);
    const willSpeakAck = Boolean(options.speakAck && cfg.autoSpeakReply && ack.length > 0);
    const ttsGraceMs = willSpeakAck ? 1200 : 0;
    this._dialogEpoch += 1;
    const epoch = this._dialogEpoch;
    this._clearTtsPauseWatchdog();
    this._dialogState = "conversation";
    this._consecutiveSidetalkCount = 0;
    this._consecutiveAmbientNoiseCount = 0;
    this._speechGraceSuppressed = false;
    if (options.speakerName?.trim()) {
      this._conversationSpeakerName = options.speakerName.trim();
    }
    this._lastTransitionReason = reason;
    this._timerPaused = false;
    const wakeMs = cfg.wakeWindowSec * 1000 + ttsGraceMs;
    const convMs =
      cfg.conversationWindowSec > 0 ? cfg.conversationWindowSec * 1000 + ttsGraceMs : 0;
    const timerMs = convMs > 0 ? convMs : reason === "wake_only" ? wakeMs : 0;
    this._awakeUntil = now + wakeMs;
    this._conversationUntil = convMs > 0 ? now + convMs : null;
    this._remainingConversationMs = convMs > 0 ? convMs : wakeMs;
    this._setConversationDeadlines(timerMs > 0 ? now + timerMs : null, true);
    this._mode = "awake";

    if (timerMs > 0) {
      this._armConversationTimer(timerMs, epoch);
    } else {
      this._clearConversationTimer();
    }

    const snap = this.snapshot();
    this.emit("stateChanged", snap);
    if (willSpeakAck) {
      const rec = this._recordSpoken(ack, now, { priority: "ack" });
      this.emit("speakRequested", ack, {
        utteranceId: rec?.id,
        priority: "ack",
        interrupt: false,
      });
    }
    return snap;
  }

  /**
   * 显式退出连续对话状态并回归待机监听。
   */
  exitConversation(
    reason: string,
    options: { speakAck?: boolean; now?: number } = {},
  ): VoiceListenerSnapshot {
    const now = options.now ?? Date.now();
    const cfg = this.config;
    this._dialogEpoch += 1;
    this._clearConversationTimer();
    this._clearTtsPauseWatchdog();
    this._dialogState = "standby";
    this._awakeUntil = null;
    this._conversationUntil = null;
    this._conversationBaseUntil = null;
    this._conversationHardUntil = null;
    this._remainingConversationMs = 0;
    this._timerPaused = false;
    this._consecutiveSidetalkCount = 0;
    this._consecutiveAmbientNoiseCount = 0;
    this._speechGraceSuppressed = false;
    this._conversationSpeakerName = null;
    this._lastTransitionReason = reason;
    this._resetDedupState();
    if (this._mode !== "processing" && this._mode !== "error") {
      this._mode = this._active ? "listening" : "idle";
    }

    const snap = this.snapshot();
    this.emit("stateChanged", snap);
    if (options.speakAck && cfg.autoSpeakReply) {
      const ack = formatExitConversationAck(cfg.cavemanMode);
      const rec = this._recordSpoken(ack, now, { priority: "system" });
      this.emit("speakRequested", ack, {
        utteranceId: rec?.id,
        priority: "system",
        interrupt: true,
      });
    }
    return snap;
  }

  /**
   * 切换待机 / 连续对话状态（供标题栏胶囊按钮与快捷键调用）。
   */
  toggleConversation(): VoiceListenerSnapshot {
    if (this._dialogState === "conversation") {
      return this.exitConversation("manual_toggle", { speakAck: false });
    }
    return this.enterConversation("manual_toggle", { speakAck: false });
  }

  /**
   * TTS 播报开始/结束通知：暂停/恢复对话倒计时，绝不覆盖 dialogState 或 mode="awake"。
   */
  setTtsSpeaking(speaking: boolean): void {
    if (speaking) {
      const currentDeadline = this._conversationUntil ?? this._awakeUntil;
      if (!this._timerPaused && this._dialogState === "conversation" && currentDeadline !== null) {
        this._remainingConversationMs = Math.max(1000, currentDeadline - Date.now());
      }
      const changed = !this._timerPaused;
      this._timerPaused = true;
      this._clearConversationTimer();
      this._clearTtsPauseWatchdog();
      const pauseEpoch = this._dialogEpoch;
      this._ttsPauseWatchdog = setTimeout(() => {
        this._ttsPauseWatchdog = null;
        if (this._timerPaused && this._dialogEpoch === pauseEpoch) {
          this.setTtsSpeaking(false);
        }
      }, TTS_PAUSE_WATCHDOG_MS);
      (this._ttsPauseWatchdog as { unref?: () => void }).unref?.();
      if (changed) {
        this.emit("stateChanged", this.snapshot());
      }
      return;
    }
    this._clearTtsPauseWatchdog();
    if (!this._timerPaused) return;
    this._timerPaused = false;
    if (this._dialogState === "conversation") {
      const cfg = this.config;
      if (cfg.conversationWindowSec > 0) {
        const resumeMs = Math.max(
          3000,
          this._remainingConversationMs > 0
            ? this._remainingConversationMs
            : cfg.conversationWindowSec * 1000,
        );
        const nextUntil = Date.now() + resumeMs;
        this._conversationUntil = nextUntil;
        this._setConversationDeadlines(nextUntil, !this._speechGraceSuppressed);
        this._armConversationTimer(resumeMs, this._dialogEpoch);
        this.emit("stateChanged", this.snapshot());
      } else if (this._awakeUntil !== null) {
        const resumeMs = Math.max(
          3000,
          this._remainingConversationMs > 0
            ? this._remainingConversationMs
            : cfg.wakeWindowSec * 1000,
        );
        const nextUntil = Date.now() + resumeMs;
        this._awakeUntil = nextUntil;
        this._setConversationDeadlines(nextUntil, !this._speechGraceSuppressed);
        this._armConversationTimer(resumeMs, this._dialogEpoch);
        this.emit("stateChanged", this.snapshot());
      } else {
        this.emit("stateChanged", this.snapshot());
      }
    }
  }

  /**
   * 实时说话活动通知：若用户正说到一半临近超时，在单轮有界顺延额度（最多 +3.5s）内防截断，
   * 绝不被持续环境噪音/背景音乐触发的 VAD 无限续期。
   */
  setSpeechInProgress(speaking: boolean): void {
    const now = Date.now();
    const wasSpeaking = this._speechInProgress;
    this._speechInProgress = speaking;
    if (speaking) {
      if (!wasSpeaking) {
        this._speechActivityStartedAt = now;
      }
    } else {
      this._speechActivityStartedAt = null;
      return;
    }

    const currentDeadline = this._conversationUntil ?? this._awakeUntil;
    if (
      this._dialogState === "conversation" &&
      !this._timerPaused &&
      currentDeadline !== null &&
      this._conversationHardUntil !== null
    ) {
      const graceLeft = this._remainingSpeechGraceMs(now);
      const remaining = currentDeadline - now;
      if (
        graceLeft >= 250 &&
        remaining < MAX_SPEECH_GRACE_MS &&
        currentDeadline < this._conversationHardUntil
      ) {
        const nextUntil = Math.min(this._conversationHardUntil, now + MAX_SPEECH_GRACE_MS);
        if (nextUntil > currentDeadline + 100) {
          if (this._conversationUntil !== null) {
            this._conversationUntil = nextUntil;
          } else if (this._awakeUntil !== null) {
            this._awakeUntil = nextUntil;
          }
          this._armConversationTimer(nextUntil - now, this._dialogEpoch);
          this.emit("stateChanged", this.snapshot());
        }
      }
    }
  }

  recordWakeWordSpot(hit: WakeWordAcousticHit): void {
    this._lastWakeHit = { ...hit, timestamp: Date.now() };
  }

  /**
   * 接收前端播报通道与实时 AEC 回声消除状态同步（解耦于对话通道，绝不覆盖 dialogState）。
   */
  handleTtsClientState(patch: {
    speaking?: boolean;
    phase?: "start" | "end" | "cancel" | "duck" | "unduck" | "telemetry";
    utteranceId?: string | null;
    text?: string | null;
    queueLength?: number;
    ducked?: boolean;
    aecActive?: boolean;
    erleDb?: number;
    doubleTalk?: boolean;
  }): void {
    const prevSpeaking = this._echoGuard.isSpeaking;
    const prevDucked = this._echoGuard.clientDucked;
    const prevUtterance = this._echoGuard.activeUtteranceId;
    const prevAec = this._echoGuard.aecActive;
    const prevDt = this._echoGuard.doubleTalkActive;

    this._echoGuard.updateClientPlaybackState(patch);
    if (patch.phase === "end" || patch.speaking === false) {
      this._agent.markConfirmationPromptTtsEnded();
      if (this._agent.getActivePendingConfirmationGateContext()) {
        const keepMs = Math.max(20_000, this.config.conversationWindowSec * 1000);
        const nowMs = Date.now();
        this._dialogState = "conversation";
        const nextUntil = nowMs + keepMs;
        this._conversationUntil = nextUntil;
        this._awakeUntil = nextUntil;
        this._remainingConversationMs = keepMs;
        this._setConversationDeadlines(nextUntil, true);
        this._armConversationTimer(keepMs, this._dialogEpoch);
      }
    }
    if (typeof patch.speaking === "boolean") {
      this.setTtsSpeaking(patch.speaking);
    }

    const changed =
      prevSpeaking !== this._echoGuard.isSpeaking ||
      prevDucked !== this._echoGuard.clientDucked ||
      prevUtterance !== this._echoGuard.activeUtteranceId ||
      prevAec !== this._echoGuard.aecActive ||
      prevDt !== this._echoGuard.doubleTalkActive;
    if (changed) {
      this.emit("stateChanged", this.snapshot());
    }
  }

  private _recordSpoken(
    text: string,
    now = Date.now(),
    meta?: {
      priority?: "ack" | "normal" | "result" | "system";
      taskId?: string;
      isConfirmationPrompt?: boolean;
    },
  ) {
    const t = text.trim();
    if (!t) return null;
    if (now >= this._lastSpokenAt && now - this._lastSpokenAt < 3500 && this._lastSpokenReply.length < 300) {
      this._lastSpokenReply = `${this._lastSpokenReply} ${t}`.trim();
    } else {
      this._lastSpokenReply = t;
    }
    this._lastSpokenAt = now;
    return this._echoGuard.registerUtterance(t, {
      now,
      priority: meta?.priority,
      taskId: meta?.taskId,
      isConfirmationPrompt: meta?.isConfirmationPrompt,
    });
  }

  private _normalizeDedupText(raw: string): string {
    return raw
      .trim()
      .toLowerCase()
      .replace(/[\s,，。．.、!！?？:：;；"'`“”‘’~～]+/g, "");
  }

  private _resetDedupState(): void {
    this._lastDispatchedText = "";
    this._lastDispatchedNormText = "";
    this._lastDispatchedAt = 0;
    this._lastDispatchedCompletedAt = 0;
  }

  /**
   * 后台预热本地温柔女声神经 TTS 并缓存唤醒词回复短语与全部场景化即时应答词（实现近零延迟播报）。
   */
  async prewarmLocalTts(): Promise<void> {
    const cfg = this.config;
    if (cfg.ttsEngine === "browser" || !cfg.autoSpeakReply) return;
    const ack = resolveWakeAckReply(cfg.wakeAckPhrase);
    const exitAck = formatExitConversationAck(cfg.cavemanMode);
    const prewarmTexts = [
      ...new Set([...TASK_ACK_PREWARM_PHRASES_ZH, ...(ack ? [ack] : []), exitAck]),
    ];
    await this._localEngine.tts.warmup({
      voice: cfg.ttsVoice,
      speed: cfg.ttsSpeed,
      prewarmTexts,
    });
  }

  updateRuntimeState(patch: {
    active?: boolean;
    mode?: VoiceListenMode;
    engine?: VoiceRuntimeEngine;
    interimTranscript?: string;
    error?: string | null;
  }): VoiceListenerSnapshot {
    this._syncLocalEngineConfig();
    if (patch.active !== undefined) {
      this._active = Boolean(patch.active);
      if (!this._active) {
        this._clearConversationTimer();
        this._clearTtsPauseWatchdog();
        this._dialogEpoch += 1;
        this._dialogState = "standby";
        this._mode = "idle";
        this._interimTranscript = "";
        this._awakeUntil = null;
        this._conversationUntil = null;
        this._conversationBaseUntil = null;
        this._conversationHardUntil = null;
        this._remainingConversationMs = 0;
        this._timerPaused = false;
        this._speechInProgress = false;
        this._speechActivityStartedAt = null;
        this._speechGraceSuppressed = false;
        this._consecutiveAmbientNoiseCount = 0;
        this._consecutiveSidetalkCount = 0;
        this._lastTransitionReason = "stopped";
        this._resetDedupState();
      } else if (this._mode === "idle" || this._mode === "error") {
        this._mode = "listening";
        this._error = null;
      }
      if (this._active) {
        // 开启监听时预连接 SystemOne 网关，并异步分片预热本地 ONNX 模型（含主声纹 VoxLock）、温柔女声 TTS 与 openWakeWord 零样本原型
        this._agent.systemOneClient?.preconnect();
        const hasAsciiWake = this.config.wakeWords.some((w) => /^[a-z][a-z0-9\s-]*$/i.test(w.trim()));
        void this._localEngine.warmup({
          preloadEnglish: hasAsciiWake,
          voicePipelineMode: this.config.voicePipelineMode,
        });
        if (this.config.sourceSeparationMode !== "off") {
          void this._localEngine.sourceSeparator.warmupAsync().catch(() => {});
        }
        if (this.config.owwEnabled) {
          void this._localEngine.openWakeWord
            .bootstrapWakeWords(this.config.wakeWords)
            .catch(() => {});
        }
        if (this.config.ttsEngine !== "browser" && this.config.autoSpeakReply) {
          void this.prewarmLocalTts().catch(() => {});
        }
      }
    }
    if (patch.engine !== undefined) {
      this._engine = patch.engine;
    }
    if (patch.interimTranscript !== undefined) {
      this._interimTranscript = patch.interimTranscript;
    }
    if (patch.error !== undefined) {
      this._error = patch.error;
      if (patch.error) {
        this._mode = "error";
      }
    }
    if (patch.mode !== undefined) {
      this._mode = patch.mode;
    }

    const snap = this.snapshot();
    this.emit("stateChanged", snap);
    return snap;
  }

  async handleTranscript(
    rawText: string,
    options: HandleTranscriptOptions = {},
  ): Promise<HandleTranscriptResult> {
    const totalStart = performance.now();
    const now = options.now ?? Date.now();
    const text = rawText.trim();
    if (options.engine) {
      this._engine = options.engine;
    }

    if (options.isFinal === false) {
      this._interimTranscript = text;
      const snap = this.snapshot();
      this.emit("stateChanged", snap);
      return {
        ok: true,
        matched: false,
        wokeOnly: false,
        command: "",
        voiceState: snap,
      };
    }

    this._interimTranscript = "";
    if (!text) {
      return {
        ok: true,
        matched: false,
        wokeOnly: false,
        command: "",
        voiceState: this.snapshot(),
      };
    }

    // 静音/热词 Prompt 回显幻觉早退：不污染 lastTranscript，也不触发 Pi Agent 或“在呢”应答
    if (isAsrHallucinationText(text, this.config.wakeWords)) {
      this._noteNonConversationSegment("ambient_noise", now);
      return {
        ok: true,
        matched: false,
        wokeOnly: false,
        command: "",
        voiceState: this.snapshot(),
      };
    }

    const prevLastTranscript = this._lastTranscript;
    this._lastTranscript = text;
    this._error = null;

    // 1.8s（或上条刚执行完毕 1.5s）内相同最终识别结果去重（归一化标点与空格，防止浏览器/VAD 重复回调）
    // 若挂起确认槽 ID 已切换（连续两个不同确认都答复“好/嗯”），跳过旧去重拦截
    const activePendingCtx = this._agent.getActivePendingConfirmationGateContext();
    const activePendingId = activePendingCtx?.id ?? null;
    const normText = this._normalizeDedupText(text);
    const samePendingEpoch = activePendingId === this._lastDedupPendingId;
    const sameAsLast =
      samePendingEpoch &&
      (text === this._lastDispatchedText ||
        (normText.length >= 2 && normText === this._lastDispatchedNormText));
    const withinStartWindow =
      this._lastDispatchedAt > 0 && now >= this._lastDispatchedAt && now - this._lastDispatchedAt < 1800;
    const withinCompletedWindow =
      this._lastDispatchedCompletedAt > 0 &&
      now >= this._lastDispatchedCompletedAt &&
      now - this._lastDispatchedCompletedAt < 1500;
    if (sameAsLast && (withinStartWindow || withinCompletedWindow)) {
      return {
        ok: true,
        matched: false,
        wokeOnly: false,
        command: "",
        voiceState: this.snapshot(),
      };
    }

    const cfg = this.config;
    const speechStartedAt = Math.max(0, now - Math.min(30_000, options.segmentDurationMs ?? 0));
    const awakeActive =
      this._awakeUntil !== null && (now < this._awakeUntil || speechStartedAt < this._awakeUntil);
    if (!awakeActive && this._awakeUntil !== null) {
      this._awakeUntil = null;
    }
    const convWindowActive =
      cfg.conversationWindowSec > 0 &&
      this._conversationUntil !== null &&
      (now < this._conversationUntil || speechStartedAt < this._conversationUntil);
    if (!convWindowActive && this._conversationUntil !== null) {
      this._conversationUntil = null;
    }
    if (
      this._dialogState === "conversation" &&
      !awakeActive &&
      !convWindowActive &&
      !this._timerPaused
    ) {
      this._dialogEpoch += 1;
      this._dialogState = "standby";
      this._clearConversationTimer();
      this._clearTtsPauseWatchdog();
      this._conversationBaseUntil = null;
      this._conversationHardUntil = null;
      this._remainingConversationMs = 0;
      this._consecutiveSidetalkCount = 0;
      this._consecutiveAmbientNoiseCount = 0;
      this._speechGraceSuppressed = false;
      this._conversationSpeakerName = null;
      this._lastTransitionReason = "timeout";
      if (this._mode !== "processing" && this._mode !== "error") {
        this._mode = this._active ? "listening" : "idle";
      }
    }
    const inConversation =
      this._dialogState === "conversation" || awakeActive || convWindowActive;
    const preEvalEpoch = this._dialogEpoch;

    const llmEvaluator: AttentionLlmEvaluator | undefined =
      options.llmAttentionOverride ??
      (cfg.provider !== "local"
        ? async (promptText: string) => {
            const raw = await this._agent.evaluateAttention(promptText, 3500);
            if (!raw) throw new Error("no llm verdict");
            return raw;
          }
        : undefined);

    const wakeSpanForOww = findWakeWordSpan(text, cfg.wakeWords);
    const owwActiveForWord =
      options.owwActiveForWord ??
      (Boolean(options.owwEvaluated) &&
        cfg.owwEnabled &&
        this._localEngine.openWakeWord.isReady &&
        Boolean(wakeSpanForOww) &&
        getPrototypesForWords([wakeSpanForOww!.wakeWord]).length > 0);

    if (options.acousticWake?.matched) {
      this._lastWakeHit = { ...options.acousticWake, timestamp: now };
    }

    const legacySpoken = this._echoGuard.getLegacyLastSpoken(now);
    const recentSpokenUtterances = this._echoGuard.getRecentUtterances(now);
    const ttsActiveNow = this._echoGuard.isSpeaking;
    const duringTtsPlayback = options.duringTtsPlayback ?? ttsActiveNow;

    const decision =
      options.precomputedAttention ??
      (await evaluateVoiceAttention({
        rawText: text,
        altText: options.altText,
        wakeWordEnabled: cfg.wakeWordEnabled,
        wakeWords: cfg.wakeWords,
        attentionMode: cfg.attentionMode,
        bypassWakeWord: options.bypassWakeWord,
        awakeActive,
        inConversation,
        dialogState: this._dialogState,
        acousticWake: options.acousticWake ?? null,
        owwActiveForWord,
        systemOneClient: this._agent.systemOneClient,
        recentTurns: this._agent.recentConversationTurns(5),
        lastSpokenReply: legacySpoken.text || this._lastSpokenReply,
        lastSpokenAt: legacySpoken.at || this._lastSpokenAt,
        recentSpokenUtterances,
        ttsActive: ttsActiveNow,
        duringTtsPlayback,
        echoCancellationMode: cfg.echoCancellationMode,
        now,
        acousticEvent: options.acousticEvent,
        voiceprint: options.voiceprint,
        voiceprintMode: cfg.voiceprintMode,
        conversationSpeakerName: this._conversationSpeakerName,
        llmEvaluator,
        capabilityDigest: this._agent.getCapabilityDigest(),
        learnedTriggers: this._agent.getLearnedTriggerSamples(),
        pendingConfirmation: activePendingCtx,
      }));

    if (decision.stage === "echo") {
      this._echoGuard.recordSuppressed();
    } else if (decision.echoStripped) {
      this._echoGuard.recordStripped();
    }
    const isRejectedNoiseOrEcho =
      !decision.accept && (decision.stage === "echo" || decision.stage === "acoustic");
    if (isRejectedNoiseOrEcho) {
      // 纯回声或单字噪声碎片不覆盖最近一次有效识别字幕与状态指标
      this._lastTranscript = prevLastTranscript;
    }

    const preMs =
      (options.timingsBase?.denoiseMs ?? 0) +
      (options.timingsBase?.vadMs ?? 0) +
      (options.timingsBase?.voiceprintMs ?? 0) +
      (options.timingsBase?.asrMs ?? 0);
    const timings: VoicePipelineTimings = {
      ...options.timingsBase,
      attentionMs: decision.latencyMs,
      totalMs: Math.round(preMs + decision.latencyMs),
    };

    const entry: VoiceTranscriptEntry = {
      id: `vt_${now}_${++this._seq}`,
      text,
      matched: decision.accept,
      wokeOnly: decision.wokeOnly,
      command: decision.command,
      timestamp: now,
      speakerName: options.voiceprint?.speakerName ?? null,
      speakerScore: options.voiceprint?.evaluated ? options.voiceprint.score : undefined,
      attentionStage: decision.stage,
      attentionReason: decision.reason,
      ...(decision.passSource ? { passSource: decision.passSource } : {}),
      ...(decision.matchedCapability ? { matchedCapability: decision.matchedCapability } : {}),
      ...(decision.intent ? { intent: decision.intent } : {}),
      ...(options.acousticWake ? { acousticWakeScore: options.acousticWake.score } : {}),
      snrGainDb: options.snrGainDb,
      timings,
    };
    this._history.push(entry);
    if (this._history.length > 25) {
      this._history = this._history.slice(-25);
    }

    if (!isRejectedNoiseOrEcho) {
      this._lastMetrics = {
        ...(this._lastMetrics ?? {}),
        voiceprint: options.voiceprint ?? this._lastMetrics?.voiceprint ?? null,
        acousticWake: options.acousticWake ?? this._lastMetrics?.acousticWake ?? null,
        ...(decision.intent ? { intent: decision.intent } : {}),
        attention: decision,
        timings,
        updatedAt: now,
      };
    }

    // 仅唤醒词：切入连续对话状态；回复自定义短语（默认“嗯?”），若配置为空则静默不回复并持续监听
    if (decision.accept && decision.wokeOnly) {
      const wakeReply = resolveWakeAckReply(cfg.wakeAckPhrase);
      if (wakeReply) {
        entry.reply = wakeReply;
      }
      const snap = this.enterConversation("wake_only", {
        speakAck: wakeReply.length > 0,
        now,
        speakerName: options.voiceprint?.speakerName,
      });
      return {
        ok: true,
        matched: true,
        wokeOnly: true,
        command: "",
        reply: wakeReply,
        attention: decision,
        voiceprint: options.voiceprint,
        acousticWake: options.acousticWake ?? null,
        timings,
        voiceState: snap,
      };
    }

    // 显式退出连续对话（纯告别口令或 SystemOne goodbye 判定）：立即回到待机并播报“已待机”，不调用 Pi Agent
    if (decision.exitConversation === true) {
      const exitReply = formatExitConversationAck(cfg.cavemanMode);
      entry.reply = exitReply;
      const snap = this.exitConversation(
        decision.stage === "systemone-attention" ? "systemone_goodbye" : "explicit_exit",
        { speakAck: true, now },
      );
      return {
        ok: true,
        matched: false,
        wokeOnly: false,
        command: "",
        reply: exitReply,
        attention: decision,
        voiceprint: options.voiceprint,
        acousticWake: options.acousticWake ?? null,
        timings,
        voiceState: snap,
      };
    }

    // 防止在异步注意力门控期间对话已超时或被手动退出，结果又被旧轮次的免唤醒判定重新复活
    const staleFollowupAfterExit =
      inConversation &&
      this._dialogEpoch !== preEvalEpoch &&
      this._dialogState === "standby" &&
      decision.accept &&
      !decision.wakeWord &&
      !options.bypassWakeWord &&
      cfg.wakeWordEnabled;

    // 注意力门控拒绝（非定向提及/旁白/回声/声纹未通过/声学否决/旧轮次已过期）
    if (staleFollowupAfterExit || !decision.accept || !decision.command) {
      if (this._dialogState === "conversation") {
        if (decision.stage !== "echo") {
          this._consecutiveSidetalkCount += 1;
          if (this._consecutiveSidetalkCount >= cfg.maxConsecutiveSidetalk) {
            const snap = this.exitConversation("sidetalk_limit", { speakAck: false, now });
            return {
              ok: true,
              matched: false,
              wokeOnly: false,
              command: "",
              attention: decision,
              voiceprint: options.voiceprint,
              acousticWake: options.acousticWake ?? null,
              timings,
              voiceState: snap,
            };
          }
          if (
            this._noteNonConversationSegment(
              decision.stage === "acoustic" ? "ambient_noise" : "rejected",
              now,
            )
          ) {
            return {
              ok: true,
              matched: false,
              wokeOnly: false,
              command: "",
              attention: decision,
              voiceprint: options.voiceprint,
              acousticWake: options.acousticWake ?? null,
              timings,
              voiceState: this.snapshot(),
            };
          }
        }
      }
      if (this._active && this._mode !== "awake") {
        this._mode = "listening";
      }
      const snap = this.snapshot();
      this.emit("stateChanged", snap);
      return {
        ok: true,
        matched: false,
        wokeOnly: false,
        command: "",
        attention: decision,
        voiceprint: options.voiceprint,
        acousticWake: options.acousticWake ?? null,
        timings,
        voiceState: snap,
      };
    }

    // 确认在呼叫/对话：若用户明确要求取消当前后台执行任务，直接中止执行通道，不阻塞对话
    const normalizedCancelCmd = decision.command
      .replace(LEADING_PUNCT_RE, "")
      .replace(TRAILING_PUNCT_RE, "")
      .trim();
    if (this._agent.activeTaskCount > 0 && CANCEL_RUNNING_TASK_RE.test(normalizedCancelCmd)) {
      this._agent.abort();
      this._agent.taintRecentAutoExecutedMemoryIfWithin(120_000);
      const cancelReply = "已取消正在执行的任务";
      entry.reply = cancelReply;
      const cancelSnap = this.snapshot();
      this.emit("stateChanged", cancelSnap);
      if (cfg.autoSpeakReply) {
        const rec = this._recordSpoken(cancelReply, now, { priority: "system" });
        this.emit("speakRequested", cancelReply, {
          utteranceId: rec?.id,
          priority: "system",
          interrupt: true,
        });
      }
      return {
        ok: true,
        matched: true,
        wokeOnly: false,
        command: decision.command,
        reply: cancelReply,
        attention: decision,
        voiceprint: options.voiceprint,
        acousticWake: options.acousticWake ?? null,
        timings,
        voiceState: cancelSnap,
      };
    }

    // 确认在呼叫/对话：进入异步解耦的 Pi Agent 执行通道（支持非阻塞投递，对话与播报持续畅通）
    const commandEpoch = this._dialogEpoch;
    const useAsyncDispatch = Boolean(options.asyncDispatch && cfg.asyncVoicePipeline !== false);
    this._consecutiveSidetalkCount = 0;
    this._consecutiveAmbientNoiseCount = 0;
    this._speechGraceSuppressed = false;
    if (options.voiceprint?.matched && options.voiceprint.speakerName?.trim()) {
      this._conversationSpeakerName = options.voiceprint.speakerName.trim();
    }
    this._awakeUntil = null;
    this._lastDispatchedText = text;
    this._lastDispatchedNormText = normText;
    this._lastDedupPendingId = activePendingId;
    this._lastDispatchedAt = now;
    this._lastDispatchedCompletedAt = 0;
    this._lastCommand = decision.command;

    // 立即维持/刷新连续对话固定倒计时窗口：即便任务在后台执行，用户也无需重复喊唤醒词即可继续对话
    if (cfg.conversationWindowSec > 0) {
      const convMs = cfg.conversationWindowSec * 1000;
      this._dialogState = "conversation";
      this._lastTransitionReason = useAsyncDispatch ? "command_dispatched_async" : "command_running";
      const nextUntil = Date.now() + convMs;
      this._conversationUntil = nextUntil;
      this._remainingConversationMs = convMs;
      this._setConversationDeadlines(nextUntil, true);
      this._armConversationTimer(convMs, this._dialogEpoch);
    }

    if (useAsyncDispatch) {
      this._mode =
        this._dialogState === "conversation" ? "awake" : this._active ? "listening" : "idle";
    } else {
      this._mode = "processing";
    }

    const agentStart = performance.now();
    const submission = this._agent.submitPrompt(decision.command, {
      source: "voice",
      voiceMeta: {
        speakerId: options.voiceprint?.speakerId ?? null,
        speakerName: options.voiceprint?.speakerName ?? null,
        speakerRole: options.voiceprint?.role ?? null,
        speakerScore: options.voiceprint?.score,
        speakerMatched: options.voiceprint?.evaluated ? options.voiceprint.matched : undefined,
        enrolledCount: options.voiceprint?.enrolledCount,
        wakeWord: decision.wakeWord,
        attentionReason: decision.reason,
        ...(decision.intent ? { intent: decision.intent } : {}),
      },
    });
    this.emit("stateChanged", this.snapshot());

    const finalizeRunResult = (runResult: PiAgentRunResult): VoiceListenerSnapshot => {
      const agentMs = Math.round(performance.now() - agentStart);
      this._lastDispatchedCompletedAt =
        options.now !== undefined ? Math.max(now, now + agentMs) : Date.now();

      timings.agentMs = agentMs;
      timings.totalMs = Math.round(
        (options.timingsBase?.denoiseMs ?? 0) +
          (options.timingsBase?.vadMs ?? 0) +
          (options.timingsBase?.voiceprintMs ?? 0) +
          (options.timingsBase?.asrMs ?? 0) +
          (timings.attentionMs ?? 0) +
          agentMs,
      );
      entry.timings = timings;
      entry.reply = runResult.reply;
      if (runResult.error) {
        entry.error = runResult.error;
      }

      // 执行完成后若 epoch 未被手动退出打断，刷新固定秒数连续对话倒计时窗口且绝不抢占其他仍在进行中的后台任务状态
      if (commandEpoch === this._dialogEpoch) {
        if (cfg.conversationWindowSec > 0 && runResult.ok) {
          const convMs = cfg.conversationWindowSec * 1000;
          this._dialogState = "conversation";
          this._consecutiveSidetalkCount = 0;
          this._consecutiveAmbientNoiseCount = 0;
          this._speechGraceSuppressed = false;
          this._lastTransitionReason = "command_done";
          const nextUntil = Date.now() + convMs;
          this._conversationUntil = nextUntil;
          this._remainingConversationMs = convMs;
          this._setConversationDeadlines(nextUntil, true);
          this._armConversationTimer(convMs, this._dialogEpoch);
        } else if (
          cfg.conversationWindowSec <= 0 &&
          this._agent.activeTaskCount === 0 &&
          !this._agent.getActivePendingConfirmationGateContext()
        ) {
          this._dialogState = "standby";
          this._conversationUntil = null;
          this._conversationBaseUntil = null;
          this._conversationHardUntil = null;
          this._awakeUntil = null;
          this._remainingConversationMs = 0;
          this._timerPaused = false;
          this._consecutiveAmbientNoiseCount = 0;
          this._speechGraceSuppressed = false;
          this._conversationSpeakerName = null;
          this._clearConversationTimer();
          this._clearTtsPauseWatchdog();
          this._lastTransitionReason = "command_done_no_window";
        }
        if (this._agent.activeTaskCount === 0) {
          this._mode = this._active
            ? this._dialogState === "conversation"
              ? "awake"
              : "listening"
            : "idle";
        }
      }

      this._lastMetrics = {
        ...(this._lastMetrics ?? {}),
        attention: decision,
        timings,
        updatedAt: Date.now(),
      };
      const finalSnap = this.snapshot();
      this.emit("stateChanged", finalSnap);

      if (
        cfg.autoSpeakReply &&
        runResult.reply &&
        !runResult.streamedSpeakChunks &&
        !runResult.silentCompleted
      ) {
        const rec = this._recordSpoken(runResult.reply, Date.now(), {
          priority: "result",
          taskId: runResult.taskId,
        });
        this.emit("speakRequested", runResult.reply, {
          utteranceId: rec?.id,
          priority: "result",
          taskId: runResult.taskId,
          interrupt: false,
        });
      }
      return finalSnap;
    };

    if (useAsyncDispatch) {
      entry.reply = submission.ack;
      void submission.promise
        .then((runResult) => {
          finalizeRunResult(runResult);
        })
        .catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          entry.error = msg;
          this.emit("stateChanged", this.snapshot());
        });

      const dispatchedSnap = this.snapshot();
      return {
        ok: true,
        matched: true,
        wokeOnly: false,
        dispatchedAsync: true,
        taskId: submission.taskId,
        entryId: submission.entryId,
        command: decision.command,
        reply: submission.ack,
        attention: decision,
        voiceprint: options.voiceprint,
        acousticWake: options.acousticWake ?? null,
        timings,
        voiceState: dispatchedSnap,
      };
    }

    const runResult: PiAgentRunResult = await submission.promise;
    const finalSnap = finalizeRunResult(runResult);

    return {
      ok: runResult.ok,
      matched: true,
      wokeOnly: false,
      taskId: runResult.taskId,
      entryId: runResult.entryId,
      command: decision.command,
      reply: runResult.reply,
      toolCalls: runResult.toolCalls,
      attention: decision,
      voiceprint: options.voiceprint,
      acousticWake: options.acousticWake ?? null,
      timings,
      ...(runResult.error ? { error: runResult.error } : {}),
      voiceState: finalSnap,
    };
  }

  /**
   * 统一的高性能音频处理管线：
   * 16kHz PCM WAV -> 环境降噪 (GTCRN/DSP) -> 神经 VAD (Silero) -> 声纹识别 (3D-Speaker CAM++)
   * -> 本地 SenseVoice / 云端 Whisper ASR -> 唤醒词注意力门控 -> Pi Agent
   */
  async processAudioUpload(
    audioBlob: Blob,
    options: {
      filename?: string;
      lang?: string;
      bypassWakeWord?: boolean;
      autoDispatch?: boolean;
      preferredEngine?: "auto" | "local" | "whisper";
      llmAttentionOverride?: AttentionLlmEvaluator;
      asyncDispatch?: boolean;
      duringTtsPlayback?: boolean;
    } = {},
  ): Promise<ProcessAudioUploadResult> {
    const totalStart = performance.now();
    const cfg = this.config;
    const rawBuf = new Uint8Array(await audioBlob.arrayBuffer());
    const lang = options.lang || cfg.voiceLang || "zh-CN";
    const autoDispatch = options.autoDispatch !== false;

    // 若不是 WAV（兼容旧客户端或测试上传的 webm/opus），直接走 Whisper STT 接口
    if (!isWavBuffer(rawBuf)) {
      const asrStart = performance.now();
      const text = await this.transcribeAudio(audioBlob, { filename: options.filename, lang });
      const asrMs = Math.round(performance.now() - asrStart);
      if (!autoDispatch) {
        return {
          ok: true,
          text,
          speechDetected: text.length > 0,
          denoiseEngine: "none",
          vadEngine: "none",
          asrEngine: "whisper-cloud",
          matched: false,
          wokeOnly: false,
          command: "",
          timings: { asrMs, totalMs: Math.round(performance.now() - totalStart) },
          voiceState: this.snapshot(),
        };
      }
      const dispatched = await this.handleTranscript(text, {
        isFinal: true,
        bypassWakeWord: options.bypassWakeWord,
        engine: "whisper",
        timingsBase: { asrMs },
        llmAttentionOverride: options.llmAttentionOverride,
        asyncDispatch: options.asyncDispatch,
        duringTtsPlayback: options.duringTtsPlayback,
      });
      return {
        ...dispatched,
        text,
        speechDetected: text.length > 0,
        denoiseEngine: "none",
        vadEngine: "none",
        asrEngine: "whisper-cloud",
      };
    }

    // ---- Stage 1: WAV 解码与 16kHz 重采样 ----
    const decoded = decodeWavPcm(rawBuf);
    const pcm16k =
      decoded.sampleRate === 16000
        ? decoded.samples
        : resampleLinear(decoded.samples, decoded.sampleRate, 16000);

    // ---- Stage 1.1: 未唤醒门控（HTTP 兜底上传模式）：先做充分降噪（含 DPDFNet4）再声学唤醒检测，未命中则跳过 ASR ----
    this._syncLocalEngineConfig();
    const engineStatusPre = this._localEngine.getStatus();

    const uploadNow = Date.now();
    const uploadDurMs = Math.round((pcm16k.length / 16000) * 1000);
    const uploadSpeechStartedAt = Math.max(0, uploadNow - Math.min(30_000, uploadDurMs));
    const uploadAwakeActive =
      this._awakeUntil !== null &&
      (uploadNow < this._awakeUntil || uploadSpeechStartedAt < this._awakeUntil);
    const uploadConvActive =
      cfg.conversationWindowSec > 0 &&
      this._conversationUntil !== null &&
      (uploadNow < this._conversationUntil || uploadSpeechStartedAt < this._conversationUntil);
    const uploadInConversation =
      this._dialogState === "conversation" || uploadAwakeActive || uploadConvActive;
    let uploadWakeGateHit: WakeWordAcousticHit | null = null;
    if (
      autoDispatch &&
      cfg.wakeWordEnabled &&
      !options.bypassWakeWord &&
      !uploadInConversation &&
      cfg.owwEnabled &&
      this._localEngine.openWakeWord.isReady &&
      getPrototypesForWords(cfg.wakeWords).length > 0
    ) {
      let gateHit = this._localEngine.scoreWakeWordAudio(pcm16k, cfg.wakeWords, {
        threshold: cfg.owwThreshold,
      });
      let gateDenoiseEngine = "oww-standby";
      if (
        !gateHit?.matched &&
        cfg.voicePipelineMode !== "xfyun" &&
        cfg.voicePipelineMode !== "voice-ws" &&
        cfg.noiseSuppressionMode !== "off"
      ) {
        // 1) 按用户配置的降噪模式执行快路径降噪后复检
        const quickDen = this._localEngine.denoise(pcm16k, 16000, cfg.noiseSuppressionMode);
        gateDenoiseEngine = `oww-standby-${quickDen.engine}`;
        const denHit = this._localEngine.scoreWakeWordAudio(quickDen.samples, cfg.wakeWords, {
          threshold: cfg.owwThreshold,
        });
        if (denHit && (!gateHit || denHit.score > gateHit.score)) {
          gateHit = denHit;
        }

        // 2) 本地具备 DPDFNet4 时，用强效去噪模型做最终声学唤醒复检
        if (
          !gateHit?.matched &&
          (cfg.noiseSuppressionMode === "auto" || cfg.noiseSuppressionMode === "neural") &&
          quickDen.engine !== "dpdfnet4" &&
          engineStatusPre.readyForDpdfnet
        ) {
          const deepDen = this._localEngine.denoise(pcm16k, 16000, "dpdfnet");
          gateDenoiseEngine = `oww-standby-${deepDen.engine}`;
          const deepHit = this._localEngine.scoreWakeWordAudio(deepDen.samples, cfg.wakeWords, {
            threshold: cfg.owwThreshold,
          });
          if (deepHit && (!gateHit || deepHit.score > gateHit.score)) {
            gateHit = deepHit;
          }
        }
      }
      if (!gateHit?.matched) {
        const timings: VoicePipelineTimings = {
          totalMs: Math.round(performance.now() - totalStart),
        };
        this._lastMetrics = {
          denoiseEngine: gateDenoiseEngine,
          vadEngine: "oww-wake-gate",
          asrEngine: "skipped-unawakened",
          acousticWake: gateHit,
          timings,
          updatedAt: Date.now(),
        };
        return {
          ok: true,
          text: "",
          speechDetected: true,
          denoiseEngine: gateDenoiseEngine,
          vadEngine: "oww-wake-gate",
          asrEngine: "skipped-unawakened",
          acousticWake: gateHit,
          matched: false,
          wokeOnly: false,
          command: "",
          timings,
          voiceState: this.snapshot(),
        };
      }
      uploadWakeGateHit = gateHit;
    }

    // ---- Stage 1.15 (讯飞听写大模型 2.0 方案): openWakeWord 唤醒/放行后直接将 16kHz 原始 PCM 推送至讯飞，不做额外降噪或特殊处理 ----
    if (
      cfg.voicePipelineMode === "xfyun" &&
      this._localEngine.xfyunIat.isConfigured()
    ) {
      const xfyunRes = await this._localEngine.xfyunIat.transcribePcm(pcm16k, {
        eosMs: cfg.vadSilenceMs,
      });
      const transcript = sanitizeAsrTranscript(xfyunRes.text, { wakeWords: cfg.wakeWords });
      const asrMs = xfyunRes.durationMs;
      const inputSnrDb = estimateSnrDb(pcm16k, 16000);
      let voiceprintResult: VoiceprintIdentifyResult | null = null;
      let voiceprintMs = 0;
      const profilesXfyun = listPublicVoiceprints();
      if (
        cfg.voiceprintMode !== "off" &&
        profilesXfyun.length > 0 &&
        pcm16k.length >= 4000 &&
        engineStatusPre.readyForVoiceprint
      ) {
        const emb = this._localEngine.extractSpeakerEmbedding(pcm16k, 16000);
        voiceprintMs = emb.durationMs;
        voiceprintResult = identifyVoiceprint(emb.embedding, emb.engine, cfg.voiceprintThreshold);
      }
      const timingsBase: Partial<VoicePipelineTimings> = {
        voiceprintMs,
        asrMs,
      };
      this._lastMetrics = {
        denoiseEngine: "xfyun-raw-direct",
        snrGainDb: 0,
        vadEngine: "xfyun-eos",
        speechRatio: transcript ? 1 : 0,
        asrEngine: "xfyun-iat-v2",
        voiceprint: voiceprintResult,
        acousticWake: uploadWakeGateHit,
        updatedAt: Date.now(),
      };
      if (!transcript.trim()) {
        if (autoDispatch) {
          this._noteNonConversationSegment("ambient_noise");
        }
        return {
          ok: true,
          text: "",
          speechDetected: false,
          denoiseEngine: "xfyun-raw-direct",
          vadEngine: "xfyun-eos",
          asrEngine: "xfyun-iat-v2",
          inputSnrDb,
          outputSnrDb: inputSnrDb,
          snrGainDb: 0,
          voiceprint: voiceprintResult,
          acousticWake: uploadWakeGateHit,
          matched: false,
          wokeOnly: false,
          command: "",
          timings: { ...timingsBase, totalMs: Math.round(performance.now() - totalStart) },
          voiceState: this.snapshot(),
        };
      }
      if (!autoDispatch) {
        return {
          ok: true,
          text: transcript,
          speechDetected: true,
          denoiseEngine: "xfyun-raw-direct",
          vadEngine: "xfyun-eos",
          asrEngine: "xfyun-iat-v2",
          inputSnrDb,
          outputSnrDb: inputSnrDb,
          snrGainDb: 0,
          voiceprint: voiceprintResult,
          acousticWake: uploadWakeGateHit,
          matched: false,
          wokeOnly: false,
          command: "",
          timings: { ...timingsBase, totalMs: Math.round(performance.now() - totalStart) },
          voiceState: this.snapshot(),
        };
      }
      const dispatched = await this.handleTranscript(transcript, {
        isFinal: true,
        bypassWakeWord: options.bypassWakeWord,
        engine: "local",
        segmentDurationMs: uploadDurMs,
        acousticWake: uploadWakeGateHit,
        owwEvaluated: Boolean(cfg.owwEnabled && this._localEngine.openWakeWord.isReady),
        voiceprint: voiceprintResult,
        snrGainDb: 0,
        timingsBase,
        llmAttentionOverride: options.llmAttentionOverride,
        asyncDispatch: options.asyncDispatch,
        duringTtsPlayback: options.duringTtsPlayback,
      });
      return {
        ...dispatched,
        text: transcript,
        speechDetected: true,
        denoiseEngine: "xfyun-raw-direct",
        vadEngine: "xfyun-eos",
        asrEngine: "xfyun-iat-v2",
        inputSnrDb,
        outputSnrDb: inputSnrDb,
        snrGainDb: 0,
        acousticWake: uploadWakeGateHit,
      };
    }

    // ---- Stage 1.16 (统一流式语音听写 WebSocket 网关方案): openWakeWord 唤醒/放行后直接将 16kHz 原始 PCM 推送至网关（服务端 CPU ONNX GTCRN+Silero VAD -> GPU Qwen3-ASR） ----
    if (
      cfg.voicePipelineMode === "voice-ws" &&
      this._localEngine.voiceWsAsr.isConfigured()
    ) {
      const wsRes = await this._localEngine.voiceWsAsr.transcribePcm(pcm16k, {
        minSilenceMs: cfg.vadSilenceMs,
      });
      const transcript = sanitizeAsrTranscript(wsRes.text, { wakeWords: cfg.wakeWords });
      const asrMs = wsRes.asrMs || wsRes.durationMs;
      const denoiseTag = wsRes.denoiseEnabled ? "voice-ws-gtcrn" : "voice-ws-raw";
      const inputSnrDb = estimateSnrDb(pcm16k, 16000);
      let voiceprintResult: VoiceprintIdentifyResult | null = null;
      let voiceprintMs = 0;
      const profilesWs = listPublicVoiceprints();
      if (
        cfg.voiceprintMode !== "off" &&
        profilesWs.length > 0 &&
        pcm16k.length >= 4000 &&
        engineStatusPre.readyForVoiceprint
      ) {
        const emb = this._localEngine.extractSpeakerEmbedding(pcm16k, 16000);
        voiceprintMs = emb.durationMs;
        voiceprintResult = identifyVoiceprint(emb.embedding, emb.engine, cfg.voiceprintThreshold);
      }
      const timingsBase: Partial<VoicePipelineTimings> = {
        voiceprintMs,
        asrMs,
      };
      this._lastMetrics = {
        denoiseEngine: denoiseTag,
        snrGainDb: 0,
        vadEngine: "voice-ws-silero",
        speechRatio: transcript ? 1 : 0,
        asrEngine: "voice-ws-asr",
        voiceprint: voiceprintResult,
        acousticWake: uploadWakeGateHit,
        updatedAt: Date.now(),
      };
      if (!transcript.trim()) {
        if (autoDispatch) {
          this._noteNonConversationSegment("ambient_noise");
        }
        return {
          ok: true,
          text: "",
          speechDetected: false,
          denoiseEngine: denoiseTag,
          vadEngine: "voice-ws-silero",
          asrEngine: "voice-ws-asr",
          inputSnrDb,
          outputSnrDb: inputSnrDb,
          snrGainDb: 0,
          voiceprint: voiceprintResult,
          acousticWake: uploadWakeGateHit,
          matched: false,
          wokeOnly: false,
          command: "",
          timings: { ...timingsBase, totalMs: Math.round(performance.now() - totalStart) },
          voiceState: this.snapshot(),
        };
      }
      if (!autoDispatch) {
        return {
          ok: true,
          text: transcript,
          speechDetected: true,
          denoiseEngine: denoiseTag,
          vadEngine: "voice-ws-silero",
          asrEngine: "voice-ws-asr",
          inputSnrDb,
          outputSnrDb: inputSnrDb,
          snrGainDb: 0,
          voiceprint: voiceprintResult,
          acousticWake: uploadWakeGateHit,
          matched: false,
          wokeOnly: false,
          command: "",
          timings: { ...timingsBase, totalMs: Math.round(performance.now() - totalStart) },
          voiceState: this.snapshot(),
        };
      }
      const dispatched = await this.handleTranscript(transcript, {
        isFinal: true,
        bypassWakeWord: options.bypassWakeWord,
        engine: "local",
        segmentDurationMs: uploadDurMs,
        acousticWake: uploadWakeGateHit,
        owwEvaluated: Boolean(cfg.owwEnabled && this._localEngine.openWakeWord.isReady),
        voiceprint: voiceprintResult,
        snrGainDb: 0,
        timingsBase,
        llmAttentionOverride: options.llmAttentionOverride,
        asyncDispatch: options.asyncDispatch,
        duringTtsPlayback: options.duringTtsPlayback,
      });
      return {
        ...dispatched,
        text: transcript,
        speechDetected: true,
        denoiseEngine: denoiseTag,
        vadEngine: "voice-ws-silero",
        asrEngine: "voice-ws-asr",
        inputSnrDb,
        outputSnrDb: inputSnrDb,
        snrGainDb: 0,
        acousticWake: uploadWakeGateHit,
      };
    }

    // ---- Stage 1.5: 本地自适应多级声源分离与说话人隔离主通道（S_Fused 最终方案） ----
    const sttAuthPre = resolveEffectiveSttAuth(cfg);
    const hasCloudSttPre = Boolean(
      sttAuthPre.baseUrl && (sttAuthPre.apiKey || isLocalEndpointUrl(sttAuthPre.baseUrl)),
    );
    const prefPre = options.preferredEngine ?? (cfg.voiceEngine === "whisper" ? "whisper" : "auto");
    const useLocalPre =
      prefPre === "local" ||
      (prefPre === "auto" && engineStatusPre.readyForLocalAsr) ||
      (prefPre === "whisper" && !hasCloudSttPre && engineStatusPre.readyForLocalAsr);

    if (
      useLocalPre &&
      cfg.sourceSeparationMode !== "off" &&
      engineStatusPre.readyForSourceSeparation
    ) {
      const now = Date.now();
      const preSepEpoch = this._dialogEpoch;
      const segDurMs = Math.round((pcm16k.length / 16000) * 1000);
      const speechStartedAt = Math.max(0, now - Math.min(30_000, segDurMs));
      const awakeActive =
        this._awakeUntil !== null && (now < this._awakeUntil || speechStartedAt < this._awakeUntil);
      const convWindowActive =
        cfg.conversationWindowSec > 0 &&
        this._conversationUntil !== null &&
        (now < this._conversationUntil || speechStartedAt < this._conversationUntil);
      const inConversation =
        this._dialogState === "conversation" || awakeActive || convWindowActive;

      let voiceprintResult: VoiceprintIdentifyResult | null = null;
      let voiceprintMs = 0;
      let preDenoisedForSep: Float32Array | undefined;
      const profiles = listPublicVoiceprints();
      // strict 门禁需在注意力决策前识别声纹（并复用本次降噪轨给声源分离，避免二次 GTCRN）；
      // tag 模式延后到分离完成后直接复用分离出的最优纯净人声做声纹打标，省去 500ms 重复降噪且抗音乐更准！
      if (cfg.voiceprintMode === "strict" && profiles.length > 0 && pcm16k.length >= 4000) {
        const denForVp = this._localEngine.denoise(pcm16k, 16000, cfg.noiseSuppressionMode);
        preDenoisedForSep = denForVp.samples;
        const emb = this._localEngine.extractSpeakerEmbedding(denForVp.samples, 16000);
        voiceprintMs = emb.durationMs;
        voiceprintResult = identifyVoiceprint(emb.embedding, emb.engine, cfg.voiceprintThreshold);
      }

      const llmEvaluator: AttentionLlmEvaluator | undefined =
        options.llmAttentionOverride ??
        (cfg.provider !== "local"
          ? async (promptText: string) => {
              const raw = await this._agent.evaluateAttention(promptText, 3500);
              if (!raw) throw new Error("no llm verdict");
              return raw;
            }
          : undefined);

      const sepLegacySpoken = this._echoGuard.getLegacyLastSpoken(now);
      const sep = await this._localEngine.sourceSeparator.separateAndRecognize(pcm16k, 16000, {
        mode: cfg.sourceSeparationMode,
        voiceLang: lang,
        wakeWordEnabled: cfg.wakeWordEnabled,
        wakeWords: cfg.wakeWords,
        attentionMode: cfg.attentionMode,
        bypassWakeWord: options.bypassWakeWord,
        awakeActive,
        inConversation,
        dialogState: this._dialogState,
        recentTurns: this._agent.recentConversationTurns(5),
        lastSpokenReply: sepLegacySpoken.text || this._lastSpokenReply,
        lastSpokenAt: sepLegacySpoken.at || this._lastSpokenAt,
        recentSpokenUtterances: this._echoGuard.getRecentUtterances(now),
        ttsActive: this._echoGuard.isSpeaking,
        duringTtsPlayback: options.duringTtsPlayback ?? this._echoGuard.isSpeaking,
        echoCancellationMode: cfg.echoCancellationMode,
        now,
        voiceprint: voiceprintResult,
        voiceprintMode: cfg.voiceprintMode,
        systemOneClient: this._agent.systemOneClient,
        llmEvaluator,
        preDenoisedGtcrn: preDenoisedForSep,
        capabilityDigest: this._agent.getCapabilityDigest(),
        learnedTriggers: this._agent.getLearnedTriggerSamples(),
        pendingConfirmation: this._agent.getActivePendingConfirmationGateContext(),
      });

      // tag 模式在分离命中有效人声后直接复用 sep.bestSpeechPcm 执行 50ms 声纹打标
      if (
        cfg.voiceprintMode === "tag" &&
        profiles.length > 0 &&
        sep.speechDetected &&
        (sep.attention.accept || !autoDispatch)
      ) {
        const vpAudio =
          sep.bestSpeechPcm && sep.bestSpeechPcm.length >= 4000 ? sep.bestSpeechPcm : pcm16k;
        if (vpAudio.length >= 4000) {
          const emb = this._localEngine.extractSpeakerEmbedding(vpAudio, 16000);
          voiceprintMs = emb.durationMs;
          voiceprintResult = identifyVoiceprint(emb.embedding, emb.engine, cfg.voiceprintThreshold);
        }
      }

      if (sep.acousticWake?.matched) {
        this._lastWakeHit = { ...sep.acousticWake, timestamp: now };
      }

      const timingsBase: Partial<VoicePipelineTimings> = {
        denoiseMs: (sep.stageTimingsMs.gtcrnMs ?? 0) + (sep.stageTimingsMs.dpdfnetMs ?? 0) + (sep.stageTimingsMs.spleeterMs ?? 0),
        vadMs: (sep.stageTimingsMs.cedSceneMs ?? 0) + (sep.stageTimingsMs.diarizationMs ?? 0),
        voiceprintMs,
        asrMs: Math.max(0, sep.totalMs - ((sep.stageTimingsMs.gtcrnMs ?? 0) + (sep.stageTimingsMs.dpdfnetMs ?? 0) + (sep.stageTimingsMs.spleeterMs ?? 0) + (sep.stageTimingsMs.cedSceneMs ?? 0) + (sep.stageTimingsMs.diarizationMs ?? 0))),
      };

      this._lastMetrics = {
        denoiseEngine: sep.denoiseEngine,
        snrGainDb: sep.snrGainDb,
        vadEngine: sep.vadEngine,
        speechRatio: sep.speechDetected ? 1 : 0,
        asrEngine: sep.asrEngine,
        detectedSoundTypes: sep.detectedSoundTypes,
        detectedSpeakerCount: sep.detectedSpeakerCount,
        separatedStreams: sep.separatedStreams,
        voiceprint: voiceprintResult,
        acousticWake: sep.acousticWake,
        attention: sep.attention,
        timings: { ...timingsBase, totalMs: Math.round(performance.now() - totalStart) },
        updatedAt: Date.now(),
      };

      if (!sep.speechDetected || !sep.text.trim()) {
        if (autoDispatch) {
          this._noteNonConversationSegment("ambient_noise");
        }
        return {
          ok: true,
          text: sep.text,
          speechDetected: false,
          denoiseEngine: sep.denoiseEngine,
          vadEngine: sep.vadEngine,
          asrEngine: sep.asrEngine,
          inputSnrDb: sep.inputSnrDb,
          outputSnrDb: sep.outputSnrDb,
          snrGainDb: sep.snrGainDb,
          acousticEvent: sep.acousticEvent,
          detectedSoundTypes: sep.detectedSoundTypes,
          detectedSpeakerCount: sep.detectedSpeakerCount,
          separatedStreams: sep.separatedStreams,
          voiceprint: voiceprintResult,
          acousticWake: sep.acousticWake,
          attention: sep.attention,
          matched: false,
          wokeOnly: false,
          command: "",
          timings: { ...timingsBase, totalMs: Math.round(performance.now() - totalStart) },
          voiceState: this.snapshot(),
        };
      }

      if (!autoDispatch) {
        return {
          ok: true,
          text: sep.text,
          speechDetected: true,
          denoiseEngine: sep.denoiseEngine,
          vadEngine: sep.vadEngine,
          asrEngine: sep.asrEngine,
          inputSnrDb: sep.inputSnrDb,
          outputSnrDb: sep.outputSnrDb,
          snrGainDb: sep.snrGainDb,
          acousticEvent: sep.acousticEvent,
          detectedSoundTypes: sep.detectedSoundTypes,
          detectedSpeakerCount: sep.detectedSpeakerCount,
          separatedStreams: sep.separatedStreams,
          voiceprint: voiceprintResult,
          acousticWake: sep.acousticWake,
          attention: sep.attention,
          matched: false,
          wokeOnly: false,
          command: "",
          timings: { ...timingsBase, totalMs: Math.round(performance.now() - totalStart) },
          voiceState: this.snapshot(),
        };
      }

      const staleConversationDecision =
        inConversation &&
        this._dialogEpoch !== preSepEpoch &&
        this._dialogState === "standby" &&
        !sep.attention.wakeWord;

      const dispatched = await this.handleTranscript(sep.text, {
        isFinal: true,
        bypassWakeWord: options.bypassWakeWord,
        engine: "local",
        now: staleConversationDecision ? Date.now() : now,
        segmentDurationMs: segDurMs,
        acousticEvent: sep.acousticEvent,
        altText: sep.altText,
        acousticWake: sep.acousticWake,
        owwEvaluated: Boolean(cfg.owwEnabled && this._localEngine.openWakeWord.isReady),
        voiceprint: voiceprintResult,
        snrGainDb: sep.snrGainDb,
        timingsBase,
        llmAttentionOverride: options.llmAttentionOverride,
        precomputedAttention: staleConversationDecision ? undefined : sep.attention,
        asyncDispatch: options.asyncDispatch,
        duringTtsPlayback: options.duringTtsPlayback,
      });

      return {
        ...dispatched,
        text: sep.text,
        speechDetected: true,
        denoiseEngine: sep.denoiseEngine,
        vadEngine: sep.vadEngine,
        asrEngine: sep.asrEngine,
        inputSnrDb: sep.inputSnrDb,
        outputSnrDb: sep.outputSnrDb,
        snrGainDb: sep.snrGainDb,
        acousticEvent: sep.acousticEvent,
        detectedSoundTypes: sep.detectedSoundTypes,
        detectedSpeakerCount: sep.detectedSpeakerCount,
        separatedStreams: sep.separatedStreams,
        acousticWake: sep.acousticWake,
      };
    }

    // ---- Stage 2: 环境降噪（GTCRN 神经语音增强 / 纯 TS 频谱减法） ----
    const denoised = this._localEngine.denoise(pcm16k, 16000, cfg.noiseSuppressionMode);

    // ---- Stage 3: 语音活动检测与静音裁切（Silero VAD / 自适应 VAD） ----
    const vad = this._localEngine.detectSpeechSegments(denoised.samples, 16000, {
      mode: cfg.vadMode,
    });

    if (
      !vad.hasSpeech ||
      vad.speechSamples.length < 1600 ||
      !hasAudibleAudioEnergy(vad.speechSamples, 16000)
    ) {
      if (autoDispatch) {
        this._noteNonConversationSegment("ambient_noise");
      }
      const timings: VoicePipelineTimings = {
        denoiseMs: denoised.durationMs,
        vadMs: vad.durationMs,
        totalMs: Math.round(performance.now() - totalStart),
      };
      this._lastMetrics = {
        denoiseEngine: denoised.engine,
        snrGainDb: denoised.snrGainDb,
        vadEngine: vad.engine,
        speechRatio: vad.speechRatio,
        asrEngine: "skipped-no-speech",
        timings,
        updatedAt: Date.now(),
      };
      return {
        ok: true,
        text: "",
        speechDetected: false,
        denoiseEngine: denoised.engine,
        vadEngine: vad.engine,
        asrEngine: "skipped-no-speech",
        inputSnrDb: denoised.inputSnrDb,
        outputSnrDb: denoised.outputSnrDb,
        snrGainDb: denoised.snrGainDb,
        speechRatio: vad.speechRatio,
        matched: false,
        wokeOnly: false,
        command: "",
        timings,
        voiceState: this.snapshot(),
      };
    }

    // ---- Stage 4: 声纹识别（3D-Speaker CAM++，仅在已注册档案且未关闭时执行） ----
    let voiceprintResult: VoiceprintIdentifyResult | null = null;
    let voiceprintMs = 0;
    const profiles = listPublicVoiceprints();
    if (cfg.voiceprintMode !== "off" && profiles.length > 0) {
      const emb = this._localEngine.extractSpeakerEmbedding(vad.speechSamples, 16000);
      voiceprintMs = emb.durationMs;
      voiceprintResult = identifyVoiceprint(emb.embedding, emb.engine, cfg.voiceprintThreshold);
    }

    // ---- Stage 4.5: 本地 openWakeWord 离线句首声学唤醒打分（降噪轨未命中时自动补查原始轨，防 GTCRN 削弱快速句首） ----
    const owwEvaluated = Boolean(cfg.owwEnabled && this._localEngine.openWakeWord.isReady);
    let acousticWake = owwEvaluated
      ? this._localEngine.scoreWakeWordAudio(vad.speechSamples, cfg.wakeWords, {
          threshold: cfg.owwThreshold,
          headOnlySec: 2.0,
        })
      : null;
    if (owwEvaluated && (!acousticWake || !acousticWake.matched)) {
      const rawHit = this._localEngine.scoreWakeWordAudio(pcm16k, cfg.wakeWords, {
        threshold: cfg.owwThreshold,
        headOnlySec: 2.0,
      });
      if (rawHit && (!acousticWake || rawHit.score > acousticWake.score)) {
        acousticWake = rawHit;
      }
    }
    if (acousticWake?.matched) {
      this._lastWakeHit = { ...acousticWake, timestamp: Date.now() };
    }

    // ---- Stage 5: 语音识别（优先本地 SenseVoice，降级云端 Whisper） ----
    const sttAuth = resolveEffectiveSttAuth(cfg);
    const hasCloudStt = Boolean(sttAuth.baseUrl && (sttAuth.apiKey || isLocalEndpointUrl(sttAuth.baseUrl)));
    const localReady = this._localEngine.getStatus().readyForLocalAsr;
    const pref = options.preferredEngine ?? (cfg.voiceEngine === "whisper" ? "whisper" : "auto");

    let transcript = "";
    let altText: string | undefined;
    let acousticEvent = "";
    let asrEngine = "sensevoice-local";
    let asrMs = 0;
    let runtimeEngine: VoiceRuntimeEngine = "local";

    const useLocal =
      pref === "local" || (pref === "auto" && localReady) || (pref === "whisper" && !hasCloudStt && localReady);

    if (useLocal) {
      // 双轨抗音乐/强噪融合识别：本地 SenseVoice 结合 openWakeWord 与 SystemOne
      const sv = await this._localEngine.transcribeDualTrack(pcm16k, vad.speechSamples, {
        voiceLang: lang,
        wakeWords: cfg.wakeWords,
        inputSnrDb: denoised.inputSnrDb,
        systemOneClient: this._agent.systemOneClient,
        acousticWake,
      });
      transcript = sv.text;
      altText = sv.altText;
      acousticEvent = sv.event;
      asrEngine = sv.engine;
      asrMs = sv.durationMs;
      runtimeEngine = "local";
    } else {
      // 将经过 GTCRN 降噪 + Silero VAD 裁切的干净 16kHz WAV 发给云端 Whisper，极大提升抗噪识别率
      const cleanWavBytes = encodeWavPcm16(vad.speechSamples, 16000);
      const cleanBlob = new Blob([cleanWavBytes as unknown as BlobPart], { type: "audio/wav" });
      const t0 = performance.now();
      transcript = await this.transcribeAudio(cleanBlob, { filename: "voice-clean.wav", lang });
      asrMs = Math.round(performance.now() - t0);
      asrEngine = "whisper-cloud";
      runtimeEngine = "whisper";
    }

    this._lastMetrics = {
      denoiseEngine: denoised.engine,
      snrGainDb: denoised.snrGainDb,
      vadEngine: vad.engine,
      speechRatio: vad.speechRatio,
      asrEngine,
      voiceprint: voiceprintResult,
      acousticWake,
      updatedAt: Date.now(),
    };

    const timingsBase: Partial<VoicePipelineTimings> = {
      denoiseMs: denoised.durationMs,
      vadMs: vad.durationMs,
      voiceprintMs,
      asrMs,
    };

    if (!autoDispatch) {
      const totalMs = Math.round(performance.now() - totalStart);
      return {
        ok: true,
        text: transcript,
        speechDetected: true,
        denoiseEngine: denoised.engine,
        vadEngine: vad.engine,
        asrEngine,
        inputSnrDb: denoised.inputSnrDb,
        outputSnrDb: denoised.outputSnrDb,
        snrGainDb: denoised.snrGainDb,
        speechRatio: vad.speechRatio,
        acousticEvent,
        voiceprint: voiceprintResult,
        acousticWake,
        matched: false,
        wokeOnly: false,
        command: "",
        timings: { ...timingsBase, totalMs },
        voiceState: this.snapshot(),
      };
    }

    // ---- Stage 6: 唤醒词注意力门控 + Pi Agent 执行 ----
    const dispatched = await this.handleTranscript(transcript, {
      isFinal: true,
      bypassWakeWord: options.bypassWakeWord,
      engine: runtimeEngine,
      segmentDurationMs: Math.round((pcm16k.length / 16000) * 1000),
      acousticEvent,
      altText,
      acousticWake,
      owwEvaluated,
      voiceprint: voiceprintResult,
      snrGainDb: denoised.snrGainDb,
      timingsBase,
      llmAttentionOverride: options.llmAttentionOverride,
      asyncDispatch: options.asyncDispatch,
      duringTtsPlayback: options.duringTtsPlayback,
    });

    return {
      ...dispatched,
      text: transcript,
      speechDetected: true,
      denoiseEngine: denoised.engine,
      vadEngine: vad.engine,
      asrEngine,
      inputSnrDb: denoised.inputSnrDb,
      outputSnrDb: denoised.outputSnrDb,
      snrGainDb: denoised.snrGainDb,
      speechRatio: vad.speechRatio,
      acousticEvent,
      acousticWake,
    };
  }

  /**
   * 处理来自连续 WebSocket 实时流会话（VoiceStreamSession）切出的双轨音频分段：
   * 直接在服务端流式 GTCRN + Silero VAD 切分基础上运行声纹 + 双轨 SenseVoice + 抗歌词注意力门控。
   */
  async processDualTrackSegment(
    segment: VoiceStreamSegmentPayload,
    options: {
      lang?: string;
      bypassWakeWord?: boolean;
      preferredEngine?: "auto" | "local" | "whisper";
      llmAttentionOverride?: AttentionLlmEvaluator;
      asyncDispatch?: boolean;
      duringTtsPlayback?: boolean;
    } = {},
  ): Promise<ProcessAudioUploadResult> {
    const totalStart = performance.now();
    const cfg = this.config;
    const lang = options.lang || cfg.voiceLang || "zh-CN";

    const profiles = listPublicVoiceprints();
    const vpAudio =
      segment.denoisedSamples.length >= 4000 ? segment.denoisedSamples : segment.rawSamples;

    this._syncLocalEngineConfig();
    const sttAuth = resolveEffectiveSttAuth(cfg);
    const hasCloudStt = Boolean(
      sttAuth.baseUrl && (sttAuth.apiKey || isLocalEndpointUrl(sttAuth.baseUrl)),
    );
    const localReady = this._localEngine.getStatus().readyForLocalAsr;
    const pref = options.preferredEngine ?? (cfg.voiceEngine === "whisper" ? "whisper" : "auto");
    const useLocal =
      pref === "local" ||
      (pref === "auto" && localReady) ||
      (pref === "whisper" && !hasCloudStt && localReady);

    // 讯飞语音听写大模型 2.0 方案直通：openWakeWord 唤醒后已将原始 16kHz PCM 直推讯飞 WebSocket 完成转写，
    // 此处不做额外降噪、声源分离或二次重解码，直接交由注意力门控与 Pi Agent 执行。
    const isXfyunSegment =
      segment.pipelineMode === "xfyun" || segment.precomputedAsrEngine === "xfyun-iat-v2";
    if (isXfyunSegment) {
      let transcript = sanitizeAsrTranscript(segment.precomputedTranscript ?? "", {
        wakeWords: cfg.wakeWords,
      });
      let asrMs = segment.precomputedAsrMs ?? 0;
      if (!transcript && segment.rawSamples.length >= 1600 && this._localEngine.xfyunIat.isConfigured()) {
        const res = await this._localEngine.xfyunIat.transcribePcm(segment.rawSamples, {
          eosMs: cfg.vadSilenceMs,
        });
        transcript = sanitizeAsrTranscript(res.text, { wakeWords: cfg.wakeWords });
        asrMs = res.durationMs;
      }

      let voiceprintResult: VoiceprintIdentifyResult | null = null;
      let voiceprintMs = 0;
      if (
        cfg.voiceprintMode !== "off" &&
        profiles.length > 0 &&
        segment.rawSamples.length >= 4000 &&
        this._localEngine.getStatus().readyForVoiceprint
      ) {
        const emb = this._localEngine.extractSpeakerEmbedding(segment.rawSamples, 16000);
        voiceprintMs = emb.durationMs;
        voiceprintResult = identifyVoiceprint(emb.embedding, emb.engine, cfg.voiceprintThreshold);
      }

      const acousticWake = segment.acousticWake ?? null;
      if (acousticWake?.matched) {
        this._lastWakeHit = { ...acousticWake, timestamp: Date.now() };
      }

      const vadEngineLabel = segment.commitReason
        ? `xfyun-eos:${segment.commitReason}`
        : "xfyun-eos";
      this._lastMetrics = {
        denoiseEngine: "xfyun-raw-direct",
        snrGainDb: 0,
        vadEngine: vadEngineLabel,
        speechRatio: transcript ? 1 : 0,
        asrEngine: "xfyun-iat-v2",
        voiceprint: voiceprintResult,
        acousticWake,
        updatedAt: Date.now(),
      };

      if (!transcript.trim()) {
        this._noteNonConversationSegment("ambient_noise");
        return {
          ok: true,
          text: "",
          speechDetected: false,
          denoiseEngine: "xfyun-raw-direct",
          vadEngine: vadEngineLabel,
          asrEngine: "xfyun-iat-v2",
          inputSnrDb: segment.inputSnrDb,
          outputSnrDb: segment.inputSnrDb,
          snrGainDb: 0,
          voiceprint: voiceprintResult,
          acousticWake,
          matched: false,
          wokeOnly: false,
          command: "",
          timings: {
            voiceprintMs,
            asrMs,
            totalMs: Math.round(performance.now() - totalStart),
          },
          voiceState: this.snapshot(),
        };
      }

      const dispatched = await this.handleTranscript(transcript, {
        isFinal: true,
        bypassWakeWord: options.bypassWakeWord,
        engine: "local",
        segmentDurationMs: Math.round(segment.durationSec * 1000),
        acousticWake,
        owwEvaluated: Boolean(cfg.owwEnabled && this._localEngine.openWakeWord.isReady),
        voiceprint: voiceprintResult,
        snrGainDb: 0,
        timingsBase: { voiceprintMs, asrMs },
        llmAttentionOverride: options.llmAttentionOverride,
        asyncDispatch: options.asyncDispatch,
        duringTtsPlayback: options.duringTtsPlayback ?? segment.duringTtsPlayback,
      });

      return {
        ...dispatched,
        text: transcript,
        speechDetected: true,
        denoiseEngine: "xfyun-raw-direct",
        vadEngine: vadEngineLabel,
        asrEngine: "xfyun-iat-v2",
        inputSnrDb: segment.inputSnrDb,
        outputSnrDb: segment.inputSnrDb,
        snrGainDb: 0,
        acousticWake,
      };
    }

    // 统一流式语音听写 WebSocket 网关方案直通：openWakeWord 唤醒后已将原始 16kHz PCM Binary 帧直推网关完成服务端降噪/VAD/识别，
    // 此处不做额外本地降噪、声源分离或二次重解码，直接交由注意力门控与 Pi Agent 执行。
    const isVoiceWsSegment =
      segment.pipelineMode === "voice-ws" || segment.precomputedAsrEngine === "voice-ws-asr";
    if (isVoiceWsSegment) {
      let transcript = sanitizeAsrTranscript(segment.precomputedTranscript ?? "", {
        wakeWords: cfg.wakeWords,
      });
      let asrMs = segment.precomputedAsrMs ?? 0;
      let denoiseTag =
        segment.denoiseEngine ||
        (this._localEngine.voiceWsAsr.getStatus().denoiseEnabled
          ? "voice-ws-gtcrn"
          : "voice-ws-raw");
      if (
        !transcript &&
        segment.rawSamples.length >= 1600 &&
        this._localEngine.voiceWsAsr.isConfigured()
      ) {
        const res = await this._localEngine.voiceWsAsr.transcribePcm(segment.rawSamples, {
          minSilenceMs: cfg.vadSilenceMs,
        });
        transcript = sanitizeAsrTranscript(res.text, { wakeWords: cfg.wakeWords });
        asrMs = res.asrMs || res.durationMs;
        denoiseTag = res.denoiseEnabled ? "voice-ws-gtcrn" : "voice-ws-raw";
      }

      let voiceprintResult: VoiceprintIdentifyResult | null = null;
      let voiceprintMs = 0;
      if (
        cfg.voiceprintMode !== "off" &&
        profiles.length > 0 &&
        segment.rawSamples.length >= 4000 &&
        this._localEngine.getStatus().readyForVoiceprint
      ) {
        const emb = this._localEngine.extractSpeakerEmbedding(segment.rawSamples, 16000);
        voiceprintMs = emb.durationMs;
        voiceprintResult = identifyVoiceprint(emb.embedding, emb.engine, cfg.voiceprintThreshold);
      }

      const acousticWake = segment.acousticWake ?? null;
      if (acousticWake?.matched) {
        this._lastWakeHit = { ...acousticWake, timestamp: Date.now() };
      }

      const vadEngineLabel = segment.commitReason
        ? `voice-ws-silero:${segment.commitReason}`
        : "voice-ws-silero";
      this._lastMetrics = {
        denoiseEngine: denoiseTag,
        snrGainDb: 0,
        vadEngine: vadEngineLabel,
        speechRatio: transcript ? 1 : 0,
        asrEngine: "voice-ws-asr",
        voiceprint: voiceprintResult,
        acousticWake,
        updatedAt: Date.now(),
      };

      if (!transcript.trim()) {
        this._noteNonConversationSegment("ambient_noise");
        return {
          ok: true,
          text: "",
          speechDetected: false,
          denoiseEngine: denoiseTag,
          vadEngine: vadEngineLabel,
          asrEngine: "voice-ws-asr",
          inputSnrDb: segment.inputSnrDb,
          outputSnrDb: segment.inputSnrDb,
          snrGainDb: 0,
          voiceprint: voiceprintResult,
          acousticWake,
          matched: false,
          wokeOnly: false,
          command: "",
          timings: {
            voiceprintMs,
            asrMs,
            totalMs: Math.round(performance.now() - totalStart),
          },
          voiceState: this.snapshot(),
        };
      }

      const dispatched = await this.handleTranscript(transcript, {
        isFinal: true,
        bypassWakeWord: options.bypassWakeWord,
        engine: "local",
        segmentDurationMs: Math.round(segment.durationSec * 1000),
        acousticWake,
        owwEvaluated: Boolean(cfg.owwEnabled && this._localEngine.openWakeWord.isReady),
        voiceprint: voiceprintResult,
        snrGainDb: 0,
        timingsBase: { voiceprintMs, asrMs },
        llmAttentionOverride: options.llmAttentionOverride,
        asyncDispatch: options.asyncDispatch,
        duringTtsPlayback: options.duringTtsPlayback ?? segment.duringTtsPlayback,
      });

      return {
        ...dispatched,
        text: transcript,
        speechDetected: true,
        denoiseEngine: denoiseTag,
        vadEngine: vadEngineLabel,
        asrEngine: "voice-ws-asr",
        inputSnrDb: segment.inputSnrDb,
        outputSnrDb: segment.inputSnrDb,
        snrGainDb: 0,
        acousticWake,
      };
    }
    const precomputedText = sanitizeAsrTranscript(segment.precomputedTranscript ?? "", {
      wakeWords: cfg.wakeWords,
    });
    const precomputedEnergyAudio =
      segment.rawSamples.length >= 800 ? segment.rawSamples : segment.denoisedSamples;
    const canReuseStreamingPrecomputed =
      useLocal &&
      precomputedText.length > 0 &&
      hasAudibleAudioEnergy(precomputedEnergyAudio, 16000) &&
      (segment.commitReason === "punctuation_split" ||
        (!segment.forcedRoll && segment.inputSnrDb >= 14));

    const sepReady =
      useLocal &&
      !canReuseStreamingPrecomputed &&
      cfg.sourceSeparationMode !== "off" &&
      this._localEngine.getStatus().readyForSourceSeparation &&
      segment.rawSamples.length >= 3200;

    // 1. 声纹识别：启用声源分离且为 tag 模式时，延后到分离命中后直接复用最优分离轨，省去噪声/拒识段上的 CAM++ 开销
    let voiceprintResult: VoiceprintIdentifyResult | null = null;
    let voiceprintMs = 0;
    const deferTagVoiceprint = sepReady && cfg.voiceprintMode === "tag";
    if (!deferTagVoiceprint && cfg.voiceprintMode !== "off" && profiles.length > 0 && vpAudio.length >= 4000) {
      const emb = this._localEngine.extractSpeakerEmbedding(vpAudio, 16000);
      voiceprintMs = emb.durationMs;
      voiceprintResult = identifyVoiceprint(emb.embedding, emb.engine, cfg.voiceprintThreshold);
    }

    // 1.5 openWakeWord 声学命中（启用声源分离时透传流式命中避免分离前重复扫 raw 轨）
    const owwEvaluated = Boolean(cfg.owwEnabled && this._localEngine.openWakeWord.isReady);
    let acousticWake =
      segment.acousticWake !== undefined
        ? segment.acousticWake
        : !sepReady && owwEvaluated
          ? this._localEngine.scoreWakeWordAudio(vpAudio, cfg.wakeWords, {
              threshold: cfg.owwThreshold,
              headOnlySec: 2.0,
            })
          : null;
    if (
      !sepReady &&
      owwEvaluated &&
      (!acousticWake || !acousticWake.matched) &&
      (segment.acousticWake !== undefined || segment.rawSamples !== vpAudio)
    ) {
      const rawHit = this._localEngine.scoreWakeWordAudio(segment.rawSamples, cfg.wakeWords, {
        threshold: cfg.owwThreshold,
        headOnlySec: 2.0,
      });
      if (rawHit && (!acousticWake || rawHit.score > acousticWake.score)) {
        acousticWake = rawHit;
      }
    }
    if (acousticWake?.matched) {
      this._lastWakeHit = { ...acousticWake, timestamp: Date.now() };
    }

    // 2. 双轨语音识别（优先本地声源分离 + SenseVoice，降级双轨 SenseVoice 或云端 Whisper）
    let transcript = "";
    let altText: string | undefined;
    let acousticEvent = "";
    let asrEngine = "sensevoice-dual-raw";
    let asrMs = 0;
    let runtimeEngine: VoiceRuntimeEngine = "local";

    if (useLocal) {
      if (canReuseStreamingPrecomputed) {
        transcript = precomputedText;
        asrEngine = segment.precomputedAsrEngine || "sensevoice-stream";
        asrMs = segment.precomputedAsrMs ?? 0;
        runtimeEngine = "local";
      } else if (sepReady) {
        const now = Date.now();
        const preSepEpoch = this._dialogEpoch;
        const segDurMs = Math.round(segment.durationSec * 1000);
        const speechStartedAt = Math.max(0, now - Math.min(30_000, segDurMs));
        const awakeActive =
          this._awakeUntil !== null && (now < this._awakeUntil || speechStartedAt < this._awakeUntil);
        const convWindowActive =
          cfg.conversationWindowSec > 0 &&
          this._conversationUntil !== null &&
          (now < this._conversationUntil || speechStartedAt < this._conversationUntil);
        const inConversation =
          this._dialogState === "conversation" || awakeActive || convWindowActive;

        const llmEvaluator: AttentionLlmEvaluator | undefined =
          options.llmAttentionOverride ??
          (cfg.provider !== "local"
            ? async (promptText: string) => {
                const raw = await this._agent.evaluateAttention(promptText, 3500);
                if (!raw) throw new Error("no llm verdict");
                return raw;
              }
            : undefined);

        const sepDualLegacy = this._echoGuard.getLegacyLastSpoken(now);
        const sep = await this._localEngine.sourceSeparator.separateAndRecognize(
          segment.rawSamples,
          16000,
          {
            mode: cfg.sourceSeparationMode,
            voiceLang: lang,
            wakeWordEnabled: cfg.wakeWordEnabled,
            wakeWords: cfg.wakeWords,
            attentionMode: cfg.attentionMode,
            bypassWakeWord: options.bypassWakeWord,
            awakeActive,
            inConversation,
            dialogState: this._dialogState,
            recentTurns: this._agent.recentConversationTurns(5),
            lastSpokenReply: sepDualLegacy.text || this._lastSpokenReply,
            lastSpokenAt: sepDualLegacy.at || this._lastSpokenAt,
            recentSpokenUtterances: this._echoGuard.getRecentUtterances(now),
            ttsActive: this._echoGuard.isSpeaking,
            duringTtsPlayback:
              options.duringTtsPlayback ?? segment.duringTtsPlayback ?? this._echoGuard.isSpeaking,
            echoCancellationMode: cfg.echoCancellationMode,
            now,
            voiceprint: voiceprintResult,
            voiceprintMode: cfg.voiceprintMode,
            systemOneClient: this._agent.systemOneClient,
            llmEvaluator,
            // 复用流式会话已经算好的 GTCRN 降噪轨与 openWakeWord 声学命中，彻底消除重复推理！
            preDenoisedGtcrn:
              segment.denoiseEngine.startsWith("gtcrn") ? segment.denoisedSamples : undefined,
            precomputedAcousticWake: acousticWake,
            capabilityDigest: this._agent.getCapabilityDigest(),
            learnedTriggers: this._agent.getLearnedTriggerSamples(),
            pendingConfirmation: this._agent.getActivePendingConfirmationGateContext(),
          },
        );

        if (deferTagVoiceprint && profiles.length > 0 && sep.speechDetected && sep.attention.accept) {
          const cleanVpAudio =
            sep.bestSpeechPcm && sep.bestSpeechPcm.length >= 4000 ? sep.bestSpeechPcm : vpAudio;
          if (cleanVpAudio.length >= 4000) {
            const emb = this._localEngine.extractSpeakerEmbedding(cleanVpAudio, 16000);
            voiceprintMs = emb.durationMs;
            voiceprintResult = identifyVoiceprint(emb.embedding, emb.engine, cfg.voiceprintThreshold);
          }
        }

        const effectiveWake = sep.acousticWake ?? acousticWake;
        if (effectiveWake?.matched) {
          this._lastWakeHit = { ...effectiveWake, timestamp: now };
        }

        this._lastMetrics = {
          denoiseEngine: sep.denoiseEngine,
          snrGainDb: sep.snrGainDb,
          vadEngine: sep.vadEngine,
          speechRatio: sep.speechDetected ? 1 : 0,
          asrEngine: sep.asrEngine,
          detectedSoundTypes: sep.detectedSoundTypes,
          detectedSpeakerCount: sep.detectedSpeakerCount,
          separatedStreams: sep.separatedStreams,
          voiceprint: voiceprintResult,
          acousticWake: effectiveWake,
          attention: sep.attention,
          updatedAt: Date.now(),
        };

        const sepText = segment.stripCommittedPrefixHint
          ? stripCommittedPrefix(sep.text, segment.stripCommittedPrefixHint)
          : sep.text;

        if (!sep.speechDetected || !sepText.trim()) {
          this._noteNonConversationSegment("ambient_noise");
          return {
            ok: true,
            text: "",
            speechDetected: false,
            denoiseEngine: sep.denoiseEngine,
            vadEngine: sep.vadEngine,
            asrEngine: sep.asrEngine,
            inputSnrDb: sep.inputSnrDb,
            outputSnrDb: sep.outputSnrDb,
            snrGainDb: sep.snrGainDb,
            acousticEvent: sep.acousticEvent,
            detectedSoundTypes: sep.detectedSoundTypes,
            detectedSpeakerCount: sep.detectedSpeakerCount,
            separatedStreams: sep.separatedStreams,
            voiceprint: voiceprintResult,
            acousticWake: effectiveWake,
            attention: sep.attention,
            matched: false,
            wokeOnly: false,
            command: "",
            timings: { voiceprintMs, asrMs: sep.totalMs, totalMs: Math.round(performance.now() - totalStart) },
            voiceState: this.snapshot(),
          };
        }

        const staleConversationDecision =
          inConversation &&
          this._dialogEpoch !== preSepEpoch &&
          this._dialogState === "standby" &&
          !sep.attention.wakeWord &&
          !options.bypassWakeWord &&
          cfg.wakeWordEnabled;

        const staleRejectedAttention: AttentionDecision | undefined = staleConversationDecision
          ? {
              accept: false,
              wokeOnly: false,
              addressed: false,
              inConversation: false,
              confidence: 0.9,
              stage: "no-wake",
              reason: "旧连续对话轮次已结束，已忽略过期异步识别结果",
              wakeWord: null,
              command: "",
              usedLlm: false,
              latencyMs: 0,
            }
          : undefined;

        const dispatched = await this.handleTranscript(sepText, {
          isFinal: true,
          bypassWakeWord: options.bypassWakeWord,
          engine: "local",
          now: staleConversationDecision ? Date.now() : now,
          segmentDurationMs: segDurMs,
          acousticEvent: sep.acousticEvent,
          altText: sep.altText,
          acousticWake: effectiveWake,
          owwEvaluated,
          voiceprint: voiceprintResult,
          snrGainDb: sep.snrGainDb,
          timingsBase: { voiceprintMs, asrMs: sep.totalMs },
          llmAttentionOverride: options.llmAttentionOverride,
          precomputedAttention: staleRejectedAttention
            ? staleRejectedAttention
            : Boolean(segment.stripCommittedPrefixHint)
              ? undefined
              : sep.attention,
          asyncDispatch: options.asyncDispatch,
          duringTtsPlayback: options.duringTtsPlayback ?? segment.duringTtsPlayback,
        });

        return {
          ...dispatched,
          text: sepText,
          speechDetected: true,
          denoiseEngine: sep.denoiseEngine,
          vadEngine: sep.vadEngine,
          asrEngine: sep.asrEngine,
          inputSnrDb: sep.inputSnrDb,
          outputSnrDb: sep.outputSnrDb,
          snrGainDb: sep.snrGainDb,
          acousticEvent: sep.acousticEvent,
          detectedSoundTypes: sep.detectedSoundTypes,
          detectedSpeakerCount: sep.detectedSpeakerCount,
          separatedStreams: sep.separatedStreams,
          acousticWake: effectiveWake,
        };
      }

      const sv = await this._localEngine.transcribeDualTrack(
        segment.rawSamples,
        segment.denoisedSamples,
        {
          voiceLang: lang,
          wakeWords: cfg.wakeWords,
          inputSnrDb: segment.inputSnrDb,
          forceDual: segment.forcedRoll || segment.inputSnrDb < 20,
          systemOneClient: this._agent.systemOneClient,
          acousticWake,
        },
      );
      transcript = segment.stripCommittedPrefixHint
        ? stripCommittedPrefix(sv.text, segment.stripCommittedPrefixHint)
        : sv.text;
      altText = sv.altText;
      acousticEvent = sv.event;
      asrEngine = sv.engine;
      asrMs = sv.durationMs;
      runtimeEngine = "local";
    } else {
      const wavBytes = encodeWavPcm16(vpAudio, 16000);
      const blob = new Blob([wavBytes as unknown as BlobPart], { type: "audio/wav" });
      const t0 = performance.now();
      transcript = await this.transcribeAudio(blob, { filename: "voice-stream.wav", lang });
      asrMs = Math.round(performance.now() - t0);
      asrEngine = "whisper-cloud";
      runtimeEngine = "whisper";
    }

    const vadEngineLabel = segment.commitReason
      ? `silero-stream:${segment.commitReason}`
      : "silero-stream";
    this._lastMetrics = {
      denoiseEngine: segment.denoiseEngine,
      snrGainDb: segment.snrGainDb,
      vadEngine: vadEngineLabel,
      speechRatio: 1,
      asrEngine,
      voiceprint: voiceprintResult,
      acousticWake,
      updatedAt: Date.now(),
    };

    if (!transcript.trim()) {
      this._noteNonConversationSegment("ambient_noise");
      return {
        ok: true,
        text: "",
        speechDetected: false,
        denoiseEngine: segment.denoiseEngine,
        vadEngine: vadEngineLabel,
        asrEngine,
        inputSnrDb: segment.inputSnrDb,
        outputSnrDb: segment.outputSnrDb,
        snrGainDb: segment.snrGainDb,
        acousticEvent,
        voiceprint: voiceprintResult,
        acousticWake,
        matched: false,
        wokeOnly: false,
        command: "",
        timings: {
          voiceprintMs,
          asrMs,
          totalMs: Math.round(performance.now() - totalStart),
        },
        voiceState: this.snapshot(),
      };
    }

    // 等用户整段话说完后作为一整条完整指令统一发送给 Pi Agent，绝不按句中标点强拆成多条独立请求！
    const dispatched = await this.handleTranscript(transcript, {
      isFinal: true,
      bypassWakeWord: options.bypassWakeWord,
      engine: runtimeEngine,
      segmentDurationMs: Math.round(segment.durationSec * 1000),
      acousticEvent,
      altText,
      acousticWake,
      owwEvaluated,
      voiceprint: voiceprintResult,
      snrGainDb: segment.snrGainDb,
      timingsBase: {
        voiceprintMs,
        asrMs,
      },
      llmAttentionOverride: options.llmAttentionOverride,
      asyncDispatch: options.asyncDispatch,
      duringTtsPlayback: options.duringTtsPlayback ?? segment.duringTtsPlayback,
    });

    return {
      ...dispatched,
      text: transcript,
      speechDetected: true,
      denoiseEngine: segment.denoiseEngine,
      vadEngine: vadEngineLabel,
      asrEngine,
      inputSnrDb: segment.inputSnrDb,
      outputSnrDb: segment.outputSnrDb,
      snrGainDb: segment.snrGainDb,
      acousticEvent,
      acousticWake,
    };
  }

  /**
   * 声纹注册：先对样本执行环境降噪与 Silero VAD 裁切，再提取 3D-Speaker CAM++ 向量并落盘，同时保存参考 WAV 供 VoxLock 使用。
   */
  async enrollVoiceprintFromAudio(
    audioBlob: Blob,
    options: { name: string; role?: VoiceprintRole },
  ): Promise<{
    profile: PublicVoiceprintProfile;
    denoiseEngine: string;
    snrGainDb: number;
    embeddingEngine: string;
    durationMs: number;
  }> {
    const t0 = performance.now();
    const rawBuf = new Uint8Array(await audioBlob.arrayBuffer());
    const decoded = decodeWavPcm(rawBuf);
    const pcm16k =
      decoded.sampleRate === 16000
        ? decoded.samples
        : resampleLinear(decoded.samples, decoded.sampleRate, 16000);

    const denoised = this._localEngine.denoise(pcm16k, 16000, this.config.noiseSuppressionMode);
    const vad = this._localEngine.detectSpeechSegments(denoised.samples, 16000, {
      mode: this.config.vadMode,
    });
    const speech = vad.hasSpeech && vad.speechSamples.length >= 4800 ? vad.speechSamples : denoised.samples;
    if (speech.length < 4800) {
      throw new Error("有效语音时长过短（需至少 0.5 秒清晰人声），请靠近麦克风重试");
    }

    const emb = this._localEngine.extractSpeakerEmbedding(speech, 16000);
    const profile = enrollVoiceprint({
      name: options.name,
      role: options.role,
      embedding: emb.embedding,
      engine: emb.engine,
      refAudioSamples16k: speech,
    });

    this.emit("stateChanged", this.snapshot());
    return {
      profile,
      denoiseEngine: denoised.engine,
      snrGainDb: denoised.snrGainDb,
      embeddingEngine: emb.engine,
      durationMs: Math.round(performance.now() - t0),
    };
  }

  /**
   * 声纹验证测试：对上传音频进行降噪 + VAD + 声纹比对，返回匹配说话人与各候选相似度。
   */
  async verifyVoiceprintFromAudio(audioBlob: Blob): Promise<{
    result: VoiceprintIdentifyResult;
    denoiseEngine: string;
    snrGainDb: number;
    durationMs: number;
  }> {
    const t0 = performance.now();
    const rawBuf = new Uint8Array(await audioBlob.arrayBuffer());
    const decoded = decodeWavPcm(rawBuf);
    const pcm16k =
      decoded.sampleRate === 16000
        ? decoded.samples
        : resampleLinear(decoded.samples, decoded.sampleRate, 16000);

    const denoised = this._localEngine.denoise(pcm16k, 16000, this.config.noiseSuppressionMode);
    const vad = this._localEngine.detectSpeechSegments(denoised.samples, 16000, {
      mode: this.config.vadMode,
    });
    const speech = vad.hasSpeech && vad.speechSamples.length >= 4000 ? vad.speechSamples : denoised.samples;
    const emb = this._localEngine.extractSpeakerEmbedding(speech, 16000);
    const result = identifyVoiceprint(emb.embedding, emb.engine, this.config.voiceprintThreshold);

    return {
      result,
      denoiseEngine: denoised.engine,
      snrGainDb: denoised.snrGainDb,
      durationMs: Math.round(performance.now() - t0),
    };
  }

  removeVoiceprint(id: string): boolean {
    const deleted = deleteVoiceprint(id);
    if (deleted) {
      this.emit("stateChanged", this.snapshot());
    }
    return deleted;
  }

  /**
   * 录制并注册自定义唤醒词真声原型（openWakeWord 本地 96 维语音嵌入，0ms / +40ms 双相位保存）。
   */
  async enrollWakeWordFromAudio(
    audioBlob: Blob,
    wakeWord: string,
    options: { voiceTag?: string } = {},
  ): Promise<OpenWakeWordEnrollResult & { prototypes: WakeWordPrototypeSummary[] }> {
    const cleanWord = wakeWord.trim();
    if (!cleanWord) {
      throw new Error("唤醒词不能为空");
    }
    const rawBuf = new Uint8Array(await audioBlob.arrayBuffer());
    const decoded = decodeWavPcm(rawBuf);
    const pcm16k =
      decoded.sampleRate === 16000
        ? decoded.samples
        : resampleLinear(decoded.samples, decoded.sampleRate, 16000);

    this._localEngine.openWakeWord.ensureLoaded();
    const enrolled = this._localEngine.openWakeWord.enrollSample(cleanWord, pcm16k, options);
    const prototypes = listWakeWordPrototypeSummaries(this.config.wakeWords);
    this.emit("stateChanged", this.snapshot());
    return {
      ...enrolled,
      prototypes,
    };
  }

  /**
   * 离线唤醒词声学测试：对上传 WAV 音频执行 openWakeWord 打分并返回最高命中与得分。
   */
  async verifyWakeWordFromAudio(
    audioBlob: Blob,
    wakeWords?: readonly string[],
  ): Promise<{
    hit: WakeWordAcousticHit | null;
    matched: boolean;
    wakeWords: string[];
    threshold: number;
    latencyMs: number;
    durationMs: number;
  }> {
    const t0 = performance.now();
    const rawBuf = new Uint8Array(await audioBlob.arrayBuffer());
    const decoded = decodeWavPcm(rawBuf);
    const pcm16k =
      decoded.sampleRate === 16000
        ? decoded.samples
        : resampleLinear(decoded.samples, decoded.sampleRate, 16000);

    const targetWords = wakeWords && wakeWords.length > 0 ? [...wakeWords] : [...this.config.wakeWords];
    const threshold = this.config.owwThreshold;
    this._localEngine.openWakeWord.ensureLoaded();
    const hit = this._localEngine.scoreWakeWordAudio(pcm16k, targetWords, { threshold });
    const durationMs = Number((performance.now() - t0).toFixed(2));
    return {
      hit,
      matched: Boolean(hit?.matched),
      wakeWords: targetWords,
      threshold,
      latencyMs: durationMs,
      durationMs,
    };
  }

  /**
   * 触发 openWakeWord 零样本多音色 TTS 原型预热（幂等，绝不覆盖用户真声录制样本）。
   */
  async bootstrapWakeWords(
    wakeWords?: readonly string[],
    force = false,
  ): Promise<OpenWakeWordBootstrapResult & { prototypes: WakeWordPrototypeSummary[] }> {
    const targetWords = wakeWords && wakeWords.length > 0 ? [...wakeWords] : [...this.config.wakeWords];
    this._localEngine.openWakeWord.ensureLoaded();
    const result = await this._localEngine.openWakeWord.bootstrapWakeWords(targetWords, { force });
    const prototypes = listWakeWordPrototypeSummaries(this.config.wakeWords);
    this.emit("stateChanged", this.snapshot());
    return {
      ...result,
      prototypes,
    };
  }

  /**
   * 删除指定 ID 的单条唤醒词原型，或删除某唤醒词对应的全部/仅用户录制原型。
   */
  removeWakeWordPrototype(
    target: string,
    enrolledOnly = false,
  ): { deleted: boolean; removedCount: number; prototypes: WakeWordPrototypeSummary[] } {
    const clean = target.trim();
    if (!clean) {
      return {
        deleted: false,
        removedCount: 0,
        prototypes: listWakeWordPrototypeSummaries(this.config.wakeWords),
      };
    }
    let removedCount = 0;
    if (deleteWakeWordPrototypeById(clean)) {
      removedCount = 1;
    } else {
      removedCount = deleteWakeWordPrototypesForWord(clean, { enrolledOnly });
    }
    if (removedCount > 0) {
      this.emit("stateChanged", this.snapshot());
    }
    return {
      deleted: removedCount > 0,
      removedCount,
      prototypes: listWakeWordPrototypeSummaries(this.config.wakeWords),
    };
  }

  /**
   * 调用 OpenAI 兼容 /audio/transcriptions 接口（Whisper / SenseVoice / SiliconFlow / 本地 Whisper）转写音频。
   */
  async transcribeAudio(
    audioBlob: Blob,
    options: { filename?: string; lang?: string } = {},
  ): Promise<string> {
    const cfg = this.config;
    const stt = resolveEffectiveSttAuth(cfg);
    if (!stt.baseUrl) {
      throw new Error(
        "尚未配置语音转写 STT 服务地址，请在「设置 → 语音与 Pi Agent」中使用本地离线 SenseVoice 引擎、讯飞听写 2.0 或填写 OpenAI 兼容 STT 接口地址。",
      );
    }
    const localUrl = isLocalEndpointUrl(stt.baseUrl);
    if (!stt.apiKey && !localUrl) {
      throw new Error("缺少语音转写 STT API Key，请在「设置 → 语音与 Pi Agent」中填写。");
    }

    const endpoint = stt.baseUrl.endsWith("/audio/transcriptions")
      ? stt.baseUrl
      : `${stt.baseUrl.replace(/\/+$/, "")}/audio/transcriptions`;

    const form = new FormData();
    const filename = options.filename || "voice.wav";
    form.append("file", audioBlob, filename);
    form.append("model", stt.model);
    const langCode = (options.lang || cfg.voiceLang || "zh-CN").split("-")[0] || "zh";
    form.append("language", langCode);

    const headers: Record<string, string> = {};
    if (stt.apiKey) {
      headers["Authorization"] = `Bearer ${stt.apiKey}`;
    }

    const bounded = createBoundedFetch(this._fetcher, 25_000);
    const res = await bounded(endpoint, {
      method: "POST",
      headers,
      body: form,
      timeoutMs: 25_000,
    });

    const rawText = await res.text();
    if (!res.ok) {
      throw new Error(`语音转写服务返回错误 (${res.status})`);
    }
    try {
      const parsed = JSON.parse(rawText) as { text?: unknown };
      if (typeof parsed.text === "string") {
        return sanitizeAsrTranscript(parsed.text, { wakeWords: cfg.wakeWords });
      }
    } catch {
      // plain text response fallback
    }
    return sanitizeAsrTranscript(rawText, { wakeWords: cfg.wakeWords });
  }

  clearHistory(): void {
    this._clearConversationTimer();
    this._clearTtsPauseWatchdog();
    this._dialogEpoch += 1;
    this._dialogState = "standby";
    this._history = [];
    this._lastTranscript = "";
    this._lastCommand = "";
    this._awakeUntil = null;
    this._conversationUntil = null;
    this._conversationBaseUntil = null;
    this._conversationHardUntil = null;
    this._remainingConversationMs = 0;
    this._timerPaused = false;
    this._consecutiveSidetalkCount = 0;
    this._consecutiveAmbientNoiseCount = 0;
    this._speechGraceSuppressed = false;
    this._conversationSpeakerName = null;
    this._lastTransitionReason = "cleared";
    this._echoGuard.reset();
    this.emit("stateChanged", this.snapshot());
  }

  snapshot(): VoiceListenerSnapshot {
    const cfg = this.config;
    this._syncLocalEngineConfig();
    const now = Date.now();
    const conversationRemainingMs =
      this._dialogState === "conversation"
        ? this._timerPaused
          ? Math.max(0, this._remainingConversationMs)
          : this._conversationUntil !== null
            ? Math.max(0, this._conversationUntil - now)
            : this._awakeUntil !== null
              ? Math.max(0, this._awakeUntil - now)
              : 0
        : 0;
    const systemOneHealth = this._agent.systemOneClient
      ? this._agent.systemOneClient.getStatus()
      : null;
    const activeTasks = this._agent.getActiveTasks();
    const recentTts = this._echoGuard.getRecentUtterances(now);
    const lanes: VoiceRuntimeLanes = {
      conversation: {
        active: this._active,
        dialogState: this._dialogState,
        speechActive: this._speechInProgress,
        fullDuplex: cfg.asyncVoicePipeline !== false,
      },
      execution: {
        active: activeTasks.length > 0,
        activeCount: activeTasks.length,
        tasks: activeTasks,
      },
      speaking: {
        active: this._echoGuard.isSpeaking,
        utteranceId: this._echoGuard.activeUtteranceId,
        text: this._echoGuard.activeUtteranceText,
        queueLength: this._echoGuard.clientQueueLength,
        ducked: this._echoGuard.clientDucked,
      },
      echo: {
        mode: cfg.echoCancellationMode,
        activeAec: this._echoGuard.aecActive,
        erleDb: this._echoGuard.erleDb,
        doubleTalkActive: this._echoGuard.doubleTalkActive,
        suppressedCount: this._echoGuard.suppressedCount,
        strippedCount: this._echoGuard.strippedCount,
        activeTtsUtterances: recentTts.length,
      },
    };
    return {
      active: this._active,
      mode: this._mode,
      dialogState: this._dialogState,
      dialogEpoch: this._dialogEpoch,
      serverNow: now,
      timerPaused: this._timerPaused,
      conversationRemainingMs,
      conversationWindowSec: cfg.conversationWindowSec,
      maxConsecutiveSidetalk: cfg.maxConsecutiveSidetalk,
      consecutiveSidetalkCount: this._consecutiveSidetalkCount,
      lastTransitionReason: this._lastTransitionReason,
      engine: this._engine,
      voicePipelineMode: cfg.voicePipelineMode,
      xfyunEndpointUrl: cfg.xfyunEndpointUrl,
      xfyunAppId: cfg.xfyunAppId,
      effectiveXfyunConfigured: resolveEffectiveXfyunAuth(cfg).configured,
      voiceWsAsrEndpointUrl: cfg.voiceWsAsrEndpointUrl,
      voiceWsAsrDenoise: cfg.voiceWsAsrDenoise,
      voiceWsAsrLanguage: cfg.voiceWsAsrLanguage,
      effectiveVoiceWsAsrConfigured: resolveEffectiveVoiceWsAsrAuth(cfg).configured,
      streamingAsrEnabled: cfg.streamingAsrEnabled,
      asyncVoicePipeline: cfg.asyncVoicePipeline,
      echoCancellationMode: cfg.echoCancellationMode,
      bargeInDuckingEnabled: cfg.bargeInDuckingEnabled,
      lanes,
      interimTranscript: this._interimTranscript,
      lastTranscript: this._lastTranscript,
      lastCommand: this._lastCommand,
      awakeUntil: this._awakeUntil,
      conversationUntil: this._conversationUntil,
      error: this._error,
      wakeWordEnabled: cfg.wakeWordEnabled,
      wakeWords: [...cfg.wakeWords],
      wakeAckPhrase: cfg.wakeAckPhrase,
      autoSpeakReply: cfg.autoSpeakReply,
      ttsEngine: cfg.ttsEngine,
      ttsVoice: cfg.ttsVoice,
      ttsSpeed: cfg.ttsSpeed,
      attentionMode: cfg.attentionMode,
      noiseSuppressionMode: cfg.noiseSuppressionMode,
      voiceprintMode: cfg.voiceprintMode,
      cavemanMode: cfg.cavemanMode,
      owwEnabled: cfg.owwEnabled,
      owwThreshold: cfg.owwThreshold,
      localEngine: this._localEngine.getStatus(),
      openWakeWord: this._localEngine.openWakeWord.getStatus(),
      wakeWordPrototypes: listWakeWordPrototypeSummaries(cfg.wakeWords),
      lastWakeHit: this._lastWakeHit ? { ...this._lastWakeHit } : null,
      systemOneHealth,
      systemOne: systemOneHealth,
      voiceprints: listPublicVoiceprints(),
      lastMetrics: this._lastMetrics ? { ...this._lastMetrics } : null,
      history: this._history.map((h) => ({ ...h })),
    };
  }

  dispose(): void {
    this._clearConversationTimer();
    this._clearTtsPauseWatchdog();
    this._unsubAgentSpeak();
    this._unsubConfirmationPending();
    this._localEngine.dispose();
    this._active = false;
    this._dialogState = "standby";
    this._mode = "idle";
    this._awakeUntil = null;
    this._conversationUntil = null;
    this._conversationBaseUntil = null;
    this._conversationHardUntil = null;
    this._remainingConversationMs = 0;
    this._timerPaused = false;
    this._speechInProgress = false;
    this._speechActivityStartedAt = null;
    this._speechGraceSuppressed = false;
    this._consecutiveAmbientNoiseCount = 0;
    this._conversationSpeakerName = null;
    this._echoGuard.reset();
    this.clear();
  }
}
