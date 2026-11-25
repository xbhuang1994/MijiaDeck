// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 涂鸦智能平台协议、加密、映射与提供者综合测试

import { describe, expect, test } from "bun:test";
import { createHmac, randomBytes } from "node:crypto";
import { createServer, type AddressInfo, type Server } from "node:net";

import {
  defaultTuyaConfig,
  type TuyaPlatformConfig,
} from "../src/platforms/configStore.ts";
import {
  TUYA_CLIENT_ID,
  TUYA_LOCAL_CMD,
  TUYA_PREFIX_55AA,
  TUYA_PREFIX_6699,
  TUYA_SCHEMA,
  UDP_BROADCAST_KEY,
  canonicalizeOpenApiUrl,
  crc32,
  decryptUdpBroadcast,
  deriveTuyaSessionKey,
  formatTuyaDeviceMetrics,
  kelvinToTuyaTemp,
  mapTuyaDeviceToCards,
  packTuyaLocalMessage,
  percentToTuyaBrightness,
  rgbIntToTuyaColourV1Hex,
  rgbIntToTuyaHsvV2,
  tryExtractTuyaFrame,
  tuyaBrightnessToPercent,
  tuyaCategoryToKind,
  tuyaColourV1HexToRgbInt,
  tuyaHsvV2ToRgbInt,
  tuyaOpenApiSign,
  tuyaSharingAesGcmDecrypt,
  tuyaSharingAesGcmEncrypt,
  tuyaSharingHashKey,
  tuyaSharingRestfulSign,
  tuyaSharingSecret,
  tuyaTempToKelvin,
  unpackTuyaLocalMessage,
  TuyaLocalClient,
  TuyaOpenApiClient,
  TuyaPlatformProvider,
  TuyaSharingClient,
  type TuyaConfigStoreAdapter,
  type TuyaDeviceRecord,
} from "../src/platforms/tuya/index.ts";

function makeMemoryConfigStore(initial?: Partial<TuyaPlatformConfig>): {
  store: TuyaConfigStoreAdapter;
  get(): TuyaPlatformConfig;
} {
  let state: TuyaPlatformConfig = {
    ...defaultTuyaConfig(),
    ...initial,
    localDevices: initial?.localDevices ? initial.localDevices.map((d) => ({ ...d })) : [],
  };
  return {
    store: {
      load: () => ({
        ...state,
        tokenSession: state.tokenSession ? { ...state.tokenSession } : null,
        localDevices: state.localDevices.map((d) => ({ ...d })),
      }),
      save: (next: TuyaPlatformConfig) => {
        state = {
          ...next,
          tokenSession: next.tokenSession ? { ...next.tokenSession } : null,
          localDevices: next.localDevices.map((d) => ({ ...d })),
        };
        return {
          ...state,
          tokenSession: state.tokenSession ? { ...state.tokenSession } : null,
          localDevices: state.localDevices.map((d) => ({ ...d })),
        };
      },
    },
    get: () => state,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function listenLoopback(server: Server): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve(addr.port);
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

describe("Tuya Crypto — HA Device Sharing & OpenAPI v2.0", () => {
  test("HA Device Sharing hashKey, secret, AES-128-GCM encrypt/decrypt round-trip and X-sign", () => {
    const rid = "550e8400-e29b-41d4-a716-446655440000";
    const refreshToken = "rt_secret_refresh_token_123";
    const hashKey = tuyaSharingHashKey(rid, refreshToken);
    expect(hashKey).toHaveLength(32);

    const secret = tuyaSharingSecret(rid, "", hashKey);
    expect(secret).toHaveLength(16);

    const rawJson = JSON.stringify({ homeId: "123456", note: "客厅灯光控制" });
    const encrypted = tuyaSharingAesGcmEncrypt(rawJson, secret, "AbCdEfGh2345");
    // 12-byte nonce -> 16 base64 chars with no padding, concatenated with ciphertext+tag base64
    expect(encrypted.startsWith(Buffer.from("AbCdEfGh2345", "utf8").toString("base64"))).toBe(true);
    const decrypted = tuyaSharingAesGcmDecrypt(encrypted, secret);
    expect(decrypted).toBe(rawJson);

    // X-sign must join only non-empty headers with "||" (no trailing "||") + queryEncdata + bodyEncdata
    const headers = {
      "X-appKey": TUYA_CLIENT_ID,
      "X-requestId": rid,
      "X-sid": "",
      "X-time": "1730000000000",
      "X-token": "access_tok_abc",
    };
    const sign = tuyaSharingRestfulSign(hashKey, "QENC", "BENC", headers);
    const expectedSignStr =
      `X-appKey=${TUYA_CLIENT_ID}||X-requestId=${rid}||X-time=1730000000000||X-token=access_tok_abcQENCBENC`;
    const expectedSign = createHmac("sha256", Buffer.from(hashKey, "utf8"))
      .update(expectedSignStr, "utf8")
      .digest("hex");
    expect(sign).toBe(expectedSign);
  });

  test("Tuya Cloud OpenAPI v2.0 canonical URL query sorting and HMAC-SHA256 signature", () => {
    expect(canonicalizeOpenApiUrl("/v1.0/devices?z=9&a=1&m=5")).toBe(
      "/v1.0/devices?a=1&m=5&z=9",
    );

    const res = tuyaOpenApiSign({
      clientId: "test_client_id",
      secret: "test_client_secret",
      method: "POST",
      url: "/v1.0/devices/dev123/commands?z=2&a=1",
      body: '{"commands":[{"code":"switch_led","value":true}]}',
      accessToken: "tok_999",
      t: "1730000000123",
      nonce: "nonce01",
    });

    const expectedStringToSign = [
      "POST",
      res.contentHash,
      "",
      "/v1.0/devices/dev123/commands?a=1&z=2",
    ].join("\n");
    expect(res.stringToSign).toBe(expectedStringToSign);

    const expectedSign = createHmac("sha256", "test_client_secret")
      .update(`test_client_idtok_9991730000000123nonce01${expectedStringToSign}`, "utf8")
      .digest("hex")
      .toUpperCase();
    expect(res.sign).toBe(expectedSign);
    expect(res.sign).toMatch(/^[0-9A-F]{64}$/);
  });
});

describe("Tuya Crypto — LocalTuya / TinyTuya v3.3, v3.4, v3.5 & UDP Broadcast", () => {
  const localKey = "0123456789abcdef";

  test("v3.3 0x000055AA AES-128-ECB + CRC32 pack/unpack and tamper detection", () => {
    expect(crc32(Buffer.from("123456789", "ascii"))).toBe(0xcbf43926);

    const payload = JSON.stringify({ devId: "bf01", dps: { "1": true } });
    const frame = packTuyaLocalMessage({
      cmd: TUYA_LOCAL_CMD.CONTROL,
      seqno: 7,
      payload,
      key: localKey,
      version: "3.3",
    });
    expect(frame.readUInt32BE(0)).toBe(TUYA_PREFIX_55AA);

    const unpacked = unpackTuyaLocalMessage(frame, { key: localKey, version: "3.3" });
    expect(unpacked.seqno).toBe(7);
    expect(unpacked.cmd).toBe(TUYA_LOCAL_CMD.CONTROL);
    expect(unpacked.json).toEqual({ devId: "bf01", dps: { "1": true } });

    // Flip a bit in encrypted body -> CRC32 must reject
    const tampered = Buffer.from(frame);
    tampered[20] = tampered[20]! ^ 0xff;
    expect(() => unpackTuyaLocalMessage(tampered, { key: localKey, version: "3.3" })).toThrow(
      /CRC32/i,
    );
  });

  test("v3.4 0x000055AA HMAC-SHA256 & session key derivation", () => {
    const clientNonce = Buffer.from("0123456789abcdef", "ascii");
    const remoteNonce = Buffer.from("fedcba9876543210", "ascii");
    const sessionKey = deriveTuyaSessionKey(localKey, clientNonce, remoteNonce, "3.4");
    expect(sessionKey).toHaveLength(16);

    const payload = JSON.stringify({ protocol: 5, t: 1730000000, data: { dps: { "20": true } } });
    const frame = packTuyaLocalMessage({
      cmd: TUYA_LOCAL_CMD.CONTROL_NEW,
      seqno: 12,
      payload,
      key: sessionKey,
      version: "3.4",
    });
    const unpacked = unpackTuyaLocalMessage(frame, { key: sessionKey, version: "3.4" });
    expect(unpacked.seqno).toBe(12);
    expect(unpacked.cmd).toBe(TUYA_LOCAL_CMD.CONTROL_NEW);
    expect(unpacked.json).toEqual({ protocol: 5, t: 1730000000, data: { dps: { "20": true } } });

    // Wrong key -> HMAC verification failure
    expect(() =>
      unpackTuyaLocalMessage(frame, { key: "fedcba9876543210", version: "3.4" }),
    ).toThrow(/HMAC/i);
  });

  test("v3.5 0x00006699 AES-128-GCM with AAD & session key derivation", () => {
    const clientNonce = Buffer.from("aabbccddeeff00112233445566778899", "hex");
    const remoteNonce = Buffer.from("112233445566778899aabbccddeeff00", "hex");
    const sessionKey = deriveTuyaSessionKey(localKey, clientNonce, remoteNonce, "3.5");
    expect(sessionKey).toHaveLength(16);

    const iv = Buffer.from("00112233445566778899aabb", "hex");
    const payload = JSON.stringify({ dps: { "1": true, "2": 240 } });
    const frame = packTuyaLocalMessage({
      cmd: TUYA_LOCAL_CMD.DP_QUERY_NEW,
      seqno: 42,
      payload,
      key: sessionKey,
      version: "3.5",
      retcode: 0,
      iv,
    });
    expect(frame.readUInt32BE(0)).toBe(TUYA_PREFIX_6699);

    const unpacked = unpackTuyaLocalMessage(frame, {
      key: sessionKey,
      version: "3.5",
      hasRetcode: true,
    });
    expect(unpacked.seqno).toBe(42);
    expect(unpacked.retcode).toBe(0);
    expect(unpacked.json).toEqual({ dps: { "1": true, "2": 240 } });

    // Tampering with AAD (seqno byte) must fail AES-GCM auth tag
    const tamperedAad = Buffer.from(frame);
    tamperedAad[9] = tamperedAad[9]! ^ 0x01;
    expect(() =>
      unpackTuyaLocalMessage(tamperedAad, { key: sessionKey, version: "3.5", hasRetcode: true }),
    ).toThrow();
  });

  test("UDP discovery broadcast decryption for both 0x000055AA (v3.3) and 0x00006699 (v3.5)", () => {
    const info = {
      ip: "192.168.1.55",
      gwId: "bf_udp_001",
      active: 2,
      ability: 0,
      encrypt: true,
      productKey: "key123",
      version: "3.3",
    };
    const packet33 = packTuyaLocalMessage({
      cmd: TUYA_LOCAL_CMD.UDP_NEW,
      seqno: 0,
      payload: JSON.stringify(info),
      key: UDP_BROADCAST_KEY,
      version: "3.3",
      retcode: 0,
    });
    expect(decryptUdpBroadcast(packet33)).toEqual(info);

    const info35 = { ...info, gwId: "bf_udp_035", version: "3.5" };
    const packet35 = packTuyaLocalMessage({
      cmd: TUYA_LOCAL_CMD.BOARDCAST_LPV34,
      seqno: 0,
      payload: JSON.stringify(info35),
      key: UDP_BROADCAST_KEY,
      version: "3.5",
      retcode: 0,
    });
    expect(decryptUdpBroadcast(packet35)).toEqual(info35);

    expect(decryptUdpBroadcast(Buffer.from("not-a-tuya-packet"))).toBeNull();
  });
});

describe("TuyaLocalClient — Real Loopback TCP Mock Servers (v3.3 & v3.5)", () => {
  test("v3.3 loopback TCP server: DP_QUERY and CONTROL setDps", async () => {
    const localKey = "k1234567890abcde";
    const deviceState: Record<string, unknown> = { "20": false, "22": 500 };

    const server = createServer((socket) => {
      let rx: Buffer = Buffer.alloc(0);
      socket.on("data", (chunk) => {
        const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        rx = Buffer.concat([rx, part]);
        while (rx.length > 0) {
          const extracted = tryExtractTuyaFrame(rx);
          if (!extracted) break;
          rx = Buffer.from(extracted.remainder);
          const req = unpackTuyaLocalMessage(extracted.frame, {
            key: localKey,
            version: "3.3",
            hasRetcode: false,
          });
          if (req.cmd === TUYA_LOCAL_CMD.DP_QUERY) {
            const resp = packTuyaLocalMessage({
              cmd: TUYA_LOCAL_CMD.DP_QUERY,
              seqno: req.seqno,
              payload: JSON.stringify({ dps: deviceState }),
              key: localKey,
              version: "3.3",
              retcode: 0,
            });
            socket.write(resp);
          } else if (req.cmd === TUYA_LOCAL_CMD.CONTROL) {
            const nextDps = (req.json?.dps ?? {}) as Record<string, unknown>;
            Object.assign(deviceState, nextDps);
            const resp = packTuyaLocalMessage({
              cmd: TUYA_LOCAL_CMD.STATUS,
              seqno: req.seqno,
              payload: JSON.stringify({ dps: deviceState }),
              key: localKey,
              version: "3.3",
              retcode: 0,
            });
            socket.write(resp);
          }
        }
      });
    });

    const port = await listenLoopback(server);
    try {
      const client = new TuyaLocalClient({
        id: "bf_local_33",
        ip: "127.0.0.1",
        port,
        localKey,
        version: "3.3",
        timeoutMs: 3000,
      });

      const initial = await client.queryDps();
      expect(initial).toEqual({ "20": false, "22": 500 });

      const updated = await client.setDps({ "20": true, "22": 800 });
      expect(updated).toEqual({ "20": true, "22": 800 });

      const verified = await client.queryDps();
      expect(verified).toEqual({ "20": true, "22": 800 });
    } finally {
      await closeServer(server);
    }
  });

  test("v3.5 loopback TCP server: 3-way session key negotiation + DP_QUERY_NEW + CONTROL_NEW", async () => {
    const localKey = "v35key0123456789";
    const keyBuf = Buffer.from(localKey, "utf8");
    const deviceState: Record<string, unknown> = { "1": false, "2": 26 };
    let handshakesCompleted = 0;

    const server = createServer((socket) => {
      let rx: Buffer = Buffer.alloc(0);
      let clientNonce: Buffer | null = null;
      let remoteNonce: Buffer | null = null;
      let sessionKey: Buffer | null = null;

      socket.on("data", (chunk) => {
        const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        rx = Buffer.concat([rx, part]);
        while (rx.length > 0) {
          const extracted = tryExtractTuyaFrame(rx);
          if (!extracted) break;
          rx = Buffer.from(extracted.remainder);
          const activeKey = sessionKey ?? keyBuf;
          const req = unpackTuyaLocalMessage(extracted.frame, {
            key: activeKey,
            version: "3.5",
            hasRetcode: false,
          });

          if (req.cmd === TUYA_LOCAL_CMD.SESS_KEY_NEG_START) {
            clientNonce = Buffer.from(req.payload.subarray(0, 16));
            remoteNonce = randomBytes(16);
            const respHmac = createHmac("sha256", keyBuf).update(clientNonce).digest();
            const resp = packTuyaLocalMessage({
              cmd: TUYA_LOCAL_CMD.SESS_KEY_NEG_RESP,
              seqno: req.seqno,
              payload: Buffer.concat([remoteNonce, respHmac]),
              key: keyBuf,
              version: "3.5",
              retcode: 0,
              includeVersionHeader: false,
            });
            socket.write(resp);
          } else if (req.cmd === TUYA_LOCAL_CMD.SESS_KEY_NEG_FINISH) {
            const expected = createHmac("sha256", keyBuf).update(remoteNonce!).digest();
            if (!req.payload.equals(expected)) {
              socket.destroy();
              return;
            }
            sessionKey = deriveTuyaSessionKey(keyBuf, clientNonce!, remoteNonce!, "3.5");
            handshakesCompleted += 1;
          } else if (req.cmd === TUYA_LOCAL_CMD.DP_QUERY_NEW && sessionKey) {
            const resp = packTuyaLocalMessage({
              cmd: TUYA_LOCAL_CMD.DP_QUERY_NEW,
              seqno: req.seqno,
              payload: JSON.stringify({ dps: deviceState }),
              key: sessionKey,
              version: "3.5",
              retcode: 0,
              includeVersionHeader: false,
            });
            socket.write(resp);
          } else if (req.cmd === TUYA_LOCAL_CMD.CONTROL_NEW && sessionKey) {
            const data = (req.json?.data ?? {}) as Record<string, unknown>;
            const nextDps = (data.dps ?? {}) as Record<string, unknown>;
            Object.assign(deviceState, nextDps);
            const resp = packTuyaLocalMessage({
              cmd: TUYA_LOCAL_CMD.STATUS,
              seqno: req.seqno,
              payload: JSON.stringify({ data: { dps: deviceState } }),
              key: sessionKey,
              version: "3.5",
              retcode: 0,
              includeVersionHeader: false,
            });
            socket.write(resp);
          }
        }
      });
    });

    const port = await listenLoopback(server);
    try {
      const client = new TuyaLocalClient({
        id: "bf_local_35",
        ip: "127.0.0.1",
        port,
        localKey,
        version: "3.5",
        timeoutMs: 3000,
      });

      const queried = await client.queryDps();
      expect(queried).toEqual({ "1": false, "2": 26 });

      const updated = await client.setDps({ "1": true, "2": 24 });
      expect(updated).toEqual({ "1": true, "2": 24 });
      expect(handshakesCompleted).toBe(2);
    } finally {
      await closeServer(server);
    }
  });
});

describe("Tuya Mapper — Light, 2-Gang Switch Split, Sensor Metrics, AC & Dehumidifier", () => {
  test("Category mapping covers lights, switches, outlets, climate, sensors, vacuum, pet-feeder, camera", () => {
    expect(tuyaCategoryToKind("dj")).toBe("light");
    expect(tuyaCategoryToKind("kg")).toBe("switch");
    expect(tuyaCategoryToKind("cz")).toBe("outlet");
    expect(tuyaCategoryToKind("kt")).toBe("air-conditioner");
    expect(tuyaCategoryToKind("cs")).toBe("dehumidifier");
    expect(tuyaCategoryToKind("wsdcg")).toBe("temperature-humidity-sensor");
    expect(tuyaCategoryToKind("sd")).toBe("vacuum");
    expect(tuyaCategoryToKind("cwwsq")).toBe("pet-feeder");
    expect(tuyaCategoryToKind("sp")).toBe("camera");
  });

  test("RGB+CCT light brightness, color-temperature, and HSV <-> RGB round-trip mapping", () => {
    expect(percentToTuyaBrightness(1, 10, 1000)).toBe(10);
    expect(percentToTuyaBrightness(50, 10, 1000)).toBe(500);
    expect(percentToTuyaBrightness(100, 10, 1000)).toBe(1000);
    expect(tuyaBrightnessToPercent(500, 10, 1000)).toBe(50);

    expect(kelvinToTuyaTemp(2700, 0, 1000)).toBe(0);
    expect(kelvinToTuyaTemp(4600, 0, 1000)).toBe(500);
    expect(kelvinToTuyaTemp(6500, 0, 1000)).toBe(1000);
    expect(tuyaTempToKelvin(500, 0, 1000)).toBe(4600);

    for (const rgb of [0xff0000, 0x00ff00, 0x0000ff, 0x00ffff, 0xffff00, 0xffffff]) {
      const hsv = rgbIntToTuyaHsvV2(rgb);
      expect(tuyaHsvV2ToRgbInt(JSON.stringify(hsv))).toBe(rgb);

      const v1Hex = rgbIntToTuyaColourV1Hex(rgb);
      expect(v1Hex).toHaveLength(14);
      expect(tuyaColourV1HexToRgbInt(v1Hex)).toBe(rgb);
    }

    const lightRecord: TuyaDeviceRecord = {
      id: "bf_light_01",
      name: "客厅吸顶灯",
      category: "dj",
      productId: "prod_bulb",
      homeName: "我的家",
      roomName: "客厅",
      online: true,
      source: "sharing",
      status: {
        switch_led: true,
        work_mode: "colour",
        bright_value_v2: 500,
        temp_value_v2: 500,
        colour_data_v2: JSON.stringify({ h: 240, s: 1000, v: 1000 }),
      },
      spec: {
        category: "dj",
        functions: [
          { code: "switch_led", type: "Boolean", values: "{}" },
          { code: "work_mode", type: "Enum", values: '{"range":["white","colour","scene"]}' },
          { code: "bright_value_v2", type: "Integer", values: '{"min":10,"max":1000,"step":1,"scale":0}' },
          { code: "temp_value_v2", type: "Integer", values: '{"min":0,"max":1000,"step":1,"scale":0}' },
          { code: "colour_data_v2", type: "Json", values: "{}" },
        ],
        status: [
          { code: "switch_led", type: "Boolean", values: "{}" },
          { code: "bright_value_v2", type: "Integer", values: '{"min":10,"max":1000,"step":1,"scale":0}' },
          { code: "temp_value_v2", type: "Integer", values: '{"min":0,"max":1000,"step":1,"scale":0}' },
          { code: "colour_data_v2", type: "Json", values: "{}" },
        ],
      },
    };

    const { cards, profiles } = mapTuyaDeviceToCards(lightRecord);
    expect(cards).toHaveLength(1);
    const card = cards[0]!;
    expect(card.platform).toBe("tuya");
    expect(card.spec_type).toBe("urn:tuya:device:light:1");
    expect(card.light_features).toEqual(["brightness", "temperature", "color"]);

    const profile = profiles.get("bf_light_01")!;
    expect(profile.powerDpCode).toBe("switch_led");
    expect(profile.detail.props.map((p) => p.name)).toContain("on");
    expect(profile.detail.props.map((p) => p.name)).toContain("brightness");
    expect(profile.detail.props.map((p) => p.name)).toContain("color-temperature");
    expect(profile.detail.props.map((p) => p.name)).toContain("color");
  });

  test("2-gang switch splits into parent panel card + .s1 and .s2 channel cards", () => {
    const swRecord: TuyaDeviceRecord = {
      id: "bf_sw_2g",
      name: "卧室双开",
      category: "kg",
      homeName: "我的家",
      roomName: "主卧",
      online: true,
      source: "sharing",
      status: { switch_1: true, switch_2: false, countdown_1: 0, relay_status: "memory" },
      spec: {
        category: "kg",
        functions: [
          { code: "switch_1", type: "Boolean", values: "{}" },
          { code: "switch_2", type: "Boolean", values: "{}" },
          { code: "countdown_1", type: "Integer", values: '{"min":0,"max":86400,"step":1,"scale":0,"unit":"s"}' },
          { code: "relay_status", type: "Enum", values: '{"range":["off","on","memory"]}' },
        ],
        status: [
          { code: "switch_1", type: "Boolean", values: "{}" },
          { code: "switch_2", type: "Boolean", values: "{}" },
        ],
      },
    };

    const { cards, profiles } = mapTuyaDeviceToCards(swRecord);
    expect(cards.map((c) => c.did)).toEqual(["bf_sw_2g", "bf_sw_2g.s1", "bf_sw_2g.s2"]);
    expect(cards[0]!.switch_channels).toEqual(["bf_sw_2g.s1", "bf_sw_2g.s2"]);
    expect(profiles.get("bf_sw_2g")!.isSplitParent).toBe(true);
    expect(profiles.get("bf_sw_2g.s1")!.powerDpCode).toBe("switch_1");
    expect(profiles.get("bf_sw_2g.s2")!.powerDpCode).toBe("switch_2");
    expect(profiles.get("bf_sw_2g.s1")!.detail.props.map((p) => p.name)).toEqual([
      "on",
      "countdown_1",
    ]);
  });

  test("Temperature/humidity sensor metrics & AC/dehumidifier Chinese prop descriptions", () => {
    const sensorRecord: TuyaDeviceRecord = {
      id: "bf_th_01",
      name: "书房温湿度计",
      category: "wsdcg",
      online: true,
      source: "sharing",
      status: { va_temperature: 245, va_humidity: 58, battery_percentage: 92 },
      spec: {
        category: "wsdcg",
        functions: [],
        status: [
          { code: "va_temperature", type: "Integer", values: '{"min":-200,"max":600,"scale":1,"step":1,"unit":"℃"}' },
          { code: "va_humidity", type: "Integer", values: '{"min":0,"max":100,"scale":0,"step":1,"unit":"%"}' },
          { code: "battery_percentage", type: "Integer", values: '{"min":0,"max":100,"scale":0,"step":1,"unit":"%"}' },
        ],
      },
    };

    const { cards, profiles } = mapTuyaDeviceToCards(sensorRecord);
    expect(cards[0]!.spec_type).toBe("urn:tuya:device:temperature-humidity-sensor:1");
    expect(cards[0]!.metric_features).toEqual(["temperature", "relative-humidity"]);
    expect(formatTuyaDeviceMetrics(profiles.get("bf_th_01")!, sensorRecord.status)).toBe(
      "24.5°C 58%",
    );

    const acRecord: TuyaDeviceRecord = {
      id: "bf_dehum_01",
      name: "客厅除湿机",
      category: "cs",
      online: true,
      source: "openapi",
      status: { switch: true, dehumidify_set_value: 50, mode: "dry", fan_speed_enum: "high", child_lock: false },
      spec: {
        category: "cs",
        functions: [
          { code: "switch", type: "Boolean", values: "{}" },
          { code: "dehumidify_set_value", type: "Integer", values: '{"min":30,"max":80,"step":5,"scale":0,"unit":"%"}' },
          { code: "mode", type: "Enum", values: '{"range":["auto","dry","continuous"]}' },
          { code: "fan_speed_enum", type: "Enum", values: '{"range":["low","high"]}' },
          { code: "child_lock", type: "Boolean", values: "{}" },
        ],
        status: [],
      },
    };

    const dehumMapped = mapTuyaDeviceToCards(acRecord);
    const props = dehumMapped.profiles.get("bf_dehum_01")!.detail.props;
    expect(props.find((p) => p.name === "on")?.desc).toBe("开关");
    expect(props.find((p) => p.name === "dehumidify_set_value")?.desc).toBe("目标湿度");
    expect(props.find((p) => p.name === "mode")?.desc).toBe("工作模式");
    expect(props.find((p) => p.name === "mode")?.value_list?.find((o) => o.value === "dry")?.desc_zh_cn).toBe(
      "干衣",
    );
    expect(props.find((p) => p.name === "fan_speed_enum")?.desc).toBe("风速");
    expect(props.find((p) => p.name === "child_lock")?.desc).toBe("童锁");
  });
});

describe("TuyaPlatformProvider — QR Auth, Encrypted Cloud Sync, Control, Hybrid Fallback & Redaction", () => {
  test("HA Device Sharing QR login flow (beginQrAuth -> pollQrAuth) persists tokenSession and redacts secrets", async () => {
    const mem = makeMemoryConfigStore();
    let pollCount = 0;

    const mockFetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/v1.0/m/life/home-assistant/qrcode/tokens?") && init?.method === "POST") {
        expect(url).toContain(`clientid=${TUYA_CLIENT_ID}`);
        expect(url).toContain("usercode=UC998877");
        expect(url).toContain(`schema=${TUYA_SCHEMA}`);
        return jsonResponse({ success: true, result: { qrcode: "QR_TOK_ABC123" } });
      }
      if (url.includes("/v1.0/m/life/home-assistant/qrcode/tokens/QR_TOK_ABC123")) {
        pollCount += 1;
        if (pollCount === 1) {
          return jsonResponse({ success: false, code: "1106", msg: "qrcode is not scanned" });
        }
        return jsonResponse({
          success: true,
          result: {
            access_token: "live_access_token_secret_xyz",
            refresh_token: "live_refresh_token_secret_xyz",
            expire_time: 7200,
            uid: "ay16800001",
            endpoint: "https://apigw.iotbing.com",
            username: "tuya_demo_user",
          },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const provider = new TuyaPlatformProvider({
      httpFetch: mockFetch,
      configStore: mem.store,
      now: () => 1_730_000_000_000,
    });

    const qrSession = await provider.beginQrAuth({ userCode: "UC998877" });
    expect(qrSession.platform).toBe("tuya");
    expect(qrSession.qrContent).toBe("tuyaSmart--qrLogin?token=QR_TOK_ABC123");
    expect(qrSession.qrSvg).toContain("<svg");

    const firstPoll = await provider.pollQrAuth(qrSession.sessionId);
    expect(firstPoll.status).toBe("pending");

    const secondPoll = await provider.pollQrAuth(qrSession.sessionId);
    expect(secondPoll.status).toBe("success");
    expect(provider.isConnected()).toBe(true);
    expect(mem.get().tokenSession?.accessToken).toBe("live_access_token_secret_xyz");

    // Verify status().configSummary NEVER leaks tokens or secrets
    const summaryStr = JSON.stringify(provider.status().configSummary);
    expect(summaryStr).not.toContain("live_access_token_secret_xyz");
    expect(summaryStr).not.toContain("live_refresh_token_secret_xyz");
    expect(provider.status().configSummary.hasTokenSession).toBe(true);
    expect(provider.status().configSummary.username).toBe("tuya_demo_user");
  });

  test("HA QR poll treats Tuya unscanned 'login failed' (E0020003) as pending and handles expiry/usercode errors", async () => {
    const mem = makeMemoryConfigStore({
      // Simulate prior regional endpoint stored in config — QR auth must still hit apigw.iotbing.com
      endpoint: "https://apigw.tuyacn.com",
    });
    let pollStep = 0;

    const mockFetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/v1.0/m/life/home-assistant/qrcode/tokens?") && init?.method === "POST") {
        expect(url.startsWith("https://apigw.iotbing.com/")).toBe(true);
        if (url.includes("usercode=BADCODE")) {
          return jsonResponse({ success: false, code: "USERCODE_INCORRECT", msg: "User Code Incorrect" });
        }
        return jsonResponse({ success: true, result: { qrcode: "QR_UNSCANNED_TEST" } });
      }
      if (url.includes("/v1.0/m/life/home-assistant/qrcode/tokens/QR_UNSCANNED_TEST")) {
        expect(url.startsWith("https://apigw.iotbing.com/")).toBe(true);
        pollStep += 1;
        if (pollStep === 1) {
          return jsonResponse({ success: false, code: "E0020003", msg: "login failed" });
        }
        if (pollStep === 2) {
          return jsonResponse({
            success: false,
            code: "LOGIN_FAILED",
            msg: "Login failed, please scan and try again!",
          });
        }
        if (pollStep === 3) {
          return jsonResponse({ success: false, code: "E0020002", msg: "QR code expired" });
        }
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const provider = new TuyaPlatformProvider({
      httpFetch: mockFetch,
      configStore: mem.store,
      now: () => 1_730_000_000_000,
    });

    // Invalid user code returns clear Chinese hint
    await expect(provider.beginQrAuth({ userCode: "BADCODE" })).rejects.toThrow("涂鸦用户码不正确");

    // Valid user code starts session and clears prior lastError
    const session = await provider.beginQrAuth({ userCode: "VALID01" });
    expect(provider.status().lastError).toBeNull();

    // Poll #1 & #2: Tuya returns "login failed" before user scans -> MUST stay "pending", never error!
    const p1 = await provider.pollQrAuth(session.sessionId);
    expect(p1.status).toBe("pending");
    expect(provider.status().lastError).toBeNull();

    const p2 = await provider.pollQrAuth(session.sessionId);
    expect(p2.status).toBe("pending");
    expect(provider.status().lastError).toBeNull();

    // Poll #3: explicit expiry code E0020002 -> status "expired"
    const p3 = await provider.pollQrAuth(session.sessionId);
    expect(p3.status).toBe("expired");
  });

  test("Full Sharing encrypted API round-trip: listDevices, deviceDetail, writeProp, togglePower, scenes & disconnect", async () => {
    const refreshToken = "refresh_tok_secret_98765";
    const accessToken = "access_tok_secret_12345";
    const mem = makeMemoryConfigStore({
      enabled: true,
      mode: "sharing",
      userCode: "UC112233",
      tokenSession: {
        accessToken,
        refreshToken,
        expireTime: 1_730_010_000_000,
        uid: "uid_sharing_1",
        endpoint: "https://apigw.iotbing.com",
      },
    });

    const lightState: Record<string, unknown> = {
      switch_led: false,
      bright_value_v2: 500,
      temp_value_v2: 500,
      colour_data_v2: JSON.stringify({ h: 0, s: 1000, v: 1000 }),
    };
    const switchState: Record<string, unknown> = {
      switch_1: true,
      switch_2: false,
    };
    const sentCommands: Array<{ deviceId: string; commands: Array<{ code: string; value: unknown }> }> = [];
    const triggeredScenes: Array<{ homeId: string; sceneId: string }> = [];

    const mockFetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const parsedUrl = new URL(urlStr);
      const headers = (init?.headers ?? {}) as Record<string, string>;

      // Verify HA Device Sharing signature & decrypt request query/body using shared protocol
      const rid = headers["X-requestId"]!;
      const sid = headers["X-sid"] ?? "";
      const hashKey = tuyaSharingHashKey(rid, refreshToken);
      const secret = tuyaSharingSecret(rid, sid, hashKey);

      const queryEnc = parsedUrl.searchParams.get("encdata") ?? "";
      let bodyEnc = "";
      if (typeof init?.body === "string" && init.body) {
        bodyEnc = (JSON.parse(init.body) as { encdata?: string }).encdata ?? "";
      }
      const expectedSign = tuyaSharingRestfulSign(hashKey, queryEnc, bodyEnc, headers);
      expect(headers["X-sign"]).toBe(expectedSign);
      expect(headers["X-token"]).toBe(accessToken);

      const queryParams = queryEnc
        ? (JSON.parse(tuyaSharingAesGcmDecrypt(queryEnc, secret)) as Record<string, unknown>)
        : {};
      const bodyParams = bodyEnc
        ? (JSON.parse(tuyaSharingAesGcmDecrypt(bodyEnc, secret)) as Record<string, unknown>)
        : {};

      const replyEncrypted = (resultObj: unknown): Response =>
        jsonResponse({
          success: true,
          result: tuyaSharingAesGcmEncrypt(JSON.stringify(resultObj), secret),
        });

      if (parsedUrl.pathname === "/v1.0/m/life/users/homes") {
        return replyEncrypted([{ ownerId: "home_1", name: "甜蜜之家" }]);
      }
      if (parsedUrl.pathname === "/v1.0/m/life/ha/home/devices") {
        expect(queryParams.homeId).toBe("home_1");
        return replyEncrypted([
          {
            id: "dev_light",
            name: "彩光球泡灯",
            category: "dj",
            productId: "p_light",
            roomName: "客厅",
            online: true,
            status: Object.entries(lightState).map(([code, value]) => ({ code, value })),
          },
          {
            id: "dev_2g",
            name: "走廊双控开关",
            category: "kg",
            productId: "p_sw2",
            roomName: "走廊",
            online: true,
            status: Object.entries(switchState).map(([code, value]) => ({ code, value })),
          },
        ]);
      }
      if (parsedUrl.pathname === "/v1.1/m/life/dev_light/specifications") {
        return replyEncrypted({
          category: "dj",
          functions: [
            { code: "switch_led", type: "Boolean", values: "{}" },
            { code: "bright_value_v2", type: "Integer", values: '{"min":10,"max":1000,"step":1,"scale":0}' },
            { code: "temp_value_v2", type: "Integer", values: '{"min":0,"max":1000,"step":1,"scale":0}' },
            { code: "colour_data_v2", type: "Json", values: "{}" },
          ],
          status: [
            { code: "switch_led", type: "Boolean", values: "{}" },
            { code: "bright_value_v2", type: "Integer", values: '{"min":10,"max":1000,"step":1,"scale":0}' },
            { code: "temp_value_v2", type: "Integer", values: '{"min":0,"max":1000,"step":1,"scale":0}' },
            { code: "colour_data_v2", type: "Json", values: "{}" },
          ],
        });
      }
      if (parsedUrl.pathname === "/v1.1/m/life/dev_2g/specifications") {
        return replyEncrypted({
          category: "kg",
          functions: [
            { code: "switch_1", type: "Boolean", values: "{}" },
            { code: "switch_2", type: "Boolean", values: "{}" },
          ],
          status: [
            { code: "switch_1", type: "Boolean", values: "{}" },
            { code: "switch_2", type: "Boolean", values: "{}" },
          ],
        });
      }
      if (parsedUrl.pathname === "/v1.0/m/life/ha/devices/detail") {
        const ids = String(queryParams.devIds ?? "").split(",");
        const list = [];
        if (ids.includes("dev_light")) {
          list.push({
            id: "dev_light",
            online: true,
            status: Object.entries(lightState).map(([code, value]) => ({ code, value })),
          });
        }
        if (ids.includes("dev_2g")) {
          list.push({
            id: "dev_2g",
            online: true,
            status: Object.entries(switchState).map(([code, value]) => ({ code, value })),
          });
        }
        return replyEncrypted(list);
      }
      if (parsedUrl.pathname.startsWith("/v1.1/m/thing/") && parsedUrl.pathname.endsWith("/commands")) {
        const deviceId = parsedUrl.pathname.split("/")[4]!;
        const cmds = (bodyParams.commands ?? []) as Array<{ code: string; value: unknown }>;
        sentCommands.push({ deviceId, commands: cmds });
        for (const c of cmds) {
          if (deviceId === "dev_light") lightState[c.code] = c.value;
          if (deviceId === "dev_2g") switchState[c.code] = c.value;
        }
        return replyEncrypted(true);
      }
      if (parsedUrl.pathname === "/v1.0/m/scene/ha/home/scenes") {
        return replyEncrypted([{ scene_id: "sc_goodnight", name: "一键晚安", home_id: "home_1" }]);
      }
      if (parsedUrl.pathname === "/v1.0/m/scene/ha/trigger") {
        triggeredScenes.push({
          homeId: String(bodyParams.homeId),
          sceneId: String(bodyParams.sceneId),
        });
        return replyEncrypted(true);
      }
      throw new Error(`Unhandled path: ${parsedUrl.pathname}`);
    }) as typeof fetch;

    const provider = new TuyaPlatformProvider({
      httpFetch: mockFetch,
      configStore: mem.store,
      now: () => 1_730_000_000_000,
    });

    const devices = await provider.listDevices();
    expect(devices.map((d) => d.did).sort()).toEqual([
      "dev_2g",
      "dev_2g.s1",
      "dev_2g.s2",
      "dev_light",
    ]);

    const detail = await provider.deviceDetail("dev_light");
    expect(detail.props.map((p) => p.name)).toContain("brightness");
    expect(detail.props.map((p) => p.name)).toContain("color-temperature");
    expect(detail.props.map((p) => p.name)).toContain("color");

    // Write brightness (100% -> 1000) & color (pure blue 0x0000ff -> h:240,s:1000,v:1000)
    await provider.writeProp("dev_light", "brightness", 100);
    await provider.writeProp("dev_light", "color", 0x0000ff);
    expect(sentCommands[0]).toEqual({
      deviceId: "dev_light",
      commands: [{ code: "bright_value_v2", value: 1000 }],
    });
    expect(sentCommands[1]).toEqual({
      deviceId: "dev_light",
      commands: [{ code: "colour_data_v2", value: '{"h":240,"s":1000,"v":1000}' }],
    });

    expect(await provider.readProp("dev_light", "brightness")).toBe(100);
    expect(await provider.readProp("dev_light", "color")).toBe(0x0000ff);

    // Toggle power on light (false -> true) and split switch channel .s2 (false -> true)
    expect(await provider.togglePower("dev_light")).toBe(true);
    expect(await provider.togglePower("dev_2g.s2")).toBe(true);
    expect(await provider.powerStates(["dev_light", "dev_2g", "dev_2g.s1", "dev_2g.s2"])).toEqual({
      dev_light: true,
      dev_2g: null,
      "dev_2g.s1": true,
      "dev_2g.s2": true,
    });

    // Scenes
    const scenes = await provider.sceneList();
    expect(scenes).toHaveLength(1);
    expect(scenes[0]!.name).toBe("一键晚安");
    await provider.runScene(scenes[0]!);
    expect(triggeredScenes).toEqual([{ homeId: "home_1", sceneId: "sc_goodnight" }]);

    // Disconnect clears session & disables
    await provider.disconnect();
    expect(provider.isEnabled()).toBe(false);
    expect(provider.isConnected()).toBe(false);
    expect(mem.get().tokenSession).toBeNull();
  });

  test("Sharing client automatically refreshes expired access token via /v1.0/m/token/{refreshToken}", async () => {
    let refreshedCallbackCount = 0;
    let currentRefresh = "rt_old_111";

    const mockFetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
      );
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const rid = headers["X-requestId"]!;
      const hashKey = tuyaSharingHashKey(rid, currentRefresh);
      const secret = tuyaSharingSecret(rid, "", hashKey);

      if (url.pathname === `/v1.0/m/token/${currentRefresh}`) {
        expect(headers["X-token"]).toBeUndefined();
        currentRefresh = "rt_new_222";
        return jsonResponse({
          success: true,
          result: tuyaSharingAesGcmEncrypt(
            JSON.stringify({
              access_token: "at_new_222",
              refresh_token: "rt_new_222",
              expire_time: 7200,
              uid: "uid_1",
            }),
            secret,
          ),
        });
      }
      if (url.pathname === "/v1.0/m/life/users/homes") {
        expect(headers["X-token"]).toBe("at_new_222");
        return jsonResponse({
          success: true,
          result: tuyaSharingAesGcmEncrypt(
            JSON.stringify([{ ownerId: "h9", name: "刷新后的家庭" }]),
            secret,
          ),
        });
      }
      throw new Error(`Unexpected path: ${url.pathname}`);
    }) as typeof fetch;

    const client = new TuyaSharingClient({
      httpFetch: mockFetch,
      now: () => 2_000_000_000_000,
      tokenSession: {
        accessToken: "at_expired_111",
        refreshToken: "rt_old_111",
        expireTime: 1_999_999_000_000, // already expired
        uid: "uid_1",
        endpoint: "https://apigw.iotbing.com",
      },
      onTokenUpdate: () => {
        refreshedCallbackCount += 1;
      },
    });

    const homes = await client.queryHomes();
    expect(homes).toEqual([{ ownerId: "h9", name: "刷新后的家庭" }]);
    expect(refreshedCallbackCount).toBe(1);
    expect(client.tokenSession?.accessToken).toBe("at_new_222");
  });

  test("Hybrid mode prefers local LAN execution and falls back to OpenAPI cloud on LAN failure, while redacting secrets", async () => {
    const accessSecret = "SUPER_SECRET_OPENAPI_KEY_999";
    const localKey = "LOCAL_SECRET_KEY";
    const mem = makeMemoryConfigStore();

    let lanFail = false;
    let lanSetCalls = 0;
    let cloudCmdCalls = 0;
    let currentPower = false;

    const mockFetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
      );
      if (url.pathname === "/v1.0/token") {
        return jsonResponse({
          success: true,
          result: {
            access_token: "openapi_tok_1",
            refresh_token: "openapi_rt_1",
            expire_time: 7200,
            uid: "uid_openapi",
          },
        });
      }
      if (url.pathname === "/v1.0/users/uid_openapi/devices") {
        return jsonResponse({
          success: true,
          result: [
            {
              id: "plug_hybrid_1",
              name: "书桌智能插座",
              category: "cz",
              product_id: "p_plug",
              online: true,
              status: [{ code: "switch_1", value: currentPower }],
            },
          ],
        });
      }
      if (url.pathname === "/v1.0/users/uid_openapi/homes") {
        return jsonResponse({ success: true, result: [{ home_id: "h1", name: "办公室" }] });
      }
      if (url.pathname === "/v1.0/devices/plug_hybrid_1/specifications") {
        return jsonResponse({
          success: true,
          result: {
            category: "cz",
            functions: [{ code: "switch_1", dp_id: 1, type: "Boolean", values: "{}" }],
            status: [{ code: "switch_1", dp_id: 1, type: "Boolean", values: "{}" }],
          },
        });
      }
      if (url.pathname === "/v1.0/devices/plug_hybrid_1/commands") {
        cloudCmdCalls += 1;
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          commands: Array<{ code: string; value: unknown }>;
        };
        currentPower = Boolean(body.commands[0]?.value);
        return jsonResponse({ success: true, result: true });
      }
      if (url.pathname === "/v1.0/devices/plug_hybrid_1/status") {
        return jsonResponse({
          success: true,
          result: [{ code: "switch_1", value: currentPower }],
        });
      }
      throw new Error(`Unexpected OpenAPI path: ${url.pathname}`);
    }) as typeof fetch;

    const provider = new TuyaPlatformProvider({
      httpFetch: mockFetch,
      configStore: mem.store,
      localTransport: {
        async queryDps() {
          if (lanFail) throw new Error(`LAN timeout using ${localKey}`);
          return { "1": currentPower };
        },
        async setDps(_dev, dps) {
          if (lanFail) throw new Error(`LAN offline using ${localKey}`);
          lanSetCalls += 1;
          currentPower = Boolean(dps["1"]);
          return { "1": currentPower };
        },
      },
    });

    await provider.configure({
      enabled: true,
      mode: "hybrid",
      region: "cn",
      accessId: "aid_demo",
      accessSecret,
      uid: "uid_openapi",
      preferLocal: true,
      localDevices: [
        {
          id: "plug_hybrid_1",
          name: "书桌智能插座",
          ip: "192.168.1.88",
          port: 6668,
          localKey,
          version: "3.3",
          category: "cz",
        },
      ],
    });

    // Re-configuring with blank secrets must preserve existing accessSecret & localKey!
    await provider.configure({
      enabled: true,
      mode: "hybrid",
      accessSecret: "",
      localDevices: [
        {
          id: "plug_hybrid_1",
          name: "书桌智能插座",
          ip: "192.168.1.88",
          localKey: "••••••••",
          version: "3.3",
          category: "cz",
        },
      ],
    });
    expect(mem.get().accessSecret).toBe(accessSecret);
    expect(mem.get().localDevices[0]!.localKey).toBe(localKey);

    // Status summary must never expose secrets
    const statusJson = JSON.stringify(provider.status());
    expect(statusJson).not.toContain(accessSecret);
    expect(statusJson).not.toContain(localKey);
    expect(provider.status().configSummary.hasAccessSecret).toBe(true);

    await provider.listDevices();

    // 1. Prefer local LAN succeeds without hitting cloud
    await provider.setPowerState("plug_hybrid_1", true);
    expect(lanSetCalls).toBe(1);
    expect(cloudCmdCalls).toBe(0);
    expect(await provider.powerState("plug_hybrid_1")).toBe(true);

    // 2. When LAN goes offline, hybrid automatically falls back to OpenAPI cloud
    lanFail = true;
    await provider.setPowerState("plug_hybrid_1", false);
    expect(cloudCmdCalls).toBe(1);
    expect(await provider.powerState("plug_hybrid_1")).toBe(false);

    // 3. In local-only mode, error messages must redact localKey
    await provider.configure({ enabled: true, mode: "local" });
    await provider.listDevices();
    await expect(provider.setPowerState("plug_hybrid_1", true)).rejects.toThrow(/\[REDACTED\]/);
  });

  test("OpenAPI client executes signed requests and handles error codes cleanly", async () => {
    const client = new TuyaOpenApiClient({
      accessId: "cid_001",
      accessSecret: "sec_001",
      region: "eu",
      httpFetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
        );
        expect(url.origin).toBe("https://openapi.tuyaeu.com");
        const headers = (init?.headers ?? {}) as Record<string, string>;
        expect(headers.client_id).toBe("cid_001");
        expect(headers.sign_method).toBe("HMAC-SHA256");
        expect(headers.sign).toMatch(/^[0-9A-F]{64}$/);
        if (url.pathname === "/v1.0/token") {
          return jsonResponse({
            success: true,
            result: { access_token: "eu_tok", refresh_token: "eu_rt", expire_time: 7200, uid: "eu_u" },
          });
        }
        return jsonResponse({ success: false, code: 1109, msg: "param is illegal" });
      }) as typeof fetch,
    });

    const tok = await client.getAccessToken();
    expect(tok.accessToken).toBe("eu_tok");
    await expect(client.getDeviceStatus("bad_dev")).rejects.toThrow(/param is illegal/);
  });

  test("HA Device Sharing resolves rooms via /v1.0/m/thing/ha/{deviceId}/room (including empty/unassigned, split switches, errors & room move refresh)", async () => {
    const refreshToken = "refresh_room_test_999";
    const accessToken = "access_room_test_111";
    const mem = makeMemoryConfigStore({
      enabled: true,
      mode: "sharing",
      userCode: "UCROOM01",
      tokenSession: {
        accessToken,
        refreshToken,
        expireTime: 1_730_010_000_000,
        uid: "uid_room_test",
        endpoint: "https://apigw.tuyacn.com",
      },
      localDevices: [
        {
          id: "dev_local_room_fallback",
          name: "局域网兜底设备",
          ip: "192.168.1.99",
          port: 6668,
          localKey: "0123456789abcdef",
          version: "3.3",
          category: "cz",
          room: "阳台",
        },
      ],
    });

    let livingLightRoom = { id: 80190840, name: "客厅" };
    const roomRequests: string[] = [];

    const mockFetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const parsedUrl = new URL(urlStr);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const rid = headers["X-requestId"]!;
      const sid = headers["X-sid"] ?? "";
      const hashKey = tuyaSharingHashKey(rid, refreshToken);
      const secret = tuyaSharingSecret(rid, sid, hashKey);

      const replyEncrypted = (resultObj: unknown): Response =>
        jsonResponse({
          success: true,
          result: tuyaSharingAesGcmEncrypt(JSON.stringify(resultObj), secret),
        });

      if (parsedUrl.pathname === "/v1.0/m/life/users/homes") {
        return replyEncrypted([{ ownerId: "244347141", name: "我的家" }]);
      }
      if (parsedUrl.pathname === "/v1.0/m/life/ha/home/devices") {
        // Real Tuya Sharing API omits roomName / room_name from /ha/home/devices
        return replyEncrypted([
          {
            id: "dev_living_light",
            name: "客厅灯",
            category: "tdq",
            product_id: "p_sw1",
            online: true,
            status: [{ code: "switch_1", value: true }],
          },
          {
            id: "dev_bedroom_2g",
            name: "卧室双开",
            category: "kg",
            product_id: "p_sw2",
            online: true,
            status: [
              { code: "switch_1", value: false },
              { code: "switch_2", value: true },
            ],
          },
          {
            id: "dev_unassigned_empty",
            name: "大空调",
            category: "infrared_ac",
            product_id: "p_ac",
            online: true,
          },
          {
            id: "dev_local_room_fallback",
            name: "局域网兜底设备",
            category: "cz",
            product_id: "p_plug",
            online: true,
            status: [{ code: "switch_1", value: false }],
          },
          {
            id: "dev_room_api_error",
            name: "故障房间接口设备",
            category: "tdq",
            product_id: "p_err",
            online: true,
            status: [{ code: "switch_1", value: false }],
          },
        ]);
      }
      if (parsedUrl.pathname.endsWith("/specifications")) {
        if (parsedUrl.pathname.includes("dev_bedroom_2g")) {
          return replyEncrypted({
            category: "kg",
            functions: [
              { code: "switch_1", type: "Boolean", values: "{}" },
              { code: "switch_2", type: "Boolean", values: "{}" },
            ],
            status: [
              { code: "switch_1", type: "Boolean", values: "{}" },
              { code: "switch_2", type: "Boolean", values: "{}" },
            ],
          });
        }
        return replyEncrypted({ functions: [], status: [] });
      }
      if (parsedUrl.pathname.startsWith("/v1.0/m/thing/ha/") && parsedUrl.pathname.endsWith("/room")) {
        const deviceId = parsedUrl.pathname.split("/")[5]!;
        roomRequests.push(deviceId);
        if (deviceId === "dev_living_light") {
          return replyEncrypted(livingLightRoom);
        }
        if (deviceId === "dev_bedroom_2g") {
          return replyEncrypted({ id: 80193049, name: "卧室" });
        }
        if (deviceId === "dev_unassigned_empty") {
          // Real Tuya gateway returns empty string `result: ""` (unencrypted) when unassigned
          return jsonResponse({ success: true, result: "" });
        }
        if (deviceId === "dev_local_room_fallback") {
          // Encrypted empty object also means unassigned -> falls back to localEntry.room ("阳台")
          return replyEncrypted({});
        }
        if (deviceId === "dev_room_api_error") {
          return jsonResponse({ success: false, code: "1108", msg: "uri path invalid" });
        }
      }
      throw new Error(`Unhandled path: ${parsedUrl.pathname}`);
    }) as typeof fetch;

    const provider = new TuyaPlatformProvider({
      httpFetch: mockFetch,
      configStore: mem.store,
      now: () => 1_730_000_000_000,
    });

    const first = await provider.listDevices();
    const byDid = new Map(first.map((d) => [d.did, d]));
    expect(byDid.get("dev_living_light")?.room_name).toBe("客厅");
    expect(byDid.get("dev_bedroom_2g")?.room_name).toBe("卧室");
    expect(byDid.get("dev_bedroom_2g.s1")?.room_name).toBe("卧室");
    expect(byDid.get("dev_bedroom_2g.s2")?.room_name).toBe("卧室");
    expect(byDid.get("dev_unassigned_empty")?.room_name).toBe("默认房间");
    expect(byDid.get("dev_local_room_fallback")?.room_name).toBe("阳台");
    expect(byDid.get("dev_room_api_error")?.room_name).toBe("默认房间");
    expect(roomRequests).toHaveLength(5);

    // Moving a device to another room in Tuya App must reflect on the next sync (no stale room cache)
    livingLightRoom = { id: 80199999, name: "书房" };
    const second = await provider.listDevices();
    const secondByDid = new Map(second.map((d) => [d.did, d]));
    expect(secondByDid.get("dev_living_light")?.room_name).toBe("书房");
  });

  test("Tuya OpenAPI v2.0 resolves home and room names via /v1.0/homes/{homeId}/rooms and room devices", async () => {
    const mem = makeMemoryConfigStore({
      enabled: true,
      mode: "openapi",
      region: "cn",
      accessId: "aid_room",
      accessSecret: "sec_room",
      uid: "uid_room_openapi",
    });

    const mockFetch: typeof fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
      );
      if (url.pathname === "/v1.0/token") {
        return jsonResponse({
          success: true,
          result: {
            access_token: "oa_tok",
            refresh_token: "oa_rt",
            expire_time: 7200,
            uid: "uid_room_openapi",
          },
        });
      }
      if (url.pathname === "/v1.0/users/uid_room_openapi/devices") {
        return jsonResponse({
          success: true,
          result: [
            { id: "oa_dev_1", name: "客厅灯", category: "dj", online: true },
            { id: "oa_dev_2", name: "书房台灯", category: "dj", online: true },
            { id: "oa_dev_3", name: "未分组插座", category: "cz", online: true },
          ],
        });
      }
      if (url.pathname === "/v1.0/users/uid_room_openapi/homes") {
        return jsonResponse({
          success: true,
          result: [
            { home_id: "h_home", name: "我的家" },
            { home_id: "h_studio", name: "工作室" },
          ],
        });
      }
      if (url.pathname === "/v1.0/homes/h_home/rooms") {
        return jsonResponse({
          success: true,
          result: {
            home_id: "h_home",
            name: "我的家",
            rooms: [{ room_id: 101, name: "客厅" }],
          },
        });
      }
      if (url.pathname === "/v1.0/homes/h_studio/rooms") {
        return jsonResponse({
          success: true,
          result: {
            home_id: "h_studio",
            name: "工作室",
            rooms: [{ room_id: 202, name: "书房" }],
          },
        });
      }
      if (url.pathname === "/v1.0/homes/h_home/rooms/101/devices") {
        return jsonResponse({ success: true, result: [{ id: "oa_dev_1" }] });
      }
      if (url.pathname === "/v1.0/homes/h_studio/rooms/202/devices") {
        return jsonResponse({ success: true, result: [{ id: "oa_dev_2" }] });
      }
      if (url.pathname.endsWith("/specifications")) {
        return jsonResponse({ success: true, result: { functions: [], status: [] } });
      }
      throw new Error(`Unexpected OpenAPI path: ${url.pathname}`);
    }) as typeof fetch;

    const provider = new TuyaPlatformProvider({
      httpFetch: mockFetch,
      configStore: mem.store,
    });

    const devices = await provider.listDevices();
    const byDid = new Map(devices.map((d) => [d.did, d]));
    expect(byDid.get("oa_dev_1")?.home_name).toBe("我的家");
    expect(byDid.get("oa_dev_1")?.room_name).toBe("客厅");
    expect(byDid.get("oa_dev_2")?.home_name).toBe("工作室");
    expect(byDid.get("oa_dev_2")?.room_name).toBe("书房");
    expect(byDid.get("oa_dev_3")?.home_name).toBe("我的家");
    expect(byDid.get("oa_dev_3")?.room_name).toBe("默认房间");
  });
});

describe("TuyaSharingClient — Token Refresh CamelCase, Concurrency & Sign-Invalid Recovery", () => {
  test("parses real Tuya camelCase refresh payload (accessToken/refreshToken/expireTime) and persists rotated session", async () => {
    let serverAccess = "at_gen1";
    let serverRefresh = "rt_gen1";
    let refreshCalls = 0;
    const nowMs = 2_000_000_000_000;

    const mem = makeMemoryConfigStore({
      enabled: true,
      mode: "sharing",
      userCode: "UC_CAMEL",
      endpoint: "https://apigw.tuyacn.com",
      tokenSession: {
        accessToken: serverAccess,
        refreshToken: serverRefresh,
        expireTime: nowMs - 10_000, // already expired
        uid: "uid_camel",
        endpoint: "https://apigw.tuyacn.com",
        terminalId: "term_001",
        username: "camel_user",
      },
    });

    const mockFetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
      );
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const rid = headers["X-requestId"]!;
      const hashKey = tuyaSharingHashKey(rid, serverRefresh);
      const secret = tuyaSharingSecret(rid, "", hashKey);
      const queryEnc = url.searchParams.get("encdata") ?? "";
      const expectedSign = tuyaSharingRestfulSign(hashKey, queryEnc, "", headers);
      if (headers["X-sign"] !== expectedSign) {
        return jsonResponse({ success: false, code: "-9999999", msg: "sign invalid", t: nowMs });
      }

      if (url.pathname === `/v1.0/m/token/${serverRefresh}`) {
        refreshCalls += 1;
        expect(headers["X-token"]).toBeUndefined();
        serverAccess = "at_gen2_camel";
        serverRefresh = "rt_gen2_camel";
        // Real Tuya /v1.0/m/token/{refreshToken} returns camelCase fields!
        return jsonResponse({
          success: true,
          t: nowMs,
          result: tuyaSharingAesGcmEncrypt(
            JSON.stringify({
              accessToken: serverAccess,
              refreshToken: serverRefresh,
              expireTime: 7200,
              uid: "uid_camel",
            }),
            secret,
          ),
        });
      }

      expect(headers["X-token"]).toBe(serverAccess);
      if (url.pathname === "/v1.0/m/life/users/homes") {
        return jsonResponse({
          success: true,
          t: nowMs,
          result: tuyaSharingAesGcmEncrypt(
            JSON.stringify([{ ownerId: "h_cn", name: "我的家" }]),
            secret,
          ),
        });
      }
      if (url.pathname === "/v1.0/m/life/ha/home/devices") {
        return jsonResponse({
          success: true,
          t: nowMs,
          result: tuyaSharingAesGcmEncrypt(
            JSON.stringify([
              { id: "dev_cn_1", name: "玄关灯", category: "dj", online: true, roomName: "玄关" },
            ]),
            secret,
          ),
        });
      }
      if (url.pathname.endsWith("/specifications")) {
        return jsonResponse({
          success: true,
          t: nowMs,
          result: tuyaSharingAesGcmEncrypt(JSON.stringify({ functions: [], status: [] }), secret),
        });
      }
      throw new Error(`Unexpected path: ${url.pathname}`);
    }) as typeof fetch;

    const provider = new TuyaPlatformProvider({
      httpFetch: mockFetch,
      configStore: mem.store,
      now: () => nowMs,
    });

    const devices = await provider.listDevices();
    expect(devices).toHaveLength(1);
    expect(devices[0]!.name).toBe("玄关灯");
    expect(refreshCalls).toBe(1);

    // Persisted session must carry rotated camelCase tokens & preserve metadata
    const saved = mem.get().tokenSession;
    expect(saved?.accessToken).toBe("at_gen2_camel");
    expect(saved?.refreshToken).toBe("rt_gen2_camel");
    expect(saved?.expireTime).toBe(nowMs + 7200 * 1000);
    expect(saved?.terminalId).toBe("term_001");
    expect(saved?.username).toBe("camel_user");
  });

  test("coalesces concurrent expired-token requests into a single refresh without sign invalid", async () => {
    let serverAccess = "at_old";
    let serverRefresh = "rt_old";
    let refreshCalls = 0;
    const nowMs = 2_000_000_000_000;

    const mockFetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
      );
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const rid = headers["X-requestId"]!;
      const hashKey = tuyaSharingHashKey(rid, serverRefresh);
      const secret = tuyaSharingSecret(rid, "", hashKey);
      const expectedSign = tuyaSharingRestfulSign(
        hashKey,
        url.searchParams.get("encdata") ?? "",
        "",
        headers,
      );
      if (headers["X-sign"] !== expectedSign) {
        return jsonResponse({ success: false, code: "-9999999", msg: "sign invalid", t: nowMs });
      }

      if (url.pathname === `/v1.0/m/token/${serverRefresh}`) {
        refreshCalls += 1;
        await new Promise((r) => setTimeout(r, 15));
        serverAccess = "at_rotated";
        serverRefresh = "rt_rotated";
        return jsonResponse({
          success: true,
          t: nowMs,
          result: tuyaSharingAesGcmEncrypt(
            JSON.stringify({
              accessToken: serverAccess,
              refreshToken: serverRefresh,
              expireTime: 7200,
              uid: "uid_conc",
            }),
            secret,
          ),
        });
      }

      if (headers["X-token"] !== serverAccess) {
        return jsonResponse({ success: false, code: "-9999999", msg: "sign invalid", t: nowMs });
      }
      return jsonResponse({
        success: true,
        t: nowMs,
        result: tuyaSharingAesGcmEncrypt(JSON.stringify([{ ownerId: "h1", name: "Home" }]), secret),
      });
    }) as typeof fetch;

    const client = new TuyaSharingClient({
      httpFetch: mockFetch,
      now: () => nowMs,
      tokenSession: {
        accessToken: serverAccess,
        refreshToken: serverRefresh,
        expireTime: nowMs - 1000,
        uid: "uid_conc",
        endpoint: "https://apigw.tuyacn.com",
      },
    });

    const all = await Promise.all(Array.from({ length: 6 }, () => client.queryHomes()));
    expect(refreshCalls).toBe(1);
    for (const homes of all) {
      expect(homes).toEqual([{ ownerId: "h1", name: "Home" }]);
    }
  });

  test("recovers from concurrent -9999999 sign invalid without double-rotating refreshToken", async () => {
    let serverAccess = "at_early_revoked";
    let serverRefresh = "rt_v1";
    let refreshCalls = 0;
    const nowMs = 2_000_000_000_000;

    const mockFetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
      );
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const rid = headers["X-requestId"]!;
      const hashKey = tuyaSharingHashKey(rid, serverRefresh);
      const secret = tuyaSharingSecret(rid, "", hashKey);

      if (url.pathname.startsWith("/v1.0/m/token/")) {
        const expectedSign = tuyaSharingRestfulSign(hashKey, "", "", headers);
        expect(headers["X-sign"]).toBe(expectedSign);
        refreshCalls += 1;
        await new Promise((r) => setTimeout(r, 15));
        serverAccess = `at_v${refreshCalls + 1}`;
        serverRefresh = `rt_v${refreshCalls + 1}`;
        return jsonResponse({
          success: true,
          t: nowMs,
          result: tuyaSharingAesGcmEncrypt(
            JSON.stringify({
              accessToken: serverAccess,
              refreshToken: serverRefresh,
              expireTime: 7200,
              uid: "uid_race",
            }),
            secret,
          ),
        });
      }

      // Simulate server rejecting old accessToken with -9999999 sign invalid
      if (headers["X-token"] !== serverAccess || serverAccess === "at_early_revoked") {
        // Stagger one response slightly so it enters catch AFTER refresh already finished
        await new Promise((r) => setTimeout(r, 25));
        return jsonResponse({ success: false, code: "-9999999", msg: "sign invalid", t: nowMs });
      }
      const expectedSign = tuyaSharingRestfulSign(hashKey, "", "", headers);
      expect(headers["X-sign"]).toBe(expectedSign);
      return jsonResponse({
        success: true,
        t: nowMs,
        result: tuyaSharingAesGcmEncrypt(JSON.stringify([{ ownerId: "h_ok", name: "恢复成功" }]), secret),
      });
    }) as typeof fetch;

    const client = new TuyaSharingClient({
      httpFetch: mockFetch,
      now: () => nowMs,
      tokenSession: {
        accessToken: serverAccess,
        refreshToken: serverRefresh,
        expireTime: nowMs + 3600_000, // locally looks valid, server rejects early with -9999999
        uid: "uid_race",
        endpoint: "https://apigw.tuyacn.com",
      },
    });

    const results = await Promise.all([
      client.queryHomes(),
      client.queryHomes(),
      client.queryHomes(),
      client.queryHomes(),
    ]);
    expect(refreshCalls).toBe(1);
    expect(client.tokenSession?.accessToken).toBe("at_v2");
    expect(client.tokenSession?.refreshToken).toBe("rt_v2");
    for (const r of results) {
      expect(r).toEqual([{ ownerId: "h_ok", name: "恢复成功" }]);
    }
  });

  test("falls back to sending X-token on refresh if gateway rejects X-token-less refresh with sign invalid", async () => {
    let refreshAttempts = 0;
    const nowMs = 2_000_000_000_000;

    const mockFetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
      );
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const rid = headers["X-requestId"]!;

      if (url.pathname === "/v1.0/m/token/rt_strict") {
        refreshAttempts += 1;
        const hashKey = tuyaSharingHashKey(rid, "rt_strict");
        const secret = tuyaSharingSecret(rid, "", hashKey);
        expect(headers["X-sign"]).toBe(tuyaSharingRestfulSign(hashKey, "", "", headers));
        if (!headers["X-token"]) {
          return jsonResponse({ success: false, code: "-9999999", msg: "sign invalid", t: nowMs });
        }
        expect(headers["X-token"]).toBe("at_strict_old");
        return jsonResponse({
          success: true,
          t: nowMs,
          result: tuyaSharingAesGcmEncrypt(
            JSON.stringify({
              accessToken: "at_strict_new",
              refreshToken: "rt_strict_new",
              expireTime: 7200,
              uid: "uid_strict",
            }),
            secret,
          ),
        });
      }

      const hashKey = tuyaSharingHashKey(rid, "rt_strict_new");
      const secret = tuyaSharingSecret(rid, "", hashKey);
      expect(headers["X-token"]).toBe("at_strict_new");
      return jsonResponse({
        success: true,
        t: nowMs,
        result: tuyaSharingAesGcmEncrypt(JSON.stringify([{ ownerId: "h_s", name: "Strict" }]), secret),
      });
    }) as typeof fetch;

    const client = new TuyaSharingClient({
      httpFetch: mockFetch,
      now: () => nowMs,
      tokenSession: {
        accessToken: "at_strict_old",
        refreshToken: "rt_strict",
        expireTime: nowMs - 1000,
        uid: "uid_strict",
        endpoint: "https://apigw.tuyacn.com",
      },
    });

    const homes = await client.queryHomes();
    expect(refreshAttempts).toBe(2);
    expect(homes).toEqual([{ ownerId: "h_s", name: "Strict" }]);
    expect(client.tokenSession?.accessToken).toBe("at_strict_new");
  });

  test("throttles failed proactive refresh during cooldown while keeping requests working with still-valid token", async () => {
    let nowMs = 2_000_000_000_000;
    let refreshCalls = 0;
    let failRefresh = true;
    let currentRefresh = "rt_cool_1";
    let currentAccess = "at_cool_1";

    const mockFetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
      );
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const rid = headers["X-requestId"]!;
      const hashKey = tuyaSharingHashKey(rid, currentRefresh);
      const secret = tuyaSharingSecret(rid, "", hashKey);

      if (url.pathname.startsWith("/v1.0/m/token/")) {
        refreshCalls += 1;
        if (failRefresh) {
          return jsonResponse({
            success: false,
            code: "API_QPS_LIMIT_OR_DEGRADE",
            msg: "rate limited",
            t: nowMs,
          });
        }
        currentAccess = "at_cool_2";
        currentRefresh = "rt_cool_2";
        return jsonResponse({
          success: true,
          t: nowMs,
          result: tuyaSharingAesGcmEncrypt(
            JSON.stringify({
              accessToken: currentAccess,
              refreshToken: currentRefresh,
              expireTime: 7200,
              uid: "uid_cool",
            }),
            secret,
          ),
        });
      }

      expect(headers["X-token"]).toBe(currentAccess);
      return jsonResponse({
        success: true,
        t: nowMs,
        result: tuyaSharingAesGcmEncrypt(JSON.stringify([{ ownerId: "h_c", name: "Cool" }]), secret),
      });
    }) as typeof fetch;

    const client = new TuyaSharingClient({
      httpFetch: mockFetch,
      now: () => nowMs,
      tokenSession: {
        accessToken: currentAccess,
        refreshToken: currentRefresh,
        expireTime: nowMs + 2 * 60_000, // within 5-min proactive window, but NOT hard-expired
        uid: "uid_cool",
        endpoint: "https://apigw.tuyacn.com",
      },
    });

    // 4 calls inside the 60s cooldown must only trigger 1 refresh attempt and all succeed!
    for (let i = 0; i < 4; i += 1) {
      expect(await client.queryHomes()).toEqual([{ ownerId: "h_c", name: "Cool" }]);
    }
    expect(refreshCalls).toBe(1);

    // After 60s cooldown passes and rate limit clears, next call refreshes cleanly
    nowMs += 61_000;
    failRefresh = false;
    expect(await client.queryHomes()).toEqual([{ ownerId: "h_c", name: "Cool" }]);
    expect(refreshCalls).toBe(2);
    expect(client.tokenSession?.accessToken).toBe("at_cool_2");
  });

  test("auto-calibrates X-time clock offset on 1013 request time invalid and retries once", async () => {
    const localNowMs = 2_000_000_000_000;
    const serverNowMs = localNowMs + 600_000; // PC clock is 10 minutes behind
    const seenTimestamps: number[] = [];

    const mockFetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const rid = headers["X-requestId"]!;
      const sentTime = Number(headers["X-time"]);
      seenTimestamps.push(sentTime);
      const hashKey = tuyaSharingHashKey(rid, "rt_clock");
      const secret = tuyaSharingSecret(rid, "", hashKey);
      expect(headers["X-sign"]).toBe(tuyaSharingRestfulSign(hashKey, "", "", headers));

      if (Math.abs(sentTime - serverNowMs) > 60_000) {
        return jsonResponse({
          success: false,
          code: "1013",
          msg: "request time is invalid",
          t: serverNowMs,
        });
      }
      return jsonResponse({
        success: true,
        t: serverNowMs,
        result: tuyaSharingAesGcmEncrypt(
          JSON.stringify([{ ownerId: "h_clk", name: "校准时钟" }]),
          secret,
        ),
      });
    }) as typeof fetch;

    const client = new TuyaSharingClient({
      httpFetch: mockFetch,
      now: () => localNowMs,
      tokenSession: {
        accessToken: "at_clock",
        refreshToken: "rt_clock",
        expireTime: localNowMs + 3600_000,
        uid: "uid_clock",
        endpoint: "https://apigw.tuyacn.com",
      },
    });

    const homes = await client.queryHomes();
    expect(homes).toEqual([{ ownerId: "h_clk", name: "校准时钟" }]);
    expect(seenTimestamps).toEqual([localNowMs, serverNowMs]);
  });

  test("provider surfaces clear Chinese re-auth message when refreshToken is permanently revoked", async () => {
    const nowMs = 2_000_000_000_000;
    const mem = makeMemoryConfigStore({
      enabled: true,
      mode: "sharing",
      userCode: "UC_DEAD",
      tokenSession: {
        accessToken: "at_dead_secret",
        refreshToken: "rt_dead_secret",
        expireTime: nowMs - 10_000,
        uid: "uid_dead",
        endpoint: "https://apigw.tuyacn.com",
      },
    });

    let callCount = 0;
    const mockFetch: typeof fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) => {
      callCount += 1;
      return jsonResponse({ success: false, code: "-9999999", msg: "sign invalid", t: nowMs });
    }) as typeof fetch;

    const provider = new TuyaPlatformProvider({
      httpFetch: mockFetch,
      configStore: mem.store,
      now: () => nowMs,
    });

    await expect(provider.listDevices()).rejects.toThrow(/涂鸦登录授权已失效.*重新扫码授权/);
    // Primary refresh (no X-token) + single fallback (with X-token) = 2 bounded calls, no infinite loop
    expect(callCount).toBe(2);
    expect(provider.status().lastError).toContain("重新扫码授权");
    expect(provider.status().lastError).not.toContain("rt_dead_secret");
  });

  test("configure() on unrelated fields preserves active sharing session and disconnect() blocks stale in-flight refresh writes", async () => {
    const nowMs = 2_000_000_000_000;
    const mem = makeMemoryConfigStore({
      enabled: true,
      mode: "sharing",
      userCode: "UC_LIFE",
      tokenSession: {
        accessToken: "at_life_1",
        refreshToken: "rt_life_1",
        expireTime: nowMs - 10_000,
        uid: "uid_life",
        endpoint: "https://apigw.tuyacn.com",
      },
    });

    let releaseRefresh!: () => void;
    const refreshStarted = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    let allowRefreshComplete!: () => void;
    const waitRefresh = new Promise<void>((resolve) => {
      allowRefreshComplete = resolve;
    });

    const mockFetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
      );
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const rid = headers["X-requestId"]!;
      const hashKey = tuyaSharingHashKey(rid, "rt_life_1");
      const secret = tuyaSharingSecret(rid, "", hashKey);
      if (url.pathname.startsWith("/v1.0/m/token/")) {
        releaseRefresh();
        await waitRefresh;
        return jsonResponse({
          success: true,
          t: nowMs,
          result: tuyaSharingAesGcmEncrypt(
            JSON.stringify({
              accessToken: "at_life_stale_new",
              refreshToken: "rt_life_stale_new",
              expireTime: 7200,
              uid: "uid_life",
            }),
            secret,
          ),
        });
      }
      throw new Error(`Unexpected path: ${url.pathname}`);
    }) as typeof fetch;

    const provider = new TuyaPlatformProvider({
      httpFetch: mockFetch,
      configStore: mem.store,
      now: () => nowMs,
    });

    // Updating preferLocal must preserve tokenSession without wiping it
    await provider.configure({ preferLocal: false });
    expect(mem.get().tokenSession?.refreshToken).toBe("rt_life_1");

    // Start listDevices() which kicks off an in-flight token refresh, then disconnect mid-flight
    const pendingList = provider.listDevices().catch(() => null);
    await refreshStarted;
    await provider.disconnect();
    allowRefreshComplete();
    await pendingList;

    // Disconnected session must NEVER be resurrected by the stale in-flight refresh callback
    expect(mem.get().tokenSession).toBeNull();
    expect(provider.isConnected()).toBe(false);
  });
});
