// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * MijiaDeck 主应用入口（Bun + TypeScript）。
 *
 * 用法:
 *   bun run src/index.ts [--demo | --virtual-light] [--port 3456] [--host 127.0.0.1]
 *                        [--show-main] [--no-open] [--check-startup]
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  acquireSingleInstanceLock,
  ensureStandardStreams,
  openBrowserUrl,
  parseCliArgs,
  resolveStartHidden,
  shouldAcquireSingleInstanceLock,
  type StartupOptions,
} from "./cli/startup.ts";
import { APP_NAME, APP_VERSION } from "./core/appMeta.ts";
import { setDataPathOverrides } from "./core/jsonStore.ts";
import { markVersionStarted } from "./core/settingsStore.ts";
import { startMijiaDeckServer, type MijiaDeckServer } from "./server/server.ts";

async function verifyStartupHealth(instance: MijiaDeckServer, mode: StartupOptions["mode"]): Promise<void> {
  const healthRes = await fetch(`${instance.url}/api/health`);
  if (!healthRes.ok) {
    throw new Error(`健康检查失败: HTTP ${healthRes.status}`);
  }
  const health = (await healthRes.json()) as Record<string, unknown>;
  if (health.ok !== true || health.app !== APP_NAME || health.version !== APP_VERSION || health.mode !== mode) {
    throw new Error("健康检查返回数据不符合预期");
  }

  const stateRes = await fetch(`${instance.url}/api/state`);
  if (!stateRes.ok) {
    throw new Error(`状态检查失败: HTTP ${stateRes.status}`);
  }
  const state = (await stateRes.json()) as Record<string, unknown>;
  if (
    state.ok !== true ||
    typeof state.accessState !== "string" ||
    typeof state.theme !== "object" ||
    state.theme === null ||
    !Array.isArray(state.devices)
  ) {
    throw new Error("状态快照结构校验失败");
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  ensureStandardStreams();

  let options: StartupOptions;
  try {
    options = parseCliArgs(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const useLock = shouldAcquireSingleInstanceLock(options);
  const lock = acquireSingleInstanceLock(undefined, { skip: !useLock });
  if (!lock) {
    console.log(`${APP_NAME} 已在运行中，退出重复实例。`);
    return 0;
  }

  const startHidden = resolveStartHidden(argv);
  const listenPort = options.checkStartup && !options.customPort ? 0 : options.port;

  let tempCheckDir: string | null = null;
  if (options.checkStartup) {
    tempCheckDir = mkdtempSync(path.join(tmpdir(), "mijiadeck-startup-check-"));
    const dir = tempCheckDir;
    setDataPathOverrides({
      dataDir: () => dir,
      dataFile: (name) => path.join(dir, name),
    });
  }

  let instance: MijiaDeckServer | null = null;
  try {
    instance = await startMijiaDeckServer({
      port: listenPort,
      hostname: options.host,
      mode: options.mode,
      autoStart: options.checkStartup ? options.mode !== "live" : true,
      autoStartTimers: options.checkStartup ? false : undefined,
    });

    if (options.checkStartup) {
      await verifyStartupHealth(instance, options.mode);
      console.log(`${APP_NAME} v${APP_VERSION} startup check passed (${options.mode})`);
      await instance.stop();
      lock.release();
      return 0;
    }

    if (!startHidden && options.mode === "live") {
      markVersionStarted();
    }

    console.log(`${APP_NAME} v${APP_VERSION} listening on ${instance.url}`);

    if (!options.noOpen && !startHidden) {
      openBrowserUrl(instance.url);
    }

    await new Promise<void>((resolve) => {
      let shuttingDown = false;
      const onSignal = (): void => {
        if (shuttingDown) {
          return;
        }
        shuttingDown = true;
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
        resolve();
      };
      process.on("SIGINT", onSignal);
      process.on("SIGTERM", onSignal);
    });

    await instance.stop();
    lock.release();
    return 0;
  } catch (err) {
    console.error(
      `${APP_NAME} 启动失败:`,
      err instanceof Error ? err.message : String(err),
    );
    if (instance !== null) {
      try {
        await instance.stop();
      } catch {
        // ignore stop errors on failure path
      }
    }
    lock.release();
    return 1;
  } finally {
    if (tempCheckDir !== null) {
      setDataPathOverrides(null);
      try {
        rmSync(tempCheckDir, { recursive: true, force: true });
      } catch {
        // ignore temp cleanup errors
      }
    }
  }
}

if (import.meta.main) {
  main()
    .then((code) => {
      process.exit(code);
    })
    .catch((err) => {
      console.error(`${APP_NAME} 异常退出:`, err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
