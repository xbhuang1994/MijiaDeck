// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 连续说话保持对话态 + SystemOne 动态判定对话结束后再倒计时退出综合回归测试

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai";
import type { LocalVoiceEngine } from "../src/agent/localVoiceEngine.ts";
import { PiAgentService } from "../src/agent/piAgentService.ts";
import type {
  ConversationEndChoice,
  ConversationEndInput,
  ConversationEndResult,
} from "../src/agent/systemOneClient.ts";
import {
  assistantReplyExpectsUserResponse,
  evaluateVoiceAttention,
  inferConversationEndFallback,
} from "../src/agent/voiceAttentionGate.ts";
import {
  VoiceListenerController,
  type VoiceListenerControllerOptions,
} from "../src/agent/voiceListenerController.ts";
import {
  DEFAULT_SYSTEMONE_MODEL,
  defaultAgentVoiceConfig,
  normalizeAgentVoiceConfig,
} from "../src/core/agentConfigStore.ts";
import { NetworkMonitor } from "../src/core/availability.ts";
import type { FetchLike } from "../src/core/httpTimeout.ts";
import { JobExecutor } from "../src/core/jobs.ts";
import { setDataPathOverrides } from "../src/core/jsonStore.ts";
import * as settingsStore from "../src/core/settingsStore.ts";
import { VirtualDemoService } from "../src/core/virtualLightService.ts";
import { startMijiaDeckServer, type MijiaDeckServer } from "../src/server/server.ts";
import { MainWindowController } from "../src/ui/controllers/mainWindowController.ts";
import { applyTheme, ThemeController } from "../src/ui/theme.ts";

let tmpDir = "";
let server: MijiaDeckServer | null = null;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "mijiadeck-dyn-conv-exit-"));
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

function makeSystemOneEndResult(
  decision: ConversationEndChoice,
  confidence = 0.92,
): ConversationEndResult {
  const other: ConversationEndChoice = decision === "continue" ? "ready_to_end" : "continue";
  return {
    decision,
    shouldStartExitCountdown: decision === "ready_to_end" && confidence >= 0.6,
    confidence,
    probabilities: {
      [decision]: confidence,
      [other]: Number((1 - confidence).toFixed(4)),
    } as Record<ConversationEndChoice, number>,
    model: DEFAULT_SYSTEMONE_MODEL,
    usage: { input_tokens: 40, output_tokens: 6 },
    latencyMs: 12,
  };
}

async function createDynamicConvHarness(options: {
  configOverrides?: Record<string, unknown>;
  vlOptions?: VoiceListenerControllerOptions;
  customStreamFn?: ConstructorParameters<typeof PiAgentService>[0]["customStreamFn"];
  customModel?: ConstructorParameters<typeof PiAgentService>[0]["customModel"];
  fetcher?: FetchLike;
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
    wakeWords: ["Neo", "小派"],
    autoSpeakReply: false,
    sourceSeparationMode: "off",
    owwEnabled: false,
    conversationWindowSec: 1,
    ...options.configOverrides,
  });

  const agent = new PiAgentService({
    deps: { mainWindow: mw, service: demo, jobs, settingsStore, broadcastState: () => {} },
    initialConfig: cfg,
    systemOneFetcher: options.fetcher,
    customStreamFn: options.customStreamFn,
    customModel: options.customModel,
  });

  const vl = new VoiceListenerController(agent, options.vlOptions);

  const cleanup = async () => {
    vl.dispose();
    agent.dispose();
    networkMonitor.stop();
    mw.dispose();
    await jobs.shutdown();
  };

  return { demo, mw, agent, vl, cleanup };
}

describe("Continuous Speech & Active Conversation Preservation (Not Mistaken for BGM)", () => {
  test("holds conversation throughout long continuous speech (6s+) with live partial updates and executes without dropping", async () => {
    const h = await createDynamicConvHarness({
      configOverrides: { conversationWindowSec: 1 },
    });
    try {
      h.vl.enterConversation("wake_only", { speakAck: false });
      expect(h.vl.dialogState).toBe("conversation");

      // Wait near expiry (700ms into 1000ms window), then start speaking continuously for > 5.5s
      await Bun.sleep(700);
      h.vl.setSpeechInProgress(true);
      expect(h.vl.snapshot().timerPaused).toBe(true);
      expect(h.vl.snapshot().conversationHoldReason).toBe("user_speaking");

      const partials = [
        "帮我把",
        "帮我把客厅的",
        "帮我把客厅吸顶灯",
        "帮我把客厅吸顶灯关掉",
      ];
      for (const p of partials) {
        await Bun.sleep(1400);
        // Must NEVER exit conversation mid-sentence (previously killed at 3.5s/5s BGM cap!)
        expect(h.vl.dialogState).toBe("conversation");
        h.vl.noteLiveSpeechActivity(p);
        expect(h.vl.snapshot().conversationHoldReason).toBe("user_speaking");
        expect(h.vl.snapshot().interimTranscript).toBe(p);
      }

      h.vl.setSpeechInProgress(false);
      expect(h.vl.dialogState).toBe("conversation");

      const res = await h.vl.handleTranscript("帮我把客厅吸顶灯关掉", { isFinal: true });
      expect(res.matched).toBe(true);
      expect(await h.demo.powerState("demo-light-living")).toBe(false);
    } finally {
      await h.cleanup();
    }
  }, 15_000);

  test("holds conversation during in-flight audio transcription/separation and during slow Pi Agent task execution", async () => {
    let releaseAsr!: () => void;
    const asrGate = new Promise<void>((r) => {
      releaseAsr = r;
    });

    let releaseAgent!: () => void;
    const agentGate = new Promise<void>((r) => {
      releaseAgent = r;
    });

    const slowEngine = {
      setPreferredAsrEngine: () => {},
      setClearVoiceServiceUrl: () => {},
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
      transcribeDualTrack: async () => {
        await asrGate;
        return {
          text: "打开客厅吸顶灯",
          rawText: "打开客厅吸顶灯",
          lang: "<|zh|>",
          emotion: "",
          event: "<|Speech|>",
          engine: "qwen3-asr-remote",
          durationMs: 1400,
        };
      },
      dispose: () => {},
    } as unknown as LocalVoiceEngine;

    const faux = fauxProvider();
    const slowStreamFn: ConstructorParameters<typeof PiAgentService>[0]["customStreamFn"] = () => {
      const stream = createAssistantMessageEventStream();
      void agentGate.then(() => {
        const msg = fauxAssistantMessage("客厅吸顶灯已打开。", { stopReason: "stop" });
        stream.push({ type: "start", partial: msg });
        stream.push({ type: "text_start", contentIndex: 0, partial: msg });
        stream.push({ type: "text_delta", contentIndex: 0, delta: "客厅吸顶灯已打开。", partial: msg });
        stream.push({ type: "text_end", contentIndex: 0, content: "客厅吸顶灯已打开。", partial: msg });
        stream.push({ type: "done", reason: "stop", message: msg });
        stream.end(msg);
      });
      return stream;
    };

    const h = await createDynamicConvHarness({
      configOverrides: {
        provider: "openai",
        modelId: faux.getModel().id,
        conversationWindowSec: 1,
        preferLocalIntents: false,
      },
      customStreamFn: slowStreamFn,
      customModel: faux.getModel(),
      vlOptions: {
        localEngine: slowEngine,
        conversationEndEvaluatorOverride: async () => makeSystemOneEndResult("ready_to_end", 0.94),
      },
    });

    try {
      h.vl.enterConversation("wake_only", { speakAck: false });

      // Start a segment whose ASR takes 1.3s (> 1.0s conversationWindowSec)
      const segPromise = h.vl.processDualTrackSegment(
        {
          rawSamples: new Float32Array(16000),
          denoisedSamples: new Float32Array(16000),
          denoiseEngine: "gtcrn-stream",
          inputSnrDb: 16,
          outputSnrDb: 20,
          snrGainDb: 4,
          startSec: 0,
          durationSec: 1,
          forcedRoll: false,
        },
        { asyncDispatch: true },
      );

      await Bun.sleep(1300);
      // Must STILL be in conversation while ASR is in-flight!
      expect(h.vl.dialogState).toBe("conversation");
      expect(h.vl.snapshot().conversationHoldReason).toBe("audio_processing");

      releaseAsr();
      const segRes = await segPromise;
      expect(segRes.matched).toBe(true);
      expect(segRes.dispatchedAsync).toBe(true);

      // Now Pi Agent is executing for 1.3s (> 1.0s conversationWindowSec) -> MUST stay in conversation!
      await Bun.sleep(1300);
      expect(h.vl.dialogState).toBe("conversation");
      expect(h.vl.snapshot().conversationHoldReason).toBe("task_running");
      expect(h.vl.snapshot().timerPaused).toBe(true);

      // Finish Pi Agent -> SystemOne returns ready_to_end -> NOW exit countdown starts and exits!
      releaseAgent();
      await Bun.sleep(150);
      expect(h.vl.snapshot().conversationExitPhase).toBe("countdown");
      expect(h.vl.snapshot().conversationEndDecision).toBe("ready_to_end");

      const exitDeadline = Date.now() + 2000;
      while (Date.now() < exitDeadline && h.vl.dialogState === "conversation") {
        await Bun.sleep(50);
      }
      expect(h.vl.dialogState).toBe("standby");
      expect(h.vl.snapshot().lastTransitionReason).toBe("timeout");
    } finally {
      await h.cleanup();
    }
  }, 15_000);
});

describe("SystemOne Dynamic Conversation-End Judgment Before Exit Countdown", () => {
  test("holds conversation without countdown when SystemOne returns continue, then starts countdown only after SystemOne returns ready_to_end", async () => {
    let s1EndCalls: Array<Record<string, unknown>> = [];
    let currentEndChoice: ConversationEndChoice = "continue";

    const mockFetcher: FetchLike = async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        state: Record<string, unknown>;
        questions: Record<string, unknown>;
      };
      if ("conv_end" in body.questions) {
        s1EndCalls.push(body.state);
        return new Response(
          JSON.stringify({
            model: DEFAULT_SYSTEMONE_MODEL,
            answers: {
              conv_end: {
                type: "choice",
                choice: currentEndChoice,
                probabilities:
                  currentEndChoice === "continue"
                    ? { continue: 0.93, ready_to_end: 0.07 }
                    : { continue: 0.08, ready_to_end: 0.92 },
                confidence: currentEndChoice === "continue" ? 0.93 : 0.92,
              },
            },
            usage: { input_tokens: 60, output_tokens: 8 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if ("conv_action" in body.questions) {
        return new Response(
          JSON.stringify({
            model: DEFAULT_SYSTEMONE_MODEL,
            answers: {
              conv_action: {
                type: "choice",
                choice: "followup",
                probabilities: { followup: 0.95, side_talk: 0.03, goodbye: 0.02 },
                confidence: 0.95,
              },
              ...("intent" in body.questions
                ? {
                    intent: {
                      type: "choice",
                      choice: "device_control",
                      probabilities: {
                        device_control: 0.9,
                        status_query: 0.05,
                        scene: 0.03,
                        general_chat: 0.02,
                      },
                      confidence: 0.9,
                    },
                  }
                : {}),
            },
            usage: { input_tokens: 50, output_tokens: 8 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          model: DEFAULT_SYSTEMONE_MODEL,
          answers: {
            decision: {
              type: "choice",
              choice: "direct_command",
              probabilities: { direct_command: 0.95, wake_only: 0.03, ignore: 0.02 },
              confidence: 0.95,
            },
          },
          usage: { input_tokens: 40, output_tokens: 6 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const faux = fauxProvider();
    let turnNum = 0;
    const streamFn: ConstructorParameters<typeof PiAgentService>[0]["customStreamFn"] = () => {
      turnNum += 1;
      const reply =
        turnNum === 1
          ? "方案一：轻柔洗30分钟；方案二：快洗15分钟。请问你想选哪个方案？"
          : "好的，已按方案一为你处理完成。";
      const stream = createAssistantMessageEventStream();
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

    const h = await createDynamicConvHarness({
      configOverrides: {
        provider: "openai",
        modelId: faux.getModel().id,
        preferLocalIntents: false,
        conversationWindowSec: 1,
        systemOneMode: "on",
        systemOneBaseUrl: "https://karpo.example.com/v1",
        systemOneApiKey: "sk-dyn-test-123456",
      },
      customStreamFn: streamFn,
      customModel: faux.getModel(),
      fetcher: mockFetcher,
    });

    try {
      // Turn 1: Assistant asks user to pick Plan 1 or Plan 2 -> SystemOne returns "continue"
      currentEndChoice = "continue";
      const r1 = await h.vl.handleTranscript("Neo，帮我拟定两个洗衣方案", { isFinal: true });
      expect(r1.matched).toBe(true);
      expect(s1EndCalls.length).toBe(1);
      expect(h.vl.dialogState).toBe("conversation");
      expect(h.vl.snapshot().conversationExitPhase).toBe("holding");
      expect(h.vl.snapshot().conversationEndDecision).toBe("continue");
      expect(h.vl.snapshot().conversationHoldReason).toBe("systemone_continue");
      expect(h.vl.snapshot().timerPaused).toBe(true);

      // Sleep 1.8s (> 1s conversationWindowSec) -> MUST STILL BE IN CONVERSATION (NO premature countdown!)
      await Bun.sleep(1800);
      expect(h.vl.dialogState).toBe("conversation");
      expect(h.vl.snapshot().conversationExitPhase).toBe("holding");

      // Turn 2: User replies without wake word ("选方案一") -> SystemOne returns "ready_to_end"
      currentEndChoice = "ready_to_end";
      const r2 = await h.vl.handleTranscript("选方案一", { isFinal: true });
      expect(r2.matched).toBe(true);
      expect(s1EndCalls.length).toBe(2);
      expect(h.vl.dialogState).toBe("conversation");
      expect(h.vl.snapshot().conversationExitPhase).toBe("countdown");
      expect(h.vl.snapshot().conversationEndDecision).toBe("ready_to_end");
      expect(h.vl.snapshot().timerPaused).toBe(false);

      // Wait ~1s countdown -> exits cleanly to standby!
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline && h.vl.dialogState === "conversation") {
        await Bun.sleep(50);
      }
      expect(h.vl.dialogState).toBe("standby");
      expect(h.vl.snapshot().lastTransitionReason).toBe("timeout");
    } finally {
      await h.cleanup();
    }
  }, 15_000);

  test("waits for TTS playback to finish before running exit countdown even when SystemOne already returned ready_to_end", async () => {
    const h = await createDynamicConvHarness({
      configOverrides: { conversationWindowSec: 1 },
      vlOptions: {
        conversationEndEvaluatorOverride: async () => makeSystemOneEndResult("ready_to_end", 0.95),
      },
    });
    try {
      // Simulate TTS speaking during command completion
      h.vl.enterConversation("wake_only", { speakAck: false });
      h.vl.setTtsSpeaking(true);
      const res = await h.vl.handleTranscript("关闭客厅吸顶灯", { isFinal: true });
      expect(res.matched).toBe(true);
      expect(h.vl.snapshot().conversationExitPhase).toBe("countdown");
      expect(h.vl.snapshot().conversationHoldReason).toBe("tts_speaking");
      expect(h.vl.snapshot().timerPaused).toBe(true);

      // Even after 1.5s (> 1s window), stays in conversation while TTS is speaking
      await Bun.sleep(1500);
      expect(h.vl.dialogState).toBe("conversation");

      // Once TTS finishes, countdown runs and exits cleanly
      h.vl.setTtsSpeaking(false);
      expect(h.vl.snapshot().timerPaused).toBe(false);
      const deadline = Date.now() + 4500;
      while (Date.now() < deadline && h.vl.dialogState === "conversation") {
        await Bun.sleep(60);
      }
      expect(h.vl.dialogState).toBe("standby");
      expect(h.vl.snapshot().lastTransitionReason).toBe("timeout");
    } finally {
      await h.cleanup();
    }
  }, 12_000);

  test("idle re-evaluation while holding re-queries SystemOne with idleSeconds and transitions to exit countdown if user walked away", async () => {
    const evalInputs: ConversationEndInput[] = [];
    const h = await createDynamicConvHarness({
      configOverrides: { conversationWindowSec: 1 },
      vlOptions: {
        idleRecheckIntervalMs: 300,
        conversationEndEvaluatorOverride: async (input) => {
          evalInputs.push(input);
          if ((input.idleSeconds ?? 0) >= 1) {
            return makeSystemOneEndResult("ready_to_end", 0.9);
          }
          return makeSystemOneEndResult("continue", 0.91);
        },
      },
    });
    try {
      const r1 = await h.vl.handleTranscript("Neo，打开客厅吸顶灯", { isFinal: true });
      expect(r1.matched).toBe(true);
      expect(h.vl.snapshot().conversationExitPhase).toBe("holding");
      expect(evalInputs.length).toBe(1);

      // Wait for idle recheck -> transitions to countdown -> exits to standby
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline && h.vl.dialogState === "conversation") {
        await Bun.sleep(50);
      }
      expect(evalInputs.length).toBeGreaterThanOrEqual(2);
      expect(evalInputs[1]!.idleSeconds).toBeGreaterThanOrEqual(1);
      expect(h.vl.dialogState).toBe("standby");
    } finally {
      await h.cleanup();
    }
  }, 10_000);

  test("side-talk during holding triggers immediate SystemOne re-evaluation with nonAddressedCount", async () => {
    const evalInputs: ConversationEndInput[] = [];
    const h = await createDynamicConvHarness({
      configOverrides: { conversationWindowSec: 1, maxConsecutiveSidetalk: 3 },
      vlOptions: {
        idleRecheckIntervalMs: 30_000,
        conversationEndEvaluatorOverride: async (input) => {
          evalInputs.push(input);
          if ((input.nonAddressedCount ?? 0) >= 1) {
            return makeSystemOneEndResult("ready_to_end", 0.93);
          }
          return makeSystemOneEndResult("continue", 0.92);
        },
      },
    });
    try {
      await h.vl.handleTranscript("Neo，打开客厅吸顶灯", { isFinal: true });
      expect(h.vl.snapshot().conversationExitPhase).toBe("holding");

      // User turns away and speaks household side-talk ("晚饭吃什么")
      const side = await h.vl.handleTranscript("晚饭吃什么", { isFinal: true });
      expect(side.matched).toBe(false);

      // Wait briefly for async re-evaluation to transition to countdown
      const deadline = Date.now() + 1000;
      while (Date.now() < deadline && h.vl.snapshot().conversationExitPhase !== "countdown") {
        await Bun.sleep(25);
      }
      expect(h.vl.snapshot().conversationExitPhase).toBe("countdown");
      expect(evalInputs.some((i) => i.nonAddressedCount === 1 && i.lastNonAddressedUtterance === "晚饭吃什么")).toBe(true);
    } finally {
      await h.cleanup();
    }
  }, 8_000);

  test("offline fallback holds open questions, starts countdown on closed replies, and allows short replies to assistant questions", async () => {
    expect(assistantReplyExpectsUserResponse("你要打开客厅还是卧室的灯？")).toBe(true);
    expect(assistantReplyExpectsUserResponse("方案一轻柔洗，方案二快洗，请选哪个")).toBe(true);
    expect(assistantReplyExpectsUserResponse("客厅灯已打开。")).toBe(false);
    expect(assistantReplyExpectsUserResponse("客厅灯已打开。还有什么需要帮忙的吗？")).toBe(false);

    expect(
      inferConversationEndFallback({ lastAssistantReply: "请问你要选方案一还是方案二？" }),
    ).toBe("continue");
    expect(
      inferConversationEndFallback({ lastAssistantReply: "客厅灯已打开。", silentCompleted: false }),
    ).toBe("ready_to_end");
    expect(
      inferConversationEndFallback({ silentCompleted: true }),
    ).toBe("ready_to_end");
    expect(
      inferConversationEndFallback({ lastAssistantReply: "请问选哪个？", idleSeconds: 45 }),
    ).toBe("ready_to_end");

    // Short 1-char answer "好" right after assistant asked a question is NOT rejected as noise
    const shortReplyDec = await evaluateVoiceAttention({
      rawText: "好",
      wakeWordEnabled: true,
      wakeWords: ["Neo", "小派"],
      attentionMode: "smart",
      dialogState: "conversation",
      inConversation: true,
      recentTurns: [
        { role: "user", text: "客厅有点暗", timestamp: Date.now() - 2000 },
        { role: "assistant", text: "需要我帮你打开客厅吸顶灯吗？", timestamp: Date.now() - 1000 },
      ],
    });
    expect(shortReplyDec.accept).toBe(true);
    expect(shortReplyDec.command).toBe("好");
  });

  test("server snapshot exposes dynamic conversationExitPhase / conversationHoldReason fields over HTTP/WS", async () => {
    const demo = new VirtualDemoService();
    server = await startMijiaDeckServer({ mode: "demo", port: 0, service: demo });
    const vl = server.runtime.voiceListener!;

    vl.enterConversation("wake_only", { speakAck: false });
    vl.setSpeechInProgress(true);
    vl.noteLiveSpeechActivity("帮我把客厅吸顶灯");

    const res = await fetch(`${server.url}/api/state`);
    expect(res.ok).toBe(true);
    const json = (await res.json()) as {
      voiceListen?: {
        dialogState?: string;
        timerPaused?: boolean;
        conversationExitPhase?: string;
        conversationHoldReason?: string | null;
      };
    };
    expect(json.voiceListen?.dialogState).toBe("conversation");
    expect(json.voiceListen?.timerPaused).toBe(true);
    expect(json.voiceListen?.conversationHoldReason).toBe("user_speaking");
  });
});
