// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors
/**
 * 设备列表本地缓存。
 *
 * 启动时优先读缓存渲染，省去每次打开都等一轮全量拉取；手动刷新成功
 * 与退出时落盘。文件与其他配置同放在用户数据目录（见 jsonStore），
 * 任何读取异常都按无缓存处理走在线加载，缓存只加速、不添堵。
 */

import { readFileSync } from "node:fs";
import { dataFile, writeJson } from "./jsonStore.ts";
import { createDeviceInfo, type DeviceInfo } from "./models.ts";

// 版本 3：保留拆分面板关系与已确认的灯光调节能力，旧缓存重新获取。
export const CACHE_VERSION = 4; // Includes verified readouts for tray selection.
const FILENAME = "devices_cache.json";

const ALLOWED_DEVICE_KEYS = new Set<string>([
  "did",
  "name",
  "model",
  "home_name",
  "room_name",
  "online",
  "spec_type",
  "switch_channels",
  "light_features",
  "metric_features",
  "firmware",
  "platform",
]);

const VALID_PLATFORMS = new Set<string>(["mijia", "tuya", "midea", "deye"]);

export interface DeviceCacheData {
  devices: DeviceInfo[];
  knownPower: Record<string, boolean | null>;
  metrics: Record<string, string>;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function parseDeviceInfo(item: unknown): DeviceInfo | null {
  if (!isPlainRecord(item)) {
    return null;
  }
  for (const key of Object.keys(item)) {
    if (!ALLOWED_DEVICE_KEYS.has(key)) {
      return null;
    }
  }
  if (
    typeof item.did !== "string" ||
    typeof item.name !== "string" ||
    typeof item.model !== "string" ||
    typeof item.home_name !== "string" ||
    typeof item.room_name !== "string" ||
    typeof item.online !== "boolean"
  ) {
    return null;
  }
  if (item.spec_type !== undefined && typeof item.spec_type !== "string") {
    return null;
  }
  if (item.switch_channels !== undefined && !isStringArray(item.switch_channels)) {
    return null;
  }
  if (item.light_features !== undefined && !isStringArray(item.light_features)) {
    return null;
  }
  if (
    item.metric_features !== undefined &&
    item.metric_features !== null &&
    !isStringArray(item.metric_features)
  ) {
    return null;
  }
  if (item.firmware !== undefined && typeof item.firmware !== "string") {
    return null;
  }
  if (
    item.platform !== undefined &&
    (typeof item.platform !== "string" || !VALID_PLATFORMS.has(item.platform))
  ) {
    return null;
  }
  return createDeviceInfo({
    did: item.did,
    name: item.name,
    model: item.model,
    home_name: item.home_name,
    room_name: item.room_name,
    online: item.online,
    spec_type: item.spec_type,
    switch_channels: item.switch_channels,
    light_features: item.light_features,
    metric_features: item.metric_features,
    firmware: item.firmware,
    ...(item.platform !== undefined
      ? { platform: item.platform as "mijia" | "tuya" | "midea" | "deye" }
      : {}),
  });
}

/**
 * 返回 { devices, knownPower, metrics }；无效一律返回 null。
 *
 * 开关记忆沿用主窗口语义：true/false 为上次已知状态，null 表示
 * 已确认无开关能力。温湿度为 did->展示文案（如 28.0°C 60%）。
 * 结构不匹配直接丢弃，避免脏数据进 UI。
 */
export function load(): DeviceCacheData | null {
  const filePath = dataFile(FILENAME);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
  if (!isPlainRecord(raw) || raw.version !== CACHE_VERSION) {
    return null;
  }
  const items = raw.devices;
  if (!Array.isArray(items)) {
    return null;
  }
  const devices: DeviceInfo[] = [];
  for (const item of items) {
    const parsed = parseDeviceInfo(item);
    if (!parsed) {
      return null;
    }
    devices.push(parsed);
  }
  const knownRaw = raw.known_power;
  const knownPower: Record<string, boolean | null> = {};
  if (isPlainRecord(knownRaw)) {
    for (const [key, value] of Object.entries(knownRaw)) {
      if (value === true || value === false || value === null) {
        knownPower[String(key)] = value;
      }
    }
  }
  const metricsRaw = raw.metrics;
  const metrics: Record<string, string> = {};
  if (isPlainRecord(metricsRaw)) {
    for (const [key, value] of Object.entries(metricsRaw)) {
      if (typeof value === "string" && value.length > 0) {
        metrics[String(key)] = value;
      }
    }
  }
  return { devices, knownPower, metrics };
}

export function save(
  devices: DeviceInfo[],
  knownPower: Record<string, boolean | null>,
  metrics?: Record<string, string | null> | null,
): void {
  // metrics 只存有值条目，避免空值膨胀文件
  const cleanMetrics: Record<string, string> = {};
  if (isPlainRecord(metrics)) {
    for (const [key, value] of Object.entries(metrics)) {
      if (typeof value === "string" && value.length > 0) {
        cleanMetrics[String(key)] = value;
      }
    }
  }
  const data: Record<string, unknown> = {
    version: CACHE_VERSION,
    devices: devices.map((device) => ({ ...device })),
    known_power: knownPower,
    metrics: cleanMetrics,
  };
  // 写失败不影响主流程，下次刷新会再次尝试
  writeJson(dataFile(FILENAME), data);
}
