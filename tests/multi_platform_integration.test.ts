// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 多平台聚合服务、REST API、故障隔离与 Pi Agent 端到端集成测试

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ProgressCallback } from "../src/core/contracts.ts";
import { setDataPathOverrides } from "../src/core/jsonStore.ts";
import {
  createDeviceInfo,
  createPropInfo,
  createSceneInfo,
  type DeviceDetail,
  type DeviceInfo,
  type SceneInfo,
} from "../src/core/models.ts";
import { VirtualDemoService } from "../src/core/virtualLightService.ts";
import {
  MultiPlatformService,
  MijiaPlatformProvider,
  PlatformRegistry,
  createMultiPlatformService,
  namespaceDid,
  parseNamespacedDid,
  type DiscoveredLocalDevice,
  type IDevicePlatformProvider,
  type PlatformId,
  type PlatformMetadata,
  type PlatformQrAuthResult,
  type PlatformQrAuthSession,
  type PlatformStatus,
} from "../src/platforms/index.ts";
import { startMijiaDeckServer, type MijiaDeckServer } from "../src/server/server.ts";

class StubExternalProvider implements IDevicePlatformProvider {
  readonly id: PlatformId;
  readonly metadata: PlatformMetadata;
  enabled: boolean;
  connected: boolean;
  shouldFailList = false;
  devices: DeviceInfo[];
  scenes: SceneInfo[];
  powerMap: Record<string, boolean | null> = {};
  metricsMap: Record<string, string | null> = {};
  propValues = new Map<string, Record<string, unknown>>();
  lastConfigured: Record<string, unknown> | null = null;
  ranScenes: SceneInfo[] = [];
  discovered: DiscoveredLocalDevice[] = [];
  private _qrSessions = new Map<string, { polled: number }>();

  constructor(options: {
    id: PlatformId;
    name: string;
    displayName: string;
    badgeText: string;
    accentColor: string;
    enabled?: boolean;
    connected?: boolean;
    devices?: DeviceInfo[];
    scenes?: SceneInfo[];
    powerMap?: Record<string, boolean | null>;
    metricsMap?: Record<string, string | null>;
    propValues?: Record<string, Record<string, unknown>>;
    discovered?: DiscoveredLocalDevice[];
  }) {
    this.id = options.id;
    this.metadata = {
      id: options.id,
      name: options.name,
      displayName: options.displayName,
      badgeText: options.badgeText,
      accentColor: options.accentColor,
      description: `${options.displayName} 测试提供者`,
      reference: "Home Assistant reference",
      capabilities: {
        cloud: true,
        local: true,
        qrAuth: options.id === "tuya",
        credentialsAuth: options.id !== "tuya",
        openApiAuth: options.id === "tuya",
        lanDiscovery: options.id !== "deye",
        scenes: options.id === "tuya",
      },
    };
    this.enabled = options.enabled ?? true;
    this.connected = options.connected ?? true;
    this.devices = options.devices ?? [];
    this.scenes = options.scenes ?? [];
    this.powerMap = { ...(options.powerMap ?? {}) };
    this.metricsMap = { ...(options.metricsMap ?? {}) };
    this.discovered = options.discovered ?? [];
    if (options.propValues) {
      for (const [k, v] of Object.entries(options.propValues)) {
        this.propValues.set(k, { ...v });
      }
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  isConnected(): boolean {
    return this.enabled && this.connected;
  }

  status(): PlatformStatus {
    return {
      ...this.metadata,
      enabled: this.enabled,
      connected: this.isConnected(),
      state: this.isConnected() ? "connected" : "disconnected",
      authMode: this.id === "tuya" ? "qr" : "hybrid",
      deviceCount: this.isConnected() ? this.devices.length : 0,
      sceneCount: this.isConnected() ? this.scenes.length : 0,
      lastSyncAt: this.isConnected() ? Date.now() : null,
      lastError: this.shouldFailList ? "模拟云端超时" : null,
      configSummary: {
        enabled: this.enabled,
        hasSecret: true,
      },
    };
  }

  async configure(config: Record<string, unknown>): Promise<PlatformStatus> {
    this.lastConfigured = { ...config };
    this.enabled = config.enabled !== false;
    this.connected = this.enabled;
    return this.status();
  }

  async disconnect(): Promise<void> {
    this.enabled = false;
    this.connected = false;
  }

  async beginQrAuth(_params: Record<string, unknown>): Promise<PlatformQrAuthSession> {
    const sessionId = `${this.id}-qr-1`;
    this._qrSessions.set(sessionId, { polled: 0 });
    return {
      platform: this.id,
      sessionId,
      qrContent: "tuyaSmart--qrLogin?token=mock_qr_token",
      qrSvg: "<svg></svg>",
      expiresAt: Date.now() + 60_000,
      hint: "请扫码授权",
    };
  }

  async pollQrAuth(sessionId: string): Promise<PlatformQrAuthResult> {
    const entry = this._qrSessions.get(sessionId);
    if (!entry) {
      return { platform: this.id, status: "expired", message: "已过期" };
    }
    entry.polled += 1;
    if (entry.polled < 2) {
      return { platform: this.id, status: "pending", message: "等待扫码" };
    }
    this.enabled = true;
    this.connected = true;
    return {
      platform: this.id,
      status: "success",
      message: "授权成功",
      platformStatus: this.status(),
    };
  }

  async discoverLocal(): Promise<DiscoveredLocalDevice[]> {
    return [...this.discovered];
  }

  async listDevices(_progress?: ProgressCallback): Promise<DeviceInfo[]> {
    if (this.shouldFailList) {
      throw new Error(`${this.id} cloud timeout`);
    }
    return this.devices.map((d) => createDeviceInfo(d));
  }

  async deviceDetail(nativeDid: string): Promise<DeviceDetail> {
    const dev = this.devices.find((d) => d.did === nativeDid);
    if (!dev) {
      throw new Error(`未找到设备 ${nativeDid}`);
    }
    const vals = this.propValues.get(nativeDid) ?? { on: this.powerMap[nativeDid] ?? false };
    const props = Object.entries(vals).map(([k, v]) =>
      createPropInfo({
        name: k,
        desc:
          k === "on"
            ? "开关"
            : k === "target-temperature"
              ? "目标温度"
              : k === "target-humidity"
                ? "目标湿度"
                : k === "brightness"
                  ? "亮度"
                  : k,
        type: typeof v === "boolean" ? "bool" : typeof v === "number" ? "int" : "string",
        readable: true,
        writable: true,
        range:
          k === "target-temperature"
            ? [16, 30, 1]
            : k === "target-humidity"
              ? [30, 80, 1]
              : k === "brightness"
                ? [1, 100, 1]
                : null,
      }),
    );
    return {
      did: nativeDid,
      name: dev.name,
      model: dev.model,
      props,
      actions: [],
    };
  }

  async readProp(nativeDid: string, name: string): Promise<unknown> {
    const vals = this.propValues.get(nativeDid) ?? {};
    return vals[name] ?? null;
  }

  async readProps(nativeDid: string, names: string[]): Promise<Record<string, unknown>> {
    const vals = this.propValues.get(nativeDid) ?? {};
    const out: Record<string, unknown> = {};
    for (const n of names) out[n] = vals[n] ?? null;
    return out;
  }

  async writeProp(nativeDid: string, name: string, value: unknown): Promise<void> {
    let vals = this.propValues.get(nativeDid);
    if (!vals) {
      vals = {};
      this.propValues.set(nativeDid, vals);
    }
    vals[name] = value;
    if (name === "on") {
      this.powerMap[nativeDid] = Boolean(value);
    }
  }

  async runAction(): Promise<void> {
    // no-op
  }

  async powerState(nativeDid: string): Promise<boolean | null> {
    return this.powerMap[nativeDid] ?? null;
  }

  async togglePower(nativeDid: string): Promise<boolean> {
    const next = !(this.powerMap[nativeDid] ?? false);
    await this.setPowerState(nativeDid, next);
    return next;
  }

  async setPowerState(nativeDid: string, state: boolean): Promise<void> {
    this.powerMap[nativeDid] = state;
    await this.writeProp(nativeDid, "on", state);
  }

  async powerStates(nativeDids: string[]): Promise<Record<string, boolean | null>> {
    const out: Record<string, boolean | null> = {};
    for (const did of nativeDids) out[did] = this.powerMap[did] ?? null;
    return out;
  }

  async readMetrics(nativeDids: string[]): Promise<Record<string, string | null>> {
    const out: Record<string, string | null> = {};
    for (const did of nativeDids) out[did] = this.metricsMap[did] ?? null;
    return out;
  }

  async sceneList(): Promise<SceneInfo[]> {
    return this.scenes.map((s) => createSceneInfo(s));
  }

  async runScene(scene: SceneInfo): Promise<void> {
    this.ranScenes.push(scene);
  }
}

describe("Multi-Platform Integration (Mijia + Tuya + Midea + Deye)", () => {
  let tempDir = "";
  let server: MijiaDeckServer | null = null;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "mijiadeck-multi-platform-"));
    const dir = tempDir;
    setDataPathOverrides({
      dataDir: () => dir,
      dataFile: (name) => path.join(dir, name),
    });
  });

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = null;
    }
    setDataPathOverrides(null);
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = "";
    }
  });

  test("namespaceDid and parseNamespacedDid preserve Mijia raw DIDs and isolate external platforms", () => {
    expect(namespaceDid("mijia", "12345.s2")).toBe("12345.s2");
    expect(parseNamespacedDid("12345.s2")).toEqual({ platform: "mijia", nativeDid: "12345.s2" });

    expect(namespaceDid("tuya", "bf1234.s1")).toBe("tuya:bf1234.s1");
    expect(parseNamespacedDid("tuya:bf1234.s1")).toEqual({ platform: "tuya", nativeDid: "bf1234.s1" });

    expect(namespaceDid("midea", "17592186044416")).toBe("midea:17592186044416");
    expect(parseNamespacedDid("midea:17592186044416")).toEqual({
      platform: "midea",
      nativeDid: "17592186044416",
    });

    expect(namespaceDid("deye", "deye-d50a3")).toBe("deye:deye-d50a3");
    expect(parseNamespacedDid("deye:deye-d50a3")).toEqual({
      platform: "deye",
      nativeDid: "deye-d50a3",
    });
  });

  test("createMultiPlatformService registers all 4 default providers (mijia, tuya, midea, deye)", () => {
    const svc = createMultiPlatformService({
      mijiaService: new VirtualDemoService(),
    });
    const statuses = svc.listPlatforms();
    expect(statuses.map((s) => s.id)).toEqual(["mijia", "tuya", "midea", "deye"]);
    expect(statuses.find((s) => s.id === "mijia")?.connected).toBe(true);
    expect(statuses.find((s) => s.id === "tuya")?.connected).toBe(false);
    expect(statuses.find((s) => s.id === "midea")?.connected).toBe(false);
    expect(statuses.find((s) => s.id === "deye")?.connected).toBe(false);
  });

  test("MultiPlatformService aggregates 4 platforms in parallel, routes controls cleanly, and isolates single-platform failures", async () => {
    const mijiaProvider = new MijiaPlatformProvider(new VirtualDemoService());
    const tuyaProvider = new StubExternalProvider({
      id: "tuya",
      name: "涂鸦智能",
      displayName: "涂鸦智能 (Tuya)",
      badgeText: "涂鸦",
      accentColor: "#ff6a00",
      devices: [
        createDeviceInfo({
          did: "ty_light_1",
          name: "涂鸦书房彩灯",
          model: "tuya.light.dj",
          home_name: "示例之家",
          room_name: "书房",
          online: true,
          spec_type: "urn:tuya:device:light:dj:1",
          light_features: ["brightness", "temperature", "color"],
        }),
      ],
      scenes: [
        createSceneInfo({
          scene_id: "home1:sc_movie",
          name: "涂鸦影院模式",
          home_id: "home1",
          home_name: "示例之家",
        }),
      ],
      powerMap: { ty_light_1: true },
      propValues: { ty_light_1: { on: true, brightness: 80 } },
    });
    const mideaProvider = new StubExternalProvider({
      id: "midea",
      name: "美的智能",
      displayName: "美的智能 (Midea)",
      badgeText: "美的",
      accentColor: "#0092d8",
      devices: [
        createDeviceInfo({
          did: "100001",
          name: "美的客厅空调",
          model: "midea.air-conditioner.0xac",
          home_name: "示例之家",
          room_name: "客厅",
          online: true,
          spec_type: "urn:midea:device:air-conditioner:0xac:1",
          metric_features: ["temperature"],
        }),
      ],
      powerMap: { "100001": false },
      metricsMap: { "100001": "26.5°C" },
      propValues: { "100001": { on: false, "target-temperature": 25 } },
    });
    const deyeProvider = new StubExternalProvider({
      id: "deye",
      name: "德业智能",
      displayName: "德业智能 (Deye)",
      badgeText: "德业",
      accentColor: "#0ea5e9",
      devices: [
        createDeviceInfo({
          did: "deye_d50",
          name: "德业地下室除湿机",
          model: "deye.dehumidifier.d50a3",
          home_name: "示例之家",
          room_name: "阳台",
          online: true,
          spec_type: "urn:deye:device:dehumidifier:d50a3:1",
          metric_features: ["temperature", "relative-humidity"],
        }),
      ],
      powerMap: { deye_d50: true },
      metricsMap: { deye_d50: "24.0°C 58%" },
      propValues: { deye_d50: { on: true, "target-humidity": 50 } },
    });

    const registry = new PlatformRegistry()
      .register(mijiaProvider)
      .register(tuyaProvider)
      .register(mideaProvider)
      .register(deyeProvider);
    const service = new MultiPlatformService({ registry, primaryMijia: mijiaProvider });

    const allDevices = await service.listDevices();
    expect(allDevices.some((d) => d.did === "demo-light-living")).toBe(true);
    expect(allDevices.some((d) => d.did === "tuya:ty_light_1" && d.platform === "tuya")).toBe(true);
    expect(allDevices.some((d) => d.did === "midea:100001" && d.platform === "midea")).toBe(true);
    expect(allDevices.some((d) => d.did === "deye:deye_d50" && d.platform === "deye")).toBe(true);

    // Parallel power states & metrics across all 4 platforms
    const powers = await service.powerStates([
      "demo-light-living",
      "tuya:ty_light_1",
      "midea:100001",
      "deye:deye_d50",
    ]);
    expect(powers["tuya:ty_light_1"]).toBe(true);
    expect(powers["midea:100001"]).toBe(false);
    expect(powers["deye:deye_d50"]).toBe(true);

    const metrics = await service.readMetrics(["midea:100001", "deye:deye_d50"]);
    expect(metrics["midea:100001"]).toBe("26.5°C");
    expect(metrics["deye:deye_d50"]).toBe("24.0°C 58%");

    // Cross-platform control writes
    await service.setPowerState("midea:100001", true);
    await service.writeProp("midea:100001", "target-temperature", 23);
    expect(await service.readProp("midea:100001", "target-temperature")).toBe(23);

    await service.writeProp("deye:deye_d50", "target-humidity", 45);
    expect(await service.readProp("deye:deye_d50", "target-humidity")).toBe(45);

    // Scene aggregation & execution routing
    const scenes = await service.sceneList();
    const tuyaScene = scenes.find((s) => s.scene_id === "tuya:home1:sc_movie");
    expect(tuyaScene).toBeDefined();
    await service.runScene(tuyaScene!);
    expect(tuyaProvider.ranScenes).toHaveLength(1);
    expect(tuyaProvider.ranScenes[0]!.scene_id).toBe("home1:sc_movie");

    // Fault isolation: if Tuya fails listDevices, Mijia + Midea + Deye still succeed
    tuyaProvider.shouldFailList = true;
    const partialDevices = await service.listDevices();
    expect(partialDevices.some((d) => d.did === "demo-light-living")).toBe(true);
    expect(partialDevices.some((d) => d.did === "midea:100001")).toBe(true);
    expect(partialDevices.some((d) => d.did === "deye:deye_d50")).toBe(true);
    expect(partialDevices.some((d) => d.did === "tuya:ty_light_1")).toBe(false);
  });

  test("End-to-end HTTP /api/platforms/* routes + /api/state + Pi Agent multi-platform control", async () => {
    const mijiaProvider = new MijiaPlatformProvider(new VirtualDemoService());
    const tuyaProvider = new StubExternalProvider({
      id: "tuya",
      name: "涂鸦智能",
      displayName: "涂鸦智能 (Tuya)",
      badgeText: "涂鸦",
      accentColor: "#ff6a00",
      enabled: false,
      connected: false,
      devices: [
        createDeviceInfo({
          did: "ty_lamp",
          name: "涂鸦氛围台灯",
          model: "tuya.light.dj",
          home_name: "示例之家",
          room_name: "卧室",
          online: true,
          spec_type: "urn:tuya:device:light:dj:1",
          light_features: ["brightness"],
        }),
      ],
      powerMap: { ty_lamp: false },
      propValues: { ty_lamp: { on: false, brightness: 50 } },
    });
    const mideaProvider = new StubExternalProvider({
      id: "midea",
      name: "美的智能",
      displayName: "美的智能 (Midea)",
      badgeText: "美的",
      accentColor: "#0092d8",
      enabled: true,
      connected: true,
      devices: [
        createDeviceInfo({
          did: "midea_ac_1",
          name: "美的卧室空调",
          model: "midea.air-conditioner.0xac",
          home_name: "示例之家",
          room_name: "卧室",
          online: true,
          spec_type: "urn:midea:device:air-conditioner:0xac:1",
          metric_features: ["temperature"],
        }),
      ],
      powerMap: { midea_ac_1: false },
      metricsMap: { midea_ac_1: "25.0°C" },
      propValues: { midea_ac_1: { on: false, "target-temperature": 26 } },
      discovered: [
        {
          platform: "midea",
          id: "midea_ac_1",
          name: "美的空调 192.168.1.50",
          ip: "192.168.1.50",
          port: 6444,
          protocolVersion: "3",
          typeCode: "0xAC",
        },
      ],
    });
    const deyeProvider = new StubExternalProvider({
      id: "deye",
      name: "德业智能",
      displayName: "德业智能 (Deye)",
      badgeText: "德业",
      accentColor: "#0ea5e9",
      enabled: true,
      connected: true,
      devices: [
        createDeviceInfo({
          did: "deye_hum_1",
          name: "德业客厅除湿机",
          model: "deye.dehumidifier.d50a3",
          home_name: "示例之家",
          room_name: "客厅",
          online: true,
          spec_type: "urn:deye:device:dehumidifier:d50a3:1",
          metric_features: ["temperature", "relative-humidity"],
        }),
      ],
      powerMap: { deye_hum_1: false },
      metricsMap: { deye_hum_1: "24.5°C 65%" },
      propValues: { deye_hum_1: { on: false, "target-humidity": 55 } },
    });

    const registry = new PlatformRegistry()
      .register(mijiaProvider)
      .register(tuyaProvider)
      .register(mideaProvider)
      .register(deyeProvider);
    const multiService = new MultiPlatformService({ registry, primaryMijia: mijiaProvider });

    server = await startMijiaDeckServer({
      mode: "demo",
      port: 0,
      service: multiService,
      autoStart: true,
      autoStartTimers: false,
    });

    const base = server.url;

    // 1. GET /api/platforms returns all 4 platforms
    const listRes = await fetch(`${base}/api/platforms`);
    expect(listRes.status).toBe(200);
    const listJson = (await listRes.json()) as { ok: boolean; platforms: PlatformStatus[] };
    expect(listJson.ok).toBe(true);
    expect(listJson.platforms.map((p) => p.id)).toEqual(["mijia", "tuya", "midea", "deye"]);

    // 2. Tuya QR auth flow: begin -> poll pending -> poll success
    const qrBeginRes = await fetch(`${base}/api/platforms/tuya/qr/begin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userCode: "USER123" }),
    });
    expect(qrBeginRes.status).toBe(200);
    const qrBeginJson = (await qrBeginRes.json()) as {
      ok: boolean;
      session: PlatformQrAuthSession;
    };
    expect(qrBeginJson.session.sessionId).toBe("tuya-qr-1");

    const poll1 = (await (
      await fetch(`${base}/api/platforms/tuya/qr/poll`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "tuya-qr-1" }),
      })
    ).json()) as { ok: boolean; result: PlatformQrAuthResult };
    expect(poll1.result.status).toBe("pending");

    const poll2 = (await (
      await fetch(`${base}/api/platforms/tuya/qr/poll`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "tuya-qr-1" }),
      })
    ).json()) as { ok: boolean; result: PlatformQrAuthResult };
    expect(poll2.result.status).toBe("success");

    // Refresh devices via HTTP and verify all 4 platforms appear in /api/state
    await fetch(`${base}/api/devices/refresh`, { method: "POST" });
    const stateJson = (await (await fetch(`${base}/api/state`)).json()) as {
      devices: DeviceInfo[];
      platforms: PlatformStatus[];
    };
    expect(stateJson.devices.some((d) => d.did === "tuya:ty_lamp")).toBe(true);
    expect(stateJson.devices.some((d) => d.did === "midea:midea_ac_1")).toBe(true);
    expect(stateJson.devices.some((d) => d.did === "deye:deye_hum_1")).toBe(true);

    // 3. Midea LAN discovery endpoint
    const discRes = await fetch(`${base}/api/platforms/midea/discover`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timeoutMs: 1000 }),
    });
    expect(discRes.status).toBe(200);
    const discJson = (await discRes.json()) as { ok: boolean; devices: DiscoveredLocalDevice[] };
    expect(discJson.devices).toHaveLength(1);
    expect(discJson.devices[0]!.ip).toBe("192.168.1.50");

    // 4. Device power & prop control over HTTP for Midea & Deye
    const mideaPowerRes = await fetch(`${base}/api/devices/${encodeURIComponent("midea:midea_ac_1")}/power`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: true }),
    });
    expect(mideaPowerRes.status).toBe(200);
    expect(mideaProvider.powerMap["midea_ac_1"]).toBe(true);

    const deyePropRes = await fetch(`${base}/api/devices/${encodeURIComponent("deye:deye_hum_1")}/prop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "target-humidity", value: 48 }),
    });
    expect(deyePropRes.status).toBe(200);
    expect(deyeProvider.propValues.get("deye_hum_1")?.["target-humidity"]).toBe(48);

    // 5. Pi Agent controls external platform device via natural Chinese command!
    const agentRes = await server.runtime.piAgent!.prompt("打开德业客厅除湿机");
    expect(agentRes.ok).toBe(true);
    expect(deyeProvider.powerMap["deye_hum_1"]).toBe(true);

    // 6. Disconnect platform cleanly
    const disRes = await fetch(`${base}/api/platforms/tuya/disconnect`, { method: "POST" });
    expect(disRes.status).toBe(200);
    expect(tuyaProvider.isConnected()).toBe(false);
  });
});
