// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 内置 Pi Agent 与智能家居工具集回归测试

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { fetchProviderModels } from "../src/agent/modelDiscovery.ts";
import { PiAgentService } from "../src/agent/piAgentService.ts";
import { evaluateVoiceAttention } from "../src/agent/voiceAttentionGate.ts";
import {
  defaultAgentVoiceConfig,
  loadAgentVoiceConfig,
  toPublicAgentVoiceConfig,
  updateAgentVoiceConfig,
} from "../src/core/agentConfigStore.ts";
import { setDataPathOverrides } from "../src/core/jsonStore.ts";
import { NetworkMonitor } from "../src/core/availability.ts";
import { JobExecutor } from "../src/core/jobs.ts";
import { MijiaService } from "../src/core/service.ts";
import * as settingsStore from "../src/core/settingsStore.ts";
import { VirtualDemoService } from "../src/core/virtualLightService.ts";
import type { FlattenedSpec, MijiaApiClient } from "../src/mijia/index.ts";
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

      // 5. Speaker control: volume, relative volume, music playback, and soft power off/on
      const rVol = await h.agent.prompt("小爱音箱音量调到65");
      expect(rVol.ok).toBe(true);
      expect(await h.service.readProp("demo-speaker-xiaoai", "volume")).toBe(65);

      const rVolUp = await h.agent.prompt("把小米音响声音调大一点");
      expect(rVolUp.ok).toBe(true);
      expect(await h.service.readProp("demo-speaker-xiaoai", "volume")).toBe(80);

      const rMusic = await h.agent.prompt("用小米音响播放周杰伦的晴天");
      expect(rMusic.ok).toBe(true);
      expect(h.service.lastDirective).toBe("播放周杰伦的晴天");

      const rSpkOff = await h.agent.prompt("关闭小米音响");
      expect(rSpkOff.ok).toBe(true);
      expect(await h.service.readProp("demo-speaker-xiaoai", "mute")).toBe(true);

      const rSpkOn = await h.agent.prompt("打开小米音响");
      expect(rSpkOn.ok).toBe(true);
      expect(await h.service.readProp("demo-speaker-xiaoai", "mute")).toBe(false);

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

  test("routes '停止播放音乐' and stop/pause/play/track variations without misexecuting as resume play", async () => {
    const h = createTestHarness();
    try {
      await h.ready();

      const stopPhrases = [
        "停止播放音乐",
        "请停止播放音乐",
        "停止播放音乐吧",
        "让小爱音箱停止播放音乐",
        "停止播放",
        "停止音乐",
        "停止放歌",
        "停止播放周杰伦的晴天",
        "结束播放",
        "把音乐停了",
        "把音乐关掉",
        "关闭音乐",
        "关掉音乐",
        "不要播放音乐",
        "不要再播放音乐",
        "别再播放音乐",
        "别让小爱音箱播放音乐",
        "不要让音箱放歌了",
        "别放歌了",
        "别播了",
        "不要再放这首歌了",
        "停止",
        "停一下",
        "stop",
        "stop playing music",
        "turn off the music",
      ];

      for (const phrase of stopPhrases) {
        await h.service.runAction("demo-speaker-xiaoai", "play");
        expect(await h.service.readProp("demo-speaker-xiaoai", "playing-state")).toBe(1);

        const res = await h.agent.prompt(phrase, { source: "voice" });
        expect(res.ok).toBe(true);
        expect(res.toolCalls.length).toBe(1);
        expect(res.toolCalls[0]?.name).toBe("control_speaker");
        expect(res.toolCalls[0]?.args.playback).toBe("stop");
        expect(res.toolCalls[0]?.args.play_music).toBeUndefined();
        expect(res.reply).not.toContain("继续播放");
        expect(res.reply).toMatch(/已经?停止/);
        // VirtualDemoService speaker only exposes pause (no stop action), so stop falls back to pause
        expect(await h.service.readProp("demo-speaker-xiaoai", "playing-state")).toBe(2);
      }

      // Pause variations
      for (const phrase of [
        "暂停播放音乐",
        "暂停播放音乐吧",
        "暂停播放周杰伦",
        "暂停",
        "暂停一下",
        "把音乐暂停",
        "pause",
        "pause music",
      ]) {
        await h.service.runAction("demo-speaker-xiaoai", "play");
        const res = await h.agent.prompt(phrase, { source: "voice" });
        expect(res.ok).toBe(true);
        expect(res.toolCalls[0]?.name).toBe("control_speaker");
        expect(res.toolCalls[0]?.args.playback).toBe("pause");
        expect(res.reply).toMatch(/已经?暂停/);
        expect(await h.service.readProp("demo-speaker-xiaoai", "playing-state")).toBe(2);
      }

      // Positive resume / generic play variations still trigger playback: "play"
      for (const phrase of [
        "继续播放",
        "继续播放音乐",
        "继续播放音乐吧",
        "恢复播放",
        "播放音乐",
        "播放音乐吧",
        "取消暂停",
        "play music",
        "resume",
      ]) {
        await h.service.runAction("demo-speaker-xiaoai", "pause");
        const res = await h.agent.prompt(phrase, { source: "voice" });
        expect(res.ok).toBe(true);
        expect(res.toolCalls[0]?.name).toBe("control_speaker");
        expect(res.toolCalls[0]?.args.playback).toBe("play");
        expect(res.reply).toContain("继续播放");
        expect(await h.service.readProp("demo-speaker-xiaoai", "playing-state")).toBe(1);
      }

      // Specific song titles containing negation/stop/next words still play the song
      for (const [phrase, expectedSong] of [
        ["播放不要说话", "不要说话"],
        ["播放 Don't Stop Me Now", "Don't Stop Me Now"],
        ["播放 Next Level", "Next Level"],
      ] as const) {
        const res = await h.agent.prompt(phrase);
        expect(res.ok).toBe(true);
        expect(res.toolCalls[0]?.name).toBe("control_speaker");
        expect(res.toolCalls[0]?.args.play_music).toBe(expectedSong);
      }

      // Track navigation takes precedence over musicMatch ("播放下一首" != play_music:"下一首")
      const rNext = await h.agent.prompt("播放下一首");
      expect(rNext.ok).toBe(true);
      expect(rNext.toolCalls[0]?.name).toBe("control_speaker");
      expect(rNext.toolCalls[0]?.args.playback).toBe("next");
      expect(rNext.toolCalls[0]?.args.play_music).toBeUndefined();

      const rPrev = await h.agent.prompt("播放上一首");
      expect(rPrev.ok).toBe(true);
      expect(rPrev.toolCalls[0]?.name).toBe("control_speaker");
      expect(rPrev.toolCalls[0]?.args.playback).toBe("previous");

      // Volume down phrase mentioning 音乐 does NOT trigger stop
      await h.service.writeProp("demo-speaker-xiaoai", "volume", 50);
      const rVolDown = await h.agent.prompt("把音乐声音调小一点");
      expect(rVolDown.ok).toBe(true);
      expect(rVolDown.toolCalls[0]?.name).toBe("control_speaker");
      expect(rVolDown.toolCalls[0]?.args.volume_delta).toBe(-15);
      expect(rVolDown.toolCalls[0]?.args.playback).toBeUndefined();

      // Compound clause: turn off light and stop playing music
      await h.service.setPowerState("demo-light-living", true);
      await h.service.runAction("demo-speaker-xiaoai", "play");
      const rCompound = await h.agent.prompt("关闭客厅灯并停止播放音乐");
      expect(rCompound.ok).toBe(true);
      expect(rCompound.toolCalls.length).toBe(2);
      expect(rCompound.toolCalls[0]?.name).toBe("set_device_power");
      expect(rCompound.toolCalls[1]?.name).toBe("control_speaker");
      expect(rCompound.toolCalls[1]?.args.playback).toBe("stop");
      expect(await h.service.powerState("demo-light-living")).toBe(false);
      expect(await h.service.readProp("demo-speaker-xiaoai", "playing-state")).toBe(2);

      // Voice attention gate keeps stop/negation music commands intact
      for (const [raw, expectedCmd] of [
        ["小派，停止播放音乐", "停止播放音乐"],
        ["小派，不要播放音乐", "不要播放音乐"],
        ["小派，别放歌了", "别放歌了"],
      ] as const) {
        const attn = await evaluateVoiceAttention({
          rawText: raw,
          wakeWordEnabled: true,
          wakeWords: ["小派"],
          attentionMode: "smart",
        });
        expect(attn.accept).toBe(true);
        expect(attn.command).toBe(expectedCmd);
      }
    } finally {
      await h.cleanup();
    }
  });

  test("stops playback on real xiaomi.wifispeaker.l05b spec (stop -> -704220008 -> pause fallback, never play)", async () => {
    const l05bSpec: FlattenedSpec = {
      name: "Speaker",
      properties: [
        {
          name: "volume",
          description: "Volume / 音量",
          type: "uint",
          rw: "rw",
          unit: "percentage",
          range: [0, 100, 1],
          "value-list": null,
          method: { siid: 2, piid: 1 },
          service: "speaker",
        },
        {
          name: "mute-2",
          description: "Mute / 静音",
          type: "bool",
          rw: "rw",
          range: null,
          "value-list": null,
          method: { siid: 2, piid: 2 },
          service: "speaker",
        },
      ],
      actions: [
        { name: "play", description: "Play / 播放", method: { siid: 3, aiid: 2 }, service: "play-control" },
        { name: "pause", description: "Pause / 暂停", method: { siid: 3, aiid: 3 }, service: "play-control" },
        { name: "stop", description: "Stop / 结束播放", method: { siid: 3, aiid: 4 }, service: "play-control" },
        { name: "previous", description: "Previous / 上一首", method: { siid: 3, aiid: 5 }, service: "play-control" },
        { name: "next", description: "Next / 下一首", method: { siid: 3, aiid: 6 }, service: "play-control" },
        { name: "stop-alarm", description: "Stop Alarm / 停止闹钟", method: { siid: 6, aiid: 1 }, service: "clock" },
      ],
    };

    const actionPayloads: Array<Record<string, unknown>> = [];
    const mockApi = {
      authDataPath: path.join(tmpDir, "auth.json"),
      apiBaseUrl: "https://api.io.mi.com/app",
      available: true,
      authData: { userId: "test-user" },
      getHomesList: mock(async () => [
        { name: "家", roomlist: [{ name: "房间", dids: ["504337266"] }] },
      ]),
      getDevicesList: mock(async () => [
        {
          did: "504337266",
          name: "小爱音箱Play",
          model: "xiaomi.wifispeaker.l05b",
          spec_type: "urn:miot-spec-v2:device:speaker:0000A015:xiaomi-l05b:1",
          isOnline: true,
        },
      ]),
      getSharedDevicesList: mock(async () => []),
      getDevicesProp: mock(async () => []),
      setDevicesProp: mock(async () => []),
      runAction: mock(async (payload: Record<string, unknown>) => {
        actionPayloads.push(payload);
        if (payload["siid"] === 3 && payload["aiid"] === 4) {
          return { code: -704220008 };
        }
        return { code: 0 };
      }),
    };

    const service = new MijiaService({
      api: mockApi as unknown as MijiaApiClient,
      specFetcher: async () => l05bSpec,
    });
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
    });

    try {
      mainWindow.start();
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        if (!mainWindow.loadActive && !mainWindow.loadingDevices && mainWindow.allDevices.length > 0) {
          break;
        }
        await Bun.sleep(15);
      }

      const res = await agent.prompt("停止播放音乐", { source: "voice" });
      expect(res.ok).toBe(true);
      expect(res.toolCalls[0]?.name).toBe("control_speaker");
      expect(res.toolCalls[0]?.args.playback).toBe("stop");
      expect(res.reply).toMatch(/已经?停止/);
      expect(res.reply).not.toContain("继续播放");
      // Tried stop (s3a4) -> -704220008 -> transparently fell back to pause (s3a3); NEVER called play (s3a2) or stop-alarm (s6a1)
      expect(actionPayloads).toEqual([
        { did: "504337266", siid: 3, aiid: 4, in: [] },
        { did: "504337266", siid: 3, aiid: 3, in: [] },
      ]);
    } finally {
      agent.dispose();
      networkMonitor.stop();
      mainWindow.dispose();
      await jobs.shutdown();
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

describe("ModelDiscovery (Auto-fetch from Provider API)", () => {
  test("fetches OpenAI-compatible /models list using saved or transient API key and redacts errors", async () => {
    let seenUrl = "";
    let seenAuth = "";
    const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      seenUrl = String(input);
      const headers = new Headers(init?.headers);
      seenAuth = headers.get("authorization") ?? "";
      return new Response(
        JSON.stringify({
          data: [
            { id: "group/qwen3.8-flash-next", owned_by: "magpie" },
            { id: "auto/claude-sonnet-5-5", owned_by: "magpie" },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await fetchProviderModels({
      provider: "openai-compatible",
      baseUrl: "https://gateway.example.test/v1/",
      apiKey: "sk-magpie-secret-test-9999",
      fetcher: mockFetch,
    });
    expect(result.ok).toBe(true);
    expect(result.source).toBe("api");
    expect(seenUrl).toBe("https://gateway.example.test/v1/models");
    expect(seenAuth).toBe("Bearer sk-magpie-secret-test-9999");
    expect(result.models.map((m) => m.id)).toEqual([
      "group/qwen3.8-flash-next",
      "auto/claude-sonnet-5-5",
    ]);

    // Fallback with redacted error on HTTP 401
    const errFetch = async () =>
      new Response(JSON.stringify({ error: { message: "Invalid key sk-magpie-secret-test-9999" } }), {
        status: 401,
      });
    const failed = await fetchProviderModels({
      provider: "deepseek",
      baseUrl: "https://gateway.example.test/v1",
      apiKey: "sk-magpie-secret-test-9999",
      fetcher: errFetch,
    });
    expect(failed.ok).toBe(false);
    expect(failed.source).toBe("fallback");
    expect(failed.models.length).toBeGreaterThan(0);
    expect(failed.error).not.toContain("sk-magpie-secret-test-9999");

    // Custom provider with anthropic-messages protocol
    let customAnthHeader = "";
    const customAnth = await fetchProviderModels({
      provider: "openai-compatible",
      apiType: "anthropic-messages",
      baseUrl: "https://custom-claude.example.test",
      apiKey: "sk-ant-custom-0001",
      fetcher: async (_url, init) => {
        customAnthHeader = new Headers(init?.headers).get("x-api-key") ?? "";
        return new Response(JSON.stringify({ data: [{ id: "claude-custom-1" }] }), { status: 200 });
      },
    });
    expect(customAnth.ok).toBe(true);
    expect(customAnthHeader).toBe("sk-ant-custom-0001");
    expect(customAnth.models[0]?.id).toBe("claude-custom-1");
  });

  test("supports Google Gemini x-goog-api-key and Anthropic x-api-key model discovery", async () => {
    let googleHeader = "";
    const gRes = await fetchProviderModels({
      provider: "google",
      apiKey: "AIzaTestKey123",
      fetcher: (async (_url, init) => {
        googleHeader = new Headers(init?.headers).get("x-goog-api-key") ?? "";
        return new Response(
          JSON.stringify({
            models: [
              { name: "models/gemini-2.5-flash", displayName: "Gemini 2.5 Flash", supportedGenerationMethods: ["generateContent"] },
              { name: "models/embedding-001", supportedGenerationMethods: ["embedContent"] },
            ],
          }),
          { status: 200 },
        );
      }) as typeof fetch,
    });
    expect(gRes.ok).toBe(true);
    expect(googleHeader).toBe("AIzaTestKey123");
    expect(gRes.models.map((m) => m.id)).toEqual(["gemini-2.5-flash"]);

    let anthHeader = "";
    const aRes = await fetchProviderModels({
      provider: "anthropic",
      apiKey: "sk-ant-test-key",
      fetcher: (async (_url, init) => {
        anthHeader = new Headers(init?.headers).get("x-api-key") ?? "";
        return new Response(
          JSON.stringify({ data: [{ id: "claude-sonnet-4-5", display_name: "Claude Sonnet 4.5" }] }),
          { status: 200 },
        );
      }) as typeof fetch,
    });
    expect(aRes.ok).toBe(true);
    expect(anthHeader).toBe("sk-ant-test-key");
    expect(aRes.models[0]?.id).toBe("claude-sonnet-4-5");
  });
});
