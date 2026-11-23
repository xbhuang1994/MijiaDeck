// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * 房间横向选项卡滚动条（区分拖拽滚动与点击激活）及房间弹出菜单模型。
 * 精确 1:1 移植自 app/ui/room_tabs.py。
 */

import { type Point, TypedEmitter } from "../../core/contracts.ts";
import type { DeviceInfo } from "../../core/models.ts";

export interface RoomTabStripOptions {
  viewportWidth?: number;
  contentWidth?: number;
  dragThreshold?: number;
}

export interface MouseReleaseResult {
  dragged: boolean;
  activateClick: boolean;
}

export interface RoomTabStripState {
  viewportWidth: number;
  contentWidth: number;
  scrollX: number;
  maxScrollX: number;
  dragging: boolean;
}

export type RoomTabStripEvents = {
  scrollChanged: [number];
  changed: [RoomTabStripState];
};

export class RoomTabStripController extends TypedEmitter<RoomTabStripEvents> {
  viewportWidth: number;
  contentWidth: number;
  scrollX: number = 0;
  readonly dragThreshold: number;
  dragging: boolean = false;

  private _press: Point | null = null;
  private _startScrollX: number = 0;

  constructor(options: RoomTabStripOptions = {}) {
    super();
    this.viewportWidth = Math.max(0, options.viewportWidth ?? 0);
    this.contentWidth = Math.max(0, options.contentWidth ?? 0);
    this.dragThreshold = Math.max(1, options.dragThreshold ?? 10);
  }

  get maxScrollX(): number {
    return Math.max(0, this.contentWidth - this.viewportWidth);
  }

  setMetrics(viewportWidth: number, contentWidth: number): void {
    this.viewportWidth = Math.max(0, viewportWidth);
    this.contentWidth = Math.max(0, contentWidth);
    this.scrollX = this._clampScroll(this.scrollX);
    this.emit("changed", this.snapshot());
  }

  refresh(viewportWidth?: number, contentWidth?: number): void {
    this._press = null;
    this.dragging = false;
    if (viewportWidth !== undefined) {
      this.viewportWidth = Math.max(0, viewportWidth);
    }
    if (contentWidth !== undefined) {
      this.contentWidth = Math.max(0, contentWidth);
    }
    this.scrollX = this._clampScroll(this.scrollX);
    this.emit("changed", this.snapshot());
  }

  setScrollX(value: number): number {
    const clamped = this._clampScroll(Math.round(value));
    if (clamped !== this.scrollX) {
      this.scrollX = clamped;
      this.emit("scrollChanged", clamped);
      this.emit("changed", this.snapshot());
    }
    return this.scrollX;
  }

  /**
   * 滚轮水平滚动（精确还原 RoomTabStrip.eventFilter 的 pixelDelta / angleDelta 换算）。
   */
  onWheel(deltaX: number, deltaY: number, isPixelDelta = true): boolean {
    if (this.maxScrollX <= 0) {
      return false;
    }
    let amount = deltaX || deltaY;
    if (!amount) {
      return false;
    }
    if (!isPixelDelta) {
      amount = amount / 2;
    }
    this.setScrollX(this.scrollX - Math.round(amount));
    return true;
  }

  /**
   * 鼠标左键按下（button === 0）。
   */
  onMousePress(x: number, y: number, button = 0): void {
    if (button !== 0) {
      return;
    }
    this._press = { x, y };
    this._startScrollX = this.scrollX;
    this.dragging = false;
  }

  /**
   * 鼠标移动：横向位移 >= dragThreshold 且横向位移大于纵向位移时进入拖拽滚动，
   * 消费事件并阻止按钮被按住激活。
   */
  onMouseMove(x: number, y: number): boolean {
    if (this._press === null) {
      return false;
    }
    const dx = x - this._press.x;
    const dy = y - this._press.y;
    if (
      this.maxScrollX > 0 &&
      Math.abs(dx) >= this.dragThreshold &&
      Math.abs(dx) > Math.abs(dy)
    ) {
      this.dragging = true;
    }
    if (this.dragging) {
      this.setScrollX(this._startScrollX - dx);
      return true;
    }
    return false;
  }

  /**
   * 鼠标左键释放：若本次手势已触发拖拽滚动，则抑制点击激活（activateClick = false）。
   */
  onMouseRelease(x: number, y: number, button = 0): MouseReleaseResult {
    if (button !== 0) {
      return { dragged: false, activateClick: false };
    }
    // In case release occurs at a new coordinate without an intervening move, apply final drag position if already dragging.
    if (this._press !== null && this.dragging) {
      const dx = x - this._press.x;
      this.setScrollX(this._startScrollX - dx);
    }
    const dragged = this.dragging;
    this._press = null;
    this.dragging = false;
    this.emit("changed", this.snapshot());
    return {
      dragged,
      activateClick: !dragged,
    };
  }

  snapshot(): RoomTabStripState {
    return {
      viewportWidth: this.viewportWidth,
      contentWidth: this.contentWidth,
      scrollX: this.scrollX,
      maxScrollX: this.maxScrollX,
      dragging: this.dragging,
    };
  }

  private _clampScroll(value: number): number {
    return Math.max(0, Math.min(this.maxScrollX, value));
  }
}

// ----------------------------------------------------------------------------
// 房间弹出菜单数据构建（自 app/ui/room_tabs.py: build_room_menu）
// ----------------------------------------------------------------------------

export interface RoomMenuEntry {
  name: string;
  count: number | null;
  selected: boolean;
}

export type RoomMenuInputEntry =
  | readonly [string, number | null]
  | { name: string; count: number | null };

export interface RoomMenuModel {
  entries: RoomMenuEntry[];
  trigger(name: string): boolean;
}

export function roomMenuAccessibleName(entry: RoomMenuEntry): string {
  return entry.count !== null ? `${entry.name}，${entry.count} 台设备` : entry.name;
}

function isTupleEntry(item: RoomMenuInputEntry): item is readonly [string, number | null] {
  return Array.isArray(item);
}

export function buildRoomMenuEntries(
  entries: ReadonlyArray<RoomMenuInputEntry>,
  current: string,
  onSelect: (roomName: string) => void,
): RoomMenuModel {
  const normalized: RoomMenuEntry[] = entries.map((item) => {
    const name = isTupleEntry(item) ? item[0] : item.name;
    const count = isTupleEntry(item) ? item[1] : item.count;
    return {
      name,
      count,
      selected: name === current,
    };
  });

  const validNames = new Set(normalized.map((e) => e.name));

  return {
    entries: normalized,
    trigger(name: string): boolean {
      if (!validNames.has(name)) {
        return false;
      }
      onSelect(name);
      return true;
    },
  };
}

/**
 * 计算当前家庭下各房间选项卡的设备计数（保留离线设备，与 MainWindow._build_room_menu 一致）。
 */
export function computeRoomMenuCounts(
  devices: ReadonlyArray<Pick<DeviceInfo, "home_name" | "room_name">>,
  currentHome: string,
  tabNames: readonly string[],
): Array<[string, number | null]> {
  const inHome = devices.filter((d) => !currentHome || d.home_name === currentHome);
  return tabNames.map((name): [string, number | null] => {
    if (name === "场景") {
      return [name, null];
    }
    if (name === "全屋") {
      return [name, inHome.length];
    }
    return [name, inHome.filter((d) => d.room_name === name).length];
  });
}
