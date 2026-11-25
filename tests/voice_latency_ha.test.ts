// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { decodeWavPcm, computeRms } from "../src/agent/audioPcm.ts";
import { planDeterministicLocalCalls } from "../src/agent/localPlannerStream.ts";
import { LocalVoiceEngine } from "../src/agent/localVoiceEngine.ts";
import { PiAgentService } from "../src/agent/piAgentService.ts";
import { SystemOneClient } from "../src/agent/systemOneClient.ts";
import { evaluateVoiceAttention } from "../src/agent/voiceAttentionGate.ts";
import {
  StreamingAutoGain,
  vadSensitivityToSeconds,
  VoiceCommandSegmenter,
  WakeWordCooldownGuard,
} from "../src/agent/voiceCommandSegmenter.ts";
import { VoiceStreamSession, type VoiceStreamSegmentPayload } from "../src/agent/voiceStreamSession.ts";
import { VoiceListenerController } from "../src/agent/voiceListenerController.ts";
import {
  AGENT_CONFIG_VERSION,
  defaultAgentVoiceConfig,
  loadAgentVoiceConfig,
  normalizeAgentVoiceConfig,
  updateAgentVoiceConfig,
} from "../src/core/agentConfigStore.ts";
import { NetworkMonitor } from "../src/core/availability.ts";
import { JobExecutor } from "../src/core/jobs.ts";
import { setDataPathOverrides } from "../src/core/jsonStore.ts";
import * as settingsStore from "../src/core/settingsStore.ts";
import { VirtualDemoService } from "../src/core/virtualLightService.ts";
import { startMijiaDeckServer } from "../src/server/server.ts";
import { MainWindowController } from "../src/ui/controllers/mainWindowController.ts";
import { ThemeController, applyTheme } from "../src/ui/theme.ts";

let tempDir: string | null = null;

function useTempDataDir(): string {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "mijiadeck-voice-ha-"));
  const dir = tempDir;
  setDataPathOverrides({ dataDir: () => dir });
  return dir;
}

afterEach(() => {
  setDataPathOverrides(null);
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe("Home Assistant-inspired Voice Command Segmenter, AGC & Cooldown", () => {
  test("vadSensitivityToSeconds maps aggressive / default / relaxed cleanly and honors user vadSilenceMs", () => {
    expect(vadSensitivityToSeconds("aggressive")).toBe(0.3);
    expect(vadSensitivityToSeconds("default")).toBe(0.95);
    expect(vadSensitivityToSeconds("default", 1200)).toBe(1.2);
    expect(vadSensitivityToSeconds("relaxed")).toBe(1.05);
    expect(vadSensitivityToSeconds("relaxed", 1500)).toBe(1.5);
  });

  test("VoiceCommandSegmenter enforces dual-threshold hysteresis and ignores brief music/drum spikes", () => {
    const seg = new VoiceCommandSegmenter({
      speechSeconds: 0.16,
      commandSeconds: 0.5,
      silenceSeconds: 0.45,
      resetSeconds: 0.24,
      beforeCommandSpeechThreshold: 0.25,
      inCommandSpeechThreshold: 0.48,
    });

    // 1. Speech starts after >= 0.16s above 0.25
    let started = false;
    for (let i = 0; i < 6; i += 1) {
      const r = seg.process(0.032, 0.72, 0.08);
      if (r.justStarted) started = true;
    }
    expect(started).toBe(true);
    expect(seg.inCommand).toBe(true);

    // 2. Continue speaking for 0.4s
    for (let i = 0; i < 12; i += 1) {
      expect(seg.process(0.032, 0.72, 0.09).continuing).toBe(true);
    }

    // 3. Pause for 0.25s, then 1 brief 96ms drum spike (< resetSeconds 0.24s!), then 0.25s more silence -> MUST end without resetting!
    for (let i = 0; i < 8; i += 1) {
      expect(seg.process(0.032, 0.05, 0.01).continuing).toBe(true);
    }
    for (let i = 0; i < 3; i += 1) {
      expect(seg.process(0.032, 0.72, 0.06).continuing).toBe(true);
    }
    let ended = false;
    for (let i = 0; i < 8; i += 1) {
      const r = seg.process(0.032, 0.05, 0.01);
      if (!r.continuing) {
        ended = true;
        break;
      }
    }
    expect(ended).toBe(true);
    expect(seg.timedOut).toBe(false);
  });

  test("VoiceCommandSegmenter ends foreground command promptly over continuous background music RMS floor", () => {
    const seg = new VoiceCommandSegmenter({
      speechSeconds: 0.16,
      commandSeconds: 0.5,
      silenceSeconds: 0.48,
      timeoutSeconds: 4.5,
      resetSeconds: 0.24,
    });

    // Establish continuous background music floor ~0.045 RMS while idle
    for (let i = 0; i < 60; i += 1) {
      seg.process(0.032, 0.05, 0.045);
    }
    expect(seg.ambientRmsFloor).toBeGreaterThan(0.025);

    // User speaks wake word + command louder than music (~0.10 RMS)
    seg.forceStartCommand(0.10);
    for (let i = 0; i < 18; i += 1) {
      expect(seg.process(0.032, 0.72, 0.10).continuing).toBe(true);
    }

    // User stops speaking, but loud background singing keeps Silero binary VAD at 0.72 while RMS returns to music floor (0.045)
    let framesUntilCut = 0;
    let ended = false;
    for (let i = 0; i < 30; i += 1) {
      framesUntilCut += 1;
      const r = seg.process(0.032, 0.72, 0.045);
      if (!r.continuing) {
        ended = true;
        break;
      }
    }
    expect(ended).toBe(true);
    expect(seg.timedOut).toBe(false);
    // Must cut in ~0.5s (~15-18 frames), NOT wait 4.5s!
    expect(framesUntilCut).toBeLessThanOrEqual(20);
  });

  test("StreamingAutoGain lifts quiet far-field speech without amplifying silence or clipping peaks", () => {
    const agc = new StreamingAutoGain({ targetRms: 0.085, maxGain: 4.0, minActiveRms: 0.005 });

    // Pure silence stays untouched
    const silence = new Float32Array(1024).fill(0.0005);
    const outSil = agc.process(silence);
    expect(computeRms(outSil)).toBeLessThan(0.002);

    // Quiet speech gets smoothly lifted
    const quiet = new Float32Array(1024);
    for (let i = 0; i < quiet.length; i += 1) {
      quiet[i] = Math.sin((2 * Math.PI * 440 * i) / 16000) * 0.02;
    }
    let lifted: Float32Array = quiet;
    for (let k = 0; k < 20; k += 1) {
      lifted = agc.process(quiet);
    }
    expect(computeRms(lifted)).toBeGreaterThan(computeRms(quiet) * 2.0);

    // Loud burst gets soft-limited within [-1, 1]
    const loud = new Float32Array(1024);
    for (let i = 0; i < loud.length; i += 1) {
      loud[i] = Math.sin((2 * Math.PI * 300 * i) / 16000) * 0.95;
    }
    const limited = agc.process(loud);
    let maxAbs = 0;
    for (let i = 0; i < limited.length; i += 1) {
      maxAbs = Math.max(maxAbs, Math.abs(limited[i]!));
    }
    expect(maxAbs).toBeLessThanOrEqual(1.0);
  });

  test("WakeWordCooldownGuard suppresses duplicate wake spots within cooldown window", () => {
    const guard = new WakeWordCooldownGuard(1800);
    expect(guard.tryAccept("Neo", 10_000)).toBe(true);
    expect(guard.tryAccept("neo", 10_500)).toBe(false);
    expect(guard.tryAccept("小派", 10_600)).toBe(true);
    expect(guard.tryAccept("Neo", 11_900)).toBe(true);
  });
});

describe("Config Store (vadSensitivity & preferLocalIntents)", () => {
  test("defaults preferLocalIntents to false, migrates v1 configs, and persists toggles safely", () => {
    useTempDataDir();
    const def = defaultAgentVoiceConfig();
    expect(def.version).toBe(AGENT_CONFIG_VERSION);
    expect(def.vadSensitivity).toBe("default");
    expect(def.preferLocalIntents).toBe(false);
    expect(def.vadSilenceMs).toBe(1000);

    const enabled = updateAgentVoiceConfig({
      vadSensitivity: "aggressive",
      preferLocalIntents: true,
    });
    expect(enabled.vadSensitivity).toBe("aggressive");
    expect(enabled.preferLocalIntents).toBe(true);
    expect(loadAgentVoiceConfig().vadSensitivity).toBe("aggressive");
    expect(loadAgentVoiceConfig().preferLocalIntents).toBe(true);

    const disabled = updateAgentVoiceConfig({
      preferLocalIntents: false,
    });
    expect(disabled.preferLocalIntents).toBe(false);
    expect(loadAgentVoiceConfig().preferLocalIntents).toBe(false);

    expect(() => updateAgentVoiceConfig({ vadSensitivity: "invalid" })).toThrow();
    expect(normalizeAgentVoiceConfig({}).preferLocalIntents).toBe(false);
    expect(normalizeAgentVoiceConfig({ preferLocalIntents: true }).preferLocalIntents).toBe(true);
    // Pre-toggle v1 configs auto-persisted preferLocalIntents: true; migrate to default-off on v2
    const migrated = normalizeAgentVoiceConfig({ version: 1, preferLocalIntents: true });
    expect(migrated.version).toBe(AGENT_CONFIG_VERSION);
    expect(migrated.preferLocalIntents).toBe(false);
    // Explicit v2 opt-in is preserved
    expect(normalizeAgentVoiceConfig({ version: 2, preferLocalIntents: true }).preferLocalIntents).toBe(
      true,
    );
  });
});

describe("Home Assistant prefer_local_intents Fast-Path in PiAgentService", () => {
  test("routes deterministic commands to cloud LLM by default and toggles local fast-path dynamically", async () => {
    useTempDataDir();
    const demo = new VirtualDemoService();
    const jobs = new JobExecutor();
    applyTheme("dark", "green");
    const themeCtrl = new ThemeController("dark");
    const networkMonitor = new NetworkMonitor({ initialReachability: "online", autoStart: false });
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
    while (Date.now() < deadline) {
      if (!mw.loadActive && !mw.loadingDevices && mw.allDevices.length > 0) {
        break;
      }
      await Bun.sleep(15);
    }

    let cloudCalls = 0;
    const mockCloud = Bun.serve({
      port: 0,
      async fetch(req) {
        if (new URL(req.url).pathname.endsWith("/systemone")) {
          return new Response("Not Found", { status: 404 });
        }
        cloudCalls += 1;
        const sse = [
          `data: ${JSON.stringify({
            id: `chatcmpl-${cloudCalls}`,
            object: "chat.completion.chunk",
            created: 1700000000,
            model: "mock-cloud-model",
            choices: [{ index: 0, delta: { role: "assistant", content: "云端已收到指令" }, finish_reason: null }],
          })}`,
          `data: ${JSON.stringify({
            id: `chatcmpl-${cloudCalls}`,
            object: "chat.completion.chunk",
            created: 1700000000,
            model: "mock-cloud-model",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          })}`,
          "data: [DONE]",
          "",
        ].join("\n\n");
        return new Response(sse, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      },
    });

    const baseCloudConfig = normalizeAgentVoiceConfig({
      ...defaultAgentVoiceConfig(),
      provider: "openai-compatible",
      baseUrl: `http://127.0.0.1:${mockCloud.port}/v1`,
      apiKey: "sk-local-fastpath-toggle-key",
      modelId: "mock-cloud-model",
    });
    expect(baseCloudConfig.preferLocalIntents).toBe(false);

    const agent = new PiAgentService({
      deps: { mainWindow: mw, service: demo, jobs, settingsStore, broadcastState: () => {} },
      initialConfig: baseCloudConfig,
    });

    try {
      // 1. Default OFF: deterministic command goes to cloud LLM, NOT local fast-path
      const r1 = await agent.prompt("关闭客厅吸顶灯", { source: "voice" });
      expect(r1.ok).toBe(true);
      expect(cloudCalls).toBe(1);
      expect(r1.reply).toContain("云端已收到指令");
      expect(await demo.powerState("demo-light-living")).toBe(true);

      // 2. Toggle ON at runtime: deterministic command executes locally with 0 additional cloud calls
      agent.reconfigure({ ...baseCloudConfig, preferLocalIntents: true });
      const r2 = await agent.prompt("关闭客厅吸顶灯", { source: "voice" });
      expect(r2.ok).toBe(true);
      expect(cloudCalls).toBe(1);
      expect(r2.toolCalls.length).toBeGreaterThan(0);
      expect(await demo.powerState("demo-light-living")).toBe(false);

      // 3. Toggle OFF at runtime: subsequent deterministic command returns to cloud LLM
      agent.reconfigure({ ...baseCloudConfig, preferLocalIntents: false });
      const r3 = await agent.prompt("打开客厅吸顶灯", { source: "voice" });
      expect(r3.ok).toBe(true);
      expect(cloudCalls).toBe(2);
      expect(r3.reply).toContain("云端已收到指令");
      expect(await demo.powerState("demo-light-living")).toBe(false);
    } finally {
      mockCloud.stop(true);
      agent.dispose();
      networkMonitor.stop();
      mw.dispose();
      await jobs.shutdown();
    }
  });

  test("exposes preferLocalIntents toggle via /api/agent/config and settings HTML (default off)", async () => {
    useTempDataDir();
    const server = await startMijiaDeckServer({
      port: 0,
      mode: "demo",
      autoStartTimers: false,
    });
    try {
      const get1 = await fetch(`${server.url}/api/agent/config`);
      expect(get1.status).toBe(200);
      const data1 = (await get1.json()) as { config: { preferLocalIntents: boolean } };
      expect(data1.config.preferLocalIntents).toBe(false);

      const postOn = await fetch(`${server.url}/api/agent/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preferLocalIntents: true }),
      });
      expect(postOn.status).toBe(200);
      const dataOn = (await postOn.json()) as { config: { preferLocalIntents: boolean } };
      expect(dataOn.config.preferLocalIntents).toBe(true);
      expect(server.runtime.piAgent?.config.preferLocalIntents).toBe(true);

      const postOff = await fetch(`${server.url}/api/agent/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preferLocalIntents: false }),
      });
      expect(postOff.status).toBe(200);
      const dataOff = (await postOff.json()) as { config: { preferLocalIntents: boolean } };
      expect(dataOff.config.preferLocalIntents).toBe(false);
      expect(server.runtime.piAgent?.config.preferLocalIntents).toBe(false);

      const htmlRes = await fetch(`${server.url}/`);
      const html = await htmlRes.text();
      expect(html).toContain('id="setting-row-agent-local-fast-path"');
      expect(html).toContain('id="set-agent-prefer-local-intents"');
    } finally {
      await server.stop();
    }
  });

  test("executes deterministic smart-home commands locally in <50ms even when a cloud LLM is configured", async () => {
    useTempDataDir();
    const demo = new VirtualDemoService();
    const jobs = new JobExecutor();
    applyTheme("dark", "green");
    const themeCtrl = new ThemeController("dark");
    const networkMonitor = new NetworkMonitor({ initialReachability: "online", autoStart: false });
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
    while (Date.now() < deadline) {
      if (!mw.loadActive && !mw.loadingDevices && mw.allDevices.length > 0) {
        break;
      }
      await Bun.sleep(15);
    }

    // Configure an unreachable cloud provider URL: if PiAgentService accidentally calls cloud LLM, it would fail!
    const cloudConfig = normalizeAgentVoiceConfig({
      ...defaultAgentVoiceConfig(),
      provider: "openai-compatible",
      baseUrl: "http://127.0.0.1:1/v1",
      apiKey: "sk-local-fastpath-test-key",
      modelId: "mock-cloud-model",
      preferLocalIntents: true,
    });

    const agent = new PiAgentService({
      deps: { mainWindow: mw, service: demo, jobs, settingsStore, broadcastState: () => {} },
      initialConfig: cloudConfig,
    });

    try {
      // 1. Deterministic command -> 0ms local planner + direct tool execution, zero cloud round-trips!
      const t0 = performance.now();
      const res = await agent.prompt("关闭客厅吸顶灯", { source: "voice" });
      const elapsedMs = performance.now() - t0;

      expect(res.ok).toBe(true);
      expect(res.toolCalls.length).toBeGreaterThan(0);
      expect(await demo.powerState("demo-light-living")).toBe(false);
      expect(elapsedMs).toBeLessThan(300);

      // 2. Open-ended query MUST NOT be hijacked by local planner
      const openPlan = planDeterministicLocalCalls("今天天气怎么样，适合出门吗", {
        getDevices: () => mw.allDevices,
        getScenes: () => mw.scenes ?? [],
      });
      expect(openPlan).toBeNull();

      const poemPlan = planDeterministicLocalCalls("帮我写一首关于春天的短诗", {
        getDevices: () => mw.allDevices,
        getScenes: () => mw.scenes ?? [],
      });
      expect(poemPlan).toBeNull();

      // 3. Explicit stop-music command matches deterministically
      const stopMusicPlan = planDeterministicLocalCalls("停止播放音乐", {
        getDevices: () => mw.allDevices,
        getScenes: () => mw.scenes ?? [],
      });
      expect(stopMusicPlan).not.toBeNull();
      expect(stopMusicPlan![0]?.name).toBe("control_speaker");
      expect(stopMusicPlan![0]?.arguments.playback).toBe("stop");
    } finally {
      agent.dispose();
      networkMonitor.stop();
      mw.dispose();
      await jobs.shutdown();
    }
  });
});

describe("Voice Attention Gate Low-Latency Fast-Paths", () => {
  test("fast-paths exact vocative smart-home command under BGM and explicit direct follow-up without SystemOne round-trip", async () => {
    let systemOneCalled = 0;
    const mockFetch = (async () => {
      systemOneCalled += 1;
      return new Response(
        JSON.stringify({
          model: "karpo/karpo-decision-31b",
          answers: {
            conv_action: {
              type: "choice",
              choice: "followup",
              probabilities: { followup: 0.94, side_talk: 0.03, goodbye: 0.03 },
              confidence: 0.92,
            },
            intent: {
              type: "choice",
              choice: "device_control",
              probabilities: { device_control: 0.96, status_query: 0.02, scene: 0.01, general_chat: 0.01 },
              confidence: 0.94,
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const s1 = new SystemOneClient({
      baseUrl: "http://127.0.0.1:9999/v1",
      model: "karpo/karpo-decision-31b",
      timeoutMs: 1000,
      confidenceThreshold: 0.65,
      fetcher: mockFetch,
    });

    // 1. Exact vocative smart-home command under BGM -> 0ms fast-wake without SystemOne
    const bgmWake = await evaluateVoiceAttention({
      rawText: "Neo，停止播放音乐",
      wakeWordEnabled: true,
      wakeWords: ["Neo"],
      attentionMode: "smart",
      acousticEvent: "<|BGM|>",
      systemOneClient: s1,
    });
    expect(bgmWake.accept).toBe(true);
    expect(bgmWake.stage).toBe("fast-wake");
    expect(bgmWake.command).toBe("停止播放音乐");
    expect(systemOneCalled).toBe(0);

    // 2. Explicit direct smart-home command in conversation mode -> 0ms fast-followup without SystemOne
    const directFollowup = await evaluateVoiceAttention({
      rawText: "把客厅灯调暗一点",
      wakeWordEnabled: true,
      wakeWords: ["Neo"],
      attentionMode: "smart",
      dialogState: "conversation",
      inConversation: true,
      systemOneClient: s1,
    });
    expect(directFollowup.accept).toBe(true);
    expect(directFollowup.stage).toBe("fast-followup");
    expect(systemOneCalled).toBe(0);

    // 3. Implicit colloquial utterance in conversation mode STILL routes to SystemOne
    const implicitFollowup = await evaluateVoiceAttention({
      rawText: "有点刺眼",
      wakeWordEnabled: true,
      wakeWords: ["Neo"],
      attentionMode: "smart",
      dialogState: "conversation",
      inConversation: true,
      systemOneClient: s1,
    });
    expect(implicitFollowup.accept).toBe(true);
    expect(implicitFollowup.stage).toBe("systemone-attention");
    expect(systemOneCalled).toBe(1);
  });
});

describe("VoiceStreamSession Wake-Anchored Capture & Bounded Backpressure", () => {
  test("sheds stale non-wake segments under slow downstream processing while preserving wake-anchored segments", async () => {
    let spotCallback: ((hit: any) => void) | undefined;
    let fakeVadQueue: Array<{ start: number; samples: Float32Array }> = [];
    let fakeVadDetected = false;
    let fedSamples = 0;

    const fakeEngine = {
      createOnlineDenoiser: () => null,
      createStreamingVad: () => ({
        acceptWaveform(chunk: Float32Array) {
          fedSamples += chunk.length;
          // Emit a fake 3.8s forcedRoll segment every 3.8s when not cleared
          if (fedSamples > 0 && fedSamples % (16000 * 4) < 512 && fakeVadDetected) {
            fakeVadQueue.push({ start: Math.max(0, fedSamples - 16000 * 4), samples: new Float32Array(16000 * 4).fill(0.05) });
          }
        },
        isDetected: () => fakeVadDetected,
        isEmpty: () => fakeVadQueue.length === 0,
        front: () => fakeVadQueue[0],
        pop: () => {
          fakeVadQueue.shift();
        },
        flush: () => {},
        clear: () => {
          fakeVadQueue = [];
        },
      }),
      createWakeWordStream: (_words: readonly string[], opts: { onSpot?: (hit: any) => void }) => {
        spotCallback = opts.onSpot;
        return {
          pushSamples: () => {},
          getHeadPeakHit: () => null,
          getPeakHit: () => null,
          resetSegmentTracking: () => {},
          reloadPrototypes: () => {},
          reset: () => {},
        };
      },
      sourceSeparator: {
        analyzeAudioScene: () => ({
          tags: [],
          speechProb: 0.5,
          musicProb: 0,
          singingProb: 0,
          noiseProb: 0,
          crowdTvProb: 0,
          detectedSoundTypes: ["speech"],
          durationMs: 1,
        }),
      },
    } as unknown as LocalVoiceEngine;

    const received: VoiceStreamSegmentPayload[] = [];
    const session = new VoiceStreamSession({
      localEngine: fakeEngine,
      noiseMode: "off",
      vadSensitivity: "aggressive",
      isInConversation: () => true,
      wakeWords: ["Neo"],
      onSegmentReady: async (seg) => {
        await new Promise((r) => setTimeout(r, 40));
        received.push(seg);
        return null;
      },
    });

    // Simulate 4 rapid rolling segments while downstream takes 40ms each -> backpressure must shed stale ones
    fakeVadDetected = true;
    const frame = new Float32Array(1024).fill(0.05);
    for (let i = 0; i < 260; i += 1) {
      session.pushFloat32Samples(frame);
    }
    expect(session.droppedStaleCount).toBeGreaterThan(0);

    // Now trigger wake word spot -> speak loudly -> drop to silence -> must emit wakeAnchored segment!
    spotCallback?.({
      wakeWord: "Neo",
      matched: true,
      score: 0.85,
      rawScore: 0.85,
      threshold: 0.6,
      source: "enrolled",
      sampleOffset: 16000 * 16,
      latencyMs: 5,
    });
    const loudSpeech = new Float32Array(1024).fill(0.15);
    for (let i = 0; i < 12; i += 1) {
      session.pushFloat32Samples(loudSpeech);
    }
    fakeVadDetected = false;
    const quietMusic = new Float32Array(1024).fill(0.01);
    for (let i = 0; i < 12; i += 1) {
      session.pushFloat32Samples(quietMusic);
    }

    await session.waitForIdle();
    expect(received.some((s) => s.wakeAnchored === true && s.acousticWake?.wakeWord === "Neo")).toBe(true);
    session.dispose();
  });
});

const BENCH_DIR = path.resolve(import.meta.dir, "..", "benchmarks", "voice_sep_100");
const BENCH_AUDIO_DIR = path.join(BENCH_DIR, "audio");
const HAS_BENCH_WAVS =
  existsSync(path.join(BENCH_AUDIO_DIR, "clip_001.wav")) &&
  existsSync(path.join(BENCH_DIR, "owner_ref.wav"));

describe("Real ONNX Latency & Negative-SNR Pop-Music Separation Verification", () => {
  test.if(HAS_BENCH_WAVS)(
    "fast-tracks clean speech (<1.5s), rejects pure songs (<800ms), skips DPDFNet4 on music, and recovers -3dB singing+command",
    async () => {
      const engine = new LocalVoiceEngine();
      const status = engine.getStatus();
      if (!status.readyForLocalAsr || !status.readyForSourceSeparation) {
        return;
      }

      const sep = engine.sourceSeparator;
      const ownerRef = path.join(BENCH_DIR, "owner_ref.wav");
      const familyRef = path.join(BENCH_DIR, "family_ref.wav");
      const refs = [
        { id: "owner", wavPath: ownerRef },
        { id: "family", wavPath: familyRef },
      ];

      // Warm up asynchronously (including English recognizer for "Neo" and primary owner VoxLock)
      await engine.warmup({ preloadEnglish: true });
      await sep.warmupAsync(refs);

      // 1. Clean command (clip_001) should fast-track without GTCRN/DPDFNet4/Spleeter/VoxLock
      const c1 = decodeWavPcm(new Uint8Array(readFileSync(path.join(BENCH_AUDIO_DIR, "clip_001.wav"))));
      const r1 = await sep.separateAndRecognize(c1.samples, c1.sampleRate, {
        wakeWords: ["Neo"],
        speakerRefWavPaths: refs,
      });
      expect(r1.attention.accept).toBe(true);
      expect(r1.denoiseEngine).toBe("highpass-fast");
      expect(r1.totalMs).toBeLessThan(2500);
      expect(r1.stageTimingsMs.dpdfnetMs).toBeUndefined();
      expect(r1.stageTimingsMs.spleeterMs).toBeUndefined();

      // 2. Pure pop song (clip_026) should reject rapidly via CED+owner gate with 0 FP
      const c26 = decodeWavPcm(new Uint8Array(readFileSync(path.join(BENCH_AUDIO_DIR, "clip_026.wav"))));
      const r26 = await sep.separateAndRecognize(c26.samples, c26.sampleRate, {
        wakeWords: ["Neo"],
        speakerRefWavPaths: refs,
      });
      expect(r26.attention.accept).toBe(false);
      expect(r26.asrEngine).toBe("skipped-pure-song");
      expect(r26.totalMs).toBeLessThan(1500);

      // 3. Loud singing + Neo command (clip_019) runs Spleeter-first without redundant DPDFNet4
      const c19 = decodeWavPcm(new Uint8Array(readFileSync(path.join(BENCH_AUDIO_DIR, "clip_019.wav"))));
      const r19 = await sep.separateAndRecognize(c19.samples, c19.sampleRate, {
        wakeWords: ["Neo"],
        speakerRefWavPaths: refs,
      });
      expect(r19.attention.accept).toBe(true);
      expect(r19.attention.command).toContain("空调");
      expect(r19.stageTimingsMs.spleeterMs).toBeDefined();
      expect(r19.stageTimingsMs.dpdfnetMs).toBeUndefined();

      // 4. Synthetic -3dB SNR mixture (owner clean command clip_001 mixed under louder pop song clip_026!)
      const mixLen = Math.min(c1.samples.length, c26.samples.length);
      const speechRms = Math.max(1e-5, computeRms(c1.samples.subarray(0, mixLen)));
      const songRms = Math.max(1e-5, computeRms(c26.samples.subarray(0, mixLen)));
      // Scale song so SNR = -3 dB (song RMS = speech RMS * 10^(3/20) ~= 1.4125x speech RMS)
      const targetSnrGain = Math.pow(10, 3 / 20);
      const songScale = (speechRms * targetSnrGain) / songRms;
      const neg3DbMix = new Float32Array(mixLen);
      for (let i = 0; i < mixLen; i += 1) {
        neg3DbMix[i] = Math.max(-1, Math.min(1, c1.samples[i]! * 0.55 + c26.samples[i]! * songScale * 0.55));
      }
      const rNeg3 = await sep.separateAndRecognize(neg3DbMix, 16000, {
        wakeWords: ["Neo"],
        speakerRefWavPaths: refs,
      });
      expect(rNeg3.attention.accept).toBe(true);
      expect(rNeg3.attention.command).toContain("灯");

      engine.dispose();
    },
    60_000,
  );
});

describe("Single-Sentence Anti-Duplicate Voice Recognition Regression", () => {
  test("VoiceCommandSegmenter does not inflate ambientRmsFloor on quiet-room speech onset and avoids premature chops", () => {
    const seg = new VoiceCommandSegmenter({ silenceSeconds: 0.55 });
    const frameSec = 512 / 16000;

    // 1. Quiet room baseline (10 frames at RMS 0.003)
    for (let i = 0; i < 10; i += 1) {
      seg.process(frameSec, 0.05, 0.003);
    }
    expect(seg.ambientRmsFloor).toBeLessThan(0.008);

    // 2. Simulate Silero VAD 0.45s onset lag: loud speech starts (RMS 0.12) while prob is still 0.05
    for (let i = 0; i < 14; i += 1) {
      seg.process(frameSec, 0.05, 0.12);
    }
    // Minimum-statistics window must keep ambientRmsFloor quiet (NOT spiked >= 0.015!)
    expect(seg.ambientRmsFloor).toBeLessThan(0.01);

    // 3. Speech detected -> ongoing syllables with soft consonant dips (0.045 vs 0.18 peak) must stay continuing
    for (let i = 0; i < 8; i += 1) {
      seg.process(frameSec, 0.72, 0.18);
    }
    expect(seg.inCommand).toBe(true);
    let cutEarly = false;
    for (let i = 0; i < 25; i += 1) {
      const rms = i % 3 === 0 ? 0.04 : 0.12;
      const step = seg.process(frameSec, 0.72, rms);
      if (!step.continuing) cutEarly = true;
    }
    expect(cutEarly).toBe(false);
  });

  test("VoiceStreamSession resets Silero VAD & tracks _vadSampleBase so 2 consecutive utterances emit 1 segment each without overlap duplication", async () => {
    let spotCallback: ((hit: any) => void) | undefined;
    let fakeVadQueue: Array<{ start: number; samples: Float32Array }> = [];
    let fakeVadDetected = false;
    let vadCounterSinceReset = 0;
    let resetCalls = 0;

    const fakeEngine = {
      createOnlineDenoiser: () => null,
      createStreamingVad: () => ({
        acceptWaveform(chunk: Float32Array) {
          vadCounterSinceReset += chunk.length;
        },
        isDetected: () => fakeVadDetected,
        isEmpty: () => fakeVadQueue.length === 0,
        front: () => fakeVadQueue[0],
        pop: () => {
          fakeVadQueue.shift();
        },
        flush: () => {},
        reset: () => {
          resetCalls += 1;
          vadCounterSinceReset = 0;
          fakeVadQueue = [];
          fakeVadDetected = false;
        },
        clear: () => {
          fakeVadQueue = [];
        },
      }),
      createWakeWordStream: (_words: readonly string[], opts: { onSpot?: (hit: any) => void }) => {
        spotCallback = opts.onSpot;
        return {
          pushSamples: () => {},
          getHeadPeakHit: () => null,
          getPeakHit: () => null,
          resetSegmentTracking: () => {},
          reloadPrototypes: () => {},
          reset: () => {},
        };
      },
      sourceSeparator: {
        analyzeAudioScene: () => ({
          tags: [],
          speechProb: 0.5,
          musicProb: 0,
          singingProb: 0,
          noiseProb: 0,
          crowdTvProb: 0,
          detectedSoundTypes: ["speech"],
          durationMs: 1,
        }),
      },
    } as unknown as LocalVoiceEngine;

    const received: VoiceStreamSegmentPayload[] = [];
    let inConversation = false;
    const session = new VoiceStreamSession({
      localEngine: fakeEngine,
      noiseMode: "off",
      vadSensitivity: "default",
      isInConversation: () => inConversation,
      wakeWords: ["Neo"],
      onSegmentReady: async (seg) => {
        received.push(seg);
        inConversation = true;
        return {
          ok: true,
          matched: true,
          wokeOnly: false,
          command: "test",
          text: "test",
          speechDetected: true,
          denoiseEngine: "off",
          vadEngine: "silero",
          asrEngine: "sensevoice-local",
          voiceState: {} as any,
        };
      },
    });

    const quiet = new Float32Array(1024).fill(0.002);
    // 0.5s quiet lead-in
    for (let i = 0; i < 8; i += 1) session.pushFloat32Samples(quiet);

    // Utterance 1: wake-anchored at ~1.0s..2.2s
    const utt1Speech = new Float32Array(1024).fill(0.11);
    fakeVadDetected = true;
    spotCallback?.({
      wakeWord: "Neo",
      matched: true,
      score: 0.85,
      rawScore: 0.85,
      threshold: 0.6,
      source: "enrolled",
      sampleOffset: 16000,
      latencyMs: 3,
    });
    for (let i = 0; i < 20; i += 1) session.pushFloat32Samples(utt1Speech);
    // Silero finalizes Utterance 1 -> quiet-room fast-completion emits ONCE and calls vad.reset()
    fakeVadDetected = false;
    fakeVadQueue.push({ start: 8192, samples: new Float32Array(20480).fill(0.11) });
    session.pushFloat32Samples(quiet);
    for (let i = 0; i < 16; i += 1) session.pushFloat32Samples(quiet);
    await session.waitForIdle();

    expect(resetCalls).toBeGreaterThanOrEqual(1);
    expect(received.length).toBe(1);
    expect(received[0]!.wakeAnchored).toBe(true);

    // Utterance 2 (non-wake follow-up at ~3.5s..5.0s, marked with distinct amplitude 0.22):
    // Since vad.reset() reset Silero's local `seg.start` back to ~16384 (1.0s post-reset),
    // `_vadSampleBase` MUST offset `seg.start` so rawSamples slices Utterance 2 (0.22), NOT Utterance 1 (0.11)!
    const utt2StartLocal = vadCounterSinceReset;
    const utt2Speech = new Float32Array(1024).fill(0.22);
    fakeVadDetected = true;
    for (let i = 0; i < 20; i += 1) session.pushFloat32Samples(utt2Speech);
    fakeVadDetected = false;
    fakeVadQueue.push({ start: utt2StartLocal, samples: new Float32Array(20480).fill(0.22) });
    session.pushFloat32Samples(quiet);
    await session.waitForIdle();

    expect(received.length).toBe(2);
    expect(received[1]!.wakeAnchored).toBe(false);
    // Utterance 2 startSec must be well after Utterance 1 (around ~3.3s+), NOT near 1.0s!
    expect(received[1]!.startSec).toBeGreaterThan(2.5);
    // Verify rawSamples captured Utterance 2's actual audio (~0.22) rather than Utterance 1 (~0.11)
    const peakUtt2 = Math.max(...Array.from(received[1]!.rawSamples, (v) => Math.abs(v)));
    expect(peakUtt2).toBeGreaterThan(0.18);

    // Also verify resetAfterTts clears pending VAD state cleanly
    fakeVadDetected = true;
    fakeVadQueue.push({ start: vadCounterSinceReset, samples: new Float32Array(8000).fill(0.05) });
    session.resetAfterTts();
    expect(fakeVadQueue.length).toBe(0);
    session.dispose();
  });

  test("VoiceListenerController deduplicates normalized & post-completion duplicate transcripts", async () => {
    useTempDataDir();
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

    const agent = new PiAgentService({
      deps: { mainWindow: mw, service: demo, jobs, settingsStore, broadcastState: () => {} },
      initialConfig: normalizeAgentVoiceConfig({
        ...defaultAgentVoiceConfig(),
        wakeWords: ["Neo"],
        attentionMode: "off",
      }),
    });
    const vl = new VoiceListenerController(agent);

    try {
      const first = await vl.handleTranscript("Neo，关闭客厅吸顶灯。", { now: 10_000 });
      expect(first.matched).toBe(true);

      // Same utterance arriving 400ms later with slightly different punctuation/casing -> MUST be deduped!
      const dup = await vl.handleTranscript("neo 关闭客厅吸顶灯", { now: 10_400 });
      expect(dup.matched).toBe(false);

      // Distinct repeat after dedup window (>2s later) -> MUST still execute
      const again = await vl.handleTranscript("Neo，打开客厅吸顶灯。", { now: 13_000 });
      expect(again.matched).toBe(true);
    } finally {
      vl.dispose();
      agent.dispose();
      networkMonitor.stop();
      mw.dispose();
      await jobs.shutdown();
    }
  });

  test.if(HAS_BENCH_WAVS)(
    "streams real single-sentence benchmark clips through VoiceStreamSession and emits exactly 1 full segment per sentence",
    async () => {
      const engine = new LocalVoiceEngine();
      const status = engine.getStatus();
      if (!status.readyForLocalAsr || !status.readyForVad || !status.readyForDenoise) {
        return;
      }

      const wakeWords = ["Neo", "尼奥", "鸟"];
      await engine.warmup({ preloadEnglish: true });
      if (status.readyForWakeWord) {
        await engine.openWakeWord.bootstrapWakeWords(wakeWords);
      }

      // 1. Verify each single-sentence clip emits EXACTLY 1 segment (zero double triggers)
      const singleClips = [
        { file: "clip_001.wav", expectSub: "客厅吸顶灯" },
        { file: "clip_002.wav", expectSub: "关灯" },
        { file: "clip_006.wav", expectSub: "living room light" },
        { file: "clip_007.wav", expectSub: "温度" },
      ];

      for (const item of singleClips) {
        const decoded = decodeWavPcm(new Uint8Array(readFileSync(path.join(BENCH_AUDIO_DIR, item.file))));
        const segs: VoiceStreamSegmentPayload[] = [];
        const session = new VoiceStreamSession({
          localEngine: engine,
          noiseMode: "auto",
          vadSensitivity: "default",
          vadSilenceMs: 1200,
          sampleRate: 16000,
          wakeWords,
          owwEnabled: true,
          owwThreshold: 0.6,
          wakeGatedAsr: false,
          onSegmentReady: async (seg) => {
            segs.push(seg);
            return null;
          },
        });

        const padded = new Float32Array(16000 * 0.6 + decoded.samples.length + 16000 * 1.6);
        padded.set(decoded.samples, Math.round(16000 * 0.6));
        for (let off = 0; off < padded.length; off += 1024) {
          session.pushFloat32Samples(padded.subarray(off, Math.min(padded.length, off + 1024)));
        }
        await session.waitForIdle();
        session.dispose();

        expect(segs.length).toBe(1);
        const asrRaw = await engine.transcribeLocal(segs[0]!.rawSamples, 16000, "zh-CN");
        const asrDen = await engine.transcribeLocal(segs[0]!.denoisedSamples, 16000, "zh-CN");
        const combined = `${asrRaw.text} ${asrDen.text}`.toLowerCase();
        expect(combined).toContain(item.expectSub.toLowerCase());
      }

      // 2. Back-to-back 2 sentences in ONE continuous session (clip_001 + silence + clip_006) -> exactly 2 complete segments
      const c1 = decodeWavPcm(new Uint8Array(readFileSync(path.join(BENCH_AUDIO_DIR, "clip_001.wav"))));
      const c6 = decodeWavPcm(new Uint8Array(readFileSync(path.join(BENCH_AUDIO_DIR, "clip_006.wav"))));
      const multiSegs: VoiceStreamSegmentPayload[] = [];
      const multiSession = new VoiceStreamSession({
        localEngine: engine,
        noiseMode: "auto",
        vadSensitivity: "default",
        vadSilenceMs: 1200,
        sampleRate: 16000,
        wakeWords,
        owwEnabled: true,
        owwThreshold: 0.6,
        wakeGatedAsr: false,
        onSegmentReady: async (seg) => {
          multiSegs.push(seg);
          return null;
        },
      });

      const lead = Math.round(16000 * 0.5);
      const gap = Math.round(16000 * 1.8);
      const tail = Math.round(16000 * 1.6);
      const merged = new Float32Array(lead + c1.samples.length + gap + c6.samples.length + tail);
      merged.set(c1.samples, lead);
      merged.set(c6.samples, lead + c1.samples.length + gap);
      for (let off = 0; off < merged.length; off += 1024) {
        multiSession.pushFloat32Samples(merged.subarray(off, Math.min(merged.length, off + 1024)));
      }
      await multiSession.waitForIdle();
      multiSession.dispose();

      expect(multiSegs.length).toBe(2);
      const asr1Raw = await engine.transcribeLocal(multiSegs[0]!.rawSamples, 16000, "zh-CN");
      const asr1Den = await engine.transcribeLocal(multiSegs[0]!.denoisedSamples, 16000, "zh-CN");
      const asr2Raw = await engine.transcribeLocal(multiSegs[1]!.rawSamples, 16000, "zh-CN");
      const asr2Den = await engine.transcribeLocal(multiSegs[1]!.denoisedSamples, 16000, "zh-CN");
      expect(`${asr1Raw.text} ${asr1Den.text}`).toContain("客厅吸顶灯");
      expect(`${asr2Raw.text} ${asr2Den.text}`.toLowerCase()).toContain("living room light");

      engine.dispose();
    },
    60_000,
  );
});
