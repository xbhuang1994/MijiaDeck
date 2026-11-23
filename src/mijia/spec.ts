// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * MIoT-Spec v2 fetcher, flattener, and atomic disk cache
 * (compatible with mijiaAPI 5.x flattened device spec shape).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  boundedFetch,
  createBoundedFetch,
  isBoundedFetch,
  type BoundedFetch,
  type FetchLike,
} from "../core/httpTimeout.ts";
import { GetDeviceInfoError } from "./errors.ts";

const MIOT_SPEC_INSTANCE_URL = "https://miot-spec.org/miot-spec-v2/instance";

export interface RawSpecMethod {
  siid: number;
  piid?: number;
  aiid?: number;
}

export interface RawSpecProp {
  name: string;
  description: string;
  type: string; // bool | int | uint | float | string
  rw: string; // "r" | "w" | "rw" | ""
  unit?: string | null;
  range?: [number, number, number] | [number, number] | null;
  "value-list"?: Array<{ value: number | string; description?: string; desc_zh_cn?: string }> | null;
  method: { siid: number; piid: number };
}

export interface RawSpecAction {
  name: string;
  description: string;
  method: { siid: number; aiid: number };
}

export interface FlattenedSpec {
  name: string;
  model?: string;
  properties: RawSpecProp[];
  actions: RawSpecAction[];
}

export interface GetDeviceInfoOptions {
  cachePath?: string;
  fetcher?: FetchLike;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractUrnShortName(urn: unknown): string {
  if (typeof urn !== "string" || !urn) {
    return "";
  }
  const parts = urn.split(":");
  if (parts.length >= 4 && parts[3]) {
    return parts[3].trim();
  }
  return "";
}

function normalizeFormat(format: unknown): string {
  if (typeof format !== "string" || !format) {
    return "string";
  }
  const lower = format.trim().toLowerCase();
  if (lower === "bool" || lower === "boolean") {
    return "bool";
  }
  if (/^int(8|16|32|64)?$/.test(lower)) {
    return "int";
  }
  if (/^uint(8|16|32|64)?$/.test(lower)) {
    return "uint";
  }
  if (lower === "float" || lower === "double") {
    return "float";
  }
  if (lower === "string") {
    return "string";
  }
  return lower;
}

function normalizeRw(access: unknown): string {
  if (!Array.isArray(access)) {
    return "";
  }
  let rw = "";
  if (access.includes("read")) {
    rw += "r";
  }
  if (access.includes("write")) {
    rw += "w";
  }
  return rw;
}

function normalizeRange(
  rawRange: unknown,
): [number, number, number] | [number, number] | null {
  if (!Array.isArray(rawRange)) {
    return null;
  }
  if (rawRange.length === 3) {
    const [min, max, step] = rawRange;
    if (
      typeof min === "number" && Number.isFinite(min) &&
      typeof max === "number" && Number.isFinite(max) &&
      typeof step === "number" && Number.isFinite(step)
    ) {
      return [min, max, step];
    }
  } else if (rawRange.length === 2) {
    const [min, max] = rawRange;
    if (
      typeof min === "number" && Number.isFinite(min) &&
      typeof max === "number" && Number.isFinite(max)
    ) {
      return [min, max];
    }
  }
  return null;
}

function normalizeValueList(
  rawList: unknown,
): Array<{ value: number | string; description?: string; desc_zh_cn?: string }> | null {
  if (!Array.isArray(rawList) || rawList.length === 0) {
    return null;
  }
  const items: Array<{ value: number | string; description?: string; desc_zh_cn?: string }> = [];
  for (const entry of rawList) {
    if (!isRecord(entry)) {
      continue;
    }
    const val = entry["value"];
    if (typeof val !== "number" && typeof val !== "string") {
      continue;
    }
    const item: { value: number | string; description?: string; desc_zh_cn?: string } = {
      value: val,
    };
    const desc = typeof entry["description"] === "string" ? entry["description"].trim() : "";
    if (desc) {
      item.description = desc;
    }
    const zhRaw =
      typeof entry["desc_zh_cn"] === "string"
        ? entry["desc_zh_cn"].trim()
        : typeof entry["comment"] === "string"
          ? entry["comment"].trim()
          : typeof entry["descriptionTranslate"] === "string"
            ? entry["descriptionTranslate"].trim()
            : "";
    if (zhRaw) {
      item.desc_zh_cn = zhRaw;
    }
    items.push(item);
  }
  return items.length > 0 ? items : null;
}

function formatDescription(entry: Record<string, unknown>, fallback: string): string {
  const desc = typeof entry["description"] === "string" ? entry["description"].trim() : "";
  const comment =
    typeof entry["comment"] === "string"
      ? entry["comment"].trim()
      : typeof entry["descriptionTranslate"] === "string"
        ? entry["descriptionTranslate"].trim()
        : "";
  if (desc && comment && comment !== desc && !desc.includes(comment)) {
    return `${desc} / ${comment}`;
  }
  return desc || comment || fallback;
}

function isFlattenedSpec(value: unknown): value is FlattenedSpec {
  if (!isRecord(value)) {
    return false;
  }
  return Array.isArray(value["properties"]) && Array.isArray(value["actions"]);
}

/**
 * Convert an official `miot-spec.org/miot-spec-v2/instance` JSON document into the
 * flattened format used by mijiaAPI 5.x and MijiaDeck.
 */
export function flattenMiotSpec(
  raw: Record<string, unknown>,
  specType?: string,
): FlattenedSpec {
  if (!isRecord(raw) || !Array.isArray(raw["services"])) {
    throw new GetDeviceInfoError(
      `Invalid MIoT spec payload${specType ? ` for ${specType}` : ""}: missing services array`,
    );
  }

  interface PendingProp {
    baseName: string;
    siid: number;
    piid: number;
    entry: Record<string, unknown>;
  }

  interface PendingAction {
    baseName: string;
    siid: number;
    aiid: number;
    entry: Record<string, unknown>;
  }

  const pendingProps: PendingProp[] = [];
  const pendingActions: PendingAction[] = [];

  for (const service of raw["services"]) {
    if (!isRecord(service)) {
      continue;
    }
    const siid = service["iid"];
    if (typeof siid !== "number" || !Number.isInteger(siid)) {
      continue;
    }
    const serviceShortName = extractUrnShortName(service["type"]);
    if (serviceShortName === "device-information") {
      continue;
    }

    if (Array.isArray(service["properties"])) {
      for (const prop of service["properties"]) {
        if (!isRecord(prop)) {
          continue;
        }
        const piid = prop["iid"];
        if (typeof piid !== "number" || !Number.isInteger(piid)) {
          continue;
        }
        const baseName =
          extractUrnShortName(prop["type"]) ||
          (typeof prop["name"] === "string" && prop["name"].trim()) ||
          `prop-${siid}-${piid}`;
        pendingProps.push({ baseName, siid, piid, entry: prop });
      }
    }

    if (Array.isArray(service["actions"])) {
      for (const act of service["actions"]) {
        if (!isRecord(act)) {
          continue;
        }
        const aiid = act["iid"];
        if (typeof aiid !== "number" || !Number.isInteger(aiid)) {
          continue;
        }
        const baseName =
          extractUrnShortName(act["type"]) ||
          (typeof act["name"] === "string" && act["name"].trim()) ||
          `action-${siid}-${aiid}`;
        pendingActions.push({ baseName, siid, aiid, entry: act });
      }
    }
  }

  const propCounts = new Map<string, number>();
  for (const item of pendingProps) {
    propCounts.set(item.baseName, (propCounts.get(item.baseName) ?? 0) + 1);
  }
  const usedPropNames = new Set<string>();
  const properties: RawSpecProp[] = [];
  for (const item of pendingProps) {
    const isDuplicate = (propCounts.get(item.baseName) ?? 0) > 1;
    let finalName = isDuplicate ? `${item.baseName}-${item.siid}` : item.baseName;
    if (usedPropNames.has(finalName)) {
      finalName = `${item.baseName}-${item.siid}-${item.piid}`;
    }
    usedPropNames.add(finalName);

    const rawUnit = item.entry["unit"];
    const unit =
      typeof rawUnit === "string" && rawUnit.trim() && rawUnit.trim().toLowerCase() !== "none"
        ? rawUnit.trim()
        : null;

    properties.push({
      name: finalName,
      description: formatDescription(item.entry, finalName),
      type: normalizeFormat(item.entry["format"] ?? item.entry["type"]),
      rw:
        typeof item.entry["rw"] === "string"
          ? item.entry["rw"]
          : normalizeRw(item.entry["access"]),
      unit,
      range: normalizeRange(item.entry["value-range"] ?? item.entry["range"]),
      "value-list": normalizeValueList(item.entry["value-list"]),
      method: { siid: item.siid, piid: item.piid },
    });
  }

  const actionCounts = new Map<string, number>();
  for (const item of pendingActions) {
    actionCounts.set(item.baseName, (actionCounts.get(item.baseName) ?? 0) + 1);
  }
  const usedActionNames = new Set<string>();
  const actions: RawSpecAction[] = [];
  for (const item of pendingActions) {
    const isDuplicate = (actionCounts.get(item.baseName) ?? 0) > 1;
    let finalName = isDuplicate ? `${item.baseName}-${item.siid}` : item.baseName;
    if (usedActionNames.has(finalName)) {
      finalName = `${item.baseName}-${item.siid}-${item.aiid}`;
    }
    usedActionNames.add(finalName);

    actions.push({
      name: finalName,
      description: formatDescription(item.entry, finalName),
      method: { siid: item.siid, aiid: item.aiid },
    });
  }

  const topName =
    (typeof raw["name"] === "string" && raw["name"].trim()) ||
    (typeof raw["comment"] === "string" && raw["comment"].trim()) ||
    (typeof raw["descriptionTranslate"] === "string" && raw["descriptionTranslate"].trim()) ||
    (typeof raw["description"] === "string" && raw["description"].trim()) ||
    "";

  const flattened: FlattenedSpec = {
    name: topName,
    properties,
    actions,
  };
  if (typeof raw["model"] === "string" && raw["model"].trim()) {
    flattened.model = raw["model"].trim();
  }
  return flattened;
}

function writeAtomicJson(targetPath: string, data: unknown): void {
  const dir = join(targetPath, "..");
  mkdirSync(dir, { recursive: true });
  const tmpPath = `${targetPath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf8");
    renameSync(tmpPath, targetPath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // ignore cleanup failure
    }
    throw err;
  }
}

/**
 * Load a flattened MIoT device specification from local cache or fetch it from
 * `https://miot-spec.org/miot-spec-v2/instance?type=<specType>` and cache atomically.
 */
export async function getDeviceInfo(
  specType: string,
  options?: GetDeviceInfoOptions,
): Promise<FlattenedSpec> {
  const trimmed = typeof specType === "string" ? specType.trim() : "";
  if (!trimmed) {
    throw new GetDeviceInfoError("Missing or empty specType");
  }

  const cacheDir = options?.cachePath ?? join(homedir(), ".config", "mijia-api");
  const cacheFile = join(cacheDir, `${trimmed.replaceAll(":", "_")}.json`);

  if (existsSync(cacheFile)) {
    try {
      const text = readFileSync(cacheFile, "utf8");
      const parsed: unknown = JSON.parse(text);
      if (isFlattenedSpec(parsed)) {
        return parsed;
      }
      if (isRecord(parsed) && Array.isArray(parsed["services"])) {
        return flattenMiotSpec(parsed, trimmed);
      }
      // Valid JSON but unrecognized structure: fall through or reject
      try {
        unlinkSync(cacheFile);
      } catch {
        // ignore
      }
    } catch {
      // Corrupt or unreadable cache file: remove best-effort and re-fetch
      try {
        unlinkSync(cacheFile);
      } catch {
        // ignore
      }
    }
  }

  const doFetch: BoundedFetch = options?.fetcher
    ? isBoundedFetch(options.fetcher)
      ? options.fetcher
      : createBoundedFetch(options.fetcher)
    : boundedFetch;

  const url = `${MIOT_SPEC_INSTANCE_URL}?type=${encodeURIComponent(trimmed)}`;
  let response: Response;
  try {
    response = await doFetch(url, { method: "GET" });
  } catch (err) {
    throw new GetDeviceInfoError(
      `Failed to fetch device spec for ${trimmed}: ${err instanceof Error ? err.message : String(err)}`,
      undefined,
      { cause: err },
    );
  }

  if (!response.ok) {
    throw new GetDeviceInfoError(
      `Failed to fetch device spec for ${trimmed}: HTTP ${response.status}`,
      response.status,
    );
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (err) {
    throw new GetDeviceInfoError(
      `Invalid JSON in device spec for ${trimmed}`,
      undefined,
      { cause: err },
    );
  }

  let flattened: FlattenedSpec;
  if (isFlattenedSpec(parsed)) {
    flattened = parsed;
  } else if (isRecord(parsed) && Array.isArray(parsed["services"])) {
    flattened = flattenMiotSpec(parsed, trimmed);
  } else {
    throw new GetDeviceInfoError(`Invalid device spec structure for ${trimmed}`);
  }

  try {
    writeAtomicJson(cacheFile, flattened);
  } catch {
    // Non-fatal if cache directory is read-only
  }

  return flattened;
}
