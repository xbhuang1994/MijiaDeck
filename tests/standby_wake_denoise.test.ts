// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 待机未唤醒状态降噪与强噪唤醒测试套件

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  computeRms,
  estimateSnrDb,
  StreamingDspDenoiser,
} from "../src/agent/audioPcm.ts";
import type {
  LocalVoiceEngine,
  OnlineDenoiserHandleLike,
  StreamingVadHandleLike,
} from "../src/agent/localVoiceEngine.ts";
import type {
  OpenWakeWordStreamSession,
  WakeWordAcousticHit,
} from "../src/agent/openWakeWordEngine.ts";
import { VoiceStreamSession } from "../src/agent/voiceStreamSession.ts";
import { setDataPathOverrides } from "../src/core/jsonStore.ts";
import { VirtualDemoService } from "../src/core/virtualLightService.ts";
import { startMijiaDeckServer, type MijiaDeckServer } from "../src/server/server.ts";

const SR = 16000;

let tempDir: string | null = null;
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
 * 频率选择性 Mock openWakeWord：
 * 模拟真实 openWakeWord 在低频噪声混叠时无法命中（混音主频被拉低至 < 700Hz），
 * 只有经过强效降噪提取出纯净 920Hz 用户人声（主频 820..1040Hz 且 RMS >= 0.05）后才命中唤醒！
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

describe("待机强噪降噪顺序与 DPDFNet4 按需唤醒增强（零待机 ASR）", () => {
  test("在线降噪先于 AGC 执行，避免把背景噪声提前放大；并尊重用户配置的 dpdfnet 在线降噪", async () => {
    const onlineRunInputs: number[] = [];
    const mockOnlineDenoiser: OnlineDenoiserHandleLike = {
      sampleRate: SR,
      frameShiftInSamples: 256,
      run(req) {
        onlineRunInputs.push(computeRms(req.samples));
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
      getStatus: () => ({
        readyForLocalAsr: true,
        readyForDpdfnet: true,
      }),
    } as unknown as LocalVoiceEngine;

    const session = new VoiceStreamSession({
      localEngine: fakeEngine,
      noiseMode: "dpdfnet",
      voicePipelineMode: "legacy",
      wakeWords: ["Neo"],
      wakeWordEnabled: true,
      owwEnabled: true,
      onSegmentReady: async () => null,
    });

    // 输入 RMS ≈ 0.014 的微弱噪声+语音（若先跑 AGC，会被拉高至 ~0.04+；先降噪则降噪器看到自然原始 RMS ≈ 0.014）
    const lowAudio = makeSine(0.5, 440, 0.02);
    pushChunked(session, lowAudio, 1024);

    // 关键断言 1：用户配置的 dpdfnet4 绝不能被静默跳过
    expect(onlineRunInputs.length).toBeGreaterThanOrEqual(7);
    // 关键断言 2：送入降噪器的是原始自然幅值（~0.014），未被前置 AGC 放大
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

    // 2. 高环境噪（180Hz 噪声 RMS ≈ 0.15）：GTCRN 无法命中，但自动触发 DPDFNet4 通道并成功唤醒
    pushChunked(session, makeSine(0.8, 180, 0.22));
    expect(dpdfCreated).toBe(1);
    expect(dpdfRunCalls).toBeGreaterThanOrEqual(1);
    expect(wakeSpots.length).toBe(1);
    expect(session.isAwake).toBe(true);

    session.dispose();
  });
});

describe("HTTP /api/agent/config 热配置同步", () => {
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
