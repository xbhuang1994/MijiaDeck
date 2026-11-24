// SPDX-License-Identifier: GPL-3.0-or-later
// Solution S5: Ultra-Fast Multi-Stream DSP/Neural Front-End + CAM++ Speaker-Boundary Splitter
// + Sliding Bilingual Wake & Strict Acoustic-Semantic Verifier
// (Zero heavy Spleeter / UVR / VoxLock / Pyannote models for lowest CPU latency)

import { cosineSimilarity, l2Normalize } from "../../../src/agent/audioPcm.ts";
import type { LocalAsrOutput, LocalVoiceEngine } from "../../../src/agent/localVoiceEngine.ts";
import type { WakeWordAcousticHit } from "../../../src/agent/openWakeWordEngine.ts";
import {
  EXPLICIT_EXIT_RE,
  computeEchoOverlap,
  evaluateVoiceAttention,
  extractCommandAfterAcousticWake,
  findWakeWordSpan,
  isWakeQueryText,
  looksLikeDirectDeviceCommand,
  matchEnglishHeadWakeWord,
  trimTrailingMusicLyrics,
  type AttentionDecision,
} from "../../../src/agent/voiceAttentionGate.ts";
import type { SoundTypeLabel } from "../generate_dataset.ts";
import type {
  SeparatedStreamSummary,
  SolutionRunInput,
  SolutionRunOutput,
  VoiceSolution,
} from "../evaluator.ts";
import { computeAcousticDiagnostics, type SharedVoiceModelPool } from "../shared_models.ts";
import {
  applyHighPassFilter,
  applySpeechBandpass,
  buildRuntimeDialogContext,
  computeRms,
  estimateSnrDb,
  extractTimedVadSegments,
  hasAudibleEnergy,
  hasSmartHomeDomainIntent,
  isThirdPersonNeoMention,
  type TimedVadSegment,
} from "./common_utils.ts";

const SR = 16000;

const NOISY_ALIAS_SURFACES = new Set<string>([
  "你好",
  "您好",
  "你有",
  "你又",
  "你给",
  "你欧",
  "你哦",
  "牛",
  "妞",
  "钮",
  "纽",
  "里奥",
  "利奥",
  "米奥",
  "new",
  "near",
  "leo",
  "mio",
  "nero",
  "rio",
  "hey ne",
  "hei ne",
]);

const AMBIGUOUS_ZH_PREFIX_RE = /^(?:你好|您好|你有|你又|你给)/;
const QUESTION_TAIL_RE = /[吗嘛么呢][。？！!?\s]*$/;
const WEIRD_SCRIPT_RE = /[\u3040-\u30ff\uac00-\ud7af]/;
const PUNCT_STRIP_RE = /[\s,，。．.、!！?？:：;；\-—~～"'“”‘’()（）[\]【】]+/g;

// Normal Chinese short phrases that must never be mistaken for standalone wake residue
const NON_WAKE_SHORT_ZH_RE =
  /^(?:你好|您好|谢谢|感谢|好的|好吧|行吧|可以|不行|不要|没事|再见|拜拜|晚安|早安|是的|对的|没有|知道|明白|吃饭|喝水|算了|不用了|不是|什么|怎么|为什么)$/i;

// Short phonetic residues compatible with standalone "Neo" / "Hey Neo" in SenseVoice auto/zh mode
const WAKE_RESIDUE_ZH_RE =
  /^(?:[你呢尼妮牛妞钮纽哦喔噢啊嗯20oO]+|尼奥|尼欧|妮奥|妮欧|尼哦|呢哦|你o|你0|neo|neil|neal|nio|niyo|neio|hey\s*neo|hi\s*neo|在吗|你在吗|在不在)$/i;

// Household human-directed chatter keywords (non-smart-home)
const HOUSEHOLD_CHATTING_RE =
  /(?:喝水|递水|倒水|杯水|杯子|晚饭|午饭|早饭|吃饭|做饭|端菜|洗碗|筷子|桌子|快递|外卖|垃圾|衣服|鞋子|作业|出门|出去|上班|下班|回家吗|睡觉了吗|买菜|超市|朋友|同事|孩子|妈妈|爸爸|老婆|老公|递过来|拿一下|递一下|拿双|拿个|帮我递|帮我拿)/;

// Concrete device adjustment / playback continuation terms valid in conversation mode
const CONVERSATION_CONTROL_RE =
  /(?:调大|调小|调高|调低|调亮|调暗|调到|调成|大一点|小一点|高一点|低一点|亮一点|暗一点|暖一点|冷一点|关了吧|关掉|关闭|打开|开启|暂停|继续|停止|静音|取消静音|下一首|上一首|换一首|切歌|再来一份|出粮|几度|多少度|百分之|\d+\s*(?:度|%|分|份)|天气|几点|时间|闹钟|定时|提醒|查一下|看看)/;

// Same-speaker multi-clause command continuation
const CONTINUATION_CLAUSE_RE =
  /^(?:然后|并且|再|并|顺便|还有|以及|把|亮度|色温|音量|温度|调到|调成|调大|调小|调高|调低|亮一点|暗一点|大一点|小一点|高一点|低一点|暖一点|冷一点|关了|关掉|打开)/;

// Assistant-style TTS echo phrases
const ASSISTANT_ECHO_PREFIX_RE = /^(?:好的|已为您|已经为您|已打开|已关闭|已将|已调|已设置|已暂停|已停止|正在为您|当前|为您|在呢|已待机)/;

// Action verb required when recovering a nasal-masked wake residue ("Neo" -> "有"/"友"/"钮" in BGM/overlap)
const SMART_HOME_ACTION_RE =
  /(?:把|打开|开启|关闭|关掉|关上|关了|开灯|关灯|熄灯|灭灯|开空调|关空调|开风扇|关风扇|开窗|关窗|开电视|关电视|调|设置|设定|设为|改成|换成|切换|播放|放一首|暂停|继续|停止|静音|取消静音|切歌|换歌|下一首|上一首|亮一点|暗一点|大一点|小一点|高一点|低一点|暖一点|冷一点|查|查询|看看|出粮|喂食|喂猫|喂狗)/;

// Nasal-masked Mandarin phonetic residue of "Neo" (/ni.o/ -> /i.o/ when /n/ is masked by BGM/overlap),
// strictly excluding Chinese negation "没有"
const MASKED_NEO_RESIDUE_RE =
  /(?<!没)(?:有|友|欧|哦|钮|牛|妞|尼|妮)(?=(?:把|打开|开启|关闭|关掉|关上|调|设置|设定|静音|暂停|继续|停止|播放|切换|查看|开灯|关灯|开空调|关空调|开风扇|关风扇|客厅|卧室|书房|主卧|次卧|台灯|吸顶灯|空调|风扇|窗帘|电视|音箱|音响|音量|亮度|温度))/;

function extractMaskedNeoCommand(text: string): string | null {
  const cleaned = text.trim();
  if (!cleaned || QUESTION_TAIL_RE.test(cleaned)) return null;
  const m = MASKED_NEO_RESIDUE_RE.exec(cleaned);
  if (!m) return null;
  const after = cleaned
    .slice(m.index + m[0].length)
    .replace(/^[\s,，。．.、!！?？:：;；]+/, "")
    .replace(/[\s,，。．.、!！?？:：;；]+$/, "")
    .trim();
  if (after.length < 2) return null;
  if (!hasSmartHomeDomainIntent(after) || !SMART_HOME_ACTION_RE.test(after)) return null;
  return after;
}

interface SpeakerWindow {
  startSample: number;
  endSample: number;
  centerSample: number;
  embedding: number[];
}

interface SegmentEvalResult {
  segment: TimedVadSegment;
  speakerId: string;
  embedding: number[] | null;
  transcript: string;
  effectiveText: string;
  altText: string;
  asrEvent: string;
  decision: AttentionDecision;
  wakeSource: "exact-text" | "en-probe" | "oww" | "fuzzy-text" | "conversation" | "none";
  owwScore: number;
  enHeadText: string;
  hasSmartHome: boolean;
  isThirdPerson: boolean;
  isPureSinging: boolean;
}

function estimateNoiseFloorRms(pcm16k: Float32Array): number {
  const frameLen = 320; // 20ms
  const frameCount = Math.floor(pcm16k.length / frameLen);
  if (frameCount < 4) return computeRms(pcm16k);
  const rmsValues: number[] = [];
  for (let f = 0; f < frameCount; f += 1) {
    const base = f * frameLen;
    let sumSq = 0;
    for (let i = 0; i < frameLen; i += 1) {
      const x = pcm16k[base + i]!;
      sumSq += x * x;
    }
    rmsValues.push(Math.sqrt(sumSq / frameLen));
  }
  rmsValues.sort((a, b) => a - b);
  return rmsValues[Math.floor(rmsValues.length * 0.15)] ?? 0;
}

function findLocalEnergyMinimumSample(
  samples: Float32Array,
  searchStart: number,
  searchEnd: number,
): number {
  const start = Math.max(0, Math.min(samples.length - 1, Math.floor(searchStart)));
  const end = Math.max(start + 1, Math.min(samples.length, Math.ceil(searchEnd)));
  const frameLen = 480; // 30ms
  const hop = 240; // 15ms

  if (end - start <= frameLen) {
    return Math.floor((start + end) / 2);
  }

  let minEnergy = Number.POSITIVE_INFINITY;
  let minCenter = Math.floor((start + end) / 2);

  for (let pos = start; pos + frameLen <= end; pos += hop) {
    let sumSq = 0;
    for (let i = 0; i < frameLen; i += 1) {
      const x = samples[pos + i]!;
      sumSq += x * x;
    }
    const avgE = sumSq / frameLen;
    if (avgE < minEnergy) {
      minEnergy = avgE;
      minCenter = pos + (frameLen >> 1);
    }
  }
  return minCenter;
}

/**
 * Fast CAM++ Speaker-Change Boundary Splitter (no Pyannote):
 * For long VAD segments (>= 2.6s), scans 1.2s windows stepping by 0.6s with CAM++.
 * When adjacent window cosine similarity drops < threshold (0.42, or stride-2 < 0.39),
 * locates the local energy minimum between windows and verifies left/right distinctiveness.
 */
function splitLongSegmentBySpeakerChange(
  engine: LocalVoiceEngine,
  stream: Float32Array,
  seg: TimedVadSegment,
  options: { splitThreshold?: number } = {},
): TimedVadSegment[] {
  const segLen = seg.endSample - seg.startSample;
  const durSec = segLen / SR;
  if (durSec < 2.6) {
    return [seg];
  }

  const splitThreshold = options.splitThreshold ?? 0.42;
  const winSamples = Math.round(1.2 * SR); // 1.2s
  const stepSamples = Math.round(0.6 * SR); // 0.6s
  const minSubSamples = Math.round(0.65 * SR);

  const offsets: number[] = [];
  for (let off = 0; off + winSamples <= segLen; off += stepSamples) {
    offsets.push(off);
  }
  const lastOff = offsets[offsets.length - 1] ?? 0;
  if (segLen - (lastOff + winSamples) >= Math.round(0.45 * SR)) {
    offsets.push(segLen - winSamples);
  }
  if (offsets.length < 2) {
    return [seg];
  }

  const windows: SpeakerWindow[] = [];
  for (const off of offsets) {
    const slice = seg.samples.subarray(off, off + winSamples);
    if (!hasAudibleEnergy(slice, 0.005)) continue;
    const emb = engine.extractSpeakerEmbedding(slice, SR);
    if (emb.embedding.length === 0) continue;
    windows.push({
      startSample: off,
      endSample: off + winSamples,
      centerSample: off + (winSamples >> 1),
      embedding: l2Normalize(emb.embedding),
    });
  }

  if (windows.length < 2) {
    return [seg];
  }

  // Find candidate speaker-change transitions
  interface TransitionCandidate {
    leftCenter: number;
    rightCenter: number;
    sim: number;
    anchorIdx: number;
  }
  const rawTransitions: TransitionCandidate[] = [];

  for (let k = 0; k < windows.length - 1; k += 1) {
    const sim = cosineSimilarity(windows[k]!.embedding, windows[k + 1]!.embedding);
    if (sim < splitThreshold) {
      rawTransitions.push({
        leftCenter: windows[k]!.centerSample,
        rightCenter: windows[k + 1]!.centerSample,
        sim,
        anchorIdx: k,
      });
    }
  }

  // Catch 50/50 transitions straddling window k+1 using non-overlapping (k, k+2) pairs
  const adjHitIndices = new Set(rawTransitions.map((t) => t.anchorIdx));
  for (let k = 0; k < windows.length - 2; k += 1) {
    if (adjHitIndices.has(k) || adjHitIndices.has(k + 1)) continue;
    const sim2 = cosineSimilarity(windows[k]!.embedding, windows[k + 2]!.embedding);
    if (sim2 < splitThreshold - 0.03) {
      rawTransitions.push({
        leftCenter: windows[k]!.centerSample,
        rightCenter: windows[k + 2]!.centerSample,
        sim: sim2,
        anchorIdx: k + 1,
      });
    }
  }

  if (rawTransitions.length === 0) {
    return [seg];
  }

  rawTransitions.sort((a, b) => a.leftCenter - b.leftCenter);

  // Merge neighboring transition triggers within 0.9s, keeping the deepest drop
  const mergedTransitions: TransitionCandidate[] = [];
  for (const cand of rawTransitions) {
    const prev = mergedTransitions[mergedTransitions.length - 1];
    const candMid = (cand.leftCenter + cand.rightCenter) / 2;
    if (prev) {
      const prevMid = (prev.leftCenter + prev.rightCenter) / 2;
      if (Math.abs(candMid - prevMid) < Math.round(0.9 * SR)) {
        if (cand.sim < prev.sim) {
          mergedTransitions[mergedTransitions.length - 1] = cand;
        }
        continue;
      }
    }
    mergedTransitions.push(cand);
  }

  // Refine each transition to the local energy minimum between centers
  const splitRelPoints: number[] = [];
  let prevSplit = 0;
  for (const tr of mergedTransitions) {
    const searchLo = Math.max(prevSplit + minSubSamples, tr.leftCenter);
    const searchHi = Math.min(segLen - minSubSamples, tr.rightCenter);
    if (searchHi <= searchLo) continue;
    const splitRel = findLocalEnergyMinimumSample(seg.samples, searchLo, searchHi);
    if (splitRel - prevSplit >= minSubSamples && segLen - splitRel >= minSubSamples) {
      splitRelPoints.push(splitRel);
      prevSplit = splitRel;
    }
  }

  if (splitRelPoints.length === 0) {
    return [seg];
  }

  // Validate each split point by comparing left/right sub-segment embeddings
  const validatedSplits: number[] = [];
  let boundaryStart = 0;
  for (let i = 0; i < splitRelPoints.length; i += 1) {
    const sp = splitRelPoints[i]!;
    const nextEnd = splitRelPoints[i + 1] ?? segLen;
    const leftSlice = seg.samples.subarray(boundaryStart, sp);
    const rightSlice = seg.samples.subarray(sp, nextEnd);
    if (leftSlice.length >= 4000 && rightSlice.length >= 4000) {
      const eL = l2Normalize(engine.extractSpeakerEmbedding(leftSlice, SR).embedding);
      const eR = l2Normalize(engine.extractSpeakerEmbedding(rightSlice, SR).embedding);
      const lrSim = cosineSimilarity(eL, eR);
      if (lrSim < splitThreshold + 0.05) {
        validatedSplits.push(sp);
        boundaryStart = sp;
      }
    }
  }

  if (validatedSplits.length === 0) {
    return [seg];
  }

  const padBoundary = Math.round(0.14 * SR);
  const cuts = [0, ...validatedSplits, segLen];
  const result: TimedVadSegment[] = [];
  for (let i = 0; i < cuts.length - 1; i += 1) {
    const rawS = cuts[i]!;
    const rawE = cuts[i + 1]!;
    const absS = Math.max(seg.startSample, seg.startSample + rawS - (i > 0 ? padBoundary : 0));
    const absE = Math.min(
      seg.endSample,
      seg.startSample + rawE + (i < cuts.length - 2 ? padBoundary : 0),
    );
    if (absE - absS < Math.round(0.25 * SR)) continue;
    result.push({
      startSample: absS,
      endSample: absE,
      startSec: Number((absS / SR).toFixed(3)),
      endSec: Number((absE / SR).toFixed(3)),
      samples: stream.slice(absS, absE),
    });
  }

  return result.length > 0 ? result : [seg];
}

/**
 * Online agglomerative CAM++ clustering across all isolated segments.
 */
function clusterSegmentSpeakers(
  engine: LocalVoiceEngine,
  segments: readonly TimedVadSegment[],
  options: { clusterThreshold?: number } = {},
): {
  speakerIds: string[];
  embeddings: Array<number[] | null>;
} {
  const clusterThreshold = options.clusterThreshold ?? 0.42;
  const embeddings: Array<number[] | null> = [];
  const speakerIds: string[] = [];

  interface Cluster {
    id: string;
    sumVec: number[];
    centroid: number[];
    count: number;
  }
  const clusters: Cluster[] = [];

  for (const seg of segments) {
    if (seg.samples.length < 4800 || !hasAudibleEnergy(seg.samples, 0.005)) {
      embeddings.push(null);
      speakerIds.push("spk_0");
      continue;
    }

    const embRes = engine.extractSpeakerEmbedding(seg.samples, SR);
    const vec = l2Normalize(embRes.embedding);
    if (vec.length === 0) {
      embeddings.push(null);
      speakerIds.push("spk_0");
      continue;
    }
    embeddings.push(vec);

    let bestCluster: Cluster | null = null;
    let bestSim = -1;
    for (const c of clusters) {
      const sim = cosineSimilarity(vec, c.centroid);
      if (sim > bestSim) {
        bestSim = sim;
        bestCluster = c;
      }
    }

    if (bestCluster && bestSim >= clusterThreshold) {
      for (let d = 0; d < bestCluster.sumVec.length && d < vec.length; d += 1) {
        bestCluster.sumVec[d] = bestCluster.sumVec[d]! + vec[d]!;
      }
      bestCluster.count += 1;
      bestCluster.centroid = l2Normalize(bestCluster.sumVec);
      speakerIds.push(bestCluster.id);
    } else {
      const id = `spk_${clusters.length}`;
      clusters.push({
        id,
        sumVec: [...vec],
        centroid: vec,
        count: 1,
      });
      speakerIds.push(id);
    }
  }

  return { speakerIds, embeddings };
}

function findMidSegmentSpeechPeaks(
  samples: Float32Array,
  minOffsetSec = 0.9,
  maxPeaks = 2,
): number[] {
  const frameLen = Math.round(0.1 * SR); // 100ms
  const frameCount = Math.floor(samples.length / frameLen);
  if (frameCount < 12) return [];

  const rms = new Float32Array(frameCount);
  let maxRms = 0;
  for (let f = 0; f < frameCount; f += 1) {
    const base = f * frameLen;
    let sumSq = 0;
    for (let i = 0; i < frameLen; i += 1) {
      const x = samples[base + i]!;
      sumSq += x * x;
    }
    const r = Math.sqrt(sumSq / frameLen);
    rms[f] = r;
    if (r > maxRms) maxRms = r;
  }
  if (maxRms < 0.008) return [];

  const startFrame = Math.max(2, Math.floor(minOffsetSec / 0.1));
  const endFrame = Math.max(startFrame + 1, frameCount - 5);
  const candidates: Array<{ sample: number; score: number }> = [];

  for (let f = startFrame; f < endFrame; f += 1) {
    const cur = rms[f]!;
    if (cur < maxRms * 0.32) continue;
    // Look for phrase onset peak (higher than preceding valley)
    const prevMin = Math.min(rms[f - 1]!, rms[f - 2]!, f >= 3 ? rms[f - 3]! : rms[f - 2]!);
    const localPeak = cur >= rms[f - 1]! && cur >= rms[f + 1]!;
    if (localPeak && cur > prevMin * 1.25) {
      candidates.push({
        sample: f * frameLen,
        score: cur * (1 + Math.min(1, (cur - prevMin) / Math.max(1e-5, cur))),
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  const picked: number[] = [];
  const minSep = Math.round(1.0 * SR);
  for (const c of candidates) {
    if (picked.every((p) => Math.abs(p - c.sample) >= minSep)) {
      picked.push(c.sample);
      if (picked.length >= maxPeaks) break;
    }
  }
  return picked.sort((a, b) => a - b);
}

function isNoisyAliasSurface(surface: string): boolean {
  return NOISY_ALIAS_SURFACES.has(surface.trim().toLowerCase());
}

function isPureShortWakeResidue(text: string, segDurSec: number): boolean {
  if (segDurSec > 2.2) return false;
  const cleaned = text.replace(PUNCT_STRIP_RE, "").trim();
  if (!cleaned) return true;
  if (NON_WAKE_SHORT_ZH_RE.test(cleaned)) return false;
  if (WEIRD_SCRIPT_RE.test(cleaned)) return true;
  if (isWakeQueryText(cleaned)) return true;
  if (WAKE_RESIDUE_ZH_RE.test(cleaned)) return true;
  return cleaned.length <= 2 && !/[\u4e00-\u9fff]{2}/.test(cleaned);
}

function isHouseholdSidetalkInConversation(text: string): boolean {
  const cleaned = text.trim();
  if (!cleaned) return true;
  if (hasSmartHomeDomainIntent(cleaned)) return false;
  if (CONVERSATION_CONTROL_RE.test(cleaned)) return false;
  if (HOUSEHOLD_CHATTING_RE.test(cleaned)) return true;
  // Generic polite/action prefix without any smart-home or control target
  if (/^(?:请|帮我|给我|麻烦|快|赶紧|顺便|把|将)/.test(cleaned)) {
    return true;
  }
  return false;
}

function hasThirdPersonWithNoSeparateWakeCommand(
  text: string,
  wakeWords: readonly string[],
): boolean {
  if (!isThirdPersonNeoMention(text)) return false;
  // Check if a later sentence clause independently issues a direct wake + smart-home command
  const clauses = text
    .split(/[。！？!?]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (clauses.length > 1) {
    for (let i = 1; i < clauses.length; i += 1) {
      const clause = clauses[i]!;
      if (isThirdPersonNeoMention(clause)) continue;
      const sp = findWakeWordSpan(clause, wakeWords);
      if (sp && !sp.fuzzy && hasSmartHomeDomainIntent(sp.afterText)) {
        return false;
      }
    }
  }
  return true;
}

function chooseBestSegmentAsr(
  candidates: Array<{ asr: LocalAsrOutput; track: "primary" | "raw" | "alt" }>,
  options: {
    wakeWords: readonly string[];
    isMusic: boolean;
    isNoise: boolean;
    anyThirdPerson: boolean;
  },
): { best: LocalAsrOutput; altText: string } {
  const valid = candidates.filter((c) => c.asr.text.trim().length > 0);
  if (valid.length === 0) {
    return { best: candidates[0]!.asr, altText: "" };
  }
  if (valid.length === 1) {
    return { best: valid[0]!.asr, altText: "" };
  }

  const scoreCand = (item: { asr: LocalAsrOutput; track: "primary" | "raw" | "alt" }): number => {
    const text = item.asr.text.trim();
    let s = Math.min(20, text.length * 0.85);

    const thirdPerson = isThirdPersonNeoMention(text);
    // Preserve third-person negative context if any clean track detected it
    if (options.anyThirdPerson && thirdPerson) {
      s += 80;
    }

    const span = findWakeWordSpan(text, options.wakeWords);
    if (span && !thirdPerson) {
      if (!span.fuzzy) {
        s += 105;
        if (hasSmartHomeDomainIntent(span.afterText)) s += 45;
        else if (looksLikeDirectDeviceCommand(span.afterText)) s += 25;
      } else if (!isNoisyAliasSurface(span.matchedSurface)) {
        s += 65;
        if (hasSmartHomeDomainIntent(span.afterText)) s += 35;
      } else if (hasSmartHomeDomainIntent(span.afterText) && !QUESTION_TAIL_RE.test(text)) {
        s += 30;
      }
      if (span.beforeText.length <= 2) s += 10;
    } else if (!thirdPerson) {
      if (hasSmartHomeDomainIntent(text)) s += 32;
      else if (looksLikeDirectDeviceCommand(text)) s += 16;
    }

    if (item.asr.event.toUpperCase().includes("SPEECH")) s += 8;
    if (item.track === "raw" && options.isMusic) s += 14;
    if (item.track === "primary" && options.isNoise && !options.isMusic) s += 12;

    const weirdMatches = text.match(/[\u3040-\u30ff\uac00-\ud7af]/g);
    if (weirdMatches && weirdMatches.length > 0) {
      s -= weirdMatches.length * 14;
    }
    return s;
  };

  const ranked = valid
    .map((item) => ({ item, score: scoreCand(item) }))
    .sort((a, b) => b.score - a.score);

  return {
    best: ranked[0]!.item.asr,
    altText: ranked[1]?.item.asr.text ?? "",
  };
}

export function createSolutionS5(pool: SharedVoiceModelPool): VoiceSolution {
  return {
    id: "s5_multistream_harmonic_verifier",
    name: "S5: Multi-Stream DSP/Neural + CAM++ Splitter + Sliding Bilingual Verifier",
    description:
      "超快多流前端（无 Spleeter/UVR/VoxLock/Pyannote）：CED-tiny + DSP 声学场景并行识别与快路径拒绝 -> 语音频带滤波 + GTCRN / 按需 DPDFNet4 双流增强 -> CAM++ 滑窗说话人边界切分与聚类 -> 句首/峰值双语滑窗探针与严格声学-语义 DDSD 校验。",

    async init(): Promise<void> {
      pool.ensureCedTagger();
      // Preload DPDFNet4 and English SenseVoice recognizer once before benchmark timing
      const tinySilence = new Float32Array(1600);
      pool.localEngine.denoise(tinySilence, SR, "dpdfnet");
      await pool.localEngine.transcribeLocal(tinySilence, SR, "en-US").catch(() => undefined);
    },

    async process(input: SolutionRunInput): Promise<SolutionRunOutput> {
      const t0 = performance.now();
      const engine = pool.localEngine;
      const { clip, pcm16k, wakeWords } = input;
      const dialogCtx = buildRuntimeDialogContext(clip, wakeWords);
      const hasAsciiWake = wakeWords.some((w) => /^[a-z][a-z0-9\s-]*$/i.test(w.trim()));

      // ==================== Stage 1: Ultra-Fast Scene Analysis (~20-25ms) ====================
      const tScene = performance.now();
      const scene = pool.analyzeAudioScene(pcm16k);
      const diag = computeAcousticDiagnostics(pcm16k);
      const rawSnrDb = estimateSnrDb(pcm16k, SR);
      const noiseFloorRms = estimateNoiseFloorRms(pcm16k);
      const sceneMs = Math.round(performance.now() - tScene);

      // Ultra-quiet / empty signal early reject
      if (!hasAudibleEnergy(pcm16k, 0.003)) {
        return {
          isNeoCommand: false,
          wokeOnly: false,
          command: "",
          rawTranscript: "",
          detectedSoundTypes: scene.detectedSoundTypes.length > 0 ? [...scene.detectedSoundTypes] : ["noise"],
          detectedSpeakerCount: 0,
          separatedStreams: [],
          attentionStage: "silence-skip",
          attentionReason: "音频能量过低，快速拒绝",
          latencyMs: Math.round(performance.now() - t0),
          stageTimingsMs: { sceneMs },
        };
      }

      // ==================== Stage 2: Fast Dual-Stream Enhancement ====================
      const tDen = performance.now();
      const hpRaw = applyHighPassFilter(pcm16k, SR, 85);
      // Stream 1: 140Hz-3800Hz speech formant bandpass -> GTCRN (~20-30ms)
      const bandpassed = applySpeechBandpass(pcm16k, SR);
      const gtcrn = engine.denoise(bandpassed, SR, "auto");

      // Fast VAD on GTCRN output for early reject
      const gtcrnVadSegs = extractTimedVadSegments(engine, gtcrn.samples, {
        threshold: 0.36,
        minSilenceDuration: 0.24,
        minSpeechDuration: 0.14,
        padSec: 0.12,
        mergeGapSec: 0.14,
      });

      // Fast Early Reject (~35ms total!): non-speech pure music/noise with no Silero VAD hit
      if (
        scene.speechProb < 0.08 &&
        (scene.musicProb >= 0.40 || scene.noiseProb >= 0.30) &&
        gtcrnVadSegs.length === 0
      ) {
        const earlyTypes = new Set<SoundTypeLabel>(scene.detectedSoundTypes);
        if (scene.singingProb >= 0.055) earlyTypes.add("song");
        if (scene.musicProb >= 0.14 || scene.singingProb >= 0.08) earlyTypes.add("bgm");
        if (scene.noiseProb >= 0.08 && scene.musicProb < 0.35) earlyTypes.add("noise");
        earlyTypes.delete("speech");

        return {
          isNeoCommand: false,
          wokeOnly: false,
          command: "",
          rawTranscript: "",
          detectedSoundTypes: earlyTypes.size > 0 ? [...earlyTypes] : ["noise"],
          detectedSpeakerCount: 0,
          separatedStreams: [
            {
              streamId: "early_non_speech",
              kind: scene.singingProb >= 0.08 ? "song_vocals" : scene.musicProb >= 0.2 ? "bgm_accompaniment" : "noise",
            },
          ],
          attentionStage: "early-scene-reject",
          attentionReason: `CED 判定非人声场景 (speech=${scene.speechProb.toFixed(2)}, music=${scene.musicProb.toFixed(2)}, noise=${scene.noiseProb.toFixed(2)}) 且 GTCRN+VAD 无语音`,
          latencyMs: Math.round(performance.now() - t0),
          stageTimingsMs: { sceneMs, denoiseMs: Math.round(performance.now() - tDen) },
        };
      }

      // Stream 2 (only when noisy or music): DPDFNet4
      const inputSnrDb = Math.min(rawSnrDb, gtcrn.inputSnrDb);
      const isNoisyOrMusic =
        inputSnrDb < 18 || scene.musicProb >= 0.14 || scene.noiseProb >= 0.10;
      const isMusicScene = scene.musicProb >= 0.14 || scene.singingProb >= 0.08;
      const isNoiseScene =
        (scene.noiseProb >= 0.08 && scene.musicProb < 0.35) ||
        (!isMusicScene &&
          ((noiseFloorRms >= 0.008 && rawSnrDb < 15 && gtcrn.snrGainDb >= 5) ||
            (diag.spectralFlatnessApprox >= 0.45 && rawSnrDb < 15) ||
            (diag.lowBandRatio >= 0.55 && rawSnrDb < 15 && gtcrn.snrGainDb >= 6)));

      let dpdfnetSamples: Float32Array | null = null;
      let dpdfSnrDb = -99;
      if (isNoisyOrMusic) {
        const dpdf = engine.denoise(pcm16k, SR, "dpdfnet");
        if (dpdf.engine === "dpdfnet4" && hasAudibleEnergy(dpdf.samples, 0.005)) {
          dpdfnetSamples = dpdf.samples;
          dpdfSnrDb = dpdf.outputSnrDb;
        }
      }
      const denoiseMs = Math.round(performance.now() - tDen);

      // Select best enhanced stream & extract timed VAD segments
      const tSplit = performance.now();
      let primaryStream = gtcrn.samples;
      let altDenStream: Float32Array | null = dpdfnetSamples;
      let baseSegments = gtcrnVadSegs;

      if (dpdfnetSamples) {
        const preferDpdf =
          gtcrnVadSegs.length === 0 ||
          scene.noiseProb >= 0.14 ||
          dpdfSnrDb > gtcrn.outputSnrDb + 1.5;
        if (preferDpdf) {
          const dpdfVadSegs = extractTimedVadSegments(engine, dpdfnetSamples, {
            threshold: 0.35,
            minSilenceDuration: 0.24,
            minSpeechDuration: 0.14,
            padSec: 0.12,
            mergeGapSec: 0.14,
          });
          if (dpdfVadSegs.length > 0) {
            primaryStream = dpdfnetSamples;
            altDenStream = gtcrn.samples;
            baseSegments = dpdfVadSegs;
          }
        }
      }

      // Fallback VAD on high-pass raw if both neural denoisers suppressed quiet speech over strong BGM
      if (baseSegments.length === 0 && scene.speechProb >= 0.10 && hasAudibleEnergy(hpRaw, 0.008)) {
        const rawVadSegs = extractTimedVadSegments(engine, hpRaw, {
          threshold: 0.32,
          minSilenceDuration: 0.25,
          minSpeechDuration: 0.14,
          padSec: 0.12,
          mergeGapSec: 0.16,
        });
        if (rawVadSegs.length > 0) {
          primaryStream = hpRaw;
          altDenStream = gtcrn.samples;
          baseSegments = rawVadSegs;
        }
      }

      // No speech segments detected after all streams -> clean reject
      if (baseSegments.length === 0) {
        const noSpeechTypes = new Set<SoundTypeLabel>(scene.detectedSoundTypes);
        if (isMusicScene) noSpeechTypes.add("bgm");
        if (scene.singingProb >= 0.055) noSpeechTypes.add("song");
        if (isNoiseScene) noSpeechTypes.add("noise");
        noSpeechTypes.delete("speech");

        return {
          isNeoCommand: false,
          wokeOnly: false,
          command: "",
          rawTranscript: "",
          detectedSoundTypes: noSpeechTypes.size > 0 ? [...noSpeechTypes] : ["noise"],
          detectedSpeakerCount: 0,
          separatedStreams: [],
          attentionStage: "vad-skip",
          attentionReason: "增强流 Silero VAD 未检测到有效人声分段",
          latencyMs: Math.round(performance.now() - t0),
          stageTimingsMs: { sceneMs, denoiseMs, splitMs: Math.round(performance.now() - tSplit) },
        };
      }

      // ==================== Stage 3: Fast CAM++ Speaker-Change Boundary Splitter ====================
      const splitThreshold = scene.musicProb >= 0.30 ? 0.39 : 0.42;
      const isolatedSegments: TimedVadSegment[] = [];
      for (const seg of baseSegments) {
        const splitSegs = splitLongSegmentBySpeakerChange(engine, primaryStream, seg, {
          splitThreshold,
        });
        isolatedSegments.push(...splitSegs);
      }

      const clusterThreshold = scene.musicProb >= 0.30 || scene.noiseProb >= 0.30 ? 0.38 : 0.42;
      const { speakerIds, embeddings } = clusterSegmentSpeakers(engine, isolatedSegments, {
        clusterThreshold,
      });
      const splitMs = Math.round(performance.now() - tSplit);

      // ==================== Stage 4: Per-Segment Multi-Window Bilingual ASR + Verifier ====================
      const tAsr = performance.now();
      const segResults: SegmentEvalResult[] = [];
      let anyBgmEvent = false;
      let detectedSuppressedSong = false;

      const probeEnWindow = async (
        winPcm: Float32Array,
        allowGated: boolean,
      ): Promise<{
        text: string;
        hit: { wakeWord: string; matchedSurface: string; fuzzy: boolean } | null;
      }> => {
        if (winPcm.length < 1600 || !hasAudibleEnergy(winPcm, 0.004)) {
          return { text: "", hit: null };
        }
        const enRes = await engine.transcribeLocal(winPcm, SR, "en-US");
        const hit = matchEnglishHeadWakeWord(enRes.text, wakeWords, {
          allowCommandGatedAliases: allowGated,
        });
        return { text: enRes.text, hit };
      };

      const scoreBestOwwOnRange = (
        startSample: number,
        endSample: number,
        includeRaw: boolean,
      ): WakeWordAcousticHit | null => {
        const len = endSample - startSample;
        if (len < 2400) return null;
        let bestHit: WakeWordAcousticHit | null = null;
        const consider = (buf: Float32Array | null) => {
          if (!buf || startSample >= buf.length) return;
          const sl = buf.subarray(startSample, Math.min(endSample, buf.length));
          if (sl.length < 2400 || !hasAudibleEnergy(sl, 0.004)) return;
          const h = engine.scoreWakeWordAudio(sl, wakeWords, { threshold: 0.6 });
          if (h && (!bestHit || h.score > bestHit.score)) {
            bestHit = h;
          }
        };
        consider(primaryStream);
        if (!bestHit?.matched && altDenStream) {
          consider(altDenStream);
        }
        if (!bestHit?.matched && includeRaw && primaryStream !== hpRaw) {
          consider(hpRaw);
        }
        return bestHit;
      };

      for (let idx = 0; idx < isolatedSegments.length; idx += 1) {
        const seg = isolatedSegments[idx]!;
        const speakerId = speakerIds[idx] ?? "spk_0";
        const segEmb = embeddings[idx] ?? null;
        const segLen = seg.samples.length;
        const segDurSec = segLen / SR;

        const segRawHp = hpRaw.subarray(
          Math.min(seg.startSample, hpRaw.length),
          Math.min(seg.endSample, hpRaw.length),
        );
        const segAltDen =
          altDenStream
            ? altDenStream.subarray(
                Math.min(seg.startSample, altDenStream.length),
                Math.min(seg.endSample, altDenStream.length),
              )
            : null;

        // 4A. Primary SenseVoice (zh-CN) decode
        const asrPrimary = await engine.transcribeLocal(seg.samples, SR, "zh-CN");
        if (asrPrimary.event.toUpperCase().includes("BGM")) anyBgmEvent = true;

        const asrCandidates: Array<{ asr: LocalAsrOutput; track: "primary" | "raw" | "alt" }> = [
          { asr: asrPrimary, track: "primary" },
        ];

        const primaryCleanChars = asrPrimary.text.replace(PUNCT_STRIP_RE, "").trim();
        const primarySpan = findWakeWordSpan(asrPrimary.text, wakeWords);
        const primaryExactWake = Boolean(primarySpan && !primarySpan.fuzzy);

        // Acoustic OWW score on isolated segment (~5-12ms across primary + GTCRN/raw if needed)
        let owwHit: WakeWordAcousticHit | null = scoreBestOwwOnRange(
          seg.startSample,
          seg.endSample,
          isNoisyOrMusic || !primaryExactWake,
        );
        let owwScore = owwHit?.score ?? 0;

        // Lean fallback decodes: only when primary lacks exact wake and signal warrants fallback
        let asrRaw: LocalAsrOutput | null = null;
        const needRawFallback =
          !primaryExactWake &&
          segRawHp.length >= 1600 &&
          primaryStream !== hpRaw &&
          (primaryCleanChars.length <= 4 ||
            WEIRD_SCRIPT_RE.test(asrPrimary.text) ||
            hasSmartHomeDomainIntent(asrPrimary.text) ||
            owwScore >= 0.35 ||
            (isMusicScene && primaryCleanChars.length <= 1));

        if (needRawFallback) {
          asrRaw = await engine.transcribeLocal(segRawHp, SR, "zh-CN");
          if (asrRaw.event.toUpperCase().includes("BGM")) anyBgmEvent = true;
          asrCandidates.push({ asr: asrRaw, track: "raw" });
        }

        // Detect singing vocals suppressed by neural denoiser during strong music:
        // primary denoised stream is empty/tiny while raw HP stream contains non-command lyrics
        if (
          scene.musicProb >= 0.30 &&
          primaryStream !== hpRaw &&
          primaryCleanChars.length <= 1 &&
          asrRaw
        ) {
          const rawClean = asrRaw.text.replace(PUNCT_STRIP_RE, "").trim();
          if (
            rawClean.length >= 2 &&
            !hasSmartHomeDomainIntent(asrRaw.text) &&
            !findWakeWordSpan(asrRaw.text, wakeWords)
          ) {
            detectedSuppressedSong = true;
            segResults.push({
              segment: seg,
              speakerId,
              embedding: segEmb,
              transcript: asrRaw.text.trim(),
              effectiveText: asrRaw.text.trim(),
              altText: "",
              asrEvent: asrRaw.event || "<|BGM|>",
              decision: {
                accept: false,
                wokeOnly: false,
                addressed: false,
                inConversation: dialogCtx.inConversation ?? false,
                confidence: 0.9,
                stage: "acoustic",
                reason: "神经降噪已滤除该段音乐人声/歌词，判定为歌曲演唱而非独立说话人",
                wakeWord: null,
                command: "",
                usedLlm: false,
                latencyMs: 0,
              },
              wakeSource: "none",
              owwScore,
              enHeadText: "",
              hasSmartHome: false,
              isThirdPerson: false,
              isPureSinging: true,
            });
            continue;
          }
        }

        const hasExactNow = asrCandidates.some((c) => {
          const sp = findWakeWordSpan(c.asr.text, wakeWords);
          return Boolean(sp && !sp.fuzzy);
        });
        const needAltDenFallback =
          !hasExactNow &&
          segAltDen &&
          segAltDen.length >= 1600 &&
          isNoisyOrMusic &&
          hasAudibleEnergy(segAltDen, 0.005) &&
          (primaryCleanChars.length <= 3 ||
            WEIRD_SCRIPT_RE.test(asrPrimary.text) ||
            (hasSmartHomeDomainIntent(asrPrimary.text) && owwScore >= 0.35));
        if (needAltDenFallback && segAltDen) {
          const asrAlt = await engine.transcribeLocal(segAltDen, SR, "zh-CN");
          if (asrAlt.event.toUpperCase().includes("BGM")) anyBgmEvent = true;
          asrCandidates.push({ asr: asrAlt, track: "alt" });
        }

        const anyThirdPerson = asrCandidates.some((c) =>
          hasThirdPersonWithNoSeparateWakeCommand(c.asr.text, wakeWords),
        );

        const { best: bestAsr, altText } = chooseBestSegmentAsr(asrCandidates, {
          wakeWords,
          isMusic: isMusicScene,
          isNoise: isNoiseScene,
          anyThirdPerson,
        });

        let bestText = bestAsr.text.trim();
        let bestEvent = bestAsr.event;
        const textThirdPerson =
          anyThirdPerson || hasThirdPersonWithNoSeparateWakeCommand(bestText, wakeWords);

        // 4B. Singing lyrics rejection (especially critical in conversation mode)
        const textHasSmartHome = hasSmartHomeDomainIntent(bestText);
        const initialSpan = findWakeWordSpan(bestText, wakeWords);
        const hasExactWakeInText = Boolean(initialSpan && !initialSpan.fuzzy);
        const isPureSinging =
          scene.singingProb >= 0.12 &&
          scene.speechProb < 0.25 &&
          !textHasSmartHome &&
          !hasExactWakeInText;

        if (isPureSinging) {
          segResults.push({
            segment: seg,
            speakerId,
            embedding: segEmb,
            transcript: bestText,
            effectiveText: bestText,
            altText,
            asrEvent: bestEvent,
            decision: {
              accept: false,
              wokeOnly: false,
              addressed: false,
              inConversation: dialogCtx.inConversation ?? false,
              confidence: 0.9,
              stage: "acoustic",
              reason: `识别为歌声演唱片段 (singing=${scene.singingProb.toFixed(2)}, speech=${scene.speechProb.toFixed(2)}) 且无智能家居意图`,
              wakeWord: null,
              command: "",
              usedLlm: false,
              latencyMs: 0,
            },
            wakeSource: "none",
            owwScore,
            enHeadText: "",
            hasSmartHome: false,
            isThirdPerson: false,
            isPureSinging: true,
          });
          continue;
        }

        // 4C. Strict Third-Person Gate BEFORE any acoustic or en-US wake rewrite!
        if (textThirdPerson) {
          segResults.push({
            segment: seg,
            speakerId,
            embedding: segEmb,
            transcript: bestText,
            effectiveText: bestText,
            altText,
            asrEvent: bestEvent,
            decision: {
              accept: false,
              wokeOnly: false,
              addressed: false,
              inConversation: dialogCtx.inConversation ?? false,
              confidence: 0.94,
              stage: "pragmatic-reject",
              reason: "检测到第三人称提及或否定呼唤语境，声学改写前已拦截",
              wakeWord: null,
              command: "",
              usedLlm: false,
              latencyMs: 0,
            },
            wakeSource: "none",
            owwScore,
            enHeadText: "",
            hasSmartHome: textHasSmartHome,
            isThirdPerson: true,
            isPureSinging: false,
          });
          continue;
        }

        // 4D. Sliding Bilingual (en-US) Wake Probe (onset 0..1.15s, fast 0..0.65s, mid-segment & pre-roll boundary)
        let enHit: { wakeWord: string; matchedSurface: string; fuzzy: boolean } | null = null;
        let enHeadText = "";
        let midPeakStartSample = -1;
        let preRollWakeConfirmed = false;

        const targetWakeDefault = wakeWords[0] ?? "Neo";
        const extractedCandidate = extractCommandAfterAcousticWake(bestText, targetWakeDefault);
        const extractedHasSmartHome = hasSmartHomeDomainIntent(extractedCandidate);
        const candidateShortOrWeird =
          isPureShortWakeResidue(bestText, segDurSec) ||
          WEIRD_SCRIPT_RE.test(bestText) ||
          bestText.replace(PUNCT_STRIP_RE, "").length <= 4;

        const shouldRunEnProbe =
          hasAsciiWake &&
          !hasExactWakeInText &&
          (candidateShortOrWeird ||
            extractedHasSmartHome ||
            looksLikeDirectDeviceCommand(extractedCandidate) ||
            Boolean(initialSpan?.fuzzy) ||
            owwScore >= 0.35);

        if (shouldRunEnProbe) {
          const allowGated = extractedHasSmartHome;

          // Onset Window 1: 0..1.15s
          const w115 = Math.min(segLen, Math.round(1.15 * SR));
          let probe = await probeEnWindow(seg.samples.subarray(0, w115), allowGated);
          enHeadText = probe.text;
          enHit = probe.hit;

          // Raw high-pass onset 0..1.15s fallback when music or strong smart-home command
          if (!enHit && segRawHp.length >= 1600 && (isMusicScene || allowGated)) {
            const rawW115 = Math.min(segRawHp.length, Math.round(1.15 * SR));
            const rawProbe = await probeEnWindow(segRawHp.subarray(0, rawW115), allowGated);
            if (rawProbe.hit) {
              enHeadText = rawProbe.text;
              enHit = rawProbe.hit;
            }
          }

          // Onset Window 2: fast 0..0.65s for rapid bilingual utterances like "Neo关灯"
          if (
            !enHit &&
            segLen >= Math.round(0.75 * SR) &&
            (segDurSec <= 2.3 || allowGated)
          ) {
            const w065 = Math.min(segLen, Math.round(0.65 * SR));
            const fastSrc = segRawHp.length >= w065 ? segRawHp : seg.samples;
            const fastProbe = await probeEnWindow(fastSrc.subarray(0, w065), allowGated);
            if (fastProbe.hit) {
              enHeadText = fastProbe.text;
              enHit = fastProbe.hit;
            }
          }

          // Mid-segment probe (if segment > 2.2s and no onset wake yet)
          if (!enHit && segDurSec > 2.2) {
            const midWindows: Array<{ start: number; end: number }> = [];
            if (owwHit && owwHit.sampleOffset > Math.round(1.0 * SR) && owwHit.score >= 0.30) {
              const s = Math.max(0, owwHit.sampleOffset - Math.round(0.95 * SR));
              const e = Math.min(segLen, owwHit.sampleOffset + Math.round(0.25 * SR));
              if (e - s >= Math.round(0.5 * SR)) {
                midWindows.push({ start: s, end: e });
              }
            }
            if (midWindows.length === 0 && allowGated) {
              const peaks = findMidSegmentSpeechPeaks(seg.samples, 0.9, 1);
              for (const pk of peaks) {
                const s = Math.max(0, pk - Math.round(0.25 * SR));
                const e = Math.min(segLen, pk + Math.round(0.95 * SR));
                if (e - s >= Math.round(0.5 * SR)) {
                  midWindows.push({ start: s, end: e });
                }
              }
            }

            for (const mw of midWindows) {
              const midProbe = await probeEnWindow(
                seg.samples.subarray(mw.start, mw.end),
                allowGated,
              );
              if (midProbe.hit) {
                enHit = midProbe.hit;
                enHeadText = midProbe.text;
                midPeakStartSample = mw.start;
                break;
              }
              if (isMusicScene && segRawHp.length >= mw.end) {
                const midRawProbe = await probeEnWindow(
                  segRawHp.subarray(mw.start, mw.end),
                  allowGated,
                );
                if (midRawProbe.hit) {
                  enHit = midRawProbe.hit;
                  enHeadText = midRawProbe.text;
                  midPeakStartSample = mw.start;
                  break;
                }
              }
            }

            // If wake was discovered mid-segment, re-decode tail from peakStart to strip leading lyrics/chatter
            if (enHit && midPeakStartSample >= Math.round(0.5 * SR)) {
              const tailPcm = seg.samples.subarray(midPeakStartSample);
              if (tailPcm.length >= 3200) {
                const tailAsr = await engine.transcribeLocal(tailPcm, SR, "zh-CN");
                const tailText = tailAsr.text.trim();
                if (tailText && !hasThirdPersonWithNoSeparateWakeCommand(tailText, wakeWords)) {
                  bestText = tailText;
                  bestEvent = tailAsr.event || bestEvent;
                }
              }
            }
          }
        }

        // 4D-2. Boundary Pre-Roll Wake Recovery for split segments whose energy-minimum cut landed
        // between a short wake word ("Neo,") and the isolated imperative smart-home command
        const prevSegThirdPerson = idx > 0 && Boolean(segResults[idx - 1]?.isThirdPerson);
        if (
          !hasExactWakeInText &&
          !enHit &&
          !owwHit?.matched &&
          !prevSegThirdPerson &&
          seg.startSample >= Math.round(0.35 * SR) &&
          extractedHasSmartHome &&
          SMART_HOME_ACTION_RE.test(extractedCandidate) &&
          !QUESTION_TAIL_RE.test(bestText)
        ) {
          const preStart = Math.max(0, seg.startSample - Math.round(0.75 * SR));
          const preEndOww = Math.min(primaryStream.length, seg.startSample + Math.round(0.65 * SR));
          let preRollOwwScore = 0;
          const preOww = scoreBestOwwOnRange(preStart, preEndOww, true);
          if (preOww) {
            preRollOwwScore = Math.max(preRollOwwScore, preOww.score);
            if (preOww.score > owwScore) {
              owwHit = preOww;
              owwScore = preOww.score;
            }
          }
          // Also check tighter 0.45s pre-roll so preceding speaker tail does not shift OWW phase/calibration
          if (preRollOwwScore < 0.50) {
            const tightStart = Math.max(0, seg.startSample - Math.round(0.45 * SR));
            const tightOww = scoreBestOwwOnRange(tightStart, preEndOww, true);
            if (tightOww) {
              preRollOwwScore = Math.max(preRollOwwScore, tightOww.score);
              if (tightOww.score > owwScore) {
                owwHit = tightOww;
                owwScore = tightOww.score;
              }
            }
          }

          // Joint acoustic-semantic boundary confirmation: strong OWW peak (>= 0.50) specifically
          // inside the split-boundary pre-roll right before an imperative smart-home command
          if (preRollOwwScore >= 0.50 && !AMBIGUOUS_ZH_PREFIX_RE.test(bestText)) {
            preRollWakeConfirmed = true;
          }

          if (!preRollWakeConfirmed && !owwHit?.matched && hasAsciiWake) {
            const preEndEn = Math.min(primaryStream.length, seg.startSample + Math.round(0.45 * SR));
            const preEn = await probeEnWindow(primaryStream.subarray(preStart, preEndEn), true);
            if (preEn.hit) {
              enHit = preEn.hit;
              enHeadText = preEn.text;
            }
          }

          // If pre-roll shows credible acoustic wake energy (>= 0.30), inspect pre-roll zh-CN
          // (primary stream, plus GTCRN alt stream in music scenes) for wake word or nasal-masked
          // phonetic residue ("钮"/"你有"/"有" + smart-home action) without leaking prior speaker text
          if (!preRollWakeConfirmed && !enHit && !owwHit?.matched && owwScore >= 0.30) {
            const checkPreRollStream = async (streamBuf: Float32Array | null): Promise<boolean> => {
              if (!streamBuf || preStart >= streamBuf.length) return false;
              const slice = streamBuf.subarray(preStart, Math.min(streamBuf.length, seg.endSample));
              if (slice.length < 3200) return false;
              const preZh = await engine.transcribeLocal(slice, SR, "zh-CN");
              const preZhText = preZh.text.trim();
              if (!preZhText || hasThirdPersonWithNoSeparateWakeCommand(preZhText, wakeWords)) {
                return false;
              }
              const preSpan = findWakeWordSpan(preZhText, wakeWords);
              const preSpanValid =
                Boolean(preSpan) &&
                (!preSpan!.fuzzy ||
                  !isNoisyAliasSurface(preSpan!.matchedSurface) ||
                  hasSmartHomeDomainIntent(preSpan!.afterText));
              if (preSpanValid && owwScore >= 0.30) return true;
              const preMaskedCmd = extractMaskedNeoCommand(preZhText);
              if (preMaskedCmd && owwScore >= 0.36) return true;
              return false;
            };

            if (await checkPreRollStream(primaryStream)) {
              preRollWakeConfirmed = true;
            } else if (isMusicScene && altDenStream && (await checkPreRollStream(altDenStream))) {
              preRollWakeConfirmed = true;
            }
          }
        }

        // Re-check third-person on potentially refined tail text
        if (hasThirdPersonWithNoSeparateWakeCommand(bestText, wakeWords)) {
          segResults.push({
            segment: seg,
            speakerId,
            embedding: segEmb,
            transcript: bestText,
            effectiveText: bestText,
            altText,
            asrEvent: bestEvent,
            decision: {
              accept: false,
              wokeOnly: false,
              addressed: false,
              inConversation: dialogCtx.inConversation ?? false,
              confidence: 0.94,
              stage: "pragmatic-reject",
              reason: "尾段检测到第三人称提及语境，已拦截",
              wakeWord: null,
              command: "",
              usedLlm: false,
              latencyMs: 0,
            },
            wakeSource: "none",
            owwScore,
            enHeadText,
            hasSmartHome: hasSmartHomeDomainIntent(bestText),
            isThirdPerson: true,
            isPureSinging: false,
          });
          continue;
        }

        // 4E. Strict Acoustic-Semantic Rewrite & Noisy-Alias Gating
        let effectiveText = bestText;
        let wakeSource: SegmentEvalResult["wakeSource"] = "none";
        const curSpan = findWakeWordSpan(bestText, wakeWords);
        const startsWithAmbiguousZh = AMBIGUOUS_ZH_PREFIX_RE.test(bestText);
        const endsWithQuestionParticle = QUESTION_TAIL_RE.test(bestText);

        if (curSpan && !curSpan.fuzzy) {
          wakeSource = "exact-text";
          // Clause-prefix isolation: strip unrelated prior sentence before punctuation + exact wake + smart-home cmd
          if (curSpan.index > 0 && hasSmartHomeDomainIntent(curSpan.afterText)) {
            const beforeRaw = bestText.slice(0, curSpan.index).trimEnd();
            if (/[。！？!?，,;；]$/.test(beforeRaw)) {
              effectiveText = bestText.slice(curSpan.index).trim();
            }
          }
          // Trailing vocative: "打开客厅灯，Neo" -> "Neo，打开客厅灯"
          if (
            curSpan.afterText.length === 0 &&
            curSpan.beforeText.length >= 2 &&
            hasSmartHomeDomainIntent(curSpan.beforeText) &&
            looksLikeDirectDeviceCommand(curSpan.beforeText) &&
            !QUESTION_TAIL_RE.test(curSpan.beforeText) &&
            !/(?:那个|这个|刚才|昨天|今天|跟|和|提到|聊到|别管|别理)/.test(curSpan.beforeText)
          ) {
            effectiveText = `${curSpan.wakeWord}，${curSpan.beforeText}`;
          }
        } else if (curSpan && curSpan.fuzzy && isNoisyAliasSurface(curSpan.matchedSurface)) {
          // Strict gate for noisy aliases ("你好" / "你有" / "你给" / "new" / "near" / ...)
          const aliasCmdHasDomain = hasSmartHomeDomainIntent(curSpan.afterText);
          if (!aliasCmdHasDomain || (startsWithAmbiguousZh && endsWithQuestionParticle)) {
            // Hard-block non-smart-home noisy-alias false triggers (e.g. "你好，帮我递水")
            segResults.push({
              segment: seg,
              speakerId,
              embedding: segEmb,
              transcript: bestText,
              effectiveText: bestText,
              altText,
              asrEvent: bestEvent,
              decision: {
                accept: false,
                wokeOnly: false,
                addressed: false,
                inConversation: dialogCtx.inConversation ?? false,
                confidence: 0.92,
                stage: "pragmatic-reject",
                reason: `模糊别名「${curSpan.matchedSurface}」后缺乏智能家居设备意图，已严格拦截`,
                wakeWord: null,
                command: "",
                usedLlm: false,
                latencyMs: 0,
              },
              wakeSource: "none",
              owwScore,
              enHeadText,
              hasSmartHome: false,
              isThirdPerson: false,
              isPureSinging: false,
            });
            continue;
          }

          // Smart-home intent IS present after noisy alias:
          // Upgrade to canonical wake only with strong en-US exact confirmation or OWW match;
          // otherwise let evaluateVoiceAttention enforce acoustic veto.
          if (enHit && !enHit.fuzzy) {
            effectiveText = `${enHit.wakeWord}，${curSpan.afterText}`;
            wakeSource = "en-probe";
          } else if (owwHit?.matched || (enHit && owwScore >= 0.32)) {
            effectiveText = `${curSpan.wakeWord}，${curSpan.afterText}`;
            wakeSource = owwHit?.matched ? "oww" : "en-probe";
          } else {
            wakeSource = "fuzzy-text";
          }
        } else if (enHit || owwHit?.matched || preRollWakeConfirmed) {
          const targetWake = enHit?.wakeWord ?? owwHit?.wakeWord ?? targetWakeDefault;
          const extracted = extractCommandAfterAcousticWake(bestText, targetWake);
          const extractedDomain = hasSmartHomeDomainIntent(extracted);
          const extractedDirect = looksLikeDirectDeviceCommand(extracted);
          const isExactEn = Boolean(enHit && !enHit.fuzzy);

          // Never promote ambiguous Chinese greeting/pronoun sentences without smart-home intent
          const blockedAmbiguous =
            startsWithAmbiguousZh && (!extractedDomain || endsWithQuestionParticle);

          if (!blockedAmbiguous) {
            if (extracted.length >= 2 && !isWakeQueryText(extracted)) {
              const allowCmdPromote =
                (isExactEn &&
                  (extractedDomain ||
                    (extractedDirect && !isHouseholdSidetalkInConversation(extracted)) ||
                    owwHit?.matched)) ||
                (Boolean(enHit?.fuzzy) &&
                  extractedDomain &&
                  (owwScore >= 0.30 || (!startsWithAmbiguousZh && extractedDirect))) ||
                (Boolean(owwHit?.matched) && extractedDomain) ||
                (preRollWakeConfirmed && extractedDomain && SMART_HOME_ACTION_RE.test(extracted));

              if (allowCmdPromote) {
                effectiveText = `${targetWake}，${extracted}`;
                wakeSource = enHit ? "en-probe" : "oww";
              }
            } else if (
              (extracted.length === 0 || isWakeQueryText(extracted)) &&
              isPureShortWakeResidue(bestText, segDurSec) &&
              (isExactEn || Boolean(owwHit?.matched))
            ) {
              effectiveText = targetWake;
              wakeSource = enHit ? "en-probe" : "oww";
            }
          }
        } else if (curSpan && curSpan.fuzzy) {
          // Non-noisy homophone (e.g. "尼奥", "Neil")
          wakeSource = "fuzzy-text";
        } else if (owwScore >= 0.36 && !startsWithAmbiguousZh) {
          // Nasal-masked Mandarin phonetic residue ("Neo" -> "有"/"友"/"钮" right before smart-home action)
          // backed by openWakeWord acoustic score >= 0.36
          const maskedCmd = extractMaskedNeoCommand(bestText);
          if (maskedCmd) {
            effectiveText = `${targetWakeDefault}，${maskedCmd}`;
            wakeSource = "oww";
          }
        }

        // 4F. Evaluate with MijiaDeck's runtime voiceAttentionGate
        const effectiveEvent =
          isMusicScene && !bestEvent.toUpperCase().includes("BGM")
            ? `${bestEvent}<|BGM|>`
            : bestEvent;

        let decision = await evaluateVoiceAttention({
          ...dialogCtx,
          rawText: effectiveText,
          altText: altText || undefined,
          acousticEvent: effectiveEvent,
          acousticWake: owwHit,
          owwActiveForWord: engine.openWakeWord.isReady,
        });

        // Additional post-attention strict verifiers for conversation mode & echo safety
        if (decision.accept) {
          // 1. Conversation mode without wake word: reject singing lyrics, household sidetalk, and assistant-phrasing echo
          if (!decision.wakeWord && dialogCtx.inConversation) {
            const cmd = decision.command.trim();
            if (
              scene.singingProb >= 0.12 &&
              scene.speechProb < 0.25 &&
              !hasSmartHomeDomainIntent(cmd)
            ) {
              decision = {
                ...decision,
                accept: false,
                addressed: false,
                command: "",
                stage: "acoustic",
                reason: "连续对话窗口内歌声歌词过滤，已拦截",
              };
            } else if (isHouseholdSidetalkInConversation(cmd)) {
              decision = {
                ...decision,
                accept: false,
                addressed: false,
                command: "",
                stage: "pragmatic-reject",
                reason: "连续对话窗口内识别为家庭日常旁白，已拦截",
              };
            } else if (
              dialogCtx.lastSpokenReply &&
              ASSISTANT_ECHO_PREFIX_RE.test(cmd) &&
              computeEchoOverlap(cmd, dialogCtx.lastSpokenReply) >= 0.45
            ) {
              decision = {
                ...decision,
                accept: false,
                addressed: false,
                command: "",
                stage: "echo",
                reason: "检测到助手播报句式回声残片，已拦截",
              };
            } else {
              wakeSource = "conversation";
            }
          }

          // 2. Trim any trailing song lyrics/chatter in music scenes
          if (decision.accept && !decision.wokeOnly && isMusicScene) {
            const cleanedCmd = trimTrailingMusicLyrics(decision.command);
            if (cleanedCmd) {
              decision = { ...decision, command: cleanedCmd };
            }
          }
        }

        segResults.push({
          segment: seg,
          speakerId,
          embedding: segEmb,
          transcript: bestText,
          effectiveText,
          altText,
          asrEvent: bestEvent,
          decision,
          wakeSource,
          owwScore,
          enHeadText,
          hasSmartHome: hasSmartHomeDomainIntent(decision.command || effectiveText),
          isThirdPerson: false,
          isPureSinging: false,
        });
      }

      // 4G. Same-speaker split-wake stitch & continuation recovery
      // (Handles brief pauses like "Neo..." [0.4s pause] "打开客厅吸顶灯" by the SAME speaker)
      for (let i = 0; i < segResults.length - 1; i += 1) {
        const cur = segResults[i]!;
        const next = segResults[i + 1]!;
        const gapSec = next.segment.startSec - cur.segment.endSec;
        if (gapSec < -0.2 || gapSec > 1.35) continue;
        if (next.isThirdPerson || next.isPureSinging || !next.transcript) continue;

        const sim =
          cur.embedding && next.embedding
            ? cosineSimilarity(cur.embedding, next.embedding)
            : cur.speakerId === next.speakerId
              ? 0.6
              : 0.4;
        const curDur = cur.segment.endSec - cur.segment.startSec;
        const compatibleSpeaker =
          cur.speakerId === next.speakerId || (curDur < 0.9 && sim >= 0.28);

        // Case 1: Pure wake segment followed immediately by same-speaker command
        if (
          cur.decision.accept &&
          cur.decision.wokeOnly &&
          !next.decision.accept &&
          compatibleSpeaker
        ) {
          const nextClean = next.transcript.replace(PUNCT_STRIP_RE, "").trim();
          if (
            nextClean.length >= 2 &&
            !EXPLICIT_EXIT_RE.test(nextClean) &&
            !isHouseholdSidetalkInConversation(next.transcript) &&
            (hasSmartHomeDomainIntent(next.transcript) ||
              looksLikeDirectDeviceCommand(next.transcript))
          ) {
            const wake = cur.decision.wakeWord ?? wakeWords[0] ?? "Neo";
            const stitchedText = `${wake}，${next.transcript}`;
            const stitchedDecision = await evaluateVoiceAttention({
              ...dialogCtx,
              rawText: stitchedText,
              acousticEvent: isMusicScene ? "<|BGM|>" : next.asrEvent,
              acousticWake: null,
              owwActiveForWord: false,
            });
            if (stitchedDecision.accept && !stitchedDecision.wokeOnly) {
              cur.decision = isMusicScene
                ? {
                    ...stitchedDecision,
                    command: trimTrailingMusicLyrics(stitchedDecision.command),
                  }
                : stitchedDecision;
              cur.effectiveText = stitchedText;
              cur.hasSmartHome = hasSmartHomeDomainIntent(cur.decision.command);
            }
          }
        }

        // Case 2: Same speaker multi-clause command continuation across brief <=0.5s pause
        if (
          cur.decision.accept &&
          !cur.decision.wokeOnly &&
          !next.decision.accept &&
          gapSec <= 0.5 &&
          sim >= 0.50 &&
          CONTINUATION_CLAUSE_RE.test(next.transcript.trim()) &&
          (hasSmartHomeDomainIntent(next.transcript) || CONVERSATION_CONTROL_RE.test(next.transcript))
        ) {
          const mergedCmd = `${cur.decision.command}，${next.transcript.trim()}`;
          cur.decision = {
            ...cur.decision,
            command: isMusicScene ? trimTrailingMusicLyrics(mergedCmd) : mergedCmd,
          };
          cur.hasSmartHome = hasSmartHomeDomainIntent(cur.decision.command);
        }
      }
      const asrMs = Math.round(performance.now() - tAsr);

      // ==================== Stage 5: Pick Cleanest Accepted Command & Sound-Type Fusion ====================
      const acceptedResults = segResults.filter((r) => r.decision.accept);

      let winner: SegmentEvalResult | null = null;
      if (acceptedResults.length > 0) {
        const rankAccepted = (r: SegmentEvalResult): number => {
          let score = r.decision.confidence * 25;
          if (!r.decision.wokeOnly && r.decision.command.trim().length >= 2) {
            score += 45;
            if (hasSmartHomeDomainIntent(r.decision.command)) score += 35;
          }
          if (r.wakeSource === "exact-text") score += 36;
          else if (r.wakeSource === "en-probe") score += 28;
          else if (r.wakeSource === "oww") score += 22;
          else if (r.wakeSource === "conversation") score += 18;
          else if (r.wakeSource === "fuzzy-text") score += 10;

          // Prefer concise, cleanly isolated commands without leakage bloat
          const cmdLen = r.decision.command.replace(PUNCT_STRIP_RE, "").length;
          if (cmdLen > 28) score -= (cmdLen - 28) * 1.5;
          return score;
        };

        acceptedResults.sort((a, b) => rankAccepted(b) - rankAccepted(a));
        winner = acceptedResults[0]!;
      }

      // In strong music scenes with >= 2 segments, run ~15ms CED-tiny on non-accepted segments
      // of raw HP audio to distinguish singing vocals ("song") from a genuine second human speaker
      if (scene.musicProb >= 0.35 && segResults.length >= 2) {
        for (const r of segResults) {
          if (r.isPureSinging || r.decision.accept) continue;
          const rawSeg = hpRaw.subarray(
            Math.min(r.segment.startSample, hpRaw.length),
            Math.min(r.segment.endSample, hpRaw.length),
          );
          if (rawSeg.length < 4800) continue;
          const segScene = pool.analyzeAudioScene(rawSeg, 15);
          const hasLyrics = r.transcript.replace(PUNCT_STRIP_RE, "").length >= 2;
          const isMusicDominatedVocal =
            segScene.musicProb >= 0.65 &&
            segScene.musicProb >= segScene.speechProb * 2.0 &&
            !r.hasSmartHome &&
            hasLyrics &&
            (r.asrEvent.toUpperCase().includes("BGM") || segScene.singingProb >= 0.02);
          if (segScene.singingProb >= 0.05 || isMusicDominatedVocal) {
            detectedSuppressedSong = true;
          }
          if (
            (segScene.singingProb >= 0.05 && segScene.speechProb < 0.28) ||
            (segScene.musicProb >= 0.55 && segScene.speechProb < 0.16 && !r.hasSmartHome) ||
            isMusicDominatedVocal
          ) {
            r.isPureSinging = true;
          }
        }
      }

      // Compute final speaker count from valid non-singing speech segments
      const validSpeakerDurations = new Map<string, number>();
      for (const r of segResults) {
        if (r.isPureSinging) continue;
        const dur = r.segment.endSec - r.segment.startSec;
        const hasText = r.transcript.replace(PUNCT_STRIP_RE, "").length >= 1 || r.decision.accept;
        if (!hasText && dur < 0.5) continue;
        validSpeakerDurations.set(r.speakerId, (validSpeakerDurations.get(r.speakerId) ?? 0) + dur);
      }
      let detectedSpeakerCount = 0;
      for (const dur of validSpeakerDurations.values()) {
        if (dur >= 0.42) detectedSpeakerCount += 1;
      }
      if (detectedSpeakerCount === 0 && (winner || segResults.some((r) => !r.isPureSinging && r.transcript.length > 0))) {
        detectedSpeakerCount = 1;
      }

      // Assemble multi-cue detected sound types
      const soundTypeSet = new Set<SoundTypeLabel>(scene.detectedSoundTypes);
      const hasRealSpeech =
        Boolean(winner) ||
        scene.speechProb >= 0.14 ||
        segResults.some((r) => !r.isPureSinging && r.transcript.replace(PUNCT_STRIP_RE, "").length >= 2);
      if (hasRealSpeech) {
        soundTypeSet.add("speech");
      } else if (scene.singingProb >= 0.12 && scene.speechProb < 0.14) {
        soundTypeSet.delete("speech");
      }

      if (scene.singingProb >= 0.055 || detectedSuppressedSong) soundTypeSet.add("song");
      if (isMusicScene || (anyBgmEvent && scene.musicProb >= 0.06 && scene.noiseProb < 0.25)) {
        soundTypeSet.add("bgm");
      }
      if (isNoiseScene) {
        soundTypeSet.add("noise");
      }
      if (detectedSpeakerCount >= 2) {
        soundTypeSet.add("multi_speaker");
      }

      const separatedStreams: SeparatedStreamSummary[] = segResults.map((r, i) => ({
        streamId: `seg_${i}_${r.speakerId}`,
        kind: r.isPureSinging ? "song_vocals" : detectedSpeakerCount >= 2 ? "speaker" : "speech",
        speakerId: r.speakerId,
        startSec: r.segment.startSec,
        endSec: r.segment.endSec,
        transcript: r.effectiveText || r.transcript,
      }));

      if (winner) {
        return {
          isNeoCommand: true,
          wokeOnly: winner.decision.wokeOnly,
          command: winner.decision.command,
          rawTranscript: winner.effectiveText || winner.transcript,
          detectedSoundTypes: [...soundTypeSet],
          detectedSpeakerCount,
          separatedStreams,
          attentionStage: winner.decision.stage,
          attentionReason: winner.decision.reason,
          latencyMs: Math.round(performance.now() - t0),
          stageTimingsMs: { sceneMs, denoiseMs, splitMs, asrMs },
        };
      }

      // Select most informative rejection reason
      const priorityStageRank = (stage: string): number => {
        if (stage === "echo") return 5;
        if (stage === "exit") return 4;
        if (stage === "pragmatic-reject") return 3;
        if (stage === "acoustic-veto") return 2;
        if (stage === "acoustic") return 1;
        return 0;
      };
      const bestRejected = [...segResults].sort(
        (a, b) => priorityStageRank(b.decision.stage) - priorityStageRank(a.decision.stage),
      )[0];

      const joinedRaw = segResults
        .map((r) => r.transcript)
        .filter(Boolean)
        .join(" | ");

      return {
        isNeoCommand: false,
        wokeOnly: false,
        command: "",
        rawTranscript: joinedRaw,
        detectedSoundTypes: [...soundTypeSet],
        detectedSpeakerCount,
        separatedStreams,
        attentionStage: bestRejected?.decision.stage ?? "no-wake",
        attentionReason: bestRejected?.decision.reason ?? "所有分段均未触发有效 Neo 指令",
        latencyMs: Math.round(performance.now() - t0),
        stageTimingsMs: { sceneMs, denoiseMs, splitMs, asrMs },
      };
    },
  };
}
