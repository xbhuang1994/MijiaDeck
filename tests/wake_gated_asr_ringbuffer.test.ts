// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { decodeWavPcm, encodeWavPcm16 } from "../src/agent/audioPcm.ts";
import { ClearVoiceGpuRuntime } from "../src/agent/clearVoiceGpuRuntime.ts";
import { LocalVoiceEngine, type LocalAsrOutput, type StreamingVadHandleLike } from "../src/agent/localVoiceEngine.ts";
import type { OpenWakeWordStreamSession, WakeWordAcousticHit } from "../src/agent/openWakeWordEngine.ts";
import { PiAgentService } from "../src/agent/piAgentService.ts";
import { VoiceListenerController, type ProcessAudioUploadResult } from "../src/agent/voiceListenerController.ts";
import { VoiceStreamSession, type VoiceStreamSegmentPayload } from "../src/agent/voiceStreamSession.ts";
import { addWakeWordPrototype } from "../src/agent/wakewordPrototypeStore.ts";
import { defaultAgentVoiceConfig, normalizeAgentVoiceConfig } from "../src/core/agentConfigStore.ts";
import { NetworkMonitor } from "../src/core/availability.ts";
import { JobExecutor } from "../src/core/jobs.ts";
import { setDataPathOverrides } from "../src/core/jsonStore.ts";
import * as settingsStore from "../src/core/settingsStore.ts";
import { VirtualDemoService } from "../src/core/virtualLightService.ts";
import { startMijiaDeckServer, type MijiaDeckServer } from "../src/server/server.ts";
import { MainWindowController } from "../src/ui/controllers/mainWindowController.ts";
import { ThemeController, applyTheme } from "../src/ui/theme.ts";

const SR = 16000;
const BENCH_AUDIO_DIR = path.resolve(import.meta.dir, "..", "benchmarks", "voice_sep_100", "audio");
const HAS_BENCH_WAVS = existsSync(path.join(BENCH_AUDIO_DIR, "clip_001.wav"));

let tempDir: string | null = null;
let mockCvServer: ReturnType<typeof Bun.serve> | null = null;
let runningServer: MijiaDeckServer | null = null;

function useTempDataDir(): string {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "mijiadeck-wake-gate-"));
  const dir = tempDir;
  setDataPathOverrides({ dataDir: () => dir });
  return dir;
}

afterEach(async () => {
  if (runningServer) {
    await runningServer.stop();
    runningServer = null;
  }
  if (mockCvServer) {
    mockCvServer.stop(true);
    mockCvServer = null;
  }
  setDataPathOverrides(null);
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

function makeSine(durationSec: number, freqHz = 440, amp = 0.25, sr = SR): Float32Array {
  const len = Math.round(sr * durationSec);
  const out = new Float32Array(len);
  for (let i = 0; i < len; i += 1) {
    out[i] = Math.sin((2 * Math.PI * freqHz * i) / sr) * amp;
  }
  return out;
}

function makeConstant(durationSec: number, value: number, sr = SR): Float32Array {
  const out = new Float32Array(Math.round(sr * durationSec));
  out.fill(value);
  return out;
}

function makeSilence(durationSec: number, sr = SR): Float32Array {
  return new Float32Array(Math.round(sr * durationSec));
}

function pushChunked(session: VoiceStreamSession, samples: Float32Array, chunkSize = 1024): void {
  for (let off = 0; off < samples.length; off += chunkSize) {
    session.pushFloat32Samples(samples.subarray(off, Math.min(samples.length, off + chunkSize)));
  }
}

/**
 * 确定性能量门控模拟 Silero VAD，同时支持 legacy（pop 出段）与 ClearVoice（帧级 isDetected）。
 */
function createEnergyMockVad(threshold = 0.02, silenceFramesToEnd = 10): StreamingVadHandleLike {
  let detected = false;
  let totalFed = 0;
  let segStart = -1;
  let silenceFrames = 0;
  let activeChunks: Float32Array[] = [];
  const emitted: Array<{ samples: Float32Array; start: number }> = [];

  const finalizeSegment = () => {
    if (segStart < 0 || activeChunks.length === 0) return;
    const total = activeChunks.reduce((acc, c) => acc + c.length, 0);
    const merged = new Float32Array(total);
    let off = 0;
    for (const c of activeChunks) {
      merged.set(c, off);
      off += c.length;
    }
    emitted.push({ samples: merged, start: segStart });
    segStart = -1;
    activeChunks = [];
  };

  return {
    acceptWaveform(samples: Float32Array) {
      let sum = 0;
      for (let i = 0; i < samples.length; i += 1) sum += samples[i]! * samples[i]!;
      const rms = Math.sqrt(sum / Math.max(1, samples.length));
      const isVoice = rms >= threshold;
      if (isVoice) {
        if (!detected) {
          segStart = totalFed;
          activeChunks = [];
        }
        detected = true;
        silenceFrames = 0;
        activeChunks.push(new Float32Array(samples));
      } else if (detected) {
        silenceFrames += 1;
        activeChunks.push(new Float32Array(samples));
        if (silenceFrames >= silenceFramesToEnd) {
          detected = false;
          silenceFrames = 0;
          finalizeSegment();
        }
      }
      totalFed += samples.length;
    },
    isDetected: () => detected,
    isEmpty: () => emitted.length === 0,
    front: () => emitted[0] ?? { samples: new Float32Array(0), start: 0 },
    pop: () => {
      emitted.shift();
    },
    flush: () => {
      if (detected) {
        detected = false;
        silenceFrames = 0;
        finalizeSegment();
      }
    },
    clear: () => {
      emitted.length = 0;
    },
    reset: () => {
      emitted.length = 0;
      detected = false;
      segStart = -1;
      silenceFrames = 0;
      activeChunks = [];
      totalFed = 0;
    },
  };
}

interface MockOwwController {
  readonly pushedSamples: number[];
  hasActivePrototypes: boolean;
  triggerAtGlobalSample: number | null;
  triggerWord: string;
  fireSpotNow: (sampleOffset?: number, wakeWord?: string) => void;
  sessionFactory: (
    wakeWords: string[],
    opts: { threshold?: number; onSpot?: (hit: WakeWordAcousticHit) => void },
  ) => OpenWakeWordStreamSession;
}

function createMockOwwController(initialActive = true): MockOwwController {
  const pushedSamples: number[] = [];
  let onSpotCb: ((hit: WakeWordAcousticHit) => void) | undefined;
  let lastGlobalEnd = 0;
  let triggeredOnce = false;

  const ctrl: MockOwwController = {
    pushedSamples,
    hasActivePrototypes: initialActive,
    triggerAtGlobalSample: null,
    triggerWord: "Neo",
    fireSpotNow(sampleOffset?: number, wakeWord?: string) {
      const hit: WakeWordAcousticHit = {
        wakeWord: wakeWord ?? ctrl.triggerWord,
        score: 0.91,
        rawScore: 0.91,
        threshold: 0.65,
        matched: true,
        source: "enrolled",
        frameIndex: 1,
        sampleOffset: sampleOffset ?? lastGlobalEnd,
        latencyMs: 6,
      };
      onSpotCb?.(hit);
    },
    sessionFactory(_wakeWords, opts) {
      onSpotCb = opts.onSpot;
      const mockSession = {
        get hasActivePrototypes() {
          return ctrl.hasActivePrototypes;
        },
        pushSamples(samples: Float32Array, globalEndSample?: number) {
          pushedSamples.push(samples.length);
          lastGlobalEnd = globalEndSample ?? lastGlobalEnd + samples.length;
          if (
            ctrl.hasActivePrototypes &&
            ctrl.triggerAtGlobalSample !== null &&
            !triggeredOnce &&
            lastGlobalEnd >= ctrl.triggerAtGlobalSample
          ) {
            triggeredOnce = true;
            const hit: WakeWordAcousticHit = {
              wakeWord: ctrl.triggerWord,
              score: 0.92,
              rawScore: 0.92,
              threshold: opts.threshold ?? 0.65,
              matched: true,
              source: "enrolled",
              frameIndex: 1,
              sampleOffset: lastGlobalEnd,
              latencyMs: 5,
            };
            onSpotCb?.(hit);
            return hit;
          }
          return null;
        },
        updateConfig() {},
        reloadPrototypes() {},
        setThreshold() {},
        getHeadPeakHit() {
          return null;
        },
        getPeakHit() {
          return null;
        },
        getSegmentPeakHit() {
          return null;
        },
        resetSegmentTracking() {},
        reset() {
          triggeredOnce = false;
        },
      };
      return mockSession as unknown as OpenWakeWordStreamSession;
    },
  };
  return ctrl;
}

function startMockClearVoiceServer() {
  const receivedSlices: Float32Array[] = [];
  const srv = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/health") {
        return Response.json({
          status: "ok",
          upstreams: {
            clearvoice: {
              status: "ok",
              details: {
                status: "ok",
                gpu_name: "Mock Online GPU",
                loaded_models: [{ name: "MossFormer2_SE_48K", task: "speech_enhancement" }],
              },
            },
          },
        });
      }
      if (u.pathname === "/clearvoice/v1/enhance") {
        const form = await req.formData();
        const file = form.get("file") as Blob;
        const decoded = decodeWavPcm(new Uint8Array(await file.arrayBuffer()));
        receivedSlices.push(new Float32Array(decoded.samples));
        // 原样返回（乘 0.9 便于区分降噪前后且保持每个样点标记值可精确断言）
        const out = new Float32Array(decoded.samples.length);
        for (let i = 0; i < decoded.samples.length; i += 1) {
          out[i] = decoded.samples[i]! * 0.9;
        }
        const wav = encodeWavPcm16(out, decoded.sampleRate);
        return new Response(new Uint8Array(wav), {
          status: 200,
          headers: {
            "Content-Type": "audio/wav",
            "X-ClearVoice-Model": "MossFormer2_SE_48K",
            "X-Elapsed-Ms": "12.0",
          },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  mockCvServer = srv;
  return { server: srv, receivedSlices };
}

function createFakeLocalEngine(opts: {
  owwCtrl?: MockOwwController | null;
  cvRuntime?: ClearVoiceGpuRuntime;
  vadThreshold?: number;
  transcribeFn?: (samples: Float32Array, signal?: AbortSignal) => Promise<LocalAsrOutput>;
}) {
  const asrCalls: Array<{ sampleCount: number; aborted: boolean }> = [];
  const fakeEngine = {
    createOnlineDenoiser: () => null,
    createStreamingVad: (vOpts?: { minSilenceDuration?: number }) => {
      const silenceFrames =
        typeof vOpts?.minSilenceDuration === "number"
          ? Math.max(1, Math.round(vOpts.minSilenceDuration / 0.032))
          : 8;
      return createEnergyMockVad(opts.vadThreshold ?? 0.02, silenceFrames);
    },
    createWakeWordStream: (
      wakeWords: string[],
      wOpts: { threshold?: number; onSpot?: (hit: WakeWordAcousticHit) => void },
    ) => (opts.owwCtrl ? opts.owwCtrl.sessionFactory(wakeWords, wOpts) : null),
    clearVoiceGpu: opts.cvRuntime,
    getStatus: () => ({
      readyForLocalAsr: true,
      activeQwen3Device: "remote",
      readyForClearVoiceGpu: Boolean(opts.cvRuntime),
      clearVoice: opts.cvRuntime?.getStatus(),
    }),
    denoise: (s: Float32Array) => ({
      samples: new Float32Array(s),
      sampleRate: SR,
      engine: "dsp" as const,
      inputSnrDb: 10,
      outputSnrDb: 15,
      snrGainDb: 5,
      durationMs: 1,
    }),
    transcribeLocal: async (
      samples: Float32Array,
      _sr?: number,
      _lang?: string,
      tOpts?: { signal?: AbortSignal },
    ): Promise<LocalAsrOutput> => {
      const rec = { sampleCount: samples.length, aborted: Boolean(tOpts?.signal?.aborted) };
      asrCalls.push(rec);
      if (tOpts?.signal) {
        tOpts.signal.addEventListener("abort", () => {
          rec.aborted = true;
        });
      }
      if (opts.transcribeFn) {
        return opts.transcribeFn(samples, tOpts?.signal);
      }
      return {
        text: "Neo，打开客厅吸顶灯",
        rawText: "Neo，打开客厅吸顶灯",
        lang: "zh",
        emotion: "",
        event: "",
        engine: "qwen3-asr-remote",
        durationMs: 40,
        computeDevice: "remote",
      };
    },
  } as unknown as LocalVoiceEngine;

  return { fakeEngine, asrCalls };
}

describe("未唤醒门控待机（零实时转写 + 循环录制缓冲区持续工作）", () => {
  test("legacy 模式未唤醒时：仅写入循环录制缓冲区并运行声学唤醒检测，绝不触发实时转写、分段 ASR 或收音 UI 闪烁", async () => {
    const owwCtrl = createMockOwwController(true);
    const { fakeEngine, asrCalls } = createFakeLocalEngine({ owwCtrl });

    const segments: VoiceStreamSegmentPayload[] = [];
    const partials: string[] = [];
    const speechActivities: boolean[] = [];

    const session = new VoiceStreamSession({
      localEngine: fakeEngine,
      noiseMode: "auto",
      voicePipelineMode: "legacy",
      wakeWords: ["Neo"],
      wakeWordEnabled: true,
      owwEnabled: true,
      streamingAsrEnabled: true,
      onPartialTranscript: (p) => partials.push(p.text),
      onSpeechActivity: (speaking) => speechActivities.push(speaking),
      onSegmentReady: async (seg) => {
        segments.push(seg);
        return null;
      },
    });

    expect(session.isAwake).toBe(false);
    expect(session.isWakeGatedStandby).toBe(true);

    // 连续输入 2.5 秒人声 + 1.4 秒静音（未说唤醒词）
    const speech = makeSine(2.5, 440, 0.25);
    const silence = makeSilence(1.4);
    pushChunked(session, speech);
    pushChunked(session, silence);

    // 即使主动 flush，未唤醒待机期也不应吐出环境音给 ASR
    await session.flush();
    await session.waitForIdle();

    expect(session.ringBufferedSamples).toBe(speech.length + silence.length);
    expect(owwCtrl.pushedSamples.reduce((a, b) => a + b, 0)).toBe(speech.length + silence.length);
    expect(asrCalls.length).toBe(0);
    expect(partials.length).toBe(0);
    expect(segments.length).toBe(0);
    expect(speechActivities.length).toBe(0);

    session.dispose();
  });

  test("clearvoice 模式未唤醒时：写入循环录制缓冲区 + 跑 openWakeWord，但零 ClearVoice GPU 请求、零转写、零分段", async () => {
    const dir = useTempDataDir();
    const { server, receivedSlices } = startMockClearVoiceServer();
    const cvRuntime = new ClearVoiceGpuRuntime({
      serviceUrl: `http://127.0.0.1:${server.port}`,
    });
    const owwCtrl = createMockOwwController(true);
    const { fakeEngine, asrCalls } = createFakeLocalEngine({ owwCtrl, cvRuntime });

    const segments: VoiceStreamSegmentPayload[] = [];
    const partials: string[] = [];
    const speechActivities: boolean[] = [];

    const session = new VoiceStreamSession({
      localEngine: fakeEngine,
      noiseMode: "auto",
      voicePipelineMode: "clearvoice",
      wakeWords: ["Neo"],
      wakeWordEnabled: true,
      owwEnabled: true,
      streamingAsrEnabled: true,
      onPartialTranscript: (p) => partials.push(p.text),
      onSpeechActivity: (speaking) => speechActivities.push(speaking),
      onSegmentReady: async (seg) => {
        segments.push(seg);
        return null;
      },
    });

    expect(session.isAwake).toBe(false);
    expect(session.isWakeGatedStandby).toBe(true);

    const speech = makeSine(3.0, 500, 0.28);
    const silence = makeSilence(1.5);
    pushChunked(session, speech);
    pushChunked(session, silence);
    await session.flush();
    await session.waitForIdle();

    expect(session.ringBufferedSamples).toBe(speech.length + silence.length);
    expect(owwCtrl.pushedSamples.reduce((a, b) => a + b, 0)).toBe(speech.length + silence.length);
    expect(receivedSlices.length).toBe(0);
    expect(asrCalls.length).toBe(0);
    expect(partials.length).toBe(0);
    expect(segments.length).toBe(0);
    expect(speechActivities.length).toBe(0);

    session.dispose();
  });
});

describe("唤醒后回放循环录制缓冲区 + 无缝衔接后续音频", () => {
  test("legacy 模式：声学唤醒瞬间立刻转写循环录制缓冲区中的预录音频，并完整拼接后续音频交付，二次唤醒不重复回放上一句", async () => {
    const owwCtrl = createMockOwwController(true);
    const { fakeEngine, asrCalls } = createFakeLocalEngine({ owwCtrl });

    const segments: VoiceStreamSegmentPayload[] = [];
    const partials: string[] = [];
    const wakeSpots: WakeWordAcousticHit[] = [];

    const session = new VoiceStreamSession({
      localEngine: fakeEngine,
      noiseMode: "off",
      voicePipelineMode: "legacy",
      vadSilenceMs: 600,
      wakeWords: ["Neo"],
      wakeWordEnabled: true,
      wakeRingLookbackMs: 1200,
      owwEnabled: true,
      streamingAsrEnabled: true,
      onWakeWordSpot: (hit) => wakeSpots.push(hit),
      onPartialTranscript: (p) => partials.push(p.text),
      onSegmentReady: async (seg) => {
        segments.push(seg);
        return null;
      },
    });

    // 1. 先录 1.2s 背景噪声 + 0.8s 唤醒前预录音频（特征幅值 0.33）
    const bg = makeConstant(1.2, 0.004);
    const preWake = makeConstant(0.8, 0.33);
    const wakeTriggerSample = bg.length + preWake.length;
    owwCtrl.triggerAtGlobalSample = wakeTriggerSample;

    pushChunked(session, bg);
    expect(asrCalls.length).toBe(0);
    expect(segments.length).toBe(0);

    // 喂入唤醒词音频 -> 末尾触发声学唤醒
    pushChunked(session, preWake);
    await Bun.sleep(20);

    expect(wakeSpots.length).toBe(1);
    expect(session.isAwake).toBe(true);
    // 唤醒后立即对循环录制缓冲区中的预录音频触发流式转写
    expect(asrCalls.length).toBeGreaterThanOrEqual(1);
    expect(partials.length).toBeGreaterThanOrEqual(1);

    // 2. 紧接唤醒词继续说后续指令（特征幅值 0.61）+ 尾静音收句
    const postWake = makeConstant(0.9, 0.61);
    const tailSilence = makeSilence(1.0);
    pushChunked(session, postWake);
    pushChunked(session, tailSilence);
    await session.waitForIdle();

    expect(segments.length).toBe(1);
    const seg1 = segments[0]!;
    expect(seg1.wakeAnchored).toBe(true);
    expect(seg1.acousticWake?.wakeWord).toBe("Neo");

    // 校验同一段内同时包含“唤醒前循环录制缓冲区音频（0.33）”和“唤醒后后续音频（0.61）”且按严格先后顺序拼接
    const preIdx = seg1.rawSamples.findIndex((v) => Math.abs(v - 0.33) < 0.02);
    const postIdx = seg1.rawSamples.findIndex((v) => Math.abs(v - 0.61) < 0.02);
    expect(preIdx).toBeGreaterThanOrEqual(0);
    expect(postIdx).toBeGreaterThan(preIdx);
    // 唤醒前 0.8s（12800 samples）全部保留
    let preCount = 0;
    let postCount = 0;
    for (let i = 0; i < seg1.rawSamples.length; i += 1) {
      const v = seg1.rawSamples[i]!;
      if (Math.abs(v - 0.33) < 0.02) preCount += 1;
      if (Math.abs(v - 0.61) < 0.02) postCount += 1;
    }
    expect(preCount).toBe(preWake.length);
    expect(postCount).toBe(postWake.length);

    // 3. 回归待机后再输入 0.5s 第二句唤醒前音频（特征幅值 0.44）并通过 triggerWake 唤醒，验证不会重复回放上一句（0.61）
    const secondPre = makeConstant(0.5, 0.44);
    const secondPost = makeConstant(0.6, 0.72);
    pushChunked(session, secondPre);
    session.triggerWake({ replayMs: 1800 });
    pushChunked(session, secondPost);
    pushChunked(session, makeSilence(1.0));
    await session.waitForIdle();

    expect(segments.length).toBe(2);
    const seg2 = segments[1]!;
    expect(seg2.wakeAnchored).toBe(true);
    // 不得重新夹带上一句的 0.61 音频
    const leakedFromSeg1 = seg2.rawSamples.some((v) => Math.abs(v - 0.61) < 0.02);
    expect(leakedFromSeg1).toBe(false);
    expect(seg2.rawSamples.some((v) => Math.abs(v - 0.44) < 0.02)).toBe(true);
    expect(seg2.rawSamples.some((v) => Math.abs(v - 0.72) < 0.02)).toBe(true);

    session.dispose();
  });

  test("clearvoice 模式：唤醒前零 GPU 降噪/零 ASR，唤醒后注入 0.3s lookback 并无缝回放缓冲区 + 后续音频（零重复帧）", async () => {
    const dir = useTempDataDir();
    const { server, receivedSlices } = startMockClearVoiceServer();
    const cvRuntime = new ClearVoiceGpuRuntime({
      serviceUrl: `http://127.0.0.1:${server.port}`,
    });
    const owwCtrl = createMockOwwController(true);
    const { fakeEngine, asrCalls } = createFakeLocalEngine({ owwCtrl, cvRuntime });

    const segments: VoiceStreamSegmentPayload[] = [];
    const partials: string[] = [];

    const session = new VoiceStreamSession({
      localEngine: fakeEngine,
      noiseMode: "off",
      voicePipelineMode: "clearvoice",
      clearVoiceSilenceMs: 256,
      clearVoiceUtteranceSilenceMs: 700,
      clearVoiceMaxChunkMs: 1800,
      clearVoiceLookbackMs: 300,
      wakeRingLookbackMs: 1000,
      wakeWords: ["Neo"],
      wakeWordEnabled: true,
      owwEnabled: true,
      streamingAsrEnabled: true,
      onPartialTranscript: (p) => partials.push(p.text),
      onSegmentReady: async (seg) => {
        segments.push(seg);
        return null;
      },
    });

    // 1. 先在待机状态下录制 1.2s 背景（特征值 0.05，作为 pre-context 观察）+ 0.7s 唤醒前音频（特征值 0.31）
    //    将唤醒触发点设在 preWake 末尾
    const bgPre = makeConstant(1.2, 0.005);
    const preWake = makeConstant(0.7, 0.31);
    owwCtrl.triggerAtGlobalSample = bgPre.length + preWake.length;

    pushChunked(session, bgPre, 1024);
    expect(receivedSlices.length).toBe(0);
    expect(asrCalls.length).toBe(0);

    // 喂入唤醒词音频（未达末尾前零 GPU；到达末尾触发声学唤醒并回放环形缓冲）
    pushChunked(session, preWake, 1024);
    expect(session.isAwake).toBe(true);

    // 2. 紧接唤醒词继续说 1.6s 后续指令（特征值 0.57，总活跃语音 > 1.8s 会先触发 timeout 增量切片并刷流式预览）+ 0.9s 静音收句
    const postWake = makeConstant(1.6, 0.57);
    const tailSilence = makeSilence(0.95);
    pushChunked(session, postWake, 1024);
    pushChunked(session, tailSilence, 1024);
    await session.waitForIdle();

    expect(receivedSlices.length).toBeGreaterThanOrEqual(2);
    // 第 1 个切片送入 GPU 时已前置拼接 0.3s 历史上下文（4800 samples）
    expect(receivedSlices[0]!.length).toBeGreaterThan(Math.round(SR * 0.3));
    // 唤醒后实时流式字幕预览已工作
    expect(partials.length).toBeGreaterThanOrEqual(1);
    expect(asrCalls.length).toBeGreaterThanOrEqual(1);

    expect(segments.length).toBe(1);
    const seg = segments[0]!;
    expect(seg.pipelineMode).toBe("clearvoice");
    expect(seg.wakeAnchored).toBe(true);
    expect(seg.acousticWake?.wakeWord).toBe("Neo");
    expect(seg.denoisedSamples.length).toBe(seg.rawSamples.length);

    // 精确计数校验：
    // - preWake（0.31）与 postWake（0.57）均完整存在且绝无唤醒帧重复喂入！
    let preCount = 0;
    let postCount = 0;
    for (let i = 0; i < seg.rawSamples.length; i += 1) {
      const v = seg.rawSamples[i]!;
      if (Math.abs(v - 0.31) < 0.015) preCount += 1;
      if (Math.abs(v - 0.57) < 0.015) postCount += 1;
    }
    expect(preCount).toBe(preWake.length);
    expect(postCount).toBe(postWake.length);

    session.dispose();
  });

  test("clearvoice 模式轻声仅说唤醒词（VAD 未翻转）也能通过 ensureUtteranceActive 完整降噪并交付唤醒段", async () => {
    const dir = useTempDataDir();
    const { server, receivedSlices } = startMockClearVoiceServer();
    const cvRuntime = new ClearVoiceGpuRuntime({
      serviceUrl: `http://127.0.0.1:${server.port}`,
    });
    const owwCtrl = createMockOwwController(true);
    // 将能量 VAD 阈值设高（0.08），模拟轻声呼唤“Neo”幅值 0.03 未翻起 Silero VAD 的场景
    const { fakeEngine } = createFakeLocalEngine({ owwCtrl, cvRuntime, vadThreshold: 0.08 });

    const segments: VoiceStreamSegmentPayload[] = [];
    const session = new VoiceStreamSession({
      localEngine: fakeEngine,
      noiseMode: "off",
      voicePipelineMode: "clearvoice",
      clearVoiceSilenceMs: 256,
      clearVoiceUtteranceSilenceMs: 600,
      wakeRingLookbackMs: 900,
      wakeWords: ["Neo"],
      wakeWordEnabled: true,
      owwEnabled: true,
      onSegmentReady: async (seg) => {
        segments.push(seg);
        return null;
      },
    });

    const softWake = makeConstant(0.8, 0.03);
    owwCtrl.triggerAtGlobalSample = softWake.length;
    pushChunked(session, softWake, 1024);
    pushChunked(session, makeSilence(0.85), 1024);
    await session.waitForIdle();

    expect(receivedSlices.length).toBeGreaterThanOrEqual(1);
    expect(segments.length).toBe(1);
    expect(segments[0]!.wakeAnchored).toBe(true);
    expect(segments[0]!.acousticWake?.wakeWord).toBe("Neo");

    session.dispose();
  });
});

describe("连续对话续说、异步间隙回放、退出对话回归零 ASR 及热配置降级", () => {
  test("clearvoice 模式：唤醒段异步识别期间的续说音频先暂存缓冲区，切入连续对话后无缝回放，退出对话立即恢复零 ASR 待机", async () => {
    const dir = useTempDataDir();
    const { server, receivedSlices } = startMockClearVoiceServer();
    const cvRuntime = new ClearVoiceGpuRuntime({
      serviceUrl: `http://127.0.0.1:${server.port}`,
    });
    const owwCtrl = createMockOwwController(true);
    const { fakeEngine, asrCalls } = createFakeLocalEngine({ owwCtrl, cvRuntime });

    let inConversation = false;
    const segments: VoiceStreamSegmentPayload[] = [];
    let releaseSeg1!: () => void;
    const seg1Started = new Promise<void>((resolve) => {
      releaseSeg1 = resolve;
    });
    let allowSeg1Finish!: () => void;
    const seg1Gate = new Promise<void>((resolve) => {
      allowSeg1Finish = resolve;
    });

    const session = new VoiceStreamSession({
      localEngine: fakeEngine,
      noiseMode: "off",
      voicePipelineMode: "clearvoice",
      clearVoiceSilenceMs: 256,
      clearVoiceUtteranceSilenceMs: 600,
      wakeRingLookbackMs: 900,
      wakeWords: ["Neo"],
      wakeWordEnabled: true,
      owwEnabled: true,
      streamingAsrEnabled: true,
      isInConversation: () => inConversation,
      onSegmentReady: async (seg) => {
        segments.push(seg);
        if (segments.length === 1) {
          releaseSeg1();
          await seg1Gate;
          inConversation = true;
          session.syncDialogState(true, "command_dispatched_async");
          return { matched: true } as unknown as ProcessAudioUploadResult;
        }
        return { matched: true } as unknown as ProcessAudioUploadResult;
      },
    });

    // Utterance 1：声学唤醒 -> 交付段 1（此时故意挂起 onSegmentReady 模拟异步 Qwen3-ASR 耗时）
    const utt1 = makeConstant(0.8, 0.35);
    owwCtrl.triggerAtGlobalSample = utt1.length;
    pushChunked(session, utt1, 1024);
    pushChunked(session, makeSilence(0.8), 1024);
    await seg1Started;

    const slicesAfterUtt1 = receivedSlices.length;
    // 在段 1 异步识别期间，用户立刻开口续说（特征值 0.49）——此时仍未进入连续对话，不应提前发 GPU 切片
    const gapFollowUp = makeConstant(0.4, 0.49);
    pushChunked(session, gapFollowUp, 1024);
    expect(receivedSlices.length).toBe(slicesAfterUtt1);

    // 放行段 1 -> 进入连续对话 -> 自动回放 gapFollowUp -> 继续说尾段（特征值 0.63）+ 静音收句
    allowSeg1Finish();
    await Bun.sleep(25);
    const tailFollowUp = makeConstant(0.5, 0.63);
    pushChunked(session, tailFollowUp, 1024);
    pushChunked(session, makeSilence(0.8), 1024);
    await session.waitForIdle();

    expect(segments.length).toBe(2);
    const seg2 = segments[1]!;
    expect(seg2.wakeAnchored).toBe(false);
    // 异步识别间隙里说的 0.49 续说首字与后续 0.63 完整衔接，无首字丢失
    expect(seg2.rawSamples.some((v) => Math.abs(v - 0.49) < 0.02)).toBe(true);
    expect(seg2.rawSamples.some((v) => Math.abs(v - 0.63) < 0.02)).toBe(true);

    // 退出连续对话 -> 立即回归零 ASR / 零 GPU 待机
    inConversation = false;
    session.syncDialogState(false, "timeout");
    expect(session.isWakeGatedStandby).toBe(true);

    const slicesBeforeStandby = receivedSlices.length;
    const asrBeforeStandby = asrCalls.length;
    pushChunked(session, makeSine(2.0, 440, 0.28), 1024);
    pushChunked(session, makeSilence(1.0), 1024);
    await session.flush();
    await session.waitForIdle();

    expect(receivedSlices.length).toBe(slicesBeforeStandby);
    expect(asrCalls.length).toBe(asrBeforeStandby);
    expect(segments.length).toBe(2);

    session.dispose();
  });

  test("legacy 模式：退出对话时立即中止在途实时流式转写（AbortSignal），后续回归零 ASR 待机", async () => {
    const owwCtrl = createMockOwwController(true);
    let inConversation = true;
    let observedAbort = false;

    const { fakeEngine, asrCalls } = createFakeLocalEngine({
      owwCtrl,
      transcribeFn: async (_samples, signal) => {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 400);
          signal?.addEventListener("abort", () => {
            observedAbort = true;
            clearTimeout(t);
            resolve();
          });
        });
        return {
          text: "不应该出现在待机后的延迟字幕",
          rawText: "不应该出现在待机后的延迟字幕",
          lang: "zh",
          emotion: "",
          event: "",
          engine: "qwen3-asr-remote",
          durationMs: 400,
          computeDevice: "remote",
        };
      },
    });

    const partials: string[] = [];
    const segments: VoiceStreamSegmentPayload[] = [];
    const session = new VoiceStreamSession({
      localEngine: fakeEngine,
      noiseMode: "off",
      voicePipelineMode: "legacy",
      wakeWords: ["Neo"],
      wakeWordEnabled: true,
      owwEnabled: true,
      streamingAsrEnabled: true,
      isInConversation: () => inConversation,
      onPartialTranscript: (p) => partials.push(p.text),
      onSegmentReady: async (seg) => {
        segments.push(seg);
        return null;
      },
    });

    // 在连续对话态喂入 1.2s 语音以发起在途实时流式转写
    pushChunked(session, makeSine(1.2, 440, 0.25), 1024);
    await Bun.sleep(20);
    expect(asrCalls.length).toBeGreaterThanOrEqual(1);

    // 立刻退出对话回归待机 -> 必须中止在途流式转写且不产生过期字幕/分段
    inConversation = false;
    session.syncDialogState(false, "user_exit");
    await Bun.sleep(30);
    expect(observedAbort).toBe(true);
    expect(partials.length).toBe(0);

    // 回归待机后再说 2.0s 语音 + 1.0s 静音 -> 零新增 ASR、零分段
    const asrAfterExit = asrCalls.length;
    pushChunked(session, makeSine(2.0, 440, 0.25), 1024);
    pushChunked(session, makeSilence(1.0), 1024);
    await session.flush();
    await session.waitForIdle();
    expect(asrCalls.length).toBe(asrAfterExit);
    expect(segments.length).toBe(0);

    session.dispose();
  });

  test("热切换开关与无 openWakeWord 兜底降级：无 OWW 时仍禁用未唤醒实时流式预览，同时保留句末离线转写兜底不失聪", async () => {
    // 1. 无 OWW 原型场景（owwCtrl.hasActivePrototypes = false）
    const owwNoProto = createMockOwwController(false);
    const { fakeEngine, asrCalls } = createFakeLocalEngine({ owwCtrl: owwNoProto });
    const partials: string[] = [];
    const segments: VoiceStreamSegmentPayload[] = [];

    const session = new VoiceStreamSession({
      localEngine: fakeEngine,
      noiseMode: "off",
      voicePipelineMode: "legacy",
      vadSilenceMs: 450,
      wakeWords: ["Neo"],
      wakeWordEnabled: true,
      owwEnabled: true,
      streamingAsrEnabled: true,
      onPartialTranscript: (p) => partials.push(p.text),
      onSegmentReady: async (seg) => {
        segments.push(seg);
        return null;
      },
    });

    expect(session.isAwake).toBe(false);
    // 没有可用声学原型时，不进入纯待机锁死（避免无唤醒原型导致完全无法语音唤醒），但实时流式转写预览必须关闭！
    expect(session.isWakeGatedStandby).toBe(false);

    pushChunked(session, makeSine(1.5, 440, 0.25), 1024);
    await Bun.sleep(20);
    // 句中实时流式预览转写仍保持 0 次！
    expect(asrCalls.length).toBe(0);
    expect(partials.length).toBe(0);

    // 句末静音仍正常吐出整段交由后端做唤醒词判定兜底
    pushChunked(session, makeSilence(0.8), 1024);
    await session.waitForIdle();
    expect(segments.length).toBe(1);
    expect(partials.length).toBe(0);

    // 2. 开启活跃 OWW 原型后，热关/热开 wakeWordEnabled 立即生效
    owwNoProto.hasActivePrototypes = true;
    expect(session.isWakeGatedStandby).toBe(true);

    session.setWakeWordEnabled(false);
    expect(session.isAwake).toBe(true);
    expect(session.isWakeGatedStandby).toBe(false);

    session.setWakeWordEnabled(true);
    expect(session.isAwake).toBe(false);
    expect(session.isWakeGatedStandby).toBe(true);

    // 3. 热关闭 owwEnabled 后，不再处于声学门控待机（允许句末兜底）
    session.setOwwEnabled(false);
    expect(session.isWakeGatedStandby).toBe(false);

    session.dispose();
  });
});

describe("HTTP /api/voice/audio 兜底上传门控与 WebSocket /ws 端到端集成", () => {
  test("VoiceListenerController.processAudioUpload 未唤醒且 OWW 就绪未命中时跳过 ClearVoice/ASR，命中或对话态正常转写", async () => {
    useTempDataDir();
    applyTheme("dark", "green");
    // 写入 1 条唤醒词原型，使 getPrototypesForWords(["Neo"]) 非空
    addWakeWordPrototype({
      wakeWord: "Neo",
      source: "enrolled",
      voiceTag: "test-user",
      embeddings: [Array.from({ length: 96 }, () => 0.1)],
    });

    const demo = new VirtualDemoService();
    const jobs = new JobExecutor();
    const networkMonitor = new NetworkMonitor({ initialReachability: "online", autoStart: false });
    const themeCtrl = new ThemeController("dark");
    const mw = new MainWindowController({
      service: demo,
      jobs,
      themeCtrl,
      networkMonitor,
      autoStartTimers: false,
      cacheLoader: () => null,
      cacheSaver: () => {},
    });
    mw.start();

    const agent = new PiAgentService({
      deps: { mainWindow: mw, service: demo, jobs, settingsStore, broadcastState: () => {} },
      initialConfig: normalizeAgentVoiceConfig({
        ...defaultAgentVoiceConfig(),
        wakeWords: ["Neo"],
        wakeWordEnabled: true,
        owwEnabled: true,
        owwThreshold: 0.65,
        sourceSeparationMode: "off",
        attentionMode: "off",
      }),
    });
    const vl = new VoiceListenerController(agent);

    let asrCalled = 0;
    let shouldWakeMatch = false;
    const engine = vl.localEngine as unknown as Record<string, unknown>;
    Object.defineProperty(vl.localEngine.openWakeWord, "isReady", {
      configurable: true,
      get: () => true,
    });
    engine.scoreWakeWordAudio = () =>
      shouldWakeMatch
        ? {
            wakeWord: "Neo",
            score: 0.9,
            rawScore: 0.9,
            threshold: 0.65,
            matched: true,
            source: "enrolled",
            sampleOffset: 16000,
            latencyMs: 4,
          }
        : {
            wakeWord: "Neo",
            score: 0.12,
            rawScore: 0.12,
            threshold: 0.65,
            matched: false,
            source: "enrolled",
            sampleOffset: 16000,
            latencyMs: 4,
          };
    engine.getStatus = () => ({
      ...LocalVoiceEngine.prototype.getStatus.call(vl.localEngine),
      readyForLocalAsr: true,
      readyForWakeWord: true,
      readyForSourceSeparation: false,
      readyForAudioTagging: false,
    });
    engine.detectSpeechSegments = (samples: Float32Array) => ({
      hasSpeech: true,
      speechSamples: samples,
      speechRatio: 0.9,
      segments: [{ startSec: 0, endSec: samples.length / SR }],
      engine: "energy",
      durationMs: 1,
    });
    engine.transcribeLocal = async () => {
      asrCalled += 1;
      return {
        text: "Neo，打开客厅吸顶灯",
        rawText: "Neo，打开客厅吸顶灯",
        lang: "zh",
        emotion: "",
        event: "",
        engine: "qwen3-asr-remote",
        durationMs: 30,
        computeDevice: "remote",
      };
    };

    try {
      const wavBytes = encodeWavPcm16(makeSine(1.0, 440, 0.25), SR);
      const wav = new Blob([wavBytes.slice().buffer], { type: "audio/wav" });

      // 1. 待机 + 未命中 OWW -> 直接跳过 ASR（asrEngine: "skipped-unawakened"）
      const blocked = await vl.processAudioUpload(wav, {
        filename: "standby.wav",
        autoDispatch: true,
      });
      expect(blocked.ok).toBe(true);
      expect(blocked.asrEngine).toBe("skipped-unawakened");
      expect(blocked.matched).toBe(false);
      expect(asrCalled).toBe(0);

      // 2. bypassWakeWord: true -> 放行转写（双轨 raw+denoised 可能各调用 1 次）
      const bypassed = await vl.processAudioUpload(wav, {
        filename: "bypass.wav",
        autoDispatch: true,
        bypassWakeWord: true,
      });
      expect(bypassed.ok).toBe(true);
      expect(bypassed.asrEngine).not.toBe("skipped-unawakened");
      expect(asrCalled).toBeGreaterThanOrEqual(1);
      const asrAfterBypass = asrCalled;

      // 3. 命中 OWW -> 放行转写
      vl.exitConversation("reset_for_test");
      shouldWakeMatch = true;
      const woke = await vl.processAudioUpload(wav, {
        filename: "wake.wav",
        autoDispatch: true,
      });
      expect(woke.ok).toBe(true);
      expect(woke.asrEngine).not.toBe("skipped-unawakened");
      expect(asrCalled).toBeGreaterThan(asrAfterBypass);
    } finally {
      vl.dispose();
      agent.dispose();
      networkMonitor.stop();
      mw.dispose();
      await jobs.shutdown();
    }
  });

  test("WebSocket /ws 端到端集成：待机期音频零转写事件、/api/agent/config 热更新开关、voice_dialog_control 同步对话态", async () => {
    useTempDataDir();
    runningServer = await startMijiaDeckServer({
      mode: "demo",
      port: 0,
      hostname: "127.0.0.1",
      service: new VirtualDemoService(),
    });

    const vl = runningServer.runtime.voiceListener!;
    const owwCtrl = createMockOwwController(true);
    let asrCalls = 0;
    const engine = vl.localEngine as unknown as Record<string, unknown>;
    engine.createOnlineDenoiser = () => null;
    engine.createWakeWordStream = (
      wakeWords: string[],
      wOpts: { threshold?: number; onSpot?: (hit: WakeWordAcousticHit) => void },
    ) => owwCtrl.sessionFactory(wakeWords, wOpts);
    engine.createStreamingVad = () => createEnergyMockVad(0.02, 8);
    engine.getStatus = () => ({
      ...LocalVoiceEngine.prototype.getStatus.call(vl.localEngine),
      readyForLocalAsr: true,
      readyForWakeWord: true,
      activeQwen3Device: "remote",
    });
    engine.transcribeLocal = async () => {
      asrCalls += 1;
      return {
        text: "Neo，测试指令",
        rawText: "Neo，测试指令",
        lang: "zh",
        emotion: "",
        event: "",
        engine: "qwen3-asr-remote",
        durationMs: 25,
        computeDevice: "remote",
      };
    };

    const wsUrl = `${runningServer.url.replace("http://", "ws://")}/ws`;
    const ws = new WebSocket(wsUrl);
    const events: Array<Record<string, unknown>> = [];

    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = (e) => reject(e);
    });
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as Record<string, unknown>;
        if (msg.type === "voice_stream_event") {
          events.push(msg);
        }
      } catch {
        // ignore non-json
      }
    };

    const waitUntil = async (pred: () => boolean, timeoutMs = 2500) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (pred()) return;
        await Bun.sleep(15);
      }
    };

    ws.send(JSON.stringify({ type: "voice_stream_start", sampleRate: SR, lang: "zh-CN" }));
    await waitUntil(() => events.some((e) => e.kind === "started"));
    expect(events.some((e) => e.kind === "started")).toBe(true);

    // 待机下推入 1.5s Int16 PCM 语音 + 0.8s 静音 -> 零 partial/result/speech_start 事件、零 ASR 调用
    const sendPcmInt16 = (f32: Float32Array) => {
      const i16 = new Int16Array(f32.length);
      for (let i = 0; i < f32.length; i += 1) {
        const clamped = Math.max(-1, Math.min(1, f32[i]!));
        i16[i] = Math.round(clamped * 32767);
      }
      ws.send(new Uint8Array(i16.buffer));
    };

    sendPcmInt16(makeSine(1.5, 440, 0.25));
    sendPcmInt16(makeSilence(0.8));
    await Bun.sleep(80);

    expect(asrCalls).toBe(0);
    expect(events.some((e) => e.kind === "partial" || e.kind === "result")).toBe(false);

    // 通过 WebSocket 进入对话 -> 立即开始正常流式转写，再退出对话 -> 恢复零 ASR 待机
    ws.send(JSON.stringify({ type: "voice_dialog_control", action: "enter" }));
    await waitUntil(() => vl.dialogState === "conversation");
    sendPcmInt16(makeSine(1.0, 440, 0.25));
    await waitUntil(() => asrCalls >= 1);
    expect(asrCalls).toBeGreaterThanOrEqual(1);

    ws.send(JSON.stringify({ type: "voice_dialog_control", action: "exit" }));
    await waitUntil(() => vl.dialogState !== "conversation");
    const asrAfterExit = asrCalls;
    sendPcmInt16(makeSine(1.2, 440, 0.25));
    sendPcmInt16(makeSilence(0.8));
    await Bun.sleep(100);
    expect(asrCalls).toBe(asrAfterExit);

    // 通过 /api/agent/config 热关闭 wakeWordEnabled -> 活跃流立即解除待机门控
    const cfgRes = await fetch(`${runningServer.url}/api/agent/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wakeWordEnabled: false }),
    });
    if (!cfgRes.ok) {
      throw new Error(`POST /api/agent/config failed: ${cfgRes.status} ${await cfgRes.text()}`);
    }
    expect(cfgRes.ok).toBe(true);
    await waitUntil(() => vl.config.wakeWordEnabled === false);
    sendPcmInt16(makeSine(1.0, 440, 0.25));
    await waitUntil(() => asrCalls > asrAfterExit);
    expect(asrCalls).toBeGreaterThan(asrAfterExit);

    ws.send(JSON.stringify({ type: "voice_stream_stop" }));
    ws.close();
  });
});

describe("真实 ONNX 模型端到端验证（背景音零 ASR + 真实唤醒词回放环形缓冲）", () => {
  test.if(HAS_BENCH_WAVS)(
    "真实 openWakeWord + Silero VAD + ASR：待机期流行歌曲/电视对话零转写，真实 Neo 唤醒词自动回放循环录制缓冲区并完整转写",
    async () => {
      useTempDataDir();
      const engine = new LocalVoiceEngine();
      const status = engine.getStatus();
      if (
        !status.readyForLocalAsr ||
        !status.readyForVad ||
        !status.readyForDenoise ||
        !status.readyForWakeWord
      ) {
        engine.dispose();
        return;
      }

      const wakeWords = ["Neo", "尼奥", "鸟"];
      await engine.warmup();
      await engine.openWakeWord.bootstrapWakeWords(wakeWords);

      // 1. 待机下播放流行歌曲 (clip_026) 和电视对话 (clip_066)：legacy 与 clearvoice 双模式均必须 0 触发、0 分段！
      for (const mode of ["legacy", "clearvoice"] as const) {
        for (const noiseFile of ["clip_026.wav", "clip_066.wav"]) {
          const decoded = decodeWavPcm(
            new Uint8Array(readFileSync(path.join(BENCH_AUDIO_DIR, noiseFile))),
          );
          const segs: VoiceStreamSegmentPayload[] = [];
          const partials: string[] = [];
          const session = new VoiceStreamSession({
            localEngine: engine,
            noiseMode: "auto",
            voicePipelineMode: mode,
            vadSilenceMs: 1000,
            wakeWords,
            wakeWordEnabled: true,
            owwEnabled: true,
            owwThreshold: 0.6,
            streamingAsrEnabled: true,
            onPartialTranscript: (p) => partials.push(p.text),
            onSegmentReady: async (seg) => {
              segs.push(seg);
              return null;
            },
          });

          expect(session.isWakeGatedStandby).toBe(true);
          pushChunked(session, decoded.samples, 1024);
          pushChunked(session, makeSilence(1.2), 1024);
          await session.flush();
          await session.waitForIdle();
          session.dispose();

          expect(segs.length).toBe(0);
          expect(partials.length).toBe(0);
        }
      }

      // 2. 待机下说真实唤醒指令 clip_001.wav（“Neo，打开客厅吸顶灯”）：
      //    openWakeWord 声学唤醒 -> 自动回放循环录制缓冲区并衔接后续音频 -> 完整转写“客厅吸顶灯”
      const wakeClip = decodeWavPcm(
        new Uint8Array(readFileSync(path.join(BENCH_AUDIO_DIR, "clip_001.wav"))),
      );
      const wakeSegs: VoiceStreamSegmentPayload[] = [];
      const wakeSpots: WakeWordAcousticHit[] = [];
      const session = new VoiceStreamSession({
        localEngine: engine,
        noiseMode: "auto",
        voicePipelineMode: "legacy",
        vadSilenceMs: 1200,
        wakeWords,
        wakeWordEnabled: true,
        owwEnabled: true,
        owwThreshold: 0.6,
        streamingAsrEnabled: false,
        onWakeWordSpot: (hit) => wakeSpots.push(hit),
        onSegmentReady: async (seg) => {
          wakeSegs.push(seg);
          return null;
        },
      });

      const padded = new Float32Array(Math.round(SR * 0.6) + wakeClip.samples.length + Math.round(SR * 1.6));
      padded.set(wakeClip.samples, Math.round(SR * 0.6));
      pushChunked(session, padded, 1024);
      await session.waitForIdle();
      session.dispose();

      expect(wakeSpots.length).toBeGreaterThanOrEqual(1);
      expect(wakeSegs.length).toBe(1);
      expect(wakeSegs[0]!.wakeAnchored).toBe(true);
      const asrRaw = await engine.transcribeLocal(wakeSegs[0]!.rawSamples, SR, "zh-CN");
      const asrDen = await engine.transcribeLocal(wakeSegs[0]!.denoisedSamples, SR, "zh-CN");
      expect(`${asrRaw.text} ${asrDen.text}`).toContain("客厅吸顶灯");

      engine.dispose();
    },
    60_000,
  );
});
