// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 内置 Pi Agent 与智能家居工具集回归测试

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
  defaultAgentVoiceConfig,
  loadAgentVoiceConfig,
  toPublicAgentVoiceConfig,
  updateAgentVoiceConfig,
} from "../src/core/agentConfigStore.ts";
import { setDataPathOverrides } from "../src/core/jsonStore.ts";
import { NetworkMonitor } from "../src/core/availability.ts";
import { JobExecutor } from "../src/core/jobs.ts";
import * as settingsStore from "../src/core/settingsStore.ts";
import { VirtualDemoService } from "../src/core/virtualLightService.ts";
import { MainWindowController } from "../src/ui/controllers/mainWindowController.ts";
import { ThemeController, applyTheme } from "../src/ui/theme.ts";

let tmpDir = "";

function createTestHarness(options: {
  customStreamFn?: ConstructorParameters<typeof PiAgentService>[0]["customStreamFn"];
  customModel?: ConstructorParameters<typeof PiAgentService>[0]["customModel"];
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

  let broadcasts = 0;
  const agent = new PiAgentService({
    deps: {
      service,
      jobs,
      mainWindow,
      settingsStore,
      broadcastState: () => {
        broadcasts += 1;
      },
    },
    ...(options.customStreamFn ? { customStreamFn: options.customStreamFn } : {}),
    ...(options.customModel ? { customModel: options.customModel } : {}),
  });

  return {
    service,
    jobs,
    mainWindow,
    agent,
    getBroadcasts: () => broadcasts,
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
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "mijiadeck-pi-agent-"));
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

describe("AgentConfigStore", () => {
  test("persists config, masks API keys, preserves key on partial update, and clears on explicit flag", () => {
    const initial = loadAgentVoiceConfig();
    expect(initial.provider).toBe("local");
    expect(initial.wakeWordEnabled).toBe(true);
    expect(initial.wakeWords.length).toBeGreaterThan(0);

    const updated = updateAgentVoiceConfig({
      provider: "deepseek",
      apiKey: "sk-secret-deepseek-9876543210",
      sttBaseUrl: "https://api.siliconflow.cn/v1/",
      sttApiKey: "sk-stt-secret-abcdef1234",
      wakeWords: "小派, 派派, pi",
      wakeWindowSec: 15,
    });
    expect(updated.provider).toBe("deepseek");
    expect(updated.modelId).toBe("deepseek-chat");
    expect(updated.sttBaseUrl).toBe("https://api.siliconflow.cn/v1");
    expect(updated.wakeWords).toEqual(["小派", "派派", "pi"]);
    expect(updated.wakeWindowSec).toBe(15);

    const pub = toPublicAgentVoiceConfig(updated);
    expect(pub.hasApiKey).toBe(true);
    expect(pub.apiKeyPreview).not.toContain("9876543210");
    expect(pub.apiKeyPreview).toContain("••••");
    expect(pub.hasSttApiKey).toBe(true);
    expect(pub.effectiveSttConfigured).toBe(true);
    expect(JSON.stringify(pub)).not.toContain("sk-secret-deepseek-9876543210");
    expect(JSON.stringify(pub)).not.toContain("sk-stt-secret-abcdef1234");

    // Partial update without apiKey keeps stored secret
    const kept = updateAgentVoiceConfig({ wakeWindowSec: 12 });
    expect(kept.apiKey).toBe("sk-secret-deepseek-9876543210");
    expect(kept.wakeWindowSec).toBe(12);

    // Explicit clear removes secret
    const cleared = updateAgentVoiceConfig({ clearApiKey: true, clearSttApiKey: true });
    expect(cleared.apiKey).toBe("");
    expect(cleared.sttApiKey).toBe("");
    expect(toPublicAgentVoiceConfig(cleared).hasApiKey).toBe(false);
  });

  test("rejects invalid provider and malformed URLs", () => {
    expect(() => updateAgentVoiceConfig({ provider: "unknown-vendor" })).toThrow();
    expect(() => updateAgentVoiceConfig({ baseUrl: "ftp://invalid.example.com" })).toThrow();
    expect(() => updateAgentVoiceConfig({ sttBaseUrl: "not-a-url" })).toThrow();
  });
});

describe("PiAgentService with Local Smart-Home Stream Engine", () => {
  test("executes compound multi-tool command: dims living room light and turns off dining light", async () => {
    const h = createTestHarness();
    try {
      await h.ready();
      expect(await h.service.readProp("demo-light-living", "brightness")).toBe(72);
      expect(await h.service.powerState("demo-switch-bar.s2")).toBe(true);

      const res = await h.agent.prompt("把客厅吸顶灯亮度调到85%，并关闭餐厅主灯", { source: "voice" });
      expect(res.ok).toBe(true);
      expect(res.toolCalls.length).toBe(2);
      expect(res.toolCalls[0]!.name).toBe("control_light");
      expect(res.toolCalls[1]!.name).toBe("set_device_power");

      expect(await h.service.readProp("demo-light-living", "brightness")).toBe(85);
      expect(await h.service.powerState("demo-switch-bar.s2")).toBe(false);
      expect(h.mainWindow.knownPower["demo-switch-bar.s2"]).toBe(false);
      expect(h.getBroadcasts()).toBeGreaterThan(0);
    } finally {
      await h.cleanup();
    }
  });

  test("controls light color temperature, color, speaker volume, pet feeder, scenes, sensors and pronoun follow-up", async () => {
    const h = createTestHarness();
    try {
      await h.ready();

      // 1. Light warm temperature + color
      const rLight = await h.agent.prompt("把客厅吸顶灯调成暖光，颜色调成蓝色");
      expect(rLight.ok).toBe(true);
      const temp = (await h.service.readProp("demo-light-living", "color-temperature")) as number;
      expect(temp).toBeLessThan(3500);
      expect(await h.service.readProp("demo-light-living", "color")).toBe(0x007aff);

      // 2. Pronoun follow-up ("把它关了") targets most recently controlled device
      const rPronoun = await h.agent.prompt("把它关了");
      expect(rPronoun.ok).toBe(true);
      expect(await h.service.powerState("demo-light-living")).toBe(false);

      // 3. Sensor query reads bedroom temp/humidity
      const rSensor = await h.agent.prompt("卧室现在温度和湿度多少？");
      expect(rSensor.ok).toBe(true);
      expect(rSensor.reply).toContain("23.6");
      expect(rSensor.reply).toContain("54");

      // 4. Pet feeder dispense 2 portions
      const rFeed = await h.agent.prompt("给宠物喂食器出粮2份");
      expect(rFeed.ok).toBe(true);
      expect(h.service.lastDispensedPortions).toBe(2);

      // 5. Speaker volume & XiaoAI directive
      const rVol = await h.agent.prompt("小爱音箱音量调到65");
      expect(rVol.ok).toBe(true);
      expect(await h.service.readProp("demo-speaker-xiaoai", "volume")).toBe(65);

      const rXiaoAi = await h.agent.prompt("让小爱播放轻音乐");
      expect(rXiaoAi.ok).toBe(true);
      expect(h.service.lastDirective).toBe("播放轻音乐");

      // 6. Room batch off
      await h.service.setPowerState("demo-switch-bar.s2", true);
      await h.service.setPowerState("demo-switch-bar.s3", true);
      await h.service.setPowerState("demo-switch-bar.s4", true);
      const rBatch = await h.agent.prompt("关闭餐厅所有灯");
      expect(rBatch.ok).toBe(true);
      expect(await h.service.powerState("demo-switch-bar.s2")).toBe(false);
      expect(await h.service.powerState("demo-switch-bar.s3")).toBe(false);
      expect(await h.service.powerState("demo-switch-bar.s4")).toBe(false);

      // 7. Manual scene execution ("回家模式" turns lights back on)
      const rScene = await h.agent.prompt("执行回家模式");
      expect(rScene.ok).toBe(true);
      expect(await h.service.powerState("demo-light-living")).toBe(true);
    } finally {
      await h.cleanup();
    }
  });

  test("supports full LLM tool-calling loop via @earendil-works/pi-ai fauxProvider and reset()", async () => {
    const faux = fauxProvider({
      models: [{ id: "faux-smart-home-1", name: "Faux Smart Home LLM" }],
    });
    const model = faux.getModel();

    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("control_light", { target: "客厅吸顶灯", brightness: 42, on: true }),
          fauxToolCall("set_device_property", { target: "小爱音箱 Pro", property: "volume", value: 30 }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("已为你把客厅吸顶灯调暗到 42%，并将小爱音箱音量调低到 30%。", {
        stopReason: "stop",
      }),
    ]);

    const h = createTestHarness({
      customModel: model,
      customStreamFn: (m, ctx, opts) => faux.provider.streamSimple(m, ctx, opts),
    });

    try {
      await h.ready();
      const events: string[] = [];
      h.agent.on("streamEvent", (ev) => events.push(String(ev.kind)));

      const res = await h.agent.prompt("准备看电影了，灯光暗一点，音箱声音小一点");
      expect(res.ok).toBe(true);
      expect(res.toolCalls.map((t) => t.name)).toEqual(["control_light", "set_device_property"]);
      expect(res.reply).toContain("42%");
      expect(await h.service.readProp("demo-light-living", "brightness")).toBe(42);
      expect(await h.service.readProp("demo-speaker-xiaoai", "volume")).toBe(30);
      expect(events).toContain("tool_start");
      expect(events).toContain("tool_end");
      expect(h.agent.snapshot().timeline.length).toBe(2);

      h.agent.reset();
      expect(h.agent.snapshot().timeline.length).toBe(0);
    } finally {
      await h.cleanup();
    }
  });

  test("returns clear guidance without leaking secrets when cloud provider lacks API key", async () => {
    const prevKey = process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    const h = createTestHarness();
    try {
      await h.ready();
      h.agent.reconfigure({
        ...defaultAgentVoiceConfig(),
        provider: "deepseek",
        modelId: "deepseek-chat",
        apiKey: "",
      });
      const res = await h.agent.prompt("打开客厅灯");
      expect(res.ok).toBe(false);
      expect(res.reply).toContain("API Key");
      expect(res.reply).toContain("内置本地引擎");
    } finally {
      if (prevKey !== undefined) process.env.DEEPSEEK_API_KEY = prevKey;
      await h.cleanup();
    }
  });
});
