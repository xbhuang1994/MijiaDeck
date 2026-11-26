// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 固定秒数对话倒计时退出（取消动态持续保活与 SystemOne 结束判定）回归测试

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai";
import { PiAgentService } from "../src/agent/piAgentService.ts";
import {
  assistantReplyExpectsUserResponse,
  evaluateVoiceAttention,
} from "../src/agent/voiceAttentionGate.ts";
import {
  VoiceListenerController,
  type VoiceListenerControllerOptions,
} from "../src/agent/voiceListenerController.ts";
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
import { startMijiaDeckServer, type MijiaDeckServer } from "../src/server/server.ts";
import { MainWindowController } from "../src/ui/controllers/mainWindowController.ts";
import { applyTheme, ThemeController } from "../src/ui/theme.ts";

let tmpDir = "";
let server: MijiaDeckServer | null = null;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "mijiadeck-fixed-conv-exit-"));
  const dir = tmpDir;
  setDataPathOverrides({ dataDir: () => dir });
});

afterEach(async () => {
  if (server) {
    await server.stop();
    server = null;
  }
  setDataPathOverrides(null);
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = "";
  }
});

async function createFixedCountdownHarness(options: {
  configOverrides?: Record<string, unknown>;
  vlOptions?: VoiceListenerControllerOptions;
  customStreamFn?: ConstructorParameters<typeof PiAgentService>[0]["customStreamFn"];
  customModel?: ConstructorParameters<typeof PiAgentService>[0]["customModel"];
  fetcher?: FetchLike;
} = {}) {
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
    wakeWords: ["Neo", "小派"],
    autoSpeakReply: false,
    sourceSeparationMode: "off",
    owwEnabled: false,
    conversationWindowSec: 1,
    ...options.configOverrides,
  });

  const agent = new PiAgentService({
    deps: { mainWindow: mw, service: demo, jobs, settingsStore, broadcastState: () => {} },
    initialConfig: cfg,
    systemOneFetcher: options.fetcher,
    customStreamFn: options.customStreamFn,
    customModel: options.customModel,
  });

  const vl = new VoiceListenerController(agent, options.vlOptions);

  const cleanup = async () => {
    vl.dispose();
    agent.dispose();
    networkMonitor.stop();
    mw.dispose();
    await jobs.shutdown();
  };

  return { demo, mw, agent, vl, cleanup };
}

describe("Fixed-Seconds Conversation Countdown Exit (Dynamic Keep-Alive Disabled)", () => {
  test("exits strictly after fixed conversationWindowSec even when assistant asks an open question and SystemOne is enabled", async () => {
    const convEndCalls: unknown[] = [];
    const mockFetcher: FetchLike = async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        questions?: Record<string, unknown>;
      };
      if (body.questions && "conv_end" in body.questions) {
        convEndCalls.push(body);
      }
      return new Response(
        JSON.stringify({
          model: DEFAULT_SYSTEMONE_MODEL,
          answers: {
            decision: {
              type: "choice",
              choice: "valid_wake",
              probabilities: { valid_wake: 0.96, false_wake: 0.04 },
              confidence: 0.96,
            },
            device_command: {
              type: "choice",
              choice: "no_device_command",
              probabilities: { has_device_command: 0.04, no_device_command: 0.96 },
              confidence: 0.96,
            },
          },
          usage: { input_tokens: 40, output_tokens: 6 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const faux = fauxProvider();
    const streamFn: ConstructorParameters<typeof PiAgentService>[0]["customStreamFn"] = () => {
      const reply = "方案一：轻柔洗 30 分钟；方案二：快洗 15 分钟。请问你想选哪个方案？";
      const stream = createAssistantMessageEventStream();
      const msg = fauxAssistantMessage(reply, { stopReason: "stop" });
      queueMicrotask(() => {
        stream.push({ type: "start", partial: msg });
        stream.push({ type: "text_start", contentIndex: 0, partial: msg });
        stream.push({ type: "text_delta", contentIndex: 0, delta: reply, partial: msg });
        stream.push({ type: "text_end", contentIndex: 0, content: reply, partial: msg });
        stream.push({ type: "done", reason: "stop", message: msg });
        stream.end(msg);
      });
      return stream;
    };

    const h = await createFixedCountdownHarness({
      configOverrides: {
        provider: "openai",
        modelId: faux.getModel().id,
        preferLocalIntents: false,
        conversationWindowSec: 1,
        systemOneMode: "on",
        systemOneBaseUrl: "https://karpo.example.com/v1",
        systemOneApiKey: "sk-fixed-test-123456",
      },
      customStreamFn: streamFn,
      customModel: faux.getModel(),
      fetcher: mockFetcher,
    });

    try {
      const r1 = await h.vl.handleTranscript("Neo，帮我拟定两个洗衣方案", { isFinal: true });
      expect(r1.matched).toBe(true);
      expect(convEndCalls.length).toBe(0);
      expect(h.vl.dialogState).toBe("conversation");
      expect(h.vl.snapshot().timerPaused).toBe(false);
      expect(h.vl.snapshot().conversationUntil).not.toBeNull();
      expect(h.vl.snapshot().conversationRemainingMs).toBeGreaterThan(0);

      // Fixed 1s countdown MUST exit cleanly without waiting for any SystemOne idle recheck
      const deadline = Date.now() + 2200;
      while (Date.now() < deadline && h.vl.dialogState === "conversation") {
        await Bun.sleep(50);
      }
      expect(h.vl.dialogState).toBe("standby");
      expect(h.vl.snapshot().lastTransitionReason).toBe("timeout");
      expect(convEndCalls.length).toBe(0);
    } finally {
      await h.cleanup();
    }
  }, 10_000);

  test("interim partial transcripts do not pause or extend fixed conversation countdown", async () => {
    const h = await createFixedCountdownHarness({
      configOverrides: { conversationWindowSec: 1 },
    });
    try {
      h.vl.enterConversation("wake_only", { speakAck: false });
      expect(h.vl.dialogState).toBe("conversation");
      expect(h.vl.snapshot().timerPaused).toBe(false);

      // Simulate streaming partial transcripts arriving repeatedly (e.g. TV chatter)
      for (let i = 0; i < 4; i += 1) {
        await h.vl.handleTranscript(`电视正在播放第${i}句台词`, { isFinal: false });
        expect(h.vl.snapshot().timerPaused).toBe(false);
        await Bun.sleep(320);
      }

      const deadline = Date.now() + 1500;
      while (Date.now() < deadline && h.vl.dialogState === "conversation") {
        await Bun.sleep(40);
      }
      expect(h.vl.dialogState).toBe("standby");
      expect(h.vl.snapshot().lastTransitionReason).toBe("timeout");
    } finally {
      await h.cleanup();
    }
  }, 10_000);

  test("TTS speaking pauses countdown and resumes fixed countdown cleanly after TTS finishes", async () => {
    const h = await createFixedCountdownHarness({
      configOverrides: { conversationWindowSec: 1 },
    });
    try {
      h.vl.enterConversation("wake_only", { speakAck: false });
      h.vl.setTtsSpeaking(true);
      const res = await h.vl.handleTranscript("关闭客厅吸顶灯", { isFinal: true });
      expect(res.matched).toBe(true);
      expect(h.vl.snapshot().timerPaused).toBe(true);

      await Bun.sleep(1400);
      expect(h.vl.dialogState).toBe("conversation");

      h.vl.setTtsSpeaking(false);
      expect(h.vl.snapshot().timerPaused).toBe(false);
      const deadline = Date.now() + 4500;
      while (Date.now() < deadline && h.vl.dialogState === "conversation") {
        await Bun.sleep(60);
      }
      expect(h.vl.dialogState).toBe("standby");
      expect(h.vl.snapshot().lastTransitionReason).toBe("timeout");
    } finally {
      await h.cleanup();
    }
  }, 12_000);

  test("preserves short replies to assistant questions within the fixed conversation window", async () => {
    expect(assistantReplyExpectsUserResponse("你要打开客厅还是卧室的灯？")).toBe(true);
    expect(assistantReplyExpectsUserResponse("客厅灯已打开。")).toBe(false);

    const shortReplyDec = await evaluateVoiceAttention({
      rawText: "好",
      wakeWordEnabled: true,
      wakeWords: ["Neo", "小派"],
      attentionMode: "smart",
      dialogState: "conversation",
      inConversation: true,
      recentTurns: [
        { role: "user", text: "客厅有点暗", timestamp: Date.now() - 2000 },
        { role: "assistant", text: "需要我帮你打开客厅吸顶灯吗？", timestamp: Date.now() - 1000 },
      ],
    });
    expect(shortReplyDec.accept).toBe(true);
    expect(shortReplyDec.command).toBe("好");
  });

  test("server /api/state reports active fixed countdown (timerPaused=false) during conversation and VAD speech", async () => {
    const demo = new VirtualDemoService();
    server = await startMijiaDeckServer({ mode: "demo", port: 0, service: demo });
    const vl = server.runtime.voiceListener!;

    vl.enterConversation("wake_only", { speakAck: false });
    vl.setSpeechInProgress(true);

    const res = await fetch(`${server.url}/api/state`);
    expect(res.ok).toBe(true);
    const json = (await res.json()) as {
      voiceListen?: {
        dialogState?: string;
        timerPaused?: boolean;
        conversationRemainingMs?: number;
        conversationUntil?: number | null;
      };
    };
    expect(json.voiceListen?.dialogState).toBe("conversation");
    expect(json.voiceListen?.timerPaused).toBe(false);
    expect(json.voiceListen?.conversationUntil).not.toBeNull();
    expect((json.voiceListen?.conversationRemainingMs ?? 0) > 0).toBe(true);
  });
});
