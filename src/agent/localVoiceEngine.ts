// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * 本地离线语音 AI 引擎（基于 sherpa-onnx-node）：
 * - 环境降噪：GTCRN（gtcrn_simple.onnx，实时极速）/ DPDFNet4（dpdfnet4.onnx，强效去噪）/
 *   VoxLock 目标说话人声纹锁定人声提取（sherpa-onnx-voxlock-int8），无模型时自动降级纯 TS 频谱减法
 * - 语音活动检测：Silero VAD 神经端点检测（支持离线与连续流式检测），无模型时自动降级自适应能量+过零率 VAD
 * - 声纹识别：阿里 3D-Speaker CAM++（192 维中文说话人嵌入），无模型时自动降级声学指纹
 * - 本地离线 ASR：
 *   - 主方案：Qwen3-ASR-0.6B int8（CPU ONNX 异步非阻塞 decodeAsync，高精度中英双语转写）
 *   - 备用/储备方案：FunAudioLLM SenseVoiceSmall int8（主模型未就绪或异常时自动无缝降级，亦可手动切换）
 */

import { existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_LOCAL_ASR_ENGINE,
  DEFAULT_QWEN3_COMPUTE_DEVICE,
  type LocalAsrEngineMode,
  type NoiseSuppressionMode,
  type Qwen3ComputeDeviceMode,
  type VadEngineMode,
} from "../core/agentConfigStore.ts";
import { projectRoot } from "../core/appMeta.ts";
import {
  adaptiveEnergyVad,
  applyHighPassFilter,
  estimateSnrDb,
  extractFallbackVoiceprint,
  l2Normalize,
  resampleLinear,
  spectralSubtractDenoise,
} from "./audioPcm.ts";
import {
  LocalTtsEngine,
  type LocalTtsStatus,
} from "./localTtsEngine.ts";
import {
  OPEN_WAKEWORD_MODEL_URLS,
  OpenWakeWordEngine,
  type OpenWakeWordScoreClipOptions,
  type OpenWakeWordStreamOptions,
  type OpenWakeWordStreamSession,
  type WakeWordAcousticHit,
} from "./openWakeWordEngine.ts";
import type { SystemOneClient } from "./systemOneClient.ts";
import {
  AudioSourceSeparator,
  resolveSourceSeparatorModelPaths,
} from "./audioSourceSeparator.ts";
import {
  extractCommandAfterAcousticWake,
  findWakeWordSpan,
  hasSmartHomeDomainIntent,
  isThirdPersonNeoMention,
  isWakeQueryText,
  looksLikeDirectDeviceCommand,
  matchEnglishHeadWakeWord,
} from "./voiceAttentionGate.ts";
import {
  Qwen3AsrGpuRuntime,
  type Qwen3GpuStatus,
} from "./qwen3AsrGpuRuntime.ts";
import { getPrimaryOwnerRefWavPath } from "./voiceprintStore.ts";

export type { LocalAsrEngineMode, NoiseSuppressionMode, Qwen3ComputeDeviceMode, Qwen3GpuStatus, VadEngineMode };
export { Qwen3AsrGpuRuntime };

export interface LocalVoiceModelPaths {
  modelsDir: string;
  gtcrn: string;
  dpdfnet4: string;
  voxlockDir: string;
  voxlockEnroll: string;
  voxlockChunk: string;
  sileroVad: string;
  speakerCampp: string;
  qwen3AsrDir: string;
  qwen3AsrConvFrontend: string;
  qwen3AsrEncoder: string;
  qwen3AsrDecoder: string;
  qwen3AsrTokenizer: string;
  senseVoiceDir: string;
  senseVoiceModel: string;
  senseVoiceTokens: string;
  openWakeWordDir: string;
  openWakeWordMel: string;
  openWakeWordEmbedding: string;
  cedModel: string;
  cedLabels: string;
  pyannoteSegmentation: string;
  spleeterVocals: string;
  spleeterAccompaniment: string;
}

export interface LocalVoiceEngineStatus {
  addonAvailable: boolean;
  addonVersion: string | null;
  modelsDir: string;
  models: {
    gtcrn: boolean;
    dpdfnet4: boolean;
    voxlock: boolean;
    sileroVad: boolean;
    speakerCampp: boolean;
    qwen3Asr: boolean;
    qwen3AsrGpu?: boolean;
    senseVoice: boolean;
    openWakeWord: boolean;
    cedAudioTagging?: boolean;
    pyannoteDiarization?: boolean;
    spleeterSeparation?: boolean;
    localTts?: boolean;
  };
  readyForDenoise: boolean;
  readyForDpdfnet: boolean;
  readyForVoxlock: boolean;
  readyForVad: boolean;
  readyForVoiceprint: boolean;
  readyForQwen3Asr: boolean;
  readyForQwen3Gpu: boolean;
  activeQwen3Device: "gpu" | "cpu" | null;
  qwen3ComputeDevice: Qwen3ComputeDeviceMode;
  gpu: Qwen3GpuStatus;
  readyForSenseVoice: boolean;
  readyForLocalAsr: boolean;
  primaryAsrEngine: "qwen3-asr" | "sensevoice" | null;
  fallbackAsrEngine: "sensevoice" | null;
  activeLocalAsrMode: LocalAsrEngineMode;
  readyForWakeWord: boolean;
  readyForSourceSeparation?: boolean;
  readyForLocalTts?: boolean;
  tts?: LocalTtsStatus;
  downloading: boolean;
  lastError: string | null;
}

export interface DenoiseOutput {
  samples: Float32Array;
  sampleRate: number;
  engine: "gtcrn" | "dpdfnet4" | "voxlock" | "dsp" | "off";
  inputSnrDb: number;
  outputSnrDb: number;
  snrGainDb: number;
  durationMs: number;
}

export interface VadOutput {
  hasSpeech: boolean;
  speechSamples: Float32Array;
  speechRatio: number;
  segmentCount: number;
  engine: "silero" | "adaptive";
  durationMs: number;
}

export interface SpeakerEmbeddingOutput {
  embedding: number[];
  dim: number;
  engine: "3dspeaker-campplus" | "dsp-mfcc";
  durationMs: number;
}

export type LocalAsrResultEngine =
  | "qwen3-asr-gpu"
  | "qwen3-asr-gpu-stream"
  | "qwen3-asr-gpu-dual-raw"
  | "qwen3-asr-gpu-dual-denoised"
  | "qwen3-asr-local"
  | "qwen3-asr-stream"
  | "qwen3-asr-dual-raw"
  | "qwen3-asr-dual-denoised"
  | "sensevoice-local"
  | "sensevoice-fallback"
  | "sensevoice-dual-raw"
  | "sensevoice-dual-denoised";

export interface LocalAsrTranscribeOptions {
  engine?: LocalAsrEngineMode;
  computeDevice?: Qwen3ComputeDeviceMode;
  hotwords?: readonly string[];
  maxNewTokens?: number;
  allowFallback?: boolean;
  /** 流式转写实时局部回调（GPU 模式下直接透传 SSE 逐 token 流式结果） */
  onPartial?: (partialText: string) => void;
  signal?: AbortSignal;
}

export interface LocalAsrOutput {
  text: string;
  rawText: string;
  lang: string;
  emotion: string;
  event: string;
  engine: LocalAsrResultEngine;
  durationMs: number;
  computeDevice?: "gpu" | "cpu";
  gpuDeviceName?: string | null;
  altText?: string;
  enHeadText?: string;
  scoreMargin?: number;
  fallbackUsed?: boolean;
  fallbackReason?: string;
}

export interface OnlineDenoiserHandleLike {
  sampleRate: number;
  frameShiftInSamples: number;
  run(req: { samples: Float32Array; sampleRate: number }): {
    samples: Float32Array;
    sampleRate: number;
  };
  flush(): { samples: Float32Array; sampleRate: number };
  reset(): void;
}

export interface StreamingVadHandleLike {
  acceptWaveform(samples: Float32Array): void;
  isEmpty(): boolean;
  isDetected(): boolean;
  front(): { start: number; samples: Float32Array };
  pop(): void;
  flush(): void;
  reset(): void;
  clear(): void;
}

interface SherpaModuleLike {
  version?: string;
  OfflineSpeechDenoiser: new (cfg: Record<string, unknown>) => {
    sampleRate: number;
    run(req: { samples: Float32Array; sampleRate: number }): {
      samples: Float32Array;
      sampleRate: number;
    };
  };
  OnlineSpeechDenoiser: new (cfg: Record<string, unknown>) => OnlineDenoiserHandleLike;
  Vad: new (cfg: Record<string, unknown>, bufferSizeInSeconds: number) => StreamingVadHandleLike;
  SpeakerEmbeddingExtractor: new (cfg: Record<string, unknown>) => {
    dim: number;
    createStream(): {
      acceptWaveform(req: { samples: Float32Array; sampleRate: number }): void;
      inputFinished(): void;
    };
    isReady(stream: unknown): boolean;
    compute(stream: unknown): Float32Array;
  };
  OfflineRecognizer: {
    createAsync(cfg: Record<string, unknown>): Promise<{
      createStream(): {
        acceptWaveform(req: { samples: Float32Array; sampleRate: number }): void;
        setOption?(key: string, value: string): void;
      };
      decodeAsync(stream: unknown): Promise<{
        text?: string;
        lang?: string;
        emotion?: string;
        event?: string;
      }>;
    }>;
  };
}

const MODEL_URLS = {
  gtcrn:
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/speech-enhancement-models/gtcrn_simple.onnx",
  dpdfnet4:
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/speech-enhancement-models/dpdfnet4.onnx",
  sileroVad:
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx",
  speakerCampp:
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx",
  qwen3AsrTar:
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25.tar.bz2",
  senseVoiceTar:
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2",
  cedTinyTar:
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/audio-tagging-models/sherpa-onnx-ced-tiny-audio-tagging-2024-04-19.tar.bz2",
  pyannoteSegTar:
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2",
  spleeterFp16Tar:
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/source-separation-models/sherpa-onnx-spleeter-2stems-fp16.tar.bz2",
} as const;

export const QWEN3_ASR_DIR_NAME = "sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25";
export const SENSE_VOICE_DIR_NAME = "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17";
const VOXLOCK_DIR_NAME = "sherpa-onnx-voxlock-int8";
const QWEN3_ASR_INIT_RETRY_COOLDOWN_MS = 30_000;

let cachedSherpa: SherpaModuleLike | null | undefined;

function loadSherpaModule(): SherpaModuleLike | null {
  if (cachedSherpa !== undefined) {
    return cachedSherpa;
  }
  try {
    const req = createRequire(import.meta.url);
    const mod = req("sherpa-onnx-node") as SherpaModuleLike;
    if (mod && typeof mod.OfflineRecognizer === "function") {
      cachedSherpa = mod;
      return cachedSherpa;
    }
  } catch {
    // 优雅降级：缺少原生包时仍可使用纯 TS DSP + 云端/浏览器识别
  }
  cachedSherpa = null;
  return null;
}

export function resolveVoiceModelPaths(modelsDirOverride?: string): LocalVoiceModelPaths {
  const envDir = process.env.MIJIADECK_VOICE_MODELS_DIR?.trim();
  const modelsDir = path.resolve(
    modelsDirOverride || envDir || path.join(projectRoot(), "voice_models"),
  );
  const qwen3AsrDir = path.join(modelsDir, QWEN3_ASR_DIR_NAME);
  const senseVoiceDir = path.join(modelsDir, SENSE_VOICE_DIR_NAME);
  const voxlockDir = path.join(modelsDir, VOXLOCK_DIR_NAME);
  const openWakeWordDir = path.join(modelsDir, "openwakeword");
  const sepPaths = resolveSourceSeparatorModelPaths(modelsDir);
  return {
    modelsDir,
    gtcrn: path.join(modelsDir, "gtcrn_simple.onnx"),
    dpdfnet4: path.join(modelsDir, "dpdfnet4.onnx"),
    voxlockDir,
    voxlockEnroll: path.join(voxlockDir, "enroll.onnx"),
    voxlockChunk: path.join(voxlockDir, "chunk_int8.onnx"),
    sileroVad: path.join(modelsDir, "silero_vad.onnx"),
    speakerCampp: path.join(modelsDir, "3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx"),
    qwen3AsrDir,
    qwen3AsrConvFrontend: path.join(qwen3AsrDir, "conv_frontend.onnx"),
    qwen3AsrEncoder: path.join(qwen3AsrDir, "encoder.int8.onnx"),
    qwen3AsrDecoder: path.join(qwen3AsrDir, "decoder.int8.onnx"),
    qwen3AsrTokenizer: path.join(qwen3AsrDir, "tokenizer"),
    senseVoiceDir,
    senseVoiceModel: path.join(senseVoiceDir, "model.int8.onnx"),
    senseVoiceTokens: path.join(senseVoiceDir, "tokens.txt"),
    openWakeWordDir,
    openWakeWordMel: path.join(openWakeWordDir, "melspectrogram.onnx"),
    openWakeWordEmbedding: path.join(openWakeWordDir, "embedding_model.onnx"),
    cedModel: sepPaths.cedModel,
    cedLabels: sepPaths.cedLabels,
    pyannoteSegmentation: sepPaths.pyannoteSegmentation,
    spleeterVocals: sepPaths.spleeterVocals,
    spleeterAccompaniment: sepPaths.spleeterAccompaniment,
  };
}

/**
 * 清洗 SenseVoice 输出中的特殊标签（如 <|zh|><|NEUTRAL|><|Speech|><|woitn|>）并标准化文本。
 */
export function cleanSenseVoiceText(raw: string): string {
  return raw
    .replace(/<\|[^|>]+\|>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 清洗 Qwen3-ASR 输出中可能残留的语言脚手架前缀（如 `language Chinese<asr_text>`）与特殊控制标签。
 */
export function cleanQwen3AsrText(raw: string): string {
  return raw
    .replace(/^\s*language\s+[A-Za-z_-]+\s*<asr_text>\s*/i, "")
    .replace(/<asr_text>/gi, " ")
    .replace(/<\|[^|>]+\|>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function mapSenseVoiceLang(voiceLang?: string): string {
  const lower = (voiceLang ?? "").trim().toLowerCase();
  if (!lower || lower === "auto") return "auto";
  if (lower.startsWith("zh-hk") || lower.includes("yue")) return "yue";
  if (lower.startsWith("zh")) return "zh";
  if (lower.startsWith("en")) return "en";
  if (lower.startsWith("ja")) return "ja";
  if (lower.startsWith("ko")) return "ko";
  return "auto";
}

/**
 * 将 UI 识别语言映射为 Qwen3-ASR `stream.setOption("language", ...)` 支持的语种名。
 * 中文（zh-CN）与 auto 保持空字符串以启用 Qwen3-ASR 原生中英混说自动识别。
 */
export function mapQwen3AsrLang(voiceLang?: string): string {
  const lower = (voiceLang ?? "").trim().toLowerCase();
  if (!lower || lower === "auto" || lower === "zh" || lower.startsWith("zh-cn")) return "";
  if (lower.startsWith("zh-hk") || lower.includes("yue")) return "Cantonese";
  if (lower.startsWith("en")) return "English";
  if (lower.startsWith("ja")) return "Japanese";
  if (lower.startsWith("ko")) return "Korean";
  return "";
}

/**
 * 抗音乐/强噪双轨 ASR 候选评分器：
 * 结合实测规律：
 * - 在强音乐播放（0dB / -3dB）下，未受神经降噪伪影破坏的 Raw 高通轨往往保留了完整爆破音（如“小派”和数字“35”）；
 * - 而在极低信噪比或稳态宽带/风扇噪声下，神经降噪轨又能拯救被底噪淹没的音节；
 * 通过对双轨解码结果做唤醒词完整度 + 指令清晰度 + 声学事件打分，取最优识别结果。
 */
export function chooseBestAsrCandidate(
  rawAsr: LocalAsrOutput,
  denoisedAsr: LocalAsrOutput,
  options: {
    wakeWords: readonly string[];
    inputSnrDb?: number;
    acousticWake?: WakeWordAcousticHit | null;
  },
): LocalAsrOutput {
  const score = (cand: LocalAsrOutput, track: "raw" | "denoised"): number => {
    const text = cand.text.trim();
    if (!text) return -100;
    let s = Math.min(18, text.length * 0.9);

    const span = findWakeWordSpan(text, options.wakeWords);
    if (span) {
      s += span.fuzzy ? 75 : 105;
      if (span.afterText && looksLikeDirectDeviceCommand(span.afterText)) {
        s += 45;
      }
      if (span.beforeText.length <= 2) {
        s += 12;
      }
    } else if (looksLikeDirectDeviceCommand(text)) {
      s += 28;
    } else if (options.acousticWake?.matched) {
      const postCmd = extractCommandAfterAcousticWake(text, options.acousticWake.wakeWord);
      if (postCmd && looksLikeDirectDeviceCommand(postCmd)) {
        s += 36;
      }
    }

    const isBgm = rawAsr.event.toUpperCase().includes("BGM");
    if (cand.event.toUpperCase().includes("SPEECH")) {
      s += 10;
    }
    if (track === "raw" && isBgm) {
      // 音乐场景下优先信任无神经伪影的原始高通轨
      s += 18;
    } else if (track === "denoised" && !isBgm && (options.inputSnrDb ?? 20) < 15) {
      // 非音乐稳态强噪场景优先信任神经降噪轨
      s += 14;
    }

    // 惩罚异常非中英乱码字符（如强噪误识别出日韩假名）
    const weirdMatches = text.match(/[\u3040-\u30ff\uac00-\ud7af]/g);
    if (weirdMatches && weirdMatches.length > 0) {
      s -= weirdMatches.length * 12;
    }
    return s;
  };

  const rawScore = score(rawAsr, "raw");
  const denScore = score(denoisedAsr, "denoised");
  const scoreMargin = Number(Math.abs(rawScore - denScore).toFixed(2));

  if (rawScore >= denScore) {
    const engine: LocalAsrResultEngine = rawAsr.engine.startsWith("qwen3-asr-gpu")
      ? "qwen3-asr-gpu-dual-raw"
      : rawAsr.engine.startsWith("qwen3-asr")
        ? "qwen3-asr-dual-raw"
        : "sensevoice-dual-raw";
    return {
      ...rawAsr,
      engine,
      durationMs: rawAsr.durationMs + denoisedAsr.durationMs,
      altText: denoisedAsr.text,
      scoreMargin,
    };
  }
  const engine: LocalAsrResultEngine = denoisedAsr.engine.startsWith("qwen3-asr-gpu")
    ? "qwen3-asr-gpu-dual-denoised"
    : denoisedAsr.engine.startsWith("qwen3-asr")
      ? "qwen3-asr-dual-denoised"
      : "sensevoice-dual-denoised";
  return {
    ...denoisedAsr,
    engine,
    durationMs: rawAsr.durationMs + denoisedAsr.durationMs,
    altText: rawAsr.text,
    scoreMargin,
  };
}

export class LocalVoiceEngine {
  private readonly _modelsDirOverride?: string;
  private readonly _oww: OpenWakeWordEngine;
  private readonly _tts: LocalTtsEngine;
  private readonly _qwen3Gpu: Qwen3AsrGpuRuntime;
  private _preferredAsrEngine: LocalAsrEngineMode = DEFAULT_LOCAL_ASR_ENGINE;
  private _qwen3ComputeDevice: Qwen3ComputeDeviceMode = DEFAULT_QWEN3_COMPUTE_DEVICE;
  private _sourceSeparator: AudioSourceSeparator | null = null;
  private _gtcrnDenoiser: InstanceType<SherpaModuleLike["OfflineSpeechDenoiser"]> | null = null;
  private _dpdfnetDenoiser: InstanceType<SherpaModuleLike["OfflineSpeechDenoiser"]> | null = null;
  private _voxlockDenoiser: {
    refPath: string;
    instance: InstanceType<SherpaModuleLike["OfflineSpeechDenoiser"]>;
  } | null = null;
  private _speakerExtractor: InstanceType<SherpaModuleLike["SpeakerEmbeddingExtractor"]> | null =
    null;
  private _qwen3AsrRecognizer: Promise<
    Awaited<ReturnType<SherpaModuleLike["OfflineRecognizer"]["createAsync"]>>
  > | null = null;
  private _qwen3AsrInitFailedAt = 0;
  private _qwen3AsrInitError: string | null = null;
  private _recognizers = new Map<
    string,
    Promise<Awaited<ReturnType<SherpaModuleLike["OfflineRecognizer"]["createAsync"]>>>
  >();
  private _downloading = false;
  private _lastError: string | null = null;

  constructor(
    options: {
      modelsDir?: string;
      preferredAsrEngine?: LocalAsrEngineMode;
      qwen3ComputeDevice?: Qwen3ComputeDeviceMode;
    } = {},
  ) {
    this._modelsDirOverride = options.modelsDir;
    this._preferredAsrEngine = options.preferredAsrEngine ?? DEFAULT_LOCAL_ASR_ENGINE;
    this._qwen3ComputeDevice = options.qwen3ComputeDevice ?? DEFAULT_QWEN3_COMPUTE_DEVICE;
    const p = resolveVoiceModelPaths(options.modelsDir);
    this._oww = new OpenWakeWordEngine({ modelsDir: p.modelsDir });
    this._tts = new LocalTtsEngine({ modelsDir: p.modelsDir });
    this._qwen3Gpu = new Qwen3AsrGpuRuntime({ modelsDir: p.modelsDir });
  }

  get preferredAsrEngine(): LocalAsrEngineMode {
    return this._preferredAsrEngine;
  }

  set preferredAsrEngine(mode: LocalAsrEngineMode) {
    if (this._preferredAsrEngine !== mode) {
      this._preferredAsrEngine = mode;
      // 切换策略时重置 Qwen3-ASR 失败冷却以便立即重检
      this._qwen3AsrInitFailedAt = 0;
      this._qwen3AsrInitError = null;
      this._qwen3Gpu.resetFailureCooldown();
    }
  }

  setPreferredAsrEngine(mode: LocalAsrEngineMode): void {
    this.preferredAsrEngine = mode;
  }

  get qwen3ComputeDevice(): Qwen3ComputeDeviceMode {
    return this._qwen3ComputeDevice;
  }

  set qwen3ComputeDevice(mode: Qwen3ComputeDeviceMode) {
    if (this._qwen3ComputeDevice !== mode) {
      this._qwen3ComputeDevice = mode;
      this._qwen3Gpu.resetFailureCooldown();
    }
  }

  setQwen3ComputeDevice(mode: Qwen3ComputeDeviceMode): void {
    this.qwen3ComputeDevice = mode;
  }

  get qwen3Gpu(): Qwen3AsrGpuRuntime {
    return this._qwen3Gpu;
  }

  get paths(): LocalVoiceModelPaths {
    return resolveVoiceModelPaths(this._modelsDirOverride);
  }

  get openWakeWord(): OpenWakeWordEngine {
    return this._oww;
  }

  get tts(): LocalTtsEngine {
    return this._tts;
  }

  get sourceSeparator(): AudioSourceSeparator {
    if (!this._sourceSeparator) {
      this._sourceSeparator = new AudioSourceSeparator(this);
    }
    return this._sourceSeparator;
  }

  createWakeWordStream(
    wakeWords: readonly string[],
    opts?: OpenWakeWordStreamOptions,
  ): OpenWakeWordStreamSession | null {
    if (!this._oww.isReady && !this._oww.ensureLoaded()) {
      return null;
    }
    return this._oww.createStreamSession(wakeWords, opts);
  }

  scoreWakeWordAudio(
    pcm16k: Float32Array,
    wakeWords: readonly string[],
    opts?: OpenWakeWordScoreClipOptions,
  ): WakeWordAcousticHit | null {
    if (!this._oww.isReady && !this._oww.ensureLoaded()) {
      return null;
    }
    return this._oww.scoreClip(pcm16k, wakeWords, opts);
  }

  private _hasQwen3AsrModels(p: LocalVoiceModelPaths = this.paths): boolean {
    return (
      existsSync(p.qwen3AsrConvFrontend) &&
      existsSync(p.qwen3AsrEncoder) &&
      existsSync(p.qwen3AsrDecoder) &&
      existsSync(p.qwen3AsrTokenizer) &&
      existsSync(path.join(p.qwen3AsrTokenizer, "vocab.json"))
    );
  }

  private _hasSenseVoiceModels(p: LocalVoiceModelPaths = this.paths): boolean {
    return existsSync(p.senseVoiceModel) && existsSync(p.senseVoiceTokens);
  }

  getStatus(): LocalVoiceEngineStatus {
    const sherpa = loadSherpaModule();
    const p = this.paths;
    const gtcrn = existsSync(p.gtcrn);
    const dpdfnet4 = existsSync(p.dpdfnet4);
    const voxlock = existsSync(p.voxlockEnroll) && existsSync(p.voxlockChunk);
    const sileroVad = existsSync(p.sileroVad);
    const speakerCampp = existsSync(p.speakerCampp);
    const qwen3AsrCpu = this._hasQwen3AsrModels(p);
    const gpuStatus = this._qwen3Gpu.getStatus();
    const readyForQwen3Gpu = gpuStatus.ready;
    const qwen3AsrGpu = gpuStatus.runtimeReady && gpuStatus.modelReady;
    const senseVoice = this._hasSenseVoiceModels(p);
    const openWakeWord = existsSync(p.openWakeWordMel) && existsSync(p.openWakeWordEmbedding);
    const cedAudioTagging = existsSync(p.cedModel) && existsSync(p.cedLabels);
    const pyannoteDiarization = existsSync(p.pyannoteSegmentation) && speakerCampp;
    const spleeterSeparation = existsSync(p.spleeterVocals) && existsSync(p.spleeterAccompaniment);
    const ttsStatus = this._tts.getStatus();
    const addonAvailable = sherpa !== null;
    const readyForQwen3Cpu = addonAvailable && qwen3AsrCpu;
    const useGpuEligible = this._qwen3ComputeDevice !== "cpu" && readyForQwen3Gpu;
    const readyForQwen3Asr = useGpuEligible || readyForQwen3Cpu;
    const activeQwen3Device: "gpu" | "cpu" | null =
      this._qwen3ComputeDevice === "cpu"
        ? readyForQwen3Cpu
          ? "cpu"
          : null
        : readyForQwen3Gpu
          ? "gpu"
          : readyForQwen3Cpu
            ? "cpu"
            : null;
    const readyForSenseVoice = addonAvailable && senseVoice;
    const readyForLocalAsr =
      this._preferredAsrEngine === "qwen3-asr"
        ? readyForQwen3Asr
        : this._preferredAsrEngine === "sensevoice"
          ? readyForSenseVoice
          : readyForQwen3Asr || readyForSenseVoice;
    const primaryAsrEngine: "qwen3-asr" | "sensevoice" | null =
      this._preferredAsrEngine === "sensevoice"
        ? readyForSenseVoice
          ? "sensevoice"
          : null
        : readyForQwen3Asr
          ? "qwen3-asr"
          : this._preferredAsrEngine === "auto" && readyForSenseVoice
            ? "sensevoice"
            : null;
    const fallbackAsrEngine: "sensevoice" | null = readyForSenseVoice ? "sensevoice" : null;
    return {
      addonAvailable,
      addonVersion: sherpa?.version ?? null,
      modelsDir: p.modelsDir,
      models: {
        gtcrn,
        dpdfnet4,
        voxlock,
        sileroVad,
        speakerCampp,
        qwen3Asr: qwen3AsrCpu || qwen3AsrGpu,
        qwen3AsrGpu,
        senseVoice,
        openWakeWord,
        cedAudioTagging,
        pyannoteDiarization,
        spleeterSeparation,
        localTts: ttsStatus.ready,
      },
      readyForDenoise: addonAvailable && gtcrn,
      readyForDpdfnet: addonAvailable && dpdfnet4,
      readyForVoxlock: addonAvailable && voxlock,
      readyForVad: addonAvailable && sileroVad,
      readyForVoiceprint: addonAvailable && speakerCampp,
      readyForQwen3Asr,
      readyForQwen3Gpu,
      activeQwen3Device,
      qwen3ComputeDevice: this._qwen3ComputeDevice,
      gpu: gpuStatus,
      readyForSenseVoice,
      readyForLocalAsr,
      primaryAsrEngine,
      fallbackAsrEngine,
      activeLocalAsrMode: this._preferredAsrEngine,
      readyForWakeWord: this._oww.getStatus().ready,
      readyForSourceSeparation:
        readyForLocalAsr && (cedAudioTagging || pyannoteDiarization || spleeterSeparation),
      readyForLocalTts: ttsStatus.ready,
      tts: ttsStatus,
      downloading: this._downloading || ttsStatus.downloading,
      lastError: this._lastError ?? gpuStatus.lastError ?? ttsStatus.lastError,
    };
  }

  private _numThreads(): number {
    return Math.min(4, Math.max(2, Math.floor(os.cpus().length / 2)));
  }

  /**
   * Qwen3-ASR-0.6B int8 CPU 推理线程数：取物理核数（上限 6），兼顾大矩阵乘吞吐与事件循环平滑响应。
   */
  private _qwen3AsrThreads(): number {
    return Math.min(6, Math.max(2, Math.floor(os.cpus().length / 2)));
  }

  /**
   * 帧级递归降噪模型（GTCRN / DPDFNet4）实测在单线程下省去每帧线程栅栏开销，速度提升约 10%~25%
   * 且不与并行 ASR/Spleeter 争抢线程池。
   */
  private _denoiserThreads(): number {
    return 1;
  }

  /**
   * 后台异步分阶段预热本地 ONNX 模型（GTCRN / CAM++ / Qwen3-ASR 主方案或 SenseVoice 备用 / openWakeWord），
   * 每步让出事件循环避免启动/开麦瞬间卡顿。
   */
  async warmup(
    options: {
      preloadEnglish?: boolean;
      localAsrEngine?: LocalAsrEngineMode;
      qwen3ComputeDevice?: Qwen3ComputeDeviceMode;
    } = {},
  ): Promise<void> {
    const yieldTick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
    const mode = options.localAsrEngine ?? this._preferredAsrEngine;
    const deviceMode = options.qwen3ComputeDevice ?? this._qwen3ComputeDevice;
    try {
      this._oww.ensureLoaded();
      await yieldTick();
      this._ensureGtcrnDenoiser();
      await yieldTick();
      this._ensureSpeakerExtractor();
      await yieldTick();
      if (mode !== "sensevoice") {
        // 1. 若检测到可用 GPU 且未强制仅 CPU，优先预热 GPU 运行时（含 Vulkan 着色器预热），无需加载 9.5s CPU ONNX
        if (deviceMode !== "cpu" && this._qwen3Gpu.getStatus().ready && !this._qwen3Gpu.isInFailureCooldown()) {
          try {
            await this._qwen3Gpu.warmup();
            if (options.preloadEnglish && this._hasSenseVoiceModels()) {
              await yieldTick();
              await this._ensureRecognizer("en");
            }
            return;
          } catch {
            // GPU 预热失败自动回落 CPU Qwen3-ASR
          }
        }
        // 2. CPU Qwen3-ASR 预热
        if (this._hasQwen3AsrModels()) {
          try {
            await this._ensureQwen3AsrRecognizer();
            if (options.preloadEnglish && this._hasSenseVoiceModels()) {
              await yieldTick();
              await this._ensureRecognizer("en");
            }
            return;
          } catch {
            // 主方案预热失败时按 auto 策略降级预热 SenseVoice 储备模型
            if (mode === "qwen3-asr") return;
          }
        }
      }
      await this._ensureRecognizer("auto");
      if (options.preloadEnglish) {
        await yieldTick();
        await this._ensureRecognizer("en");
      }
    } catch {
      // 预热失败不影响后续按需重试或降级
    }
  }

  private _ensureGtcrnDenoiser(): InstanceType<SherpaModuleLike["OfflineSpeechDenoiser"]> | null {
    if (this._gtcrnDenoiser) return this._gtcrnDenoiser;
    const sherpa = loadSherpaModule();
    const p = this.paths;
    if (!sherpa || !existsSync(p.gtcrn)) return null;
    try {
      this._gtcrnDenoiser = new sherpa.OfflineSpeechDenoiser({
        model: {
          gtcrn: { model: p.gtcrn },
          numThreads: this._denoiserThreads(),
          debug: false,
          provider: "cpu",
        },
      });
      return this._gtcrnDenoiser;
    } catch (err) {
      this._lastError = err instanceof Error ? err.message : String(err);
      return null;
    }
  }

  private _ensureDpdfnetDenoiser(): InstanceType<SherpaModuleLike["OfflineSpeechDenoiser"]> | null {
    if (this._dpdfnetDenoiser) return this._dpdfnetDenoiser;
    const sherpa = loadSherpaModule();
    const p = this.paths;
    if (!sherpa || !existsSync(p.dpdfnet4)) return null;
    try {
      this._dpdfnetDenoiser = new sherpa.OfflineSpeechDenoiser({
        model: {
          dpdfnet: { model: p.dpdfnet4 },
          numThreads: this._denoiserThreads(),
          debug: false,
          provider: "cpu",
        },
      });
      return this._dpdfnetDenoiser;
    } catch (err) {
      this._lastError = err instanceof Error ? err.message : String(err);
      return null;
    }
  }

  private _ensureVoxlockDenoiser(
    voiceSamplePath?: string | null,
  ): InstanceType<SherpaModuleLike["OfflineSpeechDenoiser"]> | null {
    const sherpa = loadSherpaModule();
    const p = this.paths;
    if (!sherpa || !existsSync(p.voxlockEnroll) || !existsSync(p.voxlockChunk)) return null;
    const refPath = (voiceSamplePath ?? getPrimaryOwnerRefWavPath() ?? "").trim();
    if (this._voxlockDenoiser && this._voxlockDenoiser.refPath === refPath) {
      return this._voxlockDenoiser.instance;
    }
    try {
      const instance = new sherpa.OfflineSpeechDenoiser({
        model: {
          voxlock: {
            enrollModel: p.voxlockEnroll,
            chunkModel: p.voxlockChunk,
            ...(refPath && existsSync(refPath) ? { voiceSample: refPath } : {}),
          },
          numThreads: this._numThreads(),
          debug: false,
          provider: "cpu",
        },
      });
      this._voxlockDenoiser = { refPath, instance };
      return instance;
    } catch (err) {
      this._lastError = err instanceof Error ? err.message : String(err);
      return null;
    }
  }

  /**
   * 为连续 WebSocket 音频流创建独立的实时流式神经降噪器（GTCRN / DPDFNet4 / VoxLock）。
   */
  createOnlineDenoiser(
    mode: NoiseSuppressionMode = "auto",
  ): { denoiser: OnlineDenoiserHandleLike; engine: "gtcrn" | "dpdfnet4" | "voxlock" } | null {
    if (mode === "off" || mode === "dsp") return null;
    const sherpa = loadSherpaModule();
    const p = this.paths;
    if (!sherpa || typeof sherpa.OnlineSpeechDenoiser !== "function") return null;

    try {
      if (mode === "voxlock" && existsSync(p.voxlockEnroll) && existsSync(p.voxlockChunk)) {
        const refPath = getPrimaryOwnerRefWavPath();
        return {
          engine: "voxlock",
          denoiser: new sherpa.OnlineSpeechDenoiser({
            model: {
              voxlock: {
                enrollModel: p.voxlockEnroll,
                chunkModel: p.voxlockChunk,
                ...(refPath && existsSync(refPath) ? { voiceSample: refPath } : {}),
              },
              numThreads: this._numThreads(),
              debug: false,
              provider: "cpu",
            },
          }),
        };
      }
      if (mode === "dpdfnet" && existsSync(p.dpdfnet4)) {
        return {
          engine: "dpdfnet4",
          denoiser: new sherpa.OnlineSpeechDenoiser({
            model: {
              dpdfnet: { model: p.dpdfnet4 },
              numThreads: this._denoiserThreads(),
              debug: false,
              provider: "cpu",
            },
          }),
        };
      }
      if (existsSync(p.gtcrn)) {
        return {
          engine: "gtcrn",
          denoiser: new sherpa.OnlineSpeechDenoiser({
            model: {
              gtcrn: { model: p.gtcrn },
              numThreads: this._denoiserThreads(),
              debug: false,
              provider: "cpu",
            },
          }),
        };
      }
    } catch (err) {
      this._lastError = err instanceof Error ? err.message : String(err);
    }
    return null;
  }

  /**
   * 为连续 WebSocket 音频流创建实时 Silero VAD 实例。
   */
  createStreamingVad(options: {
    threshold?: number;
    minSilenceDuration?: number;
    minSpeechDuration?: number;
    maxSpeechDuration?: number;
  } = {}): StreamingVadHandleLike | null {
    const sherpa = loadSherpaModule();
    const p = this.paths;
    if (!sherpa || !existsSync(p.sileroVad)) return null;
    try {
      return new sherpa.Vad(
        {
          sileroVad: {
            model: p.sileroVad,
            threshold: options.threshold ?? 0.42,
            minSilenceDuration: options.minSilenceDuration ?? 0.45,
            minSpeechDuration: options.minSpeechDuration ?? 0.18,
            maxSpeechDuration: options.maxSpeechDuration ?? 4.2,
            windowSize: 512,
          },
          sampleRate: 16000,
          numThreads: 1,
          provider: "cpu",
          debug: false,
        },
        30,
      );
    } catch (err) {
      this._lastError = err instanceof Error ? err.message : String(err);
      return null;
    }
  }

  private _ensureSpeakerExtractor(): InstanceType<
    SherpaModuleLike["SpeakerEmbeddingExtractor"]
  > | null {
    if (this._speakerExtractor) return this._speakerExtractor;
    const sherpa = loadSherpaModule();
    const p = this.paths;
    if (!sherpa || !existsSync(p.speakerCampp)) return null;
    try {
      this._speakerExtractor = new sherpa.SpeakerEmbeddingExtractor({
        model: p.speakerCampp,
        numThreads: this._numThreads(),
        debug: false,
        provider: "cpu",
      });
      return this._speakerExtractor;
    } catch (err) {
      this._lastError = err instanceof Error ? err.message : String(err);
      return null;
    }
  }

  private async _ensureQwen3AsrRecognizer(): Promise<
    Awaited<ReturnType<SherpaModuleLike["OfflineRecognizer"]["createAsync"]>> | null
  > {
    const sherpa = loadSherpaModule();
    const p = this.paths;
    if (!sherpa || !this._hasQwen3AsrModels(p)) {
      return null;
    }
    if (this._qwen3AsrRecognizer) {
      return this._qwen3AsrRecognizer;
    }
    const promise = sherpa.OfflineRecognizer.createAsync({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        qwen3Asr: {
          convFrontend: p.qwen3AsrConvFrontend,
          encoder: p.qwen3AsrEncoder,
          decoder: p.qwen3AsrDecoder,
          tokenizer: p.qwen3AsrTokenizer,
          hotwords: "",
          maxTotalLen: 512,
          maxNewTokens: 128,
          temperature: 1e-6,
          topP: 0.8,
          seed: 42,
        },
        tokens: "",
        numThreads: this._qwen3AsrThreads(),
        debug: false,
        provider: "cpu",
      },
    })
      .then((rec) => {
        this._qwen3AsrInitFailedAt = 0;
        this._qwen3AsrInitError = null;
        return rec;
      })
      .catch((err) => {
        this._qwen3AsrRecognizer = null;
        this._qwen3AsrInitFailedAt = Date.now();
        this._qwen3AsrInitError = err instanceof Error ? err.message : String(err);
        this._lastError = this._qwen3AsrInitError;
        throw err;
      });
    this._qwen3AsrRecognizer = promise;
    return promise;
  }

  private async _ensureRecognizer(
    langKey: string,
  ): Promise<Awaited<ReturnType<SherpaModuleLike["OfflineRecognizer"]["createAsync"]>> | null> {
    const sherpa = loadSherpaModule();
    const p = this.paths;
    if (!sherpa || !this._hasSenseVoiceModels(p)) {
      return null;
    }
    const existing = this._recognizers.get(langKey);
    if (existing) {
      return existing;
    }
    const promise = sherpa.OfflineRecognizer.createAsync({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        senseVoice: {
          model: p.senseVoiceModel,
          language: langKey,
          useInverseTextNormalization: 1,
        },
        tokens: p.senseVoiceTokens,
        numThreads: this._numThreads(),
        debug: false,
        provider: "cpu",
      },
    }).catch((err) => {
      this._recognizers.delete(langKey);
      this._lastError = err instanceof Error ? err.message : String(err);
      throw err;
    });
    this._recognizers.set(langKey, promise);
    return promise;
  }

  /**
   * 实时语音环境降噪：支持 GTCRN / DPDFNet4 / VoxLock 目标人声提取，缺失或指定 dsp 时自动使用纯 TS 频谱减法。
   */
  denoise(
    input: Float32Array,
    sampleRate = 16000,
    mode: NoiseSuppressionMode = "auto",
    options: { voiceSamplePath?: string | null } = {},
  ): DenoiseOutput {
    const t0 = performance.now();
    const pcm16k = sampleRate === 16000 ? input : resampleLinear(input, sampleRate, 16000);
    const inputSnrDb = estimateSnrDb(pcm16k, 16000);

    if (mode === "off" || pcm16k.length < 320) {
      return {
        samples: pcm16k,
        sampleRate: 16000,
        engine: "off",
        inputSnrDb,
        outputSnrDb: inputSnrDb,
        snrGainDb: 0,
        durationMs: Math.round(performance.now() - t0),
      };
    }

    const runNeural = (
      denoiser: InstanceType<SherpaModuleLike["OfflineSpeechDenoiser"]> | null,
      engineName: "gtcrn" | "dpdfnet4" | "voxlock",
    ): DenoiseOutput | null => {
      if (!denoiser) return null;
      try {
        const out = denoiser.run({ samples: pcm16k, sampleRate: 16000 });
        const resSamples =
          out.sampleRate === 16000
            ? out.samples
            : resampleLinear(out.samples, out.sampleRate, 16000);
        const outputSnrDb = estimateSnrDb(resSamples, 16000);
        return {
          samples: resSamples,
          sampleRate: 16000,
          engine: engineName,
          inputSnrDb,
          outputSnrDb,
          snrGainDb: Number((outputSnrDb - inputSnrDb).toFixed(2)),
          durationMs: Math.round(performance.now() - t0),
        };
      } catch (err) {
        this._lastError = err instanceof Error ? err.message : String(err);
        return null;
      }
    };

    if (mode === "voxlock") {
      const r = runNeural(this._ensureVoxlockDenoiser(options.voiceSamplePath), "voxlock");
      if (r) return r;
    }
    if (mode === "dpdfnet") {
      const r = runNeural(this._ensureDpdfnetDenoiser(), "dpdfnet4");
      if (r) return r;
    }
    if (mode === "auto" || mode === "neural" || mode === "dpdfnet" || mode === "voxlock") {
      const r = runNeural(this._ensureGtcrnDenoiser(), "gtcrn");
      if (r) return r;
    }

    const dsp = spectralSubtractDenoise(pcm16k, 16000);
    return {
      samples: dsp.samples,
      sampleRate: 16000,
      engine: "dsp",
      inputSnrDb: dsp.inputSnrDb,
      outputSnrDb: dsp.outputSnrDb,
      snrGainDb: dsp.snrGainDb,
      durationMs: Math.round(performance.now() - t0),
    };
  }

  /**
   * 神经语音活动检测（Silero VAD）：精准分离人声段与纯噪声/敲击/音乐，并保留前后 120ms 缓冲避免吞字。
   */
  detectSpeechSegments(
    input: Float32Array,
    sampleRate = 16000,
    options: { mode?: VadEngineMode; threshold?: number } = {},
  ): VadOutput {
    const t0 = performance.now();
    const pcm16k = sampleRate === 16000 ? input : resampleLinear(input, sampleRate, 16000);
    const mode = options.mode ?? "silero";
    const vad = mode === "silero" && pcm16k.length >= 512
      ? this.createStreamingVad({
          threshold: Math.max(0.15, Math.min(0.85, options.threshold ?? 0.4)),
          minSilenceDuration: 0.3,
          minSpeechDuration: 0.14,
          maxSpeechDuration: 20,
        })
      : null;

    if (vad) {
      try {
        const win = 512;
        for (let off = 0; off + win <= pcm16k.length; off += win) {
          vad.acceptWaveform(pcm16k.subarray(off, off + win));
        }
        vad.flush();

        const segments: Array<{ start: number; end: number }> = [];
        const padSamples = Math.round(16000 * 0.14); // 前后各留 140ms 安全余量
        let rawSpeechSamples = 0;

        while (!vad.isEmpty()) {
          const seg = vad.front();
          vad.pop();
          if (seg && seg.samples && seg.samples.length > 0) {
            rawSpeechSamples += seg.samples.length;
            const s = Math.max(0, seg.start - padSamples);
            const e = Math.min(pcm16k.length, seg.start + seg.samples.length + padSamples);
            const prev = segments[segments.length - 1];
            if (prev && s <= prev.end) {
              prev.end = Math.max(prev.end, e);
            } else {
              segments.push({ start: s, end: e });
            }
          }
        }
        vad.clear();

        if (segments.length === 0) {
          return {
            hasSpeech: false,
            speechSamples: new Float32Array(0),
            speechRatio: 0,
            segmentCount: 0,
            engine: "silero",
            durationMs: Math.round(performance.now() - t0),
          };
        }

        const totalLen = segments.reduce((acc, seg) => acc + (seg.end - seg.start), 0);
        const merged = new Float32Array(totalLen);
        let writePos = 0;
        for (const seg of segments) {
          const slice = pcm16k.subarray(seg.start, seg.end);
          merged.set(slice, writePos);
          writePos += slice.length;
        }

        return {
          hasSpeech: merged.length >= Math.round(16000 * 0.16),
          speechSamples: merged,
          speechRatio: Number(Math.min(1, rawSpeechSamples / Math.max(1, pcm16k.length)).toFixed(3)),
          segmentCount: segments.length,
          engine: "silero",
          durationMs: Math.round(performance.now() - t0),
        };
      } catch (err) {
        this._lastError = err instanceof Error ? err.message : String(err);
      }
    }

    const fallback = adaptiveEnergyVad(pcm16k, 16000);
    return {
      hasSpeech: fallback.hasSpeech,
      speechSamples: fallback.speechSamples,
      speechRatio: fallback.speechRatio,
      segmentCount: fallback.segmentCount,
      engine: "adaptive",
      durationMs: Math.round(performance.now() - t0),
    };
  }

  /**
   * 声纹特征提取：优先 3D-Speaker CAM++（192 维深度说话人嵌入），缺失时自动降级 64 维梅尔声学指纹。
   */
  extractSpeakerEmbedding(input: Float32Array, sampleRate = 16000): SpeakerEmbeddingOutput {
    const t0 = performance.now();
    const pcm16k = sampleRate === 16000 ? input : resampleLinear(input, sampleRate, 16000);
    const extractor = this._ensureSpeakerExtractor();

    if (extractor && pcm16k.length >= 4000) {
      try {
        const stream = extractor.createStream();
        stream.acceptWaveform({ samples: pcm16k, sampleRate: 16000 });
        stream.inputFinished();
        if (extractor.isReady(stream)) {
          const rawVec = extractor.compute(stream);
          const normalized = l2Normalize(rawVec);
          return {
            embedding: normalized,
            dim: normalized.length,
            engine: "3dspeaker-campplus",
            durationMs: Math.round(performance.now() - t0),
          };
        }
      } catch (err) {
        this._lastError = err instanceof Error ? err.message : String(err);
      }
    }

    const fallbackVec = extractFallbackVoiceprint(pcm16k, 16000);
    return {
      embedding: fallbackVec,
      dim: fallbackVec.length,
      engine: "dsp-mfcc",
      durationMs: Math.round(performance.now() - t0),
    };
  }

  /**
   * 主方案：本地离线 Qwen3-ASR-0.6B（自动识别 GPU 优先加速，无 GPU 或异常时自动无缝回退 CPU ONNX）。
   */
  async transcribeWithQwen3Asr(
    input: Float32Array,
    sampleRate = 16000,
    voiceLang = "zh-CN",
    options: Pick<
      LocalAsrTranscribeOptions,
      "hotwords" | "maxNewTokens" | "computeDevice" | "allowFallback" | "onPartial" | "signal"
    > = {},
  ): Promise<LocalAsrOutput> {
    if (options.signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    const t0 = performance.now();
    const pcm16k = sampleRate === 16000 ? input : resampleLinear(input, sampleRate, 16000);
    const deviceMode = options.computeDevice ?? this._qwen3ComputeDevice;
    const gpuStatus = this._qwen3Gpu.getStatus();
    const canTryGpu =
      deviceMode !== "cpu" && gpuStatus.ready && !this._qwen3Gpu.isInFailureCooldown();

    // Tier 1: GPU 加速推理（RTX / Radeon / Arc / Apple Silicon，实测 ~150~220ms/句，支持 SSE 逐 token 流式）
    if (canTryGpu) {
      try {
        const gpuRes = await this._qwen3Gpu.transcribe(pcm16k, {
          voiceLang,
          hotwords: options.hotwords,
          maxTokens: options.maxNewTokens,
          onPartial: options.onPartial,
          signal: options.signal,
        });
        return {
          text: gpuRes.text,
          rawText: gpuRes.rawText,
          lang: gpuRes.lang,
          emotion: "",
          event: "",
          engine: options.onPartial ? "qwen3-asr-gpu-stream" : "qwen3-asr-gpu",
          durationMs: gpuRes.durationMs,
          computeDevice: "gpu",
          gpuDeviceName: gpuRes.deviceName,
          fallbackUsed: false,
        };
      } catch (err) {
        if (options.signal?.aborted || (err instanceof DOMException && err.name === "AbortError")) {
          throw err;
        }
        const reason = err instanceof Error ? err.message : String(err);
        this._lastError = reason;
        // 显式指定仅 GPU 且禁止回落时直接抛错，否则静默回退至 CPU Qwen3-ASR
        if (deviceMode === "gpu" && options.allowFallback === false) {
          throw err;
        }
      }
    }

    if (options.signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    // Tier 2: CPU ONNX Qwen3-ASR-0.6B int8
    const recognizer = await this._ensureQwen3AsrRecognizer();
    if (!recognizer) {
      throw new Error(
        "本地离线 Qwen3-ASR-0.6B 语音识别模型尚未就绪，请在「设置 → 语音与 Pi Agent」中点击一键补齐本地语音模型，或切换备用 SenseVoice 方案。",
      );
    }

    const stream = recognizer.createStream();
    const qwenLang = mapQwen3AsrLang(voiceLang);
    if (qwenLang && typeof stream.setOption === "function") {
      stream.setOption("language", qwenLang);
    }
    if (options.hotwords && options.hotwords.length > 0 && typeof stream.setOption === "function") {
      const csv = options.hotwords
        .map((w) => w.replace(/,/g, " ").trim())
        .filter((w) => w.length > 0)
        .slice(0, 12)
        .join(",");
      if (csv) {
        stream.setOption("hotwords", csv);
      }
    }
    if (
      typeof options.maxNewTokens === "number" &&
      Number.isFinite(options.maxNewTokens) &&
      options.maxNewTokens > 0 &&
      typeof stream.setOption === "function"
    ) {
      stream.setOption("max_new_tokens", String(Math.round(options.maxNewTokens)));
    }
    stream.acceptWaveform({ samples: pcm16k, sampleRate: 16000 });
    const rawResult = await recognizer.decodeAsync(stream);
    const rawText = String(rawResult?.text ?? "");
    const text = cleanQwen3AsrText(rawText);
    if (!options.signal?.aborted && text && options.onPartial) {
      options.onPartial(text);
    }

    return {
      text,
      rawText,
      lang: String(rawResult?.lang ?? qwenLang),
      emotion: String(rawResult?.emotion ?? ""),
      event: String(rawResult?.event ?? ""),
      engine: options.onPartial ? "qwen3-asr-stream" : "qwen3-asr-local",
      durationMs: Math.round(performance.now() - t0),
      computeDevice: "cpu",
      fallbackUsed: false,
    };
  }

  /**
   * 储备/备用方案：本地离线 FunAudioLLM SenseVoiceSmall int8（异步非阻塞解码）。
   */
  async transcribeWithSenseVoice(
    input: Float32Array,
    sampleRate = 16000,
    voiceLang = "zh-CN",
    meta: { asFallback?: boolean; fallbackReason?: string } = {},
  ): Promise<LocalAsrOutput> {
    const t0 = performance.now();
    const pcm16k = sampleRate === 16000 ? input : resampleLinear(input, sampleRate, 16000);
    const svLang = voiceLang.toLowerCase().startsWith("zh-cn") ? "auto" : mapSenseVoiceLang(voiceLang);
    const recognizer = await this._ensureRecognizer(svLang);
    if (!recognizer) {
      throw new Error(
        "本地离线 SenseVoice 备用语音识别模型尚未就绪，请在「设置 → 语音与 Pi Agent」中点击一键下载本地语音模型，或配置 STT 接口。",
      );
    }

    const stream = recognizer.createStream();
    stream.acceptWaveform({ samples: pcm16k, sampleRate: 16000 });
    const rawResult = await recognizer.decodeAsync(stream);
    const rawText = String(rawResult?.text ?? "");
    const text = cleanSenseVoiceText(rawText);

    return {
      text,
      rawText,
      lang: String(rawResult?.lang ?? ""),
      emotion: String(rawResult?.emotion ?? ""),
      event: String(rawResult?.event ?? ""),
      engine: meta.asFallback ? "sensevoice-fallback" : "sensevoice-local",
      durationMs: Math.round(performance.now() - t0),
      fallbackUsed: Boolean(meta.asFallback),
      ...(meta.fallbackReason ? { fallbackReason: meta.fallbackReason } : {}),
    };
  }

  /**
   * 本地离线多语种 ASR 统一入口：
   * - `auto`（默认）：主用 Qwen3-ASR-0.6B（自动检测 GPU 加速 -> CPU ONNX 降级），若主方案不可用或异常则无缝切换至备用 SenseVoiceSmall int8
   * - `qwen3-asr`：显式指定 Qwen3-ASR-0.6B（GPU/CPU）
   * - `sensevoice`：显式切换至备用 SenseVoiceSmall int8
   */
  async transcribeLocal(
    input: Float32Array,
    sampleRate = 16000,
    voiceLang = "zh-CN",
    options: LocalAsrTranscribeOptions = {},
  ): Promise<LocalAsrOutput> {
    if (options.signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    const mode: LocalAsrEngineMode = options.engine ?? this._preferredAsrEngine;
    if (mode === "sensevoice") {
      const svRes = await this.transcribeWithSenseVoice(input, sampleRate, voiceLang);
      if (!options.signal?.aborted && svRes.text && options.onPartial) {
        options.onPartial(svRes.text);
      }
      return svRes;
    }

    const deviceMode = options.computeDevice ?? this._qwen3ComputeDevice;
    const hasQwen3Gpu =
      deviceMode !== "cpu" &&
      this._qwen3Gpu.getStatus().ready &&
      !this._qwen3Gpu.isInFailureCooldown();
    const hasQwen3Cpu = this._hasQwen3AsrModels();
    const hasSenseVoice = this._hasSenseVoiceModels();
    const allowFallback = options.allowFallback ?? mode === "auto";
    const inCpuInitCooldown =
      this._qwen3AsrInitFailedAt > 0 &&
      Date.now() - this._qwen3AsrInitFailedAt < QWEN3_ASR_INIT_RETRY_COOLDOWN_MS;

    if (hasQwen3Gpu || (hasQwen3Cpu && !inCpuInitCooldown)) {
      try {
        return await this.transcribeWithQwen3Asr(input, sampleRate, voiceLang, {
          hotwords: options.hotwords,
          maxNewTokens: options.maxNewTokens,
          computeDevice: deviceMode,
          allowFallback,
          onPartial: options.onPartial,
          signal: options.signal,
        });
      } catch (err) {
        if (options.signal?.aborted || (err instanceof DOMException && err.name === "AbortError")) {
          throw err;
        }
        const reason = err instanceof Error ? err.message : String(err);
        this._lastError = reason;
        if (allowFallback && hasSenseVoice) {
          const svRes = await this.transcribeWithSenseVoice(input, sampleRate, voiceLang, {
            asFallback: true,
            fallbackReason: `qwen3-asr-error: ${reason}`,
          });
          if (!options.signal?.aborted && svRes.text && options.onPartial) {
            options.onPartial(svRes.text);
          }
          return svRes;
        }
        throw err;
      }
    }

    if (allowFallback && hasSenseVoice) {
      const svRes = await this.transcribeWithSenseVoice(input, sampleRate, voiceLang, {
        asFallback: true,
        fallbackReason: hasQwen3Cpu
          ? `qwen3-asr-cooldown: ${this._qwen3AsrInitError || "init failed"}`
          : "qwen3-asr-model-missing",
      });
      if (!options.signal?.aborted && svRes.text && options.onPartial) {
        options.onPartial(svRes.text);
      }
      return svRes;
    }

    throw new Error(
      mode === "qwen3-asr"
        ? "本地离线 Qwen3-ASR-0.6B 模型尚未就绪，请在「设置 → 语音与 Pi Agent」中点击一键补齐模型，或将本地语音识别方案设为「自动（主用 Qwen3-ASR · 备用 SenseVoice）」。"
        : "本地离线语音识别模型（Qwen3-ASR-0.6B 主方案 / SenseVoice 备用方案）均未就绪，请在「设置 → 语音与 Pi Agent」中点击一键下载本地语音模型，或配置 STT 接口。",
    );
  }

  /**
   * 抗音乐/强噪双轨本地识别 + 中英混说唤醒词句首英文探针恢复：
   * - 默认使用 Qwen3-ASR-0.6B（CPU）主方案，未就绪/异常时自动降级 SenseVoice 备用方案；
   * - 高信噪比安静环境优先单轨极速解码；
   * - 嘈杂环境/音乐播放，或降噪单轨未检出唤醒词：融合「高通原始轨」与「神经降噪轨」择优（Qwen3-ASR 在 CPU 上采用顺序双轨避免 0.6B 模型争抢内存带宽，且首轨精确命中唤醒指令时自动早退）；
   * - 若配置了英文唤醒词且主解码仍未命中，按需触发句首英文探针恢复。
   */
  async transcribeDualTrack(
    rawPcm16k: Float32Array,
    denoisedPcm16k: Float32Array,
    options: {
      voiceLang?: string;
      wakeWords?: readonly string[];
      inputSnrDb?: number;
      forceDual?: boolean;
      systemOneClient?: SystemOneClient | null;
      acousticWake?: WakeWordAcousticHit | null;
      localAsrEngine?: LocalAsrEngineMode;
      hotwords?: readonly string[];
    } = {},
  ): Promise<LocalAsrOutput> {
    const lang = options.voiceLang || "zh-CN";
    const wakeWords = options.wakeWords ?? [];
    const inputSnrDb = options.inputSnrDb ?? estimateSnrDb(rawPcm16k, 16000);
    const hasAsciiWake = wakeWords.some((w) => /^[a-z][a-z0-9\s-]*$/i.test(w.trim()));
    const asrMode = options.localAsrEngine ?? this._preferredAsrEngine;
    const asrOpts: LocalAsrTranscribeOptions = {
      engine: asrMode,
      hotwords: options.hotwords ?? (wakeWords.length > 0 ? wakeWords : undefined),
    };
    const usingQwen3Primary =
      asrMode !== "sensevoice" &&
      (this._hasQwen3AsrModels() || (this._qwen3ComputeDevice !== "cpu" && this._qwen3Gpu.getStatus().ready));

    let best: LocalAsrOutput;
    let dualRawRes: LocalAsrOutput | null = null;
    let dualDenRes: LocalAsrOutput | null = null;
    const hpRaw = applyHighPassFilter(rawPcm16k, 16000, 85);

    // 非常安静的环境：若无需唤醒词检查或降噪单轨已精确命中唤醒词且无模糊误听，直接单轨返回保持最低延迟
    const acousticWake = options.acousticWake ?? null;
    const cleanSnrThreshold = usingQwen3Primary ? 18 : 24;
    if (!options.forceDual && inputSnrDb >= cleanSnrThreshold && denoisedPcm16k.length > 0) {
      const single = await this.transcribeLocal(denoisedPcm16k, 16000, lang, asrOpts);
      const singleSpan = wakeWords.length > 0 ? findWakeWordSpan(single.text, wakeWords) : null;
      const singleExactWake = wakeWords.length === 0 || Boolean(singleSpan && !singleSpan.fuzzy);
      if (
        single.text.length > 0 &&
        !single.event.toUpperCase().includes("BGM") &&
        singleExactWake
      ) {
        return single;
      }
      // 降噪轨未精确检出唤醒词时补跑一次高通原始轨（避免 GTCRN 削弱句首短英文音节如快速说的 "Neo关灯" / "嘿Neo"）
      const rawRes = await this.transcribeLocal(hpRaw, 16000, lang, asrOpts);
      dualRawRes = rawRes;
      dualDenRes = single;
      best = chooseBestAsrCandidate(rawRes, single, { wakeWords, inputSnrDb, acousticWake });
    } else if (usingQwen3Primary) {
      // Qwen3-ASR-0.6B 在 CPU 上采用顺序单轨优先 + 按需补跑双轨，避免两个 0.6B 解码器同时争抢内存带宽与核间缓存
      const primaryAudio = denoisedPcm16k.length > 0 ? denoisedPcm16k : hpRaw;
      const denRes = await this.transcribeLocal(primaryAudio, 16000, lang, asrOpts);
      const denSpan = wakeWords.length > 0 ? findWakeWordSpan(denRes.text, wakeWords) : null;
      const denStrongHit =
        denRes.text.length > 0 &&
        (wakeWords.length === 0 ||
          (denSpan !== null && !denSpan.fuzzy && (!denSpan.afterText || looksLikeDirectDeviceCommand(denSpan.afterText))));
      if (denStrongHit || primaryAudio === hpRaw) {
        best = denRes;
      } else {
        const rawRes = await this.transcribeLocal(hpRaw, 16000, lang, asrOpts);
        dualRawRes = rawRes;
        dualDenRes = denRes;
        best = chooseBestAsrCandidate(rawRes, denRes, { wakeWords, inputSnrDb, acousticWake });
      }
    } else {
      const [rawRes, denRes] = await Promise.all([
        this.transcribeLocal(hpRaw, 16000, lang, asrOpts),
        denoisedPcm16k.length > 0
          ? this.transcribeLocal(denoisedPcm16k, 16000, lang, asrOpts)
          : Promise.resolve<LocalAsrOutput>({
              text: "",
              rawText: "",
              lang: "",
              emotion: "",
              event: "",
              engine: "sensevoice-local",
              durationMs: 0,
            }),
      ]);
      dualRawRes = rawRes;
      dualDenRes = denRes;
      best = chooseBestAsrCandidate(rawRes, denRes, { wakeWords, inputSnrDb, acousticWake });
    }

    // SystemOne 双轨 ASR 候选择优（双轨出现不同非空候选且分差较近或处于 BGM 场景）
    if (dualRawRes && dualDenRes && options.systemOneClient?.enabled) {
      const trackA = dualRawRes.text.trim();
      const trackB = dualDenRes.text.trim();
      const isBgm =
        dualRawRes.event.toUpperCase().includes("BGM") ||
        dualDenRes.event.toUpperCase().includes("BGM");
      const scoreMargin = best.scoreMargin ?? 0;
      if (trackA && trackB && trackA !== trackB && (scoreMargin < 30 || isBgm)) {
        const sel = await options.systemOneClient.selectDualTrackAsr({
          trackA,
          trackB,
          wakeWords,
          acousticEvent: best.event || dualRawRes.event || dualDenRes.event || undefined,
          inputSnrDb,
        });
        if (sel) {
          if (sel.choice === "neither_noise" && sel.confidence >= 0.75) {
            if (!acousticWake?.matched) {
              return {
                ...best,
                text: "",
                durationMs: best.durationMs + sel.latencyMs,
              };
            }
          } else if (sel.choice === "track_a") {
            const rawDualEngine: LocalAsrResultEngine = dualRawRes.engine.startsWith("qwen3-asr-gpu")
              ? "qwen3-asr-gpu-dual-raw"
              : dualRawRes.engine.startsWith("qwen3-asr")
                ? "qwen3-asr-dual-raw"
                : "sensevoice-dual-raw";
            best = {
              ...dualRawRes,
              engine: rawDualEngine,
              durationMs: dualRawRes.durationMs + dualDenRes.durationMs + sel.latencyMs,
              altText: dualDenRes.text,
              scoreMargin: best.scoreMargin,
            };
          } else if (sel.choice === "track_b") {
            const denDualEngine: LocalAsrResultEngine = dualDenRes.engine.startsWith("qwen3-asr-gpu")
              ? "qwen3-asr-gpu-dual-denoised"
              : dualDenRes.engine.startsWith("qwen3-asr")
                ? "qwen3-asr-dual-denoised"
                : "sensevoice-dual-denoised";
            best = {
              ...dualDenRes,
              engine: denDualEngine,
              durationMs: dualRawRes.durationMs + dualDenRes.durationMs + sel.latencyMs,
              altText: dualRawRes.text,
              scoreMargin: best.scoreMargin,
            };
          }
        }
      }
    }

    // openWakeWord 声学唤醒词直救与规范化：
    // 若本地声学引擎已确信命中唤醒词，但主 ASR 吞掉了句首唤醒词（如快速说的 "Neo关灯" -> "关灯"）
    // 或将其误听为近音前缀（如 "你好关灯" / "你有关灯" / "你给开灯" / "钮关灯" / "new关灯"），
    // 精准剥离句首误听残片并完整保留后面的设备指令，绝不把短指令误清空成纯唤醒 "在呢"！
    const currentWakeSpan = wakeWords.length > 0 ? findWakeWordSpan(best.text, wakeWords) : null;
    const trimmedBest = best.text.trim();
    const isAmbiguousInterrogative =
      /^(?:你有|你又|你好|你给)/.test(trimmedBest) &&
      /[吗嘛么呢][。？！!?\s]*$/.test(trimmedBest) &&
      !isWakeQueryText(extractCommandAfterAcousticWake(trimmedBest, acousticWake?.wakeWord ?? ""));
    const isThirdPerson = isThirdPersonNeoMention(trimmedBest);
    const isHelloNonDeviceChat =
      /^(?:你好|您好)/.test(trimmedBest) &&
      !hasSmartHomeDomainIntent(extractCommandAfterAcousticWake(trimmedBest, acousticWake?.wakeWord ?? ""));
    if (
      acousticWake?.matched &&
      wakeWords.length > 0 &&
      !isAmbiguousInterrogative &&
      !isThirdPerson &&
      !isHelloNonDeviceChat &&
      (!currentWakeSpan || currentWakeSpan.fuzzy)
    ) {
      const extracted = extractCommandAfterAcousticWake(best.text, acousticWake.wakeWord);
      if (extracted && !isWakeQueryText(extracted)) {
        return {
          ...best,
          text: `${acousticWake.wakeWord}，${extracted}`,
          altText: best.altText || best.text,
        };
      }
      if (!currentWakeSpan) {
        return {
          ...best,
          text: acousticWake.wakeWord,
          altText: best.altText || best.text,
        };
      }
    }

    // 中英混说英文唤醒词句首恢复（仅在配置了英文唤醒词、中文/自动模式且主解码未命中唤醒词时触发）
    const langLower = lang.toLowerCase();
    const isBilingualZhMode = !langLower || langLower === "auto" || langLower.startsWith("zh");
    if (hasAsciiWake && isBilingualZhMode && !findWakeWordSpan(best.text, wakeWords)) {
      const recovered = await this._recoverBilingualEnglishWake(
        hpRaw,
        denoisedPcm16k,
        best,
        wakeWords,
        asrMode,
      );
      if (recovered) {
        return recovered;
      }
    }

    return best;
  }

  /**
   * 针对中英混说时的句首英文唤醒词恢复（例如快速连读 "Neo关灯" 或强噪下句首英文被吞掉）：
   * 对句首 0.65s~1.35s 音频做轻量 en 语种提示解码，并严格校验避免纯中文对话误唤醒。
   * 当备用 SenseVoice 可用时，极短句首英文探针优先复用轻量 SenseVoice en（~55ms）避免阻塞 CPU。
   */
  private async _recoverBilingualEnglishWake(
    hpRaw16k: Float32Array,
    denoised16k: Float32Array,
    best: LocalAsrOutput,
    wakeWords: readonly string[],
    asrMode: LocalAsrEngineMode = this._preferredAsrEngine,
  ): Promise<LocalAsrOutput | null> {
    const asciiWakes = wakeWords.filter((w) => /^[a-z][a-z0-9\s-]*$/i.test(w.trim()));
    if (asciiWakes.length === 0) return null;

    const primaryAudio = denoised16k.length >= 1600 ? denoised16k : hpRaw16k;
    if (primaryAudio.length < 1600) return null;

    const isShortClip = primaryAudio.length <= 16000 * 1.9;
    const headPrimary = isShortClip
      ? primaryAudio
      : primaryAudio.subarray(0, Math.min(primaryAudio.length, Math.round(16000 * 1.35)));

    const cleanBest = best.text.trim();
    const meaningfulChars = cleanBest.replace(/[\s,，。．.、!！?？:：;；\-—~～"'“”‘’]/g, "");
    const hasWeirdScript = /[\u3040-\u30ff\uac00-\ud7af]/.test(cleanBest);
    const extractedFirst = extractCommandAfterAcousticWake(cleanBest, asciiWakes[0]!);
    const bestLooksLikeCmd =
      extractedFirst.length >= 2 &&
      (looksLikeDirectDeviceCommand(extractedFirst) || isWakeQueryText(extractedFirst));
    const bestIsShortOrGarbled = isShortClip || meaningfulChars.length <= 4 || hasWeirdScript;

    // 既不是短/乱码句，也不像控制指令或唤醒询问 -> 直接跳过，零额外开销、零误触发
    if (!bestIsShortOrGarbled && !bestLooksLikeCmd) {
      return null;
    }

    const probeEngine: LocalAsrEngineMode =
      asrMode !== "qwen3-asr" && this._hasSenseVoiceModels() ? "sensevoice" : asrMode;
    let extraMs = 0;
    const probeClip = async (
      clip: Float32Array,
      allowCommandGated: boolean,
    ): Promise<{
      enRes: LocalAsrOutput;
      hit: { wakeWord: string; matchedSurface: string; fuzzy: boolean } | null;
    }> => {
      const enRes = await this.transcribeLocal(clip, 16000, "en-US", {
        engine: probeEngine,
        maxNewTokens: 24,
      });
      extraMs += enRes.durationMs;
      const hit = matchEnglishHeadWakeWord(enRes.text, asciiWakes, {
        allowCommandGatedAliases: allowCommandGated,
      });
      return { enRes, hit };
    };

    let { enRes, hit } = await probeClip(headPrimary, bestLooksLikeCmd);

    // 若降噪轨首段未命中且原始轨不同，再对高通原始轨句首 1.35s 补探一次（防止降噪器/VAD 削弱句首轻声英文唤醒词）
    if (!hit && denoised16k.length >= 1600 && hpRaw16k.length >= 1600) {
      const rawIsShort = hpRaw16k.length <= 16000 * 1.9;
      const headRaw = rawIsShort
        ? hpRaw16k
        : hpRaw16k.subarray(0, Math.min(hpRaw16k.length, Math.round(16000 * 1.35)));
      const second = await probeClip(headRaw, bestLooksLikeCmd);
      if (second.hit) {
        enRes = second.enRes;
        hit = second.hit;
      }
    }

    // 针对快速连读短句（如 0.7~1.8s 的 "Neo关灯"）：全段送 en-US 易受尾音中文干扰，补探前 0.65s 句首
    if (!hit && isShortClip && bestLooksLikeCmd && hpRaw16k.length >= Math.round(16000 * 0.75)) {
      const headFast = hpRaw16k.subarray(0, Math.round(16000 * 0.65));
      const fastProbe = await probeClip(headFast, true);
      if (fastProbe.hit) {
        enRes = fastProbe.enRes;
        hit = fastProbe.hit;
      }
    }

    if (!hit) return null;

    // 场景 1：双语“英文唤醒词 + 中文设备指令”（例如 "Neo关灯" / "Neo, 把小米音响音量调到30"）
    const extracted = extractCommandAfterAcousticWake(cleanBest, hit.wakeWord);
    if (extracted && !isWakeQueryText(extracted)) {
      return {
        ...best,
        text: `${hit.wakeWord}，${extracted}`,
        durationMs: best.durationMs + extraMs,
        altText: best.altText || best.text,
        enHeadText: enRes.text,
      };
    }

    // 场景 2：单独喊英文唤醒词（例如 "Neo" / "Hey Neo" 被 auto 误判成 "2お." / "ニ요." / "2." / "你有。"）
    if (bestIsShortOrGarbled) {
      const enSpan = findWakeWordSpan(enRes.text, asciiWakes);
      const recoveredText =
        enSpan && enSpan.afterText ? `${hit.wakeWord}，${enSpan.afterText}` : hit.wakeWord;
      return {
        ...enRes,
        text: recoveredText,
        engine: best.engine,
        durationMs: best.durationMs + extraMs,
        altText: best.text,
        enHeadText: enRes.text,
      };
    }

    return null;
  }

  /**
   * 一键补齐下载缺失的本地 ONNX 模型（GTCRN / DPDFNet4 / Silero VAD / 3D-Speaker CAM++ /
   * Qwen3-ASR-0.6B int8 主方案 / SenseVoiceSmall int8 备用方案 / openWakeWord）。
   */
  async downloadMissingModels(): Promise<LocalVoiceEngineStatus> {
    if (this._downloading) {
      return this.getStatus();
    }
    this._downloading = true;
    this._lastError = null;
    const p = this.paths;

    try {
      mkdirSync(p.modelsDir, { recursive: true });
      mkdirSync(p.openWakeWordDir, { recursive: true });

      const fetchFile = async (url: string, dest: string) => {
        if (existsSync(dest)) return;
        const part = `${dest}.part`;
        const res = await fetch(url, { redirect: "follow" });
        if (!res.ok) {
          throw new Error(`下载模型失败 (${res.status}): ${path.basename(dest)}`);
        }
        if (res.body) {
          const writer = Bun.file(part).writer();
          try {
            const reader = res.body.getReader();
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              if (value && value.byteLength > 0) {
                writer.write(value);
              }
            }
            await writer.end();
          } catch (err) {
            try {
              await writer.end();
            } catch {
              // ignore
            }
            try {
              if (existsSync(part)) unlinkSync(part);
            } catch {
              // ignore
            }
            throw err;
          }
        } else {
          const buf = await res.arrayBuffer();
          await Bun.write(part, buf);
        }
        renameSync(part, dest);
      };

      const fetchAndExtractTar = async (url: string, archiveName: string, label: string) => {
        const tarPath = path.join(p.modelsDir, archiveName);
        await fetchFile(url, tarPath);
        const proc = Bun.spawn(["tar", "-xjf", tarPath, "-C", p.modelsDir], {
          stdout: "ignore",
          stderr: "pipe",
        });
        const exitCode = await proc.exited;
        try {
          if (existsSync(tarPath)) unlinkSync(tarPath);
        } catch {
          // ignore
        }
        if (exitCode !== 0) {
          const errText = await new Response(proc.stderr).text();
          throw new Error(`解压 ${label} 模型失败: ${errText.trim() || exitCode}`);
        }
      };

      await fetchFile(MODEL_URLS.gtcrn, p.gtcrn);
      await fetchFile(MODEL_URLS.dpdfnet4, p.dpdfnet4);
      await fetchFile(MODEL_URLS.sileroVad, p.sileroVad);
      await fetchFile(MODEL_URLS.speakerCampp, p.speakerCampp);
      await fetchFile(OPEN_WAKEWORD_MODEL_URLS.mel, p.openWakeWordMel);
      await fetchFile(OPEN_WAKEWORD_MODEL_URLS.embedding, p.openWakeWordEmbedding);
      this._oww.ensureLoaded();

      // 1. 先补齐 SenseVoice 储备/备用模型（体积小，先保底离线识别可用）
      if (!this._hasSenseVoiceModels(p)) {
        await fetchAndExtractTar(MODEL_URLS.senseVoiceTar, "sensevoice.tar.bz2", "SenseVoice");
      }

      // 2. 补齐 Qwen3-ASR-0.6B int8 主方案模型（CPU 高精度多语种 ASR，流式落盘零大内存占用）
      if (!this._hasQwen3AsrModels(p)) {
        await fetchAndExtractTar(MODEL_URLS.qwen3AsrTar, "qwen3-asr-0.6B-int8.tar.bz2", "Qwen3-ASR-0.6B");
        this._qwen3AsrInitFailedAt = 0;
        this._qwen3AsrInitError = null;
      }

      // 2.5 若本机检测到硬件 GPU，自动补齐 Qwen3-ASR-0.6B Vulkan GPU 运行时与 Q8_0 GGUF 加速模型（失败不阻断 CPU/SenseVoice）
      if (this._qwen3Gpu.detectGpu(true) && !this._qwen3Gpu.getStatus().ready) {
        try {
          await this._qwen3Gpu.downloadMissingAssets();
        } catch {
          // GPU 加速组件为自动增强项，下载失败时无缝使用已就绪的 CPU Qwen3-ASR
        }
      }

      const fetchAndExtractOptionalTar = async (url: string, checkFile: string, archiveName: string) => {
        if (existsSync(checkFile)) return;
        const tarPath = path.join(p.modelsDir, archiveName);
        try {
          await fetchFile(url, tarPath);
          const proc = Bun.spawn(["tar", "-xjf", tarPath, "-C", p.modelsDir], {
            stdout: "ignore",
            stderr: "pipe",
          });
          await proc.exited;
        } catch {
          // 可选声源分离增强模型下载失败时不影响核心离线 ASR
        } finally {
          try {
            if (existsSync(tarPath)) unlinkSync(tarPath);
          } catch {
            // ignore
          }
        }
      };

      await fetchAndExtractOptionalTar(MODEL_URLS.cedTinyTar, p.cedModel, "ced-tiny.tar.bz2");
      await fetchAndExtractOptionalTar(MODEL_URLS.pyannoteSegTar, p.pyannoteSegmentation, "pyannote-seg.tar.bz2");
      await fetchAndExtractOptionalTar(MODEL_URLS.spleeterFp16Tar, p.spleeterVocals, "spleeter-fp16.tar.bz2");
      try {
        await this._tts.downloadMissingModels();
      } catch {
        // 可选本地温柔女声模型下载失败时自动回退浏览器女声，不阻断核心 ASR
      }
    } catch (err) {
      this._lastError = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      this._downloading = false;
    }

    return this.getStatus();
  }

  dispose(): void {
    this._sourceSeparator?.dispose();
    this._sourceSeparator = null;
    this._qwen3Gpu.dispose();
    this._oww.dispose();
    this._tts.dispose();
    this._gtcrnDenoiser = null;
    this._dpdfnetDenoiser = null;
    this._voxlockDenoiser = null;
    this._speakerExtractor = null;
    this._qwen3AsrRecognizer = null;
    this._qwen3AsrInitFailedAt = 0;
    this._qwen3AsrInitError = null;
    this._recognizers.clear();
  }
}
