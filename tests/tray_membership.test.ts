// SPDX-License-Identifier: GPL-3.0-or-later
/** Main/tray context menus and editor use one membership and ordering store. */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IJobExecutor, JobSubmitOptions, TrayOrderItem } from "../src/core/contracts.ts";
import { setDataPathOverrides } from "../src/core/jsonStore.ts";
import { createDeviceInfo } from "../src/core/models.ts";
import * as trayStore from "../src/core/trayStore.ts";
import { VirtualLightService } from "../src/core/virtualLightService.ts";
import { DeviceCardController } from "../src/ui/controllers/deviceCardController.ts";
import { MainWindowController } from "../src/ui/controllers/mainWindowController.ts";
import { TrayManagerController } from "../src/ui/controllers/trayManagerController.ts";

class QueueJobs implements IJobExecutor {
  readonly pending: Array<{
    fn: () => unknown | Promise<unknown>;
    options?: JobSubmitOptions<unknown>;
  }> = [];

  submit<T>(fn: () => T | Promise<T>, options?: JobSubmitOptions<T>): void {
    this.pending.push({
      fn,
      options: options as JobSubmitOptions<unknown> | undefined,
    });
  }

  cancelPending(): void {
    this.pending.length = 0;
  }

  shutdown(): void {
    this.pending.length = 0;
  }
}

describe("TrayMembershipTest", () => {
  let tempDir: string;
  let disposables: Array<{ dispose(): void }>;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "mijiadeck-tray-membership-"));
    setDataPathOverrides({
      dataDir: () => tempDir,
      dataFile: (name) => path.join(tempDir, name),
    });
    disposables = [];
  });

  afterEach(() => {
    for (const item of disposables) {
      item.dispose();
    }
    setDataPathOverrides(null);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("membership changes preserve scene snapshots and mixed order", () => {
    const scene = {
      scene_id: "same",
      name: "Scene",
      home_id: "home",
      home_name: "Home",
    };
    trayStore.save(["same", "other"]);
    trayStore.saveScenes([scene]);
    const order: TrayOrderItem[] = [
      { type: "scene", id: "same" },
      { type: "device", id: "same" },
      { type: "device", id: "other" },
    ];
    trayStore.saveOrder(order);

    trayStore.setDeviceSelected("same", true);
    expect(trayStore.loadOrder()).toEqual(order);

    trayStore.removeItem("device", "same");
    expect(trayStore.loadOrder()).toEqual([order[0]!, order[2]!]);
    expect(trayStore.loadScenes()).toEqual([scene]);

    trayStore.setDeviceSelected("same", true);
    expect(trayStore.loadOrder().at(-1)).toEqual({ type: "device", id: "same" });

    trayStore.removeItem("scene", "same");
    expect(trayStore.load()).toContain("same");
    expect(trayStore.loadScenes()).toEqual([]);
  });

  it("right-click add then tray remove updates editor and visible rows", () => {
    const service = new VirtualLightService();
    const jobs = new QueueJobs();
    const light = service.device;
    const router = createDeviceInfo({
      did: "router",
      name: "路由器",
      model: "xiaomi.router.test",
      home_name: "",
      room_name: "",
      online: true,
    });

    const window = new MainWindowController({ service, jobs });
    disposables.push(window);
    window.loggedOut = false;
    window.networkOnline = true;
    window.allDevices = [light, router];
    window.syncAccessUi();

    const quick = window.tray!.quick;
    quick.show();
    const updateSpy = spyOn(window, "updateTrayDevices");

    // Ineligible router returns null menu.
    expect(window.buildDeviceTrayMenu(router.did)).toBeNull();

    // Right-click add on main window.
    const addMenu = window.buildDeviceTrayMenu(light.did);
    expect(addMenu).not.toBeNull();
    expect(addMenu!.label).toBe("添加到托盘窗口");
    addMenu!.trigger();

    expect(trayStore.contains(light.did)).toBe(true);
    expect(quick.rows.length).toBeGreaterThan(0);
    expect(quick.rows[0]!.id).toBe(light.did);

    // Checked ("✓") in TrayManagerController.
    const editor1 = new TrayManagerController(window.allDevices, { scenes: [] });
    disposables.push(editor1);
    const lightRow1 = editor1.deviceRows.find((r) => r.did === light.did);
    expect(lightRow1?.checkText).toBe("✓");
    expect(lightRow1?.checked).toBe(true);

    // Main window context menu now offers remove.
    const mainRemoveMenu = window.buildDeviceTrayMenu(light.did);
    expect(mainRemoveMenu).not.toBeNull();
    expect(mainRemoveMenu!.label).toBe("从托盘窗口移除");

    // Remove from tray quick menu.
    const quickRemoveMenu = quick.buildRemoveMenu("device", light.did);
    expect(quickRemoveMenu[0]?.label).toBe("从托盘窗口移除");
    quickRemoveMenu[0]!.trigger();

    expect(trayStore.contains(light.did)).toBe(false);
    expect(quick.rows).toEqual([]);

    const addAgainMenu = window.buildDeviceTrayMenu(light.did);
    expect(addAgainMenu?.label).toBe("添加到托盘窗口");

    // Editor updated back to "+" and ineligible router absent.
    const editor2 = new TrayManagerController(window.allDevices, { scenes: [] });
    disposables.push(editor2);
    const lightRow2 = editor2.deviceRows.find((r) => r.did === light.did);
    expect(lightRow2?.checkText).toBe("+");
    expect(lightRow2?.checked).toBe(false);
    expect(editor2.deviceRows.find((r) => r.did === "router")).toBeUndefined();
    expect(updateSpy).toHaveBeenCalled();
  });

  it("card right-click requests menu without opening or switching device", () => {
    const card = new DeviceCardController(new VirtualLightService().device);
    disposables.push(card);

    const menu = mock(() => {});
    const opened = mock(() => {});
    const powered = mock(() => {});
    card.on("trayMenuRequested", menu);
    card.on("openRequested", opened);
    card.on("powerClicked", powered);

    const handled = card.contextMenu({ x: 100, y: 100 });
    expect(handled).toBe(true);
    expect(menu).toHaveBeenCalledTimes(1);
    expect(menu).toHaveBeenCalledWith(card.device.did, { x: 100, y: 100 });
    expect(opened).not.toHaveBeenCalled();
    expect(powered).not.toHaveBeenCalled();
  });
});
