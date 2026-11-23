// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * Brand resources and non-destructive migration to the renamed application
 * (ported 1:1 from tests/branding_test.py).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  APP_NAME,
  projectRoot,
  resourcePath,
  runtimeEnv,
  setPackagedOverride,
} from "../src/core/appMeta.ts";
import {
  dataDir,
  dataFile,
  readJson,
  resetMigrationState,
  setDataPathOverrides,
} from "../src/core/jsonStore.ts";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const origLocalAppData = process.env.LOCALAPPDATA;
const origArgvDesc = Object.getOwnPropertyDescriptor(runtimeEnv, "argv");
const origExecPathDesc = Object.getOwnPropertyDescriptor(runtimeEnv, "execPath");
const tempDirs: string[] = [];

function parseIcoSizes(icoBytes: Buffer): Set<number> {
  // ICO header: reserved (u16 LE = 0), type (u16 LE = 1 for ICO), count (u16 LE)
  expect(icoBytes.length).toBeGreaterThanOrEqual(6);
  expect(icoBytes.readUInt16LE(0)).toBe(0);
  expect(icoBytes.readUInt16LE(2)).toBe(1);
  const count = icoBytes.readUInt16LE(4);
  expect(icoBytes.length).toBeGreaterThanOrEqual(6 + count * 16);

  const sizes = new Set<number>();
  for (let i = 0; i < count; i++) {
    const offset = 6 + i * 16;
    const rawWidth = icoBytes[offset]!;
    const rawHeight = icoBytes[offset + 1]!;
    // In ICO directory entries, 0 encodes 256 px.
    const width = rawWidth === 0 ? 256 : rawWidth;
    const height = rawHeight === 0 ? 256 : rawHeight;
    expect(width).toBe(height);
    sizes.add(width);
  }
  return sizes;
}

afterEach(() => {
  setDataPathOverrides(null);
  setPackagedOverride(null);
  resetMigrationState();

  if (origLocalAppData === undefined) {
    delete process.env.LOCALAPPDATA;
  } else {
    process.env.LOCALAPPDATA = origLocalAppData;
  }
  if (origArgvDesc) {
    Object.defineProperty(runtimeEnv, "argv", origArgvDesc);
  }
  if (origExecPathDesc) {
    Object.defineProperty(runtimeEnv, "execPath", origExecPathDesc);
  }

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("BrandingTest", () => {
  test("APP_NAME and brand icon PNG/ICO assets are present and well-formed", () => {
    expect(APP_NAME).toBe("MijiaDeck");

    for (const file of ["icon.png", "tray_icon.png", "tray_icon_light.png"] as const) {
      const assetPath = resourcePath(`assets/${file}`);
      expect(existsSync(assetPath)).toBe(true);
      // Legacy app/ui/... lookup also maps cleanly to the same asset.
      expect(resourcePath(`app/ui/${file}`)).toBe(assetPath);

      const bytes = readFileSync(assetPath);
      expect(bytes.length).toBeGreaterThan(24);
      expect(bytes.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
      // IHDR width & height (bytes 16..23) are positive square dimensions.
      const width = bytes.readUInt32BE(16);
      const height = bytes.readUInt32BE(20);
      expect(width).toBeGreaterThan(0);
      expect(width).toBe(height);
    }

    const icoPath = resourcePath("assets/icon.ico");
    expect(existsSync(icoPath)).toBe(true);
    expect(resourcePath("app/ui/icon.ico")).toBe(icoPath);

    const icoBytes = readFileSync(icoPath);
    const sizes = parseIcoSizes(icoBytes);
    expect(sizes).toEqual(new Set([16, 24, 32, 48, 64, 128, 256]));
  });

  test("renamed packaged data copies old MiHome-Windows & bundle settings without overwriting new MijiaDeck data", () => {
    const temp = mkdtempSync(path.join(tmpdir(), "mijiadeck-branding-"));
    tempDirs.push(temp);

    const oldDir = path.join(temp, "MiHome-Windows");
    const targetDir = path.join(temp, "MijiaDeck");
    const bundleDir = path.join(temp, "bundle");
    for (const dir of [oldDir, targetDir, bundleDir]) {
      mkdirSync(dir, { recursive: true });
    }

    writeFileSync(path.join(oldDir, "settings.json"), '{"theme":"dark"}', "utf-8");
    writeFileSync(path.join(oldDir, "tray.json"), '{"source":"legacy"}', "utf-8");
    writeFileSync(path.join(targetDir, "tray.json"), '{"source":"new"}', "utf-8");
    writeFileSync(path.join(bundleDir, "workbench.json"), '{"position":8}', "utf-8");

    process.env.LOCALAPPDATA = temp;
    setPackagedOverride(() => true);
    resetMigrationState();
    Object.defineProperty(runtimeEnv, "argv", {
      configurable: true,
      get: () => [path.join(bundleDir, "MijiaDeck.exe")],
    });
    Object.defineProperty(runtimeEnv, "execPath", {
      configurable: true,
      get: () => path.join(bundleDir, "bun.exe"),
    });

    expect(path.resolve(dataFile("settings.json"))).toBe(
      path.resolve(path.join(targetDir, "settings.json")),
    );
    expect(readJson(path.join(targetDir, "settings.json"), {})).toEqual({ theme: "dark" });
    expect(readJson(path.join(targetDir, "tray.json"), {})).toEqual({ source: "new" });
    expect(readJson(path.join(targetDir, "workbench.json"), {})).toEqual({ position: 8 });

    // Non-destructive copy: legacy and bundle source files remain intact.
    expect(existsSync(path.join(oldDir, "settings.json"))).toBe(true);
    expect(existsSync(path.join(oldDir, "tray.json"))).toBe(true);
    expect(existsSync(path.join(bundleDir, "workbench.json"))).toBe(true);
  });

  test("source mode retains repo root as dataDir()", () => {
    setDataPathOverrides(null);
    setPackagedOverride(() => false);
    const expectedRepoRoot = path.resolve(import.meta.dir, "..");
    expect(path.resolve(projectRoot())).toBe(expectedRepoRoot);
    expect(path.resolve(dataDir())).toBe(expectedRepoRoot);
  });
});
