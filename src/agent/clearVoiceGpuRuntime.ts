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
import { projectRoot } from "../core/appMeta.ts";
import { estimateSnrDb, resampleLinear } from "./audioPcm.ts";
import {
  ClearVoiceSliceAssembler,
  DEFAULT_CLEARVOICE_CHUNKER_CONFIG,
} from "./clearVoiceChunker.ts";

export interface ClearVoiceGpuModelPaths {
  modelsDir: string;
  modelDir: string;
  modelFp32Path: string;
  modelInt8Path: string;
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
  scriptReady: boolean;
  customServiceUrl: string;
  ready: boolean;
  serverRunning: boolean;
  provider: "cuda" | "cpu" | "remote" | "none";
  modelName: string;
  serviceUrl: string | null;
  lastLatencyMs: number | null;
  lastInferMs: number | null;
  lastError: string | null;
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
export const CLEARVOICE_RUNTIME_DIR_NAME = "clearvoice-gpu-runtime";
export const CLEARVOICE_MODEL_FP32_FILENAME = "model.onnx";
export const CLEARVOICE_MODEL_INT8_FILENAME = "model.int8.onnx";

export const CLEARVOICE_DOWNLOAD_URLS = {
  modelFp32:
    "https://modelscope.cn/models/manyeyes/mossformer2-se-48k-onnx/resolve/master/model.onnx",
  modelInt8:
    "https://modelscope.cn/models/manyeyes/mossformer2-se-48k-onnx/resolve/master/model.int8.onnx",
} as const;

const CLEARVOICE_INIT_RETRY_COOLDOWN_MS = 30_000;

export function resolveClearVoiceGpuPaths(
  modelsDir: string,
  serverScriptOverride?: string,
): ClearVoiceGpuModelPaths {
  const root = path.resolve(modelsDir);
  const modelDir = path.join(root, CLEARVOICE_MODEL_DIR_NAME);
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
  private _customServiceUrl = "";
  private _gpuProbeCache:
    | { detected: boolean; name: string | null; vramTotalMb: number | null; vramFreeMb: number | null }
    | null = null;
  private _proc: ReturnType<typeof Bun.spawn> | null = null;
  private _baseUrl: string | null = null;
  private _startPromise: Promise<string> | null = null;
  private _activeProvider: "cuda" | "cpu" | "remote" | "none" = "none";
  private _activeGpuName: string | null = null;
  private _warmedUp = false;
  private _initFailedAt = 0;
  private _lastError: string | null = null;
  private _lastLatencyMs: number | null = null;
  private _lastInferMs: number | null = null;
  private _disposed = false;

  constructor(options: { modelsDir: string; serviceUrl?: string; serverScript?: string }) {
    this._modelsDir = path.resolve(options.modelsDir);
    this._serverScriptOverride = options.serverScript;
    if (options.serviceUrl) {
      this.setCustomServiceUrl(options.serviceUrl);
    }
  }

  get paths(): ClearVoiceGpuModelPaths {
    return resolveClearVoiceGpuPaths(this._modelsDir, this._serverScriptOverride);
  }

  get customServiceUrl(): string {
    return this._customServiceUrl;
  }

  setCustomServiceUrl(url: string): void {
    const trimmed = url.trim().replace(/\/+$/, "");
    if (trimmed !== this._customServiceUrl) {
      this._customServiceUrl = trimmed;
      this.resetFailureCooldown();
      if (trimmed) {
        this._activeProvider = "remote";
      } else if (!this._proc) {
        this._activeProvider = "none";
      }
    }
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

  hasModel(): boolean {
    return this.resolveModelPath() !== null;
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
    const scriptReady = this.hasServerScript();
    const hasCustom = this._customServiceUrl.length > 0;
    const ready = hasCustom || (runtimeReady && modelReady && scriptReady);
    const serverRunning = hasCustom || (this._proc !== null && this._baseUrl !== null);
    const provider: ClearVoiceGpuStatus["provider"] = hasCustom
      ? "remote"
      : this._activeProvider !== "none"
        ? this._activeProvider
        : ready && gpu.detected
          ? "cuda"
          : ready
            ? "cpu"
            : "none";

    return {
      gpuDetected: gpu.detected,
      gpuName: this._activeGpuName ?? gpu.name,
      vramTotalMb: gpu.vramTotalMb,
      vramFreeMb: gpu.vramFreeMb,
      runtimeReady,
      modelReady,
      scriptReady,
      customServiceUrl: this._customServiceUrl,
      ready,
      serverRunning,
      provider,
      modelName: "MossFormer2_SE_48K",
      serviceUrl: hasCustom ? this._customServiceUrl : this._baseUrl,
      lastLatencyMs: this._lastLatencyMs,
      lastInferMs: this._lastInferMs,
      lastError: this._lastError,
    };
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

      const deadline = Date.now() + 90_000;
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
              gpuName?: string | null;
              warmedUp?: boolean;
            };
            this._baseUrl = baseUrl;
            this._activeProvider =
              info.device === "gpu" || info.provider === "CUDAExecutionProvider" ? "cuda" : "cpu";
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
      const timeoutMsg = `ClearVoice GPU 服务启动超时 (90s): ${stderrTail.trim().slice(-240)}`;
      this._initFailedAt = Date.now();
      this._lastError = timeoutMsg;
      throw new Error(timeoutMsg);
    })().finally(() => {
      this._startPromise = null;
    });

    return this._startPromise;
  }

  /**
   * 后台预热 ClearVoice GPU 推理服务（含模型显存加载与 CUDA kernel 预热）。
   */
  async warmup(): Promise<void> {
    if (this._disposed || (this._warmedUp && this._baseUrl)) return;
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
        device: this._activeProvider === "cuda" ? "gpu" : "cpu",
        model: "MossFormer2_SE_48K",
        gpuName: this._activeGpuName,
      };
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
      const res = await fetch(`${baseUrl}/denoise`, {
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
        lastDevice === "gpu" ? "clearvoice-mossformer2-gpu" : "clearvoice-mossformer2-cpu",
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
   * 补齐下载 MossFormer2_SE_48K ONNX 模型文件（流式落盘 + 原子重命名）。
   */
  async downloadMissingModel(): Promise<ClearVoiceGpuStatus> {
    const p = this.paths;
    mkdirSync(p.modelDir, { recursive: true });
    if (!this.hasModel()) {
      const dest = p.modelFp32Path;
      const part = `${dest}.part`;
      const res = await fetch(CLEARVOICE_DOWNLOAD_URLS.modelFp32, { redirect: "follow" });
      if (!res.ok) {
        throw new Error(`下载 ClearVoice MossFormer2_SE_48K 模型失败 (${res.status})`);
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
