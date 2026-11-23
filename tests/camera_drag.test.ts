// SPDX-License-Identifier: GPL-3.0-or-later
/** Drag-to-pan gesture tests for CameraCanvasController. */

import { beforeEach, describe, expect, test } from "bun:test";
import type { Point } from "../src/core/contracts.ts";
import { CameraCanvasController } from "../src/ui/controllers/cameraPreviewController.ts";

describe("CameraDrag", () => {
  let canvas: CameraCanvasController;
  let directions: number[];
  let nowMs: number;

  beforeEach(() => {
    nowMs = 1_000;
    canvas = new CameraCanvasController({ clock: () => nowMs });
    canvas.setFrame({ width: 640, height: 360, valid: true });
    canvas.dragEnabled = true;
    directions = [];
    canvas.on("dragged", (direction) => {
      directions.push(direction);
    });
  });

  test("all 4 directions are sent while dragging before release and new frames don't cancel active gesture", () => {
    const cases: ReadonlyArray<readonly [Point, number]> = [
      [{ x: 20, y: 0 }, 2],
      [{ x: -20, y: 0 }, 1],
      [{ x: 0, y: 20 }, 4],
      [{ x: 0, y: -20 }, 3],
    ];

    for (const [delta, expected] of cases) {
      directions.length = 0;
      const start: Point = { x: 300, y: 120 };
      const target: Point = { x: start.x + delta.x, y: start.y + delta.y };

      canvas.mousePress(start);
      // New decoded frames must not cancel an active gesture.
      canvas.dragEnabled = true;
      canvas.mouseMove(target, true);
      expect(directions).toEqual([expected]);

      canvas.mouseRelease(target);
      expect(directions).toEqual([expected]);
    }
  });

  test("short click (< 12px) and disabled drag do not move camera", () => {
    const start: Point = { x: 300, y: 120 };

    canvas.mousePress(start);
    canvas.mouseRelease({ x: start.x + 3, y: start.y + 2 });
    expect(directions).toEqual([]);

    // 11px movement is still strictly under the 12px threshold.
    canvas.mousePress(start);
    canvas.mouseMove({ x: start.x + 11, y: start.y }, true);
    canvas.mouseRelease({ x: start.x + 11, y: start.y });
    expect(directions).toEqual([]);

    canvas.dragEnabled = false;
    canvas.mousePress(start);
    canvas.mouseMove({ x: start.x + 60, y: start.y }, true);
    canvas.mouseRelease({ x: start.x + 60, y: start.y });
    expect(directions).toEqual([]);
  });

  test("large fast drag is rate-limited (only one step per gesture)", () => {
    const start: Point = { x: 300, y: 120 };

    canvas.mousePress(start);
    canvas.mouseMove({ x: start.x + 20, y: start.y }, true);
    canvas.mouseMove({ x: start.x + 80, y: start.y }, true);
    canvas.mouseRelease({ x: start.x + 100, y: start.y });
    expect(directions).toEqual([2]);
  });

  test("busy drag is discarded and requires a fresh press after setDragBusy(false)", () => {
    const start: Point = { x: 300, y: 120 };
    canvas.on("dragged", () => canvas.setDragBusy(true));

    canvas.mousePress(start);
    canvas.mouseMove({ x: start.x + 20, y: start.y }, true);
    canvas.setDragBusy(false);
    canvas.mouseMove({ x: start.x + 80, y: start.y }, true);
    canvas.mouseRelease({ x: start.x + 80, y: start.y });
    expect(directions).toEqual([2]);

    canvas.setDragBusy(true);
    canvas.mousePress(start);
    canvas.setDragBusy(false);
    canvas.mouseMove({ x: start.x - 30, y: start.y }, true);
    canvas.mouseRelease({ x: start.x - 30, y: start.y });
    expect(directions).toEqual([2]);

    canvas.mousePress(start);
    canvas.mouseMove({ x: start.x - 30, y: start.y }, true);
    expect(directions).toEqual([2, 1]);
  });
});
