// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/** Common, user-facing card roles; no editable raw MIoT property lists. */

import type { DeviceInfo, PropInfo } from "./models.ts";
import * as trayStore from "./trayStore.ts";

export type LightPropertyKind = "brightness" | "temperature" | "color";

const DIGITS_RE = /^[0-9]+$/;
const SPEC_DEVICE_KIND_RE = /:device:([^:]+):/;

const CAMERA_KINDS: ReadonlySet<string> = new Set(["camera", "ip-camera"]);

const APPLIANCE_POWER_KINDS: ReadonlySet<string> = new Set([
  "television",
  "tv",
  "amplifier",
  "set-top-box",
  "projector",
  "dvd-player",
  "ir-remote",
  "washer",
  "washing-machine",
  "dryer",
  "air-conditioner",
  "aircondition",
  "airconditioner",
  "fan",
  "air-purifier",
  "airpurifier",
  "purifier",
  "humidifier",
  "dehumidifier",
  "heater",
  "water-heater",
]);

const SPEAKER_KINDS: ReadonlySet<string> = new Set(["speaker", "wifispeaker"]);

const STATUS_CANDIDATE_KINDS: ReadonlySet<string> = new Set([
  "sensor",
  "temperature-humidity-sensor",
  "temperature-sensor",
  "humidity-sensor",
  "motion",
  "motion-sensor",
  "magnet",
  "contact-sensor",
  "door",
  "door-sensor",
  "occupancy-sensor",
  "occupancy",
  "presence",
  "presence-sensor",
  "human",
  "air-monitor",
  "smoke",
  "smoke-sensor",
  "gas-sensor",
  "water-leak-sensor",
  "waterleak",
  "plant-monitor",
  "plantmonitor",
]);

const LIGHT_PROP_MAP = new Map<string, LightPropertyKind>([
  ["brightness", "brightness"],
  ["color-temperature", "temperature"],
  ["color", "color"],
  ["rgb", "color"],
]);

function hasAnyKind(kinds: Set<string>, targets: ReadonlySet<string>): boolean {
  for (const kind of kinds) {
    if (targets.has(kind)) {
      return true;
    }
  }
  return false;
}

export function isLight(device: DeviceInfo): boolean {
  const specType = device.spec_type ?? "";
  if (specType.includes(":device:light:")) {
    return true;
  }
  const parts = device.model.split(".");
  return parts.includes("light") || parts.includes("lamp") || parts.includes("bulb");
}

export function isSwitch(device: DeviceInfo): boolean {
  const specType = device.spec_type ?? "";
  return specType.includes(":device:switch:") || device.model.includes(".switch.");
}

export function isDirectPower(device: DeviceInfo): boolean {
  if (isSwitch(device)) {
    return true;
  }
  const parts = device.model.split(".");
  if (parts.includes("plug") || parts.includes("outlet")) {
    return true;
  }
  return (device.spec_type ?? "").includes(":device:outlet:");
}

export function prepareDeviceCards(devices: DeviceInfo[]): DeviceInfo[] {
  for (const device of devices) {
    if (!isSwitch(device)) {
      device.switch_channels = [];
      continue;
    }
    const prefix = `${device.did}.s`;
    device.switch_channels = devices
      .filter((child) => child.did.startsWith(prefix) && DIGITS_RE.test(child.did.slice(prefix.length)))
      .map((child) => child.did);
  }
  return devices;
}

export function deviceTitle(device: DeviceInfo): string {
  if (device.switch_channels.length > 0 && !device.name.endsWith("面板")) {
    return `${device.name}面板`;
  }
  return device.name;
}

export function hasDeviceDetails(device: DeviceInfo): boolean {
  if (device.switch_channels.length > 0 || isDirectPower(device)) {
    return false;
  }
  return isLight(device) ? device.light_features.length > 0 : isCamera(device);
}

/** Cloud class/model identifies roles; editable names do not. */
export function deviceKinds(device: DeviceInfo): Set<string> {
  const parts = new Set(device.model.toLowerCase().split("."));
  const match = SPEC_DEVICE_KIND_RE.exec(device.spec_type ?? "");
  if (match && match[1] !== undefined) {
    parts.add(match[1]);
  }
  return parts;
}

export function isCamera(device: DeviceInfo): boolean {
  return hasAnyKind(deviceKinds(device), CAMERA_KINDS);
}

export function isIrRemote(device: Pick<DeviceInfo, "model" | "spec_type">): boolean {
  const modelLower = (device.model ?? "").toLowerCase();
  if (modelLower.includes(".infrared_")) {
    return true;
  }
  const specType = (device.spec_type ?? "").toLowerCase();
  return (
    specType.includes(":device:ir-remote:") ||
    specType.includes(":device:amplifier:") ||
    specType.includes(":device:set-top-box:") ||
    specType.includes(":device:projector:") ||
    specType.includes(":device:dvd-player:")
  );
}

/** Real appliance power, not router LEDs or sensor enable flags. */
export function supportsCardPower(device: DeviceInfo): boolean {
  if (device.switch_channels.length > 0) {
    return false;
  }
  if (isLight(device) || isDirectPower(device)) {
    return true;
  }
  return hasAnyKind(deviceKinds(device), APPLIANCE_POWER_KINDS);
}

export function trayEligible(device: DeviceInfo): boolean {
  if (device.switch_channels.length > 0 || supportsCardPower(device) || isCamera(device)) {
    return true;
  }
  if (hasAnyKind(deviceKinds(device), SPEAKER_KINDS)) {
    return true;
  }
  return Array.isArray(device.metric_features) && device.metric_features.length > 0;
}

export function isStatusCandidate(device: DeviceInfo): boolean {
  return hasAnyKind(deviceKinds(device), STATUS_CANDIDATE_KINDS);
}

/** Remove known ineligible cards, preserving missing devices and scenes. */
export function pruneTraySelection(devices: DeviceInfo[]): void {
  const excluded = new Set<string>();
  for (const device of devices) {
    if (!trayEligible(device) && !(isStatusCandidate(device) && device.metric_features === null)) {
      excluded.add(device.did);
    }
  }
  const selected = trayStore.load();
  if (!selected.some((did) => excluded.has(did))) {
    return;
  }
  const order = trayStore.loadOrder();
  trayStore.save(selected.filter((did) => !excluded.has(did)));
  trayStore.saveOrder(order.filter((item) => item.type !== "device" || !excluded.has(item.id)));
}

export function lightPropertyKind(name: string): LightPropertyKind | null {
  const normalized = name.replaceAll("_", "-").replace(/-[0-9]+$/, "");
  return LIGHT_PROP_MAP.get(normalized) ?? null;
}

/** Only expose supported, writable everyday light controls. */
export function lightControls(props: PropInfo[]): Partial<Record<LightPropertyKind, PropInfo>> {
  const selected: Partial<Record<LightPropertyKind, PropInfo>> = {};
  for (const prop of props) {
    const kind = lightPropertyKind(prop.name);
    if (!kind || !prop.writable || (prop.type !== "uint" && prop.type !== "int" && prop.type !== "float")) {
      continue;
    }
    if (kind !== "color" && (!prop.range || prop.range.length < 2 || prop.range[0] >= prop.range[1])) {
      continue;
    }
    if (kind === "color" && prop.type !== "uint" && prop.type !== "int") {
      continue;
    }
    if (
      kind === "color" &&
      ((prop.value_list !== null && prop.value_list.length > 0) ||
        (prop.range !== null && prop.range.length >= 2 && (prop.range[0] > 0 || prop.range[1] < 0xffffff)))
    ) {
      continue;
    }
    if (!(kind in selected)) {
      selected[kind] = prop;
    }
  }
  return selected;
}

export function panelStatus(
  device: DeviceInfo,
  states: Record<string, boolean | null | undefined>,
): string {
  const values = device.switch_channels.map((did) => states[did]);
  if (values.length === 0 || values.some((value) => value === null || value === undefined)) {
    return "状态待确认";
  }
  const count = values.filter((value) => value === true).length;
  if (count === 0) {
    return "全部关闭";
  }
  return count === values.length ? `全部开启 · ${count} 路` : `部分开启 · ${count} 路`;
}

export function deviceSubtitle(
  device: DeviceInfo,
  metrics?: string | null,
  states?: Record<string, boolean | null | undefined> | null,
): string {
  if (!device.online) {
    return `${device.room_name} · 离线`;
  }
  if (device.switch_channels.length > 0) {
    let location = device.room_name;
    if (metrics) {
      location += ` · 设备温度 ${metrics}`;
    }
    return `${location}\n${panelStatus(device, states ?? {})}`;
  }
  return metrics ? `${device.room_name} | ${metrics}` : device.room_name;
}
