// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: Qwen3-ASR-0.6B (CPU 主方案) + SenseVoice (备用/储备方案) 单元测试与集成测试

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { decodeWavPcm, encodeWavPcm16, resampleLinear } from "../src/agent/audioPcm.ts";
import {
  chooseBestAsrCandidate,
  cleanQwen3AsrText,
  LocalVoiceEngine,
  mapQwen3AsrLang,
  QWEN3_ASR_DIR_NAME,
  resolveVoiceModelPaths,
  SENSE_VOICE_DIR_NAME,
} from "../src/agent/localVoiceEngine.ts";
import {
  defaultAgentVoiceConfig,
  loadAgentVoiceConfig,
  normalizeLocalAsrEngine,
  updateAgentVoiceConfig,
} from "../src/core/agentConfigStore.ts";
import { setDataPathOverrides } from "../src/core/jsonStore.ts";
import { VirtualDemoService } from "../src/core/virtualLightService.ts";
import { startMijiaDeckServer, type MijiaDeckServer } from "../src/server/server.ts";

const BENCH_DIR = path.resolve(import.meta.dir, "../benchmarks/voice_sep_100");
const CLIP_001_PATH = path.join(BENCH_DIR, "audio", "clip_001.wav");
const HAS_CLIP_001 = existsSync(CLIP_001_PATH);

let tmpDir = "";
let server: MijiaDeckServer | null = null;

function loadClip001Pcm16k(): Float32Array {
  const wav = decodeWavPcm(new Uint8Array(readFileSync(CLIP_001_PATH)));
  return wav.sampleRate === 16000 ? wav.samples : resampleLinear(wav.samples, wav.sampleRate, 16000);
}

function copySenseVoiceModelTo(destModelsDir: string): boolean {
  const srcPaths = resolveVoiceModelPaths();
  if (!existsSync(srcPaths.senseVoiceModel) || !existsSync(srcPaths.senseVoiceTokens)) {
    return false;
  }
  const svDir = path.join(destModelsDir, SENSE_VOICE_DIR_NAME);
  mkdirSync(svDir, { recursive: true });
  copyFileSync(srcPaths.senseVoiceModel, path.join(svDir, "model.int8.onnx"));
  copyFileSync(srcPaths.senseVoiceTokens, path.join(svDir, "tokens.txt"));
  return true;
}

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "mijiadeck-qwen3-asr-test-"));
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

describe("Qwen3-ASR Primary & SenseVoice Reserve Config & Utilities", () => {
  test("defaults localAsrEngine to auto (Qwen3-ASR primary, SenseVoice reserve) and normalizes aliases", () => {
    expect(defaultAgentVoiceConfig().localAsrEngine).toBe("auto");
    expect(loadAgentVoiceConfig().localAsrEngine).toBe("auto");

    expect(normalizeLocalAsrEngine("qwen3-asr")).toBe("qwen3-asr");
    expect(normalizeLocalAsrEngine("Qwen3-ASR-0.6B")).toBe("qwen3-asr");
    expect(normalizeLocalAsrEngine("qwen3")).toBe("qwen3-asr");
    expect(normalizeLocalAsrEngine("sensevoice")).toBe("sensevoice");
    expect(normalizeLocalAsrEngine("sv")).toBe("sensevoice");
    expect(normalizeLocalAsrEngine("invalid", "auto")).toBe("auto");

    const updated = updateAgentVoiceConfig({ localAsrEngine: "sensevoice" });
    expect(updated.localAsrEngine).toBe("sensevoice");
    expect(loadAgentVoiceConfig().localAsrEngine).toBe("sensevoice");

    const backToQwen = updateAgentVoiceConfig({ localAsrEngine: "qwen3-asr-0.6b" });
    expect(backToQwen.localAsrEngine).toBe("qwen3-asr");

    expect(() => updateAgentVoiceConfig({ localAsrEngine: "unsupported-engine" })).toThrow();
  });

  test("cleanQwen3AsrText strips scaffold prefixes/tags and mapQwen3AsrLang maps languages", () => {
    expect(cleanQwen3AsrText("language Chinese<asr_text>Neo，打开客厅吸顶灯。")).toBe(
      "Neo，打开客厅吸顶灯。",
    );
    expect(cleanQwen3AsrText("  <asr_text>  把空调调到 25 度  ")).toBe("把空调调到 25 度");
    expect(cleanQwen3AsrText("<|zh|>打开台灯")).toBe("打开台灯");

    expect(mapQwen3AsrLang("zh-CN")).toBe("");
    expect(mapQwen3AsrLang("auto")).toBe("");
    expect(mapQwen3AsrLang("en-US")).toBe("English");
    expect(mapQwen3AsrLang("zh-HK")).toBe("Cantonese");
    expect(mapQwen3AsrLang("ja-JP")).toBe("Japanese");
    expect(mapQwen3AsrLang("ko-KR")).toBe("Korean");
  });

  test("chooseBestAsrCandidate preserves qwen3-asr and sensevoice engine families", () => {
    const qwenPick = chooseBestAsrCandidate(
      {
        text: "Neo，打开客厅吸顶灯。",
        rawText: "Neo，打开客厅吸顶灯。",
        lang: "",
        emotion: "",
        event: "",
        engine: "qwen3-asr-local",
        durationMs: 1400,
      },
      {
        text: "打开吸顶灯",
        rawText: "打开吸顶灯",
        lang: "",
        emotion: "",
        event: "",
        engine: "qwen3-asr-local",
        durationMs: 1300,
      },
      { wakeWords: ["Neo"], inputSnrDb: 5 },
    );
    expect(qwenPick.engine).toBe("qwen3-asr-dual-raw");
    expect(qwenPick.text).toBe("Neo，打开客厅吸顶灯。");
  });
});

describe("Qwen3-ASR Primary + SenseVoice Reserve Fallback Behavior", () => {
  test("reports unavailable cleanly when neither Qwen3-ASR nor SenseVoice exists", async () => {
    const emptyModelsDir = path.join(tmpDir, "empty_models");
    mkdirSync(emptyModelsDir, { recursive: true });
    const engine = new LocalVoiceEngine({ modelsDir: emptyModelsDir });
    const status = engine.getStatus();

    expect(status.models.qwen3Asr).toBe(false);
    expect(status.models.senseVoice).toBe(false);
    expect(status.readyForQwen3Asr).toBe(false);
    expect(status.readyForSenseVoice).toBe(false);
    expect(status.readyForLocalAsr).toBe(false);
    expect(status.primaryAsrEngine).toBeNull();
    expect(status.fallbackAsrEngine).toBeNull();

    await expect(engine.transcribeLocal(new Float32Array(16000), 16000, "zh-CN")).rejects.toThrow(
      /Qwen3-ASR|SenseVoice/,
    );
    engine.dispose();
  });

  test("falls back automatically to SenseVoice reserve when Qwen3-ASR model is missing", async () => {
    const fallbackModelsDir = path.join(tmpDir, "sv_only_models");
    if (!copySenseVoiceModelTo(fallbackModelsDir) || !HAS_CLIP_001) {
      return;
    }

    const engine = new LocalVoiceEngine({ modelsDir: fallbackModelsDir });
    const status = engine.getStatus();
    expect(status.readyForQwen3Asr).toBe(false);
    expect(status.readyForSenseVoice).toBe(true);
    expect(status.readyForLocalAsr).toBe(true);
    expect(status.primaryAsrEngine).toBe("sensevoice");
    expect(status.fallbackAsrEngine).toBe("sensevoice");

    const pcm = loadClip001Pcm16k();
    const autoRes = await engine.transcribeLocal(pcm, 16000, "zh-CN");
    expect(autoRes.engine).toBe("sensevoice-fallback");
    expect(autoRes.fallbackUsed).toBe(true);
    expect(autoRes.fallbackReason).toBe("qwen3-asr-model-missing");
    expect(autoRes.text).toContain("客厅");

    // Explicit qwen3-asr mode reports clear missing-model error instead of silently ignoring user choice
    await expect(
      engine.transcribeLocal(pcm, 16000, "zh-CN", { engine: "qwen3-asr" }),
    ).rejects.toThrow(/Qwen3-ASR-0\.6B/);

    engine.dispose();
  }, 30_000);

  test("falls back automatically to SenseVoice reserve when Qwen3-ASR fails to initialize at runtime", async () => {
    const corruptModelsDir = path.join(tmpDir, "corrupt_qwen3_models");
    if (!copySenseVoiceModelTo(corruptModelsDir) || !HAS_CLIP_001) {
      return;
    }
    // Create structurally present but corrupted Qwen3-ASR files to trigger runtime init failure
    const qwenDir = path.join(corruptModelsDir, QWEN3_ASR_DIR_NAME);
    const tokDir = path.join(qwenDir, "tokenizer");
    mkdirSync(tokDir, { recursive: true });
    writeFileSync(path.join(tokDir, "vocab.json"), "{}");
    writeFileSync(path.join(qwenDir, "conv_frontend.onnx"), "not-a-valid-onnx");
    writeFileSync(path.join(qwenDir, "encoder.int8.onnx"), "not-a-valid-onnx");
    writeFileSync(path.join(qwenDir, "decoder.int8.onnx"), "not-a-valid-onnx");

    const engine = new LocalVoiceEngine({ modelsDir: corruptModelsDir });
    const pcm = loadClip001Pcm16k();
    const res = await engine.transcribeLocal(pcm, 16000, "zh-CN");
    expect(res.engine).toBe("sensevoice-fallback");
    expect(res.fallbackUsed).toBe(true);
    expect(res.fallbackReason).toContain("qwen3-asr-error");
    expect(res.text).toContain("客厅");

    engine.dispose();
  }, 30_000);
});

describe("Real Qwen3-ASR-0.6B (CPU) Primary & HTTP API Integration", () => {
  test("uses Qwen3-ASR-0.6B on CPU as primary and supports switching to SenseVoice reserve", async () => {
    const engine = new LocalVoiceEngine();
    const status = engine.getStatus();
    if (!status.readyForQwen3Asr || !status.readyForSenseVoice || !HAS_CLIP_001) {
      engine.dispose();
      return;
    }

    expect(status.primaryAsrEngine).toBe("qwen3-asr");
    expect(status.fallbackAsrEngine).toBe("sensevoice");
    expect(status.readyForLocalAsr).toBe(true);

    const pcm = loadClip001Pcm16k();
    const qwenRes = await engine.transcribeLocal(pcm, 16000, "zh-CN", {
      hotwords: ["Neo"],
    });
    expect(qwenRes.engine).toBe("qwen3-asr-local");
    expect(qwenRes.fallbackUsed).toBe(false);
    expect(qwenRes.text).toContain("Neo");
    expect(qwenRes.text).toContain("客厅吸顶灯");

    const svRes = await engine.transcribeLocal(pcm, 16000, "zh-CN", {
      engine: "sensevoice",
    });
    expect(svRes.engine).toBe("sensevoice-local");
    expect(svRes.fallbackUsed).toBe(false);
    expect(svRes.text).toContain("客厅吸顶灯");

    engine.dispose();
  }, 60_000);

  test("exposes localAsrEngine via /api/agent/config, /api/voice/pipeline/status, /api/voice/audio, and settings HTML", async () => {
    const demoService = new VirtualDemoService();
    server = await startMijiaDeckServer({
      mode: "demo",
      port: 0,
      service: demoService,
    });

    // 1. Settings HTML contains both Qwen3-ASR primary & SenseVoice reserve UI controls
    const htmlRes = await fetch(`${server.url}/`);
    expect(htmlRes.ok).toBe(true);
    const html = await htmlRes.text();
    expect(html).toContain('id="badge-model-qwen3-asr"');
    expect(html).toContain('id="badge-model-asr"');
    expect(html).toContain('id="set-voice-local-asr-engine"');

    // 2. Default config & pipeline status
    const statusRes = await fetch(`${server.url}/api/voice/pipeline/status`);
    expect(statusRes.ok).toBe(true);
    const statusJson = (await statusRes.json()) as {
      localEngine: {
        readyForQwen3Asr: boolean;
        readyForSenseVoice: boolean;
        primaryAsrEngine: string | null;
        fallbackAsrEngine: string | null;
        activeLocalAsrMode: string;
      };
      voice: { localAsrEngine: string };
    };
    expect(statusJson.voice.localAsrEngine).toBe("auto");
    expect(statusJson.localEngine.activeLocalAsrMode).toBe("auto");

    // 3. Reject invalid localAsrEngine via HTTP 400
    const badRes = await fetch(`${server.url}/api/agent/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ localAsrEngine: "invalid-asr" }),
    });
    expect(badRes.status).toBe(400);

    // 4. Switch to SenseVoice reserve and back to auto via /api/agent/config
    const svCfgRes = await fetch(`${server.url}/api/agent/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        localAsrEngine: "sensevoice",
        wakeWords: ["Neo"],
        sourceSeparationMode: "off",
      }),
    });
    expect(svCfgRes.ok).toBe(true);
    const svCfgJson = (await svCfgRes.json()) as {
      config: { localAsrEngine: string };
      voice: { localAsrEngine: string; localEngine: { activeLocalAsrMode: string } };
    };
    expect(svCfgJson.config.localAsrEngine).toBe("sensevoice");
    expect(svCfgJson.voice.localAsrEngine).toBe("sensevoice");
    expect(svCfgJson.voice.localEngine.activeLocalAsrMode).toBe("sensevoice");

    // 5. If real models + benchmark WAV exist, verify /api/voice/audio uses SenseVoice when set to sensevoice, and Qwen3-ASR when set to auto
    if (
      statusJson.localEngine.readyForQwen3Asr &&
      statusJson.localEngine.readyForSenseVoice &&
      HAS_CLIP_001
    ) {
      const wavBytes = encodeWavPcm16(loadClip001Pcm16k(), 16000);
      const uploadAudio = async () => {
        const form = new FormData();
        form.append("audio", new Blob([wavBytes as unknown as BlobPart], { type: "audio/wav" }), "clip_001.wav");
        form.append("autoDispatch", "false");
        const r = await fetch(`${server!.url}/api/voice/audio`, { method: "POST", body: form });
        expect(r.ok).toBe(true);
        return (await r.json()) as { text: string; asrEngine: string };
      };

      const svUpload = await uploadAudio();
      expect(svUpload.asrEngine.startsWith("sensevoice")).toBe(true);
      expect(svUpload.text).toContain("客厅吸顶灯");

      const autoCfgRes = await fetch(`${server.url}/api/agent/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ localAsrEngine: "auto" }),
      });
      expect(autoCfgRes.ok).toBe(true);

      const qwenUpload = await uploadAudio();
      expect(qwenUpload.asrEngine.startsWith("qwen3-asr")).toBe(true);
      expect(qwenUpload.text).toContain("Neo");
      expect(qwenUpload.text).toContain("客厅吸顶灯");
    }
  }, 60_000);
});
