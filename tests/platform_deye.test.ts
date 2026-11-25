// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 德业智能 (Deye Smart Cloud Classic/Fog/Combo + Solarman V5) 单元测试与集成测试

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { mkdtempSync, rmSync } from "node:fs";
import * as net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { supportsCardPower, trayEligible } from "../src/core/deviceControls.ts";
import { setDataPathOverrides } from "../src/core/jsonStore.ts";
import { ServiceError } from "../src/core/service.ts";
import {
  DeyeCloudApiInvalidAuthError,
  DeyeCloudClient,
  DeyeClassicMqttClient,
  DeyeDeviceCommandFlag,
  DeyeDeviceMode,
  DeyeDeviceStateFlag,
  DeyeDeviceTransport,
  DeyeFanSpeed,
  DeyeFogComboCommand,
  DeyeIotPlatform,
  DeyePlatformProvider,
  DEYE_PLATFORM_METADATA,
  DEYE_SOLARMAN_REGISTERS,
  FOG_PROTOCOL_V0_COMPANIONS,
  SOLARMAN_V5_CONTROL_HEARTBEAT,
  SOLARMAN_V5_CONTROL_REQUEST,
  SOLARMAN_V5_END,
  SOLARMAN_V5_START,
  SolarmanV5Error,
  buildModbusReadHoldingResponse,
  buildSolarmanV5ReadHoldingFrame,
  buildSolarmanV5ResponseFrame,
  crc16Modbus,
  decodeConnackPacket,
  decodeJwtPayload,
  decodePublishPacket,
  decodeRemainingLength,
  decodeSubackPacket,
  encodeClassicCommand,
  encodeConnectPacket,
  encodeDisconnectPacket,
  encodeFogComboFrame,
  encodeFogCommand,
  encodePingreqPacket,
  encodePublishPacket,
  encodeRemainingLength,
  encodeSubscribePacket,
  fogComboFramesFromProperties,
  getProductFeatureConfig,
  parseClassicStateHex,
  parseFogState,
  parseSolarmanV5Response,
  queryInverterTelemetry,
  resolveFogCommandPayloads,
  solarmanV5Checksum,
  stateToCommand,
  transportForDevice,
  tryExtractMqttPacket,
  type DeyeClassicMqttInfo,
  type DeyeCloudDeviceInfo,
  type DeyeInverterTelemetry,
  type IDeyeClassicMqttTransport,
  type ISolarmanTransport,
} from "../src/platforms/deye/index.ts";

function makeFakeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.fake_signature`;
}

function makeClassicStateHex(opts: {
  flag: number;
  fanSpeed: DeyeFanSpeed;
  mode: DeyeDeviceMode;
  targetHumidity: number;
  coilTempC: number;
  envTempC: number;
  envHumidity: number;
  exhaustTempC: number;
}): string {
  const bytes = new Uint8Array(20);
  bytes[0] = 0x14;
  bytes[1] = 0x02;
  bytes[2] = (opts.flag >>> 8) & 0xff;
  bytes[3] = opts.flag & 0xff;
  bytes[4] = ((opts.fanSpeed & 0x0f) << 4) | (opts.mode & 0x0f);
  bytes[5] = opts.targetHumidity & 0xff;
  bytes[14] = (opts.coilTempC + 40) & 0xff;
  bytes[15] = (opts.envTempC + 40) & 0xff;
  bytes[16] = opts.envHumidity & 0xff;
  bytes[17] = (opts.exhaustTempC + 40) & 0xff;
  return Buffer.from(bytes).toString("hex");
}

function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Deye Protocol: Classic Binary State & Command Codec", () => {
  test("parses Classic 18+ byte hex state with exact bit flags and -40 temperature offsets", () => {
    const flag =
      DeyeDeviceStateFlag.ANION_SWITCH |
      DeyeDeviceStateFlag.POWER_SWITCH |
      DeyeDeviceStateFlag.CHILD_LOCK_SWITCH |
      DeyeDeviceStateFlag.WATER_TANK_FULL_STATE |
      DeyeDeviceStateFlag.FAN_RUNNING_STATE;

    const hex = makeClassicStateHex({
      flag,
      fanSpeed: DeyeFanSpeed.HIGH,
      mode: DeyeDeviceMode.CLOTHES_DRYER_MODE,
      targetHumidity: 50,
      coilTempC: 12,
      envTempC: 26,
      envHumidity: 63,
      exhaustTempC: 48,
    });

    const state = parseClassicStateHex(hex);
    expect(state.anionSwitch).toBe(true);
    expect(state.waterPumpSwitch).toBe(false);
    expect(state.powerSwitch).toBe(true);
    expect(state.oscillatingSwitch).toBe(false);
    expect(state.childLockSwitch).toBe(true);
    expect(state.defrosting).toBe(false);
    expect(state.waterTankFull).toBe(true);
    expect(state.fanRunning).toBe(true);
    expect(state.fanSpeed).toBe(DeyeFanSpeed.HIGH);
    expect(state.mode).toBe(DeyeDeviceMode.CLOTHES_DRYER_MODE);
    expect(state.targetHumidity).toBe(50);
    expect(state.coilTemperature).toBe(12);
    expect(state.environmentTemperature).toBe(26);
    expect(state.environmentHumidity).toBe(63);
    expect(state.exhaustTemperature).toBe(48);
  });

  test("encodes Classic 10-byte command and Combo 4-byte frames with exact bitmasks", () => {
    const encoded = encodeClassicCommand({
      powerSwitch: true,
      oscillatingSwitch: true,
      childLockSwitch: false,
      waterPumpSwitch: true,
      anionSwitch: true,
      fanSpeed: DeyeFanSpeed.MIDDLE,
      mode: DeyeDeviceMode.AUTO_MODE,
      targetHumidity: 55,
      timedOffHour: 4,
    });

    expect(encoded.length).toBe(10);
    expect(encoded[0]).toBe(0x08);
    expect(encoded[1]).toBe(0x02);
    const expectedFlag =
      DeyeDeviceCommandFlag.POWER_SWITCH |
      DeyeDeviceCommandFlag.OSCILLATING_SWITCH |
      DeyeDeviceCommandFlag.WATER_PUMP_SWITCH |
      DeyeDeviceCommandFlag.ANION_SWITCH;
    expect(encoded[2]).toBe(expectedFlag);
    expect(encoded[3]).toBe((DeyeFanSpeed.MIDDLE << 4) | DeyeDeviceMode.AUTO_MODE);
    expect(encoded[4]).toBe(55);
    expect(encoded[5]).toBe(4);
    expect([...encoded.subarray(6)]).toEqual([0, 0, 0, 0]);

    // Combo 帧编码验证
    const comboFrames = fogComboFramesFromProperties({
      Power: 1,
      SetHumidity: 45,
      Mode: DeyeDeviceMode.SLEEP_MODE,
    });
    expect(comboFrames).toEqual([
      encodeFogComboFrame(DeyeFogComboCommand.POWER, 1),
      encodeFogComboFrame(DeyeFogComboCommand.HUMIDITY_OR_TEMP, 45),
      encodeFogComboFrame(DeyeFogComboCommand.MODE, DeyeDeviceMode.SLEEP_MODE),
    ]);
    expect([...comboFrames[0]!]).toEqual([2, 17, 1, 1]);
  });
});

describe("Deye Protocol: Fog State, ProtocolVersion 0 Companions & Transport Routing", () => {
  test("parses Fog JSON properties including TimedShutdownHourSetting alias and optional switches", () => {
    const state = parseFogState({
      Power: 1,
      Mode: 3,
      WindSpeed: 2,
      SetHumidity: 48,
      CurrentAmbientTemperature: 24,
      CurrentEnvironmentalHumidity: 59,
      NegativeIon: 1,
      WaterPump: 0,
      SwingingWind: 1,
      KeyLock: 0,
      Demisting: 1,
      WaterTank: 0,
      Fan: 1,
      UV: 1,
      PromptSound: 1,
      Screendisplay: 0,
      TimedShutdownHourSetting: 6,
      CurrentCoilTemperature: 14,
      CurrentExhaustTemperature: 39,
      ProtocolVersion: 0,
    });

    expect(state.powerSwitch).toBe(true);
    expect(state.mode).toBe(DeyeDeviceMode.AUTO_MODE);
    expect(state.fanSpeed).toBe(DeyeFanSpeed.MIDDLE);
    expect(state.targetHumidity).toBe(48);
    expect(state.environmentTemperature).toBe(24);
    expect(state.environmentHumidity).toBe(59);
    expect(state.anionSwitch).toBe(true);
    expect(state.waterPumpSwitch).toBe(false);
    expect(state.oscillatingSwitch).toBe(true);
    expect(state.childLockSwitch).toBe(false);
    expect(state.defrosting).toBe(true);
    expect(state.waterTankFull).toBe(false);
    expect(state.fanRunning).toBe(true);
    expect(state.uvSwitch).toBe(true);
    expect(state.promptSound).toBe(true);
    expect(state.screenDisplay).toBe(false);
    expect(state.timedOffHour).toBe(6);
    expect(state.protocolVersion).toBe(0);
  });

  test("encodes Fog commands honoring ProtocolVersion === 0 companion snapshot vs delta mode", () => {
    const fogV0Raw = {
      Power: 1,
      Mode: 0,
      WindSpeed: 1,
      SetHumidity: 55,
      NegativeIon: 1,
      WaterPump: 0,
      SwingingWind: 1,
      KeyLock: 0,
      UV: 1,
      TimedShutdownHourSetting: 3,
      ProtocolVersion: 0,
    };
    const baseline = parseFogState(fogV0Raw);
    const nextCmd = { ...stateToCommand(baseline), powerSwitch: false };

    // ProtocolVersion 0: Power 必须附带 FOG_PROTOCOL_V0_COMPANIONS.Power，且不包含 SwingingWind
    const v0Payload = encodeFogCommand(nextCmd, baseline, 0, fogV0Raw);
    expect(v0Payload["Power"]).toBe(0);
    expect(v0Payload["SetHumidity"]).toBe(55);
    expect(v0Payload["Mode"]).toBe(0);
    expect(v0Payload["WindSpeed"]).toBe(1);
    expect(v0Payload["NegativeIon"]).toBe(1);
    expect(v0Payload["KeyLock"]).toBe(0);
    expect(v0Payload["UV"]).toBe(1);
    expect(v0Payload["TimedOffHour"]).toBe(3);
    expect("SwingingWind" in v0Payload).toBe(false);
    expect(FOG_PROTOCOL_V0_COMPANIONS["Power"]!.has("SwingingWind")).toBe(false);

    // ProtocolVersion 1+: 仅发送增量变更键
    const v1Payload = encodeFogCommand(nextCmd, baseline, 1, fogV0Raw);
    expect(v1Payload).toEqual({ Power: 0 });

    // 多键同时变更在 ProtocolVersion === 0 下按官方顺序拆分为独立 POST
    const multiCmd = { ...stateToCommand(baseline), mode: DeyeDeviceMode.CLOTHES_DRYER_MODE, targetHumidity: 45 };
    const multiPayloads = resolveFogCommandPayloads(multiCmd, {
      baseline,
      protocolVersion: 0,
      lastProperties: fogV0Raw,
    });
    expect(multiPayloads.length).toBe(2);
    expect(multiPayloads[0]!["Mode"]).toBe(DeyeDeviceMode.CLOTHES_DRYER_MODE);
    expect(multiPayloads[0]!["SwingingWind"]).toBe(1); // Mode 伴随键包含 SwingingWind
    expect(multiPayloads[1]!["SetHumidity"]).toBe(45);
  });

  test("classifies Classic, Fog, FogCombo, and Combo transports accurately", () => {
    expect(
      transportForDevice({
        platform: DeyeIotPlatform.Classic,
        is_combo: false,
        protocol_version: "V1.0",
      }),
    ).toBe(DeyeDeviceTransport.CLASSIC);

    expect(
      transportForDevice({
        platform: DeyeIotPlatform.Fog,
        is_combo: false,
        protocol_version: "",
      }),
    ).toBe(DeyeDeviceTransport.FOG);

    // 关键验证：platform === 3 (FogCombo) 走 Fog HTTP，而非 Combo MQTT！
    expect(
      transportForDevice({
        platform: DeyeIotPlatform.FogCombo,
        is_combo: true,
        protocol_version: "combo_V1.0",
      }),
    ).toBe(DeyeDeviceTransport.FOG);

    // 仅 Classic 平台 + is_combo + combo_V1.0 走 COMBO
    expect(
      transportForDevice({
        platform: DeyeIotPlatform.Classic,
        is_combo: true,
        protocol_version: "combo_V1.0",
      }),
    ).toBe(DeyeDeviceTransport.COMBO);

    expect(
      transportForDevice({
        platform: DeyeIotPlatform.Classic,
        is_combo: true,
        protocol_version: "V2.0",
      }),
    ).toBe(DeyeDeviceTransport.CLASSIC);

    // 产品能力表与未知产品兜底验证
    const p40 = getProductFeatureConfig("d71936c6951c11f0a8200242ac480009");
    expect(p40.uv).toBe(true);
    expect(p40.oscillating).toBe(true);
    expect(p40.min_target_humidity).toBe(40);
    expect(p40.max_target_humidity).toBe(70);

    const fallback = getProductFeatureConfig("unknown-product-id-xyz");
    expect(fallback.min_target_humidity).toBe(25);
    expect(fallback.max_target_humidity).toBe(80);
    expect(fallback.anion).toBe(true);
  });
});

describe("Deye Cloud Client: JWT Decode, Expiry Detection & Auto-Refresh", () => {
  test("decodes JWT payload, refreshes near-expiry token, and falls back to login on refresh failure", async () => {
    const baseNowMs = 1_750_000_000_000;
    const nowSec = Math.floor(baseNowMs / 1000);

    const nearExpiryJwt = makeFakeJwt({ enduserid: "uid-deye-001", exp: nowSec + 3600 });
    const freshJwt = makeFakeJwt({ enduserid: "uid-deye-001", exp: nowSec + 7 * 86400 });
    const reloginJwt = makeFakeJwt({ enduserid: "uid-deye-001", exp: nowSec + 14 * 86400 });

    const decoded = decodeJwtPayload(nearExpiryJwt);
    expect(decoded.enduserid).toBe("uid-deye-001");
    expect(decoded.exp).toBe(nowSec + 3600);
    expect(() => decodeJwtPayload("not-a-jwt")).toThrow(DeyeCloudApiInvalidAuthError);

    const calls: Array<{ url: string; auth: string | null }> = [];
    let failRefresh = false;

    const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const headers = new Headers(init?.headers);
      calls.push({ url, auth: headers.get("Authorization") });

      if (url.endsWith("/refreshToken/")) {
        if (failRefresh) {
          return makeJsonResponse({ meta: { code: 401, message: "expired" }, data: null });
        }
        return makeJsonResponse({ meta: { code: 0, message: "ok" }, data: { token: freshJwt } });
      }
      if (url.endsWith("/login/")) {
        return makeJsonResponse({ meta: { code: 0, message: "ok" }, data: { token: reloginJwt } });
      }
      if (url.includes("/deviceList/")) {
        return makeJsonResponse({ meta: { code: 0, message: "ok" }, data: [] });
      }
      return makeJsonResponse({ meta: { code: 404, message: "not found" }, data: null }, 404);
    }) as typeof fetch;

    const refreshedTokens: string[] = [];
    const client = new DeyeCloudClient({
      username: "13800138000",
      password: "super-secret-password",
      authToken: nearExpiryJwt,
      httpFetch: mockFetch,
      nowMs: () => baseNowMs,
      onAuthTokenRefreshed: (tok) => refreshedTokens.push(tok),
    });

    expect(client.isTokenNearExpiry()).toBe(true);
    await client.getDeviceList();

    // 自动调用 refreshToken 并以新 JWT 访问 deviceList
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.deye.com.cn/v3/enduser/refreshToken/",
      "https://api.deye.com.cn/v3/enduser/deviceList/?app=new",
    ]);
    expect(calls[1]!.auth).toBe(`JWT ${freshJwt}`);
    expect(refreshedTokens).toEqual([freshJwt]);
    expect(client.isTokenNearExpiry()).toBe(false);

    // 刷新被拒时自动回退使用账号密码重新登录
    failRefresh = true;
    await client.refreshTokenIfNearExpiry(true);
    expect(client.authToken).toBe(reloginJwt);
    expect(refreshedTokens).toEqual([freshJwt, reloginJwt]);
  });
});

describe("Deye Lightweight MQTT 3.1.1 Codec & Classic Loopback Client", () => {
  test("round-trips MQTT 3.1.1 Remaining Length, CONNECT, CONNACK, SUBSCRIBE, PUBLISH, PINGREQ", () => {
    for (const val of [0, 1, 127, 128, 16_383, 16_384, 2_097_151, 2_097_152]) {
      const enc = encodeRemainingLength(val);
      const dec = decodeRemainingLength(enc, 0);
      expect(dec).toEqual({ value: val, bytesRead: enc.length });
    }

    const connectPkt = encodeConnectPacket({
      clientId: "deye-client-1",
      username: "user1",
      password: "pw1",
      keepAliveSec: 45,
    });
    expect(connectPkt[0]).toBe(0x10);
    expect(Buffer.from(connectPkt).toString("utf8")).toContain("MQTT");
    expect(Buffer.from(connectPkt).toString("utf8")).toContain("deye-client-1");

    const connack = decodeConnackPacket(new Uint8Array([0x20, 0x02, 0x01, 0x00]));
    expect(connack).toEqual({ sessionPresent: true, returnCode: 0 });

    const subPkt = encodeSubscribePacket(42, "deye/prod/dev/status/hex", 1);
    expect(subPkt[0]).toBe(0x82);
    const suback = decodeSubackPacket(new Uint8Array([0x90, 0x03, 0x00, 42, 0x01]));
    expect(suback).toEqual({ packetId: 42, returnCodes: [1] });

    const payloadBytes = new Uint8Array([0x08, 0x02, 0x01, 0x10, 0x32, 0x00, 0x00, 0x00, 0x00, 0x00]);
    const pubQos1 = encodePublishPacket("deye/p1/d1/command/hex", payloadBytes, {
      qos: 1,
      retain: true,
      packetId: 7,
    });
    const decodedPub = decodePublishPacket(pubQos1);
    expect(decodedPub.topic).toBe("deye/p1/d1/command/hex");
    expect(decodedPub.qos).toBe(1);
    expect(decodedPub.retain).toBe(true);
    expect(decodedPub.packetId).toBe(7);
    expect([...decodedPub.payload]).toEqual([...payloadBytes]);

    expect([...encodePingreqPacket()]).toEqual([0xc0, 0x00]);
    expect([...encodeDisconnectPacket()]).toEqual([0xe0, 0x00]);

    // 流式分片重组验证
    const combined = Buffer.concat([pubQos1, encodePingreqPacket()]);
    const first = tryExtractMqttPacket(new Uint8Array(combined));
    expect(first).not.toBeNull();
    expect(first!.packet.length).toBe(pubQos1.length);
    const second = tryExtractMqttPacket(first!.rest);
    expect(second).not.toBeNull();
    expect([...second!.packet]).toEqual([0xc0, 0x00]);
    expect(second!.rest.length).toBe(0);
  });

  test("queries Classic device state and publishes command over real loopback TCP MQTT broker", async () => {
    const stateHex = makeClassicStateHex({
      flag: DeyeDeviceStateFlag.POWER_SWITCH | DeyeDeviceStateFlag.ANION_SWITCH,
      fanSpeed: DeyeFanSpeed.LOW,
      mode: DeyeDeviceMode.MANUAL_MODE,
      targetHumidity: 52,
      coilTempC: 15,
      envTempC: 23,
      envHumidity: 61,
      exhaustTempC: 36,
    });

    const receivedPublishes: Array<{ topic: string; payloadHex: string }> = [];

    const server = net.createServer((socket) => {
      let buf: Uint8Array = new Uint8Array(0);
      socket.on("data", (chunk: Buffer | string) => {
        const chunkBytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        const merged = new Uint8Array(buf.length + chunkBytes.length);
        merged.set(buf, 0);
        merged.set(new Uint8Array(chunkBytes), buf.length);
        buf = merged;

        while (true) {
          const extracted = tryExtractMqttPacket(buf);
          if (!extracted) break;
          buf = extracted.rest;
          const pkt = extracted.packet;
          const type = (pkt[0]! >> 4) & 0x0f;

          if (type === 1) {
            // CONNECT -> CONNACK
            socket.write(new Uint8Array([0x20, 0x02, 0x00, 0x00]));
          } else if (type === 8) {
            // SUBSCRIBE -> SUBACK
            const lenInfo = decodeRemainingLength(pkt, 1)!;
            const pidOffset = 1 + lenInfo.bytesRead;
            socket.write(new Uint8Array([0x90, 0x03, pkt[pidOffset]!, pkt[pidOffset + 1]!, 0x00]));
          } else if (type === 3) {
            // PUBLISH
            const pub = decodePublishPacket(pkt);
            const hex = Buffer.from(pub.payload).toString("hex");
            receivedPublishes.push({ topic: pub.topic, payloadHex: hex });
            if (hex === "0001") {
              const statusTopic = pub.topic.replace(/\/command\/hex$/, "/status/hex");
              socket.write(
                encodePublishPacket(statusTopic, JSON.stringify({ data: stateHex }), { qos: 0 }),
              );
            }
          } else if (type === 14) {
            // DISCONNECT
            socket.end();
          }
        }
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address() as net.AddressInfo;

    try {
      const mqttInfo: DeyeClassicMqttInfo = {
        mqtthost: "127.0.0.1",
        mqttport: addr.port,
        sslport: 0,
        clientid: "test-classic-client",
        loginname: "deye-user",
        password: "deye-mqtt-password",
        endpoint: "deye",
      };

      const client = new DeyeClassicMqttClient({ timeoutMs: 3_000 });
      const state = await client.queryDeviceState(mqttInfo, "prod123", "dev456", { useTls: false });
      expect(state.powerSwitch).toBe(true);
      expect(state.anionSwitch).toBe(true);
      expect(state.targetHumidity).toBe(52);
      expect(state.environmentTemperature).toBe(23);
      expect(state.environmentHumidity).toBe(61);

      const cmdBytes = encodeClassicCommand({
        powerSwitch: false,
        fanSpeed: DeyeFanSpeed.HIGH,
        mode: DeyeDeviceMode.SLEEP_MODE,
        targetHumidity: 60,
      });
      await client.publishCommand(mqttInfo, "prod123", "dev456", [cmdBytes], { useTls: false });
      expect(receivedPublishes.length).toBe(2);
      expect(receivedPublishes[0]!.topic).toBe("deye/prod123/dev456/command/hex");
      expect(receivedPublishes[0]!.payloadHex).toBe("0001");
      expect(receivedPublishes[1]!.payloadHex).toBe(Buffer.from(cmdBytes).toString("hex"));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("Solarman V5 Protocol: Frame Builder, CRC16, Parser & Loopback TCP Inverter", () => {
  test("computes exact Modbus CRC16, builds Solarman V5 frames, and validates/rejects responses", () => {
    // 已知标准 Modbus RTU 向量：slave=1, func=3, start=0, count=10 -> CRC16 = 0xCDC5
    const sample = new Uint8Array([0x01, 0x03, 0x00, 0x00, 0x00, 0x0a]);
    expect(crc16Modbus(sample)).toBe(0xcdc5);

    const serial = 2712345678;
    const req = buildSolarmanV5ReadHoldingFrame(serial, 1, 0x00b8, 4, 0x05);
    expect(req.length).toBe(36);
    expect(req[0]).toBe(SOLARMAN_V5_START);
    expect(req[req.length - 1]).toBe(SOLARMAN_V5_END);

    const dv = new DataView(req.buffer, req.byteOffset, req.byteLength);
    expect(dv.getUint16(1, true)).toBe(23); // 15 + 8
    expect(dv.getUint16(3, true)).toBe(SOLARMAN_V5_CONTROL_REQUEST);
    expect(dv.getUint16(5, true)).toBe(0x05);
    expect(dv.getUint32(7, true)).toBe(serial);
    expect(req[11]).toBe(0x02);
    expect(req[34]).toBe(solarmanV5Checksum(req.subarray(1, 34)));

    // 构造合法响应并解析
    const mbResp = buildModbusReadHoldingResponse(1, [85, 0, 1500, 1200]);
    const v5Resp = buildSolarmanV5ResponseFrame(serial, mbResp, 0x05);
    const parsed = parseSolarmanV5Response(v5Resp, { expectedSerial: serial, expectedSeq: 0x05 });
    expect(parsed).toEqual([85, 0, 1500, 1200]);

    // 篡改 V5 校验和应抛错
    const badChecksum = v5Resp.slice();
    badChecksum[badChecksum.length - 2] = (badChecksum[badChecksum.length - 2]! ^ 0xff) & 0xff;
    expect(() => parseSolarmanV5Response(badChecksum)).toThrow(SolarmanV5Error);

    // 篡改采集器序列号校验应抛错
    expect(() => parseSolarmanV5Response(v5Resp, { expectedSerial: serial + 1 })).toThrow(
      SolarmanV5Error,
    );

    // 篡改 Modbus CRC 应抛错（重新计算 V5 checksum 使错误落到 Modbus CRC 校验层）
    const badModbusCrc = v5Resp.slice();
    badModbusCrc[badModbusCrc.length - 3] = (badModbusCrc[badModbusCrc.length - 3]! ^ 0x01) & 0xff;
    badModbusCrc[badModbusCrc.length - 2] = solarmanV5Checksum(
      badModbusCrc.subarray(1, badModbusCrc.length - 2),
    );
    expect(() => parseSolarmanV5Response(badModbusCrc)).toThrow(SolarmanV5Error);
  });

  test("reads real Deye hybrid inverter registers over loopback TCP ignoring spurious 0x4710 heartbeats", async () => {
    const serial = 2987654321;
    const regStore = new Map<number, number>([
      [DEYE_SOLARMAN_REGISTERS.RUNNING_STATUS, 2], // 正常运行
      [DEYE_SOLARMAN_REGISTERS.DC_TEMPERATURE, 1365], // 36.5°C
      [DEYE_SOLARMAN_REGISTERS.AC_TEMPERATURE, 1392], // 39.2°C
      [DEYE_SOLARMAN_REGISTERS.TOTAL_PRODUCTION_LOW, 0x3039], // 12345 -> (1 << 16) | 0x3039 = 77881 -> 7788.1 kWh
      [DEYE_SOLARMAN_REGISTERS.TOTAL_PRODUCTION_HIGH, 0x0001],
      [DEYE_SOLARMAN_REGISTERS.DAILY_PRODUCTION, 246], // 24.6 kWh
      [DEYE_SOLARMAN_REGISTERS.GRID_POWER, 0xff06], // -250 W（馈网 250W）
      [DEYE_SOLARMAN_REGISTERS.LOAD_POWER, 1480], // 1480 W
      [DEYE_SOLARMAN_REGISTERS.BATTERY_VOLTAGE, 5320], // 53.20 V
      [DEYE_SOLARMAN_REGISTERS.BATTERY_SOC, 88], // 88%
      [DEYE_SOLARMAN_REGISTERS.PV1_POWER, 1850],
      [DEYE_SOLARMAN_REGISTERS.PV2_POWER, 1350],
      [DEYE_SOLARMAN_REGISTERS.BATTERY_POWER, 0xfb50], // -1200 W（充电 1200W）
      [DEYE_SOLARMAN_REGISTERS.BATTERY_CURRENT, 0xf736], // -22.50 A
    ]);

    let firstReply = true;
    const server = net.createServer((socket) => {
      socket.on("data", (chunk: Buffer | string) => {
        const chunkBytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        const req = new Uint8Array(chunkBytes);
        const dv = new DataView(req.buffer, req.byteOffset, req.byteLength);
        const reqSeq = req[5]!;
        const reqSerial = dv.getUint32(7, true);
        const modbus = req.subarray(26, req.length - 2);
        const slaveId = modbus[0]!;
        const startReg = (modbus[2]! << 8) | modbus[3]!;
        const count = (modbus[4]! << 8) | modbus[5]!;

        const regs: number[] = [];
        for (let i = 0; i < count; i++) {
          regs.push(regStore.get(startReg + i) ?? 0);
        }
        const mbResp = buildModbusReadHoldingResponse(slaveId, regs);
        const v5Resp = buildSolarmanV5ResponseFrame(reqSerial, mbResp, reqSeq);

        if (firstReply) {
          firstReply = false;
          // 模拟采集器在真实响应前夹带一帧 0x4710 心跳包
          const hb = new Uint8Array(15);
          const hdv = new DataView(hb.buffer);
          hb[0] = SOLARMAN_V5_START;
          hdv.setUint16(1, 2, true);
          hdv.setUint16(3, SOLARMAN_V5_CONTROL_HEARTBEAT, true);
          hb[13] = solarmanV5Checksum(hb.subarray(1, 13));
          hb[14] = SOLARMAN_V5_END;
          socket.write(Buffer.concat([hb, v5Resp]));
        } else {
          socket.write(v5Resp);
        }
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address() as net.AddressInfo;

    try {
      const telemetry = await queryInverterTelemetry(
        {
          id: "inv_test",
          name: "屋顶混合逆变器",
          ip: "127.0.0.1",
          port: addr.port,
          serial,
          slaveId: 1,
        },
        { timeoutMs: 3_000 },
      );

      expect(telemetry.pv1PowerW).toBe(1850);
      expect(telemetry.pv2PowerW).toBe(1350);
      expect(telemetry.pvPowerW).toBe(3200);
      expect(telemetry.batterySocPct).toBe(88);
      expect(telemetry.batteryVoltageV).toBe(53.2);
      expect(telemetry.batteryCurrentA).toBe(-22.5);
      expect(telemetry.batteryPowerW).toBe(-1200);
      expect(telemetry.gridPowerW).toBe(-250);
      expect(telemetry.loadPowerW).toBe(1480);
      expect(telemetry.dailyProductionKwh).toBe(24.6);
      expect(telemetry.totalProductionKwh).toBe(7788.1);
      expect(telemetry.inverterTempC).toBe(39.2);
      expect(telemetry.runningStatusCode).toBe(2);
      expect(telemetry.runningStatus).toBe("正常运行");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("DeyePlatformProvider End-to-End (Cloud Fog + Classic/Combo + Solarman Hybrid)", () => {
  let tempDir = "";

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "mijiadeck-deye-test-"));
    setDataPathOverrides({
      dataDir: () => tempDir,
      dataFile: (name: string) => path.join(tempDir, name),
    });
  });

  afterEach(() => {
    setDataPathOverrides(null);
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("lists and controls hybrid Fog dehumidifier + Solarman V5 inverter with secret redaction", async () => {
    const nowMs = 1_760_000_000_000;
    const validJwt = makeFakeJwt({
      enduserid: "deye-uid-888",
      exp: Math.floor(nowMs / 1000) + 10 * 86400,
    });
    const secretPassword = "MyVerySecretDeyePassword!99";

    const fogDevice: DeyeCloudDeviceInfo = {
      device_id: "fog-dev-p40",
      product_id: "d71936c6951c11f0a8200242ac480009", // DYD-P40
      device_name: "客厅除湿机 P40",
      product_name: "DYD-P40",
      platform: DeyeIotPlatform.Fog,
      mac: "AA:BB:CC:DD:EE:01",
      protocol_version: "",
      is_combo: false,
      online: true,
      product_type: "dehumidifier",
    };

    const fogProps: Record<string, number> = {
      Power: 1,
      Mode: DeyeDeviceMode.AUTO_MODE,
      WindSpeed: DeyeFanSpeed.MIDDLE,
      SetHumidity: 55,
      CurrentAmbientTemperature: 25,
      CurrentEnvironmentalHumidity: 62,
      NegativeIon: 1,
      SwingingWind: 0,
      KeyLock: 0,
      UV: 1,
      WaterTank: 0,
      Demisting: 0,
      Fan: 1,
      ProtocolVersion: 0,
    };

    const postedFogCommands: Array<Record<string, unknown>> = [];

    const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith("/login/")) {
        return makeJsonResponse({ meta: { code: 0, message: "ok" }, data: { token: validJwt } });
      }
      if (url.includes("/deviceList/")) {
        return makeJsonResponse({ meta: { code: 0, message: "ok" }, data: [fogDevice] });
      }
      if (url.includes("/get/properties/")) {
        return makeJsonResponse({
          meta: { code: 0, message: "ok" },
          data: { properties: { ...fogProps } },
        });
      }
      if (url.endsWith("/set/properties/")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          device_id: string;
          params: Record<string, number>;
        };
        postedFogCommands.push(body);
        if (!("RealData" in body.params)) {
          Object.assign(fogProps, body.params);
        }
        return makeJsonResponse({ meta: { code: 0, message: "ok" }, data: {} });
      }
      return makeJsonResponse({ meta: { code: 404, message: "not found" }, data: null }, 404);
    }) as typeof fetch;

    const mockTelemetry: DeyeInverterTelemetry = {
      pv1PowerW: 2100,
      pv2PowerW: 1400,
      pvPowerW: 3500,
      batterySocPct: 91,
      batteryVoltageV: 53.6,
      batteryCurrentA: -15.2,
      batteryPowerW: -815,
      gridPowerW: -600,
      loadPowerW: 2085,
      dailyProductionKwh: 28.4,
      totalProductionKwh: 9120.5,
      inverterTempC: 41.2,
      runningStatusCode: 2,
      runningStatus: "正常运行",
    };

    const mockSolarman: ISolarmanTransport = {
      async queryInverterTelemetry() {
        return mockTelemetry;
      },
    };

    const provider = new DeyePlatformProvider({
      httpFetch: mockFetch,
      solarmanTransport: mockSolarman,
      nowMs: () => nowMs,
    });

    expect(provider.id).toBe("deye");
    expect(provider.metadata.id).toBe(DEYE_PLATFORM_METADATA.id);

    const status = await provider.configure({
      enabled: true,
      mode: "hybrid",
      username: "13900139000",
      password: secretPassword,
      solarmanInverters: [
        {
          id: "inv_roof_1",
          name: "屋顶德业 12kW 逆变器",
          ip: "192.168.1.88",
          port: 8899,
          serial: 2700012345,
          room: "配电间",
        },
      ],
    });

    expect(status.connected).toBe(true);
    expect(status.authMode).toBe("hybrid");
    expect(status.configSummary["hasPassword"]).toBe(true);
    expect(status.configSummary["hasAuthToken"]).toBe(true);
    // 严格确保 configSummary 绝不泄露密码或 JWT 明文
    const serializedSummary = JSON.stringify(status.configSummary);
    expect(serializedSummary).not.toContain(secretPassword);
    expect(serializedSummary).not.toContain(validJwt);

    // 列表聚合：同时包含 Fog 除湿机与 Solarman 逆变器
    const devices = await provider.listDevices();
    expect(devices.length).toBe(2);

    const dehum = devices.find((d) => d.did === "fog-dev-p40")!;
    const inv = devices.find((d) => d.did === "inv_roof_1")!;
    expect(dehum.model).toBe("deye.dehumidifier.dyd-p40");
    expect(dehum.spec_type).toBe("urn:deye:device:dehumidifier:d71936c6951c11f0a8200242ac480009:1");
    expect(dehum.metric_features).toEqual(["temperature", "relative-humidity"]);
    expect(supportsCardPower(dehum)).toBe(true);
    expect(trayEligible(dehum)).toBe(true);

    expect(inv.model).toBe("deye.solar-inverter.v5");
    expect(inv.spec_type).toBe("urn:deye:device:solar-inverter:v5:1");
    expect(inv.metric_features).toEqual(["temperature", "electric-power"]);
    expect(supportsCardPower(inv)).toBe(false);
    expect(trayEligible(inv)).toBe(true);

    // deviceDetail 中文属性标签检查
    const dehumDetail = await provider.deviceDetail("fog-dev-p40");
    const dehumPropNames = new Map(dehumDetail.props.map((p) => [p.name, p.desc]));
    expect(dehumPropNames.get("on")).toBe("电源开关");
    expect(dehumPropNames.get("target-humidity")).toBe("目标湿度");
    expect(dehumPropNames.get("mode")).toBe("工作模式");
    expect(dehumPropNames.get("fan-speed")).toBe("风速");
    expect(dehumPropNames.get("uv")).toBe("UV 杀菌");
    expect(dehumPropNames.get("water-tank-full")).toBe("水箱满状态");

    const invDetail = await provider.deviceDetail("inv_roof_1");
    const invPropNames = new Map(invDetail.props.map((p) => [p.name, p.desc]));
    expect(invPropNames.get("pv-power")).toBe("光伏功率");
    expect(invPropNames.get("battery-soc")).toBe("电池电量");
    expect(invPropNames.get("grid-power")).toBe("电网功率");
    expect(invPropNames.get("load-power")).toBe("负载功率");
    expect(invPropNames.get("daily-production")).toBe("日发电量");

    // writeProp: target-humidity / mode / fan-speed（含 ProtocolVersion 0 伴随属性）
    await provider.writeProp("fog-dev-p40", "target-humidity", 50);
    await provider.writeProp("fog-dev-p40", "mode", DeyeDeviceMode.CLOTHES_DRYER_MODE);
    await provider.writeProp("fog-dev-p40", "fan-speed", DeyeFanSpeed.HIGH);

    expect(postedFogCommands.length).toBe(3);
    const humCmd = postedFogCommands[0]!["params"] as Record<string, number>;
    expect(humCmd["SetHumidity"]).toBe(50);
    expect(humCmd["Power"]).toBe(1); // ProtocolVersion 0 companion
    const modeCmd = postedFogCommands[1]!["params"] as Record<string, number>;
    expect(modeCmd["Mode"]).toBe(DeyeDeviceMode.CLOTHES_DRYER_MODE);
    const fanCmd = postedFogCommands[2]!["params"] as Record<string, number>;
    expect(fanCmd["WindSpeed"]).toBe(DeyeFanSpeed.HIGH);

    // 越界目标湿度拒绝写入
    await expect(provider.writeProp("fog-dev-p40", "target-humidity", 20)).rejects.toThrow(
      ServiceError,
    );
    // 逆变器只读保护
    await expect(provider.writeProp("inv_roof_1", "pv-power", 0)).rejects.toThrow(ServiceError);

    // togglePower 验证
    expect(await provider.powerState("fog-dev-p40")).toBe(true);
    const toggled = await provider.togglePower("fog-dev-p40");
    expect(toggled).toBe(false);
    expect(await provider.powerState("fog-dev-p40")).toBe(false);
    expect(await provider.powerState("inv_roof_1")).toBeNull();

    // readMetrics 验证
    const metrics = await provider.readMetrics(["fog-dev-p40", "inv_roof_1"]);
    expect(metrics["fog-dev-p40"]).toBe("25.0°C 62%");
    expect(metrics["inv_roof_1"]).toBe("PV 3500W · 电池 91% · 负载 2085W · 41.2°C");

    // runAction refresh-state 触发 Fog RealData: 1
    await provider.runAction("fog-dev-p40", "refresh-state");
    const lastCmd = postedFogCommands[postedFogCommands.length - 1]!;
    expect(lastCmd["params"]).toEqual({ RealData: 1 });

    // diagnosticReport 脱敏检查
    const diag = await provider.diagnosticReport(dehum, { token: "leaked-token" });
    expect(diag).not.toContain(secretPassword);
    expect(diag).not.toContain(validJwt);
    expect(diag).not.toContain("leaked-token");

    // 再次配置时省略密码（或传脱敏占位符）保留已有密码与令牌
    const updatedStatus = await provider.configure({
      enabled: true,
      mode: "hybrid",
      username: "13900139000",
      password: "••••••••",
    });
    expect(updatedStatus.configSummary["hasPassword"]).toBe(true);
    expect(updatedStatus.configSummary["hasAuthToken"]).toBe(true);

    // 重启新实例后验证持久化加载成功
    const reloaded = new DeyePlatformProvider({
      httpFetch: mockFetch,
      solarmanTransport: mockSolarman,
      nowMs: () => nowMs,
    });
    expect(reloaded.isEnabled()).toBe(true);
    expect(reloaded.isConnected()).toBe(true);
    expect(reloaded.status().configSummary["username"]).toBe("13900139000");

    // disconnect 清理凭据并断开连接
    await reloaded.disconnect();
    expect(reloaded.isEnabled()).toBe(false);
    expect(reloaded.isConnected()).toBe(false);
    expect(reloaded.status().configSummary["hasPassword"]).toBe(false);
    expect(reloaded.status().configSummary["hasAuthToken"]).toBe(false);
  });

  test("routes Classic MQTT 10-byte commands and Combo 4-byte frames via injected mqttTransport", async () => {
    const nowMs = 1_760_000_000_000;
    const validJwt = makeFakeJwt({
      enduserid: "deye-classic-uid",
      exp: Math.floor(nowMs / 1000) + 10 * 86400,
    });

    const classicDevice: DeyeCloudDeviceInfo = {
      device_id: "classic-dev-1",
      product_id: "2c4bd0861c3011e89d4c00163e0c1b21", // T22A3
      device_name: "卧室除湿机 T22A3",
      product_name: "T22A3",
      platform: DeyeIotPlatform.Classic,
      mac: "AA:BB:CC:DD:EE:02",
      protocol_version: "V1.0",
      is_combo: false,
      online: true,
    };

    const comboDevice: DeyeCloudDeviceInfo = {
      device_id: "combo-dev-2",
      product_id: "a3850ae49ea511e89d4c00163e0c1b21", // N20A3
      device_name: "书房除湿机 N20A3",
      product_name: "N20A3",
      platform: DeyeIotPlatform.Classic,
      mac: "AA:BB:CC:DD:EE:03",
      protocol_version: "combo_V1.0",
      is_combo: true,
      online: true,
    };

    const mockFetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/deviceList/")) {
        return makeJsonResponse({ meta: { code: 0, message: "ok" }, data: [classicDevice, comboDevice] });
      }
      if (url.endsWith("/mqttInfo/")) {
        return makeJsonResponse({
          meta: { code: 0, message: "ok" },
          data: {
            mqtthost: "mqtt.deye.local",
            mqttport: 1883,
            sslport: 8883,
            clientid: "cid-1",
            loginname: "u1",
            password: "p1",
            endpoint: "deye",
          },
        });
      }
      return makeJsonResponse({ meta: { code: 0, message: "ok" }, data: {} });
    }) as typeof fetch;

    const published: Array<{ deviceId: string; payloads: Uint8Array[] }> = [];
    const mockMqtt: IDeyeClassicMqttTransport = {
      async queryDeviceState() {
        return parseClassicStateHex(
          makeClassicStateHex({
            flag: DeyeDeviceStateFlag.POWER_SWITCH,
            fanSpeed: DeyeFanSpeed.LOW,
            mode: DeyeDeviceMode.MANUAL_MODE,
            targetHumidity: 60,
            coilTempC: 16,
            envTempC: 24,
            envHumidity: 65,
            exhaustTempC: 35,
          }),
        );
      },
      async publishCommand(_info, _pid, deviceId, payloads) {
        published.push({ deviceId, payloads });
      },
    };

    const provider = new DeyePlatformProvider({
      persistConfig: false,
      httpFetch: mockFetch,
      mqttTransport: mockMqtt,
      nowMs: () => nowMs,
    });

    await provider.configure({
      enabled: true,
      mode: "cloud",
      authToken: validJwt,
    });

    await provider.listDevices();

    // Classic 设备下发 10 字节指令
    await provider.writeProp("classic-dev-1", "target-humidity", 45);
    expect(published.length).toBe(1);
    expect(published[0]!.deviceId).toBe("classic-dev-1");
    expect(published[0]!.payloads.length).toBe(1);
    expect(published[0]!.payloads[0]!.length).toBe(10);
    expect(published[0]!.payloads[0]![4]).toBe(45);

    // Combo 设备下发 4 字节单属性帧 {2, 17, 10, 50}
    await provider.writeProp("combo-dev-2", "target-humidity", 50);
    expect(published.length).toBe(2);
    expect(published[1]!.deviceId).toBe("combo-dev-2");
    expect(published[1]!.payloads.length).toBe(1);
    expect([...published[1]!.payloads[0]!]).toEqual([2, 17, DeyeFogComboCommand.HUMIDITY_OR_TEMP, 50]);
  });

  test("maps air-purifier cloud devices, formats water-tank-full metrics, and enforces setControlAccess", async () => {
    const nowMs = 1_760_000_000_000;
    const validJwt = makeFakeJwt({
      enduserid: "deye-ap-uid",
      exp: Math.floor(nowMs / 1000) + 10 * 86400,
    });

    const purifierDevice: DeyeCloudDeviceInfo = {
      device_id: "fog-ap-1",
      product_id: "unknown-ap-pid",
      device_name: "卧室空气净化器",
      product_name: "AP-Pro",
      platform: DeyeIotPlatform.FogCombo,
      mac: "AA:BB:CC:DD:EE:09",
      protocol_version: "combo_V1.0",
      is_combo: true,
      online: true,
      product_type: "air-purifier",
    };

    const mockFetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/deviceList/")) {
        return makeJsonResponse({ meta: { code: 0, message: "ok" }, data: [purifierDevice] });
      }
      if (url.includes("/get/properties/")) {
        return makeJsonResponse({
          meta: { code: 0, message: "ok" },
          data: {
            properties: {
              Power: 1,
              Mode: DeyeDeviceMode.AUTO_PURIFIER_MODE,
              WindSpeed: DeyeFanSpeed.AUTO,
              CurrentAmbientTemperature: 24,
              CurrentEnvironmentalHumidity: 68,
              WaterTank: 1,
              ProtocolVersion: 1,
            },
          },
        });
      }
      return makeJsonResponse({ meta: { code: 0, message: "ok" }, data: {} });
    }) as typeof fetch;

    const provider = new DeyePlatformProvider({
      persistConfig: false,
      httpFetch: mockFetch,
      nowMs: () => nowMs,
    });

    await provider.configure({ enabled: true, mode: "cloud", authToken: validJwt });
    const devices = await provider.listDevices();
    expect(devices.length).toBe(1);
    expect(devices[0]!.model).toBe("deye.air-purifier.ap-pro");
    expect(devices[0]!.spec_type).toBe("urn:deye:device:air-purifier:unknown-ap-pid:1");
    expect(supportsCardPower(devices[0]!)).toBe(true);

    const metrics = await provider.readMetrics(["fog-ap-1"]);
    expect(metrics["fog-ap-1"]).toBe("24.0°C 68% · 水满");

    provider.setControlAccess("只读保护模式");
    await expect(provider.writeProp("fog-ap-1", "on", false)).rejects.toThrow("只读保护模式");
    await expect(provider.togglePower("fog-ap-1")).rejects.toThrow("只读保护模式");
  });

  test("handles pure Solarman V5 local mode with offline inverter resilience and validation", async () => {
    const flakySolarman: ISolarmanTransport = {
      async queryInverterTelemetry(entry) {
        if (entry.id === "inv_offline") {
          throw new SolarmanV5Error("connection refused");
        }
        return {
          pv1PowerW: 900,
          pv2PowerW: 600,
          pvPowerW: 1500,
          batterySocPct: 75,
          batteryVoltageV: 52.4,
          batteryCurrentA: 4.5,
          batteryPowerW: 235,
          gridPowerW: 100,
          loadPowerW: 1835,
          dailyProductionKwh: 11.2,
          totalProductionKwh: 430.8,
          inverterTempC: 34.5,
          runningStatusCode: 2,
          runningStatus: "正常运行",
        };
      },
    };

    const provider = new DeyePlatformProvider({
      persistConfig: false,
      solarmanTransport: flakySolarman,
    });

    // 空逆变器列表在纯 solarman 模式下必须校验拒绝
    await expect(
      provider.configure({ enabled: true, mode: "solarman", solarmanInverters: [] }),
    ).rejects.toThrow(ServiceError);

    const status = await provider.configure({
      enabled: true,
      mode: "solarman",
      solarmanInverters: [
        { id: "inv_online", name: "车库逆变器", ip: "192.168.1.90", serial: 1111111111 },
        { id: "inv_offline", name: "备用逆变器", ip: "192.168.1.91", serial: 2222222222 },
      ],
    });
    expect(status.authMode).toBe("local");
    expect(status.connected).toBe(true);

    const list = await provider.listDevices();
    expect(list.length).toBe(2);
    expect(list.find((d) => d.did === "inv_online")!.online).toBe(true);
    expect(list.find((d) => d.did === "inv_offline")!.online).toBe(false);

    const props = await provider.readProps("inv_online", ["pv-power", "battery-soc", "running-status"]);
    expect(props).toEqual({
      "pv-power": 1500,
      "battery-soc": 75,
      "running-status": "正常运行",
    });
  });

  test("redacts leaked secrets in error messages and exercises productList / fogMqttInfo endpoints", async () => {
    const nowMs = 1_760_000_000_000;
    const validJwt = makeFakeJwt({
      enduserid: "deye-sec-uid",
      exp: Math.floor(nowMs / 1000) + 10 * 86400,
    });
    const secretPwd = "TopSecret_Deye_Pwd_42";

    const hitPaths: string[] = [];
    const mockFetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      hitPaths.push(url);
      if (url.endsWith("/login/")) {
        return makeJsonResponse({
          meta: { code: 4001, message: `bad password ${secretPwd}` },
          data: null,
        });
      }
      if (url.includes("/productlist/")) {
        return makeJsonResponse({
          meta: { code: 0, message: "ok" },
          data: {
            result: [
              {
                ptype: "dehumidifier",
                ptypename: "除湿机",
                pdata: [{ productid: "pid-1", pname: "P40", brand: "Deye", model: "DYD-P40" }],
              },
            ],
          },
        });
      }
      if (url.includes("/fogmqttinfo/")) {
        return makeJsonResponse({
          meta: { code: 0, message: "ok" },
          data: {
            username: "fog-u1",
            clientid: "fog-c1",
            password: "fog-p1",
            mqtt_host: "fog.deye.com.cn",
            ws_port: "8083",
            ssl_port: "8883",
            topic: { all: [], pub: [], sub: ["fogcloud/app/fog-u1/sub"] },
            expire: 3600,
          },
        });
      }
      return makeJsonResponse({ meta: { code: 0, message: "ok" }, data: {} });
    }) as typeof fetch;

    const provider = new DeyePlatformProvider({
      persistConfig: false,
      httpFetch: mockFetch,
      nowMs: () => nowMs,
    });

    // 即使远端把密码回显在错误文本里，provider 错误与 status.lastError 也不能泄露明文
    let caughtMsg = "";
    try {
      await provider.configure({
        enabled: true,
        mode: "cloud",
        username: "user@example.com",
        password: secretPwd,
      });
    } catch (err) {
      caughtMsg = err instanceof Error ? err.message : String(err);
    }
    expect(caughtMsg.length).toBeGreaterThan(0);
    expect(caughtMsg).not.toContain(secretPwd);
    expect(provider.status().lastError ?? "").not.toContain(secretPwd);

    // DeyeCloudClient productlist & fogmqttinfo 端点验证
    const cloud = new DeyeCloudClient({
      authToken: validJwt,
      httpFetch: mockFetch,
      nowMs: () => nowMs,
    });
    const products = await cloud.getProductList();
    expect(products.length).toBe(1);
    expect(products[0]!.pdata[0]!.model).toBe("DYD-P40");

    const fogMqtt = await cloud.getFogMqttInfo();
    expect(fogMqtt.mqtt_host).toBe("fog.deye.com.cn");
    expect(hitPaths.some((p) => p.includes("/productlist/?app=new"))).toBe(true);
    expect(hitPaths.some((p) => p.includes("/fogmqttinfo/?random="))).toBe(true);
  });
});
