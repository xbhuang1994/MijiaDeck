// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * 讯飞语音听写大模型（中英）V2.0 WebSocket 实时流式客户端：
 *
 * 协议文档：https://www.xfyun.cn/doc/spark/spark_zh_iat_new.html
 * - 接口地址：wss://iat.cn-huabei-1.xf-yun.com/v1
 * - 鉴权方式：URL Query 携带 host / date (RFC1123 GMT) / authorization (HMAC-SHA256 Base64 签名)
 * - 音频格式：16kHz / 16bit / 单声道 原始 Little-Endian PCM（encoding="raw"，直推原始音频，不做额外降噪与特殊处理）
 * - 分帧发送：40ms / 1280 字节（或按官方建议 1024~1280 字节）流式 JSON 帧，支持首帧 status=0 / 中间帧 status=1 / 尾帧 status=2
 * - 动态修正：默认开启 dwa="wpgs"，支持 apd 追加与 rpl (rg=[start,end]) 实时替换，结合服务端 eos 自动静音判停。
 */

import crypto from "node:crypto";

export const DEFAULT_XFYUN_IAT_ENDPOINT = "wss://iat.cn-huabei-1.xf-yun.com/v1";
export const XFYUN_IAT_DOMAIN = "spark_asr_v2";
export const XFYUN_IAT_LANGUAGE = "zh_cn";
export const XFYUN_IAT_ACCENT = "mandarin";
export const XFYUN_SAMPLE_RATE = 16000;
export const XFYUN_FRAME_BYTES = 1280; // 40ms @ 16kHz 16-bit mono PCM
export const XFYUN_MIN_EOS_MS = 600;
export const XFYUN_MAX_EOS_MS = 60_000;
export const XFYUN_DEFAULT_EOS_MS = 1200;
export const XFYUN_MIN_BOS_MS = 10_000;
export const XFYUN_MAX_BOS_MS = 60_000;
export const XFYUN_DEFAULT_BOS_MS = 10_000;
export const XFYUN_MAX_AUDIO_MS = 58_000; // 官方限制单次 <= 60s，留 2s 安全余量主动收尾

export interface XfyunIatConfig {
  endpointUrl?: string;
  appId?: string;
  apiKey?: string;
  apiSecret?: string;
}

export interface XfyunIatStatus {
  configured: boolean;
  ready: boolean;
  endpointUrl: string;
  domain: string;
  hasAppId: boolean;
  hasApiKey: boolean;
  hasApiSecret: boolean;
  lastLatencyMs: number | null;
  lastSid: string | null;
  lastError: string | null;
}

export interface XfyunIatAuthUrlResult {
  wsUrl: string;
  host: string;
  date: string;
  signatureOrigin: string;
  signature: string;
  authorizationOrigin: string;
  authorization: string;
}

export interface XfyunDecodedCwItem {
  w?: string;
  wp?: string;
  sc?: number;
}

export interface XfyunDecodedWsItem {
  bg?: number;
  cw?: XfyunDecodedCwItem[];
}

export interface XfyunDecodedTextPayload {
  sn?: number;
  ls?: boolean;
  bg?: number;
  ed?: number;
  pgs?: "apd" | "rpl" | string;
  rg?: [number, number] | number[];
  rst?: "rlt" | "pgs" | string;
  ret?: number;
  ws?: XfyunDecodedWsItem[];
}

export interface XfyunStreamPartialEvent {
  text: string;
  stableText: string;
  unstableText: string;
  latencyMs: number;
  sn: number;
}

export type XfyunStreamFinalReason = "server_eos" | "client_finish" | "max_duration" | "server_close";

export interface XfyunStreamFinalEvent {
  text: string;
  sid: string | null;
  durationMs: number;
  audioDurationMs: number;
  reason: XfyunStreamFinalReason;
}

export interface XfyunWebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (ev: { data: unknown }) => void): void;
  addEventListener(type: "error", listener: (ev: unknown) => void): void;
  addEventListener(type: "close", listener: (ev: { code?: number; reason?: string }) => void): void;
}

export type XfyunWebSocketFactory = (url: string) => XfyunWebSocketLike;

export interface XfyunStreamSessionOptions {
  eosMs?: number;
  bosMs?: number;
  dwa?: boolean;
  resId?: string;
  maxDurationMs?: number;
  connectTimeoutMs?: number;
  finishTimeoutMs?: number;
  onPartial?: (ev: XfyunStreamPartialEvent) => void;
  onFinal?: (ev: XfyunStreamFinalEvent) => void;
  onError?: (err: Error) => void;
}

export interface XfyunTranscribePcmResult {
  text: string;
  sid: string | null;
  durationMs: number;
  audioDurationMs: number;
  engine: "xfyun-iat-v2";
}

export interface XfyunConnectionTestResult {
  ok: boolean;
  latencyMs: number;
  sid: string | null;
  endpointUrl: string;
  error?: string;
}

const WS_CONNECTING = 0;
const WS_OPEN = 1;

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function normalizeXfyunEndpointUrl(raw?: string): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return DEFAULT_XFYUN_IAT_ENDPOINT;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
      return DEFAULT_XFYUN_IAT_ENDPOINT;
    }
    const cleanPath = parsed.pathname && parsed.pathname !== "/" ? parsed.pathname.replace(/\/+$/, "") : "/v1";
    return `${parsed.origin}${cleanPath}`;
  } catch {
    return DEFAULT_XFYUN_IAT_ENDPOINT;
  }
}

/**
 * 按讯飞语音听写大模型 V2.0 文档生成 HMAC-SHA256 鉴权 WebSocket URL。
 */
export function buildXfyunIatAuthUrl(params: {
  endpointUrl?: string;
  apiKey: string;
  apiSecret: string;
  date?: string;
}): XfyunIatAuthUrlResult {
  const endpoint = normalizeXfyunEndpointUrl(params.endpointUrl);
  const u = new URL(endpoint);
  const host = u.host;
  const pathname = u.pathname || "/v1";
  const date = params.date ?? new Date().toUTCString();
  const signatureOrigin = `host: ${host}\ndate: ${date}\nGET ${pathname} HTTP/1.1`;
  const signature = crypto
    .createHmac("sha256", params.apiSecret)
    .update(signatureOrigin)
    .digest("base64");
  const authorizationOrigin = `api_key="${params.apiKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`;
  const authorization = Buffer.from(authorizationOrigin, "utf-8").toString("base64");
  const search = new URLSearchParams({
    host,
    date,
    authorization,
  });
  return {
    wsUrl: `${u.origin}${pathname}?${search.toString()}`,
    host,
    date,
    signatureOrigin,
    signature,
    authorizationOrigin,
    authorization,
  };
}

/**
 * 将原始 16kHz Float32 [-1, 1] PCM 无损直转为 Little-Endian Int16 字节数组（零滤波/零降噪/零增益修改）。
 */
export function float32ToInt16LeBytes(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    const int16 = Math.max(-0x8000, Math.min(0x7fff, Math.round(s * 0x8000)));
    view.setInt16(i * 2, int16, true);
  }
  return out;
}

/**
 * 解析讯飞 V2.0 返回帧中 base64 编码的 text 字段，并维护 wpgs 动态修正（apd 追加 / rpl 范围替换）状态。
 */
export class XfyunWpgsTranscriptAssembler {
  private readonly _segments = new Map<number, { text: string; finalized: boolean }>();
  private _lastSn = 0;

  ingest(
    decoded: XfyunDecodedTextPayload,
    resultMeta?: { pgs?: string; rg?: number[]; rst?: string },
  ): {
    text: string;
    stableText: string;
    unstableText: string;
    sn: number;
    isLast: boolean;
    retErrorCode: number | null;
  } {
    if (typeof decoded.ret === "number" && decoded.ret !== 0) {
      return {
        text: this.getText(),
        stableText: this.getStableText(),
        unstableText: this.getUnstableText(),
        sn: typeof decoded.sn === "number" ? decoded.sn : this._lastSn,
        isLast: Boolean(decoded.ls),
        retErrorCode: decoded.ret,
      };
    }

    const sn = typeof decoded.sn === "number" && Number.isFinite(decoded.sn)
      ? decoded.sn
      : this._lastSn + 1;
    this._lastSn = Math.max(this._lastSn, sn);

    const pgs = decoded.pgs ?? resultMeta?.pgs;
    const rg = decoded.rg ?? resultMeta?.rg;
    const rst = decoded.rst ?? resultMeta?.rst;

    if (pgs === "rpl" && Array.isArray(rg) && rg.length >= 2) {
      const startSn = Number(rg[0]);
      const endSn = Number(rg[1]);
      if (Number.isFinite(startSn) && Number.isFinite(endSn)) {
        for (const key of Array.from(this._segments.keys())) {
          if (key >= startSn && key <= endSn) {
            this._segments.delete(key);
          }
        }
      }
    }

    let pieceText = "";
    if (Array.isArray(decoded.ws)) {
      for (const item of decoded.ws) {
        if (!item || !Array.isArray(item.cw) || item.cw.length === 0) continue;
        const best = item.cw[0];
        if (best && typeof best.w === "string") {
          pieceText += best.w;
        }
      }
    }

    this._segments.set(sn, {
      text: pieceText,
      finalized: rst === "rlt" || decoded.ls === true || pgs === undefined,
    });

    const { text, stableText, unstableText } = this._renderParts();
    return {
      text,
      stableText,
      unstableText,
      sn,
      isLast: decoded.ls === true,
      retErrorCode: null,
    };
  }

  private _renderParts(): { text: string; stableText: string; unstableText: string } {
    const keys = Array.from(this._segments.keys()).sort((a, b) => a - b);
    let text = "";
    let stableText = "";
    let stillStable = true;
    for (const k of keys) {
      const seg = this._segments.get(k);
      if (!seg) continue;
      text += seg.text;
      if (stillStable && seg.finalized) {
        stableText += seg.text;
      } else {
        stillStable = false;
      }
    }
    const unstableText = text.startsWith(stableText) ? text.slice(stableText.length) : text;
    return { text, stableText, unstableText };
  }

  getText(): string {
    return this._renderParts().text;
  }

  getStableText(): string {
    return this._renderParts().stableText;
  }

  getUnstableText(): string {
    return this._renderParts().unstableText;
  }

  reset(): void {
    this._segments.clear();
    this._lastSn = 0;
  }
}

function defaultWebSocketFactory(url: string): XfyunWebSocketLike {
  return new WebSocket(url) as unknown as XfyunWebSocketLike;
}

function redactXfyunError(raw: string): string {
  return raw
    .replace(/(authorization|api_key|apiKey|apiSecret|signature)\s*[:=]\s*[^\s,&'"]+/gi, "$1=<redacted>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220);
}

/**
 * 单次讯飞语音听写大模型 V2.0 实时 WebSocket 流式会话。
 * 支持握手阶段自动缓存待发原始 PCM 帧，连接就绪后零丢失直推；支持服务端 eos 自动收尾与客户端主动 finish。
 */
export class XfyunIatV2StreamSession {
  private readonly _appId: string;
  private readonly _eosMs: number;
  private readonly _bosMs: number;
  private readonly _dwa: boolean;
  private readonly _resId: string;
  private readonly _maxAudioBytes: number;
  private readonly _finishTimeoutMs: number;
  private readonly _opts: XfyunStreamSessionOptions;
  private readonly _ws: XfyunWebSocketLike;
  private readonly _assembler = new XfyunWpgsTranscriptAssembler();
  private readonly _startedAt = performance.now();

  private _pendingFrames: Uint8Array[] = [];
  private _pendingFinish = false;
  private _finishReason: XfyunStreamFinalReason = "server_eos";
  private _seq = 0;
  private _sentFirstFrame = false;
  private _sentLastFrame = false;
  private _totalAudioBytes = 0;
  private _sid: string | null = null;
  private _settled = false;
  private _aborted = false;
  private _connectTimer: ReturnType<typeof setTimeout> | null = null;
  private _finishTimer: ReturnType<typeof setTimeout> | null = null;
  private _doneResolvers: Array<(text: string) => void> = [];
  private readonly _onMetric?: (metric: { latencyMs: number; sid: string | null; error: string | null }) => void;

  constructor(
    auth: {
      endpointUrl: string;
      appId: string;
      apiKey: string;
      apiSecret: string;
    },
    options: XfyunStreamSessionOptions = {},
    wsFactory: XfyunWebSocketFactory = defaultWebSocketFactory,
    onMetric?: (metric: { latencyMs: number; sid: string | null; error: string | null }) => void,
  ) {
    this._appId = auth.appId;
    this._eosMs = clampInt(options.eosMs, XFYUN_MIN_EOS_MS, XFYUN_MAX_EOS_MS, XFYUN_DEFAULT_EOS_MS);
    this._bosMs = clampInt(options.bosMs, XFYUN_MIN_BOS_MS, XFYUN_MAX_BOS_MS, XFYUN_DEFAULT_BOS_MS);
    this._dwa = options.dwa !== false;
    this._resId = (options.resId ?? "").trim();
    const maxMs = clampInt(options.maxDurationMs, 2000, XFYUN_MAX_AUDIO_MS, XFYUN_MAX_AUDIO_MS);
    this._maxAudioBytes = Math.round((XFYUN_SAMPLE_RATE * 2 * maxMs) / 1000);
    this._finishTimeoutMs = clampInt(options.finishTimeoutMs, 500, 15_000, 6000);
    this._opts = options;
    this._onMetric = onMetric;

    const { wsUrl } = buildXfyunIatAuthUrl({
      endpointUrl: auth.endpointUrl,
      apiKey: auth.apiKey,
      apiSecret: auth.apiSecret,
    });
    this._ws = wsFactory(wsUrl);

    const connectTimeoutMs = clampInt(options.connectTimeoutMs, 1000, 20_000, 8000);
    this._connectTimer = setTimeout(() => {
      this._connectTimer = null;
      if (!this._settled && this._ws.readyState === WS_CONNECTING) {
        this._fail(new Error(`讯飞语音听写连接超时 (${connectTimeoutMs}ms)`));
      }
    }, connectTimeoutMs);
    (this._connectTimer as { unref?: () => void }).unref?.();

    this._ws.addEventListener("open", () => {
      this._clearConnectTimer();
      if (this._settled || this._aborted) {
        this._safeClose();
        return;
      }
      this._flushPendingQueue();
    });

    this._ws.addEventListener("message", (ev) => {
      if (this._settled || this._aborted) return;
      this._handleMessage(ev.data);
    });

    this._ws.addEventListener("error", () => {
      if (this._settled || this._aborted) return;
      this._fail(new Error("讯飞语音听写 WebSocket 连接异常"));
    });

    this._ws.addEventListener("close", (ev) => {
      this._clearConnectTimer();
      this._clearFinishTimer();
      if (this._settled || this._aborted) return;
      const assembled = this._assembler.getText().trim();
      if (assembled.length > 0 || this._sentLastFrame) {
        this._complete(this._sentLastFrame ? this._finishReason : "server_close");
        return;
      }
      const code = typeof ev?.code === "number" ? ev.code : 1006;
      const reason = typeof ev?.reason === "string" && ev.reason.trim() ? `: ${ev.reason.trim()}` : "";
      if (code === 1000 || code === 1005) {
        this._complete("server_close");
      } else {
        this._fail(new Error(`讯飞语音听写连接已关闭 (code=${code}${reason})`));
      }
    });
  }

  get isActive(): boolean {
    return !this._settled && !this._aborted;
  }

  get sid(): string | null {
    return this._sid;
  }

  get latestText(): string {
    return this._assembler.getText();
  }

  get audioDurationMs(): number {
    return Math.round((this._totalAudioBytes / (XFYUN_SAMPLE_RATE * 2)) * 1000);
  }

  pushFloat32Samples(samples: Float32Array): void {
    if (this._settled || this._aborted || this._sentLastFrame || samples.length === 0) return;
    this.pushInt16Bytes(float32ToInt16LeBytes(samples));
  }

  pushInt16Bytes(bytes: Uint8Array): void {
    if (this._settled || this._aborted || this._sentLastFrame || bytes.byteLength === 0) return;

    const remainingBudget = this._maxAudioBytes - this._totalAudioBytes;
    if (remainingBudget <= 0) {
      void this.finish("max_duration");
      return;
    }

    const slice = bytes.byteLength > remainingBudget ? bytes.subarray(0, remainingBudget) : bytes;
    for (let off = 0; off < slice.byteLength; off += XFYUN_FRAME_BYTES) {
      const end = Math.min(slice.byteLength, off + XFYUN_FRAME_BYTES);
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

  finish(reason: "client_finish" | "max_duration" = "client_finish"): Promise<string> {
    if (this._settled) {
      return Promise.resolve(this._assembler.getText().trim());
    }
    this._finishReason = reason;
    const waitPromise = new Promise<string>((resolve) => {
      this._doneResolvers.push(resolve);
    });

    if (!this._sentLastFrame) {
      if (this._ws.readyState === WS_OPEN) {
        this._sendFinalFrame();
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
    this._clearConnectTimer();
    this._clearFinishTimer();
    this._safeClose();
    this._resolveWaiters("");
  }

  private _flushPendingQueue(): void {
    const queued = this._pendingFrames;
    this._pendingFrames = [];
    for (const frame of queued) {
      if (this._settled || this._aborted || this._ws.readyState !== WS_OPEN) return;
      this._sendAudioFrame(frame);
    }
    if (this._pendingFinish && !this._sentLastFrame && this._ws.readyState === WS_OPEN) {
      this._pendingFinish = false;
      this._sendFinalFrame();
    }
  }

  private _buildHeader(status: 0 | 1 | 2): Record<string, unknown> {
    const header: Record<string, unknown> = {
      app_id: this._appId,
      status,
    };
    if (this._resId) {
      header.res_id = this._resId;
    }
    return header;
  }

  private _buildParameter(): Record<string, unknown> {
    const iat: Record<string, unknown> = {
      domain: XFYUN_IAT_DOMAIN,
      language: XFYUN_IAT_LANGUAGE,
      accent: XFYUN_IAT_ACCENT,
      eos: this._eosMs,
      bos: this._bosMs,
      result: {
        encoding: "utf8",
        compress: "raw",
        format: "json",
      },
    };
    if (this._dwa) {
      iat.dwa = "wpgs";
    }
    return { iat };
  }

  private _sendAudioFrame(pcmBytes: Uint8Array): void {
    if (this._settled || this._aborted || this._sentLastFrame) return;
    const isFirst = !this._sentFirstFrame;
    this._sentFirstFrame = true;
    this._seq += 1;
    const status: 0 | 1 = isFirst ? 0 : 1;
    const payload: Record<string, unknown> = {
      header: this._buildHeader(status),
      payload: {
        audio: {
          encoding: "raw",
          sample_rate: XFYUN_SAMPLE_RATE,
          channels: 1,
          bit_depth: 16,
          seq: this._seq,
          status,
          audio: Buffer.from(pcmBytes).toString("base64"),
        },
      },
    };
    if (isFirst) {
      payload.parameter = this._buildParameter();
    }
    try {
      this._ws.send(JSON.stringify(payload));
    } catch (err) {
      this._fail(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private _sendFinalFrame(): void {
    if (this._settled || this._aborted || this._sentLastFrame) return;
    // 若从未发送过首帧（例如空音频 flush），先补发空首帧以符合协议要求
    if (!this._sentFirstFrame) {
      this._sentFirstFrame = true;
      this._seq += 1;
      const firstPayload: Record<string, unknown> = {
        header: this._buildHeader(0),
        parameter: this._buildParameter(),
        payload: {
          audio: {
            encoding: "raw",
            sample_rate: XFYUN_SAMPLE_RATE,
            channels: 1,
            bit_depth: 16,
            seq: this._seq,
            status: 0,
            audio: "",
          },
        },
      };
      try {
        this._ws.send(JSON.stringify(firstPayload));
      } catch (err) {
        this._fail(err instanceof Error ? err : new Error(String(err)));
        return;
      }
    }
    this._sentLastFrame = true;
    this._seq += 1;
    const endPayload = {
      header: this._buildHeader(2),
      payload: {
        audio: {
          encoding: "raw",
          sample_rate: XFYUN_SAMPLE_RATE,
          channels: 1,
          bit_depth: 16,
          seq: this._seq,
          status: 2,
          audio: "",
        },
      },
    };
    try {
      this._ws.send(JSON.stringify(endPayload));
    } catch (err) {
      this._fail(err instanceof Error ? err : new Error(String(err)));
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

    let parsed: {
      header?: {
        code?: number;
        message?: string;
        sid?: string;
        status?: number;
      };
      payload?: {
        result?: {
          text?: string;
          status?: number;
          seq?: number;
          pgs?: string;
          rg?: number[];
          rst?: string;
        };
      };
    };
    try {
      parsed = JSON.parse(rawText);
    } catch {
      return;
    }

    const header = parsed.header;
    if (header?.sid && typeof header.sid === "string") {
      this._sid = header.sid;
    }
    if (typeof header?.code === "number" && header.code !== 0) {
      const errMsg = `讯飞语音听写返回错误 (code=${header.code}: ${header.message || "unknown"})`;
      this._fail(new Error(errMsg));
      return;
    }

    const result = parsed.payload?.result;
    let isLast = header?.status === 2 || result?.status === 2;

    if (result?.text && typeof result.text === "string") {
      try {
        const jsonStr = Buffer.from(result.text, "base64").toString("utf-8");
        const decoded = JSON.parse(jsonStr) as XfyunDecodedTextPayload;
        const step = this._assembler.ingest(decoded, {
          pgs: result.pgs,
          rg: result.rg,
          rst: result.rst,
        });
        if (step.retErrorCode !== null) {
          this._fail(new Error(`讯飞语音听写服务异常 (ret=${step.retErrorCode})`));
          return;
        }
        if (step.isLast) {
          isLast = true;
        }
        if (step.text.trim()) {
          this._opts.onPartial?.({
            text: step.text,
            stableText: step.stableText,
            unstableText: step.unstableText,
            latencyMs: Math.round(performance.now() - this._startedAt),
            sn: step.sn,
          });
        }
      } catch {
        // ignore malformed partial payload
      }
    }

    if (isLast) {
      const finalReason: XfyunStreamFinalReason = this._sentLastFrame
        ? this._finishReason
        : "server_eos";
      this._complete(finalReason);
    }
  }

  private _complete(reason: XfyunStreamFinalReason): void {
    if (this._settled) return;
    this._settled = true;
    this._clearConnectTimer();
    this._clearFinishTimer();
    const durationMs = Math.round(performance.now() - this._startedAt);
    const text = this._assembler.getText().trim();
    this._onMetric?.({ latencyMs: durationMs, sid: this._sid, error: null });
    this._safeClose();
    if (!this._aborted) {
      this._opts.onFinal?.({
        text,
        sid: this._sid,
        durationMs,
        audioDurationMs: this.audioDurationMs,
        reason,
      });
    }
    this._resolveWaiters(text);
  }

  private _fail(err: Error): void {
    if (this._settled) return;
    this._settled = true;
    this._clearConnectTimer();
    this._clearFinishTimer();
    const durationMs = Math.round(performance.now() - this._startedAt);
    const safeErr = new Error(redactXfyunError(err.message));
    this._onMetric?.({ latencyMs: durationMs, sid: this._sid, error: safeErr.message });
    this._safeClose();
    if (!this._aborted) {
      this._opts.onError?.(safeErr);
    }
    this._resolveWaiters(this._assembler.getText().trim());
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

  private _clearFinishTimer(): void {
    if (this._finishTimer !== null) {
      clearTimeout(this._finishTimer);
      this._finishTimer = null;
    }
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
 * 讯飞语音听写大模型 2.0 运行时管理器（配置同步、状态快照、实时流创建、离线整段直推、连通性测试）。
 */
export class XfyunIatV2Runtime {
  private _endpointUrl: string = DEFAULT_XFYUN_IAT_ENDPOINT;
  private _appId = "";
  private _apiKey = "";
  private _apiSecret = "";
  private _lastLatencyMs: number | null = null;
  private _lastSid: string | null = null;
  private _lastError: string | null = null;
  private _wsFactory: XfyunWebSocketFactory;
  private _disposed = false;

  constructor(
    options: XfyunIatConfig & { wsFactory?: XfyunWebSocketFactory } = {},
  ) {
    this._wsFactory = options.wsFactory ?? defaultWebSocketFactory;
    this.setConfig(options);
  }

  setWebSocketFactory(factory: XfyunWebSocketFactory): void {
    this._wsFactory = factory;
  }

  setConfig(config: XfyunIatConfig): void {
    const nextUrl =
      config.endpointUrl !== undefined
        ? normalizeXfyunEndpointUrl(config.endpointUrl)
        : this._endpointUrl;
    const nextAppId = config.appId !== undefined ? config.appId.trim() : this._appId;
    const nextApiKey = config.apiKey !== undefined ? config.apiKey.trim() : this._apiKey;
    const nextApiSecret = config.apiSecret !== undefined ? config.apiSecret.trim() : this._apiSecret;

    const changed =
      nextUrl !== this._endpointUrl ||
      nextAppId !== this._appId ||
      nextApiKey !== this._apiKey ||
      nextApiSecret !== this._apiSecret;

    this._endpointUrl = nextUrl;
    this._appId = nextAppId;
    this._apiKey = nextApiKey;
    this._apiSecret = nextApiSecret;

    if (changed) {
      this._lastError = null;
    }
  }

  isConfigured(): boolean {
    return Boolean(
      this._endpointUrl &&
        this._appId.length > 0 &&
        this._apiKey.length > 0 &&
        this._apiSecret.length > 0,
    );
  }

  getStatus(): XfyunIatStatus {
    const configured = this.isConfigured();
    const missingParts: string[] = [];
    if (!this._appId) missingParts.push("APPID");
    if (!this._apiKey) missingParts.push("APIKey");
    if (!this._apiSecret) missingParts.push("APISecret");
    return {
      configured,
      ready: configured && !this._disposed,
      endpointUrl: this._endpointUrl,
      domain: XFYUN_IAT_DOMAIN,
      hasAppId: this._appId.length > 0,
      hasApiKey: this._apiKey.length > 0,
      hasApiSecret: this._apiSecret.length > 0,
      lastLatencyMs: this._lastLatencyMs,
      lastSid: this._lastSid,
      lastError:
        !configured && (this._appId || this._apiKey || this._apiSecret)
          ? `讯飞听写 2.0 缺少配置：${missingParts.join(" / ")}`
          : this._lastError,
    };
  }

  createStreamSession(options: XfyunStreamSessionOptions = {}): XfyunIatV2StreamSession {
    if (!this.isConfigured()) {
      throw new Error("讯飞语音听写大模型 2.0 尚未完整配置（需要 APPID、APIKey 与 APISecret）");
    }
    return new XfyunIatV2StreamSession(
      {
        endpointUrl: this._endpointUrl,
        appId: this._appId,
        apiKey: this._apiKey,
        apiSecret: this._apiSecret,
      },
      options,
      this._wsFactory,
      ({ latencyMs, sid, error }) => {
        this._lastLatencyMs = latencyMs;
        if (sid) this._lastSid = sid;
        this._lastError = error;
      },
    );
  }

  /**
   * 将一段 16kHz 原始 Float32 PCM 直推至讯飞语音听写大模型 2.0 并等待最终识别文本（供 HTTP 上传兜底与离线验证使用）。
   */
  async transcribePcm(
    samples16k: Float32Array,
    options: {
      eosMs?: number;
      bosMs?: number;
      dwa?: boolean;
      connectTimeoutMs?: number;
      finishTimeoutMs?: number;
      onPartial?: (ev: XfyunStreamPartialEvent) => void;
    } = {},
  ): Promise<XfyunTranscribePcmResult> {
    if (!this.isConfigured()) {
      throw new Error("讯飞语音听写大模型 2.0 尚未完整配置（需要 APPID、APIKey 与 APISecret）");
    }
    if (samples16k.length === 0) {
      return {
        text: "",
        sid: null,
        durationMs: 0,
        audioDurationMs: 0,
        engine: "xfyun-iat-v2",
      };
    }

    return await new Promise<XfyunTranscribePcmResult>((resolve, reject) => {
      let done = false;
      const session = this.createStreamSession({
        eosMs: options.eosMs,
        bosMs: options.bosMs,
        dwa: options.dwa ?? true,
        connectTimeoutMs: options.connectTimeoutMs,
        finishTimeoutMs: options.finishTimeoutMs ?? 8000,
        onPartial: options.onPartial,
        onFinal: (ev) => {
          if (done) return;
          done = true;
          resolve({
            text: ev.text,
            sid: ev.sid,
            durationMs: ev.durationMs,
            audioDurationMs: ev.audioDurationMs,
            engine: "xfyun-iat-v2",
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
   * 轻量端到端握手与鉴权连通性测试：发送 160ms 静音首帧并立即收尾，验证 APPID/APIKey/APISecret 鉴权与服务可达性。
   */
  async testConnection(options: { timeoutMs?: number } = {}): Promise<XfyunConnectionTestResult> {
    if (!this.isConfigured()) {
      return {
        ok: false,
        latencyMs: 0,
        sid: null,
        endpointUrl: this._endpointUrl,
        error: "请先完整填写讯飞 APPID、APIKey 与 APISecret",
      };
    }
    const timeoutMs = clampInt(options.timeoutMs, 1500, 15_000, 8000);
    const t0 = performance.now();
    try {
      const probeSamples = new Float32Array(Math.round(XFYUN_SAMPLE_RATE * 0.16)); // 160ms raw silence
      const res = await this.transcribePcm(probeSamples, {
        eosMs: XFYUN_MIN_EOS_MS,
        connectTimeoutMs: timeoutMs,
        finishTimeoutMs: timeoutMs,
      });
      const latencyMs = Math.round(performance.now() - t0);
      this._lastLatencyMs = latencyMs;
      if (res.sid) this._lastSid = res.sid;
      this._lastError = null;
      return {
        ok: true,
        latencyMs,
        sid: res.sid,
        endpointUrl: this._endpointUrl,
      };
    } catch (err) {
      const latencyMs = Math.round(performance.now() - t0);
      const msg = redactXfyunError(err instanceof Error ? err.message : String(err));
      this._lastError = msg;
      return {
        ok: false,
        latencyMs,
        sid: this._lastSid,
        endpointUrl: this._endpointUrl,
        error: msg,
      };
    }
  }

  dispose(): void {
    this._disposed = true;
  }
}
