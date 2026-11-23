// SPDX-License-Identifier: GPL-3.0-or-later
/** Full device detail model, MIoT spec enrichment, controller state machine, and REST API tests. */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { IJobExecutor, JobSubmitOptions } from "../src/core/contracts.ts";
import {
  actionRequiresConfirmation,
  choosePropertyWidget,
  classifyDeviceProps,
  coercePropWriteValue,
  deviceCategoryLabel,
  formatPropertyValue,
  friendlyLabel,
  groupPropsByService,
  percentageProgressFor,
} from "../src/core/deviceDetailModel.ts";
import { setDataPathOverrides } from "../src/core/jsonStore.ts";
import { createDeviceInfo, createPropInfo, type DeviceInfo, type PropInfo } from "../src/core/models.ts";
import { MijiaService } from "../src/core/service.ts";
import { VirtualDemoService } from "../src/core/virtualLightService.ts";
import { flattenMiotSpec, type FlattenedSpec, type MijiaApiClient } from "../src/mijia/index.ts";
import { startMijiaDeckServer, type MijiaDeckServer } from "../src/server/server.ts";
import { DeviceDetailController } from "../src/ui/controllers/deviceDetailController.ts";
import { setAccent, setTheme } from "../src/ui/theme.ts";

interface PendingJob {
  fn: () => unknown;
  onSuccess?: (result: unknown) => void;
  onError?: (error: Error) => void;
}

class SyncTestJobs implements IJobExecutor {
  pending: PendingJob[] = [];

  submit<T>(fn: () => T | Promise<T>, options?: JobSubmitOptions<T>): void {
    this.pending.push({
      fn,
      onSuccess: options?.onSuccess as ((result: unknown) => void) | undefined,
      onError: options?.onError,
    });
  }

  async finish(): Promise<void> {
    const job = this.pending.shift();
    if (!job) throw new Error("No pending job");
    try {
      const res = await job.fn();
      job.onSuccess?.(res);
    } catch (err) {
      job.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  async finishAll(): Promise<void> {
    while (this.pending.length > 0) {
      await this.finish();
    }
  }

  cancelPending(): void {
    this.pending.length = 0;
  }

  shutdown(): void {
    this.pending.length = 0;
  }
}

describe("DeviceDetail Spec & Model", () => {
  test("flattenMiotSpec preserves service metadata and action input piids", () => {
    const raw: Record<string, unknown> = {
      type: "urn:miot-spec-v2:device:pet-feeder:0000A06C:madv-fjpet2:1",
      description: "Pet Feeder",
      comment: "智能宠物喂食器",
      services: [
        {
          iid: 2,
          type: "urn:miot-spec-v2:service:pet-feeder:00007847:madv-fjpet2:1",
          description: "Pet Feeder",
          comment: "宠物喂食",
          properties: [
            {
              iid: 5,
              type: "urn:miot-spec-v2:property:feeding-measure:00000080:madv-fjpet2:1",
              description: "Feeding Measure",
              comment: "出粮量",
              format: "uint8",
              access: [],
              "value-range": [1, 60, 1],
            },
            {
              iid: 6,
              type: "urn:miot-spec-v2:property:pet-food-left-level:0000010E:madv-fjpet2:1",
              description: "Pet Food Left Level",
              comment: "宠物粮剩余量",
              format: "uint8",
              access: ["read"],
              "value-list": [
                { value: 1, description: "Normal", comment: "正常" },
                { value: 2, description: "Low", comment: "缺粮" },
              ],
            },
          ],
          actions: [
            {
              iid: 1,
              type: "urn:miot-spec-v2:action:pet-food-out:0000282B:madv-fjpet2:1",
              description: "Pet Food Out",
              comment: "立即出粮",
              in: [5],
            },
          ],
        },
      ],
    };

    const flat = flattenMiotSpec(raw);
    expect(flat.properties[0]!.service).toBe("pet-feeder");
    expect(flat.properties[0]!.serviceDesc).toBe("Pet Feeder / 宠物喂食");
    expect(flat.actions[0]!.service).toBe("pet-feeder");
    expect(flat.actions[0]!.in).toEqual([5]);
  });

  test("MijiaService.deviceDetail resolves explicit action.in and infers legacy cached pet-feeder/speaker params", async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "mijiadeck-detail-spec-"));
    try {
      const legacyFeederSpec: FlattenedSpec = {
        name: "Pet Feeder",
        properties: [
          {
            name: "feeding-measure",
            description: "Feeding Measure / 出粮量",
            type: "uint",
            rw: "",
            range: [1, 60, 1],
            "value-list": null,
            method: { siid: 2, piid: 5 },
          },
          {
            name: "pet-food-left-level",
            description: "Pet Food Left Level / 宠物粮剩余量",
            type: "uint",
            rw: "r",
            range: null,
            "value-list": [
              { value: 1, description: "Normal", desc_zh_cn: "正常" },
              { value: 2, description: "Low", desc_zh_cn: "缺粮" },
            ],
            method: { siid: 2, piid: 6 },
          },
        ],
        actions: [
          // Intentionally omit `in` to simulate legacy cached spec file on disk
          {
            name: "pet-food-out",
            description: "Pet Food Out / 喂食机出粮",
            method: { siid: 2, aiid: 1 },
          },
        ],
      };

      const mockApi = {
        authDataPath: path.join(tempDir, "auth.json"),
        apiBaseUrl: "https://api.io.mi.com/app",
        available: true,
        authData: {},
        getHomesList: mock(async () => []),
        getDevicesList: mock(async () => [
          {
            did: "feeder-1",
            name: "宠物喂食器",
            model: "madv.feeder.fjpet2",
            spec_type: "urn:miot-spec-v2:device:pet-feeder:0000A06C:madv-fjpet2:1",
            isOnline: true,
          },
        ]),
        getSharedDevicesList: mock(async () => []),
        getDevicesProp: mock(async () => []),
        setDevicesProp: mock(async () => []),
        runAction: mock(async () => ({ code: 0 })),
      };

      const service = new MijiaService({
        api: mockApi as unknown as MijiaApiClient,
        specFetcher: async () => legacyFeederSpec,
      });

      const detail = await service.deviceDetail("feeder-1");
      expect(detail.actions).toHaveLength(1);
      expect(detail.actions[0]!.in).toBeDefined();
      expect(detail.actions[0]!.in![0]!.name).toBe("feeding-measure");
      expect(detail.actions[0]!.in![0]!.range).toEqual([1, 60, 1]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("classifyDeviceProps, widget choice, formatting, validation, and danger guards work across real device shapes", () => {
    const airPurifier = createDeviceInfo({
      did: "airp-1",
      name: "客厅空气净化器",
      model: "zhimi.airp.rma3",
      home_name: "家",
      room_name: "客厅",
      online: true,
      spec_type: "urn:miot-spec-v2:device:air-purifier:0000A007:zhimi-rma3:1",
    });

    const props: PropInfo[] = [
      createPropInfo({ name: "on", desc: "Switch Status / 开关", type: "bool", readable: true, writable: true, siid: 2, piid: 1, service: "air-purifier", service_desc: "空气净化" }),
      createPropInfo({
        name: "mode",
        desc: "Mode / 模式",
        type: "uint",
        readable: true,
        writable: true,
        value_list: [
          { value: 0, description: "Auto", desc_zh_cn: "自动" },
          { value: 1, description: "Sleep", desc_zh_cn: "睡眠" },
          { value: 2, description: "Favorite", desc_zh_cn: "最爱" },
        ],
        siid: 2,
        piid: 4,
        service: "air-purifier",
        service_desc: "空气净化",
      }),
      createPropInfo({
        name: "fan-level",
        desc: "Fan Level / 风机档位",
        type: "uint",
        readable: true,
        writable: true,
        value_list: Array.from({ length: 10 }, (_, i) => ({ value: i, desc_zh_cn: `档位 ${i + 1}` })),
        siid: 11,
        piid: 1,
        service: "fan",
        service_desc: "风扇控制",
      }),
      createPropInfo({ name: "pm2.5-density", desc: "PM2.5 Density", type: "uint", readable: true, writable: false, unit: "μg/m3", range: [0, 1000, 1], siid: 3, piid: 4 }),
      createPropInfo({ name: "filter-life-level", desc: "Filter Life Level / 滤芯剩余寿命", type: "uint", readable: true, writable: false, unit: "percentage", range: [0, 100, 1], siid: 4, piid: 1 }),
      createPropInfo({ name: "physical-controls-locked", desc: "童锁", type: "bool", readable: true, writable: true, siid: 8, piid: 1 }),
      createPropInfo({ name: "moto-speed-rpm", desc: "直流电机，调试使用，不对用户开放。", type: "uint", readable: true, writable: false, siid: 9, piid: 1 }),
      createPropInfo({ name: "wifi-encrypted-password-3", desc: "WiFi密码", type: "string", readable: true, writable: true, siid: 3, piid: 2 }),
      createPropInfo({ name: "action-arg-only", desc: "动作参数", type: "uint", readable: false, writable: false, range: [1, 10, 1], siid: 2, piid: 9 }),
    ];

    expect(deviceCategoryLabel(airPurifier)).toBe("空气净化器");
    const classified = classifyDeviceProps(airPurifier, props);
    expect(classified.powerProp?.name).toBe("on");
    expect(classified.telemetry.map((p) => p.name)).toEqual(["pm2.5-density", "filter-life-level"]);
    expect(classified.controls.map((p) => p.name)).toEqual(["mode", "fan-level", "physical-controls-locked"]);
    expect(classified.advanced.map((p) => p.name)).toEqual(["moto-speed-rpm", "wifi-encrypted-password-3"]);
    expect(classified.actionParams.map((p) => p.name)).toEqual(["action-arg-only"]);

    expect(choosePropertyWidget(props[1]!)).toBe("segmented");
    expect(choosePropertyWidget(props[2]!)).toBe("select");
    expect(choosePropertyWidget(props[5]!)).toBe("switch");
    expect(choosePropertyWidget(props[3]!)).toBe("readonly");

    expect(friendlyLabel("Switch Status / 开关", "on")).toBe("开关");
    expect(formatPropertyValue(props[1]!, 2)).toBe("最爱");
    expect(formatPropertyValue(props[3]!, 18)).toBe("18 μg/m³");
    expect(formatPropertyValue(props[4]!, 78)).toBe("78%");
    expect(formatPropertyValue(props[7]!, "super-secret")).toBe("••••••••");
    expect(percentageProgressFor(props[4]!, 78)).toBe(78);
    expect(percentageProgressFor(props[3]!, 18)).toBeNull();

    expect(groupPropsByService(classified.controls).length).toBe(3);

    expect(actionRequiresConfirmation({ name: "reboot", desc: "重启" })).toBe(true);
    expect(actionRequiresConfirmation({ name: "reset-filter-life", desc: "重置滤芯" })).toBe(true);
    expect(actionRequiresConfirmation({ name: "pet-food-out", desc: "立即出粮" })).toBe(false);

    expect(coercePropWriteValue(props[1]!, 1)).toEqual({ ok: true, value: 1 });
    expect(coercePropWriteValue(props[1]!, 99).ok).toBe(false);
    expect(coercePropWriteValue(props[3]!, 10).ok).toBe(false);
    expect(coercePropWriteValue(props[5]!, true)).toEqual({ ok: true, value: true });
    expect(coercePropWriteValue(props[5]!, "yes").ok).toBe(false);
  });
});

describe("DeviceDetailController", () => {
  test("loads values, writes props, runs actions, guards dragging reads, and handles offline devices", async () => {
    const service = new VirtualDemoService();
    const devices = await service.listDevices();
    const speaker = devices.find((d) => d.did === "demo-speaker-xiaoai")!;
    const jobs = new SyncTestJobs();

    const ctrl = new DeviceDetailController(service, jobs, speaker);
    ctrl.load();
    await jobs.finishAll();

    expect(ctrl.loading).toBe(false);
    expect(ctrl.values["volume"]).toBe(45);
    expect(ctrl.values["playing-state"]).toBe(1);

    // Drag guard prevents stale poll from overwriting value
    ctrl.setDragging("volume", true);
    ctrl.refresh();
    expect(jobs.pending.length).toBe(0);
    ctrl.setDragging("volume", false);

    // Write property updates service & reads back
    ctrl.writeProp("volume", 62);
    await jobs.finishAll();
    expect(ctrl.values["volume"]).toBe(62);

    // Run action updates playing-state via readback
    ctrl.runAction("pause");
    await jobs.finishAll();
    expect(ctrl.values["playing-state"]).toBe(2);
    ctrl.dispose();

    // Offline device loads spec without invoking readProps
    const offlineSpeaker = createDeviceInfo({ ...speaker, online: false });
    const readSpy = mock(service.readProps.bind(service));
    const offlineService = Object.assign(Object.create(Object.getPrototypeOf(service)), service, {
      readProps: readSpy,
    }) as VirtualDemoService;
    const offlineCtrl = new DeviceDetailController(offlineService, jobs, offlineSpeaker);
    offlineCtrl.load();
    await jobs.finishAll();
    expect(offlineCtrl.loading).toBe(false);
    expect(offlineCtrl.props.length).toBeGreaterThan(0);
    expect(readSpy).not.toHaveBeenCalled();
    expect(offlineCtrl.statusMessage).toContain("离线");
    offlineCtrl.dispose();
  });
});

describe("Device Detail HTTP API", () => {
  let tempDir = "";
  let server: MijiaDeckServer | null = null;

  beforeEach(async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "mijiadeck-detail-api-"));
    const dir = tempDir;
    setDataPathOverrides({
      dataDir: () => dir,
      dataFile: (name) => path.join(dir, name),
    });
    setAccent("green");
    setTheme("dark");
    server = await startMijiaDeckServer({ mode: "demo", port: 0 });
  });

  afterEach(async () => {
    if (server !== null) {
      await server.stop();
      server = null;
    }
    setAccent("green");
    setTheme("dark");
    setDataPathOverrides(null);
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = "";
    }
  });

  test("GET /api/devices/:did/detail serves light, speaker, router, sensor, switch panel, and 404", async () => {
    const base = server!.url;

    // 1. Adjustable light with extra mode/save-state/countdown & actions
    const lightRes = await fetch(`${base}/api/devices/demo-light-living/detail`);
    expect(lightRes.status).toBe(200);
    const light = (await lightRes.json()) as Record<string, unknown>;
    expect(light.ok).toBe(true);
    expect(light.supportsPower).toBe(true);
    expect(light.powerState).toBe(true);
    expect(Object.keys(light.lightControls as Record<string, unknown>)).toEqual([
      "brightness",
      "temperature",
      "color",
    ]);
    expect((light.values as Record<string, unknown>)["mode"]).toBe(0);
    expect((light.actions as unknown[]).length).toBe(2);

    // Write mode & run delay-off action
    const modeRes = await fetch(`${base}/api/devices/demo-light-living/prop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "mode", value: 2 }),
    });
    expect(modeRes.status).toBe(200);
    const modeBody = (await modeRes.json()) as { ok: boolean; values: Record<string, unknown> };
    expect(modeBody.ok).toBe(true);
    expect(modeBody.values["mode"]).toBe(2);

    const actRes = await fetch(`${base}/api/devices/demo-light-living/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "delay-off" }),
    });
    expect(actRes.status).toBe(200);
    const actBody = (await actRes.json()) as { ok: boolean; values: Record<string, unknown>; message: string };
    expect(actBody.ok).toBe(true);
    expect(actBody.values["delay-off-countdown"]).toBe(15);
    expect(actBody.message).toContain("延时关灯");

    // 2. Speaker with parameterized actions & readback
    const spkRes = await fetch(`${base}/api/devices/demo-speaker-xiaoai/detail`);
    expect(spkRes.status).toBe(200);
    const spk = (await spkRes.json()) as {
      ok: boolean;
      category: string;
      values: Record<string, unknown>;
      actions: Array<{ name: string; in?: unknown[] }>;
    };
    expect(spk.ok).toBe(true);
    expect(spk.category).toBe("小爱音箱");
    expect(spk.values["volume"]).toBe(45);
    const ttsAction = spk.actions.find((a) => a.name === "play-text");
    expect(ttsAction?.in?.length).toBe(1);

    const pauseRes = await fetch(`${base}/api/devices/demo-speaker-xiaoai/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "pause" }),
    });
    expect(pauseRes.status).toBe(200);
    const pauseBody = (await pauseRes.json()) as { ok: boolean; values: Record<string, unknown> };
    expect(pauseBody.values["playing-state"]).toBe(2);

    // 3. Router has rich telemetry + writable settings + reboot action, never card power
    const routerRes = await fetch(`${base}/api/devices/demo-router-be6500/detail`);
    expect(routerRes.status).toBe(200);
    const router = (await routerRes.json()) as {
      ok: boolean;
      supportsPower: boolean;
      values: Record<string, unknown>;
      actions: Array<{ name: string }>;
    };
    expect(router.ok).toBe(true);
    expect(router.supportsPower).toBe(false);
    expect(router.values["ip-address"]).toBe("192.168.31.1");
    expect(router.actions.some((a) => a.name === "reboot")).toBe(true);

    // 4. Split switch panel returns all 3 channels with power states and rejects parent write
    const panelRes = await fetch(`${base}/api/devices/demo-switch-bar/detail`);
    expect(panelRes.status).toBe(200);
    const panel = (await panelRes.json()) as {
      ok: boolean;
      isSplitParent: boolean;
      supportsPower: boolean;
      channels: Array<{ did: string; power: boolean | null }>;
      values: Record<string, unknown>;
    };
    expect(panel.ok).toBe(true);
    expect(panel.isSplitParent).toBe(true);
    expect(panel.supportsPower).toBe(false);
    expect(panel.channels).toHaveLength(3);
    expect(panel.values["temperature"]).toBe(28.5);

    const parentWriteRes = await fetch(`${base}/api/devices/demo-switch-bar/prop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "temperature", value: 20 }),
    });
    expect(parentWriteRes.status).toBe(400);

    // 5. Unknown device returns 404
    const missingRes = await fetch(`${base}/api/devices/non-existent-did/detail`);
    expect(missingRes.status).toBe(404);
  });

  test("GET /api/devices/:did/detail degrades cleanly for offline and spec-less devices", async () => {
    const base = server!.url;
    const mw = server!.runtime.mainWindow;

    // Inject an offline device and a BLE-only spec-less device into mainWindow state
    const offlineSensor = createDeviceInfo({
      did: "demo-sensor-ht",
      name: "卧室米家温湿度计",
      model: "miaomiaoce.sensor_ht.t2",
      home_name: "示例之家",
      room_name: "卧室",
      online: false,
      spec_type: "urn:miot-spec-v2:device:temperature-humidity-sensor:0000A00A:miaomiaoce-t2:1",
    });
    const bleNoSpec = createDeviceInfo({
      did: "ble-no-spec-1",
      name: "蓝牙门锁",
      model: "lumi.lock.mcn01",
      home_name: "示例之家",
      room_name: "玄关",
      online: true,
      spec_type: "",
    });
    mw.allDevices = mw.allDevices.map((d) => (d.did === "demo-sensor-ht" ? offlineSensor : d));
    mw.allDevices.push(bleNoSpec);

    const offRes = await fetch(`${base}/api/devices/demo-sensor-ht/detail`);
    expect(offRes.status).toBe(200);
    const offBody = (await offRes.json()) as {
      ok: boolean;
      online: boolean;
      props: unknown[];
      values: Record<string, unknown>;
    };
    expect(offBody.ok).toBe(true);
    expect(offBody.online).toBe(false);
    expect(offBody.props.length).toBeGreaterThan(0);
    expect(offBody.values).toEqual({});

    const bleRes = await fetch(`${base}/api/devices/ble-no-spec-1/detail`);
    expect(bleRes.status).toBe(200);
    const bleBody = (await bleRes.json()) as {
      ok: boolean;
      props: unknown[];
      specError: string | null;
    };
    expect(bleBody.ok).toBe(true);
    expect(bleBody.props).toEqual([]);
    expect(bleBody.specError).toBeTruthy();
  });
});
