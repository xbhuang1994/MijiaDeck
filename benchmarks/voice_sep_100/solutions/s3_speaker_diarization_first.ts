// SPDX-License-Identifier: GPL-3.0-or-later
// Solution S3: Neural Speaker Diarization First (Pyannote 3.0 + 3D-Speaker CAM++) -> Per-Speaker Isolated ASR & Attention
// 严格遵守评测完整性：绝不读取 input.clip 上任何 ground-truth 标注字段，仅使用音频信号与 buildRuntimeDialogContext 运行时上下文。

import { cosineSimilarity, l2Normalize } from "../../../src/agent/audioPcm.ts";
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
  type DiarizationSegment,
  type MusicSeparationResult,
  type SceneAnalysis,
  type SharedVoiceModelPool,
} from "../shared_models.ts";
import {
  applyHighPassFilter,
  buildRuntimeDialogContext,
  computeRms,
  extractTimedVadSegments,
  hasAudibleEnergy,
  hasSmartHomeDomainIntent,
  isThirdPersonNeoMention,
  type TimedVadSegment,
} from "./common_utils.ts";

const SAMPLE_RATE = 16000;
const PYANNOTE_CLUSTER_THRESHOLD = 0.52;
const CAMPP_DISTINCT_THRESHOLD = 0.48;
const CAMPP_DISTINCT_MUSIC_THRESHOLD = 0.42;
const CAMPP_SHORT_DISTINCT_THRESHOLD = 0.4;
const CAMPP_SAME_SPEAKER_MERGE_THRESHOLD = 0.68;

const AMBIGUOUS_FUZZY_ZH_WAKE_SURFACES = new Set<string>([
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
]);

const AMBIGUOUS_INTERROGATIVE_PREFIX_RE = /^(?:你有|你又|你好|您好|你给)/;
const INTERROGATIVE_TAIL_RE = /[吗嘛么呢][。？！!?\s]*$/;
const PURE_ZH_FILLER_OR_GREETING_RE =
  /^(?:你好|您好|好的?|谢谢|嗯+|啊+|哦+|喔+|哈+|呵+|喂|嘿|行了?|可以了?|算了|没事了?|不用了?|再见|拜拜)$/i;
const WEIRD_SCRIPT_RE = /[\u3040-\u30ff\uac00-\ud7af]/;
const NON_DEVICE_CHORE_RE =
  /(?:喝水|杯水|那杯水|递过来|递一下|拿一下|拿双|筷子|碗|洗水果|切水果|吃米饭|吃面条|吃什么|晚饭|午饭|早饭|外卖|快递|衣服|鞋子|垃圾|作业|上班|下班|出门|超市|买菜|钥匙|钱包|手机壳)/;
const LEADING_CONV_CONNECTIVE_RE = /^(?:那|还有|另外|然后|对了|顺便再|再帮我|帮我再|也把)[\s,，、]*/;
const CONV_ACTION_VERB_RE =
  /(?:打开|开启|关闭|关掉|关上|关了|开一下|关一下|调到|调成|调高|调低|调大|调小|调亮|调暗|设置|设定|设为|改成|换成|切换|暂停|继续|停止|静音|取消静音|播放|放一首|换一首|下一首|上一首|亮一点|暗一点|大一点|小一点|高一点|低一点|暖一点|冷一点|出粮|喂|查|看看)/;
const MEANINGFUL_STRIP_RE = /[\s,，。．.、!！?？:：;；\-—~～"'“”‘’()（）[\]【】]/g;

interface SpeakerTurn {
  speaker: number;
  startSec: number;
  endSec: number;
  overlapped: boolean;
  embedding: number[] | null;
}

interface EvaluatedTurn {
  turn: SpeakerTurn;
  turnIndex: number;
  rawTranscript: string;
  normalizedTranscript: string;
  altTranscript: string;
  acousticEvent: string;
  acousticWake: WakeWordAcousticHit | null;
  enHeadHit: { wakeWord: string; matchedSurface: string; fuzzy: boolean } | null;
  decision: AttentionDecision;
  energyRatio: number;
  meaningfulTextLen: number;
  isSingingOnlyTurn: boolean;
  isThirdPerson: boolean;
  asrMs: number;
  probeMs: number;
  owwMs: number;
  attentionMs: number;
}

function slicePcmWindow(
  pcm16k: Float32Array,
  startSec: number,
  endSec: number,
  padBeforeSec = 0.12,
  padAfterSec = 0.14,
): Float32Array {
  const s = Math.max(0, Math.floor((startSec - padBeforeSec) * SAMPLE_RATE));
  const e = Math.min(pcm16k.length, Math.ceil((endSec + padAfterSec) * SAMPLE_RATE));
  if (e <= s) return new Float32Array(0);
  return pcm16k.slice(s, e);
}

function stripPunct(text: string): string {
  return text.replace(MEANINGFUL_STRIP_RE, "").trim();
}

function isAmbiguousInterrogative(text: string): boolean {
  const trimmed = text.trim();
  if (!AMBIGUOUS_INTERROGATIVE_PREFIX_RE.test(trimmed)) return false;
  if (!INTERROGATIVE_TAIL_RE.test(trimmed)) return false;
  const rest = trimmed.replace(AMBIGUOUS_INTERROGATIVE_PREFIX_RE, "").replace(/^[\s,，、!！。:：]+/, "");
  return !isWakeQueryText(rest);
}

function overlapSeconds(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

function averageEmbeddings(embeddings: readonly number[][]): number[] | null {
  if (embeddings.length === 0) return null;
  const dim = embeddings[0]!.length;
  const sum = new Float32Array(dim);
  for (const emb of embeddings) {
    if (emb.length !== dim) continue;
    for (let i = 0; i < dim; i += 1) {
      sum[i] = sum[i]! + emb[i]!;
    }
  }
  return l2Normalize(sum);
}

function extractCamppEmbedding(
  pool: SharedVoiceModelPool,
  audio16k: Float32Array,
  startSec: number,
  endSec: number,
): number[] | null {
  const seg = slicePcmWindow(audio16k, startSec, endSec, 0.03, 0.03);
  if (seg.length < 4000 || computeRms(seg) < 0.007) return null;
  const res = pool.localEngine.extractSpeakerEmbedding(seg, SAMPLE_RATE);
  return res.engine === "3dspeaker-campplus" ? res.embedding : null;
}

/**
 * 结合 Pyannote 3.0 说话人日志、Silero VAD 停顿切分与 3D-Speaker CAM++ 声纹余弦相似度（<0.48 判为不同说话人），
 * 构建精准且可抵御短句漏检与相邻说话人合并的说话人轮次表。
 */
function buildRefinedSpeakerTurns(params: {
  pool: SharedVoiceModelPool;
  cleanForDiar: Float32Array;
  fallbackSpeechTrack: Float32Array;
  clipDurationSec: number;
  scene: SceneAnalysis;
  isStrongMusic: boolean;
}): {
  turns: SpeakerTurn[];
  diarMs: number;
  vadMs: number;
  camppMs: number;
} {
  const { pool, cleanForDiar, fallbackSpeechTrack, clipDurationSec, scene, isStrongMusic } = params;
  const engine = pool.localEngine;
  const distinctThreshold = isStrongMusic ? CAMPP_DISTINCT_MUSIC_THRESHOLD : CAMPP_DISTINCT_THRESHOLD;

  const diarRes = pool.diarizeSpeakers(cleanForDiar, PYANNOTE_CLUSTER_THRESHOLD);
  const diarMs = diarRes.durationMs;

  const tVad = performance.now();
  let vadSegs: TimedVadSegment[] = extractTimedVadSegments(engine, cleanForDiar, {
    threshold: 0.34,
    minSilenceDuration: 0.2,
    minSpeechDuration: 0.12,
    padSec: 0.05,
    mergeGapSec: 0.1,
  });
  if (vadSegs.length === 0 && fallbackSpeechTrack !== cleanForDiar && hasAudibleEnergy(fallbackSpeechTrack, 0.006)) {
    vadSegs = extractTimedVadSegments(engine, fallbackSpeechTrack, {
      threshold: 0.36,
      minSilenceDuration: 0.2,
      minSpeechDuration: 0.12,
      padSec: 0.05,
      mergeGapSec: 0.1,
    });
  }
  const vadMs = Math.round(performance.now() - tVad);

  const tCampp = performance.now();

  // 清洗 Pyannote 原始分段（过滤极短或近静音伪影段）
  const pySegs: DiarizationSegment[] = diarRes.segments
    .map((s) => ({
      start: Math.max(0, Math.min(clipDurationSec, Number(s.start) || 0)),
      end: Math.max(0, Math.min(clipDurationSec, Number(s.end) || 0)),
      speaker: Number(s.speaker) || 0,
    }))
    .filter((s) => {
      if (s.end - s.start < 0.18) return false;
      const segClean = slicePcmWindow(cleanForDiar, s.start, s.end, 0.04, 0.04);
      const segFall = slicePcmWindow(fallbackSpeechTrack, s.start, s.end, 0.04, 0.04);
      return computeRms(segClean) >= 0.0045 || computeRms(segFall) >= 0.0065;
    })
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const clusterByCampp = (
    items: Array<{ startSec: number; endSec: number; embedding: number[] | null }>,
  ): SpeakerTurn[] => {
    const clusters: Array<{ id: number; embeddings: number[][]; centroid: number[] }> = [];
    const out: SpeakerTurn[] = [];

    for (const item of items) {
      const dur = item.endSec - item.startSec;
      const thresh = dur < 0.38 ? CAMPP_SHORT_DISTINCT_THRESHOLD : distinctThreshold;
      let assigned = -1;

      if (item.embedding) {
        let bestSim = -1;
        let bestClusterIdx = -1;
        for (let c = 0; c < clusters.length; c += 1) {
          const sim = cosineSimilarity(item.embedding, clusters[c]!.centroid);
          if (sim > bestSim) {
            bestSim = sim;
            bestClusterIdx = c;
          }
        }
        if (bestClusterIdx >= 0 && bestSim >= thresh) {
          const target = clusters[bestClusterIdx]!;
          target.embeddings.push(item.embedding);
          target.centroid = averageEmbeddings(target.embeddings) ?? target.centroid;
          assigned = target.id;
        } else {
          const newId = clusters.length;
          clusters.push({ id: newId, embeddings: [item.embedding], centroid: item.embedding });
          assigned = newId;
        }
      } else {
        // 极短段无法提取 CAM++，归入最近邻已有聚类或 0
        assigned = out.length > 0 ? out[out.length - 1]!.speaker : 0;
      }

      out.push({
        speaker: assigned,
        startSec: item.startSec,
        endSec: item.endSec,
        overlapped: false,
        embedding: item.embedding,
      });
    }

    return out;
  };

  let rawTurns: SpeakerTurn[] = [];

  if (pySegs.length === 0) {
    // 情况 1：Pyannote 漏检（例如 <0.8s 极短指令 "Neo关灯"）-> 回退 Silero VAD + CAM++ 声纹聚类
    if (vadSegs.length > 0) {
      const vadItems = vadSegs.map((v) => ({
        startSec: v.startSec,
        endSec: v.endSec,
        embedding: extractCamppEmbedding(pool, cleanForDiar, v.startSec, v.endSec),
      }));
      rawTurns = clusterByCampp(vadItems);
    } else if (
      hasAudibleEnergy(cleanForDiar, 0.007) ||
      (scene.speechProb >= 0.16 && hasAudibleEnergy(fallbackSpeechTrack, 0.008))
    ) {
      rawTurns = [
        {
          speaker: 0,
          startSec: 0,
          endSec: clipDurationSec,
          overlapped: false,
          embedding: extractCamppEmbedding(pool, cleanForDiar, 0, clipDurationSec),
        },
      ];
    } else {
      return {
        turns: [],
        diarMs,
        vadMs,
        camppMs: Math.round(performance.now() - tCampp),
      };
    }
  } else {
    // 情况 2：Pyannote 给出分段 -> 用 Silero VAD 细分被合并的停顿边界 + 补回 Pyannote 漏掉的短 VAD 段
    let nextSyntheticSpeaker = Math.max(...pySegs.map((s) => s.speaker), 0) + 1;

    for (const seg of pySegs) {
      const coveredVads = vadSegs.filter((v) => {
        const ov = overlapSeconds(seg.start, seg.end, v.startSec, v.endSec);
        const vDur = Math.max(0.01, v.endSec - v.startSec);
        return ov / vDur >= 0.5;
      });

      if (coveredVads.length >= 2) {
        const subEmbs = coveredVads.map((v) =>
          extractCamppEmbedding(pool, cleanForDiar, v.startSec, v.endSec),
        );
        // 检测该 Pyannote 段内部是否合并了两位不同说话人（相邻或首尾 CAM++ 余弦相似度 < threshold）
        let hasDistinctSpeakerInside = false;
        for (let i = 0; i < coveredVads.length; i += 1) {
          for (let j = i + 1; j < coveredVads.length; j += 1) {
            const ea = subEmbs[i];
            const eb = subEmbs[j];
            if (!ea || !eb) continue;
            const minDur = Math.min(
              coveredVads[i]!.endSec - coveredVads[i]!.startSec,
              coveredVads[j]!.endSec - coveredVads[j]!.startSec,
            );
            const thr = minDur < 0.38 ? CAMPP_SHORT_DISTINCT_THRESHOLD : distinctThreshold;
            if (cosineSimilarity(ea, eb) < thr) {
              hasDistinctSpeakerInside = true;
              break;
            }
          }
          if (hasDistinctSpeakerInside) break;
        }

        if (hasDistinctSpeakerInside) {
          // 内部按 CAM++ 重新聚类，确保两位被合并的说话人获得独立 speakerId
          const subClustered = clusterByCampp(
            coveredVads.map((v, idx) => ({
              startSec: v.startSec,
              endSec: v.endSec,
              embedding: subEmbs[idx] ?? null,
            })),
          );
          const localToGlobal = new Map<number, number>();
          for (const st of subClustered) {
            let gid = localToGlobal.get(st.speaker);
            if (gid === undefined) {
              gid = localToGlobal.size === 0 ? seg.speaker : nextSyntheticSpeaker++;
              localToGlobal.set(st.speaker, gid);
            }
            rawTurns.push({
              ...st,
              speaker: gid,
            });
          }
          continue;
        }

        // 即使说话人相同，若段较长且中间有明显停顿（>=0.28s），仍拆成同 speaker 的独立轮次以对齐句首唤醒探测
        const segDur = seg.end - seg.start;
        let maxPause = 0;
        for (let i = 1; i < coveredVads.length; i += 1) {
          maxPause = Math.max(maxPause, coveredVads[i]!.startSec - coveredVads[i - 1]!.endSec);
        }
        if (segDur >= 2.5 && maxPause >= 0.28) {
          for (let i = 0; i < coveredVads.length; i += 1) {
            const v = coveredVads[i]!;
            rawTurns.push({
              speaker: seg.speaker,
              startSec: v.startSec,
              endSec: v.endSec,
              overlapped: false,
              embedding: subEmbs[i] ?? null,
            });
          }
          continue;
        }
      }

      rawTurns.push({
        speaker: seg.speaker,
        startSec: seg.start,
        endSec: seg.end,
        overlapped: false,
        embedding: extractCamppEmbedding(pool, cleanForDiar, seg.start, seg.end),
      });
    }

    // 补回被 Pyannote 完全漏掉的短 VAD 语音段（如结尾或开头的短句 "Neo关灯"）
    for (const v of vadSegs) {
      const vDur = Math.max(0.01, v.endSec - v.startSec);
      if (vDur < 0.22) continue;
      const totalOv = rawTurns.reduce(
        (acc, t) => acc + overlapSeconds(t.startSec, t.endSec, v.startSec, v.endSec),
        0,
      );
      if (totalOv / vDur >= 0.3) continue;
      if (computeRms(v.samples) < 0.0075) continue;

      const emb = extractCamppEmbedding(pool, cleanForDiar, v.startSec, v.endSec);
      let matchedSpeaker = -1;
      if (emb) {
        let bestSim = -1;
        for (const t of rawTurns) {
          if (!t.embedding) continue;
          const sim = cosineSimilarity(emb, t.embedding);
          if (sim > bestSim) {
            bestSim = sim;
            matchedSpeaker = t.speaker;
          }
        }
        const thr = vDur < 0.38 ? CAMPP_SHORT_DISTINCT_THRESHOLD : distinctThreshold;
        if (bestSim < thr) {
          matchedSpeaker = nextSyntheticSpeaker++;
        }
      } else {
        matchedSpeaker = rawTurns.length > 0 ? rawTurns[0]!.speaker : 0;
      }

      rawTurns.push({
        speaker: matchedSpeaker,
        startSec: v.startSec,
        endSec: v.endSec,
        overlapped: false,
        embedding: emb,
      });
    }

    rawTurns.sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec);

    // 跨段 CAM++ 校正 1：若两个非重叠分段被 Pyannote 标成同一 speaker，但 CAM++ 余弦相似度 < threshold，则拆分说话人（支持 A-B-A 复归）
    const bySpeaker = new Map<number, SpeakerTurn[]>();
    for (const t of rawTurns) {
      const arr = bySpeaker.get(t.speaker) ?? [];
      arr.push(t);
      bySpeaker.set(t.speaker, arr);
    }
    for (const [, list] of bySpeaker) {
      if (list.length < 2) continue;
      const subClusters: Array<{ speakerId: number; embeddings: number[][]; centroid: number[] }> = [];
      for (const t of list) {
        if (!t.embedding) {
          if (subClusters.length > 0) t.speaker = subClusters[subClusters.length - 1]!.speakerId;
          continue;
        }
        const dur = t.endSec - t.startSec;
        const thr = dur < 0.38 ? CAMPP_SHORT_DISTINCT_THRESHOLD : distinctThreshold;
        let bestIdx = -1;
        let bestSim = -1;
        for (let i = 0; i < subClusters.length; i += 1) {
          const sim = cosineSimilarity(t.embedding, subClusters[i]!.centroid);
          if (sim > bestSim) {
            bestSim = sim;
            bestIdx = i;
          }
        }
        if (bestIdx >= 0 && bestSim >= thr) {
          const sc = subClusters[bestIdx]!;
          sc.embeddings.push(t.embedding);
          sc.centroid = averageEmbeddings(sc.embeddings) ?? sc.centroid;
          t.speaker = sc.speakerId;
        } else {
          const assignedId = subClusters.length === 0 ? t.speaker : nextSyntheticSpeaker++;
          subClusters.push({ speakerId: assignedId, embeddings: [t.embedding], centroid: t.embedding });
          t.speaker = assignedId;
        }
      }
    }

    // 跨段 CAM++ 校正 2：若两个不同 speaker 从未在时间上重叠，且双方 CAM++ 声纹中心高度一致 (>= 0.68)，合并避免过度切分
    const speakerIds = [...new Set(rawTurns.map((t) => t.speaker))];
    if (speakerIds.length >= 2) {
      const centroids = new Map<number, number[]>();
      for (const sid of speakerIds) {
        const embs = rawTurns
          .filter((t) => t.speaker === sid && t.embedding && t.endSec - t.startSec >= 0.42)
          .map((t) => t.embedding!);
        const c = averageEmbeddings(embs);
        if (c) centroids.set(sid, c);
      }

      const parent = new Map<number, number>(speakerIds.map((id) => [id, id]));
      const findRoot = (x: number): number => {
        let cur = x;
        while (parent.get(cur) !== cur) cur = parent.get(cur)!;
        return cur;
      };

      for (let i = 0; i < speakerIds.length; i += 1) {
        for (let j = i + 1; j < speakerIds.length; j += 1) {
          const a = speakerIds[i]!;
          const b = speakerIds[j]!;
          const ca = centroids.get(a);
          const cb = centroids.get(b);
          if (!ca || !cb) continue;

          // 检查两者是否存在时间重叠
          const turnsA = rawTurns.filter((t) => t.speaker === a);
          const turnsB = rawTurns.filter((t) => t.speaker === b);
          const hasOverlap = turnsA.some((ta) =>
            turnsB.some((tb) => overlapSeconds(ta.startSec, ta.endSec, tb.startSec, tb.endSec) >= 0.12),
          );
          if (hasOverlap) continue;

          if (cosineSimilarity(ca, cb) >= CAMPP_SAME_SPEAKER_MERGE_THRESHOLD) {
            const ra = findRoot(a);
            const rb = findRoot(b);
            if (ra !== rb) parent.set(rb, ra);
          }
        }
      }

      for (const t of rawTurns) {
        t.speaker = findRoot(t.speaker);
      }
    }
  }

  // 规范化 speaker ID 为 0..K-1，并标记重叠轮次
  rawTurns.sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec);
  const remap = new Map<number, number>();
  for (const t of rawTurns) {
    let idx = remap.get(t.speaker);
    if (idx === undefined) {
      idx = remap.size;
      remap.set(t.speaker, idx);
    }
    t.speaker = idx;
  }

  for (let i = 0; i < rawTurns.length; i += 1) {
    const a = rawTurns[i]!;
    for (let j = 0; j < rawTurns.length; j += 1) {
      if (i === j) continue;
      const b = rawTurns[j]!;
      if (a.speaker !== b.speaker && overlapSeconds(a.startSec, a.endSec, b.startSec, b.endSec) >= 0.15) {
        a.overlapped = true;
        break;
      }
    }
  }

  // 单轮次短音频边界保护：若单段已覆盖绝大部分短句且两端余量很小，自动扩展到全句避免吞掉句首轻声 "N"
  if (rawTurns.length === 1 && clipDurationSec <= 3.8) {
    const only = rawTurns[0]!;
    if (only.startSec <= 0.35 && clipDurationSec - only.endSec <= 0.35) {
      only.startSec = 0;
      only.endSec = clipDurationSec;
    }
  }

  return {
    turns: rawTurns,
    diarMs,
    vadMs,
    camppMs: Math.round(performance.now() - tCampp),
  };
}

interface ScoredTrackAsr {
  track: "vocals" | "denoised" | "raw";
  asr: LocalAsrOutput;
}

function pickBestTurnAsr(
  candidates: readonly ScoredTrackAsr[],
  wakeWords: readonly string[],
  options: {
    isStrongMusic: boolean;
    inputSnrDb: number;
    acousticWake: WakeWordAcousticHit | null;
  },
): { best: LocalAsrOutput; alt: LocalAsrOutput | null; anyThirdPerson: boolean } {
  const nonEmpty = candidates.filter((c) => c.asr.text.trim().length > 0);
  if (nonEmpty.length === 0) {
    const fallback: LocalAsrOutput = candidates[0]?.asr ?? {
      text: "",
      rawText: "",
      lang: "",
      emotion: "",
      event: "",
      engine: "sensevoice-local",
      durationMs: 0,
    };
    return { best: fallback, alt: null, anyThirdPerson: false };
  }

  const anyThirdPerson = nonEmpty.some((c) => isThirdPersonNeoMention(c.asr.text));

  const scoreCandidate = (cand: ScoredTrackAsr): number => {
    const text = cand.asr.text.trim();
    if (!text) return -100;
    let s = Math.min(18, text.length * 0.9);
    const isThird = isThirdPersonNeoMention(text);
    const span = findWakeWordSpan(text, wakeWords);

    if (isThird) {
      // 明确第三人称提及：保留真实语义轨，绝不给唤醒加分
      s += 16;
    } else if (span) {
      const cmdAfter = span.afterText.trim();
      const hasDomain = hasSmartHomeDomainIntent(cmdAfter);
      if (!span.fuzzy) {
        s += 110;
        if (cmdAfter && looksLikeDirectDeviceCommand(cmdAfter)) s += 42;
        if (hasDomain) s += 26;
        if (span.beforeText.length <= 2) s += 12;
      } else if (AMBIGUOUS_FUZZY_ZH_WAKE_SURFACES.has(span.matchedSurface)) {
        // 严格防误触：模糊 "你好" / "你有" 仅在具备智能家居领域意图且非日常问句时才加分
        if (hasDomain && !isAmbiguousInterrogative(text)) {
          s += 62;
        }
      } else {
        s += hasDomain || isWakeQueryText(cmdAfter) ? 68 : 24;
        if (cmdAfter && looksLikeDirectDeviceCommand(cmdAfter)) s += 28;
      }
    } else {
      if (looksLikeDirectDeviceCommand(text)) s += 22;
      if (hasSmartHomeDomainIntent(text)) s += 28;
      if (options.acousticWake?.matched) {
        const post = extractCommandAfterAcousticWake(text, options.acousticWake.wakeWord);
        if (post && looksLikeDirectDeviceCommand(post) && hasSmartHomeDomainIntent(post)) {
          s += 32;
        }
      }
    }

    if (cand.asr.event.toUpperCase().includes("SPEECH")) s += 10;
    if (options.isStrongMusic) {
      if (cand.track === "vocals") s += 12;
      else if (cand.track === "raw") s += 10;
    } else if (options.inputSnrDb < 15 && cand.track === "denoised") {
      s += 14;
    } else if (cand.track === "denoised") {
      s += 4;
    }

    const weird = text.match(/[\u3040-\u30ff\uac00-\ud7af]/g);
    if (weird && weird.length > 0) {
      s -= weird.length * 12;
    }
    return s;
  };

  const ranked = [...nonEmpty]
    .map((c) => ({ c, score: scoreCandidate(c) }))
    .sort((a, b) => b.score - a.score);

  const best = ranked[0]!.c.asr;
  const alt = ranked.find((r) => r.c.asr.text.trim() !== best.text.trim())?.c.asr ?? null;
  return { best, alt, anyThirdPerson };
}

function cleanCommandForMusicOrOverlap(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) return "";
  const parts = trimmed
    .split(/[，,。！？!?;；]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length <= 1) return trimmed;
  // 若首句本身已是完整设备意图，则安全裁掉尾随歌词/旁白
  if (hasSmartHomeDomainIntent(parts[0]!) || looksLikeDirectDeviceCommand(parts[0]!)) {
    return trimTrailingMusicLyrics(trimmed);
  }
  // 若首句只是短过渡语而次句含智能家居意图，则从次句起保留设备指令
  if (parts.length >= 2 && hasSmartHomeDomainIntent(parts[1]!)) {
    return trimTrailingMusicLyrics(parts.slice(1).join("，"));
  }
  return trimmed;
}

export function createSolutionS3(pool: SharedVoiceModelPool): VoiceSolution {
  return {
    id: "s3_speaker_diarization_first",
    name: "S3: Speaker Diarization First (Pyannote 3.0 + CAM++ -> Isolated ASR)",
    description:
      "神经说话人分离优先架构：并行 CED-tiny 场景感知 + DPDFNet4/GTCRN 降噪 + 条件 Spleeter 人声分离 -> Pyannote 3.0 + Silero VAD + CAM++ (<0.48) 说话人轮次切分 -> 按说话人独立切片执行 SenseVoice、轮次句首对齐 en-US 探针 (0..1.15s/0..0.65s)、openWakeWord 打分与 DDSD 注意力门控。",

    async init(): Promise<void> {
      pool.ensureCedTagger();
      pool.ensureDiarizer(PYANNOTE_CLUSTER_THRESHOLD);
      pool.ensureSpleeter();
      // 预热 DPDFNet4 与 SenseVoice en-US 探针，避免首条音频冷启动毛刺
      const tinySilence = new Float32Array(1600);
      pool.localEngine.denoise(tinySilence, SAMPLE_RATE, "dpdfnet");
      try {
        await pool.localEngine.transcribeLocal(tinySilence, SAMPLE_RATE, "en-US");
      } catch {
        // 忽略冷启动预热异常
      }
    },

    async process(input: SolutionRunInput): Promise<SolutionRunOutput> {
      const t0 = performance.now();
      const engine = pool.localEngine;
      const { clip, pcm16k, wakeWords } = input;
      const clipDurationSec = pcm16k.length / SAMPLE_RATE;
      const rawRms = Math.max(1e-6, computeRms(pcm16k));

      // 运行时对话上下文（严禁访问 clip 上任何 ground-truth 字段！）
      const dialogCtx = buildRuntimeDialogContext(clip, wakeWords);
      const inConversation = dialogCtx.dialogState === "conversation";
      const asciiWakes = wakeWords
        .map((w) => w.trim())
        .filter((w) => /^[a-z][a-z0-9\s-]*$/i.test(w));

      // ==================== Stage 1: 并行场景标注 + 语音增强 + 条件音乐人声分离 + 说话人分离 ====================
      const scene = pool.analyzeAudioScene(pcm16k);
      const acoustics = computeAcousticDiagnostics(pcm16k);
      const hpRaw = applyHighPassFilter(pcm16k, SAMPLE_RATE, 85);

      const dpdf = engine.denoise(pcm16k, SAMPLE_RATE, "dpdfnet");
      const gtcrn = engine.denoise(pcm16k, SAMPLE_RATE, "auto");

      const isStrongMusic = scene.musicProb >= 0.22 || scene.singingProb >= 0.08;
      let spleeter: MusicSeparationResult | null = null;
      let vocalsDenoised: Float32Array | null = null;
      let vocalsScene: SceneAnalysis | null = null;
      let spleeterDenoiseMs = 0;

      if (isStrongMusic) {
        spleeter = pool.separateMusicStems(pcm16k, "spleeter");
        if (spleeter && hasAudibleEnergy(spleeter.vocals16k, 0.004)) {
          // 在 Spleeter 剥离伴奏后对人声 stem 用轻量 GTCRN 清理残留音乐伪影（比二次 DPDFNet4 快 ~5x 且更少削弱辅音）
          const vocGtcrn = engine.denoise(spleeter.vocals16k, SAMPLE_RATE, "auto");
          spleeterDenoiseMs = vocGtcrn.durationMs;
          vocalsDenoised = hasAudibleEnergy(vocGtcrn.samples, 0.004)
            ? vocGtcrn.samples
            : spleeter.vocals16k;
          // 在去除伴奏的 vocals stem 上补充轻量 CED 歌声检测（避免强伴奏或人声命令稀释 singingProb）
          vocalsScene = pool.analyzeAudioScene(spleeter.vocals16k, 15);
        }
      }

      const effectiveSingingProb = Math.max(scene.singingProb, vocalsScene?.singingProb ?? 0);

      // 供 Pyannote 说话人分离使用的干净人声轨：强音乐场景优先送去噪后的人声 stem，防止伴奏干扰 Pyannote
      const primaryCleanTrack: Float32Array =
        vocalsDenoised ??
        (hasAudibleEnergy(dpdf.samples, 0.0045)
          ? dpdf.samples
          : hasAudibleEnergy(gtcrn.samples, 0.0045)
            ? gtcrn.samples
            : hpRaw);

      const fallbackSpeechTrack: Float32Array = hasAudibleEnergy(gtcrn.samples, 0.005)
        ? gtcrn.samples
        : hpRaw;

      const { turns, diarMs, vadMs, camppMs } = buildRefinedSpeakerTurns({
        pool,
        cleanForDiar: primaryCleanTrack,
        fallbackSpeechTrack,
        clipDurationSec,
        scene,
        isStrongMusic,
      });

      // ==================== Stage 2: 按说话人轮次独立切片 ASR + 句首对齐唤醒 + 注意力门控 ====================
      const evaluatedTurns: EvaluatedTurn[] = [];
      let totalAsrMs = 0;
      let totalProbeMs = 0;
      let totalOwwMs = 0;
      let totalAttentionMs = 0;

      for (let idx = 0; idx < turns.length; idx += 1) {
        const turn = turns[idx]!;
        const turnDurSec = Math.max(0.05, turn.endSec - turn.startSec);

        // 对本说话人轮次按 [start - 0.12s, end + 0.14s] 切片干净增强轨与原始高通轨
        const turnClean = slicePcmWindow(primaryCleanTrack, turn.startSec, turn.endSec, 0.12, 0.14);
        const turnRawHp = slicePcmWindow(hpRaw, turn.startSec, turn.endSec, 0.12, 0.14);
        const turnDpdf =
          primaryCleanTrack !== dpdf.samples
            ? slicePcmWindow(dpdf.samples, turn.startSec, turn.endSec, 0.12, 0.14)
            : null;

        if (!hasAudibleEnergy(turnClean, 0.004) && !hasAudibleEnergy(turnRawHp, 0.005)) {
          continue;
        }

        const turnRms = computeRms(turnRawHp);
        const energyRatio = Math.min(1, turnRms / rawRms);

        // 若整体含歌声/音乐，对本轮次做局部 CED 场景判别，精确区分歌声歌词段与真实人声指令段
        const turnScene: SceneAnalysis =
          (scene.singingProb >= 0.07 || scene.musicProb >= 0.2) && turnRawHp.length >= 6400
            ? pool.analyzeAudioScene(turnRawHp, 15)
            : scene;

        // 2A. 轮次句首对齐的 openWakeWord 声学打分（对齐本说话人轮次起点 0s！）
        const tOww = performance.now();
        let turnAcousticWake: WakeWordAcousticHit | null = null;
        const owwClean = engine.scoreWakeWordAudio(turnClean, wakeWords, {
          threshold: 0.6,
          headOnlySec: 2.0,
        });
        turnAcousticWake = owwClean;
        if (!turnAcousticWake || !turnAcousticWake.matched) {
          const owwRaw = engine.scoreWakeWordAudio(turnRawHp, wakeWords, {
            threshold: 0.6,
            headOnlySec: 2.0,
          });
          if (owwRaw && (!turnAcousticWake || owwRaw.score > turnAcousticWake.score)) {
            turnAcousticWake = owwRaw;
          }
        }
        if (isStrongMusic && (!turnAcousticWake || !turnAcousticWake.matched) && turnDpdf) {
          const owwDpdf = engine.scoreWakeWordAudio(turnDpdf, wakeWords, {
            threshold: 0.6,
            headOnlySec: 2.0,
          });
          if (owwDpdf && (!turnAcousticWake || owwDpdf.score > turnAcousticWake.score)) {
            turnAcousticWake = owwDpdf;
          }
        }
        const owwMs = Math.round(performance.now() - tOww);
        totalOwwMs += owwMs;

        // 2B. 独立 SenseVoice ASR（zh-CN/auto）：先解干净增强轨，必要时并行/补跑原始高通轨择优
        const tAsr = performance.now();
        const trackResults: ScoredTrackAsr[] = [];
        const cleanTrackKind: ScoredTrackAsr["track"] = vocalsDenoised ? "vocals" : "denoised";

        if (!isStrongMusic && dpdf.inputSnrDb >= 20 && turnClean.length >= 1600) {
          const cleanAsr = await engine.transcribeLocal(turnClean, SAMPLE_RATE, "zh-CN");
          trackResults.push({ track: cleanTrackKind, asr: cleanAsr });
          const span = findWakeWordSpan(cleanAsr.text, wakeWords);
          const cleanExactWake =
            Boolean(span && !span.fuzzy) &&
            !isThirdPersonNeoMention(cleanAsr.text) &&
            (span!.afterText.length === 0 || looksLikeDirectDeviceCommand(span!.afterText));
          if (!cleanExactWake && turnRawHp.length >= 1600) {
            const rawAsr = await engine.transcribeLocal(turnRawHp, SAMPLE_RATE, "zh-CN");
            trackResults.push({ track: "raw", asr: rawAsr });
          }
        } else {
          const [cleanAsr, rawAsr] = await Promise.all([
            turnClean.length >= 1600
              ? engine.transcribeLocal(turnClean, SAMPLE_RATE, "zh-CN")
              : Promise.resolve<LocalAsrOutput>({
                  text: "",
                  rawText: "",
                  lang: "",
                  emotion: "",
                  event: "",
                  engine: "sensevoice-local",
                  durationMs: 0,
                }),
            turnRawHp.length >= 1600
              ? engine.transcribeLocal(turnRawHp, SAMPLE_RATE, "zh-CN")
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
          trackResults.push({ track: cleanTrackKind, asr: cleanAsr });
          trackResults.push({ track: "raw", asr: rawAsr });

          // 强音乐场景下若 Spleeter 人声轨与原始高通轨均未命中清晰指令/唤醒，再补验 DPDFNet4 轨
          if (vocalsDenoised && turnDpdf && hasAudibleEnergy(turnDpdf, 0.006)) {
            const hasStrongHit = trackResults.some((r) => {
              const sp = findWakeWordSpan(r.asr.text, wakeWords);
              return Boolean(sp && !sp.fuzzy) || hasSmartHomeDomainIntent(r.asr.text);
            });
            if (!hasStrongHit) {
              const dpdfAsr = await engine.transcribeLocal(turnDpdf, SAMPLE_RATE, "zh-CN");
              trackResults.push({ track: "denoised", asr: dpdfAsr });
            }
          }
        }

        const { best: bestAsr, alt: altAsr, anyThirdPerson } = pickBestTurnAsr(
          trackResults,
          wakeWords,
          {
            isStrongMusic,
            inputSnrDb: dpdf.inputSnrDb,
            acousticWake: turnAcousticWake,
          },
        );
        const asrMs = Math.round(performance.now() - tAsr);
        totalAsrMs += asrMs;

        const rawTurnText = bestAsr.text.trim();
        const altTurnText = altAsr?.text.trim() ?? "";
        const meaningfulChars = stripPunct(rawTurnText);
        const isThirdPerson = anyThirdPerson || isThirdPersonNeoMention(rawTurnText);

        // 歌声歌词判定（遵循严格防误触规则：singingProb >= 0.12 && speechProb < 0.25 && !hasSmartHomeDomainIntent）
        const clipSingingLyrics =
          scene.singingProb >= 0.12 &&
          scene.speechProb < 0.25 &&
          !hasSmartHomeDomainIntent(rawTurnText);
        const turnSingingLyrics =
          turnScene.singingProb >= 0.12 &&
          turnScene.speechProb < 0.25 &&
          !hasSmartHomeDomainIntent(rawTurnText);
        const isSingingOnlyTurn = clipSingingLyrics || turnSingingLyrics;

        // 2C. 轮次句首对齐的 en-US 探针（0..1.15s 与 0..0.65s）+ 严格防误触唤醒词规范化
        const tProbe = performance.now();
        let finalTurnText = rawTurnText;
        let enHeadHit: { wakeWord: string; matchedSurface: string; fuzzy: boolean } | null = null;
        let enHeadText = "";

        const existingSpan = findWakeWordSpan(rawTurnText, wakeWords);
        const hasExactWakeAlready = Boolean(existingSpan && !existingSpan.fuzzy);

        const extractedForCheck =
          asciiWakes.length > 0 ? extractCommandAfterAcousticWake(rawTurnText, asciiWakes[0]!) : "";
        const hasSmartDomainInExtracted =
          extractedForCheck.length >= 2 && hasSmartHomeDomainIntent(extractedForCheck);
        const hasWeirdScript = WEIRD_SCRIPT_RE.test(rawTurnText);
        const isShortOrGarbled =
          turnDurSec <= 2.4 &&
          (meaningfulChars.length <= 5 ||
            hasWeirdScript ||
            isWakeQueryText(extractedForCheck) ||
            rawTurnText.length === 0);

        const shouldRunEnProbe =
          asciiWakes.length > 0 &&
          !isThirdPerson &&
          !isSingingOnlyTurn &&
          !hasExactWakeAlready &&
          (hasSmartDomainInExtracted ||
            isShortOrGarbled ||
            Boolean(existingSpan?.fuzzy) ||
            (turnAcousticWake !== null && turnAcousticWake.score >= 0.56));

        if (shouldRunEnProbe) {
          const allowCommandGated =
            hasSmartDomainInExtracted && !isAmbiguousInterrogative(rawTurnText);

          const runHeadProbe = async (
            track: Float32Array,
            maxSec: number,
            allowGated: boolean,
          ): Promise<{
            text: string;
            hit: { wakeWord: string; matchedSurface: string; fuzzy: boolean } | null;
          }> => {
            if (track.length < 1600) return { text: "", hit: null };
            const sliceLen = Math.min(track.length, Math.round(SAMPLE_RATE * maxSec));
            const headSlice = track.subarray(0, sliceLen);
            const enRes = await engine.transcribeLocal(headSlice, SAMPLE_RATE, "en-US");
            const hit = matchEnglishHeadWakeWord(enRes.text, asciiWakes, {
              allowCommandGatedAliases: allowGated,
            });
            return { text: enRes.text.trim(), hit };
          };

          // 1) 0..1.15s 干净轨探针
          let probe = await runHeadProbe(turnClean, 1.15, allowCommandGated);
          // 2) 0..1.15s 原始高通轨探针（避免降噪器削弱句首轻声 "N"）
          if (!probe.hit && turnRawHp.length >= 1600) {
            const pRaw = await runHeadProbe(turnRawHp, 1.15, allowCommandGated);
            if (pRaw.hit) probe = pRaw;
          }
          // 3) 0..0.65s 快速连读探针（拯救快速连读短句如 "Neo关灯"）
          if (!probe.hit && turnClean.length >= Math.round(SAMPLE_RATE * 0.7)) {
            const pFastClean = await runHeadProbe(turnClean, 0.65, allowCommandGated);
            if (pFastClean.hit) probe = pFastClean;
          }
          if (!probe.hit && turnRawHp.length >= Math.round(SAMPLE_RATE * 0.7)) {
            const pFastRaw = await runHeadProbe(turnRawHp, 0.65, allowCommandGated);
            if (pFastRaw.hit) probe = pFastRaw;
          }

          if (probe.hit) {
            enHeadHit = probe.hit;
            enHeadText = probe.text;
          }
        }
        const probeMs = Math.round(performance.now() - tProbe);
        totalProbeMs += probeMs;

        // 严格防误触重组（仅在非第三人称、非歌声歌词、且满足智能家居意图或高置信纯唤醒时规范化为 `Neo，...` / `Neo`）
        if (!isThirdPerson && !isSingingOnlyTurn && !hasExactWakeAlready) {
          const startsWithAmbiguousZh = AMBIGUOUS_INTERROGATIVE_PREFIX_RE.test(rawTurnText);
          const ambigQuestion = isAmbiguousInterrogative(rawTurnText);

          // 优先检查 en-US 句首探针与 openWakeWord 声学唤醒的联合确认
          const candidateWakeWord =
            enHeadHit?.wakeWord ?? (turnAcousticWake?.matched ? turnAcousticWake.wakeWord : null);

          if (candidateWakeWord && !ambigQuestion) {
            const extractedCmd = extractCommandAfterAcousticWake(rawTurnText, candidateWakeWord);
            const cmdHasDomain = extractedCmd.length >= 2 && hasSmartHomeDomainIntent(extractedCmd);
            const cmdIsDirect = extractedCmd.length >= 2 && looksLikeDirectDeviceCommand(extractedCmd);
            const cmdIsChore = NON_DEVICE_CHORE_RE.test(extractedCmd);

            if (extractedCmd && !isWakeQueryText(extractedCmd)) {
              // 带指令重组：对 "你好" / "你有" 开头强制要求智能家居领域意图；一般句子亦防止家务闲聊被模糊唤醒改写
              const exactEnConfirmed = Boolean(enHeadHit && !enHeadHit.fuzzy);
              const strongAcoustic = Boolean(turnAcousticWake?.matched);

              if (startsWithAmbiguousZh) {
                if (cmdHasDomain && !cmdIsChore) {
                  finalTurnText = `${candidateWakeWord}，${extractedCmd}`;
                }
              } else if (cmdHasDomain && !cmdIsChore) {
                finalTurnText = `${candidateWakeWord}，${extractedCmd}`;
              } else if (
                cmdIsDirect &&
                !cmdIsChore &&
                exactEnConfirmed &&
                (strongAcoustic || (turnAcousticWake !== null && turnAcousticWake.score >= 0.42))
              ) {
                finalTurnText = `${candidateWakeWord}，${extractedCmd}`;
              } else if (!cmdIsChore && exactEnConfirmed && strongAcoustic) {
                finalTurnText = `${candidateWakeWord}，${extractedCmd}`;
              }
            } else if (isShortOrGarbled) {
              // 纯唤醒重组（如 "Neo" / "Hey Neo" / "Neo在吗"）
              const isPureZhGreeting = PURE_ZH_FILLER_OR_GREETING_RE.test(meaningfulChars);
              const exactEnConfirmed = Boolean(enHeadHit && !enHeadHit.fuzzy);
              const strongOww = Boolean(
                turnAcousticWake?.matched && turnAcousticWake.score >= 0.65,
              );

              if (isPureZhGreeting) {
                // 防止纯中文问候 "你好" / "好的" 误唤醒：必须同时有精确英文 "Neo" + 声学分支持，或极强 openWakeWord 命中
                if (
                  (exactEnConfirmed && turnAcousticWake !== null && turnAcousticWake.score >= 0.45) ||
                  strongOww
                ) {
                  finalTurnText = candidateWakeWord;
                }
              } else if (
                exactEnConfirmed ||
                (enHeadHit && !startsWithAmbiguousZh && (hasWeirdScript || isWakeQueryText(extractedForCheck) || rawTurnText.length === 0)) ||
                Boolean(turnAcousticWake?.matched)
              ) {
                const enSpan = enHeadText ? findWakeWordSpan(enHeadText, asciiWakes) : null;
                finalTurnText =
                  enSpan && enSpan.afterText && enSpan.afterText.length >= 2
                    ? `${candidateWakeWord}，${enSpan.afterText}`
                    : candidateWakeWord;
              }
            }
          }
        }

        // 2D. 独立执行 DDSD 注意力门控（含严格反误触护栏）
        const tAtt = performance.now();
        let decision: AttentionDecision;

        const finalSpan = findWakeWordSpan(finalTurnText, wakeWords);
        const finalHasExactWake = Boolean(finalSpan && !finalSpan.fuzzy);

        if (isThirdPerson) {
          decision = {
            accept: false,
            wokeOnly: false,
            addressed: false,
            inConversation,
            confidence: 0.92,
            stage: "pragmatic-reject",
            reason: "检测到第三人称提及或否定呼唤语境，已拦截误触发",
            wakeWord: finalSpan?.wakeWord ?? null,
            command: "",
            usedLlm: false,
            latencyMs: 0,
          };
        } else if (
          inConversation &&
          isSingingOnlyTurn &&
          !finalHasExactWake
        ) {
          decision = {
            accept: false,
            wokeOnly: false,
            addressed: false,
            inConversation: true,
            confidence: 0.93,
            stage: "acoustic",
            reason: "连续对话模式下检测到歌唱歌词片段且无智能家居意图，已拒绝",
            wakeWord: null,
            command: "",
            usedLlm: false,
            latencyMs: 0,
          };
        } else if (
          !inConversation &&
          isSingingOnlyTurn &&
          !finalHasExactWake
        ) {
          decision = {
            accept: false,
            wokeOnly: false,
            addressed: false,
            inConversation: false,
            confidence: 0.93,
            stage: "acoustic",
            reason: "待机模式下检测到纯歌唱片段且无明确唤醒词，已拒绝",
            wakeWord: null,
            command: "",
            usedLlm: false,
            latencyMs: 0,
          };
        } else if (
          finalSpan &&
          finalSpan.fuzzy &&
          AMBIGUOUS_FUZZY_ZH_WAKE_SURFACES.has(finalSpan.matchedSurface) &&
          (!hasSmartHomeDomainIntent(finalSpan.afterText) || isAmbiguousInterrogative(finalTurnText))
        ) {
          decision = {
            accept: false,
            wokeOnly: false,
            addressed: false,
            inConversation,
            confidence: 0.92,
            stage: "pragmatic-reject",
            reason: `模糊别名「${finalSpan.matchedSurface}」后缺乏智能家居领域意图，已拦截误触发`,
            wakeWord: finalSpan.wakeWord,
            command: "",
            usedLlm: false,
            latencyMs: 0,
          };
        } else {
          const effectiveEvent =
            bestAsr.event ||
            (scene.musicProb >= 0.18 || scene.singingProb >= 0.08 ? "<|BGM|>" : "<|Speech|>");
          const eventWithBgm =
            (scene.musicProb >= 0.2 || scene.singingProb >= 0.08) &&
            !effectiveEvent.toUpperCase().includes("BGM")
              ? `${effectiveEvent}<|BGM|>`
              : effectiveEvent;

          decision = await evaluateVoiceAttention({
            ...dialogCtx,
            rawText: finalTurnText,
            altText: altTurnText || undefined,
            acousticEvent: eventWithBgm,
            acousticWake: turnAcousticWake,
            owwActiveForWord: engine.openWakeWord.isReady,
          });

          // 连续对话模式后置防误触护栏：过滤无智能家居意图的日常家务闲聊（如 "帮我把桌上那杯水递过来"）
          if (decision.accept && !decision.wokeOnly && inConversation && !decision.wakeWord) {
            const cmd = decision.command.trim();
            const hasDomain = hasSmartHomeDomainIntent(cmd);
            if (!hasDomain && NON_DEVICE_CHORE_RE.test(cmd)) {
              decision = {
                ...decision,
                accept: false,
                addressed: false,
                stage: "pragmatic-reject",
                reason: "连续对话模式下判定为日常家务旁白（非智能家居指令），已拦截",
                command: "",
              };
            } else if (
              !hasDomain &&
              stripPunct(cmd).length > 10 &&
              !/^(?:再|稍微|还是|那就|把它|调|设|改|换|切|停|暂停|继续)/.test(cmd)
            ) {
              decision = {
                ...decision,
                accept: false,
                addressed: false,
                stage: "pragmatic-reject",
                reason: "连续对话模式下长句缺乏智能家居设备语义，已保守忽略",
                command: "",
              };
            }
          }

          // 连续对话模式带口语连接词的明确智能家居续聊恢复（如 "那卧室灯也关掉" / "还有把空调调到26度"）
          if (
            !decision.accept &&
            decision.stage === "pragmatic-reject" &&
            inConversation &&
            !isSingingOnlyTurn &&
            !isThirdPerson &&
            !INTERROGATIVE_TAIL_RE.test(finalTurnText)
          ) {
            const strippedConn = finalTurnText.replace(LEADING_CONV_CONNECTIVE_RE, "").trim();
            if (
              strippedConn.length >= 2 &&
              hasSmartHomeDomainIntent(strippedConn) &&
              CONV_ACTION_VERB_RE.test(strippedConn) &&
              !NON_DEVICE_CHORE_RE.test(strippedConn)
            ) {
              decision = {
                ...decision,
                accept: true,
                wokeOnly: false,
                addressed: true,
                inConversation: true,
                confidence: 0.86,
                stage: "fast-followup",
                reason: "连续对话中剥离口语连接词后确认为明确智能家居控制指令",
                command: strippedConn,
              };
            }
          }

          // 音乐或重叠多说话人场景下清理尾随歌词/旁白泄漏
          if (decision.accept && !decision.wokeOnly && decision.command) {
            if (isStrongMusic || scene.musicProb >= 0.14 || turn.overlapped) {
              decision = {
                ...decision,
                command: cleanCommandForMusicOrOverlap(decision.command),
              };
            }
          }
        }

        const attentionMs = Math.round(performance.now() - tAtt);
        totalAttentionMs += attentionMs;

        evaluatedTurns.push({
          turn,
          turnIndex: idx,
          rawTranscript: rawTurnText,
          normalizedTranscript: finalTurnText,
          altTranscript: altTurnText,
          acousticEvent: bestAsr.event,
          acousticWake: turnAcousticWake,
          enHeadHit,
          decision,
          energyRatio,
          meaningfulTextLen: meaningfulChars.length,
          isSingingOnlyTurn,
          isThirdPerson,
          asrMs,
          probeMs,
          owwMs,
          attentionMs,
        });
      }

      // ==================== Stage 2.5: 同说话人“唤醒词 + 短停顿 + 指令”跨轮次桥接 ====================
      // 若同一说话人先喊 "Neo"（wokeOnly），停顿 <=1.2s 后紧接着说出设备指令，桥接为完整指令避免退化为纯唤醒
      for (let i = 0; i + 1 < evaluatedTurns.length; i += 1) {
        const cur = evaluatedTurns[i]!;
        const nxt = evaluatedTurns[i + 1]!;
        if (
          cur.decision.accept &&
          cur.decision.wokeOnly &&
          !nxt.decision.accept &&
          nxt.decision.stage !== "echo" &&
          nxt.decision.stage !== "exit" &&
          !nxt.isThirdPerson &&
          !nxt.isSingingOnlyTurn &&
          cur.turn.speaker === nxt.turn.speaker &&
          nxt.turn.startSec - cur.turn.endSec <= 1.25 &&
          nxt.rawTranscript.length >= 2 &&
          (looksLikeDirectDeviceCommand(nxt.rawTranscript) || hasSmartHomeDomainIntent(nxt.rawTranscript))
        ) {
          const bridged = await evaluateVoiceAttention({
            ...dialogCtx,
            awakeActive: true,
            rawText: nxt.rawTranscript,
            altText: nxt.altTranscript || undefined,
            acousticEvent: nxt.acousticEvent || undefined,
            acousticWake: cur.acousticWake,
            owwActiveForWord: engine.openWakeWord.isReady,
          });
          if (bridged.accept && !bridged.wokeOnly && bridged.command) {
            nxt.decision = {
              ...bridged,
              wakeWord: cur.decision.wakeWord ?? wakeWords[0] ?? null,
              reason: `同说话人唤醒后停顿续说指令（桥接 speaker_${cur.turn.speaker}）`,
              command:
                isStrongMusic || nxt.turn.overlapped
                  ? cleanCommandForMusicOrOverlap(bridged.command)
                  : bridged.command,
            };
          }
        }
      }

      // ==================== Stage 3: 跨说话人轮次聚合与输出构造 ====================
      // 过滤纯歌唱伴奏聚类后再统计真实人类说话人数
      const speechSpeakerIds = new Set<number>();
      for (const et of evaluatedTurns) {
        if (et.decision.accept || (!et.isSingingOnlyTurn && et.meaningfulTextLen >= 1)) {
          speechSpeakerIds.add(et.turn.speaker);
        }
      }
      const detectedSpeakerCount =
        speechSpeakerIds.size > 0
          ? speechSpeakerIds.size
          : turns.length > 0 && !evaluatedTurns.every((t) => t.isSingingOnlyTurn)
            ? new Set(turns.map((t) => t.speaker)).size
            : 0;

      // 构造 separatedStreams（含各说话人隔离轮次及可选伴奏流）
      const separatedStreams: SeparatedStreamSummary[] = [];
      for (const et of evaluatedTurns) {
        separatedStreams.push({
          streamId: `speaker_${et.turn.speaker}_turn_${et.turnIndex}`,
          kind: "speaker",
          speakerId: `speaker_${et.turn.speaker}`,
          startSec: Number(et.turn.startSec.toFixed(3)),
          endSec: Number(et.turn.endSec.toFixed(3)),
          energyRatio: Number(et.energyRatio.toFixed(3)),
          transcript: et.rawTranscript,
        });
      }
      if (spleeter) {
        const accRms = computeRms(spleeter.accompaniment16k);
        if (accRms >= 0.008) {
          separatedStreams.push({
            streamId: "spleeter_accompaniment",
            kind: "bgm_accompaniment",
            energyRatio: Number(Math.min(1, accRms / rawRms).toFixed(3)),
          });
        }
      }

      // 声音类型聚合（严格基于 CED + 声学特征 + Pyannote/CAM++ 说话人计数）
      const soundTypes = new Set<SoundTypeLabel>();
      const hasSpokenTurn = evaluatedTurns.some(
        (t) => t.meaningfulTextLen >= 2 && !t.isSingingOnlyTurn,
      );
      if (
        scene.speechProb >= 0.14 ||
        (hasSpokenTurn && !(scene.singingProb >= 0.15 && scene.speechProb < 0.08))
      ) {
        soundTypes.add("speech");
      }
      if (scene.singingProb >= 0.055 || (vocalsScene !== null && vocalsScene.singingProb >= 0.065) || effectiveSingingProb >= 0.08) {
        soundTypes.add("song");
      }
      const anyBgmEvent = evaluatedTurns.some((t) =>
        t.acousticEvent.toUpperCase().includes("BGM"),
      );
      const strongAccomp =
        spleeter !== null &&
        computeRms(spleeter.accompaniment16k) >= Math.max(0.012, rawRms * 0.34);
      if (
        scene.musicProb >= 0.14 ||
        scene.singingProb >= 0.08 ||
        strongAccomp ||
        (anyBgmEvent && scene.musicProb >= 0.06)
      ) {
        soundTypes.add("bgm");
      }
      const acousticNoiseHint =
        scene.musicProb < 0.14 &&
        scene.singingProb < 0.06 &&
        ((dpdf.inputSnrDb < 11.5 && dpdf.snrGainDb >= 4.0) ||
          (acoustics.spectralFlatnessApprox >= 0.5 && acoustics.frameEnergyStdRatio < 0.65));
      if ((scene.noiseProb >= 0.08 && scene.musicProb < 0.35) || acousticNoiseHint) {
        soundTypes.add("noise");
      }
      if (detectedSpeakerCount >= 2) {
        soundTypes.add("multi_speaker");
      }
      if (soundTypes.size === 0) {
        soundTypes.add(scene.musicProb >= 0.08 ? "bgm" : "noise");
      }

      // 在所有隔离说话人轮次中择优聚合（直接指令优先于纯唤醒，且高置信优先）
      const acceptedTurns = evaluatedTurns.filter(
        (et) => et.decision.accept && !et.isThirdPerson,
      );

      const stageTimingsMs: Record<string, number> = {
        sceneMs: scene.durationMs,
        dpdfMs: dpdf.durationMs,
        gtcrnMs: gtcrn.durationMs,
        spleeterMs: (spleeter?.durationMs ?? 0) + spleeterDenoiseMs,
        diarMs,
        vadMs,
        camppMs,
        owwMs: totalOwwMs,
        asrMs: totalAsrMs,
        enProbeMs: totalProbeMs,
        attentionMs: totalAttentionMs,
      };

      if (acceptedTurns.length > 0) {
        const rankAccepted = (et: EvaluatedTurn): number => {
          let score = et.decision.confidence * 100;
          // 强烈优先完整操作指令而非纯唤醒
          if (!et.decision.wokeOnly && et.decision.command.trim().length > 0) {
            score += 200;
          }
          const span = findWakeWordSpan(et.normalizedTranscript, wakeWords);
          if (span && !span.fuzzy) score += 35;
          else if (et.enHeadHit && !et.enHeadHit.fuzzy) score += 28;
          if (hasSmartHomeDomainIntent(et.decision.command)) score += 30;
          if (et.acousticWake?.matched) score += 15 + et.acousticWake.score * 10;
          // 轻微偏好较后出现的轮次（例如旁白之后用户开口下指令）
          score += et.turnIndex * 0.5;
          return score;
        };

        acceptedTurns.sort((a, b) => rankAccepted(b) - rankAccepted(a));
        const winner = acceptedTurns[0]!;

        return {
          isNeoCommand: true,
          wokeOnly: winner.decision.wokeOnly,
          command: winner.decision.command,
          rawTranscript: winner.rawTranscript || winner.normalizedTranscript,
          detectedSoundTypes: [...soundTypes],
          detectedSpeakerCount,
          separatedStreams,
          attentionStage: winner.decision.stage,
          attentionReason: `[speaker_${winner.turn.speaker}] ${winner.decision.reason}`,
          latencyMs: Math.round(performance.now() - t0),
          stageTimingsMs,
        };
      }

      // 所有轮次均未触发 Neo：汇总最具信息量的拒绝原因
      if (evaluatedTurns.length === 0) {
        return {
          isNeoCommand: false,
          wokeOnly: false,
          command: "",
          rawTranscript: "",
          detectedSoundTypes: [...soundTypes],
          detectedSpeakerCount: 0,
          separatedStreams,
          attentionStage: "no-speech",
          attentionReason: "Pyannote 与 Silero VAD 均未检测到有效人声轮次",
          latencyMs: Math.round(performance.now() - t0),
          stageTimingsMs,
        };
      }

      const stagePriority: Record<string, number> = {
        echo: 5,
        exit: 4,
        "pragmatic-reject": 3,
        "acoustic-veto": 2,
        acoustic: 1,
        "no-wake": 0,
      };
      const primaryReject = [...evaluatedTurns].sort(
        (a, b) => (stagePriority[b.decision.stage] ?? 0) - (stagePriority[a.decision.stage] ?? 0),
      )[0]!;
      const joinedTranscript = evaluatedTurns
        .map((t) => t.rawTranscript)
        .filter(Boolean)
        .join(" | ");

      return {
        isNeoCommand: false,
        wokeOnly: false,
        command: "",
        rawTranscript: joinedTranscript,
        detectedSoundTypes: [...soundTypes],
        detectedSpeakerCount,
        separatedStreams,
        attentionStage: primaryReject.decision.stage,
        attentionReason: primaryReject.decision.reason,
        latencyMs: Math.round(performance.now() - t0),
        stageTimingsMs,
      };
    },
  };
}
