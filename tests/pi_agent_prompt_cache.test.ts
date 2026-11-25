// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: Pi Agent 连续任务 Prompt KV-Cache 稳定性与命中率优化回归测试

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  buildModelForConfig,
  PiAgentService,
  stripRuntimeContextBlock,
} from "../src/agent/piAgentService.ts";
import {
  buildRuntimeContextBlock,
  computeCacheFriendlyCompaction,
  createEmptyUsageSummary,
  formatTurnUserPrompt,
  recordUsageIntoSummary,
  snapshotDeviceLiveStates,
} from "../src/agent/promptCacheOptimizer.ts";
import {
  defaultAgentVoiceConfig,
  normalizeAgentVoiceConfig,
} from "../src/core/agentConfigStore.ts";
import { NetworkMonitor } from "../src/core/availability.ts";
import { JobExecutor } from "../src/core/jobs.ts";
import { setDataPathOverrides } from "../src/core/jsonStore.ts";
import { createDeviceInfo } from "../src/core/models.ts";
import * as settingsStore from "../src/core/settingsStore.ts";
import { VirtualDemoService } from "../src/core/virtualLightService.ts";
import { MainWindowController } from "../src/ui/controllers/mainWindowController.ts";
import { applyTheme, ThemeController } from "../src/ui/theme.ts";

let tmpDir = "";

function createHarness(options: {
  service?: VirtualDemoService;
  initialConfig?: ReturnType<typeof normalizeAgentVoiceConfig>;
  customStreamFn?: ConstructorParameters<typeof PiAgentService>[0]["customStreamFn"];
  customModel?: ConstructorParameters<typeof PiAgentService>[0]["customModel"];
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

function commonPrefixChars(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) {
    i += 1;
  }
  return i;
}

function extractMsgText(msg: { content?: unknown }): string {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return (msg.content as Array<{ type?: string; text?: string }>)
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n");
  }
  return "";
}

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "mijiadeck-prompt-cache-"));
  setDataPathOverrides({
    dataDir: () => tmpDir,
    dataFile: (name: string) => path.join(tmpDir, name),
  });
});

afterEach(() => {
  setDataPathOverrides(null);
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = "";
  }
});

describe("PromptCacheOptimizer Pure Primitives", () => {
  test("stripRuntimeContextBlock cleanly unwraps user command and preserves plain input", () => {
    const wrapped = formatTurnUserPrompt(
      "把客厅吸顶灯亮度调到80%",
      "当前本地时间：2026-11-26 02:18（周四，凌晨）\nChannel: text.",
    );
    expect(wrapped).toContain("<runtime_context>");
    expect(wrapped).toContain("</runtime_context>");
    expect(stripRuntimeContextBlock(wrapped)).toBe("把客厅吸顶灯亮度调到80%");
    expect(stripRuntimeContextBlock("打开客厅灯")).toBe("打开客厅灯");
  });

  test("buildRuntimeContextBlock emits full baseline first, then compact incremental deltas only", () => {
    const d1 = createDeviceInfo({
      did: "dev_b",
      name: "客厅吸顶灯",
      model: "yeelink.light.ceiling1",
      home_name: "我的家",
      room_name: "客厅",
      online: true,
    });
    const d2 = createDeviceInfo({
      did: "dev_a",
      name: "门锁",
      model: "lumi.lock.mcn01",
      home_name: "我的家",
      room_name: "玄关",
      online: false,
    });
    const d3 = createDeviceInfo({
      did: "midea:washer_1",
      name: "洗衣机",
      model: "midea.washer.demo",
      home_name: "我的家",
      room_name: "阳台",
      online: true,
    });

    const snap1 = snapshotDeviceLiveStates(
      [d1, d2, d3],
      { dev_b: false },
      { "midea:washer_1": "下筒 178分" },
    );
    const baseline = buildRuntimeContextBlock({
      localTimeLine: "当前本地时间：2026-11-26 02:18（周四，凌晨）",
      source: "voice",
      voiceMeta: { speakerName: "Henry", speakerRole: "owner", intent: "device_control" },
      currentStates: snap1,
      previousStates: null,
    });
    expect(baseline).toContain("当前本地时间：2026-11-26 02:18");
    expect(baseline).toContain("Speaker: Henry (owner).");
    expect(baseline).toContain("Intent hint: device_control.");
    expect(baseline).toContain("离线设备（其余 2 台在线）：门锁(dev_a)");
    expect(baseline).toContain("实时设备状态（基准快照）：");
    expect(baseline).toContain("客厅吸顶灯(dev_b): 电源:关");
    expect(baseline).toContain("洗衣机(midea:washer_1): 下筒 178分");

    // Turn 2: only washer metric ticks down and living room light turns on
    const snap2 = snapshotDeviceLiveStates(
      [d1, d2, d3],
      { dev_b: true },
      { "midea:washer_1": "下筒 177分" },
    );
    const delta = buildRuntimeContextBlock({
      localTimeLine: "当前本地时间：2026-11-26 02:19（周四，凌晨）",
      source: "voice",
      voiceMeta: { intent: "status_query" },
      currentStates: snap2,
      previousStates: snap1,
    });
    expect(delta).toContain("实时设备状态更新（未列出设备状态与前文一致）：");
    expect(delta).toContain("客厅吸顶灯(dev_b): 在线，电源:开");
    expect(delta).toContain("洗衣机(midea:washer_1): 在线，下筒 177分");
    expect(delta).not.toContain("门锁(dev_a)");

    // Turn 3: nothing changed
    const unchanged = buildRuntimeContextBlock({
      localTimeLine: "当前本地时间：2026-11-26 02:20（周四，凌晨）",
      source: "text",
      currentStates: snap2,
      previousStates: snap2,
    });
    expect(unchanged).toContain("Channel: text.");
    expect(unchanged).toContain("实时设备状态：较上轮无变化");
  });

  test("computeCacheFriendlyCompaction uses watermark batch eviction aligned strictly to user turn boundaries", () => {
    const sysMsg = { role: "system", content: "STATIC_SYS", timestamp: 0 } as AgentMessage;
    const makeTurn = (idx: number): AgentMessage[] => [
      { role: "user", content: [{ type: "text", text: `turn-${idx}` }], timestamp: idx * 10 },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: `tc_${idx}`, name: "set_device_power", arguments: {} }],
        api: "openai-completions",
        provider: "test",
        model: "m",
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "toolUse",
        timestamp: idx * 10 + 1,
      },
      {
        role: "toolResult",
        toolCallId: `tc_${idx}`,
        toolName: "set_device_power",
        content: [{ type: "text", text: "ok" }],
        isError: false,
        timestamp: idx * 10 + 2,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: `reply-${idx}` }],
        api: "openai-completions",
        provider: "test",
        model: "m",
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
        timestamp: idx * 10 + 3,
      },
    ];

    // maxHistoryTurns = 2 -> softLimit = 8, highWatermark = 16, targetRetained = 4
    // 4 turns = 16 non-system messages -> still <= highWatermark (no eviction, 100% append-only!)
    const fourTurns: AgentMessage[] = [sysMsg, ...makeTurn(1), ...makeTurn(2), ...makeTurn(3), ...makeTurn(4)];
    const r4 = computeCacheFriendlyCompaction(fourTurns, 2);
    expect(r4.compacted).toBe(false);
    expect(r4.droppedCount).toBe(0);

    // 5 turns = 20 non-system messages > highWatermark (16) -> batch eviction aligned to user turn boundary!
    const fiveTurns: AgentMessage[] = [...fourTurns, ...makeTurn(5)];
    const r5 = computeCacheFriendlyCompaction(fiveTurns, 2);
    expect(r5.compacted).toBe(true);
    expect(r5.droppedCount).toBeGreaterThanOrEqual(8);
    expect(r5.messages[0]).toBe(sysMsg);
    expect(r5.messages[1]?.role).toBe("user");
    // Ensure zero orphaned toolResult at start
    expect(r5.messages[1]?.role).not.toBe("toolResult");
    expect(r5.messages[1]?.role).not.toBe("assistant");
  });

  test("recordUsageIntoSummary computes cache hit rates and ignores zero-token local messages", () => {
    const sum = createEmptyUsageSummary();
    expect(recordUsageIntoSummary(sum, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })).toBeNull();
    expect(sum.llmCalls).toBe(0);

    // Call 1: cold write (0 cached, 5000 uncached)
    const r1 = recordUsageIntoSummary(sum, { input: 5000, output: 120, cacheRead: 0, cacheWrite: 0 });
    expect(r1).toBe(0);
    // Call 2: warm hit (4800 cached, 400 new input)
    const r2 = recordUsageIntoSummary(sum, { input: 400, output: 80, cacheRead: 4800, cacheWrite: 0 });
    expect(r2).toBeCloseTo(4800 / 5200, 3);
    expect(sum.llmCalls).toBe(2);
    expect(sum.cacheReadTokens).toBe(4800);
    expect(sum.totalPromptTokens).toBe(10200);
    expect(sum.cacheHitRate).toBeCloseTo(4800 / 10200, 3);
  });
});

describe("PiAgentService End-to-End Prompt KV-Cache Optimization", () => {
  test("keeps messages[0], tools, and full prior history prefix byte-for-byte identical across tool loops and consecutive tasks even as power, metrics, voice/speaker/intent, and UI home change", async () => {
    const capturedRequests: Array<{
      headers: Record<string, string>;
      body: {
        model: string;
        tools?: unknown[];
        messages: Array<{ role: string; content?: unknown; tool_calls?: unknown; tool_call_id?: string }>;
        prompt_cache_key?: string;
      };
      prefixHitRatio: number;
    }> = [];

    // Prefix cache simulator keyed by session affinity header (just like a real gateway / KV cache backend)
    const sessionCachedPrefixes = new Map<string, string>();
    let callIdx = 0;

    const mockServer = Bun.serve({
      port: 0,
      async fetch(req) {
        if (new URL(req.url).pathname.endsWith("/systemone")) {
          return new Response("Not Found", { status: 404 });
        }
        const headers: Record<string, string> = {};
        req.headers.forEach((v, k) => {
          headers[k.toLowerCase()] = v;
        });
        const body = (await req.json()) as {
          model: string;
          tools?: unknown[];
          messages: Array<{ role: string; content?: unknown; tool_calls?: unknown; tool_call_id?: string }>;
          prompt_cache_key?: string;
        };

        const sessKey = headers["x-session-id"] || headers["x-session-affinity"] || "no-session";
        const serializedPrompt = JSON.stringify({ tools: body.tools ?? [], messages: body.messages });
        const prevSerialized = sessionCachedPrefixes.get(sessKey) ?? "";
        const matchedChars = commonPrefixChars(prevSerialized, serializedPrompt);
        const prefixHitRatio = serializedPrompt.length > 0 ? matchedChars / serializedPrompt.length : 0;
        sessionCachedPrefixes.set(sessKey, serializedPrompt);

        capturedRequests.push({ headers, body, prefixHitRatio });
        callIdx += 1;

        const promptTokens = Math.max(100, Math.round(serializedPrompt.length / 4));
        const cachedTokens = Math.round(promptTokens * prefixHitRatio);

        // Task 1 Call 1: tool call -> flips living room light power state mid-task!
        if (callIdx === 1) {
          const sse = [
            `data: ${JSON.stringify({
              id: `chatcmpl-${callIdx}`,
              object: "chat.completion.chunk",
              created: 1700000000,
              model: body.model,
              choices: [
                {
                  index: 0,
                  delta: {
                    role: "assistant",
                    tool_calls: [
                      {
                        index: 0,
                        id: "call_light_on_1",
                        type: "function",
                        function: {
                          name: "set_device_power",
                          arguments: JSON.stringify({ target: "demo-light-living", state: "on" }),
                        },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            })}`,
            `data: ${JSON.stringify({
              id: `chatcmpl-${callIdx}`,
              object: "chat.completion.chunk",
              created: 1700000000,
              model: body.model,
              choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
              usage: {
                prompt_tokens: promptTokens,
                completion_tokens: 24,
                total_tokens: promptTokens + 24,
                prompt_tokens_details: { cached_tokens: cachedTokens },
              },
            })}`,
            "data: [DONE]",
            "",
          ].join("\n\n");
          return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
        }

        // Task 2 Call 3: tool call -> control_light brightness 60
        if (callIdx === 3) {
          const sse = [
            `data: ${JSON.stringify({
              id: `chatcmpl-${callIdx}`,
              object: "chat.completion.chunk",
              created: 1700000000,
              model: body.model,
              choices: [
                {
                  index: 0,
                  delta: {
                    role: "assistant",
                    tool_calls: [
                      {
                        index: 0,
                        id: "call_light_dim_2",
                        type: "function",
                        function: {
                          name: "control_light",
                          arguments: JSON.stringify({ target: "demo-light-living", brightness: 60 }),
                        },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            })}`,
            `data: ${JSON.stringify({
              id: `chatcmpl-${callIdx}`,
              object: "chat.completion.chunk",
              created: 1700000000,
              model: body.model,
              choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
              usage: {
                prompt_tokens: promptTokens,
                completion_tokens: 24,
                total_tokens: promptTokens + 24,
                prompt_tokens_details: { cached_tokens: cachedTokens },
              },
            })}`,
            "data: [DONE]",
            "",
          ].join("\n\n");
          return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
        }

        // All other calls: direct concise text answer
        const sse = [
          `data: ${JSON.stringify({
            id: `chatcmpl-${callIdx}`,
            object: "chat.completion.chunk",
            created: 1700000000,
            model: body.model,
            choices: [{ index: 0, delta: { role: "assistant", content: `已完成第${callIdx}步。` }, finish_reason: null }],
          })}`,
          `data: ${JSON.stringify({
            id: `chatcmpl-${callIdx}`,
            object: "chat.completion.chunk",
            created: 1700000000,
            model: body.model,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: {
              prompt_tokens: promptTokens,
              completion_tokens: 12,
              total_tokens: promptTokens + 12,
              prompt_tokens_details: { cached_tokens: cachedTokens },
            },
          })}`,
          "data: [DONE]",
          "",
        ].join("\n\n");
        return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
      },
    });

    const h = createHarness({
      initialConfig: normalizeAgentVoiceConfig({
        ...defaultAgentVoiceConfig(),
        provider: "openai-compatible",
        customProviderName: "magpie",
        customApiType: "openai-completions",
        modelId: "group/home-assistant",
        baseUrl: `http://127.0.0.1:${mockServer.port}/v1`,
        apiKey: "sk-test-cache-gateway",
        preferLocalIntents: false,
        silentSimpleControlReply: false,
      }),
    });

    try {
      await h.ready();
      // Start with living room light OFF and initial sensor metric
      await h.service.setPowerState("demo-light-living", false);
      h.mainWindow.applyPowerState("demo-light-living", false);
      h.mainWindow.metrics["demo-sensor-ht"] = "23.6°C · 54%";

      // Task 1: voice + owner speaker + device_control intent -> tool flips light power OFF->ON mid-task!
      const r1 = await h.agent.prompt("打开客厅吸顶灯", {
        source: "voice",
        voiceMeta: { speakerName: "Henry", speakerRole: "owner", intent: "device_control" },
      });
      expect(r1.ok).toBe(true);
      expect(r1.usage?.llmCalls).toBe(2);

      // Mutate sensor metric, online state, and UI home tab between Task 1 and Task 2!
      h.mainWindow.metrics["demo-sensor-ht"] = "24.1°C · 52%";
      h.mainWindow.currentHome = "我的家";

      // Task 2: voice + NO speaker + status_query intent -> calls control_light
      const r2 = await h.agent.prompt("把客厅吸顶灯亮度调到60%", {
        source: "voice",
        voiceMeta: { speakerName: null, intent: "status_query" },
      });
      expect(r2.ok).toBe(true);

      // Task 3: switch to text channel + change metric again
      h.mainWindow.metrics["demo-sensor-ht"] = "24.3°C · 51%";
      const r3 = await h.agent.prompt("卧室现在温度多少", { source: "text" });
      expect(r3.ok).toBe(true);

      // Task 4: unchanged device state -> delta says 无变化
      const r4 = await h.agent.prompt("刚才客厅灯开着吗", { source: "text" });
      expect(r4.ok).toBe(true);

      // Expect 6 cloud LLM calls total: Task1(2) + Task2(2) + Task3(1) + Task4(1)
      expect(capturedRequests.length).toBe(6);

      const firstSystem = capturedRequests[0]!.body.messages[0]!;
      const firstToolsJson = JSON.stringify(capturedRequests[0]!.body.tools);
      const sessionId = h.agent.sessionId;
      expect(sessionId).toMatch(/^mijiadeck_[0-9a-f]{16}$/);

      for (let i = 0; i < capturedRequests.length; i += 1) {
        const req = capturedRequests[i]!;
        // 1. Consistent session affinity headers on EVERY request
        expect(req.headers["x-session-id"]).toBe(sessionId);
        expect(req.headers["x-session-affinity"]).toBe(sessionId);
        expect(req.headers["session_id"]).toBe(sessionId);
        expect(req.headers["x-client-request-id"]).toBe(sessionId);
        // 2. Third-party openai-compatible does NOT inject non-standard prompt_cache_key into JSON body
        expect(req.body.prompt_cache_key).toBeUndefined();
        // 3. System prompt & tools are 100% BYTE-FOR-BYTE IDENTICAL across all 6 calls!
        expect(req.body.messages[0]).toEqual(firstSystem);
        expect(JSON.stringify(req.body.tools)).toBe(firstToolsJson);
        // 4. Every subsequent request strictly extends the exact prior message array (100% prefix match!)
        if (i > 0) {
          const prevMsgs = capturedRequests[i - 1]!.body.messages;
          for (let j = 0; j < prevMsgs.length; j += 1) {
            expect(req.body.messages[j]).toEqual(prevMsgs[j]);
          }
          // Every warm call (Call 2..6) achieves > 90% prefix cache hit!
          expect(req.prefixHitRatio).toBeGreaterThan(0.9);
        }
      }

      // Verify Task 1 user message carried full baseline, Task 2 carried delta, Task 4 carried 无变化
      const task1User = extractMsgText(capturedRequests[0]!.body.messages[1]!);
      expect(task1User).toContain("实时设备状态（基准快照）：");
      expect(task1User).toContain("客厅吸顶灯(demo-light-living): 电源:关");
      expect(task1User).toContain("Speaker: Henry (owner).");

      const task2User = extractMsgText(capturedRequests[2]!.body.messages[5]!);
      expect(task2User).toContain("实时设备状态更新（未列出设备状态与前文一致）：");
      expect(task2User).toContain("客厅吸顶灯(demo-light-living): 在线，电源:开");
      expect(task2User).toContain("24.1°C · 52%");
      expect(task2User).toContain("当前界面筛选家庭：我的家");

      const task4User = extractMsgText(capturedRequests[5]!.body.messages[capturedRequests[5]!.body.messages.length - 1]!);
      expect(task4User).toContain("实时设备状态：较上轮无变化");
      expect(task4User).toContain("Channel: text.");

      // Verify UI timeline keeps clean raw user commands (NEVER leaks <runtime_context> to UI!)
      const userTimelineTexts = h.agent
        .snapshot()
        .timeline.filter((e) => e.role === "user")
        .map((e) => e.text);
      expect(userTimelineTexts).toEqual([
        "打开客厅吸顶灯",
        "把客厅吸顶灯亮度调到60%",
        "卧室现在温度多少",
        "刚才客厅灯开着吗",
      ]);

      // Verify session cache telemetry & zero mid-session system prompt refreshes
      const stats = h.agent.snapshot().cacheStats;
      expect(stats.sessionId).toBe(sessionId);
      expect(stats.llmCalls).toBe(6);
      expect(stats.systemPromptRefreshes).toBe(0);
      expect(stats.historyCompactions).toBe(0);
      expect(stats.cacheReadTokens).toBeGreaterThan(0);
      expect(stats.cacheHitRate).toBeGreaterThan(0.75);
      expect(stats.lastCallCacheHitRate).not.toBeNull();
      expect(stats.lastCallCacheHitRate!).toBeGreaterThan(0.9);

      // Verify reset() rotates sessionId and clears cache stats
      h.agent.reset();
      expect(h.agent.sessionId).not.toBe(sessionId);
      expect(h.agent.snapshot().cacheStats.llmCalls).toBe(0);
      expect(h.agent.snapshot().cacheStats.cacheReadTokens).toBe(0);
    } finally {
      mockServer.stop(true);
      await h.cleanup();
    }
  });

  test("watermark batch compaction keeps long continuous sessions append-only between batch drops and re-emits device baseline after compaction", async () => {
    const capturedLengths: number[] = [];
    const capturedFirstNonSystemUsers: string[] = [];
    const capturedLastUsers: string[] = [];

    const faux = fauxProvider({ models: [{ id: "faux-watermark", name: "Faux Watermark" }] });
    // 10 consecutive text tasks (each adds 2 messages: user + assistant -> 20 non-system msgs)
    // With maxHistoryTurns = 2: softLimit = 8, highWatermark = 16, targetRetained = 4
    faux.setResponses(
      Array.from({ length: 12 }, (_, i) => fauxAssistantMessage(`答复${i + 1}`, { stopReason: "stop" })),
    );

    const h = createHarness({
      initialConfig: normalizeAgentVoiceConfig({
        ...defaultAgentVoiceConfig(),
        maxHistoryTurns: 2,
      }),
      customModel: faux.getModel(),
      customStreamFn: (m, ctx, opts) => {
        capturedLengths.push(ctx.messages.length);
        const firstNonSys = ctx.messages[1];
        if (firstNonSys) {
          capturedFirstNonSystemUsers.push(stripRuntimeContextBlock(extractMsgText(firstNonSys)));
        }
        const lastMsg = ctx.messages[ctx.messages.length - 1];
        if (lastMsg) {
          capturedLastUsers.push(extractMsgText(lastMsg));
        }
        return faux.provider.streamSimple(m, ctx, opts);
      },
    });

    try {
      await h.ready();
      for (let i = 1; i <= 11; i += 1) {
        const res = await h.agent.prompt(`连续任务${i}`);
        expect(res.ok).toBe(true);
      }

      // Tasks 1..9 (up to 16 committed non-system msgs BEFORE Task 9 starts -> 17 non-sys during Task 9):
      // NO sliding-window drift on Tasks 1..9! First non-system message stays strictly "连续任务1" for 9 straight tasks!
      for (let idx = 0; idx < 9; idx += 1) {
        expect(capturedFirstNonSystemUsers[idx]).toBe("连续任务1");
      }

      // At Task 10 start, committed body has 18 > highWatermark(16) -> ONE batch compaction drops oldest turns!
      expect(capturedFirstNonSystemUsers[9]).not.toBe("连续任务1");
      expect(capturedFirstNonSystemUsers[9]).toMatch(/^连续任务\d+$/);
      // Task 11 stays strictly append-only on the SAME compacted anchor as Task 10!
      expect(capturedFirstNonSystemUsers[10]).toBe(capturedFirstNonSystemUsers[9]);

      // After compaction, Task 10 automatically re-emitted a full device baseline snapshot!
      expect(capturedLastUsers[9]).toContain("实时设备状态（基准快照）：");
      // Task 11 is back to incremental delta!
      expect(capturedLastUsers[10]).toContain("实时设备状态：较上轮无变化");

      expect(h.agent.snapshot().cacheStats.historyCompactions).toBe(1);
    } finally {
      await h.cleanup();
    }
  });

  test("concurrent scoped tasks share the exact frozen messages[0], committed history prefix, and sessionId", async () => {
    const seenSessionIds: Array<string | undefined> = [];
    const seenSystems: string[] = [];

    let releaseFirstCall!: () => void;
    const firstCallStarted = new Promise<void>((resolve) => {
      releaseFirstCall = resolve;
    });
    let unblockFirstCall!: () => void;
    const holdFirstCall = new Promise<void>((resolve) => {
      unblockFirstCall = resolve;
    });

    const faux = fauxProvider({ models: [{ id: "faux-concurrent", name: "Faux Concurrent" }] });
    faux.setResponses([
      fauxAssistantMessage("基线回复", { stopReason: "stop" }),
      fauxAssistantMessage("并发任务1回复", { stopReason: "stop" }),
      fauxAssistantMessage("并发任务2回复", { stopReason: "stop" }),
    ]);

    let callCount = 0;
    const h = createHarness({
      customModel: faux.getModel(),
      customStreamFn: async (m, ctx, opts) => {
        callCount += 1;
        seenSessionIds.push(opts?.sessionId);
        const sys = ctx.messages[0];
        seenSystems.push(sys && typeof sys.content === "string" ? sys.content : "");
        if (callCount === 2) {
          releaseFirstCall();
          await holdFirstCall;
        }
        return faux.provider.streamSimple(m, ctx, opts);
      },
    });

    try {
      await h.ready();
      // Turn 0 commits baseline history
      await h.agent.prompt("你好");

      // Submit Task 1 (primary, held in flight) and Task 2 (concurrent scoped agent)
      const sub1 = h.agent.submitPrompt("查询客厅状态");
      await firstCallStarted;
      const sub2 = h.agent.submitPrompt("查询卧室状态");
      await Bun.sleep(25);
      unblockFirstCall();

      const [res1, res2] = await Promise.all([sub1.promise, sub2.promise]);
      expect(res1.ok).toBe(true);
      expect(res2.ok).toBe(true);

      // All 3 calls (baseline, primary task 1, concurrent scoped task 2) shared exact same sessionId & messages[0]!
      expect(seenSessionIds.length).toBe(3);
      expect(new Set(seenSessionIds).size).toBe(1);
      expect(seenSessionIds[0]).toBe(h.agent.sessionId);
      expect(seenSystems[1]).toBe(seenSystems[0]);
      expect(seenSystems[2]).toBe(seenSystems[0]);
    } finally {
      await h.cleanup();
    }
  });

  test("saving a custom instruction freezes messages[0] within the saving turn and refreshes only at the start of the next task with static prefix intact", async () => {
    const seenSystems: string[] = [];
    const faux = fauxProvider({ models: [{ id: "faux-rule-save", name: "Faux Rule Save" }] });
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("save_custom_instruction", {
            content: "以后卧室灯默认调到35%暖光",
            topic: "灯光",
          }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("已记住卧室灯默认规则。", { stopReason: "stop" }),
      fauxAssistantMessage("好的。", { stopReason: "stop" }),
    ]);

    const h = createHarness({
      customModel: faux.getModel(),
      customStreamFn: (m, ctx, opts) => {
        const sys = ctx.messages[0];
        seenSystems.push(sys && typeof sys.content === "string" ? sys.content : "");
        return faux.provider.streamSimple(m, ctx, opts);
      },
    });

    try {
      await h.ready();
      await h.agent.prompt("以后卧室灯默认调到35%暖光", { source: "voice" });
      await h.agent.prompt("打开卧室灯", { source: "voice" });

      expect(seenSystems.length).toBe(3);
      // Call 1 and Call 2 of the saving turn MUST keep byte-identical messages[0] (zero mid-turn cache bust!)
      expect(seenSystems[1]).toBe(seenSystems[0]);
      // Next task sees the saved custom instruction appended at the tail of messages[0]
      expect(seenSystems[2]).toContain("以后卧室灯默认调到35%暖光");
      // The entire static core + catalog prefix before the new custom instructions stays 100% identical!
      expect(seenSystems[2]!.startsWith(seenSystems[0]!)).toBe(true);
    } finally {
      await h.cleanup();
    }
  });

  test("buildModelForConfig enables session affinity compat on openai-completions and proxy anthropic-messages", () => {
    const base = defaultAgentVoiceConfig();
    const customCompat = buildModelForConfig({
      ...base,
      provider: "openai-compatible",
      customProviderName: "magpie",
      customApiType: "openai-completions",
      baseUrl: "https://magpie.example.test/v1",
      modelId: "group/home-assistant",
    });
    expect((customCompat.compat as Record<string, unknown> | undefined)?.sendSessionAffinityHeaders).toBe(true);

    const proxyAnthropic = buildModelForConfig({
      ...base,
      provider: "openai-compatible",
      customProviderName: "claude-proxy",
      customApiType: "anthropic-messages",
      baseUrl: "https://proxy.example.test",
      modelId: "claude-sonnet-4-5",
    });
    expect((proxyAnthropic.compat as Record<string, unknown> | undefined)?.sendSessionAffinityHeaders).toBe(true);

    const officialOpenAi = buildModelForConfig({
      ...base,
      provider: "openai",
      modelId: "gpt-4o-mini",
    });
    expect(officialOpenAi.api).toBe("openai-responses");
  });
});
