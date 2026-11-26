// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 唤醒词触发后 SystemOne 纯误唤醒校验（无上下文/背景/意图判断，非误听直通下一流程）回归测试

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AudioSourceSeparator } from "../src/agent/audioSourceSeparator.ts";
import { buildHomeCapabilityDigest } from "../src/agent/intentCanonicalizer.ts";
import { LocalVoiceEngine, type LocalAsrOutput } from "../src/agent/localVoiceEngine.ts";
import type { WakeWordAcousticHit } from "../src/agent/openWakeWordEngine.ts";
import { PiAgentService } from "../src/agent/piAgentService.ts";
import {
  SystemOneClient,
  type WakeAttentionDecision,
  type WakeDeviceCommandDecision,
} from "../src/agent/systemOneClient.ts";
import {
  buildSuspectedWakeAliasHint,
  evaluateVoiceAttention,
  extractCommandAfterAcousticWake,
} from "../src/agent/voiceAttentionGate.ts";
import { VoiceListenerController } from "../src/agent/voiceListenerController.ts";
import {
  DEFAULT_SYSTEMONE_MODEL,
  defaultAgentVoiceConfig,
  normalizeAgentVoiceConfig,
} from "../src/core/agentConfigStore.ts";
import { NetworkMonitor } from "../src/core/availability.ts";
import type { FetchLike } from "../src/core/httpTimeout.ts";
import { JobExecutor } from "../src/core/jobs.ts";
import { setDataPathOverrides } from "../src/core/jsonStore.ts";
import { createDeviceInfo } from "../src/core/models.ts";
import * as settingsStore from "../src/core/settingsStore.ts";
import { VirtualDemoService } from "../src/core/virtualLightService.ts";
import { MainWindowController } from "../src/ui/controllers/mainWindowController.ts";
import { applyTheme, ThemeController } from "../src/ui/theme.ts";

interface CapturedSystemOneBody {
  model: string;
  state: Record<string, unknown>;
  questions: Record<string, { type: string; instructions: string; criteria?: Record<string, string> }>;
}

function makeMockSystemOneClient(
  resolver: (utterance: string, body: CapturedSystemOneBody) => {
    choice: WakeAttentionDecision;
    confidence?: number;
    deviceCommand?: WakeDeviceCommandDecision;
    deviceCommandConfidence?: number;
  },
  options?: { confidenceThreshold?: number },
): { client: SystemOneClient; calls: CapturedSystemOneBody[] } {
  const calls: CapturedSystemOneBody[] = [];
  const fetcher: FetchLike = async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as CapturedSystemOneBody;
    calls.push(body);
    const utterance = String(body.state?.utterance ?? "");
    const answers: Record<string, unknown> = {};

    if (body.questions.decision) {
      const verdict = resolver(utterance, body);
      const conf = verdict.confidence ?? 0.92;
      answers.decision = {
        type: "choice",
        choice: verdict.choice,
        probabilities: {
          valid_wake: verdict.choice === "valid_wake" ? conf : Number((1 - conf).toFixed(4)),
          false_wake: verdict.choice === "false_wake" ? conf : Number((1 - conf).toFixed(4)),
        },
        confidence: conf,
      };
      if (body.questions.device_command) {
        const cmdChoice: WakeDeviceCommandDecision = verdict.deviceCommand ?? "no_device_command";
        const cmdConf = verdict.deviceCommandConfidence ?? 0.92;
        answers.device_command = {
          type: "choice",
          choice: cmdChoice,
          probabilities: {
            has_device_command:
              cmdChoice === "has_device_command" ? cmdConf : Number((1 - cmdConf).toFixed(4)),
            no_device_command:
              cmdChoice === "no_device_command" ? cmdConf : Number((1 - cmdConf).toFixed(4)),
          },
          confidence: cmdConf,
        };
      }
    }

    if (body.questions.conv_action) {
      answers.conv_action = {
        type: "choice",
        choice: "followup",
        probabilities: { followup: 0.92, side_talk: 0.05, goodbye: 0.03 },
        confidence: 0.92,
      };
    }

    if (body.questions.intent) {
      answers.intent = {
        type: "choice",
        choice: "general_chat",
        probabilities: { device_control: 0.05, status_query: 0.05, scene: 0.05, general_chat: 0.85 },
        confidence: 0.85,
      };
    }

    if (body.questions.task_ack) {
      answers.task_ack = {
        type: "choice",
        choice: "greeting_chat",
        probabilities: {
          execute_control: 0.02,
          query_status: 0.02,
          think_creative: 0.02,
          scene_routine: 0.02,
          troubleshoot: 0.02,
          urgent_cancel: 0.02,
          remember_rule: 0.02,
          safety_confirm: 0.02,
          greeting_chat: 0.84,
        },
        confidence: 0.84,
      };
    }

    return new Response(
      JSON.stringify({
        model: DEFAULT_SYSTEMONE_MODEL,
        answers,
        usage: { input_tokens: 72, output_tokens: 4 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  const client = new SystemOneClient({
    baseUrl: "https://systemone.local.test/v1",
    apiKey: "sk-wake-pure-check",
    confidenceThreshold: options?.confidenceThreshold ?? 0.65,
    fetcher,
  });
  return { client, calls };
}

function makeAcousticHit(wakeWord = "Neo", score = 0.82): WakeWordAcousticHit {
  return {
    wakeWord,
    score,
    rawScore: score,
    threshold: 0.6,
    matched: true,
    source: "enrolled",
    frameIndex: 2,
    sampleOffset: 8000,
    latencyMs: 5,
  };
}

let tmpDir = "";

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "mijiadeck-wake-s1-"));
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

describe("Simplified Wake-Word SystemOne Verification (Pure False-Wake Check)", () => {
  test("strips all context, background, intent, and dual-track fields from wake-stage SystemOne payload", async () => {
    const { client, calls } = makeMockSystemOneClient(() => ({
      choice: "valid_wake",
      confidence: 0.94,
    }));

    const digest = buildHomeCapabilityDigest([
      createDeviceInfo({
        did: "midea:washer1",
        name: "美的可爱多",
        model: "midea.washer.0xd9",
        home_name: "方寸别院",
        room_name: "阳台",
        online: true,
        spec_type: "urn:midea:device:washer:0xd9:1",
        firmware: "V3 · 38135636 · LAN",
        platform: "midea",
      }),
    ]);

    const decision = await evaluateVoiceAttention({
      rawText: "Neo，明天北京天气怎么样，需要带伞吗",
      altText: "尼奥明天北京天气怎么样",
      wakeWordEnabled: true,
      wakeWords: ["Neo", "小派"],
      attentionMode: "smart",
      dialogState: "standby",
      inConversation: false,
      recentTurns: [
        { role: "user", text: "关闭客厅灯", timestamp: Date.now() - 5000 },
        { role: "assistant", text: "已关闭客厅吸顶灯", timestamp: Date.now() - 4000 },
      ],
      acousticEvent: "<|BGM|>",
      voiceprint: {
        evaluated: true,
        matched: true,
        speakerId: "vp_1",
        speakerName: "Henry",
        role: "owner",
        score: 0.88,
        threshold: 0.5,
        engine: "3dspeaker-campplus",
        enrolledCount: 1,
        candidates: [],
      },
      acousticWake: makeAcousticHit("Neo", 0.84),
      capabilityDigest: digest,
      learnedTriggers: ["帮我洗一下袜子"],
      systemOneClient: client,
    });

    expect(calls).toHaveLength(1);
    const req = calls[0]!;
    // State contains ONLY utterance and wake_words — ZERO context/background/capabilities/history/dual-track!
    expect(Object.keys(req.state).sort()).toEqual(["utterance", "wake_words"]);
    expect(req.state.utterance).toBe("Neo，明天北京天气怎么样，需要带伞吗");
    expect(req.state.wake_words).toEqual(["Neo", "小派"]);
    expect(req.state.history).toBeUndefined();
    expect(req.state.acoustic_event).toBeUndefined();
    expect(req.state.speaker).toBeUndefined();
    expect(req.state.acoustic_wake).toBeUndefined();
    expect(req.state.home_capabilities).toBeUndefined();
    expect(req.state.learned_triggers).toBeUndefined();
    expect(req.state.track_a).toBeUndefined();
    expect(req.state.track_b).toBeUndefined();

    // Questions contain ONLY binary `decision` + OR `device_command` — NO `intent`, NO `asr_best`!
    expect(Object.keys(req.questions).sort()).toEqual(["decision", "device_command"]);
    expect(Object.keys(req.questions.decision!.criteria ?? {}).sort()).toEqual([
      "false_wake",
      "valid_wake",
    ]);
    expect(Object.keys(req.questions.device_command!.criteria ?? {}).sort()).toEqual([
      "has_device_command",
      "no_device_command",
    ]);

    // Non-misheard utterance proceeds directly to next flow with FULL text intact (no BGM chopping!)
    expect(decision.accept).toBe(true);
    expect(decision.wokeOnly).toBe(false);
    expect(decision.stage).toBe("systemone-attention");
    expect(decision.passSource).toBe("systemone");
    expect(decision.wakeWord).toBe("Neo");
    expect(decision.command).toBe("明天北京天气怎么样，需要带伞吗");
    expect(decision.intent).toBeUndefined();
  });

  test("valid_wake enters next flow directly for arbitrary content, fuzzy wake words, and pure wake calls", async () => {
    const { client, calls } = makeMockSystemOneClient(() => ({
      choice: "valid_wake",
      confidence: 0.91,
    }));

    // 1. Everyday non-smart-home question after wake word -> directly passes to next flow
    const chatRes = await evaluateVoiceAttention({
      rawText: "Neo，晚饭吃什么比较好",
      wakeWordEnabled: true,
      wakeWords: ["Neo"],
      attentionMode: "smart",
      systemOneClient: client,
    });
    expect(chatRes.accept).toBe(true);
    expect(chatRes.wokeOnly).toBe(false);
    expect(chatRes.command).toBe("晚饭吃什么比较好");
    expect(chatRes.stage).toBe("systemone-attention");

    // 2. Fuzzy homophone wake word + arbitrary request -> verified by SystemOne -> directly passes
    const fuzzyRes = await evaluateVoiceAttention({
      rawText: "尼奥，给我讲个冷笑话",
      wakeWordEnabled: true,
      wakeWords: ["Neo"],
      attentionMode: "smart",
      systemOneClient: client,
    });
    expect(fuzzyRes.accept).toBe(true);
    expect(fuzzyRes.wokeOnly).toBe(false);
    expect(fuzzyRes.wakeWord).toBe("Neo");
    expect(fuzzyRes.command).toBe("给我讲个冷笑话");

    // 3. Fuzzy pure wake call ("尼奥") -> verified valid_wake -> enters wake_only next flow
    const pureFuzzyWake = await evaluateVoiceAttention({
      rawText: "尼奥",
      wakeWordEnabled: true,
      wakeWords: ["Neo"],
      attentionMode: "smart",
      systemOneClient: client,
    });
    expect(pureFuzzyWake.accept).toBe(true);
    expect(pureFuzzyWake.wokeOnly).toBe(true);
    expect(pureFuzzyWake.wakeWord).toBe("Neo");
    expect(pureFuzzyWake.command).toBe("");

    // 4. Strict mode routes even exact pure wake call through SystemOne pure check -> valid_wake enters wake_only
    const strictWake = await evaluateVoiceAttention({
      rawText: "Neo",
      wakeWordEnabled: true,
      wakeWords: ["Neo"],
      attentionMode: "strict",
      systemOneClient: client,
    });
    expect(strictWake.accept).toBe(true);
    expect(strictWake.wokeOnly).toBe(true);
    expect(strictWake.stage).toBe("systemone-attention");

    expect(calls).toHaveLength(4);
    // Exact wake calls send ONLY utterance + wake_words; fuzzy calls also include suspected_wake_alias (and NEVER context/background/intent)
    expect(Object.keys(calls[0]!.state).sort()).toEqual(["utterance", "wake_words"]);
    expect(Object.keys(calls[1]!.state).sort()).toEqual([
      "suspected_wake_alias",
      "utterance",
      "wake_words",
    ]);
    expect(calls[1]!.state.suspected_wake_alias).toEqual({
      heard: "尼奥",
      target_wake_word: "Neo",
      if_replaced: "Neo，给我讲个冷笑话",
    });
    expect(Object.keys(calls[2]!.state).sort()).toEqual([
      "suspected_wake_alias",
      "utterance",
      "wake_words",
    ]);
    expect(Object.keys(calls[3]!.state).sort()).toEqual(["utterance", "wake_words"]);
    for (const c of calls) {
      expect(Object.keys(c.questions).sort()).toEqual(["decision", "device_command"]);
      expect(c.state.history).toBeUndefined();
      expect(c.state.acoustic_event).toBeUndefined();
      expect(c.state.home_capabilities).toBeUndefined();
      expect(c.state.learned_triggers).toBeUndefined();
      expect(c.state.speaker).toBeUndefined();
    }
  });

  test("false_wake rejects misheard triggers cleanly across text wake spans and acoustic-only wakes", async () => {
    const { client, calls } = makeMockSystemOneClient((utterance) => {
      if (utterance.includes("那哦，讲个笑话")) {
        return { choice: "valid_wake", confidence: 0.9 };
      }
      return { choice: "false_wake", confidence: 0.93 };
    });

    // 1. Third-person mention -> false_wake -> rejected
    const mention = await evaluateVoiceAttention({
      rawText: "我刚才聊到Neo挺好用的",
      wakeWordEnabled: true,
      wakeWords: ["Neo"],
      attentionMode: "smart",
      systemOneClient: client,
    });
    expect(mention.accept).toBe(false);
    expect(mention.stage).toBe("systemone-attention");
    expect(mention.reason).toContain("误听");

    // 2. Acoustic false trigger with no text wake word ("今天晚饭吃什么") -> SystemOne checks -> false_wake -> rejected
    const acousticFalse = await evaluateVoiceAttention({
      rawText: "今天晚饭吃什么",
      wakeWordEnabled: true,
      wakeWords: ["Neo"],
      attentionMode: "smart",
      dialogState: "standby",
      acousticWake: makeAcousticHit("Neo", 0.68),
      systemOneClient: client,
    });
    expect(acousticFalse.accept).toBe(false);
    expect(acousticFalse.stage).toBe("systemone-attention");
    expect(acousticFalse.reason).toContain("误听");

    // 3. Acoustic wake with ASR-mangled wake prefix outside homophone table -> SystemOne confirms valid_wake -> enters next flow
    const acousticRecovered = await evaluateVoiceAttention({
      rawText: "那哦，讲个笑话",
      wakeWordEnabled: true,
      wakeWords: ["Neo"],
      attentionMode: "smart",
      dialogState: "standby",
      acousticWake: makeAcousticHit("Neo", 0.81),
      systemOneClient: client,
    });
    expect(acousticRecovered.accept).toBe(true);
    expect(acousticRecovered.stage).toBe("systemone-attention");
    expect(acousticRecovered.wakeWord).toBe("Neo");
    expect(acousticRecovered.command).toContain("讲个笑话");

    expect(calls).toHaveLength(3);
  });

  test("LocalVoiceEngine.transcribeDualTrack skips SystemOne selectDualTrackAsr when wake word is triggered", async () => {
    let systemOneCalls = 0;
    const mockClient = new SystemOneClient({
      baseUrl: "https://systemone.local.test/v1",
      apiKey: "sk-dual-track-skip",
      fetcher: (async () => {
        systemOneCalls += 1;
        return new Response(
          JSON.stringify({
            model: DEFAULT_SYSTEMONE_MODEL,
            answers: {
              asr_best: {
                type: "choice",
                choice: "neither_noise",
                probabilities: { track_a: 0.05, track_b: 0.05, neither_noise: 0.9 },
                confidence: 0.9,
              },
            },
            usage: { input_tokens: 40, output_tokens: 4 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }) as FetchLike,
    });

    const engine = new LocalVoiceEngine();
    let callIdx = 0;
    (engine as unknown as { transcribeLocal: (...args: unknown[]) => Promise<LocalAsrOutput> }).transcribeLocal =
      async () => {
        callIdx += 1;
        if (callIdx === 1) {
          return {
            text: "Neo，讲个笑话",
            rawText: "Neo，讲个笑话",
            lang: "zh",
            emotion: "",
            event: "<|BGM|>",
            engine: "sensevoice-local",
            durationMs: 20,
          };
        }
        return {
          text: "尼奥讲个笑话",
          rawText: "尼奥讲个笑话",
          lang: "zh",
          emotion: "",
          event: "<|BGM|>",
          engine: "sensevoice-local",
          durationMs: 20,
        };
      };

    try {
      const pcm = new Float32Array(16000).fill(0.05);
      const out = await engine.transcribeDualTrack(pcm, pcm, {
        voiceLang: "zh-CN",
        wakeWords: ["Neo"],
        inputSnrDb: 4,
        forceDual: true,
        acousticWake: makeAcousticHit("Neo", 0.78),
        systemOneClient: mockClient,
        localAsrEngine: "sensevoice",
      });
      // Must NOT invoke SystemOne selectDualTrackAsr during wake-triggered stage
      expect(systemOneCalls).toBe(0);
      expect(out.text).toContain("Neo");
    } finally {
      engine.dispose();
    }
  });

  test("AudioSourceSeparator does not override SystemOne-verified wake utterances with sidetalk or short-noun rejections", async () => {
    const { client, calls } = makeMockSystemOneClient(() => ({
      choice: "valid_wake",
      confidence: 0.93,
    }));

    const fakeEngine = {
      getStatus: () => ({ readyForSenseVoice: false, primaryAsrEngine: "qwen3-asr" }),
      scoreWakeWordAudio: () => null,
      transcribeLocal: async () => ({
        text: "Neo，晚饭吃什么",
        rawText: "Neo，晚饭吃什么",
        lang: "zh",
        emotion: "",
        event: "<|Speech|>",
        engine: "qwen3-asr-remote",
        durationMs: 10,
      }),
    } as unknown as LocalVoiceEngine;

    const sep = new AudioSourceSeparator(fakeEngine);
    const evalTurn = (sep as unknown as {
      _evaluateTurnCandidate: (params: Record<string, unknown>) => Promise<{ decision: { accept: boolean; command: string; stage: string } }>;
    })._evaluateTurnCandidate.bind(sep);

    const candidate = await evalTurn({
      branch: "clean_fast",
      startSec: 0,
      endSec: 1.5,
      segPcm: new Float32Array(24000).fill(0.08),
      zhRes: {
        text: "Neo，晚饭吃什么",
        rawText: "Neo，晚饭吃什么",
        lang: "zh",
        emotion: "",
        event: "<|Speech|>",
        engine: "qwen3-asr-remote",
        durationMs: 10,
      },
      altZhRes: null,
      globalTextContext: "",
      isTseOrMusicSeparated: false,
      scene: {
        tags: [],
        speechProb: 0.9,
        musicProb: 0,
        singingProb: 0,
        noiseProb: 0,
        crowdTvProb: 0,
        detectedSoundTypes: ["speech"],
        durationMs: 1,
      },
      opts: {
        wakeWordEnabled: true,
        wakeWords: ["Neo"],
        attentionMode: "smart",
        dialogState: "standby",
        inConversation: false,
        systemOneClient: client,
      },
    });

    expect(calls).toHaveLength(1);
    expect(candidate.decision.accept).toBe(true);
    expect(candidate.decision.stage).toBe("systemone-attention");
    expect(candidate.decision.command).toBe("晚饭吃什么");
  });

  test("End-to-end VoiceListenerController: valid_wake directly enters Pi Agent while false_wake stays in standby, and conversation mode keeps full context", async () => {
    const { client, calls } = makeMockSystemOneClient((utterance) => ({
      choice: utterance.includes("聊到Neo") ? "false_wake" : "valid_wake",
      confidence: 0.94,
    }));

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
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && mw.allDevices.length === 0) {
      await Bun.sleep(10);
    }

    const cfg = normalizeAgentVoiceConfig({
      ...defaultAgentVoiceConfig(),
      provider: "local",
      wakeWords: ["Neo", "小派"],
      autoSpeakReply: false,
      sourceSeparationMode: "off",
      owwEnabled: false,
      systemOneMode: "on",
      systemOneBaseUrl: "https://systemone.local.test/v1",
      systemOneApiKey: "sk-wake-e2e",
      conversationWindowSec: 25,
    });

    const agent = new PiAgentService({
      deps: { mainWindow: mw, service: demo, jobs, settingsStore, broadcastState: () => {} },
      initialConfig: cfg,
    });
    // Inject mock SystemOne client directly so we inspect exact requests
    (agent as unknown as { _systemOne: SystemOneClient })._systemOne = client;

    const vl = new VoiceListenerController(agent);
    try {
      // 1. Misheard wake -> SystemOne false_wake -> stays standby
      const misheard = await vl.handleTranscript("我刚聊到Neo真不错", { isFinal: true });
      expect(misheard.matched).toBe(false);
      expect(misheard.attention?.stage).toBe("systemone-attention");
      expect(vl.dialogState).toBe("standby");

      // 2. Real wake with fuzzy homophone + device command -> SystemOne valid_wake -> directly executes in Pi Agent & enters conversation
      const valid = await vl.handleTranscript("尼奥，关闭客厅吸顶灯", { isFinal: true });
      expect(valid.matched).toBe(true);
      expect(valid.attention?.stage).toBe("systemone-attention");
      expect(valid.command).toBe("关闭客厅吸顶灯");
      expect(await demo.powerState("demo-light-living")).toBe(false);
      expect(vl.dialogState).toBe("conversation");

      // 3. Subsequent conversation turn (no wake word) still sends full conversation history to evaluateConversationTurn
      const convTurn = await vl.handleTranscript("有点暗", { isFinal: true });
      expect(convTurn.matched).toBe(true);
      expect(convTurn.attention?.stage).toBe("systemone-attention");

      const wakeCalls = calls.filter((c) => Boolean(c.questions.decision));
      const convCalls = calls.filter((c) => Boolean(c.questions.conv_action));
      expect(wakeCalls.length).toBe(2);
      // 1st wake call ("我刚聊到Neo真不错"): exact wake -> strictly utterance + wake_words
      expect(Object.keys(wakeCalls[0]!.state).sort()).toEqual(["utterance", "wake_words"]);
      // 2nd wake call ("尼奥，关闭客厅吸顶灯"): fuzzy homophone -> adds suspected_wake_alias only
      expect(Object.keys(wakeCalls[1]!.state).sort()).toEqual([
        "suspected_wake_alias",
        "utterance",
        "wake_words",
      ]);
      for (const wc of wakeCalls) {
        expect(Object.keys(wc.questions).sort()).toEqual(["decision", "device_command"]);
        expect(wc.state.history).toBeUndefined();
        expect(wc.state.home_capabilities).toBeUndefined();
        expect(wc.state.acoustic_event).toBeUndefined();
      }
      expect(convCalls.length).toBe(1);
      expect(Array.isArray(convCalls[0]!.state.history)).toBe(true);
    } finally {
      vl.dispose();
      agent.dispose();
      networkMonitor.stop();
      mw.dispose();
      await jobs.shutdown();
    }
  });

  test("reproduces user bug: openWakeWord Neo 0.70 + ASR '六，我觉得客厅有点暗呢。' verifies with SystemOne (never no-wake/context) and enters next flow cleanly", async () => {
    // 1. Paused phonetic slip stripping: strips '六，' after acoustic wake while preserving '六点开空调'
    expect(extractCommandAfterAcousticWake("六，我觉得客厅有点暗呢。", "Neo")).toBe("我觉得客厅有点暗呢");
    expect(extractCommandAfterAcousticWake("六点开空调", "Neo")).toBe("六点开空调");
    expect(extractCommandAfterAcousticWake("六。", "Neo")).toBe("");

    // 2. With SystemOne enabled: sends utterance + wake_words + suspected_wake_alias + acoustic_wake (no context/background/intent) and strips '六，' -> enters next flow
    const { client, calls } = makeMockSystemOneClient(() => ({
      choice: "valid_wake",
      confidence: 0.91,
    }));
    const withS1 = await evaluateVoiceAttention({
      rawText: "六，我觉得客厅有点暗呢。",
      wakeWordEnabled: true,
      wakeWords: ["Neo"],
      attentionMode: "smart",
      dialogState: "standby",
      inConversation: false,
      acousticWake: makeAcousticHit("Neo", 0.7),
      systemOneClient: client,
    });
    expect(calls).toHaveLength(1);
    expect(Object.keys(calls[0]!.state).sort()).toEqual([
      "acoustic_wake",
      "suspected_wake_alias",
      "utterance",
      "wake_words",
    ]);
    expect(calls[0]!.state.suspected_wake_alias).toEqual({
      heard: "六",
      target_wake_word: "Neo",
      if_replaced: "Neo，我觉得客厅有点暗呢",
    });
    expect(calls[0]!.state.acoustic_wake).toEqual({ wake_word: "Neo", score: 0.7 });
    expect(Object.keys(calls[0]!.questions).sort()).toEqual(["decision", "device_command"]);
    expect(withS1.accept).toBe(true);
    expect(withS1.wokeOnly).toBe(false);
    expect(withS1.stage).toBe("systemone-attention");
    expect(withS1.wakeWord).toBe("Neo");
    expect(withS1.command).toBe("我觉得客厅有点暗呢");

    // 3. Even when SystemOne is unavailable/offline, matched openWakeWord Neo 0.70 MUST NOT fall back to "未检测到唤醒词或有效对话上下文"
    const offlineRecovery = await evaluateVoiceAttention({
      rawText: "六，我觉得客厅有点暗呢。",
      wakeWordEnabled: true,
      wakeWords: ["Neo"],
      attentionMode: "smart",
      dialogState: "standby",
      inConversation: false,
      acousticWake: makeAcousticHit("Neo", 0.7),
      systemOneClient: null,
    });
    expect(offlineRecovery.accept).toBe(true);
    expect(offlineRecovery.stage).toBe("fast-wake");
    expect(offlineRecovery.passSource).toBe("acoustic_wake_recovery");
    expect(offlineRecovery.wakeWord).toBe("Neo");
    expect(offlineRecovery.command).toBe("我觉得客厅有点暗呢");

    // 4. ClearVoice multi-track segment where ClearVoice +35.5dB denoising drops per-track OWW score below 0.60:
    //    streamAcousticWake Neo 0.70 is preserved on the winning track and routes through SystemOne -> Pi Agent!
    const { client: cvS1, calls: cvCalls } = makeMockSystemOneClient(() => ({
      choice: "valid_wake",
      confidence: 0.92,
    }));

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
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && mw.allDevices.length === 0) {
      await Bun.sleep(10);
    }

    let asrTrackCall = 0;
    const fakeLocalEngine = {
      setPreferredAsrEngine: () => {},
      setClearVoiceServiceUrl: () => {},
      getStatus: () => ({
        readyForLocalAsr: true,
        readyForClearVoiceGpu: true,
        readyForSourceSeparation: false,
        readyForDenoise: true,
        readyForVad: true,
        readyForVoiceprint: false,
        readyForWakeWord: true,
        readyForLocalTts: false,
      }),
      openWakeWord: {
        isReady: true,
        getStatus: () => ({ ready: true, prototypeCount: 2, enrolledCount: 2, ttsCount: 0 }),
      },
      detectSpeechSegments: (samples: Float32Array) => ({
        hasSpeech: true,
        speechSamples: samples,
        speechRatio: 0.9,
        engine: "silero",
        durationMs: 3,
      }),
      scoreWakeWordAudio: (_samples: Float32Array) => {
        // Simulate ClearVoice SE +35.5dB altering timbre so per-track re-score drops below 0.60
        const idx = asrTrackCall;
        return {
          wakeWord: "Neo",
          score: idx === 0 ? 0.48 : 0.08,
          rawScore: idx === 0 ? 0.48 : 0.08,
          threshold: 0.6,
          matched: false,
          source: "enrolled" as const,
          frameIndex: 1,
          sampleOffset: 4000,
          latencyMs: 3,
        };
      },
      transcribeLocal: async (): Promise<LocalAsrOutput> => {
        asrTrackCall += 1;
        return {
          text: asrTrackCall === 1 ? "六，我觉得客厅有点暗呢。" : "今天晚上看什么电影",
          rawText: asrTrackCall === 1 ? "六，我觉得客厅有点暗呢。" : "今天晚上看什么电影",
          lang: "zh",
          emotion: "",
          event: "<|Speech|>",
          engine: "qwen3-asr-remote",
          durationMs: 25,
        };
      },
      dispose: () => {},
    } as unknown as LocalVoiceEngine;

    const cfg = normalizeAgentVoiceConfig({
      ...defaultAgentVoiceConfig(),
      provider: "local",
      voicePipelineMode: "clearvoice",
      wakeWords: ["Neo"],
      owwEnabled: true,
      owwThreshold: 0.6,
      autoSpeakReply: false,
      sourceSeparationMode: "off",
      systemOneMode: "on",
      systemOneBaseUrl: "https://systemone.local.test/v1",
      systemOneApiKey: "sk-cv-wake",
      conversationWindowSec: 25,
    });
    const agent = new PiAgentService({
      deps: { mainWindow: mw, service: demo, jobs, settingsStore, broadcastState: () => {} },
      initialConfig: cfg,
    });
    (agent as unknown as { _systemOne: SystemOneClient })._systemOne = cvS1;
    const vl = new VoiceListenerController(agent, { localEngine: fakeLocalEngine });

    try {
      const segRes = await vl.processDualTrackSegment({
        rawSamples: new Float32Array(32000).fill(0.08),
        denoisedSamples: new Float32Array(32000).fill(0.08),
        separatedTracks: [
          {
            trackId: "cv_track_1",
            trackIndex: 1,
            sourceSlot: 0,
            samples: new Float32Array(32000).fill(0.08),
            sampleRate: 16000,
            rms: 0.08,
            energyRatio: 0.7,
            outputSnrDb: 35.5,
            snrGainDb: 35.5,
          },
          {
            trackId: "cv_track_2",
            trackIndex: 2,
            sourceSlot: 1,
            samples: new Float32Array(32000).fill(0.04),
            sampleRate: 16000,
            rms: 0.04,
            energyRatio: 0.3,
            outputSnrDb: 18,
            snrGainDb: 18,
          },
        ],
        denoiseEngine: "clearvoice-mossformer2-bss-se-remote",
        pipelineMode: "clearvoice",
        inputSnrDb: 0,
        outputSnrDb: 35.5,
        snrGainDb: 35.5,
        startSec: 0,
        durationSec: 2,
        forcedRoll: false,
        wakeAnchored: true,
        acousticWake: makeAcousticHit("Neo", 0.7),
      });

      expect(cvCalls.filter((c) => Boolean(c.questions.decision))).toHaveLength(1);
      expect(segRes.matched).toBe(true);
      expect(segRes.command).toBe("我觉得客厅有点暗呢");
      expect(segRes.tracks).toHaveLength(2);
      // Track 1 accepted via SystemOne pure wake check; Track 2 remains strictly isolated & rejected
      expect(segRes.tracks![0]!.matched).toBe(true);
      expect(segRes.tracks![0]!.attention?.stage).toBe("systemone-attention");
      expect(segRes.tracks![1]!.matched).toBe(false);
    } finally {
      vl.dispose();
      agent.dispose();
      networkMonitor.stop();
      mw.dispose();
      await jobs.shutdown();
    }
  });

  test("reproduces user bug: openWakeWord Neo 0.80 + '你有播放点音乐吧。' passes via acoustic+homophone double confirmation and semantic substitution, while rejecting natural questions like '你有打开窗户吗？'", async () => {
    // 1. Exact user scenario in smart mode: openWakeWord Neo 0.80 + '你有播放点音乐吧。' -> 0ms fast-wake double confirmation (zero SystemOne false-reject risk!)
    const { client: s1Mock, calls } = makeMockSystemOneClient((utterance, body) => {
      // Simulate SystemOne using semantic substitution: natural Chinese questions stay false_wake, ungrammatical homophone commands become valid_wake
      if (utterance.includes("打开窗户吗") || utterance.includes("今天晚饭吃什么")) {
        return { choice: "false_wake", confidence: 0.94 };
      }
      const alias = body.state.suspected_wake_alias as { if_replaced?: string } | undefined;
      if (alias?.if_replaced?.startsWith("Neo，")) {
        return { choice: "valid_wake", confidence: 0.95 };
      }
      return { choice: "false_wake", confidence: 0.9 };
    });

    const strongDoubleConfirm = await evaluateVoiceAttention({
      rawText: "你有播放点音乐吧。",
      wakeWordEnabled: true,
      wakeWords: ["Neo"],
      attentionMode: "smart",
      dialogState: "standby",
      inConversation: false,
      acousticWake: makeAcousticHit("Neo", 0.8),
      systemOneClient: s1Mock,
    });
    expect(strongDoubleConfirm.accept).toBe(true);
    expect(strongDoubleConfirm.wokeOnly).toBe(false);
    expect(strongDoubleConfirm.stage).toBe("fast-wake");
    expect(strongDoubleConfirm.passSource).toBe("acoustic_wake_recovery");
    expect(strongDoubleConfirm.wakeWord).toBe("Neo");
    expect(strongDoubleConfirm.command).toBe("播放点音乐吧");
    expect(calls).toHaveLength(0);

    // 2. Strict mode or moderate OWW score (0.66): routes to SystemOne with suspected_wake_alias (heard: '你有' -> if_replaced: 'Neo，播放点音乐吧') + acoustic_wake
    const moderateScoreRes = await evaluateVoiceAttention({
      rawText: "你有播放点音乐吧。",
      wakeWordEnabled: true,
      wakeWords: ["Neo"],
      attentionMode: "smart",
      dialogState: "standby",
      inConversation: false,
      acousticWake: makeAcousticHit("Neo", 0.66),
      systemOneClient: s1Mock,
    });
    expect(moderateScoreRes.accept).toBe(true);
    expect(moderateScoreRes.stage).toBe("systemone-attention");
    expect(moderateScoreRes.wakeWord).toBe("Neo");
    expect(moderateScoreRes.command).toBe("播放点音乐吧");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.state).toEqual({
      utterance: "你有播放点音乐吧。",
      wake_words: ["Neo"],
      suspected_wake_alias: {
        heard: "你有",
        target_wake_word: "Neo",
        if_replaced: "Neo，播放点音乐吧",
      },
      acoustic_wake: {
        wake_word: "Neo",
        score: 0.66,
      },
    });
    expect(String(calls[0]!.questions.decision!.instructions)).toContain("你有播放点音乐吧");
    expect(String(calls[0]!.questions.decision!.instructions)).toContain("if_replaced");

    // 3. Non-direct utterance after homophone ('你有明天北京天气怎么样' + openWakeWord Neo 0.80):
    //    goes to SystemOne with semantic substitution hint -> valid_wake -> strips '你有' -> passes '明天北京天气怎么样'
    const nonDirectHomophone = await evaluateVoiceAttention({
      rawText: "你有明天北京天气怎么样",
      wakeWordEnabled: true,
      wakeWords: ["Neo"],
      attentionMode: "smart",
      dialogState: "standby",
      inConversation: false,
      acousticWake: makeAcousticHit("Neo", 0.8),
      systemOneClient: s1Mock,
    });
    expect(nonDirectHomophone.accept).toBe(true);
    expect(nonDirectHomophone.stage).toBe("systemone-attention");
    expect(nonDirectHomophone.wakeWord).toBe("Neo");
    expect(nonDirectHomophone.command).toBe("明天北京天气怎么样");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.state.suspected_wake_alias).toEqual({
      heard: "你有",
      target_wake_word: "Neo",
      if_replaced: "Neo，明天北京天气怎么样",
    });

    // 4. False-positive guard: natural Chinese question '你有打开窗户吗？' even with OWW 0.80 MUST NOT fast-path and MUST be rejected by SystemOne (and offline fallback)
    const naturalQuestionWithS1 = await evaluateVoiceAttention({
      rawText: "你有打开窗户吗？",
      wakeWordEnabled: true,
      wakeWords: ["Neo"],
      attentionMode: "smart",
      dialogState: "standby",
      inConversation: false,
      acousticWake: makeAcousticHit("Neo", 0.8),
      systemOneClient: s1Mock,
    });
    expect(naturalQuestionWithS1.accept).toBe(false);
    expect(naturalQuestionWithS1.stage).toBe("systemone-attention");
    expect(calls).toHaveLength(3);

    const naturalQuestionOffline = await evaluateVoiceAttention({
      rawText: "你有打开窗户吗？",
      wakeWordEnabled: true,
      wakeWords: ["Neo"],
      attentionMode: "smart",
      dialogState: "standby",
      inConversation: false,
      acousticWake: makeAcousticHit("Neo", 0.8),
      systemOneClient: null,
    });
    expect(naturalQuestionOffline.accept).toBe(false);
    expect(naturalQuestionOffline.stage).toBe("pragmatic-reject");

    // 5. buildSuspectedWakeAliasHint returns null for ordinary non-alias sentences (e.g. '今天晚饭吃什么', '六个苹果多少钱')
    expect(buildSuspectedWakeAliasHint("今天晚饭吃什么", null, makeAcousticHit("Neo", 0.68))).toBeNull();
    expect(buildSuspectedWakeAliasHint("六个苹果多少钱", null, makeAcousticHit("Neo", 0.68))).toBeNull();
  });
});
