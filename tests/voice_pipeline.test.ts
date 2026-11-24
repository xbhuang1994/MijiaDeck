// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 语音识别、环境降噪、声纹识别与唤醒词注意力机制深度测试

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  adaptiveEnergyVad,
  applyHighPassFilter,
  cosineSimilarity,
  decodeWavPcm,
  encodeWavPcm16,
  estimateSnrDb,
  extractFallbackVoiceprint,
  isWavBuffer,
  resampleLinear,
  spectralSubtractDenoise,
} from "../src/agent/audioPcm.ts";
import { cleanSenseVoiceText, LocalVoiceEngine } from "../src/agent/localVoiceEngine.ts";
import {
  computeEchoOverlap,
  evaluateVoiceAttention,
  findWakeWordSpan,
  parseLlmAttentionJson,
} from "../src/agent/voiceAttentionGate.ts";
import {
  clearVoiceprints,
  deleteVoiceprint,
  enrollVoiceprint,
  identifyVoiceprint,
  listPublicVoiceprints,
} from "../src/agent/voiceprintStore.ts";
import { setDataPathOverrides } from "../src/core/jsonStore.ts";
import { VirtualDemoService } from "../src/core/virtualLightService.ts";
import { startMijiaDeckServer, type MijiaDeckServer } from "../src/server/server.ts";

let tmpDir = "";
let server: MijiaDeckServer | null = null;

function synthSpeechLikeWave(options: {
  durationSec?: number;
  sampleRate?: number;
  f0Hz?: number;
  formantHz?: number;
  amp?: number;
  noiseAmp?: number;
  hum50HzAmp?: number;
  leadingSilenceSec?: number;
  trailingSilenceSec?: number;
}): Float32Array {
  const sr = options.sampleRate ?? 16000;
  const lead = Math.round((options.leadingSilenceSec ?? 0.35) * sr);
  const trail = Math.round((options.trailingSilenceSec ?? 0.35) * sr);
  const body = Math.round((options.durationSec ?? 1.4) * sr);
  const total = lead + body + trail;
  const out = new Float32Array(total);
  const f0 = options.f0Hz ?? 185;
  const formant = options.formantHz ?? 760;
  const amp = options.amp ?? 0.45;
  const noiseAmp = options.noiseAmp ?? 0;
  const humAmp = options.hum50HzAmp ?? 0;

  let seed = Math.round(f0 * 97 + formant * 13);
  const nextRand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return (seed / 0xffffffff) * 2 - 1;
  };

  for (let i = 0; i < total; i += 1) {
    const t = i / sr;
    let val = 0;
    if (i >= lead && i < lead + body) {
      const localT = (i - lead) / sr;
      // 模拟音节包络与谐波共振峰
      const syllEnv = 0.55 + 0.45 * Math.sin(2 * Math.PI * 3.8 * localT);
      const pitch = f0 * (1 + 0.06 * Math.sin(2 * Math.PI * 2.1 * localT));
      val =
        amp *
        syllEnv *
        (0.55 * Math.sin(2 * Math.PI * pitch * t) +
          0.3 * Math.sin(2 * Math.PI * formant * t) +
          0.15 * Math.sin(2 * Math.PI * (formant * 1.9) * t));
    }
    if (humAmp > 0) {
      val += humAmp * Math.sin(2 * Math.PI * 50 * t);
    }
    if (noiseAmp > 0) {
      val += noiseAmp * nextRand();
    }
    out[i] = Math.max(-1, Math.min(1, val));
  }
  return out;
}

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "mijiadeck-voice-pipe-"));
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

describe("Audio PCM WAV Codec & Environmental Noise Suppression", () => {
  test("encodes and decodes 16kHz PCM WAV accurately and resamples 48kHz -> 16kHz", () => {
    const clean = synthSpeechLikeWave({ durationSec: 0.6, f0Hz: 210 });
    const wavBytes = encodeWavPcm16(clean, 16000);
    expect(isWavBuffer(wavBytes)).toBe(true);

    const decoded = decodeWavPcm(wavBytes);
    expect(decoded.sampleRate).toBe(16000);
    expect(decoded.channels).toBe(1);
    expect(decoded.samples.length).toBe(clean.length);

    const wave48k = synthSpeechLikeWave({ sampleRate: 48000, durationSec: 0.5, f0Hz: 200 });
    const down16k = resampleLinear(wave48k, 48000, 16000);
    expect(Math.abs(down16k.length - Math.round(wave48k.length / 3))).toBeLessThanOrEqual(2);
  });

  test("high-pass + spectral subtraction DSP improves SNR on noisy hum+broadband audio", () => {
    const noisy = synthSpeechLikeWave({
      durationSec: 1.5,
      f0Hz: 210,
      formantHz: 850,
      amp: 0.42,
      noiseAmp: 0.08,
      hum50HzAmp: 0.12,
    });
    const rawSnr = estimateSnrDb(noisy, 16000);
    const hp = applyHighPassFilter(noisy, 16000, 85);
    expect(estimateSnrDb(hp, 16000)).toBeGreaterThanOrEqual(rawSnr);

    const denoised = spectralSubtractDenoise(noisy, 16000);
    expect(denoised.outputSnrDb).toBeGreaterThan(denoised.inputSnrDb);
    expect(denoised.snrGainDb).toBeGreaterThan(2);

    const vad = adaptiveEnergyVad(denoised.samples, 16000);
    expect(vad.hasSpeech).toBe(true);
    expect(vad.segmentCount).toBeGreaterThanOrEqual(1);

    // Pure steady noise should be rejected by adaptive VAD
    const pureNoise = synthSpeechLikeWave({ amp: 0, noiseAmp: 0.05, durationSec: 1.2 });
    const noiseVad = adaptiveEnergyVad(pureNoise, 16000);
    expect(noiseVad.hasSpeech).toBe(false);
  });

  test("LocalVoiceEngine GTCRN neural denoiser & Silero VAD work when models exist (and degrade gracefully otherwise)", () => {
    const engine = new LocalVoiceEngine();
    const status = engine.getStatus();
    const noisy = synthSpeechLikeWave({
      durationSec: 1.6,
      f0Hz: 195,
      formantHz: 780,
      amp: 0.45,
      noiseAmp: 0.07,
      hum50HzAmp: 0.1,
    });

    const out = engine.denoise(noisy, 16000, "auto");
    expect(out.samples.length).toBeGreaterThan(0);
    expect(out.outputSnrDb).toBeGreaterThan(out.inputSnrDb);
    if (status.readyForDenoise) {
      expect(out.engine).toBe("gtcrn");
    } else {
      expect(out.engine).toBe("dsp");
    }

    expect(cleanSenseVoiceText("<|zh|><|NEUTRAL|><|Speech|>小派，打开客厅吸顶灯")).toBe(
      "小派，打开客厅吸顶灯",
    );
    engine.dispose();
  });
});

describe("Voiceprint Enrollment & Verification Store", () => {
  test("separates distinct voices via multi-sample centroid embeddings and supports CRUD", () => {
    const speakerA1 = synthSpeechLikeWave({ f0Hz: 135, formantHz: 520, durationSec: 1.5 });
    const speakerA2 = synthSpeechLikeWave({ f0Hz: 142, formantHz: 545, durationSec: 1.5 });
    const speakerATest = synthSpeechLikeWave({ f0Hz: 138, formantHz: 530, durationSec: 1.5 });
    const speakerB = synthSpeechLikeWave({ f0Hz: 310, formantHz: 1550, durationSec: 1.5 });

    const embA1 = extractFallbackVoiceprint(speakerA1, 16000);
    const embA2 = extractFallbackVoiceprint(speakerA2, 16000);
    const embATest = extractFallbackVoiceprint(speakerATest, 16000);
    const embB = extractFallbackVoiceprint(speakerB, 16000);

    expect(cosineSimilarity(embA1, embATest)).toBeGreaterThan(cosineSimilarity(embA1, embB));

    const p1 = enrollVoiceprint({ name: "主人", embedding: embA1, engine: "dsp-mfcc", role: "owner" });
    expect(p1.sampleCount).toBe(1);
    const p2 = enrollVoiceprint({ name: "主人", embedding: embA2, engine: "dsp-mfcc", role: "owner" });
    expect(p2.id).toBe(p1.id);
    expect(p2.sampleCount).toBe(2);

    const hitA = identifyVoiceprint(embATest, "dsp-mfcc", 0.75);
    expect(hitA.evaluated).toBe(true);
    expect(hitA.matched).toBe(true);
    expect(hitA.speakerName).toBe("主人");

    const rejectB = identifyVoiceprint(embB, "dsp-mfcc", 0.75);
    expect(rejectB.evaluated).toBe(true);
    expect(rejectB.matched).toBe(false);
    expect(rejectB.score).toBeLessThan(hitA.score);

    expect(listPublicVoiceprints().length).toBe(1);
    expect(deleteVoiceprint(p1.id)).toBe(true);
    expect(listPublicVoiceprints().length).toBe(0);
    clearVoiceprints();
  });
});

describe("Wake-Word Attention Mechanism (DDSD)", () => {
  const wakeWords = ["小派", "派派", "pi", "米家助手"];

  test("recovers Chinese homophone wake words while protecting English word boundaries", () => {
    const fuzzy = findWakeWordSpan("小拍，打开客厅吸顶灯", wakeWords);
    expect(fuzzy).not.toBeNull();
    expect(fuzzy!.wakeWord).toBe("小派");
    expect(fuzzy!.fuzzy).toBe(true);
    expect(fuzzy!.afterText).toBe("打开客厅吸顶灯");

    expect(findWakeWordSpan("take a picture please", wakeWords)).toBeNull();
  });

  test("fast-paths clear vocative commands and rejects third-person wake-word mentions deterministically", async () => {
    const direct = await evaluateVoiceAttention({
      rawText: "小派，打开客厅吸顶灯",
      wakeWordEnabled: true,
      wakeWords,
      attentionMode: "smart",
    });
    expect(direct.accept).toBe(true);
    expect(direct.stage).toBe("fast-wake");
    expect(direct.command).toBe("打开客厅吸顶灯");

    const thirdPerson = await evaluateVoiceAttention({
      rawText: "我刚才跟朋友聊到小派这个项目挺好用的",
      wakeWordEnabled: true,
      wakeWords,
      attentionMode: "smart",
    });
    expect(thirdPerson.accept).toBe(false);
    expect(thirdPerson.addressed).toBe(false);
    expect(thirdPerson.stage).toBe("pragmatic-reject");

    const dismissive = await evaluateVoiceAttention({
      rawText: "别管小派了，我们去吃饭吧",
      wakeWordEnabled: true,
      wakeWords,
      attentionMode: "smart",
    });
    expect(dismissive.accept).toBe(false);

    const metaQuestion = await evaluateVoiceAttention({
      rawText: "小派好用吗？我觉得还可以",
      wakeWordEnabled: true,
      wakeWords,
      attentionMode: "smart",
    });
    expect(metaQuestion.accept).toBe(false);
  });

  test("uses Pi Agent LLM Attention Gate for ambiguous mentions and active conversation side-talk", async () => {
    const promptsSeen: string[] = [];
    const mockLlm = async (prompt: string) => {
      promptsSeen.push(prompt);
      const utteranceMatch = /最新听到的语音文本："""([\s\S]*?)"""/.exec(prompt);
      const utterance = utteranceMatch ? utteranceMatch[1]! : "";
      if (utterance.includes("聊到小派") || utterance.includes("晚饭吃什么")) {
        return JSON.stringify({
          addressed: false,
          inConversation: false,
          confidence: 0.94,
          reason: "说话人在与他人聊天提及助手或讨论晚饭，并非在对助手下达指令",
          command: "",
        });
      }
      return JSON.stringify({
        addressed: true,
        inConversation: true,
        confidence: 0.92,
        reason: "用户承接上一轮对话继续调整亮度",
        command: "再调亮到90%",
      });
    };

    // Ambiguous wake-word mention -> triggers LLM attention gate -> rejects!
    const rejWake = await evaluateVoiceAttention({
      rawText: "我刚跟朋友聊到小派，挺聪明的",
      wakeWordEnabled: true,
      wakeWords,
      attentionMode: "smart",
      llmEvaluator: mockLlm,
    });
    expect(rejWake.accept).toBe(false);
    expect(rejWake.usedLlm).toBe(true);
    expect(rejWake.stage).toBe("llm-attention");

    // Strict mode checks even direct wake commands via LLM attention gate
    const strictOk = await evaluateVoiceAttention({
      rawText: "小派，再调亮到90%",
      wakeWordEnabled: true,
      wakeWords,
      attentionMode: "strict",
      llmEvaluator: mockLlm,
    });
    expect(strictOk.accept).toBe(true);
    expect(strictOk.usedLlm).toBe(true);
    expect(strictOk.command).toBe("再调亮到90%");

    // In-conversation side-talk rejected by LLM attention gate
    const sideTalk = await evaluateVoiceAttention({
      rawText: "你今晚晚饭吃什么呀，帮我顺便点个外卖",
      wakeWordEnabled: true,
      wakeWords,
      attentionMode: "smart",
      inConversation: true,
      recentTurns: [
        { role: "user", text: "把客厅灯亮度调到 70%", timestamp: Date.now() - 4000 },
        { role: "assistant", text: "已将客厅吸顶灯亮度调到 70%。", timestamp: Date.now() - 3000 },
      ],
      llmEvaluator: mockLlm,
    });
    expect(sideTalk.accept).toBe(false);
    expect(sideTalk.usedLlm).toBe(true);
    expect(promptsSeen.length).toBe(3);

    // Self-TTS echo suppression & BGM acoustic event rejection
    expect(computeEchoOverlap("已将客厅吸顶灯亮度调到70", "已将客厅吸顶灯亮度调到 70%。")).toBeGreaterThan(0.8);
    const echo = await evaluateVoiceAttention({
      rawText: "已将客厅吸顶灯亮度调到70",
      wakeWordEnabled: true,
      wakeWords,
      attentionMode: "smart",
      inConversation: true,
      lastSpokenReply: "已将客厅吸顶灯亮度调到 70%。",
      lastSpokenAt: Date.now() - 1200,
    });
    expect(echo.accept).toBe(false);
    expect(echo.stage).toBe("echo");

    const bgm = await evaluateVoiceAttention({
      rawText: "啦啦啦",
      wakeWordEnabled: true,
      wakeWords,
      attentionMode: "smart",
      inConversation: true,
      acousticEvent: "<|BGM|>",
    });
    expect(bgm.accept).toBe(false);
    expect(bgm.stage).toBe("acoustic");

    expect(
      parseLlmAttentionJson('```json\n{"addressed":false,"inConversation":false,"confidence":0.9,"reason":"旁白","command":""}\n```')
        ?.addressed,
    ).toBe(false);
  });

  test("enforces strict voiceprint policy to block unrecognized speakers", async () => {
    const blocked = await evaluateVoiceAttention({
      rawText: "小派，关闭客厅吸顶灯",
      wakeWordEnabled: true,
      wakeWords,
      attentionMode: "smart",
      voiceprintMode: "strict",
      voiceprint: {
        evaluated: true,
        matched: false,
        speakerId: null,
        speakerName: null,
        role: null,
        score: 0.21,
        threshold: 0.42,
        engine: "3dspeaker-campplus",
        enrolledCount: 1,
        candidates: [{ id: "vp_1", name: "主人", role: "owner", score: 0.21 }],
      },
    });
    expect(blocked.accept).toBe(false);
    expect(blocked.stage).toBe("voiceprint");
  });
});

describe("End-to-End Voice Pipeline HTTP API (Pipeline Status, Voiceprint CRUD, Denoised Audio Upload)", () => {
  test("serves /api/voice/pipeline/status, enrolls/verifies/deletes voiceprints, and runs denoised WAV upload", async () => {
    const demoService = new VirtualDemoService();
    const mockSttFetcher = (async () =>
      new Response(JSON.stringify({ text: "小派，关闭客厅吸顶灯" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;

    server = await startMijiaDeckServer({
      mode: "demo",
      port: 0,
      service: demoService,
      sttFetcher: mockSttFetcher,
    });

    // 1. Check pipeline status endpoint
    const statusRes = await fetch(`${server.url}/api/voice/pipeline/status`);
    expect(statusRes.status).toBe(200);
    const statusJson = (await statusRes.json()) as any;
    expect(statusJson.ok).toBe(true);
    expect(statusJson.localEngine).toBeTruthy();

    // 2. Enroll voiceprint via WAV upload
    const ownerWav = encodeWavPcm16(
      synthSpeechLikeWave({ f0Hz: 155, formantHz: 600, durationSec: 1.8, amp: 0.45, noiseAmp: 0.03 }),
      16000,
    );
    const enrollForm = new FormData();
    enrollForm.append("audio", new Blob([ownerWav as unknown as BlobPart], { type: "audio/wav" }), "owner.wav");
    enrollForm.append("name", "测试主人");
    enrollForm.append("role", "owner");

    const enrollRes = await fetch(`${server.url}/api/voiceprints/enroll`, {
      method: "POST",
      body: enrollForm,
    });
    expect(enrollRes.status).toBe(200);
    const enrollJson = (await enrollRes.json()) as any;
    expect(enrollJson.ok).toBe(true);
    expect(enrollJson.profile.name).toBe("测试主人");
    const profileId = enrollJson.profile.id as string;

    // 3. Verify same speaker via /api/voiceprints/verify
    const verifyForm = new FormData();
    verifyForm.append("audio", new Blob([ownerWav as unknown as BlobPart], { type: "audio/wav" }), "verify.wav");
    const verifyRes = await fetch(`${server.url}/api/voiceprints/verify`, {
      method: "POST",
      body: verifyForm,
    });
    expect(verifyRes.status).toBe(200);
    const verifyJson = (await verifyRes.json()) as any;
    expect(verifyJson.ok).toBe(true);
    expect(verifyJson.result.evaluated).toBe(true);
    expect(verifyJson.result.matched).toBe(true);
    expect(verifyJson.result.speakerName).toBe("测试主人");

    // 4. Configure Whisper STT so WAV upload runs Denoise -> VAD -> Voiceprint -> Cloud STT -> Attention -> Pi Agent
    await fetch(`${server.url}/api/agent/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        voiceEngine: "whisper",
        sttBaseUrl: "https://stt.example.test/v1",
        sttApiKey: "sk-stt-secret-demo-1234",
        noiseSuppressionMode: "dsp",
        vadMode: "adaptive",
        voiceprintMode: "tag",
        attentionMode: "smart",
      }),
    });

    const audioForm = new FormData();
    audioForm.append("audio", new Blob([ownerWav as unknown as BlobPart], { type: "audio/wav" }), "cmd.wav");
    audioForm.append("engine", "whisper");
    const audioRes = await fetch(`${server.url}/api/voice/audio`, {
      method: "POST",
      body: audioForm,
    });
    expect(audioRes.status).toBe(200);
    const audioJson = (await audioRes.json()) as any;
    expect(audioJson.ok).toBe(true);
    expect(audioJson.speechDetected).toBe(true);
    expect(audioJson.denoiseEngine).toBe("dsp");
    expect(audioJson.matched).toBe(true);
    expect(audioJson.command).toBe("关闭客厅吸顶灯");
    expect(audioJson.voiceprint?.speakerName).toBe("测试主人");
    expect(await demoService.powerState("demo-light-living")).toBe(false);

    // 5. Third-person wake-word mention via /api/voice-listen/transcript does NOT toggle device
    const rejRes = await fetch(`${server.url}/api/voice-listen/transcript`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "我刚才聊到小派，打开客厅吸顶灯那个演示挺不错", isFinal: true }),
    });
    const rejJson = (await rejRes.json()) as any;
    expect(rejJson.ok).toBe(true);
    expect(rejJson.matched).toBe(false);
    expect(await demoService.powerState("demo-light-living")).toBe(false);

    // 6. Delete enrolled voiceprint
    const delRes = await fetch(`${server.url}/api/voiceprints/${encodeURIComponent(profileId)}`, {
      method: "DELETE",
    });
    expect(delRes.status).toBe(200);
    const listRes = await fetch(`${server.url}/api/voiceprints`);
    const listJson = (await listRes.json()) as any;
    expect(listJson.profiles.length).toBe(0);
  });
});
