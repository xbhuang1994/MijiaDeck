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
  voicePipelineMode?: "legacy" | "xfyun";
  xfyunEndpointUrl?: string;
  xfyunAppId?: string;
  effectiveXfyunConfigured?: boolean;
  streamingAsrEnabled?: boolean;
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
  asyncVoicePipeline?: boolean;
  echoCancellationMode?: "auto" | "aggressive" | "standard" | "off";
  bargeInDuckingEnabled?: boolean;
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
  xfyunIatReady?: boolean;
  localTtsReady?: boolean;
}

export interface ClientSpeakMeta {
  utteranceId?: string;
  priority?: "ack" | "normal" | "result" | "system";
  taskId?: string;
  interrupt?: boolean;
}

export interface VoiceListenerClientCallbacks {
  onStatusChange: (status: {
    active: boolean;
    mode: ClientVoiceMode;
    engine: ClientVoiceEngine;
    interimTranscript: string;
    error: string | null;
    oneShot: boolean;
    speaking: boolean;
    ducked: boolean;
    speakingQueueLength: number;
    speakingText: string | null;
    aecActive: boolean;
    erleDb: number;
    doubleTalk: boolean;
  }) => void;
  onLevelChange: (level: number) => void;
  onSyncServerState: (patch: {
    active?: boolean;
    mode?: ClientVoiceMode;
    engine?: ClientVoiceEngine;
    interimTranscript?: string;
    error?: string | null;
  }) => void;
  onTranscriptFinal: (
    text: string,
    options: {
      bypassWakeWord: boolean;
      engine: ClientVoiceEngine;
      asyncDispatch?: boolean;
      duringTtsPlayback?: boolean;
    },
  ) => Promise<void>;
  onUploadAudio: (
    blob: Blob,
    options: {
      bypassWakeWord: boolean;
      lang: string;
      engine: "local" | "whisper";
      filename: string;
      asyncDispatch?: boolean;
      duringTtsPlayback?: boolean;
    },
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
 * 独立音频线程 AudioWorkletProcessor 源码（全双工 + 实时参考信号 PBFDAF/NLMS 声学回声消除）：
 * 1. 双输入时钟同步下采样至 16kHz Mono PCM（Input 0 = 麦克风，Input 1 = 本机 TTS 播报远端参考信号）
 * 2. 85Hz 一阶高通滤波去除直流偏移与低频嗡声
 * 3. 内置 16 分块 × 256 采样 (256ms) PBFDAF 频域自适应回声消除 + 双讲检测 (DTD) + 残余回声抑制 (RES)
 * 4. 全双工异步流模式：播报期间绝不强行暂停麦克风收音，经实时 AEC 净化后的近端人声持续直推服务端！
 * 5. 双讲检测仅在真实近端人声出现时通知主线程平滑降音（Ducking）与打断，彻底消除扬声器自回声误打断。
 */
const VOICE_WORKLET_CODE = `
function aecFft(re, im, inverse) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wlenRe = Math.cos(ang);
    const wlenIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let wRe = 1, wIm = 0;
      const half = len >> 1;
      for (let j = 0; j < half; j += 1) {
        const uRe = re[i + j], uIm = im[i + j];
        const vRe = re[i + j + half] * wRe - im[i + j + half] * wIm;
        const vIm = re[i + j + half] * wIm + im[i + j + half] * wRe;
        re[i + j] = uRe + vRe;
        im[i + j] = uIm + vIm;
        re[i + j + half] = uRe - vRe;
        im[i + j + half] = uIm - vIm;
        const nextWRe = wRe * wlenRe - wIm * wlenIm;
        wIm = wRe * wlenIm + wIm * wlenRe;
        wRe = nextWRe;
      }
    }
  }
  if (inverse) {
    const invN = 1 / n;
    for (let i = 0; i < n; i += 1) {
      re[i] *= invN;
      im[i] *= invN;
    }
  }
}

class WorkletPbfdafAec {
  constructor(aggressive) {
    this.N = 256;
    this.F = 512;
    this.B = 257;
    this.M = 16;
    this.stepSize = 0.45;
    this.reg = 1e-4;
    this.farEndThresh = 0.0025;
    this.aggressive = Boolean(aggressive);
    this.prevRef = new Float32Array(this.N);
    this.xRe = Array.from({ length: this.M }, () => new Float32Array(this.B));
    this.xIm = Array.from({ length: this.M }, () => new Float32Array(this.B));
    this.wRe = Array.from({ length: this.M }, () => new Float32Array(this.B));
    this.wIm = Array.from({ length: this.M }, () => new Float32Array(this.B));
    this.partHead = 0;
    this.psdRef = new Float32Array(this.B).fill(this.reg);
    this.psdErr = new Float32Array(this.B).fill(1e-7);
    this.psdEcho = new Float32Array(this.B).fill(1e-7);
    this.prevPostGain = new Float32Array(this.B).fill(1);
    this.prevErrTime = new Float32Array(this.N);
    this.tmpRe = new Float32Array(this.F);
    this.tmpIm = new Float32Array(this.F);
    this.yRe = new Float32Array(this.F);
    this.yIm = new Float32Array(this.F);
    this.eRe = new Float32Array(this.F);
    this.eIm = new Float32Array(this.F);
    this.gradRe = new Float32Array(this.F);
    this.gradIm = new Float32Array(this.F);
    this.smoothMicPow = 1e-8;
    this.smoothErrPow = 1e-8;
    this.farEndHold = 0;
    this.doubleTalkHold = 0;
    this.erleDb = 0;
    this.convergedRatio = 0;
    this.adaptBlocks = 0;
    this.constraintTick = 0;
  }

  processBlock(mic, ref) {
    const N = this.N, F = this.F, B = this.B, M = this.M;
    let micSum = 0, refSum = 0;
    for (let i = 0; i < N; i += 1) {
      const m = mic[i], r = ref[i];
      micSum += m * m;
      refSum += r * r;
    }
    const micPow = micSum / N;
    const refPow = refSum / N;
    const micRms = Math.sqrt(micPow);
    const refRms = Math.sqrt(refPow);
    const refNow = refRms >= this.farEndThresh;
    if (refNow) this.farEndHold = 18;
    else if (this.farEndHold > 0) this.farEndHold -= 1;
    const farEndActive = refNow || this.farEndHold > 0;

    this.tmpRe.set(this.prevRef, 0);
    this.tmpRe.set(ref, N);
    this.tmpIm.fill(0);
    this.prevRef.set(ref, 0);
    aecFft(this.tmpRe, this.tmpIm, false);

    this.partHead = (this.partHead - 1 + M) % M;
    const cxRe = this.xRe[this.partHead], cxIm = this.xIm[this.partHead];
    for (let k = 0; k < B; k += 1) {
      cxRe[k] = this.tmpRe[k];
      cxIm[k] = this.tmpIm[k];
    }

    if (!farEndActive) {
      this.doubleTalkHold = 0;
      this.prevErrTime.set(mic, 0);
      this.prevPostGain.fill(1);
      return { output: mic, farEndActive: false, doubleTalk: false, erleDb: this.erleDb, outputRms: micRms };
    }

    this.yRe.fill(0);
    this.yIm.fill(0);
    for (let p = 0; p < M; p += 1) {
      const idx = (this.partHead + p) % M;
      const xpRe = this.xRe[idx], xpIm = this.xIm[idx];
      const wpRe = this.wRe[p], wpIm = this.wIm[p];
      for (let k = 0; k < B; k += 1) {
        const xr = xpRe[k], xi = xpIm[k], wr = wpRe[k], wi = wpIm[k];
        this.yRe[k] += wr * xr - wi * xi;
        this.yIm[k] += wr * xi + wi * xr;
      }
    }
    for (let k = 1; k < B - 1; k += 1) {
      this.yRe[F - k] = this.yRe[k];
      this.yIm[F - k] = -this.yIm[k];
    }
    aecFft(this.yRe, this.yIm, true);

    const linearErr = new Float32Array(N);
    let errSum = 0, echoSum = 0, micEchoDot = 0, errEchoDot = 0;
    for (let i = 0; i < N; i += 1) {
      const m = mic[i], yh = this.yRe[N + i], e = m - yh;
      linearErr[i] = e;
      errSum += e * e;
      echoSum += yh * yh;
      micEchoDot += m * yh;
      errEchoDot += e * yh;
    }
    const errPow = errSum / N;
    const echoPow = echoSum / N;
    this.smoothMicPow = 0.72 * this.smoothMicPow + 0.28 * micPow;
    this.smoothErrPow = 0.72 * this.smoothErrPow + 0.28 * errPow;

    const micEchoCorr = micSum > 1e-9 && echoSum > 1e-9 ? Math.abs(micEchoDot) / Math.sqrt(micSum * echoSum) : 0;
    const errEchoCorr = errSum > 1e-9 && echoSum > 1e-9 ? Math.abs(errEchoDot) / Math.sqrt(errSum * echoSum) : 0;
    const converged = this.adaptBlocks >= 10 && this.convergedRatio > 0.45;
    const errRms = Math.sqrt(errPow);
    const echoRms = Math.sqrt(echoPow);

    const strongNear = converged && errRms > Math.max(0.014, echoRms * 0.42) && errEchoCorr < 0.35 && micPow > echoPow * 1.35;
    const loudNear = micRms > Math.max(0.035, refRms * 1.45) && errRms > Math.max(0.025, echoRms * 0.85) && micEchoCorr < 0.55;
    if (strongNear || loudNear) this.doubleTalkHold = 6;
    else if (this.doubleTalkHold > 0) this.doubleTalkHold -= 1;
    const doubleTalk = this.doubleTalkHold > 0;

    this.eRe.fill(0);
    this.eIm.fill(0);
    for (let i = 0; i < N; i += 1) this.eRe[N + i] = linearErr[i];
    aecFft(this.eRe, this.eIm, false);

    for (let k = 0; k < B; k += 1) {
      let totalX = 0;
      for (let p = 0; p < M; p += 1) {
        const xr = this.xRe[p][k], xi = this.xIm[p][k];
        totalX += xr * xr + xi * xi;
      }
      this.psdRef[k] = 0.65 * this.psdRef[k] + 0.35 * totalX;
    }

    if (refNow && !doubleTalk) {
      if (errPow > micPow * 2.5 && micPow > 1e-6) {
        for (let p = 0; p < M; p += 1) {
          for (let k = 0; k < B; k += 1) {
            this.wRe[p][k] *= 0.5;
            this.wIm[p][k] *= 0.5;
          }
        }
      } else {
        const cPart = this.constraintTick % M;
        this.constraintTick += 1;
        for (let p = 0; p < M; p += 1) {
          const idx = (this.partHead + p) % M;
          const xpRe = this.xRe[idx], xpIm = this.xIm[idx];
          const wpRe = this.wRe[p], wpIm = this.wIm[p];
          if (p === cPart) {
            this.gradRe.fill(0);
            this.gradIm.fill(0);
            for (let k = 0; k < B; k += 1) {
              const norm = this.stepSize / (this.psdRef[k] + this.reg);
              const er = this.eRe[k], ei = this.eIm[k], xr = xpRe[k], xi = xpIm[k];
              const gr = (xr * er + xi * ei) * norm;
              const gi = (xr * ei - xi * er) * norm;
              this.gradRe[k] = gr;
              this.gradIm[k] = gi;
              if (k > 0 && k < B - 1) {
                this.gradRe[F - k] = gr;
                this.gradIm[F - k] = -gi;
              }
            }
            aecFft(this.gradRe, this.gradIm, true);
            for (let i = N; i < F; i += 1) this.gradRe[i] = 0;
            this.gradIm.fill(0);
            aecFft(this.gradRe, this.gradIm, false);
            for (let k = 0; k < B; k += 1) {
              wpRe[k] += this.gradRe[k];
              wpIm[k] += this.gradIm[k];
            }
          } else {
            for (let k = 0; k < B; k += 1) {
              const norm = this.stepSize / (this.psdRef[k] + this.reg);
              const er = this.eRe[k], ei = this.eIm[k], xr = xpRe[k], xi = xpIm[k];
              wpRe[k] += (xr * er + xi * ei) * norm;
              wpIm[k] += (xr * ei - xi * er) * norm;
            }
          }
        }
        this.adaptBlocks += 1;
        const ratio = this.smoothMicPow > 1e-8 ? Math.max(0, Math.min(1, 1 - this.smoothErrPow / this.smoothMicPow)) : 0;
        this.convergedRatio = 0.85 * this.convergedRatio + 0.15 * ratio;
      }
    }

    this.tmpRe.set(this.prevErrTime, 0);
    this.tmpRe.set(linearErr, N);
    this.tmpIm.fill(0);
    this.prevErrTime.set(linearErr, 0);
    aecFft(this.tmpRe, this.tmpIm, false);

    this.gradRe.fill(0);
    this.gradIm.fill(0);
    for (let i = 0; i < N; i += 1) this.gradRe[N + i] = this.yRe[N + i];
    aecFft(this.gradRe, this.gradIm, false);

    const overSub = doubleTalk ? (this.aggressive ? 0.65 : 0.45) : (this.aggressive ? 2.2 : 1.45);
    const gainFloor = doubleTalk ? 0.35 : (this.aggressive ? 0.025 : 0.06);
    const leak = converged ? 0.32 : 0.65;
    for (let k = 0; k < B; k += 1) {
      const errP = this.tmpRe[k] * this.tmpRe[k] + this.tmpIm[k] * this.tmpIm[k];
      const echoP = this.gradRe[k] * this.gradRe[k] + this.gradIm[k] * this.gradIm[k];
      this.psdErr[k] = 0.55 * this.psdErr[k] + 0.45 * errP;
      this.psdEcho[k] = 0.55 * this.psdEcho[k] + 0.45 * echoP;
      const resEst = this.psdEcho[k] * leak + (refNow ? this.psdRef[k] * 0.004 : 0);
      const wiener = this.psdErr[k] > 1e-10 ? Math.max(0, this.psdErr[k] - overSub * resEst) / this.psdErr[k] : gainFloor;
      const g = 0.35 * this.prevPostGain[k] + 0.65 * Math.max(gainFloor, Math.min(1, wiener));
      this.prevPostGain[k] = g;
      this.tmpRe[k] *= g;
      this.tmpIm[k] *= g;
      if (k > 0 && k < B - 1) {
        this.tmpRe[F - k] = this.tmpRe[k];
        this.tmpIm[F - k] = -this.tmpIm[k];
      }
    }
    aecFft(this.tmpRe, this.tmpIm, true);
    const out = new Float32Array(N);
    let outSum = 0;
    for (let i = 0; i < N; i += 1) {
      const v = Math.max(-1, Math.min(1, this.tmpRe[N + i]));
      out[i] = v;
      outSum += v * v;
    }
    const outPow = outSum / N;
    if (refNow && !doubleTalk && this.smoothMicPow > 1e-7) {
      const db = Math.max(0, Math.min(45, 10 * Math.log10((this.smoothMicPow + 1e-9) / (outPow + 1e-9))));
      this.erleDb = Math.round((0.8 * this.erleDb + 0.2 * db) * 10) / 10;
    }
    return { output: out, farEndActive: true, doubleTalk, erleDb: this.erleDb, outputRms: Math.sqrt(outPow) };
  }
}

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

    // 连续实时流模式 + 全双工 AEC 配置
    this.streamMode = Boolean(opts.streamMode);
    this.fullDuplex = opts.fullDuplex !== false;
    this.bargeInEnabled = opts.bargeInEnabled !== false;
    this.echoMode = typeof opts.echoMode === "string" ? opts.echoMode : "auto";
    this.aecEnabled = this.echoMode !== "off" && this.echoMode !== "standard";
    this.aec = new WorkletPbfdafAec(this.echoMode === "aggressive");
    this.aecBlockSize = 256;
    this.aecMicBuf = new Float32Array(this.aecBlockSize);
    this.aecRefBuf = new Float32Array(this.aecBlockSize);
    this.aecPos = 0;
    this.ttsActive = false;
    this.lastDoubleTalk = false;
    this.aecMetricsTick = 0;
    this.noRefLoudFrames = 0;

    this.streamFrameSize = 1024;
    this.streamBuf = new Int16Array(this.streamFrameSize);
    this.streamPos = 0;

    // 兜底 HTTP 模式下的自适应噪声底噪 + VAD 状态
    this.vadThreshold = Number(opts.vadThreshold) || 0.018;
    this.vadSilenceMs = Number(opts.vadSilenceMs) || 1000;
    this.noiseFloor = 0.006;
    this.speaking = false;
    this.speechChunks = [];
    this.speechSampleCount = 0;
    this.silentSamples = 0;
    this.loudFrames = 0;
    this.maxSpeechSamples = this.targetRate * 30;
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
        if (typeof msg.fullDuplex === "boolean") this.fullDuplex = msg.fullDuplex;
        if (typeof msg.bargeInEnabled === "boolean") this.bargeInEnabled = msg.bargeInEnabled;
        if (typeof msg.echoMode === "string") {
          this.echoMode = msg.echoMode;
          this.aecEnabled = this.echoMode !== "off" && this.echoMode !== "standard";
          this.aec.aggressive = this.echoMode === "aggressive";
        }
      } else if (msg.type === "tts_state") {
        this.ttsActive = Boolean(msg.active);
        if (this.ttsActive && !this.bargeInEnabled) {
          this.loudFrames = 0;
        }
        if (!this.ttsActive) {
          this.noRefLoudFrames = 0;
          if (this.lastDoubleTalk) {
            this.lastDoubleTalk = false;
            this.port.postMessage({ type: "double_talk", active: false, erleDb: this.aec.erleDb });
          }
        }
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

  pushToStreamOrVad(cleanSamples) {
    // 关闭语音打断（bargeInEnabled=false）且正在 TTS 播报/尾音保护期：
    // 在 Worklet 源头静音门控上行帧，保持流时钟连续但彻底阻断系统提示音/残余回声进入后端 VAD！
    const ttsMicGated = this.ttsActive && !this.bargeInEnabled;
    if (ttsMicGated) {
      this.levelAccumN += cleanSamples.length;
      if (this.levelAccumN >= 640) {
        this.port.postMessage({
          type: "level",
          rms: 0,
          noiseFloor: this.noiseFloor,
          speaking: false,
        });
        this.levelAccumSq = 0;
        this.levelAccumN = 0;
      }
      if (this.streamMode) {
        for (let i = 0; i < cleanSamples.length; i += 1) {
          this.streamBuf[this.streamPos] = 0;
          this.streamPos += 1;
          if (this.streamPos >= this.streamFrameSize) {
            const out = this.streamBuf;
            this.streamBuf = new Int16Array(this.streamFrameSize);
            this.streamPos = 0;
            this.port.postMessage({ type: "pcm_frame", buffer: out.buffer }, [out.buffer]);
          }
        }
        return;
      }
      if (this.speaking) {
        this.silentSamples += cleanSamples.length;
        const maxSilenceSamples = Math.round((this.vadSilenceMs / 1000) * this.targetRate);
        if (this.silentSamples >= maxSilenceSamples) {
          this.finishUtterance();
        }
      } else {
        this.loudFrames = 0;
      }
      return;
    }

    let sumSq = 0;
    let zcrCount = 0;
    let prev = 0;
    for (let i = 0; i < cleanSamples.length; i += 1) {
      const s = cleanSamples[i];
      sumSq += s * s;
      if (i > 0 && ((s >= 0 && prev < 0) || (s < 0 && prev >= 0))) zcrCount += 1;
      prev = s;
    }
    const rms = Math.sqrt(sumSq / Math.max(1, cleanSamples.length));
    const zcr = zcrCount / Math.max(1, cleanSamples.length);

    this.levelAccumSq += sumSq;
    this.levelAccumN += cleanSamples.length;
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

    const adaptiveThresh = Math.max(this.vadThreshold, this.noiseFloor * 2.55);
    const isVoiceLike = rms >= adaptiveThresh && zcr >= 0.01 && zcr <= 0.48;

    // 传统半双工模式（仅当用户主动关闭全双工异步管线时走 paused 逻辑）
    if (this.paused && !this.fullDuplex) {
      if (rms >= Math.max(this.vadThreshold * 2.6, this.noiseFloor * 4.2) && zcr >= 0.02 && zcr <= 0.42) {
        this.loudFrames += 1;
        if (this.loudFrames >= 6) {
          this.loudFrames = 0;
          this.port.postMessage({ type: "barge_in", rms });
        }
      } else {
        this.loudFrames = Math.max(0, this.loudFrames - 1);
      }
      this.pushPreRoll(cleanSamples);
      return;
    }

    // 连续实时流模式：全双工期间持续将经 AEC 净化后的 16kHz Int16 PCM 推送服务端（永不阻塞对话！）
    if (this.streamMode) {
      for (let i = 0; i < cleanSamples.length; i += 1) {
        const s = cleanSamples[i];
        this.streamBuf[this.streamPos] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
        this.streamPos += 1;
        if (this.streamPos >= this.streamFrameSize) {
          const out = this.streamBuf;
          this.streamBuf = new Int16Array(this.streamFrameSize);
          this.streamPos = 0;
          this.port.postMessage({ type: "pcm_frame", buffer: out.buffer }, [out.buffer]);
        }
      }
      return;
    }

    // HTTP 降级 VAD 模式
    if (!this.speaking) {
      const rate = rms < this.noiseFloor ? 0.05 : 0.008;
      this.noiseFloor = Math.max(0.002, Math.min(0.03, this.noiseFloor * (1 - rate) + rms * rate));
      this.pushPreRoll(cleanSamples);

      if (isVoiceLike) {
        this.loudFrames += 1;
        if (this.loudFrames >= 4) {
          this.speaking = true;
          this.silentSamples = 0;
          const pre = this.drainPreRoll();
          this.speechChunks = [pre, Float32Array.from(cleanSamples)];
          this.speechSampleCount = pre.length + cleanSamples.length;
          this.port.postMessage({ type: "speech_start" });
        }
      } else {
        this.loudFrames = 0;
      }
    } else {
      this.speechChunks.push(Float32Array.from(cleanSamples));
      this.speechSampleCount += cleanSamples.length;
      const continueThresh = Math.max(this.vadThreshold * 0.72, this.noiseFloor * 1.85);
      if (rms >= continueThresh) this.silentSamples = 0;
      else this.silentSamples += cleanSamples.length;
      const maxSilenceSamples = Math.round((this.vadSilenceMs / 1000) * this.targetRate);
      if (this.silentSamples >= maxSilenceSamples || this.speechSampleCount >= this.maxSpeechSamples) {
        this.finishUtterance();
      }
    }
  }

  process(inputs) {
    const micIn = inputs[0];
    if (!micIn || !micIn[0] || micIn[0].length === 0) return true;
    const micCh = micIn[0];
    const refIn = inputs[1];
    const refCh = refIn && refIn[0] && refIn[0].length === micCh.length ? refIn[0] : null;

    const micOut = [];
    const refOut = [];
    let phase = this.phase;

    for (let i = 0; i < micCh.length; i += 1) {
      const x = micCh[i];
      const y = this.hpAlpha * (this.hpPrevY + x - this.hpPrevX);
      this.hpPrevX = x;
      this.hpPrevY = y;

      phase += 1;
      if (phase >= this.ratio) {
        phase -= this.ratio;
        const clampedMic = y > 1 ? 1 : y < -1 ? -1 : y;
        const r = refCh ? refCh[i] : 0;
        const clampedRef = r > 1 ? 1 : r < -1 ? -1 : r;
        micOut.push(clampedMic);
        refOut.push(clampedRef);
      }
    }
    this.phase = phase;
    if (micOut.length === 0) return true;

    // 启用参考信号实时 PBFDAF AEC（全双工 + auto/aggressive 模式）
    if (this.aecEnabled && this.fullDuplex) {
      for (let i = 0; i < micOut.length; i += 1) {
        this.aecMicBuf[this.aecPos] = micOut[i];
        this.aecRefBuf[this.aecPos] = refOut[i];
        this.aecPos += 1;
        if (this.aecPos >= this.aecBlockSize) {
          this.aecPos = 0;
          const res = this.aec.processBlock(this.aecMicBuf, this.aecRefBuf);
          this.aecMetricsTick += 1;

          // 有远端参考信号时，使用 AEC 双讲检测精准驱动降音/打断；
          // 若走浏览器原生 SpeechSynthesis（无 PCM 参考信号），则使用高门限近端人声检测兜底双讲
          let dt = this.bargeInEnabled ? res.doubleTalk : false;
          if (this.bargeInEnabled && !res.farEndActive && this.ttsActive) {
            if (res.outputRms >= Math.max(this.vadThreshold * 2.5, this.noiseFloor * 4.0)) {
              this.noRefLoudFrames += 1;
              if (this.noRefLoudFrames >= 4) dt = true;
            } else {
              this.noRefLoudFrames = Math.max(0, this.noRefLoudFrames - 1);
            }
          } else {
            this.noRefLoudFrames = 0;
          }

          if (dt !== this.lastDoubleTalk) {
            this.lastDoubleTalk = dt;
            this.port.postMessage({
              type: "double_talk",
              active: dt,
              rms: res.outputRms,
              erleDb: res.erleDb,
              farEndActive: res.farEndActive,
            });
          } else if (res.farEndActive && this.aecMetricsTick % 16 === 0) {
            this.port.postMessage({
              type: "aec_metrics",
              active: true,
              erleDb: res.erleDb,
              doubleTalk: dt,
              farEndActive: true,
            });
          }

          this.pushToStreamOrVad(res.output);
        }
      }
      return true;
    }

    const pcm16 = Float32Array.from(micOut);
    this.pushToStreamOrVad(pcm16);
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
  utteranceId: string;
  text: string;
  priority: "ack" | "normal" | "result" | "system";
  taskId?: string;
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
    vadSilenceMs: 1000,
    noiseSuppressionMode: "auto",
    vadMode: "silero",
    voiceprintMode: "tag",
    voiceprintThreshold: 0.42,
    attentionMode: "smart",
    conversationWindowSec: 25,
    maxConsecutiveSidetalk: 3,
    bargeInEnabled: true,
    asyncVoicePipeline: true,
    echoCancellationMode: "auto",
    bargeInDuckingEnabled: true,
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

  // Streaming Neural TTS Queue + Prefetch + Watchdog + WebAudio AEC Reference Feed
  private ttsQueue: TtsQueueItem[] = [];
  private ttsSpeaking = false;
  private ttsDucked = false;
  private ttsNotifiedSpeaking = false;
  private ttsSessionGen = 0;
  private ttsItemSeq = 0;
  private activeTtsItem: TtsQueueItem | null = null;
  private lastAckEnqueuedAt = 0;
  private activeAudioEl: HTMLAudioElement | null = null;
  private activeAudioUrl: string | null = null;
  private activeBufferSource: AudioBufferSourceNode | null = null;
  private activeTtsAbort: AbortController | null = null;
  private ttsWatchdogTimer: number | null = null;
  private ttsReleaseTimer: number | null = null;
  private doubleTalkConfirmTimer: number | null = null;

  // 实时回声消除与双讲状态
  private aecActive = false;
  private erleDb = 0;
  private doubleTalkActive = false;

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
  private ttsGainNode: GainNode | null = null;
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

  isSpeaking(): boolean {
    return this.ttsSpeaking;
  }

  private isFullDuplexEnabled(): boolean {
    return this.config.asyncVoicePipeline !== false;
  }

  updateConfig(next: Partial<ClientVoiceConfig>): void {
    const prevLang = this.config.voiceLang;
    const prevEngine = this.config.voiceEngine;
    this.config = { ...this.config, ...next };

    // 动态热更新 AudioWorklet 参数（含全双工开关、语音打断与回声消除档位，无需重启麦克风）
    if (this.workletNode) {
      const echoMode = this.config.echoCancellationMode ?? "auto";
      this.workletNode.port.postMessage({
        type: "config",
        vadThreshold: this.config.vadThreshold,
        vadSilenceMs: this.config.vadSilenceMs,
        fullDuplex: this.isFullDuplexEnabled(),
        bargeInEnabled: this.config.bargeInEnabled !== false,
        echoMode,
      });
      this.aecActive =
        this.isFullDuplexEnabled() && echoMode !== "off" && echoMode !== "standard";
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
        "当前浏览器无法访问麦克风且不支持在线语音识别，请允许麦克风权限并使用本地 SenseVoice 引擎、讯飞听写 2.0 或 STT 接口。";
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
      if (this.ttsSpeaking && this.config.bargeInEnabled !== false) {
        this.cancelSpeaking();
      }
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

  private clearDoubleTalkConfirmTimer(): void {
    if (this.doubleTalkConfirmTimer !== null) {
      window.clearTimeout(this.doubleTalkConfirmTimer);
      this.doubleTalkConfirmTimer = null;
    }
  }

  private applyTtsDucking(ducked: boolean): void {
    this.ttsDucked = ducked;
    const gainTarget = ducked
      ? this.config.bargeInDuckingEnabled !== false
        ? 0.14
        : 0.35
      : 1.0;
    if (this.ttsGainNode && this.audioCtx && this.audioCtx.state !== "closed") {
      try {
        const now = this.audioCtx.currentTime;
        this.ttsGainNode.gain.cancelScheduledValues(now);
        this.ttsGainNode.gain.setTargetAtTime(gainTarget, now, 0.015);
      } catch {
        // ignore
      }
    }
    if (this.activeAudioEl) {
      try {
        this.activeAudioEl.volume = ducked ? 0.16 : 1.0;
      } catch {
        // ignore
      }
    }
  }

  private handleDoubleTalkSignal(active: boolean, erleDb?: number): void {
    this.doubleTalkActive = active;
    if (typeof erleDb === "number" && Number.isFinite(erleDb)) {
      this.erleDb = Math.round(erleDb * 10) / 10;
    }
    if (!this.ttsSpeaking) {
      this.clearDoubleTalkConfirmTimer();
      if (this.ttsDucked) this.applyTtsDucking(false);
      this.emitState(false);
      return;
    }

    if (active) {
      if (this.config.bargeInEnabled !== false) {
        if (this.config.bargeInDuckingEnabled !== false) {
          this.applyTtsDucking(true);
        }
        if (this.doubleTalkConfirmTimer === null) {
          this.doubleTalkConfirmTimer = window.setTimeout(() => {
            this.doubleTalkConfirmTimer = null;
            if (this.ttsSpeaking && this.doubleTalkActive && this.config.bargeInEnabled !== false) {
              this.cancelSpeaking();
              this.interimTranscript = "已打断，请说…";
              this.emitState(false);
            }
          }, 280);
        }
      }
      this.cb.sendVoiceStreamControl?.({
        type: "voice_tts_state",
        speaking: true,
        phase: "duck",
        utteranceId: this.activeTtsItem?.utteranceId,
        text: this.activeTtsItem?.text,
        queueLength: this.ttsQueue.length,
        aecActive: this.aecActive,
        erleDb: this.erleDb,
        doubleTalk: true,
      });
      this.emitState(false);
    } else {
      this.clearDoubleTalkConfirmTimer();
      if (this.ttsDucked) {
        this.applyTtsDucking(false);
      }
      this.cb.sendVoiceStreamControl?.({
        type: "voice_tts_state",
        speaking: this.ttsSpeaking,
        phase: this.ttsSpeaking ? "start" : "end",
        utteranceId: this.activeTtsItem?.utteranceId,
        queueLength: this.ttsQueue.length,
        aecActive: this.aecActive,
        erleDb: this.erleDb,
        doubleTalk: false,
      });
      this.emitState(false);
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
    if (this.activeBufferSource) {
      try {
        this.activeBufferSource.onended = null;
        this.activeBufferSource.stop();
        this.activeBufferSource.disconnect();
      } catch {
        // ignore
      }
      this.activeBufferSource = null;
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
   * 立即打断当前语音播报（Barge-in），不影响正在后台执行的任务与对话状态。
   */
  cancelSpeaking(): void {
    this.ttsSessionGen += 1;
    const cancelledId = this.activeTtsItem?.utteranceId;
    for (const item of this.ttsQueue) {
      try {
        item.abort?.abort();
      } catch {
        // ignore
      }
    }
    this.ttsQueue = [];
    this.activeTtsItem = null;
    this.ttsSpeaking = false;
    this.speakingMuted = false;
    this.doubleTalkActive = false;
    this.clearDoubleTalkConfirmTimer();
    this.applyTtsDucking(false);

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
    this.workletNode?.port.postMessage({ type: "tts_state", active: false });
    this.workletNode?.port.postMessage({ type: "pause", paused: false });
    if (this.ttsNotifiedSpeaking) {
      this.ttsNotifiedSpeaking = false;
      this.cb.sendVoiceStreamControl?.({
        type: "voice_tts_state",
        speaking: false,
        phase: "cancel",
        utteranceId: cancelledId,
        queueLength: 0,
        aecActive: this.aecActive,
        erleDb: this.erleDb,
        doubleTalk: false,
      });
    }
    if (this.active && this.mode === "speaking") {
      this.mode = "listening";
    }
    this.emitState(false);
  }

  private buildTtsQueueItem(
    cleaned: string,
    meta?: ClientSpeakMeta,
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
    const utteranceId = meta?.utteranceId || `cli_tts_${++this.ttsItemSeq}_${Date.now()}`;

    const item: TtsQueueItem = {
      utteranceId,
      text: cleaned,
      priority: meta?.priority ?? "normal",
      taskId: meta?.taskId,
      engine,
      voice,
      speed,
    };
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
   * 异步独立播报通道入队：默认非破坏性排队，避免多任务结果或确认语互相截断；
   * 仅当显式传入 interrupt: true（或用户关闭全双工异步管线）时才打断当前播报。
   */
  speak(text: string, meta?: ClientSpeakMeta): void {
    const cleaned = sanitizeBrowserTts(text);
    if (!cleaned || !this.config.autoSpeakReply) return;
    if (typeof window === "undefined") return;
    if (meta?.interrupt === true || !this.isFullDuplexEnabled()) {
      this.cancelSpeaking();
    } else if (meta?.priority === "ack") {
      const now = Date.now();
      if ((this.ttsSpeaking || this.ttsQueue.length > 0) && now - this.lastAckEnqueuedAt < 1500) {
        return;
      }
      this.lastAckEnqueuedAt = now;
    }
    if (this.ttsReleaseTimer !== null) {
      window.clearTimeout(this.ttsReleaseTimer);
      this.ttsReleaseTimer = null;
    }
    this.ttsQueue.push(this.buildTtsQueueItem(cleaned, meta));
    this.emitState(false);
    if (!this.ttsSpeaking) {
      void this.pumpTtsQueue();
    }
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
    this.ttsQueue.push(this.buildTtsQueueItem(cleaned, { priority: "system", interrupt: true }, overrides));
    void this.pumpTtsQueue();
  }

  /**
   * 流式分句播报：收到 Pi Agent 首句即刻预取并朗读，大幅降低首字语音延迟（TTFA）。
   */
  enqueueSpeakChunk(text: string, meta?: ClientSpeakMeta): void {
    const cleaned = sanitizeBrowserTts(text);
    if (!cleaned || !this.config.autoSpeakReply) return;
    if (typeof window === "undefined") return;
    if (meta?.priority === "ack") {
      const now = Date.now();
      if ((this.ttsSpeaking || this.ttsQueue.length > 0) && now - this.lastAckEnqueuedAt < 1500) {
        return;
      }
      this.lastAckEnqueuedAt = now;
    }
    if (this.ttsReleaseTimer !== null) {
      window.clearTimeout(this.ttsReleaseTimer);
      this.ttsReleaseTimer = null;
    }
    this.ttsQueue.push(this.buildTtsQueueItem(cleaned, meta));
    this.emitState(false);
    if (!this.ttsSpeaking) {
      void this.pumpTtsQueue();
    }
  }

  private async pumpTtsQueue(): Promise<void> {
    if (this.ttsSpeaking) return;
    const next = this.ttsQueue.shift();
    const fullDuplex = this.isFullDuplexEnabled();

    if (!next) {
      // 所有分段播报结束：等待声学混响与系统音频输出缓冲泄放后再结束播报态、释放 Worklet 静音门控并通知服务端
      const bargeIn = this.config.bargeInEnabled !== false;
      const tailMs = fullDuplex && bargeIn ? 280 : 420;
      this.ttsReleaseTimer = window.setTimeout(() => {
        this.ttsReleaseTimer = null;
        this.speakingMuted = false;
        this.activeTtsItem = null;
        this.doubleTalkActive = false;
        this.clearDoubleTalkConfirmTimer();
        this.applyTtsDucking(false);
        this.workletNode?.port.postMessage({ type: "tts_state", active: false });
        if (!fullDuplex) {
          this.workletNode?.port.postMessage({ type: "pause", paused: false });
        }
        if (this.ttsNotifiedSpeaking) {
          this.ttsNotifiedSpeaking = false;
          this.cb.sendVoiceStreamControl?.({
            type: "voice_tts_state",
            speaking: false,
            phase: "end",
            queueLength: 0,
            aecActive: this.aecActive,
            erleDb: this.erleDb,
            doubleTalk: false,
          });
        }
        if (this.active && this.mode === "speaking") {
          this.mode = "listening";
        }
        this.emitState(false);
      }, tailMs);
      return;
    }

    const gen = this.ttsSessionGen;
    this.ttsSpeaking = true;
    this.activeTtsItem = next;
    this.speakingMuted = !fullDuplex;
    this.applyTtsDucking(false);

    if (fullDuplex) {
      // 全双工异步模式：绝不暂停麦克风！仅通知 Worklet 开启/维持实时 AEC 与双讲监测
      this.workletNode?.port.postMessage({ type: "tts_state", active: true });
    } else {
      this.workletNode?.port.postMessage({ type: "pause", paused: true });
    }

    this.ttsNotifiedSpeaking = true;
    this.cb.sendVoiceStreamControl?.({
      type: "voice_tts_state",
      speaking: true,
      phase: "start",
      utteranceId: next.utteranceId,
      text: next.text,
      queueLength: this.ttsQueue.length,
      aecActive: this.aecActive,
      erleDb: this.erleDb,
      doubleTalk: this.doubleTalkActive,
    });

    if (!fullDuplex && this.active && this.mode !== "speaking") {
      this.mode = "speaking";
    }
    this.emitState(false);

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
      this.activeTtsItem = null;
      // 仅上报单条语段播放完毕（不提前置 speaking: false）：
      // 保持服务端回声窗口与 Worklet 尾音门控持续至 ttsReleaseTimer 混响泄放结束！
      this.cb.sendVoiceStreamControl?.({
        type: "voice_tts_state",
        phase: "end",
        utteranceId: next.utteranceId,
        text: next.text,
        queueLength: this.ttsQueue.length,
        aecActive: this.aecActive,
        erleDb: this.erleDb,
        doubleTalk: false,
      });
      this.emitState(false);
      void this.pumpTtsQueue();
    };

    try {
      // 1. 优先播放服务端本地 Matcha 温柔女声 WAV；若 AudioContext 处于活动状态，走 WebAudio
      //    同步馈送 ttsGainNode -> destination + Worklet Input 1，提供样本级精确远端参考信号给 AEC！
      if (next.audioPromise) {
        this.activeTtsAbort = next.abort ?? null;
        const wavBlob = await next.audioPromise;
        if (gen !== this.ttsSessionGen) return;
        if (wavBlob) {
          const playedViaWebAudio = await this.playWavViaWebAudio(
            wavBlob,
            next.text.length,
            gen,
            finishChunk,
          );
          if (playedViaWebAudio) {
            return;
          }
          if (gen !== this.ttsSessionGen) return;

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

  /**
   * 通过同一个 AudioContext 播放本地 TTS WAV 并同步路由到 AudioWorklet Input 1 作为 AEC 远端参考信号。
   */
  private async playWavViaWebAudio(
    wavBlob: Blob,
    textLen: number,
    gen: number,
    finishChunk: () => void,
  ): Promise<boolean> {
    const ctx = this.audioCtx;
    const gain = this.ttsGainNode;
    if (!ctx || !gain || ctx.state === "closed" || gen !== this.ttsSessionGen) {
      return false;
    }
    try {
      if (ctx.state === "suspended") {
        await ctx.resume();
      }
      if (gen !== this.ttsSessionGen || ctx.state !== "running") return false;
      const arrBuf = await wavBlob.arrayBuffer();
      if (gen !== this.ttsSessionGen) return false;
      const audioBuf = await ctx.decodeAudioData(arrBuf.slice(0));
      if (gen !== this.ttsSessionGen || !this.audioCtx || !this.ttsGainNode) return false;

      const src = ctx.createBufferSource();
      src.buffer = audioBuf;
      src.connect(this.ttsGainNode);
      this.activeBufferSource = src;

      const estMs = Math.max(
        4000,
        Math.min(28_000, Math.round(audioBuf.duration * 1000) + 2500, textLen * 360 + 4000),
      );
      this.ttsWatchdogTimer = window.setTimeout(finishChunk, estMs);
      src.onended = finishChunk;
      src.start(0);
      return true;
    } catch {
      this.cleanupActiveAudio();
      return false;
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
        audio.volume = this.ttsDucked ? 0.16 : 1.0;
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

    // Watchdog 防止 Chrome/Edge 偶发丢失 onend 导致播报状态卡死
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
    const xfyunReady = Boolean(this.config.xfyunIatReady || this.config.effectiveXfyunConfigured);
    const localReady =
      Boolean(this.config.localAsrReady) ||
      (this.config.voicePipelineMode === "xfyun" && xfyunReady);

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
    // 1. 优先本地离线 SenseVoice + GTCRN 降噪 + Silero VAD + 声纹（或讯飞听写大模型 2.0）
    // 2. 其次云端 Whisper STT（同样走 AudioWorklet 16kHz PCM + AEC + 降噪）
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
      speaking: this.ttsSpeaking,
      ducked: this.ttsDucked,
      speakingQueueLength: this.ttsQueue.length,
      speakingText: this.activeTtsItem?.text ?? null,
      aecActive: this.aecActive,
      erleDb: this.erleDb,
      doubleTalk: this.doubleTalkActive,
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
      const fullDuplex = this.isFullDuplexEnabled();
      if (!this.active || (!fullDuplex && this.speakingMuted)) return;
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
        const duringTts = this.ttsSpeaking;
        if (this.oneShot) {
          this.stop(true);
        } else {
          this.emitState(false);
        }
        void this.cb.onTranscriptFinal(finalText, {
          bypassWakeWord: bypass,
          engine: "browser",
          asyncDispatch: fullDuplex,
          duringTtsPlayback: duringTts,
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
              ? "浏览器在线识别不可达，已自动切换至内置语音管线（本地 SenseVoice / 讯飞听写 2.0）"
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
          "浏览器在线语音识别网络不可达（建议在「设置 → 语音与 Pi Agent」补齐本地 SenseVoice、配置讯飞听写 2.0 或配置 STT 接口）。";
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
   * 高性能全双工 AudioWorklet 16kHz PCM 实时采集管线：
   * - 2 路输入：Input 0 为麦克风，Input 1 为本地 TTS 实时回放参考信号（样本同步 PBFDAF AEC）
   * - 支持切后台不断流、400ms Pre-roll、双讲平滑降音（Ducking）与真打断（Barge-in）
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
      const echoMode = this.config.echoCancellationMode ?? "auto";
      const fullDuplex = this.isFullDuplexEnabled();

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          // 除用户显式关闭外，始终开启浏览器硬件回声消除（第一层 AEC）；
          // 服务端启用神经降噪/双轨抗音乐识别时关闭浏览器粗糙的 NS/AGC，避免人声被抽泵砍断！
          echoCancellation: echoMode !== "off",
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

      // 创建 TTS 主输出与 AEC 参考信号分路节点
      const ttsGain = ctx.createGain();
      ttsGain.gain.value = this.ttsDucked ? 0.14 : 1.0;
      ttsGain.connect(ctx.destination);
      this.ttsGainNode = ttsGain;

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
          numberOfInputs: 2,
          numberOfOutputs: 1,
          channelCount: 1,
          processorOptions: {
            vadThreshold: this.config.vadThreshold,
            vadSilenceMs: this.config.vadSilenceMs,
            streamMode: this.streamingOverWs,
            fullDuplex,
            bargeInEnabled: this.config.bargeInEnabled !== false,
            echoMode,
          },
        });
        this.workletNode = node;
        this.aecActive = fullDuplex && echoMode !== "off" && echoMode !== "standard";

        if (this.ttsSpeaking) {
          if (fullDuplex) {
            node.port.postMessage({ type: "tts_state", active: true });
          } else {
            node.port.postMessage({ type: "pause", paused: true });
          }
        }

        node.port.onmessage = (ev) => {
          const msg = ev.data as {
            type?: string;
            rms?: number;
            samples?: Float32Array;
            sampleRate?: number;
            buffer?: ArrayBuffer;
            active?: boolean;
            erleDb?: number;
            doubleTalk?: boolean;
            farEndActive?: boolean;
          };
          if (!msg || !this.active) return;

          if (msg.type === "level") {
            const level = Math.min(1, (msg.rms ?? 0) * 11);
            this.cb.onLevelChange(this.speakingMuted ? 0 : level);
          } else if (msg.type === "double_talk") {
            this.handleDoubleTalkSignal(Boolean(msg.active), msg.erleDb);
          } else if (msg.type === "aec_metrics") {
            if (typeof msg.erleDb === "number" && Number.isFinite(msg.erleDb)) {
              this.erleDb = Math.round(msg.erleDb * 10) / 10;
            }
            this.aecActive = Boolean(msg.active);
            if (this.ttsSpeaking) {
              this.cb.sendVoiceStreamControl?.({
                type: "voice_tts_state",
                speaking: true,
                utteranceId: this.activeTtsItem?.utteranceId,
                queueLength: this.ttsQueue.length,
                aecActive: this.aecActive,
                erleDb: this.erleDb,
                doubleTalk: Boolean(msg.doubleTalk),
              });
            }
            this.emitState(false);
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

        // Input 0: 麦克风采集信号；Input 1: 本地 TTS 远端参考信号（实时自适应回声消除）
        source.connect(node, 0, 0);
        ttsGain.connect(node, 0, 1);
        node.connect(silentGain);
        silentGain.connect(ctx.destination);
      } else {
        // 极端旧内核降级（ScriptProcessor + Pre-roll）
        this.aecActive = false;
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
        if (now - lastLoud >= this.config.vadSilenceMs || now - startedAt >= 30_000) {
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
    const duringTts = this.ttsSpeaking;
    try {
      await this.cb.onUploadAudio(blob, {
        bypassWakeWord: bypass,
        lang: this.config.voiceLang || "zh-CN",
        engine,
        filename: "voice.wav",
        asyncDispatch: this.isFullDuplexEnabled(),
        duringTtsPlayback: duringTts,
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
    this.aecActive = false;
    this.doubleTalkActive = false;
    this.clearDoubleTalkConfirmTimer();
    if (this.activeBufferSource) {
      try {
        this.activeBufferSource.onended = null;
        this.activeBufferSource.stop();
        this.activeBufferSource.disconnect();
      } catch {
        // ignore
      }
      this.activeBufferSource = null;
    }
    if (this.ttsGainNode) {
      try {
        this.ttsGainNode.disconnect();
      } catch {
        // ignore
      }
      this.ttsGainNode = null;
    }
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
