// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const APP_VERSION = "1.1.2";
export const APP_NAME = "MijiaDeck";
export const UPDATE_REPOSITORY = "Songmanual/MijiaDeck";

export interface RuntimeEnv {
  isPackaged(): boolean;
  platform: NodeJS.Platform;
  argv: string[];
  execPath: string;
  env: Record<string, string | undefined>;
}

const defaultIsPackaged = (): boolean => {
  if (process.env.MIJIADECK_PACKAGED === "1") {
    return true;
  }
  const exec = process.execPath.toLowerCase();
  const mainArg = (process.argv[1] ?? "").toLowerCase();
  return !exec.endsWith("bun.exe") && !exec.endsWith("/bun") && mainArg.startsWith("/$bunfs");
};

export const runtimeEnv: RuntimeEnv = {
  isPackaged: defaultIsPackaged,
  platform: process.platform,
  get argv() {
    return process.argv;
  },
  get execPath() {
    return process.execPath;
  },
  get env() {
    return process.env;
  },
};

export function isPackaged(): boolean {
  return runtimeEnv.isPackaged();
}

export function setPackagedOverride(fn: (() => boolean) | null): void {
  runtimeEnv.isPackaged = fn ?? defaultIsPackaged;
}

export function projectRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..");
}

/**
 * Resolve bundled/source resource files.
 * Maps legacy `app/ui/...` paths transparently to `assets/...` as well as direct `assets/...` paths.
 */
export function resourcePath(relative: string): string {
  const normalized = relative.replaceAll("\\", "/");
  const mapped = normalized.startsWith("app/ui/")
    ? "assets/" + normalized.slice("app/ui/".length)
    : normalized;

  const execDir = dirname(resolve(runtimeEnv.execPath));
  for (const rel of [mapped, normalized]) {
    const candidate = resolve(execDir, rel);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  const root = projectRoot();
  for (const rel of [mapped, normalized]) {
    const candidate = resolve(root, rel);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return resolve(root, mapped);
}

/**
 * Hint GC / working-set trim when minimized to tray.
 * Safe no-op if unavailable.
 */
export function trimWorkingSet(): void {
  try {
    if (typeof Bun !== "undefined" && typeof Bun.gc === "function") {
      Bun.gc(false);
    }
  } catch {
    // ignore
  }
}
