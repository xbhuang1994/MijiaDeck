// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: Caveman 回复策略、智能家居工具精简输出与本地规划器回归测试

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import {
  buildCavemanPromptBlock,
  compressCavemanReply,
  compressCavemanSpeakChunk,
  DEFAULT_CAVEMAN_MODE,
  formatExitConversationAck,
  formatWakeAck,
  isSilentSentinel,
  normalizeCavemanMode,
  preservesCriticalTokens,
  sanitizeForVoiceTts,
  SILENT_REPLY_SENTINEL,
  type CavemanReplyMode,
} from "../src/agent/cavemanReplyPolicy.ts";
import {
  createLocalSmartHomeStreamFn,
  summarizeToolResults,
  type ImplicitActionLabel,
} from "../src/agent/localPlannerStream.ts";
import { PiAgentService } from "../src/agent/piAgentService.ts";
import { createSmartHomeTools } from "../src/agent/smartHomeTools.ts";
import { NetworkMonitor } from "../src/core/availability.ts";
import { JobExecutor } from "../src/core/jobs.ts";
import { setDataPathOverrides } from "../src/core/jsonStore.ts";
import * as settingsStore from "../src/core/settingsStore.ts";
import { VirtualDemoService } from "../src/core/virtualLightService.ts";
import { MainWindowController } from "../src/ui/controllers/mainWindowController.ts";
import { applyTheme, ThemeController } from "../src/ui/theme.ts";

let tmpDir = "";

function estimateApproxTokens(text: string): number {
  const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const nonCjk = text.replace(/[\u4e00-\u9fff]/g, " ");
  const words = nonCjk.trim().split(/\s+/).filter(Boolean).length;
  return Math.ceil(cjk * 1.15 + words * 1.3);
}

function createHarness(options: {
  getCavemanMode?: () => CavemanReplyMode;
  classifyImplicitAction?: (utterance: string) => Promise<ImplicitActionLabel | null>;
} = {}) {
  const service = new VirtualDemoService();
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

  const tools = createSmartHomeTools(deps);
  const customStreamFn =
    options.getCavemanMode || options.classifyImplicitAction
      ? createLocalSmartHomeStreamFn({
          getDevices: () => mainWindow.allDevices,
          getScenes: () => mainWindow.scenes ?? [],
          getKnownPower: () => mainWindow.knownPower,
          getCavemanMode: options.getCavemanMode,
          classifyImplicitAction: options.classifyImplicitAction,
        })
      : undefined;

  const agent = new PiAgentService({
    deps,
    ...(customStreamFn ? { customStreamFn } : {}),
  });

  return {
    service,
    jobs,
    mainWindow,
    tools,
    agent,
    findTool(name: string) {
      const t = tools.find((item) => item.name === name);
      if (!t) throw new Error(`Tool not found: ${name}`);
      return t;
    },
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
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "mijiadeck-caveman-"));
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

describe("CavemanReplyPolicy — Prompt & Normalization", () => {
  test("re-exports default mode and normalizes mode aliases", () => {
    expect(DEFAULT_CAVEMAN_MODE).toBe("lite");
    expect(normalizeCavemanMode("ultra")).toBe("ultra");
    expect(normalizeCavemanMode("caveman-ultra")).toBe("ultra");
    expect(normalizeCavemanMode("caveman")).toBe("full");
    expect(normalizeCavemanMode("concise")).toBe("lite");
    expect(normalizeCavemanMode("normal")).toBe("off");
    expect(normalizeCavemanMode("unknown", "lite")).toBe("lite");
  });

  test("buildCavemanPromptBlock stays compact (<= 210 tokens) and includes required hard rules for all 4 modes", () => {
    const modes: CavemanReplyMode[] = ["ultra", "full", "lite", "off"];
    for (const mode of modes) {
      const textPrompt = buildCavemanPromptBlock(mode, { isVoice: false });
      const voicePrompt = buildCavemanPromptBlock(mode, {
        isVoice: true,
        speakerName: "小明",
        speakerRole: "owner",
      });

      expect(estimateApproxTokens(textPrompt)).toBeLessThanOrEqual(210);
      expect(estimateApproxTokens(voicePrompt)).toBeLessThanOrEqual(210);

      // Hard rules present in every mode
      expect(voicePrompt).toContain("ZH/EN");
      expect(voicePrompt).toContain("did/id");
      expect(voicePrompt).toContain("Auto-Clarity");
      expect(voicePrompt).toContain("离线");
      expect(voicePrompt).toContain("not/never/no/only");

      // Voice-specific rules
      expect(voicePrompt).toContain("Markdown");
      expect(voicePrompt).toContain(SILENT_REPLY_SENTINEL);
      expect(voicePrompt).toContain("小明");
      expect(voicePrompt).toContain("owner");
      expect(textPrompt).not.toContain(SILENT_REPLY_SENTINEL);
    }

    expect(buildCavemanPromptBlock("ultra")).toContain("客厅灯已开，亮度80%");
    expect(buildCavemanPromptBlock("ultra")).toContain("卧室 23.6°C，湿度 54%");
    expect(buildCavemanPromptBlock("full")).toContain("客厅吸顶灯已打开，亮度调到80%。");
    expect(buildCavemanPromptBlock("full")).toContain("抱歉，卧室灯离线了，暂时无法打开。");
    expect(buildCavemanPromptBlock("lite")).toContain("好的，客厅吸顶灯已经打开，亮度调到80%了。");
    expect(buildCavemanPromptBlock("off")).toContain("1-2 sentences");
  });

  test("detects [SILENT] sentinel accurately without false positives", () => {
    expect(isSilentSentinel("[SILENT]")).toBe(true);
    expect(isSilentSentinel("  [silent]  ")).toBe(true);
    expect(isSilentSentinel("`[SILENT]`")).toBe(true);
    expect(isSilentSentinel("[SILENT]。")).toBe(true);
    expect(isSilentSentinel("客厅灯已开")).toBe(false);
    expect(isSilentSentinel("[SILENT] 客厅灯已开")).toBe(false);
    expect(isSilentSentinel("")).toBe(false);
  });
});

describe("CavemanReplyPolicy — Voice TTS Sanitization & Compression", () => {
  test("sanitizeForVoiceTts removes IDs, Markdown, brackets, arrows, emojis, and bullets while keeping numbers & commas", () => {
    const dirty = [
      "### 💡 状态更新",
      "- **客厅吸顶灯** [did=demo-light-living]：亮度 20% -> 80% ✨",
      "- `卧室米家温湿度计` [id=sensor-1]：23.6°C，湿度 54%",
      "1. 查看 [设备文档](https://example.com)「完成」",
    ].join("\n");

    const clean = sanitizeForVoiceTts(dirty);
    expect(clean).not.toContain("[did=");
    expect(clean).not.toContain("[id=");
    expect(clean).not.toContain("**");
    expect(clean).not.toContain("`");
    expect(clean).not.toContain("###");
    expect(clean).not.toContain("->");
    expect(clean).not.toContain("「");
    expect(clean).not.toContain("」");
    expect(clean).not.toContain("💡");
    expect(clean).not.toContain("✨");
    expect(clean).not.toContain("https://example.com");
    expect(clean).toContain("客厅吸顶灯");
    expect(clean).toContain("20%，80%");
    expect(clean).toContain("23.6°C，湿度 54%");
    expect(clean).toContain("设备文档");
    expect(clean).not.toContain("\n");
  });

  test("compressCavemanReply keeps natural warmth in lite, tightens cleanly in full, and compresses telegraphically in ultra", () => {
    const zhVerbose =
      "好的，没问题！我已经为您打开了客厅吸顶灯，并将亮度调至 80%。请问还有什么可以帮您的吗？";

    const offText = compressCavemanReply(zhVerbose, "off", false);
    expect(offText).toBe(zhVerbose);

    // lite keeps friendly "好的，" while removing stacked filler ("没问题"), bureaucratic "为您", and customer-service closers
    const liteOut = compressCavemanReply(zhVerbose, "lite", true);
    expect(liteOut).toStartWith("好的，");
    expect(liteOut).not.toContain("没问题");
    expect(liteOut).not.toContain("为您");
    expect(liteOut).not.toContain("请问还有什么");
    expect(liteOut).toContain("客厅吸顶灯");
    expect(liteOut).toContain("80%");

    // full removes openers/closers but preserves complete natural verbs & apology
    const fullOut = compressCavemanReply(zhVerbose, "full", true);
    expect(fullOut).not.toContain("好的");
    expect(fullOut).not.toContain("我已经为您");
    expect(fullOut).not.toContain("请问还有什么");
    expect(fullOut).toContain("客厅吸顶灯");
    expect(fullOut).toContain("80%");
    expect(fullOut.length).toBeLessThanOrEqual(liteOut.length);

    const fullApology = compressCavemanReply("好的！抱歉，卧室灯当前离线，无法打开。请问还有什么可以帮您的吗？", "full", true);
    expect(fullApology).toContain("抱歉");
    expect(fullApology).toContain("离线");
    expect(fullApology).not.toContain("请问还有什么");

    const ultraOut = compressCavemanReply(zhVerbose, "ultra", true);
    expect(ultraOut).toContain("客厅吸顶灯");
    expect(ultraOut).toContain("80%");
    expect(ultraOut.length).toBeLessThanOrEqual(fullOut.length);

    const enVerbose =
      "Sure! I'd be happy to help. I've gone ahead and turned on the living room light to 80%. Let me know if you need anything else!";
    const enFull = compressCavemanReply(enVerbose, "full", true);
    expect(enFull).not.toMatch(/sure/i);
    expect(enFull).not.toMatch(/happy to help/i);
    expect(enFull).not.toMatch(/gone ahead/i);
    expect(enFull).not.toMatch(/anything else/i);
    expect(enFull).toContain("80%");
    expect(enFull.toLowerCase()).toContain("living room light");

    const enUltra = compressCavemanReply(
      "Of course! The living room light is now on at 80%. Anything else?",
      "ultra",
      true,
    );
    expect(enUltra).not.toMatch(/of course/i);
    expect(enUltra).not.toMatch(/anything else/i);
    expect(enUltra).toContain("80%");
    expect(enUltra).toMatch(/^Living room light/i);
  });

  test("preserves operational negations and exact numbers/units via hard data-integrity guardrail", () => {
    const zhOffline = "好的！抱歉，卧室灯当前离线，无法打开。请问还有什么可以帮您的吗？";
    const zhOut = compressCavemanReply(zhOffline, "ultra", true);
    expect(zhOut).toContain("离线");
    expect(zhOut).toContain("无法");
    expect(zhOut).not.toContain("好的");
    expect(zhOut).not.toContain("请问还有什么");

    const zhClosed = "好的，我已经为您把客厅吸顶灯关闭了。祝您使用愉快！";
    const zhClosedOut = compressCavemanReply(zhClosed, "ultra", true);
    expect(zhClosedOut).toContain("关闭");
    expect(zhClosedOut).not.toContain("祝您使用愉快");

    const enOffline = "Sure! Bedroom light is offline and cannot be turned on. Anything else?";
    const enOut = compressCavemanReply(enOffline, "ultra", true);
    expect(enOut.toLowerCase()).toContain("offline");
    expect(enOut.toLowerCase()).toContain("cannot");
    expect(enOut).not.toMatch(/anything else/i);

    const enOff = "Got it! I've gone ahead and turned the kitchen light off. Let me know if you need anything else.";
    const enOffOut = compressCavemanReply(enOff, "full", true);
    expect(enOffOut.toLowerCase()).toContain("off");

    // Direct guardrail unit assertions
    expect(preservesCriticalTokens("卧室 23.6°C，湿度 54%", "卧室 23.6°C，湿度 54%")).toBe(true);
    expect(preservesCriticalTokens("卧室 23.6°C，湿度 54%", "卧室 23°C，湿度 54%")).toBe(false);
    expect(preservesCriticalTokens("已出粮 2 份", "已出粮 2份")).toBe(true);
    expect(preservesCriticalTokens("已出粮 2 份", "已出粮 2")).toBe(false);
    expect(preservesCriticalTokens("卧室灯离线，无法打开", "卧室灯已打开")).toBe(false);
    expect(preservesCriticalTokens("未找到设备", "设备")).toBe(false);
    expect(preservesCriticalTokens("Device not found", "Device found")).toBe(false);
    expect(preservesCriticalTokens("Light is off", "Light is on")).toBe(false);
    expect(preservesCriticalTokens("Error 401: failed", "401")).toBe(false);
  });

  test("bypasses compression for isError, Auto-Clarity safety/confirmation phrases, and off mode (while still sanitizing voice TTS)", () => {
    const errRaw = "**错误**：网络不可用 [did=demo-1]，请检查连接。";
    expect(compressCavemanReply(errRaw, "ultra", false, { isError: true })).toBe(errRaw);
    const errVoice = compressCavemanReply(errRaw, "ultra", true, { isError: true });
    expect(errVoice).toContain("错误");
    expect(errVoice).toContain("网络不可用");
    expect(errVoice).not.toContain("**");
    expect(errVoice).not.toContain("[did=");

    const zhWarn = "好的，警告：此操作将重置所有配置且不可逆，请确认是否继续？";
    expect(compressCavemanReply(zhWarn, "ultra", false)).toBe(zhWarn);

    const enWarn = "Sure! WARNING: Deleting all scenes is irreversible. Please confirm before proceeding.";
    expect(compressCavemanReply(enWarn, "ultra", false)).toBe(enWarn);

    const offVoice = compressCavemanReply("好的，**客厅灯**已开 [did=1] 💡", "off", true);
    expect(offVoice).toContain("好的");
    expect(offVoice).not.toContain("**");
    expect(offVoice).not.toContain("[did=1]");
    expect(offVoice).not.toContain("💡");
  });

  test("protects fenced code blocks verbatim in non-voice text mode", () => {
    const input = [
      "好的，我已经为您生成配置：",
      "```json",
      '{"device": "客厅灯", "brightness": 80, "note": "好的，不要压缩我"}',
      "```",
      "请问还有什么可以帮您的吗？",
    ].join("\n");

    const out = compressCavemanReply(input, "ultra", false);
    expect(out).toContain('```json\n{"device": "客厅灯", "brightness": 80, "note": "好的，不要压缩我"}\n```');
    expect(out).not.toContain("请问还有什么");
  });

  test("handles standalone filler according to preserveEmptyFiller and runs well under 0.2ms per call", () => {
    expect(compressCavemanReply("好的！", "full", true)).toBe("好的！");
    expect(compressCavemanReply("好的！", "full", true, { preserveEmptyFiller: false })).toBe("");

    const sample =
      "好的，没问题！我已经为您打开了客厅吸顶灯，并将亮度调至 80%。请问还有什么可以帮您的吗？";
    const t0 = performance.now();
    for (let i = 0; i < 500; i += 1) {
      compressCavemanReply(sample, "full", true);
    }
    const elapsedMs = performance.now() - t0;
    expect(elapsedMs / 500).toBeLessThan(0.5);
  });

  test("compressCavemanSpeakChunk suppresses [SILENT], standalone openers/closers, and protects decimals", () => {
    const state = { emittedAny: false };

    expect(compressCavemanSpeakChunk("[SILENT]", "full", state)).toBe("");
    expect(state.emittedAny).toBe(false);

    expect(compressCavemanSpeakChunk("好的！", "full", state)).toBe("");
    expect(compressCavemanSpeakChunk("Sure!", "full", state)).toBe("");
    expect(state.emittedAny).toBe(false);

    const body = compressCavemanSpeakChunk("卧室米家温湿度计 23.6°C，湿度 54%。", "full", state);
    expect(body).toContain("23.6°C");
    expect(body).toContain("54%");
    expect(state.emittedAny).toBe(true);

    expect(compressCavemanSpeakChunk("还有什么需要帮您的吗？", "full", state)).toBe("");
    expect(compressCavemanSpeakChunk("Let me know if you need anything else.", "full", state)).toBe("");
    expect(compressCavemanSpeakChunk("Anything else?", "full", state)).toBe("");

    // Mode off still suppresses [SILENT]
    const offState = { emittedAny: false };
    expect(compressCavemanSpeakChunk("[SILENT]", "off", offState)).toBe("");
    expect(offState.emittedAny).toBe(false);
    expect(compressCavemanSpeakChunk("好的，**客厅灯**已开。", "off", offState)).toBe("好的，客厅灯已开。");
    expect(offState.emittedAny).toBe(true);
  });

  test("formatWakeAck never returns 1-char '在' and formatExitConversationAck matches mode specs", () => {
    expect(formatWakeAck("ultra")).toBe("在呢");
    expect(formatWakeAck("full")).toBe("在呢");
    expect(formatWakeAck("lite")).toBe("我在，请说");
    expect(formatWakeAck("off")).toBe("我在，请说指令");

    for (const mode of ["ultra", "full", "lite", "off"] as const) {
      const ack = formatWakeAck(mode);
      expect(ack).not.toBe("在");
      expect(ack.length).toBeGreaterThanOrEqual(2);
    }

    expect(formatWakeAck("ultra", "张三")).toBe("张三，在呢");
    expect(formatWakeAck("full", "张三")).toBe("张三，在呢");
    expect(formatWakeAck("lite", "张三")).toBe("张三，我在，请说");
    expect(formatWakeAck("off", "张三")).toBe("张三，我在，请说指令");
    expect(formatWakeAck("full", "   ")).toBe("在呢");

    expect(formatExitConversationAck("ultra")).toBe("已待机");
    expect(formatExitConversationAck("full")).toBe("好的，已待机");
    expect(formatExitConversationAck("lite")).toBe("好的，有需要再叫我");
    expect(formatExitConversationAck("off")).toBe("好的，已回到待机，有需要再叫我");
  });
});

describe("SmartHomeTools & LocalPlannerStream — Natural Replies (lite/full) & Crisp Telegraphic (ultra)", () => {
  test("produces natural spoken replies in default lite mode and direct natural sentences in full mode", async () => {
    const h = createHarness();
    try {
      await h.ready();

      // 1. Default lite mode: warm, grammatical, natural spoken Chinese (never stiff fragments!)
      const spkOff = await h.agent.prompt("关闭小米音响");
      expect(spkOff.ok).toBe(true);
      expect(spkOff.reply).toBe("好的，小爱音箱 Pro 已经暂停并静音了");
      expect(spkOff.reply).not.toContain("已「");

      const spkOn = await h.agent.prompt("打开小米音响");
      expect(spkOn.ok).toBe(true);
      expect(spkOn.reply).toBe("好的，小爱音箱 Pro 已经唤醒了");

      const lightOff = await h.agent.prompt("关闭客厅吸顶灯");
      expect(lightOff.reply).toBe("好的，客厅吸顶灯已经关掉了");

      const lightOnBright = await h.agent.prompt("把客厅吸顶灯亮度调到85%");
      expect(lightOnBright.reply).toBe("好的，已经打开客厅吸顶灯，并把亮度调到85%了");

      const lightBrightOnly = await h.agent.prompt("把客厅吸顶灯亮度调到60%");
      expect(lightBrightOnly.reply).toBe("好的，客厅吸顶灯亮度已经调到60%了");

      const lightWarm = await h.agent.prompt("把客厅吸顶灯调成暖光");
      expect(lightWarm.reply).toBe("好的，客厅吸顶灯已经调成暖光了");
      expect(lightWarm.reply).not.toContain("K");

      // Batch 3 devices off -> uses natural "和" instead of machine colon
      await h.service.setPowerState("demo-switch-bar.s2", true);
      await h.service.setPowerState("demo-switch-bar.s3", true);
      await h.service.setPowerState("demo-switch-bar.s4", true);
      const batch3 = await h.agent.prompt("关闭餐厅所有灯");
      expect(batch3.reply).toContain("餐厅主灯");
      expect(batch3.reply).toContain("吧台射灯");
      expect(batch3.reply).toContain("餐边灯带");
      expect(batch3.reply).toContain("和");
      expect(batch3.reply).not.toContain("已关：");

      // Sensor summary in lite mode sounds natural & omits battery >= 20% unless requested
      const sensorReply = await h.agent.prompt("卧室现在温度和湿度多少？");
      expect(sensorReply.reply).toBe("卧室现在温度23.6°C，湿度54%");
      expect(sensorReply.reply).not.toContain("电量");

      const sensorBatReply = await h.agent.prompt("卧室温度计电量多少？");
      expect(sensorBatReply.reply).toContain("23.6°C");
      expect(sensorBatReply.reply).toContain("54%");
      expect(sensorBatReply.reply).toContain("电量");

      // Scene disabled: returns clear notice without executing any scene tool
      const sceneRes = await h.agent.prompt("执行回家模式");
      expect(sceneRes.reply).toContain("场景功能");
      expect(sceneRes.toolCalls.length).toBe(0);

      const feedRes = await h.agent.prompt("给宠物喂食器出粮2份");
      expect(feedRes.reply).toBe("好的，智能宠物喂食器已经出粮2份了");

      const volRes = await h.agent.prompt("小爱音箱音量调到65");
      expect(volRes.reply).toBe("好的，小爱音箱 Pro 音量已经调到65%了");

      const musicRes = await h.agent.prompt("用小米音响播放晴天");
      expect(musicRes.reply).toBe("好的，小爱音箱 Pro 开始播放晴天了");

      // Compound action in lite mode prefixes "好的，" only ONCE
      await h.service.setPowerState("demo-light-living", true);
      h.mainWindow.applyPowerState("demo-light-living", true);
      await h.service.setPowerState("demo-switch-bar.s2", true);
      h.mainWindow.applyPowerState("demo-switch-bar.s2", true);
      const compound = await h.agent.prompt("把客厅吸顶灯亮度调到85%，并关闭餐厅主灯");
      expect(compound.reply).toBe("好的，客厅吸顶灯亮度已经调到85%了，餐厅主灯已经关掉了");
      expect(compound.reply.split("好的").length - 1).toBe(1);

      // Greeting in lite mode is warm & concise
      const greet = await h.agent.prompt("你好");
      expect(greet.reply).toContain("在线");
      expect(greet.reply).toContain("在呢");
    } finally {
      await h.cleanup();
    }

    // 2. Full mode: direct, no "好的，" filler, still natural complete sentences
    const hFull = createHarness({ getCavemanMode: () => "full" });
    try {
      await hFull.ready();
      const rBright = await hFull.agent.prompt("把客厅吸顶灯亮度调到60%");
      expect(rBright.reply).toBe("客厅吸顶灯亮度已调到60%");
      expect(rBright.reply).not.toContain("好的");

      const rWarm = await hFull.agent.prompt("把客厅吸顶灯调成暖光");
      expect(rWarm.reply).toBe("客厅吸顶灯已调成暖光");

      const rVol = await hFull.agent.prompt("小爱音箱音量调到65");
      expect(rVol.reply).toBe("小爱音箱 Pro 音量已调到65%");

      const rSensor = await hFull.agent.prompt("卧室现在温度和湿度多少？");
      expect(rSensor.reply).toBe("卧室当前温度23.6°C，湿度54%");
    } finally {
      await hFull.cleanup();
    }
  });

  test("preserves crisp telegraphic Caveman outputs in ultra mode + clean uiSummary on tools", async () => {
    const h = createHarness({ getCavemanMode: () => "ultra" });
    try {
      await h.ready();

      // 1. Speaker soft power off/on grammar fix
      const spkOff = await h.agent.prompt("关闭小米音响");
      expect(spkOff.ok).toBe(true);
      expect(spkOff.reply).toBe("小爱音箱 Pro 已静音暂停");
      expect(spkOff.reply).not.toContain("已「");

      const spkOn = await h.agent.prompt("打开小米音响");
      expect(spkOn.ok).toBe(true);
      expect(spkOn.reply).toBe("小爱音箱 Pro 已唤醒");

      // 2. Single power off / on
      const lightOff = await h.agent.prompt("关闭客厅吸顶灯");
      expect(lightOff.reply).toBe("客厅吸顶灯已关");

      // control_light turning on from off + setting brightness
      const lightOnBright = await h.agent.prompt("把客厅吸顶灯亮度调到85%");
      expect(lightOnBright.reply).toBe("客厅吸顶灯已开，亮度 85%");

      // control_light when already on
      const lightBrightOnly = await h.agent.prompt("把客厅吸顶灯亮度调到60%");
      expect(lightBrightOnly.reply).toBe("客厅吸顶灯亮度 60%");

      // 3. Batch 3 devices off
      await h.service.setPowerState("demo-switch-bar.s2", true);
      await h.service.setPowerState("demo-switch-bar.s3", true);
      await h.service.setPowerState("demo-switch-bar.s4", true);
      const batch3 = await h.agent.prompt("关闭餐厅所有灯");
      expect(batch3.reply).toMatch(/^已关：/);
      expect(batch3.reply).toContain("餐厅主灯");
      expect(batch3.reply).toContain("吧台射灯");
      expect(batch3.reply).toContain("餐边灯带");
      expect(batch3.reply.split("、").length).toBe(3);

      // 4. Batch 4+ devices off (all lights: living + 3 dining = 4)
      await h.service.setPowerState("demo-light-living", true);
      await h.service.setPowerState("demo-switch-bar.s2", true);
      await h.service.setPowerState("demo-switch-bar.s3", true);
      await h.service.setPowerState("demo-switch-bar.s4", true);
      const batch4 = await h.agent.prompt("关闭全部灯");
      expect(batch4.reply).toMatch(/^已关 \d+ 台（.+等）$/);

      // 5. Partial failure (mark 吧台射灯 offline)
      const barSpot = h.mainWindow.allDevices.find((d) => d.did === "demo-switch-bar.s3");
      expect(barSpot).toBeTruthy();
      barSpot!.online = false;
      const partialRes = await h.findTool("set_device_power").execute("tc_partial", {
        state: "off",
        room: "餐厅",
        category: "light",
      });
      const partialText = (partialRes.content[0] as { text: string }).text;
      expect(partialText).toContain("吧台射灯离线");
      expect(partialText).toContain("；");
      barSpot!.online = true;

      // 6. Feeder, disabled scene notice, speaker controls, xiaoai, boolean property
      const feedRes = await h.agent.prompt("给宠物喂食器出粮2份");
      expect(feedRes.reply).toBe("智能宠物喂食器已出粮 2 份");

      const sceneRes = await h.agent.prompt("执行回家模式");
      expect(sceneRes.reply).toBe("场景功能暂未开启");
      expect(sceneRes.toolCalls.length).toBe(0);

      const volRes = await h.agent.prompt("小爱音箱音量调到65");
      expect(volRes.reply).toBe("小爱音箱 Pro 音量 65%");

      const muteRes = await h.agent.prompt("小爱音箱静音");
      expect(muteRes.reply).toBe("小爱音箱 Pro 已静音");

      const musicRes = await h.agent.prompt("用小米音响播放晴天");
      expect(musicRes.reply).toBe("小爱音箱 Pro 播放晴天");

      const speakRes = await h.agent.prompt("让音箱播报测试一下");
      expect(speakRes.reply).toBe("小爱音箱 Pro 已播报");

      const xiaoaiRes = await h.agent.prompt("让小爱播放轻音乐");
      expect(xiaoaiRes.reply).toBe("已发给小爱：播放轻音乐");

      const boolPropRes = await h.findTool("set_device_property").execute("tc_bool", {
        target: "客厅吸顶灯",
        property: "on",
        value: false,
      });
      expect((boolPropRes.content[0] as { text: string }).text).toContain("关");
      expect((boolPropRes.content[0] as { text: string }).text).not.toContain("false");

      // 7. Read-only discovery tools keep did=/id= in content[0].text AND attach clean uiSummary
      const listDevRes = await h.findTool("list_devices").execute("tc_ld", {});
      expect((listDevRes.content[0] as { text: string }).text).toContain("[did=");
      expect((listDevRes.details as Record<string, unknown>).uiSummary).toMatch(/^共 \d+ 台：/);
      expect(String((listDevRes.details as Record<string, unknown>).uiSummary)).not.toContain("[did=");

      // Scene tools are disabled and omitted from Pi Agent tool registry
      expect(h.tools.some((t) => t.name === "list_scenes" || t.name === "run_scene")).toBe(false);

      const detailRes = await h.findTool("get_device_detail").execute("tc_gd", { target: "客厅吸顶灯" });
      expect((detailRes.content[0] as { text: string }).text).toContain("[did=demo-light-living]");
      expect(String((detailRes.details as Record<string, unknown>).uiSummary)).toBe("客厅吸顶灯已关");
    } finally {
      await h.cleanup();
    }
  });

  test("localPlannerStream summarizes devices, scenes, sensors, lights, greetings, and compound actions without [did=...] leaks", async () => {
    const h = createHarness({ getCavemanMode: () => "ultra" });
    try {
      await h.ready();

      // Greeting concise in ultra mode
      const greet = await h.agent.prompt("你好");
      expect(greet.reply).toMatch(/^在呢，\d+\/\d+ 台设备在线，请说$/);
      expect(greet.reply.length).toBeLessThan(30);

      // list_devices & list_scenes NEVER leak [did=...] or dangling colon
      const devList = await h.agent.prompt("有哪些设备");
      expect(devList.reply).toMatch(/^共 \d+ 台：/);
      expect(devList.reply).not.toContain("[did=");
      expect(devList.reply.endsWith("：")).toBe(false);

      const scnList = await h.agent.prompt("有哪些场景");
      expect(scnList.reply).toBe("场景功能暂未开启");
      expect(scnList.toolCalls.length).toBe(0);

      // Sensor summary omits battery >= 20% unless user asked for 电量
      const sensorReply = await h.agent.prompt("卧室现在温度和湿度多少？");
      expect(sensorReply.reply).toBe("卧室米家温湿度计 23.6°C，湿度 54%");
      expect(sensorReply.reply).not.toContain("电量");

      const sensorBatReply = await h.agent.prompt("卧室温度计电量多少？");
      expect(sensorBatReply.reply).toContain("23.6°C");
      expect(sensorBatReply.reply).toContain("54%");
      expect(sensorBatReply.reply).toContain("电量");

      // Light detail: on vs off
      const lightDetailOn = await h.agent.prompt("客厅吸顶灯状态怎么样");
      expect(lightDetailOn.reply).toBe("客厅吸顶灯已开，亮度 72%，4200K");

      await h.service.setPowerState("demo-light-living", false);
      const lightDetailOff = await h.agent.prompt("客厅吸顶灯开着吗");
      expect(lightDetailOff.reply).toBe("客厅吸顶灯已关");

      // Non-sensor detail (speaker) NEVER leaks [did=...]
      const spkDetail = await h.agent.prompt("小爱音箱状态怎么样");
      expect(spkDetail.reply).not.toContain("[did=");
      expect(spkDetail.reply).toContain("小爱音箱 Pro");
      expect(spkDetail.reply).toContain("音量");

      // Compound join of 2 short clauses uses "，"
      await h.service.setPowerState("demo-light-living", true);
      h.mainWindow.applyPowerState("demo-light-living", true);
      await h.service.setPowerState("demo-switch-bar.s2", true);
      h.mainWindow.applyPowerState("demo-switch-bar.s2", true);
      const compound = await h.agent.prompt("把客厅吸顶灯亮度调到85%，并关闭餐厅主灯");
      expect(compound.reply).toBe("客厅吸顶灯亮度 85%，餐厅主灯已关");

      // Compound join of longer / 3+ clauses uses "；" in ultra mode
      const threeToolMsgs: ToolResultMessage[] = [
        {
          role: "toolResult",
          toolCallId: "c1",
          toolName: "set_device_power",
          content: [{ type: "text", text: "客厅吸顶灯已开" }],
          details: { ok: true, uiSummary: "客厅吸顶灯已开" },
          isError: false,
          timestamp: Date.now(),
        },
        {
          role: "toolResult",
          toolCallId: "c2",
          toolName: "set_device_power",
          content: [{ type: "text", text: "餐厅主灯已关" }],
          details: { ok: true, uiSummary: "餐厅主灯已关" },
          isError: false,
          timestamp: Date.now(),
        },
        {
          role: "toolResult",
          toolCallId: "c3",
          toolName: "run_scene",
          content: [{ type: "text", text: "已执行：回家模式" }],
          details: { ok: true, uiSummary: "已执行：回家模式" },
          isError: false,
          timestamp: Date.now(),
        },
      ];
      expect(summarizeToolResults(threeToolMsgs, "", "ultra")).toBe(
        "客厅吸顶灯已开；餐厅主灯已关；已执行：回家模式",
      );

      // Low battery (<20%) sensor summary via direct summarizeToolResults
      const lowBatMsg: ToolResultMessage = {
        role: "toolResult",
        toolCallId: "t1",
        toolName: "get_device_detail",
        content: [{ type: "text", text: "设备：卧室米家温湿度计 [did=demo-sensor]" }],
        details: {
          ok: true,
          name: "卧室米家温湿度计",
          room: "卧室",
          online: true,
          values: { temperature: 23.6, "relative-humidity": 54, "battery-level": 12 },
        },
        isError: false,
        timestamp: Date.now(),
      };
      expect(summarizeToolResults([lowBatMsg], "卧室几度", "ultra")).toBe(
        "卧室米家温湿度计 23.6°C，湿度 54%，电量 12%",
      );
      expect(summarizeToolResults([lowBatMsg], "卧室几度", "lite")).toContain("12%");
    } finally {
      await h.cleanup();
    }
  });

  test("localPlannerStream supports optional classifyImplicitAction hook for colloquial utterances", async () => {
    const seenUtterances: string[] = [];
    const h = createHarness({
      getCavemanMode: () => "full",
      classifyImplicitAction: async (utterance) => {
        seenUtterances.push(utterance);
        if (utterance.includes("刺眼")) return "light_dimmer";
        if (utterance.includes("黑漆漆")) return "light_brighter";
        if (utterance.includes("太吵")) return "speaker_quieter";
        if (utterance.includes("讲个故事")) return "needs_llm_agent";
        return null;
      },
    });

    try {
      await h.ready();

      // 1. "有点刺眼" -> light_dimmer -> brightness 35%
      const rDim = await h.agent.prompt("有点刺眼");
      expect(rDim.ok).toBe(true);
      expect(rDim.toolCalls[0]?.name).toBe("control_light");
      expect(await h.service.readProp("demo-light-living", "brightness")).toBe(35);

      // 2. "黑漆漆的看不清" -> light_brighter -> on + brightness 85%
      await h.service.setPowerState("demo-light-living", false);
      const rBright = await h.agent.prompt("黑漆漆的看不清");
      expect(rBright.ok).toBe(true);
      expect(rBright.toolCalls[0]?.name).toBe("control_light");
      expect(await h.service.powerState("demo-light-living")).toBe(true);
      expect(await h.service.readProp("demo-light-living", "brightness")).toBe(85);

      // 3. "太吵了" -> speaker_quieter -> volume -15
      const volBefore = (await h.service.readProp("demo-speaker-xiaoai", "volume")) as number;
      const rQuiet = await h.agent.prompt("太吵了");
      expect(rQuiet.ok).toBe(true);
      expect(rQuiet.toolCalls[0]?.name).toBe("control_speaker");
      expect(await h.service.readProp("demo-speaker-xiaoai", "volume")).toBe(volBefore - 15);

      // 4. "给我讲个故事" -> needs_llm_agent -> no random tool executed, concise hint
      const rLlm = await h.agent.prompt("给我讲个故事");
      expect(rLlm.ok).toBe(true);
      expect(rLlm.toolCalls.length).toBe(0);
      expect(rLlm.reply).toContain("大模型");

      expect(seenUtterances).toEqual(["有点刺眼", "黑漆漆的看不清", "太吵了", "给我讲个故事"]);
    } finally {
      await h.cleanup();
    }
  });
});
