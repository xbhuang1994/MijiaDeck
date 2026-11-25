// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: Pi Agent 融合系统提示词与 5 项代码微增强回归测试

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { loadAgentSkills } from "../src/agent/agentSkillStore.ts";
import { buildCavemanPromptBlock } from "../src/agent/cavemanReplyPolicy.ts";
import {
  formatLocalTimeContext,
  PiAgentService,
} from "../src/agent/piAgentService.ts";
import { createSmartHomeTools } from "../src/agent/smartHomeTools.ts";
import { classifyToolError } from "../src/agent/taskVerificationLoop.ts";
import { NetworkMonitor } from "../src/core/availability.ts";
import { JobExecutor } from "../src/core/jobs.ts";
import { setDataPathOverrides } from "../src/core/jsonStore.ts";
import { createDeviceInfo } from "../src/core/models.ts";
import * as settingsStore from "../src/core/settingsStore.ts";
import { VirtualDemoService } from "../src/core/virtualLightService.ts";
import { MainWindowController } from "../src/ui/controllers/mainWindowController.ts";
import { applyTheme, ThemeController } from "../src/ui/theme.ts";

let tmpDir = "";

function createHarness(options: {
  service?: VirtualDemoService;
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

  const deps = {
    service,
    jobs,
    mainWindow,
    settingsStore,
    broadcastState: () => {},
  };

  const agent = new PiAgentService({
    deps,
    ...(options.customStreamFn ? { customStreamFn: options.customStreamFn } : {}),
    ...(options.customModel ? { customModel: options.customModel } : {}),
  });

  return {
    service,
    jobs,
    mainWindow,
    deps,
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
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "mijiadeck-prompt-guards-"));
  setDataPathOverrides({
    dataDir: () => tmpDir,
    dataFile: (name: string) => path.join(tmpDir, name),
  });
});

afterEach(() => {
  setDataPathOverrides(null);
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = "";
  }
});

describe("Pi Agent Merged Prompt & Context Micro-Enhancements (#3 & #4)", () => {
  test("formatLocalTimeContext formats date, time, weekday, and coarse period accurately", () => {
    expect(formatLocalTimeContext(new Date(2026, 10, 25, 2, 15))).toBe(
      "当前本地时间：2026-11-25 02:15（周三，凌晨）",
    );
    expect(formatLocalTimeContext(new Date(2026, 10, 25, 7, 5))).toBe(
      "当前本地时间：2026-11-25 07:05（周三，清晨）",
    );
    expect(formatLocalTimeContext(new Date(2026, 10, 25, 10, 30))).toBe(
      "当前本地时间：2026-11-25 10:30（周三，上午）",
    );
    expect(formatLocalTimeContext(new Date(2026, 10, 25, 12, 45))).toBe(
      "当前本地时间：2026-11-25 12:45（周三，中午）",
    );
    expect(formatLocalTimeContext(new Date(2026, 10, 25, 15, 0))).toBe(
      "当前本地时间：2026-11-25 15:00（周三，下午）",
    );
    expect(formatLocalTimeContext(new Date(2026, 10, 25, 20, 20))).toBe(
      "当前本地时间：2026-11-25 20:20（周三，晚上）",
    );
    expect(formatLocalTimeContext(new Date(2026, 10, 25, 23, 50))).toBe(
      "当前本地时间：2026-11-25 23:50（周三，深夜）",
    );
  });

  test("merged system prompt keeps static core prefix & inventory catalog free of volatile clock/state, omits scenes when disabled, and adds multi-home & >80 truncation hints", async () => {
    const h = createHarness();
    try {
      await h.ready();
      const singleHomePrompt = h.agent.agent.state.systemPrompt;

      // Static core sections present
      expect(singleHomePrompt).toContain("## 一、执行、寻址与语音消歧");
      expect(singleHomePrompt).toContain("## 二、跨平台分品类控制铁律");
      expect(singleHomePrompt).toContain("## 三、作息编排、定时与全屋巡检");
      expect(singleHomePrompt).toContain("## 四、物理安全、权限与隐私防线");
      expect(singleHomePrompt).toContain("## 五、宿主闭环、自愈协议与播报规范");
      expect(singleHomePrompt).toContain("confirm_dangerous: true");
      expect(singleHomePrompt).not.toContain("当前手动场景：");

      // KV-cache prefix order: static rules precede static Reply Style and static device inventory;
      // volatile minute-level clock must NOT be embedded in messages[0] (moved to per-turn <runtime_context>)
      const idxRulesEnd = singleHomePrompt.indexOf("## 五、宿主闭环、自愈协议与播报规范");
      const idxReplyStyle = singleHomePrompt.indexOf("Reply Style");
      const idxCatalog = singleHomePrompt.indexOf("当前设备清单：");
      expect(idxRulesEnd).toBeGreaterThan(0);
      expect(idxReplyStyle).toBeGreaterThan(idxRulesEnd);
      expect(idxCatalog).toBeGreaterThan(idxReplyStyle);
      expect(singleHomePrompt).not.toContain("当前本地时间：");

      // Single home stays compact without redundant per-device home column
      expect(singleHomePrompt).not.toContain("| 家庭:");

      // Multi-home + >80 devices triggers per-device `家庭:` column and truncation notice
      const manyDevices = Array.from({ length: 85 }, (_, i) =>
        createDeviceInfo({
          did: `dev_${i + 1}`,
          name: `测试灯${i + 1}`,
          model: "yeelink.light.lamp1",
          home_name: i % 2 === 0 ? "方寸别院" : "红泥的家",
          room_name: "客厅",
          online: true,
        }),
      );
      h.mainWindow.applyDevices(manyDevices);

      // Trigger fresh system prompt assembly via a fast zero-tool faux LLM call
      let capturedSystem = "";
      let capturedUser = "";
      const faux = fauxProvider({ models: [{ id: "faux-prompt-check", name: "Faux Prompt Check" }] });
      faux.setResponses([fauxAssistantMessage("ok", { stopReason: "stop" })]);
      const h2 = createHarness({
        customModel: faux.getModel(),
        customStreamFn: (m, ctx, opts) => {
          const sysMsg = ctx.messages.find((msg) => msg.role === "system");
          if (sysMsg) {
            capturedSystem = typeof sysMsg.content === "string" ? sysMsg.content : "";
          }
          const userMsg = [...ctx.messages].reverse().find((msg) => msg.role === "user");
          if (userMsg) {
            capturedUser =
              typeof userMsg.content === "string"
                ? userMsg.content
                : userMsg.content
                    .filter((b): b is { type: "text"; text: string } => b.type === "text")
                    .map((b) => b.text)
                    .join("\n");
          }
          return faux.provider.streamSimple(m, ctx, opts);
        },
      });
      try {
        h2.mainWindow.loggedOut = false;
        h2.mainWindow.networkOnline = true;
        h2.mainWindow.applyDevices(manyDevices);
        await h2.agent.prompt("设备盘点");
        expect(capturedSystem).toContain("当前设备清单（已展示前 80 / 共 85 台，其余请用 list_devices 筛选）：");
        expect(capturedSystem).toContain("| 家庭:方寸别院 |");
        expect(capturedSystem).toContain("| 家庭:红泥的家 |");
        expect(capturedSystem).not.toContain("当前本地时间：");
        expect(capturedUser).toContain("<runtime_context>");
        expect(capturedUser).toContain("当前本地时间：");
        expect(capturedUser).toContain("设备盘点");
      } finally {
        await h2.cleanup();
      }
    } finally {
      await h.cleanup();
    }
  });

  test("lite caveman prompt block drops leading '好的，' and 'Sure,' to prevent double-ack with TASK_ACK_TEXT", () => {
    const litePrompt = buildCavemanPromptBlock("lite", { isVoice: true });
    expect(litePrompt).toContain("客厅吸顶灯已经打开，亮度调到80%了。");
    expect(litePrompt).not.toContain("好的，");
    expect(litePrompt).not.toContain("Sure, ");
  });
});

describe("Cloud Recovery [UNSOLVABLE] Read-Only Fix (#1) & Unsolvable Regex Expansion (#2)", () => {
  test("recovery round calling read-only get_device_detail then [UNSOLVABLE] stops cleanly as unsolvable without fake pass or skill pollution", async () => {
    const service = new VirtualDemoService();
    const origWriteProp = service.writeProp.bind(service);
    service.writeProp = async (did: string, name: string, value: unknown) => {
      if (did === "demo-light-living" && name === "brightness") {
        // Silently drop write so Round 0 verification triggers cloud recovery
        return;
      }
      return origWriteProp(did, name, value);
    };

    const faux = fauxProvider({
      models: [{ id: "faux-readonly-unsolvable", name: "Faux ReadOnly Unsolvable" }],
    });
    faux.setResponses([
      // Round 0: LLM attempts brightness change
      fauxAssistantMessage(
        [fauxToolCall("control_light", { target: "客厅吸顶灯", brightness: 85 })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("客厅吸顶灯亮度已调到85%。", { stopReason: "stop" }),
      // Round 1 recovery: LLM inspects device detail (read-only) first, then determines unsolvable!
      fauxAssistantMessage(
        [fauxToolCall("get_device_detail", { target: "demo-light-living" })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("[UNSOLVABLE] 客厅吸顶灯当前硬件锁死，无法调节亮度。", {
        stopReason: "stop",
      }),
    ]);

    const h = createHarness({
      service,
      customModel: faux.getModel(),
      customStreamFn: (m, ctx, opts) => faux.provider.streamSimple(m, ctx, opts),
    });
    try {
      await h.ready();
      const res = await h.agent.prompt("把客厅吸顶灯亮度调到85%");
      expect(res.verification?.passed).toBe(false);
      expect(res.verification?.status).toBe("unsolvable");
      expect(res.verification?.solvable).toBe(false);
      expect(res.retriesUsed).toBe(0);
      expect(res.skillEvent).toBeUndefined();
      expect(loadAgentSkills().length).toBe(0);
      expect(res.reply).toContain("客厅吸顶灯当前硬件锁死，无法调节亮度");
      expect(res.reply).not.toContain("[UNSOLVABLE]");
    } finally {
      await h.cleanup();
    }
  });

  test("classifyToolError immediately classifies IR audio unsupported, IR 2050, read-only inverter, non-speaker, missing speaker, and dangerous action confirmation as unsolvable", () => {
    const unsupportedSamples = [
      "音响为红外遥控音响，暂不支持绝对音量设置（请使用调大/调小音量）",
      "音响为红外遥控音响，暂不支持语音点歌、文本播报",
      "当前模式不支持该红外参数组合（红外码库无对应指令，错误码 2050）",
      "德业 Solarman V5 光伏逆变器当前仅支持只读遥测监控",
      "德业光伏逆变器不支持开关切换",
      "客厅电视不是音箱或红外音响设备，请改用对应设备控制工具",
      "音响不是小爱音箱，不支持转发小爱指令",
      "安全提示：客厅摄像机的「重启」属于高风险不可逆动作，暂未执行。请先向用户说明后果并获明确二次确认后，再携带 confirm_dangerous=true 调用。",
    ];
    for (const msg of unsupportedSamples) {
      const issue = classifyToolError("control_speaker", {}, msg, { isCloudLlm: true });
      expect(issue.code).toBe("unsupported_capability");
      expect(issue.solvable).toBe(false);
    }

    const notFoundSamples = [
      "未找到指定的小爱音箱：书房小爱",
      "未找到指定的音箱或红外音响：书房音响",
    ];
    for (const msg of notFoundSamples) {
      const issue = classifyToolError("control_speaker", {}, msg, { isCloudLlm: true });
      expect(issue.code).toBe("device_not_found");
      expect(issue.solvable).toBe(false);
    }
  });
});

describe("SmartHomeTools Safety & Anti-Silent-Fallback Guards (#5)", () => {
  test("run_device_action blocks dangerous actions without confirm_dangerous=true, allows them when confirmed, and leaves normal actions unaffected", async () => {
    const h = createHarness();
    const executedActions: Array<{ did: string; action: string; params?: unknown[] }> = [];
    const origRunAction = h.service.runAction.bind(h.service);
    h.service.runAction = async (did: string, action: string, params?: unknown[]) => {
      executedActions.push({ did, action, params });
      if (action === "reboot" || action === "reset-filter-life" || action === "format") {
        return;
      }
      return origRunAction(did, action, params);
    };

    try {
      await h.ready();
      const tools = createSmartHomeTools(h.deps);
      const runActTool = tools.find((t) => t.name === "run_device_action")!;

      // 1. Unconfirmed dangerous actions are blocked cleanly
      for (const dangerousAct of ["reboot", "reset-filter-life", "factory_reset", "format", "delete"]) {
        const blocked = await runActTool.execute("tc-block", {
          target: "demo-light-living",
          action: dangerousAct,
        });
        expect(blocked.isError).toBe(true);
        const text = blocked.content.map((c) => (c.type === "text" ? c.text : "")).join(" ");
        expect(text).toContain("安全提示");
        expect(text).toContain("暂未执行");
        expect(text).toContain("confirm_dangerous=true");
        expect((blocked.details as Record<string, unknown>).blockedDangerousAction).toBe(true);
      }
      expect(executedActions).toHaveLength(0);

      // 2. Confirmed dangerous action executes cleanly
      const confirmed = await runActTool.execute("tc-confirm", {
        target: "demo-light-living",
        action: "reboot",
        confirm_dangerous: true,
      });
      expect(confirmed.isError).toBeUndefined();
      expect(executedActions).toEqual([{ did: "demo-light-living", action: "reboot", params: undefined }]);

      // 3. Normal action (pet-food-out) executes without confirm_dangerous
      const normal = await runActTool.execute("tc-normal", {
        target: "demo-pet-feeder",
        action: "pet-food-out",
        params: [2],
      });
      expect(normal.isError).toBeUndefined();
      expect(executedActions).toHaveLength(2);
      expect(executedActions[1]?.action).toBe("pet-food-out");
    } finally {
      await h.cleanup();
    }
  });

  test("control_speaker and send_xiaoai_command refuse silent fallback when explicit target/speaker is offline, non-speaker, or missing", async () => {
    const h = createHarness();
    const speakerActions: Array<{ did: string; action: string }> = [];
    const speakerProps: Array<{ did: string; prop: string; val: unknown }> = [];
    const origRunAction = h.service.runAction.bind(h.service);
    const origWriteProp = h.service.writeProp.bind(h.service);
    h.service.runAction = async (did: string, action: string, params?: unknown[]) => {
      speakerActions.push({ did, action });
      if (did === "spk_living") return;
      return origRunAction(did, action, params);
    };
    h.service.writeProp = async (did: string, prop: string, val: unknown) => {
      speakerProps.push({ did, prop, val });
      if (did === "spk_living") return;
      return origWriteProp(did, prop, val);
    };

    try {
      h.mainWindow.loggedOut = false;
      h.mainWindow.networkOnline = true;
      const livingSpk = createDeviceInfo({
        did: "spk_living",
        name: "客厅小爱",
        model: "xiaomi.wifispeaker.l05b",
        home_name: "我的家",
        room_name: "客厅",
        online: true,
      });
      const bedroomSpkOffline = createDeviceInfo({
        did: "spk_bedroom",
        name: "卧室小爱",
        model: "xiaomi.wifispeaker.l05b",
        home_name: "我的家",
        room_name: "卧室",
        online: false,
      });
      const irAmp = createDeviceInfo({
        did: "tuya:ir_amp_1",
        name: "音响",
        model: "tuya.infrared_amplifier.demo",
        spec_type: "urn:tuya:device:amplifier:1",
        home_name: "我的家",
        room_name: "客厅",
        online: true,
        platform: "tuya",
      });
      const livingTv = createDeviceInfo({
        did: "tuya:ir_tv_1",
        name: "客厅电视",
        model: "tuya.infrared_tv.demo",
        spec_type: "urn:tuya:device:television:1",
        home_name: "我的家",
        room_name: "客厅",
        online: true,
        platform: "tuya",
      });
      h.mainWindow.applyDevices([livingSpk, bedroomSpkOffline, irAmp, livingTv]);

      const tools = createSmartHomeTools(h.deps);
      const controlSpeaker = tools.find((t) => t.name === "control_speaker")!;
      const sendXiaoAi = tools.find((t) => t.name === "send_xiaoai_command")!;

      // 1. Offline named speaker must NOT fall back to living room XiaoAi
      const offSpkRes = await controlSpeaker.execute("tc-off-1", {
        target: "卧室小爱",
        play_music: "雨声白噪音",
      });
      expect(offSpkRes.isError).toBe(true);
      expect(JSON.stringify(offSpkRes.content)).toContain("卧室小爱离线");

      const offXiaoAiRes = await sendXiaoAi.execute("tc-off-2", {
        speaker: "卧室小爱",
        text: "明天天气怎么样",
      });
      expect(offXiaoAiRes.isError).toBe(true);
      expect(JSON.stringify(offXiaoAiRes.content)).toContain("卧室小爱离线");

      // 2. Non-speaker device (TV in control_speaker, IR amplifier in send_xiaoai_command) must NOT fall back to XiaoAi
      const tvRes = await controlSpeaker.execute("tc-tv", {
        target: "客厅电视",
        volume_delta: 20,
      });
      expect(tvRes.isError).toBe(true);
      expect(JSON.stringify(tvRes.content)).toContain("不是音箱或红外音响设备");

      const irXiaoAiRes = await sendXiaoAi.execute("tc-ir-xiaoai", {
        speaker: "音响",
        text: "定明早七点闹钟",
      });
      expect(irXiaoAiRes.isError).toBe(true);
      expect(JSON.stringify(irXiaoAiRes.content)).toContain("不是小爱音箱");

      // 3. Missing/banned speaker must NOT fall back to XiaoAi
      const missingSpkRes = await controlSpeaker.execute("tc-miss-1", {
        target: "书房小爱",
        volume: 30,
      });
      expect(missingSpkRes.isError).toBe(true);
      expect(JSON.stringify(missingSpkRes.content)).toContain("未找到指定的音箱或红外音响");

      const missingXiaoAiRes = await sendXiaoAi.execute("tc-miss-2", {
        speaker: "书房小爱",
        text: "你好",
      });
      expect(missingXiaoAiRes.isError).toBe(true);
      expect(JSON.stringify(missingXiaoAiRes.content)).toContain("未找到指定的小爱音箱");

      // Living room XiaoAi was NEVER touched by any of the 6 invalid/offline calls!
      expect(speakerActions).toHaveLength(0);
      expect(speakerProps).toHaveLength(0);

      // 4. Omitting speaker/target still routes smoothly to the default online XiaoAi
      const defaultRes = await sendXiaoAi.execute("tc-default", {
        text: "明天天气怎么样",
      });
      expect(defaultRes.isError).toBeUndefined();
      expect(speakerActions).toEqual([{ did: "spk_living", action: "execute-text-directive" }]);
    } finally {
      await h.cleanup();
    }
  });
});
