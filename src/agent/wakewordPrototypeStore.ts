// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * 本地 openWakeWord 唤醒词声学原型持久化（wakeword_prototypes.json）。
 * 仅在本地保存 96 维原始 speech_embedding 序列（减去 bgMean 之前的原始向量，
 * 以确保 bgMean 背景均值更新后全部原型保持一致）、通用语音背景均值与硬负样本。
 */

import { dataFile, readJson, writeJson } from "../core/jsonStore.ts";

const FILENAME = "wakeword_prototypes.json";

export const WAKEWORD_EMBEDDING_DIM = 96;
export const MAX_ENROLLED_PROTOTYPES_PER_WORD = 6;
export const MAX_TTS_PROTOTYPES_PER_WORD = 10;

export type WakeWordPrototypeSource = "enrolled" | "tts-bootstrap";

export interface WakeWordPrototypeRecord {
  id: string;
  wakeWord: string;
  source: WakeWordPrototypeSource;
  voiceTag: string;
  frameCount: number;
  /** [frameCount][96] 原始 96 维 speech_embedding（减去 bgMean 之前） */
  embeddings: number[][];
  createdAt: number;
}

export interface WakeWordPrototypeSummary {
  wakeWord: string;
  enrolledCount: number;
  ttsCount: number;
  totalCount: number;
  sampleIds: string[];
  enrolledIds: string[];
  updatedAt: number | null;
}

export interface WakeWordHardNegativeRecord {
  label: string;
  embeddings: number[][];
}

export interface WakeWordPrototypeStoreData {
  version: number;
  embeddingDim: number;
  bgMean: number[];
  hardNegatives: WakeWordHardNegativeRecord[];
  prototypes: WakeWordPrototypeRecord[];
  updatedAt: number;
}

export interface AddWakeWordPrototypeInput {
  id?: string;
  wakeWord: string;
  source: WakeWordPrototypeSource;
  voiceTag: string;
  embeddings: readonly (readonly number[])[];
  createdAt?: number;
}

export interface ReplaceTtsPrototypeInput {
  id?: string;
  voiceTag: string;
  embeddings: readonly (readonly number[])[];
  createdAt?: number;
}

let idCounter = 0;

/**
 * 归一化唤醒词键名，用于跨大小写与首尾空白的稳定索引匹配。
 */
export function normalizeWakeWordKey(word: string): string {
  return word.trim().toLowerCase().replace(/\s+/g, " ");
}

function emptyStore(): WakeWordPrototypeStoreData {
  return {
    version: 1,
    embeddingDim: WAKEWORD_EMBEDDING_DIM,
    bgMean: [],
    hardNegatives: [],
    prototypes: [],
    updatedAt: 0,
  };
}

function sanitizeEmbeddingFrame(frame: unknown): number[] | null {
  if (!Array.isArray(frame) || frame.length !== WAKEWORD_EMBEDDING_DIM) {
    return null;
  }
  const out = new Array<number>(WAKEWORD_EMBEDDING_DIM);
  for (let i = 0; i < WAKEWORD_EMBEDDING_DIM; i += 1) {
    const v = Number(frame[i]);
    if (!Number.isFinite(v)) {
      return null;
    }
    out[i] = v;
  }
  return out;
}

function sanitizeEmbeddings(raw: unknown): number[][] {
  if (!Array.isArray(raw)) return [];
  const frames: number[][] = [];
  for (const frame of raw) {
    const clean = sanitizeEmbeddingFrame(frame);
    if (clean) frames.push(clean);
  }
  return frames;
}

function makePrototypeId(wakeWord: string, source: WakeWordPrototypeSource): string {
  idCounter = (idCounter + 1) % 0xffff;
  const slug = wakeWord
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 20);
  const prefix = source === "enrolled" ? "ww_enr" : "ww_tts";
  return `${prefix}_${slug || "word"}_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}

function normalizeStore(raw: unknown): WakeWordPrototypeStoreData {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return emptyStore();
  }
  const obj = raw as Record<string, unknown>;

  const bgMeanClean = sanitizeEmbeddingFrame(obj.bgMean) ?? [];

  const hardNegatives: WakeWordHardNegativeRecord[] = [];
  if (Array.isArray(obj.hardNegatives)) {
    for (const item of obj.hardNegatives) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const rec = item as Record<string, unknown>;
      const label = typeof rec.label === "string" ? rec.label.trim() : "";
      const embeddings = sanitizeEmbeddings(rec.embeddings);
      if (!label || embeddings.length === 0) continue;
      hardNegatives.push({ label, embeddings });
    }
  }

  const prototypes: WakeWordPrototypeRecord[] = [];
  if (Array.isArray(obj.prototypes)) {
    for (const item of obj.prototypes) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const rec = item as Record<string, unknown>;
      const id = typeof rec.id === "string" ? rec.id.trim() : "";
      const wakeWord = typeof rec.wakeWord === "string" ? rec.wakeWord.trim() : "";
      const source: WakeWordPrototypeSource =
        rec.source === "enrolled" ? "enrolled" : "tts-bootstrap";
      const voiceTag = typeof rec.voiceTag === "string" ? rec.voiceTag.trim() : "default";
      const embeddings = sanitizeEmbeddings(rec.embeddings);
      if (!id || !wakeWord || embeddings.length === 0) continue;
      prototypes.push({
        id,
        wakeWord,
        source,
        voiceTag: voiceTag || "default",
        frameCount: embeddings.length,
        embeddings,
        createdAt: typeof rec.createdAt === "number" && Number.isFinite(rec.createdAt)
          ? rec.createdAt
          : Date.now(),
      });
    }
  }

  return {
    version: 1,
    embeddingDim: WAKEWORD_EMBEDDING_DIM,
    bgMean: bgMeanClean,
    hardNegatives,
    prototypes,
    updatedAt:
      typeof obj.updatedAt === "number" && Number.isFinite(obj.updatedAt) ? obj.updatedAt : 0,
  };
}

function enforceWordSourceCap(
  prototypes: WakeWordPrototypeRecord[],
  wordKey: string,
  source: WakeWordPrototypeSource,
): WakeWordPrototypeRecord[] {
  const cap =
    source === "enrolled" ? MAX_ENROLLED_PROTOTYPES_PER_WORD : MAX_TTS_PROTOTYPES_PER_WORD;
  const matching = prototypes.filter(
    (p) => normalizeWakeWordKey(p.wakeWord) === wordKey && p.source === source,
  );
  if (matching.length <= cap) {
    return prototypes;
  }
  const keepSet = new Set(matching.slice(-cap).map((p) => p.id));
  return prototypes.filter(
    (p) =>
      normalizeWakeWordKey(p.wakeWord) !== wordKey || p.source !== source || keepSet.has(p.id),
  );
}

/**
 * 读取本地唤醒词原型库。文件缺失或损坏时安全返回空库。
 */
export function loadWakeWordStore(): WakeWordPrototypeStoreData {
  const raw = readJson<Record<string, unknown>>(
    dataFile(FILENAME),
    emptyStore() as unknown as Record<string, unknown>,
  );
  return normalizeStore(raw);
}

/**
 * 原子保存本地唤醒词原型库。
 */
export function saveWakeWordStore(store: WakeWordPrototypeStoreData): void {
  const normalized = normalizeStore({
    ...store,
    version: 1,
    embeddingDim: WAKEWORD_EMBEDDING_DIM,
    updatedAt: Date.now(),
  });
  writeJson(dataFile(FILENAME), normalized as unknown as Record<string, unknown>);
}

/**
 * 清空所有唤醒词声学原型、背景均值与硬负样本。
 */
export function clearWakeWordPrototypes(): void {
  saveWakeWordStore(emptyStore());
}

/**
 * 添加一条唤醒词声学原型（按词条与来源分别限额：用户录制 <= 6，TTS 预热 <= 10）。
 */
export function addWakeWordPrototype(input: AddWakeWordPrototypeInput): WakeWordPrototypeRecord {
  const wakeWord = input.wakeWord.trim();
  if (!wakeWord) {
    throw new Error("唤醒词不能为空");
  }
  const embeddings = sanitizeEmbeddings(input.embeddings);
  if (embeddings.length === 0) {
    throw new Error("提取到的唤醒词声学特征为空，请靠近麦克风清晰朗读后重试");
  }

  const store = loadWakeWordStore();
  const source: WakeWordPrototypeSource =
    input.source === "enrolled" ? "enrolled" : "tts-bootstrap";
  const record: WakeWordPrototypeRecord = {
    id: input.id?.trim() || makePrototypeId(wakeWord, source),
    wakeWord,
    source,
    voiceTag: input.voiceTag.trim() || "default",
    frameCount: embeddings.length,
    embeddings,
    createdAt:
      typeof input.createdAt === "number" && Number.isFinite(input.createdAt)
        ? input.createdAt
        : Date.now(),
  };

  const wordKey = normalizeWakeWordKey(wakeWord);
  // 若传入重复 ID，先移除旧记录再追加
  const deduped = store.prototypes.filter((p) => p.id !== record.id);
  deduped.push(record);
  store.prototypes = enforceWordSourceCap(deduped, wordKey, source);
  saveWakeWordStore(store);
  return record;
}

/**
 * 替换指定唤醒词的 TTS 预热原型（仅替换 source === "tts-bootstrap"，绝不触碰用户 enrolled 样本）。
 */
export function replaceTtsPrototypesForWord(
  wakeWord: string,
  records: readonly ReplaceTtsPrototypeInput[],
): WakeWordPrototypeRecord[] {
  const cleanWord = wakeWord.trim();
  if (!cleanWord) {
    throw new Error("唤醒词不能为空");
  }
  const wordKey = normalizeWakeWordKey(cleanWord);
  const store = loadWakeWordStore();

  // 严格保留所有非目标词条，以及目标词条的全部用户 enrolled 样本
  const preserved = store.prototypes.filter(
    (p) => !(normalizeWakeWordKey(p.wakeWord) === wordKey && p.source === "tts-bootstrap"),
  );

  const created: WakeWordPrototypeRecord[] = [];
  const now = Date.now();
  for (const item of records) {
    const embeddings = sanitizeEmbeddings(item.embeddings);
    if (embeddings.length === 0) continue;
    created.push({
      id: item.id?.trim() || makePrototypeId(cleanWord, "tts-bootstrap"),
      wakeWord: cleanWord,
      source: "tts-bootstrap",
      voiceTag: item.voiceTag.trim() || "tts",
      frameCount: embeddings.length,
      embeddings,
      createdAt:
        typeof item.createdAt === "number" && Number.isFinite(item.createdAt)
          ? item.createdAt
          : now,
    });
  }

  const capped = created.slice(-MAX_TTS_PROTOTYPES_PER_WORD);
  store.prototypes = [...preserved, ...capped];
  saveWakeWordStore(store);
  return capped;
}

/**
 * 按样本 ID 删除单条唤醒词原型。
 */
export function deleteWakeWordPrototypeById(id: string): boolean {
  const targetId = id.trim();
  if (!targetId) return false;
  const store = loadWakeWordStore();
  const next = store.prototypes.filter((p) => p.id !== targetId);
  if (next.length === store.prototypes.length) {
    return false;
  }
  store.prototypes = next;
  saveWakeWordStore(store);
  return true;
}

/**
 * 按唤醒词删除原型（可选仅删除用户录制样本 enrolledOnly，保留 TTS 预热原型）。
 */
export function deleteWakeWordPrototypesForWord(
  wakeWord: string,
  options?: { enrolledOnly?: boolean },
): number {
  const wordKey = normalizeWakeWordKey(wakeWord);
  if (!wordKey) return 0;
  const store = loadWakeWordStore();
  const enrolledOnly = Boolean(options?.enrolledOnly);

  const next = store.prototypes.filter((p) => {
    if (normalizeWakeWordKey(p.wakeWord) !== wordKey) return true;
    if (enrolledOnly) return p.source !== "enrolled";
    return false;
  });

  const removed = store.prototypes.length - next.length;
  if (removed > 0) {
    store.prototypes = next;
    saveWakeWordStore(store);
  }
  return removed;
}

/**
 * 汇总各唤醒词的原型覆盖情况（若传入 configuredWakeWords，则优先按配置顺序展示并补全 0 样本词条）。
 */
export function listWakeWordPrototypeSummaries(
  configuredWakeWords?: readonly string[],
): WakeWordPrototypeSummary[] {
  const store = loadWakeWordStore();
  const grouped = new Map<
    string,
    {
      displayWord: string;
      records: WakeWordPrototypeRecord[];
    }
  >();

  const configuredOrder: string[] = [];
  if (configuredWakeWords) {
    for (const rawWord of configuredWakeWords) {
      const displayWord = rawWord.trim();
      const key = normalizeWakeWordKey(displayWord);
      if (!key || grouped.has(key)) continue;
      grouped.set(key, { displayWord, records: [] });
      configuredOrder.push(key);
    }
  }

  const extraOrder: string[] = [];
  for (const rec of store.prototypes) {
    const key = normalizeWakeWordKey(rec.wakeWord);
    if (!key) continue;
    let bucket = grouped.get(key);
    if (!bucket) {
      bucket = { displayWord: rec.wakeWord, records: [] };
      grouped.set(key, bucket);
      extraOrder.push(key);
    }
    bucket.records.push(rec);
  }

  const summaries: WakeWordPrototypeSummary[] = [];
  for (const key of [...configuredOrder, ...extraOrder]) {
    const bucket = grouped.get(key);
    if (!bucket) continue;
    let enrolledCount = 0;
    let ttsCount = 0;
    let updatedAt: number | null = null;
    const sampleIds: string[] = [];
    const enrolledIds: string[] = [];

    for (const rec of bucket.records) {
      sampleIds.push(rec.id);
      if (rec.source === "enrolled") {
        enrolledCount += 1;
        enrolledIds.push(rec.id);
      } else {
        ttsCount += 1;
      }
      if (updatedAt === null || rec.createdAt > updatedAt) {
        updatedAt = rec.createdAt;
      }
    }

    summaries.push({
      wakeWord: bucket.displayWord,
      enrolledCount,
      ttsCount,
      totalCount: bucket.records.length,
      sampleIds,
      enrolledIds,
      updatedAt,
    });
  }

  return summaries;
}

/**
 * 获取指定唤醒词集合对应的全部声学原型（用户录制原型优先排列）。
 */
export function getPrototypesForWords(wakeWords: readonly string[]): WakeWordPrototypeRecord[] {
  const keySet = new Set<string>();
  for (const w of wakeWords) {
    const key = normalizeWakeWordKey(w);
    if (key) keySet.add(key);
  }
  if (keySet.size === 0) return [];

  const store = loadWakeWordStore();
  const matched = store.prototypes.filter((p) => keySet.has(normalizeWakeWordKey(p.wakeWord)));
  matched.sort((a, b) => {
    if (a.source === b.source) return b.createdAt - a.createdAt;
    return a.source === "enrolled" ? -1 : 1;
  });
  return matched;
}

/**
 * 更新通用语音背景均值（96 维）与硬负样本特征，供均值中心化与对比惩罚校准使用。
 */
export function setStoreBackgroundStats(
  bgMean: readonly number[],
  hardNegatives: readonly WakeWordHardNegativeRecord[],
): void {
  const store = loadWakeWordStore();
  const cleanBg = sanitizeEmbeddingFrame(bgMean);
  store.bgMean = cleanBg ?? [];

  const cleanNegs: WakeWordHardNegativeRecord[] = [];
  for (const item of hardNegatives) {
    const label = item.label.trim();
    const embeddings = sanitizeEmbeddings(item.embeddings);
    if (!label || embeddings.length === 0) continue;
    cleanNegs.push({ label, embeddings });
  }
  store.hardNegatives = cleanNegs;
  saveWakeWordStore(store);
}
