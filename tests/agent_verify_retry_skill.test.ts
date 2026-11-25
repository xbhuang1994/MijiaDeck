// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: Pi Agent 先回复“好的” -> 执行 -> 状态检查 -> 思考排错3轮重试 -> 沉淀复用 Skill 闭环测试

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  loadAgentSkills,
  matchAgentSkill,
  normalizeSkillIntentKey,
} from "../src/agent/agentSkillStore.ts";
import { PiAgentService, TASK_ACK_TEXT } from "../src/agent/piAgentService.ts";
import { MAX_RECOVERY_ROUNDS } from "../src/agent/taskVerificationLoop.ts";
import { NetworkMonitor } from "../src/core/availability.ts";
import { JobExecutor } from "../src/core/jobs.ts";
import { setDataPathOverrides } from "../src/core/jsonStore.ts";
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

      // Voice heard: "好的", retry 1 notice, retry 2 notice, verified final reply
      expect(spoken[0]).toBe("好的");
      expect(spoken.some((s) => s.includes("第1次重试"))).toBe(true);
      expect(spoken.some((s) => s.includes("第2次重试"))).toBe(true);
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
      // Voice sequence: "好的" -> retry 1 notice -> final verified reply
      expect(spoken[0]).toBe("好的");
      expect(spoken[1]).toContain("第1次重试");
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
});
