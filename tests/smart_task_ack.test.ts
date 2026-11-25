// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: SystemOne 场景化简短首次应答词（Smart Task Ack）单元测试与端到端集成测试

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { PiAgentService } from "../src/agent/piAgentService.ts";
import {
  inferFallbackTaskAckScenario,
  resolveTaskAckPhrase,
  stripDuplicatedAckPrefix,
  TASK_ACK_PREWARM_PHRASES_ZH,
  TASK_ACK_SCENARIO_CATALOG,
  TASK_ACK_SCENARIOS,
  TASK_ACK_TEXT,
  type TaskAckScenario,
} from "../src/agent/taskAckPolicy.ts";
import { VoiceListenerController } from "../src/agent/voiceListenerController.ts";
import { defaultAgentVoiceConfig, type AgentVoiceConfig } from "../src/core/agentConfigStore.ts";
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

function createMockSystemOneAckFetcher(
  resolver: (
    utterance: string,
    state: Record<string, unknown>,
    init?: RequestInit,
  ) =>
    | { scenario: TaskAckScenario; confidence?: number; delayMs?: number }
    | Response
    | Promise<{ scenario: TaskAckScenario; confidence?: number; delayMs?: number } | Response>,
): { fetcher: FetchLike; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  const fetcher: FetchLike = async (_input, init) => {
    const payload = JSON.parse(String(init?.body ?? "{}")) as {
      model: string;
      state: Record<string, unknown>;
      questions: Record<string, unknown>;
    };
    calls.push(payload);
    const utterance = String(payload.state?.utterance ?? "");
    const decision = await resolver(utterance, payload.state, init);
    if (decision instanceof Response) {
      return decision;
    }
    if (decision.delayMs && decision.delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, decision.delayMs);
        init?.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
          },
          { once: true },
        );
      });
    }
    if (init?.signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    return new Response(
      JSON.stringify({
        model: payload.model || "karpo/karpo-decision-31b",
        answers: {
          task_ack: buildAckAnswer(decision.scenario, decision.confidence ?? 0.93),
        },
        usage: { input_tokens: 120, output_tokens: 1 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  return { fetcher, calls };
}

function createHarness(options: {
  service?: VirtualDemoService;
  initialConfig?: AgentVoiceConfig;
  customStreamFn?: ConstructorParameters<typeof PiAgentService>[0]["customStreamFn"];
  customModel?: ConstructorParameters<typeof PiAgentService>[0]["customModel"];
  systemOneFetcher?: FetchLike;
} = {}) {
  const service = options.service ?? new VirtualDemoService();
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

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "mijiadeck-smart-ack-"));
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

describe("Task Ack Policy Catalog & Offline Fallback", () => {
  test("maps all 9 scenarios to concise ZH & EN phrases and prewarms all Chinese phrases", () => {
    expect(TASK_ACK_SCENARIO_CATALOG.execute_control.zh).toBe("好的");
    expect(TASK_ACK_SCENARIO_CATALOG.query_status.zh).toBe("稍等我看一下");
    expect(TASK_ACK_SCENARIO_CATALOG.think_creative.zh).toBe("让我想想");
    expect(TASK_ACK_SCENARIO_CATALOG.scene_routine.zh).toBe("马上安排");
    expect(TASK_ACK_SCENARIO_CATALOG.troubleshoot.zh).toBe("我来排查一下");
    expect(TASK_ACK_SCENARIO_CATALOG.urgent_cancel.zh).toBe("马上处理");
    expect(TASK_ACK_SCENARIO_CATALOG.remember_rule.zh).toBe("明白，我记一下");
    expect(TASK_ACK_SCENARIO_CATALOG.safety_confirm.zh).toBe("先确认一下");
    expect(TASK_ACK_SCENARIO_CATALOG.greeting_chat.zh).toBe("在呢");

    expect(resolveTaskAckPhrase("execute_control", "打开灯光")).toBe("好的");
    expect(resolveTaskAckPhrase("query_status", "空调设置的多少度")).toBe("稍等我看一下");
    expect(resolveTaskAckPhrase("think_creative", "给我讲个笑话")).toBe("让我想想");
    expect(resolveTaskAckPhrase("execute_control", "帮我洗一下衣服")).toBe("好的");

    // Pure English utterances receive concise English acks; mixed CJK stays Chinese
    expect(resolveTaskAckPhrase("execute_control", "Turn on the living room light")).toBe("Okay");
    expect(resolveTaskAckPhrase("query_status", "What temperature is the AC set to?")).toBe("Let me check");
    expect(resolveTaskAckPhrase("think_creative", "Tell me a joke")).toBe("Let me think");
    expect(resolveTaskAckPhrase("execute_control", "打开 AC")).toBe("好的");

    // Prewarm list covers every unique ZH ack phrase
    for (const key of TASK_ACK_SCENARIOS) {
      expect(TASK_ACK_PREWARM_PHRASES_ZH).toContain(TASK_ACK_SCENARIO_CATALOG[key].zh);
    }
  });

  test("offline fallback classifies core examples and expanded scenarios without misclassifying regular device control", () => {
    const cases: Array<[string, TaskAckScenario, string]> = [
      ["打开灯光", "execute_control", "好的"],
      ["帮我洗一下衣服", "execute_control", "好的"],
      ["十分钟以后开灯", "execute_control", "好的"],
      ["把洗衣机开启智洗烘模式", "execute_control", "好的"],
      ["把空调温度调到26度", "execute_control", "好的"],
      ["空调设置的多少度", "query_status", "稍等我看一下"],
      ["客厅现在温度湿度多少", "query_status", "稍等我看一下"],
      ["家里哪些灯还开着", "query_status", "稍等我看一下"],
      ["给我讲个笑话", "think_creative", "让我想想"],
      ["晚上吃什么好呢", "think_creative", "让我想想"],
      ["为什么天空是蓝色的", "think_creative", "让我想想"],
      ["我要睡觉了", "scene_routine", "马上安排"],
      ["开启观影模式", "scene_routine", "马上安排"],
      ["为什么客厅灯没亮", "troubleshoot", "我来排查一下"],
      ["空调怎么打不开", "troubleshoot", "我来排查一下"],
      ["快停下别放了", "urgent_cancel", "马上处理"],
      ["不对，我说的是卧室的灯", "urgent_cancel", "马上处理"],
      ["以后记得洗衣默认用智洗烘模式", "remember_rule", "明白，我记一下"],
      ["把大门智能门锁打开", "safety_confirm", "先确认一下"],
      ["关闭监控摄像头", "safety_confirm", "先确认一下"],
      ["早上好", "greeting_chat", "在呢"],
      ["你好呀", "greeting_chat", "在呢"],
    ];

    for (const [input, expectedScenario, expectedPhrase] of cases) {
      const scenario = inferFallbackTaskAckScenario(input);
      expect(scenario).toBe(expectedScenario);
      expect(resolveTaskAckPhrase(scenario, input)).toBe(expectedPhrase);
    }
  });

  test("stripDuplicatedAckPrefix removes repeated scenario acks without stripping short replies", () => {
    expect(stripDuplicatedAckPrefix("好的，客厅吸顶灯已打开。", "好的")).toBe("客厅吸顶灯已打开。");
    expect(stripDuplicatedAckPrefix("稍等我看一下，空调设定为 26°C。", "稍等我看一下")).toBe(
      "空调设定为 26°C。",
    );
    expect(stripDuplicatedAckPrefix("让我想想，从前有个程序员。", "让我想想")).toBe(
      "从前有个程序员。",
    );
    expect(stripDuplicatedAckPrefix("让我想想！", "让我想想", { suppressPureMatch: true })).toBe("");
    expect(stripDuplicatedAckPrefix("好的", "好的")).toBe("好的");
  });
});

describe("PiAgentService Smart Immediate Ack via SystemOne", () => {
  test("uses SystemOne to choose scenario-specific ack BEFORE tool/LLM execution and deduplicates final voice TTS", async () => {
    const scenarioMap: Record<string, TaskAckScenario> = {
      打开灯光: "execute_control",
      空调设置的多少度: "query_status",
      给我讲个笑话: "think_creative",
      帮我洗一下衣服: "execute_control",
      我要睡觉了: "scene_routine",
      以后记得洗衣默认用智洗烘模式: "remember_rule",
      为什么客厅灯没亮: "troubleshoot",
      快停下别放了: "urgent_cancel",
      把智能门锁打开: "safety_confirm",
      早上好: "greeting_chat",
    };

    const { fetcher, calls } = createMockSystemOneAckFetcher((utterance) => ({
      scenario: scenarioMap[utterance] ?? "execute_control",
      confidence: 0.94,
    }));

    const faux = fauxProvider({
      models: [{ id: "faux-smart-ack-llm", name: "Faux Smart Ack LLM" }],
    });
    faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall("set_device_power", { target: "客厅吸顶灯", state: "on" })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("客厅吸顶灯已打开。", { stopReason: "stop" }),
      fauxAssistantMessage("稍等我看一下，卧室空调当前设定 26°C。", { stopReason: "stop" }),
      fauxAssistantMessage("让我想想，为什么程序员分不清万圣节和圣诞节？因为 Oct 31 等于 Dec 25。", {
        stopReason: "stop",
      }),
      fauxAssistantMessage("洗衣机准备就绪，请问选择智洗烘还是快洗？", { stopReason: "stop" }),
      fauxAssistantMessage("已为你调暗客厅灯光并准备入睡环境。", { stopReason: "stop" }),
      fauxAssistantMessage("已记住：以后洗衣默认用智洗烘模式。", { stopReason: "stop" }),
      fauxAssistantMessage("客厅吸顶灯当前在线，电源为关。", { stopReason: "stop" }),
      fauxAssistantMessage("已停止播放。", { stopReason: "stop" }),
      fauxAssistantMessage("安全提示：智能门锁开锁属于高风险操作，暂未执行，请确认是否继续？", {
        stopReason: "stop",
      }),
      fauxAssistantMessage("早上好！今天有什么需要我帮忙的？", { stopReason: "stop" }),
    ]);

    const cfg: AgentVoiceConfig = {
      ...defaultAgentVoiceConfig(),
      provider: "openai-compatible",
      baseUrl: "https://karpo.test.local/v1",
      apiKey: "sk-smart-ack-test-key",
      modelId: "faux-smart-ack-llm",
      systemOneMode: "on",
      cavemanMode: "off",
      autoSpeakReply: true,
    };

    const h = createHarness({
      initialConfig: cfg,
      customModel: faux.getModel(),
      customStreamFn: (m, ctx, opts) => faux.provider.streamSimple(m, ctx, opts),
      systemOneFetcher: fetcher,
    });

    try {
      await h.ready();
      const order: string[] = [];
      const spoken: Array<{ text: string; final: boolean }> = [];
      h.agent.on("streamEvent", (ev) => {
        if (ev.kind === "task_ack") {
          order.push(`task_ack:${String(ev.text)}:${String(ev.scenario)}`);
        } else if (ev.kind === "tool_start") {
          order.push(`tool_start:${String((ev.toolCall as any)?.name ?? "")}`);
        }
      });
      h.agent.on("speakChunk", (c) => {
        spoken.push({ text: c.text, final: c.final });
        order.push(`speak:${c.text}`);
      });

      // 1. 打开灯光 -> 好的 (strictly before tool_start!)
      const rLight = await h.agent.prompt("打开灯光", { source: "voice" });
      expect(rLight.ack).toBe("好的");
      expect(rLight.ackScenario).toBe("execute_control");
      expect(rLight.ackSource).toBe("systemone");
      expect(order.indexOf("task_ack:好的:execute_control")).toBeGreaterThanOrEqual(0);
      expect(order.indexOf("speak:好的")).toBeGreaterThan(order.indexOf("task_ack:好的:execute_control"));
      expect(order.indexOf("tool_start:set_device_power")).toBeGreaterThan(order.indexOf("speak:好的"));

      // 2. 空调设置的多少度 -> 稍等我看一下 (and dedups leading "稍等我看一下，" from final TTS!)
      spoken.length = 0;
      const rAc = await h.agent.prompt("空调设置的多少度", { source: "voice" });
      expect(rAc.ack).toBe("稍等我看一下");
      expect(rAc.ackScenario).toBe("query_status");
      expect(rAc.ackSource).toBe("systemone");
      expect(spoken[0]?.text).toBe("稍等我看一下");
      expect(spoken[spoken.length - 1]?.text).not.toStartWith("稍等我看一下");
      expect(spoken[spoken.length - 1]?.text).toContain("26°C");

      // Verify prior history sent to SystemOne excludes the current utterance
      const acCallState = calls[1]?.state as Record<string, unknown>;
      expect(acCallState.utterance).toBe("空调设置的多少度");
      expect(Array.isArray(acCallState.history)).toBe(true);
      expect((acCallState.history as string[]).some((line) => line.includes("空调设置的多少度"))).toBe(false);
      expect((acCallState.history as string[]).some((line) => line.includes("打开灯光"))).toBe(true);

      // 3. 给我讲个笑话 -> 让我想想 (and dedups leading "让我想想，" from final TTS!)
      spoken.length = 0;
      const rJoke = await h.agent.prompt("给我讲个笑话", { source: "voice" });
      expect(rJoke.ack).toBe("让我想想");
      expect(rJoke.ackScenario).toBe("think_creative");
      expect(spoken[0]?.text).toBe("让我想想");
      expect(spoken[spoken.length - 1]?.text).not.toStartWith("让我想想");

      // 4. 帮我洗一下衣服 -> 好的
      const rWash = await h.agent.prompt("帮我洗一下衣服", { source: "voice" });
      expect(rWash.ack).toBe("好的");
      expect(rWash.ackScenario).toBe("execute_control");

      // 5-10. Expanded scenarios
      expect((await h.agent.prompt("我要睡觉了", { source: "text" })).ack).toBe("马上安排");
      expect((await h.agent.prompt("以后记得洗衣默认用智洗烘模式", { source: "text" })).ack).toBe(
        "明白，我记一下",
      );
      expect((await h.agent.prompt("为什么客厅灯没亮", { source: "text" })).ack).toBe("我来排查一下");
      expect((await h.agent.prompt("快停下别放了", { source: "text" })).ack).toBe("马上处理");
      expect((await h.agent.prompt("把智能门锁打开", { source: "text" })).ack).toBe("先确认一下");
      expect((await h.agent.prompt("早上好", { source: "text" })).ack).toBe("在呢");

      expect(calls).toHaveLength(10);
    } finally {
      await h.cleanup();
    }
  });

  test("degrades smoothly to offline fallback when SystemOne fails or has low confidence", async () => {
    let mode: "error500" | "lowConf" = "error500";
    const { fetcher } = createMockSystemOneAckFetcher(() => {
      if (mode === "error500") {
        return new Response("upstream failure", { status: 500 });
      }
      return { scenario: "greeting_chat", confidence: 0.25 };
    });

    const faux = fauxProvider({
      models: [{ id: "faux-fallback-llm", name: "Faux Fallback LLM" }],
    });
    faux.setResponses([
      fauxAssistantMessage("卧室空调当前设定 25°C。", { stopReason: "stop" }),
      fauxAssistantMessage("从前有只小猫学编程。", { stopReason: "stop" }),
      fauxAssistantMessage("已打开客厅灯。", { stopReason: "stop" }),
    ]);

    const cfg: AgentVoiceConfig = {
      ...defaultAgentVoiceConfig(),
      provider: "openai-compatible",
      baseUrl: "https://karpo.test.local/v1",
      apiKey: "sk-fallback-test-key",
      modelId: "faux-fallback-llm",
      systemOneMode: "on",
    };

    const h = createHarness({
      initialConfig: cfg,
      customModel: faux.getModel(),
      customStreamFn: (m, ctx, opts) => faux.provider.streamSimple(m, ctx, opts),
      systemOneFetcher: fetcher,
    });

    try {
      await h.ready();
      // 1. HTTP 500 -> falls back to deterministic query_status ("稍等我看一下")
      const r1 = await h.agent.prompt("空调设置的多少度");
      expect(r1.ok).toBe(true);
      expect(r1.ack).toBe("稍等我看一下");
      expect(r1.ackScenario).toBe("query_status");
      expect(r1.ackSource).toBe("fallback");

      // 2. Low confidence (0.25 < 0.45) -> falls back to deterministic think_creative ("让我想想")
      mode = "lowConf";
      const r2 = await h.agent.prompt("给我讲个笑话");
      expect(r2.ok).toBe(true);
      expect(r2.ack).toBe("让我想想");
      expect(r2.ackScenario).toBe("think_creative");
      expect(r2.ackSource).toBe("fallback");

      // 3. SystemOne mode off -> zero SystemOne HTTP call, defaults safely to TASK_ACK_TEXT for control
      h.agent.reconfigure({ ...cfg, systemOneMode: "off" });
      const r3 = await h.agent.prompt("打开灯光");
      expect(r3.ok).toBe(true);
      expect(r3.ack).toBe(TASK_ACK_TEXT);
      expect(r3.ackSource).toBe("fallback");
    } finally {
      await h.cleanup();
    }
  });

  test("aborting while SystemOne ack is in flight cancels cleanly without tripping breaker or leaking ack/speak", async () => {
    const { fetcher } = createMockSystemOneAckFetcher((utterance) => ({
      scenario: utterance.includes("笑话") ? "think_creative" : "query_status",
      delayMs: utterance.includes("笑话") ? 200 : 0,
    }));

    const faux = fauxProvider({
      models: [{ id: "faux-abort-llm", name: "Faux Abort LLM" }],
    });
    faux.setResponses([
      fauxAssistantMessage("卧室空调设定 26°C。", { stopReason: "stop" }),
    ]);

    const cfg: AgentVoiceConfig = {
      ...defaultAgentVoiceConfig(),
      provider: "openai-compatible",
      baseUrl: "https://karpo.test.local/v1",
      apiKey: "sk-abort-test-key",
      modelId: "faux-abort-llm",
      systemOneMode: "on",
      autoSpeakReply: true,
    };

    const h = createHarness({
      initialConfig: cfg,
      customModel: faux.getModel(),
      customStreamFn: (m, ctx, opts) => faux.provider.streamSimple(m, ctx, opts),
      systemOneFetcher: fetcher,
    });

    try {
      await h.ready();
      const ackEvents: string[] = [];
      const spoken: string[] = [];
      h.agent.on("streamEvent", (ev) => {
        if (ev.kind === "task_ack") ackEvents.push(String(ev.text));
      });
      h.agent.on("speakChunk", (c) => spoken.push(c.text));

      const p1 = h.agent.prompt("给我讲个笑话", { source: "voice" });
      await Bun.sleep(25);
      // Barge-in with a new prompt while Turn 1's SystemOne call is still pending
      const p2 = h.agent.prompt("空调设置的多少度", { source: "voice" });

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1.ok).toBe(false);
      expect(r1.ack).toBe("");
      expect(r2.ok).toBe(true);
      expect(r2.ack).toBe("稍等我看一下");
      expect(r2.ackSource).toBe("systemone");
      // Only Turn 2 emitted task_ack & spoken ack; SystemOne circuit breaker stayed closed
      expect(ackEvents).toEqual(["稍等我看一下"]);
      expect(spoken[0]).toBe("稍等我看一下");
      expect(h.agent.systemOneClient?.getStatus().circuitState).toBe("closed");
      expect(h.agent.systemOneClient?.getStatus().lastFailureKind).toBe("none");
    } finally {
      await h.cleanup();
    }
  });

  test("POST /api/agent/prompt exposes SystemOne ack, ackScenario, and ackSource", async () => {
    const demo = new VirtualDemoService();
    const { fetcher } = createMockSystemOneAckFetcher((utterance) => ({
      scenario: utterance.includes("笑话") ? "think_creative" : "query_status",
      confidence: 0.96,
    }));
    const faux = fauxProvider({
      models: [{ id: "faux-http-ack", name: "Faux HTTP Ack" }],
    });
    faux.setResponses([
      fauxAssistantMessage("空调当前设定 26°C。", { stopReason: "stop" }),
    ]);

    server = await startMijiaDeckServer({
      mode: "demo",
      port: 0,
      service: demo,
      agentModel: faux.getModel(),
      agentStreamFn: (m, ctx, opts) => faux.provider.streamSimple(m, ctx, opts),
      systemOneFetcher: fetcher as unknown as typeof fetch,
    });

    await fetch(`${server.url}/api/agent/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "openai-compatible",
        baseUrl: "http://127.0.0.1:19999/v1",
        apiKey: "sk-http-ack-test",
        systemOneMode: "on",
      }),
    });

    const res = await fetch(`${server.url}/api/agent/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "空调设置的多少度", source: "text" }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.ok).toBe(true);
    expect(json.ack).toBe("稍等我看一下");
    expect(json.ackScenario).toBe("query_status");
    expect(json.ackSource).toBe("systemone");
  });

  test("VoiceListenerController.prewarmLocalTts prewarms all Chinese scenario ack phrases", async () => {
    const h = createHarness();
    const prewarmed: string[] = [];
    const fakeLocalEngine = {
      tts: {
        warmup: async (opts: { prewarmTexts?: readonly string[] }) => {
          prewarmed.push(...(opts.prewarmTexts ?? []));
        },
      },
      getStatus: () => ({ readyForLocalAsr: false, readyForSourceSeparation: false }),
      setPreferredAsrEngine: () => {},
      setQwen3ComputeDevice: () => {},
      dispose: () => {},
    } as any;

    const vl = new VoiceListenerController(h.agent, {
      localEngine: fakeLocalEngine,
    });

    try {
      await vl.prewarmLocalTts();
      for (const phrase of TASK_ACK_PREWARM_PHRASES_ZH) {
        expect(prewarmed).toContain(phrase);
      }
    } finally {
      vl.dispose();
      await h.cleanup();
    }
  });
});
