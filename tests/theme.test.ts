// SPDX-License-Identifier: GPL-3.0-or-later
/** 浅色/深色主题回归测试。 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IJobExecutor, JobSubmitOptions } from "../src/core/contracts.ts";
import { setDataPathOverrides } from "../src/core/jsonStore.ts";
import { createDeviceInfo, type DeviceInfo } from "../src/core/models.ts";
import * as settingsStore from "../src/core/settingsStore.ts";
import * as trayStore from "../src/core/trayStore.ts";
import { VirtualLightService } from "../src/core/virtualLightService.ts";
import { MainWindowController } from "../src/ui/controllers/mainWindowController.ts";
import { SettingsDialogController } from "../src/ui/controllers/settingsDialogController.ts";
import { TrayManagerController } from "../src/ui/controllers/trayManagerController.ts";
import {
  SiColors,
  applyTheme,
  buildCss,
  currentAccent,
  currentTheme,
  effectiveTheme,
  setAccent,
  setTheme,
} from "../src/ui/theme.ts";

class StubJobs implements IJobExecutor {
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

function makeTestDevices(): DeviceInfo[] {
  return Array.from({ length: 4 }, (_, i) =>
    createDeviceInfo({
      did: String(i),
      name: `设备${i}`,
      model: "a.b.c",
      home_name: "家",
      room_name: "客厅",
      online: i % 2 === 0,
    }),
  );
}

describe("ThemeTest", () => {
  let tempDir = "";
  let windows: MainWindowController[] = [];

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "mijiadeck-theme-test-"));
    const dir = tempDir;
    setDataPathOverrides({
      dataDir: () => dir,
      dataFile: (name) => path.join(dir, name),
    });
    windows = [];
    setAccent("green");
    setTheme("dark");
  });

  afterEach(() => {
    for (const win of windows) {
      win.dispose();
    }
    windows = [];
    setAccent("green");
    setTheme("dark");
    setDataPathOverrides(null);
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = "";
    }
  });

  test("dynamic SiColors palette and CSS generation contain zero unresolved placeholders", () => {
    const darkCss = buildCss();
    expect(darkCss.length).toBeGreaterThan(0);
    expect(darkCss).not.toMatch(/\$[A-Z][A-Z0-9_]*/);
    expect(SiColors.CARD).toBe("#2a2c32");
    expect(SiColors.TITLE_BAR_BG).toBe("#1a1b20");

    setTheme("light");
    expect(SiColors.CARD).toBe("#ffffff");
    expect(SiColors.THEME).toBe("#00cc92");
    expect(SiColors.TITLE_BAR_BG).toBe("#f6f8fb");
    const lightCss = buildCss();
    expect(lightCss).not.toMatch(/\$[A-Z][A-Z0-9_]*/);
    expect(lightCss).not.toContain("{SiColors");
    expect(lightCss).toContain("#ffffff");
    expect(lightCss).toContain("#f6f8fb");
    expect(lightCss).toContain("#00cc92");

    setTheme("dark");
    expect(SiColors.CARD).toBe("#2a2c32");
    expect(SiColors.TITLE_BAR_BG).toBe("#1a1b20");
    expect(buildCss()).not.toMatch(/\$[A-Z][A-Z0-9_]*/);
  });

  test("effectiveTheme resolves system/light/dark and settings store persists mode", () => {
    settingsStore.setThemeMode("system");
    expect(["dark", "light"]).toContain(effectiveTheme("system"));
    expect(effectiveTheme("system", "light")).toBe("light");
    expect(effectiveTheme("system", "dark")).toBe("dark");
    expect(effectiveTheme("light")).toBe("light");
    expect(effectiveTheme("dark")).toBe("dark");
    expect(settingsStore.getThemeMode()).toBe("system");

    settingsStore.setThemeMode("light");
    expect(settingsStore.getThemeMode()).toBe("light");

    settingsStore.setThemeMode("dark");
    expect(settingsStore.getThemeMode()).toBe("dark");
  });

  test("main window switches light/dark palettes and tray retheme recreates visible quick window", () => {
    trayStore.save([]);
    applyTheme("light");

    const service = new VirtualLightService();
    const jobs = new StubJobs();
    const devs = makeTestDevices();
    const win = new MainWindowController({
      service,
      jobs,
      cacheLoader: () => null,
      cacheSaver: () => {},
    });
    windows.push(win);
    win.loggedOut = false;
    win.syncAccessUi();
    win.applyDevices(devs);
    win.show();

    // Light theme title bar & online card background
    expect(currentTheme()).toBe("light");
    expect(SiColors.TITLE_BAR_BG.toUpperCase()).toBe("#F6F8FB");
    const onlineCardLight = win.cards.get("0");
    expect(onlineCardLight).toBeDefined();
    expect(onlineCardLight!.backgroundColor.toUpperCase()).toBe("#FFFFFF");

    // Switch to dark: cards rebuild with dark palette
    win.applyThemeMode("dark");
    expect(currentTheme()).toBe("dark");
    expect(SiColors.TITLE_BAR_BG.toUpperCase()).toBe("#1A1B20");
    const onlineCardDark = win.cards.get("0");
    expect(onlineCardDark).toBeDefined();
    expect(onlineCardDark!.backgroundColor.toUpperCase()).toBe("#2A2C32");

    // Switch back to light
    win.applyThemeMode("light");
    expect(currentTheme()).toBe("light");
    expect(SiColors.TITLE_BAR_BG.toUpperCase()).toBe("#F6F8FB");
    expect(win.cards.get("0")!.backgroundColor.toUpperCase()).toBe("#FFFFFF");

    // Tray full quick-window rebuild via onThemeChanged -> retheme()
    expect(win.tray).not.toBeNull();
    win.tray!.setDevices(devs, {});
    win.tray!.quick.showNearTray();
    expect(win.tray!.quick.visible).toBe(true);
    const oldQuick = win.tray!.quick;

    win.onThemeChanged(currentTheme());
    expect(win.tray!.quick).not.toBe(oldQuick);
    expect(win.tray!.quick.visible).toBe(true);
    expect(["#1E1F24", "#F2F3F5", "#2A2C32", "#FFFFFF", "#F6F8FB"]).toContain(
      SiColors.WINDOW_BG.toUpperCase(),
    );

    win.tray!.hideQuick();
    expect(win.tray!.quick.visible).toBe(false);
  });

  test("SettingsDialogController supports live preview and cancel restores original theme/color without persisting", () => {
    settingsStore.setThemeMode("dark");
    settingsStore.setThemeColor("green");
    applyTheme("dark", "green");

    const service = new VirtualLightService();
    const jobs = new StubJobs();
    const devs = makeTestDevices();
    const win = new MainWindowController({
      service,
      jobs,
      cacheLoader: () => null,
      cacheSaver: () => {},
    });
    windows.push(win);
    win.loggedOut = false;
    win.syncAccessUi();
    win.applyDevices(devs);

    // Window is previewed in light while store stays dark: dialog reads initial value from store
    win.applyThemeMode("light");
    const dlg = new SettingsDialogController({ devices: devs, host: win });
    expect(dlg.snapshot().themeModeLabel).toBe("深色模式");
    expect(dlg.originalThemeMode).toBe("dark");
    expect(dlg.originalThemeColor).toBe("green");

    dlg.selectThemeMode("浅色模式");
    expect(dlg.pendingThemeMode).toBe("light");
    expect(currentTheme()).toBe("light");

    dlg.selectThemeMode("深色模式");
    expect(dlg.pendingThemeMode).toBe("dark");
    expect(currentTheme()).toBe("dark");

    // Live-preview both light mode and blue accent, then cancel
    dlg.selectThemeMode("light");
    dlg.selectThemeColor("blue");
    expect(currentTheme()).toBe("light");
    expect(currentAccent()).toBe("blue");

    let cancelled = false;
    dlg.on("cancelled", () => {
      cancelled = true;
    });
    dlg.cancel();

    expect(cancelled).toBe(true);
    expect(dlg.closed).toBe(true);
    expect(dlg.accepted).toBe(false);
    expect(currentTheme()).toBe("dark");
    expect(currentAccent()).toBe("green");
    expect(settingsStore.getThemeMode()).toBe("dark");
    expect(settingsStore.getThemeColor()).toBe("green");

    // TrayManagerController reject also closes cleanly
    const trayDlg = new TrayManagerController(devs);
    const trayFinishedCodes: number[] = [];
    trayDlg.events.on("finished", (code) => {
      trayFinishedCodes.push(code);
    });
    trayDlg.reject();
    expect(trayDlg.result).toBe("rejected");
    expect(trayFinishedCodes).toEqual([0]);
    trayDlg.dispose();
  });
});
