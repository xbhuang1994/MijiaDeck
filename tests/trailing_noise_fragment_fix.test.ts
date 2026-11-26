// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 回归测试 — 修复每次说完话后尾音回声/噪声碎片（如“呀。” / 未知声纹 / 误覆盖有效字幕与指标）

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { computeRms, l2Normalize } from "../src/agent/audioPcm.ts";
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

function createSileroSegmentMockVad(
  isVoiceFn: (samples: Float32Array) => boolean,
  silenceFramesToEnd = 18,
): StreamingVadHandleLike {
  let detected = false;
  let silentFrames = 0;
  let sampleCursor = 0;
  let segStart = 0;
  let chunks: Float32Array[] = [];
  let queue: Array<{ start: number; samples: Float32Array }> = [];

  const finalize = () => {
    if (chunks.length === 0) return;
    const total = chunks.reduce((a, c) => a + c.length, 0);
    const merged = new Float32Array(total);
    let off = 0;
    for (const c of chunks) {
      merged.set(c, off);
      off += c.length;
    }
    queue.push({ start: segStart, samples: merged });
    chunks = [];
    detected = false;
    silentFrames = 0;
  };

  return {
    acceptWaveform(frame: Float32Array) {
      if (isVoiceFn(frame)) {
        if (!detected) {
          detected = true;
          segStart = sampleCursor;
          chunks = [];
        }
        silentFrames = 0;
        chunks.push(new Float32Array(frame));
      } else if (detected) {
        silentFrames += 1;
        chunks.push(new Float32Array(frame));
        if (silentFrames >= silenceFramesToEnd) {
          finalize();
        }
      }
      sampleCursor += frame.length;
    },
    isEmpty: () => queue.length === 0,
    isDetected: () => detected,
    front: () => queue[0]!,
    pop: () => {
      queue.shift();
    },
    flush: () => {
      finalize();
    },
    reset: () => {
      queue = [];
      chunks = [];
      detected = false;
      silentFrames = 0;
      sampleCursor = 0;
    },
    clear: () => {
      queue = [];
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
  setDataPathOverrides(null);
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = "";
  }
});

describe("VoiceStreamSession 采集态 TTS 锁存与微弱噪声能量早退", () => {
  test("Legacy 模式：采集态 TTS 标记跨越 1.2s 尾静音不丢失，且静音/极微弱脉冲直接早退零出段", async () => {
    const fakeEngine = {
      createOnlineDenoiser: () => null,
      createStreamingVad: () => createSileroSegmentMockVad((frame) => computeRms(frame) >= 0.0035, 36),
      createWakeWordStream: () => null,
      getStatus: () => ({
        readyForLocalAsr: true,
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
        engine: "sensevoice-local",
        durationMs: 25,
      }),
    } as unknown as LocalVoiceEngine;

    const emitted: VoiceStreamSegmentPayload[] = [];
    const session = new VoiceStreamSession({
      localEngine: fakeEngine,
      noiseMode: "off",
      voicePipelineMode: "legacy",
      streamingAsrEnabled: false,
      vadSilenceMs: 1200,
      isInConversation: () => true,
      wakeWords: ["Neo"],
      onSegmentReady: async (seg) => {
        emitted.push(seg);
        return null;
      },
    });

    try {
      // 1. 极微弱仅 1 帧刚过 0.004、整体不可听的微脉冲 -> 直接早退零出段
      const blip = new Float32Array(16000);
      for (let i = 0; i < 600; i += 1) {
        blip[i] = Math.sin((2 * Math.PI * 300 * i) / 16000) * 0.0065;
      }
      session.pushFloat32Samples(blip);
      session.pushFloat32Samples(makeSilence(1.4));
      await session.waitForIdle();
      expect(emitted).toHaveLength(0);

      // 2. TTS 播报期间捕获短语音残片 -> 播报立刻结束 -> 经过 > 1050ms 墙钟 + 尾静音才提交整句
      session.notifyTtsState(true);
      session.pushFloat32Samples(makeSine(0.5, 16000, 420, 0.14));
      session.notifyTtsState(false);
      await Bun.sleep(1080);
      session.pushFloat32Samples(makeSilence(1.3));
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

describe("Layer 6: VoiceListenerController 纯噪声/回声尾音绝不覆盖有效字幕与旁白计数", () => {
  test("用户说完有效指令后紧随回声或单字噪声碎片“呀。”（未知声纹 10%）不覆盖 lastTranscript 且回声不消耗旁白计数", async () => {
    updateAgentVoiceConfig({
      voicePipelineMode: "legacy",
      wakeWordEnabled: true,
      wakeWords: ["Neo", "小派"],
      voiceprintMode: "tag",
      voiceprintThreshold: 0.3,
      attentionMode: "smart",
      conversationWindowSec: 20,
      maxConsecutiveSidetalk: 3,
      sourceSeparationMode: "off",
      owwEnabled: false,
    });

    const ownerVec = l2Normalize(new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]));
    const strangerVec = l2Normalize(new Float32Array([0.1, 0.995, 0, 0, 0, 0, 0, 0]));
    enrollVoiceprint({ name: "主人", role: "owner", embedding: ownerVec, engine: "3dspeaker-campplus" });

    let nextTranscript = "Neo，打开客厅吸顶灯";
    let nextEmbedding = ownerVec;

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
      extractSpeakerEmbedding: () => ({
        embedding: nextEmbedding,
        engine: "3dspeaker-campplus" as const,
        durationMs: 8,
      }),
      scoreWakeWordAudio: () => null,
      transcribeDualTrack: async (): Promise<LocalAsrOutput> => ({
        text: nextTranscript,
        rawText: nextTranscript,
        lang: "zh",
        emotion: "",
        event: "",
        engine: "sensevoice-local",
        durationMs: 25,
      }),
      getStatus: () => ({
        readyForLocalAsr: true,
        readyForSourceSeparation: false,
      }),
      dispose: () => {},
    } as unknown as LocalVoiceEngine;

    const { controller, cleanup } = buildTestController(fakeEngine);
    try {
      // 1. 用户先说一句真实指令 -> 建立有效字幕与对话态
      const validAudio = makeSine(1.0, 16000, 440, 0.22);
      const validRes = await controller.processDualTrackSegment(
        {
          rawSamples: validAudio,
          denoisedSamples: validAudio,
          denoiseEngine: "gtcrn",
          inputSnrDb: 8,
          outputSnrDb: 20.4,
          snrGainDb: 12.4,
          startSec: 0,
          durationSec: 1.0,
          forcedRoll: false,
          wakeAnchored: false,
        },
        { asyncDispatch: false },
      );
      expect(validRes.matched).toBe(true);
      const snapAfterValid = controller.snapshot();
      expect(snapAfterValid.lastTranscript).toBe("Neo，打开客厅吸顶灯");

      // 2a. 紧接指令播报尾窗内出现失真残片“呀。”（未知声纹 10%）-> 命中回声拦截（stage="echo"），不覆盖字幕且不累加旁白计数
      const sidetalkAfterValid = snapAfterValid.consecutiveSidetalkCount;
      nextTranscript = "呀。";
      nextEmbedding = strangerVec;
      const immediateEchoRes = await controller.processDualTrackSegment(
        {
          rawSamples: makeSine(0.4, 16000, 320, 0.12),
          denoisedSamples: makeSine(0.4, 16000, 320, 0.12),
          denoiseEngine: "gtcrn",
          inputSnrDb: 11.1,
          outputSnrDb: 22.0,
          snrGainDb: 10.9,
          startSec: 1.2,
          durationSec: 0.4,
          forcedRoll: false,
          wakeAnchored: false,
        },
        { asyncDispatch: false },
      );
      expect(immediateEchoRes.matched).toBe(false);
      expect(immediateEchoRes.attention?.stage).toBe("echo");
      const snapAfterImmediateEcho = controller.snapshot();
      expect(snapAfterImmediateEcho.consecutiveSidetalkCount).toBe(sidetalkAfterValid);
      expect(snapAfterImmediateEcho.lastTranscript).toBe("Neo，打开客厅吸顶灯");

      // 2b. 脱离 TTS 回声窗口（10s 后）出现纯环境噪声单字碎片“呀。”（stage="acoustic"）-> 不覆盖有效字幕！
      const pureAcousticRes = await controller.handleTranscript("呀。", {
        isFinal: true,
        now: Date.now() + 10_000,
        voiceprint: {
          evaluated: true,
          matched: false,
          score: 0.1,
          threshold: 0.3,
          enrolledCount: 1,
          speakerId: null,
          speakerName: null,
          role: null,
          engine: "3dspeaker-campplus",
          candidates: [],
        },
      });
      expect(pureAcousticRes.matched).toBe(false);
      expect(pureAcousticRes.attention?.stage).toBe("acoustic");
      expect(controller.snapshot().lastTranscript).toBe("Neo，打开客厅吸顶灯");

      // 3. 播报期间失真回声“呀。”（duringTtsPlayback=true）按 echo 拦截，不覆盖字幕也不累加旁白计数
      const prevSidetalk = controller.snapshot().consecutiveSidetalkCount;
      controller.handleTtsClientState({
        speaking: true,
        phase: "start",
        utteranceId: "tts_ack_1",
        text: "好的",
      });
      const echoRes = await controller.processDualTrackSegment(
        {
          rawSamples: makeSine(0.4, 16000, 320, 0.12),
          denoisedSamples: makeSine(0.4, 16000, 320, 0.12),
          denoiseEngine: "gtcrn",
          inputSnrDb: 10,
          outputSnrDb: 18,
          snrGainDb: 8,
          startSec: 12,
          durationSec: 0.4,
          forcedRoll: false,
          wakeAnchored: false,
          duringTtsPlayback: true,
        },
        { asyncDispatch: false, duringTtsPlayback: true },
      );
      expect(echoRes.matched).toBe(false);
      expect(echoRes.attention?.stage).toBe("echo");
      expect(controller.snapshot().consecutiveSidetalkCount).toBe(prevSidetalk);
      expect(controller.snapshot().lastTranscript).toBe("Neo，打开客厅吸顶灯");
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
