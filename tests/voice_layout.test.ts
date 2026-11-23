// SPDX-License-Identifier: GPL-3.0-or-later
/** Voice FAB left-expansion layout, submission trimming/collapsing, narrow clamping, and Toast anchoring. */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  BOTTOM_RESERVED_HEIGHT,
  ToastLayoutController,
  VoiceFabController,
} from "../src/ui/controllers/voiceFabController.ts";

describe("VoiceLayoutTest", () => {
  let fab: VoiceFabController;
  let toast: ToastLayoutController;

  beforeEach(() => {
    fab = new VoiceFabController({ width: 1160, height: 740 });
    fab.setVisible(true);
    toast = new ToastLayoutController();
  });

  afterEach(() => {
    toast.dismiss();
    fab.dispose();
  });

  test("input expands left without moving button and submission trims and collapses panel", () => {
    const hostSize = { width: 1160, height: 740 };
    const initialBallPos = { x: fab.ballRect.x, y: fab.ballRect.y };

    // Intermediate reveal step before full expansion
    fab.setReveal(0.4);
    const intermediateWidth = fab.panelRect.width;
    expect(intermediateWidth).toBeGreaterThan(0);

    fab.expand();
    expect(fab.panelRect.width).toBeGreaterThan(intermediateWidth);
    expect({ x: fab.ballRect.x, y: fab.ballRect.y }).toEqual(initialBallPos);

    const panelCenterY = fab.panelRect.y + fab.panelRect.height / 2;
    const ballCenterY = fab.ballRect.y + fab.ballRect.height / 2;
    expect(panelCenterY).toBe(ballCenterY);

    const panelRight = fab.panelRect.x + fab.panelRect.width;
    expect(panelRight).toBeLessThan(fab.ballRect.x);

    const bottomClearance = hostSize.height - initialBallPos.y - fab.ballRect.height;
    expect(bottomClearance).toBeGreaterThanOrEqual(BOTTOM_RESERVED_HEIGHT);

    const commands: string[] = [];
    fab.on("submitted", (text) => commands.push(text));
    fab.setInputText(" 音量调整到50 ");
    expect(fab.submit()).toBe(true);

    expect(commands).toEqual(["音量调整到50"]);
    expect(fab.panelVisible).toBe(false);
    expect(fab.expanded).toBe(false);
  });

  test("narrow window clamps panel inside host and toast stays beside ball across resizes", () => {
    const narrowHost = { width: 480, height: 520 };
    fab.reposition(narrowHost);
    fab.expand();
    expect(fab.panelRect.x).toBeGreaterThanOrEqual(0);

    const shown = toast.show("已告诉小爱同学：你在吗", narrowHost, {
      fabState: { visible: fab.visible, ballRect: fab.ballRect },
      durationMs: 5000,
    });
    expect(shown.rect.x + shown.rect.width).toBeLessThan(fab.ballRect.x);

    const toastCenterY = shown.rect.y + shown.rect.height / 2;
    const ballCenterY = fab.ballRect.y + fab.ballRect.height / 2;
    expect(Math.abs(toastCenterY - ballCenterY)).toBeLessThanOrEqual(1);

    const widerHost = { width: 760, height: 560 };
    fab.reposition(widerHost);
    const moved = toast.reposition(widerHost, {
      visible: fab.visible,
      ballRect: fab.ballRect,
    });
    expect(moved).not.toBeNull();
    expect(moved!.x + moved!.width).toBeLessThan(fab.ballRect.x);
    expect(moved!.x).toBeGreaterThan(shown.rect.x);
    const movedCenterY = moved!.y + moved!.height / 2;
    const widerBallCenterY = fab.ballRect.y + fab.ballRect.height / 2;
    expect(Math.abs(movedCenterY - widerBallCenterY)).toBeLessThanOrEqual(1);
  });
});
