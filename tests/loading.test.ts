// SPDX-License-Identifier: GPL-3.0-or-later
/** Loading progress follows real work, survives status updates, and cancels safely. */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { APP_NAME } from "../src/core/appMeta.ts";
import type { IJobExecutor, JobSubmitOptions } from "../src/core/contracts.ts";
import { setDataPathOverrides } from "../src/core/jsonStore.ts";
import { createDeviceInfo } from "../src/core/models.ts";
import { MijiaService } from "../src/core/service.ts";
import { VirtualLightService } from "../src/core/virtualLightService.ts";
import type { MijiaApiClient } from "../src/mijia/index.ts";
import { MainWindowController } from "../src/ui/controllers/mainWindowController.ts";
import { SiColors, applyTheme, buildCss, setAccent, setTheme } from "../src/ui/theme.ts";

interface QueuedJob {
  fn: () => unknown | Promise<unknown>;
  onSuccess?: (result: unknown) => void;
  onError?: (error: Error) => void;
}

class FakeJobs implements IJobExecutor {
  readonly pending: QueuedJob[] = [];

  submit<T>(fn: () => T | Promise<T>, options?: JobSubmitOptions<T>): void {
    this.pending.push({
      fn,
      onSuccess: options?.onSuccess as ((result: unknown) => void) | undefined,
      onError: options?.onError,
    });
  }

  async finish(): Promise<void> {
    const job = this.pending.shift();
    if (!job) {
      throw new Error("No pending job to finish");
    }
    try {
      const result = await job.fn();
      job.onSuccess?.(result);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      job.onError?.(error);
    }
  }

  cancelPending(): void {
    this.pending.length = 0;
  }

  shutdown(): void {
    this.pending.length = 0;
  }
}

describe("LoadingTest", () => {
  let tempDir = "";
  let service: VirtualLightService;
  let jobs: FakeJobs;
  let window: MainWindowController;

  function createWindow(
    overrides: Partial<ConstructorParameters<typeof MainWindowController>[0]> = {},
  ): MainWindowController {
    const win = new MainWindowController({
      service,
      jobs,
      tray: null,
      cacheLoader: () => null,
      cacheSaver: () => {},
      ...overrides,
    });
    win.loggedOut = false;
    win.syncAccessUi();
    return win;
  }

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "mijiadeck-loading-test-"));
    const dir = tempDir;
    setDataPathOverrides({
      dataDir: () => dir,
      dataFile: (name) => path.join(dir, name),
    });
    setAccent("green");
    setTheme("dark");
    service = new VirtualLightService();
    jobs = new FakeJobs();
    window = createWindow();
  });

  afterEach(() => {
    window.dispose();
    setAccent("green");
    setTheme("dark");
    setDataPathOverrides(null);
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = "";
    }
  });

  test("first login central loading waits for initial states and hides footer during full-page load", async () => {
    window.startupLoad();
    expect(window.loadActive).toBe(true);
    expect(window.activeContentView).toBe("loading");
    expect(window.footerVisible).toBe(false);

    // Finish device list job; power & metrics jobs follow
    await jobs.finish();
    expect(window.loadPending).toEqual(new Set(["power", "metrics"]));
    expect(window.footer.progressVisible).toBe(false);
    expect(window.footer.statusText).toBe("");
    expect(window.loadingPageProgress).toBe(80);

    // Finish initial switch state; controllable light needs no sensor request
    await jobs.finish();
    expect(window.loadActive).toBe(false);
    expect(window.activeContentView).toBe("normal");
    expect(window.footerVisible).toBe(true);
    expect(window.footer.progressVisible).toBe(false);
  });

  test("metrics wait for live power and skip offline devices", async () => {
    const light = createDeviceInfo(service.device);
    const sensor = createDeviceInfo({
      ...light,
      did: "sensor",
      name: "测试传感器",
      model: "test.sensor",
    });
    const offline = createDeviceInfo({
      ...sensor,
      did: "offline",
      online: false,
    });

    const powerStatesMock = mock(async () => ({
      [light.did]: true,
      [sensor.did]: null,
    }));
    const readMetricsMock = mock(async (_dids: string[]) => ({
      [sensor.did]: "24°C",
    }));
    service.powerStates = powerStatesMock;
    service.readMetrics = readMetricsMock;

    window.beginLoading(true);
    window.onDevicesLoaded([light, sensor, offline]);
    expect(readMetricsMock).not.toHaveBeenCalled();

    while (window.loadActive && jobs.pending.length > 0) {
      await jobs.finish();
    }

    expect(readMetricsMock).toHaveBeenCalledTimes(1);
    expect(readMetricsMock).toHaveBeenCalledWith([sensor.did]);
    expect(window.loadActive).toBe(false);
  });

  test("cached startup refreshes saved power before dismissing loading", async () => {
    const device = createDeviceInfo(service.device);
    window.dispose();
    window = createWindow({
      cacheLoader: () => ({
        devices: [device],
        knownPower: { [device.did]: false },
        metrics: {},
      }),
    });

    window.startupLoad();
    expect(window.loadActive).toBe(true);
    await jobs.finish();
    expect(window.knownPower[device.did]).toBe(true);
    expect(window.loadActive).toBe(false);
  });

  test("manual refresh keeps content visible and clearStatusHint cannot erase footer progress", () => {
    window.loadDevices({ manual: true });
    expect(window.activeContentView).toBe("normal");
    window.onLoadingProgress(window.loadGeneration, 45, "正在读取共享设备…");
    window.clearStatusHint();
    expect(window.footer.progressVisible).toBe(true);
    expect(window.footer.statusText).toBe("正在读取共享设备…");
    expect(window.footer.progressValue).toBe(45);
  });

  test("refresh timeout stops spinner and late result cannot replace new refresh", async () => {
    window.loadDevices({ manual: true });
    const ticket = window.loadGeneration;
    expect(window.loadingDevices).toBe(true);
    expect(window.refreshSpinning).toBe(true);

    window.onLoadingTimeout();
    expect(window.loadingDevices).toBe(false);
    expect(window.refreshSpinning).toBe(false);
    expect(window.loadActive).toBe(false);
    expect(window.loadWatchdogActive).toBe(false);
    expect(window.footer.statusText).toContain("刷新超时");

    window.loadDevices({ manual: true });
    const current = window.loadGeneration;
    window.acceptDeviceList(ticket, []);
    expect(window.loadGeneration).toBe(current);
    expect(window.loadPending).toEqual(new Set(["list"]));

    // Old queued result is discarded
    await jobs.finish();
    expect(window.loadPending).toEqual(new Set(["list"]));

    // New list and follow-up state jobs finish normally
    while (window.loadActive && jobs.pending.length > 0) {
      await jobs.finish();
    }
    expect(window.loadActive).toBe(false);
  });

  test("empty account and state failure never leave loading page stuck", () => {
    window.beginLoading(true);
    window.onDevicesLoaded([]);
    expect(window.loadActive).toBe(false);

    window.beginLoading(true);
    window.prepareLoadingStates();
    const ticket = window.loadGeneration;
    window.onPollError(new Error("offline test"), ticket);
    window.onMetricsError(new Error("offline test"), ticket);
    expect(window.loadActive).toBe(false);
    expect(window.activeContentView).toBe("normal");
  });

  test("disconnect cancels both progress views and ignores stale worker events", () => {
    window.beginLoading(true);
    const ticket = window.loadGeneration;
    window.onNetworkChanged(false);
    expect(window.loadActive).toBe(false);
    expect(window.footer.progressVisible).toBe(false);

    window.onLoadingProgress(ticket, 75, "stale");
    expect(window.footer.statusText).not.toBe("stale");
    expect(window.activeContentView).toBe("normal");
  });

  test("async worker updates central view, saved accent is applied, and brand name matches APP_NAME", async () => {
    applyTheme("dark", "#8044cc");
    window.beginLoading(true);
    const ticket = window.loadGeneration;

    await Promise.resolve().then(() => {
      window.onLoadingProgress(ticket, 65, "正在识别灯光控制能力…");
    });

    expect(window.footer.progressVisible).toBe(false);
    expect(window.loadingPageProgress).toBe(65);
    expect(window.loadingPageText).toBe("正在识别灯光控制能力…");
    expect(SiColors.THEME).toBe("#8044cc");

    const css = buildCss();
    expect(css).toContain(SiColors.THEME);
    expect(css).toContain(`.reserved-footer .progress-chunk {\n  background: ${SiColors.THEME};`);
    expect(window.title).toBe(APP_NAME);
  });

  test("MijiaService.listDevices emits stage progress around completed API calls", async () => {
    const events: Array<number | string> = [];
    const mockApi = {
      getHomesList: mock(async () => {
        events.push("getHomesList");
        return [];
      }),
      getDevicesList: mock(async () => {
        events.push("getDevicesList");
        return [];
      }),
      getSharedDevicesList: mock(async () => {
        events.push("getSharedDevicesList");
        return [];
      }),
    } as unknown as MijiaApiClient;

    const realService = new MijiaService({ api: mockApi });
    await realService.listDevices((value) => {
      events.push(value);
    });

    expect(events.slice(0, 6)).toEqual([
      8,
      "getHomesList",
      25,
      "getDevicesList",
      45,
      "getSharedDevicesList",
    ]);
    expect(events[events.length - 1]).toBe(75);
  });
});
