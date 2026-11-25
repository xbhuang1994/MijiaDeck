// SPDX-License-Identifier: GPL-3.0-or-later
/** End-to-end HTTP REST API, static asset security, QR SVG rendering, and WebSocket live broadcast tests. */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { APP_NAME, APP_VERSION } from "../src/core/appMeta.ts";
import { setDataPathOverrides } from "../src/core/jsonStore.ts";
import { createRequestHandler } from "../src/server/routes.ts";
import { startMijiaDeckServer, type MijiaDeckServer } from "../src/server/server.ts";
import { renderQrSvg } from "../src/ui/qrSvg.ts";
import { setAccent, setTheme } from "../src/ui/theme.ts";

function rawHttpGetStatus(host: string, port: number, rawPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port });
    let data = "";
    socket.setEncoding("utf-8");
    socket.on("connect", () => {
      socket.write(`GET ${rawPath} HTTP/1.1\r\nHost: ${host}:${port}\r\nConnection: close\r\n\r\n`);
    });
    socket.on("data", (chunk) => {
      data += chunk;
    });
    socket.on("end", () => {
      const [head = "", body = ""] = data.split("\r\n\r\n");
      const statusLine = head.split("\r\n")[0] ?? "";
      const match = /^HTTP\/\d\.\d\s+(\d+)/.exec(statusLine);
      resolve({ status: match ? Number.parseInt(match[1]!, 10) : 0, body });
    });
    socket.on("error", reject);
  });
}

describe("ServerApiTest", () => {
  let tempDir = "";
  let server: MijiaDeckServer | null = null;

  beforeEach(async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "mijiadeck-server-api-test-"));
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

  test("static routes, assets, health, and state endpoints return 200 with valid content", async () => {
    const base = server!.url;

    const indexRes = await fetch(`${base}/`);
    expect(indexRes.status).toBe(200);
    expect(indexRes.headers.get("content-type")).toContain("text/html");
    expect(await indexRes.text()).toContain(APP_NAME);

    const stylesRes = await fetch(`${base}/styles.css`);
    expect(stylesRes.status).toBe(200);
    expect(stylesRes.headers.get("content-type")).toContain("text/css");
    expect((await stylesRes.text()).length).toBeGreaterThan(0);

    const themeCssRes = await fetch(`${base}/theme.css`);
    expect(themeCssRes.status).toBe(200);
    expect(themeCssRes.headers.get("content-type")).toContain("text/css");
    const themeCss = await themeCssRes.text();
    expect(themeCss).toContain(":root");
    expect(themeCss).not.toMatch(/\$[A-Z][A-Z0-9_]*/);

    const appJsRes = await fetch(`${base}/app.js`);
    expect(appJsRes.status).toBe(200);
    expect(appJsRes.headers.get("content-type")).toContain("application/javascript");
    expect((await appJsRes.text()).length).toBeGreaterThan(100);

    const iconRes = await fetch(`${base}/assets/icon.png`);
    expect(iconRes.status).toBe(200);
    expect(iconRes.headers.get("content-type")).toContain("image/png");
    const iconBytes = new Uint8Array(await iconRes.arrayBuffer());
    expect(iconBytes.length).toBeGreaterThan(8);
    expect(Array.from(iconBytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);

    const healthRes = await fetch(`${base}/api/health`);
    expect(healthRes.status).toBe(200);
    expect(await healthRes.json()).toEqual({
      ok: true,
      app: APP_NAME,
      version: APP_VERSION,
      mode: "demo",
    });

    const stateRes = await fetch(`${base}/api/state`);
    expect(stateRes.status).toBe(200);
    const state = (await stateRes.json()) as Record<string, unknown>;
    expect(state.ok).toBe(true);
    expect(state.mode).toBe("demo");
    expect(state.loggedIn).toBe(true);
    expect(state.accessState).toBe("ready");
    expect(Array.isArray(state.devices)).toBe(true);
    expect((state.devices as unknown[]).length).toBeGreaterThan(0);
  });

  test("path traversal under /assets/ is rejected with 403/400", async () => {
    const base = server!.url;

    // Live HTTP traversal payloads preserved across WHATWG URL / Bun.serve normalization
    for (const payload of [
      "/assets/..%2fpackage.json",
      "/assets/%2e%2e%2fpackage.json",
      "/assets/%2e%2e%5cpackage.json",
    ]) {
      const res = await fetch(`${base}${payload}`);
      expect([400, 403]).toContain(res.status);
      expect(await res.text()).not.toContain('"devDependencies"');
    }

    // Direct handler check for unnormalized /assets/../package.json
    const handler = createRequestHandler(server!.runtime);
    const directRes = await handler({
      method: "GET",
      url: "http://127.0.0.1/assets/../package.json",
    } as Request);
    expect([400, 403]).toContain(directRes.status);
    expect(await directRes.text()).not.toContain('"devDependencies"');

    // Unnormalized literal /assets/../package.json over raw TCP socket never leaks package.json
    const raw = await rawHttpGetStatus("127.0.0.1", server!.port, "/assets/../package.json");
    expect(raw.status).toBeGreaterThanOrEqual(400);
    expect(raw.body).not.toContain('"devDependencies"');
  });

  test("device power toggle, light controls, and property writes update state", async () => {
    const base = server!.url;
    const did = "demo-light-living";

    // Toggle power from initial true -> false
    const toggleRes = await fetch(`${base}/api/devices/${did}/power`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(toggleRes.status).toBe(200);
    const toggleBody = (await toggleRes.json()) as Record<string, unknown>;
    expect(toggleBody.ok).toBe(true);
    expect(toggleBody.state).toBe(false);

    // Explicitly turn power back on
    const onRes = await fetch(`${base}/api/devices/${did}/power`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: true }),
    });
    expect(onRes.status).toBe(200);
    const onBody = (await onRes.json()) as Record<string, unknown>;
    expect(onBody.ok).toBe(true);
    expect(onBody.state).toBe(true);

    // Read light controls
    const lightRes = await fetch(`${base}/api/devices/${did}/light`);
    expect(lightRes.status).toBe(200);
    const lightData = (await lightRes.json()) as {
      ok: boolean;
      did: string;
      controls: Record<string, unknown>;
      values: Record<string, unknown>;
    };
    expect(lightData.ok).toBe(true);
    expect(lightData.did).toBe(did);
    expect(lightData.controls.brightness).toBeDefined();
    expect(lightData.controls.temperature).toBeDefined();
    expect(lightData.controls.color).toBeDefined();

    // Write brightness property and verify readback
    const propRes = await fetch(`${base}/api/devices/${did}/prop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "brightness", value: 88 }),
    });
    expect(propRes.status).toBe(200);
    const propBody = (await propRes.json()) as {
      ok: boolean;
      values: Record<string, unknown>;
    };
    expect(propBody.ok).toBe(true);
    expect(propBody.values.brightness).toBe(88);

    const lightAfter = (await (await fetch(`${base}/api/devices/${did}/light`)).json()) as {
      values: Record<string, unknown>;
    };
    expect(lightAfter.values.brightness).toBe(88);
  });

  test("scene execution is blocked while disabled and voice commands still succeed", async () => {
    const base = server!.url;

    const sleepRes = await fetch(`${base}/api/scenes/demo-scene-sleep/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(sleepRes.status).toBe(403);
    const sleepBody = (await sleepRes.json()) as { ok: boolean; error: string };
    expect(sleepBody.ok).toBe(false);

    const stateAfterBlockedScene = (await (await fetch(`${base}/api/state`)).json()) as {
      knownPower: Record<string, boolean | null>;
      scenes: unknown[];
      rooms: string[];
    };
    expect(stateAfterBlockedScene.knownPower["demo-light-living"]).toBe(true);
    expect(stateAfterBlockedScene.scenes).toEqual([]);
    expect(stateAfterBlockedScene.rooms).not.toContain("场景");

    const voiceRes = await fetch(`${base}/api/voice`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "打开卧室灯" }),
    });
    expect(voiceRes.status).toBe(200);
    const voiceBody = (await voiceRes.json()) as { ok: boolean; did: string; message: string };
    expect(voiceBody.ok).toBe(true);
    expect(voiceBody.did).toBe("demo-speaker-xiaoai");
    expect(voiceBody.message).toContain("已告诉小爱同学：打开卧室灯");
  });

  test("home/room switching, tray membership & save, theme preview, and settings persistence", async () => {
    const base = server!.url;

    // Home & room switching
    const homeRes = await fetch(`${base}/api/home`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ home: "示例之家" }),
    });
    expect(homeRes.status).toBe(200);
    const homeData = (await homeRes.json()) as { ok: boolean; home: string };
    expect(homeData.ok).toBe(true);
    expect(homeData.home).toBe("示例之家");

    const roomRes = await fetch(`${base}/api/room`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ room: "客厅" }),
    });
    expect(roomRes.status).toBe(200);
    const roomData = (await roomRes.json()) as {
      ok: boolean;
      room: string;
      visibleDevices: Array<{ room_name: string }>;
    };
    expect(roomData.ok).toBe(true);
    expect(roomData.room).toBe("客厅");
    expect(roomData.visibleDevices.length).toBeGreaterThan(0);
    expect(roomData.visibleDevices.every((d) => d.room_name === "客厅")).toBe(true);

    // Tray membership toggle
    const memberRes = await fetch(`${base}/api/tray/membership`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "device", id: "demo-light-living", selected: true }),
    });
    expect(memberRes.status).toBe(200);
    const memberData = (await memberRes.json()) as {
      ok: boolean;
      tray: { devices: string[] };
    };
    expect(memberData.ok).toBe(true);
    expect(memberData.tray.devices).toContain("demo-light-living");

    // Tray full save strips scene entries while scenes feature is disabled
    const saveTrayRes = await fetch(`${base}/api/tray/save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        devices: ["demo-light-living"],
        scenes: [
          {
            scene_id: "demo-scene-home",
            name: "回家模式",
            home_id: "demo-home-1",
            home_name: "示例之家",
          },
        ],
        order: [
          { type: "scene", id: "demo-scene-home" },
          { type: "device", id: "demo-light-living" },
        ],
      }),
    });
    expect(saveTrayRes.status).toBe(200);
    const saveTrayData = (await saveTrayRes.json()) as {
      ok: boolean;
      tray: { scenes: unknown[]; order: Array<{ type: string; id: string }> };
    };
    expect(saveTrayData.ok).toBe(true);
    expect(saveTrayData.tray.scenes).toEqual([]);
    expect(saveTrayData.tray.order).toEqual([
      { type: "device", id: "demo-light-living" },
    ]);

    // Theme preview updates runtime CSS without persisting to settings.json
    const previewRes = await fetch(`${base}/api/theme/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "light", color: "blue" }),
    });
    expect(previewRes.status).toBe(200);
    const previewData = (await previewRes.json()) as {
      ok: boolean;
      theme: { effective: string; accent: string };
    };
    expect(previewData.ok).toBe(true);
    expect(previewData.theme.effective).toBe("light");
    expect(previewData.theme.accent).toBe("blue");

    const beforeSaveSettings = (await (await fetch(`${base}/api/settings`)).json()) as {
      settings: { theme: string; theme_color: string };
    };
    expect(beforeSaveSettings.settings.theme).toBe("system");
    expect(beforeSaveSettings.settings.theme_color).toBe("green");

    // Save settings persists theme & custom accent color
    const saveSettingsRes = await fetch(`${base}/api/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        theme: "light",
        theme_color: "#336699",
        show_scene_tab: false,
      }),
    });
    expect(saveSettingsRes.status).toBe(200);
    const savedSettings = (await saveSettingsRes.json()) as {
      ok: boolean;
      settings: { theme: string; theme_color: string; show_scene_tab: boolean };
    };
    expect(savedSettings.ok).toBe(true);
    expect(savedSettings.settings.theme).toBe("light");
    expect(savedSettings.settings.theme_color).toBe("#336699");
    expect(savedSettings.settings.show_scene_tab).toBe(false);

    const updatedThemeCss = await (await fetch(`${base}/theme.css`)).text();
    expect(updatedThemeCss).toContain("#336699");
  });

  test("privacy-safe diagnostics, camera PTZ, and QR SVG renderer", async () => {
    const base = server!.url;
    const camDid = "demo-camera-cs2";

    const diagRes = await fetch(`${base}/api/diagnostics`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ did: camDid }),
    });
    expect(diagRes.status).toBe(200);
    const diagBody = (await diagRes.json()) as { ok: boolean; did: string; report: string };
    expect(diagBody.ok).toBe(true);
    expect(diagBody.report).toContain("chuangmi.camera.029a02");
    expect(diagBody.report).not.toContain("PRIVATE");
    expect(diagBody.report).not.toContain(camDid);

    const ptzRes = await fetch(`${base}/api/camera/${camDid}/ptz`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ direction: 2 }),
    });
    expect(ptzRes.status).toBe(200);
    expect(await ptzRes.json()).toEqual({
      ok: true,
      did: camDid,
      direction: 2,
    });

    const badPtzRes = await fetch(`${base}/api/camera/${camDid}/ptz`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ direction: 9 }),
    });
    expect(badPtzRes.status).toBe(400);

    const svg = renderQrSvg("https://account.xiaomi.com/qr?id=mijiadeck-test", 220);
    expect(svg.startsWith("<svg ")).toBe(true);
    expect(svg.endsWith("</svg>")).toBe(true);
    expect(svg).toContain('width="220"');
    expect(svg).toContain('height="220"');
    expect(svg).toContain("viewBox=");
    expect(svg).toContain("<path ");

    const utf8Svg = renderQrSvg("米家扫码登录", 180, "L");
    expect(utf8Svg).toContain('width="180"');
    expect(utf8Svg).toContain("<path ");
  });

  test("WebSocket /ws delivers initial state, responds to ping, and broadcasts live mutations", async () => {
    const wsUrl = `${server!.url.replace("http://", "ws://")}/ws`;
    const ws = new WebSocket(wsUrl);
    const messages: Array<Record<string, unknown>> = [];
    const waiters: Array<() => void> = [];

    const waitFor = (predicate: () => boolean, timeoutMs = 3_000): Promise<void> => {
      if (predicate()) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error("Timed out waiting for WebSocket message"));
        }, timeoutMs);
        const check = (): void => {
          if (predicate()) {
            clearTimeout(timer);
            resolve();
          } else {
            waiters.push(check);
          }
        };
        waiters.push(check);
      });
    };

    try {
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve());
        ws.addEventListener("error", () => reject(new Error("WebSocket open failed")));
        ws.addEventListener("message", (event) => {
          const parsed = JSON.parse(String(event.data)) as Record<string, unknown>;
          messages.push(parsed);
          const pending = waiters.splice(0, waiters.length);
          for (const fn of pending) {
            fn();
          }
        });
      });

      // Initial state snapshot sent on connect
      await waitFor(() => messages.some((m) => m.type === "state"));
      const initialMsg = messages.find((m) => m.type === "state") as {
        data: { devices: unknown[]; knownPower: Record<string, boolean | null> };
      };
      expect(initialMsg.data.devices.length).toBeGreaterThan(0);

      // Ping/pong heartbeat
      ws.send("ping");
      await waitFor(() => messages.some((m) => m.type === "pong"));

      // Trigger power toggle via HTTP and observe live WebSocket broadcast
      const countBefore = messages.length;
      const powerRes = await fetch(`${server!.url}/api/devices/demo-light-living/power`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: false }),
      });
      expect(powerRes.status).toBe(200);

      await waitFor(() =>
        messages.slice(countBefore).some((m) => {
          if (m.type !== "state") return false;
          const data = m.data as { knownPower?: Record<string, boolean | null> } | undefined;
          return data?.knownPower?.["demo-light-living"] === false;
        }),
      );
    } finally {
      ws.close();
    }
  });
});
