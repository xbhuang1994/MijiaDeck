// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/** 托盘项目管理对话框控制器：设备/场景勾选加入 + 房间筛选 + 统一排序页拖拽排序。 */

import {
  TypedEmitter,
  type IJobExecutor,
  type TrayOrderItem,
  type TraySceneSnapshot,
} from "../../core/contracts.ts";
import { deviceTitle, trayEligible } from "../../core/deviceControls.ts";
import { SCENES_FEATURE_ENABLED } from "../../core/featureFlags.ts";
import type { DeviceInfo, SceneInfo } from "../../core/models.ts";
import * as settingsStore from "../../core/settingsStore.ts";
import * as trayStore from "../../core/trayStore.ts";

export const UNASSIGNED_ROOM = "未分配房间";
export const ALL_ROOMS_LABEL = "全部房间";

export interface TrayManagerDeviceRow {
  did: string;
  label: string;
  room: string;
  online: boolean;
  checked: boolean;
  checkText: "✓" | "+";
  visible: boolean;
}

export interface TrayManagerSceneRow {
  sceneId: string;
  label: string;
  checked: boolean;
  checkText: "✓" | "+";
}

export interface TrayManagerSortRow {
  type: "device" | "scene";
  id: string;
  label: string;
  online: boolean;
}

export interface TrayRoomOption {
  room: string | null;
  label: string;
  checked: boolean;
  trigger(): void;
}

export interface TraySceneStatus {
  title: string;
  detail: string;
}

export interface TrayManagerOptions {
  scenes?: SceneInfo[] | null;
  sceneLoader?: (() => SceneInfo[] | Promise<SceneInfo[]>) | null;
  jobs?: IJobExecutor | null;
}

export interface TrayManagerEvents {
  [key: string]: unknown[];
  accepted: [];
  rejected: [];
  finished: [result: number];
  stateChanged: [];
}

function lexCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function itemKey(item: TrayOrderItem): string {
  return `${item.type}:${item.id}`;
}

/**
 * 托盘快捷项管理控制器：设备与场景双选项卡，房间筛选，拖拽排序 + 勾选加入。
 */
export class TrayManagerController {
  readonly events = new TypedEmitter<TrayManagerEvents>();
  readonly title = "编辑卡片";
  readonly tabLabels: readonly string[] = SCENES_FEATURE_ENABLED ? ["设备", "场景"] : ["设备"];

  devices: DeviceInfo[];
  currentRoom: string | null = null;
  roomNames: string[];
  deviceRooms: Record<string, string> = {};
  deviceRows: TrayManagerDeviceRow[] = [];
  sceneRows: TrayManagerSceneRow[] = [];
  sortRows: TrayManagerSortRow[] = [];

  activeTab: 0 | 1 = 0;
  view: "list" | "sort" = "list";
  tabsVisible = true;
  deviceListVisible = true;
  sceneListVisible = false;
  sortListVisible = false;
  roomFilterVisible = true;
  roomButtonText = ALL_ROOMS_LABEL;
  roomButtonTooltip = "按房间筛选设备";
  sortButtonText = "排序";
  subtitleText = "勾选加入托盘快捷窗口";
  deviceScrollTop = 0;
  sceneStatus: TraySceneStatus | null = null;
  sortEmptyText: string | null = null;
  sceneLoading = false;
  sceneFilled = false;
  result: "accepted" | "rejected" | null = null;

  private scenes: SceneInfo[] | null;
  private readonly sceneLoader: (() => SceneInfo[] | Promise<SceneInfo[]>) | null;
  private readonly jobs: IJobExecutor | null;
  private sceneMap = new Map<string, SceneInfo>();
  private order: TrayOrderItem[];
  private snapMap = new Map<string, TraySceneSnapshot>();
  private disposed = false;

  constructor(devices: DeviceInfo[], options: TrayManagerOptions = {}) {
    const eligible = devices.filter((device) => trayEligible(device));
    this.devices = [...eligible];

    const roomSet = new Set<string>();
    for (const d of this.devices) {
      const room = d.room_name || UNASSIGNED_ROOM;
      this.deviceRooms[d.did] = room;
      roomSet.add(room);
    }
    this.roomNames = [...roomSet].sort(lexCompare);

    this.scenes = SCENES_FEATURE_ENABLED && options.scenes !== undefined ? options.scenes : [];
    this.sceneLoader = SCENES_FEATURE_ENABLED ? (options.sceneLoader ?? null) : null;
    this.jobs = options.jobs ?? null;

    this.order = SCENES_FEATURE_ENABLED
      ? trayStore.loadOrder()
      : trayStore.loadOrder().filter((item) => item.type !== "scene");
    if (SCENES_FEATURE_ENABLED) {
      for (const snap of trayStore.loadScenes()) {
        this.snapMap.set(snap.scene_id, snap);
      }
    }

    const selected = trayStore.load();
    const selSet = new Set<string>(selected);
    const devMap = new Map<string, DeviceInfo>(this.devices.map((d) => [d.did, d]));

    // 已选设备按 tray_store 顺序排列，未选设备在线优先+按名排序追加
    const ordered: DeviceInfo[] = [];
    for (const did of selected) {
      const dev = devMap.get(did);
      if (dev) {
        ordered.push(dev);
      }
    }
    const unordered = this.devices
      .filter((d) => !selSet.has(d.did))
      .sort((a, b) => {
        const onlineDiff = (a.online ? 0 : 1) - (b.online ? 0 : 1);
        if (onlineDiff !== 0) return onlineDiff;
        return lexCompare(a.name, b.name);
      });

    for (const dev of [...ordered, ...unordered]) {
      const checked = selSet.has(dev.did);
      this.deviceRows.push({
        did: dev.did,
        label: `${deviceTitle(dev)}  ·  ${dev.room_name}`,
        room: this.deviceRooms[dev.did],
        online: dev.online,
        checked,
        checkText: checked ? "✓" : "+",
        visible: true,
      });
    }
  }

  // ---------- 房间筛选 ----------

  buildRoomMenu(): TrayRoomOption[] {
    const rooms: Array<string | null> = [null, ...this.roomNames];
    return rooms.map((room) => ({
      room,
      label: room !== null ? room : ALL_ROOMS_LABEL,
      checked: room === this.currentRoom,
      trigger: () => this.setRoomFilter(room),
    }));
  }

  setRoomFilter(room: string | null): void {
    if (room !== null && !this.roomNames.includes(room)) {
      return;
    }
    this.currentRoom = room;
    this.roomButtonText = room !== null ? room : ALL_ROOMS_LABEL;
    this.roomButtonTooltip = `按房间筛选设备 · ${room ?? ALL_ROOMS_LABEL}`;
    for (const row of this.deviceRows) {
      row.visible = room === null || row.room === room;
    }
    this.deviceScrollTop = 0;
    this.emitStateChanged();
  }

  visibleDeviceIds(): string[] {
    return this.deviceRows.filter((r) => r.visible).map((r) => r.did);
  }

  // ---------- 勾选交互 ----------

  toggleDevice(did: string, checked?: boolean): void {
    const row = this.deviceRows.find((r) => r.did === did);
    if (!row) {
      return;
    }
    row.checked = checked !== undefined ? checked : !row.checked;
    row.checkText = row.checked ? "✓" : "+";
    this.emitStateChanged();
  }

  isDeviceChecked(did: string): boolean {
    return this.deviceRows.find((r) => r.did === did)?.checked ?? false;
  }

  toggleScene(sceneId: string, checked?: boolean): void {
    const row = this.sceneRows.find((r) => r.sceneId === sceneId);
    if (!row) {
      return;
    }
    row.checked = checked !== undefined ? checked : !row.checked;
    row.checkText = row.checked ? "✓" : "+";
    this.emitStateChanged();
  }

  isSceneChecked(sceneId: string): boolean {
    return this.sceneRows.find((r) => r.sceneId === sceneId)?.checked ?? false;
  }

  // ---------- 选项卡与视图切换 ----------

  switchTab(index: 0 | 1): void {
    const nextTab: 0 | 1 = SCENES_FEATURE_ENABLED ? index : 0;
    this.activeTab = nextTab;
    const isDev = nextTab === 0;
    const isList = this.view === "list";
    this.deviceListVisible = isDev && isList;
    this.sceneListVisible = SCENES_FEATURE_ENABLED && !isDev && isList;
    this.roomFilterVisible = isDev && isList;
    this.updateSubtitle();
    if (SCENES_FEATURE_ENABLED && !isDev) {
      this.ensureScenes();
    }
    this.emitStateChanged();
  }

  toggleSortView(): void {
    this.switchView(this.view === "sort" ? "list" : "sort");
  }

  switchView(view: "list" | "sort"): void {
    this.view = view;
    const isList = view === "list";
    const isDev = this.activeTab === 0;
    this.tabsVisible = isList;
    this.deviceListVisible = isList && isDev;
    this.sceneListVisible = isList && !isDev;
    this.sortListVisible = !isList;
    this.roomFilterVisible = isList && isDev;
    if (isList) {
      this.sortButtonText = "排序";
    } else {
      this.sortButtonText = "返回";
      this.rebuildSortView();
    }
    this.updateSubtitle();
    this.emitStateChanged();
  }

  private updateSubtitle(): void {
    if (this.view === "sort") {
      this.subtitleText = "长按拖拽调整托盘项目的显示顺序";
    } else if (this.activeTab === 1) {
      this.subtitleText = "勾选加入托盘快捷窗口，点击行内按钮可立即执行场景";
    } else {
      this.subtitleText = "勾选加入托盘快捷窗口";
    }
  }

  // ---------- 场景页加载 ----------

  private ensureScenes(): void {
    if (!settingsStore.getShowSceneTab()) {
      this.fillSceneStatus(
        "场景功能未开启",
        "请先在 设置 → 主题界面 中开启「显示场景选项卡」，再回到此处添加场景",
      );
      return;
    }
    if (this.scenes !== null) {
      if (!this.sceneFilled) {
        this.fillSceneList();
      }
      return;
    }
    if (this.sceneLoading) {
      this.fillSceneStatus("正在加载场景…", "");
      return;
    }
    if (this.sceneLoader === null || this.jobs === null) {
      this.fillSceneStatus("场景数据不可用", "");
      return;
    }
    this.sceneLoading = true;
    this.fillSceneStatus("正在加载场景…", "");
    this.jobs.submit(this.sceneLoader, {
      onSuccess: (scenes) => this.onScenesLoaded(scenes),
      onError: (err) => this.onScenesFailed(err),
    });
  }

  private onScenesLoaded(scenes: SceneInfo[]): void {
    if (this.disposed) return;
    this.sceneLoading = false;
    this.scenes = scenes;
    if (this.view === "sort") {
      // 排序页开着：用最新场景名刷新行（快照名可能已过期）
      this.rebuildSortView();
    }
    if (this.activeTab === 1) {
      this.fillSceneList();
    }
    this.emitStateChanged();
  }

  private onScenesFailed(error: Error): void {
    if (this.disposed) return;
    this.sceneLoading = false;
    if (this.activeTab === 1) {
      this.fillSceneStatus("场景加载失败", error.message);
    }
    this.emitStateChanged();
  }

  private clearSceneLayout(): void {
    this.sceneRows = [];
    this.sceneMap.clear();
  }

  private fillSceneStatus(title: string, detail: string): void {
    this.clearSceneLayout();
    this.sceneStatus = { title, detail };
  }

  private fillSceneList(): void {
    this.clearSceneLayout();
    const scenes = this.scenes ?? [];
    if (scenes.length === 0) {
      // 服务端已确认无场景：置已填充，保存时按空列表清掉失效快照
      this.sceneFilled = true;
      this.fillSceneStatus("暂无场景", "可在米家 APP「智能」中创建手动场景后再回来添加");
      return;
    }
    this.sceneFilled = true;
    this.sceneStatus = null;
    for (const s of scenes) {
      this.sceneMap.set(s.scene_id, s);
    }
    // 已选场景按存储顺序排列，未选按名排序追加（同设备页规则）
    const savedIds = trayStore.loadScenes().map((s) => s.scene_id);
    const savedSet = new Set<string>(savedIds);
    const ordered: SceneInfo[] = [];
    for (const sid of savedIds) {
      const s = this.sceneMap.get(sid);
      if (s) {
        ordered.push(s);
      }
    }
    const unordered = scenes
      .filter((s) => !savedSet.has(s.scene_id))
      .sort((a, b) => lexCompare(a.name, b.name));

    for (const scene of [...ordered, ...unordered]) {
      const checked = savedSet.has(scene.scene_id);
      this.sceneRows.push({
        sceneId: scene.scene_id,
        label: scene.home_name ? `${scene.name}  ·  ${scene.home_name}` : scene.name,
        checked,
        checkText: checked ? "✓" : "+",
      });
    }
  }

  // ---------- 排序页与拖拽重排 ----------

  checkedItems(): TrayOrderItem[] {
    const items: TrayOrderItem[] = [];
    for (const row of this.deviceRows) {
      if (row.checked) {
        items.push({ type: "device", id: row.did });
      }
    }
    if (!SCENES_FEATURE_ENABLED) {
      return items;
    }
    if (this.sceneFilled) {
      for (const row of this.sceneRows) {
        if (row.checked) {
          items.push({ type: "scene", id: row.sceneId });
        }
      }
    } else {
      // 场景页没呈现过确认列表：已存快照就是当前勾选
      for (const s of trayStore.loadScenes()) {
        items.push({ type: "scene", id: s.scene_id });
      }
    }
    return items;
  }

  rebuildSortView(): void {
    this.sortRows = [];
    const checked = this.checkedItems();
    const keys = new Set<string>(checked.map(itemKey));
    const filtered = this.order.filter((it) => keys.has(itemKey(it)));
    const seen = new Set<string>(filtered.map(itemKey));
    // 新勾选但还没进过 order 的项目追加到末尾
    for (const it of checked) {
      if (!seen.has(itemKey(it))) {
        filtered.push(it);
        seen.add(itemKey(it));
      }
    }
    this.order = filtered;

    if (filtered.length === 0) {
      this.sortEmptyText = SCENES_FEATURE_ENABLED
        ? "暂无已加入托盘的项目\n先在设备或场景页勾选添加"
        : "暂无已加入托盘的设备\n先在设备页勾选添加";
      return;
    }
    this.sortEmptyText = null;

    const devMap = new Map<string, DeviceInfo>(this.devices.map((d) => [d.did, d]));
    for (const item of filtered) {
      const row = this.makeSortRow(item, devMap);
      if (row !== null) {
        this.sortRows.push(row);
      }
    }
  }

  private makeSortRow(item: TrayOrderItem, devMap: Map<string, DeviceInfo>): TrayManagerSortRow | null {
    if (item.type === "device") {
      const dev = devMap.get(item.id);
      if (!dev) {
        return null;
      }
      return {
        type: "device",
        id: item.id,
        label: `${deviceTitle(dev)}  ·  ${dev.room_name}`,
        online: dev.online,
      };
    }

    // 最新场景名优先，未加载时回退已存快照（快照保证离线可显示）
    const scene = (this.scenes ?? []).find((s) => s.scene_id === item.id) ?? null;
    const snap = this.snapMap.get(item.id) ?? null;
    if (scene === null && snap === null) {
      return null;
    }
    const label =
      scene !== null
        ? scene.home_name
          ? `${scene.name}  ·  ${scene.home_name}`
          : scene.name
        : snap!.home_name
          ? `${snap!.name}  ·  ${snap!.home_name}`
          : snap!.name;
    return {
      type: "scene",
      id: item.id,
      label,
      online: true,
    };
  }

  sortLayoutIds(): string[] {
    return this.sortRows.map((r) => r.id);
  }

  private syncOrderFromLayout(): void {
    const pos = new Map<string, number>();
    this.sortRows.forEach((row, idx) => {
      pos.set(itemKey({ type: row.type, id: row.id }), idx);
      if (!pos.has(row.id)) {
        pos.set(row.id, idx);
      }
    });
    const fallback = this.sortRows.length;
    this.order.sort((a, b) => {
      const pa = pos.get(itemKey(a)) ?? pos.get(a.id) ?? fallback;
      const pb = pos.get(itemKey(b)) ?? pos.get(b.id) ?? fallback;
      return pa - pb;
    });
  }

  reorderItem(dragId: string, targetId: string | null, after = false): void {
    if (this.sortRows.length === 0) {
      this.rebuildSortView();
    }
    const srcIdx = this.sortRows.findIndex((r) => r.id === dragId);
    if (srcIdx < 0) {
      return;
    }
    if (targetId === dragId) {
      // 原地放下：保持原位不动
      return;
    }
    // 先移除源行再取目标索引：移除会让后续条目前移
    const [srcRow] = this.sortRows.splice(srcIdx, 1);
    if (targetId === null) {
      this.sortRows.push(srcRow);
      this.syncOrderFromLayout();
      this.emitStateChanged();
      return;
    }
    let dstIdx = this.sortRows.findIndex((r) => r.id === targetId);
    if (dstIdx < 0) {
      // 目标不存在则还原
      this.sortRows.splice(srcIdx, 0, srcRow);
      return;
    }
    if (after) {
      dstIdx += 1;
    }
    this.sortRows.splice(dstIdx, 0, srcRow);
    this.syncOrderFromLayout();
    this.emitStateChanged();
  }

  selectedOrder(): TrayOrderItem[] {
    if (this.sortRows.length > 0) {
      this.syncOrderFromLayout();
    }
    const checked = this.checkedItems();
    const keys = new Set<string>(checked.map(itemKey));
    const order = this.order.filter((it) => keys.has(itemKey(it))).map((it) => ({ ...it }));
    const seen = new Set<string>(order.map(itemKey));
    for (const it of checked) {
      if (!seen.has(itemKey(it))) {
        order.push({ ...it });
        seen.add(itemKey(it));
      }
    }
    return order;
  }

  selectedDeviceIds(): string[] {
    return this.selectedOrder()
      .filter((item) => item.type === "device")
      .map((item) => item.id);
  }

  selectedSceneData(): TraySceneSnapshot[] {
    if (!SCENES_FEATURE_ENABLED) {
      return [];
    }
    // 场景页未呈现过确认列表（未开启 / 加载中 / 加载失败）时返回已存快照原值
    if (!this.sceneFilled) {
      return trayStore.loadScenes();
    }
    const result: TraySceneSnapshot[] = [];
    for (const row of this.sceneRows) {
      if (!row.checked) continue;
      const scene = this.sceneMap.get(row.sceneId);
      if (scene) {
        result.push({
          scene_id: scene.scene_id,
          name: scene.name,
          home_id: scene.home_id,
          home_name: scene.home_name,
        });
      }
    }
    return result;
  }

  accept(): void {
    this.result = "accepted";
    this.events.emit("accepted");
    this.events.emit("finished", 1);
  }

  reject(): void {
    this.result = "rejected";
    this.events.emit("rejected");
    this.events.emit("finished", 0);
  }

  dispose(): void {
    this.disposed = true;
  }

  private emitStateChanged(): void {
    this.events.emit("stateChanged");
  }
}
