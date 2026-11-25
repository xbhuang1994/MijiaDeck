// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * 米家风格的设备卡片控制器（1:1 移植自 app/ui/device_card.py）。
 *
 * 卡片按设备角色提供常用操作：圆形电源钮直接开关，面板本体只展示；
 * 调光调色灯点击打开小控制窗，摄像头提供独立播放按钮与预览窗口。
 *
 * 设备是否支持开关在列表接口里拿不到：电源钮初始隐藏，后台批量探测
 * 确认有可写开关属性后才显示并回填真实状态。
 */

import { TypedEmitter, type Point } from "../../core/contracts.ts";
import {
  deviceSubtitle,
  deviceTitle,
  hasDeviceDetails,
  isCamera,
  isLight,
  supportsCardPower,
} from "../../core/deviceControls.ts";
import type { DeviceInfo } from "../../core/models.ts";
import { SiColors } from "../theme.ts";

export const POWER_BTN_SIZE = 36;
export const ICON_SIZE = 34;
// 主页内容使用更舒展的尺寸，不影响全局 DPI 或托盘卡片。
// 网格以此最小宽度计算列数，再均分可用宽度，避免右侧留下整块空白。
export const CARD_FIXED_WIDTH = 212;
export const CARD_FIXED_HEIGHT = 92;

const PLAY_BUTTON_ICON_SIZE = 26;

const MODEL_ICONS: ReadonlyArray<readonly [string, string]> = [
  ["wifispeaker", "mdi.speaker"],
  ["light", "mdi.lightbulb-outline"],
  ["plug", "mdi.power-socket-eu"],
  ["sensor", "mdi.thermometer"],
  ["humidifier", "mdi.water-outline"],
  ["airpurifier", "mdi.air-filter"],
  ["curtain", "mdi.blinds"],
  ["camera", "mdi.cctv"],
];

function resolveFallbackIcon(model: string): string {
  for (const [key, icon] of MODEL_ICONS) {
    if (model.includes(key)) {
      return icon;
    }
  }
  return "mdi.devices";
}

export type DeviceCardEvents = {
  powerClicked: [string];
  openRequested: [string];
  trayMenuRequested: [string, Point];
};

export interface DeviceCardSnapshot {
  did: string;
  title: string;
  subtitle: string;
  online: boolean;
  busy: boolean;
  hovered: boolean;
  powerState: boolean | null;
  powerButtonVisible: boolean;
  powerButtonEnabled: boolean;
  hasPlayButton: boolean;
  playButtonEnabled: boolean;
  playButtonWidth: number;
  playButtonIconSize: number;
  hasCameraCornerTag: boolean;
  hasLightCornerTag: boolean;
  cursor: "pointer" | "arrow";
  backgroundColor: string;
  borderColor: string;
  iconPath: string | null;
  fallbackIcon: string;
  width: number;
  height: number;
}

export class DeviceCardController extends TypedEmitter<DeviceCardEvents> {
  readonly device: DeviceInfo;
  readonly online: boolean;
  readonly hasPlayButton: boolean;
  readonly playButtonEnabled: boolean;
  readonly playButtonWidth: number = POWER_BTN_SIZE;
  readonly playButtonIconSize: number = PLAY_BUTTON_ICON_SIZE;
  readonly playButtonAccessibleName: string;
  readonly hasCameraCornerTag: boolean;
  readonly hasLightCornerTag: boolean;
  readonly cursor: "pointer" | "arrow";
  readonly fallbackIcon: string;
  readonly height: number = CARD_FIXED_HEIGHT;

  subtitle: string;
  busy = false;
  hovered = false;
  powerState: boolean | null = null;
  // 列表接口不带开关信息，初始隐藏电源钮；后台探测确认设备
  // 有可写开关属性后再经 setPowerState 显示并回填真实状态。
  powerButtonVisible = false;
  iconPath: string | null = null;
  width: number = CARD_FIXED_WIDTH;
  disposed = false;

  private _metricsText: string | null = null;
  private _panelStates: Record<string, boolean | null | undefined> = {};

  constructor(device: DeviceInfo) {
    super();
    this.device = device;
    this.online = device.online;
    this.hasPlayButton = isCamera(device);
    this.playButtonEnabled = this.hasPlayButton && this.online;
    this.playButtonAccessibleName = this.online ? "查看摄像头画面" : "摄像头离线";
    this.hasCameraCornerTag = this.hasPlayButton;
    this.hasLightCornerTag = !this.hasPlayButton && isLight(device) && hasDeviceDetails(device);
    this.cursor = hasDeviceDetails(device) ? "pointer" : "arrow";
    this.fallbackIcon = resolveFallbackIcon(device.model);
    this.subtitle = this._subText(null);
  }

  get title(): string {
    return deviceTitle(this.device);
  }

  get powerButtonEnabled(): boolean {
    return this.online && !this.busy;
  }

  get backgroundColor(): string {
    if (!this.online) {
      // 离线卡片整体灰置，hover 不提亮（无交互暗示）
      return SiColors.OFFLINE_CARD;
    }
    return this.hovered && hasDeviceDetails(this.device) ? SiColors.CARD_HOVER : SiColors.CARD;
  }

  get borderColor(): string {
    return this.hovered && this.online && hasDeviceDetails(this.device)
      ? SiColors.CARD_BORDER_HOVER
      : SiColors.LINE;
  }

  get nameColor(): string {
    return this.online ? SiColors.INFO_TEXT : SiColors.OFFLINE_TEXT;
  }

  get subtitleColor(): string {
    return this.online ? SiColors.TEXT_SECONDARY : SiColors.OFFLINE_SUB;
  }

  setFixedWidth(width: number): void {
    this.width = width;
  }

  // ---------- 状态渲染 ----------

  setIcon(path: string | null): void {
    if (path === null || path.trim() === "") {
      return;
    }
    this.iconPath = path;
  }

  setPowerState(state: boolean | null): void {
    if (!supportsCardPower(this.device)) {
      this.powerState = null;
      this.powerButtonVisible = false;
      return;
    }
    if (state === null) {
      this.powerState = null;
      this.powerButtonVisible = false;
      return;
    }
    // 能设置状态即证明设备具备开关能力，电源钮随之可见
    this.powerState = Boolean(state);
    this.powerButtonVisible = true;
  }

  setMetrics(text: string | null): void {
    // 离线设备不展示温湿度，读数可能是旧缓存
    if (!this.online) {
      return;
    }
    this._metricsText = text ?? null;
    this.subtitle = this._subText(this._metricsText);
  }

  setPanelStates(states: Record<string, boolean | null | undefined>): void {
    if (this.device.switch_channels.length > 0) {
      this._panelStates = { ...states };
      this.subtitle = this._subText(this._metricsText);
    }
  }

  setBusy(busy: boolean): void {
    this.busy = Boolean(busy);
  }

  setHovered(hovered: boolean): void {
    this.hovered = Boolean(hovered);
  }

  // ---------- 交互 ----------

  clickCard(): void {
    if (hasDeviceDetails(this.device) && this.online) {
      this.emit("openRequested", this.device.did);
    }
  }

  clickPlayButton(): void {
    if (this.hasPlayButton && this.online) {
      this.emit("openRequested", this.device.did);
    }
  }

  clickPowerButton(): void {
    if (this.powerButtonVisible && this.online && !this.busy) {
      this.emit("powerClicked", this.device.did);
    }
  }

  contextMenu(pos: Point): boolean {
    this.emit("trayMenuRequested", this.device.did, { x: pos.x, y: pos.y });
    return true;
  }

  dispose(): void {
    this.disposed = true;
    this.clear();
  }

  snapshot(): DeviceCardSnapshot {
    return {
      did: this.device.did,
      title: this.title,
      subtitle: this.subtitle,
      online: this.online,
      busy: this.busy,
      hovered: this.hovered,
      powerState: this.powerState,
      powerButtonVisible: this.powerButtonVisible,
      powerButtonEnabled: this.powerButtonEnabled,
      hasPlayButton: this.hasPlayButton,
      playButtonEnabled: this.playButtonEnabled,
      playButtonWidth: this.playButtonWidth,
      playButtonIconSize: this.playButtonIconSize,
      hasCameraCornerTag: this.hasCameraCornerTag,
      hasLightCornerTag: this.hasLightCornerTag,
      cursor: this.cursor,
      backgroundColor: this.backgroundColor,
      borderColor: this.borderColor,
      iconPath: this.iconPath,
      fallbackIcon: this.fallbackIcon,
      width: this.width,
      height: this.height,
    };
  }

  private _subText(metrics: string | null): string {
    return deviceSubtitle(this.device, metrics, this._panelStates);
  }
}
