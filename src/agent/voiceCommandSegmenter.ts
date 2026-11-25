// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * 借鉴 Home Assistant Core (`homeassistant/components/assist_pipeline/vad.py`、
 * `audio_enhancer.py`、`run.py`) 设计的低延迟、抗背景音乐语音分段器、流式软限幅 AGC
 * 与唤醒词防重复冷却保护器：
 *
 * 1. `VadSensitivity` + `VoiceCommandSegmenter`：
 *    - 双阈值滞回（`beforeCommandSpeechThreshold` / `inCommandSpeechThreshold`）；
 *    - `resetSeconds` 防尖峰静默重置机制：背景音乐鼓点、瞬态歌词峰或短暂环境杂音
 *      不会轻易清零句末静音倒计时，彻底解决持续背景音乐下 VAD 永远等满 4.2s 才切段的问题；
 *    - 自适应前景语音能量门限：在持续音乐底噪上追踪“前景说话人能量抬升 -> 回落至音乐底噪”
 *      的变化，实现背景音乐中说完指令后 ~550ms 即刻截断送识别！
 * 2. `StreamingAutoGain`（借鉴 Home Assistant `AudioSettings.auto_gain_dbfs`）：
 *    - 对远场低音量人声自动平滑增益至最佳识别电平，同时对高能量音乐软限幅绝不削波失真。
 * 3. `WakeWordCooldownGuard`（借鉴 Home Assistant `WAKE_WORD_COOLDOWN`）：
 *    - 防止滚动重叠窗口在 2s 内重复触发同一唤醒词。
 */

import { computeRms } from "./audioPcm.ts";

export type VadSensitivityMode = "aggressive" | "default" | "relaxed";

/**
 * 将 Home Assistant 风格 VAD 灵敏度档位与用户配置的尾静音时长映射为句末静音判定时长（秒）。
 * - aggressive: 0.30s（极速抢答，适合短设备指令）
 * - default:    严格尊重用户设置的 `fallbackSilenceMs`（允许 0.40s ~ 3.50s，默认 0.95s 兼顾慢语速自然停顿）
 * - relaxed:    >= 1.05s（允许较长句中思考停顿，同样尊重更高的用户配置）
 */
export function vadSensitivityToSeconds(
  sensitivity: VadSensitivityMode | string | undefined,
  fallbackSilenceMs?: number,
): number {
  if (sensitivity === "aggressive") return 0.30;
  if (sensitivity === "relaxed") {
    if (typeof fallbackSilenceMs === "number" && Number.isFinite(fallbackSilenceMs)) {
      return Math.max(1.05, Math.min(3.5, fallbackSilenceMs / 1000));
    }
    return 1.05;
  }
  if (typeof fallbackSilenceMs === "number" && Number.isFinite(fallbackSilenceMs)) {
    return Math.max(0.4, Math.min(3.5, fallbackSilenceMs / 1000));
  }
  return 0.95;
}

export interface VoiceCommandSegmenterOptions {
  /** 判定语音指令正式开始所需的累计语音时长（秒），默认 0.20s */
  speechSeconds?: number;
  /** 单条语音指令最小时长（秒），默认 0.65s */
  commandSeconds?: number;
  /** 判定语音指令结束所需的尾静音时长（秒），默认 0.55s */
  silenceSeconds?: number;
  /** 单条语音指令最大时长上限（秒），默认 5.5s */
  timeoutSeconds?: number;
  /** 需持续说话多久才重置尾静音倒计时（抗短暂音乐节拍/杂音尖峰），默认 0.24s */
  resetSeconds?: number;
  /** 进入指令前的语音概率门限（低门槛防吞首字），默认 0.25 */
  beforeCommandSpeechThreshold?: number;
  /** 指令进行中的语音概率门限（高门槛防音乐拖尾），默认 0.48 */
  inCommandSpeechThreshold?: number;
}

export interface VoiceCommandSegmenterStepResult {
  /** 指令是否仍在继续；false 表示本条指令刚刚结束（正常尾静音或超时） */
  continuing: boolean;
  /** 是否正处于有效指令区间内 */
  inCommand: boolean;
  /** 是否刚在本帧从 idle 跃迁到 inCommand */
  justStarted: boolean;
  /** 本帧结束是否由最大时长超时触发 */
  timedOut: boolean;
}

/**
 * Home Assistant `VoiceCommandSegmenter` 滞回状态机（TypeScript 实现，增加背景音乐自适应底噪感知）。
 */
export class VoiceCommandSegmenter {
  readonly speechSeconds: number;
  readonly commandSeconds: number;
  private _silenceSeconds: number;
  readonly timeoutSeconds: number;
  readonly resetSeconds: number;
  readonly beforeCommandSpeechThreshold: number;
  readonly inCommandSpeechThreshold: number;

  inCommand = false;
  timedOut = false;

  private _speechSecondsLeft = 0;
  private _commandSecondsLeft = 0;
  private _silenceSecondsLeft = 0;
  private _timeoutSecondsLeft = 0;
  private _resetSecondsLeft = 0;

  // 自适应背景音乐/底噪能量追踪（用于区分持续背景音乐 vs 前景近场说话人）
  private _ambientRmsFloor = 0.008;
  private _commandPeakRms = 0;
  private _idleRmsWindow: number[] = [];

  constructor(options: VoiceCommandSegmenterOptions = {}) {
    this.speechSeconds = Math.max(0.06, options.speechSeconds ?? 0.20);
    this.commandSeconds = Math.max(this.speechSeconds, options.commandSeconds ?? 0.65);
    this._silenceSeconds = Math.max(0.20, options.silenceSeconds ?? 0.95);
    this.timeoutSeconds = Math.max(1.5, options.timeoutSeconds ?? 30.0);
    this.resetSeconds = Math.max(0.08, options.resetSeconds ?? 0.24);
    this.beforeCommandSpeechThreshold = options.beforeCommandSpeechThreshold ?? 0.25;
    this.inCommandSpeechThreshold = options.inCommandSpeechThreshold ?? 0.48;
    this.reset();
  }

  get silenceSeconds(): number {
    return this._silenceSeconds;
  }

  setSilenceSeconds(seconds: number): void {
    if (!Number.isFinite(seconds)) return;
    this._silenceSeconds = Math.max(0.20, Math.min(5.0, seconds));
    if (!this.inCommand) {
      this._silenceSecondsLeft = this._silenceSeconds;
    }
  }

  get ambientRmsFloor(): number {
    return this._ambientRmsFloor;
  }

  reset(): void {
    this._speechSecondsLeft = this.speechSeconds;
    this._commandSecondsLeft = Math.max(0, this.commandSeconds - this.speechSeconds);
    this._silenceSecondsLeft = this._silenceSeconds;
    this._timeoutSecondsLeft = this.timeoutSeconds;
    this._resetSecondsLeft = this.resetSeconds;
    this.inCommand = false;
    this._commandPeakRms = 0;
    this._idleRmsWindow.length = 0;
  }

  /**
   * 由声学唤醒词（openWakeWord）强制进入指令捕获态（借鉴 Home Assistant WAKE_WORD -> STT 切换）：
   * 立即跳过前置语音累积，保证唤醒词后紧跟的短指令或慢语速长指令完整捕获，绝不在 4s 处强行截断。
   */
  forceStartCommand(initialPeakRms = 0.05): void {
    this.inCommand = true;
    this.timedOut = false;
    this._commandSecondsLeft = Math.max(0.45, this.commandSeconds - this.speechSeconds);
    this._silenceSecondsLeft = this._silenceSeconds;
    this._timeoutSecondsLeft = this.timeoutSeconds;
    this._resetSecondsLeft = this.resetSeconds;
    this._commandPeakRms = Math.max(initialPeakRms, this._ambientRmsFloor * 1.4);
    this._idleRmsWindow.length = 0;
  }

  /**
   * 喂入一帧语音概率与帧 RMS，返回滞回分段状态。
   * 当 `rawRms` 存在持续背景音乐底噪（例如 `ambientRmsFloor >= 0.015`）时，
   * 若前景语音能量显著抬升后又回落至音乐底噪附近，即便 Silero VAD 因歌声维持中等概率，
   * 也会识别为“前景人声已停顿”并平稳推进尾静音倒计时。
   */
  process(
    chunkSeconds: number,
    speechProbability: number | null,
    frameRms?: number,
  ): VoiceCommandSegmenterStepResult {
    if (this.timedOut) {
      this.timedOut = false;
    }

    const prob = speechProbability === null || !Number.isFinite(speechProbability) ? 0 : speechProbability;
    if (prob < 0) {
      return { continuing: true, inCommand: this.inCommand, justStarted: false, timedOut: false };
    }

    const rms = typeof frameRms === "number" && Number.isFinite(frameRms) ? frameRms : undefined;

    // 未在指令内时采用最小统计窗口跟踪持续背景底噪：
    // - 能量低于当前底噪时立即向下衰减；
    // - 向上抬升仅在非语音帧连续满 20 帧（~640ms）后取窗口最小值缓慢收敛，
    //   彻底杜绝安静房间起音阶段（Silero VAD 0.2~0.5s 触发延迟期间）将人声起音误算为音乐底噪！
    if (!this.inCommand && rms !== undefined) {
      if (rms < this._ambientRmsFloor) {
        this._ambientRmsFloor = Math.max(
          0.003,
          Math.min(0.14, this._ambientRmsFloor * 0.92 + rms * 0.08),
        );
      }
      if (prob <= this.beforeCommandSpeechThreshold) {
        this._idleRmsWindow.push(rms);
        if (this._idleRmsWindow.length > 20) {
          this._idleRmsWindow.shift();
        }
        if (this._idleRmsWindow.length >= 20) {
          let windowMin = this._idleRmsWindow[0]!;
          for (let i = 1; i < this._idleRmsWindow.length; i += 1) {
            if (this._idleRmsWindow[i]! < windowMin) {
              windowMin = this._idleRmsWindow[i]!;
            }
          }
          if (windowMin > this._ambientRmsFloor) {
            this._ambientRmsFloor = Math.max(
              0.003,
              Math.min(0.14, this._ambientRmsFloor * 0.92 + windowMin * 0.08),
            );
          }
        }
      } else {
        this._idleRmsWindow.length = 0;
      }
    }

    if (this.inCommand) {
      this._timeoutSecondsLeft -= chunkSeconds;
      if (this._timeoutSecondsLeft <= 0) {
        this.reset();
        this.timedOut = true;
        return { continuing: false, inCommand: false, justStarted: false, timedOut: true };
      }
    }

    if (!this.inCommand) {
      const isSpeech = prob > this.beforeCommandSpeechThreshold;
      if (isSpeech) {
        this._resetSecondsLeft = this.resetSeconds;
        this._speechSecondsLeft -= chunkSeconds;
        if (this._speechSecondsLeft <= 0) {
          this.inCommand = true;
          this._commandSecondsLeft = Math.max(0, this.commandSeconds - this.speechSeconds);
          this._silenceSecondsLeft = this.silenceSeconds;
          this._timeoutSecondsLeft = this.timeoutSeconds;
          this._commandPeakRms = rms ?? 0;
          this._idleRmsWindow.length = 0;
          return { continuing: true, inCommand: true, justStarted: true, timedOut: false };
        }
      } else {
        this._resetSecondsLeft -= chunkSeconds;
        if (this._resetSecondsLeft <= 0) {
          this._speechSecondsLeft = this.speechSeconds;
          this._resetSecondsLeft = this.resetSeconds;
        }
      }
      return { continuing: true, inCommand: false, justStarted: false, timedOut: false };
    }

    // 指令进行中：跟踪峰值并判断是否仍存在前景人声
    if (rms !== undefined && rms > this._commandPeakRms) {
      this._commandPeakRms = rms;
    }

    // 在高背景音乐环境下，仅当当前帧能量同时回落至环境底噪附近（<= floor * 1.32）
    // 且明显低于前景语音峰值（<= peak * 0.65）时，才判定前景人声已停顿，避免正常轻音节被误切。
    let effectiveInThreshold = this.inCommandSpeechThreshold;
    if (
      rms !== undefined &&
      this._ambientRmsFloor >= 0.015 &&
      this._commandPeakRms >= this._ambientRmsFloor * 1.45 &&
      rms <= this._ambientRmsFloor * 1.32 &&
      rms <= this._commandPeakRms * 0.65
    ) {
      effectiveInThreshold = Math.max(effectiveInThreshold, 0.78);
    }

    const isSpeech = prob > effectiveInThreshold;
    if (!isSpeech) {
      // 静音帧：重置“连续讲话确认”计时并消耗静音倒计时
      this._resetSecondsLeft = this.resetSeconds;
      this._silenceSecondsLeft -= chunkSeconds;
      this._commandSecondsLeft -= chunkSeconds;
      if (this._silenceSecondsLeft <= 0 && this._commandSecondsLeft <= 0) {
        this.reset();
        return { continuing: false, inCommand: false, justStarted: false, timedOut: false };
      }
    } else {
      // 讲话帧：只有持续满足 resetSeconds 才重置静音倒计时（过滤瞬态鼓点/爆音）
      this._resetSecondsLeft -= chunkSeconds;
      this._commandSecondsLeft -= chunkSeconds;
      if (this._resetSecondsLeft <= 0) {
        this._silenceSecondsLeft = this.silenceSeconds;
        this._resetSecondsLeft = this.resetSeconds;
      }
    }

    return { continuing: true, inCommand: true, justStarted: false, timedOut: false };
  }
}

export interface StreamingAutoGainOptions {
  /** 目标语音 RMS 电平（默认 0.085，约 -21 dBFS） */
  targetRms?: number;
  /** 最大增益倍数（默认 4.5x = +13 dB，避免把纯静音底噪拉爆） */
  maxGain?: number;
  /** 触发增益提升的最小信号门限（默认 0.004，纯数字静音不放大） */
  minActiveRms?: number;
  /** 增益平滑上升/下降速率 */
  attackRate?: number;
  releaseRate?: number;
}

/**
 * 轻量流式软限幅自动增益控制（借鉴 Home Assistant `AudioSettings.auto_gain_dbfs`）：
 * 当浏览器关闭粗糙 WebRTC AGC 以防音乐抽泵时，由服务端对远场轻声语音执行平滑增益与防削波限幅。
 */
export class StreamingAutoGain {
  private readonly _targetRms: number;
  private readonly _maxGain: number;
  private readonly _minActiveRms: number;
  private readonly _attackRate: number;
  private readonly _releaseRate: number;
  private _currentGain = 1.0;

  constructor(options: StreamingAutoGainOptions = {}) {
    this._targetRms = options.targetRms ?? 0.085;
    this._maxGain = Math.max(1, Math.min(8, options.maxGain ?? 4.5));
    this._minActiveRms = options.minActiveRms ?? 0.0045;
    this._attackRate = options.attackRate ?? 0.35;
    this._releaseRate = options.releaseRate ?? 0.08;
  }

  get currentGain(): number {
    return this._currentGain;
  }

  reset(): void {
    this._currentGain = 1.0;
  }

  process(samples: Float32Array): Float32Array {
    if (samples.length === 0) return samples;
    const rms = computeRms(samples);
    let desiredGain = 1.0;
    if (rms >= this._minActiveRms && rms < this._targetRms) {
      desiredGain = Math.min(this._maxGain, this._targetRms / rms);
    } else if (rms >= this._targetRms * 1.6) {
      desiredGain = Math.max(0.65, (this._targetRms * 1.6) / rms);
    }

    const rate = desiredGain < this._currentGain ? this._attackRate : this._releaseRate;
    const prevGain = this._currentGain;
    const nextGain = prevGain + (desiredGain - prevGain) * rate;
    this._currentGain = nextGain;

    if (Math.abs(nextGain - 1.0) < 0.03 && Math.abs(prevGain - 1.0) < 0.03) {
      return samples;
    }

    const out = new Float32Array(samples.length);
    const invLen = 1 / samples.length;
    for (let i = 0; i < samples.length; i += 1) {
      const g = prevGain + (nextGain - prevGain) * (i * invLen);
      const scaled = samples[i]! * g;
      // 软限幅（tanh 仅作用于 > 0.85 的高幅值，保持语音线性无失真）
      if (scaled > 0.85) {
        out[i] = 0.85 + 0.15 * Math.tanh((scaled - 0.85) / 0.15);
      } else if (scaled < -0.85) {
        out[i] = -0.85 + 0.15 * Math.tanh((scaled + 0.85) / 0.15);
      } else {
        out[i] = scaled;
      }
    }
    return out;
  }
}

/**
 * 唤醒词防重复冷却保护（借鉴 Home Assistant `assist_pipeline/run.py` `WAKE_WORD_COOLDOWN`）。
 */
export class WakeWordCooldownGuard {
  private readonly _cooldownMs: number;
  private readonly _lastAcceptedByWord = new Map<string, number>();

  constructor(cooldownMs = 1800) {
    this._cooldownMs = Math.max(0, cooldownMs);
  }

  /**
   * 尝试接受唤醒词；若同词条在冷却窗口内已触发则返回 false。
   */
  tryAccept(wakeWord: string, nowMs = Date.now()): boolean {
    const key = wakeWord.trim().toLowerCase();
    if (!key) return true;
    const last = this._lastAcceptedByWord.get(key);
    if (last !== undefined && nowMs >= last && nowMs - last < this._cooldownMs) {
      return false;
    }
    this._lastAcceptedByWord.set(key, nowMs);
    return true;
  }

  reset(): void {
    this._lastAcceptedByWord.clear();
  }
}
