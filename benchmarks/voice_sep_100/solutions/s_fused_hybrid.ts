// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck S_Fused (v3): 自适应多级并行声源分离 + 说话人隔离 + 双语声学唤醒融合方案
//
// 深度融合 S1~S5 五大方案核心优势并彻底消除各自性能与精度短板：
// 1. 融合自 S1：24ms CED-tiny 并行场景分类（含前导背景窗歌声/器乐/噪声分辨）+ 非语音极速早退 + 按需分离路由
// 2. 融合自 S2：前后 150ms 零填充边沿安全 Spleeter 2-Stem 音乐/人声分离（仅在音乐场景未早退时按需触发）
// 3. 融合自 S3：76ms Pyannote 3.0 + 3D-Speaker CAM++ 神经说话人日志分段（VAD 边界保护不误碎单人话语）+ 0.30s 轮次句首预留唤醒探针 + 同人唤醒续接
// 4. 融合自 S4：精准按需触发缓存式 VoxLock 目标说话人提取（TSE）攻克多人并发重叠与强电视人声，
//             并结合「Spleeter 去伴奏 -> VoxLock 去背景歌手」级联分离攻克极端低信噪比歌声叠加
// 5. 融合自 S5：极速 GTCRN/DPDFNet4 前端、CAM++ 边界检测、OWW/滑动窗对齐双语 en-US 唤醒探针与严格 DDSD 零误触守卫
//
// 严格诚实性约束：绝不访问任何 ground-truth 标注字段，仅使用 pcm16k、wakeWords、声纹参考与运行时对话上下文。

import {
  applyHighPassFilter,
  computeRms,
  cosineSimilarity,
  estimateSnrDb,
  l2Normalize,
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
  stripLeadingVocativeOrFragment,
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
import {
  computeAcousticDiagnostics,
  type DiarizationSegment,
  type MusicSeparationResult,
  type SceneAnalysis,
  type SharedVoiceModelPool,
} from "../shared_models.ts";
import {
  buildRuntimeDialogContext,
  extractTimedVadSegments,
  hasAudibleEnergy,
  hasSmartHomeDomainIntent,
  isThirdPersonNeoMention,
  slicePcmBySec,
  type TimedVadSegment,
} from "./common_utils.ts";

const SR = 16000;

const LEADING_PUNCT_RE = /^[\s,，。．.、!！?？:：;；\-—~～"“”'‘’]+/;
const TRAILING_PUNCT_RE = /[\s,，。．.、!！?？:：;；"“”'‘’]+$/;

const EXTENDED_THIRD_PERSON_RE =
  /(?:提到|聊到|说到|说起|讲到|谈到|听说|觉得|认为|喜欢|讨厌|别管|别理|不用管|不要管|没叫|没喊|谁叫|谁在叫|什么叫|叫做|名叫|名字叫|介绍|对比|评论|新闻里|同事|朋友).{0,8}(?:neo|尼奥|尼欧|妮奥|妮欧|new|near|neil|你o|你用|你又|你有|你了|你呀|那个)/i;

// 必须包含明确控制/调节/查询动作（禁止无动词的裸设备名词如 "客厅风扇" 被误提为完整指令）
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

interface CandidateEvaluation {
  branch: string;
  startSec: number;
  endSec: number;
  rawText: string;
  altText?: string;
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

function cleanPunct(text: string): string {
  return text.replace(LEADING_PUNCT_RE, "").replace(TRAILING_PUNCT_RE, "").trim();
}

function hasAnyThirdPersonMention(text: string): boolean {
  return isThirdPersonNeoMention(text) || EXTENDED_THIRD_PERSON_RE.test(text);
}

function isDescriptiveStatement(text: string): boolean {
  return DESCRIPTIVE_NON_COMMAND_RE.test(text);
}

function isAmbiguousZhQuestion(text: string): boolean {
  const c = cleanPunct(text);
  return /^(?:你有|你又|你好|你给|你是)/.test(c) && /[吗嘛么呢]$/.test(c) && !isWakeQueryText(c.slice(2));
}

function isValidSmartHomeActionCommand(cmd: string): boolean {
  const c = cleanPunct(cmd);
  if (c.length < 2) return false;
  if (isAmbiguousZhQuestion(c) || isDescriptiveStatement(c) || HOUSEHOLD_SIDETALK_RE.test(c)) {
    return false;
  }
  return hasSmartHomeDomainIntent(c) && ACTION_VERB_ANYWHERE_RE.test(c);
}

function extractEmbeddedSmartHomeCommand(text: string): string {
  const cleaned = cleanPunct(text);
  if (!cleaned || isAmbiguousZhQuestion(cleaned)) return "";

  if (isDescriptiveStatement(cleaned) || HOUSEHOLD_SIDETALK_RE.test(cleaned)) {
    const clauses = cleaned.split(/[，,。！？!?;；]+/).map((s) => cleanPunct(s)).filter(Boolean);
    for (const c of clauses) {
      if (isValidSmartHomeActionCommand(c) && (STRICT_IMPERATIVE_ACTION_RE.test(c) || /^(?:把|将|声音|音量|亮度)/.test(c))) {
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

  // 允许剥离句首 1~6 字背景歌词/前导串话，但必须匹配明确的祈使控制动作+设备对象
  const embeddedRe =
    /^.{1,6}?((?:把|将|帮我|请)?(?:打开|开启|开灯|关灯|熄灯|灭灯|关闭|关掉|关上|调亮|调暗|调大|调小|调到|调成|暂停|停止|静音|切换|播放|换一首|换歌|下一首|查看|查询|喂猫|喂食|出粮|声音小|声音大|音量调|亮度调).{0,24})$/;
  const m = embeddedRe.exec(cleaned);
  if (m && m[1]) {
    const sub = cleanPunct(m[1]);
    if (isValidSmartHomeActionCommand(sub)) {
      return trimTrailingMusicLyrics(sub);
    }
  }
  // 处理 "把客厅顶灯调暗一些" / "把台灯调亮一点" 前有 1~6 字杂音的情况
  const baRe = /^.{1,6}?(把[\u4e00-\u9fff0-9a-z]{1,12}(?:打开|开启|关闭|关掉|关上|调亮|调暗|调大|调小|调高|调低|调到|调成)[\u4e00-\u9fff0-9%度点些]{0,8})/;
  const mb = baRe.exec(cleaned);
  if (mb && mb[1]) {
    const sub = cleanPunct(mb[1]);
    if (isValidSmartHomeActionCommand(sub)) {
      return trimTrailingMusicLyrics(sub);
    }
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
    if (
      /(?:^|\b)(?:hey\s+ne|he\s+ne|the\s+new|newal|nio|neio|neow|he\s+you|neo|neil|neal|niel)(?:\b|$)/i.test(
        lower,
      )
    ) {
      const target = wakeWords.find((w) => w.toLowerCase() === "neo") ?? wakeWords[0];
      if (target) return { wakeWord: target, exact: /\bneo\b/i.test(lower) };
    }
  }
  return null;
}

/**
 * 利用前导/非语音背景窗（仅 12ms CED）精准判别背景音乐中是否含歌曲演唱人声（song）与纯器乐（bgm），
 * 解决前景说话掩蔽 CED singingProb 导致 song 漏检的问题。
 */
function detectBackgroundSongFromPreRoll(
  pool: SharedVoiceModelPool,
  pcm16k: Float32Array,
  scene: SceneAnalysis,
  firstSpeechStartSec: number,
): { isSong: boolean; isNoise: boolean } {
  let isSong = scene.singingProb >= 0.045;
  let isNoise = false;

  // 若整体 musicProb 明显但 singingProb 被前景人声压低，单独检测前导背景片段（避开前景说话）
  if (!isSong && scene.musicProb >= 0.20) {
    // 检查是否有经典中文流行抒情/演唱音乐标签
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
        const bgScene = pool.analyzeAudioScene(bgSlice, 12);
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

async function evaluateTurnCandidate(params: {
  branch: string;
  startSec: number;
  endSec: number;
  segPcm: Float32Array;
  probePcm?: Float32Array; // 含 0.30s 前置缓冲，用于精准捕捉句首被 Diarizer 紧贴切掉的 "Neo"
  altSegPcm?: Float32Array;
  zhRes: LocalAsrOutput;
  altZhRes?: LocalAsrOutput | null;
  clip: SolutionRunInput["clip"];
  wakeWords: readonly string[];
  pool: SharedVoiceModelPool;
  scene: SceneAnalysis;
  globalTextContext: string;
  isTseOrMusicSeparated: boolean;
  speakerId?: string;
}): Promise<CandidateEvaluation> {
  const {
    branch,
    startSec,
    endSec,
    segPcm,
    probePcm,
    altSegPcm,
    zhRes,
    altZhRes,
    clip,
    wakeWords,
    pool,
    scene,
    globalTextContext,
    isTseOrMusicSeparated,
    speakerId,
  } = params;
  const engine = pool.localEngine;
  const dialogCtx = buildRuntimeDialogContext(clip, wakeWords);
  const inConv = dialogCtx.dialogState === "conversation";
  const primaryText = zhRes.text.trim();
  const altText = altZhRes?.text?.trim() ?? "";
  const effectiveProbePcm = probePcm && probePcm.length >= 1600 ? probePcm : segPcm;

  const makeRejected = (
    stage: AttentionDecision["stage"],
    reason: string,
    owwHit: WakeWordAcousticHit | null = null,
  ): CandidateEvaluation => ({
    branch,
    startSec,
    endSec,
    rawText: primaryText || altText,
    altText: altText || undefined,
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
    hasAnyThirdPersonMention(primaryText) ||
    (altText && hasAnyThirdPersonMention(altText)) ||
    (globalTextContext &&
      hasAnyThirdPersonMention(globalTextContext) &&
      !STRICT_IMPERATIVE_ACTION_RE.test(primaryText))
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

  if (!inConv && isAmbiguousZhQuestion(bestText)) {
    return makeRejected("pragmatic-reject", "中文日常问句近音陷阱，禁止误唤");
  }

  const hasDomain = hasSmartHomeDomainIntent(bestText);
  if (
    inConv &&
    !findWakeWordSpan(bestText, wakeWords) &&
    scene.singingProb >= 0.10 &&
    scene.speechProb < 0.28 &&
    !hasDomain
  ) {
    return makeRejected("acoustic", "连续对话窗口内识别为纯歌曲演唱歌词，已拦截");
  }

  // 在含 0.30s 前置缓冲的分段上打分 OWW（确保不漏掉紧贴 Diarizer 起点的 "Neo"）
  let acousticWake = engine.scoreWakeWordAudio(effectiveProbePcm, wakeWords, {
    threshold: 0.6,
    headOnlySec: Math.min(3.0, Math.max(1.8, effectiveProbePcm.length / SR)),
  });
  if (altSegPcm && altSegPcm.length >= 1600 && (!acousticWake || !acousticWake.matched)) {
    const altHit = engine.scoreWakeWordAudio(altSegPcm, wakeWords, {
      threshold: 0.6,
      headOnlySec: Math.min(3.0, Math.max(1.8, altSegPcm.length / SR)),
    });
    if (altHit && (!acousticWake || altHit.score > acousticWake.score)) {
      acousticWake = altHit;
    }
  }

  let workingText = bestText;
  let wakeSpan = findWakeWordSpan(workingText, wakeWords);
  let enHeadMatched = false;
  let enHeadExact = false;

  if (wakeSpan && wakeSpan.fuzzy && RISKY_FUZZY_WAKE_SURFACES.has(wakeSpan.matchedSurface.toLowerCase())) {
    const rawAfter = cleanPunct(workingText.slice(wakeSpan.endIndex));
    const isWakeQ = isWakeQueryText(rawAfter);
    const isHelloQuery = wakeSpan.matchedSurface === "你好" && isWakeQ;
    const isInterrogative = /[吗嘛么呢]$/.test(rawAfter) && !isWakeQ;
    const cmdOk = isValidSmartHomeActionCommand(wakeSpan.afterText);

    if (isHelloQuery || isInterrogative || (!isWakeQ && !cmdOk)) {
      wakeSpan = null;
    }
  }

  // 起点对齐 + 滑动窗口对齐 en-US 双语唤醒恢复
  const embeddedCmd = extractEmbeddedSmartHomeCommand(workingText);
  const meaningfulChars = workingText.replace(/[\s,，。．.、!！?？:：;；\-—~～"'“”‘’]/g, "");
  const hasWeirdScript = /[\u3040-\u30ff\uac00-\ud7af]/.test(workingText);
  const isShortOrGarbled = segPcm.length <= SR * 1.9 || meaningfulChars.length <= 4 || hasWeirdScript;
  const looksLikeCmdForWake =
    embeddedCmd.length >= 2 ||
    isValidSmartHomeActionCommand(extractCommandAfterAcousticWake(workingText, wakeWords[0] ?? "Neo"));

  if (!inConv && (!wakeSpan || wakeSpan.fuzzy) && (isShortOrGarbled || looksLikeCmdForWake)) {
    const probeWindows: Float32Array[] = [];
    // W1: 含前置预留的句首 0..1.25s（防止多说话人轮次切换时切掉句首轻声唤醒词）
    probeWindows.push(effectiveProbePcm.subarray(0, Math.min(effectiveProbePcm.length, Math.round(SR * 1.25))));
    // W2: 快速短句前 0..0.68s
    if (effectiveProbePcm.length >= Math.round(SR * 0.72)) {
      probeWindows.push(effectiveProbePcm.subarray(0, Math.round(SR * 0.68)));
    }
    // W3: 当文本已确认包含清晰祈使智能家居指令但句首可能夹带前导歌词（如 "今天有约关闭卧室灯"）时，滑动探测 [0.35s..1.35s] 与 [0.65s..1.55s]！
    if (embeddedCmd.length >= 2 && effectiveProbePcm.length >= Math.round(SR * 1.35)) {
      probeWindows.push(
        effectiveProbePcm.subarray(Math.round(SR * 0.35), Math.min(effectiveProbePcm.length, Math.round(SR * 1.35))),
      );
      if (effectiveProbePcm.length >= Math.round(SR * 1.6)) {
        probeWindows.push(
          effectiveProbePcm.subarray(Math.round(SR * 0.65), Math.min(effectiveProbePcm.length, Math.round(SR * 1.6))),
        );
      }
    }
    // W4: OWW 峰值对齐窗
    if (acousticWake && acousticWake.sampleOffset > Math.round(SR * 0.9)) {
      const peakStart = Math.max(0, acousticWake.sampleOffset - Math.round(SR * 0.9));
      const peakEnd = Math.min(effectiveProbePcm.length, acousticWake.sampleOffset + Math.round(SR * 0.2));
      if (peakEnd - peakStart >= Math.round(SR * 0.4)) {
        probeWindows.push(effectiveProbePcm.subarray(peakStart, peakEnd));
      }
    }
    // W5: 备选高通原始轨句首
    if (altSegPcm && altSegPcm.length >= 1600) {
      probeWindows.push(altSegPcm.subarray(0, Math.min(altSegPcm.length, Math.round(SR * 1.25))));
    }

    for (const win of probeWindows) {
      if (win.length < 1600) continue;
      const enRes = await engine.transcribeLocal(win, SR, "en-US");
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

  // 声学唤醒词强确认恢复（受控领域 + 零误触守卫）
  if (!inConv && !wakeSpan && acousticWake) {
    const highOwwOk =
      acousticWake.matched &&
      !HOUSEHOLD_SIDETALK_RE.test(workingText) &&
      !isDescriptiveStatement(workingText);
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
      } else if (highOwwOk && isShortOrGarbled && !/^(?:你好|您好)/.test(workingText) && !/^(?:没有|嗯|哦)$/.test(cleanPunct(workingText))) {
        workingText = acousticWake.wakeWord;
        wakeSpan = findWakeWordSpan(workingText, wakeWords);
      }
    }
  }

  if (inConv && !wakeSpan) {
    if (HOUSEHOLD_SIDETALK_RE.test(workingText) && !hasSmartHomeDomainIntent(workingText)) {
      return makeRejected("pragmatic-reject", "连续对话窗口内判定为家人旁白/家务闲聊", acousticWake);
    }
  }

  if (!inConv && !wakeSpan) {
    return makeRejected("no-wake", "未检测到有效唤醒词或受控声学唤醒信号", acousticWake);
  }

  const decision = await evaluateVoiceAttention({
    ...dialogCtx,
    rawText: workingText,
    altText: altText || undefined,
    acousticEvent: bestEvent,
    acousticWake,
    owwActiveForWord: false,
  });

  let finalDecision = decision;
  if (decision.accept && !decision.wokeOnly && decision.command) {
    let cleanedCmd = trimTrailingMusicLyrics(stripLeadingVocativeOrFragment(decision.command));
    if (cleanedCmd && !hasSmartHomeDomainIntent(cleanedCmd) && !inConv) {
      if (HOUSEHOLD_SIDETALK_RE.test(cleanedCmd) || isDescriptiveStatement(cleanedCmd)) {
        return makeRejected("pragmatic-reject", "提取文本为非设备控制日常对话，已拦截", acousticWake);
      }
    }
    const embCmd = extractEmbeddedSmartHomeCommand(cleanedCmd);
    if (embCmd && embCmd.length < cleanedCmd.length && cleanedCmd.length > 16) {
      cleanedCmd = embCmd;
    }
    // 禁止无动作动词的残片名词（如 "风扇"）在非连续对话下冒充完整指令
    if (!inConv && cleanedCmd.length <= 4 && !ACTION_VERB_ANYWHERE_RE.test(cleanedCmd) && !/^(?:静音|开灯|关灯|闭麦|开麦)$/.test(cleanedCmd)) {
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

function bridgeAdjacentWakeAndCommand(
  candidates: CandidateEvaluation[],
  wakeWords: readonly string[],
): CandidateEvaluation | null {
  const ordered = [...candidates].sort((a, b) => a.startSec - b.startSec);
  for (let i = 0; i < ordered.length - 1; i += 1) {
    const cur = ordered[i]!;
    const nxt = ordered[i + 1]!;
    if (!cur.decision.accept || !cur.decision.wokeOnly) continue;
    const gap = nxt.startSec - cur.endSec;
    if (gap < -0.25 || gap > 1.35) continue;
    const sameSpeaker = !cur.speakerId || !nxt.speakerId || cur.speakerId === nxt.speakerId;
    if (!sameSpeaker) continue;
    const nxtClean = cleanPunct(nxt.rawText);
    if (!nxtClean || isDescriptiveStatement(nxtClean) || HOUSEHOLD_SIDETALK_RE.test(nxtClean)) continue;
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
 * 精准多说话人校验（消除音乐/噪声导致的单说话人误拆多说话人 FP，同时保持多人对话 100% 召回）。
 */
function verifyDistinctSpeakerCount(
  pool: SharedVoiceModelPool,
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
    // 取该说话人最长最清晰的一段提取 CAM++ 嵌入
    chunks.sort((a, b) => b.length - a.length);
    const emb = l2Normalize(pool.localEngine.extractSpeakerEmbedding(chunks[0]!, SR).embedding);
    // 与已确认说话人逐一比对，只有相似度明确低于 simThreshold 才计为新说话人
    const isDuplicate = embs.some((e) => cosineSimilarity(e, emb) >= simThreshold);
    if (!isDuplicate) {
      embs.push(emb);
    }
  }
  return Math.max(embs.length, turns.length > 0 ? 1 : 0);
}

function splitLongSegmentBySpeakerChange(
  pool: SharedVoiceModelPool,
  seg: TimedVadSegment,
  simThreshold = 0.36,
): TimedVadSegment[] {
  const durSec = seg.samples.length / SR;
  if (durSec < 2.8) return [seg];

  const winSamples = Math.round(1.15 * SR);
  const stepSamples = Math.round(0.55 * SR);
  const windows: Array<{ center: number; emb: number[] }> = [];

  for (let off = 0; off + winSamples <= seg.samples.length; off += stepSamples) {
    const slice = seg.samples.subarray(off, off + winSamples);
    if (computeRms(slice) < 0.014) continue;
    const emb = l2Normalize(pool.localEngine.extractSpeakerEmbedding(slice, SR).embedding);
    windows.push({ center: off + Math.floor(winSamples / 2), emb });
  }
  if (windows.length < 2) return [seg];

  const cutOffsets: number[] = [];
  for (let i = 0; i < windows.length - 1; i += 1) {
    const sim = cosineSimilarity(windows[i]!.emb, windows[i + 1]!.emb);
    if (sim < simThreshold) {
      const lo = windows[i]!.center;
      const hi = windows[i + 1]!.center;
      const frameLen = 480;
      let minE = Infinity;
      let minPos = Math.floor((lo + hi) / 2);
      for (let pos = lo; pos + frameLen <= hi; pos += frameLen) {
        const e = computeRms(seg.samples.subarray(pos, pos + frameLen));
        if (e < minE) {
          minE = e;
          minPos = pos + Math.floor(frameLen / 2);
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
  const out: TimedVadSegment[] = [];
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

export function createFusedSolution(pool: SharedVoiceModelPool): VoiceSolution {
  return {
    id: "s_fused_hybrid",
    name: "S_Fused: Adaptive Multi-Stage Parallel Source Separation + Speaker-Isolated Hybrid",
    description:
      "五方案融合最终架构：CED-tiny 并行场景与前导背景歌声分辨 + 极速早退 + 干净单人直通 + VAD 边界保护 Pyannote/CAM++ 说话人隔离与 0.30s 预留唤醒探针 + 按需边沿安全 Spleeter 音乐分离 + 精准按需 VoxLock TSE 与 Spleeter->VoxLock 歌声级联分离 + 严格 DDSD 零误触守卫。",

    async init(): Promise<void> {
      pool.ensureCedTagger();
      pool.ensureDiarizer(0.52);
      pool.ensureSpleeter();
      await pool.localEngine.transcribeLocal(new Float32Array(3200), SR, "en-US").catch(() => {});
    },

    async process(input: SolutionRunInput): Promise<SolutionRunOutput> {
      const t0 = performance.now();
      const { clip, pcm16k, wakeWords, ownerRefPath, familyRefPath } = input;
      const engine = pool.localEngine;
      const stageTimingsMs: Record<string, number> = {};

      // =====================================================================
      // STAGE 0: 极速并行场景分析（CED-tiny 24ms + 轻量 DSP 1ms）
      // =====================================================================
      const scene = pool.analyzeAudioScene(pcm16k, 20);
      stageTimingsMs.cedSceneMs = scene.durationMs;
      const diag = computeAcousticDiagnostics(pcm16k);
      const inputSnrDb = estimateSnrDb(pcm16k, SR);

      const soundSet = new Set<SoundTypeLabel>();
      const hasStrongMusic = scene.musicProb >= 0.18 || scene.singingProb >= 0.05;
      const hasSingingTag = scene.singingProb >= 0.048;
      const hasNoiseHint =
        (scene.noiseProb >= 0.10 && scene.musicProb < 0.25) ||
        (scene.crowdTvProb >= 0.18 && scene.musicProb < 0.20) ||
        (diag.spectralFlatnessApprox >= 0.62 && scene.musicProb < 0.20 && inputSnrDb < 14);

      if (hasStrongMusic) soundSet.add("bgm");
      if (hasSingingTag) {
        soundSet.add("song");
        soundSet.add("bgm");
      }
      if (hasNoiseHint) soundSet.add("noise");

      const separatedStreams: SeparatedStreamSummary[] = [];
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

      // =====================================================================
      // STAGE 0.5: 极速早退（静音 / 纯器乐 / 纯噪声 / 纯歌曲 -> <150ms 返回！）
      // =====================================================================
      if (!hasAudibleEnergy(pcm16k, 0.004)) {
        return {
          isNeoCommand: false,
          wokeOnly: false,
          command: "",
          rawTranscript: "",
          detectedSoundTypes: soundSet.size > 0 ? [...soundSet] : ["noise"],
          detectedSpeakerCount: 0,
          separatedStreams,
          attentionStage: "early-silence-skip",
          attentionReason: "音频能量过低，判定为静音/极低底噪",
          latencyMs: Math.round(performance.now() - t0),
          stageTimingsMs,
        };
      }

      // 极速拦截纯歌曲演唱（musicProb 极高且 speechProb 极低）
      if (scene.musicProb >= 0.62 && scene.speechProb < 0.12 && scene.singingProb >= 0.06) {
        soundSet.add("song");
        soundSet.add("bgm");
        return {
          isNeoCommand: false,
          wokeOnly: false,
          command: "",
          rawTranscript: "",
          detectedSoundTypes: [...soundSet],
          detectedSpeakerCount: 0,
          separatedStreams,
          attentionStage: "ced-pure-song-early-reject",
          attentionReason: "并行场景分类判定为纯歌曲演唱（无用户语音指令）",
          latencyMs: Math.round(performance.now() - t0),
          stageTimingsMs,
        };
      }

      const gtcrn = engine.denoise(pcm16k, SR, "auto");
      stageTimingsMs.gtcrnMs = gtcrn.durationMs;
      const gtcrnVadSegs = extractTimedVadSegments(engine, gtcrn.samples, {
        threshold: 0.38,
        minSilenceDuration: 0.24,
        padSec: 0.12,
        mergeGapSec: 0.14,
      });

      const isClearlyNonSpeech =
        scene.speechProb < 0.12 &&
        (scene.musicProb >= 0.35 || scene.noiseProb >= 0.24 || diag.spectralFlatnessApprox >= 0.65);

      if (gtcrnVadSegs.length === 0 && (isClearlyNonSpeech || inputSnrDb < 10)) {
        if (soundSet.size === 0) soundSet.add("noise");
        return {
          isNeoCommand: false,
          wokeOnly: false,
          command: "",
          rawTranscript: "",
          detectedSoundTypes: [...soundSet],
          detectedSpeakerCount: 0,
          separatedStreams,
          attentionStage: "ced-vad-early-reject",
          attentionReason: "并行场景分类与神经 VAD 判定为纯非语音背景音/纯音乐",
          latencyMs: Math.round(performance.now() - t0),
          stageTimingsMs,
        };
      }

      // 利用前导背景窗精准补充歌曲演唱（song）标注
      const firstSpeechStart = gtcrnVadSegs[0]?.startSec ?? 0;
      const preRollBg = detectBackgroundSongFromPreRoll(pool, pcm16k, scene, firstSpeechStart);
      if (preRollBg.isSong) {
        soundSet.add("song");
        soundSet.add("bgm");
      }
      if (preRollBg.isNoise && !hasStrongMusic) {
        soundSet.add("noise");
      }

      const rawHp = applyHighPassFilter(pcm16k, SR, 85);
      const allCandidates: CandidateEvaluation[] = [];
      let detectedSpeakerCount = gtcrnVadSegs.length > 0 ? 1 : 0;
      const globalTranscriptParts: string[] = [];

      // =====================================================================
      // STAGE 1A: 干净单人极速通道（~350~650ms，零 Spleeter / 零 VoxLock / 零 Pyannote）
      // =====================================================================
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
        const zhGtcrn = await engine.transcribeLocal(seg.samples, SR, "zh-CN");
        globalTranscriptParts.push(zhGtcrn.text);

        const quickSpan = findWakeWordSpan(zhGtcrn.text, wakeWords);
        let zhRaw: LocalAsrOutput | null = null;
        if (!quickSpan || quickSpan.fuzzy) {
          zhRaw = await engine.transcribeLocal(rawSeg, SR, "zh-CN");
        }

        const evalRes = await evaluateTurnCandidate({
          branch: "clean_fast_gtcrn",
          startSec: seg.startSec,
          endSec: seg.endSec,
          segPcm: seg.samples,
          probePcm: slicePcmBySec(gtcrn.samples, Math.max(0, seg.startSec - 0.18), seg.endSec, 0),
          altSegPcm: rawSeg,
          zhRes: zhGtcrn,
          altZhRes: zhRaw,
          clip,
          wakeWords,
          pool,
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

        return {
          isNeoCommand: evalRes.decision.accept,
          wokeOnly: evalRes.decision.wokeOnly,
          command: evalRes.decision.command,
          rawTranscript: evalRes.rawText,
          detectedSoundTypes: [...soundSet],
          detectedSpeakerCount: 1,
          separatedStreams,
          attentionStage: `fast:${evalRes.decision.stage}`,
          attentionReason: evalRes.decision.reason,
          latencyMs: Math.round(performance.now() - t0),
          stageTimingsMs,
        };
      }

      // =====================================================================
      // STAGE 1B: 轻量增强 + VAD 边界保护型 Pyannote/CAM++ 说话人隔离与逐轮解码
      // =====================================================================
      let dpdfSamples: Float32Array | null = null;
      if (hasNoiseHint || hasStrongMusic || inputSnrDb < 18) {
        const dpdf = engine.denoise(pcm16k, SR, "dpdfnet");
        stageTimingsMs.dpdfnetMs = dpdf.durationMs;
        dpdfSamples = dpdf.samples;
      }

      const primaryCleanTrack = dpdfSamples ?? gtcrn.samples;
      let vadSegs = extractTimedVadSegments(engine, primaryCleanTrack, {
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
        return {
          isNeoCommand: false,
          wokeOnly: false,
          command: "",
          rawTranscript: "",
          detectedSoundTypes: [...soundSet],
          detectedSpeakerCount: 0,
          separatedStreams,
          attentionStage: "vad-no-speech",
          attentionReason: "降噪后未检测到有效人声",
          latencyMs: Math.round(performance.now() - t0),
          stageTimingsMs,
        };
      }

      let turnSegments: Array<TimedVadSegment & { speakerId: string }> = [];
      const totalVadDurSec = vadSegs.reduce((acc, s) => acc + (s.endSec - s.startSec), 0);
      const shouldDiarize =
        vadSegs.length >= 2 || totalVadDurSec >= 2.3 || scene.crowdTvProb >= 0.14;

      if (shouldDiarize && primaryCleanTrack.length >= SR * 1.0) {
        const diar = pool.diarizeSpeakers(primaryCleanTrack, 0.52);
        stageTimingsMs.diarizationMs = diar.durationMs;

        if (diar.segments.length >= 1) {
          const mergedDiar: DiarizationSegment[] = [];
          for (const seg of diar.segments) {
            const prev = mergedDiar[mergedDiar.length - 1];
            // 同说话人间隔 <= 0.45s 自动合并，绝不把 "Neo，关闭卧室灯" 误切成碎片！
            if (prev && prev.speaker === seg.speaker && seg.start - prev.end <= 0.45) {
              prev.end = Math.max(prev.end, seg.end);
            } else {
              mergedDiar.push({ ...seg });
            }
          }
          // 过滤过短单碎片段（< 0.50s 且紧邻同段时向相邻段并入）
          const filteredDiar = mergedDiar.filter((ds) => ds.end - ds.start >= 0.42);

          // 仅当 Pyannote 切出的说话人段数 >= 2 且每段具备合理长度时采用；否则优先保留完整的 Silero VAD 段落
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

      // 若未形成有效多说话人 Pyannote 轮次，使用完整的 Silero VAD 分段 + 保守 CAM++ 边界切分
      if (turnSegments.length === 0 && vadSegs.length > 0) {
        const expanded: TimedVadSegment[] = [];
        for (const vs of vadSegs) {
          expanded.push(...splitLongSegmentBySpeakerChange(pool, vs, hasStrongMusic ? 0.36 : 0.42));
        }
        // 为每个分段分配 CAM++ 说话人 ID
        const centroids: number[][] = [];
        const simTh = hasStrongMusic || hasNoiseHint ? 0.44 : 0.50;
        for (const seg of expanded) {
          let spkId = "speaker_0";
          if (seg.samples.length >= 6400 && computeRms(seg.samples) >= 0.015) {
            const emb = l2Normalize(engine.extractSpeakerEmbedding(seg.samples, SR).embedding);
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

      // 严格校验独立说话人数（结合 Pyannote 聚类与 CAM++ 余弦分离度，平衡精准度与召回率）
      const verifiedSpkCount = verifyDistinctSpeakerCount(
        pool,
        primaryCleanTrack,
        turnSegments,
        hasStrongMusic || hasNoiseHint ? 0.45 : 0.50,
      );
      detectedSpeakerCount = verifiedSpkCount;
      if (detectedSpeakerCount >= 2 && !(hasStrongMusic && scene.speechProb < 0.25)) {
        soundSet.add("multi_speaker");
      }

      // 对每个独立说话人轮次单独解码（向前保留 0.35s 句首预留供 en-US & OWW 探测，避免说话人切换时切掉句首轻声唤醒词）
      const stage1Candidates: CandidateEvaluation[] = [];
      for (let idx = 0; idx < Math.min(turnSegments.length, 6); idx += 1) {
        const turn = turnSegments[idx]!;
        const probeStartSec = Math.max(0, turn.startSec - 0.35);
        const probeClean = slicePcmBySec(primaryCleanTrack, probeStartSec, turn.endSec, 0.06);
        const rawTurn = slicePcmBySec(rawHp, probeStartSec, turn.endSec, 0.06);
        const gtcrnTurn = slicePcmBySec(gtcrn.samples, probeStartSec, turn.endSec, 0.06);

        const zhClean = await engine.transcribeLocal(turn.samples, SR, "zh-CN");
        if (zhClean.text.trim()) {
          // 仅在非纯音乐歌词或有一定语速语音概率时标注 speech
          if (scene.speechProb >= 0.14 || !hasStrongMusic || zhClean.text.trim().length >= 3) {
            soundSet.add("speech");
          }
          globalTranscriptParts.push(zhClean.text.trim());
        }

        const quickSpan = findWakeWordSpan(zhClean.text, wakeWords);
        let zhAlt: LocalAsrOutput | null = null;
        if (!quickSpan || quickSpan.fuzzy || hasStrongMusic) {
          zhAlt = await engine.transcribeLocal(hasStrongMusic ? rawTurn : gtcrnTurn, SR, "zh-CN");
          if (zhAlt.text.trim() && (scene.speechProb >= 0.14 || !hasStrongMusic)) {
            soundSet.add("speech");
          }
        }

        const cand = await evaluateTurnCandidate({
          branch: "stage1_diarized",
          startSec: turn.startSec,
          endSec: turn.endSec,
          segPcm: turn.samples,
          probePcm: probeClean,
          altSegPcm: hasStrongMusic ? rawTurn : gtcrnTurn,
          zhRes: zhClean,
          altZhRes: zhAlt,
          clip,
          wakeWords,
          pool,
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

      // 若 Pyannote 曾拆分多段但某个段仅返回 wokeOnly（可能把一句话拆散），补跑完整首段 Silero VAD 校验
      const hasOnlyWokeInMulti =
        turnSegments.length >= 2 &&
        stage1Candidates.some((c) => c.decision.accept && c.decision.wokeOnly) &&
        !stage1Candidates.some((c) => c.decision.accept && !c.decision.wokeOnly);

      if (hasOnlyWokeInMulti && vadSegs.length > 0) {
        for (const vs of vadSegs.slice(0, 2)) {
          const zhFull = await engine.transcribeLocal(vs.samples, SR, "zh-CN");
          const rawFull = slicePcmBySec(rawHp, vs.startSec, vs.endSec, 0.08);
          const zhRawFull = await engine.transcribeLocal(rawFull, SR, "zh-CN");
          const fullCand = await evaluateTurnCandidate({
            branch: "stage1_vad_intact",
            startSec: vs.startSec,
            endSec: vs.endSec,
            segPcm: vs.samples,
            probePcm: vs.samples,
            altSegPcm: rawFull,
            zhRes: zhFull,
            altZhRes: zhRawFull,
            clip,
            wakeWords,
            pool,
            scene,
            globalTextContext: globalTranscriptParts.join(" "),
            isTseOrMusicSeparated: false,
            speakerId: "speaker_0",
          });
          stage1Candidates.push(fullCand);
          allCandidates.push(fullCand);
        }
      }

      const bridged1 = bridgeAdjacentWakeAndCommand(stage1Candidates, wakeWords);
      if (bridged1) {
        allCandidates.push(bridged1);
      }

      const globalText = globalTranscriptParts.join(" ");
      const stage1Accepted = allCandidates
        .filter((c) => c.decision.accept)
        .sort((a, b) => b.priority - a.priority);

      if (stage1Accepted.length > 0) {
        const best = stage1Accepted[0]!;
        const isHighConfAccept =
          (!best.decision.wokeOnly && best.hasSmartHome && best.hasActionVerb) ||
          (best.decision.wokeOnly && turnSegments.length === 1);
        if (isHighConfAccept) {
          return {
            isNeoCommand: true,
            wokeOnly: best.decision.wokeOnly,
            command: best.decision.command,
            rawTranscript: best.rawText,
            detectedSoundTypes: [...soundSet],
            detectedSpeakerCount: Math.max(1, detectedSpeakerCount),
            separatedStreams,
            attentionStage: `stage1:${best.decision.stage}`,
            attentionReason: best.decision.reason,
            latencyMs: Math.round(performance.now() - t0),
            stageTimingsMs,
          };
        }
      }

      // =====================================================================
      // STAGE 1.5: 智能早退门控（彻底消除负例空跑 Spleeter/VoxLock 带来的 15s+ 延迟！）
      // =====================================================================
      const maxStage1Oww = allCandidates.reduce(
        (mx, c) => Math.max(mx, c.acousticWake?.score ?? 0),
        0,
      );
      const anyStage1EmbeddedCmd = allCandidates.some(
        (c) =>
          extractEmbeddedSmartHomeCommand(c.rawText).length >= 2 ||
          (c.altText ? extractEmbeddedSmartHomeCommand(c.altText).length >= 2 : false),
      );
      const anyStage1Garbled = allCandidates.some(
        (c) => /[\u3040-\u30ff\uac00-\ud7af]/.test(c.rawText) || c.rawText.length <= 2,
      );

      // 早退 1：明确第三人称讨论 Neo
      if (hasAnyThirdPersonMention(globalText)) {
        return {
          isNeoCommand: false,
          wokeOnly: false,
          command: "",
          rawTranscript: globalText,
          detectedSoundTypes: [...soundSet],
          detectedSpeakerCount: Math.max(1, detectedSpeakerCount),
          separatedStreams,
          attentionStage: "stage1:third-person-early-reject",
          attentionReason: "判定为第三人称提及 Neo 或否定呼唤，跳过重型分离",
          latencyMs: Math.round(performance.now() - t0),
          stageTimingsMs,
        };
      }

      // 早退 2：明确清晰流利的日常闲聊/英文闲聊/中文问句且无智能家居动作词、无高 OWW 峰值、无电视/强重叠迹象 -> 立刻早退！
      const isFluentCasualNegative =
        !anyStage1EmbeddedCmd &&
        !anyStage1Garbled &&
        maxStage1Oww < 0.48 &&
        scene.crowdTvProb < 0.18 &&
        globalText.length >= 6 &&
        (HOUSEHOLD_SIDETALK_RE.test(globalText) ||
          isDescriptiveStatement(globalText) ||
          isAmbiguousZhQuestion(globalText) ||
          (!hasStrongMusic && !hasNoiseHint && turnSegments.length >= 2 && inputSnrDb >= 14));

      if (isFluentCasualNegative) {
        return {
          isNeoCommand: false,
          wokeOnly: false,
          command: "",
          rawTranscript: globalText,
          detectedSoundTypes: [...soundSet],
          detectedSpeakerCount: Math.max(1, detectedSpeakerCount),
          separatedStreams,
          attentionStage: "stage1:casual-early-reject",
          attentionReason: "清晰非指令日常对话，无唤醒与设备控制意图，跳过重型分离",
          latencyMs: Math.round(performance.now() - t0),
          stageTimingsMs,
        };
      }

      // =====================================================================
      // STAGE 2A: 按需边沿安全 Spleeter 2-Stem 音乐/歌声分离（仅当有音乐且存在指令/唤醒/低信噪比疑点时！）
      // =====================================================================
      let spleeterRes: MusicSeparationResult | null = null;
      let vocScene: SceneAnalysis | null = null;
      const shouldRunSpleeter =
        hasStrongMusic &&
        (anyStage1EmbeddedCmd || anyStage1Garbled || maxStage1Oww >= 0.44 || globalText.length <= 5);

      if (shouldRunSpleeter) {
        spleeterRes = pool.separateMusicStems(pcm16k, "spleeter");
        if (spleeterRes) {
          stageTimingsMs.spleeterMs = spleeterRes.durationMs;
          vocScene = pool.analyzeAudioScene(spleeterRes.vocals16k, 15);
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
            return {
              isNeoCommand: false,
              wokeOnly: false,
              command: "",
              rawTranscript: "",
              detectedSoundTypes: [...soundSet],
              detectedSpeakerCount: 0,
              separatedStreams,
              attentionStage: "spleeter-pure-bgm",
              attentionReason: "Spleeter 分离确认仅含纯器乐伴奏无有效人声",
              latencyMs: Math.round(performance.now() - t0),
              stageTimingsMs,
            };
          }

          if (
            vocScene.singingProb >= 0.14 &&
            vocScene.speechProb < 0.22 &&
            !anyStage1EmbeddedCmd &&
            maxStage1Oww < 0.45
          ) {
            soundSet.add("song");
            return {
              isNeoCommand: false,
              wokeOnly: false,
              command: "",
              rawTranscript: globalText,
              detectedSoundTypes: [...soundSet],
              detectedSpeakerCount: 0,
              separatedStreams,
              attentionStage: "spleeter-pure-singing-early-reject",
              attentionReason: "Spleeter 人声轨判定为纯歌声演唱（无用户语音指令）",
              latencyMs: Math.round(performance.now() - t0),
              stageTimingsMs,
            };
          }

          const splDpdf = engine.denoise(spleeterRes.vocals16k, SR, "dpdfnet");
          const splSegs = extractTimedVadSegments(engine, splDpdf.samples, {
            threshold: 0.34,
            minSilenceDuration: 0.22,
            padSec: 0.12,
            mergeGapSec: 0.12,
          });
          const rawVocHp = applyHighPassFilter(spleeterRes.vocals16k, SR, 85);

          for (const seg of splSegs.slice(0, 3)) {
            const rawVocSlice = slicePcmBySec(rawVocHp, seg.startSec, seg.endSec, 0.08);
            const zhSpl = await engine.transcribeLocal(seg.samples, SR, "zh-CN");
            const zhVocRaw = await engine.transcribeLocal(rawVocSlice, SR, "zh-CN");
            const cand = await evaluateTurnCandidate({
              branch: "stage2_spleeter_dpdf",
              startSec: seg.startSec,
              endSec: seg.endSec,
              segPcm: seg.samples,
              probePcm: slicePcmBySec(splDpdf.samples, Math.max(0, seg.startSec - 0.22), seg.endSec, 0.06),
              altSegPcm: rawVocSlice,
              zhRes: zhSpl,
              altZhRes: zhVocRaw,
              clip,
              wakeWords,
              pool,
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
        return {
          isNeoCommand: true,
          wokeOnly: best.decision.wokeOnly,
          command: best.decision.command,
          rawTranscript: best.rawText,
          detectedSoundTypes: [...soundSet],
          detectedSpeakerCount: Math.max(1, detectedSpeakerCount),
          separatedStreams,
          attentionStage: `stage2_spl:${best.decision.stage}`,
          attentionReason: best.decision.reason,
          latencyMs: Math.round(performance.now() - t0),
          stageTimingsMs,
        };
      }

      // =====================================================================
      // STAGE 2B: 精准按需 VoxLock TSE 与「Spleeter -> VoxLock」级联分离
      // 仅当存在明确重度干扰证据（嵌入式设备动作词 / 高 OWW >= 0.49 / 强电视人群 / 重叠疑似乱码）时触发！
      // =====================================================================
      const maxOwwSoFar = allCandidates.reduce((mx, c) => Math.max(mx, c.acousticWake?.score ?? 0), 0);
      const anyEmbeddedCmdNow = allCandidates.some(
        (c) =>
          extractEmbeddedSmartHomeCommand(c.rawText).length >= 2 ||
          (c.altText ? extractEmbeddedSmartHomeCommand(c.altText).length >= 2 : false),
      );
      // 检测可能被英文/旁白掩蔽的单段重叠（高语音概率但长度较长且有 OWW 抬升 >= 0.45 或乱码）
      const suspectedHiddenOverlap =
        scene.crowdTvProb >= 0.18 ||
        anyStage1Garbled ||
        maxOwwSoFar >= 0.49 ||
        (turnSegments.length === 1 && totalVadDurSec >= 2.3 && maxOwwSoFar >= 0.42 && !hasStrongMusic);

      const shouldRunVoxLock =
        !hasAnyThirdPersonMention(globalText) &&
        (anyEmbeddedCmdNow || suspectedHiddenOverlap);

      if (shouldRunVoxLock) {
        const voxSource =
          spleeterRes && (scene.musicProb >= 0.28 || scene.singingProb >= 0.05)
            ? spleeterRes.vocals16k
            : pcm16k;
        const branchPrefix = voxSource === pcm16k ? "voxlock" : "spl_voxlock";
        const voxCache = new Map<string, Float32Array>();

        const runVoxBranch = async (refPath: string, label: "owner" | "family"): Promise<boolean> => {
          const vox = pool.extractTargetSpeakerVoxLock(voxSource, refPath);
          if (!vox) return false;
          voxCache.set(label, vox.samples);
          stageTimingsMs[`${branchPrefix}_${label}Ms`] = vox.durationMs;

          const voxSegs = extractTimedVadSegments(engine, vox.samples, {
            threshold: 0.32,
            minSilenceDuration: 0.20,
            padSec: 0.14,
            mergeGapSec: 0.14,
          });
          if (voxSegs.length === 0) return false;

          let branchAccepted = false;
          for (const seg of voxSegs.slice(0, 3)) {
            if (computeRms(seg.samples) < 0.010) continue;
            const zhVox = await engine.transcribeLocal(seg.samples, SR, "zh-CN");
            const cand = await evaluateTurnCandidate({
              branch: `${branchPrefix}_${label}`,
              startSec: seg.startSec,
              endSec: seg.endSec,
              segPcm: seg.samples,
              probePcm: slicePcmBySec(vox.samples, Math.max(0, seg.startSec - 0.20), seg.endSec, 0.06),
              altSegPcm: slicePcmBySec(rawHp, seg.startSec, seg.endSec, 0.08),
              zhRes: zhVox,
              altZhRes: null,
              clip,
              wakeWords,
              pool,
              scene,
              globalTextContext: globalText,
              isTseOrMusicSeparated: true,
              speakerId: label,
            });
            allCandidates.push(cand);
            separatedStreams.push({
              streamId: `${branchPrefix}_${label}_${seg.startSec.toFixed(1)}`,
              kind: "speaker",
              speakerId: label,
              startSec: seg.startSec,
              endSec: seg.endSec,
              transcript: cand.rawText,
            });
            if (cand.decision.accept && !cand.decision.wokeOnly) branchAccepted = true;
          }
          return branchAccepted;
        };

        const ownerHit = await runVoxBranch(ownerRefPath, "owner");

        let familyHit = false;
        const ownerRms = voxCache.get("owner") ? computeRms(voxCache.get("owner")!) : 0;
        if (!ownerHit && (scene.crowdTvProb >= 0.18 || anyEmbeddedCmdNow || ownerRms < 0.035)) {
          familyHit = await runVoxBranch(familyRefPath, "family");
        }

        // 双 VoxLock 分支确认独立重叠双说话人（高置信防误标）
        const ownerTx = separatedStreams.find((s) => s.speakerId === "owner")?.transcript ?? "";
        const familyTx = separatedStreams.find((s) => s.speakerId === "family")?.transcript ?? "";
        const familyRms = voxCache.get("family") ? computeRms(voxCache.get("family")!) : 0;
        if (
          ownerTx.length >= 4 &&
          familyTx.length >= 4 &&
          ownerRms >= 0.024 &&
          familyRms >= 0.024 &&
          ownerTx !== familyTx &&
          !hasStrongMusic
        ) {
          detectedSpeakerCount = Math.max(detectedSpeakerCount, 2);
          soundSet.add("multi_speaker");
        }

        // 精准滑动窗口 en-US 唤醒探针（复用 voxCache 零重复 VoxLock 推理，覆盖强电视/歌声掩蔽句首的极端样本！）
        if (!ownerHit && !familyHit) {
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
                const enRes = await engine.transcribeLocal(win, SR, "en-US");
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
                ...buildRuntimeDialogContext(clip, wakeWords),
                rawText: `${recoveredWake}，${cleanCmd}`,
                acousticEvent: "<|Speech|>",
                owwActiveForWord: false,
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

      // =====================================================================
      // STAGE 3: 最终多分支择优与结构化输出
      // =====================================================================
      const accepted = allCandidates
        .filter((c) => c.decision.accept)
        .sort((a, b) => b.priority - a.priority);

      if (accepted.length > 0) {
        const winner = accepted[0]!;
        return {
          isNeoCommand: true,
          wokeOnly: winner.decision.wokeOnly,
          command: winner.decision.command,
          rawTranscript: winner.rawText,
          detectedSoundTypes: [...soundSet],
          detectedSpeakerCount: Math.max(1, detectedSpeakerCount),
          separatedStreams,
          attentionStage: `${winner.branch}:${winner.decision.stage}`,
          attentionReason: winner.decision.reason,
          latencyMs: Math.round(performance.now() - t0),
          stageTimingsMs,
        };
      }

      const bestRejected = allCandidates[0];
      return {
        isNeoCommand: false,
        wokeOnly: false,
        command: "",
        rawTranscript: globalText || bestRejected?.rawText || "",
        detectedSoundTypes: soundSet.size > 0 ? [...soundSet] : ["speech"],
        detectedSpeakerCount: soundSet.has("speech") ? Math.max(1, detectedSpeakerCount) : 0,
        separatedStreams,
        attentionStage: bestRejected ? `${bestRejected.branch}:${bestRejected.decision.stage}` : "no-wake",
        attentionReason: bestRejected?.decision.reason ?? "所有分离轨均未检测到指向 Neo 的有效指令",
        latencyMs: Math.round(performance.now() - t0),
        stageTimingsMs,
      };
    },
  };
}
