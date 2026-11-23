// SPDX-License-Identifier: GPL-3.0-or-later
/** Read-only parent panels, direct light switches and the small light popup. */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { IJobExecutor, JobSubmitOptions, Rect, ScreenInfo } from "../src/core/contracts.ts";
import {
  deviceSubtitle,
  deviceTitle,
  hasDeviceDetails,
  lightControls,
  prepareDeviceCards,
} from "../src/core/deviceControls.ts";
import { setDataPathOverrides } from "../src/core/jsonStore.ts";
import { createDeviceInfo, createPropInfo, type DeviceInfo } from "../src/core/models.ts";
import { ServiceError } from "../src/core/service.ts";
import * as trayStore from "../src/core/trayStore.ts";
import { DEMO_DID, VirtualLightService } from "../src/core/virtualLightService.ts";
import { CameraWindowController } from "../src/ui/controllers/cameraPreviewController.ts";
import { DeviceCardController } from "../src/ui/controllers/deviceCardController.ts";
import { LightControlController } from "../src/ui/controllers/lightControlController.ts";
import { MainWindowController } from "../src/ui/controllers/mainWindowController.ts";
import {
  SHADOW_PAD,
  TrayQuickWindowController,
} from "../src/ui/controllers/trayQuickController.ts";
import { currentTheme, setTheme, SiColors } from "../src/ui/theme.ts";

interface PendingJob {
  fn: () => unknown;
  onSuccess?: (result: unknown) => void;
  onError?: (error: Error) => void;
  priority: number;
}

class Jobs implements IJobExecutor {
  pending: PendingJob[] = [];

  submit<T>(fn: () => T | Promise<T>, options?: JobSubmitOptions<T>): void {
    this.pending.push({
      fn,
      onSuccess: options?.onSuccess as ((result: unknown) => void) | undefined,
      onError: options?.onError,
      priority: options?.priority ?? 10,
    });
  }

  async finish(): Promise<void> {
    const job = this.pending.shift();
    if (!job) {
      throw new Error("No pending job to finish");
    }
    try {
      const result = await job.fn();
      job.onSuccess?.(result);
    } catch (error) {
      job.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async finishAll(): Promise<void> {
    while (this.pending.length > 0) {
      await this.finish();
    }
  }

  cancelPending(): void {
    this.pending.length = 0;
  }

  shutdown(): void {
    this.pending.length = 0;
  }
}

interface Disposable {
  dispose?(): void;
  reject?(): void;
}

describe("DeviceControlsTest", () => {
  let tempDir: string;
  let service: VirtualLightService;
  let jobs: Jobs;
  let cleanups: Disposable[];

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "mijiadeck-device-controls-"));
    setDataPathOverrides({
      dataDir: () => tempDir,
      dataFile: (name: string) => path.join(tempDir, name),
    });
    service = new VirtualLightService();
    jobs = new Jobs();
    cleanups = [];
  });

  afterEach(() => {
    for (const item of cleanups) {
      if (typeof item.reject === "function") {
        item.reject();
      }
      if (typeof item.dispose === "function") {
        item.dispose();
      }
    }
    cleanups = [];
    setDataPathOverrides(null);
    rmSync(tempDir, { recursive: true, force: true });
  });

  function track<T extends Disposable>(item: T): T {
    cleanups.push(item);
    return item;
  }

  function panelDevices(): DeviceInfo[] {
    const parent = createDeviceInfo({
      did: "123",
      name: "吧台",
      model: "xiaomi.switch.w3",
      home_name: "Home",
      room_name: "吧台",
      online: true,
    });
    const children = [2, 3, 4].map((s) =>
      createDeviceInfo({
        did: `123.s${s}`,
        name: `灯${s}`,
        model: parent.model,
        home_name: "Home",
        room_name: "吧台",
        online: true,
      }),
    );
    return prepareDeviceCards([parent, ...children]);
  }

  async function openPopup(): Promise<LightControlController> {
    const dialog = track(new LightControlController(service, jobs, service.device));
    dialog.show();
    dialog.load();
    await jobs.finish(); // supported controls
    await jobs.finish(); // initial values
    return dialog;
  }

  test("light dialog remains centered after async controls load", async () => {
    const screenArea: Rect = { x: 0, y: 0, width: 1920, height: 1040 };
    const parentRect: Rect = {
      x: screenArea.x + 10,
      y: screenArea.y + 10,
      width: screenArea.width - 20,
      height: screenArea.height - 20,
    };
    const dialog = track(
      new LightControlController(service, jobs, service.device, {
        parentRect,
        screenArea,
      }),
    );
    dialog.showCentered(parentRect, screenArea);
    dialog.load();
    const initialHeight = dialog.geometry.height;

    await jobs.finish(); // Dynamic sliders change the dialog height.

    expect(dialog.modal).toBe(true);
    expect(dialog.isWindow).toBe(true);
    expect(dialog.geometry.height).toBeGreaterThan(initialHeight);

    const centerX = parentRect.x + Math.floor(parentRect.width / 2);
    const centerY = parentRect.y + Math.floor(parentRect.height / 2);
    const rawX = centerX - Math.floor(dialog.geometry.width / 2);
    const rawY = centerY - Math.floor(dialog.geometry.height / 2);
    const expectedX = Math.max(
      screenArea.x,
      Math.min(rawX, screenArea.x + screenArea.width - dialog.geometry.width),
    );
    const expectedY = Math.max(
      screenArea.y,
      Math.min(rawY, screenArea.y + screenArea.height - dialog.geometry.height),
    );
    const manhattan =
      Math.abs(dialog.geometry.x - expectedX) + Math.abs(dialog.geometry.y - expectedY);
    expect(manhattan).toBeLessThanOrEqual(3);
    expect(dialog.powerVisible).toBe(true);
    expect(dialog.title).toBe(service.device.name);

    await jobs.finish();
    expect(new Set(Object.keys(dialog.props))).toEqual(
      new Set(["brightness", "temperature", "color"]),
    );
  });

  test("tray light page returns without moving window and stops on signout", async () => {
    const quick = track(new TrayQuickWindowController(service, jobs));
    quick.show();
    const originalGeometry = { ...quick.geometry };

    quick.showLightControls(service.device);
    const pane = quick.lightControl;
    expect(pane).not.toBeNull();
    expect(quick.currentPage).toBe("light");
    expect(pane!.isWindow).toBe(false);
    expect(pane!.embedded).toBe(true);

    quick.hideAfterPointerLeave();
    expect(quick.visible).toBe(true);

    await jobs.finish();
    await jobs.finish();
    expect(quick.geometry).toEqual(originalGeometry);
    expect(pane!.powerVisible).toBe(true);
    expect(pane!.title).toBe(service.device.name);

    pane!.setSliderValue("brightness", 75);
    pane!.commitSlider("brightness");
    await jobs.finish();
    expect(service.values["brightness"]).toBe(75);

    // Return / close button closes embedded light pane
    pane!.reject();
    expect(quick.lightControl).toBeNull();
    expect(quick.overviewPageEnabled).toBe(true);
    expect(quick.overviewPageHidden).toBe(false);
    expect(quick.overviewPageDetached).toBe(false);
    expect(quick.currentPage).toBe("overview");
    expect(quick.geometry).toEqual(originalGeometry);

    // Sign-out stops an open embedded light page immediately
    quick.showLightControls(service.device);
    const pending = quick.lightControl;
    expect(pending).not.toBeNull();
    quick.setAccessState("signed_out");
    expect(quick.lightControl).toBeNull();
    expect(pending!.closed).toBe(true);
    expect(pending!.pollActive).toBe(false);
  });

  test("adjustable lights have LED tag on main and tray cards", () => {
    for (const features of [[], ["brightness"], ["temperature"], ["color"]]) {
      const light = createDeviceInfo({ ...service.device, light_features: features });
      const card = track(new DeviceCardController(light));
      const quick = track(new TrayQuickWindowController(service, jobs));
      const row = quick.makeRow(light);
      expect(card.hasLightCornerTag).toBe(features.length > 0);
      expect(row.hasLightTag).toBe(features.length > 0);
    }
  });

  test("panel card has no power or details even with old cached state", () => {
    const [parent] = panelDevices();
    const card = track(new DeviceCardController(parent!));
    card.setPowerState(true);
    card.setMetrics("24°C");
    card.setPanelStates({ "123.s2": true, "123.s3": false, "123.s4": false });

    expect(deviceTitle(parent!)).toBe("吧台面板");
    expect(card.title).toBe("吧台面板");
    expect(card.subtitle).toContain("设备温度 24°C");
    expect(card.subtitle).toContain("部分开启 · 1 路");
    expect(card.powerButtonVisible).toBe(false);
    expect(card.powerState).toBeNull();

    const opened = mock(() => {});
    card.on("openRequested", opened);
    card.clickCard();
    expect(opened).not.toHaveBeenCalled();
  });

  test("panel unknown temperature is omitted and unknown channel is not off", () => {
    const [parent] = panelDevices();
    const text = deviceSubtitle(parent!, null, { "123.s2": true, "123.s3": false });
    expect(text).not.toContain("温度");
    expect(text).toContain("状态待确认");
  });

  test("split switch and plain light cannot open generic editor", () => {
    const devices = [
      ...panelDevices(),
      createDeviceInfo({
        did: "lamp",
        name: "普通灯",
        model: "test.light.basic",
        home_name: "H",
        room_name: "R",
        online: true,
      }),
    ];
    for (const device of devices) {
      expect(hasDeviceDetails(device)).toBe(false);
      expect(() => new CameraWindowController(service, jobs, device)).toThrow(
        "Only cameras use this preview window",
      );
      const win = track(new MainWindowController({ service, jobs, tray: null }));
      win.allDevices = [device];
      win.loggedOut = false;
      win.openDevice(device.did); // no dialog or cloud call
      expect(win.lightWindows.size).toBe(0);
      expect(win.cameraWindows.size).toBe(0);
      expect(jobs.pending.length).toBe(0);
    }
  });

  test("parent panel can be added to tray as display-only and updates with child power", () => {
    const devices = panelDevices();
    trayStore.save(["123"]);
    const quick = track(new TrayQuickWindowController(service, jobs));
    quick.setDevices(devices, {
      "123": true,
      "123.s2": true,
      "123.s3": false,
      "123.s4": false,
    });
    quick.setMetrics({ "123": "24°C" });
    quick.rebuild();

    const row = quick.rows[0];
    expect(row).toBeDefined();
    expect(row!.id).toBe("123");
    expect(row!.hasPowerBtn).toBe(false);
    expect(row!.cursor).toBe("default");
    expect(row!.clickable).toBe(false);
    expect(row!.subtitle).toContain("设备温度 24°C");
    expect(row!.subtitle).toContain("部分开启 · 1 路");

    quick.applyPower({ "123.s3": true });
    expect(quick.rows[0]!.subtitle).toContain("部分开启 · 2 路");
  });

  test("popup only has everyday controls and no function editor", async () => {
    const dialog = await openPopup();
    expect(new Set(Object.keys(dialog.props))).toEqual(
      new Set(["brightness", "temperature", "color"]),
    );
    expect(dialog.sliders.brightness?.value).toBe(65);
    expect(dialog.sliders.temperature?.previewText).toContain("4000");
    expect(dialog.powerState).toBe(true);
    expect("drawer" in dialog).toBe(false);
    expect("_drawer" in dialog).toBe(false);
  });

  test("sliders preview then write on release and rgb stays in memory", async () => {
    const dialog = await openPopup();
    dialog.setSliderValue("brightness", 80);
    expect(service.values["brightness"]).toBe(65);
    expect(dialog.sliders.brightness?.previewText).toBe("80%");

    dialog.commitSlider("brightness");
    await jobs.finish();
    expect(service.values["brightness"]).toBe(80);
    await jobs.finish(); // Read back the device's actual post-write state.

    dialog.chooseColor(() => 0x3366ff);
    await jobs.finish();
    expect(service.values["color"]).toBe(0x3366ff);
    await jobs.finish();

    dialog.togglePower();
    await jobs.finish();
    expect(service.values["on"]).toBe(false);
    await jobs.finish();

    expect(dialog.sliders.brightness?.enabled).toBe(false);
    dialog.setSliderValue("brightness", 55);
    dialog.commitSlider("brightness");
    expect(jobs.pending.length).toBe(0);
    expect(service.values["brightness"]).toBe(80);
    expect(service.values["on"]).toBe(false); // No implicit power-on command.
  });

  test("adjustments require confirmed power-on and color picker is guarded", async () => {
    service.values["on"] = false;
    const dialog = await openPopup();

    for (const state of [false, null]) {
      dialog.values["on"] = state;
      dialog.render();
      expect(dialog.colorButtonEnabled).toBe(false);
      for (const slider of Object.values(dialog.sliders)) {
        expect(slider?.enabled).toBe(false);
      }
      const picker = mock(() => 0x3366ff);
      dialog.chooseColor(picker);
      expect(picker).not.toHaveBeenCalled();

      for (const [name, value] of [
        ["brightness", 45],
        ["color-temperature", 3000],
        ["color", 0x3366ff],
      ] as const) {
        dialog.write(name, value);
      }
      expect(jobs.pending.length).toBe(0);
    }

    dialog.values["on"] = false;
    dialog.render();
    dialog.togglePower();
    await jobs.finish();
    await jobs.finish();

    expect(dialog.colorButtonEnabled).toBe(true);
    for (const slider of Object.values(dialog.sliders)) {
      expect(slider?.enabled).toBe(true);
    }

    dialog.setSliderValue("brightness", 45);
    dialog.commitSlider("brightness");
    await jobs.finish();
    await jobs.finish();
    expect(service.values["brightness"]).toBe(45);
    expect(dialog.powerText).toBe("已开启");
  });

  test("tray controls hide old page and require power before slider clicks", async () => {
    service.values["on"] = false;
    const screen: ScreenInfo = {
      name: "test-screen",
      availableGeometry: { x: 0, y: 0, width: 2000, height: 1200 },
    };
    const quick = track(
      new TrayQuickWindowController(service, jobs, {
        env: {
          screens: () => [screen],
          primaryScreen: () => screen,
          screenAt: () => screen,
        },
      }),
    );
    quick.show();
    quick.showLightControls(service.device);
    await jobs.finish();
    await jobs.finish();

    const pane = quick.lightControl;
    expect(pane).not.toBeNull();
    expect(quick.overviewPageHidden).toBe(true);
    expect(quick.overviewPageEnabled).toBe(false);
    expect(quick.overviewPageUpdatesEnabled).toBe(false);
    expect(quick.overviewPageDetached).toBe(true);
    expect(pane!.backdrop).not.toBeNull();
    expect(pane!.geometry.width).toBe(quick.size.width - 2 * SHADOW_PAD);
    expect(pane!.geometry.height).toBe(quick.size.height - 2 * SHADOW_PAD);

    // Background device update rebuilds card data without leaking overview page.
    trayStore.setDeviceSelected(service.device.did, true);
    quick.setDevices([service.device], { [service.device.did]: false });
    expect(quick.lightControl).toBe(pane);
    expect(quick.currentPage).toBe("light");
    expect(quick.overviewPageHidden).toBe(true);
    expect(quick.overviewPageEnabled).toBe(false);
    expect(quick.overviewPageUpdatesEnabled).toBe(false);
    expect(quick.overviewPageDetached).toBe(true);

    expect(pane!.isWindow).toBe(false);
    expect(pane!.hasDiagnosticsButton).toBe(false);
    expect(pane!.closeAccessibleName).toBe("返回设备列表");

    // Disabled slider blocks track clicks while power is off
    expect(pane!.sliders.brightness?.enabled).toBe(false);
    pane!.clickSliderTrack("brightness", 98);
    expect(jobs.pending.length).toBe(0);
    expect(service.values["brightness"]).toBe(65);

    // Turn on power, then clicking slider track commits
    pane!.togglePower();
    await jobs.finish();
    await jobs.finish();
    expect(pane!.sliders.brightness?.enabled).toBe(true);
    pane!.clickSliderTrack("brightness", 98);
    await jobs.finish();
    expect(service.values["brightness"]).not.toBe(65);

    // Dragging via embedded light title moves the tray quick window
    const original = { ...quick.position };
    const start = { x: 200, y: 120 };
    expect(quick.beginDrag("light_title", start)).toBe(true);
    expect(quick.updateDrag({ x: start.x + 50, y: start.y + 40 }, true)).toBe(true);
    expect(quick.endDrag()).toBe(true);
    expect(quick.position).toEqual({ x: original.x + 50, y: original.y + 40 });
  });

  test("main light dialog does not resize or move after status and poll updates", async () => {
    const dialog = track(new LightControlController(service, jobs, service.device));
    dialog.showCentered();
    dialog.load();
    await jobs.finish(); // Controls are ready, first value read is still queued.
    const initial = { ...dialog.geometry };

    await jobs.finish();
    expect(dialog.geometry).toEqual(initial);

    for (const value of [94, 100, 55]) {
      service.values["brightness"] = value;
      dialog.refresh();
      await jobs.finish();
      expect(dialog.geometry).toEqual(initial);
    }
  });

  test("overlay isolated with real theme, audio bar, and rebuilt cards", async () => {
    const previousTheme = currentTheme();
    const speaker = createDeviceInfo({
      did: "local-speaker",
      name: "测试音箱",
      model: "xiaomi.wifispeaker.test",
      home_name: "本地测试",
      room_name: "测试房间",
      online: true,
    });
    const devices = [service.device, speaker];
    trayStore.setDeviceSelected(service.device.did, true);

    try {
      for (const theme of ["light", "dark"] as const) {
        setTheme(theme);
        const quick = track(new TrayQuickWindowController(service, jobs));
        quick.setDevices(devices, { [service.device.did]: false });
        quick.show();
        await jobs.finishAll();
        expect(quick.audioBarVisible).toBe(true);

        quick.showLightControls(service.device);
        await jobs.finishAll();
        const pane = quick.lightControl;
        expect(pane).not.toBeNull();

        for (let i = 0; i < 3; i += 1) {
          quick.setDevices(devices, { [service.device.did]: false });
          expect(quick.overviewPageHidden).toBe(true);
          expect(quick.overviewPageDetached).toBe(true);
          expect(quick.overviewPageUpdatesEnabled).toBe(false);
          expect(quick.currentPage).toBe("light");
          expect(quick.lightControl).toBe(pane);
        }

        pane!.reject();
        expect(quick.lightControl).toBeNull();
        expect(quick.overviewPageHidden).toBe(false);
        expect(quick.overviewPageDetached).toBe(false);
        expect(quick.overviewPageUpdatesEnabled).toBe(true);
        expect(quick.overviewPageEnabled).toBe(true);
        expect(quick.currentPage).toBe("overview");
        expect(quick.audioBarVisible).toBe(true);
        quick.hide();
      }
    } finally {
      setTheme(previousTheme);
    }
  });

  test("repeated light close clears overlay state and restores tray surface", async () => {
    const previousTheme = currentTheme();
    try {
      for (const theme of ["light", "dark"] as const) {
        setTheme(theme);
        const quick = track(new TrayQuickWindowController(service, jobs));
        quick.show();
        for (let i = 0; i < 4; i += 1) {
          quick.showLightControls(service.device);
          await jobs.finishAll();
          const pane = quick.lightControl;
          expect(pane).not.toBeNull();
          pane!.reject();
          expect(quick.lightControl).toBeNull();
          expect(pane!.closed).toBe(true);
          expect(pane!.visible).toBe(false);
          expect(quick.currentPage).toBe("overview");
          expect(quick.overviewPageHidden).toBe(false);
          expect(quick.overviewPageDetached).toBe(false);
          expect(quick.overviewPageEnabled).toBe(true);
          expect(SiColors.CARD).toBe(theme === "light" ? "#ffffff" : "#2a2c32");
        }
        quick.hide();
      }
    } finally {
      setTheme(previousTheme);
    }
  });

  test("stale read does not reset slider during drag", async () => {
    const dialog = await openPopup();
    dialog.refresh();
    dialog.setSliderDown("brightness", true);
    dialog.setSliderValue("brightness", 90);
    await jobs.finish();
    expect(dialog.sliders.brightness?.value).toBe(90);
    dialog.setSliderDown("brightness", false);
  });

  test("clicking slider track also commits once", async () => {
    const dialog = await openPopup();
    dialog.clickSliderTrack("brightness", 98);
    expect(jobs.pending.length).toBe(1);
    await jobs.finish();
    expect(service.values["brightness"]).not.toBe(65);
  });

  test("unsupported and readonly properties are not exposed", () => {
    const props = [
      createPropInfo({
        name: "mode",
        desc: "Mode",
        type: "uint",
        readable: true,
        writable: true,
      }),
      createPropInfo({
        name: "brightness",
        desc: "Brightness",
        type: "uint",
        readable: true,
        writable: false,
        range: [1, 100, 1],
      }),
      createPropInfo({
        name: "color",
        desc: "Not RGB",
        type: "uint",
        readable: true,
        writable: true,
        range: [0, 10, 1],
      }),
    ];
    expect(lightControls(props)).toEqual({});
  });

  test("virtual service does not construct account client", async () => {
    expect("api" in service).toBe(false);
    expect("_api" in service).toBe(false);
    expect(service.device.did).toBe(DEMO_DID);
    await expect(service.setPowerState("real-device", true)).rejects.toBeInstanceOf(ServiceError);
  });
});
