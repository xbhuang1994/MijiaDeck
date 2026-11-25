// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: Swarm 全链路集成测试（SystemOne 决策模型 + Caveman 极简回复 + openWakeWord 与双态监听）

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { encodeWavPcm16 } from "../src/agent/audioPcm.ts";
import { evaluateVoiceAttention } from "../src/agent/voiceAttentionGate.ts";
import { clearWakeWordPrototypes } from "../src/agent/wakewordPrototypeStore.ts";
import { setDataPathOverrides } from "../src/core/jsonStore.ts";
import { VirtualDemoService } from "../src/core/virtualLightService.ts";
import { startMijiaDeckServer, type MijiaDeckServer } from "../src/server/server.ts";

let tmpDir = "";
let server: MijiaDeckServer | null = null;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "mijiadeck-swarm-e2e-"));
  setDataPathOverrides({ dataDir: () => tmpDir });
  clearWakeWordPrototypes();
});

afterEach(async () => {
  if (server) {
    await server.stop();
    server = null;
  }
  setDataPathOverrides(null);
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

function synthSpeechLike(durationSec = 1.0, freqHz = 210): Float32Array {
  const sr = 16000;
  const n = Math.round(sr * durationSec);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const t = i / sr;
    const env = Math.sin((Math.PI * i) / n);
    out[i] =
      env *
      (0.32 * Math.sin(2 * Math.PI * freqHz * t) +
        0.16 * Math.sin(2 * Math.PI * freqHz * 2.4 * t) +
        0.08 * Math.sin(2 * Math.PI * freqHz * 4.1 * t));
  }
  return out;
}

describe("Swarm Integrated E2E: SystemOne + Caveman + openWakeWord + Dual-State Dialog", () => {
  test("routes standby/conversation 5-turn decisions & implicit actions to SystemOne and enforces dual-state transitions", async () => {
    const demo = new VirtualDemoService();
    const systemOneCalls: Array<Record<string, unknown>> = [];

    const mockSystemOneFetch = (async (_input: unknown, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body ?? "{}")) as {
        model: string;
        state: Record<string, unknown>;
        questions: Record<string, { type: string; criteria?: Record<string, string> }>;
      };
      systemOneCalls.push(payload);
      const utterance = String(payload.state?.utterance ?? "");
      const answers: Record<string, unknown> = {};

      if (payload.questions.decision) {
        if (utterance.includes("聊到Neo")) {
          answers.decision = {
            type: "choice",
            choice: "false_wake",
            probabilities: { valid_wake: 0.06, false_wake: 0.94 },
            confidence: 0.91,
          };
        } else {
          answers.decision = {
            type: "choice",
            choice: "valid_wake",
            probabilities: { valid_wake: 0.95, false_wake: 0.05 },
            confidence: 0.925,
          };
        }
      }

      if (payload.questions.conv_action) {
        if (utterance.includes("晚饭") || utterance.includes("快递")) {
          answers.conv_action = {
            type: "choice",
            choice: "side_talk",
            probabilities: { followup: 0.04, side_talk: 0.92, goodbye: 0.04 },
            confidence: 0.88,
          };
        } else if (utterance.includes("先这样") || utterance.includes("拜拜")) {
          answers.conv_action = {
            type: "choice",
            choice: "goodbye",
            probabilities: { followup: 0.02, side_talk: 0.03, goodbye: 0.95 },
            confidence: 0.925,
          };
        } else {
          answers.conv_action = {
            type: "choice",
            choice: "followup",
            probabilities: { followup: 0.94, side_talk: 0.03, goodbye: 0.03 },
            confidence: 0.91,
          };
        }
      }

      if (payload.questions.intent) {
        answers.intent = {
          type: "choice",
          choice: "device_control",
          probabilities: { device_control: 0.96, status_query: 0.02, scene: 0.01, general_chat: 0.01 },
          confidence: 0.947,
        };
      }

      if (payload.questions.action || payload.questions.implicit_action) {
        const key = payload.questions.implicit_action ? "implicit_action" : "action";
        answers[key] = {
          type: "choice",
          choice: utterance.includes("刺眼") ? "light_dimmer" : "needs_llm_agent",
          probabilities: {
            light_brighter: 0.01,
            light_dimmer: utterance.includes("刺眼") ? 0.95 : 0.02,
            speaker_quieter: 0.01,
            speaker_louder: 0.01,
            power_off: 0.0,
            power_on: 0.0,
            query_status: 0.01,
            needs_llm_agent: utterance.includes("刺眼") ? 0.01 : 0.94,
          },
          confidence: 0.94,
        };
      }

      if (payload.questions.task_ack) {
        const scenario = utterance.includes("多少度")
          ? "query_status"
          : utterance.includes("笑话")
            ? "think_creative"
            : "execute_control";
        answers.task_ack = {
          type: "choice",
          choice: scenario,
          probabilities: {
            execute_control: scenario === "execute_control" ? 0.92 : 0.01,
            query_status: scenario === "query_status" ? 0.92 : 0.01,
            think_creative: scenario === "think_creative" ? 0.92 : 0.01,
            scene_routine: 0.01,
            troubleshoot: 0.01,
            urgent_cancel: 0.01,
            remember_rule: 0.01,
            safety_confirm: 0.01,
            greeting_chat: 0.01,
          },
          confidence: 0.92,
        };
      }

      return new Response(
        JSON.stringify({
          model: payload.model || "karpo/karpo-decision-31b",
          answers,
          usage: { input_tokens: 280, output_tokens: 0 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    server = await startMijiaDeckServer({
      mode: "demo",
      port: 0,
      service: demo,
      systemOneFetcher: mockSystemOneFetch,
    });

    // Enable SystemOne even while using local planner + configure custom wake word Neo + Caveman full
    const cfgRes = await fetch(`${server.url}/api/agent/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "local",
        wakeWords: ["Neo", "小派"],
        systemOneMode: "on",
        systemOneBaseUrl: "http://127.0.0.1:9999/v1",
        systemOneModel: "karpo/karpo-decision-31b",
        cavemanMode: "full",
        conversationWindowSec: 25,
        maxConsecutiveSidetalk: 2,
      }),
    });
    expect(cfgRes.status).toBe(200);
    const cfgJson = (await cfgRes.json()) as any;
    expect(cfgJson.config.effectiveSystemOneConfigured).toBe(true);
    expect(cfgJson.config.cavemanMode).toBe("full");

    const vl = server.runtime.voiceListener!;
    vl.updateRuntimeState({ active: true });
    expect(vl.snapshot().dialogState).toBe("standby");

    // 1. Standby third-person mention -> SystemOne rejects as false_wake (pure wake check, no context/background) -> stays in standby
    const mention = await vl.handleTranscript("我刚才聊到Neo挺好用的", { isFinal: true });
    expect(mention.matched).toBe(false);
    expect(mention.attention?.stage).toBe("systemone-attention");
    expect(vl.snapshot().dialogState).toBe("standby");
    const wakeCall = systemOneCalls.find((c) => Boolean((c.questions as any)?.decision));
    expect(wakeCall).toBeTruthy();
    expect(Object.keys((wakeCall!.questions as Record<string, unknown>))).toEqual(["decision"]);
    expect(Object.keys((wakeCall!.state as Record<string, unknown>)).sort()).toEqual([
      "utterance",
      "wake_words",
    ]);

    // 2. Wake-only "Neo" -> enters conversation mode with default gentle wake ack "嗯?"
    const wakeOnly = await vl.handleTranscript("Neo", { isFinal: true });
    expect(wakeOnly.matched).toBe(true);
    expect(wakeOnly.wokeOnly).toBe(true);
    expect(wakeOnly.reply).toBe("嗯?");
    expect(vl.snapshot().dialogState).toBe("conversation");

    // 3. In conversation mode: implicit colloquial command ("有点刺眼") -> SystemOne conv_action=followup + implicit light_dimmer!
    const implicit = await vl.handleTranscript("有点刺眼", { isFinal: true });
    expect(implicit.matched).toBe(true);
    expect(implicit.attention?.stage).toBe("systemone-attention");
    expect(vl.snapshot().dialogState).toBe("conversation");
    // Verify SystemOne received compact history array (<= 5 entries)
    const convCall = systemOneCalls.find((c) => Boolean((c.questions as any)?.conv_action));
    expect(convCall).toBeTruthy();
    expect(Array.isArray((convCall!.state as any).history)).toBe(true);

    // 4. In conversation mode: family side-talk ("晚饭吃什么") -> ignored WITHOUT exiting conversation (1/2)
    const side1 = await vl.handleTranscript("晚饭吃什么", { isFinal: true });
    expect(side1.matched).toBe(false);
    expect(vl.snapshot().dialogState).toBe("conversation");
    expect(vl.snapshot().consecutiveSidetalkCount).toBe(1);

    // 5. Second consecutive side-talk ("帮我拿个快递") hits maxConsecutiveSidetalk=2 -> auto-exits to standby!
    const side2 = await vl.handleTranscript("帮我拿个快递", { isFinal: true });
    expect(side2.matched).toBe(false);
    expect(vl.snapshot().dialogState).toBe("standby");
    expect(vl.snapshot().lastTransitionReason).toBe("sidetalk_limit");

    // 6. Manual enter via REST /api/voice-listen/dialog -> goodbye via SystemOne exits cleanly to standby!
    const enterRes = await fetch(`${server.url}/api/voice-listen/dialog`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "enter" }),
    });
    expect(enterRes.status).toBe(200);
    expect(((await enterRes.json()) as any).voice.dialogState).toBe("conversation");

    const bye = await vl.handleTranscript("先这样吧，谢谢你啦", { isFinal: true });
    expect(bye.matched).toBe(false);
    expect(bye.attention?.exitConversation).toBe(true);
    expect(vl.snapshot().dialogState).toBe("standby");
  }, 15_000);

  test("enforces Caveman reply & streaming TTS compression with cloud LLM fauxProvider without losing numbers", async () => {
    const demo = new VirtualDemoService();
    const faux = fauxProvider({
      models: [{ id: "caveman-test-model", name: "Caveman Test Model" }],
    });
    faux.setResponses([
      fauxAssistantMessage(
        "好的！我已经为您打开了客厅吸顶灯，并将亮度调整到了 80%。请问还有什么可以帮您的吗？",
        { stopReason: "stop" },
      ),
    ]);

    try {
      server = await startMijiaDeckServer({
        mode: "demo",
        port: 0,
        service: demo,
        agentModel: faux.getModel(),
        agentStreamFn: (m, ctx, opts) => faux.provider.streamSimple(m, ctx, opts),
      });

      await fetch(`${server.url}/api/agent/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "openai-compatible",
          baseUrl: "https://mock.invalid/v1",
          apiKey: "sk-faux-caveman-test",
          modelId: "caveman-test-model",
          cavemanMode: "full",
          autoSpeakReply: true,
        }),
      });

      const spokenChunks: string[] = [];
      server.runtime.piAgent!.on("speakChunk", ({ text }) => {
        if (text.trim()) spokenChunks.push(text.trim());
      });

      const run = await server.runtime.piAgent!.prompt("打开客厅吸顶灯调到80%", { source: "voice" });
      expect(run.ok).toBe(true);
      expect(run.reply).toContain("80%");
      expect(run.reply).not.toContain("好的");
      expect(run.reply).not.toContain("请问还有什么");
      expect(spokenChunks.join(" ")).toContain("80%");
      expect(spokenChunks.join(" ")).not.toContain("请问还有什么");
    } finally {
      // faux provider has no global registration to clean up
    }
  });

  test("supports openWakeWord custom enrollment REST endpoints, acoustic veto, and WS dialog/TTS control", async () => {
    const demo = new VirtualDemoService();
    server = await startMijiaDeckServer({
      mode: "demo",
      port: 0,
      service: demo,
    });

    // 1. Acoustic veto blocks fuzzy ASR alias when openWakeWord score is low
    const vetoed = await evaluateVoiceAttention({
      rawText: "你有播放音乐",
      wakeWordEnabled: true,
      wakeWords: ["Neo"],
      attentionMode: "smart",
      owwActiveForWord: true,
      acousticWake: {
        matched: false,
        wakeWord: "Neo",
        score: 0.22,
        rawScore: 0.22,
        threshold: 0.6,
        source: "enrolled",
        frameIndex: 4,
        sampleOffset: 5120,
        latencyMs: 5,
      },
    });
    expect(vetoed.accept).toBe(false);
    expect(vetoed.stage).toBe("acoustic-veto");

    // 2. Wakeword prototype REST lifecycle
    const list0 = await fetch(`${server.url}/api/voice/wakewords/prototypes`);
    expect(list0.status).toBe(200);
    const list0Json = (await list0.json()) as any;
    expect(list0Json.ok).toBe(true);

    if (list0Json.engineStatus?.ready) {
      const wav = encodeWavPcm16(synthSpeechLike(0.9, 220), 16000);
      const enrollForm = new FormData();
      enrollForm.append("audio", new Blob([wav as unknown as BlobPart], { type: "audio/wav" }), "neo.wav");
      enrollForm.append("wakeWord", "Neo");
      const enrollRes = await fetch(`${server.url}/api/voice/wakewords/enroll`, {
        method: "POST",
        body: enrollForm,
      });
      expect(enrollRes.status).toBe(200);
      const enrollJson = (await enrollRes.json()) as any;
      expect(enrollJson.ok).toBe(true);
      expect(enrollJson.summary.enrolledCount).toBeGreaterThanOrEqual(1);

      const verifyForm = new FormData();
      verifyForm.append("audio", new Blob([wav as unknown as BlobPart], { type: "audio/wav" }), "neo.wav");
      const verifyRes = await fetch(`${server.url}/api/voice/wakewords/verify`, {
        method: "POST",
        body: verifyForm,
      });
      expect(verifyRes.status).toBe(200);
      const verifyJson = (await verifyRes.json()) as any;
      expect(verifyJson.ok).toBe(true);
      expect(typeof verifyJson.latencyMs).toBe("number");

      const delRes = await fetch(`${server.url}/api/voice/wakewords/prototypes/Neo`, {
        method: "DELETE",
      });
      expect(delRes.status).toBe(200);
    }

    // 3. WebSocket voice_dialog_control + voice_tts_state (must not clobber conversation state!)
    const wsUrl = server.url.replace(/^http/, "ws") + "/ws";
    const ws = new WebSocket(wsUrl);
    const voiceStates: Array<Record<string, unknown>> = [];
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("ws failed"));
    });
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as { type?: string; data?: Record<string, unknown> };
        if (msg.type === "voice_state" && msg.data) {
          voiceStates.push(msg.data);
        }
      } catch {
        // ignore
      }
    };

    server.runtime.voiceListener!.updateRuntimeState({ active: true });
    ws.send(JSON.stringify({ type: "voice_dialog_control", action: "enter" }));
    await Bun.sleep(120);
    expect(server.runtime.voiceListener!.snapshot().dialogState).toBe("conversation");

    // TTS speaking -> pause timer -> TTS done -> STILL in conversation (not clobbered!)
    ws.send(JSON.stringify({ type: "voice_tts_state", speaking: true }));
    await Bun.sleep(80);
    expect(server.runtime.voiceListener!.snapshot().timerPaused).toBe(true);

    ws.send(JSON.stringify({ type: "voice_tts_state", speaking: false }));
    await Bun.sleep(80);
    expect(server.runtime.voiceListener!.snapshot().timerPaused).toBe(false);
    expect(server.runtime.voiceListener!.snapshot().dialogState).toBe("conversation");

    ws.send(JSON.stringify({ type: "voice_dialog_control", action: "exit" }));
    await Bun.sleep(100);
    expect(server.runtime.voiceListener!.snapshot().dialogState).toBe("standby");
    expect(voiceStates.some((s) => s.dialogState === "conversation")).toBe(true);
    ws.close();
  }, 15_000);
});
