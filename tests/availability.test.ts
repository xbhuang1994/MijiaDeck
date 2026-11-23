// SPDX-License-Identifier: GPL-3.0-or-later
/** Logged-out/offline UI must not expose cached device or speaker controls. */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  MESSAGES,
  NetworkMonitor,
  PROBE_TIMEOUT_MS,
  PROBE_URL,
  speakerHint,
  type Reachability,
} from "../src/core/availability.ts";
import type { IJobExecutor, IMijiaService, JobSubmitOptions } from "../src/core/contracts.ts";
import { setDataPathOverrides } from "../src/core/jsonStore.ts";
import { createDeviceInfo, type DeviceInfo } from "../src/core/models.ts";
import { MijiaService, ServiceError } from "../src/core/service.ts";
import type { MijiaApiClient } from "../src/mijia/index.ts";
import { MainWindowController } from "../src/ui/controllers/mainWindowController.ts";
import type { TrayQuickWindowController } from "../src/ui/controllers/trayQuickController.ts";

class FakeNetworkMonitor extends NetworkMonitor {
  checkNowCalls = 0;

  constructor(initialOnline = true) {
    super({
      initialReachability: initialOnline ? "online" : "disconnected",
      autoStart: false,
    });
  }

  override checkNow(): Promise<boolean> {
    this.checkNowCalls += 1;
    return Promise.resolve(this.online);
  }
}

function createMockService(): IMijiaService {
  return {
    setControlAccess: mock(() => {}),
    apiVersion: mock(() => "1.0.0"),
    accountId: mock(() => ""),
    logout: mock(async () => {}),
    loginStatus: mock(() => false),
    qrLoginBegin: mock(async () => null),
    qrLoginWait: mock(async () => {}),
    listDevices: mock(async () => []),
    deviceDetail: mock(async (did: string) => ({
      did,
      name: "",
      model: "",
      props: [],
      actions: [],
    })),
    readProp: mock(async () => null),
    readProps: mock(async () => ({})),
    writeProp: mock(async () => {}),
    runAction: mock(async () => {}),
    powerState: mock(async () => null),
    togglePower: mock(async () => false),
    setPowerState: mock(async () => {}),
    powerStates: mock(async () => ({})),
    readMetrics: mock(async () => ({})),
    sceneList: mock(async () => []),
    runScene: mock(async () => {}),
    iconUrls: mock(async () => ({})),
    iconFile: mock(async () => null),
    hasProductPageName: mock(() => false),
    cachedProductPageNames: mock(() => ({})),
    productPageName: mock(async () => null),
    specHasPublishedFunctions: mock(() => null),
    localizedProductNames: mock(() => ({})),
    prepareCameraSource: mock(async () => null),
    recordDeviceObservation: mock(() => {}),
    deviceDiagnosticReport: mock(async () => ""),
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("AvailabilityTest", () => {
  let tempDir: string;
  let service: IMijiaService;
  let submitMock: ReturnType<typeof mock>;
  let jobs: IJobExecutor;
  let monitor: FakeNetworkMonitor;
  let win: MainWindowController;
  let quick: TrayQuickWindowController;
  let speaker: DeviceInfo;
  let light: DeviceInfo;
  let extraMonitors: NetworkMonitor[];

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "mijiadeck-availability-"));
    setDataPathOverrides({
      dataDir: () => tempDir,
      dataFile: (name: string) => path.join(tempDir, name),
    });

    service = createMockService();
    submitMock = mock((_fn: () => unknown, _options?: JobSubmitOptions<unknown>) => {});
    jobs = {
      submit: submitMock as IJobExecutor["submit"],
      cancelPending: mock(() => {}),
      shutdown: mock(() => {}),
    };
    monitor = new FakeNetworkMonitor(true);
    win = new MainWindowController({
      service,
      jobs,
      networkMonitor: monitor,
      initiallyVisible: false,
    });
    quick = win.tray!.quick;
    speaker = createDeviceInfo({
      did: "speaker",
      name: "Speaker",
      model: "xiaomi.wifispeaker.test",
      home_name: "Home",
      room_name: "Room",
      online: true,
    });
    light = createDeviceInfo({
      did: "light",
      name: "Light",
      model: "test.light.test",
      home_name: "Home",
      room_name: "Room",
      online: true,
    });
    extraMonitors = [];
  });

  afterEach(() => {
    for (const m of extraMonitors) {
      m.stop();
    }
    extraMonitors = [];
    monitor.stop();
    win.dispose();
    setDataPathOverrides(null);
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("no login shows no cached scenes, devices, or speaker controls", () => {
    quick.setDevices([speaker, light], { light: true });
    quick.showNearTray();

    expect(quick.emptyText).toBe(MESSAGES.signed_out);
    expect(quick.listVisible).toBe(false);
    expect(quick.audioBarVisible).toBe(false);
    expect(quick.voiceBarVisible).toBe(false);
    expect(win.scrollVisible).toBe(false);
  });

  test("logged-out tray click opens login in main window instead of quick popup", async () => {
    const loginSpy = spyOn(win, "loginAccount").mockImplementation(() => {});
    expect(win.isVisible()).toBe(false);

    win.tray!.onActivated("trigger");
    await Bun.sleep(20);

    expect(win.isVisible()).toBe(true);
    expect(loginSpy).toHaveBeenCalledTimes(1);
    expect(quick.visible).toBe(false);
  });

  test("disconnect replaces controls with offline message without reading states or running timers", () => {
    win.loggedOut = false;
    win.allDevices = [light, speaker];
    win.syncAccessUi();
    quick.setDevices([light, speaker], { light: true });
    submitMock.mockClear();

    win.onNetworkChanged(false);
    quick.showNearTray();

    expect(quick.emptyText).toBe(MESSAGES.offline);
    expect(quick.listVisible).toBe(false);
    expect(quick.audioBarVisible).toBe(false);
    expect(quick.voiceBarVisible).toBe(false);
    expect(quick.dragHeaderVisible).toBe(false);
    expect(win.scrollVisible).toBe(false);
    expect(win.pollTimerActive).toBe(false);
    expect(win.metricsTimerActive).toBe(false);

    win.refreshPowerStates(true);
    win.refreshMetrics();
    expect(submitMock).not.toHaveBeenCalled();
  });

  test("reconnect waits for device refresh before restoring controls", () => {
    win.loggedOut = false;
    win.onNetworkChanged(false);
    const loadSpy = spyOn(win, "loadDevices").mockImplementation(() => {});

    win.onNetworkChanged(true);
    expect(win.accessState()).toBe("loading");
    expect(loadSpy).toHaveBeenCalledTimes(1);
    expect(win.scrollVisible).toBe(false);

    win.onDevicesLoaded([light]);
    expect(win.accessState()).toBe("ready");
    expect(win.scrollVisible).toBe(true);
  });

  test("no speaker and offline speaker show distinct hints", () => {
    win.loggedOut = false;
    const offlineSpeaker = createDeviceInfo({
      did: "s",
      name: "Speaker",
      model: "xiaomi.wifispeaker.test",
      home_name: "H",
      room_name: "R",
      online: false,
    });

    const cases: ReadonlyArray<readonly [DeviceInfo[], string]> = [
      [[light], "当前你还没有添加任何智能音箱"],
      [[offlineSpeaker], "智能音箱当前离线"],
    ];

    for (const [devices, expected] of cases) {
      win.allDevices = devices;
      win.syncAccessUi();
      quick.setDevices(devices, {});
      expect(win.accessHintText).toBe(expected);
      expect(quick.speakerHintText).toBe(expected);
      expect(quick.audioBarVisible).toBe(false);
      expect(quick.voiceBarVisible).toBe(false);
      expect(win.voiceFab.visible).toBe(false);
    }

    expect(speakerHint([speaker])).toBe("");
  });

  test("blocked service does not execute previously queued controls and makes zero API calls", async () => {
    const api = {
      authDataPath: path.join(tempDir, "auth.json"),
      apiBaseUrl: "https://api.io.mi.com/app",
      available: true,
      authData: {},
      getHomesList: mock(async () => []),
      getDevicesList: mock(async () => []),
      getSharedDevicesList: mock(async () => []),
      getDevicesProp: mock(async () => []),
      setDevicesProp: mock(async () => []),
      runAction: mock(async () => ({})),
      getScenesList: mock(async () => []),
      runScene: mock(async () => true),
      postEncrypted: mock(async () => ({})),
    };
    const blockedService = new MijiaService({ api: api as unknown as MijiaApiClient });
    blockedService.setControlAccess(MESSAGES.offline);

    const operations: Array<() => Promise<unknown>> = [
      () => blockedService.setPowerState("light", true),
      () => blockedService.writeProp("light", "on", true),
      () => blockedService.runAction("speaker", "play"),
      () => blockedService.powerStates(["light"]),
      () => blockedService.readMetrics(["light"]),
    ];

    for (const operation of operations) {
      await expect(operation()).rejects.toBeInstanceOf(ServiceError);
    }

    expect(api.getHomesList).not.toHaveBeenCalled();
    expect(api.getDevicesList).not.toHaveBeenCalled();
    expect(api.getSharedDevicesList).not.toHaveBeenCalled();
    expect(api.getDevicesProp).not.toHaveBeenCalled();
    expect(api.setDevicesProp).not.toHaveBeenCalled();
    expect(api.runAction).not.toHaveBeenCalled();
    expect(api.getScenesList).not.toHaveBeenCalled();
    expect(api.runScene).not.toHaveBeenCalled();
    expect(api.postEncrypted).not.toHaveBeenCalled();
  });

  test("system network reachability does not treat unknown as logout", () => {
    const offlineStatuses: readonly Reachability[] = ["disconnected", "local", "site"];
    for (const status of offlineStatuses) {
      expect(NetworkMonitor.isReachabilityOnline(status)).toBe(false);
    }
    const onlineStatuses: readonly Reachability[] = ["unknown", "online"];
    for (const status of onlineStatuses) {
      expect(NetworkMonitor.isReachabilityOnline(status)).toBe(true);
    }
  });

  test("failed HTTP probe overrides Windows online and recovery requires real HTTP 200-499 response", async () => {
    expect(new URL(PROBE_URL).hostname).toBe("api.io.mi.com");
    expect(PROBE_TIMEOUT_MS).toBe(2500);

    const first = createDeferred<Response>();
    const second = createDeferred<Response>();
    const third = createDeferred<Response>();
    const responses = [first.promise, second.promise, third.promise];
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];

    const asFetch = (
      fn: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
    ): typeof fetch => Object.assign(fn, { preconnect: fetch.preconnect }) as typeof fetch;

    const fetcher = asFetch((input, init) => {
      requests.push({ url: String(input), init });
      const next = responses.shift();
      if (!next) {
        return Promise.reject(new Error("Unexpected extra probe"));
      }
      return next;
    });

    const netMonitor = new NetworkMonitor({
      initialReachability: "online",
      fetcher,
      autoStart: false,
    });
    extraMonitors.push(netMonitor);

    const changes: boolean[] = [];
    netMonitor.on("changed", (online) => {
      changes.push(online);
    });

    const p1 = netMonitor.checkNow();
    const p2 = netMonitor.checkNow();
    expect(p1).toBe(p2);
    expect(requests).toHaveLength(1); // single-flight

    // No HTTP response despite Windows reporting online
    first.reject(new TypeError("Failed to fetch"));
    await p1;
    expect(netMonitor.online).toBe(false);

    // Windows reporting Online cannot restore availability without a fresh HTTP 200-499 response
    netMonitor.onSystemReachabilityChanged("online");
    expect(netMonitor.online).toBe(false);
    expect(requests).toHaveLength(2);

    // HTTP 500 is outside 200-499 and must not count as recovered
    second.resolve(new Response(null, { status: 500 }));
    await netMonitor.checkNow();
    expect(netMonitor.online).toBe(false);

    // Real HTTP 404 (within 200-499; root need not be a page) restores online
    const p3 = netMonitor.checkNow();
    expect(requests).toHaveLength(3);
    third.resolve(new Response(null, { status: 404 }));
    await p3;

    expect(netMonitor.online).toBe(true);
    expect(changes).toEqual([false, true]);
    expect(new URL(requests[0]!.url).hostname).toBe("api.io.mi.com");
    expect(requests[0]!.init?.method).toBe("HEAD");
    expect(requests[0]!.init?.cache).toBe("no-store");
    expect(requests[0]!.init?.signal).toBeInstanceOf(AbortSignal);

    // Verify timeout aborts hanging probe and marks monitor offline
    let aborted = false;
    const hangingFetcher = asFetch(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(init.signal?.reason ?? new DOMException("Timed out", "TimeoutError"));
          });
        }),
    );

    const timeoutMonitor = new NetworkMonitor({
      initialReachability: "online",
      fetcher: hangingFetcher,
      timeoutMs: 30,
      autoStart: false,
    });
    extraMonitors.push(timeoutMonitor);

    const onlineAfterTimeout = await timeoutMonitor.checkNow();
    expect(aborted).toBe(true);
    expect(onlineAfterTimeout).toBe(false);
    expect(timeoutMonitor.online).toBe(false);
  });
});
