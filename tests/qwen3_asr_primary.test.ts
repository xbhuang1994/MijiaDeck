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
  type LocalAsrOutput,
  type StreamingVadHandleLike,
} from "../src/agent/localVoiceEngine.ts";
import {
  buildQwen3GpuChatPayload,
  parseLlamaListDevicesOutput,
  parseQwen3GpuResponseText,
  selectBestGpuDevice,
} from "../src/agent/qwen3AsrGpuRuntime.ts";
import {
  endsWithStrongSentencePunct,
  isStandaloneWakePrefix,
  longestCommonStablePrefix,
  Qwen3StreamingHypothesisTracker,
  splitAtClauseBoundary,
  splitStreamingSentences,
  stripCommittedPrefix,
  type StreamingPartialUpdate,
} from "../src/agent/qwen3StreamingTranscriber.ts";
import {
  VoiceStreamSession,
  type VoiceStreamSegmentPayload,
} from "../src/agent/voiceStreamSession.ts";
import {
  defaultAgentVoiceConfig,
  loadAgentVoiceConfig,
  normalizeLocalAsrEngine,
  normalizeQwen3ComputeDevice,
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

describe("Qwen3-ASR GPU Auto-Detection, Compute Device & Streaming Segmentation", () => {
  test("parses llama-server --list-devices and selects discrete GPU over integrated/virtual adapters", () => {
    const sampleOutput = [
      "Available devices:",
      "  Vulkan0: Intel(R) UHD Graphics (16295 MiB, 15527 MiB free)",
      "  Vulkan1: NVIDIA GeForce RTX 3060 Laptop GPU (6009 MiB, 5241 MiB free)",
      "  Vulkan2: Todesk Virtual Display Adapter (128 MiB, 128 MiB free)",
      "  Vulkan3: Microsoft Basic Render Driver (4096 MiB, 4096 MiB free)",
    ].join("\n");

    const devices = parseLlamaListDevicesOutput(sampleOutput);
    expect(devices.length).toBe(2);
    expect(devices[0]!.id).toBe("Vulkan0");
    expect(devices[0]!.isDiscrete).toBe(false);
    expect(devices[1]!.id).toBe("Vulkan1");
    expect(devices[1]!.name).toBe("NVIDIA GeForce RTX 3060 Laptop GPU");
    expect(devices[1]!.isDiscrete).toBe(true);
    expect(devices[1]!.vramTotalMb).toBe(6009);
    expect(devices[1]!.vramFreeMb).toBe(5241);

    const best = selectBestGpuDevice(devices);
    expect(best?.id).toBe("Vulkan1");
    expect(best?.backend).toBe("vulkan");

    // Integrated GPU still selected when no discrete GPU exists
    const igpuOnly = selectBestGpuDevice([devices[0]!]);
    expect(igpuOnly?.id).toBe("Vulkan0");

    // Too-small VRAM or virtual-only devices return null
    expect(
      selectBestGpuDevice([
        {
          id: "Vulkan0",
          backend: "vulkan",
          name: "Tiny GPU",
          vramTotalMb: 512,
          vramFreeMb: 256,
          isDiscrete: true,
        },
      ]),
    ).toBeNull();
    expect(selectBestGpuDevice([])).toBeNull();
  });

  test("builds Qwen3 GPU OpenAI chat payload with hotwords and cleans response tags", () => {
    const payload = buildQwen3GpuChatPayload("UklGRg==", {
      hotwords: ["Neo", "小派"],
      maxTokens: 96,
      stream: true,
    });
    expect(payload.stream).toBe(true);
    expect(payload.max_tokens).toBe(96);
    const msgs = payload.messages as Array<{ role: string; content: unknown }>;
    expect(msgs.length).toBe(2);
    expect(msgs[0]!.role).toBe("system");
    expect(msgs[0]!.content).toBe("Neo 小派");
    expect(msgs[1]!.role).toBe("user");

    expect(
      parseQwen3GpuResponseText("<think>language Chinese</think>language Chinese<asr_text>Neo，打开客厅灯。"),
    ).toBe("Neo，打开客厅灯。");
  });

  test("persists qwen3ComputeDevice and qwen3StreamingEnabled with strict validation", () => {
    const def = defaultAgentVoiceConfig();
    expect(def.qwen3ComputeDevice).toBe("auto");
    expect(def.qwen3StreamingEnabled).toBe(true);

    expect(normalizeQwen3ComputeDevice("gpu")).toBe("gpu");
    expect(normalizeQwen3ComputeDevice("vulkan")).toBe("gpu");
    expect(normalizeQwen3ComputeDevice("cuda")).toBe("gpu");
    expect(normalizeQwen3ComputeDevice("cpu")).toBe("cpu");
    expect(normalizeQwen3ComputeDevice("auto")).toBe("auto");
    expect(normalizeQwen3ComputeDevice("unknown", "auto")).toBe("auto");

    const updated = updateAgentVoiceConfig({
      qwen3ComputeDevice: "cpu",
      qwen3StreamingEnabled: false,
    });
    expect(updated.qwen3ComputeDevice).toBe("cpu");
    expect(updated.qwen3StreamingEnabled).toBe(false);
    expect(loadAgentVoiceConfig().qwen3ComputeDevice).toBe("cpu");
    expect(loadAgentVoiceConfig().qwen3StreamingEnabled).toBe(false);

    const backOn = updateAgentVoiceConfig({
      qwen3ComputeDevice: "vulkan",
      qwen3StreamingEnabled: true,
    });
    expect(backOn.qwen3ComputeDevice).toBe("gpu");
    expect(backOn.qwen3StreamingEnabled).toBe(true);

    expect(() => updateAgentVoiceConfig({ qwen3ComputeDevice: "tpu-999" })).toThrow();
  });

  test("segments bilingual streaming sentences accurately while protecting wake words and decimals", () => {
    // 1. LocalAgreement stable prefix avoids splitting English tokens mid-word
    expect(longestCommonStablePrefix("打开客厅灯。", "打开客厅灯，亮度调到80")).toBe("打开客厅灯");
    expect(longestCommonStablePrefix("Hey Neo turn", "Hey Neo turning off")).toBe("Hey Neo");

    // 2. Wake-word prefix protection: NEVER split "Neo。打开客厅吸顶灯" into two sentences
    expect(isStandaloneWakePrefix("Neo。", ["Neo", "小派"])).toBe(true);
    expect(isStandaloneWakePrefix("嘿Neo！", ["Neo", "小派"])).toBe(true);
    expect(isStandaloneWakePrefix("Neo，打开客厅灯。", ["Neo", "小派"])).toBe(false);

    const wakeSplit = splitStreamingSentences("Neo。打开客厅吸顶灯。", {
      wakeWords: ["Neo", "小派"],
      forceFlush: true,
    });
    expect(wakeSplit.completed).toEqual(["Neo。打开客厅吸顶灯。"]);

    // 3. Multi-sentence Chinese streaming split (mid-utterance & flush)
    const midSplit = splitStreamingSentences("打开客厅吸顶灯。把空调调到25.5度", {
      wakeWords: ["Neo"],
      forceFlush: false,
    });
    expect(midSplit.completed).toEqual(["打开客厅吸顶灯。"]);
    expect(midSplit.remainder).toBe("把空调调到25.5度");

    const decimalFlush = splitStreamingSentences("把空调调到25.5度。关闭餐厅灯。", {
      wakeWords: ["Neo"],
      forceFlush: true,
    });
    expect(decimalFlush.completed).toEqual(["把空调调到25.5度。", "关闭餐厅灯。"]);

    // 4. English multi-sentence split
    const enFlush = splitStreamingSentences("Turn on the desk lamp. Set brightness to 80%!", {
      wakeWords: ["Neo"],
      forceFlush: true,
    });
    expect(enFlush.completed).toEqual(["Turn on the desk lamp.", "Set brightness to 80%!"]);

    // 5. Long run-on utterance without strong punctuation falls back to clause boundary
    const longClause =
      "请把客厅的吸顶灯亮度调到百分之八十，顺便把卧室的空调温度调到二十五度，然后帮我查一下阳台湿度";
    const clauseRes = splitAtClauseBoundary(longClause, 32);
    expect(clauseRes.completed.length).toBe(1);
    expect(clauseRes.completed[0]!.endsWith("，")).toBe(true);
    expect(clauseRes.remainder.length).toBeGreaterThan(0);

    // 6. Prefix deduplication tolerates minor punctuation changes
    expect(stripCommittedPrefix("打开客厅吸顶灯，把空调调到25度。", "打开客厅吸顶灯。")).toBe(
      "把空调调到25度。",
    );
    expect(endsWithStrongSentencePunct("打开客厅灯。")).toBe(true);
    expect(endsWithStrongSentencePunct("温度25.")).toBe(false);
  });

  test("Qwen3StreamingHypothesisTracker keeps whole utterance intact by default and supports opt-in mid-stream split", () => {
    // 1. Default behavior: live partials stream cleanly, NEVER forcibly split on mid-speech punctuation or 320ms pause
    const defaultTracker = new Qwen3StreamingHypothesisTracker({
      wakeWords: ["Neo", "小派"],
      punctuationPauseMs: 320,
    });
    const d1 = defaultTracker.ingestHypothesis("Neo。打开客厅吸顶灯。", {
      engine: "qwen3-asr-gpu-stream",
      latencyMs: 140,
    });
    expect(d1.completedSentences).toEqual([]);
    expect(d1.partial?.text).toBe("Neo。打开客厅吸顶灯。");

    const d2 = defaultTracker.ingestHypothesis("Neo。打开客厅吸顶灯。关闭卧室灯。", {
      engine: "qwen3-asr-gpu-stream",
      latencyMs: 155,
    });
    expect(d2.completedSentences).toEqual([]);
    expect(d2.partial?.text).toBe("Neo。打开客厅吸顶灯。关闭卧室灯。");
    expect(defaultTracker.advanceFrame(400, false).shouldCommitByPunctPause).toBe(false);
    expect(defaultTracker.flush()).toEqual(["Neo。打开客厅吸顶灯。关闭卧室灯。"]);

    // 2. Explicit opt-in split mode still supports mid-stream punctuation splits and fast 320ms punctuation pauses
    const tracker = new Qwen3StreamingHypothesisTracker({
      wakeWords: ["Neo", "小派"],
      punctuationPauseMs: 320,
      splitMidUtterance: true,
      enablePunctuationPauseCommit: true,
    });

    // Standalone wake word should NOT trigger punctuation pause commit
    tracker.ingestHypothesis("Neo。", { engine: "qwen3-asr-gpu-stream", latencyMs: 120 });
    expect(tracker.advanceFrame(400, false).shouldCommitByPunctPause).toBe(false);

    // Command arrives -> mid-stream second sentence triggers immediate split of sentence 1
    const r1 = tracker.ingestHypothesis("Neo。打开客厅吸顶灯。", {
      engine: "qwen3-asr-gpu-stream",
      latencyMs: 140,
    });
    expect(r1.completedSentences).toEqual([]);
    expect(r1.partial?.text).toBe("Neo。打开客厅吸顶灯。");

    const r2 = tracker.ingestHypothesis("Neo。打开客厅吸顶灯。关闭卧室灯", {
      engine: "qwen3-asr-gpu-stream",
      latencyMs: 155,
    });
    expect(r2.completedSentences).toEqual(["Neo。打开客厅吸顶灯。"]);
    expect(r2.commitReason).toBe("punctuation_split");
    expect(r2.partial?.text).toBe("关闭卧室灯");

    // Sentence 2 finishes with punctuation -> 320ms silence triggers fast punctuation_pause commit
    const r3 = tracker.ingestHypothesis("Neo。打开客厅吸顶灯。关闭卧室灯。", {
      engine: "qwen3-asr-gpu-stream",
      latencyMs: 160,
    });
    expect(r3.completedSentences).toEqual([]);
    expect(r3.partial?.text).toBe("关闭卧室灯。");
    expect(tracker.advanceFrame(160, false).shouldCommitByPunctPause).toBe(false);
    expect(tracker.advanceFrame(160, false).shouldCommitByPunctPause).toBe(true);

    // Flush returns only sentence 2 (zero duplicate of sentence 1)
    expect(tracker.flush()).toEqual(["关闭卧室灯。"]);
  });

  test("VoiceStreamSession honors streamingAsrEnabled toggle ON/OFF, emits live partials, and segments cleanly", async () => {
    // Deterministic fake Silero VAD + fake LocalVoiceEngine to test streaming switch & segmentation precisely
    const createMockEngine = (hypotheses: string[]) => {
      let speechFramesLeft = 0;
      let sampleCursor = 0;
      let vadSegs: Array<{ start: number; samples: Float32Array }> = [];
      let segStart = 0;
      let segChunks: Float32Array[] = [];
      let callCount = 0;

      const fakeVad: StreamingVadHandleLike = {
        acceptWaveform(frame: Float32Array) {
          let sumSq = 0;
          for (let i = 0; i < frame.length; i += 1) sumSq += frame[i]! * frame[i]!;
          const rms = Math.sqrt(sumSq / frame.length);
          const isVoice = rms > 0.02;
          if (isVoice) {
            if (speechFramesLeft === 0) {
              segStart = sampleCursor;
              segChunks = [];
            }
            speechFramesLeft = 22; // ~704ms VAD silence hold
            segChunks.push(new Float32Array(frame));
          } else if (speechFramesLeft > 0) {
            speechFramesLeft -= 1;
            segChunks.push(new Float32Array(frame));
            if (speechFramesLeft === 0 && segChunks.length > 0) {
              const total = segChunks.reduce((a, c) => a + c.length, 0);
              const merged = new Float32Array(total);
              let off = 0;
              for (const c of segChunks) {
                merged.set(c, off);
                off += c.length;
              }
              vadSegs.push({ start: segStart, samples: merged });
              segChunks = [];
            }
          }
          sampleCursor += frame.length;
        },
        isEmpty: () => vadSegs.length === 0,
        isDetected: () => speechFramesLeft > 0,
        front: () => vadSegs[0]!,
        pop: () => {
          vadSegs.shift();
        },
        flush: () => {
          if (segChunks.length > 0) {
            const total = segChunks.reduce((a, c) => a + c.length, 0);
            const merged = new Float32Array(total);
            let off = 0;
            for (const c of segChunks) {
              merged.set(c, off);
              off += c.length;
            }
            vadSegs.push({ start: segStart, samples: merged });
            segChunks = [];
            speechFramesLeft = 0;
          }
        },
        reset: () => {
          vadSegs = [];
          segChunks = [];
          speechFramesLeft = 0;
        },
        clear: () => {
          vadSegs = [];
        },
      };

      const fakeEngine = {
        createOnlineDenoiser: () => null,
        createStreamingVad: () => fakeVad,
        createWakeWordStream: () => null,
        getStatus: () => ({
          readyForLocalAsr: true,
          activeQwen3Device: "gpu" as const,
        }),
        transcribeLocal: async (
          _pcm: Float32Array,
          _sr: number,
          _lang: string,
          opts?: { onPartial?: (t: string) => void },
        ): Promise<LocalAsrOutput> => {
          const text = hypotheses[Math.min(callCount, hypotheses.length - 1)]!;
          callCount += 1;
          opts?.onPartial?.(text);
          return {
            text,
            rawText: text,
            lang: "Chinese",
            emotion: "",
            event: "",
            engine: "qwen3-asr-gpu-stream",
            durationMs: 42,
            computeDevice: "gpu",
          };
        },
        getCallCount: () => callCount,
      };
      return fakeEngine;
    };

    const makeTone = (ms: number, amp: number): Float32Array => {
      const n = Math.round((16000 * ms) / 1000);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i += 1) {
        out[i] = amp * Math.sin((2 * Math.PI * 440 * i) / 16000);
      }
      return out;
    };

    // Case A (Default): streamingAsrEnabled = true -> live partials WITHOUT premature mid-utterance splitting!
    const partials: StreamingPartialUpdate[] = [];
    const emitted: VoiceStreamSegmentPayload[] = [];
    const mockOn = createMockEngine([
      "打开客厅吸顶灯",
      "打开客厅吸顶灯。把空调调到25度。",
    ]);
    const sessionOn = new VoiceStreamSession({
      localEngine: mockOn as unknown as LocalVoiceEngine,
      noiseMode: "off",
      bypassWakeWord: true,
      wakeWords: ["Neo"],
      owwEnabled: false,
      streamingAsrEnabled: true,
      streamingPollIntervalMs: 256,
      onPartialTranscript: (ev) => partials.push(ev),
      onSegmentReady: async (seg) => {
        emitted.push(seg);
        return null;
      },
    });

    // Push first 384ms speech -> triggers hypothesis #1 ("打开客厅吸顶灯")
    sessionOn.pushFloat32Samples(makeTone(384, 0.12));
    await Bun.sleep(20);
    // Push next 384ms speech -> triggers hypothesis #2 ("打开客厅吸顶灯。把空调调到25度。") -> MUST NOT split mid-speech!
    sessionOn.pushFloat32Samples(makeTone(384, 0.12));
    await Bun.sleep(20);
    // Push brief 320ms slow-speech pause -> MUST NOT cut early on punctuation pause!
    sessionOn.pushFloat32Samples(makeTone(320, 0));
    await Bun.sleep(20);
    expect(emitted.length).toBe(0);
    // Push remaining silence past VAD hold (~704ms total) -> emits 1 single combined utterance!
    sessionOn.pushFloat32Samples(makeTone(512, 0));
    await sessionOn.waitForIdle();

    expect(partials.length).toBeGreaterThanOrEqual(2);
    expect(emitted.length).toBe(1);
    expect(emitted[0]!.commitReason).toBe("vad_silence");

    // Hot toggle OFF disables speculative streaming cleanly
    sessionOn.setStreamingAsrEnabled(false);
    expect(sessionOn.streamingAsrEnabled).toBe(false);
    sessionOn.dispose();

    // Case A2 (Opt-in legacy split): streamingSentenceSplit = true -> preserves explicit mid-stream splitting
    const emittedSplit: VoiceStreamSegmentPayload[] = [];
    const mockSplit = createMockEngine([
      "打开客厅吸顶灯",
      "打开客厅吸顶灯。把空调调到25度。",
    ]);
    const sessionSplit = new VoiceStreamSession({
      localEngine: mockSplit as unknown as LocalVoiceEngine,
      noiseMode: "off",
      bypassWakeWord: true,
      wakeWords: ["Neo"],
      owwEnabled: false,
      streamingAsrEnabled: true,
      streamingSentenceSplit: true,
      streamingPollIntervalMs: 256,
      streamingPunctuationPauseMs: 256,
      onSegmentReady: async (seg) => {
        emittedSplit.push(seg);
        return null;
      },
    });
    sessionSplit.pushFloat32Samples(makeTone(384, 0.12));
    await Bun.sleep(20);
    sessionSplit.pushFloat32Samples(makeTone(384, 0.12));
    await Bun.sleep(20);
    sessionSplit.pushFloat32Samples(makeTone(320, 0));
    await sessionSplit.waitForIdle();
    expect(emittedSplit.map((s) => s.precomputedTranscript)).toEqual([
      "打开客厅吸顶灯。",
      "把空调调到25度。",
    ]);
    expect(emittedSplit[0]!.commitReason).toBe("punctuation_split");
    expect(emittedSplit[1]!.commitReason).toBe("punctuation_pause");
    sessionSplit.dispose();

    // Case B: streamingAsrEnabled = false -> zero speculative streaming calls, pure batch VAD compatibility
    const partialsOff: StreamingPartialUpdate[] = [];
    const emittedOff: VoiceStreamSegmentPayload[] = [];
    const mockOff = createMockEngine(["打开客厅吸顶灯。"]);
    const sessionOff = new VoiceStreamSession({
      localEngine: mockOff as unknown as LocalVoiceEngine,
      noiseMode: "off",
      bypassWakeWord: true,
      owwEnabled: false,
      streamingAsrEnabled: false,
      streamingPollIntervalMs: 256,
      onPartialTranscript: (ev) => partialsOff.push(ev),
      onSegmentReady: async (seg) => {
        emittedOff.push(seg);
        return null;
      },
    });

    sessionOff.pushFloat32Samples(makeTone(768, 0.12));
    await Bun.sleep(20);
    expect(mockOff.getCallCount()).toBe(0);
    expect(partialsOff.length).toBe(0);
    await sessionOff.flush();
    expect(emittedOff.length).toBe(1);
    expect(emittedOff[0]!.precomputedTranscript).toBeUndefined();
    sessionOff.dispose();
  });
});

describe("Real Qwen3-ASR-0.6B (GPU/CPU) Primary, Streaming & HTTP API Integration", () => {
  test("auto-detects GPU for Qwen3-ASR-0.6B when available, streams SSE partials, and switches cleanly to CPU & SenseVoice", async () => {
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
    const streamedPartials: string[] = [];
    const qwenRes = await engine.transcribeLocal(pcm, 16000, "zh-CN", {
      hotwords: ["Neo"],
      onPartial: (p) => streamedPartials.push(p),
    });

    if (status.readyForQwen3Gpu) {
      expect(status.activeQwen3Device).toBe("gpu");
      expect(status.gpu.detected).toBe(true);
      expect(qwenRes.engine).toBe("qwen3-asr-gpu-stream");
      expect(qwenRes.computeDevice).toBe("gpu");
      expect(streamedPartials.length).toBeGreaterThanOrEqual(2);
    } else {
      expect(status.activeQwen3Device).toBe("cpu");
      expect(qwenRes.engine).toBe("qwen3-asr-stream");
      expect(qwenRes.computeDevice).toBe("cpu");
    }
    expect(qwenRes.fallbackUsed).toBe(false);
    expect(qwenRes.text).toContain("Neo");
    expect(qwenRes.text).toContain("客厅吸顶灯");

    // Explicit CPU mode works even when GPU is present
    const cpuRes = await engine.transcribeLocal(pcm, 16000, "zh-CN", {
      computeDevice: "cpu",
      hotwords: ["Neo"],
    });
    expect(cpuRes.engine).toBe("qwen3-asr-local");
    expect(cpuRes.computeDevice).toBe("cpu");
    expect(cpuRes.text).toContain("客厅吸顶灯");

    const svRes = await engine.transcribeLocal(pcm, 16000, "zh-CN", {
      engine: "sensevoice",
    });
    expect(svRes.engine).toBe("sensevoice-local");
    expect(svRes.fallbackUsed).toBe(false);
    expect(svRes.text).toContain("客厅吸顶灯");

    engine.dispose();
  }, 90_000);

  test("exposes localAsrEngine, GPU device mode, and streaming switch via HTTP API and HTML", async () => {
    const demoService = new VirtualDemoService();
    server = await startMijiaDeckServer({
      mode: "demo",
      port: 0,
      service: demoService,
    });

    // 1. Settings & Drawer HTML contain GPU badge, compute device selector, and streaming toggle controls
    const htmlRes = await fetch(`${server.url}/`);
    expect(htmlRes.ok).toBe(true);
    const html = await htmlRes.text();
    expect(html).toContain('id="badge-model-qwen3-asr"');
    expect(html).toContain('id="badge-model-qwen3-gpu"');
    expect(html).toContain('id="badge-model-asr"');
    expect(html).toContain('id="set-voice-local-asr-engine"');
    expect(html).toContain('id="set-voice-qwen3-device"');
    expect(html).toContain('id="set-voice-qwen3-streaming"');
    expect(html).toContain('id="pi-streaming-toggle-btn"');

    // 2. Default config & pipeline status
    const statusRes = await fetch(`${server.url}/api/voice/pipeline/status`);
    expect(statusRes.ok).toBe(true);
    const statusJson = (await statusRes.json()) as {
      localEngine: {
        readyForQwen3Asr: boolean;
        readyForQwen3Gpu: boolean;
        activeQwen3Device: string | null;
        qwen3ComputeDevice: string;
        gpu: { detected: boolean; deviceName: string | null };
        readyForSenseVoice: boolean;
        primaryAsrEngine: string | null;
        fallbackAsrEngine: string | null;
        activeLocalAsrMode: string;
      };
      voice: {
        localAsrEngine: string;
        qwen3ComputeDevice: string;
        qwen3StreamingEnabled: boolean;
      };
    };
    expect(statusJson.voice.localAsrEngine).toBe("auto");
    expect(statusJson.voice.qwen3ComputeDevice).toBe("auto");
    expect(statusJson.voice.qwen3StreamingEnabled).toBe(true);
    expect(statusJson.localEngine.activeLocalAsrMode).toBe("auto");
    expect(statusJson.localEngine.qwen3ComputeDevice).toBe("auto");

    // 3. Reject invalid localAsrEngine and qwen3ComputeDevice via HTTP 400
    const badRes = await fetch(`${server.url}/api/agent/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ localAsrEngine: "invalid-asr" }),
    });
    expect(badRes.status).toBe(400);

    const badDevRes = await fetch(`${server.url}/api/agent/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ qwen3ComputeDevice: "invalid-gpu" }),
    });
    expect(badDevRes.status).toBe(400);

    // 4. Toggle streaming switch & compute device via /api/agent/config
    const toggleRes = await fetch(`${server.url}/api/agent/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        qwen3StreamingEnabled: false,
        qwen3ComputeDevice: "cpu",
      }),
    });
    expect(toggleRes.ok).toBe(true);
    const toggleJson = (await toggleRes.json()) as {
      config: { qwen3StreamingEnabled: boolean; qwen3ComputeDevice: string };
      voice: {
        qwen3StreamingEnabled: boolean;
        qwen3ComputeDevice: string;
        localEngine: { qwen3ComputeDevice: string; activeQwen3Device: string | null };
      };
    };
    expect(toggleJson.config.qwen3StreamingEnabled).toBe(false);
    expect(toggleJson.config.qwen3ComputeDevice).toBe("cpu");
    expect(toggleJson.voice.qwen3StreamingEnabled).toBe(false);
    expect(toggleJson.voice.localEngine.qwen3ComputeDevice).toBe("cpu");

    // 5. Switch to SenseVoice reserve and back to auto (GPU/CPU) via /api/agent/config
    const svCfgRes = await fetch(`${server.url}/api/agent/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        localAsrEngine: "sensevoice",
        qwen3ComputeDevice: "auto",
        qwen3StreamingEnabled: true,
        wakeWords: ["Neo"],
        sourceSeparationMode: "off",
      }),
    });
    expect(svCfgRes.ok).toBe(true);
    const svCfgJson = (await svCfgRes.json()) as {
      config: { localAsrEngine: string; qwen3StreamingEnabled: boolean };
      voice: { localAsrEngine: string; localEngine: { activeLocalAsrMode: string } };
    };
    expect(svCfgJson.config.localAsrEngine).toBe("sensevoice");
    expect(svCfgJson.config.qwen3StreamingEnabled).toBe(true);
    expect(svCfgJson.voice.localAsrEngine).toBe("sensevoice");
    expect(svCfgJson.voice.localEngine.activeLocalAsrMode).toBe("sensevoice");

    // 6. If real models + benchmark WAV exist, verify /api/voice/audio uses SenseVoice when set to sensevoice, and Qwen3-ASR (GPU/CPU) when set to auto
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
      if (statusJson.localEngine.readyForQwen3Gpu) {
        expect(qwenUpload.asrEngine.startsWith("qwen3-asr-gpu")).toBe(true);
      }
      expect(qwenUpload.text).toContain("Neo");
      expect(qwenUpload.text).toContain("客厅吸顶灯");
    }
  }, 90_000);
});
