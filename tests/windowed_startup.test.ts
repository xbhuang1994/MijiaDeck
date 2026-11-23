// SPDX-License-Identifier: GPL-3.0-or-later
/** Windowed startup behavior: --show-main override, standard stream repair, CLI flag parsing, and single-instance lock. */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  acquireSingleInstanceLock,
  ensureStandardStreams,
  parseCliArgs,
  resolveStartHidden,
  shouldAcquireSingleInstanceLock,
  type StandardStreamsTarget,
} from "../src/cli/startup.ts";
import { setDataPathOverrides } from "../src/core/jsonStore.ts";
import * as settingsStore from "../src/core/settingsStore.ts";
import { setAccent, setTheme } from "../src/ui/theme.ts";

describe("WindowedStartupTest", () => {
  let tempDir = "";

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "mijiadeck-startup-test-"));
    const dir = tempDir;
    setDataPathOverrides({
      dataDir: () => dir,
      dataFile: (name) => path.join(dir, name),
    });
    setAccent("green");
    setTheme("dark");
  });

  afterEach(() => {
    setAccent("green");
    setTheme("dark");
    setDataPathOverrides(null);
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = "";
    }
  });

  test("--show-main overrides saved hidden tray startup without changing start_minimized", () => {
    settingsStore.setMinimizeToTray(true);
    settingsStore.setStartMinimized(true);
    settingsStore.setTrayIntroSeen(true);
    settingsStore.markVersionStarted();

    expect(settingsStore.shouldStartHidden()).toBe(true);
    expect(resolveStartHidden([])).toBe(true);
    expect(resolveStartHidden(["--show-main"])).toBe(false);

    // Persisted preference remains unchanged
    expect(settingsStore.getStartMinimized()).toBe(true);
    expect(settingsStore.shouldStartHidden()).toBe(true);
  });

  test("ensureStandardStreams safely repairs absent stdin/stdout/stderr streams", () => {
    const target: StandardStreamsTarget = {
      stdin: null,
      stdout: null,
      stderr: null,
    };

    const result = ensureStandardStreams(target);
    expect(result.stdinOk).toBe(true);
    expect(result.stdoutOk).toBe(true);
    expect(result.stderrOk).toBe(true);
    expect(result.repaired).toEqual(["stdin", "stdout", "stderr"]);

    const stdout = target.stdout as { isatty(): boolean; write(chunk: string): boolean };
    const stderr = target.stderr as { isatty(): boolean; write(chunk: string): boolean };
    const stdin = target.stdin as { isatty(): boolean; read(): string };

    expect(typeof stdout.isatty()).toBe("boolean");
    expect(typeof stderr.isatty()).toBe("boolean");
    expect(stdin.read()).toBe("");
    expect(stdout.write("ok")).toBe(true);

    // Second invocation sees healthy streams and repairs nothing
    const second = ensureStandardStreams(target);
    expect(second.repaired).toEqual([]);
    expect(second.stdinOk && second.stdoutOk && second.stderrOk).toBe(true);
  });

  test("parseCliArgs parses all supported flags and validates port/host", () => {
    expect(parseCliArgs([])).toEqual({
      showMain: false,
      mode: "live",
      port: DEFAULT_PORT,
      customPort: false,
      host: DEFAULT_HOST,
      checkStartup: false,
      noOpen: false,
      unknownArgs: [],
    });

    expect(
      parseCliArgs([
        "--show-main",
        "--demo",
        "--port",
        "8080",
        "--host",
        "0.0.0.0",
        "--check-startup",
        "--no-open",
        "--unknown",
      ]),
    ).toEqual({
      showMain: true,
      mode: "demo",
      port: 8080,
      customPort: true,
      host: "0.0.0.0",
      checkStartup: true,
      noOpen: true,
      unknownArgs: ["--unknown"],
    });

    expect(parseCliArgs(["--virtual-light", "--port=0", "--host=localhost"])).toEqual({
      showMain: false,
      mode: "virtual-light",
      port: 0,
      customPort: true,
      host: "localhost",
      checkStartup: false,
      noOpen: false,
      unknownArgs: [],
    });

    expect(parseCliArgs(["--port", String(DEFAULT_PORT)]).customPort).toBe(false);

    expect(() => parseCliArgs(["--port"])).toThrow();
    expect(() => parseCliArgs(["--port", "abc"])).toThrow();
    expect(() => parseCliArgs(["--port", "70000"])).toThrow();
    expect(() => parseCliArgs(["--host"])).toThrow();
  });

  test("single-instance lock acquire, release, stale recovery, and skip rules", () => {
    // Skip rule matrix
    expect(shouldAcquireSingleInstanceLock({ checkStartup: false, port: DEFAULT_PORT }, {})).toBe(
      true,
    );
    expect(
      shouldAcquireSingleInstanceLock(
        { checkStartup: false, port: DEFAULT_PORT },
        { MIHOME_RESTARTED: "1" },
      ),
    ).toBe(false);
    expect(shouldAcquireSingleInstanceLock({ checkStartup: true, port: DEFAULT_PORT }, {})).toBe(
      false,
    );
    expect(
      shouldAcquireSingleInstanceLock(
        { checkStartup: false, port: 4567, customPort: true },
        {},
      ),
    ).toBe(false);

    // Acquire & block duplicate while live
    const lockName = "test-instance.lock";
    const lock1 = acquireSingleInstanceLock(lockName, { dir: tempDir, env: {} });
    expect(lock1).not.toBeNull();
    expect(lock1!.acquired).toBe(true);
    expect(lock1!.skipped).toBe(false);
    expect(existsSync(lock1!.lockPath)).toBe(true);

    const duplicate = acquireSingleInstanceLock(lockName, { dir: tempDir, env: {} });
    expect(duplicate).toBeNull();

    // Release removes lock file and allows re-acquisition
    lock1!.release();
    lock1!.release(); // idempotent
    expect(existsSync(lock1!.lockPath)).toBe(false);

    const lock2 = acquireSingleInstanceLock(lockName, { dir: tempDir, env: {} });
    expect(lock2).not.toBeNull();
    lock2!.release();

    // Skipped locks do not touch disk
    const skippedLock = acquireSingleInstanceLock("skipped.lock", {
      dir: tempDir,
      skip: true,
      env: {},
    });
    expect(skippedLock).not.toBeNull();
    expect(skippedLock!.skipped).toBe(true);
    expect(existsSync(skippedLock!.lockPath)).toBe(false);

    const restartedLock = acquireSingleInstanceLock("restarted.lock", {
      dir: tempDir,
      env: { MIHOME_RESTARTED: "1" },
    });
    expect(restartedLock).not.toBeNull();
    expect(restartedLock!.skipped).toBe(true);
    expect(existsSync(restartedLock!.lockPath)).toBe(false);

    // Stale lock left by a dead PID is reclaimed
    const staleLockPath = path.join(tempDir, "stale.lock");
    writeFileSync(
      staleLockPath,
      JSON.stringify({ pid: 999_999_99, token: "dead", createdAt: 0 }),
      "utf-8",
    );
    const recovered = acquireSingleInstanceLock("stale.lock", { dir: tempDir, env: {} });
    expect(recovered).not.toBeNull();
    expect(recovered!.acquired).toBe(true);
    expect(recovered!.skipped).toBe(false);
    recovered!.release();
    expect(existsSync(staleLockPath)).toBe(false);
  });
});
