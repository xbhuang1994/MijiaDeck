// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 100 条多场景声源分离与语音识别带标注测试音频生成器
//
// 生成 100 条真实 16kHz PCM WAV 测试音频（精确 50% 向 Neo 下达指令，50% 非指令），覆盖：
// 1. clean_no_bgm (14条: 7正/7负) — 无背景音乐、快速连读、第三人称提及、近音陷阱
// 2. song_singing (22条: 11正/11负) — 真实中文歌曲演唱人声+伴奏背景（-2dB ~ +7dB SNR）
// 3. instrumental_bgm (16条: 8正/8负) — 真实伴奏轨与器乐 BGM（无歌手演唱）
// 4. ambient_noise (18条: 9正/9负) — 风扇/50Hz嗡声、雨声宽带噪、机械键盘敲击、电视广播人声、吸尘器轰鸣、咖啡馆多人嘈杂
// 5. multi_speaker (18条: 9正/9负) — 2~3 人顺序交替讲话、多人同时重叠并发讲话、多人+BGM混合
// 6. conversation_scenes (12条: 6正/6负) — 连续对话免唤醒追问、家人旁白、TTS自回声、第三人称元讨论
//
// 同时导出 owner_ref.wav（独立中性朗读语料，无测试集泄漏）用于 VoxLock/声纹参考，以及 manifest.json 与 labels.csv。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import {
  applyHighPassFilter,
  computeRms,
  decodeWavPcm,
  encodeWavPcm16,
  resampleLinear,
} from "../../src/agent/audioPcm.ts";

export type ScenarioCategory =
  | "clean_no_bgm"
  | "song_singing"
  | "instrumental_bgm"
  | "ambient_noise"
  | "multi_speaker"
  | "conversation_scenes";

export type SoundTypeLabel = "speech" | "song" | "bgm" | "noise" | "multi_speaker";

export type NoiseKind =
  | "none"
  | "fan_hum"
  | "rain_broadband"
  | "keyboard_clicks"
  | "tv_chatter"
  | "vacuum_roar"
  | "cafe_babble";

export type VoiceId =
  | "Microsoft Kangkang"
  | "Microsoft Huihui"
  | "Microsoft Yaoyao"
  | "Microsoft David"
  | "Microsoft Zira"
  | "Microsoft Mark";

export interface SpeakerSegmentSpec {
  speakerId: string;
  voice: VoiceId;
  role: "owner" | "family" | "bystander" | "tv";
  text: string;
  rate?: number; // WinRT SpeakingRate 0.7..1.4
  offsetSec: number;
  gainDb?: number; // relative to primary speaker (0 dB)
  isNeoSpeaker: boolean;
}

export interface ClipManifestEntry {
  id: string;
  index: number;
  filename: string;
  durationSec: number;
  sampleRate: number;
  isNeoCommand: boolean;
  category: ScenarioCategory;
  soundTypes: SoundTypeLabel[];
  hasBgm: boolean;
  hasSong: boolean;
  noiseType: NoiseKind;
  speakerCount: number;
  overlappingSpeakers: boolean;
  snrDb: number | null;
  dialogState: "standby" | "conversation";
  recentHistory: Array<{ role: "user" | "assistant"; text: string }>;
  lastSpokenReply?: string;
  targetTranscript: string;
  distractorTranscript: string;
  expectedCommand: string;
  expectedCommandKeywords: string[][];
  expectedWokeOnly: boolean;
  speakers: Array<{
    speakerId: string;
    voice: VoiceId;
    role: string;
    startSec: number;
    endSec: number;
    text: string;
    isNeoSpeaker: boolean;
  }>;
  notes: string;
}

interface ClipRecipe {
  id: string;
  category: ScenarioCategory;
  isNeoCommand: boolean;
  soundTypes: SoundTypeLabel[];
  hasBgm: boolean;
  hasSong: boolean;
  songSource?: "qi-feng-le" | "piao-yang" | "audio-example";
  songOffsetSec?: number;
  bgmKind?: "real_accompaniment_1" | "real_accompaniment_2" | "piano_lofi" | "electronic_beat" | "acoustic_guitar";
  noiseType: NoiseKind;
  snrDb: number | null;
  minDurationSec?: number;
  dialogState: "standby" | "conversation";
  recentHistory?: Array<{ role: "user" | "assistant"; text: string }>;
  lastSpokenReply?: string;
  speakers: SpeakerSegmentSpec[];
  expectedCommand: string;
  expectedCommandKeywords: string[][];
  expectedWokeOnly?: boolean;
  notes: string;
}

const TARGET_SR = 16000;
const ROOT_DIR = path.resolve(import.meta.dir, "../..");
const OUT_DIR = path.resolve(import.meta.dir);
const AUDIO_DIR = path.join(OUT_DIR, "audio");
const TTS_CACHE_DIR = path.join(OUT_DIR, "_tts_cache");
const RAW_SOURCES_DIR = path.join(ROOT_DIR, "benchmarks", "raw_sources");
const MODELS_DIR = path.join(ROOT_DIR, "voice_models");

// 确定性伪随机数生成器（LCG + Box-Muller）
class SeededRng {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    this.state = (Math.imul(this.state, 1664525) + 1013904223) >>> 0;
    return this.state / 0x100000000;
  }
  uniform(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }
  gaussian(): number {
    const u1 = Math.max(1e-7, this.next());
    const u2 = this.next();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }
}

// =============================================================================
// 100 条严格分层配比测试样本配方（50 正例向 Neo 下达指令 + 50 负例非指令）
// =============================================================================

function buildRecipes(): ClipRecipe[] {
  const recipes: ClipRecipe[] = [];
  let seq = 0;
  const add = (r: Omit<ClipRecipe, "id">) => {
    seq += 1;
    recipes.push({
      id: `clip_${String(seq).padStart(3, "0")}`,
      ...r,
    });
  };

  // ===========================================================================
  // Category 1: clean_no_bgm — 14 clips (7 Neo positive, 7 Non-Neo negative)
  // ===========================================================================
  add({
    category: "clean_no_bgm",
    isNeoCommand: true,
    soundTypes: ["speech"],
    hasBgm: false,
    hasSong: false,
    noiseType: "none",
    snrDb: null,
    dialogState: "standby",
    speakers: [
      { speakerId: "owner_m1", voice: "Microsoft Kangkang", role: "owner", text: "Neo，打开客厅吸顶灯", offsetSec: 0.3, isNeoSpeaker: true },
    ],
    expectedCommand: "打开客厅吸顶灯",
    expectedCommandKeywords: [["打开", "开"], ["客厅", "吸顶灯", "灯"]],
    notes: "干净环境标准句首唤醒+完整控制指令（男声）",
  });
  add({
    category: "clean_no_bgm",
    isNeoCommand: true,
    soundTypes: ["speech"],
    hasBgm: false,
    hasSong: false,
    noiseType: "none",
    snrDb: null,
    dialogState: "standby",
    speakers: [
      { speakerId: "owner_m1", voice: "Microsoft Kangkang", role: "owner", text: "Neo关灯", rate: 1.2, offsetSec: 0.25, isNeoSpeaker: true },
    ],
    expectedCommand: "关灯",
    expectedCommandKeywords: [["关", "熄", "灭"], ["灯"]],
    notes: "快速连读短指令 'Neo关灯' 回归测试",
  });
  add({
    category: "clean_no_bgm",
    isNeoCommand: true,
    soundTypes: ["speech"],
    hasBgm: false,
    hasSong: false,
    noiseType: "none",
    snrDb: null,
    dialogState: "standby",
    speakers: [
      { speakerId: "family_f1", voice: "Microsoft Huihui", role: "family", text: "嘿Neo，把卧室灯关掉", offsetSec: 0.3, isNeoSpeaker: true },
    ],
    expectedCommand: "把卧室灯关掉",
    expectedCommandKeywords: [["关", "关闭", "关掉"], ["卧室", "灯"]],
    notes: "女声呼唤前缀 + 设备关闭指令",
  });
  add({
    category: "clean_no_bgm",
    isNeoCommand: true,
    soundTypes: ["speech"],
    hasBgm: false,
    hasSong: false,
    noiseType: "none",
    snrDb: null,
    dialogState: "standby",
    speakers: [
      { speakerId: "family_f2", voice: "Microsoft Yaoyao", role: "family", text: "Neo，把小米音响音量调到35", offsetSec: 0.3, isNeoSpeaker: true },
    ],
    expectedCommand: "把小米音响音量调到35",
    expectedCommandKeywords: [["音量", "声音", "音响", "音箱"], ["35", "三十五"]],
    notes: "干净环境数字调节指令（女声2）",
  });
  add({
    category: "clean_no_bgm",
    isNeoCommand: true,
    soundTypes: ["speech"],
    hasBgm: false,
    hasSong: false,
    noiseType: "none",
    snrDb: null,
    dialogState: "standby",
    speakers: [
      { speakerId: "owner_m1", voice: "Microsoft Kangkang", role: "owner", text: "Neo在吗", offsetSec: 0.35, isNeoSpeaker: true },
    ],
    expectedCommand: "",
    expectedCommandKeywords: [],
    expectedWokeOnly: true,
    notes: "干净环境纯唤醒询问",
  });
  add({
    category: "clean_no_bgm",
    isNeoCommand: true,
    soundTypes: ["speech"],
    hasBgm: false,
    hasSong: false,
    noiseType: "none",
    snrDb: null,
    dialogState: "standby",
    speakers: [
      { speakerId: "owner_en", voice: "Microsoft David", role: "owner", text: "Hey Neo, turn off the living room light", offsetSec: 0.3, isNeoSpeaker: true },
    ],
    expectedCommand: "turn off the living room light",
    expectedCommandKeywords: [["turn off", "off", "close", "关"], ["light", "living", "灯"]],
    notes: "纯英文唤醒+英文设备控制指令",
  });
  add({
    category: "clean_no_bgm",
    isNeoCommand: true,
    soundTypes: ["speech"],
    hasBgm: false,
    hasSong: false,
    noiseType: "none",
    snrDb: null,
    dialogState: "standby",
    speakers: [
      { speakerId: "owner_m1", voice: "Microsoft Kangkang", role: "owner", text: "Neo，查询客厅温度和湿度", offsetSec: 0.3, isNeoSpeaker: true },
    ],
    expectedCommand: "查询客厅温度和湿度",
    expectedCommandKeywords: [["查", "温度", "湿度"]],
    notes: "干净环境传感器查询指令",
  });

  // 7 clean_no_bgm negatives
  add({
    category: "clean_no_bgm",
    isNeoCommand: false,
    soundTypes: ["speech"],
    hasBgm: false,
    hasSong: false,
    noiseType: "none",
    snrDb: null,
    dialogState: "standby",
    speakers: [
      { speakerId: "owner_m1", voice: "Microsoft Kangkang", role: "owner", text: "今天天气真不错，下午去公园走走吧", offsetSec: 0.3, isNeoSpeaker: false },
    ],
    expectedCommand: "",
    expectedCommandKeywords: [],
    notes: "普通日常闲聊，无唤醒词",
  });
  add({
    category: "clean_no_bgm",
    isNeoCommand: false,
    soundTypes: ["speech"],
    hasBgm: false,
    hasSong: false,
    noiseType: "none",
    snrDb: null,
    dialogState: "standby",
    speakers: [
      { speakerId: "family_f1", voice: "Microsoft Huihui", role: "family", text: "我刚才跟朋友聊到Neo这个助手挺好用的", offsetSec: 0.3, isNeoSpeaker: false },
    ],
    expectedCommand: "",
    expectedCommandKeywords: [],
    notes: "第三人称提及 Neo（非向 Neo 下达指令）",
  });
  add({
    category: "clean_no_bgm",
    isNeoCommand: false,
    soundTypes: ["speech"],
    hasBgm: false,
    hasSong: false,
    noiseType: "none",
    snrDb: null,
    dialogState: "standby",
    speakers: [
      { speakerId: "owner_m1", voice: "Microsoft Kangkang", role: "owner", text: "别管Neo了，我们先吃饭吧", offsetSec: 0.3, isNeoSpeaker: false },
    ],
    expectedCommand: "",
    expectedCommandKeywords: [],
    notes: "否定/忽略 Neo 的旁白指令",
  });
  add({
    category: "clean_no_bgm",
    isNeoCommand: false,
    soundTypes: ["speech"],
    hasBgm: false,
    hasSong: false,
    noiseType: "none",
    snrDb: null,
    dialogState: "standby",
    speakers: [
      { speakerId: "family_f2", voice: "Microsoft Yaoyao", role: "family", text: "你好，今天晚饭想吃什么呀", offsetSec: 0.3, isNeoSpeaker: false },
    ],
    expectedCommand: "",
    expectedCommandKeywords: [],
    notes: "近音陷阱：'你好' 日常问候，绝不能误唤 Neo",
  });
  add({
    category: "clean_no_bgm",
    isNeoCommand: false,
    soundTypes: ["speech"],
    hasBgm: false,
    hasSong: false,
    noiseType: "none",
    snrDb: null,
    dialogState: "standby",
    speakers: [
      { speakerId: "family_f1", voice: "Microsoft Huihui", role: "family", text: "你有打开阳台的窗户吗", offsetSec: 0.3, isNeoSpeaker: false },
    ],
    expectedCommand: "",
    expectedCommandKeywords: [],
    notes: "近音陷阱：'你有打开...吗' 问句，非指令",
  });
  add({
    category: "clean_no_bgm",
    isNeoCommand: false,
    soundTypes: ["speech"],
    hasBgm: false,
    hasSong: false,
    noiseType: "none",
    snrDb: null,
    dialogState: "standby",
    speakers: [
      { speakerId: "owner_en", voice: "Microsoft David", role: "owner", text: "No, stop talking about New York weather", offsetSec: 0.3, isNeoSpeaker: false },
    ],
    expectedCommand: "",
    expectedCommandKeywords: [],
    notes: "英文近音陷阱：No / New York",
  });
  add({
    category: "clean_no_bgm",
    isNeoCommand: false,
    soundTypes: ["speech"],
    hasBgm: false,
    hasSong: false,
    noiseType: "none",
    snrDb: null,
    dialogState: "standby",
    speakers: [
      { speakerId: "owner_m1", voice: "Microsoft Kangkang", role: "owner", text: "打开客厅吸顶灯那个开关好像有点松了", offsetSec: 0.3, isNeoSpeaker: false },
    ],
    expectedCommand: "",
    expectedCommandKeywords: [],
    notes: "待机状态无唤醒词的设备讨论句",
  });

  // ===========================================================================
  // Category 2: song_singing — 22 clips (11 Neo positive, 11 Non-Neo negative)
  // Real Chinese singing songs (起风了, 漂洋过海来看你, audio_example)
  // ===========================================================================
  const songPosSpecs: Array<{
    voice: VoiceId;
    text: string;
    cmd: string;
    kw: string[][];
    song: "qi-feng-le" | "piao-yang" | "audio-example";
    songOff: number;
    snr: number;
    rate?: number;
    wokeOnly?: boolean;
    note: string;
  }> = [
    {
      voice: "Microsoft Kangkang",
      text: "Neo，打开客厅吸顶灯",
      cmd: "打开客厅吸顶灯",
      kw: [["打开", "开"], ["客厅", "吸顶灯", "灯"]],
      song: "qi-feng-le",
      songOff: 2.0,
      snr: 6,
      note: "《起风了》歌声背景 +6dB SNR 下达开灯指令",
    },
    {
      voice: "Microsoft Huihui",
      text: "Neo，关闭卧室灯",
      cmd: "关闭卧室灯",
      kw: [["关", "关闭"], ["卧室", "灯"]],
      song: "qi-feng-le",
      songOff: 7.5,
      snr: 3,
      note: "《起风了》副歌人声 +3dB SNR 下达关灯指令",
    },
    {
      voice: "Microsoft Kangkang",
      text: "Neo，把小米音响音量调到20",
      cmd: "把小米音响音量调到20",
      kw: [["音量", "声音", "音响", "音箱"], ["20", "二十"]],
      song: "qi-feng-le",
      songOff: 12.0,
      snr: 0,
      note: "《起风了》0dB 强歌声干扰下调小音量",
    },
    {
      voice: "Microsoft Yaoyao",
      text: "Neo，暂停播放音乐",
      cmd: "暂停播放音乐",
      kw: [["暂停", "停止", "停"], ["音乐", "播放", "歌"]],
      song: "piao-yang",
      songOff: 3.0,
      snr: 4,
      note: "《漂洋过海来看你》+4dB SNR 暂停音乐",
    },
    {
      voice: "Microsoft Kangkang",
      text: "嘿Neo，打开空调",
      cmd: "打开空调",
      kw: [["打开", "开"], ["空调"]],
      song: "piao-yang",
      songOff: 10.0,
      snr: 1,
      note: "《漂洋过海来看你》+1dB 强歌声干扰下开空调",
    },
    {
      voice: "Microsoft Kangkang",
      text: "Neo关灯",
      cmd: "关灯",
      kw: [["关", "熄", "灭"], ["灯"]],
      song: "qi-feng-le",
      songOff: 16.0,
      snr: 4,
      rate: 1.15,
      note: "歌声背景中快速连读 'Neo关灯'",
    },
    {
      voice: "Microsoft Huihui",
      text: "Neo，把台灯调亮一点",
      cmd: "把台灯调亮一点",
      kw: [["亮", "调亮", "台灯", "灯"]],
      song: "piao-yang",
      songOff: 18.0,
      snr: 3,
      note: "《漂洋过海来看你》女声调亮台灯",
    },
    {
      voice: "Microsoft Kangkang",
      text: "Neo，静音",
      cmd: "静音",
      kw: [["静音", "闭麦", "关声", "无声"]],
      song: "audio-example",
      songOff: 1.0,
      snr: 2,
      note: "强歌曲播放 +2dB SNR 短指令静音",
    },
    {
      voice: "Microsoft Yaoyao",
      text: "Neo，帮我关闭所有灯",
      cmd: "帮我关闭所有灯",
      kw: [["关", "关闭"], ["所有", "全部", "全屋", "灯"]],
      song: "qi-feng-le",
      songOff: 22.0,
      snr: 2,
      note: "《起风了》强歌声 +2dB 关闭所有灯",
    },
    {
      voice: "Microsoft Kangkang",
      text: "Neo，打开窗帘",
      cmd: "打开窗帘",
      kw: [["打开", "开"], ["窗帘", "窗"]],
      song: "piao-yang",
      songOff: 25.0,
      snr: -1,
      note: "极端低信噪比 -1dB 强歌曲演唱背景开窗帘",
    },
    {
      voice: "Microsoft David",
      text: "Hey Neo, pause the music",
      cmd: "pause the music",
      kw: [["pause", "stop", "暂停", "停"], ["music", "音乐", "歌"]],
      song: "audio-example",
      songOff: 3.5,
      snr: 4,
      note: "歌曲背景中英文暂停音乐指令",
    },
  ];
  for (const s of songPosSpecs) {
    add({
      category: "song_singing",
      isNeoCommand: true,
      soundTypes: ["speech", "song", "bgm"],
      hasBgm: true,
      hasSong: true,
      songSource: s.song,
      songOffsetSec: s.songOff,
      noiseType: "none",
      snrDb: s.snr,
      dialogState: "standby",
      speakers: [
        {
          speakerId: s.voice === "Microsoft Kangkang" ? "owner_m1" : "family_s",
          voice: s.voice,
          role: s.voice === "Microsoft Kangkang" ? "owner" : "family",
          text: s.text,
          rate: s.rate,
          offsetSec: 0.75,
          isNeoSpeaker: true,
        },
      ],
      expectedCommand: s.cmd,
      expectedCommandKeywords: s.kw,
      expectedWokeOnly: s.wokeOnly,
      notes: s.note,
    });
  }

  // 11 song_singing negatives: pure singing songs + chatting over singing songs
  const songNegSpecs: Array<{
    song: "qi-feng-le" | "piao-yang" | "audio-example";
    songOff: number;
    dur: number;
    voice?: VoiceId;
    text?: string;
    snr?: number;
    note: string;
  }> = [
    { song: "qi-feng-le", songOff: 0.5, dur: 4.0, note: "纯歌曲《起风了》主歌演唱片段（无人指令）" },
    { song: "qi-feng-le", songOff: 8.0, dur: 4.2, note: "纯歌曲《起风了》高潮副歌演唱片段" },
    { song: "qi-feng-le", songOff: 18.0, dur: 4.0, note: "纯歌曲《起风了》尾段演唱片段" },
    { song: "piao-yang", songOff: 1.5, dur: 4.2, note: "纯歌曲《漂洋过海来看你》人声演唱片段1" },
    { song: "piao-yang", songOff: 12.5, dur: 4.2, note: "纯歌曲《漂洋过海来看你》人声演唱片段2" },
    { song: "piao-yang", songOff: 24.0, dur: 4.0, note: "纯歌曲《漂洋过海来看你》高潮演唱片段3" },
    { song: "audio-example", songOff: 0.5, dur: 4.0, note: "纯流行英文/器乐演唱片段" },
    {
      song: "qi-feng-le",
      songOff: 5.0,
      dur: 4.5,
      voice: "Microsoft Huihui",
      text: "这首歌真的很好听，我上学的时候经常听",
      snr: 3,
      note: "边听《起风了》边与家人聊天（非指令）",
    },
    {
      song: "piao-yang",
      songOff: 7.0,
      dur: 4.5,
      voice: "Microsoft Kangkang",
      text: "我刚才听朋友说Neo这个语音项目挺有意思的",
      snr: 4,
      note: "歌曲背景中第三人称提及 Neo（非指令）",
    },
    {
      song: "qi-feng-le",
      songOff: 14.0,
      dur: 4.2,
      voice: "Microsoft Yaoyao",
      text: "你好，今天晚上咱们出去吃火锅吧",
      snr: 3,
      note: "歌曲背景中'你好'聊天近音陷阱",
    },
    {
      song: "piao-yang",
      songOff: 20.0,
      dur: 4.2,
      voice: "Microsoft Kangkang",
      text: "把客厅灯修好之后亮多了，晚上看书舒服",
      snr: 4,
      note: "歌曲背景中谈论灯光但无唤醒词",
    },
  ];
  for (const s of songNegSpecs) {
    const hasSpk = Boolean(s.voice && s.text);
    add({
      category: "song_singing",
      isNeoCommand: false,
      soundTypes: hasSpk ? ["speech", "song", "bgm"] : ["song", "bgm"],
      hasBgm: true,
      hasSong: true,
      songSource: s.song,
      songOffsetSec: s.songOff,
      noiseType: "none",
      snrDb: hasSpk ? (s.snr ?? 3) : null,
      minDurationSec: s.dur,
      dialogState: "standby",
      speakers: hasSpk
        ? [{ speakerId: "chat_s", voice: s.voice!, role: "family", text: s.text!, offsetSec: 0.6, isNeoSpeaker: false }]
        : [],
      expectedCommand: "",
      expectedCommandKeywords: [],
      notes: s.note,
    });
  }

  // ===========================================================================
  // Category 3: instrumental_bgm — 16 clips (8 Neo positive, 8 Non-Neo negative)
  // Real separated accompaniment + rich procedural BGM (no singing vocals)
  // ===========================================================================
  const bgmPosSpecs: Array<{
    voice: VoiceId;
    text: string;
    cmd: string;
    kw: string[][];
    bgm: NonNullable<ClipRecipe["bgmKind"]>;
    snr: number;
    note: string;
  }> = [
    { voice: "Microsoft Kangkang", text: "Neo，打开书房台灯", cmd: "打开书房台灯", kw: [["打开", "开"], ["书房", "台灯", "灯"]], bgm: "real_accompaniment_1", snr: 5, note: "真实歌曲纯伴奏 BGM +5dB 开台灯" },
    { voice: "Microsoft Huihui", text: "Neo，把空调调到26度", cmd: "把空调调到26度", kw: [["空调"], ["26", "二十六"]], bgm: "real_accompaniment_1", snr: 1, note: "真实伴奏 BGM +1dB 调空调温度" },
    { voice: "Microsoft Yaoyao", text: "Neo，打开净化器", cmd: "打开净化器", kw: [["打开", "开"], ["净化器", "净化"]], bgm: "real_accompaniment_2", snr: 3, note: "真实伴奏2 BGM +3dB 开净化器" },
    { voice: "Microsoft Kangkang", text: "Neo，关闭客厅风扇", cmd: "关闭客厅风扇", kw: [["关", "关闭"], ["风扇", "客厅"]], bgm: "piano_lofi", snr: 2, note: "Lo-Fi 钢琴伴奏 BGM +2dB 关风扇" },
    { voice: "Microsoft Huihui", text: "Neo，喂猫出粮两份", cmd: "喂猫出粮两份", kw: [["喂", "出粮"], ["两", "2"]], bgm: "electronic_beat", snr: 0, note: "强电子鼓点 BGM 0dB 喂猫出粮" },
    { voice: "Microsoft Kangkang", text: "Neo，切换观影模式", cmd: "切换观影模式", kw: [["观影", "模式", "场景", "切换"]], bgm: "acoustic_guitar", snr: 4, note: "木吉他分解和弦 BGM +4dB 切场景" },
    { voice: "Microsoft Yaoyao", text: "Neo，把客厅灯亮度调到50", cmd: "把客厅灯亮度调到50", kw: [["亮度", "灯", "客厅"], ["50", "五十"]], bgm: "real_accompaniment_2", snr: -1, note: "极强伴奏 BGM -1dB 调亮度" },
    { voice: "Microsoft Kangkang", text: "Neo，下一首歌", cmd: "下一首歌", kw: [["下一首", "切歌", "换歌"]], bgm: "electronic_beat", snr: 3, note: "电子节奏 BGM +3dB 切歌" },
  ];
  for (const b of bgmPosSpecs) {
    add({
      category: "instrumental_bgm",
      isNeoCommand: true,
      soundTypes: ["speech", "bgm"],
      hasBgm: true,
      hasSong: false,
      bgmKind: b.bgm,
      noiseType: "none",
      snrDb: b.snr,
      dialogState: "standby",
      speakers: [
        {
          speakerId: b.voice === "Microsoft Kangkang" ? "owner_m1" : "family_s",
          voice: b.voice,
          role: b.voice === "Microsoft Kangkang" ? "owner" : "family",
          text: b.text,
          offsetSec: 0.65,
          isNeoSpeaker: true,
        },
      ],
      expectedCommand: b.cmd,
      expectedCommandKeywords: b.kw,
      notes: b.note,
    });
  }

  const bgmNegSpecs: Array<{
    bgm: NonNullable<ClipRecipe["bgmKind"]>;
    voice?: VoiceId;
    text?: string;
    snr?: number;
    note: string;
  }> = [
    { bgm: "real_accompaniment_1", note: "纯伴奏音乐1（无任何说话）" },
    { bgm: "real_accompaniment_2", note: "纯伴奏音乐2（无任何说话）" },
    { bgm: "piano_lofi", note: "纯 Lo-Fi 钢琴背景音乐" },
    { bgm: "electronic_beat", note: "纯强鼓点电子背景音乐" },
    { bgm: "acoustic_guitar", voice: "Microsoft Huihui", text: "周末准备去海边玩两天，机票订好了吗", snr: 4, note: "纯吉他BGM中普通对话" },
    { bgm: "piano_lofi", voice: "Microsoft Kangkang", text: "我觉得Neo的界面设计还挺简洁的", snr: 3, note: "钢琴BGM中第三人称评价Neo" },
    { bgm: "real_accompaniment_1", voice: "Microsoft Yaoyao", text: "你有看到我放在桌上的耳机吗", snr: 4, note: "伴奏BGM中'你有...'近音聊天" },
    { bgm: "electronic_beat", voice: "Microsoft Mark", text: "This background beat sounds super chill tonight", snr: 3, note: "电子BGM中纯英文闲聊" },
  ];
  for (const b of bgmNegSpecs) {
    const hasSpk = Boolean(b.voice && b.text);
    add({
      category: "instrumental_bgm",
      isNeoCommand: false,
      soundTypes: hasSpk ? ["speech", "bgm"] : ["bgm"],
      hasBgm: true,
      hasSong: false,
      bgmKind: b.bgm,
      noiseType: "none",
      snrDb: hasSpk ? (b.snr ?? 3) : null,
      minDurationSec: 3.8,
      dialogState: "standby",
      speakers: hasSpk
        ? [{ speakerId: "chat_b", voice: b.voice!, role: "family", text: b.text!, offsetSec: 0.55, isNeoSpeaker: false }]
        : [],
      expectedCommand: "",
      expectedCommandKeywords: [],
      notes: b.note,
    });
  }

  // ===========================================================================
  // Category 4: ambient_noise — 18 clips (9 Neo positive, 9 Non-Neo negative)
  // Fan/50Hz hum, rain, keyboard clicks, TV chatter, vacuum roar, cafe babble
  // ===========================================================================
  const noisePosSpecs: Array<{
    voice: VoiceId;
    text: string;
    cmd: string;
    kw: string[][];
    noise: NoiseKind;
    snr: number;
    note: string;
  }> = [
    { voice: "Microsoft Kangkang", text: "Neo，打开客厅吸顶灯", cmd: "打开客厅吸顶灯", kw: [["打开", "开"], ["客厅", "吸顶灯", "灯"]], noise: "fan_hum", snr: 2, note: "风扇+50Hz交流嗡声 +2dB 开灯" },
    { voice: "Microsoft Huihui", text: "Neo，把卧室空调关掉", cmd: "把卧室空调关掉", kw: [["关", "关掉", "关闭"], ["空调", "卧室"]], noise: "fan_hum", snr: -1, note: "强风扇宽带噪 -1dB 关空调" },
    { voice: "Microsoft Yaoyao", text: "Neo，关闭阳台窗户", cmd: "关闭阳台窗户", kw: [["关", "关闭"], ["窗", "阳台"]], noise: "rain_broadband", snr: 1, note: "大雨宽带白粉噪 +1dB 关窗" },
    { voice: "Microsoft Kangkang", text: "Neo，打开书房灯", cmd: "打开书房灯", kw: [["打开", "开"], ["书房", "灯"]], noise: "keyboard_clicks", snr: 4, note: "高频机械键盘敲击脉冲 +4dB 开灯" },
    { voice: "Microsoft Kangkang", text: "Neo，把电视关掉", cmd: "把电视关掉", kw: [["关", "关掉", "关闭"], ["电视"]], noise: "tv_chatter", snr: 3, note: "电视人声广播背景 +3dB 关电视" },
    { voice: "Microsoft Huihui", text: "Neo，把客厅吸顶灯调暗一点", cmd: "把客厅吸顶灯调暗一点", kw: [["暗", "调暗", "灯", "吸顶灯"]], noise: "tv_chatter", snr: 1, note: "强电视对话背景 +1dB 调暗灯" },
    { voice: "Microsoft Kangkang", text: "Neo，打开空气净化器", cmd: "打开空气净化器", kw: [["打开", "开"], ["净化器", "空气"]], noise: "vacuum_roar", snr: 0, note: "吸尘器轰鸣 0dB 开空气净化器" },
    { voice: "Microsoft Yaoyao", text: "Neo，打开餐厅灯", cmd: "打开餐厅灯", kw: [["打开", "开"], ["餐厅", "灯"]], noise: "cafe_babble", snr: 2, note: "多人嘈杂环境底噪 +2dB 开餐厅灯" },
    { voice: "Microsoft Kangkang", text: "Neo，查看当前室内湿度", cmd: "查看当前室内湿度", kw: [["查", "看", "湿度"]], noise: "rain_broadband", snr: 3, note: "雨声环境查湿度" },
  ];
  for (const n of noisePosSpecs) {
    add({
      category: "ambient_noise",
      isNeoCommand: true,
      soundTypes: ["speech", "noise"],
      hasBgm: false,
      hasSong: false,
      noiseType: n.noise,
      snrDb: n.snr,
      dialogState: "standby",
      speakers: [
        {
          speakerId: n.voice === "Microsoft Kangkang" ? "owner_m1" : "family_n",
          voice: n.voice,
          role: n.voice === "Microsoft Kangkang" ? "owner" : "family",
          text: n.text,
          offsetSec: 0.65,
          isNeoSpeaker: true,
        },
      ],
      expectedCommand: n.cmd,
      expectedCommandKeywords: n.kw,
      notes: n.note,
    });
  }

  const noiseNegSpecs: Array<{
    noise: NoiseKind;
    voice?: VoiceId;
    text?: string;
    snr?: number;
    note: string;
  }> = [
    { noise: "fan_hum", note: "纯空调风扇+50Hz交流嗡声（无人声）" },
    { noise: "rain_broadband", note: "纯大雨宽带背景音（无人声）" },
    { noise: "keyboard_clicks", note: "纯机械键盘密集敲击声（无人声）" },
    { noise: "vacuum_roar", note: "纯吸尘器马达轰鸣声（无人声）" },
    { noise: "tv_chatter", note: "纯电视广播谈话背景声（无用户指令）" },
    { noise: "cafe_babble", note: "纯多人嘈杂咖啡馆背景声" },
    { noise: "keyboard_clicks", voice: "Microsoft Kangkang", text: "这段代码编译报错了，我看一下日志", snr: 4, note: "敲键盘时自言自语（非指令）" },
    { noise: "tv_chatter", voice: "Microsoft Huihui", text: "刚才新闻里提到Neo芯片性能提升很大", snr: 3, note: "电视背景声下第三人称提及Neo" },
    { noise: "fan_hum", voice: "Microsoft Yaoyao", text: "今天好热啊，等下喝杯冰水吧", snr: 2, note: "风扇噪声中日常聊天（无唤醒词）" },
  ];
  for (const n of noiseNegSpecs) {
    const hasSpk = Boolean(n.voice && n.text);
    add({
      category: "ambient_noise",
      isNeoCommand: false,
      soundTypes: hasSpk ? ["speech", "noise"] : ["noise"],
      hasBgm: false,
      hasSong: false,
      noiseType: n.noise,
      snrDb: hasSpk ? (n.snr ?? 3) : null,
      minDurationSec: 3.6,
      dialogState: "standby",
      speakers: hasSpk
        ? [{ speakerId: "chat_n", voice: n.voice!, role: "family", text: n.text!, offsetSec: 0.55, isNeoSpeaker: false }]
        : [],
      expectedCommand: "",
      expectedCommandKeywords: [],
      notes: n.note,
    });
  }

  // ===========================================================================
  // Category 5: multi_speaker — 18 clips (9 Neo positive, 9 Non-Neo negative)
  // Sequential 2-3 speakers, simultaneous overlapping crosstalk, multi-speaker + BGM
  // ===========================================================================
  // 9 Positive Multi-Speaker clips
  add({
    category: "multi_speaker",
    isNeoCommand: true,
    soundTypes: ["speech", "multi_speaker"],
    hasBgm: false,
    hasSong: false,
    noiseType: "none",
    snrDb: null,
    dialogState: "standby",
    speakers: [
      { speakerId: "family_f1", voice: "Microsoft Huihui", role: "family", text: "你晚上想吃米饭还是面条呀", offsetSec: 0.25, isNeoSpeaker: false },
      { speakerId: "owner_m1", voice: "Microsoft Kangkang", role: "owner", text: "Neo，打开客厅吸顶灯", offsetSec: 2.8, isNeoSpeaker: true },
    ],
    expectedCommand: "打开客厅吸顶灯",
    expectedCommandKeywords: [["打开", "开"], ["客厅", "吸顶灯", "灯"]],
    notes: "双人顺序讲话：说话人A日常聊天 -> 说话人B下达Neo开灯指令",
  });
  add({
    category: "multi_speaker",
    isNeoCommand: true,
    soundTypes: ["speech", "multi_speaker"],
    hasBgm: false,
    hasSong: false,
    noiseType: "none",
    snrDb: null,
    dialogState: "standby",
    speakers: [
      { speakerId: "owner_m1", voice: "Microsoft Kangkang", role: "owner", text: "Neo，关闭卧室灯", offsetSec: 0.25, isNeoSpeaker: true },
      { speakerId: "family_f2", voice: "Microsoft Yaoyao", role: "family", text: "明天早上别忘了带雨伞出门", offsetSec: 2.3, isNeoSpeaker: false },
    ],
    expectedCommand: "关闭卧室灯",
    expectedCommandKeywords: [["关", "关闭"], ["卧室", "灯"]],
    notes: "双人顺序讲话：先下达Neo关灯指令 -> 另一人紧接着聊无关话题（不可把后人聊天拼成指令）",
  });
  add({
    category: "multi_speaker",
    isNeoCommand: true,
    soundTypes: ["speech", "multi_speaker"],
    hasBgm: false,
    hasSong: false,
    noiseType: "none",
    snrDb: null,
    dialogState: "standby",
    speakers: [
      { speakerId: "family_f1", voice: "Microsoft Huihui", role: "family", text: "周末电影票买好了吗", offsetSec: 0.2, isNeoSpeaker: false },
      { speakerId: "owner_m1", voice: "Microsoft Kangkang", role: "owner", text: "Neo，把空调调到25度", offsetSec: 2.2, isNeoSpeaker: true },
      { speakerId: "family_f2", voice: "Microsoft Yaoyao", role: "family", text: "买好了是下午三点的场次", offsetSec: 4.5, isNeoSpeaker: false },
    ],
    expectedCommand: "把空调调到25度",
    expectedCommandKeywords: [["空调"], ["25", "二十五"]],
    notes: "三人顺序对话：中间插播主人的Neo空调指令",
  });
  add({
    category: "multi_speaker",
    isNeoCommand: true,
    soundTypes: ["speech", "multi_speaker"],
    hasBgm: false,
    hasSong: false,
    noiseType: "none",
    snrDb: null,
    dialogState: "standby",
    speakers: [
      { speakerId: "family_f1", voice: "Microsoft Huihui", role: "family", text: "昨天超市打折买了不少水果放在冰箱里记得吃", offsetSec: 0.2, gainDb: -4, isNeoSpeaker: false },
      { speakerId: "owner_m1", voice: "Microsoft Kangkang", role: "owner", text: "Neo，打开书房台灯", offsetSec: 0.9, gainDb: 0, isNeoSpeaker: true },
    ],
    expectedCommand: "打开书房台灯",
    expectedCommandKeywords: [["打开", "开"], ["书房", "台灯", "灯"]],
    notes: "双人同时重叠并发讲话（+4dB 主人女声背景干扰）：提取主人开台灯指令",
  });
  add({
    category: "multi_speaker",
    isNeoCommand: true,
    soundTypes: ["speech", "multi_speaker"],
    hasBgm: false,
    hasSong: false,
    noiseType: "none",
    snrDb: null,
    dialogState: "standby",
    speakers: [
      { speakerId: "family_f2", voice: "Microsoft Yaoyao", role: "family", text: "明天开会的材料我都整理好发到群里了你记得看一下", offsetSec: 0.15, gainDb: -2, isNeoSpeaker: false },
      { speakerId: "owner_m1", voice: "Microsoft Kangkang", role: "owner", text: "Neo，把小米音响音量调到30", offsetSec: 0.85, gainDb: 0, isNeoSpeaker: true },
    ],
    expectedCommand: "把小米音响音量调到30",
    expectedCommandKeywords: [["音量", "声音", "音响", "音箱"], ["30", "三十"]],
    notes: "双人高强度重叠讲话（+2dB SIR）：提取主人音量指令",
  });
  add({
    category: "multi_speaker",
    isNeoCommand: true,
    soundTypes: ["speech", "multi_speaker", "bgm"],
    hasBgm: true,
    hasSong: false,
    bgmKind: "piano_lofi",
    noiseType: "none",
    snrDb: 4,
    dialogState: "standby",
    speakers: [
      { speakerId: "family_f1", voice: "Microsoft Huihui", role: "family", text: "厨房里的水烧开了我去泡茶", offsetSec: 0.3, isNeoSpeaker: false },
      { speakerId: "owner_m1", voice: "Microsoft Kangkang", role: "owner", text: "Neo，关闭客厅风扇", offsetSec: 2.7, isNeoSpeaker: true },
    ],
    expectedCommand: "关闭客厅风扇",
    expectedCommandKeywords: [["关", "关闭"], ["风扇", "客厅"]],
    notes: "双人对话 + BGM 复合场景：分离BGM与说话人后执行关风扇",
  });
  add({
    category: "multi_speaker",
    isNeoCommand: true,
    soundTypes: ["speech", "multi_speaker", "song", "bgm"],
    hasBgm: true,
    hasSong: true,
    songSource: "qi-feng-le",
    songOffsetSec: 4.0,
    noiseType: "none",
    snrDb: 4,
    dialogState: "standby",
    speakers: [
      { speakerId: "family_f2", voice: "Microsoft Yaoyao", role: "family", text: "这首歌声音有点大了", offsetSec: 0.35, isNeoSpeaker: false },
      { speakerId: "owner_m1", voice: "Microsoft Kangkang", role: "owner", text: "Neo，把音量调小一点", offsetSec: 2.4, isNeoSpeaker: true },
    ],
    expectedCommand: "把音量调小一点",
    expectedCommandKeywords: [["音量", "声音"], ["小", "低", "降"]],
    notes: "双人对话 + 真实歌声背景终极复合场景：调小音量",
  });
  add({
    category: "multi_speaker",
    isNeoCommand: true,
    soundTypes: ["speech", "multi_speaker", "noise"],
    hasBgm: false,
    hasSong: false,
    noiseType: "tv_chatter",
    snrDb: 4,
    dialogState: "standby",
    speakers: [
      { speakerId: "family_f1", voice: "Microsoft Huihui", role: "family", text: "快看外面好像下雨了", offsetSec: 0.3, isNeoSpeaker: false },
      { speakerId: "owner_m1", voice: "Microsoft Kangkang", role: "owner", text: "Neo，关闭窗帘", offsetSec: 2.3, isNeoSpeaker: true },
    ],
    expectedCommand: "关闭窗帘",
    expectedCommandKeywords: [["关", "关闭"], ["窗帘", "窗"]],
    notes: "双人对话 + 电视人声噪声背景：关闭窗帘",
  });
  add({
    category: "multi_speaker",
    isNeoCommand: true,
    soundTypes: ["speech", "multi_speaker"],
    hasBgm: false,
    hasSong: false,
    noiseType: "none",
    snrDb: null,
    dialogState: "standby",
    speakers: [
      { speakerId: "bystander_en", voice: "Microsoft Zira", role: "bystander", text: "Did you finish reading that article from yesterday", offsetSec: 0.2, gainDb: -4, isNeoSpeaker: false },
      { speakerId: "owner_m1", voice: "Microsoft Kangkang", role: "owner", text: "Neo，打开客厅灯", offsetSec: 0.75, gainDb: 0, isNeoSpeaker: true },
    ],
    expectedCommand: "打开客厅灯",
    expectedCommandKeywords: [["打开", "开"], ["客厅", "灯"]],
    notes: "中英双人同时重叠讲话：英文旁白叠中文主人指令",
  });

  // 9 Negative Multi-Speaker clips
  add({
    category: "multi_speaker",
    isNeoCommand: false,
    soundTypes: ["speech", "multi_speaker"],
    hasBgm: false,
    hasSong: false,
    noiseType: "none",
    snrDb: null,
    dialogState: "standby",
    speakers: [
      { speakerId: "family_f1", voice: "Microsoft Huihui", role: "family", text: "晚上我们吃烤鱼还是炒菜呀", offsetSec: 0.25, isNeoSpeaker: false },
      { speakerId: "owner_m1", voice: "Microsoft Kangkang", role: "owner", text: "随便吧炒两个青菜就行", offsetSec: 2.6, isNeoSpeaker: false },
    ],
    expectedCommand: "",
    expectedCommandKeywords: [],
    notes: "双人日常家庭对话（无指令）",
  });
  add({
    category: "multi_speaker",
    isNeoCommand: false,
    soundTypes: ["speech", "multi_speaker"],
    hasBgm: false,
    hasSong: false,
    noiseType: "none",
    snrDb: null,
    dialogState: "standby",
    speakers: [
      { speakerId: "owner_m1", voice: "Microsoft Kangkang", role: "owner", text: "你觉得Neo这个语音助手好用吗", offsetSec: 0.25, isNeoSpeaker: false },
      { speakerId: "family_f1", voice: "Microsoft Huihui", role: "family", text: "我觉得还不错反应挺快的", offsetSec: 2.7, isNeoSpeaker: false },
    ],
    expectedCommand: "",
    expectedCommandKeywords: [],
    notes: "双人讨论第三人称 Neo（非下达指令）",
  });
  add({
    category: "multi_speaker",
    isNeoCommand: false,
    soundTypes: ["speech", "multi_speaker"],
    hasBgm: false,
    hasSong: false,
    noiseType: "none",
    snrDb: null,
    dialogState: "standby",
    speakers: [
      { speakerId: "family_f1", voice: "Microsoft Huihui", role: "family", text: "我刚跟同事聊到Neo的时候大家都很感兴趣", offsetSec: 0.2, isNeoSpeaker: false },
      { speakerId: "family_f2", voice: "Microsoft Yaoyao", role: "family", text: "对呀我也想在家里装一个", offsetSec: 3.1, isNeoSpeaker: false },
    ],
    expectedCommand: "",
    expectedCommandKeywords: [],
    notes: "双人聊天转述提及 Neo",
  });
  add({
    category: "multi_speaker",
    isNeoCommand: false,
    soundTypes: ["speech", "multi_speaker"],
    hasBgm: false,
    hasSong: false,
    noiseType: "none",
    snrDb: null,
    dialogState: "standby",
    speakers: [
      { speakerId: "owner_m1", voice: "Microsoft Kangkang", role: "owner", text: "快递放在门口了谁去拿一下", offsetSec: 0.2, gainDb: 0, isNeoSpeaker: false },
      { speakerId: "family_f1", voice: "Microsoft Huihui", role: "family", text: "我马上去拿顺便把垃圾也倒了", offsetSec: 0.9, gainDb: -2, isNeoSpeaker: false },
    ],
    expectedCommand: "",
    expectedCommandKeywords: [],
    notes: "双人同时重叠家务对话（非指令）",
  });
  add({
    category: "multi_speaker",
    isNeoCommand: false,
    soundTypes: ["speech", "multi_speaker"],
    hasBgm: false,
    hasSong: false,
    noiseType: "none",
    snrDb: null,
    dialogState: "standby",
    speakers: [
      { speakerId: "family_f1", voice: "Microsoft Huihui", role: "family", text: "别管Neo了先把客厅收拾一下吧", offsetSec: 0.2, isNeoSpeaker: false },
      { speakerId: "owner_m1", voice: "Microsoft Kangkang", role: "owner", text: "好我把茶几擦干净", offsetSec: 2.9, isNeoSpeaker: false },
    ],
    expectedCommand: "",
    expectedCommandKeywords: [],
    notes: "双人对话中包含否定提及 Neo",
  });
  add({
    category: "multi_speaker",
    isNeoCommand: false,
    soundTypes: ["speech", "multi_speaker", "bgm"],
    hasBgm: true,
    hasSong: false,
    bgmKind: "acoustic_guitar",
    noiseType: "none",
    snrDb: 4,
    dialogState: "standby",
    speakers: [
      { speakerId: "family_f2", voice: "Microsoft Yaoyao", role: "family", text: "这首吉他曲挺放松的", offsetSec: 0.3, isNeoSpeaker: false },
      { speakerId: "owner_m1", voice: "Microsoft Kangkang", role: "owner", text: "嗯适合晚上看书的时候听", offsetSec: 2.3, isNeoSpeaker: false },
    ],
    expectedCommand: "",
    expectedCommandKeywords: [],
    notes: "双人聊天 + 纯器乐BGM（非指令）",
  });
  add({
    category: "multi_speaker",
    isNeoCommand: false,
    soundTypes: ["speech", "multi_speaker", "song", "bgm"],
    hasBgm: true,
    hasSong: true,
    songSource: "piao-yang",
    songOffsetSec: 15.0,
    noiseType: "none",
    snrDb: 3,
    dialogState: "standby",
    speakers: [
      { speakerId: "family_f1", voice: "Microsoft Huihui", role: "family", text: "你好，帮我把桌上那杯水递过来", offsetSec: 0.35, isNeoSpeaker: false },
      { speakerId: "owner_m1", voice: "Microsoft Kangkang", role: "owner", text: "给，小心有点烫", offsetSec: 2.8, isNeoSpeaker: false },
    ],
    expectedCommand: "",
    expectedCommandKeywords: [],
    notes: "双人对话 + 真实歌声背景 + '你好'近音陷阱",
  });
  add({
    category: "multi_speaker",
    isNeoCommand: false,
    soundTypes: ["speech", "multi_speaker"],
    hasBgm: false,
    hasSong: false,
    noiseType: "none",
    snrDb: null,
    dialogState: "standby",
    speakers: [
      { speakerId: "family_f1", voice: "Microsoft Huihui", role: "family", text: "今天外面太阳好大呀", offsetSec: 0.2, isNeoSpeaker: false },
      { speakerId: "family_f2", voice: "Microsoft Yaoyao", role: "family", text: "是啊我把阳台的衣服都收进来了", offsetSec: 2.0, isNeoSpeaker: false },
      { speakerId: "owner_m1", voice: "Microsoft Kangkang", role: "owner", text: "晚上应该会凉快一点", offsetSec: 4.4, isNeoSpeaker: false },
    ],
    expectedCommand: "",
    expectedCommandKeywords: [],
    notes: "三人日常闲聊（无指令）",
  });
  add({
    category: "multi_speaker",
    isNeoCommand: false,
    soundTypes: ["speech", "multi_speaker", "noise"],
    hasBgm: false,
    hasSong: false,
    noiseType: "cafe_babble",
    snrDb: 3,
    dialogState: "standby",
    speakers: [
      { speakerId: "owner_en", voice: "Microsoft David", role: "owner", text: "No, I think we should take the subway instead", offsetSec: 0.3, isNeoSpeaker: false },
      { speakerId: "bystander_en", voice: "Microsoft Zira", role: "bystander", text: "Sounds good, traffic near downtown is heavy", offsetSec: 2.9, isNeoSpeaker: false },
    ],
    expectedCommand: "",
    expectedCommandKeywords: [],
    notes: "英文双人聊天 + 咖啡馆背景音 + No/Near 陷阱",
  });

  // ===========================================================================
  // Category 6: conversation_scenes — 12 clips (6 Neo positive, 6 Non-Neo negative)
  // Continuous dialog mode (with recent 5-turn history), followups vs sidetalk vs echo
  // ===========================================================================
  const lightHistory = [
    { role: "user" as const, text: "Neo，打开客厅吸顶灯" },
    { role: "assistant" as const, text: "已打开客厅吸顶灯。" },
  ];
  const speakerHistory = [
    { role: "user" as const, text: "Neo，播放轻音乐" },
    { role: "assistant" as const, text: "已开始播放轻音乐。" },
  ];

  // 6 positive followups in conversation mode (no wake word required!)
  add({
    category: "conversation_scenes",
    isNeoCommand: true,
    soundTypes: ["speech"],
    hasBgm: false,
    hasSong: false,
    noiseType: "none",
    snrDb: null,
    dialogState: "conversation",
    recentHistory: lightHistory,
    speakers: [
      { speakerId: "owner_m1", voice: "Microsoft Kangkang", role: "owner", text: "再调亮一点", offsetSec: 0.3, isNeoSpeaker: true },
    ],
    expectedCommand: "再调亮一点",
    expectedCommandKeywords: [["亮", "调亮"]],
    notes: "连续对话免唤醒追问：调亮灯光",
  });
  add({
    category: "conversation_scenes",
    isNeoCommand: true,
    soundTypes: ["speech", "bgm"],
    hasBgm: true,
    hasSong: false,
    bgmKind: "piano_lofi",
    noiseType: "none",
    snrDb: 3,
    dialogState: "conversation",
    recentHistory: speakerHistory,
    speakers: [
      { speakerId: "owner_m1", voice: "Microsoft Kangkang", role: "owner", text: "声音小一点", offsetSec: 0.55, isNeoSpeaker: true },
    ],
    expectedCommand: "声音小一点",
    expectedCommandKeywords: [["声音", "音量"], ["小", "低"]],
    notes: "连续对话 + BGM 背景下免唤醒调小声音",
  });
  add({
    category: "conversation_scenes",
    isNeoCommand: true,
    soundTypes: ["speech", "song", "bgm"],
    hasBgm: true,
    hasSong: true,
    songSource: "qi-feng-le",
    songOffsetSec: 6.0,
    noiseType: "none",
    snrDb: 4,
    dialogState: "conversation",
    recentHistory: speakerHistory,
    speakers: [
      { speakerId: "owner_m1", voice: "Microsoft Kangkang", role: "owner", text: "换一首歌", offsetSec: 0.65, isNeoSpeaker: true },
    ],
    expectedCommand: "换一首歌",
    expectedCommandKeywords: [["换", "下一首", "切"]],
    notes: "连续对话 + 真实歌声背景免唤醒切歌",
  });
  add({
    category: "conversation_scenes",
    isNeoCommand: true,
    soundTypes: ["speech", "noise"],
    hasBgm: false,
    hasSong: false,
    noiseType: "fan_hum",
    snrDb: 2,
    dialogState: "conversation",
    recentHistory: lightHistory,
    speakers: [
      { speakerId: "family_f1", voice: "Microsoft Huihui", role: "family", text: "把卧室灯也关掉", offsetSec: 0.5, isNeoSpeaker: true },
    ],
    expectedCommand: "把卧室灯也关掉",
    expectedCommandKeywords: [["关", "关掉", "关闭"], ["卧室", "灯"]],
    notes: "连续对话 + 风扇噪声下免唤醒关卧室灯",
  });
  add({
    category: "conversation_scenes",
    isNeoCommand: true,
    soundTypes: ["speech"],
    hasBgm: false,
    hasSong: false,
    noiseType: "none",
    snrDb: null,
    dialogState: "conversation",
    recentHistory: lightHistory,
    speakers: [
      { speakerId: "owner_m1", voice: "Microsoft Kangkang", role: "owner", text: "顺便打开书房台灯", offsetSec: 0.3, isNeoSpeaker: true },
    ],
    expectedCommand: "顺便打开书房台灯",
    expectedCommandKeywords: [["打开", "开"], ["书房", "台灯", "灯"]],
    notes: "连续对话免唤醒顺便开书房台灯",
  });
  add({
    category: "conversation_scenes",
    isNeoCommand: true,
    soundTypes: ["speech", "multi_speaker"],
    hasBgm: false,
    hasSong: false,
    noiseType: "none",
    snrDb: null,
    dialogState: "conversation",
    recentHistory: lightHistory,
    speakers: [
      { speakerId: "family_f1", voice: "Microsoft Huihui", role: "family", text: "我去厨房洗点水果", offsetSec: 0.25, isNeoSpeaker: false },
      { speakerId: "owner_m1", voice: "Microsoft Kangkang", role: "owner", text: "把亮度调到80", offsetSec: 2.3, isNeoSpeaker: true },
    ],
    expectedCommand: "把亮度调到80",
    expectedCommandKeywords: [["亮度", "调到"], ["80", "八十"]],
    notes: "连续对话 + 多人场景：家人旁白后主人免唤醒续聊调亮度",
  });

  // 6 negative clips in conversation mode (family sidetalk, echo, pure song, third-person)
  add({
    category: "conversation_scenes",
    isNeoCommand: false,
    soundTypes: ["speech"],
    hasBgm: false,
    hasSong: false,
    noiseType: "none",
    snrDb: null,
    dialogState: "conversation",
    recentHistory: lightHistory,
    speakers: [
      { speakerId: "family_f1", voice: "Microsoft Huihui", role: "family", text: "晚饭吃什么呀，帮我拿双筷子", offsetSec: 0.3, isNeoSpeaker: false },
    ],
    expectedCommand: "",
    expectedCommandKeywords: [],
    notes: "连续对话窗口内的家人旁白（必须拒绝）",
  });
  add({
    category: "conversation_scenes",
    isNeoCommand: false,
    soundTypes: ["speech"],
    hasBgm: false,
    hasSong: false,
    noiseType: "none",
    snrDb: null,
    dialogState: "conversation",
    recentHistory: lightHistory,
    lastSpokenReply: "已打开客厅吸顶灯。",
    speakers: [
      { speakerId: "owner_m1", voice: "Microsoft Kangkang", role: "owner", text: "已打开客厅吸顶灯", offsetSec: 0.25, isNeoSpeaker: false },
    ],
    expectedCommand: "",
    expectedCommandKeywords: [],
    notes: "连续对话窗口内的 TTS 扬声器自回声（必须抑制）",
  });
  add({
    category: "conversation_scenes",
    isNeoCommand: false,
    soundTypes: ["speech"],
    hasBgm: false,
    hasSong: false,
    noiseType: "none",
    snrDb: null,
    dialogState: "conversation",
    recentHistory: lightHistory,
    speakers: [
      { speakerId: "owner_m1", voice: "Microsoft Kangkang", role: "owner", text: "哈哈今天上班太累了，待会早点睡", offsetSec: 0.3, isNeoSpeaker: false },
    ],
    expectedCommand: "",
    expectedCommandKeywords: [],
    notes: "连续对话窗口内的日常感叹旁白",
  });
  add({
    category: "conversation_scenes",
    isNeoCommand: false,
    soundTypes: ["speech"],
    hasBgm: false,
    hasSong: false,
    noiseType: "none",
    snrDb: null,
    dialogState: "conversation",
    recentHistory: lightHistory,
    speakers: [
      { speakerId: "family_f2", voice: "Microsoft Yaoyao", role: "family", text: "好了谢谢不用了", offsetSec: 0.3, isNeoSpeaker: false },
    ],
    expectedCommand: "",
    expectedCommandKeywords: [],
    notes: "连续对话窗口内的礼貌告别/结束对话口令",
  });
  add({
    category: "conversation_scenes",
    isNeoCommand: false,
    soundTypes: ["song", "bgm"],
    hasBgm: true,
    hasSong: true,
    songSource: "qi-feng-le",
    songOffsetSec: 11.0,
    noiseType: "none",
    snrDb: null,
    minDurationSec: 4.0,
    dialogState: "conversation",
    recentHistory: speakerHistory,
    speakers: [],
    expectedCommand: "",
    expectedCommandKeywords: [],
    notes: "连续对话窗口内只有歌曲演唱（绝不能把歌词当免唤醒指令）",
  });
  add({
    category: "conversation_scenes",
    isNeoCommand: false,
    soundTypes: ["speech", "noise"],
    hasBgm: false,
    hasSong: false,
    noiseType: "tv_chatter",
    snrDb: 2,
    dialogState: "conversation",
    recentHistory: lightHistory,
    speakers: [
      { speakerId: "family_f1", voice: "Microsoft Huihui", role: "family", text: "你去拿一下外卖吧，我在接电话", offsetSec: 0.45, isNeoSpeaker: false },
    ],
    expectedCommand: "",
    expectedCommandKeywords: [],
    notes: "连续对话窗口 + 电视背景音中的家人旁白",
  });

  if (recipes.length !== 100) {
    throw new Error(`Expected exactly 100 recipes, got ${recipes.length}`);
  }
  const posCount = recipes.filter((r) => r.isNeoCommand).length;
  const negCount = recipes.length - posCount;
  if (posCount !== 50 || negCount !== 50) {
    throw new Error(`Expected exact 50/50 split, got ${posCount}/${negCount}`);
  }
  return recipes;
}

// =============================================================================
// WinRT 批量 TTS 合成（一次 PowerShell 调用合成所有不重复语音片段）
// =============================================================================

interface TtsJob {
  key: string;
  voice: VoiceId;
  text: string;
  rate: number;
  outPath: string;
}

function hashKey(voice: string, text: string, rate: number): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(`${voice}|${rate.toFixed(2)}|${text}`);
  return hasher.digest("hex").slice(0, 16);
}

async function synthesizeAllTtsJobs(jobs: TtsJob[]): Promise<void> {
  mkdirSync(TTS_CACHE_DIR, { recursive: true });
  const missing = jobs.filter((j) => !existsSync(j.outPath));
  if (missing.length === 0) {
    console.log(`[TTS] All ${jobs.length} speech clips cached.`);
    return;
  }
  console.log(`[TTS] Synthesizing ${missing.length} unique speech utterances via WinRT OneCore TTS...`);
  const jobsJsonPath = path.join(TTS_CACHE_DIR, "_tts_jobs.json");
  writeFileSync(jobsJsonPath, JSON.stringify(missing, null, 2), "utf8");

  const psScript = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
[void][Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType=WindowsRuntime]
[void][Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType=WindowsRuntime]

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
})[0]

function Await-WinRT($winRtTask, $resultType) {
  $netTask = $asTaskGeneric.MakeGenericMethod($resultType).Invoke($null, @($winRtTask))
  $netTask.Wait(-1) | Out-Null
  return $netTask.Result
}

$jobs = Get-Content -Raw -Encoding UTF8 '${jobsJsonPath.replace(/'/g, "''")}' | ConvertFrom-Json
if ($jobs -isnot [System.Array]) { $jobs = @($jobs) }

$voices = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices
$voiceMap = @{}
foreach ($v in $voices) { $voiceMap[$v.DisplayName] = $v }

$synth = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
$done = 0
foreach ($job in $jobs) {
  $v = $voiceMap[$job.voice]
  if (-not $v) { $v = $voiceMap['Microsoft Huihui'] }
  $synth.Voice = $v
  try { $synth.Options.SpeakingRate = [double]$job.rate } catch {}
  $stream = Await-WinRT ($synth.SynthesizeTextToStreamAsync([string]$job.text)) ([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])
  $size = [uint32]$stream.Size
  $reader = New-Object Windows.Storage.Streams.DataReader($stream.GetInputStreamAt(0))
  $loadOp = $reader.LoadAsync($size)
  $asTaskGeneric.MakeGenericMethod([uint32]).Invoke($null, @($loadOp)).Wait(-1) | Out-Null
  $bytes = New-Object byte[] $size
  $reader.ReadBytes($bytes)
  [System.IO.File]::WriteAllBytes([string]$job.outPath, $bytes)
  $reader.Dispose()
  $stream.Dispose()
  $done++
}
$synth.Dispose()
Write-Output "Synthesized $done TTS clips."
`;
  const psPath = path.join(TTS_CACHE_DIR, "_run_tts.ps1");
  writeFileSync(psPath, psScript, "utf8");
  const proc = Bun.spawn(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", psPath], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(`WinRT TTS synthesis failed (exit ${code}): ${stderr || stdout}`);
  }
  console.log(`[TTS] ${stdout.trim()}`);
}

// =============================================================================
// 真实音频素材加载与纯伴奏/多类环境噪声合成
// =============================================================================

function loadWav16k(filePath: string): Float32Array {
  const bytes = readFileSync(filePath);
  const decoded = decodeWavPcm(bytes);
  return decoded.sampleRate === TARGET_SR
    ? decoded.samples
    : resampleLinear(decoded.samples, decoded.sampleRate, TARGET_SR);
}

function sliceLoop(src: Float32Array, offsetSec: number, lengthSamples: number): Float32Array {
  const out = new Float32Array(lengthSamples);
  if (src.length === 0) return out;
  const start = Math.floor(offsetSec * TARGET_SR) % src.length;
  for (let i = 0; i < lengthSamples; i += 1) {
    out[i] = src[(start + i) % src.length]!;
  }
  return out;
}

function trimSilenceEdges(samples: Float32Array, thresh = 0.004): Float32Array {
  let start = 0;
  let end = samples.length - 1;
  while (start < end && Math.abs(samples[start]!) < thresh) start += 1;
  while (end > start && Math.abs(samples[end]!) < thresh) end -= 1;
  const pad = Math.round(TARGET_SR * 0.04);
  start = Math.max(0, start - pad);
  end = Math.min(samples.length, end + pad);
  return samples.slice(start, end);
}

function normalizeRms(samples: Float32Array, targetRms: number): Float32Array {
  const rms = computeRms(samples);
  if (rms < 1e-6) return new Float32Array(samples.length);
  const gain = targetRms / rms;
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    out[i] = samples[i]! * gain;
  }
  return out;
}

function extractRealAccompaniment(songPath: string, cachePath: string): Float32Array {
  if (existsSync(cachePath)) {
    return loadWav16k(cachePath);
  }
  const spleeterDir = path.join(MODELS_DIR, "sherpa-onnx-spleeter-2stems-fp16");
  const uvrPath = path.join(MODELS_DIR, "uvr", "UVR_MDXNET_1_9703.onnx");
  const rawSong = loadWav16k(songPath);
  // Extract first 25s accompaniment stem using sherpa-onnx OfflineSourceSeparation if model exists
  const segLen = Math.min(rawSong.length, TARGET_SR * 25);
  const seg = rawSong.subarray(0, segLen);
  try {
    const req = createRequire(import.meta.url);
    const sherpa = req("sherpa-onnx-node");
    if (sherpa && typeof sherpa.OfflineSourceSeparation === "function") {
      let sep: any = null;
      if (existsSync(path.join(spleeterDir, "vocals.fp16.onnx")) && existsSync(path.join(spleeterDir, "accompaniment.fp16.onnx"))) {
        sep = new sherpa.OfflineSourceSeparation({
          model: {
            spleeter: {
              vocals: path.join(spleeterDir, "vocals.fp16.onnx"),
              accompaniment: path.join(spleeterDir, "accompaniment.fp16.onnx"),
            },
            numThreads: 4,
            provider: "cpu",
            debug: false,
          },
        });
      } else if (existsSync(uvrPath)) {
        sep = new sherpa.OfflineSourceSeparation({
          model: { uvr: { model: uvrPath }, numThreads: 4, provider: "cpu", debug: false },
        });
      }
      if (sep) {
        console.log(`[BGM] Extracting pure instrumental accompaniment from ${path.basename(songPath)}...`);
        const res = sep.process({ samples: [seg], sampleRate: TARGET_SR });
        // stems[1] is accompaniment (stems[0] is vocals)
        const accStem = res?.stems?.[1]?.[0];
        if (accStem && accStem.length > 0) {
          const acc16k =
            res.sampleRate === TARGET_SR
              ? new Float32Array(accStem)
              : resampleLinear(new Float32Array(accStem), res.sampleRate, TARGET_SR);
          const norm = normalizeRms(acc16k, 0.14);
          writeFileSync(cachePath, encodeWavPcm16(norm, TARGET_SR));
          return norm;
        }
      }
    }
  } catch (err) {
    console.warn(`[BGM] Accompaniment extraction fallback:`, err);
  }
  // Fallback: procedural rich chord track
  return synthProceduralBgm("piano_lofi", segLen, new SeededRng(4242));
}

function synthProceduralBgm(
  kind: "piano_lofi" | "electronic_beat" | "acoustic_guitar",
  lengthSamples: number,
  rng: SeededRng,
): Float32Array {
  const out = new Float32Array(lengthSamples);
  const chords = [
    [261.63, 329.63, 392.0, 493.88], // Cmaj7
    [220.0, 261.63, 329.63, 392.0], // Am7
    [174.61, 220.0, 261.63, 329.63], // Fmaj7
    [196.0, 246.94, 293.66, 392.0], // G6
  ];
  const bpm = kind === "electronic_beat" ? 122 : kind === "acoustic_guitar" ? 96 : 82;
  const beatSec = 60 / bpm;

  for (let i = 0; i < lengthSamples; i += 1) {
    const t = i / TARGET_SR;
    const beatIdx = Math.floor(t / beatSec);
    const beatPhase = (t % beatSec) / beatSec;
    const chord = chords[Math.floor(beatIdx / 4) % chords.length]!;
    let v = 0;

    if (kind === "piano_lofi") {
      const env = Math.exp(-beatPhase * 2.4);
      for (let k = 0; k < chord.length; k += 1) {
        const f = chord[k]!;
        v += (0.14 * env) * (Math.sin(2 * Math.PI * f * t) + 0.3 * Math.sin(4 * Math.PI * f * t));
      }
      // warm bass + soft vinyl brush
      const bass = chord[0]! * 0.5;
      v += 0.22 * Math.exp(-beatPhase * 3.0) * Math.sin(2 * Math.PI * bass * t);
      if (beatIdx % 2 === 1 && beatPhase < 0.08) {
        v += 0.08 * (1 - beatPhase / 0.08) * rng.gaussian();
      }
    } else if (kind === "electronic_beat") {
      // Kick on every beat (pitch sweep 150Hz -> 45Hz)
      const kickEnv = Math.exp(-beatPhase * 16);
      const kickFreq = 45 + 105 * Math.exp(-beatPhase * 28);
      v += 0.42 * kickEnv * Math.sin(2 * Math.PI * kickFreq * beatPhase * beatSec);
      // Off-beat hi-hat
      const eighthPhase = ((t + beatSec * 0.5) % beatSec) / beatSec;
      if (eighthPhase < 0.06) {
        v += 0.14 * Math.exp(-eighthPhase * 45) * rng.gaussian();
      }
      // Sidechained synth pad
      const sidechain = Math.min(1, beatPhase * 4);
      for (const f of chord) {
        const saw = 2 * ((f * t) % 1) - 1;
        v += 0.055 * sidechain * (0.6 * Math.sin(2 * Math.PI * f * t) + 0.4 * saw);
      }
    } else {
      // acoustic_guitar arpeggio
      const sixteenthSec = beatSec / 2;
      const stepIdx = Math.floor(t / sixteenthSec);
      const stepPhase = (t % sixteenthSec) / sixteenthSec;
      const noteFreq = chord[stepIdx % chord.length]! * (stepIdx % 8 >= 4 ? 2 : 1);
      const pluck = Math.exp(-stepPhase * 4.5);
      v +=
        0.24 *
        pluck *
        (Math.sin(2 * Math.PI * noteFreq * t) +
          0.45 * Math.sin(4 * Math.PI * noteFreq * t) +
          0.2 * Math.sin(6 * Math.PI * noteFreq * t));
      v += 0.16 * Math.exp(-beatPhase * 2.2) * Math.sin(2 * Math.PI * (chord[0]! * 0.5) * t);
    }
    out[i] = v;
  }
  return normalizeRms(out, 0.14);
}

function synthEnvironmentalNoise(
  kind: NoiseKind,
  lengthSamples: number,
  rng: SeededRng,
  fourSpeakersAudio: Float32Array,
): Float32Array {
  const out = new Float32Array(lengthSamples);
  if (kind === "none") return out;

  if (kind === "fan_hum") {
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < lengthSamples; i += 1) {
      const t = i / TARGET_SR;
      const w = rng.gaussian();
      b0 = 0.997 * b0 + w * 0.03;
      b1 = 0.985 * b1 + w * 0.05;
      b2 = 0.95 * b2 + w * 0.08;
      const airflow = b0 + b1 + b2;
      const hum =
        0.18 * Math.sin(2 * Math.PI * 50 * t) +
        0.11 * Math.sin(2 * Math.PI * 100 * t) +
        0.06 * Math.sin(2 * Math.PI * 150 * t);
      out[i] = airflow + hum;
    }
  } else if (kind === "rain_broadband") {
    let lp = 0;
    for (let i = 0; i < lengthSamples; i += 1) {
      const w = rng.gaussian();
      lp = 0.72 * lp + 0.28 * w;
      // occasional droplet pop
      const drop = rng.next() < 0.0012 ? rng.uniform(-0.8, 0.8) : 0;
      out[i] = 0.7 * lp + 0.3 * w + drop;
    }
  } else if (kind === "keyboard_clicks") {
    // Low office room tone + crisp mechanical key click bursts (~7 clicks/sec)
    let lp = 0;
    let nextClick = Math.round(rng.uniform(0.06, 0.22) * TARGET_SR);
    let clickRemaining = 0;
    let clickFreq = 3200;
    for (let i = 0; i < lengthSamples; i += 1) {
      lp = 0.94 * lp + 0.06 * rng.gaussian();
      let v = 0.06 * lp;
      if (i >= nextClick) {
        clickRemaining = Math.round(0.018 * TARGET_SR);
        clickFreq = rng.uniform(2200, 4800);
        nextClick = i + Math.round(rng.uniform(0.09, 0.24) * TARGET_SR);
      }
      if (clickRemaining > 0) {
        const age = (0.018 * TARGET_SR - clickRemaining) / TARGET_SR;
        const env = Math.exp(-age * 280);
        v += env * (0.6 * rng.gaussian() + 0.5 * Math.sin(2 * Math.PI * clickFreq * age));
        clickRemaining -= 1;
      }
      out[i] = v;
    }
  } else if (kind === "vacuum_roar") {
    let lp = 0;
    for (let i = 0; i < lengthSamples; i += 1) {
      const t = i / TARGET_SR;
      const w = rng.gaussian();
      lp = 0.85 * lp + 0.15 * w;
      const motor =
        0.22 * Math.sin(2 * Math.PI * 185 * t) +
        0.15 * Math.sin(2 * Math.PI * 370 * t) +
        0.10 * Math.sin(2 * Math.PI * 555 * t) +
        0.07 * Math.sin(2 * Math.PI * 925 * t);
      out[i] = motor + 0.65 * lp + 0.35 * w;
    }
  } else if (kind === "tv_chatter") {
    // Authentic Mandarin TV talk-show chatter: bandpass-filtered real multi-speaker audio + slight room tone
    const offsetSec = rng.uniform(0, 6);
    const slice = sliceLoop(fourSpeakersAudio, offsetSec, lengthSamples);
    const hp = applyHighPassFilter(slice, TARGET_SR, 280);
    // Low-pass ~3600Hz to sound like a TV speaker across the room
    let lp = 0;
    for (let i = 0; i < lengthSamples; i += 1) {
      lp = 0.52 * lp + 0.48 * hp[i]!;
      out[i] = lp + 0.012 * rng.gaussian();
    }
  } else if (kind === "cafe_babble") {
    // 3 overlapping offset real-speech streams + ambient room hiss
    const s1 = sliceLoop(fourSpeakersAudio, rng.uniform(0, 5), lengthSamples);
    const s2 = sliceLoop(fourSpeakersAudio, rng.uniform(5, 11), lengthSamples);
    const s3 = sliceLoop(fourSpeakersAudio, rng.uniform(11, 17), lengthSamples);
    let lp = 0;
    for (let i = 0; i < lengthSamples; i += 1) {
      lp = 0.9 * lp + 0.1 * rng.gaussian();
      out[i] = 0.4 * s1[i]! + 0.35 * s2[i]! + 0.35 * s3[i]! + 0.18 * lp;
    }
  }

  return normalizeRms(out, 0.12);
}

function softLimit(x: number): number {
  if (Math.abs(x) <= 0.92) return x;
  return Math.sign(x) * (0.92 + 0.08 * Math.tanh((Math.abs(x) - 0.92) / 0.08));
}

function csvEscape(v: string): string {
  if (/[",\r\n]/.test(v)) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

// =============================================================================
// 主流程：生成 owner_ref.wav + 100 条 WAV + manifest.json + labels.csv
// =============================================================================

async function main() {
  mkdirSync(AUDIO_DIR, { recursive: true });
  mkdirSync(TTS_CACHE_DIR, { recursive: true });

  const recipes = buildRecipes();

  // 1. 收集所有唯一 TTS 语音任务（包含独立的中性 owner_ref 声纹注册语料，完全不与测试集文本重合）
  const ownerRefText = "今天是晴朗的一天，微风轻拂过窗前的绿植，茶杯里散发着淡淡的清香，适合安静地阅读一本好书。";
  const familyRefText = "窗外的阳光透过百叶窗洒在木地板上，远处的公园里传来一阵阵轻松的脚步声。";
  const jobMap = new Map<string, TtsJob>();
  const registerJob = (voice: VoiceId, text: string, rate = 1.0): string => {
    const key = hashKey(voice, text, rate);
    if (!jobMap.has(key)) {
      jobMap.set(key, {
        key,
        voice,
        text,
        rate,
        outPath: path.join(TTS_CACHE_DIR, `${key}.wav`),
      });
    }
    return jobMap.get(key)!.outPath;
  };

  const ownerRefRawPath = registerJob("Microsoft Kangkang", ownerRefText, 1.0);
  const familyRefRawPath = registerJob("Microsoft Huihui", familyRefText, 1.0);
  for (const r of recipes) {
    for (const spk of r.speakers) {
      registerJob(spk.voice, spk.text, spk.rate ?? 1.0);
    }
  }

  await synthesizeAllTtsJobs([...jobMap.values()]);

  // 2. 导出干净 16kHz owner_ref.wav & family_ref.wav（独立声纹/VoxLock 参考语音）
  const ownerRefPcm = normalizeRms(trimSilenceEdges(loadWav16k(ownerRefRawPath)), 0.16);
  writeFileSync(path.join(OUT_DIR, "owner_ref.wav"), encodeWavPcm16(ownerRefPcm, TARGET_SR));
  const familyRefPcm = normalizeRms(trimSilenceEdges(loadWav16k(familyRefRawPath)), 0.16);
  writeFileSync(path.join(OUT_DIR, "family_ref.wav"), encodeWavPcm16(familyRefPcm, TARGET_SR));

  // 3. 加载真实歌曲与真实多说话人素材，并提取 2 条真实纯伴奏轨
  const songFiles = {
    "qi-feng-le": loadWav16k(path.join(RAW_SOURCES_DIR, "qi-feng-le-zh.wav")),
    "piao-yang": loadWav16k(path.join(RAW_SOURCES_DIR, "piao-yang-guo-hai-lai-kan-ni.wav")),
    "audio-example": loadWav16k(path.join(RAW_SOURCES_DIR, "audio_example.wav")),
  };
  const fourSpeakersZh = loadWav16k(path.join(RAW_SOURCES_DIR, "0-four-speakers-zh.wav"));
  const realAcc1 = extractRealAccompaniment(
    path.join(RAW_SOURCES_DIR, "qi-feng-le-zh.wav"),
    path.join(TTS_CACHE_DIR, "_accompaniment_qifengle.wav"),
  );
  const realAcc2 = extractRealAccompaniment(
    path.join(RAW_SOURCES_DIR, "piao-yang-guo-hai-lai-kan-ni.wav"),
    path.join(TTS_CACHE_DIR, "_accompaniment_piaoyang.wav"),
  );

  // 4. 逐条混音生成 100 条 16kHz PCM WAV 并构建严格标注清单
  const manifest: ClipManifestEntry[] = [];
  const PRIMARY_SPEECH_RMS = 0.16;

  for (let i = 0; i < recipes.length; i += 1) {
    const r = recipes[i]!;
    const rng = new SeededRng(20261125 + i * 7919);

    // 4a. 解码每个说话人的音频并确定精准起止时间
    const decodedSpeakers: Array<{
      spec: SpeakerSegmentSpec;
      pcm: Float32Array;
      startSample: number;
      endSample: number;
    }> = [];

    let maxEndSample = Math.round((r.minDurationSec ?? 2.6) * TARGET_SR);
    for (const spk of r.speakers) {
      const wavPath = jobMap.get(hashKey(spk.voice, spk.text, spk.rate ?? 1.0))!.outPath;
      const trimmed = trimSilenceEdges(loadWav16k(wavPath));
      const gainLinear = Math.pow(10, (spk.gainDb ?? 0) / 20);
      const scaled = normalizeRms(trimmed, PRIMARY_SPEECH_RMS * gainLinear);
      const startSample = Math.round(spk.offsetSec * TARGET_SR);
      const endSample = startSample + scaled.length;
      if (endSample + Math.round(0.45 * TARGET_SR) > maxEndSample) {
        maxEndSample = endSample + Math.round(0.45 * TARGET_SR);
      }
      decodedSpeakers.push({ spec: spk, pcm: scaled, startSample, endSample });
    }

    const totalSamples = maxEndSample;
    const speechMix = new Float32Array(totalSamples);

    // 检测是否存在时间重叠的并发说话人
    let overlappingSpeakers = false;
    for (let a = 0; a < decodedSpeakers.length; a += 1) {
      for (let b = a + 1; b < decodedSpeakers.length; b += 1) {
        const sa = decodedSpeakers[a]!;
        const sb = decodedSpeakers[b]!;
        const overlap = Math.min(sa.endSample, sb.endSample) - Math.max(sa.startSample, sb.startSample);
        if (overlap > TARGET_SR * 0.2) {
          overlappingSpeakers = true;
        }
      }
    }

    for (const d of decodedSpeakers) {
      for (let k = 0; k < d.pcm.length && d.startSample + k < totalSamples; k += 1) {
        speechMix[d.startSample + k] = speechMix[d.startSample + k]! + d.pcm[k]!;
      }
    }

    // 4b. 构建背景轨（歌曲演唱 / 纯伴奏 BGM / 各类环境噪声）
    const bgMix = new Float32Array(totalSamples);
    let hasBgTrack = false;

    if (r.hasSong && r.songSource) {
      const songSlice = sliceLoop(songFiles[r.songSource], r.songOffsetSec ?? 1.0, totalSamples);
      const normSong = normalizeRms(songSlice, 0.14);
      for (let k = 0; k < totalSamples; k += 1) bgMix[k] = bgMix[k]! + normSong[k]!;
      hasBgTrack = true;
    } else if (r.hasBgm && r.bgmKind) {
      let bgmWave: Float32Array;
      if (r.bgmKind === "real_accompaniment_1") {
        bgmWave = sliceLoop(realAcc1, rng.uniform(0, 12), totalSamples);
      } else if (r.bgmKind === "real_accompaniment_2") {
        bgmWave = sliceLoop(realAcc2, rng.uniform(0, 12), totalSamples);
      } else {
        bgmWave = synthProceduralBgm(r.bgmKind, totalSamples, rng);
      }
      const normBgm = normalizeRms(bgmWave, 0.14);
      for (let k = 0; k < totalSamples; k += 1) bgMix[k] = bgMix[k]! + normBgm[k]!;
      hasBgTrack = true;
    }

    if (r.noiseType !== "none") {
      const noiseWave = synthEnvironmentalNoise(r.noiseType, totalSamples, rng, fourSpeakersZh);
      for (let k = 0; k < totalSamples; k += 1) bgMix[k] = bgMix[k]! + noiseWave[k]!;
      hasBgTrack = true;
    }

    // 4c. 精确按目标 SNR（基于活跃目标说话人语音段 RMS vs 同段背景 RMS）混音
    const finalMix = new Float32Array(totalSamples);
    if (hasBgTrack) {
      let targetBgRms = 0.14;
      if (decodedSpeakers.length > 0 && r.snrDb !== null) {
        // 以主说话人（若是 Neo 指令则取 Neo 说话人，否则取首位说话人）活跃区间的 RMS 对齐 SNR
        const refSpk = decodedSpeakers.find((d) => d.spec.isNeoSpeaker) ?? decodedSpeakers[0]!;
        const refSpeechRms = computeRms(refSpk.pcm);
        const bgDuringRef = bgMix.subarray(
          Math.max(0, refSpk.startSample),
          Math.min(totalSamples, refSpk.endSample),
        );
        const bgLocalRms = computeRms(bgDuringRef);
        const desiredBgRms = refSpeechRms / Math.pow(10, r.snrDb / 20);
        const scale = bgLocalRms > 1e-6 ? desiredBgRms / bgLocalRms : 1;
        for (let k = 0; k < totalSamples; k += 1) {
          finalMix[k] = softLimit(speechMix[k]! + bgMix[k]! * scale);
        }
      } else {
        const bgScaled = normalizeRms(bgMix, targetBgRms);
        for (let k = 0; k < totalSamples; k += 1) {
          finalMix[k] = softLimit(speechMix[k]! + bgScaled[k]!);
        }
      }
    } else {
      // 极轻自然底噪 (-55dB) 贴近真实麦克风采集
      for (let k = 0; k < totalSamples; k += 1) {
        finalMix[k] = softLimit(speechMix[k]! + 0.0005 * rng.gaussian());
      }
    }

    const filename = `audio/${r.id}.wav`;
    writeFileSync(path.join(OUT_DIR, filename), encodeWavPcm16(finalMix, TARGET_SR));

    const neoSpk = decodedSpeakers.find((d) => d.spec.isNeoSpeaker);
    const distractors = decodedSpeakers.filter((d) => !d.spec.isNeoSpeaker).map((d) => d.spec.text);

    manifest.push({
      id: r.id,
      index: i + 1,
      filename,
      durationSec: Number((totalSamples / TARGET_SR).toFixed(3)),
      sampleRate: TARGET_SR,
      isNeoCommand: r.isNeoCommand,
      category: r.category,
      soundTypes: r.soundTypes,
      hasBgm: r.hasBgm,
      hasSong: r.hasSong,
      noiseType: r.noiseType,
      speakerCount: decodedSpeakers.length,
      overlappingSpeakers,
      snrDb: r.snrDb,
      dialogState: r.dialogState,
      recentHistory: r.recentHistory ?? [],
      ...(r.lastSpokenReply ? { lastSpokenReply: r.lastSpokenReply } : {}),
      targetTranscript: neoSpk ? neoSpk.spec.text : (decodedSpeakers[0]?.spec.text ?? ""),
      distractorTranscript: distractors.join(" | "),
      expectedCommand: r.expectedCommand,
      expectedCommandKeywords: r.expectedCommandKeywords,
      expectedWokeOnly: Boolean(r.expectedWokeOnly),
      speakers: decodedSpeakers.map((d) => ({
        speakerId: d.spec.speakerId,
        voice: d.spec.voice,
        role: d.spec.role,
        startSec: Number((d.startSample / TARGET_SR).toFixed(3)),
        endSec: Number((d.endSample / TARGET_SR).toFixed(3)),
        text: d.spec.text,
        isNeoSpeaker: d.spec.isNeoSpeaker,
      })),
      notes: r.notes,
    });
  }

  // 5. 写出 manifest.json 与人类可直接查阅的 labels.csv
  writeFileSync(path.join(OUT_DIR, "manifest.json"), JSON.stringify({
    version: 1,
    generatedAt: new Date().toISOString(),
    totalClips: manifest.length,
    neoCommandCount: manifest.filter((m) => m.isNeoCommand).length,
    nonNeoCount: manifest.filter((m) => !m.isNeoCommand).length,
    ownerRefWav: "owner_ref.wav",
    familyRefWav: "family_ref.wav",
    categories: Object.fromEntries(
      (["clean_no_bgm", "song_singing", "instrumental_bgm", "ambient_noise", "multi_speaker", "conversation_scenes"] as ScenarioCategory[]).map(
        (cat) => {
          const items = manifest.filter((m) => m.category === cat);
          return [
            cat,
            {
              total: items.length,
              neo: items.filter((m) => m.isNeoCommand).length,
              nonNeo: items.filter((m) => !m.isNeoCommand).length,
            },
          ];
        },
      ),
    ),
    clips: manifest,
  }, null, 2), "utf8");

  const csvHeader = [
    "id",
    "filename",
    "is_neo_command",
    "category",
    "sound_types",
    "has_bgm",
    "has_song",
    "noise_type",
    "speaker_count",
    "overlapping_speakers",
    "snr_db",
    "dialog_state",
    "duration_sec",
    "target_transcript",
    "expected_command",
    "expected_woke_only",
    "distractor_transcript",
    "notes",
  ].join(",");
  const csvRows = manifest.map((m) =>
    [
      m.id,
      m.filename,
      String(m.isNeoCommand),
      m.category,
      m.soundTypes.join("|"),
      String(m.hasBgm),
      String(m.hasSong),
      m.noiseType,
      String(m.speakerCount),
      String(m.overlappingSpeakers),
      m.snrDb === null ? "" : String(m.snrDb),
      m.dialogState,
      String(m.durationSec),
      m.targetTranscript,
      m.expectedCommand,
      String(m.expectedWokeOnly),
      m.distractorTranscript,
      m.notes,
    ]
      .map(csvEscape)
      .join(","),
  );
  writeFileSync(path.join(OUT_DIR, "labels.csv"), "\uFEFF" + [csvHeader, ...csvRows].join("\n"), "utf8");

  console.log(`\n[Dataset] Successfully generated ${manifest.length} labeled WAV clips!`);
  console.log(`  Neo commands: ${manifest.filter((m) => m.isNeoCommand).length}`);
  console.log(`  Non-Neo clips: ${manifest.filter((m) => !m.isNeoCommand).length}`);
  console.log(`  Manifest: ${path.join(OUT_DIR, "manifest.json")}`);
  console.log(`  Labels CSV: ${path.join(OUT_DIR, "labels.csv")}`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("[Dataset] Generation failed:", err);
    process.exit(1);
  });
}
