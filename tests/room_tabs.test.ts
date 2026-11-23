// SPDX-License-Identifier: GPL-3.0-or-later
/** Room tab strip drag vs click, popup room menu counts, and per-home room counting with offline devices. */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IJobExecutor } from "../src/core/contracts.ts";
import { setDataPathOverrides } from "../src/core/jsonStore.ts";
import { createDeviceInfo } from "../src/core/models.ts";
import { VirtualLightService } from "../src/core/virtualLightService.ts";
import { MainWindowController } from "../src/ui/controllers/mainWindowController.ts";
import {
  RoomTabStripController,
  buildRoomMenuEntries,
  computeRoomMenuCounts,
  roomMenuAccessibleName,
} from "../src/ui/controllers/roomTabsController.ts";
import { setAccent, setTheme } from "../src/ui/theme.ts";

class NoopJobs implements IJobExecutor {
  submit(): void {
    // no-op for synchronous layout test
  }
  cancelPending(): void {}
  shutdown(): void {}
}

describe("RoomTabsTest", () => {
  let tempDir = "";

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "mijiadeck-room-tabs-test-"));
    const dir = tempDir;
    setDataPathOverrides({
      dataDir: () => dir,
      dataFile: (name) => path.join(dir, name),
    });
    setAccent("green");
    setTheme("dark");
  });

  afterEach(() => {
    setAccent("green");
    setTheme("dark");
    setDataPathOverrides(null);
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = "";
    }
  });

  test("drag scrolls horizontally without activating room and plain click still activates room", () => {
    const strip = new RoomTabStripController({
      viewportWidth: 300,
      contentWidth: 12 * 90,
    });
    strip.refresh();
    expect(strip.maxScrollX).toBeGreaterThan(0);

    const clicks: number[] = [];

    // Drag gesture on button 1: press at (60, 24), move to (10, 24), release at (10, 24)
    strip.onMousePress(60, 24);
    const consumed = strip.onMouseMove(10, 24);
    expect(consumed).toBe(true);
    const dragResult = strip.onMouseRelease(10, 24);
    if (dragResult.activateClick) {
      clicks.push(1);
    }
    expect(dragResult.dragged).toBe(true);
    expect(dragResult.activateClick).toBe(false);
    expect(strip.scrollX).toBeGreaterThan(0);
    expect(clicks).toEqual([]);

    // Plain click on button 1 without drag
    strip.onMousePress(60, 24);
    const clickResult = strip.onMouseRelease(60, 24);
    if (clickResult.activateClick) {
      clicks.push(1);
    }
    expect(clickResult.dragged).toBe(false);
    expect(clickResult.activateClick).toBe(true);
    expect(clicks).toEqual([1]);
  });

  test("room popup keeps counts and selects the clicked room", () => {
    const selected: string[] = [];
    const menu = buildRoomMenuEntries(
      [
        ["场景", null],
        ["全屋", 29],
        ["办公室", 8],
      ],
      "全屋",
      (room) => selected.push(room),
    );

    expect(menu.entries.map((entry) => [entry.name, entry.count])).toEqual([
      ["场景", null],
      ["全屋", 29],
      ["办公室", 8],
    ]);
    expect(menu.entries[1]!.selected).toBe(true);
    expect(menu.entries[2]!.selected).toBe(false);
    expect(roomMenuAccessibleName(menu.entries[0]!)).toBe("场景");
    expect(roomMenuAccessibleName(menu.entries[1]!)).toBe("全屋，29 台设备");

    expect(menu.trigger("办公室")).toBe(true);
    expect(selected).toEqual(["办公室"]);
  });

  test("room counts follow current home and include offline devices", () => {
    const devices = [
      createDeviceInfo({
        did: "d1",
        name: "设备1",
        model: "m.1",
        home_name: "家一",
        room_name: "办公室",
        online: true,
      }),
      createDeviceInfo({
        did: "d2",
        name: "设备2",
        model: "m.2",
        home_name: "家一",
        room_name: "办公室",
        online: false,
      }),
      createDeviceInfo({
        did: "d3",
        name: "设备3",
        model: "m.3",
        home_name: "家一",
        room_name: "客厅",
        online: true,
      }),
      createDeviceInfo({
        did: "d4",
        name: "设备4",
        model: "m.4",
        home_name: "家二",
        room_name: "办公室",
        online: true,
      }),
    ];

    const tabNames = ["场景", "全屋", "办公室", "客厅"];
    const expected: Array<[string, number | null]> = [
      ["场景", null],
      ["全屋", 3],
      ["办公室", 2],
      ["客厅", 1],
    ];

    expect(computeRoomMenuCounts(devices, "家一", tabNames)).toEqual(expected);

    const win = new MainWindowController({
      service: new VirtualLightService(),
      jobs: new NoopJobs(),
      tray: null,
      cacheLoader: () => null,
      cacheSaver: () => {},
    });
    try {
      win.loggedOut = false;
      win.allDevices = devices;
      win.currentHome = "家一";
      win.currentRoom = "全屋";
      win.tabNames = tabNames;

      const menu = win.buildRoomMenu();
      expect(menu.entries.map((entry) => [entry.name, entry.count])).toEqual(expected);
      menu.trigger("办公室");
      expect(win.currentRoom).toBe("办公室");
    } finally {
      win.dispose();
    }
  });
});
