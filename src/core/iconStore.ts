// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors
/**
 * 设备图标持久化：model -> 图标 URL 映射与图片文件缓存。
 *
 * 图标 URL 来自米家 CDN（Expires 为 9999 年，可长期信任），启动时优先
 * 读磁盘缓存避免重复调接口，只对缓存里没有的型号增量拉取。任何读取
 * 异常都按无缓存处理，缓存只加速、不添堵。
 */

import path from "node:path";
import { dataDir, dataFile, readJson, writeJson } from "./jsonStore.ts";

export const CACHE_VERSION = 1;
const FILENAME = "device_icons.json";
const ICONS_SUBDIR = "icons";

// model 是云端型号标识（如 xiaomi.wifispeaker.x08c），文件名只保留
// 合法字符，防止异常数据把图片写出数据目录
const ILLEGAL_CHARS_RE = /[/\\:*?"<>|]/g;

export function iconsDir(): string {
  return path.join(dataDir(), ICONS_SUBDIR);
}

export function iconPath(model: string): string {
  const safe = model.replace(ILLEGAL_CHARS_RE, "_");
  return path.join(iconsDir(), `${safe}.png`);
}

/** 读磁盘图标 URL 缓存；无效或损坏返回空对象。 */
export function loadUrls(): Record<string, string> {
  const raw = readJson<Record<string, unknown>>(dataFile(FILENAME), {});
  if (raw.version !== CACHE_VERSION) {
    return {};
  }
  const icons = raw.icons;
  if (typeof icons !== "object" || icons === null || Array.isArray(icons)) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(icons as Record<string, unknown>)) {
    if (typeof v === "string" && v.length > 0) {
      result[String(k)] = v;
    }
  }
  return result;
}

export function saveUrls(urls: Record<string, string>): void {
  writeJson(dataFile(FILENAME), {
    version: CACHE_VERSION,
    icons: urls,
  });
}
