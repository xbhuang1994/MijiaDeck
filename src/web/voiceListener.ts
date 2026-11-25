// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * 浏览器端实时语音监听客户端（深度优化版）：
 * - 独立音频线程 AudioWorklet（切后台/最小化不中断）：WebRTC AEC/NS/AGC + 85Hz 高通滤波 +
 *   自适应环境底噪追踪 + 400ms Pre-roll 环形缓冲（绝不截断句首唤醒词）+ 16kHz Mono PCM WAV 直出
 * - 模式优先级（auto）：本地离线引擎（SenseVoice + GTCRN 降噪 + Silero VAD + 3D-Speaker 声纹）
 *   -> 云端 Whisper STT -> 浏览器 Web Speech API
 * - 语音交互体验优化：流式分句 TTS 播报队列、Watchdog 防静音卡死、语音打断（Barge-in）、一键 3 秒声纹录制。
 */

export type ClientVoiceEngine = "local" | "browser" | "whisper";
export type ClientVoiceMode = "idle" | "listening" | "awake" | "processing" | "speaking" | "error";

export interface ClientVoiceConfig {
  voiceEnabled: boolean;
  voiceEngine: "auto" | "local" | "browser" | "whisper";
  localAsrEngine?: "auto" | "qwen3-asr" | "sensevoice";
  qwen3ComputeDevice?: "auto" | "gpu" | "cpu";
  qwen3StreamingEnabled?: boolean;
  voiceLang: string;
  wakeWordEnabled: boolean;
  wakeWords: string[];
  wakeAckPhrase?: string;
  wakeWindowSec: number;
  autoSpeakReply: boolean;
  ttsEngine?: "auto" | "local" | "browser";
  ttsVoice?: "gentle-zh-en" | "warm-zh-baker";
  ttsSpeed?: number;
  continuousListen: boolean;
  vadThreshold: number;
  vadSilenceMs: number;
  noiseSuppressionMode?: "auto" | "neural" | "dpdfnet" | "voxlock" | "dsp" | "off";
  vadMode?: "silero" | "adaptive";
  voiceprintMode?: "off" | "tag" | "strict";
  voiceprintThreshold?: number;
  attentionMode?: "smart" | "strict" | "off";
  conversationWindowSec?: number;
  maxConsecutiveSidetalk?: number;
  bargeInEnabled?: boolean;
  systemOneMode?: "auto" | "on" | "off";
  systemOneBaseUrl?: string;
  systemOneModel?: string;
  systemOneTimeoutMs?: number;
  systemOneConfidenceThreshold?: number;
  cavemanMode?: "ultra" | "full" | "lite" | "off";
  owwEnabled?: boolean;
  owwThreshold?: number;
  effectiveSttConfigured: boolean;
  localAsrReady?: boolean;
  localTtsReady?: boolean;
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
  onUploadAudio: (
    blob: Blob,
    options: { bypassWakeWord: boolean; lang: string; engine: "local" | "whisper"; filename: string },
  ) => Promise<void>;
  isVoiceStreamReady?: () => boolean;
  sendVoiceStreamControl?: (msg: Record<string, unknown>) => boolean;
  sendVoiceStreamPcm?: (buffer: ArrayBuffer) => boolean;
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

export function isMicrophoneAudioSupported(): boolean {
  return typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia);
}

const TTS_MAX_CHARS = 90;
const TTS_TRUNCATE_SUFFIX = "，详情见面板";

/**
 * 将 Pi Agent 回复净化为适合浏览器语音播报的简短口语文本：
 * - 去除 Markdown 标记（** / * / ` / #）、直角引号「」与 [did=...] 标识符
 * - 将 °C / ℃ 转为更自然的“度”
 * - 合并换行为中文逗号
 * - 超出约 90 字时优先在标点边界截断并附加“，详情见面板”
 */
export function sanitizeBrowserTts(text: string): string {
  const cleaned = String(text ?? "")
    .replace(/\[did=[^\]]*\]/gi, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```[^\n]*\n?|```/g, ""))
    .replace(/^\s*[-•]\s+/gm, "")
    .replace(/\*\*|\*|`|[「」]|#+/g, "")
    .replace(/°\s*[Cc]|℃/g, "度")
    .replace(/\r?\n+/g, "，")
    .replace(/\s+/g, " ")
    .replace(/([。！？；，,.!?;、])\s*，+/g, "$1")
    .replace(/，{2,}/g, "，")
    .replace(/^[，,\s]+|[，,\s]+$/g, "")
    .trim();

  if (!cleaned) return "";
  if (cleaned.length <= TTS_MAX_CHARS) return cleaned;

  const head = cleaned.slice(0, TTS_MAX_CHARS);
  const punctRe = /[。！？；，,.!?;、]/g;
  let cutIdx = -1;
  let match: RegExpExecArray | null;
  while ((match = punctRe.exec(head)) !== null) {
    cutIdx = match.index;
  }

  let base: string;
  if (cutIdx >= 24) {
    base = head.slice(0, cutIdx);
  } else {
    const spaceIdx = head.lastIndexOf(" ");
    base = spaceIdx >= 60 ? head.slice(0, spaceIdx) : head.slice(0, TTS_MAX_CHARS - 4);
  }
  base = base.replace(/[。！？；，,.!?;、\s]+$/g, "").trim();
  return base ? `${base}${TTS_TRUNCATE_SUFFIX}` : cleaned.slice(0, TTS_MAX_CHARS);
}

/**
 * 从浏览器 SpeechSynthesis 音色列表中优先挑选温柔女声（兜底引擎使用，避开生硬男声与默认机械音）。
 */
export function pickGentleBrowserVoice(
  voices: ReadonlyArray<SpeechSynthesisVoice>,
  lang = "zh-CN",
): SpeechSynthesisVoice | null {
  if (!voices || voices.length === 0) return null;
  const targetLang = (lang || "zh-CN").toLowerCase();
  const langPrefix = targetLang.split("-")[0] || "zh";

  let best: SpeechSynthesisVoice | null = null;
  let bestScore = -Infinity;

  for (const v of voices) {
    const name = `${v.name || ""} ${v.voiceURI || ""}`.toLowerCase();
    const vLang = (v.lang || "").toLowerCase();
    let score = 0;

    if (vLang === targetLang) score += 40;
    else if (vLang.startsWith(langPrefix)) score += 28;
    else if (langPrefix === "zh" && vLang.startsWith("zh")) score += 22;
    else score -= 30;

    if (/xiaoxiao|晓晓/.test(name)) score += 120;
    else if (/xiaoyi|晓伊|xiaohan|晓涵|xiaorou|晓柔|xiaochen|晓辰/.test(name)) score += 115;
    else if (/hsiaochen|hsiaoyu|hiumaan|hiugaai|晓臻|晓雨/.test(name)) score += 108;
    else if (/google.*普通话|google.*chinese|tingting|meijia|sinji|yaoyao|瑶瑶/.test(name)) score += 92;
    else if (/natural|neural|online/.test(name)) score += 75;
    else if (/huihui|慧慧|female|woman|女/.test(name)) score += 45;

    if (/kangkang|康康|yunxi|云希|yunjian|云健|yunyang|云扬|yunze|云泽|yunjie|david|mark|george|\bmale\b|男/.test(name)) {
      score -= 120;
    }

    if (score > bestScore) {
      bestScore = score;
      best = v;
    }
  }
  return bestScore > -10 ? best : null;
}

/**
 * 将浏览器 16kHz Mono Float32Array 编码为标准 16-bit PCM WAV Blob（零外部依赖）。
 */
export function encodeFloat32ToWavBlob(samples: Float32Array, sampleRate = 16000): Blob {
  const numSamples = samples.length;
  const dataBytes = numSamples * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  const writeStr = (off: number, str: string) => {
    for (let i = 0; i < str.length; i += 1) {
      view.setUint8(off + i, str.charCodeAt(i));
    }
  };

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, dataBytes, true);

  let off = 44;
  for (let i = 0; i < numSamples; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(off, s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), true);
    off += 2;
  }
  return new Blob([buffer], { type: "audio/wav" });
}

/**
 * 独立音频线程 AudioWorkletProcessor 源码：
 * 1. 85Hz 一阶高通滤波去除直流偏移与交流电低频嗡声
 * 2. 实时下采样至 16kHz Mono PCM
 * 3. 自适应噪声底噪追踪（在风扇/空调等稳定噪声下不持续误触发）
 * 4. 400ms Pre-roll 环形缓冲（说话前 400ms 自动拼接到句首，绝不切掉唤醒词首字）
 * 5. 切后台/最小化窗口依然稳定运行
 */
const VOICE_WORKLET_CODE = `
class MijiaVoiceProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.targetRate = 16000;
    this.ratio = sampleRate / this.targetRate;
    this.phase = 0;

    // 85Hz 一阶高通滤波器状态
    const rc = 1 / (2 * Math.PI * 85);
    const dt = 1 / sampleRate;
    this.hpAlpha = rc / (rc + dt);
    this.hpPrevX = 0;
    this.hpPrevY = 0;

    // 400ms 16kHz pre-roll 环形缓冲 (6400 samples)
    this.preRollCapacity = Math.round(this.targetRate * 0.4);
    this.preRoll = new Float32Array(this.preRollCapacity);
    this.preRollWrite = 0;
    this.preRollFilled = 0;

    // 连续实时流模式：每 64ms (1024 samples = 2x512 Silero VAD 窗口) 将 16kHz Int16 PCM 推给服务端在线降噪 + Silero VAD
    // 相比 128ms 帧减半首包等待，同时彻底避免强噪/背景音乐下浏览器 RMS 门限失效或长时卡顿！
    this.streamMode = Boolean(opts.streamMode);
    this.streamFrameSize = 1024;
    this.streamBuf = new Int16Array(this.streamFrameSize);
    this.streamPos = 0;

    // 兜底 HTTP 模式下的自适应噪声底噪 + VAD 状态
    this.vadThreshold = Number(opts.vadThreshold) || 0.018;
    this.vadSilenceMs = Number(opts.vadSilenceMs) || 600;
    this.noiseFloor = 0.006;
    this.speaking = false;
    this.speechChunks = [];
    this.speechSampleCount = 0;
    this.silentSamples = 0;
    this.loudFrames = 0;
    this.maxSpeechSamples = this.targetRate * 5;
    this.minSpeechSamples = Math.round(this.targetRate * 0.22);

    this.paused = false;
    this.levelAccumSq = 0;
    this.levelAccumN = 0;

    this.port.onmessage = (ev) => {
      const msg = ev.data || {};
      if (msg.type === "config") {
        if (typeof msg.vadThreshold === "number") this.vadThreshold = msg.vadThreshold;
        if (typeof msg.vadSilenceMs === "number") this.vadSilenceMs = msg.vadSilenceMs;
        if (typeof msg.streamMode === "boolean") this.streamMode = msg.streamMode;
      } else if (msg.type === "pause") {
        this.paused = Boolean(msg.paused);
        if (this.paused) {
          this.speaking = false;
          this.speechChunks = [];
          this.speechSampleCount = 0;
          this.silentSamples = 0;
          this.loudFrames = 0;
          this.streamPos = 0;
        }
      } else if (msg.type === "flush") {
        this.finishUtterance();
      }
    };
  }

  pushPreRoll(buf) {
    for (let i = 0; i < buf.length; i += 1) {
      this.preRoll[this.preRollWrite] = buf[i];
      this.preRollWrite = (this.preRollWrite + 1) % this.preRollCapacity;
      if (this.preRollFilled < this.preRollCapacity) this.preRollFilled += 1;
    }
  }

  drainPreRoll() {
    const out = new Float32Array(this.preRollFilled);
    const start = (this.preRollWrite - this.preRollFilled + this.preRollCapacity) % this.preRollCapacity;
    for (let i = 0; i < this.preRollFilled; i += 1) {
      out[i] = this.preRoll[(start + i) % this.preRollCapacity];
    }
    return out;
  }

  finishUtterance() {
    if (!this.speaking) return;
    this.speaking = false;
    this.silentSamples = 0;
    this.loudFrames = 0;
    const total = this.speechSampleCount;
    const chunks = this.speechChunks;
    this.speechChunks = [];
    this.speechSampleCount = 0;
    if (total < this.minSpeechSamples) {
      this.port.postMessage({ type: "speech_cancel" });
      return;
    }
    const merged = new Float32Array(total);
    let offset = 0;
    for (let i = 0; i < chunks.length; i += 1) {
      merged.set(chunks[i], offset);
      offset += chunks[i].length;
    }
    this.port.postMessage({ type: "utterance", samples: merged, sampleRate: this.targetRate }, [merged.buffer]);
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0] || input[0].length === 0) return true;
    const channel = input[0];

    // 1. 高通滤波 + 实时抗混叠下采样到 16kHz
    const outList = [];
    let phase = this.phase;
    let sumSq16 = 0;
    let zcrCount = 0;
    let prev16 = 0;

    for (let i = 0; i < channel.length; i += 1) {
      const x = channel[i];
      const y = this.hpAlpha * (this.hpPrevY + x - this.hpPrevX);
      this.hpPrevX = x;
      this.hpPrevY = y;

      phase += 1;
      if (phase >= this.ratio) {
        phase -= this.ratio;
        const clamped = y > 1 ? 1 : y < -1 ? -1 : y;
        outList.push(clamped);
        sumSq16 += clamped * clamped;
        if (outList.length > 1 && ((clamped >= 0 && prev16 < 0) || (clamped < 0 && prev16 >= 0))) {
          zcrCount += 1;
        }
        prev16 = clamped;
      }
    }
    this.phase = phase;
    if (outList.length === 0) return true;

    const pcm16 = Float32Array.from(outList);
    const rms = Math.sqrt(sumSq16 / pcm16.length);
    const zcr = zcrCount / pcm16.length;

    // 定期上报电平（约每 40ms 一次，降低主线程消息负载）
    this.levelAccumSq += sumSq16;
    this.levelAccumN += pcm16.length;
    if (this.levelAccumN >= 640) {
      const avgRms = Math.sqrt(this.levelAccumSq / this.levelAccumN);
      this.port.postMessage({
        type: "level",
        rms: avgRms,
        noiseFloor: this.noiseFloor,
        speaking: this.speaking,
      });
      this.levelAccumSq = 0;
      this.levelAccumN = 0;
    }

    // 自适应噪声底噪慢速跟踪（未说话时向环境底噪收敛）
    const adaptiveThresh = Math.max(this.vadThreshold, this.noiseFloor * 2.55);
    const isVoiceLike = rms >= adaptiveThresh && zcr >= 0.01 && zcr <= 0.48;

    if (this.paused) {
      // 播报期间检测高能量人声以支持语音打断（Barge-in）
      if (rms >= Math.max(this.vadThreshold * 2.6, this.noiseFloor * 4.2) && zcr >= 0.02 && zcr <= 0.42) {
        this.loudFrames += 1;
        if (this.loudFrames >= 6) {
          this.loudFrames = 0;
          this.port.postMessage({ type: "barge_in", rms });
        }
      } else {
        this.loudFrames = Math.max(0, this.loudFrames - 1);
      }
      this.pushPreRoll(pcm16);
      return true;
    }

    // 连续实时流模式：绕过粗糙浏览器能量门限，直接持续将 16kHz Int16 PCM 推给服务端在线神经降噪 + Silero VAD
    if (this.streamMode) {
      for (let i = 0; i < pcm16.length; i += 1) {
        const s = pcm16[i];
        this.streamBuf[this.streamPos] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
        this.streamPos += 1;
        if (this.streamPos >= this.streamFrameSize) {
          const out = this.streamBuf;
          this.streamBuf = new Int16Array(this.streamFrameSize);
          this.streamPos = 0;
          this.port.postMessage({ type: "pcm_frame", buffer: out.buffer }, [out.buffer]);
        }
      }
      return true;
    }

    if (!this.speaking) {
      // 限制 noiseFloor 上限（0.030），避免背景音乐把阈值拉高到 0.20 导致真人语音无法触发
      const rate = rms < this.noiseFloor ? 0.05 : 0.008;
      this.noiseFloor = Math.max(0.002, Math.min(0.03, this.noiseFloor * (1 - rate) + rms * rate));
      this.pushPreRoll(pcm16);

      if (isVoiceLike) {
        this.loudFrames += 1;
        // 连续 ~32ms（约 4~6 帧）超过动态门限即判定开声，过滤瞬态键盘敲击
        if (this.loudFrames >= 4) {
          this.speaking = true;
          this.silentSamples = 0;
          const pre = this.drainPreRoll();
          this.speechChunks = [pre, pcm16];
          this.speechSampleCount = pre.length + pcm16.length;
          this.port.postMessage({ type: "speech_start" });
        }
      } else {
        this.loudFrames = 0;
      }
    } else {
      this.speechChunks.push(pcm16);
      this.speechSampleCount += pcm16.length;
      const continueThresh = Math.max(this.vadThreshold * 0.72, this.noiseFloor * 1.85);
      if (rms >= continueThresh) {
        this.silentSamples = 0;
      } else {
        this.silentSamples += pcm16.length;
      }

      const maxSilenceSamples = Math.round((this.vadSilenceMs / 1000) * this.targetRate);
      if (this.silentSamples >= maxSilenceSamples || this.speechSampleCount >= this.maxSpeechSamples) {
        this.finishUtterance();
      }
    }

    return true;
  }
}
registerProcessor("mijia-voice-processor", MijiaVoiceProcessor);
`;

/**
 * 一次性录制指定时长（默认 3 秒）的 16kHz Mono PCM WAV，用于声纹注册与声纹验证测试。
 */
export async function recordShortWavSample(
  durationMs = 3000,
  onProgress?: (ratio: number, level: number) => void,
  stopSignal?: AbortSignal,
): Promise<Blob> {
  if (!isMicrophoneAudioSupported()) {
    throw new Error("当前浏览器不支持麦克风录音");
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
  });
  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtx) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error("当前浏览器不支持 Web Audio API");
  }

  const ctx = new AudioCtx();
  const source = ctx.createMediaStreamSource(stream);
  const chunks: Float32Array[] = [];
  const startAt = Date.now();
  const nativeRate = ctx.sampleRate;

  // 优先用 ScriptProcessor/Analyser 兼容采集 3s 样本（短时录音，简单零兼容风险）
  const proc = ctx.createScriptProcessor(2048, 1, 1);
  const silentGain = ctx.createGain();
  silentGain.gain.value = 0;

  try {
    await new Promise<void>((resolve) => {
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        stopSignal?.removeEventListener("abort", done);
        resolve();
      };
      if (stopSignal?.aborted) {
        done();
        return;
      }
      stopSignal?.addEventListener("abort", done, { once: true });
      proc.onaudioprocess = (ev) => {
        if (finished) return;
        const data = ev.inputBuffer.getChannelData(0);
        const copy = new Float32Array(data.length);
        let sum = 0;
        for (let i = 0; i < data.length; i += 1) {
          const s = data[i]!;
          copy[i] = s;
          sum += s * s;
        }
        chunks.push(copy);
        const rms = Math.sqrt(sum / Math.max(1, data.length));
        const elapsed = Date.now() - startAt;
        onProgress?.(Math.min(1, elapsed / durationMs), Math.min(1, rms * 10));
        if (elapsed >= durationMs) {
          done();
        }
      };
      source.connect(proc);
      proc.connect(silentGain);
      silentGain.connect(ctx.destination);
    });
  } finally {
    try {
      proc.disconnect();
      source.disconnect();
      silentGain.disconnect();
    } catch {
      // ignore
    }
    void ctx.close().catch(() => {});
    stream.getTracks().forEach((t) => t.stop());
  }

  const totalLen = chunks.reduce((acc, c) => acc + c.length, 0);
  const raw = new Float32Array(totalLen);
  let offset = 0;
  for (const c of chunks) {
    raw.set(c, offset);
    offset += c.length;
  }

  // 下采样到 16kHz Mono PCM WAV
  const targetRate = 16000;
  const ratio = nativeRate / targetRate;
  const outLen = Math.max(1, Math.round(raw.length / ratio));
  const pcm16 = new Float32Array(outLen);
  for (let i = 0; i < outLen; i += 1) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = raw[Math.min(idx, raw.length - 1)] ?? 0;
    const b = raw[Math.min(idx + 1, raw.length - 1)] ?? a;
    pcm16[i] = a + (b - a) * frac;
  }
  return encodeFloat32ToWavBlob(pcm16, targetRate);
}

interface TtsQueueItem {
  text: string;
  engine: "auto" | "local" | "browser";
  voice: "gentle-zh-en" | "warm-zh-baker";
  speed: number;
  abort?: AbortController;
  audioPromise?: Promise<Blob | null>;
}

export class VoiceListenerClient {
  private config: ClientVoiceConfig = {
    voiceEnabled: true,
    voiceEngine: "auto",
    voiceLang: "zh-CN",
    wakeWordEnabled: true,
    wakeWords: ["小派", "pi"],
    wakeAckPhrase: "嗯?",
    wakeWindowSec: 12,
    autoSpeakReply: true,
    ttsEngine: "auto",
    ttsVoice: "gentle-zh-en",
    ttsSpeed: 0.98,
    continuousListen: true,
    vadThreshold: 0.018,
    vadSilenceMs: 750,
    noiseSuppressionMode: "auto",
    vadMode: "silero",
    voiceprintMode: "tag",
    voiceprintThreshold: 0.42,
    attentionMode: "smart",
    conversationWindowSec: 25,
    maxConsecutiveSidetalk: 3,
    bargeInEnabled: true,
    effectiveSttConfigured: false,
    localAsrReady: false,
    localTtsReady: undefined,
  };

  private active = false;
  private oneShot = false;
  private mode: ClientVoiceMode = "idle";
  private activeEngine: ClientVoiceEngine = "local";
  private interimTranscript = "";
  private lastError: string | null = null;
  private speakingMuted = false;

  // Streaming Neural TTS Queue + Prefetch + Watchdog（优先本地温柔女声，自动平滑降级浏览器女声）
  private ttsQueue: TtsQueueItem[] = [];
  private ttsSpeaking = false;
  private ttsNotifiedSpeaking = false;
  private ttsSessionGen = 0;
  private activeAudioEl: HTMLAudioElement | null = null;
  private activeAudioUrl: string | null = null;
  private activeTtsAbort: AbortController | null = null;
  private ttsWatchdogTimer: number | null = null;
  private ttsReleaseTimer: number | null = null;

  // Web Speech API state
  private recognition: SpeechRecognitionLike | null = null;
  private restartTimer: number | null = null;
  private consecutiveQuickEnds = 0;
  private lastStartAt = 0;

  // AudioContext + AudioWorklet PCM Pipeline state
  private mediaStream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private workletBlobUrl: string | null = null;
  private fallbackProcessor: ScriptProcessorNode | null = null;
  private silentGain: GainNode | null = null;
  private streamingOverWs = false;
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

    // 动态热更新 AudioWorklet 参数（无需重启麦克风）
    if (this.workletNode) {
      this.workletNode.port.postMessage({
        type: "config",
        vadThreshold: this.config.vadThreshold,
        vadSilenceMs: this.config.vadSilenceMs,
      });
    }

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
        "当前浏览器无法访问麦克风且不支持在线语音识别，请允许麦克风权限并启用本地离线 Qwen3-ASR / SenseVoice 引擎或配置 STT 接口。";
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

    if (engine === "local" || engine === "whisper") {
      await this.startPcmAudioPipeline(engine);
    } else {
      this.startBrowserSpeech();
    }
  }

  stop(notifyServer = true): void {
    if (this.streamingOverWs) {
      this.cb.sendVoiceStreamControl?.({ type: "voice_stream_stop" });
      this.streamingOverWs = false;
    }
    this.active = false;
    this.oneShot = false;
    this.mode = "idle";
    this.interimTranscript = "";
    this.cancelSpeaking();
    this.clearRestartTimer();
    this.stopRecognitionInstance();
    this.stopAudioCapture();
    this.cb.onLevelChange(0);
    this.emitState(notifyServer);
  }

  /**
   * 接收服务端 WebSocket 实时语音流回执（语音开始/结束/唤醒命中/识别结果）。
   */
  handleStreamServerEvent(ev: {
    kind?: string;
    text?: string;
    matched?: boolean;
    wakeWord?: string;
    score?: number;
    threshold?: number;
    source?: string;
  }): void {
    if (!this.active) return;
    if (ev.kind === "wake_spot") {
      const word = typeof ev.wakeWord === "string" && ev.wakeWord.trim() ? ev.wakeWord.trim() : "";
      this.interimTranscript = word ? `⚡ 命中「${word}」` : "⚡ 已唤醒";
      this.emitState(false);
      return;
    }
    if (!this.streamingOverWs) return;
    if (ev.kind === "speech_start") {
      this.interimTranscript = "收音中…";
      this.emitState(false);
    } else if (ev.kind === "partial") {
      const partialText = typeof ev.text === "string" ? ev.text.trim() : "";
      if (partialText) {
        this.interimTranscript = partialText;
        this.emitState(false);
      }
    } else if (ev.kind === "speech_end") {
      if (!this.interimTranscript || this.interimTranscript === "收音中…") {
        this.interimTranscript = "识别中…";
      }
      this.emitState(false);
    } else if (ev.kind === "result") {
      this.interimTranscript = "";
      if (this.oneShot && (ev.text || ev.matched)) {
        this.stop(true);
      } else {
        this.emitState(false);
      }
    }
  }

  private cleanupActiveAudio(): void {
    if (this.activeTtsAbort) {
      try {
        this.activeTtsAbort.abort();
      } catch {
        // ignore
      }
      this.activeTtsAbort = null;
    }
    if (this.activeAudioEl) {
      try {
        this.activeAudioEl.onended = null;
        this.activeAudioEl.onerror = null;
        this.activeAudioEl.pause();
        this.activeAudioEl.src = "";
      } catch {
        // ignore
      }
      this.activeAudioEl = null;
    }
    if (this.activeAudioUrl) {
      try {
        URL.revokeObjectURL(this.activeAudioUrl);
      } catch {
        // ignore
      }
      this.activeAudioUrl = null;
    }
  }

  /**
   * 立即打断当前语音播报（Barge-in），让用户随时插话下达新指令。
   */
  cancelSpeaking(): void {
    this.ttsSessionGen += 1;
    for (const item of this.ttsQueue) {
      try {
        item.abort?.abort();
      } catch {
        // ignore
      }
    }
    this.ttsQueue = [];
    this.ttsSpeaking = false;
    this.speakingMuted = false;
    if (this.ttsWatchdogTimer !== null) {
      window.clearTimeout(this.ttsWatchdogTimer);
      this.ttsWatchdogTimer = null;
    }
    if (this.ttsReleaseTimer !== null) {
      window.clearTimeout(this.ttsReleaseTimer);
      this.ttsReleaseTimer = null;
    }
    this.cleanupActiveAudio();
    try {
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
    } catch {
      // ignore
    }
    this.workletNode?.port.postMessage({ type: "pause", paused: false });
    if (this.ttsNotifiedSpeaking) {
      this.ttsNotifiedSpeaking = false;
      this.cb.sendVoiceStreamControl?.({ type: "voice_tts_state", speaking: false });
    }
    if (this.active && this.mode === "speaking") {
      this.mode = "listening";
      this.emitState(false);
    }
  }

  private buildTtsQueueItem(
    cleaned: string,
    overrides?: {
      ttsEngine?: "auto" | "local" | "browser";
      ttsVoice?: "gentle-zh-en" | "warm-zh-baker";
      ttsSpeed?: number;
    },
  ): TtsQueueItem {
    const engine = overrides?.ttsEngine ?? this.config.ttsEngine ?? "auto";
    const voice = overrides?.ttsVoice ?? this.config.ttsVoice ?? "gentle-zh-en";
    const speedRaw = overrides?.ttsSpeed ?? this.config.ttsSpeed ?? 0.98;
    const speed = Number.isFinite(speedRaw) ? Math.min(1.4, Math.max(0.7, speedRaw)) : 0.98;

    const item: TtsQueueItem = { text: cleaned, engine, voice, speed };
    const shouldTryLocal =
      engine === "local" || (engine === "auto" && this.config.localTtsReady !== false);

    if (shouldTryLocal && typeof fetch === "function") {
      const abort = new AbortController();
      item.abort = abort;
      item.audioPromise = this.fetchLocalTtsWav(cleaned, voice, speed, abort.signal);
    }
    return item;
  }

  private async fetchLocalTtsWav(
    text: string,
    voice: "gentle-zh-en" | "warm-zh-baker",
    speed: number,
    signal: AbortSignal,
  ): Promise<Blob | null> {
    const timeoutId = window.setTimeout(() => {
      try {
        // 超时保护避免极端情况下卡住播报管线
        if (!signal.aborted && this.activeTtsAbort?.signal === signal) {
          this.activeTtsAbort.abort();
        }
      } catch {
        // ignore
      }
    }, 6000);
    try {
      const res = await fetch("/api/voice/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, voice, speed }),
        signal,
      });
      if (!res.ok) {
        if (res.status === 503) {
          this.config.localTtsReady = false;
        }
        return null;
      }
      this.config.localTtsReady = true;
      const blob = await res.blob();
      return blob.size > 44 ? blob : null;
    } catch {
      return null;
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  /**
   * 整句播报（兼容旧事件）。
   */
  speak(text: string): void {
    const cleaned = sanitizeBrowserTts(text);
    if (!cleaned || !this.config.autoSpeakReply) return;
    if (typeof window === "undefined") return;
    this.cancelSpeaking();
    this.ttsQueue.push(this.buildTtsQueueItem(cleaned));
    void this.pumpTtsQueue();
  }

  /**
   * 试听当前选择的温柔女声配置（忽略 autoSpeakReply 开关，供设置弹窗即时试听）。
   */
  previewVoice(
    text: string,
    overrides?: {
      ttsEngine?: "auto" | "local" | "browser";
      ttsVoice?: "gentle-zh-en" | "warm-zh-baker";
      ttsSpeed?: number;
    },
  ): void {
    const cleaned = sanitizeBrowserTts(text) || "嗯？客厅吸顶灯已开，亮度调至百分之八十。";
    if (typeof window === "undefined") return;
    this.cancelSpeaking();
    this.ttsQueue.push(this.buildTtsQueueItem(cleaned, overrides));
    void this.pumpTtsQueue();
  }

  /**
   * 流式分句播报：收到 Pi Agent 首句即刻预取并朗读，大幅降低首字语音延迟（TTFA）。
   */
  enqueueSpeakChunk(text: string): void {
    const cleaned = sanitizeBrowserTts(text);
    if (!cleaned || !this.config.autoSpeakReply) return;
    if (typeof window === "undefined") return;
    if (this.ttsReleaseTimer !== null) {
      window.clearTimeout(this.ttsReleaseTimer);
      this.ttsReleaseTimer = null;
    }
    this.ttsQueue.push(this.buildTtsQueueItem(cleaned));
    if (!this.ttsSpeaking) {
      void this.pumpTtsQueue();
    }
  }

  private async pumpTtsQueue(): Promise<void> {
    if (this.ttsSpeaking) return;
    const next = this.ttsQueue.shift();
    if (!next) {
      // 所有分段播报结束：延迟 320ms 解除防回声静音，并通过 voice_tts_state 恢复服务端计时（不覆盖 dialogState）
      this.ttsReleaseTimer = window.setTimeout(() => {
        this.ttsReleaseTimer = null;
        this.speakingMuted = false;
        this.workletNode?.port.postMessage({ type: "pause", paused: false });
        if (this.ttsNotifiedSpeaking) {
          this.ttsNotifiedSpeaking = false;
          this.cb.sendVoiceStreamControl?.({ type: "voice_tts_state", speaking: false });
        }
        if (this.active && this.mode === "speaking") {
          this.mode = "listening";
          this.emitState(false);
        }
      }, 320);
      return;
    }

    const gen = this.ttsSessionGen;
    this.ttsSpeaking = true;
    this.speakingMuted = true;
    this.workletNode?.port.postMessage({ type: "pause", paused: true });
    if (!this.ttsNotifiedSpeaking) {
      this.ttsNotifiedSpeaking = true;
      this.cb.sendVoiceStreamControl?.({ type: "voice_tts_state", speaking: true });
    }
    if (this.active && this.mode !== "speaking") {
      this.mode = "speaking";
      this.emitState(false);
    }

    let settled = false;
    const finishChunk = () => {
      if (settled || gen !== this.ttsSessionGen) return;
      settled = true;
      if (this.ttsWatchdogTimer !== null) {
        window.clearTimeout(this.ttsWatchdogTimer);
        this.ttsWatchdogTimer = null;
      }
      this.cleanupActiveAudio();
      this.ttsSpeaking = false;
      void this.pumpTtsQueue();
    };

    try {
      // 1. 优先播放服务端本地 Matcha 温柔女声 WAV（已预取，流式多句近乎零停顿）
      if (next.audioPromise) {
        this.activeTtsAbort = next.abort ?? null;
        const wavBlob = await next.audioPromise;
        if (gen !== this.ttsSessionGen) return;
        if (wavBlob) {
          const played = await this.playWavBlob(wavBlob, next.text.length, gen, finishChunk);
          if (played) {
            return;
          }
          if (gen !== this.ttsSessionGen) return;
        }
      }

      // 2. 自动兜底：使用浏览器 SpeechSynthesis 并优先选择温柔女声（如 Xiaoxiao / Xiaoyi / Tingting）
      if ("speechSynthesis" in window) {
        this.speakWithBrowserVoice(next.text, next.speed, finishChunk);
        return;
      }

      finishChunk();
    } catch {
      finishChunk();
    }
  }

  private playWavBlob(
    wavBlob: Blob,
    textLen: number,
    gen: number,
    finishChunk: () => void,
  ): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      if (gen !== this.ttsSessionGen || typeof Audio === "undefined") {
        resolve(false);
        return;
      }
      try {
        const url = URL.createObjectURL(wavBlob);
        const audio = new Audio(url);
        audio.preload = "auto";
        this.activeAudioUrl = url;
        this.activeAudioEl = audio;

        const estMs = Math.max(5000, Math.min(25_000, textLen * 320 + 3500));
        this.ttsWatchdogTimer = window.setTimeout(finishChunk, estMs);

        audio.onended = finishChunk;
        audio.onerror = finishChunk;

        const playPromise = audio.play();
        if (playPromise && typeof playPromise.then === "function") {
          playPromise
            .then(() => {
              resolve(true);
            })
            .catch(() => {
              if (this.ttsWatchdogTimer !== null) {
                window.clearTimeout(this.ttsWatchdogTimer);
                this.ttsWatchdogTimer = null;
              }
              this.cleanupActiveAudio();
              resolve(false);
            });
        } else {
          resolve(true);
        }
      } catch {
        this.cleanupActiveAudio();
        resolve(false);
      }
    });
  }

  private speakWithBrowserVoice(text: string, speed: number, finishChunk: () => void): void {
    const utter = new SpeechSynthesisUtterance(text);
    const lang = this.config.voiceLang || "zh-CN";
    utter.lang = lang;
    utter.rate = Math.min(1.18, Math.max(0.82, speed));
    utter.pitch = 1.04;
    try {
      const voices = window.speechSynthesis.getVoices();
      const gentle = pickGentleBrowserVoice(voices, lang);
      if (gentle) {
        utter.voice = gentle;
      }
    } catch {
      // ignore
    }

    // Watchdog 防止 Chrome/Edge 偶发丢失 onend 导致麦克风永久静音卡死
    const estMs = Math.max(4500, Math.min(18_000, text.length * 280 + 2800));
    this.ttsWatchdogTimer = window.setTimeout(finishChunk, estMs);
    utter.onend = finishChunk;
    utter.onerror = finishChunk;
    window.speechSynthesis.speak(utter);
  }

  private pickEngine(forced?: ClientVoiceEngine): ClientVoiceEngine | null {
    if (forced) return forced;
    const pref = this.config.voiceEngine;
    const hasMic = isMicrophoneAudioSupported();
    const hasSpeech = isBrowserSpeechSupported();
    const localReady = Boolean(this.config.localAsrReady);

    if (pref === "local") {
      return hasMic ? "local" : hasSpeech ? "browser" : null;
    }
    if (pref === "whisper") {
      return hasMic ? "whisper" : hasSpeech ? "browser" : null;
    }
    if (pref === "browser") {
      return hasSpeech
        ? "browser"
        : hasMic && localReady
          ? "local"
          : hasMic && this.config.effectiveSttConfigured
            ? "whisper"
            : null;
    }

    // auto（深度优化后）：
    // 1. 优先本地离线 SenseVoice + GTCRN 降噪 + Silero VAD + 声纹（国内零网络报错、高准确率、全链路声学增强）
    // 2. 其次云端 Whisper STT（同样走 AudioWorklet 16kHz PCM + GTCRN 降噪）
    // 3. 兜底浏览器原生 Web Speech API
    if (hasMic && localReady) return "local";
    if (hasMic && this.config.effectiveSttConfigured) return "whisper";
    if (hasSpeech) return "browser";
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
        if (isMicrophoneAudioSupported() && (this.config.localAsrReady || this.config.effectiveSttConfigured)) {
          const fallbackEngine: "local" | "whisper" = this.config.localAsrReady ? "local" : "whisper";
          const wasOneShot = this.oneShot;
          this.cb.onToast(
            fallbackEngine === "local"
              ? "浏览器在线识别不可达，已自动切换至本地离线 Qwen3-ASR / SenseVoice 引擎"
              : "浏览器在线识别不可达，已自动切换至 Whisper VAD 降噪转写模式",
            3200,
          );
          this.stopRecognitionInstance();
          this.activeEngine = fallbackEngine;
          this.oneShot = wasOneShot;
          void this.startPcmAudioPipeline(fallbackEngine);
          return;
        }
        this.lastError =
          "浏览器在线语音识别网络不可达（建议在「设置 → 语音与 Pi Agent」启用本地离线 Qwen3-ASR / SenseVoice 引擎或配置 STT 接口）。";
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

  /**
   * 高性能 AudioWorklet 16kHz PCM 实时采集管线（切后台不断流、400ms Pre-roll、自适应降噪门限、Barge-in 打断）。
   */
  private async startPcmAudioPipeline(engine: "local" | "whisper"): Promise<void> {
    if (!isMicrophoneAudioSupported()) {
      this.lastError = "当前浏览器不支持麦克风音频采集。";
      this.active = false;
      this.mode = "error";
      this.emitState(true);
      return;
    }
    this.stopAudioCapture();

    try {
      const useNeuralPipeline = this.config.noiseSuppressionMode !== "off" && this.config.noiseSuppressionMode !== "dsp";
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          // 始终保留硬件回声消除（消除本机扬声器回声）；
          // 服务端启用神经降噪/双轨抗音乐识别时关闭浏览器粗糙的 NS/AGC，避免音乐场景下人声被浏览器抽泵砍断！
          echoCancellation: true,
          noiseSuppression: !useNeuralPipeline && this.config.noiseSuppressionMode !== "off",
          autoGainControl: !useNeuralPipeline,
          channelCount: 1,
        },
      });
      if (!this.active) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      this.mediaStream = stream;

      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) {
        throw new Error("当前浏览器不支持 Web Audio API");
      }

      const ctx = new AudioCtx();
      this.audioCtx = ctx;
      if (ctx.state === "suspended") {
        await ctx.resume();
      }
      const source = ctx.createMediaStreamSource(stream);
      const silentGain = ctx.createGain();
      silentGain.gain.value = 0;
      this.silentGain = silentGain;

      const canStreamWs =
        Boolean(this.cb.isVoiceStreamReady?.()) &&
        Boolean(this.cb.sendVoiceStreamControl) &&
        Boolean(this.cb.sendVoiceStreamPcm);

      if (ctx.audioWorklet && typeof AudioWorkletNode !== "undefined") {
        const blob = new Blob([VOICE_WORKLET_CODE], { type: "application/javascript" });
        const url = URL.createObjectURL(blob);
        this.workletBlobUrl = url;
        await ctx.audioWorklet.addModule(url);

        if (canStreamWs) {
          this.streamingOverWs = Boolean(
            this.cb.sendVoiceStreamControl?.({
              type: "voice_stream_start",
              sampleRate: 16000,
              lang: this.config.voiceLang || "zh-CN",
              bypassWakeWord: this.oneShot,
              engine,
            }),
          );
        } else {
          this.streamingOverWs = false;
        }

        const node = new AudioWorkletNode(ctx, "mijia-voice-processor", {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          channelCount: 1,
          processorOptions: {
            vadThreshold: this.config.vadThreshold,
            vadSilenceMs: this.config.vadSilenceMs,
            streamMode: this.streamingOverWs,
          },
        });
        this.workletNode = node;

        node.port.onmessage = (ev) => {
          const msg = ev.data as {
            type?: string;
            rms?: number;
            samples?: Float32Array;
            sampleRate?: number;
            buffer?: ArrayBuffer;
          };
          if (!msg || !this.active) return;

          if (msg.type === "level") {
            const level = Math.min(1, (msg.rms ?? 0) * 11);
            this.cb.onLevelChange(this.speakingMuted ? 0 : level);
          } else if (msg.type === "barge_in") {
            if (this.config.bargeInEnabled !== false && this.speakingMuted) {
              this.cancelSpeaking();
              this.interimTranscript = "已打断，请说…";
              this.emitState(false);
            }
          } else if (msg.type === "pcm_frame" && msg.buffer instanceof ArrayBuffer) {
            if (this.streamingOverWs) {
              const sent = this.cb.sendVoiceStreamPcm?.(msg.buffer);
              if (sent === false) {
                // WebSocket 临时断开时自动降级到本地 VAD + HTTP 上传
                this.streamingOverWs = false;
                node.port.postMessage({ type: "config", streamMode: false });
              }
            }
          } else if (msg.type === "speech_start") {
            if (!this.uploading) {
              this.interimTranscript = "收音中…";
              this.emitState(false);
            }
          } else if (msg.type === "speech_cancel") {
            if (!this.uploading) {
              this.interimTranscript = "";
              this.emitState(false);
            }
          } else if (msg.type === "utterance" && msg.samples instanceof Float32Array) {
            if (this.uploading) return;
            const wavBlob = encodeFloat32ToWavBlob(msg.samples, msg.sampleRate || 16000);
            void this.dispatchAudioBlob(wavBlob, engine);
          }
        };

        source.connect(node);
        node.connect(silentGain);
        silentGain.connect(ctx.destination);
      } else {
        // 极端旧内核降级（ScriptProcessor + Pre-roll）
        this.setupLegacyPcmCapture(ctx, source, silentGain, engine);
      }

      this.lastError = null;
      this.mode = this.oneShot ? "awake" : "listening";
      this.emitState(true);
    } catch {
      this.lastError = "无法获取麦克风权限，请在浏览器中允许录音权限。";
      this.active = false;
      this.mode = "error";
      this.emitState(true);
      this.cb.onToast(this.lastError, 4500);
    }
  }

  private setupLegacyPcmCapture(
    ctx: AudioContext,
    source: MediaStreamAudioSourceNode,
    silentGain: GainNode,
    engine: "local" | "whisper",
  ): void {
    const proc = ctx.createScriptProcessor(2048, 1, 1);
    this.fallbackProcessor = proc;
    const chunks: Float32Array[] = [];
    let speaking = false;
    let lastLoud = 0;
    let startedAt = 0;
    const preRoll: Float32Array[] = [];

    proc.onaudioprocess = (ev) => {
      if (!this.active || this.speakingMuted || this.uploading) return;
      const input = ev.inputBuffer.getChannelData(0);
      const copy = new Float32Array(input);
      let sum = 0;
      for (let i = 0; i < copy.length; i += 1) sum += copy[i]! * copy[i]!;
      const rms = Math.sqrt(sum / copy.length);
      this.cb.onLevelChange(Math.min(1, rms * 10));

      const now = Date.now();
      if (!speaking) {
        preRoll.push(copy);
        if (preRoll.length > 6) preRoll.shift();
        if (rms >= this.config.vadThreshold) {
          speaking = true;
          startedAt = now;
          lastLoud = now;
          chunks.length = 0;
          chunks.push(...preRoll);
          this.interimTranscript = "收音中…";
          this.emitState(false);
        }
      } else {
        chunks.push(copy);
        if (rms >= this.config.vadThreshold * 0.75) {
          lastLoud = now;
        }
        if (now - lastLoud >= this.config.vadSilenceMs || now - startedAt >= 15_000) {
          speaking = false;
          const total = chunks.reduce((a, c) => a + c.length, 0);
          const merged = new Float32Array(total);
          let off = 0;
          for (const c of chunks) {
            merged.set(c, off);
            off += c.length;
          }
          chunks.length = 0;
          const ratio = ctx.sampleRate / 16000;
          const outLen = Math.max(1, Math.round(merged.length / ratio));
          const pcm16 = new Float32Array(outLen);
          for (let i = 0; i < outLen; i += 1) {
            pcm16[i] = merged[Math.min(merged.length - 1, Math.floor(i * ratio))] ?? 0;
          }
          const wavBlob = encodeFloat32ToWavBlob(pcm16, 16000);
          void this.dispatchAudioBlob(wavBlob, engine);
        }
      }
    };

    source.connect(proc);
    proc.connect(silentGain);
    silentGain.connect(ctx.destination);
  }

  private async dispatchAudioBlob(blob: Blob, engine: "local" | "whisper"): Promise<void> {
    this.uploading = true;
    this.interimTranscript = "识别中…";
    this.emitState(false);
    const bypass = this.oneShot;
    try {
      await this.cb.onUploadAudio(blob, {
        bypassWakeWord: bypass,
        lang: this.config.voiceLang || "zh-CN",
        engine,
        filename: "voice.wav",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastError = msg;
      this.cb.onToast(`语音识别失败：${msg}`, 4000);
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
    if (this.workletNode) {
      try {
        this.workletNode.port.onmessage = null;
        this.workletNode.disconnect();
      } catch {
        // ignore
      }
      this.workletNode = null;
    }
    if (this.workletBlobUrl) {
      URL.revokeObjectURL(this.workletBlobUrl);
      this.workletBlobUrl = null;
    }
    if (this.fallbackProcessor) {
      try {
        this.fallbackProcessor.onaudioprocess = null;
        this.fallbackProcessor.disconnect();
      } catch {
        // ignore
      }
      this.fallbackProcessor = null;
    }
    if (this.silentGain) {
      try {
        this.silentGain.disconnect();
      } catch {
        // ignore
      }
      this.silentGain = null;
    }
    if (this.audioCtx) {
      void this.audioCtx.close().catch(() => {});
      this.audioCtx = null;
    }
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((t) => t.stop());
      this.mediaStream = null;
    }
  }
}
