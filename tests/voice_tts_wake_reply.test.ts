// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 温柔女声本地神经 TTS 与自定义唤醒词回复短语回归测试

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_WAKE_ACK_PHRASE,
  resolveWakeAckReply,
} from "../src/agent/cavemanReplyPolicy.ts";
import {
  LocalTtsEngine,
  normalizeTextForLocalTts,
  normalizeTtsSpeed,
  normalizeTtsVoice,
  postProcessTtsSamples,
} from "../src/agent/localTtsEngine.ts";
import {
  defaultAgentVoiceConfig,
  loadAgentVoiceConfig,
  normalizeAgentVoiceConfig,
  updateAgentVoiceConfig,
} from "../src/core/agentConfigStore.ts";
import { setDataPathOverrides } from "../src/core/jsonStore.ts";
import { VirtualDemoService } from "../src/core/virtualLightService.ts";
import { startMijiaDeckServer, type MijiaDeckServer } from "../src/server/server.ts";
import { pickGentleBrowserVoice } from "../src/web/voiceListener.ts";

let tmpDir = "";
let server: MijiaDeckServer | null = null;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "mijiadeck-tts-wake-"));
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

describe("Wake-Word Reply Phrase Config & Behavior", () => {
  test("defaults to '嗯?' when unset and preserves explicit empty string '' for silent mode", () => {
    expect(DEFAULT_WAKE_ACK_PHRASE).toBe("嗯?");
    expect(resolveWakeAckReply(undefined)).toBe("嗯?");
    expect(resolveWakeAckReply(null)).toBe("嗯?");
    expect(resolveWakeAckReply("")).toBe("");
    expect(resolveWakeAckReply("   ")).toBe("");
    expect(resolveWakeAckReply("我在听呢")).toBe("我在听呢");

    const def = defaultAgentVoiceConfig();
    expect(def.wakeAckPhrase).toBe("嗯?");
    expect(def.ttsEngine).toBe("auto");
    expect(def.ttsVoice).toBe("gentle-zh-en");
    expect(def.ttsSpeed).toBe(0.98);

    // Unset field in legacy JSON falls back to default "嗯?"
    const legacy = normalizeAgentVoiceConfig({ provider: "local" });
    expect(legacy.wakeAckPhrase).toBe("嗯?");

    // Explicit empty string persists as ""
    updateAgentVoiceConfig({ wakeAckPhrase: "" });
    expect(loadAgentVoiceConfig().wakeAckPhrase).toBe("");

    // Custom phrase persists cleanly
    updateAgentVoiceConfig({ wakeAckPhrase: "请说，我在听" });
    expect(loadAgentVoiceConfig().wakeAckPhrase).toBe("请说，我在听");
  });

  test("wake-only trigger speaks default '嗯?', custom phrase, and stays silent + continuously listening when empty", async () => {
    const demo = new VirtualDemoService();
    server = await startMijiaDeckServer({ mode: "demo", port: 0, service: demo });
    // Use sourceSeparationMode="off" and owwEnabled=false so transcript unit test doesn't warm 500MB ASR/separation models
    await fetch(`${server.url}/api/agent/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceSeparationMode: "off",
        owwEnabled: false,
        ttsEngine: "browser",
      }),
    });
    const vl = server.runtime.voiceListener!;
    vl.updateRuntimeState({ active: true });

    const spoken: string[] = [];
    vl.on("speakRequested", (text) => {
      spoken.push(text);
    });

    // 1. Default phrase -> "嗯?"
    const rDefault = await vl.handleTranscript("小派", { isFinal: true });
    expect(rDefault.matched).toBe(true);
    expect(rDefault.wokeOnly).toBe(true);
    expect(rDefault.reply).toBe("嗯?");
    expect(rDefault.voiceState.dialogState).toBe("conversation");
    expect(spoken).toEqual(["嗯?"]);

    // Return to standby
    vl.exitConversation("test_reset", { speakAck: false });
    spoken.length = 0;

    // 2. Custom phrase -> "在呢，请讲"
    const cfgCustom = await fetch(`${server.url}/api/agent/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wakeAckPhrase: "在呢，请讲" }),
    });
    expect(cfgCustom.status).toBe(200);
    expect(((await cfgCustom.json()) as any).config.wakeAckPhrase).toBe("在呢，请讲");

    const rCustom = await vl.handleTranscript("小派", { isFinal: true });
    expect(rCustom.matched).toBe(true);
    expect(rCustom.wokeOnly).toBe(true);
    expect(rCustom.reply).toBe("在呢，请讲");
    expect(rCustom.voiceState.dialogState).toBe("conversation");
    expect(spoken).toEqual(["在呢，请讲"]);

    // Return to standby
    vl.exitConversation("test_reset", { speakAck: false });
    spoken.length = 0;

    // 3. Empty phrase "" -> silent, NO speakRequested emitted, still enters conversation & executes follow-up command
    const cfgSilent = await fetch(`${server.url}/api/agent/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wakeAckPhrase: "" }),
    });
    expect(cfgSilent.status).toBe(200);
    const silentJson = (await cfgSilent.json()) as any;
    expect(silentJson.config.wakeAckPhrase).toBe("");
    expect(silentJson.voice.wakeAckPhrase).toBe("");

    const rSilent = await vl.handleTranscript("小派", { isFinal: true });
    expect(rSilent.matched).toBe(true);
    expect(rSilent.wokeOnly).toBe(true);
    expect(rSilent.reply).toBe("");
    expect(rSilent.voiceState.dialogState).toBe("conversation");
    expect(rSilent.voiceState.mode).toBe("awake");
    expect(spoken).toEqual([]);

    // Follow-up command without repeating wake word still executes seamlessly in continuous listening
    const followUp = await vl.handleTranscript("关闭客厅吸顶灯", { isFinal: true });
    expect(followUp.ok).toBe(true);
    expect(followUp.matched).toBe(true);
    expect(followUp.command).toBe("关闭客厅吸顶灯");
    expect(await demo.powerState("demo-light-living")).toBe(false);
  });
});

describe("Local Gentle Female TTS Engine & HTTP Endpoint", () => {
  test("normalizes percentages, temperatures, Markdown, and English tokens cleanly", () => {
    expect(normalizeTextForLocalTts("嗯?")).toBe("嗯？");
    expect(normalizeTextForLocalTts("**客厅吸顶灯** [did=1] 亮度 85%，温度 23.6°C ✨")).toBe(
      "客厅吸顶灯 亮度 百分之85，温度 23.6度",
    );
    expect(normalizeTextForLocalTts("Neo已就绪，OK", "gentle-zh-en")).toBe("尼奥已就绪，ok");
    expect(normalizeTextForLocalTts("Neo已就绪，OK", "warm-zh-baker")).toBe("尼奥已就绪，好的");
    expect(normalizeTtsVoice("warm-zh-baker")).toBe("warm-zh-baker");
    expect(normalizeTtsVoice("invalid")).toBe("gentle-zh-en");
    expect(normalizeTtsSpeed(0.5)).toBe(0.7);
    expect(normalizeTtsSpeed(2.0)).toBe(1.4);
    expect(normalizeTtsSpeed(1.05)).toBe(1.05);
  });

  test("postProcessTtsSamples adds click-free leading pad and normalizes peak safely", () => {
    const raw = new Float32Array(1600);
    for (let i = 0; i < raw.length; i += 1) {
      raw[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / 16000);
    }
    const processed = postProcessTtsSamples(raw, 16000);
    expect(processed.length).toBeGreaterThan(raw.length);
    // Leading 35ms silence pad prevents first-syllable cutoff
    expect(processed[0]).toBe(0);
    expect(processed[100]).toBe(0);
    let maxAbs = 0;
    for (let i = 0; i < processed.length; i += 1) {
      const a = Math.abs(processed[i]!);
      if (a > maxAbs) maxAbs = a;
    }
    expect(maxAbs).toBeGreaterThan(0.8);
    expect(maxAbs).toBeLessThanOrEqual(0.98);

    // Quiet signals cap gain at 2.2x to avoid boosting background hiss
    const quiet = new Float32Array(1600).fill(0.1);
    const quietOut = postProcessTtsSamples(quiet, 16000);
    expect(quietOut[1000]!).toBeCloseTo(0.22, 2);
  });

  test("pickGentleBrowserVoice prioritizes gentle female voices and avoids male voices", () => {
    const mk = (name: string, lang = "zh-CN") =>
      ({ name, lang, voiceURI: name, default: false, localService: true }) as SpeechSynthesisVoice;
    const picked1 = pickGentleBrowserVoice([
      mk("Microsoft Kangkang - Chinese (Simplified)"),
      mk("Microsoft Huihui Desktop - Chinese (Simplified)"),
      mk("Microsoft Xiaoxiao Online (Natural) - Chinese (Mainland)"),
    ]);
    expect(picked1?.name).toContain("Xiaoxiao");

    const picked2 = pickGentleBrowserVoice([
      mk("Microsoft Yunxi Online (Natural) - Chinese (Mainland)"),
      mk("Microsoft Xiaoyi Online (Natural) - Chinese (Mainland)"),
    ]);
    expect(picked2?.name).toContain("Xiaoyi");
  });

  test("POST /api/voice/tts synthesizes gentle female WAV audio with LRU caching (and gracefully degrades if models absent)", async () => {
    const demo = new VirtualDemoService();
    server = await startMijiaDeckServer({ mode: "demo", port: 0, service: demo });

    const statusRes = await fetch(`${server.url}/api/voice/tts/status`);
    expect(statusRes.status).toBe(200);
    const statusJson = (await statusRes.json()) as any;
    expect(statusJson.ok).toBe(true);
    expect(Array.isArray(statusJson.presets)).toBe(true);
    expect(statusJson.presets.length).toBeGreaterThanOrEqual(2);

    // Reject empty text with 400
    const badRes = await fetch(`${server.url}/api/voice/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "   " }),
    });
    expect(badRes.status).toBe(400);

    // Real local synthesis check when Matcha model is installed on disk
    if (statusJson.tts?.ready) {
      const r1 = await fetch(`${server.url}/api/voice/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "嗯?", voice: "gentle-zh-en", speed: 0.98 }),
      });
      expect(r1.status).toBe(200);
      expect(r1.headers.get("content-type")).toBe("audio/wav");
      expect(r1.headers.get("x-tts-voice")).toBe("gentle-zh-en");
      const wav1 = new Uint8Array(await r1.arrayBuffer());
      expect(wav1.byteLength).toBeGreaterThan(2000);
      expect(new TextDecoder().decode(wav1.slice(0, 4))).toBe("RIFF");

      // Second call hits LRU cache instantaneously
      const r2 = await fetch(`${server.url}/api/voice/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "嗯?", voice: "gentle-zh-en", speed: 0.98 }),
      });
      expect(r2.status).toBe(200);
      expect(r2.headers.get("x-tts-cache")).toBe("hit");
    }

    // Missing model directory reports ready=false cleanly without crashing
    const emptyModelsDir = mkdtempSync(path.join(os.tmpdir(), "mijiadeck-no-tts-"));
    try {
      const emptyEngine = new LocalTtsEngine({ modelsDir: emptyModelsDir });
      expect(emptyEngine.getStatus().ready).toBe(false);
      expect(emptyEngine.resolveAvailableVoice()).toBeNull();
    } finally {
      rmSync(emptyModelsDir, { recursive: true, force: true });
    }
  }, 20_000);
});
