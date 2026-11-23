// SPDX-License-Identifier: GPL-3.0-or-later
/** Click sequencing and first-run guidance without a tray or cloud account. */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IJobExecutor } from "../src/core/contracts.ts";
import { setDataPathOverrides } from "../src/core/jsonStore.ts";
import { createDeviceInfo, type DeviceInfo } from "../src/core/models.ts";
import * as settingsStore from "../src/core/settingsStore.ts";
import { VirtualLightService } from "../src/core/virtualLightService.ts";
import { MainWindowController } from "../src/ui/controllers/mainWindowController.ts";
import { startWithTrayIntro } from "../src/ui/controllers/trayIntroController.ts";
import {
  TRAY_TOOLTIP,
  TrayController,
  TrayQuickWindowController,
  type TrayActivationReason,
  type TrayMainHost,
} from "../src/ui/controllers/trayQuickController.ts";

class NoopJobs implements IJobExecutor {
  submit(): void {
    // no-op
  }
  cancelPending(): void {
    // no-op
  }
  shutdown(): void {
    // no-op
  }
}

interface ControllerFixture {
  controller: TrayController;
  quick: TrayQuickWindowController;
  main: TrayMainHost & {
    deviceList: DeviceInfo[];
    openLightWindow: ReturnType<typeof mock>;
  };
  now: { value: number };
}

describe("TrayActivationTest", () => {
  let tempDir: string;
  let controllers: TrayController[];
  let mainWindows: MainWindowController[];

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "mijiadeck-tray-activation-"));
    setDataPathOverrides({
      dataDir: () => tempDir,
      dataFile: (name) => path.join(tempDir, name),
    });
    controllers = [];
    mainWindows = [];
  });

  afterEach(() => {
    for (const c of controllers) {
      c.dispose();
    }
    for (const w of mainWindows) {
      w.dispose();
    }
    setDataPathOverrides(null);
    rmSync(tempDir, { recursive: true, force: true });
  });

  function makeController(): ControllerFixture {
    const now = { value: 1000 };
    const openLightWindow = mock((_device: DeviceInfo) => {});
    const main: ControllerFixture["main"] = {
      deviceList: [],
      devices() {
        return this.deviceList;
      },
      show: mock(() => {}),
      showTrayManager: mock(() => {}),
      showSettings: mock(() => {}),
      openLightWindow,
      networkOnline: true,
      loggedOut: false,
      accessState: () => "ready",
    };
    const controller = new TrayController({}, new NoopJobs(), main, {
      nowMs: () => now.value,
      doubleClickIntervalMs: 400,
    });
    controllers.push(controller);
    return { controller, quick: controller.quick, main, now };
  }

  it("single and standalone double-click open popup", () => {
    const reasons: TrayActivationReason[] = ["trigger", "double_click"];
    for (const reason of reasons) {
      const { controller, quick } = makeController();
      const showSpy = spyOn(quick, "showNearTray");
      controller.onActivated(reason);
      expect(showSpy).toHaveBeenCalledTimes(1);
    }
  });

  it("adjustable light opens inside tray without hiding it", () => {
    const { controller, quick, main } = makeController();
    const device = createDeviceInfo({
      did: "light",
      name: "灯泡",
      model: "test.light.color",
      home_name: "",
      room_name: "",
      online: true,
      light_features: ["brightness", "temperature"],
    });
    main.deviceList = [device];
    const showLightSpy = spyOn(quick, "showLightControls");
    const hideSpy = spyOn(quick, "hide");

    controller.onOpenDevice(device.did);

    expect(showLightSpy).toHaveBeenCalledTimes(1);
    expect(showLightSpy).toHaveBeenCalledWith(device);
    expect(hideSpy).not.toHaveBeenCalled();
    expect(main.openLightWindow).not.toHaveBeenCalled();
  });

  it("tray uses native tooltip without hover popup", () => {
    const { controller } = makeController();
    expect(controller.tooltip).toBe("单击图标打开浮窗控制设备");
    expect(controller.tooltip).toBe(TRAY_TOOLTIP);
    expect(controller.hasHoverPopup).toBe(false);
  });

  it("Windows double-click sequence does not toggle twice", () => {
    const { controller, quick, now } = makeController();
    const showSpy = spyOn(quick, "showNearTray");
    const hideSpy = spyOn(quick, "hide");

    const sequence: TrayActivationReason[] = ["trigger", "double_click", "trigger"];
    for (const reason of sequence) {
      controller.onActivated(reason);
      now.value += 50;
    }

    expect(showSpy).toHaveBeenCalledTimes(1);
    expect(hideSpy).not.toHaveBeenCalled();
  });

  it("click visible popup closes it and context click leaves it alone", () => {
    const { controller, quick } = makeController();
    quick.visible = true;
    const hideSpy = spyOn(quick, "hide");

    controller.onActivated("context");
    expect(hideSpy).not.toHaveBeenCalled();

    controller.onActivated("trigger");
    expect(hideSpy).toHaveBeenCalledTimes(1);
  });

  it("first-run shows main and guidance before starting login jobs", () => {
    settingsStore.setStartMinimized(true);
    expect(settingsStore.shouldStartHidden()).toBe(false);

    const window = new MainWindowController({
      service: new VirtualLightService(),
      jobs: new NoopJobs(),
      tray: null,
      initiallyVisible: false,
    });
    mainWindows.push(window);
    window.resize(900, 600);
    window.show();

    const ready = mock(() => {});
    const guide = startWithTrayIntro(ready);
    expect(guide).not.toBeNull();
    expect(guide!.isVisible()).toBe(true);
    expect(window.isVisible()).toBe(true);
    expect(ready).not.toHaveBeenCalled();

    guide!.dismiss();
    expect(guide!.isVisible()).toBe(false);
    expect(guide!.dismissed).toBe(true);
    expect(ready).toHaveBeenCalledTimes(1);
    expect(settingsStore.getTrayIntroSeen()).toBe(true);

    settingsStore.markVersionStarted();
    expect(settingsStore.shouldStartHidden()).toBe(true);

    expect(startWithTrayIntro(ready)).toBeNull();
    expect(ready).toHaveBeenCalledTimes(2);
  });

  it("upgrade shows main once without changing tray start preference", () => {
    settingsStore.setStartMinimized(true);
    settingsStore.setTrayIntroSeen(true);
    // Missing version marker in an existing v1.0.2/v1.1.0 profile.
    expect(settingsStore.shouldStartHidden()).toBe(false);

    settingsStore.markVersionStarted("1.0.2");
    expect(settingsStore.shouldStartHidden()).toBe(false);

    settingsStore.markVersionStarted();
    expect(settingsStore.shouldStartHidden()).toBe(true);
    expect(settingsStore.getStartMinimized()).toBe(true);
  });
});
