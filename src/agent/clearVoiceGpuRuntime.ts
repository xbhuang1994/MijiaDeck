// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * 在线 ClearVoice (Voice & ASR Gateway) 语音增强与多轨盲源分离运行时：
 *
 * - 仅支持通过在线 ClearVoice 网关（/clearvoice/v1/enhance、/clearvoice/v1/separate、/health）调用远端 GPU 模型
 *   （MossFormer2_SE_48K / FRCRN_SE_16K / MossFormerGAN_SE_16K 降噪与 MossFormer2_SS_16K 盲源分离）；
 * - 内置 2x2 物理混合投影最小二乘增益恢复，撤销远端分轨 RMS 归一化以保留真实物理响度与相位符号；
 * - 提供离线长音频按 2.0s 切片 + 0.3s 历史上下文 + 20ms 线性交叉淡入淡出分块增强与多轨 PIT 置换对齐拼接入口；
 * - 服务未配置、不可用或超时时进入短冷却窗口并向调用方返回清晰状态，绝不阻塞主语音链路。
 */

import { DEFAULT_CLEARVOICE_MODEL, isLocalEndpointUrl } from "../core/agentConfigStore.ts";
import {
  computeRms,
  decodeWavPcm,
  encodeWavPcm16,
  estimateSnrDb,
  resampleLinear,
} from "./audioPcm.ts";
import {
  ClearVoiceMultiTrackAssembler,
  ClearVoiceSliceAssembler,
  DEFAULT_CLEARVOICE_CHUNKER_CONFIG,
  pruneInactiveOrDuplicateTracks,
} from "./clearVoiceChunker.ts";

export interface ClearVoiceGpuStatus {
  gpuDetected: boolean;
  gpuName: string | null;
  vramTotalMb: number | null;
  vramFreeMb: number | null;
  runtimeReady: boolean;
  modelReady: boolean;
  ssModelReady: boolean;
  scriptReady: boolean;
  customServiceUrl: string;
  remote: boolean;
  hasApiKey: boolean;
  ready: boolean;
  multiTrackReady: boolean;
  serverRunning: boolean;
  provider: "remote" | "none";
  ssProvider: "remote" | "none";
  modelName: string;
  ssModelName: string;
  serviceUrl: string | null;
  lastLatencyMs: number | null;
  lastInferMs: number | null;
  lastSeparateMs: number | null;
  lastError: string | null;
}

export interface ClearVoiceGatewayEndpoints {
  rootUrl: string;
  healthUrl: string;
  modelsUrl: string;
  enhanceUrl: string;
  separateUrl: string;
  superResolutionUrl: string;
}

export interface ClearVoiceRemoteHealthResult {
  ok: boolean;
  protocol: "gateway";
  latencyMs: number;
  gpuName: string | null;
  loadedModels: string[];
  ssSupported: boolean;
  error?: string;
}

/**
 * 规范化在线 Voice & ASR Gateway 的 ClearVoice 接口路径：
 * 支持传入根地址（https://voice.1inch.cn:18443）或带子路径（/clearvoice、/clearvoice/v1、/v1 等）。
 */
export function resolveClearVoiceGatewayEndpoints(serviceUrl: string): ClearVoiceGatewayEndpoints {
  const trimmed = serviceUrl.trim().replace(/\/+$/, "");
  const rootUrl = trimmed
    .replace(/\/clearvoice\/v1\/(?:enhance|separate|super-resolution)$/i, "")
    .replace(/\/clearvoice\/v1$/i, "")
    .replace(/\/clearvoice$/i, "")
    .replace(/\/v1\/audio\/(?:enhance|separate|super-resolution)$/i, "")
    .replace(/\/v1\/audio$/i, "")
    .replace(/\/v1$/i, "")
    .replace(/\/+$/, "");
  return {
    rootUrl,
    healthUrl: `${rootUrl}/health`,
    modelsUrl: `${rootUrl}/clearvoice/models`,
    enhanceUrl: `${rootUrl}/clearvoice/v1/enhance`,
    separateUrl: `${rootUrl}/clearvoice/v1/separate`,
    superResolutionUrl: `${rootUrl}/clearvoice/v1/super-resolution`,
  };
}

/**
 * 将远程返回的音频采样长度精确对齐至目标样本数（防 STFT/编解码边界微差造成滑窗时间漂移）。
 */
export function fitAudioLength(samples: Float32Array, targetLength: number): Float32Array {
  if (samples.length === targetLength) return samples;
  if (samples.length > targetLength) return samples.slice(0, targetLength);
  const out = new Float32Array(targetLength);
  out.set(samples, 0);
  return out;
}

/**
 * 物理混合投影增益恢复（2x2 线性最小二乘）：
 * 远程 ClearVoice MossFormer2_SS_16K 输出通常会对每条说话人音轨独立做 RMS/峰值归一化，
 * 这会破坏真实物理响度并在单人说话场景下把微弱残影轨放大到与主轨同等音量。
 * 通过求解 rawMix ≈ a0*s0 + a1*s1 恢复真实物理增益与相位符号：
 * - 单人说话：主轨恢复真实响度，残影轨自动缩回真实微弱幅值供后续 prune 干净剔除；
 * - 双人重叠：双轨均恢复各自真实物理响度与一致相位，提升 VAD 精度与跨片 PIT 对齐稳定性。
 */
export function recoverSeparatedTrackGains(
  rawMix: Float32Array,
  tracks: ReadonlyArray<Float32Array>,
): Float32Array[] {
  if (tracks.length === 0) return [];
  const inRms = computeRms(rawMix);
  if (inRms < 1e-7) {
    return tracks.map((t) => new Float32Array(t.length));
  }

  if (tracks.length === 2) {
    const t0 = tracks[0]!;
    const t1 = tracks[1]!;
    const n = Math.min(rawMix.length, t0.length, t1.length);
    if (n >= 32) {
      let s00 = 0;
      let s11 = 0;
      let s01 = 0;
      let b0 = 0;
      let b1 = 0;
      for (let i = 0; i < n; i += 1) {
        const x = rawMix[i]!;
        const u = t0[i]!;
        const v = t1[i]!;
        s00 += u * u;
        s11 += v * v;
        s01 += u * v;
        b0 += x * u;
        b1 += x * v;
      }
      const det = s00 * s11 - s01 * s01;
      if (s00 > 1e-10 && s11 > 1e-10 && det > s00 * s11 * 1e-4) {
        let a0 = (s11 * b0 - s01 * b1) / det;
        let a1 = (s00 * b1 - s01 * b0) / det;
        const r0 = Math.sqrt(s00 / n);
        const r1 = Math.sqrt(s11 / n);
        const maxA0 = (inRms * 1.35) / Math.max(1e-6, r0);
        const maxA1 = (inRms * 1.35) / Math.max(1e-6, r1);
        a0 = Math.max(-maxA0, Math.min(maxA0, a0));
        a1 = Math.max(-maxA1, Math.min(maxA1, a1));

        let peak = 0;
        for (let i = 0; i < t0.length; i += 1) {
          const v = Math.abs(t0[i]! * a0);
          if (v > peak) peak = v;
        }
        for (let i = 0; i < t1.length; i += 1) {
          const v = Math.abs(t1[i]! * a1);
          if (v > peak) peak = v;
        }
        const clipScale = peak > 0.96 ? 0.96 / peak : 1;
        const g0 = a0 * clipScale;
        const g1 = a1 * clipScale;

        const out0 = new Float32Array(t0.length);
        const out1 = new Float32Array(t1.length);
        for (let i = 0; i < t0.length; i += 1) {
          out0[i] = Math.max(-1, Math.min(1, t0[i]! * g0));
        }
        for (let i = 0; i < t1.length; i += 1) {
          out1[i] = Math.max(-1, Math.min(1, t1[i]! * g1));
        }
        return [out0, out1];
      }
    }
  }

  // 退化/非双轨回退：能量守恒统一缩放
  let sumSq = 0;
  let maxPeak = 0;
  for (const tr of tracks) {
    const r = computeRms(tr);
    sumSq += r * r;
    for (let i = 0; i < tr.length; i += 1) {
      const av = Math.abs(tr[i]!);
      if (av > maxPeak) maxPeak = av;
    }
  }
  if (sumSq < 1e-12) {
    return tracks.map((t) => new Float32Array(t.length));
  }
  let gain = inRms / Math.sqrt(sumSq);
  if (maxPeak * gain > 0.96) {
    gain = 0.96 / maxPeak;
  }
  return tracks.map((tr) => {
    const out = new Float32Array(tr.length);
    for (let i = 0; i < tr.length; i += 1) {
      out[i] = Math.max(-1, Math.min(1, tr[i]! * gain));
    }
    return out;
  });
}

export interface ClearVoiceDenoiseSliceOptions {
  inputSampleRate?: number;
  outputSampleRate?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ClearVoiceDenoiseSliceResult {
  samples: Float32Array;
  sampleRate: number;
  durationMs: number;
  inferMs: number;
  provider: string;
  device: "gpu" | "cpu";
  model: string;
  gpuName: string | null;
}

export interface ClearVoiceSeparateSliceOptions extends ClearVoiceDenoiseSliceOptions {
  /** 是否在单次整段处理后剔除静音残影/镜像串音轨（流式多片滑窗设为 false 由装配器统一对齐后剔除） */
  pruneTracks?: boolean;
  /** 是否对每条分离出的音轨独立执行在线 ClearVoice 降噪与剔除背景音（默认 true） */
  applyDenoise?: boolean;
}

export interface ClearVoiceSeparatedTrackSlice {
  trackIndex: number;
  sourceSlot: number;
  samples: Float32Array;
  rms: number;
  energyRatio: number;
  seApplied: boolean;
}

export interface ClearVoiceSeparateSliceResult {
  tracks: ClearVoiceSeparatedTrackSlice[];
  sampleRate: number;
  ssUsed: boolean;
  durationMs: number;
  ssMs: number;
  seMs: number;
  inferMs: number;
  provider: string;
  device: "gpu" | "cpu";
  model: string;
  gpuName: string | null;
  swaps: number;
  pairWcorr: number;
  pairEcorr: number;
}

export interface ClearVoiceOfflineTrackItem {
  trackIndex: number;
  trackId: string;
  sourceSlot: number;
  samples: Float32Array;
  sampleRate: number;
  rms: number;
  energyRatio: number;
  inputSnrDb: number;
  outputSnrDb: number;
  snrGainDb: number;
}

export interface ClearVoiceOfflineMultiTrackResult {
  tracks: ClearVoiceOfflineTrackItem[];
  rawTrackCount: number;
  keptTrackCount: number;
  ssUsed: boolean;
  engine: string;
  inputSnrDb: number;
  durationMs: number;
  ssMs: number;
  seMs: number;
  sliceCount: number;
  crossfadeCount: number;
  permutationSwaps: number;
  gpuName: string | null;
}

export interface ClearVoiceOfflineChunkResult {
  samples: Float32Array;
  sampleRate: number;
  engine: string;
  inputSnrDb: number;
  outputSnrDb: number;
  snrGainDb: number;
  durationMs: number;
  sliceCount: number;
  crossfadeCount: number;
  gpuName: string | null;
}

const CLEARVOICE_INIT_RETRY_COOLDOWN_MS = 30_000;

export class ClearVoiceGpuRuntime {
  private readonly _fetcher: typeof fetch;
  private _customServiceUrl = "";
  private _customApiKey = "";
  private _customModel = DEFAULT_CLEARVOICE_MODEL;
  private _remoteHealthy: boolean | null = null;
  private _remoteLoadedModels: string[] = [];
  private _remoteSeparateSupported: boolean | null = null;
  private _activeGpuName: string | null = null;
  private _warmedUp = false;
  private _initFailedAt = 0;
  private _lastError: string | null = null;
  private _lastLatencyMs: number | null = null;
  private _lastInferMs: number | null = null;
  private _lastSeparateMs: number | null = null;
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
        model: options.model ?? DEFAULT_CLEARVOICE_MODEL,
      });
    }
  }

  get customServiceUrl(): string {
    return this._customServiceUrl;
  }

  get customModel(): string {
    return this._customModel;
  }

  isRemoteConfigured(): boolean {
    return (
      this._customServiceUrl.length > 0 &&
      (this._customApiKey.length > 0 || isLocalEndpointUrl(this._customServiceUrl))
    );
  }

  private _buildAuthHeaders(): Record<string, string> {
    if (!this._customApiKey) return {};
    return {
      Authorization: `Bearer ${this._customApiKey}`,
      "X-Auth-Code": this._customApiKey,
    };
  }

  setRemoteConfig(config: { serviceUrl?: string; apiKey?: string; model?: string }): void {
    const nextUrl =
      config.serviceUrl !== undefined
        ? config.serviceUrl.trim().replace(/\/+$/, "")
        : this._customServiceUrl;
    const nextKey = config.apiKey !== undefined ? config.apiKey.trim() : this._customApiKey;
    const nextModel =
      config.model !== undefined
        ? config.model.trim() || DEFAULT_CLEARVOICE_MODEL
        : this._customModel;

    const urlChanged = nextUrl !== this._customServiceUrl;
    const keyChanged = nextKey !== this._customApiKey;
    this._customServiceUrl = nextUrl;
    this._customApiKey = nextKey;
    this._customModel = nextModel;

    if (urlChanged || keyChanged) {
      this._remoteSeparateSupported = null;
      this._remoteHealthy = null;
      this._remoteLoadedModels = [];
      this._warmedUp = false;
      this.resetFailureCooldown();
      if (urlChanged) {
        this._activeGpuName = null;
        this._lastLatencyMs = null;
        this._lastInferMs = null;
        this._lastSeparateMs = null;
      }
    }
  }

  setCustomServiceUrl(url: string): void {
    this.setRemoteConfig({ serviceUrl: url });
  }

  isInFailureCooldown(): boolean {
    return (
      this._initFailedAt > 0 && Date.now() - this._initFailedAt < CLEARVOICE_INIT_RETRY_COOLDOWN_MS
    );
  }

  resetFailureCooldown(): void {
    this._initFailedAt = 0;
    this._lastError = null;
  }

  getStatus(): ClearVoiceGpuStatus {
    const hasCustomUrl = this._customServiceUrl.length > 0;
    const remoteReady = this.isRemoteConfigured();
    const missingRemoteKey = hasCustomUrl && !remoteReady;
    const multiTrackReady = remoteReady && this._remoteSeparateSupported !== false;

    return {
      gpuDetected: remoteReady,
      gpuName: remoteReady ? (this._activeGpuName ?? "在线 ClearVoice GPU") : null,
      vramTotalMb: null,
      vramFreeMb: null,
      runtimeReady: remoteReady,
      modelReady: remoteReady,
      ssModelReady: multiTrackReady,
      scriptReady: remoteReady,
      customServiceUrl: this._customServiceUrl,
      remote: remoteReady,
      hasApiKey: this._customApiKey.length > 0,
      ready: remoteReady,
      multiTrackReady,
      serverRunning: remoteReady,
      provider: remoteReady ? "remote" : "none",
      ssProvider: multiTrackReady ? "remote" : "none",
      modelName: this._customModel || DEFAULT_CLEARVOICE_MODEL,
      ssModelName: "MossFormer2_SS_16K",
      serviceUrl: hasCustomUrl ? this._customServiceUrl : null,
      lastLatencyMs: this._lastLatencyMs,
      lastInferMs: this._lastInferMs,
      lastSeparateMs: this._lastSeparateMs,
      lastError: missingRemoteKey ? "缺少在线 ClearVoice 授权码，请填写授权码" : this._lastError,
    };
  }

  /**
   * 探测在线 ClearVoice / Voice & ASR Gateway 健康状态，同步远端 GPU 与模型状态。
   */
  async probeRemoteHealth(options: { timeoutMs?: number } = {}): Promise<ClearVoiceRemoteHealthResult> {
    if (!this._customServiceUrl) {
      return {
        ok: false,
        protocol: "gateway",
        latencyMs: 0,
        gpuName: null,
        loadedModels: [],
        ssSupported: false,
        error: "未配置在线 ClearVoice 服务地址",
      };
    }
    const t0 = performance.now();
    const endpoints = resolveClearVoiceGatewayEndpoints(this._customServiceUrl);
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
            ? "ClearVoice 授权码无效或未提供 (401)"
            : res.status === 403
              ? "ClearVoice 授权码缺少 clearvoice 服务权限 (403)"
              : `ClearVoice 远程健康检查失败 (${res.status})`;
        this._remoteHealthy = false;
        this._lastError = msg;
        if (res.status === 401 || res.status === 403) {
          this._initFailedAt = Date.now();
        }
        return {
          ok: false,
          protocol: "gateway",
          latencyMs,
          gpuName: this._activeGpuName,
          loadedModels: [],
          ssSupported: false,
          error: msg,
        };
      }

      const json = (await res.json()) as {
        status?: string;
        ok?: boolean;
        service?: string;
        gpuName?: string | null;
        gpu_name?: string | null;
        ssReady?: boolean;
        loaded_models?: Array<{ name?: string; task?: string }>;
        upstreams?: {
          clearvoice?: {
            status?: string;
            details?: {
              status?: string;
              gpu_name?: string | null;
              loaded_models?: Array<{ name?: string; task?: string }>;
            };
          };
        };
      };

      const cvUpstream = json.upstreams?.clearvoice;
      const details = cvUpstream?.details ?? json;
      const ok = cvUpstream
        ? cvUpstream.status === "ok"
        : json.status !== undefined
          ? json.status === "ok"
          : json.ok !== false;
      const rawGpuName =
        typeof details?.gpu_name === "string" && details.gpu_name.trim()
          ? details.gpu_name.trim()
          : typeof json.gpuName === "string" && json.gpuName.trim()
            ? json.gpuName.trim()
            : null;
      const loadedModels = Array.isArray(details?.loaded_models)
        ? details.loaded_models
            .map((m) => (typeof m?.name === "string" ? m.name : ""))
            .filter(Boolean)
        : [];
      const ssSupported = json.ssReady !== false;

      this._remoteHealthy = ok;
      this._remoteLoadedModels = loadedModels;
      this._remoteSeparateSupported = ssSupported;
      if (rawGpuName) this._activeGpuName = rawGpuName;
      this._lastLatencyMs = latencyMs;
      if (ok) {
        this._warmedUp = true;
        this._initFailedAt = 0;
        this._lastError = null;
      } else {
        this._lastError = "远程 ClearVoice 上游服务暂不可用";
      }
      return {
        ok,
        protocol: "gateway",
        latencyMs,
        gpuName: rawGpuName,
        loadedModels,
        ssSupported,
        ...(ok ? {} : { error: "远程 ClearVoice 上游服务暂不可用" }),
      };
    } catch (err) {
      const latencyMs = Math.round(performance.now() - t0);
      const msg = `远程 ClearVoice 连接失败: ${err instanceof Error ? err.message : String(err)}`;
      this._remoteHealthy = false;
      this._lastError = msg;
      return {
        ok: false,
        protocol: "gateway",
        latencyMs,
        gpuName: this._activeGpuName,
        loadedModels: [],
        ssSupported: false,
        error: msg,
      };
    }
  }

  /**
   * 后台轻量探活在线 ClearVoice 网关并同步远端 GPU 信息。
   */
  async warmup(): Promise<void> {
    if (this._disposed || (this._warmedUp && this._customServiceUrl)) return;
    if (!this.isRemoteConfigured()) return;
    await this.probeRemoteHealth({ timeoutMs: 8000 });
  }

  /**
   * 对单个带历史上下文的音频切片调用在线 ClearVoice 网关（/clearvoice/v1/enhance）执行降噪增强。
   */
  async denoiseSlice(
    pcmWithContext: Float32Array,
    options: ClearVoiceDenoiseSliceOptions = {},
  ): Promise<ClearVoiceDenoiseSliceResult> {
    if (options.signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    const inSr = options.inputSampleRate ?? 16000;
    const outSr = options.outputSampleRate ?? inSr;
    if (pcmWithContext.length === 0) {
      return {
        samples: new Float32Array(0),
        sampleRate: outSr,
        durationMs: 0,
        inferMs: 0,
        provider: this.isRemoteConfigured() ? "remote" : "none",
        device: "gpu",
        model: this._customModel || DEFAULT_CLEARVOICE_MODEL,
        gpuName: this._activeGpuName,
      };
    }
    if (this._disposed) {
      throw new Error("ClearVoice 在线运行时已释放");
    }
    if (!this.isRemoteConfigured()) {
      throw new Error("未配置在线 ClearVoice 服务地址或授权码（仅支持在线模式）");
    }

    const expectedOutLen =
      inSr === outSr
        ? pcmWithContext.length
        : Math.max(1, Math.round(pcmWithContext.length * (outSr / inSr)));
    const t0 = performance.now();
    const endpoints = resolveClearVoiceGatewayEndpoints(this._customServiceUrl);
    const model = this._customModel || DEFAULT_CLEARVOICE_MODEL;

    const wavBytes = encodeWavPcm16(pcmWithContext, inSr);
    const form = new FormData();
    form.append("file", new Blob([wavBytes as unknown as BlobPart], { type: "audio/wav" }), "slice.wav");
    form.append("model", model);
    form.append("response_format", "wav");

    const timeoutMs = options.timeoutMs ?? (this._warmedUp ? 20_000 : 45_000);
    const timeoutCtrl = new AbortController();
    const timer = setTimeout(() => timeoutCtrl.abort(), timeoutMs);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutCtrl.signal])
      : timeoutCtrl.signal;

    try {
      const res = await this._fetcher(endpoints.enhanceUrl, {
        method: "POST",
        headers: this._buildAuthHeaders(),
        body: form,
        signal,
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        if (res.status === 401 || res.status === 403) {
          this._initFailedAt = Date.now();
        }
        throw new Error(`ClearVoice 在线降噪失败 (${res.status}): ${errText.slice(0, 180)}`);
      }

      const contentType = (res.headers.get("content-type") || "").toLowerCase();
      let decodedSamples: Float32Array;
      let decodedSr = inSr;
      let inferMsRaw = Number(res.headers.get("X-Elapsed-Ms"));
      let modelOut = res.headers.get("X-ClearVoice-Model") || model;

      if (contentType.includes("application/json")) {
        const json = (await res.json()) as {
          audio_base64?: string;
          elapsed_ms?: number;
          model?: string;
        };
        if (!json.audio_base64) {
          throw new Error("ClearVoice 在线降噪返回缺少 audio_base64 数据");
        }
        const wavBuf = new Uint8Array(Buffer.from(json.audio_base64, "base64"));
        const dec = decodeWavPcm(wavBuf);
        decodedSamples = dec.samples;
        decodedSr = dec.sampleRate;
        if (typeof json.elapsed_ms === "number") inferMsRaw = json.elapsed_ms;
        if (typeof json.model === "string" && json.model) modelOut = json.model;
      } else {
        const wavBuf = new Uint8Array(await res.arrayBuffer());
        const dec = decodeWavPcm(wavBuf);
        decodedSamples = dec.samples;
        decodedSr = dec.sampleRate;
      }

      const resampled =
        decodedSr === outSr ? decodedSamples : resampleLinear(decodedSamples, decodedSr, outSr);
      const outSamples = fitAudioLength(resampled, expectedOutLen);
      const durationMs = Math.round(performance.now() - t0);
      const inferMs = Number.isFinite(inferMsRaw) ? Number(inferMsRaw.toFixed(1)) : durationMs;

      this._remoteHealthy = true;
      this._warmedUp = true;
      this._lastLatencyMs = durationMs;
      this._lastInferMs = inferMs;
      this._lastError = null;

      return {
        samples: outSamples,
        sampleRate: outSr,
        durationMs,
        inferMs,
        provider: "remote",
        device: "gpu",
        model: modelOut,
        gpuName: this._activeGpuName ?? "在线 ClearVoice GPU",
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

  /**
   * 对离线上传音频按准实时滑窗规范（每片 <= 2.0s + 0.3s 历史上下文 + 20ms 线性交叉淡入淡出）
   * 分片送入在线 ClearVoice 推理并无缝拼接输出 16kHz 纯净语音。
   */
  async enhanceOfflineWithChunking(
    pcm: Float32Array,
    sampleRate = 16000,
    options: {
      maxChunkMs?: number;
      lookbackMs?: number;
      crossfadeMs?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<ClearVoiceOfflineChunkResult> {
    const t0 = performance.now();
    const pcm16k = sampleRate === 16000 ? pcm : resampleLinear(pcm, sampleRate, 16000);
    const inputSnrDb = estimateSnrDb(pcm16k, 16000);
    if (pcm16k.length < 320) {
      return {
        samples: pcm16k,
        sampleRate: 16000,
        engine: "clearvoice-mossformer2-remote",
        inputSnrDb,
        outputSnrDb: inputSnrDb,
        snrGainDb: 0,
        durationMs: Math.round(performance.now() - t0),
        sliceCount: 0,
        crossfadeCount: 0,
        gpuName: this._activeGpuName,
      };
    }

    const maxChunkSamples = Math.round(
      16000 * ((options.maxChunkMs ?? DEFAULT_CLEARVOICE_CHUNKER_CONFIG.maxChunkMs) / 1000),
    );
    const lookbackSamples = Math.round(
      16000 * ((options.lookbackMs ?? DEFAULT_CLEARVOICE_CHUNKER_CONFIG.lookbackMs) / 1000),
    );
    const crossfadeMs = options.crossfadeMs ?? DEFAULT_CLEARVOICE_CHUNKER_CONFIG.crossfadeMs;

    const assembler = new ClearVoiceSliceAssembler({
      sampleRate: 16000,
      crossfadeMs,
    });

    let lastGpuName: string | null = this._activeGpuName;

    let pos = 0;
    let idx = 0;
    while (pos < pcm16k.length) {
      const end = Math.min(pcm16k.length, pos + maxChunkSamples);
      const ctxStart = Math.max(0, pos - lookbackSamples);
      const actualLookback = pos - ctxStart;
      const newLen = end - pos;
      const sliceWithContext = pcm16k.subarray(ctxStart, end);

      const res = await this.denoiseSlice(sliceWithContext, {
        inputSampleRate: 16000,
        outputSampleRate: 16000,
        signal: options.signal,
      });
      lastGpuName = res.gpuName;

      assembler.appendEnhancedSlice({
        enhancedWithContext: res.samples,
        lookbackSamples: actualLookback,
        newSamples: newLen,
        applyCrossfade: idx > 0,
      });
      pos = end;
      idx += 1;
    }

    const stitched = assembler.getStitchedAudio();
    const outputSnrDb = estimateSnrDb(stitched, 16000);
    return {
      samples: stitched,
      sampleRate: 16000,
      engine: "clearvoice-mossformer2-remote",
      inputSnrDb,
      outputSnrDb,
      snrGainDb: Number((outputSnrDb - inputSnrDb).toFixed(2)),
      durationMs: Math.round(performance.now() - t0),
      sliceCount: assembler.sliceCount,
      crossfadeCount: assembler.crossfadeCount,
      gpuName: lastGpuName,
    };
  }

  /**
   * 通过在线 Voice & ASR Gateway（/clearvoice/v1/separate + 按需并行 /clearvoice/v1/enhance）
   * 执行多轨盲源分离与分轨降噪，内置物理投影增益恢复防止单说话人残影轨被 RMS 归一化误放大。
   * 若远程网关不支持 /separate（返回 404/405/501），自动平滑回退为单轨降噪输出。
   */
  async separateSlice(
    pcmWithContext: Float32Array,
    options: ClearVoiceSeparateSliceOptions = {},
  ): Promise<ClearVoiceSeparateSliceResult> {
    if (options.signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    const inSr = options.inputSampleRate ?? 16000;
    const outSr = options.outputSampleRate ?? inSr;
    if (pcmWithContext.length === 0) {
      return {
        tracks: [],
        sampleRate: outSr,
        ssUsed: false,
        durationMs: 0,
        ssMs: 0,
        seMs: 0,
        inferMs: 0,
        provider: this.isRemoteConfigured() ? "remote" : "none",
        device: "gpu",
        model: this._customModel || DEFAULT_CLEARVOICE_MODEL,
        gpuName: this._activeGpuName,
        swaps: 0,
        pairWcorr: 0,
        pairEcorr: 0,
      };
    }
    if (this._disposed) {
      throw new Error("ClearVoice 在线运行时已释放");
    }
    if (!this.isRemoteConfigured()) {
      throw new Error("未配置在线 ClearVoice 服务地址或授权码（仅支持在线模式）");
    }

    if (this._remoteSeparateSupported === false) {
      return this._separateFallbackViaDenoise(pcmWithContext, options);
    }

    const expectedOutLen =
      inSr === outSr
        ? pcmWithContext.length
        : Math.max(1, Math.round(pcmWithContext.length * (outSr / inSr)));
    const t0 = performance.now();
    const endpoints = resolveClearVoiceGatewayEndpoints(this._customServiceUrl);

    const wavBytes = encodeWavPcm16(pcmWithContext, inSr);
    const form = new FormData();
    form.append("file", new Blob([wavBytes as unknown as BlobPart], { type: "audio/wav" }), "mix.wav");
    form.append("model", "MossFormer2_SS_16K");
    form.append("response_format", "json");

    // 首次调用远端 MossFormer2_SS_16K 可能需要懒加载权重，放宽冷启动超时
    const timeoutMs = options.timeoutMs ?? (this._warmedUp ? 35_000 : 90_000);
    const timeoutCtrl = new AbortController();
    const timer = setTimeout(() => timeoutCtrl.abort(), timeoutMs);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutCtrl.signal])
      : timeoutCtrl.signal;

    try {
      const res = await this._fetcher(endpoints.separateUrl, {
        method: "POST",
        headers: this._buildAuthHeaders(),
        body: form,
        signal,
      });

      if (res.status === 404 || res.status === 405 || res.status === 501) {
        clearTimeout(timer);
        this._remoteSeparateSupported = false;
        return this._separateFallbackViaDenoise(pcmWithContext, options);
      }

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        if (res.status === 401 || res.status === 403) {
          this._initFailedAt = Date.now();
        }
        throw new Error(`ClearVoice 在线盲源分离失败 (${res.status}): ${errText.slice(0, 180)}`);
      }

      const json = (await res.json()) as {
        model?: string;
        elapsed_ms?: number;
        speakers?: Array<{
          speaker?: number;
          sample_rate?: number;
          audio_base64?: string;
        }>;
      };
      const speakers = Array.isArray(json.speakers) ? json.speakers : [];
      if (speakers.length === 0) {
        clearTimeout(timer);
        return this._separateFallbackViaDenoise(pcmWithContext, options);
      }

      const ssMsRaw = typeof json.elapsed_ms === "number" ? json.elapsed_ms : performance.now() - t0;
      const decodedInSr: Float32Array[] = [];
      for (const sp of speakers) {
        if (!sp.audio_base64) continue;
        const wavBuf = new Uint8Array(Buffer.from(sp.audio_base64, "base64"));
        const dec = decodeWavPcm(wavBuf);
        const atInSr =
          dec.sampleRate === inSr ? dec.samples : resampleLinear(dec.samples, dec.sampleRate, inSr);
        decodedInSr.push(fitAudioLength(atInSr, pcmWithContext.length));
      }
      if (decodedInSr.length === 0) {
        clearTimeout(timer);
        return this._separateFallbackViaDenoise(pcmWithContext, options);
      }

      // 物理投影增益恢复：撤销远端 ClearVoice 分轨独立 RMS 归一化，恢复真实物理响度与相位符号
      const gainRecovered = recoverSeparatedTrackGains(pcmWithContext, decodedInSr);

      let workingSlots: Array<{ sourceSlot: number; samples: Float32Array }> = gainRecovered.map(
        (samples, idx) => ({ sourceSlot: idx, samples }),
      );
      let pairWcorr = 0;
      let pairEcorr = 0;

      // 单次离线整段模式（pruneTracks !== false）：先剔除物理增益恢复后的空轨/残影轨，避免对死静音轨浪费远程 /enhance 往返
      if (options.pruneTracks !== false && workingSlots.length > 1) {
        const prePrune = pruneInactiveOrDuplicateTracks(workingSlots.map((w) => w.samples));
        pairWcorr = prePrune.pairWcorr;
        pairEcorr = prePrune.pairEcorr;
        workingSlots = prePrune.tracks.map((tr) => ({
          sourceSlot: workingSlots[tr.sourceSlot]?.sourceSlot ?? tr.sourceSlot,
          samples: tr.samples,
        }));
      }

      const applyDenoise = options.applyDenoise !== false;
      let seMsTotal = 0;
      const processedSlots: Array<{ sourceSlot: number; samples: Float32Array; seApplied: boolean }> =
        await Promise.all(
          workingSlots.map(async (slot) => {
            const trRms = computeRms(slot.samples);
            // 流式滑窗模式下保留全槽位，但对极低能量死静音槽位跳过远程 /enhance 降低延迟与带宽
            if (applyDenoise && trRms >= 0.002) {
              try {
                const enh = await this.denoiseSlice(slot.samples, {
                  inputSampleRate: inSr,
                  outputSampleRate: outSr,
                  timeoutMs: options.timeoutMs,
                  signal: options.signal,
                });
                seMsTotal += enh.inferMs;
                return {
                  sourceSlot: slot.sourceSlot,
                  samples: fitAudioLength(enh.samples, expectedOutLen),
                  seApplied: true,
                };
              } catch (err) {
                if (options.signal?.aborted || (err instanceof DOMException && err.name === "AbortError")) {
                  throw err;
                }
                // 单轨远程降噪异常时保底输出分离轨，不丢弃有效说话人
              }
            }
            const resampled =
              inSr === outSr ? slot.samples : resampleLinear(slot.samples, inSr, outSr);
            return {
              sourceSlot: slot.sourceSlot,
              samples: fitAudioLength(resampled, expectedOutLen),
              seApplied: false,
            };
          }),
        );

      let finalSlots = processedSlots;
      if (options.pruneTracks !== false && finalSlots.length > 1) {
        const postPrune = pruneInactiveOrDuplicateTracks(finalSlots.map((s) => s.samples));
        pairWcorr = postPrune.pairWcorr;
        pairEcorr = postPrune.pairEcorr;
        finalSlots = postPrune.tracks.map((tr) => {
          const src = finalSlots[tr.sourceSlot]!;
          return {
            sourceSlot: src.sourceSlot,
            samples: tr.samples,
            seApplied: src.seApplied,
          };
        });
      }

      const rmsVals = finalSlots.map((s) => computeRms(s.samples));
      const totalEnergy = rmsVals.reduce((acc, r) => acc + r * r, 0);
      const tracks: ClearVoiceSeparatedTrackSlice[] = finalSlots.map((slot, idx) => {
        const r = rmsVals[idx] ?? 0;
        const ratio =
          totalEnergy > 1e-12 ? (r * r) / totalEnergy : 1 / Math.max(1, finalSlots.length);
        return {
          trackIndex: idx + 1,
          sourceSlot: slot.sourceSlot,
          samples: slot.samples,
          rms: Number(r.toFixed(5)),
          energyRatio: Number(ratio.toFixed(4)),
          seApplied: slot.seApplied,
        };
      });

      const durationMs = Math.round(performance.now() - t0);
      const ssMs = Number(ssMsRaw.toFixed(1));
      const seMs = Number(seMsTotal.toFixed(1));
      const inferMs = Number((ssMs + seMs).toFixed(1));

      this._remoteHealthy = true;
      this._remoteSeparateSupported = true;
      this._warmedUp = true;
      this._lastLatencyMs = durationMs;
      this._lastSeparateMs = ssMs;
      this._lastInferMs = inferMs;
      this._lastError = null;

      const seModelName = this._customModel || DEFAULT_CLEARVOICE_MODEL;
      return {
        tracks,
        sampleRate: outSr,
        ssUsed: true,
        durationMs,
        ssMs,
        seMs,
        inferMs,
        provider: "remote",
        device: "gpu",
        model: applyDenoise ? `MossFormer2_SS_16K+${seModelName}` : "MossFormer2_SS_16K",
        gpuName: this._activeGpuName ?? "在线 ClearVoice GPU",
        swaps: 0,
        pairWcorr,
        pairEcorr,
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

  private async _separateFallbackViaDenoise(
    pcmWithContext: Float32Array,
    options: ClearVoiceSeparateSliceOptions,
  ): Promise<ClearVoiceSeparateSliceResult> {
    const res = await this.denoiseSlice(pcmWithContext, options);
    const r = Number(computeRms(res.samples).toFixed(5));
    return {
      tracks: [
        {
          trackIndex: 1,
          sourceSlot: 0,
          samples: res.samples,
          rms: r,
          energyRatio: 1,
          seApplied: true,
        },
      ],
      sampleRate: res.sampleRate,
      ssUsed: false,
      durationMs: res.durationMs,
      ssMs: 0,
      seMs: res.inferMs,
      inferMs: res.inferMs,
      provider: res.provider,
      device: res.device,
      model: res.model,
      gpuName: res.gpuName,
      swaps: 0,
      pairWcorr: 0,
      pairEcorr: 0,
    };
  }

  /**
   * 对离线音频执行在线 ClearVoice 多轨盲源分离 + 分轨独立降噪去背景音（长音频按滑窗 + PIT 置换对齐拼接，绝不混回单轨）。
   */
  async separateAndEnhanceOfflineWithChunking(
    pcm: Float32Array,
    sampleRate = 16000,
    options: {
      singlePassMaxMs?: number;
      maxChunkMs?: number;
      lookbackMs?: number;
      crossfadeMs?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<ClearVoiceOfflineMultiTrackResult> {
    const t0 = performance.now();
    const pcm16k = sampleRate === 16000 ? pcm : resampleLinear(pcm, sampleRate, 16000);
    const inputSnrDb = estimateSnrDb(pcm16k, 16000);
    if (pcm16k.length < 320) {
      return {
        tracks: [],
        rawTrackCount: 0,
        keptTrackCount: 0,
        ssUsed: false,
        engine: "clearvoice-mossformer2-remote",
        inputSnrDb,
        durationMs: Math.round(performance.now() - t0),
        ssMs: 0,
        seMs: 0,
        sliceCount: 0,
        crossfadeCount: 0,
        permutationSwaps: 0,
        gpuName: this._activeGpuName,
      };
    }

    const singlePassMaxSamples = Math.round(16000 * ((options.singlePassMaxMs ?? 4500) / 1000));

    // 中短音频（<= 4.5s）直接整段单次 BSS+SE，无任何切片跨窗置换风险
    if (pcm16k.length <= singlePassMaxSamples) {
      const res = await this.separateSlice(pcm16k, {
        inputSampleRate: 16000,
        outputSampleRate: 16000,
        pruneTracks: true,
        applyDenoise: true,
        signal: options.signal,
      });
      const engineLabel = res.ssUsed
        ? "clearvoice-mossformer2-bss-se-remote"
        : "clearvoice-mossformer2-remote";
      const tracks: ClearVoiceOfflineTrackItem[] = res.tracks.map((tr, idx) => {
        const outSnr = estimateSnrDb(tr.samples, 16000);
        return {
          trackIndex: idx + 1,
          trackId: `cv_track_${idx + 1}`,
          sourceSlot: tr.sourceSlot,
          samples: tr.samples,
          sampleRate: 16000,
          rms: tr.rms,
          energyRatio: tr.energyRatio,
          inputSnrDb,
          outputSnrDb: outSnr,
          snrGainDb: Number((outSnr - inputSnrDb).toFixed(2)),
        };
      });
      return {
        tracks,
        rawTrackCount: res.ssUsed ? Math.max(2, tracks.length) : tracks.length,
        keptTrackCount: tracks.length,
        ssUsed: res.ssUsed,
        engine: engineLabel,
        inputSnrDb,
        durationMs: Math.round(performance.now() - t0),
        ssMs: res.ssMs,
        seMs: res.seMs,
        sliceCount: 1,
        crossfadeCount: 0,
        permutationSwaps: res.swaps,
        gpuName: res.gpuName,
      };
    }

    // 长音频（> 4.5s）：按滑窗 + 0.5s 历史上下文 + PIT 置换对齐 + 每轨独立 20ms Overlap-Add 拼接
    const maxChunkSamples = Math.round(16000 * ((options.maxChunkMs ?? 3000) / 1000));
    const lookbackSamples = Math.round(16000 * ((options.lookbackMs ?? 500) / 1000));
    const crossfadeMs = options.crossfadeMs ?? DEFAULT_CLEARVOICE_CHUNKER_CONFIG.crossfadeMs;

    const assembler = new ClearVoiceMultiTrackAssembler({
      sampleRate: 16000,
      crossfadeMs,
      lookbackMs: options.lookbackMs ?? 500,
    });

    let lastGpuName: string | null = this._activeGpuName;
    let ssUsedAny = false;
    let totalSsMs = 0;
    let totalSeMs = 0;
    let serverSwaps = 0;

    let pos = 0;
    let idx = 0;
    while (pos < pcm16k.length) {
      const end = Math.min(pcm16k.length, pos + maxChunkSamples);
      const ctxStart = Math.max(0, pos - lookbackSamples);
      const actualLookback = pos - ctxStart;
      const newLen = end - pos;
      const sliceWithContext = pcm16k.subarray(ctxStart, end);

      const res = await this.separateSlice(sliceWithContext, {
        inputSampleRate: 16000,
        outputSampleRate: 16000,
        pruneTracks: false,
        applyDenoise: true,
        signal: options.signal,
      });
      lastGpuName = res.gpuName;
      ssUsedAny = ssUsedAny || res.ssUsed;
      totalSsMs += res.ssMs;
      totalSeMs += res.seMs;
      serverSwaps += res.swaps;

      assembler.appendSeparatedSlice({
        tracksWithContext: res.tracks.map((t) => t.samples),
        lookbackSamples: actualLookback,
        newSamples: newLen,
        applyCrossfade: idx > 0,
      });

      pos = end;
      idx += 1;
    }

    const pruned = assembler.getTracks({ prune: true });
    const engineLabel = ssUsedAny
      ? "clearvoice-mossformer2-bss-se-remote"
      : "clearvoice-mossformer2-remote";

    const tracks: ClearVoiceOfflineTrackItem[] = pruned.tracks.map((tr) => {
      const outSnr = estimateSnrDb(tr.samples, 16000);
      return {
        trackIndex: tr.trackIndex,
        trackId: `cv_track_${tr.trackIndex}`,
        sourceSlot: tr.sourceSlot,
        samples: tr.samples,
        sampleRate: 16000,
        rms: tr.rms,
        energyRatio: tr.energyRatio,
        inputSnrDb,
        outputSnrDb: outSnr,
        snrGainDb: Number((outSnr - inputSnrDb).toFixed(2)),
      };
    });

    return {
      tracks,
      rawTrackCount: assembler.trackSlotCount,
      keptTrackCount: tracks.length,
      ssUsed: ssUsedAny,
      engine: engineLabel,
      inputSnrDb,
      durationMs: Math.round(performance.now() - t0),
      ssMs: Number(totalSsMs.toFixed(1)),
      seMs: Number(totalSeMs.toFixed(1)),
      sliceCount: assembler.sliceCount,
      crossfadeCount: assembler.crossfadeCount,
      permutationSwaps: assembler.permutationSwaps + serverSwaps,
      gpuName: lastGpuName,
    };
  }

  dispose(): void {
    this._disposed = true;
    this._warmedUp = false;
  }
}
