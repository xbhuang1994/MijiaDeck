// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * Qwen3-ASR-0.6B GPU 自动识别与加速推理运行时（基于 llama.cpp Vulkan/CUDA/Metal + Q8_0 GGUF）：
 *
 * - 自动探测系统 GPU（优先独立 NVIDIA / AMD / Intel Arc GPU，过滤虚拟显卡与软件渲染器）
 * - 自动在 127.0.0.1 随机空闲端口拉起本地回环 llama-server，全层卸载至检测到的 GPU（--n-gpu-layers 99）
 * - 支持普通离线转写与 SSE 逐 token 流式转写（配合 Qwen3StreamingHypothesisTracker 实现低延迟流式字幕与智能断句）
 * - 无 GPU、未下载 GPU 组件或 GPU 推理异常时零阻塞优雅回落至 CPU Qwen3-ASR / 备用 SenseVoice
 */

import { existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { DEFAULT_QWEN3_ASR_MODEL, isLocalEndpointUrl } from "../core/agentConfigStore.ts";
import { encodeWavPcm16 } from "./audioPcm.ts";

export type GpuBackendKind = "vulkan" | "cuda" | "metal" | "rocm" | "remote" | "none";

export interface DetectedGpuDevice {
  id: string;
  backend: GpuBackendKind;
  name: string;
  vramTotalMb: number | null;
  vramFreeMb: number | null;
  isDiscrete: boolean;
}

export interface Qwen3GpuStatus {
  detected: boolean;
  backend: GpuBackendKind;
  remote?: boolean;
  serviceUrl?: string | null;
  modelName?: string;
  deviceId: string | null;
  deviceName: string | null;
  vramTotalMb: number | null;
  vramFreeMb: number | null;
  runtimeReady: boolean;
  modelReady: boolean;
  ready: boolean;
  serverRunning: boolean;
  lastLatencyMs?: number | null;
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

export interface Qwen3GpuModelPaths {
  modelsDir: string;
  runtimeDir: string;
  serverBin: string;
  ggufDir: string;
  modelPath: string;
  mmprojPath: string;
}

export interface Qwen3GpuTranscribeOptions {
  voiceLang?: string;
  hotwords?: readonly string[];
  maxTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** 传入此回调时自动启用 SSE 逐 token 流式输出 */
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

export const QWEN3_GPU_RUNTIME_DIR_NAME = "llama-cpp-vulkan";
export const QWEN3_GPU_GGUF_DIR_NAME = "qwen3-asr-0.6b-gguf";
export const QWEN3_GPU_MODEL_FILENAME = "Qwen3-ASR-0.6B-Q8_0.gguf";
export const QWEN3_GPU_MMPROJ_FILENAME = "mmproj-Qwen3-ASR-0.6B-Q8_0.gguf";

export const QWEN3_GPU_DOWNLOAD_URLS = {
  llamaWinVulkanZip:
    "https://github.com/ggml-org/llama.cpp/releases/download/b12722/llama-b12722-bin-win-vulkan-x64.zip",
  qwen3GgufModel:
    "https://huggingface.co/ggml-org/Qwen3-ASR-0.6B-GGUF/resolve/main/Qwen3-ASR-0.6B-Q8_0.gguf",
  qwen3GgufMmproj:
    "https://huggingface.co/ggml-org/Qwen3-ASR-0.6B-GGUF/resolve/main/mmproj-Qwen3-ASR-0.6B-Q8_0.gguf",
} as const;

const GPU_INIT_RETRY_COOLDOWN_MS = 30_000;
const MIN_VRAM_MB = 1536;

const VIRTUAL_OR_SW_GPU_RE =
  /microsoft basic|llvmpipe|swiftshader|todesk|parsec|citrix|vmware|virtualbox|hyper-v|remote display|mirror driver|meta virtual/i;
const DISCRETE_GPU_RE =
  /nvidia|geforce|\brtx\b|\bgtx\b|quadro|tesla|titan|radeon\s+rx|radeon\s+pro|radeon\s+vii|intel\(r\)\s+arc|\barc\s+[ab]\d/i;
const INTEGRATED_GPU_RE = /intel\(r\)\s+(?:uhd|hd|iris)|radeon\(tm\)\s+graphics|vega\s+\d/i;

export function resolveQwen3GpuModelPaths(modelsDir: string): Qwen3GpuModelPaths {
  const root = path.resolve(modelsDir);
  const runtimeDir = path.join(root, QWEN3_GPU_RUNTIME_DIR_NAME);
  const binName = process.platform === "win32" ? "llama-server.exe" : "llama-server";
  const ggufDir = path.join(root, QWEN3_GPU_GGUF_DIR_NAME);
  return {
    modelsDir: root,
    runtimeDir,
    serverBin: path.join(runtimeDir, binName),
    ggufDir,
    modelPath: path.join(ggufDir, QWEN3_GPU_MODEL_FILENAME),
    mmprojPath: path.join(ggufDir, QWEN3_GPU_MMPROJ_FILENAME),
  };
}

function inferBackendFromDeviceId(id: string): GpuBackendKind {
  const lower = id.trim().toLowerCase();
  if (lower.startsWith("vulkan")) return "vulkan";
  if (lower.startsWith("cuda")) return "cuda";
  if (lower.startsWith("mtl") || lower.startsWith("metal")) return "metal";
  if (lower.startsWith("rocm") || lower.startsWith("hip")) return "rocm";
  return "none";
}

/**
 * 解析 `llama-server --list-devices` 输出中的硬件 GPU 列表。
 * 示例行：
 *   Vulkan0: Intel(R) UHD Graphics (16295 MiB, 15527 MiB free)
 *   Vulkan1: NVIDIA GeForce RTX 3060 Laptop GPU (6009 MiB, 5241 MiB free)
 */
export function parseLlamaListDevicesOutput(output: string): DetectedGpuDevice[] {
  const devices: DetectedGpuDevice[] = [];
  const lines = output.split(/\r?\n/);
  const re = /^\s*([A-Za-z]+\d+)\s*:\s*(.+?)(?:\s*\((\d+)\s*MiB(?:,\s*(\d+)\s*MiB\s*free)?\))?\s*$/i;

  for (const line of lines) {
    const m = re.exec(line);
    if (!m) continue;
    const id = m[1]!.trim();
    const backend = inferBackendFromDeviceId(id);
    if (backend === "none") continue;
    const name = m[2]!.trim();
    if (!name || VIRTUAL_OR_SW_GPU_RE.test(name)) continue;
    const vramTotalMb = m[3] ? Number.parseInt(m[3], 10) : null;
    const vramFreeMb = m[4] ? Number.parseInt(m[4], 10) : vramTotalMb;
    const isDiscrete = DISCRETE_GPU_RE.test(name) && !INTEGRATED_GPU_RE.test(name);
    devices.push({
      id,
      backend,
      name,
      vramTotalMb: Number.isFinite(vramTotalMb) ? vramTotalMb : null,
      vramFreeMb: Number.isFinite(vramFreeMb) ? vramFreeMb : null,
      isDiscrete,
    });
  }
  return devices;
}

/**
 * 从候选 GPU 列表中挑选最适合运行 Qwen3-ASR-0.6B 的 GPU：
 * 优先独立显卡（NVIDIA RTX/GTX、AMD Radeon RX、Intel Arc），其次足够显存的集成 GPU/Apple Silicon。
 */
export function selectBestGpuDevice(
  devices: readonly DetectedGpuDevice[],
): DetectedGpuDevice | null {
  let best: DetectedGpuDevice | null = null;
  let bestScore = -Infinity;

  for (const dev of devices) {
    if (dev.backend === "none" || VIRTUAL_OR_SW_GPU_RE.test(dev.name)) continue;
    const freeMb = dev.vramFreeMb ?? dev.vramTotalMb ?? 0;
    if (dev.vramTotalMb !== null && dev.vramTotalMb < MIN_VRAM_MB) {
      continue;
    }
    let score = 0;
    if (dev.isDiscrete) score += 1000;
    else if (dev.backend === "metal") score += 900;
    else if (INTEGRATED_GPU_RE.test(dev.name)) score += 200;
    else score += 400;

    if (dev.backend === "cuda") score += 120;
    else if (dev.backend === "vulkan") score += 100;
    else if (dev.backend === "metal") score += 100;

    if (/nvidia|rtx|gtx/i.test(dev.name)) score += 80;
    score += Math.min(200, Math.round(freeMb / 64));

    if (score > bestScore) {
      bestScore = score;
      best = dev;
    }
  }
  return best;
}

/**
 * 清洗 llama-server Qwen3-ASR 响应中可能带有的 `<asr_text>` / `<think>` / 语言脚手架标签。
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

export function buildQwen3GpuChatPayload(
  wavBase64: string,
  options: {
    voiceLang?: string;
    hotwords?: readonly string[];
    maxTokens?: number;
    stream?: boolean;
  } = {},
): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = [];
  const hotwordStr = (options.hotwords ?? [])
    .map((w) => w.replace(/,/g, " ").trim())
    .filter((w) => w.length > 0)
    .slice(0, 12)
    .join(" ");

  if (hotwordStr) {
    messages.push({ role: "system", content: hotwordStr });
  }

  const userContent: Array<Record<string, unknown>> = [
    {
      type: "input_audio",
      input_audio: {
        data: wavBase64,
        format: "wav",
      },
    },
  ];
  messages.push({ role: "user", content: userContent });

  return {
    model: "qwen3-asr-0.6b",
    messages,
    temperature: 0,
    top_p: 0.8,
    seed: 42,
    max_tokens: Math.max(16, Math.min(512, Math.round(options.maxTokens ?? 128))),
    stream: Boolean(options.stream),
  };
}

async function reserveEphemeralPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        srv.close(() => reject(new Error("无法分配本地 GPU 服务端口")));
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

function probeOsGpuSync(): DetectedGpuDevice | null {
  try {
    if (process.platform === "darwin" && process.arch === "arm64") {
      return {
        id: "MTL0",
        backend: "metal",
        name: "Apple Silicon GPU",
        vramTotalMb: null,
        vramFreeMb: null,
        isDiscrete: false,
      };
    }

    // 1. 快速探测 NVIDIA GPU（nvidia-smi，通常 <60ms，跨 Windows/Linux 有效）
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
        const hasVulkan =
          process.platform !== "win32" || existsSync("C:\\Windows\\System32\\vulkan-1.dll");
        return {
          id: hasVulkan ? "Vulkan0" : "CUDA0",
          backend: hasVulkan ? "vulkan" : "cuda",
          name,
          vramTotalMb: Number.isFinite(total) ? total : null,
          vramFreeMb: Number.isFinite(free) ? free : null,
          isDiscrete: true,
        };
      }
    }

    // 2. Linux DRM GPU 节点检查
    if (process.platform === "linux" && existsSync("/dev/dri/renderD128")) {
      return {
        id: "Vulkan0",
        backend: "vulkan",
        name: "Vulkan GPU (/dev/dri/renderD128)",
        vramTotalMb: null,
        vramFreeMb: null,
        isDiscrete: false,
      };
    }
  } catch {
    // 探测失败视为无可用 GPU，静默降级 CPU
  }
  return null;
}

const activeGpuSubprocesses = new Set<ReturnType<typeof Bun.spawn>>();
let exitHookRegistered = false;

function registerProcessExitCleanup(): void {
  if (exitHookRegistered) return;
  exitHookRegistered = true;
  const cleanup = () => {
    for (const proc of activeGpuSubprocesses) {
      try {
        proc.kill(9);
      } catch {
        // ignore
      }
    }
    activeGpuSubprocesses.clear();
  };
  process.once("exit", cleanup);
}

export class Qwen3AsrGpuRuntime {
  private readonly _modelsDir: string;
  private readonly _fetcher: typeof fetch;
  private _remoteServiceUrl = "";
  private _remoteApiKey = "";
  private _remoteModel = DEFAULT_QWEN3_ASR_MODEL;
  private _remoteGpuName: string | null = null;
  private _remoteLastLatencyMs: number | null = null;
  private _cachedDevice: DetectedGpuDevice | null | undefined;
  private _cachedFromBinary = false;
  private _proc: ReturnType<typeof Bun.spawn> | null = null;
  private _baseUrl: string | null = null;
  private _startPromise: Promise<string> | null = null;
  private _warmedUp = false;
  private _initFailedAt = 0;
  private _lastError: string | null = null;
  private _disposed = false;

  constructor(options: {
    modelsDir: string;
    serviceUrl?: string;
    apiKey?: string;
    model?: string;
    fetcher?: typeof fetch;
  }) {
    this._modelsDir = path.resolve(options.modelsDir);
    this._fetcher = options.fetcher ?? globalThis.fetch;
    if (options.serviceUrl || options.apiKey || options.model) {
      this.setRemoteConfig({
        serviceUrl: options.serviceUrl ?? "",
        apiKey: options.apiKey ?? "",
        model: options.model ?? DEFAULT_QWEN3_ASR_MODEL,
      });
    }
  }

  get paths(): Qwen3GpuModelPaths {
    return resolveQwen3GpuModelPaths(this._modelsDir);
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
      if (this.isRemoteConfigured()) {
        // 切至在线远程 Qwen3-ASR 网关时立即释放本地 llama-server 显存
        this._killProcess();
      }
    }
  }

  hasRuntimeBinary(): boolean {
    return existsSync(this.paths.serverBin);
  }

  hasGgufModels(): boolean {
    const p = this.paths;
    return existsSync(p.modelPath) && existsSync(p.mmprojPath);
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

  /**
   * 自动检测本机可用 GPU（优先直接调用 `llama-server --list-devices` 获取精确 Vulkan 设备号与显存，
   * 尚未下载运行时则回退 OS 级 GPU 探测）。结果自动缓存，热路径零开销。
   */
  detectGpu(forceRefresh = false): DetectedGpuDevice | null {
    const hasBin = this.hasRuntimeBinary();
    if (!forceRefresh && this._cachedDevice !== undefined && (this._cachedFromBinary || !hasBin)) {
      return this._cachedDevice;
    }

    if (hasBin) {
      try {
        const res = Bun.spawnSync([this.paths.serverBin, "--list-devices"], {
          stdout: "pipe",
          stderr: "pipe",
        });
        const combined =
          new TextDecoder().decode(res.stdout) + "\n" + new TextDecoder().decode(res.stderr);
        const devices = parseLlamaListDevicesOutput(combined);
        const picked = selectBestGpuDevice(devices);
        this._cachedDevice = picked;
        this._cachedFromBinary = true;
        return picked;
      } catch (err) {
        this._lastError = err instanceof Error ? err.message : String(err);
      }
    }

    const osDev = probeOsGpuSync();
    this._cachedDevice = osDev;
    this._cachedFromBinary = false;
    return osDev;
  }

  getStatus(): Qwen3GpuStatus {
    const hasRemoteUrl = this._remoteServiceUrl.length > 0;
    if (this.isRemoteConfigured()) {
      return {
        detected: true,
        backend: "remote",
        remote: true,
        serviceUrl: this._remoteServiceUrl,
        modelName: this._remoteModel,
        deviceId: "remote",
        deviceName: this._remoteGpuName ?? "在线 Qwen3-ASR GPU",
        vramTotalMb: null,
        vramFreeMb: null,
        runtimeReady: true,
        modelReady: true,
        ready: true,
        serverRunning: true,
        lastLatencyMs: this._remoteLastLatencyMs,
        lastError: this._lastError,
      };
    }
    const dev = this.detectGpu(false);
    const runtimeReady = this.hasRuntimeBinary();
    const modelReady = this.hasGgufModels();
    const detected = dev !== null;
    const ready = !hasRemoteUrl && detected && runtimeReady && modelReady;
    return {
      detected,
      backend: dev?.backend ?? "none",
      remote: false,
      serviceUrl: hasRemoteUrl ? this._remoteServiceUrl : this._baseUrl,
      modelName: hasRemoteUrl ? this._remoteModel : "Qwen3-ASR-0.6B-Q8_0",
      deviceId: dev?.id ?? null,
      deviceName: dev?.name ?? null,
      vramTotalMb: dev?.vramTotalMb ?? null,
      vramFreeMb: dev?.vramFreeMb ?? null,
      runtimeReady,
      modelReady,
      ready,
      serverRunning: this._proc !== null && this._baseUrl !== null,
      lastLatencyMs: this._remoteLastLatencyMs,
      lastError: hasRemoteUrl ? "缺少在线 Qwen3-ASR 授权码，请填写授权码" : this._lastError,
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
   * 惰性启动本地回环 GPU 推理服务（或返回已配置的在线 Qwen3-ASR 网关地址），等待 `/health` 就绪后返回服务地址。
   */
  async ensureStarted(): Promise<string> {
    if (this._disposed) {
      throw new Error("Qwen3-ASR GPU 运行时已释放");
    }
    if (this.isRemoteConfigured()) {
      return this._remoteServiceUrl;
    }
    if (this._baseUrl && this._proc && this._proc.exitCode === null) {
      return this._baseUrl;
    }
    if (this._startPromise) {
      return this._startPromise;
    }

    const dev = this.detectGpu(false);
    if (!dev) {
      throw new Error("未检测到可用的硬件 GPU");
    }
    if (!this.hasRuntimeBinary() || !this.hasGgufModels()) {
      throw new Error("Qwen3-ASR-0.6B GPU 运行时或 GGUF 模型尚未就绪");
    }

    this._startPromise = (async () => {
      registerProcessExitCleanup();
      const port = await reserveEphemeralPort();
      const baseUrl = `http://127.0.0.1:${port}`;
      const p = this.paths;

      const args = [
        "--model",
        p.modelPath,
        "--mmproj",
        p.mmprojPath,
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--n-gpu-layers",
        "99",
        "--ctx-size",
        "2048",
        "--batch-size",
        "512",
        "--parallel",
        "1",
        "--flash-attn",
        "on",
        "--no-webui",
      ];
      if (dev.id) {
        args.push("--device", dev.id);
      }

      const proc = Bun.spawn([p.serverBin, ...args], {
        cwd: p.runtimeDir,
        stdout: "ignore",
        stderr: "pipe",
      });
      this._proc = proc;
      activeGpuSubprocesses.add(proc);

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
            // ignore stderr drain error on kill
          }
        })();
      }

      void proc.exited.then(() => {
        activeGpuSubprocesses.delete(proc);
        if (this._proc === proc) {
          this._proc = null;
          this._baseUrl = null;
        }
      });

      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        if (this._disposed) {
          this._killProcess();
          throw new Error("Qwen3-ASR GPU 运行时在启动期间已释放");
        }
        if (proc.exitCode !== null) {
          const msg = `llama-server 提前退出 (code=${proc.exitCode}): ${stderrTail.trim().slice(-300)}`;
          this._initFailedAt = Date.now();
          this._lastError = msg;
          throw new Error(msg);
        }
        try {
          const res = await fetch(`${baseUrl}/health`, {
            signal: AbortSignal.timeout(1000),
          });
          if (res.ok) {
            this._baseUrl = baseUrl;
            this._initFailedAt = 0;
            this._lastError = null;
            return baseUrl;
          }
        } catch {
          // still loading model weights into VRAM
        }
        await Bun.sleep(150);
      }

      this._killProcess();
      const timeoutMsg = `Qwen3-ASR GPU 服务启动超时 (30s): ${stderrTail.trim().slice(-240)}`;
      this._initFailedAt = Date.now();
      this._lastError = timeoutMsg;
      throw new Error(timeoutMsg);
    })().finally(() => {
      this._startPromise = null;
    });

    return this._startPromise;
  }

  /**
   * 后台预热 GPU 推理服务（本地编译 Vulkan 着色器管线；在线网关则执行轻量 /health 探活并同步远端 GPU 信息）。
   */
  async warmup(): Promise<void> {
    if (this._disposed || this._warmedUp) return;
    if (this.isRemoteConfigured()) {
      await this.probeRemoteHealth({ timeoutMs: 8000 });
      return;
    }
    await this.ensureStarted();
    if (this._disposed || this._warmedUp) return;
    try {
      // 发送 0.25s 静音短片触发一次极轻推理，提前完成 Vulkan shader 编译与显存池初始化
      await this.transcribe(new Float32Array(4000), {
        maxTokens: 4,
        timeoutMs: 35_000,
      });
    } catch {
      // 预热短片失败不影响后续正式请求
    }
  }

  /**
   * 通过在线 Voice & ASR Gateway（OpenAI Whisper 兼容 /v1/audio/transcriptions 或 /v1/transcribe）
   * 调用远程 GPU Qwen3-ASR-0.6B 执行多语言语音识别。
   */
  private async _transcribeViaRemoteGateway(
    pcm16k: Float32Array,
    options: Qwen3GpuTranscribeOptions,
  ): Promise<Qwen3GpuTranscribeResult> {
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

  /**
   * 在 GPU 上执行 Qwen3-ASR-0.6B 语音转写（支持在线网关、本地 GPU 一次性转写与 SSE 逐 token 流式转写）。
   */
  async transcribe(
    pcm16k: Float32Array,
    options: Qwen3GpuTranscribeOptions = {},
  ): Promise<Qwen3GpuTranscribeResult> {
    if (options.signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    if (this.isRemoteConfigured()) {
      return this._transcribeViaRemoteGateway(pcm16k, options);
    }
    const t0 = performance.now();
    const baseUrl = await this.ensureStarted();
    if (options.signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    const dev = this.detectGpu(false);

    const wavBytes = encodeWavPcm16(pcm16k, 16000);
    const wavBase64 = Buffer.from(wavBytes.buffer, wavBytes.byteOffset, wavBytes.byteLength).toString(
      "base64",
    );
    const wantStream = typeof options.onPartial === "function";
    const audioSec = pcm16k.length / 16000;
    const autoMaxTokens =
      options.maxTokens ?? Math.max(128, Math.min(512, Math.ceil(audioSec * 16) + 32));
    const payload = buildQwen3GpuChatPayload(wavBase64, {
      voiceLang: options.voiceLang,
      hotwords: options.hotwords,
      maxTokens: autoMaxTokens,
      stream: wantStream,
    });

    // 首次推理需编译 Vulkan 着色器（约 5~14s），预热后单句仅 ~150~220ms；长语音按时长适当放宽超时
    const warmedTimeoutMs = Math.max(12_000, Math.min(30_000, Math.round(audioSec * 800) + 6000));
    const timeoutMs = options.timeoutMs ?? (this._warmedUp ? warmedTimeoutMs : 30_000);
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
    const combinedSignal = options.signal
      ? AbortSignal.any([options.signal, timeoutController.signal])
      : timeoutController.signal;

    try {
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: combinedSignal,
      });
      if (!res.ok) {
        const bodyText = await res.text().catch(() => "");
        throw new Error(`Qwen3-ASR GPU 请求失败 (${res.status}): ${bodyText.slice(0, 200)}`);
      }

      if (!wantStream) {
        const json = (await res.json()) as {
          choices?: Array<{
            message?: { content?: string; reasoning_content?: string };
          }>;
        };
        const msg = json.choices?.[0]?.message;
        const rawText = String(msg?.content ?? "");
        const reasoning = String(msg?.reasoning_content ?? "");
        const langMatch = /language\s+([A-Za-z_-]+)/i.exec(reasoning || rawText);
        const text = parseQwen3GpuResponseText(rawText);
        this._warmedUp = true;
        return {
          text,
          rawText,
          lang: langMatch?.[1] ?? "",
          durationMs: Math.round(performance.now() - t0),
          deviceId: dev?.id ?? null,
          deviceName: dev?.name ?? null,
          backend: dev?.backend ?? "vulkan",
        };
      }

      // SSE 逐 token 流式解析
      let rawAccum = "";
      let reasoningAccum = "";
      let lastEmittedClean = "";
      if (res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let lineBuf = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          lineBuf += decoder.decode(value, { stream: true });
          let nl = lineBuf.indexOf("\n");
          while (nl >= 0) {
            const line = lineBuf.slice(0, nl).trim();
            lineBuf = lineBuf.slice(nl + 1);
            if (line.startsWith("data:")) {
              const dataStr = line.slice(5).trim();
              if (dataStr && dataStr !== "[DONE]") {
                try {
                  const chunk = JSON.parse(dataStr) as {
                    choices?: Array<{
                      delta?: { content?: string; reasoning_content?: string };
                    }>;
                  };
                  const delta = chunk.choices?.[0]?.delta;
                  if (typeof delta?.reasoning_content === "string") {
                    reasoningAccum += delta.reasoning_content;
                  }
                  if (typeof delta?.content === "string" && delta.content.length > 0) {
                    rawAccum += delta.content;
                    const cleaned = parseQwen3GpuResponseText(rawAccum);
                    if (cleaned && cleaned !== lastEmittedClean) {
                      lastEmittedClean = cleaned;
                      options.onPartial?.(cleaned);
                    }
                  }
                } catch {
                  // ignore malformed partial JSON chunk
                }
              }
            }
            nl = lineBuf.indexOf("\n");
          }
        }
      }

      const text = parseQwen3GpuResponseText(rawAccum);
      const langMatch = /language\s+([A-Za-z_-]+)/i.exec(reasoningAccum || rawAccum);
      this._warmedUp = true;
      return {
        text,
        rawText: rawAccum,
        lang: langMatch?.[1] ?? "",
        durationMs: Math.round(performance.now() - t0),
        deviceId: dev?.id ?? null,
        deviceName: dev?.name ?? null,
        backend: dev?.backend ?? "vulkan",
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
   * 补齐下载 Windows Vulkan GPU 运行时与 Qwen3-ASR-0.6B Q8_0 GGUF 模型（流式落盘，低内存占用）。
   */
  async downloadMissingAssets(): Promise<Qwen3GpuStatus> {
    const p = this.paths;
    mkdirSync(p.runtimeDir, { recursive: true });
    mkdirSync(p.ggufDir, { recursive: true });

    const streamDownload = async (url: string, dest: string) => {
      if (existsSync(dest)) return;
      const part = `${dest}.part`;
      const res = await fetch(url, { redirect: "follow" });
      if (!res.ok) {
        throw new Error(`下载 GPU 组件失败 (${res.status}): ${path.basename(dest)}`);
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
    };

    if (!existsSync(p.serverBin) && process.platform === "win32" && process.arch === "x64") {
      const zipPath = path.join(p.modelsDir, "llama-cpp-vulkan-win-x64.zip");
      await streamDownload(QWEN3_GPU_DOWNLOAD_URLS.llamaWinVulkanZip, zipPath);
      const proc = Bun.spawn(
        [
          "powershell.exe",
          "-NoProfile",
          "-Command",
          `Expand-Archive -Force -Path '${zipPath.replace(/'/g, "''")}' -DestinationPath '${p.runtimeDir.replace(/'/g, "''")}'`,
        ],
        { stdout: "ignore", stderr: "pipe" },
      );
      const code = await proc.exited;
      try {
        if (existsSync(zipPath)) unlinkSync(zipPath);
      } catch {
        // ignore
      }
      if (code !== 0) {
        const errText = await new Response(proc.stderr).text();
        throw new Error(`解压 Vulkan GPU 运行时失败: ${errText.trim() || code}`);
      }
    }

    await streamDownload(QWEN3_GPU_DOWNLOAD_URLS.qwen3GgufMmproj, p.mmprojPath);
    await streamDownload(QWEN3_GPU_DOWNLOAD_URLS.qwen3GgufModel, p.modelPath);

    this.resetFailureCooldown();
    this.detectGpu(true);
    return this.getStatus();
  }

  private _killProcess(): void {
    const proc = this._proc;
    this._proc = null;
    this._baseUrl = null;
    this._warmedUp = false;
    if (!proc) return;
    activeGpuSubprocesses.delete(proc);
    try {
      proc.kill(9);
    } catch {
      // ignore
    }
  }

  dispose(): void {
    this._disposed = true;
    this._killProcess();
  }
}
