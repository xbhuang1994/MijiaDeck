// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

export interface DeviceInfo {
  did: string;
  name: string;
  model: string;
  home_name: string;
  room_name: string;
  online: boolean;
  spec_type: string;
  switch_channels: string[];
  light_features: string[];
  /** null = unverified; [] = verified no supported readout */
  metric_features: string[] | null;
  firmware: string;
}

export function createDeviceInfo(
  partial: Pick<DeviceInfo, "did" | "name" | "model" | "home_name" | "room_name" | "online"> &
    Partial<Omit<DeviceInfo, "did" | "name" | "model" | "home_name" | "room_name" | "online">>,
): DeviceInfo {
  return {
    did: partial.did,
    name: partial.name,
    model: partial.model,
    home_name: partial.home_name,
    room_name: partial.room_name,
    online: partial.online,
    spec_type: partial.spec_type ?? "",
    switch_channels: partial.switch_channels ? [...partial.switch_channels] : [],
    light_features: partial.light_features ? [...partial.light_features] : [],
    metric_features:
      partial.metric_features === undefined
        ? null
        : partial.metric_features === null
          ? null
          : [...partial.metric_features],
    firmware: partial.firmware ?? "",
  };
}

export interface PropEnumOption {
  value: number | string;
  description?: string;
  desc_zh_cn?: string;
}

export interface PropInfo {
  name: string;
  desc: string;
  type: string; // bool / int / uint / float / string
  readable: boolean;
  writable: boolean;
  range: [number, number, number] | [number, number] | null;
  value_list: PropEnumOption[] | null;
}

export function createPropInfo(
  partial: Pick<PropInfo, "name" | "desc" | "type" | "readable" | "writable"> &
    Partial<Pick<PropInfo, "range" | "value_list">>,
): PropInfo {
  return {
    name: partial.name,
    desc: partial.desc,
    type: partial.type,
    readable: partial.readable,
    writable: partial.writable,
    range: partial.range ?? null,
    value_list: partial.value_list ?? null,
  };
}

export interface ActionInfo {
  name: string;
  desc: string;
}

export interface DeviceDetail {
  did: string;
  name: string;
  model: string;
  props: PropInfo[];
  actions: ActionInfo[];
}

export interface SceneInfo {
  scene_id: string;
  name: string;
  home_id: string;
  home_name: string;
}

export function createSceneInfo(
  partial: Pick<SceneInfo, "scene_id" | "name" | "home_id"> & Partial<Pick<SceneInfo, "home_name">>,
): SceneInfo {
  return {
    scene_id: partial.scene_id,
    name: partial.name,
    home_id: partial.home_id,
    home_name: partial.home_name ?? "",
  };
}

/**
 * 小爱音箱判定：音频控制栏、语音入口共用同一标准。
 * 用包含匹配而非限定 xiaomi 前缀，第三方音箱（模型含 wifispeaker）同样具备能力。
 */
export function isSpeaker(device: Pick<DeviceInfo, "model">): boolean {
  return device.model.includes("wifispeaker");
}
