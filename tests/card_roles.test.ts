// SPDX-License-Identifier: GPL-3.0-or-later
/** Card roles must not expose incidental switches or generic editors. */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { IJobExecutor, JobSubmitOptions } from "../src/core/contracts.ts";
import {
  hasDeviceDetails,
  pruneTraySelection,
  supportsCardPower,
  trayEligible,
} from "../src/core/deviceControls.ts";
import { setDataPathOverrides } from "../src/core/jsonStore.ts";
import { createDeviceInfo, type DeviceInfo } from "../src/core/models.ts";
import { MijiaService, ServiceError } from "../src/core/service.ts";
import * as trayStore from "../src/core/trayStore.ts";
import { VirtualLightService } from "../src/core/virtualLightService.ts";
import type { FlattenedSpec, MijiaApiClient } from "../src/mijia/index.ts";
import { CameraWindowController } from "../src/ui/controllers/cameraPreviewController.ts";
import { DeviceCardController } from "../src/ui/controllers/deviceCardController.ts";
import { TrayManagerController } from "../src/ui/controllers/trayManagerController.ts";
import { TrayQuickWindowController } from "../src/ui/controllers/trayQuickController.ts";

interface PendingJob {
  fn: () => unknown;
  onSuccess?: (result: unknown) => void;
  onError?: (error: Error) => void;
}

class Jobs implements IJobExecutor {
  pending: PendingJob[] = [];

  submit<T>(fn: () => T | Promise<T>, options?: JobSubmitOptions<T>): void {
    this.pending.push({
      fn,
      onSuccess: options?.onSuccess as ((result: unknown) => void) | undefined,
      onError: options?.onError,
    });
  }

  cancelPending(): void {
    this.pending.length = 0;
  }

  shutdown(): void {
    this.pending.length = 0;
  }
}

interface Disposable {
  dispose(): void;
}

function makeDevice(model: string, kind: string, did = "test"): DeviceInfo {
  return createDeviceInfo({
    did,
    name: "测试设备",
    model,
    home_name: "家",
    room_name: "测试房间",
    online: true,
    spec_type: `urn:miot-spec-v2:device:${kind}:0000:test:1`,
  });
}

function makeSwitchSpec(): FlattenedSpec {
  return {
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
}

interface MockApi {
  authDataPath: string;
  apiBaseUrl: string;
  available: boolean;
  authData: Record<string, unknown>;
  getHomesList: ReturnType<typeof mock>;
  getDevicesList: ReturnType<typeof mock>;
  getSharedDevicesList: ReturnType<typeof mock>;
  getDevicesProp: ReturnType<typeof mock>;
  setDevicesProp: ReturnType<typeof mock>;
}

function createServiceFixture(tempDir: string): { service: MijiaService; api: MockApi } {
  const api: MockApi = {
    authDataPath: path.join(tempDir, "auth.json"),
    apiBaseUrl: "https://api.io.mi.com/app",
    available: true,
    authData: {},
    getHomesList: mock(async () => []),
    getDevicesList: mock(async () => []),
    getSharedDevicesList: mock(async () => []),
    getDevicesProp: mock(async (queries: Array<Record<string, unknown>>) =>
      queries.map((q) => ({ ...q, code: 0, value: q["siid"] !== 3 })),
    ),
    setDevicesProp: mock(async (queries: Array<Record<string, unknown>>) =>
      queries.map((q) => ({ ...q, code: 0 })),
    ),
  };

  const service = new MijiaService({ api: api as unknown as MijiaApiClient });
  for (const did of ["123", "123.s2", "123.s3", "123.s4", "123.s99"]) {
    service.deviceIndex.set(did, ["xiaomi.switch.w3", "test-spec", `Channel ${did}`]);
  }
  service.specCache.set("test-spec", makeSwitchSpec());
  return { service, api };
}

describe("CardRolesTest", () => {
  let tempDir: string;
  let cleanups: Disposable[];

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "mijiadeck-card-roles-"));
    setDataPathOverrides({
      dataDir: () => tempDir,
      dataFile: (name: string) => path.join(tempDir, name),
    });
    cleanups = [];
  });

  afterEach(() => {
    for (const item of cleanups) {
      item.dispose();
    }
    cleanups = [];
    setDataPathOverrides(null);
    rmSync(tempDir, { recursive: true, force: true });
  });

  function track<T extends Disposable>(item: T): T {
    cleanups.push(item);
    return item;
  }

  test("display devices ignore old cached on and cannot open generic editor", () => {
    const service = new VirtualLightService();
    const jobs = new Jobs();
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["xiaomi.router.rn01", "router"],
      ["anseny.sensor_ht.1", "temperature-humidity-sensor"],
      ["test.sensor_occupy.1", "occupancy-sensor"],
      ["test.remote.1", "remote-control"],
    ];

    for (const [model, kind] of cases) {
      const d = makeDevice(model, kind);
      expect(supportsCardPower(d)).toBe(false);
      expect(hasDeviceDetails(d)).toBe(false);

      const card = track(new DeviceCardController(d));
      card.setPowerState(true);
      expect(card.powerButtonVisible).toBe(false);
      expect(card.powerState).toBeNull();

      const opened = mock(() => {});
      card.on("openRequested", opened);
      card.clickCard();
      expect(opened).not.toHaveBeenCalled();

      expect(() => new CameraWindowController(service, jobs, d)).toThrow(
        "Only cameras use this preview window",
      );
    }
  });

  test("camera play buttons open once without power and disable when offline", () => {
    const stylesCss = readFileSync(
      path.resolve(import.meta.dir, "../src/web/styles.css"),
      "utf-8",
    );
    // Main card play button width is 36px and tray row play button width is 28px.
    expect(stylesCss).toMatch(/\.camera-play-btn\s*\{[^}]*width:\s*36px;/);
    expect(stylesCss).toMatch(/\.camera-play-btn\.sm\s*\{[^}]*width:\s*28px;/);

    for (const online of [true, false]) {
      const d = createDeviceInfo({
        ...makeDevice("test.camera.1", "camera", "camera"),
        online,
      });
      const card = track(new DeviceCardController(d));
      const opened = mock(() => {});
      const power = mock(() => {});
      card.on("openRequested", opened);
      card.on("powerClicked", power);

      card.clickPlayButton();
      expect(opened).toHaveBeenCalledTimes(online ? 1 : 0);
      expect(power).not.toHaveBeenCalled();
      expect(card.powerButtonVisible).toBe(false);
      expect(card.hasCameraCornerTag).toBe(true);
      expect(card.hasPlayButton).toBe(true);
      expect(card.playButtonEnabled).toBe(online);
      expect(card.playButtonWidth).toBe(36);
      expect(card.playButtonIconSize).toBe(26);

      const service = new VirtualLightService();
      const toggleSpy = spyOn(service, "togglePower");
      const quick = track(new TrayQuickWindowController(service, new Jobs()));
      quick.setDevices([d], { camera: true });
      quick.rebuild();

      const row = quick.makeRow(d);
      const trayOpened = mock(() => {});
      quick.events.on("openDeviceRequested", trayOpened);
      quick.clickCameraPlay(d.did);

      expect(trayOpened).toHaveBeenCalledTimes(online ? 1 : 0);
      expect(toggleSpy).not.toHaveBeenCalled();
      expect(row.hasPowerBtn).toBe(false);
      expect(row.hasPlayBtn).toBe(true);
      expect(row.playBtnEnabled).toBe(online);
      expect(row.hasCameraTag).toBe(true);
    }
  });

  test("real appliance roles keep quick power and tray eligibility, not generic details", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["test.tv.1", "television"],
      ["test.washer.1", "washer"],
      ["test.plug.1", "outlet"],
      ["test.switch.1", "switch"],
      ["test.light.1", "light"],
    ];
    for (const [model, kind] of cases) {
      const d = makeDevice(model, kind);
      expect(supportsCardPower(d)).toBe(true);
      expect(trayEligible(d)).toBe(true);
      expect(hasDeviceDetails(d)).toBe(false);
    }
  });

  test("router on property is never read or written as power", async () => {
    const { service, api } = createServiceFixture(tempDir);
    service.deviceIndex.set("router", ["xiaomi.router.rn01", "test-spec", "router"]);

    expect(await service.powerStates(["router"])).toEqual({ router: null });
    expect(api.getDevicesProp).not.toHaveBeenCalled();

    await expect(service.setPowerState("router", true)).rejects.toBeInstanceOf(ServiceError);
    expect(api.setDevicesProp).not.toHaveBeenCalled();
  });

  test("sensor class alone does not qualify without a supported readout", async () => {
    const { service, api } = createServiceFixture(tempDir);
    const specType = "urn:miot-spec-v2:device:occupancy-sensor:0000:test:1";
    api.getHomesList.mockResolvedValue([]);
    api.getDevicesList.mockResolvedValue([
      {
        did: "sensor",
        name: "电子围栏",
        model: "ainice.sensor_occupy.bt",
        spec_type: specType,
        isOnline: true,
      },
    ]);
    api.getSharedDevicesList.mockResolvedValue([]);
    service.specCache.set(specType, {
      name: "Occupancy Sensor",
      properties: [
        {
          name: "occupancy",
          description: "Occupancy",
          type: "bool",
          rw: "r",
          method: { siid: 2, piid: 1 },
        },
      ],
      actions: [],
    });

    const [sensor] = await service.listDevices();
    expect(sensor).toBeDefined();
    expect(sensor!.metric_features).toEqual([]);
    expect(trayEligible(sensor!)).toBe(false);

    service.specCache.get(specType)!.properties.push({
      name: "temperature",
      description: "Temperature",
      type: "float",
      rw: "r",
      method: { siid: 2, piid: 2 },
    });

    const [sensorWithTemp] = await service.listDevices();
    expect(sensorWithTemp).toBeDefined();
    expect(sensorWithTemp!.metric_features).toEqual(["temperature"]);
    expect(trayEligible(sensorWithTemp!)).toBe(true);
  });

  test("tray editor, pruneTraySelection, and TrayQuickWindowController use same roles while preserving scenes", () => {
    const router = makeDevice("xiaomi.router.rn01", "router", "router");
    const sensor = createDeviceInfo({
      ...makeDevice("test.sensor_ht.1", "temperature-humidity-sensor", "sensor"),
      metric_features: ["temperature"],
    });
    const camera = makeDevice("test.camera.1", "camera", "camera");
    const emptySensor = createDeviceInfo({
      ...makeDevice("ainice.sensor_occupy.bt", "occupancy-sensor", "empty-sensor"),
      metric_features: [],
    });

    trayStore.save(["router", "empty-sensor", "sensor", "missing"]);
    trayStore.saveScenes([
      { scene_id: "scene", name: "场景", home_id: "1", home_name: "家" },
    ]);
    trayStore.saveOrder([
      { type: "device", id: "router" },
      { type: "scene", id: "scene" },
      { type: "device", id: "sensor" },
      { type: "device", id: "missing" },
    ]);

    pruneTraySelection([router, emptySensor, sensor, camera]);

    expect(trayStore.load()).toEqual(["sensor", "missing"]);
    expect(trayStore.loadOrder()[0]).toEqual({ type: "scene", id: "scene" });
    expect(trayStore.loadScenes()).toHaveLength(1);

    const dialog = track(
      new TrayManagerController([router, emptySensor, sensor, camera], { scenes: [] }),
    );
    expect(new Set(dialog.deviceRows.map((r) => r.did))).toEqual(new Set(["sensor", "camera"]));

    const quick = track(new TrayQuickWindowController(new VirtualLightService(), new Jobs()));
    quick.setDevices([router, sensor, camera], { router: true, sensor: true });
    expect(new Set(quick.devices.map((d) => d.did))).toEqual(new Set(["sensor", "camera"]));

    quick.rebuild();
    const row = quick.rows.find((r) => r.type === "device" && r.id === "sensor");
    expect(row).toBeDefined();
    expect(row!.hasPowerBtn).toBe(false);
    expect(row!.cursor).toBe("default");
    expect(row!.clickable).toBe(false);
  });
});
