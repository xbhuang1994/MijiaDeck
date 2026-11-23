// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors
/**
 * 托盘快捷项的本地持久化。
 *
 * 与 workbench.json 同目录，单独文件 tray.json，默认空列表，由用户
 * 在管理对话框中自主添加。devices/scenes 记录成员集合（设备存 did；
 * 场景存必要快照 scene_id/name/home_id/home_name，执行只认 id 与
 * home_id，快照名保证离线/未刷新时快捷窗口仍可显示）；order 记录
 * 两类项目混排后的统一展示顺序，快捷窗口按它渲染。
 */

import type { TrayOrderItem, TraySceneSnapshot } from "./contracts.ts";
import { dataFile, readJson, writeJson } from "./jsonStore.ts";

const VERSION = 1;
const FILENAME = "tray.json";

interface RawTrayStore extends Record<string, unknown> {
  version: number;
  devices: string[];
  scenes?: unknown[];
  order?: unknown[];
}

function empty(): RawTrayStore {
  return { version: VERSION, devices: [], scenes: [], order: [] };
}

function readRaw(): RawTrayStore {
  const raw = readJson<Record<string, unknown>>(dataFile(FILENAME), empty());
  if (raw.version !== VERSION) {
    return empty();
  }
  const devices = raw.devices;
  if (!Array.isArray(devices) || !devices.every((d) => typeof d === "string")) {
    return empty();
  }
  return raw as RawTrayStore;
}

function writeRaw(raw: RawTrayStore): void {
  writeJson(dataFile(FILENAME), raw);
}

/** 托盘设备 did 列表（与 order 中设备的相对顺序一致）。 */
export function load(): string[] {
  const devices = readRaw().devices;
  return Array.isArray(devices) ? [...devices] : [];
}

/** 托盘的场景快照列表（与 order 中场景的相对顺序一致）；非法条目直接丢弃。 */
export function loadScenes(): TraySceneSnapshot[] {
  const raw = readRaw().scenes;
  if (!Array.isArray(raw)) {
    return [];
  }
  const result: TraySceneSnapshot[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      continue;
    }
    const rec = item as Record<string, unknown>;
    const sid = rec.scene_id ? String(rec.scene_id) : "";
    if (!sid) {
      continue;
    }
    result.push({
      scene_id: sid,
      name: rec.name ? String(rec.name) : "",
      home_id: rec.home_id ? String(rec.home_id) : "",
      home_name: rec.home_name ? String(rec.home_name) : "",
    });
  }
  return result;
}

export function save(dids: string[]): void {
  const raw = readRaw();
  // 去重保序
  const seen = new Set<string>();
  const uniq: string[] = [];
  for (const d of dids) {
    const s = String(d);
    if (!seen.has(s)) {
      seen.add(s);
      uniq.push(s);
    }
  }
  raw.devices = uniq;
  writeRaw(raw);
}

export function saveScenes(scenes: Array<Partial<TraySceneSnapshot>>): void {
  const raw = readRaw();
  const seen = new Set<string>();
  const uniq: TraySceneSnapshot[] = [];
  for (const item of scenes) {
    const sid = item.scene_id ? String(item.scene_id) : "";
    if (!sid || seen.has(sid)) {
      continue;
    }
    seen.add(sid);
    uniq.push({
      scene_id: sid,
      name: item.name ? String(item.name) : "",
      home_id: item.home_id ? String(item.home_id) : "",
      home_name: item.home_name ? String(item.home_name) : "",
    });
  }
  raw.scenes = uniq;
  writeRaw(raw);
}

/**
 * 设备与场景混排后的统一展示顺序，元素为 { type, id }。
 *
 * 旧数据没有 order 字段时合成（设备在前、场景在后），与历史快捷
 * 窗口的显示顺序一致，用户无需重新排序。
 */
export function loadOrder(): TrayOrderItem[] {
  const raw = readRaw().order;
  if (Array.isArray(raw)) {
    const result: TrayOrderItem[] = [];
    for (const item of raw) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        continue;
      }
      const rec = item as Record<string, unknown>;
      const t = rec.type ? String(rec.type) : "";
      const id = rec.id ? String(rec.id) : "";
      if ((t === "device" || t === "scene") && id) {
        result.push({ type: t, id });
      }
    }
    if (result.length > 0) {
      return result;
    }
  }
  return [
    ...load().map((id): TrayOrderItem => ({ type: "device", id })),
    ...loadScenes().map((s): TrayOrderItem => ({ type: "scene", id: s.scene_id })),
  ];
}

export function saveOrder(order: TrayOrderItem[]): void {
  const raw = readRaw();
  const seen = new Set<string>();
  const uniq: TrayOrderItem[] = [];
  for (const item of order) {
    const t = item.type ? String(item.type) : "";
    const id = item.id ? String(item.id) : "";
    const key = `${t}\0${id}`;
    if ((t !== "device" && t !== "scene") || !id || seen.has(key)) {
      continue;
    }
    seen.add(key);
    uniq.push({ type: t, id });
  }
  raw.order = uniq;
  writeRaw(raw);
}

export function add(did: string): void {
  const s = String(did);
  const dids = load();
  if (!dids.includes(s)) {
    dids.push(s);
    save(dids);
  }
}

export function remove(did: string): void {
  const s = String(did);
  const dids = load();
  const idx = dids.indexOf(s);
  if (idx !== -1) {
    dids.splice(idx, 1);
    save(dids);
  }
}

export function contains(did: string): boolean {
  return load().includes(String(did));
}

/** Commit device membership and mixed ordering together, preserving scenes. */
export function setDeviceSelected(did: string, selected: boolean): void {
  const id = String(did);
  const raw = readRaw();
  let devices = Array.from(new Set(Array.isArray(raw.devices) ? raw.devices : []));
  let order = loadOrder();
  if (selected) {
    if (!devices.includes(id)) {
      devices.push(id);
    }
    if (!order.some((item) => item.type === "device" && item.id === id)) {
      order.push({ type: "device", id });
    }
  } else {
    devices = devices.filter((item) => item !== id);
    order = order.filter((item) => !(item.type === "device" && item.id === id));
  }
  raw.devices = devices;
  raw.order = order;
  writeRaw(raw);
}

export function removeItem(kind: "device" | "scene", itemId: string): void {
  const id = String(itemId);
  if (kind === "device") {
    setDeviceSelected(id, false);
  } else if (kind === "scene") {
    const raw = readRaw();
    raw.scenes = loadScenes().filter((s) => s.scene_id !== id);
    raw.order = loadOrder().filter((item) => !(item.type === "scene" && item.id === id));
    writeRaw(raw);
  }
}
