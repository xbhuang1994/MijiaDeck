// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: AI 思考等级配置、对话框思考过程展示与语音静默（不播报）回归测试

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
  type AssistantMessage,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { sanitizeForVoiceTts } from "../src/agent/cavemanReplyPolicy.ts";
import {
  buildModelForConfig,
  InlineThinkStreamSplitter,
  PiAgentService,
  splitInlineThinkBlocks,
} from "../src/agent/piAgentService.ts";
import { VoiceListenerController } from "../src/agent/voiceListenerController.ts";
import {
  defaultAgentVoiceConfig,
  loadAgentVoiceConfig,
  normalizeAgentVoiceConfig,
  normalizeThinkingLevel,
  toPublicAgentVoiceConfig,
  updateAgentVoiceConfig,
  VALID_THINKING_LEVELS,
} from "../src/core/agentConfigStore.ts";
import { NetworkMonitor } from "../src/core/availability.ts";
import { JobExecutor } from "../src/core/jobs.ts";
import { setDataPathOverrides } from "../src/core/jsonStore.ts";
import * as settingsStore from "../src/core/settingsStore.ts";
import { VirtualDemoService } from "../src/core/virtualLightService.ts";
import { startMijiaDeckServer } from "../src/server/server.ts";
import { MainWindowController } from "../src/ui/controllers/mainWindowController.ts";
import { applyTheme, ThemeController } from "../src/ui/theme.ts";

let tmpDir = "";

function createTestHarness(
  options: {
    initialConfig?: ReturnType<typeof defaultAgentVoiceConfig>;
    customStreamFn?: ConstructorParameters<typeof PiAgentService>[0]["customStreamFn"];
    customModel?: ConstructorParameters<typeof PiAgentService>[0]["customModel"];
  } = {},
) {
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
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "mijiadeck-thinking-"));
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

describe("ThinkingLevel Config Persistence & Model Building", () => {
  test("defaults thinkingLevel to 'off', persists all levels & aliases, and rejects invalid values", () => {
    const def = defaultAgentVoiceConfig();
    expect(def.thinkingLevel).toBe("off");
    expect(loadAgentVoiceConfig().thinkingLevel).toBe("off");
    expect(normalizeAgentVoiceConfig({}).thinkingLevel).toBe("off");

    expect(normalizeThinkingLevel("none")).toBe("off");
    expect(normalizeThinkingLevel("disabled")).toBe("off");
    expect(normalizeThinkingLevel("min")).toBe("minimal");
    expect(normalizeThinkingLevel("med")).toBe("medium");
    expect(normalizeThinkingLevel("extra-high")).toBe("xhigh");
    expect(normalizeThinkingLevel("maximum")).toBe("max");
    expect(normalizeThinkingLevel("nonsense", "low")).toBe("low");

    for (const level of VALID_THINKING_LEVELS) {
      const updated = updateAgentVoiceConfig({ thinkingLevel: level });
      expect(updated.thinkingLevel).toBe(level);
      expect(loadAgentVoiceConfig().thinkingLevel).toBe(level);
      expect(toPublicAgentVoiceConfig(updated).thinkingLevel).toBe(level);
    }

    expect(() => updateAgentVoiceConfig({ thinkingLevel: "super-ultra" })).toThrow(/思考等级/);
  });

  test("buildModelForConfig enables reasoning & thinking headroom appropriately across providers", () => {
    const base = defaultAgentVoiceConfig();

    // Local planner never turns on cloud reasoning
    const localModel = buildModelForConfig({ ...base, provider: "local", thinkingLevel: "high" });
    expect(localModel.reasoning).toBe(false);

    // Custom / non-catalog model toggles reasoning based on thinkingLevel
    const dsOff = buildModelForConfig({
      ...base,
      provider: "deepseek",
      modelId: "deepseek-reasoner",
      thinkingLevel: "off",
    });
    expect(dsOff.reasoning).toBe(false);

    const dsHigh = buildModelForConfig({
      ...base,
      provider: "deepseek",
      modelId: "deepseek-reasoner",
      thinkingLevel: "high",
    });
    expect(dsHigh.reasoning).toBe(true);
    expect(dsHigh.maxTokens).toBeGreaterThanOrEqual(32_768);

    // Known official non-reasoning model stays reasoning=false so official OpenAI doesn't 400
    const gpt4oMini = buildModelForConfig({
      ...base,
      provider: "openai",
      modelId: "gpt-4o-mini",
      thinkingLevel: "medium",
    });
    expect(gpt4oMini.reasoning).toBe(false);

    // Known catalog reasoning models preserve thinkingLevelMap & compat
    const claudeOpus47 = buildModelForConfig({
      ...base,
      provider: "anthropic",
      modelId: "claude-opus-4-7",
      thinkingLevel: "xhigh",
    });
    expect(claudeOpus47.reasoning).toBe(true);
    expect(claudeOpus47.thinkingLevelMap?.xhigh).toBe("xhigh");
    expect((claudeOpus47.compat as Record<string, unknown> | undefined)?.forceAdaptiveThinking).toBe(
      true,
    );

    const gpt54 = buildModelForConfig({
      ...base,
      provider: "openai",
      modelId: "gpt-5.4",
      thinkingLevel: "xhigh",
    });
    expect(gpt54.reasoning).toBe(true);
    expect(gpt54.thinkingLevelMap?.xhigh).toBe("xhigh");
    expect(gpt54.thinkingLevelMap?.off).toBe("none");

    // Third-party proxy strips Anthropic-only experimental beta flags
    const proxyClaude = buildModelForConfig({
      ...base,
      provider: "openai-compatible",
      customApiType: "anthropic-messages",
      baseUrl: "https://proxy.example.com",
      modelId: "claude-opus-5",
      thinkingLevel: "high",
    });
    expect(proxyClaude.reasoning).toBe(true);
    const proxyCompat = (proxyClaude.compat ?? {}) as Record<string, unknown>;
    expect(proxyCompat.supportsMidConvoEffort).toBeUndefined();
    expect(proxyCompat.supportsMidConvoToolChanges).toBeUndefined();
  });
});

describe("Inline <think> Stream Splitter & Voice TTS Guard", () => {
  test("splits <think>...</think> across arbitrary chunk boundaries without losing normal '<' text", () => {
    const splitter = new InlineThinkStreamSplitter();
    const chunks = ["<th", "ink>步骤1：检查客厅灯。", "步骤2：调亮度。", "</th", "ink>\n", "温度 <", " 20°C，已打开客厅灯。"];
    let thinking = "";
    let text = "";
    for (const c of chunks) {
      const out = splitter.push(c);
      thinking += out.thinking;
      text += out.text;
    }
    const tail = splitter.flush();
    thinking += tail.thinking;
    text += tail.text;

    expect(thinking).toBe("步骤1：检查客厅灯。步骤2：调亮度。");
    expect(text.trim()).toBe("温度 < 20°C，已打开客厅灯。");
  });

  test("handles multiple think blocks and unclosed trailing think without leaking into text", () => {
    const multi = splitInlineThinkBlocks("<think>第一段</think>正文A<think>第二段</think>正文B");
    expect(multi.thinking).toBe("第一段\n\n第二段");
    expect(multi.text).toBe("正文A正文B");

    const unclosed = splitInlineThinkBlocks("<think>仍在思考中还没有闭合");
    expect(unclosed.thinking).toBe("仍在思考中还没有闭合");
    expect(unclosed.text).toBe("");

    expect(sanitizeForVoiceTts("<think>不要念这段思考！</think>客厅灯已开。")).toBe("客厅灯已开。");
  });
});

describe("PiAgentService Thinking Stream Display & Strict No-Speak Isolation", () => {
  test("passes configured thinkingLevel to LLM stream, shows multi-turn thinking in timeline, and NEVER speaks thinking", async () => {
    const observedReasoning: Array<SimpleStreamOptions["reasoning"]> = [];
    const faux = fauxProvider({
      models: [
        {
          id: "faux-reasoner",
          name: "Faux Reasoner",
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128_000,
          maxTokens: 16_384,
        },
      ],
      tokensPerSecond: 0,
    });
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxThinking("内部思考第一步：需要把客厅吸顶灯亮度调整到 75%。"),
          fauxToolCall("control_light", { target: "客厅吸顶灯", on: true, brightness: 75 }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage([
        fauxThinking("内部思考第二步：控制工具执行成功，现在简短回复用户。"),
        fauxText("客厅吸顶灯亮度已调到 75%。"),
      ]),
    ]);

    const initialConfig = {
      ...defaultAgentVoiceConfig(),
      provider: "deepseek" as const,
      modelId: "deepseek-reasoner",
      thinkingLevel: "high" as const,
      autoSpeakReply: true,
      preferLocalIntents: false,
      cavemanMode: "lite" as const,
      silentSimpleControlReply: false,
    };

    const h = createTestHarness({
      initialConfig,
      customModel: faux.getModel(),
      customStreamFn: (model, context, options) => {
        observedReasoning.push(options?.reasoning);
        return faux.provider.streamSimple(model, context, options);
      },
    });
    const voiceCtrl = new VoiceListenerController(h.agent);

    try {
      await h.ready();
      expect(h.agent.agent.state.thinkingLevel).toBe("high");

      const streamEvents: Array<Record<string, unknown>> = [];
      const spokenChunks: string[] = [];
      const voiceSpokenAll: string[] = [];
      h.agent.on("streamEvent", (ev) => streamEvents.push(ev));
      h.agent.on("speakChunk", ({ text }) => spokenChunks.push(text));
      voiceCtrl.on("speakChunkRequested", ({ text }) => voiceSpokenAll.push(text));
      voiceCtrl.on("speakRequested", (text) => voiceSpokenAll.push(text));

      const res = await h.agent.prompt("把客厅吸顶灯亮度调到 75%", { source: "voice" });
      expect(res.ok).toBe(true);
      expect(observedReasoning).toEqual(["high", "high"]);

      // Thinking appears in result, timeline snapshot, and stream events
      expect(res.thinkingLevel).toBe("high");
      expect(res.thinking).toContain("内部思考第一步");
      expect(res.thinking).toContain("内部思考第二步");
      expect(res.reply).toContain("75%");
      expect(res.reply).not.toContain("内部思考");

      const snap = h.agent.snapshot();
      const assistantEntry = snap.timeline.find((e) => e.id === res.entryId);
      expect(assistantEntry?.thinking).toContain("内部思考第一步");
      expect(assistantEntry?.thinking).toContain("内部思考第二步");
      expect(assistantEntry?.thinkingActive).toBe(false);
      expect(assistantEntry?.thinkingLevel).toBe("high");

      const thinkingDeltas = streamEvents.filter((e) => e.kind === "thinking_delta");
      expect(thinkingDeltas.length).toBeGreaterThan(0);

      // CRITICAL: Thinking is NEVER spoken in any TTS channel
      const joinedSpoken = [...spokenChunks, ...voiceSpokenAll].join(" ");
      expect(joinedSpoken).toContain("75%");
      expect(joinedSpoken).not.toContain("内部思考");
      expect(joinedSpoken).not.toContain("第一步");
      expect(joinedSpoken).not.toContain("第二步");

      // Reconfiguring to 'off' passes undefined reasoning on subsequent calls
      h.agent.reconfigure({ ...initialConfig, thinkingLevel: "off" });
      expect(h.agent.agent.state.thinkingLevel).toBe("off");
      faux.setResponses([fauxAssistantMessage("好的，没问题。")]);
      await h.agent.prompt("你好", { source: "text" });
      expect(observedReasoning[2]).toBeUndefined();
    } finally {
      voiceCtrl.dispose();
      await h.cleanup();
    }
  });

  test("extracts inline <think>...</think> from text_delta into dialog thinking block and NEVER speaks it in voice mode", async () => {
    const inlineStreamFn: NonNullable<ConstructorParameters<typeof PiAgentService>[0]["customStreamFn"]> = (
      model,
    ) => {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const partial: AssistantMessage = {
          role: "assistant",
          content: [{ type: "text", text: "" }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "pending",
          timestamp: Date.now(),
        };
        stream.push({ type: "start", partial });
        stream.push({ type: "text_start", contentIndex: 0, partial });
        const deltas = [
          "<thi",
          "nk>悄悄分析一下。不要把这句话播报出来！",
          "</thi",
          "nk>\n今天室内环境很舒适。",
        ];
        for (const d of deltas) {
          (partial.content[0] as { type: "text"; text: string }).text += d;
          stream.push({ type: "text_delta", contentIndex: 0, delta: d, partial });
        }
        stream.push({
          type: "text_end",
          contentIndex: 0,
          content: (partial.content[0] as { type: "text"; text: string }).text,
          partial,
        });
        const finalMsg: AssistantMessage = { ...partial, stopReason: "stop" };
        stream.push({ type: "done", reason: "stop", message: finalMsg });
        stream.end(finalMsg);
      });
      return stream;
    };

    const h = createTestHarness({
      initialConfig: {
        ...defaultAgentVoiceConfig(),
        provider: "openai-compatible",
        modelId: "qwen3-32b",
        thinkingLevel: "medium",
        autoSpeakReply: true,
        preferLocalIntents: false,
      },
      customStreamFn: inlineStreamFn,
    });

    try {
      await h.ready();
      const spokenChunks: string[] = [];
      const thinkingEvents: Array<Record<string, unknown>> = [];
      h.agent.on("speakChunk", ({ text }) => spokenChunks.push(text));
      h.agent.on("streamEvent", (ev) => {
        if (ev.kind === "thinking_delta") thinkingEvents.push(ev);
      });

      const res = await h.agent.prompt("现在家里怎么样？", { source: "voice" });
      expect(res.ok).toBe(true);
      expect(res.thinking).toBe("悄悄分析一下。不要把这句话播报出来！");
      expect(res.reply).toBe("今天室内环境很舒适。");
      expect(res.reply).not.toContain("<think>");
      expect(thinkingEvents.length).toBeGreaterThan(0);

      const allSpoken = spokenChunks.join(" ");
      expect(allSpoken).toContain("今天室内环境很舒适");
      expect(allSpoken).not.toContain("悄悄分析");
      expect(allSpoken).not.toContain("不要把这句话");
    } finally {
      await h.cleanup();
    }
  });
});

describe("Server API & UI Controls for Thinking Level", () => {
  test("exposes thinkingLevel via /api/agent/config, returns thinking from /api/agent/prompt, and renders UI controls", async () => {
    const faux = fauxProvider({
      models: [{ id: "faux-api-reasoner", name: "Faux API Reasoner", reasoning: true }],
      tokensPerSecond: 0,
    });
    faux.setResponses([
      fauxAssistantMessage([
        fauxThinking("通过 API 校验思考过程字段返回。"),
        fauxText("接口验证完成。"),
      ]),
    ]);

    const srv = await startMijiaDeckServer({
      mode: "demo",
      port: 0,
      autoStartTimers: false,
      agentModel: faux.getModel(),
      agentStreamFn: (m, ctx, opts) => faux.provider.streamSimple(m, ctx, opts),
    });

    try {
      // 1. Default config returns thinkingLevel: "off"
      const cfg1 = await fetch(`${srv.url}/api/agent/config`);
      expect(cfg1.status).toBe(200);
      const data1 = (await cfg1.json()) as { config: { thinkingLevel: string } };
      expect(data1.config.thinkingLevel).toBe("off");

      // 2. Updating thinkingLevel via POST persists & updates live Agent state
      const cfg2 = await fetch(`${srv.url}/api/agent/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ thinkingLevel: "medium" }),
      });
      expect(cfg2.status).toBe(200);
      const data2 = (await cfg2.json()) as { config: { thinkingLevel: string } };
      expect(data2.config.thinkingLevel).toBe("medium");
      expect(srv.runtime.piAgent?.config.thinkingLevel).toBe("medium");
      expect(srv.runtime.piAgent?.agent.state.thinkingLevel).toBe("medium");

      // 3. Invalid thinkingLevel returns 400
      const cfgBad = await fetch(`${srv.url}/api/agent/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ thinkingLevel: "invalid-level" }),
      });
      expect(cfgBad.status).toBe(400);

      // 4. Prompt response includes thinking & timeline thinking entry
      const promptRes = await fetch(`${srv.url}/api/agent/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "检查一下", source: "text" }),
      });
      expect(promptRes.status).toBe(200);
      const promptData = (await promptRes.json()) as {
        ok: boolean;
        reply: string;
        thinking?: string;
        thinkingLevel?: string;
        agent: { timeline: Array<{ role: string; thinking?: string }> };
      };
      expect(promptData.ok).toBe(true);
      expect(promptData.thinking).toBe("通过 API 校验思考过程字段返回。");
      expect(promptData.thinkingLevel).toBe("medium");
      expect(promptData.reply).toBe("接口验证完成。");
      const lastEntry = promptData.agent.timeline[promptData.agent.timeline.length - 1];
      expect(lastEntry?.thinking).toBe("通过 API 校验思考过程字段返回。");

      // 5. HTML page includes both drawer and settings thinking level controls
      const html = await (await fetch(`${srv.url}/`)).text();
      expect(html).toContain('id="pi-thinking-level-select"');
      expect(html).toContain('id="set-agent-thinking-level"');
    } finally {
      await srv.stop();
    }
  });
});
