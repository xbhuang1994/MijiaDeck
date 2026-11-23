// SPDX-License-Identifier: GPL-3.0-or-later
/** Tray settings restores its owner before opening the main settings layer. */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IJobExecutor } from "../src/core/contracts.ts";
import { setDataPathOverrides } from "../src/core/jsonStore.ts";
import type { DeviceInfo } from "../src/core/models.ts";
import {
  TrayController,
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

class MainHost implements TrayMainHost {
  visible = false;
  minimized = false;
  raised = 0;
  activated = 0;
  readonly settingsCalls: Array<[visible: boolean, minimized: boolean]> = [];

  devices(): DeviceInfo[] {
    return [];
  }

  isMinimized(): boolean {
    return this.minimized;
  }

  show(): void {
    this.visible = true;
    this.minimized = false;
  }

  showMinimized(): void {
    this.visible = true;
    this.minimized = true;
  }

  showNormal(): void {
    this.visible = true;
    this.minimized = false;
  }

  raise(): void {
    this.raised += 1;
  }

  activateWindow(): void {
    this.activated += 1;
  }

  showTrayManager(): void {
    // no-op
  }

  showSettings(): void {
    this.settingsCalls.push([this.visible, this.minimized]);
  }
}

describe("TraySettingsTest", () => {
  let tempDir: string;
  let controllers: TrayController[];

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "mijiadeck-tray-settings-"));
    setDataPathOverrides({
      dataDir: () => tempDir,
      dataFile: (name) => path.join(tempDir, name),
    });
    controllers = [];
  });

  afterEach(() => {
    for (const c of controllers) {
      c.dispose();
    }
    setDataPathOverrides(null);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("hidden and minimized main windows are restored before showSettings runs on next tick", async () => {
    for (const minimized of [false, true]) {
      const main = new MainHost();
      if (minimized) {
        main.showMinimized();
      }
      const controller = new TrayController({}, new NoopJobs(), main);
      controllers.push(controller);
      controller.quick.show();
      const hideSpy = spyOn(controller.quick, "hide");

      controller.onSettings();

      expect(hideSpy).toHaveBeenCalledTimes(1);
      expect(controller.quick.visible).toBe(false);
      expect(main.visible).toBe(true);
      expect(main.minimized).toBe(false);
      expect(main.raised).toBe(1);
      expect(main.activated).toBe(1);
      expect(main.settingsCalls).toEqual([]);

      await new Promise<void>((resolve) => setTimeout(resolve, 15));
      expect(main.settingsCalls).toEqual([[true, false]]);
    }
  });
});
