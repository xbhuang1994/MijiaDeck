// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * 本地声纹注册与匹配持久化（voiceprints.json）。
 * 仅在本地保存 L2 归一化说话人嵌入向量，绝不上传至任何外部服务。
 */

import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { dataFile, readJson, writeJson } from "../core/jsonStore.ts";
import { cosineSimilarity, encodeWavPcm16, l2Normalize } from "./audioPcm.ts";

const FILENAME = "voiceprints.json";
const MAX_SAMPLES_PER_SPEAKER = 8;

export type VoiceprintRole = "owner" | "member";

export interface VoiceprintProfileRecord {
  id: string;
  name: string;
  role: VoiceprintRole;
  engine: string;
  dim: number;
  centroid: number[];
  samples: number[][];
  sampleCount: number;
  refWavFilename?: string;
  createdAt: number;
  updatedAt: number;
}

export interface PublicVoiceprintProfile {
  id: string;
  name: string;
  role: VoiceprintRole;
  engine: string;
  dim: number;
  sampleCount: number;
  hasRefAudio?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface VoiceprintMatchCandidate {
  id: string;
  name: string;
  role: VoiceprintRole;
  score: number;
}

export interface VoiceprintIdentifyResult {
  evaluated: boolean;
  matched: boolean;
  speakerId: string | null;
  speakerName: string | null;
  role: VoiceprintRole | null;
  score: number;
  threshold: number;
  engine: string;
  enrolledCount: number;
  candidates: VoiceprintMatchCandidate[];
}

interface VoiceprintFileSchema {
  version: number;
  profiles: VoiceprintProfileRecord[];
}

function emptyStore(): VoiceprintFileSchema {
  return { version: 1, profiles: [] };
}

function normalizeStore(raw: unknown): VoiceprintFileSchema {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return emptyStore();
  }
  const obj = raw as { profiles?: unknown };
  if (!Array.isArray(obj.profiles)) {
    return emptyStore();
  }
  const profiles: VoiceprintProfileRecord[] = [];
  for (const item of obj.profiles) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const id = typeof rec.id === "string" ? rec.id.trim() : "";
    const name = typeof rec.name === "string" ? rec.name.trim() : "";
    const engine = typeof rec.engine === "string" ? rec.engine.trim() : "";
    const centroid = Array.isArray(rec.centroid)
      ? rec.centroid.map((v) => Number(v)).filter((v) => Number.isFinite(v))
      : [];
    if (!id || !name || !engine || centroid.length === 0) continue;

    const samplesRaw = Array.isArray(rec.samples) ? rec.samples : [centroid];
    const samples: number[][] = [];
    for (const s of samplesRaw) {
      if (!Array.isArray(s) || s.length !== centroid.length) continue;
      samples.push(l2Normalize(s.map((v) => Number(v) || 0)));
    }
    const safeSamples = samples.length > 0 ? samples.slice(-MAX_SAMPLES_PER_SPEAKER) : [l2Normalize(centroid)];
    const role: VoiceprintRole = rec.role === "member" ? "member" : "owner";
    const now = Date.now();
    profiles.push({
      id,
      name,
      role,
      engine,
      dim: centroid.length,
      centroid: computeCentroid(safeSamples),
      samples: safeSamples,
      sampleCount: safeSamples.length,
      ...(typeof rec.refWavFilename === "string" && rec.refWavFilename.trim()
        ? { refWavFilename: rec.refWavFilename.trim() }
        : {}),
      createdAt: typeof rec.createdAt === "number" ? rec.createdAt : now,
      updatedAt: typeof rec.updatedAt === "number" ? rec.updatedAt : now,
    });
  }
  return { version: 1, profiles };
}

function computeCentroid(samples: readonly number[][]): number[] {
  const dim = samples[0]?.length ?? 0;
  if (dim === 0) return [];
  const sum = new Float64Array(dim);
  for (const s of samples) {
    for (let i = 0; i < dim; i += 1) {
      sum[i] = sum[i]! + (s[i] ?? 0);
    }
  }
  return l2Normalize(sum);
}

function makeProfileId(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return `vp_${slug || "speaker"}_${Date.now().toString(36)}`;
}

export function toPublicVoiceprint(profile: VoiceprintProfileRecord): PublicVoiceprintProfile {
  const hasRefAudio = Boolean(
    profile.refWavFilename && existsSync(dataFile(profile.refWavFilename)),
  );
  return {
    id: profile.id,
    name: profile.name,
    role: profile.role,
    engine: profile.engine,
    dim: profile.dim,
    sampleCount: profile.sampleCount,
    hasRefAudio,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}

/**
 * 返回主人的本地参考语音 WAV 路径（用于 VoxLock 目标说话人声纹锁定人声提取）。
 */
export function getPrimaryOwnerRefWavPath(): string | null {
  const profiles = loadVoiceprints();
  const preferred =
    profiles.find((p) => p.role === "owner" && p.refWavFilename && existsSync(dataFile(p.refWavFilename))) ??
    profiles.find((p) => p.refWavFilename && existsSync(dataFile(p.refWavFilename)));
  if (!preferred?.refWavFilename) return null;
  return dataFile(preferred.refWavFilename);
}

/**
 * 返回全部已保存参考语音 WAV 的声纹档案（主人优先），供自适应多说话人 VoxLock TSE 声源分离使用。
 */
export function listVoiceprintRefWavPaths(): Array<{
  id: string;
  name: string;
  role: VoiceprintRole;
  wavPath: string;
}> {
  const profiles = loadVoiceprints();
  const sorted = [...profiles].sort((a, b) => (a.role === "owner" ? -1 : b.role === "owner" ? 1 : 0));
  const out: Array<{ id: string; name: string; role: VoiceprintRole; wavPath: string }> = [];
  for (const p of sorted) {
    if (!p.refWavFilename) continue;
    const wavPath = dataFile(p.refWavFilename);
    if (existsSync(wavPath)) {
      out.push({ id: p.id, name: p.name, role: p.role, wavPath });
    }
  }
  return out;
}

export function loadVoiceprints(): VoiceprintProfileRecord[] {
  const raw = readJson<Record<string, unknown>>(
    dataFile(FILENAME),
    emptyStore() as unknown as Record<string, unknown>,
  );
  return normalizeStore(raw).profiles;
}

function saveVoiceprints(profiles: VoiceprintProfileRecord[]): void {
  const payload: VoiceprintFileSchema = {
    version: 1,
    profiles,
  };
  writeJson(dataFile(FILENAME), payload as unknown as Record<string, unknown>);
}

export function listPublicVoiceprints(): PublicVoiceprintProfile[] {
  return loadVoiceprints().map(toPublicVoiceprint);
}

/**
 * 注册或追加采样到同名说话人声纹档案（自动 L2 归一化与多样本质心融合）。
 */
export function enrollVoiceprint(options: {
  name: string;
  embedding: ArrayLike<number>;
  engine: string;
  role?: VoiceprintRole;
  refAudioSamples16k?: Float32Array;
}): PublicVoiceprintProfile {
  const name = options.name.trim().slice(0, 32);
  if (!name) {
    throw new Error("请输入说话人名称（如“主人”或姓名）");
  }
  const vec = l2Normalize(options.embedding);
  if (vec.length === 0) {
    throw new Error("提取到的声纹特征向量为空，请靠近麦克风清晰朗读 2~4 秒后重试");
  }

  const saveRefWav = (profileId: string, pcm?: Float32Array): string | undefined => {
    if (!pcm || pcm.length < 16000) return undefined;
    try {
      const safeId = profileId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48);
      const filename = `voiceprint_ref_${safeId}.wav`;
      const wavBytes = encodeWavPcm16(pcm.slice(0, 16000 * 10), 16000);
      writeFileSync(dataFile(filename), wavBytes);
      return filename;
    } catch {
      return undefined;
    }
  };

  const profiles = loadVoiceprints();
  const now = Date.now();
  const existing = profiles.find(
    (p) => p.name.toLowerCase() === name.toLowerCase() && p.engine === options.engine && p.dim === vec.length,
  );

  if (existing) {
    existing.samples = [...existing.samples, vec].slice(-MAX_SAMPLES_PER_SPEAKER);
    existing.centroid = computeCentroid(existing.samples);
    existing.sampleCount = existing.samples.length;
    if (options.role) existing.role = options.role;
    const savedRef = saveRefWav(existing.id, options.refAudioSamples16k);
    if (savedRef) existing.refWavFilename = savedRef;
    existing.updatedAt = now;
    saveVoiceprints(profiles);
    return toPublicVoiceprint(existing);
  }

  // 若同名档案来自旧引擎/不同维度，用新引擎重新建立
  const filtered = profiles.filter((p) => p.name.toLowerCase() !== name.toLowerCase());
  const id = makeProfileId(name);
  const savedRef = saveRefWav(id, options.refAudioSamples16k);
  const record: VoiceprintProfileRecord = {
    id,
    name,
    role: options.role ?? (filtered.length === 0 ? "owner" : "member"),
    engine: options.engine,
    dim: vec.length,
    centroid: vec,
    samples: [vec],
    sampleCount: 1,
    ...(savedRef ? { refWavFilename: savedRef } : {}),
    createdAt: now,
    updatedAt: now,
  };
  filtered.push(record);
  saveVoiceprints(filtered);
  return toPublicVoiceprint(record);
}

export function deleteVoiceprint(id: string): boolean {
  const profiles = loadVoiceprints();
  const target = profiles.find((p) => p.id === id);
  const next = profiles.filter((p) => p.id !== id);
  if (next.length === profiles.length) {
    return false;
  }
  if (target?.refWavFilename) {
    try {
      const refPath = dataFile(target.refWavFilename);
      if (existsSync(refPath)) unlinkSync(refPath);
    } catch {
      // ignore
    }
  }
  saveVoiceprints(next);
  return true;
}

export function clearVoiceprints(): void {
  saveVoiceprints([]);
}

/**
 * 将当前音频提取的声纹向量与已注册说话人逐一比对（质心 + 最优单样本融合打分）。
 */
export function identifyVoiceprint(
  embedding: ArrayLike<number>,
  engine: string,
  threshold = 0.42,
): VoiceprintIdentifyResult {
  const allProfiles = loadVoiceprints();
  const vec = l2Normalize(embedding);
  const compatible = allProfiles.filter((p) => p.engine === engine && p.dim === vec.length);

  if (compatible.length === 0 || vec.length === 0) {
    return {
      evaluated: false,
      matched: false,
      speakerId: null,
      speakerName: null,
      role: null,
      score: 0,
      threshold,
      engine,
      enrolledCount: allProfiles.length,
      candidates: [],
    };
  }

  const candidates: VoiceprintMatchCandidate[] = compatible
    .map((p) => {
      const centroidScore = cosineSimilarity(vec, p.centroid);
      let maxSampleScore = centroidScore;
      for (const sample of p.samples) {
        const s = cosineSimilarity(vec, sample);
        if (s > maxSampleScore) maxSampleScore = s;
      }
      // 70% 质心稳定性 + 30% 最优样本兼容性，兼顾跨语调鲁棒性与区分度
      const blended = Number((centroidScore * 0.7 + maxSampleScore * 0.3).toFixed(4));
      return {
        id: p.id,
        name: p.name,
        role: p.role,
        score: blended,
      };
    })
    .sort((a, b) => b.score - a.score);

  const best = candidates[0]!;
  const matched = best.score >= threshold;
  return {
    evaluated: true,
    matched,
    speakerId: matched ? best.id : null,
    speakerName: matched ? best.name : null,
    role: matched ? best.role : null,
    score: best.score,
    threshold,
    engine,
    enrolledCount: compatible.length,
    candidates,
  };
}
