// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 在线 ClearVoice 与 Qwen3-ASR 网关接入单元测试与端到端集成测试

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { computeRms, decodeWavPcm, encodeWavPcm16 } from "../src/agent/audioPcm.ts";
import { pruneInactiveOrDuplicateTracks } from "../src/agent/clearVoiceChunker.ts";
import {
  ClearVoiceGpuRuntime,
  recoverSeparatedTrackGains,
  resolveClearVoiceGatewayEndpoints,
} from "../src/agent/clearVoiceGpuRuntime.ts";
import { LocalVoiceEngine } from "../src/agent/localVoiceEngine.ts";
import {
  mapQwen3GatewayLang,
  Qwen3AsrGpuRuntime,
  resolveQwen3AsrGatewayEndpoints,
} from "../src/agent/qwen3AsrGpuRuntime.ts";
import {
  defaultAgentVoiceConfig,
  loadAgentVoiceConfig,
  resolveEffectiveClearVoiceAuth,
  resolveEffectiveQwen3AsrAuth,
  toPublicAgentVoiceConfig,
  updateAgentVoiceConfig,
} from "../src/core/agentConfigStore.ts";
import { setDataPathOverrides } from "../src/core/jsonStore.ts";
import { VirtualDemoService } from "../src/core/virtualLightService.ts";
import { sanitizeErrorMessage } from "../src/server/routes.ts";
import { startMijiaDeckServer, type MijiaDeckServer } from "../src/server/server.ts";

let tmpDir = "";
let server: MijiaDeckServer | null = null;
let mockGateway: ReturnType<typeof Bun.serve> | null = null;

function makeSine(durationSec: number, sampleRate = 16000, freqHz = 440, amp = 0.25): Float32Array {
  const n = Math.round(durationSec * sampleRate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    out[i] = Math.sin((2 * Math.PI * freqHz * i) / sampleRate) * amp;
  }
  return out;
}

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "mijiadeck-remote-voice-gw-"));
  const dir = tmpDir;
  setDataPathOverrides({ dataDir: () => dir });
});

afterEach(async () => {
  if (server) {
    await server.stop();
    server = null;
  }
  if (mockGateway) {
    mockGateway.stop(true);
    mockGateway = null;
  }
  setDataPathOverrides(null);
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = "";
  }
});

describe("在线 Voice & ASR Gateway 配置持久化、同源密钥复用与安全脱敏", () => {
  test("持久化 ClearVoice 与 Qwen3-ASR 远程网关配置且向前端一律脱敏", () => {
    const def = defaultAgentVoiceConfig();
    expect(def.clearVoiceServiceUrl).toBe("");
    expect(def.clearVoiceApiKey).toBe("");
    expect(def.clearVoiceModel).toBe("MossFormer2_SE_48K");
    expect(def.qwen3AsrServiceUrl).toBe("");
    expect(def.qwen3AsrApiKey).toBe("");
    expect(def.qwen3AsrModel).toBe("Qwen/Qwen3-ASR-0.6B");

    const updated = updateAgentVoiceConfig({
      clearVoiceServiceUrl: "https://voice.example.cn:18443/",
      clearVoiceApiKey: "vgw_testSecretToken1234567890",
      clearVoiceModel: "FRCRN_SE_16K",
      qwen3AsrServiceUrl: "https://voice.example.cn:18443/v1/",
      qwen3AsrModel: "Qwen/Qwen3-ASR-0.6B",
    });

    expect(updated.clearVoiceServiceUrl).toBe("https://voice.example.cn:18443");
    expect(updated.clearVoiceApiKey).toBe("vgw_testSecretToken1234567890");
    expect(updated.clearVoiceModel).toBe("FRCRN_SE_16K");
    expect(updated.qwen3AsrServiceUrl).toBe("https://voice.example.cn:18443/v1");
    expect(updated.qwen3AsrApiKey).toBe("");

    // 同源自动安全复用 ClearVoice 授权码
    const qwenAuthSameOrigin = resolveEffectiveQwen3AsrAuth(updated);
    expect(qwenAuthSameOrigin.configured).toBe(true);
    expect(qwenAuthSameOrigin.apiKey).toBe("vgw_testSecretToken1234567890");

    // 面向前端序列化绝不泄露明文密钥
    const pub = toPublicAgentVoiceConfig(updated) as unknown as Record<string, unknown>;
    expect(pub.clearVoiceApiKey).toBeUndefined();
    expect(pub.qwen3AsrApiKey).toBeUndefined();
    expect(pub.hasClearVoiceApiKey).toBe(true);
    expect(pub.clearVoiceApiKeyPreview).toBe("vgw_••••7890");
    expect(pub.effectiveClearVoiceRemoteConfigured).toBe(true);
    expect(pub.hasQwen3AsrApiKey).toBe(false);
    expect(pub.effectiveQwen3AsrRemoteConfigured).toBe(true);

    // 跨不同域名绝不泄露密钥！
    const diffOrigin = updateAgentVoiceConfig({
      qwen3AsrServiceUrl: "https://other-asr.example.com:8443",
    });
    const qwenAuthDiffOrigin = resolveEffectiveQwen3AsrAuth(diffOrigin);
    expect(qwenAuthDiffOrigin.apiKey).toBeUndefined();
    expect(qwenAuthDiffOrigin.configured).toBe(false);

    // 清除密钥与持久化重载验证
    const cleared = updateAgentVoiceConfig({ clearClearVoiceApiKey: true });
    expect(cleared.clearVoiceApiKey).toBe("");
    expect(loadAgentVoiceConfig().clearVoiceApiKey).toBe("");
    expect(resolveEffectiveClearVoiceAuth(cleared).configured).toBe(false);

    // 错误清洗器自动脱敏 vgw_ 授权码
    expect(
      sanitizeErrorMessage(new Error("auth failed with vgw_testSecretToken1234567890 in header")),
    ).not.toContain("vgw_testSecretToken1234567890");
  });

  test("规范化各种形式的服务地址并正确映射 Qwen3-ASR 语种（防静音幻觉）", () => {
    expect(resolveClearVoiceGatewayEndpoints("https://voice.1inch.cn:18443/").enhanceUrl).toBe(
      "https://voice.1inch.cn:18443/clearvoice/v1/enhance",
    );
    expect(
      resolveClearVoiceGatewayEndpoints("https://voice.1inch.cn:18443/clearvoice/v1").separateUrl,
    ).toBe("https://voice.1inch.cn:18443/clearvoice/v1/separate");
    expect(resolveClearVoiceGatewayEndpoints("https://voice.1inch.cn:18443/v1").healthUrl).toBe(
      "https://voice.1inch.cn:18443/health",
    );

    expect(resolveQwen3AsrGatewayEndpoints("https://voice.1inch.cn:18443").transcriptionsUrl).toBe(
      "https://voice.1inch.cn:18443/v1/audio/transcriptions",
    );
    expect(resolveQwen3AsrGatewayEndpoints("https://voice.1inch.cn:18443/v1").transcriptionsUrl).toBe(
      "https://voice.1inch.cn:18443/v1/audio/transcriptions",
    );
    expect(
      resolveQwen3AsrGatewayEndpoints("https://voice.1inch.cn:18443/asr/v1/audio/transcriptions")
        .transcriptionsUrl,
    ).toBe("https://voice.1inch.cn:18443/asr/v1/audio/transcriptions");
    expect(resolveQwen3AsrGatewayEndpoints("https://voice.1inch.cn:18443/v1/transcribe").preferJsonTranscribe).toBe(
      true,
    );

    // 中文与自动模式留空启用原生中英混说且防静音幻觉
    expect(mapQwen3GatewayLang("zh-CN")).toBe("");
    expect(mapQwen3GatewayLang("auto")).toBe("");
    expect(mapQwen3GatewayLang("en-US")).toBe("English");
    expect(mapQwen3GatewayLang("zh-HK")).toBe("Cantonese");
    expect(mapQwen3GatewayLang("ja-JP")).toBe("Japanese");
    expect(mapQwen3GatewayLang("ko-KR")).toBe("Korean");
  });

  test("recoverSeparatedTrackGains 撤销远程 BSS 独立 RMS 归一化：单人剔除残影轨、双人恢复真实响度与相位", () => {
    const speakerA = makeSine(1.2, 16000, 320, 0.24);
    const speakerB = makeSine(1.2, 16000, 890, 0.20);
    const tinyNoise = makeSine(1.2, 16000, 1400, 0.004);

    // 场景 1：单人说话，模拟远程 ClearVoice 将主轨与极微弱残影轨各自归一化到相同 RMS 0.03
    const normTo = (arr: Float32Array, targetRms: number) => {
      const r = computeRms(arr) || 1;
      return arr.map((v) => (v / r) * targetRms);
    };
    const singleRaw = speakerA;
    const singleFakeSp1 = normTo(speakerA, 0.03);
    const singleFakeSp2 = normTo(tinyNoise, 0.03);

    const recoveredSingle = recoverSeparatedTrackGains(singleRaw, [singleFakeSp1, singleFakeSp2]);
    expect(computeRms(recoveredSingle[0]!)).toBeCloseTo(computeRms(speakerA), 2);
    expect(computeRms(recoveredSingle[1]!)).toBeLessThan(0.005);
    const prunedSingle = pruneInactiveOrDuplicateTracks(recoveredSingle);
    expect(prunedSingle.tracks).toHaveLength(1);

    // 场景 2：双人重叠且 sp2 存在反相，物理投影恢复双方真实响度与正确相位且完整保留 2 轨
    const dualRaw = new Float32Array(speakerA.length);
    for (let i = 0; i < dualRaw.length; i += 1) {
      dualRaw[i] = speakerA[i]! + speakerB[i]!;
    }
    const dualNormSp1 = normTo(speakerA, 0.03);
    const dualNormSp2Inverted = normTo(speakerB, 0.03).map((v) => -v);

    const recoveredDual = recoverSeparatedTrackGains(dualRaw, [dualNormSp1, dualNormSp2Inverted]);
    expect(computeRms(recoveredDual[0]!)).toBeCloseTo(computeRms(speakerA), 2);
    expect(computeRms(recoveredDual[1]!)).toBeCloseTo(computeRms(speakerB), 2);
    // 反相被精确纠正回正相（与原 speakerB 高度正相关）
    let dot = 0;
    for (let i = 0; i < speakerB.length; i += 1) dot += speakerB[i]! * recoveredDual[1]![i]!;
    expect(dot).toBeGreaterThan(0);
    const prunedDual = pruneInactiveOrDuplicateTracks(recoveredDual);
    expect(prunedDual.tracks).toHaveLength(2);
  });
});

describe("在线 Voice & ASR Gateway 协议联调（Mock Gateway 还原 README 完整契约）", () => {
  test("ClearVoice 在线降噪/多轨分离 + Qwen3-ASR 在线识别 + /api/voice/gateway/test 全链路验证", async () => {
    const AUTH_CODE = "vgw_mock_gateway_code_9876543210";
    let enhanceCalls = 0;
    let separateCalls = 0;
    let asrMultipartCalls = 0;
    let asrJsonCalls = 0;
    const capturedAsr: { language: string | null; prompt: string | null } = {
      language: null,
      prompt: null,
    };
    let separateMode: "single" | "dual" = "dual";

    mockGateway = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const u = new URL(req.url);
        if (u.pathname === "/healthz") {
          return Response.json({ status: "ok", service: "voice-asr-gateway" });
        }

        const authHeader = req.headers.get("authorization") || "";
        const xAuthCode = req.headers.get("x-auth-code") || "";
        const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : xAuthCode.trim();
        if (token !== AUTH_CODE) {
          return Response.json({ detail: "Invalid auth code" }, { status: 401 });
        }

        if (u.pathname === "/health") {
          return Response.json({
            status: "ok",
            auth: { key_id: "key_mock", key_name: "default", services: ["clearvoice", "asr"] },
            upstreams: {
              clearvoice: {
                status: "ok",
                http_status: 200,
                latency_ms: 3.1,
                details: {
                  status: "ok",
                  service: "clearvoice",
                  cuda_available: true,
                  gpu_name: "AMD Radeon AI PRO R9700",
                  loaded_models: [
                    { name: "MossFormer2_SE_48K", task: "speech_enhancement", sample_rate: 48000 },
                    { name: "MossFormer2_SS_16K", task: "speech_separation", sample_rate: 16000 },
                  ],
                },
              },
              asr: {
                status: "ok",
                http_status: 200,
                latency_ms: 2.4,
                details: {
                  status: "ok",
                  service: "qwen3-asr",
                  model: "Qwen/Qwen3-ASR-0.6B",
                  loaded: true,
                  cuda_available: true,
                  gpu_name: "AMD Radeon AI PRO R9700",
                  supported_languages_count: 30,
                },
              },
            },
          });
        }

        if (u.pathname === "/clearvoice/v1/enhance" || u.pathname === "/v1/audio/enhance") {
          enhanceCalls += 1;
          const form = await req.formData();
          const file = form.get("file") as Blob;
          const model = String(form.get("model") || "MossFormer2_SE_48K");
          const decoded = decodeWavPcm(new Uint8Array(await file.arrayBuffer()));
          const enhanced = decoded.samples.map((v) => v * 0.92);
          const outWav = encodeWavPcm16(enhanced, decoded.sampleRate);
          return new Response(new Uint8Array(outWav), {
            status: 200,
            headers: {
              "Content-Type": "audio/wav",
              "X-ClearVoice-Model": model,
              "X-Elapsed-Ms": "42.5",
              "X-Audio-Sample-Rate": String(decoded.sampleRate),
            },
          });
        }

        if (u.pathname === "/clearvoice/v1/separate") {
          separateCalls += 1;
          const form = await req.formData();
          const file = form.get("file") as Blob;
          const decoded = decodeWavPcm(new Uint8Array(await file.arrayBuffer()));
          const n = decoded.samples.length;
          const sr = decoded.sampleRate;
          const sp1 = makeSine(n / sr, sr, 320, 0.03);
          const sp2 =
            separateMode === "dual" ? makeSine(n / sr, sr, 880, 0.03) : makeSine(n / sr, sr, 1500, 0.03);
          return Response.json({
            task: "speech_separation",
            model: "MossFormer2_SS_16K",
            elapsed_ms: 85.0,
            speakers: [
              {
                speaker: 1,
                filename: "speaker_1.wav",
                sample_rate: sr,
                duration: n / sr,
                mime_type: "audio/wav",
                audio_base64: Buffer.from(encodeWavPcm16(sp1, sr)).toString("base64"),
              },
              {
                speaker: 2,
                filename: "speaker_2.wav",
                sample_rate: sr,
                duration: n / sr,
                mime_type: "audio/wav",
                audio_base64: Buffer.from(encodeWavPcm16(sp2, sr)).toString("base64"),
              },
            ],
          });
        }

        if (u.pathname === "/v1/audio/transcriptions" || u.pathname === "/asr/v1/audio/transcriptions") {
          asrMultipartCalls += 1;
          const form = await req.formData();
          const lang = form.get("language");
          const prompt = form.get("prompt");
          capturedAsr.language = lang === null ? null : String(lang);
          capturedAsr.prompt = prompt === null ? null : String(prompt);
          return Response.json({
            task: "transcribe",
            language: "Chinese",
            duration: 1.0,
            text: "Neo，打开客厅吸顶灯。",
            model: String(form.get("model") || "Qwen/Qwen3-ASR-0.6B"),
            elapsed_ms: 112.0,
          });
        }

        if (u.pathname === "/v1/transcribe") {
          asrJsonCalls += 1;
          const body = (await req.json()) as { audio_base64?: string };
          if (!body.audio_base64) {
            return Response.json({ detail: "missing audio_base64" }, { status: 400 });
          }
          return Response.json({
            text: "把卧室空调调到二十五度。",
            language: "Chinese",
            model: "Qwen/Qwen3-ASR-0.6B",
            duration: 1.0,
            elapsed_ms: 95.0,
          });
        }

        return new Response("not found", { status: 404 });
      },
    });

    const gatewayUrl = `http://127.0.0.1:${mockGateway.port}`;

    // 0. 未配置在线网关时，ClearVoice 与 Qwen3-ASR 均严格报告未就绪且仅支持在线模式（不再启动本地模型/进程）
    const unconfiguredCv = new ClearVoiceGpuRuntime();
    expect(unconfiguredCv.getStatus().ready).toBe(false);
    expect(unconfiguredCv.getStatus().provider).toBe("none");
    await expect(unconfiguredCv.denoiseSlice(makeSine(0.5))).rejects.toThrow(/仅支持在线模式/);
    unconfiguredCv.dispose();

    const unconfiguredQwen = new Qwen3AsrGpuRuntime();
    expect(unconfiguredQwen.getStatus().ready).toBe(false);
    expect(unconfiguredQwen.getStatus().backend).toBe("none");
    await expect(unconfiguredQwen.transcribe(makeSine(0.5))).rejects.toThrow(/仅支持在线模式/);
    unconfiguredQwen.dispose();

    // 1. 直接验证 ClearVoiceGpuRuntime (gateway 模式)
    const cv = new ClearVoiceGpuRuntime({
      serviceUrl: gatewayUrl,
      apiKey: AUTH_CODE,
      model: "MossFormer2_SE_48K",
    });
    const cvHealth = await cv.probeRemoteHealth();
    expect(cvHealth.ok).toBe(true);
    expect(cvHealth.protocol).toBe("gateway");
    expect(cvHealth.gpuName).toBe("AMD Radeon AI PRO R9700");
    expect(cv.getStatus().provider).toBe("remote");
    expect(cv.getStatus().multiTrackReady).toBe(true);
    expect(cv.getStatus().gpuName).toBe("AMD Radeon AI PRO R9700");

    // 单轨降噪
    const toneA = makeSine(1.0, 16000, 320, 0.25);
    const enhRes = await cv.denoiseSlice(toneA, { inputSampleRate: 16000, outputSampleRate: 16000 });
    expect(enhRes.samples.length).toBe(toneA.length);
    expect(enhRes.provider).toBe("remote");
    expect(enhRes.device).toBe("gpu");
    expect(enhRes.gpuName).toBe("AMD Radeon AI PRO R9700");
    expect(enhanceCalls).toBe(1);

    // 双人重叠分离 + 分轨并行降噪 -> 完整保留 2 轨
    separateMode = "dual";
    const toneB = makeSine(1.0, 16000, 880, 0.22);
    const mixDual = new Float32Array(toneA.length);
    for (let i = 0; i < mixDual.length; i += 1) mixDual[i] = toneA[i]! + toneB[i]!;
    const sepDual = await cv.separateSlice(mixDual, {
      inputSampleRate: 16000,
      outputSampleRate: 16000,
      pruneTracks: true,
      applyDenoise: true,
    });
    expect(sepDual.ssUsed).toBe(true);
    expect(sepDual.provider).toBe("remote");
    expect(sepDual.tracks).toHaveLength(2);
    expect(separateCalls).toBe(1);
    expect(enhanceCalls).toBe(3); // 1 single + 2 parallel tracks

    // 单人说话分离 -> 物理投影识别出虚假残影轨并提前剔除，仅增强主轨 1 次！
    separateMode = "single";
    const sepSingle = await cv.separateSlice(toneA, {
      inputSampleRate: 16000,
      outputSampleRate: 16000,
      pruneTracks: true,
      applyDenoise: true,
    });
    expect(sepSingle.tracks).toHaveLength(1);
    expect(enhanceCalls).toBe(4); // 只增强了主轨，未对残影轨浪费远程调用
    cv.dispose();

    // 2. 验证 Qwen3AsrGpuRuntime (multipart OpenAI Whisper 兼容 + JSON /v1/transcribe)
    const qwen = new Qwen3AsrGpuRuntime({
      serviceUrl: gatewayUrl,
      apiKey: AUTH_CODE,
      model: "Qwen/Qwen3-ASR-0.6B",
    });
    const qwenHealth = await qwen.probeRemoteHealth();
    expect(qwenHealth.ok).toBe(true);
    expect(qwenHealth.gpuName).toBe("AMD Radeon AI PRO R9700");
    expect(qwen.getStatus().backend).toBe("remote");
    expect(qwen.getStatus().ready).toBe(true);

    const partials: string[] = [];
    const asrRes = await qwen.transcribe(toneA, {
      voiceLang: "zh-CN",
      hotwords: ["Neo", "小派"],
      onPartial: (t) => partials.push(t),
    });
    expect(asrRes.text).toBe("Neo，打开客厅吸顶灯。");
    expect(asrRes.backend).toBe("remote");
    expect(asrRes.deviceName).toBe("AMD Radeon AI PRO R9700");
    expect(asrMultipartCalls).toBe(1);
    expect(capturedAsr.language).toBeNull(); // zh-CN 不强制传 language，防静音幻觉并保持中英混说
    expect(capturedAsr.prompt).toBeNull(); // 不向 Qwen3-ASR 注入 hotwords prompt，彻底杜绝静音/弱音复读唤醒词列表幻觉
    expect(partials).toEqual(["Neo，打开客厅吸顶灯。"]);
    qwen.dispose();

    // /v1/transcribe JSON 模式
    const qwenJson = new Qwen3AsrGpuRuntime({
      serviceUrl: `${gatewayUrl}/v1/transcribe`,
      apiKey: AUTH_CODE,
    });
    const jsonRes = await qwenJson.transcribe(toneA, { voiceLang: "zh-CN" });
    expect(jsonRes.text).toBe("把卧室空调调到二十五度。");
    expect(asrJsonCalls).toBe(1);
    qwenJson.dispose();

    // 3. 验证 LocalVoiceEngine 统一编排
    const engine = new LocalVoiceEngine({ modelsDir: tmpDir });
    engine.setClearVoiceRemoteConfig({ serviceUrl: gatewayUrl, apiKey: AUTH_CODE });
    engine.setQwen3AsrRemoteConfig({ serviceUrl: gatewayUrl, apiKey: AUTH_CODE });
    const st = engine.getStatus();
    expect(st.readyForClearVoiceGpu).toBe(true);
    expect(st.readyForClearVoiceBss).toBe(true);
    expect(st.readyForQwen3Remote).toBe(true);
    expect(st.readyForLocalAsr).toBe(true);
    expect(st.activeQwen3Device).toBe("remote");
    expect(st.primaryAsrEngine).toBe("qwen3-asr");

    const localRes = await engine.transcribeLocal(toneA, 16000, "zh-CN", {
      hotwords: ["Neo"],
    });
    expect(localRes.engine).toBe("qwen3-asr-remote");
    expect(localRes.computeDevice).toBe("remote");
    expect(localRes.text).toBe("Neo，打开客厅吸顶灯。");
    engine.dispose();

    // 4. 验证 MijiaDeck HTTP Server 配置 API、测试接口与 UI DOM 元素
    server = await startMijiaDeckServer({
      mode: "demo",
      port: 0,
      hostname: "127.0.0.1",
      service: new VirtualDemoService(),
    });

    const saveRes = await fetch(`${server.url}/api/agent/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        voicePipelineMode: "clearvoice",
        clearVoiceServiceUrl: gatewayUrl,
        clearVoiceApiKey: AUTH_CODE,
        clearVoiceModel: "MossFormer2_SE_48K",
        qwen3AsrServiceUrl: gatewayUrl,
        qwen3AsrModel: "Qwen/Qwen3-ASR-0.6B",
      }),
    });
    expect(saveRes.ok).toBe(true);
    const saveJson = (await saveRes.json()) as {
      config: Record<string, unknown>;
      voice: {
        clearVoiceServiceUrl: string;
        qwen3AsrServiceUrl: string;
        localEngine: {
          activeQwen3Device: string;
          readyForClearVoiceGpu: boolean;
          readyForQwen3Remote: boolean;
        };
      };
    };
    // API 绝不回传明文授权码
    expect(saveJson.config.clearVoiceApiKey).toBeUndefined();
    expect(saveJson.config.qwen3AsrApiKey).toBeUndefined();
    expect(saveJson.config.hasClearVoiceApiKey).toBe(true);
    expect(saveJson.config.effectiveClearVoiceRemoteConfigured).toBe(true);
    expect(saveJson.config.effectiveQwen3AsrRemoteConfigured).toBe(true);
    expect(saveJson.voice.localEngine.activeQwen3Device).toBe("remote");
    expect(saveJson.voice.localEngine.readyForClearVoiceGpu).toBe(true);
    expect(saveJson.voice.localEngine.readyForQwen3Remote).toBe(true);

    // /api/voice/gateway/test 测试连通性（复用已保存授权码）
    const testOkRes = await fetch(`${server.url}/api/voice/gateway/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(testOkRes.ok).toBe(true);
    const testOkJson = (await testOkRes.json()) as {
      ok: boolean;
      clearvoice: { ok: boolean; gpuName: string | null };
      asr: { ok: boolean; gpuName: string | null; model: string | null };
    };
    expect(testOkJson.ok).toBe(true);
    expect(testOkJson.clearvoice.ok).toBe(true);
    expect(testOkJson.clearvoice.gpuName).toBe("AMD Radeon AI PRO R9700");
    expect(testOkJson.asr.ok).toBe(true);
    expect(testOkJson.asr.model).toBe("Qwen/Qwen3-ASR-0.6B");

    // 错误授权码应明确报 401 且不泄露密钥
    const testBadRes = await fetch(`${server.url}/api/voice/gateway/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clearVoiceServiceUrl: gatewayUrl,
        clearVoiceApiKey: "vgw_wrong_token_00000000",
        qwen3AsrServiceUrl: gatewayUrl,
        qwen3AsrApiKey: "vgw_wrong_token_00000000",
      }),
    });
    const testBadJson = (await testBadRes.json()) as {
      ok: boolean;
      clearvoice: { ok: boolean; error?: string };
      asr: { ok: boolean; error?: string };
    };
    expect(testBadJson.ok).toBe(false);
    expect(testBadJson.clearvoice.ok).toBe(false);
    expect(testBadJson.clearvoice.error).toContain("401");
    expect(testBadJson.clearvoice.error).not.toContain("vgw_wrong_token_00000000");

    // 页面 DOM 包含在线模型网关设置控件，且已移除本地 GPU 推理设备选择器与本地 GPU 徽章
    const html = await (await fetch(`${server.url}/`)).text();
    expect(html).toContain("setting-row-voice-gateway");
    expect(html).toContain("set-clearvoice-service-url");
    expect(html).toContain("set-clearvoice-api-key");
    expect(html).toContain("set-qwen3-asr-service-url");
    expect(html).toContain("set-qwen3-asr-api-key");
    expect(html).toContain("set-voice-gateway-test-btn");
    expect(html).not.toContain("setting-row-qwen3-device");
    expect(html).not.toContain("set-voice-qwen3-device");
    expect(html).not.toContain("badge-model-qwen3-gpu");
  });
});
