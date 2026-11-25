// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 多轨场景下“音轨 1 说完真实命令，音轨 2（电视）持续发声阻塞音轨 1 执行”全链路回归测试

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { decodeWavPcm, l2Normalize } from "../src/agent/audioPcm.ts";
import {
  alignSeparatedTracksWithPrevTails,
  ClearVoiceMultiTrackEndpointTracker,
  computeNormalizedWaveformCorr,
  pruneInactiveOrDuplicateTracks,
} from "../src/agent/clearVoiceChunker.ts";
import { ClearVoiceGpuRuntime } from "../src/agent/clearVoiceGpuRuntime.ts";
import {
  LocalVoiceEngine,
  type LocalAsrOutput,
  type StreamingVadHandleLike,
} from "../src/agent/localVoiceEngine.ts";
import type { WakeWordAcousticHit } from "../src/agent/openWakeWordEngine.ts";
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
import { MainWindowController } from "../src/ui/controllers/mainWindowController.ts";
import { ThemeController } from "../src/ui/theme.ts";

const SR = 16000;
let tmpDir = "";
let mockCvServer: ReturnType<typeof Bun.serve> | null = null;

function makeSineSlice(
  startSample: number,
  length: number,
  sampleRate = SR,
  freqHz = 320,
  amp = 0.24,
): Float32Array {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    out[i] = Math.sin((2 * Math.PI * freqHz * (startSample + i)) / sampleRate) * amp;
  }
  return out;
}

function makeSegmentedTrack(
  totalSec: number,
  intervals: Array<[number, number]>,
  freqHz: number,
  amp = 0.24,
  sr = SR,
): Float32Array {
  const total = Math.round(totalSec * sr);
  const out = new Float32Array(total);
  for (const [s0, s1] of intervals) {
    const i0 = Math.max(0, Math.round(s0 * sr));
    const i1 = Math.min(total, Math.round(s1 * sr));
    for (let i = i0; i < i1; i += 1) {
      // 加入缓慢振幅包络，更接近真实语流
      const env = 0.78 + 0.22 * Math.sin((2 * Math.PI * 5 * i) / sr);
      out[i] = Math.sin((2 * Math.PI * freqHz * i) / sr) * amp * env;
    }
  }
  return out;
}

function makeAsrOut(text: string, durationMs = 5): LocalAsrOutput {
  return {
    text,
    rawText: text,
    lang: "zh",
    emotion: "",
    event: "",
    engine: "qwen3-asr-local",
    durationMs,
  };
}

function estimateDominantZeroCrossingHz(samples: Float32Array, sr = SR): number {
  // 仅在有声帧计算过零频率，避免静音尾段拉低估计值
  const win = 320;
  let crossings = 0;
  let activeSamples = 0;
  for (let off = 0; off + win <= samples.length; off += win) {
    let sq = 0;
    for (let i = 0; i < win; i += 1) {
      const s = samples[off + i]!;
      sq += s * s;
    }
    if (Math.sqrt(sq / win) < 0.015) continue;
    activeSamples += win;
    for (let i = 1; i < win; i += 1) {
      const a = samples[off + i - 1]!;
      const b = samples[off + i]!;
      if ((a <= 0 && b > 0) || (a >= 0 && b < 0)) {
        crossings += 1;
      }
    }
  }
  if (activeSamples < win) return 0;
  return (crossings / 2) / (activeSamples / sr);
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

/**
 * 启动确定性模拟 ClearVoice BSS 服务器：按全局时间线精确分离两条已知波形（并可配置按切片故意对调 PIT 顺序）。
 * 利用输入片段尾部与混合参考信号互相关自动定位时间游标，保证任意长度/自适应步进切片均严丝合缝！
 */
function startTimelineMockBssServer(options: {
  slot0Timeline: Float32Array;
  slot1Timeline: Float32Array;
  swapOnCall?: (callIdx: number) => boolean;
}): { server: ReturnType<typeof Bun.serve>; getCallCount: () => number } {
  const { slot0Timeline, slot1Timeline, swapOnCall } = options;
  const totalLen = Math.max(slot0Timeline.length, slot1Timeline.length);
  const mixTimeline = new Float32Array(totalLen);
  for (let i = 0; i < totalLen; i += 1) {
    mixTimeline[i] = (slot0Timeline[i] ?? 0) + (slot1Timeline[i] ?? 0);
  }
  let callCount = 0;
  let lastEndPos = 0;

  const findBestStart = (input: Float32Array): number => {
    const n = input.length;
    // 在预期位置 [max(0, lastEndPos - 6400), min(totalLen - n, lastEndPos + 4096)] 附近做稀疏步长对齐
    const searchLo = Math.max(0, lastEndPos - 6400);
    const searchHi = Math.max(searchLo, Math.min(totalLen - n, lastEndPos + 4096));
    const probeLen = Math.min(n, 4800);
    const probeOff = Math.max(0, n - probeLen);
    let bestPos = Math.min(Math.max(0, lastEndPos - (callCount > 0 ? 4800 : 0)), Math.max(0, totalLen - n));
    let bestErr = Number.POSITIVE_INFINITY;
    for (let pos = searchLo; pos <= searchHi; pos += 64) {
      let err = 0;
      for (let k = 0; k < probeLen; k += 16) {
        const d = input[probeOff + k]! - mixTimeline[pos + probeOff + k]!;
        err += d * d;
      }
      if (err < bestErr) {
        bestErr = err;
        bestPos = pos;
      }
    }
    // 精细搜索 [-64, +64]
    const fineLo = Math.max(0, bestPos - 64);
    const fineHi = Math.min(Math.max(0, totalLen - n), bestPos + 64);
    for (let pos = fineLo; pos <= fineHi; pos += 1) {
      let err = 0;
      for (let k = 0; k < probeLen; k += 8) {
        const d = input[probeOff + k]! - mixTimeline[pos + probeOff + k]!;
        err += d * d;
      }
      if (err < bestErr) {
        bestErr = err;
        bestPos = pos;
      }
    }
    return bestPos;
  };

  const srv = Bun.serve({
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
        const callIdx = callCount++;
        const startPos = findBestStart(input);
        lastEndPos = startPos + n;
        const t0 = new Float32Array(n);
        const t1 = new Float32Array(n);
        for (let i = 0; i < n; i += 1) {
          const idx = startPos + i;
          t0[i] = idx < slot0Timeline.length ? slot0Timeline[idx]! : 0;
          t1[i] = idx < slot1Timeline.length ? slot1Timeline[idx]! : 0;
        }
        const shouldSwap = swapOnCall ? swapOnCall(callIdx) : callIdx % 2 === 1;
        const outTracks = shouldSwap ? [t1, t0] : [t0, t1];
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
            "X-ClearVoice-SS-Ms": "12.0",
            "X-ClearVoice-SE-Ms": "8.0",
            "X-ClearVoice-Infer-Ms": "20.0",
            "X-ClearVoice-Gpu-Name": "Mock RTX 3060",
          },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { server: srv, getCallCount: () => callCount };
}

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "mijiadeck-cv-tvblock-"));
  const dir = tmpDir;
  setDataPathOverrides({ dataDir: () => dir });
});

afterEach(() => {
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

describe("ClearVoice 多轨持续电视防串轨与防阻塞核心算法单元测试", () => {
  test("幅值感知 PIT 对齐：音轨 1 静音含微弱电视串音时，绝不把高能电视轨换入音轨 1", () => {
    const lookback = Math.round(SR * 0.3); // 4800
    const tvPrev = makeSineSlice(0, 16000, SR, 880, 0.22);
    // 音轨 1（Slot 0）已停说，仅残留 0.0004 幅度的微弱电视串音（与 TV 完全同相位，纯归一化余弦相关会高达 1.0！）
    const quietSlot0WithTvBleed = tvPrev.map((v) => v * 0.002);

    // 下一片 BSS 发生轨序翻转：Slot 0 变成了高能电视，Slot 1 变成了静音
    const tvCurr = makeSineSlice(16000 - lookback, lookback + 16000, SR, 880, 0.22);
    const silentCurr = new Float32Array(lookback + 16000);

    const res = alignSeparatedTracksWithPrevTails(
      [quietSlot0WithTvBleed, tvPrev],
      [tvCurr, silentCurr],
      lookback,
    );
    expect(res.swapped).toBe(true);
    expect(res.permutation).toEqual([1, 0]);
    // 纠正后 Slot 0 仍保持静音，Slot 1 仍为电视
    expect(computeNormalizedWaveformCorr(tvPrev.subarray(tvPrev.length - lookback), res.aligned[1]!.subarray(0, lookback))).toBeGreaterThan(0.99);
    const slot0Energy = res.aligned[0]!.reduce((s, v) => s + v * v, 0);
    expect(slot0Energy).toBeLessThan(1e-6);
  });

  test("静默边界 PIT 兜底：重叠区恰逢电视 300ms 换气停顿时，利用 prevRecentRms 连续性防止电视跳轨污染音轨 1", () => {
    const lookback = Math.round(SR * 0.3); // 4800
    // 前一片末尾 300ms 两轨均近静音（模拟真实 GPU Slice 1 [3.7..4.0s] 电视换气间隙）
    const prevSlot0Tail = new Float32Array(lookback);
    const prevSlot1Tail = new Float32Array(lookback);
    // 下一片 BSS 轨序翻转：高能电视输出到 Slot 0，Slot 1 静音
    const currTv = makeSineSlice(0, lookback + 16000, SR, 860, 0.2);
    currTv.fill(0, 0, lookback); // 前 300ms 重叠区仍处于换气尾段
    const currSilent = new Float32Array(lookback + 16000);

    // prevRecentRms 显示前一片整体上 Slot 0 已静音 (0.001)，Slot 1 为持续活跃电视 (0.14)
    const res = alignSeparatedTracksWithPrevTails(
      [prevSlot0Tail, prevSlot1Tail],
      [currTv, currSilent],
      lookback,
      { prevRecentRms: [0.001, 0.14] },
    );
    expect(res.swapped).toBe(true);
    expect(res.permutation).toEqual([1, 0]);
    expect(res.aligned[1]!.reduce((s, v) => s + v * v, 0)).toBeGreaterThan(10);
    expect(res.aligned[0]!.reduce((s, v) => s + v * v, 0)).toBeLessThan(1e-6);
  });

  test("pruneInactiveOrDuplicateTracks：保护短时清晰真实指令音轨（1.2s 发声 + 16s 静音）不被长电视轨稀释误删，同时继续剔除镜像残影", () => {
    // Track 0: 用户说 1.2s（amp=0.12）+ 16.8s 静音 -> 整段 RMS 约 0.021，低于 Track 1 (0.212) 的 12%
    const userTrack = makeSegmentedTrack(18, [[0.5, 1.7]], 330, 0.12, SR);
    // Track 1: 电视全程 18s 持续说话（amp=0.30, 880Hz）
    const tvTrack = makeSegmentedTrack(18, [[0, 18]], 880, 0.30, SR);

    const resKeep = pruneInactiveOrDuplicateTracks([userTrack, tvTrack]);
    expect(resKeep.tracks).toHaveLength(2);
    expect(resKeep.droppedCount).toBe(0);

    // 对比：单人镜像串音轨（哪怕只在某 1.2s 有声，但与主轨同源高相关）仍应被干净剔除！
    const ghostBleed = new Float32Array(tvTrack.length);
    for (let i = Math.round(0.5 * SR); i < Math.round(1.7 * SR); i += 1) {
      ghostBleed[i] = tvTrack[i]! * 0.35;
    }
    const resDrop = pruneInactiveOrDuplicateTracks([ghostBleed, tvTrack]);
    expect(resDrop.tracks).toHaveLength(1);
    expect(resDrop.droppedCount).toBe(1);
  });

  test("ClearVoiceMultiTrackEndpointTracker：分轨独立判停、自适应缩短步进、跨轨串音抑制与未闭合宽限隔离", () => {
    const tracker = new ClearVoiceMultiTrackEndpointTracker({
      sampleRate: SR,
      utteranceSilenceMs: 1000,
      longUtteranceExtraSilenceMs: 350,
      incompleteGraceMs: 650,
      maxChunkMs: 2000,
      vadFactory: () => createEnergyMockVad(0.02),
    });

    // Slice 0 [0..2.0s]: Slot 0 (User) 0..1.6s 说话 + 0.4s 静音；Slot 1 (TV) 0..2.0s 全程说话
    const s0User = makeSegmentedTrack(2.0, [[0, 1.6]], 320, 0.25, SR);
    const s0Tv = makeSegmentedTrack(2.0, [[0, 2.0]], 880, 0.24, SR);
    const step0 = tracker.ingestAlignedSlices([s0User, s0Tv], {
      sliceStartGlobalSample: 0,
      slotStartLocalSamples: [0, 0],
    });
    expect(step0.readySlots).toHaveLength(0);
    // Slot 0 已进入 400ms 尾静音倒计时而 Slot 1 仍在说 -> 自适应下一切片步进应短于 2000ms
    const adaptiveMs = tracker.computeAdaptiveNextChunkMs();
    expect(adaptiveMs).not.toBeNull();
    expect(adaptiveMs!).toBeGreaterThanOrEqual(800);
    expect(adaptiveMs!).toBeLessThan(1500);

    // 故意给电视轨（Slot 1）标记未闭合语义宽限，绝不能拖延用户轨（Slot 0）判停！
    tracker.setSlotIncompleteHint(1, true);

    // Slice 1 [2.0..2.9s]: Slot 0 静音（含 2% 微弱电视串音），Slot 1 仍全程说话 -> Slot 0 累计静音 1.3s >= 1.0s，立即独立出段！
    const s1Tv = makeSegmentedTrack(0.9, [[0, 0.9]], 880, 0.24, SR);
    const s1UserQuietBleed = s1Tv.map((v) => v * 0.02);
    const step1 = tracker.ingestAlignedSlices([s1UserQuietBleed, s1Tv], {
      sliceStartGlobalSample: Math.round(2.0 * SR),
      slotStartLocalSamples: [s0User.length, s0Tv.length],
    });
    expect(step1.readySlots).toHaveLength(1);
    expect(step1.readySlots[0]!.slotIndex).toBe(0);
    expect(step1.readySlots[0]!.reason).toBe("track_silence");
    expect(step1.readySlots[0]!.speechMs).toBeGreaterThanOrEqual(1500);
    // Slot 1 仍在活跃说话
    expect(tracker.getSlotSnapshot(1)?.hasSpeech).toBe(true);
    expect(tracker.getSlotSnapshot(1)?.trailingSilenceMs).toBe(0);

    // 反向对称校验：Slot 1 说完停声、Slot 0 持续发声 -> 立即独立出段 Slot 1
    tracker.reset();
    const rev0Tv = makeSegmentedTrack(2.0, [[0, 2.0]], 880, 0.24, SR);
    const rev0User = makeSegmentedTrack(2.0, [[0, 1.5]], 320, 0.25, SR);
    expect(
      tracker.ingestAlignedSlices([rev0Tv, rev0User], {
        sliceStartGlobalSample: 0,
        slotStartLocalSamples: [0, 0],
      }).readySlots,
    ).toHaveLength(0);
    const rev1Tv = makeSegmentedTrack(0.8, [[0, 0.8]], 880, 0.24, SR);
    const rev1UserSilent = new Float32Array(Math.round(0.8 * SR));
    const revStep1 = tracker.ingestAlignedSlices([rev1Tv, rev1UserSilent], {
      sliceStartGlobalSample: Math.round(2.0 * SR),
      slotStartLocalSamples: [rev0Tv.length, rev0User.length],
    });
    expect(revStep1.readySlots).toHaveLength(1);
    expect(revStep1.readySlots[0]!.slotIndex).toBe(1);
  });
});

describe("流式端到端：音轨 1 真实命令 + 音轨 2 电视持续发声（不阻塞、不串轨、不重复执行）", () => {
  test("核心复现与修复：音轨 1 说完真实命令，音轨 2（电视）连续说 10 秒不停，音轨 1 在未 flush 前立即执行且后续 flush 不重复执行", async () => {
    updateAgentVoiceConfig({
      voicePipelineMode: "clearvoice",
      wakeWordEnabled: true,
      wakeWords: ["Neo", "小派"],
      voiceprintMode: "tag",
      voiceprintThreshold: 0.42,
      attentionMode: "smart",
      conversationWindowSec: 25,
      vadSilenceMs: 1000,
      owwEnabled: false,
    });

    const ownerEmb = l2Normalize([1, 0, 0, 0, 0, 0, 0, 0]);
    const tvEmb = l2Normalize([0, 1, 0, 0, 0, 0, 0, 0]);
    enrollVoiceprint({ name: "主人", role: "owner", embedding: ownerEmb, engine: "3dspeaker-campplus" });

    // 10.5 秒时间线：音轨 1 (Slot 0, 320Hz) 在 [0.2s, 2.0s] 说真实命令后静音；音轨 2 (Slot 1, 880Hz) [0.0s, 10.5s] 全程持续说话（模拟电视不停）
    const totalSec = 10.5;
    const slot0User = makeSegmentedTrack(totalSec, [[0.2, 2.0]], 320, 0.26, SR);
    const slot1Tv = makeSegmentedTrack(totalSec, [[0.0, 10.5]], 880, 0.24, SR);
    const mix = new Float32Array(slot0User.length);
    for (let i = 0; i < mix.length; i += 1) {
      mix[i] = slot0User[i]! + slot1Tv[i]!;
    }

    const mock = startTimelineMockBssServer({
      slot0Timeline: slot0User,
      slot1Timeline: slot1Tv,
      swapOnCall: (idx) => idx % 2 === 1, // 奇数切片故意翻转轨序，同时检验 PIT 防换轨
    });
    mockCvServer = mock.server;

    const cvRuntime = new ClearVoiceGpuRuntime({
      modelsDir: tmpDir,
      serviceUrl: `http://127.0.0.1:${mockCvServer.port}`,
    });

    const fakeEngine = {
      clearVoiceGpu: cvRuntime,
      openWakeWord: { isReady: true, getStatus: () => ({ ready: true, prototypes: [] }) },
      getStatus: () => ({
        readyForLocalAsr: true,
        readyForVad: true,
        readyForVoiceprint: true,
        readyForClearVoiceGpu: true,
        readyForClearVoiceBss: true,
        activeQwen3Device: "gpu",
      }),
      createOnlineDenoiser: () => null,
      dispose: () => {},
      createStreamingVad: () => createEnergyMockVad(0.02),
      createWakeWordStream: () => null,
      denoise: (s: Float32Array) => ({ samples: s, engine: "off", durationMs: 1 }),
      detectSpeechSegments: (samples: Float32Array) => ({
        hasSpeech: samples.length >= 1600,
        speechRatio: 0.9,
        speechSamples: samples,
        segments: [{ start: 0, end: samples.length }],
        engine: "silero-mock",
        durationMs: 2,
      }),
      extractSpeakerEmbedding: (samples: Float32Array) => {
        const hz = estimateDominantZeroCrossingHz(samples, SR);
        return {
          embedding: hz < 600 ? ownerEmb : tvEmb,
          engine: "3dspeaker-campplus",
          durationMs: 3,
        };
      },
      scoreWakeWordAudio: () => null,
      transcribeLocal: async (samples: Float32Array): Promise<LocalAsrOutput> => {
        const hz = estimateDominantZeroCrossingHz(samples, SR);
        if (hz > 150 && hz < 600) {
          return makeAsrOut("Neo，打开客厅吸顶灯", 6);
        }
        return makeAsrOut("各位观众晚上好下面播报今晚的天气预报以及体育新闻", 6);
      },
    } as unknown as LocalVoiceEngine;

    const { controller, agent, cleanup } = buildTestController(fakeEngine);
    try {
      await cvRuntime.warmup();
      const emittedBeforeFlush: VoiceStreamSegmentPayload[] = [];
      const emittedAfterFlush: VoiceStreamSegmentPayload[] = [];
      let flushed = false;

      const session = new VoiceStreamSession({
        localEngine: fakeEngine,
        noiseMode: "off",
        sampleRate: SR,
        bypassWakeWord: true,
        wakeWordEnabled: true,
        wakeWords: ["Neo", "小派"],
        owwEnabled: false,
        wakeGatedAsr: false,
        vadSilenceMs: 1000,
        streamingAsrEnabled: true,
        voicePipelineMode: "clearvoice",
        clearVoiceSilenceMs: 280,
        clearVoiceMaxChunkMs: 2000,
        isInConversation: () => controller.dialogState === "conversation",
        onSegmentReady: async (seg) => {
          if (flushed) emittedAfterFlush.push(seg);
          else emittedBeforeFlush.push(seg);
          const res = await controller.processDualTrackSegment(seg, {
            lang: "zh-CN",
            bypassWakeWord: false,
            preferredEngine: "local",
            asyncDispatch: false,
          });
          return res;
        },
      });

      // 仅喂入前 5.0 秒（此时电视仍在持续发声，混合音频从未静音，且不调用 flush()！）
      const first5Sec = mix.subarray(0, Math.round(5.0 * SR));
      const frame = 512;
      for (let off = 0; off < first5Sec.length; off += frame) {
        session.pushFloat32Samples(first5Sec.subarray(off, Math.min(first5Sec.length, off + frame)));
      }
      await session.waitForIdle();

      // 断言 1：电视还在播、未 flush 前，音轨 1 必须已经独立出段并立即执行命令！
      expect(emittedBeforeFlush.length).toBe(1);
      expect(emittedBeforeFlush[0]!.clearVoiceMeta?.independentTrackEmit).toBe(true);
      expect(emittedBeforeFlush[0]!.clearVoiceMeta?.sourceSlot).toBe(0);
      expect(emittedBeforeFlush[0]!.separatedTracks).toHaveLength(1);
      expect(emittedBeforeFlush[0]!.separatedTracks![0]!.trackId).toBe("cv_track_1");

      const userTurnsMid = agent.snapshot().timeline.filter((e) => e.role === "user");
      expect(userTurnsMid).toHaveLength(1);
      expect(userTurnsMid[0]!.text).toContain("打开客厅吸顶灯");

      // 继续喂入剩余 5.5 秒持续电视音频（电视从未停过），不产生重复执行
      const restAudio = mix.subarray(Math.round(5.0 * SR));
      for (let off = 0; off < restAudio.length; off += frame) {
        session.pushFloat32Samples(restAudio.subarray(off, Math.min(restAudio.length, off + frame)));
      }
      await session.waitForIdle();
      expect(agent.snapshot().timeline.filter((e) => e.role === "user")).toHaveLength(1);

      // 最后模拟停止录音 flush -> 仅提交未出段的电视轨，严禁重复执行音轨 1！
      flushed = true;
      session.flush();
      await session.waitForIdle();

      expect(agent.snapshot().timeline.filter((e) => e.role === "user")).toHaveLength(1);
      // flush 提交的应当只有电视槽位（slot 1），不再包含已出段且已重置的音轨 1（slot 0）
      if (emittedAfterFlush.length > 0) {
        const afterSlots = emittedAfterFlush.flatMap((seg) =>
          (seg.separatedTracks ?? []).map((t) => t.sourceSlot),
        );
        expect(afterSlots).not.toContain(0);
      }

      session.dispose();
    } finally {
      await cleanup();
    }
  });

  test("对称槽位与连续多条命令：电视占音轨 1 持续 13 秒不停，用户在音轨 2 连续说出 2 条命令均即时执行", async () => {
    updateAgentVoiceConfig({
      voicePipelineMode: "clearvoice",
      wakeWordEnabled: true,
      wakeWords: ["Neo"],
      voiceprintMode: "off",
      attentionMode: "smart",
      conversationWindowSec: 30,
      vadSilenceMs: 900,
      owwEnabled: false,
    });

    // Slot 0 = 电视全程 13s 不停 (880Hz)；Slot 1 = 用户在 [0.2..1.8s] 说指令1 (320Hz)，在 [6.2..7.8s] 说指令2 (460Hz)
    const totalSec = 13.0;
    const slot0Tv = makeSegmentedTrack(totalSec, [[0.0, 13.0]], 880, 0.24, SR);
    const slot1Cmd1 = makeSegmentedTrack(totalSec, [[0.2, 1.8]], 320, 0.25, SR);
    const slot1Cmd2 = makeSegmentedTrack(totalSec, [[6.2, 7.8]], 460, 0.25, SR);
    const slot1User = new Float32Array(slot0Tv.length);
    const mix = new Float32Array(slot0Tv.length);
    for (let i = 0; i < mix.length; i += 1) {
      slot1User[i] = slot1Cmd1[i]! + slot1Cmd2[i]!;
      mix[i] = slot0Tv[i]! + slot1User[i]!;
    }

    const mock = startTimelineMockBssServer({
      slot0Timeline: slot0Tv,
      slot1Timeline: slot1User,
      swapOnCall: (idx) => idx % 2 === 1,
    });
    mockCvServer = mock.server;

    const cvRuntime = new ClearVoiceGpuRuntime({
      modelsDir: tmpDir,
      serviceUrl: `http://127.0.0.1:${mockCvServer.port}`,
    });

    const fakeEngine = {
      clearVoiceGpu: cvRuntime,
      openWakeWord: { isReady: true, getStatus: () => ({ ready: true, prototypes: [] }) },
      getStatus: () => ({
        readyForLocalAsr: true,
        readyForVad: true,
        readyForVoiceprint: false,
        readyForClearVoiceGpu: true,
        readyForClearVoiceBss: true,
        activeQwen3Device: "gpu",
      }),
      createOnlineDenoiser: () => null,
      dispose: () => {},
      createStreamingVad: () => createEnergyMockVad(0.02),
      createWakeWordStream: () => null,
      denoise: (s: Float32Array) => ({ samples: s, engine: "off", durationMs: 1 }),
      detectSpeechSegments: (samples: Float32Array) => ({
        hasSpeech: samples.length >= 1600,
        speechRatio: 0.9,
        speechSamples: samples,
        segments: [{ start: 0, end: samples.length }],
        engine: "silero-mock",
        durationMs: 1,
      }),
      extractSpeakerEmbedding: () => ({ embedding: [1, 0], engine: "mock", durationMs: 1 }),
      scoreWakeWordAudio: () => null,
      transcribeLocal: async (samples: Float32Array): Promise<LocalAsrOutput> => {
        const hz = estimateDominantZeroCrossingHz(samples, SR);
        if (hz > 200 && hz < 390) {
          return makeAsrOut("Neo，打开客厅吸顶灯", 5);
        }
        if (hz >= 390 && hz < 650) {
          return makeAsrOut("关闭卧室台灯", 5);
        }
        return makeAsrOut("电视剧里的台词一直在喋喋不休", 5);
      },
    } as unknown as LocalVoiceEngine;

    const { controller, agent, cleanup } = buildTestController(fakeEngine);
    try {
      await cvRuntime.warmup();
      const emitted: VoiceStreamSegmentPayload[] = [];
      const session = new VoiceStreamSession({
        localEngine: fakeEngine,
        noiseMode: "off",
        sampleRate: SR,
        bypassWakeWord: true,
        wakeWordEnabled: true,
        wakeWords: ["Neo"],
        owwEnabled: false,
        wakeGatedAsr: false,
        vadSilenceMs: 900,
        streamingAsrEnabled: false,
        voicePipelineMode: "clearvoice",
        clearVoiceSilenceMs: 280,
        clearVoiceMaxChunkMs: 2000,
        isInConversation: () => controller.dialogState === "conversation",
        onSegmentReady: async (seg) => {
          emitted.push(seg);
          const res = await controller.processDualTrackSegment(seg, {
            lang: "zh-CN",
            bypassWakeWord: false,
            preferredEngine: "local",
            asyncDispatch: false,
          });
          return res;
        },
      });

      const frame = 512;
      // 阶段 1：推入 0..5.0s（仅第 1 条命令完成，电视继续）
      for (let off = 0; off < Math.round(5.0 * SR); off += frame) {
        session.pushFloat32Samples(mix.subarray(off, Math.min(Math.round(5.0 * SR), off + frame)));
      }
      await session.waitForIdle();
      expect(emitted.length).toBe(1);
      expect(emitted[0]!.clearVoiceMeta?.sourceSlot).toBe(1);
      expect(agent.snapshot().timeline.filter((e) => e.role === "user").map((e) => e.text)).toEqual([
        "打开客厅吸顶灯",
      ]);
      expect(controller.dialogState).toBe("conversation");

      // 阶段 2：推入 5.0..12.5s（电视依然从未停声，用户在 6.2..7.8s 说第 2 条指令）
      for (let off = Math.round(5.0 * SR); off < Math.round(12.5 * SR); off += frame) {
        session.pushFloat32Samples(mix.subarray(off, Math.min(Math.round(12.5 * SR), off + frame)));
      }
      await session.waitForIdle();
      expect(emitted.length).toBe(2);
      expect(emitted[1]!.clearVoiceMeta?.sourceSlot).toBe(1);
      expect(agent.snapshot().timeline.filter((e) => e.role === "user").map((e) => e.text)).toEqual([
        "打开客厅吸顶灯",
        "关闭卧室台灯",
      ]);

      session.dispose();
    } finally {
      await cleanup();
    }
  });

  test("待机唤醒门控 + 持续电视：即使电视先短暂停顿触发无命中分轨出段，仍保留唤醒锚定让用户真实指令顺利执行", async () => {
    updateAgentVoiceConfig({
      voicePipelineMode: "clearvoice",
      wakeWordEnabled: true,
      wakeWords: ["Neo"],
      voiceprintMode: "off",
      attentionMode: "smart",
      conversationWindowSec: 25,
      vadSilenceMs: 900,
      owwEnabled: true,
    });

    // 场景：
    // [0..1.5s] 待机期纯电视说话；
    // [1.5..2.0s] 用户开始喊 "Neo..."（在 t=2.0s 触发声学唤醒点）；
    // [2.0..4.8s] 用户继续把命令说完（长 3.3s），随后静音；
    // [0.0..2.2s] 电视说话，[2.2..3.6s] 电视暂停 1.4s（先触发电视轨独立出段并被拒识！），[3.6..9.0s] 电视恢复持续说话直到结束！
    const totalSec = 9.0;
    const slot0User = makeSegmentedTrack(totalSec, [[1.5, 4.8]], 320, 0.25, SR);
    const slot1Tv = makeSegmentedTrack(totalSec, [[0.0, 2.2], [3.6, 9.0]], 880, 0.24, SR);
    const mix = new Float32Array(slot0User.length);
    for (let i = 0; i < mix.length; i += 1) {
      mix[i] = slot0User[i]! + slot1Tv[i]!;
    }

    const mock = startTimelineMockBssServer({
      slot0Timeline: slot0User,
      slot1Timeline: slot1Tv,
      swapOnCall: () => false,
    });
    mockCvServer = mock.server;

    const cvRuntime = new ClearVoiceGpuRuntime({
      modelsDir: tmpDir,
      serviceUrl: `http://127.0.0.1:${mockCvServer.port}`,
    });

    let spotCallback: ((hit: WakeWordAcousticHit) => void) | null = null;
    let fedWakeSamples = 0;
    let wakeFired = false;

    const fakeEngine = {
      clearVoiceGpu: cvRuntime,
      openWakeWord: { isReady: true, getStatus: () => ({ ready: true, prototypes: [] }) },
      getStatus: () => ({
        readyForLocalAsr: true,
        readyForVad: true,
        readyForVoiceprint: false,
        readyForClearVoiceGpu: true,
        readyForClearVoiceBss: true,
        activeQwen3Device: "gpu",
      }),
      createOnlineDenoiser: () => null,
      dispose: () => {},
      createStreamingVad: () => createEnergyMockVad(0.02),
      createWakeWordStream: (
        _words: string[],
        opts: { onSpot?: (hit: WakeWordAcousticHit) => void },
      ) => {
        spotCallback = opts.onSpot ?? null;
        return {
          pushSamples(samples: Float32Array, globalEndSample?: number) {
            fedWakeSamples = globalEndSample ?? fedWakeSamples + samples.length;
            if (!wakeFired && fedWakeSamples >= Math.round(2.1 * SR)) {
              wakeFired = true;
              const hit: WakeWordAcousticHit = {
                matched: true,
                wakeWord: "Neo",
                score: 0.92,
                rawScore: 0.92,
                threshold: 0.5,
                source: "enrolled",
                frameIndex: 0,
                sampleOffset: fedWakeSamples,
                latencyMs: 4,
              };
              spotCallback?.(hit);
            }
          },
          reset() {},
          resetSegmentTracking() {},
          getLatestHit: () => null,
          getLastSegmentHit: () => null,
          hasSegmentHit: () => wakeFired,
          dispose() {},
        };
      },
      denoise: (s: Float32Array) => ({ samples: s, engine: "off", durationMs: 1 }),
      detectSpeechSegments: (samples: Float32Array) => ({
        hasSpeech: samples.length >= 1600,
        speechRatio: 0.9,
        speechSamples: samples,
        segments: [{ start: 0, end: samples.length }],
        engine: "silero-mock",
        durationMs: 1,
      }),
      extractSpeakerEmbedding: () => ({ embedding: [1, 0], engine: "mock", durationMs: 1 }),
      scoreWakeWordAudio: (samples: Float32Array): WakeWordAcousticHit | null => {
        const hz = estimateDominantZeroCrossingHz(samples, SR);
        if (hz > 150 && hz < 600) {
          return {
            matched: true,
            wakeWord: "Neo",
            score: 0.92,
            rawScore: 0.92,
            threshold: 0.5,
            source: "enrolled",
                frameIndex: 0,
            sampleOffset: 0,
            latencyMs: 2,
          };
        }
        return {
          matched: false,
          wakeWord: "Neo",
          score: 0.08,
          rawScore: 0.08,
          threshold: 0.5,
          source: "enrolled",
                frameIndex: 0,
          sampleOffset: 0,
          latencyMs: 2,
        };
      },
      transcribeLocal: async (samples: Float32Array): Promise<LocalAsrOutput> => {
        const hz = estimateDominantZeroCrossingHz(samples, SR);
        if (hz > 150 && hz < 600) {
          return makeAsrOut("Neo，把客厅吸顶灯打开", 5);
        }
        return makeAsrOut("广告之后马上回来", 5);
      },
    } as unknown as LocalVoiceEngine;

    const { controller, agent, cleanup } = buildTestController(fakeEngine);
    try {
      await cvRuntime.warmup();
      const emitted: VoiceStreamSegmentPayload[] = [];
      const session = new VoiceStreamSession({
        localEngine: fakeEngine,
        noiseMode: "off",
        sampleRate: SR,
        bypassWakeWord: false,
        wakeWordEnabled: true,
        wakeWords: ["Neo"],
        owwEnabled: true,
        wakeGatedAsr: true,
        vadSilenceMs: 900,
        streamingAsrEnabled: false,
        voicePipelineMode: "clearvoice",
        clearVoiceSilenceMs: 280,
        clearVoiceMaxChunkMs: 1600,
        isInConversation: () => controller.dialogState === "conversation",
        onSegmentReady: async (seg) => {
          emitted.push(seg);
          const res = await controller.processDualTrackSegment(seg, {
            lang: "zh-CN",
            bypassWakeWord: false,
            preferredEngine: "local",
            asyncDispatch: false,
          });
          return res;
        },
      });

      const frame = 512;
      for (let off = 0; off < mix.length; off += frame) {
        session.pushFloat32Samples(mix.subarray(off, Math.min(mix.length, off + frame)));
      }
      await session.waitForIdle();

      // 即使电视轨（slot 1）因暂停先出段且被拒识，唤醒锚定仍保留给用户轨（slot 0），用户命令成功执行！
      const tvEmits = emitted.filter((e) => e.clearVoiceMeta?.sourceSlot === 1);
      const userEmits = emitted.filter((e) => e.clearVoiceMeta?.sourceSlot === 0);
      expect(tvEmits.length).toBeGreaterThanOrEqual(1);
      expect(userEmits.length).toBeGreaterThanOrEqual(1);
      expect(userEmits[0]!.wakeAnchored).toBe(true);
      expect(agent.snapshot().timeline.filter((e) => e.role === "user").map((e) => e.text)).toEqual([
        "把客厅吸顶灯打开",
      ]);
      expect(controller.dialogState).toBe("conversation");

      session.dispose();
    } finally {
      await cleanup();
    }
  });

  test("持续电视背景下用户慢语速句中停顿 550ms：绝不提前截断成两句，停稳后合并为完整一条命令执行", async () => {
    updateAgentVoiceConfig({
      voicePipelineMode: "clearvoice",
      wakeWordEnabled: true,
      wakeWords: ["Neo"],
      voiceprintMode: "off",
      attentionMode: "smart",
      conversationWindowSec: 25,
      vadSilenceMs: 1100,
      owwEnabled: false,
    });

    // 用户 [0.2..1.5s] + 550ms 停顿 + [2.05..3.2s]，之后静音；电视 [0..8.5s] 全程持续
    const totalSec = 8.5;
    const slot0User = makeSegmentedTrack(totalSec, [[0.2, 1.5], [2.05, 3.2]], 320, 0.25, SR);
    const slot1Tv = makeSegmentedTrack(totalSec, [[0.0, 8.5]], 880, 0.24, SR);
    const mix = new Float32Array(slot0User.length);
    for (let i = 0; i < mix.length; i += 1) {
      mix[i] = slot0User[i]! + slot1Tv[i]!;
    }

    const mock = startTimelineMockBssServer({
      slot0Timeline: slot0User,
      slot1Timeline: slot1Tv,
      swapOnCall: () => false,
    });
    mockCvServer = mock.server;

    const cvRuntime = new ClearVoiceGpuRuntime({
      modelsDir: tmpDir,
      serviceUrl: `http://127.0.0.1:${mockCvServer.port}`,
    });

    const fakeEngine = {
      clearVoiceGpu: cvRuntime,
      openWakeWord: { isReady: true, getStatus: () => ({ ready: true, prototypes: [] }) },
      getStatus: () => ({
        readyForLocalAsr: true,
        readyForVad: true,
        readyForVoiceprint: false,
        readyForClearVoiceGpu: true,
        readyForClearVoiceBss: true,
        activeQwen3Device: "gpu",
      }),
      createOnlineDenoiser: () => null,
      dispose: () => {},
      createStreamingVad: () => createEnergyMockVad(0.02),
      createWakeWordStream: () => null,
      denoise: (s: Float32Array) => ({ samples: s, engine: "off", durationMs: 1 }),
      detectSpeechSegments: (samples: Float32Array) => ({
        hasSpeech: samples.length >= 1600,
        speechRatio: 0.8,
        speechSamples: samples,
        segments: [{ start: 0, end: samples.length }],
        engine: "silero-mock",
        durationMs: 1,
      }),
      extractSpeakerEmbedding: () => ({ embedding: [1, 0], engine: "mock", durationMs: 1 }),
      scoreWakeWordAudio: () => null,
      transcribeLocal: async (samples: Float32Array): Promise<LocalAsrOutput> => {
        const hz = estimateDominantZeroCrossingHz(samples, SR);
        if (hz > 150 && hz < 600) {
          return makeAsrOut("Neo，打开客厅吸顶灯", 4);
        }
        return makeAsrOut("新闻联播持续播报中", 4);
      },
    } as unknown as LocalVoiceEngine;

    const { controller, agent, cleanup } = buildTestController(fakeEngine);
    try {
      await cvRuntime.warmup();
      const userEmits: VoiceStreamSegmentPayload[] = [];
      const session = new VoiceStreamSession({
        localEngine: fakeEngine,
        noiseMode: "off",
        sampleRate: SR,
        bypassWakeWord: true,
        wakeWordEnabled: true,
        wakeWords: ["Neo"],
        owwEnabled: false,
        wakeGatedAsr: false,
        vadSilenceMs: 1100,
        streamingAsrEnabled: false,
        voicePipelineMode: "clearvoice",
        clearVoiceSilenceMs: 280,
        clearVoiceMaxChunkMs: 1800,
        isInConversation: () => controller.dialogState === "conversation",
        onSegmentReady: async (seg) => {
          if (seg.clearVoiceMeta?.sourceSlot === 0) {
            userEmits.push(seg);
          }
          const res = await controller.processDualTrackSegment(seg, {
            lang: "zh-CN",
            bypassWakeWord: false,
            preferredEngine: "local",
            asyncDispatch: false,
          });
          return res;
        },
      });

      for (let off = 0; off < mix.length; off += 512) {
        session.pushFloat32Samples(mix.subarray(off, Math.min(mix.length, off + 512)));
      }
      await session.waitForIdle();

      expect(userEmits).toHaveLength(1);
      // 完整包含前后两段语音，总时长 >= 2.8s（而非在 1.5s 处被腰斩）
      expect(userEmits[0]!.durationSec).toBeGreaterThanOrEqual(2.7);
      expect(agent.snapshot().timeline.filter((e) => e.role === "user")).toHaveLength(1);

      session.dispose();
    } finally {
      await cleanup();
    }
  });

  test("同批多轨保护：音轨 1 命中真实命令时，音轨 2 电视恰好说出“再见”绝不把对话踢回待机", async () => {
    updateAgentVoiceConfig({
      voicePipelineMode: "clearvoice",
      wakeWordEnabled: true,
      wakeWords: ["Neo"],
      voiceprintMode: "off",
      attentionMode: "smart",
      conversationWindowSec: 25,
      owwEnabled: false,
    });

    const fakeEngine = {
      openWakeWord: { getStatus: () => ({ ready: false, prototypes: [] }) },
      getStatus: () => ({
        readyForLocalAsr: true,
        readyForVad: true,
        readyForVoiceprint: false,
        readyForClearVoiceGpu: true,
        readyForClearVoiceBss: true,
      }),
      detectSpeechSegments: (samples: Float32Array) => ({
        hasSpeech: true,
        speechRatio: 0.9,
        speechSamples: samples,
        segments: [{ start: 0, end: samples.length }],
        engine: "silero-mock",
        durationMs: 1,
      }),
      dispose: () => {},
      extractSpeakerEmbedding: () => ({ embedding: [1, 0], engine: "mock", durationMs: 1 }),
      scoreWakeWordAudio: () => null,
      transcribeLocal: async (samples: Float32Array): Promise<LocalAsrOutput> => {
        const hz = estimateDominantZeroCrossingHz(samples, SR);
        if (hz < 600) {
          return makeAsrOut("打开客厅吸顶灯", 4);
        }
        return makeAsrOut("好的谢谢再见", 4);
      },
    } as unknown as LocalVoiceEngine;

    const { controller, agent, cleanup } = buildTestController(fakeEngine);
    try {
      controller.enterConversation("manual");
      expect(controller.dialogState).toBe("conversation");

      const t1 = makeSineSlice(0, SR * 2, SR, 320, 0.25);
      const t2 = makeSineSlice(0, SR * 2, SR, 880, 0.22);
      const res = await controller.processClearVoiceSeparatedTracks(
        [
          { trackId: "cv_track_1", trackIndex: 1, samples: t1 },
          { trackId: "cv_track_2", trackIndex: 2, samples: t2 },
        ],
        {
          denoiseEngine: "clearvoice-mossformer2-bss-se-gpu",
          bssUsed: true,
          inputSnrDb: 10,
          denoiseMs: 25,
          rawDurationMs: 2000,
          preVadSegmented: true,
        },
        {
          lang: "zh-CN",
          bypassWakeWord: false,
          autoDispatch: true,
          useLocal: true,
          asyncDispatch: false,
        },
      );

      expect(res.matched).toBe(true);
      expect(agent.snapshot().timeline.filter((e) => e.role === "user").map((e) => e.text)).toEqual([
        "打开客厅吸顶灯",
      ]);
      // 关键：同批音轨 2 电视说“再见”绝不能将已执行真实命令的用户踢回待机！
      expect(controller.dialogState).toBe("conversation");
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 真实 RTX GPU 端到端实测：真实用户命令录音 clip_001.wav + 真实持续电视/旁白录音循环 8.5s
// ---------------------------------------------------------------------------

const REAL_MODELS_DIR = process.env.MIJIADECK_VOICE_MODELS_DIR || "";
const REAL_CMD_WAV = path.resolve(import.meta.dir, "../benchmarks/voice_sep_100/audio/clip_001.wav");
const REAL_TV_WAV = path.resolve(import.meta.dir, "../benchmarks/voice_sep_100/family_ref.wav");
const REAL_OWNER_REF = path.resolve(import.meta.dir, "../benchmarks/voice_sep_100/owner_ref.wav");

describe("真实 GPU ClearVoice (MossFormer2_SS_16K + SE_48K) 持续电视不阻塞用户命令端到端实测", () => {
  test(
    "真实录音混合：用户说 clip_001（0..2.86s）+ 电视持续循环 family_ref（0..8.5s 不停），未 flush 前即独立出段执行用户命令",
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
        !existsSync(REAL_CMD_WAV) ||
        !existsSync(REAL_TV_WAV) ||
        !existsSync(REAL_OWNER_REF)
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
        conversationWindowSec: 30,
        vadSilenceMs: 1000,
        owwEnabled: false,
      });

      const ownerRef = decodeWavPcm(new Uint8Array(readFileSync(REAL_OWNER_REF)));
      const ownerEmb = engine.extractSpeakerEmbedding(ownerRef.samples, ownerRef.sampleRate);
      enrollVoiceprint({ name: "主人", role: "owner", embedding: ownerEmb.embedding, engine: ownerEmb.engine });

      const cmdWav = decodeWavPcm(new Uint8Array(readFileSync(REAL_CMD_WAV)));
      const tvWav = decodeWavPcm(new Uint8Array(readFileSync(REAL_TV_WAV)));
      // 提取 family_ref 中无长静音的活跃语段循环铺满 8.5s，模拟绝不停顿的电视对话
      const tvVad = engine.detectSpeechSegments(tvWav.samples, tvWav.sampleRate);
      const tvCore = tvVad.speechSamples.length >= SR ? tvVad.speechSamples : tvWav.samples;
      const totalSamples = Math.round(8.5 * SR);
      const mix = new Float32Array(totalSamples);
      for (let i = 0; i < totalSamples; i += 1) {
        const tvS = tvCore[i % tvCore.length]! * 0.85;
        const userS = i < cmdWav.samples.length ? cmdWav.samples[i]! : 0;
        mix[i] = Math.max(-0.98, Math.min(0.98, userS + tvS));
      }

      const { controller, agent, cleanup } = buildTestController(engine);
      try {
        await engine.clearVoiceGpu.warmup();
        const emittedBeforeFlush: VoiceStreamSegmentPayload[] = [];
        let flushed = false;

        const session = new VoiceStreamSession({
          localEngine: engine,
          noiseMode: "off",
          sampleRate: SR,
          bypassWakeWord: true,
          wakeWordEnabled: true,
          wakeWords: ["Neo", "nil", "neil", "小派"],
          owwEnabled: false,
          wakeGatedAsr: false,
          vadSilenceMs: 1000,
          streamingAsrEnabled: false,
          voicePipelineMode: "clearvoice",
          clearVoiceSilenceMs: 280,
          clearVoiceMaxChunkMs: 2000,
          isInConversation: () => controller.dialogState === "conversation",
          onSegmentReady: async (seg) => {
            if (!flushed) emittedBeforeFlush.push(seg);
            const res = await controller.processDualTrackSegment(seg, {
              lang: "zh-CN",
              bypassWakeWord: false,
              preferredEngine: "local",
              asyncDispatch: false,
            });
            return res;
          },
        });

        for (let off = 0; off < mix.length; off += 512) {
          session.pushFloat32Samples(mix.subarray(off, Math.min(mix.length, off + 512)));
        }
        // 不调用 flush()，直接等待所有已切分切片在真实 GPU 跑完
        await session.waitForIdle();

        // 断言：在电视持续播放满 8.5s、混合音频从未静音、未调用 flush() 的情况下，
        // 真实用户命令（clip_001: 打开客厅吸顶灯）已经独立出段并被 Pi Agent 执行！
        expect(emittedBeforeFlush.some((s) => s.clearVoiceMeta?.independentTrackEmit === true)).toBe(true);
        const userTurnsBeforeFlush = agent.snapshot().timeline.filter((e) => e.role === "user");
        expect(userTurnsBeforeFlush.length).toBe(1);
        expect(userTurnsBeforeFlush[0]!.text).toMatch(/客厅|吸顶灯|打开/);

        // 再调用 flush()，验证用户命令不会被重复执行第二次
        flushed = true;
        session.flush();
        await session.waitForIdle();
        expect(agent.snapshot().timeline.filter((e) => e.role === "user")).toHaveLength(1);

        session.dispose();
      } finally {
        await cleanup();
      }
    },
    180_000,
  );
});
