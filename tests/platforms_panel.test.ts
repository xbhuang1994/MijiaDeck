// SPDX-License-Identifier: GPL-3.0-or-later
/** Unit tests for modular multi-platform frontend controller helpers & browser-safety. */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  buildDeyeConfigPayload,
  buildMideaConfigPayload,
  buildTuyaConfigPayload,
  DEFAULT_DEYE_ENDPOINT,
  deyeFormStateFromSummary,
  formatMideaTypeLabel,
  formatPlatformSummaryLine,
  mergeDiscoveredDeyeInverter,
  mergeDiscoveredMideaDevice,
  mergeDiscoveredTuyaDevice,
  MIDEA_DEVICE_TYPES,
  mideaFormStateFromSummary,
  normalizeDeyeInverters,
  normalizeMideaLocalDevices,
  normalizeTuyaLocalDevices,
  parseLocalDevicesJson,
  parseMideaTypeCode,
  PLATFORM_DISPLAY_META,
  platformBadgeInfo,
  PlatformsPanelController,
  platformStatusTone,
  sanitizePlatformErrorMessage,
  tuyaFormStateFromSummary,
  UI_PLATFORM_ORDER,
  type UiDiscoveredLocalDevice,
  type UiPlatformId,
  type UiPlatformStatus,
} from "../src/web/platformsPanel.ts";

function makeStatus(overrides: Partial<UiPlatformStatus> = {}): UiPlatformStatus {
  const id: UiPlatformId = overrides.id ?? "tuya";
  const meta = PLATFORM_DISPLAY_META[id];
  return {
    id,
    name: meta.badgeText,
    displayName: meta.displayName,
    badgeText: meta.badgeText,
    accentColor: meta.color,
    description: meta.description,
    reference: meta.reference,
    enabled: false,
    connected: false,
    state: "disconnected",
    authMode: "qr",
    deviceCount: 0,
    sceneCount: 0,
    lastSyncAt: null,
    lastError: null,
    capabilities: {
      cloud: true,
      local: id !== "mijia",
      qrAuth: id === "mijia" || id === "tuya",
      credentialsAuth: id === "midea" || id === "deye",
      openApiAuth: id === "tuya",
      lanDiscovery: id === "tuya" || id === "midea",
      scenes: id === "mijia" || id === "tuya",
    },
    configSummary: {},
    ...overrides,
  };
}

describe("PLATFORM_DISPLAY_META", () => {
  test("contains complete metadata for all 4 platforms with distinct badges and valid hex colors", () => {
    expect(UI_PLATFORM_ORDER).toEqual(["mijia", "tuya", "midea", "deye"]);

    const seenBadges = new Set<string>();
    const seenColors = new Set<string>();

    for (const id of UI_PLATFORM_ORDER) {
      const meta = PLATFORM_DISPLAY_META[id];
      expect(meta).toBeDefined();
      expect(meta.id).toBe(id);
      expect(meta.badgeText.length).toBeGreaterThan(0);
      expect(meta.shortLabel.length).toBeGreaterThan(0);
      expect(meta.displayName.length).toBeGreaterThan(0);
      expect(meta.iconGlyph.length).toBeGreaterThan(0);
      expect(meta.description.length).toBeGreaterThan(0);
      expect(meta.color).toMatch(/^#[0-9a-fA-F]{6}$/);

      seenBadges.add(meta.badgeText);
      seenColors.add(meta.color.toLowerCase());
    }

    expect(seenBadges.size).toBe(4);
    expect(seenColors.size).toBe(4);
    expect(PLATFORM_DISPLAY_META.mijia.badgeText).toBe("米家");
    expect(PLATFORM_DISPLAY_META.tuya.badgeText).toBe("涂鸦");
    expect(PLATFORM_DISPLAY_META.midea.badgeText).toBe("美的");
    expect(PLATFORM_DISPLAY_META.deye.badgeText).toBe("德业");
  });
});

describe("platformBadgeInfo", () => {
  test("infers platform badge from explicit platform field or namespaced did prefix", () => {
    const tuyaByPrefix = platformBadgeInfo({ did: "tuya:bf1234567890" });
    expect(tuyaByPrefix.platform).toBe("tuya");
    expect(tuyaByPrefix.badgeText).toBe("涂鸦");
    expect(tuyaByPrefix.isExternal).toBe(true);

    const mideaSplit = platformBadgeInfo({ did: "midea:15482910293.s1" });
    expect(mideaSplit.platform).toBe("midea");
    expect(mideaSplit.badgeText).toBe("美的");
    expect(mideaSplit.isExternal).toBe(true);

    const deyeByPrefix = platformBadgeInfo({ did: "deye:inv_2712345678" });
    expect(deyeByPrefix.platform).toBe("deye");
    expect(deyeByPrefix.badgeText).toBe("德业");
    expect(deyeByPrefix.isExternal).toBe(true);

    const explicitDeye = platformBadgeInfo({ did: "raw-id-001", platform: "deye" });
    expect(explicitDeye.platform).toBe("deye");
    expect(explicitDeye.badgeText).toBe("德业");

    const mijiaPlain = platformBadgeInfo({ did: "1029384756" });
    expect(mijiaPlain.platform).toBe("mijia");
    expect(mijiaPlain.badgeText).toBe("米家");
    expect(mijiaPlain.isExternal).toBe(false);

    // Namespaced external DID wins even if stale platform says mijia
    const stalePlatform = platformBadgeInfo({ did: "tuya:dev99", platform: "mijia" });
    expect(stalePlatform.platform).toBe("tuya");
    expect(stalePlatform.badgeText).toBe("涂鸦");
  });
});

describe("formatPlatformSummaryLine & platformStatusTone", () => {
  test("formats connected, disconnected, configuring, and error platform statuses clearly", () => {
    const connected = makeStatus({
      id: "tuya",
      enabled: true,
      connected: true,
      state: "connected",
      deviceCount: 4,
      sceneCount: 0,
    });
    expect(formatPlatformSummaryLine(connected)).toBe("已连接 · 4 台设备");
    expect(platformStatusTone(connected)).toEqual({ label: "已连接", tone: "connected" });

    const connectedWithScenes = makeStatus({
      id: "mijia",
      enabled: true,
      connected: true,
      state: "connected",
      deviceCount: 12,
      sceneCount: 3,
    });
    // Scenes feature is currently disabled, so summary omits scene counts
    expect(formatPlatformSummaryLine(connectedWithScenes)).toBe("已连接 · 12 台设备");

    const disconnected = makeStatus({
      id: "midea",
      enabled: false,
      connected: false,
      state: "disconnected",
    });
    expect(formatPlatformSummaryLine(disconnected)).toBe("未接入");
    expect(platformStatusTone(disconnected)).toEqual({ label: "未接入", tone: "disconnected" });

    const configuring = makeStatus({
      id: "deye",
      state: "configuring",
      connected: false,
    });
    expect(formatPlatformSummaryLine(configuring)).toBe("正在连接…");
    expect(platformStatusTone(configuring)).toEqual({ label: "连接中", tone: "configuring" });

    const errored = makeStatus({
      id: "deye",
      state: "error",
      connected: false,
      lastError: "登录失败：token=supersecret999 无效",
    });
    const summary = formatPlatformSummaryLine(errored);
    expect(summary).toContain("连接异常：");
    expect(summary).toContain("token=[REDACTED]");
    expect(summary).not.toContain("supersecret999");
    expect(platformStatusTone(errored)).toEqual({ label: "异常", tone: "error" });
  });
});

describe("buildTuyaConfigPayload", () => {
  test("omits blank accessSecret and blank localKey so saved secrets are preserved", () => {
    const payload = buildTuyaConfigPayload({
      mode: "hybrid",
      userCode: "  az1701234567  ",
      region: "cn",
      accessId: "  ak_12345  ",
      accessSecret: "   ",
      uid: "  ay15890  ",
      endpoint: "   ",
      preferLocal: true,
      localDevices: [
        {
          id: " bf001 ",
          name: " 客厅插座 ",
          ip: " 192.168.1.50 ",
          port: 6668,
          version: "3.4",
          localKey: "   ",
          hasLocalKey: true,
        },
        {
          id: "bf002",
          name: "",
          ip: "192.168.1.51",
          port: 6668,
          version: "3.5",
          localKey: "  0123456789abcdef  ",
        },
        {
          // Incomplete row should be safely omitted
          id: "",
          name: "空设备",
          ip: "192.168.1.52",
          version: "3.3",
          localKey: "",
        },
      ],
    });

    expect(payload.enabled).toBe(true);
    expect(payload.mode).toBe("hybrid");
    expect(payload.userCode).toBe("az1701234567");
    expect(payload.accessId).toBe("ak_12345");
    expect(payload.uid).toBe("ay15890");
    expect("accessSecret" in payload).toBe(false);
    expect("endpoint" in payload).toBe(false);

    expect(payload.localDevices).toHaveLength(2);
    expect(payload.localDevices[0]).toEqual({
      id: "bf001",
      name: "客厅插座",
      ip: "192.168.1.50",
      port: 6668,
      version: "3.4",
    });
    expect("localKey" in payload.localDevices[0]!).toBe(false);

    expect(payload.localDevices[1]).toEqual({
      id: "bf002",
      name: "bf002",
      ip: "192.168.1.51",
      port: 6668,
      version: "3.5",
      localKey: "0123456789abcdef",
    });
  });

  test("includes trimmed accessSecret when user enters a new secret", () => {
    const payload = buildTuyaConfigPayload({
      mode: "openapi",
      userCode: "",
      region: "eu",
      accessId: "id_eu",
      accessSecret: "  new_secret_value  ",
      uid: "u_eu",
      preferLocal: false,
      localDevices: [],
    });

    expect(payload.region).toBe("eu");
    expect(payload.accessSecret).toBe("new_secret_value");
    expect(payload.preferLocal).toBe(false);
  });
});

describe("buildMideaConfigPayload", () => {
  test("omits blank password, token, and key while normalizing Midea appliance types and protocols", () => {
    const payload = buildMideaConfigPayload({
      mode: "hybrid",
      cloudBrand: "meiju",
      account: " 13800138000 ",
      password: "   ",
      hasPassword: true,
      useChinaServer: true,
      preferLocal: true,
      localDevices: [
        {
          id: " 15482910293 ",
          name: " 主卧空调 ",
          ip: " 192.168.1.80 ",
          port: 6444,
          type: 0xac,
          protocolVersion: 3,
          token: "  ",
          key: "",
          hasToken: true,
          hasKey: true,
        },
        {
          id: "15482910294",
          name: "书房除湿机",
          ip: "192.168.1.81",
          port: 99999, // invalid port -> falls back to 6444
          type: 0xa1,
          protocolVersion: 2,
          token: " aabbcc ",
          key: " ddeeff ",
        },
      ],
    });

    expect(payload.enabled).toBe(true);
    expect(payload.mode).toBe("hybrid");
    expect(payload.cloudBrand).toBe("meiju");
    expect(payload.account).toBe("13800138000");
    expect(payload.useChinaServer).toBe(true);
    expect("password" in payload).toBe(false);

    expect(payload.localDevices).toHaveLength(2);
    expect(payload.localDevices[0]).toEqual({
      id: "15482910293",
      name: "主卧空调",
      ip: "192.168.1.80",
      port: 6444,
      type: 0xac,
      protocolVersion: 3,
    });
    expect("token" in payload.localDevices[0]!).toBe(false);
    expect("key" in payload.localDevices[0]!).toBe(false);

    expect(payload.localDevices[1]).toEqual({
      id: "15482910294",
      name: "书房除湿机",
      ip: "192.168.1.81",
      port: 6444,
      type: 0xa1,
      protocolVersion: 2,
      token: "aabbcc",
      key: "ddeeff",
    });
  });

  test("preserves non-blank password verbatim", () => {
    const payload = buildMideaConfigPayload({
      mode: "cloud",
      cloudBrand: "msmarthome",
      account: "user@example.com",
      password: "MyPassword!23",
      useChinaServer: false,
      preferLocal: false,
      localDevices: [],
    });

    expect(payload.password).toBe("MyPassword!23");
    expect(payload.useChinaServer).toBe(false);
    expect(payload.cloudBrand).toBe("msmarthome");
  });
});

describe("buildDeyeConfigPayload", () => {
  test("omits blank secrets, defaults endpoint, and normalizes Solarman V5 inverters safely", () => {
    const payload = buildDeyeConfigPayload({
      mode: "hybrid",
      username: " 13900001111 ",
      password: "",
      authToken: "   ",
      endpoint: "   ",
      solarmanInverters: [
        {
          name: " 屋顶逆变器 ",
          ip: " 192.168.1.90 ",
          port: 8899,
          serial: "2712345678",
          slaveId: 1,
        },
        {
          // Invalid serial must be dropped cleanly
          name: "错误条目",
          ip: "192.168.1.91",
          serial: "not-a-number",
        },
        {
          // Out-of-range port & slaveId fallback cleanly
          name: "",
          ip: "192.168.1.92",
          port: -1,
          serial: 2799990001,
          slaveId: 300,
        },
      ],
    });

    expect(payload.enabled).toBe(true);
    expect(payload.mode).toBe("hybrid");
    expect(payload.username).toBe("13900001111");
    expect(payload.endpoint).toBe(DEFAULT_DEYE_ENDPOINT);
    expect("password" in payload).toBe(false);
    expect("authToken" in payload).toBe(false);

    expect(payload.solarmanInverters).toEqual([
      {
        id: "inv_2712345678",
        name: "屋顶逆变器",
        ip: "192.168.1.90",
        port: 8899,
        serial: 2712345678,
        slaveId: 1,
      },
      {
        id: "inv_2799990001",
        name: "德业逆变器 2799990001",
        ip: "192.168.1.92",
        port: 8899,
        serial: 2799990001,
        slaveId: 1,
      },
    ]);
  });
});

describe("parseLocalDevicesJson & local device normalization", () => {
  test("parses valid JSON arrays, wrapped objects, and rejects malformed JSON safely", () => {
    expect(parseLocalDevicesJson("")).toEqual({ ok: true, devices: [] });

    const invalid = parseLocalDevicesJson("{bad json");
    expect(invalid.ok).toBe(false);
    expect(invalid.devices).toEqual([]);

    const primitive = parseLocalDevicesJson("42");
    expect(primitive.ok).toBe(false);

    const tuyaParsed = parseLocalDevicesJson(
      JSON.stringify({
        localDevices: [
          { id: "devA", name: "台灯", ip: "192.168.1.10", version: "V3.4", localKey: "k123" },
          { id: "devA", name: "台灯更新", ip: "192.168.1.11", version: "3.5" },
          { id: "", ip: "192.168.1.12" },
          "not-an-object",
        ],
      }),
      "tuya",
    );
    expect(tuyaParsed.ok).toBe(true);
    expect(tuyaParsed.devices).toHaveLength(1);
    expect(tuyaParsed.devices[0]).toMatchObject({
      id: "devA",
      name: "台灯更新",
      ip: "192.168.1.11",
      port: 6668,
      version: "3.5",
    });

    const mideaParsed = parseLocalDevicesJson(
      JSON.stringify([
        { id: 88001, name: "客厅空调", ip: "192.168.1.20", typeCode: "0xAC", version: "V2" },
        { id: "88002", ip: "192.168.1.21", type: "除湿机", protocolVersion: 3 },
      ]),
      "midea",
    );
    expect(mideaParsed.ok).toBe(true);
    expect(mideaParsed.devices).toHaveLength(2);
    expect(mideaParsed.devices[0]).toMatchObject({
      id: "88001",
      type: 0xac,
      protocolVersion: 2,
      port: 6444,
    });
    expect(mideaParsed.devices[1]).toMatchObject({
      id: "88002",
      name: "美的设备 88002",
      type: 0xa1,
      protocolVersion: 3,
    });

    const deyeParsed = parseLocalDevicesJson(
      JSON.stringify([{ ip: "192.168.1.99", loggerSerial: "2700112233", slave_id: 2 }]),
      "deye",
    );
    expect(deyeParsed.ok).toBe(true);
    expect(deyeParsed.devices).toEqual([
      {
        id: "inv_2700112233",
        name: "德业逆变器 2700112233",
        ip: "192.168.1.99",
        port: 8899,
        serial: 2700112233,
        slaveId: 2,
      },
    ]);
  });

  test("normalizers filter invalid entries and deduplicate cleanly", () => {
    expect(normalizeTuyaLocalDevices([null, 123, { id: "x" }, { ip: "1.2.3.4" }])).toEqual([]);
    expect(normalizeMideaLocalDevices([undefined, { id: "1" }, { ip: "1.2.3.4" }])).toEqual([]);
    expect(
      normalizeDeyeInverters([
        { ip: "10.0.0.1", serial: 0 },
        { ip: "10.0.0.2", serial: -5 },
        { ip: "", serial: 12345 },
      ]),
    ).toEqual([]);
  });
});

describe("LAN discovery merge helpers", () => {
  test("merges discovered Tuya & Midea LAN devices without mutating input or clobbering saved secrets", () => {
    const existingTuya = [
      {
        id: "bf_exist",
        name: "卧室智能排插",
        ip: "192.168.1.40",
        port: 6668,
        version: "3.3" as const,
        localKey: "savedLocalKey16",
        hasLocalKey: true,
      },
    ];
    const discoveredTuyaUpdate: UiDiscoveredLocalDevice = {
      platform: "tuya",
      id: "bf_exist",
      name: "Tuya Generic",
      ip: "192.168.1.45",
      port: 6668,
      protocolVersion: "3.4",
    };
    const mergedTuya = mergeDiscoveredTuyaDevice(existingTuya, discoveredTuyaUpdate);
    expect(existingTuya[0]!.ip).toBe("192.168.1.40"); // pure, non-mutating
    expect(mergedTuya).toHaveLength(1);
    expect(mergedTuya[0]).toMatchObject({
      id: "bf_exist",
      name: "卧室智能排插", // kept custom user name
      ip: "192.168.1.45", // updated IP
      version: "3.4", // updated version
      localKey: "savedLocalKey16", // preserved secret
      hasLocalKey: true,
    });

    const discoveredTuyaNew: UiDiscoveredLocalDevice = {
      platform: "tuya",
      id: "bf_new01",
      name: "走廊灯",
      ip: "192.168.1.46",
      port: 6668,
      protocolVersion: "3.5",
    };
    const withNewTuya = mergeDiscoveredTuyaDevice(mergedTuya, discoveredTuyaNew);
    expect(withNewTuya).toHaveLength(2);
    expect(withNewTuya[1]).toMatchObject({ id: "bf_new01", ip: "192.168.1.46", version: "3.5" });

    const existingMidea = [
      {
        id: "10086",
        name: "客厅立式空调",
        ip: "192.168.1.70",
        port: 6444,
        type: 0xac,
        protocolVersion: 3 as const,
        token: "tok_existing",
        key: "key_existing",
        hasToken: true,
        hasKey: true,
      },
    ];
    const discoveredMidea: UiDiscoveredLocalDevice = {
      platform: "midea",
      id: "10086",
      name: "Midea AC",
      ip: "192.168.1.72",
      port: 6444,
      protocolVersion: "3",
      typeCode: "0xAC",
    };
    const mergedMidea = mergeDiscoveredMideaDevice(existingMidea, discoveredMidea);
    expect(mergedMidea[0]).toMatchObject({
      id: "10086",
      name: "客厅立式空调",
      ip: "192.168.1.72",
      token: "tok_existing",
      key: "key_existing",
    });

    const mergedDeye = mergeDiscoveredDeyeInverter([], {
      platform: "deye",
      id: "2711223344",
      name: "车库逆变器",
      ip: "192.168.1.95",
      port: 8899,
      protocolVersion: "v5",
    });
    expect(mergedDeye).toHaveLength(1);
    expect(mergedDeye[0]).toMatchObject({
      id: "inv_2711223344",
      ip: "192.168.1.95",
      serial: 2711223344,
    });
  });
});

describe("Midea type codes, summary hydrators & error sanitization", () => {
  test("parses and formats Midea device type codes accurately", () => {
    expect(MIDEA_DEVICE_TYPES.some((t) => t.code === 0xac)).toBe(true);
    expect(parseMideaTypeCode("0xA1")).toBe(0xa1);
    expect(parseMideaTypeCode("fa")).toBe(0xfa);
    expect(parseMideaTypeCode(252)).toBe(0xfc);
    expect(parseMideaTypeCode("热水器")).toBe(0xe2);
    expect(parseMideaTypeCode("invalid")).toBe(0xac);
    expect(formatMideaTypeLabel(0xac)).toContain("空调");
    expect(formatMideaTypeLabel(0x99)).toBe("美的设备 (0x99)");
  });

  test("hydrates form states from redacted server configSummary without prefilling plaintext secrets", () => {
    const tuya = tuyaFormStateFromSummary({
      enabled: true,
      mode: "openapi",
      region: "us",
      accessId: "ak_us",
      hasAccessSecret: true,
      hasTokenSession: true,
      localDevices: [{ id: "d1", name: "灯", ip: "192.168.1.5", version: "3.4", hasLocalKey: true }],
    });
    expect(tuya.hasAccessSecret).toBe(true);
    expect(tuya.accessSecret).toBe("");
    expect(tuya.localDevices[0]?.hasLocalKey).toBe(true);
    expect(tuya.localDevices[0]?.localKey).toBeUndefined();

    const midea = mideaFormStateFromSummary({
      enabled: true,
      mode: "hybrid",
      cloudBrand: "meiju",
      account: "13800138000",
      hasPassword: true,
      useChinaServer: true,
    });
    expect(midea.hasPassword).toBe(true);
    expect(midea.password).toBe("");

    const deye = deyeFormStateFromSummary({
      enabled: true,
      mode: "solarman",
      hasPassword: true,
      hasAuthToken: true,
      solarmanInverters: [{ id: "inv_1", name: "逆变器", ip: "10.0.0.9", serial: 270001 }],
    });
    expect(deye.hasPassword).toBe(true);
    expect(deye.password).toBe("");
    expect(deye.endpoint).toBe(DEFAULT_DEYE_ENDPOINT);
    expect(deye.solarmanInverters).toHaveLength(1);
  });

  test("sanitizes secret query/key-value fragments from error messages", () => {
    const scrubbed = sanitizePlatformErrorMessage(
      new Error("HTTP 401: access_secret=abc12345&password=myPass99 failed"),
    );
    expect(scrubbed).not.toContain("abc12345");
    expect(scrubbed).not.toContain("myPass99");
    expect(scrubbed).toContain("access_secret=[REDACTED]");
    expect(scrubbed).toContain("password=[REDACTED]");
  });
});

describe("Browser-safety & DOM security invariants", () => {
  test("src/web/platformsPanel.ts has zero node:* imports, zero innerHTML usage, and bundles for browser target", async () => {
    const panelPath = path.resolve(import.meta.dir, "../src/web/platformsPanel.ts");
    const source = readFileSync(panelPath, "utf8");

    expect(source).not.toMatch(/from\s+["']node:/);
    expect(source).not.toMatch(/\.\s*innerHTML\s*=/);
    expect(source).not.toMatch(/insertAdjacentHTML\s*\(/);

    const buildResult = await Bun.build({
      entrypoints: [panelPath],
      target: "browser",
      minify: false,
    });
    expect(buildResult.success).toBe(true);
    expect(buildResult.outputs.length).toBeGreaterThan(0);
  });
});

// Lightweight DOM shim for verifying PlatformsPanelController lifecycle in headless Bun
class FakeElement {
  tagName: string;
  id = "";
  className = "";
  textContent = "";
  type = "";
  value = "";
  placeholder = "";
  min = "";
  max = "";
  disabled = false;
  hidden = false;
  checked = false;
  selected = false;
  spellcheck = false;
  autocomplete = "";
  dataset: Record<string, string> = {};
  attrs = new Map<string, string>();
  children: FakeElement[] = [];
  listeners = new Map<string, Array<() => void>>();
  classes = new Set<string>();
  styleProps = new Map<string, string>();

  classList = {
    toggle: (cls: string, force?: boolean): boolean => {
      const next = force !== undefined ? force : !this.classes.has(cls);
      if (next) this.classes.add(cls);
      else this.classes.delete(cls);
      return next;
    },
    add: (cls: string): void => {
      this.classes.add(cls);
    },
    remove: (cls: string): void => {
      this.classes.delete(cls);
    },
  };

  style = {
    setProperty: (k: string, v: string): void => {
      this.styleProps.set(k, v);
    },
  };

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }

  setAttribute(name: string, val: string): void {
    this.attrs.set(name, val);
  }

  appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    return child;
  }

  append(...nodes: FakeElement[]): void {
    this.children.push(...nodes);
  }

  replaceChildren(...nodes: FakeElement[]): void {
    this.children = [...nodes];
  }

  addEventListener(event: string, fn: () => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(fn);
    this.listeners.set(event, list);
  }

  click(): void {
    if (this.disabled) return;
    for (const fn of this.listeners.get("click") ?? []) {
      fn();
    }
  }

  contains(target: unknown): boolean {
    if (target === this) return true;
    return this.children.some((c) => c.contains(target));
  }

  findAll(predicate: (el: FakeElement) => boolean): FakeElement[] {
    const out: FakeElement[] = [];
    if (predicate(this)) out.push(this);
    for (const child of this.children) {
      out.push(...child.findAll(predicate));
    }
    return out;
  }
}

describe("PlatformsPanelController lifecycle", () => {
  test("refreshes platforms, drives Tuya QR poll to completion, and cleans up timers on dispose", async () => {
    const origDocument = (globalThis as Record<string, unknown>).document;
    const head = new FakeElement("head");
    const fakeDocument = {
      head,
      activeElement: null,
      createElement: (tag: string) => new FakeElement(tag),
      createElementNS: (_ns: string, tag: string) => new FakeElement(tag),
      getElementById: (id: string) => head.findAll((el) => el.id === id)[0] ?? null,
    };
    (globalThis as Record<string, unknown>).document = fakeDocument;

    try {
      const container = new FakeElement("div");
      const changedSnapshots: UiPlatformStatus[][] = [];
      const toasts: string[] = [];
      const postCalls: Array<{ url: string; body: unknown }> = [];
      let pollCount = 0;

      const initialPlatforms: UiPlatformStatus[] = [
        makeStatus({ id: "mijia", enabled: true, connected: true, state: "connected", deviceCount: 5 }),
        makeStatus({
          id: "tuya",
          enabled: false,
          connected: false,
          state: "disconnected",
          configSummary: { mode: "sharing", userCode: "az1701234567" },
        }),
        makeStatus({ id: "midea", enabled: false, connected: false, state: "disconnected" }),
        makeStatus({ id: "deye", enabled: false, connected: false, state: "disconnected" }),
      ];

      const connectedTuyaPlatforms: UiPlatformStatus[] = initialPlatforms.map((p) =>
        p.id === "tuya"
          ? makeStatus({
              id: "tuya",
              enabled: true,
              connected: true,
              state: "connected",
              deviceCount: 3,
              configSummary: { mode: "sharing", userCode: "az1701234567", hasTokenSession: true },
            })
          : p,
      );

      const controller = new PlatformsPanelController({
        container: container as unknown as HTMLElement,
        qrPollIntervalMs: 500,
        onPlatformsChanged: (list) => changedSnapshots.push(list),
        onToast: (msg) => toasts.push(msg),
        apiGet: async <T>(url: string): Promise<T> => {
          expect(url).toBe("/api/platforms");
          return { ok: true, platforms: initialPlatforms } as T;
        },
        apiPost: async <T>(url: string, body?: unknown): Promise<T> => {
          postCalls.push({ url, body });
          if (url === "/api/platforms/tuya/qr/begin") {
            return {
              ok: true,
              session: {
                platform: "tuya",
                sessionId: "sess-1",
                qrContent: "tuyaSmart--qrLogin?token=tok123",
                expiresAt: Date.now() + 60_000,
                hint: "请使用涂鸦智能 App 扫码",
              },
            } as T;
          }
          if (url === "/api/platforms/tuya/qr/poll") {
            pollCount += 1;
            return {
              ok: true,
              result: {
                platform: "tuya",
                status: "success",
                message: "涂鸦智能扫码授权成功",
              },
              platforms: connectedTuyaPlatforms,
            } as T;
          }
          throw new Error(`Unexpected POST ${url}`);
        },
      });

      const refreshed = await controller.refresh();
      expect(refreshed).toHaveLength(4);
      expect(changedSnapshots.length).toBe(1);

      // Click "获取授权二维码" inside the expanded Tuya card
      const qrBtn = container.findAll(
        (el) => el.tagName === "BUTTON" && el.textContent === "获取授权二维码",
      )[0];
      expect(qrBtn).toBeDefined();
      qrBtn!.click();

      // Wait for qr/begin + first poll (qrPollIntervalMs = 500ms)
      await new Promise((resolve) => setTimeout(resolve, 650));

      expect(postCalls.some((c) => c.url === "/api/platforms/tuya/qr/begin")).toBe(true);
      expect(pollCount).toBe(1);
      expect(controller.getPlatforms().find((p) => p.id === "tuya")?.connected).toBe(true);
      expect(toasts.some((t) => t.includes("扫码授权成功"))).toBe(true);

      // Verify dispose stops cleanly without throwing
      controller.dispose();
    } finally {
      (globalThis as Record<string, unknown>).document = origDocument;
    }
  });

  test("PlatformsPanelController supports manual confirm button and stays clean across pending QR polls", async () => {
    const origDocument = (globalThis as Record<string, unknown>).document;
    const head = new FakeElement("head");
    const fakeDocument = {
      head,
      activeElement: null,
      createElement: (tag: string) => new FakeElement(tag),
      createElementNS: (_ns: string, tag: string) => new FakeElement(tag),
      getElementById: (id: string) => head.findAll((el) => el.id === id)[0] ?? null,
    };
    (globalThis as Record<string, unknown>).document = fakeDocument;

    try {
      const container = new FakeElement("div");
      let pollCount = 0;

      const initialPlatforms: UiPlatformStatus[] = [
        makeStatus({ id: "mijia", enabled: true, connected: true, state: "connected" }),
        makeStatus({
          id: "tuya",
          enabled: true,
          connected: false,
          state: "configuring",
          configSummary: { mode: "sharing", userCode: "USER_PENDING" },
        }),
        makeStatus({ id: "midea", enabled: false, connected: false, state: "disconnected" }),
        makeStatus({ id: "deye", enabled: false, connected: false, state: "disconnected" }),
      ];

      const controller = new PlatformsPanelController({
        container: container as unknown as HTMLElement,
        qrPollIntervalMs: 5000,
        apiGet: async <T>() => ({ ok: true, platforms: initialPlatforms }) as T,
        apiPost: async <T>(url: string) => {
          if (url === "/api/platforms/tuya/qr/begin") {
            return {
              ok: true,
              session: {
                platform: "tuya",
                sessionId: "sess-pending-1",
                qrContent: "tuyaSmart--qrLogin?token=tok_wait",
                expiresAt: Date.now() + 180_000,
                hint: "请扫码确认",
              },
            } as T;
          }
          if (url === "/api/platforms/tuya/qr/poll") {
            pollCount += 1;
            return {
              ok: true,
              result: {
                platform: "tuya",
                status: "pending",
                message: "等待涂鸦智能 / Smart Life App 扫码并点击确认…",
              },
            } as T;
          }
          throw new Error(`Unexpected POST ${url}`);
        },
      });

      await controller.refresh();
      const qrBtn = container.findAll(
        (el) => el.tagName === "BUTTON" && el.textContent === "获取授权二维码",
      )[0];
      qrBtn!.click();
      await new Promise((resolve) => setTimeout(resolve, 30));

      const confirmBtn = container.findAll(
        (el) => el.tagName === "BUTTON" && el.textContent === "我已扫码，立即确认",
      )[0];
      expect(confirmBtn).toBeDefined();
      confirmBtn!.click();
      await new Promise((resolve) => setTimeout(resolve, 30));

      expect(pollCount).toBe(1);
      const errLines = container.findAll((el) => el.className === "pf-qr-status-err");
      expect(errLines).toHaveLength(0);

      controller.dispose();
    } finally {
      (globalThis as Record<string, unknown>).document = origDocument;
    }
  });
});
