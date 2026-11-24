// SPDX-License-Identifier: GPL-3.0-or-later
// Solution S1: Parallel CED Audio Scene Classifier + Adaptive Separation Router
//
// 严格遵循零作弊原则：仅使用 input.pcm16k、input.sampleRate、input.wakeWords、
// 以及 buildRuntimeDialogContext(input.clip, input.wakeWords) 提供的运行时对话状态。

import { cosineSimilarity, l2Normalize } from "../../../src/agent/audioPcm.ts";
import type { DenoiseOutput, LocalAsrOutput } from "../../../src/agent/localVoiceEngine.ts";
import type { WakeWordAcousticHit } from "../../../src/agent/openWakeWordEngine.ts";
import {
  computeEchoOverlap,
  evaluateVoiceAttention,
  extractCommandAfterAcousticWake,
  findWakeWordSpan,
  isWakeQueryText,
  looksLikeDirectDeviceCommand,
  matchEnglishHeadWakeWord,
  trimTrailingMusicLyrics,
  type AttentionDecision,
  type WakeSpanMatch,
} from "../../../src/agent/voiceAttentionGate.ts";
import type {
  SeparatedStreamSummary,
  SolutionRunInput,
  SolutionRunOutput,
  VoiceSolution,
} from "../evaluator.ts";
import type { SoundTypeLabel } from "../generate_dataset.ts";
import {
  computeAcousticDiagnostics,
  type MusicSeparationResult,
  type SceneAnalysis,
  type SharedVoiceModelPool,
} from "../shared_models.ts";
import {
  applyHighPassFilter,
  buildRuntimeDialogContext,
  computeRms,
  estimateSnrDb,
  extractTimedVadSegments,
  hasAudibleEnergy,
  hasSmartHomeDomainIntent,
  isThirdPersonNeoMention,
  type TimedVadSegment,
} from "./common_utils.ts";

const SAMPLE_RATE = 16000;
const MAX_SEGMENTS_TO_EVALUATE = 6;

const PUNCT_STRIP_RE = /[\s,，。．.、!！?？:：;；\-—~～"'“”‘’()（）[\]【】]+/g;
const WEIRD_SCRIPT_RE = /[\u3040-\u30ff\uac00-\ud7af]/g;

const RISKY_FUZZY_ZH_ALIASES = new Set<string>([
  "你好",
  "您好",
  "你有",
  "你又",
  "你给",
  "你欧",
  "你哦",
  "妞",
  "牛",
  "纽",
  "钮",
]);

const STRONG_WAKE_HOMOPHONES = new Set<string>([
  "neil",
  "neal",
  "nio",
  "niyo",
  "neio",
  "neow",
  "newo",
  "niel",
  "尼奥",
  "尼欧",
  "妮奥",
  "妮欧",
  "尼哦",
  "妮哦",
  "呢哦",
  "你o",
  "你0",
  "2お",
  "ニオ",
  "ネオ",
  "にお",
  "ニ요",
  "니오",
  "네오",
]);

const AMBIGUOUS_ZH_PREFIX_RE = /^(?:你好|您好|你有|你又|你给)/;
const INTERROGATIVE_END_RE = /[吗嘛么呢][。？！!?\s]*$/;

const EXTRA_REF_BEFORE_RE =
  /(?:提到|聊到|说到|说起|讲到|谈到|关于|听说|觉得|认为|喜欢|讨厌|记得|忘了|叫做|名叫|名字叫|取名叫|别理|别管|不用管|不要管|不是叫|没叫|没喊|谁叫|谁在叫|什么叫|演示|测试一下|介绍|对比|比一比|不如|就像|好像|刚才那个|今天那个|昨天那个)/i;
const EXTRA_REF_AFTER_RE =
  /^(?:是(?:个|一个|什么|谁|哪个|怎么|不是|真的|挺|很)|挺|真(?:的)?(?:好用|不错|聪明|笨|差|慢|快)|好不好用|好用吗|怎么样|这个(?:软件|助手|东西|项目|名字|功能|模型)|那个(?:软件|助手|东西|项目)|它|他|她|刚才|刚刚|昨天|今天(?:好像|居然|又)|的(?:名字|功能|原理|声音|模型|效果|界面|性能|芯片|反应|设计)|会不会|能不能被|怎么老是|别理|算了|没叫你)/i;

const HOUSEHOLD_SIDETALK_RE =
  /(?:递过来|拿一下|端过来|吃什么|吃饭|晚饭|午饭|早饭|杯水|喝水|快递|外卖|洗碗|筷子|手机在哪|钥匙|拖地|收衣服|作业|上班|下班|菜市场|买菜)/i;

const DEVICE_FOLLOWUP_ACTION_RE =
  /(?:开灯|关灯|打开|关闭|关掉|关上|关了|开一下|关一下|调[高低大小亮暗暖冷到成]|设[置定为]|度|%|暂停|继续|停止|静音|下一首|上一首|切歌|换歌|换一首|再来一份|出粮|全开|全关|也关|也开|别关|别开|再[高低大小亮暗暖冷]|稍微[高低大小亮暗暖冷])/i;

interface SegmentBundle {
  startSample: number;
  endSample: number;
  startSec: number;
  endSec: number;
  primaryAudio: Float32Array;
  secondaryAudio: Float32Array;
  hpRawAudio: Float32Array;
  energyRatio: number;
}

interface SegmentEvalResult {
  segIndex: number;
  speakerId: string;
  startSec: number;
  endSec: number;
  energyRatio: number;
  rawAsrText: string;
  altAsrText: string;
  candidateText: string;
  enHeadText?: string;
  acousticWake: WakeWordAcousticHit | null;
  decision: AttentionDecision;
  exactWake: boolean;
  isThirdPerson: boolean;
  asrMs: number;
  probeMs: number;
  owwMs: number;
}

function countMeaningfulChars(text: string): number {
  return text.replace(PUNCT_STRIP_RE, "").trim().length;
}

function isReferentialWakeContext(text: string, wakeWords: readonly string[]): boolean {
  const cleaned = text.trim();
  if (!cleaned) return false;
  if (isThirdPersonNeoMention(cleaned)) return true;
  const span = findWakeWordSpan(cleaned, wakeWords);
  if (!span) return false;
  if (span.beforeText && EXTRA_REF_BEFORE_RE.test(span.beforeText)) return true;
  if (span.afterText && EXTRA_REF_AFTER_RE.test(span.afterText)) return true;
  return false;
}

function isRiskyChineseFuzzyAlias(span: WakeSpanMatch): boolean {
  return span.fuzzy && RISKY_FUZZY_ZH_ALIASES.has(span.matchedSurface);
}

function isAmbiguousChineseInterrogative(text: string, extractedCmd: string): boolean {
  const trimmed = text.trim();
  return (
    AMBIGUOUS_ZH_PREFIX_RE.test(trimmed) &&
    INTERROGATIVE_END_RE.test(trimmed) &&
    !isWakeQueryText(extractedCmd)
  );
}

function hasOppositeControlVerb(heard: string, lastSpoken: string): boolean {
  const pairs: Array<[RegExp, RegExp]> = [
    [/(?:打开|开启|开灯|开机|开空调|开风扇|开窗|开电视|开音|全开)/, /(?:关闭|关掉|关上|关灯|关机|关空调|关风扇|关窗|关电视|关音|全关|已关)/],
    [/(?:调大|大一点|调高|高一点|调亮|亮一点|升温)/, /(?:调小|小一点|调低|低一点|调暗|暗一点|降温)/],
    [/(?:播放|继续|取消静音|开麦)/, /(?:暂停|停止|静音|闭麦)/],
  ];
  for (const [a, b] of pairs) {
    if ((a.test(heard) && b.test(lastSpoken)) || (b.test(heard) && a.test(lastSpoken))) {
      return true;
    }
  }
  return false;
}

function isStrongEchoConfirmation(heard: string, lastSpoken: string | undefined): boolean {
  if (!lastSpoken) return false;
  const overlap = computeEchoOverlap(heard, lastSpoken);
  if (overlap < 0.65) return false;
  if (hasOppositeControlVerb(heard, lastSpoken)) return false;
  // Confirmation phrasing or very high overlap without wake word
  if (overlap >= 0.76) return true;
  return /(?:好的|已为您|已经|已打开|已关闭|已设为|已调|已暂停|已停止|已静音|在呢|待机)/.test(
    heard,
  );
}

function hasValidFollowupIntent(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (HOUSEHOLD_SIDETALK_RE.test(trimmed) && !hasSmartHomeDomainIntent(trimmed)) {
    return false;
  }
  return hasSmartHomeDomainIntent(trimmed) || DEVICE_FOLLOWUP_ACTION_RE.test(trimmed);
}

const EMBEDDED_CMD_BOUNDARY_RE =
  /(?:把|帮我|给我|请|麻烦|打开|开启|关闭|关掉|关上|开灯|关灯|调|设置|设定|播放|暂停|继续|停止|静音|下一首|上一首|换一首|切歌)/;

function findEmbeddedCommandStartIndex(text: string): number {
  const trimmed = text.trim();
  if (!trimmed || looksLikeDirectDeviceCommand(trimmed)) return 0;
  const m = EMBEDDED_CMD_BOUNDARY_RE.exec(trimmed);
  if (m && m.index > 0) {
    const suffix = trimmed.slice(m.index).trim();
    if (suffix.length >= 2 && hasSmartHomeDomainIntent(suffix)) {
      return m.index;
    }
  }
  return 0;
}

function extractCleanCommandClause(text: string, aggressiveTrim: boolean): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  if (!aggressiveTrim) return trimmed;

  const parts = trimmed
    .split(/[，,。！？!?;；]/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return trimmed;

  // In music/multi-speaker scenes, drop leading non-command lyric/bystander clauses
  let startIdx = 0;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i]!;
    if (looksLikeDirectDeviceCommand(part) || hasSmartHomeDomainIntent(part)) {
      startIdx = i;
      break;
    }
  }
  const kept = parts.slice(startIdx);
  if (kept.length > 0) {
    const first = kept[0]!;
    const embIdx = findEmbeddedCommandStartIndex(first);
    if (embIdx > 0) {
      kept[0] = first.slice(embIdx).trim();
    }
  }
  if (kept.length <= 1) return kept[0] ?? trimmed;
  return trimTrailingMusicLyrics(kept.join("，"));
}

function scoreAsrCandidate(
  cand: LocalAsrOutput,
  wakeWords: readonly string[],
  options: {
    isPrimary: boolean;
    preferPrimaryBonus: number;
    preferSecondaryBonus: number;
  },
): number {
  const text = cand.text.trim();
  if (!text) return -100;

  let s = Math.min(20, countMeaningfulChars(text) * 1.0);
  const span = findWakeWordSpan(text, wakeWords);
  if (span) {
    if (!span.fuzzy) {
      s += 110;
    } else if (isRiskyChineseFuzzyAlias(span)) {
      s += hasSmartHomeDomainIntent(span.afterText) ? 55 : 5;
    } else {
      s += 78;
    }
    if (span.afterText && hasSmartHomeDomainIntent(span.afterText)) {
      s += 45;
    } else if (span.afterText && looksLikeDirectDeviceCommand(span.afterText)) {
      s += 24;
    }
    if (span.beforeText.length <= 2) {
      s += 10;
    }
  } else {
    if (hasSmartHomeDomainIntent(text)) {
      s += 34;
    } else if (looksLikeDirectDeviceCommand(text)) {
      s += 18;
    }
  }

  if (cand.event.toUpperCase().includes("SPEECH")) {
    s += 8;
  }

  s += options.isPrimary ? options.preferPrimaryBonus : options.preferSecondaryBonus;

  const weirdMatches = text.match(WEIRD_SCRIPT_RE);
  if (weirdMatches && weirdMatches.length > 0) {
    s -= weirdMatches.length * 14;
  }
  return s;
}

function selectMusicSegments(
  denVocalsSegs: TimedVadSegment[],
  rawVocalsSegs: TimedVadSegment[],
): TimedVadSegment[] {
  const filterAudible = (segs: TimedVadSegment[], minRms: number): TimedVadSegment[] =>
    segs.filter((seg) => seg.samples.length >= Math.round(SAMPLE_RATE * 0.2) && computeRms(seg.samples) >= minRms);

  const cleanDen = filterAudible(denVocalsSegs, 0.006);
  const cleanRaw = filterAudible(rawVocalsSegs, 0.01);

  if (cleanDen.length === 0) return cleanRaw;
  if (cleanRaw.length === 0) return cleanDen;

  // Prefer GTCRN-cleaned vocal boundaries, and append any substantial non-overlapping raw vocal segment
  const chosen: TimedVadSegment[] = [...cleanDen];
  for (const r of cleanRaw) {
    const dur = r.endSec - r.startSec;
    if (dur < 0.35 || computeRms(r.samples) < 0.014) continue;
    const overlaps = chosen.some(
      (d) => Math.min(d.endSample, r.endSample) - Math.max(d.startSample, r.startSample) > SAMPLE_RATE * 0.12,
    );
    if (!overlaps) {
      chosen.push(r);
    }
  }
  chosen.sort((a, b) => a.startSample - b.startSample);
  return chosen;
}

function selectNoiseBranchTrackAndSegments(
  dpdf: DenoiseOutput,
  gtcrn: DenoiseOutput,
  dpdfSegs: TimedVadSegment[],
  gtcrnSegs: TimedVadSegment[],
  clipLenSamples: number,
): {
  primaryFull: Float32Array;
  secondaryFull: Float32Array;
  segments: TimedVadSegment[];
  primarySnrOut: number;
  primaryEngine: "dpdfnet4" | "gtcrn";
} {
  const usable = (segs: TimedVadSegment[]): TimedVadSegment[] =>
    segs.filter((s) => s.samples.length >= Math.round(SAMPLE_RATE * 0.2) && computeRms(s.samples) >= 0.006);

  const dSegs = usable(dpdfSegs);
  const gSegs = usable(gtcrnSegs);

  if (dSegs.length === 0 && gSegs.length === 0) {
    return {
      primaryFull: dpdf.samples,
      secondaryFull: gtcrn.samples,
      segments: [],
      primarySnrOut: dpdf.outputSnrDb,
      primaryEngine: "dpdfnet4",
    };
  }
  if (dSegs.length > 0 && gSegs.length === 0) {
    return {
      primaryFull: dpdf.samples,
      secondaryFull: gtcrn.samples,
      segments: dSegs,
      primarySnrOut: dpdf.outputSnrDb,
      primaryEngine: "dpdfnet4",
    };
  }
  if (gSegs.length > 0 && dSegs.length === 0) {
    return {
      primaryFull: gtcrn.samples,
      secondaryFull: dpdf.samples,
      segments: gSegs,
      primarySnrOut: gtcrn.outputSnrDb,
      primaryEngine: "gtcrn",
    };
  }

  // Both found segments: check if one leaked continuous noise floor (>92% speech ratio) while the other isolated cleanly
  const dCoverage = dSegs.reduce((acc, s) => acc + (s.endSample - s.startSample), 0) / Math.max(1, clipLenSamples);
  const gCoverage = gSegs.reduce((acc, s) => acc + (s.endSample - s.startSample), 0) / Math.max(1, clipLenSamples);

  let preferDpdf = dpdf.outputSnrDb >= gtcrn.outputSnrDb - 1.5;
  if (gCoverage > 0.92 && dCoverage < 0.84) {
    preferDpdf = true;
  } else if (dCoverage > 0.92 && gCoverage < 0.84) {
    preferDpdf = false;
  }

  return preferDpdf
    ? {
        primaryFull: dpdf.samples,
        secondaryFull: gtcrn.samples,
        segments: dSegs,
        primarySnrOut: dpdf.outputSnrDb,
        primaryEngine: "dpdfnet4",
      }
    : {
        primaryFull: gtcrn.samples,
        secondaryFull: dpdf.samples,
        segments: gSegs,
        primarySnrOut: gtcrn.outputSnrDb,
        primaryEngine: "gtcrn",
      };
}

function capSegmentsChronologically(segs: TimedVadSegment[], maxCount: number): TimedVadSegment[] {
  if (segs.length <= maxCount) return segs;
  const scored = segs.map((seg, idx) => ({
    seg,
    idx,
    weight: computeRms(seg.samples) * Math.sqrt(Math.max(0.2, seg.endSec - seg.startSec)),
  }));
  scored.sort((a, b) => b.weight - a.weight);
  return scored
    .slice(0, maxCount)
    .sort((a, b) => a.idx - b.idx)
    .map((item) => item.seg);
}

function clusterSegmentSpeakers(
  pool: SharedVoiceModelPool,
  segments: readonly SegmentBundle[],
  allowSingleSegSplit: boolean,
): {
  speakerIds: string[];
  speakerCount: number;
  isMultiSpeaker: boolean;
  durationMs: number;
} {
  const t0 = performance.now();
  if (segments.length === 0) {
    return { speakerIds: [], speakerCount: 0, isMultiSpeaker: false, durationMs: 0 };
  }

  const engine = pool.localEngine;
  const clusters: Array<{ id: string; centroid: number[]; count: number }> = [];
  const speakerIds: string[] = new Array(segments.length).fill("spk_0");

  let embeddedCount = 0;
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i]!;
    if (seg.primaryAudio.length < 6400) {
      // Segment too short (<0.40s) for reliable CAM++ embedding; inherit nearest cluster later
      speakerIds[i] = clusters[clusters.length - 1]?.id ?? "spk_0";
      continue;
    }
    const embOut = engine.extractSpeakerEmbedding(seg.primaryAudio, SAMPLE_RATE);
    const vec = l2Normalize(embOut.embedding);
    embeddedCount += 1;

    let bestClusterIdx = -1;
    let bestSim = -1;
    for (let c = 0; c < clusters.length; c += 1) {
      const sim = cosineSimilarity(vec, clusters[c]!.centroid);
      if (sim > bestSim) {
        bestSim = sim;
        bestClusterIdx = c;
      }
    }

    if (bestClusterIdx >= 0 && bestSim >= 0.45) {
      const target = clusters[bestClusterIdx]!;
      speakerIds[i] = target.id;
      const n = target.count;
      const merged = target.centroid.map((v, k) => (v * n + (vec[k] ?? 0)) / (n + 1));
      target.centroid = l2Normalize(merged);
      target.count = n + 1;
    } else {
      const id = `spk_${clusters.length}`;
      clusters.push({ id, centroid: vec, count: 1 });
      speakerIds[i] = id;
    }
  }

  // Fallback for seamless multi-speaker turn-taking merged into 1 long VAD segment (>= 3.0s)
  if (clusters.length <= 1 && segments.length === 1 && allowSingleSegSplit) {
    const onlySeg = segments[0]!;
    const durSec = onlySeg.endSec - onlySeg.startSec;
    if (durSec >= 3.0 && onlySeg.primaryAudio.length >= Math.round(SAMPLE_RATE * 3.0)) {
      const splitEndA = Math.floor(onlySeg.primaryAudio.length * 0.44);
      const splitStartB = Math.floor(onlySeg.primaryAudio.length * 0.56);
      const partA = onlySeg.primaryAudio.subarray(0, splitEndA);
      const partB = onlySeg.primaryAudio.subarray(splitStartB);
      if (partA.length >= 16000 && partB.length >= 16000) {
        const sim = pool.speakerSimilarity(partA, partB);
        if (sim > 0 && sim < 0.3) {
          return {
            speakerIds: ["spk_0"],
            speakerCount: 2,
            isMultiSpeaker: true,
            durationMs: Math.round(performance.now() - t0),
          };
        }
      }
    }
  }

  const speakerCount = embeddedCount > 0 ? Math.max(1, clusters.length) : 1;
  return {
    speakerIds,
    speakerCount,
    isMultiSpeaker: clusters.length >= 2,
    durationMs: Math.round(performance.now() - t0),
  };
}

function buildFinalSoundTypes(params: {
  scene: SceneAnalysis;
  vocalsScene: SceneAnalysis | null;
  stems: MusicSeparationResult | null;
  diag: ReturnType<typeof computeAcousticDiagnostics>;
  inputSnrDb: number;
  bestSnrOutDb: number;
  isMusicScene: boolean;
  isMultiSpeaker: boolean;
  hasConfirmedSpeech: boolean;
  hasBgmAsrTag: boolean;
}): SoundTypeLabel[] {
  const {
    scene,
    vocalsScene,
    stems,
    diag,
    inputSnrDb,
    bestSnrOutDb,
    isMusicScene,
    isMultiSpeaker,
    hasConfirmedSpeech,
    hasBgmAsrTag,
  } = params;

  const types = new Set<SoundTypeLabel>();

  // 1. Song (singing) refined via Spleeter vocalToAccompDb + vocalsScene
  let hasSong = scene.singingProb >= 0.055;
  if (stems) {
    const vocSing = vocalsScene?.singingProb ?? 0;
    if (stems.vocalToAccompDb < -11 && vocSing < 0.06 && scene.singingProb < 0.12) {
      hasSong = false;
    } else if (stems.vocalToAccompDb > -9 && (vocSing >= 0.075 || scene.singingProb >= 0.05)) {
      hasSong = true;
    }
  }
  if (hasSong) {
    types.add("song");
  }

  // 2. BGM / musical accompaniment
  const accRms = stems ? computeRms(stems.accompaniment16k) : 0;
  const hasBgm =
    scene.musicProb >= 0.14 ||
    hasSong ||
    (stems !== null && accRms >= 0.012 && stems.vocalToAccompDb <= 12) ||
    (hasBgmAsrTag && scene.musicProb >= 0.08);
  if (hasBgm) {
    types.add("bgm");
  }

  // 3. Speech (avoid mislabeling pure singing as spoken speech)
  const heavySingingOnly =
    hasSong &&
    !hasConfirmedSpeech &&
    scene.speechProb < 0.14 &&
    (vocalsScene === null || vocalsScene.speechProb < 0.22);

  if (
    hasConfirmedSpeech ||
    (!heavySingingOnly &&
      (scene.speechProb >= 0.14 ||
        (vocalsScene !== null && vocalsScene.speechProb >= 0.24 && vocalsScene.singingProb < 0.22)))
  ) {
    types.add("speech");
  }

  // 4. Ambient / TV / Crowd Noise
  const snrGainDb = bestSnrOutDb - inputSnrDb;
  const hasNoise =
    (scene.noiseProb >= 0.085 && scene.musicProb < 0.35) ||
    (scene.crowdTvProb >= 0.14 && scene.musicProb < 0.3) ||
    (!isMusicScene &&
      !hasBgm &&
      inputSnrDb < 14 &&
      (scene.noiseProb >= 0.03 ||
        (diag.spectralFlatnessApprox >= 0.5 && diag.frameEnergyStdRatio < 0.72) ||
        (snrGainDb >= 6.5 && diag.frameEnergyStdRatio < 0.78)));
  if (hasNoise) {
    types.add("noise");
  }

  // 5. Multi-speaker
  if (isMultiSpeaker) {
    types.add("multi_speaker");
    types.add("speech");
  }

  return [...types];
}

export function createSolutionS1(pool: SharedVoiceModelPool): VoiceSolution {
  return {
    id: "s1_ced_adaptive_router",
    name: "S1: CED Audio Scene Classifier + Adaptive Separation Router",
    description:
      "并行 CED-tiny 527类声学场景识别与轻量声学诊断前置门控 -> 自适应三路分离路由（音乐/歌声走 Spleeter 2-stems + GTCRN；强噪/TV/人群走 DPDFNet4+GTCRN 双降噪择优；干净场景走极速单轨 GTCRN）-> 语音起始对齐中英唤醒词恢复与安全注意力门控。",

    async init(): Promise<void> {
      pool.ensureCedTagger();
      pool.ensureSpleeter();
      // Pre-warm DPDFNet4 and en-US SenseVoice recognizer so first-clip latency is not skewed by model loading
      try {
        const silent = new Float32Array(3200);
        pool.localEngine.denoise(silent, SAMPLE_RATE, "dpdfnet");
        await pool.localEngine.transcribeLocal(silent, SAMPLE_RATE, "en-US");
      } catch {
        // graceful fallback if optional model unavailable
      }
    },

    async process(input: SolutionRunInput): Promise<SolutionRunOutput> {
      const t0 = performance.now();
      const engine = pool.localEngine;
      const { pcm16k, wakeWords } = input;
      const runtimeCtx = buildRuntimeDialogContext(input.clip, wakeWords);
      const hasAsciiWake = wakeWords.some((w) => /^[a-z][a-z0-9\s-]*$/i.test(w.trim()));

      const stageTimingsMs: Record<string, number> = {};
      const separatedStreams: SeparatedStreamSummary[] = [];

      // =========================================================================
      // 1. Parallel Scene Recognition First (CED-tiny 527-class + Acoustic Diagnostics)
      // =========================================================================
      const tScene0 = performance.now();
      const [scene, diag, inputSnrDb] = await Promise.all([
        Promise.resolve().then(() => pool.analyzeAudioScene(pcm16k)),
        Promise.resolve().then(() => computeAcousticDiagnostics(pcm16k)),
        Promise.resolve().then(() => estimateSnrDb(pcm16k, SAMPLE_RATE)),
      ]);
      stageTimingsMs.sceneMs = Math.round(performance.now() - tScene0);

      // Guard against empty / near-silent clips
      if (!hasAudibleEnergy(pcm16k, 0.003)) {
        return {
          isNeoCommand: false,
          wokeOnly: false,
          command: "",
          rawTranscript: "",
          detectedSoundTypes: scene.noiseProb >= 0.08 ? ["noise"] : [],
          detectedSpeakerCount: 0,
          separatedStreams: [],
          attentionStage: "silence-skip",
          attentionReason: "音频能量过低（静音），直接跳过",
          latencyMs: Math.round(performance.now() - t0),
          stageTimingsMs,
        };
      }

      // =========================================================================
      // 2. Early Gate for Non-Speech (Music / Pure Noise with no Silero VAD Speech)
      // =========================================================================
      let cachedGtcrn: DenoiseOutput | null = null;
      const isStrongNonSpeechCandidate =
        scene.speechProb < 0.08 && (scene.musicProb >= 0.45 || scene.noiseProb >= 0.35);

      if (isStrongNonSpeechCandidate) {
        cachedGtcrn = engine.denoise(pcm16k, SAMPLE_RATE, "auto");
        stageTimingsMs.earlyGtcrnMs = cachedGtcrn.durationMs;

        const tVad0 = performance.now();
        const earlySegs = extractTimedVadSegments(engine, cachedGtcrn.samples, {
          threshold: 0.42,
          minSilenceDuration: 0.25,
          minSpeechDuration: 0.14,
          padSec: 0.12,
          mergeGapSec: 0.18,
        });
        stageTimingsMs.earlyVadMs = Math.round(performance.now() - tVad0);

        const totalEarlySec = earlySegs.reduce((acc, s) => acc + (s.endSec - s.startSec), 0);
        const maxEarlyRms = earlySegs.reduce((mx, s) => Math.max(mx, computeRms(s.samples)), 0);

        if (earlySegs.length === 0 || (totalEarlySec < 0.32 && maxEarlyRms < 0.016)) {
          const earlyTypes: SoundTypeLabel[] = [];
          if (scene.singingProb >= 0.06) earlyTypes.push("song");
          if (scene.musicProb >= 0.16 || scene.singingProb >= 0.08) earlyTypes.push("bgm");
          if (scene.noiseProb >= 0.1 && scene.musicProb < 0.35) earlyTypes.push("noise");
          if (earlyTypes.length === 0) {
            earlyTypes.push(scene.musicProb >= scene.noiseProb ? "bgm" : "noise");
          }

          separatedStreams.push({
            streamId: earlyTypes.includes("bgm") ? "non_speech_bgm" : "non_speech_noise",
            kind: earlyTypes.includes("bgm") ? "bgm_accompaniment" : "noise",
            energyRatio: 1,
          });

          return {
            isNeoCommand: false,
            wokeOnly: false,
            command: "",
            rawTranscript: "",
            detectedSoundTypes: earlyTypes,
            detectedSpeakerCount: 0,
            separatedStreams,
            attentionStage: "ced-early-gate",
            attentionReason: `CED 非语音早退门控命中 (speech=${scene.speechProb.toFixed(2)}, music=${scene.musicProb.toFixed(2)}, noise=${scene.noiseProb.toFixed(2)})，且 Silero VAD 无有效语音`,
            latencyMs: Math.round(performance.now() - t0),
            stageTimingsMs,
          };
        }
      }

      // =========================================================================
      // 3. Adaptive Front-End Separation Routing based on CED Scene
      // =========================================================================
      const isMusicScene = scene.musicProb >= 0.16 || scene.singingProb >= 0.05;
      const isAcousticNoisy =
        diag.spectralFlatnessApprox >= 0.58 && diag.frameEnergyStdRatio < 0.65;
      const isNoiseScene =
        !isMusicScene &&
        (scene.noiseProb >= 0.1 ||
          scene.crowdTvProb >= 0.12 ||
          inputSnrDb < 14 ||
          isAcousticNoisy);

      const route: "music" | "noise" | "clean" = isMusicScene
        ? "music"
        : isNoiseScene
          ? "noise"
          : "clean";

      let stems: MusicSeparationResult | null = null;
      let vocalsScene: SceneAnalysis | null = null;
      let primaryFull: Float32Array = pcm16k;
      let secondaryFull: Float32Array = applyHighPassFilter(pcm16k, SAMPLE_RATE, 85);
      let bestSnrOutDb = inputSnrDb;
      let chosenTimedSegs: TimedVadSegment[] = [];

      const rawTotalPower = Math.max(1e-12, computeRms(pcm16k) ** 2);

      if (route === "music") {
        stems = pool.separateMusicStems(pcm16k, "spleeter");
        if (stems) {
          stageTimingsMs.spleeterMs = stems.durationMs;
          const vocRms = computeRms(stems.vocals16k);
          const accRms = computeRms(stems.accompaniment16k);
          const totalStemPow = Math.max(1e-12, vocRms * vocRms + accRms * accRms);
          const accRatio = (accRms * accRms) / totalStemPow;

          separatedStreams.push({
            streamId: "spleeter_accompaniment",
            kind: "bgm_accompaniment",
            energyRatio: Number(accRatio.toFixed(3)),
          });

          if (vocRms >= 0.005) {
            vocalsScene = pool.analyzeAudioScene(stems.vocals16k);
            stageTimingsMs.vocalsSceneMs = vocalsScene.durationMs;
          }

          const denVocals = engine.denoise(stems.vocals16k, SAMPLE_RATE, "auto");
          stageTimingsMs.denoiseMs = denVocals.durationMs;
          bestSnrOutDb = denVocals.outputSnrDb;

          const tVad0 = performance.now();
          const denVocSegs = extractTimedVadSegments(engine, denVocals.samples, {
            threshold: 0.36,
            minSilenceDuration: 0.25,
            minSpeechDuration: 0.14,
            padSec: 0.14,
            mergeGapSec: 0.22,
          });
          const rawVocSegs = extractTimedVadSegments(engine, stems.vocals16k, {
            threshold: 0.4,
            minSilenceDuration: 0.25,
            minSpeechDuration: 0.14,
            padSec: 0.14,
            mergeGapSec: 0.22,
          });
          stageTimingsMs.vadMs = Math.round(performance.now() - tVad0);

          chosenTimedSegs = selectMusicSegments(denVocSegs, rawVocSegs);
          primaryFull = denVocals.samples;
          secondaryFull = applyHighPassFilter(stems.vocals16k, SAMPLE_RATE, 85);

          // Pure instrumental BGM after Spleeter: virtually silent vocal track & no VAD segments
          if (chosenTimedSegs.length === 0 && vocRms < 0.008) {
            const types = buildFinalSoundTypes({
              scene,
              vocalsScene,
              stems,
              diag,
              inputSnrDb,
              bestSnrOutDb,
              isMusicScene: true,
              isMultiSpeaker: false,
              hasConfirmedSpeech: false,
              hasBgmAsrTag: false,
            });
            return {
              isNeoCommand: false,
              wokeOnly: false,
              command: "",
              rawTranscript: "",
              detectedSoundTypes: types.length > 0 ? types : ["bgm"],
              detectedSpeakerCount: 0,
              separatedStreams,
              attentionStage: "spleeter-no-vocals",
              attentionReason: `Spleeter 分离后人声轨静默 (vocalToAccomp=${stems.vocalToAccompDb}dB)，判定为纯伴奏背景音乐`,
              latencyMs: Math.round(performance.now() - t0),
              stageTimingsMs,
            };
          }
        } else {
          // Graceful fallback if Spleeter unavailable
          const gtcrn = cachedGtcrn ?? engine.denoise(pcm16k, SAMPLE_RATE, "auto");
          stageTimingsMs.denoiseMs = gtcrn.durationMs;
          bestSnrOutDb = gtcrn.outputSnrDb;
          const tVad0 = performance.now();
          chosenTimedSegs = extractTimedVadSegments(engine, gtcrn.samples, {
            threshold: 0.36,
            minSilenceDuration: 0.25,
            minSpeechDuration: 0.14,
            padSec: 0.14,
            mergeGapSec: 0.2,
          });
          stageTimingsMs.vadMs = Math.round(performance.now() - tVad0);
          primaryFull = gtcrn.samples;
          secondaryFull = applyHighPassFilter(pcm16k, SAMPLE_RATE, 90);
        }
      } else if (route === "noise") {
        const dpdf = engine.denoise(pcm16k, SAMPLE_RATE, "dpdfnet");
        const gtcrn = cachedGtcrn ?? engine.denoise(pcm16k, SAMPLE_RATE, "auto");
        stageTimingsMs.dpdfnetMs = dpdf.durationMs;
        stageTimingsMs.gtcrnMs = gtcrn.durationMs;

        const tVad0 = performance.now();
        const dpdfSegs = extractTimedVadSegments(engine, dpdf.samples, {
          threshold: 0.38,
          minSilenceDuration: 0.24,
          minSpeechDuration: 0.14,
          padSec: 0.14,
          mergeGapSec: 0.18,
        });
        const gtcrnSegs = extractTimedVadSegments(engine, gtcrn.samples, {
          threshold: 0.38,
          minSilenceDuration: 0.24,
          minSpeechDuration: 0.14,
          padSec: 0.14,
          mergeGapSec: 0.18,
        });
        stageTimingsMs.vadMs = Math.round(performance.now() - tVad0);

        const picked = selectNoiseBranchTrackAndSegments(
          dpdf,
          gtcrn,
          dpdfSegs,
          gtcrnSegs,
          pcm16k.length,
        );
        primaryFull = picked.primaryFull;
        secondaryFull = picked.secondaryFull;
        chosenTimedSegs = picked.segments;
        bestSnrOutDb = picked.primarySnrOut;

        const denPow = computeRms(primaryFull) ** 2;
        const noiseRatio = Math.max(0, Math.min(1, (rawTotalPower - denPow) / rawTotalPower));
        separatedStreams.push({
          streamId: `ambient_noise_${picked.primaryEngine}`,
          kind: "noise",
          energyRatio: Number(noiseRatio.toFixed(3)),
        });
      } else {
        // Clean scene: fast single-track GTCRN + conditional high-pass raw fallback
        const gtcrn = cachedGtcrn ?? engine.denoise(pcm16k, SAMPLE_RATE, "auto");
        stageTimingsMs.gtcrnMs = gtcrn.durationMs;
        bestSnrOutDb = gtcrn.outputSnrDb;

        const tVad0 = performance.now();
        chosenTimedSegs = extractTimedVadSegments(engine, gtcrn.samples, {
          threshold: 0.38,
          minSilenceDuration: 0.24,
          minSpeechDuration: 0.12,
          padSec: 0.14,
          mergeGapSec: 0.18,
        });
        stageTimingsMs.vadMs = Math.round(performance.now() - tVad0);

        primaryFull = gtcrn.samples;
        secondaryFull = applyHighPassFilter(pcm16k, SAMPLE_RATE, 85);
      }

      // Low-threshold Silero VAD rescue pass if default VAD found nothing
      if (chosenTimedSegs.length === 0) {
        const rescueSegs = extractTimedVadSegments(engine, primaryFull, {
          threshold: 0.22,
          minSilenceDuration: 0.24,
          minSpeechDuration: 0.12,
          padSec: 0.14,
          mergeGapSec: 0.2,
        }).filter((s) => computeRms(s.samples) >= 0.007);
        if (rescueSegs.length > 0) {
          chosenTimedSegs = rescueSegs;
        } else if (scene.speechProb >= 0.25 && hasAudibleEnergy(primaryFull, 0.012)) {
          chosenTimedSegs = [
            {
              startSample: 0,
              endSample: primaryFull.length,
              startSec: 0,
              endSec: Number((primaryFull.length / SAMPLE_RATE).toFixed(3)),
              samples: primaryFull,
            },
          ];
        }
      }

      if (chosenTimedSegs.length === 0) {
        const types = buildFinalSoundTypes({
          scene,
          vocalsScene,
          stems,
          diag,
          inputSnrDb,
          bestSnrOutDb,
          isMusicScene,
          isMultiSpeaker: false,
          hasConfirmedSpeech: false,
          hasBgmAsrTag: false,
        });
        return {
          isNeoCommand: false,
          wokeOnly: false,
          command: "",
          rawTranscript: "",
          detectedSoundTypes: types.length > 0 ? types : [isMusicScene ? "bgm" : "noise"],
          detectedSpeakerCount: 0,
          separatedStreams,
          attentionStage: "vad-skip",
          attentionReason: `分离路由(${route})后 Silero VAD 未检测到有效人声分段`,
          latencyMs: Math.round(performance.now() - t0),
          stageTimingsMs,
        };
      }

      const cappedSegs = capSegmentsChronologically(chosenTimedSegs, MAX_SEGMENTS_TO_EVALUATE);
      const hpRawFull = applyHighPassFilter(pcm16k, SAMPLE_RATE, 90);
      const segmentBundles: SegmentBundle[] = cappedSegs.map((seg) => {
        const s = Math.max(0, Math.min(primaryFull.length, seg.startSample));
        const e = Math.max(s, Math.min(primaryFull.length, seg.endSample));
        const s2 = Math.max(0, Math.min(secondaryFull.length, seg.startSample));
        const e2 = Math.max(s2, Math.min(secondaryFull.length, seg.endSample));
        const sR = Math.max(0, Math.min(hpRawFull.length, seg.startSample));
        const eR = Math.max(sR, Math.min(hpRawFull.length, seg.endSample));

        const primaryAudio = primaryFull.slice(s, e);
        const secondaryAudio = secondaryFull.slice(s2, e2);
        const hpRawAudio = hpRawFull.slice(sR, eR);
        const segPow = computeRms(primaryAudio) ** 2;
        return {
          startSample: s,
          endSample: e,
          startSec: seg.startSec,
          endSec: seg.endSec,
          primaryAudio,
          secondaryAudio,
          hpRawAudio,
          energyRatio: Number(Math.min(1, segPow / rawTotalPower).toFixed(3)),
        };
      });

      // =========================================================================
      // 4. Multi-Speaker Detection via 3D-Speaker CAM++ Clustering (sim < 0.45)
      // =========================================================================
      const speakerInfo = clusterSegmentSpeakers(
        pool,
        segmentBundles,
        !isMusicScene && scene.singingProb < 0.08,
      );
      stageTimingsMs.speakerClusterMs = speakerInfo.durationMs;

      const heavySinging =
        (scene.singingProb >= 0.12 && scene.speechProb < 0.25) ||
        (vocalsScene !== null && vocalsScene.singingProb >= 0.16 && vocalsScene.speechProb < 0.25);

      // =========================================================================
      // 5. Per-Segment ASR + Speech-Onset Aligned Bilingual Wake Recovery + Safe Attention Gate
      // =========================================================================
      const evalResults: SegmentEvalResult[] = [];
      let totalAsrMs = 0;
      let totalProbeMs = 0;
      let totalOwwMs = 0;
      let sawBgmAsrTag = false;

      const evaluateCandidateText = async (params: {
        candidateText: string;
        rawAsrText: string;
        altAsrText: string;
        asrEvent: string;
        acousticWake: WakeWordAcousticHit | null;
        isThirdPerson: boolean;
        confirmedByEnExact: boolean;
        confirmedByEnOrOww: boolean;
      }): Promise<{ decision: AttentionDecision; exactWake: boolean }> => {
        const {
          candidateText,
          rawAsrText,
          altAsrText,
          asrEvent,
          acousticWake,
          isThirdPerson,
          confirmedByEnExact,
          confirmedByEnOrOww,
        } = params;

        const cleaned = candidateText.trim();
        if (!cleaned) {
          return {
            exactWake: false,
            decision: {
              accept: false,
              wokeOnly: false,
              addressed: false,
              inConversation: runtimeCtx.dialogState === "conversation",
              confidence: 1,
              stage: "no-wake",
              reason: "识别结果为空",
              wakeWord: null,
              command: "",
              usedLlm: false,
              latencyMs: 0,
            },
          };
        }

        // CRITICAL FIX 1: Reject third-person Neo mention before attention gate
        if (isThirdPerson || isReferentialWakeContext(cleaned, wakeWords)) {
          return {
            exactWake: false,
            decision: {
              accept: false,
              wokeOnly: false,
              addressed: false,
              inConversation: runtimeCtx.dialogState === "conversation",
              confidence: 0.92,
              stage: "pragmatic-reject",
              reason: "检测到对唤醒词的第三人称提及或否定呼唤语境，已拦截",
              wakeWord: null,
              command: "",
              usedLlm: false,
              latencyMs: 0,
            },
          };
        }

        const wakeSpan = findWakeWordSpan(cleaned, wakeWords);
        const exactWake = Boolean(wakeSpan && !wakeSpan.fuzzy);

        // CRITICAL FIX 2: Block risky fuzzy Chinese aliases ("你好" / "你有" / ...) without smart-home domain intent
        if (wakeSpan && isRiskyChineseFuzzyAlias(wakeSpan)) {
          const extractedCmd = wakeSpan.afterText;
          if (
            isAmbiguousChineseInterrogative(cleaned, extractedCmd) ||
            (!hasSmartHomeDomainIntent(extractedCmd) && !confirmedByEnExact)
          ) {
            return {
              exactWake: false,
              decision: {
                accept: false,
                wokeOnly: false,
                addressed: false,
                inConversation: runtimeCtx.dialogState === "conversation",
                confidence: 0.9,
                stage: "pragmatic-reject",
                reason: `模糊中文近音「${wakeSpan.matchedSurface}」缺乏智能家居控制语义，拦截防误触`,
                wakeWord: wakeSpan.wakeWord,
                command: "",
                usedLlm: false,
                latencyMs: 0,
              },
            };
          }
        }

        // In conversation mode, reject heavy singing lyrics unless explicit wake or smart-home intent
        if (
          runtimeCtx.dialogState === "conversation" &&
          heavySinging &&
          !wakeSpan &&
          !hasSmartHomeDomainIntent(cleaned)
        ) {
          return {
            exactWake: false,
            decision: {
              accept: false,
              wokeOnly: false,
              addressed: false,
              inConversation: true,
              confidence: 0.9,
              stage: "acoustic",
              reason: "连续对话窗口内检测到高置信度歌声且无唤醒词/智能家居意图，拒绝歌词误触发",
              wakeWord: null,
              command: "",
              usedLlm: false,
              latencyMs: 0,
            },
          };
        }

        // Enhanced TTS echo rejection (protects against slightly noisy self-echo without blocking opposite commands)
        if (!wakeSpan && isStrongEchoConfirmation(cleaned, runtimeCtx.lastSpokenReply)) {
          return {
            exactWake: false,
            decision: {
              accept: false,
              wokeOnly: false,
              addressed: false,
              inConversation: runtimeCtx.dialogState === "conversation",
              confidence: 0.9,
              stage: "echo",
              reason: "与系统刚刚播报的回复高度重合且非反向控制指令，判定为自回声并抑制",
              wakeWord: null,
              command: "",
              usedLlm: false,
              latencyMs: 0,
            },
          };
        }

        // Decide whether openWakeWord acoustic veto should apply on fuzzy matches:
        // Do NOT falsely veto strong phonetic transliterations ("尼奥"/"neil") or music/noise smart-home aliases
        const isStrongHomophoneWithIntent =
          Boolean(
            wakeSpan &&
              wakeSpan.fuzzy &&
              STRONG_WAKE_HOMOPHONES.has(wakeSpan.matchedSurface.toLowerCase()) &&
              (hasSmartHomeDomainIntent(wakeSpan.afterText) ||
                looksLikeDirectDeviceCommand(wakeSpan.afterText) ||
                wakeSpan.afterText.length === 0),
          );
        const allowNoisySmartHomeFuzzy =
          Boolean(
            wakeSpan &&
              wakeSpan.fuzzy &&
              (isMusicScene || isNoiseScene) &&
              hasSmartHomeDomainIntent(wakeSpan.afterText) &&
              !isAmbiguousChineseInterrogative(cleaned, wakeSpan.afterText),
          );
        const applyOwwVeto =
          engine.openWakeWord.isReady &&
          !confirmedByEnOrOww &&
          !isStrongHomophoneWithIntent &&
          !allowNoisySmartHomeFuzzy;

        const effectiveAcousticEvent = isMusicScene ? "<|BGM|>" : asrEvent;
        const decision = await evaluateVoiceAttention({
          ...runtimeCtx,
          rawText: cleaned,
          altText: altAsrText || rawAsrText,
          acousticEvent: effectiveAcousticEvent,
          acousticWake,
          owwActiveForWord: applyOwwVeto,
        });

        // Post-guard for conversation fast-followup: reject domestic side-talk ("帮我把水递过来")
        if (
          decision.accept &&
          decision.stage === "fast-followup" &&
          !wakeSpan &&
          !hasValidFollowupIntent(decision.command)
        ) {
          return {
            exactWake: false,
            decision: {
              ...decision,
              accept: false,
              addressed: false,
              stage: "pragmatic-reject",
              reason: "连续对话窗口内无明确智能家居控制意图，判定为家庭日常旁白并拦截",
              command: "",
            },
          };
        }

        // Clean trailing/leading lyrics or bystander bleed in music / multi-speaker scenes
        if (decision.accept && !decision.wokeOnly && decision.command) {
          const cleanedCmd = extractCleanCommandClause(
            decision.command,
            isMusicScene || speakerInfo.isMultiSpeaker,
          );
          if (cleanedCmd) {
            return {
              exactWake,
              decision: {
                ...decision,
                command: cleanedCmd,
              },
            };
          }
        }

        return { exactWake, decision };
      };

      for (let i = 0; i < segmentBundles.length; i += 1) {
        const seg = segmentBundles[i]!;
        const segDurSec = seg.endSec - seg.startSec;
        const spkId = speakerInfo.speakerIds[i] ?? "spk_0";

        // 5.1 Adaptive per-segment SenseVoice ASR
        let bestAsr: LocalAsrOutput;
        let altAsrText = "";
        let segAsrMs = 0;

        if (route === "clean") {
          const primaryRes = await engine.transcribeLocal(seg.primaryAudio, SAMPLE_RATE, "zh-CN");
          segAsrMs += primaryRes.durationMs;
          const pSpan = findWakeWordSpan(primaryRes.text, wakeWords);
          const pExactWake = Boolean(pSpan && !pSpan.fuzzy);
          const pThirdPerson = isReferentialWakeContext(primaryRes.text, wakeWords);
          const pCleanFollowup =
            runtimeCtx.dialogState === "conversation" &&
            hasValidFollowupIntent(primaryRes.text) &&
            !AMBIGUOUS_ZH_PREFIX_RE.test(primaryRes.text.trim());

          if ((pExactWake || pThirdPerson || pCleanFollowup) && primaryRes.text.trim().length > 0) {
            bestAsr = primaryRes;
          } else {
            // Conditional high-pass raw fallback (rescues clipped consonants / English "Neo")
            const rawRes = await engine.transcribeLocal(seg.hpRawAudio, SAMPLE_RATE, "zh-CN");
            segAsrMs += rawRes.durationMs;
            const sPrimary = scoreAsrCandidate(primaryRes, wakeWords, {
              isPrimary: true,
              preferPrimaryBonus: 6,
              preferSecondaryBonus: 0,
            });
            const sRaw = scoreAsrCandidate(rawRes, wakeWords, {
              isPrimary: false,
              preferPrimaryBonus: 6,
              preferSecondaryBonus: 0,
            });
            if (sRaw > sPrimary) {
              bestAsr = rawRes;
              altAsrText = primaryRes.text;
            } else {
              bestAsr = primaryRes;
              altAsrText = rawRes.text;
            }
          }
        } else {
          // Music (denVocals vs Spleeter vocals) or Noise (DPDFNet4 vs GTCRN): dual-track parallel ASR
          const [resA, resB] = await Promise.all([
            engine.transcribeLocal(seg.primaryAudio, SAMPLE_RATE, "zh-CN"),
            seg.secondaryAudio.length >= 1600
              ? engine.transcribeLocal(seg.secondaryAudio, SAMPLE_RATE, "zh-CN")
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
          segAsrMs += resA.durationMs + resB.durationMs;

          const sA = scoreAsrCandidate(resA, wakeWords, {
            isPrimary: true,
            preferPrimaryBonus: route === "noise" ? 10 : 6,
            preferSecondaryBonus: route === "music" ? 8 : 0,
          });
          const sB = scoreAsrCandidate(resB, wakeWords, {
            isPrimary: false,
            preferPrimaryBonus: route === "noise" ? 10 : 6,
            preferSecondaryBonus: route === "music" ? 8 : 0,
          });

          if (sA >= sB) {
            bestAsr = resA;
            altAsrText = resB.text;
          } else {
            bestAsr = resB;
            altAsrText = resA.text;
          }
        }
        totalAsrMs += segAsrMs;

        if (bestAsr.event.toUpperCase().includes("BGM")) {
          sawBgmAsrTag = true;
        }

        const rawAsrText = bestAsr.text.trim();
        // Check third-person across BOTH ASR tracks so denoiser boundary clipping cannot hide "别管"
        const isThirdPerson =
          isReferentialWakeContext(rawAsrText, wakeWords) ||
          isReferentialWakeContext(altAsrText, wakeWords);

        // 5.2 Per-segment openWakeWord acoustic scoring (aligned to VAD segment)
        const tOww0 = performance.now();
        const owwHeadSec = segDurSec > 2.4 ? Math.min(6.0, segDurSec) : 2.0;
        let acousticWake = engine.scoreWakeWordAudio(seg.primaryAudio, wakeWords, {
          threshold: 0.58,
          headOnlySec: owwHeadSec,
        });
        if (!acousticWake?.matched && seg.secondaryAudio.length >= 2400) {
          const secHit = engine.scoreWakeWordAudio(seg.secondaryAudio, wakeWords, {
            threshold: 0.58,
            headOnlySec: owwHeadSec,
          });
          if (secHit && (!acousticWake || secHit.score > acousticWake.score)) {
            acousticWake = secHit;
          }
        }
        const segOwwMs = Math.round(performance.now() - tOww0);
        totalOwwMs += segOwwMs;

        // 5.3 Speech-Onset Aligned Bilingual Wake Recovery (NEVER overwrite if isThirdPerson!)
        let candidateText = rawAsrText;
        let enHeadText: string | undefined;
        let segProbeMs = 0;
        let confirmedByEnExact = false;
        let confirmedByEnOrOww = false;

        const initialSpan = findWakeWordSpan(rawAsrText, wakeWords);
        const hasExactInitialWake = Boolean(initialSpan && !initialSpan.fuzzy);

        if (!isThirdPerson && !hasExactInitialWake && hasAsciiWake) {
          const asciiWakes = wakeWords.filter((w) => /^[a-z][a-z0-9\s-]*$/i.test(w.trim()));
          const primaryWake = asciiWakes[0] ?? wakeWords[0] ?? "Neo";
          const extractedForCheck = extractCommandAfterAcousticWake(rawAsrText, primaryWake);
          const hasDomainIntent = hasSmartHomeDomainIntent(extractedForCheck);
          const hasDirectCmd =
            extractedForCheck.length >= 2 &&
            (looksLikeDirectDeviceCommand(extractedForCheck) || isWakeQueryText(extractedForCheck));
          const meaningfulLen = countMeaningfulChars(rawAsrText);
          const hasWeird = WEIRD_SCRIPT_RE.test(rawAsrText);
          const isShortOrGarbled =
            segDurSec <= 2.2 || meaningfulLen <= 5 || hasWeird || rawAsrText.length === 0;
          const ambiguousPrefix = AMBIGUOUS_ZH_PREFIX_RE.test(rawAsrText);
          const ambiguousInterrogative = isAmbiguousChineseInterrogative(
            rawAsrText,
            extractedForCheck,
          );

          // Should we run onset-aligned en-US head probe?
          const shouldProbeEn =
            !ambiguousInterrogative &&
            (hasDomainIntent ||
              isShortOrGarbled ||
              Boolean(initialSpan) ||
              (hasDirectCmd && !ambiguousPrefix) ||
              (acousticWake !== null && acousticWake.score >= 0.35));

          let enHit: { wakeWord: string; matchedSurface: string; fuzzy: boolean } | null = null;
          let enResText = "";

          if (shouldProbeEn) {
            // Only allow fuzzy en-US command-gated aliases ("new"/"near"/"leo") when true smart-home intent exists!
            const allowGatedAliases =
              (hasDomainIntent || isWakeQueryText(extractedForCheck)) && !ambiguousPrefix;

            const runEnProbe = async (
              clip: Float32Array,
              allowAliases: boolean,
            ): Promise<{
              text: string;
              hit: { wakeWord: string; matchedSurface: string; fuzzy: boolean } | null;
            }> => {
              if (clip.length < 1600) return { text: "", hit: null };
              const res = await engine.transcribeLocal(clip, SAMPLE_RATE, "en-US");
              segProbeMs += res.durationMs;
              const hit = matchEnglishHeadWakeWord(res.text, asciiWakes, {
                allowCommandGatedAliases: allowAliases,
              });
              return { text: res.text, hit };
            };

            // Probe 1: Speech-onset aligned 0..1.15s on primaryAudio, then secondaryAudio
            const head115Len = Math.round(SAMPLE_RATE * 1.15);
            const p1 = await runEnProbe(
              seg.primaryAudio.subarray(0, Math.min(seg.primaryAudio.length, head115Len)),
              allowGatedAliases,
            );
            if (p1.hit) {
              enHit = p1.hit;
              enResText = p1.text;
            } else if (seg.secondaryAudio.length >= 1600) {
              const p2 = await runEnProbe(
                seg.secondaryAudio.subarray(0, Math.min(seg.secondaryAudio.length, head115Len)),
                allowGatedAliases,
              );
              if (p2.hit) {
                enHit = p2.hit;
                enResText = p2.text;
              }
            }

            // Probe 2: Short fast connected speech 0..0.65s (e.g. fast "Neo关灯")
            if (
              !enHit &&
              (hasDomainIntent || isShortOrGarbled || Boolean(initialSpan)) &&
              seg.secondaryAudio.length >= Math.round(SAMPLE_RATE * 0.65)
            ) {
              const head065Len = Math.round(SAMPLE_RATE * 0.65);
              const fastClip =
                route === "noise"
                  ? seg.primaryAudio.subarray(0, Math.min(seg.primaryAudio.length, head065Len))
                  : seg.secondaryAudio.subarray(0, Math.min(seg.secondaryAudio.length, head065Len));
              const pFast = await runEnProbe(fastClip, allowGatedAliases);
              if (pFast.hit) {
                enHit = pFast.hit;
                enResText = pFast.text;
              } else if (route === "music" && seg.hpRawAudio.length >= head065Len) {
                const pRawFast = await runEnProbe(
                  seg.hpRawAudio.subarray(0, Math.min(seg.hpRawAudio.length, head065Len)),
                  allowGatedAliases,
                );
                if (pRawFast.hit) {
                  enHit = pRawFast.hit;
                  enResText = pRawFast.text;
                }
              }
            }

            // Probe 3: Localized mid-segment en-US probe around OWW peak (long music/multi-speaker segments)
            const owwMidFloor = hasDomainIntent ? 0.26 : 0.35;
            if (
              !enHit &&
              segDurSec > 2.0 &&
              acousticWake &&
              acousticWake.score >= owwMidFloor &&
              acousticWake.sampleOffset > Math.round(SAMPLE_RATE * 0.8)
            ) {
              const targetAudio = route === "music" ? seg.secondaryAudio : seg.primaryAudio;
              const winStart = Math.max(
                0,
                acousticWake.sampleOffset - Math.round(SAMPLE_RATE * 0.95),
              );
              const winEnd = Math.min(
                targetAudio.length,
                acousticWake.sampleOffset + Math.round(SAMPLE_RATE * 0.45),
              );
              if (winEnd - winStart >= 3200) {
                const pMid = await runEnProbe(
                  targetAudio.subarray(winStart, winEnd),
                  allowGatedAliases,
                );
                if (pMid.hit) {
                  enHit = pMid.hit;
                  enResText = pMid.text;
                }
              }
            }

            // Probe 4: Embedded command boundary probe when lyrics/bystander preceded a smart-home command
            if (
              !enHit &&
              (isMusicScene || speakerInfo.isMultiSpeaker) &&
              hasDomainIntent &&
              segDurSec >= 1.8
            ) {
              const embIdx = findEmbeddedCommandStartIndex(rawAsrText);
              const totalLen = Math.max(1, rawAsrText.length);
              const prefixRatio = embIdx / totalLen;
              if (prefixRatio >= 0.12 && prefixRatio <= 0.75) {
                const targetAudio = route === "music" ? seg.secondaryAudio : seg.primaryAudio;
                const estCenter = Math.round(prefixRatio * targetAudio.length);
                const winStart = Math.max(0, estCenter - Math.round(SAMPLE_RATE * 0.85));
                const winEnd = Math.min(
                  targetAudio.length,
                  estCenter + Math.round(SAMPLE_RATE * 0.55),
                );
                if (winEnd - winStart >= 3200) {
                  const pBound = await runEnProbe(targetAudio.subarray(winStart, winEnd), false);
                  if (pBound.hit) {
                    enHit = pBound.hit;
                    enResText = pBound.text;
                  }
                }
              }
            }

            if (enResText) {
              enHeadText = enResText;
            }
          }

          totalProbeMs += segProbeMs;

          // Safely apply wake recovery from en-US probe or strong openWakeWord hit
          if (enHit && !ambiguousInterrogative) {
            const isExactSurface =
              !enHit.fuzzy &&
              enHit.matchedSurface.toLowerCase().includes(enHit.wakeWord.toLowerCase());
            const extracted = extractCommandAfterAcousticWake(rawAsrText, enHit.wakeWord);
            const cleanedCmd = extractCleanCommandClause(
              extracted,
              isMusicScene || speakerInfo.isMultiSpeaker,
            );
            const extractedHasDomain = hasSmartHomeDomainIntent(cleanedCmd);

            // Guard: If Chinese ASR started with "你好"/"你有" and no smart-home domain intent, block unless pure exact "Neo"
            if (ambiguousPrefix && !extractedHasDomain) {
              if (cleanedCmd.length === 0 && isExactSurface) {
                candidateText = enHit.wakeWord;
                confirmedByEnExact = true;
                confirmedByEnOrOww = true;
              }
            } else if (cleanedCmd && !isWakeQueryText(cleanedCmd)) {
              if (isExactSurface || extractedHasDomain) {
                candidateText = `${enHit.wakeWord}，${cleanedCmd}`;
                confirmedByEnExact = isExactSurface;
                confirmedByEnOrOww = true;
              }
            } else if (isShortOrGarbled) {
              // Pure wake word recovery ("Neo" / "Hey Neo" / "Neo在吗")
              if (isExactSurface || !enHit.fuzzy || (acousticWake && acousticWake.score >= 0.45)) {
                const enSpan = findWakeWordSpan(enResText, asciiWakes);
                const enAfter = enSpan?.afterText?.trim() ?? "";
                candidateText =
                  enAfter && hasSmartHomeDomainIntent(enAfter)
                    ? `${enHit.wakeWord}，${enAfter}`
                    : enHit.wakeWord;
                confirmedByEnExact = isExactSurface;
                confirmedByEnOrOww = true;
              }
            }
          } else if (acousticWake?.matched && !ambiguousInterrogative) {
            // OWW-only recovery when en-US missed: strictly gated on smart-home domain intent or high-score short garble
            const extracted = extractCommandAfterAcousticWake(rawAsrText, acousticWake.wakeWord);
            const cleanedCmd = extractCleanCommandClause(
              extracted,
              isMusicScene || speakerInfo.isMultiSpeaker,
            );
            const extractedHasDomain = hasSmartHomeDomainIntent(cleanedCmd);
            const highConfOww = acousticWake.score >= (isMusicScene ? 0.68 : 0.64);

            if (extractedHasDomain && !HOUSEHOLD_SIDETALK_RE.test(cleanedCmd)) {
              candidateText = `${acousticWake.wakeWord}，${cleanedCmd}`;
              confirmedByEnOrOww = true;
            } else if (
              !ambiguousPrefix &&
              !cleanedCmd &&
              isShortOrGarbled &&
              highConfOww &&
              !heavySinging
            ) {
              candidateText = acousticWake.wakeWord;
              confirmedByEnOrOww = true;
            }
          }
        }

        const { decision, exactWake } = await evaluateCandidateText({
          candidateText,
          rawAsrText,
          altAsrText,
          asrEvent: bestAsr.event,
          acousticWake,
          isThirdPerson,
          confirmedByEnExact,
          confirmedByEnOrOww,
        });

        evalResults.push({
          segIndex: i,
          speakerId: spkId,
          startSec: seg.startSec,
          endSec: seg.endSec,
          energyRatio: seg.energyRatio,
          rawAsrText,
          altAsrText,
          candidateText,
          enHeadText,
          acousticWake,
          decision,
          exactWake,
          isThirdPerson,
          asrMs: segAsrMs,
          probeMs: segProbeMs,
          owwMs: segOwwMs,
        });
      }

      stageTimingsMs.asrMs = totalAsrMs;
      stageTimingsMs.enProbeMs = totalProbeMs;
      stageTimingsMs.owwMs = totalOwwMs;

      // =========================================================================
      // 5.4 Adjacent Wake + Command Segment Merge ("Neo" [pause <= 1.0s] "打开客厅灯")
      // =========================================================================
      for (let i = 0; i + 1 < evalResults.length; i += 1) {
        const cur = evalResults[i]!;
        const nxt = evalResults[i + 1]!;
        if (!cur.decision.accept || !cur.decision.wokeOnly || !cur.decision.wakeWord) continue;
        if (nxt.decision.accept || nxt.isThirdPerson) continue;

        const gapSec = nxt.startSec - cur.endSec;
        const curDur = cur.endSec - cur.startSec;
        const sameOrShortSpeaker = cur.speakerId === nxt.speakerId || curDur < 0.75;
        const nxtText = nxt.rawAsrText.trim();
        if (
          gapSec >= -0.05 &&
          gapSec <= 1.05 &&
          sameOrShortSpeaker &&
          nxtText.length >= 2 &&
          !isReferentialWakeContext(nxtText, wakeWords) &&
          (hasSmartHomeDomainIntent(nxtText) || looksLikeDirectDeviceCommand(nxtText)) &&
          !HOUSEHOLD_SIDETALK_RE.test(nxtText)
        ) {
          const mergedText = `${cur.decision.wakeWord}，${nxtText}`;
          const mergedEval = await evaluateCandidateText({
            candidateText: mergedText,
            rawAsrText: `${cur.rawAsrText} ${nxt.rawAsrText}`.trim(),
            altAsrText: nxt.altAsrText,
            asrEvent: isMusicScene ? "<|BGM|>" : "",
            acousticWake: cur.acousticWake,
            isThirdPerson: false,
            confirmedByEnExact: cur.exactWake,
            confirmedByEnOrOww: true,
          });
          if (mergedEval.decision.accept && !mergedEval.decision.wokeOnly) {
            cur.decision = mergedEval.decision;
            cur.candidateText = mergedText;
            cur.endSec = nxt.endSec;
          }
        }
      }

      // =========================================================================
      // 6. Populate Separated Streams, Select Winning Decision & Fuse Sound Types
      // =========================================================================
      for (const res of evalResults) {
        const streamKind: SeparatedStreamSummary["kind"] =
          isMusicScene && heavySinging && !res.decision.accept
            ? "song_vocals"
            : speakerInfo.isMultiSpeaker
              ? "speaker"
              : "speech";
        separatedStreams.push({
          streamId: `seg_${res.segIndex}_${res.speakerId}`,
          kind: streamKind,
          speakerId: res.speakerId,
          startSec: res.startSec,
          endSec: res.endSec,
          energyRatio: res.energyRatio,
          transcript: res.candidateText || res.rawAsrText,
        });
      }

      const accepted = evalResults.filter((r) => r.decision.accept);
      let winner: SegmentEvalResult | null = null;
      if (accepted.length > 0) {
        accepted.sort((a, b) => {
          // Prefer full command over wokeOnly, then exact wake, then smart-home intent, then confidence
          const score = (r: SegmentEvalResult): number =>
            (r.decision.wokeOnly ? 0 : 100) +
            (r.exactWake ? 25 : 0) +
            (hasSmartHomeDomainIntent(r.decision.command) ? 20 : 0) +
            r.decision.confidence * 10;
          return score(b) - score(a);
        });
        winner = accepted[0]!;
      } else if (evalResults.length > 0) {
        // Pick the most informative rejection stage for diagnostics
        const priorityStages = new Set(["echo", "exit", "pragmatic-reject", "acoustic", "acoustic-veto"]);
        winner =
          evalResults.find((r) => priorityStages.has(r.decision.stage)) ??
          evalResults[evalResults.length - 1]!;
      }

      const hasMeaningfulSpokenText = evalResults.some(
        (r) => r.decision.accept || countMeaningfulChars(r.rawAsrText) >= 2,
      );
      const hasConfirmedSpeech =
        Boolean(winner?.decision.accept) ||
        (hasMeaningfulSpokenText && !heavySinging) ||
        speakerInfo.isMultiSpeaker;

      const detectedSoundTypes = buildFinalSoundTypes({
        scene,
        vocalsScene,
        stems,
        diag,
        inputSnrDb,
        bestSnrOutDb,
        isMusicScene,
        isMultiSpeaker: speakerInfo.isMultiSpeaker,
        hasConfirmedSpeech,
        hasBgmAsrTag: sawBgmAsrTag,
      });

      const combinedTranscript =
        winner && winner.decision.accept
          ? winner.candidateText || winner.rawAsrText
          : evalResults
              .map((r) => r.rawAsrText)
              .filter(Boolean)
              .join(" / ");

      const detectedSpeakerCount = detectedSoundTypes.includes("speech")
        ? Math.max(1, speakerInfo.speakerCount)
        : 0;

      return {
        isNeoCommand: winner?.decision.accept ?? false,
        wokeOnly: winner?.decision.wokeOnly ?? false,
        command: winner?.decision.accept ? winner.decision.command : "",
        rawTranscript: combinedTranscript,
        detectedSoundTypes,
        detectedSpeakerCount,
        separatedStreams,
        attentionStage: winner?.decision.stage ?? "no-wake",
        attentionReason: winner?.decision.reason ?? "未检测到有效唤醒词或设备控制指令",
        latencyMs: Math.round(performance.now() - t0),
        stageTimingsMs,
      };
    },
  };
}
