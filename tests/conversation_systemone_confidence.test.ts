// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 连续对话中跟进/叮嘱/反馈表达避免被 SystemOne 低置信度误拦的回归测试

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PiAgentService } from "../src/agent/piAgentService.ts";
import {
  SystemOneClient,
  type CommandIntentChoice,
  type ConversationActionChoice,
} from "../src/agent/systemOneClient.ts";
import {
  evaluateVoiceAttention,
  isBareWeakClosingPhrase,
  isContextualConversationFollowup,
} from "../src/agent/voiceAttentionGate.ts";
import { VoiceListenerController } from "../src/agent/voiceListenerController.ts";
import type { VoiceprintIdentifyResult } from "../src/agent/voiceprintStore.ts";
import {
  DEFAULT_SYSTEMONE_MODEL,
  defaultAgentVoiceConfig,
  normalizeAgentVoiceConfig,
} from "../src/core/agentConfigStore.ts";
import { NetworkMonitor } from "../src/core/availability.ts";
import type { FetchLike } from "../src/core/httpTimeout.ts";
import { JobExecutor } from "../src/core/jobs.ts";
import { setDataPathOverrides } from "../src/core/jsonStore.ts";
import * as settingsStore from "../src/core/settingsStore.ts";
import { VirtualDemoService } from "../src/core/virtualLightService.ts";
import { MainWindowController } from "../src/ui/controllers/mainWindowController.ts";
import { applyTheme, ThemeController } from "../src/ui/theme.ts";

interface MockConvVerdict {
  choice: ConversationActionChoice;
  confidence: number;
  probabilities: Record<ConversationActionChoice, number>;
  intent?: CommandIntentChoice;
}

function createMockSystemOne(
  resolver: (
    utterance: string,
    state: Record<string, unknown>,
    questions: Record<string, Record<string, unknown>>,
  ) => MockConvVerdict,
  threshold = 0.65,
) {
  const requests: Array<{
    state: Record<string, unknown>;
    questions: Record<string, Record<string, unknown>>;
  }> = [];

  const fetcher: FetchLike = async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      state: Record<string, unknown>;
      questions: Record<string, Record<string, unknown>>;
    };
    requests.push(body);
    const utterance = String(body.state.utterance ?? "");
    const verdict = resolver(utterance, body.state, body.questions);
    const answers: Record<string, unknown> = {};
    if ("conv_action" in body.questions) {
      answers.conv_action = {
        type: "choice",
        choice: verdict.choice,
        confidence: verdict.confidence,
        probabilities: verdict.probabilities,
      };
    }
    if ("intent" in body.questions) {
      const intentChoice = verdict.intent ?? "general_chat";
      answers.intent = {
        type: "choice",
        choice: intentChoice,
        confidence: 0.85,
        probabilities: {
          device_control: intentChoice === "device_control" ? 0.85 : 0.05,
          status_query: intentChoice === "status_query" ? 0.85 : 0.05,
          scene: intentChoice === "scene" ? 0.85 : 0.05,
          general_chat: intentChoice === "general_chat" ? 0.85 : 0.05,
        },
      };
    }
    if ("task_ack" in body.questions) {
      answers.task_ack = {
        type: "choice",
        choice: "execute_control",
        confidence: 0.8,
        probabilities: {
          execute_control: 0.8,
          query_status: 0.05,
          think_creative: 0.03,
          scene_routine: 0.02,
          troubleshoot: 0.02,
          urgent_cancel: 0.02,
          remember_rule: 0.02,
          safety_confirm: 0.02,
          greeting_chat: 0.02,
        },
      };
    }
    return new Response(
      JSON.stringify({
        model: DEFAULT_SYSTEMONE_MODEL,
        answers,
        usage: { input_tokens: 120, output_tokens: 12 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  const client = new SystemOneClient({
    baseUrl: "https://karpo.test.local/v1",
    apiKey: "sk-test-conv-conf-1234",
    confidenceThreshold: threshold,
    fetcher,
  });

  return { client, requests };
}

const HENRY_VOICEPRINT: VoiceprintIdentifyResult = {
  evaluated: true,
  matched: true,
  speakerId: "vp_henry",
  speakerName: "Henry",
  role: "owner",
  score: 0.35,
  threshold: 0.3,
  enrolledCount: 1,
  engine: "3d-speaker",
  candidates: [{ id: "vp_henry", name: "Henry", role: "owner", score: 0.35 }],
};

const OTHER_SPEAKER_VOICEPRINT: VoiceprintIdentifyResult = {
  evaluated: true,
  matched: false,
  speakerId: null,
  speakerName: null,
  role: null,
  score: 0.14,
  threshold: 0.3,
  enrolledCount: 1,
  engine: "3d-speaker",
  candidates: [{ id: "vp_henry", name: "Henry", role: "owner", score: 0.14 }],
};

const USER_BUG_RECENT_TURNS = [
  { role: "user" as const, text: "你没有打开客厅灯啊", timestamp: 1_700_000_000_000 },
  { role: "assistant" as const, text: "已开", timestamp: 1_700_000_001_000 },
  { role: "user" as const, text: "刚刚为什么没有打开客厅灯呢", timestamp: 1_700_000_012_000 },
  { role: "assistant" as const, text: "前两次可能没听清，这次已开", timestamp: 1_700_000_013_000 },
];

describe("SystemOneClient 3-class conversation calibration & prompt guidance", () => {
  test("includes admonishment/feedback follow-up guidance and same_speaker state in CONVERSATION_ACTION_QUESTION", async () => {
    const { client, requests } = createMockSystemOne(() => ({
      choice: "followup",
      confidence: 0.88,
      probabilities: { followup: 0.92, side_talk: 0.04, goodbye: 0.04 },
    }));

    const res = await client.evaluateConversationTurn({
      utterance: "那以后不要出现这种情况了。",
      recentHistory: USER_BUG_RECENT_TURNS.map(({ role, text }) => ({ role, text })),
      speakerName: "Henry",
      sameSpeaker: true,
    });

    expect(res?.accepted).toBe(true);
    expect(requests).toHaveLength(1);
    const { state, questions } = requests[0]!;
    expect(state.same_speaker).toBe(true);
    expect(state.speaker).toBe("Henry");
    const convQ = questions.conv_action!;
    const criteria = convQ.criteria as Record<string, string>;
    expect(String(convQ.instructions)).toContain("same_speaker");
    expect(String(convQ.instructions)).toContain("叮嘱");
    expect(criteria.followup).toContain("那以后不要出现这种情况了");
    expect(criteria.goodbye).toContain("绝不是 goodbye");
  });

  test("calibrates 3-class entropy-compressed followup and followup-vs-goodbye split in non-strict mode while keeping strict mode strict", async () => {
    // 1. Entropy-compressed clear followup: P(followup)=0.72 >= 0.65, P(side_talk)=0.14, low spread confidence=0.38
    const { client: entropyClient } = createMockSystemOne(() => ({
      choice: "followup",
      confidence: 0.38,
      probabilities: { followup: 0.72, side_talk: 0.14, goodbye: 0.14 },
    }));
    const rEntropySmart = await entropyClient.evaluateConversationTurn(
      { utterance: "那以后不要出现这种情况了。", recentHistory: USER_BUG_RECENT_TURNS },
      { strict: false },
    );
    const rEntropyStrict = await entropyClient.evaluateConversationTurn(
      { utterance: "那以后不要出现这种情况了。", recentHistory: USER_BUG_RECENT_TURNS },
      { strict: true },
    );
    expect(rEntropySmart?.accepted).toBe(true);
    expect(rEntropyStrict?.accepted).toBe(false);

    // 2. Followup-vs-goodbye split: P(followup)=0.54, P(goodbye)=0.36 -> P(directed)=0.90, P(side_talk)=0.10, confidence=0.26
    const { client: splitClient } = createMockSystemOne(() => ({
      choice: "followup",
      confidence: 0.26,
      probabilities: { followup: 0.54, goodbye: 0.36, side_talk: 0.1 },
    }));
    const rSplitSmart = await splitClient.evaluateConversationTurn(
      { utterance: "那以后不要出现这种情况了。", recentHistory: USER_BUG_RECENT_TURNS },
      { strict: false },
    );
    const rSplitStrict = await splitClient.evaluateConversationTurn(
      { utterance: "那以后不要出现这种情况了。", recentHistory: USER_BUG_RECENT_TURNS },
      { strict: true },
    );
    expect(rSplitSmart?.accepted).toBe(true);
    expect(rSplitStrict?.accepted).toBe(false);

    // 3. Truly uncertain near-tie with high side_talk stays rejected at client layer
    const { client: tieClient } = createMockSystemOne(() => ({
      choice: "followup",
      confidence: 0.15,
      probabilities: { followup: 0.44, side_talk: 0.4, goodbye: 0.16 },
    }));
    const rTie = await tieClient.evaluateConversationTurn(
      { utterance: "好像是这样吧", recentHistory: USER_BUG_RECENT_TURNS },
      { strict: false },
    );
    expect(rTie?.accepted).toBe(false);
  });
});

describe("VoiceAttentionGate contextual follow-up helpers & gray-zone recovery", () => {
  test("recognizes natural contextual follow-up / admonishment expressions and excludes bare weak closings, lyrics, and side-talk", () => {
    for (const positive of [
      "那以后不要出现这种情况了。",
      "以后不要再这样了",
      "下次注意一点",
      "别再听错了",
      "那你记住了啊",
      "好吧，下次记得听清楚点",
      "知道了，那以后反应快一点",
      "刚刚为什么没有打开客厅灯呢",
      "为什么会没听清呢",
      "你刚才听到什么了",
      "可是刚才它明明没开",
      "原来是这样",
      "这就对了",
      "听清了吗",
      "Don't let this happen again.",
    ]) {
      expect(isContextualConversationFollowup(positive)).toBe(true);
    }

    for (const bare of ["嗯好吧", "嗯，好吧。", "行吧", "那好吧", "算了，没事了", "知道了", "ok"]) {
      expect(isBareWeakClosingPhrase(bare)).toBe(true);
      expect(isContextualConversationFollowup(bare)).toBe(false);
    }

    for (const negative of [
      "晚饭吃什么",
      "帮我拿双筷子",
      "你今晚晚饭吃什么呀，帮我顺便点个外卖",
      "告诉我为什么",
      "现在我好想你",
      "非常累的时候就会站在阳台凑出。",
      "现在不需要测需要去切换的你这吧。",
      "好了，谢谢，不用了。",
      "我刚才跟朋友聊到小派这个项目挺好用的",
    ]) {
      expect(isContextualConversationFollowup(negative)).toBe(false);
    }
  });

  test("reproduces user bug: '那以后不要出现这种情况了。' in continuous conversation is accepted across low-confidence followup and non-exiting goodbye split", async () => {
    const scenarios: Array<{ label: string; verdict: MockConvVerdict }> = [
      {
        label: "low-confidence followup vs moderate side_talk",
        verdict: {
          choice: "followup",
          confidence: 0.55,
          probabilities: { followup: 0.55, side_talk: 0.3, goodbye: 0.15 },
        },
      },
      {
        label: "low-confidence non-exiting goodbye split with strong followup",
        verdict: {
          choice: "goodbye",
          confidence: 0.48,
          probabilities: { goodbye: 0.5, followup: 0.41, side_talk: 0.09 },
        },
      },
      {
        label: "entropy-compressed followup",
        verdict: {
          choice: "followup",
          confidence: 0.42,
          probabilities: { followup: 0.68, side_talk: 0.14, goodbye: 0.18 },
        },
      },
    ];

    for (const sc of scenarios) {
      const { client } = createMockSystemOne(() => sc.verdict);
      const dec = await evaluateVoiceAttention({
        rawText: "那以后不要出现这种情况了。",
        wakeWordEnabled: true,
        wakeWords: ["Neo", "小派"],
        attentionMode: "smart",
        dialogState: "conversation",
        inConversation: true,
        recentTurns: USER_BUG_RECENT_TURNS,
        voiceprint: HENRY_VOICEPRINT,
        conversationSpeakerName: "Henry",
        systemOneClient: client,
      });

      expect(dec.accept).toBe(true);
      expect(dec.addressed).toBe(true);
      expect(dec.exitConversation).not.toBe(true);
      expect(dec.command).toBe("那以后不要出现这种情况了");
      expect(dec.reason).not.toContain("置信度不足");
    }
  });

  test("recovers novel non-cue follow-up when same conversation speaker matches and followup leads side_talk clearly", async () => {
    const { client } = createMockSystemOne(() => ({
      choice: "followup",
      confidence: 0.52,
      probabilities: { followup: 0.58, side_talk: 0.28, goodbye: 0.14 },
    }));

    const dec = await evaluateVoiceAttention({
      rawText: "可能是麦克风离得有点远",
      wakeWordEnabled: true,
      wakeWords: ["Neo"],
      attentionMode: "smart",
      dialogState: "conversation",
      inConversation: true,
      recentTurns: USER_BUG_RECENT_TURNS,
      voiceprint: HENRY_VOICEPRINT,
      conversationSpeakerName: "Henry",
      systemOneClient: client,
    });

    expect(dec.accept).toBe(true);
    expect(dec.passSource).toBe("conversation_followup_recovery");
    expect(dec.command).toBe("可能是麦克风离得有点远");
  });

  test("preserves strict safety guardrails: side_talk, confident goodbye, bare weak closing, BGM, unmatched speaker, near-tie, and strict mode", async () => {
    // 1. Confident or non-confident side_talk MUST still be rejected
    const { client: sideTalkS1 } = createMockSystemOne(() => ({
      choice: "side_talk",
      confidence: 0.82,
      probabilities: { followup: 0.12, side_talk: 0.82, goodbye: 0.06 },
    }));
    const rSideTalk = await evaluateVoiceAttention({
      rawText: "那以后不要出现这种情况了。",
      wakeWordEnabled: true,
      wakeWords: ["Neo"],
      attentionMode: "smart",
      dialogState: "conversation",
      inConversation: true,
      recentTurns: USER_BUG_RECENT_TURNS,
      voiceprint: HENRY_VOICEPRINT,
      conversationSpeakerName: "Henry",
      systemOneClient: sideTalkS1,
    });
    expect(rSideTalk.accept).toBe(false);
    expect(rSideTalk.reason).toContain("旁白/闲聊");

    // 2. Confident goodbye (>= 0.65) MUST still exit conversation
    const { client: byeS1 } = createMockSystemOne(() => ({
      choice: "goodbye",
      confidence: 0.86,
      probabilities: { followup: 0.08, side_talk: 0.06, goodbye: 0.86 },
    }));
    const rBye = await evaluateVoiceAttention({
      rawText: "好了没事了，谢谢你",
      wakeWordEnabled: true,
      wakeWords: ["Neo"],
      attentionMode: "smart",
      dialogState: "conversation",
      inConversation: true,
      recentTurns: USER_BUG_RECENT_TURNS,
      systemOneClient: byeS1,
    });
    expect(rBye.accept).toBe(false);
    expect(rBye.exitConversation).toBe(true);

    // 3. Bare weak closing ("嗯好吧") with low-confidence goodbye MUST NOT trigger agent
    const { client: weakByeS1 } = createMockSystemOne(() => ({
      choice: "goodbye",
      confidence: 0.56,
      probabilities: { goodbye: 0.56, followup: 0.34, side_talk: 0.1 },
    }));
    const rWeakBye = await evaluateVoiceAttention({
      rawText: "嗯好吧",
      wakeWordEnabled: true,
      wakeWords: ["Neo"],
      attentionMode: "smart",
      dialogState: "conversation",
      inConversation: true,
      recentTurns: USER_BUG_RECENT_TURNS,
      voiceprint: HENRY_VOICEPRINT,
      conversationSpeakerName: "Henry",
      systemOneClient: weakByeS1,
    });
    expect(rWeakBye.accept).toBe(false);
    expect(rWeakBye.exitConversation).not.toBe(true);

    // 4. BGM context MUST block gray-zone recovery
    const { client: lowFollowupS1 } = createMockSystemOne(() => ({
      choice: "followup",
      confidence: 0.54,
      probabilities: { followup: 0.54, side_talk: 0.32, goodbye: 0.14 },
    }));
    const rBgm = await evaluateVoiceAttention({
      rawText: "那以后不要出现这种情况了。",
      wakeWordEnabled: true,
      wakeWords: ["Neo"],
      attentionMode: "smart",
      dialogState: "conversation",
      inConversation: true,
      acousticEvent: "<|BGM|>",
      recentTurns: USER_BUG_RECENT_TURNS,
      voiceprint: HENRY_VOICEPRINT,
      conversationSpeakerName: "Henry",
      systemOneClient: lowFollowupS1,
    });
    expect(rBgm.accept).toBe(false);

    // 5. Unmatched enrolled voiceprint (TV / other speaker) MUST block gray-zone recovery
    const rOtherSpeaker = await evaluateVoiceAttention({
      rawText: "那以后不要出现这种情况了。",
      wakeWordEnabled: true,
      wakeWords: ["Neo"],
      attentionMode: "smart",
      dialogState: "conversation",
      inConversation: true,
      recentTurns: USER_BUG_RECENT_TURNS,
      voiceprint: OTHER_SPEAKER_VOICEPRINT,
      conversationSpeakerName: "Henry",
      systemOneClient: lowFollowupS1,
    });
    expect(rOtherSpeaker.accept).toBe(false);

    // 6. Near-tie uncertain output MUST remain conservatively ignored
    const { client: nearTieS1 } = createMockSystemOne(() => ({
      choice: "followup",
      confidence: 0.39,
      probabilities: { followup: 0.39, side_talk: 0.37, goodbye: 0.24 },
    }));
    const rNearTie = await evaluateVoiceAttention({
      rawText: "那以后不要出现这种情况了。",
      wakeWordEnabled: true,
      wakeWords: ["Neo"],
      attentionMode: "smart",
      dialogState: "conversation",
      inConversation: true,
      recentTurns: USER_BUG_RECENT_TURNS,
      voiceprint: HENRY_VOICEPRINT,
      conversationSpeakerName: "Henry",
      systemOneClient: nearTieS1,
    });
    expect(rNearTie.accept).toBe(false);

    // 7. Strict attention mode MUST NOT relax threshold or run gray-zone recovery
    const { client: strictS1 } = createMockSystemOne(() => ({
      choice: "followup",
      confidence: 0.68,
      probabilities: { followup: 0.72, side_talk: 0.14, goodbye: 0.14 },
    }));
    const rStrict = await evaluateVoiceAttention({
      rawText: "那以后不要出现这种情况了。",
      wakeWordEnabled: true,
      wakeWords: ["Neo"],
      attentionMode: "strict",
      dialogState: "conversation",
      inConversation: true,
      recentTurns: USER_BUG_RECENT_TURNS,
      voiceprint: HENRY_VOICEPRINT,
      conversationSpeakerName: "Henry",
      systemOneClient: strictS1,
    });
    expect(rStrict.accept).toBe(false);
  });
});

describe("End-to-End VoiceListenerController continuous conversation flow with speaker continuity", () => {
  let tmpDir = "";

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "mijiadeck-conv-s1-conf-"));
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

  test("tracks active conversation speaker across turns, forwards same_speaker to SystemOne, accepts follow-up admonishment, and clears speaker on exit", async () => {
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

    const { client: s1Client, requests: s1Requests } = createMockSystemOne((utterance) => {
      if (utterance.includes("以后不要出现")) {
        return {
          choice: "followup",
          confidence: 0.56,
          probabilities: { followup: 0.56, side_talk: 0.28, goodbye: 0.16 },
          intent: "general_chat",
        };
      }
      return {
        choice: "followup",
        confidence: 0.9,
        probabilities: { followup: 0.92, side_talk: 0.04, goodbye: 0.04 },
        intent: "general_chat",
      };
    });

    const cfg = normalizeAgentVoiceConfig({
      ...defaultAgentVoiceConfig(),
      wakeWords: ["Neo", "小派"],
      attentionMode: "smart",
      voiceprintMode: "tag",
      voiceprintThreshold: 0.3,
      autoSpeakReply: false,
      conversationWindowSec: 8,
      owwEnabled: false,
      systemOneMode: "on",
      systemOneBaseUrl: "https://karpo.test.local/v1",
      systemOneApiKey: "sk-test-e2e-1234",
    });

    const agent = new PiAgentService({
      deps: { mainWindow: mw, service: demo, jobs, settingsStore, broadcastState: () => {} },
      initialConfig: cfg,
    });
    (agent as unknown as { _systemOne: SystemOneClient })._systemOne = s1Client;

    const vl = new VoiceListenerController(agent);

    try {
      // Turn 1: Wake + explicit command by Henry establishes active conversation speaker "Henry"
      const t1 = await vl.handleTranscript("Neo，打开客厅吸顶灯", {
        isFinal: true,
        voiceprint: HENRY_VOICEPRINT,
      });
      expect(t1.matched).toBe(true);
      expect(vl.dialogState).toBe("conversation");

      // Turn 2: Follow-up question by Henry
      const t2 = await vl.handleTranscript("刚刚为什么没有打开客厅灯呢", {
        isFinal: true,
        voiceprint: HENRY_VOICEPRINT,
      });
      expect(t2.matched).toBe(true);

      // Turn 3: Admonishment follow-up by Henry with low SystemOne confidence (0.56) -> accepted!
      const t3 = await vl.handleTranscript("那以后不要出现这种情况了。", {
        isFinal: true,
        voiceprint: HENRY_VOICEPRINT,
      });
      expect(t3.matched).toBe(true);
      expect(t3.command).toBe("那以后不要出现这种情况了");
      expect(t3.attention?.accept).toBe(true);

      const convReqs = s1Requests.filter((r) => "conv_action" in r.questions);
      const t3Req = convReqs.find((r) => String(r.state.utterance).includes("以后不要出现"));
      expect(t3Req).toBeDefined();
      expect(t3Req!.state.same_speaker).toBe(true);
      expect(t3Req!.state.speaker).toBe("Henry");
      expect(Array.isArray(t3Req!.state.history)).toBe(true);
      expect((t3Req!.state.history as string[]).length).toBeGreaterThanOrEqual(2);

      // Exit conversation clears tracked speaker so a brand new conversation doesn't inherit stale speaker
      vl.exitConversation("explicit_exit", { speakAck: false });
      expect(vl.dialogState).toBe("standby");
      vl.enterConversation("manual_toggle", { speakAck: false });

      const t4 = await vl.handleTranscript("那以后不要出现这种情况了。", {
        isFinal: true,
        voiceprint: HENRY_VOICEPRINT,
      });
      const afterResetReqs = s1Requests.filter(
        (r) => "conv_action" in r.questions && String(r.state.utterance).includes("以后不要出现"),
      );
      expect(afterResetReqs.length).toBe(2);
      expect(afterResetReqs[1]!.state.same_speaker).toBeUndefined();
      // Still accepted via contextual follow-up cues + history
      expect(t4.matched).toBe(true);

      // Verify recentConversationTurns preserves non-empty in-flight streaming assistant text
      // (while skipping empty streaming placeholders) so rapid follow-ups never lose prior context.
      const timeline = (agent as unknown as { _timeline: Array<Record<string, unknown>> })._timeline;
      timeline.push(
        {
          id: "msg_stream_nonempty",
          role: "assistant",
          source: "voice",
          text: "前两次可能没听清，这次已开",
          timestamp: Date.now(),
          status: "streaming",
          toolCalls: [],
        },
        {
          id: "msg_stream_empty",
          role: "assistant",
          source: "voice",
          text: "   ",
          timestamp: Date.now() + 1,
          status: "streaming",
          toolCalls: [],
        },
      );
      const turnsAfterStream = agent.recentConversationTurns(6);
      expect(turnsAfterStream[turnsAfterStream.length - 1]?.text).toBe(
        "前两次可能没听清，这次已开",
      );
    } finally {
      vl.dispose();
      agent.dispose();
      networkMonitor.stop();
      mw.dispose();
      await jobs.shutdown();
    }
  });
});
