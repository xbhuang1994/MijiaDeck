// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 简单常规控制指令状态检查正常后静默、仅异常或需询问时回复 单元测试与端到端集成测试

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { PiAgentService, TASK_ACK_TEXT } from "../src/agent/piAgentService.ts";
import {
  evaluateSilentControlReply,
  hasExplicitInfoQueryIntent,
  isSimpleRoutineDeviceAction,
  replyNeedsUserAttention,
  replyReportsAnomalyOrWarning,
} from "../src/agent/silentControlReplyPolicy.ts";
import type {
  ExecutedToolTrace,
  TaskVerificationOutcome,
} from "../src/agent/taskVerificationLoop.ts";
import { VoiceListenerController } from "../src/agent/voiceListenerController.ts";
import {
  defaultAgentVoiceConfig,
  loadAgentVoiceConfig,
  updateAgentVoiceConfig,
  type AgentVoiceConfig,
} from "../src/core/agentConfigStore.ts";
import { NetworkMonitor } from "../src/core/availability.ts";
import { JobExecutor } from "../src/core/jobs.ts";
import { setDataPathOverrides } from "../src/core/jsonStore.ts";
import { createDeviceInfo } from "../src/core/models.ts";
import * as settingsStore from "../src/core/settingsStore.ts";
import { VirtualDemoService } from "../src/core/virtualLightService.ts";
import { startMijiaDeckServer, type MijiaDeckServer } from "../src/server/server.ts";
import { MainWindowController } from "../src/ui/controllers/mainWindowController.ts";
import { applyTheme, ThemeController } from "../src/ui/theme.ts";

let tmpDir = "";
let server: MijiaDeckServer | null = null;

function makePassedOutcome(toolName = "set_device_power", did = "demo-light-living"): TaskVerificationOutcome {
  return {
    checked: true,
    passed: true,
    checks: [{ did, deviceName: "客厅吸顶灯", toolName, passed: true, summary: "客厅吸顶灯电源状态核验通过" }],
    issues: [],
    solvable: true,
    analysis: "已完成 1 项设备状态核验，结果全部符合预期。",
    specs: [],
  };
}

function makeLightPowerTrace(did = "demo-light-living", state = false): ExecutedToolTrace {
  return {
    toolCallId: "tc_power_1",
    name: "set_device_power",
    args: { target: did, state: state ? "on" : "off" },
    isError: false,
    text: state ? "客厅吸顶灯已开" : "客厅吸顶灯已关",
    details: {
      ok: true,
      succeeded: [{ did, name: "客厅吸顶灯", state }],
      failed: [],
    },
  };
}

function createHarness(options: {
  service?: VirtualDemoService;
  initialConfig?: AgentVoiceConfig;
  customStreamFn?: ConstructorParameters<typeof PiAgentService>[0]["customStreamFn"];
  customModel?: ConstructorParameters<typeof PiAgentService>[0]["customModel"];
} = {}) {
  const service = options.service ?? new VirtualDemoService();
  const jobs = new JobExecutor();
  applyTheme("dark", "green");
  const themeCtrl = new ThemeController("dark");
  const networkMonitor = new NetworkMonitor({
    initialReachability: "online",
    autoStart: false,
  });
  const mainWindow = new MainWindowController({
    service,
    jobs,
    themeCtrl,
    networkMonitor,
    autoStartTimers: false,
    cacheLoader: () => null,
    cacheSaver: () => {},
  });

  const agent = new PiAgentService({
    deps: {
      service,
      jobs,
      mainWindow,
      settingsStore,
      broadcastState: () => {},
    },
    ...(options.initialConfig ? { initialConfig: options.initialConfig } : {}),
    ...(options.customStreamFn ? { customStreamFn: options.customStreamFn } : {}),
    ...(options.customModel ? { customModel: options.customModel } : {}),
  });

  return {
    service,
    jobs,
    mainWindow,
    agent,
    async ready() {
      mainWindow.start();
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        if (!mainWindow.loadActive && !mainWindow.loadingDevices && mainWindow.allDevices.length > 0) {
          break;
        }
        await Bun.sleep(15);
      }
    },
    async cleanup() {
      agent.dispose();
      networkMonitor.stop();
      mainWindow.dispose();
      await jobs.shutdown();
    },
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "mijiadeck-silent-ctrl-"));
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

describe("SilentControlReplyPolicy — Pure 4-Gate Decision Engine", () => {
  test("silences clean simple routine controls (power, light, speaker, routine property, prerequisite probe, reused skill)", () => {
    // 1. Simple light power off
    const rPower = evaluateSilentControlReply({
      userText: "关闭客厅吸顶灯",
      ackScenario: "execute_control",
      traces: [makeLightPowerTrace("demo-light-living", false)],
      verification: makePassedOutcome("set_device_power", "demo-light-living"),
      retriesUsed: 0,
      candidateReply: "好的，客厅吸顶灯已经关掉了",
      status: "done",
    });
    expect(rPower.silent).toBe(true);

    // 2. Prerequisite get_device_detail on SAME device before control_light
    const rProbeLight = evaluateSilentControlReply({
      userText: "把客厅吸顶灯调暗一点",
      ackScenario: "execute_control",
      traces: [
        {
          toolCallId: "tc_probe",
          name: "get_device_detail",
          args: { target: "demo-light-living" },
          isError: false,
          text: "亮度 72%",
          details: { did: "demo-light-living", name: "客厅吸顶灯" },
        },
        {
          toolCallId: "tc_light",
          name: "control_light",
          args: { target: "demo-light-living", brightness: 45 },
          isError: false,
          text: "客厅吸顶灯亮度 45%",
          details: { did: "demo-light-living", name: "客厅吸顶灯", brightness: 45 },
        },
      ],
      verification: makePassedOutcome("control_light", "demo-light-living"),
      retriesUsed: 0,
      candidateReply: "客厅吸顶灯亮度已调到 45%。",
      status: "done",
    });
    expect(rProbeLight.silent).toBe(true);

    // 3. Routine AC temperature property
    const rAc = evaluateSilentControlReply({
      userText: "把卧室空调调到26度",
      ackScenario: "execute_control",
      traces: [
        {
          toolCallId: "tc_ac",
          name: "set_device_property",
          args: { target: "midea:ac1", property: "target-temperature", value: 26 },
          isError: false,
          text: "卧室空调 目标温度=26°C",
          details: { did: "midea:ac1", name: "卧室空调", property: "target-temperature", propLabel: "目标温度", value: 26 },
        },
      ],
      verification: makePassedOutcome("set_device_property", "midea:ac1"),
      retriesUsed: 0,
      candidateReply: "卧室空调已设为 26°C。",
      status: "done",
    });
    expect(rAc.silent).toBe(true);

    // 4. Urgent stop music (urgent_cancel without correction)
    const rStopMusic = evaluateSilentControlReply({
      userText: "快停下别放了",
      ackScenario: "urgent_cancel",
      traces: [
        {
          toolCallId: "tc_spk",
          name: "control_speaker",
          args: { playback: "stop" },
          isError: false,
          text: "小爱音箱 Pro 已停止",
          details: { did: "demo-speaker-xiaoai", name: "小爱音箱 Pro", playback: "stop" },
        },
      ],
      verification: makePassedOutcome("control_speaker", "demo-speaker-xiaoai"),
      retriesUsed: 0,
      candidateReply: "小爱音箱 Pro 已停止播放。",
      status: "done",
    });
    expect(rStopMusic.silent).toBe(true);

    // 5. Reused skill with 0 retries
    const rSkillReuse = evaluateSilentControlReply({
      userText: "请帮我打开客厅吸顶灯一下",
      ackScenario: "execute_control",
      traces: [makeLightPowerTrace("demo-light-living", true)],
      verification: makePassedOutcome("set_device_power", "demo-light-living"),
      retriesUsed: 0,
      skillEvent: { kind: "reused" },
      candidateReply: "客厅吸顶灯已打开",
      status: "done",
    });
    expect(rSkillReuse.silent).toBe(true);

    // 6. Reversible curtain/IR action
    const curtainTrace: ExecutedToolTrace = {
      toolCallId: "tc_curtain",
      name: "run_device_action",
      args: { target: "curtain-1", action: "close" },
      isError: false,
      text: "客厅窗帘已执行关闭",
      details: { ok: true, did: "curtain-1", name: "客厅窗帘", action: "close", actionLabel: "关闭" },
    };
    expect(isSimpleRoutineDeviceAction(curtainTrace)).toBe(true);
    expect(
      evaluateSilentControlReply({
        userText: "关闭客厅窗帘",
        ackScenario: "execute_control",
        traces: [curtainTrace],
        verification: makePassedOutcome("run_device_action", "curtain-1"),
        retriesUsed: 0,
        candidateReply: "客厅窗帘已关闭。",
        status: "done",
      }).silent,
    ).toBe(true);

    // 7. Cloud LLM outputting [SILENT] after clean verification
    expect(
      evaluateSilentControlReply({
        userText: "Turn off the living room light",
        ackScenario: "execute_control",
        traces: [makeLightPowerTrace("demo-light-living", false)],
        verification: makePassedOutcome("set_device_power", "demo-light-living"),
        retriesUsed: 0,
        candidateReply: "[SILENT]",
        status: "done",
      }).silent,
    ).toBe(true);
  });

  test("NEVER silences abnormal verification, retries, newly created skills, questions, warnings, queries, scenes, or high-risk devices", () => {
    // Verification failed / unchecked / retried / skill created
    expect(
      evaluateSilentControlReply({
        userText: "打开客厅吸顶灯",
        ackScenario: "execute_control",
        traces: [makeLightPowerTrace("demo-light-living", true)],
        verification: { ...makePassedOutcome(), passed: false, issues: [{ code: "power_mismatch", solvable: true, toolName: "set_device_power", toolArgs: {}, summary: "状态未生效" }] },
        retriesUsed: 0,
      }).silent,
    ).toBe(false);

    expect(
      evaluateSilentControlReply({
        userText: "打开客厅吸顶灯",
        ackScenario: "execute_control",
        traces: [makeLightPowerTrace("demo-light-living", true)],
        verification: makePassedOutcome(),
        retriesUsed: 1,
      }).silent,
    ).toBe(false);

    expect(
      evaluateSilentControlReply({
        userText: "打开客厅吸顶灯",
        ackScenario: "execute_control",
        traces: [makeLightPowerTrace("demo-light-living", true)],
        verification: makePassedOutcome(),
        retriesUsed: 0,
        skillEvent: { kind: "created" },
      }).silent,
    ).toBe(false);

    // Disallowed scenarios (query, scene, troubleshoot, safety, rule, greeting)
    for (const scenario of [
      "query_status",
      "think_creative",
      "scene_routine",
      "troubleshoot",
      "remember_rule",
      "safety_confirm",
      "greeting_chat",
    ] as const) {
      expect(
        evaluateSilentControlReply({
          userText: "打开客厅吸顶灯",
          ackScenario: scenario,
          traces: [makeLightPowerTrace("demo-light-living", true)],
          verification: makePassedOutcome(),
          retriesUsed: 0,
        }).silent,
      ).toBe(false);
    }

    // Scene routine phrase even with execute_control scenario
    expect(
      evaluateSilentControlReply({
        userText: "准备看电影了，灯光暗一点，音箱声音小一点",
        ackScenario: "execute_control",
        traces: [makeLightPowerTrace("demo-light-living", true)],
        verification: makePassedOutcome(),
        retriesUsed: 0,
      }).silent,
    ).toBe(false);

    // Correction / undo utterance
    expect(
      evaluateSilentControlReply({
        userText: "不对，我说的是卧室的灯",
        ackScenario: "urgent_cancel",
        traces: [makeLightPowerTrace("demo-light-living", false)],
        verification: makePassedOutcome(),
        retriesUsed: 0,
      }).silent,
    ).toBe(false);

    // Compound command asking for sensor info alongside light control
    expect(hasExplicitInfoQueryIntent("打开客厅灯，顺便看看卧室多少度")).toBe(true);
    expect(hasExplicitInfoQueryIntent("把卧室空调调到26度")).toBe(false);
    expect(
      evaluateSilentControlReply({
        userText: "打开客厅灯，顺便看看卧室多少度",
        ackScenario: "execute_control",
        traces: [
          makeLightPowerTrace("demo-light-living", true),
          {
            toolCallId: "tc_sensor",
            name: "get_device_detail",
            args: { target: "demo-sensor-bedroom" },
            isError: false,
            text: "23.6°C",
            details: { did: "demo-sensor-bedroom", name: "卧室米家温湿度计" },
          },
        ],
        verification: makePassedOutcome(),
        retriesUsed: 0,
      }).silent,
    ).toBe(false);

    // Unrelated device detail query before control
    expect(
      evaluateSilentControlReply({
        userText: "打开客厅灯",
        ackScenario: "execute_control",
        traces: [
          {
            toolCallId: "tc_other",
            name: "get_device_detail",
            args: { target: "demo-sensor-bedroom" },
            isError: false,
            text: "23.6°C",
            details: { did: "demo-sensor-bedroom", name: "卧室米家温湿度计" },
          },
          makeLightPowerTrace("demo-light-living", true),
        ],
        verification: makePassedOutcome(),
        retriesUsed: 0,
      }).silent,
    ).toBe(false);

    // Sensitive security / infrastructure devices (camera, smart lock, router)
    const camDev = createDeviceInfo({
      did: "demo-cam-balcony",
      name: "阳台摄像头",
      model: "chuangmi.camera.029a02",
      home_name: "演示家庭",
      room_name: "阳台",
      spec_type: "urn:miot-spec-v2:device:camera:0000A01C",
      online: true,
    });
    expect(
      evaluateSilentControlReply({
        userText: "关闭阳台设备",
        ackScenario: "execute_control",
        traces: [
          {
            toolCallId: "tc_cam",
            name: "set_device_power",
            args: { target: "demo-cam-balcony", state: "off" },
            isError: false,
            text: "阳台摄像头已关",
            details: { ok: true, succeeded: [{ did: "demo-cam-balcony", name: "阳台摄像头", state: false }], failed: [] },
          },
        ],
        verification: makePassedOutcome("set_device_power", "demo-cam-balcony"),
        retriesUsed: 0,
        devices: [camDev],
      }).silent,
    ).toBe(false);

    // Timer / countdown / child-lock property
    expect(
      evaluateSilentControlReply({
        userText: "把空调定时设成30分钟",
        ackScenario: "execute_control",
        traces: [
          {
            toolCallId: "tc_timer",
            name: "set_device_property",
            args: { target: "midea:ac1", property: "countdown-time", value: 30 },
            isError: false,
            text: "倒计时 30 分钟",
            details: { did: "midea:ac1", name: "卧室空调", property: "countdown-time", propLabel: "倒计时", value: 30 },
          },
        ],
        verification: makePassedOutcome("set_device_property", "midea:ac1"),
        retriesUsed: 0,
      }).silent,
    ).toBe(false);

    // Pet feeder / washer / dangerous action / XiaoAi forward
    expect(
      isSimpleRoutineDeviceAction({
        toolCallId: "tc_feed",
        name: "run_device_action",
        args: { target: "demo-feeder", action: "pet-food-out", params: [2] },
        isError: false,
        text: "智能宠物喂食器已出粮 2 份",
        details: { ok: true, did: "demo-feeder", action: "pet-food-out", isFeederAction: true },
      }),
    ).toBe(false);

    expect(
      isSimpleRoutineDeviceAction({
        toolCallId: "tc_wash",
        name: "run_device_action",
        args: { target: "midea:washer", action: "start-wash" },
        isError: false,
        text: "已启动洗涤",
        details: { ok: true, did: "midea:washer", action: "start-wash" },
      }),
    ).toBe(false);

    expect(
      isSimpleRoutineDeviceAction({
        toolCallId: "tc_danger",
        name: "run_device_action",
        args: { target: "router-1", action: "reboot", confirm_dangerous: true },
        isError: false,
        text: "已重启",
        details: { ok: true, did: "router-1", action: "reboot" },
      }),
    ).toBe(false);

    // Tuya QR sharing warning note in trace
    expect(
      evaluateSilentControlReply({
        userText: "关闭电视",
        ackScenario: "execute_control",
        traces: [
          {
            toolCallId: "tc_ir",
            name: "set_device_power",
            args: { target: "tuya:tv1", state: "off" },
            isError: false,
            text: "客厅电视 已关（提示：当前为涂鸦扫码共享模式，如设备无响应请在设置→多平台接入补充涂鸦 OpenAPI 凭据）",
            details: {
              ok: true,
              succeeded: [
                {
                  did: "tuya:tv1",
                  name: "客厅电视",
                  state: false,
                  note: "已关（提示：当前为涂鸦扫码共享模式，如设备无响应请在设置→多平台接入补充涂鸦 OpenAPI 凭据）",
                },
              ],
              failed: [],
            },
          },
        ],
        verification: makePassedOutcome("set_device_power", "tuya:tv1"),
        retriesUsed: 0,
      }).silent,
    ).toBe(false);

    // Candidate reply asks question or warns about anomaly
    expect(replyNeedsUserAttention("请问需要把卧室灯也关掉吗？")).toBe(true);
    expect(replyNeedsUserAttention("客厅吸顶灯已经关掉了")).toBe(false);
    expect(replyReportsAnomalyOrWarning("客厅灯已开，但检测到除湿机水箱已满")).toBe(true);
    expect(replyReportsAnomalyOrWarning("客厅吸顶灯亮度已调到 80%。")).toBe(false);

    expect(
      evaluateSilentControlReply({
        userText: "打开客厅吸顶灯",
        ackScenario: "execute_control",
        traces: [makeLightPowerTrace("demo-light-living", true)],
        verification: makePassedOutcome(),
        retriesUsed: 0,
        candidateReply: "客厅吸顶灯已打开，请问需要顺便调暖光吗？",
      }).silent,
    ).toBe(false);

    expect(
      evaluateSilentControlReply({
        userText: "打开客厅吸顶灯",
        ackScenario: "execute_control",
        traces: [makeLightPowerTrace("demo-light-living", true)],
        verification: makePassedOutcome(),
        retriesUsed: 0,
        candidateReply: "客厅吸顶灯已打开，不过检测到卧室传感器电量不足。",
      }).silent,
    ).toBe(false);
  });
});

describe("PiAgentService & VoiceListenerController — End-to-End Silent Simple Control Behavior", () => {
  test("silences routine light/speaker controls after live state verification, preserves multi-turn context, and replies on queries/anomalies", async () => {
    const h = createHarness();
    const voiceCtrl = new VoiceListenerController(h.agent);

    try {
      await h.ready();
      const spokenChunks: Array<{ text: string; priority?: string }> = [];
      const fallbackSpoken: string[] = [];
      h.agent.on("speakChunk", (c) => spokenChunks.push({ text: c.text, priority: c.priority }));
      voiceCtrl.on("speakRequested", (text) => fallbackSpoken.push(text));

      // 1. Simple light off -> speaks ONLY "好的", verifies live power === false, silent completion
      const rOff = await h.agent.prompt("关闭客厅吸顶灯", { source: "voice" });
      expect(rOff.ok).toBe(true);
      expect(rOff.ack).toBe(TASK_ACK_TEXT);
      expect(rOff.silentCompleted).toBe(true);
      expect(rOff.reply).toBe("");
      expect(rOff.verification?.status).toBe("passed");
      expect(await h.service.powerState("demo-light-living")).toBe(false);
      expect(spokenChunks).toEqual([{ text: "好的", priority: "ack" }]);
      expect(fallbackSpoken).toEqual([]);

      // 2. Simple light brightness adjust -> silent after verification
      spokenChunks.length = 0;
      const rBright = await h.agent.prompt("把客厅吸顶灯亮度调到80%", { source: "voice" });
      expect(rBright.ok).toBe(true);
      expect(rBright.silentCompleted).toBe(true);
      expect(rBright.reply).toBe("");
      expect(rBright.verification?.status).toBe("passed");
      expect(await h.service.readProp("demo-light-living", "brightness")).toBe(80);
      expect(spokenChunks).toEqual([{ text: "好的", priority: "ack" }]);

      // 3. Multi-turn pronoun follow-up ("把它关了") still resolves recent device & stays silent!
      spokenChunks.length = 0;
      const rPronoun = await h.agent.prompt("把它关了", { source: "voice" });
      expect(rPronoun.ok).toBe(true);
      expect(rPronoun.silentCompleted).toBe(true);
      expect(rPronoun.reply).toBe("");
      expect(await h.service.powerState("demo-light-living")).toBe(false);
      expect(spokenChunks).toEqual([{ text: "好的", priority: "ack" }]);

      // recentConversationTurns preserves internal summary of silent turns for SystemOne context!
      const turns = h.agent.recentConversationTurns(6);
      expect(turns.some((t) => t.role === "assistant" && t.text.includes("客厅吸顶灯"))).toBe(true);

      // 4. Status query ALWAYS replies & speaks!
      spokenChunks.length = 0;
      const rQuery = await h.agent.prompt("卧室现在温度和湿度多少？", { source: "voice" });
      expect(rQuery.ok).toBe(true);
      expect(rQuery.silentCompleted).toBeUndefined();
      expect(rQuery.reply).toContain("23.6");
      expect(rQuery.reply).toContain("54");
      expect(spokenChunks.length).toBeGreaterThanOrEqual(2);
      expect(spokenChunks.map((s) => s.text).join(" ")).toContain("23.6");

      // 5. Abnormal state: offline device ALWAYS replies & speaks!
      spokenChunks.length = 0;
      const living = h.mainWindow.allDevices.find((d) => d.did === "demo-light-living")!;
      living.online = false;
      const rOffline = await h.agent.prompt("打开客厅吸顶灯", { source: "voice" });
      expect(rOffline.silentCompleted).toBeUndefined();
      expect(rOffline.verification?.status).toBe("unsolvable");
      expect(rOffline.reply).toContain("离线");
      expect(spokenChunks.length).toBe(2);
      expect(spokenChunks[1]?.text).toContain("离线");
      living.online = true;

      // 6. Abnormal state: partial batch failure (1 of 3 dining lights offline) ALWAYS replies & speaks!
      spokenChunks.length = 0;
      const barSpot = h.mainWindow.allDevices.find((d) => d.did === "demo-switch-bar.s3")!;
      barSpot.online = false;
      const rPartial = await h.agent.prompt("关闭餐厅所有灯", { source: "voice" });
      expect(rPartial.silentCompleted).toBeUndefined();
      expect(rPartial.verification?.passed).toBe(false);
      expect(rPartial.reply).toContain("吧台射灯");
      expect(rPartial.reply).toContain("离线");
      expect(spokenChunks.length).toBe(2);
      expect(spokenChunks[1]?.text).toContain("离线");
      barSpot.online = true;

      // 7. VoiceListenerController end-to-end voice command stays silent on final reply & keeps conversation alive
      spokenChunks.length = 0;
      fallbackSpoken.length = 0;
      const voiceRes = await voiceCtrl.handleTranscript("小派，打开客厅吸顶灯", {
        isFinal: true,
        asyncDispatch: false,
      });
      expect(voiceRes.ok).toBe(true);
      expect(voiceRes.reply).toBe("");
      expect(voiceRes.voiceState.dialogState).toBe("conversation");
      expect(await h.service.powerState("demo-light-living")).toBe(true);
      expect(spokenChunks).toEqual([{ text: "好的", priority: "ack" }]);
      expect(fallbackSpoken).toEqual([]);
    } finally {
      voiceCtrl.dispose();
      await h.cleanup();
    }
  });

  test("Cloud LLM: silences verified simple control (even with verbose LLM text), NEVER silences LLM questions/warnings or failed verification on [SILENT]", async () => {
    const service = new VirtualDemoService();
    let dropLivingPowerOnce = false;
    const origSetPower = service.setPowerState.bind(service);
    service.setPowerState = async (did: string, state: boolean) => {
      if (did === "demo-light-living" && dropLivingPowerOnce) {
        dropLivingPowerOnce = false;
        return; // silently drop write so verification fails!
      }
      return origSetPower(did, state);
    };

    const faux = fauxProvider({
      models: [{ id: "faux-silent-ctrl", name: "Faux Silent Ctrl" }],
    });
    faux.setResponses([
      // Case 1: prerequisite get_device_detail + control_light + verbose confirmation -> SILENT
      fauxAssistantMessage(
        [
          fauxToolCall("get_device_detail", { target: "demo-light-living" }),
          fauxToolCall("control_light", { target: "demo-light-living", on: true, brightness: 40 }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("已为您将客厅吸顶灯亮度调整为 40%。", { stopReason: "stop" }),

      // Case 2: control_light succeeds, BUT LLM notices issue and asks user a question -> REPLIES!
      fauxAssistantMessage(
        [fauxToolCall("set_device_power", { target: "demo-light-living", state: "on" })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("客厅吸顶灯已打开，但检测到湿度偏高，需要同时打开除湿机吗？", {
        stopReason: "stop",
      }),

      // Case 3: Ambiguous / clarification turn with zero mutating tools -> REPLIES!
      fauxAssistantMessage("洗衣机准备就绪，请问选择智洗烘还是快洗？", { stopReason: "stop" }),

      // Case 4: LLM outputs [SILENT] after set_device_power, BUT verification catches state mismatch -> RECOVERS & REPLIES!
      fauxAssistantMessage(
        [fauxToolCall("set_device_power", { target: "demo-light-living", state: "off" })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("[SILENT]", { stopReason: "stop" }),
      // Round 1 recovery from LLM succeeds
      fauxAssistantMessage(
        [fauxToolCall("set_device_power", { target: "demo-light-living", state: "off" })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("客厅吸顶灯已重新关闭。", { stopReason: "stop" }),
    ]);

    const h = createHarness({
      service,
      customModel: faux.getModel(),
      customStreamFn: (m, ctx, opts) => faux.provider.streamSimple(m, ctx, opts),
    });

    try {
      await h.ready();
      const spoken: string[] = [];
      h.agent.on("speakChunk", (c) => spoken.push(c.text));

      // Case 1 -> SILENT
      const r1 = await h.agent.prompt("把客厅吸顶灯调暗一点", { source: "voice" });
      expect(r1.ok).toBe(true);
      expect(r1.silentCompleted).toBe(true);
      expect(r1.reply).toBe("");
      expect(r1.verification?.status).toBe("passed");
      expect(spoken).toEqual(["好的"]);

      // Case 2 -> LLM asks user question -> NOT silent!
      spoken.length = 0;
      const r2 = await h.agent.prompt("打开客厅吸顶灯", { source: "voice" });
      expect(r2.ok).toBe(true);
      expect(r2.silentCompleted).toBeUndefined();
      expect(r2.reply).toContain("需要同时打开除湿机吗");
      expect(spoken.length).toBe(2);
      expect(spoken[1]).toContain("除湿机");

      // Case 3 -> Clarification question without mutating tool -> NOT silent!
      spoken.length = 0;
      const r3 = await h.agent.prompt("帮我洗一下衣服", { source: "voice" });
      expect(r3.ok).toBe(true);
      expect(r3.silentCompleted).toBeUndefined();
      expect(r3.reply).toContain("智洗烘");
      expect(spoken.length).toBe(2);

      // Case 4 -> LLM returned [SILENT], but state check caught mismatch -> retries & replies!
      spoken.length = 0;
      await origSetPower("demo-light-living", true);
      dropLivingPowerOnce = true;
      const r4 = await h.agent.prompt("关闭客厅吸顶灯", { source: "voice" });
      expect(r4.ok).toBe(true);
      expect(r4.silentCompleted).toBeUndefined();
      expect(r4.retriesUsed).toBe(1);
      expect(r4.verification?.status).toBe("recovered");
      expect(r4.reply).toContain("状态检查已通过");
      expect(spoken[0]).toBe("好的");
      expect(spoken.some((s) => s.includes("第1次重试"))).toBe(true);
      expect(spoken[spoken.length - 1]).toContain("状态检查已通过");
    } finally {
      await h.cleanup();
    }
  });

  test("HTTP /api/agent/prompt & /api/agent/config expose silentCompleted (default on) and allow explicit opt-out", async () => {
    expect(defaultAgentVoiceConfig().silentSimpleControlReply).toBe(true);
    expect(loadAgentVoiceConfig().silentSimpleControlReply).toBe(true);

    server = await startMijiaDeckServer({
      mode: "demo",
      port: 0,
      autoStartTimers: false,
    });

    // 1. Default ON: simple light control returns silentCompleted: true, reply: ""
    const res1 = await fetch(`${server.url}/api/agent/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "关闭客厅吸顶灯", source: "text" }),
    });
    expect(res1.status).toBe(200);
    const j1 = (await res1.json()) as any;
    expect(j1.ok).toBe(true);
    expect(j1.ack).toBe("好的");
    expect(j1.silentCompleted).toBe(true);
    expect(j1.reply).toBe("");
    expect(j1.verification?.status).toBe("passed");
    const lastEntry = j1.agent.timeline[j1.agent.timeline.length - 1];
    expect(lastEntry.silentCompleted).toBe(true);
    expect(lastEntry.text).toBe("");

    // 2. Abnormal state still replies clearly via HTTP API
    const resErr = await fetch(`${server.url}/api/agent/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "把餐厅主灯调暗一点", source: "text" }),
    });
    expect(resErr.status).toBe(200);
    const jErr = (await resErr.json()) as any;
    expect(jErr.silentCompleted).toBeUndefined();
    expect(jErr.verification?.status).toBe("unsolvable");
    expect(jErr.reply).toContain("不支持亮度调节");

    // 3. Explicit config opt-out restores verbose confirmation replies & persists
    const cfgRes = await fetch(`${server.url}/api/agent/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ silentSimpleControlReply: false }),
    });
    expect(cfgRes.status).toBe(200);
    expect(((await cfgRes.json()) as any).config.silentSimpleControlReply).toBe(false);
    expect(loadAgentVoiceConfig().silentSimpleControlReply).toBe(false);

    const res2 = await fetch(`${server.url}/api/agent/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "打开客厅吸顶灯", source: "text" }),
    });
    expect(res2.status).toBe(200);
    const j2 = (await res2.json()) as any;
    expect(j2.ok).toBe(true);
    expect(j2.silentCompleted).toBeUndefined();
    expect(j2.reply).toContain("客厅吸顶灯");

    // Re-enable via updateAgentVoiceConfig
    expect(updateAgentVoiceConfig({ silentSimpleControlReply: true }).silentSimpleControlReply).toBe(true);
  });
});
