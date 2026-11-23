// SPDX-License-Identifier: GPL-3.0-or-later
/** Grid card widths fill the full viewport including rounding remainders. */

import { describe, expect, test } from "bun:test";
import { CARD_FIXED_WIDTH } from "../src/ui/controllers/deviceCardController.ts";
import {
  GRID_SPACING,
  columnsForWidth,
  gridCardWidth,
} from "../src/ui/controllers/mainWindowController.ts";

describe("GridWidthTest", () => {
  test("full rows fill viewport including rounding remainders", () => {
    const viewports = [702, 980, 1100, 1101, 1102, 1103, 1400, 1901] as const;

    for (const available of viewports) {
      const columns = columnsForWidth(available, GRID_SPACING);
      const widths = Array.from({ length: columns }, (_, col) =>
        gridCardWidth(available, columns, col, GRID_SPACING),
      );
      const totalWidth = widths.reduce((sum, w) => sum + w, 0);

      expect(totalWidth + (columns - 1) * 8).toBe(available);
      expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);
      expect(Math.min(...widths)).toBeGreaterThanOrEqual(CARD_FIXED_WIDTH);
      expect(Math.min(...widths)).toBeGreaterThanOrEqual(212);
    }
  });
});
