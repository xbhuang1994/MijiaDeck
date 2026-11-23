// SPDX-License-Identifier: GPL-3.0-or-later
/** Footer status/account UI, per-account preference isolation, logout cleanup, job cancel, and auto-update flow. */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as accountStore from "../src/core/accountStore.ts";
import { TypedEmitter } from "../src/core/contracts.ts";
import { JobExecutor } from "../src/core/jobs.ts";
import { setDataPathOverrides } from "../src/core/jsonStore.ts";
import { MijiaService } from "../src/core/service.ts";
import * as settingsStore from "../src/core/settingsStore.ts";
import type { ReleaseInfo } from "../src/core/updateChecker.ts";
import type { MijiaApiClient, MijiaDevice } from "../src/mijia/index.ts";
import { FooterBarController } from "../src/ui/controllers/footerBarController.ts";
import { checkUpdate, type UpdateHost } from "../src/ui/controllers/updateFlow.ts";
import { setAccent, setTheme } from "../src/ui/theme.ts";

describe("FooterAccountTest", () => {
  let tempDir = "";

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "mijiadeck-footer-account-test-"));
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

  test("status replaces version and update badge until cleared, and login/logout label toggles", () => {
    const bar = new FooterBarController(30);
    bar.setRelease({
      tag: "v0.4.0",
      url: "https://github.com/example/project/releases/v0.4.0",
      name: "New",
    });
    expect(bar.versionVisible).toBe(true);
    expect(bar.updateButtonVisible).toBe(true);

    bar.setStatus("正在获取设备列表…");
    expect(bar.versionVisible).toBe(false);
    expect(bar.updateButtonVisible).toBe(false);
    expect(bar.statusVisible).toBe(true);

    bar.setStatus("");
    expect(bar.versionVisible).toBe(true);
    expect(bar.updateButtonVisible).toBe(true);

    bar.setLoggedIn(false);
    expect(bar.accountText).toBe("登录账号");
    expect(bar.accountVisible).toBe(true);

    bar.setLoggedIn(true);
    expect(bar.accountText).toBe("退出登录");
  });

  test("preferences are restored per account without changing theme and devices_cache is cleared on deactivate", () => {
    const trayPath = path.join(tempDir, "tray.json");
    const cachePath = path.join(tempDir, "devices_cache.json");
    const trayA = {
      version: 1,
      devices: ["device-a"],
      scenes: [{ scene_id: "scene-a" }],
    };

    writeFileSync(trayPath, JSON.stringify(trayA), "utf-8");
    settingsStore.setThemeColor("blue");
    settingsStore.setDefaultSpeakerDid("speaker-a");
    accountStore.activate("account-a");

    writeFileSync(cachePath, "{}", "utf-8");
    accountStore.deactivate();
    expect(existsSync(cachePath)).toBe(false);

    accountStore.activate("account-b");
    expect(JSON.parse(readFileSync(trayPath, "utf-8"))).toEqual({});

    writeFileSync(trayPath, JSON.stringify({ version: 1, devices: ["device-b"] }), "utf-8");
    accountStore.deactivate();

    accountStore.activate("account-a");
    expect(JSON.parse(readFileSync(trayPath, "utf-8"))).toEqual(trayA);
    expect(settingsStore.getDefaultSpeakerDid()).toBe("speaker-a");
    expect(settingsStore.getThemeColor()).toBe("blue");
  });

  test("MijiaService.logout removes only test auth file, closes session, and clears caches", async () => {
    const authPath = path.join(tempDir, "auth.json");
    writeFileSync(authPath, "{}", "utf-8");

    const closeMock = mock(() => {});
    const oldApi = {
      authData: { userId: "test" } as Record<string, unknown>,
      authDataPath: authPath,
      close: closeMock,
    };
    const replacementApi = {
      authData: {} as Record<string, unknown>,
      authDataPath: authPath,
    };

    const service = new MijiaService({
      api: oldApi as unknown as MijiaApiClient,
      apiFactory: () => replacementApi as unknown as MijiaApiClient,
    });
    service.deviceCache.set("old", {} as MijiaDevice);
    service.deviceIndex.set("old", ["model.old", "urn:spec", "Old Device"]);
    service.homeIds = new Map([["old", "home"]]);

    await service.logout();

    expect(existsSync(authPath)).toBe(false);
    expect(oldApi.authData).toEqual({});
    expect(closeMock).toHaveBeenCalledTimes(1);
    expect(service.deviceCache.size).toBe(0);
    expect(service.deviceIndex.size).toBe(0);
    expect(service.homeIds).toBeNull();
    expect(service.api).toBe(replacementApi as unknown as MijiaApiClient);
  });

  test("JobExecutor.cancelPending discards old account callbacks and queued tasks while running new account jobs", async () => {
    const jobs = new JobExecutor();
    let resolveStarted!: () => void;
    let resolveRelease!: () => void;
    let resolveNewDone!: () => void;

    const started = new Promise<void>((r) => {
      resolveStarted = r;
    });
    const release = new Promise<void>((r) => {
      resolveRelease = r;
    });
    const newDone = new Promise<void>((r) => {
      resolveNewDone = r;
    });

    const oldResult = mock((_val: string) => {});
    const oldQueued = mock(() => "old-queued");
    const newResult = mock((_val: string) => {
      resolveNewDone();
    });

    try {
      jobs.submit(
        async () => {
          resolveStarted();
          await release;
          return "old";
        },
        { onSuccess: oldResult },
      );

      await started;
      jobs.submit(oldQueued);
      jobs.cancelPending();
      jobs.submit(() => "new", { onSuccess: newResult });

      resolveRelease();
      await newDone;

      expect(oldResult).not.toHaveBeenCalled();
      expect(oldQueued).not.toHaveBeenCalled();
      expect(newResult).toHaveBeenCalledTimes(1);
      expect(newResult).toHaveBeenCalledWith("new");
    } finally {
      resolveRelease();
      await jobs.shutdown();
    }
  });

  test("automatic update check uses footer onUpdateAvailable without modal prompt", async () => {
    const info: ReleaseInfo = {
      tag: "v999.0.0",
      url: "https://github.com/example/project/releases/v999.0.0",
      name: "New",
    };

    class FakeChecker extends TypedEmitter<{
      checkFinished: [ReleaseInfo | null, Error | null];
    }> {
      async check(): Promise<void> {
        this.emit("checkFinished", info, null);
      }
    }

    const onUpdateAvailable = mock((_release: ReleaseInfo | null) => {});
    const promptNewVersion = mock((_release: ReleaseInfo) => {});
    const showToast = mock((_text: string, _durationMs?: number) => {});
    const host: UpdateHost = {
      onUpdateAvailable,
      promptNewVersion,
      showToast,
    };

    await checkUpdate(host, {
      manual: false,
      checker: new FakeChecker(),
    });

    expect(onUpdateAvailable).toHaveBeenCalledTimes(1);
    expect(onUpdateAvailable).toHaveBeenCalledWith(info);
    expect(promptNewVersion).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });
});
