// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * 自适应多级并行声源分离与说话人隔离语音识别引擎（S_Fused 最终落地架构）：
 *
 * 在嘈杂环境（歌曲演唱、纯伴奏 BGM、各类环境噪声、多人交替/重叠讲话、连续对话）中，
 * 先并行识别声音类型并将不同声源与不同说话人分离，再对目标人声段执行精准语音转换与唤醒注意力门控：
 * - Stage 0（~24ms）：CED-tiny 527 类并行声学事件分类（Speech / Song / BGM / Noise / Crowd-TV）
 *   + 前导背景窗歌声分辨 + 纯非语音/纯歌曲极速早退；
 * - Stage 1A（~350~650ms）：高信噪比干净单人极速直通路径；
 * - Stage 1B：DPDFNet4/GTCRN 语音增强 + VAD 边界保护型 Pyannote 3.0 / 3D-Speaker CAM++ 说话人隔离
 *   + 0.35s 轮次句首预留双语唤醒探针 + 同说话人唤醒续接 + 日常闲聊/第三人称早退；
 * - Stage 2A：按需触发边沿安全（前后 150ms 零填充防 ISTFT 尖峰）Spleeter 2-Stem 人声/伴奏分离；
 * - Stage 2B：按需触发缓存式 VoxLock 目标说话人提取（TSE）与「Spleeter -> VoxLock」级联分离，
 *   攻克多人同时并发重叠与强歌声/电视人声掩蔽；
 * - 优雅降级：任意可选分离/分类模型缺失时自动平滑回退，绝不中断主语音链路。
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import type { SourceSeparationMode } from "../core/agentConfigStore.ts";
import {
  applyHighPassFilter,
  computeRms,
  cosineSimilarity,
  estimateSnrDb,
  l2Normalize,
  resampleLinear,
} from "./audioPcm.ts";
import type { LocalAsrOutput, LocalVoiceEngine } from "./localVoiceEngine.ts";
import type { WakeWordAcousticHit } from "./openWakeWordEngine.ts";
import type { SystemOneClient } from "./systemOneClient.ts";
import {
  evaluateVoiceAttention,
  extractCommandAfterAcousticWake,
  findWakeWordSpan,
  hasSmartHomeDomainIntent,
  isThirdPersonNeoMention,
  isWakeQueryText,
  looksLikeDirectDeviceCommand,
  matchEnglishHeadWakeWord,
  stripLeadingVocativeOrFragment,
  trimTrailingMusicLyrics,
  type AttentionDecision,
  type AttentionLlmEvaluator,
  type ConversationTurnContext,
  type VoiceprintPolicyMode,
} from "./voiceAttentionGate.ts";
import { listVoiceprintRefWavPaths, type VoiceprintIdentifyResult } from "./voiceprintStore.ts";

export type SoundTypeTag = "speech" | "song" | "bgm" | "noise" | "multi_speaker";

export interface AudioTagItem {
  name: string;
  prob: number;
  index: number;
}

export interface AudioSceneAnalysis {
  tags: AudioTagItem[];
  speechProb: number;
  musicProb: number;
  singingProb: number;
  noiseProb: number;
  crowdTvProb: number;
  detectedSoundTypes: SoundTypeTag[];
  durationMs: number;
}

export interface SpeakerDiarizationSpan {
  start: number;
  end: number;
  speaker: number;
}

export interface MusicStemSeparationOutput {
  vocals16k: Float32Array;
  accompaniment16k: Float32Array;
  vocalToAccompDb: number;
  engine: "spleeter" | "uvr";
  durationMs: number;
}

export interface SeparatedAudioStreamInfo {
  streamId: string;
  kind: "speech" | "song_vocals" | "bgm_accompaniment" | "noise" | "speaker";
  speakerId?: string;
  startSec?: number;
  endSec?: number;
  energyRatio?: number;
  transcript?: string;
}

export interface SourceSeparationRunOptions {
  mode?: SourceSeparationMode;
  voiceLang?: string;
  wakeWordEnabled?: boolean;
  wakeWords?: readonly string[];
  attentionMode?: "smart" | "strict" | "off";
  bypassWakeWord?: boolean;
  awakeActive?: boolean;
  inConversation?: boolean;
  dialogState?: "standby" | "conversation";
  recentTurns?: readonly ConversationTurnContext[];
  lastSpokenReply?: string;
  lastSpokenAt?: number;
  now?: number;
  voiceprint?: VoiceprintIdentifyResult | null;
  voiceprintMode?: VoiceprintPolicyMode;
  systemOneClient?: SystemOneClient | null;
  llmEvaluator?: AttentionLlmEvaluator;
  speakerRefWavPaths?: ReadonlyArray<{ id: string; wavPath: string }>;
}

export interface SourceSeparationPipelineResult {
  speechDetected: boolean;
  text: string;
  altText?: string;
  acousticEvent: string;
  denoiseEngine: string;
  vadEngine: string;
  asrEngine: string;
  inputSnrDb: number;
  outputSnrDb: number;
  snrGainDb: number;
  detectedSoundTypes: SoundTypeTag[];
  detectedSpeakerCount: number;
  separatedStreams: SeparatedAudioStreamInfo[];
  acousticWake: WakeWordAcousticHit | null;
  attention: AttentionDecision;
  stageTimingsMs: Record<string, number>;
  totalMs: number;
}

export interface SourceSeparatorModelPaths {
  cedModel: string;
  cedLabels: string;
  pyannoteSegmentation: string;
  spleeterVocals: string;
  spleeterAccompaniment: string;
  uvrModel: string;
}

const SR = 16000;
const LEADING_PUNCT_RE = /^[\s,，。．.、!！?？:：;；\-—~～"“”'‘’]+/;
const TRAILING_PUNCT_RE = /[\s,，。．.、!！?？:：;；"“”'‘’]+$/;

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

const STRICT_IMPERATIVE_ACTION_RE =
  /^(?:请|帮我|给我|麻烦|快|赶紧|顺便|现在|把|将|再|稍微|还是|那就)?(?:打开|开启|开灯|关灯|熄灯|灭灯|亮灯|开机|关机|开空调|关空调|开风扇|关风扇|开窗|关窗|开电视|关电视|开音箱|关音箱|开音响|关音响|全开|全关|关掉|关闭|关上|开一下|关一下|调大|调小|调亮|调暗|调高|调低|调到|调成|设置|设定|设为|改成|换成|切换|播放|放一首|来一首|放歌|放音乐|播音乐|听歌|切歌|换歌|换一首|下一首|上一首|暂停|继续|停止|静音|取消静音|闭麦|开麦|大一点|小一点|亮一点|暗一点|高一点|低一点|暖一点|冷一点|查|查看|查询|看看|喂猫|喂狗|喂食|出粮|turn\s+(?:on|off)|open|close|set|play|pause|stop|mute|unmute|switch|check)/i;

const ACTION_VERB_ANYWHERE_RE =
  /(?:打开|开启|开灯|关灯|熄灯|灭灯|亮灯|关闭|关掉|关上|调亮|调暗|调大|调小|调高|调低|调到|调成|设置|设定|切换|播放|暂停|继续|停止|静音|闭麦|换一首|换歌|下一首|上一首|切歌|查看|查询|喂猫|喂狗|喂食|出粮|亮一点|暗一点|小一点|大一点|高一点|低一点|turn\s+(?:on|off)|open|close|set|play|pause|stop|mute)/i;

const DESCRIPTIVE_NON_COMMAND_RE =
  /(?:好像|有点松|修好之后|挺好的|挺好看|挺舒服|看书舒服|舒服多了|亮多了|真不错|很好听|经常听|那个开关|那个演示|什么时候买)/;

const RISKY_FUZZY_WAKE_SURFACES = new Set([
  "你好",
  "你有",
  "你又",
  "你给",
  "你欧",
  "你哦",
  "你o",
  "你0",
  "你用",
  "妞",
  "牛",
  "纽",
  "钮",
  "new",
  "near",
  "leo",
  "mio",
  "nero",
  "rio",
]);

const HOUSEHOLD_SIDETALK_RE =
  /(?:晚饭|午饭|早饭|吃什么|吃饭|火锅|烤鱼|炒菜|青菜|米饭|面条|筷子|倒水|杯水|递过来|洗点水果|买点水果|拿一下|递一下|快递|外卖|垃圾|收拾一下|擦干净|加班|太累了|早点睡|接电话|雨伞|电影票|买好了|海边|机票|耳机|公园|上班|地铁|泡茶|水烧开了|衣服都收|冰箱里|超市打折|开会的材料|编译报错|日志)/;

interface TimedSpeechSegment {
  startSample: number;
  endSample: number;
  startSec: number;
  endSec: number;
  samples: Float32Array;
}

interface TurnCandidate {
  branch: string;
  startSec: number;
  endSec: number;
  rawText: string;
  altText?: string;
  acousticEvent: string;
  decision: AttentionDecision;
  acousticWake: WakeWordAcousticHit | null;
  enHeadMatched: boolean;
  enHeadExact: boolean;
  hasSmartHome: boolean;
  hasActionVerb: boolean;
  priority: number;
  speakerId?: string;
  segPcm: Float32Array;
}

interface SherpaExtraModule {
  AudioTagging?: new (cfg: Record<string, unknown>) => {
    createStream(): { acceptWaveform(req: { samples: Float32Array; sampleRate: number }): void };
    compute(stream: unknown, topK?: number): AudioTagItem[];
  };
  OfflineSpeakerDiarization?: new (cfg: Record<string, unknown>) => {
    process(samples: Float32Array): SpeakerDiarizationSpan[];
    setConfig?(cfg: Record<string, unknown>): void;
  };
  OfflineSourceSeparation?: new (cfg: Record<string, unknown>) => {
    process(req: { samples: Float32Array[]; sampleRate: number }): {
      stems: Float32Array[][];
      sampleRate: number;
    };
  };
  OfflineSpeechDenoiser?: new (cfg: Record<string, unknown>) => {
    run(req: { samples: Float32Array; sampleRate: number }): {
      samples: Float32Array;
      sampleRate: number;
    };
  };
}

let cachedExtraSherpa: SherpaExtraModule | null | undefined;

function loadExtraSherpa(): SherpaExtraModule | null {
  if (cachedExtraSherpa !== undefined) return cachedExtraSherpa;
  try {
    const req = createRequire(import.meta.url);
    cachedExtraSherpa = req("sherpa-onnx-node") as SherpaExtraModule;
    return cachedExtraSherpa;
  } catch {
    cachedExtraSherpa = null;
    return null;
  }
}

export function resolveSourceSeparatorModelPaths(modelsDir: string): SourceSeparatorModelPaths {
  const cedDir = path.join(modelsDir, "sherpa-onnx-ced-tiny-audio-tagging-2024-04-19");
  const pyannoteDir = path.join(modelsDir, "sherpa-onnx-pyannote-segmentation-3-0");
  const spleeterDir = path.join(modelsDir, "sherpa-onnx-spleeter-2stems-fp16");
  const uvrDir = path.join(modelsDir, "uvr");
  return {
    cedModel: path.join(cedDir, "model.int8.onnx"),
    cedLabels: path.join(cedDir, "class_labels_indices.csv"),
    pyannoteSegmentation: path.join(pyannoteDir, "model.int8.onnx"),
    spleeterVocals: path.join(spleeterDir, "vocals.fp16.onnx"),
    spleeterAccompaniment: path.join(spleeterDir, "accompaniment.fp16.onnx"),
    uvrModel: path.join(uvrDir, "UVR_MDXNET_1_9703.onnx"),
  };
}

function cleanPunct(text: string): string {
  return text.replace(LEADING_PUNCT_RE, "").replace(TRAILING_PUNCT_RE, "").trim();
}

function isAmbiguousZhQuestion(text: string): boolean {
  const c = cleanPunct(text);
  return /^(?:你有|你又|你好|你给|你是)/.test(c) && /[吗嘛么呢]$/.test(c) && !isWakeQueryText(c.slice(2));
}

function isValidSmartHomeActionCommand(cmd: string): boolean {
  const c = cleanPunct(cmd);
  if (c.length < 2) return false;
  if (isAmbiguousZhQuestion(c) || DESCRIPTIVE_NON_COMMAND_RE.test(c) || HOUSEHOLD_SIDETALK_RE.test(c)) {
    return false;
  }
  return hasSmartHomeDomainIntent(c) && ACTION_VERB_ANYWHERE_RE.test(c);
}

function extractEmbeddedSmartHomeCommand(text: string): string {
  const cleaned = cleanPunct(text);
  if (!cleaned || isAmbiguousZhQuestion(cleaned)) return "";

  if (DESCRIPTIVE_NON_COMMAND_RE.test(cleaned) || HOUSEHOLD_SIDETALK_RE.test(cleaned)) {
    const clauses = cleaned.split(/[，,。！？!?;；]+/).map((s) => cleanPunct(s)).filter(Boolean);
    for (const c of clauses) {
      if (
        isValidSmartHomeActionCommand(c) &&
        (STRICT_IMPERATIVE_ACTION_RE.test(c) || /^(?:把|将|声音|音量|亮度)/.test(c))
      ) {
        return trimTrailingMusicLyrics(c);
      }
    }
    return "";
  }

  if (
    isValidSmartHomeActionCommand(cleaned) &&
    (STRICT_IMPERATIVE_ACTION_RE.test(cleaned) || /^(?:把|将|声音|音量|亮度)/.test(cleaned))
  ) {
    return trimTrailingMusicLyrics(cleaned);
  }

  const embeddedRe =
    /^.{1,6}?((?:把|将|帮我|请)?(?:打开|开启|开灯|关灯|熄灯|灭灯|关闭|关掉|关上|调亮|调暗|调大|调小|调到|调成|暂停|停止|静音|切换|播放|换一首|换歌|下一首|查看|查询|喂猫|喂食|出粮|声音小|声音大|音量调|亮度调).{0,24})$/;
  const m = embeddedRe.exec(cleaned);
  if (m && m[1]) {
    const sub = cleanPunct(m[1]);
    if (isValidSmartHomeActionCommand(sub)) return trimTrailingMusicLyrics(sub);
  }

  const baRe =
    /^.{1,6}?(把[\u4e00-\u9fff0-9a-z]{1,12}(?:打开|开启|关闭|关掉|关上|调亮|调暗|调大|调小|调高|调低|调到|调成)[\u4e00-\u9fff0-9%度点些]{0,8})/;
  const mb = baRe.exec(cleaned);
  if (mb && mb[1]) {
    const sub = cleanPunct(mb[1]);
    if (isValidSmartHomeActionCommand(sub)) return trimTrailingMusicLyrics(sub);
  }
  return "";
}

function matchSafeEnWake(
  enText: string,
  wakeWords: readonly string[],
  allowCommandGated: boolean,
): { wakeWord: string; exact: boolean } | null {
  const cleaned = cleanPunct(enText);
  if (!cleaned) return null;
  const lower = cleaned.toLowerCase();
  if (/^(?:no|not|now|ni\s*hao|knee|need|you\s+how|how)\b/i.test(lower)) {
    return null;
  }
  const direct = matchEnglishHeadWakeWord(cleaned, wakeWords, {
    allowCommandGatedAliases: allowCommandGated,
  });
  if (direct) {
    if (
      direct.fuzzy &&
      (/\b(?:new\s+york|near\s+(?:the|downtown|here)|no\s+stop|no\s+i)\b/i.test(lower) ||
        /^no\b/i.test(lower))
    ) {
      return null;
    }
    return { wakeWord: direct.wakeWord, exact: !direct.fuzzy };
  }
  if (allowCommandGated) {
    const hasAsciiWake = wakeWords.some((w) => /^[a-z][a-z0-9\s-]*$/i.test(w.trim()));
    if (
      hasAsciiWake &&
      /(?:^|\b)(?:hey\s+ne|he\s+ne|the\s+new|newal|nio|neio|neow|he\s+you|neo|neil|neal|niel)(?:\b|$)/i.test(
        lower,
      )
    ) {
      const target =
        wakeWords.find((w) => w.toLowerCase() === "neo") ??
        wakeWords.find((w) => /^[a-z][a-z0-9\s-]*$/i.test(w.trim()));
      if (target) return { wakeWord: target, exact: /\bneo\b/i.test(lower) };
    }
  }
  return null;
}

function slicePcmBySec(pcm16k: Float32Array, startSec: number, endSec: number, padSec = 0.08): Float32Array {
  const s = Math.max(0, Math.floor((startSec - padSec) * SR));
  const e = Math.min(pcm16k.length, Math.ceil((endSec + padSec) * SR));
  return e > s ? pcm16k.slice(s, e) : new Float32Array(0);
}

function computeSpectralFlatnessApprox(pcm16k: Float32Array): number {
  const frameLen = 320;
  const frameCount = Math.floor(pcm16k.length / frameLen);
  if (frameCount < 3) return 0;
  let lp300 = 0;
  let lp3400 = 0;
  const a300 = (2 * Math.PI * 300) / (SR + 2 * Math.PI * 300);
  const a3400 = (2 * Math.PI * 3400) / (SR + 2 * Math.PI * 3400);
  let eLow = 0;
  let eMid = 0;
  let eHigh = 0;
  for (let i = 0; i < frameCount * frameLen; i += 1) {
    const x = pcm16k[i]!;
    lp300 += a300 * (x - lp300);
    lp3400 += a3400 * (x - lp3400);
    const low = lp300;
    const mid = lp3400 - lp300;
    const high = x - lp3400;
    eLow += low * low;
    eMid += mid * mid;
    eHigh += high * high;
  }
  const eTotal = Math.max(1e-12, eLow + eMid + eHigh);
  const gMean = Math.cbrt(Math.max(1e-18, (eLow / eTotal) * (eMid / eTotal) * (eHigh / eTotal)));
  return Math.min(1, gMean * 3);
}

export class AudioSourceSeparator {
  private readonly _engine: LocalVoiceEngine;
  private _cedTagger: InstanceType<NonNullable<SherpaExtraModule["AudioTagging"]>> | null = null;
  private _diarizer: InstanceType<NonNullable<SherpaExtraModule["OfflineSpeakerDiarization"]>> | null =
    null;
  private _spleeter: InstanceType<NonNullable<SherpaExtraModule["OfflineSourceSeparation"]>> | null =
    null;
  private _voxlockCache = new Map<
    string,
    InstanceType<NonNullable<SherpaExtraModule["OfflineSpeechDenoiser"]>>
  >();

  constructor(engine: LocalVoiceEngine) {
    this._engine = engine;
  }

  get modelPaths(): SourceSeparatorModelPaths {
    return resolveSourceSeparatorModelPaths(this._engine.paths.modelsDir);
  }

  private _numThreads(): number {
    return Math.min(4, Math.max(2, Math.floor(os.cpus().length / 2)));
  }

  getModelAvailability(): {
    cedAudioTagging: boolean;
    pyannoteDiarization: boolean;
    spleeterSeparation: boolean;
    uvrSeparation: boolean;
  } {
    const mp = this.modelPaths;
    const sherpa = loadExtraSherpa();
    const ok = sherpa !== null;
    return {
      cedAudioTagging: ok && typeof sherpa?.AudioTagging === "function" && existsSync(mp.cedModel) && existsSync(mp.cedLabels),
      pyannoteDiarization:
        ok &&
        typeof sherpa?.OfflineSpeakerDiarization === "function" &&
        existsSync(mp.pyannoteSegmentation) &&
        existsSync(this._engine.paths.speakerCampp),
      spleeterSeparation:
        ok &&
        typeof sherpa?.OfflineSourceSeparation === "function" &&
        existsSync(mp.spleeterVocals) &&
        existsSync(mp.spleeterAccompaniment),
      uvrSeparation:
        ok && typeof sherpa?.OfflineSourceSeparation === "function" && existsSync(mp.uvrModel),
    };
  }

  warmup(): void {
    try {
      this._ensureCedTagger();
      this._ensureDiarizer();
      this._ensureSpleeter();
    } catch {
      // 预热异常绝不影响正常语音降级链路
    }
  }

  private _ensureCedTagger() {
    if (this._cedTagger) return this._cedTagger;
    const sherpa = loadExtraSherpa();
    const mp = this.modelPaths;
    if (!sherpa?.AudioTagging || !existsSync(mp.cedModel) || !existsSync(mp.cedLabels)) {
      return null;
    }
    try {
      this._cedTagger = new sherpa.AudioTagging({
        model: {
          ced: mp.cedModel,
          numThreads: this._numThreads(),
          debug: false,
          provider: "cpu",
        },
        labels: mp.cedLabels,
        topK: 20,
      });
      return this._cedTagger;
    } catch {
      return null;
    }
  }

  private _ensureDiarizer() {
    if (this._diarizer) return this._diarizer;
    const sherpa = loadExtraSherpa();
    const mp = this.modelPaths;
    if (
      !sherpa?.OfflineSpeakerDiarization ||
      !existsSync(mp.pyannoteSegmentation) ||
      !existsSync(this._engine.paths.speakerCampp)
    ) {
      return null;
    }
    try {
      this._diarizer = new sherpa.OfflineSpeakerDiarization({
        segmentation: {
          pyannote: { model: mp.pyannoteSegmentation },
          numThreads: this._numThreads(),
          provider: "cpu",
          debug: false,
        },
        embedding: {
          model: this._engine.paths.speakerCampp,
          numThreads: this._numThreads(),
          provider: "cpu",
          debug: false,
        },
        clustering: { numClusters: -1, threshold: 0.52 },
        minDurationOn: 0.25,
        minDurationOff: 0.22,
      });
      return this._diarizer;
    } catch {
      return null;
    }
  }

  private _ensureSpleeter() {
    if (this._spleeter) return this._spleeter;
    const sherpa = loadExtraSherpa();
    const mp = this.modelPaths;
    if (
      !sherpa?.OfflineSourceSeparation ||
      !existsSync(mp.spleeterVocals) ||
      !existsSync(mp.spleeterAccompaniment)
    ) {
      return null;
    }
    try {
      this._spleeter = new sherpa.OfflineSourceSeparation({
        model: {
          spleeter: {
            vocals: mp.spleeterVocals,
            accompaniment: mp.spleeterAccompaniment,
          },
          numThreads: this._numThreads(),
          provider: "cpu",
          debug: false,
        },
      });
      return this._spleeter;
    } catch {
      return null;
    }
  }

  /**
   * Stage 0：并行声学场景识别（CED-tiny 527 类音频事件标签，识别人声/歌曲/BGM/环境噪声/电视群聊）。
   */
  analyzeAudioScene(pcm16k: Float32Array, topK = 20): AudioSceneAnalysis {
    const t0 = performance.now();
    const tagger = this._ensureCedTagger();
    if (!tagger || pcm16k.length < 1600) {
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

    try {
      const stream = tagger.createStream();
      stream.acceptWaveform({ samples: pcm16k, sampleRate: SR });
      const tags = (tagger.compute(stream, topK) ?? []) as AudioTagItem[];

      let speechProb = 0;
      let musicProb = 0;
      let singingProb = 0;
      let noiseProb = 0;
      let crowdTvProb = 0;

      for (const tag of tags) {
        const name = tag.name;
        const p = Number(tag.prob) || 0;
        const lower = name.toLowerCase();
        if (SPEECH_LABELS.has(name)) speechProb = Math.max(speechProb, p);
        if (SINGING_LABELS.has(name) || lower.includes("sing")) {
          singingProb = Math.max(singingProb, p);
        }
        if (
          MUSIC_LABELS.has(name) ||
          lower.includes("music") ||
          lower.includes("guitar") ||
          lower.includes("piano") ||
          lower.includes("drum")
        ) {
          musicProb = Math.max(musicProb, p);
        }
        if (
          NOISE_LABELS.has(name) ||
          lower.includes("noise") ||
          lower.includes("hum") ||
          lower.includes("rain") ||
          lower.includes("typing") ||
          lower.includes("keyboard") ||
          lower.includes("fan") ||
          lower.includes("vacuum") ||
          lower.includes("static") ||
          lower.includes("hiss")
        ) {
          noiseProb = Math.max(noiseProb, p);
        }
        if (CROWD_TV_LABELS.has(name)) crowdTvProb = Math.max(crowdTvProb, p);
      }

      const detectedSoundTypes: SoundTypeTag[] = [];
      if (speechProb >= 0.14) detectedSoundTypes.push("speech");
      if (singingProb >= 0.048) detectedSoundTypes.push("song");
      if (musicProb >= 0.18 || singingProb >= 0.05) detectedSoundTypes.push("bgm");
      if (noiseProb >= 0.10 && musicProb < 0.25) detectedSoundTypes.push("noise");

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
    } catch {
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
  }

  /**
   * 边沿安全 Spleeter 2-Stem 人声/伴奏分离（前后 150ms 零填充彻底消除 ISTFT 边界归一化尖峰）。
   */
  separateMusicStems(pcm16k: Float32Array): MusicStemSeparationOutput | null {
    const t0 = performance.now();
    const sep = this._ensureSpleeter();
    if (!sep || pcm16k.length < 3200) return null;

    try {
      const padSamples = 2400; // 150ms @ 16kHz
      const padded = new Float32Array(pcm16k.length + padSamples * 2);
      padded.set(pcm16k, padSamples);

      const res = sep.process({ samples: [padded], sampleRate: SR });
      const rawVoc = res?.stems?.[0]?.[0];
      const rawAcc = res?.stems?.[1]?.[0];
      if (!rawVoc || !rawAcc) return null;

      const outSr = Number(res.sampleRate) || 44100;
      let vocals16k =
        outSr === SR
          ? new Float32Array(rawVoc)
          : resampleLinear(new Float32Array(rawVoc), outSr, SR);
      let accompaniment16k =
        outSr === SR
          ? new Float32Array(rawAcc)
          : resampleLinear(new Float32Array(rawAcc), outSr, SR);

      const vStart = Math.min(padSamples, vocals16k.length);
      const vEnd = Math.min(vocals16k.length, vStart + pcm16k.length);
      vocals16k = vocals16k.slice(vStart, vEnd);

      const aStart = Math.min(padSamples, accompaniment16k.length);
      const aEnd = Math.min(accompaniment16k.length, aStart + pcm16k.length);
      accompaniment16k = accompaniment16k.slice(aStart, aEnd);

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
        engine: "spleeter",
        durationMs: Math.round(performance.now() - t0),
      };
    } catch {
      return null;
    }
  }

  /**
   * Pyannote 3.0 + 3D-Speaker CAM++ 离线说话人日志分段。
   */
  diarizeSpeakers(
    pcm16k: Float32Array,
    threshold = 0.52,
  ): { segments: SpeakerDiarizationSpan[]; speakerCount: number; durationMs: number } {
    const t0 = performance.now();
    const sd = this._ensureDiarizer();
    if (!sd || pcm16k.length < 4000) {
      return { segments: [], speakerCount: 0, durationMs: Math.round(performance.now() - t0) };
    }
    try {
      sd.setConfig?.({ clustering: { numClusters: -1, threshold } });
      const segments = (sd.process(pcm16k) ?? []) as SpeakerDiarizationSpan[];
      const speakerCount = new Set(segments.map((s) => s.speaker)).size;
      return { segments, speakerCount, durationMs: Math.round(performance.now() - t0) };
    } catch {
      return { segments: [], speakerCount: 0, durationMs: Math.round(performance.now() - t0) };
    }
  }

  /**
   * VoxLock 目标说话人提取（TSE）：按注册参考声纹 WAV 锁定目标人声，抑制并发串话、电视人声与背景歌手。
   */
  extractTargetSpeakerVoxLock(
    pcm16k: Float32Array,
    refWavPath: string,
  ): { samples: Float32Array; durationMs: number } | null {
    const t0 = performance.now();
    const sherpa = loadExtraSherpa();
    const p = this._engine.paths;
    if (
      !sherpa?.OfflineSpeechDenoiser ||
      !refWavPath ||
      !existsSync(refWavPath) ||
      !existsSync(p.voxlockEnroll) ||
      !existsSync(p.voxlockChunk)
    ) {
      return null;
    }

    try {
      let instance = this._voxlockCache.get(refWavPath);
      if (!instance) {
        instance = new sherpa.OfflineSpeechDenoiser({
          model: {
            voxlock: {
              enrollModel: p.voxlockEnroll,
              chunkModel: p.voxlockChunk,
              voiceSample: refWavPath,
            },
            numThreads: this._numThreads(),
            debug: false,
            provider: "cpu",
          },
        });
        this._voxlockCache.set(refWavPath, instance);
      }
      const out = instance.run({ samples: pcm16k, sampleRate: SR });
      const samples =
        out.sampleRate === SR
          ? new Float32Array(out.samples)
          : resampleLinear(new Float32Array(out.samples), out.sampleRate, SR);
      return { samples, durationMs: Math.round(performance.now() - t0) };
    } catch {
      return null;
    }
  }

  private _extractTimedVadSegments(
    pcm16k: Float32Array,
    options: { threshold?: number; minSilenceDuration?: number; padSec?: number; mergeGapSec?: number } = {},
  ): TimedSpeechSegment[] {
    const padSamples = Math.round((options.padSec ?? 0.12) * SR);
    const mergeGapSamples = Math.round((options.mergeGapSec ?? 0.12) * SR);
    const vad = this._engine.createStreamingVad({
      threshold: options.threshold ?? 0.36,
      minSilenceDuration: options.minSilenceDuration ?? 0.22,
      minSpeechDuration: 0.14,
      maxSpeechDuration: 15,
    });
    if (!vad || pcm16k.length < 512) {
      const fb = this._engine.detectSpeechSegments(pcm16k, SR, { mode: "adaptive" });
      return fb.hasSpeech
        ? [
            {
              startSample: 0,
              endSample: pcm16k.length,
              startSec: 0,
              endSec: Number((pcm16k.length / SR).toFixed(3)),
              samples: pcm16k,
            },
          ]
        : [];
    }
    try {
      for (let off = 0; off + 512 <= pcm16k.length; off += 512) {
        vad.acceptWaveform(pcm16k.subarray(off, off + 512));
      }
      vad.flush();
      const ranges: Array<{ s: number; e: number }> = [];
      while (!vad.isEmpty()) {
        const seg = vad.front();
        vad.pop();
        if (seg && seg.samples && seg.samples.length > 0) {
          const s = Math.max(0, seg.start - padSamples);
          const e = Math.min(pcm16k.length, seg.start + seg.samples.length + padSamples);
          const prev = ranges[ranges.length - 1];
          if (prev && s <= prev.e + mergeGapSamples) {
            prev.e = Math.max(prev.e, e);
          } else {
            ranges.push({ s, e });
          }
        }
      }
      vad.clear();
      return ranges
        .filter((r) => r.e - r.s >= Math.round(SR * 0.18))
        .map((r) => ({
          startSample: r.s,
          endSample: r.e,
          startSec: Number((r.s / SR).toFixed(3)),
          endSec: Number((r.e / SR).toFixed(3)),
          samples: pcm16k.slice(r.s, r.e),
        }));
    } catch {
      return [];
    }
  }

  private _detectBackgroundSongFromPreRoll(
    pcm16k: Float32Array,
    scene: AudioSceneAnalysis,
    firstSpeechStartSec: number,
  ): { isSong: boolean; isNoise: boolean } {
    let isSong = scene.singingProb >= 0.045;
    let isNoise = false;

    if (!isSong && scene.musicProb >= 0.20) {
      const hasVocalMusicTag = scene.tags.some(
        (t) =>
          t.prob >= 0.045 &&
          /singing|vocal|pop music|music of asia|tender music|sad music|lullaby|christmas music|christian music|choir/i.test(
            t.name,
          ),
      );
      if (firstSpeechStartSec >= 0.42) {
        const bgSlice = pcm16k.subarray(0, Math.min(pcm16k.length, Math.round(firstSpeechStartSec * SR)));
        if (bgSlice.length >= Math.round(0.4 * SR) && computeRms(bgSlice) >= 0.015) {
          const bgScene = this.analyzeAudioScene(bgSlice, 12);
          if (bgScene.singingProb >= 0.04 || (bgScene.speechProb >= 0.12 && bgScene.musicProb >= 0.35)) {
            isSong = true;
          }
          if (bgScene.noiseProb >= 0.20 && bgScene.musicProb < 0.25) {
            isNoise = true;
          }
        }
      }
      if (!isSong && hasVocalMusicTag && scene.singingProb >= 0.015) {
        isSong = true;
      }
    }
    return { isSong, isNoise };
  }

  private _splitLongSegmentBySpeakerChange(
    seg: TimedSpeechSegment,
    simThreshold = 0.42,
  ): TimedSpeechSegment[] {
    if (seg.samples.length / SR < 2.8) return [seg];
    const winSamples = Math.round(1.15 * SR);
    const stepSamples = Math.round(0.55 * SR);
    const windows: Array<{ center: number; emb: number[] }> = [];

    for (let off = 0; off + winSamples <= seg.samples.length; off += stepSamples) {
      const slice = seg.samples.subarray(off, off + winSamples);
      if (computeRms(slice) < 0.014) continue;
      const emb = l2Normalize(this._engine.extractSpeakerEmbedding(slice, SR).embedding);
      windows.push({ center: off + Math.floor(winSamples / 2), emb });
    }
    if (windows.length < 2) return [seg];

    const cutOffsets: number[] = [];
    for (let i = 0; i < windows.length - 1; i += 1) {
      if (cosineSimilarity(windows[i]!.emb, windows[i + 1]!.emb) < simThreshold) {
        const lo = windows[i]!.center;
        const hi = windows[i + 1]!.center;
        let minE = Infinity;
        let minPos = Math.floor((lo + hi) / 2);
        for (let pos = lo; pos + 480 <= hi; pos += 480) {
          const e = computeRms(seg.samples.subarray(pos, pos + 480));
          if (e < minE) {
            minE = e;
            minPos = pos + 240;
          }
        }
        if (
          minPos >= Math.round(0.75 * SR) &&
          seg.samples.length - minPos >= Math.round(0.75 * SR) &&
          (cutOffsets.length === 0 || minPos - cutOffsets[cutOffsets.length - 1]! >= Math.round(1.0 * SR))
        ) {
          cutOffsets.push(minPos);
        }
      }
    }
    if (cutOffsets.length === 0) return [seg];

    const boundaries = [0, ...cutOffsets, seg.samples.length];
    const out: TimedSpeechSegment[] = [];
    for (let i = 0; i < boundaries.length - 1; i += 1) {
      const relS = Math.max(0, boundaries[i]! - Math.round(0.10 * SR));
      const relE = Math.min(seg.samples.length, boundaries[i + 1]! + Math.round(0.10 * SR));
      if (relE - relS < Math.round(0.55 * SR)) continue;
      const absS = seg.startSample + relS;
      const absE = seg.startSample + relE;
      out.push({
        startSample: absS,
        endSample: absE,
        startSec: Number((absS / SR).toFixed(3)),
        endSec: Number((absE / SR).toFixed(3)),
        samples: seg.samples.slice(relS, relE),
      });
    }
    return out.length > 0 ? out : [seg];
  }

  private _verifyDistinctSpeakerCount(
    cleanTrack: Float32Array,
    turns: ReadonlyArray<{ startSec: number; endSec: number; speakerId: string }>,
    simThreshold: number,
  ): number {
    const bySpeaker = new Map<string, Float32Array[]>();
    for (const t of turns) {
      if (t.endSec - t.startSec < 0.42) continue;
      const sl = slicePcmBySec(cleanTrack, t.startSec, t.endSec, 0);
      if (sl.length < 6400 || computeRms(sl) < 0.015) continue;
      const arr = bySpeaker.get(t.speakerId) ?? [];
      arr.push(sl);
      bySpeaker.set(t.speakerId, arr);
    }
    const embs: number[][] = [];
    for (const [, chunks] of bySpeaker) {
      chunks.sort((a, b) => b.length - a.length);
      const emb = l2Normalize(this._engine.extractSpeakerEmbedding(chunks[0]!, SR).embedding);
      if (!embs.some((e) => cosineSimilarity(e, emb) >= simThreshold)) {
        embs.push(emb);
      }
    }
    return Math.max(embs.length, turns.length > 0 ? 1 : 0);
  }

  private async _evaluateTurnCandidate(params: {
    branch: string;
    startSec: number;
    endSec: number;
    segPcm: Float32Array;
    probePcm?: Float32Array;
    altSegPcm?: Float32Array;
    zhRes: LocalAsrOutput;
    altZhRes?: LocalAsrOutput | null;
    opts: SourceSeparationRunOptions;
    scene: AudioSceneAnalysis;
    globalTextContext: string;
    isTseOrMusicSeparated: boolean;
    speakerId?: string;
  }): Promise<TurnCandidate> {
    const {
      branch,
      startSec,
      endSec,
      segPcm,
      probePcm,
      altSegPcm,
      zhRes,
      altZhRes,
      opts,
      scene,
      globalTextContext,
      isTseOrMusicSeparated,
      speakerId,
    } = params;
    const wakeWords = opts.wakeWords ?? ["Neo"];
    const wakeWordEnabled = opts.wakeWordEnabled !== false;
    const inConv = opts.dialogState === "conversation" || Boolean(opts.inConversation) || Boolean(opts.awakeActive);
    const primaryText = zhRes.text.trim();
    const altText = altZhRes?.text?.trim() ?? "";
    const effectiveProbePcm = probePcm && probePcm.length >= 1600 ? probePcm : segPcm;

    const makeRejected = (
      stage: AttentionDecision["stage"],
      reason: string,
      owwHit: WakeWordAcousticHit | null = null,
    ): TurnCandidate => ({
      branch,
      startSec,
      endSec,
      rawText: primaryText || altText,
      altText: altText || undefined,
      acousticEvent: zhRes.event || altZhRes?.event || "",
      decision: {
        accept: false,
        wokeOnly: false,
        addressed: false,
        inConversation: inConv,
        confidence: 0.9,
        stage,
        reason,
        wakeWord: null,
        command: "",
        usedLlm: false,
        latencyMs: 0,
      },
      acousticWake: owwHit,
      enHeadMatched: false,
      enHeadExact: false,
      hasSmartHome: false,
      hasActionVerb: false,
      priority: -100,
      speakerId,
      segPcm,
    });

    if (!primaryText && !altText) {
      return makeRejected("no-wake", "分段转写为空");
    }

    if (
      !opts.bypassWakeWord &&
      wakeWordEnabled &&
      (isThirdPersonNeoMention(primaryText) ||
        (altText && isThirdPersonNeoMention(altText)) ||
        (globalTextContext &&
          isThirdPersonNeoMention(globalTextContext) &&
          !STRICT_IMPERATIVE_ACTION_RE.test(primaryText)))
    ) {
      return makeRejected("pragmatic-reject", "检测到第三人称提及或否定呼唤语境，拒绝触发");
    }

    let bestText = primaryText || altText;
    let bestEvent = zhRes.event;
    if (altText && altText !== primaryText) {
      const pSpan = findWakeWordSpan(primaryText, wakeWords);
      const aSpan = findWakeWordSpan(altText, wakeWords);
      const pCmd = extractEmbeddedSmartHomeCommand(primaryText);
      const aCmd = extractEmbeddedSmartHomeCommand(altText);
      const pScore =
        (pSpan ? (pSpan.fuzzy ? 55 : 100) : 0) +
        (pCmd ? 50 : 0) +
        (isValidSmartHomeActionCommand(primaryText) ? 25 : 0) -
        (primaryText.match(/[\u3040-\u30ff\uac00-\ud7af]/g)?.length ?? 0) * 15;
      const aScore =
        (aSpan ? (aSpan.fuzzy ? 55 : 100) : 0) +
        (aCmd ? 50 : 0) +
        (isValidSmartHomeActionCommand(altText) ? 25 : 0) -
        (altText.match(/[\u3040-\u30ff\uac00-\ud7af]/g)?.length ?? 0) * 15;
      if (aScore > pScore) {
        bestText = altText;
        bestEvent = altZhRes?.event || bestEvent;
      }
    }

    if (!opts.bypassWakeWord && wakeWordEnabled && !inConv && isAmbiguousZhQuestion(bestText)) {
      return makeRejected("pragmatic-reject", "中文日常问句近音陷阱，禁止误唤");
    }

    const hasDomain = hasSmartHomeDomainIntent(bestText);
    if (
      !opts.bypassWakeWord &&
      inConv &&
      !findWakeWordSpan(bestText, wakeWords) &&
      scene.singingProb >= 0.10 &&
      scene.speechProb < 0.28 &&
      !hasDomain
    ) {
      return makeRejected("acoustic", "连续对话窗口内识别为纯歌曲演唱歌词，已拦截");
    }

    let acousticWake = this._engine.scoreWakeWordAudio(effectiveProbePcm, wakeWords, {
      threshold: 0.6,
      headOnlySec: Math.min(3.0, Math.max(1.8, effectiveProbePcm.length / SR)),
    });
    if (altSegPcm && altSegPcm.length >= 1600 && (!acousticWake || !acousticWake.matched)) {
      const altHit = this._engine.scoreWakeWordAudio(altSegPcm, wakeWords, {
        threshold: 0.6,
        headOnlySec: Math.min(3.0, Math.max(1.8, altSegPcm.length / SR)),
      });
      if (altHit && (!acousticWake || altHit.score > acousticWake.score)) {
        acousticWake = altHit;
      }
    }

    let workingText = bestText;
    let wakeSpan = wakeWordEnabled ? findWakeWordSpan(workingText, wakeWords) : null;
    let enHeadMatched = false;
    let enHeadExact = false;

    if (
      wakeSpan &&
      wakeSpan.fuzzy &&
      RISKY_FUZZY_WAKE_SURFACES.has(wakeSpan.matchedSurface.toLowerCase())
    ) {
      const rawAfter = cleanPunct(workingText.slice(wakeSpan.endIndex));
      const isWakeQ = isWakeQueryText(rawAfter);
      const isHelloQuery = wakeSpan.matchedSurface === "你好" && isWakeQ;
      const isInterrogative = /[吗嘛么呢]$/.test(rawAfter) && !isWakeQ;
      const cmdOk = isValidSmartHomeActionCommand(wakeSpan.afterText);
      if (isHelloQuery || isInterrogative || (!isWakeQ && !cmdOk)) {
        wakeSpan = null;
      }
    }

    const embeddedCmd = extractEmbeddedSmartHomeCommand(workingText);
    const meaningfulChars = workingText.replace(/[\s,，。．.、!！?？:：;；\-—~～"'“”‘’]/g, "");
    const hasWeirdScript = /[\u3040-\u30ff\uac00-\ud7af]/.test(workingText);
    const isShortOrGarbled = segPcm.length <= SR * 1.9 || meaningfulChars.length <= 4 || hasWeirdScript;
    const looksLikeCmdForWake =
      embeddedCmd.length >= 2 ||
      isValidSmartHomeActionCommand(extractCommandAfterAcousticWake(workingText, wakeWords[0] ?? "Neo"));
    const hasAsciiWake = wakeWords.some((w) => /^[a-z][a-z0-9\s-]*$/i.test(w.trim()));

    if (
      !opts.bypassWakeWord &&
      wakeWordEnabled &&
      hasAsciiWake &&
      !inConv &&
      (!wakeSpan || wakeSpan.fuzzy) &&
      (isShortOrGarbled || looksLikeCmdForWake)
    ) {
      const probeWindows: Float32Array[] = [];
      probeWindows.push(effectiveProbePcm.subarray(0, Math.min(effectiveProbePcm.length, Math.round(SR * 1.25))));
      if (effectiveProbePcm.length >= Math.round(SR * 0.72)) {
        probeWindows.push(effectiveProbePcm.subarray(0, Math.round(SR * 0.68)));
      }
      if (embeddedCmd.length >= 2 && effectiveProbePcm.length >= Math.round(SR * 1.35)) {
        probeWindows.push(
          effectiveProbePcm.subarray(
            Math.round(SR * 0.35),
            Math.min(effectiveProbePcm.length, Math.round(SR * 1.35)),
          ),
        );
        if (effectiveProbePcm.length >= Math.round(SR * 1.6)) {
          probeWindows.push(
            effectiveProbePcm.subarray(
              Math.round(SR * 0.65),
              Math.min(effectiveProbePcm.length, Math.round(SR * 1.6)),
            ),
          );
        }
      }
      if (acousticWake && acousticWake.sampleOffset > Math.round(SR * 0.9)) {
        const peakStart = Math.max(0, acousticWake.sampleOffset - Math.round(SR * 0.9));
        const peakEnd = Math.min(effectiveProbePcm.length, acousticWake.sampleOffset + Math.round(SR * 0.2));
        if (peakEnd - peakStart >= Math.round(SR * 0.4)) {
          probeWindows.push(effectiveProbePcm.subarray(peakStart, peakEnd));
        }
      }
      if (altSegPcm && altSegPcm.length >= 1600) {
        probeWindows.push(altSegPcm.subarray(0, Math.min(altSegPcm.length, Math.round(SR * 1.25))));
      }

      for (const win of probeWindows) {
        if (win.length < 1600) continue;
        const enRes = await this._engine.transcribeLocal(win, SR, "en-US");
        const enHit = matchSafeEnWake(enRes.text, wakeWords, looksLikeCmdForWake);
        if (enHit) {
          enHeadMatched = true;
          enHeadExact = enHit.exact;
          const cmd = embeddedCmd || extractCommandAfterAcousticWake(workingText, enHit.wakeWord);
          const cleanCmd = cmd ? trimTrailingMusicLyrics(cmd) : "";
          if (cleanCmd && !isWakeQueryText(cleanCmd) && isValidSmartHomeActionCommand(cleanCmd)) {
            workingText = `${enHit.wakeWord}，${cleanCmd}`;
            wakeSpan = findWakeWordSpan(workingText, wakeWords);
          } else if (isShortOrGarbled && (enHit.exact || (acousticWake && acousticWake.score >= 0.42))) {
            workingText = enHit.wakeWord;
            wakeSpan = findWakeWordSpan(workingText, wakeWords);
          }
          break;
        }
      }
    }

    if (!opts.bypassWakeWord && wakeWordEnabled && !inConv && !wakeSpan && acousticWake) {
      const highOwwOk =
        acousticWake.matched &&
        !HOUSEHOLD_SIDETALK_RE.test(workingText) &&
        !DESCRIPTIVE_NON_COMMAND_RE.test(workingText);
      const tseAssistedOk =
        isTseOrMusicSeparated &&
        acousticWake.score >= 0.43 &&
        embeddedCmd.length >= 2 &&
        isValidSmartHomeActionCommand(embeddedCmd);

      if (highOwwOk || tseAssistedOk) {
        const cmd = embeddedCmd || extractCommandAfterAcousticWake(workingText, acousticWake.wakeWord);
        const cleanCmd = cmd ? trimTrailingMusicLyrics(cmd) : "";
        if (cleanCmd && isValidSmartHomeActionCommand(cleanCmd) && !isWakeQueryText(cleanCmd)) {
          workingText = `${acousticWake.wakeWord}，${cleanCmd}`;
          wakeSpan = findWakeWordSpan(workingText, wakeWords);
        } else if (
          highOwwOk &&
          isShortOrGarbled &&
          !/^(?:你好|您好)/.test(workingText) &&
          !/^(?:没有|嗯|哦)$/.test(cleanPunct(workingText))
        ) {
          workingText = acousticWake.wakeWord;
          wakeSpan = findWakeWordSpan(workingText, wakeWords);
        }
      }
    }

    if (!opts.bypassWakeWord && inConv && !wakeSpan) {
      if (HOUSEHOLD_SIDETALK_RE.test(workingText) && !hasSmartHomeDomainIntent(workingText)) {
        return makeRejected("pragmatic-reject", "连续对话窗口内判定为家人旁白/家务闲聊", acousticWake);
      }
    }

    if (!opts.bypassWakeWord && wakeWordEnabled && !inConv && !wakeSpan) {
      return makeRejected("no-wake", "未检测到有效唤醒词或受控声学唤醒信号", acousticWake);
    }

    const decision = await evaluateVoiceAttention({
      rawText: workingText,
      altText: altText || undefined,
      wakeWordEnabled,
      wakeWords,
      attentionMode: opts.attentionMode ?? "smart",
      bypassWakeWord: opts.bypassWakeWord,
      awakeActive: opts.awakeActive,
      inConversation: inConv,
      dialogState: opts.dialogState,
      recentTurns: opts.recentTurns,
      lastSpokenReply: opts.lastSpokenReply,
      lastSpokenAt: opts.lastSpokenAt,
      now: opts.now,
      acousticEvent: bestEvent,
      acousticWake,
      owwActiveForWord: false,
      voiceprint: opts.voiceprint,
      voiceprintMode: opts.voiceprintMode,
      systemOneClient: opts.systemOneClient,
      llmEvaluator: opts.llmEvaluator,
    });

    let finalDecision = decision;
    if (decision.accept && !decision.wokeOnly && decision.command) {
      let cleanedCmd = trimTrailingMusicLyrics(stripLeadingVocativeOrFragment(decision.command));
      if (cleanedCmd && !hasSmartHomeDomainIntent(cleanedCmd) && !inConv && !opts.bypassWakeWord) {
        if (HOUSEHOLD_SIDETALK_RE.test(cleanedCmd) || DESCRIPTIVE_NON_COMMAND_RE.test(cleanedCmd)) {
          return makeRejected("pragmatic-reject", "提取文本为非设备控制日常对话，已拦截", acousticWake);
        }
      }
      const embCmd = extractEmbeddedSmartHomeCommand(cleanedCmd);
      if (embCmd && embCmd.length < cleanedCmd.length && cleanedCmd.length > 16) {
        cleanedCmd = embCmd;
      }
      if (
        !opts.bypassWakeWord &&
        !inConv &&
        cleanedCmd.length <= 4 &&
        !ACTION_VERB_ANYWHERE_RE.test(cleanedCmd) &&
        !/^(?:静音|开灯|关灯|闭麦|开麦)$/.test(cleanedCmd)
      ) {
        return makeRejected("pragmatic-reject", "残片名词缺少控制动作，拒绝残缺指令", acousticWake);
      }
      finalDecision = { ...decision, command: cleanedCmd };
    }

    const hasVerb = ACTION_VERB_ANYWHERE_RE.test(finalDecision.command);
    let priority = -50;
    if (finalDecision.accept) {
      priority = 100;
      if (!finalDecision.wokeOnly) priority += 55;
      if (hasSmartHomeDomainIntent(finalDecision.command)) priority += 35;
      if (hasVerb) priority += 25;
      if (STRICT_IMPERATIVE_ACTION_RE.test(finalDecision.command)) priority += 20;
      if (enHeadExact || (wakeSpan && !wakeSpan.fuzzy)) priority += 25;
      if (acousticWake?.matched) priority += 15;
      if (branch.startsWith("voxlock") || branch.startsWith("spl_voxlock")) priority += 8;
      if (finalDecision.command.length > 20) {
        priority -= (finalDecision.command.length - 20) * 2;
      }
    }

    return {
      branch,
      startSec,
      endSec,
      rawText: bestText,
      altText: altText || undefined,
      acousticEvent: bestEvent,
      decision: finalDecision,
      acousticWake,
      enHeadMatched,
      enHeadExact,
      hasSmartHome: hasSmartHomeDomainIntent(finalDecision.command || bestText),
      hasActionVerb: hasVerb,
      priority,
      speakerId,
      segPcm,
    };
  }

  private _bridgeAdjacentWakeAndCommand(
    candidates: TurnCandidate[],
    wakeWords: readonly string[],
  ): TurnCandidate | null {
    const ordered = [...candidates].sort((a, b) => a.startSec - b.startSec);
    for (let i = 0; i < ordered.length - 1; i += 1) {
      const cur = ordered[i]!;
      const nxt = ordered[i + 1]!;
      if (!cur.decision.accept || !cur.decision.wokeOnly) continue;
      const gap = nxt.startSec - cur.endSec;
      if (gap < -0.25 || gap > 1.35) continue;
      if (cur.speakerId && nxt.speakerId && cur.speakerId !== nxt.speakerId) continue;
      const nxtClean = cleanPunct(nxt.rawText);
      if (!nxtClean || DESCRIPTIVE_NON_COMMAND_RE.test(nxtClean) || HOUSEHOLD_SIDETALK_RE.test(nxtClean)) {
        continue;
      }
      if (isValidSmartHomeActionCommand(nxtClean) || looksLikeDirectDeviceCommand(nxtClean)) {
        return {
          ...cur,
          branch: `${cur.branch}_bridged`,
          endSec: nxt.endSec,
          rawText: `${cur.rawText} ${nxt.rawText}`.trim(),
          decision: {
            ...cur.decision,
            wokeOnly: false,
            command: trimTrailingMusicLyrics(nxtClean),
            wakeWord: cur.decision.wakeWord ?? wakeWords[0] ?? "Neo",
            reason: "同说话人唤醒词与后续指令自动无缝续接",
          },
          hasSmartHome: true,
          hasActionVerb: true,
          priority: 225,
        };
      }
    }
    return null;
  }

  /**
   * 完整自适应多级声源分离与语音识别主入口（S_Fused 最终方案）。
   */
  async separateAndRecognize(
    input: Float32Array,
    sampleRate = 16000,
    opts: SourceSeparationRunOptions = {},
  ): Promise<SourceSeparationPipelineResult> {
    const t0 = performance.now();
    const pcm16k = sampleRate === SR ? input : resampleLinear(input, sampleRate, SR);
    const mode: SourceSeparationMode = opts.mode ?? "auto";
    const voiceLang = opts.voiceLang || "zh-CN";
    const wakeWords = opts.wakeWords ?? ["Neo"];
    const inConv = opts.dialogState === "conversation" || Boolean(opts.inConversation) || Boolean(opts.awakeActive);
    const stageTimingsMs: Record<string, number> = {};

    const inputSnrDb = estimateSnrDb(pcm16k, SR);
    const scene = this.analyzeAudioScene(pcm16k, 20);
    stageTimingsMs.cedSceneMs = scene.durationMs;
    const spectralFlatness = computeSpectralFlatnessApprox(pcm16k);

    const soundSet = new Set<SoundTypeTag>();
    const hasStrongMusic = scene.musicProb >= 0.18 || scene.singingProb >= 0.05;
    const hasSingingTag = scene.singingProb >= 0.048;
    const hasNoiseHint =
      (scene.noiseProb >= 0.10 && scene.musicProb < 0.25) ||
      (scene.crowdTvProb >= 0.18 && scene.musicProb < 0.20) ||
      (spectralFlatness >= 0.62 && scene.musicProb < 0.20 && inputSnrDb < 14);

    if (hasStrongMusic) soundSet.add("bgm");
    if (hasSingingTag) {
      soundSet.add("song");
      soundSet.add("bgm");
    }
    if (hasNoiseHint) soundSet.add("noise");

    const separatedStreams: SeparatedAudioStreamInfo[] = [];
    if (hasStrongMusic) {
      separatedStreams.push({
        streamId: "scene_bgm",
        kind: "bgm_accompaniment",
        energyRatio: Number(scene.musicProb.toFixed(3)),
      });
    }
    if (hasSingingTag) {
      separatedStreams.push({
        streamId: "scene_song",
        kind: "song_vocals",
        energyRatio: Number(scene.singingProb.toFixed(3)),
      });
    }
    if (hasNoiseHint) {
      separatedStreams.push({
        streamId: "scene_noise",
        kind: "noise",
        energyRatio: Number(Math.max(scene.noiseProb, scene.crowdTvProb).toFixed(3)),
      });
    }

    const buildReturn = (p: {
      speechDetected: boolean;
      text: string;
      altText?: string;
      acousticEvent: string;
      denoiseEngine: string;
      vadEngine: string;
      asrEngine: string;
      outputSnrDb: number;
      detectedSpeakerCount: number;
      acousticWake: WakeWordAcousticHit | null;
      attention: AttentionDecision;
    }): SourceSeparationPipelineResult => ({
      ...p,
      inputSnrDb,
      snrGainDb: Number((p.outputSnrDb - inputSnrDb).toFixed(2)),
      detectedSoundTypes: soundSet.size > 0 ? [...soundSet] : [p.speechDetected ? "speech" : "noise"],
      separatedStreams,
      stageTimingsMs,
      totalMs: Math.round(performance.now() - t0),
    });

    const rejectDecision = (stage: AttentionDecision["stage"], reason: string): AttentionDecision => ({
      accept: false,
      wokeOnly: false,
      addressed: false,
      inConversation: inConv,
      confidence: 0.92,
      stage,
      reason,
      wakeWord: null,
      command: "",
      usedLlm: false,
      latencyMs: 0,
    });

    // Stage 0.5: 极速静音与纯歌曲早退
    if (pcm16k.length < 1600 || computeRms(pcm16k) < 0.004) {
      return buildReturn({
        speechDetected: false,
        text: "",
        acousticEvent: "",
        denoiseEngine: "off",
        vadEngine: "silero",
        asrEngine: "skipped-silence",
        outputSnrDb: inputSnrDb,
        detectedSpeakerCount: 0,
        acousticWake: null,
        attention: rejectDecision("no-wake", "音频能量过低，判定为静音/极低底噪"),
      });
    }

    if (
      !opts.bypassWakeWord &&
      scene.musicProb >= 0.62 &&
      scene.speechProb < 0.12 &&
      scene.singingProb >= 0.06
    ) {
      soundSet.add("song");
      soundSet.add("bgm");
      return buildReturn({
        speechDetected: false,
        text: "",
        acousticEvent: "<|BGM|>",
        denoiseEngine: "ced-gate",
        vadEngine: "ced-gate",
        asrEngine: "skipped-pure-song",
        outputSnrDb: inputSnrDb,
        detectedSpeakerCount: 0,
        acousticWake: null,
        attention: rejectDecision("acoustic", "并行场景分类判定为纯歌曲演唱（无用户语音指令）"),
      });
    }

    const gtcrn = this._engine.denoise(pcm16k, SR, "auto");
    stageTimingsMs.gtcrnMs = gtcrn.durationMs;
    const gtcrnVadSegs = this._extractTimedVadSegments(gtcrn.samples, {
      threshold: 0.38,
      minSilenceDuration: 0.24,
      padSec: 0.12,
      mergeGapSec: 0.14,
    });

    const isClearlyNonSpeech =
      scene.speechProb < 0.12 &&
      (scene.musicProb >= 0.35 || scene.noiseProb >= 0.24 || spectralFlatness >= 0.65);

    if (gtcrnVadSegs.length === 0 && (isClearlyNonSpeech || inputSnrDb < 10)) {
      if (soundSet.size === 0) soundSet.add("noise");
      return buildReturn({
        speechDetected: false,
        text: "",
        acousticEvent: hasStrongMusic ? "<|BGM|>" : "",
        denoiseEngine: gtcrn.engine,
        vadEngine: "silero",
        asrEngine: "skipped-no-speech",
        outputSnrDb: gtcrn.outputSnrDb,
        detectedSpeakerCount: 0,
        acousticWake: null,
        attention: rejectDecision("acoustic", "并行场景分类与神经 VAD 判定为纯非语音背景音/纯音乐"),
      });
    }

    const preRollBg = this._detectBackgroundSongFromPreRoll(
      pcm16k,
      scene,
      gtcrnVadSegs[0]?.startSec ?? 0,
    );
    if (preRollBg.isSong) {
      soundSet.add("song");
      soundSet.add("bgm");
    }
    if (preRollBg.isNoise && !hasStrongMusic) {
      soundSet.add("noise");
    }

    const rawHp = applyHighPassFilter(pcm16k, SR, 85);
    const allCandidates: TurnCandidate[] = [];
    let detectedSpeakerCount = gtcrnVadSegs.length > 0 ? 1 : 0;
    const globalTranscriptParts: string[] = [];

    // Stage 1A: 干净单说话人极速通道
    const isCleanLikelySingle =
      inputSnrDb >= 18 &&
      !hasStrongMusic &&
      !hasNoiseHint &&
      scene.crowdTvProb < 0.12 &&
      gtcrnVadSegs.length === 1 &&
      gtcrnVadSegs[0]!.samples.length < SR * 2.7;

    if (isCleanLikelySingle) {
      const seg = gtcrnVadSegs[0]!;
      soundSet.add("speech");
      const rawSeg = slicePcmBySec(rawHp, seg.startSec, seg.endSec, 0.08);
      const zhGtcrn = await this._engine.transcribeLocal(seg.samples, SR, voiceLang);
      globalTranscriptParts.push(zhGtcrn.text);

      const quickSpan = findWakeWordSpan(zhGtcrn.text, wakeWords);
      let zhRaw: LocalAsrOutput | null = null;
      if (!quickSpan || quickSpan.fuzzy) {
        zhRaw = await this._engine.transcribeLocal(rawSeg, SR, voiceLang);
      }

      const evalRes = await this._evaluateTurnCandidate({
        branch: "clean_fast_gtcrn",
        startSec: seg.startSec,
        endSec: seg.endSec,
        segPcm: seg.samples,
        probePcm: slicePcmBySec(gtcrn.samples, Math.max(0, seg.startSec - 0.18), seg.endSec, 0),
        altSegPcm: rawSeg,
        zhRes: zhGtcrn,
        altZhRes: zhRaw,
        opts,
        scene,
        globalTextContext: zhGtcrn.text,
        isTseOrMusicSeparated: false,
        speakerId: "speaker_0",
      });
      separatedStreams.push({
        streamId: "speaker_0",
        kind: "speaker",
        speakerId: "speaker_0",
        startSec: seg.startSec,
        endSec: seg.endSec,
        transcript: evalRes.rawText,
      });

      return buildReturn({
        speechDetected: true,
        text: evalRes.rawText,
        altText: evalRes.altText,
        acousticEvent: evalRes.acousticEvent,
        denoiseEngine: gtcrn.engine,
        vadEngine: "silero",
        asrEngine: "sensevoice-sep-fast",
        outputSnrDb: gtcrn.outputSnrDb,
        detectedSpeakerCount: 1,
        acousticWake: evalRes.acousticWake,
        attention: evalRes.decision,
      });
    }

    // Stage 1B: 轻量增强 + VAD 边界保护型 Pyannote/CAM++ 说话人隔离与逐轮解码
    let dpdfSamples: Float32Array | null = null;
    let denoiseOutSnr = gtcrn.outputSnrDb;
    let denoiseEngineName: string = gtcrn.engine;
    if (hasNoiseHint || hasStrongMusic || inputSnrDb < 18) {
      const dpdf = this._engine.denoise(pcm16k, SR, "dpdfnet");
      stageTimingsMs.dpdfnetMs = dpdf.durationMs;
      dpdfSamples = dpdf.samples;
      denoiseOutSnr = dpdf.outputSnrDb;
      denoiseEngineName = dpdf.engine;
    }

    const primaryCleanTrack = dpdfSamples ?? gtcrn.samples;
    let vadSegs = this._extractTimedVadSegments(primaryCleanTrack, {
      threshold: 0.36,
      minSilenceDuration: 0.22,
      padSec: 0.12,
      mergeGapSec: 0.10,
    });
    if (vadSegs.length === 0 && gtcrnVadSegs.length > 0) {
      vadSegs = gtcrnVadSegs;
    }

    if (vadSegs.length === 0 && !hasStrongMusic) {
      if (soundSet.size === 0) soundSet.add("noise");
      return buildReturn({
        speechDetected: false,
        text: "",
        acousticEvent: "",
        denoiseEngine: denoiseEngineName,
        vadEngine: "silero",
        asrEngine: "skipped-no-speech",
        outputSnrDb: denoiseOutSnr,
        detectedSpeakerCount: 0,
        acousticWake: null,
        attention: rejectDecision("no-wake", "降噪后未检测到有效人声"),
      });
    }

    let turnSegments: Array<TimedSpeechSegment & { speakerId: string }> = [];
    const totalVadDurSec = vadSegs.reduce((acc, s) => acc + (s.endSec - s.startSec), 0);
    const shouldDiarize =
      vadSegs.length >= 2 || totalVadDurSec >= 2.3 || scene.crowdTvProb >= 0.14;

    if (shouldDiarize && primaryCleanTrack.length >= SR * 1.0) {
      const diar = this.diarizeSpeakers(primaryCleanTrack, 0.52);
      stageTimingsMs.diarizationMs = diar.durationMs;

      if (diar.segments.length >= 1) {
        const mergedDiar: SpeakerDiarizationSpan[] = [];
        for (const seg of diar.segments) {
          const prev = mergedDiar[mergedDiar.length - 1];
          if (prev && prev.speaker === seg.speaker && seg.start - prev.end <= 0.45) {
            prev.end = Math.max(prev.end, seg.end);
          } else {
            mergedDiar.push({ ...seg });
          }
        }
        const filteredDiar = mergedDiar.filter((ds) => ds.end - ds.start >= 0.42);
        if (filteredDiar.length >= 2 && diar.speakerCount >= 2) {
          for (const ds of filteredDiar) {
            const sSample = Math.max(0, Math.floor((ds.start - 0.14) * SR));
            const eSample = Math.min(primaryCleanTrack.length, Math.ceil((ds.end + 0.14) * SR));
            turnSegments.push({
              startSample: sSample,
              endSample: eSample,
              startSec: Number((sSample / SR).toFixed(3)),
              endSec: Number((eSample / SR).toFixed(3)),
              samples: primaryCleanTrack.slice(sSample, eSample),
              speakerId: `speaker_${ds.speaker}`,
            });
          }
        }
      }
    }

    if (turnSegments.length === 0 && vadSegs.length > 0) {
      const expanded: TimedSpeechSegment[] = [];
      for (const vs of vadSegs) {
        expanded.push(...this._splitLongSegmentBySpeakerChange(vs, hasStrongMusic ? 0.36 : 0.42));
      }
      const centroids: number[][] = [];
      const simTh = hasStrongMusic || hasNoiseHint ? 0.44 : 0.50;
      for (const seg of expanded) {
        let spkId = "speaker_0";
        if (seg.samples.length >= 6400 && computeRms(seg.samples) >= 0.015) {
          const emb = l2Normalize(this._engine.extractSpeakerEmbedding(seg.samples, SR).embedding);
          let bestIdx = -1;
          let bestSim = -1;
          for (let c = 0; c < centroids.length; c += 1) {
            const sim = cosineSimilarity(emb, centroids[c]!);
            if (sim > bestSim) {
              bestSim = sim;
              bestIdx = c;
            }
          }
          if (bestIdx >= 0 && bestSim >= simTh) {
            spkId = `speaker_${bestIdx}`;
          } else {
            spkId = `speaker_${centroids.length}`;
            centroids.push(emb);
          }
        }
        turnSegments.push({ ...seg, speakerId: spkId });
      }
    }

    detectedSpeakerCount = this._verifyDistinctSpeakerCount(
      primaryCleanTrack,
      turnSegments,
      hasStrongMusic || hasNoiseHint ? 0.45 : 0.50,
    );
    if (detectedSpeakerCount >= 2 && !(hasStrongMusic && scene.speechProb < 0.25)) {
      soundSet.add("multi_speaker");
    }

    const stage1Candidates: TurnCandidate[] = [];
    for (let idx = 0; idx < Math.min(turnSegments.length, 6); idx += 1) {
      const turn = turnSegments[idx]!;
      const probeStartSec = Math.max(0, turn.startSec - 0.35);
      const probeClean = slicePcmBySec(primaryCleanTrack, probeStartSec, turn.endSec, 0.06);
      const rawTurn = slicePcmBySec(rawHp, probeStartSec, turn.endSec, 0.06);
      const gtcrnTurn = slicePcmBySec(gtcrn.samples, probeStartSec, turn.endSec, 0.06);

      const zhClean = await this._engine.transcribeLocal(turn.samples, SR, voiceLang);
      if (zhClean.text.trim()) {
        if (scene.speechProb >= 0.14 || !hasStrongMusic || zhClean.text.trim().length >= 3) {
          soundSet.add("speech");
        }
        globalTranscriptParts.push(zhClean.text.trim());
      }

      const quickSpan = findWakeWordSpan(zhClean.text, wakeWords);
      let zhAlt: LocalAsrOutput | null = null;
      if (!quickSpan || quickSpan.fuzzy || hasStrongMusic) {
        zhAlt = await this._engine.transcribeLocal(
          hasStrongMusic ? rawTurn : gtcrnTurn,
          SR,
          voiceLang,
        );
        if (zhAlt.text.trim() && (scene.speechProb >= 0.14 || !hasStrongMusic)) {
          soundSet.add("speech");
        }
      }

      const cand = await this._evaluateTurnCandidate({
        branch: "stage1_diarized",
        startSec: turn.startSec,
        endSec: turn.endSec,
        segPcm: turn.samples,
        probePcm: probeClean,
        altSegPcm: hasStrongMusic ? rawTurn : gtcrnTurn,
        zhRes: zhClean,
        altZhRes: zhAlt,
        opts,
        scene,
        globalTextContext: globalTranscriptParts.join(" "),
        isTseOrMusicSeparated: false,
        speakerId: turn.speakerId,
      });
      stage1Candidates.push(cand);
      allCandidates.push(cand);
      separatedStreams.push({
        streamId: `stage1_${turn.speakerId}_${turn.startSec.toFixed(1)}`,
        kind: "speaker",
        speakerId: turn.speakerId,
        startSec: turn.startSec,
        endSec: turn.endSec,
        transcript: cand.rawText,
      });
    }

    const hasOnlyWokeInMulti =
      turnSegments.length >= 2 &&
      stage1Candidates.some((c) => c.decision.accept && c.decision.wokeOnly) &&
      !stage1Candidates.some((c) => c.decision.accept && !c.decision.wokeOnly);

    if (hasOnlyWokeInMulti && vadSegs.length > 0) {
      for (const vs of vadSegs.slice(0, 2)) {
        const zhFull = await this._engine.transcribeLocal(vs.samples, SR, voiceLang);
        const rawFull = slicePcmBySec(rawHp, vs.startSec, vs.endSec, 0.08);
        const zhRawFull = await this._engine.transcribeLocal(rawFull, SR, voiceLang);
        const fullCand = await this._evaluateTurnCandidate({
          branch: "stage1_vad_intact",
          startSec: vs.startSec,
          endSec: vs.endSec,
          segPcm: vs.samples,
          probePcm: vs.samples,
          altSegPcm: rawFull,
          zhRes: zhFull,
          altZhRes: zhRawFull,
          opts,
          scene,
          globalTextContext: globalTranscriptParts.join(" "),
          isTseOrMusicSeparated: false,
          speakerId: "speaker_0",
        });
        stage1Candidates.push(fullCand);
        allCandidates.push(fullCand);
      }
    }

    const bridged1 = this._bridgeAdjacentWakeAndCommand(stage1Candidates, wakeWords);
    if (bridged1) allCandidates.push(bridged1);

    const globalText = globalTranscriptParts.join(" ");
    const stage1Accepted = allCandidates
      .filter((c) => c.decision.accept)
      .sort((a, b) => b.priority - a.priority);

    if (stage1Accepted.length > 0) {
      const best = stage1Accepted[0]!;
      const isHighConfAccept =
        opts.bypassWakeWord ||
        (!best.decision.wokeOnly && best.hasSmartHome && best.hasActionVerb) ||
        (best.decision.wokeOnly && turnSegments.length === 1);
      if (isHighConfAccept || mode === "fast") {
        return buildReturn({
          speechDetected: true,
          text: best.rawText,
          altText: best.altText,
          acousticEvent: best.acousticEvent,
          denoiseEngine: denoiseEngineName,
          vadEngine: "silero-diar",
          asrEngine: "sensevoice-sep-stage1",
          outputSnrDb: denoiseOutSnr,
          detectedSpeakerCount: Math.max(1, detectedSpeakerCount),
          acousticWake: best.acousticWake,
          attention: best.decision,
        });
      }
    }

    // fast 模式不升级重型分离，直接结束
    if (mode === "fast") {
      const bestRej = allCandidates[0];
      return buildReturn({
        speechDetected: globalText.length > 0,
        text: globalText || bestRej?.rawText || "",
        altText: bestRej?.altText,
        acousticEvent: bestRej?.acousticEvent ?? "",
        denoiseEngine: denoiseEngineName,
        vadEngine: "silero-diar",
        asrEngine: "sensevoice-sep-fast",
        outputSnrDb: denoiseOutSnr,
        detectedSpeakerCount: soundSet.has("speech") ? Math.max(1, detectedSpeakerCount) : 0,
        acousticWake: bestRej?.acousticWake ?? null,
        attention: bestRej?.decision ?? rejectDecision("no-wake", "未检测到指向助手的有效指令"),
      });
    }

    // Stage 1.5: 智能早退门控
    const maxStage1Oww = allCandidates.reduce((mx, c) => Math.max(mx, c.acousticWake?.score ?? 0), 0);
    const anyStage1EmbeddedCmd = allCandidates.some(
      (c) =>
        extractEmbeddedSmartHomeCommand(c.rawText).length >= 2 ||
        (c.altText ? extractEmbeddedSmartHomeCommand(c.altText).length >= 2 : false),
    );
    const anyStage1Garbled = allCandidates.some(
      (c) => /[\u3040-\u30ff\uac00-\ud7af]/.test(c.rawText) || c.rawText.length <= 2,
    );

    if (!opts.bypassWakeWord && isThirdPersonNeoMention(globalText)) {
      return buildReturn({
        speechDetected: true,
        text: globalText,
        acousticEvent: allCandidates[0]?.acousticEvent ?? "",
        denoiseEngine: denoiseEngineName,
        vadEngine: "silero-diar",
        asrEngine: "sensevoice-sep-stage1",
        outputSnrDb: denoiseOutSnr,
        detectedSpeakerCount: Math.max(1, detectedSpeakerCount),
        acousticWake: allCandidates[0]?.acousticWake ?? null,
        attention: rejectDecision("pragmatic-reject", "判定为第三人称提及或否定呼唤，跳过重型分离"),
      });
    }

    const isFluentCasualNegative =
      mode !== "full" &&
      !opts.bypassWakeWord &&
      !anyStage1EmbeddedCmd &&
      !anyStage1Garbled &&
      maxStage1Oww < 0.48 &&
      scene.crowdTvProb < 0.18 &&
      globalText.length >= 6 &&
      (HOUSEHOLD_SIDETALK_RE.test(globalText) ||
        DESCRIPTIVE_NON_COMMAND_RE.test(globalText) ||
        isAmbiguousZhQuestion(globalText) ||
        (!hasStrongMusic && !hasNoiseHint && turnSegments.length >= 2 && inputSnrDb >= 14));

    if (isFluentCasualNegative) {
      return buildReturn({
        speechDetected: true,
        text: globalText,
        acousticEvent: allCandidates[0]?.acousticEvent ?? "",
        denoiseEngine: denoiseEngineName,
        vadEngine: "silero-diar",
        asrEngine: "sensevoice-sep-stage1",
        outputSnrDb: denoiseOutSnr,
        detectedSpeakerCount: Math.max(1, detectedSpeakerCount),
        acousticWake: allCandidates[0]?.acousticWake ?? null,
        attention: rejectDecision("no-wake", "清晰非指令日常对话，无唤醒与设备控制意图"),
      });
    }

    // Stage 2A: 按需边沿安全 Spleeter 2-Stem 音乐/歌声分离
    let spleeterRes: MusicStemSeparationOutput | null = null;
    let vocScene: AudioSceneAnalysis | null = null;
    const shouldRunSpleeter =
      hasStrongMusic &&
      (mode === "full" ||
        anyStage1EmbeddedCmd ||
        anyStage1Garbled ||
        maxStage1Oww >= 0.44 ||
        globalText.length <= 5);

    if (shouldRunSpleeter) {
      spleeterRes = this.separateMusicStems(pcm16k);
      if (spleeterRes) {
        stageTimingsMs.spleeterMs = spleeterRes.durationMs;
        vocScene = this.analyzeAudioScene(spleeterRes.vocals16k, 15);
        if (spleeterRes.vocalToAccompDb < 14) soundSet.add("bgm");
        if (vocScene.singingProb >= 0.045 || scene.singingProb >= 0.045) {
          soundSet.add("song");
          soundSet.add("bgm");
        }
        if (vocScene.speechProb >= 0.16) soundSet.add("speech");

        separatedStreams.push({
          streamId: "spleeter_accompaniment",
          kind: "bgm_accompaniment",
          energyRatio: Number(computeRms(spleeterRes.accompaniment16k).toFixed(4)),
        });

        const vocRms = computeRms(spleeterRes.vocals16k);
        if (vocRms < 0.008 && spleeterRes.vocalToAccompDb < -12) {
          return buildReturn({
            speechDetected: false,
            text: "",
            acousticEvent: "<|BGM|>",
            denoiseEngine: "spleeter",
            vadEngine: "silero",
            asrEngine: "skipped-pure-bgm",
            outputSnrDb: denoiseOutSnr,
            detectedSpeakerCount: 0,
            acousticWake: null,
            attention: rejectDecision("acoustic", "Spleeter 分离确认仅含纯器乐伴奏无有效人声"),
          });
        }

        if (
          !opts.bypassWakeWord &&
          vocScene.singingProb >= 0.14 &&
          vocScene.speechProb < 0.22 &&
          !anyStage1EmbeddedCmd &&
          maxStage1Oww < 0.45
        ) {
          soundSet.add("song");
          return buildReturn({
            speechDetected: false,
            text: globalText,
            acousticEvent: "<|BGM|>",
            denoiseEngine: "spleeter",
            vadEngine: "silero",
            asrEngine: "skipped-pure-singing",
            outputSnrDb: denoiseOutSnr,
            detectedSpeakerCount: 0,
            acousticWake: null,
            attention: rejectDecision("acoustic", "Spleeter 人声轨判定为纯歌声演唱（无用户语音指令）"),
          });
        }

        const splDpdf = this._engine.denoise(spleeterRes.vocals16k, SR, "dpdfnet");
        const splSegs = this._extractTimedVadSegments(splDpdf.samples, {
          threshold: 0.34,
          minSilenceDuration: 0.22,
          padSec: 0.12,
          mergeGapSec: 0.12,
        });
        const rawVocHp = applyHighPassFilter(spleeterRes.vocals16k, SR, 85);

        for (const seg of splSegs.slice(0, 3)) {
          const rawVocSlice = slicePcmBySec(rawVocHp, seg.startSec, seg.endSec, 0.08);
          const zhSpl = await this._engine.transcribeLocal(seg.samples, SR, voiceLang);
          const zhVocRaw = await this._engine.transcribeLocal(rawVocSlice, SR, voiceLang);
          const cand = await this._evaluateTurnCandidate({
            branch: "stage2_spleeter_dpdf",
            startSec: seg.startSec,
            endSec: seg.endSec,
            segPcm: seg.samples,
            probePcm: slicePcmBySec(splDpdf.samples, Math.max(0, seg.startSec - 0.22), seg.endSec, 0.06),
            altSegPcm: rawVocSlice,
            zhRes: zhSpl,
            altZhRes: zhVocRaw,
            opts,
            scene: {
              ...scene,
              singingProb: Math.max(scene.singingProb, vocScene.singingProb),
              speechProb: Math.max(scene.speechProb, vocScene.speechProb),
            },
            globalTextContext: globalText,
            isTseOrMusicSeparated: true,
            speakerId: "vocal_sep",
          });
          allCandidates.push(cand);
        }
      }
    }

    const postSplAccepted = allCandidates
      .filter((c) => c.decision.accept)
      .sort((a, b) => b.priority - a.priority);
    if (postSplAccepted.length > 0 && postSplAccepted[0]!.priority >= 170) {
      const best = postSplAccepted[0]!;
      return buildReturn({
        speechDetected: true,
        text: best.rawText,
        altText: best.altText,
        acousticEvent: best.acousticEvent,
        denoiseEngine: "spleeter+dpdfnet4",
        vadEngine: "silero",
        asrEngine: "sensevoice-sep-spleeter",
        outputSnrDb: denoiseOutSnr,
        detectedSpeakerCount: Math.max(1, detectedSpeakerCount),
        acousticWake: best.acousticWake,
        attention: best.decision,
      });
    }

    // Stage 2B: 按需 VoxLock TSE 与「Spleeter -> VoxLock」歌声级联分离
    const speakerRefs =
      opts.speakerRefWavPaths && opts.speakerRefWavPaths.length > 0
        ? opts.speakerRefWavPaths
        : listVoiceprintRefWavPaths().map((r) => ({ id: r.role === "owner" ? "owner" : r.id, wavPath: r.wavPath }));

    const maxOwwSoFar = allCandidates.reduce((mx, c) => Math.max(mx, c.acousticWake?.score ?? 0), 0);
    const anyEmbeddedCmdNow = allCandidates.some(
      (c) =>
        extractEmbeddedSmartHomeCommand(c.rawText).length >= 2 ||
        (c.altText ? extractEmbeddedSmartHomeCommand(c.altText).length >= 2 : false),
    );
    const suspectedHiddenOverlap =
      scene.crowdTvProb >= 0.18 ||
      anyStage1Garbled ||
      maxOwwSoFar >= 0.49 ||
      (turnSegments.length === 1 && totalVadDurSec >= 2.3 && maxOwwSoFar >= 0.42 && !hasStrongMusic);

    const shouldRunVoxLock =
      speakerRefs.length > 0 &&
      !isThirdPersonNeoMention(globalText) &&
      (mode === "full" || anyEmbeddedCmdNow || suspectedHiddenOverlap);

    if (shouldRunVoxLock) {
      const voxSource =
        spleeterRes && (scene.musicProb >= 0.28 || scene.singingProb >= 0.05)
          ? spleeterRes.vocals16k
          : pcm16k;
      const branchPrefix = voxSource === pcm16k ? "voxlock" : "spl_voxlock";
      const voxCache = new Map<string, Float32Array>();

      let anyVoxHit = false;
      for (let rIdx = 0; rIdx < Math.min(speakerRefs.length, 2); rIdx += 1) {
        const ref = speakerRefs[rIdx]!;
        if (rIdx > 0 && anyVoxHit) break;
        if (rIdx > 0) {
          const firstRefSamples = voxCache.get(speakerRefs[0]!.id);
          const firstRms = firstRefSamples ? computeRms(firstRefSamples) : 0;
          if (!(scene.crowdTvProb >= 0.18 || anyEmbeddedCmdNow || firstRms < 0.035 || mode === "full")) {
            break;
          }
        }
        const vox = this.extractTargetSpeakerVoxLock(voxSource, ref.wavPath);
        if (!vox) continue;
        voxCache.set(ref.id, vox.samples);
        stageTimingsMs[`${branchPrefix}_${ref.id}Ms`] = vox.durationMs;

        const voxSegs = this._extractTimedVadSegments(vox.samples, {
          threshold: 0.32,
          minSilenceDuration: 0.20,
          padSec: 0.14,
          mergeGapSec: 0.14,
        });
        for (const seg of voxSegs.slice(0, 3)) {
          if (computeRms(seg.samples) < 0.010) continue;
          const zhVox = await this._engine.transcribeLocal(seg.samples, SR, voiceLang);
          const cand = await this._evaluateTurnCandidate({
            branch: `${branchPrefix}_${ref.id}`,
            startSec: seg.startSec,
            endSec: seg.endSec,
            segPcm: seg.samples,
            probePcm: slicePcmBySec(vox.samples, Math.max(0, seg.startSec - 0.20), seg.endSec, 0.06),
            altSegPcm: slicePcmBySec(rawHp, seg.startSec, seg.endSec, 0.08),
            zhRes: zhVox,
            altZhRes: null,
            opts,
            scene,
            globalTextContext: globalText,
            isTseOrMusicSeparated: true,
            speakerId: ref.id,
          });
          allCandidates.push(cand);
          separatedStreams.push({
            streamId: `${branchPrefix}_${ref.id}_${seg.startSec.toFixed(1)}`,
            kind: "speaker",
            speakerId: ref.id,
            startSec: seg.startSec,
            endSec: seg.endSec,
            transcript: cand.rawText,
          });
          if (cand.decision.accept && !cand.decision.wokeOnly) {
            anyVoxHit = true;
          }
        }
      }

      // 双 VoxLock 分支确认独立重叠双说话人
      if (speakerRefs.length >= 2) {
        const s0 = speakerRefs[0]!.id;
        const s1 = speakerRefs[1]!.id;
        const tx0 = separatedStreams.find((s) => s.speakerId === s0)?.transcript ?? "";
        const tx1 = separatedStreams.find((s) => s.speakerId === s1)?.transcript ?? "";
        const rms0 = voxCache.get(s0) ? computeRms(voxCache.get(s0)!) : 0;
        const rms1 = voxCache.get(s1) ? computeRms(voxCache.get(s1)!) : 0;
        if (tx0.length >= 4 && tx1.length >= 4 && rms0 >= 0.024 && rms1 >= 0.024 && tx0 !== tx1 && !hasStrongMusic) {
          detectedSpeakerCount = Math.max(detectedSpeakerCount, 2);
          soundSet.add("multi_speaker");
        }
      }

      // 局部滑动窗口 en-US 唤醒探针（复用 voxCache 零重复 VoxLock 推理）
      if (!anyVoxHit && !opts.bypassWakeWord && opts.wakeWordEnabled !== false) {
        const tseCmdCands = allCandidates.filter(
          (c) =>
            (c.branch.startsWith("voxlock") ||
              c.branch.startsWith("spl_voxlock") ||
              c.branch.startsWith("stage2_spleeter")) &&
            extractEmbeddedSmartHomeCommand(c.rawText).length >= 2,
        );
        for (const tc of tseCmdCands.slice(0, 2)) {
          const cleanCmd = extractEmbeddedSmartHomeCommand(tc.rawText);
          const cachedVox = tc.speakerId ? voxCache.get(tc.speakerId) : undefined;
          const scanAudio = cachedVox
            ? slicePcmBySec(cachedVox, tc.startSec, tc.endSec, 0.05)
            : tc.segPcm;
          const rawSlice = slicePcmBySec(rawHp, tc.startSec, tc.endSec, 0.05);

          let recoveredWake: string | null = null;
          for (const srcAudio of [scanAudio, rawSlice]) {
            const maxScanEnd = Math.min(srcAudio.length, Math.round(SR * 2.1));
            for (let off = 0; off + Math.round(SR * 0.65) <= maxScanEnd; off += Math.round(SR * 0.35)) {
              const win = srcAudio.subarray(off, Math.min(srcAudio.length, off + Math.round(SR * 0.85)));
              const enRes = await this._engine.transcribeLocal(win, SR, "en-US");
              const hit = matchSafeEnWake(enRes.text, wakeWords, true);
              if (hit) {
                recoveredWake = hit.wakeWord;
                break;
              }
            }
            if (recoveredWake) break;
          }

          if (recoveredWake) {
            const recoveredDecision = await evaluateVoiceAttention({
              rawText: `${recoveredWake}，${cleanCmd}`,
              wakeWordEnabled: true,
              wakeWords,
              attentionMode: opts.attentionMode ?? "smart",
              dialogState: opts.dialogState,
              inConversation: inConv,
              recentTurns: opts.recentTurns,
              lastSpokenReply: opts.lastSpokenReply,
              lastSpokenAt: opts.lastSpokenAt,
              now: opts.now,
              acousticEvent: "<|Speech|>",
              owwActiveForWord: false,
              voiceprint: opts.voiceprint,
              voiceprintMode: opts.voiceprintMode,
              systemOneClient: opts.systemOneClient,
              llmEvaluator: opts.llmEvaluator,
            });
            if (recoveredDecision.accept) {
              allCandidates.push({
                ...tc,
                branch: `${tc.branch}_slide_probe`,
                decision: recoveredDecision,
                enHeadMatched: true,
                hasSmartHome: true,
                hasActionVerb: true,
                priority: 195,
              });
              break;
            }
          }
        }
      }
    }

    // Stage 3: 最终择优输出
    const accepted = allCandidates
      .filter((c) => c.decision.accept)
      .sort((a, b) => b.priority - a.priority);

    if (accepted.length > 0) {
      const winner = accepted[0]!;
      return buildReturn({
        speechDetected: true,
        text: winner.rawText,
        altText: winner.altText,
        acousticEvent: winner.acousticEvent,
        denoiseEngine: winner.branch.startsWith("spl_voxlock")
          ? "spleeter+voxlock"
          : winner.branch.startsWith("voxlock")
            ? "voxlock"
            : denoiseEngineName,
        vadEngine: "silero-sep",
        asrEngine: `sensevoice-sep-${winner.branch}`,
        outputSnrDb: denoiseOutSnr,
        detectedSpeakerCount: Math.max(1, detectedSpeakerCount),
        acousticWake: winner.acousticWake,
        attention: winner.decision,
      });
    }

    const bestRejected = allCandidates[0];
    return buildReturn({
      speechDetected: globalText.length > 0,
      text: globalText || bestRejected?.rawText || "",
      altText: bestRejected?.altText,
      acousticEvent: bestRejected?.acousticEvent ?? "",
      denoiseEngine: denoiseEngineName,
      vadEngine: "silero-sep",
      asrEngine: "sensevoice-sep",
      outputSnrDb: denoiseOutSnr,
      detectedSpeakerCount: soundSet.has("speech") ? Math.max(1, detectedSpeakerCount) : 0,
      acousticWake: bestRejected?.acousticWake ?? null,
      attention: bestRejected?.decision ?? rejectDecision("no-wake", "所有分离轨均未检测到指向助手的有效指令"),
    });
  }

  dispose(): void {
    this._cedTagger = null;
    this._diarizer = null;
    this._spleeter = null;
    this._voxlockCache.clear();
  }
}
