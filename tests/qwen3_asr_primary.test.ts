// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 在线 Qwen3-ASR-0.6B (主方案) + 本地 SenseVoice (备用/储备方案) 单元测试与集成测试

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { decodeWavPcm, encodeWavPcm16, resampleLinear } from "../src/agent/audioPcm.ts";
import {
  chooseBestAsrCandidate,
  cleanQwen3AsrText,
  LocalVoiceEngine,
  mapQwen3AsrLang,
  resolveVoiceModelPaths,
  SENSE_VOICE_DIR_NAME,
  type LocalAsrOutput,
  type StreamingVadHandleLike,
} from "../src/agent/localVoiceEngine.ts";
import { parseQwen3GpuResponseText } from "../src/agent/qwen3AsrGpuRuntime.ts";
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
        engine: "qwen3-asr-remote",
        durationMs: 1400,
      },
      {
        text: "打开吸顶灯",
        rawText: "打开吸顶灯",
        lang: "",
        emotion: "",
        event: "",
        engine: "qwen3-asr-remote",
        durationMs: 1300,
      },
      { wakeWords: ["Neo"], inputSnrDb: 5 },
    );
    expect(qwenPick.engine).toBe("qwen3-asr-remote-dual-raw");
    expect(qwenPick.text).toBe("Neo，打开客厅吸顶灯。");
  });
});

describe("Qwen3-ASR Online Primary + SenseVoice Reserve Fallback Behavior", () => {
  test("reports unavailable cleanly when neither online Qwen3-ASR nor local SenseVoice is ready", async () => {
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

  test("falls back automatically to SenseVoice reserve when online Qwen3-ASR is not configured", async () => {
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
    expect(autoRes.fallbackReason).toBe("qwen3-asr-remote-unconfigured");
    expect(autoRes.text).toContain("客厅");

    // Explicit qwen3-asr mode reports clear online-only error instead of silently ignoring user choice
    await expect(
      engine.transcribeLocal(pcm, 16000, "zh-CN", { engine: "qwen3-asr" }),
    ).rejects.toThrow(/Qwen3-ASR-0\.6B/);

    engine.dispose();
  }, 30_000);

  test("falls back automatically to SenseVoice reserve when online Qwen3-ASR gateway errors", async () => {
    const fallbackModelsDir = path.join(tmpDir, "remote_err_qwen3_models");
    if (!copySenseVoiceModelTo(fallbackModelsDir) || !HAS_CLIP_001) {
      return;
    }

    const failingGateway = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        return Response.json({ detail: "upstream unavailable" }, { status: 503 });
      },
    });
    const engine = new LocalVoiceEngine({ modelsDir: fallbackModelsDir });
    try {
      engine.setQwen3AsrRemoteConfig({
        serviceUrl: `http://127.0.0.1:${failingGateway.port}`,
      });
      const pcm = loadClip001Pcm16k();
      const res = await engine.transcribeLocal(pcm, 16000, "zh-CN");
      expect(res.engine).toBe("sensevoice-fallback");
      expect(res.fallbackUsed).toBe(true);
      expect(res.fallbackReason).toContain("qwen3-asr-error");
      expect(res.text).toContain("客厅");
    } finally {
      engine.dispose();
      failingGateway.stop(true);
    }
  }, 30_000);
});

describe("Qwen3-ASR Online Response Cleaning & Streaming Segmentation", () => {
  test("cleans Qwen3 response tags and persists qwen3StreamingEnabled", () => {
    expect(
      parseQwen3GpuResponseText("<think>language Chinese</think>language Chinese<asr_text>Neo，打开客厅灯。"),
    ).toBe("Neo，打开客厅灯。");

    const def = defaultAgentVoiceConfig();
    expect(def.qwen3StreamingEnabled).toBe(true);

    const updated = updateAgentVoiceConfig({ qwen3StreamingEnabled: false });
    expect(updated.qwen3StreamingEnabled).toBe(false);
    expect(loadAgentVoiceConfig().qwen3StreamingEnabled).toBe(false);

    const backOn = updateAgentVoiceConfig({ qwen3StreamingEnabled: true });
    expect(backOn.qwen3StreamingEnabled).toBe(true);
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
      engine: "qwen3-asr-remote-stream",
      latencyMs: 140,
    });
    expect(d1.completedSentences).toEqual([]);
    expect(d1.partial?.text).toBe("Neo。打开客厅吸顶灯。");

    const d2 = defaultTracker.ingestHypothesis("Neo。打开客厅吸顶灯。关闭卧室灯。", {
      engine: "qwen3-asr-remote-stream",
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
    tracker.ingestHypothesis("Neo。", { engine: "qwen3-asr-remote-stream", latencyMs: 120 });
    expect(tracker.advanceFrame(400, false).shouldCommitByPunctPause).toBe(false);

    // Command arrives -> mid-stream second sentence triggers immediate split of sentence 1
    const r1 = tracker.ingestHypothesis("Neo。打开客厅吸顶灯。", {
      engine: "qwen3-asr-remote-stream",
      latencyMs: 140,
    });
    expect(r1.completedSentences).toEqual([]);
    expect(r1.partial?.text).toBe("Neo。打开客厅吸顶灯。");

    const r2 = tracker.ingestHypothesis("Neo。打开客厅吸顶灯。关闭卧室灯", {
      engine: "qwen3-asr-remote-stream",
      latencyMs: 155,
    });
    expect(r2.completedSentences).toEqual(["Neo。打开客厅吸顶灯。"]);
    expect(r2.commitReason).toBe("punctuation_split");
    expect(r2.partial?.text).toBe("关闭卧室灯");

    // Sentence 2 finishes with punctuation -> 320ms silence triggers fast punctuation_pause commit
    const r3 = tracker.ingestHypothesis("Neo。打开客厅吸顶灯。关闭卧室灯。", {
      engine: "qwen3-asr-remote-stream",
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
          activeQwen3Device: "remote" as const,
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
            engine: "qwen3-asr-remote-stream",
            durationMs: 42,
            computeDevice: "remote",
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

describe("Online Qwen3-ASR Primary, SenseVoice Reserve & HTTP API Integration", () => {
  test("uses online Qwen3-ASR gateway as primary when configured and switches cleanly to local SenseVoice reserve", async () => {
    const authHeaders: string[] = [];
    const mockQwenGateway = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url);
        authHeaders.push(req.headers.get("authorization") ?? "");
        if (url.pathname === "/health") {
          return Response.json({ status: "ok", device: "remote-gpu", model: "qwen3-asr-online" });
        }
        if (url.pathname === "/v1/audio/transcriptions") {
          const form = await req.formData();
          const file = form.get("file");
          if (!(file instanceof Blob) || file.size < 44) {
            return Response.json({ error: "missing audio file" }, { status: 400 });
          }
          return Response.json({
            text: "Neo，打开客厅吸顶灯",
            language: "zh",
          });
        }
        return new Response("not found", { status: 404 });
      },
    });

    const engine = new LocalVoiceEngine();
    engine.setQwen3AsrRemoteConfig({
      serviceUrl: `http://127.0.0.1:${mockQwenGateway.port}`,
      apiKey: "test-online-token",
    });

    try {
      const status = engine.getStatus();
      expect(status.readyForQwen3Asr).toBe(true);
      expect(status.readyForQwen3Gpu).toBe(true);
      expect(status.activeQwen3Device).toBe("remote");
      expect(status.primaryAsrEngine).toBe("qwen3-asr");
      expect(status.readyForLocalAsr).toBe(true);

      const pcm = HAS_CLIP_001
        ? loadClip001Pcm16k()
        : new Float32Array(16000).map((_, i) => 0.2 * Math.sin((2 * Math.PI * 440 * i) / 16000));

      const qwenRes = await engine.transcribeLocal(pcm, 16000, "zh-CN", {
        hotwords: ["Neo"],
      });
      expect(qwenRes.engine).toBe("qwen3-asr-remote");
      expect(qwenRes.computeDevice).toBe("remote");
      expect(qwenRes.fallbackUsed).toBe(false);
      expect(qwenRes.text).toContain("Neo");
      expect(qwenRes.text).toContain("客厅吸顶灯");
      expect(authHeaders.some((h) => h === "Bearer test-online-token")).toBe(true);

      if (status.readyForSenseVoice && HAS_CLIP_001) {
        const svRes = await engine.transcribeLocal(pcm, 16000, "zh-CN", {
          engine: "sensevoice",
        });
        expect(svRes.engine).toBe("sensevoice-local");
        expect(svRes.fallbackUsed).toBe(false);
        expect(svRes.text).toContain("客厅吸顶灯");
      }
    } finally {
      engine.dispose();
      mockQwenGateway.stop(true);
    }
  }, 30_000);

  test("exposes online Qwen3-ASR gateway, localAsrEngine, and streaming switch via HTTP API and HTML (with local GPU device selector removed)", async () => {
    const mockQwenGateway = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/health") {
          return Response.json({ status: "ok", device: "remote-gpu", model: "qwen3-asr-online" });
        }
        if (url.pathname === "/v1/audio/transcriptions") {
          return Response.json({
            text: "Neo，打开客厅吸顶灯",
            language: "zh",
          });
        }
        return new Response("not found", { status: 404 });
      },
    });

    try {
      const demoService = new VirtualDemoService();
      server = await startMijiaDeckServer({
        mode: "demo",
        port: 0,
        service: demoService,
      });

      // 1. Settings & Drawer HTML contain online gateway + ASR controls and exclude removed local Qwen3 device controls
      const htmlRes = await fetch(`${server.url}/`);
      expect(htmlRes.ok).toBe(true);
      const html = await htmlRes.text();
      expect(html).toContain('id="badge-model-qwen3-asr"');
      expect(html).toContain('id="badge-model-asr"');
      expect(html).toContain('id="set-voice-local-asr-engine"');
      expect(html).toContain('id="set-voice-qwen3-streaming"');
      expect(html).toContain('id="pi-streaming-toggle-btn"');
      expect(html).toContain('id="set-qwen3-asr-service-url"');
      expect(html).not.toContain('id="badge-model-qwen3-gpu"');
      expect(html).not.toContain('id="set-voice-qwen3-device"');
      expect(html).not.toContain('id="setting-row-qwen3-device"');

      // 2. Default config & pipeline status (unconfigured online gateway -> activeQwen3Device is null)
      const statusRes = await fetch(`${server.url}/api/voice/pipeline/status`);
      expect(statusRes.ok).toBe(true);
      const statusJson = (await statusRes.json()) as {
        localEngine: {
          readyForQwen3Asr: boolean;
          readyForQwen3Gpu: boolean;
          activeQwen3Device: string | null;
          gpu: { detected: boolean; deviceName: string | null; remoteConfigured: boolean };
          readyForSenseVoice: boolean;
          primaryAsrEngine: string | null;
          fallbackAsrEngine: string | null;
          activeLocalAsrMode: string;
        };
        voice: {
          localAsrEngine: string;
          qwen3StreamingEnabled: boolean;
        };
      };
      expect(statusJson.voice.localAsrEngine).toBe("auto");
      expect(statusJson.voice.qwen3StreamingEnabled).toBe(true);
      expect(statusJson.localEngine.activeLocalAsrMode).toBe("auto");
      expect(statusJson.localEngine.readyForQwen3Asr).toBe(false);
      expect(statusJson.localEngine.activeQwen3Device).toBeNull();

      // 3. Reject invalid localAsrEngine via HTTP 400
      const badRes = await fetch(`${server.url}/api/agent/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ localAsrEngine: "invalid-asr" }),
      });
      expect(badRes.status).toBe(400);

      // 4. Toggle streaming switch & configure online Qwen3-ASR gateway via /api/agent/config
      const toggleRes = await fetch(`${server.url}/api/agent/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          qwen3StreamingEnabled: false,
          qwen3AsrServiceUrl: `http://127.0.0.1:${mockQwenGateway.port}`,
          qwen3AsrApiKey: "mock-online-key",
        }),
      });
      expect(toggleRes.ok).toBe(true);
      const toggleJson = (await toggleRes.json()) as {
        config: { qwen3StreamingEnabled: boolean; qwen3AsrServiceUrl: string };
        voice: {
          qwen3StreamingEnabled: boolean;
          localEngine: { readyForQwen3Asr: boolean; activeQwen3Device: string | null };
        };
      };
      expect(toggleJson.config.qwen3StreamingEnabled).toBe(false);
      expect(toggleJson.config.qwen3AsrServiceUrl).toBe(`http://127.0.0.1:${mockQwenGateway.port}`);
      expect(toggleJson.voice.qwen3StreamingEnabled).toBe(false);
      expect(toggleJson.voice.localEngine.readyForQwen3Asr).toBe(true);
      expect(toggleJson.voice.localEngine.activeQwen3Device).toBe("remote");

      // 5. Switch to SenseVoice reserve and back to auto via /api/agent/config
      const svCfgRes = await fetch(`${server.url}/api/agent/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          localAsrEngine: "sensevoice",
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

      // 6. Verify /api/voice/audio routes through online Qwen3-ASR when localAsrEngine=auto
      const autoCfgRes = await fetch(`${server.url}/api/agent/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ localAsrEngine: "auto", owwEnabled: false }),
      });
      expect(autoCfgRes.ok).toBe(true);

      const pcm = HAS_CLIP_001
        ? loadClip001Pcm16k()
        : new Float32Array(16000).map((_, i) => 0.25 * Math.sin((2 * Math.PI * 440 * i) / 16000));
      const wavBytes = encodeWavPcm16(pcm, 16000);
      const form = new FormData();
      form.append("audio", new Blob([wavBytes as unknown as BlobPart], { type: "audio/wav" }), "test.wav");
      form.append("autoDispatch", "false");
      form.append("bypassWakeWord", "true");
      const uploadRes = await fetch(`${server.url}/api/voice/audio`, { method: "POST", body: form });
      expect(uploadRes.ok).toBe(true);
      const qwenUpload = (await uploadRes.json()) as { text: string; asrEngine: string };
      expect(qwenUpload.asrEngine.startsWith("qwen3-asr-remote")).toBe(true);
      expect(qwenUpload.text).toContain("Neo");
      expect(qwenUpload.text).toContain("客厅吸顶灯");
    } finally {
      mockQwenGateway.stop(true);
    }
  }, 30_000);
});
