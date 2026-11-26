// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 静音/低能量 ASR 幻觉与热词 Prompt 回显防护回归测试

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isAsrHallucinationText,
  isKnownAsrSilenceHallucination,
  isWakeWordPromptHallucination,
  sanitizeAsrTranscript,
  stripRepeatedLeadingWakeWords,
} from "../src/agent/asrHallucinationGuard.ts";
import { hasAudibleAudioEnergy } from "../src/agent/audioPcm.ts";
import type { LocalAsrOutput, LocalVoiceEngine, StreamingVadHandleLike } from "../src/agent/localVoiceEngine.ts";
import { PiAgentService } from "../src/agent/piAgentService.ts";
import type { StreamingPartialUpdate } from "../src/agent/streamingAsrTracker.ts";
import { evaluateVoiceAttention } from "../src/agent/voiceAttentionGate.ts";
import { VoiceListenerController } from "../src/agent/voiceListenerController.ts";
import { VoiceStreamSession, type VoiceStreamSegmentPayload } from "../src/agent/voiceStreamSession.ts";
import {
  defaultAgentVoiceConfig,
  normalizeAgentVoiceConfig,
} from "../src/core/agentConfigStore.ts";
import { NetworkMonitor } from "../src/core/availability.ts";
import { JobExecutor } from "../src/core/jobs.ts";
import { setDataPathOverrides } from "../src/core/jsonStore.ts";
import * as settingsStore from "../src/core/settingsStore.ts";
import { VirtualDemoService } from "../src/core/virtualLightService.ts";
import { MainWindowController } from "../src/ui/controllers/mainWindowController.ts";
import { applyTheme, ThemeController } from "../src/ui/theme.ts";

const USER_WAKE_WORDS = ["嘿Neo", "尼奥", "鸟", "嘿6", "Neo"];

let tmpDir = "";

function makeSine(durationSec: number, amp = 0.2, freqHz = 440, sr = 16000): Float32Array {
  const n = Math.round(durationSec * sr);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    out[i] = Math.sin((2 * Math.PI * freqHz * i) / sr) * amp;
  }
  return out;
}

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "mijiadeck-asr-hallucination-"));
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

describe("ASR Hallucination & Hotword Prompt Leakage Guard", () => {
  test("detects exact wakeword-list regurgitation hallucinations", () => {
    const hallucinations = [
      "嘿Neo 尼奥 鸟 嘿6 Neo",
      "嘿，Neo 尼奥 鸟 嘿6。",
      "嘿Neo 尼奥 鸟 嘿6",
      "尼奥 鸟 嘿6 Neo",
      "尼奥 鸟 嘿6",
      "尼奥 鸟",
      "你好呀，Neo 尼奥 鸟 嘿6 Neo。",
      "Neo 小派",
    ];
    const combinedWakeWords = [...USER_WAKE_WORDS, "小派"];

    for (const sample of hallucinations) {
      expect(isWakeWordPromptHallucination(sample, combinedWakeWords)).toBe(true);
      expect(sanitizeAsrTranscript(sample, { wakeWords: combinedWakeWords })).toBe("");
    }
  });

  test("detects classic subtitle silence hallucinations, non-speech tags, and degenerate repetition loops", () => {
    const silenceHallucinations = [
      "感谢观看",
      "感谢您的观看。",
      "谢谢大家观看！",
      "请不吝点赞订阅转发打赏支持明镜与点点栏目",
      "字幕由Amara.org社区提供",
      "Thanks for watching.",
      "Subtitles by the Amara.org community",
      "ご視聴ありがとうございました",
      "[Music]",
      "(Silence)",
      "♪ ...",
      "啊啊啊啊啊啊",
      "谢谢 谢谢 谢谢 谢谢",
      "好的好的好的好的",
    ];

    for (const sample of silenceHallucinations) {
      expect(isKnownAsrSilenceHallucination(sample)).toBe(true);
      expect(sanitizeAsrTranscript(sample, { wakeWords: USER_WAKE_WORDS })).toBe("");
    }
  });

  test("preserves valid wake words, short confirmations, exit phrases, and smart-home commands", () => {
    const validUtterances = [
      "Neo",
      "嘿Neo",
      "嘿，Neo",
      "嘿Neo，Neo",
      "尼奥",
      "ニ요.",
      "2お.",
      "对",
      "好",
      "嗯",
      "谢谢",
      "谢谢，不用了",
      "好了，谢谢，不用了。",
      "打开个性灯",
      "Neo，打开客厅吸顶灯",
      "嘿Neo，把卧室空调调到26度",
      "1000000",
    ];

    for (const sample of validUtterances) {
      expect(isAsrHallucinationText(sample, USER_WAKE_WORDS)).toBe(false);
      expect(sanitizeAsrTranscript(sample, { wakeWords: USER_WAKE_WORDS })).toBe(sample);
    }

    expect(stripRepeatedLeadingWakeWords("Neo", "嘿Neo", USER_WAKE_WORDS)).toBe("");
    expect(stripRepeatedLeadingWakeWords("Neo，打开客厅灯", "嘿Neo", USER_WAKE_WORDS)).toBe(
      "打开客厅灯",
    );
  });

  test("hasAudibleAudioEnergy blocks digital silence, thermal mic floor, and 10ms clicks while keeping soft short speech", () => {
    // 1. Pure silence
    expect(hasAudibleAudioEnergy(new Float32Array(16000), 16000)).toBe(false);

    // 2. Quiet mic floor (peak 0.004)
    const floor = new Float32Array(16000);
    for (let i = 0; i < floor.length; i += 1) {
      floor[i] = Math.sin(i * 0.13) * 0.004;
    }
    expect(hasAudibleAudioEnergy(floor, 16000)).toBe(false);

    // 3. Tiny single 10ms electrical click in 1s silence
    const click = new Float32Array(16000);
    for (let i = 4000; i < 4160; i += 1) {
      click[i] = 0.04 * Math.sin(((i - 4000) / 160) * Math.PI);
    }
    expect(hasAudibleAudioEnergy(click, 16000)).toBe(false);

    // 4. Short soft utterance ("对", 160ms at amp 0.02 inside 2s silence)
    const softShort = new Float32Array(32000);
    for (let i = 8000; i < 10560; i += 1) {
      softShort[i] = 0.02 * Math.sin((2 * Math.PI * 300 * i) / 16000);
    }
    expect(hasAudibleAudioEnergy(softShort, 16000)).toBe(true);

    // 5. Normal speech-level signal
    expect(hasAudibleAudioEnergy(makeSine(1.0, 0.12), 16000)).toBe(true);
  });
});

describe("End-to-End VoiceStreamSession, Attention Gate & VoiceListenerController Protection", () => {
  test("VoiceStreamSession drops silent VAD blips and strips hallucinated streaming partials", async () => {
    let emittedFakeSeg = false;
    let fakeVadDetected = false;
    let fakeVadSegs: Array<{ start: number; samples: Float32Array }> = [];
    let fedTotal = 0;

    // Simulate a hyper-sensitive VAD that falsely fires on silence
    const falseTriggerVad: StreamingVadHandleLike = {
      acceptWaveform(frame: Float32Array) {
        fedTotal += frame.length;
        if (!emittedFakeSeg && fedTotal >= 16000 * 0.4 && fedTotal < 16000 * 1.2) {
          fakeVadDetected = true;
        } else if (fakeVadDetected) {
          fakeVadDetected = false;
          emittedFakeSeg = true;
          fakeVadSegs.push({ start: 6400, samples: new Float32Array(12800) });
        }
      },
      isEmpty: () => fakeVadSegs.length === 0,
      isDetected: () => fakeVadDetected,
      front: () => fakeVadSegs[0]!,
      pop: () => {
        fakeVadSegs.shift();
      },
      flush: () => {},
      reset: () => {
        fakeVadDetected = false;
        fakeVadSegs = [];
      },
      clear: () => {
        fakeVadSegs = [];
      },
    };

    let asrCalls = 0;
    const partials: StreamingPartialUpdate[] = [];
    const segments: VoiceStreamSegmentPayload[] = [];
    const mockEngine = {
      createOnlineDenoiser: () => null,
      createStreamingVad: () => falseTriggerVad,
      createWakeWordStream: () => null,
      getStatus: () => ({ readyForLocalAsr: true }),
      transcribeLocal: async (): Promise<LocalAsrOutput> => {
        asrCalls += 1;
        return {
          text: "嘿Neo 尼奥 鸟 嘿6 Neo",
          rawText: "嘿Neo 尼奥 鸟 嘿6 Neo",
          lang: "Chinese",
          emotion: "",
          event: "",
          engine: "sensevoice-local",
          durationMs: 10,
        };
      },
    };

    const session = new VoiceStreamSession({
      localEngine: mockEngine as unknown as LocalVoiceEngine,
      noiseMode: "off",
      bypassWakeWord: true,
      wakeWords: USER_WAKE_WORDS,
      owwEnabled: false,
      streamingAsrEnabled: true,
      streamingPollIntervalMs: 256,
      onPartialTranscript: (p) => partials.push(p),
      onSegmentReady: async (seg) => {
        segments.push(seg);
        return null;
      },
    });

    // Push 2 seconds of pure silence while VAD falsely triggers
    const silence = new Float32Array(16000 * 2);
    for (let off = 0; off < silence.length; off += 1024) {
      session.pushFloat32Samples(silence.subarray(off, off + 1024));
    }
    await Bun.sleep(40);
    await session.waitForIdle();
    session.dispose();

    expect(asrCalls).toBe(0);
    expect(partials).toHaveLength(0);
    expect(segments).toHaveLength(0);
  });

  test("evaluateVoiceAttention & VoiceListenerController reject wakeword prompt dumps without invoking PiAgent or replying 在呢", async () => {
    for (const mode of [
      { dialogState: "standby" as const, inConversation: false, bypassWakeWord: false },
      { dialogState: "conversation" as const, inConversation: true, bypassWakeWord: false },
      { dialogState: "conversation" as const, inConversation: true, bypassWakeWord: true },
    ]) {
      for (const bad of ["嘿Neo 尼奥 鸟 嘿6 Neo", "尼奥 鸟 嘿6 Neo", "尼奥 鸟 嘿6"]) {
        const dec = await evaluateVoiceAttention({
          rawText: bad,
          wakeWordEnabled: true,
          wakeWords: USER_WAKE_WORDS,
          attentionMode: "smart",
          dialogState: mode.dialogState,
          inConversation: mode.inConversation,
          bypassWakeWord: mode.bypassWakeWord,
        });
        expect(dec.accept).toBe(false);
        expect(dec.command).toBe("");
      }
    }

    // Repeated same wake word ("嘿Neo，Neo") is wake-only, never dispatches "Neo" as a command
    const repWake = await evaluateVoiceAttention({
      rawText: "嘿Neo，Neo",
      wakeWordEnabled: true,
      wakeWords: USER_WAKE_WORDS,
      attentionMode: "smart",
      dialogState: "standby",
      inConversation: false,
    });
    expect(repWake.accept).toBe(true);
    expect(repWake.wokeOnly).toBe(true);
    expect(repWake.command).toBe("");

    // Full VoiceListenerController + PiAgentService integration: zero agent timeline entries, zero "在呢" replies
    applyTheme("dark", "green");
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
    const cfg = normalizeAgentVoiceConfig({
      ...defaultAgentVoiceConfig(),
      wakeWords: USER_WAKE_WORDS,
      wakeAckPhrase: "",
      autoSpeakReply: true,
      sourceSeparationMode: "off",
      owwEnabled: false,
    });
    const agent = new PiAgentService({
      deps: { mainWindow: mw, service: demo, jobs, settingsStore, broadcastState: () => {} },
      initialConfig: cfg,
    });
    const vl = new VoiceListenerController(agent);
    const spoken: string[] = [];
    vl.on("speakRequested", (txt) => spoken.push(txt));
    vl.on("speakChunkRequested", ({ text }) => spoken.push(text));

    try {
      vl.enterConversation("command_done", { speakAck: false });
      const r1 = await vl.handleTranscript("嘿Neo 尼奥 鸟 嘿6 Neo", { isFinal: true });
      const r2 = await vl.handleTranscript("尼奥 鸟 嘿6", { isFinal: true });
      expect(r1.matched).toBe(false);
      expect(r2.matched).toBe(false);
      expect(agent.snapshot().timeline).toHaveLength(0);
      expect(spoken).toHaveLength(0);
      expect(vl.snapshot().lastTranscript).toBe("");
    } finally {
      vl.dispose();
      agent.dispose();
      networkMonitor.stop();
      mw.dispose();
      await jobs.shutdown();
    }
  });
});
