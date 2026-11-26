// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * 16kHz Mono PCM WAV 编解码、重采样、信噪比估计、纯 TS 频谱减法降噪与声学声纹降级特征提取。
 * 零外部依赖（无需 ffmpeg），用于前端 AudioWorklet 上传的 PCM WAV 与后端 ONNX/DSP 管线衔接。
 */

export interface DecodedWav {
  samples: Float32Array;
  sampleRate: number;
  channels: number;
  durationSec: number;
}

export interface DspDenoiseResult {
  samples: Float32Array;
  sampleRate: number;
  inputSnrDb: number;
  outputSnrDb: number;
  snrGainDb: number;
}

export interface AdaptiveVadResult {
  hasSpeech: boolean;
  speechSamples: Float32Array;
  speechRatio: number;
  segmentCount: number;
}

function readAscii(view: DataView, offset: number, length: number): string {
  let out = "";
  for (let i = 0; i < length && offset + i < view.byteLength; i += 1) {
    out += String.fromCharCode(view.getUint8(offset + i));
  }
  return out;
}

/**
 * 判断二进制数据是否为 RIFF/WAVE 头。
 */
export function isWavBuffer(data: Uint8Array | ArrayBuffer): boolean {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.byteLength < 44) return false;
  return (
    bytes[0] === 0x52 && // R
    bytes[1] === 0x49 && // I
    bytes[2] === 0x46 && // F
    bytes[3] === 0x46 && // F
    bytes[8] === 0x57 && // W
    bytes[9] === 0x41 && // A
    bytes[10] === 0x56 && // V
    bytes[11] === 0x45 // E
  );
}

/**
 * 解析 PCM 16-bit / PCM 8-bit / IEEE Float 32-bit WAV 为单声道 Float32Array（[-1, 1]）。
 */
export function decodeWavPcm(data: Uint8Array | ArrayBuffer): DecodedWav {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (!isWavBuffer(bytes)) {
    throw new Error("无效的 WAV 音频文件头");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let audioFormat = 1;
  let numChannels = 1;
  let sampleRate = 16000;
  let bitsPerSample = 16;
  let dataOffset = -1;
  let dataSize = 0;

  let offset = 12;
  while (offset + 8 <= view.byteLength) {
    const chunkId = readAscii(view, offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const bodyOffset = offset + 8;

    if (chunkId === "fmt " && chunkSize >= 16 && bodyOffset + 16 <= view.byteLength) {
      audioFormat = view.getUint16(bodyOffset, true);
      numChannels = Math.max(1, view.getUint16(bodyOffset + 2, true));
      sampleRate = Math.max(8000, view.getUint32(bodyOffset + 4, true));
      bitsPerSample = view.getUint16(bodyOffset + 14, true);
    } else if (chunkId === "data") {
      dataOffset = bodyOffset;
      dataSize = Math.min(chunkSize, Math.max(0, view.byteLength - bodyOffset));
      break;
    }

    offset = bodyOffset + chunkSize + (chunkSize % 2);
  }

  if (dataOffset < 0 || dataSize <= 0) {
    throw new Error("WAV 文件缺少有效的音频 data 数据块");
  }
  if (audioFormat !== 1 && audioFormat !== 3) {
    throw new Error(`暂不支持的 WAV 编码格式 (format=${audioFormat})`);
  }

  const bytesPerSample = Math.max(1, bitsPerSample >> 3);
  const frameSize = bytesPerSample * numChannels;
  const frameCount = Math.floor(dataSize / frameSize);
  const samples = new Float32Array(frameCount);

  for (let i = 0; i < frameCount; i += 1) {
    let mono = 0;
    const framePos = dataOffset + i * frameSize;
    for (let ch = 0; ch < numChannels; ch += 1) {
      const pos = framePos + ch * bytesPerSample;
      let val = 0;
      if (audioFormat === 3 && bitsPerSample === 32) {
        val = view.getFloat32(pos, true);
      } else if (bitsPerSample === 16) {
        val = view.getInt16(pos, true) / 32768;
      } else if (bitsPerSample === 24) {
        const b0 = bytes[pos] ?? 0;
        const b1 = bytes[pos + 1] ?? 0;
        const b2 = bytes[pos + 2] ?? 0;
        let v = b0 | (b1 << 8) | (b2 << 16);
        if (v & 0x800000) v |= ~0xffffff;
        val = v / 8388608;
      } else if (bitsPerSample === 8) {
        val = ((bytes[pos] ?? 128) - 128) / 128;
      } else {
        val = view.getInt16(pos, true) / 32768;
      }
      mono += val;
    }
    const avg = mono / numChannels;
    samples[i] = Math.max(-1, Math.min(1, Number.isFinite(avg) ? avg : 0));
  }

  return {
    samples,
    sampleRate,
    channels: numChannels,
    durationSec: frameCount / sampleRate,
  };
}

/**
 * 将单声道 Float32Array（[-1, 1]）编码为标准 16-bit PCM WAV 字节流。
 */
export function encodeWavPcm16(samples: Float32Array, sampleRate = 16000): Uint8Array {
  const numSamples = samples.length;
  const dataBytes = numSamples * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  const writeStr = (off: number, str: string) => {
    for (let i = 0; i < str.length; i += 1) {
      view.setUint8(off + i, str.charCodeAt(i));
    }
  };

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, "data");
  view.setUint32(40, dataBytes, true);

  let outOff = 44;
  for (let i = 0; i < numSamples; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(outOff, s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), true);
    outOff += 2;
  }

  return new Uint8Array(buffer);
}

/**
 * 轻量线性抗混叠重采样（支持 48kHz / 44.1kHz / 22.05kHz -> 16kHz）。
 */
export function resampleLinear(
  samples: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array {
  if (fromRate === toRate || samples.length === 0) {
    return samples;
  }
  const ratio = fromRate / toRate;
  const outLength = Math.max(1, Math.round(samples.length / ratio));
  const out = new Float32Array(outLength);

  if (ratio > 1.5) {
    // 降采样时做简单箱式平均抗混叠
    const radius = Math.max(1, Math.floor(ratio * 0.5));
    for (let i = 0; i < outLength; i += 1) {
      const center = i * ratio;
      const start = Math.max(0, Math.floor(center - radius));
      const end = Math.min(samples.length - 1, Math.ceil(center + radius));
      let sum = 0;
      let count = 0;
      for (let j = start; j <= end; j += 1) {
        sum += samples[j]!;
        count += 1;
      }
      out[i] = count > 0 ? sum / count : 0;
    }
    return out;
  }

  for (let i = 0; i < outLength; i += 1) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = samples[Math.min(idx, samples.length - 1)] ?? 0;
    const b = samples[Math.min(idx + 1, samples.length - 1)] ?? a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/**
 * 一阶高通滤波（默认 85Hz）：消除直流漂移、50/60Hz 交流电嗡声与桌面低频震动。
 */
export function applyHighPassFilter(
  samples: Float32Array,
  sampleRate = 16000,
  cutoffHz = 85,
): Float32Array {
  if (samples.length === 0) return samples;
  const out = new Float32Array(samples.length);
  const rc = 1 / (2 * Math.PI * cutoffHz);
  const dt = 1 / sampleRate;
  const alpha = rc / (rc + dt);

  let prevX = samples[0]!;
  let prevY = 0;
  out[0] = 0;
  for (let i = 1; i < samples.length; i += 1) {
    const x = samples[i]!;
    const y = alpha * (prevY + x - prevX);
    out[i] = y;
    prevX = x;
    prevY = y;
  }
  return out;
}

export function computeRms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const s = samples[i]!;
    sum += s * s;
  }
  return Math.sqrt(sum / samples.length);
}

/**
 * 分帧估计语音分段信噪比（SNR dB）：
 * 使用 20ms 帧能量的第 15 百分位估计底噪，第 90 百分位估计语音峰值。
 */
export function estimateSnrDb(samples: Float32Array, sampleRate = 16000): number {
  const frameLen = Math.max(160, Math.round(sampleRate * 0.02));
  const frameCount = Math.floor(samples.length / frameLen);
  if (frameCount < 3) {
    return 0;
  }
  const energies: number[] = [];
  for (let f = 0; f < frameCount; f += 1) {
    let sum = 0;
    const base = f * frameLen;
    for (let i = 0; i < frameLen; i += 1) {
      const s = samples[base + i]!;
      sum += s * s;
    }
    energies.push(sum / frameLen);
  }
  energies.sort((a, b) => a - b);
  const noiseFloor = Math.max(1e-10, energies[Math.floor(energies.length * 0.15)] ?? 1e-10);
  const speechPeak = Math.max(noiseFloor, energies[Math.floor(energies.length * 0.9)] ?? noiseFloor);
  const snr = 10 * Math.log10(speechPeak / noiseFloor);
  return Number(Math.max(0, Math.min(60, snr)).toFixed(2));
}

// ---------------------------------------------------------------------------
// 轻量 Radix-2 FFT + 纯 TS 频谱减法/维纳降噪（GTCRN 未安装时的零依赖降级方案）
// ---------------------------------------------------------------------------

function fftInPlace(re: Float32Array, im: Float32Array, inverse: boolean): void {
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
    for (let i = 0; i < n; i += 1) {
      re[i] = re[i]! / n;
      im[i] = im[i]! / n;
    }
  }
}

/**
 * 纯 TypeScript 频谱维纳降噪（85Hz 高通 + 512 点 Hann 窗 STFT + 最小统计底噪估计 + 软增益地板）。
 */
export function spectralSubtractDenoise(
  input: Float32Array,
  sampleRate = 16000,
): DspDenoiseResult {
  const inputSnrDb = estimateSnrDb(input, sampleRate);
  if (input.length < 512) {
    const hp = applyHighPassFilter(input, sampleRate, 85);
    const outSnr = estimateSnrDb(hp, sampleRate);
    return {
      samples: hp,
      sampleRate,
      inputSnrDb,
      outputSnrDb: outSnr,
      snrGainDb: Number((outSnr - inputSnrDb).toFixed(2)),
    };
  }

  const filtered = applyHighPassFilter(input, sampleRate, 85);
  const fftSize = 512;
  const hop = 256;
  const bins = fftSize / 2 + 1;

  const win = new Float32Array(fftSize);
  for (let i = 0; i < fftSize; i += 1) {
    win[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (fftSize - 1)));
  }

  const numFrames = Math.max(1, Math.floor((filtered.length - fftSize) / hop) + 1);
  const framePowers: Float32Array[] = [];
  const frameRe: Float32Array[] = [];
  const frameIm: Float32Array[] = [];
  const frameTotals: Array<{ idx: number; energy: number }> = [];

  for (let f = 0; f < numFrames; f += 1) {
    const re = new Float32Array(fftSize);
    const im = new Float32Array(fftSize);
    const start = f * hop;
    let totalE = 0;
    for (let i = 0; i < fftSize; i += 1) {
      const v = (filtered[start + i] ?? 0) * win[i]!;
      re[i] = v;
      totalE += v * v;
    }
    fftInPlace(re, im, false);
    const pwr = new Float32Array(bins);
    for (let k = 0; k < bins; k += 1) {
      pwr[k] = re[k]! * re[k]! + im[k]! * im[k]!;
    }
    frameRe.push(re);
    frameIm.push(im);
    framePowers.push(pwr);
    frameTotals.push({ idx: f, energy: totalE });
  }

  // 使用能量最低的 20% 帧作为环境底噪谱估计
  frameTotals.sort((a, b) => a.energy - b.energy);
  const noiseFramesCount = Math.max(1, Math.floor(numFrames * 0.2));
  const noisePsd = new Float32Array(bins);
  for (let n = 0; n < noiseFramesCount; n += 1) {
    const pwr = framePowers[frameTotals[n]!.idx]!;
    for (let k = 0; k < bins; k += 1) {
      noisePsd[k] = noisePsd[k]! + pwr[k]! / noiseFramesCount;
    }
  }

  const out = new Float32Array(filtered.length);
  const norm = new Float32Array(filtered.length);
  const prevGain = new Float32Array(bins).fill(1);
  const oversubtract = 1.65;
  const gainFloor = 0.08;

  for (let f = 0; f < numFrames; f += 1) {
    const re = frameRe[f]!;
    const im = frameIm[f]!;
    const pwr = framePowers[f]!;

    for (let k = 0; k < bins; k += 1) {
      const cleanEst = Math.max(0, pwr[k]! - oversubtract * noisePsd[k]!);
      const wiener = pwr[k]! > 1e-12 ? cleanEst / pwr[k]! : gainFloor;
      const clamped = Math.max(gainFloor, Math.min(1, wiener));
      const smooth = 0.35 * prevGain[k]! + 0.65 * clamped;
      prevGain[k] = smooth;

      re[k] = re[k]! * smooth;
      im[k] = im[k]! * smooth;
      if (k > 0 && k < bins - 1) {
        const mirror = fftSize - k;
        re[mirror] = re[mirror]! * smooth;
        im[mirror] = im[mirror]! * smooth;
      }
    }

    fftInPlace(re, im, true);
    const start = f * hop;
    for (let i = 0; i < fftSize && start + i < out.length; i += 1) {
      const w = win[i]!;
      out[start + i] = out[start + i]! + re[i]! * w;
      norm[start + i] = norm[start + i]! + w * w;
    }
  }

  for (let i = 0; i < out.length; i += 1) {
    if (norm[i]! > 1e-6) {
      out[i] = Math.max(-1, Math.min(1, out[i]! / norm[i]!));
    } else {
      out[i] = filtered[i]!;
    }
  }

  const outputSnrDb = estimateSnrDb(out, sampleRate);
  return {
    samples: out,
    sampleRate,
    inputSnrDb,
    outputSnrDb,
    snrGainDb: Number((outputSnrDb - inputSnrDb).toFixed(2)),
  };
}

/**
 * 连续流式纯 TS 频谱维纳降噪器（85Hz 连续高通 + 512 点周期 sqrt-Hann 50% 重叠 STFT/ISTFT +
 * 逐频点非对称底噪追踪）：
 * - 当用户选择 `dsp` 模式或本地 ONNX 降噪模型（GTCRN/DPDFNet4）尚未就绪时，
 *   保障待机与对话实时流仍具备连续低延迟（16ms 帧移）环境降噪能力，不再退化为零降噪直通。
 */
export class StreamingDspDenoiser {
  readonly sampleRate: number;
  readonly frameShiftInSamples = 256;

  private readonly _fftSize = 512;
  private readonly _hop = 256;
  private readonly _bins = 257;
  private readonly _win: Float32Array;
  private readonly _hpAlpha: number;

  private _hpPrevX = 0;
  private _hpPrevY = 0;
  private _inPending = new Float32Array(0);
  private _prevInputHalf = new Float32Array(256);
  private _olaTail = new Float32Array(256);
  private _noisePsd = new Float32Array(257);
  private _prevGain = new Float32Array(257).fill(1);
  private _noiseInitialized = false;
  private _re = new Float32Array(512);
  private _im = new Float32Array(512);

  constructor(sampleRate = 16000) {
    this.sampleRate = sampleRate;
    const rc = 1 / (2 * Math.PI * 85);
    const dt = 1 / sampleRate;
    this._hpAlpha = rc / (rc + dt);
    this._win = new Float32Array(this._fftSize);
    for (let i = 0; i < this._fftSize; i += 1) {
      // 周期 sqrt-Hann：50% hop 完美满足 COLA（sin^2 + cos^2 === 1）
      this._win[i] = Math.sin((Math.PI * i) / this._fftSize);
    }
  }

  reset(): void {
    this._hpPrevX = 0;
    this._hpPrevY = 0;
    this._inPending = new Float32Array(0);
    this._prevInputHalf.fill(0);
    this._olaTail.fill(0);
    this._noisePsd.fill(0);
    this._prevGain.fill(1);
    this._noiseInitialized = false;
  }

  private _processHop(hopSamples: Float32Array, outDest: Float32Array, outOffset: number): void {
    const N = this._fftSize;
    const H = this._hop;
    const B = this._bins;
    const re = this._re;
    const im = this._im;
    const win = this._win;

    // 拼接 [prev 256, curr 256] 并施加 85Hz 高通 + sqrt-Hann 分析窗
    for (let i = 0; i < H; i += 1) {
      re[i] = this._prevInputHalf[i]! * win[i]!;
      im[i] = 0;
    }
    let prevX = this._hpPrevX;
    let prevY = this._hpPrevY;
    const alpha = this._hpAlpha;
    for (let i = 0; i < H; i += 1) {
      const x = hopSamples[i]!;
      const y = alpha * (prevY + x - prevX);
      prevX = x;
      prevY = y;
      this._prevInputHalf[i] = y;
      re[H + i] = y * win[H + i]!;
      im[H + i] = 0;
    }
    this._hpPrevX = prevX;
    this._hpPrevY = prevY;

    fftInPlace(re, im, false);

    // 帧级信噪比辅助判断：语音活跃帧极慢更新底噪，静默/稳态噪声帧平稳跟踪底噪
    let totalPwr = 0;
    let totalNoise = 0;
    for (let k = 0; k < B; k += 1) {
      const p = re[k]! * re[k]! + im[k]! * im[k]!;
      totalPwr += p;
      totalNoise += this._noisePsd[k]!;
    }

    if (!this._noiseInitialized) {
      for (let k = 0; k < B; k += 1) {
        this._noisePsd[k] = re[k]! * re[k]! + im[k]! * im[k]!;
      }
      this._noiseInitialized = true;
    } else {
      const speechLikely = totalNoise > 1e-10 && totalPwr > totalNoise * 2.2;
      const upRate = speechLikely ? 0.0025 : 0.08;
      const downRate = speechLikely ? 0.16 : 0.12;
      for (let k = 0; k < B; k += 1) {
        const p = re[k]! * re[k]! + im[k]! * im[k]!;
        const cur = this._noisePsd[k]!;
        const rate = p < cur ? downRate : upRate;
        this._noisePsd[k] = cur * (1 - rate) + p * rate;
      }
    }

    const oversubtract = 1.75;
    const gainFloor = 0.12;
    for (let k = 0; k < B; k += 1) {
      const p = re[k]! * re[k]! + im[k]! * im[k]!;
      const cleanEst = Math.max(0, p - oversubtract * this._noisePsd[k]!);
      const wiener = p > 1e-12 ? cleanEst / p : gainFloor;
      const clamped = Math.max(gainFloor, Math.min(1, wiener));
      const g = 0.35 * this._prevGain[k]! + 0.65 * clamped;
      this._prevGain[k] = g;

      re[k] = re[k]! * g;
      im[k] = im[k]! * g;
      if (k > 0 && k < B - 1) {
        const mirror = N - k;
        re[mirror] = re[mirror]! * g;
        im[mirror] = im[mirror]! * g;
      }
    }

    fftInPlace(re, im, true);

    for (let i = 0; i < H; i += 1) {
      const s = this._olaTail[i]! + re[i]! * win[i]!;
      outDest[outOffset + i] = Math.max(-1, Math.min(1, s));
      this._olaTail[i] = re[H + i]! * win[H + i]!;
    }
  }

  run(req: { samples: Float32Array; sampleRate: number }): {
    samples: Float32Array;
    sampleRate: number;
  } {
    const input =
      req.sampleRate === this.sampleRate
        ? req.samples
        : resampleLinear(req.samples, req.sampleRate, this.sampleRate);
    if (input.length === 0) {
      return { samples: new Float32Array(0), sampleRate: this.sampleRate };
    }

    let buf: Float32Array;
    if (this._inPending.length === 0) {
      buf = input;
    } else {
      buf = new Float32Array(this._inPending.length + input.length);
      buf.set(this._inPending, 0);
      buf.set(input, this._inPending.length);
    }

    const H = this._hop;
    const fullHops = Math.floor(buf.length / H);
    const out = new Float32Array(fullHops * H);
    for (let h = 0; h < fullHops; h += 1) {
      this._processHop(buf.subarray(h * H, (h + 1) * H), out, h * H);
    }

    const consumed = fullHops * H;
    this._inPending = consumed < buf.length ? buf.slice(consumed) : new Float32Array(0);
    return { samples: out, sampleRate: this.sampleRate };
  }

  flush(): { samples: Float32Array; sampleRate: number } {
    if (this._inPending.length === 0) {
      return { samples: new Float32Array(0), sampleRate: this.sampleRate };
    }
    const pendingLen = this._inPending.length;
    const padded = new Float32Array(this._hop);
    padded.set(this._inPending, 0);
    this._inPending = new Float32Array(0);
    const tmp = new Float32Array(this._hop);
    this._processHop(padded, tmp, 0);
    return { samples: tmp.slice(0, pendingLen), sampleRate: this.sampleRate };
  }
}

/**
 * 纯 TS 自适应底噪 + 过零率端点检测（Silero VAD 不可用时的降级方案）。
 */
export function adaptiveEnergyVad(
  samples: Float32Array,
  sampleRate = 16000,
  thresholdRatio = 2.6,
): AdaptiveVadResult {
  const frameLen = Math.round(sampleRate * 0.02); // 20ms
  const frameCount = Math.floor(samples.length / frameLen);
  if (frameCount < 3) {
    return {
      hasSpeech: false,
      speechSamples: new Float32Array(0),
      speechRatio: 0,
      segmentCount: 0,
    };
  }

  const rmsList = new Float32Array(frameCount);
  const zcrList = new Float32Array(frameCount);
  for (let f = 0; f < frameCount; f += 1) {
    const start = f * frameLen;
    let sumSq = 0;
    let crossings = 0;
    for (let i = 0; i < frameLen; i += 1) {
      const cur = samples[start + i]!;
      sumSq += cur * cur;
      if (i > 0) {
        const prev = samples[start + i - 1]!;
        if ((cur >= 0 && prev < 0) || (cur < 0 && prev >= 0)) crossings += 1;
      }
    }
    rmsList[f] = Math.sqrt(sumSq / frameLen);
    zcrList[f] = crossings / frameLen;
  }

  const sortedRms = Array.from(rmsList).sort((a, b) => a - b);
  const noiseRms = Math.max(0.004, sortedRms[Math.floor(sortedRms.length * 0.2)] ?? 0.004);
  const speechThresh = Math.max(0.012, noiseRms * thresholdRatio);

  const active = new Uint8Array(frameCount);
  let activeCount = 0;
  for (let f = 0; f < frameCount; f += 1) {
    const r = rmsList[f]!;
    const z = zcrList[f]!;
    // 人声特征：能量明显高于底噪，且过零率在合理语音频段（过滤纯高频嘶声和纯直流）
    if (r >= speechThresh && z >= 0.015 && z <= 0.45) {
      active[f] = 1;
      activeCount += 1;
    }
  }

  if (activeCount < 4) {
    return {
      hasSpeech: false,
      speechSamples: new Float32Array(0),
      speechRatio: activeCount / frameCount,
      segmentCount: 0,
    };
  }

  // 合并短于 240ms 的间隔并向两端扩展 120ms 保护边界
  const padFrames = 6;
  const expanded = new Uint8Array(frameCount);
  for (let f = 0; f < frameCount; f += 1) {
    if (!active[f]) continue;
    const lo = Math.max(0, f - padFrames);
    const hi = Math.min(frameCount - 1, f + padFrames);
    for (let k = lo; k <= hi; k += 1) expanded[k] = 1;
  }

  let segments = 0;
  let totalKeepSamples = 0;
  const ranges: Array<[number, number]> = [];
  let inSeg = false;
  let segStart = 0;
  for (let f = 0; f < frameCount; f += 1) {
    if (expanded[f] && !inSeg) {
      inSeg = true;
      segStart = f;
    } else if (!expanded[f] && inSeg) {
      inSeg = false;
      ranges.push([segStart * frameLen, f * frameLen]);
      totalKeepSamples += (f - segStart) * frameLen;
      segments += 1;
    }
  }
  if (inSeg) {
    ranges.push([segStart * frameLen, samples.length]);
    totalKeepSamples += samples.length - segStart * frameLen;
    segments += 1;
  }

  const out = new Float32Array(totalKeepSamples);
  let writePos = 0;
  for (const [s, e] of ranges) {
    const slice = samples.subarray(s, e);
    out.set(slice, writePos);
    writePos += slice.length;
  }

  return {
    hasSpeech: out.length >= Math.round(sampleRate * 0.16),
    speechSamples: out,
    speechRatio: Number((activeCount / frameCount).toFixed(3)),
    segmentCount: segments,
  };
}

// ---------------------------------------------------------------------------
// 向量运算与纯 TS 声学声纹降级特征（3D-Speaker CAM++ 未安装时使用）
// ---------------------------------------------------------------------------

export function l2Normalize(vec: ArrayLike<number>): number[] {
  let normSq = 0;
  for (let i = 0; i < vec.length; i += 1) {
    const v = vec[i] ?? 0;
    normSq += v * v;
  }
  const norm = Math.sqrt(normSq);
  const out = new Array<number>(vec.length);
  if (norm < 1e-12) {
    out.fill(0);
    return out;
  }
  for (let i = 0; i < vec.length; i += 1) {
    out[i] = (vec[i] ?? 0) / norm;
  }
  return out;
}

export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < len; i += 1) {
    const va = a[i] ?? 0;
    const vb = b[i] ?? 0;
    dot += va * vb;
    na += va * va;
    nb += vb * vb;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  if (denom < 1e-12) return 0;
  return Math.max(-1, Math.min(1, dot / denom));
}

function hzToMel(hz: number): number {
  return 2595 * Math.log10(1 + hz / 700);
}

function melToHz(mel: number): number {
  return 700 * (Math.pow(10, mel / 2595) - 1);
}

/**
 * 纯 TS 64 维梅尔倒谱均值+方差声学声纹（当 3D-Speaker CAM++ 模型不可用时的轻量降级）。
 */
export function extractFallbackVoiceprint(
  input: Float32Array,
  sampleRate = 16000,
): number[] {
  const samples = sampleRate === 16000 ? input : resampleLinear(input, sampleRate, 16000);
  const fftSize = 512;
  const hop = 160;
  const numMel = 32;
  const bins = fftSize / 2 + 1;

  // 构建 32 通道三角梅尔滤波器组 (80Hz - 7600Hz)
  const melMin = hzToMel(80);
  const melMax = hzToMel(7600);
  const binPoints: number[] = [];
  for (let m = 0; m < numMel + 2; m += 1) {
    const mel = melMin + ((melMax - melMin) * m) / (numMel + 1);
    const hz = melToHz(mel);
    binPoints.push(Math.floor(((fftSize + 1) * hz) / 16000));
  }

  const win = new Float32Array(fftSize);
  for (let i = 0; i < fftSize; i += 1) {
    win[i] = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (fftSize - 1));
  }

  const numFrames = Math.max(1, Math.floor((samples.length - fftSize) / hop) + 1);
  const mean = new Float64Array(numMel);
  const m2 = new Float64Array(numMel);
  let validFrames = 0;

  for (let f = 0; f < numFrames; f += 1) {
    const start = f * hop;
    const re = new Float32Array(fftSize);
    const im = new Float32Array(fftSize);
    let energy = 0;
    for (let i = 0; i < fftSize; i += 1) {
      const s = (samples[start + i] ?? 0) * win[i]!;
      re[i] = s;
      energy += s * s;
    }
    if (energy / fftSize < 1e-5 && numFrames > 5) continue;

    fftInPlace(re, im, false);
    const pwr = new Float32Array(bins);
    for (let k = 0; k < bins; k += 1) {
      pwr[k] = re[k]! * re[k]! + im[k]! * im[k]!;
    }

    validFrames += 1;
    for (let m = 0; m < numMel; m += 1) {
      const left = binPoints[m]!;
      const center = Math.max(left + 1, binPoints[m + 1]!);
      const right = Math.max(center + 1, binPoints[m + 2]!);
      let band = 1e-10;
      for (let k = left; k < center && k < bins; k += 1) {
        band += pwr[k]! * ((k - left) / (center - left));
      }
      for (let k = center; k < right && k < bins; k += 1) {
        band += pwr[k]! * ((right - k) / (right - center));
      }
      const logVal = Math.log(band);
      const delta = logVal - mean[m]!;
      mean[m] = mean[m]! + delta / validFrames;
      m2[m] = m2[m]! + delta * (logVal - mean[m]!);
    }
  }

  // 倒谱均值减法（CMN）去信道偏移，拼接均值 + 标准差成 64 维向量
  let globalMean = 0;
  for (let m = 0; m < numMel; m += 1) globalMean += mean[m]! / numMel;
  const feat = new Float64Array(numMel * 2);
  for (let m = 0; m < numMel; m += 1) {
    feat[m] = mean[m]! - globalMean;
    feat[numMel + m] = validFrames > 1 ? Math.sqrt(Math.max(0, m2[m]! / (validFrames - 1))) : 0;
  }
  return l2Normalize(feat);
}
