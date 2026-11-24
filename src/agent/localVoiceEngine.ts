// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * 本地离线语音 AI 引擎（基于 sherpa-onnx-node）：
 * - 环境降噪：GTCRN 神经网络语音增强（gtcrn_simple.onnx，535KB），无模型时自动降级纯 TS 频谱减法
 * - 语音活动检测：Silero VAD 神经端点检测（silero_vad.onnx，643KB），无模型时自动降级自适应能量+过零率 VAD
 * - 声纹识别：阿里 3D-Speaker CAM++（3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx，28MB），无模型时自动降级声学指纹
 * - 本地离线 ASR：FunAudioLLM SenseVoiceSmall int8（中/英/粤/日/韩 + ITN + 声学事件检测），异步非阻塞 decodeAsync
 */

import { existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { projectRoot } from "../core/appMeta.ts";
import {
  adaptiveEnergyVad,
  estimateSnrDb,
  extractFallbackVoiceprint,
  l2Normalize,
  resampleLinear,
  spectralSubtractDenoise,
} from "./audioPcm.ts";

export type NoiseSuppressionMode = "auto" | "neural" | "dsp" | "off";
export type VadEngineMode = "silero" | "adaptive";

export interface LocalVoiceModelPaths {
  modelsDir: string;
  gtcrn: string;
  sileroVad: string;
  speakerCampp: string;
  senseVoiceDir: string;
  senseVoiceModel: string;
  senseVoiceTokens: string;
}

export interface LocalVoiceEngineStatus {
  addonAvailable: boolean;
  addonVersion: string | null;
  modelsDir: string;
  models: {
    gtcrn: boolean;
    sileroVad: boolean;
    speakerCampp: boolean;
    senseVoice: boolean;
  };
  readyForDenoise: boolean;
  readyForVad: boolean;
  readyForVoiceprint: boolean;
  readyForLocalAsr: boolean;
  downloading: boolean;
  lastError: string | null;
}

export interface DenoiseOutput {
  samples: Float32Array;
  sampleRate: number;
  engine: "gtcrn" | "dsp" | "off";
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

export interface LocalAsrOutput {
  text: string;
  rawText: string;
  lang: string;
  emotion: string;
  event: string;
  engine: "sensevoice-local";
  durationMs: number;
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
  Vad: new (cfg: Record<string, unknown>, bufferSizeInSeconds: number) => {
    acceptWaveform(samples: Float32Array): void;
    isEmpty(): boolean;
    isDetected(): boolean;
    front(): { start: number; samples: Float32Array };
    pop(): void;
    flush(): void;
    reset(): void;
    clear(): void;
  };
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
  gtcrn: "https://github.com/k2-fsa/sherpa-onnx/releases/download/speech-enhancement-models/gtcrn_simple.onnx",
  sileroVad: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx",
  speakerCampp:
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx",
  senseVoiceTar:
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2",
} as const;

const SENSE_VOICE_DIR_NAME = "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17";

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
  return {
    modelsDir,
    gtcrn: path.join(modelsDir, "gtcrn_simple.onnx"),
    sileroVad: path.join(modelsDir, "silero_vad.onnx"),
    speakerCampp: path.join(modelsDir, "3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx"),
    senseVoiceDir,
    senseVoiceModel: path.join(senseVoiceDir, "model.int8.onnx"),
    senseVoiceTokens: path.join(senseVoiceDir, "tokens.txt"),
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

export class LocalVoiceEngine {
  private readonly _modelsDirOverride?: string;
  private _denoiser: InstanceType<SherpaModuleLike["OfflineSpeechDenoiser"]> | null = null;
  private _speakerExtractor: InstanceType<SherpaModuleLike["SpeakerEmbeddingExtractor"]> | null =
    null;
  private _recognizers = new Map<
    string,
    Promise<Awaited<ReturnType<SherpaModuleLike["OfflineRecognizer"]["createAsync"]>>>
  >();
  private _downloading = false;
  private _lastError: string | null = null;

  constructor(options: { modelsDir?: string } = {}) {
    this._modelsDirOverride = options.modelsDir;
  }

  get paths(): LocalVoiceModelPaths {
    return resolveVoiceModelPaths(this._modelsDirOverride);
  }

  getStatus(): LocalVoiceEngineStatus {
    const sherpa = loadSherpaModule();
    const p = this.paths;
    const gtcrn = existsSync(p.gtcrn);
    const sileroVad = existsSync(p.sileroVad);
    const speakerCampp = existsSync(p.speakerCampp);
    const senseVoice = existsSync(p.senseVoiceModel) && existsSync(p.senseVoiceTokens);
    const addonAvailable = sherpa !== null;
    return {
      addonAvailable,
      addonVersion: sherpa?.version ?? null,
      modelsDir: p.modelsDir,
      models: { gtcrn, sileroVad, speakerCampp, senseVoice },
      readyForDenoise: addonAvailable && gtcrn,
      readyForVad: addonAvailable && sileroVad,
      readyForVoiceprint: addonAvailable && speakerCampp,
      readyForLocalAsr: addonAvailable && senseVoice,
      downloading: this._downloading,
      lastError: this._lastError,
    };
  }

  private _numThreads(): number {
    return Math.min(4, Math.max(2, Math.floor(os.cpus().length / 2)));
  }

  /**
   * 后台异步预热本地 ONNX 模型（GTCRN / CAM++ / SenseVoice），消除首句冷启动延迟。
   */
  async warmup(): Promise<void> {
    try {
      this._ensureDenoiser();
      this._ensureSpeakerExtractor();
      await this._ensureRecognizer("auto");
    } catch {
      // 预热失败不影响后续按需重试或降级
    }
  }

  private _ensureDenoiser(): InstanceType<SherpaModuleLike["OfflineSpeechDenoiser"]> | null {
    if (this._denoiser) return this._denoiser;
    const sherpa = loadSherpaModule();
    const p = this.paths;
    if (!sherpa || !existsSync(p.gtcrn)) return null;
    try {
      this._denoiser = new sherpa.OfflineSpeechDenoiser({
        model: {
          gtcrn: { model: p.gtcrn },
          numThreads: this._numThreads(),
          debug: false,
          provider: "cpu",
        },
      });
      return this._denoiser;
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
    if (!sherpa || !existsSync(p.senseVoiceModel) || !existsSync(p.senseVoiceTokens)) {
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
   * 实时语音环境降噪：优先 GTCRN 神经网络降噪，缺失或指定 dsp 时自动使用纯 TS 频谱减法。
   */
  denoise(
    input: Float32Array,
    sampleRate = 16000,
    mode: NoiseSuppressionMode = "auto",
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

    if (mode === "auto" || mode === "neural") {
      const denoiser = this._ensureDenoiser();
      if (denoiser) {
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
            engine: "gtcrn",
            inputSnrDb,
            outputSnrDb,
            snrGainDb: Number((outputSnrDb - inputSnrDb).toFixed(2)),
            durationMs: Math.round(performance.now() - t0),
          };
        } catch (err) {
          this._lastError = err instanceof Error ? err.message : String(err);
        }
      }
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
    const sherpa = loadSherpaModule();
    const p = this.paths;

    if (mode === "silero" && sherpa && existsSync(p.sileroVad) && pcm16k.length >= 512) {
      try {
        const threshold = Math.max(0.15, Math.min(0.85, options.threshold ?? 0.42));
        const vad = new sherpa.Vad(
          {
            sileroVad: {
              model: p.sileroVad,
              threshold,
              minSilenceDuration: 0.3,
              minSpeechDuration: 0.14,
              maxSpeechDuration: 20,
              windowSize: 512,
            },
            sampleRate: 16000,
            numThreads: 1,
            provider: "cpu",
            debug: false,
          },
          30,
        );

        const win = 512;
        for (let off = 0; off + win <= pcm16k.length; off += win) {
          vad.acceptWaveform(pcm16k.subarray(off, off + win));
        }
        vad.flush();

        const segments: Array<{ start: number; end: number }> = [];
        const padSamples = Math.round(16000 * 0.12); // 前后各留 120ms 安全余量
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
   * 声纹特征提取：优先 3D-Speaker CAM++（512 维深度说话人嵌入），缺失时自动降级 64 维梅尔声学指纹。
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
   * 本地离线高精度多语种 ASR（FunAudioLLM SenseVoiceSmall int8，异步非阻塞解码）。
   */
  async transcribeLocal(
    input: Float32Array,
    sampleRate = 16000,
    voiceLang = "zh-CN",
  ): Promise<LocalAsrOutput> {
    const t0 = performance.now();
    const pcm16k = sampleRate === 16000 ? input : resampleLinear(input, sampleRate, 16000);
    // 中文环境下使用 auto 能更好兼容中英混合（如 “小派 / pi / LED”）
    const svLang = voiceLang.toLowerCase().startsWith("zh-cn") ? "auto" : mapSenseVoiceLang(voiceLang);
    const recognizer = await this._ensureRecognizer(svLang);
    if (!recognizer) {
      throw new Error(
        "本地离线 SenseVoice 语音识别模型尚未就绪，请在「设置 → 语音与 Pi Agent」中点击一键下载本地语音模型，或配置 STT 接口。",
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
      engine: "sensevoice-local",
      durationMs: Math.round(performance.now() - t0),
    };
  }

  /**
   * 一键补齐下载缺失的本地 ONNX 模型（GTCRN / Silero VAD / 3D-Speaker CAM++ / SenseVoiceSmall int8）。
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

      const fetchFile = async (url: string, dest: string) => {
        if (existsSync(dest)) return;
        const part = `${dest}.part`;
        const res = await fetch(url, { redirect: "follow" });
        if (!res.ok) {
          throw new Error(`下载模型失败 (${res.status}): ${path.basename(dest)}`);
        }
        const buf = await res.arrayBuffer();
        await Bun.write(part, buf);
        renameSync(part, dest);
      };

      await fetchFile(MODEL_URLS.gtcrn, p.gtcrn);
      await fetchFile(MODEL_URLS.sileroVad, p.sileroVad);
      await fetchFile(MODEL_URLS.speakerCampp, p.speakerCampp);

      if (!existsSync(p.senseVoiceModel) || !existsSync(p.senseVoiceTokens)) {
        const tarPath = path.join(p.modelsDir, "sensevoice.tar.bz2");
        await fetchFile(MODEL_URLS.senseVoiceTar, tarPath);
        const proc = Bun.spawn(["tar", "-xjf", tarPath, "-C", p.modelsDir], {
          stdout: "ignore",
          stderr: "pipe",
        });
        const exitCode = await proc.exited;
        try {
          unlinkSync(tarPath);
        } catch {
          // ignore
        }
        if (exitCode !== 0) {
          const errText = await new Response(proc.stderr).text();
          throw new Error(`解压 SenseVoice 模型失败: ${errText.trim() || exitCode}`);
        }
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
    this._denoiser = null;
    this._speakerExtractor = null;
    this._recognizers.clear();
  }
}
