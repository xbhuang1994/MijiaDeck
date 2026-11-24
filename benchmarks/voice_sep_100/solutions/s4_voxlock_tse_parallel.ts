// SPDX-License-Identifier: GPL-3.0-or-later
// Solution S4: Target Speaker Extraction (VoxLock TSE) + Acoustic Wake-Word Spotting + Parallel Multi-Branch Decoding

import { existsSync, readFileSync } from "node:fs";
import {
  cosineSimilarity,
  decodeWavPcm,
  l2Normalize,
  resampleLinear,
} from "../../../src/agent/audioPcm.ts";
import type { LocalAsrOutput } from "../../../src/agent/localVoiceEngine.ts";
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

type BranchId = "voxlock_owner" | "voxlock_family" | "dpdfnet_general" | "raw_hp";
type WakeProvenance =
  | "exact-asr"
  | "en-head+oww"
  | "en-head-exact"
  | "oww-matched"
  | "homophone-asr"
  | "en-head-fuzzy"
  | "conversation-followup"
  | "none";

interface BranchSegmentDecode {
  branchId: BranchId;
  segIndex: number;
  startSec: number;
  endSec: number;
  segRms: number;
  origText: string;
  candidateText: string;
  asrEvent: string;
  asrLang: string;
  acousticWake: WakeWordAcousticHit | null;
  enHeadText: string;
  enHeadHit: { wakeWord: string; matchedSurface: string; fuzzy: boolean } | null;
  wakeProvenance: WakeProvenance;
  decision: AttentionDecision;
  rankScore: number;
  stitchedFromWake?: boolean;
}

interface BranchRunResult {
  branchId: BranchId;
  speakerId?: string;
  samples: Float32Array;
  vadSegments: TimedVadSegment[];
  activeSec: number;
  activeRms: number;
  mergedText: string;
  decodes: BranchSegmentDecode[];
}

const LEADING_PUNCT_RE = /^[\s,，。．.、!！?？:：;；\-—~～"“”'‘’]+/;
const TRAILING_PUNCT_RE = /[\s,，。．.、!！?？:：;；"“”'‘’]+$/;
const WEIRD_SCRIPT_RE = /[\u3040-\u30ff\uac00-\ud7af]/g;

// 容易与日常中文表达混淆的模糊唤醒词（必须有明确智能家居域意图且不能是疑问句）
const AMBIGUOUS_FUZZY_ZH_SURFACES = new Set([
  "你好",
  "您好",
  "你有",
  "你又",
  "你给",
  "你欧",
  "你哦",
]);

// 高确定性的 Neo 音译/近音词（非日常高频词）
const STRONG_NEO_HOMOPHONES = new Set([
  "neo",
  "neil",
  "neal",
  "nil",
  "nio",
  "niyo",
  "neio",
  "neow",
  "newo",
  "niel",
  "hey ne",
  "hei ne",
  "尼奥",
  "尼欧",
  "妮奥",
  "妮欧",
  "尼哦",
  "妮哦",
  "你o",
  "你0",
]);

// 面向他人说话的中文主语前缀（防止 "你帮我把灯关了" / "你去开空调" 被模糊 en-head 改写）
const HUMAN_ADDRESSED_PREFIX_RE =
  /^(?:你去|你能|你先|你顺便|你帮我?|你看|你听|你别|你不要|你快|你来|你们|叫你|让你)/;

// 常见纯中文寒暄/应答（绝不能在无指令、无高置信声学确认时误判成单独 "Neo"）
const COMMON_NON_WAKE_PHRASE_RE =
  /^(?:你好|您好|你好呀|你好啊|谢谢|谢谢你|多谢|再见|拜拜|晚安|早安|好的|好吧|行吧|可以|行|没问题|没事|没事了|算了|不用了|知道了|明白|是的|不是|对|对呀|嗯+|啊+|哦+|喔+|哈哈+|呵呵+|等一下|稍等|不好意思|对不起|没关系|欢迎|辛苦了|加油|太好了|真的吗|怎么了|为什么|什么|干嘛|吃饭|喝水|你好吗|在干嘛)$/;

// 连续对话模式下的有效续聊设备/助手意图（包含明确设备域词 + 典型指代调节指令）
const CONVERSATION_ANAPHORIC_CMD_RE =
  /^(?:再|稍微|稍微再|还是|那就|帮我再|把它|把(?:声音|音量|亮度|色温|温度))?(?:调到?\s*\d+\s*(?:度|%|分贝)?|调大|调小|调高|调低|大一点|小一点|高一点|低一点|亮一点|暗一点|暖一点|冷一点|关了吧|关掉|关闭|打开吧?|开启|开一下|关一下|再来一份|停一下|暂停|继续|停止|静音|取消静音|下一首|上一首|换一首|切歌)$/i;

const ASSISTANT_QUERY_INTENT_RE =
  /(?:天气|气温|几点|时间|日期|星期几|闹钟|提醒|倒计时|日程|备忘|weather|time|alarm|timer)/i;

const GENERIC_POLITE_PREFIX_RE = /^(?:请|帮我|给我|麻烦|快|赶紧|顺便|现在|把|将)/;

const EXTENDED_POLITE_EXIT_RE =
  /^(?:好了谢谢|行了谢谢|可以了谢谢|没事了谢谢|不用了谢谢|好的不用了|行了不用了|没事谢谢|谢谢不用了|谢谢再见)$/;

const EXTENDED_THIRD_PERSON_ZH_RE =
  /(?:提到|聊到|说到|说起|讲到|谈到|听说|觉得|认为|喜欢|讨厌|别管|别理|不用管|不要管|没叫|没喊|谁叫|谁在叫|什么叫|叫做|名叫|名字叫|介绍|对比|评论|新闻里|同事|朋友).{0,8}(?:neo|尼奥|尼欧|妮奥|妮欧|尼哦|呢哦|你o|你0|2お|ニオ|ネオ|ニ요|你好|你有|new|near|neil|nio)/i;

const ENGLISH_THIRD_PERSON_NEO_RE =
  /(?:\b(?:ignore|forget(?:\s+about)?|don'?t\s+(?:mind|worry\s+about|listen\s+to|call|bother)|never\s+mind|talking\s+about|talked\s+about|mentioned|about|called|named|heard\s+of)\s+(?:neo|neil|nio)\b|\bneo\s+(?:is|was|seems|looks|sounds|works|isn'?t|doesn'?t)\b)/i;

// 仅在声学唤醒 (openWakeWord / en-US 探针) 已确证句首存在 "Neo" 时，剥离 SenseVoice 对 "Neo" 产生的中文感叹/近音残片（如 "哎呦，打开客厅吸顶灯"）
const ACOUSTIC_CONFIRMED_MANGLED_PREFIX_RE =
  /^(?:哎呦|哎哟|诶呦|诶哟|里哦|利哦|尼哟|你哟|米哦|哟呵|呦|哟|哦|噢|嗯|呃|额|呐|呢|啊|呀|啦)[\s,，。!！?？:：、]*/;

function extractCleanCommandAfterConfirmedWake(rawText: string, wakeWord: string): string {
  // 若多说话人/长段文本由句末标点隔开，且前句无智能家居意图而后句含明确设备指令，优先从后句提取
  const later = findLaterDomainClauseCharOffset(rawText);
  const workingText =
    later && !looksLikeDirectDeviceCommand(cleanEdges(rawText)) ? later.clauseText : rawText;

  const base = extractCommandAfterAcousticWake(workingText, wakeWord);
  const cleanedRaw = cleanEdges(workingText);
  const m = ACOUSTIC_CONFIRMED_MANGLED_PREFIX_RE.exec(cleanedRaw);
  if (m) {
    const rest = cleanEdges(cleanedRaw.slice(m[0].length));
    if (
      rest.length >= 2 &&
      (looksLikeDirectDeviceCommand(rest) || hasSmartHomeDomainIntent(rest))
    ) {
      return rest;
    }
  }
  const mBase = ACOUSTIC_CONFIRMED_MANGLED_PREFIX_RE.exec(base);
  if (mBase) {
    const rest = cleanEdges(base.slice(mBase[0].length));
    if (
      rest.length >= 2 &&
      (looksLikeDirectDeviceCommand(rest) || hasSmartHomeDomainIntent(rest))
    ) {
      return rest;
    }
  }
  return base;
}

/**
 * 在长段包含多个子句且后半段出现明确智能家居意图时，定位该后半段子句在文本中的字符起始比例，
 * 供声学局部探针（openWakeWord + en-US 句首对齐）精准扫描零停顿说话人切换/歌词转指令边界。
 */
function findLaterDomainClauseCharOffset(text: string): {
  clauseText: string;
  charRatio: number;
} | null {
  const parts = text.split(/([？?!！。;；])/).filter((p) => p.length > 0);
  const clauses: Array<{ text: string; startChar: number }> = [];
  let cursor = 0;
  for (let i = 0; i < parts.length; i += 1) {
    const p = parts[i]!;
    if (/^[？?!！。;；]$/.test(p)) {
      if (clauses.length > 0) {
        clauses[clauses.length - 1]!.text += p;
      }
      cursor += p.length;
      continue;
    }
    clauses.push({ text: p, startChar: cursor });
    cursor += p.length;
  }
  if (clauses.length < 2) return null;

  const totalLen = Math.max(1, text.length);
  // 查找非首句且包含明确智能家居域意图的子句
  for (let i = 1; i < clauses.length; i += 1) {
    const c = clauses[i]!;
    if (hasSmartHomeDomainIntent(c.text)) {
      return {
        clauseText: cleanEdges(c.text),
        charRatio: Math.max(0.15, Math.min(0.85, c.startChar / totalLen)),
      };
    }
  }
  return null;
}

function stripPunct(text: string): string {
  return text
    .replace(/[\s,，。．.、!！?？:：;；\-—~～"'“”‘’()（）[\]【】]+/g, "")
    .trim();
}

function cleanEdges(text: string): string {
  return text.replace(LEADING_PUNCT_RE, "").replace(TRAILING_PUNCT_RE, "").trim();
}

function isExtendedThirdPersonNeoMention(text: string): boolean {
  if (!text) return false;
  return (
    isThirdPersonNeoMention(text) ||
    EXTENDED_THIRD_PERSON_ZH_RE.test(text) ||
    ENGLISH_THIRD_PERSON_NEO_RE.test(text)
  );
}

function countNeoLikeMentions(text: string): number {
  const matches = text.match(/(?:(?<![a-z])(?:neo|neil|neal|nio)(?![a-z])|尼奥|尼欧|妮奥|妮欧)/gi);
  return matches ? matches.length : 0;
}

function isAmbiguousInterrogativeZh(text: string, wakeWord: string): boolean {
  const t = text.trim();
  if (!/^(?:你有|你又|你好|您好|你给)/.test(t)) return false;
  if (!/[吗嘛么呢][。？！!?\s]*$/.test(t)) return false;
  const extracted = extractCommandAfterAcousticWake(t, wakeWord);
  return !isWakeQueryText(extracted);
}

function hasConversationDeviceIntent(text: string): boolean {
  const cleaned = cleanEdges(text);
  if (!cleaned) return false;
  if (hasSmartHomeDomainIntent(cleaned)) return true;
  if (CONVERSATION_ANAPHORIC_CMD_RE.test(stripPunct(cleaned))) return true;
  if (ASSISTANT_QUERY_INTENT_RE.test(cleaned)) return true;
  return false;
}

function isPredominantlyEnglish(text: string): boolean {
  const asciiLetters = (text.match(/[a-zA-Z]/g) ?? []).length;
  const cjkChars = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  return asciiLetters >= 4 && asciiLetters > cjkChars * 2;
}

function concatSegmentSamples(segs: readonly TimedVadSegment[]): Float32Array {
  if (segs.length === 0) return new Float32Array(0);
  if (segs.length === 1) return segs[0]!.samples;
  const totalLen = segs.reduce((acc, s) => acc + s.samples.length, 0);
  const out = new Float32Array(totalLen);
  let pos = 0;
  for (const s of segs) {
    out.set(s.samples, pos);
    pos += s.samples.length;
  }
  return out;
}

function totalVadSec(segs: readonly TimedVadSegment[]): number {
  return segs.reduce((acc, s) => acc + Math.max(0, s.endSec - s.startSec), 0);
}

function intervalsOverlapSec(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  const s = Math.max(aStart, bStart);
  const e = Math.min(aEnd, bEnd);
  return Math.max(0, e - s);
}

function rangesDistinctDuration(
  primary: readonly TimedVadSegment[],
  other: readonly TimedVadSegment[],
): number {
  let nonOverlap = 0;
  for (const seg of primary) {
    const dur = Math.max(0, seg.endSec - seg.startSec);
    let ov = 0;
    for (const o of other) {
      ov += intervalsOverlapSec(seg.startSec, seg.endSec, o.startSec, o.endSec);
    }
    nonOverlap += Math.max(0, dur - Math.min(dur, ov));
  }
  return nonOverlap;
}

function computeNormCommandOverlap(a: string, b: string): number {
  const na = stripPunct(a).toLowerCase();
  const nb = stripPunct(b).toLowerCase();
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) {
    return Math.min(na.length, nb.length) / Math.max(na.length, nb.length);
  }
  return computeEchoOverlap(na, nb);
}

export function createSolutionS4(pool: SharedVoiceModelPool): VoiceSolution {
  const refEmbeddingCache = new Map<string, number[]>();

  function getRefSpeakerEmbedding(refWavPath: string): number[] | null {
    if (!refWavPath || !existsSync(refWavPath)) return null;
    const cached = refEmbeddingCache.get(refWavPath);
    if (cached) return cached;
    try {
      const decoded = decodeWavPcm(readFileSync(refWavPath));
      const pcm16k =
        decoded.sampleRate === 16000
          ? decoded.samples
          : resampleLinear(decoded.samples, decoded.sampleRate, 16000);
      if (pcm16k.length < 4000) return null;
      const emb = l2Normalize(pool.localEngine.extractSpeakerEmbedding(pcm16k, 16000).embedding);
      refEmbeddingCache.set(refWavPath, emb);
      return emb;
    } catch {
      return null;
    }
  }

  function extractCamppEmbedding(pcm16k: Float32Array): number[] | null {
    if (pcm16k.length < 4000) return null;
    const res = pool.localEngine.extractSpeakerEmbedding(pcm16k, 16000);
    return l2Normalize(res.embedding);
  }

  return {
    id: "s4_voxlock_tse_parallel",
    name: "S4: VoxLock TSE + Acoustic Wake + Parallel Multi-Branch",
    description:
      "目标说话人提取（VoxLock TSE Owner/Family 双声纹分支）+ DPDFNet4 通用分支 + 原始高通保真分支并行解码，结合 CED-tiny 场景分析、逐段起止对齐英文唤醒探针与 openWakeWord 声学打分及严格防误触多分支融合。",

    async init(): Promise<void> {
      pool.ensureCedTagger();
      // 预热 DPDFNet4 会话，消除首条音频冷启动开销
      pool.localEngine.denoise(new Float32Array(1600), 16000, "dpdfnet");
    },

    async process(input: SolutionRunInput): Promise<SolutionRunOutput> {
      const t0 = performance.now();
      const stageTimingsMs: Record<string, number> = {};
      const engine = pool.localEngine;
      const { pcm16k, wakeWords, ownerRefPath, familyRefPath } = input;
      const primaryWake = wakeWords[0]?.trim() || "Neo";
      const asciiWakes = wakeWords
        .map((w) => w.trim())
        .filter((w) => /^[a-z][a-z0-9\s-]*$/i.test(w));

      // 严格仅使用运行时对话上下文（绝不读取任何 ground-truth 字段）
      const dialogCtx = buildRuntimeDialogContext(input.clip, wakeWords);
      const inConversation = dialogCtx.dialogState === "conversation";

      // ==================== Stage 1: 并行声学场景分类 + DSP 声学诊断 ====================
      const tScene = performance.now();
      const scene: SceneAnalysis = pool.analyzeAudioScene(pcm16k);
      const diag = computeAcousticDiagnostics(pcm16k);
      const rawHp = applyHighPassFilter(pcm16k, 16000, 85);
      const inputSnrDb = estimateSnrDb(pcm16k, 16000);
      stageTimingsMs.sceneAndDiagMs = Math.round(performance.now() - tScene);

      if (!hasAudibleEnergy(rawHp, 0.003)) {
        return {
          isNeoCommand: false,
          wokeOnly: false,
          command: "",
          rawTranscript: "",
          detectedSoundTypes: [],
          detectedSpeakerCount: 0,
          separatedStreams: [],
          attentionStage: "silence-skip",
          attentionReason: "音频能量过低（静音）",
          latencyMs: Math.max(1, Math.round(performance.now() - t0)),
          stageTimingsMs,
        };
      }

      const ownerRefEmb = getRefSpeakerEmbedding(ownerRefPath);
      const familyRefEmb = getRefSpeakerEmbedding(familyRefPath);

      // ==================== Stage 2: 多分支声源/目标说话人提取 ====================
      // 紧凑分段参数（padSec=0.08 + mergeGapSec=0.04 -> 合并间隙 <= 0.20s，保留 >=0.22s 说话人轮转停顿，
      // 便于每段独立句首对齐 en-US 唤醒探针与 openWakeWord 打分；同说话人停顿由后续相邻拼接自动恢复）
      const turnVadOpts = {
        threshold: 0.38,
        minSilenceDuration: 0.18,
        minSpeechDuration: 0.14,
        padSec: 0.08,
        mergeGapSec: 0.04,
      };

      // Branch C: DPDFNet4 通用降噪（保留未注册说话人，强效抑制宽带/风扇/键盘/BGM）
      const tDpdf = performance.now();
      const dpdfRes = engine.denoise(pcm16k, 16000, "dpdfnet");
      const dpdfVadSegs = extractTimedVadSegments(engine, dpdfRes.samples, turnVadOpts);
      const dpdfActiveSec = totalVadSec(dpdfVadSegs);
      const dpdfActiveSpeech = concatSegmentSamples(dpdfVadSegs);
      const dpdfActiveRms = computeRms(dpdfActiveSpeech);
      stageTimingsMs.dpdfnetMs = Math.round(performance.now() - tDpdf);

      // Branch A: VoxLock Owner 目标说话人提取（剥离重叠串话/电视人声/背景歌声）
      const tOwner = performance.now();
      const ownerTse = pool.extractTargetSpeakerVoxLock(pcm16k, ownerRefPath);
      const ownerSamples = ownerTse?.samples ?? new Float32Array(0);
      const ownerVadSegs = hasAudibleEnergy(ownerSamples, 0.005)
        ? extractTimedVadSegments(engine, ownerSamples, turnVadOpts)
        : [];
      const ownerActiveSec = totalVadSec(ownerVadSegs);
      const ownerActiveSpeech = concatSegmentSamples(ownerVadSegs);
      const ownerActiveRms = computeRms(ownerActiveSpeech);
      stageTimingsMs.voxlockOwnerMs = Math.round(performance.now() - tOwner);

      // 判断 Branch A 是否已完整干净覆盖全部语音能量；否则运行 Branch B (VoxLock Family)
      let ownerBranchEmb: number[] | null = null;
      let dpdfSoloSimToOwner = 0;
      let dpdfSingleSegConsistent = true;
      if (ownerActiveSpeech.length >= 4000) {
        ownerBranchEmb = extractCamppEmbedding(ownerActiveSpeech);
      }
      if (dpdfVadSegs.length === 1 && dpdfActiveSpeech.length >= 4800 && ownerRefEmb) {
        const dpdfEmb = extractCamppEmbedding(dpdfActiveSpeech);
        if (dpdfEmb) {
          dpdfSoloSimToOwner = cosineSimilarity(dpdfEmb, ownerRefEmb);
        }
        // 长单段检查首尾声纹一致性，防止把无停顿切换说话人误判成单人
        if (dpdfActiveSec >= 2.4) {
          const chunkSamples = Math.round(16000 * 1.1);
          const headSlice = dpdfActiveSpeech.subarray(0, chunkSamples);
          const tailSlice = dpdfActiveSpeech.subarray(dpdfActiveSpeech.length - chunkSamples);
          if (computeRms(headSlice) >= 0.012 && computeRms(tailSlice) >= 0.012) {
            const headEmb = extractCamppEmbedding(headSlice);
            const tailEmb = extractCamppEmbedding(tailSlice);
            if (headEmb && tailEmb && cosineSimilarity(headEmb, tailEmb) < 0.42) {
              dpdfSingleSegConsistent = false;
            }
          }
        }
      }

      const ownerCleanlyCapturesAll =
        dpdfVadSegs.length === 1 &&
        ownerVadSegs.length === 1 &&
        dpdfSingleSegConsistent &&
        dpdfActiveSec > 0 &&
        dpdfActiveSec < 10.0 &&
        ownerActiveSec >= dpdfActiveSec * 0.85 &&
        ownerActiveRms >= dpdfActiveRms * 0.80 &&
        dpdfSoloSimToOwner >= 0.62 &&
        scene.crowdTvProb < 0.08;

      const hasAnySpeechCandidate =
        dpdfVadSegs.length > 0 || ownerVadSegs.length > 0 || scene.speechProb >= 0.18;

      // Branch B: VoxLock Family 目标说话人提取
      const tFamily = performance.now();
      let familySamples: Float32Array = new Float32Array(0);
      let familyVadSegs: TimedVadSegment[] = [];
      let familyActiveSec = 0;
      let familyActiveRms = 0;
      let familyActiveSpeech: Float32Array = new Float32Array(0);
      let familyBranchEmb: number[] | null = null;

      if (!ownerCleanlyCapturesAll && hasAnySpeechCandidate && existsSync(familyRefPath)) {
        const familyTse = pool.extractTargetSpeakerVoxLock(pcm16k, familyRefPath);
        if (familyTse && hasAudibleEnergy(familyTse.samples, 0.005)) {
          familySamples = familyTse.samples;
          familyVadSegs = extractTimedVadSegments(engine, familySamples, turnVadOpts);
          familyActiveSec = totalVadSec(familyVadSegs);
          familyActiveSpeech = concatSegmentSamples(familyVadSegs);
          familyActiveRms = computeRms(familyActiveSpeech);
          if (familyActiveSpeech.length >= 4000) {
            familyBranchEmb = extractCamppEmbedding(familyActiveSpeech);
          }
        }
      }
      stageTimingsMs.voxlockFamilyMs = Math.round(performance.now() - tFamily);

      // ==================== Stage 3: 多说话人检测（VoxLock 双通道 + CAM++ 聚类） ====================
      const tSpk = performance.now();
      let multiSpeaker = false;
      let detectedSpeakerCount = 0;
      let ownerAndFamilyDistinct = false;
      const musicHeavyForCampp = scene.singingProb >= 0.08 || scene.musicProb >= 0.28;

      // 检测器 1: VoxLock Owner vs Family 双通道独立活跃段检测（可检出 100% 重叠串话）
      if (
        ownerActiveSec >= 0.45 &&
        familyActiveSec >= 0.45 &&
        ownerActiveRms >= 0.012 &&
        familyActiveRms >= 0.012
      ) {
        const rmsBalance =
          Math.min(ownerActiveRms, familyActiveRms) /
          Math.max(1e-6, Math.max(ownerActiveRms, familyActiveRms));
        const crossSim =
          ownerBranchEmb && familyBranchEmb
            ? cosineSimilarity(ownerBranchEmb, familyBranchEmb)
            : 1.0;
        const ownerSimOwnRef =
          ownerBranchEmb && ownerRefEmb ? cosineSimilarity(ownerBranchEmb, ownerRefEmb) : 0;
        const ownerSimFamRef =
          ownerBranchEmb && familyRefEmb ? cosineSimilarity(ownerBranchEmb, familyRefEmb) : 0;
        const famSimFamRef =
          familyBranchEmb && familyRefEmb ? cosineSimilarity(familyBranchEmb, familyRefEmb) : 0;
        const famSimOwnRef =
          familyBranchEmb && ownerRefEmb ? cosineSimilarity(familyBranchEmb, ownerRefEmb) : 0;

        const temporalDistinctSec =
          rangesDistinctDuration(ownerVadSegs, familyVadSegs) +
          rangesDistinctDuration(familyVadSegs, ownerVadSegs);

        const refPreferenceSplit =
          ownerSimOwnRef > ownerSimFamRef + 0.07 && famSimFamRef > famSimOwnRef + 0.07;

        if (
          (rmsBalance >= 0.18 && crossSim < 0.48) ||
          (rmsBalance >= 0.22 && crossSim < 0.56 && refPreferenceSplit) ||
          (temporalDistinctSec >= 0.65 && crossSim < 0.56 && rmsBalance >= 0.16)
        ) {
          multiSpeaker = true;
          ownerAndFamilyDistinct = true;
          detectedSpeakerCount = Math.max(detectedSpeakerCount, 2);
        }
      }

      // 检测器 2: DPDFNet4 细分 VAD 段间 CAM++ 说话人余弦相似度检测（覆盖未注册说话人如 Yaoyao / David / TV）
      const dpdfFineSegs = dpdfVadSegs.filter(
        (s) => s.endSec - s.startSec >= 0.45 && computeRms(s.samples) >= 0.012,
      );

      const dpdfSegEmbeddings: Array<{ seg: TimedVadSegment; emb: number[] }> = [];
      for (const seg of dpdfFineSegs.slice(0, 6)) {
        const emb = extractCamppEmbedding(seg.samples);
        if (emb) {
          dpdfSegEmbeddings.push({ seg, emb });
        }
      }

      if (!musicHeavyForCampp && dpdfSegEmbeddings.length >= 2) {
        let minPairSim = 1.0;
        for (let i = 0; i < dpdfSegEmbeddings.length; i += 1) {
          for (let j = i + 1; j < dpdfSegEmbeddings.length; j += 1) {
            const sim = cosineSimilarity(dpdfSegEmbeddings[i]!.emb, dpdfSegEmbeddings[j]!.emb);
            if (sim < minPairSim) minPairSim = sim;
          }
        }
        if (minPairSim < 0.46) {
          multiSpeaker = true;
          // 贪心凝聚聚类估计说话人数量（阈值 0.46）
          const clusters: number[][] = [];
          for (const item of dpdfSegEmbeddings) {
            let matchedIdx = -1;
            let bestSim = -1;
            for (let c = 0; c < clusters.length; c += 1) {
              const sim = cosineSimilarity(item.emb, clusters[c]!);
              if (sim >= 0.46 && sim > bestSim) {
                bestSim = sim;
                matchedIdx = c;
              }
            }
            if (matchedIdx < 0) {
              clusters.push(item.emb);
            }
          }
          detectedSpeakerCount = Math.max(detectedSpeakerCount, clusters.length);
        }
      } else if (!musicHeavyForCampp && dpdfSegEmbeddings.length === 1) {
        // 检查单条长语音段内是否存在无停顿切换说话人，或 Owner 与未注册说话人部分错峰叠加
        const onlySeg = dpdfSegEmbeddings[0]!.seg;
        const onlyDur = onlySeg.endSec - onlySeg.startSec;
        if (onlyDur >= 2.5) {
          const chunkSamples = Math.round(16000 * 1.1);
          const headSlice = onlySeg.samples.subarray(0, chunkSamples);
          const tailSlice = onlySeg.samples.subarray(onlySeg.samples.length - chunkSamples);
          if (computeRms(headSlice) >= 0.014 && computeRms(tailSlice) >= 0.014) {
            const headEmb = extractCamppEmbedding(headSlice);
            const tailEmb = extractCamppEmbedding(tailSlice);
            if (headEmb && tailEmb && cosineSimilarity(headEmb, tailEmb) < 0.34) {
              multiSpeaker = true;
              detectedSpeakerCount = Math.max(detectedSpeakerCount, 2);
            }
          }
        }
        // 检查是否存在 DPDFNet4 有明显语音但 VoxLock Owner 静音的未注册说话人片段
        if (
          !multiSpeaker &&
          ownerActiveSec >= 0.45 &&
          ownerBranchEmb &&
          dpdfActiveSec >= ownerActiveSec + 0.6
        ) {
          const uncoveredSec = rangesDistinctDuration(dpdfFineSegs, ownerVadSegs);
          if (uncoveredSec >= 0.55) {
            for (const seg of dpdfFineSegs) {
              const ov = ownerVadSegs.reduce(
                (acc, os) => acc + intervalsOverlapSec(seg.startSec, seg.endSec, os.startSec, os.endSec),
                0,
              );
              if (seg.endSec - seg.startSec - ov >= 0.5) {
                const emb = extractCamppEmbedding(seg.samples);
                if (emb && cosineSimilarity(emb, ownerBranchEmb) < 0.46) {
                  multiSpeaker = true;
                  detectedSpeakerCount = Math.max(detectedSpeakerCount, 2);
                  break;
                }
              }
            }
          }
        }
      }
      stageTimingsMs.speakerDetectMs = Math.round(performance.now() - tSpk);

      // ==================== Stage 4: 逐分支逐段 ASR + 句首对齐英文探针 + OWW 声学打分 ====================
      const tAsr = performance.now();

      const decodeSingleSegment = async (
        branchId: BranchId,
        segIndex: number,
        seg: TimedVadSegment,
      ): Promise<{
        origText: string;
        candidateText: string;
        asrEvent: string;
        asrLang: string;
        acousticWake: WakeWordAcousticHit | null;
        enHeadText: string;
        enHeadHit: { wakeWord: string; matchedSurface: string; fuzzy: boolean } | null;
        wakeProvenance: WakeProvenance;
        segRms: number;
      }> => {
        const segRms = computeRms(seg.samples);
        if (!hasAudibleEnergy(seg.samples, 0.0045)) {
          return {
            origText: "",
            candidateText: "",
            asrEvent: "",
            asrLang: "",
            acousticWake: null,
            enHeadText: "",
            enHeadHit: null,
            wakeProvenance: "none",
            segRms,
          };
        }

        const segDurSec = seg.samples.length / 16000;

        // 1. 主解码 (SenseVoice zh-CN -> auto) + 句首 openWakeWord 声学打分
        let activeSegSamples: Float32Array = seg.samples;
        let svAuto: LocalAsrOutput = await engine.transcribeLocal(activeSegSamples, 16000, "zh-CN");
        let acousticWake = engine.scoreWakeWordAudio(activeSegSamples, wakeWords, {
          threshold: 0.6,
          headOnlySec: 2.0,
        });

        // 若句首 2s 内声学命中但落点偏后（>= 1.4s），先按声学落点裁掉前序旁白/歌词并重解码，防止串话混入命令
        if (
          acousticWake?.matched &&
          acousticWake.sampleOffset >= 22400 &&
          !findWakeWordSpan(svAuto.text, wakeWords) &&
          !isExtendedThirdPersonNeoMention(svAuto.text)
        ) {
          const sliceStart = Math.max(0, acousticWake.sampleOffset - 10400);
          const subPcm = seg.samples.subarray(sliceStart);
          if (subPcm.length >= 4800) {
            const subAsr = await engine.transcribeLocal(subPcm, 16000, "zh-CN");
            if (subAsr.text.trim()) {
              activeSegSamples = subPcm;
              svAuto = subAsr;
            }
          }
        }

        // 若单段较长 (>2.2s) 且句首 2s 未检测到唤醒词，检查是否存在零停顿中段切换说话人或中段唤醒词
        if (
          segDurSec > 2.2 &&
          !acousticWake?.matched &&
          !findWakeWordSpan(svAuto.text, wakeWords) &&
          !isExtendedThirdPersonNeoMention(svAuto.text)
        ) {
          const laterClause = findLaterDomainClauseCharOffset(svAuto.text);
          const midThreshold = laterClause ? 0.56 : 0.68;
          const midHit = engine.scoreWakeWordAudio(seg.samples, wakeWords, {
            threshold: midThreshold,
          });

          if (midHit?.matched && midHit.sampleOffset > 12800) {
            const sliceStart = Math.max(0, midHit.sampleOffset - 10400);
            const subPcm = seg.samples.subarray(sliceStart);
            if (subPcm.length >= 4800) {
              const subAsr = await engine.transcribeLocal(subPcm, 16000, "zh-CN");
              const subTextClean = subAsr.text.trim();
              if (subTextClean) {
                activeSegSamples = subPcm;
                svAuto = subAsr;
                acousticWake = midHit;
              }
            }
          } else if (laterClause && asciiWakes.length > 0) {
            // 在后半段智能家居子句估算起点（或 midHit 峰值位置）附近做局部句首对齐 en-US 探针
            const estSample =
              midHit && midHit.score >= 0.32 && midHit.sampleOffset > 12800
                ? Math.max(0, midHit.sampleOffset - 10400)
                : Math.max(0, Math.round(seg.samples.length * laterClause.charRatio) - 7200);
            const probeEnd = Math.min(seg.samples.length, estSample + Math.round(16000 * 1.25));
            const midProbeSlice = seg.samples.subarray(estSample, probeEnd);
            if (midProbeSlice.length >= 4800) {
              const midEn = await engine.transcribeLocal(midProbeSlice, 16000, "en-US");
              const midEnHit = matchEnglishHeadWakeWord(midEn.text.trim(), asciiWakes, {
                allowCommandGatedAliases: true,
              });
              const midEnStrong =
                midEnHit &&
                (!midEnHit.fuzzy ||
                  STRONG_NEO_HOMOPHONES.has(midEnHit.matchedSurface.toLowerCase()) ||
                  (midHit?.score ?? 0) >= 0.3);
              if (midEnStrong) {
                const subPcm = seg.samples.subarray(estSample);
                if (subPcm.length >= 4800) {
                  const subAsr = await engine.transcribeLocal(subPcm, 16000, "zh-CN");
                  if (subAsr.text.trim()) {
                    activeSegSamples = subPcm;
                    svAuto = subAsr;
                    if (midHit && (!acousticWake || midHit.score > acousticWake.score)) {
                      acousticWake = midHit;
                    }
                  }
                }
              }
            }
          }
        }

        const activeDurSec = activeSegSamples.length / 16000;
        let baseText = svAuto.text.trim();
        let baseLang = svAuto.lang;
        const baseEvent = svAuto.event;

        // 若识别为英文语音，补跑一次 en-US 全段解码以提升英文智能家居指令清晰度
        if (
          (baseLang.toLowerCase().includes("en") || isPredominantlyEnglish(baseText)) &&
          (!findWakeWordSpan(baseText, wakeWords) || !hasSmartHomeDomainIntent(baseText))
        ) {
          const enFull = await engine.transcribeLocal(activeSegSamples, 16000, "en-US");
          const enFullText = enFull.text.trim();
          const autoSpan = findWakeWordSpan(baseText, wakeWords);
          const enSpan = findWakeWordSpan(enFullText, wakeWords);
          if (
            enFullText &&
            ((enSpan && !autoSpan) ||
              (enSpan && !enSpan.fuzzy && autoSpan?.fuzzy) ||
              (hasSmartHomeDomainIntent(enFullText) && !hasSmartHomeDomainIntent(baseText)))
          ) {
            baseText = enFullText;
            baseLang = enFull.lang || "en";
          }
        }

        const origText = baseText;
        const origSpan = findWakeWordSpan(origText, wakeWords);
        const segThirdPerson = isExtendedThirdPersonNeoMention(origText);

        // 2. 起止对齐的英文句首探针（0..1.15s & 0..0.65s），仅在配置英文唤醒词且无精确命中时触发
        let enHeadText = "";
        let enHeadHit: { wakeWord: string; matchedSurface: string; fuzzy: boolean } | null = null;
        const meaningful = stripPunct(origText);
        const hasWeirdScript = WEIRD_SCRIPT_RE.test(origText);
        WEIRD_SCRIPT_RE.lastIndex = 0;

        const extractedForProbe = extractCleanCommandAfterConfirmedWake(origText, primaryWake);
        const probeHasDomainCmd =
          extractedForProbe.length >= 2 && hasSmartHomeDomainIntent(extractedForProbe);
        const probeIsWakeQ = isWakeQueryText(extractedForProbe);
        const isShortOrGarbled =
          activeDurSec <= 2.1 || meaningful.length <= 5 || hasWeirdScript || meaningful.length === 0;

        if (
          asciiWakes.length > 0 &&
          !segThirdPerson &&
          (!origSpan || origSpan.fuzzy) &&
          (isShortOrGarbled ||
            probeHasDomainCmd ||
            probeIsWakeQ ||
            Boolean(origSpan?.fuzzy) ||
            Boolean(acousticWake?.matched))
        ) {
          const head115End = Math.min(activeSegSamples.length, Math.round(16000 * 1.15));
          const head115 =
            activeDurSec <= 1.35 ? activeSegSamples : activeSegSamples.subarray(0, head115End);
          const en115 = await engine.transcribeLocal(head115, 16000, "en-US");
          enHeadText = en115.text.trim();
          enHeadHit = matchEnglishHeadWakeWord(enHeadText, asciiWakes, {
            allowCommandGatedAliases: probeHasDomainCmd,
          });

          // 快速连读短句（如 "Neo关灯"）：补探更紧的前 0.65s，避免后续中文音节干扰英文识别
          if (!enHeadHit && activeSegSamples.length >= Math.round(16000 * 0.7)) {
            const head065 = activeSegSamples.subarray(0, Math.round(16000 * 0.65));
            const en065 = await engine.transcribeLocal(head065, 16000, "en-US");
            const hit065 = matchEnglishHeadWakeWord(en065.text.trim(), asciiWakes, {
              allowCommandGatedAliases: probeHasDomainCmd,
            });
            if (hit065) {
              enHeadText = en065.text.trim();
              enHeadHit = hit065;
            }
          }

          // 若英文句首探针命中 Neo 但中文主轨乱码/空，对较长段尝试全段 en-US 解码（挽救纯英文指令）
          if (
            enHeadHit &&
            activeDurSec > 1.25 &&
            (!probeHasDomainCmd || hasWeirdScript || meaningful.length <= 3)
          ) {
            const enFull = await engine.transcribeLocal(activeSegSamples, 16000, "en-US");
            const enFullSpan = findWakeWordSpan(enFull.text.trim(), asciiWakes);
            if (
              enFullSpan &&
              enFullSpan.afterText.length >= 4 &&
              (hasSmartHomeDomainIntent(enFullSpan.afterText) ||
                looksLikeDirectDeviceCommand(enFullSpan.afterText))
            ) {
              baseText = enFull.text.trim();
              baseLang = enFull.lang || "en";
            }
          }
        }

        // 3. 安全规范化候选文本（严格防误改写：绝不改写第三人称提及、绝不放行无域意图的 "你好"/"你有"）
        let candidateText = baseText;
        let wakeProvenance: WakeProvenance = "none";

        const postSpan = findWakeWordSpan(candidateText, wakeWords);
        if (segThirdPerson || isExtendedThirdPersonNeoMention(candidateText)) {
          return {
            origText,
            candidateText,
            asrEvent: baseEvent,
            asrLang: baseLang,
            acousticWake,
            enHeadText,
            enHeadHit,
            wakeProvenance: "none",
            segRms,
          };
        }

        if (postSpan && !postSpan.fuzzy) {
          wakeProvenance = "exact-asr";
          return {
            origText,
            candidateText,
            asrEvent: baseEvent,
            asrLang: baseLang,
            acousticWake,
            enHeadText,
            enHeadHit,
            wakeProvenance,
            segRms,
          };
        }

        const wakeWordTarget = enHeadHit?.wakeWord ?? acousticWake?.wakeWord ?? primaryWake;
        const extracted = extractCleanCommandAfterConfirmedWake(candidateText, wakeWordTarget);
        const hasDomainCmd = extracted.length >= 2 && hasSmartHomeDomainIntent(extracted);
        const isWakeQ = isWakeQueryText(extracted);
        const ambiguousQuestion = isAmbiguousInterrogativeZh(candidateText, wakeWordTarget);
        const humanAddressed = HUMAN_ADDRESSED_PREFIX_RE.test(candidateText.trim());
        const owwScore = acousticWake?.score ?? 0;

        // 强音译同音词（如 "尼奥"/"尼欧"/"Neil"/"Nio"，绝非 "你好"/"你有"）+ 智能家居指令
        const origSurfaceLower = postSpan?.matchedSurface.toLowerCase() ?? "";
        const isStrongHomophoneInAsr =
          Boolean(postSpan?.fuzzy) &&
          STRONG_NEO_HOMOPHONES.has(origSurfaceLower) &&
          !AMBIGUOUS_FUZZY_ZH_SURFACES.has(postSpan!.matchedSurface);

        if (isStrongHomophoneInAsr && (hasDomainCmd || isWakeQ || !postSpan!.afterText)) {
          candidateText =
            extracted && !isWakeQ ? `${postSpan!.wakeWord}，${extracted}` : postSpan!.wakeWord;
          wakeProvenance = "homophone-asr";
          return {
            origText,
            candidateText,
            asrEvent: baseEvent,
            asrLang: baseLang,
            acousticWake,
            enHeadText,
            enHeadHit,
            wakeProvenance,
            segRms,
          };
        }

        const enHeadExact = Boolean(enHeadHit && !enHeadHit.fuzzy);
        const enHeadStrongHomophone = Boolean(
          enHeadHit && STRONG_NEO_HOMOPHONES.has(enHeadHit.matchedSurface.toLowerCase()),
        );

        // 场景 A: 唤醒词 + 明确智能家居指令恢复
        if (hasDomainCmd && !isWakeQ && (!ambiguousQuestion || enHeadExact)) {
          const allowEnHeadCmdRewrite =
            Boolean(enHeadHit) &&
            (enHeadExact ||
              (!humanAddressed &&
                (enHeadStrongHomophone ||
                  owwScore >= 0.28 ||
                  Boolean(postSpan?.fuzzy) ||
                  looksLikeDirectDeviceCommand(candidateText.trim()) ||
                  looksLikeDirectDeviceCommand(extracted))));

          const allowOwwCmdRewrite =
            Boolean(acousticWake?.matched) &&
            !ambiguousQuestion &&
            (!humanAddressed || owwScore >= 0.62);

          if (allowEnHeadCmdRewrite || allowOwwCmdRewrite) {
            candidateText = `${wakeWordTarget}，${extracted}`;
            if (enHeadExact && acousticWake?.matched) {
              wakeProvenance = "en-head+oww";
            } else if (enHeadExact) {
              wakeProvenance = "en-head-exact";
            } else if (acousticWake?.matched) {
              wakeProvenance = "oww-matched";
            } else {
              wakeProvenance = "en-head-fuzzy";
            }
            return {
              origText,
              candidateText,
              asrEvent: baseEvent,
              asrLang: baseLang,
              acousticWake,
              enHeadText,
              enHeadHit,
              wakeProvenance,
              segRms,
            };
          }
        }

        // 场景 B: 纯唤醒 / 唤醒询问（"Neo" / "Hey Neo" / "Neo在吗"）
        if ((isShortOrGarbled || isWakeQ) && !ambiguousQuestion && !humanAddressed) {
          const isCommonGreetingOrFiller = COMMON_NON_WAKE_PHRASE_RE.test(meaningful);
          const isPlainNiHaoOrNiYou = /^(?:你好|您好|你有|你又|你给)$/.test(meaningful);

          const allowStandaloneRecovery =
            // 普通 "你好"/"你有" 必须同时有精确英文 "Neo" + OWW 高分 corroboration（防纯问候误唤）
            isPlainNiHaoOrNiYou
              ? enHeadExact && owwScore >= 0.38
              : isCommonGreetingOrFiller
                ? enHeadExact && owwScore >= 0.42 && meaningful.length <= 2
                : enHeadExact ||
                  (enHeadStrongHomophone && (hasWeirdScript || meaningful.length <= 3 || isWakeQ || owwScore >= 0.28)) ||
                  (Boolean(acousticWake?.matched) &&
                    (hasWeirdScript || meaningful.length <= 3 || isWakeQ));

          if (allowStandaloneRecovery) {
            const enSpan = findWakeWordSpan(enHeadText, asciiWakes);
            const enAfter = enSpan?.afterText ?? "";
            if (enAfter && hasSmartHomeDomainIntent(enAfter)) {
              candidateText = `${wakeWordTarget}，${enAfter}`;
            } else {
              candidateText = wakeWordTarget;
            }
            if (enHeadExact && acousticWake?.matched) {
              wakeProvenance = "en-head+oww";
            } else if (enHeadExact) {
              wakeProvenance = "en-head-exact";
            } else if (acousticWake?.matched) {
              wakeProvenance = "oww-matched";
            } else {
              wakeProvenance = "en-head-fuzzy";
            }
          }
        }

        return {
          origText,
          candidateText,
          asrEvent: baseEvent,
          asrLang: baseLang,
          acousticWake,
          enHeadText,
          enHeadHit,
          wakeProvenance,
          segRms,
        };
      };

      // 先解码全部主干分支（Branch C: dpdfnet_general, Branch A: voxlock_owner, Branch B: voxlock_family）
      type RawBranchDecode = {
        branchId: BranchId;
        speakerId?: string;
        samples: Float32Array;
        vadSegments: TimedVadSegment[];
        activeSec: number;
        activeRms: number;
        segResults: Array<Awaited<ReturnType<typeof decodeSingleSegment>> & { seg: TimedVadSegment; segIndex: number }>;
        mergedText: string;
      };

      const runBranchDecode = async (
        branchId: BranchId,
        samples: Float32Array,
        vadSegments: TimedVadSegment[],
        activeSec: number,
        activeRms: number,
        speakerId?: string,
      ): Promise<RawBranchDecode> => {
        const capped = vadSegments.slice(0, 6);
        const segResults = await Promise.all(
          capped.map(async (seg, idx) => {
            const res = await decodeSingleSegment(branchId, idx, seg);
            return { ...res, seg, segIndex: idx };
          }),
        );
        const mergedText = segResults
          .map((r) => r.origText)
          .filter(Boolean)
          .join("，");
        return {
          branchId,
          speakerId,
          samples,
          vadSegments: capped,
          activeSec,
          activeRms,
          segResults,
          mergedText,
        };
      };

      // 并行运行三个核心分支的异步 SenseVoice 解码
      const coreBranchPromises: Array<Promise<RawBranchDecode>> = [
        runBranchDecode(
          "dpdfnet_general",
          dpdfRes.samples,
          dpdfVadSegs,
          dpdfActiveSec,
          dpdfActiveRms,
          "general",
        ),
        runBranchDecode(
          "voxlock_owner",
          ownerSamples,
          ownerVadSegs,
          ownerActiveSec,
          ownerActiveRms,
          "owner",
        ),
      ];
      if (familyVadSegs.length > 0) {
        coreBranchPromises.push(
          runBranchDecode(
            "voxlock_family",
            familySamples,
            familyVadSegs,
            familyActiveSec,
            familyActiveRms,
            "family",
          ),
        );
      }

      const rawBranches = await Promise.all(coreBranchPromises);
      const dpdfBranchRaw = rawBranches.find((b) => b.branchId === "dpdfnet_general")!;

      // 构造全局 / 时序对齐的第三人称提及与回声检查上下文（防止孤立分支裁掉 "别管" 或截断回声）
      const dpdfFullText = dpdfBranchRaw.mergedText;
      const dpdfFullThirdPerson = isExtendedThirdPersonNeoMention(dpdfFullText);
      const dpdfNeoMentionCount = countNeoLikeMentions(dpdfFullText);

      // 预先对 dpdfnet_general 的每个段做一次回声检查，供 TSE 分支防回声泄漏使用
      const dpdfEchoWindows: Array<{ startSec: number; endSec: number; text: string }> = [];
      if (dialogCtx.lastSpokenReply) {
        for (const r of dpdfBranchRaw.segResults) {
          if (!r.origText) continue;
          const overlap = computeEchoOverlap(r.origText, dialogCtx.lastSpokenReply);
          const span = findWakeWordSpan(r.origText, wakeWords);
          const looksDirect = looksLikeDirectDeviceCommand(r.origText);
          const threshold = span || looksDirect ? 0.88 : 0.6;
          if (overlap >= threshold) {
            dpdfEchoWindows.push({
              startSec: r.seg.startSec,
              endSec: r.seg.endSec,
              text: r.origText,
            });
          }
        }
      }

      const isBlockedByThirdPersonContext = (
        segOrigText: string,
        branchFullText: string,
        startSec: number,
        endSec: number,
      ): boolean => {
        if (isExtendedThirdPersonNeoMention(segOrigText)) return true;
        if (isExtendedThirdPersonNeoMention(branchFullText)) return true;
        // 检查时间对齐的 dpdfnet_general 片段（前后各扩 1.2s，防止 VoxLock 裁掉 "别管"）
        for (const dr of dpdfBranchRaw.segResults) {
          if (intervalsOverlapSec(startSec - 1.2, endSec + 0.5, dr.seg.startSec, dr.seg.endSec) > 0) {
            if (isExtendedThirdPersonNeoMention(dr.origText)) {
              return true;
            }
          }
        }
        // 若全局 dpdf 仅出现至多一次 Neo 提及且为第三人称讨论 -> 禁止任何分支将其误判为指令
        if (dpdfFullThirdPerson && dpdfNeoMentionCount <= 1) {
          return true;
        }
        return false;
      };

      const isBlockedByDpdfEcho = (
        candidateText: string,
        startSec: number,
        endSec: number,
      ): boolean => {
        if (!dialogCtx.lastSpokenReply || dpdfEchoWindows.length === 0) return false;
        if (findWakeWordSpan(candidateText, wakeWords)) return false;
        for (const ew of dpdfEchoWindows) {
          if (intervalsOverlapSec(startSec, endSec, ew.startSec, ew.endSec) > 0.25) {
            // 若该分支文本与已确认的回声段高度重合或与播报回复高度重合，则拦截 TSE 残余回声
            const ovReply = computeEchoOverlap(candidateText, dialogCtx.lastSpokenReply);
            const ovEcho = computeEchoOverlap(candidateText, ew.text);
            if (ovReply >= 0.55 || ovEcho >= 0.6) {
              return true;
            }
          }
        }
        return false;
      };

      const scoreAcceptedCandidate = (
        branchId: BranchId,
        decision: AttentionDecision,
        provenance: WakeProvenance,
        acousticWake: WakeWordAcousticHit | null,
        segRms: number,
      ): number => {
        let score = 0;

        // 1. 唤醒来源可信度
        switch (provenance) {
          case "exact-asr":
            score += 56;
            break;
          case "en-head+oww":
            score += 52;
            break;
          case "en-head-exact":
            score += 45;
            break;
          case "oww-matched":
            score += 42;
            break;
          case "homophone-asr":
            score += 38;
            break;
          case "en-head-fuzzy":
            score += 32;
            break;
          case "conversation-followup":
            score += 36;
            break;
          default:
            score += 18;
            break;
        }

        // 2. 指令完整度与智能家居域相关性
        const cmd = decision.command.trim();
        if (!decision.wokeOnly && cmd.length > 0) {
          if (hasSmartHomeDomainIntent(cmd)) score += 46;
          else if (hasConversationDeviceIntent(cmd)) score += 32;
          const isDirectStart = looksLikeDirectDeviceCommand(cmd);
          if (isDirectStart) {
            score += 22;
          } else if (stripPunct(cmd).length > 10) {
            // 惩罚句首疑似混入旁白/闲聊前缀的指令，优先选干净隔离出的核心命令
            score -= 18;
          }
          // 惩罚包含未分离旁白/歌词的超长指令
          const normLen = stripPunct(cmd).length;
          if (normLen > 24) {
            score -= (normLen - 24) * 2.5;
          }
          const weirdCount = (cmd.match(WEIRD_SCRIPT_RE) ?? []).length;
          if (weirdCount > 0) score -= weirdCount * 22;
        } else if (decision.wokeOnly) {
          score += 12;
        }

        // 3. 声学场景与分支专长加权
        const hasMusicOrSong = scene.musicProb >= 0.14 || scene.singingProb >= 0.055;
        if (multiSpeaker) {
          // 多人/重叠串话场景强烈偏好 VoxLock 目标说话人提取分支
          if (branchId === "voxlock_owner") score += 26;
          else if (branchId === "voxlock_family") score += 23;
          else if (branchId === "dpdfnet_general") score += 8;
          else score += 2;
        } else if (hasMusicOrSong) {
          // 歌声/BGM 场景偏好 VoxLock 声纹锁人声提取，同时保留 DPDFNet4/Raw 高保真备选
          if (branchId === "voxlock_owner") score += 21;
          else if (branchId === "voxlock_family") score += 18;
          else if (branchId === "dpdfnet_general") score += 13;
          else score += 10;
        } else if (inputSnrDb >= 18) {
          // 干净高信噪比单人语音：高通原始轨无神经降噪失真，各分支均衡择优
          if (branchId === "raw_hp") score += 18;
          else if (branchId === "dpdfnet_general") score += 17;
          else if (branchId === "voxlock_owner") score += 16;
          else score += 14;
        } else {
          // 强环境噪声单人语音：DPDFNet4 与 VoxLock 优先
          if (branchId === "dpdfnet_general") score += 21;
          else if (branchId === "voxlock_owner") score += 19;
          else if (branchId === "voxlock_family") score += 16;
          else score += 5;
        }

        // 4. 声学唤醒分与有效人声能量细粒度加分
        if (acousticWake) {
          score += Math.min(10, acousticWake.score * 10);
        }
        score += Math.min(8, segRms * 55);
        return Number(score.toFixed(2));
      };

      const evaluateBranchCandidate = async (
        branchId: BranchId,
        segIndex: number,
        startSec: number,
        endSec: number,
        segRms: number,
        origText: string,
        candidateText: string,
        asrEvent: string,
        asrLang: string,
        acousticWake: WakeWordAcousticHit | null,
        enHeadText: string,
        enHeadHit: { wakeWord: string; matchedSurface: string; fuzzy: boolean } | null,
        wakeProvenance: WakeProvenance,
        branchFullText: string,
        stitchedFromWake = false,
      ): Promise<BranchSegmentDecode> => {
        const makeReject = (stage: AttentionDecision["stage"], reason: string): BranchSegmentDecode => ({
          branchId,
          segIndex,
          startSec,
          endSec,
          segRms,
          origText,
          candidateText,
          asrEvent,
          asrLang,
          acousticWake,
          enHeadText,
          enHeadHit,
          wakeProvenance,
          decision: {
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
          },
          rankScore: -100,
          stitchedFromWake,
        });

        const cleanCand = candidateText.trim();
        if (!cleanCand) {
          return makeReject("no-wake", "识别文本为空");
        }

        // 反误触规则 1: 严禁放行或改写任何第三人称 Neo 提及（同时校验当前分支与 dpdfnet_general 全文）
        if (isBlockedByThirdPersonContext(origText, branchFullText, startSec, endSec)) {
          return makeReject("pragmatic-reject", "检测到对唤醒词的第三人称提及或否定呼唤语境");
        }

        // 反误触规则 2: 严禁在无智能家居域意图时接受模糊 "你好" / "你有" 别名
        const origSpan = findWakeWordSpan(origText, wakeWords);
        const candSpan = findWakeWordSpan(cleanCand, wakeWords);
        if (
          candSpan?.fuzzy &&
          AMBIGUOUS_FUZZY_ZH_SURFACES.has(candSpan.matchedSurface) &&
          !hasSmartHomeDomainIntent(candSpan.afterText)
        ) {
          return makeReject(
            "pragmatic-reject",
            `拦截无智能家居域意图的模糊别名「${candSpan.matchedSurface}」`,
          );
        }
        if (
          origSpan?.fuzzy &&
          AMBIGUOUS_FUZZY_ZH_SURFACES.has(origSpan.matchedSurface) &&
          !hasSmartHomeDomainIntent(origSpan.afterText) &&
          wakeProvenance !== "en-head+oww" &&
          wakeProvenance !== "en-head-exact"
        ) {
          return makeReject(
            "pragmatic-reject",
            `原始转写仅命中无域意图的模糊词「${origSpan.matchedSurface}」`,
          );
        }

        // 反误触规则 3: 连续对话模式下拦截纯歌声歌词（核心指标保护）
        if (inConversation && !candSpan) {
          if (
            scene.singingProb >= 0.12 &&
            scene.speechProb < 0.25 &&
            !hasSmartHomeDomainIntent(cleanCand)
          ) {
            return makeReject("acoustic", "连续对话模式下拦截纯歌声歌词");
          }
          if (scene.singingProb >= 0.1 && !hasConversationDeviceIntent(cleanCand)) {
            return makeReject("acoustic", "连续对话模式下拦截无设备意图的歌声片段");
          }

          // 扩展礼貌退出短语（无设备意图）
          const normExit = stripPunct(cleanCand);
          if (EXTENDED_POLITE_EXIT_RE.test(normExit)) {
            return makeReject("exit", "识别到礼貌结束对话口令，回到待机模式");
          }

          // 连续对话模式无唤醒词防旁白：若仅凭 "帮我/把/请/给我/麻烦" 等通用前缀命中，必须含设备/助手意图
          if (GENERIC_POLITE_PREFIX_RE.test(cleanCand) && !hasConversationDeviceIntent(cleanCand)) {
            return makeReject("pragmatic-reject", "连续对话模式下拦截无智能家居意图的日常家务旁白");
          }
        }

        // 反误触规则 4: 跨分支回声泄漏抑制
        if (isBlockedByDpdfEcho(cleanCand, startSec, endSec)) {
          return makeReject("echo", "跨分支回声校验命中系统播报回声，已抑制");
        }

        // 若场景检测到背景音乐/歌声，通知注意力门控自动裁切指令尾随歌词
        const hasMusicContext = scene.musicProb >= 0.14 || scene.singingProb >= 0.055;
        const effectiveEvent =
          asrEvent || (hasMusicContext ? "<|BGM|>" : "");

        const decision = await evaluateVoiceAttention({
          ...dialogCtx,
          rawText: cleanCand,
          altText: origText !== cleanCand ? origText : undefined,
          acousticEvent: effectiveEvent,
          acousticWake,
          owwActiveForWord: engine.openWakeWord.isReady,
        });

        // 门控后二次校验与指令清理
        if (decision.accept) {
          // 再次确认模糊 "你好"/"你有" 绝不会漏网无域意图指令
          if (
            candSpan?.fuzzy &&
            AMBIGUOUS_FUZZY_ZH_SURFACES.has(candSpan.matchedSurface) &&
            !hasSmartHomeDomainIntent(decision.command)
          ) {
            return makeReject(
              "pragmatic-reject",
              `二次校验拦截无智能家居域意图的模糊词「${candSpan.matchedSurface}」`,
            );
          }

          // 若连续对话模式（无唤醒词）放行，但指令既无智能家居意图也无续聊调节/助手查询意图 -> 保守拦截防闲聊误触
          if (
            inConversation &&
            !decision.wakeWord &&
            !decision.wokeOnly &&
            !hasConversationDeviceIntent(decision.command)
          ) {
            return makeReject("pragmatic-reject", "连续对话无唤醒词且缺乏明确设备控制语义，已拦截");
          }

          let cleanedCmd = cleanEdges(decision.command);
          if (!decision.wokeOnly && cleanedCmd && hasMusicContext) {
            cleanedCmd = cleanEdges(trimTrailingMusicLyrics(cleanedCmd));
          }

          const finalDecision: AttentionDecision = {
            ...decision,
            command: decision.wokeOnly ? "" : cleanedCmd,
          };

          const effProvenance: WakeProvenance =
            wakeProvenance !== "none"
              ? wakeProvenance
              : inConversation && !finalDecision.wakeWord
                ? "conversation-followup"
                : finalDecision.wakeWord
                  ? "homophone-asr"
                  : "none";

          return {
            branchId,
            segIndex,
            startSec,
            endSec,
            segRms,
            origText,
            candidateText: cleanCand,
            asrEvent,
            asrLang,
            acousticWake,
            enHeadText,
            enHeadHit,
            wakeProvenance: effProvenance,
            decision: finalDecision,
            rankScore: scoreAcceptedCandidate(
              branchId,
              finalDecision,
              effProvenance,
              acousticWake,
              segRms,
            ),
            stitchedFromWake,
          };
        }

        return {
          branchId,
          segIndex,
          startSec,
          endSec,
          segRms,
          origText,
          candidateText: cleanCand,
          asrEvent,
          asrLang,
          acousticWake,
          enHeadText,
          enHeadHit,
          wakeProvenance,
          decision,
          rankScore: -50,
          stitchedFromWake,
        };
      };

      const evaluateRawBranch = async (raw: RawBranchDecode): Promise<BranchRunResult> => {
        const decodes: BranchSegmentDecode[] = [];
        for (const r of raw.segResults) {
          const dec = await evaluateBranchCandidate(
            raw.branchId,
            r.segIndex,
            r.seg.startSec,
            r.seg.endSec,
            r.segRms,
            r.origText,
            r.candidateText,
            r.asrEvent,
            r.asrLang,
            r.acousticWake,
            r.enHeadText,
            r.enHeadHit,
            r.wakeProvenance,
            raw.mergedText,
          );
          decodes.push(dec);
        }

        // 同分支相邻段拼接：若某段是纯唤醒 "Neo"，且紧随其后（间隔 <= 1.25s）的同说话人段是明确设备指令，则合成完整命令
        for (let i = 0; i < decodes.length - 1; i += 1) {
          const cur = decodes[i]!;
          const next = decodes[i + 1]!;
          const gapSec = next.startSec - cur.endSec;
          if (
            cur.decision.accept &&
            cur.decision.wokeOnly &&
            cur.decision.wakeWord &&
            gapSec >= -0.2 &&
            gapSec <= 1.25 &&
            next.origText &&
            (hasSmartHomeDomainIntent(next.origText) || looksLikeDirectDeviceCommand(next.origText)) &&
            !isExtendedThirdPersonNeoMention(next.origText)
          ) {
            // 对于通用分支 (dpdfnet/raw)，检验相邻两段声纹一致性，防止把旁白人的话拼到唤醒词后
            let sameSpeakerOk =
              raw.branchId === "voxlock_owner" || raw.branchId === "voxlock_family";
            if (!sameSpeakerOk) {
              const curSeg = raw.segResults[i]?.seg;
              const nextSeg = raw.segResults[i + 1]?.seg;
              if (curSeg && nextSeg && curSeg.samples.length >= 4000 && nextSeg.samples.length >= 4000) {
                const sim = pool.speakerSimilarity(curSeg.samples, nextSeg.samples);
                sameSpeakerOk = sim >= 0.46;
              } else {
                sameSpeakerOk = !multiSpeaker;
              }
            }
            if (sameSpeakerOk) {
              const combinedText = `${cur.decision.wakeWord}，${cleanEdges(next.origText)}`;
              const stitched = await evaluateBranchCandidate(
                raw.branchId,
                cur.segIndex,
                cur.startSec,
                next.endSec,
                Math.max(cur.segRms, next.segRms),
                `${cur.origText}，${next.origText}`,
                combinedText,
                next.asrEvent || cur.asrEvent,
                next.asrLang || cur.asrLang,
                cur.acousticWake,
                cur.enHeadText,
                cur.enHeadHit,
                cur.wakeProvenance,
                raw.mergedText,
                true,
              );
              if (stitched.decision.accept && !stitched.decision.wokeOnly) {
                decodes.push(stitched);
              }
            }
          }
        }

        return {
          branchId: raw.branchId,
          speakerId: raw.speakerId,
          samples: raw.samples,
          vadSegments: raw.vadSegments,
          activeSec: raw.activeSec,
          activeRms: raw.activeRms,
          mergedText: raw.mergedText,
          decodes,
        };
      };

      const evaluatedBranches: BranchRunResult[] = [];
      for (const rb of rawBranches) {
        evaluatedBranches.push(await evaluateRawBranch(rb));
      }

      // 判断是否需要补跑 Branch D (raw_hp 原始高通轨)：
      // 1. 干净高信噪比音频（防止 VoxLock / DPDFNet4 削弱句首极短快读音节如 "Neo关灯"）
      // 2. 强背景音乐/歌声场景（原始高通有时保留更清晰辅音爆破音）
      // 3. 三个神经分支均未给出高置信带指令命中时作为兜底挽救
      const existingAccepted = evaluatedBranches
        .flatMap((b) => b.decodes)
        .filter((d) => d.decision.accept);

      const hasStrongCmdAccepted = existingAccepted.some(
        (d) =>
          !d.decision.wokeOnly &&
          (d.wakeProvenance === "exact-asr" ||
            d.wakeProvenance === "en-head+oww" ||
            d.wakeProvenance === "homophone-asr" ||
            d.wakeProvenance === "conversation-followup") &&
          hasSmartHomeDomainIntent(d.decision.command),
      );

      const neuralHasAnyText = evaluatedBranches.some((b) => b.mergedText.trim().length > 0);
      const shouldRunRawHp =
        !neuralHasAnyText ||
        (inputSnrDb >= 18 && !hasStrongCmdAccepted) ||
        (inputSnrDb >= 18 && !multiSpeaker && existingAccepted.every((d) => d.decision.wokeOnly)) ||
        ((scene.musicProb >= 0.14 || scene.singingProb >= 0.055) && !hasStrongCmdAccepted);

      if (shouldRunRawHp) {
        const rawVadSegs = extractTimedVadSegments(engine, rawHp, turnVadOpts);
        if (rawVadSegs.length > 0) {
          const rawActiveSec = totalVadSec(rawVadSegs);
          const rawActiveRms = computeRms(concatSegmentSamples(rawVadSegs));
          const rawDecoded = await runBranchDecode(
            "raw_hp",
            rawHp,
            rawVadSegs,
            rawActiveSec,
            rawActiveRms,
          );
          evaluatedBranches.push(await evaluateRawBranch(rawDecoded));
        }
      }
      stageTimingsMs.asrAndAttentionMs = Math.round(performance.now() - tAsr);

      // ==================== Stage 5: 多分支假设融合与择优 ====================
      const allDecodes = evaluatedBranches.flatMap((b) => b.decodes);
      const acceptedDecodes = allDecodes.filter((d) => d.decision.accept);

      // 跨分支一致性加分：若不同分支提取出高度一致的指令，则提升可信度
      for (const cand of acceptedDecodes) {
        if (cand.decision.wokeOnly || !cand.decision.command) continue;
        let agreeingBranches = 0;
        const seenBranch = new Set<BranchId>([cand.branchId]);
        for (const other of acceptedDecodes) {
          if (seenBranch.has(other.branchId)) continue;
          if (other.decision.wokeOnly || !other.decision.command) continue;
          if (computeNormCommandOverlap(cand.decision.command, other.decision.command) >= 0.65) {
            seenBranch.add(other.branchId);
            agreeingBranches += 1;
          }
        }
        cand.rankScore += agreeingBranches * 9;
      }

      acceptedDecodes.sort((a, b) => b.rankScore - a.rankScore);
      const winner = acceptedDecodes[0] ?? null;

      // 构造最终声学场景标签（严格结合 CED-tiny、DSP 诊断、多说话人检测与语音活动）
      const soundTypeSet = new Set<SoundTypeLabel>();
      const rawHasBgmEvent = allDecodes.some((d) => d.asrEvent.toUpperCase().includes("BGM"));
      const anyActiveSpeechVad = dpdfActiveSec >= 0.22 || ownerActiveSec >= 0.22 || familyActiveSec >= 0.22;

      if (
        scene.speechProb >= 0.14 ||
        winner !== null ||
        (anyActiveSpeechVad && (scene.singingProb < 0.12 || scene.speechProb >= 0.08))
      ) {
        soundTypeSet.add("speech");
      }
      if (scene.singingProb >= 0.055) {
        soundTypeSet.add("song");
      }
      if (
        scene.musicProb >= 0.14 ||
        scene.singingProb >= 0.08 ||
        (rawHasBgmEvent && scene.musicProb >= 0.07)
      ) {
        soundTypeSet.add("bgm");
      }
      if (
        (scene.noiseProb >= 0.08 && scene.musicProb < 0.35) ||
        (scene.musicProb < 0.14 &&
          scene.singingProb < 0.055 &&
          dpdfRes.inputSnrDb < 14 &&
          dpdfRes.snrGainDb >= 4.5 &&
          diag.rms >= 0.015)
      ) {
        soundTypeSet.add("noise");
      }
      if (multiSpeaker) {
        soundTypeSet.add("multi_speaker");
        soundTypeSet.add("speech");
      }

      const detectedSoundTypes = [...soundTypeSet];
      const finalSpeakerCount = !soundTypeSet.has("speech")
        ? 0
        : multiSpeaker
          ? Math.max(2, detectedSpeakerCount)
          : 1;

      // ==================== Stage 6: 组装分离声源流摘要 (separatedStreams) ====================
      const totalRawRms = Math.max(1e-6, diag.rms);
      const separatedStreams: SeparatedStreamSummary[] = [];

      const ownerBranchRes = evaluatedBranches.find((b) => b.branchId === "voxlock_owner");
      if (ownerBranchRes && ownerBranchRes.activeSec >= 0.2 && ownerBranchRes.activeRms >= 0.008) {
        separatedStreams.push({
          streamId: "voxlock_owner",
          kind: "speaker",
          speakerId: "owner",
          startSec: ownerBranchRes.vadSegments[0]?.startSec,
          endSec: ownerBranchRes.vadSegments[ownerBranchRes.vadSegments.length - 1]?.endSec,
          energyRatio: Number(Math.min(1, ownerBranchRes.activeRms / totalRawRms).toFixed(3)),
          transcript: ownerBranchRes.mergedText || undefined,
        });
      }

      const familyBranchRes = evaluatedBranches.find((b) => b.branchId === "voxlock_family");
      if (
        familyBranchRes &&
        familyBranchRes.activeSec >= 0.2 &&
        familyBranchRes.activeRms >= 0.008 &&
        (ownerAndFamilyDistinct || ownerActiveSec < 0.25)
      ) {
        separatedStreams.push({
          streamId: "voxlock_family",
          kind: "speaker",
          speakerId: "family",
          startSec: familyBranchRes.vadSegments[0]?.startSec,
          endSec: familyBranchRes.vadSegments[familyBranchRes.vadSegments.length - 1]?.endSec,
          energyRatio: Number(Math.min(1, familyBranchRes.activeRms / totalRawRms).toFixed(3)),
          transcript: familyBranchRes.mergedText || undefined,
        });
      }

      const dpdfBranchRes = evaluatedBranches.find((b) => b.branchId === "dpdfnet_general");
      if (dpdfBranchRes && dpdfBranchRes.activeSec >= 0.2 && dpdfBranchRes.activeRms >= 0.008) {
        separatedStreams.push({
          streamId: "dpdfnet_general",
          kind: "speech",
          speakerId: multiSpeaker ? "mixed_speakers" : "general",
          startSec: dpdfBranchRes.vadSegments[0]?.startSec,
          endSec: dpdfBranchRes.vadSegments[dpdfBranchRes.vadSegments.length - 1]?.endSec,
          energyRatio: Number(Math.min(1, dpdfBranchRes.activeRms / totalRawRms).toFixed(3)),
          transcript: dpdfBranchRes.mergedText || undefined,
        });
      }

      if (soundTypeSet.has("song")) {
        separatedStreams.push({
          streamId: "scene_song_vocals",
          kind: "song_vocals",
          energyRatio: Number(scene.singingProb.toFixed(3)),
        });
      }
      if (soundTypeSet.has("bgm")) {
        separatedStreams.push({
          streamId: "scene_bgm_accompaniment",
          kind: "bgm_accompaniment",
          energyRatio: Number(scene.musicProb.toFixed(3)),
        });
      }
      if (soundTypeSet.has("noise")) {
        separatedStreams.push({
          streamId: "scene_ambient_noise",
          kind: "noise",
          energyRatio: Number(
            Math.max(scene.noiseProb, Math.min(1, Math.max(0, (18 - inputSnrDb) / 25))).toFixed(3),
          ),
        });
      }

      // 构造最终输出
      if (winner) {
        return {
          isNeoCommand: true,
          wokeOnly: winner.decision.wokeOnly,
          command: winner.decision.command,
          rawTranscript: winner.candidateText || winner.origText,
          detectedSoundTypes,
          detectedSpeakerCount: finalSpeakerCount,
          separatedStreams,
          attentionStage: `${winner.branchId}:${winner.decision.stage}`,
          attentionReason: `[${winner.branchId}/${winner.wakeProvenance}] ${winner.decision.reason}`,
          latencyMs: Math.max(1, Math.round(performance.now() - t0)),
          stageTimingsMs,
        };
      }

      // 无分支放行：选择信息最完整的拒绝记录返回
      const bestRejected =
        dpdfBranchRes?.decodes.find((d) => d.origText.length > 0) ??
        ownerBranchRes?.decodes.find((d) => d.origText.length > 0) ??
        familyBranchRes?.decodes.find((d) => d.origText.length > 0) ??
        allDecodes.find((d) => d.origText.length > 0) ??
        null;

      return {
        isNeoCommand: false,
        wokeOnly: false,
        command: "",
        rawTranscript: bestRejected?.origText ?? dpdfFullText ?? "",
        detectedSoundTypes,
        detectedSpeakerCount: finalSpeakerCount,
        separatedStreams,
        attentionStage: bestRejected
          ? `${bestRejected.branchId}:${bestRejected.decision.stage}`
          : "vad-skip",
        attentionReason: bestRejected
          ? `[${bestRejected.branchId}] ${bestRejected.decision.reason}`
          : "所有分支均未检测到面向 Neo 的有效语音指令",
        latencyMs: Math.max(1, Math.round(performance.now() - t0)),
        stageTimingsMs,
      };
    },
  };
}
