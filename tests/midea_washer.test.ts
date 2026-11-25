// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 美的洗衣机全品类（0xD9 复式/三筒、0xDB 滚筒、0xDA 波轮）协议、Provider、HTTP 与 Agent 完整测试

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSmartHomeTools, resolveDevices } from "../src/agent/smartHomeTools.ts";
import { supportsCardPower, trayEligible } from "../src/core/deviceControls.ts";
import {
  deviceCategoryLabel,
  formatPropertyValue,
  formatWasherCardMetrics,
  isWasherDevice,
} from "../src/core/deviceDetailModel.ts";
import { JobExecutor } from "../src/core/jobs.ts";
import { setDataPathOverrides } from "../src/core/jsonStore.ts";
import * as settingsStore from "../src/core/settingsStore.ts";
import * as trayStore from "../src/core/trayStore.ts";
import { VirtualDemoService } from "../src/core/virtualLightService.ts";
import { createMultiPlatformService } from "../src/platforms/index.ts";
import {
  MideaLocalSecurity,
  MideaPlatformProvider,
  buildMideaModelString,
  buildWasherLuaControlPayload,
  buildWasherLuaQueries,
  buildWasherQuery,
  buildWasherSet,
  buildWasherStatusResponseFrame,
  decodeWasherProgress,
  defaultWasherState,
  encodeWasherProgramForLua,
  formatMideaMetrics,
  getMideaApplianceType,
  getWasherProgramOptions,
  mapMideaDeviceToInfo,
  normalizeWasherProgram,
  parseMideaFrame,
  parseWasherLuaStatus,
  parseWasherResponse,
  resolveMideaWasherProfile,
  type MideaWasherState,
} from "../src/platforms/midea/index.ts";
import { createRequestHandler, type AppRuntime } from "../src/server/routes.ts";
import { MainWindowController } from "../src/ui/controllers/mainWindowController.ts";
import { ThemeController } from "../src/ui/theme.ts";

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function createFakeMeijuWasherCloud(options: {
  appliances: Array<Record<string, unknown>>;
  luaStateByKey: Record<string, Record<string, unknown>>;
}): {
  fetchFn: typeof fetch;
  luaQueries: Array<{ code: string; query: Record<string, unknown> }>;
  luaControls: Array<{
    code: string;
    control: Record<string, unknown>;
    status: Record<string, unknown>;
  }>;
} {
  const luaQueries: Array<{ code: string; query: Record<string, unknown> }> = [];
  const luaControls: Array<{
    code: string;
    control: Record<string, unknown>;
    status: Record<string, unknown>;
  }> = [];

  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, any>) : {};

    if (url.includes("/v1/user/login/id/get")) {
      return jsonResponse({ code: "0", data: { loginId: "washer-login-id" } });
    }
    if (url.includes("/mj/user/login")) {
      return jsonResponse({
        code: "0",
        data: {
          mdata: { accessToken: "washer-token-001" },
          key: "1122334455667788",
          uid: "washer-uid-01",
        },
      });
    }
    if (url.includes("/v1/homegroup/list/get")) {
      return jsonResponse({
        code: "0",
        data: {
          homeList: [{ homegroupId: "home-w-1", name: "方寸别院", isDefault: "1" }],
        },
      });
    }
    if (url.includes("/v1/appliance/home/list/get")) {
      return jsonResponse({
        code: "0",
        data: {
          homeList: [
            {
              homegroupId: "home-w-1",
              name: "方寸别院",
              roomList: [
                {
                  name: "阳台",
                  applianceList: options.appliances,
                },
              ],
            },
          ],
        },
      });
    }
    if (url.includes("/mjl/v1/device/status/lua/get")) {
      const code = String(body.applianceCode ?? "");
      const query = (body.command?.query ?? {}) as Record<string, unknown>;
      luaQueries.push({ code, query });
      const locKey =
        query.query_type === "dc"
          ? `${code}:dc:${query.dc_location ?? 1}`
          : query.db_location !== undefined
            ? `${code}:db:${query.db_location}`
            : code;
      const st = options.luaStateByKey[locKey] ?? options.luaStateByKey[code];
      if (!st) {
        return jsonResponse({ code: "1306", msg: "unsupported query bucket" });
      }
      return jsonResponse({ code: "0", data: { ...st } });
    }
    if (url.includes("/mjl/v1/device/lua/control")) {
      const code = String(body.applianceCode ?? "");
      const control = (body.command?.control ?? {}) as Record<string, unknown>;
      const status = (body.command?.status ?? {}) as Record<string, unknown>;
      luaControls.push({ code, control, status });

      const locKey =
        control.bucket === "dc"
          ? `${code}:dc:${control.dc_location ?? 1}`
          : control.db_location !== undefined
            ? `${code}:db:${control.db_location}`
            : code;
      const targetKey = locKey in options.luaStateByKey ? locKey : code;
      const prev = options.luaStateByKey[targetKey] ?? {};
      const next: Record<string, unknown> = { ...prev, ...control };

      // 模拟真实设备：db_control_status=start/pause 同步更新 db_running_status，db_power 同步所有同 bucket 筒
      if (control.db_power === "on" || control.db_power === "off") {
        for (const k of Object.keys(options.luaStateByKey)) {
          if (k.startsWith(`${code}:db:`)) {
            options.luaStateByKey[k] = {
              ...options.luaStateByKey[k],
              db_power: control.db_power,
              db_running_status: control.db_power === "on" ? "standby" : "off",
            };
          }
        }
        next.db_running_status = control.db_power === "on" ? "standby" : "off";
      }
      if (control.db_control_status === "start") {
        next.db_power = "on";
        next.db_running_status = "start";
        next.db_progress = 4; // wash bit
        if (!next.db_remain_time || Number(next.db_remain_time) <= 0) {
          next.db_remain_time = 45;
        }
      } else if (control.db_control_status === "pause") {
        next.db_running_status = "pause";
      }
      if (control.control_status === "start") {
        next.power = "on";
        next.running_status = "start";
        next.progress = 4;
      } else if (control.control_status === "pause") {
        next.running_status = "pause";
      }
      if (control.power === "on" || control.power === "off") {
        next.running_status = control.power === "on" ? "standby" : "off";
      }
      options.luaStateByKey[targetKey] = next;
      return jsonResponse({ code: "0", data: { code: "0", status: next } });
    }
    return jsonResponse({ code: "404" }, 404);
  }) as typeof fetch;

  return { fetchFn, luaQueries, luaControls };
}

describe("美的洗衣机全品类协议编解码与型号配置 (0xD9 / 0xDB / 0xDA)", () => {
  test("1. 品类注册表将 0xD9 / 0xDA / 0xDB 均识别为 washing-machine 且支持电源与托盘", () => {
    for (const code of [0xd9, 0xda, 0xdb]) {
      const typeInfo = getMideaApplianceType(code);
      expect(typeInfo.kind).toBe("washing-machine");
      expect(typeInfo.metricFeatures).toEqual([]);

      const devInfo = mapMideaDeviceToInfo({
        id: `midea-${code.toString(16)}`,
        name: `美的${typeInfo.label}`,
        type: code,
        homeName: "我的家",
        roomName: "阳台",
        online: true,
        protocolVersion: 3,
        source: "cloud",
      });
      expect(devInfo.model).toBe(buildMideaModelString(code));
      expect(isWasherDevice(devInfo)).toBe(true);
      expect(supportsCardPower(devInfo)).toBe(true);
      expect(trayEligible(devInfo)).toBe(true);
      expect(deviceCategoryLabel(devInfo)).toBe("洗衣机");
    }
  });

  test("2. 0xD9 型号多筒拓扑解析（38135636 三筒 / 38138899 双筒 / 38206322 上下洗烘 / 通用双筒）", () => {
    const p38135636 = resolveMideaWasherProfile(0xd9, { sn8: "38135636", modelNumber: "13363" });
    expect(p38135636.layout).toBe("triple-db");
    expect(p38135636.defaultDrum).toBe("bottom");
    expect(p38135636.drums.map((d) => [d.key, d.bucket, d.location, d.hasSoftener])).toEqual([
      ["bottom", "db", 2, true],
      ["left", "db", 3, false],
      ["right", "db", 4, false],
    ]);
    // 绝不能向 38135636 发送不兼容的 query_type: "da" 或 "dc"
    expect(buildWasherLuaQueries(0xd9, { sn8: "38135636" }).map((q) => q.query)).toEqual([
      { query_type: "db", db_location: 2 },
      { query_type: "db", db_location: 3 },
      { query_type: "db", db_location: 4 },
    ]);

    const p38138899 = resolveMideaWasherProfile(0xd9, { sn8: "38138899" });
    expect(p38138899.layout).toBe("dual-db");
    expect(p38138899.drums.map((d) => [d.key, d.location])).toEqual([
      ["left", 3],
      ["right", 4],
    ]);

    const p38206322 = resolveMideaWasherProfile(0xd9, { sn8: "38206322" });
    expect(p38206322.layout).toBe("stack-db-dc");
    expect(buildWasherLuaQueries(0xd9, { sn8: "38206322" }).map((q) => q.query)).toEqual([
      { query_type: "db", db_location: 2 },
      { query_type: "dc", dc_location: 1 },
    ]);

    const pGeneric = resolveMideaWasherProfile(0xd9);
    expect(pGeneric.layout).toBe("dual-db");
    expect(pGeneric.drums.map((d) => [d.key, d.location])).toEqual([
      ["left", 1],
      ["right", 2],
    ]);
  });

  test("3. 洗涤程序双向编解码、进度位掩码过滤待机脏数据（32 / 1028）", () => {
    expect(normalizeWasherProgram(148, 0xd9)).toBe("socks");
    expect(normalizeWasherProgram(156, 0xd9)).toBe("underpants");
    expect(normalizeWasherProgram(144, 0xd9)).toBe("bra");
    expect(normalizeWasherProgram(143, 0xd9)).toBe("blood_stain_wash");
    expect(normalizeWasherProgram(138, 0xd9)).toBe("smart_wash_dry");
    expect(normalizeWasherProgram("袜子", 0xd9)).toBe("socks");

    expect(encodeWasherProgramForLua("socks", 0xd9, { sn8: "38135636" })).toBe(148);
    expect(encodeWasherProgramForLua("underpants", 0xd9, { sn8: "38135636" })).toBe(156);
    expect(encodeWasherProgramForLua("underwear", 0xd9, { sn8: "38135636" })).toBe(156);
    expect(encodeWasherProgramForLua("mixed_wash", 0xdb)).toBe("mixed_wash");

    // 待机/关机时的脏位码 32、1028 必须归零为 idle；运行中按低位 bit 正确解码阶段
    expect(decodeWasherProgress(32, "off", "db")).toBe("idle");
    expect(decodeWasherProgress(1028, "standby", "db")).toBe("idle");
    expect(decodeWasherProgress(1, "start", "db")).toBe("spin");
    expect(decodeWasherProgress(2, "start", "db")).toBe("rinse");
    expect(decodeWasherProgress(4, "start", "db")).toBe("wash");
    expect(decodeWasherProgress(16, "start", "db")).toBe("dry");
    expect(decodeWasherProgress(32, "start", "db")).toBe("weight");
    expect(decodeWasherProgress(1, "start", "dc")).toBe("dry");

    // 38135636 三个筒的程序列表差异化
    const bottomProgs = getWasherProgramOptions(0xd9, "bottom", { sn8: "38135636" });
    const leftProgs = getWasherProgramOptions(0xd9, "left", { sn8: "38135636" });
    const rightProgs = getWasherProgramOptions(0xd9, "right", { sn8: "38135636" });
    expect(bottomProgs.some((o) => o.value === "mixed_wash")).toBe(true);
    expect(leftProgs.some((o) => o.value === "socks")).toBe(true);
    expect(rightProgs.some((o) => o.value === "underpants")).toBe(true);
    expect(rightProgs.some((o) => o.value === "bra")).toBe(true);
    expect(rightProgs.some((o) => o.value === "blood_stain_wash")).toBe(true);
  });

  test("4. 0xDB 滚筒与 0xDA 波轮 0xAA 二进制帧编解码往返（无 CRC8，仅校验和）", () => {
    const dbQuery = buildWasherQuery(0xdb);
    const dbParsedQ = parseMideaFrame(dbQuery);
    expect(dbParsedQ.deviceType).toBe(0xdb);
    expect(dbParsedQ.frameType).toBe(0x03);
    expect(dbParsedQ.checksumValid).toBe(true);
    expect(Array.from(dbParsedQ.rawBody)).toEqual([0x03]);

    const dbState = {
      ...defaultWasherState(0xdb),
      power: true,
      running: true,
      runningStatus: "start" as const,
      progress: "wash" as const,
      program: "cotton",
      waterLevel: 3,
      temperature: 60,
      dehydrationSpeed: 1200,
      washTime: 25,
      dehydrationTime: 8,
      detergent: 2,
      softener: 1,
      remainTime: 78,
      stains: 3,
    };
    const dbStatusFrame = buildWasherStatusResponseFrame(dbState);
    const dbDecoded = parseWasherResponse(0xdb, dbStatusFrame);
    expect(dbDecoded).not.toBeNull();
    expect(dbDecoded).toMatchObject({
      kind: "washer",
      deviceType: 0xdb,
      power: true,
      running: true,
      runningStatus: "start",
      progress: "wash",
      program: "cotton",
      waterLevel: 3,
      temperature: 60,
      dehydrationSpeed: 1200,
      washTime: 25,
      dehydrationTime: 8,
      detergent: 2,
      softener: 1,
      remainTime: 78,
      stains: 3,
    });

    const dbPowerFrame = buildWasherSet({ ...dbState, power: false }, "on");
    const dbPowerParsed = parseMideaFrame(dbPowerFrame);
    expect(dbPowerParsed.checksumValid).toBe(true);
    expect(dbPowerParsed.rawBody[0]).toBe(0x02);
    expect(dbPowerParsed.rawBody[1]).toBe(0x00);

    const dbPauseFrame = buildWasherSet({ ...dbState, running: false }, "control-status");
    expect(Array.from(parseMideaFrame(dbPauseFrame).rawBody)).toEqual([0x02, 0xff, 0x00]);

    // 0xDA 波轮往返
    const daState = {
      ...defaultWasherState(0xda),
      power: true,
      running: true,
      runningStatus: "start" as const,
      progress: "rinse" as const,
      program: "blanket",
      washLevel: 6,
      rinseLevel: 7,
      washStrength: 3,
      dehydrationSpeed: 800,
      washTime: 15,
      soakTime: 20,
      rinseCount: 3,
      dehydrationTime: 6,
      detergent: 2,
      softener: 2,
      remainTime: 95,
      errorCode: "0",
    };
    const daFrame = buildWasherStatusResponseFrame(daState);
    const daDecoded = parseWasherResponse(0xda, daFrame);
    expect(daDecoded).toMatchObject({
      kind: "washer",
      deviceType: 0xda,
      power: true,
      running: true,
      runningStatus: "start",
      progress: "rinse",
      program: "blanket",
      washLevel: 6,
      rinseLevel: 7,
      washStrength: 3,
      dehydrationSpeed: 800,
      washTime: 15,
      soakTime: 20,
      rinseCount: 3,
      dehydrationTime: 6,
      detergent: 2,
      softener: 2,
      remainTime: 95,
    });
    const daSetFrame = buildWasherSet(daState, "program");
    expect(parseMideaFrame(daSetFrame).checksumValid).toBe(true);
    expect(parseMideaFrame(daSetFrame).rawBody[0]).toBe(0x02);
  });
});

describe("MideaPlatformProvider 洗衣机端到端控制（云端 Lua 多筒/滚筒/波轮 + 局域网 TCP）", () => {
  test("5. 0xD9 美的可爱多三筒 (38135636) 全流程：三筒并行读取、切筒、专属程序、参数写入与动作执行", async () => {
    const cloud = createFakeMeijuWasherCloud({
      appliances: [
        {
          applianceCode: "210006741790988",
          name: "美的可爱多",
          type: "0xD9",
          onlineStatus: "1",
          modelNumber: "13363",
          sn8: "38135636",
          masterId: "3",
        },
      ],
      luaStateByKey: {
        "210006741790988:db:2": {
          bucket: "db",
          db_location: 2,
          db_position: 1,
          db_power: "on",
          db_running_status: "standby",
          db_progress: 32,
          db_program: "mixed_wash",
          db_remain_time: 88,
          db_temperature: 4, // 40°C
          db_dehydration_speed: 5, // 1200 RPM
          db_rinse_count: 2,
          db_water_level: 5,
          db_dry: 3,
          db_detergent: 2,
          db_softener: 1,
          db_set_wash_time: 13,
          db_set_dewater_time: 6,
          db_baby_lock: 0,
          db_nightly_wash: 0,
          db_steam_wash: 1,
          db_fast_clean_wash: 0,
          db_cycle_memory: 1,
          db_fresh_air_time: 2,
          db_appointment_time: 0,
          db_voice_not_disturb_switch: 0,
          db_door_opened: 0,
          db_detergent_needed: 0,
          db_softener_needed: 0,
          db_bucket_water_overheating: 0,
          db_drying_tunnel_overheating: 0,
          db_remote_control_flag: 1,
          db_error_code: 0,
        },
        "210006741790988:db:3": {
          bucket: "db",
          db_location: 3,
          db_position: 0,
          db_power: "on",
          db_running_status: "start",
          db_progress: 4, // wash
          db_program: 148, // socks
          db_remain_time: 35,
          db_temperature: 3, // 30°C
          db_dehydration_speed: 3, // 800 RPM
          db_rinse_count: 2,
          db_water_level: 5,
          db_dry: 1,
          db_detergent: 1,
          db_softener: 0,
          db_detergent_needed: 1,
          db_remote_control_flag: 1,
          db_error_code: 0,
        },
        "210006741790988:db:4": {
          bucket: "db",
          db_location: 4,
          db_position: 0,
          db_power: "on",
          db_running_status: "standby",
          db_progress: 1028,
          db_program: 156, // underpants
          db_remain_time: 48,
          db_temperature: 5, // 60°C
          db_dehydration_speed: 3,
          db_rinse_count: 2,
          db_water_level: 5,
          db_dry: 1,
          db_detergent: 1,
          db_softener: 0,
          db_detergent_needed: 0,
          db_remote_control_flag: 1,
          db_error_code: 0,
        },
      },
    });

    const provider = new MideaPlatformProvider({
      httpFetch: cloud.fetchFn,
      skipLoadConfig: true,
      initialConfig: {
        enabled: true,
        mode: "cloud",
        cloudBrand: "meiju",
        account: "13800138000",
        password: "Password!1",
        useChinaServer: true,
      },
    });

    const devices = await provider.listDevices();
    expect(devices).toHaveLength(1);
    expect(devices[0]!.model).toBe("midea.washing-machine.0xd9");

    // deviceDetail + readProps 并发拉取 3 个 db_location (2/3/4)，无无效 da/dc 请求
    const detail = await provider.deviceDetail("210006741790988");
    expect(detail.props.some((p) => p.name === "drum-location")).toBe(true);
    expect(detail.props.some((p) => p.name === "softener")).toBe(true); // 下筒支持柔顺剂
    expect(detail.actions.map((a) => a.name)).toContain("start-wash");
    expect(detail.actions.map((a) => a.name)).toContain("pause-wash");
    expect(detail.actions.map((a) => a.name)).toContain("cancel-appointment");

    const vals = await provider.readProps("210006741790988", [
      "on",
      "drum-location",
      "running-status",
      "progress",
      "program",
      "temperature",
      "dehydration-speed",
      "dry-mode",
      "steam-wash",
      "remote-control-flag",
      "drum-left-status",
      "drum-left-program",
      "drum-left-remain-time",
      "drum-left-progress",
      "drum-left-detergent-lack",
      "drum-right-program",
      "drum-right-progress",
    ]);
    expect(vals).toEqual({
      on: true,
      "drum-location": "bottom",
      "running-status": "standby",
      progress: "idle", // 过滤待机脏码 32
      program: "mixed_wash",
      temperature: 40,
      "dehydration-speed": 1200,
      "dry-mode": 3,
      "steam-wash": true,
      "remote-control-flag": true,
      "drum-left-status": "start",
      "drum-left-program": "socks",
      "drum-left-remain-time": 35,
      "drum-left-progress": "wash",
      "drum-left-detergent-lack": true,
      "drum-right-program": "underpants",
      "drum-right-progress": "idle", // 过滤待机脏码 1028
    });
    expect(cloud.luaQueries.every((q) => q.query.query_type === "db")).toBe(true);

    // 切换当前操作筒至左筒：纯本地焦点切换，不发无效空控，且刷新后的 detail 切到左筒专属程序并隐藏柔顺剂
    const controlsBeforeSwitch = cloud.luaControls.length;
    await provider.writeProp("210006741790988", "drum-location", "left");
    expect(cloud.luaControls.length).toBe(controlsBeforeSwitch);

    const leftDetail = await provider.deviceDetail("210006741790988");
    expect(leftDetail.props.some((p) => p.name === "softener")).toBe(false);
    const leftProgProp = leftDetail.props.find((p) => p.name === "program")!;
    expect(leftProgProp.value_list?.some((o) => o.value === "socks")).toBe(true);
    expect(await provider.readProp("210006741790988", "program")).toBe("socks");

    // 在左筒写入温度、脱水转速、童锁、新风、预约与取消预约
    await provider.writeProp("210006741790988", "temperature", 60);
    await provider.writeProp("210006741790988", "dehydration-speed", 1000);
    await provider.writeProp("210006741790988", "child-lock", true);
    await provider.writeProp("210006741790988", "appointment-time", 180);
    await provider.runAction("210006741790988", "cancel-appointment");

    // 跨筒直写右筒程序与启动右筒（无需先切换 activeDrum）
    await provider.writeProp("210006741790988", "drum-right-program", "bra");
    await provider.runAction("210006741790988", "start-wash", ["right"]);
    await provider.runAction("210006741790988", "pause-wash", ["right"]);

    expect(cloud.luaControls.map((c) => c.control)).toEqual([
      { bucket: "db", db_location: 3, db_temperature: 5 },
      { bucket: "db", db_location: 3, db_dehydration_speed: 4 },
      { bucket: "db", db_location: 3, db_baby_lock: 1 },
      {
        bucket: "db",
        db_location: 3,
        db_control_status: "start",
        db_appointment: 1,
        db_appointment_time: 180,
      },
      {
        bucket: "db",
        db_location: 3,
        db_control_status: "pause",
        db_appointment: 0,
        db_appointment_time: 0,
      },
      { bucket: "db", db_location: 4, db_program: 144 },
      { bucket: "db", db_location: 4, db_control_status: "start" },
      { bucket: "db", db_location: 4, db_control_status: "pause" },
    ]);

    // 只读告警字段禁止写入
    await expect(
      provider.writeProp("210006741790988", "door-opened", true),
    ).rejects.toThrow(/只读/);
  });

  test("6. 0xDB 滚筒与 0xDA 波轮云端 Lua 读写与参数自适应编码", async () => {
    const cloud = createFakeMeijuWasherCloud({
      appliances: [
        {
          applianceCode: "300000000000001",
          name: "美的滚筒洗烘",
          type: "0xDB",
          onlineStatus: "1",
          modelNumber: "MG100",
          masterId: "3",
        },
        {
          applianceCode: "300000000000002",
          name: "美的波轮洗衣机",
          type: "0xDA",
          onlineStatus: "1",
          modelNumber: "MB80",
          masterId: "3",
        },
      ],
      luaStateByKey: {
        "300000000000001": {
          power: "on",
          running_status: "standby",
          progress: 0,
          program: "cotton",
          remain_time: 65,
          temperature: "40",
          dehydration_speed: "1000",
          soak_count: "2",
          water_level: "auto",
          dryer: "0",
          detergent: "2",
          softener: "1",
          lock: "off",
          nightly: "off",
          steam_wash: "off",
          beforehand_wash: "off",
          super_clean_wash: "off",
          stains: "0",
          error_code: "0",
        },
        "300000000000002": {
          power: "on",
          running_status: "standby",
          progress: 0,
          program: "standard",
          mode: "normal",
          remain_time: 42,
          wash_level: 5,
          rinse_level: 5,
          wash_strength: 2,
          wash_time: 12,
          soak_time: 10,
          rinse_count: 2,
          dehydration_time: 5,
          dehydration_speed: 800,
          detergent: 2,
          softener: 1,
          lock: "off",
          error_code: "0",
        },
      },
    });

    const provider = new MideaPlatformProvider({
      httpFetch: cloud.fetchFn,
      skipLoadConfig: true,
      initialConfig: {
        enabled: true,
        mode: "cloud",
        cloudBrand: "meiju",
        account: "13800138000",
        password: "Password!1",
        useChinaServer: true,
      },
    });

    await provider.listDevices();

    // 0xDB 滚筒写入：自动保留云端样本的字符串/数字格式与 soak_count 键名
    await provider.writeProp("300000000000001", "program", "down_jacket");
    await provider.writeProp("300000000000001", "temperature", 60);
    await provider.writeProp("300000000000001", "rinse-count", 3);
    await provider.writeProp("300000000000001", "water-level", 3);
    await provider.writeProp("300000000000001", "beforehand-wash", true);
    await provider.writeProp("300000000000001", "stains", 3);
    await provider.runAction("300000000000001", "start-wash");

    // 0xDA 波轮写入
    await provider.writeProp("300000000000002", "program", "blanket");
    await provider.writeProp("300000000000002", "wash-level", 7);
    await provider.writeProp("300000000000002", "wash-strength", 4);
    await provider.writeProp("300000000000002", "soak-time", 25);
    await provider.writeProp("300000000000002", "child-lock", true);

    expect(cloud.luaControls.map((c) => ({ code: c.code, control: c.control }))).toEqual([
      { code: "300000000000001", control: { program: "down_jacket" } },
      { code: "300000000000001", control: { temperature: "60" } },
      { code: "300000000000001", control: { soak_count: "3" } },
      { code: "300000000000001", control: { water_level: "high" } },
      { code: "300000000000001", control: { beforehand_wash: "on" } },
      { code: "300000000000001", control: { stains: "3" } },
      { code: "300000000000001", control: { control_status: "start" } },
      { code: "300000000000002", control: { program: "blanket" } },
      { code: "300000000000002", control: { wash_level: 7 } },
      { code: "300000000000002", control: { wash_strength: 4 } },
      { code: "300000000000002", control: { soak_time: 25 } },
      { code: "300000000000002", control: { lock: "on" } },
    ]);
  });

  test("7. 真实 Loopback TCP 测试 0xDB 滚筒洗衣机 LAN V2 (0x5A5A) 查状态、开机、设程序与启动/暂停", async () => {
    const devId = "400000000000001";
    let simState: MideaWasherState = {
      ...defaultWasherState(0xdb),
      power: true,
      running: false,
      runningStatus: "standby",
      progress: "idle",
      program: "mixed_wash",
      temperature: 40,
      dehydrationSpeed: 800,
      remainTime: 55,
    };

    const server = net.createServer((socket) => {
      socket.on("data", (chunk: Buffer) => {
        const decoded = MideaLocalSecurity.decode5a5a(chunk);
        const frame = parseMideaFrame(decoded.payload);
        if (frame.frameType === 0x02) {
          const b = frame.rawBody;
          if (b[1] === 0x00 || b[1] === 0x01) {
            simState = {
              ...simState,
              power: b[1] === 0x01,
              running: b[1] === 0x01 ? simState.running : false,
              runningStatus: b[1] === 0x01 ? "standby" : "off",
            };
          } else if (b.length === 3 && b[2] === 0x00) {
            simState = { ...simState, running: false, runningStatus: "pause", progress: "idle" };
          } else if (b.length >= 16) {
            const running = b[2] === 0x01;
            const prog = b[4] !== 0xff ? normalizeWasherProgram(b[4], 0xdb) : simState.program;
            const waterLevel = b[5] !== 0xff ? b[5]! : simState.waterLevel;
            simState = {
              ...simState,
              running,
              runningStatus: running ? "start" : "pause",
              progress: running ? "wash" : "idle",
              program: prog,
              waterLevel,
            };
          }
        }
        const respFrame = buildWasherStatusResponseFrame(simState);
        socket.write(MideaLocalSecurity.encode5a5a(respFrame, decoded.applianceId));
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as net.AddressInfo).port;

    const provider = new MideaPlatformProvider({
      skipLoadConfig: true,
      initialConfig: {
        enabled: true,
        mode: "local",
        localDevices: [
          {
            id: devId,
            name: "阳台滚筒",
            ip: "127.0.0.1",
            port,
            type: 0xdb,
            protocolVersion: 2,
            room: "阳台",
          },
        ],
      },
    });

    try {
      const initial = await provider.readProps(devId, ["on", "program", "remain-time", "temperature"]);
      expect(initial).toEqual({
        on: true,
        program: "mixed_wash",
        "remain-time": 55,
        temperature: 40,
      });

      await provider.writeProp(devId, "program", "cotton");
      await provider.runAction(devId, "start-wash");
      expect(await provider.readProps(devId, ["running-status", "progress", "program"])).toEqual({
        "running-status": "start",
        progress: "wash",
        program: "cotton",
      });

      await provider.runAction(devId, "pause-wash");
      expect(await provider.readProp(devId, "running-status")).toBe("pause");

      await provider.setPowerState(devId, false);
      expect(await provider.powerState(devId)).toBe(false);
    } finally {
      provider.dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("洗衣机 HTTP 路由、状态摘要与 Pi Agent 工具集成", () => {
  const cleanups: Array<() => void> = [];
  let tempDir = "";

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "mijiadeck-washer-test-"));
    setDataPathOverrides({ dataDir: () => tempDir });
  });

  afterEach(() => {
    while (cleanups.length > 0) {
      cleanups.pop()!();
    }
    setDataPathOverrides(null);
    if (tempDir) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore temp cleanup errors
      }
      tempDir = "";
    }
  });

  function createWasherIntegrationHarness() {
    const cloud = createFakeMeijuWasherCloud({
      appliances: [
        {
          applianceCode: "210006741790988",
          name: "美的可爱多",
          type: "0xD9",
          onlineStatus: "1",
          modelNumber: "13363",
          sn8: "38135636",
          masterId: "3",
        },
      ],
      luaStateByKey: {
        "210006741790988:db:2": {
          bucket: "db",
          db_location: 2,
          db_position: 1,
          db_power: "on",
          db_running_status: "start",
          db_progress: 4,
          db_program: "mixed_wash",
          db_remain_time: 88,
          db_temperature: 4,
          db_dehydration_speed: 5,
          db_rinse_count: 2,
          db_water_level: 5,
          db_dry: 3,
          db_detergent: 2,
          db_softener: 1,
          db_door_opened: 0,
          db_detergent_needed: 0,
          db_softener_needed: 0,
          db_remote_control_flag: 1,
          db_error_code: 0,
        },
        "210006741790988:db:3": {
          bucket: "db",
          db_location: 3,
          db_position: 0,
          db_power: "on",
          db_running_status: "standby",
          db_progress: 32,
          db_program: 148,
          db_remain_time: 135,
          db_temperature: 3,
          db_dehydration_speed: 3,
          db_rinse_count: 2,
          db_water_level: 5,
          db_dry: 1,
          db_detergent: 1,
          db_softener: 0,
          db_detergent_needed: 1,
          db_remote_control_flag: 1,
          db_error_code: 0,
        },
        "210006741790988:db:4": {
          bucket: "db",
          db_location: 4,
          db_position: 0,
          db_power: "on",
          db_running_status: "standby",
          db_progress: 1028,
          db_program: 156,
          db_remain_time: 135,
          db_temperature: 4,
          db_dehydration_speed: 3,
          db_rinse_count: 2,
          db_water_level: 5,
          db_dry: 1,
          db_detergent: 1,
          db_softener: 0,
          db_detergent_needed: 0,
          db_remote_control_flag: 1,
          db_error_code: 0,
        },
      },
    });

    const service = createMultiPlatformService({
      mijiaService: new VirtualDemoService(),
      mideaOptions: {
        httpFetch: cloud.fetchFn,
        skipLoadConfig: true,
        initialConfig: {
          enabled: true,
          mode: "cloud",
          cloudBrand: "meiju",
          account: "13800138000",
          password: "Password!1",
          useChinaServer: true,
        },
      },
    });
    const jobs = new JobExecutor();
    const mw = new MainWindowController({ service, jobs });
    cleanups.push(() => {
      jobs.shutdown();
      service.dispose();
    });
    return { cloud, service, jobs, mw };
  }

  test("8. HTTP /detail、/prop 切筒与 /action 回读完整联动且不把洗涤水温污染为室内温度", async () => {
    const { service, jobs, mw } = createWasherIntegrationHarness();
    const all = await service.listDevices();
    const devices = all.filter((d) => d.did.startsWith("midea:"));
    mw.allDevices = devices;
    mw.loggedOut = false;
    mw.networkOnline = true;
    mw.syncAccessUi();
    const did = devices[0]!.did; // midea:210006741790988

    const runtime: AppRuntime = {
      mode: "demo",
      service,
      jobs,
      mainWindow: mw,
      themeCtrl: new ThemeController(),
      settingsStore,
      trayStore,
      broadcastState: () => {},
    };
    const handler = createRequestHandler(runtime);

    // 1. GET /api/devices/:did/detail
    const detailRes = await handler(
      new Request(`http://127.0.0.1/api/devices/${encodeURIComponent(did)}/detail`),
    );
    expect(detailRes.status).toBe(200);
    const detailJson = (await detailRes.json()) as Record<string, any>;
    expect(detailJson.ok).toBe(true);
    expect(detailJson.category).toBe("洗衣机");
    expect(detailJson.supportsPower).toBe(true);
    expect(detailJson.powerState).toBe(true);
    expect(detailJson.values["drum-location"]).toBe("bottom");
    expect(detailJson.values["running-status"]).toBe("start");
    expect(detailJson.values["remain-time"]).toBe(88);
    // 卡片指标应显示运行状态而不是水温 40°C
    expect(mw.metrics[did]).toBe("下筒 88分");

    // 2. POST /api/devices/:did/prop 切换至左筒，回读包含全量联动字段
    const switchRes = await handler(
      new Request(`http://127.0.0.1/api/devices/${encodeURIComponent(did)}/prop`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "drum-location", value: "left" }),
      }),
    );
    expect(switchRes.status).toBe(200);
    const switchJson = (await switchRes.json()) as Record<string, any>;
    expect(switchJson.ok).toBe(true);
    expect(switchJson.values["drum-location"]).toBe("left");
    expect(switchJson.values["program"]).toBe("socks");
    expect(switchJson.values["detergent-lack"]).toBe(true);

    // 3. POST /api/devices/:did/action 启动左筒洗涤并刷新状态
    const startRes = await handler(
      new Request(`http://127.0.0.1/api/devices/${encodeURIComponent(did)}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "start-wash" }),
      }),
    );
    expect(startRes.status).toBe(200);
    const startJson = (await startRes.json()) as Record<string, any>;
    expect(startJson.ok).toBe(true);
    expect(startJson.values["running-status"]).toBe("start");
    expect(mw.metrics[did]).toContain("下筒 88分");
    expect(mw.metrics[did]).toContain("左筒 135分");
  });

  test("9. Pi Agent 工具集完整识别、查询并控制美的洗衣机（中文字面枚举 + 动作参数）", async () => {
    const { cloud, service, jobs, mw } = createWasherIntegrationHarness();
    const devices = (await service.listDevices()).filter((d) => d.did.startsWith("midea:"));
    mw.allDevices = devices;
    mw.loggedOut = false;
    mw.networkOnline = true;
    mw.syncAccessUi();

    // 语义解析：洗衣机 / 阳台洗衣机 / 可爱多
    expect(resolveDevices(devices, { target: "阳台洗衣机" })).toHaveLength(1);
    expect(resolveDevices(devices, { target: "可爱多" })).toHaveLength(1);
    expect(resolveDevices(devices, { category: "washer" })).toHaveLength(1);

    const tools = createSmartHomeTools({
      service,
      jobs,
      mainWindow: mw,
      settingsStore,
      broadcastState: () => {},
    });
    const byName = new Map(tools.map((t) => [t.name, t]));

    const listRes = await byName.get("list_devices")!.execute("call-1", {
      platform: "midea",
      category: "washer",
    });
    expect((listRes.details as Record<string, unknown>).count).toBe(1);

    const detailRes = await byName.get("get_device_detail")!.execute("call-2", {
      target: "阳台洗衣机",
    });
    const uiSummary = String((detailRes.details as Record<string, unknown>).uiSummary ?? "");
    expect(uiSummary).toContain("美的可爱多");
    expect(uiSummary).toContain("运行中");
    expect(uiSummary).not.toContain("40°C");

    // 用中文值修改洗衣机程序
    const setRes = await byName.get("set_device_property")!.execute("call-3", {
      target: "美的可爱多",
      property: "洗涤程序",
      value: "智洗烘",
    });
    expect((setRes.details as Record<string, unknown>).ok).toBe(true);
    expect(cloud.luaControls.at(-1)?.control).toEqual({
      bucket: "db",
      db_location: 2,
      db_program: 138,
    });

    // 通过动作启动右筒洗涤
    const actRes = await byName.get("run_device_action")!.execute("call-4", {
      target: "美的可爱多",
      action: "开始洗涤",
      params: ["right"],
    });
    expect((actRes.details as Record<string, unknown>).ok).toBe(true);
    expect(cloud.luaControls.at(-1)?.control).toEqual({
      bucket: "db",
      db_location: 4,
      db_control_status: "start",
    });
  });

  test("10. 洗衣机告警遥测友好格式化与卡片指标格式化", () => {
    const dummyProp = (name: string, type: "bool" | "string" = "bool") => ({
      name,
      desc: name,
      type,
      readable: true,
      writable: false,
      unit: null,
      range: null,
      value_list: null,
    });
    expect(formatPropertyValue(dummyProp("door-opened"), false)).toBe("已关好");
    expect(formatPropertyValue(dummyProp("door-opened"), true)).toBe("已开启");
    expect(formatPropertyValue(dummyProp("detergent-lack"), true)).toBe("不足，请补充");
    expect(formatPropertyValue(dummyProp("detergent-lack"), false)).toBe("充足");
    expect(formatPropertyValue(dummyProp("remote-control-flag"), false)).toBe("未开启");
    expect(formatPropertyValue(dummyProp("error-code", "string"), "0")).toBe("无故障");
    expect(formatPropertyValue(dummyProp("error-code", "string"), "E10")).toBe("E10");

    const parsed = parseWasherLuaStatus(
      0xdb,
      {
        power: "on",
        running_status: "start",
        progress: 2, // rinse
        program: "cotton",
        remain_time: 22,
      },
      null,
    );
    expect(formatMideaMetrics(parsed)).toBe("漂洗中 · 剩 22 分");

    const singleMetrics = formatWasherCardMetrics(
      [
        {
          name: "progress",
          desc: "当前阶段",
          type: "string",
          readable: true,
          writable: false,
          unit: null,
          range: null,
          value_list: [{ value: "rinse", description: "Rinsing", desc_zh_cn: "漂洗中" }],
        },
      ],
      { "running-status": "start", progress: "rinse", "remain-time": 22 },
    );
    expect(singleMetrics).toBe("漂洗中 · 剩 22 分");

    // 无效控制指令返回 null
    expect(buildWasherLuaControlPayload(defaultWasherState(0xdb), "nonexistent")).toBeNull();
  });
});
