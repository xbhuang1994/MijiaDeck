// SPDX-License-Identifier: GPL-3.0-or-later
/** Regression tests verifying scenes and scene-related configurations are disabled across UI, controllers, API, and Pi Agent. */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IJobExecutor, JobSubmitOptions } from "../src/core/contracts.ts";
import { SCENES_FEATURE_ENABLED } from "../src/core/featureFlags.ts";
import { setDataPathOverrides } from "../src/core/jsonStore.ts";
import { createDeviceInfo, createSceneInfo } from "../src/core/models.ts";
import * as settingsStore from "../src/core/settingsStore.ts";
import * as trayStore from "../src/core/trayStore.ts";
import { VirtualLightService } from "../src/core/virtualLightService.ts";
import { startMijiaDeckServer, type MijiaDeckServer } from "../src/server/server.ts";
import {
  ALL_ROOMS,
  MainWindowController,
  SCENE_TAB,
} from "../src/ui/controllers/mainWindowController.ts";
import { SettingsDialogController } from "../src/ui/controllers/settingsDialogController.ts";
import { TrayManagerController } from "../src/ui/controllers/trayManagerController.ts";
import { TrayQuickWindowController } from "../src/ui/controllers/trayQuickController.ts";

class SyncJobs implements IJobExecutor {
  submit<T>(fn: () => T | Promise<T>, options?: JobSubmitOptions<T>): void {
    Promise.resolve()
      .then(() => fn())
      .then((res) => options?.onSuccess?.(res))
      .catch((err) => options?.onError?.(err instanceof Error ? err : new Error(String(err))));
  }
  cancelPending(): void {}
  shutdown(): void {}
}

describe("ScenesDisabledTest", () => {
  let tempDir = "";
  let server: MijiaDeckServer | null = null;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "mijiadeck-scenes-disabled-"));
    setDataPathOverrides({
      dataDir: () => tempDir,
      dataFile: (name) => path.join(tempDir, name),
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

  test("feature flag is false and settingsStore ignores show_scene_tab even with legacy settings.json", () => {
    expect(SCENES_FEATURE_ENABLED).toBe(false);

    // Seed legacy settings.json with show_scene_tab: true
    writeFileSync(
      path.join(tempDir, "settings.json"),
      JSON.stringify({ version: 1, show_scene_tab: true }),
    );
    expect(settingsStore.getShowSceneTab()).toBe(false);

    settingsStore.setShowSceneTab(true);
    expect(settingsStore.getShowSceneTab()).toBe(false);

    const dlg = new SettingsDialogController();
    expect(dlg.showSceneTab).toBe(false);
    dlg.setShowSceneTab(true);
    expect(dlg.showSceneTab).toBe(false);
    expect(dlg.save()).toBe(true);
    expect(settingsStore.getShowSceneTab()).toBe(false);
  });

  test("MainWindowController omits scene tab, never fetches/runs scenes, and redirects SCENE_TAB to ALL_ROOMS", () => {
    const service = new VirtualLightService();
    const sceneListSpy = mock(async () => [
      createSceneInfo({ scene_id: "s1", name: "回家模式", home_id: "h1", home_name: "家" }),
    ]);
    const runSceneSpy = mock(async () => {});
    service.sceneList = sceneListSpy;
    service.runScene = runSceneSpy;

    const mw = new MainWindowController({
      service,
      jobs: new SyncJobs(),
      tray: null,
      cacheLoader: () => null,
      cacheSaver: () => {},
    });
    try {
      mw.loggedOut = false;
      mw.networkOnline = true;
      mw.applyDevices([
        createDeviceInfo({
          did: "d1",
          name: "客厅灯",
          model: "yeelink.light.lamp1",
          home_name: "家",
          room_name: "客厅",
          online: true,
        }),
      ]);

      expect(mw.showSceneTab).toBe(false);
      expect(mw.tabNames).not.toContain(SCENE_TAB);
      expect(mw.buildRoomMenu().entries.map((e) => e.name)).not.toContain(SCENE_TAB);
      expect(sceneListSpy).not.toHaveBeenCalled();

      mw.selectRoom(SCENE_TAB);
      expect(mw.currentRoom).toBe(ALL_ROOMS);
      expect(sceneListSpy).not.toHaveBeenCalled();

      mw.loadScenes();
      mw.onSceneExecuted("s1");
      expect(sceneListSpy).not.toHaveBeenCalled();
      expect(runSceneSpy).not.toHaveBeenCalled();
    } finally {
      mw.dispose();
    }
  });

  test("TrayManagerController and TrayQuickWindowController hide legacy saved scenes completely", () => {
    const dev = createDeviceInfo({
      did: "d1",
      name: "客厅灯",
      model: "yeelink.light.lamp1",
      home_name: "家",
      room_name: "客厅",
      online: true,
    });
    trayStore.save(["d1"]);
    trayStore.saveScenes([
      { scene_id: "legacy-s1", name: "回家模式", home_id: "h1", home_name: "家" },
    ]);
    trayStore.saveOrder([
      { type: "scene", id: "legacy-s1" },
      { type: "device", id: "d1" },
    ]);

    const mgr = new TrayManagerController([dev]);
    try {
      expect(mgr.tabLabels).toEqual(["设备"]);
      mgr.switchTab(1);
      expect(mgr.activeTab).toBe(0);
      expect(mgr.sceneListVisible).toBe(false);
      expect(mgr.selectedOrder()).toEqual([{ type: "device", id: "d1" }]);
      expect(mgr.selectedSceneData()).toEqual([]);

      mgr.switchView("sort");
      expect(mgr.sortLayoutIds()).toEqual(["d1"]);
    } finally {
      mgr.dispose();
    }

    const runSceneSpy = mock(async () => {});
    const quick = new TrayQuickWindowController(
      { runScene: runSceneSpy },
      new SyncJobs(),
    );
    try {
      quick.show();
      quick.setAccessState("ready");
      quick.setDevices([dev], { d1: true });
      expect(quick.rows.map((r) => `${r.type}:${r.id}`)).toEqual(["device:d1"]);

      quick.runScene("legacy-s1");
      expect(runSceneSpy).not.toHaveBeenCalled();
    } finally {
      quick.dispose();
    }
  });

  test("HTTP server strips scenes from state/platforms/tray, blocks scene endpoints, and refuses enabling show_scene_tab", async () => {
    // Seed legacy settings & tray with scenes before server boots
    writeFileSync(
      path.join(tempDir, "settings.json"),
      JSON.stringify({ version: 1, show_scene_tab: true }),
    );
    writeFileSync(
      path.join(tempDir, "tray.json"),
      JSON.stringify({
        version: 1,
        devices: ["demo-light-living"],
        scenes: [{ scene_id: "demo-scene-home", name: "回家模式", home_id: "demo-home-1", home_name: "示例之家" }],
        order: [
          { type: "scene", id: "demo-scene-home" },
          { type: "device", id: "demo-light-living" },
        ],
      }),
    );

    server = await startMijiaDeckServer({
      port: 0,
      hostname: "127.0.0.1",
      mode: "demo",
      autoStart: true,
      autoStartTimers: false,
    });
    const base = server.url;

    const state = (await (await fetch(`${base}/api/state`)).json()) as {
      scenesEnabled: boolean;
      scenes: unknown[];
      rooms: string[];
      roomMenu: Array<{ name: string }>;
      settings: { show_scene_tab: boolean; scenes_enabled: boolean };
      tray: { scenes: unknown[]; order: Array<{ type: string; id: string }> };
      platforms: Array<{ id: string; sceneCount: number; capabilities: { scenes: boolean } }>;
    };
    expect(state.scenesEnabled).toBe(false);
    expect(state.scenes).toEqual([]);
    expect(state.rooms).not.toContain(SCENE_TAB);
    expect(state.roomMenu.map((e) => e.name)).not.toContain(SCENE_TAB);
    expect(state.settings.show_scene_tab).toBe(false);
    expect(state.settings.scenes_enabled).toBe(false);
    expect(state.tray.scenes).toEqual([]);
    expect(state.tray.order).toEqual([{ type: "device", id: "demo-light-living" }]);
    for (const pf of state.platforms) {
      expect(pf.sceneCount).toBe(0);
      expect(pf.capabilities.scenes).toBe(false);
    }

    // Attempt to re-enable show_scene_tab via /api/settings must remain false
    const saveSettingsRes = await fetch(`${base}/api/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ show_scene_tab: true, showSceneTab: true }),
    });
    expect(saveSettingsRes.status).toBe(200);
    const saveSettingsBody = (await saveSettingsRes.json()) as {
      settings: { show_scene_tab: boolean };
      rooms: string[];
    };
    expect(saveSettingsBody.settings.show_scene_tab).toBe(false);
    expect(saveSettingsBody.rooms).not.toContain(SCENE_TAB);

    // Switching to 场景 room is rejected (404)
    const roomRes = await fetch(`${base}/api/room`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ room: SCENE_TAB }),
    });
    expect(roomRes.status).toBe(404);

    // Running a scene is rejected (403)
    const runRes = await fetch(`${base}/api/scenes/demo-scene-home/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(runRes.status).toBe(403);

    // Adding a scene to tray via membership API is rejected (403)
    const trayMemberRes = await fetch(`${base}/api/tray/membership`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "scene", id: "demo-scene-home", selected: true }),
    });
    expect(trayMemberRes.status).toBe(403);

    // Web HTML hides scene settings card and tray manager scene tab
    const html = readFileSync(path.join(process.cwd(), "src/web/index.html"), "utf-8");
    expect(html).toContain('id="setting-row-show-scene-tab" hidden');
    expect(html).toContain('id="tray-mgr-tab-scenes" role="tab" aria-selected="false" data-tm-tab="scenes" hidden');
    expect(html).not.toContain("设备与场景列表");
  });
});
