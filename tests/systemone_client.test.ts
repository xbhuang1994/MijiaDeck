// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: SystemOne 决策模型客户端单元测试

import { describe, expect, test } from "bun:test";
import {
  buildSystemOneEndpoint,
  DEFAULT_SYSTEMONE_TIMEOUT_MS,
  formatCompactHistory,
  redactSystemOneError,
  SystemOneClient,
  type CommandIntentChoice,
  type ConversationActionChoice,
  type DualTrackAsrChoice,
  type EchoCheckChoice,
  type ImplicitActionChoice,
  type TaskAckScenario,
  type WakeAttentionDecision,
  type WakeDeviceCommandDecision,
} from "../src/agent/systemOneClient.ts";
import { TASK_ACK_SCENARIOS } from "../src/agent/taskAckPolicy.ts";
import {
  DEFAULT_SYSTEMONE_MODEL,
  defaultAgentVoiceConfig,
} from "../src/core/agentConfigStore.ts";
import type { FetchLike } from "../src/core/httpTimeout.ts";

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function makeChoiceAnswer<K extends string>(
  choice: K,
  confidence: number,
  allKeys: readonly K[],
): {
  type: "choice";
  choice: K;
  probabilities: Record<K, number>;
  confidence: number;
} {
  const probs = {} as Record<K, number>;
  const others = allKeys.filter((k) => k !== choice);
  const rem = others.length > 0 ? Math.max(0, 1 - confidence) / others.length : 0;
  for (const k of allKeys) {
    probs[k] = k === choice ? confidence : Number(rem.toFixed(4));
  }
  return {
    type: "choice",
    choice,
    probabilities: probs,
    confidence,
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function createMockFetcher(
  handler: (req: RecordedRequest, callIndex: number, init?: RequestInit) => Response | Promise<Response>,
): { fetcher: FetchLike; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetcher: FetchLike = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const rawHeaders = (init?.headers ?? {}) as Record<string, string>;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawHeaders)) {
      headers[k.toLowerCase()] = String(v);
    }
    const bodyText = typeof init?.body === "string" ? init.body : "{}";
    const parsedBody = JSON.parse(bodyText) as Record<string, unknown>;
    const rec: RecordedRequest = {
      url,
      method: init?.method ?? "GET",
      headers,
      body: parsedBody,
    };
    requests.push(rec);
    return handler(rec, requests.length - 1, init);
  };
  return { fetcher, requests };
}

describe("SystemOneClient helpers & configuration", () => {
  test("buildSystemOneEndpoint normalizes trailing slashes and /systemone suffix", () => {
    expect(buildSystemOneEndpoint("https://api.example.com/v1")).toBe(
      "https://api.example.com/v1/systemone",
    );
    expect(buildSystemOneEndpoint("https://api.example.com/v1///")).toBe(
      "https://api.example.com/v1/systemone",
    );
    expect(buildSystemOneEndpoint("https://api.example.com/v1/systemone")).toBe(
      "https://api.example.com/v1/systemone",
    );
    expect(buildSystemOneEndpoint("https://api.example.com/v1/systemone/")).toBe(
      "https://api.example.com/v1/systemone",
    );
    expect(buildSystemOneEndpoint("http://127.0.0.1:8080/")).toBe(
      "http://127.0.0.1:8080/systemone",
    );
    expect(buildSystemOneEndpoint("ftp://invalid.example.com")).toBe("");
    expect(buildSystemOneEndpoint("not-a-url")).toBe("");
    expect(buildSystemOneEndpoint("")).toBe("");
  });

  test("redactSystemOneError strips sk- keys, Bearer tokens, and explicit apiKey", () => {
    const raw =
      "Upstream failed: Authorization: Bearer eyJhbGciOi.secretToken_123, key sk-proj-998877665544, custom=myRawApiKey98765";
    const redacted = redactSystemOneError(raw, "myRawApiKey98765");
    expect(redacted).not.toContain("eyJhbGciOi");
    expect(redacted).not.toContain("secretToken_123");
    expect(redacted).not.toContain("sk-proj-998877665544");
    expect(redacted).not.toContain("myRawApiKey98765");
    expect(redacted).not.toMatch(/Bearer\s+[^\[]/i);
    expect(redacted).toContain("[REDACTED]");
  });

  test("formatCompactHistory keeps only last 5 non-empty messages truncated to <= 80 chars", () => {
    const longText = "这是一段非常非常长的智能家居历史记录，用来验证每条消息都会被严格截断到不超过八十个字符以控制 SystemOne 推理延迟和输入长度限制超标情况";
    const history = [
      { role: "user" as const, text: "turn 1" },
      { role: "assistant" as const, text: "turn 2" },
      { role: "user" as const, text: "   " },
      { role: "user" as const, text: "turn 3" },
      { role: "assistant" as const, text: "turn 4" },
      { role: "user" as const, text: "turn 5" },
      { role: "assistant" as const, text: "turn 6" },
      { role: "user" as const, text: longText },
    ];
    const formatted = formatCompactHistory(history);
    expect(formatted).toHaveLength(5);
    expect(formatted[0]).toBe("U: turn 3");
    expect(formatted[1]).toBe("A: turn 4");
    expect(formatted[2]).toBe("U: turn 5");
    expect(formatted[3]).toBe("A: turn 6");
    expect(formatted[4]!.startsWith("U: ")).toBe(true);
    for (const line of formatted) {
      expect(line.length).toBeLessThanOrEqual(80);
    }
  });

  test("fromConfig resolves auth safely, supports local endpoint without key, and preconnects safely", async () => {
    const offCfg = {
      ...defaultAgentVoiceConfig(),
      provider: "openai" as const,
      apiKey: "sk-main-secret-12345678",
      systemOneMode: "off" as const,
    };
    expect(SystemOneClient.fromConfig(offCfg)).toBeNull();

    // Inherit same-origin key from main provider
    const sameOriginCfg = {
      ...defaultAgentVoiceConfig(),
      provider: "openai-compatible" as const,
      baseUrl: "https://gateway.example.com/v1",
      apiKey: "sk-main-secret-12345678",
      systemOneMode: "auto" as const,
      systemOneModel: DEFAULT_SYSTEMONE_MODEL,
    };
    const preconnectOrigins: string[] = [];
    const { fetcher, requests } = createMockFetcher(() =>
      jsonResponse({
        model: DEFAULT_SYSTEMONE_MODEL,
        answers: {
          q1: { type: "noul", noul: 0.72 },
        },
        usage: { input_tokens: 12, output_tokens: 4 },
      }),
    );
    const fetcherWithPreconnect = Object.assign(fetcher, {
      preconnect: (origin: string) => {
        preconnectOrigins.push(origin);
      },
    }) as FetchLike;

    const client = SystemOneClient.fromConfig(sameOriginCfg, fetcherWithPreconnect);
    expect(client).not.toBeNull();
    client!.preconnect();
    expect(preconnectOrigins).toEqual(["https://gateway.example.com"]);

    const res = await client!.decide("test", {
      q1: { type: "noul", instructions: "estimate likelihood" },
    });
    expect(res?.answers.q1.noul).toBe(0.72);
    expect(requests[0]!.url).toBe("https://gateway.example.com/v1/systemone");
    expect(requests[0]!.headers.authorization).toBe("Bearer sk-main-secret-12345678");

    // Local endpoint without API key should NOT send Authorization header
    const localCfg = {
      ...defaultAgentVoiceConfig(),
      systemOneMode: "on" as const,
      systemOneBaseUrl: "http://127.0.0.1:9090/",
      systemOneApiKey: "",
    };
    const { fetcher: localFetcher, requests: localReqs } = createMockFetcher(() =>
      jsonResponse({
        model: DEFAULT_SYSTEMONE_MODEL,
        answers: { q1: { type: "noul", noul: 0.5 } },
        usage: { input_tokens: 5, output_tokens: 1 },
      }),
    );
    const localClient = SystemOneClient.fromConfig(localCfg, localFetcher);
    expect(localClient).not.toBeNull();
    await localClient!.decide("ping", { q1: { type: "noul", instructions: "ok?" } });
    expect(localReqs[0]!.url).toBe("http://127.0.0.1:9090/systemone");
    expect(localReqs[0]!.headers.authorization).toBeUndefined();

    // Status never leaks secrets
    const statusJson = JSON.stringify(client!.getStatus());
    expect(statusJson).not.toContain("sk-main-secret-12345678");
    expect(client!.getStatus().endpointHost).toBe("gateway.example.com");
    expect(client!.getStatus().enabled).toBe(true);
    expect(client!.getStatus().totalCalls).toBe(1);
  });
});

describe("SystemOneClient wire protocol & 6 domain methods", () => {
  test("decide supports batched choice, score, and noul questions in a single POST", async () => {
    const { fetcher, requests } = createMockFetcher(() =>
      jsonResponse({
        model: DEFAULT_SYSTEMONE_MODEL,
        answers: {
          route: makeChoiceAnswer("fast", 0.91, ["fast", "slow"] as const),
          quality: {
            type: "score",
            score: 4,
            legend: { "1": "差", "5": "优" },
            probabilities: { "4": 0.8, "5": 0.2 },
            confidence: 0.8,
          },
          risk: {
            type: "noul",
            noul: 0.12,
          },
        },
        usage: { input_tokens: 80, output_tokens: 15 },
      }),
    );

    const client = new SystemOneClient({
      baseUrl: "https://karpo.example.com/v1/",
      apiKey: "sk-test-token-12345678",
      fetcher,
    });

    const res = await client.decide(
      ["U: 打开客厅灯"],
      {
        route: {
          type: "choice",
          instructions: "choose route",
          criteria: { fast: "fast path", slow: "slow path" },
        },
        quality: {
          type: "score",
          instructions: "rate clarity",
          criteria: ["模糊", "较清晰", "非常清晰"],
        },
        risk: {
          type: "noul",
          instructions: "estimate accidental trigger risk",
        },
      },
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe("POST");
    expect(requests[0]!.url).toBe("https://karpo.example.com/v1/systemone");
    expect(requests[0]!.body.model).toBe(DEFAULT_SYSTEMONE_MODEL);
    expect(requests[0]!.body.state).toEqual(["U: 打开客厅灯"]);

    expect(res).not.toBeNull();
    const typedChoice: "fast" | "slow" = res!.answers.route.choice;
    expect(typedChoice).toBe("fast");
    expect(res!.answers.quality.score).toBe(4);
    expect(res!.answers.risk.noul).toBe(0.12);
    expect(res!.usage).toEqual({ input_tokens: 80, output_tokens: 15 });

    // Generic decide with cacheable: true + cacheKey caches result
    const cached1 = await client.decide(
      "same-state",
      {
        route: {
          type: "choice",
          instructions: "choose route",
          criteria: { fast: "fast path", slow: "slow path" },
        },
      },
      { cacheKey: "custom-route-key", cacheable: true },
    );
    const cached2 = await client.decide(
      "same-state",
      {
        route: {
          type: "choice",
          instructions: "choose route",
          criteria: { fast: "fast path", slow: "slow path" },
        },
      },
      { cacheKey: "custom-route-key", cacheable: true },
    );
    expect(cached1?.answers.route.choice).toBe("fast");
    expect(cached2?.answers.route.choice).toBe("fast");
    expect(requests).toHaveLength(2);
    expect(client.getStatus().cacheHits).toBe(1);
  });

  test("decide rejects unknown choice key or malformed answer structure as network failure", async () => {
    const { fetcher } = createMockFetcher(() =>
      jsonResponse({
        model: DEFAULT_SYSTEMONE_MODEL,
        answers: {
          route: {
            type: "choice",
            choice: "not_in_criteria",
            probabilities: { fast: 0.5, slow: 0.5 },
            confidence: 0.9,
          },
        },
        usage: { input_tokens: 10, output_tokens: 2 },
      }),
    );

    const client = new SystemOneClient({
      baseUrl: "https://schema.example.com/v1",
      apiKey: "sk-schema-123456",
      fetcher,
    });

    const bad = await client.decide("test", {
      route: {
        type: "choice",
        instructions: "pick",
        criteria: { fast: "a", slow: "b" },
      },
    });
    expect(bad).toBeNull();
    expect(client.lastFailureKind).toBe("network");
    expect(client.getStatus().circuitState).toBe("closed");

    // 2nd malformed response trips breaker
    const bad2 = await client.decide("test", {
      route: {
        type: "choice",
        instructions: "pick",
        criteria: { fast: "a", slow: "b" },
      },
    });
    expect(bad2).toBeNull();
    expect(client.getStatus().circuitState).toBe("open");
  });

  test("(a) evaluateWakeAttention checks wake word OR device control command without context/background/intent/dual-track fields", async () => {
    let verdict: WakeAttentionDecision = "valid_wake";
    let conf = 0.72;
    let cmdVerdict: WakeDeviceCommandDecision = "no_device_command";
    let cmdConf = 0.91;
    const { fetcher, requests } = createMockFetcher(() =>
      jsonResponse({
        model: DEFAULT_SYSTEMONE_MODEL,
        answers: {
          decision: makeChoiceAnswer<WakeAttentionDecision>(verdict, conf, [
            "valid_wake",
            "false_wake",
          ]),
          device_command: makeChoiceAnswer<WakeDeviceCommandDecision>(cmdVerdict, cmdConf, [
            "has_device_command",
            "no_device_command",
          ]),
        },
        usage: { input_tokens: 90, output_tokens: 8 },
      }),
    );

    const client = new SystemOneClient({
      baseUrl: "https://karpo.example.com/v1",
      apiKey: "sk-test-wake-12345678",
      confidenceThreshold: 0.65,
      fetcher,
    });

    const res = await client.evaluateWakeAttention(
      {
        utterance: "小派，明天天气怎么样",
        wakeWords: ["小派", "Neo"],
      },
      { strict: false },
    );

    expect(requests).toHaveLength(1);
    const body = requests[0]!.body;
    const state = body.state as Record<string, unknown>;
    const questions = body.questions as Record<string, Record<string, unknown>>;

    // State must contain ONLY utterance and wake_words — no context, background, history, capabilities, or dual-track fields
    expect(Object.keys(state).sort()).toEqual(["utterance", "wake_words"]);
    expect(state.utterance).toBe("小派，明天天气怎么样");
    expect(state.wake_words).toEqual(["小派", "Neo"]);

    // Questions must contain ONLY binary `decision` + OR `device_command` (no intent, no asr_best)
    expect(Object.keys(questions).sort()).toEqual(["decision", "device_command"]);
    const criteria = questions.decision!.criteria as Record<string, string>;
    expect(Object.keys(criteria).sort()).toEqual(["false_wake", "valid_wake"]);
    expect(String(questions.decision!.instructions)).toContain("误听");
    expect(String(questions.decision!.instructions)).not.toContain("home_capabilities");
    expect(String(questions.decision!.instructions)).not.toContain("BGM");
    const cmdCriteria = questions.device_command!.criteria as Record<string, string>;
    expect(Object.keys(cmdCriteria).sort()).toEqual(["has_device_command", "no_device_command"]);

    expect(res).not.toBeNull();
    expect(res!.decision).toBe("valid_wake");
    expect(res!.accepted).toBe(true);
    expect(res!.acceptedBy).toBe("wake_word");
    expect(res!.hasDeviceCommand).toBe(false);
    expect(res!.isFalseWake).toBe(false);
    expect(res!.cached).toBe(false);

    // Same confidence 0.72 under strict mode (threshold 0.75) with no device command should NOT be accepted
    const strictRes = await client.evaluateWakeAttention(
      {
        utterance: "小派今天怎么样",
        wakeWords: ["小派"],
      },
      { strict: true },
    );
    expect(requests).toHaveLength(2);
    expect(Object.keys(requests[1]!.body.questions as Record<string, unknown>).sort()).toEqual([
      "decision",
      "device_command",
    ]);
    expect(strictRes!.accepted).toBe(false);
    expect(strictRes!.acceptedBy).toBe("none");
    expect(strictRes!.isFalseWake).toBe(true);

    // OR condition: even when decision === "false_wake", has_device_command accepts cleanly!
    verdict = "false_wake";
    conf = 0.93;
    cmdVerdict = "has_device_command";
    cmdConf = 0.94;
    const deviceCmdRes = await client.evaluateWakeAttention({
      utterance: "房间太热了，把空调打开",
      wakeWords: ["Neo"],
    });
    expect(deviceCmdRes!.decision).toBe("false_wake");
    expect(deviceCmdRes!.hasDeviceCommand).toBe(true);
    expect(deviceCmdRes!.accepted).toBe(true);
    expect(deviceCmdRes!.acceptedBy).toBe("device_command");
    expect(deviceCmdRes!.isFalseWake).toBe(false);

    // Explicit false_wake + no_device_command rejects cleanly
    verdict = "false_wake";
    conf = 0.93;
    cmdVerdict = "no_device_command";
    cmdConf = 0.95;
    const falseRes = await client.evaluateWakeAttention({
      utterance: "你哦快过来吃饭",
      wakeWords: ["Neo"],
    });
    expect(falseRes!.decision).toBe("false_wake");
    expect(falseRes!.hasDeviceCommand).toBe(false);
    expect(falseRes!.accepted).toBe(false);
    expect(falseRes!.acceptedBy).toBe("none");
    expect(falseRes!.isFalseWake).toBe(true);
  });

  test("(b) evaluateConversationTurn sends last 5 compact U:/A: turns, role boundary, and goodbye exit flag", async () => {
    let turnAction: ConversationActionChoice = "followup";
    let turnConf = 0.88;

    const { fetcher, requests } = createMockFetcher(() =>
      jsonResponse({
        model: DEFAULT_SYSTEMONE_MODEL,
        answers: {
          conv_action: makeChoiceAnswer<ConversationActionChoice>(
            turnAction,
            turnConf,
            ["followup", "side_talk", "goodbye"],
          ),
          intent: makeChoiceAnswer<CommandIntentChoice>(
            "device_control",
            0.9,
            ["device_control", "status_query", "scene", "general_chat"],
          ),
          asr_best: makeChoiceAnswer<DualTrackAsrChoice>(
            "track_a",
            0.92,
            ["track_a", "track_b", "neither_noise"],
          ),
        },
        usage: { input_tokens: 180, output_tokens: 22 },
      }),
    );

    const client = new SystemOneClient({
      baseUrl: "https://karpo.example.com/v1",
      apiKey: "sk-test-conv-12345678",
      fetcher,
    });

    const sevenTurns = [
      { role: "user" as const, text: "第一句很早的历史" },
      { role: "assistant" as const, text: "第二句很早的回复" },
      { role: "user" as const, text: "打开客厅灯" },
      { role: "assistant" as const, text: "已打开客厅吸顶灯" },
      { role: "user" as const, text: "调暗一点" },
      { role: "assistant" as const, text: "已调至 40%" },
      { role: "user" as const, text: "卧室灯也开一下" },
    ];

    const res1 = await client.evaluateConversationTurn(
      {
        utterance: "再亮一点吧",
        altUtterance: "再亮一点",
        recentHistory: sevenTurns,
        wakeWords: ["小派"],
        lastSpokenReply: "已打开卧室灯",
      },
      { includeIntent: true },
    );

    expect(requests).toHaveLength(1);
    const state = requests[0]!.body.state as Record<string, unknown>;
    const questions = requests[0]!.body.questions as Record<string, Record<string, unknown>>;

    expect(state.history).toEqual([
      "U: 打开客厅灯",
      "A: 已打开客厅吸顶灯",
      "U: 调暗一点",
      "A: 已调至 40%",
      "U: 卧室灯也开一下",
    ]);
    expect(String(questions.conv_action!.instructions)).toContain("多平台智能家居控制助手");
    expect(String(questions.conv_action!.instructions)).toContain("home_capabilities");
    expect(String(questions.conv_action!.instructions)).toContain("连续对话模式");
    expect(Object.keys(questions).sort()).toEqual(["asr_best", "conv_action", "intent"]);

    expect(res1!.action).toBe("followup");
    expect(res1!.accepted).toBe(true);
    expect(res1!.shouldExitConversation).toBe(false);
    expect(res1!.intent?.choice).toBe("device_control");
    expect(res1!.asrBest?.selectedText).toBe("再亮一点吧");

    // Goodbye >= 0.65 exits conversation
    turnAction = "goodbye";
    turnConf = 0.78;
    const resBye = await client.evaluateConversationTurn({
      utterance: "好了谢谢，不用了",
      recentHistory: sevenTurns,
    });
    expect(resBye!.action).toBe("goodbye");
    expect(resBye!.accepted).toBe(false);
    expect(resBye!.shouldExitConversation).toBe(true);

    // Goodbye < 0.65 does NOT force exit
    turnConf = 0.58;
    const resWeakBye = await client.evaluateConversationTurn({
      utterance: "嗯好吧",
      recentHistory: sevenTurns,
    });
    expect(resWeakBye!.action).toBe("goodbye");
    expect(resWeakBye!.shouldExitConversation).toBe(false);

    // Strict mode raises followup acceptance threshold from 0.65 to 0.75
    turnAction = "followup";
    turnConf = 0.7;
    const resNormalFollowup = await client.evaluateConversationTurn(
      { utterance: "再调高一点", recentHistory: sevenTurns },
      { strict: false },
    );
    const resStrictFollowup = await client.evaluateConversationTurn(
      { utterance: "再调高一点", recentHistory: sevenTurns },
      { strict: true },
    );
    expect(resNormalFollowup!.accepted).toBe(true);
    expect(resStrictFollowup!.accepted).toBe(false);
  });

  test("(c) classifyCommandIntent classifies device_control / status_query / scene / general_chat", async () => {
    const { fetcher, requests } = createMockFetcher(() =>
      jsonResponse({
        model: DEFAULT_SYSTEMONE_MODEL,
        answers: {
          intent: makeChoiceAnswer<CommandIntentChoice>(
            "status_query",
            0.95,
            ["device_control", "status_query", "scene", "general_chat"],
          ),
        },
        usage: { input_tokens: 60, output_tokens: 8 },
      }),
    );

    const client = new SystemOneClient({
      baseUrl: "https://karpo.example.com",
      apiKey: "sk-test-intent-123456",
      fetcher,
    });

    const res = await client.classifyCommandIntent({
      command: "卧室现在多少度",
      recentHistory: [{ role: "user", text: "开空调" }],
    });

    expect(requests).toHaveLength(1);
    expect((requests[0]!.body.state as Record<string, unknown>).command).toBe("卧室现在多少度");
    expect((requests[0]!.body.state as Record<string, unknown>).history).toEqual(["U: 开空调"]);
    expect(res!.intent).toBe("status_query");
    expect(res!.confidence).toBe(0.95);
  });

  test("(d) selectDualTrackAsr selects track_a / track_b / neither_noise", async () => {
    let picked: DualTrackAsrChoice = "track_b";
    const { fetcher, requests } = createMockFetcher(() =>
      jsonResponse({
        model: DEFAULT_SYSTEMONE_MODEL,
        answers: {
          asr_best: makeChoiceAnswer<DualTrackAsrChoice>(
            picked,
            0.91,
            ["track_a", "track_b", "neither_noise"],
          ),
        },
        usage: { input_tokens: 75, output_tokens: 10 },
      }),
    );

    const client = new SystemOneClient({
      baseUrl: "https://karpo.example.com",
      apiKey: "sk-test-asr-123456",
      fetcher,
    });

    const res = await client.selectDualTrackAsr({
      trackA: "爱上你小拍关灯",
      trackB: "小派关闭卧室灯",
      wakeWords: ["小派"],
      acousticEvent: "<|BGM|>",
      inputSnrDb: 4.26,
    });

    expect(requests).toHaveLength(1);
    const state = requests[0]!.body.state as Record<string, unknown>;
    expect(state.track_a).toBe("爱上你小拍关灯");
    expect(state.track_b).toBe("小派关闭卧室灯");
    expect(state.input_snr_db).toBe(4.3);
    expect(res!.choice).toBe("track_b");
    expect(res!.selectedText).toBe("小派关闭卧室灯");

    picked = "neither_noise";
    const noiseRes = await client.selectDualTrackAsr({
      trackA: "啦啦啦风吹过",
      trackB: "风吹过夏天",
      wakeWords: ["小派"],
    });
    expect(noiseRes!.choice).toBe("neither_noise");
    expect(noiseRes!.selectedText).toBe("");
  });

  test("(e) classifyEchoOrCommand distinguishes TTS echo from opposite user command", async () => {
    let choice: EchoCheckChoice = "user_command";
    const { fetcher, requests } = createMockFetcher(() =>
      jsonResponse({
        model: DEFAULT_SYSTEMONE_MODEL,
        answers: {
          echo_check: makeChoiceAnswer<EchoCheckChoice>(choice, 0.93, ["echo", "user_command"]),
        },
        usage: { input_tokens: 55, output_tokens: 7 },
      }),
    );

    const client = new SystemOneClient({
      baseUrl: "https://karpo.example.com",
      apiKey: "sk-test-echo-123456",
      fetcher,
    });

    const cmdRes = await client.classifyEchoOrCommand({
      lastSpoken: "已关闭客厅吸顶灯",
      heard: "打开客厅吸顶灯",
    });
    expect(requests).toHaveLength(1);
    expect(cmdRes!.choice).toBe("user_command");
    expect(cmdRes!.isEcho).toBe(false);

    choice = "echo";
    const echoRes = await client.classifyEchoOrCommand({
      lastSpoken: "已关闭客厅吸顶灯",
      heard: "关闭客厅吸顶灯",
    });
    expect(echoRes!.choice).toBe("echo");
    expect(echoRes!.isEcho).toBe(true);
  });

  test("(f) classifyImplicitAction maps complaints to quick actions or needs_llm_agent", async () => {
    let action: ImplicitActionChoice = "light_brighter";
    let conf = 0.89;
    const { fetcher } = createMockFetcher(() =>
      jsonResponse({
        model: DEFAULT_SYSTEMONE_MODEL,
        answers: {
          implicit_action: makeChoiceAnswer<ImplicitActionChoice>(action, conf, [
            "light_brighter",
            "light_dimmer",
            "speaker_quieter",
            "speaker_louder",
            "power_off",
            "power_on",
            "query_status",
            "needs_llm_agent",
          ]),
        },
        usage: { input_tokens: 70, output_tokens: 9 },
      }),
    );

    const client = new SystemOneClient({
      baseUrl: "https://karpo.example.com",
      apiKey: "sk-test-implicit-123456",
      fetcher,
    });

    const r1 = await client.classifyImplicitAction({
      utterance: "这里有点暗，看不清书",
      recentHistory: [{ role: "assistant", text: "已打开书房台灯" }],
    });
    expect(r1!.action).toBe("light_brighter");
    expect(r1!.needsAgent).toBe(false);

    action = "needs_llm_agent";
    conf = 0.85;
    const r2 = await client.classifyImplicitAction({
      utterance: "把卧室灯调成暖白色 3500K 然后十分钟后关掉",
    });
    expect(r2!.action).toBe("needs_llm_agent");
    expect(r2!.needsAgent).toBe(true);

    // Low confidence also falls back to needsAgent = true
    action = "speaker_quieter";
    conf = 0.45;
    const r3 = await client.classifyImplicitAction({ utterance: "有点杂音" });
    expect(r3!.needsAgent).toBe(true);
  });

  test("(g) classifyTaskAck selects scenario-specific short ack, handles ZH/EN, low confidence, and caller abort", async () => {
    let scenario: TaskAckScenario = "query_status";
    let conf = 0.94;
    let delayMs = 0;
    const { fetcher, requests } = createMockFetcher(async (_req, _idx, init) => {
      if (delayMs > 0) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, delayMs);
          init?.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
          );
        });
      }
      return jsonResponse({
        model: DEFAULT_SYSTEMONE_MODEL,
        answers: {
          task_ack: makeChoiceAnswer<TaskAckScenario>(scenario, conf, TASK_ACK_SCENARIOS),
        },
        usage: { input_tokens: 95, output_tokens: 1 },
      });
    });

    const client = new SystemOneClient({
      baseUrl: "https://karpo.example.com/v1",
      apiKey: "sk-test-ack-123456",
      fetcher,
    });

    const r1 = await client.classifyTaskAck({
      utterance: "空调设置的多少度",
      source: "voice",
      recentHistory: [{ role: "user", text: "打开空调" }],
    });
    expect(requests).toHaveLength(1);
    const state = requests[0]!.body.state as Record<string, unknown>;
    expect(state.utterance).toBe("空调设置的多少度");
    expect(state.source).toBe("voice");
    expect(state.history).toEqual(["U: 打开空调"]);
    expect(r1!.scenario).toBe("query_status");
    expect(r1!.ackText).toBe("稍等我看一下");
    expect(r1!.confident).toBe(true);

    // Pure English utterance maps to concise English ack phrase
    scenario = "think_creative";
    conf = 0.88;
    const r2 = await client.classifyTaskAck({ utterance: "Tell me a joke" });
    expect(r2!.scenario).toBe("think_creative");
    expect(r2!.ackText).toBe("Let me think");
    expect(r2!.confident).toBe(true);

    // Low confidence marks confident = false
    conf = 0.3;
    const r3 = await client.classifyTaskAck({ utterance: "嗯..." });
    expect(r3!.confident).toBe(false);

    // Caller AbortSignal cancels cleanly without counting as a SystemOne failure
    delayMs = 200;
    const ac = new AbortController();
    const pending = client.classifyTaskAck({ utterance: "给我讲个笑话" }, { signal: ac.signal });
    setTimeout(() => ac.abort(), 20);
    const rAborted = await pending;
    expect(rAborted).toBeNull();
    expect(client.lastFailureKind).toBe("none");
    expect(client.getStatus().circuitState).toBe("closed");
  });
});

describe("SystemOneClient circuit breaker & failure classification", () => {
  test("HTTP 404/405/501 trips immediately on 1st failure for 10 min with unsupported-endpoint", async () => {
    for (const statusCode of [404, 405, 501]) {
      let nowMs = 1_000_000;
      let calls = 0;
      const { fetcher } = createMockFetcher(() => {
        calls += 1;
        return new Response(
          `Not supported for Bearer secretTok_${statusCode} sk-leak-99999999`,
          { status: statusCode },
        );
      });

      const client = new SystemOneClient({
        baseUrl: "https://unsupported.example.com/v1",
        apiKey: "sk-leak-99999999",
        fetcher,
        now: () => nowMs,
      });

      const first = await client.decide("hi", {
        q: { type: "noul", instructions: "ok" },
      });
      expect(first).toBeNull();
      expect(calls).toBe(1);
      expect(client.lastFailureKind).toBe("unsupported");

      const st = client.getStatus();
      expect(st.circuitState).toBe("open");
      expect(st.openReason).toBe("unsupported-endpoint");
      expect(st.retryAfterMs).toBe(600_000);
      // Error stored in status must redact secrets
      expect(st.lastError).not.toContain("sk-leak-99999999");
      expect(st.lastError).not.toContain(`secretTok_${statusCode}`);

      // Subsequent calls within 10 min are short-circuited
      nowMs += 300_000;
      const second = await client.decide("hi2", {
        q: { type: "noul", instructions: "ok" },
      });
      expect(second).toBeNull();
      expect(calls).toBe(1);
      expect(client.getStatus().retryAfterMs).toBe(300_000);
    }
  });

  test("HTTP 401/403 trips immediately on 1st failure for 5 min with auth-error", async () => {
    for (const statusCode of [401, 403]) {
      let nowMs = 2_000_000;
      const { fetcher, requests } = createMockFetcher(
        () => new Response("Invalid key sk-auth-secret-8888", { status: statusCode }),
      );
      const client = new SystemOneClient({
        baseUrl: "https://auth.example.com/v1",
        apiKey: "sk-auth-secret-8888",
        fetcher,
        now: () => nowMs,
      });

      const res = await client.decide("hi", { q: { type: "noul", instructions: "ok" } });
      expect(res).toBeNull();
      expect(requests).toHaveLength(1);
      expect(client.lastFailureKind).toBe("auth");

      const st = client.getStatus();
      expect(st.circuitState).toBe("open");
      expect(st.openReason).toBe("auth-error");
      expect(st.retryAfterMs).toBe(300_000);
      expect(JSON.stringify(st)).not.toContain("sk-auth-secret-8888");
    }
  });

  test("5xx / 429 / invalid JSON trips after 2 consecutive failures with 30s->60s->120s->300s backoff and half-open recovery", async () => {
    let nowMs = 5_000_000;
    let mode: "fail500" | "fail429" | "invalidJson" | "ok" = "fail500";
    let fetchCount = 0;

    const { fetcher } = createMockFetcher(() => {
      fetchCount += 1;
      if (mode === "fail500") return new Response("internal error", { status: 500 });
      if (mode === "fail429") return new Response("rate limit", { status: 429 });
      if (mode === "invalidJson") return new Response("<<<not json>>>", { status: 200 });
      return jsonResponse({
        model: DEFAULT_SYSTEMONE_MODEL,
        answers: { q: { type: "noul", noul: 0.9 } },
        usage: { input_tokens: 10, output_tokens: 2 },
      });
    });

    const client = new SystemOneClient({
      baseUrl: "https://transient.example.com/v1",
      apiKey: "sk-transient-123456",
      fetcher,
      now: () => nowMs,
    });

    const ask = () => client.decide("ping", { q: { type: "noul", instructions: "ok" } });

    // Failure #1 -> stays closed
    expect(await ask()).toBeNull();
    expect(client.getStatus().circuitState).toBe("closed");
    expect(client.lastFailureKind).toBe("network");

    // Success resets consecutive count
    mode = "ok";
    expect((await ask())?.answers.q.noul).toBe(0.9);
    expect(client.lastFailureKind).toBe("none");

    // Failure #1 (invalid JSON) -> still closed
    mode = "invalidJson";
    expect(await ask()).toBeNull();
    expect(client.getStatus().circuitState).toBe("closed");

    // Failure #2 (429) -> opens for 30s
    mode = "fail429";
    expect(await ask()).toBeNull();
    expect(client.getStatus().circuitState).toBe("open");
    expect(client.getStatus().openReason).toBe("transient-failures");
    expect(client.getStatus().retryAfterMs).toBe(30_000);
    const countWhenOpened = fetchCount;

    // Short-circuited during cooldown
    nowMs += 15_000;
    expect(await ask()).toBeNull();
    expect(fetchCount).toBe(countWhenOpened);

    // After 30s -> half-open; failing probe doubles backoff to 60s
    nowMs += 15_000;
    expect(client.getStatus().circuitState).toBe("half-open");
    expect(await ask()).toBeNull();
    expect(fetchCount).toBe(countWhenOpened + 1);
    expect(client.getStatus().circuitState).toBe("open");
    expect(client.getStatus().retryAfterMs).toBe(60_000);

    // After 60s -> half-open; failing probe doubles backoff to 120s
    nowMs += 60_000;
    expect(await ask()).toBeNull();
    expect(client.getStatus().retryAfterMs).toBe(120_000);

    // After 120s -> half-open; failing probe increases backoff to 300s
    nowMs += 120_000;
    expect(await ask()).toBeNull();
    expect(client.getStatus().retryAfterMs).toBe(300_000);

    // After 300s -> half-open; failing probe stays capped at 300s
    nowMs += 300_000;
    expect(await ask()).toBeNull();
    expect(client.getStatus().retryAfterMs).toBe(300_000);

    // After 300s -> half-open probe SUCCEEDS -> resets to closed and backoff resets to 30s
    nowMs += 300_000;
    mode = "ok";
    const recovered = await ask();
    expect(recovered?.answers.q.noul).toBe(0.9);
    expect(client.getStatus().circuitState).toBe("closed");
    expect(client.getStatus().openReason).toBeNull();
    expect(client.lastFailureKind).toBe("none");

    // Verify backoff reset back to 30s after recovery
    mode = "fail500";
    expect(await ask()).toBeNull();
    expect(client.getStatus().circuitState).toBe("closed");
    expect(await ask()).toBeNull();
    expect(client.getStatus().circuitState).toBe("open");
    expect(client.getStatus().retryAfterMs).toBe(30_000);
  });

  test("timeout error sets lastFailureKind='timeout' and trips after 2 consecutive timeouts", async () => {
    let nowMs = 9_000_000;
    const hangingFetcher: FetchLike = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const sig = init?.signal;
        if (sig?.aborted) {
          reject(sig.reason ?? new DOMException("Timed out", "TimeoutError"));
          return;
        }
        sig?.addEventListener(
          "abort",
          () => {
            reject(sig.reason ?? new DOMException("Timed out", "TimeoutError"));
          },
          { once: true },
        );
      });

    const client = new SystemOneClient({
      baseUrl: "https://slow.example.com/v1",
      apiKey: "sk-timeout-123456",
      timeoutMs: 30,
      fetcher: hangingFetcher,
      now: () => nowMs,
    });

    expect(DEFAULT_SYSTEMONE_TIMEOUT_MS).toBe(2_000);

    expect(await client.decide("slow1", { q: { type: "noul", instructions: "ok" } })).toBeNull();
    expect(client.lastFailureKind).toBe("timeout");
    expect(client.getStatus().circuitState).toBe("closed");

    expect(await client.decide("slow2", { q: { type: "noul", instructions: "ok" } })).toBeNull();
    expect(client.lastFailureKind).toBe("timeout");
    expect(client.getStatus().circuitState).toBe("open");
    expect(client.getStatus().retryAfterMs).toBe(30_000);
  });

  test("reset() restores closed breaker state and clears negative LRU cache", async () => {
    let nowMs = 1_000;
    let shouldFail = false;
    let fetchCount = 0;

    const { fetcher } = createMockFetcher(() => {
      fetchCount += 1;
      if (shouldFail) return new Response("not found", { status: 404 });
      return jsonResponse({
        model: DEFAULT_SYSTEMONE_MODEL,
        answers: {
          decision: makeChoiceAnswer<WakeAttentionDecision>(
            "false_wake",
            0.96,
            ["valid_wake", "false_wake"],
          ),
          device_command: makeChoiceAnswer<WakeDeviceCommandDecision>(
            "no_device_command",
            0.96,
            ["has_device_command", "no_device_command"],
          ),
        },
        usage: { input_tokens: 40, output_tokens: 6 },
      });
    });

    const client = new SystemOneClient({
      baseUrl: "https://reset.example.com/v1",
      apiKey: "sk-reset-123456",
      fetcher,
      now: () => nowMs,
    });

    // Populate negative cache with `false_wake`
    const r1 = await client.evaluateWakeAttention({ utterance: "聊到小派不错", wakeWords: ["小派"] });
    expect(r1!.decision).toBe("false_wake");
    expect(r1!.cached).toBe(false);
    expect(fetchCount).toBe(1);

    // Hit cache
    const r2 = await client.evaluateWakeAttention({ utterance: "聊到小派不错", wakeWords: ["小派"] });
    expect(r2!.cached).toBe(true);
    expect(fetchCount).toBe(1);

    // Trip breaker with 404 on a different utterance
    shouldFail = true;
    expect(
      await client.evaluateWakeAttention({ utterance: "另一个句子", wakeWords: ["小派"] }),
    ).toBeNull();
    expect(client.getStatus().circuitState).toBe("open");
    expect(fetchCount).toBe(2);

    // Reset clears breaker + cache
    client.reset();
    expect(client.getStatus().circuitState).toBe("closed");
    expect(client.getStatus().openReason).toBeNull();
    expect(client.lastFailureKind).toBe("none");

    shouldFail = false;
    const r3 = await client.evaluateWakeAttention({ utterance: "聊到小派不错", wakeWords: ["小派"] });
    expect(r3!.cached).toBe(false);
    expect(fetchCount).toBe(3);
  });

  test("network exceptions redact secrets and concurrent half-open calls issue only one probe", async () => {
    let nowMs = 20_000_000;
    let callCount = 0;
    let releaseProbe: (() => void) | null = null;

    const fetcher: FetchLike = () => {
      callCount += 1;
      if (callCount <= 2) {
        return Promise.reject(
          new Error("ECONNREFUSED with Bearer topSecretToken99 and sk-net-secret-777777"),
        );
      }
      return new Promise<Response>((resolve) => {
        releaseProbe = () => {
          resolve(
            jsonResponse({
              model: DEFAULT_SYSTEMONE_MODEL,
              answers: { q: { type: "noul", noul: 0.8 } },
              usage: { input_tokens: 8, output_tokens: 2 },
            }),
          );
        };
      });
    };

    const client = new SystemOneClient({
      baseUrl: "https://net.example.com/v1",
      apiKey: "sk-net-secret-777777",
      fetcher,
      now: () => nowMs,
    });

    const ask = () => client.decide("hi", { q: { type: "noul", instructions: "ok" } });
    expect(await ask()).toBeNull();
    expect(await ask()).toBeNull();
    expect(client.lastFailureKind).toBe("network");
    expect(client.getStatus().circuitState).toBe("open");
    expect(client.getStatus().lastError).not.toContain("topSecretToken99");
    expect(client.getStatus().lastError).not.toContain("sk-net-secret-777777");

    // Advance past 30s cooldown into half-open
    nowMs += 30_000;
    const probe1 = ask();
    const probe2 = ask(); // concurrent call while probe1 is in-flight should short-circuit

    expect(await probe2).toBeNull();
    expect(callCount).toBe(3);

    releaseProbe!();
    const probe1Res = await probe1;
    expect(probe1Res?.answers.q.noul).toBe(0.8);
    expect(client.getStatus().circuitState).toBe("closed");
  });
});

describe("SystemOneClient negative LRU cache", () => {
  test("caches false_wake/side_talk/goodbye, NEVER caches valid_wake/followup, expires after 10s", async () => {
    let nowMs = 100_000;
    let wakeVerdict: WakeAttentionDecision = "false_wake";
    let convVerdict: ConversationActionChoice = "side_talk";
    let fetchCount = 0;

    const { fetcher } = createMockFetcher((req) => {
      fetchCount += 1;
      const questions = req.body.questions as Record<string, unknown>;
      if ("decision" in questions) {
        return jsonResponse({
          model: DEFAULT_SYSTEMONE_MODEL,
          answers: {
            decision: makeChoiceAnswer<WakeAttentionDecision>(
              wakeVerdict,
              0.92,
              ["valid_wake", "false_wake"],
            ),
            device_command: makeChoiceAnswer<WakeDeviceCommandDecision>(
              "no_device_command",
              0.92,
              ["has_device_command", "no_device_command"],
            ),
          },
          usage: { input_tokens: 50, output_tokens: 8 },
        });
      }
      return jsonResponse({
        model: DEFAULT_SYSTEMONE_MODEL,
        answers: {
          conv_action: makeChoiceAnswer<ConversationActionChoice>(
            convVerdict,
            0.91,
            ["followup", "side_talk", "goodbye"],
          ),
        },
        usage: { input_tokens: 50, output_tokens: 8 },
      });
    });

    const client = new SystemOneClient({
      baseUrl: "https://cache.example.com/v1",
      apiKey: "sk-cache-123456",
      fetcher,
      now: () => nowMs,
    });

    // 1. `false_wake` IS cached
    wakeVerdict = "false_wake";
    const ig1 = await client.evaluateWakeAttention({ utterance: "背景歌词片段", wakeWords: ["小派"] });
    expect(ig1!.cached).toBe(false);
    expect(ig1!.isFalseWake).toBe(true);
    expect(fetchCount).toBe(1);

    nowMs += 5_000;
    const ig2 = await client.evaluateWakeAttention({ utterance: "背景歌词片段", wakeWords: ["小派"] });
    expect(ig2!.cached).toBe(true);
    expect(ig2!.latencyMs).toBe(0);
    expect(fetchCount).toBe(1);
    expect(client.getStatus().cacheHits).toBe(1);

    // Expires at exact TTL (10_000ms from storedAt)
    nowMs += 5_000;
    const ig3 = await client.evaluateWakeAttention({ utterance: "背景歌词片段", wakeWords: ["小派"] });
    expect(ig3!.cached).toBe(false);
    expect(fetchCount).toBe(2);

    // 2. `valid_wake` is NEVER cached (neither pure wake nor wake+command)
    wakeVerdict = "valid_wake";
    const vw1 = await client.evaluateWakeAttention({ utterance: "小派在吗", wakeWords: ["小派"] });
    const vw2 = await client.evaluateWakeAttention({ utterance: "小派在吗", wakeWords: ["小派"] });
    expect(vw1!.accepted).toBe(true);
    expect(vw1!.cached).toBe(false);
    expect(vw2!.cached).toBe(false);
    expect(fetchCount).toBe(4);

    const dc1 = await client.evaluateWakeAttention({ utterance: "小派开灯", wakeWords: ["小派"] });
    const dc2 = await client.evaluateWakeAttention({ utterance: "小派开灯", wakeWords: ["小派"] });
    expect(dc1!.cached).toBe(false);
    expect(dc2!.cached).toBe(false);
    expect(fetchCount).toBe(6);

    // 3. `side_talk` and `goodbye` ARE cached
    convVerdict = "side_talk";
    const st1 = await client.evaluateConversationTurn({
      utterance: "晚饭吃什么",
      recentHistory: [{ role: "user", text: "开灯" }],
    });
    const st2 = await client.evaluateConversationTurn({
      utterance: "晚饭吃什么",
      recentHistory: [{ role: "user", text: "开灯" }],
    });
    expect(st1!.cached).toBe(false);
    expect(st2!.cached).toBe(true);
    expect(fetchCount).toBe(7);

    convVerdict = "goodbye";
    const gb1 = await client.evaluateConversationTurn({
      utterance: "好了谢谢",
      recentHistory: [{ role: "user", text: "开灯" }],
    });
    const gb2 = await client.evaluateConversationTurn({
      utterance: "好了谢谢",
      recentHistory: [{ role: "user", text: "开灯" }],
    });
    expect(gb1!.shouldExitConversation).toBe(true);
    expect(gb2!.cached).toBe(true);
    expect(fetchCount).toBe(8);

    // 4. `followup` is NEVER cached
    convVerdict = "followup";
    const fu1 = await client.evaluateConversationTurn({
      utterance: "再亮一点",
      recentHistory: [{ role: "user", text: "开灯" }],
    });
    const fu2 = await client.evaluateConversationTurn({
      utterance: "再亮一点",
      recentHistory: [{ role: "user", text: "开灯" }],
    });
    expect(fu1!.accepted).toBe(true);
    expect(fu1!.cached).toBe(false);
    expect(fu2!.cached).toBe(false);
    expect(fetchCount).toBe(10);
  });

  test("evicts least-recently-used entry when cache exceeds max 64 entries", async () => {
    let nowMs = 500_000;
    let fetchCount = 0;

    const { fetcher } = createMockFetcher(() => {
      fetchCount += 1;
      return jsonResponse({
        model: DEFAULT_SYSTEMONE_MODEL,
        answers: {
          decision: makeChoiceAnswer<WakeAttentionDecision>(
            "false_wake",
            0.95,
            ["valid_wake", "false_wake"],
          ),
          device_command: makeChoiceAnswer<WakeDeviceCommandDecision>(
            "no_device_command",
            0.95,
            ["has_device_command", "no_device_command"],
          ),
        },
        usage: { input_tokens: 30, output_tokens: 5 },
      });
    });

    const client = new SystemOneClient({
      baseUrl: "https://lru.example.com/v1",
      apiKey: "sk-lru-123456",
      fetcher,
      now: () => nowMs,
    });

    // Fill all 64 slots: item-0 .. item-63
    for (let i = 0; i < 64; i += 1) {
      await client.evaluateWakeAttention({ utterance: `bgm-lyric-${i}`, wakeWords: ["小派"] });
    }
    expect(fetchCount).toBe(64);

    // Touch item-0 so item-1 becomes least recently used
    const touched = await client.evaluateWakeAttention({
      utterance: "bgm-lyric-0",
      wakeWords: ["小派"],
    });
    expect(touched!.cached).toBe(true);
    expect(fetchCount).toBe(64);

    // Insert 65th item -> should evict item-1, keep item-0
    await client.evaluateWakeAttention({ utterance: "bgm-lyric-64", wakeWords: ["小派"] });
    expect(fetchCount).toBe(65);

    const stillCached = await client.evaluateWakeAttention({
      utterance: "bgm-lyric-0",
      wakeWords: ["小派"],
    });
    expect(stillCached!.cached).toBe(true);
    expect(fetchCount).toBe(65);

    const evicted = await client.evaluateWakeAttention({
      utterance: "bgm-lyric-1",
      wakeWords: ["小派"],
    });
    expect(evicted!.cached).toBe(false);
    expect(fetchCount).toBe(66);
  });
});
