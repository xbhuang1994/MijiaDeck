// SPDX-License-Identifier: GPL-3.0-or-later
/** Room filtering must preserve selections, scenes and the global sort order. */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setDataPathOverrides } from "../src/core/jsonStore.ts";
import { createDeviceInfo, createSceneInfo } from "../src/core/models.ts";
import * as settingsStore from "../src/core/settingsStore.ts";
import * as trayStore from "../src/core/trayStore.ts";
import {
  ALL_ROOMS_LABEL,
  TrayManagerController,
  UNASSIGNED_ROOM,
} from "../src/ui/controllers/trayManagerController.ts";

describe("TrayRoomFilterTest", () => {
  let tempDir: string;
  let dialog: TrayManagerController;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "mijiadeck-tray-room-filter-"));
    setDataPathOverrides({
      dataDir: () => tempDir,
      dataFile: (name) => path.join(tempDir, name),
    });

    trayStore.save(["office"]);
    trayStore.saveOrder([]);
    trayStore.saveScenes([
      { scene_id: "scene", name: "回家", home_id: "home", home_name: "家" },
    ]);
    settingsStore.setShowSceneTab(true);

    const devices = [
      createDeviceInfo({
        did: "office",
        name: "办公室灯",
        model: "light",
        home_name: "家",
        room_name: "办公室",
        online: true,
      }),
      createDeviceInfo({
        did: "bed",
        name: "卧室灯",
        model: "light",
        home_name: "家",
        room_name: "卧室",
        online: false,
      }),
      createDeviceInfo({
        did: "none",
        name: "插座",
        model: "plug",
        home_name: "家",
        room_name: "",
        online: true,
      }),
    ];
    dialog = new TrayManagerController(devices, {
      scenes: [
        createSceneInfo({
          scene_id: "scene",
          name: "回家",
          home_id: "home",
          home_name: "家",
        }),
      ],
    });
  });

  afterEach(() => {
    dialog.dispose();
    setDataPathOverrides(null);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("room menu includes 全部房间 first, 4 total options including 未分配房间, and filters unassigned device", () => {
    const actions = dialog.buildRoomMenu();
    expect(actions[0]?.label).toBe("全部房间");
    expect(actions[0]?.label).toBe(ALL_ROOMS_LABEL);
    expect(actions.length).toBe(4);

    const unassigned = actions.find((a) => a.label === "未分配房间");
    expect(unassigned).toBeDefined();
    expect(unassigned!.label).toBe(UNASSIGNED_ROOM);
    unassigned!.trigger();

    expect(new Set(dialog.visibleDeviceIds())).toEqual(new Set(["none"]));
  });

  it("switching rooms keeps checked devices intact and excludes disabled scenes from selectedOrder", () => {
    dialog.setRoomFilter("卧室");
    expect(dialog.deviceRows.find((r) => r.did === "office")?.visible).toBe(false);
    expect(dialog.isDeviceChecked("office")).toBe(true);

    dialog.toggleDevice("bed");
    dialog.setRoomFilter("办公室");

    const selected = new Set(dialog.selectedOrder().map((item) => `${item.type}:${item.id}`));
    expect(selected).toEqual(new Set(["device:office", "device:bed"]));

    dialog.setRoomFilter(null);
    expect(dialog.deviceRows.every((r) => r.visible)).toBe(true);
  });

  it("tabs hide scenes while disabled and sort preserves room filter and restores on devices list", () => {
    dialog.toggleDevice("bed");
    dialog.setRoomFilter("办公室");

    dialog.switchTab(1);
    expect(dialog.tabLabels).toEqual(["设备"]);
    expect(dialog.activeTab).toBe(0);
    expect(dialog.roomFilterVisible).toBe(true);
    expect(dialog.selectedSceneData()).toEqual([]);

    dialog.switchView("sort");
    expect(new Set(dialog.sortLayoutIds())).toEqual(new Set(["office", "bed"]));
    expect(dialog.roomFilterVisible).toBe(false);

    dialog.switchView("list");
    dialog.switchTab(0);
    expect(dialog.roomFilterVisible).toBe(true);
    expect(dialog.currentRoom).toBe("办公室");
    expect(dialog.isDeviceChecked("bed")).toBe(true);
    expect(dialog.visibleDeviceIds()).toEqual(["office"]);
  });
});
