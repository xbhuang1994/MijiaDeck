// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * 实时自适应声学回声消除器（PBFDAF: Partitioned Block Frequency-Domain Adaptive Filter +
 * 双讲检测 DTD + 频域残余回声抑制 RES）。
 *
 * 面向 16kHz 单声道全双工语音交互：
 * - Hop = 256 采样 (16ms)，FFT = 512 点，M = 16 个分块覆盖最长 256ms 扬声器到麦克风传输延迟与室内混响尾；
 * - 零外部依赖，单帧计算耗时 < 0.2ms，适用于 Node/Bun 服务端与浏览器 AudioWorklet 音频线程；
 * - 检测到双讲（Double-Talk，用户插话）时立即冻结自适应权重防发散，同时继续减去已收敛的线性回声分量，
 *   并放宽后滤波门限完整保留用户近端人声。
 */

export interface AcousticEchoCancellerOptions {
  /** 采样率（默认 16000 Hz） */
  sampleRate?: number;
  /** 分块步进采样数，必须为 2 的幂（默认 256 = 16ms @ 16kHz） */
  blockSize?: number;
  /** 分块数，总滤波长度 = blockSize * numPartitions（默认 16 => 256ms） */
  numPartitions?: number;
  /** NLMS 归一化步长（默认 0.45） */
  stepSize?: number;
  /** 频域功率正则化常量，防静音除零（默认 1e-4） */
  regularization?: number;
  /** 远端参考信号激活 RMS 阈值（默认 0.0025） */
  farEndRmsThreshold?: number;
  /** 强效模式（提高残余回声抑制强度） */
  aggressive?: boolean;
}

export interface AecBlockResult {
  /** 消除回声并经过残余抑制后的近端输出（与输入等长） */
  output: Float32Array;
  /** 远端参考（TTS 播报）当前或尾部混响期是否活跃 */
  farEndActive: boolean;
  /** 是否检测到近端双讲（用户在播报期间说话） */
  doubleTalk: boolean;
  /** 当前估计回声回损增强（ERLE，dB，越大说明回声抑制越充分） */
  erleDb: number;
  /** 当前块麦克风输入 RMS */
  micRms: number;
  /** 当前块远端参考 RMS */
  refRms: number;
  /** 当前块输出 RMS */
  outputRms: number;
}

function fftRadix2(re: Float32Array, im: Float32Array, inverse: boolean): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) {
      j ^= bit;
    }
    j ^= bit;
    if (i < j) {
      const tr = re[i]!;
      re[i] = re[j]!;
      re[j] = tr;
      const ti = im[i]!;
      im[i] = im[j]!;
      im[j] = ti;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wlenRe = Math.cos(ang);
    const wlenIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let wRe = 1;
      let wIm = 0;
      const half = len >> 1;
      for (let j = 0; j < half; j += 1) {
        const uRe = re[i + j]!;
        const uIm = im[i + j]!;
        const vRe = re[i + j + half]! * wRe - im[i + j + half]! * wIm;
        const vIm = re[i + j + half]! * wIm + im[i + j + half]! * wRe;
        re[i + j] = uRe + vRe;
        im[i + j] = uIm + vIm;
        re[i + j + half] = uRe - vRe;
        im[i + j + half] = uIm - vIm;
        const nextWRe = wRe * wlenRe - wIm * wlenIm;
        wIm = wRe * wlenIm + wIm * wlenRe;
        wRe = nextWRe;
      }
    }
  }

  if (inverse) {
    const invN = 1 / n;
    for (let i = 0; i < n; i += 1) {
      re[i] = re[i]! * invN;
      im[i] = im[i]! * invN;
    }
  }
}

export class AcousticEchoCanceller {
  readonly sampleRate: number;
  readonly blockSize: number;
  readonly fftSize: number;
  readonly bins: number;
  readonly numPartitions: number;

  private readonly _stepSize: number;
  private readonly _reg: number;
  private readonly _farEndThresh: number;
  private _aggressive: boolean;

  // 延迟线与频域分块权重
  private readonly _prevRef: Float32Array;
  private readonly _xRe: Float32Array[];
  private readonly _xIm: Float32Array[];
  private readonly _wRe: Float32Array[];
  private readonly _wIm: Float32Array[];
  private _partHead = 0;

  // 平滑功率统计（用于 NLMS 归一化、双讲检测与残余回声抑制）
  private readonly _psdRef: Float32Array;
  private readonly _psdErr: Float32Array;
  private readonly _psdEcho: Float32Array;
  private readonly _prevPostGain: Float32Array;
  private readonly _prevErrTime: Float32Array;

  // 临时 FFT 缓冲（零 GC 分配）
  private readonly _tmpRe: Float32Array;
  private readonly _tmpIm: Float32Array;
  private readonly _yRe: Float32Array;
  private readonly _yIm: Float32Array;
  private readonly _eRe: Float32Array;
  private readonly _eIm: Float32Array;
  private readonly _gradRe: Float32Array;
  private readonly _gradIm: Float32Array;

  // 帧级平滑能量与状态机
  private _smoothMicPow = 1e-8;
  private _smoothErrPow = 1e-8;
  private _smoothEchoPow = 1e-8;
  private _smoothRefPow = 1e-8;
  private _farEndHoldBlocks = 0;
  private _doubleTalkHoldBlocks = 0;
  private _erleDb = 0;
  private _convergedRatio = 0;
  private _activeAdaptBlocks = 0;
  private _constraintTick = 0;

  // 任意长度流式切片缓冲
  private _pendingMic: Float32Array = new Float32Array(0);
  private _pendingRef: Float32Array = new Float32Array(0);

  constructor(options: AcousticEchoCancellerOptions = {}) {
    this.sampleRate = options.sampleRate ?? 16000;
    this.blockSize = options.blockSize ?? 256;
    this.fftSize = this.blockSize * 2;
    this.bins = this.fftSize / 2 + 1;
    this.numPartitions = Math.max(2, Math.min(32, options.numPartitions ?? 16));
    this._stepSize = options.stepSize ?? 0.45;
    this._reg = options.regularization ?? 1e-4;
    this._farEndThresh = options.farEndRmsThreshold ?? 0.0025;
    this._aggressive = Boolean(options.aggressive);

    this._prevRef = new Float32Array(this.blockSize);
    this._xRe = Array.from({ length: this.numPartitions }, () => new Float32Array(this.bins));
    this._xIm = Array.from({ length: this.numPartitions }, () => new Float32Array(this.bins));
    this._wRe = Array.from({ length: this.numPartitions }, () => new Float32Array(this.bins));
    this._wIm = Array.from({ length: this.numPartitions }, () => new Float32Array(this.bins));

    this._psdRef = new Float32Array(this.bins).fill(this._reg);
    this._psdErr = new Float32Array(this.bins).fill(1e-7);
    this._psdEcho = new Float32Array(this.bins).fill(1e-7);
    this._prevPostGain = new Float32Array(this.bins).fill(1);
    this._prevErrTime = new Float32Array(this.blockSize);

    this._tmpRe = new Float32Array(this.fftSize);
    this._tmpIm = new Float32Array(this.fftSize);
    this._yRe = new Float32Array(this.fftSize);
    this._yIm = new Float32Array(this.fftSize);
    this._eRe = new Float32Array(this.fftSize);
    this._eIm = new Float32Array(this.fftSize);
    this._gradRe = new Float32Array(this.fftSize);
    this._gradIm = new Float32Array(this.fftSize);
  }

  setAggressive(aggressive: boolean): void {
    this._aggressive = Boolean(aggressive);
  }

  get erleDb(): number {
    return this._erleDb;
  }

  reset(): void {
    this._prevRef.fill(0);
    for (let p = 0; p < this.numPartitions; p += 1) {
      this._xRe[p]!.fill(0);
      this._xIm[p]!.fill(0);
      this._wRe[p]!.fill(0);
      this._wIm[p]!.fill(0);
    }
    this._partHead = 0;
    this._psdRef.fill(this._reg);
    this._psdErr.fill(1e-7);
    this._psdEcho.fill(1e-7);
    this._prevPostGain.fill(1);
    this._prevErrTime.fill(0);
    this._smoothMicPow = 1e-8;
    this._smoothErrPow = 1e-8;
    this._smoothEchoPow = 1e-8;
    this._smoothRefPow = 1e-8;
    this._farEndHoldBlocks = 0;
    this._doubleTalkHoldBlocks = 0;
    this._erleDb = 0;
    this._convergedRatio = 0;
    this._activeAdaptBlocks = 0;
    this._constraintTick = 0;
    this._pendingMic = new Float32Array(0);
    this._pendingRef = new Float32Array(0);
  }

  /**
   * 处理单个固定 blockSize 帧（mic 与 ref 长度均须为 blockSize）。
   */
  processBlock(mic: Float32Array, ref: Float32Array): AecBlockResult {
    const N = this.blockSize;
    const F = this.fftSize;
    const B = this.bins;
    const M = this.numPartitions;

    let micSumSq = 0;
    let refSumSq = 0;
    for (let i = 0; i < N; i += 1) {
      const m = mic[i] ?? 0;
      const r = ref[i] ?? 0;
      micSumSq += m * m;
      refSumSq += r * r;
    }
    const micPow = micSumSq / N;
    const refPow = refSumSq / N;
    const micRms = Math.sqrt(micPow);
    const refRms = Math.sqrt(refPow);

    const refPresentNow = refRms >= this._farEndThresh;
    if (refPresentNow) {
      // 保留 ~220ms 混响尾活跃标志
      this._farEndHoldBlocks = Math.max(12, Math.round((0.22 * this.sampleRate) / N));
    } else if (this._farEndHoldBlocks > 0) {
      this._farEndHoldBlocks -= 1;
    }
    const farEndActive = refPresentNow || this._farEndHoldBlocks > 0;

    // 1. 远端参考信号 Overlap-Save FFT：x_block = [prevRef, ref]
    this._tmpRe.set(this._prevRef, 0);
    this._tmpRe.set(ref.subarray(0, N), N);
    this._tmpIm.fill(0);
    this._prevRef.set(ref.subarray(0, N), 0);

    fftRadix2(this._tmpRe, this._tmpIm, false);

    // 写入最新分块头（环形索引）
    this._partHead = (this._partHead - 1 + M) % M;
    const curXRe = this._xRe[this._partHead]!;
    const curXIm = this._xIm[this._partHead]!;
    for (let k = 0; k < B; k += 1) {
      curXRe[k] = this._tmpRe[k]!;
      curXIm[k] = this._tmpIm[k]!;
    }

    // 若远端完全静默且无残留混响，直接零失真透传麦克风信号
    if (!farEndActive) {
      this._doubleTalkHoldBlocks = 0;
      this._prevErrTime.set(mic.subarray(0, N), 0);
      this._prevPostGain.fill(1);
      const out = new Float32Array(N);
      out.set(mic.subarray(0, N), 0);
      return {
        output: out,
        farEndActive: false,
        doubleTalk: false,
        erleDb: this._erleDb,
        micRms,
        refRms,
        outputRms: micRms,
      };
    }

    // 2. 分块频域滤波预测线性回声 Y(k) = sum_{p=0}^{M-1} W_p(k) * X_p(k)
    this._yRe.fill(0);
    this._yIm.fill(0);
    for (let p = 0; p < M; p += 1) {
      const idx = (this._partHead + p) % M;
      const xpRe = this._xRe[idx]!;
      const xpIm = this._xIm[idx]!;
      const wpRe = this._wRe[p]!;
      const wpIm = this._wIm[p]!;
      for (let k = 0; k < B; k += 1) {
        const xr = xpRe[k]!;
        const xi = xpIm[k]!;
        const wr = wpRe[k]!;
        const wi = wpIm[k]!;
        this._yRe[k] = this._yRe[k]! + (wr * xr - wi * xi);
        this._yIm[k] = this._yIm[k]! + (wr * xi + wi * xr);
      }
    }

    // 共轭对称补全以执行实数 IFFT
    for (let k = 1; k < B - 1; k += 1) {
      this._yRe[F - k] = this._yRe[k]!;
      this._yIm[F - k] = -this._yIm[k]!;
    }
    fftRadix2(this._yRe, this._yIm, true);

    // 3. 计算线性误差 e[n] = mic[n] - y_hat[n]（取后半段有效线性卷积样本）
    const linearErr = new Float32Array(N);
    let errSumSq = 0;
    let echoSumSq = 0;
    let micEchoDot = 0;
    let errEchoDot = 0;
    for (let i = 0; i < N; i += 1) {
      const m = mic[i] ?? 0;
      const yh = this._yRe[N + i] ?? 0;
      const e = m - yh;
      linearErr[i] = e;
      errSumSq += e * e;
      echoSumSq += yh * yh;
      micEchoDot += m * yh;
      errEchoDot += e * yh;
    }

    const errPow = errSumSq / N;
    const echoPow = echoSumSq / N;

    this._smoothMicPow = 0.72 * this._smoothMicPow + 0.28 * micPow;
    this._smoothErrPow = 0.72 * this._smoothErrPow + 0.28 * errPow;
    this._smoothEchoPow = 0.72 * this._smoothEchoPow + 0.28 * echoPow;
    this._smoothRefPow = 0.72 * this._smoothRefPow + 0.28 * refPow;

    // 4. 双讲检测（Double-Talk Detector）：
    //    结合回声相关性、残差突升比与能量门限，区分「纯回声收敛期」与「用户真实插话」
    const micEchoCorr =
      micSumSq > 1e-9 && echoSumSq > 1e-9
        ? Math.abs(micEchoDot) / Math.sqrt(micSumSq * echoSumSq)
        : 0;
    const errEchoCorr =
      errSumSq > 1e-9 && echoSumSq > 1e-9
        ? Math.abs(errEchoDot) / Math.sqrt(errSumSq * echoSumSq)
        : 0;
    const converged = this._activeAdaptBlocks >= 10 && this._convergedRatio > 0.45;
    const errRms = Math.sqrt(errPow);
    const echoRms = Math.sqrt(echoPow);

    const strongUncorrelatedNearEnd =
      converged &&
      errRms > Math.max(0.014, echoRms * 0.42) &&
      errEchoCorr < 0.35 &&
      micPow > echoPow * 1.35;
    const suddenLoudNearEnd =
      micRms > Math.max(0.035, refRms * 1.45) &&
      errRms > Math.max(0.025, echoRms * 0.85) &&
      micEchoCorr < 0.55;

    if (strongUncorrelatedNearEnd || suddenLoudNearEnd) {
      this._doubleTalkHoldBlocks = 6; // ~96ms 滞回保持，防止语音元音间断抖动
    } else if (this._doubleTalkHoldBlocks > 0) {
      this._doubleTalkHoldBlocks -= 1;
    }
    const doubleTalk = this._doubleTalkHoldBlocks > 0;

    // 5. 误差频谱（前 N 补零，后 N 为 linearErr）用于分块 NLMS 权重更新
    this._eRe.fill(0);
    this._eIm.fill(0);
    for (let i = 0; i < N; i += 1) {
      this._eRe[N + i] = linearErr[i]!;
    }
    fftRadix2(this._eRe, this._eIm, false);

    // 计算总远端分块功率谱并更新平滑 PSD
    for (let k = 0; k < B; k += 1) {
      let totalX = 0;
      for (let p = 0; p < M; p += 1) {
        const xr = this._xRe[p]![k]!;
        const xi = this._xIm[p]![k]!;
        totalX += xr * xr + xi * xi;
      }
      this._psdRef[k] = 0.65 * this._psdRef[k]! + 0.35 * totalX;
    }

    // 仅在远端活跃且非双讲时更新自适应滤波器权重（双讲时冻结权重防发散）
    if (refPresentNow && !doubleTalk) {
      const mu = this._stepSize;
      // 发散保护：若误差显著大于麦克风输入，按比例衰减权重并重新收敛
      if (errPow > micPow * 2.5 && micPow > 1e-6) {
        for (let p = 0; p < M; p += 1) {
          const wpRe = this._wRe[p]!;
          const wpIm = this._wIm[p]!;
          for (let k = 0; k < B; k += 1) {
            wpRe[k] = wpRe[k]! * 0.5;
            wpIm[k] = wpIm[k]! * 0.5;
          }
        }
      } else {
        // 每块对其中一个分块执行频域梯度投影约束（轮换约束，兼顾精度与极低算力）
        const constrainedPartition = this._constraintTick % M;
        this._constraintTick += 1;

        for (let p = 0; p < M; p += 1) {
          const idx = (this._partHead + p) % M;
          const xpRe = this._xRe[idx]!;
          const xpIm = this._xIm[idx]!;
          const wpRe = this._wRe[p]!;
          const wpIm = this._wIm[p]!;

          if (p === constrainedPartition) {
            this._gradRe.fill(0);
            this._gradIm.fill(0);
            for (let k = 0; k < B; k += 1) {
              const norm = mu / (this._psdRef[k]! + this._reg);
              const er = this._eRe[k]!;
              const ei = this._eIm[k]!;
              const xr = xpRe[k]!;
              const xi = xpIm[k]!;
              // conj(X) * E
              const gr = (xr * er + xi * ei) * norm;
              const gi = (xr * ei - xi * er) * norm;
              this._gradRe[k] = gr;
              this._gradIm[k] = gi;
              if (k > 0 && k < B - 1) {
                this._gradRe[F - k] = gr;
                this._gradIm[F - k] = -gi;
              }
            }
            // 投影回时域并置零后半段，保证严格线性卷积
            fftRadix2(this._gradRe, this._gradIm, true);
            for (let i = N; i < F; i += 1) {
              this._gradRe[i] = 0;
            }
            this._gradIm.fill(0);
            fftRadix2(this._gradRe, this._gradIm, false);
            for (let k = 0; k < B; k += 1) {
              wpRe[k] = wpRe[k]! + this._gradRe[k]!;
              wpIm[k] = wpIm[k]! + this._gradIm[k]!;
            }
          } else {
            for (let k = 0; k < B; k += 1) {
              const norm = mu / (this._psdRef[k]! + this._reg);
              const er = this._eRe[k]!;
              const ei = this._eIm[k]!;
              const xr = xpRe[k]!;
              const xi = xpIm[k]!;
              wpRe[k] = wpRe[k]! + (xr * er + xi * ei) * norm;
              wpIm[k] = wpIm[k]! + (xr * ei - xi * er) * norm;
            }
          }
        }
        this._activeAdaptBlocks += 1;
        const instantErleRatio = this._smoothMicPow > 1e-8
          ? Math.max(0, Math.min(1, 1 - this._smoothErrPow / this._smoothMicPow))
          : 0;
        this._convergedRatio = 0.85 * this._convergedRatio + 0.15 * instantErleRatio;
      }
    }

    // 6. 频域残余回声抑制（RES / Nonlinear Post-Filter）
    //    在非双讲期抑制扬声器非线性失真与超长混响残余；双讲期放宽增益地板以完整保留人声清晰度
    this._tmpRe.set(this._prevErrTime, 0);
    this._tmpRe.set(linearErr, N);
    this._tmpIm.fill(0);
    this._prevErrTime.set(linearErr, 0);
    fftRadix2(this._tmpRe, this._tmpIm, false);

    // 计算当前估计回声频谱能量（复用 y_hat 时域后半段）
    this._gradRe.fill(0);
    this._gradIm.fill(0);
    for (let i = 0; i < N; i += 1) {
      this._gradRe[N + i] = this._yRe[N + i] ?? 0;
    }
    fftRadix2(this._gradRe, this._gradIm, false);

    const overSub = doubleTalk
      ? this._aggressive
        ? 0.65
        : 0.45
      : this._aggressive
        ? 2.2
        : 1.45;
    const gainFloor = doubleTalk ? 0.35 : this._aggressive ? 0.025 : 0.06;
    const leakFactor = converged ? 0.32 : 0.65;

    for (let k = 0; k < B; k += 1) {
      const errP = this._tmpRe[k]! * this._tmpRe[k]! + this._tmpIm[k]! * this._tmpIm[k]!;
      const echoP = this._gradRe[k]! * this._gradRe[k]! + this._gradIm[k]! * this._gradIm[k]!;
      this._psdErr[k] = 0.55 * this._psdErr[k]! + 0.45 * errP;
      this._psdEcho[k] = 0.55 * this._psdEcho[k]! + 0.45 * echoP;

      const resEchoEst =
        this._psdEcho[k]! * leakFactor + (refPresentNow ? this._psdRef[k]! * 0.004 : 0);
      const wiener =
        this._psdErr[k]! > 1e-10
          ? Math.max(0, this._psdErr[k]! - overSub * resEchoEst) / this._psdErr[k]!
          : gainFloor;
      const targetGain = Math.max(gainFloor, Math.min(1, wiener));
      const smoothGain = 0.35 * this._prevPostGain[k]! + 0.65 * targetGain;
      this._prevPostGain[k] = smoothGain;

      this._tmpRe[k] = this._tmpRe[k]! * smoothGain;
      this._tmpIm[k] = this._tmpIm[k]! * smoothGain;
      if (k > 0 && k < B - 1) {
        this._tmpRe[F - k] = this._tmpRe[k]!;
        this._tmpIm[F - k] = -this._tmpIm[k]!;
      }
    }

    fftRadix2(this._tmpRe, this._tmpIm, true);
    const out = new Float32Array(N);
    let outSumSq = 0;
    for (let i = 0; i < N; i += 1) {
      const v = Math.max(-1, Math.min(1, this._tmpRe[N + i] ?? 0));
      out[i] = v;
      outSumSq += v * v;
    }
    const outPow = outSumSq / N;
    const outputRms = Math.sqrt(outPow);

    if (refPresentNow && !doubleTalk && this._smoothMicPow > 1e-7) {
      const instantDb = 10 * Math.log10((this._smoothMicPow + 1e-9) / (outPow + 1e-9));
      const clampedDb = Math.max(0, Math.min(45, instantDb));
      this._erleDb = Number((0.8 * this._erleDb + 0.2 * clampedDb).toFixed(1));
    }

    return {
      output: out,
      farEndActive,
      doubleTalk,
      erleDb: this._erleDb,
      micRms,
      refRms,
      outputRms,
    };
  }

  /**
   * 处理任意长度的连续 PCM 流切片（自动按 blockSize 切块并保留尾部余量）。
   */
  processStream(micSamples: Float32Array, refSamples: Float32Array): AecBlockResult {
    const len = Math.min(micSamples.length, refSamples.length);
    if (len === 0) {
      return {
        output: new Float32Array(0),
        farEndActive: this._farEndHoldBlocks > 0,
        doubleTalk: this._doubleTalkHoldBlocks > 0,
        erleDb: this._erleDb,
        micRms: 0,
        refRms: 0,
        outputRms: 0,
      };
    }

    const combinedMic = new Float32Array(this._pendingMic.length + len);
    combinedMic.set(this._pendingMic, 0);
    combinedMic.set(micSamples.subarray(0, len), this._pendingMic.length);

    const combinedRef = new Float32Array(this._pendingRef.length + len);
    combinedRef.set(this._pendingRef, 0);
    combinedRef.set(refSamples.subarray(0, len), this._pendingRef.length);

    const blocks = Math.floor(combinedMic.length / this.blockSize);
    const out = new Float32Array(blocks * this.blockSize);
    let last: AecBlockResult | null = null;
    let anyDoubleTalk = false;
    let anyFarEnd = false;

    for (let b = 0; b < blocks; b += 1) {
      const off = b * this.blockSize;
      const res = this.processBlock(
        combinedMic.subarray(off, off + this.blockSize),
        combinedRef.subarray(off, off + this.blockSize),
      );
      out.set(res.output, off);
      anyDoubleTalk = anyDoubleTalk || res.doubleTalk;
      anyFarEnd = anyFarEnd || res.farEndActive;
      last = res;
    }

    const remOff = blocks * this.blockSize;
    this._pendingMic = combinedMic.slice(remOff);
    this._pendingRef = combinedRef.slice(remOff);

    return {
      output: out,
      farEndActive: anyFarEnd,
      doubleTalk: anyDoubleTalk,
      erleDb: last?.erleDb ?? this._erleDb,
      micRms: last?.micRms ?? 0,
      refRms: last?.refRms ?? 0,
      outputRms: last?.outputRms ?? 0,
    };
  }
}
