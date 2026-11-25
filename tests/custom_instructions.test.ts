// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 语音保存多条附加指令规则与冲突最新优先回归测试

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { saveAgentSkill } from "../src/agent/agentSkillStore.ts";
import {
  addCustomInstruction,
  buildCustomInstructionsPromptSection,
  clearCustomInstructions,
  deleteCustomInstruction,
  deleteCustomInstructionsByQuery,
  deleteLatestCustomInstruction,
  detectCustomInstructionConflicts,
  hasApplicableCustomInstructions,
  loadCustomInstructions,
  parseCustomInstructionVoiceIntent,
  resolveLightDefaultPreferenceFromRules,
  resolveWasherDefaultProgramFromRules,
  setCustomInstructionEnabled,
  updateCustomInstruction,
} from "../src/agent/customInstructionStore.ts";
import { planDeterministicLocalCalls } from "../src/agent/localPlannerStream.ts";
import { PiAgentService } from "../src/agent/piAgentService.ts";
import { evaluateVoiceAttention } from "../src/agent/voiceAttentionGate.ts";
import { VoiceListenerController } from "../src/agent/voiceListenerController.ts";
import { updateAgentVoiceConfig } from "../src/core/agentConfigStore.ts";
import { NetworkMonitor } from "../src/core/availability.ts";
import type { IMijiaService } from "../src/core/contracts.ts";
import { JobExecutor } from "../src/core/jobs.ts";
import { setDataPathOverrides } from "../src/core/jsonStore.ts";
import { createDeviceInfo, type DeviceDetail } from "../src/core/models.ts";
import * as settingsStore from "../src/core/settingsStore.ts";
import { VirtualDemoService } from "../src/core/virtualLightService.ts";
import { startMijiaDeckServer } from "../src/server/server.ts";
import { MainWindowController } from "../src/ui/controllers/mainWindowController.ts";
import { ThemeController, applyTheme } from "../src/ui/theme.ts";

let tmpDir = "";

function createTestHarness(options: {
  service?: IMijiaService;
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

  let broadcasts = 0;
  const agent = new PiAgentService({
    deps: {
      service,
      jobs,
      mainWindow,
      settingsStore,
      broadcastState: () => {
        broadcasts += 1;
      },
    },
    ...(options.customStreamFn ? { customStreamFn: options.customStreamFn } : {}),
    ...(options.customModel ? { customModel: options.customModel } : {}),
  });

  return {
    service,
    jobs,
    mainWindow,
    agent,
    getBroadcasts: () => broadcasts,
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

function createWasherAndAcService(): {
  service: IMijiaService;
  writtenProps: Array<{ did: string; prop: string; value: unknown }>;
  ranActions: Array<{ did: string; action: string; params: unknown[] }>;
} {
  const writtenProps: Array<{ did: string; prop: string; value: unknown }> = [];
  const ranActions: Array<{ did: string; action: string; params: unknown[] }> = [];
  const stateValues: Record<string, Record<string, unknown>> = {
    "midea:washer-1": {
      on: true,
      "running-status": "standby",
      program: "mix",
    },
    "midea:ac-1": {
      on: false,
      mode: "cool",
      "target-temperature": 26,
    },
  };

  const washerDev = createDeviceInfo({
    did: "midea:washer-1",
    name: "美的洗烘一体机",
    model: "midea.washer.d9",
    home_name: "家",
    room_name: "阳台",
    online: true,
    platform: "midea",
    spec_type: "urn:midea-spec:device:washing-machine:00000001:midea-d9:1",
  });
  const acDev = createDeviceInfo({
    did: "midea:ac-1",
    name: "客厅空调",
    model: "midea.aircondition.ac",
    home_name: "家",
    room_name: "客厅",
    online: true,
    platform: "midea",
    spec_type: "urn:miot-spec-v2:device:air-conditioner:0000A004:midea-ac:1",
  });

  const details: Record<string, DeviceDetail> = {
    "midea:washer-1": {
      did: washerDev.did,
      name: washerDev.name,
      model: washerDev.model,
      props: [
        {
          name: "on",
          desc: "开关",
          type: "bool",
          readable: true,
          writable: true,
          range: null,
          value_list: null,
          service: "washer",
        },
        {
          name: "program",
          desc: "洗涤程序",
          type: "string",
          readable: true,
          writable: true,
          range: null,
          service: "washer",
          value_list: [
            { value: "mix", description: "Mix", desc_zh_cn: "混合洗" },
            { value: "smart_wash_dry", description: "Smart Wash & Dry", desc_zh_cn: "智洗烘" },
            { value: "fast_wash", description: "Fast Wash", desc_zh_cn: "快洗" },
          ],
        },
        {
          name: "running-status",
          desc: "运行状态",
          type: "string",
          readable: true,
          writable: false,
          range: null,
          value_list: null,
          service: "washer",
        },
      ],
      actions: [
        { name: "start-wash", desc: "开始洗涤", service: "washer" },
        { name: "pause-wash", desc: "暂停洗涤", service: "washer" },
      ],
    },
    "midea:ac-1": {
      did: acDev.did,
      name: acDev.name,
      model: acDev.model,
      props: [
        {
          name: "on",
          desc: "开关",
          type: "bool",
          readable: true,
          writable: true,
          range: null,
          value_list: null,
          service: "ac",
        },
        {
          name: "mode",
          desc: "模式",
          type: "string",
          readable: true,
          writable: true,
          range: null,
          value_list: null,
          service: "ac",
        },
        {
          name: "target-temperature",
          desc: "目标温度",
          type: "int",
          readable: true,
          writable: true,
          range: [16, 30, 1],
          value_list: null,
          service: "ac",
        },
      ],
      actions: [],
    },
  };

  const service: IMijiaService = {
    setControlAccess: () => {},
    apiVersion: () => "mock",
    accountId: () => "mock-account",
    logout: () => {},
    loginStatus: () => true,
    qrLoginBegin: async () => null,
    qrLoginWait: async () => {},
    listDevices: async () => [washerDev, acDev],
    sceneList: async () => [],
    runScene: async () => {},
    deviceDetail: async (did) => details[did]!,
    readProp: async (did, prop) => stateValues[did]?.[prop],
    readProps: async (did, props) => {
      const out: Record<string, unknown> = {};
      for (const p of props) out[p] = stateValues[did]?.[p];
      return out;
    },
    writeProp: async (did, prop, value) => {
      writtenProps.push({ did, prop, value });
      stateValues[did] = { ...(stateValues[did] ?? {}), [prop]: value };
    },
    runAction: async (did, action, params) => {
      const paramArr = Array.isArray(params) ? params : params !== undefined ? [params] : [];
      ranActions.push({ did, action, params: paramArr });
      if (action === "start-wash") {
        stateValues[did] = { ...(stateValues[did] ?? {}), "running-status": "start" };
      }
    },
    powerState: async (did) => Boolean(stateValues[did]?.on),
    powerStates: async (dids) => Object.fromEntries(dids.map((d) => [d, Boolean(stateValues[d]?.on)])),
    setPowerState: async (did, on) => {
      stateValues[did] = { ...(stateValues[did] ?? {}), on };
    },
    togglePower: async (did) => {
      const next = !stateValues[did]?.on;
      stateValues[did] = { ...(stateValues[did] ?? {}), on: next };
      return next;
    },
    readMetrics: async () => ({}),
    iconUrls: async () => ({}),
    iconFile: async () => null,
    hasProductPageName: () => false,
    cachedProductPageNames: () => ({}),
    productPageName: async () => null,
    specHasPublishedFunctions: () => true,
    localizedProductNames: () => ({}),
    prepareCameraSource: async () => null,
    recordDeviceObservation: () => {},
    deviceDiagnosticReport: async () => "{}",
  };

  return { service, writtenProps, ranActions };
}

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "mijiadeck-custom-inst-"));
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

describe("CustomInstructionStore: multi-rule persistence & latest-wins conflict resolution", () => {
  test("saves multiple rules with strictly increasing priority, deduplicates by bumping to latest, and resolves conflicts latest-first", () => {
    const r1 = addCustomInstruction({
      content: "洗衣默认用标准洗模式",
      source: "voice",
    });
    const r2 = addCustomInstruction({
      content: "以后我说打开空调你要自己判断室外温度，根据室外温度自动选择对应正确的模式和温度",
      source: "voice",
    });
    const r3 = addCustomInstruction({
      content: "洗衣默认用智洗烘模式",
      source: "voice",
    });

    expect(r1.created).toBe(true);
    expect(r2.created).toBe(true);
    expect(r3.created).toBe(true);
    expect(r1.rule.topic).toBe("洗衣机");
    expect(r2.rule.topic).toBe("空调");
    expect(r3.rule.topic).toBe("洗衣机");

    // r3 conflicts with r1 (both specify washer default program), NOT with r2 (AC)
    expect(r3.conflictingRules.map((r) => r.id)).toEqual([r1.rule.id]);

    const all = loadCustomInstructions();
    expect(all.length).toBe(3);
    expect(all[0]!.id).toBe(r3.rule.id);
    expect(all[1]!.id).toBe(r2.rule.id);
    expect(all[2]!.id).toBe(r1.rule.id);
    expect(all[0]!.priority).toBeGreaterThan(all[1]!.priority);
    expect(all[1]!.priority).toBeGreaterThan(all[2]!.priority);

    // Washer effective rule picks newest (智洗烘) over older (标准洗)
    expect(resolveWasherDefaultProgramFromRules(all)?.programKey).toBe("smart_wash_dry");

    // Conflict map flags r1 as overridden by r3, while r2 has no conflict
    const conflicts = detectCustomInstructionConflicts(all);
    expect(conflicts.get(r1.rule.id)?.overriddenById).toBe(r3.rule.id);
    expect(conflicts.has(r2.rule.id)).toBe(false);
    expect(conflicts.has(r3.rule.id)).toBe(false);

    // Disabling newest conflicting rule (r3) cleanly falls back to r1 (标准洗 -> mix)
    setCustomInstructionEnabled(r3.rule.id, false);
    expect(resolveWasherDefaultProgramFromRules()?.programKey).toBe("mix");

    // Re-saving exact duplicate of r1 bumps r1 to highest priority & re-enables
    setCustomInstructionEnabled(r3.rule.id, true);
    const bumped = addCustomInstruction({ content: "洗衣默认用标准洗模式", source: "voice" });
    expect(bumped.created).toBe(false);
    expect(bumped.bumped).toBe(true);
    expect(bumped.rule.id).toBe(r1.rule.id);
    expect(resolveWasherDefaultProgramFromRules()?.programKey).toBe("mix");
    expect(detectCustomInstructionConflicts(loadCustomInstructions()).get(r3.rule.id)?.overriddenById).toBe(
      r1.rule.id,
    );

    // Updating content bumps updated rule to latest
    const edited = updateCustomInstruction(r3.rule.id, { content: "洗衣默认用快洗模式" });
    expect(edited?.priority).toBeGreaterThan(bumped.rule.priority);
    expect(resolveWasherDefaultProgramFromRules()?.programKey).toBe("fast_wash");

    // Delete & clear helpers
    expect(deleteLatestCustomInstruction()?.id).toBe(r3.rule.id);
    expect(deleteCustomInstructionsByQuery("空调").length).toBe(1);
    expect(deleteCustomInstruction(r1.rule.id)?.id).toBe(r1.rule.id);
    expect(loadCustomInstructions().length).toBe(0);
    addCustomInstruction({ content: "测试规则一", source: "manual" });
    expect(clearCustomInstructions()).toBe(1);
    expect(loadCustomInstructions().length).toBe(0);
  });

  test("resolves multi-dimension light preferences without false conflicts while overriding same-dimension conflicts", () => {
    addCustomInstruction({ content: "打开客厅灯默认亮度30%", source: "voice" });
    addCustomInstruction({ content: "打开客厅灯默认用暖光", source: "voice" });
    addCustomInstruction({ content: "打开客厅灯默认亮度80%", source: "voice" });

    const all = loadCustomInstructions();
    const pref = resolveLightDefaultPreferenceFromRules("客厅吸顶灯", "客厅", all);
    expect(pref?.brightness).toBe(80); // latest brightness overrides 30%
    expect(pref?.temperaturePreset).toBe("warm"); // non-conflicting color temp still active

    const conflicts = detectCustomInstructionConflicts(all);
    // Brightness 30% rule is overridden; warm light rule is NOT conflicted
    expect(conflicts.size).toBe(1);
  });

  test("builds system prompt section with explicit recency order, conflict-override rule, and legacy extra fallback", () => {
    addCustomInstruction({ content: "洗衣默认用标准洗模式", source: "manual" });
    addCustomInstruction({ content: "洗衣默认用智洗烘模式", source: "voice" });
    addCustomInstruction({
      content: "以后我说打开空调你要自己判断室外温度，根据室外温度自动选择对应正确的模式和温度",
      source: "voice",
    });

    const section = buildCustomInstructionsPromptSection(
      loadCustomInstructions(),
      "我说晚安就关客厅灯",
    );
    expect(section).toContain("冲突裁决铁律");
    expect(section).toContain("最新 · 最高优先");
    expect(section).toContain("以后我说打开空调你要自己判断室外温度");
    expect(section).toContain("洗衣默认用智洗烘模式");
    expect(section).toContain("若与上方更新规则 #2 冲突，必须以 #2 为准");
    expect(section).toContain("优先级低于上方最新保存的附加指令规则");
    expect(section).toContain("我说晚安就关客厅灯");

    // Ordering check: AC (newest) appears before 智洗烘, which appears before 标准洗
    const idxAc = section.indexOf("以后我说打开空调");
    const idxSmart = section.indexOf("洗衣默认用智洗烘模式");
    const idxStd = section.indexOf("洗衣默认用标准洗模式");
    expect(idxAc).toBeGreaterThan(-1);
    expect(idxSmart).toBeGreaterThan(idxAc);
    expect(idxStd).toBeGreaterThan(idxSmart);
  });
});

describe("Voice intent parsing & VoiceAttentionGate for custom instruction rules", () => {
  test("parses user examples and natural rule management commands without misclassifying regular device controls", () => {
    const p1 = parseCustomInstructionVoiceIntent("以后记得洗衣默认用智洗烘模式");
    expect(p1).toEqual({
      kind: "save",
      content: "洗衣默认用智洗烘模式",
      rawText: "以后记得洗衣默认用智洗烘模式",
      topic: "洗衣机",
    });

    const p2 = parseCustomInstructionVoiceIntent(
      "以后我说打开空调你要自己判断室外温度，根据室外温度自动选择对应正确的模式和温度。",
    );
    expect(p2?.kind).toBe("save");
    if (p2?.kind === "save") {
      expect(p2.topic).toBe("空调");
      expect(p2.content).toContain("以后我说打开空调你要自己判断室外温度");
      expect(p2.content).toContain("根据室外温度自动选择对应正确的模式和温度");
    }

    const p3 = parseCustomInstructionVoiceIntent("记住，晚上十点以后客厅灯亮度不超过30%");
    expect(p3?.kind).toBe("save");
    if (p3?.kind === "save") {
      expect(p3.topic).toBe("灯光");
      expect(p3.content).toBe("晚上十点以后客厅灯亮度不超过30%");
    }

    const p4 = parseCustomInstructionVoiceIntent("保存一条附加指令：打开空调默认25度");
    expect(p4?.kind).toBe("save");
    if (p4?.kind === "save") {
      expect(p4.content).toBe("打开空调默认25度");
    }

    expect(parseCustomInstructionVoiceIntent("查看我保存的附加指令")?.kind).toBe("list");
    expect(parseCustomInstructionVoiceIntent("删除最新一条附加指令")?.kind).toBe("delete_latest");
    expect(parseCustomInstructionVoiceIntent("把刚才那条附加指令删掉")?.kind).toBe("delete_latest");
    expect(parseCustomInstructionVoiceIntent("删除关于洗衣的附加指令")).toEqual({
      kind: "delete_match",
      query: "洗衣",
    });
    expect(parseCustomInstructionVoiceIntent("清空所有附加指令")?.kind).toBe("clear");

    // Negative guards: ordinary commands & questions MUST NOT match
    expect(parseCustomInstructionVoiceIntent("打开空调")).toBeNull();
    expect(parseCustomInstructionVoiceIntent("把客厅吸顶灯亮度调到80%")).toBeNull();
    expect(parseCustomInstructionVoiceIntent("卧室现在温度和湿度多少")).toBeNull();
    expect(parseCustomInstructionVoiceIntent("我记得刚才关灯了")).toBeNull();
    expect(parseCustomInstructionVoiceIntent("以后会下雨吗")).toBeNull();
  });

  test("VoiceAttentionGate accepts short and long voice rule-saving utterances in wake-word, BGM, and continuous conversation modes", async () => {
    const wakeWords = ["小派", "Neo"];

    const resWake1 = await evaluateVoiceAttention({
      rawText: "小派，以后记得洗衣默认用智洗烘模式",
      wakeWordEnabled: true,
      wakeWords,
      attentionMode: "smart",
    });
    expect(resWake1.accept).toBe(true);
    expect(resWake1.command).toBe("以后记得洗衣默认用智洗烘模式");

    const resWake2 = await evaluateVoiceAttention({
      rawText:
        "小派，以后我说打开空调你要自己判断室外温度，根据室外温度自动选择对应正确的模式和温度。",
      wakeWordEnabled: true,
      wakeWords,
      attentionMode: "smart",
      acousticEvent: "<|BGM|>",
    });
    expect(resWake2.accept).toBe(true);
    expect(resWake2.command).toContain("以后我说打开空调你要自己判断室外温度");
    expect(resWake2.command).toContain("根据室外温度自动选择对应正确的模式和温度");

    // Continuous conversation (no wake word, 39 chars > old 36-char limit!)
    const resConv = await evaluateVoiceAttention({
      rawText:
        "以后我说打开空调你要自己判断室外温度，根据室外温度自动选择对应正确的模式和温度。",
      wakeWordEnabled: true,
      wakeWords,
      attentionMode: "smart",
      inConversation: true,
      dialogState: "conversation",
    });
    expect(resConv.accept).toBe(true);
    expect(resConv.stage).toBe("fast-followup");
    expect(resConv.command).toContain("根据室外温度自动选择对应正确的模式和温度");
  });
});

describe("End-to-end VoiceListenerController + PiAgentService integration", () => {
  test("saves multiple voice rules without accidentally controlling devices, and executes latest conflicting rule for washer & light", async () => {
    const mockIoT = createWasherAndAcService();
    const h = createTestHarness({ service: mockIoT.service });
    const voice = new VoiceListenerController(h.agent);
    try {
      await h.ready();

      // 1. Voice-save older washer rule
      const v1 = await voice.handleTranscript("小派，以后记得洗衣默认用标准洗模式", {
        isFinal: true,
      });
      expect(v1.ok).toBe(true);
      expect(v1.matched).toBe(true);
      expect(v1.toolCalls?.[0]?.name).toBe("save_custom_instruction");
      expect(mockIoT.writtenProps.length).toBe(0);
      expect(mockIoT.ranActions.length).toBe(0);

      // 2. Voice-save newer conflicting washer rule (智洗烘)
      const v2 = await voice.handleTranscript("小派，以后记得洗衣默认用智洗烘模式", {
        isFinal: true,
      });
      expect(v2.ok).toBe(true);
      expect(v2.matched).toBe(true);
      expect(v2.toolCalls?.[0]?.name).toBe("save_custom_instruction");

      // 3. Voice-save long multi-clause AC rule (must NOT split on comma and turn on AC!)
      const v3 = await voice.handleTranscript(
        "小派，以后我说打开空调你要自己判断室外温度，根据室外温度自动选择对应正确的模式和温度。",
        { isFinal: true },
      );
      expect(v3.ok).toBe(true);
      expect(v3.matched).toBe(true);
      expect(v3.toolCalls?.length).toBe(1);
      expect(v3.toolCalls?.[0]?.name).toBe("save_custom_instruction");
      expect(await mockIoT.service.powerState("midea:ac-1")).toBe(false);

      const saved = h.agent.snapshot().customInstructions;
      expect(saved.length).toBe(3);
      expect(saved.every((r) => r.source === "voice")).toBe(true);
      expect(saved[0]!.topic).toBe("空调");
      expect(saved[1]!.content).toBe("洗衣默认用智洗烘模式");
      expect(saved[2]!.content).toBe("洗衣默认用标准洗模式");

      // 4. Starting laundry now applies NEWEST rule: smart_wash_dry!
      const washRes = await h.agent.prompt("开始洗衣服", { source: "voice" });
      expect(washRes.ok).toBe(true);
      expect(mockIoT.writtenProps.some((w) => w.prop === "program" && w.value === "smart_wash_dry")).toBe(
        true,
      );
      expect(mockIoT.ranActions.some((a) => a.action === "start-wash")).toBe(true);

      // 5. Delete newest washer rule by voice -> falls back to older 标准洗 (mix)
      const delRes = await voice.handleTranscript("小派，删除关于智洗烘的附加指令", {
        isFinal: true,
      });
      expect(delRes.ok).toBe(true);
      expect(delRes.toolCalls?.[0]?.name).toBe("delete_custom_instruction");

      mockIoT.writtenProps.length = 0;
      const washRes2 = await h.agent.prompt("开始洗衣服", { source: "voice" });
      expect(washRes2.ok).toBe(true);
      expect(mockIoT.writtenProps.some((w) => w.prop === "program" && w.value === "mix")).toBe(true);

      // 6. List instructions by voice
      const listRes = await voice.handleTranscript("小派，查看我保存的附加指令", {
        isFinal: true,
      });
      expect(listRes.ok).toBe(true);
      expect(listRes.toolCalls?.[0]?.name).toBe("list_custom_instructions");
      expect(listRes.reply).toContain("2条附加指令");
    } finally {
      voice.dispose();
      await h.cleanup();
    }
  });

  test("applies latest light default rule in local mode when turning on living room light", async () => {
    const h = createTestHarness();
    try {
      await h.ready();
      await h.agent.prompt("以后记得打开客厅灯默认亮度30%", { source: "voice" });
      await h.agent.prompt("以后记得打开客厅灯默认亮度80%", { source: "voice" });

      const res = await h.agent.prompt("打开客厅吸顶灯", { source: "voice" });
      expect(res.ok).toBe(true);
      expect(await h.service.readProp("demo-light-living", "brightness")).toBe(80);
    } finally {
      await h.cleanup();
    }
  });

  test("injects newest-first custom instructions into Cloud LLM prompt, bypasses local fast-path & stale skills when applicable", async () => {
    const faux = fauxProvider({
      models: [{ id: "faux-custom-inst-1", name: "Faux Custom Inst LLM" }],
    });
    let capturedSystemPrompt = "";
    const wrappedStreamFn: ConstructorParameters<typeof PiAgentService>[0]["customStreamFn"] = (
      model,
      context,
      options,
    ) => {
      const sysMsg = context.messages.find((m) => m.role === "system");
      if (sysMsg && typeof sysMsg.content === "string") {
        capturedSystemPrompt = sysMsg.content;
      }
      return faux.provider.streamSimple(model, context, options);
    };

    const mockIoT = createWasherAndAcService();
    const h = createTestHarness({
      service: mockIoT.service,
      customModel: faux.getModel(),
      customStreamFn: wrappedStreamFn,
    });

    try {
      await h.ready();
      // Enable preferLocalIntents to prove applicable custom instructions defer to Cloud LLM
      const cfg = updateAgentVoiceConfig({
        provider: "deepseek",
        apiKey: "sk-test-custom-inst",
        preferLocalIntents: true,
      });
      h.agent.reconfigure(cfg);

      // Seed an older cached Skill for "打开空调" BEFORE adding the newer custom instruction rule
      saveAgentSkill({
        name: "打开客厅空调",
        description: "旧技能：直接开空调",
        triggerText: "打开空调",
        targetDids: ["midea:ac-1"],
        pitfall: "旧排错沉淀",
        resolutionSummary: "直接打开",
        steps: [{ toolName: "set_device_power", args: { target: "midea:ac-1", state: "on" } }],
      });
      await Bun.sleep(15);

      // Cloud LLM calls save_custom_instruction when user speaks a rule
      faux.setResponses([
        fauxAssistantMessage(
          [
            fauxToolCall("save_custom_instruction", {
              content: "以后我说打开空调你要自己判断室外温度，根据室外温度自动选择对应正确的模式和温度",
              topic: "空调",
            }),
          ],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("已记住空调自动温控规则。", { stopReason: "stop" }),
      ]);

      const saveRes = await h.agent.prompt(
        "以后我说打开空调你要自己判断室外温度，根据室外温度自动选择对应正确的模式和温度。",
        { source: "voice" },
      );
      expect(saveRes.ok).toBe(true);
      expect(saveRes.toolCalls.some((t) => t.name === "save_custom_instruction")).toBe(true);
      expect(h.agent.listCustomInstructions().length).toBe(1);

      // Verify preferLocalIntents returns null for "打开空调" because an AC custom instruction applies
      expect(
        hasApplicableCustomInstructions("打开空调", h.agent.listCustomInstructions()),
      ).toBe(true);
      expect(
        planDeterministicLocalCalls("打开空调", {
          getDevices: () => h.mainWindow.activeDevices(),
          getScenes: () => [],
          getCustomInstructions: () => h.agent.listCustomInstructions(),
        }),
      ).toBeNull();

      // Now user says "打开空调" -> stale old Skill MUST be skipped and Cloud LLM receives the saved rule in systemPrompt!
      faux.setResponses([
        fauxAssistantMessage(
          [
            fauxToolCall("set_device_power", { target: "midea:ac-1", state: "on" }),
            fauxToolCall("set_device_property", { target: "midea:ac-1", property: "mode", value: "heat" }),
            fauxToolCall("set_device_property", {
              target: "midea:ac-1",
              property: "target-temperature",
              value: 24,
            }),
          ],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("已根据室外温度开启客厅空调制热 24°C。", { stopReason: "stop" }),
      ]);

      const acRes = await h.agent.prompt("打开空调", { source: "voice" });
      expect(acRes.ok).toBe(true);
      expect(acRes.skillEvent).toBeUndefined(); // Stale skill was NOT blindly replayed
      expect(capturedSystemPrompt).toContain("冲突裁决铁律");
      expect(capturedSystemPrompt).toContain("以后我说打开空调你要自己判断室外温度");
      expect(
        mockIoT.writtenProps.some((w) => w.prop === "target-temperature" && w.value === 24),
      ).toBe(true);
    } finally {
      await h.cleanup();
    }
  });
});

describe("HTTP REST API /api/agent/instructions", () => {
  test("supports full CRUD, voice-prefix normalization, conflict reporting, and clear", async () => {
    const srv = await startMijiaDeckServer({
      mode: "demo",
      port: 0,
      hostname: "127.0.0.1",
      autoStart: true,
      autoStartTimers: false,
    });
    try {
      const r1 = await fetch(`${srv.url}/api/agent/instructions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: "以后记得洗衣默认用标准洗模式",
          source: "voice",
        }),
      });
      const d1 = (await r1.json()) as {
        ok: boolean;
        rule: { id: string; content: string; source: string; topic: string };
      };
      expect(r1.status).toBe(200);
      expect(d1.ok).toBe(true);
      expect(d1.rule.content).toBe("洗衣默认用标准洗模式");
      expect(d1.rule.source).toBe("voice");
      expect(d1.rule.topic).toBe("洗衣机");

      const r2 = await fetch(`${srv.url}/api/agent/instructions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: "以后记得洗衣默认用智洗烘模式",
          source: "voice",
        }),
      });
      const d2 = (await r2.json()) as {
        ok: boolean;
        rule: { id: string; content: string };
        conflictingRules: Array<{ id: string }>;
        conflicts: Record<string, { overriddenById: string }>;
        instructions: Array<{ id: string }>;
      };
      expect(d2.ok).toBe(true);
      expect(d2.rule.content).toBe("洗衣默认用智洗烘模式");
      expect(d2.conflictingRules.map((x) => x.id)).toEqual([d1.rule.id]);
      expect(d2.conflicts[d1.rule.id]?.overriddenById).toBe(d2.rule.id);
      expect(d2.instructions[0]!.id).toBe(d2.rule.id);

      // Toggle disable newest -> conflict disappears
      const rToggle = await fetch(
        `${srv.url}/api/agent/instructions/${encodeURIComponent(d2.rule.id)}/toggle`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: false }),
        },
      );
      const dToggle = (await rToggle.json()) as {
        ok: boolean;
        rule: { enabled: boolean };
        conflicts: Record<string, unknown>;
      };
      expect(dToggle.ok).toBe(true);
      expect(dToggle.rule.enabled).toBe(false);
      expect(Object.keys(dToggle.conflicts).length).toBe(0);

      // Delete one & clear remaining
      const rDel = await fetch(
        `${srv.url}/api/agent/instructions/${encodeURIComponent(d2.rule.id)}/delete`,
        { method: "POST" },
      );
      expect((await rDel.json()).deleted).toBe(true);

      const rGet = await fetch(`${srv.url}/api/agent/instructions`);
      const dGet = (await rGet.json()) as { ok: boolean; instructions: Array<{ id: string }> };
      expect(dGet.instructions.length).toBe(1);
      expect(dGet.instructions[0]!.id).toBe(d1.rule.id);

      const rClear = await fetch(`${srv.url}/api/agent/instructions/clear`, { method: "POST" });
      const dClear = (await rClear.json()) as { ok: boolean; cleared: number; instructions: unknown[] };
      expect(dClear.ok).toBe(true);
      expect(dClear.cleared).toBe(1);
      expect(dClear.instructions.length).toBe(0);
    } finally {
      await srv.stop();
    }
  });
});
