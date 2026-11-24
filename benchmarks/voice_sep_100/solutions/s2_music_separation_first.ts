// SPDX-License-Identifier: GPL-3.0-or-later
// Solution S2: Unconditional Neural Music Source Separation First (Spleeter 2-Stem) + Dual-Denoiser Vocal ASR
//
// Architecture:
// 1. Unconditionally run Spleeter 2-stem separation (vocals16k + accompaniment16k + vocalToAccompDb),
//    alongside CED audio scene analysis and DSP acoustic diagnostics on both stems.
// 2. Dual-stage vocal enhancement: DPDFNet4 on vocals16k to strip residual music bleed, singing harmonics,
//    and broadband noise; retain high-pass vocals16k (and high-pass raw pcm16k when vocalToAccompDb > 16 dB).
// 3. Silero VAD segmentation on enhanced vocals -> up to 4 longest/most-energetic vocal utterances.
// 4. Per-segment CAM++ speaker clustering (multi_speaker when pairwise similarity < 0.45),
//    dual-track vocal ASR (enhanced + raw vocals when SNR < 18 or no exact wake),
//    onset-aligned bilingual en-US head probe (0..1.15s & 0..0.65s), calibrated openWakeWord scoring
//    with strict third-person & Chinese greeting guardrails, singing-lyric guard, and DDSD attention gate.

import {
  cosineSimilarity,
  l2Normalize,
  resampleLinear,
} from "../../../src/agent/audioPcm.ts";
import type { LocalAsrOutput } from "../../../src/agent/localVoiceEngine.ts";
import type { WakeWordAcousticHit } from "../../../src/agent/openWakeWordEngine.ts";
import {
  evaluateVoiceAttention,
  extractCommandAfterAcousticWake,
  findWakeWordSpan,
  isWakeQueryText,
  looksLikeDirectDeviceCommand,
  matchEnglishHeadWakeWord,
  trimTrailingMusicLyrics,
  type AttentionDecision,
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
  slicePcmBySec,
  type TimedVadSegment,
} from "./common_utils.ts";

const SR = 16000;
const SPLEETER_EDGE_PAD_SAMPLES = Math.round(0.15 * SR); // 150ms zero-pad eliminates FP16 ISTFT boundary spikes
const MAX_VAD_SEGMENTS = 4;
const SPEAKER_SIM_THRESHOLD = 0.45;
const OWW_SEGMENT_THRESHOLD = 0.6;
const OWW_AMBIGUOUS_VETO_FLOOR = 0.48;

const AMBIGUOUS_ZH_PREFIX_RE = /^(?:你好|您好|你有|你又|你给|牛|妞|纽|钮)/;
const AMBIGUOUS_FUZZY_SURFACE_RE = /^(?:你好|您好|你有|你又|你给|你欧|你哦|牛|妞|纽|钮|new|near)$/i;
const HIGH_PRECISION_NEO_HOMOPHONE_RE =
  /^(?:(?:hey|hi|ok|嘿|喂|嗨)[\s,，]*)?(?:尼奥|尼欧|妮奥|妮欧|尼哦|妮哦|neil|neal|nio|niyo|neio|neow|newo|niel|你o|你0|2お|ニオ|ネオ|にお|ニ요|니오|네오)$/i;
const PLAIN_ZH_SHORT_GREETING_RE =
  /^(?:你好|您好|谢谢|好的|好吧|行吧|可以|嗯|哦|啊|是的|不是|没有|知道|明白|晚安|早安|再见|拜拜|算了|不用了|没事了)$/;
const FALSE_ZH_GREETING_EN_RE =
  /^(?:ni|nee|knee|need)\s+(?:hao|how|ha|have|you|gao)\b/i;
const GENERIC_CONVERSATION_LEAD_RE =
  /^(?:请|帮我|给我|麻烦|快|赶紧|顺便|现在|把|将)/;
const CLEAR_CONVERSATION_FOLLOWUP_RE =
  /(?:再(?:调|大|小|亮|暗|高|低|暖|冷|来一份|来一点|开|关)|稍微|还是|那就|把它|调大|调小|调亮|调暗|调高|调低|调到|调成|设为|设定|设置|改成|换成|大一点|小一点|高一点|低一点|亮一点|暗一点|暖一点|冷一点|关了吧|开了吗|关了吗|打开吧|暂停|继续|停止|静音|取消静音|下一首|上一首|换一首|切歌|出粮|几度|多少度|天气|几点|闹钟|提醒|全开|全关|全部关|全部开|全屋)/i;
const COMMAND_ACTION_RE =
  /(?:开|关|调|设|改|换|切|放|播|暂|停|继|查|看|问|亮|暗|大|小|高|低|暖|冷|静音|模式|场景|喂|出粮|turn|open|close|set|play|pause|stop|mute)/i;

interface SpeakerCluster {
  id: string;
  centroid: number[];
  count: number;
}

interface EnHeadProbeResult {
  wakeWord: string;
  matchedSurface: string;
  fuzzy: boolean;
  enText: string;
  durationMs: number;
}

interface SegmentEvalResult {
  index: number;
  seg: TimedVadSegment;
  speakerId: string;
  embedding: number[] | null;
  energyRatio: number;
  isSingingSegment: boolean;
  rawTranscript: string;
  altTranscript: string;
  normalizedTranscript: string;
  asrEvent: string;
  hasExplicitWake: boolean;
  recoveredByEnProbe: boolean;
  recoveredByOww: boolean;
  acousticWake: WakeWordAcousticHit | null;
  decision: AttentionDecision;
  priority: number;
}

function cleanPunct(text: string): string {
  return text
    .replace(/^[\s,，。．.、!！?？:：;；\-—~～"'“”‘’]+/, "")
    .replace(/[\s,，。．.、!！?？:：;；\-—~～"'“”‘’]+$/, "")
    .trim();
}

function isAmbiguousInterrogative(text: string, wakeWord: string): boolean {
  const trimmed = text.trim();
  if (!/^(?:你有|你又|你好|您好|你给)/.test(trimmed)) return false;
  if (!/[吗嘛么呢][。？！!?\s]*$/.test(trimmed)) return false;
  const after = extractCommandAfterAcousticWake(trimmed, wakeWord);
  return !isWakeQueryText(after);
}

function isFalseChineseGreetingEnProbe(enText: string, matchedSurface: string): boolean {
  const trimmed = enText.trim();
  if (FALSE_ZH_GREETING_EN_RE.test(trimmed)) return true;
  const surface = matchedSurface.toLowerCase().replace(/[^a-z]/g, "");
  return surface === "ni" || surface === "nee" || surface === "need" || surface === "knee";
}

/**
 * Locate actual vocal energy onset inside a VAD segment so bilingual en-US probes
 * and openWakeWord onset scoring align directly with the spoken start of the utterance.
 */
function findVocalOnsetSample(samples: Float32Array, maxSkipSec = 0.45): number {
  const frameLen = 320; // 20ms
  const frameCount = Math.floor(samples.length / frameLen);
  if (frameCount < 4) return 0;

  let peakRms = 0;
  const frameRms = new Float32Array(frameCount);
  for (let f = 0; f < frameCount; f += 1) {
    let sumSq = 0;
    const base = f * frameLen;
    for (let i = 0; i < frameLen; i += 1) {
      const x = samples[base + i]!;
      sumSq += x * x;
    }
    const rms = Math.sqrt(sumSq / frameLen);
    frameRms[f] = rms;
    if (rms > peakRms) peakRms = rms;
  }

  if (peakRms < 0.008) return 0;
  const thresh = Math.max(0.008, Math.min(0.025, peakRms * 0.1));
  const maxFrames = Math.min(frameCount, Math.floor((maxSkipSec * SR) / frameLen));
  const preRollSamples = Math.round(0.06 * SR);

  for (let f = 0; f < maxFrames; f += 1) {
    if (frameRms[f]! >= thresh) {
      return Math.max(0, f * frameLen - preRollSamples);
    }
  }
  return 0;
}

function sliceOnsetWindow(samples: Float32Array, onsetSample: number, windowSec: number): Float32Array {
  if (samples.length === 0) return samples;
  const start = Math.min(onsetSample, Math.max(0, samples.length - Math.round(0.35 * SR)));
  const end = Math.min(samples.length, start + Math.round(windowSec * SR));
  return samples.subarray(start, end);
}

/**
 * Assign a normalized CAM++ speaker embedding into online cosine-similarity clusters.
 */
function assignSpeakerCluster(clusters: SpeakerCluster[], normEmb: number[]): string {
  let bestIdx = -1;
  let bestSim = -1;
  for (let i = 0; i < clusters.length; i += 1) {
    const sim = cosineSimilarity(normEmb, clusters[i]!.centroid);
    if (sim > bestSim) {
      bestSim = sim;
      bestIdx = i;
    }
  }
  if (bestIdx >= 0 && bestSim >= SPEAKER_SIM_THRESHOLD) {
    const c = clusters[bestIdx]!;
    const merged = new Array<number>(c.centroid.length);
    for (let j = 0; j < c.centroid.length; j += 1) {
      merged[j] = c.centroid[j]! * c.count + (normEmb[j] ?? 0);
    }
    c.centroid = l2Normalize(merged);
    c.count += 1;
    return c.id;
  }
  const id = `spk_${clusters.length}`;
  clusters.push({ id, centroid: normEmb, count: 1 });
  return id;
}

/**
 * Score enhanced vs raw vocal ASR candidate for Spleeter-separated audio without
 * rewarding lyric/chatter bloat from un-denoised tracks.
 */
function scoreVocalAsrCandidate(
  cand: LocalAsrOutput,
  track: "enhanced" | "vocals_raw" | "clean_raw",
  options: {
    wakeWords: readonly string[];
    vocalToAccompDb: number;
    segSnrDb: number;
    acousticWake: WakeWordAcousticHit | null;
  },
): number {
  const text = cand.text.trim();
  if (!text) return -120;

  let score = Math.min(16, text.length * 0.8);
  const thirdPerson = isThirdPersonNeoMention(text);
  const span = findWakeWordSpan(text, options.wakeWords);

  if (span) {
    if (!span.fuzzy) {
      score += 105;
    } else if (
      AMBIGUOUS_FUZZY_SURFACE_RE.test(span.matchedSurface) &&
      !hasSmartHomeDomainIntent(span.afterText)
    ) {
      score += 18;
    } else {
      score += 68;
    }
    if (!thirdPerson && span.afterText) {
      if (looksLikeDirectDeviceCommand(span.afterText)) score += 42;
      if (hasSmartHomeDomainIntent(span.afterText)) score += 26;
    }
    if (span.beforeText.length <= 2) {
      score += 18;
    } else if (span.beforeText.length >= 8 && !thirdPerson) {
      // Penalize lyric or chatter leakage preceding the wake word
      score -= Math.min(18, (span.beforeText.length - 6) * 1.5);
    }
  } else {
    if (looksLikeDirectDeviceCommand(text)) score += 24;
    if (hasSmartHomeDomainIntent(text)) score += 18;
    if (options.acousticWake?.matched) {
      const postCmd = extractCommandAfterAcousticWake(text, options.acousticWake.wakeWord);
      if (postCmd && hasSmartHomeDomainIntent(postCmd)) {
        score += 32;
      }
    }
  }

  // Preserve third-person context cleanly if one track heard the full referential phrase
  if (thirdPerson) {
    score += 15;
  }

  if (cand.event.toUpperCase().includes("SPEECH")) {
    score += 8;
  }

  // Track-prior weighting tuned for Spleeter + DPDFNet4
  if (track === "clean_raw" && options.vocalToAccompDb > 16 && options.segSnrDb >= 18) {
    score += 10;
  } else if (track === "enhanced" && (options.vocalToAccompDb < 14 || options.segSnrDb < 16)) {
    score += 9;
  } else if (track === "vocals_raw" && options.vocalToAccompDb >= 12) {
    score += 4;
  }

  // Penalize Japanese/Korean garbled script leakage from SenseVoice auto mode
  const weirdMatches = text.match(/[\u3040-\u30ff\uac00-\ud7af]/g);
  if (weirdMatches && weirdMatches.length > 0) {
    score -= weirdMatches.length * 14;
  }

  return score;
}

const EXPLICIT_DEVICE_VERB_ANCHOR_RE =
  /(打开|关闭|关掉|关上|开启|开灯|关灯|熄灯|灭灯|调大|调小|调亮|调暗|调高|调低|调到|调成|把|将|设置|设定|设为|改成|换成|切换|播放|放一首|来一首|放歌|暂停|继续|停止|静音|取消静音|下一首|上一首|切歌|换歌|查看|查询|帮我|请把)/;

function extractCleanCommandAfterWake(rawText: string, wakeWord: string): string {
  const base = extractCommandAfterAcousticWake(rawText, wakeWord);
  if (!base || looksLikeDirectDeviceCommand(base)) return base;
  // Strip 1..3 stray non-command characters caused by mangled wake/singing onset before a clear device verb
  const m = EXPLICIT_DEVICE_VERB_ANCHOR_RE.exec(base);
  if (m && m.index > 0 && m.index <= 3) {
    const rest = cleanPunct(base.slice(m.index));
    if (rest.length >= 2 && hasSmartHomeDomainIntent(rest)) {
      return rest;
    }
  }
  return base;
}

/**
 * Run onset-aligned en-US head probes (0..1.15s and 0..0.65s for short/command segments,
 * plus an acoustic-peak-aligned window when OWW peaks later after a singing/bystander intro)
 * across enhanced vocals, raw vocals, and clean raw audio when available.
 */
async function runOnsetEnglishWakeProbe(
  pool: SharedVoiceModelPool,
  tracks: {
    enhanced: Float32Array;
    vocalsRaw: Float32Array;
    cleanRaw: Float32Array | null;
  },
  asciiWakes: readonly string[],
  options: {
    allowCommandGated: boolean;
    isShortClip: boolean;
    isAmbiguousZhPrefix: boolean;
    acousticWake: WakeWordAcousticHit | null;
  },
): Promise<EnHeadProbeResult | null> {
  if (asciiWakes.length === 0) return null;
  const engine = pool.localEngine;
  let totalMs = 0;

  const onsetEnh = findVocalOnsetSample(tracks.enhanced);
  const onsetRaw =
    tracks.vocalsRaw.length >= 1600 ? findVocalOnsetSample(tracks.vocalsRaw) : 0;
  const onsetClean =
    tracks.cleanRaw && tracks.cleanRaw.length >= 1600
      ? findVocalOnsetSample(tracks.cleanRaw)
      : 0;

  const probeOnce = async (
    slice: Float32Array,
    allowGated: boolean,
  ): Promise<EnHeadProbeResult | null> => {
    if (slice.length < 1600) return null;
    const enRes = await engine.transcribeLocal(slice, SR, "en-US");
    totalMs += enRes.durationMs;
    const enText = enRes.text.trim();
    if (!enText) return null;

    const hit = matchEnglishHeadWakeWord(enText, asciiWakes, {
      allowCommandGatedAliases: allowGated,
    });
    if (!hit) return null;
    if (isFalseChineseGreetingEnProbe(enText, hit.matchedSurface)) {
      return null;
    }
    if (options.isAmbiguousZhPrefix && hit.fuzzy && !allowGated) {
      return null;
    }
    return {
      wakeWord: hit.wakeWord,
      matchedSurface: hit.matchedSurface,
      fuzzy: hit.fuzzy,
      enText,
      durationMs: totalMs,
    };
  };

  // Pass 1: 0..1.15s onset-aligned window on enhanced vocals, then raw vocals (and clean raw)
  const w115Enh = sliceOnsetWindow(tracks.enhanced, onsetEnh, 1.15);
  const p1 = await probeOnce(w115Enh, options.allowCommandGated);
  if (p1) return p1;

  if (tracks.vocalsRaw.length >= 1600) {
    const w115Raw = sliceOnsetWindow(tracks.vocalsRaw, onsetRaw, 1.15);
    const p2 = await probeOnce(w115Raw, options.allowCommandGated);
    if (p2) return p2;
  }

  if (tracks.cleanRaw && tracks.cleanRaw.length >= 1600) {
    const w115Clean = sliceOnsetWindow(tracks.cleanRaw, onsetClean, 1.15);
    const pClean = await probeOnce(w115Clean, options.allowCommandGated);
    if (pClean) return pClean;
  }

  // Pass 2: tighter 0..0.65s onset window for fast-linked short commands (e.g. "Neo关灯")
  if (options.isShortClip || options.allowCommandGated) {
    const w65Enh = sliceOnsetWindow(tracks.enhanced, onsetEnh, 0.65);
    if (w65Enh.length >= 1600 && w65Enh.length < w115Enh.length - 1600) {
      const p3 = await probeOnce(w65Enh, options.allowCommandGated);
      if (p3) return p3;
    }
    if (tracks.vocalsRaw.length >= 1600) {
      const w65Raw = sliceOnsetWindow(tracks.vocalsRaw, onsetRaw, 0.65);
      if (w65Raw.length >= 1600) {
        const p4 = await probeOnce(w65Raw, options.allowCommandGated);
        if (p4) return p4;
      }
    }
    if (tracks.cleanRaw && tracks.cleanRaw.length >= 1600) {
      const w65Clean = sliceOnsetWindow(tracks.cleanRaw, onsetClean, 0.65);
      if (w65Clean.length >= 1600) {
        const p5 = await probeOnce(w65Clean, options.allowCommandGated);
        if (p5) return p5;
      }
    }
  }

  // Pass 3: OWW-peak-aligned window when a singing/bystander intro precedes a mid-segment wake word
  if (
    options.allowCommandGated &&
    options.acousticWake &&
    options.acousticWake.score >= 0.35 &&
    options.acousticWake.sampleOffset >= Math.round(0.85 * SR)
  ) {
    const peakEnd = Math.min(
      tracks.enhanced.length,
      onsetEnh + options.acousticWake.sampleOffset + Math.round(0.15 * SR),
    );
    const peakStart = Math.max(0, peakEnd - Math.round(0.95 * SR));
    if (peakEnd - peakStart >= 3200) {
      const pPeakEnh = await probeOnce(tracks.enhanced.subarray(peakStart, peakEnd), true);
      if (pPeakEnh) return pPeakEnh;
      if (tracks.vocalsRaw.length >= peakEnd) {
        const pPeakRaw = await probeOnce(tracks.vocalsRaw.subarray(peakStart, peakEnd), true);
        if (pPeakRaw) return pPeakRaw;
      }
    }
  }

  return null;
}

function scoreSegmentOww(
  pool: SharedVoiceModelPool,
  tracks: {
    enhanced: Float32Array;
    vocalsRaw: Float32Array;
    cleanRaw: Float32Array | null;
  },
  wakeWords: readonly string[],
): WakeWordAcousticHit | null {
  const engine = pool.localEngine;
  if (!engine.openWakeWord.isReady) return null;

  const segDurSec = tracks.enhanced.length / SR;
  const scanSec = Math.min(3.5, Math.max(2.0, segDurSec));
  const onsetEnh = findVocalOnsetSample(tracks.enhanced);
  const candTracks: Float32Array[] = [
    sliceOnsetWindow(tracks.enhanced, onsetEnh, scanSec),
  ];
  if (tracks.vocalsRaw.length >= 1600) {
    const onsetRaw = findVocalOnsetSample(tracks.vocalsRaw);
    candTracks.push(sliceOnsetWindow(tracks.vocalsRaw, onsetRaw, scanSec));
  }
  if (tracks.cleanRaw && tracks.cleanRaw.length >= 1600) {
    const onsetClean = findVocalOnsetSample(tracks.cleanRaw);
    candTracks.push(sliceOnsetWindow(tracks.cleanRaw, onsetClean, scanSec));
  }

  let best: WakeWordAcousticHit | null = null;
  for (const clip of candTracks) {
    if (clip.length < 1600) continue;
    const hit = engine.scoreWakeWordAudio(clip, wakeWords, {
      threshold: OWW_SEGMENT_THRESHOLD,
      headOnlySec: scanSec,
    });
    if (hit && (!best || hit.score > best.score)) {
      best = hit;
    }
    if (best && best.matched && best.score >= 0.72) {
      break;
    }
  }
  return best;
}

function computeDecisionPriority(params: {
  decision: AttentionDecision;
  hasExplicitWake: boolean;
  recoveredByEnProbe: boolean;
  recoveredByOww: boolean;
  acousticWake: WakeWordAcousticHit | null;
}): number {
  const { decision } = params;
  if (!decision.accept) {
    if (
      decision.stage === "echo" ||
      decision.stage === "exit" ||
      decision.stage === "pragmatic-reject"
    ) {
      return 30;
    }
    if (decision.stage === "acoustic-veto") return 20;
    return 10;
  }

  let p = 100;
  if (!decision.wokeOnly && decision.command.trim().length > 0) {
    p += 80;
    if (hasSmartHomeDomainIntent(decision.command)) {
      p += 35;
    }
  } else {
    p += 20;
  }

  if (params.hasExplicitWake) p += 45;
  else if (params.recoveredByEnProbe) p += 32;
  else if (params.recoveredByOww) p += 26;
  else if (decision.stage === "fast-followup") p += 22;

  p += decision.confidence * 15;
  p += (params.acousticWake?.score ?? 0) * 8;
  return p;
}

function makeRejectedDecision(
  stage: AttentionDecision["stage"],
  reason: string,
  inConversation: boolean,
): AttentionDecision {
  return {
    accept: false,
    wokeOnly: false,
    addressed: false,
    inConversation,
    confidence: 0.9,
    stage,
    reason,
    wakeWord: null,
    command: "",
    usedLlm: false,
    latencyMs: 0,
  };
}

function sanitizeAudioStem(samples: Float32Array): Float32Array {
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const v = samples[i]!;
    out[i] = Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0;
  }
  return out;
}

/**
 * Zero-pad pcm16k by 150ms on both ends before Spleeter 2-stem separation so
 * ISTFT window-normalization boundary spikes fall cleanly inside the padding,
 * then crop back to the exact clip span and recompute true vocalToAccompDb.
 */
function separateSpleeterEdgeSafe(
  pool: SharedVoiceModelPool,
  pcm16k: Float32Array,
): {
  vocals16k: Float32Array;
  accompaniment16k: Float32Array;
  vocalToAccompDb: number;
  durationMs: number;
} {
  const t0 = performance.now();
  const pad = SPLEETER_EDGE_PAD_SAMPLES;
  const padded = new Float32Array(pcm16k.length + pad * 2);
  padded.set(pcm16k, pad);

  const sep = pool.separateMusicStems(padded, "spleeter");
  if (!sep) {
    return {
      vocals16k: pcm16k,
      accompaniment16k: new Float32Array(pcm16k.length),
      vocalToAccompDb: 40,
      durationMs: Math.round(performance.now() - t0),
    };
  }

  const start = Math.min(pad, Math.max(0, sep.vocals16k.length - 1));
  const endVoc = Math.min(sep.vocals16k.length, start + pcm16k.length);
  const endAcc = Math.min(sep.accompaniment16k.length, start + pcm16k.length);
  const vocals16k = sanitizeAudioStem(sep.vocals16k.subarray(start, endVoc));
  const accompaniment16k = sanitizeAudioStem(sep.accompaniment16k.subarray(start, endAcc));

  const vocRms = Math.max(1e-6, computeRms(vocals16k));
  const accRms = Math.max(1e-6, computeRms(accompaniment16k));
  const vocalToAccompDb = Number((20 * Math.log10(vocRms / accRms)).toFixed(2));

  return {
    vocals16k,
    accompaniment16k,
    vocalToAccompDb,
    durationMs: sep.durationMs,
  };
}

export function createSolutionS2(pool: SharedVoiceModelPool): VoiceSolution {
  return {
    id: "s2_music_separation_first",
    name: "S2: Music-Separation-First (Spleeter 2-Stem + DPDFNet4 Vocal ASR)",
    description:
      "先无条件执行 Spleeter 2-Stem 人声/伴奏神经分离 + CED 场景与双轨声学诊断，再以 DPDFNet4 深度净化人声轨、Silero VAD 逐段切分，结合 CAM++ 说话人聚类、双轨人声 ASR、句首对齐英文唤醒探针与校准 openWakeWord 门控完成高保真指令识别。",

    async init(): Promise<void> {
      pool.ensureSpleeter();
      pool.ensureCedTagger();
      const warmupSilence = new Float32Array(Math.round(0.25 * SR));
      pool.localEngine.denoise(warmupSilence, SR, "dpdfnet");
      try {
        await pool.localEngine.transcribeLocal(warmupSilence, SR, "en-US");
      } catch {
        // ignore if model unavailable
      }
    },

    async process(input: SolutionRunInput): Promise<SolutionRunOutput> {
      const tTotal0 = performance.now();
      const engine = pool.localEngine;
      const wakeWords = input.wakeWords.length > 0 ? input.wakeWords : ["Neo"];
      const asciiWakes = wakeWords.filter((w) => /^[a-z][a-z0-9\s-]*$/i.test(w.trim()));
      const primaryWake = asciiWakes[0] ?? wakeWords[0] ?? "Neo";
      const pcm16k =
        input.sampleRate === SR
          ? input.pcm16k
          : resampleLinear(input.pcm16k, input.sampleRate, SR);
      const totalDurSec = Number((pcm16k.length / SR).toFixed(3));
      const runtimeCtx = buildRuntimeDialogContext(input.clip, wakeWords);

      if (pcm16k.length < 1600) {
        return {
          isNeoCommand: false,
          wokeOnly: false,
          command: "",
          rawTranscript: "",
          detectedSoundTypes: [],
          detectedSpeakerCount: 0,
          separatedStreams: [],
          attentionStage: "too-short",
          attentionReason: "音频时长不足 100ms，已跳过",
          latencyMs: Math.max(1, Math.round(performance.now() - tTotal0)),
        };
      }

      // =========================================================================
      // Stage 1: Unconditional Spleeter 2-Stem Music Separation + Scene Analysis
      // =========================================================================
      const sep = separateSpleeterEdgeSafe(pool, pcm16k);
      const spleeterMs = sep.durationMs;
      const { vocals16k, accompaniment16k, vocalToAccompDb } = sep;

      const scene = pool.analyzeAudioScene(pcm16k);
      const sceneMs = scene.durationMs;
      const accompDiag = computeAcousticDiagnostics(accompaniment16k);
      const vocalsDiag = computeAcousticDiagnostics(vocals16k);
      const clipSnrDb = estimateSnrDb(pcm16k, SR);

      const vocEnergy = vocalsDiag.rms * vocalsDiag.rms;
      const accEnergy = accompDiag.rms * accompDiag.rms;
      const totalStemEnergy = Math.max(1e-12, vocEnergy + accEnergy);
      const vocEnergyRatio = Number((vocEnergy / totalStemEnergy).toFixed(3));
      const accEnergyRatio = Number((accEnergy / totalStemEnergy).toFixed(3));

      // Combine Spleeter accompaniment physics + CED tags for BGM / Song / Noise classification
      const strongAccompStem = accompDiag.rms >= 0.014 && vocalToAccompDb < 14;
      const accompLooksMusical =
        strongAccompStem &&
        (scene.musicProb >= 0.05 ||
          scene.singingProb >= 0.04 ||
          (scene.noiseProb < 0.22 &&
            scene.crowdTvProb < 0.16 &&
            accompDiag.spectralFlatnessApprox < 0.56 &&
            accompDiag.lowBandRatio < 0.88 &&
            accompDiag.frameEnergyStdRatio >= 0.18));

      let hasBgm =
        scene.musicProb >= 0.14 || scene.singingProb >= 0.08 || accompLooksMusical;

      // Secondary CED pass on separated vocals when music is present and singing is uncertain
      let vocalSceneSingingProb = scene.singingProb;
      let vocalSceneSpeechProb = scene.speechProb;
      let extraSceneMs = 0;
      if (hasBgm && scene.singingProb < 0.065 && hasAudibleEnergy(vocals16k, 0.008)) {
        const vocalScene = pool.analyzeAudioScene(vocals16k);
        extraSceneMs = vocalScene.durationMs;
        vocalSceneSingingProb = Math.max(vocalSceneSingingProb, vocalScene.singingProb);
        vocalSceneSpeechProb = Math.max(vocalSceneSpeechProb, vocalScene.speechProb);
      }

      const hasSong =
        scene.singingProb >= 0.055 ||
        (hasBgm && vocalSceneSingingProb >= 0.065 && vocalsDiag.rms >= 0.012);

      const accompLooksNoisy =
        !hasBgm &&
        accompDiag.rms >= 0.011 &&
        vocalToAccompDb < 14 &&
        (scene.noiseProb >= 0.03 ||
          scene.crowdTvProb >= 0.10 ||
          clipSnrDb < 15 ||
          accompDiag.spectralFlatnessApprox >= 0.52 ||
          accompDiag.lowBandRatio >= 0.62 ||
          accompDiag.highBandRatio >= 0.24);

      const hasNoise =
        (scene.noiseProb >= 0.08 && scene.musicProb < 0.35 && !hasSong) ||
        (scene.crowdTvProb >= 0.14 && scene.musicProb < 0.25 && !hasSong) ||
        accompLooksNoisy ||
        (!hasBgm && !hasSong && clipSnrDb < 11.5);

      const separatedStreams: SeparatedStreamSummary[] = [];
      if (hasBgm || hasNoise || accompDiag.rms >= 0.01) {
        separatedStreams.push({
          streamId: "spleeter_accompaniment",
          kind: hasBgm ? "bgm_accompaniment" : "noise",
          startSec: 0,
          endSec: totalDurSec,
          energyRatio: accEnergyRatio,
        });
      }

      // Fast-path clean rejection when Spleeter yields virtually silent vocals (pure instrumental BGM / pure noise)
      if (vocalsDiag.rms < 0.0075 && vocalToAccompDb < -14 && vocalSceneSpeechProb < 0.18) {
        const soundTypes: SoundTypeLabel[] = [];
        if (hasSong) soundTypes.push("song");
        if (hasBgm) soundTypes.push("bgm");
        if (hasNoise || soundTypes.length === 0) soundTypes.push("noise");
        return {
          isNeoCommand: false,
          wokeOnly: false,
          command: "",
          rawTranscript: "",
          detectedSoundTypes: [...new Set(soundTypes)],
          detectedSpeakerCount: 0,
          separatedStreams,
          attentionStage: "vad-skip",
          attentionReason: hasBgm
            ? `Spleeter 分离人声能量极弱 (${vocalToAccompDb} dB)，判定为纯伴奏/器乐 BGM`
            : `Spleeter 分离人声能量极弱 (${vocalToAccompDb} dB)，判定为纯环境噪声`,
          latencyMs: Math.max(1, Math.round(performance.now() - tTotal0)),
          stageTimingsMs: {
            spleeterMs,
            sceneMs: sceneMs + extraSceneMs,
            denoiseMs: 0,
            vadMs: 0,
          },
        };
      }

      // =========================================================================
      // Stage 2: Dual-Stage Vocal Enhancement (DPDFNet4 + HP Vocals + Clean Raw)
      // =========================================================================
      const denVocals = engine.denoise(vocals16k, SR, "dpdfnet");
      const enhancedVocals = denVocals.samples;
      const hpVocals = applyHighPassFilter(vocals16k, SR, 85);
      const hpCleanRaw = vocalToAccompDb > 16 ? applyHighPassFilter(pcm16k, SR, 85) : null;

      const tVad0 = performance.now();
      let vadSegments = extractTimedVadSegments(engine, enhancedVocals, {
        threshold: 0.36,
        minSilenceDuration: 0.25,
        minSpeechDuration: 0.14,
        padSec: 0.12,
        mergeGapSec: 0.08,
      });

      // Conservative retry only when CED strongly indicates speech & audible energy survived DPDFNet4
      if (
        vadSegments.length === 0 &&
        vocalSceneSpeechProb >= 0.35 &&
        hasAudibleEnergy(enhancedVocals, 0.008)
      ) {
        vadSegments = extractTimedVadSegments(engine, enhancedVocals, {
          threshold: 0.26,
          minSilenceDuration: 0.25,
          minSpeechDuration: 0.12,
          padSec: 0.12,
          mergeGapSec: 0.08,
        });
      }
      const vadMs = Math.round(performance.now() - tVad0);

      // Pure instrumental BGM or pure ambient noise -> immediate clean rejection
      if (vadSegments.length === 0) {
        const soundTypes: SoundTypeLabel[] = [];
        if (hasSong) soundTypes.push("song");
        if (hasBgm) soundTypes.push("bgm");
        if (hasNoise || soundTypes.length === 0) soundTypes.push("noise");
        if (hasSong && vocalsDiag.rms >= 0.01) {
          separatedStreams.push({
            streamId: "spleeter_vocals",
            kind: "song_vocals",
            startSec: 0,
            endSec: totalDurSec,
            energyRatio: vocEnergyRatio,
          });
        }

        return {
          isNeoCommand: false,
          wokeOnly: false,
          command: "",
          rawTranscript: "",
          detectedSoundTypes: [...new Set(soundTypes)],
          detectedSpeakerCount: 0,
          separatedStreams,
          attentionStage: "vad-skip",
          attentionReason: hasBgm
            ? "Spleeter 人声轨经 DPDFNet4 净化后未检测到有效口语语音（纯伴奏/音乐）"
            : "Spleeter 人声轨经 DPDFNet4 净化后未检测到有效语音（纯环境噪声）",
          latencyMs: Math.max(1, Math.round(performance.now() - tTotal0)),
          stageTimingsMs: {
            spleeterMs,
            sceneMs: sceneMs + extraSceneMs,
            denoiseMs: denVocals.durationMs,
            vadMs,
          },
        };
      }

      // Select up to 4 longest/most-energetic VAD segments, then keep chronological order
      let selectedSegments = vadSegments;
      if (vadSegments.length > MAX_VAD_SEGMENTS) {
        selectedSegments = [...vadSegments]
          .sort((a, b) => {
            const scoreA = (a.endSec - a.startSec) * Math.max(0.01, computeRms(a.samples));
            const scoreB = (b.endSec - b.startSec) * Math.max(0.01, computeRms(b.samples));
            return scoreB - scoreA;
          })
          .slice(0, MAX_VAD_SEGMENTS)
          .sort((a, b) => a.startSec - b.startSec);
      }

      // =========================================================================
      // Stage 3: Per-Segment Speaker Clustering, Dual-Track Vocal ASR,
      //          Onset-Aligned Bilingual Recovery, OWW & DDSD Attention Gate
      // =========================================================================
      let speakerMs = 0;
      let asrMs = 0;
      let owwMs = 0;
      let attentionMs = 0;

      const speakerClusters: SpeakerCluster[] = [];
      const speechEmbeddings: number[][] = [];
      const segEvals: SegmentEvalResult[] = [];
      let sawAsrBgmEvent = false;
      let intraSegmentSpeakerChange = false;

      const segRmsList = selectedSegments.map((s) => computeRms(s.samples));
      const maxSegRms = Math.max(0.001, ...segRmsList);
      const totalSegEnergy = Math.max(
        1e-12,
        selectedSegments.reduce((acc, s, idx) => {
          const r = segRmsList[idx]!;
          return acc + r * r * s.samples.length;
        }, 0),
      );

      for (let i = 0; i < selectedSegments.length; i += 1) {
        const seg = selectedSegments[i]!;
        const enhancedSeg = seg.samples;
        const vocalsRawSeg = slicePcmBySec(hpVocals, seg.startSec, seg.endSec, 0);
        const cleanRawSeg = hpCleanRaw
          ? slicePcmBySec(hpCleanRaw, seg.startSec, seg.endSec, 0)
          : null;
        const segDurSec = enhancedSeg.length / SR;
        const segRms = segRmsList[i]!;
        const segEnergyRatio = Number(
          (
            vocEnergyRatio *
            ((segRms * segRms * enhancedSeg.length) / totalSegEnergy)
          ).toFixed(3),
        );

        // 3A. CAM++ speaker embedding for foreground vocal segments (exclude ultra-faint residual bleed)
        let speakerId = "spk_0";
        let segEmb: number[] | null = null;
        const minForegroundRms = Math.max(0.014, maxSegRms * 0.22);
        if (enhancedSeg.length >= 6400 && segRms >= minForegroundRms) {
          const tSpk0 = performance.now();
          const embOut = engine.extractSpeakerEmbedding(enhancedSeg, SR);
          speakerMs += embOut.durationMs || Math.round(performance.now() - tSpk0);
          if (embOut.engine === "3dspeaker-campplus" && embOut.embedding.length > 0) {
            segEmb = l2Normalize(embOut.embedding);
          }

          // Check for intra-segment speaker switch on long continuous non-singing segments
          if (
            selectedSegments.length === 1 &&
            segDurSec >= 2.8 &&
            !hasSong &&
            segEmb
          ) {
            const winSamples = Math.min(Math.round(1.2 * SR), Math.floor(enhancedSeg.length * 0.4));
            if (winSamples >= 6400) {
              const headSlice = enhancedSeg.subarray(0, winSamples);
              const tailSlice = enhancedSeg.subarray(enhancedSeg.length - winSamples);
              if (computeRms(headSlice) >= 0.012 && computeRms(tailSlice) >= 0.012) {
                const eHead = engine.extractSpeakerEmbedding(headSlice, SR);
                const eTail = engine.extractSpeakerEmbedding(tailSlice, SR);
                speakerMs += eHead.durationMs + eTail.durationMs;
                if (
                  eHead.engine === "3dspeaker-campplus" &&
                  eTail.engine === "3dspeaker-campplus"
                ) {
                  const splitSim = cosineSimilarity(
                    l2Normalize(eHead.embedding),
                    l2Normalize(eTail.embedding),
                  );
                  if (splitSim < 0.34) {
                    intraSegmentSpeakerChange = true;
                  }
                }
              }
            }
          }
        }

        // 3B. Calibrated openWakeWord scoring on segment onset
        const tOww0 = performance.now();
        const acousticWake = scoreSegmentOww(
          pool,
          { enhanced: enhancedSeg, vocalsRaw: vocalsRawSeg, cleanRaw: cleanRawSeg },
          wakeWords,
        );
        owwMs += Math.round(performance.now() - tOww0);

        // 3C. Dual-Track Vocal ASR (enhanced vocals first; raw vocals / clean raw if SNR < 18 or no exact wake)
        const segSnrDb = estimateSnrDb(
          vocalsRawSeg.length >= 1600 ? vocalsRawSeg : enhancedSeg,
          SR,
        );
        const denAsr = await engine.transcribeLocal(enhancedSeg, SR, "zh-CN");
        asrMs += denAsr.durationMs;
        const denSpan = findWakeWordSpan(denAsr.text, wakeWords);
        const denHasExactWake = Boolean(denSpan && !denSpan.fuzzy);

        let bestAsr: LocalAsrOutput = denAsr;
        let altTranscript = "";
        const needRawDecode =
          segSnrDb < 18 ||
          clipSnrDb < 18 ||
          !denHasExactWake ||
          denAsr.text.trim().length === 0;

        if (needRawDecode) {
          const secondaryTrack =
            cleanRawSeg && cleanRawSeg.length >= 1600
              ? cleanRawSeg
              : vocalsRawSeg.length >= 1600
                ? vocalsRawSeg
                : null;
          const secondaryKind: "clean_raw" | "vocals_raw" =
            cleanRawSeg && cleanRawSeg.length >= 1600 ? "clean_raw" : "vocals_raw";

          if (secondaryTrack) {
            const rawAsr = await engine.transcribeLocal(secondaryTrack, SR, "zh-CN");
            asrMs += rawAsr.durationMs;
            const denScore = scoreVocalAsrCandidate(denAsr, "enhanced", {
              wakeWords,
              vocalToAccompDb,
              segSnrDb,
              acousticWake,
            });
            const rawScore = scoreVocalAsrCandidate(rawAsr, secondaryKind, {
              wakeWords,
              vocalToAccompDb,
              segSnrDb,
              acousticWake,
            });
            if (rawScore > denScore) {
              bestAsr = rawAsr;
              altTranscript = denAsr.text.trim();
            } else {
              bestAsr = denAsr;
              altTranscript = rawAsr.text.trim();
            }

            // On moderate music + low SNR, if secondary was clean_raw (not possible) skip;
            // if vocalToAccompDb > 16 and still no exact wake, vocalsRaw wasn't tried yet - usually unnecessary
          }
        }

        if (bestAsr.event.toUpperCase().includes("BGM")) {
          sawAsrBgmEvent = true;
        }

        const rawText = bestAsr.text.trim();
        let workingText = rawText;
        const thirdPersonContext =
          isThirdPersonNeoMention(rawText) ||
          (altTranscript.length > 0 && isThirdPersonNeoMention(altTranscript));

        const initialSpan = findWakeWordSpan(workingText, wakeWords);
        const hasExplicitWake = Boolean(initialSpan && !initialSpan.fuzzy);
        const meaningfulChars = cleanPunct(workingText);
        const hasWeirdScript = /[\u3040-\u30ff\uac00-\ud7af]/.test(workingText);
        const ambiguousZhPrefix = AMBIGUOUS_ZH_PREFIX_RE.test(workingText);
        const ambiguousInterrogative = isAmbiguousInterrogative(workingText, primaryWake);

        const extractedAfterWake = extractCleanCommandAfterWake(workingText, primaryWake);
        const extractedHasSmartHome =
          extractedAfterWake.length >= 2 &&
          hasSmartHomeDomainIntent(extractedAfterWake) &&
          (looksLikeDirectDeviceCommand(extractedAfterWake) ||
            COMMAND_ACTION_RE.test(extractedAfterWake));

        const isShortClip = segDurSec <= 1.85;
        const isShortOrGarbled =
          (segDurSec <= 1.75 && meaningfulChars.length <= 5) ||
          hasWeirdScript ||
          (segDurSec <= 1.35 && meaningfulChars.length === 0);

        let recoveredByEnProbe = false;
        let recoveredByOww = false;

        // 3D. Onset-Aligned Bilingual en-US Head Probe (NEVER on third-person mentions or interrogatives)
        if (
          !hasExplicitWake &&
          !thirdPersonContext &&
          !ambiguousInterrogative &&
          asciiWakes.length > 0 &&
          (isShortOrGarbled || extractedHasSmartHome)
        ) {
          const probeRes = await runOnsetEnglishWakeProbe(
            pool,
            { enhanced: enhancedSeg, vocalsRaw: vocalsRawSeg, cleanRaw: cleanRawSeg },
            asciiWakes,
            {
              allowCommandGated: extractedHasSmartHome,
              isShortClip,
              isAmbiguousZhPrefix: ambiguousZhPrefix,
              acousticWake,
            },
          );
          if (probeRes) {
            asrMs += probeRes.durationMs;
            const postCmd = extractCleanCommandAfterWake(workingText, probeRes.wakeWord);
            const postHasSmartHome = postCmd.length >= 2 && hasSmartHomeDomainIntent(postCmd);
            if (postCmd && !isWakeQueryText(postCmd)) {
              // Guard: never promote "你好/你有 + non-smart-home" (e.g. "你好，帮我递水")
              if (!ambiguousZhPrefix || postHasSmartHome) {
                workingText = `${probeRes.wakeWord}，${postCmd}`;
                recoveredByEnProbe = true;
              }
            } else if (
              isShortOrGarbled &&
              (!ambiguousZhPrefix || !probeRes.fuzzy) &&
              (!PLAIN_ZH_SHORT_GREETING_RE.test(meaningfulChars) || !probeRes.fuzzy)
            ) {
              workingText = probeRes.wakeWord;
              recoveredByEnProbe = true;
            }
          }
        }

        // 3E. Calibrated openWakeWord Recovery (strictly guarded against third-person & Chinese greetings)
        const spanAfterEn = findWakeWordSpan(workingText, wakeWords);
        const explicitAfterEn = Boolean(spanAfterEn && !spanAfterEn.fuzzy);
        if (
          !explicitAfterEn &&
          !thirdPersonContext &&
          !ambiguousInterrogative &&
          acousticWake?.matched
        ) {
          const postCmd = extractCleanCommandAfterWake(workingText, acousticWake.wakeWord);
          const postHasSmartHome =
            postCmd.length >= 2 &&
            hasSmartHomeDomainIntent(postCmd) &&
            (looksLikeDirectDeviceCommand(postCmd) || COMMAND_ACTION_RE.test(postCmd));

          if (postHasSmartHome) {
            workingText = `${acousticWake.wakeWord}，${postCmd}`;
            recoveredByOww = true;
          } else if (
            !ambiguousZhPrefix &&
            !PLAIN_ZH_SHORT_GREETING_RE.test(meaningfulChars) &&
            isShortOrGarbled &&
            (!postCmd || isWakeQueryText(postCmd)) &&
            acousticWake.score >= 0.62
          ) {
            workingText = acousticWake.wakeWord;
            recoveredByOww = true;
          }
        }

        // 3F. High-precision non-ambiguous Neo transliteration promotion (e.g. "尼奥，打开客厅灯")
        const preGateSpan = findWakeWordSpan(workingText, wakeWords);
        if (
          preGateSpan &&
          preGateSpan.fuzzy &&
          !thirdPersonContext &&
          !ambiguousInterrogative &&
          HIGH_PRECISION_NEO_HOMOPHONE_RE.test(preGateSpan.matchedSurface) &&
          preGateSpan.beforeText.length <= 2 &&
          preGateSpan.afterText.length >= 2 &&
          hasSmartHomeDomainIntent(preGateSpan.afterText) &&
          looksLikeDirectDeviceCommand(preGateSpan.afterText)
        ) {
          workingText = `${preGateSpan.wakeWord}，${preGateSpan.afterText}`;
        }

        // 3G. Singing-lyric guard (especially critical in conversation mode)
        const finalPreSpan = findWakeWordSpan(workingText, wakeWords);
        const hasFinalExplicitWake = Boolean(finalPreSpan && !finalPreSpan.fuzzy);
        const hasDomainIntent =
          hasSmartHomeDomainIntent(workingText) ||
          (finalPreSpan ? hasSmartHomeDomainIntent(finalPreSpan.afterText) : false);
        const singingDominant =
          (scene.singingProb >= 0.12 && scene.speechProb < 0.25) ||
          (vocalSceneSingingProb >= 0.2 && scene.speechProb < 0.22);

        const isSingingSegment =
          singingDominant && !hasDomainIntent && !hasFinalExplicitWake;

        // Add valid spoken segments to speaker clustering (exclude pure singing segments)
        if (segEmb && !isSingingSegment) {
          speakerId = assignSpeakerCluster(speakerClusters, segEmb);
          speechEmbeddings.push(segEmb);
        }

        // 3H. Voice Attention Gate with strict fuzzy-alias & singing/sidetalk guards
        let decision: AttentionDecision;
        const tAtt0 = performance.now();

        if (isSingingSegment) {
          decision = makeRejectedDecision(
            "acoustic",
            `检测到纯歌声歌词片段 (singing=${scene.singingProb.toFixed(2)}, speech=${scene.speechProb.toFixed(2)})，已拦截`,
            runtimeCtx.inConversation,
          );
        } else if (
          finalPreSpan &&
          finalPreSpan.fuzzy &&
          AMBIGUOUS_FUZZY_SURFACE_RE.test(finalPreSpan.matchedSurface) &&
          (!hasSmartHomeDomainIntent(finalPreSpan.afterText) || ambiguousInterrogative)
        ) {
          decision = makeRejectedDecision(
            "pragmatic-reject",
            `模糊近音前缀「${finalPreSpan.matchedSurface}」缺乏明确智能家居控制语义，已拦截`,
            runtimeCtx.inConversation,
          );
        } else {
          // Tighten OWW confirmation floor when the only wake match is an ambiguous Chinese prefix
          const gatedAcousticWake =
            finalPreSpan &&
            finalPreSpan.fuzzy &&
            AMBIGUOUS_FUZZY_SURFACE_RE.test(finalPreSpan.matchedSurface)
              ? acousticWake && acousticWake.score >= OWW_AMBIGUOUS_VETO_FLOOR
                ? acousticWake
                : null
              : acousticWake;

          const effectiveAcousticEvent =
            bestAsr.event || (hasBgm || hasSong ? "<|BGM|>" : undefined);

          decision = await evaluateVoiceAttention({
            ...runtimeCtx,
            rawText: workingText,
            altText: altTranscript || undefined,
            acousticEvent: effectiveAcousticEvent,
            acousticWake: gatedAcousticWake,
            owwActiveForWord: engine.openWakeWord.isReady,
          });

          // Extra conversation-mode sidetalk guard for generic leading verbs without smart-home intent
          if (
            decision.accept &&
            !decision.wokeOnly &&
            runtimeCtx.inConversation &&
            !finalPreSpan
          ) {
            const cmd = decision.command.trim();
            if (
              GENERIC_CONVERSATION_LEAD_RE.test(cmd) &&
              !hasSmartHomeDomainIntent(cmd) &&
              !CLEAR_CONVERSATION_FOLLOWUP_RE.test(cmd)
            ) {
              decision = makeRejectedDecision(
                "pragmatic-reject",
                "连续对话窗口中检测到非智能家居日常家务/旁白，已拦截",
                true,
              );
            }
          }

          // Trim trailing lyric or bystander leakage from accepted commands
          if (decision.accept && !decision.wokeOnly && decision.command) {
            const trimmed =
              hasBgm || hasSong || selectedSegments.length > 1 || intraSegmentSpeakerChange
                ? trimTrailingMusicLyrics(decision.command)
                : decision.command.trim();
            if (trimmed) {
              decision = { ...decision, command: trimmed };
            }
          }
        }

        attentionMs += decision.latencyMs || Math.round(performance.now() - tAtt0);

        const priority = computeDecisionPriority({
          decision,
          hasExplicitWake: hasFinalExplicitWake,
          recoveredByEnProbe,
          recoveredByOww,
          acousticWake,
        });

        segEvals.push({
          index: i,
          seg,
          speakerId,
          embedding: segEmb,
          energyRatio: segEnergyRatio,
          isSingingSegment,
          rawTranscript: rawText,
          altTranscript,
          normalizedTranscript: workingText,
          asrEvent: bestAsr.event,
          hasExplicitWake: hasFinalExplicitWake,
          recoveredByEnProbe,
          recoveredByOww,
          acousticWake,
          decision,
          priority,
        });

        separatedStreams.push({
          streamId: `vocal_seg_${i}`,
          kind: isSingingSegment ? "song_vocals" : "speech",
          speakerId: isSingingSegment ? undefined : speakerId,
          startSec: seg.startSec,
          endSec: seg.endSec,
          energyRatio: segEnergyRatio,
          transcript: rawText,
        });
      }

      // =========================================================================
      // Stage 4: Cross-Segment Split-Wake Recombination ("Neo ... [pause] ... 关灯")
      // =========================================================================
      for (let i = 0; i < segEvals.length - 1; i += 1) {
        const cur = segEvals[i]!;
        const next = segEvals[i + 1]!;
        if (!cur.decision.accept || !cur.decision.wokeOnly) continue;
        if (next.decision.accept) continue;
        const gapSec = next.seg.startSec - cur.seg.endSec;
        if (gapSec < -0.1 || gapSec > 1.25) continue;

        const sameSpeaker =
          !cur.embedding ||
          !next.embedding ||
          cosineSimilarity(cur.embedding, next.embedding) >= SPEAKER_SIM_THRESHOLD;
        const nextClean = cleanPunct(next.rawTranscript);
        if (
          sameSpeaker &&
          nextClean.length >= 2 &&
          !isThirdPersonNeoMention(nextClean) &&
          hasSmartHomeDomainIntent(nextClean) &&
          looksLikeDirectDeviceCommand(nextClean)
        ) {
          const combinedText = `${cur.decision.wakeWord ?? primaryWake}，${nextClean}`;
          const combinedDecision = await evaluateVoiceAttention({
            ...runtimeCtx,
            rawText: combinedText,
            acousticEvent: hasBgm || hasSong ? "<|BGM|>" : undefined,
            acousticWake: cur.acousticWake,
            owwActiveForWord: engine.openWakeWord.isReady,
          });
          attentionMs += combinedDecision.latencyMs;
          if (combinedDecision.accept && !combinedDecision.wokeOnly) {
            cur.decision = {
              ...combinedDecision,
              command: trimTrailingMusicLyrics(combinedDecision.command),
            };
            cur.normalizedTranscript = combinedText;
            cur.priority = computeDecisionPriority({
              decision: cur.decision,
              hasExplicitWake: cur.hasExplicitWake,
              recoveredByEnProbe: cur.recoveredByEnProbe,
              recoveredByOww: cur.recoveredByOww,
              acousticWake: cur.acousticWake,
            });
          }
        }
      }

      // =========================================================================
      // Stage 5: Final Decision Selection & Parallel Sound-Type Synthesis
      // =========================================================================
      const acceptedEvals = segEvals.filter((e) => e.decision.accept);
      let chosen: SegmentEvalResult;
      if (acceptedEvals.length > 0) {
        acceptedEvals.sort((a, b) => b.priority - a.priority);
        chosen = acceptedEvals[0]!;
      } else {
        const sortedRejected = [...segEvals].sort((a, b) => {
          if (b.priority !== a.priority) return b.priority - a.priority;
          return b.rawTranscript.length - a.rawTranscript.length;
        });
        chosen = sortedRejected[0]!;
      }

      // Pairwise CAM++ check for multi-speaker count
      let hasDistinctPair = false;
      for (let a = 0; a < speechEmbeddings.length && !hasDistinctPair; a += 1) {
        for (let b = a + 1; b < speechEmbeddings.length; b += 1) {
          if (cosineSimilarity(speechEmbeddings[a]!, speechEmbeddings[b]!) < SPEAKER_SIM_THRESHOLD) {
            hasDistinctPair = true;
            break;
          }
        }
      }

      const hasAnySpokenSeg = segEvals.some(
        (e) => !e.isSingingSegment && (e.rawTranscript.length > 0 || e.decision.accept),
      );
      const isMultiSpeaker =
        speakerClusters.length >= 2 ||
        hasDistinctPair ||
        intraSegmentSpeakerChange ||
        (scene.crowdTvProb >= 0.24 && hasAnySpokenSeg && !hasSong && scene.musicProb < 0.25);

      const detectedSpeakerCount = !hasAnySpokenSeg
        ? 0
        : Math.max(isMultiSpeaker ? 2 : 1, speakerClusters.length);

      if (sawAsrBgmEvent && !hasNoise) {
        hasBgm = true;
      }

      const detectedSoundTypes: SoundTypeLabel[] = [];
      if (
        chosen.decision.accept ||
        hasAnySpokenSeg ||
        (scene.speechProb >= 0.2 && !segEvals.every((e) => e.isSingingSegment))
      ) {
        detectedSoundTypes.push("speech");
      }
      if (hasSong) detectedSoundTypes.push("song");
      if (hasBgm) detectedSoundTypes.push("bgm");
      if (hasNoise) detectedSoundTypes.push("noise");
      if (isMultiSpeaker) detectedSoundTypes.push("multi_speaker");

      const diagnosticRaw =
        chosen.rawTranscript ||
        segEvals.map((e) => e.rawTranscript).filter(Boolean).join(" / ");

      return {
        isNeoCommand: chosen.decision.accept,
        wokeOnly: chosen.decision.wokeOnly,
        command: chosen.decision.accept ? chosen.decision.command : "",
        rawTranscript: diagnosticRaw,
        detectedSoundTypes: [...new Set(detectedSoundTypes)],
        detectedSpeakerCount,
        separatedStreams,
        attentionStage: chosen.decision.stage,
        attentionReason: chosen.decision.reason,
        latencyMs: Math.max(1, Math.round(performance.now() - tTotal0)),
        stageTimingsMs: {
          spleeterMs,
          sceneMs: sceneMs + extraSceneMs,
          denoiseMs: denVocals.durationMs,
          vadMs,
          speakerMs,
          owwMs,
          asrMs,
          attentionMs,
        },
      };
    },
  };
}
