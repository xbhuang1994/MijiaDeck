// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 多轨转写超 20 字由 SystemOne 判别并在当前对话内屏蔽背景音/旁白/噪音/电视音轨测试

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { decodeWavPcm, encodeWavPcm16 } from "../src/agent/audioPcm.ts";
import { ClearVoiceGpuRuntime } from "../src/agent/clearVoiceGpuRuntime.ts";
import {
  ConversationTrackMuteManager,
  countTrackTranscriptChars,
  MULTITRACK_NOISE_CHECK_MIN_CHARS,
  resolveTrackMuteKey,
} from "../src/agent/multiTrackNoiseFilter.ts";
import {
  LocalVoiceEngine,
  type LocalAsrOutput,
  type StreamingVadHandleLike,
} from "../src/agent/localVoiceEngine.ts";
import { PiAgentService } from "../src/agent/piAgentService.ts";
import type { StreamingPartialUpdate } from "../src/agent/qwen3StreamingTranscriber.ts";
import {
  SystemOneClient,
  type TrackNoiseClassChoice,
} from "../src/agent/systemOneClient.ts";
import { VoiceListenerController } from "../src/agent/voiceListenerController.ts";
import {
  VoiceStreamSession,
  type VoiceStreamSegmentPayload,
} from "../src/agent/voiceStreamSession.ts";
import { updateAgentVoiceConfig } from "../src/core/agentConfigStore.ts";
import type { FetchLike } from "../src/core/httpTimeout.ts";
import { JobExecutor } from "../src/core/jobs.ts";
import { setDataPathOverrides } from "../src/core/jsonStore.ts";
import * as settingsStore from "../src/core/settingsStore.ts";
import { VirtualDemoService } from "../src/core/virtualLightService.ts";
import { MainWindowController } from "../src/ui/controllers/mainWindowController.ts";
import { ThemeController } from "../src/ui/theme.ts";

let tmpDir = "";
let mockCvServer: ReturnType<typeof Bun.serve> | null = null;
let mockSystemOneServer: ReturnType<typeof Bun.serve> | null = null;

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

function makeNoiseChoiceAnswer(choice: TrackNoiseClassChoice, confidence: number) {
  const other = Number(Math.max(0, 1 - confidence).toFixed(4));
  return {
    type: "choice" as const,
    choice,
    probabilities: {
      background_noise_tv: choice === "background_noise_tv" ? confidence : other,
      human_speech: choice === "human_speech" ? confidence : other,
    },
    confidence,
  };
}

function makeGenericChoiceAnswer(choice: string, keys: readonly string[], confidence = 0.94) {
  const probs: Record<string, number> = {};
  const rest = keys.length > 1 ? Number((Math.max(0, 1 - confidence) / (keys.length - 1)).toFixed(4)) : 0;
  for (const k of keys) {
    probs[k] = k === choice ? confidence : rest;
  }
  return {
    type: "choice" as const,
    choice,
    probabilities: probs,
    confidence,
  };
}

function fillNonTrackSystemOneDefaults(
  qKey: string,
  qDef: unknown,
  overrides?: { decision?: string; convAction?: string },
): Record<string, unknown> | null {
  const def = qDef as { criteria?: Record<string, string> } | undefined;
  const keys = def?.criteria ? Object.keys(def.criteria) : [];
  if (qKey === "decision") {
    const choice = overrides?.decision ?? "direct_command";
    return makeGenericChoiceAnswer(choice, keys.length > 0 ? keys : ["direct_command", "wake_only", "ignore"]);
  }
  if (qKey === "conv_action") {
    const choice = overrides?.convAction ?? "side_talk";
    return makeGenericChoiceAnswer(choice, keys.length > 0 ? keys : ["followup", "side_talk", "goodbye"]);
  }
  if (keys.length > 0) {
    return makeGenericChoiceAnswer(keys[0]!, keys, 0.9);
  }
  return null;
}

interface RecordedSystemOneCall {
  state: Record<string, unknown>;
  questions: Record<string, unknown>;
}

function createMockSystemOneClient(
  resolver: (
    state: Record<string, unknown>,
    questions: Record<string, unknown>,
  ) => Record<string, unknown> | null,
  options?: { confidenceThreshold?: number },
): { client: SystemOneClient; calls: RecordedSystemOneCall[] } {
  const calls: RecordedSystemOneCall[] = [];
  const fetcher: FetchLike = async (_url, init) => {
    const parsed = JSON.parse(String(init?.body ?? "{}")) as {
      model?: string;
      state?: Record<string, unknown>;
      questions?: Record<string, unknown>;
    };
    const state = parsed.state ?? {};
    const questions = parsed.questions ?? {};
    calls.push({ state, questions });
    const answers = resolver(state, questions);
    if (!answers) {
      return new Response("upstream error", { status: 500 });
    }
    return new Response(
      JSON.stringify({
        model: parsed.model ?? "systemone-v1",
        answers,
        usage: { input_tokens: 120, output_tokens: 16 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  const client = new SystemOneClient({
    baseUrl: "http://127.0.0.1:9999/v1",
    apiKey: "test-key",
    confidenceThreshold: options?.confidenceThreshold ?? 0.65,
    fetcher,
  });
  return { client, calls };
}

function startMockSystemOneHttpServer(
  resolver: (
    state: Record<string, unknown>,
    questions: Record<string, unknown>,
  ) => Record<string, unknown>,
): { url: string; calls: RecordedSystemOneCall[]; stop: () => void } {
  const calls: RecordedSystemOneCall[] = [];
  const srv = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const u = new URL(req.url);
      if (u.pathname.endsWith("/systemone")) {
        const body = (await req.json()) as {
          model?: string;
          state?: Record<string, unknown>;
          questions?: Record<string, unknown>;
        };
        const state = body.state ?? {};
        const questions = body.questions ?? {};
        calls.push({ state, questions });
        const answers = resolver(state, questions);
        return Response.json({
          model: body.model ?? "systemone-v1",
          answers,
          usage: { input_tokens: 100, output_tokens: 12 },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  mockSystemOneServer = srv;
  return {
    url: `http://127.0.0.1:${srv.port}/v1`,
    calls,
    stop: () => srv.stop(true),
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
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "mijiadeck-mt-mute-"));
  const dir = tmpDir;
  setDataPathOverrides({ dataDir: () => dir });
});

afterEach(() => {
  if (mockCvServer) {
    mockCvServer.stop(true);
    mockCvServer = null;
  }
  if (mockSystemOneServer) {
    mockSystemOneServer.stop(true);
    mockSystemOneServer = null;
  }
  setDataPathOverrides(null);
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = "";
  }
});

describe("多轨字数统计与 SystemOneClient.classifyMultiTrackNoise 单元测试", () => {
  test("countTrackTranscriptChars 严格剔除空白与标点，区分 20 字与超 20 字边界", () => {
    expect(MULTITRACK_NOISE_CHECK_MIN_CHARS).toBe(20);
    expect(countTrackTranscriptChars("一二三四五，六七八九十！一二三四五、六七八九十。")).toBe(20);
    expect(countTrackTranscriptChars("一二三四五，六七八九十！一二三四五、六七八九十一。")).toBe(21);
    expect(countTrackTranscriptChars("  Neo，打开客厅吸顶灯！ ")).toBe(10);
    expect(resolveTrackMuteKey({ trackId: "cv_track_2", trackIndex: 2, sourceSlot: 1 })).toBe("slot:1");
    expect(resolveTrackMuteKey({ trackId: "cv_track_2", trackIndex: 2 })).toBe("id:cv_track_2");
  });

  test("classifyMultiTrackNoise 单次批量判别多条音轨并遵循置信度门限与仅缓存负向策略", async () => {
    const { client, calls } = createMockSystemOneClient((_state, questions) => {
      const ans: Record<string, unknown> = {};
      for (const qKey of Object.keys(questions)) {
        if (qKey === "track_1") {
          ans[qKey] = makeNoiseChoiceAnswer("human_speech", 0.94);
        } else if (qKey === "track_2") {
          ans[qKey] = makeNoiseChoiceAnswer("background_noise_tv", 0.92);
        } else if (qKey === "track_3") {
          // 低置信度 background_noise_tv（< 0.65）不应被误屏蔽
          ans[qKey] = makeNoiseChoiceAnswer("background_noise_tv", 0.52);
        }
      }
      return ans;
    });

    const input = {
      tracks: [
        { trackId: "cv_track_1", trackIndex: 1, text: "Neo，打开客厅吸顶灯", speakerName: "主人" },
        {
          trackId: "cv_track_2",
          trackIndex: 2,
          text: "欢迎收看今晚八点档晚间新闻联播节目，下面为您播报天气预报",
        },
        { trackId: "cv_track_3", trackIndex: 3, text: "好像是外面有点声音" },
      ],
      wakeWords: ["Neo"],
      recentHistory: [{ role: "user" as const, text: "把卧室灯关一下" }],
    };

    const res1 = await client.classifyMultiTrackNoise(input);
    expect(res1).not.toBeNull();
    expect(calls).toHaveLength(1);
    expect(Object.keys(calls[0]!.questions)).toEqual(["track_1", "track_2", "track_3"]);
    expect(res1!.cached).toBe(false);
    expect(res1!.mutedTrackIds).toEqual(["cv_track_2"]);
    expect(res1!.verdicts.find((v) => v.trackIndex === 1)?.shouldMute).toBe(false);
    expect(res1!.verdicts.find((v) => v.trackIndex === 2)?.shouldMute).toBe(true);
    expect(res1!.verdicts.find((v) => v.trackIndex === 3)?.shouldMute).toBe(false);

    // 相同输入命中负向缓存，不再发起网络请求
    const res2 = await client.classifyMultiTrackNoise(input);
    expect(res2?.cached).toBe(true);
    expect(res2?.mutedTrackIds).toEqual(["cv_track_2"]);
    expect(calls).toHaveLength(1);
  });

  test("ConversationTrackMuteManager：单轨或 <= 20 字绝不调用 SystemOne；超 20 字后即时屏蔽且单轨恢复时不误伤", async () => {
    const { client, calls } = createMockSystemOneClient((state, questions) => {
      const tracks = (state.tracks as Array<{ track_index: number; text: string }>) ?? [];
      const ans: Record<string, unknown> = {};
      for (const qKey of Object.keys(questions)) {
        const idx = Number(qKey.replace("track_", ""));
        const tr = tracks.find((t) => t.track_index === idx);
        const isTv = Boolean(tr && /(?:新闻|联播|观众|广告|播报)/.test(tr.text));
        ans[qKey] = makeNoiseChoiceAnswer(isTv ? "background_noise_tv" : "human_speech", 0.95);
      }
      return ans;
    });

    const mgr = new ConversationTrackMuteManager();

    // 1. 单轨即使超出 20 字也绝不调用 SystemOne、绝不屏蔽
    const single = await mgr.evaluateTracks(
      [
        {
          trackId: "cv_track_1",
          trackIndex: 1,
          sourceSlot: 0,
          text: "各位观众晚上好欢迎收看今晚的新闻联播特别节目现在为您播报",
        },
      ],
      { totalTracksInBatch: 1, mode: "final", systemOneClient: client },
    );
    expect(single.evaluated).toBe(false);
    expect(calls).toHaveLength(0);
    expect(mgr.mutedCount).toBe(0);

    // 2. 多轨合计恰好 20 字（含标点）：不超出 20 字，不调用 SystemOne
    const exact20 = await mgr.evaluateTracks(
      [
        { trackId: "cv_track_1", trackIndex: 1, sourceSlot: 0, text: "帮我打开客厅吸顶灯吧" }, // 10 chars
        { trackId: "cv_track_2", trackIndex: 2, sourceSlot: 1, text: "各位观众朋友们，晚上好！" }, // 10 chars
      ],
      { totalTracksInBatch: 2, mode: "preview", systemOneClient: client },
    );
    expect(exact20.totalEffectiveChars).toBe(20);
    expect(exact20.evaluated).toBe(false);
    expect(calls).toHaveLength(0);

    // 3. 同一话语流式预览覆盖更新（不会叠加 10+10 变成 20），直到增长到 21 字才触发 SystemOne
    const preview21 = await mgr.evaluateTracks(
      [
        { trackId: "cv_track_1", trackIndex: 1, sourceSlot: 0, text: "帮我打开客厅吸顶灯吧" }, // 10 chars
        { trackId: "cv_track_2", trackIndex: 2, sourceSlot: 1, text: "各位观众朋友们晚上好，欢迎" }, // 12 chars -> total 22 > 20
      ],
      { totalTracksInBatch: 2, mode: "preview", systemOneClient: client },
    );
    expect(preview21.evaluated).toBe(true);
    expect(calls).toHaveLength(1);
    expect(preview21.newlyMuted.map((m) => m.trackIndex)).toEqual([2]);
    expect(mgr.isTrackMuted({ trackId: "cv_track_2", trackIndex: 2, sourceSlot: 1 }, 2)).toBe(true);
    expect(mgr.isTrackMuted({ trackId: "cv_track_1", trackIndex: 1, sourceSlot: 0 }, 2)).toBe(false);

    // 4. 若后续退回单轨（例如电视关闭、仅剩 1 轨），绝不误屏蔽唯一音轨
    expect(mgr.isTrackMuted({ trackId: "cv_track_2", trackIndex: 2, sourceSlot: 1 }, 1)).toBe(false);

    // 5. 异步判别期间若对话重置（reset），陈旧屏蔽结果自动丢弃不污染新对话
    let releaseFetch!: () => void;
    const delayedClient = new SystemOneClient({
      baseUrl: "http://127.0.0.1:9999/v1",
      apiKey: "k",
      fetcher: async () => {
        await new Promise<void>((resolve) => {
          releaseFetch = resolve;
        });
        return new Response(
          JSON.stringify({
            model: "systemone-v1",
            answers: {
              track_1: makeNoiseChoiceAnswer("human_speech", 0.9),
              track_2: makeNoiseChoiceAnswer("background_noise_tv", 0.98),
            },
            usage: { input_tokens: 40, output_tokens: 8 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    });
    mgr.reset();
    const pendingEval = mgr.evaluateTracks(
      [
        { trackId: "cv_track_1", trackIndex: 1, sourceSlot: 0, text: "打开客厅灯" },
        {
          trackId: "cv_track_2",
          trackIndex: 2,
          sourceSlot: 1,
          text: "欢迎收看今晚八点档的新闻联播特别节目现在播报天气",
        },
      ],
      { totalTracksInBatch: 2, mode: "final", systemOneClient: delayedClient },
    );
    await Bun.sleep(10);
    mgr.reset(); // 模拟请求未返回时对话已退出
    releaseFetch();
    const staleRes = await pendingEval;
    expect(staleRes.newlyMuted).toHaveLength(0);
    expect(mgr.mutedCount).toBe(0);
  });
});

describe("VoiceListenerController 多轨屏蔽集成测试", () => {
  test("多轨超 20 字由 SystemOne 屏蔽电视音轨：首轮跳过触发，同对话后续轮次跳过 ASR 与触发，退出对话后自动解除", async () => {
    const sysOne = startMockSystemOneHttpServer((state, questions) => {
      const answers: Record<string, unknown> = {};
      const tracks = (state.tracks as Array<{ track_index: number; text: string }>) ?? [];
      for (const [qKey, qDef] of Object.entries(questions)) {
        if (qKey.startsWith("track_")) {
          const idx = Number(qKey.replace("track_", ""));
          const tr = tracks.find((t) => t.track_index === idx);
          const isTv = Boolean(tr && /(?:新闻联播|观众|播报|电视|广告|旁白)/.test(tr.text));
          answers[qKey] = makeNoiseChoiceAnswer(isTv ? "background_noise_tv" : "human_speech", 0.96);
        } else {
          const fallback = fillNonTrackSystemOneDefaults(qKey, qDef, {
            decision: "direct_command",
            convAction: "followup",
          });
          if (fallback) answers[qKey] = fallback;
        }
      }
      return answers;
    });

    updateAgentVoiceConfig({
      voicePipelineMode: "clearvoice",
      wakeWordEnabled: true,
      wakeWords: ["Neo", "小派"],
      attentionMode: "smart",
      voiceprintMode: "off",
      conversationWindowSec: 25,
      maxConsecutiveSidetalk: 3,
      owwEnabled: false,
      systemOneMode: "on",
      systemOneBaseUrl: sysOne.url,
      systemOneApiKey: "mock-key",
      systemOneConfidenceThreshold: 0.65,
    });

    let turn = 1;
    const vadCalls: number[] = [];
    const asrCalls: number[] = [];
    const fakeEngine = {
      clearVoiceGpu: new ClearVoiceGpuRuntime(),
      openWakeWord: { isReady: false, getStatus: () => ({ ready: false, prototypeCount: 0 }) },
      sourceSeparator: { warmupAsync: async () => {} },
      tts: { getStatus: () => ({ ready: false, addonAvailable: false, readyVoices: [], activeVoice: null }) },
      setPreferredAsrEngine: () => {},
      setClearVoiceServiceUrl: () => {},
      getStatus: () => ({
        readyForLocalAsr: true,
        readyForClearVoiceGpu: true,
        readyForClearVoiceBss: true,
        readyForVoiceprint: false,
        clearVoice: new ClearVoiceGpuRuntime().getStatus(),
      }),
      detectSpeechSegments: (samples: Float32Array) => {
        const hz = estimateDominantZeroCrossingHz(samples, 16000);
        vadCalls.push(hz < 600 ? 1 : 2);
        return {
          hasSpeech: true,
          speechSamples: samples,
          speechRatio: 0.9,
          segmentCount: 1,
          engine: "silero" as const,
          durationMs: 3,
        };
      },
      transcribeLocal: async (samples: Float32Array): Promise<LocalAsrOutput> => {
        const hz = estimateDominantZeroCrossingHz(samples, 16000);
        const trackNum = hz < 600 ? 1 : 2;
        asrCalls.push(trackNum);
        let text = "";
        if (trackNum === 1) {
          text = turn === 1 ? "Neo，打开客厅吸顶灯" : turn === 2 ? "把亮度调高一点" : "Neo，关闭客厅吸顶灯";
        } else {
          text =
            turn === 1
              ? "欢迎收看今晚八点档的新闻联播节目，下面为您播报今日天气预报"
              : "电视广告时间现在为您推荐最新款家居产品限时优惠活动";
        }
        return {
          text,
          rawText: text,
          lang: "zh",
          emotion: "",
          event: "",
          engine: "qwen3-asr-remote",
          durationMs: 35,
        };
      },
      dispose: () => {},
    } as unknown as LocalVoiceEngine;

    const { controller, agent, cleanup } = buildTestController(fakeEngine);
    try {
      const track1Audio = makeSine(1.2, 16000, 320, 0.25);
      const track2Audio = makeSine(1.2, 16000, 900, 0.22);

      // ---- Turn 1：多轨并发，音轨 2 超 20 字，SystemOne 判定为电视并立即屏蔽 ----
      const r1 = await controller.processClearVoiceSeparatedTracks(
        [
          { trackId: "cv_track_1", trackIndex: 1, sourceSlot: 0, samples: track1Audio, energyRatio: 0.55 },
          { trackId: "cv_track_2", trackIndex: 2, sourceSlot: 1, samples: track2Audio, energyRatio: 0.45 },
        ],
        {
          denoiseEngine: "clearvoice-mossformer2-bss-se-remote",
          bssUsed: true,
          inputSnrDb: 8,
          denoiseMs: 40,
          rawDurationMs: 1200,
          preVadSegmented: true,
        },
        { lang: "zh-CN", autoDispatch: true, useLocal: true, asyncDispatch: false },
      );

      // Turn 1 两条轨都先做了 ASR，随后超 20 字触发 SystemOne 批量判别
      expect(asrCalls).toEqual([1, 2]);
      expect(sysOne.calls.some((c) => "track_1" in c.questions && "track_2" in c.questions)).toBe(true);

      expect(r1.matched).toBe(true);
      expect(r1.text).toBe("Neo，打开客厅吸顶灯");
      expect(r1.tracks![0]!.matched).toBe(true);
      expect(r1.tracks![0]!.muted).toBeUndefined();
      // 音轨 2 刚被屏蔽：不走注意力门控也不走 handleTranscript/Pi Agent，无历史记录污染
      expect(r1.tracks![1]!.muted).toBe(true);
      expect(r1.tracks![1]!.mutedJustNow).toBe(true);
      expect(r1.tracks![1]!.matched).toBe(false);
      expect(r1.tracks![1]!.attention?.stage).toBe("noise-track-muted");

      const snap1 = controller.snapshot();
      expect(snap1.dialogState).toBe("conversation");
      expect(snap1.mutedTracks).toHaveLength(1);
      expect(snap1.mutedTracks[0]!.trackIndex).toBe(2);
      expect(snap1.mutedTracks[0]!.sourceSlot).toBe(1);
      // 音轨 2 被屏蔽，绝不进入语音历史与 Pi Agent 时间线
      expect(snap1.history.filter((h) => h.trackIndex === 2)).toHaveLength(0);
      expect(agent.snapshot().timeline.filter((e) => e.role === "user")).toHaveLength(1);

      // ---- Turn 2（同一对话内）：音轨 2 直接跳过 VAD 与语音转文字（ASR）及后续触发 ----
      turn = 2;
      vadCalls.length = 0;
      asrCalls.length = 0;

      const r2 = await controller.processClearVoiceSeparatedTracks(
        [
          { trackId: "cv_track_1", trackIndex: 1, sourceSlot: 0, samples: track1Audio, energyRatio: 0.55 },
          { trackId: "cv_track_2", trackIndex: 2, sourceSlot: 1, samples: track2Audio, energyRatio: 0.45 },
        ],
        {
          denoiseEngine: "clearvoice-mossformer2-bss-se-remote",
          bssUsed: true,
          inputSnrDb: 8,
          denoiseMs: 40,
          rawDurationMs: 1200,
          preVadSegmented: true,
        },
        { lang: "zh-CN", autoDispatch: true, useLocal: true, asyncDispatch: false },
      );

      // 关键断言：音轨 2 完全未执行 VAD 与 ASR！仅音轨 1 执行了 ASR 与后续触发！
      expect(vadCalls).toEqual([1]);
      expect(asrCalls).toEqual([1]);
      expect(r2.matched).toBe(true);
      expect(r2.tracks![0]!.matched).toBe(true);
      expect(r2.tracks![1]!.muted).toBe(true);
      expect(r2.tracks![1]!.mutedJustNow).toBeUndefined();
      expect(r2.tracks![1]!.asrEngine).toBe("skipped-muted-track");
      expect(r2.tracks![1]!.text).toBe("");
      expect(r2.tracks![1]!.matched).toBe(false);

      // ---- 退出当前对话：屏蔽状态自动清空，下一轮新对话重新正常识别音轨 2 ----
      controller.exitConversation("timeout", { speakAck: false });
      expect(controller.snapshot().mutedTracks).toHaveLength(0);

      turn = 3;
      asrCalls.length = 0;
      await controller.processClearVoiceSeparatedTracks(
        [
          { trackId: "cv_track_1", trackIndex: 1, sourceSlot: 0, samples: track1Audio, energyRatio: 0.55 },
          { trackId: "cv_track_2", trackIndex: 2, sourceSlot: 1, samples: track2Audio, energyRatio: 0.45 },
        ],
        {
          denoiseEngine: "clearvoice-mossformer2-bss-se-remote",
          bssUsed: true,
          inputSnrDb: 8,
          denoiseMs: 40,
          rawDurationMs: 1200,
          preVadSegmented: true,
        },
        { lang: "zh-CN", autoDispatch: true, useLocal: true, asyncDispatch: false },
      );
      // 新对话开始时两条音轨均重新执行了 ASR（说明旧对话屏蔽已随退出解除）
      expect(asrCalls).toEqual([1, 2]);
    } finally {
      await cleanup();
    }
  });

  test("唤醒词纯唤醒（wake_only）进入对话时，唤醒同一批次已屏蔽的电视音轨在对话内持续保持屏蔽", async () => {
    const sysOne = startMockSystemOneHttpServer((state, questions) => {
      const answers: Record<string, unknown> = {};
      const tracks = (state.tracks as Array<{ track_index: number; text: string }>) ?? [];
      for (const [qKey, qDef] of Object.entries(questions)) {
        if (qKey.startsWith("track_")) {
          const idx = Number(qKey.replace("track_", ""));
          const tr = tracks.find((t) => t.track_index === idx);
          const isTv = Boolean(tr && /(?:电视剧|解说|新闻|广告)/.test(tr.text));
          answers[qKey] = makeNoiseChoiceAnswer(isTv ? "background_noise_tv" : "human_speech", 0.95);
        } else {
          const fallback = fillNonTrackSystemOneDefaults(qKey, qDef, {
            decision: "wake_only",
            convAction: "followup",
          });
          if (fallback) answers[qKey] = fallback;
        }
      }
      return answers;
    });

    updateAgentVoiceConfig({
      voicePipelineMode: "clearvoice",
      wakeWordEnabled: true,
      wakeWords: ["Neo"],
      attentionMode: "smart",
      voiceprintMode: "off",
      conversationWindowSec: 20,
      owwEnabled: false,
      systemOneMode: "on",
      systemOneBaseUrl: sysOne.url,
      systemOneApiKey: "mock-key",
    });

    let turn = 1;
    const asrCalls: number[] = [];
    const fakeEngine = {
      clearVoiceGpu: new ClearVoiceGpuRuntime(),
      openWakeWord: { isReady: false, getStatus: () => ({ ready: false, prototypeCount: 0 }) },
      sourceSeparator: { warmupAsync: async () => {} },
      tts: { getStatus: () => ({ ready: false, addonAvailable: false, readyVoices: [], activeVoice: null }) },
      setPreferredAsrEngine: () => {},
      setClearVoiceServiceUrl: () => {},
      getStatus: () => ({
        readyForLocalAsr: true,
        readyForClearVoiceGpu: true,
        readyForClearVoiceBss: true,
        readyForVoiceprint: false,
        clearVoice: new ClearVoiceGpuRuntime().getStatus(),
      }),
      detectSpeechSegments: (samples: Float32Array) => ({
        hasSpeech: true,
        speechSamples: samples,
        speechRatio: 0.9,
        segmentCount: 1,
        engine: "silero" as const,
        durationMs: 2,
      }),
      transcribeLocal: async (samples: Float32Array): Promise<LocalAsrOutput> => {
        const hz = estimateDominantZeroCrossingHz(samples, 16000);
        const trackNum = hz < 600 ? 1 : 2;
        asrCalls.push(trackNum);
        const text =
          trackNum === 1
            ? turn === 1
              ? "Neo"
              : "打开客厅吸顶灯"
            : "本集电视剧解说为您带来精彩剧情回顾与人物命运分析";
        return {
          text,
          rawText: text,
          lang: "zh",
          emotion: "",
          event: "",
          engine: "qwen3-asr-remote",
          durationMs: 25,
        };
      },
      dispose: () => {},
    } as unknown as LocalVoiceEngine;

    const { controller, cleanup } = buildTestController(fakeEngine);
    try {
      const track1Audio = makeSine(1.0, 16000, 320, 0.25);
      const track2Audio = makeSine(1.0, 16000, 900, 0.22);

      // Turn 1：待机态唤醒词 "Neo" + 音轨 2 电视解说超 20 字 -> 屏蔽音轨 2 并进入连续对话
      const r1 = await controller.processClearVoiceSeparatedTracks(
        [
          { trackId: "cv_track_1", trackIndex: 1, sourceSlot: 0, samples: track1Audio },
          { trackId: "cv_track_2", trackIndex: 2, sourceSlot: 1, samples: track2Audio },
        ],
        {
          denoiseEngine: "clearvoice-mossformer2-bss-se-remote",
          bssUsed: true,
          inputSnrDb: 8,
          denoiseMs: 30,
          rawDurationMs: 1000,
          preVadSegmented: true,
        },
        { lang: "zh-CN", autoDispatch: true, useLocal: true, asyncDispatch: false },
      );

      expect(r1.wokeOnly).toBe(true);
      expect(controller.dialogState).toBe("conversation");
      expect(controller.snapshot().mutedTracks.map((m) => m.trackIndex)).toEqual([2]);

      // Turn 2：刚进入的连续对话中，音轨 2 继续保持屏蔽、跳过 ASR
      turn = 2;
      asrCalls.length = 0;
      const r2 = await controller.processClearVoiceSeparatedTracks(
        [
          { trackId: "cv_track_1", trackIndex: 1, sourceSlot: 0, samples: track1Audio },
          { trackId: "cv_track_2", trackIndex: 2, sourceSlot: 1, samples: track2Audio },
        ],
        {
          denoiseEngine: "clearvoice-mossformer2-bss-se-remote",
          bssUsed: true,
          inputSnrDb: 8,
          denoiseMs: 30,
          rawDurationMs: 1000,
          preVadSegmented: true,
        },
        { lang: "zh-CN", autoDispatch: true, useLocal: true, asyncDispatch: false },
      );

      expect(asrCalls).toEqual([1]);
      expect(r2.matched).toBe(true);
      expect(r2.tracks![1]!.muted).toBe(true);
      expect(r2.tracks![1]!.asrEngine).toBe("skipped-muted-track");
    } finally {
      await cleanup();
    }
  });

  test("同一对话内跨轮次累计超出 20 字后触发 SystemOne 屏蔽，后续轮次跳过 ASR", async () => {
    const sysOne = startMockSystemOneHttpServer((state, questions) => {
      const answers: Record<string, unknown> = {};
      const tracks = (state.tracks as Array<{ track_index: number; text: string }>) ?? [];
      for (const [qKey, qDef] of Object.entries(questions)) {
        if (qKey.startsWith("track_")) {
          const idx = Number(qKey.replace("track_", ""));
          const tr = tracks.find((t) => t.track_index === idx);
          const isTv = Boolean(tr && /(?:观众|新闻|焦点)/.test(tr.text));
          answers[qKey] = makeNoiseChoiceAnswer(isTv ? "background_noise_tv" : "human_speech", 0.94);
        } else {
          const fallback = fillNonTrackSystemOneDefaults(qKey, qDef, { convAction: "side_talk" });
          if (fallback) answers[qKey] = fallback;
        }
      }
      return answers;
    });

    updateAgentVoiceConfig({
      voicePipelineMode: "clearvoice",
      wakeWordEnabled: true,
      wakeWords: ["Neo"],
      attentionMode: "smart",
      voiceprintMode: "off",
      conversationWindowSec: 25,
      owwEnabled: false,
      systemOneMode: "on",
      systemOneBaseUrl: sysOne.url,
      systemOneApiKey: "mock-key",
    });

    let turn = 1;
    const asrCalls: number[] = [];
    const fakeEngine = {
      clearVoiceGpu: new ClearVoiceGpuRuntime(),
      openWakeWord: { isReady: false, getStatus: () => ({ ready: false, prototypeCount: 0 }) },
      sourceSeparator: { warmupAsync: async () => {} },
      tts: { getStatus: () => ({ ready: false, addonAvailable: false, readyVoices: [], activeVoice: null }) },
      setPreferredAsrEngine: () => {},
      setClearVoiceServiceUrl: () => {},
      getStatus: () => ({
        readyForLocalAsr: true,
        readyForClearVoiceGpu: true,
        readyForClearVoiceBss: true,
        readyForVoiceprint: false,
        clearVoice: new ClearVoiceGpuRuntime().getStatus(),
      }),
      detectSpeechSegments: (samples: Float32Array) => ({
        hasSpeech: true,
        speechSamples: samples,
        speechRatio: 0.9,
        segmentCount: 1,
        engine: "silero" as const,
        durationMs: 2,
      }),
      transcribeLocal: async (samples: Float32Array): Promise<LocalAsrOutput> => {
        const hz = estimateDominantZeroCrossingHz(samples, 16000);
        const trackNum = hz < 600 ? 1 : 2;
        asrCalls.push(trackNum);
        const text =
          trackNum === 1
            ? turn === 1
              ? "打开客厅灯" // 5 chars
              : "调亮一点" // 4 chars
            : turn === 1
              ? "各位观众朋友们大家好" // 10 chars (turn1 total = 15 <= 20)
              : "欢迎收看今晚的焦点访谈新闻"; // +12 chars -> track2 cum = 22 > 20
        return {
          text,
          rawText: text,
          lang: "zh",
          emotion: "",
          event: "",
          engine: "qwen3-asr-remote",
          durationMs: 20,
        };
      },
      dispose: () => {},
    } as unknown as LocalVoiceEngine;

    const { controller, cleanup } = buildTestController(fakeEngine);
    try {
      controller.enterConversation("manual", { speakAck: false });
      const track1Audio = makeSine(1.0, 16000, 320, 0.25);
      const track2Audio = makeSine(1.0, 16000, 900, 0.22);

      // Turn 1：总计 15 字 <= 20，不触发 SystemOne 噪音音轨判别
      await controller.processClearVoiceSeparatedTracks(
        [
          { trackId: "cv_track_1", trackIndex: 1, sourceSlot: 0, samples: track1Audio },
          { trackId: "cv_track_2", trackIndex: 2, sourceSlot: 1, samples: track2Audio },
        ],
        {
          denoiseEngine: "clearvoice-mossformer2-bss-se-remote",
          bssUsed: true,
          inputSnrDb: 8,
          denoiseMs: 25,
          rawDurationMs: 1000,
          preVadSegmented: true,
        },
        { lang: "zh-CN", autoDispatch: true, useLocal: true, asyncDispatch: false },
      );
      expect(sysOne.calls.filter((c) => "track_2" in c.questions)).toHaveLength(0);
      expect(controller.snapshot().mutedTracks).toHaveLength(0);

      // Turn 2：音轨 2 累计达到 22 字 > 20 -> 触发 SystemOne 判别并屏蔽音轨 2
      turn = 2;
      const r2 = await controller.processClearVoiceSeparatedTracks(
        [
          { trackId: "cv_track_1", trackIndex: 1, sourceSlot: 0, samples: track1Audio },
          { trackId: "cv_track_2", trackIndex: 2, sourceSlot: 1, samples: track2Audio },
        ],
        {
          denoiseEngine: "clearvoice-mossformer2-bss-se-remote",
          bssUsed: true,
          inputSnrDb: 8,
          denoiseMs: 25,
          rawDurationMs: 1000,
          preVadSegmented: true,
        },
        { lang: "zh-CN", autoDispatch: true, useLocal: true, asyncDispatch: false },
      );
      expect(sysOne.calls.filter((c) => "track_2" in c.questions)).toHaveLength(1);
      expect(r2.tracks![1]!.muted).toBe(true);
      expect(controller.snapshot().mutedTracks.map((m) => m.trackIndex)).toEqual([2]);

      // Turn 3：音轨 2 直接跳过 ASR
      turn = 3;
      asrCalls.length = 0;
      await controller.processClearVoiceSeparatedTracks(
        [
          { trackId: "cv_track_1", trackIndex: 1, sourceSlot: 0, samples: track1Audio },
          { trackId: "cv_track_2", trackIndex: 2, sourceSlot: 1, samples: track2Audio },
        ],
        {
          denoiseEngine: "clearvoice-mossformer2-bss-se-remote",
          bssUsed: true,
          inputSnrDb: 8,
          denoiseMs: 25,
          rawDurationMs: 1000,
          preVadSegmented: true,
        },
        { lang: "zh-CN", autoDispatch: true, useLocal: true, asyncDispatch: false },
      );
      expect(asrCalls).toEqual([1]);
    } finally {
      await cleanup();
    }
  });

  test("单轨超 20 字绝不触发屏蔽；待机未唤醒批次的临时屏蔽不泄漏到后续新对话", async () => {
    const sysOne = startMockSystemOneHttpServer((state, questions) => {
      const answers: Record<string, unknown> = {};
      const tracks = (state.tracks as Array<{ track_index: number; text: string }>) ?? [];
      for (const [qKey, qDef] of Object.entries(questions)) {
        if (qKey.startsWith("track_")) {
          const idx = Number(qKey.replace("track_", ""));
          const tr = tracks.find((t) => t.track_index === idx);
          const isTv = Boolean(tr && /(?:电视|新闻|旁白)/.test(tr.text));
          answers[qKey] = makeNoiseChoiceAnswer(isTv ? "background_noise_tv" : "human_speech", 0.96);
        } else {
          const fallback = fillNonTrackSystemOneDefaults(qKey, qDef, {
            decision: "ignore",
            convAction: "side_talk",
          });
          if (fallback) answers[qKey] = fallback;
        }
      }
      return answers;
    });

    updateAgentVoiceConfig({
      voicePipelineMode: "clearvoice",
      wakeWordEnabled: true,
      wakeWords: ["Neo"],
      attentionMode: "smart",
      voiceprintMode: "off",
      conversationWindowSec: 20,
      owwEnabled: false,
      systemOneMode: "on",
      systemOneBaseUrl: sysOne.url,
      systemOneApiKey: "mock-key",
    });

    const fakeEngine = {
      clearVoiceGpu: new ClearVoiceGpuRuntime(),
      openWakeWord: { isReady: false, getStatus: () => ({ ready: false, prototypeCount: 0 }) },
      sourceSeparator: { warmupAsync: async () => {} },
      tts: { getStatus: () => ({ ready: false, addonAvailable: false, readyVoices: [], activeVoice: null }) },
      setPreferredAsrEngine: () => {},
      setClearVoiceServiceUrl: () => {},
      getStatus: () => ({
        readyForLocalAsr: true,
        readyForClearVoiceGpu: true,
        readyForClearVoiceBss: true,
        readyForVoiceprint: false,
        clearVoice: new ClearVoiceGpuRuntime().getStatus(),
      }),
      detectSpeechSegments: (samples: Float32Array) => ({
        hasSpeech: true,
        speechSamples: samples,
        speechRatio: 0.9,
        segmentCount: 1,
        engine: "silero" as const,
        durationMs: 2,
      }),
      transcribeLocal: async (samples: Float32Array): Promise<LocalAsrOutput> => {
        const hz = estimateDominantZeroCrossingHz(samples, 16000);
        const text =
          hz < 600
            ? "今天天气不错我们一会儿去超市买点水果吧"
            : "电视新闻旁白正在播报今日晚间焦点节目请大家收看";
        return {
          text,
          rawText: text,
          lang: "zh",
          emotion: "",
          event: "",
          engine: "qwen3-asr-remote",
          durationMs: 20,
        };
      },
      dispose: () => {},
    } as unknown as LocalVoiceEngine;

    const { controller, cleanup } = buildTestController(fakeEngine);
    try {
      const track1Audio = makeSine(1.0, 16000, 320, 0.25);
      const track2Audio = makeSine(1.0, 16000, 900, 0.22);

      // 1. 单轨超 20 字 -> 绝不调用 SystemOne 多轨噪音判别，绝不屏蔽
      controller.enterConversation("manual", { speakAck: false });
      await controller.processClearVoiceSeparatedTracks(
        [{ trackId: "cv_track_1", trackIndex: 1, sourceSlot: 0, samples: track2Audio }],
        {
          denoiseEngine: "clearvoice-mossformer2-remote",
          bssUsed: false,
          inputSnrDb: 10,
          denoiseMs: 20,
          rawDurationMs: 1000,
          preVadSegmented: true,
        },
        { lang: "zh-CN", autoDispatch: true, useLocal: true, asyncDispatch: false },
      );
      expect(sysOne.calls.filter((c) => "track_1" in c.questions)).toHaveLength(0);
      expect(controller.snapshot().mutedTracks).toHaveLength(0);

      // 2. 待机态（未唤醒、未进入对话）：虽然当批屏蔽了电视轨，但批次结束仍在待机 -> 自动清理不泄漏到未来新对话
      controller.exitConversation("timeout", { speakAck: false });
      const standbyRes = await controller.processClearVoiceSeparatedTracks(
        [
          { trackId: "cv_track_1", trackIndex: 1, sourceSlot: 0, samples: track1Audio },
          { trackId: "cv_track_2", trackIndex: 2, sourceSlot: 1, samples: track2Audio },
        ],
        {
          denoiseEngine: "clearvoice-mossformer2-bss-se-remote",
          bssUsed: true,
          inputSnrDb: 8,
          denoiseMs: 25,
          rawDurationMs: 1000,
          preVadSegmented: true,
        },
        { lang: "zh-CN", autoDispatch: true, useLocal: true, asyncDispatch: false },
      );
      expect(standbyRes.tracks![1]!.muted).toBe(true);
      expect(controller.dialogState).toBe("standby");
      expect(controller.snapshot().mutedTracks).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });
});

describe("VoiceStreamSession 实时多轨流式预览超 20 字即时屏蔽与零后续 ASR 端到端测试", () => {
  test("流式第 1 切片超 20 字即由 SystemOne 屏蔽电视音轨，第 2 切片与话语收尾均直接跳过电视音轨 ASR 与触发", async () => {
    const sysOne = startMockSystemOneHttpServer((state, questions) => {
      const answers: Record<string, unknown> = {};
      const tracks = (state.tracks as Array<{ track_index: number; text: string }>) ?? [];
      for (const [qKey, qDef] of Object.entries(questions)) {
        if (qKey.startsWith("track_")) {
          const idx = Number(qKey.replace("track_", ""));
          const tr = tracks.find((t) => t.track_index === idx);
          const isTv = Boolean(tr && /(?:新闻联播|天气预报|观众)/.test(tr.text));
          answers[qKey] = makeNoiseChoiceAnswer(isTv ? "background_noise_tv" : "human_speech", 0.97);
        } else {
          const fallback = fillNonTrackSystemOneDefaults(qKey, qDef, {
            decision: "direct_command",
            convAction: "followup",
          });
          if (fallback) answers[qKey] = fallback;
        }
      }
      return answers;
    });

    updateAgentVoiceConfig({
      voicePipelineMode: "clearvoice",
      qwen3StreamingEnabled: true,
      wakeWordEnabled: true,
      wakeWords: ["Neo"],
      attentionMode: "smart",
      voiceprintMode: "off",
      conversationWindowSec: 25,
      owwEnabled: false,
      systemOneMode: "on",
      systemOneBaseUrl: sysOne.url,
      systemOneApiKey: "mock-key",
    });

    // Mock 在线 ClearVoice 多轨网关：2 轨（320Hz 用户 + 880Hz 电视）
    let sepCount = 0;
    let totalSamples = 0;
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
                  loaded_models: [
                    { name: "MossFormer2_SE_48K", task: "speech_enhancement" },
                    { name: "MossFormer2_SS_16K", task: "speech_separation" },
                  ],
                },
              },
            },
          });
        }
        if (u.pathname === "/clearvoice/v1/enhance") {
          const form = await req.formData();
          const file = form.get("file") as Blob;
          const decoded = decodeWavPcm(new Uint8Array(await file.arrayBuffer()));
          const outWav = encodeWavPcm16(decoded.samples, decoded.sampleRate);
          return new Response(new Uint8Array(outWav), {
            status: 200,
            headers: {
              "Content-Type": "audio/wav",
              "X-ClearVoice-Model": "MossFormer2_SE_48K",
              "X-Elapsed-Ms": "12.0",
            },
          });
        }
        if (u.pathname === "/clearvoice/v1/separate") {
          const form = await req.formData();
          const file = form.get("file") as Blob;
          const decoded = decodeWavPcm(new Uint8Array(await file.arrayBuffer()));
          const n = decoded.samples.length;
          const sr = decoded.sampleRate;
          const idx = sepCount++;
          const startPos = idx === 0 ? 0 : Math.max(0, totalSamples - 4800);
          totalSamples = startPos + n;
          const tUser = makeSineSlice(startPos, n, sr, 320, 0.26);
          const tTv = makeSineSlice(startPos, n, sr, 880, 0.22);
          return Response.json({
            task: "speech_separation",
            model: "MossFormer2_SS_16K",
            elapsed_ms: 25.0,
            speakers: [tUser, tTv].map((tr, spIdx) => ({
              speaker: spIdx + 1,
              sample_rate: sr,
              audio_base64: Buffer.from(encodeWavPcm16(tr, sr)).toString("base64"),
            })),
          });
        }
        return new Response("not found", { status: 404 });
      },
    });

    const cvRuntime = new ClearVoiceGpuRuntime({
      serviceUrl: `http://127.0.0.1:${mockCvServer.port}`,
    });

    const asrCalls: Array<{ track: number; samples: number }> = [];
    const fakeEngine = {
      clearVoiceGpu: cvRuntime,
      openWakeWord: { isReady: false, getStatus: () => ({ ready: false, prototypeCount: 0 }) },
      sourceSeparator: { warmupAsync: async () => {} },
      tts: { getStatus: () => ({ ready: false, addonAvailable: false, readyVoices: [], activeVoice: null }) },
      setPreferredAsrEngine: () => {},
      setClearVoiceServiceUrl: () => {},
      createOnlineDenoiser: () => null,
      createStreamingVad: () => createEnergyMockVad(0.02),
      createWakeWordStream: () => null,
      getStatus: () => ({
        readyForLocalAsr: true,
        activeQwen3Device: "remote",
        readyForClearVoiceGpu: true,
        readyForClearVoiceBss: true,
        readyForVoiceprint: false,
        clearVoice: cvRuntime.getStatus(),
      }),
      detectSpeechSegments: (samples: Float32Array) => ({
        hasSpeech: true,
        speechSamples: samples,
        speechRatio: 0.9,
        segmentCount: 1,
        engine: "silero" as const,
        durationMs: 2,
      }),
      transcribeLocal: async (samples: Float32Array): Promise<LocalAsrOutput> => {
        const hz = estimateDominantZeroCrossingHz(samples, 16000);
        const track = hz < 600 ? 1 : 2;
        asrCalls.push({ track, samples: samples.length });
        const text =
          track === 1
            ? "打开客厅吸顶灯"
            : "各位观众晚上好欢迎收看今晚的新闻联播节目下面为您播报天气预报";
        return {
          text,
          rawText: text,
          lang: "zh",
          emotion: "",
          event: "",
          engine: "qwen3-asr-remote",
          durationMs: 30,
          computeDevice: "remote",
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

    const { controller, cleanup } = buildTestController(fakeEngine);
    try {
      controller.enterConversation("manual", { speakAck: false });
      const partials: StreamingPartialUpdate[] = [];
      let finalResult: Awaited<ReturnType<VoiceListenerController["processDualTrackSegment"]>> | null =
        null;

      const session = new VoiceStreamSession({
        localEngine: fakeEngine,
        noiseMode: "auto",
        voicePipelineMode: "clearvoice",
        streamingAsrEnabled: true,
        wakeWords: ["Neo"],
        isInConversation: () => controller.dialogState === "conversation",
        trackMuteManager: controller.trackMuteManager,
        getSystemOneClient: () => controller.systemOneClient,
        getRecentHistory: () => controller.getRecentHistoryForSystemOne(5),
        getDialogEpoch: () => controller.dialogEpoch,
        onPartialTranscript: (ev) => {
          partials.push(ev);
        },
        onSegmentReady: async (seg: VoiceStreamSegmentPayload) => {
          finalResult = await controller.processDualTrackSegment(seg, {
            lang: "zh-CN",
            preferredEngine: "local",
            asyncDispatch: false,
          });
          return finalResult;
        },
      });

      // 连续推入 4.5s 双人叠加语音（320Hz 用户 + 880Hz 电视，在 2.0s 与 4.0s 分别触发 2 次流式预览切片）+ 静音收尾
      const mixUser = makeSine(4.5, 16000, 320, 0.26);
      const mixTv = makeSine(4.5, 16000, 880, 0.22);
      const mixed45 = new Float32Array(mixUser.length);
      for (let i = 0; i < mixed45.length; i += 1) {
        mixed45[i] = mixUser[i]! + mixTv[i]!;
      }
      session.pushFloat32Samples(mixed45);
      session.pushFloat32Samples(new Float32Array(Math.round(16000 * 0.4)));
      await session.flush();
      await session.waitForIdle();
      session.dispose();

      // 关键断言：
      // 1. 电视音轨（track 2）仅在第 1 次流式预览被转写过 1 次（超 20 字后即刻被 SystemOne 屏蔽）！
      // 2. 第 2 次流式预览切片与话语收尾正式识别均完全跳过了音轨 2 的 ASR！
      const track2AsrCalls = asrCalls.filter((c) => c.track === 2);
      const track1AsrCalls = asrCalls.filter((c) => c.track === 1);
      expect(track2AsrCalls).toHaveLength(1);
      expect(track1AsrCalls.length).toBeGreaterThanOrEqual(3); // 2 次流式预览 + 1 次最终收尾

      // 3. 实时字幕预览中不包含已被屏蔽的电视音轨
      expect(partials.length).toBeGreaterThanOrEqual(1);
      for (const p of partials) {
        expect(p.text).not.toContain("新闻联播");
        expect(p.tracks?.some((t) => t.trackIndex === 2)).toBe(false);
      }

      // 4. 最终结果：音轨 1 正常执行，音轨 2 保持屏蔽状态且跳过了最终 ASR
      expect(finalResult).not.toBeNull();
      expect(finalResult!.matched).toBe(true);
      expect(finalResult!.text).toBe("打开客厅吸顶灯");
      expect(finalResult!.tracks).toHaveLength(2);
      expect(finalResult!.tracks![0]!.matched).toBe(true);
      expect(finalResult!.tracks![1]!.muted).toBe(true);
      expect(finalResult!.tracks![1]!.asrEngine).toBe("skipped-muted-track");
      expect(finalResult!.tracks![1]!.matched).toBe(false);
    } finally {
      await cleanup();
    }
  });
});
