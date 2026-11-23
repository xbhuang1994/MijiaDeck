// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * Comprehensive unit tests for `src/mijia/` SDK, `specZh`, `cache` v4,
 * `iconStore`, and corrupt `auth.json` quarantine in `MijiaService`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";

import { setPackagedOverride } from "../src/core/appMeta.ts";
import * as deviceCache from "../src/core/cache.ts";
import type { FetchLike } from "../src/core/httpTimeout.ts";
import * as iconStore from "../src/core/iconStore.ts";
import { resetMigrationState, setDataPathOverrides } from "../src/core/jsonStore.ts";
import { createDeviceInfo } from "../src/core/models.ts";
import { MijiaService } from "../src/core/service.ts";
import * as specZh from "../src/core/specZh.ts";
import {
  DeviceActionError,
  DeviceGetError,
  DeviceNotFoundError,
  DeviceSetError,
  GetDeviceInfoError,
  LoginError,
  MijiaApiClient,
  MijiaDevice,
  decrypt,
  flattenMiotSpec,
  genNonce,
  generateEncParams,
  generateEncSignature,
  generateSignature,
  getDeviceInfo,
  getSignedNonce,
  rc4Crypt,
  type FlattenedSpec,
  type MijiaDeviceApi,
} from "../src/mijia/index.ts";

const tempDirs: string[] = [];
const origUserProfile = process.env.USERPROFILE;
const origHome = process.env.HOME;

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function restoreEnv(): void {
  if (origUserProfile === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = origUserProfile;
  }
  if (origHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = origHome;
  }
}

beforeEach(() => {
  const dataRoot = makeTempDir("mijiadeck-sdk-data-");
  setPackagedOverride(null);
  resetMigrationState();
  setDataPathOverrides({
    dataDir: () => dataRoot,
    dataFile: (filename) => path.join(dataRoot, filename),
  });
});

afterEach(() => {
  setDataPathOverrides(null);
  setPackagedOverride(null);
  resetMigrationState();
  restoreEnv();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("mijia/crypto", () => {
  test("genNonce returns 12-byte Base64 nonce with big-endian epoch minutes", () => {
    const beforeMin = Math.floor(Date.now() / 60_000) >>> 0;
    const n1 = genNonce();
    const n2 = genNonce();
    const afterMin = Math.floor(Date.now() / 60_000) >>> 0;

    const b1 = Buffer.from(n1, "base64");
    const b2 = Buffer.from(n2, "base64");
    expect(b1.length).toBe(12);
    expect(b2.length).toBe(12);
    expect(n1).not.toBe(n2);

    const mins = b1.readUInt32BE(8);
    expect(mins).toBeGreaterThanOrEqual(beforeMin);
    expect(mins).toBeLessThanOrEqual(afterMin);
  });

  test("getSignedNonce matches SHA-256(Base64Decode(ssecurity) || Base64Decode(nonce))", () => {
    const ssecurity = Buffer.from("0123456789abcdef", "utf8").toString("base64");
    const nonce = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 0, 1, 2, 3]).toString("base64");

    const expected = createHash("sha256")
      .update(Buffer.concat([Buffer.from(ssecurity, "base64"), Buffer.from(nonce, "base64")]))
      .digest("base64");

    const actual = getSignedNonce(ssecurity, nonce);
    expect(actual).toBe(expected);
    expect(Buffer.from(actual, "base64").length).toBe(32);
  });

  test("rc4Crypt performs RC4-drop1024 round-trip and rejects empty keys", () => {
    const key = Buffer.from("secret-rc4-key-bytes", "utf8");
    const plain = Buffer.from('{"did":"12345","name":"客厅灯","value":true}', "utf8");

    const cipher = rc4Crypt(key, plain);
    expect(Buffer.from(cipher).equals(plain)).toBe(false);

    const recovered = rc4Crypt(key, cipher);
    expect(Buffer.from(recovered).toString("utf8")).toBe(plain.toString("utf8"));

    // Verify drop1024 differs from standard RC4 (drop=0).
    const cipherNoDrop = rc4Crypt(key, plain, 0);
    expect(Buffer.from(cipherNoDrop).equals(cipher)).toBe(false);
    expect(Buffer.from(rc4Crypt(key, cipherNoDrop, 0)).equals(plain)).toBe(true);

    // Empty payload round-trips cleanly.
    expect(rc4Crypt(key, new Uint8Array(0)).length).toBe(0);

    // Empty key must throw RangeError.
    expect(() => rc4Crypt(new Uint8Array(0), plain)).toThrow(RangeError);
  });

  test("generateEncParams and decrypt round-trip payloads and verify signatures", () => {
    const ssecurity = Buffer.from("mijia-test-ssecurity-key", "utf8").toString("base64");
    const nonce = genNonce();
    const signedNonce = getSignedNonce(ssecurity, nonce);
    const payloadStr = JSON.stringify({ params: [{ did: "123", siid: 2, piid: 1 }], label: "主卧开关" });

    const enc = generateEncParams(
      "/app/miotspec/prop/get",
      "POST",
      signedNonce,
      nonce,
      { data: payloadStr },
      ssecurity,
    );

    expect(enc["ssecurity"]).toBe(ssecurity);
    expect(enc["_nonce"]).toBe(nonce);
    expect(typeof enc["data"]).toBe("string");
    expect(typeof enc["rc4_hash__"]).toBe("string");
    expect(typeof enc["signature"]).toBe("string");

    // Decrypt encrypted data and rc4_hash__ using decrypt().
    expect(decrypt(ssecurity, nonce, enc["data"]!)).toBe(payloadStr);
    const expectedRc4Hash = generateEncSignature("/miotspec/prop/get", "POST", signedNonce, {
      data: payloadStr,
    });
    expect(decrypt(ssecurity, nonce, enc["rc4_hash__"]!)).toBe(expectedRc4Hash);

    // Verify outer signature matches encrypted params without signature/ssecurity/_nonce.
    const expectedOuterSig = generateEncSignature(
      "https://api.io.mi.com/app/miotspec/prop/get",
      "post",
      signedNonce,
      { data: enc["data"]!, rc4_hash__: enc["rc4_hash__"]! },
    );
    expect(enc["signature"]).toBe(expectedOuterSig);

    // Verify generateSignature normalizes /app/ prefix as well.
    expect(generateSignature("/app/v2/test", signedNonce, nonce, { data: "{}" })).toBe(
      generateSignature("/v2/test", signedNonce, nonce, { data: "{}" }),
    );
  });

  test("decrypt transparently decompresses GZIP-compressed MIoT payloads", () => {
    const ssecurity = Buffer.from("mijia-gzip-test-key", "utf8").toString("base64");
    const nonce = genNonce();
    const signedNonce = getSignedNonce(ssecurity, nonce);
    const key = Buffer.from(signedNonce, "base64");
    const expectedJson = JSON.stringify({ code: 0, result: { homelist: [{ id: "1", name: "客厅" }] } });
    const gz = gzipSync(Buffer.from(expectedJson, "utf8"));
    const encryptedB64 = Buffer.from(rc4Crypt(key, gz)).toString("base64");

    expect(decrypt(ssecurity, nonce, encryptedB64)).toBe(expectedJson);
  });
});

describe("mijia/spec", () => {
  const rawMiotSpec: Record<string, unknown> = {
    type: "urn:miot-spec-v2:device:switch:0000A003:xiaomi-w3:1",
    description: "Three-channel Switch",
    comment: "三键开关",
    model: "xiaomi.switch.w3",
    services: [
      {
        iid: 1,
        type: "urn:miot-spec-v2:service:device-information:00007801:xiaomi-w3:1",
        properties: [
          {
            iid: 1,
            type: "urn:miot-spec-v2:property:manufacturer:00000001:xiaomi-w3:1",
            description: "Device Manufacturer",
            format: "string",
            access: ["read"],
          },
        ],
      },
      {
        iid: 2,
        type: "urn:miot-spec-v2:service:switch:0000780C:xiaomi-w3:1",
        properties: [
          {
            iid: 1,
            type: "urn:miot-spec-v2:property:on:00000006:xiaomi-w3:1",
            description: "Switch Status",
            comment: "左键开关",
            format: "bool",
            access: ["read", "write", "notify"],
          },
          {
            iid: 2,
            type: "urn:miot-spec-v2:property:mode:00000008:xiaomi-w3:1",
            description: "Mode",
            format: "uint8",
            access: ["read", "write"],
            "value-list": [
              { value: 0, description: "Wired", comment: "有线开关" },
              { value: 1, description: "Wireless", descriptionTranslate: "无线开关" },
            ],
          },
        ],
        actions: [
          {
            iid: 1,
            type: "urn:miot-spec-v2:action:toggle:00002811:xiaomi-w3:1",
            description: "Toggle",
            comment: "切换",
          },
        ],
      },
      {
        iid: 3,
        type: "urn:miot-spec-v2:service:switch:0000780C:xiaomi-w3:1",
        properties: [
          {
            iid: 1,
            type: "urn:miot-spec-v2:property:on:00000006:xiaomi-w3:1",
            description: "Switch Status",
            format: "bool",
            access: ["read", "write"],
          },
          {
            iid: 2,
            type: "urn:miot-spec-v2:property:brightness:0000000D:xiaomi-w3:1",
            description: "Brightness",
            format: "int32",
            access: ["read", "write"],
            unit: "percentage",
            "value-range": [1, 100, 1],
          },
        ],
        actions: [
          {
            iid: 1,
            type: "urn:miot-spec-v2:action:toggle:00002811:xiaomi-w3:1",
            description: "Toggle",
          },
        ],
      },
    ],
  };

  test("flattenMiotSpec skips device-information, deduplicates repeated names with -<siid>, and preserves metadata", () => {
    const flattened = flattenMiotSpec(rawMiotSpec);

    expect(flattened.name).toBe("三键开关");
    expect(flattened.model).toBe("xiaomi.switch.w3");

    const propNames = flattened.properties.map((p) => p.name);
    expect(propNames).toEqual(["on-2", "mode", "on-3", "brightness"]);
    expect(propNames).not.toContain("manufacturer");

    const on2 = flattened.properties[0]!;
    expect(on2.description).toBe("Switch Status / 左键开关");
    expect(on2.type).toBe("bool");
    expect(on2.rw).toBe("rw");
    expect(on2.method).toEqual({ siid: 2, piid: 1 });

    const mode = flattened.properties[1]!;
    expect(mode.type).toBe("uint");
    expect(mode.rw).toBe("rw");
    expect(mode["value-list"]).toEqual([
      { value: 0, description: "Wired", desc_zh_cn: "有线开关" },
      { value: 1, description: "Wireless", desc_zh_cn: "无线开关" },
    ]);
    expect(mode.method).toEqual({ siid: 2, piid: 2 });

    const brightness = flattened.properties[3]!;
    expect(brightness.type).toBe("int");
    expect(brightness.unit).toBe("percentage");
    expect(brightness.range).toEqual([1, 100, 1]);
    expect(brightness.method).toEqual({ siid: 3, piid: 2 });

    expect(flattened.actions.map((a) => a.name)).toEqual(["toggle-2", "toggle-3"]);
    expect(flattened.actions[0]!.method).toEqual({ siid: 2, aiid: 1 });
    expect(flattened.actions[1]!.method).toEqual({ siid: 3, aiid: 1 });
  });

  test("flattenMiotSpec throws GetDeviceInfoError on missing services array", () => {
    expect(() => flattenMiotSpec({ name: "broken" }, "urn:bad")).toThrow(GetDeviceInfoError);
  });

  test("getDeviceInfo supports atomic cache hit, remote fetch + cache write, and invalid spec errors", async () => {
    const cacheDir = makeTempDir("mijiadeck-spec-cache-");
    const specType = "urn:miot-spec-v2:device:switch:0000A003:xiaomi-w3:1";
    const expectedCacheFile = path.join(cacheDir, `${specType.replaceAll(":", "_")}.json`);

    // 1. Remote fetch flattens spec and writes cache atomically (no leftover .tmp files).
    let fetchCalls = 0;
    const remoteFetcher: FetchLike = async (input) => {
      fetchCalls += 1;
      expect(String(input)).toBe(
        `https://miot-spec.org/miot-spec-v2/instance?type=${encodeURIComponent(specType)}`,
      );
      return new Response(JSON.stringify(rawMiotSpec), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const fetched = await getDeviceInfo(specType, { cachePath: cacheDir, fetcher: remoteFetcher });
    expect(fetchCalls).toBe(1);
    expect(fetched.properties.map((p) => p.name)).toEqual(["on-2", "mode", "on-3", "brightness"]);
    expect(existsSync(expectedCacheFile)).toBe(true);
    expect(readdirSync(cacheDir).filter((f) => f.endsWith(".tmp"))).toEqual([]);

    // 2. Subsequent call hits disk cache without invoking fetcher.
    const neverFetcher: FetchLike = async () => {
      throw new Error("should not fetch when cache hits");
    };
    const cached = await getDeviceInfo(specType, { cachePath: cacheDir, fetcher: neverFetcher });
    expect(cached).toEqual(fetched);

    // 3. Invalid remote spec structure throws GetDeviceInfoError.
    const invalidFetcher: FetchLike = async () =>
      new Response(JSON.stringify({ hello: "world" }), { status: 200 });
    await expect(
      getDeviceInfo("urn:miot-spec-v2:device:bad:1", { cachePath: cacheDir, fetcher: invalidFetcher }),
    ).rejects.toThrow(GetDeviceInfoError);

    // 4. HTTP error status and empty specType also throw GetDeviceInfoError.
    const errStatusFetcher: FetchLike = async () => new Response("Not Found", { status: 404 });
    await expect(
      getDeviceInfo("urn:miot-spec-v2:device:missing:1", {
        cachePath: cacheDir,
        fetcher: errStatusFetcher,
      }),
    ).rejects.toThrow(GetDeviceInfoError);
    await expect(getDeviceInfo("   ", { cachePath: cacheDir })).rejects.toThrow(GetDeviceInfoError);

    // 5. Legacy cached flattened spec (without service metadata) upgrades online and falls back offline.
    const legacyType = "urn:miot-spec-v2:device:switch:0000A003:xiaomi-legacy:1";
    const legacyFile = path.join(cacheDir, `${legacyType.replaceAll(":", "_")}.json`);
    writeFileSync(
      legacyFile,
      JSON.stringify({
        name: "Legacy Switch",
        properties: [
          { name: "on", description: "Switch", type: "bool", rw: "rw", method: { siid: 2, piid: 1 } },
        ],
        actions: [],
      }),
      "utf8",
    );
    const offlineFallback = await getDeviceInfo(legacyType, {
      cachePath: cacheDir,
      fetcher: async () => {
        throw new Error("network down");
      },
    });
    expect(offlineFallback.name).toBe("Legacy Switch");

    const upgraded = await getDeviceInfo(legacyType, {
      cachePath: cacheDir,
      fetcher: async () =>
        new Response(JSON.stringify(rawMiotSpec), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    });
    expect(upgraded.properties[0]!.service).toBe("switch");
  });
});

describe("mijia/device", () => {
  const lampSpec: FlattenedSpec = {
    name: "Desk Lamp",
    properties: [
      {
        name: "color-temperature",
        description: "Color Temperature",
        type: "uint",
        rw: "rw",
        range: [2700, 6500, 1],
        "value-list": null,
        method: { siid: 2, piid: 3 },
      },
      {
        name: "status",
        description: "Status",
        type: "uint",
        rw: "r",
        range: null,
        "value-list": null,
        method: { siid: 2, piid: 4 },
      },
      {
        name: "reset-flag",
        description: "Reset",
        type: "bool",
        rw: "w",
        range: null,
        "value-list": null,
        method: { siid: 2, piid: 5 },
      },
    ],
    actions: [
      {
        name: "bright-increase",
        description: "Increase Brightness",
        method: { siid: 2, aiid: 2 },
      },
    ],
  };

  test("MijiaDevice.fromSpec shares identical DevProp instance for hyphen/underscore aliases and executes get/set/runAction", async () => {
    const getQueries: unknown[] = [];
    const setQueries: unknown[] = [];
    const actionPayloads: unknown[] = [];

    const mockApi: MijiaDeviceApi = {
      authDataPath: "unused/auth.json",
      getDevicesList: async () => [],
      getDevicesProp: async (q) => {
        getQueries.push(q);
        return { ...(q as Record<string, unknown>), code: 0, value: 4200 };
      },
      setDevicesProp: async (q) => {
        setQueries.push(q);
        return { ...(q as Record<string, unknown>), code: 0 };
      },
      runAction: async (payload) => {
        actionPayloads.push(payload);
        return { code: 0, out: [] };
      },
    };

    const dev = MijiaDevice.fromSpec(mockApi, {
      did: "lamp-1",
      model: "yeelink.light.lamp4",
      name: "书桌灯",
      spec: lampSpec,
      sleepTime: 0,
    });

    // Hyphen and underscore aliases MUST point to the exact same DevProp instance.
    expect(dev.propList["color-temperature"]).toBeDefined();
    expect(dev.propList["color_temperature"]).toBe(dev.propList["color-temperature"]);

    // get() works through both alias forms.
    expect(await dev.get("color-temperature")).toBe(4200);
    expect(await dev.get("color_temperature")).toBe(4200);
    expect(getQueries).toEqual([
      { did: "lamp-1", siid: 2, piid: 3 },
      { did: "lamp-1", siid: 2, piid: 3 },
    ]);

    // set() writes via parent did & method.
    await dev.set("color_temperature", 5000);
    expect(setQueries).toEqual([{ did: "lamp-1", siid: 2, piid: 3, value: 5000 }]);

    // runAction() supports hyphen & underscore names and `_in` / array params.
    await dev.runAction("bright-increase");
    await dev.runAction("bright_increase", [10]);
    await dev.runAction("bright-increase", { _in: ["step", 1] });
    expect(actionPayloads).toEqual([
      { did: "lamp-1", siid: 2, aiid: 2, in: [] },
      { did: "lamp-1", siid: 2, aiid: 2, in: [10] },
      { did: "lamp-1", siid: 2, aiid: 2, in: ["step", 1] },
    ]);

    // Permission / missing checks throw exact SDK error classes.
    await expect(dev.get("missing-prop")).rejects.toThrow(DeviceGetError);
    await expect(dev.get("reset-flag")).rejects.toThrow(DeviceGetError);
    await expect(dev.set("status", 1)).rejects.toThrow(DeviceSetError);
    await expect(dev.set("missing-prop", 1)).rejects.toThrow(DeviceSetError);
    await expect(dev.runAction("unknown-action")).rejects.toThrow(DeviceActionError);

    // MijiaDevice.create throws DeviceNotFoundError if not in owned list.
    await expect(MijiaDevice.create(mockApi, { did: "non-existent" })).rejects.toThrow(
      DeviceNotFoundError,
    );
  });
});

describe("MijiaApiClient, quarantine, icon redirect, specZh, cache v4 & iconStore", () => {
  test("MijiaService quarantines corrupt auth.json to auth.json.corrupt", () => {
    const fakeHome = makeTempDir("mijiadeck-home-");
    process.env.USERPROFILE = fakeHome;
    process.env.HOME = fakeHome;
    expect(path.resolve(homedir())).toBe(path.resolve(fakeHome));

    const authDir = path.join(fakeHome, ".config", "mijia-api");
    mkdirSync(authDir, { recursive: true });
    const authPath = path.join(authDir, "auth.json");
    const corruptPath = path.join(authDir, "auth.json.corrupt");
    writeFileSync(authPath, "{corrupt json", "utf8");

    // Direct MijiaApiClient throws SyntaxError on corrupt file.
    expect(() => new MijiaApiClient({ authDataPath: authPath })).toThrow(SyntaxError);

    // MijiaService catches the SyntaxError, quarantines auth.json -> auth.json.corrupt, and recovers cleanly.
    const service = new MijiaService();
    expect(existsSync(authPath)).toBe(false);
    expect(existsSync(corruptPath)).toBe(true);
    expect(readFileSync(corruptPath, "utf8")).toBe("{corrupt json");
    expect(service.loginStatus()).toBe(false);
  });

  test("MijiaApiClient.fetchIconRedirect sends manual-redirect encrypted POST and returns 302 Location", async () => {
    const authDir = makeTempDir("mijiadeck-client-");
    const authPath = path.join(authDir, "auth.json");
    const ssecurity = Buffer.from("icon-test-ssecurity", "utf8").toString("base64");
    writeFileSync(
      authPath,
      JSON.stringify({
        userId: "10086",
        ssecurity,
        serviceToken: "tok-xyz",
        deviceId: "dev1234567890abc",
      }),
      "utf8",
    );

    const captured: Array<{ url: string; init?: RequestInit }> = [];
    const redirectUrl = "https://cdn.cnbj1.fds.api.mi-img.com/iotweb-product-center/lamp.png";
    const mockFetcher: FetchLike = async (input, init) => {
      captured.push({ url: String(input), init });
      return new Response(null, {
        status: 302,
        headers: { Location: redirectUrl },
      });
    };

    const client = new MijiaApiClient({ authDataPath: authPath, fetcher: mockFetcher });
    expect(client.available).toBe(true);

    const loc = await client.fetchIconRedirect("yeelink.light.lamp4");
    expect(loc).toBe(redirectUrl);
    expect(captured.length).toBe(1);
    expect(captured[0]!.url).toBe("https://api.mijia.tech/app/v2/productconfig/get_icon");
    expect(captured[0]!.init?.redirect).toBe("manual");

    // Verify request body decrypts to the expected model payload.
    const params = new URLSearchParams(String(captured[0]!.init?.body ?? ""));
    const nonce = params.get("_nonce")!;
    const decryptedData = JSON.parse(decrypt(ssecurity, nonce, params.get("data")!)) as Record<
      string,
      unknown
    >;
    expect(decryptedData).toEqual({ icon_name: "icon_real", model: "yeelink.light.lamp4" });

    // Non-302 returns null.
    const client200 = new MijiaApiClient({
      authDataPath: authPath,
      fetcher: async () => new Response("ok", { status: 200 }),
    });
    expect(await client200.fetchIconRedirect("yeelink.light.lamp4")).toBeNull();

    client.close();
    expect(client.available).toBe(false);
    expect(await client.fetchIconRedirect("yeelink.light.lamp4")).toBeNull();
  });

  test("specZh fallback tables distinguish exact suffix overrides from base-name fallback", () => {
    // Exact match: on-2 is "按键", distinct from base "on" ("开关").
    expect(specZh.lookupZh("on-2", specZh.PROPERTY_ZH)).toBe("按键");
    expect(specZh.lookupZh("on", specZh.PROPERTY_ZH)).toBe("开关");
    // Unlisted numeric suffix falls back to base name.
    expect(specZh.lookupZh("on-99", specZh.PROPERTY_ZH)).toBe("开关");
    expect(specZh.lookupZh("unknown-prop", specZh.PROPERTY_ZH)).toBeNull();

    // Description backfill rules.
    expect(specZh.propDescZh("temperature", "Temperature")).toBe("Temperature / 温度");
    expect(specZh.propDescZh("temperature", "")).toBe("温度");
    expect(specZh.propDescZh("temperature", "当前温度")).toBe("当前温度");
    expect(specZh.propDescZh("custom-xyz", "Custom")).toBe("Custom");
    expect(specZh.actionDescZh("toggle-3", "Toggle")).toBe("Toggle / 切换");
    expect(specZh.actionDescZh("play-text", "Play Text")).toBe("Play Text / 朗读文本");

    // In-place spec dict backfill.
    const info: specZh.SpecFallbackInfo = {
      properties: [
        { name: "relative-humidity", description: "Relative Humidity" },
        { name: "brightness", description: "亮度" },
      ],
      actions: [{ name: "reboot", description: "Reboot" }],
    };
    specZh.applyFallback(info);
    expect(info.properties![0]!.description).toBe("Relative Humidity / 湿度");
    expect(info.properties![1]!.description).toBe("亮度");
    expect(info.actions![0]!.description).toBe("Reboot / 重启");
  });

  test("cache v4 saves and loads devices, knownPower, and metrics while rejecting invalid versions", () => {
    const dev = createDeviceInfo({
      did: "dev-1",
      name: "客厅吸顶灯",
      model: "yeelink.light.ceiling1",
      home_name: "我的家",
      room_name: "客厅",
      online: true,
      spec_type: "urn:miot-spec-v2:device:light:1",
      switch_channels: [],
      light_features: ["brightness", "color-temperature"],
      metric_features: [],
      firmware: "2.1.0",
    });

    deviceCache.save([dev], { "dev-1": true, "dev-2": null }, { "dev-1": "26.5°C 55%", empty: "" });
    const loaded = deviceCache.load();
    expect(loaded).not.toBeNull();
    expect(loaded!.devices).toEqual([dev]);
    expect(loaded!.knownPower).toEqual({ "dev-1": true, "dev-2": null });
    expect(loaded!.metrics).toEqual({ "dev-1": "26.5°C 55%" });

    // Stale cache version (e.g., v3) is rejected cleanly as null.
    const staleDir = makeTempDir("mijiadeck-stale-cache-");
    setDataPathOverrides({
      dataDir: () => staleDir,
      dataFile: (filename) => path.join(staleDir, filename),
    });
    writeFileSync(
      path.join(staleDir, "devices_cache.json"),
      JSON.stringify({ version: deviceCache.CACHE_VERSION - 1, devices: [], known_power: {}, metrics: {} }),
      "utf8",
    );
    expect(deviceCache.load()).toBeNull();
  });

  test("iconStore sanitizes illegal filename characters and persists URL cache", () => {
    const cleanPath = iconStore.iconPath("xiaomi.wifispeaker.x08c");
    expect(path.basename(cleanPath)).toBe("xiaomi.wifispeaker.x08c.png");
    expect(path.dirname(cleanPath)).toBe(iconStore.iconsDir());

    const dirtyPath = iconStore.iconPath('a/b\\c:d*e?f"g<h>i|j');
    expect(path.basename(dirtyPath)).toBe("a_b_c_d_e_f_g_h_i_j.png");
    expect(path.dirname(dirtyPath)).toBe(iconStore.iconsDir());

    iconStore.saveUrls({
      "xiaomi.light.1": "https://cdn.example/light1.png",
      "xiaomi.empty": "",
    });
    expect(iconStore.loadUrls()).toEqual({
      "xiaomi.light.1": "https://cdn.example/light1.png",
    });
  });
});

describe("mijia/client QR login & STS token exchange", () => {
  test("two-step sid=mijia QR login fetches signed serviceLogin params, preserves STS callback URL, carries domain cookies, and persists auth.json", async () => {
    const authDir = makeTempDir("mijiadeck-qr-login-");
    const authPath = path.join(authDir, "auth.json");

    const requests: Array<{ url: string; headers: Headers; redirect?: RequestRedirect }> = [];
    const stsCallbackUrl =
      "https://sts.api.mijia.tech/mijia/sts?d=dev&ticket=t123&nonce=987654321&p_ts=1700000000";

    const mockFetcher: FetchLike = async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      requests.push({ url, headers, redirect: init?.redirect });

      if (url.startsWith("https://account.xiaomi.com/pass/serviceLogin")) {
        const location =
          "https://account.xiaomi.com/fe/service/login/password?" +
          new URLSearchParams({
            _sign: "SERVER_SIGNED_VALUE==",
            qs: "%3F_json%3Dtrue%26sid%3Dmijia",
            callback: "https://sts.api.mijia.tech/mijia/sts",
            sid: "mijia",
            serviceParam: '{"checkSafePhone":false}',
          }).toString();
        return new Response(`&&&START&&&${JSON.stringify({ code: 70016, location })}`, {
          status: 200,
        });
      }

      if (url.startsWith("https://account.xiaomi.com/longPolling/loginUrl")) {
        return new Response(
          `&&&START&&&${JSON.stringify({
            code: 0,
            loginUrl: "https://account.xiaomi.com/fe/service/login/qrcode?token=qr-abc",
            lp: "https://lp.open.account.xiaomi.com/lp?id=poll-123",
            qr: "https://account.xiaomi.com/qr/poll-123.png",
          })}`,
          { status: 200 },
        );
      }

      if (url === "https://lp.open.account.xiaomi.com/lp?id=poll-123") {
        const resHeaders = new Headers();
        resHeaders.append("Set-Cookie", "passToken=lp-pass-token; Domain=.account.xiaomi.com; Path=/");
        return new Response(
          `&&&START&&&${JSON.stringify({
            code: 0,
            userId: 123456789,
            cUserId: "encrypted-uid-1",
            ssecurity: "c3NlY3VyaXR5S2V5MTIzNA==",
            psecurity: "cHNlY3VyaXR5S2V5",
            nonce: 987654321,
            passToken: "body-pass-token",
            location: stsCallbackUrl,
          })}`,
          { status: 200, headers: resHeaders },
        );
      }

      if (url === stsCallbackUrl) {
        // Must NOT leak account.xiaomi.com cookies to sts.api.mijia.tech,
        // and must NOT mangle the sid=mijia STS URL with a forged clientSign.
        expect(headers.get("cookie") ?? "").not.toContain("passToken");
        const resHeaders = new Headers();
        resHeaders.set("Location", "/mijia/sts/finish?ok=1");
        resHeaders.append("Set-Cookie", "stsSession=hop1-sess; Domain=.api.mijia.tech; Path=/");
        resHeaders.append(
          "Set-Cookie",
          'serviceToken="valid-mijia-sts-token=="; Domain=.api.mijia.tech; Path=/',
        );
        return new Response(null, { status: 302, headers: resHeaders });
      }

      if (url === "https://sts.api.mijia.tech/mijia/sts/finish?ok=1") {
        // Redirect hop on the same domain MUST carry cookies set on hop 1.
        const cookieHdr = headers.get("cookie") ?? "";
        expect(cookieHdr).toContain("stsSession=hop1-sess");
        expect(cookieHdr).toContain("serviceToken=valid-mijia-sts-token==");

        // Clearing cookies (Max-Age=0, expired date, EXPIRED/deleted) must NOT overwrite valid serviceToken.
        const resHeaders = new Headers();
        resHeaders.append("Set-Cookie", "serviceToken=EXPIRED; Max-Age=0; Domain=.api.mijia.tech; Path=/");
        resHeaders.append(
          "Set-Cookie",
          "serviceToken=stale; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Domain=.api.mijia.tech; Path=/",
        );
        resHeaders.append("Set-Cookie", "userId=123456789; Domain=.api.mijia.tech; Path=/");
        return new Response("ok", { status: 200, headers: resHeaders });
      }

      throw new Error(`Unexpected URL: ${url}`);
    };

    const client = new MijiaApiClient({ authDataPath: authPath, fetcher: mockFetcher });
    const qrData = await client.getQrLoginData();
    expect(qrData.refreshed).toBeUndefined();
    expect(qrData.loginUrl).toBe("https://account.xiaomi.com/fe/service/login/qrcode?token=qr-abc");
    expect(qrData.lp).toBe("https://lp.open.account.xiaomi.com/lp?id=poll-123");

    // Verify Step 1 queried serviceLogin with sid=mijia and forwarded server-signed params.
    expect(requests[0]!.url).toBe(
      "https://account.xiaomi.com/pass/serviceLogin?_json=true&sid=mijia&_locale=zh_CN",
    );
    const qrUrl = new URL(requests[1]!.url);
    expect(qrUrl.origin + qrUrl.pathname).toBe("https://account.xiaomi.com/longPolling/loginUrl");
    expect(qrUrl.searchParams.get("_sign")).toBe("SERVER_SIGNED_VALUE==");
    expect(qrUrl.searchParams.get("sid")).toBe("mijia");
    expect(qrUrl.searchParams.get("callback")).toBe("https://sts.api.mijia.tech/mijia/sts");

    await client.completeQrLogin(qrData);
    expect(client.available).toBe(true);
    expect(client.authData["serviceToken"]).toBe("valid-mijia-sts-token==");
    expect(client.authData["ssecurity"]).toBe("c3NlY3VyaXR5S2V5MTIzNA==");
    expect(client.authData["psecurity"]).toBe("cHNlY3VyaXR5S2V5");
    expect(client.authData["passToken"]).toBe("body-pass-token");
    expect(client.authData["cUserId"]).toBe("encrypted-uid-1");
    expect(typeof client.authData["deviceId"]).toBe("string");
    expect(typeof client.authData["pass_o"]).toBe("string");
    expect(typeof client.authData["ua"]).toBe("string");
    expect(typeof client.authData["expireTime"]).toBe("number");

    // Auth file persisted cleanly on disk.
    const saved = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, unknown>;
    expect(saved["serviceToken"]).toBe("valid-mijia-sts-token==");
    expect(saved["userId"]).toBe(123456789);

    // Confirm STS URL was requested verbatim without forged clientSign.
    const stsUrls = requests.filter((r) => r.url.startsWith("https://sts.api.mijia.tech")).map((r) => r.url);
    expect(stsUrls).toEqual([stsCallbackUrl, "https://sts.api.mijia.tech/mijia/sts/finish?ok=1"]);
  });

  test("completeQrLogin falls back to clientSign only when untouched STS URL yields no serviceToken and throws LoginError if both fail", async () => {
    const authDir = makeTempDir("mijiadeck-qr-fallback-");
    const authPath = path.join(authDir, "auth.json");
    const legacyLocation = "https://sts.api.io.mi.com/sts?d=dev&ticket=legacy";
    const visited: string[] = [];

    const fallbackFetcher: FetchLike = async (input) => {
      const url = String(input);
      visited.push(url);
      if (url === "https://lp.open.account.xiaomi.com/lp?id=legacy") {
        return new Response(
          `&&&START&&&${JSON.stringify({
            code: 0,
            userId: "998877",
            cUserId: "c-998877",
            ssecurity: "bGVnYWN5U3NlY3VyaXR5",
            nonce: 424242,
            location: legacyLocation,
          })}`,
          { status: 200 },
        );
      }
      if (url === legacyLocation) {
        return new Response("missing sign", { status: 401 });
      }
      if (url.startsWith(`${legacyLocation}&clientSign=`)) {
        const resHeaders = new Headers();
        resHeaders.append("Set-Cookie", "yetAnotherServiceToken=legacy-token-ok; Path=/");
        return new Response("ok", { status: 200, headers: resHeaders });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const client = new MijiaApiClient({ authDataPath: authPath, fetcher: fallbackFetcher });
    await client.completeQrLogin({
      loginUrl: "https://example.invalid/qr",
      lp: "https://lp.open.account.xiaomi.com/lp?id=legacy",
    });
    expect(client.authData["serviceToken"]).toBe("legacy-token-ok");
    expect(visited.length).toBe(3);
    expect(visited[1]).toBe(legacyLocation);
    expect(visited[2]).toContain("clientSign=");

    // When neither primary nor fallback returns a serviceToken, throw LoginError.
    const failingClient = new MijiaApiClient({
      authDataPath: path.join(authDir, "fail-auth.json"),
      fetcher: async (input) => {
        const url = String(input);
        if (url.includes("/lp?")) {
          return new Response(
            `&&&START&&&${JSON.stringify({
              code: 0,
              userId: "1",
              ssecurity: "YWJj",
              nonce: 1,
              location: "https://sts.api.mijia.tech/mijia/sts?ticket=bad",
            })}`,
            { status: 200 },
          );
        }
        return new Response("ok", { status: 200 });
      },
    });
    await expect(
      failingClient.completeQrLogin({
        loginUrl: "https://example.invalid/qr",
        lp: "https://lp.open.account.xiaomi.com/lp?id=fail",
      }),
    ).rejects.toThrow(LoginError);
  });

  test("getQrLoginData silently refreshes credentials when serviceLogin returns code 0", async () => {
    const authDir = makeTempDir("mijiadeck-qr-refresh-");
    const authPath = path.join(authDir, "auth.json");
    writeFileSync(
      authPath,
      JSON.stringify({
        userId: "556677",
        cUserId: "c-556677",
        passToken: "valid-pass-token",
        ssecurity: "b2xkU3NlYw==",
        serviceToken: "expired-token",
        expireTime: Date.now() - 10_000,
      }),
      "utf8",
    );

    const refreshFetcher: FetchLike = async (input) => {
      const url = String(input);
      if (url.startsWith("https://account.xiaomi.com/pass/serviceLogin")) {
        return new Response(
          `&&&START&&&${JSON.stringify({
            code: 0,
            userId: "556677",
            cUserId: "c-556677",
            ssecurity: "bmV3U3NlYw==",
            nonce: 777,
            location: "https://sts.api.mijia.tech/mijia/sts?ticket=silent",
          })}`,
          { status: 200 },
        );
      }
      if (url === "https://sts.api.mijia.tech/mijia/sts?ticket=silent") {
        const headers = new Headers();
        headers.append("Set-Cookie", "serviceToken=fresh-silent-token; Domain=.api.mijia.tech; Path=/");
        return new Response("ok", { status: 200, headers });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const client = new MijiaApiClient({ authDataPath: authPath, fetcher: refreshFetcher });
    expect(client.available).toBe(false);

    const result = await client.getQrLoginData();
    expect(result.refreshed).toBe(true);
    expect(client.available).toBe(true);
    expect(client.authData["serviceToken"]).toBe("fresh-silent-token");
    expect(client.authData["ssecurity"]).toBe("bmV3U3NlYw==");
  });
});
