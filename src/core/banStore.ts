// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors
/**
 * 被屏蔽（ban）设备列表的本地持久化。
 *
 * 与 tray.json 同目录，单独文件 banned_devices.json，随账号配置隔离。
 * 被屏蔽设备不再出现在主界面常规控制列表、托盘快捷窗口及 Pi Agent 智能控制中，
 * 而是集中展示在「已屏蔽」栏，可随时右键取消屏蔽恢复。
 */

import { dataFile, readJson, writeJson } from "./jsonStore.ts";

export const BAN_STORE_VERSION = 1;
const FILENAME = "banned_devices.json";

interface RawBanStore extends Record<string, unknown> {
  version: number;
  devices: string[];
}

function empty(): RawBanStore {
  return { version: BAN_STORE_VERSION, devices: [] };
}

function normalizeDids(dids: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const uniq: string[] = [];
  for (const item of dids) {
    if (typeof item !== "string") {
      continue;
    }
    const id = item.trim();
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    uniq.push(id);
  }
  return uniq;
}

function readRaw(): RawBanStore {
  const raw = readJson<Record<string, unknown>>(dataFile(FILENAME), empty());
  if (raw.version !== BAN_STORE_VERSION) {
    return empty();
  }
  if (!Array.isArray(raw.devices)) {
    return empty();
  }
  return {
    version: BAN_STORE_VERSION,
    devices: normalizeDids(raw.devices),
  };
}

function writeRaw(raw: RawBanStore): void {
  writeJson(dataFile(FILENAME), raw);
}

/** 已屏蔽设备 did 列表（去重保序）。 */
export function load(): string[] {
  return [...readRaw().devices];
}

/** 已屏蔽设备 did 集合。 */
export function loadSet(): Set<string> {
  return new Set(readRaw().devices);
}

/** 覆盖保存已屏蔽设备 did 列表（去重保序）。 */
export function save(dids: readonly string[]): string[] {
  const uniq = normalizeDids(dids);
  writeRaw({ version: BAN_STORE_VERSION, devices: uniq });
  return uniq;
}

/** 添加一个设备到屏蔽列表。 */
export function add(did: string): string[] {
  const id = String(did ?? "").trim();
  const current = load();
  if (!id || current.includes(id)) {
    return current;
  }
  current.push(id);
  return save(current);
}

/** 从屏蔽列表移除一个设备。 */
export function remove(did: string): string[] {
  const id = String(did ?? "").trim();
  const current = load();
  if (!id || !current.includes(id)) {
    return current;
  }
  return save(current.filter((item) => item !== id));
}

/** 设置指定设备的屏蔽状态，返回更新后的完整屏蔽列表。 */
export function setBanned(did: string, banned: boolean): string[] {
  return banned ? add(did) : remove(did);
}

/** 判断设备是否已被屏蔽。 */
export function contains(did: string): boolean {
  const id = String(did ?? "").trim();
  return id.length > 0 && load().includes(id);
}
