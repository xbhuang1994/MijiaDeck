// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 100 条带标注音频 5 方案 + 融合方案统一严格评测器

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { decodeWavPcm, resampleLinear } from "../../src/agent/audioPcm.ts";
import type {
  ClipManifestEntry,
  ScenarioCategory,
  SoundTypeLabel,
} from "./generate_dataset.ts";

export interface SeparatedStreamSummary {
  streamId: string;
  kind: "speech" | "song_vocals" | "bgm_accompaniment" | "noise" | "speaker";
  speakerId?: string;
  startSec?: number;
  endSec?: number;
  energyRatio?: number;
  transcript?: string;
}

export interface SolutionRunInput {
  clip: ClipManifestEntry;
  pcm16k: Float32Array;
  sampleRate: number;
  wakeWords: readonly string[];
  ownerRefPath: string;
  familyRefPath: string;
}

export interface SolutionRunOutput {
  isNeoCommand: boolean;
  wokeOnly: boolean;
  command: string;
  rawTranscript: string;
  detectedSoundTypes: SoundTypeLabel[];
  detectedSpeakerCount: number;
  separatedStreams: SeparatedStreamSummary[];
  attentionStage: string;
  attentionReason: string;
  latencyMs: number;
  stageTimingsMs?: Record<string, number>;
}

export interface VoiceSolution {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  init?(): Promise<void> | void;
  process(input: SolutionRunInput): Promise<SolutionRunOutput>;
  dispose?(): Promise<void> | void;
}

export interface ClipEvaluationRecord {
  id: string;
  category: ScenarioCategory;
  expectedIsNeo: boolean;
  predictedIsNeo: boolean;
  routingCorrect: boolean;
  commandCorrect: boolean;
  strictCorrect: boolean;
  expectedCommand: string;
  predictedCommand: string;
  rawTranscript: string;
  expectedSoundTypes: SoundTypeLabel[];
  predictedSoundTypes: SoundTypeLabel[];
  expectedSpeakerCount: number;
  predictedSpeakerCount: number;
  attentionStage: string;
  attentionReason: string;
  latencyMs: number;
  durationSec: number;
  failureType: "none" | "false_positive" | "false_negative" | "command_mismatch";
}

export interface SoundTypeMetric {
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
  f1: number;
}

export interface SolutionBenchmarkSummary {
  solutionId: string;
  solutionName: string;
  description: string;
  totalClips: number;
  strictCorrect: number;
  strictAccuracyPct: number;
  passed95Bar: boolean;
  routingCorrect: number;
  routingAccuracyPct: number;
  tp: number;
  tn: number;
  fp: number;
  fn: number;
  commandMismatchOnTp: number;
  precisionPct: number;
  recallPct: number;
  f1Pct: number;
  fprPct: number;
  fnrPct: number;
  positiveCommandAccuracyPct: number;
  soundTypeMacroF1Pct: number;
  soundTypeMetrics: Record<SoundTypeLabel, SoundTypeMetric>;
  categoryBreakdown: Record<
    ScenarioCategory,
    {
      total: number;
      strictCorrect: number;
      strictAccuracyPct: number;
      routingCorrect: number;
      fp: number;
      fn: number;
      cmdMismatch: number;
      meanLatencyMs: number;
    }
  >;
  latency: {
    meanMs: number;
    p50Ms: number;
    p95Ms: number;
    maxMs: number;
    totalSec: number;
    totalAudioSec: number;
    rtf: number;
  };
  failures: ClipEvaluationRecord[];
  records: ClipEvaluationRecord[];
}

export interface DatasetManifest {
  version: number;
  generatedAt: string;
  totalClips: number;
  neoCommandCount: number;
  nonNeoCount: number;
  ownerRefWav: string;
  familyRefWav: string;
  clips: ClipManifestEntry[];
}

export const ALL_SOUND_TYPES: readonly SoundTypeLabel[] = [
  "speech",
  "song",
  "bgm",
  "noise",
  "multi_speaker",
];

export const ALL_CATEGORIES: readonly ScenarioCategory[] = [
  "clean_no_bgm",
  "song_singing",
  "instrumental_bgm",
  "ambient_noise",
  "multi_speaker",
  "conversation_scenes",
];

export function normalizeCommandForEval(raw: string): string {
  let s = raw
    .toLowerCase()
    .replace(/[\s,，。．.、!！?？:：;；\-—~～"'“”‘’()（）[\]【】]+/g, "")
    .trim();
  const numMap: Array<[RegExp, string]> = [
    [/八十/g, "80"],
    [/五十/g, "50"],
    [/三十五/g, "35"],
    [/三十/g, "30"],
    [/二十六/g, "26"],
    [/二十五/g, "25"],
    [/二十四/g, "24"],
    [/二十/g, "20"],
    [/两/g, "2"],
    [/二/g, "2"],
  ];
  for (const [re, rep] of numMap) {
    s = s.replace(re, rep);
  }
  return s;
}

export function evaluateCommandMatch(
  clip: ClipManifestEntry,
  out: SolutionRunOutput,
): boolean {
  if (!clip.isNeoCommand) {
    return !out.isNeoCommand;
  }
  if (!out.isNeoCommand) return false;

  if (clip.expectedWokeOnly) {
    return out.wokeOnly === true && out.command.trim().length === 0;
  }

  if (out.wokeOnly) return false;
  const normPred = normalizeCommandForEval(out.command);
  if (!normPred) return false;

  // Reject unseparated garbage/lyrics/bystander leakage (> 2.8x expected length)
  const normExp = normalizeCommandForEval(clip.expectedCommand);
  const maxAllowedLen = Math.max(24, Math.round(normExp.length * 2.8));
  if (normPred.length > maxAllowedLen) {
    return false;
  }

  for (const kwGroup of clip.expectedCommandKeywords) {
    const matchedGroup = kwGroup.some((kw) => normPred.includes(normalizeCommandForEval(kw)));
    if (!matchedGroup) {
      return false;
    }
  }
  return true;
}

export function loadDataset(datasetDir: string): {
  manifest: DatasetManifest;
  audioByClipId: Map<string, Float32Array>;
  ownerRefPath: string;
  familyRefPath: string;
} {
  const manifestPath = path.join(datasetDir, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as DatasetManifest;
  const audioByClipId = new Map<string, Float32Array>();
  for (const clip of manifest.clips) {
    const wavPath = path.join(datasetDir, clip.filename);
    const decoded = decodeWavPcm(readFileSync(wavPath));
    const pcm16k =
      decoded.sampleRate === 16000
        ? decoded.samples
        : resampleLinear(decoded.samples, decoded.sampleRate, 16000);
    audioByClipId.set(clip.id, pcm16k);
  }
  return {
    manifest,
    audioByClipId,
    ownerRefPath: path.join(datasetDir, manifest.ownerRefWav),
    familyRefPath: path.join(datasetDir, manifest.familyRefWav),
  };
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[idx]!;
}

export async function benchmarkSolution(
  solution: VoiceSolution,
  dataset: ReturnType<typeof loadDataset>,
  options: { wakeWords?: readonly string[]; verbose?: boolean } = {},
): Promise<SolutionBenchmarkSummary> {
  const wakeWords = options.wakeWords ?? ["Neo"];
  if (solution.init) {
    await solution.init();
  }

  const records: ClipEvaluationRecord[] = [];
  let totalAudioSec = 0;

  for (const clip of dataset.manifest.clips) {
    const pcm16k = dataset.audioByClipId.get(clip.id)!;
    totalAudioSec += clip.durationSec;

    const t0 = performance.now();
    const out = await solution.process({
      clip,
      pcm16k,
      sampleRate: 16000,
      wakeWords,
      ownerRefPath: dataset.ownerRefPath,
      familyRefPath: dataset.familyRefPath,
    });
    const measuredMs = Math.max(1, Math.round(out.latencyMs || performance.now() - t0));

    const routingCorrect = out.isNeoCommand === clip.isNeoCommand;
    const commandCorrect = evaluateCommandMatch(clip, out);
    const strictCorrect = clip.isNeoCommand ? routingCorrect && commandCorrect : routingCorrect;

    let failureType: ClipEvaluationRecord["failureType"] = "none";
    if (!strictCorrect) {
      if (!clip.isNeoCommand && out.isNeoCommand) {
        failureType = "false_positive";
      } else if (clip.isNeoCommand && !out.isNeoCommand) {
        failureType = "false_negative";
      } else {
        failureType = "command_mismatch";
      }
    }

    records.push({
      id: clip.id,
      category: clip.category,
      expectedIsNeo: clip.isNeoCommand,
      predictedIsNeo: out.isNeoCommand,
      routingCorrect,
      commandCorrect,
      strictCorrect,
      expectedCommand: clip.expectedWokeOnly ? "<WOKE_ONLY>" : clip.expectedCommand,
      predictedCommand: out.wokeOnly ? "<WOKE_ONLY>" : out.command,
      rawTranscript: out.rawTranscript,
      expectedSoundTypes: clip.soundTypes,
      predictedSoundTypes: [...new Set(out.detectedSoundTypes)],
      expectedSpeakerCount: clip.speakerCount,
      predictedSpeakerCount: out.detectedSpeakerCount,
      attentionStage: out.attentionStage,
      attentionReason: out.attentionReason,
      latencyMs: measuredMs,
      durationSec: clip.durationSec,
      failureType,
    });

    if (options.verbose && !strictCorrect) {
      console.log(
        `  [FAIL ${solution.id}] ${clip.id} (${clip.category}) ${failureType}: exp=${clip.isNeoCommand ? clip.expectedCommand || "<WOKE>" : "REJECT"} | got=${out.isNeoCommand ? out.command || "<WOKE>" : "REJECT"} | raw="${out.rawTranscript}" | stage=${out.attentionStage}`,
      );
    }
  }

  if (solution.dispose) {
    await solution.dispose();
  }

  // Aggregate metrics
  let tp = 0;
  let tn = 0;
  let fp = 0;
  let fn = 0;
  let commandMismatchOnTp = 0;
  let strictCorrect = 0;
  let routingCorrect = 0;
  let posCmdOk = 0;
  let posTotal = 0;

  for (const r of records) {
    if (r.strictCorrect) strictCorrect += 1;
    if (r.routingCorrect) routingCorrect += 1;
    if (r.expectedIsNeo) {
      posTotal += 1;
      if (r.predictedIsNeo) {
        tp += 1;
        if (r.commandCorrect) {
          posCmdOk += 1;
        } else {
          commandMismatchOnTp += 1;
        }
      } else {
        fn += 1;
      }
    } else {
      if (r.predictedIsNeo) {
        fp += 1;
      } else {
        tn += 1;
      }
    }
  }

  // Sound-type F1
  const soundTypeMetrics = {} as Record<SoundTypeLabel, SoundTypeMetric>;
  let f1Sum = 0;
  for (const st of ALL_SOUND_TYPES) {
    let stTp = 0;
    let stFp = 0;
    let stFn = 0;
    for (const r of records) {
      const hasExp = r.expectedSoundTypes.includes(st);
      const hasPred = r.predictedSoundTypes.includes(st);
      if (hasExp && hasPred) stTp += 1;
      else if (!hasExp && hasPred) stFp += 1;
      else if (hasExp && !hasPred) stFn += 1;
    }
    const prec = stTp + stFp > 0 ? stTp / (stTp + stFp) : 1;
    const rec = stTp + stFn > 0 ? stTp / (stTp + stFn) : 1;
    const f1 = prec + rec > 0 ? (2 * prec * rec) / (prec + rec) : 0;
    soundTypeMetrics[st] = {
      tp: stTp,
      fp: stFp,
      fn: stFn,
      precision: Number((prec * 100).toFixed(1)),
      recall: Number((rec * 100).toFixed(1)),
      f1: Number((f1 * 100).toFixed(1)),
    };
    f1Sum += f1;
  }

  // Category breakdown
  const categoryBreakdown = {} as SolutionBenchmarkSummary["categoryBreakdown"];
  for (const cat of ALL_CATEGORIES) {
    const items = records.filter((r) => r.category === cat);
    const sc = items.filter((r) => r.strictCorrect).length;
    const rc = items.filter((r) => r.routingCorrect).length;
    const cFp = items.filter((r) => r.failureType === "false_positive").length;
    const cFn = items.filter((r) => r.failureType === "false_negative").length;
    const cMm = items.filter((r) => r.failureType === "command_mismatch").length;
    const meanLat =
      items.length > 0 ? items.reduce((acc, r) => acc + r.latencyMs, 0) / items.length : 0;
    categoryBreakdown[cat] = {
      total: items.length,
      strictCorrect: sc,
      strictAccuracyPct: items.length > 0 ? Number(((sc / items.length) * 100).toFixed(1)) : 0,
      routingCorrect: rc,
      fp: cFp,
      fn: cFn,
      cmdMismatch: cMm,
      meanLatencyMs: Math.round(meanLat),
    };
  }

  const latencies = records.map((r) => r.latencyMs).sort((a, b) => a - b);
  const totalMs = latencies.reduce((a, b) => a + b, 0);
  const precision = tp + fp > 0 ? tp / (tp + fp) : 1;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 1;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  const strictAccuracyPct = Number(((strictCorrect / records.length) * 100).toFixed(2));

  return {
    solutionId: solution.id,
    solutionName: solution.name,
    description: solution.description,
    totalClips: records.length,
    strictCorrect,
    strictAccuracyPct,
    passed95Bar: strictAccuracyPct >= 95.0,
    routingCorrect,
    routingAccuracyPct: Number(((routingCorrect / records.length) * 100).toFixed(2)),
    tp,
    tn,
    fp,
    fn,
    commandMismatchOnTp,
    precisionPct: Number((precision * 100).toFixed(2)),
    recallPct: Number((recall * 100).toFixed(2)),
    f1Pct: Number((f1 * 100).toFixed(2)),
    fprPct: Number(((fp / Math.max(1, tn + fp)) * 100).toFixed(2)),
    fnrPct: Number(((fn / Math.max(1, tp + fn)) * 100).toFixed(2)),
    positiveCommandAccuracyPct: Number(((posCmdOk / Math.max(1, posTotal)) * 100).toFixed(2)),
    soundTypeMacroF1Pct: Number(((f1Sum / ALL_SOUND_TYPES.length) * 100).toFixed(2)),
    soundTypeMetrics,
    categoryBreakdown,
    latency: {
      meanMs: Math.round(totalMs / Math.max(1, records.length)),
      p50Ms: Math.round(percentile(latencies, 0.5)),
      p95Ms: Math.round(percentile(latencies, 0.95)),
      maxMs: Math.round(latencies[latencies.length - 1] ?? 0),
      totalSec: Number((totalMs / 1000).toFixed(2)),
      totalAudioSec: Number(totalAudioSec.toFixed(2)),
      rtf: Number((totalMs / 1000 / Math.max(0.001, totalAudioSec)).toFixed(3)),
    },
    failures: records.filter((r) => !r.strictCorrect),
    records,
  };
}

export function saveBenchmarkSummary(outPath: string, summary: SolutionBenchmarkSummary): void {
  writeFileSync(outPath, JSON.stringify(summary, null, 2), "utf8");
}

export function printSummaryTable(summaries: readonly SolutionBenchmarkSummary[]): void {
  console.log("\n=========================================================================================================");
  console.log("  SOLUTION                 | STRICT ACC | ROUTE ACC |  FP |  FN | CMD_ERR | SOUND F1 | MEAN ms | P95 ms | RTF  | >=95%");
  console.log("---------------------------------------------------------------------------------------------------------");
  for (const s of summaries) {
    console.log(
      `  ${s.solutionId.padEnd(24)} | ${String(s.strictAccuracyPct.toFixed(1) + "%").padStart(10)} | ${String(s.routingAccuracyPct.toFixed(1) + "%").padStart(9)} | ${String(s.fp).padStart(3)} | ${String(s.fn).padStart(3)} | ${String(s.commandMismatchOnTp).padStart(7)} | ${String(s.soundTypeMacroF1Pct.toFixed(1) + "%").padStart(8)} | ${String(s.latency.meanMs).padStart(7)} | ${String(s.latency.p95Ms).padStart(6)} | ${s.latency.rtf.toFixed(2).padStart(4)} | ${s.passed95Bar ? "PASS" : "FAIL"}`,
    );
  }
  console.log("=========================================================================================================\n");
}
