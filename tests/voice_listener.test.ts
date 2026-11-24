// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 语音监听、唤醒词提取、STT 转写与 Pi Agent 端到端控制测试

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractWakeCommand } from "../src/agent/voiceListenerController.ts";
import { setDataPathOverrides } from "../src/core/jsonStore.ts";
import { VirtualDemoService } from "../src/core/virtualLightService.ts";
import { startMijiaDeckServer, type MijiaDeckServer } from "../src/server/server.ts";

let tmpDir = "";
let server: MijiaDeckServer | null = null;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "mijiadeck-voice-listen-"));
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

describe("Wake-Word Extraction", () => {
  const words = ["小派", "派派", "pi", "米家助手"];

  test("extracts command after Chinese or English wake words", () => {
    const r1 = extractWakeCommand("小派，打开客厅吸顶灯", { wakeWordEnabled: true, wakeWords: words });
    expect(r1.matched).toBe(true);
    expect(r1.wokeOnly).toBe(false);
    expect(r1.command).toBe("打开客厅吸顶灯");

    const r2 = extractWakeCommand("小派把餐厅主灯关了", { wakeWordEnabled: true, wakeWords: words });
    expect(r2.matched).toBe(true);
    expect(r2.command).toBe("把餐厅主灯关了");

    const r3 = extractWakeCommand("Hey pi, turn off living room light", {
      wakeWordEnabled: true,
      wakeWords: words,
    });
    expect(r3.matched).toBe(true);
    expect(r3.command).toBe("turn off living room light");
  });

  test("handles wake-only trigger, ambient speech rejection, active wake window and bypass mode", () => {
    const wakeOnly = extractWakeCommand("小派！", { wakeWordEnabled: true, wakeWords: words });
    expect(wakeOnly.matched).toBe(true);
    expect(wakeOnly.wokeOnly).toBe(true);
    expect(wakeOnly.command).toBe("");

    const ambient = extractWakeCommand("今天晚饭吃什么", { wakeWordEnabled: true, wakeWords: words });
    expect(ambient.matched).toBe(false);

    // Avoid false positive inside longer English word ("picture" contains "pi")
    const falseEn = extractWakeCommand("take a picture please", { wakeWordEnabled: true, wakeWords: words });
    expect(falseEn.matched).toBe(false);

    const activeWindow = extractWakeCommand("关闭客厅吸顶灯", {
      wakeWordEnabled: true,
      wakeWords: words,
      awakeActive: true,
    });
    expect(activeWindow.matched).toBe(true);
    expect(activeWindow.command).toBe("关闭客厅吸顶灯");

    const bypass = extractWakeCommand("查看卧室温度", {
      wakeWordEnabled: true,
      wakeWords: words,
      bypassWakeWord: true,
    });
    expect(bypass.matched).toBe(true);
    expect(bypass.command).toBe("查看卧室温度");
  });
});

describe("Voice Listener -> Pi Agent End-to-End Server & WebSocket Integration", () => {
  test("wake-word flow + active wake window controls real demo devices and streams WS events", async () => {
    const demoService = new VirtualDemoService();
    server = await startMijiaDeckServer({
      mode: "demo",
      port: 0,
      service: demoService,
    });

    // Connect WebSocket client to capture live broadcasts
    const wsMessages: Array<{ type: string; data?: any; text?: string }> = [];
    const wsUrl = server.url.replace("http://", "ws://") + "/ws";
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", (e) => reject(e));
    });
    ws.addEventListener("message", (ev) => {
      wsMessages.push(JSON.parse(String(ev.data)));
    });

    try {
      // 1. Initial /api/state includes piAgent & voiceListen without exposing secrets
      const stateRes = await fetch(`${server.url}/api/state`);
      expect(stateRes.status).toBe(200);
      const stateJson = (await stateRes.json()) as any;
      expect(stateJson.piAgent).toBeTruthy();
      expect(stateJson.piAgent.provider).toBe("local");
      expect(stateJson.voiceListen).toBeTruthy();
      expect(stateJson.voiceListen.wakeWordEnabled).toBe(true);

      // 2. Ambient speech without wake word is ignored
      const ignRes = await fetch(`${server.url}/api/voice-listen/transcript`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "随便聊聊天", isFinal: true }),
      });
      const ignJson = (await ignRes.json()) as any;
      expect(ignJson.ok).toBe(true);
      expect(ignJson.matched).toBe(false);
      expect(await demoService.powerState("demo-light-living")).toBe(true);

      // 3. Wake word only ("小派") opens awake window
      const wakeRes = await fetch(`${server.url}/api/voice-listen/transcript`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "小派", isFinal: true }),
      });
      const wakeJson = (await wakeRes.json()) as any;
      expect(wakeJson.matched).toBe(true);
      expect(wakeJson.wokeOnly).toBe(true);
      expect(wakeJson.voiceState.mode).toBe("awake");
      expect(wakeJson.voiceState.awakeUntil).toBeGreaterThan(Date.now());

      // 4. Follow-up voice command without wake word executes via Pi Agent and turns off living room light
      const cmdRes = await fetch(`${server.url}/api/voice-listen/transcript`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "关闭客厅吸顶灯", isFinal: true }),
      });
      const cmdJson = (await cmdRes.json()) as any;
      expect(cmdJson.ok).toBe(true);
      expect(cmdJson.matched).toBe(true);
      expect(cmdJson.command).toBe("关闭客厅吸顶灯");
      expect(cmdJson.toolCalls.length).toBe(1);
      expect(cmdJson.toolCalls[0].name).toBe("set_device_power");
      expect(await demoService.powerState("demo-light-living")).toBe(false);
      expect(server.runtime.mainWindow.knownPower["demo-light-living"]).toBe(false);

      // Verify WebSocket received agent_state, voice_state, agent_speak, and device state updates
      await Bun.sleep(80);
      const types = new Set(wsMessages.map((m) => m.type));
      expect(types.has("voice_state")).toBe(true);
      expect(types.has("agent_state")).toBe(true);
      expect(types.has("agent_speak")).toBe(true);
    } finally {
      ws.close();
    }
  });

  test("POST /api/voice-listen/transcribe transcribes audio via OpenAI-compatible STT and drives Pi Agent", async () => {
    const demoService = new VirtualDemoService();
    let capturedAuth = "";
    let capturedUrl = "";

    const mockSttFetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(input);
      const headers = new Headers(init?.headers);
      capturedAuth = headers.get("authorization") ?? "";
      return new Response(JSON.stringify({ text: "小派，给宠物喂食器出粮3份" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    server = await startMijiaDeckServer({
      mode: "demo",
      port: 0,
      service: demoService,
      sttFetcher: mockSttFetcher,
    });

    // Configure STT endpoint via /api/agent/config
    const cfgRes = await fetch(`${server.url}/api/agent/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sttBaseUrl: "https://stt.example.test/v1",
        sttApiKey: "sk-test-stt-secret-key-0001",
        sttModel: "FunAudioLLM/SenseVoiceSmall",
      }),
    });
    expect(cfgRes.status).toBe(200);
    const cfgJson = (await cfgRes.json()) as any;
    expect(cfgJson.config.hasSttApiKey).toBe(true);
    expect(JSON.stringify(cfgJson)).not.toContain("sk-test-stt-secret-key-0001");

    // Upload audio blob to /api/voice-listen/transcribe
    const form = new FormData();
    form.append("audio", new Blob([new Uint8Array(2048)], { type: "audio/webm" }), "test.webm");
    form.append("lang", "zh-CN");
    form.append("autoDispatch", "true");

    const trRes = await fetch(`${server.url}/api/voice-listen/transcribe`, {
      method: "POST",
      body: form,
    });
    expect(trRes.status).toBe(200);
    const trJson = (await trRes.json()) as any;
    expect(trJson.ok).toBe(true);
    expect(trJson.text).toBe("小派，给宠物喂食器出粮3份");
    expect(trJson.matched).toBe(true);
    expect(trJson.command).toBe("给宠物喂食器出粮3份");
    expect(capturedUrl).toBe("https://stt.example.test/v1/audio/transcriptions");
    expect(capturedAuth).toBe("Bearer sk-test-stt-secret-key-0001");
    expect(demoService.lastDispensedPortions).toBe(3);
  });

  test("POST /api/agent/models auto-fetches live model list using saved server-side API key", async () => {
    let seenUrl = "";
    let seenAuth = "";
    server = await startMijiaDeckServer({
      mode: "demo",
      port: 0,
      modelFetcher: (async (input: string | URL | Request, init?: RequestInit) => {
        seenUrl = String(input);
        seenAuth = new Headers(init?.headers).get("authorization") ?? "";
        return new Response(
          JSON.stringify({
            data: [{ id: "group/qwen3.8-flash-next" }, { id: "auto/claude-sonnet-5-5" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }) as typeof fetch,
    });

    await fetch(`${server.url}/api/agent/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "openai-compatible",
        baseUrl: "https://magpie.example.test/v1",
        apiKey: "sk-saved-secret-key-5555",
        modelId: "group/qwen3.8-flash-next",
      }),
    });

    // Request models list WITHOUT resending apiKey — backend resolves saved key securely
    const res = await fetch(`${server.url}/api/agent/models`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "openai-compatible", baseUrl: "https://magpie.example.test/v1" }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.ok).toBe(true);
    expect(json.fetched).toBe(true);
    expect(json.source).toBe("api");
    expect(json.models.map((m: any) => m.id)).toEqual([
      "group/qwen3.8-flash-next",
      "auto/claude-sonnet-5-5",
    ]);
    expect(seenUrl).toBe("https://magpie.example.test/v1/models");
    expect(seenAuth).toBe("Bearer sk-saved-secret-key-5555");
    expect(JSON.stringify(json)).not.toContain("sk-saved-secret-key-5555");
  });
});
