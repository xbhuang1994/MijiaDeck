// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * Split switch cards must address their own service on the parent hardware
 * (ported 1:1 from tests/split_switch_test.py).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { setPackagedOverride } from "../src/core/appMeta.ts";
import { NetworkMonitor } from "../src/core/availability.ts";
import type { IJobExecutor, JobSubmitOptions } from "../src/core/contracts.ts";
import { resetMigrationState, setDataPathOverrides } from "../src/core/jsonStore.ts";
import { createDeviceInfo } from "../src/core/models.ts";
import { MijiaService, ServiceError } from "../src/core/service.ts";
import type { FlattenedSpec, MijiaApiClient } from "../src/mijia/index.ts";
import { ALL_HOMES, ALL_ROOMS, MainWindowController } from "../src/ui/controllers/mainWindowController.ts";

const SPEC: FlattenedSpec = {
  name: "Three-channel switch",
  properties: [
    ...[2, 3, 4].map((s) => ({
      name: `on-${s}`,
      description: "Switch",
      type: "bool",
      rw: "rw",
      range: null,
      "value-list": null,
      method: { siid: s, piid: 1 },
    })),
    {
      name: "temperature",
      description: "Temperature",
      type: "float",
      rw: "r",
      range: null,
      method: { siid: 8, piid: 1 },
    },
  ],
  actions: [2, 3, 4].map((s) => ({
    name: `toggle-${s}`,
    description: "Toggle",
    method: { siid: s, aiid: 1 },
  })),
};

interface MockApiHandle {
  api: MijiaApiClient;
  getDevicesPropCalls: unknown[];
  setDevicesPropCalls: unknown[];
  getHomesListCount: number;
  getDevicesListCount: number;
  getSharedDevicesListCount: number;
  setGetDevicesPropHandler(fn: (queries: Record<string, unknown> | Array<Record<string, unknown>>) => unknown): void;
  setHomesListResult(rows: Array<Record<string, unknown>>): void;
  setDevicesListResult(rows: Array<Record<string, unknown>>): void;
  setSharedDevicesListResult(rows: Array<Record<string, unknown>>): void;
}

function createMockApi(): MockApiHandle {
  let getDevicesPropImpl = (
    queries: Record<string, unknown> | Array<Record<string, unknown>>,
  ): unknown => {
    const single = !Array.isArray(queries);
    const items = single ? [queries] : queries;
    const results = items.map((q) => ({ ...q, code: 0, value: q["siid"] !== 3 }));
    return single ? results[0] : results;
  };
  let homesResult: Array<Record<string, unknown>> = [];
  let devicesResult: Array<Record<string, unknown>> = [];
  let sharedResult: Array<Record<string, unknown>> = [];

  const handle: MockApiHandle = {
    api: null as unknown as MijiaApiClient,
    getDevicesPropCalls: [],
    setDevicesPropCalls: [],
    getHomesListCount: 0,
    getDevicesListCount: 0,
    getSharedDevicesListCount: 0,
    setGetDevicesPropHandler(fn) {
      getDevicesPropImpl = fn;
    },
    setHomesListResult(rows) {
      homesResult = rows;
    },
    setDevicesListResult(rows) {
      devicesResult = rows;
    },
    setSharedDevicesListResult(rows) {
      sharedResult = rows;
    },
  };

  const mockApi = {
    authDataPath: path.join("unused", "auth.json"),
    authData: {},
    apiBaseUrl: "https://api.io.mi.com/app",
    available: true,
    close: () => {},
    getHomesList: async () => {
      handle.getHomesListCount += 1;
      return homesResult;
    },
    getDevicesList: async () => {
      handle.getDevicesListCount += 1;
      return devicesResult;
    },
    getSharedDevicesList: async () => {
      handle.getSharedDevicesListCount += 1;
      return sharedResult;
    },
    getDevicesProp: async (
      queries: Record<string, unknown> | Array<Record<string, unknown>>,
    ): Promise<unknown> => {
      handle.getDevicesPropCalls.push(queries);
      return getDevicesPropImpl(queries);
    },
    setDevicesProp: async (
      queries: Record<string, unknown> | Array<Record<string, unknown>>,
    ): Promise<unknown> => {
      handle.setDevicesPropCalls.push(queries);
      const single = !Array.isArray(queries);
      const items = single ? [queries] : queries;
      const results = items.map((q) => ({ ...q, code: 0 }));
      return single ? results[0] : results;
    },
    runAction: async () => ({ code: 0 }),
  };

  handle.api = mockApi as unknown as MijiaApiClient;
  return handle;
}

describe("SplitSwitchTest", () => {
  let tempDir: string;
  let mockApi: MockApiHandle;
  let service: MijiaService;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "mijiadeck-split-switch-"));
    setPackagedOverride(null);
    resetMigrationState();
    setDataPathOverrides({
      dataDir: () => tempDir,
      dataFile: (filename) => path.join(tempDir, filename),
    });

    mockApi = createMockApi();
    service = new MijiaService({
      api: mockApi.api,
      specFetcher: async () => structuredClone(SPEC),
    });
    for (const did of ["123", "123.s2", "123.s3", "123.s4", "123.s99"]) {
      service.deviceIndex.set(did, ["xiaomi.switch.w3", "test-spec", `Channel ${did}`]);
    }
    service.specCache.set("test-spec", structuredClone(SPEC));
  });

  afterEach(() => {
    setDataPathOverrides(null);
    setPackagedOverride(null);
    resetMigrationState();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("three cards read distinct channels from parent", async () => {
    const states = await service.powerStates(["123.s2", "123.s3", "123.s4"]);
    expect(states).toEqual({ "123.s2": true, "123.s3": false, "123.s4": true });
    expect(mockApi.getDevicesPropCalls.at(-1)).toEqual([
      { did: "123", siid: 2, piid: 1 },
      { did: "123", siid: 3, piid: 1 },
      { did: "123", siid: 4, piid: 1 },
    ]);
  });

  test("initial list reuses metadata instead of fetching lists again", async () => {
    service.deviceIndex.clear();
    mockApi.setHomesListResult([]);
    mockApi.setDevicesListResult([
      {
        did: "123.s3",
        model: "xiaomi.switch.w3",
        spec_type: "test-spec",
        name: "Light",
        isOnline: true,
      },
    ]);
    mockApi.setSharedDevicesListResult([]);

    await service.listDevices();
    expect(await service.powerState("123.s3")).toBe(false);
    expect(mockApi.getDevicesListCount).toBe(1);
    expect(mockApi.getSharedDevicesListCount).toBe(1);
  });

  test("parent is read-only and split cards keep distinct states", async () => {
    const states = await service.powerStates(["123", "123.s2", "123.s3"]);
    expect(states).toEqual({ "123": null, "123.s2": true, "123.s3": false });
    const lastBatch = mockApi.getDevicesPropCalls.at(-1) as Array<Record<string, unknown>>;
    expect(lastBatch.length).toBe(2);
  });

  test("toggle writes only selected channel", async () => {
    expect(await service.togglePower("123.s3")).toBe(true);
    expect(mockApi.setDevicesPropCalls).toEqual([[{ did: "123", siid: 3, piid: 1, value: true }]]);
  });

  test("missing channel .s99 does not fall back to another light", async () => {
    expect(await service.powerStates(["123.s99"])).toEqual({ "123.s99": null });
    await expect(service.setPowerState("123.s99", true)).rejects.toThrow(ServiceError);
    expect(mockApi.setDevicesPropCalls.length).toBe(0);
  });

  test("specs are filtered without mutating shared cache", async () => {
    const specs = await service.specsFor(["123.s3", "123.s4", "123"]);
    expect(specs["123.s3"]!.properties.map((p) => p.name)).toEqual(["on-3"]);
    expect(specs["123.s4"]!.properties.map((p) => p.name)).toEqual(["on-4"]);
    expect(service.specCache.get("test-spec")).toEqual(SPEC);
    expect(specs["123"]).toEqual(SPEC);
  });

  test("detail reads and writes use parent but preserve card id", async () => {
    const detail = await service.deviceDetail("123.s4");
    expect(detail.did).toBe("123.s4");
    expect(detail.props.map((p) => p.name)).toEqual(["on-4"]);
    expect(detail.actions.map((a) => a.name)).toEqual(["toggle-4"]);

    const dev = service.deviceCache.get("123.s4")!;
    dev.sleepTime = 0;

    expect(await service.readProps("123.s4", ["on-4"])).toEqual({ "on-4": true });
    expect(await service.readProp("123.s4", "on_4")).toBe(true);

    await service.writeProp("123.s4", "on-4", false);
    expect(mockApi.setDevicesPropCalls).toEqual([{ did: "123", siid: 4, piid: 1, value: false }]);

    await expect(service.writeProp("123.s4", "on-2", true)).rejects.toThrow(ServiceError);
  });

  test("failed read is unknown (null) and recovers", async () => {
    mockApi.setGetDevicesPropHandler(() => [{ did: "123", siid: 3, piid: 1, code: -1 }]);
    expect(await service.powerStates(["123.s3"])).toEqual({ "123.s3": null });

    mockApi.setGetDevicesPropHandler(() => [
      { did: "123", siid: 3, piid: 1, code: 0, value: false },
    ]);
    expect(await service.powerStates(["123.s3"])).toEqual({ "123.s3": false });
  });

  test("poll retries cached unknown (null) but skips offline devices", async () => {
    const submitted: Array<() => unknown | Promise<unknown>> = [];
    const mockJobs: IJobExecutor = {
      submit<T>(fn: () => T | Promise<T>, _options?: JobSubmitOptions<T>): void {
        submitted.push(fn);
      },
      cancelPending(): void {},
      shutdown(): void {},
    };

    const monitor = new NetworkMonitor({ initialReachability: "online", autoStart: false });
    const window = new MainWindowController({
      service,
      jobs: mockJobs,
      networkMonitor: monitor,
      tray: null,
      autoStartTimers: false,
    });

    try {
      window.loggedOut = false;
      window.networkOnline = true;
      window.syncAccessUi();
      window.currentHome = ALL_HOMES;
      window.currentRoom = ALL_ROOMS;
      window.allDevices = [
        createDeviceInfo({
          did: "123.s3",
          name: "Channel 123.s3",
          model: "xiaomi.switch.w3",
          home_name: "Home",
          room_name: "Room",
          online: true,
          spec_type: "test-spec",
        }),
        createDeviceInfo({
          did: "offline",
          name: "Offline Switch",
          model: "xiaomi.switch.w3",
          home_name: "Home",
          room_name: "Room",
          online: false,
          spec_type: "test-spec",
        }),
      ];
      window.knownPower = { "123.s3": null };

      for (const force of [false, true]) {
        submitted.length = 0;
        window.refreshPowerStates(force);
        expect(submitted.length).toBe(1);
        const result = await submitted[0]!();
        expect(result).toEqual({ "123.s3": false });
      }
    } finally {
      window.dispose();
      monitor.stop();
    }
  });
});
