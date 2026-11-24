// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 声源分离评测共享 ONNX 模型与声学分析工具池

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import os from "node:os";
import {
  computeRms,
  cosineSimilarity,
  l2Normalize,
  resampleLinear,
} from "../../src/agent/audioPcm.ts";
import { LocalVoiceEngine } from "../../src/agent/localVoiceEngine.ts";
import type { SoundTypeLabel } from "./generate_dataset.ts";

export interface AudioTagPrediction {
  name: string;
  prob: number;
  index: number;
}

export interface SceneAnalysis {
  tags: AudioTagPrediction[];
  speechProb: number;
  musicProb: number;
  singingProb: number;
  noiseProb: number;
  crowdTvProb: number;
  detectedSoundTypes: SoundTypeLabel[];
  durationMs: number;
}

export interface DiarizationSegment {
  start: number;
  end: number;
  speaker: number;
}

export interface MusicSeparationResult {
  vocals16k: Float32Array;
  accompaniment16k: Float32Array;
  vocalToAccompDb: number;
  engine: "spleeter" | "uvr";
  durationMs: number;
}

const SPEECH_LABELS = new Set([
  "Speech",
  "Male speech, man speaking",
  "Female speech, woman speaking",
  "Child speech, kid speaking",
  "Conversation",
  "Narration, monologue",
  "Babbling",
  "Speech synthesizer",
]);

const SINGING_LABELS = new Set([
  "Singing",
  "Choir",
  "Yodeling",
  "Chant",
  "Mantra",
  "Male singing",
  "Female singing",
  "Child singing",
  "Synthetic singing",
  "Rapping",
  "Humming",
  "Vocal music",
  "A capella",
]);

const MUSIC_LABELS = new Set([
  "Music",
  "Musical instrument",
  "Plucked string instrument",
  "Guitar",
  "Acoustic guitar",
  "Electric guitar",
  "Piano",
  "Keyboard (musical)",
  "Electric piano",
  "Drum",
  "Drum kit",
  "Synthesizer",
  "Pop music",
  "Rock music",
  "Hip hop music",
  "Electronic music",
  "Background music",
  "Soundtrack music",
  "Lullaby",
  "Music of Asia",
  "Tender music",
  "Happy music",
  "Sad music",
  "Christian music",
  "Christmas music",
  "Dance music",
  "Jazz",
  "Classical music",
  "Country",
  "Folk",
]);

const NOISE_LABELS = new Set([
  "Noise",
  "White noise",
  "Pink noise",
  "Hum",
  "Static",
  "Mains hum",
  "Environmental noise",
  "Mechanical fan",
  "Air conditioning",
  "Vacuum cleaner",
  "Hair dryer",
  "Rain",
  "Rain on surface",
  "Raindrop",
  "Water",
  "Stream",
  "Typing",
  "Computer keyboard",
  "Typewriter",
  "Clickety-clack",
  "Clicking",
  "Chatter",
  "Crowd",
  "Hubbub, speech noise, speech babble",
  "Television",
  "Radio",
  "Engine",
  "Traffic noise, roadway noise",
  "Wind",
  "Wind noise (microphone)",
]);

const CROWD_TV_LABELS = new Set([
  "Chatter",
  "Crowd",
  "Hubbub, speech noise, speech babble",
  "Television",
  "Radio",
  "Conversation",
]);

export class SharedVoiceModelPool {
  readonly modelsDir: string;
  readonly localEngine: LocalVoiceEngine;
  private readonly _sherpa: any;
  private _cedTagger: any = null;
  private _diarizer: any = null;
  private _spleeter: any = null;
  private _uvr: any = null;
  private _voxlockCache = new Map<string, any>();

  constructor(modelsDir?: string) {
    this.modelsDir = path.resolve(modelsDir || path.join(import.meta.dir, "../../voice_models"));
    this.localEngine = new LocalVoiceEngine({ modelsDir: this.modelsDir });
    const req = createRequire(import.meta.url);
    this._sherpa = req("sherpa-onnx-node");
  }

  private _threads(): number {
    return Math.min(4, Math.max(2, Math.floor(os.cpus().length / 2)));
  }

  async warmupCore(wakeWords: readonly string[] = ["Neo"]): Promise<void> {
    await this.localEngine.warmup();
    this.localEngine.openWakeWord.ensureLoaded();
    await this.localEngine.openWakeWord.bootstrapWakeWords(wakeWords);
  }

  ensureCedTagger(): any {
    if (this._cedTagger) return this._cedTagger;
    const cedDir = path.join(this.modelsDir, "sherpa-onnx-ced-tiny-audio-tagging-2024-04-19");
    const modelPath = path.join(cedDir, "model.int8.onnx");
    const labelsPath = path.join(cedDir, "class_labels_indices.csv");
    if (!existsSync(modelPath) || !existsSync(labelsPath)) return null;
    this._cedTagger = new this._sherpa.AudioTagging({
      model: {
        ced: modelPath,
        numThreads: this._threads(),
        debug: false,
        provider: "cpu",
      },
      labels: labelsPath,
      topK: 20,
    });
    return this._cedTagger;
  }

  analyzeAudioScene(pcm16k: Float32Array, topK = 20): SceneAnalysis {
    const t0 = performance.now();
    const tagger = this.ensureCedTagger();
    if (!tagger) {
      return {
        tags: [],
        speechProb: 0.5,
        musicProb: 0,
        singingProb: 0,
        noiseProb: 0,
        crowdTvProb: 0,
        detectedSoundTypes: ["speech"],
        durationMs: Math.round(performance.now() - t0),
      };
    }

    const stream = tagger.createStream();
    stream.acceptWaveform({ samples: pcm16k, sampleRate: 16000 });
    const tags = (tagger.compute(stream, topK) ?? []) as AudioTagPrediction[];

    let speechProb = 0;
    let musicProb = 0;
    let singingProb = 0;
    let noiseProb = 0;
    let crowdTvProb = 0;

    for (const tag of tags) {
      const name = tag.name;
      const p = Number(tag.prob) || 0;
      if (SPEECH_LABELS.has(name)) speechProb = Math.max(speechProb, p);
      if (SINGING_LABELS.has(name) || name.toLowerCase().includes("sing")) {
        singingProb = Math.max(singingProb, p);
      }
      if (MUSIC_LABELS.has(name) || name.toLowerCase().includes("music") || name.toLowerCase().includes("guitar") || name.toLowerCase().includes("piano") || name.toLowerCase().includes("drum")) {
        musicProb = Math.max(musicProb, p);
      }
      if (NOISE_LABELS.has(name) || name.toLowerCase().includes("noise") || name.toLowerCase().includes("hum") || name.toLowerCase().includes("rain") || name.toLowerCase().includes("typing") || name.toLowerCase().includes("keyboard") || name.toLowerCase().includes("fan") || name.toLowerCase().includes("vacuum") || name.toLowerCase().includes("static") || name.toLowerCase().includes("hiss")) {
        noiseProb = Math.max(noiseProb, p);
      }
      if (CROWD_TV_LABELS.has(name)) {
        crowdTvProb = Math.max(crowdTvProb, p);
      }
    }

    const detectedSoundTypes: SoundTypeLabel[] = [];
    if (speechProb >= 0.14) detectedSoundTypes.push("speech");
    if (singingProb >= 0.055) detectedSoundTypes.push("song");
    if (musicProb >= 0.14 || singingProb >= 0.08) detectedSoundTypes.push("bgm");
    if (noiseProb >= 0.08 && musicProb < 0.35) detectedSoundTypes.push("noise");

    return {
      tags,
      speechProb,
      musicProb,
      singingProb,
      noiseProb,
      crowdTvProb,
      detectedSoundTypes,
      durationMs: Math.round(performance.now() - t0),
    };
  }

  ensureDiarizer(threshold = 0.55): any {
    if (this._diarizer) return this._diarizer;
    const pyannoteModel = path.join(
      this.modelsDir,
      "sherpa-onnx-pyannote-segmentation-3-0",
      "model.int8.onnx",
    );
    const embModel = path.join(this.modelsDir, "3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx");
    if (!existsSync(pyannoteModel) || !existsSync(embModel)) return null;
    this._diarizer = new this._sherpa.OfflineSpeakerDiarization({
      segmentation: {
        pyannote: { model: pyannoteModel },
        numThreads: this._threads(),
        provider: "cpu",
        debug: false,
      },
      embedding: {
        model: embModel,
        numThreads: this._threads(),
        provider: "cpu",
        debug: false,
      },
      clustering: { numClusters: -1, threshold },
      minDurationOn: 0.25,
      minDurationOff: 0.22,
    });
    return this._diarizer;
  }

  diarizeSpeakers(pcm16k: Float32Array, threshold = 0.55): {
    segments: DiarizationSegment[];
    speakerCount: number;
    durationMs: number;
  } {
    const t0 = performance.now();
    const sd = this.ensureDiarizer(threshold);
    if (!sd || pcm16k.length < 4000) {
      return { segments: [], speakerCount: 0, durationMs: Math.round(performance.now() - t0) };
    }
    try {
      sd.setConfig({ clustering: { numClusters: -1, threshold } });
    } catch {
      // ignore if unchanged
    }
    const rawSegs = (sd.process(pcm16k) ?? []) as DiarizationSegment[];
    const speakers = new Set(rawSegs.map((s) => s.speaker));
    return {
      segments: rawSegs,
      speakerCount: speakers.size,
      durationMs: Math.round(performance.now() - t0),
    };
  }

  ensureSpleeter(): any {
    if (this._spleeter) return this._spleeter;
    const dir = path.join(this.modelsDir, "sherpa-onnx-spleeter-2stems-fp16");
    const vocals = path.join(dir, "vocals.fp16.onnx");
    const accomp = path.join(dir, "accompaniment.fp16.onnx");
    if (!existsSync(vocals) || !existsSync(accomp)) return null;
    this._spleeter = new this._sherpa.OfflineSourceSeparation({
      model: {
        spleeter: { vocals, accompaniment: accomp },
        numThreads: this._threads(),
        provider: "cpu",
        debug: false,
      },
    });
    return this._spleeter;
  }

  ensureUvr(): any {
    if (this._uvr) return this._uvr;
    const uvrPath = path.join(this.modelsDir, "uvr", "UVR_MDXNET_1_9703.onnx");
    if (!existsSync(uvrPath)) return null;
    this._uvr = new this._sherpa.OfflineSourceSeparation({
      model: {
        uvr: { model: uvrPath },
        numThreads: this._threads(),
        provider: "cpu",
        debug: false,
      },
    });
    return this._uvr;
  }

  separateMusicStems(
    pcm16k: Float32Array,
    engine: "spleeter" | "uvr" = "spleeter",
  ): MusicSeparationResult | null {
    const t0 = performance.now();
    const sep = engine === "uvr" ? this.ensureUvr() : this.ensureSpleeter();
    if (!sep || pcm16k.length < 3200) return null;

    // 150ms 前后零填充以彻底规避 sherpa-onnx Spleeter FP16 首尾 ISTFT 边界归一化尖峰，分离后精确裁回原长度
    const padSamples = engine === "spleeter" ? 2400 : 0;
    let workInput = pcm16k;
    if (padSamples > 0) {
      workInput = new Float32Array(pcm16k.length + padSamples * 2);
      workInput.set(pcm16k, padSamples);
    }

    const res = sep.process({ samples: [workInput], sampleRate: 16000 });
    const rawVoc = res?.stems?.[0]?.[0];
    const rawAcc = res?.stems?.[1]?.[0];
    if (!rawVoc || !rawAcc) return null;

    const outSr = Number(res.sampleRate) || 44100;
    let vocals16k =
      outSr === 16000 ? new Float32Array(rawVoc) : resampleLinear(new Float32Array(rawVoc), outSr, 16000);
    let accompaniment16k =
      outSr === 16000 ? new Float32Array(rawAcc) : resampleLinear(new Float32Array(rawAcc), outSr, 16000);

    if (padSamples > 0) {
      const start = Math.min(padSamples, vocals16k.length);
      const end = Math.min(vocals16k.length, start + pcm16k.length);
      vocals16k = vocals16k.slice(start, end);
      const accStart = Math.min(padSamples, accompaniment16k.length);
      const accEnd = Math.min(accompaniment16k.length, accStart + pcm16k.length);
      accompaniment16k = accompaniment16k.slice(accStart, accEnd);
    }

    // 防御性清洗非有限值与极值尖峰
    for (let i = 0; i < vocals16k.length; i += 1) {
      const v = vocals16k[i]!;
      vocals16k[i] = Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0;
    }
    for (let i = 0; i < accompaniment16k.length; i += 1) {
      const v = accompaniment16k[i]!;
      accompaniment16k[i] = Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0;
    }

    const vocRms = Math.max(1e-6, computeRms(vocals16k));
    const accRms = Math.max(1e-6, computeRms(accompaniment16k));
    const vocalToAccompDb = Number((20 * Math.log10(vocRms / accRms)).toFixed(2));

    return {
      vocals16k,
      accompaniment16k,
      vocalToAccompDb,
      engine,
      durationMs: Math.round(performance.now() - t0),
    };
  }

  extractTargetSpeakerVoxLock(
    pcm16k: Float32Array,
    refWavPath: string,
  ): { samples: Float32Array; durationMs: number } | null {
    const t0 = performance.now();
    if (!existsSync(refWavPath)) return null;
    const p = this.localEngine.paths;
    if (!existsSync(p.voxlockEnroll) || !existsSync(p.voxlockChunk)) return null;

    let instance = this._voxlockCache.get(refWavPath);
    if (!instance) {
      instance = new this._sherpa.OfflineSpeechDenoiser({
        model: {
          voxlock: {
            enrollModel: p.voxlockEnroll,
            chunkModel: p.voxlockChunk,
            voiceSample: refWavPath,
          },
          numThreads: this._threads(),
          debug: false,
          provider: "cpu",
        },
      });
      this._voxlockCache.set(refWavPath, instance);
    }

    const out = instance.run({ samples: pcm16k, sampleRate: 16000 });
    const samples =
      out.sampleRate === 16000
        ? new Float32Array(out.samples)
        : resampleLinear(new Float32Array(out.samples), out.sampleRate, 16000);
    return {
      samples,
      durationMs: Math.round(performance.now() - t0),
    };
  }

  /**
   * 计算两段音频的 3D-Speaker CAM++ 声纹余弦相似度，用于快速说话人变更检测与说话人归属。
   */
  speakerSimilarity(a16k: Float32Array, b16k: Float32Array): number {
    if (a16k.length < 4000 || b16k.length < 4000) return 0;
    const ea = this.localEngine.extractSpeakerEmbedding(a16k, 16000);
    const eb = this.localEngine.extractSpeakerEmbedding(b16k, 16000);
    return cosineSimilarity(l2Normalize(ea.embedding), l2Normalize(eb.embedding));
  }

  dispose(): void {
    this._cedTagger = null;
    this._diarizer = null;
    this._spleeter = null;
    this._uvr = null;
    this._voxlockCache.clear();
    this.localEngine.dispose();
  }
}

/**
 * 轻量 DSP 声学特征分析（用于并行识别稳态噪声、音乐周期性/谐波性、歌声颤音特征等）。
 */
export function computeAcousticDiagnostics(pcm16k: Float32Array): {
  rms: number;
  zcrMean: number;
  zcrStd: number;
  lowBandRatio: number;
  midBandRatio: number;
  highBandRatio: number;
  frameEnergyStdRatio: number;
  spectralFlatnessApprox: number;
} {
  const frameLen = 320; // 20ms
  const frameCount = Math.floor(pcm16k.length / frameLen);
  if (frameCount < 3) {
    return {
      rms: computeRms(pcm16k),
      zcrMean: 0,
      zcrStd: 0,
      lowBandRatio: 0,
      midBandRatio: 1,
      highBandRatio: 0,
      frameEnergyStdRatio: 0,
      spectralFlatnessApprox: 0,
    };
  }

  const frameRms = new Float32Array(frameCount);
  const frameZcr = new Float32Array(frameCount);
  let totalSq = 0;

  // 简易三频带能量估计（一阶 IIR 低通 300Hz、高通 3400Hz）
  let lp300 = 0;
  let lp3400 = 0;
  const a300 = (2 * Math.PI * 300) / (16000 + 2 * Math.PI * 300);
  const a3400 = (2 * Math.PI * 3400) / (16000 + 2 * Math.PI * 3400);
  let eLow = 0;
  let eMid = 0;
  let eHigh = 0;

  for (let f = 0; f < frameCount; f += 1) {
    const base = f * frameLen;
    let sumSq = 0;
    let zc = 0;
    for (let i = 0; i < frameLen; i += 1) {
      const x = pcm16k[base + i]!;
      sumSq += x * x;
      totalSq += x * x;
      if (i > 0) {
        const p = pcm16k[base + i - 1]!;
        if ((x >= 0 && p < 0) || (x < 0 && p >= 0)) zc += 1;
      }
      lp300 += a300 * (x - lp300);
      lp3400 += a3400 * (x - lp3400);
      const low = lp300;
      const mid = lp3400 - lp300;
      const high = x - lp3400;
      eLow += low * low;
      eMid += mid * mid;
      eHigh += high * high;
    }
    frameRms[f] = Math.sqrt(sumSq / frameLen);
    frameZcr[f] = zc / frameLen;
  }

  let meanRms = 0;
  let meanZcr = 0;
  for (let f = 0; f < frameCount; f += 1) {
    meanRms += frameRms[f]!;
    meanZcr += frameZcr[f]!;
  }
  meanRms /= frameCount;
  meanZcr /= frameCount;

  let varRms = 0;
  let varZcr = 0;
  for (let f = 0; f < frameCount; f += 1) {
    varRms += (frameRms[f]! - meanRms) ** 2;
    varZcr += (frameZcr[f]! - meanZcr) ** 2;
  }
  const stdRms = Math.sqrt(varRms / frameCount);
  const stdZcr = Math.sqrt(varZcr / frameCount);

  const eTotal = Math.max(1e-12, eLow + eMid + eHigh);
  const gMean = Math.cbrt(Math.max(1e-18, (eLow / eTotal) * (eMid / eTotal) * (eHigh / eTotal)));
  const aMean = 1 / 3;

  return {
    rms: Math.sqrt(totalSq / Math.max(1, pcm16k.length)),
    zcrMean: meanZcr,
    zcrStd: stdZcr,
    lowBandRatio: eLow / eTotal,
    midBandRatio: eMid / eTotal,
    highBandRatio: eHigh / eTotal,
    frameEnergyStdRatio: meanRms > 1e-6 ? stdRms / meanRms : 0,
    spectralFlatnessApprox: Math.min(1, gMean / aMean),
  };
}
