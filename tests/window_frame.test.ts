// SPDX-License-Identifier: GPL-3.0-or-later
/** Native frame event dispatch: caption double-click maximize, NCCALCSIZE delegation, and NCHITTEST passthrough. */

import { describe, expect, mock, test } from "bun:test";
import {
  HTCAPTION,
  HTCLIENT,
  WM_NCCALCSIZE,
  WM_NCHITTEST,
  WM_NCLBUTTONDBLCLK,
  handleNativeWindowEvent,
} from "../src/ui/controllers/mainWindowController.ts";

describe("WindowFrameTest", () => {
  test("WM_NCLBUTTONDBLCLK on HTCAPTION toggles maximized once", () => {
    const toggleMaximized = mock(() => {});
    const hitTest = mock((_lParam: number) => 0);

    const result = handleNativeWindowEvent(
      { message: WM_NCLBUTTONDBLCLK, wParam: HTCAPTION, lParam: 0 },
      { hitTest, toggleMaximized },
    );
    expect(result).toEqual([true, 0]);
    expect(toggleMaximized).toHaveBeenCalledTimes(1);
    expect(hitTest).not.toHaveBeenCalled();

    // Non-caption double-click does not toggle maximize
    const nonCaption = handleNativeWindowEvent(
      { message: WM_NCLBUTTONDBLCLK, wParam: HTCLIENT, lParam: 0 },
      { hitTest, toggleMaximized },
    );
    expect(nonCaption).toEqual([false, 0]);
    expect(toggleMaximized).toHaveBeenCalledTimes(1);
  });

  test("WM_NCCALCSIZE returns [false, 0] without calling hitTest", () => {
    const hitTest = mock((_lParam: number) => 2);
    const toggleMaximized = mock(() => {});

    const result = handleNativeWindowEvent(
      { message: WM_NCCALCSIZE, wParam: 1, lParam: 0 },
      { hitTest, toggleMaximized },
    );
    expect(result).toEqual([false, 0]);
    expect(hitTest).not.toHaveBeenCalled();
    expect(toggleMaximized).not.toHaveBeenCalled();
  });

  test("WM_NCHITTEST calls hitTest(lParam) and returns [true, code]", () => {
    const hitTest = mock((_lParam: number) => 2);
    const toggleMaximized = mock(() => {});

    const result = handleNativeWindowEvent(
      { message: WM_NCHITTEST, wParam: 0, lParam: 12345 },
      { hitTest, toggleMaximized },
    );
    expect(result).toEqual([true, 2]);
    expect(hitTest).toHaveBeenCalledTimes(1);
    expect(hitTest).toHaveBeenCalledWith(12345);
    expect(toggleMaximized).not.toHaveBeenCalled();
  });
});
