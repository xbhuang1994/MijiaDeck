// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * ClearVoice (MossFormer2_SE_48K) GPU 语音降噪推理服务运行时：
 *
 * - 支持自动在本地 127.0.0.1 随机空闲端口拉起部署于 NVIDIA CUDA GPU 的 ClearVoice 推理服务
 *   （tools/clearvoice_gpu_server/server.py + voice_models/clearvoice-gpu-runtime + MossFormer2_SE_48K ONNX）；
 * - 亦支持通过 clearVoiceServiceUrl 对接外部已部署的 GPU ClearVoice 服务；
 * - 零 JSON 音频编解码开销（原始 Float32Array 二进制直传 /denoise），单切片 GPU 推理仅数十毫秒；
 * - 提供离线长音频按 2.0s 切片 + 0.3s 历史上下文 + 20ms 线性交叉淡入淡出分块增强入口；
 * - 服务不可用或超时时进入短冷却窗口并向调用方返回清晰状态，绝不阻塞主语音链路。
 */

import { existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { DEFAULT_CLEARVOICE_MODEL, isLocalEndpointUrl } from "../core/agentConfigStore.ts";
import { projectRoot } from "../core/appMeta.ts";
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

export interface ClearVoiceGpuModelPaths {
  modelsDir: string;
  modelDir: string;
  modelFp32Path: string;
  modelInt8Path: string;
  ssModelDir: string;
  ssModelPath: string;
  ssModelAltPath: string;
  runtimeDir: string;
  pythonBin: string;
  serverScript: string;
}

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
  provider: "cuda" | "cpu" | "remote" | "none";
  ssProvider: "cuda" | "cpu" | "remote" | "none";
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
  protocol: "gateway" | "local-binary";
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
  /** 是否在服务端剔除静音残影/镜像串音轨（单次整段处理设为 true，流式多片滑窗设为 false 由装配器统一对齐后剔除） */
  pruneTracks?: boolean;
  /** 是否对每条分离出的音轨独立执行 MossFormer2_SE_48K 降噪与剔除背景音（默认 true） */
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

export const CLEARVOICE_MODEL_DIR_NAME = "clearvoice-mossformer2-se-48k";
export const CLEARVOICE_SS_MODEL_DIR_NAME = "clearvoice-mossformer2-ss-16k";
export const CLEARVOICE_RUNTIME_DIR_NAME = "clearvoice-gpu-runtime";
export const CLEARVOICE_MODEL_FP32_FILENAME = "model.onnx";
export const CLEARVOICE_MODEL_INT8_FILENAME = "model.int8.onnx";
export const CLEARVOICE_SS_MODEL_FILENAME = "model.onnx";
export const CLEARVOICE_SS_MODEL_ALT_FILENAME = "mossformer2_ss_16k.onnx";

export const CLEARVOICE_DOWNLOAD_URLS = {
  modelFp32:
    "https://modelscope.cn/models/manyeyes/mossformer2-se-48k-onnx/resolve/master/model.onnx",
  modelInt8:
    "https://modelscope.cn/models/manyeyes/mossformer2-se-48k-onnx/resolve/master/model.int8.onnx",
  ssModelMirror:
    "https://hf-mirror.com/kkk4oru/mossformer2-ss-16k-onnx/resolve/main/model.onnx",
  ssModelPrimary:
    "https://huggingface.co/kkk4oru/mossformer2-ss-16k-onnx/resolve/main/model.onnx",
} as const;

const CLEARVOICE_INIT_RETRY_COOLDOWN_MS = 30_000;

export function resolveClearVoiceGpuPaths(
  modelsDir: string,
  serverScriptOverride?: string,
): ClearVoiceGpuModelPaths {
  const root = path.resolve(modelsDir);
  const modelDir = path.join(root, CLEARVOICE_MODEL_DIR_NAME);
  const ssModelDir = path.join(root, CLEARVOICE_SS_MODEL_DIR_NAME);
  const runtimeDir = path.join(root, CLEARVOICE_RUNTIME_DIR_NAME);
  const pythonBin =
    process.platform === "win32"
      ? path.join(runtimeDir, "venv", "Scripts", "python.exe")
      : path.join(runtimeDir, "venv", "bin", "python");
  const serverScript = path.resolve(
    serverScriptOverride || path.join(projectRoot(), "tools", "clearvoice_gpu_server", "server.py"),
  );
  return {
    modelsDir: root,
    modelDir,
    modelFp32Path: path.join(modelDir, CLEARVOICE_MODEL_FP32_FILENAME),
    modelInt8Path: path.join(modelDir, CLEARVOICE_MODEL_INT8_FILENAME),
    ssModelDir,
    ssModelPath: path.join(ssModelDir, CLEARVOICE_SS_MODEL_FILENAME),
    ssModelAltPath: path.join(ssModelDir, CLEARVOICE_SS_MODEL_ALT_FILENAME),
    runtimeDir,
    pythonBin,
    serverScript,
  };
}

function probeNvidiaGpuSync(): {
  detected: boolean;
  name: string | null;
  vramTotalMb: number | null;
  vramFreeMb: number | null;
} {
  try {
    const nv = Bun.spawnSync(
      ["nvidia-smi", "--query-gpu=name,memory.total,memory.free", "--format=csv,noheader,nounits"],
      { stdout: "pipe", stderr: "ignore" },
    );
    if (nv.exitCode === 0) {
      const text = new TextDecoder().decode(nv.stdout).trim();
      const firstLine = text.split(/\r?\n/).find((l) => l.trim().length > 0);
      if (firstLine) {
        const parts = firstLine.split(",").map((s) => s.trim());
        const name = parts[0] || "NVIDIA GPU";
        const total = parts[1] ? Number.parseInt(parts[1], 10) : null;
        const free = parts[2] ? Number.parseInt(parts[2], 10) : total;
        return {
          detected: true,
          name,
          vramTotalMb: Number.isFinite(total) ? total : null,
          vramFreeMb: Number.isFinite(free) ? free : null,
        };
      }
    }
  } catch {
    // ignore probe failure
  }
  return { detected: false, name: null, vramTotalMb: null, vramFreeMb: null };
}

async function reserveEphemeralPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        srv.close(() => reject(new Error("无法分配 ClearVoice GPU 服务端口")));
        return;
      }
      const port = addr.port;
      srv.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

const activeClearVoiceSubprocesses = new Set<ReturnType<typeof Bun.spawn>>();
let exitHookRegistered = false;

function registerProcessExitCleanup(): void {
  if (exitHookRegistered) return;
  exitHookRegistered = true;
  process.once("exit", () => {
    for (const proc of activeClearVoiceSubprocesses) {
      try {
        proc.kill(9);
      } catch {
        // ignore
      }
    }
    activeClearVoiceSubprocesses.clear();
  });
}

export class ClearVoiceGpuRuntime {
  private readonly _modelsDir: string;
  private readonly _serverScriptOverride?: string;
  private readonly _fetcher: typeof fetch;
  private _customServiceUrl = "";
  private _customApiKey = "";
  private _customModel = DEFAULT_CLEARVOICE_MODEL;
  private _remoteProtocol: "auto" | "gateway" | "local-binary" = "auto";
  private _remoteHealthy: boolean | null = null;
  private _remoteLoadedModels: string[] = [];
  private _gpuProbeCache:
    | { detected: boolean; name: string | null; vramTotalMb: number | null; vramFreeMb: number | null }
    | null = null;
  private _proc: ReturnType<typeof Bun.spawn> | null = null;
  private _baseUrl: string | null = null;
  private _startPromise: Promise<string> | null = null;
  private _activeProvider: "cuda" | "cpu" | "remote" | "none" = "none";
  private _activeSsProvider: "cuda" | "cpu" | "remote" | "none" = "none";
  private _remoteSeparateSupported: boolean | null = null;
  private _activeGpuName: string | null = null;
  private _warmedUp = false;
  private _initFailedAt = 0;
  private _lastError: string | null = null;
  private _lastLatencyMs: number | null = null;
  private _lastInferMs: number | null = null;
  private _lastSeparateMs: number | null = null;
  private _disposed = false;

  constructor(options: {
    modelsDir: string;
    serviceUrl?: string;
    apiKey?: string;
    model?: string;
    serverScript?: string;
    fetcher?: typeof fetch;
  }) {
    this._modelsDir = path.resolve(options.modelsDir);
    this._serverScriptOverride = options.serverScript;
    this._fetcher = options.fetcher ?? globalThis.fetch;
    if (options.serviceUrl || options.apiKey || options.model) {
      this.setRemoteConfig({
        serviceUrl: options.serviceUrl ?? "",
        apiKey: options.apiKey ?? "",
        model: options.model ?? DEFAULT_CLEARVOICE_MODEL,
      });
    }
  }

  get paths(): ClearVoiceGpuModelPaths {
    return resolveClearVoiceGpuPaths(this._modelsDir, this._serverScriptOverride);
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

  private _isGatewayProtocol(): boolean {
    if (!this._customServiceUrl) return false;
    if (this._remoteProtocol === "gateway") return true;
    if (this._remoteProtocol === "local-binary") return false;
    return (
      this._customApiKey.length > 0 ||
      /\/(?:clearvoice|v1\/audio)(?:\/|$)/i.test(this._customServiceUrl) ||
      !isLocalEndpointUrl(this._customServiceUrl)
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
      this._remoteProtocol = "auto";
      this._remoteSeparateSupported = null;
      this._remoteHealthy = null;
      this._remoteLoadedModels = [];
      this._warmedUp = false;
      this.resetFailureCooldown();
      if (urlChanged) {
        this._activeGpuName = null;
      }
      if (this.isRemoteConfigured()) {
        // 切至在线远程 ClearVoice 服务时立即释放本地 Python 子进程显存
        this._killProcess();
        this._activeProvider = "remote";
        this._activeSsProvider = "remote";
      } else if (!this._proc) {
        this._activeProvider = "none";
        this._activeSsProvider = "none";
      }
    }
  }

  setCustomServiceUrl(url: string): void {
    this.setRemoteConfig({ serviceUrl: url });
  }

  hasRuntime(): boolean {
    const envPy = process.env.MIJIADECK_CLEARVOICE_PYTHON?.trim();
    if (envPy && existsSync(envPy)) return true;
    return existsSync(this.paths.pythonBin);
  }

  resolvePythonBin(): string | null {
    const envPy = process.env.MIJIADECK_CLEARVOICE_PYTHON?.trim();
    if (envPy && existsSync(envPy)) return envPy;
    if (existsSync(this.paths.pythonBin)) return this.paths.pythonBin;
    return null;
  }

  resolveModelPath(): string | null {
    const p = this.paths;
    if (existsSync(p.modelFp32Path) && statSync(p.modelFp32Path).size > 10_000_000) {
      return p.modelFp32Path;
    }
    if (existsSync(p.modelInt8Path) && statSync(p.modelInt8Path).size > 10_000_000) {
      return p.modelInt8Path;
    }
    return null;
  }

  resolveSsModelPath(): string | null {
    const p = this.paths;
    if (existsSync(p.ssModelPath) && statSync(p.ssModelPath).size > 10_000_000) {
      return p.ssModelPath;
    }
    if (existsSync(p.ssModelAltPath) && statSync(p.ssModelAltPath).size > 10_000_000) {
      return p.ssModelAltPath;
    }
    return null;
  }

  hasModel(): boolean {
    return this.resolveModelPath() !== null;
  }

  hasSsModel(): boolean {
    return this.resolveSsModelPath() !== null;
  }

  hasServerScript(): boolean {
    return existsSync(this.paths.serverScript);
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

  private _detectGpu(forceRefresh = false) {
    if (!forceRefresh && this._gpuProbeCache) {
      return this._gpuProbeCache;
    }
    this._gpuProbeCache = probeNvidiaGpuSync();
    return this._gpuProbeCache;
  }

  getStatus(): ClearVoiceGpuStatus {
    const gpu = this._detectGpu(false);
    const runtimeReady = this.hasRuntime();
    const modelReady = this.hasModel();
    const ssModelReady = this.hasSsModel();
    const scriptReady = this.hasServerScript();
    const hasCustomUrl = this._customServiceUrl.length > 0;
    const remoteReady = this.isRemoteConfigured();
    const missingRemoteKey = hasCustomUrl && !remoteReady;
    const ready = remoteReady || (!hasCustomUrl && runtimeReady && modelReady && scriptReady);
    const multiTrackReady = remoteReady
      ? this._remoteSeparateSupported !== false
      : !hasCustomUrl && runtimeReady && modelReady && ssModelReady && scriptReady;
    const serverRunning = remoteReady || (this._proc !== null && this._baseUrl !== null);
    const provider: ClearVoiceGpuStatus["provider"] = remoteReady
      ? "remote"
      : !hasCustomUrl && this._activeProvider !== "none"
        ? this._activeProvider
        : ready && gpu.detected
          ? "cuda"
          : ready
            ? "cpu"
            : "none";
    const ssProvider: ClearVoiceGpuStatus["ssProvider"] = remoteReady
      ? this._remoteSeparateSupported === false
        ? "none"
        : "remote"
      : !hasCustomUrl && this._activeSsProvider !== "none"
        ? this._activeSsProvider
        : multiTrackReady && gpu.detected
          ? "cuda"
          : multiTrackReady
            ? "cpu"
            : "none";

    return {
      gpuDetected: remoteReady ? true : gpu.detected,
      gpuName: remoteReady ? (this._activeGpuName ?? "在线 ClearVoice GPU") : (this._activeGpuName ?? gpu.name),
      vramTotalMb: remoteReady ? null : gpu.vramTotalMb,
      vramFreeMb: remoteReady ? null : gpu.vramFreeMb,
      runtimeReady: remoteReady ? true : runtimeReady,
      modelReady: remoteReady ? true : modelReady,
      ssModelReady: remoteReady ? this._remoteSeparateSupported !== false : ssModelReady,
      scriptReady: remoteReady ? true : scriptReady,
      customServiceUrl: this._customServiceUrl,
      remote: remoteReady,
      hasApiKey: this._customApiKey.length > 0,
      ready,
      multiTrackReady,
      serverRunning,
      provider,
      ssProvider,
      modelName: this._customModel || DEFAULT_CLEARVOICE_MODEL,
      ssModelName: "MossFormer2_SS_16K",
      serviceUrl: hasCustomUrl ? this._customServiceUrl : this._baseUrl,
      lastLatencyMs: this._lastLatencyMs,
      lastInferMs: this._lastInferMs,
      lastSeparateMs: this._lastSeparateMs,
      lastError: missingRemoteKey ? "缺少在线 ClearVoice 授权码，请填写授权码" : this._lastError,
    };
  }

  /**
   * 探测远程 ClearVoice / Voice & ASR Gateway 健康状态，自动识别协议并同步远程 GPU 与模型状态。
   */
  async probeRemoteHealth(options: { timeoutMs?: number } = {}): Promise<ClearVoiceRemoteHealthResult> {
    if (!this._customServiceUrl) {
      return {
        ok: false,
        protocol: "local-binary",
        latencyMs: 0,
        gpuName: null,
        loadedModels: [],
        ssSupported: false,
        error: "未配置远程 ClearVoice 服务地址",
      };
    }
    const t0 = performance.now();
    const isGwHint = this._isGatewayProtocol();
    const endpoints = resolveClearVoiceGatewayEndpoints(this._customServiceUrl);
    const healthUrl = isGwHint ? endpoints.healthUrl : `${this._customServiceUrl}/health`;
    const timeoutMs = options.timeoutMs ?? 8000;

    try {
      const res = await this._fetcher(healthUrl, {
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
          protocol: isGwHint ? "gateway" : "local-binary",
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
      if (cvUpstream || json.service === "clearvoice" || Array.isArray(json.loaded_models)) {
        const details = cvUpstream?.details ?? json;
        const ok = cvUpstream ? cvUpstream.status === "ok" : json.status === "ok";
        const gpuName =
          typeof details?.gpu_name === "string" && details.gpu_name.trim()
            ? details.gpu_name.trim()
            : null;
        const loadedModels = Array.isArray(details?.loaded_models)
          ? details.loaded_models
              .map((m) => (typeof m?.name === "string" ? m.name : ""))
              .filter(Boolean)
          : [];
        this._remoteProtocol = "gateway";
        this._remoteHealthy = ok;
        this._remoteLoadedModels = loadedModels;
        this._remoteSeparateSupported = true;
        this._activeProvider = "remote";
        this._activeSsProvider = "remote";
        if (gpuName) this._activeGpuName = gpuName;
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
          gpuName,
          loadedModels,
          ssSupported: true,
          ...(ok ? {} : { error: "远程 ClearVoice 上游服务暂不可用" }),
        };
      }

      // 本地兼容二进制服务 /health
      const ok = json.ok !== false && json.status !== "error";
      const gpuName =
        typeof json.gpuName === "string" && json.gpuName.trim() ? json.gpuName.trim() : null;
      this._remoteProtocol = "local-binary";
      this._remoteHealthy = ok;
      this._remoteSeparateSupported = json.ssReady !== false;
      if (gpuName) this._activeGpuName = gpuName;
      this._lastLatencyMs = latencyMs;
      if (ok) {
        this._warmedUp = true;
        this._initFailedAt = 0;
        this._lastError = null;
      }
      return {
        ok,
        protocol: "local-binary",
        latencyMs,
        gpuName,
        loadedModels: [],
        ssSupported: json.ssReady !== false,
      };
    } catch (err) {
      const latencyMs = Math.round(performance.now() - t0);
      const msg = `远程 ClearVoice 连接失败: ${err instanceof Error ? err.message : String(err)}`;
      this._remoteHealthy = false;
      this._lastError = msg;
      return {
        ok: false,
        protocol: isGwHint ? "gateway" : "local-binary",
        latencyMs,
        gpuName: this._activeGpuName,
        loadedModels: [],
        ssSupported: false,
        error: msg,
      };
    }
  }

  /**
   * 惰性启动本地 ClearVoice GPU 推理服务（或连接已配置的外部 ClearVoice GPU 服务），等待 /health 就绪。
   */
  async ensureStarted(): Promise<string> {
    if (this._disposed) {
      throw new Error("ClearVoice GPU 运行时已释放");
    }
    if (this._customServiceUrl) {
      return this._customServiceUrl;
    }
    if (this._baseUrl && this._proc && this._proc.exitCode === null) {
      return this._baseUrl;
    }
    if (this._startPromise) {
      return this._startPromise;
    }

    const pythonBin = this.resolvePythonBin();
    const modelPath = this.resolveModelPath();
    const ssModelPath = this.resolveSsModelPath();
    const scriptPath = this.paths.serverScript;

    if (!pythonBin) {
      throw new Error("ClearVoice GPU Python 运行时未就绪");
    }
    if (!modelPath) {
      throw new Error("ClearVoice MossFormer2_SE_48K 模型尚未下载");
    }
    if (!existsSync(scriptPath)) {
      throw new Error(`ClearVoice GPU 服务脚本不存在: ${scriptPath}`);
    }

    this._startPromise = (async () => {
      registerProcessExitCleanup();
      const port = await reserveEphemeralPort();
      const baseUrl = `http://127.0.0.1:${port}`;
      const gpu = this._detectGpu(false);

      const args = [
        scriptPath,
        "--model",
        modelPath,
        ...(ssModelPath ? ["--ss-model", ssModelPath] : []),
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--device",
        gpu.detected ? "gpu" : "cpu",
      ];

      const proc = Bun.spawn([pythonBin, ...args], {
        cwd: path.dirname(scriptPath),
        env: {
          ...process.env,
          PYTHONDONTWRITEBYTECODE: "1",
        },
        stdout: "ignore",
        stderr: "pipe",
      });
      this._proc = proc;
      activeClearVoiceSubprocesses.add(proc);

      let stderrTail = "";
      if (proc.stderr) {
        const reader = proc.stderr.getReader();
        const decoder = new TextDecoder();
        void (async () => {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              if (value) {
                stderrTail = (stderrTail + decoder.decode(value, { stream: true })).slice(-2000);
              }
            }
          } catch {
            // ignore stderr drain error on exit
          }
        })();
      }

      void proc.exited.then(() => {
        activeClearVoiceSubprocesses.delete(proc);
        if (this._proc === proc) {
          this._proc = null;
          this._baseUrl = null;
        }
      });

      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        if (this._disposed) {
          this._killProcess();
          throw new Error("ClearVoice GPU 服务在启动期间已释放");
        }
        if (proc.exitCode !== null) {
          const msg = `ClearVoice GPU 服务提前退出 (code=${proc.exitCode}): ${stderrTail.trim().slice(-320)}`;
          this._initFailedAt = Date.now();
          this._lastError = msg;
          throw new Error(msg);
        }
        try {
          const res = await fetch(`${baseUrl}/health`, {
            signal: AbortSignal.timeout(1500),
          });
          if (res.ok) {
            const info = (await res.json()) as {
              provider?: string;
              device?: string;
              ssReady?: boolean;
              ssProvider?: string | null;
              ssDevice?: string | null;
              gpuName?: string | null;
              warmedUp?: boolean;
            };
            this._baseUrl = baseUrl;
            this._activeProvider =
              info.device === "gpu" || info.provider === "CUDAExecutionProvider" ? "cuda" : "cpu";
            if (info.ssReady) {
              this._activeSsProvider =
                info.ssDevice === "gpu" || info.ssProvider === "CUDAExecutionProvider"
                  ? "cuda"
                  : "cpu";
            } else {
              this._activeSsProvider = "none";
            }
            if (typeof info.gpuName === "string" && info.gpuName.trim()) {
              this._activeGpuName = info.gpuName.trim();
            }
            this._warmedUp = Boolean(info.warmedUp);
            this._initFailedAt = 0;
            this._lastError = null;
            return baseUrl;
          }
        } catch {
          // still loading MossFormer2 weights & warming CUDA kernels
        }
        await Bun.sleep(200);
      }

      this._killProcess();
      const timeoutMsg = `ClearVoice GPU 服务启动超时 (120s): ${stderrTail.trim().slice(-240)}`;
      this._initFailedAt = Date.now();
      this._lastError = timeoutMsg;
      throw new Error(timeoutMsg);
    })().finally(() => {
      this._startPromise = null;
    });

    return this._startPromise;
  }

  /**
   * 后台预热 ClearVoice GPU 推理服务（本地服务完成模型显存加载与 CUDA kernel 预热；在线网关则执行轻量 /health 探活与远端 GPU 信息同步）。
   */
  async warmup(): Promise<void> {
    if (this._disposed || (this._warmedUp && (this._baseUrl || this._customServiceUrl))) return;
    if (this.isRemoteConfigured() && this._isGatewayProtocol()) {
      await this.probeRemoteHealth({ timeoutMs: 8000 });
      return;
    }
    await this.ensureStarted();
    if (this._disposed || this._warmedUp) return;
    try {
      await this.denoiseSlice(new Float32Array(8000), {
        inputSampleRate: 16000,
        outputSampleRate: 16000,
        timeoutMs: 30_000,
      });
      this._warmedUp = true;
    } catch {
      // warmup failure does not block subsequent calls
    }
  }

  /**
   * 通过在线 Voice & ASR Gateway（/clearvoice/v1/enhance）执行单轨语音降噪增强。
   */
  private async _denoiseSliceViaGateway(
    pcmWithContext: Float32Array,
    options: ClearVoiceDenoiseSliceOptions,
  ): Promise<ClearVoiceDenoiseSliceResult> {
    const inSr = options.inputSampleRate ?? 16000;
    const outSr = options.outputSampleRate ?? inSr;
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

      this._remoteProtocol = "gateway";
      this._remoteHealthy = true;
      this._warmedUp = true;
      this._lastLatencyMs = durationMs;
      this._lastInferMs = inferMs;
      this._lastError = null;
      this._activeProvider = "remote";

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
   * 对单个带历史上下文的音频切片调用 GPU ClearVoice (MossFormer2_SE_48K) 推理降噪。
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
        provider: this._activeProvider,
        device: this._activeProvider === "cuda" || this._activeProvider === "remote" ? "gpu" : "cpu",
        model: this._customModel || DEFAULT_CLEARVOICE_MODEL,
        gpuName: this._activeGpuName,
      };
    }

    if (this.isRemoteConfigured() && this._isGatewayProtocol()) {
      return this._denoiseSliceViaGateway(pcmWithContext, options);
    }

    const t0 = performance.now();
    const baseUrl = await this.ensureStarted();
    if (options.signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    const bodyBytes = new Uint8Array(
      pcmWithContext.buffer.slice(
        pcmWithContext.byteOffset,
        pcmWithContext.byteOffset + pcmWithContext.byteLength,
      ),
    );
    const timeoutMs = options.timeoutMs ?? (this._warmedUp ? 12_000 : 30_000);
    const timeoutCtrl = new AbortController();
    const timer = setTimeout(() => timeoutCtrl.abort(), timeoutMs);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutCtrl.signal])
      : timeoutCtrl.signal;

    try {
      const res = await this._fetcher(`${baseUrl}/denoise`, {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Audio-Format": "f32le",
          "X-Sample-Rate": String(inSr),
          "X-Output-Sample-Rate": String(outSr),
        },
        body: bodyBytes as unknown as BodyInit,
        signal,
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`ClearVoice GPU 推理失败 (${res.status}): ${errText.slice(0, 200)}`);
      }
      const arrBuf = await res.arrayBuffer();
      const alignedLen = Math.floor(arrBuf.byteLength / 4);
      const outSamples = new Float32Array(arrBuf, 0, alignedLen);
      const provider = res.headers.get("X-ClearVoice-Provider") || this._activeProvider;
      const deviceHdr = (res.headers.get("X-ClearVoice-Device") || "").toLowerCase();
      const device: "gpu" | "cpu" =
        deviceHdr === "gpu" || provider === "CUDAExecutionProvider" ? "gpu" : "cpu";
      const inferMsRaw = Number(res.headers.get("X-ClearVoice-Infer-Ms"));
      const gpuName = res.headers.get("X-ClearVoice-Gpu-Name") || this._activeGpuName;
      const durationMs = Math.round(performance.now() - t0);
      const inferMs = Number.isFinite(inferMsRaw) ? Number(inferMsRaw.toFixed(1)) : durationMs;

      this._warmedUp = true;
      this._lastLatencyMs = durationMs;
      this._lastInferMs = inferMs;
      if (gpuName) this._activeGpuName = gpuName;
      if (!this._customServiceUrl) {
        this._activeProvider = device === "gpu" ? "cuda" : "cpu";
      }

      return {
        samples: outSamples,
        sampleRate: outSr,
        durationMs,
        inferMs,
        provider,
        device,
        model: res.headers.get("X-ClearVoice-Model") || "MossFormer2_SE_48K",
        gpuName,
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
   * 分片送入 ClearVoice GPU 推理并无缝拼接输出 16kHz 纯净语音。
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
        engine: "clearvoice-mossformer2-gpu",
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

    let lastDevice: "gpu" | "cpu" = "gpu";
    let lastProvider = "cuda";
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
      lastDevice = res.device;
      lastProvider = res.provider;
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
      engine:
        lastProvider === "remote"
          ? "clearvoice-mossformer2-remote"
          : lastDevice === "gpu"
            ? "clearvoice-mossformer2-gpu"
            : "clearvoice-mossformer2-cpu",
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
   */
  private async _separateSliceViaGateway(
    pcmWithContext: Float32Array,
    options: ClearVoiceSeparateSliceOptions,
  ): Promise<ClearVoiceSeparateSliceResult> {
    const inSr = options.inputSampleRate ?? 16000;
    const outSr = options.outputSampleRate ?? inSr;
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
                const enh = await this._denoiseSliceViaGateway(slot.samples, {
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

      this._remoteProtocol = "gateway";
      this._remoteHealthy = true;
      this._remoteSeparateSupported = true;
      this._warmedUp = true;
      this._lastLatencyMs = durationMs;
      this._lastSeparateMs = ssMs;
      this._lastInferMs = inferMs;
      this._lastError = null;
      this._activeProvider = "remote";
      this._activeSsProvider = "remote";

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

  /**
   * 对单个带历史上下文的音频切片调用 GPU ClearVoice（MossFormer2_SS_16K 盲源分离 + 分轨 MossFormer2_SE_48K 降噪去背景音）。
   * 绝不将多轨音轨混回单轨；若外部服务仅实现旧版 /denoise 接口（返回 404），自动平滑回退为单轨降噪输出。
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
        provider: this._activeProvider,
        device: this._activeProvider === "cuda" || this._activeProvider === "remote" ? "gpu" : "cpu",
        model: this._customModel || DEFAULT_CLEARVOICE_MODEL,
        gpuName: this._activeGpuName,
        swaps: 0,
        pairWcorr: 0,
        pairEcorr: 0,
      };
    }

    // 若已确认远程/Mock 服务不支持 /separate，直接走 /denoise 单轨路径避免多余 404 往返
    if (this._customServiceUrl && this._remoteSeparateSupported === false) {
      return this._separateFallbackViaDenoise(pcmWithContext, options);
    }

    if (this.isRemoteConfigured() && this._isGatewayProtocol()) {
      return this._separateSliceViaGateway(pcmWithContext, options);
    }

    const t0 = performance.now();
    const baseUrl = await this.ensureStarted();
    if (options.signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    const bodyBytes = new Uint8Array(
      pcmWithContext.buffer.slice(
        pcmWithContext.byteOffset,
        pcmWithContext.byteOffset + pcmWithContext.byteLength,
      ),
    );
    const timeoutMs = options.timeoutMs ?? (this._warmedUp ? 25_000 : 45_000);
    const timeoutCtrl = new AbortController();
    const timer = setTimeout(() => timeoutCtrl.abort(), timeoutMs);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutCtrl.signal])
      : timeoutCtrl.signal;

    try {
      const res = await this._fetcher(`${baseUrl}/separate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Audio-Format": "f32le",
          "X-Sample-Rate": String(inSr),
          "X-Output-Sample-Rate": String(outSr),
          "X-Prune-Tracks": options.pruneTracks === false ? "0" : "1",
          "X-Apply-Denoise": options.applyDenoise === false ? "0" : "1",
        },
        body: bodyBytes as unknown as BodyInit,
        signal,
      });

      if (res.status === 404 || res.status === 405 || res.status === 501) {
        clearTimeout(timer);
        if (this._customServiceUrl) {
          this._remoteSeparateSupported = false;
        }
        return this._separateFallbackViaDenoise(pcmWithContext, options);
      }

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`ClearVoice GPU 盲源分离失败 (${res.status}): ${errText.slice(0, 200)}`);
      }

      if (this._customServiceUrl) {
        this._remoteSeparateSupported = true;
      }

      const arrBuf = await res.arrayBuffer();
      const totalFloats = Math.floor(arrBuf.byteLength / 4);
      const flat = new Float32Array(arrBuf, 0, totalFloats);

      const trackCountHdr = Number.parseInt(res.headers.get("X-ClearVoice-Track-Count") || "1", 10);
      const trackCount = Number.isFinite(trackCountHdr) && trackCountHdr > 0 ? trackCountHdr : 1;
      const samplesPerTrackHdr = Number.parseInt(
        res.headers.get("X-ClearVoice-Samples-Per-Track") || "0",
        10,
      );
      const samplesPerTrack =
        Number.isFinite(samplesPerTrackHdr) && samplesPerTrackHdr > 0
          ? samplesPerTrackHdr
          : Math.floor(totalFloats / Math.max(1, trackCount));

      let parsedMeta: Array<{
        index?: number;
        sourceSlot?: number;
        rms?: number;
        energyRatio?: number;
        seApplied?: boolean;
      }> = [];
      try {
        const rawMeta = res.headers.get("X-ClearVoice-Track-Meta");
        if (rawMeta) {
          const j = JSON.parse(rawMeta);
          if (Array.isArray(j)) parsedMeta = j;
        }
      } catch {
        // ignore malformed metadata header
      }

      let pairWcorr = 0;
      let pairEcorr = 0;
      try {
        const rawCorr = res.headers.get("X-ClearVoice-Pair-Corr");
        if (rawCorr) {
          const j = JSON.parse(rawCorr) as { wcorr?: number; ecorr?: number };
          if (typeof j.wcorr === "number") pairWcorr = j.wcorr;
          if (typeof j.ecorr === "number") pairEcorr = j.ecorr;
        }
      } catch {
        // ignore
      }

      const tracks: ClearVoiceSeparatedTrackSlice[] = [];
      for (let i = 0; i < trackCount; i += 1) {
        const start = i * samplesPerTrack;
        const end = Math.min(totalFloats, start + samplesPerTrack);
        if (end <= start) continue;
        // 每条音轨分配独立拷贝，绝不共享或混叠底层缓冲区
        const trackSamples = flat.slice(start, end);
        const m = parsedMeta[i];
        const rms = typeof m?.rms === "number" ? m.rms : Number(computeRms(trackSamples).toFixed(5));
        const energyRatio =
          typeof m?.energyRatio === "number" ? m.energyRatio : Number((1 / trackCount).toFixed(4));
        tracks.push({
          trackIndex: i + 1,
          sourceSlot: typeof m?.sourceSlot === "number" ? m.sourceSlot : i,
          samples: trackSamples,
          rms,
          energyRatio,
          seApplied: m?.seApplied !== false,
        });
      }

      const ssUsed = res.headers.get("X-ClearVoice-SS-Available") === "1";
      const provider = res.headers.get("X-ClearVoice-Provider") || this._activeProvider;
      const deviceHdr = (res.headers.get("X-ClearVoice-Device") || "").toLowerCase();
      const device: "gpu" | "cpu" =
        deviceHdr === "gpu" || provider === "CUDAExecutionProvider" ? "gpu" : "cpu";
      const ssMsRaw = Number(res.headers.get("X-ClearVoice-SS-Ms"));
      const seMsRaw = Number(res.headers.get("X-ClearVoice-SE-Ms"));
      const inferMsRaw = Number(res.headers.get("X-ClearVoice-Infer-Ms"));
      const swapsRaw = Number.parseInt(res.headers.get("X-ClearVoice-Swaps") || "0", 10);
      const gpuName = res.headers.get("X-ClearVoice-Gpu-Name") || this._activeGpuName;
      const durationMs = Math.round(performance.now() - t0);
      const ssMs = Number.isFinite(ssMsRaw) ? Number(ssMsRaw.toFixed(1)) : 0;
      const seMs = Number.isFinite(seMsRaw) ? Number(seMsRaw.toFixed(1)) : 0;
      const inferMs = Number.isFinite(inferMsRaw)
        ? Number(inferMsRaw.toFixed(1))
        : Number((ssMs + seMs).toFixed(1));

      this._warmedUp = true;
      this._lastLatencyMs = durationMs;
      this._lastInferMs = inferMs;
      this._lastSeparateMs = ssUsed ? ssMs : null;
      if (gpuName) this._activeGpuName = gpuName;
      if (!this._customServiceUrl) {
        this._activeProvider = device === "gpu" ? "cuda" : "cpu";
        if (ssUsed) {
          this._activeSsProvider = device === "gpu" ? "cuda" : "cpu";
        }
      }

      return {
        tracks,
        sampleRate: outSr,
        ssUsed,
        durationMs,
        ssMs,
        seMs,
        inferMs,
        provider,
        device,
        model:
          res.headers.get("X-ClearVoice-Model") ||
          (ssUsed ? "MossFormer2_SS_16K+MossFormer2_SE_48K" : "MossFormer2_SE_48K"),
        gpuName,
        swaps: Number.isFinite(swapsRaw) ? swapsRaw : 0,
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
   * 对离线音频执行 ClearVoice 多轨盲源分离 + 分轨独立降噪去背景音（长音频按滑窗 + PIT 置换对齐拼接，绝不混回单轨）。
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
        engine: "clearvoice-mossformer2-gpu",
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
        ? res.provider === "remote"
          ? "clearvoice-mossformer2-bss-se-remote"
          : res.device === "gpu"
            ? "clearvoice-mossformer2-bss-se-gpu"
            : "clearvoice-mossformer2-bss-se-cpu"
        : res.provider === "remote"
          ? "clearvoice-mossformer2-remote"
          : res.device === "gpu"
            ? "clearvoice-mossformer2-gpu"
            : "clearvoice-mossformer2-cpu";
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

    let lastDevice: "gpu" | "cpu" = "gpu";
    let lastProvider = "cuda";
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
      lastDevice = res.device;
      lastProvider = res.provider;
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
      ? lastProvider === "remote"
        ? "clearvoice-mossformer2-bss-se-remote"
        : lastDevice === "gpu"
          ? "clearvoice-mossformer2-bss-se-gpu"
          : "clearvoice-mossformer2-bss-se-cpu"
      : lastProvider === "remote"
        ? "clearvoice-mossformer2-remote"
        : lastDevice === "gpu"
          ? "clearvoice-mossformer2-gpu"
          : "clearvoice-mossformer2-cpu";

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

  /**
   * 补齐下载 MossFormer2_SE_48K 与 MossFormer2_SS_16K ONNX 模型文件（流式落盘 + 原子重命名）。
   */
  async downloadMissingModel(): Promise<ClearVoiceGpuStatus> {
    const p = this.paths;
    mkdirSync(p.modelDir, { recursive: true });
    mkdirSync(p.ssModelDir, { recursive: true });

    const downloadFile = async (urls: readonly string[], dest: string, label: string) => {
      const part = `${dest}.part`;
      let lastErr: unknown = null;
      for (const url of urls) {
        try {
          const res = await fetch(url, { redirect: "follow" });
          if (!res.ok) {
            lastErr = new Error(`下载 ${label} 失败 (${res.status})`);
            continue;
          }
          if (res.body) {
            const writer = Bun.file(part).writer();
            try {
              const reader = res.body.getReader();
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (value && value.byteLength > 0) writer.write(value);
              }
              await writer.end();
            } catch (err) {
              try {
                await writer.end();
              } catch {
                // ignore
              }
              try {
                if (existsSync(part)) unlinkSync(part);
              } catch {
                // ignore
              }
              throw err;
            }
          } else {
            await Bun.write(part, await res.arrayBuffer());
          }
          renameSync(part, dest);
          return;
        } catch (err) {
          lastErr = err;
        }
      }
      throw lastErr instanceof Error ? lastErr : new Error(`下载 ${label} 失败`);
    };

    if (!this.hasModel()) {
      await downloadFile([CLEARVOICE_DOWNLOAD_URLS.modelFp32], p.modelFp32Path, "ClearVoice MossFormer2_SE_48K");
    }
    if (!this.hasSsModel()) {
      await downloadFile(
        [CLEARVOICE_DOWNLOAD_URLS.ssModelMirror, CLEARVOICE_DOWNLOAD_URLS.ssModelPrimary],
        p.ssModelPath,
        "ClearVoice MossFormer2_SS_16K",
      );
    }
    this.resetFailureCooldown();
    this._detectGpu(true);
    return this.getStatus();
  }

  private _killProcess(): void {
    const proc = this._proc;
    this._proc = null;
    this._baseUrl = null;
    if (proc) {
      activeClearVoiceSubprocesses.delete(proc);
      try {
        proc.kill();
      } catch {
        // ignore
      }
    }
  }

  dispose(): void {
    this._disposed = true;
    this._killProcess();
    this._warmedUp = false;
  }
}
