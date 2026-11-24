// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * 浏览器端实时语音监听客户端：
 * - 模式 1 (browser)：Web Speech API (SpeechRecognition / webkitSpeechRecognition) 持续监听 + 实时字幕
 * - 模式 2 (whisper)：麦克风 AudioContext RMS 语音活动检测 (VAD) + MediaRecorder 自动分段上传 /api/voice-listen/transcribe
 * - 支持自动降级 (auto)、单次直说 (bypassWakeWord)、实时音频电平可视化与 TTS 回复防回声保护。
 */

export type ClientVoiceEngine = "browser" | "whisper";
export type ClientVoiceMode = "idle" | "listening" | "awake" | "processing" | "speaking" | "error";

export interface ClientVoiceConfig {
  voiceEnabled: boolean;
  voiceEngine: "auto" | "browser" | "whisper";
  voiceLang: string;
  wakeWordEnabled: boolean;
  wakeWords: string[];
  wakeWindowSec: number;
  autoSpeakReply: boolean;
  continuousListen: boolean;
  vadThreshold: number;
  vadSilenceMs: number;
  effectiveSttConfigured: boolean;
}

export interface VoiceListenerClientCallbacks {
  onStatusChange: (status: {
    active: boolean;
    mode: ClientVoiceMode;
    engine: ClientVoiceEngine;
    interimTranscript: string;
    error: string | null;
    oneShot: boolean;
  }) => void;
  onLevelChange: (level: number) => void;
  onSyncServerState: (patch: {
    active?: boolean;
    mode?: ClientVoiceMode;
    engine?: ClientVoiceEngine;
    interimTranscript?: string;
    error?: string | null;
  }) => void;
  onTranscriptFinal: (text: string, options: { bypassWakeWord: boolean; engine: ClientVoiceEngine }) => Promise<void>;
  onUploadAudio: (blob: Blob, options: { bypassWakeWord: boolean; lang: string }) => Promise<void>;
  onToast: (message: string, durationMs?: number) => void;
}

interface SpeechRecognitionResultLike {
  isFinal: boolean;
  0: { transcript: string; confidence?: number };
}

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResultLike>;
}

interface SpeechRecognitionErrorEventLike {
  error: string;
  message?: string;
}

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  onstart: (() => void) | null;
  onresult: ((ev: SpeechRecognitionEventLike) => void) | null;
  onerror: ((ev: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function isBrowserSpeechSupported(): boolean {
  return getSpeechRecognitionCtor() !== null;
}

export function isMediaRecorderSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia) &&
    typeof MediaRecorder !== "undefined"
  );
}

export class VoiceListenerClient {
  private config: ClientVoiceConfig = {
    voiceEnabled: true,
    voiceEngine: "auto",
    voiceLang: "zh-CN",
    wakeWordEnabled: true,
    wakeWords: ["小派", "pi"],
    wakeWindowSec: 10,
    autoSpeakReply: true,
    continuousListen: true,
    vadThreshold: 0.025,
    vadSilenceMs: 1200,
    effectiveSttConfigured: false,
  };

  private active = false;
  private oneShot = false;
  private mode: ClientVoiceMode = "idle";
  private activeEngine: ClientVoiceEngine = "browser";
  private interimTranscript = "";
  private lastError: string | null = null;
  private speakingMuted = false;

  // Web Speech API state
  private recognition: SpeechRecognitionLike | null = null;
  private restartTimer: number | null = null;
  private consecutiveQuickEnds = 0;
  private lastStartAt = 0;

  // AudioContext + VAD / Level meter state
  private mediaStream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private levelRaf: number | null = null;
  private recorder: MediaRecorder | null = null;
  private recordedChunks: Blob[] = [];
  private vadSpeaking = false;
  private vadSpeechStartAt = 0;
  private vadLastLoudAt = 0;
  private uploading = false;

  constructor(private readonly cb: VoiceListenerClientCallbacks) {}

  isActive(): boolean {
    return this.active;
  }

  isOneShot(): boolean {
    return this.oneShot;
  }

  updateConfig(next: Partial<ClientVoiceConfig>): void {
    const prevLang = this.config.voiceLang;
    const prevEngine = this.config.voiceEngine;
    this.config = { ...this.config, ...next };
    if (this.active && (this.config.voiceLang !== prevLang || this.config.voiceEngine !== prevEngine)) {
      const wasOneShot = this.oneShot;
      this.stop(false);
      void this.start({ oneShot: wasOneShot });
    }
  }

  async toggle(): Promise<void> {
    if (this.active) {
      this.stop(true);
    } else {
      await this.start({ oneShot: false });
    }
  }

  async startOneShot(): Promise<void> {
    if (this.active && this.oneShot) {
      this.stop(true);
      return;
    }
    if (this.active) {
      this.stop(false);
    }
    await this.start({ oneShot: true });
  }

  async start(options: { oneShot?: boolean; forceEngine?: ClientVoiceEngine } = {}): Promise<void> {
    this.oneShot = Boolean(options.oneShot);
    this.lastError = null;
    this.interimTranscript = "";

    const engine = this.pickEngine(options.forceEngine);
    if (!engine) {
      const msg =
        "当前浏览器不支持原生语音识别且未开启麦克风权限/STT 转写服务，请使用 Chrome / Edge 浏览器或在设置中配置 STT 接口。";
      this.active = false;
      this.mode = "error";
      this.lastError = msg;
      this.emitState(true);
      this.cb.onToast(msg, 4500);
      return;
    }

    this.active = true;
    this.activeEngine = engine;
    this.mode = this.oneShot ? "awake" : "listening";
    this.emitState(true);

    if (engine === "whisper") {
      await this.startWhisperVad();
    } else {
      this.startBrowserSpeech();
      // 可选启用音量波形可视化（若失败不影响语音识别主流程）
      void this.startLevelMeterOnly();
    }
  }

  stop(notifyServer = true): void {
    this.active = false;
    this.oneShot = false;
    this.mode = "idle";
    this.interimTranscript = "";
    this.clearRestartTimer();
    this.stopRecognitionInstance();
    this.stopAudioCapture();
    this.cb.onLevelChange(0);
    this.emitState(notifyServer);
  }

  speak(text: string): void {
    const cleaned = text.trim();
    if (!cleaned || !this.config.autoSpeakReply) return;
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;

    try {
      window.speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(cleaned.slice(0, 220));
      utter.lang = this.config.voiceLang || "zh-CN";
      utter.rate = 1.06;

      this.speakingMuted = true;
      if (this.active) {
        this.mode = "speaking";
        this.emitState(true);
      }

      const done = () => {
        // 延迟 450ms 解除静音，防止扬声器尾音回录
        window.setTimeout(() => {
          this.speakingMuted = false;
          if (this.active && this.mode === "speaking") {
            this.mode = "listening";
            this.emitState(true);
          }
        }, 450);
      };
      utter.onend = done;
      utter.onerror = done;
      window.speechSynthesis.speak(utter);
    } catch {
      this.speakingMuted = false;
    }
  }

  private pickEngine(forced?: ClientVoiceEngine): ClientVoiceEngine | null {
    if (forced) return forced;
    const pref = this.config.voiceEngine;
    const hasSpeech = isBrowserSpeechSupported();
    const hasMedia = isMediaRecorderSupported();

    if (pref === "whisper") {
      return hasMedia ? "whisper" : hasSpeech ? "browser" : null;
    }
    if (pref === "browser") {
      return hasSpeech ? "browser" : hasMedia && this.config.effectiveSttConfigured ? "whisper" : null;
    }
    // auto：优先浏览器原生实时识别；不支持时若已配 STT 则切 whisper
    if (hasSpeech) return "browser";
    if (hasMedia && this.config.effectiveSttConfigured) return "whisper";
    return null;
  }

  private emitState(syncServer: boolean): void {
    this.cb.onStatusChange({
      active: this.active,
      mode: this.mode,
      engine: this.activeEngine,
      interimTranscript: this.interimTranscript,
      error: this.lastError,
      oneShot: this.oneShot,
    });
    if (syncServer) {
      this.cb.onSyncServerState({
        active: this.active,
        mode: this.mode,
        engine: this.activeEngine,
        interimTranscript: this.interimTranscript,
        error: this.lastError,
      });
    }
  }

  private clearRestartTimer(): void {
    if (this.restartTimer !== null) {
      window.clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  private stopRecognitionInstance(): void {
    const rec = this.recognition;
    this.recognition = null;
    if (!rec) return;
    rec.onstart = null;
    rec.onresult = null;
    rec.onerror = null;
    rec.onend = null;
    try {
      rec.abort();
    } catch {
      try {
        rec.stop();
      } catch {
        // ignore
      }
    }
  }

  private startBrowserSpeech(): void {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
      this.lastError = "当前浏览器不支持 Web Speech API";
      this.stop(true);
      return;
    }
    this.stopRecognitionInstance();

    const rec = new Ctor();
    rec.continuous = !this.oneShot && this.config.continuousListen;
    rec.interimResults = true;
    rec.lang = this.config.voiceLang || "zh-CN";
    rec.maxAlternatives = 1;
    this.recognition = rec;

    rec.onstart = () => {
      this.lastStartAt = Date.now();
      this.lastError = null;
      if (this.active && !this.speakingMuted) {
        this.mode = this.oneShot ? "awake" : "listening";
        this.emitState(true);
      }
    };

    rec.onresult = (ev) => {
      if (!this.active || this.speakingMuted) return;
      let interim = "";
      let finalText = "";
      for (let i = ev.resultIndex; i < ev.results.length; i += 1) {
        const res = ev.results[i];
        if (!res || !res[0]) continue;
        const transcript = String(res[0].transcript ?? "").trim();
        if (!transcript) continue;
        if (res.isFinal) {
          finalText += (finalText ? " " : "") + transcript;
        } else {
          interim += (interim ? " " : "") + transcript;
        }
      }

      if (interim) {
        this.interimTranscript = interim;
        this.emitState(false);
      }

      if (finalText) {
        this.interimTranscript = "";
        const bypass = this.oneShot;
        if (this.oneShot) {
          this.stop(true);
        } else {
          this.emitState(false);
        }
        void this.cb.onTranscriptFinal(finalText, {
          bypassWakeWord: bypass,
          engine: "browser",
        });
      }
    };

    rec.onerror = (ev) => {
      const code = ev.error || "unknown";
      if (code === "no-speech" || code === "aborted") {
        return;
      }
      if (code === "not-allowed" || code === "service-not-allowed") {
        this.lastError = "麦克风权限被拒绝，请在浏览器地址栏允许访问麦克风后重试。";
        this.active = false;
        this.mode = "error";
        this.stopAudioCapture();
        this.emitState(true);
        this.cb.onToast(this.lastError, 4500);
        return;
      }
      if (code === "audio-capture") {
        this.lastError = "未检测到可用麦克风设备，请检查系统录音输入设置。";
        this.active = false;
        this.mode = "error";
        this.stopAudioCapture();
        this.emitState(true);
        this.cb.onToast(this.lastError, 4500);
        return;
      }
      if (code === "network") {
        // 国内 Chrome 无法访问 Google 语音服务时：若已配置 STT 自动无缝切换到 Whisper VAD 模式
        if (this.config.voiceEngine === "auto" && this.config.effectiveSttConfigured && isMediaRecorderSupported()) {
          const wasOneShot = this.oneShot;
          this.cb.onToast("浏览器云端识别不可达，已自动切换至 Whisper VAD 录音转写模式", 3200);
          this.stopRecognitionInstance();
          this.activeEngine = "whisper";
          this.oneShot = wasOneShot;
          void this.startWhisperVad();
          return;
        }
        this.lastError =
          "浏览器在线语音识别网络不可达（建议使用 Edge 浏览器，或在「设置 → 语音与 Pi Agent」中配置 Whisper / SenseVoice 兼容 STT 接口）。";
        this.active = false;
        this.mode = "error";
        this.stopAudioCapture();
        this.emitState(true);
        this.cb.onToast(this.lastError, 5500);
        return;
      }

      this.lastError = `语音识别异常（${code}）`;
      this.emitState(true);
    };

    rec.onend = () => {
      if (!this.active) return;
      if (this.oneShot) {
        this.stop(true);
        return;
      }
      const livedMs = Date.now() - this.lastStartAt;
      if (livedMs < 800) {
        this.consecutiveQuickEnds += 1;
      } else {
        this.consecutiveQuickEnds = 0;
      }
      const delay = Math.min(3000, 260 + this.consecutiveQuickEnds * 350);
      this.clearRestartTimer();
      this.restartTimer = window.setTimeout(() => {
        this.restartTimer = null;
        if (this.active && this.activeEngine === "browser") {
          this.startBrowserSpeech();
        }
      }, delay);
    };

    try {
      rec.start();
    } catch {
      this.lastError = "无法启动浏览器语音识别，请稍后重试。";
      this.stop(true);
    }
  }

  private async startLevelMeterOnly(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia || this.mediaStream) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!this.active) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      this.mediaStream = stream;
      this.setupAnalyser(stream, false);
    } catch {
      // 波形可视化失败不影响浏览器 SpeechRecognition 正常工作
    }
  }

  private async startWhisperVad(): Promise<void> {
    if (!isMediaRecorderSupported()) {
      this.lastError = "当前浏览器不支持麦克风录音（MediaRecorder）。";
      this.active = false;
      this.mode = "error";
      this.emitState(true);
      return;
    }
    this.stopAudioCapture();

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!this.active) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      this.mediaStream = stream;
      this.lastError = null;
      this.mode = this.oneShot ? "awake" : "listening";
      this.emitState(true);
      this.setupAnalyser(stream, true);
    } catch {
      this.lastError = "无法获取麦克风权限，请在浏览器中允许录音权限。";
      this.active = false;
      this.mode = "error";
      this.emitState(true);
      this.cb.onToast(this.lastError, 4500);
    }
  }

  private setupAnalyser(stream: MediaStream, enableVad: boolean): void {
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;

    const ctx = new AudioCtx();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);

    this.audioCtx = ctx;
    this.analyser = analyser;
    const samples = new Float32Array(analyser.fftSize);

    const tick = () => {
      if (!this.active || !this.analyser) return;
      this.analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (let i = 0; i < samples.length; i += 1) {
        const s = samples[i]!;
        sum += s * s;
      }
      const rms = Math.sqrt(sum / samples.length);
      const level = Math.min(1, rms * 10);
      this.cb.onLevelChange(this.speakingMuted ? 0 : level);

      if (enableVad && !this.speakingMuted && !this.uploading) {
        const now = Date.now();
        if (rms >= this.config.vadThreshold) {
          this.vadLastLoudAt = now;
          if (!this.vadSpeaking) {
            this.beginVadSegment(stream);
          }
        } else if (this.vadSpeaking) {
          const silentMs = now - this.vadLastLoudAt;
          const totalMs = now - this.vadSpeechStartAt;
          if (silentMs >= this.config.vadSilenceMs || totalMs >= 15_000) {
            this.finishVadSegment();
          }
        }
      }

      this.levelRaf = window.requestAnimationFrame(tick);
    };

    this.levelRaf = window.requestAnimationFrame(tick);
  }

  private beginVadSegment(stream: MediaStream): void {
    this.vadSpeaking = true;
    this.vadSpeechStartAt = Date.now();
    this.vadLastLoudAt = this.vadSpeechStartAt;
    this.recordedChunks = [];
    this.interimTranscript = "正在录音…";
    this.emitState(false);

    try {
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/webm")
          ? "audio/webm"
          : "";
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      this.recorder = recorder;
      recorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) {
          this.recordedChunks.push(ev.data);
        }
      };
      recorder.onstop = () => {
        const chunks = this.recordedChunks;
        this.recordedChunks = [];
        this.recorder = null;
        if (chunks.length === 0) return;
        const blob = new Blob(chunks, { type: mimeType || "audio/webm" });
        if (blob.size < 1200) return;
        void this.dispatchVadBlob(blob);
      };
      recorder.start(250);
    } catch {
      this.vadSpeaking = false;
    }
  }

  private finishVadSegment(): void {
    this.vadSpeaking = false;
    if (this.recorder && this.recorder.state !== "inactive") {
      try {
        this.recorder.stop();
      } catch {
        // ignore
      }
    }
  }

  private async dispatchVadBlob(blob: Blob): Promise<void> {
    this.uploading = true;
    this.interimTranscript = "正在转写语音…";
    this.emitState(false);
    const bypass = this.oneShot;
    try {
      await this.cb.onUploadAudio(blob, {
        bypassWakeWord: bypass,
        lang: this.config.voiceLang || "zh-CN",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastError = msg;
      this.cb.onToast(`语音转写失败：${msg}`, 4000);
    } finally {
      this.uploading = false;
      this.interimTranscript = "";
      if (this.oneShot) {
        this.stop(true);
      } else {
        this.emitState(false);
      }
    }
  }

  private stopAudioCapture(): void {
    if (this.levelRaf !== null) {
      window.cancelAnimationFrame(this.levelRaf);
      this.levelRaf = null;
    }
    this.vadSpeaking = false;
    if (this.recorder && this.recorder.state !== "inactive") {
      try {
        this.recorder.stop();
      } catch {
        // ignore
      }
    }
    this.recorder = null;
    this.recordedChunks = [];

    if (this.audioCtx) {
      void this.audioCtx.close().catch(() => {});
      this.audioCtx = null;
    }
    this.analyser = null;

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((t) => t.stop());
      this.mediaStream = null;
    }
  }
}
