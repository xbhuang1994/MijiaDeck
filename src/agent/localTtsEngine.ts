// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * 本地离线温柔女声神经 TTS 引擎（基于 sherpa-onnx-node Matcha-TTS + Vocos 声码器）：
 * - 主音色 `gentle-zh-en`（matcha-icefall-zh-en + vocos-16khz-univ）：温柔柔和、细腻悦耳的中英女声，RTF ~0.10
 * - 备选音色 `warm-zh-baker`（matcha-icefall-zh-baker + vocos-22khz-univ）：知性清晰 22kHz 普通话女声，RTF ~0.12
 * - 内置中文/中英混合口语规范化（百分比、温度、单位与常见英文词）、淡入淡出防爆音、首部 35ms 静音防蓝牙截断、
 *   内存 LRU WAV 缓存与唤醒回复短语预热（实测命中缓存 <2ms，首次合成短句 ~100ms）。
 */

import { existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { projectRoot } from "../core/appMeta.ts";
import { encodeWavPcm16 } from "./audioPcm.ts";

export type TtsEngineMode = "auto" | "local" | "browser";
export type TtsVoicePreset = "gentle-zh-en" | "warm-zh-baker";

export const DEFAULT_TTS_ENGINE: TtsEngineMode = "auto";
export const DEFAULT_TTS_VOICE: TtsVoicePreset = "gentle-zh-en";
export const DEFAULT_TTS_SPEED = 0.98;

export interface TtsVoicePresetInfo {
  id: TtsVoicePreset;
  label: string;
  description: string;
  modelDirName: string;
  vocoderFileName: string;
}

export const TTS_VOICE_PRESETS: ReadonlyArray<TtsVoicePresetInfo> = [
  {
    id: "gentle-zh-en",
    label: "柔美轻柔女声（中英双语 · 推荐）",
    description: "温柔细腻、柔和悦耳的神经女声，支持中英混读，离线响应约 100~350ms",
    modelDirName: "matcha-icefall-zh-en",
    vocoderFileName: "vocos-16khz-univ.onnx",
  },
  {
    id: "warm-zh-baker",
    label: "知性温暖女声（普通话 22kHz）",
    description: "清晰温润的 22kHz 高采样率普通话女声，咬字自然流畅",
    modelDirName: "matcha-icefall-zh-baker",
    vocoderFileName: "vocos-22khz-univ.onnx",
  },
];

export const TTS_MODEL_URLS = {
  matchaZhEnTar:
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/matcha-icefall-zh-en.tar.bz2",
  vocos16k:
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/vocoder-models/vocos-16khz-univ.onnx",
  matchaZhBakerTar:
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/matcha-icefall-zh-baker.tar.bz2",
  vocos22k:
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/vocoder-models/vocos-22khz-univ.onnx",
} as const;

export interface LocalTtsModelPaths {
  modelsDir: string;
  zhEnDir: string;
  zhEnModel: string;
  zhEnLexicon: string;
  zhEnEnLexicon: string;
  zhEnTokens: string;
  zhEnPhoneFst: string;
  zhEnDateFst: string;
  zhEnNumberFst: string;
  vocos16k: string;
  zhBakerDir: string;
  zhBakerModel: string;
  zhBakerLexicon: string;
  zhBakerTokens: string;
  zhBakerPhoneFst: string;
  zhBakerDateFst: string;
  zhBakerNumberFst: string;
  vocos22k: string;
}

export interface LocalTtsStatus {
  addonAvailable: boolean;
  ready: boolean;
  readyVoices: TtsVoicePreset[];
  activeVoice: TtsVoicePreset | null;
  modelsDir: string;
  models: {
    matchaZhEn: boolean;
    vocos16k: boolean;
    matchaZhBaker: boolean;
    vocos22k: boolean;
  };
  downloading: boolean;
  lastError: string | null;
}

export interface LocalTtsSynthesisResult {
  wav: Uint8Array;
  sampleRate: number;
  durationSec: number;
  voice: TtsVoicePreset;
  speed: number;
  latencyMs: number;
  cached: boolean;
  normalizedText: string;
}

interface OfflineTtsHandleLike {
  sampleRate: number;
  numSpeakers: number;
  generateAsync(req: { text: string; sid?: number; speed?: number }): Promise<{
    samples: Float32Array;
    sampleRate: number;
  }>;
  generate?(req: { text: string; sid?: number; speed?: number }): {
    samples: Float32Array;
    sampleRate: number;
  };
}

interface SherpaTtsModuleLike {
  OfflineTts?: {
    createAsync(cfg: Record<string, unknown>): Promise<OfflineTtsHandleLike>;
  };
}

let cachedSherpaTts: SherpaTtsModuleLike | null | undefined;

function loadSherpaTtsModule(): SherpaTtsModuleLike | null {
  if (cachedSherpaTts !== undefined) {
    return cachedSherpaTts;
  }
  try {
    const req = createRequire(import.meta.url);
    const mod = req("sherpa-onnx-node") as SherpaTtsModuleLike;
    if (mod && typeof mod.OfflineTts?.createAsync === "function") {
      cachedSherpaTts = mod;
      return cachedSherpaTts;
    }
  } catch {
    // 缺少原生模块时自动降级浏览器女声
  }
  cachedSherpaTts = null;
  return null;
}

export function resolveLocalTtsPaths(modelsDirOverride?: string): LocalTtsModelPaths {
  const envDir = process.env.MIJIADECK_VOICE_MODELS_DIR?.trim();
  const modelsDir = path.resolve(
    modelsDirOverride || envDir || path.join(projectRoot(), "voice_models"),
  );
  const zhEnDir = path.join(modelsDir, "matcha-icefall-zh-en");
  const zhBakerDir = path.join(modelsDir, "matcha-icefall-zh-baker");
  return {
    modelsDir,
    zhEnDir,
    zhEnModel: path.join(zhEnDir, "model-steps-3.onnx"),
    zhEnLexicon: path.join(zhEnDir, "lexicon.txt"),
    zhEnEnLexicon: path.join(zhEnDir, "lexicon-us-en.txt"),
    zhEnTokens: path.join(zhEnDir, "tokens.txt"),
    zhEnPhoneFst: path.join(zhEnDir, "phone-zh.fst"),
    zhEnDateFst: path.join(zhEnDir, "date-zh.fst"),
    zhEnNumberFst: path.join(zhEnDir, "number-zh.fst"),
    vocos16k: path.join(modelsDir, "vocos-16khz-univ.onnx"),
    zhBakerDir,
    zhBakerModel: path.join(zhBakerDir, "model-steps-3.onnx"),
    zhBakerLexicon: path.join(zhBakerDir, "lexicon.txt"),
    zhBakerTokens: path.join(zhBakerDir, "tokens.txt"),
    zhBakerPhoneFst: path.join(zhBakerDir, "phone.fst"),
    zhBakerDateFst: path.join(zhBakerDir, "date.fst"),
    zhBakerNumberFst: path.join(zhBakerDir, "number.fst"),
    vocos22k: path.join(modelsDir, "vocos-22khz-univ.onnx"),
  };
}

export function normalizeTtsVoice(
  value: unknown,
  fallback: TtsVoicePreset = DEFAULT_TTS_VOICE,
): TtsVoicePreset {
  if (typeof value !== "string") return fallback;
  const v = value.trim().toLowerCase();
  if (v === "gentle-zh-en" || v === "warm-zh-baker") return v;
  return fallback;
}

export function normalizeTtsSpeed(value: unknown, fallback: number = DEFAULT_TTS_SPEED): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Number(Math.min(1.4, Math.max(0.7, n)).toFixed(2));
}

const MAX_TTS_TEXT_CHARS = 180;

/**
 * 将回复文本规范化为适合本地 Matcha-TTS 朗读的温柔自然口语文本：
 * - 清理 Markdown、设备 ID、表情符号与多余符号
 * - 将 `%`、`°C`/`℃`、`K`、`dB` 等符号转为中文口语读法，避免 OOV 漏读
 * - 对中英混排自动补空格并规范常见智能家居英文词，防止漏读或生硬卡顿
 */
export function normalizeTextForLocalTts(
  rawText: string,
  voice: TtsVoicePreset = DEFAULT_TTS_VOICE,
): string {
  let text = String(rawText ?? "")
    .replace(/\[did=[^\]]*\]/gi, "")
    .replace(/\[id=[^\]]*\]/gi, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```[^\n]*\n?|```/g, ""))
    .replace(/^\s*[-•*]\s+/gm, "")
    .replace(/\*\*|\*|`|[「」『』【】]|#+/g, "")
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "")
    .replace(/\r?\n+/g, "，")
    .trim();

  if (!text) return "";

  // 常见单位与符号口语化（Matcha 词典无 '%' 与 '°C'）
  text = text
    .replace(/(\d+(?:\.\d+)?)\s*%/g, "百分之$1")
    .replace(/(\d+(?:\.\d+)?)\s*(?:°\s*[Cc]|℃)/g, "$1度")
    .replace(/°\s*[Cc]|℃/g, "度")
    .replace(/(\d{3,4})\s*[Kk]\b/g, "$1开")
    .replace(/(\d+(?:\.\d+)?)\s*dB\b/gi, "$1分贝")
    .replace(/\bPM\s*2\.5\b/gi, "空气指数")
    .replace(/\bWi-?Fi\b/gi, "无线网")
    .replace(/(\d+)\s*\/\s*(\d+)\s*台/g, "$1台，共$2台");

  // 常见唤醒词与产品英文词处理
  if (voice === "warm-zh-baker") {
    text = text
      .replace(/\bPi\s*Agent\b/gi, "小派助手")
      .replace(/\bMijiaDeck\b/gi, "米家桌面端")
      .replace(/\bNeo\b/gi, "尼奥")
      .replace(/\bPro\b/gi, "专业版")
      .replace(/\bMax\b/gi, "增强版")
      .replace(/\bMini\b/gi, "迷你")
      .replace(/\bLite\b/gi, "青春版")
      .replace(/\bPlus\b/gi, "加强版")
      .replace(/\bAir\b/gi, "轻享版")
      .replace(/\bOK\b/gi, "好的")
      .replace(/\bhello\b/gi, "你好")
      .replace(/\bhi\b/gi, "嗨");
  } else {
    // gentle-zh-en 挂载了 lexicon-us-en.txt（词条均为小写），补齐少量词典外专有名词并隔离中英边界
    text = text
      .replace(/\bMijiaDeck\b/gi, "米家桌面端")
      .replace(/\bNeo\b/gi, "尼奥")
      .replace(/([\u4e00-\u9fff])([A-Za-z])/g, "$1 $2")
      .replace(/([A-Za-z])([\u4e00-\u9fff])/g, "$1 $2")
      .replace(/[A-Za-z]+/g, (word) => word.toLowerCase());
  }

  // 规范标点：保留中文疑问语气（如“嗯?” -> “嗯？”）
  text = text
    .replace(/\?/g, "？")
    .replace(/!/g, "！")
    .replace(/,/g, "，")
    .replace(/;/g, "；")
    .replace(/\s+/g, " ")
    .replace(/([。！？；，、])\s*，+/g, "$1")
    .replace(/，{2,}/g, "，")
    .replace(/^[，,\s]+|[，,\s]+$/g, "")
    .trim();

  if (text.length > MAX_TTS_TEXT_CHARS) {
    const head = text.slice(0, MAX_TTS_TEXT_CHARS);
    const cut = Math.max(head.lastIndexOf("。"), head.lastIndexOf("，"), head.lastIndexOf("；"));
    text = (cut >= 32 ? head.slice(0, cut) : head).trim();
  }

  return text;
}

/**
 * 柔和音频后处理：
 * 1. 前置 35ms 极短静音缓冲，避免 USB/蓝牙声卡刚唤醒时吞掉首字（尤其是“嗯？”等单字应答）
 * 2. 柔化峰值归一化（目标峰值 0.88，避免破音或音量过小）
 * 3. 首尾 8ms / 18ms 线性淡入淡出，消除起止爆音
 */
export function postProcessTtsSamples(raw: Float32Array, sampleRate: number): Float32Array {
  if (raw.length === 0) return raw;

  let peak = 0;
  for (let i = 0; i < raw.length; i += 1) {
    const a = Math.abs(raw[i] ?? 0);
    if (a > peak) peak = a;
  }

  const targetPeak = 0.88;
  const gain = peak > 1e-4 ? Math.min(2.2, targetPeak / peak) : 1;

  const leadSamples = Math.round(sampleRate * 0.035);
  const tailSamples = Math.round(sampleRate * 0.02);
  const out = new Float32Array(leadSamples + raw.length + tailSamples);

  const fadeIn = Math.min(Math.round(sampleRate * 0.008), raw.length);
  const fadeOut = Math.min(Math.round(sampleRate * 0.018), raw.length);

  for (let i = 0; i < raw.length; i += 1) {
    let s = (raw[i] ?? 0) * gain;
    if (i < fadeIn) {
      s *= i / Math.max(1, fadeIn);
    }
    const fromEnd = raw.length - 1 - i;
    if (fromEnd < fadeOut) {
      s *= fromEnd / Math.max(1, fadeOut);
    }
    out[leadSamples + i] = Math.max(-0.98, Math.min(0.98, s));
  }

  return out;
}

const MAX_CACHE_ENTRIES = 48;

export class LocalTtsEngine {
  private readonly _modelsDirOverride?: string;
  private readonly _instances = new Map<TtsVoicePreset, Promise<OfflineTtsHandleLike>>();
  private readonly _cache = new Map<
    string,
    { wav: Uint8Array; sampleRate: number; durationSec: number; voice: TtsVoicePreset }
  >();
  private _downloading = false;
  private _lastError: string | null = null;
  private _activeVoice: TtsVoicePreset | null = null;
  private _disposed = false;

  constructor(options: { modelsDir?: string } = {}) {
    this._modelsDirOverride = options.modelsDir;
  }

  get paths(): LocalTtsModelPaths {
    return resolveLocalTtsPaths(this._modelsDirOverride);
  }

  getStatus(): LocalTtsStatus {
    const sherpa = loadSherpaTtsModule();
    const p = this.paths;
    const matchaZhEn =
      existsSync(p.zhEnModel) && existsSync(p.zhEnLexicon) && existsSync(p.zhEnTokens);
    const vocos16k = existsSync(p.vocos16k);
    const matchaZhBaker =
      existsSync(p.zhBakerModel) && existsSync(p.zhBakerLexicon) && existsSync(p.zhBakerTokens);
    const vocos22k = existsSync(p.vocos22k);
    const addonAvailable = sherpa !== null;

    const readyVoices: TtsVoicePreset[] = [];
    if (addonAvailable && matchaZhEn && vocos16k) readyVoices.push("gentle-zh-en");
    if (addonAvailable && matchaZhBaker && vocos22k) readyVoices.push("warm-zh-baker");

    return {
      addonAvailable,
      ready: readyVoices.length > 0,
      readyVoices,
      activeVoice: this._activeVoice ?? readyVoices[0] ?? null,
      modelsDir: p.modelsDir,
      models: {
        matchaZhEn,
        vocos16k,
        matchaZhBaker,
        vocos22k,
      },
      downloading: this._downloading,
      lastError: this._lastError,
    };
  }

  resolveAvailableVoice(preferred: TtsVoicePreset = DEFAULT_TTS_VOICE): TtsVoicePreset | null {
    const status = this.getStatus();
    if (!status.ready) return null;
    if (status.readyVoices.includes(preferred)) return preferred;
    return status.readyVoices[0] ?? null;
  }

  private async _getInstance(voice: TtsVoicePreset): Promise<OfflineTtsHandleLike> {
    const existing = this._instances.get(voice);
    if (existing) return existing;

    const sherpa = loadSherpaTtsModule();
    if (!sherpa?.OfflineTts) {
      throw new Error("sherpa-onnx-node OfflineTts 不可用");
    }

    const p = this.paths;
    const threads = Math.max(2, Math.min(4, Math.floor((os.cpus()?.length ?? 4) / 2)));

    let cfg: Record<string, unknown>;
    if (voice === "gentle-zh-en") {
      const lexicons = [p.zhEnLexicon];
      if (existsSync(p.zhEnEnLexicon)) {
        lexicons.push(p.zhEnEnLexicon);
      }
      const fsts = [p.zhEnPhoneFst, p.zhEnDateFst, p.zhEnNumberFst].filter((f) => existsSync(f));
      cfg = {
        model: {
          matcha: {
            acousticModel: p.zhEnModel,
            vocoder: p.vocos16k,
            lexicon: lexicons.join(","),
            tokens: p.zhEnTokens,
            noiseScale: 0.667,
            lengthScale: 1.0,
          },
          numThreads: threads,
          provider: "cpu",
          debug: 0,
        },
        ...(fsts.length > 0 ? { ruleFsts: fsts.join(",") } : {}),
        maxNumSentences: 1,
      };
    } else {
      const fsts = [p.zhBakerPhoneFst, p.zhBakerDateFst, p.zhBakerNumberFst].filter((f) =>
        existsSync(f),
      );
      cfg = {
        model: {
          matcha: {
            acousticModel: p.zhBakerModel,
            vocoder: p.vocos22k,
            lexicon: p.zhBakerLexicon,
            tokens: p.zhBakerTokens,
            noiseScale: 0.667,
            lengthScale: 1.0,
          },
          numThreads: threads,
          provider: "cpu",
          debug: 0,
        },
        ...(fsts.length > 0 ? { ruleFsts: fsts.join(",") } : {}),
        maxNumSentences: 1,
      };
    }

    const promise = sherpa.OfflineTts.createAsync(cfg)
      .then((handle) => {
        this._activeVoice = voice;
        return handle;
      })
      .catch((err) => {
        this._instances.delete(voice);
        this._lastError = err instanceof Error ? err.message : String(err);
        throw err;
      });

    this._instances.set(voice, promise);
    return promise;
  }

  /**
   * 合成自然温柔女声 WAV 音频（命中 LRU 缓存时 <2ms 返回）。
   */
  async synthesizeWav(
    rawText: string,
    options: { voice?: TtsVoicePreset; speed?: number } = {},
  ): Promise<LocalTtsSynthesisResult> {
    const t0 = performance.now();
    const requestedVoice = normalizeTtsVoice(options.voice, DEFAULT_TTS_VOICE);
    const voice = this.resolveAvailableVoice(requestedVoice);
    if (!voice) {
      throw new Error("本地离线温柔女声模型尚未安装，请点击「一键补齐模型」或改用浏览器女声");
    }

    const speed = normalizeTtsSpeed(options.speed, DEFAULT_TTS_SPEED);
    const normalizedText = normalizeTextForLocalTts(rawText, voice);
    if (!normalizedText) {
      throw new Error("播报文本为空");
    }

    const cacheKey = `${voice}|${speed.toFixed(2)}|${normalizedText}`;
    const hit = this._cache.get(cacheKey);
    if (hit) {
      // Refresh LRU recency
      this._cache.delete(cacheKey);
      this._cache.set(cacheKey, hit);
      return {
        wav: hit.wav,
        sampleRate: hit.sampleRate,
        durationSec: hit.durationSec,
        voice: hit.voice,
        speed,
        latencyMs: Math.round(performance.now() - t0),
        cached: true,
        normalizedText,
      };
    }

    const tts = await this._getInstance(voice);
    const generated = await tts.generateAsync({
      text: normalizedText,
      sid: 0,
      speed,
    });
    if (!generated?.samples || generated.samples.length === 0) {
      throw new Error("本地 TTS 未生成有效音频帧");
    }

    const processed = postProcessTtsSamples(generated.samples, generated.sampleRate);
    const wav = encodeWavPcm16(processed, generated.sampleRate);
    const durationSec = Number((processed.length / generated.sampleRate).toFixed(3));

    if (this._cache.size >= MAX_CACHE_ENTRIES) {
      const oldestKey = this._cache.keys().next().value;
      if (oldestKey !== undefined) {
        this._cache.delete(oldestKey);
      }
    }
    this._cache.set(cacheKey, {
      wav,
      sampleRate: generated.sampleRate,
      durationSec,
      voice,
    });

    return {
      wav,
      sampleRate: generated.sampleRate,
      durationSec,
      voice,
      speed,
      latencyMs: Math.round(performance.now() - t0),
      cached: false,
      normalizedText,
    };
  }

  /**
   * 后台预加载神经女声模型并预热常用短句（如唤醒回复短语“嗯?”），让首次触发几乎零延迟。
   */
  async warmup(options: {
    voice?: TtsVoicePreset;
    speed?: number;
    prewarmTexts?: ReadonlyArray<string>;
  } = {}): Promise<void> {
    if (this._disposed) return;
    const voice = this.resolveAvailableVoice(options.voice ?? DEFAULT_TTS_VOICE);
    if (!voice) return;
    try {
      await this._getInstance(voice);
      if (this._disposed) return;
      const speed = normalizeTtsSpeed(options.speed, DEFAULT_TTS_SPEED);
      const texts = options.prewarmTexts ?? [];
      for (const raw of texts) {
        if (this._disposed) return;
        const t = raw.trim();
        if (!t) continue;
        await this.synthesizeWav(t, { voice, speed });
      }
    } catch {
      // 预热失败不阻塞主流程
    }
  }

  /**
   * 下载缺失的默认温柔女声模型（matcha-icefall-zh-en + vocos-16khz-univ）。
   */
  async downloadMissingModels(): Promise<LocalTtsStatus> {
    if (this._downloading) return this.getStatus();
    this._downloading = true;
    this._lastError = null;
    const p = this.paths;
    try {
      mkdirSync(p.modelsDir, { recursive: true });

      const fetchFile = async (url: string, dest: string) => {
        if (existsSync(dest)) return;
        const part = `${dest}.part`;
        const res = await fetch(url, { redirect: "follow" });
        if (!res.ok) {
          throw new Error(`下载 TTS 模型失败 (${res.status}): ${path.basename(dest)}`);
        }
        const buf = await res.arrayBuffer();
        await Bun.write(part, buf);
        renameSync(part, dest);
      };

      await fetchFile(TTS_MODEL_URLS.vocos16k, p.vocos16k);
      if (!existsSync(p.zhEnModel) || !existsSync(p.zhEnLexicon) || !existsSync(p.zhEnTokens)) {
        const tarPath = path.join(p.modelsDir, "matcha-icefall-zh-en.tar.bz2");
        try {
          await fetchFile(TTS_MODEL_URLS.matchaZhEnTar, tarPath);
          const proc = Bun.spawn(["tar", "-xjf", tarPath, "-C", p.modelsDir], {
            stdout: "ignore",
            stderr: "pipe",
          });
          const code = await proc.exited;
          if (code !== 0) {
            const errText = await new Response(proc.stderr).text();
            throw new Error(`解压 Matcha 女声模型失败: ${errText.trim() || code}`);
          }
        } finally {
          try {
            if (existsSync(tarPath)) unlinkSync(tarPath);
          } catch {
            // ignore
          }
        }
      }
    } catch (err) {
      this._lastError = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      this._downloading = false;
    }
    return this.getStatus();
  }

  dispose(): void {
    this._disposed = true;
    this._instances.clear();
    this._cache.clear();
    this._activeVoice = null;
  }
}
