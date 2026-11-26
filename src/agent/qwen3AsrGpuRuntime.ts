// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * 在线 Qwen3-ASR (Voice & ASR Gateway) 语音识别运行时：
 *
 * - 仅支持通过在线 Voice & ASR Gateway（OpenAI Whisper 兼容 /v1/audio/transcriptions 或 /v1/transcribe）
 *   调用远端 GPU 部署的 Qwen3-ASR-0.6B 模型；
 * - 支持多语言识别、热词上下文提示与静音防幻觉语言映射；
 * - 在线网关未配置或临时异常时进入短冷却窗口，由上层自动平滑回落至本地备用 SenseVoice 方案。
 */

import { DEFAULT_QWEN3_ASR_MODEL, isLocalEndpointUrl } from "../core/agentConfigStore.ts";
import { encodeWavPcm16 } from "./audioPcm.ts";

export type GpuBackendKind = "remote" | "none";

export interface Qwen3GpuStatus {
  detected: boolean;
  backend: GpuBackendKind;
  remote: boolean;
  serviceUrl: string | null;
  modelName: string;
  deviceId: string | null;
  deviceName: string | null;
  vramTotalMb: number | null;
  vramFreeMb: number | null;
  runtimeReady: boolean;
  modelReady: boolean;
  ready: boolean;
  serverRunning: boolean;
  lastLatencyMs: number | null;
  lastError: string | null;
}

export interface Qwen3AsrGatewayEndpoints {
  rootUrl: string;
  healthUrl: string;
  modelsUrl: string;
  transcriptionsUrl: string;
  transcribeJsonUrl: string;
  preferJsonTranscribe: boolean;
}

export interface Qwen3RemoteHealthResult {
  ok: boolean;
  latencyMs: number;
  gpuName: string | null;
  model: string | null;
  supportedLanguagesCount: number | null;
  error?: string;
}

/**
 * 规范化在线 Voice & ASR Gateway 的 Qwen3-ASR 接口路径：
 * 支持传入根地址（https://voice.1inch.cn:18443）、/v1、/asr、/asr/v1、
 * /v1/audio/transcriptions、/asr/v1/audio/transcriptions 或 /v1/transcribe。
 */
export function resolveQwen3AsrGatewayEndpoints(serviceUrl: string): Qwen3AsrGatewayEndpoints {
  const trimmed = serviceUrl.trim().replace(/\/+$/, "");
  const isExplicitTranscriptions = /\/audio\/transcriptions$/i.test(trimmed);
  const isExplicitJsonTranscribe = /\/v1\/transcribe$/i.test(trimmed);
  const rootUrl = trimmed
    .replace(/\/asr\/v1\/audio\/transcriptions$/i, "")
    .replace(/\/v1\/audio\/transcriptions$/i, "")
    .replace(/\/audio\/transcriptions$/i, "")
    .replace(/\/v1\/transcribe$/i, "")
    .replace(/\/asr\/v1$/i, "")
    .replace(/\/asr$/i, "")
    .replace(/\/v1$/i, "")
    .replace(/\/+$/, "");
  return {
    rootUrl,
    healthUrl: `${rootUrl}/health`,
    modelsUrl: `${rootUrl}/v1/models`,
    transcriptionsUrl: isExplicitTranscriptions ? trimmed : `${rootUrl}/v1/audio/transcriptions`,
    transcribeJsonUrl: isExplicitJsonTranscribe ? trimmed : `${rootUrl}/v1/transcribe`,
    preferJsonTranscribe: isExplicitJsonTranscribe,
  };
}

/**
 * 将 UI 语种映射为在线 Qwen3-ASR 网关的 language 参数：
 * 中文（zh-CN / zh）与 auto 留空以启用原生中英混说自动识别并防止静音幻觉。
 */
export function mapQwen3GatewayLang(voiceLang?: string): string {
  const lower = (voiceLang ?? "").trim().toLowerCase();
  if (!lower || lower === "auto" || lower === "zh" || lower.startsWith("zh-cn")) return "";
  if (lower.startsWith("zh-hk") || lower.includes("yue")) return "Cantonese";
  if (lower.startsWith("en")) return "English";
  if (lower.startsWith("ja")) return "Japanese";
  if (lower.startsWith("ko")) return "Korean";
  return "";
}

export interface Qwen3GpuTranscribeOptions {
  voiceLang?: string;
  hotwords?: readonly string[];
  maxTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  onPartial?: (partialText: string) => void;
}

export interface Qwen3GpuTranscribeResult {
  text: string;
  rawText: string;
  lang: string;
  durationMs: number;
  deviceId: string | null;
  deviceName: string | null;
  backend: GpuBackendKind;
}

const GPU_INIT_RETRY_COOLDOWN_MS = 30_000;

/**
 * 清洗 Qwen3-ASR 响应中可能带有的 `<asr_text>` / `<think>` / 语言脚手架标签。
 */
export function parseQwen3GpuResponseText(raw: string): string {
  return String(raw ?? "")
    .replace(/<think>[\s\S]*?<\/think>/gi, " ")
    .replace(/^\s*language\s+[A-Za-z_-]+\s*<asr_text>\s*/i, "")
    .replace(/<asr_text>/gi, " ")
    .replace(/<\|[^|>]+\|>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export class Qwen3AsrGpuRuntime {
  private readonly _fetcher: typeof fetch;
  private _remoteServiceUrl = "";
  private _remoteApiKey = "";
  private _remoteModel = DEFAULT_QWEN3_ASR_MODEL;
  private _remoteGpuName: string | null = null;
  private _remoteLastLatencyMs: number | null = null;
  private _warmedUp = false;
  private _initFailedAt = 0;
  private _lastError: string | null = null;
  private _disposed = false;

  constructor(
    options: {
      serviceUrl?: string;
      apiKey?: string;
      model?: string;
      fetcher?: typeof fetch;
    } = {},
  ) {
    this._fetcher = options.fetcher ?? globalThis.fetch;
    if (options.serviceUrl || options.apiKey || options.model) {
      this.setRemoteConfig({
        serviceUrl: options.serviceUrl ?? "",
        apiKey: options.apiKey ?? "",
        model: options.model ?? DEFAULT_QWEN3_ASR_MODEL,
      });
    }
  }

  get remoteServiceUrl(): string {
    return this._remoteServiceUrl;
  }

  get remoteModel(): string {
    return this._remoteModel;
  }

  isRemoteConfigured(): boolean {
    return (
      this._remoteServiceUrl.length > 0 &&
      (this._remoteApiKey.length > 0 || isLocalEndpointUrl(this._remoteServiceUrl))
    );
  }

  private _buildAuthHeaders(): Record<string, string> {
    if (!this._remoteApiKey) return {};
    return {
      Authorization: `Bearer ${this._remoteApiKey}`,
      "X-Auth-Code": this._remoteApiKey,
    };
  }

  setRemoteConfig(config: { serviceUrl?: string; apiKey?: string; model?: string }): void {
    const nextUrl =
      config.serviceUrl !== undefined
        ? config.serviceUrl.trim().replace(/\/+$/, "")
        : this._remoteServiceUrl;
    const nextKey = config.apiKey !== undefined ? config.apiKey.trim() : this._remoteApiKey;
    const nextModel =
      config.model !== undefined
        ? config.model.trim() || DEFAULT_QWEN3_ASR_MODEL
        : this._remoteModel;

    const urlChanged = nextUrl !== this._remoteServiceUrl;
    const keyChanged = nextKey !== this._remoteApiKey;
    this._remoteServiceUrl = nextUrl;
    this._remoteApiKey = nextKey;
    this._remoteModel = nextModel;

    if (urlChanged || keyChanged) {
      if (urlChanged) {
        this._remoteGpuName = null;
        this._remoteLastLatencyMs = null;
      }
      this._warmedUp = false;
      this.resetFailureCooldown();
    }
  }

  isInFailureCooldown(): boolean {
    return (
      this._initFailedAt > 0 && Date.now() - this._initFailedAt < GPU_INIT_RETRY_COOLDOWN_MS
    );
  }

  resetFailureCooldown(): void {
    this._initFailedAt = 0;
    this._lastError = null;
  }

  getStatus(): Qwen3GpuStatus {
    const hasRemoteUrl = this._remoteServiceUrl.length > 0;
    const remoteReady = this.isRemoteConfigured();
    return {
      detected: remoteReady,
      backend: remoteReady ? "remote" : "none",
      remote: remoteReady,
      serviceUrl: hasRemoteUrl ? this._remoteServiceUrl : null,
      modelName: this._remoteModel,
      deviceId: remoteReady ? "remote" : null,
      deviceName: remoteReady ? (this._remoteGpuName ?? "在线 Qwen3-ASR GPU") : null,
      vramTotalMb: null,
      vramFreeMb: null,
      runtimeReady: remoteReady,
      modelReady: remoteReady,
      ready: remoteReady,
      serverRunning: remoteReady,
      lastLatencyMs: this._remoteLastLatencyMs,
      lastError:
        hasRemoteUrl && !remoteReady ? "缺少在线 Qwen3-ASR 授权码，请填写授权码" : this._lastError,
    };
  }

  /**
   * 探测在线 Qwen3-ASR 网关健康状态，获取远端 GPU 名称与模型信息。
   */
  async probeRemoteHealth(options: { timeoutMs?: number } = {}): Promise<Qwen3RemoteHealthResult> {
    if (!this._remoteServiceUrl) {
      return {
        ok: false,
        latencyMs: 0,
        gpuName: null,
        model: null,
        supportedLanguagesCount: null,
        error: "未配置在线 Qwen3-ASR 服务地址",
      };
    }
    const t0 = performance.now();
    const endpoints = resolveQwen3AsrGatewayEndpoints(this._remoteServiceUrl);
    const timeoutMs = options.timeoutMs ?? 8000;
    try {
      const res = await this._fetcher(endpoints.healthUrl, {
        method: "GET",
        headers: this._buildAuthHeaders(),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const latencyMs = Math.round(performance.now() - t0);
      if (!res.ok) {
        const msg =
          res.status === 401
            ? "Qwen3-ASR 授权码无效或未提供 (401)"
            : res.status === 403
              ? "Qwen3-ASR 授权码缺少 asr 服务权限 (403)"
              : `Qwen3-ASR 远程健康检查失败 (${res.status})`;
        this._lastError = msg;
        if (res.status === 401 || res.status === 403) {
          this._initFailedAt = Date.now();
        }
        return {
          ok: false,
          latencyMs,
          gpuName: this._remoteGpuName,
          model: this._remoteModel,
          supportedLanguagesCount: null,
          error: msg,
        };
      }
      const json = (await res.json()) as {
        status?: string;
        model?: string;
        gpu_name?: string | null;
        supported_languages_count?: number;
        upstreams?: {
          asr?: {
            status?: string;
            details?: {
              status?: string;
              model?: string;
              gpu_name?: string | null;
              supported_languages_count?: number;
            };
          };
        };
      };
      const asrUpstream = json.upstreams?.asr;
      const details = asrUpstream?.details ?? json;
      const ok = asrUpstream ? asrUpstream.status === "ok" : json.status === "ok";
      const gpuName =
        typeof details?.gpu_name === "string" && details.gpu_name.trim()
          ? details.gpu_name.trim()
          : null;
      const model =
        typeof details?.model === "string" && details.model.trim()
          ? details.model.trim()
          : this._remoteModel;
      const langCount =
        typeof details?.supported_languages_count === "number"
          ? details.supported_languages_count
          : null;
      if (gpuName) this._remoteGpuName = gpuName;
      this._remoteLastLatencyMs = latencyMs;
      if (ok) {
        this._warmedUp = true;
        this._initFailedAt = 0;
        this._lastError = null;
      } else {
        this._lastError = "在线 Qwen3-ASR 上游服务暂不可用";
      }
      return {
        ok,
        latencyMs,
        gpuName,
        model,
        supportedLanguagesCount: langCount,
        ...(ok ? {} : { error: "在线 Qwen3-ASR 上游服务暂不可用" }),
      };
    } catch (err) {
      const latencyMs = Math.round(performance.now() - t0);
      const msg = `在线 Qwen3-ASR 连接失败: ${err instanceof Error ? err.message : String(err)}`;
      this._lastError = msg;
      return {
        ok: false,
        latencyMs,
        gpuName: this._remoteGpuName,
        model: this._remoteModel,
        supportedLanguagesCount: null,
        error: msg,
      };
    }
  }

  /**
   * 后台轻量探活在线 Qwen3-ASR 网关并同步远端 GPU 信息。
   */
  async warmup(): Promise<void> {
    if (this._disposed || this._warmedUp) return;
    if (!this.isRemoteConfigured()) return;
    await this.probeRemoteHealth({ timeoutMs: 8000 });
  }

  /**
   * 通过在线 Voice & ASR Gateway（OpenAI Whisper 兼容 /v1/audio/transcriptions 或 /v1/transcribe）
   * 调用远程 GPU Qwen3-ASR-0.6B 执行多语言语音识别。
   */
  async transcribe(
    pcm16k: Float32Array,
    options: Qwen3GpuTranscribeOptions = {},
  ): Promise<Qwen3GpuTranscribeResult> {
    if (options.signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    if (this._disposed) {
      throw new Error("Qwen3-ASR 在线运行时已释放");
    }
    if (!this.isRemoteConfigured()) {
      throw new Error("未配置在线 Qwen3-ASR 服务地址或授权码（仅支持在线模式）");
    }

    const t0 = performance.now();
    const endpoints = resolveQwen3AsrGatewayEndpoints(this._remoteServiceUrl);
    const wavBytes = encodeWavPcm16(pcm16k, 16000);
    const audioSec = pcm16k.length / 16000;
    const langHint = mapQwen3GatewayLang(options.voiceLang);
    const hotwordPrompt = (options.hotwords ?? [])
      .map((w) => w.replace(/,/g, " ").trim())
      .filter((w) => w.length > 0)
      .slice(0, 12)
      .join(" ");

    const defaultTimeoutMs = Math.max(15_000, Math.min(45_000, Math.round(audioSec * 1200) + 10_000));
    const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
    const combinedSignal = options.signal
      ? AbortSignal.any([options.signal, timeoutController.signal])
      : timeoutController.signal;

    try {
      let res: Response;
      if (endpoints.preferJsonTranscribe) {
        const wavBase64 = Buffer.from(
          wavBytes.buffer,
          wavBytes.byteOffset,
          wavBytes.byteLength,
        ).toString("base64");
        res = await this._fetcher(endpoints.transcribeJsonUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...this._buildAuthHeaders(),
          },
          body: JSON.stringify({
            audio_base64: wavBase64,
            filename: "speech.wav",
            model: this._remoteModel,
            ...(langHint ? { language: langHint } : {}),
            ...(hotwordPrompt ? { prompt: hotwordPrompt } : {}),
          }),
          signal: combinedSignal,
        });
      } else {
        const form = new FormData();
        form.append(
          "file",
          new Blob([wavBytes as unknown as BlobPart], { type: "audio/wav" }),
          "speech.wav",
        );
        form.append("model", this._remoteModel);
        form.append("response_format", "verbose_json");
        if (langHint) {
          form.append("language", langHint);
        }
        if (hotwordPrompt) {
          form.append("prompt", hotwordPrompt);
        }
        res = await this._fetcher(endpoints.transcriptionsUrl, {
          method: "POST",
          headers: this._buildAuthHeaders(),
          body: form,
          signal: combinedSignal,
        });
      }

      if (!res.ok) {
        const bodyText = await res.text().catch(() => "");
        if (res.status === 401 || res.status === 403) {
          this._initFailedAt = Date.now();
        }
        throw new Error(`Qwen3-ASR 在线识别失败 (${res.status}): ${bodyText.slice(0, 180)}`);
      }

      const rawBody = await res.text();
      let rawText = "";
      let lang = "";
      try {
        const parsed = JSON.parse(rawBody) as { text?: unknown; language?: unknown };
        rawText = typeof parsed.text === "string" ? parsed.text : "";
        lang = typeof parsed.language === "string" ? parsed.language : "";
      } catch {
        rawText = rawBody;
      }

      const text = parseQwen3GpuResponseText(rawText);
      if (!options.signal?.aborted && text && typeof options.onPartial === "function") {
        options.onPartial(text);
      }

      const durationMs = Math.round(performance.now() - t0);
      this._remoteLastLatencyMs = durationMs;
      this._warmedUp = true;
      this._lastError = null;

      return {
        text,
        rawText,
        lang,
        durationMs,
        deviceId: "remote",
        deviceName: this._remoteGpuName ?? "在线 Qwen3-ASR GPU",
        backend: "remote",
      };
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        this._lastError = err instanceof Error ? err.message : String(err);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  dispose(): void {
    this._disposed = true;
    this._warmedUp = false;
  }
}
