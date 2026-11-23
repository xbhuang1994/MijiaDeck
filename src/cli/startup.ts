// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * CLI 参数解析、单实例锁、静默启动判定与无控制台标准流防护。
 * 对应原 Python 入口 run.py 的启动语义。
 */

import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { APP_NAME } from "../core/appMeta.ts";
import { shouldStartHidden } from "../core/settingsStore.ts";

export type AppMode = "live" | "demo" | "virtual-light";

export const DEFAULT_PORT = 3456;
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_LOCK_NAME = `${APP_NAME}.lock`;
export const DEFAULT_STALE_LOCK_MS = 30_000;

export interface StartupOptions {
  showMain: boolean;
  mode: AppMode;
  port: number;
  customPort: boolean;
  host: string;
  checkStartup: boolean;
  noOpen: boolean;
  unknownArgs: string[];
}

export interface SingleInstanceLock {
  readonly lockPath: string;
  readonly acquired: boolean;
  readonly skipped: boolean;
  release(): void;
}

export interface SingleInstanceLockOptions {
  dir?: string;
  staleMs?: number;
  skip?: boolean;
  env?: Record<string, string | undefined>;
}

export interface StandardStreamsTarget {
  stdin?: unknown;
  stdout?: unknown;
  stderr?: unknown;
}

export interface StandardStreamsResult {
  stdinOk: boolean;
  stdoutOk: boolean;
  stderrOk: boolean;
  repaired: Array<"stdin" | "stdout" | "stderr">;
}

function parsePortValue(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") {
    throw new Error("--port 缺少端口号参数");
  }
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`无效端口号: ${raw}`);
  }
  const port = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`端口号超出有效范围 (0-65535): ${raw}`);
  }
  return port;
}

function parseHostValue(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === "") {
    throw new Error("--host 缺少主机地址参数");
  }
  return raw.trim();
}

/**
 * 解析命令行参数。
 *
 * 支持：
 * - `--show-main`：本次强制展示主界面，不改动持久化的 `start_minimized`
 * - `--demo`：启用内置演示家庭（VirtualDemoService）
 * - `--virtual-light`：启用单盏虚拟彩灯模式（VirtualLightService）
 * - `--port <number>` / `--port=<number>`：监听端口（默认 3456，0 表示随机空闲端口）
 * - `--host <string>` / `--host=<string>`：监听地址（默认 127.0.0.1）
 * - `--check-startup`：执行启动自检并退出
 * - `--no-open`：启动后不自动拉起浏览器
 */
export function parseCliArgs(argv: readonly string[] = process.argv.slice(2)): StartupOptions {
  let showMain = false;
  let mode: AppMode = "live";
  let port = DEFAULT_PORT;
  let portSpecified = false;
  let host = DEFAULT_HOST;
  let checkStartup = false;
  let noOpen = false;
  const unknownArgs: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--show-main") {
      showMain = true;
    } else if (arg === "--demo") {
      mode = "demo";
    } else if (arg === "--virtual-light") {
      mode = "virtual-light";
    } else if (arg === "--check-startup") {
      checkStartup = true;
    } else if (arg === "--no-open") {
      noOpen = true;
    } else if (arg === "--port") {
      port = parsePortValue(argv[i + 1]);
      portSpecified = true;
      i += 1;
    } else if (arg.startsWith("--port=")) {
      port = parsePortValue(arg.slice("--port=".length));
      portSpecified = true;
    } else if (arg === "--host") {
      host = parseHostValue(argv[i + 1]);
      i += 1;
    } else if (arg.startsWith("--host=")) {
      host = parseHostValue(arg.slice("--host=".length));
    } else {
      unknownArgs.push(arg);
    }
  }

  return {
    showMain,
    mode,
    port,
    customPort: portSpecified && port !== DEFAULT_PORT,
    host,
    checkStartup,
    noOpen,
    unknownArgs,
  };
}

/**
 * 判定本次启动是否应静默隐藏。
 * `--show-main` 仅覆写本次启动结果，绝不修改持久化的 `start_minimized`。
 */
export function resolveStartHidden(argv: readonly string[] = process.argv.slice(2)): boolean {
  return shouldStartHidden() && !argv.includes("--show-main");
}

/**
 * 判断本次启动是否需要抢占单实例锁。
 * 自重启（MIHOME_RESTARTED=1）、启动自检（--check-startup）或自定义端口时跳过。
 */
export function shouldAcquireSingleInstanceLock(
  options: Pick<StartupOptions, "checkStartup" | "port"> & { customPort?: boolean },
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (env.MIHOME_RESTARTED === "1") {
    return false;
  }
  if (options.checkStartup) {
    return false;
  }
  if (options.customPort || options.port !== DEFAULT_PORT) {
    return false;
  }
  return true;
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  if (pid === process.pid) {
    return true;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

function isLockFileStale(lockPath: string, staleMs: number): boolean {
  try {
    const raw = readFileSync(lockPath, "utf-8").trim();
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { pid?: unknown };
        if (typeof parsed.pid === "number" && Number.isInteger(parsed.pid)) {
          return !isPidAlive(parsed.pid);
        }
      } catch {
        const pid = Number.parseInt(raw.split(/\s+/)[0] ?? "", 10);
        if (Number.isInteger(pid) && pid > 0) {
          return !isPidAlive(pid);
        }
      }
    }
    const stat = statSync(lockPath);
    return Date.now() - stat.mtimeMs > staleMs;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT";
  }
}

function tryCreateLockFile(lockPath: string, token: string): boolean {
  let fd: number | null = null;
  try {
    fd = openSync(lockPath, "wx");
    const payload = JSON.stringify({
      pid: process.pid,
      token,
      createdAt: Date.now(),
    });
    writeSync(fd, payload, 0, "utf-8");
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      return false;
    }
    throw err;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // ignore close errors
      }
    }
  }
}

/**
 * 获取单实例锁文件。
 *
 * - 当 `MIHOME_RESTARTED=1` 或 `options.skip=true` 时直接跳过并返回 no-op 锁句柄；
 * - 若锁文件已存在且持有进程仍存活，返回 `null`；
 * - 若检测到进程崩溃遗留的过期锁文件，自动清理并重试一次。
 */
export function acquireSingleInstanceLock(
  lockName: string = DEFAULT_LOCK_NAME,
  options: SingleInstanceLockOptions = {},
): SingleInstanceLock | null {
  const env = options.env ?? process.env;
  const dir = options.dir ?? tmpdir();
  const safeName = path.basename(lockName || DEFAULT_LOCK_NAME);
  const lockPath = path.join(dir, safeName);

  if (options.skip || env.MIHOME_RESTARTED === "1") {
    return {
      lockPath,
      acquired: true,
      skipped: true,
      release(): void {
        // no-op when skipped
      },
    };
  }

  const staleMs = options.staleMs ?? DEFAULT_STALE_LOCK_MS;
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  let created = false;
  try {
    created = tryCreateLockFile(lockPath, token);
    if (!created && isLockFileStale(lockPath, staleMs)) {
      try {
        unlinkSync(lockPath);
      } catch {
        // ignore concurrent unlink
      }
      created = tryCreateLockFile(lockPath, token);
    }
  } catch {
    // 临时目录不可写时退化为不阻断启动
    return {
      lockPath,
      acquired: true,
      skipped: true,
      release(): void {
        // no-op
      },
    };
  }

  if (!created) {
    return null;
  }

  let released = false;
  return {
    lockPath,
    acquired: true,
    skipped: false,
    release(): void {
      if (released) {
        return;
      }
      released = true;
      try {
        const current = readFileSync(lockPath, "utf-8");
        if (current.includes(token)) {
          unlinkSync(lockPath);
        }
      } catch {
        // ignore if already removed
      }
    },
  };
}

function createNullReadableStream(): Record<string, unknown> {
  const stream: Record<string, unknown> = {
    isTTY: false,
    readable: true,
    isatty: () => false,
    read: () => "",
    resume: () => stream,
    pause: () => stream,
    on: () => stream,
    once: () => stream,
    off: () => stream,
  };
  return stream;
}

function createNullWritableStream(): Record<string, unknown> {
  const stream: Record<string, unknown> = {
    isTTY: false,
    writable: true,
    isatty: () => false,
    write: () => true,
    end: () => {},
    on: () => stream,
    once: () => stream,
    off: () => stream,
  };
  return stream;
}

/**
 * 防护无控制台/窗口化启动时缺失的标准流（对齐 tests/windowed_startup_test.py）。
 * 对空或不可用的 stdin / stdout / stderr 注入安全的空实现，避免依赖检查抛错。
 */
export function ensureStandardStreams(
  target: StandardStreamsTarget = process,
): StandardStreamsResult {
  const repaired: Array<"stdin" | "stdout" | "stderr"> = [];

  if (target.stdin === null || target.stdin === undefined) {
    try {
      Object.defineProperty(target, "stdin", {
        value: createNullReadableStream(),
        writable: true,
        configurable: true,
      });
      repaired.push("stdin");
    } catch {
      // ignore read-only host property
    }
  }

  if (target.stdout === null || target.stdout === undefined) {
    try {
      Object.defineProperty(target, "stdout", {
        value: createNullWritableStream(),
        writable: true,
        configurable: true,
      });
      repaired.push("stdout");
    } catch {
      // ignore read-only host property
    }
  }

  if (target.stderr === null || target.stderr === undefined) {
    try {
      Object.defineProperty(target, "stderr", {
        value: createNullWritableStream(),
        writable: true,
        configurable: true,
      });
      repaired.push("stderr");
    } catch {
      // ignore read-only host property
    }
  }

  return {
    stdinOk: target.stdin !== null && target.stdin !== undefined,
    stdoutOk: target.stdout !== null && target.stdout !== undefined,
    stderrOk: target.stderr !== null && target.stderr !== undefined,
    repaired,
  };
}

/**
 * 在默认浏览器中打开本地控制页 URL（仅允许 http/https，安全忽略启动失败）。
 */
export function openBrowserUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }
  const safeUrl = parsed.toString();
  try {
    let cmd: string[];
    if (process.platform === "win32") {
      cmd = ["rundll32", "url.dll,FileProtocolHandler", safeUrl];
    } else if (process.platform === "darwin") {
      cmd = ["open", safeUrl];
    } else {
      cmd = ["xdg-open", safeUrl];
    }
    const proc = Bun.spawn(cmd, {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    proc.unref();
    return true;
  } catch {
    return false;
  }
}
