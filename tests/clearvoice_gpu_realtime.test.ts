// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: ClearVoice GPU 准实时切片降噪 -> Qwen3-ASR 单元测试与端到端集成测试

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { decodeWavPcm, encodeWavPcm16, resampleLinear } from "../src/agent/audioPcm.ts";
import {
  applyLinearCrossfade,
  ClearVoiceRealtimeChunker,
  ClearVoiceSliceAssembler,
  DEFAULT_CLEARVOICE_CHUNKER_CONFIG,
} from "../src/agent/clearVoiceChunker.ts";
import { ClearVoiceGpuRuntime } from "../src/agent/clearVoiceGpuRuntime.ts";
import {
  LocalVoiceEngine,
  type LocalAsrOutput,
  type StreamingVadHandleLike,
} from "../src/agent/localVoiceEngine.ts";
import {
  VoiceStreamSession,
  type VoiceStreamSegmentPayload,
} from "../src/agent/voiceStreamSession.ts";
import {
  defaultAgentVoiceConfig,
  loadAgentVoiceConfig,
  normalizeVoicePipelineMode,
  updateAgentVoiceConfig,
} from "../src/core/agentConfigStore.ts";
import { setDataPathOverrides } from "../src/core/jsonStore.ts";
import { VirtualDemoService } from "../src/core/virtualLightService.ts";
import { startMijiaDeckServer, type MijiaDeckServer } from "../src/server/server.ts";

let tmpDir = "";
let server: MijiaDeckServer | null = null;
let mockCvServer: ReturnType<typeof Bun.serve> | null = null;

function createEnergyMockVad(threshold = 0.02): StreamingVadHandleLike {
  let detected = false;
  return {
    acceptWaveform(samples: Float32Array) {
      let sum = 0;
      for (let i = 0; i < samples.length; i += 1) {
        const s = samples[i]!;
        sum += s * s;
      }
      const rms = Math.sqrt(sum / Math.max(1, samples.length));
      detected = rms >= threshold;
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

function makeSine(durationSec: number, sampleRate = 16000, freqHz = 440, amp = 0.25): Float32Array {
  const n = Math.round(durationSec * sampleRate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    out[i] = Math.sin((2 * Math.PI * freqHz * i) / sampleRate) * amp;
  }
  return out;
}

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "mijiadeck-clearvoice-test-"));
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

describe("ClearVoice 准实时切片器与边界交叉淡入淡出单元测试", () => {
  test("双触发规则 1（优先静音触发）：检测到人声后停顿达到 280ms 立即截断并携带 0.3s 历史上下文", () => {
    const vad = createEnergyMockVad(0.02);
    const activityLog: boolean[] = [];
    const chunker = new ClearVoiceRealtimeChunker({
      sampleRate: 16000,
      frameSizeMs: 32,
      silenceTriggerMs: 280,
      maxChunkMs: 2000,
      lookbackMs: 300,
      crossfadeMs: 20,
      preRollMs: 160,
      minSpeechMs: 160,
      vad,
      onSpeechActivity: (s) => activityLog.push(s),
    });

    // 先喂入 0.5s 安静底噪，填充环形历史缓冲区
    const leadQuiet = makeSine(0.5, 16000, 100, 0.003);
    expect(chunker.pushSamples(leadQuiet)).toHaveLength(0);

    // 说话 0.8s（不足 2.0s 上限）
    const speech = makeSine(0.8, 16000, 440, 0.25);
    expect(chunker.pushSamples(speech)).toHaveLength(0);
    expect(chunker.isSpeaking).toBe(true);

    // 静音停顿 224ms（未达到 280ms 阈值，不应截断）
    expect(chunker.pushSamples(new Float32Array(Math.round(16000 * 0.224)))).toHaveLength(0);

    // 继续静音至 >= 280ms，立刻触发静音切分
    const emitted = chunker.pushSamples(new Float32Array(Math.round(16000 * 0.128)));
    expect(emitted).toHaveLength(1);
    const chunk = emitted[0]!;
    expect(chunk.triggerReason).toBe("silence");
    expect(chunk.utteranceEnded).toBe(true);
    expect(chunk.needsCrossfade).toBe(false);
    // 头部拼接了 0.3s (4800 样本) 历史上下文
    expect(chunk.lookbackSamples).toBe(Math.round(16000 * 0.3));
    expect(chunk.rawWithContext.length).toBe(chunk.lookbackSamples + chunk.rawNewSamples.length);
    // 活动状态正确完成 start -> end 闭环
    expect(activityLog).toEqual([true, false]);
  });

  test("双触发规则 2（兜底超时强制触发）：连续不停顿快语速满 2.0s 强制切分，续段自动拼接 0.3s 上下文并标记需要 20ms Cross-fade", () => {
    const vad = createEnergyMockVad(0.02);
    const chunker = new ClearVoiceRealtimeChunker({
      sampleRate: 16000,
      frameSizeMs: 32,
      silenceTriggerMs: 280,
      maxChunkMs: 2000,
      lookbackMs: 300,
      crossfadeMs: 20,
      preRollMs: 160,
      vad,
    });

    // 连续不停顿讲话 3.2s -> 应在第 1 次达到 2.0s 时触发 timeout 强制切分
    const continuousSpeech = makeSine(3.2, 16000, 520, 0.28);
    const midChunks = chunker.pushSamples(continuousSpeech);
    expect(midChunks.length).toBe(1);
    expect(midChunks[0]!.triggerReason).toBe("timeout");
    expect(midChunks[0]!.utteranceEnded).toBe(false);
    expect(midChunks[0]!.durationMs).toBeGreaterThanOrEqual(1980);
    expect(midChunks[0]!.durationMs).toBeLessThanOrEqual(2050);

    // 随后停顿 320ms -> 静音触发收尾第二段，携带精确 0.3s 历史上下文并启用 20ms Cross-fade
    const tailChunks = chunker.pushSamples(new Float32Array(Math.round(16000 * 0.32)));
    expect(tailChunks.length).toBe(1);
    const second = tailChunks[0]!;
    expect(second.triggerReason).toBe("silence");
    expect(second.utteranceEnded).toBe(true);
    expect(second.needsCrossfade).toBe(true);
    expect(second.lookbackSamples).toBe(Math.round(16000 * 0.3));
    // 验证历史上下文内容精确等于第一段末尾的 0.3s 原始音频
    const firstTail = midChunks[0]!.rawNewSamples.subarray(
      midChunks[0]!.rawNewSamples.length - second.lookbackSamples,
    );
    const secondCtx = second.rawWithContext.subarray(0, second.lookbackSamples);
    let maxDiff = 0;
    for (let i = 0; i < firstTail.length; i += 1) {
      maxDiff = Math.max(maxDiff, Math.abs(firstTail[i]! - secondCtx[i]!));
    }
    expect(maxDiff).toBeLessThan(1e-6);
  });

  test("阶段 1 重采样支持：48kHz 输入音频自动重采样至 16kHz 驱动双触发切片", () => {
    const vad = createEnergyMockVad(0.02);
    const chunker = new ClearVoiceRealtimeChunker({
      sampleRate: 16000,
      inputSampleRate: 48000,
      silenceTriggerMs: 280,
      maxChunkMs: 2000,
      vad,
    });

    const speech48k = makeSine(0.7, 48000, 400, 0.25);
    const silence48k = new Float32Array(Math.round(48000 * 0.35));
    const c1 = chunker.pushSamples(speech48k);
    const c2 = chunker.pushSamples(silence48k);
    expect(c1.length).toBe(0);
    expect(c2.length).toBe(1);
    expect(c2[0]!.triggerReason).toBe("silence");
    expect(c2[0]!.rawNewSamples.length).toBeGreaterThan(10000);
  });

  test("阶段 3 + 阶段 4（裁剪 0.3s 历史输出 + 20ms 线性交叉淡入淡出）：彻底消除阶跃跳变且零时间漂移", () => {
    // 1. 直接校验 applyLinearCrossfade 线性淡入淡出权重
    const tail = new Float32Array(320).fill(1.0);
    const head = new Float32Array(320).fill(-1.0);
    const faded = applyLinearCrossfade(tail, head);
    expect(faded.length).toBe(320);
    expect(faded[0]!).toBeCloseTo(1.0, 5);
    expect(faded[319]!).toBeCloseTo(-1.0, 5);
    expect(Math.abs(faded[160]!)).toBeLessThan(0.01);

    // 2. 模拟两段有直流偏移跳变 (+0.8 -> -0.8) 的连续切片经过 ClearVoiceSliceAssembler 拼接
    const sr = 16000;
    const lookbackN = Math.round(sr * 0.3); // 4800
    const cfN = Math.round(sr * 0.02); // 320
    const assembler = new ClearVoiceSliceAssembler({ sampleRate: sr, crossfadeMs: 20 });

    const slice1Out = new Float32Array(16000).fill(0.8);
    const r1 = assembler.appendEnhancedSlice({
      enhancedWithContext: slice1Out,
      lookbackSamples: 0,
      newSamples: 16000,
      applyCrossfade: false,
    });
    expect(r1.crossfadeApplied).toBe(false);
    expect(r1.stitchedTotalSamples).toBe(16000);

    // 第二段：前 4800 样本为 0.3s 历史上下文，后 12000 样本为新增部分，均输出 -0.8
    const slice2Out = new Float32Array(lookbackN + 12000).fill(-0.8);
    const r2 = assembler.appendEnhancedSlice({
      enhancedWithContext: slice2Out,
      lookbackSamples: lookbackN,
      newSamples: 12000,
      applyCrossfade: true,
    });
    expect(r2.crossfadeApplied).toBe(true);
    expect(assembler.crossfadeCount).toBe(1);
    // 严格保持精确总时长 (16000 + 12000 = 28000)，零重复、零漂移！
    expect(r2.stitchedTotalSamples).toBe(28000);

    const stitched = assembler.getStitchedAudio();
    expect(stitched.length).toBe(28000);
    // 校验交界处最大相邻采样差分远小于硬切跳变 (1.6)
    let maxStep = 0;
    for (let i = 16000 - cfN - 2; i < 16000 + 2; i += 1) {
      maxStep = Math.max(maxStep, Math.abs(stitched[i + 1]! - stitched[i]!));
    }
    expect(maxStep).toBeLessThan(0.02);
  });
});

describe("ClearVoice 配置持久化、热切换按钮 API 与准实时流集成", () => {
  test("voicePipelineMode 与 clearVoiceServiceUrl 规范化及持久化", () => {
    expect(defaultAgentVoiceConfig().voicePipelineMode).toBe("legacy");
    expect(normalizeVoicePipelineMode("clearvoice")).toBe("clearvoice");
    expect(normalizeVoicePipelineMode("mossformer2")).toBe("clearvoice");
    expect(normalizeVoicePipelineMode("new")).toBe("clearvoice");
    expect(normalizeVoicePipelineMode("original")).toBe("legacy");
    expect(normalizeVoicePipelineMode("unknown-mode")).toBe("legacy");

    const updated = updateAgentVoiceConfig({
      voicePipelineMode: "clearvoice",
      clearVoiceServiceUrl: "http://127.0.0.1:18999/",
    });
    expect(updated.voicePipelineMode).toBe("clearvoice");
    expect(updated.clearVoiceServiceUrl).toBe("http://127.0.0.1:18999");

    const reloaded = loadAgentVoiceConfig();
    expect(reloaded.voicePipelineMode).toBe("clearvoice");
    expect(reloaded.clearVoiceServiceUrl).toBe("http://127.0.0.1:18999");

    const switchedBack = updateAgentVoiceConfig({ voicePipelineMode: "legacy" });
    expect(switchedBack.voicePipelineMode).toBe("legacy");
  });

  test("VoiceStreamSession 在 ClearVoice 新方案下完整跑通：双触发切片 -> 在线网关 -> 裁剪与淡入淡出 -> Qwen3-ASR 交付", async () => {
    // 启动轻量 Mock 在线 ClearVoice 网关服务，验证 WAV 表单上传与 0.3s lookback 传递
    const receivedLengths: number[] = [];
    mockCvServer = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const u = new URL(req.url);
        if (u.pathname === "/health") {
          return Response.json({
            status: "ok",
            upstreams: {
              clearvoice: {
                status: "ok",
                details: {
                  status: "ok",
                  gpu_name: "Mock Online GPU",
                  loaded_models: [{ name: "MossFormer2_SE_48K", task: "speech_enhancement" }],
                },
              },
            },
          });
        }
        if (u.pathname === "/clearvoice/v1/enhance") {
          const form = await req.formData();
          const file = form.get("file") as Blob;
          const decoded = decodeWavPcm(new Uint8Array(await file.arrayBuffer()));
          receivedLengths.push(decoded.samples.length);
          // 模拟降噪（轻微衰减幅值以产生可验证信号变化）
          const out = new Float32Array(decoded.samples.length);
          for (let i = 0; i < decoded.samples.length; i += 1) {
            out[i] = decoded.samples[i]! * 0.85;
          }
          const wav = encodeWavPcm16(out, decoded.sampleRate);
          return new Response(new Uint8Array(wav), {
            status: 200,
            headers: {
              "Content-Type": "audio/wav",
              "X-ClearVoice-Model": "MossFormer2_SE_48K",
              "X-Elapsed-Ms": "28.5",
            },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });

    const cvRuntime = new ClearVoiceGpuRuntime({
      serviceUrl: `http://127.0.0.1:${mockCvServer.port}`,
    });

    const fakeEngine = {
      createOnlineDenoiser: () => null,
      createStreamingVad: () => createEnergyMockVad(0.02),
      createWakeWordStream: () => null,
      clearVoiceGpu: cvRuntime,
      getStatus: () => ({
        readyForLocalAsr: true,
        activeQwen3Device: "remote",
        readyForClearVoiceGpu: true,
        clearVoice: cvRuntime.getStatus(),
      }),
      denoise: (s: Float32Array) => ({
        samples: s,
        sampleRate: 16000,
        engine: "dsp" as const,
        inputSnrDb: 10,
        outputSnrDb: 15,
        snrGainDb: 5,
        durationMs: 2,
      }),
      transcribeLocal: async (): Promise<LocalAsrOutput> => ({
        text: "小派，打开客厅吸顶灯",
        rawText: "小派，打开客厅吸顶灯",
        lang: "zh",
        emotion: "",
        event: "",
        engine: "qwen3-asr-remote",
        durationMs: 140,
        computeDevice: "remote",
      }),
    } as unknown as LocalVoiceEngine;

    const emittedSegments: VoiceStreamSegmentPayload[] = [];
    const partials: string[] = [];

    const session = new VoiceStreamSession({
      localEngine: fakeEngine,
      noiseMode: "auto",
      voicePipelineMode: "clearvoice",
      streamingAsrEnabled: true,
      isInConversation: () => true,
      wakeWords: ["小派"],
      onPartialTranscript: (p) => partials.push(p.text),
      onSegmentReady: async (seg) => {
        emittedSegments.push(seg);
        return null;
      },
    });

    expect(session.voicePipelineMode).toBe("clearvoice");

    // 连续讲话 2.5s（先在 2.0s 触发一次 timeout 强制切分）+ 0.35s 静音（触发 silence 收尾）
    session.pushFloat32Samples(makeSine(2.5, 16000, 440, 0.25));
    session.pushFloat32Samples(new Float32Array(Math.round(16000 * 0.35)));
    await session.flush();
    await session.waitForIdle();

    // 在线 ClearVoice 网关收到 2 个切片（第 1 段 timeout 强制切分 + 第 2 段带 0.3s 历史上下文的 silence 切分）
    expect(receivedLengths.length).toBe(2);
    expect(receivedLengths[1]!).toBeGreaterThan(Math.round(16000 * 0.3));
    // 超时切分阶段实时刷出了流式字幕预览
    expect(partials.length).toBeGreaterThanOrEqual(1);
    expect(partials[0]).toContain("打开客厅吸顶灯");
    // 最终交付给 Qwen3-ASR 的完整段附带清晰 ClearVoice 元数据（含 2 次切片与 1 次 20ms 交叉淡入淡出）
    expect(emittedSegments.length).toBe(1);
    const seg = emittedSegments[0]!;
    expect(seg.pipelineMode).toBe("clearvoice");
    expect(seg.denoiseEngine).toBe("clearvoice-mossformer2-remote");
    expect(seg.clearVoiceMeta?.sliceCount).toBe(2);
    expect(seg.clearVoiceMeta?.crossfadeCount).toBe(1);
    expect(seg.denoisedSamples.length).toBe(seg.rawSamples.length);

    // 运行期无缝热切回原方案（legacy）
    session.setVoicePipelineMode("legacy");
    expect(session.voicePipelineMode).toBe("legacy");
    session.dispose();
  });

  test("HTTP /api/agent/config 切换新旧方案开关并同步 VoiceListenerSnapshot 与 UI 节点", async () => {
    server = await startMijiaDeckServer({
      mode: "demo",
      port: 0,
      hostname: "127.0.0.1",
      service: new VirtualDemoService(),
    });

    // 默认应为原方案 legacy
    const initialRes = await fetch(`${server.url}/api/voice-listen/state`);
    expect(initialRes.ok).toBe(true);
    const initialJson = (await initialRes.json()) as {
      voice: { voicePipelineMode: string; localEngine: { clearVoice: { modelName: string } } };
    };
    expect(initialJson.voice.voicePipelineMode).toBe("legacy");
    expect(initialJson.voice.localEngine.clearVoice.modelName).toBe("MossFormer2_SE_48K");

    // 切换为新方案 clearvoice
    const switchRes = await fetch(`${server.url}/api/agent/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ voicePipelineMode: "clearvoice" }),
    });
    expect(switchRes.ok).toBe(true);
    const switchJson = (await switchRes.json()) as {
      config: { voicePipelineMode: string };
      voice: { voicePipelineMode: string };
    };
    expect(switchJson.config.voicePipelineMode).toBe("clearvoice");
    expect(switchJson.voice.voicePipelineMode).toBe("clearvoice");

    // 切回原方案 legacy
    const backRes = await fetch(`${server.url}/api/agent/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ voicePipelineMode: "legacy" }),
    });
    expect(backRes.ok).toBe(true);
    const backJson = (await backRes.json()) as {
      config: { voicePipelineMode: string };
      voice: { voicePipelineMode: string };
    };
    expect(backJson.config.voicePipelineMode).toBe("legacy");
    expect(backJson.voice.voicePipelineMode).toBe("legacy");

    // 确认前端 HTML 包含抽屉快捷切换按钮与设置页切换开关
    const htmlRes = await fetch(`${server.url}/`);
    const html = await htmlRes.text();
    expect(html).toContain("pi-voice-pipeline-toggle-btn");
    expect(html).toContain("set-voice-clearvoice-enabled");
    expect(html).toContain("badge-model-clearvoice");
  });
});

// ---------------------------------------------------------------------------
// 在线 ClearVoice (MossFormer2_SE_48K) -> 在线 Qwen3-ASR 端到端实测（配置了在线网关且样本就绪时自动运行）
// ---------------------------------------------------------------------------

const REAL_MODELS_DIR = process.env.MIJIADECK_VOICE_MODELS_DIR || "";
const REAL_BENCH_WAV = path.resolve(import.meta.dir, "../benchmarks/voice_sep_100/audio/clip_001.wav");

describe("在线 ClearVoice (MossFormer2_SE_48K) -> Qwen3-ASR 端到端验证", () => {
  test(
    "在线 ClearVoice 服务降噪 + Qwen3-ASR 转写端到端链路",
    async () => {
      const engine = new LocalVoiceEngine(
        REAL_MODELS_DIR ? { modelsDir: REAL_MODELS_DIR } : {},
      );
      const status = engine.getStatus();
      if (!status.readyForClearVoiceGpu || !status.readyForQwen3Asr || !existsSync(REAL_BENCH_WAV)) {
        // 未配置在线 ClearVoice / Qwen3-ASR 网关或无录音样本时跳过实测
        engine.dispose();
        return;
      }

      try {
        const decoded = decodeWavPcm(new Uint8Array(readFileSync(REAL_BENCH_WAV)));
        const pcm16k =
          decoded.sampleRate === 16000
            ? decoded.samples
            : resampleLinear(decoded.samples, decoded.sampleRate, 16000);

        const cvOut = await engine.clearVoiceGpu.enhanceOfflineWithChunking(pcm16k, 16000, {
          maxChunkMs: DEFAULT_CLEARVOICE_CHUNKER_CONFIG.maxChunkMs,
          lookbackMs: DEFAULT_CLEARVOICE_CHUNKER_CONFIG.lookbackMs,
          crossfadeMs: DEFAULT_CLEARVOICE_CHUNKER_CONFIG.crossfadeMs,
        });
        expect(cvOut.samples.length).toBe(pcm16k.length);
        expect(cvOut.sliceCount).toBeGreaterThanOrEqual(1);
        expect(cvOut.engine).toContain("clearvoice-mossformer2");

        const asrOut = await engine.transcribeLocal(cvOut.samples, 16000, "zh-CN", {
          engine: "qwen3-asr",
        });
        expect(asrOut.text.trim().length).toBeGreaterThan(0);
        expect(asrOut.engine).toContain("qwen3-asr");
      } finally {
        engine.dispose();
      }
    },
    120_000,
  );
});
