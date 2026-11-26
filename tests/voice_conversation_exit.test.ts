// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 环境噪音与背景音乐下无真实对话时正确退出对话模式回归测试

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { decodeWavPcm, resampleLinear } from "../src/agent/audioPcm.ts";
import { LocalVoiceEngine } from "../src/agent/localVoiceEngine.ts";
import { PiAgentService } from "../src/agent/piAgentService.ts";
import {
  evaluateVoiceAttention,
  isClearConversationCommand,
  isExplicitExitPhrase,
  isNoiseOrGarbledFragment,
} from "../src/agent/voiceAttentionGate.ts";
import { VoiceListenerController } from "../src/agent/voiceListenerController.ts";
import { VoiceStreamSession } from "../src/agent/voiceStreamSession.ts";
import {
  defaultAgentVoiceConfig,
  normalizeAgentVoiceConfig,
} from "../src/core/agentConfigStore.ts";
import { NetworkMonitor } from "../src/core/availability.ts";
import { JobExecutor } from "../src/core/jobs.ts";
import { setDataPathOverrides } from "../src/core/jsonStore.ts";
import * as settingsStore from "../src/core/settingsStore.ts";
import { VirtualDemoService } from "../src/core/virtualLightService.ts";
import { startMijiaDeckServer, type MijiaDeckServer } from "../src/server/server.ts";
import { MainWindowController } from "../src/ui/controllers/mainWindowController.ts";
import { applyTheme, ThemeController } from "../src/ui/theme.ts";

const BENCH_DIR = path.resolve(import.meta.dir, "..", "benchmarks", "voice_sep_100");
const BENCH_AUDIO_DIR = path.join(BENCH_DIR, "audio");
const HAS_BENCH_WAVS =
  existsSync(path.join(BENCH_AUDIO_DIR, "clip_026.wav")) &&
  existsSync(path.join(BENCH_AUDIO_DIR, "clip_066.wav"));

let tmpDir = "";
let server: MijiaDeckServer | null = null;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "mijiadeck-conv-exit-"));
  const dir = tmpDir;
  setDataPathOverrides({ dataDir: () => dir });
});

afterEach(async () => {
  if (server) {
    await server.stop();
    server = null;
  }
  setDataPathOverrides(null);
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = "";
  }
});

async function createIsolatedVoiceHarness(
  configOverrides: Record<string, unknown> = {},
  localEngine?: LocalVoiceEngine,
) {
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

  const cfg = normalizeAgentVoiceConfig({
    ...defaultAgentVoiceConfig(),
    wakeWords: ["Neo", "小派"],
    autoSpeakReply: false,
    sourceSeparationMode: "off",
    owwEnabled: false,
    ...configOverrides,
  });
  const agent = new PiAgentService({
    deps: { mainWindow: mw, service: demo, jobs, settingsStore, broadcastState: () => {} },
    initialConfig: cfg,
  });
  const vl = new VoiceListenerController(agent, { localEngine });

  const cleanup = async () => {
    vl.dispose();
    agent.dispose();
    networkMonitor.stop();
    mw.dispose();
    await jobs.shutdown();
  };

  return { demo, mw, agent, vl, cleanup };
}

describe("Conversation Mode Attention Rejection Under Noise & Background Music", () => {
  const wakeWords = ["Neo", "小派"];

  test("rejects BGM lyrics, TV chatter, cafe babble, and ASR noise hallucinations in both awakeActive and conversation windows", async () => {
    const noiseSamples: Array<{ text: string; event?: string }> = [
      { text: "从前初是这世间万般流。", event: "<|BGM|>" },
      { text: "也甘愿赴汤蹈火去走开一回。", event: "<|BGM|>" },
      { text: "从来没能将我的情意表达千万。", event: "<|BGM|>" },
      { text: "如今走过这世。", event: "<|BGM|>" },
      { text: "现在我好想你", event: "<|BGM|>" },
      { text: "把爱留在昨天", event: "<|BGM|>" },
      { text: "还是忘不了你", event: "<|BGM|>" },
      { text: "告诉我为什么", event: "<|BGM|>" },
      { text: "You' always seems like t", event: "<|BGM|>" },
      { text: "The.", event: "<|BGM|>" },
      { text: "非常累的时候就会站在阳台凑出。", event: "<|Speech|>" },
      { text: "现在不需要测需要去切换的你这吧。", event: "<|Speech|>" },
      { text: "真在需要测试要切换下你这吧就。", event: "<|Speech|>" },
      { text: "そしす。", event: "<|Speech|>" },
      { text: "그.", event: "<|Speech|>" },
      { text: "I.", event: "<|Speech|>" },
    ];

    for (const awakeActive of [true, false]) {
      for (const sample of noiseSamples) {
        const dec = await evaluateVoiceAttention({
          rawText: sample.text,
          wakeWordEnabled: true,
          wakeWords,
          attentionMode: "smart",
          dialogState: "conversation",
          inConversation: true,
          awakeActive,
          acousticEvent: sample.event,
        });
        expect(dec.accept).toBe(false);
      }
    }

    expect(isNoiseOrGarbledFragment("The.", "<|BGM|>")).toBe(true);
    expect(isNoiseOrGarbledFragment("そしす。", "<|Speech|>")).toBe(true);
    expect(isClearConversationCommand("现在不需要测需要去切换的你这吧")).toBe(false);
    expect(isClearConversationCommand("非常累的时候就会站在阳台凑出")).toBe(false);
  });

  test("preserves genuine follow-up smart-home commands and compound exit phrases in conversation mode", async () => {
    const validFollowups = [
      { text: "关闭客厅吸顶灯" },
      { text: "再调亮一点" },
      { text: "声音小一点", event: "<|BGM|>" },
      { text: "换一首歌", event: "<|BGM|>" },
      { text: "把卧室灯也关掉" },
      { text: "顺便打开书房台灯" },
      { text: "把亮度调到80" },
      { text: "暂停", event: "<|BGM|>" },
      { text: "下一首", event: "<|BGM|>" },
      { text: "关了吧" },
      { text: "客厅现在几度" },
      { text: "播放周杰伦的彩虹" },
    ];

    for (const item of validFollowups) {
      const dec = await evaluateVoiceAttention({
        rawText: item.text,
        wakeWordEnabled: true,
        wakeWords,
        attentionMode: "smart",
        dialogState: "conversation",
        inConversation: true,
        awakeActive: false,
        acousticEvent: item.event,
      });
      expect(dec.accept).toBe(true);
    }

    // Compound polite exit phrases exit immediately, while follow-up commands starting with "好了，" are NOT misclassified as exit
    expect(isExplicitExitPhrase("好了，谢谢，不用了。")).toBe(true);
    expect(isExplicitExitPhrase("先这样吧，谢谢你")).toBe(true);
    expect(isExplicitExitPhrase("好了，再把台灯关了")).toBe(false);

    const exitDec = await evaluateVoiceAttention({
      rawText: "好了，谢谢，不用了。",
      wakeWordEnabled: true,
      wakeWords,
      attentionMode: "smart",
      dialogState: "conversation",
      inConversation: true,
    });
    expect(exitDec.accept).toBe(false);
    expect(exitDec.exitConversation).toBe(true);
  });
});

describe("Conversation Mode Reliable Exit Under Ambient Noise / Background Music", () => {
  test("continuous or flickering VAD speech activity cannot extend conversation window indefinitely", async () => {
    const h = await createIsolatedVoiceHarness({ conversationWindowSec: 1 });
    try {
      // 1. Continuous/flickering VAD (simulating constant background singing/music/TV)
      h.vl.enterConversation("wake_only", { speakAck: false });
      expect(h.vl.dialogState).toBe("conversation");
      h.vl.setSpeechInProgress(true);
      expect(h.vl.snapshot().timerPaused).toBe(false);

      // Keep flickering VAD every 400ms as if music/noise keeps triggering Silero VAD
      const start = Date.now();
      let exited = false;
      while (Date.now() - start < 6500) {
        await Bun.sleep(300);
        if (h.vl.dialogState === "standby") {
          exited = true;
          break;
        }
        h.vl.setSpeechInProgress(false);
        await Bun.sleep(100);
        h.vl.setSpeechInProgress(true);
      }

      expect(exited).toBe(true);
      expect(h.vl.snapshot().dialogState).toBe("standby");
      expect(h.vl.snapshot().lastTransitionReason).toBe("timeout");
    } finally {
      await h.cleanup();
    }
  }, 10_000);

  test("repeated non-speech ambient segments suppress speech grace and exit right on base timeout", async () => {
    const fakeEmptyEngine = {
      getStatus: () => ({
        readyForLocalAsr: true,
        readyForSourceSeparation: false,
        readyForDenoise: false,
        readyForVad: false,
        readyForVoiceprint: false,
        readyForWakeWord: false,
        readyForLocalTts: false,
      }),
      openWakeWord: {
        isReady: false,
        getStatus: () => ({ ready: false, prototypeCount: 0, enrolledCount: 0, ttsCount: 0 }),
      },
      transcribeDualTrack: async () => ({
        text: "",
        rawText: "",
        lang: "<|zh|>",
        emotion: "",
        event: "<|BGM|>",
        engine: "sensevoice-dual-raw",
        durationMs: 5,
      }),
      dispose: () => {},
    } as unknown as LocalVoiceEngine;

    const h = await createIsolatedVoiceHarness({ conversationWindowSec: 1 }, fakeEmptyEngine);
    try {
      h.vl.enterConversation("command_done", { speakAck: false });
      expect(h.vl.dialogState).toBe("conversation");

      // Simulate 2 pure-music/noise empty segments while VAD reports speaking=true
      const dummySeg = {
        rawSamples: new Float32Array(16000),
        denoisedSamples: new Float32Array(16000),
        denoiseEngine: "gtcrn-stream",
        inputSnrDb: 0,
        outputSnrDb: 2,
        snrGainDb: 2,
        startSec: 0,
        durationSec: 1,
        forcedRoll: true,
      };
      h.vl.setSpeechInProgress(true);
      await h.vl.processDualTrackSegment(dummySeg);
      await h.vl.processDualTrackSegment(dummySeg);

      // Speech grace is now suppressed -> must exit promptly around the 1s base timeout (well before +3.5s grace!)
      const deadline = Date.now() + 1800;
      while (Date.now() < deadline && h.vl.dialogState === "conversation") {
        await Bun.sleep(50);
      }
      expect(h.vl.dialogState).toBe("standby");
      expect(h.vl.snapshot().lastTransitionReason).toBe("timeout");
    } finally {
      await h.cleanup();
    }
  }, 8_000);

  test("still grants single bounded grace when a real quiet-room user speaks near expiry", async () => {
    const h = await createIsolatedVoiceHarness({ conversationWindowSec: 1 });
    try {
      h.vl.enterConversation("wake_only", { speakAck: false });
      await Bun.sleep(750);
      // Real user starts speaking 250ms before timeout -> bounded grace extends deadline
      h.vl.setSpeechInProgress(true);
      await Bun.sleep(550);
      // Should still be alive inside bounded grace window (1.3s > 1.0s base)
      expect(h.vl.dialogState).toBe("conversation");

      // Real command completes inside grace window -> executes and resets conversation cleanly!
      h.vl.setSpeechInProgress(false);
      const res = await h.vl.handleTranscript("关闭客厅吸顶灯", { isFinal: true });
      expect(res.matched).toBe(true);
      expect(res.command).toBe("关闭客厅吸顶灯");
      expect(await h.demo.powerState("demo-light-living")).toBe(false);
    } finally {
      await h.cleanup();
    }
  }, 8_000);

  test("stale async separation result after conversation timeout cannot resurrect conversation mode", async () => {
    let releaseSep!: () => void;
    const sepGate = new Promise<void>((r) => {
      releaseSep = r;
    });

    const slowSepEngine = {
      getStatus: () => ({
        readyForLocalAsr: true,
        readyForSourceSeparation: true,
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
      sourceSeparator: {
        separateAndRecognize: async () => {
          await sepGate;
          return {
            speechDetected: true,
            text: "打开客厅吸顶灯",
            acousticEvent: "<|Speech|>",
            denoiseEngine: "gtcrn-stream",
            vadEngine: "silero",
            asrEngine: "sensevoice-sep-fast",
            inputSnrDb: 15,
            outputSnrDb: 18,
            snrGainDb: 3,
            detectedSoundTypes: ["speech"],
            detectedSpeakerCount: 1,
            separatedStreams: [],
            acousticWake: null,
            attention: {
              accept: true,
              wokeOnly: false,
              addressed: true,
              inConversation: true,
              confidence: 0.92,
              stage: "fast-followup",
              reason: "stale in-conversation decision",
              wakeWord: null,
              command: "打开客厅吸顶灯",
              usedLlm: false,
              latencyMs: 5,
            },
            stageTimingsMs: {},
            totalMs: 50,
          };
        },
      },
      dispose: () => {},
    } as unknown as LocalVoiceEngine;

    const h = await createIsolatedVoiceHarness(
      { conversationWindowSec: 1, sourceSeparationMode: "auto" },
      slowSepEngine,
    );
    try {
      h.vl.enterConversation("wake_only", { speakAck: false });
      const segPromise = h.vl.processDualTrackSegment({
        rawSamples: new Float32Array(16000),
        denoisedSamples: new Float32Array(16000),
        denoiseEngine: "gtcrn-stream",
        inputSnrDb: 15,
        outputSnrDb: 18,
        snrGainDb: 3,
        startSec: 0,
        durationSec: 1,
        forcedRoll: false,
      });

      // Conversation exits while separation is in-flight
      h.vl.exitConversation("timeout", { speakAck: false });
      expect(h.vl.dialogState).toBe("standby");

      releaseSep();
      const res = await segPromise;
      expect(res.matched).toBe(false);
      expect(h.vl.dialogState).toBe("standby");
    } finally {
      await h.cleanup();
    }
  });

  test("wake-only enters timed window even when conversationWindowSec is 0, and WS close releases TTS timer pause", async () => {
    const demo = new VirtualDemoService();
    server = await startMijiaDeckServer({ mode: "demo", port: 0, service: demo });

    // 1. wake-only with conversationWindowSec=0 & wakeWindowSec=3 (minimum clamp)
    await fetch(`${server.url}/api/agent/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceSeparationMode: "off",
        owwEnabled: false,
        autoSpeakReply: false,
        conversationWindowSec: 0,
        wakeWindowSec: 3,
      }),
    });
    const vl = server.runtime.voiceListener!;
    vl.enterConversation("wake_only", { speakAck: false });
    expect(vl.dialogState).toBe("conversation");
    expect(vl.snapshot().conversationRemainingMs).toBeGreaterThan(0);

    // 2. Manual enter with conversationWindowSec=1 + WS voice_tts_state(true) -> abrupt WS close MUST unpause timer and allow exit!
    await fetch(`${server.url}/api/agent/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationWindowSec: 1 }),
    });
    const wsUrl = server.url.replace(/^http/, "ws") + "/ws";
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("ws open failed"));
    });

    vl.enterConversation("ws_control", { speakAck: false });
    ws.send(JSON.stringify({ type: "voice_tts_state", speaking: true }));
    await Bun.sleep(80);
    expect(vl.snapshot().timerPaused).toBe(true);

    // Abruptly close WebSocket without sending speaking: false
    ws.close();
    const unpauseDeadline = Date.now() + 1000;
    while (Date.now() < unpauseDeadline && vl.snapshot().timerPaused) {
      await Bun.sleep(30);
    }
    expect(vl.snapshot().timerPaused).toBe(false);

    // Resume timer must now fire and exit conversation cleanly (resumeMs >= 3000ms)
    const exitDeadline = Date.now() + 4500;
    while (Date.now() < exitDeadline && vl.dialogState === "conversation") {
      await Bun.sleep(80);
    }
    expect(vl.dialogState).toBe("standby");
    expect(vl.snapshot().lastTransitionReason).toBe("timeout");
  }, 15_000);

  test.if(HAS_BENCH_WAVS)(
    "real ONNX streaming of continuous pop song (clip_026) and TV chatter (clip_066) exits conversation mode cleanly with zero false executions",
    async () => {
      const engine = new LocalVoiceEngine();
      const status = engine.getStatus();
      if (!status.readyForLocalAsr || !status.readyForVad || !status.readyForSourceSeparation) {
        engine.dispose();
        return;
      }

      await engine.warmup({ preloadEnglish: true });
      const h = await createIsolatedVoiceHarness(
        {
          conversationWindowSec: 2,
          maxConsecutiveSidetalk: 3,
          sourceSeparationMode: "auto",
          attentionMode: "smart",
        },
        engine,
      );

      try {
        for (const clipFile of ["clip_026.wav", "clip_066.wav"]) {
          const decoded = decodeWavPcm(new Uint8Array(readFileSync(path.join(BENCH_AUDIO_DIR, clipFile))));
          const pcm =
            decoded.sampleRate === 16000
              ? decoded.samples
              : resampleLinear(decoded.samples, decoded.sampleRate, 16000);

          let matchedCount = 0;
          const session = new VoiceStreamSession({
            localEngine: engine,
            noiseMode: "auto",
            vadSensitivity: "default",
            wakeWords: ["Neo"],
            isInConversation: () => h.vl.dialogState === "conversation",
            onSpeechActivity: (speaking) => h.vl.setSpeechInProgress(speaking),
            onSegmentReady: async (seg) => {
              const res = await h.vl.processDualTrackSegment(seg);
              if (res.matched) matchedCount += 1;
              return res;
            },
          });

          h.vl.enterConversation("wake_only", { speakAck: false });
          expect(h.vl.dialogState).toBe("conversation");

          // Stream real background song / TV chatter frames continuously over real time until timeout/sidetalk exit
          const start = Date.now();
          let pos = 0;
          while (Date.now() - start < 7500 && h.vl.dialogState === "conversation") {
            const end = Math.min(pcm.length, pos + 1024);
            session.pushFloat32Samples(pcm.subarray(pos, end));
            pos = end >= pcm.length ? 0 : end;
            await Bun.sleep(64);
          }
          await session.waitForIdle();
          session.dispose();
          h.vl.setSpeechInProgress(false);

          expect(matchedCount).toBe(0);
          expect(h.vl.dialogState).toBe("standby");
          expect(["timeout", "sidetalk_limit"]).toContain(h.vl.snapshot().lastTransitionReason ?? "");
        }
      } finally {
        await h.cleanup();
      }
    },
    60_000,
  );
});
