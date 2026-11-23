// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors
/**
 * JSON 持久化公共基础：数据目录解析、旧位置迁移、原子写入。
 *
 * 打包形态曾把配置写在 exe 同目录，装进 Program Files 等受保护位置后
 * 写入失败且被静默吞掉，表现为设置每次启动重置；现统一写入
 * %LOCALAPPDATA%\MijiaDeck\，并把旧位置的已有文件一次性迁移过来。
 * 开发形态仍为仓库根目录（文件均已 gitignore）。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { isPackaged, projectRoot, runtimeEnv } from "./appMeta.ts";

export const _APP_DIR_NAME = "MijiaDeck";
export const _LEGACY_APP_DIR_NAME = "MiHome-Windows";
// 旧版写在 exe 同目录的全部数据文件，发现即迁移
export const KNOWN_FILES = [
  "settings.json",
  "tray.json",
  "workbench.json",
  "devices_cache.json",
  "account_profiles.json",
] as const;

export interface DataPathOverrides {
  dataDir?: () => string;
  dataFile?: (filename: string) => string;
}

let migrated = false;
let pathOverrides: DataPathOverrides | null = null;

export function setDataPathOverrides(overrides: DataPathOverrides | null): void {
  pathOverrides = overrides;
}

export function resetMigrationState(): void {
  migrated = false;
}

export function dataDir(): string {
  if (pathOverrides?.dataDir) {
    return pathOverrides.dataDir();
  }
  if (isPackaged()) {
    const base = runtimeEnv.env.LOCALAPPDATA || homedir();
    return path.join(base, _APP_DIR_NAME);
  }
  return projectRoot();
}

export function dataFile(filename: string): string {
  if (pathOverrides?.dataFile) {
    return pathOverrides.dataFile(filename);
  }
  if (isPackaged() && !migrated) {
    migrated = true;
    _migrateLegacyFiles();
  }
  return path.join(dataDir(), filename);
}

function isExistingFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function _migrateLegacyFiles(): void {
  const targetDir = path.resolve(dataDir());
  const localBase = runtimeEnv.env.LOCALAPPDATA || homedir();
  const candidates: string[] = [path.resolve(path.join(localBase, _LEGACY_APP_DIR_NAME))];
  const argv0 = runtimeEnv.argv[0];
  if (argv0) {
    candidates.push(path.dirname(path.resolve(argv0)));
  }
  if (runtimeEnv.execPath) {
    candidates.push(path.dirname(path.resolve(runtimeEnv.execPath)));
  }

  const targetKey = runtimeEnv.platform === "win32" ? targetDir.toLowerCase() : targetDir;
  const seen = new Set<string>();

  try {
    mkdirSync(targetDir, { recursive: true });
    for (const legacyDir of candidates) {
      const legacyKey = runtimeEnv.platform === "win32" ? legacyDir.toLowerCase() : legacyDir;
      if (seen.has(legacyKey) || legacyKey === targetKey) {
        continue;
      }
      seen.add(legacyKey);
      for (const name of KNOWN_FILES) {
        const legacy = path.join(legacyDir, name);
        const target = path.join(targetDir, name);
        if (isExistingFile(legacy) && !existsSync(target)) {
          // Copy only: preserve old data and never overwrite new preferences.
          writeFileSync(target, readFileSync(legacy));
        }
      }
    }
  } catch {
    // ignore OSError during non-destructive migration
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 读取 JSON 对象；文件缺失、损坏或类型不对时返回 defaultValue。 */
export function readJson<T extends Record<string, unknown>>(filePath: string, defaultValue: T): T {
  try {
    const raw: unknown = JSON.parse(readFileSync(filePath, "utf-8"));
    if (!isPlainObject(raw)) {
      return defaultValue;
    }
    return raw as T;
  } catch {
    return defaultValue;
  }
}

/** 原子写入（严格模式）：先写同目录临时文件再 rename，失败时抛出异常。 */
export function writeJsonStrict(filePath: string, data: Record<string, unknown>): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 1), "utf-8");
  renameSync(tmp, filePath);
}

/** 原子写入：先写同目录临时文件再 rename，进程被杀不会留半截文件；吞掉 IO 异常。 */
export function writeJson(filePath: string, data: Record<string, unknown>): void {
  try {
    writeJsonStrict(filePath, data);
  } catch {
    // ignore OSError
  }
}
