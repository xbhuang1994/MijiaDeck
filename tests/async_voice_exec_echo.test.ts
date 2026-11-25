// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 语音对话 / 任务执行 / 播报异步解耦与多层回声消除综合回归测试

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai";
import { AcousticEchoCanceller } from "../src/agent/echoCanceller.ts";
import {
  TtsEchoGuard,
  computeEnhancedEchoOverlap,
  evaluateTtsEcho,
  normalizeTextForEchoMatch,
} from "../src/agent/echoGuard.ts";
import { LocalVoiceEngine } from "../src/agent/localVoiceEngine.ts";
import { PiAgentService } from "../src/agent/piAgentService.ts";
import { evaluateVoiceAttention } from "../src/agent/voiceAttentionGate.ts";
import { VoiceListenerController } from "../src/agent/voiceListenerController.ts";
import { VoiceStreamSession } from "../src/agent/voiceStreamSession.ts";
import {
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
import { startMijiaDeckServer, type MijiaDeckServer } from "../src/server/server.ts";
import { MainWindowController } from "../src/ui/controllers/mainWindowController.ts";
import { ThemeController, applyTheme } from "../src/ui/theme.ts";

let tmpDir = "";
let activeServer: MijiaDeckServer | null = null;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "mijiadeck-async-echo-"));
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

/** Deterministic LCG PRNG for reproducible acoustic echo tests. */
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

async function createAsyncTestHarness(options: {
  customStreamFn?: ConstructorParameters<typeof PiAgentService>[0]["customStreamFn"];
  customModel?: ConstructorParameters<typeof PiAgentService>[0]["customModel"];
  configOverrides?: Record<string, unknown>;
} = {}) {
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
    wakeWords: ["小派", "Neo"],
    autoSpeakReply: true,
    asyncVoicePipeline: true,
    echoCancellationMode: "auto",
    bargeInDuckingEnabled: true,
    sourceSeparationMode: "off",
    owwEnabled: false,
    ...options.configOverrides,
  });

  const agent = new PiAgentService({
    deps: {
      mainWindow: mw,
      service: demo,
      jobs,
      settingsStore,
      broadcastState: () => {},
    },
    initialConfig: cfg,
    ...(options.customStreamFn ? { customStreamFn: options.customStreamFn } : {}),
    ...(options.customModel ? { customModel: options.customModel } : {}),
  });
  const vl = new VoiceListenerController(agent);

  const cleanup = async () => {
    vl.dispose();
    agent.dispose();
    networkMonitor.stop();
    mw.dispose();
    await jobs.shutdown();
  };

  return { demo, mw, agent, vl, cleanup };
}

// ============================================================================
// Suite 1: Acoustic Echo Canceller (PBFDAF + DTD + RES)
// ============================================================================

describe("AcousticEchoCanceller (PBFDAF + DTD + RES)", () => {
  test("converges on multi-tap room echo path (48ms + 112ms) and achieves >= 12 dB ERLE", () => {
    const sr = 16000;
    const totalSamples = sr * 3; // 3 seconds
    const rand = makePrng(20261126);

    // Speech-like colored far-end reference (TTS speaker playback)
    const ref = new Float32Array(totalSamples);
    let lp = 0;
    for (let i = 0; i < totalSamples; i += 1) {
      const env = 0.65 + 0.35 * Math.sin((2 * Math.PI * 3.5 * i) / sr);
      const white = (rand() * 2 - 1) * 0.45 * env;
      lp = 0.6 * lp + 0.4 * white;
      ref[i] = lp;
    }

    // Synthetic room impulse response: 48ms direct echo (768 samples) + 112ms reflection (1792 samples)
    const mic = new Float32Array(totalSamples);
    for (let i = 0; i < totalSamples; i += 1) {
      const tap1 = i >= 768 ? 0.62 * ref[i - 768]! : 0;
      const tap2 = i >= 1792 ? -0.24 * ref[i - 1792]! : 0;
      const tap3 = i >= 900 ? 0.14 * ref[i - 900]! : 0;
      const noise = (rand() * 2 - 1) * 0.0015;
      mic[i] = tap1 + tap2 + tap3 + noise;
    }

    const aec = new AcousticEchoCanceller({ sampleRate: sr, blockSize: 256, numPartitions: 16 });
    const res = aec.processStream(mic, ref);

    // Measure echo suppression on final 1 second after convergence
    const tailStart = sr * 2;
    const micTailRms = rmsOf(mic.subarray(tailStart, res.output.length));
    const outTailRms = rmsOf(res.output.subarray(tailStart, res.output.length));
    const measuredErleDb = 20 * Math.log10((micTailRms + 1e-9) / (outTailRms + 1e-9));

    expect(res.farEndActive).toBe(true);
    expect(measuredErleDb).toBeGreaterThanOrEqual(12);
    expect(res.erleDb).toBeGreaterThanOrEqual(10);
    expect(outTailRms).toBeLessThan(micTailRms * 0.25);
  });

  test("detects double-talk during TTS echo, freezes weights, and preserves near-end speech", () => {
    const sr = 16000;
    const totalSamples = sr * 3;
    const rand = makePrng(99887766);

    const ref = new Float32Array(totalSamples);
    let lp = 0;
    for (let i = 0; i < totalSamples; i += 1) {
      const white = (rand() * 2 - 1) * 0.35;
      lp = 0.55 * lp + 0.45 * white;
      ref[i] = lp;
    }

    // Near-end user voice enters from 1.6s to 2.5s (harmonic speech-like formants)
    const nearEnd = new Float32Array(totalSamples);
    const dtStart = Math.round(sr * 1.6);
    const dtEnd = Math.round(sr * 2.5);
    for (let i = dtStart; i < dtEnd; i += 1) {
      const t = i / sr;
      nearEnd[i] =
        0.22 * Math.sin(2 * Math.PI * 240 * t) +
        0.15 * Math.sin(2 * Math.PI * 520 * t) +
        0.1 * Math.sin(2 * Math.PI * 1180 * t);
    }

    const mic = new Float32Array(totalSamples);
    for (let i = 0; i < totalSamples; i += 1) {
      const echo = (i >= 512 ? 0.55 * ref[i - 512]! : 0) + (i >= 1024 ? -0.18 * ref[i - 1024]! : 0);
      mic[i] = echo + nearEnd[i]!;
    }

    const aec = new AcousticEchoCanceller({ sampleRate: sr });
    let dtBlockHits = 0;
    const outAll = new Float32Array(totalSamples);
    for (let off = 0; off + 256 <= totalSamples; off += 256) {
      const blockRes = aec.processBlock(mic.subarray(off, off + 256), ref.subarray(off, off + 256));
      outAll.set(blockRes.output, off);
      if (off >= dtStart && off < dtEnd && blockRes.doubleTalk) {
        dtBlockHits += 1;
      }
    }

    const outDtRms = rmsOf(outAll.subarray(dtStart + 512, dtEnd - 512));
    const nearDtRms = rmsOf(nearEnd.subarray(dtStart + 512, dtEnd - 512));
    // Post-double-talk echo suppression should remain strong (weights didn't diverge)
    const postStart = Math.round(sr * 2.65);
    const micPostRms = rmsOf(mic.subarray(postStart, totalSamples - 256));
    const outPostRms = rmsOf(outAll.subarray(postStart, totalSamples - 256));

    expect(dtBlockHits).toBeGreaterThanOrEqual(8);
    expect(outDtRms).toBeGreaterThan(nearDtRms * 0.4);
    expect(outPostRms).toBeLessThan(micPostRms * 0.4);
  });

  test("passes near-end speech cleanly when far-end reference is silent", () => {
    const sr = 16000;
    const n = 256 * 12;
    const ref = new Float32Array(n); // all zeros
    const mic = new Float32Array(n);
    for (let i = 0; i < n; i += 1) {
      mic[i] = 0.25 * Math.sin((2 * Math.PI * 440 * i) / sr);
    }

    const aec = new AcousticEchoCanceller({ sampleRate: sr });
    const res = aec.processStream(mic, ref);
    expect(res.farEndActive).toBe(false);
    expect(res.doubleTalk).toBe(false);
    expect(rmsOf(res.output)).toBeCloseTo(rmsOf(mic), 2);
  });
});

// ============================================================================
// Suite 2: Multi-Utterance TtsEchoGuard & Double-Talk Echo Stripping
// ============================================================================

describe("TtsEchoGuard & Semantic Echo Protection", () => {
  test("normalizes Chinese spoken numbers/units so Matcha TTS matches ASR digits", () => {
    expect(normalizeTextForEchoMatch("亮度调至百分之八十五")).toContain("85%");
    expect(normalizeTextForEchoMatch("空调已设为二十六度")).toContain("26度");
    expect(
      computeEnhancedEchoOverlap(
        "客厅吸顶灯已打开，亮度调至百分之八十五",
        "客厅吸顶灯已打开，亮度调至85%",
      ),
    ).toBeGreaterThanOrEqual(0.85);
    expect(
      computeEnhancedEchoOverlap("空调已设为二十六度", "空调已设为26°C"),
    ).toBeGreaterThanOrEqual(0.85);
  });

  test("tracks queued multi-utterance playback timestamps accurately even when queued >6s earlier", () => {
    const guard = new TtsEchoGuard();
    const t0 = 1_700_000_000_000;
    const u1 = guard.registerUtterance("好的，正在帮你处理。", { now: t0, priority: "ack" });
    const u2 = guard.registerUtterance("客厅吸顶灯已打开，亮度调至85%。", {
      now: t0 + 100,
      priority: "result",
    });

    // u1 finishes at t0 + 2500, u2 only starts playing at t0 + 6500 (6.4s after enqueue!)
    guard.updateClientPlaybackState({ speaking: true, phase: "start", utteranceId: u1.id, now: t0 + 200 });
    guard.updateClientPlaybackState({ speaking: true, phase: "end", utteranceId: u1.id, now: t0 + 2500 });
    guard.updateClientPlaybackState({ speaking: true, phase: "start", utteranceId: u2.id, now: t0 + 6500 });

    // At t0 + 7400 (7.3s after enqueue, but actively playing!), echo of u2 MUST still be caught!
    const ev = guard.evaluate({
      transcript: "客厅吸顶灯已打开亮度调至百分之八十五",
      now: t0 + 7400,
      duringTtsPlayback: true,
    });
    expect(ev.isEcho).toBe(true);
    expect(ev.duringActiveTts).toBe(true);
    guard.recordSuppressed();
    expect(guard.suppressedCount).toBe(1);
  });

  test("suppresses short ack homophone echoes ('嗯?' -> '恩', '好的' -> '好哒')", () => {
    const t0 = 1_700_000_100_000;
    const r1 = evaluateTtsEcho({
      transcript: "恩",
      now: t0 + 900,
      legacyLastSpokenReply: "嗯?",
      legacyLastSpokenAt: t0,
    });
    expect(r1.isEcho).toBe(true);

    const r2 = evaluateTtsEcho({
      transcript: "好哒",
      now: t0 + 1100,
      legacyLastSpokenReply: "好的",
      legacyLastSpokenAt: t0,
    });
    expect(r2.isEcho).toBe(true);
  });

  test("protects opposite-polarity user commands right after status TTS broadcast", () => {
    const guard = new TtsEchoGuard();
    const t0 = 1_700_000_200_000;
    const u = guard.registerUtterance("客厅吸顶灯已关闭", { now: t0 });
    guard.updateClientPlaybackState({ speaking: true, phase: "start", utteranceId: u.id, now: t0 + 50 });

    const ev = guard.evaluate({
      transcript: "打开客厅吸顶灯",
      now: t0 + 900,
      duringTtsPlayback: true,
      looksDirectCommand: true,
    });
    expect(ev.isEcho).toBe(false);
  });

  test("strips leaked TTS prefix during double-talk while preserving the user's real command", () => {
    const guard = new TtsEchoGuard();
    const t0 = 1_700_000_300_000;
    const u = guard.registerUtterance("客厅吸顶灯已打开", { now: t0 });
    guard.updateClientPlaybackState({ speaking: true, phase: "start", utteranceId: u.id, now: t0 + 50 });

    const ev = guard.evaluate({
      transcript: "客厅吸顶灯已打开，把卧室台灯关了",
      now: t0 + 800,
      duringTtsPlayback: true,
      looksDirectCommand: true,
    });
    expect(ev.isEcho).toBe(false);
    expect(ev.strippedTranscript).toBeTruthy();
    expect(ev.strippedTranscript).toContain("把卧室台灯关了");
    expect(ev.strippedTranscript).not.toContain("客厅吸顶灯已打开");
  });

  test("integrates with evaluateVoiceAttention to strip double-talk echo and pass clean command", async () => {
    const guard = new TtsEchoGuard();
    const t0 = 1_700_000_400_000;
    const u = guard.registerUtterance("客厅吸顶灯已打开", { now: t0 });
    guard.updateClientPlaybackState({ speaking: true, phase: "start", utteranceId: u.id, now: t0 + 20 });

    const decision = await evaluateVoiceAttention({
      rawText: "客厅吸顶灯已打开，查看卧室温度",
      wakeWords: ["小派"],
      wakeWordEnabled: true,
      awakeActive: true,
      attentionMode: "smart",
      recentSpokenUtterances: guard.getRecentUtterances(t0 + 600),
      ttsActive: true,
      duringTtsPlayback: true,
      echoCancellationMode: "auto",
      now: t0 + 600,
    });

    expect(decision.accept).toBe(true);
    expect(decision.echoStripped).toBe(true);
    expect(decision.command).toContain("查看卧室温度");
    expect(decision.command).not.toContain("客厅吸顶灯已打开");
  });

  test("uses owner voiceprint to raise echo threshold and non-owner to tighten during active TTS", () => {
    const guard = new TtsEchoGuard();
    const t0 = 1_700_000_500_000;
    const u = guard.registerUtterance("客厅吸顶灯亮度已调到百分之八十", { now: t0 });
    guard.updateClientPlaybackState({ speaking: true, phase: "start", utteranceId: u.id, now: t0 + 20 });

    // Partial overlap (~0.56): non-owner during active TTS should be rejected, owner allowed
    const nonOwner = guard.evaluate({
      transcript: "客厅吸顶灯亮度",
      now: t0 + 500,
      duringTtsPlayback: true,
      voiceprint: {
        evaluated: true,
        matched: false,
        score: 0.12,
        threshold: 0.42,
        enrolledCount: 1,
        speakerId: null,
        speakerName: null,
        role: null,
        engine: "campp",
        candidates: [],
      },
    });
    expect(nonOwner.isEcho).toBe(true);

    const owner = guard.evaluate({
      transcript: "客厅吸顶灯亮度调到50",
      now: t0 + 500,
      duringTtsPlayback: true,
      looksDirectCommand: true,
      voiceprint: {
        evaluated: true,
        matched: true,
        score: 0.78,
        threshold: 0.42,
        enrolledCount: 1,
        speakerId: "vp_owner",
        speakerName: "主人",
        role: "owner",
        engine: "campp",
        candidates: [{ id: "vp_owner", name: "主人", role: "owner", score: 0.78 }],
      },
    });
    expect(owner.isEcho).toBe(false);
  });
});

// ============================================================================
// Suite 3: Async Decoupled Execution, Non-Blocking Conversation & Stream Session
// ============================================================================

describe("Async Decoupled 3-Lane Pipeline", () => {
  test("PiAgentService.submitPrompt executes concurrent tasks without aborting or blocking each other", async () => {
    const faux = fauxProvider();
    const completionOrder: string[] = [];

    const delayedStreamFn: ConstructorParameters<typeof PiAgentService>[0]["customStreamFn"] = (
      _model,
      context,
      options,
    ) => {
      const stream = createAssistantMessageEventStream();
      const lastUser = [...context.messages].reverse().find((m) => m.role === "user");
      const rawText =
        typeof lastUser?.content === "string"
          ? lastUser.content
          : Array.isArray(lastUser?.content)
            ? lastUser.content.map((c) => ("text" in c ? c.text : "")).join("")
            : "";
      const isSlow = rawText.includes("慢任务");
      const delayMs = isSlow ? 220 : 30;
      const reply = isSlow ? "慢任务已完成" : "快任务已完成";

      void (async () => {
        const started = Date.now();
        while (Date.now() - started < delayMs) {
          if (options?.signal?.aborted) {
            const abortedMsg = fauxAssistantMessage("", { stopReason: "aborted" });
            stream.push({ type: "error", reason: "aborted", error: abortedMsg });
            stream.end(abortedMsg);
            return;
          }
          await Bun.sleep(10);
        }
        const msg = fauxAssistantMessage(reply, { stopReason: "stop" });
        stream.push({ type: "start", partial: msg });
        stream.push({ type: "text_start", contentIndex: 0, partial: msg });
        stream.push({ type: "text_delta", contentIndex: 0, delta: reply, partial: msg });
        stream.push({ type: "text_end", contentIndex: 0, content: reply, partial: msg });
        stream.push({ type: "done", reason: "stop", message: msg });
        stream.end(msg);
      })();

      return stream;
    };

    const h = await createAsyncTestHarness({
      customStreamFn: delayedStreamFn,
      customModel: faux.getModel(),
      configOverrides: { provider: "openai", modelId: faux.getModel().id, preferLocalIntents: false },
    });

    try {
      const tStart = Date.now();
      const sub1 = h.agent.submitPrompt("执行慢任务", { source: "voice" });
      const sub2 = h.agent.submitPrompt("执行快任务", { source: "voice" });
      const submitElapsed = Date.now() - tStart;

      // Both submissions must return immediately without blocking!
      expect(submitElapsed).toBeLessThan(80);
      expect(sub1.accepted).toBe(true);
      expect(sub2.accepted).toBe(true);
      expect(sub1.taskId).not.toBe(sub2.taskId);

      // Both tasks must be concurrently active right after submission
      expect(h.agent.activeTaskCount).toBe(2);
      expect(h.agent.snapshot().activeTaskCount).toBe(2);

      const p1 = sub1.promise.then((res) => {
        completionOrder.push("slow");
        return res;
      });
      const p2 = sub2.promise.then((res) => {
        completionOrder.push("fast");
        return res;
      });

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
      expect(r1.reply).toContain("慢任务已完成");
      expect(r2.reply).toContain("快任务已完成");
      // Fast task MUST finish before slow task without aborting slow task!
      expect(completionOrder).toEqual(["fast", "slow"]);
      expect(h.agent.activeTaskCount).toBe(0);
    } finally {
      await h.cleanup();
    }
  });

  test("PiAgentService.abortTask cancels only the target task while concurrent tasks complete", async () => {
    const faux = fauxProvider();
    const streamFn: ConstructorParameters<typeof PiAgentService>[0]["customStreamFn"] = (
      _model,
      context,
      options,
    ) => {
      const stream = createAssistantMessageEventStream();
      const lastUser = [...context.messages].reverse().find((m) => m.role === "user");
      const rawText = typeof lastUser?.content === "string" ? lastUser.content : "";
      const isLong = rawText.includes("长任务");
      const delayMs = isLong ? 450 : 70;

      void (async () => {
        const started = Date.now();
        while (Date.now() - started < delayMs) {
          if (options?.signal?.aborted) {
            const abortedMsg = fauxAssistantMessage("", { stopReason: "aborted" });
            stream.push({ type: "error", reason: "aborted", error: abortedMsg });
            stream.end(abortedMsg);
            return;
          }
          await Bun.sleep(10);
        }
        const reply = isLong ? "长任务完成" : "短任务成功";
        const msg = fauxAssistantMessage(reply, { stopReason: "stop" });
        stream.push({ type: "start", partial: msg });
        stream.push({ type: "text_start", contentIndex: 0, partial: msg });
        stream.push({ type: "text_delta", contentIndex: 0, delta: reply, partial: msg });
        stream.push({ type: "text_end", contentIndex: 0, content: reply, partial: msg });
        stream.push({ type: "done", reason: "stop", message: msg });
        stream.end(msg);
      })();

      return stream;
    };

    const h = await createAsyncTestHarness({
      customStreamFn: streamFn,
      customModel: faux.getModel(),
      configOverrides: { provider: "openai", modelId: faux.getModel().id, preferLocalIntents: false },
    });

    try {
      const subLong = h.agent.submitPrompt("运行长任务", { source: "text" });
      const subShort = h.agent.submitPrompt("运行短任务", { source: "text" });

      await Bun.sleep(25);
      expect(h.agent.abortTask(subLong.taskId)).toBe(true);

      const [rLong, rShort] = await Promise.all([subLong.promise, subShort.promise]);
      const longEntry = h.agent.snapshot().timeline.find((e) => e.id === rLong.entryId);
      expect(longEntry?.status).toBe("aborted");
      expect(rShort.ok).toBe(true);
      expect(rShort.reply).toContain("短任务成功");
    } finally {
      await h.cleanup();
    }
  });

  test("VoiceListenerController asyncDispatch never blocks conversation & supports voice cancel command", async () => {
    const faux = fauxProvider();
    const streamFn: ConstructorParameters<typeof PiAgentService>[0]["customStreamFn"] = (
      _model,
      context,
      options,
    ) => {
      const stream = createAssistantMessageEventStream();
      const lastUser = [...context.messages].reverse().find((m) => m.role === "user");
      const rawText = typeof lastUser?.content === "string" ? lastUser.content : "";
      const delayMs = rawText.includes("扫描") ? 350 : 40;

      void (async () => {
        const started = Date.now();
        while (Date.now() - started < delayMs) {
          if (options?.signal?.aborted) {
            const abortedMsg = fauxAssistantMessage("", { stopReason: "aborted" });
            stream.push({ type: "error", reason: "aborted", error: abortedMsg });
            stream.end(abortedMsg);
            return;
          }
          await Bun.sleep(10);
        }
        const reply = rawText.includes("扫描") ? "全屋设备检查完毕" : "客厅灯状态正常";
        const msg = fauxAssistantMessage(reply, { stopReason: "stop" });
        stream.push({ type: "start", partial: msg });
        stream.push({ type: "text_start", contentIndex: 0, partial: msg });
        stream.push({ type: "text_delta", contentIndex: 0, delta: reply, partial: msg });
        stream.push({ type: "text_end", contentIndex: 0, content: reply, partial: msg });
        stream.push({ type: "done", reason: "stop", message: msg });
        stream.end(msg);
      })();

      return stream;
    };

    const h = await createAsyncTestHarness({
      customStreamFn: streamFn,
      customModel: faux.getModel(),
      configOverrides: { provider: "openai", modelId: faux.getModel().id, preferLocalIntents: false },
    });

    try {
      h.vl.enterConversation("test-start");

      const t0 = Date.now();
      const res1 = await h.vl.handleTranscript("帮我扫描检查全屋设备", {
        isFinal: true,
        asyncDispatch: true,
      });
      const elapsed1 = Date.now() - t0;

      // Dispatch returns immediately without awaiting the 350ms execution!
      expect(elapsed1).toBeLessThan(120);
      expect(res1.matched).toBe(true);
      expect(res1.dispatchedAsync).toBe(true);
      expect(res1.taskId).toBeTruthy();

      // Conversation lane stays in conversation mode while execution lane runs in background
      const snapWhileRunning = h.vl.snapshot();
      expect(snapWhileRunning.dialogState).toBe("conversation");
      expect(snapWhileRunning.lanes.conversation.dialogState).toBe("conversation");
      expect(snapWhileRunning.lanes.conversation.fullDuplex).toBe(true);
      expect(snapWhileRunning.lanes.execution.activeCount).toBe(1);

      // User immediately speaks a second command while Task 1 is still running!
      const res2 = await h.vl.handleTranscript("查一下客厅吸顶灯状态", {
        isFinal: true,
        asyncDispatch: true,
      });
      expect(res2.matched).toBe(true);
      expect(res2.dispatchedAsync).toBe(true);
      expect(h.agent.activeTaskCount).toBeGreaterThanOrEqual(1);

      // Voice cancel command aborts running execution cleanly
      const cancelRes = await h.vl.handleTranscript("停止执行", {
        isFinal: true,
        asyncDispatch: true,
      });
      expect(cancelRes.matched).toBe(true);
      expect(cancelRes.reply).toContain("已取消");

      // Wait for tasks to settle
      const settleDeadline = Date.now() + 1000;
      while (Date.now() < settleDeadline && h.agent.activeTaskCount > 0) {
        await Bun.sleep(15);
      }
      expect(h.agent.activeTaskCount).toBe(0);
      expect(h.vl.snapshot().dialogState).toBe("conversation");
    } finally {
      await h.cleanup();
    }
  });

  test("VoiceStreamSession.notifyTtsState preserves in-progress user speech and marks duringTtsPlayback", async () => {
    const segments: Array<{ sampleCount: number; duringTtsPlayback?: boolean }> = [];
    let vadResetCalls = 0;
    let vadDetected = false;
    let vadSamples = 0;
    const queuedSegs: Array<{ samples: Float32Array; start: number }> = [];
    const speechBuf: number[] = [];

    // Deterministic mock VAD proving notifyTtsState NEVER wipes active user speech!
    const fakeLocalEngine = {
      createOnlineDenoiser: () => null,
      createStreamingVad: () => ({
        acceptWaveform: (frame: Float32Array) => {
          let s = 0;
          for (let i = 0; i < frame.length; i += 1) s += frame[i]! * frame[i]!;
          const rms = Math.sqrt(s / Math.max(1, frame.length));
          if (rms > 0.05) {
            vadDetected = true;
            for (let i = 0; i < frame.length; i += 1) speechBuf.push(frame[i]!);
          } else if (vadDetected && speechBuf.length >= 4000) {
            vadDetected = false;
            queuedSegs.push({
              samples: Float32Array.from(speechBuf),
              start: Math.max(0, vadSamples - speechBuf.length),
            });
            speechBuf.length = 0;
          }
          vadSamples += frame.length;
        },
        isDetected: () => vadDetected,
        isEmpty: () => queuedSegs.length === 0,
        front: () => queuedSegs[0]!,
        pop: () => {
          queuedSegs.shift();
        },
        flush: () => {},
        clear: () => {
          vadResetCalls += 1;
          queuedSegs.length = 0;
          speechBuf.length = 0;
          vadDetected = false;
        },
        reset: () => {
          vadResetCalls += 1;
          queuedSegs.length = 0;
          speechBuf.length = 0;
          vadDetected = false;
        },
      }),
    } as unknown as LocalVoiceEngine;

    const session = new VoiceStreamSession({
      localEngine: fakeLocalEngine,
      noiseMode: "off",
      owwEnabled: false,
      onSegmentReady: async (seg) => {
        segments.push({ sampleCount: seg.rawSamples.length, duringTtsPlayback: seg.duringTtsPlayback });
        return null;
      },
      vadThreshold: 0.015,
      vadSilenceMs: 200,
    });

    const makeFrame = (amp: number): Float32Array => {
      const f = new Float32Array(1024);
      for (let i = 0; i < f.length; i += 1) {
        f[i] = amp * Math.sin((2 * Math.PI * 440 * i) / 16000);
      }
      return f;
    };

    // Start speaking, then TTS turns ON & OFF mid-utterance — notifyTtsState MUST NOT wipe the speech!
    for (let i = 0; i < 6; i += 1) session.pushFloat32Samples(makeFrame(0.25));
    session.notifyTtsState(true);
    for (let i = 0; i < 6; i += 1) session.pushFloat32Samples(makeFrame(0.25));
    session.notifyTtsState(false);
    expect(vadResetCalls).toBe(0);

    // Push silence to trigger clean utterance flush
    for (let i = 0; i < 6; i += 1) session.pushFloat32Samples(new Float32Array(1024));
    await Bun.sleep(100);
    expect(vadResetCalls).toBe(0);
    session.dispose();

    expect(segments.length).toBeGreaterThanOrEqual(1);
    expect(segments[0]!.duringTtsPlayback).toBe(true);
  });
});

// ============================================================================
// Suite 4: Config Persistence & End-to-End HTTP/WebSocket Server Integration
// ============================================================================

describe("Config & Server HTTP/WebSocket Integration", () => {
  test("persists asyncVoicePipeline, echoCancellationMode, and bargeInDuckingEnabled", () => {
    const initial = loadAgentVoiceConfig();
    expect(initial.asyncVoicePipeline).toBe(true);
    expect(initial.echoCancellationMode).toBe("auto");
    expect(initial.bargeInDuckingEnabled).toBe(true);

    const updated = updateAgentVoiceConfig({
      asyncVoicePipeline: false,
      echoCancellationMode: "aggressive",
      bargeInDuckingEnabled: false,
    });
    expect(updated.asyncVoicePipeline).toBe(false);
    expect(updated.echoCancellationMode).toBe("aggressive");
    expect(updated.bargeInDuckingEnabled).toBe(false);

    const reloaded = loadAgentVoiceConfig();
    expect(reloaded.asyncVoicePipeline).toBe(false);
    expect(reloaded.echoCancellationMode).toBe("aggressive");
    expect(reloaded.bargeInDuckingEnabled).toBe(false);
  });

  test("supports POST /api/agent/prompt (async), /api/agent/tasks/:id/abort, and rich WS voice_tts_state", async () => {
    activeServer = await startMijiaDeckServer({
      port: 0,
      hostname: "127.0.0.1",
      mode: "demo",
      autoStartTimers: false,
    });
    const baseUrl = `http://127.0.0.1:${activeServer.port}`;
    const wsUrl = `ws://127.0.0.1:${activeServer.port}/ws`;
    const vl = activeServer.runtime.voiceListener;
    expect(vl).toBeDefined();
    if (!vl) throw new Error("voiceListener missing");

    // 1. Test async prompt endpoint
    const promptRes = await fetch(`${baseUrl}/api/agent/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "打开客厅吸顶灯", source: "text", async: true }),
    });
    expect(promptRes.status).toBe(200);
    const promptData = (await promptRes.json()) as {
      ok: boolean;
      accepted: boolean;
      async: boolean;
      taskId: string;
      entryId: string;
    };
    expect(promptData.ok).toBe(true);
    expect(promptData.accepted).toBe(true);
    expect(promptData.async).toBe(true);
    expect(promptData.taskId).toBeTruthy();

    // 2. Test task abort endpoint (returns ok even if fast local task already completed)
    const abortRes = await fetch(
      `${baseUrl}/api/agent/tasks/${encodeURIComponent(promptData.taskId)}/abort`,
      { method: "POST" },
    );
    expect(abortRes.status).toBe(200);
    const abortData = (await abortRes.json()) as { ok: boolean; agent: { activeTaskCount: number } };
    expect(abortData.ok).toBe(true);
    expect(typeof abortData.agent.activeTaskCount).toBe("number");

    // 3. Test WS rich voice_tts_state updates lanes & echoGuard & preserves conversation timer pause
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", (e) => reject(e), { once: true });
    });

    try {
      vl.enterConversation("ws-test");

      ws.send(
        JSON.stringify({
          type: "voice_tts_state",
          speaking: true,
          phase: "start",
          utteranceId: "utt_ws_1",
          text: "客厅吸顶灯已打开，亮度调至85%",
          queueLength: 1,
          aecActive: true,
          erleDb: 18.4,
          doubleTalk: false,
        }),
      );
      await Bun.sleep(60);

      const snapSpeaking = vl.snapshot();
      expect(snapSpeaking.timerPaused).toBe(true);
      expect(snapSpeaking.lanes.speaking.active).toBe(true);
      expect(snapSpeaking.lanes.speaking.utteranceId).toBe("utt_ws_1");
      expect(snapSpeaking.lanes.speaking.queueLength).toBe(1);
      expect(snapSpeaking.lanes.echo.activeAec).toBe(true);
      expect(snapSpeaking.lanes.echo.erleDb).toBeCloseTo(18.4, 1);

      // Leaked echo matching the active utterance reported by browser MUST be suppressed!
      const echoCheck = await vl.handleTranscript(
        "客厅吸顶灯已打开亮度调至百分之八十五",
        { isFinal: true, duringTtsPlayback: true, asyncDispatch: true },
      );
      expect(echoCheck.matched).toBe(false);
      expect(echoCheck.attention?.stage).toBe("echo");

      // Double-talk ducking signal updates speaking.ducked
      ws.send(
        JSON.stringify({
          type: "voice_tts_state",
          speaking: true,
          phase: "duck",
          utteranceId: "utt_ws_1",
          aecActive: true,
          erleDb: 19.2,
          doubleTalk: true,
        }),
      );
      await Bun.sleep(60);
      expect(vl.snapshot().lanes.speaking.ducked).toBe(true);
      expect(vl.snapshot().lanes.echo.doubleTalkActive).toBe(true);

      // End TTS playback -> restores timerPaused = false while staying in conversation mode
      ws.send(
        JSON.stringify({
          type: "voice_tts_state",
          speaking: false,
          phase: "end",
          utteranceId: "utt_ws_1",
          queueLength: 0,
          aecActive: true,
          erleDb: 19.2,
          doubleTalk: false,
        }),
      );
      await Bun.sleep(60);
      const snapDone = vl.snapshot();
      expect(snapDone.timerPaused).toBe(false);
      expect(snapDone.dialogState).toBe("conversation");
      expect(snapDone.lanes.speaking.active).toBe(false);
      expect(snapDone.lanes.speaking.ducked).toBe(false);
    } finally {
      ws.close();
    }
  });
});
