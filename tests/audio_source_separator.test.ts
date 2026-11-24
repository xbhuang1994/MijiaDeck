// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 自适应多级并行声源分离与说话人隔离引擎（S_Fused 落地版）单元测试与集成测试

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { decodeWavPcm, encodeWavPcm16, resampleLinear } from "../src/agent/audioPcm.ts";
import { AudioSourceSeparator } from "../src/agent/audioSourceSeparator.ts";
import { LocalVoiceEngine } from "../src/agent/localVoiceEngine.ts";
import { hasSmartHomeDomainIntent, isThirdPersonNeoMention } from "../src/agent/voiceAttentionGate.ts";
import { setDataPathOverrides } from "../src/core/jsonStore.ts";
import { VirtualDemoService } from "../src/core/virtualLightService.ts";
import { startMijiaDeckServer, type MijiaDeckServer } from "../src/server/server.ts";

const BENCH_DIR = path.resolve(import.meta.dir, "../benchmarks/voice_sep_100");
const HAS_BENCH_WAVS = existsSync(path.join(BENCH_DIR, "manifest.json"));

let tmpDir = "";
let server: MijiaDeckServer | null = null;

function loadBenchClip16k(clipId: string): Float32Array {
  const wavPath = path.join(BENCH_DIR, "audio", `${clipId}.wav`);
  const d = decodeWavPcm(readFileSync(wavPath));
  return d.sampleRate === 16000 ? d.samples : resampleLinear(d.samples, d.sampleRate, 16000);
}

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "mijiadeck-sep-test-"));
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

describe("Voice Attention Domain & Third-Person Guardrails", () => {
  test("distinguishes smart-home domain commands from everyday household chat and third-person mentions", () => {
    expect(hasSmartHomeDomainIntent("打开客厅吸顶灯")).toBe(true);
    expect(hasSmartHomeDomainIntent("把空调调到25度")).toBe(true);
    expect(hasSmartHomeDomainIntent("帮我把桌上那杯水递过来")).toBe(false);
    expect(hasSmartHomeDomainIntent("今天晚饭吃什么呀")).toBe(false);

    expect(isThirdPersonNeoMention("别管Neo了，我们先吃饭吧")).toBe(true);
    expect(isThirdPersonNeoMention("别管你用了，先把客厅收拾一下吧")).toBe(true);
    expect(isThirdPersonNeoMention("我刚才跟朋友聊到Neo这个助手挺好用的")).toBe(true);
    expect(isThirdPersonNeoMention("Neo，打开客厅吸顶灯")).toBe(false);
  });
});

describe("AudioSourceSeparator Graceful Degradation", () => {
  test("degrades gracefully when optional separation/tagging/diarization models are absent", () => {
    const emptyModelsDir = path.join(tmpDir, "empty_models");
    const engine = new LocalVoiceEngine({ modelsDir: emptyModelsDir });
    const sep = new AudioSourceSeparator(engine);

    const avail = sep.getModelAvailability();
    expect(avail.cedAudioTagging).toBe(false);
    expect(avail.pyannoteDiarization).toBe(false);
    expect(avail.spleeterSeparation).toBe(false);

    const status = engine.getStatus();
    expect(status.readyForSourceSeparation).toBe(false);

    const dummy = new Float32Array(16000);
    const scene = sep.analyzeAudioScene(dummy);
    expect(scene.detectedSoundTypes).toContain("speech");
    expect(sep.separateMusicStems(dummy)).toBeNull();
    expect(sep.diarizeSpeakers(dummy).segments).toEqual([]);
    expect(sep.extractTargetSpeakerVoxLock(dummy, path.join(tmpDir, "missing.wav"))).toBeNull();

    sep.dispose();
    engine.dispose();
  });
});

describe("AudioSourceSeparator Real ONNX Multi-Source Separation Integration", () => {
  test("separates songs, BGM, ambient noise, overlapping speakers, and enforces zero false positives", async () => {
    const engine = new LocalVoiceEngine();
    const status = engine.getStatus();
    if (!status.readyForSourceSeparation || !HAS_BENCH_WAVS) {
      engine.dispose();
      return;
    }

    await engine.warmup();
    await engine.openWakeWord.bootstrapWakeWords(["Neo"]);
    const sep = engine.sourceSeparator;
    const speakerRefs = [
      { id: "owner", wavPath: path.join(BENCH_DIR, "owner_ref.wav") },
      { id: "family", wavPath: path.join(BENCH_DIR, "family_ref.wav") },
    ];

    // 1. Clean command
    const cleanRes = await sep.separateAndRecognize(loadBenchClip16k("clip_001"), 16000, {
      wakeWords: ["Neo"],
      speakerRefWavPaths: speakerRefs,
    });
    expect(cleanRes.attention.accept).toBe(true);
    expect(cleanRes.attention.command).toContain("客厅");
    expect(cleanRes.detectedSoundTypes).toContain("speech");

    // 2. Third-person negation trap ("别管Neo了，我们先吃饭吧") -> MUST reject
    const negThird = await sep.separateAndRecognize(loadBenchClip16k("clip_010"), 16000, {
      wakeWords: ["Neo"],
      speakerRefWavPaths: speakerRefs,
    });
    expect(negThird.attention.accept).toBe(false);

    // 3. Pure singing song (no user speech) -> MUST reject early and tag song/bgm
    const pureSong = await sep.separateAndRecognize(loadBenchClip16k("clip_026"), 16000, {
      wakeWords: ["Neo"],
      speakerRefWavPaths: speakerRefs,
    });
    expect(pureSong.attention.accept).toBe(false);
    expect(pureSong.detectedSoundTypes).toContain("bgm");

    // 4. Hard song + Neo command (+1dB singing background -> cascaded Spleeter->VoxLock)
    const hardSongCmd = await sep.separateAndRecognize(loadBenchClip16k("clip_019"), 16000, {
      wakeWords: ["Neo"],
      speakerRefWavPaths: speakerRefs,
    });
    expect(hardSongCmd.attention.accept).toBe(true);
    expect(hardSongCmd.attention.command).toContain("空调");
    expect(hardSongCmd.detectedSoundTypes).toContain("bgm");

    // 5. Simultaneous overlapping multi-speaker crosstalk -> VoxLock TSE isolates owner command
    const overlapCmd = await sep.separateAndRecognize(loadBenchClip16k("clip_074"), 16000, {
      wakeWords: ["Neo"],
      speakerRefWavPaths: speakerRefs,
    });
    expect(overlapCmd.attention.accept).toBe(true);
    expect(overlapCmd.attention.command).toContain("台灯");

    // 6. Multi-speaker + singing + "你好" household trap -> MUST reject
    const helloTrap = await sep.separateAndRecognize(loadBenchClip16k("clip_086"), 16000, {
      wakeWords: ["Neo"],
      speakerRefWavPaths: speakerRefs,
    });
    expect(helloTrap.attention.accept).toBe(false);

    engine.dispose();
  }, 60_000);

  test("integrates with MijiaDeck HTTP /api/agent/config & /api/voice/audio with sourceSeparationMode", async () => {
    const demoService = new VirtualDemoService();
    server = await startMijiaDeckServer({
      mode: "demo",
      port: 0,
      service: demoService,
    });

    // Update sourceSeparationMode config via API
    const cfgRes = await fetch(`${server.url}/api/agent/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        wakeWords: ["Neo"],
        sourceSeparationMode: "auto",
      }),
    });
    expect(cfgRes.status).toBe(200);
    const cfgJson = (await cfgRes.json()) as any;
    expect(cfgJson.config.sourceSeparationMode).toBe("auto");

    const statusRes = await fetch(`${server.url}/api/voice/pipeline/status`);
    expect(statusRes.status).toBe(200);
    const statusJson = (await statusRes.json()) as any;
    expect(statusJson.ok).toBe(true);
    expect(typeof statusJson.localEngine.readyForSourceSeparation).toBe("boolean");

    if (statusJson.localEngine.readyForSourceSeparation && HAS_BENCH_WAVS) {
      const wavBytes = encodeWavPcm16(loadBenchClip16k("clip_001"), 16000);
      const form = new FormData();
      form.append("audio", new Blob([wavBytes as unknown as BlobPart], { type: "audio/wav" }), "cmd.wav");
      const res = await fetch(`${server.url}/api/voice/audio`, { method: "POST", body: form });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.ok).toBe(true);
      expect(body.matched).toBe(true);
      expect(body.command).toContain("客厅");
      expect(Array.isArray(body.detectedSoundTypes)).toBe(true);
      expect(body.detectedSpeakerCount).toBeGreaterThanOrEqual(1);
      expect(await demoService.powerState("demo-light-living")).toBe(true);
    }
  }, 30_000);
});
