// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: SystemOne 延迟优化与适配回归测试

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { LocalVoiceEngine, type LocalAsrOutput } from "../src/agent/localVoiceEngine.ts";
import { PiAgentService } from "../src/agent/piAgentService.ts";
import {
  SystemOneClient,
  type ConversationActionChoice,
  type TaskAckScenario,
} from "../src/agent/systemOneClient.ts";
import {
  classifyDeterministicTaskAck,
  isSelfContainedTaskAckUtterance,
  TASK_ACK_QUESTION,
  TASK_ACK_SCENARIOS,
} from "../src/agent/taskAckPolicy.ts";
import { evaluateVoiceAttention } from "../src/agent/voiceAttentionGate.ts";
import { VoiceListenerController } from "../src/agent/voiceListenerController.ts";
import {
  DEFAULT_SYSTEMONE_MODEL,
  defaultAgentVoiceConfig,
  normalizeAgentVoiceConfig,
  type AgentVoiceConfig,
} from "../src/core/agentConfigStore.ts";
import { NetworkMonitor } from "../src/core/availability.ts";
import type { FetchLike } from "../src/core/httpTimeout.ts";
import { JobExecutor } from "../src/core/jobs.ts";
import { setDataPathOverrides } from "../src/core/jsonStore.ts";
import * as settingsStore from "../src/core/settingsStore.ts";
import { VirtualDemoService } from "../src/core/virtualLightService.ts";
import { MainWindowController } from "../src/ui/controllers/mainWindowController.ts";
import { applyTheme, ThemeController } from "../src/ui/theme.ts";

let tmpDir = "";

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "mijiadeck-s1-latency-"));
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

function buildAckAnswer(choice: TaskAckScenario, confidence = 0.93) {
  const probs = {} as Record<TaskAckScenario, number>;
  const rem = Number(((1 - confidence) / (TASK_ACK_SCENARIOS.length - 1)).toFixed(4));
  for (const key of TASK_ACK_SCENARIOS) {
    probs[key] = key === choice ? confidence : rem;
  }
  return {
    type: "choice",
    choice,
    probabilities: probs,
    confidence,
  };
}

function createHarness(options: {
  initialConfig?: AgentVoiceConfig;
  customStreamFn?: ConstructorParameters<typeof PiAgentService>[0]["customStreamFn"];
  customModel?: ConstructorParameters<typeof PiAgentService>[0]["customModel"];
  systemOneFetcher?: FetchLike;
} = {}) {
  const service = new VirtualDemoService();
  const jobs = new JobExecutor();
  applyTheme("dark", "green");
  const themeCtrl = new ThemeController("dark");
  const networkMonitor = new NetworkMonitor({
    initialReachability: "online",
    autoStart: false,
  });
  const mainWindow = new MainWindowController({
    service,
    jobs,
    themeCtrl,
    networkMonitor,
    autoStartTimers: false,
    cacheLoader: () => null,
    cacheSaver: () => {},
  });

  const agent = new PiAgentService({
    deps: {
      service,
      jobs,
      mainWindow,
      settingsStore,
      broadcastState: () => {},
    },
    ...(options.initialConfig ? { initialConfig: options.initialConfig } : {}),
    ...(options.customStreamFn ? { customStreamFn: options.customStreamFn } : {}),
    ...(options.customModel ? { customModel: options.customModel } : {}),
    ...(options.systemOneFetcher ? { systemOneFetcher: options.systemOneFetcher } : {}),
  });

  return {
    service,
    jobs,
    mainWindow,
    agent,
    async ready() {
      mainWindow.start();
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        if (!mainWindow.loadActive && !mainWindow.loadingDevices && mainWindow.allDevices.length > 0) {
          break;
        }
        await Bun.sleep(15);
      }
    },
    async cleanup() {
      agent.dispose();
      networkMonitor.stop();
      mainWindow.dispose();
      await jobs.shutdown();
    },
  };
}

describe("SystemOneClient Latency Optimizations", () => {
  test("compact question schemas & state deduplication significantly shrink payload bytes", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetcher: FetchLike = async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      bodies.push(body);
      const q = body.questions as Record<string, unknown>;
      const answers: Record<string, unknown> = {};
      if ("decision" in q) {
        answers.decision = {
          type: "choice",
          choice: "valid_wake",
          probabilities: { valid_wake: 0.94, false_wake: 0.06 },
          confidence: 0.94,
        };
      }
      if ("device_command" in q) {
        answers.device_command = {
          type: "choice",
          choice: "no_device_command",
          probabilities: { has_device_command: 0.05, no_device_command: 0.95 },
          confidence: 0.95,
        };
      }
      if ("conv_action" in q) {
        answers.conv_action = {
          type: "choice",
          choice: "followup",
          probabilities: { followup: 0.92, side_talk: 0.04, goodbye: 0.04 },
          confidence: 0.92,
        };
      }
      if ("task_ack" in q) {
        answers.task_ack = buildAckAnswer("query_status", 0.94);
      }
      return new Response(
        JSON.stringify({
          model: DEFAULT_SYSTEMONE_MODEL,
          answers,
          usage: { input_tokens: 100, output_tokens: 4 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const client = new SystemOneClient({
      baseUrl: "https://karpo.local.test/v1",
      apiKey: "sk-compact-test",
      fetcher,
    });

    await client.evaluateWakeAttention({
      utterance: "Neo，明天天气怎么样",
      wakeWords: ["Neo"],
    });
    await client.evaluateConversationTurn(
      {
        utterance: "有点暗",
        recentHistory: [
          { role: "user", text: "打开客厅灯" },
          { role: "assistant", text: "已打开客厅吸顶灯" },
        ],
        lastSpokenReply: "已打开客厅吸顶灯",
        wakeWords: ["Neo", "Hey Neo"],
      },
      { includeIntent: false },
    );
    await client.classifyTaskAck({
      utterance: "空调设置的多少度",
      source: "voice",
      recentHistory: [
        { role: "user", text: "turn 1" },
        { role: "assistant", text: "reply 1" },
        { role: "user", text: "turn 2" },
        { role: "assistant", text: "reply 2" },
        { role: "user", text: "打开客厅灯" },
      ],
    });

    expect(bodies).toHaveLength(3);

    // 1. Wake questions payload stays compact (< 900 chars total vs ~1826 chars previously)
    const wakeQChars = JSON.stringify(bodies[0]!.questions).length;
    expect(wakeQChars).toBeLessThan(950);

    // 2. Conversation state deduplicates last_spoken_reply already present in history & omits wake_words when no alt/acousticWake
    const convState = bodies[1]!.state as Record<string, unknown>;
    expect(convState.last_spoken_reply).toBeUndefined();
    expect(convState.wake_words).toBeUndefined();
    expect(Object.keys(bodies[1]!.questions as Record<string, unknown>)).toEqual(["conv_action"]);
    expect(JSON.stringify(bodies[1]!.questions).length).toBeLessThan(750);

    // 3. Task Ack schema is compact (< 750 chars vs ~1900 chars previously) and history capped to <= 3 entries
    expect(JSON.stringify(TASK_ACK_QUESTION).length).toBeLessThan(750);
    const ackState = bodies[2]!.state as Record<string, unknown>;
    expect(Array.isArray(ackState.history)).toBe(true);
    expect((ackState.history as string[]).length).toBeLessThanOrEqual(3);
  });

  test("coalesces concurrent identical requests (singleflight) while isolating per-caller abort signals", async () => {
    let fetchCount = 0;
    let releaseFetch!: () => void;
    let fetchAborted = false;

    const fetcher: FetchLike = (_url, init) => {
      fetchCount += 1;
      return new Promise<Response>((resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            fetchAborted = true;
            reject(new DOMException("Aborted", "AbortError"));
          },
          { once: true },
        );
        releaseFetch = () => {
          resolve(
            new Response(
              JSON.stringify({
                model: DEFAULT_SYSTEMONE_MODEL,
                answers: {
                  q: { type: "choice", choice: "yes", probabilities: { yes: 0.95, no: 0.05 }, confidence: 0.95 },
                },
                usage: { input_tokens: 20, output_tokens: 2 },
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            ),
          );
        };
      });
    };

    const client = new SystemOneClient({
      baseUrl: "https://coalesce.test/v1",
      apiKey: "sk-coalesce",
      fetcher,
    });

    const ac1 = new AbortController();
    const ac2 = new AbortController();
    const q = { q: { type: "choice" as const, instructions: "ok?", criteria: { yes: "y", no: "n" } } };

    const p1 = client.decide({ utterance: "hello" }, q, { signal: ac1.signal });
    const p2 = client.decide({ utterance: "hello" }, q, { signal: ac2.signal });

    // Only ONE underlying HTTP request should be sent for both identical calls
    expect(fetchCount).toBe(1);
    expect(client.getStatus().coalescedCalls).toBe(1);

    // Aborting caller 1 must NOT abort the shared request while caller 2 is still waiting
    ac1.abort();
    expect(await p1).toBeNull();
    expect(fetchAborted).toBe(false);

    // Completing the shared fetch resolves caller 2 cleanly
    releaseFetch();
    const r2 = await p2;
    expect(r2?.answers.q.choice).toBe("yes");
    expect(client.getStatus().circuitState).toBe("closed");
  });

  test("caches confident classifyTaskAck results across turns for self-contained utterances and respects softTimeout without tripping breaker", async () => {
    let nowMs = 1_000_000;
    let fetchCount = 0;
    let mode: "ok" | "hang" = "ok";

    const fetcher: FetchLike = (_url, init) => {
      fetchCount += 1;
      if (mode === "hang") {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init?.signal?.reason ?? new DOMException("Timed out", "TimeoutError")),
            { once: true },
          );
        });
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            model: DEFAULT_SYSTEMONE_MODEL,
            answers: {
              task_ack: buildAckAnswer("query_status", 0.94),
            },
            usage: { input_tokens: 60, output_tokens: 1 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    };

    const client = new SystemOneClient({
      baseUrl: "https://ackcache.test/v1",
      apiKey: "sk-ack-cache",
      timeoutMs: 2000,
      fetcher,
      now: () => nowMs,
    });

    // 1. Self-contained utterance hits cache even when prior history changes!
    expect(isSelfContainedTaskAckUtterance("空调设置的多少度")).toBe(true);
    expect(isSelfContainedTaskAckUtterance("那这个呢")).toBe(false);

    const a1 = await client.classifyTaskAck({
      utterance: "空调设置的多少度？",
      source: "voice",
      recentHistory: [{ role: "user", text: "打开客厅灯" }],
    });
    expect(a1?.cached).toBe(false);
    expect(a1?.ackText).toBe("稍等我看一下");
    expect(fetchCount).toBe(1);

    nowMs += 60_000; // 1 min later (< 5 min TTL), different history
    const a2 = await client.classifyTaskAck({
      utterance: "空调设置的多少度",
      source: "voice",
      recentHistory: [{ role: "user", text: "关闭卧室灯" }],
    });
    expect(a2?.cached).toBe(true);
    expect(a2?.latencyMs).toBe(0);
    expect(a2?.ackText).toBe("稍等我看一下");
    expect(fetchCount).toBe(1);

    // 2. Soft timeout returns null cleanly without tripping circuit breaker, and enters congestion cooldown
    mode = "hang";
    const s1 = await client.classifyTaskAck(
      { utterance: "帮我分析一下房间湿度" },
      { timeoutMs: 30, softTimeout: true },
    );
    const s2 = await client.classifyTaskAck(
      { utterance: "帮我分析一下房间亮度" },
      { timeoutMs: 30, softTimeout: true },
    );
    expect(s1).toBeNull();
    expect(s2).toBeNull();
    expect(client.getStatus().circuitState).toBe("closed");
    expect(client.getStatus().softTimeouts).toBe(2);
    expect(client.isCongestedForNonCritical).toBe(true);

    // Congestion window expires after 15s
    nowMs += 16_000;
    expect(client.isCongestedForNonCritical).toBe(false);
  });

  test("throttles repeated preconnect() calls within window and allows force override", () => {
    let nowMs = 10_000;
    const preconnectCalls: string[] = [];
    const fetcher = Object.assign(
      (async () => new Response("{}", { status: 200 })) as FetchLike,
      {
        preconnect: (origin: string) => {
          preconnectCalls.push(origin);
        },
      },
    );

    const client = new SystemOneClient({
      baseUrl: "https://preconnect.test/v1",
      apiKey: "sk-preconnect",
      fetcher,
      now: () => nowMs,
    });

    client.preconnect();
    client.preconnect();
    nowMs += 5_000;
    client.preconnect();
    expect(preconnectCalls).toHaveLength(1);

    client.preconnect({ force: true });
    expect(preconnectCalls).toHaveLength(2);

    nowMs += 16_000;
    client.preconnect();
    expect(preconnectCalls).toHaveLength(3);
  });
});

describe("VoiceAttentionGate & LocalVoiceEngine Latency Reductions", () => {
  test("fast-paths clear follow-up device commands in conversation mode (0 SystemOne calls) and drops unused intent question on implicit turns", async () => {
    const seenQuestions: string[][] = [];
    const fetcher: FetchLike = async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        questions: Record<string, unknown>;
      };
      seenQuestions.push(Object.keys(body.questions).sort());
      return new Response(
        JSON.stringify({
          model: DEFAULT_SYSTEMONE_MODEL,
          answers: {
            conv_action: {
              type: "choice",
              choice: "followup",
              probabilities: { followup: 0.93, side_talk: 0.04, goodbye: 0.03 },
              confidence: 0.93,
            },
          },
          usage: { input_tokens: 90, output_tokens: 3 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const client = new SystemOneClient({
      baseUrl: "https://gate.test/v1",
      apiKey: "sk-gate",
      fetcher,
    });

    // Clear follow-ups that previously fell through to SystemOne now run in 0ms
    for (const cmd of [
      "再亮一点",
      "稍微暗一点",
      "还是关了吧",
      "房间太热了，把空调调到26度",
      "请帮我把卧室空调温度调到26度并打开除湿",
    ]) {
      const dec = await evaluateVoiceAttention({
        rawText: cmd,
        wakeWordEnabled: true,
        wakeWords: ["Neo"],
        attentionMode: "smart",
        dialogState: "conversation",
        inConversation: true,
        systemOneClient: client,
      });
      expect(dec.accept).toBe(true);
      expect(dec.stage).toBe("fast-followup");
      expect(dec.usedSystemOne).toBeUndefined();
    }

    // Exact wake word + mid-clause explicit device command also takes 0ms fast-wake
    const wakeExplicit = await evaluateVoiceAttention({
      rawText: "Neo，房间太热了，把空调调到26度",
      wakeWordEnabled: true,
      wakeWords: ["Neo"],
      attentionMode: "smart",
      dialogState: "standby",
      systemOneClient: client,
    });
    expect(wakeExplicit.accept).toBe(true);
    expect(wakeExplicit.stage).toBe("fast-wake");
    expect(seenQuestions).toHaveLength(0);

    // Implicit complaint in conversation still calls SystemOne, but asks ONLY conv_action (NO unused intent question!)
    const implicit = await evaluateVoiceAttention({
      rawText: "有点暗",
      wakeWordEnabled: true,
      wakeWords: ["Neo"],
      attentionMode: "smart",
      dialogState: "conversation",
      inConversation: true,
      systemOneClient: client,
    });
    expect(implicit.accept).toBe(true);
    expect(implicit.stage).toBe("systemone-attention");
    expect(implicit.usedSystemOne).toBe(true);
    expect(seenQuestions).toEqual([["conv_action"]]);
  });

  test("LocalVoiceEngine.transcribeDualTrack clears altText after SystemOne selectDualTrackAsr resolves to prevent duplicate asr_best evaluation", async () => {
    const client = new SystemOneClient({
      baseUrl: "https://dual.test/v1",
      apiKey: "sk-dual",
      fetcher: (async () =>
        new Response(
          JSON.stringify({
            model: DEFAULT_SYSTEMONE_MODEL,
            answers: {
              asr_best: {
                type: "choice",
                choice: "track_b",
                probabilities: { track_a: 0.08, track_b: 0.9, neither_noise: 0.02 },
                confidence: 0.9,
              },
            },
            usage: { input_tokens: 40, output_tokens: 2 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )) as FetchLike,
    });

    const engine = new LocalVoiceEngine();
    let idx = 0;
    (engine as unknown as { transcribeLocal: (...args: unknown[]) => Promise<LocalAsrOutput> }).transcribeLocal =
      async () => {
        idx += 1;
        return idx === 1
          ? {
              text: "有点暗的歌词",
              rawText: "有点暗的歌词",
              lang: "zh",
              emotion: "",
              event: "<|BGM|>",
              engine: "sensevoice-local",
              durationMs: 15,
            }
          : {
              text: "有点暗",
              rawText: "有点暗",
              lang: "zh",
              emotion: "",
              event: "<|BGM|>",
              engine: "sensevoice-local",
              durationMs: 15,
            };
      };

    try {
      const pcm = new Float32Array(16000).fill(0.05);
      const out = await engine.transcribeDualTrack(pcm, pcm, {
        voiceLang: "zh-CN",
        wakeWords: ["Neo"],
        inputSnrDb: 4,
        forceDual: true,
        systemOneClient: client,
      });
      expect(out.text).toBe("有点暗");
      expect(out.altText).toBeUndefined();
    } finally {
      engine.dispose();
    }
  });
});

describe("PiAgentService & VoiceListenerController Auto-Mode Ack & Preconnect", () => {
  test("classifyDeterministicTaskAck resolves clear commands/queries/complaints in 0ms while returning null for ambiguous speech", () => {
    expect(classifyDeterministicTaskAck("打开客厅吸顶灯")?.scenario).toBe("execute_control");
    expect(classifyDeterministicTaskAck("下一首")?.scenario).toBe("execute_control");
    expect(classifyDeterministicTaskAck("暂停")?.scenario).toBe("execute_control");
    expect(classifyDeterministicTaskAck("我觉得客厅有点暗呢")?.scenario).toBe("execute_control");
    expect(classifyDeterministicTaskAck("空调设置的多少度")?.scenario).toBe("query_status");
    expect(classifyDeterministicTaskAck("给我讲个笑话")?.scenario).toBe("think_creative");
    expect(classifyDeterministicTaskAck("我要睡觉了")?.scenario).toBe("scene_routine");
    expect(classifyDeterministicTaskAck("为什么客厅灯没亮")?.scenario).toBe("troubleshoot");
    expect(classifyDeterministicTaskAck("快停下别放了")?.scenario).toBe("urgent_cancel");
    expect(classifyDeterministicTaskAck("以后记得洗衣默认用智洗烘模式")?.scenario).toBe("remember_rule");
    expect(classifyDeterministicTaskAck("把大门智能门锁打开")?.scenario).toBe("safety_confirm");
    expect(classifyDeterministicTaskAck("早上好")?.scenario).toBe("greeting_chat");

    // Ambiguous / open / interrogative-control utterances return null so SystemOne can disambiguate
    expect(classifyDeterministicTaskAck("那以后不要出现这种情况了")).toBeNull();
    expect(classifyDeterministicTaskAck("今天适合洗衣服吗")).toBeNull();
    expect(classifyDeterministicTaskAck("帮我看看这个方案")).toBeNull();
  });

  test("in auto mode, clear utterances & post-slow-attention voice turns avoid blocking SystemOne task_ack calls, while wake/speech events trigger preconnect", async () => {
    let sysOneAckCalls = 0;
    const preconnectOrigins: string[] = [];

    const mockFetcher = Object.assign(
      (async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          questions: Record<string, unknown>;
        };
        const answers: Record<string, unknown> = {};
        if ("task_ack" in body.questions) {
          sysOneAckCalls += 1;
          answers.task_ack = buildAckAnswer("think_creative", 0.91);
        }
        return new Response(
          JSON.stringify({
            model: DEFAULT_SYSTEMONE_MODEL,
            answers,
            usage: { input_tokens: 80, output_tokens: 1 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }) as FetchLike,
      {
        preconnect: (origin: string) => {
          preconnectOrigins.push(origin);
        },
      },
    );

    const faux = fauxProvider({
      models: [{ id: "faux-auto-ack", name: "Faux Auto Ack" }],
    });
    faux.setResponses([
      fauxAssistantMessage("已打开客厅吸顶灯。", { stopReason: "stop" }),
      fauxAssistantMessage("空调设定为 26°C。", { stopReason: "stop" }),
      fauxAssistantMessage("好的，我明白了。", { stopReason: "stop" }),
      fauxAssistantMessage("我们可以先看室内温湿度再决定。", { stopReason: "stop" }),
    ]);

    const cfg = normalizeAgentVoiceConfig({
      ...defaultAgentVoiceConfig(),
      provider: "openai-compatible",
      baseUrl: "https://auto-opt.test/v1",
      apiKey: "sk-auto-opt-key",
      modelId: "faux-auto-ack",
      systemOneMode: "auto",
      cavemanMode: "off",
      autoSpeakReply: false,
    });

    const h = createHarness({
      initialConfig: cfg,
      customModel: faux.getModel(),
      customStreamFn: (m, ctx, opts) => faux.provider.streamSimple(m, ctx, opts),
      systemOneFetcher: mockFetcher,
    });
    const vl = new VoiceListenerController(h.agent);

    try {
      await h.ready();

      // Wake spot triggers proactive preconnect to SystemOne origin before ASR even finishes
      vl.recordWakeWordSpot({
        wakeWord: "Neo",
        score: 0.85,
        rawScore: 0.85,
        threshold: 0.6,
        matched: true,
        source: "enrolled",
        frameIndex: 1,
        sampleOffset: 1600,
        latencyMs: 4,
      });
      expect(preconnectOrigins).toEqual(["https://auto-opt.test"]);

      // 1. Clear control command -> 0ms deterministic ack, 0 SystemOne calls
      const r1 = await h.agent.prompt("打开客厅吸顶灯", { source: "voice" });
      expect(r1.ack).toBe("好的");
      expect(r1.ackScenario).toBe("execute_control");
      expect(sysOneAckCalls).toBe(0);

      // 2. Clear query -> 0ms deterministic ack ("稍等我看一下"), 0 SystemOne calls
      const r2 = await h.agent.prompt("空调设置的多少度", { source: "voice" });
      expect(r2.ack).toBe("稍等我看一下");
      expect(r2.ackScenario).toBe("query_status");
      expect(sysOneAckCalls).toBe(0);

      // 3. Ambiguous utterance when attention already spent 600ms on SystemOne -> avoids 2nd serial SystemOne wait!
      const r3 = await h.agent.prompt("那以后不要出现这种情况了", {
        source: "voice",
        voiceMeta: { attentionSystemOneMs: 600 },
      });
      expect(r3.ok).toBe(true);
      expect(sysOneAckCalls).toBe(0);

      // 4. Ambiguous utterance with 0 prior SystemOne cost -> still uses SystemOne for smart ack!
      const r4 = await h.agent.prompt("帮我看看这个方案", { source: "voice" });
      expect(r4.ack).toBe("让我想想");
      expect(r4.ackScenario).toBe("think_creative");
      expect(r4.ackSource).toBe("systemone");
      expect(sysOneAckCalls).toBe(1);
    } finally {
      vl.dispose();
      await h.cleanup();
    }
  });
});
