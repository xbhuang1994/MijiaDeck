// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: ClearVoice 多轨盲源分离 + 分轨独立降噪/声纹/转写/逻辑判定/后续流程与 UI 展示综合测试

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { decodeWavPcm, encodeWavPcm16, l2Normalize } from "../src/agent/audioPcm.ts";
import {
  alignSeparatedTracksWithPrevTails,
  ClearVoiceMultiTrackAssembler,
  computeNormalizedWaveformCorr,
  pruneInactiveOrDuplicateTracks,
} from "../src/agent/clearVoiceChunker.ts";
import { ClearVoiceGpuRuntime } from "../src/agent/clearVoiceGpuRuntime.ts";
import {
  LocalVoiceEngine,
  type LocalAsrOutput,
  type StreamingVadHandleLike,
} from "../src/agent/localVoiceEngine.ts";
import { PiAgentService } from "../src/agent/piAgentService.ts";
import { VoiceListenerController } from "../src/agent/voiceListenerController.ts";
import {
  VoiceStreamSession,
  type VoiceStreamSegmentPayload,
} from "../src/agent/voiceStreamSession.ts";
import { enrollVoiceprint } from "../src/agent/voiceprintStore.ts";
import { updateAgentVoiceConfig } from "../src/core/agentConfigStore.ts";
import { JobExecutor } from "../src/core/jobs.ts";
import { setDataPathOverrides } from "../src/core/jsonStore.ts";
import * as settingsStore from "../src/core/settingsStore.ts";
import { VirtualDemoService } from "../src/core/virtualLightService.ts";
import { startMijiaDeckServer, type MijiaDeckServer } from "../src/server/server.ts";
import { MainWindowController } from "../src/ui/controllers/mainWindowController.ts";
import { ThemeController } from "../src/ui/theme.ts";

let tmpDir = "";
let server: MijiaDeckServer | null = null;
let mockCvServer: ReturnType<typeof Bun.serve> | null = null;

function makeSine(durationSec: number, sampleRate = 16000, freqHz = 440, amp = 0.25): Float32Array {
  const n = Math.round(durationSec * sampleRate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    out[i] = Math.sin((2 * Math.PI * freqHz * i) / sampleRate) * amp;
  }
  return out;
}

function makeSineSlice(
  startSample: number,
  length: number,
  sampleRate = 16000,
  freqHz = 440,
  amp = 0.25,
): Float32Array {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    out[i] = Math.sin((2 * Math.PI * freqHz * (startSample + i)) / sampleRate) * amp;
  }
  return out;
}

function estimateDominantZeroCrossingHz(samples: Float32Array, sr = 16000): number {
  let crossings = 0;
  for (let i = 1; i < samples.length; i += 1) {
    if ((samples[i - 1]! <= 0 && samples[i]! > 0) || (samples[i - 1]! >= 0 && samples[i]! < 0)) {
      crossings += 1;
    }
  }
  return (crossings / 2) / Math.max(0.01, samples.length / sr);
}

function createEnergyMockVad(threshold = 0.02): StreamingVadHandleLike {
  let detected = false;
  return {
    acceptWaveform(samples: Float32Array) {
      let sum = 0;
      for (let i = 0; i < samples.length; i += 1) {
        const s = samples[i]!;
        sum += s * s;
      }
      detected = Math.sqrt(sum / Math.max(1, samples.length)) >= threshold;
    },
    isEmpty: () => true,
    isDetected: () => detected,
    front: () => ({ start: 0, samples: new Float32Array(0) }),
    pop: () => {},
    flush: () => {},
    reset: () => {
      detected = false;
    },
    clear: () => {
      detected = false;
    },
  };
}

function buildTestController(localEngine: LocalVoiceEngine): {
  controller: VoiceListenerController;
  agent: PiAgentService;
  cleanup: () => Promise<void>;
} {
  const service = new VirtualDemoService();
  const jobs = new JobExecutor();
  const themeCtrl = new ThemeController("dark");
  const mainWindow = new MainWindowController({
    service,
    jobs,
    themeCtrl,
    autoStartTimers: false,
    cacheLoader: () => null,
    cacheSaver: () => {},
  });
  mainWindow.start();
  const agent = new PiAgentService({
    deps: { service, jobs, mainWindow, settingsStore, broadcastState: () => {} },
  });
  const controller = new VoiceListenerController(agent, { localEngine });
  return {
    controller,
    agent,
    cleanup: async () => {
      controller.dispose();
      agent.dispose();
      mainWindow.dispose();
      await jobs.shutdown();
    },
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "mijiadeck-cv-mt-"));
  const dir = tmpDir;
  setDataPathOverrides({ dataDir: () => dir });
});

afterEach(async () => {
  if (server) {
    await server.stop();
    server = null;
  }
  if (mockCvServer) {
    mockCvServer.stop(true);
    mockCvServer = null;
  }
  setDataPathOverrides(null);
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = "";
  }
});

describe("ClearVoice 多轨 PIT 置换对齐、空轨/镜像轨剔除与防混轨装配单元测试", () => {
  test("PIT 置换对齐：跨切片音轨对调时自动纠正回原槽位，绝不把两名说话人混进同一音轨", () => {
    const sr = 16000;
    const lookback = Math.round(sr * 0.3); // 4800
    const prevA = makeSineSlice(0, 16000, sr, 320, 0.25);
    const prevB = makeSineSlice(0, 16000, sr, 870, 0.22);

    // 模拟第 2 片 BSS 输出发生了轨序互换（Slot 0 变成 B，Slot 1 变成 A）
    const nextStart = 16000 - lookback;
    const currA = makeSineSlice(nextStart, lookback + 12000, sr, 320, 0.25);
    const currB = makeSineSlice(nextStart, lookback + 12000, sr, 870, 0.22);

    const aligned = alignSeparatedTracksWithPrevTails([prevA, prevB], [currB, currA], lookback);
    expect(aligned.swapped).toBe(true);
    expect(aligned.permutation).toEqual([1, 0]);
    expect(computeNormalizedWaveformCorr(prevA.subarray(prevA.length - lookback), aligned.aligned[0]!.subarray(0, lookback))).toBeGreaterThan(0.99);
    expect(computeNormalizedWaveformCorr(prevB.subarray(prevB.length - lookback), aligned.aligned[1]!.subarray(0, lookback))).toBeGreaterThan(0.99);
  });

  test("ClearVoiceMultiTrackAssembler 跨切片保持音轨严格独立，绝不混杂成单轨", () => {
    const sr = 16000;
    const lookback = Math.round(sr * 0.3);
    const asm = new ClearVoiceMultiTrackAssembler({ sampleRate: sr, crossfadeMs: 20, lookbackMs: 300 });

    // Slice 0: [0, 16000) -> Track0=320Hz, Track1=870Hz
    const s0A = makeSineSlice(0, 16000, sr, 320, 0.25);
    const s0B = makeSineSlice(0, 16000, sr, 870, 0.22);
    const r0 = asm.appendSeparatedSlice({
      tracksWithContext: [s0A, s0B],
      lookbackSamples: 0,
      newSamples: 16000,
      applyCrossfade: false,
    });
    expect(r0.swapped).toBe(false);

    // Slice 1: [16000-4800, 32000) -> 故意对调为 [TrackB, TrackA]
    const s1A = makeSineSlice(16000 - lookback, lookback + 16000, sr, 320, 0.25);
    const s1B = makeSineSlice(16000 - lookback, lookback + 16000, sr, 870, 0.22);
    const r1 = asm.appendSeparatedSlice({
      tracksWithContext: [s1B, s1A],
      lookbackSamples: lookback,
      newSamples: 16000,
      applyCrossfade: true,
    });
    expect(r1.swapped).toBe(true);
    expect(asm.permutationSwaps).toBe(1);
    expect(asm.crossfadeCount).toBe(1);

    const out = asm.getTracks({ prune: true });
    expect(out.tracks).toHaveLength(2);
    expect(out.tracks[0]!.samples.length).toBe(32000);
    expect(out.tracks[1]!.samples.length).toBe(32000);
    // 校验两条音轨全程保持各自独立频段且几乎正交（绝无串轨混叠）
    expect(estimateDominantZeroCrossingHz(out.tracks[0]!.samples, sr)).toBeCloseTo(320, -1);
    expect(estimateDominantZeroCrossingHz(out.tracks[1]!.samples, sr)).toBeCloseTo(870, -1);
    expect(Math.abs(computeNormalizedWaveformCorr(out.tracks[0]!.samples, out.tracks[1]!.samples))).toBeLessThan(0.05);
  });

  test("pruneInactiveOrDuplicateTracks：单人静音残影/镜像串音轨自动剔除为 1 轨，双人独立声源完整保留 2 轨", () => {
    const tA = makeSine(1.5, 16000, 320, 0.25);
    const tSilent = makeSine(1.5, 16000, 320, 0.001);
    const resSilent = pruneInactiveOrDuplicateTracks([tA, tSilent]);
    expect(resSilent.tracks).toHaveLength(1);
    expect(resSilent.droppedCount).toBe(1);

    // 模拟单人说话在 BSS 中产生的衰减镜像串音（振幅调制相同 + 同相位）
    const speechLike = new Float32Array(24000);
    for (let i = 0; i < speechLike.length; i += 1) {
      const env = i % 6400 < 3200 ? 0.28 : 0.02;
      speechLike[i] = Math.sin((2 * Math.PI * 360 * i) / 16000) * env;
    }
    const bleedMirror = speechLike.map((v) => v * 0.35);
    const resMirror = pruneInactiveOrDuplicateTracks([speechLike, bleedMirror]);
    expect(resMirror.tracks).toHaveLength(1);

    // 真实双人重叠：互不相关 -> 完整保留 2 条独立音轨
    const tB = makeSine(1.5, 16000, 910, 0.22);
    const resTwo = pruneInactiveOrDuplicateTracks([tA, tB]);
    expect(resTwo.tracks).toHaveLength(2);
    expect(resTwo.droppedCount).toBe(0);
  });
});

describe("ClearVoice 多轨全链路独立声纹、独立 ASR、独立逻辑判定与独立后续流程", () => {
  test("双轨并发（主人下指令 + 家人闲聊）：每轨独立声纹/转写/判定，主人轨执行且家人旁白轨独立拒识不误伤对话", async () => {
    updateAgentVoiceConfig({
      voicePipelineMode: "clearvoice",
      wakeWordEnabled: true,
      wakeWords: ["Neo", "小派"],
      voiceprintMode: "tag",
      voiceprintThreshold: 0.42,
      attentionMode: "smart",
      conversationWindowSec: 20,
      maxConsecutiveSidetalk: 3,
      owwEnabled: false,
    });

    const ownerEmb = l2Normalize([1, 0, 0, 0, 0, 0, 0, 0]);
    const familyEmb = l2Normalize([0, 1, 0, 0, 0, 0, 0, 0]);
    enrollVoiceprint({ name: "主人", role: "owner", embedding: ownerEmb, engine: "3dspeaker-campplus" });
    enrollVoiceprint({ name: "家人", role: "member", embedding: familyEmb, engine: "3dspeaker-campplus" });

    // 启动模拟 ClearVoice 多轨 BSS+SE 服务：返回 2 条完全独立音轨（音轨1=320Hz主人, 音轨2=880Hz家人），并在第2片故意对调顺序检验 PIT！
    let sepCallCount = 0;
    let totalEmittedSamples = 0;
    mockCvServer = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const u = new URL(req.url);
        if (u.pathname === "/health") {
          return Response.json({
            ok: true,
            model: "MossFormer2_SE_48K",
            ssReady: true,
            ssModel: "MossFormer2_SS_16K",
            provider: "CUDAExecutionProvider",
            ssProvider: "CUDAExecutionProvider",
            device: "gpu",
            ssDevice: "gpu",
            gpuName: "Mock RTX 3060",
            warmedUp: true,
          });
        }
        if (u.pathname === "/separate") {
          const buf = await req.arrayBuffer();
          const input = new Float32Array(buf);
          const n = input.length;
          const callIdx = sepCallCount++;
          const startPos = callIdx === 0 ? 0 : Math.max(0, totalEmittedSamples - 4800);
          totalEmittedSamples = startPos + n;
          const trackOwner = makeSineSlice(startPos, n, 16000, 320, 0.26);
          const trackFamily = makeSineSlice(startPos, n, 16000, 880, 0.22);
          // 第 2 片故意互换输出顺序以检验 PIT 对齐防混轨
          const outTracks = callIdx % 2 === 1 ? [trackFamily, trackOwner] : [trackOwner, trackFamily];
          const packed = new Float32Array(n * 2);
          packed.set(outTracks[0]!, 0);
          packed.set(outTracks[1]!, n);
          return new Response(new Uint8Array(packed.buffer), {
            status: 200,
            headers: {
              "Content-Type": "application/octet-stream",
              "X-ClearVoice-Track-Count": "2",
              "X-ClearVoice-Samples-Per-Track": String(n),
              "X-ClearVoice-SS-Available": "1",
              "X-ClearVoice-Model": "MossFormer2_SS_16K+MossFormer2_SE_48K",
              "X-ClearVoice-Provider": "CUDAExecutionProvider",
              "X-ClearVoice-Device": "gpu",
              "X-ClearVoice-SS-Ms": "35.0",
              "X-ClearVoice-SE-Ms": "22.0",
              "X-ClearVoice-Infer-Ms": "57.0",
              "X-ClearVoice-Gpu-Name": "Mock RTX 3060",
            },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });

    const cvRuntime = new ClearVoiceGpuRuntime({
      modelsDir: tmpDir,
      serviceUrl: `http://127.0.0.1:${mockCvServer.port}`,
    });

    const vpInputs: number[] = [];
    const asrInputs: number[] = [];
    const fakeEngine = {
      clearVoiceGpu: cvRuntime,
      openWakeWord: {
        isReady: false,
        getStatus: () => ({ ready: false, prototypeCount: 0 }),
        bootstrapWakeWords: async () => ({ synthesized: 0, skipped: 0, wakeWords: [] }),
      },
      sourceSeparator: { warmupAsync: async () => {} },
      tts: {
        getStatus: () => ({ ready: false, addonAvailable: false, readyVoices: [], activeVoice: null }),
        warmup: async () => {},
      },
      setPreferredAsrEngine: () => {},
      setQwen3ComputeDevice: () => {},
      setClearVoiceServiceUrl: () => {},
      createOnlineDenoiser: () => null,
      createStreamingVad: () => createEnergyMockVad(0.02),
      createWakeWordStream: () => null,
      getStatus: () => ({
        readyForLocalAsr: true,
        activeQwen3Device: "gpu",
        readyForClearVoiceGpu: true,
        readyForClearVoiceBss: true,
        clearVoice: cvRuntime.getStatus(),
        readyForVoiceprint: true,
        readyForSourceSeparation: false,
      }),
      detectSpeechSegments: (samples: Float32Array) => ({
        hasSpeech: true,
        speechSamples: samples,
        speechRatio: 0.9,
        segmentCount: 1,
        engine: "silero" as const,
        durationMs: 4,
      }),
      extractSpeakerEmbedding: (samples: Float32Array) => {
        const hz = estimateDominantZeroCrossingHz(samples, 16000);
        vpInputs.push(hz);
        return {
          embedding: hz < 600 ? ownerEmb : familyEmb,
          dim: 8,
          engine: "3dspeaker-campplus" as const,
          durationMs: 12,
        };
      },
      transcribeLocal: async (samples: Float32Array): Promise<LocalAsrOutput> => {
        const hz = estimateDominantZeroCrossingHz(samples, 16000);
        asrInputs.push(hz);
        const text = hz < 600 ? "Neo，打开客厅吸顶灯" : "你晚上想吃米饭还是面条呀";
        return {
          text,
          rawText: text,
          lang: "zh",
          emotion: "",
          event: "",
          engine: "qwen3-asr-gpu",
          durationMs: 65,
          computeDevice: "gpu",
        };
      },
      denoise: (s: Float32Array) => ({
        samples: s,
        sampleRate: 16000,
        engine: "dsp" as const,
        inputSnrDb: 10,
        outputSnrDb: 15,
        snrGainDb: 5,
        durationMs: 2,
      }),
      dispose: () => cvRuntime.dispose(),
    } as unknown as LocalVoiceEngine;

    const { controller, agent, cleanup } = buildTestController(fakeEngine);
    try {
      const capturedSegments: VoiceStreamSegmentPayload[] = [];
      let streamResult: Awaited<ReturnType<VoiceListenerController["processDualTrackSegment"]>> | null = null;

      const session = new VoiceStreamSession({
        localEngine: fakeEngine,
        noiseMode: "auto",
        voicePipelineMode: "clearvoice",
        streamingAsrEnabled: false,
        wakeWords: ["Neo", "小派"],
        onSegmentReady: async (seg) => {
          capturedSegments.push(seg);
          streamResult = await controller.processDualTrackSegment(seg, {
            lang: "zh-CN",
            preferredEngine: "local",
            asyncDispatch: false,
          });
          return streamResult;
        },
      });

      // 连续讲话 2.5s + 0.35s 静音（触发 2 个切片，测试跨切片 PIT 对齐与分轨独立处理）
      session.pushFloat32Samples(makeSine(2.5, 16000, 500, 0.25));
      session.pushFloat32Samples(new Float32Array(Math.round(16000 * 0.35)));
      await session.flush();
      await session.waitForIdle();
      session.dispose();

      expect(capturedSegments).toHaveLength(1);
      const seg = capturedSegments[0]!;
      expect(seg.separatedTracks).toHaveLength(2);
      expect(seg.clearVoiceMeta?.bssUsed).toBe(true);
      expect(seg.clearVoiceMeta?.permutationSwaps).toBe(1);

      // 每条音轨各自做独立声纹识别 & 独立 ASR（2 轨 -> 各调用 2 次，且频段完全隔离无混叠）
      expect(vpInputs).toHaveLength(2);
      expect(asrInputs).toHaveLength(2);
      expect(vpInputs[0]!).toBeLessThan(400);
      expect(vpInputs[1]!).toBeGreaterThan(750);

      expect(streamResult).not.toBeNull();
      expect(streamResult!.tracks).toHaveLength(2);
      const tr1 = streamResult!.tracks![0]!;
      const tr2 = streamResult!.tracks![1]!;

      // 音轨 1：主人声纹 + Neo 开灯指令 -> 独立判定通过并走 Pi Agent 后续流程
      expect(tr1.trackIndex).toBe(1);
      expect(tr1.voiceprint?.speakerName).toBe("主人");
      expect(tr1.text).toBe("Neo，打开客厅吸顶灯");
      expect(tr1.matched).toBe(true);
      expect(tr1.command).toContain("打开客厅吸顶灯");

      // 音轨 2：家人声纹 + 日常闲聊 -> 独立判定拒识，绝不拼入音轨 1 文字，也不误伤主人已进入的对话状态
      expect(tr2.trackIndex).toBe(2);
      expect(tr2.voiceprint?.speakerName).toBe("家人");
      expect(tr2.text).toBe("你晚上想吃米饭还是面条呀");
      expect(tr2.matched).toBe(false);
      expect(tr2.attention?.accept).toBe(false);

      // 主字段 text 绝不混拼双轨文字
      expect(streamResult!.text).toBe("Neo，打开客厅吸顶灯");
      expect(streamResult!.text).not.toContain("米饭");

      // Snapshot 完整保留多轨输出给 UI 分轨展示，且未误增旁白计数
      const snap = controller.snapshot();
      expect(snap.dialogState).toBe("conversation");
      expect(snap.consecutiveSidetalkCount).toBe(0);
      expect(snap.lastTrackBatch?.trackCount).toBe(2);
      expect(snap.lastTrackBatch?.acceptedCount).toBe(1);
      expect(snap.lastTrackBatch?.tracks.map((t) => t.text)).toEqual([
        "Neo，打开客厅吸顶灯",
        "你晚上想吃米饭还是面条呀",
      ]);
      expect(snap.history.filter((h) => h.trackIndex === 1)).toHaveLength(1);
      expect(snap.history.filter((h) => h.trackIndex === 2)).toHaveLength(1);

      // Pi Agent 对话时间线用户消息附带音轨编号与说话人标注
      const userMsgs = agent.snapshot().timeline.filter((e) => e.role === "user");
      expect(userMsgs).toHaveLength(1);
      expect(userMsgs[0]!.trackIndex).toBe(1);
      expect(userMsgs[0]!.trackCount).toBe(2);
      expect(userMsgs[0]!.speakerName).toBe("主人");
    } finally {
      await cleanup();
    }
  });

  test("双轨两条独立指令并发 + 严格声纹门禁分轨独立拦截互不干扰", async () => {
    updateAgentVoiceConfig({
      voicePipelineMode: "clearvoice",
      wakeWordEnabled: false,
      voiceprintMode: "strict",
      voiceprintThreshold: 0.45,
      attentionMode: "smart",
      owwEnabled: false,
    });

    const ownerEmb = l2Normalize([1, 0, 0, 0, 0, 0, 0, 0]);
    const strangerEmb = l2Normalize([0, 0, 1, 0, 0, 0, 0, 0]);
    enrollVoiceprint({ name: "主人", role: "owner", embedding: ownerEmb, engine: "3dspeaker-campplus" });

    const fakeEngine = {
      clearVoiceGpu: new ClearVoiceGpuRuntime({ modelsDir: tmpDir }),
      openWakeWord: { isReady: false, getStatus: () => ({ ready: false, prototypeCount: 0 }) },
      sourceSeparator: { warmupAsync: async () => {} },
      tts: { getStatus: () => ({ ready: false, addonAvailable: false, readyVoices: [], activeVoice: null }) },
      setPreferredAsrEngine: () => {},
      setQwen3ComputeDevice: () => {},
      setClearVoiceServiceUrl: () => {},
      getStatus: () => ({
        readyForLocalAsr: true,
        readyForClearVoiceGpu: true,
        readyForClearVoiceBss: true,
        readyForVoiceprint: true,
        clearVoice: new ClearVoiceGpuRuntime({ modelsDir: tmpDir }).getStatus(),
      }),
      detectSpeechSegments: (samples: Float32Array) => ({
        hasSpeech: true,
        speechSamples: samples,
        speechRatio: 0.9,
        segmentCount: 1,
        engine: "silero" as const,
        durationMs: 3,
      }),
      extractSpeakerEmbedding: (samples: Float32Array) => {
        const hz = estimateDominantZeroCrossingHz(samples, 16000);
        return {
          embedding: hz < 600 ? ownerEmb : strangerEmb,
          dim: 8,
          engine: "3dspeaker-campplus" as const,
          durationMs: 10,
        };
      },
      transcribeLocal: async (samples: Float32Array): Promise<LocalAsrOutput> => {
        const hz = estimateDominantZeroCrossingHz(samples, 16000);
        const text = hz < 600 ? "打开客厅吸顶灯" : "关闭卧室所有灯";
        return {
          text,
          rawText: text,
          lang: "zh",
          emotion: "",
          event: "",
          engine: "qwen3-asr-gpu",
          durationMs: 40,
        };
      },
      dispose: () => {},
    } as unknown as LocalVoiceEngine;

    const { controller, agent, cleanup } = buildTestController(fakeEngine);
    try {
      const res = await controller.processClearVoiceSeparatedTracks(
        [
          { trackId: "cv_track_1", trackIndex: 1, samples: makeSine(1.2, 16000, 320, 0.25), energyRatio: 0.55 },
          { trackId: "cv_track_2", trackIndex: 2, samples: makeSine(1.2, 16000, 900, 0.22), energyRatio: 0.45 },
        ],
        {
          denoiseEngine: "clearvoice-mossformer2-bss-se-gpu",
          bssUsed: true,
          inputSnrDb: 8,
          denoiseMs: 60,
          rawDurationMs: 1200,
          preVadSegmented: false,
        },
        {
          lang: "zh-CN",
          bypassWakeWord: false,
          autoDispatch: true,
          useLocal: true,
          asyncDispatch: false,
        },
      );

      // 音轨 1（主人）放行并执行；音轨 2（未注册陌生人）在严格声纹门禁下独立拦截，绝不执行！
      expect(res.tracks).toHaveLength(2);
      expect(res.tracks![0]!.matched).toBe(true);
      expect(res.tracks![0]!.voiceprint?.matched).toBe(true);
      expect(res.tracks![1]!.matched).toBe(false);
      expect(res.tracks![1]!.attention?.stage).toBe("voiceprint");
      expect(agent.snapshot().timeline.filter((e) => e.role === "user")).toHaveLength(1);

      // 若关闭严格声纹拦截（tag 模式），双轨两条不同有效指令应各自独立走完整执行流程！
      updateAgentVoiceConfig({ voiceprintMode: "tag" });
      const resBoth = await controller.processClearVoiceSeparatedTracks(
        [
          { trackId: "cv_track_1", trackIndex: 1, samples: makeSine(1.2, 16000, 320, 0.25), energyRatio: 0.52 },
          { trackId: "cv_track_2", trackIndex: 2, samples: makeSine(1.2, 16000, 900, 0.22), energyRatio: 0.48 },
        ],
        {
          denoiseEngine: "clearvoice-mossformer2-bss-se-gpu",
          bssUsed: true,
          inputSnrDb: 10,
          denoiseMs: 55,
          rawDurationMs: 1200,
          preVadSegmented: false,
        },
        {
          lang: "zh-CN",
          bypassWakeWord: true,
          autoDispatch: true,
          useLocal: true,
          asyncDispatch: false,
          now: Date.now() + 5000,
        },
      );
      expect(resBoth.tracks).toHaveLength(2);
      expect(resBoth.tracks![0]!.matched).toBe(true);
      expect(resBoth.tracks![1]!.matched).toBe(true);
      expect(resBoth.trackBatch?.acceptedCount).toBe(2);
      const allUsers = agent.snapshot().timeline.filter((e) => e.role === "user");
      expect(allUsers.length).toBe(3); // 上一轮 1 条 + 本轮双轨 2 条独立执行
    } finally {
      await cleanup();
    }
  });

  test("HTTP 页面与状态 API 正确暴露多轨输出面板 DOM 与 BSS 状态字段", async () => {
    server = await startMijiaDeckServer({
      mode: "demo",
      port: 0,
      hostname: "127.0.0.1",
      service: new VirtualDemoService(),
    });

    const html = await (await fetch(`${server.url}/`)).text();
    expect(html).toContain("pi-voice-tracks-panel");
    expect(html).toContain("pi-tracks-list");
    expect(html).toContain("badge-model-clearvoice-ss");

    const stateJson = (await (await fetch(`${server.url}/api/voice-listen/state`)).json()) as {
      voice: {
        lastTrackBatch: unknown;
        recentTrackBatches: unknown[];
        localEngine: { clearVoice: { ssModelName: string; multiTrackReady: boolean } };
      };
    };
    expect(stateJson.voice.lastTrackBatch).toBeNull();
    expect(Array.isArray(stateJson.voice.recentTrackBatches)).toBe(true);
    expect(stateJson.voice.localEngine.clearVoice.ssModelName).toBe("MossFormer2_SS_16K");
  });
});

// ---------------------------------------------------------------------------
// 真实硬件 GPU 端到端实测：ClearVoice (MossFormer2_SS_16K + MossFormer2_SE_48K CUDA)
// -> 分轨独立 3D-Speaker CAM++ 声纹 + 本地 ASR + 独立逻辑判定（本机模型就绪时自动运行）
// ---------------------------------------------------------------------------

const REAL_MODELS_DIR = process.env.MIJIADECK_VOICE_MODELS_DIR || "";
const REAL_OVERLAP_WAV = path.resolve(import.meta.dir, "../benchmarks/voice_sep_100/audio/clip_075.wav");
const REAL_SINGLE_WAV = path.resolve(import.meta.dir, "../benchmarks/voice_sep_100/audio/clip_001.wav");
const REAL_OWNER_REF = path.resolve(import.meta.dir, "../benchmarks/voice_sep_100/owner_ref.wav");
const REAL_FAMILY_REF = path.resolve(import.meta.dir, "../benchmarks/voice_sep_100/family_ref.wav");

describe("真实 GPU ClearVoice (MossFormer2_SS_16K + SE_48K) 多轨端到端验证", () => {
  test(
    "真实双人高强度重叠录音 clip_075 盲源分离为 2 轨并独立完成声纹/转写/判定；单人录音 clip_001 自动保留 1 轨",
    async () => {
      const engine = new LocalVoiceEngine({
        ...(REAL_MODELS_DIR ? { modelsDir: REAL_MODELS_DIR } : {}),
        qwen3ComputeDevice: "cpu",
      });
      const st = engine.getStatus();
      if (
        !st.readyForClearVoiceGpu ||
        !st.readyForClearVoiceBss ||
        !st.readyForLocalAsr ||
        !existsSync(REAL_OVERLAP_WAV) ||
        !existsSync(REAL_SINGLE_WAV) ||
        !existsSync(REAL_OWNER_REF) ||
        !existsSync(REAL_FAMILY_REF)
      ) {
        engine.dispose();
        return;
      }

      updateAgentVoiceConfig({
        voicePipelineMode: "clearvoice",
        localAsrEngine: "sensevoice",
        wakeWordEnabled: true,
        wakeWords: ["Neo", "nil", "neil", "小派"],
        voiceprintMode: "tag",
        voiceprintThreshold: 0.42,
        attentionMode: "smart",
        owwEnabled: false,
      });

      const ownerRef = decodeWavPcm(new Uint8Array(readFileSync(REAL_OWNER_REF)));
      const familyRef = decodeWavPcm(new Uint8Array(readFileSync(REAL_FAMILY_REF)));
      const ownerEmb = engine.extractSpeakerEmbedding(ownerRef.samples, ownerRef.sampleRate);
      const familyEmb = engine.extractSpeakerEmbedding(familyRef.samples, familyRef.sampleRate);
      enrollVoiceprint({ name: "主人", role: "owner", embedding: ownerEmb.embedding, engine: ownerEmb.engine });
      enrollVoiceprint({ name: "家人", role: "member", embedding: familyEmb.embedding, engine: familyEmb.engine });

      const { controller, cleanup } = buildTestController(engine);
      try {
        // 1. 真实双人高强度重叠语音（主人: "Neo，把小米音响音量调到30" + 家人: "明天开会的材料我都整理好发到群里了你记得看一下"）
        const overlapBlob = new Blob([readFileSync(REAL_OVERLAP_WAV)], { type: "audio/wav" });
        const overlapRes = await controller.processAudioUpload(overlapBlob, {
          filename: "clip_075.wav",
          lang: "zh-CN",
          autoDispatch: true,
          preferredEngine: "local",
          asyncDispatch: false,
        });

        expect(overlapRes.tracks).toBeDefined();
        expect(overlapRes.tracks!.length).toBe(2);
        expect(overlapRes.trackBatch?.bssUsed).toBe(true);

        const ownerTrack = overlapRes.tracks!.find((t) => t.voiceprint?.speakerName === "主人");
        const bystanderTrack = overlapRes.tracks!.find((t) => t.trackId !== ownerTrack?.trackId);
        expect(ownerTrack).toBeDefined();
        expect(bystanderTrack).toBeDefined();
        expect(ownerTrack!.text).toMatch(/音量|音响|音箱|30/);
        expect(ownerTrack!.matched).toBe(true);
        expect(bystanderTrack!.text).toMatch(/开会|材料|群里|整理/);
        expect(bystanderTrack!.matched).toBe(false);

        // 2. 真实单人语音 clip_001 -> 自动过滤空轨/镜像残影轨，干净保留 1 轨
        const singleBlob = new Blob([readFileSync(REAL_SINGLE_WAV)], { type: "audio/wav" });
        const singleRes = await controller.processAudioUpload(singleBlob, {
          filename: "clip_001.wav",
          lang: "zh-CN",
          autoDispatch: false,
          preferredEngine: "local",
        });
        expect(singleRes.tracks).toBeDefined();
        expect(singleRes.tracks!.length).toBe(1);
        expect(singleRes.tracks![0]!.text).toMatch(/客厅|吸顶灯|打开/);
      } finally {
        await cleanup();
      }
    },
    180_000,
  );
});
