// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 涂鸦智能红外遥控子设备（音响/空调/电视/DIY等）与红外网关端到端测试

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { planDeterministicLocalCalls } from "../src/agent/localPlannerStream.ts";
import { createSmartHomeTools, resolveDevices } from "../src/agent/smartHomeTools.ts";
import { NetworkMonitor } from "../src/core/availability.ts";
import { isIrRemote, supportsCardPower } from "../src/core/deviceControls.ts";
import { deviceCategoryLabel, isIrRemoteDevice } from "../src/core/deviceDetailModel.ts";
import { JobExecutor } from "../src/core/jobs.ts";
import { setDataPathOverrides } from "../src/core/jsonStore.ts";
import { createDeviceInfo } from "../src/core/models.ts";
import * as settingsStore from "../src/core/settingsStore.ts";
import * as trayStore from "../src/core/trayStore.ts";
import {
  defaultTuyaConfig,
  type TuyaPlatformConfig,
} from "../src/platforms/configStore.ts";
import { MultiPlatformService } from "../src/platforms/index.ts";
import {
  isTuyaInfraredCategory,
  isTuyaIrHubCategory,
  mapTuyaDeviceToCards,
  tuyaCategoryToKind,
  tuyaIrKeyDescZh,
  tuyaSharingAesGcmDecrypt,
  tuyaSharingAesGcmEncrypt,
  tuyaSharingHashKey,
  tuyaSharingSecret,
  TuyaPlatformProvider,
  type TuyaConfigStoreAdapter,
  type TuyaDeviceRecord,
  type TuyaDeviceSpecification,
} from "../src/platforms/tuya/index.ts";
import { createRequestHandler, StateBroadcaster } from "../src/server/routes.ts";
import { MainWindowController } from "../src/ui/controllers/mainWindowController.ts";
import { ThemeController, applyTheme } from "../src/ui/theme.ts";

const MOCK_ACCESS_TOKEN = "mock_ir_access_token";
const MOCK_REFRESH_TOKEN = "mock_ir_refresh_token_123456";

const AMPLIFIER_SPEC: TuyaDeviceSpecification = {
  category: "infrared_amplifier",
  functions: [
    { code: "Next", type: "STRING", values: "Next" },
    { code: "Pause", type: "STRING", values: "Pause" },
    { code: "Play", type: "STRING", values: "Play" },
    { code: "PowerOff", type: "STRING", values: "PowerOff" },
    { code: "PowerOn", type: "STRING", values: "PowerOn" },
    { code: "Previous", type: "STRING", values: "Previous" },
    { code: "Volume+", type: "STRING", values: "Volume+" },
    { code: "Volume-", type: "STRING", values: "Volume-" },
  ],
  status: [],
};

const AC_SPEC: TuyaDeviceSpecification = {
  category: "infrared_ac",
  functions: [
    {
      code: "F",
      type: "ENUM",
      values: JSON.stringify({ min: 0, max: 3, scale: 0, step: 1, type: "Integer" }),
    },
    {
      code: "M",
      type: "ENUM",
      values: JSON.stringify({ min: 0, max: 4, scale: 0, step: 1, type: "Integer" }),
    },
    { code: "PowerOff", type: "STRING", values: "PowerOff" },
    { code: "PowerOn", type: "STRING", values: "PowerOn" },
    {
      code: "T",
      type: "ENUM",
      values: JSON.stringify({ min: 16, max: 30, scale: 0, step: 1, type: "Integer" }),
    },
  ],
  status: [
    {
      code: "wind",
      type: "ENUM",
      values: JSON.stringify({ min: 0, max: 3, scale: 0, step: 1, type: "Integer" }),
    },
    {
      code: "mode",
      type: "ENUM",
      values: JSON.stringify({ min: 0, max: 4, scale: 0, step: 1, type: "Integer" }),
    },
    { code: "power", type: "BOOLEAN", values: "{}" },
    {
      code: "temp",
      type: "ENUM",
      values: JSON.stringify({ min: 16, max: 30, scale: 0, step: 1, type: "Integer" }),
    },
  ],
};

const TV_SPEC: TuyaDeviceSpecification = {
  category: "infrared_tv",
  functions: [
    { code: "Power", type: "STRING", values: "Power" },
    { code: "Mute", type: "STRING", values: "Mute" },
    { code: "Volume+", type: "STRING", values: "Volume+" },
    { code: "Volume-", type: "STRING", values: "Volume-" },
    { code: "Channel+", type: "STRING", values: "Channel+" },
    { code: "Channel-", type: "STRING", values: "Channel-" },
    { code: "0", type: "STRING", values: "0" },
    { code: "1", type: "STRING", values: "1" },
    { code: "2", type: "STRING", values: "2" },
    {
      code: "C",
      type: "ENUM",
      values: JSON.stringify({ min: 1, max: 999, scale: 0, step: 1, type: "Integer" }),
    },
  ],
  status: [],
};

function makeConfigStore(initial: Partial<TuyaPlatformConfig>): TuyaConfigStoreAdapter {
  let cfg: TuyaPlatformConfig = {
    ...defaultTuyaConfig(),
    ...initial,
    localDevices: initial.localDevices ? initial.localDevices.map((d) => ({ ...d })) : [],
  };
  return {
    load: () => ({
      ...cfg,
      tokenSession: cfg.tokenSession ? { ...cfg.tokenSession } : null,
      localDevices: cfg.localDevices.map((d) => ({ ...d })),
    }),
    save: (next) => {
      cfg = {
        ...next,
        tokenSession: next.tokenSession ? { ...next.tokenSession } : null,
        localDevices: next.localDevices.map((d) => ({ ...d })),
      };
      return cfg;
    },
  };
}

function getHeader(headers: HeadersInit | undefined, key: string): string {
  if (!headers) return "";
  if (headers instanceof Headers) return headers.get(key) ?? "";
  if (Array.isArray(headers)) {
    const entry = headers.find(([k]) => k.toLowerCase() === key.toLowerCase());
    return entry?.[1] ?? "";
  }
  const lower = key.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return String(v);
  }
  return "";
}

function encryptSharingResponse(headers: HeadersInit | undefined, result: unknown): Response {
  const rid = getHeader(headers, "X-requestId");
  const hashKey = tuyaSharingHashKey(rid, MOCK_REFRESH_TOKEN);
  const secret = tuyaSharingSecret(rid, "", hashKey);
  const enc = tuyaSharingAesGcmEncrypt(JSON.stringify(result), secret);
  return new Response(JSON.stringify({ success: true, result: enc, t: Date.now() }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function decryptSharingBody(headers: HeadersInit | undefined, body: BodyInit | null | undefined): any {
  if (!body || typeof body !== "string") return null;
  const parsed = JSON.parse(body) as { encdata?: string };
  if (!parsed.encdata) return parsed;
  const rid = getHeader(headers, "X-requestId");
  const hashKey = tuyaSharingHashKey(rid, MOCK_REFRESH_TOKEN);
  const secret = tuyaSharingSecret(rid, "", hashKey);
  return JSON.parse(tuyaSharingAesGcmDecrypt(parsed.encdata, secret));
}

function createSharingMockFetch(options?: { failCode2050On?: Set<string> }) {
  const sentCommands: Array<{ deviceId: string; commands: Array<{ code: string; value: unknown }> }> = [];

  const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const u = new URL(url);

    if (u.pathname === "/v1.0/m/life/users/homes") {
      return encryptSharingResponse(init?.headers, [{ ownerId: "home1", name: "我的家" }]);
    }
    if (u.pathname === "/v1.0/m/life/ha/home/devices") {
      return encryptSharingResponse(init?.headers, [
        {
          id: "hub_001",
          name: "万能红外遥控器",
          category: "wnykq",
          productId: "pvbslqlvmasy5f64",
          online: true,
          sub: false,
          status: [],
          roomName: "客厅",
        },
        {
          id: "amp_001",
          name: "音响",
          category: "infrared_amplifier",
          productId: "g4epfqle2vmfaxb8",
          online: true,
          sub: true,
          status: [],
          roomName: "默认房间",
        },
        {
          id: "ac_001",
          name: "小空调",
          category: "infrared_ac",
          productId: "qzktzhehinzsz2je",
          online: true,
          sub: true,
          status: [],
          roomName: "卧室",
        },
      ]);
    }
    if (u.pathname === "/v1.1/m/life/hub_001/specifications") {
      return encryptSharingResponse(init?.headers, { category: "wnykq", functions: [], status: [] });
    }
    if (u.pathname === "/v1.1/m/life/amp_001/specifications") {
      return encryptSharingResponse(init?.headers, AMPLIFIER_SPEC);
    }
    if (u.pathname === "/v1.1/m/life/ac_001/specifications") {
      return encryptSharingResponse(init?.headers, AC_SPEC);
    }
    if (u.pathname === "/v1.0/m/life/ha/devices/detail") {
      return encryptSharingResponse(init?.headers, [
        { id: "amp_001", online: true, status: [] },
        { id: "ac_001", online: true, status: [] },
      ]);
    }
    const cmdMatch = /^\/v1\.1\/m\/thing\/([^/]+)\/commands$/.exec(u.pathname);
    if (cmdMatch) {
      const deviceId = cmdMatch[1]!;
      const body = decryptSharingBody(init?.headers, init?.body);
      const commands = (body?.commands ?? []) as Array<{ code: string; value: unknown }>;
      sentCommands.push({ deviceId, commands });
      if (options?.failCode2050On?.has(commands[0]?.code ?? "")) {
        return new Response(
          JSON.stringify({ success: false, code: 2050, msg: "ir key not supported" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return encryptSharingResponse(init?.headers, true);
    }
    return encryptSharingResponse(init?.headers, []);
  }) as typeof fetch;

  return { mockFetch, sentCommands };
}

describe("Tuya Infrared Remote — Constants, Category Mapping & UI Helpers", () => {
  test("recognizes IR hub (wnykq) and all infrared_* virtual sub-device categories", () => {
    expect(tuyaCategoryToKind("wnykq")).toBe("ir-hub");
    expect(isTuyaIrHubCategory("wnykq")).toBe(true);
    expect(isTuyaInfraredCategory("wnykq")).toBe(false);

    expect(tuyaCategoryToKind("infrared_amplifier")).toBe("amplifier");
    expect(tuyaCategoryToKind("infrared_ac")).toBe("air-conditioner");
    expect(tuyaCategoryToKind("infrared_tv")).toBe("television");
    expect(tuyaCategoryToKind("infrared_fan")).toBe("fan");
    expect(tuyaCategoryToKind("infrared_stb")).toBe("set-top-box");
    expect(tuyaCategoryToKind("infrared_projector")).toBe("projector");
    expect(tuyaCategoryToKind("infrared_dvd")).toBe("dvd-player");
    expect(tuyaCategoryToKind("infrared_diy")).toBe("ir-remote");
    expect(tuyaCategoryToKind("infrared_unknown_future")).toBe("ir-remote");

    expect(isTuyaInfraredCategory("infrared_amplifier")).toBe(true);
    expect(isTuyaInfraredCategory("infrared_ac")).toBe(true);
    expect(isTuyaInfraredCategory("infrared_diy")).toBe(true);
    expect(isTuyaInfraredCategory("dj")).toBe(false);

    expect(tuyaIrKeyDescZh("PowerOn")).toBe("开机");
    expect(tuyaIrKeyDescZh("PowerOff")).toBe("关机");
    expect(tuyaIrKeyDescZh("Volume+")).toBe("音量+");
    expect(tuyaIrKeyDescZh("Volume-")).toBe("音量-");
    expect(tuyaIrKeyDescZh("Previous")).toBe("上一首");
    expect(tuyaIrKeyDescZh("Next")).toBe("下一首");
    expect(tuyaIrKeyDescZh("Mute")).toBe("静音");
    expect(tuyaIrKeyDescZh("Channel+")).toBe("频道+");
    expect(tuyaIrKeyDescZh("5")).toBe("5");
  });

  test("deviceControls & deviceDetailModel recognize IR devices for power toggle and category labels", () => {
    const amp = createDeviceInfo({
      did: "tuya:amp_001",
      name: "音响",
      model: "tuya.infrared_amplifier.g4epfqle2vmfaxb8",
      home_name: "我的家",
      room_name: "默认房间",
      online: true,
      spec_type: "urn:tuya:device:amplifier:1",
    });
    const ac = createDeviceInfo({
      did: "tuya:ac_001",
      name: "小空调",
      model: "tuya.infrared_ac.qzktzhehinzsz2je",
      home_name: "我的家",
      room_name: "卧室",
      online: true,
      spec_type: "urn:tuya:device:air-conditioner:1",
    });
    const hub = createDeviceInfo({
      did: "tuya:hub_001",
      name: "万能红外遥控器",
      model: "tuya.wnykq.pvbslqlvmasy5f64",
      home_name: "我的家",
      room_name: "客厅",
      online: true,
      spec_type: "urn:tuya:device:ir-hub:1",
    });

    expect(supportsCardPower(amp)).toBe(true);
    expect(supportsCardPower(ac)).toBe(true);
    expect(supportsCardPower(hub)).toBe(false);

    expect(isIrRemote(amp)).toBe(true);
    expect(isIrRemote(ac)).toBe(true);
    expect(isIrRemote(hub)).toBe(false);

    expect(isIrRemoteDevice(amp)).toBe(true);
    expect(deviceCategoryLabel(amp)).toBe("红外音响");
    expect(deviceCategoryLabel(ac)).toBe("红外空调");
    expect(deviceCategoryLabel(hub)).toBe("万能红外遥控器");
  });
});

describe("Tuya Infrared Remote — Mapper (Amplifier / AC / TV / Hub)", () => {
  test("maps infrared_amplifier into ordered ir-remote actions and discrete irPower with zero string input props", () => {
    const record: TuyaDeviceRecord = {
      id: "amp_001",
      name: "音响",
      category: "infrared_amplifier",
      productId: "g4epfqle2vmfaxb8",
      homeName: "我的家",
      roomName: "默认房间",
      online: true,
      sub: true,
      status: {},
      spec: AMPLIFIER_SPEC,
      codeToDpId: {},
      dpIdToCode: {},
      source: "sharing",
    };

    const { profiles } = mapTuyaDeviceToCards(record);
    const profile = profiles.get("amp_001");
    expect(profile).toBeDefined();
    expect(profile!.isInfraredRemote).toBe(true);
    expect(profile!.info.spec_type).toBe("urn:tuya:device:amplifier:1");

    // Only canonical 'on' prop; none of Next/Pause/Play/Volume+ leaked as writable string props
    expect(profile!.detail.props.map((p) => p.name)).toEqual(["on"]);
    expect(profile!.detail.props[0]!.readable).toBe(false);
    expect(profile!.detail.props[0]!.writable).toBe(true);

    // Logically ordered IR remote actions
    expect(profile!.detail.actions.map((a) => a.name)).toEqual([
      "PowerOn",
      "PowerOff",
      "Volume+",
      "Volume-",
      "Previous",
      "Play",
      "Pause",
      "Next",
    ]);
    expect(profile!.detail.actions.every((a) => a.service === "ir-remote")).toBe(true);
    expect(profile!.detail.actions.find((a) => a.name === "Volume+")?.desc).toBe("音量+");

    expect(profile!.irPower?.onAction?.dpCode).toBe("PowerOn");
    expect(profile!.irPower?.offAction?.dpCode).toBe("PowerOff");
    expect(profile!.irPower?.assumedState).toBeNull();
  });

  test("maps infrared_ac integer-range ENUMs M/T/F and status wind/mode/power/temp without duplicates", () => {
    const record: TuyaDeviceRecord = {
      id: "ac_001",
      name: "小空调",
      category: "infrared_ac",
      productId: "qzktzhehinzsz2je",
      homeName: "我的家",
      roomName: "卧室",
      online: true,
      sub: true,
      status: {},
      spec: AC_SPEC,
      codeToDpId: {},
      dpIdToCode: {},
      source: "sharing",
    };

    const { profiles } = mapTuyaDeviceToCards(record);
    const profile = profiles.get("ac_001");
    expect(profile!.isInfraredRemote).toBe(true);
    expect(profile!.info.spec_type).toBe("urn:tuya:device:air-conditioner:1");

    const propNames = profile!.detail.props.map((p) => p.name);
    expect(propNames).toEqual(["on", "mode", "target-temperature", "fan-level"]);

    const modeProp = profile!.detail.props.find((p) => p.name === "mode")!;
    expect(modeProp.value_list).toHaveLength(5);
    expect(modeProp.value_list?.[0]).toMatchObject({ value: 0, desc_zh_cn: "制冷" });

    const tempProp = profile!.detail.props.find((p) => p.name === "target-temperature")!;
    expect(tempProp.range).toEqual([16, 30, 1]);
    expect(tempProp.unit).toBe("celsius");

    const fanProp = profile!.detail.props.find((p) => p.name === "fan-level")!;
    expect(fanProp.value_list).toHaveLength(4);
    expect(fanProp.value_list?.[0]).toMatchObject({ value: 0, desc_zh_cn: "自动" });

    expect(profile!.detail.actions.map((a) => a.name)).toEqual(["PowerOn", "PowerOff"]);
    expect(profile!.irPower?.statusDpCode).toBe("power");
    expect(profile!.bindingsByPropName.get("target-temperature")?.dpCode).toBe("T");
    expect(profile!.bindingsByPropName.get("target-temperature")?.statusDpCode).toBe("temp");
    expect(profile!.bindingsByPropName.get("mode")?.dpCode).toBe("M");
    expect(profile!.bindingsByPropName.get("mode")?.statusDpCode).toBe("mode");
    expect(profile!.bindingsByPropName.get("fan-level")?.dpCode).toBe("F");
    expect(profile!.bindingsByPropName.get("fan-level")?.statusDpCode).toBe("wind");
  });

  test("maps infrared_tv single Power toggle key, numeric channel ENUM, and ordered digits", () => {
    const record: TuyaDeviceRecord = {
      id: "tv_001",
      name: "客厅电视",
      category: "infrared_tv",
      productId: "tvprod01",
      homeName: "我的家",
      roomName: "客厅",
      online: true,
      sub: true,
      status: {},
      spec: TV_SPEC,
      codeToDpId: {},
      dpIdToCode: {},
      source: "sharing",
    };

    const { profiles } = mapTuyaDeviceToCards(record);
    const profile = profiles.get("tv_001");
    expect(profile!.isInfraredRemote).toBe(true);
    expect(profile!.irPower?.toggleAction?.dpCode).toBe("Power");
    expect(profile!.irPower?.onAction).toBeNull();
    expect(profile!.irPower?.offAction).toBeNull();

    // Integer-range ENUM 'C' should be mapped as numeric range [1, 999, 1], not a raw string input
    const chProp = profile!.detail.props.find((p) => p.name === "C");
    expect(chProp?.range).toEqual([1, 999, 1]);
    expect(chProp?.type).toBe("uint");

    // Digit keys appear at the end in 1..9, 0 order
    const actionNames = profile!.detail.actions.map((a) => a.name);
    expect(actionNames.slice(-3)).toEqual(["1", "2", "0"]);
  });
});

describe("Tuya Infrared Remote — Provider Sharing Mode Control", () => {
  test("executes amplifier IR buttons, aliases, repeat count, power toggle, and skips local LAN on virtual sub-devices", async () => {
    const { mockFetch, sentCommands } = createSharingMockFetch();
    const localSendCalls: string[] = [];
    const provider = new TuyaPlatformProvider({
      httpFetch: mockFetch,
      localTransport: {
        async queryDps(entry) {
          localSendCalls.push(`query:${entry.id}`);
          throw new Error("LAN should never be called for virtual IR sub-device");
        },
        async setDps(entry) {
          localSendCalls.push(`set:${entry.id}`);
          throw new Error("LAN should never be called for virtual IR sub-device");
        },
      },
      configStore: makeConfigStore({
        enabled: true,
        mode: "hybrid",
        preferLocal: true,
        localDevices: [
          // Even if a user accidentally added an IP/localKey entry for amp_001, sub:true IR device must use cloud
          { id: "amp_001", name: "音响", ip: "192.168.1.250", localKey: "0123456789abcdef", version: "3.3" },
        ],
        tokenSession: {
          accessToken: MOCK_ACCESS_TOKEN,
          refreshToken: MOCK_REFRESH_TOKEN,
          expireTime: Date.now() + 3600_000,
          uid: "uid1",
          endpoint: "https://apigw.tuyacn.com",
        },
      }),
    });

    const devices = await provider.listDevices();
    expect(devices.map((d) => d.did).sort()).toEqual(["ac_001", "amp_001", "hub_001"]);

    // 1. Direct IR button click
    await provider.runAction("amp_001", "Play");
    expect(sentCommands.at(-1)).toEqual({
      deviceId: "amp_001",
      commands: [{ code: "Play", value: "Play" }],
    });

    // 2. Chinese alias + repeat count (3 presses)
    sentCommands.length = 0;
    await provider.runAction("amp_001", "音量加", [3]);
    expect(sentCommands).toHaveLength(3);
    expect(sentCommands.every((c) => c.commands[0]?.code === "Volume+" && c.commands[0]?.value === "Volume+")).toBe(
      true,
    );

    // 3. Toggle power from unknown -> true (PowerOn) -> false (PowerOff), preserved across listDevices()
    expect(await provider.powerState("amp_001")).toBeNull();
    const first = await provider.togglePower("amp_001");
    expect(first).toBe(true);
    expect(sentCommands.at(-1)?.commands).toEqual([{ code: "PowerOn", value: "PowerOn" }]);
    expect(await provider.powerState("amp_001")).toBe(true);

    // Re-syncing devices must preserve assumed IR power state
    await provider.listDevices();
    expect(await provider.powerState("amp_001")).toBe(true);

    const second = await provider.togglePower("amp_001");
    expect(second).toBe(false);
    expect(sentCommands.at(-1)?.commands).toEqual([{ code: "PowerOff", value: "PowerOff" }]);
    expect(await provider.powerState("amp_001")).toBe(false);

    // Local TCP transport was NEVER attempted for the virtual IR sub-device
    expect(localSendCalls).toEqual([]);
  });

  test("controls infrared_ac via PowerOn/PowerOff and integer M/T/F commands and translates error 2050", async () => {
    const { mockFetch, sentCommands } = createSharingMockFetch({
      failCode2050On: new Set(["F"]),
    });
    const provider = new TuyaPlatformProvider({
      httpFetch: mockFetch,
      configStore: makeConfigStore({
        enabled: true,
        mode: "sharing",
        tokenSession: {
          accessToken: MOCK_ACCESS_TOKEN,
          refreshToken: MOCK_REFRESH_TOKEN,
          expireTime: Date.now() + 3600_000,
          uid: "uid1",
          endpoint: "https://apigw.tuyacn.com",
        },
      }),
    });

    await provider.listDevices();

    // Power on must send PowerOn (NOT read-only 'power': true)
    await provider.setPowerState("ac_001", true);
    expect(sentCommands.at(-1)).toEqual({
      deviceId: "ac_001",
      commands: [{ code: "PowerOn", value: "PowerOn" }],
    });

    // Setting temperature and mode sends integer T and M
    await provider.writeProp("ac_001", "target-temperature", 25);
    expect(sentCommands.at(-1)).toEqual({
      deviceId: "ac_001",
      commands: [{ code: "T", value: 25 }],
    });

    await provider.writeProp("ac_001", "mode", 0);
    expect(sentCommands.at(-1)).toEqual({
      deviceId: "ac_001",
      commands: [{ code: "M", value: 0 }],
    });

    // readProps reflects updated status even when cloud returns empty status array
    const values = await provider.readProps("ac_001", ["on", "mode", "target-temperature"]);
    expect(values).toEqual({
      on: true,
      mode: 0,
      "target-temperature": 25,
    });

    // Error code 2050 yields a clear Chinese explanation
    await expect(provider.writeProp("ac_001", "fan-level", 3)).rejects.toThrow(/2050|红外码库/);
  });
});

describe("Tuya Infrared Remote — Provider OpenAPI v2.0 IR Control Hub", () => {
  test("discovers remotes/keys/learning-codes and dispatches raw/learning/ac-scene commands", async () => {
    const calls: Array<{ method: string; path: string; body: any }> = [];

    const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const u = new URL(url);
      const method = (init?.method ?? "GET").toUpperCase();
      const body = typeof init?.body === "string" && init.body ? JSON.parse(init.body) : null;
      calls.push({ method, path: u.pathname, body });

      if (u.pathname === "/v1.0/token") {
        return Response.json({
          success: true,
          result: { access_token: "oa_tok", refresh_token: "oa_rt", uid: "oa_uid", expire_time: 7200 },
        });
      }
      if (u.pathname === "/v1.0/users/oa_uid/devices") {
        return Response.json({
          success: true,
          result: [
            { id: "hub_oa", name: "万能红外遥控器", category: "wnykq", product_id: "p_hub", online: true, sub: false },
            { id: "amp_oa", name: "客厅音响", category: "infrared_amplifier", product_id: "p_amp", online: true, sub: true },
            { id: "diy_oa", name: "自定义设备", category: "infrared_diy", product_id: "p_diy", online: true, sub: true },
            { id: "ac_oa", name: "卧室空调", category: "infrared_ac", product_id: "p_ac", online: true, sub: true },
          ],
        });
      }
      if (u.pathname.endsWith("/specifications")) {
        if (u.pathname.includes("amp_oa")) {
          return Response.json({ success: true, result: AMPLIFIER_SPEC });
        }
        if (u.pathname.includes("ac_oa")) {
          return Response.json({ success: true, result: AC_SPEC });
        }
        return Response.json({ success: true, result: { category: "infrared_diy", functions: [], status: [] } });
      }
      if (u.pathname === "/v2.0/infrareds/hub_oa/remotes") {
        return Response.json({
          success: true,
          result: [
            { remote_id: "amp_oa", remote_name: "客厅音响", category_id: 9, remote_index: 1234 },
            { remote_id: "diy_oa", remote_name: "自定义设备", category_id: 99, remote_index: 0 },
            { remote_id: "ac_oa", remote_name: "卧室空调", category_id: 5, remote_index: 5678 },
          ],
        });
      }
      if (u.pathname === "/v2.0/infrareds/hub_oa/remotes/amp_oa/keys") {
        return Response.json({
          success: true,
          result: {
            category_id: 9,
            remote_index: 1234,
            key_list: [
              { key: "PowerOn", key_id: 1, key_name: "开机", standard_key: true },
              { key: "Volume+", key_id: 2, key_name: "音量加", standard_key: true },
            ],
          },
        });
      }
      if (u.pathname === "/v2.0/infrareds/hub_oa/remotes/diy_oa/keys") {
        return Response.json({
          success: true,
          result: { category_id: 99, remote_index: 0, key_list: [] },
        });
      }
      if (u.pathname === "/v2.0/infrareds/hub_oa/remotes/diy_oa/learning-codes" && method === "GET") {
        return Response.json({
          success: true,
          result: [{ id: 101, key_name: "蓝牙切换", code: "RAW_HEX_BT_CODE" }],
        });
      }
      if (u.pathname === "/v2.0/infrareds/hub_oa/remotes/ac_oa/keys") {
        return Response.json({
          success: true,
          result: { category_id: 5, remote_index: 5678, key_list: [] },
        });
      }
      if (u.pathname === "/v2.0/infrareds/hub_oa/remotes/ac_oa/ac/status") {
        return Response.json({
          success: true,
          result: { power: "1", mode: "0", temp: "26", wind: "2" },
        });
      }
      if (u.pathname.includes("/raw/command") || u.pathname.includes("/learning-codes") || u.pathname.includes("/scenes/command")) {
        return Response.json({ success: true, result: true });
      }
      return Response.json({ success: true, result: [] });
    }) as typeof fetch;

    const provider = new TuyaPlatformProvider({
      httpFetch: mockFetch,
      configStore: makeConfigStore({
        enabled: true,
        mode: "openapi",
        accessId: "mock_access_id",
        accessSecret: "mock_access_secret",
        uid: "oa_uid",
      }),
    });

    await provider.listDevices();

    // 1. Standard IR key via OpenAPI v2.0 raw/command
    await provider.runAction("amp_oa", "Volume+");
    const rawCall = calls.find((c) => c.path === "/v2.0/infrareds/hub_oa/remotes/amp_oa/raw/command");
    expect(rawCall?.body).toEqual({
      category_id: 9,
      remote_index: 1234,
      key: "Volume+",
      key_id: 2,
    });

    // 2. DIY learned key via OpenAPI v2.0 learning-codes POST
    const diyDetail = await provider.deviceDetail("diy_oa");
    expect(diyDetail.actions.map((a) => a.name)).toContain("蓝牙切换");
    await provider.runAction("diy_oa", "蓝牙切换");
    const learnCall = calls.find(
      (c) => c.method === "POST" && c.path === "/v2.0/infrareds/hub_oa/remotes/diy_oa/learning-codes",
    );
    expect(learnCall?.body).toEqual({ code: "RAW_HEX_BT_CODE" });

    // 3. IR AC status read & scene command
    expect(await provider.readProps("ac_oa", ["on", "mode", "target-temperature", "fan-level"])).toEqual({
      on: true,
      mode: 0,
      "target-temperature": 26,
      "fan-level": 2,
    });
    await provider.writeProp("ac_oa", "target-temperature", 23);
    const acSceneCall = calls.find(
      (c) => c.path === "/v2.0/infrareds/hub_oa/air-conditioners/ac_oa/scenes/command",
    );
    expect(acSceneCall?.body).toMatchObject({ power: 1, mode: 0, temp: 23, wind: 2 });
  });
});

describe("Tuya Infrared Remote — HTTP API, Pi Agent Tools & Local Planner Integration", () => {
  let tmpDir = "";

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "mijiadeck-tuya-ir-"));
    const dir = tmpDir;
    setDataPathOverrides({
      dataDir: () => dir,
      dataFile: (name) => path.join(dir, name),
    });
  });

  afterEach(() => {
    setDataPathOverrides(null);
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = "";
    }
  });

  test("HTTP routes sync powerState on IR remote power actions and Pi Agent / local planner control IR amplifier without breaking XiaoAi", async () => {
    const { mockFetch, sentCommands } = createSharingMockFetch();
    const tuyaProvider = new TuyaPlatformProvider({
      httpFetch: mockFetch,
      configStore: makeConfigStore({
        enabled: true,
        mode: "sharing",
        tokenSession: {
          accessToken: MOCK_ACCESS_TOKEN,
          refreshToken: MOCK_REFRESH_TOKEN,
          expireTime: Date.now() + 3600_000,
          uid: "uid1",
          endpoint: "https://apigw.tuyacn.com",
        },
      }),
    });

    const service = new MultiPlatformService({ providers: [tuyaProvider] });
    const jobs = new JobExecutor();
    applyTheme("dark", "green");
    const themeCtrl = new ThemeController("dark");
    const networkMonitor = new NetworkMonitor({ initialReachability: "online", autoStart: false });
    const mainWindow = new MainWindowController({
      service,
      jobs,
      themeCtrl,
      networkMonitor,
      autoStartTimers: false,
      cacheLoader: () => null,
      cacheSaver: () => {},
    });

    try {
      service.setControlAccess();
      const devices = await service.listDevices();
      mainWindow.allDevices = devices;
      mainWindow.loggedOut = false;
      mainWindow.networkOnline = true;

      const handler = createRequestHandler({
        mode: "live",
        service,
        jobs,
        mainWindow,
        themeCtrl,
        settingsStore,
        trayStore,
        broadcaster: new StateBroadcaster(),
      });

      const ampDid = "tuya:amp_001";

      // GET /api/devices/:did/detail returns ir-remote actions cleanly
      const detailRes = await handler(
        new Request(`http://127.0.0.1/api/devices/${encodeURIComponent(ampDid)}/detail`),
      );
      expect(detailRes.status).toBe(200);
      const detailJson = (await detailRes.json()) as any;
      expect(detailJson.ok).toBe(true);
      expect(detailJson.actions.map((a: any) => a.name)).toContain("Volume+");
      expect(detailJson.props.map((p: any) => p.name)).toEqual(["on"]);

      // POST /api/devices/:did/action for PowerOn syncs mainWindow.knownPower to true
      const actionRes = await handler(
        new Request(`http://127.0.0.1/api/devices/${encodeURIComponent(ampDid)}/action`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "PowerOn" }),
        }),
      );
      expect(actionRes.status).toBe(200);
      const actionJson = (await actionRes.json()) as any;
      expect(actionJson.ok).toBe(true);
      expect(actionJson.powerState).toBe(true);
      expect(mainWindow.knownPower[ampDid]).toBe(true);

      // Pi Agent tools: control_speaker controls IR amplifier (volume_delta, playback, power)
      const tools = createSmartHomeTools({
        service,
        jobs,
        mainWindow,
        settingsStore,
        broadcastState: () => {},
      });
      const speakerTool = tools.find((t) => t.name === "control_speaker")!;
      expect(speakerTool).toBeDefined();

      sentCommands.length = 0;
      const volRes = await speakerTool.execute("tc1", {
        target: "音响",
        volume_delta: 20,
      });
      expect(JSON.stringify(volRes.content)).toContain("音量调大（2次）");
      expect(sentCommands).toHaveLength(2);
      expect(sentCommands.every((c) => c.commands[0]?.code === "Volume+")).toBe(true);

      sentCommands.length = 0;
      const nextRes = await speakerTool.execute("tc2", {
        target: "音响",
        playback: "next",
      });
      expect(JSON.stringify(nextRes.content)).toContain("下一首");
      expect(sentCommands[0]?.commands).toEqual([{ code: "Next", value: "Next" }]);

      // Unsupported XiaoAi-only TTS returns an honest message
      const ttsRes = await speakerTool.execute("tc3", {
        target: "音响",
        tts: "你好",
      });
      expect(JSON.stringify(ttsRes.content)).toContain("红外遥控");

      // Local deterministic planner routes IR amplifier & IR AC utterances properly,
      // while preserving XiaoAi routing when a XiaoAi speaker is also present
      const xiaoai = createDeviceInfo({
        did: "mijia_spk_1",
        name: "小爱音箱Play",
        model: "xiaomi.wifispeaker.lx06",
        home_name: "我的家",
        room_name: "客厅",
        online: true,
      });
      const mixedDevices = [...devices, xiaoai];
      const plannerDeps = { getDevices: () => mixedDevices, getScenes: () => [] };

      const openAmp = planDeterministicLocalCalls("打开音响", plannerDeps);
      expect(openAmp?.[0]).toMatchObject({
        name: "set_device_power",
        arguments: { target: ampDid, state: "on" },
      });

      const nextAmp = planDeterministicLocalCalls("音响下一首", plannerDeps);
      expect(nextAmp?.[0]).toMatchObject({
        name: "control_speaker",
        arguments: { target: ampDid, playback: "next" },
      });

      const louderAmp = planDeterministicLocalCalls("音响声音大一点", plannerDeps);
      expect(louderAmp?.[0]).toMatchObject({
        name: "control_speaker",
        arguments: { target: ampDid, volume_delta: 15 },
      });

      const xiaoaiDirective = planDeterministicLocalCalls("让小爱播放音乐", plannerDeps);
      expect(xiaoaiDirective?.[0]).toMatchObject({
        name: "send_xiaoai_command",
        arguments: { text: "播放音乐" },
      });

      const xiaoaiVol = planDeterministicLocalCalls("小爱音箱声音大一点", plannerDeps);
      expect(xiaoaiVol?.[0]).toEqual({
        name: "control_speaker",
        arguments: { volume_delta: 15 },
      });

      const resolvedXiaoai = resolveDevices(mixedDevices, { target: "小米音响" });
      expect(resolvedXiaoai.map((d) => d.did)).toEqual(["mijia_spk_1"]);
    } finally {
      networkMonitor.stop();
      mainWindow.dispose();
      await jobs.shutdown();
    }
  });
});
