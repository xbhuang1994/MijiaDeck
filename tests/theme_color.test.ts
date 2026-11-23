// SPDX-License-Identifier: GPL-3.0-or-later
/** Every selectable color provides separate light/dark interaction roles. */

import { afterEach, describe, expect, test } from "bun:test";
import {
  SiColors,
  THEME_COLORS,
  accentColors,
  buildCss,
  contrast,
  currentAccent,
  setAccent,
  setTheme,
  type PresetAccent,
  type ThemeName,
} from "../src/ui/theme.ts";

describe("ThemeColorTest", () => {
  afterEach(() => {
    setAccent("green");
    setTheme("dark");
  });

  test("each preset color has distinct surface and interaction roles", () => {
    const presets: readonly PresetAccent[] = ["green", "pink", "yellow", "blue"];
    const modes: readonly ThemeName[] = ["light", "dark"];

    for (const accent of presets) {
      const rolesByMode = [];
      for (const mode of modes) {
        setAccent(accent);
        setTheme(mode);
        const roles = accentColors();
        expect(roles.THEME).toBe(THEME_COLORS[accent].hex);
        expect(new Set([roles.THEME, roles.THEME_HOVER, roles.THEME_PRESSED]).size).toBe(3);
        expect(roles.THEME).not.toBe(roles.ACCENT_SURFACE);
        expect(roles.ON_THEME_TEXT).not.toBe(roles.THEME);
        expect(buildCss()).toContain(roles.THEME);
        expect(SiColors.THEME).toBe(roles.THEME);
        rolesByMode.push(roles);
      }
      expect(rolesByMode[0]!.ACCENT_SURFACE).not.toBe(rolesByMode[1]!.ACCENT_SURFACE);
    }
  });

  test("invalid choice cannot replace current color", () => {
    setAccent("blue");
    expect(() => setAccent("invalid")).toThrow();
    expect(currentAccent()).toBe("blue");
  });

  test("custom colors have readable text in both modes", () => {
    const colors = [
      "#333333",
      "#000000",
      "#ffffff",
      "#eab308",
      "#aabbcc",
      "#67837e",
      "#00c788",
      "#3ce5ff",
    ] as const;
    const modes: readonly ThemeName[] = ["light", "dark"];

    for (const color of colors) {
      for (const mode of modes) {
        setAccent(color);
        setTheme(mode);
        const roles = accentColors();
        expect(roles.THEME).toBe(color);
        expect(["#ffffff", "#000000"]).toContain(roles.ON_THEME_TEXT);
        expect(contrast(roles.ON_THEME_TEXT, roles.THEME)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(roles.THEME_DIM, roles.ACCENT_SURFACE)).toBeGreaterThanOrEqual(4.5);
        expect(buildCss()).toContain(roles.THEME);
      }
    }
  });
});
