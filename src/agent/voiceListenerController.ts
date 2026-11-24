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
  type AgentVoiceConfig,
} from "../core/agentConfigStore.ts";
import { TypedEmitter } from "../core/contracts.ts";
import { createBoundedFetch, type FetchLike } from "../core/httpTimeout.ts";
import { decodeWavPcm, encodeWavPcm16, isWavBuffer, resampleLinear } from "./audioPcm.ts";
import { LocalVoiceEngine, type LocalVoiceEngineStatus } from "./localVoiceEngine.ts";
import type { AgentToolCallRecord, PiAgentRunResult, PiAgentService } from "./piAgentService.ts";
import type { VoiceStreamSegmentPayload } from "./voiceStreamSession.ts";
import {
  evaluateVoiceAttention,
  findWakeWordSpan,
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

export type VoiceListenMode = "idle" | "listening" | "awake" | "processing" | "speaking" | "error";
export type VoiceRuntimeEngine = "local" | "browser" | "whisper" | "manual";

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
  snrGainDb?: number;
  timings?: VoicePipelineTimings;
}

export interface VoiceLastMetrics {
  denoiseEngine?: string;
  snrGainDb?: number;
  vadEngine?: string;
  speechRatio?: number;
  asrEngine?: string;
  voiceprint?: VoiceprintIdentifyResult | null;
  attention?: AttentionDecision | null;
  timings?: VoicePipelineTimings | null;
  updatedAt: number;
}

export interface VoiceListenerSnapshot {
  active: boolean;
  mode: VoiceListenMode;
  engine: VoiceRuntimeEngine;
  interimTranscript: string;
  lastTranscript: string;
  lastCommand: string;
  awakeUntil: number | null;
  conversationUntil: number | null;
  error: string | null;
  wakeWordEnabled: boolean;
  wakeWords: string[];
  autoSpeakReply: boolean;
  attentionMode: AgentVoiceConfig["attentionMode"];
  noiseSuppressionMode: AgentVoiceConfig["noiseSuppressionMode"];
  voiceprintMode: AgentVoiceConfig["voiceprintMode"];
  localEngine: LocalVoiceEngineStatus;
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
  acousticEvent?: string;
  voiceprint?: VoiceprintIdentifyResult | null;
  snrGainDb?: number;
  timingsBase?: Partial<VoicePipelineTimings>;
  llmAttentionOverride?: AttentionLlmEvaluator;
}

export interface HandleTranscriptResult {
  ok: boolean;
  matched: boolean;
  wokeOnly: boolean;
  command: string;
  reply?: string;
  toolCalls?: AgentToolCallRecord[];
  attention?: AttentionDecision;
  voiceprint?: VoiceprintIdentifyResult | null;
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
}

export type VoiceListenerEvents = {
  stateChanged: [VoiceListenerSnapshot];
  speakRequested: [string];
  speakChunkRequested: [{ text: string; final: boolean }];
};

const LEADING_PUNCT_RE = /^[\s,，。．.、!！?？:：;；\-—~～]+/;
const TRAILING_PUNCT_RE = /[\s,，。．.、!！?？:：;；]+$/;

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
  private readonly _unsubAgentSpeak: () => void;

  private _active = false;
  private _mode: VoiceListenMode = "idle";
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
  private _lastDispatchedAt = 0;
  private _seq = 0;

  constructor(
    agent: PiAgentService,
    options: { fetcher?: FetchLike; localEngine?: LocalVoiceEngine } = {},
  ) {
    super();
    this._agent = agent;
    this._fetcher = options.fetcher ?? globalThis.fetch;
    this._localEngine = options.localEngine ?? new LocalVoiceEngine();
    this._engine = this._localEngine.getStatus().readyForLocalAsr ? "local" : "browser";

    // 转发 Pi Agent 流式分句语音播报事件，并记录用于自回声抑制
    this._unsubAgentSpeak = this._agent.on("speakChunk", ({ text, final }) => {
      if (!this.config.autoSpeakReply) return;
      this._recordSpoken(text);
      this.emit("speakChunkRequested", { text, final });
    });
  }

  get config(): AgentVoiceConfig {
    return this._agent.config;
  }

  get localEngine(): LocalVoiceEngine {
    return this._localEngine;
  }

  private _recordSpoken(text: string): void {
    const t = text.trim();
    if (!t) return;
    const now = Date.now();
    if (now - this._lastSpokenAt < 3500 && this._lastSpokenReply.length < 300) {
      this._lastSpokenReply = `${this._lastSpokenReply} ${t}`.trim();
    } else {
      this._lastSpokenReply = t;
    }
    this._lastSpokenAt = now;
  }

  updateRuntimeState(patch: {
    active?: boolean;
    mode?: VoiceListenMode;
    engine?: VoiceRuntimeEngine;
    interimTranscript?: string;
    error?: string | null;
  }): VoiceListenerSnapshot {
    if (patch.active !== undefined) {
      this._active = Boolean(patch.active);
      if (!this._active) {
        this._mode = "idle";
        this._interimTranscript = "";
        this._awakeUntil = null;
        this._conversationUntil = null;
      } else if (this._mode === "idle" || this._mode === "error") {
        this._mode = "listening";
        this._error = null;
      }
      if (this._active) {
        // 用户开启监听时异步预热本地 ONNX 模型，消除首句冷启动延迟
        void this._localEngine.warmup();
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

    this._lastTranscript = text;
    this._error = null;

    // 1.5s 内相同最终识别结果去重（避免浏览器重复回调）
    if (text === this._lastDispatchedText && now - this._lastDispatchedAt < 1500) {
      return {
        ok: true,
        matched: false,
        wokeOnly: false,
        command: "",
        voiceState: this.snapshot(),
      };
    }

    const cfg = this.config;
    const awakeActive = this._awakeUntil !== null && now < this._awakeUntil;
    if (!awakeActive && this._awakeUntil !== null) {
      this._awakeUntil = null;
    }
    const inConversation =
      awakeActive ||
      (cfg.conversationWindowSec > 0 &&
        this._conversationUntil !== null &&
        now < this._conversationUntil);
    if (!inConversation && this._conversationUntil !== null) {
      this._conversationUntil = null;
    }

    const llmEvaluator: AttentionLlmEvaluator | undefined =
      options.llmAttentionOverride ??
      (cfg.provider !== "local"
        ? async (promptText: string) => {
            const raw = await this._agent.evaluateAttention(promptText, 7000);
            if (!raw) throw new Error("no llm verdict");
            return raw;
          }
        : undefined);

    const decision = await evaluateVoiceAttention({
      rawText: text,
      wakeWordEnabled: cfg.wakeWordEnabled,
      wakeWords: cfg.wakeWords,
      attentionMode: cfg.attentionMode,
      bypassWakeWord: options.bypassWakeWord,
      awakeActive,
      inConversation,
      recentTurns: this._agent.recentConversationTurns(6),
      lastSpokenReply: this._lastSpokenReply,
      lastSpokenAt: this._lastSpokenAt,
      now,
      acousticEvent: options.acousticEvent,
      voiceprint: options.voiceprint,
      voiceprintMode: cfg.voiceprintMode,
      llmEvaluator,
    });

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
      snrGainDb: options.snrGainDb,
      timings,
    };
    this._history.push(entry);
    if (this._history.length > 25) {
      this._history = this._history.slice(-25);
    }

    this._lastMetrics = {
      ...(this._lastMetrics ?? {}),
      voiceprint: options.voiceprint ?? this._lastMetrics?.voiceprint ?? null,
      attention: decision,
      timings,
      updatedAt: now,
    };

    // 仅唤醒词：开启唤醒等待窗口与对话窗口
    if (decision.accept && decision.wokeOnly) {
      this._awakeUntil = now + cfg.wakeWindowSec * 1000;
      if (cfg.conversationWindowSec > 0) {
        this._conversationUntil = now + cfg.conversationWindowSec * 1000;
      }
      this._mode = "awake";
      const wakeReply = options.voiceprint?.speakerName
        ? `${options.voiceprint.speakerName}，我在，请说指令`
        : "我在，请说指令";
      entry.reply = wakeReply;
      const snap = this.snapshot();
      this.emit("stateChanged", snap);
      if (cfg.autoSpeakReply) {
        this._recordSpoken(wakeReply);
        this.emit("speakRequested", wakeReply);
      }
      return {
        ok: true,
        matched: true,
        wokeOnly: true,
        command: "",
        reply: wakeReply,
        attention: decision,
        voiceprint: options.voiceprint,
        timings,
        voiceState: snap,
      };
    }

    // 注意力门控拒绝（非定向提及/旁白/回声/声纹未通过）
    // 仅在显式告别词时提前结束对话窗口，旁白/他人插话/回声不破坏用户当前剩余的短时对话窗口
    if (!decision.accept || !decision.command) {
      if (/(?:退下|再见|拜拜|不用了|没事了|闭嘴|安静|休息吧)/.test(text)) {
        this._awakeUntil = null;
        this._conversationUntil = null;
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
        timings,
        voiceState: snap,
      };
    }

    // 确认在呼叫/对话：进入 Pi Agent 工具执行循环
    this._awakeUntil = null;
    this._lastDispatchedText = text;
    this._lastDispatchedAt = now;
    this._lastCommand = decision.command;
    this._mode = "processing";
    this.emit("stateChanged", this.snapshot());

    const agentStart = performance.now();
    const runResult: PiAgentRunResult = await this._agent.prompt(decision.command, {
      source: "voice",
      voiceMeta: {
        speakerName: options.voiceprint?.speakerName ?? null,
        speakerRole: options.voiceprint?.role ?? null,
        speakerScore: options.voiceprint?.score,
        wakeWord: decision.wakeWord,
        attentionReason: decision.reason,
      },
    });
    const agentMs = Math.round(performance.now() - agentStart);

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

    // 执行完成后刷新连续对话窗口（后续多轮追问无需重复喊唤醒词，由注意力门控区分续聊与旁白）
    if (cfg.conversationWindowSec > 0 && runResult.ok) {
      this._conversationUntil = Date.now() + cfg.conversationWindowSec * 1000;
    }

    this._mode = this._active ? "listening" : "idle";
    this._lastMetrics = {
      ...(this._lastMetrics ?? {}),
      attention: decision,
      timings,
      updatedAt: Date.now(),
    };
    const finalSnap = this.snapshot();
    this.emit("stateChanged", finalSnap);

    if (cfg.autoSpeakReply && runResult.reply) {
      this._recordSpoken(runResult.reply);
      if (!runResult.streamedSpeakChunks) {
        this.emit("speakRequested", runResult.reply);
      }
    }

    return {
      ok: runResult.ok,
      matched: true,
      wokeOnly: false,
      command: decision.command,
      reply: runResult.reply,
      toolCalls: runResult.toolCalls,
      attention: decision,
      voiceprint: options.voiceprint,
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

    // ---- Stage 2: 环境降噪（GTCRN 神经语音增强 / 纯 TS 频谱减法） ----
    const denoised = this._localEngine.denoise(pcm16k, 16000, cfg.noiseSuppressionMode);

    // ---- Stage 3: 语音活动检测与静音裁切（Silero VAD / 自适应 VAD） ----
    const vad = this._localEngine.detectSpeechSegments(denoised.samples, 16000, {
      mode: cfg.vadMode,
    });

    if (!vad.hasSpeech || vad.speechSamples.length < 1600) {
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

    // ---- Stage 5: 语音识别（优先本地离线 SenseVoiceSmall int8，降级云端 Whisper） ----
    const sttAuth = resolveEffectiveSttAuth(cfg);
    const hasCloudStt = Boolean(sttAuth.baseUrl && (sttAuth.apiKey || isLocalEndpointUrl(sttAuth.baseUrl)));
    const localReady = this._localEngine.getStatus().readyForLocalAsr;
    const pref = options.preferredEngine ?? (cfg.voiceEngine === "whisper" ? "whisper" : "auto");

    let transcript = "";
    let acousticEvent = "";
    let asrEngine = "sensevoice-local";
    let asrMs = 0;
    let runtimeEngine: VoiceRuntimeEngine = "local";

    const useLocal =
      pref === "local" || (pref === "auto" && localReady) || (pref === "whisper" && !hasCloudStt && localReady);

    if (useLocal) {
      // 双轨抗音乐/强噪融合识别：同时参考高通原始轨（零降噪伪影）与神经降噪轨，避免音乐场景吞字或误词！
      const sv = await this._localEngine.transcribeDualTrack(pcm16k, vad.speechSamples, {
        voiceLang: lang,
        wakeWords: cfg.wakeWords,
        inputSnrDb: denoised.inputSnrDb,
      });
      transcript = sv.text;
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
      acousticEvent,
      voiceprint: voiceprintResult,
      snrGainDb: denoised.snrGainDb,
      timingsBase,
      llmAttentionOverride: options.llmAttentionOverride,
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
    } = {},
  ): Promise<ProcessAudioUploadResult> {
    const totalStart = performance.now();
    const cfg = this.config;
    const lang = options.lang || cfg.voiceLang || "zh-CN";

    // 1. 声纹识别（使用降噪后更干净的说话人语音段）
    let voiceprintResult: VoiceprintIdentifyResult | null = null;
    let voiceprintMs = 0;
    const profiles = listPublicVoiceprints();
    const vpAudio =
      segment.denoisedSamples.length >= 4000 ? segment.denoisedSamples : segment.rawSamples;
    if (cfg.voiceprintMode !== "off" && profiles.length > 0 && vpAudio.length >= 4000) {
      const emb = this._localEngine.extractSpeakerEmbedding(vpAudio, 16000);
      voiceprintMs = emb.durationMs;
      voiceprintResult = identifyVoiceprint(emb.embedding, emb.engine, cfg.voiceprintThreshold);
    }

    // 2. 双轨语音识别（优先本地 SenseVoice 双轨融合，降级云端 Whisper）
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

    let transcript = "";
    let acousticEvent = "";
    let asrEngine = "sensevoice-dual-raw";
    let asrMs = 0;
    let runtimeEngine: VoiceRuntimeEngine = "local";

    if (useLocal) {
      const sv = await this._localEngine.transcribeDualTrack(
        segment.rawSamples,
        segment.denoisedSamples,
        {
          voiceLang: lang,
          wakeWords: cfg.wakeWords,
          inputSnrDb: segment.inputSnrDb,
          forceDual: segment.forcedRoll || segment.inputSnrDb < 20,
        },
      );
      transcript = sv.text;
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

    this._lastMetrics = {
      denoiseEngine: segment.denoiseEngine,
      snrGainDb: segment.snrGainDb,
      vadEngine: "silero-stream",
      speechRatio: 1,
      asrEngine,
      voiceprint: voiceprintResult,
      updatedAt: Date.now(),
    };

    if (!transcript.trim()) {
      return {
        ok: true,
        text: "",
        speechDetected: false,
        denoiseEngine: segment.denoiseEngine,
        vadEngine: "silero-stream",
        asrEngine,
        inputSnrDb: segment.inputSnrDb,
        outputSnrDb: segment.outputSnrDb,
        snrGainDb: segment.snrGainDb,
        acousticEvent,
        voiceprint: voiceprintResult,
        matched: false,
        wokeOnly: false,
        command: "",
        timings: { voiceprintMs, asrMs, totalMs: Math.round(performance.now() - totalStart) },
        voiceState: this.snapshot(),
      };
    }

    const dispatched = await this.handleTranscript(transcript, {
      isFinal: true,
      bypassWakeWord: options.bypassWakeWord,
      engine: runtimeEngine,
      acousticEvent,
      voiceprint: voiceprintResult,
      snrGainDb: segment.snrGainDb,
      timingsBase: { voiceprintMs, asrMs },
      llmAttentionOverride: options.llmAttentionOverride,
    });

    return {
      ...dispatched,
      text: transcript,
      speechDetected: true,
      denoiseEngine: segment.denoiseEngine,
      vadEngine: "silero-stream",
      asrEngine,
      inputSnrDb: segment.inputSnrDb,
      outputSnrDb: segment.outputSnrDb,
      snrGainDb: segment.snrGainDb,
      acousticEvent,
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
        "尚未配置语音转写 STT 服务地址，请在「设置 → 语音与 Pi Agent」中使用本地离线 SenseVoice 引擎或填写 OpenAI 兼容 STT 接口地址。",
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
        return parsed.text.trim();
      }
    } catch {
      // plain text response fallback
    }
    return rawText.trim();
  }

  clearHistory(): void {
    this._history = [];
    this._lastTranscript = "";
    this._lastCommand = "";
    this._conversationUntil = null;
    this.emit("stateChanged", this.snapshot());
  }

  snapshot(): VoiceListenerSnapshot {
    const cfg = this.config;
    return {
      active: this._active,
      mode: this._mode,
      engine: this._engine,
      interimTranscript: this._interimTranscript,
      lastTranscript: this._lastTranscript,
      lastCommand: this._lastCommand,
      awakeUntil: this._awakeUntil,
      conversationUntil: this._conversationUntil,
      error: this._error,
      wakeWordEnabled: cfg.wakeWordEnabled,
      wakeWords: [...cfg.wakeWords],
      autoSpeakReply: cfg.autoSpeakReply,
      attentionMode: cfg.attentionMode,
      noiseSuppressionMode: cfg.noiseSuppressionMode,
      voiceprintMode: cfg.voiceprintMode,
      localEngine: this._localEngine.getStatus(),
      voiceprints: listPublicVoiceprints(),
      lastMetrics: this._lastMetrics ? { ...this._lastMetrics } : null,
      history: this._history.map((h) => ({ ...h })),
    };
  }

  dispose(): void {
    this._unsubAgentSpeak();
    this._localEngine.dispose();
    this._active = false;
    this._mode = "idle";
    this._awakeUntil = null;
    this._conversationUntil = null;
    this.clear();
  }
}
