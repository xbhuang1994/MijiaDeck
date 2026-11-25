// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 慢语速长语音整句合并（防提前强拆多句发给 Pi Agent）综合回归测试

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai";
import { ClearVoiceRealtimeChunker } from "../src/agent/clearVoiceChunker.ts";
import { ClearVoiceGpuRuntime } from "../src/agent/clearVoiceGpuRuntime.ts";
import type { LocalAsrOutput, LocalVoiceEngine, StreamingVadHandleLike } from "../src/agent/localVoiceEngine.ts";
import { PiAgentService } from "../src/agent/piAgentService.ts";
import {
  joinUtteranceFragments,
  looksLikeIncompleteUtterance,
} from "../src/agent/qwen3StreamingTranscriber.ts";
import { VoiceCommandSegmenter } from "../src/agent/voiceCommandSegmenter.ts";
import { VoiceListenerController } from "../src/agent/voiceListenerController.ts";
import {
  VoiceStreamSession,
  type VoiceStreamSegmentPayload,
} from "../src/agent/voiceStreamSession.ts";
import {
  defaultAgentVoiceConfig,
  normalizeAgentVoiceConfig,
} from "../src/core/agentConfigStore.ts";
import { NetworkMonitor } from "../src/core/availability.ts";
import { JobExecutor } from "../src/core/jobs.ts";
import { setDataPathOverrides } from "../src/core/jsonStore.ts";
import * as settingsStore from "../src/core/settingsStore.ts";
import { VirtualDemoService } from "../src/core/virtualLightService.ts";
import { MainWindowController } from "../src/ui/controllers/mainWindowController.ts";
import { applyTheme, ThemeController } from "../src/ui/theme.ts";

let tmpDir = "";
let mockCvServer: ReturnType<typeof Bun.serve> | null = null;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "mijiadeck-long-speech-"));
  const dir = tmpDir;
  setDataPathOverrides({ dataDir: () => dir });
});

afterEach(() => {
  if (mockCvServer) {
    mockCvServer.stop(true);
    mockCvServer = null;
  }
  setDataPathOverrides(null);
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = "";
  }
});

function makeSine(durationSec: number, amp = 0.22, freqHz = 440, sr = 16000): Float32Array {
  const n = Math.round(durationSec * sr);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    out[i] = Math.sin((2 * Math.PI * freqHz * i) / sr) * amp;
  }
  return out;
}

function makeSilence(durationSec: number, sr = 16000): Float32Array {
  return new Float32Array(Math.round(durationSec * sr));
}

function createEnergyMockVad(threshold = 0.02): StreamingVadHandleLike {
  let detected = false;
  return {
    acceptWaveform(samples: Float32Array) {
      let sum = 0;
      for (let i = 0; i < samples.length; i += 1) {
        const s = samples[i]!;
        sum += s * s;
      }
      detected = Math.sqrt(sum / Math.max(1, samples.length)) >= threshold;
    },
    isEmpty: () => true,
    isDetected: () => detected,
    front: () => ({ start: 0, samples: new Float32Array(0) }),
    pop: () => {},
    flush: () => {},
    reset: () => {
      detected = false;
    },
    clear: () => {
      detected = false;
    },
  };
}

function createSileroLikeMockVad(minSilenceSec = 1.0, threshold = 0.02): StreamingVadHandleLike {
  const silenceFramesNeeded = Math.max(1, Math.round((minSilenceSec * 16000) / 512));
  let detected = false;
  let silentFrames = 0;
  let sampleCursor = 0;
  let segStart = 0;
  let chunks: Float32Array[] = [];
  let queue: Array<{ start: number; samples: Float32Array }> = [];

  const finalize = () => {
    if (chunks.length === 0) return;
    const total = chunks.reduce((a, c) => a + c.length, 0);
    const merged = new Float32Array(total);
    let off = 0;
    for (const c of chunks) {
      merged.set(c, off);
      off += c.length;
    }
    queue.push({ start: segStart, samples: merged });
    chunks = [];
    detected = false;
    silentFrames = 0;
  };

  return {
    acceptWaveform(frame: Float32Array) {
      let sum = 0;
      for (let i = 0; i < frame.length; i += 1) {
        const s = frame[i]!;
        sum += s * s;
      }
      const isVoice = Math.sqrt(sum / Math.max(1, frame.length)) >= threshold;
      if (isVoice) {
        if (!detected) {
          detected = true;
          segStart = sampleCursor;
          chunks = [];
        }
        silentFrames = 0;
        chunks.push(new Float32Array(frame));
      } else if (detected) {
        silentFrames += 1;
        chunks.push(new Float32Array(frame));
        if (silentFrames >= silenceFramesNeeded) {
          finalize();
        }
      }
      sampleCursor += frame.length;
    },
    isEmpty: () => queue.length === 0,
    isDetected: () => detected,
    front: () => queue[0]!,
    pop: () => {
      queue.shift();
    },
    flush: () => {
      finalize();
    },
    reset: () => {
      queue = [];
      chunks = [];
      detected = false;
      silentFrames = 0;
      sampleCursor = 0;
    },
    clear: () => {
      queue = [];
    },
  };
}

describe("Slow & Long Speech Anti-Splitting Heuristics", () => {
  test("looksLikeIncompleteUtterance identifies dangling pauses while keeping complete commands & wake words snappy", () => {
    const wakeWords = ["Neo", "小派"];

    // Incomplete mid-sentence pauses -> true
    expect(looksLikeIncompleteUtterance("Neo，帮我把客厅的灯，", wakeWords)).toBe(true);
    expect(looksLikeIncompleteUtterance("我想洗一下深色衣服，然后", wakeWords)).toBe(true);
    expect(looksLikeIncompleteUtterance("打开客厅吸顶灯，顺便。", wakeWords)).toBe(true);
    expect(looksLikeIncompleteUtterance("Neo，帮我把客厅吸顶灯", wakeWords)).toBe(true);
    expect(looksLikeIncompleteUtterance("把卧室空调。", wakeWords)).toBe(true);
    expect(looksLikeIncompleteUtterance("把走廊开关", wakeWords)).toBe(true);
    expect(looksLikeIncompleteUtterance("把阳台洗衣机", wakeWords)).toBe(true);
    expect(looksLikeIncompleteUtterance("帮我", wakeWords)).toBe(true);
    expect(looksLikeIncompleteUtterance("Turn on the lamp and", wakeWords)).toBe(true);

    // Complete commands & standalone wake words -> false
    expect(looksLikeIncompleteUtterance("Neo", wakeWords)).toBe(false);
    expect(looksLikeIncompleteUtterance("Neo。", wakeWords)).toBe(false);
    expect(looksLikeIncompleteUtterance("小派，在吗？", wakeWords)).toBe(false);
    expect(looksLikeIncompleteUtterance("Neo，打开客厅吸顶灯。", wakeWords)).toBe(false);
    expect(looksLikeIncompleteUtterance("帮我把客厅吸顶灯打开", wakeWords)).toBe(false);
    expect(looksLikeIncompleteUtterance("把卧室空调调到26度", wakeWords)).toBe(false);
    expect(looksLikeIncompleteUtterance("客厅现在几度？", wakeWords)).toBe(false);
    expect(looksLikeIncompleteUtterance("关灯", wakeWords)).toBe(false);

    // Fragment joining removes artificial mid-clause period & deduplicates overlap
    expect(joinUtteranceFragments("帮我把客厅的吸顶灯。", "调到百分之五十。")).toBe(
      "帮我把客厅的吸顶灯调到百分之五十。",
    );
    expect(joinUtteranceFragments("我想洗一下衣服，然后。", "顺便查一下阳台湿度。")).toBe(
      "我想洗一下衣服，然后顺便查一下阳台湿度。",
    );
    expect(joinUtteranceFragments("Turn on the light", "and set brightness to 80%")).toBe(
      "Turn on the light and set brightness to 80%",
    );
  });
});

describe("ClearVoice Pipeline Slow & Long Utterance Continuity", () => {
  test("ClearVoiceRealtimeChunker decouples 280ms denoising slices from 1200ms utterance end so slow multi-pause speech stays 1 utterance", () => {
    const vad = createEnergyMockVad(0.02);
    const activityLog: boolean[] = [];
    const chunker = new ClearVoiceRealtimeChunker({
      sampleRate: 16000,
      frameSizeMs: 32,
      silenceTriggerMs: 280,
      utteranceSilenceMs: 1200,
      longUtteranceThresholdMs: 3000,
      longUtteranceExtraSilenceMs: 350,
      incompleteGraceMs: 700,
      maxChunkMs: 2000,
      lookbackMs: 300,
      crossfadeMs: 20,
      vad,
      onSpeechActivity: (speaking) => activityLog.push(speaking),
    });

    const allChunks = [
      ...chunker.pushSamples(makeSilence(0.4)),
      // Clause 1 (1.5s) + slow pause (650ms > 280ms, < 1200ms)
      ...chunker.pushSamples(makeSine(1.5)),
      ...chunker.pushSamples(makeSilence(0.65)),
      // Clause 2 (2.2s) + slow pause (900ms > 280ms, < 1550ms long-utterance patience)
      ...chunker.pushSamples(makeSine(2.2)),
      ...chunker.pushSamples(makeSilence(0.9)),
      // Clause 3 (1.4s) + true end-of-utterance silence (1.7s >= 1550ms)
      ...chunker.pushSamples(makeSine(1.4)),
      ...chunker.pushSamples(makeSilence(1.7)),
    ];

    const endedChunks = allChunks.filter((c) => c.utteranceEnded);
    const denoiseSlices = allChunks.filter((c) => c.rawNewSamples.length > 0);
    // Incremental denoising slices were emitted promptly on 280ms pauses & 2.0s timeout...
    expect(denoiseSlices.length).toBeGreaterThanOrEqual(4);
    // ...yet ONLY ONE utterance end happened at the very end!
    expect(endedChunks.length).toBe(1);
    expect(endedChunks[0]!.rawNewSamples.length).toBe(0);
    expect(activityLog).toEqual([true, false]);
  });

  test("VoiceStreamSession in ClearVoice mode keeps an 11-second slow multi-pause utterance intact and extends pause on incomplete clause", async () => {
    const receivedSliceLengths: number[] = [];
    mockCvServer = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const u = new URL(req.url);
        if (u.pathname === "/health") {
          return Response.json({
            ok: true,
            model: "MossFormer2_SE_48K",
            provider: "CUDAExecutionProvider",
            device: "gpu",
            gpuName: "Mock RTX 3060",
            warmedUp: true,
          });
        }
        if (u.pathname === "/denoise") {
          const buf = await req.arrayBuffer();
          const input = new Float32Array(buf);
          receivedSliceLengths.push(input.length);
          return new Response(new Uint8Array(input.buffer.slice(0)), {
            status: 200,
            headers: {
              "Content-Type": "application/octet-stream",
              "X-ClearVoice-Model": "MossFormer2_SE_48K",
              "X-ClearVoice-Provider": "CUDAExecutionProvider",
              "X-ClearVoice-Device": "gpu",
              "X-ClearVoice-Infer-Ms": "18",
              "X-ClearVoice-Gpu-Name": "Mock RTX 3060",
            },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });

    const cvRuntime = new ClearVoiceGpuRuntime({
      modelsDir: tmpDir,
      serviceUrl: `http://127.0.0.1:${mockCvServer.port}`,
    });

    let asrCalls = 0;
    const previews = [
      "Neo，帮我把客厅的吸顶灯",
      "Neo，帮我把客厅的吸顶灯",
      "Neo，帮我把客厅的吸顶灯调暗到百分之五十，然后",
      "Neo，帮我把客厅的吸顶灯调暗到百分之五十，然后再把卧室空调打开调到26度。",
    ];
    const fakeEngine = {
      createOnlineDenoiser: () => null,
      createStreamingVad: () => createEnergyMockVad(0.02),
      createWakeWordStream: () => null,
      clearVoiceGpu: cvRuntime,
      getStatus: () => ({
        readyForLocalAsr: true,
        activeQwen3Device: "gpu" as const,
        readyForClearVoiceGpu: true,
        clearVoice: cvRuntime.getStatus(),
      }),
      denoise: (s: Float32Array) => ({
        samples: s,
        sampleRate: 16000,
        engine: "dsp" as const,
        inputSnrDb: 12,
        outputSnrDb: 16,
        snrGainDb: 4,
        durationMs: 2,
      }),
      transcribeLocal: async (): Promise<LocalAsrOutput> => {
        const text = previews[Math.min(asrCalls, previews.length - 1)]!;
        asrCalls += 1;
        return {
          text,
          rawText: text,
          lang: "zh",
          emotion: "",
          event: "",
          engine: "qwen3-asr-gpu",
          durationMs: 35,
          computeDevice: "gpu",
        };
      },
    } as unknown as LocalVoiceEngine;

    const emitted: VoiceStreamSegmentPayload[] = [];
    let resolveFirstPartial!: () => void;
    const firstPartialReady = new Promise<void>((resolve) => {
      resolveFirstPartial = resolve;
    });
    const session = new VoiceStreamSession({
      localEngine: fakeEngine,
      noiseMode: "auto",
      voicePipelineMode: "clearvoice",
      streamingAsrEnabled: true,
      vadSilenceMs: 1200,
      vadSensitivity: "default",
      wakeWords: ["Neo"],
      onPartialTranscript: () => {
        resolveFirstPartial();
      },
      onSegmentReady: async (seg) => {
        emitted.push(seg);
        return null;
      },
    });

    // Part 1: 2.2s speech + 0.35s silence; wait deterministically for preview ASR to flag incomplete clause ("Neo，帮我把客厅的吸顶灯")
    session.pushFloat32Samples(makeSine(2.2));
    session.pushFloat32Samples(makeSilence(0.35));
    await firstPartialReady;
    // Slow thinking pause extends to 1.45s total (> 1200ms base vadSilenceMs, inside 1200 + 700ms incomplete grace!)
    session.pushFloat32Samples(makeSilence(1.1));
    await Bun.sleep(40);
    expect(emitted.length).toBe(0);

    // Part 2: 4.5s speech + 0.8s slow pause (exceeds old 8.0s hard cap!)
    session.pushFloat32Samples(makeSine(4.5));
    session.pushFloat32Samples(makeSilence(0.8));
    await Bun.sleep(60);
    expect(emitted.length).toBe(0);

    // Part 3: 3.5s speech + 2.1s true final silence -> commits ONCE!
    session.pushFloat32Samples(makeSine(3.5));
    session.pushFloat32Samples(makeSilence(2.1));
    await session.waitForIdle();

    expect(receivedSliceLengths.length).toBeGreaterThanOrEqual(5);
    expect(emitted.length).toBe(1);
    expect(emitted[0]!.durationSec).toBeGreaterThan(10.0);
    expect(emitted[0]!.clearVoiceMeta?.crossfadeCount).toBeGreaterThanOrEqual(4);
    session.dispose();
  });
});

describe("Legacy Pipeline Long Speech, Wake-Anchored & Audio Stitching", () => {
  test("allows 10-second continuous slow speech and 7-second wake-anchored speech without 3.8s/4.0s forced chop", async () => {
    // 1. VoiceCommandSegmenter forceStartCommand does NOT chop at 4.0s
    const seg = new VoiceCommandSegmenter({ silenceSeconds: 1.2 });
    seg.forceStartCommand(0.1);
    let cutBefore7s = false;
    for (let i = 0; i < Math.round(7.0 / 0.032); i += 1) {
      if (!seg.process(0.032, 0.72, 0.1).continuing) {
        cutBefore7s = true;
        break;
      }
    }
    expect(cutBefore7s).toBe(false);

    // 2. VoiceStreamSession in legacy mode with 10s continuous speech (with brief 600ms slow pauses) -> 1 single segment!
    const fakeEngine = {
      createOnlineDenoiser: () => null,
      createStreamingVad: (opts?: { minSilenceDuration?: number }) =>
        createSileroLikeMockVad(opts?.minSilenceDuration ?? 1.2, 0.02),
      createWakeWordStream: () => null,
      getStatus: () => ({ readyForLocalAsr: true, activeQwen3Device: "gpu" as const }),
      sourceSeparator: {
        analyzeAudioScene: () => ({
          tags: [],
          speechProb: 0.9,
          musicProb: 0,
          singingProb: 0,
          noiseProb: 0,
          crowdTvProb: 0,
          detectedSoundTypes: ["speech"],
          durationMs: 1,
        }),
      },
    } as unknown as LocalVoiceEngine;

    const emitted: VoiceStreamSegmentPayload[] = [];
    const session = new VoiceStreamSession({
      localEngine: fakeEngine,
      noiseMode: "off",
      voicePipelineMode: "legacy",
      vadSilenceMs: 1200,
      vadSensitivity: "default",
      bypassWakeWord: true,
      owwEnabled: false,
      onSegmentReady: async (s) => {
        emitted.push(s);
        return null;
      },
    });

    session.pushFloat32Samples(makeSine(3.6));
    session.pushFloat32Samples(makeSilence(0.7));
    session.pushFloat32Samples(makeSine(3.8));
    session.pushFloat32Samples(makeSilence(0.8));
    session.pushFloat32Samples(makeSine(2.4));
    // True end silence: 1.2s VAD + 0.35s long-utterance grace = 1.55s -> push 1.8s
    session.pushFloat32Samples(makeSilence(1.8));
    await session.waitForIdle();

    expect(emitted.length).toBe(1);
    expect(emitted[0]!.forcedRoll).toBe(false);
    expect(emitted[0]!.durationSec).toBeGreaterThan(10.0);
    session.dispose();
  });

  test("legacy deferred hold stitches two slow fragments paused slightly past vadSilenceMs into 1 unified segment", async () => {
    let callIdx = 0;
    const hyps = [
      "Neo，我想洗一下深色衣服，然后",
      "Neo，我想洗一下深色衣服，然后",
      "顺便帮我拟定两个洗涤方案。",
    ];
    const fakeEngine = {
      createOnlineDenoiser: () => null,
      createStreamingVad: (opts?: { minSilenceDuration?: number }) =>
        createSileroLikeMockVad(opts?.minSilenceDuration ?? 1.0, 0.02),
      createWakeWordStream: () => null,
      getStatus: () => ({ readyForLocalAsr: true, activeQwen3Device: "gpu" as const }),
      transcribeLocal: async (): Promise<LocalAsrOutput> => {
        const text = hyps[Math.min(callIdx, hyps.length - 1)]!;
        callIdx += 1;
        return {
          text,
          rawText: text,
          lang: "zh",
          emotion: "",
          event: "",
          engine: "qwen3-asr-gpu-stream",
          durationMs: 25,
          computeDevice: "gpu",
        };
      },
    } as unknown as LocalVoiceEngine;

    const emitted: VoiceStreamSegmentPayload[] = [];
    const session = new VoiceStreamSession({
      localEngine: fakeEngine,
      noiseMode: "off",
      voicePipelineMode: "legacy",
      vadSilenceMs: 1000,
      vadSensitivity: "default",
      bypassWakeWord: true,
      wakeWords: ["Neo"],
      owwEnabled: false,
      streamingAsrEnabled: true,
      streamingPollIntervalMs: 320,
      incompleteGraceMs: 650,
      onSegmentReady: async (s) => {
        emitted.push(s);
        return null;
      },
    });

    // Fragment 1: 1.5s speech ("Neo，我想洗一下深色衣服，然后") + 1.3s pause (> 1.0s VAD, < 1.65s incomplete grace!)
    session.pushFloat32Samples(makeSine(1.5));
    await Bun.sleep(25);
    session.pushFloat32Samples(makeSilence(1.3));
    await Bun.sleep(25);
    // Must be held, NOT dispatched early!
    expect(emitted.length).toBe(0);

    // Fragment 2: user resumes speaking 1.6s ("顺便帮我拟定两个洗涤方案。") + 1.6s final silence
    session.pushFloat32Samples(makeSine(1.6));
    await Bun.sleep(25);
    session.pushFloat32Samples(makeSilence(1.6));
    await session.waitForIdle();

    expect(emitted.length).toBe(1);
    expect(emitted[0]!.durationSec).toBeGreaterThan(4.0);
    session.dispose();
  });
});

describe("End-to-End VoiceListenerController -> PiAgentService Single Combined Dispatch", () => {
  test("sends multi-sentence slow utterance to Pi Agent as ONE unified prompt (never split on 。/！) and honors 12s speech inside 5s wakeWindowSec", async () => {
    applyTheme("dark", "green");
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
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && mw.allDevices.length === 0) {
      await Bun.sleep(10);
    }

    const receivedPrompts: string[] = [];
    const faux = fauxProvider();
    const captureStreamFn: ConstructorParameters<typeof PiAgentService>[0]["customStreamFn"] = (
      _model,
      context,
    ) => {
      const stream = createAssistantMessageEventStream();
      const lastUser = [...context.messages].reverse().find((m) => m.role === "user");
      const rawText =
        typeof lastUser?.content === "string"
          ? lastUser.content
          : Array.isArray(lastUser?.content)
            ? lastUser.content.map((c) => ("text" in c ? c.text : "")).join("")
            : "";
      const isAttentionCheck = rawText.includes("最新听到的语音文本");
      const reply = isAttentionCheck
        ? JSON.stringify({
            addressed: true,
            inConversation: true,
            confidence: 0.96,
            reason: "用户在呼叫 Neo 并交代洗衣机完整需求",
            command: "我等下要洗深色衣服。这批里面有棉质衬衫不能高温洗。你先帮我拟定两个可选方案看看。",
          })
        : "已收到完整需求，拟定方案一与方案二。";
      if (!isAttentionCheck) {
        receivedPrompts.push(rawText);
      }
      const msg = fauxAssistantMessage(reply, { stopReason: "stop" });
      queueMicrotask(() => {
        stream.push({ type: "start", partial: msg });
        stream.push({ type: "text_start", contentIndex: 0, partial: msg });
        stream.push({ type: "text_delta", contentIndex: 0, delta: reply, partial: msg });
        stream.push({ type: "text_end", contentIndex: 0, content: reply, partial: msg });
        stream.push({ type: "done", reason: "stop", message: msg });
        stream.end(msg);
      });
      return stream;
    };

    const fullLongTranscript =
      "Neo，我等下要洗深色衣服。这批里面有棉质衬衫不能高温洗。你先帮我拟定两个可选方案看看。";
    const fakeLocalEngine = {
      setPreferredAsrEngine: () => {},
      setQwen3ComputeDevice: () => {},
      setClearVoiceServiceUrl: () => {},
      getStatus: () => ({
        readyForLocalAsr: true,
        readyForSourceSeparation: false,
        readyForDenoise: true,
        readyForVad: true,
        readyForVoiceprint: false,
        readyForWakeWord: false,
        readyForLocalTts: false,
        readyForClearVoiceGpu: true,
      }),
      openWakeWord: {
        isReady: false,
        getStatus: () => ({ ready: false, prototypeCount: 0, enrolledCount: 0, ttsCount: 0 }),
      },
      transcribeLocal: async (): Promise<LocalAsrOutput> => ({
        text: fullLongTranscript,
        rawText: fullLongTranscript,
        lang: "zh",
        emotion: "",
        event: "",
        engine: "qwen3-asr-gpu",
        durationMs: 120,
        computeDevice: "gpu",
      }),
      dispose: () => {},
    } as unknown as LocalVoiceEngine;

    const cfg = normalizeAgentVoiceConfig({
      ...defaultAgentVoiceConfig(),
      provider: "openai",
      modelId: faux.getModel().id,
      wakeWords: ["Neo"],
      wakeWindowSec: 5,
      conversationWindowSec: 0,
      qwen3StreamingEnabled: true,
      voicePipelineMode: "clearvoice",
      asyncVoicePipeline: true,
      preferLocalIntents: false,
      autoSpeakReply: false,
      sourceSeparationMode: "off",
      owwEnabled: false,
    });

    const agent = new PiAgentService({
      deps: { mainWindow: mw, service: demo, jobs, settingsStore, broadcastState: () => {} },
      initialConfig: cfg,
      customStreamFn: captureStreamFn,
      customModel: faux.getModel(),
    });
    const vl = new VoiceListenerController(agent, { localEngine: fakeLocalEngine });

    try {
      // 1. Multi-sentence ClearVoice segment with qwen3StreamingEnabled=true MUST fire ONLY 1 Pi Agent prompt!
      const res = await vl.processDualTrackSegment(
        {
          rawSamples: makeSine(11.5),
          denoisedSamples: makeSine(11.5),
          denoiseEngine: "clearvoice-mossformer2-gpu",
          inputSnrDb: 18,
          outputSnrDb: 24,
          snrGainDb: 6,
          startSec: 0,
          durationSec: 11.5,
          forcedRoll: false,
          pipelineMode: "clearvoice",
        },
        { asyncDispatch: false },
      );

      expect(res.matched).toBe(true);
      expect(receivedPrompts.length).toBe(1);
      expect(agent.snapshot().timeline.filter((e) => e.role === "user").length).toBe(1);
      expect(receivedPrompts[0]).toContain("洗深色衣服");
      expect(receivedPrompts[0]).toContain("棉质衬衫");
      expect(receivedPrompts[0]).toContain("两个可选方案");

      // 2. Wake-only opens 5s wakeWindowSec; user starts a 12s slow utterance at t0+3s and finishes at t0+15s -> still accepted!
      const t0 = Date.now() + 20_000;
      const woke = await vl.handleTranscript("Neo", { isFinal: true, now: t0 });
      expect(woke.wokeOnly).toBe(true);

      const slowFollow = await vl.handleTranscript(
        "帮我把客厅吸顶灯亮度调暗一点。顺便把卧室空调也打开设为26度。",
        {
          isFinal: true,
          now: t0 + 15_000,
          segmentDurationMs: 12_000,
        },
      );
      expect(slowFollow.matched).toBe(true);
      expect(receivedPrompts.length).toBe(2);
      expect(agent.snapshot().timeline.filter((e) => e.role === "user").length).toBe(2);
      expect(receivedPrompts[1]).toContain("客厅吸顶灯");
      expect(receivedPrompts[1]).toContain("卧室空调");
    } finally {
      vl.dispose();
      agent.dispose();
      networkMonitor.stop();
      mw.dispose();
      await jobs.shutdown();
    }
  });

  test("VoiceStreamSession.updateVadTiming hot-updates ClearVoice utteranceSilenceMs without reconnecting", async () => {
    const fakeEngine = {
      createOnlineDenoiser: () => null,
      createStreamingVad: () => createEnergyMockVad(0.02),
      createWakeWordStream: () => null,
      clearVoiceGpu: {
        getStatus: () => ({ ready: false }),
        isInFailureCooldown: () => false,
      },
      getStatus: () => ({ readyForLocalAsr: false, readyForClearVoiceGpu: false }),
      denoise: (s: Float32Array) => ({
        samples: s,
        sampleRate: 16000,
        engine: "dsp" as const,
        inputSnrDb: 12,
        outputSnrDb: 15,
        snrGainDb: 3,
        durationMs: 1,
      }),
    } as unknown as LocalVoiceEngine;

    const emitted: VoiceStreamSegmentPayload[] = [];
    const session = new VoiceStreamSession({
      localEngine: fakeEngine,
      noiseMode: "dsp",
      voicePipelineMode: "clearvoice",
      vadSilenceMs: 700,
      vadSensitivity: "default",
      onSegmentReady: async (s) => {
        emitted.push(s);
        return null;
      },
    });

    // Initialize chunker, then hot-update vadSilenceMs to 1600ms
    session.pushFloat32Samples(makeSilence(0.1));
    session.updateVadTiming({ vadSilenceMs: 1600 });

    // Speak 1.0s + pause 1.1s (> old 700ms, < new 1600ms!) -> MUST NOT split!
    session.pushFloat32Samples(makeSine(1.0));
    session.pushFloat32Samples(makeSilence(1.1));
    await Bun.sleep(40);
    expect(emitted.length).toBe(0);

    // Resume speaking 0.8s + final silence 1.75s (>= 1600ms) -> commits as 1 combined utterance!
    session.pushFloat32Samples(makeSine(0.8));
    session.pushFloat32Samples(makeSilence(1.75));
    await session.waitForIdle();

    expect(emitted.length).toBe(1);
    session.dispose();
  });
});
