// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: Pi Agent 先回复“好的” -> 执行 -> 状态检查 -> 思考排错3轮重试 -> 沉淀复用 Skill 闭环测试

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  buildSkillsPromptSection,
  computeSkillStepsSignature,
  loadAgentSkills,
  matchAgentSkill,
  normalizeSkillIntentKey,
  resolveCanonicalSkillIntent,
  saveAgentSkill,
} from "../src/agent/agentSkillStore.ts";
import { PiAgentService, TASK_ACK_TEXT } from "../src/agent/piAgentService.ts";
import {
  DEFAULT_SPEAKER_PLAYBACK_SETTLE_DELAYS_MS,
  DEFAULT_VERIFY_SETTLE_DELAYS_MS,
  MAX_RECOVERY_ROUNDS,
  resolveSpeakerPlayingValue,
} from "../src/agent/taskVerificationLoop.ts";
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

function createHarness(options: {
  service?: VirtualDemoService;
  customStreamFn?: ConstructorParameters<typeof PiAgentService>[0]["customStreamFn"];
  customModel?: ConstructorParameters<typeof PiAgentService>[0]["customModel"];
  verificationOptions?: ConstructorParameters<typeof PiAgentService>[0]["verificationOptions"];
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
    ...(options.customStreamFn ? { customStreamFn: options.customStreamFn } : {}),
    ...(options.customModel ? { customModel: options.customModel } : {}),
    ...(options.verificationOptions ? { verificationOptions: options.verificationOptions } : {}),
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
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "mijiadeck-verify-skill-"));
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

describe("Pi Agent Closed-Loop: Immediate Ack -> Execute -> State Verify -> 3-Round Self-Heal -> Skill", () => {
  test("replies '好的' immediately BEFORE executing tools, verifies live state, and stays silent when simple control check passes cleanly", async () => {
    const service = new VirtualDemoService();
    const order: string[] = [];
    const origSetPower = service.setPowerState.bind(service);
    service.setPowerState = async (did: string, state: boolean) => {
      order.push(`device_write:${did}:${state}`);
      return origSetPower(did, state);
    };
    const origPowerState = service.powerState.bind(service);
    service.powerState = async (did: string) => {
      order.push(`device_verify:${did}`);
      return origPowerState(did);
    };

    const h = createHarness({ service });
    try {
      await h.ready();
      order.length = 0;

      const spoken: Array<{ text: string; final: boolean }> = [];
      const finalReplyEvents: Array<Record<string, unknown>> = [];
      h.agent.on("streamEvent", (ev) => {
        order.push(`event:${String(ev.kind)}`);
        if (ev.kind === "final_reply") {
          finalReplyEvents.push(ev);
        }
      });
      h.agent.on("speakChunk", (chunk) => {
        spoken.push({ text: chunk.text, final: chunk.final });
        order.push(`speak:${chunk.text}`);
      });

      const res = await h.agent.prompt("关闭客厅吸顶灯", { source: "voice" });
      expect(res.ok).toBe(true);
      expect(res.ack).toBe(TASK_ACK_TEXT);
      expect(res.silentCompleted).toBe(true);
      expect(res.reply).toBe("");
      expect(res.retriesUsed).toBe(0);
      expect(res.verification?.status).toBe("passed");
      expect(res.verification?.passed).toBe(true);
      expect(await service.powerState("demo-light-living")).toBe(false);

      // Strict ordering: task_ack & speak "好的" MUST happen BEFORE tool_start & device write!
      const ackIdx = order.indexOf("event:task_ack");
      const speakAckIdx = order.indexOf("speak:好的");
      const toolStartIdx = order.indexOf("event:tool_start");
      const writeIdx = order.indexOf("device_write:demo-light-living:false");
      const verifyIdx = order.indexOf("device_verify:demo-light-living");
      const verifyEventIdx = order.indexOf("event:verification_result");
      const finalReplyIdx = order.indexOf("event:final_reply");

      expect(ackIdx).toBeGreaterThanOrEqual(0);
      expect(speakAckIdx).toBeGreaterThan(ackIdx);
      expect(toolStartIdx).toBeGreaterThan(speakAckIdx);
      expect(writeIdx).toBeGreaterThan(toolStartIdx);
      expect(verifyIdx).toBeGreaterThan(writeIdx);
      expect(verifyEventIdx).toBeGreaterThan(verifyIdx);
      expect(finalReplyIdx).toBeGreaterThan(verifyEventIdx);
      expect(finalReplyEvents.length).toBe(1);
      expect(finalReplyEvents[0]?.silent).toBe(true);
      expect(finalReplyEvents[0]?.text).toBe("");

      // Voice speaks ONLY immediate ack "好的" — no redundant post-verification TTS reply when state is normal!
      expect(spoken.length).toBe(1);
      expect(spoken[0]?.text).toBe("好的");
      expect(spoken[0]?.final).toBe(false);

      // 1st-try clean success does NOT spam skill store
      expect(loadAgentSkills().length).toBe(0);
    } finally {
      await h.cleanup();
    }
  });

  test("catches silent state mismatch, informs user before each retry, heals via escalated path, precipitates Skill (JSON+MD), and reuses Skill next time with 0 retries", async () => {
    const service = new VirtualDemoService();
    await service.setPowerState("demo-light-living", false);

    // Simulate a real-world quirky device:
    // - setPowerState silently does NOT turn the lamp on (pitfall!)
    // - writeProp("demo-light-living", "on", true) (Round 2 escalated direct property write) ACTUALLY works!
    let setPowerCalls = 0;
    let writePropCalls = 0;
    const origWriteProp = service.writeProp.bind(service);
    service.setPowerState = async (did: string, state: boolean) => {
      if (did === "demo-light-living" && state === true) {
        setPowerCalls += 1;
        return; // silently fails to update hardware state!
      }
      return origWriteProp(did, "on", state);
    };
    service.writeProp = async (did: string, name: string, value: unknown) => {
      if (did === "demo-light-living" && name === "on" && value === true) {
        writePropCalls += 1;
      }
      return origWriteProp(did, name, value);
    };

    const h = createHarness({ service });
    try {
      await h.ready();

      const timelineEvents: Array<{ kind: string; text?: string; attempt?: number }> = [];
      const spoken: string[] = [];
      h.agent.on("streamEvent", (ev) => {
        timelineEvents.push({
          kind: String(ev.kind),
          text: typeof ev.text === "string" ? ev.text : undefined,
          attempt: typeof ev.attempt === "number" ? ev.attempt : undefined,
        });
      });
      h.agent.on("speakChunk", (c) => spoken.push(c.text));

      // --- RUN 1: Hits pitfall -> Round 1 retry -> Round 2 escalated writeProp heals it -> saves Skill ---
      const r1 = await h.agent.prompt("打开客厅吸顶灯", { source: "voice" });
      expect(r1.ok).toBe(true);
      expect(r1.ack).toBe("好的");
      expect(r1.retriesUsed).toBe(2);
      expect(r1.verification?.status).toBe("recovered");
      expect(r1.verification?.passed).toBe(true);
      expect(await service.powerState("demo-light-living")).toBe(true);
      expect(setPowerCalls).toBe(2); // initial round 0 + round 1 retry
      expect(writePropCalls).toBe(1); // round 2 direct property write healed it!

      // Each retry MUST inform the user of BOTH the problem AND what it plans to do
      expect(r1.retryNotices?.length).toBe(2);
      expect(r1.retryNotices?.[0]?.attempt).toBe(1);
      expect(r1.retryNotices?.[0]?.problem).toContain("客厅吸顶灯");
      expect(r1.retryNotices?.[0]?.plan.length).toBeGreaterThan(4);
      expect(r1.retryNotices?.[0]?.text).toContain("第1次重试");
      expect(r1.retryNotices?.[1]?.attempt).toBe(2);
      expect(r1.retryNotices?.[1]?.plan).toContain("底层属性写入");
      expect(r1.retryNotices?.[1]?.text).toContain("第2次重试");

      // Self-healing retries are SILENT in voice TTS (recorded in timeline/retryNotices, never spoken aloud!)
      // Voice hears ONLY: immediate ack "好的" and final verified reply.
      expect(spoken[0]).toBe("好的");
      expect(spoken.some((s) => s.includes("第1次重试"))).toBe(false);
      expect(spoken.some((s) => s.includes("第2次重试"))).toBe(false);
      expect(spoken.some((s) => s.includes("重试"))).toBe(false);
      expect(spoken.length).toBe(2);
      expect(timelineEvents.filter((e) => e.kind === "retry_notice").length).toBe(2);
      expect(r1.reply).toContain("状态检查已通过");
      expect(r1.reply).toContain("沉淀为技能");

      // Skill was precipitated to JSON + Markdown file!
      expect(r1.skillEvent?.kind).toBe("created");
      const skills = loadAgentSkills();
      expect(skills.length).toBe(1);
      const savedSkill = skills[0]!;
      expect(savedSkill.steps.some((s) => s.toolName === "set_device_property")).toBe(true);
      expect(savedSkill.pitfall).toContain("客厅吸顶灯");
      expect(savedSkill.markdownFile).toBeTruthy();
      const mdFullPath = path.join(tmpDir, savedSkill.markdownFile!);
      expect(existsSync(mdFullPath)).toBe(true);
      const mdContent = readFileSync(mdFullPath, "utf-8");
      expect(mdContent).toContain("避坑记录");
      expect(mdContent).toContain("set_device_property");

      // --- RUN 2: Same intent (with polite phrasing) reuses Skill -> 0 retries, skips pitfall! ---
      await origWriteProp("demo-light-living", "on", false);
      expect(await service.powerState("demo-light-living")).toBe(false);
      setPowerCalls = 0;
      writePropCalls = 0;
      spoken.length = 0;

      const r2 = await h.agent.prompt("请帮我打开客厅吸顶灯一下", { source: "voice" });
      expect(r2.ok).toBe(true);
      expect(r2.ack).toBe("好的");
      expect(r2.retriesUsed).toBe(0);
      expect(r2.retryNotices).toBeUndefined();
      expect(r2.verification?.status).toBe("passed");
      expect(r2.verification?.passed).toBe(true);
      expect(r2.skillEvent?.kind).toBe("reused");
      expect(r2.skillEvent?.skillId).toBe(savedSkill.id);
      expect(await service.powerState("demo-light-living")).toBe(true);
      // NEVER called the broken setPowerState path at all!
      expect(setPowerCalls).toBe(0);
      expect(writePropCalls).toBe(1);
      expect(spoken[0]).toBe("好的");

      const refreshedSkills = loadAgentSkills();
      expect(refreshedSkills[0]?.useCount).toBe(1);
      expect(refreshedSkills[0]?.retriesAvoided).toBe(1);
    } finally {
      await h.cleanup();
    }
  });

  test("stops after 3 failed retry rounds, reports problem honestly, and does NOT save a broken skill", async () => {
    const service = new VirtualDemoService();
    await service.setPowerState("demo-light-living", false);

    // Permanently stuck device: every write silently leaves power === false
    service.setPowerState = async () => {};
    service.writeProp = async () => {};

    const h = createHarness({ service });
    try {
      await h.ready();

      const retryEvents: Array<{ attempt: number; problem: string; plan: string }> = [];
      h.agent.on("streamEvent", (ev) => {
        if (ev.kind === "retry_notice") {
          retryEvents.push({
            attempt: Number(ev.attempt),
            problem: String(ev.problem ?? ""),
            plan: String(ev.plan ?? ""),
          });
        }
      });

      const res = await h.agent.prompt("打开客厅吸顶灯");
      expect(res.ack).toBe("好的");
      expect(res.retriesUsed).toBe(MAX_RECOVERY_ROUNDS);
      expect(res.retryNotices?.length).toBe(3);
      expect(retryEvents.map((e) => e.attempt)).toEqual([1, 2, 3]);
      for (const ev of retryEvents) {
        expect(ev.problem).toContain("客厅吸顶灯");
        expect(ev.plan.length).toBeGreaterThan(4);
      }

      expect(res.verification?.status).toBe("failed");
      expect(res.verification?.passed).toBe(false);
      expect(res.verification?.retriesUsed).toBe(3);
      expect(res.reply).toContain("已尝试 3 轮");
      expect(res.reply).toContain("客厅吸顶灯");
      expect(res.skillEvent).toBeUndefined();
      // Must NOT save a skill when recovery failed!
      expect(loadAgentSkills().length).toBe(0);
    } finally {
      await h.cleanup();
    }
  });

  test("assesses unsolvable issues (offline / unsupported / not found) and stops immediately with 0 retries", async () => {
    const h = createHarness();
    try {
      await h.ready();

      // 1. Offline device -> unsolvable, 0 retries
      const living = h.mainWindow.allDevices.find((d) => d.did === "demo-light-living")!;
      living.online = false;
      const rOffline = await h.agent.prompt("关闭客厅吸顶灯");
      expect(rOffline.ack).toBe("好的");
      expect(rOffline.retriesUsed).toBe(0);
      expect(rOffline.retryNotices).toBeUndefined();
      expect(rOffline.verification?.status).toBe("unsolvable");
      expect(rOffline.verification?.solvable).toBe(false);
      expect(rOffline.reply).toContain("离线");
      living.online = true;

      // 2. Unsupported capability (switch light cannot dim) -> unsolvable, 0 retries
      const rUnsup = await h.agent.prompt("把餐厅主灯调暗一点");
      expect(rUnsup.retriesUsed).toBe(0);
      expect(rUnsup.verification?.status).toBe("unsolvable");
      expect(rUnsup.reply).toContain("不支持亮度调节");

      // 3. Non-existent device -> unsolvable, 0 retries
      const rMissing = await h.agent.prompt("打开地下室空调");
      expect(rMissing.retriesUsed).toBe(0);
      expect(rMissing.verification?.status).toBe("unsolvable");
      expect(loadAgentSkills().length).toBe(0);
    } finally {
      await h.cleanup();
    }
  });

  test("holds back premature unverified Cloud LLM claim, recovers via LLM follow-up, and saves Skill", async () => {
    const service = new VirtualDemoService();
    let brightnessAttempts = 0;
    const origWriteProp = service.writeProp.bind(service);
    service.writeProp = async (did: string, name: string, value: unknown) => {
      if (did === "demo-light-living" && name === "brightness") {
        brightnessAttempts += 1;
        if (brightnessAttempts === 1) {
          // Silently drop 1st brightness write so state check catches mismatch (72 !== 85)!
          return;
        }
      }
      return origWriteProp(did, name, value);
    };

    const faux = fauxProvider({
      models: [{ id: "faux-verify-llm", name: "Faux Verify LLM" }],
    });
    faux.setResponses([
      // Round 0: LLM calls control_light and prematurely claims success
      fauxAssistantMessage(
        [fauxToolCall("control_light", { target: "客厅吸顶灯", brightness: 85 })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("已将客厅吸顶灯亮度调到 85%。", { stopReason: "stop" }),
      // Round 1 recovery: LLM sees state mismatch diagnostic, explicitly turns on + sets brightness
      fauxAssistantMessage(
        [fauxToolCall("control_light", { target: "demo-light-living", on: true, brightness: 85 })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("已重新开启客厅吸顶灯并将亮度调到 85%。", { stopReason: "stop" }),
    ]);

    const h = createHarness({
      service,
      customModel: faux.getModel(),
      customStreamFn: (m, ctx, opts) => faux.provider.streamSimple(m, ctx, opts),
    });

    try {
      await h.ready();
      const spoken: string[] = [];
      const emittedDeltas: string[] = [];
      h.agent.on("speakChunk", (c) => spoken.push(c.text));
      h.agent.on("streamEvent", (ev) => {
        if (ev.kind === "text_delta" && typeof ev.text === "string") {
          emittedDeltas.push(ev.text);
        }
      });

      const res = await h.agent.prompt("把客厅吸顶灯亮度调到85%", { source: "voice" });
      expect(res.ok).toBe(true);
      expect(res.ack).toBe("好的");
      expect(res.retriesUsed).toBe(1);
      expect(res.verification?.status).toBe("recovered");
      expect(res.verification?.passed).toBe(true);
      expect(await service.readProp("demo-light-living", "brightness")).toBe(85);
      // Premature Round 0 text was NOT streamed as unverified delta before verification!
      expect(emittedDeltas.length).toBe(0);
      // Voice sequence: "好的" -> final verified reply (retry 1 runs silently without TTS broadcast!)
      expect(spoken[0]).toBe("好的");
      expect(spoken.some((s) => s.includes("第1次重试"))).toBe(false);
      expect(spoken.length).toBe(2);
      expect(spoken[spoken.length - 1]).toContain("85%");
      // Skill saved from LLM recovery
      expect(res.skillEvent?.kind).toBe("created");
      expect(loadAgentSkills().length).toBe(1);
    } finally {
      await h.cleanup();
    }
  });

  test("exposes /api/agent/skills CRUD, toggle, and normalized intent safety (never mismatches different numeric targets)", async () => {
    const demo = new VirtualDemoService();
    let brightnessDrops = 0;
    const origWrite = demo.writeProp.bind(demo);
    demo.writeProp = async (did: string, name: string, value: unknown) => {
      if (did === "demo-light-living" && name === "brightness" && brightnessDrops === 0) {
        brightnessDrops += 1;
        return; // drop 1st write to trigger 1-round self-heal & skill creation
      }
      return origWrite(did, name, value);
    };

    server = await startMijiaDeckServer({
      mode: "demo",
      port: 0,
      service: demo,
    });

    const p1 = await fetch(`${server.url}/api/agent/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "把客厅吸顶灯亮度调到 85%", source: "text" }),
    });
    expect(p1.status).toBe(200);
    const p1Json = (await p1.json()) as any;
    expect(p1Json.ok).toBe(true);
    expect(p1Json.ack).toBe("好的");
    expect(p1Json.retriesUsed).toBe(1);
    expect(p1Json.verification.status).toBe("recovered");
    expect(p1Json.skillEvent.kind).toBe("created");
    const skillId = p1Json.skillEvent.skillId as string;

    // Numeric target safety: 30% MUST NOT match the 85% skill!
    expect(normalizeSkillIntentKey("把客厅吸顶灯亮度调到 85%")).not.toBe(
      normalizeSkillIntentKey("把客厅吸顶灯亮度调到 30%"),
    );
    expect(matchAgentSkill("把客厅吸顶灯亮度调到 30%", server.runtime.mainWindow.activeDevices())).toBeNull();
    expect(
      matchAgentSkill("帮我把客厅吸顶灯亮度调到85%", server.runtime.mainWindow.activeDevices())?.id,
    ).toBe(skillId);

    // GET /api/agent/skills
    const listRes = await fetch(`${server.url}/api/agent/skills`);
    expect(listRes.status).toBe(200);
    const listJson = (await listRes.json()) as any;
    expect(listJson.skills.length).toBe(1);
    expect(listJson.skills[0].id).toBe(skillId);

    // Toggle OFF -> skill no longer matches
    const offRes = await fetch(`${server.url}/api/agent/skills/${encodeURIComponent(skillId)}/toggle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(offRes.status).toBe(200);
    expect(((await offRes.json()) as any).skill.enabled).toBe(false);
    expect(matchAgentSkill("把客厅吸顶灯亮度调到 85%", server.runtime.mainWindow.activeDevices())).toBeNull();

    // DELETE /api/agent/skills/:id removes JSON record & Markdown file
    const mdPath = path.join(tmpDir, listJson.skills[0].markdownFile);
    expect(existsSync(mdPath)).toBe(true);
    const delRes = await fetch(`${server.url}/api/agent/skills/${encodeURIComponent(skillId)}`, {
      method: "DELETE",
    });
    expect(delRes.status).toBe(200);
    expect(loadAgentSkills().length).toBe(0);
    expect(existsSync(mdPath)).toBe(false);
  });

  test("absorbs speaker playing-state cloud/device propagation delay on Round 0 with 0 retries, 0 false skills, and silent completion", async () => {
    expect(DEFAULT_SPEAKER_PLAYBACK_SETTLE_DELAYS_MS).toEqual([700, 1000, 1300]);
    expect(DEFAULT_VERIFY_SETTLE_DELAYS_MS).toEqual([300, 600]);
    expect(
      resolveSpeakerPlayingValue({
        name: "playing-state",
        desc: "播放状态",
        type: "uint",
        readable: true,
        writable: false,
        range: null,
        value_list: [{ value: 0, description: "Playing", desc_zh_cn: "播放中" }],
        unit: null,
        siid: 3,
        piid: 1,
      }),
    ).toBe(0);
    expect(
      resolveSpeakerPlayingValue({
        name: "playing-state",
        desc: "播放状态",
        type: "uint",
        readable: true,
        writable: false,
        range: null,
        value_list: null,
        unit: null,
        siid: 3,
        piid: 1,
      }),
    ).toBe(1);

    const service = new VirtualDemoService();
    await service.runAction("demo-speaker-xiaoai", "play");

    // Simulate real XiaoAI speaker (e.g. xiaomi.wifispeaker.l05b) lag:
    // pause succeeds immediately on device, but MIoT playing-state stays 1 for the first 3 readProps calls
    // (1 inside control_speaker + 2 inside verifyExecutedToolCalls), then reports 2 on the 4th read!
    let speakerReadCount = 0;
    const origReadProps = service.readProps.bind(service);
    service.readProps = async (did: string, names: string[]) => {
      const vals = await origReadProps(did, names);
      if (did === "demo-speaker-xiaoai" && names.includes("playing-state")) {
        speakerReadCount += 1;
        if (speakerReadCount <= 3) {
          return { ...vals, "playing-state": 1 };
        }
      }
      return vals;
    };

    const recordedSleeps: number[] = [];
    const h = createHarness({
      service,
      verificationOptions: {
        speakerPlaybackSettleDelaysMs: [15, 25, 35],
        sleep: async (ms) => {
          recordedSleeps.push(ms);
        },
      },
    });
    try {
      await h.ready();
      const spoken: string[] = [];
      const retryEvents: unknown[] = [];
      h.agent.on("speakChunk", (c) => spoken.push(c.text));
      h.agent.on("streamEvent", (ev) => {
        if (ev.kind === "retry_notice") retryEvents.push(ev);
      });

      const res = await h.agent.prompt("停止播放音乐", { source: "voice" });
      expect(res.ok).toBe(true);
      expect(res.retriesUsed).toBe(0);
      expect(res.retryNotices).toBeUndefined();
      expect(retryEvents.length).toBe(0);
      expect(res.verification?.status).toBe("passed");
      expect(res.verification?.passed).toBe(true);
      expect(res.verification?.checks[0]?.summary).toContain("延迟同步确认");
      expect(res.silentCompleted).toBe(true);
      expect(res.reply).toBe("");
      expect(recordedSleeps).toEqual([15, 25]);
      // Voice spoke ONLY the immediate ack (no retry speech, no redundant confirmation speech)
      expect(spoken.length).toBe(1);
      expect(spoken.some((s) => s.includes("重试"))).toBe(false);
      // Must NOT pollute skill store when latency was merely readback lag
      expect(loadAgentSkills().length).toBe(0);
    } finally {
      await h.cleanup();
    }
  });

  test("recovers from transient speaker readback error during settle polling with 0 retries, and fails fast on fatal readback error", async () => {
    const service = new VirtualDemoService();
    await service.runAction("demo-speaker-xiaoai", "play");

    let verifyReads = 0;
    const origReadProps = service.readProps.bind(service);
    service.readProps = async (did: string, names: string[]) => {
      if (did === "demo-speaker-xiaoai" && names.length === 1 && names[0] === "playing-state") {
        verifyReads += 1;
        if (verifyReads === 1) {
          throw new Error("设备响应超时，请稍后重试（错误码 -705004000）");
        }
      }
      return origReadProps(did, names);
    };

    const sleepCalls: number[] = [];
    const h = createHarness({
      service,
      verificationOptions: {
        speakerPlaybackSettleDelaysMs: [10, 20, 30],
        sleep: async (ms) => {
          sleepCalls.push(ms);
        },
      },
    });
    try {
      await h.ready();
      const res = await h.agent.prompt("暂停播放音乐", { source: "voice" });
      expect(res.ok).toBe(true);
      expect(res.retriesUsed).toBe(0);
      expect(res.verification?.status).toBe("passed");
      expect(res.silentCompleted).toBe(true);
      expect(sleepCalls).toEqual([10]);

      // Fatal readback error (e.g. session logged out) must abort settle polling immediately (0 sleeps)
      sleepCalls.length = 0;
      await service.runAction("demo-speaker-xiaoai", "play");
      service.readProps = async (did: string, names: string[]) => {
        if (did === "demo-speaker-xiaoai" && names.length === 1 && names[0] === "playing-state") {
          throw new Error("尚未登录，请先扫码登录");
        }
        return origReadProps(did, names);
      };
      const fatalRes = await h.agent.prompt("停止播放音乐", { source: "text" });
      expect(sleepCalls).toEqual([]);
      expect(fatalRes.retriesUsed).toBe(0);
      expect(fatalRes.verification?.passed).toBe(false);
      expect(fatalRes.verification?.status).toBe("unsolvable");
    } finally {
      await h.cleanup();
    }
  });

  test("escalates silently via silent execute-text-directive when speaker genuinely ignores pause, without TTS retry spam or muting speaker", async () => {
    const service = new VirtualDemoService();
    await service.runAction("demo-speaker-xiaoai", "play");

    // Simulate a speaker where play-control `pause` returns ok but does NOT stop playback (e.g. radio/news/TTS),
    // while `execute-text-directive` ("停止播放", silent=1) genuinely stops playback!
    const recordedActions: Array<{ name: string; params?: unknown }> = [];
    const origRunAction = service.runAction.bind(service);
    service.runAction = async (did: string, name: string, params?: unknown) => {
      if (did === "demo-speaker-xiaoai") {
        recordedActions.push({ name, params });
        if (name === "pause" || name === "stop") {
          return; // silently fails to stop playback!
        }
      }
      return origRunAction(did, name, params);
    };

    const h = createHarness({
      service,
      verificationOptions: {
        settleDelaysMs: [5, 5],
        speakerPlaybackSettleDelaysMs: [5, 5, 5],
        sleep: async () => {},
      },
    });
    try {
      await h.ready();
      const spoken: string[] = [];
      const retryEvents: Array<{ attempt: number; plan: string }> = [];
      h.agent.on("speakChunk", (c) => spoken.push(c.text));
      h.agent.on("streamEvent", (ev) => {
        if (ev.kind === "retry_notice") {
          retryEvents.push({
            attempt: Number(ev.attempt),
            plan: String(ev.plan ?? ""),
          });
        }
      });

      const res = await h.agent.prompt("停止播放音乐", { source: "voice" });
      expect(res.ok).toBe(true);
      // VirtualDemoService speaker has only `pause` (no `stop`), so Round 0 already executed `pause`,
      // and Round 1 jumps directly to silent `send_xiaoai_command("停止播放", silent: true)`!
      expect(res.retriesUsed).toBe(1);
      expect(res.verification?.status).toBe("recovered");
      expect(res.verification?.passed).toBe(true);
      expect(await service.readProp("demo-speaker-xiaoai", "playing-state")).toBe(2);
      // Speaker was NOT left muted as an unnecessary side-effect!
      expect(await service.readProp("demo-speaker-xiaoai", "mute")).toBe(false);

      // Verify silent execution flag [directive, 1] was sent to execute-text-directive
      const textDirectiveCall = recordedActions.find((a) => a.name === "execute-text-directive");
      expect(textDirectiveCall).toBeDefined();
      expect(textDirectiveCall?.params).toEqual(["停止播放", 1]);

      // Retry notice recorded in UI timeline, NEVER broadcast via voice TTS!
      expect(retryEvents.length).toBe(1);
      expect(retryEvents[0]?.plan).toContain("静默小爱文本指令");
      expect(spoken.some((s) => s.includes("重试"))).toBe(false);
      expect(spoken.length).toBe(2); // immediate ack + final verified reply only
    } finally {
      await h.cleanup();
    }
  });

  test("never broadcasts TTS during any of 3 failed voice retries and aborts promptly during settle polling", async () => {
    const service = new VirtualDemoService();
    await service.setPowerState("demo-light-living", false);
    service.setPowerState = async () => {};
    service.writeProp = async () => {};

    const h = createHarness({
      service,
      verificationOptions: {
        settleDelaysMs: [5, 5],
        sleep: async () => {},
      },
    });
    try {
      await h.ready();
      const spoken: string[] = [];
      h.agent.on("speakChunk", (c) => spoken.push(c.text));

      const res = await h.agent.prompt("打开客厅吸顶灯", { source: "voice" });
      expect(res.retriesUsed).toBe(MAX_RECOVERY_ROUNDS);
      expect(res.verification?.status).toBe("failed");
      expect(res.retryNotices?.length).toBe(3);
      // ZERO retry notices spoken aloud; only ack + final failure summary
      expect(spoken.some((s) => s.includes("重试"))).toBe(false);
      expect(spoken.length).toBe(2);
      expect(spoken[0]).toBe("好的");
      expect(spoken[1]).toContain("已尝试 3 轮");
    } finally {
      await h.cleanup();
    }

    // Abort during long settle polling resolves immediately without waiting for the timer
    const slowService = new VirtualDemoService();
    await slowService.setPowerState("demo-light-living", false);
    slowService.setPowerState = async () => {};
    const hAbort = createHarness({
      service: slowService,
      verificationOptions: {
        settleDelaysMs: [10_000],
      },
    });
    try {
      await hAbort.ready();
      const sub = hAbort.agent.submitPrompt("打开客厅吸顶灯", { source: "text" });
      await Bun.sleep(40);
      const t0 = performance.now();
      expect(hAbort.agent.abortTask(sub.taskId)).toBe(true);
      const abortedRes = await sub.promise;
      expect(performance.now() - t0).toBeLessThan(800);
      expect(abortedRes.ok).toBe(false);
    } finally {
      await hAbort.cleanup();
    }
  });

  test("stop-playback Skill precipitated via self-heal is reused across natural phrasing & ASR punctuation variations with 0 retries and 0 duplicate skills", async () => {
    const service = new VirtualDemoService();
    let pauseCalls = 0;
    let textDirectiveCalls = 0;
    const origRunAction = service.runAction.bind(service);
    service.runAction = async (did: string, name: string, params?: unknown) => {
      if (did === "demo-speaker-xiaoai" && name === "pause") {
        // Simulate real XiaoAI quirk: MIoT pause leaves playing-state=1 (does not stop stream)
        pauseCalls += 1;
        return;
      }
      if (did === "demo-speaker-xiaoai" && name === "execute-text-directive") {
        textDirectiveCalls += 1;
        // Text directive "停止播放" actually stops playback -> playing-state=2
        await origRunAction(did, "pause");
        return;
      }
      return origRunAction(did, name, params);
    };

    let llmCalls = 0;
    const faux = fauxProvider({
      models: [{ id: "faux-stop-music", name: "Faux Stop Music" }],
    });
    faux.setResponses([
      // Task 1 Round 0: Cloud LLM calls control_speaker(stop) -> triggers playback_mismatch
      fauxAssistantMessage(
        [fauxToolCall("control_speaker", { target: "demo-speaker-xiaoai", playback: "stop" })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("已停止播放。", { stopReason: "stop" }),
      // Task 1 Round 1 recovery: Cloud LLM escalates to silent send_xiaoai_command("停止播放") -> passes!
      fauxAssistantMessage(
        [
          fauxToolCall("send_xiaoai_command", {
            speaker: "demo-speaker-xiaoai",
            text: "停止播放",
            silent: true,
          }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("已通过小爱指令停止播放。", { stopReason: "stop" }),
    ]);

    const h = createHarness({
      service,
      verificationOptions: {
        settleDelaysMs: [],
        speakerPlaybackSettleDelaysMs: [],
        sleep: async () => {},
      },
      customModel: faux.getModel(),
      customStreamFn: (m, ctx, opts) => {
        llmCalls += 1;
        return faux.provider.streamSimple(m, ctx, opts);
      },
    });

    try {
      await h.ready();
      await origRunAction("demo-speaker-xiaoai", "play");
      expect(await service.readProp("demo-speaker-xiaoai", "playing-state")).toBe(1);

      // --- Task 1: "停止播放。" hits playback_mismatch, heals via silent send_xiaoai_command, precipitates Skill #1 ---
      const r1 = await h.agent.prompt("停止播放。", { source: "voice" });
      expect(r1.ok).toBe(true);
      expect(r1.retriesUsed).toBe(1);
      expect(r1.verification?.status).toBe("recovered");
      expect(r1.skillEvent?.kind).toBe("created");
      expect(textDirectiveCalls).toBe(1);
      expect(pauseCalls).toBe(1);

      const skillsAfterRun1 = loadAgentSkills();
      expect(skillsAfterRun1.length).toBe(1);
      const skill1 = skillsAfterRun1[0]!;
      expect(skill1.canonicalIntentKey).toBe("speaker:stop_playback");
      expect(skill1.targetDids).toEqual(["demo-speaker-xiaoai"]);
      // send_xiaoai_command step MUST bind `speaker` cleanly (keeping `silent: true`) and NEVER inject bogus `target`!
      expect(skill1.steps).toEqual([
        {
          toolName: "send_xiaoai_command",
          args: { speaker: "demo-speaker-xiaoai", text: "停止播放", silent: true },
        },
      ]);

      // --- Task 2: Slightly varied phrasing + ASR punctuation ("停止播放音乐。") MUST reuse Skill #1 with 0 retries & 0 LLM calls! ---
      await origRunAction("demo-speaker-xiaoai", "play");
      expect(await service.readProp("demo-speaker-xiaoai", "playing-state")).toBe(1);
      const llmCallsBeforeRun2 = llmCalls;
      pauseCalls = 0;
      textDirectiveCalls = 0;

      const r2 = await h.agent.prompt("停止播放音乐。", { source: "voice" });
      expect(r2.ok).toBe(true);
      expect(r2.retriesUsed).toBe(0);
      expect(r2.retryNotices).toBeUndefined();
      expect(r2.verification?.status).toBe("passed");
      expect(r2.skillEvent?.kind).toBe("reused");
      expect(r2.skillEvent?.skillId).toBe(skill1.id);
      expect(llmCalls).toBe(llmCallsBeforeRun2); // ZERO cloud LLM round-trips!
      expect(pauseCalls).toBe(0); // NEVER stepped into the broken pause pitfall again!
      expect(textDirectiveCalls).toBe(1);
      expect(await service.readProp("demo-speaker-xiaoai", "playing-state")).toBe(2);

      // --- Tasks 3..5: Natural stop phrasings ("停止播放了。", "让小爱停止播放吧。", "别放了。") ALL reuse Skill #1 ---
      for (const phrase of ["停止播放了。", "让小爱停止播放吧。", "别放了。"]) {
        await origRunAction("demo-speaker-xiaoai", "play");
        const rx = await h.agent.prompt(phrase, { source: "voice" });
        expect(rx.ok).toBe(true);
        expect(rx.retriesUsed).toBe(0);
        expect(rx.skillEvent?.kind).toBe("reused");
        expect(rx.skillEvent?.skillId).toBe(skill1.id);
      }

      expect(llmCalls).toBe(llmCallsBeforeRun2);
      const finalSkills = loadAgentSkills();
      expect(finalSkills.length).toBe(1); // STRICTLY NO DUPLICATE SKILLS!
      expect(finalSkills[0]!.useCount).toBe(4);
      expect(finalSkills[0]!.retriesAvoided).toBe(4);
      expect(finalSkills[0]!.triggers).toContain("停止播放。");
      expect(finalSkills[0]!.triggers).toContain("停止播放音乐。");
    } finally {
      await h.cleanup();
    }
  });

  test("escalates immediately when a reused pause Skill fails, upgrades the Skill in-place without creating duplicates, and reuses upgraded Skill next time", async () => {
    const service = new VirtualDemoService();
    let pauseShouldWork = true;
    const origRunAction = service.runAction.bind(service);
    const seenActions: string[] = [];

    service.runAction = async (did: string, name: string, params?: unknown) => {
      seenActions.push(`${name}:${JSON.stringify(params ?? null)}`);
      if (did === "demo-speaker-xiaoai" && name === "pause") {
        if (pauseShouldWork) {
          return origRunAction(did, "pause");
        }
        // On Task 2, pause stops working -> playing-state remains 1!
        return;
      }
      if (did === "demo-speaker-xiaoai" && name === "execute-text-directive") {
        return origRunAction(did, "pause");
      }
      return origRunAction(did, name, params);
    };

    const h = createHarness({
      service,
      verificationOptions: {
        settleDelaysMs: [],
        speakerPlaybackSettleDelaysMs: [],
        sleep: async () => {},
      },
    });
    try {
      await h.ready();
      // Pre-seed a Skill that previously healed via control_speaker(pause)
      const seeded = saveAgentSkill({
        name: "停止播放（避坑流程）",
        description: "旧沉淀：改用 pause 停止播放",
        triggerText: "停止播放",
        targetDids: ["demo-speaker-xiaoai"],
        pitfall: "小爱音箱 Pro播放状态检查未生效：音箱仍在播放中",
        resolutionSummary: "改用暂停指令停止小爱音箱 Pro播放",
        steps: [{ toolName: "control_speaker", args: { target: "demo-speaker-xiaoai", playback: "pause" } }],
        activeDevices: h.mainWindow.activeDevices(),
      });
      expect(seeded.created).toBe(true);
      expect(loadAgentSkills().length).toBe(1);

      // Now pause stops working! Task 2 matches seeded Skill, executes pause -> fails verification!
      // Attempt 1 MUST NOT repeat pause; it escalates directly to silent send_xiaoai_command and upgrades Skill in-place!
      pauseShouldWork = false;
      await origRunAction("demo-speaker-xiaoai", "play");
      seenActions.length = 0;

      const r2 = await h.agent.prompt("停止播放音乐", { source: "voice" });
      expect(r2.ok).toBe(true);
      expect(r2.retriesUsed).toBe(1); // Escalated on Attempt 1 (did NOT waste Attempt 1 repeating pause!)
      expect(r2.verification?.status).toBe("recovered");
      expect(r2.skillEvent?.kind).toBe("updated");
      expect(r2.skillEvent?.skillId).toBe(seeded.skill.id);
      expect(r2.reply).toContain("已更新技能");
      expect(r2.reply).not.toContain("沉淀为技能");
      // First action was reused Skill's pause, second action was immediate escalation to silent execute-text-directive
      expect(seenActions[0]).toBe("pause:null");
      expect(seenActions[1]).toContain("execute-text-directive");

      const afterUpgrade = loadAgentSkills();
      expect(afterUpgrade.length).toBe(1); // STRICTLY 1 Skill (upgraded in-place, ZERO duplicates!)
      expect(afterUpgrade[0]!.id).toBe(seeded.skill.id);
      expect(afterUpgrade[0]!.steps[0]?.toolName).toBe("send_xiaoai_command");
      expect(afterUpgrade[0]!.steps[0]?.args.speaker).toBe("demo-speaker-xiaoai");
      expect(afterUpgrade[0]!.steps[0]?.args.silent).toBe(true);
      expect(afterUpgrade[0]!.steps[0]?.args.target).toBeUndefined();

      // Task 3 immediately reuses upgraded Skill with 0 retries!
      await origRunAction("demo-speaker-xiaoai", "play");
      seenActions.length = 0;
      const r3 = await h.agent.prompt("停止播放", { source: "voice" });
      expect(r3.ok).toBe(true);
      expect(r3.retriesUsed).toBe(0);
      expect(r3.skillEvent?.kind).toBe("reused");
      expect(r3.skillEvent?.skillId).toBe(seeded.skill.id);
      expect(seenActions.length).toBe(1);
      expect(seenActions[0]).toContain("execute-text-directive");
    } finally {
      await h.cleanup();
    }
  });

  test("deduplicates skills across synonyms, identical (targetDids+steps), legacy polluted targetDids, and enforces strict device/room/numeric safety", () => {
    const xiaoaiLiving = createDeviceInfo({
      did: "504337266",
      name: "小爱音箱Play",
      model: "xiaomi.wifispeaker.l05b",
      home_name: "方寸别院",
      room_name: "客厅",
      online: true,
      spec_type: "urn:miot-spec-v2:device:speaker:0000A015:xiaomi-l05b:1",
    });
    const xiaoaiBedroom = createDeviceInfo({
      did: "504337299",
      name: "卧室小爱音箱",
      model: "xiaomi.wifispeaker.l05b",
      home_name: "方寸别院",
      room_name: "卧室",
      online: true,
      spec_type: "urn:miot-spec-v2:device:speaker:0000A015:xiaomi-l05b:1",
    });
    const irAmp = createDeviceInfo({
      did: "tuya:6cb2201c8dd09d11cdacgh",
      name: "音响",
      model: "tuya.infrared_amplifier.g4epfqle2vmfaxb8",
      home_name: "我的家",
      room_name: "客厅",
      online: true,
      spec_type: "urn:tuya:device:amplifier:1",
    });
    const livingLight = createDeviceInfo({
      did: "demo-light-living",
      name: "客厅吸顶灯",
      model: "yeelink.light.ceiling1",
      home_name: "方寸别院",
      room_name: "客厅",
      online: true,
    });
    const devices = [xiaoaiLiving, xiaoaiBedroom, irAmp, livingLight];

    // 1. ASR trailing punctuation + polite particles normalization
    expect(normalizeSkillIntentKey("停止播放。")).toBe("停止播放");
    expect(normalizeSkillIntentKey("停止播放了。")).toBe("停止播放");
    expect(normalizeSkillIntentKey("请帮我停止播放一下吧。")).toBe("停止播放");
    expect(normalizeSkillIntentKey("嗨Neo，停止播放！")).toBe("停止播放");
    expect(normalizeSkillIntentKey("把客厅吸顶灯亮度调到 85%。")).toBe("客厅吸顶灯亮度调到85%");
    expect(normalizeSkillIntentKey("把客厅吸顶灯亮度调到 30%。")).toBe("客厅吸顶灯亮度调到30%");

    // 2. Saving synonymous phrasings merges into a single Skill (never creates duplicates)
    const s1 = saveAgentSkill({
      name: "停止播放（避坑流程）",
      description: "自动排错沉淀",
      triggerText: "停止播放",
      targetDids: ["504337266"],
      pitfall: "音箱仍在播放中",
      resolutionSummary: "改用小爱文本指令停止播放",
      steps: [{ toolName: "send_xiaoai_command", args: { speaker: "504337266", text: "停止播放", silent: true } }],
      activeDevices: devices,
    });
    expect(s1.created).toBe(true);

    const s2 = saveAgentSkill({
      name: "停止播放音乐（避坑流程）",
      description: "自动排错沉淀",
      triggerText: "停止播放音乐",
      targetDids: ["504337266"],
      pitfall: "音箱仍在播放中",
      resolutionSummary: "改用小爱文本指令停止播放",
      steps: [{ toolName: "send_xiaoai_command", args: { silent: true, text: "停止播放", speaker: "504337266" } }],
      activeDevices: devices,
    });
    expect(s2.created).toBe(false);
    expect(s2.stepsChanged).toBe(false);
    expect(s2.triggerAdded).toBe(true);
    expect(s2.skill.id).toBe(s1.skill.id);

    // 3. Even an arbitrary phrasing producing identical (targetDids + steps) merges via stepsSignature!
    const s3 = saveAgentSkill({
      name: "把唱歌的停掉（避坑流程）",
      description: "自动排错沉淀",
      triggerText: "别再出声了",
      targetDids: ["504337266"],
      pitfall: "音箱仍在播放中",
      resolutionSummary: "改用小爱文本指令停止播放",
      steps: [{ toolName: "send_xiaoai_command", args: { speaker: "504337266", text: "停止播放", silent: true } }],
      activeDevices: devices,
    });
    expect(s3.created).toBe(false);
    expect(s3.skill.id).toBe(s1.skill.id);
    expect(loadAgentSkills().length).toBe(1);
    expect(
      computeSkillStepsSignature([{ toolName: "control_speaker", args: { target: "504337266", playback: "pause" } }]),
    ).toBe(
      computeSkillStepsSignature([{ toolName: "control_speaker", args: { playback: "pause", target: "504337266" } }]),
    );

    // 4. Positive matches on XiaoAi stop skill
    expect(matchAgentSkill("停止播放", devices)?.id).toBe(s1.skill.id);
    expect(matchAgentSkill("停止播放音乐。", devices)?.id).toBe(s1.skill.id);
    expect(matchAgentSkill("小爱音箱Play停止播放", devices)?.id).toBe(s1.skill.id);
    expect(matchAgentSkill("小爱同学，别放了。", devices)?.id).toBe(s1.skill.id);
    expect(matchAgentSkill("把客厅小爱音箱停掉播放", devices)?.id).toBe(s1.skill.id);

    // 5. Strict negative safety guards: NEVER misroute across devices, rooms, polarity, compounds, or non-audio chores!
    expect(matchAgentSkill("让音响停止播放", devices)).toBeNull();
    expect(matchAgentSkill("让卧室小爱停止播放", devices)).toBeNull();
    expect(matchAgentSkill("继续播放音乐", devices)).toBeNull();
    expect(matchAgentSkill("取消暂停", devices)).toBeNull();
    expect(matchAgentSkill("停止播放并关闭客厅吸顶灯", devices)).toBeNull();
    expect(matchAgentSkill("停止洗衣机", devices)).toBeNull();
    expect(matchAgentSkill("停止灌溉", devices)).toBeNull();
    expect(matchAgentSkill("不要放猫粮", devices)).toBeNull();
    expect(resolveCanonicalSkillIntent("不要放猫粮", devices)).toBeNull();

    // 6. Distinct numeric targets NEVER merge or cross-match
    const b85 = saveAgentSkill({
      name: "客厅灯85%",
      description: "85%",
      triggerText: "把客厅吸顶灯亮度调到85%",
      targetDids: ["demo-light-living"],
      pitfall: "亮度未生效",
      resolutionSummary: "先开灯再设85%",
      steps: [{ toolName: "control_light", args: { target: "demo-light-living", on: true, brightness: 85 } }],
      activeDevices: devices,
    });
    const b30 = saveAgentSkill({
      name: "客厅灯30%",
      description: "30%",
      triggerText: "把客厅吸顶灯亮度调到30%",
      targetDids: ["demo-light-living"],
      pitfall: "亮度未生效",
      resolutionSummary: "先开灯再设30%",
      steps: [{ toolName: "control_light", args: { target: "demo-light-living", on: true, brightness: 30 } }],
      activeDevices: devices,
    });
    expect(b85.skill.id).not.toBe(b30.skill.id);
    expect(matchAgentSkill("客厅吸顶灯亮度调到 85%。", devices)?.id).toBe(b85.skill.id);
    expect(matchAgentSkill("客厅吸顶灯亮度调到 30%。", devices)?.id).toBe(b30.skill.id);
    expect(matchAgentSkill("客厅吸顶灯亮度调到 50%", devices)).toBeNull();

    // 7. Legacy polluted targetDids (["504337266", "小爱"]) + legacy duplicate JSON entries are healed cleanly on load
    writeFileSync(
      path.join(tmpDir, "agent_skills.json"),
      JSON.stringify({
        version: 1,
        skills: [
          {
            id: "skill_legacy_1",
            name: "停止播放（避坑流程）",
            description: "old1",
            triggers: ["停止播放"],
            normalizedIntentKey: "停止播放",
            targetDids: ["504337266", "小爱"],
            pitfall: "仍在播放",
            resolutionSummary: "改用暂停",
            steps: [{ toolName: "control_speaker", args: { target: "504337266", playback: "pause" } }],
            verification: [],
            createdFromRetry: true,
            useCount: 1,
            retriesAvoided: 1,
            enabled: true,
            createdAt: 1000,
            updatedAt: 2000,
            lastUsedAt: null,
          },
          {
            id: "skill_legacy_2",
            name: "停止播放音乐（避坑流程）",
            description: "old2",
            triggers: ["停止播放音乐"],
            normalizedIntentKey: "停止播放音乐",
            targetDids: ["504337266"],
            pitfall: "仍在播放",
            resolutionSummary: "改用暂停",
            steps: [{ toolName: "control_speaker", args: { target: "504337266", playback: "pause" } }],
            verification: [],
            createdFromRetry: true,
            useCount: 2,
            retriesAvoided: 2,
            enabled: true,
            createdAt: 1500,
            updatedAt: 3000,
            lastUsedAt: null,
          },
        ],
      }),
      "utf-8",
    );

    const coalesced = loadAgentSkills();
    expect(coalesced.length).toBe(1);
    expect(coalesced[0]!.useCount).toBe(3);
    expect(coalesced[0]!.triggers).toContain("停止播放");
    expect(coalesced[0]!.triggers).toContain("停止播放音乐");
    expect(matchAgentSkill("停止播放", devices)?.id).toBe(coalesced[0]!.id);
    const promptSec = buildSkillsPromptSection(coalesced);
    expect(promptSec).toContain("停止播放");
    expect(promptSec).toContain("覆盖常规默认参数");
  });

  test("resolves did from set_device_power recovery without targetDids alias pollution and exposes saved Skill in Cloud LLM system prompt for compound commands", async () => {
    const service = new VirtualDemoService();
    const origRunAction = service.runAction.bind(service);
    const origWriteProp = service.writeProp.bind(service);
    let stopAttempts = 0;

    service.runAction = async (did: string, name: string, params?: unknown) => {
      if (did === "demo-speaker-xiaoai" && name === "pause") {
        stopAttempts += 1;
        if (stopAttempts === 1) {
          // Round 0 fails to stop playback
          return;
        }
      }
      return origRunAction(did, name, params);
    };

    const seenSystems: string[] = [];
    const faux = fauxProvider({
      models: [{ id: "faux-power-skill", name: "Faux Power Skill" }],
    });
    faux.setResponses([
      // Task 1 Round 0: control_speaker(stop) fails verification
      fauxAssistantMessage(
        [fauxToolCall("control_speaker", { target: "demo-speaker-xiaoai", playback: "stop" })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("已停止播放。", { stopReason: "stop" }),
      // Task 1 Round 1 recovery: Cloud LLM uses set_device_power with fuzzy alias "小爱" -> succeeds!
      fauxAssistantMessage(
        [fauxToolCall("set_device_power", { target: "小爱", state: "off" })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("已将小爱静音暂停。", { stopReason: "stop" }),
      // Task 3 (compound command): falls through to Cloud LLM -> receives saved Skill in messages[0]!
      fauxAssistantMessage("已按避坑经验处理复合指令。", { stopReason: "stop" }),
    ]);

    const h = createHarness({
      service,
      verificationOptions: {
        settleDelaysMs: [],
        speakerPlaybackSettleDelaysMs: [],
        sleep: async () => {},
      },
      customModel: faux.getModel(),
      customStreamFn: (m, ctx, opts) => {
        const sys = ctx.messages[0];
        seenSystems.push(sys && typeof sys.content === "string" ? sys.content : "");
        return faux.provider.streamSimple(m, ctx, opts);
      },
    });

    try {
      await h.ready();
      await origRunAction("demo-speaker-xiaoai", "play");
      await origWriteProp("demo-speaker-xiaoai", "mute", false);

      // Task 1: recovers via set_device_power({ target: "小爱", state: "off" })
      const r1 = await h.agent.prompt("停止播放", { source: "voice" });
      expect(r1.ok).toBe(true);
      expect(r1.retriesUsed).toBe(1);
      expect(r1.skillEvent?.kind).toBe("created");

      const saved = loadAgentSkills();
      expect(saved.length).toBe(1);
      // targetDids MUST contain ONLY real did (NO "小爱" alias pollution that previously broke matchAgentSkill!)
      expect(saved[0]!.targetDids).toEqual(["demo-speaker-xiaoai"]);
      expect(saved[0]!.steps).toEqual([
        { toolName: "set_device_power", args: { target: "demo-speaker-xiaoai", state: "off" } },
      ]);

      // Task 2: immediately matches & reuses the skill (0 retries, 0 LLM calls)
      await origRunAction("demo-speaker-xiaoai", "play");
      await origWriteProp("demo-speaker-xiaoai", "mute", false);
      const systemsBeforeTask2 = seenSystems.length;
      const r2 = await h.agent.prompt("停止播放音乐", { source: "voice" });
      expect(r2.ok).toBe(true);
      expect(r2.retriesUsed).toBe(0);
      expect(r2.skillEvent?.kind).toBe("reused");
      expect(seenSystems.length).toBe(systemsBeforeTask2);

      // Task 3: compound command falls through to Cloud LLM and system prompt includes the saved Skill!
      const r3 = await h.agent.prompt("停止播放并关闭客厅吸顶灯", { source: "voice" });
      expect(r3.ok).toBe(true);
      const lastSys = seenSystems[seenSystems.length - 1] ?? "";
      expect(lastSys).toContain("已沉淀技能（Skills");
      expect(lastSys).toContain("停止播放（避坑流程）");
      expect(lastSys).toContain("demo-speaker-xiaoai");
      expect(loadAgentSkills().length).toBe(1);
    } finally {
      await h.cleanup();
    }
  });
});
