// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 本地 SenseVoice 流式转写、配置迁移与 ClearVoice/Qwen3-ASR 移除回归测试

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LocalAsrOutput, LocalVoiceEngine, StreamingVadHandleLike } from "../src/agent/localVoiceEngine.ts";
import {
  splitStreamingSentences,
  StreamingAsrHypothesisTracker,
  type StreamingPartialUpdate,
} from "../src/agent/streamingAsrTracker.ts";
import { VoiceStreamSession, type VoiceStreamSegmentPayload } from "../src/agent/voiceStreamSession.ts";
import {
  defaultAgentVoiceConfig,
  loadAgentVoiceConfig,
  normalizeAgentVoiceConfig,
  toPublicAgentVoiceConfig,
  updateAgentVoiceConfig,
} from "../src/core/agentConfigStore.ts";
import { setDataPathOverrides } from "../src/core/jsonStore.ts";
import { VirtualDemoService } from "../src/core/virtualLightService.ts";
import { startMijiaDeckServer, type MijiaDeckServer } from "../src/server/server.ts";

let tempDir: string | null = null;
let runningServer: MijiaDeckServer | null = null;

function useTempDataDir(): string {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "mijiadeck-streaming-asr-"));
  const dir = tempDir;
  setDataPathOverrides({ dataDir: () => dir });
  return dir;
}

afterEach(async () => {
  if (runningServer) {
    await runningServer.stop();
    runningServer = null;
  }
  setDataPathOverrides(null);
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

function makeSine(durationSec: number, amp = 0.22, freqHz = 440, sr = 16000): Float32Array {
  const n = Math.round(durationSec * sr);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    out[i] = Math.sin((2 * Math.PI * freqHz * i) / sr) * amp;
  }
  return out;
}

function makeSilence(durationSec: number, sr = 16000): Float32Array {
  return new Float32Array(Math.round(durationSec * sr));
}

function createEnergyMockVad(silenceFramesToEnd = 14): StreamingVadHandleLike {
  let detected = false;
  let silentFrames = 0;
  let totalFed = 0;
  let segStart = 0;
  let chunks: Float32Array[] = [];
  const emitted: Array<{ start: number; samples: Float32Array }> = [];

  const finalize = () => {
    if (chunks.length === 0) return;
    const len = chunks.reduce((a, c) => a + c.length, 0);
    const merged = new Float32Array(len);
    let off = 0;
    for (const c of chunks) {
      merged.set(c, off);
      off += c.length;
    }
    emitted.push({ start: segStart, samples: merged });
    chunks = [];
    detected = false;
    silentFrames = 0;
  };

  return {
    acceptWaveform(frame: Float32Array) {
      let sum = 0;
      for (let i = 0; i < frame.length; i += 1) sum += frame[i]! * frame[i]!;
      const rms = Math.sqrt(sum / Math.max(1, frame.length));
      if (rms >= 0.02) {
        if (!detected) {
          detected = true;
          segStart = totalFed;
          chunks = [];
        }
        silentFrames = 0;
        chunks.push(new Float32Array(frame));
      } else if (detected) {
        silentFrames += 1;
        chunks.push(new Float32Array(frame));
        if (silentFrames >= silenceFramesToEnd) {
          finalize();
        }
      }
      totalFed += frame.length;
    },
    isDetected: () => detected,
    isEmpty: () => emitted.length === 0,
    front: () => emitted[0]!,
    pop: () => {
      emitted.shift();
    },
    flush: () => finalize(),
    clear: () => {
      emitted.length = 0;
    },
    reset: () => {
      emitted.length = 0;
      chunks = [];
      detected = false;
      silentFrames = 0;
      totalFed = 0;
    },
  };
}

describe("StreamingAsrHypothesisTracker & Bilingual Sentence Splitting", () => {
  test("splits completed Chinese/English sentences while protecting wake words and stabilizing LocalAgreement prefixes", () => {
    const split = splitStreamingSentences("Neo，打开客厅吸顶灯。把卧室空调调到26度", {
      wakeWords: ["Neo"],
    });
    expect(split.completed).toEqual(["Neo，打开客厅吸顶灯。"]);
    expect(split.remainder).toBe("把卧室空调调到26度");

    // Wake word followed immediately by period must NOT split standalone wake word
    const wakeProtect = splitStreamingSentences("Neo。打开客厅吸顶灯", {
      wakeWords: ["Neo"],
    });
    expect(wakeProtect.completed).toEqual([]);
    expect(wakeProtect.remainder).toContain("打开客厅吸顶灯");

    // LocalAgreement stability + default whole-utterance mode
    const tracker = new StreamingAsrHypothesisTracker({
      wakeWords: ["Neo"],
      splitMidUtterance: false,
    });
    const r1 = tracker.ingestHypothesis("Neo，打开客厅", { engine: "sensevoice-local", latencyMs: 30 });
    expect(r1.completedSentences).toEqual([]);
    expect(r1.partial?.text).toBe("Neo，打开客厅");

    const r2 = tracker.ingestHypothesis("Neo，打开客厅吸顶灯。", {
      engine: "sensevoice-local",
      latencyMs: 35,
    });
    expect(r2.completedSentences).toEqual([]);
    expect(r2.partial?.stableText).toBe("Neo，打开客厅");
    expect(r2.partial?.unstableText).toBe("吸顶灯。");
    expect(tracker.flush()).toEqual(["Neo，打开客厅吸顶灯。"]);
  });
});

describe("VoiceStreamSession 流式开关（streamingAsrEnabled）实时热切换", () => {
  test("streamingAsrEnabled=true 推送实时流式预览，关闭后静默转入传统静音判停模式", async () => {
    let asrCalls = 0;
    const fakeEngine = {
      createOnlineDenoiser: () => null,
      createStreamingVad: () => createEnergyMockVad(16),
      createWakeWordStream: () => null,
      getStatus: () => ({ readyForLocalAsr: true }),
      transcribeLocal: async (): Promise<LocalAsrOutput> => {
        asrCalls += 1;
        return {
          text: "打开客厅吸顶灯",
          rawText: "打开客厅吸顶灯",
          lang: "zh",
          emotion: "",
          event: "",
          engine: "sensevoice-local",
          durationMs: 20,
        };
      },
    } as unknown as LocalVoiceEngine;

    const partials: StreamingPartialUpdate[] = [];
    const emitted: VoiceStreamSegmentPayload[] = [];
    const session = new VoiceStreamSession({
      localEngine: fakeEngine,
      noiseMode: "off",
      voicePipelineMode: "legacy",
      bypassWakeWord: true,
      owwEnabled: false,
      streamingAsrEnabled: true,
      streamingPollIntervalMs: 300,
      onPartialTranscript: (p) => partials.push(p),
      onSegmentReady: async (seg) => {
        emitted.push(seg);
        return null;
      },
    });

    session.pushFloat32Samples(makeSine(1.0));
    await Bun.sleep(30);
    expect(asrCalls).toBeGreaterThanOrEqual(1);
    expect(partials.length).toBeGreaterThanOrEqual(1);

    session.pushFloat32Samples(makeSilence(0.8));
    await session.waitForIdle();
    expect(emitted.length).toBe(1);

    // Hot-disable streaming ASR: subsequent speech produces 0 speculative preview calls
    session.setStreamingAsrEnabled(false);
    expect(session.streamingAsrEnabled).toBe(false);
    const asrBeforeOff = asrCalls;
    const partialsBeforeOff = partials.length;

    session.pushFloat32Samples(makeSine(1.0));
    await Bun.sleep(30);
    expect(asrCalls).toBe(asrBeforeOff);
    expect(partials.length).toBe(partialsBeforeOff);

    session.pushFloat32Samples(makeSilence(0.8));
    await session.waitForIdle();
    expect(emitted.length).toBe(2);

    session.dispose();
  });
});

describe("旧配置迁移与 ClearVoice / Qwen3-ASR 彻底移除校验", () => {
  test("加载包含遗留 clearVoice* / qwen3Asr* / localAsrEngine / qwen3StreamingEnabled 的 pi_agent.json 时自动无损迁移", () => {
    const dir = useTempDataDir();
    writeFileSync(
      path.join(dir, "pi_agent.json"),
      JSON.stringify({
        voicePipelineMode: "clearvoice",
        localAsrEngine: "qwen3-asr",
        qwen3StreamingEnabled: false,
        clearVoiceServiceUrl: "https://legacy.example.invalid:18443",
        clearVoiceApiKey: "legacy-cv-secret",
        qwen3AsrServiceUrl: "https://legacy.example.invalid:18443",
        qwen3AsrApiKey: "legacy-qwen-secret",
        wakeWords: ["Neo"],
      }),
      "utf-8",
    );

    const loaded = loadAgentVoiceConfig();
    expect(loaded.voicePipelineMode).toBe("legacy");
    expect(loaded.streamingAsrEnabled).toBe(false);

    const normalized = normalizeAgentVoiceConfig({
      ...defaultAgentVoiceConfig(),
      voicePipelineMode: "clearvoice" as unknown as "legacy",
    });
    expect(normalized.voicePipelineMode).toBe("legacy");

    const pub = toPublicAgentVoiceConfig(loaded) as unknown as Record<string, unknown>;
    expect(pub.streamingAsrEnabled).toBe(false);
    expect(pub.qwen3StreamingEnabled).toBeUndefined();
    expect(pub.localAsrEngine).toBeUndefined();
    expect(pub.clearVoiceServiceUrl).toBeUndefined();
    expect(pub.qwen3AsrServiceUrl).toBeUndefined();

    const updated = updateAgentVoiceConfig({ streamingAsrEnabled: true });
    expect(updated.streamingAsrEnabled).toBe(true);
  });

  test("HTTP 服务已移除 /api/voice/gateway/test 及前端 ClearVoice / Qwen3-ASR 界面与配置字段", async () => {
    useTempDataDir();
    runningServer = await startMijiaDeckServer({
      mode: "demo",
      port: 0,
      hostname: "127.0.0.1",
      service: new VirtualDemoService(),
    });

    const removedGateway = await fetch(`${runningServer.url}/api/voice/gateway/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(removedGateway.status).toBe(404);

    const statusRes = await fetch(`${runningServer.url}/api/voice/pipeline/status`);
    expect(statusRes.ok).toBe(true);
    const statusJson = (await statusRes.json()) as { localEngine: Record<string, unknown> };
    expect(statusJson.localEngine.clearVoice).toBeUndefined();
    expect(statusJson.localEngine.gpu).toBeUndefined();
    expect(statusJson.localEngine.readyForClearVoiceGpu).toBeUndefined();
    expect(statusJson.localEngine.readyForQwen3Asr).toBeUndefined();

    const cfgRes = await fetch(`${runningServer.url}/api/agent/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ streamingAsrEnabled: false }),
    });
    expect(cfgRes.ok).toBe(true);
    const cfgJson = (await cfgRes.json()) as {
      config: Record<string, unknown>;
      voice: Record<string, unknown>;
    };
    expect(cfgJson.config.streamingAsrEnabled).toBe(false);
    expect(cfgJson.voice.streamingAsrEnabled).toBe(false);
    expect(cfgJson.voice.lastTrackBatch).toBeUndefined();
    expect(cfgJson.voice.mutedTracks).toBeUndefined();

    const html = await (await fetch(`${runningServer.url}/`)).text();
    expect(html).toContain("setting-row-streaming-asr");
    expect(html).toContain("set-voice-streaming-asr");
    expect(html).toContain("setting-row-voice-pipeline");
    expect(html).not.toContain("badge-model-qwen3-asr");
    expect(html).not.toContain("badge-model-clearvoice");
    expect(html).not.toContain("setting-row-local-asr-engine");
    expect(html).not.toContain("setting-row-voice-gateway");
    expect(html).not.toContain("pi-voice-tracks-panel");
  });
});
