// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { encodeWavPcm16 } from "../src/agent/audioPcm.ts";
import { LocalVoiceEngine, type LocalAsrOutput } from "../src/agent/localVoiceEngine.ts";
import type { OpenWakeWordStreamSession, WakeWordAcousticHit } from "../src/agent/openWakeWordEngine.ts";
import { PiAgentService } from "../src/agent/piAgentService.ts";
import { VoiceListenerController } from "../src/agent/voiceListenerController.ts";
import {
  decodeInt16PcmBuffer,
  VoiceStreamSession,
  type VoiceStreamSegmentPayload,
} from "../src/agent/voiceStreamSession.ts";
import {
  buildXfyunIatAuthUrl,
  float32ToInt16LeBytes,
  XfyunIatV2Runtime,
  XfyunWpgsTranscriptAssembler,
} from "../src/agent/xfyunIatV2Runtime.ts";
import {
  defaultAgentVoiceConfig,
  loadAgentVoiceConfig,
  normalizeVoicePipelineMode,
  resolveEffectiveXfyunAuth,
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
let mockXfyunServer: ReturnType<typeof Bun.serve> | null = null;
let runningServer: MijiaDeckServer | null = null;

function useTempDataDir(): string {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "mijiadeck-xfyun-"));
  const dir = tempDir;
  setDataPathOverrides({ dataDir: () => dir });
  return dir;
}

afterEach(async () => {
  if (runningServer) {
    await runningServer.stop();
    runningServer = null;
  }
  if (mockXfyunServer) {
    mockXfyunServer.stop(true);
    mockXfyunServer = null;
  }
  setDataPathOverrides(null);
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

interface CapturedXfyunSession {
  query: URLSearchParams;
  frames: Array<{
    header: Record<string, unknown>;
    parameter?: Record<string, unknown>;
    payload?: { audio?: Record<string, unknown> };
  }>;
  receivedPcmBytes: Uint8Array;
}

function encodeXfyunResultText(obj: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(obj), "utf-8").toString("base64");
}

function startMockXfyunServer(options: {
  partials?: Array<{ sn: number; text: string; pgs?: "apd" | "rpl"; rg?: [number, number]; rst?: "pgs" | "rlt" }>;
  finalText?: string;
  autoEosAfterFrames?: number;
  errorCode?: number;
  errorMessage?: string;
} = {}) {
  const sessions: CapturedXfyunSession[] = [];
  const finalText = options.finalText ?? "Neo，打开客厅吸顶灯。";

  interface MockWsState {
    session: CapturedXfyunSession;
    pcmChunks: Uint8Array[];
    sentFinal: boolean;
    frameCount: number;
  }

  const server = Bun.serve<MockWsState>({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/v1") {
        const session: CapturedXfyunSession = {
          query: url.searchParams,
          frames: [],
          receivedPcmBytes: new Uint8Array(0),
        };
        sessions.push(session);
        const ok = srv.upgrade(req, {
          data: { session, pcmChunks: [], sentFinal: false, frameCount: 0 },
        });
        if (ok) return undefined;
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      message(ws, raw) {
        const msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw)) as {
          header: Record<string, unknown>;
          parameter?: Record<string, unknown>;
          payload?: { audio?: Record<string, unknown> };
        };
        ws.data.session.frames.push(msg);
        ws.data.frameCount += 1;

        const audioB64 = msg.payload?.audio?.audio;
        if (typeof audioB64 === "string" && audioB64.length > 0) {
          const decoded = new Uint8Array(Buffer.from(audioB64, "base64"));
          ws.data.pcmChunks.push(decoded);
          const total = ws.data.pcmChunks.reduce((acc, c) => acc + c.byteLength, 0);
          const merged = new Uint8Array(total);
          let off = 0;
          for (const c of ws.data.pcmChunks) {
            merged.set(c, off);
            off += c.byteLength;
          }
          ws.data.session.receivedPcmBytes = merged;
        }

        if (options.errorCode && options.errorCode !== 0) {
          ws.send(
            JSON.stringify({
              header: {
                code: options.errorCode,
                message: options.errorMessage ?? "mock auth error",
                sid: "mock_sid_err",
                status: 2,
              },
            }),
          );
          ws.close();
          return;
        }

        if (msg.header?.status === 0) {
          ws.send(
            JSON.stringify({
              header: { code: 0, message: "success", sid: "mock_sid_ok", status: 0 },
            }),
          );
          if (options.partials && options.partials.length > 0) {
            for (const p of options.partials) {
              ws.send(
                JSON.stringify({
                  header: { code: 0, message: "success", sid: "mock_sid_ok", status: 1 },
                  payload: {
                    result: {
                      encoding: "utf8",
                      compress: "raw",
                      format: "json",
                      seq: p.sn,
                      status: 1,
                      text: encodeXfyunResultText({
                        sn: p.sn,
                        ls: false,
                        pgs: p.pgs ?? "apd",
                        ...(p.rg ? { rg: p.rg } : {}),
                        rst: p.rst ?? "pgs",
                        ws: [{ bg: 0, cw: [{ w: p.text }] }],
                      }),
                    },
                  },
                }),
              );
            }
          }
        }

        const triggerAutoEos =
          typeof options.autoEosAfterFrames === "number" &&
          ws.data.frameCount >= options.autoEosAfterFrames;

        if (!ws.data.sentFinal && (msg.header?.status === 2 || triggerAutoEos)) {
          ws.data.sentFinal = true;
          const lastSn = (options.partials?.length ?? 0) + 1;
          ws.send(
            JSON.stringify({
              header: { code: 0, message: "success", sid: "mock_sid_ok", status: 2 },
              payload: {
                result: {
                  encoding: "utf8",
                  compress: "raw",
                  format: "json",
                  seq: lastSn,
                  status: 2,
                  text: encodeXfyunResultText({
                    sn: lastSn,
                    ls: true,
                    pgs: options.partials && options.partials.length > 0 ? "rpl" : "apd",
                    ...(options.partials && options.partials.length > 0
                      ? { rg: [1, options.partials.length] }
                      : {}),
                    rst: "rlt",
                    ws: [{ bg: 0, cw: [{ w: finalText }] }],
                  }),
                },
              },
            }),
          );
          ws.close(1000, "done");
        }
      },
    },
  });

  mockXfyunServer = server;
  return {
    endpointUrl: `ws://127.0.0.1:${server.port}/v1`,
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
        score: 0.92,
        rawScore: 0.92,
        threshold: 0.6,
        source: "enrolled",
        frameIndex: 1,
        sampleOffset: sampleOffset ?? lastEndSample,
        latencyMs: 5,
      });
    },
    factory(_wakeWords: readonly string[], opts?: { onSpot?: (hit: WakeWordAcousticHit) => void }): OpenWakeWordStreamSession {
      onSpotCb = opts?.onSpot;
      return {
        hasActivePrototypes: true,
        pushSamples(_samples: Float32Array, endSampleOffset: number) {
          lastEndSample = endSampleOffset;
          return null;
        },
        getPeakHit: () => null,
        getHeadPeakHit: () => null,
        resetSegmentTracking: () => {},
        reloadPrototypes: () => {},
        reset: () => {},
      } as unknown as OpenWakeWordStreamSession;
    },
  };
}

function makeInt16SineBytes(durationSec: number, freqHz = 440, amp = 0.35): Uint8Array {
  const count = Math.round(SR * durationSec);
  const bytes = new Uint8Array(count * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < count; i += 1) {
    const val = Math.round(Math.sin((2 * Math.PI * freqHz * i) / SR) * amp * 32767);
    view.setInt16(i * 2, val, true);
  }
  return bytes;
}

describe("讯飞语音听写大模型 2.0 协议与工具函数", () => {
  test("HMAC-SHA256 签名与 authorization 参数精确匹配官方文档测试向量", () => {
    const res = buildXfyunIatAuthUrl({
      endpointUrl: "wss://iat.cn-huabei-1.xf-yun.com/v1",
      apiKey: "keyxxxxxxxx8ee279348519exxxxxxxx",
      apiSecret: "secretxxxxxxxx2df7900c09xxxxxxxx",
      date: "Thu, 17 Sep 2026 01:38:38 GMT",
    });

    expect(res.signatureOrigin).toBe(
      "host: iat.cn-huabei-1.xf-yun.com\ndate: Thu, 17 Sep 2026 01:38:38 GMT\nGET /v1 HTTP/1.1",
    );
    expect(res.signature).toBe("FedHfo4jlPWnPO11NslNRsPu76k0T5iPsepze3HtxTc=");
    expect(res.authorization).toBe(
      "YXBpX2tleT0ia2V5eHh4eHh4eHg4ZWUyNzkzNDg1MTlleHh4eHh4eHgiLCBhbGdvcml0aG09ImhtYWMtc2hhMjU2IiwgaGVhZGVycz0iaG9zdCBkYXRlIHJlcXVlc3QtbGluZSIsIHNpZ25hdHVyZT0iRmVkSGZvNGpsUFduUE8xMU5zbE5Sc1B1NzZrMFQ1aVBzZXB6ZTNIdHhUYz0i",
    );
    const parsed = new URL(res.wsUrl);
    expect(parsed.searchParams.get("host")).toBe("iat.cn-huabei-1.xf-yun.com");
    expect(parsed.searchParams.get("date")).toBe("Thu, 17 Sep 2026 01:38:38 GMT");
    expect(parsed.searchParams.get("authorization")).toBe(res.authorization);
  });

  test("Int16 PCM 经 decodeInt16PcmBuffer -> float32ToInt16LeBytes 完整无损零失真还原", () => {
    const orig = new Uint8Array(2048);
    const view = new DataView(orig.buffer);
    const edgeVals = [-32768, -16384, -1234, -1, 0, 1, 1234, 16384, 32767];
    for (let i = 0; i < 1024; i += 1) {
      view.setInt16(i * 2, edgeVals[i % edgeVals.length]!, true);
    }
    const f32 = decodeInt16PcmBuffer(orig);
    const roundtripped = float32ToInt16LeBytes(f32);
    expect(Buffer.compare(Buffer.from(roundtripped), Buffer.from(orig))).toBe(0);
  });

  test("wpgs 动态修正组装器正确处理 apd 追加、rpl 范围替换与 rst 稳态切分", () => {
    const asm = new XfyunWpgsTranscriptAssembler();
    const s1 = asm.ingest({
      sn: 1,
      ls: false,
      pgs: "apd",
      rst: "pgs",
      ws: [{ cw: [{ w: "ne" }] }],
    });
    expect(s1.text).toBe("ne");
    expect(s1.stableText).toBe("");

    const s2 = asm.ingest({
      sn: 2,
      ls: false,
      pgs: "rpl",
      rg: [1, 1],
      rst: "pgs",
      ws: [{ cw: [{ w: "neo" }] }, { cw: [{ w: "打开" }] }],
    });
    expect(s2.text).toBe("neo打开");

    const s3 = asm.ingest({
      sn: 3,
      ls: false,
      pgs: "rpl",
      rg: [1, 2],
      rst: "rlt",
      ws: [{ cw: [{ w: "Neo，打开客厅吸顶灯" }] }],
    });
    expect(s3.text).toBe("Neo，打开客厅吸顶灯");
    expect(s3.stableText).toBe("Neo，打开客厅吸顶灯");
    expect(s3.unstableText).toBe("");

    const s4 = asm.ingest({
      sn: 4,
      ls: true,
      pgs: "apd",
      rst: "rlt",
      ws: [{ cw: [{ w: "。" }] }],
    });
    expect(s4.text).toBe("Neo，打开客厅吸顶灯。");
    expect(s4.isLast).toBe(true);
    expect(s4.retErrorCode).toBeNull();
  });
});

describe("agentConfigStore 讯飞 2.0 配置持久化、切换与密钥脱敏", () => {
  test("voicePipelineMode 支持 legacy / xfyun 切换（历史 clearvoice 自动归一化为 legacy），且 apiKey/apiSecret 绝不明文暴露", () => {
    useTempDataDir();
    expect(defaultAgentVoiceConfig().voicePipelineMode).toBe("legacy");
    expect(normalizeVoicePipelineMode("xfyun")).toBe("xfyun");
    expect(normalizeVoicePipelineMode("xfyun-iat-v2")).toBe("xfyun");
    expect(normalizeVoicePipelineMode("spark_asr_v2")).toBe("xfyun");
    expect(normalizeVoicePipelineMode("xunfei")).toBe("xfyun");
    expect(normalizeVoicePipelineMode("clearvoice")).toBe("legacy");

    const updated = updateAgentVoiceConfig({
      voicePipelineMode: "xfyun",
      xfyunEndpointUrl: "wss://iat.cn-huabei-1.xf-yun.com/v1",
      xfyunAppId: "test_app_1234",
      xfyunApiKey: "test_xfyun_apikey_abcdef123456",
      xfyunApiSecret: "test_xfyun_secret_9876543210ab",
    });
    expect(updated.voicePipelineMode).toBe("xfyun");
    expect(updated.xfyunAppId).toBe("test_app_1234");

    const reloaded = loadAgentVoiceConfig();
    expect(reloaded.voicePipelineMode).toBe("xfyun");
    expect(reloaded.xfyunApiKey).toBe("test_xfyun_apikey_abcdef123456");
    expect(reloaded.xfyunApiSecret).toBe("test_xfyun_secret_9876543210ab");
    expect(resolveEffectiveXfyunAuth(reloaded).configured).toBe(true);

    const pub = toPublicAgentVoiceConfig(reloaded) as unknown as Record<string, unknown>;
    expect(pub.xfyunApiKey).toBeUndefined();
    expect(pub.xfyunApiSecret).toBeUndefined();
    expect(pub.hasXfyunApiKey).toBe(true);
    expect(pub.hasXfyunApiSecret).toBe(true);
    expect(pub.effectiveXfyunConfigured).toBe(true);
    expect(String(pub.xfyunApiKeyPreview)).toContain("••••");
    expect(String(pub.xfyunApiSecretPreview)).toContain("••••");

    // 留空不覆盖已有密钥；切回 legacy 保持密钥完整
    const keepSecrets = updateAgentVoiceConfig({
      xfyunApiKey: "",
      xfyunApiSecret: "",
      voicePipelineMode: "legacy",
    });
    expect(keepSecrets.voicePipelineMode).toBe("legacy");
    expect(keepSecrets.xfyunApiKey).toBe("test_xfyun_apikey_abcdef123456");
    expect(keepSecrets.xfyunApiSecret).toBe("test_xfyun_secret_9876543210ab");

    // 显式清除密钥
    const cleared = updateAgentVoiceConfig({
      clearXfyunApiKey: true,
      clearXfyunApiSecret: true,
    });
    expect(cleared.xfyunApiKey).toBe("");
    expect(cleared.xfyunApiSecret).toBe("");
    expect(resolveEffectiveXfyunAuth(cleared).configured).toBe(false);
  });
});

describe("VoiceStreamSession 讯飞听写大模型 2.0 端到端直推原始音频", () => {
  test("未唤醒待机期零讯飞连接；openWakeWord 唤醒后直接推送无损原始 PCM，支持动态修正实时字幕与方案热切换", async () => {
    const mock = startMockXfyunServer({
      partials: [
        { sn: 1, text: "Neo打开", pgs: "apd", rst: "pgs" },
        { sn: 2, text: "Neo打开客厅灯", pgs: "rpl", rg: [1, 1], rst: "pgs" },
      ],
      finalText: "Neo，打开客厅吸顶灯。",
    });

    const engine = new LocalVoiceEngine({ modelsDir: path.join(os.tmpdir(), "nonexistent-xfyun-test") });
    engine.setXfyunIatConfig({
      endpointUrl: mock.endpointUrl,
      appId: "app_test_01",
      apiKey: "key_test_0123456789abcdef01234567",
      apiSecret: "sec_test_0123456789abcdef01234567",
    });

    const mockOww = createMockOwwController();
    let localAsrCalls = 0;
    let denoiseCalls = 0;
    (engine as unknown as { createWakeWordStream: typeof engine.createWakeWordStream }).createWakeWordStream =
      (words, opts) => mockOww.factory(words, opts);
    (engine as unknown as { createOnlineDenoiser: typeof engine.createOnlineDenoiser }).createOnlineDenoiser =
      () => ({
        sampleRate: SR,
        engine: "gtcrn",
        denoiser: {
          sampleRate: SR,
          frameShiftInSamples: 256,
          run: ({ samples, sampleRate }: { samples: Float32Array; sampleRate: number }) => {
            denoiseCalls += 1;
            // 故意返回全零以验证：即使降噪器存在，推送给讯飞的依然是未处理的原始音频！
            return { samples: new Float32Array(samples.length), sampleRate };
          },
          flush: () => ({ samples: new Float32Array(0), sampleRate: SR }),
          reset: () => {},
        },
      });
    (engine as unknown as { transcribeLocal: typeof engine.transcribeLocal }).transcribeLocal =
      async (): Promise<LocalAsrOutput> => {
        localAsrCalls += 1;
        return { text: "should-not-be-called", rawText: "", lang: "zh", emotion: "", event: "", engine: "sensevoice-local", durationMs: 1 };
      };

    const partials: string[] = [];
    const emitted: VoiceStreamSegmentPayload[] = [];
    const session = new VoiceStreamSession({
      localEngine: engine,
      noiseMode: "auto",
      voicePipelineMode: "xfyun",
      wakeWordEnabled: true,
      wakeWords: ["Neo"],
      wakeGatedAsr: true,
      wakeRingLookbackMs: 1000,
      onPartialTranscript: (ev) => {
        partials.push(ev.text);
      },
      onSegmentReady: async (seg) => {
        emitted.push(seg);
        return null;
      },
    });

    expect(session.voicePipelineMode).toBe("xfyun");
    expect(session.denoiseEngine).toBe("xfyun-raw-direct");

    // 1. 待机期推入 0.5s 原始音频：未命中唤醒词时绝不建连讯飞 WebSocket
    const standbyBytes = makeInt16SineBytes(0.5, 300, 0.25);
    for (let off = 0; off < standbyBytes.byteLength; off += 2048) {
      session.pushInt16Frame(standbyBytes.subarray(off, Math.min(standbyBytes.byteLength, off + 2048)));
    }
    expect(mock.sessions.length).toBe(0);
    expect(session.isWakeGatedStandby).toBe(true);

    // 2. openWakeWord 命中唤醒！此时立即建连讯飞并回放原始循环缓冲区
    const denoiseBeforeWake = denoiseCalls;
    mockOww.fireWake("Neo");

    // 3. 唤醒后继续推入 0.4s 原始 Int16 PCM 帧（期间应跳过本地降噪，直接无损直推讯飞）
    const afterWakeBytes = makeInt16SineBytes(0.4, 660, 0.4);
    for (let off = 0; off < afterWakeBytes.byteLength; off += 2048) {
      session.pushInt16Frame(afterWakeBytes.subarray(off, Math.min(afterWakeBytes.byteLength, off + 2048)));
    }
    // 唤醒后的帧不再跑本地降噪！
    expect(denoiseCalls).toBe(denoiseBeforeWake);

    // 4. flush 发送 status=2 并等待讯飞最终结果返回
    await session.flush();

    expect(mock.sessions.length).toBe(1);
    const xfSess = mock.sessions[0]!;
    // 验证协议参数
    const firstFrame = xfSess.frames[0]!;
    expect(firstFrame.header.app_id).toBe("app_test_01");
    expect(firstFrame.header.status).toBe(0);
    const iatParam = (firstFrame.parameter as { iat?: Record<string, unknown> })?.iat;
    expect(iatParam?.domain).toBe("spark_asr_v2");
    expect(iatParam?.language).toBe("zh_cn");
    expect(iatParam?.accent).toBe("mandarin");
    expect(iatParam?.dwa).toBe("wpgs");
    expect(firstFrame.payload?.audio?.encoding).toBe("raw");
    expect(firstFrame.payload?.audio?.sample_rate).toBe(16000);
    expect(firstFrame.payload?.audio?.channels).toBe(1);
    expect(firstFrame.payload?.audio?.bit_depth).toBe(16);

    // 验证推送到讯飞的字节与原始 PCM 完全一致（含回溯的待机原始音频 + 唤醒后原始音频，未被降噪器置零！）
    const expectedRawBytes = new Uint8Array(standbyBytes.byteLength + afterWakeBytes.byteLength);
    expectedRawBytes.set(standbyBytes, 0);
    expectedRawBytes.set(afterWakeBytes, standbyBytes.byteLength);
    expect(Buffer.compare(Buffer.from(xfSess.receivedPcmBytes), Buffer.from(expectedRawBytes))).toBe(0);

    // 验证实时字幕回调与最终出段
    expect(partials).toContain("Neo打开");
    expect(partials).toContain("Neo打开客厅灯");
    expect(emitted.length).toBe(1);
    expect(emitted[0]!.pipelineMode).toBe("xfyun");
    expect(emitted[0]!.denoiseEngine).toBe("xfyun-raw-direct");
    expect(emitted[0]!.precomputedTranscript).toBe("Neo，打开客厅吸顶灯。");
    expect(emitted[0]!.precomputedAsrEngine).toBe("xfyun-iat-v2");
    expect(emitted[0]!.wakeAnchored).toBe(true);
    expect(emitted[0]!.acousticWake?.wakeWord).toBe("Neo");

    // 严禁调用本地 ASR
    expect(localAsrCalls).toBe(0);

    // 5. 运行期热切换至 legacy 再切回 xfyun
    session.setVoicePipelineMode("legacy");
    expect(session.voicePipelineMode).toBe("legacy");
    session.setVoicePipelineMode("xfyun");
    expect(session.voicePipelineMode).toBe("xfyun");

    session.dispose();
    engine.dispose();
  });

  test("讯飞服务端 eos 自动判停可自主完成出段并支持连续对话下一轮自动直推", async () => {
    const mock = startMockXfyunServer({
      finalText: "把客厅灯调亮一点。",
      autoEosAfterFrames: 4,
    });

    const engine = new LocalVoiceEngine({ modelsDir: path.join(os.tmpdir(), "nonexistent-xfyun-test-2") });
    engine.setXfyunIatConfig({
      endpointUrl: mock.endpointUrl,
      appId: "app_test_02",
      apiKey: "key_test_0123456789abcdef01234567",
      apiSecret: "sec_test_0123456789abcdef01234567",
    });

    let inConv = true;
    const emitted: VoiceStreamSegmentPayload[] = [];
    const session = new VoiceStreamSession({
      localEngine: engine,
      noiseMode: "off",
      voicePipelineMode: "xfyun",
      wakeWordEnabled: true,
      wakeWords: ["Neo"],
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

    // 用户开口说下一轮指令（连续有声原始 PCM）-> 自动建连讯飞并由服务端 autoEos 判停出段
    const speech = makeInt16SineBytes(0.4, 520, 0.3);
    for (let off = 0; off < speech.byteLength; off += 2048) {
      session.pushInt16Frame(speech.subarray(off, Math.min(speech.byteLength, off + 2048)));
    }
    await session.waitForIdle();

    expect(mock.sessions.length).toBe(1);
    expect(emitted.length).toBe(1);
    expect(emitted[0]!.precomputedTranscript).toBe("把客厅灯调亮一点。");
    expect(emitted[0]!.commitReason).toBe("vad_silence");
    expect(emitted[0]!.pipelineMode).toBe("xfyun");

    inConv = false;
    session.syncDialogState(false, "timeout");
    session.dispose();
    engine.dispose();
  });
});

describe("VoiceListenerController 与 HTTP API 端到端集成（含切换、直通执行与连通性测试）", () => {
  test("VoiceListenerController 在 xfyun 方案下直接派发设备控制指令，且 HTTP API 切换与连通性测试正常", async () => {
    useTempDataDir();
    const mock = startMockXfyunServer({ finalText: "Neo，打开客厅主灯" });

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
      voicePipelineMode: "xfyun",
      xfyunEndpointUrl: mock.endpointUrl,
      xfyunAppId: "app_ctrl_test",
      xfyunApiKey: "key_ctrl_0123456789abcdef01234567",
      xfyunApiSecret: "sec_ctrl_0123456789abcdef01234567",
      wakeWordEnabled: true,
      wakeWords: ["Neo"],
      owwEnabled: false,
    });
    piAgent.reconfigure(loadAgentVoiceConfig());

    const engine = new LocalVoiceEngine({ modelsDir: path.join(os.tmpdir(), "nonexistent-xfyun-ctrl") });
    let denoiseCalled = 0;
    (engine as unknown as { denoise: typeof engine.denoise }).denoise = () => {
      denoiseCalled += 1;
      throw new Error("should not denoise in xfyun mode");
    };

    const vl = new VoiceListenerController(piAgent, { localEngine: engine });
    const wavBytes = encodeWavPcm16(decodeInt16PcmBuffer(makeInt16SineBytes(0.3, 440, 0.3)), SR);
    const wavBlob = new Blob([wavBytes as unknown as BlobPart], { type: "audio/wav" });

    const uploadRes = await vl.processAudioUpload(wavBlob, { bypassWakeWord: true });
    expect(uploadRes.ok).toBe(true);
    expect(uploadRes.asrEngine).toBe("xfyun-iat-v2");
    expect(uploadRes.denoiseEngine).toBe("xfyun-raw-direct");
    expect(uploadRes.text).toBe("Neo，打开客厅主灯");
    expect(denoiseCalled).toBe(0);

    vl.dispose();
    piAgent.dispose();
    mainWin.dispose();
    net.stop();
    await jobs.shutdown();

    // HTTP Server 端到端验证：配置保存、脱敏、方案切换、/api/voice/xfyun/test 与 UI DOM
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
        voicePipelineMode: "xfyun",
        xfyunEndpointUrl: mock.endpointUrl,
        xfyunAppId: "app_http_test",
        xfyunApiKey: "key_http_0123456789abcdef01234567",
        xfyunApiSecret: "sec_http_0123456789abcdef01234567",
      }),
    });
    expect(saveRes.ok).toBe(true);
    const saveJson = (await saveRes.json()) as {
      config: Record<string, unknown>;
      voice: {
        voicePipelineMode: string;
        effectiveXfyunConfigured: boolean;
        localEngine: { readyForXfyunIat: boolean };
      };
    };
    expect(saveJson.config.voicePipelineMode).toBe("xfyun");
    expect(saveJson.config.xfyunApiKey).toBeUndefined();
    expect(saveJson.config.xfyunApiSecret).toBeUndefined();
    expect(saveJson.config.hasXfyunApiKey).toBe(true);
    expect(saveJson.config.hasXfyunApiSecret).toBe(true);
    expect(saveJson.config.effectiveXfyunConfigured).toBe(true);
    expect(saveJson.voice.voicePipelineMode).toBe("xfyun");
    expect(saveJson.voice.effectiveXfyunConfigured).toBe(true);
    expect(saveJson.voice.localEngine.readyForXfyunIat).toBe(true);

    // 测试 /api/voice/xfyun/test 连通性接口
    const testRes = await fetch(`${runningServer.url}/api/voice/xfyun/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(testRes.ok).toBe(true);
    const testJson = (await testRes.json()) as { ok: boolean; sid: string | null; latencyMs: number };
    expect(testJson.ok).toBe(true);
    expect(testJson.sid).toBe("mock_sid_ok");

    // 切回 legacy
    const toLegacyRes = await fetch(`${runningServer.url}/api/agent/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ voicePipelineMode: "legacy" }),
    });
    expect(((await toLegacyRes.json()) as { voice: { voicePipelineMode: string } }).voice.voicePipelineMode).toBe("legacy");

    // 校验前端 HTML 包含讯飞 2.0 设置项与方案切换按钮，且已完全移除 ClearVoice / Qwen3-ASR 控件
    const html = await (await fetch(`${runningServer.url}/`)).text();
    expect(html).toContain("pi-voice-pipeline-toggle-btn");
    expect(html).toContain("set-voice-pipeline-mode");
    expect(html).toContain("setting-row-xfyun-iat");
    expect(html).toContain("badge-model-xfyun-iat");
    expect(html).toContain("set-xfyun-test-btn");
    expect(html).not.toContain("set-voice-clearvoice-enabled");
    expect(html).not.toContain("setting-row-voice-gateway");
    expect(html).not.toContain("pi-voice-tracks-panel");
  });

  test("XfyunIatV2Runtime.testConnection 在服务端返回错误码时准确返回失败且脱敏", async () => {
    const mockErr = startMockXfyunServer({
      errorCode: 10163,
      errorMessage: "invalid api_key=secret_token_should_redact",
    });
    const rt = new XfyunIatV2Runtime({
      endpointUrl: mockErr.endpointUrl,
      appId: "bad_app",
      apiKey: "bad_key_1234567890",
      apiSecret: "bad_secret_1234567890",
    });
    const res = await rt.testConnection({ timeoutMs: 4000 });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("10163");
    expect(res.error).not.toContain("secret_token_should_redact");
    rt.dispose();
  });
});
