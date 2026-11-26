// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 回归测试 — 修复每次说完话后必现尾音碎片（如“呀。” / 未知声纹 10% / 降噪 +48.9dB / ClearVoice 忽略卡片）

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  computeRms,
  decodeWavPcm,
  encodeWavPcm16,
  hasAudibleAudioEnergy,
  l2Normalize,
} from "../src/agent/audioPcm.ts";
import { ClearVoiceRealtimeChunker } from "../src/agent/clearVoiceChunker.ts";
import {
  capDenoisedGainToInput,
  ClearVoiceGpuRuntime,
} from "../src/agent/clearVoiceGpuRuntime.ts";
import { evaluateTtsEcho, TtsEchoGuard } from "../src/agent/echoGuard.ts";
import type {
  LocalAsrOutput,
  LocalVoiceEngine,
  StreamingVadHandleLike,
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
import { MainWindowController } from "../src/ui/controllers/mainWindowController.ts";
import { ThemeController } from "../src/ui/theme.ts";

let tmpDir = "";
let mockCvServer: ReturnType<typeof Bun.serve> | null = null;

function makeSine(durationSec: number, sampleRate = 16000, freqHz = 440, amp = 0.22): Float32Array {
  const n = Math.round(durationSec * sampleRate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    out[i] = Math.sin((2 * Math.PI * freqHz * i) / sampleRate) * amp;
  }
  return out;
}

function makeSilence(durationSec: number, sampleRate = 16000): Float32Array {
  return new Float32Array(Math.round(durationSec * sampleRate));
}

function createTriggerableMockVad(isVoiceFn: (samples: Float32Array) => boolean): StreamingVadHandleLike {
  let detected = false;
  return {
    acceptWaveform(samples: Float32Array) {
      detected = isVoiceFn(samples);
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
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "mijiadeck-trailing-noise-"));
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

describe("Layer 1 & 4: ClearVoice 远端 SE 物理增益上限护栏与微弱尾音早退", () => {
  test("capDenoisedGainToInput 阻止远端峰值归一化把微弱底噪/气音放大成高电平碎片，同时对正常人声零衰减", () => {
    // 1. 极微弱底噪/气音（RMS ~ 0.0014, Peak ~ 0.002），模拟远端 MossFormer2_SE_48K 归一化到 Peak=0.60
    const faintBreath = makeSine(0.5, 16000, 320, 0.002);
    const blownUp = makeSine(0.5, 16000, 320, 0.6);
    const capped = capDenoisedGainToInput(faintBreath, blownUp);
    expect(computeRms(capped)).toBeLessThanOrEqual(computeRms(faintBreath) * 1.36);
    expect(hasAudibleAudioEnergy(capped, 16000)).toBe(false);

    // 2. 纯数字静音输入绝不允许放大出任何非零能量
    const pureSilence = makeSilence(0.3);
    const cappedSilence = capDenoisedGainToInput(pureSilence, blownUp);
    expect(computeRms(cappedSilence)).toBe(0);

    // 3. 正常说话人声（降噪后能量 <= 输入能量）完全保持原样，零失真
    const normalSpeech = makeSine(0.6, 16000, 440, 0.18);
    const denoisedSpeech = makeSine(0.6, 16000, 440, 0.15);
    const cappedNormal = capDenoisedGainToInput(normalSpeech, denoisedSpeech);
    expect(cappedNormal).toBe(denoisedSpeech);
  });

  test("ClearVoiceGpuRuntime.denoiseSlice 与 separateSlice 限制远端 SE 增益爆炸并跳过不可听槽位", async () => {
    let enhanceCalls = 0;
    mockCvServer = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const u = new URL(req.url);
        if (u.pathname === "/clearvoice/v1/enhance") {
          enhanceCalls += 1;
          const form = await req.formData();
          const file = form.get("file") as Blob;
          const dec = decodeWavPcm(new Uint8Array(await file.arrayBuffer()));
          // 模拟远端 SE 把任意输入峰值归一化到 0.7（诱发 +48dB 假降噪与 ASR 幻觉）
          const normalized = makeSine(dec.samples.length / dec.sampleRate, dec.sampleRate, 350, 0.7);
          return new Response(new Uint8Array(encodeWavPcm16(normalized, dec.sampleRate)), {
            status: 200,
            headers: { "Content-Type": "audio/wav", "X-Elapsed-Ms": "12" },
          });
        }
        if (u.pathname === "/clearvoice/v1/separate") {
          const form = await req.formData();
          const file = form.get("file") as Blob;
          const dec = decodeWavPcm(new Uint8Array(await file.arrayBuffer()));
          const quietSlot = makeSine(dec.samples.length / dec.sampleRate, dec.sampleRate, 300, 0.002);
          const b64 = Buffer.from(encodeWavPcm16(quietSlot, dec.sampleRate)).toString("base64");
          return Response.json({
            model: "MossFormer2_SS_16K",
            elapsed_ms: 15,
            speakers: [{ speaker: 0, sample_rate: dec.sampleRate, audio_base64: b64 }],
          });
        }
        return new Response("not found", { status: 404 });
      },
    });

    const runtime = new ClearVoiceGpuRuntime({
      serviceUrl: `http://127.0.0.1:${mockCvServer.port}`,
    });

    // denoiseSlice 收到微弱气音时，即便远端返回 0.7 峰值，物理增益上限也会将其压回不可听电平
    const faint = makeSine(0.5, 16000, 350, 0.0025);
    const enh = await runtime.denoiseSlice(faint, { inputSampleRate: 16000, outputSampleRate: 16000 });
    expect(computeRms(enh.samples)).toBeLessThanOrEqual(computeRms(faint) * 1.36);
    expect(hasAudibleAudioEnergy(enh.samples, 16000)).toBe(false);

    // separateSlice 对不可听微弱输入直接跳过 /enhance 往返
    enhanceCalls = 0;
    const sep = await runtime.separateSlice(faint, {
      inputSampleRate: 16000,
      outputSampleRate: 16000,
      pruneTracks: false,
      applyDenoise: true,
    });
    expect(enhanceCalls).toBe(0);
    expect(sep.tracks.length).toBe(1);
    expect(hasAudibleAudioEnergy(sep.tracks[0]!.samples, 16000)).toBe(false);
  });
});

describe("Layer 2 & 3: ClearVoiceRealtimeChunker 起音门限与 VoiceStreamSession 采集态 TTS 锁存/能量早退", () => {
  test("ClearVoiceRealtimeChunker 过滤低于 -48dBFS 的起音误触发，但不截断已开声话语的轻声尾音", () => {
    // 模拟 Silero VAD 对极微弱噪声也错误输出 detected=true
    const oversensitiveVad = createTriggerableMockVad((frame) => computeRms(frame) >= 0.001);
    const chunker = new ClearVoiceRealtimeChunker({
      sampleRate: 16000,
      frameSizeMs: 32,
      silenceTriggerMs: 280,
      utteranceSilenceMs: 280,
      vad: oversensitiveVad,
    });

    // 1. 极微弱底噪（amp=0.003 -> RMS≈0.0021 < 0.004）不得开启新话语
    const faintNoise = makeSine(0.6, 16000, 300, 0.003);
    expect(chunker.pushSamples(faintNoise)).toHaveLength(0);
    expect(chunker.inUtterance).toBe(false);
    expect(chunker.pushSamples(makeSilence(0.4))).toHaveLength(0);

    // 2. 正常开声（amp=0.18）后紧接极轻尾音（amp=0.0035）应保持在同一话语中不被提前截断
    const loudHead = makeSine(0.4, 16000, 440, 0.18);
    const softTail = makeSine(0.25, 16000, 440, 0.0035);
    expect(chunker.pushSamples(loudHead)).toHaveLength(0);
    expect(chunker.inUtterance).toBe(true);
    expect(chunker.pushSamples(softTail)).toHaveLength(0);
    expect(chunker.isSpeaking).toBe(true);
    const emitted = chunker.pushSamples(makeSilence(0.35));
    expect(emitted.length).toBe(1);
    expect(emitted[0]!.rawNewSamples.length).toBeGreaterThan(Math.round(16000 * 0.6));
  });

  test("VoiceStreamSession ClearVoice 模式：采集态 TTS 标记跨越 1.2s 尾静音不丢失，且静音/低能量片零 GPU 调用", async () => {
    let separateCalls = 0;
    const mockCvRuntime = {
      getStatus: () => ({ ready: true, provider: "remote" as const }),
      isInFailureCooldown: () => false,
      separateSlice: async (pcm: Float32Array) => {
        separateCalls += 1;
        return {
          tracks: [{ trackIndex: 1, sourceSlot: 0, samples: pcm, rms: computeRms(pcm), energyRatio: 1 }],
          sampleRate: 16000,
          ssUsed: true,
          durationMs: 12,
          ssMs: 6,
          seMs: 6,
          inferMs: 12,
          provider: "remote" as const,
          device: "gpu" as const,
          model: "MossFormer2_SE_48K",
          gpuName: "Mock GPU",
          swaps: 0,
          pairWcorr: 0,
          pairEcorr: 0,
        };
      },
    };

    const fakeEngine = {
      createOnlineDenoiser: () => null,
      createStreamingVad: () => createTriggerableMockVad((frame) => computeRms(frame) >= 0.0035),
      createWakeWordStream: () => null,
      clearVoiceGpu: mockCvRuntime,
      getStatus: () => ({
        readyForLocalAsr: true,
        activeQwen3Device: "remote" as const,
        readyForClearVoiceGpu: true,
        clearVoice: mockCvRuntime.getStatus(),
      }),
      denoise: (s: Float32Array) => ({
        samples: s,
        sampleRate: 16000,
        engine: "dsp" as const,
        inputSnrDb: 10,
        outputSnrDb: 12,
        snrGainDb: 2,
        durationMs: 1,
      }),
      transcribeLocal: async (): Promise<LocalAsrOutput> => ({
        text: "呀。",
        rawText: "呀。",
        lang: "zh",
        emotion: "",
        event: "",
        engine: "qwen3-asr-remote",
        durationMs: 25,
        computeDevice: "remote",
      }),
    } as unknown as LocalVoiceEngine;

    const emitted: VoiceStreamSegmentPayload[] = [];
    const partials: string[] = [];
    const session = new VoiceStreamSession({
      localEngine: fakeEngine,
      noiseMode: "auto",
      voicePipelineMode: "clearvoice",
      streamingAsrEnabled: true,
      vadSilenceMs: 1200,
      clearVoiceSilenceMs: 280,
      clearVoiceUtteranceSilenceMs: 1200,
      isInConversation: () => true,
      wakeWords: ["Neo"],
      onPartialTranscript: (p) => partials.push(p.text),
      onSegmentReady: async (seg) => {
        emitted.push(seg);
        return null;
      },
    });

    try {
      // 1. 极微弱仅 1 帧刚过 0.004、整体不可听的微脉冲 -> 零 GPU 调用、零出段
      const blip = new Float32Array(16000);
      for (let i = 0; i < 600; i += 1) {
        blip[i] = Math.sin((2 * Math.PI * 300 * i) / 16000) * 0.0065;
      }
      session.pushFloat32Samples(blip);
      session.pushFloat32Samples(makeSilence(1.3));
      await session.waitForIdle();
      expect(separateCalls).toBe(0);
      expect(emitted).toHaveLength(0);

      // 2. TTS 播报期间捕获短语音残片 -> 播报立刻结束 -> 经过 1.25s 尾静音（已超 1000ms 实时尾窗）才提交整句
      session.notifyTtsState(true);
      session.pushFloat32Samples(makeSine(0.5, 16000, 420, 0.14));
      session.pushFloat32Samples(makeSilence(0.32)); // 触发 280ms 增量切片与流式预览
      await Bun.sleep(40);
      // 播报期间单字“呀。”流式预览不应刷屏到 UI
      expect(partials).toHaveLength(0);

      // TTS 结束，且等待超过 1050ms 墙钟时间模拟 1.2s 真实尾静音判停
      session.notifyTtsState(false);
      await Bun.sleep(1080);
      session.pushFloat32Samples(makeSilence(1.0)); // 补足 1200ms 整句静默判停
      await session.waitForIdle();

      expect(emitted).toHaveLength(1);
      // 关键断言：即便出段时刻距离 TTS 结束已超过 1000ms，采集态锁存仍准确保留 duringTtsPlayback=true！
      expect(emitted[0]!.duringTtsPlayback).toBe(true);
    } finally {
      session.dispose();
    }
  });
});

describe("Layer 5: TtsEchoGuard 失真单字回声残片拦截与有效短答复保护", () => {
  test("拦截播报期间及紧邻尾音的失真单字碎片（如“呀。”/“啊。”/未知声纹单字），同时完整放行“好/对/嗯/开/关/一”", () => {
    const guard = new TtsEchoGuard();
    const t0 = 1_700_000_000_000;
    const rec = guard.registerUtterance("好的", { now: t0, priority: "ack" });
    guard.updateClientPlaybackState({
      speaking: true,
      phase: "start",
      utteranceId: rec.id,
      text: "好的",
      now: t0 + 10,
    });

    const unknownVp = {
      evaluated: true,
      matched: false,
      score: 0.1,
      threshold: 0.3,
      enrolledCount: 1,
      speakerId: null,
      speakerName: null,
      role: null,
      engine: "3dspeaker-campplus" as const,
      candidates: [],
      reason: "未知声纹",
    };

    // 1. 播报期间回收失真单字“呀。”（与“好的”零字面重合 + 未知声纹 10%）-> 精准判为回声
    const duringYa = evaluateTtsEcho({
      transcript: "呀。",
      now: t0 + 400,
      recentUtterances: guard.getRecentUtterances(t0 + 400),
      ttsActive: true,
      duringTtsPlayback: true,
      voiceprint: unknownVp,
    });
    expect(duringYa.isEcho).toBe(true);

    // 2. 播报结束后 900ms 尾窗内回收“啊。” / “呀。” -> 精准判为回声
    guard.updateClientPlaybackState({
      speaking: false,
      phase: "end",
      utteranceId: rec.id,
      now: t0 + 500,
    });
    const tailYa = evaluateTtsEcho({
      transcript: "呀。",
      now: t0 + 1400,
      recentUtterances: guard.getRecentUtterances(t0 + 1400),
      ttsActive: false,
      duringTtsPlayback: false,
      voiceprint: unknownVp,
    });
    expect(tailYa.isEcho).toBe(true);

    // 3. 播报期间未知声纹飘出非有效回复的随机单字“的。” -> 判为回声
    const nonOwnerStray = evaluateTtsEcho({
      transcript: "的。",
      now: t0 + 420,
      recentUtterances: [{ ...rec, active: true, endedAt: null }],
      ttsActive: true,
      duringTtsPlayback: true,
      voiceprint: unknownVp,
    });
    expect(nonOwnerStray.isEcho).toBe(true);

    // 4. 确认提问播报完毕后，用户的真实单字确认回复（“好”/“对”/“是”/“嗯”/“开”/“关”/“一”）绝不误杀！
    const confirmGuard = new TtsEchoGuard();
    const qRec = confirmGuard.registerUtterance("需要现在启动阳台洗衣机吗？", {
      now: t0 + 3000,
      priority: "result",
      isConfirmationPrompt: true,
    });
    confirmGuard.updateClientPlaybackState({
      speaking: false,
      phase: "end",
      utteranceId: qRec.id,
      now: t0 + 4500,
    });
    for (const validReply of ["好", "对", "是", "嗯", "开", "关", "一", "不"]) {
      const r = evaluateTtsEcho({
        transcript: validReply,
        now: t0 + 5200,
        recentUtterances: confirmGuard.getRecentUtterances(t0 + 5200),
        ttsActive: false,
        duringTtsPlayback: false,
        strictConfirmationGuard: true,
        confirmationPromptEnqueuedAt: t0 + 3000,
        voiceprint: unknownVp,
      });
      expect(r.isEcho).toBe(false);
    }
    // 5. 验证单段 phase="end"（省略 speaking 字段）保持 isSpeaking=true 直至尾音泄放定时器发出 speaking=false
    const tailGuard = new TtsEchoGuard();
    const ackRec = tailGuard.registerUtterance("好的", { now: t0 + 6000, priority: "ack" });
    tailGuard.updateClientPlaybackState({
      speaking: true,
      phase: "start",
      utteranceId: ackRec.id,
      text: "好的",
      now: t0 + 6010,
    });
    expect(tailGuard.isSpeaking).toBe(true);
    tailGuard.updateClientPlaybackState({
      phase: "end",
      utteranceId: ackRec.id,
      text: "好的",
      queueLength: 0,
      now: t0 + 6400,
    });
    expect(tailGuard.isSpeaking).toBe(true);
    tailGuard.updateClientPlaybackState({
      speaking: false,
      phase: "end",
      queueLength: 0,
      now: t0 + 6820,
    });
    expect(tailGuard.isSpeaking).toBe(false);
  });
});

describe("Layer 6: VoiceListenerController 纯噪声/回声尾音绝不覆盖 ClearVoice 分轨卡片与有效字幕", () => {
  test("用户说完有效指令后紧随单轨“呀。”（未知声纹 10% / 降噪 +48.9dB / 已忽略）不覆盖 lastTrackBatch / lastMetrics / lastTranscript", async () => {
    updateAgentVoiceConfig({
      voicePipelineMode: "clearvoice",
      wakeWordEnabled: true,
      wakeWords: ["Neo", "小派"],
      voiceprintMode: "tag",
      voiceprintThreshold: 0.3,
      attentionMode: "smart",
      conversationWindowSec: 20,
      maxConsecutiveSidetalk: 3,
      owwEnabled: false,
    });

    const ownerVec = l2Normalize(new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]));
    const strangerVec = l2Normalize(new Float32Array([0.1, 0.995, 0, 0, 0, 0, 0, 0]));
    enrollVoiceprint({ name: "主人", role: "owner", embedding: ownerVec, engine: "3dspeaker-campplus" });

    let nextTranscript = "Neo，打开客厅吸顶灯";
    let nextEmbedding = ownerVec;
    let nextVadHasSpeech = true;
    let asrCallCount = 0;

    const fakeEngine = {
      openWakeWord: {
        isReady: false,
        getStatus: () => ({
          ready: false,
          modelsReady: false,
          enrolledCount: 0,
          activeWords: [],
        }),
      },
      configureRemoteClearVoice: () => {},
      configureRemoteQwen3Asr: () => {},
      detectSpeechSegments: (samples: Float32Array) => ({
        hasSpeech: nextVadHasSpeech,
        speechRatio: nextVadHasSpeech ? 0.85 : 0,
        speechSamples: nextVadHasSpeech ? samples : new Float32Array(0),
        engine: "silero" as const,
        durationMs: 4,
      }),
      extractSpeakerEmbedding: () => ({
        embedding: nextEmbedding,
        engine: "3dspeaker-campplus" as const,
        durationMs: 8,
      }),
      scoreWakeWordAudio: () => null,
      transcribeLocal: async (): Promise<LocalAsrOutput> => {
        asrCallCount += 1;
        return {
          text: nextTranscript,
          rawText: nextTranscript,
          lang: "zh",
          emotion: "",
          event: "",
          engine: "qwen3-asr-remote",
          durationMs: 35,
          computeDevice: "remote",
        };
      },
      getStatus: () => ({
        readyForLocalAsr: true,
        readyForClearVoiceGpu: true,
        activeQwen3Device: "remote",
      }),
      dispose: () => {},
    } as unknown as LocalVoiceEngine;

    const { controller, cleanup } = buildTestController(fakeEngine);
    try {
      // 1. 用户先说一句真实指令 -> 建立有效的 ClearVoice 分轨卡片、lastMetrics 与 lastTranscript
      const validAudio = makeSine(1.0, 16000, 440, 0.22);
      const validRes = await controller.processClearVoiceSeparatedTracks(
        [{ trackId: "cv_track_1", trackIndex: 1, samples: validAudio, snrGainDb: 12.4 }],
        {
          denoiseEngine: "clearvoice-mossformer2-bss-se-remote",
          bssUsed: true,
          inputSnrDb: 8,
          denoiseMs: 180,
          rawDurationMs: 1000,
          preVadSegmented: true,
        },
        { lang: "zh-CN", autoDispatch: true, useLocal: true, asyncDispatch: false },
      );
      expect(validRes.matched).toBe(true);
      const snapAfterValid = controller.snapshot();
      expect(snapAfterValid.lastTranscript).toBe("Neo，打开客厅吸顶灯");
      expect(snapAfterValid.lastTrackBatch?.tracks[0]?.text).toBe("Neo，打开客厅吸顶灯");
      expect(snapAfterValid.lastTrackBatch?.acceptedCount).toBe(1);
      expect(snapAfterValid.lastMetrics?.trackBatch?.batchId).toBe(snapAfterValid.lastTrackBatch?.batchId);

      // 2a. 紧接指令播报尾窗内出现单轨失真残片“呀。”（未知声纹 10% + 降噪 +48.9dB）
      // -> 命中 Layer 5 失真回声拦截（stage="echo"），既不覆盖卡片也不消耗旁白退出计数！
      const sidetalkAfterValid = snapAfterValid.consecutiveSidetalkCount;
      nextTranscript = "呀。";
      nextEmbedding = strangerVec;
      nextVadHasSpeech = true;
      const immediateEchoRes = await controller.processClearVoiceSeparatedTracks(
        [{ trackId: "cv_track_1", trackIndex: 1, samples: makeSine(0.4, 16000, 320, 0.12), snrGainDb: 48.9 }],
        {
          denoiseEngine: "clearvoice-mossformer2-bss-se-remote",
          bssUsed: true,
          inputSnrDb: 11.1,
          denoiseMs: 318,
          rawDurationMs: 400,
          preVadSegmented: true,
        },
        { lang: "zh-CN", autoDispatch: true, useLocal: true, asyncDispatch: false },
      );
      expect(immediateEchoRes.matched).toBe(false);
      expect(immediateEchoRes.attention?.stage).toBe("echo");
      const snapAfterImmediateEcho = controller.snapshot();
      expect(snapAfterImmediateEcho.consecutiveSidetalkCount).toBe(sidetalkAfterValid);
      expect(snapAfterImmediateEcho.lastTranscript).toBe("Neo，打开客厅吸顶灯");
      expect(snapAfterImmediateEcho.lastTrackBatch?.batchId).toBe(snapAfterValid.lastTrackBatch?.batchId);
      expect(snapAfterImmediateEcho.lastMetrics?.snrGainDb).toBe(12.4);

      // 2b. 脱离 TTS 回声窗口（10s 后）出现纯环境噪声单轨碎片“呀。”（stage="acoustic"）
      // -> 同样绝不覆盖 lastTrackBatch、lastMetrics 与 lastTranscript！
      const pureAcousticRes = await controller.processClearVoiceSeparatedTracks(
        [{ trackId: "cv_track_1", trackIndex: 1, samples: makeSine(0.4, 16000, 320, 0.12), snrGainDb: 48.9 }],
        {
          denoiseEngine: "clearvoice-mossformer2-bss-se-remote",
          bssUsed: true,
          inputSnrDb: 11.1,
          denoiseMs: 318,
          rawDurationMs: 400,
          preVadSegmented: true,
        },
        {
          lang: "zh-CN",
          autoDispatch: true,
          useLocal: true,
          asyncDispatch: false,
          now: Date.now() + 10_000,
        },
      );
      expect(pureAcousticRes.matched).toBe(false);
      expect(pureAcousticRes.attention?.stage).toBe("acoustic");

      // 关键断言：UI 展示的 lastTrackBatch、lastMetrics 与 lastTranscript 全部保持上一条有效指令，绝不被“呀。”覆盖！
      const snapAfterNoise = controller.snapshot();
      expect(snapAfterNoise.lastTranscript).toBe("Neo，打开客厅吸顶灯");
      expect(snapAfterNoise.lastTrackBatch?.batchId).toBe(snapAfterValid.lastTrackBatch?.batchId);
      expect(snapAfterNoise.lastTrackBatch?.tracks[0]?.text).toBe("Neo，打开客厅吸顶灯");
      expect(snapAfterNoise.lastMetrics?.trackBatch?.batchId).toBe(snapAfterValid.lastTrackBatch?.batchId);
      expect(snapAfterNoise.lastMetrics?.snrGainDb).toBe(12.4);

      // 3. 播报期间失真回声“呀。”（duringTtsPlayback=true）按 echo 拦截，既不覆盖卡片也不累加旁白退出计数
      const prevSidetalk = snapAfterNoise.consecutiveSidetalkCount;
      controller.handleTtsClientState({
        speaking: true,
        phase: "start",
        utteranceId: "tts_ack_1",
        text: "好的",
      });
      const echoRes = await controller.processClearVoiceSeparatedTracks(
        [{ trackId: "cv_track_1", trackIndex: 1, samples: makeSine(0.4, 16000, 320, 0.12), snrGainDb: 42.0 }],
        {
          denoiseEngine: "clearvoice-mossformer2-bss-se-remote",
          bssUsed: true,
          inputSnrDb: 10,
          denoiseMs: 260,
          rawDurationMs: 400,
          preVadSegmented: true,
        },
        {
          lang: "zh-CN",
          autoDispatch: true,
          useLocal: true,
          asyncDispatch: false,
          duringTtsPlayback: true,
        },
      );
      expect(echoRes.matched).toBe(false);
      expect(echoRes.attention?.stage).toBe("echo");
      const snapAfterEcho = controller.snapshot();
      expect(snapAfterEcho.consecutiveSidetalkCount).toBe(prevSidetalk);
      expect(snapAfterEcho.lastTrackBatch?.batchId).toBe(snapAfterValid.lastTrackBatch?.batchId);
      expect(snapAfterEcho.lastTranscript).toBe("Neo，打开客厅吸顶灯");

      // 4. 分轨 Silero VAD 判定无语音且 RMS=0.014 (< 0.022) 时直接跳过声纹与 ASR（零 ASR 消耗）
      const asrBeforeSkip = asrCallCount;
      nextVadHasSpeech = false;
      const lowEnergyNonSpeech = makeSine(0.4, 16000, 300, 0.02); // RMS ≈ 0.0141 < 0.022
      const skippedRes = await controller.processClearVoiceSeparatedTracks(
        [{ trackId: "cv_track_1", trackIndex: 1, samples: lowEnergyNonSpeech, snrGainDb: 35.0 }],
        {
          denoiseEngine: "clearvoice-mossformer2-bss-se-remote",
          bssUsed: true,
          inputSnrDb: 10,
          denoiseMs: 210,
          rawDurationMs: 400,
          preVadSegmented: true,
        },
        { lang: "zh-CN", autoDispatch: true, useLocal: true, asyncDispatch: false },
      );
      expect(asrCallCount).toBe(asrBeforeSkip);
      expect(skippedRes.speechDetected).toBe(false);
      expect(controller.snapshot().lastTrackBatch?.batchId).toBe(snapAfterValid.lastTrackBatch?.batchId);
    } finally {
      await cleanup();
    }
  });
});

describe("Layer 1 (Client Worklet): bargeInEnabled=false 时播报期静音门控麦克风上行与尾音释放", () => {
  function instantiateVoiceWorklet(processorOptions: Record<string, unknown>) {
    const src = readFileSync(
      path.join(import.meta.dir, "..", "src", "web", "voiceListener.ts"),
      "utf8",
    );
    const startMarker = "const VOICE_WORKLET_CODE = `";
    const endMarker = 'registerProcessor("mijia-voice-processor", MijiaVoiceProcessor);';
    const startIdx = src.indexOf(startMarker);
    const endIdx = src.indexOf(endMarker, startIdx);
    expect(startIdx).toBeGreaterThan(-1);
    expect(endIdx).toBeGreaterThan(startIdx);

    const rawCode = src.slice(startIdx + startMarker.length, endIdx + endMarker.length);

    let RegisteredCtor: any = null;
    const posted: any[] = [];
    class FakeAudioWorkletProcessor {
      port = {
        onmessage: null as ((ev: { data: any }) => void) | null,
        postMessage: (msg: any) => {
          posted.push(msg);
        },
      };
    }

    const factory = new Function("AudioWorkletProcessor", "registerProcessor", "sampleRate", rawCode);
    factory(
      FakeAudioWorkletProcessor,
      (_name: string, ctor: any) => {
        RegisteredCtor = ctor;
      },
      16000,
    );
    expect(RegisteredCtor).toBeTruthy();
    const instance = new RegisteredCtor({ processorOptions });
    return { instance, posted };
  }

  test("bargeInEnabled=false 且 ttsActive=true 时上行 PCM 帧全零门控且不触发 double_talk；播报结束释放后立即恢复收音", () => {
    const { instance, posted } = instantiateVoiceWorklet({
      streamMode: true,
      fullDuplex: true,
      bargeInEnabled: false,
      echoMode: "auto",
      vadThreshold: 0.025,
      vadSilenceMs: 1200,
    });

    const micBlock = makeSine(128 / 16000, 16000, 500, 0.35);
    const refBlock = makeSine(128 / 16000, 16000, 500, 0.3);

    // 1. 开启 TTS 播报 -> 连续喂入 24 个 128 样本块（足够产出 2 帧 1024-sample PCM）
    instance.port.onmessage({ data: { type: "tts_state", active: true } });
    for (let i = 0; i < 24; i += 1) {
      instance.process([[micBlock]], [[refBlock]]);
    }
    const gatedFrames = posted.filter((m) => m.type === "pcm_frame");
    expect(gatedFrames.length).toBeGreaterThanOrEqual(2);
    for (const f of gatedFrames) {
      const i16 = new Int16Array(f.buffer);
      let maxAbs = 0;
      for (let k = 0; k < i16.length; k += 1) {
        const a = Math.abs(i16[k]!);
        if (a > maxAbs) maxAbs = a;
      }
      expect(maxAbs).toBe(0);
    }
    // 关闭打断时不应发出 double_talk 信号
    expect(posted.some((m) => m.type === "double_talk" && m.active === true)).toBe(false);

    // 2. 尾音保护期结束后释放 tts_state=false -> 麦克风立即恢复正常收音
    posted.length = 0;
    instance.port.onmessage({ data: { type: "tts_state", active: false } });
    const quietRef = makeSilence(128 / 16000);
    for (let i = 0; i < 24; i += 1) {
      instance.process([[micBlock]], [[quietRef]]);
    }
    const resumedFrames = posted.filter((m) => m.type === "pcm_frame");
    expect(resumedFrames.length).toBeGreaterThanOrEqual(2);
    let maxResumed = 0;
    for (const f of resumedFrames) {
      const i16 = new Int16Array(f.buffer);
      for (let k = 0; k < i16.length; k += 1) {
        const a = Math.abs(i16[k]!);
        if (a > maxResumed) maxResumed = a;
      }
    }
    expect(maxResumed).toBeGreaterThan(2000);
  });

  test("bargeInEnabled=true 且 ttsActive=true 时保留全双工打断上行（不静音门控）", () => {
    const { instance, posted } = instantiateVoiceWorklet({
      streamMode: true,
      fullDuplex: true,
      bargeInEnabled: true,
      echoMode: "auto",
      vadThreshold: 0.025,
      vadSilenceMs: 1200,
    });

    const micBlock = makeSine(128 / 16000, 16000, 500, 0.35);
    const zeroRef = makeSilence(128 / 16000);

    instance.port.onmessage({ data: { type: "tts_state", active: true } });
    for (let i = 0; i < 24; i += 1) {
      instance.process([[micBlock]], [[zeroRef]]);
    }
    const frames = posted.filter((m) => m.type === "pcm_frame");
    expect(frames.length).toBeGreaterThanOrEqual(2);
    let maxAbs = 0;
    for (const f of frames) {
      const i16 = new Int16Array(f.buffer);
      for (let k = 0; k < i16.length; k += 1) {
        const a = Math.abs(i16[k]!);
        if (a > maxAbs) maxAbs = a;
      }
    }
    expect(maxAbs).toBeGreaterThan(2000);
  });
});
