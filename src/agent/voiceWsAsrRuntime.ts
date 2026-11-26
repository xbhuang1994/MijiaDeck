// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * 统一流式语音降噪与听写网关（Unified Streaming Voice & ASR Gateway）WebSocket 客户端：
 *
 * 协议规范（README.md）：
 * - 连接地址：wss://voice.1inch.cn:18443/v1/ws/asr（兼容别名：/ws/asr、/ws）
 * - 鉴权方式：
 *   1. HTTP 请求头（默认）：Authorization: Bearer <AUTH_CODE>（亦支持 X-Auth-Code / X-API-Key）
 *   2. Query 参数：?token=<AUTH_CODE>
 *   3. Subprotocol：Sec-WebSocket-Protocol: bearer.<AUTH_CODE>
 * - 音频格式：16kHz / 16bit / 单声道原始 Little-Endian PCM（pcm_s16le），Binary Frame 直推（建议 64ms = 2048 bytes）
 * - 服务端预处理与识别：CPU ONNX GTCRN 降噪 + Silero VAD v5 静音过滤与 RingBuffer 切片 -> GPU Qwen3-ASR-0.6B 流式识别
 * - 控制帧：config / commit / eos / reset / ping；服务端事件：ready / config_ack / vad / partial / final / done / pong / error
 */

export const DEFAULT_VOICE_WS_ASR_ENDPOINT = "wss://voice.1inch.cn:18443/v1/ws/asr";
export const VOICE_WS_ASR_SAMPLE_RATE = 16000;
export const VOICE_WS_ASR_FRAME_BYTES = 2048; // 64ms @ 16kHz 16-bit mono PCM
export const VOICE_WS_ASR_DEFAULT_PARTIAL_INTERVAL_MS = 640;
export const VOICE_WS_ASR_MIN_PARTIAL_INTERVAL_MS = 160;
export const VOICE_WS_ASR_MAX_PARTIAL_INTERVAL_MS = 3000;
export const VOICE_WS_ASR_DEFAULT_VAD_THRESHOLD = 0.5;
export const VOICE_WS_ASR_DEFAULT_MIN_SPEECH_MS = 256;
export const VOICE_WS_ASR_DEFAULT_MIN_SILENCE_MS = 640;
export const VOICE_WS_ASR_MIN_SILENCE_MS = 320;
export const VOICE_WS_ASR_MAX_SILENCE_MS = 5000;
export const VOICE_WS_ASR_DEFAULT_PRE_ROLL_MS = 320;
export const VOICE_WS_ASR_DEFAULT_MAX_UTTERANCE_SEC = 30.0;
export const VOICE_WS_ASR_MAX_AUDIO_MS = 58_000;

export type VoiceWsAuthMode = "header" | "query" | "subprotocol";

export interface VoiceWsAsrConfig {
  endpointUrl?: string;
  authCode?: string;
  denoise?: boolean;
  language?: string | null;
  authMode?: VoiceWsAuthMode;
}

export interface VoiceWsAsrStatus {
  configured: boolean;
  ready: boolean;
  endpointUrl: string;
  hasAuthCode: boolean;
  denoiseEnabled: boolean;
  language: string | null;
  denoiseModel: string | null;
  vadModel: string | null;
  asrModel: string | null;
  lastLatencyMs: number | null;
  lastSessionId: string | null;
  lastError: string | null;
}

export interface VoiceWsAsrVadOptions {
  threshold?: number;
  minSpeechMs?: number;
  minSilenceMs?: number;
  preRollMs?: number;
  maxUtteranceSec?: number;
}

export interface VoiceWsAsrVadEvent {
  state: "speech_start" | "speech_end" | string;
  utteranceId: number;
  prob: number;
  audioMs: number;
  reason?: string;
}

export interface VoiceWsAsrPartialEvent {
  utteranceId: number;
  chunkId: number;
  text: string;
  delta: string;
  stableText: string;
  unstableText: string;
  language: string | null;
  speechMs: number;
  asrMs: number;
  cpuDenoiseMsAvg: number | null;
  cpuVadMsAvg: number | null;
  latencyMs: number;
}

export type VoiceWsAsrFinalReason =
  | "vad_silence"
  | "max_utterance_sec"
  | "commit"
  | "eos"
  | "client_finish"
  | "max_duration"
  | "no_speech_timeout"
  | "server_close";

export interface VoiceWsAsrSessionStats {
  audioMs?: number;
  vadFrames?: number;
  speechFrames?: number;
  framesDroppedSilence?: number;
  utterancesCompleted?: number;
  cpuDenoiseMsAvg?: number;
  cpuVadMsAvg?: number;
  gpuChunksSent?: number;
}

export interface VoiceWsAsrFinalEvent {
  text: string;
  sessionId: string | null;
  utteranceId: number | null;
  language: string | null;
  durationMs: number;
  audioDurationMs: number;
  speechMs: number;
  asrMs: number;
  cpuDenoiseMsAvg: number | null;
  cpuVadMsAvg: number | null;
  framesDroppedSilence: number | null;
  denoiseEnabled: boolean;
  denoiseModel: string | null;
  vadModel: string | null;
  asrModel: string | null;
  reason: VoiceWsAsrFinalReason;
  stats: VoiceWsAsrSessionStats | null;
}

export interface VoiceWsWebSocketLike {
  readonly readyState: number;
  send(data: string | Uint8Array | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (ev: { data: unknown }) => void): void;
  addEventListener(type: "error", listener: (ev: unknown) => void): void;
  addEventListener(type: "close", listener: (ev: { code?: number; reason?: string }) => void): void;
}

export interface VoiceWsFactoryOptions {
  headers?: Record<string, string>;
  protocols?: string[];
}

export type VoiceWsWebSocketFactory = (
  url: string,
  options?: VoiceWsFactoryOptions,
) => VoiceWsWebSocketLike;

export interface VoiceWsAsrStreamSessionOptions {
  denoise?: boolean;
  language?: string | null;
  context?: string;
  partialIntervalMs?: number;
  vad?: VoiceWsAsrVadOptions;
  /** 单句模式：收到服务端首个 final（如 vad_silence）后即刻完成会话并发送 eos 收尾（实时语音默认 true；整段上传设为 false 以合并多句直至 done） */
  stopOnFinal?: boolean;
  maxDurationMs?: number;
  connectTimeoutMs?: number;
  /** 实时流在迟迟未检测到 speech_start/partial 时的安全兜底超时（毫秒，<=0 禁用） */
  noSpeechTimeoutMs?: number;
  finishTimeoutMs?: number;
  onReady?: (info: {
    sessionId: string | null;
    denoiseModel: string | null;
    vadModel: string | null;
    asrModel: string | null;
  }) => void;
  onVad?: (ev: VoiceWsAsrVadEvent) => void;
  onPartial?: (ev: VoiceWsAsrPartialEvent) => void;
  onFinal?: (ev: VoiceWsAsrFinalEvent) => void;
  onError?: (err: Error) => void;
}

export interface VoiceWsAsrTranscribePcmResult {
  text: string;
  sessionId: string | null;
  language: string | null;
  durationMs: number;
  audioDurationMs: number;
  asrMs: number;
  denoiseEnabled: boolean;
  denoiseModel: string | null;
  vadModel: string | null;
  asrModel: string | null;
  stats: VoiceWsAsrSessionStats | null;
  engine: "voice-ws-asr";
}

export interface VoiceWsAsrConnectionTestResult {
  ok: boolean;
  latencyMs: number;
  sessionId: string | null;
  endpointUrl: string;
  denoiseModel: string | null;
  vadModel: string | null;
  asrModel: string | null;
  error?: string;
}

const WS_CONNECTING = 0;
const WS_OPEN = 1;

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function clampFloat(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * 规范化统一流式语音听写 WebSocket 端点地址：
 * - 支持 ws:// / wss://（亦兼容用户粘贴 https:// / http:// 自动转为 wss:// / ws://）
 * - 根路径自动补全为 /v1/ws/asr，保留显式 /v1/ws/asr、/ws/asr、/ws 等路径
 * - 剥离 URL 中可能误带入的查询参数（如 ?token=）与片段，防止凭据落盘或外泄
 */
export function normalizeVoiceWsAsrEndpointUrl(raw?: string): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return DEFAULT_VOICE_WS_ASR_ENDPOINT;
  try {
    const parsed = new URL(trimmed);
    let protocol = parsed.protocol;
    if (protocol === "https:") {
      protocol = "wss:";
    } else if (protocol === "http:") {
      protocol = "ws:";
    } else if (protocol !== "ws:" && protocol !== "wss:") {
      return DEFAULT_VOICE_WS_ASR_ENDPOINT;
    }
    const cleanPath =
      parsed.pathname && parsed.pathname !== "/"
        ? parsed.pathname.replace(/\/+$/, "")
        : "/v1/ws/asr";
    return `${protocol}//${parsed.host}${cleanPath}`;
  } catch {
    return DEFAULT_VOICE_WS_ASR_ENDPOINT;
  }
}

/**
 * 按 README 规范构造统一流式语音听写网关连接参数（默认使用 Authorization: Bearer 请求头，不把授权码暴露在 URL 中）。
 */
export function buildVoiceWsAuthConnection(params: {
  endpointUrl?: string;
  authCode: string;
  authMode?: VoiceWsAuthMode;
}): {
  wsUrl: string;
  options: VoiceWsFactoryOptions;
  authMode: VoiceWsAuthMode;
} {
  const endpoint = normalizeVoiceWsAsrEndpointUrl(params.endpointUrl);
  const code = params.authCode.trim();
  const mode: VoiceWsAuthMode = params.authMode ?? "header";
  if (mode === "query") {
    const u = new URL(endpoint);
    if (code) {
      u.searchParams.set("token", code);
    }
    return { wsUrl: u.toString(), options: {}, authMode: "query" };
  }
  if (mode === "subprotocol") {
    return {
      wsUrl: endpoint,
      options: code ? { protocols: [`bearer.${code}`] } : {},
      authMode: "subprotocol",
    };
  }
  return {
    wsUrl: endpoint,
    options: code ? { headers: { Authorization: `Bearer ${code}` } } : {},
    authMode: "header",
  };
}

/**
 * 将原始 16kHz Float32 [-1, 1] PCM 无损直转为 Little-Endian Int16 字节数组（零滤波/零本地降噪/零增益修改）。
 */
export function float32ToPcmS16LeBytes(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    const int16 = Math.max(-0x8000, Math.min(0x7fff, Math.round(s * 0x8000)));
    view.setInt16(i * 2, int16, true);
  }
  return out;
}

export function redactVoiceWsError(raw: string): string {
  return raw
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
    .replace(/bearer\.[A-Za-z0-9._~+/=-]+/gi, "bearer.<redacted>")
    .replace(/vgw_[A-Za-z0-9._~+/=-]{6,}/g, "<redacted>")
    .replace(
      /(token|authorization|auth[_-]?code|x-auth-code|x-api-key|voiceWsAsrAuthCode)\s*[:=]\s*[^\s,&'"};]+/gi,
      "$1=<redacted>",
    )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220);
}

function defaultWebSocketFactory(
  url: string,
  options?: VoiceWsFactoryOptions,
): VoiceWsWebSocketLike {
  if (options?.headers && Object.keys(options.headers).length > 0) {
    // Bun 原生 WebSocket 支持在第二参数对象中透传 headers（不会把授权码暴露在 URL Query 中）
    return new WebSocket(url, {
      headers: options.headers,
      ...(options.protocols && options.protocols.length > 0 ? { protocols: options.protocols } : {}),
    } as unknown as string[]) as unknown as VoiceWsWebSocketLike;
  }
  if (options?.protocols && options.protocols.length > 0) {
    return new WebSocket(url, options.protocols) as unknown as VoiceWsWebSocketLike;
  }
  return new WebSocket(url) as unknown as VoiceWsWebSocketLike;
}

function mapServerFinalReason(raw: unknown, fallback: VoiceWsAsrFinalReason): VoiceWsAsrFinalReason {
  switch (raw) {
    case "vad_silence":
    case "max_utterance_sec":
    case "commit":
    case "eos":
      return raw;
    default:
      return fallback;
  }
}

function joinUtterances(parts: readonly string[]): string {
  let merged = "";
  for (const raw of parts) {
    const piece = raw.trim();
    if (!piece) continue;
    if (!merged) {
      merged = piece;
      continue;
    }
    const lastChar = merged[merged.length - 1] ?? "";
    const firstChar = piece[0] ?? "";
    const needsSpace = /[A-Za-z0-9]$/.test(lastChar) && /^[A-Za-z0-9]/.test(firstChar);
    merged += needsSpace ? ` ${piece}` : piece;
  }
  return merged;
}

/**
 * 单次统一流式语音听写网关 WebSocket 会话。
 * 支持握手阶段自动缓存待发原始 PCM 帧，连接就绪后先发送 config 帧再以 Binary Frame 直推 16kHz PCM；
 * 支持服务端 GTCRN 降噪、Silero VAD 静音自动判停、partial 实时增量出字、final 收句与 eos 优雅关闭。
 */
export class VoiceWsAsrStreamSession {
  private readonly _denoise: boolean;
  private readonly _language: string | null;
  private readonly _context: string;
  private readonly _partialIntervalMs: number;
  private readonly _vadThreshold: number;
  private readonly _vadMinSpeechMs: number;
  private readonly _vadMinSilenceMs: number;
  private readonly _vadPreRollMs: number;
  private readonly _vadMaxUtteranceSec: number;
  private readonly _stopOnFinal: boolean;
  private readonly _maxAudioBytes: number;
  private readonly _finishTimeoutMs: number;
  private readonly _noSpeechTimeoutMs: number;
  private readonly _opts: VoiceWsAsrStreamSessionOptions;
  private readonly _ws: VoiceWsWebSocketLike;
  private readonly _startedAt = performance.now();

  private _pendingFrames: Uint8Array[] = [];
  private _pendingFinish = false;
  private _sentConfig = false;
  private _sentEos = false;
  private _finishReason: VoiceWsAsrFinalReason = "client_finish";
  private _totalAudioBytes = 0;
  private _sessionId: string | null = null;
  private _denoiseModel: string | null = null;
  private _vadModel: string | null = null;
  private _asrModel: string | null = null;
  private _lastLanguage: string | null = null;
  private _lastUtteranceId: number | null = null;
  private _latestPartialText = "";
  private _finalUtterances: string[] = [];
  private _lastFinalReason: VoiceWsAsrFinalReason | null = null;
  private _totalSpeechMs = 0;
  private _totalAsrMs = 0;
  private _lastCpuDenoiseMsAvg: number | null = null;
  private _lastCpuVadMsAvg: number | null = null;
  private _lastFramesDroppedSilence: number | null = null;
  private _lastStats: VoiceWsAsrSessionStats | null = null;
  private _lastPongTs: number | null = null;
  private _speechObserved = false;
  private _settled = false;
  private _aborted = false;
  private _connectTimer: ReturnType<typeof setTimeout> | null = null;
  private _noSpeechTimer: ReturnType<typeof setTimeout> | null = null;
  private _finishTimer: ReturnType<typeof setTimeout> | null = null;
  private _doneResolvers: Array<(text: string) => void> = [];
  private readonly _onMetric?: (metric: {
    latencyMs: number;
    sessionId: string | null;
    denoiseModel: string | null;
    vadModel: string | null;
    asrModel: string | null;
    error: string | null;
  }) => void;

  constructor(
    auth: {
      endpointUrl: string;
      authCode: string;
      authMode?: VoiceWsAuthMode;
    },
    options: VoiceWsAsrStreamSessionOptions = {},
    wsFactory: VoiceWsWebSocketFactory = defaultWebSocketFactory,
    onMetric?: (metric: {
      latencyMs: number;
      sessionId: string | null;
      denoiseModel: string | null;
      vadModel: string | null;
      asrModel: string | null;
      error: string | null;
    }) => void,
  ) {
    this._denoise = options.denoise !== false;
    const langTrimmed = typeof options.language === "string" ? options.language.trim() : "";
    this._language = langTrimmed || null;
    this._context = typeof options.context === "string" ? options.context.trim() : "";
    this._partialIntervalMs = clampInt(
      options.partialIntervalMs,
      VOICE_WS_ASR_MIN_PARTIAL_INTERVAL_MS,
      VOICE_WS_ASR_MAX_PARTIAL_INTERVAL_MS,
      VOICE_WS_ASR_DEFAULT_PARTIAL_INTERVAL_MS,
    );
    this._vadThreshold = clampFloat(
      options.vad?.threshold,
      0.1,
      0.95,
      VOICE_WS_ASR_DEFAULT_VAD_THRESHOLD,
    );
    this._vadMinSpeechMs = clampInt(
      options.vad?.minSpeechMs,
      64,
      2000,
      VOICE_WS_ASR_DEFAULT_MIN_SPEECH_MS,
    );
    this._vadMinSilenceMs = clampInt(
      options.vad?.minSilenceMs,
      VOICE_WS_ASR_MIN_SILENCE_MS,
      VOICE_WS_ASR_MAX_SILENCE_MS,
      VOICE_WS_ASR_DEFAULT_MIN_SILENCE_MS,
    );
    this._vadPreRollMs = clampInt(
      options.vad?.preRollMs,
      0,
      1500,
      VOICE_WS_ASR_DEFAULT_PRE_ROLL_MS,
    );
    this._vadMaxUtteranceSec = Number(
      clampFloat(
        options.vad?.maxUtteranceSec,
        3.0,
        60.0,
        VOICE_WS_ASR_DEFAULT_MAX_UTTERANCE_SEC,
      ).toFixed(1),
    );
    this._stopOnFinal = options.stopOnFinal !== false;
    const maxMs = clampInt(options.maxDurationMs, 2000, VOICE_WS_ASR_MAX_AUDIO_MS, VOICE_WS_ASR_MAX_AUDIO_MS);
    this._maxAudioBytes = Math.round((VOICE_WS_ASR_SAMPLE_RATE * 2 * maxMs) / 1000);
    this._finishTimeoutMs = clampInt(options.finishTimeoutMs, 500, 15_000, 6000);
    this._noSpeechTimeoutMs =
      options.noSpeechTimeoutMs === undefined
        ? this._stopOnFinal
          ? 12_000
          : 0
        : options.noSpeechTimeoutMs <= 0
          ? 0
          : clampInt(options.noSpeechTimeoutMs, 1000, 60_000, 12_000);
    this._opts = options;
    this._onMetric = onMetric;

    const conn = buildVoiceWsAuthConnection({
      endpointUrl: auth.endpointUrl,
      authCode: auth.authCode,
      authMode: auth.authMode,
    });
    this._ws = wsFactory(conn.wsUrl, conn.options);

    const connectTimeoutMs = clampInt(options.connectTimeoutMs, 1000, 20_000, 8000);
    this._connectTimer = setTimeout(() => {
      this._connectTimer = null;
      if (!this._settled && this._ws.readyState === WS_CONNECTING) {
        this._fail(new Error(`统一流式语音听写网关连接超时 (${connectTimeoutMs}ms)`));
      }
    }, connectTimeoutMs);
    (this._connectTimer as { unref?: () => void }).unref?.();

    this._ws.addEventListener("open", () => {
      this._clearConnectTimer();
      if (this._settled || this._aborted) {
        this._safeClose();
        return;
      }
      this._sendConfigFrame();
      this._armNoSpeechTimer();
      this._flushPendingQueue();
    });

    this._ws.addEventListener("message", (ev) => {
      if (this._settled || this._aborted) return;
      this._handleMessage(ev.data);
    });

    this._ws.addEventListener("error", () => {
      if (this._settled || this._aborted) return;
      this._fail(new Error("统一流式语音听写网关 WebSocket 连接异常"));
    });

    this._ws.addEventListener("close", (ev) => {
      this._clearTimers();
      if (this._settled || this._aborted) return;
      const code = typeof ev?.code === "number" ? ev.code : 1006;
      const reasonRaw = typeof ev?.reason === "string" ? ev.reason.trim() : "";
      if (code === 4401 || code === 4403) {
        const suffix = reasonRaw ? `: ${reasonRaw}` : "";
        this._fail(new Error(`统一流式语音听写网关鉴权失败 (code=${code}${suffix})，请检查授权码`));
        return;
      }
      const assembled = this.latestText.trim();
      if (assembled.length > 0 || this._sentEos || code === 1000 || code === 1005) {
        this._complete(this._sentEos ? this._finishReason : "server_close");
        return;
      }
      const suffix = reasonRaw ? `: ${reasonRaw}` : "";
      this._fail(new Error(`统一流式语音听写网关连接已关闭 (code=${code}${suffix})`));
    });
  }

  get isActive(): boolean {
    return !this._settled && !this._aborted;
  }

  get sessionId(): string | null {
    return this._sessionId;
  }

  get denoiseEnabled(): boolean {
    return this._denoise;
  }

  get lastPongTs(): number | null {
    return this._lastPongTs;
  }

  get latestText(): string {
    if (this._finalUtterances.length > 0) {
      if (!this._stopOnFinal && this._latestPartialText.trim()) {
        return joinUtterances([...this._finalUtterances, this._latestPartialText]);
      }
      return joinUtterances(this._finalUtterances);
    }
    return this._latestPartialText;
  }

  get audioDurationMs(): number {
    return Math.round((this._totalAudioBytes / (VOICE_WS_ASR_SAMPLE_RATE * 2)) * 1000);
  }

  pushFloat32Samples(samples: Float32Array): void {
    if (this._settled || this._aborted || this._sentEos || samples.length === 0) return;
    this.pushInt16Bytes(float32ToPcmS16LeBytes(samples));
  }

  pushInt16Bytes(bytes: Uint8Array): void {
    if (this._settled || this._aborted || this._sentEos || bytes.byteLength === 0) return;

    const remainingBudget = this._maxAudioBytes - this._totalAudioBytes;
    if (remainingBudget <= 0) {
      void this.finish("max_duration");
      return;
    }

    const slice = bytes.byteLength > remainingBudget ? bytes.subarray(0, remainingBudget) : bytes;
    for (let off = 0; off < slice.byteLength; off += VOICE_WS_ASR_FRAME_BYTES) {
      const end = Math.min(slice.byteLength, off + VOICE_WS_ASR_FRAME_BYTES);
      const frame = slice.slice(off, end);
      this._totalAudioBytes += frame.byteLength;
      if (this._ws.readyState === WS_OPEN) {
        this._sendAudioFrame(frame);
      } else if (this._ws.readyState === WS_CONNECTING) {
        this._pendingFrames.push(frame);
      }
    }

    if (this._totalAudioBytes >= this._maxAudioBytes) {
      void this.finish("max_duration");
    }
  }

  commit(): void {
    if (this._settled || this._aborted || this._sentEos || this._ws.readyState !== WS_OPEN) return;
    this._sendJsonControl({ type: "commit" });
  }

  reset(): void {
    if (this._settled || this._aborted || this._sentEos) return;
    this._latestPartialText = "";
    if (this._ws.readyState === WS_OPEN) {
      this._sendJsonControl({ type: "reset" });
    }
  }

  ping(): void {
    if (this._settled || this._aborted || this._ws.readyState !== WS_OPEN) return;
    this._sendJsonControl({ type: "ping" });
  }

  finish(reason: "client_finish" | "max_duration" = "client_finish"): Promise<string> {
    if (this._settled) {
      return Promise.resolve(this.latestText.trim());
    }
    this._finishReason = reason;
    this._clearNoSpeechTimer();
    const waitPromise = new Promise<string>((resolve) => {
      this._doneResolvers.push(resolve);
    });

    if (!this._sentEos) {
      if (this._ws.readyState === WS_OPEN) {
        this._sendEosFrame();
      } else if (this._ws.readyState === WS_CONNECTING) {
        this._pendingFinish = true;
      } else {
        this._complete(reason);
        return waitPromise;
      }
    }

    if (!this._finishTimer) {
      this._finishTimer = setTimeout(() => {
        this._finishTimer = null;
        if (!this._settled) {
          this._complete(reason);
        }
      }, this._finishTimeoutMs);
      (this._finishTimer as { unref?: () => void }).unref?.();
    }

    return waitPromise;
  }

  abort(): void {
    if (this._aborted) return;
    this._aborted = true;
    this._settled = true;
    this._pendingFrames = [];
    this._pendingFinish = false;
    this._clearTimers();
    this._safeClose();
    this._resolveWaiters("");
  }

  private _armNoSpeechTimer(): void {
    if (this._noSpeechTimeoutMs <= 0 || this._speechObserved || this._sentEos || this._settled) {
      return;
    }
    this._clearNoSpeechTimer();
    this._noSpeechTimer = setTimeout(() => {
      this._noSpeechTimer = null;
      if (!this._settled && !this._aborted && !this._speechObserved) {
        this._sendEosFrameBestEffort();
        this._complete("no_speech_timeout");
      }
    }, this._noSpeechTimeoutMs);
    (this._noSpeechTimer as { unref?: () => void }).unref?.();
  }

  private _sendConfigFrame(): void {
    if (this._sentConfig || this._settled || this._aborted || this._ws.readyState !== WS_OPEN) return;
    this._sentConfig = true;
    const configPayload = {
      type: "config",
      sample_rate: VOICE_WS_ASR_SAMPLE_RATE,
      encoding: "pcm_s16le",
      language: this._language,
      context: this._context,
      denoise: this._denoise,
      partial_interval_ms: this._partialIntervalMs,
      vad: {
        threshold: this._vadThreshold,
        min_speech_ms: this._vadMinSpeechMs,
        min_silence_ms: this._vadMinSilenceMs,
        pre_roll_ms: this._vadPreRollMs,
        max_utterance_sec: this._vadMaxUtteranceSec,
      },
    };
    this._sendJsonControl(configPayload);
  }

  private _flushPendingQueue(): void {
    const queued = this._pendingFrames;
    this._pendingFrames = [];
    for (const frame of queued) {
      if (this._settled || this._aborted || this._ws.readyState !== WS_OPEN) return;
      this._sendAudioFrame(frame);
    }
    if (this._pendingFinish && !this._sentEos && this._ws.readyState === WS_OPEN) {
      this._pendingFinish = false;
      this._sendEosFrame();
    }
  }

  private _sendAudioFrame(pcmBytes: Uint8Array): void {
    if (this._settled || this._aborted || this._sentEos) return;
    if (!this._sentConfig) {
      this._sendConfigFrame();
    }
    try {
      this._ws.send(pcmBytes);
    } catch (err) {
      this._fail(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private _sendJsonControl(payload: Record<string, unknown>): void {
    try {
      this._ws.send(JSON.stringify(payload));
    } catch (err) {
      this._fail(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private _sendEosFrame(): void {
    if (this._settled || this._aborted || this._sentEos) return;
    if (!this._sentConfig && this._ws.readyState === WS_OPEN) {
      this._sendConfigFrame();
    }
    this._sentEos = true;
    this._sendJsonControl({ type: "eos" });
  }

  private _sendEosFrameBestEffort(): void {
    if (this._sentEos || this._ws.readyState !== WS_OPEN) return;
    this._sentEos = true;
    try {
      this._ws.send(JSON.stringify({ type: "eos" }));
    } catch {
      // ignore best-effort eos errors
    }
  }

  private _handleMessage(rawData: unknown): void {
    let rawText: string;
    if (typeof rawData === "string") {
      rawText = rawData;
    } else if (rawData instanceof ArrayBuffer) {
      rawText = new TextDecoder().decode(rawData);
    } else if (ArrayBuffer.isView(rawData)) {
      rawText = new TextDecoder().decode(rawData);
    } else {
      rawText = String(rawData ?? "");
    }

    let ev: Record<string, unknown>;
    try {
      const parsed = JSON.parse(rawText);
      if (!parsed || typeof parsed !== "object") return;
      ev = parsed as Record<string, unknown>;
    } catch {
      return;
    }

    const type = typeof ev.type === "string" ? ev.type : "";
    switch (type) {
      case "ready": {
        if (typeof ev.session_id === "string" && ev.session_id.trim()) {
          this._sessionId = ev.session_id.trim();
        }
        if (typeof ev.denoise === "string" && ev.denoise.trim()) {
          this._denoiseModel = ev.denoise.trim();
        }
        if (typeof ev.vad === "string" && ev.vad.trim()) {
          this._vadModel = ev.vad.trim();
        }
        if (typeof ev.asr_model === "string" && ev.asr_model.trim()) {
          this._asrModel = ev.asr_model.trim();
        }
        this._opts.onReady?.({
          sessionId: this._sessionId,
          denoiseModel: this._denoiseModel,
          vadModel: this._vadModel,
          asrModel: this._asrModel,
        });
        return;
      }

      case "config_ack": {
        return;
      }

      case "pong": {
        const ts = finiteOrNull(ev.ts);
        if (ts !== null) {
          this._lastPongTs = ts;
        }
        return;
      }

      case "vad": {
        const state = typeof ev.state === "string" ? ev.state : "";
        const utteranceId = typeof ev.utterance_id === "number" ? ev.utterance_id : 0;
        const prob = typeof ev.prob === "number" ? ev.prob : 0;
        const audioMs = typeof ev.audio_ms === "number" ? ev.audio_ms : 0;
        if (state === "speech_start") {
          this._speechObserved = true;
          this._clearNoSpeechTimer();
        }
        this._opts.onVad?.({
          state,
          utteranceId,
          prob,
          audioMs,
          ...(typeof ev.reason === "string" ? { reason: ev.reason } : {}),
        });
        return;
      }

      case "partial": {
        this._speechObserved = true;
        this._clearNoSpeechTimer();
        const text = typeof ev.text === "string" ? ev.text : "";
        const delta = typeof ev.delta === "string" ? ev.delta : "";
        const utteranceId = typeof ev.utterance_id === "number" ? ev.utterance_id : 1;
        const chunkId = typeof ev.chunk_id === "number" ? ev.chunk_id : 0;
        const language = typeof ev.language === "string" && ev.language.trim() ? ev.language.trim() : null;
        const speechMs = typeof ev.speech_ms === "number" ? ev.speech_ms : 0;
        const asrMs = typeof ev.asr_ms === "number" ? ev.asr_ms : 0;
        const cpuDenoiseMsAvg = finiteOrNull(ev.cpu_denoise_ms_avg);
        const cpuVadMsAvg = finiteOrNull(ev.cpu_vad_ms_avg);

        this._lastUtteranceId = utteranceId;
        if (language) this._lastLanguage = language;
        if (cpuDenoiseMsAvg !== null) this._lastCpuDenoiseMsAvg = cpuDenoiseMsAvg;
        if (cpuVadMsAvg !== null) this._lastCpuVadMsAvg = cpuVadMsAvg;
        this._latestPartialText = text;

        if (text.trim()) {
          const stableText =
            delta && text.endsWith(delta) ? text.slice(0, text.length - delta.length) : text;
          const unstableText = delta && text.endsWith(delta) ? delta : "";
          this._opts.onPartial?.({
            utteranceId,
            chunkId,
            text,
            delta,
            stableText,
            unstableText,
            language,
            speechMs,
            asrMs,
            cpuDenoiseMsAvg,
            cpuVadMsAvg,
            latencyMs: Math.round(performance.now() - this._startedAt),
          });
        }
        return;
      }

      case "final": {
        this._speechObserved = true;
        this._clearNoSpeechTimer();
        const text = typeof ev.text === "string" ? ev.text.trim() : "";
        const utteranceId = typeof ev.utterance_id === "number" ? ev.utterance_id : 1;
        const language = typeof ev.language === "string" && ev.language.trim() ? ev.language.trim() : null;
        const speechMs = typeof ev.speech_ms === "number" ? ev.speech_ms : 0;
        const asrMs = typeof ev.asr_ms === "number" ? ev.asr_ms : 0;
        const cpuDenoiseMsAvg = finiteOrNull(ev.cpu_denoise_ms_avg);
        const cpuVadMsAvg = finiteOrNull(ev.cpu_vad_ms_avg);
        const framesDroppedSilence = finiteOrNull(ev.frames_dropped_silence);

        this._lastUtteranceId = utteranceId;
        if (language) this._lastLanguage = language;
        this._totalSpeechMs += speechMs;
        this._totalAsrMs += asrMs;
        if (cpuDenoiseMsAvg !== null) this._lastCpuDenoiseMsAvg = cpuDenoiseMsAvg;
        if (cpuVadMsAvg !== null) this._lastCpuVadMsAvg = cpuVadMsAvg;
        if (framesDroppedSilence !== null) this._lastFramesDroppedSilence = framesDroppedSilence;
        this._latestPartialText = "";
        if (text) {
          this._finalUtterances.push(text);
        }

        const mappedReason = mapServerFinalReason(
          ev.reason,
          this._sentEos ? this._finishReason : "vad_silence",
        );
        this._lastFinalReason = mappedReason;

        if (this._stopOnFinal) {
          const hadSentEos = this._sentEos;
          this._sendEosFrameBestEffort();
          this._complete(hadSentEos && mappedReason === "eos" ? this._finishReason : mappedReason);
        }
        return;
      }

      case "done": {
        if (typeof ev.session_id === "string" && ev.session_id.trim()) {
          this._sessionId = ev.session_id.trim();
        }
        const rawStats = ev.stats && typeof ev.stats === "object"
          ? (ev.stats as Record<string, unknown>)
          : null;
        if (rawStats) {
          this._lastStats = {
            audioMs: finiteOrNull(rawStats.audio_ms) ?? undefined,
            vadFrames: finiteOrNull(rawStats.vad_frames) ?? undefined,
            speechFrames: finiteOrNull(rawStats.speech_frames) ?? undefined,
            framesDroppedSilence: finiteOrNull(rawStats.frames_dropped_silence) ?? undefined,
            utterancesCompleted: finiteOrNull(rawStats.utterances_completed) ?? undefined,
            cpuDenoiseMsAvg: finiteOrNull(rawStats.cpu_denoise_ms_avg) ?? undefined,
            cpuVadMsAvg: finiteOrNull(rawStats.cpu_vad_ms_avg) ?? undefined,
            gpuChunksSent: finiteOrNull(rawStats.gpu_chunks_sent) ?? undefined,
          };
          if (this._lastCpuDenoiseMsAvg === null && this._lastStats.cpuDenoiseMsAvg !== undefined) {
            this._lastCpuDenoiseMsAvg = this._lastStats.cpuDenoiseMsAvg;
          }
          if (this._lastCpuVadMsAvg === null && this._lastStats.cpuVadMsAvg !== undefined) {
            this._lastCpuVadMsAvg = this._lastStats.cpuVadMsAvg;
          }
          if (
            this._lastFramesDroppedSilence === null &&
            this._lastStats.framesDroppedSilence !== undefined
          ) {
            this._lastFramesDroppedSilence = this._lastStats.framesDroppedSilence;
          }
        }
        const finalReason: VoiceWsAsrFinalReason =
          this._lastFinalReason ?? (this._sentEos ? this._finishReason : "eos");
        this._complete(finalReason);
        return;
      }

      case "error": {
        const code = typeof ev.code === "number" ? ev.code : 500;
        const message = typeof ev.message === "string" && ev.message.trim() ? ev.message.trim() : "unknown";
        this._fail(new Error(`统一流式语音听写网关返回错误 (code=${code}: ${message})`));
        return;
      }

      default:
        return;
    }
  }

  private _complete(reason: VoiceWsAsrFinalReason): void {
    if (this._settled) return;
    this._settled = true;
    this._clearTimers();
    const durationMs = Math.round(performance.now() - this._startedAt);
    const text = this.latestText.trim();
    this._onMetric?.({
      latencyMs: durationMs,
      sessionId: this._sessionId,
      denoiseModel: this._denoiseModel,
      vadModel: this._vadModel,
      asrModel: this._asrModel,
      error: null,
    });
    this._safeClose();
    if (!this._aborted) {
      this._opts.onFinal?.({
        text,
        sessionId: this._sessionId,
        utteranceId: this._lastUtteranceId,
        language: this._lastLanguage,
        durationMs,
        audioDurationMs: this.audioDurationMs,
        speechMs: Math.round(this._totalSpeechMs),
        asrMs: Math.round(this._totalAsrMs || durationMs),
        cpuDenoiseMsAvg: this._lastCpuDenoiseMsAvg,
        cpuVadMsAvg: this._lastCpuVadMsAvg,
        framesDroppedSilence: this._lastFramesDroppedSilence,
        denoiseEnabled: this._denoise,
        denoiseModel: this._denoiseModel,
        vadModel: this._vadModel,
        asrModel: this._asrModel,
        reason,
        stats: this._lastStats,
      });
    }
    this._resolveWaiters(text);
  }

  private _fail(err: Error): void {
    if (this._settled) return;
    this._settled = true;
    this._clearTimers();
    const durationMs = Math.round(performance.now() - this._startedAt);
    const safeErr = new Error(redactVoiceWsError(err.message));
    this._onMetric?.({
      latencyMs: durationMs,
      sessionId: this._sessionId,
      denoiseModel: this._denoiseModel,
      vadModel: this._vadModel,
      asrModel: this._asrModel,
      error: safeErr.message,
    });
    this._safeClose();
    if (!this._aborted) {
      this._opts.onError?.(safeErr);
    }
    this._resolveWaiters(this.latestText.trim());
  }

  private _resolveWaiters(text: string): void {
    const waiters = this._doneResolvers;
    this._doneResolvers = [];
    for (const r of waiters) r(text);
  }

  private _clearConnectTimer(): void {
    if (this._connectTimer !== null) {
      clearTimeout(this._connectTimer);
      this._connectTimer = null;
    }
  }

  private _clearNoSpeechTimer(): void {
    if (this._noSpeechTimer !== null) {
      clearTimeout(this._noSpeechTimer);
      this._noSpeechTimer = null;
    }
  }

  private _clearFinishTimer(): void {
    if (this._finishTimer !== null) {
      clearTimeout(this._finishTimer);
      this._finishTimer = null;
    }
  }

  private _clearTimers(): void {
    this._clearConnectTimer();
    this._clearNoSpeechTimer();
    this._clearFinishTimer();
  }

  private _safeClose(): void {
    try {
      if (this._ws.readyState === WS_CONNECTING || this._ws.readyState === WS_OPEN) {
        this._ws.close(1000, "done");
      }
    } catch {
      // ignore close errors
    }
  }
}

/**
 * 统一流式语音降噪与听写网关运行时管理器（配置同步、状态快照、实时流创建、整段直推、连通性测试）。
 */
export class VoiceWsAsrRuntime {
  private _endpointUrl: string = DEFAULT_VOICE_WS_ASR_ENDPOINT;
  private _authCode = "";
  private _denoise = true;
  private _language: string | null = null;
  private _authMode: VoiceWsAuthMode = "header";
  private _denoiseModel: string | null = null;
  private _vadModel: string | null = null;
  private _asrModel: string | null = null;
  private _lastLatencyMs: number | null = null;
  private _lastSessionId: string | null = null;
  private _lastError: string | null = null;
  private _wsFactory: VoiceWsWebSocketFactory;
  private _disposed = false;

  constructor(
    options: VoiceWsAsrConfig & { wsFactory?: VoiceWsWebSocketFactory } = {},
  ) {
    this._wsFactory = options.wsFactory ?? defaultWebSocketFactory;
    this.setConfig(options);
  }

  setWebSocketFactory(factory: VoiceWsWebSocketFactory): void {
    this._wsFactory = factory;
  }

  setConfig(config: VoiceWsAsrConfig): void {
    const nextUrl =
      config.endpointUrl !== undefined
        ? normalizeVoiceWsAsrEndpointUrl(config.endpointUrl)
        : this._endpointUrl;
    const nextAuthCode = config.authCode !== undefined ? config.authCode.trim() : this._authCode;
    const nextDenoise = config.denoise !== undefined ? Boolean(config.denoise) : this._denoise;
    const nextLang =
      config.language !== undefined
        ? typeof config.language === "string" && config.language.trim()
          ? config.language.trim()
          : null
        : this._language;
    const nextAuthMode = config.authMode ?? this._authMode;

    const changed =
      nextUrl !== this._endpointUrl ||
      nextAuthCode !== this._authCode ||
      nextDenoise !== this._denoise ||
      nextLang !== this._language ||
      nextAuthMode !== this._authMode;

    this._endpointUrl = nextUrl;
    this._authCode = nextAuthCode;
    this._denoise = nextDenoise;
    this._language = nextLang;
    this._authMode = nextAuthMode;

    if (changed) {
      this._lastError = null;
    }
  }

  isConfigured(): boolean {
    return Boolean(this._endpointUrl && this._authCode.length > 0);
  }

  getStatus(): VoiceWsAsrStatus {
    const configured = this.isConfigured();
    return {
      configured,
      ready: configured && !this._disposed,
      endpointUrl: this._endpointUrl,
      hasAuthCode: this._authCode.length > 0,
      denoiseEnabled: this._denoise,
      language: this._language,
      denoiseModel: this._denoiseModel,
      vadModel: this._vadModel,
      asrModel: this._asrModel,
      lastLatencyMs: this._lastLatencyMs,
      lastSessionId: this._lastSessionId,
      lastError: !configured && this._endpointUrl && this._lastError ? this._lastError : this._lastError,
    };
  }

  createStreamSession(options: VoiceWsAsrStreamSessionOptions = {}): VoiceWsAsrStreamSession {
    if (!this.isConfigured()) {
      throw new Error("统一流式语音听写网关尚未配置授权码");
    }
    return new VoiceWsAsrStreamSession(
      {
        endpointUrl: this._endpointUrl,
        authCode: this._authCode,
        authMode: this._authMode,
      },
      {
        ...options,
        denoise: options.denoise !== undefined ? options.denoise : this._denoise,
        language: options.language !== undefined ? options.language : this._language,
      },
      this._wsFactory,
      ({ latencyMs, sessionId, denoiseModel, vadModel, asrModel, error }) => {
        this._lastLatencyMs = latencyMs;
        if (sessionId) this._lastSessionId = sessionId;
        if (denoiseModel) this._denoiseModel = denoiseModel;
        if (vadModel) this._vadModel = vadModel;
        if (asrModel) this._asrModel = asrModel;
        this._lastError = error;
      },
    );
  }

  /**
   * 将一段 16kHz 原始 Float32 PCM 直推至统一流式语音听写网关并等待最终识别结果（供 HTTP 上传与离线验证使用）。
   */
  async transcribePcm(
    samples16k: Float32Array,
    options: {
      denoise?: boolean;
      language?: string | null;
      context?: string;
      minSilenceMs?: number;
      partialIntervalMs?: number;
      connectTimeoutMs?: number;
      finishTimeoutMs?: number;
      onPartial?: (ev: VoiceWsAsrPartialEvent) => void;
    } = {},
  ): Promise<VoiceWsAsrTranscribePcmResult> {
    if (!this.isConfigured()) {
      throw new Error("统一流式语音听写网关尚未配置授权码");
    }
    if (samples16k.length === 0) {
      return {
        text: "",
        sessionId: null,
        language: null,
        durationMs: 0,
        audioDurationMs: 0,
        asrMs: 0,
        denoiseEnabled: options.denoise !== undefined ? options.denoise : this._denoise,
        denoiseModel: this._denoiseModel,
        vadModel: this._vadModel,
        asrModel: this._asrModel,
        stats: null,
        engine: "voice-ws-asr",
      };
    }

    return await new Promise<VoiceWsAsrTranscribePcmResult>((resolve, reject) => {
      let done = false;
      const session = this.createStreamSession({
        denoise: options.denoise,
        language: options.language,
        context: options.context,
        partialIntervalMs: options.partialIntervalMs,
        vad:
          options.minSilenceMs !== undefined
            ? { minSilenceMs: options.minSilenceMs }
            : undefined,
        stopOnFinal: false,
        noSpeechTimeoutMs: 0,
        connectTimeoutMs: options.connectTimeoutMs,
        finishTimeoutMs: options.finishTimeoutMs ?? 10_000,
        onPartial: options.onPartial,
        onFinal: (ev) => {
          if (done) return;
          done = true;
          resolve({
            text: ev.text,
            sessionId: ev.sessionId,
            language: ev.language,
            durationMs: ev.durationMs,
            audioDurationMs: ev.audioDurationMs,
            asrMs: ev.asrMs,
            denoiseEnabled: ev.denoiseEnabled,
            denoiseModel: ev.denoiseModel,
            vadModel: ev.vadModel,
            asrModel: ev.asrModel,
            stats: ev.stats,
            engine: "voice-ws-asr",
          });
        },
        onError: (err) => {
          if (done) return;
          done = true;
          reject(err);
        },
      });
      session.pushFloat32Samples(samples16k);
      void session.finish("client_finish");
    });
  }

  /**
   * 轻量端到端 WebSocket 握手与授权码连通性测试：发送 config + 160ms 静音 Binary 帧 + eos，验证鉴权、CPU ONNX 预处理与 GPU ASR 会话状态。
   */
  async testConnection(options: { timeoutMs?: number } = {}): Promise<VoiceWsAsrConnectionTestResult> {
    if (!this.isConfigured()) {
      return {
        ok: false,
        latencyMs: 0,
        sessionId: null,
        endpointUrl: this._endpointUrl,
        denoiseModel: this._denoiseModel,
        vadModel: this._vadModel,
        asrModel: this._asrModel,
        error: "请先填写统一流式语音听写网关地址与授权码",
      };
    }
    const timeoutMs = clampInt(options.timeoutMs, 1500, 15_000, 8000);
    const t0 = performance.now();
    try {
      const probeSamples = new Float32Array(Math.round(VOICE_WS_ASR_SAMPLE_RATE * 0.16)); // 160ms silence
      const res = await this.transcribePcm(probeSamples, {
        minSilenceMs: VOICE_WS_ASR_DEFAULT_MIN_SILENCE_MS,
        connectTimeoutMs: timeoutMs,
        finishTimeoutMs: timeoutMs,
      });
      const latencyMs = Math.round(performance.now() - t0);
      this._lastLatencyMs = latencyMs;
      if (res.sessionId) this._lastSessionId = res.sessionId;
      if (res.denoiseModel) this._denoiseModel = res.denoiseModel;
      if (res.vadModel) this._vadModel = res.vadModel;
      if (res.asrModel) this._asrModel = res.asrModel;
      this._lastError = null;
      return {
        ok: true,
        latencyMs,
        sessionId: res.sessionId,
        endpointUrl: this._endpointUrl,
        denoiseModel: res.denoiseModel,
        vadModel: res.vadModel,
        asrModel: res.asrModel,
      };
    } catch (err) {
      const latencyMs = Math.round(performance.now() - t0);
      const msg = redactVoiceWsError(err instanceof Error ? err.message : String(err));
      this._lastError = msg;
      return {
        ok: false,
        latencyMs,
        sessionId: this._lastSessionId,
        endpointUrl: this._endpointUrl,
        denoiseModel: this._denoiseModel,
        vadModel: this._vadModel,
        asrModel: this._asrModel,
        error: msg,
      };
    }
  }

  dispose(): void {
    this._disposed = true;
  }
}
