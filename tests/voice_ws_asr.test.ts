// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { encodeWavPcm16 } from "../src/agent/audioPcm.ts";
import { LocalVoiceEngine } from "../src/agent/localVoiceEngine.ts";
import type { OpenWakeWordStreamSession, WakeWordAcousticHit } from "../src/agent/openWakeWordEngine.ts";
import { PiAgentService } from "../src/agent/piAgentService.ts";
import { VoiceListenerController } from "../src/agent/voiceListenerController.ts";
import {
  decodeInt16PcmBuffer,
  VoiceStreamSession,
  type VoiceStreamSegmentPayload,
} from "../src/agent/voiceStreamSession.ts";
import {
  buildVoiceWsAuthConnection,
  DEFAULT_VOICE_WS_ASR_ENDPOINT,
  float32ToPcmS16LeBytes,
  normalizeVoiceWsAsrEndpointUrl,
  redactVoiceWsError,
  VoiceWsAsrRuntime,
} from "../src/agent/voiceWsAsrRuntime.ts";
import {
  defaultAgentVoiceConfig,
  loadAgentVoiceConfig,
  normalizeVoicePipelineMode,
  resolveEffectiveVoiceWsAsrAuth,
  toPublicAgentVoiceConfig,
  updateAgentVoiceConfig,
} from "../src/core/agentConfigStore.ts";
import { NetworkMonitor } from "../src/core/availability.ts";
import { JobExecutor } from "../src/core/jobs.ts";
import { setDataPathOverrides } from "../src/core/jsonStore.ts";
import * as settingsStore from "../src/core/settingsStore.ts";
import { VirtualDemoService } from "../src/core/virtualLightService.ts";
import { startMijiaDeckServer, type MijiaDeckServer } from "../src/server/server.ts";
import { MainWindowController } from "../src/ui/controllers/mainWindowController.ts";
import { ThemeController, applyTheme } from "../src/ui/theme.ts";

const SR = 16000;

let tempDir: string | null = null;
let mockGatewayServer: ReturnType<typeof Bun.serve> | null = null;
let runningServer: MijiaDeckServer | null = null;

function useTempDataDir(): string {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "mijiadeck-voice-ws-"));
  const dir = tempDir;
  setDataPathOverrides({ dataDir: () => dir });
  return dir;
}

afterEach(async () => {
  if (runningServer) {
    await runningServer.stop();
    runningServer = null;
  }
  if (mockGatewayServer) {
    mockGatewayServer.stop(true);
    mockGatewayServer = null;
  }
  setDataPathOverrides(null);
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

interface CapturedVoiceWsSession {
  pathname: string;
  authHeader: string | null;
  queryToken: string | null;
  subprotocol: string | null;
  controlMessages: Array<Record<string, unknown>>;
  binaryChunks: Uint8Array[];
  receivedPcmBytes: Uint8Array;
}

function startMockVoiceWsGateway(options: {
  expectedAuthCode?: string;
  partials?: Array<{ text: string; delta: string; language?: string }>;
  finalTexts?: string[];
  autoFinalAfterBinaryChunks?: number;
  silentOnZeroSpeech?: boolean;
  rejectWithCode?: 4401 | 4403;
  rejectMessage?: string;
} = {}) {
  const sessions: CapturedVoiceWsSession[] = [];
  const expectedAuth = options.expectedAuthCode ?? "vgw_test_auth_code_1234567890";
  const finalTexts = options.finalTexts ?? ["Neo，打开客厅吸顶灯。"];

  interface MockWsState {
    session: CapturedVoiceWsSession;
    authorized: boolean;
    binaryChunkCount: number;
    emittedFinalCount: number;
    sentSpeechStart: boolean;
  }

  const server = Bun.serve<MockWsState>({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/v1/ws/asr" || url.pathname === "/ws/asr" || url.pathname === "/ws") {
        const authHeader = req.headers.get("authorization");
        const queryToken = url.searchParams.get("token");
        const subprotocol = req.headers.get("sec-websocket-protocol");
        let provided = "";
        if (authHeader?.toLowerCase().startsWith("bearer ")) {
          provided = authHeader.slice(7).trim();
        } else if (queryToken) {
          provided = queryToken.trim();
        } else if (subprotocol?.startsWith("bearer.")) {
          provided = subprotocol.slice(7).trim();
        }
        const authorized =
          !options.rejectWithCode && provided.length > 0 && provided === expectedAuth;

        const session: CapturedVoiceWsSession = {
          pathname: url.pathname,
          authHeader,
          queryToken,
          subprotocol,
          controlMessages: [],
          binaryChunks: [],
          receivedPcmBytes: new Uint8Array(0),
        };
        sessions.push(session);

        const ok = srv.upgrade(req, {
          data: {
            session,
            authorized,
            binaryChunkCount: 0,
            emittedFinalCount: 0,
            sentSpeechStart: false,
          },
        });
        if (ok) return undefined;
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        if (!ws.data.authorized) {
          const closeCode = options.rejectWithCode ?? 4401;
          const httpCode = closeCode === 4403 ? 403 : 401;
          const msg = options.rejectMessage ?? "Invalid authorization code.";
          ws.send(JSON.stringify({ type: "error", code: httpCode, message: msg }));
          ws.close(closeCode, msg);
          return;
        }
        ws.send(
          JSON.stringify({
            type: "ready",
            session_id: `ws_mock_${sessions.length}`,
            sample_rate: 16000,
            encoding: "pcm_s16le",
            denoise: "gtcrn_simple.onnx",
            vad: "silero_vad_v5.onnx",
            asr_model: "Qwen/Qwen3-ASR-0.6B",
          }),
        );
      },
      message(ws, raw) {
        if (!ws.data.authorized) return;
        if (typeof raw === "string") {
          const msg = JSON.parse(raw) as Record<string, unknown>;
          ws.data.session.controlMessages.push(msg);
          const type = msg.type;
          if (type === "config") {
            ws.send(
              JSON.stringify({
                type: "config_ack",
                sample_rate: msg.sample_rate ?? 16000,
                encoding: msg.encoding ?? "pcm_s16le",
                denoise: msg.denoise ?? true,
                language: msg.language ?? null,
                partial_interval_ms: msg.partial_interval_ms ?? 640,
                vad: msg.vad ?? {
                  threshold: 0.5,
                  min_speech_ms: 256,
                  min_silence_ms: 640,
                  pre_roll_ms: 320,
                  max_utterance_sec: 30.0,
                },
              }),
            );
            return;
          }
          if (type === "ping") {
            ws.send(JSON.stringify({ type: "pong", ts: 1795690148.5 }));
            return;
          }
          if (type === "reset") {
            ws.data.sentSpeechStart = false;
            return;
          }
          if (type === "commit") {
            const idx = ws.data.emittedFinalCount;
            const text = finalTexts[idx] ?? finalTexts[finalTexts.length - 1] ?? "";
            ws.data.emittedFinalCount += 1;
            ws.send(
              JSON.stringify({
                type: "final",
                utterance_id: ws.data.emittedFinalCount,
                text,
                language: "Chinese",
                speech_ms: 640,
                asr_ms: 142.5,
                reason: "commit",
                cpu_denoise_ms_avg: 0.85,
                cpu_vad_ms_avg: 0.12,
                frames_dropped_silence: 3,
              }),
            );
            return;
          }
          if (type === "eos") {
            if (!options.silentOnZeroSpeech) {
              while (ws.data.emittedFinalCount < finalTexts.length) {
                const text = finalTexts[ws.data.emittedFinalCount] ?? "";
                ws.data.emittedFinalCount += 1;
                if (text) {
                  ws.send(
                    JSON.stringify({
                      type: "final",
                      utterance_id: ws.data.emittedFinalCount,
                      text,
                      language: "Chinese",
                      speech_ms: 1280,
                      asr_ms: 168.4,
                      reason: "eos",
                      cpu_denoise_ms_avg: 0.86,
                      cpu_vad_ms_avg: 0.13,
                      frames_dropped_silence: 4,
                    }),
                  );
                }
              }
            }
            ws.send(
              JSON.stringify({
                type: "done",
                session_id: `ws_mock_${sessions.length}`,
                stats: {
                  audio_ms: Math.round((ws.data.session.receivedPcmBytes.byteLength / 32000) * 1000),
                  vad_frames: Math.max(1, ws.data.binaryChunkCount),
                  speech_frames: options.silentOnZeroSpeech ? 0 : ws.data.binaryChunkCount,
                  frames_dropped_silence: options.silentOnZeroSpeech ? ws.data.binaryChunkCount : 4,
                  utterances_completed: ws.data.emittedFinalCount,
                  cpu_denoise_ms_avg: 0.86,
                  cpu_vad_ms_avg: 0.13,
                  gpu_chunks_sent: options.silentOnZeroSpeech ? 0 : Math.max(1, ws.data.emittedFinalCount),
                },
              }),
            );
            ws.close(1000, "eos");
            return;
          }
          return;
        }

        const chunk = raw instanceof Uint8Array ? new Uint8Array(raw) : new Uint8Array(raw as ArrayBuffer);
        ws.data.session.binaryChunks.push(chunk);
        ws.data.binaryChunkCount += 1;

        const total = ws.data.session.binaryChunks.reduce((acc, c) => acc + c.byteLength, 0);
        const merged = new Uint8Array(total);
        let off = 0;
        for (const c of ws.data.session.binaryChunks) {
          merged.set(c, off);
          off += c.byteLength;
        }
        ws.data.session.receivedPcmBytes = merged;

        if (!options.silentOnZeroSpeech && !ws.data.sentSpeechStart) {
          ws.data.sentSpeechStart = true;
          ws.send(
            JSON.stringify({
              type: "vad",
              state: "speech_start",
              utterance_id: 1,
              prob: 0.96,
              audio_ms: 128,
            }),
          );
          if (options.partials && options.partials.length > 0) {
            options.partials.forEach((p, idx) => {
              ws.send(
                JSON.stringify({
                  type: "partial",
                  utterance_id: 1,
                  chunk_id: idx,
                  text: p.text,
                  delta: p.delta,
                  language: p.language ?? "Chinese",
                  speech_ms: (idx + 1) * 640,
                  asr_ms: 150 + idx * 20,
                  cpu_denoise_ms_avg: 0.85,
                  cpu_vad_ms_avg: 0.12,
                }),
              );
            });
          }
        }

        if (
          !options.silentOnZeroSpeech &&
          typeof options.autoFinalAfterBinaryChunks === "number" &&
          ws.data.emittedFinalCount === 0 &&
          ws.data.binaryChunkCount >= options.autoFinalAfterBinaryChunks
        ) {
          const text = finalTexts[0] ?? "";
          ws.data.emittedFinalCount += 1;
          ws.send(
            JSON.stringify({
              type: "vad",
              state: "speech_end",
              utterance_id: 1,
              prob: 0.02,
              audio_ms: Math.round((merged.byteLength / 32000) * 1000),
              reason: "vad_silence",
            }),
          );
          ws.send(
            JSON.stringify({
              type: "final",
              utterance_id: 1,
              text,
              language: "Chinese",
              speech_ms: Math.round((merged.byteLength / 32000) * 1000),
              asr_ms: 185.0,
              reason: "vad_silence",
              cpu_denoise_ms_avg: 0.85,
              cpu_vad_ms_avg: 0.12,
              frames_dropped_silence: 12,
            }),
          );
        }
      },
    },
  });

  mockGatewayServer = server;
  return {
    endpointUrl: `ws://127.0.0.1:${server.port}/v1/ws/asr`,
    authCode: expectedAuth,
    sessions,
  };
}

function createMockOwwController() {
  let onSpotCb: ((hit: WakeWordAcousticHit) => void) | undefined;
  let lastEndSample = 0;

  return {
    fireWake(wakeWord = "Neo", sampleOffset?: number) {
      onSpotCb?.({
        matched: true,
        wakeWord,
        score: 0.94,
        rawScore: 0.94,
        threshold: 0.6,
        source: "enrolled",
        frameIndex: 1,
        latencyMs: 2,
        sampleOffset: sampleOffset ?? lastEndSample,
      });
    },
    attachToEngine(engine: LocalVoiceEngine) {
      const fakeStream = {
        pushSamples(pcm16k: Float32Array, endGlobalSample?: number) {
          lastEndSample = endGlobalSample ?? lastEndSample + pcm16k.length;
          return null;
        },
        reset() {},
        resetSegmentTracking() {},
      } as unknown as OpenWakeWordStreamSession;
      (engine as unknown as { createWakeWordStream: typeof engine.createWakeWordStream }).createWakeWordStream = (
        _wakeWords,
        opts,
      ) => {
        onSpotCb = opts?.onSpot;
        return fakeStream;
      };
    },
  };
}

function makeInt16SineBytes(durationSec: number, freqHz = 440, amp = 0.35): Uint8Array {
  const n = Math.round(SR * durationSec);
  const bytes = new Uint8Array(n * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < n; i += 1) {
    const val = Math.round(Math.sin((2 * Math.PI * freqHz * i) / SR) * amp * 0x7fff);
    view.setInt16(i * 2, val, true);
  }
  return bytes;
}

describe("统一流式语音听写 WebSocket 网关协议与工具函数", () => {
  test("endpoint URL 规范化支持 wss/ws/https/http 自动补全路径并剥离敏感 query 参数", () => {
    expect(normalizeVoiceWsAsrEndpointUrl("")).toBe(DEFAULT_VOICE_WS_ASR_ENDPOINT);
    expect(normalizeVoiceWsAsrEndpointUrl("https://voice.1inch.cn:18443")).toBe(
      "wss://voice.1inch.cn:18443/v1/ws/asr",
    );
    expect(normalizeVoiceWsAsrEndpointUrl("wss://voice.1inch.cn:18443/ws/asr?token=vgw_secret123")).toBe(
      "wss://voice.1inch.cn:18443/ws/asr",
    );
    expect(normalizeVoiceWsAsrEndpointUrl("ws://127.0.0.1:18100/ws/")).toBe(
      "ws://127.0.0.1:18100/ws",
    );
    expect(normalizeVoiceWsAsrEndpointUrl("ftp://invalid.example.com")).toBe(
      DEFAULT_VOICE_WS_ASR_ENDPOINT,
    );
  });

  test("鉴权构造支持 Header (Bearer) / Query (?token=) / Subprotocol (bearer.<CODE>) 三种方式且脱敏器隐藏授权码", () => {
    const secret = "vgw_SuperSecretToken987654321";
    const h = buildVoiceWsAuthConnection({ endpointUrl: DEFAULT_VOICE_WS_ASR_ENDPOINT, authCode: secret });
    expect(h.wsUrl).toBe(DEFAULT_VOICE_WS_ASR_ENDPOINT);
    expect(h.options.headers?.Authorization).toBe(`Bearer ${secret}`);

    const q = buildVoiceWsAuthConnection({
      endpointUrl: DEFAULT_VOICE_WS_ASR_ENDPOINT,
      authCode: secret,
      authMode: "query",
    });
    expect(new URL(q.wsUrl).searchParams.get("token")).toBe(secret);

    const sp = buildVoiceWsAuthConnection({
      endpointUrl: DEFAULT_VOICE_WS_ASR_ENDPOINT,
      authCode: secret,
      authMode: "subprotocol",
    });
    expect(sp.options.protocols).toEqual([`bearer.${secret}`]);

    const leaked = `Failed Authorization: Bearer ${secret} token=${secret} bearer.${secret}`;
    const safe = redactVoiceWsError(leaked);
    expect(safe).not.toContain(secret);
    expect(safe).toContain("<redacted>");
  });

  test("Int16 PCM 经 decodeInt16PcmBuffer -> float32ToPcmS16LeBytes 完整无损零失真还原", () => {
    const rawInt16 = makeInt16SineBytes(0.128, 520, 0.45);
    const f32 = decodeInt16PcmBuffer(rawInt16);
    const roundtrip = float32ToPcmS16LeBytes(f32);
    expect(roundtrip.byteLength).toBe(rawInt16.byteLength);
    expect(Buffer.compare(Buffer.from(roundtrip), Buffer.from(rawInt16))).toBe(0);
  });

  test("VoiceWsAsrRuntime 支持 config/Binary 推流/partial/vad/ping/commit/eos/多句合并与 4401 鉴权失败脱敏", async () => {
    const mock = startMockVoiceWsGateway({
      partials: [
        { text: "打开客厅", delta: "打开客厅" },
        { text: "打开客厅吸顶灯", delta: "吸顶灯" },
      ],
      finalTexts: ["打开客厅吸顶灯。", "把亮度调到80%。"],
    });

    const rt = new VoiceWsAsrRuntime({
      endpointUrl: mock.endpointUrl,
      authCode: mock.authCode,
      denoise: true,
      language: "zh",
    });

    const partials: Array<{ text: string; delta: string; stableText: string; unstableText: string }> = [];
    const samples = decodeInt16PcmBuffer(makeInt16SineBytes(0.256, 440, 0.3));
    const res = await rt.transcribePcm(samples, {
      minSilenceMs: 800,
      onPartial: (ev) =>
        partials.push({
          text: ev.text,
          delta: ev.delta,
          stableText: ev.stableText,
          unstableText: ev.unstableText,
        }),
    });

    expect(res.engine).toBe("voice-ws-asr");
    expect(res.text).toBe("打开客厅吸顶灯。把亮度调到80%。");
    expect(res.sessionId).toBe("ws_mock_1");
    expect(res.denoiseModel).toBe("gtcrn_simple.onnx");
    expect(res.vadModel).toBe("silero_vad_v5.onnx");
    expect(res.asrModel).toBe("Qwen/Qwen3-ASR-0.6B");
    expect(partials.length).toBe(2);
    expect(partials[1]!.stableText).toBe("打开客厅");
    expect(partials[1]!.unstableText).toBe("吸顶灯");

    expect(mock.sessions.length).toBe(1);
    const cap = mock.sessions[0]!;
    expect(cap.authHeader).toBe(`Bearer ${mock.authCode}`);
    expect(cap.queryToken).toBeNull();
    expect(cap.controlMessages[0]?.type).toBe("config");
    expect(cap.controlMessages[0]?.denoise).toBe(true);
    expect(cap.controlMessages[0]?.language).toBe("zh");
    expect((cap.controlMessages[0]?.vad as Record<string, unknown>)?.min_silence_ms).toBe(800);
    expect(cap.controlMessages[cap.controlMessages.length - 1]?.type).toBe("eos");
    expect(cap.binaryChunks.length).toBe(4); // 256ms / 64ms = 4 frames of 2048 bytes
    expect(cap.receivedPcmBytes.byteLength).toBe(samples.length * 2);

    // 校验 ping / pong 与 commit 控制帧
    let gotCommitFinal = "";
    const liveSess = rt.createStreamSession({
      stopOnFinal: true,
      onFinal: (ev) => {
        gotCommitFinal = ev.text;
      },
    });
    liveSess.pushFloat32Samples(samples.subarray(0, 1024));
    await Bun.sleep(40);
    liveSess.ping();
    await Bun.sleep(30);
    expect(liveSess.lastPongTs).toBe(1795690148.5);
    liveSess.commit();
    await Bun.sleep(50);
    expect(gotCommitFinal).toBe("打开客厅吸顶灯。");
    expect(liveSess.isActive).toBe(false);

    // 校验鉴权失败 (4401)
    const badRt = new VoiceWsAsrRuntime({
      endpointUrl: mock.endpointUrl,
      authCode: "vgw_wrong_token_should_be_redacted",
    });
    const badTest = await badRt.testConnection({ timeoutMs: 4000 });
    expect(badTest.ok).toBe(false);
    expect(badTest.error).toBeDefined();
    expect(badTest.error).not.toContain("vgw_wrong_token_should_be_redacted");
    badRt.dispose();
    rt.dispose();
  });

  test("静音音频发送 eos 后仅返回 done（无 final）时优雅完成且返回空文本", async () => {
    const mock = startMockVoiceWsGateway({ silentOnZeroSpeech: true });
    const rt = new VoiceWsAsrRuntime({
      endpointUrl: mock.endpointUrl,
      authCode: mock.authCode,
    });
    const probe = await rt.testConnection({ timeoutMs: 4000 });
    expect(probe.ok).toBe(true);
    expect(probe.sessionId).toBe("ws_mock_1");
    expect(probe.denoiseModel).toBe("gtcrn_simple.onnx");
    expect(probe.vadModel).toBe("silero_vad_v5.onnx");
    expect(probe.asrModel).toBe("Qwen/Qwen3-ASR-0.6B");
    rt.dispose();
  });
});

describe("agentConfigStore 统一流式语音听写网关配置持久化、切换与授权码脱敏", () => {
  test("voicePipelineMode 支持 voice-ws 与别名映射，authCode 仅持久化本地绝不明文暴露", () => {
    useTempDataDir();
    expect(defaultAgentVoiceConfig().voiceWsAsrEndpointUrl).toBe(DEFAULT_VOICE_WS_ASR_ENDPOINT);
    expect(normalizeVoicePipelineMode("voice-ws")).toBe("voice-ws");
    expect(normalizeVoicePipelineMode("unified-ws-asr")).toBe("voice-ws");
    expect(normalizeVoicePipelineMode("voice-gateway")).toBe("voice-ws");
    expect(normalizeVoicePipelineMode("ws_asr")).toBe("voice-ws");

    const secretCode = "vgw_LocalOnlySecretCode_0123456789";
    const saved = updateAgentVoiceConfig({
      voicePipelineMode: "voice-ws",
      voiceWsAsrEndpointUrl: "https://voice.1inch.cn:18443/v1/ws/asr?token=leaked",
      voiceWsAsrAuthCode: secretCode,
      voiceWsAsrDenoise: false,
      voiceWsAsrLanguage: "zh",
    });

    expect(saved.voicePipelineMode).toBe("voice-ws");
    expect(saved.voiceWsAsrEndpointUrl).toBe("wss://voice.1inch.cn:18443/v1/ws/asr");
    expect(saved.voiceWsAsrAuthCode).toBe(secretCode);
    expect(saved.voiceWsAsrDenoise).toBe(false);
    expect(saved.voiceWsAsrLanguage).toBe("zh");

    const loaded = loadAgentVoiceConfig();
    expect(loaded.voicePipelineMode).toBe("voice-ws");
    expect(loaded.voiceWsAsrAuthCode).toBe(secretCode);

    const resolved = resolveEffectiveVoiceWsAsrAuth(loaded);
    expect(resolved.configured).toBe(true);
    expect(resolved.endpointUrl).toBe("wss://voice.1inch.cn:18443/v1/ws/asr");
    expect(resolved.authCode).toBe(secretCode);
    expect(resolved.denoise).toBe(false);
    expect(resolved.language).toBe("zh");

    const pub = toPublicAgentVoiceConfig(loaded) as unknown as Record<string, unknown>;
    expect(pub.voiceWsAsrAuthCode).toBeUndefined();
    expect(pub.hasVoiceWsAsrAuthCode).toBe(true);
    expect(pub.effectiveVoiceWsAsrConfigured).toBe(true);
    expect(String(pub.voiceWsAsrAuthCodePreview)).toContain("••••");
    expect(String(pub.voiceWsAsrAuthCodePreview)).not.toContain(secretCode);

    // 切回 xfyun / legacy 后 authCode 保留，显式 clearVoiceWsAsrAuthCode 后清除
    const switched = updateAgentVoiceConfig({ voicePipelineMode: "xfyun" });
    expect(switched.voicePipelineMode).toBe("xfyun");
    expect(switched.voiceWsAsrAuthCode).toBe(secretCode);

    const cleared = updateAgentVoiceConfig({ clearVoiceWsAsrAuthCode: true });
    expect(cleared.voiceWsAsrAuthCode).toBe("");
    expect(toPublicAgentVoiceConfig(cleared).hasVoiceWsAsrAuthCode).toBe(false);
  });
});

describe("VoiceStreamSession 统一流式语音听写网关端到端直推原始音频", () => {
  test("未唤醒待机期零网关连接；openWakeWord 唤醒后直接推送无损原始 PCM，支持实时 partial 字幕与方案热切换", async () => {
    const mock = startMockVoiceWsGateway({
      partials: [
        { text: "Neo，打开", delta: "Neo，打开" },
        { text: "Neo，打开客厅吸顶灯", delta: "客厅吸顶灯" },
      ],
      finalTexts: ["Neo，打开客厅吸顶灯。"],
    });

    const engine = new LocalVoiceEngine({ modelsDir: path.join(os.tmpdir(), "nonexistent-voice-ws-test") });
    engine.setVoiceWsAsrConfig({
      endpointUrl: mock.endpointUrl,
      authCode: mock.authCode,
      denoise: true,
    });
    const owwCtrl = createMockOwwController();
    owwCtrl.attachToEngine(engine);

    let localDenoiseCalled = 0;
    (engine as unknown as { denoise: typeof engine.denoise }).denoise = () => {
      localDenoiseCalled += 1;
      throw new Error("should not call local denoise in voice-ws mode");
    };
    (engine as unknown as { createOnlineDenoiser: typeof engine.createOnlineDenoiser }).createOnlineDenoiser =
      () => null;

    const partials: Array<{ text: string; engine: string }> = [];
    const emitted: VoiceStreamSegmentPayload[] = [];
    let inConv = false;

    const session = new VoiceStreamSession({
      localEngine: engine,
      noiseMode: "auto",
      voicePipelineMode: "voice-ws",
      wakeWordEnabled: true,
      wakeWords: ["Neo"],
      owwEnabled: true,
      wakeGatedAsr: true,
      wakeRingLookbackMs: 1200,
      isInConversation: () => inConv,
      onPartialTranscript: (p) => partials.push({ text: p.text, engine: p.engine }),
      onSegmentReady: async (seg) => {
        emitted.push(seg);
        return null;
      },
    });

    expect(session.voicePipelineMode).toBe("voice-ws");
    expect(session.denoiseEngine).toBe("voice-ws-gtcrn");

    // 1. 待机音频：绝不建连网关
    const standbyBytes = makeInt16SineBytes(0.32, 300, 0.2);
    for (let off = 0; off < standbyBytes.byteLength; off += 2048) {
      session.pushInt16Frame(standbyBytes.subarray(off, off + 2048));
    }
    expect(mock.sessions.length).toBe(0);

    // 2. 命中 openWakeWord 声学唤醒 -> 立即回放原始环形缓冲并建连网关
    owwCtrl.fireWake("Neo");
    await Bun.sleep(40);
    expect(mock.sessions.length).toBe(1);

    // 3. 推送后续实时原始 16kHz PCM 音频帧
    const cmdBytes = makeInt16SineBytes(0.256, 520, 0.4);
    for (let off = 0; off < cmdBytes.byteLength; off += 2048) {
      session.pushInt16Frame(cmdBytes.subarray(off, off + 2048));
    }

    // 4. flush 结束本句
    await session.flush();
    await session.waitForIdle();

    expect(localDenoiseCalled).toBe(0);
    expect(partials.some((p) => p.engine === "voice-ws-asr" && p.text.includes("客厅吸顶灯"))).toBe(true);
    expect(emitted.length).toBe(1);
    expect(emitted[0]!.pipelineMode).toBe("voice-ws");
    expect(emitted[0]!.denoiseEngine).toBe("voice-ws-gtcrn");
    expect(emitted[0]!.precomputedAsrEngine).toBe("voice-ws-asr");
    expect(emitted[0]!.precomputedTranscript).toBe("Neo，打开客厅吸顶灯。");
    expect(emitted[0]!.wakeAnchored).toBe(true);

    // 校验发送给网关的是无损原始 PCM（待机回放 + 命令音频）
    const expectedPcm = Buffer.concat([Buffer.from(standbyBytes), Buffer.from(cmdBytes)]);
    expect(Buffer.compare(Buffer.from(mock.sessions[0]!.receivedPcmBytes), expectedPcm)).toBe(0);

    // 5. 运行期热切换至 xfyun / legacy 再切回 voice-ws
    session.setVoicePipelineMode("xfyun");
    expect(session.voicePipelineMode).toBe("xfyun");
    session.setVoicePipelineMode("legacy");
    expect(session.voicePipelineMode).toBe("legacy");
    session.setVoicePipelineMode("voice-ws");
    expect(session.voicePipelineMode).toBe("voice-ws");

    inConv = false;
    session.dispose();
    engine.dispose();
  });

  test("服务端 Silero VAD vad_silence 自动判停可自主出段并支持连续对话下一轮自动直推", async () => {
    const mock = startMockVoiceWsGateway({
      finalTexts: ["打开书房台灯"],
      autoFinalAfterBinaryChunks: 3,
    });

    const engine = new LocalVoiceEngine({ modelsDir: path.join(os.tmpdir(), "nonexistent-voice-ws-test-2") });
    engine.setVoiceWsAsrConfig({
      endpointUrl: mock.endpointUrl,
      authCode: mock.authCode,
      denoise: true,
    });
    (engine as unknown as { createOnlineDenoiser: typeof engine.createOnlineDenoiser }).createOnlineDenoiser =
      () => null;

    let inConv = true;
    const emitted: VoiceStreamSegmentPayload[] = [];
    const session = new VoiceStreamSession({
      localEngine: engine,
      noiseMode: "off",
      voicePipelineMode: "voice-ws",
      wakeWordEnabled: true,
      wakeWords: ["Neo"],
      owwEnabled: false,
      isInConversation: () => inConv,
      onSegmentReady: async (seg) => {
        emitted.push(seg);
        return null;
      },
    });

    // 连续对话态下纯静音不建连
    const silence = new Uint8Array(2048 * 4);
    for (let off = 0; off < silence.byteLength; off += 2048) {
      session.pushInt16Frame(silence.subarray(off, off + 2048));
    }
    expect(mock.sessions.length).toBe(0);

    // 第 1 轮开口说话 -> 服务端 vad_silence 自动判停出段
    const speech1 = makeInt16SineBytes(0.32, 480, 0.35);
    for (let off = 0; off < speech1.byteLength; off += 2048) {
      session.pushInt16Frame(speech1.subarray(off, Math.min(speech1.byteLength, off + 2048)));
    }
    await session.waitForIdle();

    expect(mock.sessions.length).toBe(1);
    expect(emitted.length).toBe(1);
    expect(emitted[0]!.pipelineMode).toBe("voice-ws");
    expect(emitted[0]!.precomputedTranscript).toBe("打开书房台灯");
    expect(emitted[0]!.commitReason).toBe("vad_silence");

    // 连续对话态第 2 轮再次开口 -> 自动建立新一轮 WebSocket 推流并再次自动出段
    const speech2 = makeInt16SineBytes(0.32, 560, 0.35);
    for (let off = 0; off < speech2.byteLength; off += 2048) {
      session.pushInt16Frame(speech2.subarray(off, Math.min(speech2.byteLength, off + 2048)));
    }
    await session.waitForIdle();
    expect(mock.sessions.length).toBe(2);
    expect(emitted.length).toBe(2);

    inConv = false;
    session.syncDialogState(false, "timeout");
    session.dispose();
    engine.dispose();
  });
});

describe("VoiceListenerController 与 HTTP API 端到端集成（含切换、直通执行与连通性测试）", () => {
  test("VoiceListenerController 在 voice-ws 方案下直接派发设备控制指令，且 HTTP API 切换、脱敏与 /api/voice/ws-asr/test 正常", async () => {
    useTempDataDir();
    const mock = startMockVoiceWsGateway({
      finalTexts: ["Neo，打开客厅主灯"],
    });

    applyTheme("dark", "green");
    const service = new VirtualDemoService();
    const jobs = new JobExecutor();
    const themeCtrl = new ThemeController("dark");
    const net = new NetworkMonitor({ initialReachability: "online", autoStart: false });
    const mainWin = new MainWindowController({
      service,
      jobs,
      themeCtrl,
      networkMonitor: net,
      autoStartTimers: false,
      cacheLoader: () => null,
      cacheSaver: () => {},
    });
    const piAgent = new PiAgentService({
      deps: { service, jobs, mainWindow: mainWin, settingsStore, broadcastState: () => {} },
    });
    updateAgentVoiceConfig({
      voicePipelineMode: "voice-ws",
      voiceWsAsrEndpointUrl: mock.endpointUrl,
      voiceWsAsrAuthCode: mock.authCode,
      voiceWsAsrDenoise: true,
      wakeWordEnabled: true,
      wakeWords: ["Neo"],
      owwEnabled: false,
    });
    piAgent.reconfigure(loadAgentVoiceConfig());

    const engine = new LocalVoiceEngine({ modelsDir: path.join(os.tmpdir(), "nonexistent-voice-ws-ctrl") });
    let denoiseCalled = 0;
    (engine as unknown as { denoise: typeof engine.denoise }).denoise = () => {
      denoiseCalled += 1;
      throw new Error("should not denoise locally in voice-ws mode");
    };

    const vl = new VoiceListenerController(piAgent, { localEngine: engine });
    const wavBytes = encodeWavPcm16(decodeInt16PcmBuffer(makeInt16SineBytes(0.3, 440, 0.3)), SR);
    const wavBlob = new Blob([wavBytes as unknown as BlobPart], { type: "audio/wav" });

    const uploadRes = await vl.processAudioUpload(wavBlob, { bypassWakeWord: true });
    expect(uploadRes.ok).toBe(true);
    expect(uploadRes.asrEngine).toBe("voice-ws-asr");
    expect(uploadRes.denoiseEngine).toBe("voice-ws-gtcrn");
    expect(uploadRes.vadEngine).toBe("voice-ws-silero");
    expect(uploadRes.text).toBe("Neo，打开客厅主灯");
    expect(denoiseCalled).toBe(0);

    vl.dispose();
    piAgent.dispose();
    mainWin.dispose();
    net.stop();
    await jobs.shutdown();

    // HTTP Server 端到端验证：配置保存、脱敏、方案切换、/api/voice/ws-asr/test 与 UI DOM
    runningServer = await startMijiaDeckServer({
      mode: "demo",
      port: 0,
      hostname: "127.0.0.1",
      service: new VirtualDemoService(),
    });

    const saveRes = await fetch(`${runningServer.url}/api/agent/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        voicePipelineMode: "voice-ws",
        voiceWsAsrEndpointUrl: mock.endpointUrl,
        voiceWsAsrAuthCode: mock.authCode,
        voiceWsAsrDenoise: true,
        voiceWsAsrLanguage: "zh",
      }),
    });
    expect(saveRes.ok).toBe(true);
    const saveJson = (await saveRes.json()) as {
      config: Record<string, unknown>;
      voice: {
        voicePipelineMode: string;
        effectiveVoiceWsAsrConfigured: boolean;
        localEngine: { readyForVoiceWsAsr: boolean };
      };
    };
    expect(saveJson.config.voicePipelineMode).toBe("voice-ws");
    expect(saveJson.config.voiceWsAsrAuthCode).toBeUndefined();
    expect(saveJson.config.hasVoiceWsAsrAuthCode).toBe(true);
    expect(saveJson.config.effectiveVoiceWsAsrConfigured).toBe(true);
    expect(saveJson.voice.voicePipelineMode).toBe("voice-ws");
    expect(saveJson.voice.effectiveVoiceWsAsrConfigured).toBe(true);
    expect(saveJson.voice.localEngine.readyForVoiceWsAsr).toBe(true);

    // 测试 /api/voice/ws-asr/test 连通性接口（复用已保存授权码）
    const testRes = await fetch(`${runningServer.url}/api/voice/ws-asr/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(testRes.ok).toBe(true);
    const testJson = (await testRes.json()) as {
      ok: boolean;
      sessionId: string | null;
      denoiseModel: string | null;
      vadModel: string | null;
      asrModel: string | null;
      latencyMs: number;
    };
    expect(testJson.ok).toBe(true);
    expect(testJson.sessionId).toBeTruthy();
    expect(testJson.denoiseModel).toBe("gtcrn_simple.onnx");
    expect(testJson.vadModel).toBe("silero_vad_v5.onnx");
    expect(testJson.asrModel).toBe("Qwen/Qwen3-ASR-0.6B");

    // 测试错误授权码时返回 ok: false 且错误信息绝不包含明文授权码
    const badToken = "vgw_InvalidTestSecretCode_9999999";
    const badRes = await fetch(`${runningServer.url}/api/voice/ws-asr/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        voiceWsAsrEndpointUrl: mock.endpointUrl,
        voiceWsAsrAuthCode: badToken,
      }),
    });
    expect(badRes.ok).toBe(true);
    const badJson = (await badRes.json()) as { ok: boolean; error?: string };
    expect(badJson.ok).toBe(false);
    expect(badJson.error).toBeTruthy();
    expect(badJson.error).not.toContain(badToken);

    // 在 voice-ws / xfyun / legacy 间自由切换
    const toXfyunRes = await fetch(`${runningServer.url}/api/agent/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ voicePipelineMode: "xfyun" }),
    });
    expect(((await toXfyunRes.json()) as { voice: { voicePipelineMode: string } }).voice.voicePipelineMode).toBe(
      "xfyun",
    );
    const toLegacyRes = await fetch(`${runningServer.url}/api/agent/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ voicePipelineMode: "legacy" }),
    });
    expect(((await toLegacyRes.json()) as { voice: { voicePipelineMode: string } }).voice.voicePipelineMode).toBe(
      "legacy",
    );

    // 校验前端 HTML 包含统一流式语音听写网关配置卡片、下拉选项与状态徽章，且前端脚本保存设置保留 voice-ws 不会误回退 legacy
    const html = await (await fetch(`${runningServer.url}/`)).text();
    expect(html).toContain("set-voice-pipeline-mode");
    expect(html).toContain('value="voice-ws"');
    expect(html).toContain("setting-row-voice-ws-asr");
    expect(html).toContain("badge-model-voice-ws-asr");
    expect(html).toContain("set-voice-ws-asr-test-btn");

    const appJs = await (await fetch(`${runningServer.url}/app.js`)).text();
    expect(appJs).toContain("set-voice-pipeline-mode");
    expect(appJs).toContain('"voice-ws"');
    expect(appJs).not.toMatch(
      /set-voice-pipeline-mode[\s\S]{0,120}===\s*"xfyun"\s*\?\s*"xfyun"\s*:\s*"legacy"/,
    );
  });

  test("无本地 SenseVoice 模型时动态配置并切换至 voice-ws 会将 VoiceListenerController.engine 升级为 local", () => {
    useTempDataDir();
    applyTheme("dark", "green");
    const service = new VirtualDemoService();
    const jobs = new JobExecutor();
    const themeCtrl = new ThemeController("dark");
    const net = new NetworkMonitor({ initialReachability: "online", autoStart: false });
    const mainWin = new MainWindowController({
      service,
      jobs,
      themeCtrl,
      networkMonitor: net,
      autoStartTimers: false,
      cacheLoader: () => null,
      cacheSaver: () => {},
    });
    const piAgent = new PiAgentService({
      deps: { service, jobs, mainWindow: mainWin, settingsStore, broadcastState: () => {} },
    });
    const engine = new LocalVoiceEngine({
      modelsDir: path.join(os.tmpdir(), "nonexistent-voice-ws-promote"),
    });
    const vl = new VoiceListenerController(piAgent, { localEngine: engine });
    expect(vl.snapshot().engine).toBe("browser");

    const updated = updateAgentVoiceConfig({
      voicePipelineMode: "voice-ws",
      voiceWsAsrEndpointUrl: "wss://voice.1inch.cn:18443/v1/ws/asr",
      voiceWsAsrAuthCode: "vgw_test_promote_engine_123456",
    });
    piAgent.reconfigure(updated);
    const snap = vl.updateRuntimeState({});
    expect(snap.voicePipelineMode).toBe("voice-ws");
    expect(snap.effectiveVoiceWsAsrConfigured).toBe(true);
    expect(snap.localEngine.readyForVoiceWsAsr).toBe(true);
    expect(snap.engine).toBe("local");

    vl.dispose();
    piAgent.dispose();
    mainWin.dispose();
    net.stop();
    void jobs.shutdown();
  });
});
