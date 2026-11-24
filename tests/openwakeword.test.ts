// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: openWakeWord 原生 ONNX 声学唤醒词核心与原型库测试

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { decodeWavPcm, resampleLinear } from "../src/agent/audioPcm.ts";
import {
  DEFAULT_HARD_NEGATIVES,
  OPEN_WAKEWORD_MODEL_URLS,
  OpenWakeWordEngine,
  bandedSubsequenceDtw,
  computePatienceForWakeWord,
  meanCenterNormalize,
  resolveOpenWakeWordModelPaths,
  scorePrototypeEndingAt,
  slidingAlignedCosine,
  type WakeWordAcousticHit,
} from "../src/agent/openWakeWordEngine.ts";
import {
  MAX_ENROLLED_PROTOTYPES_PER_WORD,
  MAX_TTS_PROTOTYPES_PER_WORD,
  WAKEWORD_EMBEDDING_DIM,
  addWakeWordPrototype,
  clearWakeWordPrototypes,
  deleteWakeWordPrototypeById,
  deleteWakeWordPrototypesForWord,
  getPrototypesForWords,
  listWakeWordPrototypeSummaries,
  loadWakeWordStore,
  replaceTtsPrototypesForWord,
  setStoreBackgroundStats,
} from "../src/agent/wakewordPrototypeStore.ts";
import { setDataPathOverrides } from "../src/core/jsonStore.ts";

let tmpDir = "";
const enginesToDispose: OpenWakeWordEngine[] = [];

function trackEngine(engine: OpenWakeWordEngine): OpenWakeWordEngine {
  enginesToDispose.push(engine);
  return engine;
}

function makeFakeEmbedding(seed: number, frames = 5): number[][] {
  let state = (seed * 2654435761 + 1013904223) >>> 0;
  const nextVal = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return Number((((state / 0xffffffff) * 2 - 1) * 10).toFixed(4));
  };
  const out: number[][] = [];
  for (let f = 0; f < frames; f += 1) {
    const vec = new Array<number>(WAKEWORD_EMBEDDING_DIM);
    for (let d = 0; d < WAKEWORD_EMBEDDING_DIM; d += 1) {
      vec[d] = nextVal();
    }
    out.push(vec);
  }
  return out;
}

function synthSpeechLikeClip(durationSec = 1.0, f0 = 190, formant = 780): Float32Array {
  const sr = 16000;
  const lead = Math.round(sr * 0.25);
  const body = Math.round(sr * durationSec);
  const trail = Math.round(sr * 0.25);
  const out = new Float32Array(lead + body + trail);
  for (let i = 0; i < body; i += 1) {
    const t = i / sr;
    const env = Math.sin((Math.PI * i) / body) * (0.65 + 0.35 * Math.sin(2 * Math.PI * 4.5 * t));
    out[lead + i] =
      0.5 *
      env *
      (0.5 * Math.sin(2 * Math.PI * f0 * t) +
        0.32 * Math.sin(2 * Math.PI * formant * t) +
        0.18 * Math.sin(2 * Math.PI * (formant * 1.85) * t));
  }
  return out;
}

function synthSapiTestClips(
  items: ReadonlyArray<{ key: string; text: string; voice: string; rate?: number }>,
): Record<string, Float32Array> | null {
  if (process.platform !== "win32") return null;
  const psScript = `
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$jobs = @(([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($env:OWW_TEST_CLIPS))) | ConvertFrom-Json)
$out = @{}
foreach ($j in $jobs) {
  try {
    $synth.SelectVoice($j.voice)
    $synth.Rate = [int]$j.rate
    $ms = New-Object System.IO.MemoryStream
    $synth.SetOutputToWaveStream($ms)
    $synth.Speak([string]$j.text)
    $synth.SetOutputToNull()
    $out[$j.key] = [System.Convert]::ToBase64String($ms.ToArray())
    $ms.Dispose()
  } catch {}
}
$synth.Dispose()
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$out | ConvertTo-Json -Compress
`;
  const proc = Bun.spawnSync(
    [
      "powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      psScript,
    ],
    {
      env: {
        ...process.env,
        OWW_TEST_CLIPS: Buffer.from(
          JSON.stringify(items.map((x) => ({ ...x, rate: x.rate ?? 0 }))),
          "utf8",
        ).toString("base64"),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (proc.exitCode !== 0) return null;
  const raw = proc.stdout.toString().trim();
  if (!raw) return null;
  const parsed = JSON.parse(raw) as Record<string, string>;
  const clips: Record<string, Float32Array> = {};
  for (const [k, b64] of Object.entries(parsed)) {
    const decoded = decodeWavPcm(Buffer.from(b64, "base64"));
    clips[k] =
      decoded.sampleRate === 16000
        ? decoded.samples
        : resampleLinear(decoded.samples, decoded.sampleRate, 16000);
  }
  return Object.keys(clips).length > 0 ? clips : null;
}

function prependSilence(pcm: Float32Array, silenceSec = 0.5): Float32Array {
  const pad = Math.round(16000 * silenceSec);
  const out = new Float32Array(pad + pcm.length);
  out.set(pcm, pad);
  return out;
}

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "mijiadeck-oww-test-"));
  setDataPathOverrides({
    dataDir: () => tmpDir,
    dataFile: (name) => path.join(tmpDir, name),
  });
});

afterEach(() => {
  while (enginesToDispose.length > 0) {
    const eng = enginesToDispose.pop();
    try {
      eng?.dispose();
    } catch {
      // ignore
    }
  }
  setDataPathOverrides(null);
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = "";
  }
});

describe("wakewordPrototypeStore", () => {
  test("CRUD, per-source caps, summaries, and background stats persist cleanly", () => {
    expect(loadWakeWordStore().prototypes).toHaveLength(0);

    // 写入 8 条 enrolled（应截断至上限 6）
    for (let i = 0; i < MAX_ENROLLED_PROTOTYPES_PER_WORD + 2; i += 1) {
      addWakeWordPrototype({
        wakeWord: "Neo",
        source: "enrolled",
        voiceTag: `user_${i}`,
        embeddings: makeFakeEmbedding(i, 4),
        createdAt: 1000 + i,
      });
    }
    // 写入 12 条 tts-bootstrap（应截断至上限 10，且不影响 enrolled）
    for (let i = 0; i < MAX_TTS_PROTOTYPES_PER_WORD + 2; i += 1) {
      addWakeWordPrototype({
        wakeWord: "neo",
        source: "tts-bootstrap",
        voiceTag: `tts_${i}`,
        embeddings: makeFakeEmbedding(100 + i, 5),
        createdAt: 2000 + i,
      });
    }

    const neoProtos = getPrototypesForWords(["NEO"]);
    const enrolled = neoProtos.filter((p) => p.source === "enrolled");
    const tts = neoProtos.filter((p) => p.source === "tts-bootstrap");
    expect(enrolled).toHaveLength(MAX_ENROLLED_PROTOTYPES_PER_WORD);
    expect(tts).toHaveLength(MAX_TTS_PROTOTYPES_PER_WORD);
    // 保留最新的记录
    expect(enrolled.some((p) => p.voiceTag === "user_7")).toBe(true);
    expect(enrolled.some((p) => p.voiceTag === "user_0")).toBe(false);
    expect(tts.some((p) => p.voiceTag === "tts_11")).toBe(true);
    expect(tts.some((p) => p.voiceTag === "tts_0")).toBe(false);

    // listWakeWordPrototypeSummaries 包含 0 样本配置词条
    const summaries = listWakeWordPrototypeSummaries(["Neo", "小派"]);
    expect(summaries).toHaveLength(2);
    expect(summaries[0]!.wakeWord).toBe("Neo");
    expect(summaries[0]!.enrolledCount).toBe(6);
    expect(summaries[0]!.ttsCount).toBe(10);
    expect(summaries[0]!.totalCount).toBe(16);
    expect(summaries[0]!.enrolledIds).toHaveLength(6);
    expect(summaries[0]!.sampleIds).toHaveLength(16);
    expect(summaries[0]!.updatedAt).toBe(2011);

    expect(summaries[1]!.wakeWord).toBe("小派");
    expect(summaries[1]!.totalCount).toBe(0);
    expect(summaries[1]!.updatedAt).toBeNull();

    // 删除单条
    const victimId = summaries[0]!.enrolledIds[0]!;
    expect(deleteWakeWordPrototypeById(victimId)).toBe(true);
    expect(deleteWakeWordPrototypeById(victimId)).toBe(false);
    expect(listWakeWordPrototypeSummaries(["Neo"])[0]!.enrolledCount).toBe(5);

    // 仅删除用户录制样本（保留 TTS 预热样本）
    const removedEnrolled = deleteWakeWordPrototypesForWord("Neo", { enrolledOnly: true });
    expect(removedEnrolled).toBe(5);
    const afterEnrolledDel = listWakeWordPrototypeSummaries(["Neo"])[0]!;
    expect(afterEnrolledDel.enrolledCount).toBe(0);
    expect(afterEnrolledDel.ttsCount).toBe(10);

    // 保存背景均值与硬负样本
    const fakeMean = makeFakeEmbedding(7, 1)[0]!;
    setStoreBackgroundStats(fakeMean, [
      { label: "no", embeddings: makeFakeEmbedding(11, 4) },
      { label: "小爱", embeddings: makeFakeEmbedding(12, 5) },
    ]);
    const reloaded = loadWakeWordStore();
    expect(reloaded.bgMean).toHaveLength(WAKEWORD_EMBEDDING_DIM);
    expect(reloaded.hardNegatives).toHaveLength(2);

    // 清空
    clearWakeWordPrototypes();
    expect(loadWakeWordStore().prototypes).toHaveLength(0);
    expect(loadWakeWordStore().bgMean).toHaveLength(0);
  });

  test("replaceTtsPrototypesForWord replaces ONLY tts-bootstrap and preserves enrolled samples", () => {
    const enrolledRec = addWakeWordPrototype({
      wakeWord: "小派",
      source: "enrolled",
      voiceTag: "owner-mic",
      embeddings: makeFakeEmbedding(1, 5),
      createdAt: 5000,
    });
    addWakeWordPrototype({
      wakeWord: "小派",
      source: "tts-bootstrap",
      voiceTag: "old-tts-1",
      embeddings: makeFakeEmbedding(2, 5),
      createdAt: 4000,
    });
    addWakeWordPrototype({
      wakeWord: "Neo",
      source: "tts-bootstrap",
      voiceTag: "neo-tts",
      embeddings: makeFakeEmbedding(3, 5),
      createdAt: 4500,
    });

    const replaced = replaceTtsPrototypesForWord("小派", [
      { voiceTag: "new-tts-a", embeddings: makeFakeEmbedding(10, 6) },
      { voiceTag: "new-tts-b", embeddings: makeFakeEmbedding(11, 6) },
    ]);
    expect(replaced).toHaveLength(2);

    const xpRecords = getPrototypesForWords(["小派"]);
    expect(xpRecords.filter((p) => p.source === "enrolled").map((p) => p.id)).toEqual([
      enrolledRec.id,
    ]);
    expect(xpRecords.filter((p) => p.source === "tts-bootstrap").map((p) => p.voiceTag)).toEqual([
      "new-tts-a",
      "new-tts-b",
    ]);
    // 其他唤醒词原样保留
    expect(getPrototypesForWords(["Neo"])).toHaveLength(1);
  });
});

describe("OpenWakeWordEngine graceful degradation & Stage 3 math", () => {
  test("degrades gracefully when models directory is empty", async () => {
    const emptyModelsDir = path.join(tmpDir, "empty_models");
    const engine = trackEngine(new OpenWakeWordEngine({ modelsDir: emptyModelsDir }));

    expect(engine.isReady).toBe(false);
    const status = engine.getStatus();
    expect(status.ready).toBe(false);
    expect(status.modelsPresent).toBe(false);
    expect(status.lastError).toBeTruthy();
    expect(OPEN_WAKEWORD_MODEL_URLS.mel).toContain("melspectrogram.onnx");
    expect(OPEN_WAKEWORD_MODEL_URLS.embedding).toContain("embedding_model.onnx");

    const clip = synthSpeechLikeClip(0.8);
    expect(engine.scoreClip(clip, ["Neo"])).toBeNull();

    const session = engine.createStreamSession(["Neo"]);
    expect(session.pushSamples(clip, clip.length)).toBeNull();
    expect(session.getPeakHit()).toBeNull();

    const boot = await engine.bootstrapWakeWords(["Neo", "小派"]);
    expect(boot.bootstrapped).toEqual([]);
    expect(boot.skipped).toEqual(["Neo", "小派"]);
  });

  test("patience and Stage 3 DTW stretch tolerance behave as expected", () => {
    expect(computePatienceForWakeWord("Neo")).toBe(2);
    expect(computePatienceForWakeWord("小派")).toBe(2);
    expect(computePatienceForWakeWord("小派同学")).toBe(3);
    expect(computePatienceForWakeWord("Hey Neo")).toBe(3);
    expect(computePatienceForWakeWord("Jarvis")).toBe(3);

    const bg = new Float32Array(WAKEWORD_EMBEDDING_DIM).fill(1);
    const baseProto = makeFakeEmbedding(42, 6).map((f) => meanCenterNormalize(f, bg));
    // 构造 1.33x 语速拉长序列（8 帧匹配 6 帧原型）
    const stretched: Float32Array[] = [
      baseProto[0]!,
      baseProto[0]!,
      baseProto[1]!,
      baseProto[2]!,
      baseProto[3]!,
      baseProto[4]!,
      baseProto[4]!,
      baseProto[5]!,
    ];
    const unrelated = makeFakeEmbedding(999, 8).map((f) => meanCenterNormalize(f, bg));

    const dtwMatch = bandedSubsequenceDtw(stretched, baseProto);
    const dtwMismatch = bandedSubsequenceDtw(unrelated, baseProto);
    expect(dtwMatch).toBeGreaterThan(0.92);
    expect(dtwMismatch).toBeLessThan(0.45);

    const exactCos = slidingAlignedCosine(baseProto, baseProto);
    expect(exactCos).toBeGreaterThan(0.999);
    expect(scorePrototypeEndingAt(baseProto, baseProto.length - 1, baseProto)).toBeGreaterThan(0.99);
    const stretchedBlended = scorePrototypeEndingAt(stretched, stretched.length - 1, baseProto);
    const unrelatedBlended = scorePrototypeEndingAt(unrelated, unrelated.length - 1, baseProto);
    expect(stretchedBlended).toBeGreaterThan(0.5);
    expect(unrelatedBlended).toBeLessThan(0.25);
    expect(stretchedBlended - unrelatedBlended).toBeGreaterThan(0.35);
  });

  test("excludes hard negatives matching an active wake word and degrades on invalid runtime lib", () => {
    setStoreBackgroundStats(makeFakeEmbedding(1, 1)[0]!, [
      { label: "小爱", embeddings: makeFakeEmbedding(2, 5) },
      { label: "no", embeddings: makeFakeEmbedding(3, 5) },
    ]);
    addWakeWordPrototype({
      wakeWord: "小爱",
      source: "enrolled",
      voiceTag: "user",
      embeddings: makeFakeEmbedding(4, 5),
    });

    const badRuntimeEngine = trackEngine(
      new OpenWakeWordEngine({
        runtimeLibPath: path.join(tmpDir, "missing_onnxruntime.dll"),
      }),
    );
    expect(badRuntimeEngine.isReady).toBe(false);
    expect(badRuntimeEngine.getStatus().runtimeLoaded).toBe(false);
    expect(badRuntimeEngine.lastError).toBeTruthy();

    // 当“小爱”本身作为激活唤醒词时，编译上下文应自动排除同名硬负样本“小爱”，同时保留“no”
    const ctx = badRuntimeEngine.compileScoringContext(["小爱"]);
    expect(ctx.hardNegatives.map((h) => h.label)).toEqual(["no"]);
  });
});

const realPaths = resolveOpenWakeWordModelPaths();
const hasRealModels = existsSync(realPaths.melPath) && existsSync(realPaths.embeddingPath);

describe.if(hasRealModels)("OpenWakeWordEngine real ONNX integration", () => {
  test("coexists with sherpa-onnx-node and produces non-degenerate int16 mel + 96-dim embeddings", () => {
    // 确认与 sherpa-onnx-node 同时加载零冲突
    const req = createRequire(import.meta.url);
    const sherpa = req("sherpa-onnx-node") as { version?: string };
    expect(sherpa).toBeTruthy();

    const engine = trackEngine(new OpenWakeWordEngine());
    expect(engine.isReady).toBe(true);
    const status = engine.getStatus();
    expect(status.ready).toBe(true);
    expect(status.modelsPresent).toBe(true);
    expect(status.runtimeLoaded).toBe(true);
    expect(status.lastError).toBeNull();

    // 校验 Stage 1 int16 标度梅尔频谱非退化（人声波形方差显著大于静音）
    const speech = synthSpeechLikeClip(0.8, 195, 820);
    const silence = new Float32Array(16000);
    const speechMel = engine.extractMelSpectrogram(speech);
    const silenceMel = engine.extractMelSpectrogram(silence);

    expect(speechMel.melBins).toBe(32);
    expect(speechMel.frameCount).toBeGreaterThan(0);

    const calcVariance = (arr: Float32Array): number => {
      let mean = 0;
      for (let i = 0; i < arr.length; i += 1) mean += arr[i]!;
      mean /= Math.max(1, arr.length);
      let v = 0;
      for (let i = 0; i < arr.length; i += 1) {
        const d = arr[i]! - mean;
        v += d * d;
      }
      return v / Math.max(1, arr.length);
    };

    const speechVar = calcVariance(speechMel.frames);
    const silenceVar = calcVariance(silenceMel.frames);
    expect(speechVar).toBeGreaterThan(2.0);
    expect(speechVar).toBeGreaterThan(silenceVar * 10 + 1.0);

    // 校验 Stage 2 96 维嵌入有效且非零非 NaN
    const { embeddings } = engine.extractEmbeddings(speech);
    expect(embeddings.length).toBeGreaterThan(5);
    expect(embeddings[0]!).toHaveLength(96);
    expect(embeddings[0]!.every((v) => Number.isFinite(v))).toBe(true);
    const norm = Math.sqrt(embeddings[Math.floor(embeddings.length / 2)]!.reduce((a, b) => a + b * b, 0));
    expect(norm).toBeGreaterThan(1.0);
  });

  test("bootstraps wake words, separates positives vs negatives, enrolls dual-phase samples, and spots in stream", async () => {
    const engine = trackEngine(new OpenWakeWordEngine());
    expect(engine.isReady).toBe(true);

    // 1. 零样本预热（Windows SAPI）
    const boot1 = await engine.bootstrapWakeWords(["Neo", "小派"]);
    if (process.platform === "win32" && boot1.bootstrapped.length > 0) {
      expect(boot1.bootstrapped).toEqual(["Neo", "小派"]);
      expect(boot1.skipped).toEqual([]);

      const store = loadWakeWordStore();
      expect(store.bgMean).toHaveLength(96);
      expect(store.hardNegatives.length).toBe(DEFAULT_HARD_NEGATIVES.length);

      // 幂等性验证：二次调用直接跳过
      const boot2 = await engine.bootstrapWakeWords(["Neo", "小派"]);
      expect(boot2.bootstrapped).toEqual([]);
      expect(boot2.skipped).toEqual(["Neo", "小派"]);

      // 2. 合成全新真实语音句做正负样本分离与流式低延迟检测
      const clips = synthSapiTestClips([
        { key: "neo_pos", text: "Neo, turn on the desk lamp", voice: "Microsoft David Desktop", rate: 1 },
        { key: "neo_pos_f", text: "Neo, dim the bedroom light", voice: "Microsoft Zira Desktop", rate: -1 },
        { key: "neo_neg", text: "No, stop that right now", voice: "Microsoft David Desktop", rate: 0 },
        { key: "xp_pos", text: "小派，打开客厅灯", voice: "Microsoft Huihui Desktop", rate: 1 },
        { key: "xp_neg", text: "今天天气真不错", voice: "Microsoft Huihui Desktop", rate: 0 },
        { key: "enroll_neo", text: "Neo", voice: "Microsoft Zira Desktop", rate: 0 },
      ]);

      if (clips?.neo_pos && clips.neo_neg && clips.xp_pos && clips.xp_neg) {
        const hitNeoPos = engine.scoreClip(clips.neo_pos, ["Neo", "小派"]);
        const hitNeoPosF = clips.neo_pos_f
          ? engine.scoreClip(clips.neo_pos_f, ["Neo", "小派"])
          : null;
        const hitNeoNeg = engine.scoreClip(clips.neo_neg, ["Neo", "小派"]);
        const hitXpPos = engine.scoreClip(clips.xp_pos, ["Neo", "小派"]);
        const hitXpNeg = engine.scoreClip(clips.xp_neg, ["Neo", "小派"]);

        expect(hitNeoPos).not.toBeNull();
        expect(hitNeoPos!.matched).toBe(true);
        expect(hitNeoPos!.wakeWord).toBe("Neo");
        expect(hitNeoPos!.score).toBeGreaterThan(0.75);

        if (hitNeoPosF) {
          expect(hitNeoPosF.matched).toBe(true);
          expect(hitNeoPosF.wakeWord).toBe("Neo");
        }

        expect(hitNeoNeg).not.toBeNull();
        expect(hitNeoNeg!.matched).toBe(false);
        expect(hitNeoPos!.score - hitNeoNeg!.score).toBeGreaterThan(0.12);

        expect(hitXpPos).not.toBeNull();
        expect(hitXpPos!.matched).toBe(true);
        expect(hitXpPos!.wakeWord).toBe("小派");
        expect(hitXpPos!.score).toBeGreaterThan(0.75);

        expect(hitXpNeg).not.toBeNull();
        expect(hitXpNeg!.matched).toBe(false);
        expect(hitXpPos!.score - hitXpNeg!.score).toBeGreaterThan(0.2);

        // 3. 测试双相位偏移自定义录制（0 / 640 采样）以及强制重预热保留用户样本
        if (clips.enroll_neo) {
          const enrolled = engine.enrollSample("Neo", clips.enroll_neo, { voiceTag: "test-user" });
          expect(enrolled.record.source).toBe("enrolled");
          expect(enrolled.record.frameCount).toBeGreaterThanOrEqual(3);
          expect(enrolled.record.frameCount).toBeLessThanOrEqual(10);
          expect(enrolled.summary.enrolledCount).toBeGreaterThanOrEqual(1);

          // 强制重新 bootstrap 绝不删除用户 enrolled 样本
          await engine.bootstrapWakeWords(["Neo"], { force: true });
          const afterForce = listWakeWordPrototypeSummaries(["Neo"])[0]!;
          expect(afterForce.enrolledCount).toBe(enrolled.summary.enrolledCount);
          expect(afterForce.ttsCount).toBeGreaterThan(0);
        }

        // 4. 流式 OpenWakeWordStreamSession 实测：静音快路径 + 正样本低延迟命中 + 负样本零误报
        const spotted: WakeWordAcousticHit[] = [];
        const stream = engine.createStreamSession(["Neo", "小派"], {
          debounceMs: 1500,
          onSpot: (hit) => spotted.push(hit),
        });

        // 先推送 1.6 秒纯静音验证 RMS 静音快路径跳帧
        const idleSilence = new Float32Array(16000 * 1.6);
        let sampleCursor = 0;
        const chunkSize = 2048; // 模拟浏览器 AudioWorklet 128ms 帧
        for (let i = 0; i < idleSilence.length; i += chunkSize) {
          const chunk = idleSilence.subarray(i, Math.min(idleSilence.length, i + chunkSize));
          sampleCursor += chunk.length;
          expect(stream.pushSamples(chunk, sampleCursor)).toBeNull();
        }
        expect(stream.idleSkippedFrames).toBeGreaterThan(0);

        // 重置分段追踪后推送 “Neo, turn on the desk lamp”
        stream.resetSegmentTracking();
        const neoStreamAudio = prependSilence(clips.neo_pos, 0.2);
        let neoSpot: WakeWordAcousticHit | null = null;
        for (let i = 0; i < neoStreamAudio.length; i += chunkSize) {
          const chunk = neoStreamAudio.subarray(i, Math.min(neoStreamAudio.length, i + chunkSize));
          sampleCursor += chunk.length;
          const hit = stream.pushSamples(chunk, sampleCursor);
          if (hit) neoSpot = hit;
        }
        expect(neoSpot).not.toBeNull();
        expect(neoSpot!.matched).toBe(true);
        expect(neoSpot!.wakeWord).toBe("Neo");
        expect(neoSpot!.latencyMs).toBeLessThan(80);
        expect(stream.getPeakHit()?.wakeWord).toBe("Neo");
        expect(stream.getHeadPeakHit(16)?.matched).toBe(true);

        // 推送 1.8 秒静音跨过防抖窗口，再推送 “小派，打开客厅灯”
        const gapSil = new Float32Array(Math.round(16000 * 1.8));
        for (let i = 0; i < gapSil.length; i += chunkSize) {
          const chunk = gapSil.subarray(i, Math.min(gapSil.length, i + chunkSize));
          sampleCursor += chunk.length;
          stream.pushSamples(chunk, sampleCursor);
        }
        stream.resetSegmentTracking();
        const xpStreamAudio = prependSilence(clips.xp_pos, 0.2);
        let xpSpot: WakeWordAcousticHit | null = null;
        for (let i = 0; i < xpStreamAudio.length; i += chunkSize) {
          const chunk = xpStreamAudio.subarray(i, Math.min(xpStreamAudio.length, i + chunkSize));
          sampleCursor += chunk.length;
          const hit = stream.pushSamples(chunk, sampleCursor);
          if (hit) xpSpot = hit;
        }
        expect(xpSpot).not.toBeNull();
        expect(xpSpot!.matched).toBe(true);
        expect(xpSpot!.wakeWord).toBe("小派");
        expect(xpSpot!.latencyMs).toBeLessThan(80);
        expect(spotted.map((h) => h.wakeWord)).toEqual(["Neo", "小派"]);

        // 负样本流（"No, stop..." 与 "今天天气真不错"）零误报
        stream.reset();
        let negCursor = 0;
        const negCombined = prependSilence(clips.neo_neg, 0.5);
        for (let i = 0; i < negCombined.length; i += chunkSize) {
          const chunk = negCombined.subarray(i, Math.min(negCombined.length, i + chunkSize));
          negCursor += chunk.length;
          expect(stream.pushSamples(chunk, negCursor)).toBeNull();
        }
        const negZh = prependSilence(clips.xp_neg, 0.5);
        for (let i = 0; i < negZh.length; i += chunkSize) {
          const chunk = negZh.subarray(i, Math.min(negZh.length, i + chunkSize));
          negCursor += chunk.length;
          expect(stream.pushSamples(chunk, negCursor)).toBeNull();
        }
      }
    }
  });
});
