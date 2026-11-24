// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * 语音监听状态机、唤醒词解析、Whisper 兼容 STT 转写与 Pi Agent 调度管线。
 */

import {
  isLocalEndpointUrl,
  resolveEffectiveSttAuth,
  type AgentVoiceConfig,
} from "../core/agentConfigStore.ts";
import { TypedEmitter } from "../core/contracts.ts";
import { createBoundedFetch, type FetchLike } from "../core/httpTimeout.ts";
import type { AgentToolCallRecord, PiAgentRunResult, PiAgentService } from "./piAgentService.ts";

export type VoiceListenMode = "idle" | "listening" | "awake" | "processing" | "speaking" | "error";

export interface VoiceTranscriptEntry {
  id: string;
  text: string;
  matched: boolean;
  wokeOnly: boolean;
  command: string;
  reply?: string;
  error?: string;
  timestamp: number;
}

export interface VoiceListenerSnapshot {
  active: boolean;
  mode: VoiceListenMode;
  engine: "browser" | "whisper" | "manual";
  interimTranscript: string;
  lastTranscript: string;
  lastCommand: string;
  awakeUntil: number | null;
  error: string | null;
  wakeWordEnabled: boolean;
  wakeWords: string[];
  autoSpeakReply: boolean;
  history: VoiceTranscriptEntry[];
}

export interface WakeMatchResult {
  matched: boolean;
  wokeOnly: boolean;
  wakeWord: string | null;
  command: string;
}

export interface HandleTranscriptOptions {
  isFinal?: boolean;
  bypassWakeWord?: boolean;
  engine?: "browser" | "whisper" | "manual";
  now?: number;
}

export interface HandleTranscriptResult {
  ok: boolean;
  matched: boolean;
  wokeOnly: boolean;
  command: string;
  reply?: string;
  toolCalls?: AgentToolCallRecord[];
  error?: string;
  voiceState: VoiceListenerSnapshot;
}

export type VoiceListenerEvents = {
  stateChanged: [VoiceListenerSnapshot];
  speakRequested: [string];
};

const LEADING_PUNCT_RE = /^[\s,，。．.、!！?？:：;；\-—~～]+/;
const TRAILING_PUNCT_RE = /[\s,，。．.、!！?？:：;；]+$/;

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 唤醒词提取器：
 * - 若未开启唤醒词或 bypassWakeWord=true，整句直接作为指令
 * - 若当前处于唤醒等待窗口（awakeUntil > now），整句直接作为指令
 * - 否则在句子中匹配最长唤醒词，提取唤醒词后的指令文本；若仅说唤醒词则进入唤醒窗口
 */
export function extractWakeCommand(
  rawText: string,
  options: {
    wakeWordEnabled: boolean;
    wakeWords: readonly string[];
    bypassWakeWord?: boolean;
    awakeActive?: boolean;
  },
): WakeMatchResult {
  const cleaned = rawText.trim();
  if (!cleaned) {
    return { matched: false, wokeOnly: false, wakeWord: null, command: "" };
  }

  if (!options.wakeWordEnabled || options.bypassWakeWord || options.awakeActive) {
    const cmd = cleaned.replace(LEADING_PUNCT_RE, "").replace(TRAILING_PUNCT_RE, "").trim();
    return {
      matched: cmd.length > 0,
      wokeOnly: false,
      wakeWord: null,
      command: cmd,
    };
  }

  // 按长度降序优先匹配更具体的唤醒词
  const sortedWords = [...options.wakeWords]
    .map((w) => w.trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);

  for (const word of sortedWords) {
    const isAsciiWord = /^[a-z0-9]+$/i.test(word);
    const pattern = isAsciiWord
      ? new RegExp(`(?:^|[\\s,，。!！?？、])(?:hey\\s+|hi\\s+|ok\\s+)?${escapeRegExp(word)}(?=$|[\\s,，。!！?？:：、\\u4e00-\\u9fff])`, "i")
      : new RegExp(escapeRegExp(word), "i");

    const match = pattern.exec(cleaned);
    if (!match) continue;

    const afterIdx = match.index + match[0].length;
    const afterText = cleaned
      .slice(afterIdx)
      .replace(LEADING_PUNCT_RE, "")
      .replace(/^(?:同学|你好|请|帮我一下)?[\s,，。!！?？:：]*/i, "")
      .replace(TRAILING_PUNCT_RE, "")
      .trim();

    if (afterText.length > 0) {
      return {
        matched: true,
        wokeOnly: false,
        wakeWord: word,
        command: afterText,
      };
    }

    return {
      matched: true,
      wokeOnly: true,
      wakeWord: word,
      command: "",
    };
  }

  return { matched: false, wokeOnly: false, wakeWord: null, command: "" };
}

export class VoiceListenerController extends TypedEmitter<VoiceListenerEvents> {
  private readonly _agent: PiAgentService;
  private readonly _fetcher: FetchLike;

  private _active = false;
  private _mode: VoiceListenMode = "idle";
  private _engine: "browser" | "whisper" | "manual" = "browser";
  private _interimTranscript = "";
  private _lastTranscript = "";
  private _lastCommand = "";
  private _awakeUntil: number | null = null;
  private _error: string | null = null;
  private _history: VoiceTranscriptEntry[] = [];
  private _lastDispatchedText = "";
  private _lastDispatchedAt = 0;
  private _seq = 0;

  constructor(agent: PiAgentService, options: { fetcher?: FetchLike } = {}) {
    super();
    this._agent = agent;
    this._fetcher = options.fetcher ?? globalThis.fetch;
  }

  get config(): AgentVoiceConfig {
    return this._agent.config;
  }

  updateRuntimeState(patch: {
    active?: boolean;
    mode?: VoiceListenMode;
    engine?: "browser" | "whisper" | "manual";
    interimTranscript?: string;
    error?: string | null;
  }): VoiceListenerSnapshot {
    if (patch.active !== undefined) {
      this._active = Boolean(patch.active);
      if (!this._active) {
        this._mode = "idle";
        this._interimTranscript = "";
        this._awakeUntil = null;
      } else if (this._mode === "idle" || this._mode === "error") {
        this._mode = "listening";
        this._error = null;
      }
    }
    if (patch.engine !== undefined) {
      this._engine = patch.engine;
    }
    if (patch.interimTranscript !== undefined) {
      this._interimTranscript = patch.interimTranscript;
    }
    if (patch.error !== undefined) {
      this._error = patch.error;
      if (patch.error) {
        this._mode = "error";
      }
    }
    if (patch.mode !== undefined) {
      this._mode = patch.mode;
    }

    const snap = this.snapshot();
    this.emit("stateChanged", snap);
    return snap;
  }

  async handleTranscript(
    rawText: string,
    options: HandleTranscriptOptions = {},
  ): Promise<HandleTranscriptResult> {
    const now = options.now ?? Date.now();
    const text = rawText.trim();
    if (options.engine) {
      this._engine = options.engine;
    }

    // 中间识别字幕仅刷新显示，不触发 Pi Agent
    if (options.isFinal === false) {
      this._interimTranscript = text;
      const snap = this.snapshot();
      this.emit("stateChanged", snap);
      return {
        ok: true,
        matched: false,
        wokeOnly: false,
        command: "",
        voiceState: snap,
      };
    }

    this._interimTranscript = "";
    if (!text) {
      return {
        ok: true,
        matched: false,
        wokeOnly: false,
        command: "",
        voiceState: this.snapshot(),
      };
    }

    this._lastTranscript = text;
    this._error = null;

    // 1.5s 内相同最终识别结果去重（避免浏览器重复回调）
    if (
      text === this._lastDispatchedText &&
      now - this._lastDispatchedAt < 1500
    ) {
      return {
        ok: true,
        matched: false,
        wokeOnly: false,
        command: "",
        voiceState: this.snapshot(),
      };
    }

    const cfg = this.config;
    const awakeActive = this._awakeUntil !== null && now < this._awakeUntil;
    if (!awakeActive && this._awakeUntil !== null) {
      this._awakeUntil = null;
    }

    const match = extractWakeCommand(text, {
      wakeWordEnabled: cfg.wakeWordEnabled,
      wakeWords: cfg.wakeWords,
      bypassWakeWord: options.bypassWakeWord,
      awakeActive,
    });

    const entry: VoiceTranscriptEntry = {
      id: `vt_${now}_${++this._seq}`,
      text,
      matched: match.matched,
      wokeOnly: match.wokeOnly,
      command: match.command,
      timestamp: now,
    };
    this._history.push(entry);
    if (this._history.length > 20) {
      this._history = this._history.slice(-20);
    }

    // 仅唤醒词：开启连续聆听窗口，等待用户下一句说出具体控制指令
    if (match.matched && match.wokeOnly) {
      this._awakeUntil = now + cfg.wakeWindowSec * 1000;
      this._mode = "awake";
      entry.reply = "我在，请说指令";
      const snap = this.snapshot();
      this.emit("stateChanged", snap);
      if (cfg.autoSpeakReply) {
        this.emit("speakRequested", "我在，请说指令");
      }
      return {
        ok: true,
        matched: true,
        wokeOnly: true,
        command: "",
        reply: "我在，请说指令",
        voiceState: snap,
      };
    }

    if (!match.matched || !match.command) {
      if (this._active && this._mode !== "awake") {
        this._mode = "listening";
      }
      const snap = this.snapshot();
      this.emit("stateChanged", snap);
      return {
        ok: true,
        matched: false,
        wokeOnly: false,
        command: "",
        voiceState: snap,
      };
    }

    // 命中指令：关闭单次唤醒窗口，交给内置 Pi Agent 执行！
    this._awakeUntil = null;
    this._lastDispatchedText = text;
    this._lastDispatchedAt = now;
    this._lastCommand = match.command;
    this._mode = "processing";
    this.emit("stateChanged", this.snapshot());

    const runResult: PiAgentRunResult = await this._agent.prompt(match.command, {
      source: "voice",
    });

    entry.reply = runResult.reply;
    if (runResult.error) {
      entry.error = runResult.error;
    }

    this._mode = this._active ? "listening" : "idle";
    const finalSnap = this.snapshot();
    this.emit("stateChanged", finalSnap);

    if (cfg.autoSpeakReply && runResult.reply) {
      this.emit("speakRequested", runResult.reply);
    }

    return {
      ok: runResult.ok,
      matched: true,
      wokeOnly: false,
      command: match.command,
      reply: runResult.reply,
      toolCalls: runResult.toolCalls,
      ...(runResult.error ? { error: runResult.error } : {}),
      voiceState: finalSnap,
    };
  }

  /**
   * 调用 OpenAI 兼容 /audio/transcriptions 接口（Whisper / SenseVoice / SiliconFlow / 本地 Whisper）转写音频。
   */
  async transcribeAudio(
    audioBlob: Blob,
    options: { filename?: string; lang?: string } = {},
  ): Promise<string> {
    const cfg = this.config;
    const stt = resolveEffectiveSttAuth(cfg);
    if (!stt.baseUrl) {
      throw new Error(
        "尚未配置语音转写 STT 服务地址，请在「设置 → 语音与 Pi Agent」中填写 OpenAI 兼容 STT 接口地址（如 SiliconFlow / OpenAI / 本地 Whisper）。",
      );
    }
    const localUrl = isLocalEndpointUrl(stt.baseUrl);
    if (!stt.apiKey && !localUrl) {
      throw new Error("缺少语音转写 STT API Key，请在「设置 → 语音与 Pi Agent」中填写。");
    }

    const endpoint = stt.baseUrl.endsWith("/audio/transcriptions")
      ? stt.baseUrl
      : `${stt.baseUrl.replace(/\/+$/, "")}/audio/transcriptions`;

    const form = new FormData();
    const filename = options.filename || "voice.webm";
    form.append("file", audioBlob, filename);
    form.append("model", stt.model);
    const langCode = (options.lang || cfg.voiceLang || "zh-CN").split("-")[0] || "zh";
    form.append("language", langCode);

    const headers: Record<string, string> = {};
    if (stt.apiKey) {
      headers["Authorization"] = `Bearer ${stt.apiKey}`;
    }

    const bounded = createBoundedFetch(this._fetcher, 25_000);
    const res = await bounded(endpoint, {
      method: "POST",
      headers,
      body: form,
      timeoutMs: 25_000,
    });

    const rawText = await res.text();
    if (!res.ok) {
      throw new Error(`语音转写服务返回错误 (${res.status})`);
    }
    try {
      const parsed = JSON.parse(rawText) as { text?: unknown };
      if (typeof parsed.text === "string") {
        return parsed.text.trim();
      }
    } catch {
      // plain text response fallback
    }
    return rawText.trim();
  }

  clearHistory(): void {
    this._history = [];
    this._lastTranscript = "";
    this._lastCommand = "";
    this.emit("stateChanged", this.snapshot());
  }

  snapshot(): VoiceListenerSnapshot {
    const cfg = this.config;
    return {
      active: this._active,
      mode: this._mode,
      engine: this._engine,
      interimTranscript: this._interimTranscript,
      lastTranscript: this._lastTranscript,
      lastCommand: this._lastCommand,
      awakeUntil: this._awakeUntil,
      error: this._error,
      wakeWordEnabled: cfg.wakeWordEnabled,
      wakeWords: [...cfg.wakeWords],
      autoSpeakReply: cfg.autoSpeakReply,
      history: this._history.map((h) => ({ ...h })),
    };
  }

  dispose(): void {
    this._active = false;
    this._mode = "idle";
    this._awakeUntil = null;
    this.clear();
  }
}
