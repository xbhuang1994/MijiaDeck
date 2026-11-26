// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 待机未唤醒状态降噪与多轨盲源分离抗电视唤醒测试套件

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  computeRms,
  decodeWavPcm,
  encodeWavPcm16,
  estimateSnrDb,
  StreamingDspDenoiser,
} from "../src/agent/audioPcm.ts";
import { ClearVoiceGpuRuntime } from "../src/agent/clearVoiceGpuRuntime.ts";
import {
  LocalVoiceEngine,
  type LocalAsrOutput,
  type OnlineDenoiserHandleLike,
  type StreamingVadHandleLike,
} from "../src/agent/localVoiceEngine.ts";
import type {
  OpenWakeWordStreamSession,
  WakeWordAcousticHit,
} from "../src/agent/openWakeWordEngine.ts";
import { PiAgentService } from "../src/agent/piAgentService.ts";
import { VoiceListenerController } from "../src/agent/voiceListenerController.ts";
import {
  VoiceStreamSession,
  type VoiceStreamSegmentPayload,
} from "../src/agent/voiceStreamSession.ts";
import { addWakeWordPrototype } from "../src/agent/wakewordPrototypeStore.ts";
import { defaultAgentVoiceConfig, normalizeAgentVoiceConfig } from "../src/core/agentConfigStore.ts";
import { NetworkMonitor } from "../src/core/availability.ts";
import { JobExecutor } from "../src/core/jobs.ts";
import { setDataPathOverrides } from "../src/core/jsonStore.ts";
import * as settingsStore from "../src/core/settingsStore.ts";
import { VirtualDemoService } from "../src/core/virtualLightService.ts";
import { startMijiaDeckServer, type MijiaDeckServer } from "../src/server/server.ts";
import { MainWindowController } from "../src/ui/controllers/mainWindowController.ts";
import { ThemeController, applyTheme } from "../src/ui/theme.ts";

const SR = 16000;
const BENCH_AUDIO_DIR = path.resolve(import.meta.dir, "..", "benchmarks", "voice_sep_100", "audio");
const HAS_BENCH_WAVS = existsSync(path.join(BENCH_AUDIO_DIR, "clip_001.wav"));

let tempDir: string | null = null;
let mockCvServer: ReturnType<typeof Bun.serve> | null = null;
let runningServer: MijiaDeckServer | null = null;

function useTempDataDir(): string {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "mijiadeck-standby-denoise-"));
  const dir = tempDir;
  setDataPathOverrides({ dataDir: () => dir });
  return dir;
}

afterEach(async () => {
  if (runningServer) {
    await runningServer.stop();
    runningServer = null;
  }
  if (mockCvServer) {
    mockCvServer.stop(true);
    mockCvServer = null;
  }
  setDataPathOverrides(null);
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

function makeSine(durationSec: number, freqHz: number, amp: number, sr = SR): Float32Array {
  const len = Math.round(sr * durationSec);
  const out = new Float32Array(len);
  for (let i = 0; i < len; i += 1) {
    out[i] = Math.sin((2 * Math.PI * freqHz * i) / sr) * amp;
  }
  return out;
}

function makeSilence(durationSec: number, sr = SR): Float32Array {
  return new Float32Array(Math.round(sr * durationSec));
}

function pushChunked(session: VoiceStreamSession, samples: Float32Array, chunkSize = 1024): void {
  for (let off = 0; off < samples.length; off += chunkSize) {
    session.pushFloat32Samples(samples.subarray(off, Math.min(samples.length, off + chunkSize)));
  }
}

function estimateZeroCrossingHz(samples: Float32Array, sr = SR): number {
  if (samples.length < 64) return 0;
  let crossings = 0;
  for (let i = 1; i < samples.length; i += 1) {
    const a = samples[i - 1]!;
    const b = samples[i]!;
    if ((a <= 0 && b > 0) || (a >= 0 && b < 0)) crossings += 1;
  }
  return (crossings / 2) / (samples.length / sr);
}

function createEnergyMockVad(threshold = 0.02): StreamingVadHandleLike {
  let detected = false;
  return {
    acceptWaveform(samples: Float32Array) {
      detected = computeRms(samples) >= threshold;
    },
    isDetected: () => detected,
    isEmpty: () => true,
    front: () => ({ start: 0, samples: new Float32Array(0) }),
    pop: () => {},
    flush: () => {},
    clear: () => {},
    reset: () => {
      detected = false;
    },
  };
}

/**
 * 模拟支持 /separate 的 ClearVoice GPU 盲源分离服务：
 * - 将混合信号分离为 2 条独立音轨：
 *   - 轨 A：电视背景音（低频 180Hz）
 *   - 轨 B：干净用户人声唤醒信号（高频 920Hz，仅当混音中含高频成分时非零）
 * - 支持偶数切片故意交换两轨顺序，验证待机 PIT 置换对齐跨切片边界不串轨！
 */
function startMockMultiTrackClearVoiceServer(options: { swapEveryOtherSlice?: boolean } = {}) {
  let separateCalls = 0;
  const receivedLengths: number[] = [];

  const srv = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/health") {
        return Response.json({
          ok: true,
          model: "MossFormer2_SE_48K",
          provider: "CUDAExecutionProvider",
          device: "gpu",
          ssReady: true,
          ssModel: "MossFormer2_SS_16K",
          ssProvider: "CUDAExecutionProvider",
          ssDevice: "gpu",
          gpuName: "Mock RTX 3060",
          warmedUp: true,
        });
      }
      if (u.pathname === "/separate") {
        separateCalls += 1;
        const buf = await req.arrayBuffer();
        const mix = new Float32Array(buf);
        const n = mix.length;
        receivedLengths.push(n);

        // 简单正交解调分离：用 1 阶差分能量检测高频 920Hz 用户人声成分，还原纯净双轨
        const tvTrack = new Float32Array(n);
        const userTrack = new Float32Array(n);
        const win = 160;
        for (let off = 0; off < n; off += win) {
          const end = Math.min(n, off + win);
          // 分别计算 180Hz 与 920Hz 离散匹配幅度
          let c180 = 0, s180 = 0, c920 = 0, s920 = 0;
          const m = end - off;
          for (let i = off; i < end; i += 1) {
            const x = mix[i]!;
            const a1 = (2 * Math.PI * 180 * i) / SR;
            const a2 = (2 * Math.PI * 920 * i) / SR;
            c180 += x * Math.cos(a1);
            s180 += x * Math.sin(a1);
            c920 += x * Math.cos(a2);
            s920 += x * Math.sin(a2);
          }
          const amp180 = (2 * Math.hypot(c180, s180)) / Math.max(1, m);
          const amp920 = (2 * Math.hypot(c920, s920)) / Math.max(1, m);
          const ph180 = Math.atan2(s180, c180);
          const ph920 = Math.atan2(s920, c920);
          for (let i = off; i < end; i += 1) {
            if (amp180 > 0.02) {
              tvTrack[i] = amp180 * Math.cos((2 * Math.PI * 180 * i) / SR - ph180);
            }
            if (amp920 > 0.02) {
              userTrack[i] = amp920 * Math.cos((2 * Math.PI * 920 * i) / SR - ph920);
            }
          }
        }

        const shouldSwap = Boolean(options.swapEveryOtherSlice && separateCalls % 2 === 0);
        const tracks = shouldSwap ? [userTrack, tvTrack] : [tvTrack, userTrack];
        const packed = new Float32Array(n * 2);
        packed.set(tracks[0]!, 0);
        packed.set(tracks[1]!, n);

        return new Response(new Uint8Array(packed.buffer), {
          status: 200,
          headers: {
            "Content-Type": "application/octet-stream",
            "X-Sample-Rate": String(SR),
            "X-ClearVoice-Track-Count": "2",
            "X-ClearVoice-Samples-Per-Track": String(n),
            "X-ClearVoice-SS-Available": "1",
            "X-ClearVoice-Model": "MossFormer2_SS_16K+MossFormer2_SE_48K",
            "X-ClearVoice-Provider": "CUDAExecutionProvider",
            "X-ClearVoice-Device": "gpu",
            "X-ClearVoice-SS-Ms": "15.0",
            "X-ClearVoice-SE-Ms": "6.0",
            "X-ClearVoice-Infer-Ms": "21.0",
            "X-ClearVoice-Gpu-Name": "Mock RTX 3060",
          },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  mockCvServer = srv;
  return {
    server: srv,
    get separateCalls() {
      return separateCalls;
    },
    receivedLengths,
  };
}

/**
 * 频率选择性 Mock openWakeWord：
 * 模拟真实 openWakeWord 在电视低频混叠时无法命中（混音主频被拉低至 < 700Hz），
 * 只有经过盲源分离提取出纯净 920Hz 用户人声轨（主频 800..1050Hz 且 RMS >= 0.05）后才命中唤醒！
 */
function createCleanUserTrackOwwFactory() {
  let sessionsCreated = 0;
  let totalSpots = 0;
  const factory = (
    _wakeWords: string[],
    opts?: { threshold?: number; onSpot?: (hit: WakeWordAcousticHit) => void },
  ): OpenWakeWordStreamSession => {
    sessionsCreated += 1;
    let spotted = false;
    const mock = {
      hasActivePrototypes: true,
      pushSamples(samples: Float32Array, endSampleOffset: number) {
        if (spotted || samples.length < 320) return null;
        // 滑窗检测 200ms 片段：只有当音频足够纯净（主频 820..1040Hz 且 RMS >= 0.05）才命中唤醒
        const win = 3200;
        for (let off = 0; off + win <= samples.length; off += 1600) {
          const seg = samples.subarray(off, off + win);
          const rms = computeRms(seg);
          const hz = estimateZeroCrossingHz(seg, SR);
          if (rms >= 0.05 && hz >= 820 && hz <= 1040) {
            spotted = true;
            totalSpots += 1;
            const hitSample = Math.max(0, endSampleOffset - (samples.length - (off + win)));
            const hit: WakeWordAcousticHit = {
              matched: true,
              wakeWord: "Neo",
              score: 0.88,
              rawScore: 0.88,
              threshold: opts?.threshold ?? 0.6,
              source: "enrolled",
              frameIndex: 10,
              sampleOffset: hitSample,
              latencyMs: 3,
            };
            opts?.onSpot?.(hit);
            return hit;
          }
        }
        return null;
      },
      reloadPrototypes() {},
      resetSegmentTracking() {},
      reset() {
        spotted = false;
      },
      getPeakHit: () => null,
      getHeadPeakHit: () => null,
    };
    return mock as unknown as OpenWakeWordStreamSession;
  };
  return {
    factory,
    get sessionsCreated() {
      return sessionsCreated;
    },
    get totalSpots() {
      return totalSpots;
    },
  };
}

describe("StreamingDspDenoiser 连续流式纯 TS 降噪器", () => {
  test("在稳态宽带底噪下持续抑制噪声、保持样本长度对齐并提升信噪比", () => {
    const dsp = new StreamingDspDenoiser(SR);
    // 构造 1.0s 纯低频/宽带底噪 + 1.0s 语音正弦+底噪 + 0.5s 纯底噪
    const total = Math.round(SR * 2.5);
    const noisy = new Float32Array(total);
    let seed = 12345;
    const nextRand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return (seed / 0xffffffff) * 2 - 1;
    };
    for (let i = 0; i < total; i += 1) {
      const noise = nextRand() * 0.06;
      const speech =
        i >= SR * 1.0 && i < SR * 2.0 ? Math.sin((2 * Math.PI * 520 * i) / SR) * 0.22 : 0;
      noisy[i] = Math.max(-1, Math.min(1, noise + speech));
    }

    const out = new Float32Array(total);
    let write = 0;
    for (let off = 0; off < total; off += 1024) {
      const res = dsp.run({ samples: noisy.subarray(off, Math.min(total, off + 1024)), sampleRate: SR });
      out.set(res.samples, write);
      write += res.samples.length;
    }
    const tail = dsp.flush();
    out.set(tail.samples, write);
    write += tail.samples.length;

    expect(write).toBe(total);
    const inNoiseRms = computeRms(noisy.subarray(SR * 0.3, SR * 0.9));
    const outNoiseRms = computeRms(out.subarray(SR * 0.3, SR * 0.9));
    expect(outNoiseRms).toBeLessThan(inNoiseRms * 0.6);
    expect(estimateSnrDb(out, SR)).toBeGreaterThan(estimateSnrDb(noisy, SR));

    dsp.reset();
    const emptyFlush = dsp.flush();
    expect(emptyFlush.samples.length).toBe(0);
  });
});

describe("待机 ClearVoice 多轨盲源分离唤醒（抗电视背景音 + 零待机 ASR）", () => {
  test("连续播放电视时混合轨无法触发 OWW，待机 ClearVoice BSS+SE 分离出纯净用户轨后精准唤醒并回放环形缓冲", async () => {
    const dir = useTempDataDir();
    const cvMock = startMockMultiTrackClearVoiceServer({ swapEveryOtherSlice: true });
    const cvRuntime = new ClearVoiceGpuRuntime({
      modelsDir: dir,
      serviceUrl: `http://127.0.0.1:${cvMock.server.port}`,
    });
    const owwFactory = createCleanUserTrackOwwFactory();
    const asrCalls: number[] = [];

    const fakeEngine = {
      createOnlineDenoiser: () => null,
      createStreamingVad: () => createEnergyMockVad(0.02),
      createWakeWordStream: owwFactory.factory,
      clearVoiceGpu: cvRuntime,
      getStatus: () => ({
        readyForLocalAsr: true,
        activeQwen3Device: "gpu",
        readyForClearVoiceGpu: true,
        readyForClearVoiceBss: true,
        readyForDpdfnet: false,
        clearVoice: cvRuntime.getStatus(),
      }),
      denoise: (s: Float32Array) => ({
        samples: new Float32Array(s),
        sampleRate: SR,
        engine: "dsp" as const,
        inputSnrDb: 5,
        outputSnrDb: 10,
        snrGainDb: 5,
        durationMs: 1,
      }),
      transcribeLocal: async (samples: Float32Array): Promise<LocalAsrOutput> => {
        asrCalls.push(samples.length);
        return {
          text: "Neo，打开客厅吸顶灯",
          rawText: "Neo，打开客厅吸顶灯",
          lang: "zh",
          emotion: "",
          event: "",
          engine: "qwen3-asr-gpu",
          durationMs: 20,
        };
      },
    } as unknown as LocalVoiceEngine;

    const wakeSpots: WakeWordAcousticHit[] = [];
    const segments: VoiceStreamSegmentPayload[] = [];
    const partials: string[] = [];

    const session = new VoiceStreamSession({
      localEngine: fakeEngine,
      noiseMode: "auto",
      voicePipelineMode: "clearvoice",
      standbyClearVoiceStepMs: 1200,
      clearVoiceSilenceMs: 256,
      clearVoiceUtteranceSilenceMs: 600,
      clearVoiceMaxChunkMs: 1600,
      wakeRingLookbackMs: 1400,
      wakeWords: ["Neo"],
      wakeWordEnabled: true,
      owwEnabled: true,
      streamingAsrEnabled: true,
      onWakeWordSpot: (hit) => wakeSpots.push(hit),
      onPartialTranscript: (p) => partials.push(p.text),
      onSegmentReady: async (seg) => {
        segments.push(seg);
        return null;
      },
    });

    // 阶段 1：连续 2.6 秒纯电视背景音（180Hz 强干扰）-> 触发待机 ClearVoice 分离，但 0 误唤醒、0 ASR、0 字幕、0 分段！
    const pureTv = makeSine(2.6, 180, 0.35);
    pushChunked(session, pureTv);
    await session.waitForIdle();

    expect(cvMock.separateCalls).toBeGreaterThanOrEqual(2);
    expect(session.standbyClearVoiceProcessedSlices).toBeGreaterThanOrEqual(2);
    expect(wakeSpots.length).toBe(0);
    expect(asrCalls.length).toBe(0);
    expect(partials.length).toBe(0);
    expect(segments.length).toBe(0);
    expect(session.isWakeGatedStandby).toBe(true);

    // 阶段 2：电视持续播放的同时，用户叠加上 920Hz 唤醒词与指令（混合后被 180Hz 电视压制，快路径 OWW 无法直接命中！）
    const tvPlusUser = new Float32Array(Math.round(SR * 1.4));
    for (let i = 0; i < tvPlusUser.length; i += 1) {
      const tv = Math.sin((2 * Math.PI * 180 * i) / SR) * 0.35;
      // 仅在 0.2s..1.0s 说唤醒词+指令，之后 0.4s 用户停说但电视还在放
      const user = i >= SR * 0.2 && i < SR * 1.0 ? Math.sin((2 * Math.PI * 920 * i) / SR) * 0.16 : 0;
      tvPlusUser[i] = tv + user;
    }
    pushChunked(session, tvPlusUser);
    // 紧接 0.9s 静音收句
    pushChunked(session, makeSilence(0.9));
    await session.waitForIdle();

    // 待机 ClearVoice BSS+SE 分离出纯净用户轨 -> 成功触发声学唤醒 -> 自动回放环形缓冲并交付多轨唤醒分段！
    expect(wakeSpots.length).toBe(1);
    expect(wakeSpots[0]!.wakeWord).toBe("Neo");
    expect(segments.length).toBeGreaterThanOrEqual(1);
    expect(segments[0]!.wakeAnchored).toBe(true);
    expect(segments[0]!.pipelineMode).toBe("clearvoice");

    session.dispose();
  });

  test("在线降噪先于 AGC 执行，避免把背景噪声提前放大；且当 ClearVoice GPU 不可用时仍执行用户配置的 dpdfnet 在线降噪", async () => {
    const onlineRunInputs: number[] = [];
    const mockOnlineDenoiser: OnlineDenoiserHandleLike = {
      sampleRate: SR,
      frameShiftInSamples: 256,
      run(req) {
        onlineRunInputs.push(computeRms(req.samples));
        // 模拟降噪输出衰减一半能量
        const out = new Float32Array(req.samples.length);
        for (let i = 0; i < req.samples.length; i += 1) out[i] = req.samples[i]! * 0.5;
        return { samples: out, sampleRate: SR };
      },
      flush: () => ({ samples: new Float32Array(0), sampleRate: SR }),
      reset() {},
    };

    const owwPushedRms: number[] = [];
    const fakeEngine = {
      createOnlineDenoiser: (mode: string) =>
        mode === "dpdfnet" ? { denoiser: mockOnlineDenoiser, engine: "dpdfnet4" as const } : null,
      createStreamingVad: () => createEnergyMockVad(0.02),
      createWakeWordStream: () =>
        ({
          hasActivePrototypes: true,
          pushSamples(s: Float32Array) {
            owwPushedRms.push(computeRms(s));
            return null;
          },
          reloadPrototypes() {},
          resetSegmentTracking() {},
          reset() {},
          getPeakHit: () => null,
          getHeadPeakHit: () => null,
        }) as unknown as OpenWakeWordStreamSession,
      clearVoiceGpu: {
        getStatus: () => ({
          ready: false,
          multiTrackReady: false,
          provider: "none",
          ssProvider: "none",
        }),
        isInFailureCooldown: () => false,
      },
      getStatus: () => ({
        readyForLocalAsr: true,
        activeQwen3Device: "cpu",
        readyForClearVoiceGpu: false,
        readyForDpdfnet: true,
      }),
    } as unknown as LocalVoiceEngine;

    const session = new VoiceStreamSession({
      localEngine: fakeEngine,
      noiseMode: "dpdfnet",
      voicePipelineMode: "clearvoice",
      wakeWords: ["Neo"],
      wakeWordEnabled: true,
      owwEnabled: true,
      onSegmentReady: async () => null,
    });

    // 输入 RMS ≈ 0.014 的微弱噪声+语音（若先跑 AGC，会被拉高至 ~0.04+；先降噪则降噪器看到自然原始 RMS ≈ 0.014）
    const lowAudio = makeSine(0.5, 440, 0.02);
    pushChunked(session, lowAudio, 1024);

    // 关键断言 1：ClearVoice GPU 不可用时，用户配置的 dpdfnet4 绝不能被静默跳过！
    expect(onlineRunInputs.length).toBeGreaterThanOrEqual(7);
    // 关键断言 2：送入降噪器的是原始自然幅值（~0.014），未被前置 AGC 放大！
    for (const r of onlineRunInputs) {
      expect(r).toBeLessThan(0.018);
    }
    // 关键断言 3：降噪后的音频仍经过后置 AGC 抬升给 OWW
    expect(owwPushedRms.length).toBe(onlineRunInputs.length);
    expect(owwPushedRms[owwPushedRms.length - 1]!).toBeGreaterThan(0.009);

    session.dispose();
  });

  test("Legacy 模式下高环境噪待机自动介入 DPDFNet4 强噪增强通道并成功唤醒（安静环境零开销）", async () => {
    let dpdfCreated = 0;
    let dpdfRunCalls = 0;
    const gtcrnDenoiser: OnlineDenoiserHandleLike = {
      sampleRate: SR,
      frameShiftInSamples: 256,
      run: (req) => ({ samples: new Float32Array(req.samples), sampleRate: SR }),
      flush: () => ({ samples: new Float32Array(0), sampleRate: SR }),
      reset() {},
    };
    const dpdfDenoiser: OnlineDenoiserHandleLike = {
      sampleRate: SR,
      frameShiftInSamples: 256,
      run: (req) => {
        dpdfRunCalls += 1;
        // 模拟 DPDFNet4 剥离低频噪声后输出纯净 920Hz 用户声
        const out = new Float32Array(req.samples.length);
        for (let i = 0; i < out.length; i += 1) {
          out[i] = Math.sin((2 * Math.PI * 920 * i) / SR) * 0.16;
        }
        return { samples: out, sampleRate: SR };
      },
      flush: () => ({ samples: new Float32Array(0), sampleRate: SR }),
      reset() {},
    };

    const owwFactory = createCleanUserTrackOwwFactory();
    const fakeEngine = {
      createOnlineDenoiser: (mode: string) => {
        if (mode === "dpdfnet") {
          dpdfCreated += 1;
          return { denoiser: dpdfDenoiser, engine: "dpdfnet4" as const };
        }
        return { denoiser: gtcrnDenoiser, engine: "gtcrn" as const };
      },
      createStreamingVad: () => createEnergyMockVad(0.02),
      createWakeWordStream: owwFactory.factory,
      getStatus: () => ({
        readyForLocalAsr: true,
        activeQwen3Device: "cpu",
        readyForClearVoiceGpu: false,
        readyForDpdfnet: true,
      }),
    } as unknown as LocalVoiceEngine;

    const wakeSpots: WakeWordAcousticHit[] = [];
    const session = new VoiceStreamSession({
      localEngine: fakeEngine,
      noiseMode: "auto",
      voicePipelineMode: "legacy",
      wakeWords: ["Neo"],
      wakeWordEnabled: true,
      owwEnabled: true,
      onWakeWordSpot: (hit) => wakeSpots.push(hit),
      onSegmentReady: async () => null,
    });

    // 1. 安静环境（RMS < 0.005）：DPDFNet4 完全不初始化、零开销
    pushChunked(session, makeSine(1.0, 180, 0.004));
    expect(dpdfCreated).toBe(0);
    expect(dpdfRunCalls).toBe(0);

    // 2. 高环境噪（180Hz 噪声 RMS ≈ 0.15）：GTCRN 无法命中，但自动触发 DPDFNet4 通道并成功唤醒！
    pushChunked(session, makeSine(0.8, 180, 0.22));
    expect(dpdfCreated).toBe(1);
    expect(dpdfRunCalls).toBeGreaterThanOrEqual(1);
    expect(wakeSpots.length).toBe(1);
    expect(session.isAwake).toBe(true);

    session.dispose();
  });
});

describe("HTTP /api/voice/audio 待机门控 ClearVoice 降噪唤醒与热配置同步", () => {
  test("processAudioUpload 待机门控在原始与快速降噪均未命中时调用 ClearVoice BSS+SE 分轨检测并复用于 Stage 1.2（零重复 GPU 调用）", async () => {
    const dir = useTempDataDir();
    applyTheme("dark", "green");
    const cvMock = startMockMultiTrackClearVoiceServer({ swapEveryOtherSlice: false });

    addWakeWordPrototype({
      wakeWord: "Neo",
      source: "enrolled",
      voiceTag: "owner",
      embeddings: [Array.from({ length: 96 }, () => 0.1)],
    });

    const demo = new VirtualDemoService();
    const jobs = new JobExecutor();
    const networkMonitor = new NetworkMonitor({ initialReachability: "online", autoStart: false });
    const themeCtrl = new ThemeController("dark");
    const mw = new MainWindowController({
      service: demo,
      jobs,
      themeCtrl,
      networkMonitor,
      autoStartTimers: false,
      cacheLoader: () => null,
      cacheSaver: () => {},
    });
    mw.start();

    const agent = new PiAgentService({
      deps: { mainWindow: mw, service: demo, jobs, settingsStore, broadcastState: () => {} },
      initialConfig: normalizeAgentVoiceConfig({
        ...defaultAgentVoiceConfig(),
        voicePipelineMode: "clearvoice",
        clearVoiceServiceUrl: `http://127.0.0.1:${cvMock.server.port}`,
        noiseSuppressionMode: "auto",
        wakeWords: ["Neo"],
        wakeWordEnabled: true,
        owwEnabled: true,
        owwThreshold: 0.6,
        sourceSeparationMode: "off",
        attentionMode: "off",
      }),
    });
    const vl = new VoiceListenerController(agent);

    let asrCalls = 0;
    const engine = vl.localEngine as unknown as Record<string, unknown>;
    Object.defineProperty(vl.localEngine.openWakeWord, "isReady", {
      configurable: true,
      get: () => true,
    });
    // 只有分离出的纯净 920Hz 用户轨能过 openWakeWord（混音与 180Hz 电视轨均低分未命中）
    engine.scoreWakeWordAudio = (samples: Float32Array) => {
      const hz = estimateZeroCrossingHz(samples, SR);
      const matched = hz >= 800 && hz <= 1050 && computeRms(samples) >= 0.05;
      return {
        wakeWord: "Neo",
        score: matched ? 0.89 : 0.25,
        rawScore: matched ? 0.89 : 0.25,
        threshold: 0.6,
        matched,
        source: "enrolled",
        frameIndex: 5,
        sampleOffset: samples.length,
        latencyMs: 4,
      };
    };
    engine.denoise = (samples: Float32Array) => ({
      samples: new Float32Array(samples),
      sampleRate: SR,
      engine: "gtcrn" as const,
      inputSnrDb: 2,
      outputSnrDb: 4,
      snrGainDb: 2,
      durationMs: 2,
    });
    engine.getStatus = () => ({
      ...LocalVoiceEngine.prototype.getStatus.call(vl.localEngine),
      readyForLocalAsr: true,
      readyForWakeWord: true,
      readyForClearVoiceGpu: true,
      readyForClearVoiceBss: true,
      readyForSourceSeparation: false,
      clearVoice: vl.localEngine.clearVoiceGpu.getStatus(),
    });
    engine.detectSpeechSegments = (samples: Float32Array) => ({
      hasSpeech: computeRms(samples) >= 0.03,
      speechSamples: samples,
      speechRatio: 0.9,
      segmentCount: 1,
      engine: "adaptive" as const,
      durationMs: 1,
    });
    engine.transcribeLocal = async (samples: Float32Array): Promise<LocalAsrOutput> => {
      asrCalls += 1;
      const hz = estimateZeroCrossingHz(samples, SR);
      return {
        text: hz >= 800 ? "Neo，打开客厅吸顶灯" : "电视新闻播报今天天气晴朗",
        rawText: hz >= 800 ? "Neo，打开客厅吸顶灯" : "电视新闻播报今天天气晴朗",
        lang: "zh",
        emotion: "",
        event: "",
        engine: "qwen3-asr-gpu",
        durationMs: 15,
      };
    };

    try {
      // 1. 纯电视噪音（180Hz）：ClearVoice 分离后仍未命中唤醒 -> 严格零 ASR
      const tvOnlyWav = encodeWavPcm16(makeSine(1.2, 180, 0.35), SR);
      const tvBlocked = await vl.processAudioUpload(
        new Blob([tvOnlyWav.slice().buffer], { type: "audio/wav" }),
        { filename: "tv.wav", autoDispatch: true },
      );
      expect(tvBlocked.ok).toBe(true);
      expect(tvBlocked.asrEngine).toBe("skipped-unawakened");
      expect(tvBlocked.matched).toBe(false);
      expect(asrCalls).toBe(0);
      const callsAfterTv = cvMock.separateCalls;
      expect(callsAfterTv).toBe(1);

      // 2. 电视(180Hz) + 用户唤醒(920Hz) 混音：原始与 GTCRN 均未命中 -> ClearVoice 分轨命中 -> 直接复用分轨进入 Stage 1.2（仅增 1 次 GPU 调用！）
      const mix = new Float32Array(Math.round(SR * 1.2));
      for (let i = 0; i < mix.length; i += 1) {
        mix[i] = Math.sin((2 * Math.PI * 180 * i) / SR) * 0.35 + Math.sin((2 * Math.PI * 920 * i) / SR) * 0.16;
      }
      const mixWav = encodeWavPcm16(mix, SR);
      const woke = await vl.processAudioUpload(
        new Blob([mixWav.slice().buffer], { type: "audio/wav" }),
        { filename: "tv_plus_wake.wav", autoDispatch: true },
      );
      expect(woke.ok).toBe(true);
      expect(woke.matched).toBe(true);
      expect(woke.asrEngine).not.toBe("skipped-unawakened");
      expect(asrCalls).toBeGreaterThanOrEqual(1);
      // 复用 preSeparatedCv，不重复调用 ClearVoice GPU！
      expect(cvMock.separateCalls).toBe(callsAfterTv + 1);
    } finally {
      vl.dispose();
      agent.dispose();
      networkMonitor.stop();
      mw.dispose();
      await jobs.shutdown();
    }
  });

  test("通过 /api/agent/config 热更新 noiseSuppressionMode 实时同步至活跃 WebSocket VoiceStreamSession", async () => {
    useTempDataDir();
    runningServer = await startMijiaDeckServer({
      mode: "demo",
      port: 0,
      hostname: "127.0.0.1",
      service: new VirtualDemoService(),
    });

    const vl = runningServer.runtime.voiceListener!;
    const denoiserModes: string[] = [];
    const engine = vl.localEngine as unknown as Record<string, unknown>;
    engine.createOnlineDenoiser = (mode: string) => {
      denoiserModes.push(mode);
      return null;
    };
    engine.createWakeWordStream = () => null;
    engine.createStreamingVad = () => createEnergyMockVad(0.02);

    const wsUrl = `${runningServer.url.replace("http://", "ws://")}/ws`;
    const ws = new WebSocket(wsUrl);
    let started = false;
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = (e) => reject(e);
    });
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as { type?: string; kind?: string };
        if (msg.type === "voice_stream_event" && msg.kind === "started") {
          started = true;
        }
      } catch {
        // ignore
      }
    };

    ws.send(JSON.stringify({ type: "voice_stream_start", sampleRate: SR, lang: "zh-CN" }));
    const deadline = Date.now() + 2000;
    while (!started && Date.now() < deadline) {
      await Bun.sleep(15);
    }
    expect(started).toBe(true);
    expect(denoiserModes).toEqual(["auto"]);

    const res = await fetch(`${runningServer.url}/api/agent/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ noiseSuppressionMode: "dpdfnet" }),
    });
    expect(res.ok).toBe(true);
    expect(denoiserModes).toEqual(["auto", "dpdfnet"]);

    ws.send(JSON.stringify({ type: "voice_stream_stop" }));
    ws.close();
  });
});

describe("真实 ONNX + ClearVoice GPU 连续电视播放下待机唤醒端到端验证", () => {
  test.if(HAS_BENCH_WAVS)(
    "持续播放真实电视广播（0dB SNR 压过用户声）：待机纯电视零误触发/零 ASR，叠加真实「Neo，打开客厅吸顶灯」后通过待机 ClearVoice BSS+SE 成功唤醒并完整转写",
    async () => {
      useTempDataDir();
      const engine = new LocalVoiceEngine();
      const status = engine.getStatus();
      if (
        !status.readyForLocalAsr ||
        !status.readyForWakeWord ||
        !status.readyForClearVoiceGpu ||
        !status.readyForClearVoiceBss ||
        status.clearVoice.provider !== "cuda"
      ) {
        engine.dispose();
        return;
      }

      const wakeWords = ["Neo"];
      await engine.openWakeWord.bootstrapWakeWords(wakeWords);
      const userClip = decodeWavPcm(
        new Uint8Array(readFileSync(path.join(BENCH_AUDIO_DIR, "clip_001.wav"))),
      ).samples;
      engine.openWakeWord.enrollSample("Neo", userClip.subarray(0, Math.round(SR * 0.85)), {
        voiceTag: "owner",
      });
      await engine.clearVoiceGpu.warmup();

      const tvRaw = decodeWavPcm(
        new Uint8Array(readFileSync(path.join(BENCH_AUDIO_DIR, "clip_066.wav"))),
      ).samples;

      // 构造 8.5s 连续电视播放流：前 3.8s 为纯电视，3.8s 处以 0dB SNR 叠加真实用户「Neo，打开客厅吸顶灯」，之后继续播放电视至结尾
      const totalSamples = Math.round(SR * 8.5);
      const mixedStream = new Float32Array(totalSamples);
      for (let i = 0; i < totalSamples; i += 1) {
        mixedStream[i] = tvRaw[i % tvRaw.length]!;
      }
      const tvRms = computeRms(mixedStream);
      const userRms = computeRms(userClip);
      const gain = userRms > 1e-6 ? tvRms / userRms : 1; // 0 dB SNR（电视与人声等响）
      const insertAt = Math.round(SR * 3.8);
      for (let i = 0; i < userClip.length && insertAt + i < totalSamples; i += 1) {
        mixedStream[insertAt + i] = Math.max(
          -0.98,
          Math.min(0.98, mixedStream[insertAt + i]! + userClip[i]! * gain),
        );
      }

      const wakeSpots: WakeWordAcousticHit[] = [];
      const segments: VoiceStreamSegmentPayload[] = [];
      const partials: string[] = [];

      const session = new VoiceStreamSession({
        localEngine: engine,
        noiseMode: "auto",
        voicePipelineMode: "clearvoice",
        vadSilenceMs: 900,
        wakeWords,
        wakeWordEnabled: true,
        owwEnabled: true,
        owwThreshold: 0.6,
        streamingAsrEnabled: false,
        onWakeWordSpot: (hit) => wakeSpots.push(hit),
        onPartialTranscript: (p) => partials.push(p.text),
        onSegmentReady: async (seg) => {
          segments.push(seg);
          return null;
        },
      });

      try {
        // 先只推送前 3.2s 纯电视音频 -> 严格 0 误触发、0 分段、0 字幕！
        pushChunked(session, mixedStream.subarray(0, Math.round(SR * 3.2)), 1024);
        await session.waitForIdle();
        expect(session.standbyClearVoiceProcessedSlices).toBeGreaterThanOrEqual(2);
        expect(wakeSpots.length).toBe(0);
        expect(segments.length).toBe(0);
        expect(partials.length).toBe(0);

        // 推送剩余电视 + 0dB 叠加「Neo，打开客厅吸顶灯」音频 + 1.2s 结尾静音
        pushChunked(session, mixedStream.subarray(Math.round(SR * 3.2)), 1024);
        pushChunked(session, makeSilence(1.2), 1024);
        await session.flush();
        await session.waitForIdle();

        expect(wakeSpots.length).toBeGreaterThanOrEqual(1);
        expect(segments.length).toBeGreaterThanOrEqual(1);
        expect(segments.some((s) => s.wakeAnchored)).toBe(true);

        // 对唤醒交付的分离音轨执行真实本地 ASR，验证完整指令「客厅吸顶灯」未被电视吞掉！
        let combinedText = "";
        for (const seg of segments) {
          const tracks =
            seg.separatedTracks && seg.separatedTracks.length > 0
              ? seg.separatedTracks.map((t) => t.samples)
              : [seg.denoisedSamples];
          for (const tr of tracks) {
            const asr = await engine.transcribeLocal(tr, SR, "zh-CN", { hotwords: wakeWords });
            combinedText += ` ${asr.text}`;
          }
        }
        expect(combinedText).toContain("客厅吸顶灯");
      } finally {
        session.dispose();
        engine.dispose();
      }
    },
    180_000,
  );
});
