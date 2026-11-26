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
import type { LocalAsrOutput, LocalVoiceEngine, StreamingVadHandleLike } from "../src/agent/localVoiceEngine.ts";
import { PiAgentService } from "../src/agent/piAgentService.ts";
import {
  joinUtteranceFragments,
  looksLikeIncompleteUtterance,
} from "../src/agent/streamingAsrTracker.ts";
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

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "mijiadeck-long-speech-"));
  const dir = tmpDir;
  setDataPathOverrides({ dataDir: () => dir });
});

afterEach(() => {
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
      getStatus: () => ({ readyForLocalAsr: true }),
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
      getStatus: () => ({ readyForLocalAsr: true }),
      transcribeLocal: async (): Promise<LocalAsrOutput> => {
        const text = hyps[Math.min(callIdx, hyps.length - 1)]!;
        callIdx += 1;
        return {
          text,
          rawText: text,
          lang: "zh",
          emotion: "",
          event: "",
          engine: "sensevoice-local",
          durationMs: 25,
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
      getStatus: () => ({
        readyForLocalAsr: true,
        readyForSourceSeparation: false,
        readyForDenoise: true,
        readyForVad: true,
        readyForVoiceprint: false,
        readyForWakeWord: false,
        readyForLocalTts: false,
      }),
      openWakeWord: {
        isReady: false,
        getStatus: () => ({ ready: false, prototypeCount: 0, enrolledCount: 0, ttsCount: 0 }),
      },
      transcribeDualTrack: async (): Promise<LocalAsrOutput> => ({
        text: fullLongTranscript,
        rawText: fullLongTranscript,
        lang: "zh",
        emotion: "",
        event: "",
        engine: "sensevoice-local",
        durationMs: 120,
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
      streamingAsrEnabled: true,
      voicePipelineMode: "legacy",
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
      // 1. Multi-sentence segment with streamingAsrEnabled=true MUST fire ONLY 1 Pi Agent prompt!
      const res = await vl.processDualTrackSegment(
        {
          rawSamples: makeSine(11.5),
          denoisedSamples: makeSine(11.5),
          denoiseEngine: "gtcrn",
          inputSnrDb: 18,
          outputSnrDb: 24,
          snrGainDb: 6,
          startSec: 0,
          durationSec: 11.5,
          forcedRoll: false,
          pipelineMode: "legacy",
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

  test("VoiceStreamSession.updateVadTiming hot-updates segmenter silence duration without reconnecting", async () => {
    // Use an always-empty mock VAD so segmenter-driven wake-anchored timing governs end-of-utterance
    let detected = false;
    const fakeVad: StreamingVadHandleLike = {
      acceptWaveform(frame: Float32Array) {
        let sum = 0;
        for (let i = 0; i < frame.length; i += 1) sum += frame[i]! * frame[i]!;
        detected = Math.sqrt(sum / Math.max(1, frame.length)) >= 0.02;
      },
      isEmpty: () => true,
      isDetected: () => detected,
      front: () => ({ start: 0, samples: new Float32Array(0) }),
      pop: () => {},
      flush: () => {},
      reset: () => {
        detected = false;
      },
      clear: () => {},
    };

    const fakeEngine = {
      createOnlineDenoiser: () => null,
      createStreamingVad: () => fakeVad,
      createWakeWordStream: () => null,
      getStatus: () => ({ readyForLocalAsr: false }),
    } as unknown as LocalVoiceEngine;

    const emitted: VoiceStreamSegmentPayload[] = [];
    const session = new VoiceStreamSession({
      localEngine: fakeEngine,
      noiseMode: "off",
      voicePipelineMode: "legacy",
      vadSilenceMs: 700,
      vadSensitivity: "default",
      owwEnabled: false,
      onSegmentReady: async (s) => {
        emitted.push(s);
        return null;
      },
    });

    // Hot-update vadSilenceMs to 1600ms, then anchor a wake utterance
    session.pushFloat32Samples(makeSilence(0.1));
    session.updateVadTiming({ vadSilenceMs: 1600 });
    session.triggerWake({ replayMs: 200 });

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
