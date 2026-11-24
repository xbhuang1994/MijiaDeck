// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * 本地离线 openWakeWord 声学唤醒词引擎（零外部 npm 依赖，bun:ffi 直连 ONNX Runtime C API v17）：
 * - Stage 1：melspectrogram.onnx（输入 int16 标度 Float32 [-32768, 32767]，1760 采样滑窗 -> [1,1,8,32]，后处理 x/10+2）
 * - Stage 2：embedding_model.onnx（输入 [B,76,32,1] -> 输出 conv2d_19 [B,1,1,96] 96 维语音嵌入）
 * - Stage 3：均值中心化余弦相似度（65%）+ 带约束子序列 DTW（35%，支持 0.70x~1.45x 语速拉伸）+ 硬负样本对比校准
 * - 支持毫秒级连续流式检测（OpenWakeWordStreamSession，含静音 RMS 快路径跳过）、离线片段打分、
 *   双相位偏移（0 / 40ms）用户定制唤醒词录制，以及 Windows SAPI 多音色异步零样本预热。
 */

import {
  CString,
  FFIType,
  dlopen,
  linkSymbols,
  ptr,
  read,
  toArrayBuffer,
  type Pointer,
} from "bun:ffi";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { projectRoot } from "../core/appMeta.ts";
import { dataFile } from "../core/jsonStore.ts";
import {
  applyHighPassFilter,
  computeRms,
  decodeWavPcm,
  l2Normalize,
  resampleLinear,
} from "./audioPcm.ts";
import {
  WAKEWORD_EMBEDDING_DIM,
  addWakeWordPrototype,
  getPrototypesForWords,
  listWakeWordPrototypeSummaries,
  loadWakeWordStore,
  normalizeWakeWordKey,
  replaceTtsPrototypesForWord,
  setStoreBackgroundStats,
  type ReplaceTtsPrototypeInput,
  type WakeWordHardNegativeRecord,
  type WakeWordPrototypeRecord,
  type WakeWordPrototypeSource,
  type WakeWordPrototypeSummary,
} from "./wakewordPrototypeStore.ts";

export const OPEN_WAKEWORD_MODEL_URLS = {
  mel: "https://github.com/dscripka/openWakeWord/releases/download/v0.5.1/melspectrogram.onnx",
  embedding:
    "https://github.com/dscripka/openWakeWord/releases/download/v0.5.1/embedding_model.onnx",
} as const;

export const DEFAULT_HARD_NEGATIVES = [
  "no",
  "new",
  "near",
  "你好",
  "你有",
  "打开",
  "小爱",
] as const;

export const DEFAULT_WAKEWORD_THRESHOLD = 0.68;

const SAMPLE_RATE = 16000;
const HOP_SAMPLES = 1280; // 80ms @ 16kHz
const HOP_MS = 80;
const OVERLAP_SAMPLES = 480; // 30ms lookback -> 1760 samples yields exact [1,1,8,32]
const MEL_WINDOW_SAMPLES = OVERLAP_SAMPLES + HOP_SAMPLES; // 1760
const MEL_BINS = 32;
const MEL_HOP_FRAMES = 8;
const EMB_WINDOW_FRAMES = 76;
const EMB_WINDOW_FLOATS = EMB_WINDOW_FRAMES * MEL_BINS; // 2432
const SILENCE_MEL_VALUE = -8.0; // melspectrogram.onnx on digital silence after (x / 10 + 2)
const PHASE_SHIFT_SAMPLES = 640; // 40ms half-hop shift invariance

const SILENCE_RMS_THRESHOLD = 0.0025;
const SILENCE_SKIP_CONSECUTIVE_FRAMES = 12;
const WARMUP_SUPPRESS_FRAMES = 5; // 400ms
const DEFAULT_DEBOUNCE_MS = 1500;
const EMB_HISTORY_CAPACITY = 24;
const MAX_SEGMENT_TRACK_FRAMES = 256;

const ORT_API_VERSION = 17;
const ORT_LOGGING_LEVEL_ERROR = 3;
const ORT_ENABLE_ALL = 99;
const ORT_ARENA_ALLOCATOR = 1;
const ORT_MEM_TYPE_DEFAULT = 0;
const ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT = 1;

// ABI-frozen OrtApi(17) vtable 0-based function pointer indices
const ORT_VTABLE = {
  GetErrorMessage: 2,
  CreateEnv: 3,
  CreateSessionFromArray: 8,
  Run: 9,
  CreateSessionOptions: 10,
  SetSessionGraphOptimizationLevel: 23,
  SetIntraOpNumThreads: 24,
  SetInterOpNumThreads: 25,
  CreateTensorWithDataAsOrtValue: 49,
  GetTensorMutableData: 51,
  GetDimensionsCount: 61,
  GetDimensions: 62,
  GetTensorTypeAndShape: 65,
  CreateCpuMemoryInfo: 69,
  ReleaseEnv: 92,
  ReleaseStatus: 93,
  ReleaseMemoryInfo: 94,
  ReleaseSession: 95,
  ReleaseValue: 96,
  ReleaseTensorTypeAndShapeInfo: 99,
  ReleaseSessionOptions: 100,
} as const;

export interface WakeWordAcousticHit {
  matched: boolean;
  wakeWord: string;
  score: number;
  rawScore: number;
  threshold: number;
  source: WakeWordPrototypeSource;
  frameIndex: number;
  sampleOffset: number;
  latencyMs: number;
}

export interface OpenWakeWordModelPaths {
  modelsDir: string;
  openWakeWordDir: string;
  melPath: string;
  embeddingPath: string;
}

export interface OpenWakeWordEngineStatus {
  ready: boolean;
  modelsPresent: boolean;
  runtimeLoaded: boolean;
  melPath: string;
  embeddingPath: string;
  lastError: string | null;
  bootstrapping: boolean;
}

export interface OpenWakeWordEngineOptions {
  modelsDir?: string;
  runtimeLibPath?: string;
  defaultThreshold?: number;
}

export interface OpenWakeWordStreamOptions {
  threshold?: number;
  debounceMs?: number;
  onSpot?: (hit: WakeWordAcousticHit) => void;
}

export interface OpenWakeWordScoreClipOptions {
  threshold?: number;
  headOnlySec?: number;
}

export interface OpenWakeWordEnrollResult {
  record: WakeWordPrototypeRecord;
  summary: WakeWordPrototypeSummary;
  durationMs: number;
}

export interface OpenWakeWordBootstrapResult {
  bootstrapped: string[];
  skipped: string[];
  durationMs: number;
}

interface CompiledPrototype {
  id: string;
  wakeWord: string;
  wordKey: string;
  source: WakeWordPrototypeSource;
  frames: Float32Array[];
}

interface CompiledHardNegative {
  label: string;
  labelKey: string;
  frames: Float32Array[];
}

interface CompiledScoringContext {
  storeUpdatedAt: number;
  bgMean: Float32Array | null;
  prototypes: CompiledPrototype[];
  hardNegatives: CompiledHardNegative[];
  displayWordByKey: Map<string, string>;
  patienceByKey: Map<string, number>;
}

// ---------------------------------------------------------------------------
// 路径解析与错误脱敏
// ---------------------------------------------------------------------------

function sanitizeErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  // 脱敏可能包含敏感凭证或冗长用户目录路径的片段
  const redacted = raw
    .replace(/([A-Za-z]:\\Users\\)[^\\/\s]+/gi, "$1<user>")
    .replace(/(\/Users\/|\/home\/)[^/\s]+/gi, "$1<user>")
    .replace(/(sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._-]{8,})/gi, "<redacted>")
    .replace(/\s+/g, " ")
    .trim();
  return redacted.slice(0, 240) || "未知错误";
}

export function resolveOpenWakeWordModelPaths(modelsDirOverride?: string): OpenWakeWordModelPaths {
  const envDir = process.env.MIJIADECK_VOICE_MODELS_DIR?.trim();
  const baseDir = path.resolve(
    modelsDirOverride || envDir || path.join(projectRoot(), "voice_models"),
  );
  const directMel = path.join(baseDir, "melspectrogram.onnx");
  const directEmb = path.join(baseDir, "embedding_model.onnx");
  const useDirect = Boolean(modelsDirOverride) && (existsSync(directMel) || existsSync(directEmb));
  const openWakeWordDir = useDirect ? baseDir : path.join(baseDir, "openwakeword");
  return {
    modelsDir: baseDir,
    openWakeWordDir,
    melPath: path.join(openWakeWordDir, "melspectrogram.onnx"),
    embeddingPath: path.join(openWakeWordDir, "embedding_model.onnx"),
  };
}

function getOnnxRuntimeLibCandidates(explicitLibPath?: string): string[] {
  if (explicitLibPath?.trim()) {
    return [path.resolve(explicitLibPath.trim())];
  }

  const platform = process.platform;
  const platFolder = platform === "win32" ? "win" : platform;
  const pkgName = `sherpa-onnx-${platFolder}-${process.arch}`;
  const libNames =
    platform === "win32"
      ? ["onnxruntime.dll"]
      : platform === "darwin"
        ? ["libonnxruntime.dylib"]
        : ["libonnxruntime.so", "libonnxruntime.so.1"];

  const dirs: string[] = [];
  const pushDir = (dir: string) => {
    const resolved = path.resolve(dir);
    if (!dirs.includes(resolved)) dirs.push(resolved);
  };

  pushDir(path.join(projectRoot(), "node_modules", pkgName));

  try {
    const req = createRequire(import.meta.url);
    const sherpaEntry = req.resolve("sherpa-onnx-node");
    const sherpaDir = path.dirname(sherpaEntry);
    pushDir(path.join(sherpaDir, "node_modules", pkgName));
    pushDir(path.join(sherpaDir, "..", pkgName));
    pushDir(sherpaDir);
  } catch {
    // sherpa-onnx-node 不可解析时继续探测其他候选路径
  }

  try {
    const req = createRequire(import.meta.url);
    const nativePkg = req.resolve(`${pkgName}/package.json`);
    pushDir(path.dirname(nativePkg));
  } catch {
    // ignore
  }

  const execDir = path.dirname(path.resolve(process.execPath));
  pushDir(execDir);
  pushDir(path.join(execDir, "node_modules", pkgName));
  pushDir(path.join(process.cwd(), "node_modules", pkgName));

  const candidates: string[] = [];
  for (const dir of dirs) {
    for (const name of libNames) {
      candidates.push(path.join(dir, name));
    }
  }
  return candidates;
}

function resolveOnnxRuntimeLibPath(explicitLibPath?: string): string | null {
  const candidates = getOnnxRuntimeLibCandidates(explicitLibPath);
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 零依赖原生 ONNX Runtime C API v17 FFI 封装
// ---------------------------------------------------------------------------

function makeCStringBuf(text: string): Uint8Array {
  const encoded = new TextEncoder().encode(text);
  const buf = new Uint8Array(encoded.byteLength + 1);
  buf.set(encoded, 0);
  buf[encoded.byteLength] = 0;
  return buf;
}

function toPointer(addr: bigint): Pointer {
  return Number(addr) as unknown as Pointer;
}

class OrtNativeRuntime {
  readonly libPath: string;
  private readonly _dlLib;
  private readonly _baseFns;
  private readonly _api;
  private readonly _envPtr: Pointer;
  private readonly _memInfoPtr: Pointer;
  private readonly _sessionOptsPtr: Pointer;

  constructor(libPath: string) {
    this.libPath = libPath;
    this._dlLib = dlopen(libPath, {
      OrtGetApiBase: {
        args: [],
        returns: FFIType.ptr,
      },
    });

    const apiBasePtr = this._dlLib.symbols.OrtGetApiBase();
    if (!apiBasePtr) {
      throw new Error("OrtGetApiBase 返回空指针");
    }

    const getApiAddr = read.u64(apiBasePtr, 0);
    if (getApiAddr === 0n) {
      throw new Error("OrtApiBase.GetApi 函数指针为空");
    }

    this._baseFns = linkSymbols({
      GetApi: {
        ptr: getApiAddr,
        args: [FFIType.u32],
        returns: FFIType.ptr,
      },
    });

    const apiPtr = this._baseFns.symbols.GetApi(ORT_API_VERSION);
    if (!apiPtr) {
      throw new Error(`ONNX Runtime 不支持 C API v${ORT_API_VERSION}`);
    }

    const slot = (idx: number): bigint => {
      const addr = read.u64(apiPtr, idx * 8);
      if (addr === 0n) {
        throw new Error(`OrtApi vtable 槽位 ${idx} 为空指针`);
      }
      return addr;
    };

    this._api = linkSymbols({
      GetErrorMessage: {
        ptr: slot(ORT_VTABLE.GetErrorMessage),
        args: [FFIType.ptr],
        returns: FFIType.ptr,
      },
      CreateEnv: {
        ptr: slot(ORT_VTABLE.CreateEnv),
        args: [FFIType.i32, FFIType.ptr, FFIType.ptr],
        returns: FFIType.ptr,
      },
      CreateSessionFromArray: {
        ptr: slot(ORT_VTABLE.CreateSessionFromArray),
        args: [FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.ptr],
        returns: FFIType.ptr,
      },
      Run: {
        ptr: slot(ORT_VTABLE.Run),
        args: [
          FFIType.ptr,
          FFIType.ptr,
          FFIType.ptr,
          FFIType.ptr,
          FFIType.u64,
          FFIType.ptr,
          FFIType.u64,
          FFIType.ptr,
        ],
        returns: FFIType.ptr,
      },
      CreateSessionOptions: {
        ptr: slot(ORT_VTABLE.CreateSessionOptions),
        args: [FFIType.ptr],
        returns: FFIType.ptr,
      },
      SetSessionGraphOptimizationLevel: {
        ptr: slot(ORT_VTABLE.SetSessionGraphOptimizationLevel),
        args: [FFIType.ptr, FFIType.i32],
        returns: FFIType.ptr,
      },
      SetIntraOpNumThreads: {
        ptr: slot(ORT_VTABLE.SetIntraOpNumThreads),
        args: [FFIType.ptr, FFIType.i32],
        returns: FFIType.ptr,
      },
      SetInterOpNumThreads: {
        ptr: slot(ORT_VTABLE.SetInterOpNumThreads),
        args: [FFIType.ptr, FFIType.i32],
        returns: FFIType.ptr,
      },
      CreateTensorWithDataAsOrtValue: {
        ptr: slot(ORT_VTABLE.CreateTensorWithDataAsOrtValue),
        args: [
          FFIType.ptr,
          FFIType.ptr,
          FFIType.u64,
          FFIType.ptr,
          FFIType.u64,
          FFIType.i32,
          FFIType.ptr,
        ],
        returns: FFIType.ptr,
      },
      GetTensorMutableData: {
        ptr: slot(ORT_VTABLE.GetTensorMutableData),
        args: [FFIType.ptr, FFIType.ptr],
        returns: FFIType.ptr,
      },
      GetDimensionsCount: {
        ptr: slot(ORT_VTABLE.GetDimensionsCount),
        args: [FFIType.ptr, FFIType.ptr],
        returns: FFIType.ptr,
      },
      GetDimensions: {
        ptr: slot(ORT_VTABLE.GetDimensions),
        args: [FFIType.ptr, FFIType.ptr, FFIType.u64],
        returns: FFIType.ptr,
      },
      GetTensorTypeAndShape: {
        ptr: slot(ORT_VTABLE.GetTensorTypeAndShape),
        args: [FFIType.ptr, FFIType.ptr],
        returns: FFIType.ptr,
      },
      CreateCpuMemoryInfo: {
        ptr: slot(ORT_VTABLE.CreateCpuMemoryInfo),
        args: [FFIType.i32, FFIType.i32, FFIType.ptr],
        returns: FFIType.ptr,
      },
      ReleaseEnv: {
        ptr: slot(ORT_VTABLE.ReleaseEnv),
        args: [FFIType.ptr],
        returns: FFIType.void,
      },
      ReleaseStatus: {
        ptr: slot(ORT_VTABLE.ReleaseStatus),
        args: [FFIType.ptr],
        returns: FFIType.void,
      },
      ReleaseMemoryInfo: {
        ptr: slot(ORT_VTABLE.ReleaseMemoryInfo),
        args: [FFIType.ptr],
        returns: FFIType.void,
      },
      ReleaseSession: {
        ptr: slot(ORT_VTABLE.ReleaseSession),
        args: [FFIType.ptr],
        returns: FFIType.void,
      },
      ReleaseValue: {
        ptr: slot(ORT_VTABLE.ReleaseValue),
        args: [FFIType.ptr],
        returns: FFIType.void,
      },
      ReleaseTensorTypeAndShapeInfo: {
        ptr: slot(ORT_VTABLE.ReleaseTensorTypeAndShapeInfo),
        args: [FFIType.ptr],
        returns: FFIType.void,
      },
      ReleaseSessionOptions: {
        ptr: slot(ORT_VTABLE.ReleaseSessionOptions),
        args: [FFIType.ptr],
        returns: FFIType.void,
      },
    });

    const outPtr = new BigUint64Array(1);
    const logIdBuf = makeCStringBuf("mijiadeck-oww");

    this.checkStatus(
      this._api.symbols.CreateEnv(ORT_LOGGING_LEVEL_ERROR, ptr(logIdBuf), ptr(outPtr)),
      "CreateEnv",
    );
    this._envPtr = toPointer(outPtr[0]!);

    this.checkStatus(
      this._api.symbols.CreateSessionOptions(ptr(outPtr)),
      "CreateSessionOptions",
    );
    this._sessionOptsPtr = toPointer(outPtr[0]!);

    this.checkStatus(
      this._api.symbols.SetSessionGraphOptimizationLevel(this._sessionOptsPtr, ORT_ENABLE_ALL),
      "SetSessionGraphOptimizationLevel",
    );
    this.checkStatus(
      this._api.symbols.SetIntraOpNumThreads(this._sessionOptsPtr, 1),
      "SetIntraOpNumThreads",
    );
    this.checkStatus(
      this._api.symbols.SetInterOpNumThreads(this._sessionOptsPtr, 1),
      "SetInterOpNumThreads",
    );

    this.checkStatus(
      this._api.symbols.CreateCpuMemoryInfo(
        ORT_ARENA_ALLOCATOR,
        ORT_MEM_TYPE_DEFAULT,
        ptr(outPtr),
      ),
      "CreateCpuMemoryInfo",
    );
    this._memInfoPtr = toPointer(outPtr[0]!);

    // Pin temporary init buffers through FFI calls
    void logIdBuf.byteLength;
    void outPtr.byteLength;
  }

  private checkStatus(status: Pointer | bigint | null, label: string): void {
    if (!status) return;
    const statusPtr = typeof status === "bigint" ? toPointer(status) : status;
    let message = "ONNX Runtime 执行失败";
    try {
      const msgPtr = this._api.symbols.GetErrorMessage(statusPtr);
      if (msgPtr) {
        message = new CString(msgPtr).toString();
      }
    } finally {
      this._api.symbols.ReleaseStatus(statusPtr);
    }
    throw new Error(`${label}: ${message}`);
  }

  createSessionFromFile(filePath: string): Pointer {
    const modelBytes = new Uint8Array(readFileSync(filePath));
    const outPtr = new BigUint64Array(1);
    try {
      this.checkStatus(
        this._api.symbols.CreateSessionFromArray(
          this._envPtr,
          ptr(modelBytes),
          modelBytes.byteLength,
          this._sessionOptsPtr,
          ptr(outPtr),
        ),
        `CreateSessionFromArray(${path.basename(filePath)})`,
      );
      return toPointer(outPtr[0]!);
    } finally {
      void modelBytes.byteLength;
      void outPtr.byteLength;
    }
  }

  releaseSession(sessionPtr: Pointer): void {
    if (sessionPtr) {
      this._api.symbols.ReleaseSession(sessionPtr);
    }
  }

  runFloat32(
    sessionPtr: Pointer,
    inputName: string,
    inputData: Float32Array,
    inputShape: readonly number[],
    outputName: string,
  ): { data: Float32Array; dims: number[] } {
    // 关键：在 ReleaseValue 完成之前，通过局部常量与 finally 牢牢固定全部 TypedArray，防止 JSC GC 移动底层内存
    const shapeBuf = BigInt64Array.from(inputShape.map((d) => BigInt(d)));
    const inNameBuf = makeCStringBuf(inputName);
    const outNameBuf = makeCStringBuf(outputName);
    const inNamePtrs = new BigUint64Array([BigInt(ptr(inNameBuf))]);
    const outNamePtrs = new BigUint64Array([BigInt(ptr(outNameBuf))]);
    const outPtr = new BigUint64Array(1);
    const inVals = new BigUint64Array(1);
    const outVals = new BigUint64Array([0n]);
    const dimCountBuf = new BigUint64Array(1);

    let inValPtr: Pointer | null = null;
    let outValPtr: Pointer | null = null;
    let typeShapePtr: Pointer | null = null;

    try {
      this.checkStatus(
        this._api.symbols.CreateTensorWithDataAsOrtValue(
          this._memInfoPtr,
          ptr(inputData),
          inputData.byteLength,
          ptr(shapeBuf),
          shapeBuf.length,
          ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT,
          ptr(outPtr),
        ),
        "CreateTensorWithDataAsOrtValue",
      );
      inValPtr = toPointer(outPtr[0]!);
      inVals[0] = outPtr[0]!;

      this.checkStatus(
        this._api.symbols.Run(
          sessionPtr,
          null,
          ptr(inNamePtrs),
          ptr(inVals),
          1,
          ptr(outNamePtrs),
          1,
          ptr(outVals),
        ),
        "Run",
      );
      outValPtr = toPointer(outVals[0]!);

      this.checkStatus(
        this._api.symbols.GetTensorTypeAndShape(outValPtr, ptr(outPtr)),
        "GetTensorTypeAndShape",
      );
      typeShapePtr = toPointer(outPtr[0]!);

      this.checkStatus(
        this._api.symbols.GetDimensionsCount(typeShapePtr, ptr(dimCountBuf)),
        "GetDimensionsCount",
      );
      const dimCount = Number(dimCountBuf[0]!);
      const dimsBuf = new BigInt64Array(dimCount);
      this.checkStatus(
        this._api.symbols.GetDimensions(typeShapePtr, ptr(dimsBuf), dimCount),
        "GetDimensions",
      );

      const dims = Array.from(dimsBuf, (v) => Number(v));
      const totalElements = dims.reduce((acc, d) => acc * Math.max(0, d), 1);

      this.checkStatus(
        this._api.symbols.GetTensorMutableData(outValPtr, ptr(outPtr)),
        "GetTensorMutableData",
      );
      const dataPtr = toPointer(outPtr[0]!);

      // 必须在 ReleaseValue 释放 ORT 内存之前深拷贝输出张量！
      const result = new Float32Array(totalElements);
      if (totalElements > 0 && dataPtr) {
        const view = new Float32Array(toArrayBuffer(dataPtr, 0, totalElements * 4));
        result.set(view);
      }

      void dimsBuf.byteLength;
      return { data: result, dims };
    } finally {
      if (typeShapePtr) {
        this._api.symbols.ReleaseTensorTypeAndShapeInfo(typeShapePtr);
      }
      if (outValPtr) {
        this._api.symbols.ReleaseValue(outValPtr);
      }
      if (inValPtr) {
        this._api.symbols.ReleaseValue(inValPtr);
      }
      // 显式保持所有 FFI 输入缓冲区存活至 ReleaseValue 之后
      void inputData.byteLength;
      void shapeBuf.byteLength;
      void inNameBuf.byteLength;
      void outNameBuf.byteLength;
      void inNamePtrs.byteLength;
      void outNamePtrs.byteLength;
      void outPtr.byteLength;
      void inVals.byteLength;
      void outVals.byteLength;
      void dimCountBuf.byteLength;
    }
  }
}

// 进程内按 DLL 路径共享单例 OrtEnv（符合 ONNX Runtime 官方推荐且与 sherpa-onnx-node 无冲突）
const runtimePool = new Map<string, OrtNativeRuntime>();

function getOrCreateOrtRuntime(libPath: string): OrtNativeRuntime {
  const key = process.platform === "win32" ? libPath.toLowerCase() : libPath;
  const cached = runtimePool.get(key);
  if (cached) return cached;
  const runtime = new OrtNativeRuntime(libPath);
  runtimePool.set(key, runtime);
  return runtime;
}

// ---------------------------------------------------------------------------
// Stage 3 声学打分算法：均值中心化余弦 + 带约束子序列 DTW + 硬负样本对比校准
// ---------------------------------------------------------------------------

/**
 * 减去通用语音背景均值（96 维）并做 L2 归一化。
 */
export function meanCenterNormalize(
  vec: ArrayLike<number>,
  bgMean: ArrayLike<number> | null,
): Float32Array {
  const dim = WAKEWORD_EMBEDDING_DIM;
  const out = new Float32Array(dim);
  const useMean = bgMean !== null && bgMean.length === dim;
  let normSq = 0;
  for (let d = 0; d < dim; d += 1) {
    const raw = vec[d] ?? 0;
    const centered = useMean ? raw - (bgMean[d] ?? 0) : raw;
    out[d] = centered;
    normSq += centered * centered;
  }
  if (normSq < 1e-12) {
    out.fill(0);
    return out;
  }
  const invNorm = 1 / Math.sqrt(normSq);
  for (let d = 0; d < dim; d += 1) {
    out[d] = out[d]! * invNorm;
  }
  return out;
}

function dot96(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < WAKEWORD_EMBEDDING_DIM; i += 1) {
    sum += a[i]! * b[i]!;
  }
  return sum;
}

function alignedCosineEndingAt(
  U: readonly Float32Array[],
  endIdx: number,
  P: readonly Float32Array[],
): number {
  const m = P.length;
  const avail = endIdx + 1;
  if (m === 0 || avail === 0) return 0;
  if (avail >= m) {
    let sum = 0;
    const base = endIdx - m + 1;
    for (let j = 0; j < m; j += 1) {
      sum += dot96(U[base + j]!, P[j]!);
    }
    return sum / m;
  }
  let sum = 0;
  for (let i = 0; i < avail; i += 1) {
    const pIdx = Math.min(m - 1, Math.floor((i * m) / avail));
    sum += dot96(U[i]!, P[pIdx]!);
  }
  return sum / avail;
}

function bandedSubsequenceDtwEndingAt(
  U: readonly Float32Array[],
  endIdx: number,
  P: readonly Float32Array[],
): number {
  const m = P.length;
  const avail = endIdx + 1;
  if (m === 0 || avail === 0) return 0;

  const minLen = Math.max(1, Math.round(m * 0.7));
  const maxLen = Math.min(avail, Math.max(minLen, Math.round(m * 1.45)));
  if (avail < Math.min(minLen, m)) return 0;

  // 从 endIdx 反向执行一次带语速带宽 [0.70x, 1.45x] 的子序列 DTW，同时覆盖所有合法起始偏移
  const INF = 1e9;
  const prevCost = new Float64Array(m).fill(INF);
  const prevSteps = new Int32Array(m).fill(1);
  const currCost = new Float64Array(m).fill(INF);
  const currSteps = new Int32Array(m).fill(1);

  prevCost[m - 1] = 1 - dot96(U[endIdx]!, P[m - 1]!);
  prevSteps[m - 1] = 1;

  let bestSim = m === 1 ? 1 - prevCost[0]! : 0;

  for (let step = 1; step < maxLen; step += 1) {
    currCost.fill(INF);
    const uVec = U[endIdx - step]!;
    for (let j = m - 1; j >= 0; j -= 1) {
      const cost = 1 - dot96(uVec, P[j]!);
      let bestPrevCost = prevCost[j]!;
      let bestPrevSteps = prevSteps[j]!;

      if (j + 1 < m && prevCost[j + 1]! < bestPrevCost) {
        bestPrevCost = prevCost[j + 1]!;
        bestPrevSteps = prevSteps[j + 1]!;
      }
      if (j + 1 < m && currCost[j + 1]! < bestPrevCost) {
        bestPrevCost = currCost[j + 1]!;
        bestPrevSteps = currSteps[j + 1]!;
      }

      if (bestPrevCost < INF) {
        currCost[j] = bestPrevCost + cost;
        currSteps[j] = bestPrevSteps + 1;
      }
    }

    if (step + 1 >= minLen && currCost[0]! < INF) {
      const sim = 1 - currCost[0]! / Math.max(1, currSteps[0]!);
      if (sim > bestSim) {
        bestSim = sim;
      }
    }

    prevCost.set(currCost);
    prevSteps.set(currSteps);
  }

  return bestSim;
}

/**
 * 计算以 U[endIdx] 为结束帧的原型匹配原始得分：
 * 0.65 * 对齐余弦 + 0.35 * 带约束子序列 DTW（0.70x~1.45x 语速拉伸）。
 */
export function scorePrototypeEndingAt(
  U: readonly Float32Array[],
  endIdx: number,
  P: readonly Float32Array[],
): number {
  if (U.length === 0 || P.length === 0 || endIdx < 0 || endIdx >= U.length) return 0;
  const minAvail = Math.max(2, Math.round(P.length * 0.7));
  if (endIdx + 1 < Math.min(minAvail, P.length)) return 0;
  const cosSim = alignedCosineEndingAt(U, endIdx, P);
  const dtwSim = bandedSubsequenceDtwEndingAt(U, endIdx, P);
  return 0.65 * cosSim + 0.35 * dtwSim;
}

/**
 * 滑动对齐余弦相似度（在整段 U 上搜索最佳子序列位置）。
 */
export function slidingAlignedCosine(
  U: readonly Float32Array[],
  P: readonly Float32Array[],
): number {
  if (U.length === 0 || P.length === 0) return 0;
  if (U.length < P.length) {
    return alignedCosineEndingAt(U, U.length - 1, P);
  }
  let best = -1;
  for (let endIdx = P.length - 1; endIdx < U.length; endIdx += 1) {
    const s = alignedCosineEndingAt(U, endIdx, P);
    if (s > best) best = s;
  }
  return best;
}

/**
 * 带约束子序列 DTW 相似度（在整段 U 上搜索允许 0.70x~1.45x 语速伸缩的最佳匹配）。
 */
export function bandedSubsequenceDtw(
  U: readonly Float32Array[],
  P: readonly Float32Array[],
): number {
  if (U.length === 0 || P.length === 0) return 0;
  const startEnd = Math.min(U.length - 1, Math.max(0, Math.round(P.length * 0.7) - 1));
  let best = -1;
  for (let endIdx = startEnd; endIdx < U.length; endIdx += 1) {
    const s = bandedSubsequenceDtwEndingAt(U, endIdx, P);
    if (s > best) best = s;
  }
  return best;
}

function calibrateWithHardNegatives(rawSim: number, maxHardNegSim: number): number {
  return Math.max(0, rawSim - 0.28 * Math.max(0, maxHardNegSim - 0.56));
}

function containsCjk(text: string): boolean {
  return /[\u4e00-\u9fff]/.test(text);
}

/**
 * 按唤醒词音节/长度计算连续帧确认耐心度（短词 <=4 ASCII 或 <=2 CJK 用 2 帧，更长用 3 帧）。
 */
export function computePatienceForWakeWord(wakeWord: string): number {
  const cjkMatches = wakeWord.match(/[\u4e00-\u9fff]/g);
  const asciiMatches = wakeWord.match(/[A-Za-z0-9]/g);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;
  const asciiCount = asciiMatches ? asciiMatches.length : 0;
  if (cjkCount > 0 && asciiCount === 0) {
    return cjkCount <= 2 ? 2 : 3;
  }
  if (cjkCount === 0) {
    return asciiCount <= 4 ? 2 : 3;
  }
  return cjkCount * 2 + asciiCount <= 4 ? 2 : 3;
}

function trimActiveEmbeddings(embeddings: number[][], hopRms: number[]): number[][] {
  if (embeddings.length <= 3) {
    return embeddings;
  }
  let maxRms = 1e-6;
  for (let i = 0; i < hopRms.length; i += 1) {
    if (hopRms[i]! > maxRms) maxRms = hopRms[i]!;
  }
  const energyThresh = Math.max(0.008, maxRms * 0.14);

  let lo = 0;
  while (lo < hopRms.length && hopRms[lo]! < energyThresh) {
    lo += 1;
  }
  let hi = hopRms.length - 1;
  while (hi > lo && hopRms[hi]! < energyThresh) {
    hi -= 1;
  }

  // 未找到有效高能帧时，取能量峰值附近的紧凑窗口
  if (lo >= hopRms.length) {
    let peakIdx = 0;
    for (let i = 1; i < hopRms.length; i += 1) {
      if (hopRms[i]! > hopRms[peakIdx]!) peakIdx = i;
    }
    const start = Math.max(0, peakIdx - 1);
    const end = Math.min(embeddings.length, start + 4);
    return embeddings.slice(start, end);
  }

  // 760ms 嵌入窗存在约 1~2 帧尾随感知，尾部额外保留 2 帧
  const start = Math.max(0, lo);
  let end = Math.min(embeddings.length, hi + 3);
  if (end - start < 3) {
    end = Math.min(embeddings.length, start + 3);
  }
  if (end - start > 10) {
    end = start + 10;
  }
  return embeddings.slice(start, end);
}

// ---------------------------------------------------------------------------
// 流式检测会话（OpenWakeWordStreamSession）
// ---------------------------------------------------------------------------

export class OpenWakeWordStreamSession {
  private readonly _engine: OpenWakeWordEngine;
  private _wakeWords: string[];
  private readonly _threshold: number;
  private readonly _debounceMs: number;
  private readonly _onSpot?: (hit: WakeWordAcousticHit) => void;

  private _context: CompiledScoringContext;
  private _pendingAudio = new Float32Array(0);
  private readonly _audioTail = new Float32Array(OVERLAP_SAMPLES);
  private readonly _melInputBuf = new Float32Array(MEL_WINDOW_SAMPLES);
  private readonly _melRing = new Float32Array(EMB_WINDOW_FLOATS);
  private _embHistory: Float32Array[] = [];

  private _frameIndex = 0;
  private _consecutiveSilentHops = 0;
  private _idleSkippedFrames = 0;
  private _lastSpotStreamMs = Number.NEGATIVE_INFINITY;
  private _streaks = new Map<string, number>();

  private _peakHit: WakeWordAcousticHit | null = null;
  private _segmentFrameHits: WakeWordAcousticHit[] = [];

  constructor(
    engine: OpenWakeWordEngine,
    wakeWords: readonly string[],
    options: OpenWakeWordStreamOptions = {},
  ) {
    this._engine = engine;
    this._wakeWords = [...wakeWords];
    this._threshold = options.threshold ?? engine.defaultThreshold;
    this._debounceMs = Math.max(0, options.debounceMs ?? DEFAULT_DEBOUNCE_MS);
    this._onSpot = options.onSpot;
    this._melRing.fill(SILENCE_MEL_VALUE);
    this._context = engine.compileScoringContext(this._wakeWords);
  }

  get frameIndex(): number {
    return this._frameIndex;
  }

  get idleSkippedFrames(): number {
    return this._idleSkippedFrames;
  }

  reloadPrototypes(wakeWords?: readonly string[]): void {
    if (wakeWords) {
      this._wakeWords = [...wakeWords];
    }
    this._context = this._engine.compileScoringContext(this._wakeWords);
    this._streaks.clear();
  }

  /**
   * 仅重置当前语音段的峰值追踪（用于 Silero VAD 分段切换，不破坏连续音频/梅尔上下文与防抖）。
   */
  resetSegmentTracking(): void {
    this._peakHit = null;
    this._segmentFrameHits = [];
  }

  /**
   * 完整重置流式会话的音频缓冲、梅尔环形缓冲、嵌入历史与状态机。
   */
  reset(): void {
    this._pendingAudio = new Float32Array(0);
    this._audioTail.fill(0);
    this._melRing.fill(SILENCE_MEL_VALUE);
    this._embHistory = [];
    this._frameIndex = 0;
    this._consecutiveSilentHops = 0;
    this._idleSkippedFrames = 0;
    this._lastSpotStreamMs = Number.NEGATIVE_INFINITY;
    this._streaks.clear();
    this.resetSegmentTracking();
  }

  /**
   * 返回当前语音段内的最高声学命中记录。
   */
  getPeakHit(): WakeWordAcousticHit | null {
    return this._peakHit;
  }

  /**
   * 返回当前语音段前 maxFrames 个活动帧内的最高声学命中记录（用于句首唤醒词验证）。
   */
  getHeadPeakHit(maxFrames = 20): WakeWordAcousticHit | null {
    const limit = Math.min(this._segmentFrameHits.length, Math.max(1, maxFrames));
    let best: WakeWordAcousticHit | null = null;
    for (let i = 0; i < limit; i += 1) {
      const hit = this._segmentFrameHits[i]!;
      if (!best || hit.score > best.score) {
        best = hit;
      }
    }
    return best;
  }

  /**
   * 推送 16kHz Mono Float32 PCM 样本并实时运行 80ms 步进声学检测。
   * 返回本次推送中触发的最高置信唤醒命中（未触发则返回 null）。
   */
  pushSamples(pcm16kF32: Float32Array, endSampleOffset: number): WakeWordAcousticHit | null {
    if (!this._engine.isReady || pcm16kF32.length === 0) {
      return null;
    }

    if (this._context.prototypes.length === 0) {
      // 允许在流运行过程中通过 enroll/bootstrap 后自动生效
      const storeUpdatedAt = loadWakeWordStore().updatedAt;
      if (storeUpdatedAt !== this._context.storeUpdatedAt) {
        this._context = this._engine.compileScoringContext(this._wakeWords);
      }
      if (this._context.prototypes.length === 0) {
        return null;
      }
    }

    // 拼接待处理缓冲
    let buf: Float32Array;
    if (this._pendingAudio.length === 0) {
      buf = pcm16kF32;
    } else {
      buf = new Float32Array(this._pendingAudio.length + pcm16kF32.length);
      buf.set(this._pendingAudio, 0);
      buf.set(pcm16kF32, this._pendingAudio.length);
    }

    let offset = 0;
    let spottedInPush: WakeWordAcousticHit | null = null;

    while (offset + HOP_SAMPLES <= buf.length) {
      const hop = buf.subarray(offset, offset + HOP_SAMPLES);
      offset += HOP_SAMPLES;
      const remainingSamples = buf.length - offset;
      const hopEndSample = Math.max(0, endSampleOffset - remainingSamples);

      const hit = this.processHop(hop, hopEndSample);
      if (hit && (!spottedInPush || hit.score > spottedInPush.score)) {
        spottedInPush = hit;
      }
    }

    const leftover = buf.length - offset;
    this._pendingAudio = leftover > 0 ? buf.slice(offset) : new Float32Array(0);
    return spottedInPush;
  }

  private processHop(hop: Float32Array, hopEndSample: number): WakeWordAcousticHit | null {
    const hopStartMs = performance.now();
    const currentFrame = this._frameIndex;
    this._frameIndex += 1;

    const rms = computeRms(hop);

    // 构造 1760 采样滑窗 [prev 480, new 1280] 并更新尾部 480 重叠
    for (let i = 0; i < OVERLAP_SAMPLES; i += 1) {
      this._melInputBuf[i] = Math.max(-32768, Math.min(32767, this._audioTail[i]! * 32768));
    }
    for (let i = 0; i < HOP_SAMPLES; i += 1) {
      this._melInputBuf[OVERLAP_SAMPLES + i] = Math.max(-32768, Math.min(32767, hop[i]! * 32768));
    }
    this._audioTail.set(hop.subarray(HOP_SAMPLES - OVERLAP_SAMPLES));

    // RMS 静音快路径：连续 >= 12 帧（960ms）低于静音门限时跳过 ONNX 推理，空闲 CPU < 0.2%
    if (rms < SILENCE_RMS_THRESHOLD) {
      this._consecutiveSilentHops += 1;
      if (this._consecutiveSilentHops >= SILENCE_SKIP_CONSECUTIVE_FRAMES) {
        this._melRing.copyWithin(0, MEL_HOP_FRAMES * MEL_BINS);
        this._melRing.fill(SILENCE_MEL_VALUE, EMB_WINDOW_FLOATS - MEL_HOP_FRAMES * MEL_BINS);
        if (this._consecutiveSilentHops === SILENCE_SKIP_CONSECUTIVE_FRAMES) {
          this._embHistory = [];
          this._streaks.clear();
        }
        this._idleSkippedFrames += 1;
        return null;
      }
    } else {
      this._consecutiveSilentHops = 0;
    }

    // Stage 1: melspectrogram.onnx -> [1, 1, 8, 32]
    const melChunk = this._engine.runMelHop(this._melInputBuf);
    this._melRing.copyWithin(0, MEL_HOP_FRAMES * MEL_BINS);
    this._melRing.set(melChunk, EMB_WINDOW_FLOATS - MEL_HOP_FRAMES * MEL_BINS);

    // Stage 2: embedding_model.onnx -> [1, 1, 1, 96]
    const rawEmbedding = this._engine.runEmbeddingSingle(this._melRing);
    const normEmbedding = meanCenterNormalize(rawEmbedding, this._context.bgMean);
    this._embHistory.push(normEmbedding);
    if (this._embHistory.length > EMB_HISTORY_CAPACITY) {
      this._embHistory.shift();
    }

    // Stage 3: 评估当前结束帧 against 所有激活原型 + 局部硬负样本
    const endIdx = this._embHistory.length - 1;
    let maxHardNegSim = 0;
    for (const hn of this._context.hardNegatives) {
      const sim = scorePrototypeEndingAt(this._embHistory, endIdx, hn.frames);
      if (sim > maxHardNegSim) maxHardNegSim = sim;
    }

    const bestPerWord = new Map<
      string,
      {
        wakeWord: string;
        score: number;
        rawScore: number;
        source: WakeWordPrototypeSource;
      }
    >();

    for (const proto of this._context.prototypes) {
      const rawScore = scorePrototypeEndingAt(this._embHistory, endIdx, proto.frames);
      const score = calibrateWithHardNegatives(rawScore, maxHardNegSim);
      const prev = bestPerWord.get(proto.wordKey);
      if (!prev || score > prev.score) {
        bestPerWord.set(proto.wordKey, {
          wakeWord: this._context.displayWordByKey.get(proto.wordKey) ?? proto.wakeWord,
          score,
          rawScore,
          source: proto.source,
        });
      }
    }

    const latencyMs = Number((performance.now() - hopStartMs).toFixed(2));
    let bestFrameCandidate: {
      wordKey: string;
      wakeWord: string;
      score: number;
      rawScore: number;
      source: WakeWordPrototypeSource;
    } | null = null;

    for (const [wordKey, cand] of bestPerWord) {
      if (!bestFrameCandidate || cand.score > bestFrameCandidate.score) {
        bestFrameCandidate = { wordKey, ...cand };
      }
    }

    if (bestFrameCandidate) {
      const frameHit: WakeWordAcousticHit = {
        matched: bestFrameCandidate.score >= this._threshold,
        wakeWord: bestFrameCandidate.wakeWord,
        score: Number(bestFrameCandidate.score.toFixed(4)),
        rawScore: Number(bestFrameCandidate.rawScore.toFixed(4)),
        threshold: this._threshold,
        source: bestFrameCandidate.source,
        frameIndex: currentFrame,
        sampleOffset: hopEndSample,
        latencyMs,
      };
      if (this._segmentFrameHits.length < MAX_SEGMENT_TRACK_FRAMES) {
        this._segmentFrameHits.push(frameHit);
      }
      if (!this._peakHit || frameHit.score > this._peakHit.score) {
        this._peakHit = frameHit;
      }
    }

    // 启动前 5 帧（400ms）热身抑制，防止开麦瞬间爆音误触发
    if (currentFrame < WARMUP_SUPPRESS_FRAMES) {
      return null;
    }

    // 连续帧耐心度更新 + 防抖触发判定
    let triggeredCandidate: {
      wordKey: string;
      wakeWord: string;
      score: number;
      rawScore: number;
      source: WakeWordPrototypeSource;
    } | null = null;

    for (const [wordKey, cand] of bestPerWord) {
      if (cand.score >= this._threshold) {
        const nextStreak = (this._streaks.get(wordKey) ?? 0) + 1;
        this._streaks.set(wordKey, nextStreak);
        const requiredPatience = this._context.patienceByKey.get(wordKey) ?? 2;
        if (nextStreak >= requiredPatience) {
          if (!triggeredCandidate || cand.score > triggeredCandidate.score) {
            triggeredCandidate = { wordKey, ...cand };
          }
        }
      } else {
        this._streaks.set(wordKey, 0);
      }
    }

    if (!triggeredCandidate) {
      return null;
    }

    const streamTimeMs = currentFrame * HOP_MS;
    if (streamTimeMs - this._lastSpotStreamMs < this._debounceMs) {
      return null;
    }

    this._lastSpotStreamMs = streamTimeMs;
    this._streaks.clear();

    const spottedHit: WakeWordAcousticHit = {
      matched: true,
      wakeWord: triggeredCandidate.wakeWord,
      score: Number(triggeredCandidate.score.toFixed(4)),
      rawScore: Number(triggeredCandidate.rawScore.toFixed(4)),
      threshold: this._threshold,
      source: triggeredCandidate.source,
      frameIndex: currentFrame,
      sampleOffset: hopEndSample,
      latencyMs,
    };

    if (!this._peakHit || spottedHit.score >= this._peakHit.score) {
      this._peakHit = spottedHit;
    }

    if (this._onSpot) {
      try {
        this._onSpot(spottedHit);
      } catch {
        // 回调异常不得中断实时音频流
      }
    }

    return spottedHit;
  }
}

// ---------------------------------------------------------------------------
// Windows SAPI 批量多音色零样本语音合成（单进程异步调用）
// ---------------------------------------------------------------------------

interface SapiSynthJob {
  key: string;
  text: string;
  lang: "zh" | "en";
  voiceIndex: number;
  rate: number;
}

const SAPI_BATCH_PS_SCRIPT = `
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$installed = @($synth.GetInstalledVoices() | Where-Object { $_.Enabled })
$enVoices = @()
$zhVoices = @()

foreach ($pref in @("Microsoft David Desktop", "Microsoft Zira Desktop")) {
  $hit = $installed | Where-Object { $_.VoiceInfo.Name -eq $pref } | Select-Object -First 1
  if ($hit) { $enVoices += $hit.VoiceInfo.Name }
}
foreach ($v in $installed) {
  if ($v.VoiceInfo.Culture.Name -like "en-*" -and -not ($enVoices -contains $v.VoiceInfo.Name)) {
    $enVoices += $v.VoiceInfo.Name
  }
}

foreach ($pref in @("Microsoft Huihui Desktop", "Microsoft Yaoyao Desktop", "Microsoft Kangkang Desktop")) {
  $hit = $installed | Where-Object { $_.VoiceInfo.Name -eq $pref } | Select-Object -First 1
  if ($hit) { $zhVoices += $hit.VoiceInfo.Name }
}
foreach ($v in $installed) {
  if ($v.VoiceInfo.Culture.Name -like "zh-*" -and -not ($zhVoices -contains $v.VoiceInfo.Name)) {
    $zhVoices += $v.VoiceInfo.Name
  }
}

$fallback = if ($installed.Count -gt 0) { $installed[0].VoiceInfo.Name } else { "" }
$jobsJson = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($env:MIJIADECK_OWW_TTS_JOBS))
$parsedJobs = $jobsJson | ConvertFrom-Json
if ($parsedJobs -is [System.Array]) { $jobs = $parsedJobs } else { $jobs = @($parsedJobs) }
$fmt16k = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$results = @{}

foreach ($job in $jobs) {
  try {
    $pool = @(if ($job.lang -eq "zh") { $zhVoices } else { $enVoices })
    if ($pool.Count -eq 0) {
      if ($fallback -eq "") { continue }
      $voiceName = $fallback
    } elseif ([int]$job.voiceIndex -lt $pool.Count) {
      $voiceName = $pool[[int]$job.voiceIndex]
    } else {
      continue
    }
    $synth.SelectVoice($voiceName)
    $synth.Rate = [int]$job.rate
    $ms = New-Object System.IO.MemoryStream
    $synth.SetOutputToAudioStream($ms, $fmt16k)
    $synth.Speak([string]$job.text)
    $synth.SetOutputToNull()
    $pcmBytes = $ms.ToArray()
    $ms.Dispose()
    if ($pcmBytes.Length -ge 3200) {
      $results[$job.key] = @{
        voice = $voiceName
        pcm16 = [System.Convert]::ToBase64String($pcmBytes)
      }
    }
  } catch {
    # skip single failed item
  }
}

$synth.Dispose()
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$results | ConvertTo-Json -Compress -Depth 4
`;

async function synthesizeSapiBatch(
  jobs: readonly SapiSynthJob[],
  timeoutMs = 15000,
): Promise<Map<string, { voice: string; pcm16k: Float32Array }>> {
  const output = new Map<string, { voice: string; pcm16k: Float32Array }>();
  if (process.platform !== "win32" || jobs.length === 0) {
    return output;
  }

  let proc: ReturnType<typeof Bun.spawn> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  try {
    const jobsB64 = Buffer.from(JSON.stringify(jobs), "utf8").toString("base64");
    proc = Bun.spawn(
      [
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        SAPI_BATCH_PS_SCRIPT,
      ],
      {
        env: {
          ...process.env,
          MIJIADECK_OWW_TTS_JOBS: jobsB64,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    const stdoutPromise =
      proc.stdout && typeof proc.stdout !== "number"
        ? new Response(proc.stdout).text()
        : Promise.resolve("");
    const stderrPromise =
      proc.stderr && typeof proc.stderr !== "number"
        ? new Response(proc.stderr).text()
        : Promise.resolve("");

    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });

    const exitPromise = Promise.all([proc.exited, stdoutPromise, stderrPromise]);
    const raceResult = await Promise.race([exitPromise, timedOut]);
    if (raceResult === "timeout") {
      try {
        proc.kill();
      } catch {
        // ignore
      }
      return output;
    }

    const [exitCode, stdoutText] = raceResult;
    if (exitCode !== 0) {
      return output;
    }

    const trimmed = stdoutText.trim();
    if (!trimmed) return output;

    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return output;
    }

    for (const [key, val] of Object.entries(parsed as Record<string, unknown>)) {
      if (!val || typeof val !== "object" || Array.isArray(val)) continue;
      const entry = val as { voice?: unknown; wav?: unknown; pcm16?: unknown };
      try {
        let pcm16k: Float32Array | null = null;
        if (typeof entry.pcm16 === "string" && entry.pcm16) {
          const rawPcm = Buffer.from(entry.pcm16, "base64");
          const count = Math.floor(rawPcm.byteLength / 2);
          const samples = new Float32Array(count);
          const view = new DataView(rawPcm.buffer, rawPcm.byteOffset, rawPcm.byteLength);
          for (let i = 0; i < count; i += 1) {
            samples[i] = view.getInt16(i * 2, true) / 32768;
          }
          pcm16k = samples;
        } else if (typeof entry.wav === "string" && entry.wav) {
          const wavBytes = Buffer.from(entry.wav, "base64");
          const decoded = decodeWavPcm(wavBytes);
          pcm16k =
            decoded.sampleRate === SAMPLE_RATE
              ? decoded.samples
              : resampleLinear(decoded.samples, decoded.sampleRate, SAMPLE_RATE);
        }
        if (pcm16k && pcm16k.length >= 1600) {
          output.set(key, {
            voice: typeof entry.voice === "string" ? entry.voice : "sapi",
            pcm16k,
          });
        }
      } catch {
        // 忽略单条损坏音频
      }
    }
  } catch {
    // 非 Windows 或 SAPI 不可用时静默降级为空
  } finally {
    if (timer) clearTimeout(timer);
  }

  return output;
}

function compactVoiceSlug(voiceName: string): string {
  const lower = voiceName.toLowerCase();
  if (lower.includes("david")) return "david";
  if (lower.includes("zira")) return "zira";
  if (lower.includes("huihui")) return "huihui";
  return (
    lower
      .replace(/microsoft|desktop/g, "")
      .replace(/[^a-z0-9]+/g, "")
      .slice(0, 12) || "sapi"
  );
}

// ---------------------------------------------------------------------------
// OpenWakeWordEngine 核心引擎类
// ---------------------------------------------------------------------------

export class OpenWakeWordEngine {
  readonly paths: OpenWakeWordModelPaths;
  readonly defaultThreshold: number;
  private readonly _runtimeLibPathOverride?: string;

  private _runtime: OrtNativeRuntime | null = null;
  private _melSession: Pointer | null = null;
  private _embSession: Pointer | null = null;
  private _lastError: string | null = null;
  private _bootstrapping = false;
  private _bootstrapQueue: Promise<unknown> = Promise.resolve();
  private _disposed = false;
  private _compiledCtxCache: {
    cacheKey: string;
    storeUpdatedAt: number;
    protoCount: number;
    hardNegCount: number;
    context: CompiledScoringContext;
  } | null = null;

  constructor(options: OpenWakeWordEngineOptions = {}) {
    this.paths = resolveOpenWakeWordModelPaths(options.modelsDir);
    this._runtimeLibPathOverride = options.runtimeLibPath;
    this.defaultThreshold = options.defaultThreshold ?? DEFAULT_WAKEWORD_THRESHOLD;
    this.ensureLoaded();
  }

  get isReady(): boolean {
    return !this._disposed && this._runtime !== null && this._melSession !== null && this._embSession !== null;
  }

  get lastError(): string | null {
    return this._lastError;
  }

  getStatus(): OpenWakeWordEngineStatus {
    const modelsPresent = existsSync(this.paths.melPath) && existsSync(this.paths.embeddingPath);
    return {
      ready: this.isReady,
      modelsPresent,
      runtimeLoaded: this._runtime !== null,
      melPath: this.paths.melPath,
      embeddingPath: this.paths.embeddingPath,
      lastError: this._lastError,
      bootstrapping: this._bootstrapping,
    };
  }

  /**
   * 加载原生 ONNX Runtime 与 openWakeWord 两个 ONNX 模型（失败时优雅降级不抛异常）。
   */
  ensureLoaded(): boolean {
    if (this._disposed) return false;
    if (this.isReady) return true;

    const modelsPresent = existsSync(this.paths.melPath) && existsSync(this.paths.embeddingPath);
    if (!modelsPresent) {
      this._lastError = "未找到 openWakeWord 模型文件（melspectrogram.onnx / embedding_model.onnx）";
      return false;
    }

    try {
      if (!this._runtime) {
        const libPath = resolveOnnxRuntimeLibPath(this._runtimeLibPathOverride);
        if (!libPath) {
          this._lastError = "未找到 ONNX Runtime 原生动态库（onnxruntime）";
          return false;
        }
        this._runtime = getOrCreateOrtRuntime(libPath);
      }

      if (!this._melSession) {
        this._melSession = this._runtime.createSessionFromFile(this.paths.melPath);
      }
      if (!this._embSession) {
        this._embSession = this._runtime.createSessionFromFile(this.paths.embeddingPath);
      }
      this._lastError = null;
      return true;
    } catch (err) {
      this.releaseSessions();
      this._lastError = sanitizeErrorMessage(err);
      return false;
    }
  }

  private releaseSessions(): void {
    if (this._runtime) {
      if (this._melSession) {
        try {
          this._runtime.releaseSession(this._melSession);
        } catch {
          // ignore
        }
      }
      if (this._embSession) {
        try {
          this._runtime.releaseSession(this._embSession);
        } catch {
          // ignore
        }
      }
    }
    this._melSession = null;
    this._embSession = null;
  }

  dispose(): void {
    this._disposed = true;
    this._compiledCtxCache = null;
    this.releaseSessions();
  }

  /**
   * Stage 1 单步（1760 int16 标度样本 -> 8x32 后处理梅尔帧）。内部供流式会话与批提取共用。
   */
  runMelHop(int16ScaledWindow1760: Float32Array): Float32Array {
    if (!this.isReady || !this._runtime || !this._melSession) {
      throw new Error("openWakeWord 引擎未就绪");
    }
    const { data } = this._runtime.runFloat32(
      this._melSession,
      "input",
      int16ScaledWindow1760,
      [1, int16ScaledWindow1760.length],
      "output",
    );
    const out = new Float32Array(MEL_HOP_FRAMES * MEL_BINS);
    const count = Math.min(out.length, data.length);
    for (let i = 0; i < count; i += 1) {
      // 上游 openWakeWord 精确后处理变换：spec / 10.0 + 2.0
      out[i] = data[i]! / 10.0 + 2.0;
    }
    return out;
  }

  /**
   * Stage 2 单帧（[1, 76, 32, 1] -> 96 维原始语音嵌入）。
   */
  runEmbeddingSingle(melWindow76x32: Float32Array): Float32Array {
    if (!this.isReady || !this._runtime || !this._embSession) {
      throw new Error("openWakeWord 引擎未就绪");
    }
    const { data } = this._runtime.runFloat32(
      this._embSession,
      "input_1",
      melWindow76x32,
      [1, EMB_WINDOW_FRAMES, MEL_BINS, 1],
      "conv2d_19",
    );
    return data.length === WAKEWORD_EMBEDDING_DIM
      ? data
      : data.slice(0, WAKEWORD_EMBEDDING_DIM);
  }

  /**
   * Stage 2 批量推理（[B, 76, 32, 1] -> B x 96 维原始语音嵌入）。
   */
  runEmbeddingBatch(melBatch: Float32Array, batchSize: number): number[][] {
    if (!this.isReady || !this._runtime || !this._embSession) {
      throw new Error("openWakeWord 引擎未就绪");
    }
    if (batchSize <= 0) return [];
    const { data } = this._runtime.runFloat32(
      this._embSession,
      "input_1",
      melBatch,
      [batchSize, EMB_WINDOW_FRAMES, MEL_BINS, 1],
      "conv2d_19",
    );
    const embeddings: number[][] = new Array(batchSize);
    for (let b = 0; b < batchSize; b += 1) {
      const base = b * WAKEWORD_EMBEDDING_DIM;
      const vec = new Array<number>(WAKEWORD_EMBEDDING_DIM);
      for (let d = 0; d < WAKEWORD_EMBEDDING_DIM; d += 1) {
        vec[d] = data[base + d] ?? 0;
      }
      embeddings[b] = vec;
    }
    return embeddings;
  }

  /**
   * 提取音频片段的 Stage 1 后处理梅尔频谱（与流式步进严格一致，用于诊断与测试校验）。
   */
  extractMelSpectrogram(pcm16kF32: Float32Array): {
    frames: Float32Array;
    frameCount: number;
    melBins: number;
  } {
    if (!this.isReady) {
      throw new Error("openWakeWord 本地声学引擎未就绪，请先检查模型文件");
    }
    if (pcm16kF32.length === 0) {
      return { frames: new Float32Array(0), frameCount: 0, melBins: MEL_BINS };
    }
    const hops = Math.max(1, Math.ceil(pcm16kF32.length / HOP_SAMPLES));
    const padded = new Float32Array(OVERLAP_SAMPLES + hops * HOP_SAMPLES);
    padded.set(pcm16kF32, OVERLAP_SAMPLES);

    const frameCount = hops * MEL_HOP_FRAMES;
    const frames = new Float32Array(frameCount * MEL_BINS);
    const win = new Float32Array(MEL_WINDOW_SAMPLES);

    for (let h = 0; h < hops; h += 1) {
      const base = h * HOP_SAMPLES;
      for (let i = 0; i < MEL_WINDOW_SAMPLES; i += 1) {
        win[i] = Math.max(-32768, Math.min(32767, padded[base + i]! * 32768));
      }
      const mel8 = this.runMelHop(win);
      frames.set(mel8, h * MEL_HOP_FRAMES * MEL_BINS);
    }

    return { frames, frameCount, melBins: MEL_BINS };
  }

  /**
   * 提取与流式推理逐帧对齐的 96 维原始语音嵌入序列及对应 80ms 步进 RMS 能量。
   */
  extractEmbeddings(
    pcm16kF32: Float32Array,
    options?: { phaseOffsetSamples?: number; trailingPadSamples?: number },
  ): { embeddings: number[][]; hopRms: number[] } {
    if (!this.isReady) {
      throw new Error("openWakeWord 本地声学引擎未就绪，请先检查模型文件");
    }
    if (pcm16kF32.length === 0) {
      return { embeddings: [], hopRms: [] };
    }

    const phaseOffset = Math.max(0, Math.round(options?.phaseOffsetSamples ?? 0));
    const trailingPad = Math.max(0, Math.round(options?.trailingPadSamples ?? 3840));
    const totalPayload = phaseOffset + pcm16kF32.length + trailingPad;
    const hops = Math.max(1, Math.ceil(totalPayload / HOP_SAMPLES));

    const padded = new Float32Array(OVERLAP_SAMPLES + hops * HOP_SAMPLES);
    padded.set(pcm16kF32, OVERLAP_SAMPLES + phaseOffset);

    // 与流式会话一致：前置 68 帧静音梅尔（-8.0），确保首帧即可输出完整 76 帧窗口嵌入
    const prefixMelFrames = EMB_WINDOW_FRAMES - MEL_HOP_FRAMES; // 68
    const totalMelFrames = prefixMelFrames + hops * MEL_HOP_FRAMES;
    const melMatrix = new Float32Array(totalMelFrames * MEL_BINS);
    melMatrix.fill(SILENCE_MEL_VALUE, 0, prefixMelFrames * MEL_BINS);

    const hopRms = new Array<number>(hops);
    const win = new Float32Array(MEL_WINDOW_SAMPLES);

    for (let h = 0; h < hops; h += 1) {
      const base = h * HOP_SAMPLES;
      let sumSq = 0;
      for (let i = 0; i < MEL_WINDOW_SAMPLES; i += 1) {
        const s = padded[base + i]!;
        win[i] = Math.max(-32768, Math.min(32767, s * 32768));
        if (i >= OVERLAP_SAMPLES) {
          sumSq += s * s;
        }
      }
      hopRms[h] = Math.sqrt(sumSq / HOP_SAMPLES);
      const mel8 = this.runMelHop(win);
      melMatrix.set(mel8, (prefixMelFrames + h * MEL_HOP_FRAMES) * MEL_BINS);
    }

    const melBatch = new Float32Array(hops * EMB_WINDOW_FLOATS);
    for (let h = 0; h < hops; h += 1) {
      const srcOffset = h * MEL_HOP_FRAMES * MEL_BINS;
      melBatch.set(
        melMatrix.subarray(srcOffset, srcOffset + EMB_WINDOW_FLOATS),
        h * EMB_WINDOW_FLOATS,
      );
    }

    const embeddings = this.runEmbeddingBatch(melBatch, hops);
    return { embeddings, hopRms };
  }

  /**
   * 提取经 RMS 活动帧裁剪的紧凑唤醒词原型嵌入（通常 3~10 帧，即 240~800ms）。
   */
  extractActiveEmbeddings(
    pcm16kF32: Float32Array,
    options?: { phaseOffsetSamples?: number },
  ): number[][] {
    const { embeddings, hopRms } = this.extractEmbeddings(pcm16kF32, options);
    return trimActiveEmbeddings(embeddings, hopRms);
  }

  /**
   * 编译当前唤醒词集合与硬负样本的均值中心化打分上下文（带路径+updatedAt 缓存，零重复归一化开销）。
   */
  compileScoringContext(wakeWords: readonly string[]): CompiledScoringContext {
    const store = loadWakeWordStore();
    const storePath = dataFile("wakeword_prototypes.json");
    const normKeys = wakeWords
      .map((w) => normalizeWakeWordKey(w))
      .filter(Boolean)
      .sort()
      .join("|");
    const cacheKey = `${storePath}::${normKeys}`;
    if (
      this._compiledCtxCache &&
      this._compiledCtxCache.cacheKey === cacheKey &&
      this._compiledCtxCache.storeUpdatedAt === store.updatedAt &&
      this._compiledCtxCache.protoCount === store.prototypes.length &&
      this._compiledCtxCache.hardNegCount === store.hardNegatives.length
    ) {
      return this._compiledCtxCache.context;
    }

    const bgMean =
      store.bgMean.length === WAKEWORD_EMBEDDING_DIM ? Float32Array.from(store.bgMean) : null;

    const activeKeys = new Set<string>();
    const displayWordByKey = new Map<string, string>();
    const patienceByKey = new Map<string, number>();

    for (const rawWord of wakeWords) {
      const trimmed = rawWord.trim();
      const key = normalizeWakeWordKey(trimmed);
      if (!key || activeKeys.has(key)) continue;
      activeKeys.add(key);
      displayWordByKey.set(key, trimmed);
      patienceByKey.set(key, computePatienceForWakeWord(trimmed));
    }

    const protoRecords = getPrototypesForWords(wakeWords);
    const prototypes: CompiledPrototype[] = [];
    for (const rec of protoRecords) {
      const wordKey = normalizeWakeWordKey(rec.wakeWord);
      if (!activeKeys.has(wordKey) || rec.embeddings.length === 0) continue;
      prototypes.push({
        id: rec.id,
        wakeWord: displayWordByKey.get(wordKey) ?? rec.wakeWord,
        wordKey,
        source: rec.source,
        frames: rec.embeddings.map((e) => meanCenterNormalize(e, bgMean)),
      });
    }

    // 关键：排除与任一已配置唤醒词同名的硬负样本，避免误伤自定义唤醒词（如用户将“小爱”设为唤醒词）
    const hardNegatives: CompiledHardNegative[] = [];
    for (const hn of store.hardNegatives) {
      const labelKey = normalizeWakeWordKey(hn.label);
      if (!labelKey || activeKeys.has(labelKey) || hn.embeddings.length === 0) continue;
      hardNegatives.push({
        label: hn.label,
        labelKey,
        frames: hn.embeddings.map((e) => meanCenterNormalize(e, bgMean)),
      });
    }

    const context: CompiledScoringContext = {
      storeUpdatedAt: store.updatedAt,
      bgMean,
      prototypes,
      hardNegatives,
      displayWordByKey,
      patienceByKey,
    };
    this._compiledCtxCache = {
      cacheKey,
      storeUpdatedAt: store.updatedAt,
      protoCount: store.prototypes.length,
      hardNegCount: store.hardNegatives.length,
      context,
    };
    return context;
  }

  /**
   * 创建连续流式声学唤醒检测会话。
   */
  createStreamSession(
    wakeWords: readonly string[],
    options?: OpenWakeWordStreamOptions,
  ): OpenWakeWordStreamSession {
    return new OpenWakeWordStreamSession(this, wakeWords, options);
  }

  /**
   * 对离线音频片段执行声学唤醒词打分（可选仅检查句首 headOnlySec 秒）。
   * 引擎未就绪或无可用原型时返回 null。
   */
  scoreClip(
    pcm16kF32: Float32Array,
    wakeWords: readonly string[],
    options?: OpenWakeWordScoreClipOptions,
  ): WakeWordAcousticHit | null {
    if (!this.isReady || pcm16kF32.length === 0) {
      return null;
    }

    const context = this.compileScoringContext(wakeWords);
    if (context.prototypes.length === 0) {
      return null;
    }

    const t0 = performance.now();
    const threshold = options?.threshold ?? this.defaultThreshold;
    const headSamples =
      options?.headOnlySec && options.headOnlySec > 0
        ? Math.min(pcm16kF32.length, Math.max(HOP_SAMPLES, Math.round(options.headOnlySec * SAMPLE_RATE)))
        : pcm16kF32.length;
    const segment = headSamples < pcm16kF32.length ? pcm16kF32.subarray(0, headSamples) : pcm16kF32;

    const { embeddings } = this.extractEmbeddings(segment);
    if (embeddings.length === 0) {
      return null;
    }

    const normedU = embeddings.map((e) => meanCenterNormalize(e, context.bgMean));
    let best: {
      wakeWord: string;
      score: number;
      rawScore: number;
      source: WakeWordPrototypeSource;
      frameIndex: number;
    } | null = null;

    for (let t = 0; t < normedU.length; t += 1) {
      let maxHardNegSim = 0;
      for (const hn of context.hardNegatives) {
        const sim = scorePrototypeEndingAt(normedU, t, hn.frames);
        if (sim > maxHardNegSim) maxHardNegSim = sim;
      }

      for (const proto of context.prototypes) {
        const rawScore = scorePrototypeEndingAt(normedU, t, proto.frames);
        const score = calibrateWithHardNegatives(rawScore, maxHardNegSim);
        if (!best || score > best.score) {
          best = {
            wakeWord: proto.wakeWord,
            score,
            rawScore,
            source: proto.source,
            frameIndex: t,
          };
        }
      }
    }

    if (!best) {
      return null;
    }

    const latencyMs = Number((performance.now() - t0).toFixed(2));
    return {
      matched: best.score >= threshold,
      wakeWord: best.wakeWord,
      score: Number(best.score.toFixed(4)),
      rawScore: Number(best.rawScore.toFixed(4)),
      threshold,
      source: best.source,
      frameIndex: best.frameIndex,
      sampleOffset: Math.min(segment.length, (best.frameIndex + 1) * HOP_SAMPLES),
      latencyMs,
    };
  }

  /**
   * 录制并注册自定义唤醒词真声样本：
   * 对输入音频做 85Hz 高通滤波，并在 0 与 640 采样（40ms）双相位偏移下提取活动帧原型持久化至本地库。
   */
  enrollSample(
    wakeWord: string,
    pcm16kF32: Float32Array,
    options?: { voiceTag?: string },
  ): OpenWakeWordEnrollResult {
    const cleanWord = wakeWord.trim();
    if (!cleanWord) {
      throw new Error("唤醒词不能为空");
    }
    if (!this.isReady) {
      throw new Error("openWakeWord 本地声学引擎未就绪，请先检查模型文件");
    }
    if (pcm16kF32.length < Math.round(SAMPLE_RATE * 0.15)) {
      throw new Error("录音时长过短，请清晰朗读唤醒词（建议 0.5~2 秒）");
    }

    const t0 = performance.now();
    const filtered = applyHighPassFilter(pcm16kF32, SAMPLE_RATE, 85);
    const rms = computeRms(filtered);
    if (rms < 0.003) {
      throw new Error("未检测到有效语音信号，请靠近麦克风清晰朗读唤醒词后重试");
    }

    const voiceTag = options?.voiceTag?.trim() || "user";
    const embPhase0 = this.extractActiveEmbeddings(filtered, { phaseOffsetSamples: 0 });
    const embPhase40 = this.extractActiveEmbeddings(filtered, {
      phaseOffsetSamples: PHASE_SHIFT_SAMPLES,
    });

    if (embPhase0.length === 0) {
      throw new Error("提取到的唤醒词声学特征为空，请靠近麦克风清晰朗读后重试");
    }

    // 先写入 +40ms 相位偏移原型，再写入主相位 0 原型，保证返回的 record 为主原型且受限额保护
    if (embPhase40.length > 0) {
      addWakeWordPrototype({
        wakeWord: cleanWord,
        source: "enrolled",
        voiceTag: `${voiceTag}@+40ms`,
        embeddings: embPhase40,
      });
    }

    const record = addWakeWordPrototype({
      wakeWord: cleanWord,
      source: "enrolled",
      voiceTag,
      embeddings: embPhase0,
    });

    const summary = listWakeWordPrototypeSummaries([cleanWord])[0]!;
    const durationMs = Number((performance.now() - t0).toFixed(2));
    return { record, summary, durationMs };
  }

  /**
   * 幂等异步零样本预热：利用 Windows SAPI 多音色（David / Zira / Huihui，多语速 [-2,0,+2]，
   * 中文额外叠加 0.88x / 1.12x 音高变速）生成 TTS 原型、默认硬负样本与通用语音背景均值 bgMean。
   * 绝不覆盖用户录制的 enrolled 样本；非 Windows 或 SAPI 不可用时优雅跳过不报错。
   */
  async bootstrapWakeWords(
    wakeWords: readonly string[],
    options?: { force?: boolean },
  ): Promise<OpenWakeWordBootstrapResult> {
    const run = async (): Promise<OpenWakeWordBootstrapResult> => {
      const t0 = performance.now();
      const uniqueWords: Array<{ display: string; key: string }> = [];
      const seenKeys = new Set<string>();
      for (const raw of wakeWords) {
        const display = raw.trim();
        const key = normalizeWakeWordKey(display);
        if (!key || seenKeys.has(key)) continue;
        seenKeys.add(key);
        uniqueWords.push({ display, key });
      }

      if (!this.ensureLoaded() || process.platform !== "win32" || uniqueWords.length === 0) {
        return {
          bootstrapped: [],
          skipped: uniqueWords.map((w) => w.display),
          durationMs: Number((performance.now() - t0).toFixed(2)),
        };
      }

      const force = Boolean(options?.force);
      const store = loadWakeWordStore();
      const existingTtsKeys = new Set<string>();
      for (const p of store.prototypes) {
        if (p.source === "tts-bootstrap") {
          existingTtsKeys.add(normalizeWakeWordKey(p.wakeWord));
        }
      }

      const toBootstrap: Array<{ display: string; key: string }> = [];
      const skipped: string[] = [];
      for (const w of uniqueWords) {
        if (!force && existingTtsKeys.has(w.key)) {
          skipped.push(w.display);
        } else {
          toBootstrap.push(w);
        }
      }

      const needHardNegs =
        force ||
        store.hardNegatives.length < DEFAULT_HARD_NEGATIVES.length ||
        store.bgMean.length !== WAKEWORD_EMBEDDING_DIM;

      if (toBootstrap.length === 0 && !needHardNegs) {
        return {
          bootstrapped: [],
          skipped,
          durationMs: Number((performance.now() - t0).toFixed(2)),
        };
      }

      this._bootstrapping = true;
      try {
        const jobs: SapiSynthJob[] = [];
        const rates = [-2, 0, 2] as const;

        for (let wi = 0; wi < toBootstrap.length; wi += 1) {
          const word = toBootstrap[wi]!;
          const isZh = containsCjk(word.display);
          const voiceIndices = isZh ? [0] : [0, 1];
          for (const voiceIndex of voiceIndices) {
            for (const rate of rates) {
              jobs.push({
                key: `w_${wi}_v${voiceIndex}_r${rate}`,
                text: word.display,
                lang: isZh ? "zh" : "en",
                voiceIndex,
                rate,
              });
            }
          }
        }

        if (needHardNegs) {
          for (let ni = 0; ni < DEFAULT_HARD_NEGATIVES.length; ni += 1) {
            const label = DEFAULT_HARD_NEGATIVES[ni]!;
            const isZh = containsCjk(label);
            jobs.push({
              key: `n_${ni}`,
              text: label,
              lang: isZh ? "zh" : "en",
              voiceIndex: 0,
              rate: 0,
            });
          }
        }

        const synthMap = await synthesizeSapiBatch(jobs);
        if (synthMap.size === 0) {
          return {
            bootstrapped: [],
            skipped: uniqueWords.map((w) => w.display),
            durationMs: Number((performance.now() - t0).toFixed(2)),
          };
        }

        const bootstrapped: string[] = [];
        for (let wi = 0; wi < toBootstrap.length; wi += 1) {
          const word = toBootstrap[wi]!;
          const isZh = containsCjk(word.display);
          const voiceIndices = isZh ? [0] : [0, 1];
          const records: ReplaceTtsPrototypeInput[] = [];
          const validVoices = new Set<string>();

          for (const voiceIndex of voiceIndices) {
            for (const rate of rates) {
              const entry = synthMap.get(`w_${wi}_v${voiceIndex}_r${rate}`);
              if (!entry) continue;
              validVoices.add(entry.voice);
              const slug = compactVoiceSlug(entry.voice);
              const filtered = applyHighPassFilter(entry.pcm16k, SAMPLE_RATE, 85);
              const embs = this.extractActiveEmbeddings(filtered, { phaseOffsetSamples: 0 });
              if (embs.length > 0) {
                records.push({
                  voiceTag: `sapi:${slug}:r${rate}`,
                  embeddings: embs,
                });
              }

              // 正常语速额外补充 +40ms 半帧相位偏移，提升跨帧对齐鲁棒性
              if (rate === 0) {
                const embs40 = this.extractActiveEmbeddings(filtered, {
                  phaseOffsetSamples: PHASE_SHIFT_SAMPLES,
                });
                if (embs40.length > 0) {
                  records.push({
                    voiceTag: `sapi:${slug}:r0:p40`,
                    embeddings: embs40,
                  });
                }
              }
            }
          }

          // 中文（或仅单一英语音色可用时）对正常语速额外生成 0.88x / 1.12x 音高变速原型以覆盖男女声差异
          if (isZh || validVoices.size <= 1) {
            const baseEntry = synthMap.get(`w_${wi}_v0_r0`);
            if (baseEntry) {
              const slug = compactVoiceSlug(baseEntry.voice);
              const filtered = applyHighPassFilter(baseEntry.pcm16k, SAMPLE_RATE, 85);
              for (const pitchFactor of [0.88, 1.12] as const) {
                const warped = resampleLinear(
                  filtered,
                  Math.round(SAMPLE_RATE * pitchFactor),
                  SAMPLE_RATE,
                );
                const embs = this.extractActiveEmbeddings(warped, { phaseOffsetSamples: 0 });
                if (embs.length > 0) {
                  records.push({
                    voiceTag: `sapi:${slug}:pitch${pitchFactor}`,
                    embeddings: embs,
                  });
                }
              }
            }
          }

          if (records.length > 0) {
            replaceTtsPrototypesForWord(word.display, records);
            bootstrapped.push(word.display);
          } else {
            skipped.push(word.display);
          }
        }

        // 更新硬负样本与平衡后的通用语音背景均值 bgMean
        const refreshedStore = loadWakeWordStore();
        let nextHardNegs: WakeWordHardNegativeRecord[] = refreshedStore.hardNegatives;

        if (needHardNegs) {
          const builtNegs: WakeWordHardNegativeRecord[] = [];
          for (let ni = 0; ni < DEFAULT_HARD_NEGATIVES.length; ni += 1) {
            const label = DEFAULT_HARD_NEGATIVES[ni]!;
            const entry = synthMap.get(`n_${ni}`);
            if (!entry) continue;
            const filtered = applyHighPassFilter(entry.pcm16k, SAMPLE_RATE, 85);
            const embs = this.extractActiveEmbeddings(filtered, { phaseOffsetSamples: 0 });
            if (embs.length > 0) {
              builtNegs.push({ label, embeddings: embs });
            }
          }
          if (builtNegs.length > 0) {
            nextHardNegs = builtNegs;
          }
        }

        const bgMean = computeBalancedBackgroundMean(refreshedStore.prototypes, nextHardNegs);
        if (bgMean.length === WAKEWORD_EMBEDDING_DIM || nextHardNegs.length > 0) {
          setStoreBackgroundStats(bgMean, nextHardNegs);
        }

        return {
          bootstrapped,
          skipped,
          durationMs: Number((performance.now() - t0).toFixed(2)),
        };
      } finally {
        this._bootstrapping = false;
      }
    };

    const next = this._bootstrapQueue.then(run, run);
    this._bootstrapQueue = next.catch(() => undefined);
    return next;
  }
}

/**
 * 计算按词条/硬负样本类别均衡加权的 96 维通用语音背景均值，避免样本数量多的单个词条拉偏全局均值。
 */
function computeBalancedBackgroundMean(
  prototypes: readonly WakeWordPrototypeRecord[],
  hardNegatives: readonly WakeWordHardNegativeRecord[],
): number[] {
  const classBuckets = new Map<string, number[][]>();

  for (const proto of prototypes) {
    const key = `w:${normalizeWakeWordKey(proto.wakeWord)}`;
    let frames = classBuckets.get(key);
    if (!frames) {
      frames = [];
      classBuckets.set(key, frames);
    }
    for (const f of proto.embeddings) {
      if (f.length === WAKEWORD_EMBEDDING_DIM) frames.push(f);
    }
  }

  for (const hn of hardNegatives) {
    const key = `n:${normalizeWakeWordKey(hn.label)}`;
    let frames = classBuckets.get(key);
    if (!frames) {
      frames = [];
      classBuckets.set(key, frames);
    }
    for (const f of hn.embeddings) {
      if (f.length === WAKEWORD_EMBEDDING_DIM) frames.push(f);
    }
  }

  if (classBuckets.size === 0) {
    return [];
  }

  const globalSum = new Float64Array(WAKEWORD_EMBEDDING_DIM);
  let validClasses = 0;

  for (const frames of classBuckets.values()) {
    if (frames.length === 0) continue;
    const classSum = new Float64Array(WAKEWORD_EMBEDDING_DIM);
    for (const f of frames) {
      for (let d = 0; d < WAKEWORD_EMBEDDING_DIM; d += 1) {
        classSum[d] = classSum[d]! + f[d]!;
      }
    }
    for (let d = 0; d < WAKEWORD_EMBEDDING_DIM; d += 1) {
      globalSum[d] = globalSum[d]! + classSum[d]! / frames.length;
    }
    validClasses += 1;
  }

  if (validClasses === 0) {
    return [];
  }

  const bgMean = new Array<number>(WAKEWORD_EMBEDDING_DIM);
  for (let d = 0; d < WAKEWORD_EMBEDDING_DIM; d += 1) {
    bgMean[d] = globalSum[d]! / validClasses;
  }
  return bgMean;
}

// 供外部按需直接复用 L2 归一化工具
export { l2Normalize };
