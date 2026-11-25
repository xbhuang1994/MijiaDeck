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
});
