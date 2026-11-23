// SPDX-License-Identifier: GPL-3.0-or-later
/** Persistent tray placement and time to reach a popup away from the tray. */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IJobExecutor, ScreenInfo } from "../src/core/contracts.ts";
import { setDataPathOverrides } from "../src/core/jsonStore.ts";
import * as settingsStore from "../src/core/settingsStore.ts";
import type { AudioBarTimers } from "../src/ui/controllers/audioBarController.ts";
import {
  SHADOW_PAD,
  TrayQuickWindowController,
  type DragSurface,
  type TrayQuickWindowOptions,
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

interface ScheduledTimer {
  id: number;
  kind: "timeout" | "interval";
  delayMs: number;
  nextRunMs: number;
  fn: () => void;
  cancelled: boolean;
}

class FakeClock {
  now = 1000;
  private nextId = 1;
  private readonly entries = new Map<number, ScheduledTimer>();
  readonly scheduledTimeouts: number[] = [];

  readonly timers: AudioBarTimers = {
    setInterval: (fn, ms) => {
      const id = this.nextId++;
      this.entries.set(id, {
        id,
        kind: "interval",
        delayMs: ms,
        nextRunMs: this.now + ms,
        fn,
        cancelled: false,
      });
      return id;
    },
    clearInterval: (handle) => {
      const entry = this.entries.get(handle as number);
      if (entry) {
        entry.cancelled = true;
        this.entries.delete(handle as number);
      }
    },
    setTimeout: (fn, ms) => {
      const id = this.nextId++;
      this.scheduledTimeouts.push(ms);
      this.entries.set(id, {
        id,
        kind: "timeout",
        delayMs: ms,
        nextRunMs: this.now + ms,
        fn,
        cancelled: false,
      });
      return id;
    },
    clearTimeout: (handle) => {
      const entry = this.entries.get(handle as number);
      if (entry) {
        entry.cancelled = true;
        this.entries.delete(handle as number);
      }
    },
  };

  advance(ms: number): void {
    const target = this.now + ms;
    while (true) {
      let next: ScheduledTimer | null = null;
      for (const entry of this.entries.values()) {
        if (entry.cancelled || entry.nextRunMs > target) {
          continue;
        }
        if (
          next === null ||
          entry.nextRunMs < next.nextRunMs ||
          (entry.nextRunMs === next.nextRunMs && entry.id < next.id)
        ) {
          next = entry;
        }
      }
      if (next === null) {
        break;
      }
      this.now = next.nextRunMs;
      if (next.kind === "timeout") {
        this.entries.delete(next.id);
      } else {
        next.nextRunMs += next.delayMs;
      }
      next.fn();
    }
    this.now = target;
  }

  get activeCount(): number {
    return this.entries.size;
  }
}

describe("TrayPositionTest", () => {
  let tempDir: string;
  let clock: FakeClock;
  let windows: TrayQuickWindowController[];
  let quick: TrayQuickWindowController;

  function makeWindow(options: TrayQuickWindowOptions = {}): TrayQuickWindowController {
    const win = new TrayQuickWindowController({}, new NoopJobs(), {
      nowMs: () => clock.now,
      timers: clock.timers,
      ...options,
    });
    windows.push(win);
    return win;
  }

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "mijiadeck-tray-position-"));
    setDataPathOverrides({
      dataDir: () => tempDir,
      dataFile: (name) => path.join(tempDir, name),
    });
    clock = new FakeClock();
    windows = [];
    quick = makeWindow();
  });

  afterEach(() => {
    for (const win of windows) {
      win.hide();
      win.dispose();
    }
    expect(clock.activeCount).toBe(0);
    setDataPathOverrides(null);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("header drag saves and recreated window restores position", () => {
    const q = quick;
    q.move({ x: 50, y: 50 });
    q.show();

    const screen: ScreenInfo = {
      name: "test-screen",
      availableGeometry: { x: 0, y: 0, width: 2000, height: 1200 },
    };
    const env = {
      screenAt: () => screen,
      screens: () => [screen],
      primaryScreen: () => screen,
    };
    q.setEnv(env);

    const start = { x: 50 + 80, y: 50 + 8 };
    expect(q.beginDrag("drag_header", start)).toBe(true);
    expect(q.updateDrag({ x: start.x + 80, y: start.y + 50 }, true)).toBe(true);
    expect(q.endDrag()).toBe(true);

    expect(q.position).toEqual({ x: 130, y: 100 });
    expect(q.dragging).toBe(false);
    expect(settingsStore.getTrayPosition()).toEqual({
      screen: "test-screen",
      x: 130,
      y: 100,
    });

    const other = makeWindow({ env });
    other.resize(q.size.width, q.size.height);
    expect(other.popupPosition()).toEqual(q.position);
  });

  it("short header click does not save position", () => {
    quick.show();
    const start = { x: 80, y: 8 };
    expect(quick.beginDrag("drag_header", start)).toBe(true);
    expect(quick.endDrag()).toBe(true);
    expect(quick.dragging).toBe(false);
    expect(settingsStore.getTrayPosition()).toBeNull();
  });

  it("audio top padding, audio drag header, and move handle are all drag handles", () => {
    const q = quick;
    q.audioBar.setSpeaker("test-speaker", "测试音箱");
    q.show();
    expect(q.audioBarVisible).toBe(true);

    const screen: ScreenInfo = {
      name: "test-screen",
      availableGeometry: { x: 0, y: 0, width: 2000, height: 1400 },
    };
    q.setEnv({
      screenAt: () => screen,
      screens: () => [screen],
      primaryScreen: () => screen,
    });

    const cases: Array<{ surface: DragSurface; localY?: number }> = [
      { surface: "audio_top_padding" },
      { surface: "audio_bar", localY: SHADOW_PAD + 3 },
      { surface: "audio_drag_header" },
      { surface: "audio_drag_handle" },
    ];

    for (const { surface, localY } of cases) {
      q.move({ x: 80, y: 80 });
      const start = { x: 110, y: 88 };
      expect(q.beginDrag(surface, start, localY)).toBe(true);
      expect(q.updateDrag({ x: start.x + 50, y: start.y + 40 }, true)).toBe(true);
      expect(q.endDrag()).toBe(true);
      expect(q.position).toEqual({ x: 130, y: 120 });
      expect(q.dragging).toBe(false);
    }
  });

  it("speaker button still opens selection without dragging or saving position", () => {
    const q = quick;
    q.audioBar.setSpeaker("test-speaker", "测试音箱");
    q.show();

    const callback = mock(() => {});
    q.audioBar.events.on("speakerRequested", callback);
    const original = { ...q.position };

    expect(q.beginDrag("speaker_button", { x: 100, y: 100 })).toBe(false);
    expect(q.updateDrag({ x: 160, y: 150 }, true)).toBe(false);
    expect(q.endDrag()).toBe(false);

    q.audioBar.requestSpeaker();

    expect(callback).toHaveBeenCalledTimes(1);
    expect(q.position).toEqual(original);
    expect(settingsStore.getTrayPosition()).toBeNull();
  });

  it("missing monitor and changed work area clamp to visible screen bounds", () => {
    const q = quick;
    q.resize(300, 300);
    const screen: ScreenInfo = {
      name: "remaining",
      availableGeometry: { x: -1000, y: 50, width: 800, height: 700 },
    };
    q.setEnv({
      screens: () => [screen],
      screenAt: () => screen,
      primaryScreen: () => screen,
    });

    settingsStore.setTrayPosition({ screen: "removed", x: 99999, y: -99999 });
    expect(q.popupPosition()).toEqual({ x: -500, y: 50 });

    settingsStore.setTrayPosition({ screen: "remaining", x: 99999, y: 99999 });
    expect(q.popupPosition()).toEqual({ x: -500, y: 450 });
  });

  it("resetPosition clears saved position and moves open window back to default corner", () => {
    quick.show();
    quick.move({ x: 70, y: 80 });
    quick.savePosition();
    expect(settingsStore.getTrayPosition()).not.toBeNull();

    quick.resetPosition();
    expect(settingsStore.getTrayPosition()).toBeNull();
    expect(quick.position).toEqual(quick.popupPosition());
  });

  it("popup allows 3000ms to reach then 300ms leave delay; dragging suppresses leave hide", () => {
    const q = quick;
    q.showImmediately();
    const hideSpy = spyOn(q, "hide");

    expect(q.leaveTimerIntervalMs).toBe(3000);
    q.pointerHasEntered = false;
    q.setEnv({
      isWindowActive: () => false,
      isUnderMouse: () => false,
      hasOtherActiveAppWindow: () => false,
    });

    q.maybeHideOnDeactivate();
    expect(hideSpy).not.toHaveBeenCalled();
    expect(q.leaveTimerActive).toBe(true);
    expect(clock.scheduledTimeouts.at(-1)).toBe(3000);

    q.onPointerEnter();
    expect(q.leaveTimerIntervalMs).toBe(300);
    expect(q.leaveTimerActive).toBe(false);

    q.dragging = true;
    q.hideAfterPointerLeave();
    expect(hideSpy).not.toHaveBeenCalled();

    // Clean up spy/flag so afterEach hides cleanly.
    q.dragging = false;
    hideSpy.mockRestore();
  });

  it("rapid show/hide cycles remain immediate and stay hidden", () => {
    const q = quick;
    const target = { x: 30, y: 40 };
    const posSpy = spyOn(q, "popupPosition").mockReturnValue(target);

    for (let i = 0; i < 10; i += 1) {
      q.showImmediately();
      expect(q.visible).toBe(true);
      expect(q.isExplicitlyVisible()).toBe(true);
      expect(q.position).toEqual(target);
      q.hide();
      expect(q.visible).toBe(false);
      expect(q.isExplicitlyVisible()).toBe(false);
    }

    clock.advance(250);
    expect(q.visible).toBe(false);
    expect(q.isExplicitlyVisible()).toBe(false);
    expect(q.position).toEqual(target);
    posSpy.mockRestore();
  });
});
