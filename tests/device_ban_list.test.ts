// SPDX-License-Identifier: GPL-3.0-or-later
/** Device ban/unban persistence, account isolation, MainWindow/Tray/RoomTabs filtering, Pi Agent exclusion, and REST/WS API. */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSmartHomeTools } from "../src/agent/smartHomeTools.ts";
import { PiAgentService } from "../src/agent/piAgentService.ts";
import * as accountStore from "../src/core/accountStore.ts";
import * as banStore from "../src/core/banStore.ts";
import type { IJobExecutor, JobSubmitOptions } from "../src/core/contracts.ts";
import { setDataPathOverrides } from "../src/core/jsonStore.ts";
import { createDeviceInfo } from "../src/core/models.ts";
import * as settingsStore from "../src/core/settingsStore.ts";
import * as trayStore from "../src/core/trayStore.ts";
import { VirtualDemoService } from "../src/core/virtualLightService.ts";
import { startMijiaDeckServer, type MijiaDeckServer } from "../src/server/server.ts";
import {
  ALL_HOMES,
  ALL_ROOMS,
  BANNED_TAB,
  MainWindowController,
} from "../src/ui/controllers/mainWindowController.ts";
import { computeRoomMenuCounts } from "../src/ui/controllers/roomTabsController.ts";

class ImmediateJobs implements IJobExecutor {
  submit<T>(fn: () => T | Promise<T>, options?: JobSubmitOptions<T>): void {
    Promise.resolve()
      .then(() => fn())
      .then((res) => options?.onSuccess?.(res))
      .catch((err) => options?.onError?.(err instanceof Error ? err : new Error(String(err))));
  }
  cancelPending(): void {}
  shutdown(): void {}
}

class NoopJobs implements IJobExecutor {
  submit(): void {}
  cancelPending(): void {}
  shutdown(): void {}
}

describe("DeviceBanListTest", () => {
  let tempDir = "";
  let server: MijiaDeckServer | null = null;
  let disposables: Array<{ dispose(): void }> = [];

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "mijiadeck-ban-test-"));
    const dir = tempDir;
    setDataPathOverrides({
      dataDir: () => dir,
      dataFile: (name) => path.join(dir, name),
    });
    disposables = [];
  });

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = null;
    }
    for (const d of disposables) {
      d.dispose();
    }
    disposables = [];
    setDataPathOverrides(null);
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = "";
    }
  });

  test("banStore persists deduplicated ordered ids and handles corrupt files safely", () => {
    expect(banStore.load()).toEqual([]);
    expect(banStore.contains("dev-1")).toBe(false);

    expect(banStore.add(" dev-1 ")).toEqual(["dev-1"]);
    expect(banStore.add("dev-2")).toEqual(["dev-1", "dev-2"]);
    expect(banStore.add("dev-1")).toEqual(["dev-1", "dev-2"]);
    expect(banStore.add("   ")).toEqual(["dev-1", "dev-2"]);
    expect(banStore.contains("dev-1")).toBe(true);
    expect([...banStore.loadSet()]).toEqual(["dev-1", "dev-2"]);

    expect(banStore.setBanned("dev-1", false)).toEqual(["dev-2"]);
    expect(banStore.contains("dev-1")).toBe(false);
    expect(banStore.load()).toEqual(["dev-2"]);

    // Corrupt JSON and mismatched version recover cleanly to empty
    writeFileSync(path.join(tempDir, "banned_devices.json"), "{invalid-json", "utf-8");
    expect(banStore.load()).toEqual([]);

    writeFileSync(
      path.join(tempDir, "banned_devices.json"),
      JSON.stringify({ version: 999, devices: ["dev-1"] }),
      "utf-8",
    );
    expect(banStore.load()).toEqual([]);
  });

  test("accountStore isolates banned_devices.json across Xiaomi accounts", () => {
    accountStore.activate("account-A");
    banStore.add("did-a1");
    expect(banStore.load()).toEqual(["did-a1"]);

    accountStore.activate("account-B");
    expect(banStore.load()).toEqual([]);
    banStore.add("did-b1");
    expect(banStore.load()).toEqual(["did-b1"]);

    accountStore.activate("account-A");
    expect(banStore.load()).toEqual(["did-a1"]);
  });

  test("MainWindowController hides banned devices from rooms, tray, voice, and moves them to 已屏蔽 tab", () => {
    const service = new VirtualDemoService();
    const mw = new MainWindowController({
      service,
      jobs: new NoopJobs(),
      cacheLoader: () => null,
      cacheSaver: () => {},
    });
    disposables.push(mw);

    const devices = [
      createDeviceInfo({
        did: "light-living",
        name: "客厅吸顶灯",
        model: "yeelink.light.ceiling1",
        home_name: "家一",
        room_name: "客厅",
        online: true,
        spec_type: "urn:miot-spec-v2:device:light:0000A001:yeelink-ceiling1:1",
        light_features: ["brightness"],
      }),
      createDeviceInfo({
        did: "router-study",
        name: "书房路由器",
        model: "xiaomi.router.be6500",
        home_name: "家一",
        room_name: "书房",
        online: true,
      }),
      createDeviceInfo({
        did: "speaker-living",
        name: "小爱音箱 Pro",
        model: "xiaomi.wifispeaker.lx06",
        home_name: "家一",
        room_name: "客厅",
        online: true,
      }),
      createDeviceInfo({
        did: "light-home2",
        name: "度假屋壁灯",
        model: "yeelink.light.lamp1",
        home_name: "家二",
        room_name: "卧室",
        online: true,
        spec_type: "urn:miot-spec-v2:device:light:0000A001:yeelink-lamp1:1",
      }),
    ];

    mw.loggedOut = false;
    mw.networkOnline = true;
    trayStore.setDeviceSelected("light-living", true);
    mw.applyDevices(devices);

    expect(mw.tabNames).toContain(BANNED_TAB);
    expect(mw.activeDevices().map((d) => d.did)).toEqual([
      "light-living",
      "router-study",
      "speaker-living",
      "light-home2",
    ]);
    expect(mw.tray!.quick.rows.some((r) => r.id === "light-living")).toBe(true);
    expect(mw.voiceDid).toBe("speaker-living");

    // Ban menu works even for non-tray-eligible devices like router
    const routerBanMenu = mw.buildDeviceBanMenu("router-study");
    expect(routerBanMenu).not.toBeNull();
    expect(routerBanMenu!.label).toBe("屏蔽设备");

    // Select 书房 then ban its only device -> falls back to 全屋 and removes empty 书房 tab
    mw.selectRoom("书房");
    expect(mw.currentRoom).toBe("书房");
    routerBanMenu!.trigger();
    expect(mw.isDeviceBanned("router-study")).toBe(true);
    expect(mw.tabNames).not.toContain("书房");
    expect(mw.currentRoom).toBe(ALL_ROOMS);

    // Ban light-living -> removed from 全屋, 客厅, tray quick rows, and TrayManager
    expect(mw.setDeviceBanned("light-living", true)).toBe(true);
    expect(mw.visibleDevices().map((d) => d.did)).not.toContain("light-living");
    expect(mw.tray!.quick.rows.some((r) => r.id === "light-living")).toBe(false);
    expect(mw.buildDeviceTrayMenu("light-living")).toBeNull();

    const trayMgr = mw.showTrayManager()!;
    disposables.push(trayMgr);
    expect(trayMgr.deviceRows.some((r) => r.did === "light-living")).toBe(false);

    // Room menu counts exclude banned devices from 全屋/客厅 and report 2 in 已屏蔽
    const menuCounts = mw.buildRoomMenu().entries.map((e) => [e.name, e.count]);
    expect(menuCounts).toContainEqual([ALL_ROOMS, 2]);
    expect(menuCounts).toContainEqual(["客厅", 1]);
    expect(menuCounts).toContainEqual([BANNED_TAB, 2]);

    // computeRoomMenuCounts helper matches
    expect(
      computeRoomMenuCounts(
        mw.activeDevices(),
        "家一",
        ["场景", "全屋", "客厅", "已屏蔽"],
        mw.bannedDevices(),
      ),
    ).toEqual([
      ["场景", null],
      ["全屋", 1],
      ["客厅", 1],
      ["已屏蔽", 2],
    ]);

    // Switch to 已屏蔽 tab -> lists both banned devices, count label shows 已屏蔽 2 台设备
    mw.selectRoom(BANNED_TAB);
    expect(mw.currentRoom).toBe(BANNED_TAB);
    expect(mw.visibleDevices().map((d) => d.did).sort()).toEqual(["light-living", "router-study"]);
    expect(mw.countLabelText).toBe("已屏蔽 2 台设备");

    // Home filtering applies inside 已屏蔽 tab too
    mw.selectHome("家二");
    mw.selectRoom(BANNED_TAB);
    expect(mw.visibleDevices()).toEqual([]);
    mw.selectHome(ALL_HOMES);
    mw.selectRoom(BANNED_TAB);

    // Ban speaker -> voice FAB hides & active speaker becomes null
    mw.setDeviceBanned("speaker-living", true);
    expect(mw.voiceDid).toBeNull();
    expect(mw.voiceFab.visible).toBe(false);

    // Unban from 已屏蔽 tab via buildDeviceBanMenu -> restores device & tray row
    const unbanLight = mw.buildDeviceBanMenu("light-living");
    expect(unbanLight?.label).toBe("取消屏蔽");
    unbanLight!.trigger();
    expect(mw.isDeviceBanned("light-living")).toBe(false);
    expect(mw.currentRoom).toBe(BANNED_TAB);
    expect(mw.tray!.quick.rows.some((r) => r.id === "light-living")).toBe(true);

    // Unban remaining devices -> stays on 已屏蔽 tab cleanly with 0 devices
    mw.setDeviceBanned("router-study", false);
    mw.setDeviceBanned("speaker-living", false);
    expect(mw.currentRoom).toBe(BANNED_TAB);
    expect(mw.visibleDevices()).toEqual([]);
    expect(mw.tabNames).toContain("书房");
    expect(mw.voiceDid).toBe("speaker-living");
  });

  test("Pi Agent and smartHomeTools never list or control banned devices until unbanned", async () => {
    const service = new VirtualDemoService();
    const jobs = new ImmediateJobs();
    const mw = new MainWindowController({
      service,
      jobs,
      tray: null,
      cacheLoader: () => null,
      cacheSaver: () => {},
    });
    disposables.push(mw);

    const demoDevices = await service.listDevices();
    mw.loggedOut = false;
    mw.networkOnline = true;
    mw.applyDevices(demoDevices);
    await Bun.sleep(30);

    const tools = createSmartHomeTools({
      service,
      jobs,
      mainWindow: mw,
      settingsStore,
      broadcastState: () => {},
    });
    const findTool = (name: string) => tools.find((t) => t.name === name)!;

    // Ensure living light starts ON
    await service.setPowerState("demo-light-living", true);
    mw.applyPowerState("demo-light-living", true);

    // Ban 客厅吸顶灯
    mw.setDeviceBanned("demo-light-living", true);

    // list_devices must not include banned device
    const listRes = await findTool("list_devices").execute("call-1", {});
    const listedDids = ((listRes.details as { devices: Array<{ did: string }> }).devices ?? []).map(
      (d) => d.did,
    );
    expect(listedDids).not.toContain("demo-light-living");

    // set_device_power("off", category: "light") must NOT turn off banned 客厅吸顶灯
    await findTool("set_device_power").execute("call-2", {
      state: "off",
      category: "light",
    });
    expect(await service.powerState("demo-light-living")).toBe(true);

    // control_light targeting banned 客厅吸顶灯 must fail with not found
    const lightRes = await findTool("control_light").execute("call-3", {
      target: "客厅吸顶灯",
      brightness: 40,
    });
    expect((lightRes.details as { ok: boolean }).ok).toBe(false);

    // Local PiAgent prompt("关闭客厅吸顶灯") must NOT turn off banned light
    const agent = new PiAgentService({
      deps: {
        service,
        jobs,
        mainWindow: mw,
        settingsStore,
        broadcastState: () => {},
      },
    });
    await agent.prompt("关闭客厅吸顶灯");
    expect(await service.powerState("demo-light-living")).toBe(true);

    // Unban -> now list_devices & control work again
    mw.setDeviceBanned("demo-light-living", false);
    const listAfter = await findTool("list_devices").execute("call-4", {});
    const listedAfterDids = (
      (listAfter.details as { devices: Array<{ did: string }> }).devices ?? []
    ).map((d) => d.did);
    expect(listedAfterDids).toContain("demo-light-living");

    await findTool("set_device_power").execute("call-5", {
      state: "off",
      target: "客厅吸顶灯",
    });
    expect(await service.powerState("demo-light-living")).toBe(false);
  });

  test("REST API /api/devices/:did/ban, /api/devices/banned, /api/room, and WebSocket broadcast work end-to-end", async () => {
    server = await startMijiaDeckServer({ mode: "demo", port: 0 });
    const base = server.url;

    // Connect WebSocket client to observe live broadcasts
    const wsUrl = base.replace(/^http/, "ws") + "/ws";
    const wsMessages: Array<Record<string, unknown>> = [];
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error("WS failed")), { once: true });
    });
    ws.addEventListener("message", (ev) => {
      try {
        wsMessages.push(JSON.parse(String(ev.data)) as Record<string, unknown>);
      } catch {
        // ignore
      }
    });

    // Initial state has 已屏蔽 in rooms and 0 banned devices
    const initState = (await (await fetch(`${base}/api/state`)).json()) as {
      rooms: string[];
      bannedDeviceIds: string[];
      bannedDevices: Array<{ did: string }>;
      visibleDevices: Array<{ did: string }>;
      roomMenu: Array<{ name: string; count: number | null; selected?: boolean }>;
    };
    expect(initState.rooms).toContain(BANNED_TAB);
    expect(initState.bannedDeviceIds).toEqual([]);
    expect(initState.bannedDevices).toEqual([]);
    expect(initState.visibleDevices.some((d) => d.did === "demo-light-living")).toBe(true);
    expect(initState.roomMenu).toContainEqual({ name: BANNED_TAB, count: 0, selected: false });

    // Ban demo-light-living
    const banRes = await fetch(`${base}/api/devices/demo-light-living/ban`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ banned: true }),
    });
    expect(banRes.status).toBe(200);
    const banBody = (await banRes.json()) as {
      ok: boolean;
      banned: boolean;
      bannedDeviceIds: string[];
      bannedDevices: Array<{ did: string }>;
      visibleDevices: Array<{ did: string }>;
      roomMenu: Array<{ name: string; count: number | null; selected?: boolean }>;
    };
    expect(banBody.ok).toBe(true);
    expect(banBody.banned).toBe(true);
    expect(banBody.bannedDeviceIds).toEqual(["demo-light-living"]);
    expect(banBody.bannedDevices.map((d) => d.did)).toEqual(["demo-light-living"]);
    expect(banBody.visibleDevices.some((d) => d.did === "demo-light-living")).toBe(false);
    expect(banBody.roomMenu.find((e) => e.name === BANNED_TAB)?.count).toBe(1);

    // GET /api/devices/banned reflects the banned device
    const bannedListRes = await fetch(`${base}/api/devices/banned`);
    expect(bannedListRes.status).toBe(200);
    const bannedListBody = (await bannedListRes.json()) as {
      ok: boolean;
      bannedDeviceIds: string[];
      bannedDevices: Array<{ did: string }>;
    };
    expect(bannedListBody.bannedDeviceIds).toEqual(["demo-light-living"]);
    expect(bannedListBody.bannedDevices.map((d) => d.did)).toEqual(["demo-light-living"]);

    // Adding a banned device to tray is rejected with 400
    const trayRejectRes = await fetch(`${base}/api/tray/membership`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "device", id: "demo-light-living", selected: true }),
    });
    expect(trayRejectRes.status).toBe(400);

    // Switching room to 已屏蔽 shows only the banned device in visibleDevices
    const bannedRoomRes = await fetch(`${base}/api/room`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ room: BANNED_TAB }),
    });
    expect(bannedRoomRes.status).toBe(200);
    const bannedRoomBody = (await bannedRoomRes.json()) as {
      ok: boolean;
      room: string;
      visibleDevices: Array<{ did: string }>;
    };
    expect(bannedRoomBody.room).toBe(BANNED_TAB);
    expect(bannedRoomBody.visibleDevices.map((d) => d.did)).toEqual(["demo-light-living"]);

    // Unban demo-light-living
    const unbanRes = await fetch(`${base}/api/devices/demo-light-living/ban`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ banned: false }),
    });
    expect(unbanRes.status).toBe(200);
    const unbanBody = (await unbanRes.json()) as {
      ok: boolean;
      banned: boolean;
      bannedDeviceIds: string[];
      visibleDevices: Array<{ did: string }>;
    };
    expect(unbanBody.banned).toBe(false);
    expect(unbanBody.bannedDeviceIds).toEqual([]);
    expect(unbanBody.visibleDevices).toEqual([]);

    // Switch back to 全屋 -> demo-light-living is restored
    const allRoomRes = await fetch(`${base}/api/room`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ room: ALL_ROOMS }),
    });
    const allRoomBody = (await allRoomRes.json()) as {
      visibleDevices: Array<{ did: string }>;
    };
    expect(allRoomBody.visibleDevices.some((d) => d.did === "demo-light-living")).toBe(true);

    // Validation errors: unknown device -> 404; non-boolean banned -> 400
    const notFoundRes = await fetch(`${base}/api/devices/does-not-exist/ban`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ banned: true }),
    });
    expect(notFoundRes.status).toBe(404);

    const badParamRes = await fetch(`${base}/api/devices/demo-light-living/ban`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ banned: "yes" }),
    });
    expect(badParamRes.status).toBe(400);

    // Confirm WebSocket received state broadcasts containing bannedDeviceIds
    await Bun.sleep(100);
    const hasBannedBroadcast = wsMessages.some((m) => {
      const state = (m.state ?? m.data ?? m) as { bannedDeviceIds?: string[] };
      return Array.isArray(state.bannedDeviceIds) && state.bannedDeviceIds.includes("demo-light-living");
    });
    expect(hasBannedBroadcast).toBe(true);

    ws.close();
  });
});
