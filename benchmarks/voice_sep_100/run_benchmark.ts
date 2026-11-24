// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 运行指定方案（baseline / s1..s5 / fused / all）在 100 条带标注音频上的评测

import { mkdirSync } from "node:fs";
import path from "node:path";
import {
  benchmarkSolution,
  loadDataset,
  printSummaryTable,
  saveBenchmarkSummary,
  type SolutionBenchmarkSummary,
  type VoiceSolution,
} from "./evaluator.ts";
import { SharedVoiceModelPool } from "./shared_models.ts";
import { createBaselineSolution } from "./solutions/baseline.ts";

const DATASET_DIR = path.resolve(import.meta.dir);
const RESULTS_DIR = path.join(DATASET_DIR, "results");

async function main() {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const args = process.argv.slice(2);
  const targets = args.length > 0 ? args : ["baseline"];
  const verbose = true;

  console.log(`[Bench] Loading 100 labeled WAV clips from ${DATASET_DIR}...`);
  const dataset = loadDataset(DATASET_DIR);
  console.log(
    `[Bench] Loaded ${dataset.manifest.totalClips} clips (${dataset.manifest.neoCommandCount} Neo / ${dataset.manifest.nonNeoCount} Non-Neo).`,
  );

  const pool = new SharedVoiceModelPool();
  await pool.warmupCore(["Neo"]);

  const factories: Record<string, () => Promise<VoiceSolution>> = {
    baseline: async () => createBaselineSolution(pool),
    s1: async () => (await import("./solutions/s1_ced_adaptive_router.ts")).createSolutionS1(pool),
    s2: async () => (await import("./solutions/s2_music_separation_first.ts")).createSolutionS2(pool),
    s3: async () => (await import("./solutions/s3_speaker_diarization_first.ts")).createSolutionS3(pool),
    s4: async () => (await import("./solutions/s4_voxlock_tse_parallel.ts")).createSolutionS4(pool),
    s5: async () => (await import("./solutions/s5_multistream_harmonic_verifier.ts")).createSolutionS5(pool),
    fused: async () => (await import("./solutions/s_fused_hybrid.ts")).createFusedSolution(pool),
    prod: async () => ({
      id: "prod_audio_source_separator",
      name: "Production src/agent/audioSourceSeparator.ts (Final Shipped S_Fused)",
      description: "生产落地版 AudioSourceSeparator.separateAndRecognize (src/agent/audioSourceSeparator.ts) 100条全量验收。",
      init: () => {
        pool.localEngine.sourceSeparator.warmup();
      },
      process: async (input) => {
        const now = 1_764_000_000_000;
        const res = await pool.localEngine.sourceSeparator.separateAndRecognize(input.pcm16k, input.sampleRate, {
          mode: "auto",
          voiceLang: "zh-CN",
          wakeWordEnabled: true,
          wakeWords: input.wakeWords,
          attentionMode: "smart",
          dialogState: input.clip.dialogState,
          inConversation: input.clip.dialogState === "conversation",
          recentTurns: input.clip.recentHistory.map((h, idx) => ({
            role: h.role,
            text: h.text,
            timestamp: now - (input.clip.recentHistory.length - idx) * 2000,
          })),
          lastSpokenReply: input.clip.lastSpokenReply,
          lastSpokenAt: input.clip.lastSpokenReply ? now - 1200 : undefined,
          now,
          speakerRefWavPaths: [
            { id: "owner", wavPath: input.ownerRefPath },
            { id: "family", wavPath: input.familyRefPath },
          ],
        });
        return {
          isNeoCommand: res.attention.accept,
          wokeOnly: res.attention.wokeOnly,
          command: res.attention.command,
          rawTranscript: res.text,
          detectedSoundTypes: res.detectedSoundTypes,
          detectedSpeakerCount: res.detectedSpeakerCount,
          separatedStreams: res.separatedStreams,
          attentionStage: res.attention.stage,
          attentionReason: res.attention.reason,
          latencyMs: res.totalMs,
          stageTimingsMs: res.stageTimingsMs,
        };
      },
    }),
  };

  const runList = targets.includes("all")
    ? ["baseline", "s1", "s2", "s3", "s4", "s5", "fused"]
    : targets;

  const summaries: SolutionBenchmarkSummary[] = [];
  for (const key of runList) {
    const fn = factories[key];
    if (!fn) {
      console.error(`Unknown solution key: ${key}`);
      continue;
    }
    const sol = await fn();
    console.log(`\n[Bench] Running ${sol.id} — ${sol.name}...`);
    const summary = await benchmarkSolution(sol, dataset, { wakeWords: ["Neo"], verbose });
    saveBenchmarkSummary(path.join(RESULTS_DIR, `${sol.id}.json`), summary);
    summaries.push(summary);

    console.log(`  Strict Acc: ${summary.strictAccuracyPct}% (${summary.strictCorrect}/100) | Routing: ${summary.routingAccuracyPct}% | FP=${summary.fp} FN=${summary.fn} CmdErr=${summary.commandMismatchOnTp} | SoundF1=${summary.soundTypeMacroF1Pct}% | Mean=${summary.latency.meanMs}ms P95=${summary.latency.p95Ms}ms RTF=${summary.latency.rtf}`);
    for (const [cat, stats] of Object.entries(summary.categoryBreakdown)) {
      console.log(
        `    - ${cat.padEnd(20)}: ${stats.strictCorrect}/${stats.total} (${stats.strictAccuracyPct}%) [FP=${stats.fp} FN=${stats.fn} CmdErr=${stats.cmdMismatch} avg=${stats.meanLatencyMs}ms]`,
      );
    }
  }

  printSummaryTable(summaries);
  pool.dispose();
}

main().catch((err) => {
  console.error("[Bench] Failed:", err);
  process.exit(1);
});
