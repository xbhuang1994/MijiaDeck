// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * 语音 AI 引擎（本地 sherpa-onnx-node 基础管线 + 讯飞语音听写大模型 2.0 在线接入）：
 * - 环境降噪：GTCRN（gtcrn_simple.onnx）/ DPDFNet4（dpdfnet4.onnx）/ VoxLock 目标人声提取 / 纯 TS 频谱减法
 * - 语音活动检测：Silero VAD 神经端点检测（支持离线与连续流式检测），无模型时自动降级自适应能量+过零率 VAD
 * - 声纹识别：阿里 3D-Speaker CAM++（192 维中文说话人嵌入），无模型时自动降级声学指纹
 * - 语音识别（ASR）：
 *   - 本地离线：FunAudioLLM SenseVoiceSmall int8
 *   - 在线直推：讯飞语音听写大模型 2.0（Spark ASR V2 WebSocket，openWakeWord 唤醒后直推 16kHz 原始音频）
 */

import { existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import type {
  NoiseSuppressionMode,
  VadEngineMode,
  VoicePipelineMode,
} from "../core/agentConfigStore.ts";
import { projectRoot } from "../core/appMeta.ts";
import { sanitizeAsrTranscript } from "./asrHallucinationGuard.ts";
import {
  adaptiveEnergyVad,
  applyHighPassFilter,
  estimateSnrDb,
  extractFallbackVoiceprint,
  hasAudibleAudioEnergy,
  l2Normalize,
  resampleLinear,
  spectralSubtractDenoise,
  StreamingDspDenoiser,
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
  XfyunIatV2Runtime,
  type XfyunIatConfig,
  type XfyunIatStatus,
} from "./xfyunIatV2Runtime.ts";
import {
  VoiceWsAsrRuntime,
  type VoiceWsAsrConfig,
  type VoiceWsAsrStatus,
} from "./voiceWsAsrRuntime.ts";
import { getPrimaryOwnerRefWavPath } from "./voiceprintStore.ts";

export type {
  NoiseSuppressionMode,
  VadEngineMode,
  VoicePipelineMode,
  VoiceWsAsrConfig,
  VoiceWsAsrStatus,
  XfyunIatConfig,
  XfyunIatStatus,
};
export { VoiceWsAsrRuntime, XfyunIatV2Runtime };

export interface LocalVoiceModelPaths {
  modelsDir: string;
  gtcrn: string;
  dpdfnet4: string;
  voxlockDir: string;
  voxlockEnroll: string;
  voxlockChunk: string;
  sileroVad: string;
  speakerCampp: string;
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
    senseVoice: boolean;
    openWakeWord: boolean;
    cedAudioTagging?: boolean;
    pyannoteDiarization?: boolean;
    spleeterSeparation?: boolean;
    localTts?: boolean;
    xfyunIat?: boolean;
    voiceWsAsr?: boolean;
  };
  readyForDenoise: boolean;
  readyForDpdfnet: boolean;
  readyForVoxlock: boolean;
  readyForXfyunIat: boolean;
  xfyunIat: XfyunIatStatus;
  readyForVoiceWsAsr: boolean;
  voiceWsAsr: VoiceWsAsrStatus;
  readyForVad: boolean;
  readyForVoiceprint: boolean;
  readyForSenseVoice: boolean;
  readyForLocalAsr: boolean;
  primaryAsrEngine: "sensevoice" | null;
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
  | "xfyun-iat-v2"
  | "voice-ws-asr"
  | "sensevoice-local"
  | "sensevoice-dual-raw"
  | "sensevoice-dual-denoised";

export interface LocalAsrTranscribeOptions {
  hotwords?: readonly string[];
  maxNewTokens?: number;
  /** 流式转写实时局部回调 */
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
  altText?: string;
  enHeadText?: string;
  scoreMargin?: number;
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
  senseVoiceTar:
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2",
  cedTinyTar:
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/audio-tagging-models/sherpa-onnx-ced-tiny-audio-tagging-2024-04-19.tar.bz2",
  pyannoteSegTar:
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2",
  spleeterFp16Tar:
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/source-separation-models/sherpa-onnx-spleeter-2stems-fp16.tar.bz2",
} as const;

export const SENSE_VOICE_DIR_NAME = "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17";
const VOXLOCK_DIR_NAME = "sherpa-onnx-voxlock-int8";

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
    return {
      ...rawAsr,
      engine: "sensevoice-dual-raw",
      durationMs: rawAsr.durationMs + denoisedAsr.durationMs,
      altText: denoisedAsr.text,
      scoreMargin,
    };
  }
  return {
    ...denoisedAsr,
    engine: "sensevoice-dual-denoised",
    durationMs: rawAsr.durationMs + denoisedAsr.durationMs,
    altText: rawAsr.text,
    scoreMargin,
  };
}

export class LocalVoiceEngine {
  private readonly _modelsDirOverride?: string;
  private readonly _oww: OpenWakeWordEngine;
  private readonly _tts: LocalTtsEngine;
  private readonly _xfyunIat: XfyunIatV2Runtime;
  private readonly _voiceWsAsr: VoiceWsAsrRuntime;
  private _sourceSeparator: AudioSourceSeparator | null = null;
  private _gtcrnDenoiser: InstanceType<SherpaModuleLike["OfflineSpeechDenoiser"]> | null = null;
  private _dpdfnetDenoiser: InstanceType<SherpaModuleLike["OfflineSpeechDenoiser"]> | null = null;
  private _voxlockDenoiser: {
    refPath: string;
    instance: InstanceType<SherpaModuleLike["OfflineSpeechDenoiser"]>;
  } | null = null;
  private _speakerExtractor: InstanceType<SherpaModuleLike["SpeakerEmbeddingExtractor"]> | null =
    null;
  private _recognizers = new Map<
    string,
    Promise<Awaited<ReturnType<SherpaModuleLike["OfflineRecognizer"]["createAsync"]>>>
  >();
  private _downloading = false;
  private _lastError: string | null = null;

  constructor(
    options: {
      modelsDir?: string;
    } = {},
  ) {
    this._modelsDirOverride = options.modelsDir;
    const p = resolveVoiceModelPaths(options.modelsDir);
    this._oww = new OpenWakeWordEngine({ modelsDir: p.modelsDir });
    this._tts = new LocalTtsEngine({ modelsDir: p.modelsDir });
    this._xfyunIat = new XfyunIatV2Runtime();
    this._voiceWsAsr = new VoiceWsAsrRuntime();
  }

  get xfyunIat(): XfyunIatV2Runtime {
    return this._xfyunIat;
  }

  setXfyunIatConfig(config: XfyunIatConfig): void {
    this._xfyunIat.setConfig(config);
  }

  get voiceWsAsr(): VoiceWsAsrRuntime {
    return this._voiceWsAsr;
  }

  setVoiceWsAsrConfig(config: VoiceWsAsrConfig): void {
    this._voiceWsAsr.setConfig(config);
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
    const xfyunStatus = this._xfyunIat.getStatus();
    const voiceWsAsrStatus = this._voiceWsAsr.getStatus();
    const senseVoice = this._hasSenseVoiceModels(p);
    const openWakeWord = existsSync(p.openWakeWordMel) && existsSync(p.openWakeWordEmbedding);
    const cedAudioTagging = existsSync(p.cedModel) && existsSync(p.cedLabels);
    const pyannoteDiarization = existsSync(p.pyannoteSegmentation) && speakerCampp;
    const spleeterSeparation = existsSync(p.spleeterVocals) && existsSync(p.spleeterAccompaniment);
    const ttsStatus = this._tts.getStatus();
    const addonAvailable = sherpa !== null;
    const readyForSenseVoice = addonAvailable && senseVoice;
    const readyForLocalAsr = readyForSenseVoice;
    const primaryAsrEngine: "sensevoice" | null = readyForSenseVoice ? "sensevoice" : null;
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
        senseVoice,
        openWakeWord,
        cedAudioTagging,
        pyannoteDiarization,
        spleeterSeparation,
        localTts: ttsStatus.ready,
        xfyunIat: xfyunStatus.ready,
        voiceWsAsr: voiceWsAsrStatus.ready,
      },
      readyForDenoise: addonAvailable && gtcrn,
      readyForDpdfnet: addonAvailable && dpdfnet4,
      readyForVoxlock: addonAvailable && voxlock,
      readyForXfyunIat: xfyunStatus.ready,
      xfyunIat: xfyunStatus,
      readyForVoiceWsAsr: voiceWsAsrStatus.ready,
      voiceWsAsr: voiceWsAsrStatus,
      readyForVad: addonAvailable && sileroVad,
      readyForVoiceprint: addonAvailable && speakerCampp,
      readyForSenseVoice,
      readyForLocalAsr,
      primaryAsrEngine,
      readyForWakeWord: this._oww.getStatus().ready,
      readyForSourceSeparation:
        readyForLocalAsr && (cedAudioTagging || pyannoteDiarization || spleeterSeparation),
      readyForLocalTts: ttsStatus.ready,
      tts: ttsStatus,
      downloading: this._downloading || ttsStatus.downloading,
      lastError: this._lastError ?? ttsStatus.lastError,
    };
  }

  private _numThreads(): number {
    return Math.min(4, Math.max(2, Math.floor(os.cpus().length / 2)));
  }

  /**
   * 帧级递归降噪模型（GTCRN / DPDFNet4）实测在单线程下省去每帧线程栅栏开销，速度提升约 10%~25%
   * 且不与并行 ASR/Spleeter 争抢线程池。
   */
  private _denoiserThreads(): number {
    return 1;
  }

  /**
   * 后台异步分阶段预热本地 ONNX 基础模型（GTCRN / CAM++ / SenseVoice / openWakeWord），
   * 每步让出事件循环避免启动/开麦瞬间卡顿。
   */
  async warmup(
    options: {
      preloadEnglish?: boolean;
      voicePipelineMode?: VoicePipelineMode;
    } = {},
  ): Promise<void> {
    const yieldTick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
    try {
      this._oww.ensureLoaded();
      await yieldTick();
      if (options.voicePipelineMode === "xfyun" || options.voicePipelineMode === "voice-ws") {
        // 讯飞听写 2.0 / 统一流式语音听写网关方案：仅需就绪 openWakeWord 与可选声纹提取器，跳过重型降噪/本地识别预热
        this._ensureSpeakerExtractor();
        return;
      }
      this._ensureGtcrnDenoiser();
      await yieldTick();
      this._ensureSpeakerExtractor();
      await yieldTick();
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
   * 为连续 WebSocket 音频流创建独立的实时流式降噪器（GTCRN / DPDFNet4 / VoxLock / 纯 TS 频谱维纳 DSP 降级）。
   */
  createOnlineDenoiser(
    mode: NoiseSuppressionMode = "auto",
  ): { denoiser: OnlineDenoiserHandleLike; engine: "gtcrn" | "dpdfnet4" | "voxlock" | "dsp" } | null {
    if (mode === "off") return null;
    if (mode === "dsp") {
      return {
        engine: "dsp",
        denoiser: new StreamingDspDenoiser(16000),
      };
    }
    const sherpa = loadSherpaModule();
    const p = this.paths;
    if (sherpa && typeof sherpa.OnlineSpeechDenoiser === "function") {
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
    }
    // 无原生 ONNX 降噪模型时自动降级到连续流式 DSP 频谱维纳降噪，确保待机/对话永不退化为零降噪
    return {
      engine: "dsp",
      denoiser: new StreamingDspDenoiser(16000),
    };
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
        Math.max(35, Math.ceil((options.maxSpeechDuration ?? 4.2) + 8)),
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
          maxSpeechDuration: 30,
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
   * 本地离线 FunAudioLLM SenseVoiceSmall int8（异步非阻塞解码）。
   */
  async transcribeWithSenseVoice(
    input: Float32Array,
    sampleRate = 16000,
    voiceLang = "zh-CN",
    meta: { hotwords?: readonly string[] } = {},
  ): Promise<LocalAsrOutput> {
    const t0 = performance.now();
    const pcm16k = sampleRate === 16000 ? input : resampleLinear(input, sampleRate, 16000);
    const svLang = voiceLang.toLowerCase().startsWith("zh-cn") ? "auto" : mapSenseVoiceLang(voiceLang);
    const recognizer = await this._ensureRecognizer(svLang);
    if (!recognizer) {
      throw new Error(
        "本地离线 SenseVoice 语音识别模型尚未就绪，请在「设置 → 语音与 Pi Agent」中点击一键补齐本地模型，或配置讯飞听写 2.0 / STT 接口。",
      );
    }

    if (pcm16k.length < 800 || !hasAudibleAudioEnergy(pcm16k, 16000)) {
      return {
        text: "",
        rawText: "",
        lang: "",
        emotion: "",
        event: "",
        engine: "sensevoice-local",
        durationMs: Math.round(performance.now() - t0),
      };
    }

    const stream = recognizer.createStream();
    stream.acceptWaveform({ samples: pcm16k, sampleRate: 16000 });
    const rawResult = await recognizer.decodeAsync(stream);
    const rawText = String(rawResult?.text ?? "");
    const text = sanitizeAsrTranscript(cleanSenseVoiceText(rawText), {
      wakeWords: meta.hotwords,
    });

    return {
      text,
      rawText,
      lang: String(rawResult?.lang ?? ""),
      emotion: String(rawResult?.emotion ?? ""),
      event: String(rawResult?.event ?? ""),
      engine: "sensevoice-local",
      durationMs: Math.round(performance.now() - t0),
    };
  }

  /**
   * 本地离线多语种语音识别统一入口（FunAudioLLM SenseVoiceSmall int8）。
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
    const svRes = await this.transcribeWithSenseVoice(input, sampleRate, voiceLang, {
      hotwords: options.hotwords,
    });
    if (!options.signal?.aborted && svRes.text && options.onPartial) {
      options.onPartial(svRes.text);
    }
    return svRes;
  }

  /**
   * 抗音乐/强噪双轨识别 + 中英混说唤醒词句首英文探针恢复（本地离线 SenseVoiceSmall int8）：
   * - 高信噪比安静环境优先单轨极速解码；
   * - 嘈杂环境/音乐播放，或降噪单轨未检出唤醒词：融合「高通原始轨」与「神经降噪轨」择优；
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
      hotwords?: readonly string[];
    } = {},
  ): Promise<LocalAsrOutput> {
    const lang = options.voiceLang || "zh-CN";
    const wakeWords = options.wakeWords ?? [];
    const inputSnrDb = options.inputSnrDb ?? estimateSnrDb(rawPcm16k, 16000);
    const hasAsciiWake = wakeWords.some((w) => /^[a-z][a-z0-9\s-]*$/i.test(w.trim()));
    const asrOpts: LocalAsrTranscribeOptions = {
      hotwords: options.hotwords ?? (wakeWords.length > 0 ? wakeWords : undefined),
    };

    let best: LocalAsrOutput;
    let dualRawRes: LocalAsrOutput | null = null;
    let dualDenRes: LocalAsrOutput | null = null;
    const hpRaw = applyHighPassFilter(rawPcm16k, 16000, 85);

    // 非常安静的环境：若无需唤醒词检查或降噪单轨已精确命中唤醒词且无模糊误听，直接单轨返回保持最低延迟
    const acousticWake = options.acousticWake ?? null;
    if (!options.forceDual && inputSnrDb >= 24 && denoisedPcm16k.length > 0) {
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

    // SystemOne 双轨 ASR 候选择优（仅非唤醒触发阶段的双轨冲突/BGM 场景启用；唤醒触发阶段不做双轨/背景 SystemOne 判断）
    const wakeTriggered =
      Boolean(acousticWake?.matched) ||
      (wakeWords.length > 0 &&
        (Boolean(findWakeWordSpan(dualRawRes?.text ?? "", wakeWords)) ||
          Boolean(findWakeWordSpan(dualDenRes?.text ?? "", wakeWords))));
    if (dualRawRes && dualDenRes && options.systemOneClient?.enabled && !wakeTriggered) {
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
            best = {
              ...dualRawRes,
              engine: "sensevoice-dual-raw",
              durationMs: dualRawRes.durationMs + dualDenRes.durationMs + sel.latencyMs,
              altText: dualDenRes.text,
              scoreMargin: best.scoreMargin,
            };
          } else if (sel.choice === "track_b") {
            best = {
              ...dualDenRes,
              engine: "sensevoice-dual-denoised",
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
      );
      if (recovered) {
        return recovered;
      }
    }

    return best;
  }

  /**
   * 针对中英混说时的句首英文唤醒词恢复（例如快速连读 "Neo关灯" 或强噪下句首英文被吞掉）：
   * 对句首 0.65s~1.35s 音频做轻量 SenseVoice en 语种提示解码，并严格校验避免纯中文对话误唤醒。
   */
  private async _recoverBilingualEnglishWake(
    hpRaw16k: Float32Array,
    denoised16k: Float32Array,
    best: LocalAsrOutput,
    wakeWords: readonly string[],
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

    let extraMs = 0;
    const probeClip = async (
      clip: Float32Array,
      allowCommandGated: boolean,
    ): Promise<{
      enRes: LocalAsrOutput;
      hit: { wakeWord: string; matchedSurface: string; fuzzy: boolean } | null;
    }> => {
      const enRes = await this.transcribeLocal(clip, 16000, "en-US", {
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
   * 一键补齐下载缺失的本地 ONNX 基础模型（GTCRN / DPDFNet4 / Silero VAD / 3D-Speaker CAM++ /
   * SenseVoiceSmall int8 / openWakeWord / 本地温柔女声 TTS）。
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

      // 补齐 SenseVoice 本地离线识别模型
      if (!this._hasSenseVoiceModels(p)) {
        await fetchAndExtractTar(MODEL_URLS.senseVoiceTar, "sensevoice.tar.bz2", "SenseVoice");
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
    this._xfyunIat.dispose();
    this._voiceWsAsr.dispose();
    this._oww.dispose();
    this._tts.dispose();
    this._gtcrnDenoiser = null;
    this._dpdfnetDenoiser = null;
    this._voxlockDenoiser = null;
    this._speakerExtractor = null;
    this._recognizers.clear();
  }
}
