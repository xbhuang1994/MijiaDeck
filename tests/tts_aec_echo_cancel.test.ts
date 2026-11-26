// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 声学回声消除（AEC V2：样本级 GCC-PHAT 延迟估计 + 双路径 PBFDAF + Hann-OLA 相干 RES +
// 浏览器 48kHz/44.1kHz AudioWorklet + 服务端 VoiceStreamSession 兜底 AEC）综合验证测试

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AcousticEchoCanceller } from "../src/agent/echoCanceller.ts";
import { encodeWavPcm16 } from "../src/agent/audioPcm.ts";
import { LocalVoiceEngine } from "../src/agent/localVoiceEngine.ts";
import { VoiceStreamSession, decodeInt16PcmBuffer } from "../src/agent/voiceStreamSession.ts";
import { setDataPathOverrides } from "../src/core/jsonStore.ts";
import { startMijiaDeckServer, type MijiaDeckServer } from "../src/server/server.ts";

let tmpDir = "";
let activeServer: MijiaDeckServer | null = null;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "mijiadeck-aec-v2-"));
  const dir = tmpDir;
  setDataPathOverrides({ dataDir: () => dir });
});

afterEach(async () => {
  if (activeServer) {
    await activeServer.stop();
    activeServer = null;
  }
  setDataPathOverrides(null);
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = "";
  }
});

function makePrng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

function rmsOf(buf: Float32Array): number {
  if (buf.length === 0) return 0;
  let s = 0;
  for (let i = 0; i < buf.length; i += 1) {
    const v = buf[i]!;
    s += v * v;
  }
  return Math.sqrt(s / buf.length);
}

function erleDb(mic: Float32Array, out: Float32Array): number {
  const len = Math.min(mic.length, out.length);
  return 20 * Math.log10((rmsOf(mic.subarray(0, len)) + 1e-9) / (rmsOf(out.subarray(0, len)) + 1e-9));
}

/**
 * 构造逼真的语音调制测试信号（带音节包络停顿、多共振峰与辅音宽带噪声，
 * 专门暴露传统 AEC 在真实语音音节间歇与基频色散上的收敛/误判缺陷）。
 */
function makeSpeechLikeSignal(durationSec: number, sr: number, seed: number): Float32Array {
  const n = Math.round(durationSec * sr);
  const out = new Float32Array(n);
  const rand = makePrng(seed);
  let lp = 0;
  for (let i = 0; i < n; i += 1) {
    const t = i / sr;
    // 音节包络（每 ~260ms 一个音节并包含明显停顿谷值）
    const syllPhase = (t * 3.8) % 1;
    const env = syllPhase < 0.72 ? Math.sin((Math.PI * syllPhase) / 0.72) : 0.04;
    const f0 = 185 + 35 * Math.sin(2 * Math.PI * 1.4 * t);
    const voice =
      0.34 * Math.sin(2 * Math.PI * f0 * t) +
      0.24 * Math.sin(2 * Math.PI * f0 * 2.1 * t + 0.4) +
      0.16 * Math.sin(2 * Math.PI * f0 * 3.7 * t + 1.1) +
      0.1 * Math.sin(2 * Math.PI * f0 * 6.3 * t + 0.7);
    const white = (rand() * 2 - 1) * 0.28;
    lp = 0.55 * lp + 0.45 * white;
    out[i] = Math.max(-0.92, Math.min(0.92, (voice * 0.52 + lp * 0.48) * env));
  }
  return out;
}

/** 构造真实室内多径回声（直达声 + 早期反射 + 可选扬声器非线性饱和失真 + 极低底噪） */
function synthesizeRoomEcho(
  ref: Float32Array,
  sr: number,
  options: { delayMs: number; gain?: number; nonlinear?: boolean; noiseFloor?: number; tailMs?: number },
): { mic: Float32Array; ref: Float32Array } {
  const gain = options.gain ?? 0.65;
  const nonlinear = options.nonlinear === true;
  const noiseFloor = options.noiseFloor ?? 0.0008;
  const d = Math.round((options.delayMs / 1000) * sr);
  const tail = Math.round(((options.tailMs ?? 120) / 1000) * sr);
  const len = ref.length + d + tail;
  const mic = new Float32Array(len);
  const refPad = new Float32Array(len);
  refPad.set(ref, 0);
  const rand = makePrng(77112233 + Math.round(options.delayMs * 10));

  const taps: ReadonlyArray<readonly [number, number]> = [
    [d, gain],
    [d + Math.round(0.0053 * sr), -gain * 0.36],
    [d + Math.round(0.0131 * sr), gain * 0.24],
    [d + Math.round(0.0256 * sr), -gain * 0.14],
    [d + Math.round(0.045 * sr), gain * 0.08],
    [d + Math.round(0.072 * sr), -gain * 0.04],
  ];
  const tanhScale = Math.tanh(2.2);

  for (let i = 0; i < len; i += 1) {
    let v = 0;
    for (const [lag, w] of taps) {
      const idx = i - lag;
      if (idx >= 0 && idx < ref.length) {
        let s = ref[idx]!;
        if (nonlinear) {
          s = Math.tanh(s * 2.2) / tanhScale;
        }
        v += s * w;
      }
    }
    const noise = (rand() * 2 - 1) * noiseFloor;
    mic[i] = Math.max(-1, Math.min(1, v + noise));
  }
  return { mic, ref: refPad };
}

function instantiateVoiceWorkletAtRate(
  sampleRateHz: number,
  processorOptions: Record<string, unknown>,
) {
  const src = readFileSync(
    path.join(import.meta.dir, "..", "src", "web", "voiceListener.ts"),
    "utf8",
  );
  const startMarker = "const VOICE_WORKLET_CODE = `";
  const endMarker = 'registerProcessor("mijia-voice-processor", MijiaVoiceProcessor);';
  const startIdx = src.indexOf(startMarker);
  const endIdx = src.indexOf(endMarker, startIdx);
  expect(startIdx).toBeGreaterThan(-1);
  expect(endIdx).toBeGreaterThan(startIdx);

  const rawCode = src.slice(startIdx + startMarker.length, endIdx + endMarker.length);
  let RegisteredCtor: any = null;
  const posted: any[] = [];

  class FakeAudioWorkletProcessor {
    port = {
      onmessage: null as ((ev: { data: any }) => void) | null,
      postMessage: (msg: any) => {
        posted.push(msg);
      },
    };
  }

  const factory = new Function("AudioWorkletProcessor", "registerProcessor", "sampleRate", rawCode);
  factory(
    FakeAudioWorkletProcessor,
    (_name: string, ctor: any) => {
      RegisteredCtor = ctor;
    },
    sampleRateHz,
  );
  expect(RegisteredCtor).toBeTruthy();
  const instance = new RegisteredCtor({ processorOptions });
  return { instance, posted };
}

// ============================================================================
// Suite 1: AcousticEchoCanceller V2 DSP（高延迟、高增益、非线性、热启动、真双讲）
// ============================================================================

describe("AcousticEchoCanceller V2 (GCC-PHAT Delay + Two-Path PBFDAF + Hann-OLA RES)", () => {
  test("auto-locks acoustic/OS delay across 80ms, 180ms, 320ms, and 480ms (Bluetooth/WASAPI) with >= 18 dB ERLE and 0 false double-talk", () => {
    const sr = 16000;
    const speech = makeSpeechLikeSignal(3.2, sr, 202601);

    for (const delayMs of [80, 180, 320, 480]) {
      const { mic, ref } = synthesizeRoomEcho(speech, sr, { delayMs, gain: 0.65 });
      const aec = new AcousticEchoCanceller({ sampleRate: sr });
      const blocks = Math.floor(mic.length / 256);
      const out = new Float32Array(blocks * 256);
      let falseDt = 0;
      let lastRes: ReturnType<AcousticEchoCanceller["processBlock"]> | null = null;

      for (let b = 0; b < blocks; b += 1) {
        const off = b * 256;
        const r = aec.processBlock(mic.subarray(off, off + 256), ref.subarray(off, off + 256));
        out.set(r.output, off);
        if (r.doubleTalk) falseDt += 1;
        lastRes = r;
      }

      const secondHalfStart = Math.floor(out.length * 0.45);
      const steadyErle = erleDb(mic.subarray(secondHalfStart, out.length), out.subarray(secondHalfStart));
      const fullErle = erleDb(mic.subarray(0, out.length), out);

      expect(Math.abs((lastRes?.estimatedDelayMs ?? 0) - delayMs)).toBeLessThanOrEqual(6);
      expect(steadyErle).toBeGreaterThanOrEqual(24);
      // 480ms 极高冷启动延迟需先累计 ~670ms 缓冲完成首次 GCC-PHAT 锁定，故整段均值门槛按延迟分段
      expect(fullErle).toBeGreaterThanOrEqual(delayMs >= 320 ? 12 : 18);
      expect(falseDt).toBe(0);
    }
  });

  test("handles loud microphone gain (1.8x ref) and nonlinear distorted speakers without DTD deadlock", () => {
    const sr = 16000;
    const speech = makeSpeechLikeSignal(3.0, sr, 202602);

    // Case A: Loud mic gain 1.8x (previously triggered permanent DTD deadlock!)
    const loud = synthesizeRoomEcho(speech, sr, { delayMs: 110, gain: 1.8 });
    const aecLoud = new AcousticEchoCanceller({ sampleRate: sr });
    const resLoud = aecLoud.processStream(loud.mic, loud.ref);
    const loudTailStart = Math.floor(resLoud.output.length * 0.4);
    expect(erleDb(loud.mic.subarray(loudTailStart, resLoud.output.length), resLoud.output.subarray(loudTailStart)))
      .toBeGreaterThanOrEqual(22);
    expect(resLoud.doubleTalk).toBe(false);

    // Case B: Nonlinear saturated speaker (tanh distortion)
    const nonlin = synthesizeRoomEcho(speech, sr, { delayMs: 140, gain: 0.7, nonlinear: true });
    const aecNonlin = new AcousticEchoCanceller({ sampleRate: sr, aggressive: true });
    const resNonlin = aecNonlin.processStream(nonlin.mic, nonlin.ref);
    const nlTailStart = Math.floor(resNonlin.output.length * 0.4);
    expect(erleDb(nonlin.mic.subarray(nlTailStart, resNonlin.output.length), resNonlin.output.subarray(nlTailStart)))
      .toBeGreaterThanOrEqual(26);
    expect(resNonlin.doubleTalk).toBe(false);
  });

  test("retains converged room model across silence gaps so subsequent TTS replies cancel >= 28 dB from frame 0", () => {
    const sr = 16000;
    const utt1 = makeSpeechLikeSignal(2.4, sr, 202603);
    const utt2 = makeSpeechLikeSignal(1.2, sr, 202604);
    const aec = new AcousticEchoCanceller({ sampleRate: sr });

    // Utterance 1 trains room model & locks 135ms delay
    const e1 = synthesizeRoomEcho(utt1, sr, { delayMs: 135, gain: 0.65, nonlinear: true });
    aec.processStream(e1.mic, e1.ref);

    // 0.7s silence gap between utterances (farEndActive transitions true -> false cleanly)
    const silence = new Float32Array(Math.round(0.7 * sr));
    const silRes = aec.processStream(silence, silence);
    expect(rmsOf(silRes.output)).toBeLessThan(0.002);

    // Utterance 2 (short 1.2s reply) should cancel immediately with zero cold-start leak
    const e2 = synthesizeRoomEcho(utt2, sr, { delayMs: 135, gain: 0.65, nonlinear: true });
    const r2 = aec.processStream(e2.mic, e2.ref);
    const fullErle2 = erleDb(e2.mic.subarray(0, r2.output.length), r2.output);
    expect(fullErle2).toBeGreaterThanOrEqual(28);
    expect(r2.doubleTalk).toBe(false);
  });

  test("preserves near-end user speech during double-talk while suppressing pre- and post-speech TTS echo", () => {
    const sr = 16000;
    const ttsVoice = makeSpeechLikeSignal(3.8, sr, 202605);
    const userVoice = makeSpeechLikeSignal(1.2, sr, 99118822);
    const aec = new AcousticEchoCanceller({ sampleRate: sr });

    // Warm up on a brief first utterance
    const warm = synthesizeRoomEcho(makeSpeechLikeSignal(2.0, sr, 202606), sr, { delayMs: 120, gain: 0.6 });
    aec.processStream(warm.mic, warm.ref);
    const gap = new Float32Array(Math.round(0.6 * sr));
    aec.processStream(gap, gap);

    // Utterance with double-talk in the middle [1.0s .. 2.2s]
    const e = synthesizeRoomEcho(ttsVoice, sr, { delayMs: 120, gain: 0.6 });
    const mic = new Float32Array(e.mic);
    const near = new Float32Array(mic.length);
    const dtStart = Math.round(1.0 * sr);
    const dtEnd = dtStart + userVoice.length;
    for (let i = 0; i < userVoice.length && dtStart + i < mic.length; i += 1) {
      near[dtStart + i] = userVoice[i]! * 0.9;
      mic[dtStart + i] = Math.max(-1, Math.min(1, mic[dtStart + i]! + near[dtStart + i]!));
    }

    const blocks = Math.floor(mic.length / 256);
    const out = new Float32Array(blocks * 256);
    let preDtHits = 0;
    let midDtHits = 0;
    let postDtHits = 0;
    for (let b = 0; b < blocks; b += 1) {
      const off = b * 256;
      const r = aec.processBlock(mic.subarray(off, off + 256), e.ref.subarray(off, off + 256));
      out.set(r.output, off);
      if (r.doubleTalk) {
        if (off < dtStart) preDtHits += 1;
        else if (off < dtEnd) midDtHits += 1;
        else postDtHits += 1;
      }
    }

    const preErle = erleDb(mic.subarray(0, dtStart), out.subarray(0, dtStart));
    const postStart = dtEnd + Math.round(0.25 * sr);
    const postErle = erleDb(mic.subarray(postStart, out.length), out.subarray(postStart, out.length));
    const preserveRatio =
      rmsOf(out.subarray(dtStart + 512, dtEnd - 512)) / rmsOf(near.subarray(dtStart + 512, dtEnd - 512));

    expect(preDtHits).toBe(0);
    expect(midDtHits).toBeGreaterThanOrEqual(15);
    expect(postDtHits).toBeLessThanOrEqual(8); // allow brief 128ms holdover right after user stops
    expect(preErle).toBeGreaterThanOrEqual(28);
    expect(postErle).toBeGreaterThanOrEqual(24);
    expect(preserveRatio).toBeGreaterThanOrEqual(0.55);
  });

  test("re-locks automatically when speaker latency shifts mid-session (e.g., 90ms -> 340ms)", () => {
    const sr = 16000;
    const aec = new AcousticEchoCanceller({ sampleRate: sr });

    const part1 = synthesizeRoomEcho(makeSpeechLikeSignal(2.2, sr, 30301), sr, { delayMs: 90, gain: 0.6 });
    const r1 = aec.processStream(part1.mic, part1.ref);
    expect(Math.abs((r1.estimatedDelayMs ?? 0) - 90)).toBeLessThanOrEqual(6);

    const gap = new Float32Array(Math.round(0.6 * sr));
    aec.processStream(gap, gap);

    const part2 = synthesizeRoomEcho(makeSpeechLikeSignal(3.0, sr, 30302), sr, { delayMs: 340, gain: 0.6 });
    const r2 = aec.processStream(part2.mic, part2.ref);
    const tailStart = Math.floor(r2.output.length * 0.55);
    const tailErle = erleDb(part2.mic.subarray(tailStart, r2.output.length), r2.output.subarray(tailStart));
    expect(Math.abs((r2.estimatedDelayMs ?? 0) - 340)).toBeLessThanOrEqual(8);
    expect(tailErle).toBeGreaterThanOrEqual(20);
  });
});

// ============================================================================
// Suite 2: Browser AudioWorklet (48kHz / 44.1kHz Anti-Aliased Resampling + V2 AEC)
// ============================================================================

describe("Browser AudioWorklet VOICE_WORKLET_CODE (48kHz & 44.1kHz Real-Time AEC)", () => {
  for (const nativeSr of [48000, 44100] as const) {
    test(`cancels 180ms-delayed broadcast echo at ${nativeSr}Hz native sampleRate with stereo ref input (>= 20 dB ERLE)`, () => {
      const { instance, posted } = instantiateVoiceWorkletAtRate(nativeSr, {
        streamMode: true,
        fullDuplex: true,
        bargeInEnabled: true,
        echoMode: "auto",
        initialDelayMs: 60,
        vadThreshold: 0.018,
        vadSilenceMs: 1000,
      });

      const refNative = makeSpeechLikeSignal(3.0, nativeSr, 448800 + nativeSr);
      const { mic: micNative, ref: refPad } = synthesizeRoomEcho(refNative, nativeSr, {
        delayMs: 180,
        gain: 0.65,
      });

      instance.port.onmessage({ data: { type: "tts_state", active: true } });

      // Feed 128-sample WebAudio render quanta: inputs = [ input0(mic), input1(stereo ref) ]
      for (let off = 0; off + 128 <= micNative.length; off += 128) {
        const micQ = micNative.subarray(off, off + 128);
        const refQ = refPad.subarray(off, off + 128);
        instance.process([[micQ], [refQ, refQ]]);
      }

      const pcmFrames = posted.filter((m) => m.type === "pcm_frame");
      expect(pcmFrames.length).toBeGreaterThan(25);

      const decodedChunks = pcmFrames.map((f) => decodeInt16PcmBuffer(new Uint8Array(f.buffer)));
      const totalSamples = decodedChunks.reduce((acc, c) => acc + c.length, 0);
      const out16k = new Float32Array(totalSamples);
      let pos = 0;
      for (const c of decodedChunks) {
        out16k.set(c, pos);
        pos += c.length;
      }

      // Measure RMS suppression on converged second half
      const mic16kRefRms = rmsOf(micNative.subarray(Math.floor(micNative.length * 0.45)));
      const outTailRms = rmsOf(out16k.subarray(Math.floor(out16k.length * 0.45)));
      const measuredErle = 20 * Math.log10((mic16kRefRms + 1e-9) / (outTailRms + 1e-9));

      expect(measuredErle).toBeGreaterThanOrEqual(20);
      expect(posted.some((m) => m.type === "double_talk" && m.active === true)).toBe(false);
      const metrics = posted.filter((m) => m.type === "aec_metrics");
      expect(metrics.length).toBeGreaterThanOrEqual(1);
      expect(metrics[metrics.length - 1].erleDb).toBeGreaterThanOrEqual(14);
    });
  }

  test("continues suppressing trailing room echo after tts_state=false release when bargeInEnabled=false", () => {
    const { instance, posted } = instantiateVoiceWorkletAtRate(16000, {
      streamMode: true,
      fullDuplex: true,
      bargeInEnabled: false,
      echoMode: "auto",
      vadThreshold: 0.02,
      vadSilenceMs: 1000,
    });

    // TTS lasts 2.2s, room echo delayed by 160ms + 120ms reverb tail
    const refSig = makeSpeechLikeSignal(2.2, 16000, 55123);
    const { mic, ref } = synthesizeRoomEcho(refSig, 16000, { delayMs: 160, gain: 0.65, tailMs: 160 });

    // Suppose ttsActive releases early right at end of refSig (before 160ms+reverb finishes at mic!)
    instance.port.onmessage({ data: { type: "tts_state", active: true } });
    const releaseSample = refSig.length;
    for (let off = 0; off + 128 <= mic.length; off += 128) {
      if (off >= releaseSample && off - 128 < releaseSample) {
        instance.port.onmessage({ data: { type: "tts_state", active: false } });
      }
      instance.process([[mic.subarray(off, off + 128)], [ref.subarray(off, off + 128)]]);
    }

    const pcmFrames = posted.filter((m) => m.type === "pcm_frame");
    const allOut = new Float32Array(pcmFrames.length * 1024);
    pcmFrames.forEach((f, idx) => {
      allOut.set(decodeInt16PcmBuffer(new Uint8Array(f.buffer)), idx * 1024);
    });

    // Even in the post-release echo tail window, AEC trained during ttsActive cancels the echo tail!
    const tailMicRms = rmsOf(mic.subarray(releaseSample, Math.min(allOut.length, releaseSample + 3200)));
    const tailOutRms = rmsOf(allOut.subarray(releaseSample, Math.min(allOut.length, releaseSample + 3200)));
    const tailErle = 20 * Math.log10((tailMicRms + 1e-9) / (tailOutRms + 1e-9));
    expect(tailMicRms).toBeGreaterThan(0.05);
    expect(tailErle).toBeGreaterThanOrEqual(22);
  });
});

// ============================================================================
// Suite 3: Server-Side VoiceStreamSession AEC + LocalTtsEngine Cache + WS Integration
// ============================================================================

describe("Server-Side VoiceStreamSession Reference AEC & WS Integration", () => {
  test("VoiceStreamSession.pushFrameWithReference eliminates TTS broadcast echo before ring buffer & downstream ASR", () => {
    const engine = new LocalVoiceEngine({ modelsDir: path.join(tmpDir, "empty-models") });
    const telemetryEvents: Array<{ active: boolean; erleDb: number; estimatedDelayMs: number }> = [];
    const session = new VoiceStreamSession({
      localEngine: engine,
      noiseMode: "off",
      bypassWakeWord: true,
      owwEnabled: false,
      echoCancellationMode: "auto",
      clientAecActive: false,
      onAecTelemetry: (ev) => {
        telemetryEvents.push({
          active: ev.active,
          erleDb: ev.erleDb,
          estimatedDelayMs: ev.estimatedDelayMs,
        });
      },
      onSegmentReady: async () => null,
    });

    const speech = makeSpeechLikeSignal(2.6, 16000, 661122);
    const { mic, ref } = synthesizeRoomEcho(speech, 16000, { delayMs: 140, gain: 0.65 });

    // Stream 1024-sample chunks (64ms) with synchronized reference
    for (let off = 0; off + 1024 <= mic.length; off += 1024) {
      session.pushFrameWithReference(mic.subarray(off, off + 1024), ref.subarray(off, off + 1024), 16000);
    }

    expect(session.serverAecErleDb).toBeGreaterThanOrEqual(16);
    expect(Math.abs(session.serverAecEstimatedDelayMs - 140)).toBeLessThanOrEqual(8);
    expect(telemetryEvents.length).toBeGreaterThanOrEqual(1);

    // Verify the audio written into VoiceStreamSession's raw ring buffer is genuinely echo-cancelled!
    const internalRing = (session as unknown as { _rawRing: Float32Array; _rawTotalSamples: number })._rawRing;
    const totalFed = (session as unknown as { _rawTotalSamples: number })._rawTotalSamples;
    const tailLen = 16000;
    const ringTail = new Float32Array(tailLen);
    for (let i = 0; i < tailLen; i += 1) {
      ringTail[i] = internalRing[(totalFed - tailLen + i) % internalRing.length]!;
    }
    const rawMicTailRms = rmsOf(mic.subarray(totalFed - tailLen, totalFed));
    const ringTailRms = rmsOf(ringTail);
    const ringErle = 20 * Math.log10((rawMicTailRms + 1e-9) / (ringTailRms + 1e-9));
    expect(ringErle).toBeGreaterThanOrEqual(22);

    session.dispose();
    engine.dispose();
  });

  test("VoiceStreamSession.pushFarEndReference runs only when clientAecActive=false and cleanly yields when clientAecActive=true", () => {
    const engine = new LocalVoiceEngine({ modelsDir: path.join(tmpDir, "empty-models") });
    const session = new VoiceStreamSession({
      localEngine: engine,
      noiseMode: "off",
      bypassWakeWord: true,
      owwEnabled: false,
      echoCancellationMode: "auto",
      clientAecActive: false,
      onSegmentReady: async () => null,
    });

    const speech = makeSpeechLikeSignal(2.4, 16000, 773311);
    const { mic, ref } = synthesizeRoomEcho(speech, 16000, { delayMs: 120, gain: 0.6 });
    session.pushFarEndReference(ref, 16000);
    expect(session.serverAecActive).toBe(true);

    for (let off = 0; off + 1024 <= mic.length; off += 1024) {
      session.pushFloat32Samples(mic.subarray(off, off + 1024));
    }
    expect(session.serverAecErleDb).toBeGreaterThanOrEqual(15);

    // Switching clientAecActive=true clears server reference queue and prevents double-AEC
    session.setClientAecActive(true);
    session.pushFarEndReference(ref, 16000);
    expect(session.clientAecActive).toBe(true);
    expect(session.serverAecActive).toBe(false);

    session.dispose();
    engine.dispose();
  });

  test("LocalTtsEngine.getCachedPcm16k extracts 16kHz PCM from LRU cache without re-synthesis", () => {
    const engine = new LocalVoiceEngine({ modelsDir: path.join(tmpDir, "empty-models") });
    expect(engine.tts.getCachedPcm16k("未缓存文本")).toBeNull();

    // Seed LRU cache with a synthetic 16kHz WAV matching default voice/speed
    const rawSamples = new Float32Array(1600);
    for (let i = 0; i < rawSamples.length; i += 1) {
      rawSamples[i] = 0.4 * Math.sin((2 * Math.PI * 440 * i) / 16000);
    }
    const wav = encodeWavPcm16(rawSamples, 16000);
    const cache = (
      engine.tts as unknown as {
        _cache: Map<string, { wav: Uint8Array; sampleRate: number; durationSec: number; voice: string }>;
      }
    )._cache;
    cache.set("gentle-zh-en|0.98|客厅灯已打开", {
      wav,
      sampleRate: 16000,
      durationSec: 0.1,
      voice: "gentle-zh-en",
    });

    const cached = engine.tts.getCachedPcm16k("客厅灯已打开");
    expect(cached).not.toBeNull();
    expect(cached!.length).toBe(1600);
    expect(rmsOf(cached!)).toBeCloseTo(rmsOf(rawSamples), 2);
    engine.dispose();
  });

  test("WebSocket voice_stream_start propagates clientAecActive and hot config update toggles echoCancellationMode", async () => {
    activeServer = await startMijiaDeckServer({
      port: 0,
      mode: "demo",
      autoStart: true,
      autoStartTimers: false,
    });
    const wsUrl = activeServer.url.replace(/^http/, "ws") + "/ws";
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("ws failed"));
    });

    const startedPromise = new Promise<Record<string, unknown>>((resolve) => {
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(String(ev.data)) as Record<string, unknown>;
          if (msg.type === "voice_stream_event" && msg.kind === "started") {
            resolve(msg);
          }
        } catch {
          // ignore
        }
      };
    });

    ws.send(
      JSON.stringify({
        type: "voice_stream_start",
        sampleRate: 16000,
        lang: "zh-CN",
        bypassWakeWord: false,
        engine: "local",
        clientAecActive: true,
      }),
    );
    const started = await startedPromise;
    expect(started.kind).toBe("started");

    // Verify telemetry phase does not clobber active utterance text & updates ERLE cleanly
    ws.send(
      JSON.stringify({
        type: "voice_tts_state",
        speaking: true,
        phase: "start",
        utteranceId: "utt_aec_test_1",
        text: "客厅吸顶灯已打开",
        aecActive: true,
        erleDb: 28.5,
      }),
    );
    await Bun.sleep(40);
    let snap = activeServer.runtime.voiceListener!.snapshot();
    expect(snap.lanes.echo.activeAec).toBe(true);
    expect(snap.lanes.echo.erleDb).toBeCloseTo(28.5, 1);

    ws.send(
      JSON.stringify({
        type: "voice_tts_state",
        speaking: true,
        phase: "telemetry",
        utteranceId: "utt_aec_test_1",
        aecActive: true,
        erleDb: 34.2,
      }),
    );
    await Bun.sleep(40);
    snap = activeServer.runtime.voiceListener!.snapshot();
    expect(snap.lanes.echo.erleDb).toBeCloseTo(34.2, 1);
    expect(snap.lanes.speaking.text).toBe("客厅吸顶灯已打开");

    ws.close();
    await Bun.sleep(40);
  });
});
