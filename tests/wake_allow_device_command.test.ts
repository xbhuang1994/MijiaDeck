// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 唤醒词判定增加“或含控制设备指令即放行”条件回归与端到端测试

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildHomeCapabilityDigest } from "../src/agent/intentCanonicalizer.ts";
import type { WakeWordAcousticHit } from "../src/agent/openWakeWordEngine.ts";
import { PiAgentService } from "../src/agent/piAgentService.ts";
import {
  SystemOneClient,
  type WakeAttentionDecision,
  type WakeDeviceCommandDecision,
} from "../src/agent/systemOneClient.ts";
import {
  evaluateVoiceAttention,
  hasExplicitDeviceControlCommand,
} from "../src/agent/voiceAttentionGate.ts";
import {
  extractWakeCommand,
  VoiceListenerController,
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
import { createDeviceInfo } from "../src/core/models.ts";
import * as settingsStore from "../src/core/settingsStore.ts";
import { VirtualDemoService } from "../src/core/virtualLightService.ts";
import { MainWindowController } from "../src/ui/controllers/mainWindowController.ts";
import { applyTheme, ThemeController } from "../src/ui/theme.ts";

interface CapturedBody {
  model: string;
  state: Record<string, unknown>;
  questions: Record<string, { type: string; instructions: string; criteria?: Record<string, string> }>;
}

function makeMockSystemOne(
  resolver: (utterance: string, body: CapturedBody) => {
    wake: WakeAttentionDecision;
    wakeConfidence?: number;
    deviceCommand: WakeDeviceCommandDecision;
    deviceCommandConfidence?: number;
  },
  options?: { confidenceThreshold?: number },
): { client: SystemOneClient; calls: CapturedBody[] } {
  const calls: CapturedBody[] = [];
  const fetcher: FetchLike = async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as CapturedBody;
    calls.push(body);
    const utterance = String(body.state?.utterance ?? "");
    const answers: Record<string, unknown> = {};

    if (body.questions.decision || body.questions.device_command) {
      const v = resolver(utterance, body);
      const wc = v.wakeConfidence ?? 0.92;
      const dc = v.deviceCommandConfidence ?? 0.94;
      if (body.questions.decision) {
        answers.decision = {
          type: "choice",
          choice: v.wake,
          probabilities: {
            valid_wake: v.wake === "valid_wake" ? wc : Number((1 - wc).toFixed(4)),
            false_wake: v.wake === "false_wake" ? wc : Number((1 - wc).toFixed(4)),
          },
          confidence: wc,
        };
      }
      if (body.questions.device_command) {
        answers.device_command = {
          type: "choice",
          choice: v.deviceCommand,
          probabilities: {
            has_device_command:
              v.deviceCommand === "has_device_command" ? dc : Number((1 - dc).toFixed(4)),
            no_device_command:
              v.deviceCommand === "no_device_command" ? dc : Number((1 - dc).toFixed(4)),
          },
          confidence: dc,
        };
      }
    }

    return new Response(
      JSON.stringify({
        model: DEFAULT_SYSTEMONE_MODEL,
        answers,
        usage: { input_tokens: 80, output_tokens: 8 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  const client = new SystemOneClient({
    baseUrl: "https://systemone.local.test/v1",
    apiKey: "sk-wake-device-cmd-test",
    confidenceThreshold: options?.confidenceThreshold ?? 0.65,
    fetcher,
  });
  return { client, calls };
}

function makeAcousticHit(wakeWord = "Neo", score = 0.78, matched = true): WakeWordAcousticHit {
  return {
    wakeWord,
    score,
    rawScore: score,
    threshold: 0.6,
    matched,
    source: "enrolled",
    frameIndex: 2,
    sampleOffset: 8000,
    latencyMs: 5,
  };
}

let tmpDir = "";

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "mijiadeck-wake-devcmd-"));
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

describe("Wake-Word OR Device-Control Command Condition", () => {
  test("hasExplicitDeviceControlCommand accurately detects device control commands and rejects questions, past reports, and chat", () => {
    const washerDigest = buildHomeCapabilityDigest([
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

    for (const positive of [
      "打开客厅吸顶灯",
      "打开个性灯",
      "关闭卧室灯",
      "把客厅灯关了",
      "关灯",
      "开灯",
      "房间太热了，把空调调到26度",
      "客厅有点暗，帮我开一下灯",
      "洗衣机暂停一下",
      "扫地机开始清扫",
      "把窗帘拉上",
      "浴霸关掉",
      "把电视声音调小一点",
      "播放点音乐吧",
      "停止播放",
      "静音",
      "我刚才聊到Neo，顺便把客厅灯关了",
      "turn on the living room light",
      "stop music",
    ]) {
      expect(hasExplicitDeviceControlCommand(positive)).toBe(true);
    }

    expect(hasExplicitDeviceControlCommand("帮我洗一下袜子", washerDigest)).toBe(true);
    expect(hasExplicitDeviceControlCommand("袜子洗好了吗", washerDigest)).toBe(false);

    for (const negative of [
      "你有打开窗户吗？",
      "空调开着吗？",
      "客厅灯开了吗",
      "帮我问问有没有关灯",
      "我刚才把灯关了",
      "我已经打开客厅灯了",
      "客厅灯打开了",
      "我刚才聊到小派，打开客厅吸顶灯那个演示挺不错",
      "别关灯",
      "不要开空调",
      "出门没关灯",
      "我觉得客厅有点暗呢",
      "今天晚饭吃什么",
      "我刚才聊到Neo挺好用的",
      "别管小派了，我们去吃饭吧",
      "neon lights look bright",
      "pioneer speaker review",
      "No, stop that",
      "如果太亮了就关灯",
      "今天天气真不错",
    ]) {
      expect(hasExplicitDeviceControlCommand(negative)).toBe(false);
    }
  });

  test("SystemOneClient.evaluateWakeAttention evaluates decision OR device_command in a single batch and caches only full rejections", async () => {
    let wake: WakeAttentionDecision = "false_wake";
    let wakeConf = 0.93;
    let deviceCommand: WakeDeviceCommandDecision = "has_device_command";
    let deviceCommandConf = 0.94;

    const { client, calls } = makeMockSystemOne(() => ({
      wake,
      wakeConfidence: wakeConf,
      deviceCommand,
      deviceCommandConfidence: deviceCommandConf,
    }));

    // 1. false_wake + has_device_command -> ACCEPTED via OR condition, NEVER cached
    const r1 = await client.evaluateWakeAttention({
      utterance: "房间太热了，把空调打开",
      wakeWords: ["Neo"],
    });
    expect(r1).not.toBeNull();
    expect(r1!.decision).toBe("false_wake");
    expect(r1!.hasDeviceCommand).toBe(true);
    expect(r1!.accepted).toBe(true);
    expect(r1!.acceptedBy).toBe("device_command");
    expect(r1!.isFalseWake).toBe(false);
    expect(r1!.cached).toBe(false);

    // Repeating same utterance must NOT hit negative cache
    const r1Repeat = await client.evaluateWakeAttention({
      utterance: "房间太热了，把空调打开",
      wakeWords: ["Neo"],
    });
    expect(r1Repeat!.cached).toBe(false);
    expect(calls).toHaveLength(2);
    expect(Object.keys(calls[0]!.questions).sort()).toEqual(["decision", "device_command"]);

    // 2. Strict mode: low-confidence wake (0.70 < 0.75) + high-confidence device_command (0.94 >= 0.75) -> ACCEPTED
    wake = "valid_wake";
    wakeConf = 0.7;
    deviceCommand = "has_device_command";
    deviceCommandConf = 0.94;
    const rStrictOr = await client.evaluateWakeAttention(
      { utterance: "打开客厅吸顶灯", wakeWords: ["Neo"] },
      { strict: true },
    );
    expect(rStrictOr!.accepted).toBe(true);
    expect(rStrictOr!.acceptedBy).toBe("device_command");

    // 3. valid_wake + has_device_command -> acceptedBy: "both"
    wake = "valid_wake";
    wakeConf = 0.95;
    const rBoth = await client.evaluateWakeAttention({
      utterance: "Neo，打开客厅吸顶灯",
      wakeWords: ["Neo"],
    });
    expect(rBoth!.accepted).toBe(true);
    expect(rBoth!.acceptedBy).toBe("both");

    // 4. false_wake + no_device_command -> REJECTED and cached
    wake = "false_wake";
    wakeConf = 0.94;
    deviceCommand = "no_device_command";
    deviceCommandConf = 0.96;
    const rReject1 = await client.evaluateWakeAttention({
      utterance: "今天晚饭吃什么",
      wakeWords: ["Neo"],
    });
    const rReject2 = await client.evaluateWakeAttention({
      utterance: "今天晚饭吃什么",
      wakeWords: ["Neo"],
    });
    expect(rReject1!.accepted).toBe(false);
    expect(rReject1!.acceptedBy).toBe("none");
    expect(rReject1!.cached).toBe(false);
    expect(rReject2!.cached).toBe(true);
  });

  test("evaluateVoiceAttention applies wake-word OR device-command across SystemOne, acoustic-veto, offline fallback, strict mode, and standby no-wake", async () => {
    const { client, calls } = makeMockSystemOne((utterance) => {
      if (utterance.includes("打开") || utterance.includes("关了") || utterance.includes("空调")) {
        return {
          wake: "false_wake",
          wakeConfidence: 0.91,
          deviceCommand: "has_device_command",
          deviceCommandConfidence: 0.95,
        };
      }
      return {
        wake: "false_wake",
        wakeConfidence: 0.94,
        deviceCommand: "no_device_command",
        deviceCommandConfidence: 0.96,
      };
    });

    // 1. Situation A3-1: SystemOne returns false_wake + has_device_command on mid-sentence wake + device cmd
    const s1DevicePass = await evaluateVoiceAttention({
      rawText: "我刚才聊到Neo，顺便把客厅灯关了",
      wakeWordEnabled: true,
      wakeWords: ["Neo"],
      attentionMode: "smart",
      systemOneClient: client,
    });
    expect(s1DevicePass.accept).toBe(true);
    expect(s1DevicePass.wokeOnly).toBe(false);
    expect(s1DevicePass.stage).toBe("systemone-attention");
    expect(s1DevicePass.passSource).toBe("device_command");
    expect(s1DevicePass.command).toBe("顺便把客厅灯关了");

    // 2. Situation C2 (strict mode): OWW triggered Neo, ASR dropped 'Neo' completely -> SystemOne false_wake + has_device_command -> ACCEPTED!
    const strictAcousticDroppedWake = await evaluateVoiceAttention({
      rawText: "打开客厅吸顶灯",
      wakeWordEnabled: true,
      wakeWords: ["Neo"],
      attentionMode: "strict",
      dialogState: "standby",
      acousticWake: makeAcousticHit("Neo", 0.78, true),
      systemOneClient: client,
    });
    expect(strictAcousticDroppedWake.accept).toBe(true);
    expect(strictAcousticDroppedWake.wokeOnly).toBe(false);
    expect(strictAcousticDroppedWake.stage).toBe("systemone-attention");
    expect(strictAcousticDroppedWake.passSource).toBe("device_command");
    expect(strictAcousticDroppedWake.command).toBe("打开客厅吸顶灯");

    // 3. Situation D (standby, NO wake word, NO acoustic wake):
    //    - smart mode: explicit device control command passes in 0ms without blocking
    const standbyDeviceCmd = await evaluateVoiceAttention({
      rawText: "把卧室空调调到26度",
      wakeWordEnabled: true,
      wakeWords: ["Neo"],
      attentionMode: "smart",
      dialogState: "standby",
      systemOneClient: client,
    });
    expect(standbyDeviceCmd.accept).toBe(true);
    expect(standbyDeviceCmd.stage).toBe("fast-wake");
    expect(standbyDeviceCmd.passSource).toBe("device_command");
    expect(standbyDeviceCmd.command).toBe("把卧室空调调到26度");

    //    - strict mode: explicit device control command verifies via SystemOne and passes
    const callsBeforeStrictStandby = calls.length;
    const strictStandbyDeviceCmd = await evaluateVoiceAttention({
      rawText: "打开客厅吸顶灯",
      wakeWordEnabled: true,
      wakeWords: ["Neo"],
      attentionMode: "strict",
      dialogState: "standby",
      systemOneClient: client,
    });
    expect(calls.length).toBe(callsBeforeStrictStandby + 1);
    expect(strictStandbyDeviceCmd.accept).toBe(true);
    expect(strictStandbyDeviceCmd.stage).toBe("systemone-attention");
    expect(strictStandbyDeviceCmd.passSource).toBe("device_command");
    expect(strictStandbyDeviceCmd.command).toBe("打开客厅吸顶灯");

    //    - non-command standby speech STILL rejects with 0 extra SystemOne calls
    const callsBeforeChat = calls.length;
    const standbyChat = await evaluateVoiceAttention({
      rawText: "今天晚饭吃什么",
      wakeWordEnabled: true,
      wakeWords: ["Neo"],
      attentionMode: "smart",
      dialogState: "standby",
      systemOneClient: client,
    });
    expect(standbyChat.accept).toBe(false);
    expect(standbyChat.stage).toBe("no-wake");
    expect(calls.length).toBe(callsBeforeChat);

    // 4. Situation A0 (low OWW score): fuzzy wake + device cmd passes, fuzzy wake without device cmd stays vetoed
    const lowOwwDevice = await evaluateVoiceAttention({
      rawText: "尼奥，打开客厅吸顶灯",
      wakeWordEnabled: true,
      wakeWords: ["Neo"],
      attentionMode: "smart",
      owwActiveForWord: true,
      acousticWake: makeAcousticHit("Neo", 0.2, false),
    });
    expect(lowOwwDevice.accept).toBe(true);
    expect(lowOwwDevice.passSource).toBe("device_command");
    expect(lowOwwDevice.command).toBe("打开客厅吸顶灯");

    const lowOwwNoDevice = await evaluateVoiceAttention({
      rawText: "尼奥在吗",
      wakeWordEnabled: true,
      wakeWords: ["Neo"],
      attentionMode: "smart",
      owwActiveForWord: true,
      acousticWake: makeAcousticHit("Neo", 0.2, false),
    });
    expect(lowOwwNoDevice.accept).toBe(false);
    expect(lowOwwNoDevice.stage).toBe("acoustic-veto");

    // 5. Situation A4 (offline fallback): trailing wake word + device cmd passes cleanly
    const offlineTrailingWake = await evaluateVoiceAttention({
      rawText: "帮我把客厅灯打开Neo",
      wakeWordEnabled: true,
      wakeWords: ["Neo"],
      attentionMode: "smart",
    });
    expect(offlineTrailingWake.accept).toBe(true);
    expect(offlineTrailingWake.passSource).toBe("device_command");
    expect(offlineTrailingWake.command).toBe("帮我把客厅灯打开");

    // 6. attentionMode === "off" also respects the OR condition
    const offModeDevice = await evaluateVoiceAttention({
      rawText: "关闭客厅吸顶灯",
      wakeWordEnabled: true,
      wakeWords: ["Neo"],
      attentionMode: "off",
    });
    expect(offModeDevice.accept).toBe(true);
    expect(offModeDevice.passSource).toBe("device_command");
    expect(offModeDevice.command).toBe("关闭客厅吸顶灯");

    // 7. Security & echo guards run BEFORE wake-word OR condition and are NEVER bypassed
    const voiceprintBlocked = await evaluateVoiceAttention({
      rawText: "打开客厅吸顶灯",
      wakeWordEnabled: true,
      wakeWords: ["Neo"],
      attentionMode: "smart",
      voiceprintMode: "strict",
      voiceprint: {
        evaluated: true,
        matched: false,
        speakerId: null,
        speakerName: null,
        role: null,
        score: 0.18,
        threshold: 0.45,
        engine: "3dspeaker-campplus",
        enrolledCount: 1,
        candidates: [],
      },
    });
    expect(voiceprintBlocked.accept).toBe(false);
    expect(voiceprintBlocked.stage).toBe("voiceprint");

    const now = Date.now();
    const echoBlocked = await evaluateVoiceAttention({
      rawText: "已关闭客厅吸顶灯",
      wakeWordEnabled: true,
      wakeWords: ["Neo"],
      attentionMode: "smart",
      lastSpokenReply: "已关闭客厅吸顶灯",
      lastSpokenAt: now - 400,
      now,
    });
    expect(echoBlocked.accept).toBe(false);
    expect(echoBlocked.stage).toBe("echo");

    // 8. extractWakeCommand helper also allows explicit device control command
    const helperMatch = extractWakeCommand("关闭客厅吸顶灯", {
      wakeWordEnabled: true,
      wakeWords: ["Neo"],
    });
    expect(helperMatch.matched).toBe(true);
    expect(helperMatch.wokeOnly).toBe(false);
    expect(helperMatch.command).toBe("关闭客厅吸顶灯");
  });

  test("End-to-end VoiceListenerController: standby device control command executes real demo device without wake word while chat stays standby", async () => {
    const { client } = makeMockSystemOne((utterance) => ({
      wake: "false_wake",
      wakeConfidence: 0.92,
      deviceCommand:
        utterance.includes("客厅吸顶灯") ? "has_device_command" : "no_device_command",
      deviceCommandConfidence: 0.96,
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
      wakeWordEnabled: true,
      wakeWords: ["Neo"],
      autoSpeakReply: false,
      sourceSeparationMode: "off",
      owwEnabled: false,
      systemOneMode: "on",
      systemOneBaseUrl: "https://systemone.local.test/v1",
      systemOneApiKey: "sk-e2e-devcmd",
      conversationWindowSec: 25,
    });

    const agent = new PiAgentService({
      deps: { mainWindow: mw, service: demo, jobs, settingsStore, broadcastState: () => {} },
      initialConfig: cfg,
    });
    (agent as unknown as { _systemOne: SystemOneClient })._systemOne = client;
    const vl = new VoiceListenerController(agent);

    try {
      expect(vl.dialogState).toBe("standby");
      expect(await demo.powerState("demo-light-living")).toBe(true);

      // 1. Ordinary standby chat without wake word stays ignored in standby
      const chat = await vl.handleTranscript("今天晚饭吃什么", { isFinal: true });
      expect(chat.matched).toBe(false);
      expect(vl.dialogState).toBe("standby");
      expect(await demo.powerState("demo-light-living")).toBe(true);

      // 2. Direct standby device control command without wake word passes and turns off real demo light
      const turnOff = await vl.handleTranscript("关闭客厅吸顶灯", { isFinal: true });
      expect(turnOff.matched).toBe(true);
      expect(turnOff.command).toBe("关闭客厅吸顶灯");
      expect(turnOff.attention?.passSource).toBe("device_command");
      expect(await demo.powerState("demo-light-living")).toBe(false);
      expect(vl.dialogState).toBe("conversation");

      // 3. Exit back to standby; strict mode + SystemOne OR condition turns light back ON even when wake=false_wake
      vl.exitConversation("manual_test", { speakAck: false });
      expect(vl.dialogState).toBe("standby");
      agent.reconfigure({ ...cfg, attentionMode: "strict" });
      (agent as unknown as { _systemOne: SystemOneClient })._systemOne = client;

      const turnOn = await vl.handleTranscript("嗯，把客厅吸顶灯打开", {
        isFinal: true,
        acousticWake: makeAcousticHit("Neo", 0.72, true),
      });
      expect(turnOn.matched).toBe(true);
      expect(turnOn.attention?.stage).toBe("systemone-attention");
      expect(turnOn.attention?.passSource).toBe("device_command");
      expect(await demo.powerState("demo-light-living")).toBe(true);
    } finally {
      vl.dispose();
      agent.dispose();
      networkMonitor.stop();
      mw.dispose();
      await jobs.shutdown();
    }
  });
});
