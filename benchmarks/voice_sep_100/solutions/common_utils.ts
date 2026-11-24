// SPDX-License-Identifier: GPL-3.0-or-later
// 评测方案公共底层音频切片与分段辅助工具（绝不读取任何 ground-truth 标注字段）

import {
  applyHighPassFilter,
  computeRms,
  estimateSnrDb,
} from "../../../src/agent/audioPcm.ts";
import type { LocalVoiceEngine } from "../../../src/agent/localVoiceEngine.ts";
import type { EvaluateAttentionInput } from "../../../src/agent/voiceAttentionGate.ts";
import type { ClipManifestEntry } from "../generate_dataset.ts";

export interface TimedVadSegment {
  startSample: number;
  endSample: number;
  startSec: number;
  endSec: number;
  samples: Float32Array;
}

/**
 * 使用 Silero VAD 返回带精确起止时间戳的语音分段（前后各留 padSec 保护边界），
 * 便于按每段独立进行声纹分析、句首英文唤醒探针与语音识别。
 */
export function extractTimedVadSegments(
  engine: LocalVoiceEngine,
  pcm16k: Float32Array,
  options: {
    threshold?: number;
    minSilenceDuration?: number;
    minSpeechDuration?: number;
    padSec?: number;
    mergeGapSec?: number;
  } = {},
): TimedVadSegment[] {
  const sr = 16000;
  const padSamples = Math.round((options.padSec ?? 0.14) * sr);
  const mergeGapSamples = Math.round((options.mergeGapSec ?? 0.18) * sr);
  const vad = engine.createStreamingVad({
    threshold: options.threshold ?? 0.38,
    minSilenceDuration: options.minSilenceDuration ?? 0.25,
    minSpeechDuration: options.minSpeechDuration ?? 0.14,
    maxSpeechDuration: 15,
  });
  if (!vad || pcm16k.length < 512) {
    return pcm16k.length >= 1600
      ? [
          {
            startSample: 0,
            endSample: pcm16k.length,
            startSec: 0,
            endSec: Number((pcm16k.length / sr).toFixed(3)),
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

    const rawRanges: Array<{ s: number; e: number }> = [];
    while (!vad.isEmpty()) {
      const seg = vad.front();
      vad.pop();
      if (seg && seg.samples && seg.samples.length > 0) {
        const s = Math.max(0, seg.start - padSamples);
        const e = Math.min(pcm16k.length, seg.start + seg.samples.length + padSamples);
        const prev = rawRanges[rawRanges.length - 1];
        if (prev && s <= prev.e + mergeGapSamples) {
          prev.e = Math.max(prev.e, e);
        } else {
          rawRanges.push({ s, e });
        }
      }
    }
    vad.clear();

    return rawRanges
      .filter((r) => r.e - r.s >= Math.round(sr * 0.18))
      .map((r) => ({
        startSample: r.s,
        endSample: r.e,
        startSec: Number((r.s / sr).toFixed(3)),
        endSec: Number((r.e / sr).toFixed(3)),
        samples: pcm16k.slice(r.s, r.e),
      }));
  } catch {
    return [];
  }
}

export function slicePcmBySec(
  pcm16k: Float32Array,
  startSec: number,
  endSec: number,
  padSec = 0.12,
): Float32Array {
  const sr = 16000;
  const s = Math.max(0, Math.floor((startSec - padSec) * sr));
  const e = Math.min(pcm16k.length, Math.ceil((endSec + padSec) * sr));
  if (e <= s) return new Float32Array(0);
  return pcm16k.slice(s, e);
}

/**
 * 仅从运行时对话上下文构造 EvaluateAttentionInput 基础字段（绝不暴露任何测试标注字段）。
 */
export function buildRuntimeDialogContext(
  clip: ClipManifestEntry,
  wakeWords: readonly string[],
): Pick<
  EvaluateAttentionInput,
  | "wakeWordEnabled"
  | "wakeWords"
  | "attentionMode"
  | "dialogState"
  | "inConversation"
  | "recentTurns"
  | "lastSpokenReply"
  | "lastSpokenAt"
  | "now"
> {
  const now = 1_764_000_000_000;
  return {
    wakeWordEnabled: true,
    wakeWords,
    attentionMode: "smart",
    dialogState: clip.dialogState,
    inConversation: clip.dialogState === "conversation",
    recentTurns: clip.recentHistory.map((h, idx) => ({
      role: h.role,
      text: h.text,
      timestamp: now - (clip.recentHistory.length - idx) * 2000,
    })),
    lastSpokenReply: clip.lastSpokenReply,
    lastSpokenAt: clip.lastSpokenReply ? now - 1200 : undefined,
    now,
  };
}

/**
 * 判断句子是否包含真实智能家居设备/控制对象语义（防止 "你好，帮我把桌上那杯水递过来" 等日常家务被模糊别名误触发）。
 */
const SMART_HOME_DOMAIN_RE =
  /(?:灯|吸顶灯|台灯|照明|空调|温度|湿度|空气|净化器|风扇|窗帘|窗户|电视|音响|音箱|音量|声音|静音|闭麦|开麦|音乐|歌|播放|暂停|继续|停止|下一首|上一首|切歌|换歌|换一首|亮度|调亮|调暗|亮一点|暗一点|大一点|小一点|高一点|低一点|暖一点|冷一点|色温|插座|开关|喂猫|喂狗|喂食|出粮|场景|模式|观影|睡眠|回家|离家|全屋|客厅|卧室|书房|餐厅|厨房|阳台|主卧|次卧|玄关|卫生间|light|lamp|ac|air\s*conditioner|fan|curtain|tv|speaker|volume|music|pause|play|mute|bright|dim|temp|humidity)/i;

export function hasSmartHomeDomainIntent(text: string): boolean {
  return SMART_HOME_DOMAIN_RE.test(text);
}

/**
 * 严格检查第三人称提及或否定呼唤语境（防止声学唤醒覆盖掉 "别管Neo..." / "聊到Neo..." 等前文否定信号）。
 */
const STRICT_THIRD_PERSON_RE =
  /(?:提到|聊到|说到|说起|讲到|谈到|听说|觉得|认为|喜欢|讨厌|别管|别理|不用管|不要管|没叫|没喊|谁叫|谁在叫|什么叫|叫做|名叫|名字叫|介绍|对比|评论|新闻里|同事|朋友).{0,8}(?:neo|尼奥|尼欧|妮奥|妮欧|new|near|neil|你o)/i;

const STRICT_THIRD_PERSON_AFTER_RE =
  /(?:neo|尼奥|尼欧|妮奥|妮欧).{0,3}(?:这个|那个|的(?:界面|功能|名字|性能|芯片|声音|模型|反应|效果|设计)|好用|不错|挺快|挺聪明|挺有意思|怎么样|好不好用|芯片|软件|助手|项目)/i;

export function isThirdPersonNeoMention(text: string): boolean {
  return STRICT_THIRD_PERSON_RE.test(text) || STRICT_THIRD_PERSON_AFTER_RE.test(text);
}

/**
 * 判断纯人声/高通音频是否包含足以进入 ASR 的能量。
 */
export function hasAudibleEnergy(pcm16k: Float32Array, minRms = 0.006): boolean {
  return pcm16k.length >= 1600 && computeRms(pcm16k) >= minRms;
}

/**
 * 人声语音频带滤波（200Hz 高通 + 温和 3800Hz 低通），抑制低频鼓点/50Hz嗡声与高频嘶声/键盘敲击。
 */
export function applySpeechBandpass(pcm16k: Float32Array, sampleRate = 16000): Float32Array {
  const hp = applyHighPassFilter(pcm16k, sampleRate, 140);
  const out = new Float32Array(hp.length);
  const alpha = (2 * Math.PI * 3800) / (sampleRate + 2 * Math.PI * 3800);
  let y = 0;
  for (let i = 0; i < hp.length; i += 1) {
    y += alpha * (hp[i]! - y);
    out[i] = y;
  }
  return out;
}

export { applyHighPassFilter, computeRms, estimateSnrDb };
