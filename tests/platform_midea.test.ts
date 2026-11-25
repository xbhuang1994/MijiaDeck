// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 美的智能 (Midea) 协议与平台集成完整测试

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { isLight, supportsCardPower } from "../src/core/deviceControls.ts";
import { setDataPathOverrides } from "../src/core/jsonStore.ts";
import {
  CRC8_854_TABLE,
  DISCOVERY_MSG,
  DISCOVERY_MSG_LEGACY,
  LOCAL_AES_KEY,
  LOCAL_MD5_SALT,
  MIDEA_APPLIANCE_TYPES,
  MIDEA_CLOUD_PRESETS,
  MIDEA_DEFAULT_KEYS,
  MIDEA_PLATFORM_METADATA,
  MSGTYPE_ENCRYPTED_REQUEST,
  MSGTYPE_ENCRYPTED_RESPONSE,
  MSGTYPE_HANDSHAKE_REQUEST,
  MSGTYPE_HANDSHAKE_RESPONSE,
  MideaCloudClient,
  MideaCloudSecurity,
  MideaLanClient,
  MideaLocalSecurity,
  MideaPlatformProvider,
  buildAcQuery,
  buildAcSet,
  buildAcStatusResponseFrame,
  buildDehumidifierQuery,
  buildDehumidifierSet,
  buildDehumidifierStatusResponseFrame,
  buildFanSet,
  buildMideaFrame,
  buildPurifierSet,
  buildWaterHeaterSet,
  defaultAcState,
  defaultDehumidifierState,
  formatMideaMetrics,
  mapMideaDeviceToInfo,
  mideaChecksum,
  mideaCrc8,
  parseAcResponse,
  parseDehumidifierResponse,
  parseDiscoveryResponse,
  parseFanResponse,
  parseMideaFrame,
  parsePurifierResponse,
  parseWaterHeaterResponse,
  type IMideaLanTransport,
  type MideaAcState,
  type MideaLanDeviceEndpoint,
} from "../src/platforms/midea/index.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function startTcpServer(
  onConnection: (socket: net.Socket) => void,
): Promise<{ server: net.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer(onConnection);
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Failed to bind TCP mock server"));
        return;
      }
      resolve({ server, port: addr.port });
    });
  });
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

describe("Midea 协议常量、加解密与 0xAA 串口编解码", () => {
  test("1. 云端预设、默认回退密钥对、品类注册表与广播发现包合法性", () => {
    expect(MIDEA_CLOUD_PRESETS.meiju.appId).toBe("900");
    expect(MIDEA_CLOUD_PRESETS.meiju.appKey).toBe("46579c15");
    expect(MIDEA_CLOUD_PRESETS.meiju.fixedKey).toBe(10864842703515613082n);

    expect(MIDEA_CLOUD_PRESETS.msmarthome.appId).toBe("1010");
    expect(MIDEA_CLOUD_PRESETS.msmarthome.fixedKey).toBe(13101328926877700970n);
    expect(MIDEA_CLOUD_PRESETS.msmarthome.fixedIv).toBe(16429062708050928556n);
    expect(MIDEA_CLOUD_PRESETS.msmarthome.apiUrlChina).toContain("smartmidea.net");

    expect(MIDEA_CLOUD_PRESETS.nethomeplus.appId).toBe("1017");
    expect(MIDEA_CLOUD_PRESETS.midea_air.appId).toBe("1117");

    expect(MIDEA_DEFAULT_KEYS[99]!.token.length).toBe(128);
    expect(MIDEA_DEFAULT_KEYS[99]!.key.length).toBe(64);
    expect(LOCAL_AES_KEY.length).toBe(16);
    expect(LOCAL_MD5_SALT.length).toBe(36);

    // 104 字节标准发现包与 72 字节兼容发现包均通过 0x5A5A 解包与 MD5 校验
    expect(DISCOVERY_MSG.length).toBe(104);
    expect(MideaLocalSecurity.decode5a5a(DISCOVERY_MSG).msgType).toBe(0x92);
    expect(DISCOVERY_MSG_LEGACY.length).toBe(72);
    expect(MideaLocalSecurity.decode5a5a(DISCOVERY_MSG_LEGACY).msgType).toBe(0x92);

    // 13 类核心家电品类注册完整
    for (const code of [0xac, 0xa1, 0xfa, 0xfc, 0xfd, 0xe2, 0xe3, 0xdb, 0xdc, 0xcc, 0xcf, 0xea, 0x13]) {
      expect(MIDEA_APPLIANCE_TYPES[code]).toBeDefined();
      expect(MIDEA_APPLIANCE_TYPES[code]!.label.length).toBeGreaterThan(0);
    }
  });

  test("2. Meiju & MSmartHome 密码哈希、HMAC-SHA256 签名及旧版表单 SHA256 签名", () => {
    const meiju = new MideaCloudSecurity("meiju");
    const msmart = new MideaCloudSecurity("msmarthome");
    const nethome = new MideaCloudSecurity("nethomeplus");

    // getDeviceId
    const expectedDevId = createHash("sha256")
      .update("Hello, user@example.com!")
      .digest("hex")
      .slice(0, 16);
    expect(meiju.getDeviceId("user@example.com")).toBe(expectedDevId);
    expect(expectedDevId.length).toBe(16);

    // encryptPassword
    const pwdHash = createHash("sha256").update("Secret#123").digest("hex");
    const expectedMeijuPwd = createHash("sha256")
      .update(`login-001${pwdHash}${MIDEA_CLOUD_PRESETS.meiju.loginKey}`)
      .digest("hex");
    expect(meiju.encryptPassword("login-001", "Secret#123")).toBe(expectedMeijuPwd);

    // encryptIamPassword: Meiju = md5(md5(pwd)), MSmartHome = sha256(loginId + md5(md5(pwd)) + loginKey)
    const md5Once = createHash("md5").update("Secret#123").digest("hex");
    const doubleMd5 = createHash("md5").update(md5Once).digest("hex");
    expect(meiju.encryptIamPassword("login-001", "Secret#123")).toBe(doubleMd5);

    const expectedMsmartIam = createHash("sha256")
      .update(`login-001${doubleMd5}${MIDEA_CLOUD_PRESETS.msmarthome.loginKey}`)
      .digest("hex");
    expect(msmart.encryptIamPassword("login-001", "Secret#123")).toBe(expectedMsmartIam);

    // HMAC-SHA256 sign for Meiju / MSmartHome
    const bodyStr = JSON.stringify({ appId: "900", stamp: "20261125120000" });
    const expectedMeijuSign = createHmac("sha256", MIDEA_CLOUD_PRESETS.meiju.hmacKey!)
      .update(`${MIDEA_CLOUD_PRESETS.meiju.iotKey}${bodyStr}1700000000`)
      .digest("hex");
    expect(meiju.sign("/v1/homegroup/list/get", bodyStr, "1700000000")).toBe(expectedMeijuSign);

    const expectedMsmartSign = createHmac("sha256", MIDEA_CLOUD_PRESETS.msmarthome.hmacKey!)
      .update(`${MIDEA_CLOUD_PRESETS.msmarthome.iotKey}${bodyStr}1700000000`)
      .digest("hex");
    expect(msmart.sign("/v1/homegroup/list/get", bodyStr, "1700000000")).toBe(expectedMsmartSign);

    // Legacy sorted form SHA256 sign for NetHomePlus
    const legacySign = nethome.sign("https://mapp.appsmb.com/v1/user/login", {
      zKey: "last",
      aKey: "first",
    });
    const expectedLegacySign = createHash("sha256")
      .update(`/v1/user/login` + `aKey=first&zKey=last` + MIDEA_CLOUD_PRESETS.nethomeplus.appKey)
      .digest("hex");
    expect(legacySign).toBe(expectedLegacySign);
  });

  test("3. getUdpId (methods 0/1/2) 折叠算法与 Meiju(ECB) / MSmartHome(CBC) AES 密钥加解密", () => {
    const applianceId = 152839104215234n; // 48-bit ID

    // 手工验证 method 1 (6字节小端) 与 method 2 (6字节大端) 和 method 0 (8字节小端)
    const manualUdp = (bytes: Buffer): string => {
      const h = createHash("sha256").update(bytes).digest();
      const out = Buffer.alloc(16);
      for (let i = 0; i < 16; i++) out[i] = h[i]! ^ h[i + 16]!;
      return out.toString("hex");
    };

    const le6 = Buffer.alloc(6);
    le6.writeUIntLE(Number(applianceId), 0, 6);
    const be6 = Buffer.alloc(6);
    be6.writeUIntBE(Number(applianceId), 0, 6);
    const le8 = Buffer.alloc(8);
    le8.writeBigUInt64LE(applianceId, 0);

    expect(MideaCloudSecurity.getUdpId(applianceId, 0)).toBe(manualUdp(le8));
    expect(MideaCloudSecurity.getUdpId(applianceId, 1)).toBe(manualUdp(le6));
    expect(MideaCloudSecurity.getUdpId(applianceId, 2)).toBe(manualUdp(be6));
    expect(MideaCloudSecurity.getUdpId(applianceId, 1)).not.toBe(
      MideaCloudSecurity.getUdpId(applianceId, 2),
    );

    // Meiju ECB fixedKey & session key
    const meiju = new MideaCloudSecurity("meiju");
    const encFixed = meiju.aesEncryptWithFixedKey("0000AC123456789012345678");
    expect(meiju.aesDecryptWithFixedKey(encFixed)).toBe("0000AC123456789012345678");
    expect(meiju.tryDecryptSn(encFixed)).toBe("0000AC123456789012345678");

    const sessionKeyCipher = meiju.aesEncryptWithFixedKey("1234567890abcdef");
    meiju.setAesKeys(sessionKeyCipher);
    expect(meiju.hasSessionAesKey).toBe(true);
    const encBySession = meiju.aesEncrypt("0000AC9988776655");
    expect(meiju.tryDecryptSn(encBySession)).toBe("0000AC9988776655");

    // MSmartHome CBC fixedKey + fixedIv
    const msmart = new MideaCloudSecurity("msmarthome");
    const cbcCipher = msmart.aesEncryptWithFixedKey("MSMART_SN_000001");
    expect(msmart.aesDecryptWithFixedKey(cbcCipher)).toBe("MSMART_SN_000001");
  });

  test("4. LAN V2 (0x5A5A) 打包/解包与 MD5 篡改检测", () => {
    const acQuery = buildAcQuery();
    const applianceId = 17592186044415n;
    const packed = MideaLocalSecurity.encode5a5a(acQuery, applianceId);

    expect(packed[0]).toBe(0x5a);
    expect(packed[1]).toBe(0x5a);
    expect(packed.readUInt16LE(4)).toBe(packed.length);

    const decoded = MideaLocalSecurity.decode5a5a(packed);
    expect(decoded.signatureValid).toBe(true);
    expect(decoded.applianceId).toBe(applianceId);
    expect(decoded.msgType).toBe(0x20);
    expect(decoded.payload.equals(acQuery)).toBe(true);

    // 篡改密文 1 字节必须触发 MD5 签名校验失败
    const tampered = Buffer.from(packed);
    tampered[45] = tampered[45]! ^ 0xff;
    expect(() => MideaLocalSecurity.decode5a5a(tampered)).toThrow("MD5");
  });

  test("5. LAN V3 (0x8370) 握手 deriveTcpKey、加密帧往返与分片/篡改校验", () => {
    const key32 = Buffer.from(MIDEA_DEFAULT_KEYS[99]!.key, "hex");
    const plain32 = randomBytes(32);
    const handshakeResp = MideaLocalSecurity.createHandshakeResponse(plain32, key32);

    const clientSec = new MideaLocalSecurity();
    const derived = clientSec.deriveTcpKey(handshakeResp, key32);
    expect(derived.length).toBe(32);
    for (let i = 0; i < 32; i++) {
      expect(derived[i]).toBe(plain32[i]! ^ key32[i]!);
    }

    // 错误 key 与 ERROR 响应必须拒绝
    const wrongKey = Buffer.alloc(32, 0xaa);
    expect(() => MideaLocalSecurity.deriveTcpKey(handshakeResp, wrongKey)).toThrow("不匹配");
    expect(() => MideaLocalSecurity.deriveTcpKey(Buffer.from("ERROR"), key32)).toThrow("ERROR");

    // 加密请求与响应往返 + 流式半包拼接
    const serverSec = new MideaLocalSecurity();
    serverSec.setTcpKey(derived);

    const payload1 = MideaLocalSecurity.encode5a5a(buildAcQuery(), 123456n);
    const payload2 = Buffer.from("Midea-V3-Exact-16B");
    const wire1 = clientSec.encode8370(payload1, MSGTYPE_ENCRYPTED_REQUEST);
    const wire2 = clientSec.encode8370(payload2, MSGTYPE_ENCRYPTED_REQUEST);

    const combined = Buffer.concat([wire1, wire2]);
    // 故意在中间截断，验证 streaming remainder
    const cut = wire1.length + 10;
    const partA = serverSec.decode8370(combined.subarray(0, cut));
    expect(partA.packets.length).toBe(1);
    expect(partA.packets[0]!.msgType).toBe(MSGTYPE_ENCRYPTED_REQUEST);
    expect(partA.packets[0]!.counter).toBe(1);
    expect(partA.packets[0]!.payload.equals(payload1)).toBe(true);
    expect(partA.remainder.length).toBe(10);

    const partB = serverSec.decode8370(Buffer.concat([partA.remainder, combined.subarray(cut)]));
    expect(partB.packets.length).toBe(1);
    expect(partB.packets[0]!.counter).toBe(2);
    expect(partB.packets[0]!.payload.equals(payload2)).toBe(true);
    expect(partB.remainder.length).toBe(0);

    // 篡改密文必须触发 SHA-256 签名错误
    const badWire = Buffer.from(wire1);
    badWire[10] = badWire[10]! ^ 0x01;
    expect(() => serverSec.decode8370(badWire)).toThrow("SHA-256");
  });

  test("6. 0xAA 串口帧 CRC8 查找表与多项式一致性、校验和及损坏检测", () => {
    // 验证整个 256 字节表均严格等于反射多项式 0x8C
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let bit = 0; bit < 8; bit++) {
        c = c & 1 ? (c >> 1) ^ 0x8c : c >> 1;
      }
      expect(CRC8_854_TABLE[i]).toBe(c & 0xff);
    }

    const body = new Uint8Array([0x41, 0x81, 0x00, 0xff, 0x03, 0xff, 0x00, 0x02]);
    const frame = buildMideaFrame(0xac, 0x03, body, { protocolVersion: 0x03 });
    expect(frame[0]).toBe(0xaa);
    expect(frame[1]).toBe(frame.length - 1);
    expect(frame[frame.length - 2]).toBe(mideaCrc8(body));
    expect(frame[frame.length - 1]).toBe(mideaChecksum(frame.subarray(1, frame.length - 1)));

    const parsed = parseMideaFrame(frame);
    expect(parsed.deviceType).toBe(0xac);
    expect(parsed.frameType).toBe(0x03);
    expect(parsed.crcValid).toBe(true);
    expect(parsed.checksumValid).toBe(true);
    expect(Buffer.from(parsed.body).equals(Buffer.from(body))).toBe(true);

    // 破坏校验和必须抛出异常
    const corrupted = Buffer.from(frame);
    corrupted[corrupted.length - 1] = (corrupted[corrupted.length - 1]! + 1) & 0xff;
    expect(() => parseMideaFrame(corrupted)).toThrow("校验和失败");
  });

  test("7. 0xAC 空调状态帧解析与设置编码（含 0.5°C 步进与室内外温度）", () => {
    const query = buildAcQuery();
    const parsedQuery = parseMideaFrame(query);
    expect(parsedQuery.deviceType).toBe(0xac);
    expect(parsedQuery.body[0]).toBe(0x41);
    expect(parsedQuery.body[1]).toBe(0x81);

    // 构造真实 0xC0 响应帧：开机、制冷(2)、24.5°C、中风(60)、上下扫风、ECO、电辅热、室内 26.5°C、室外 34.0°C、屏显关闭
    const c0Body = new Uint8Array(23);
    c0Body[0] = 0xc0;
    c0Body[1] = 0x01; // power on
    c0Body[2] = (2 << 5) | 0x10 | (24 - 16); // cool + 0.5°C + 24°C = 24.5°C
    c0Body[3] = 60; // medium fan
    c0Body[7] = 0x0c; // vertical swing on, horizontal off
    c0Body[8] = 0x20; // turbo on
    c0Body[9] = 0x10 | 0x08; // eco + auxHeat
    c0Body[11] = 103; // (103 - 50) / 2 = 26.5°C
    c0Body[12] = 118; // (118 - 50) / 2 = 34.0°C
    c0Body[14] = 0x70; // screenDisplay off

    const c0Frame = buildMideaFrame(0xac, 0x03, c0Body, { protocolVersion: 0x03 });
    const parsed = parseAcResponse(c0Frame)!;
    expect(parsed).not.toBeNull();
    expect(parsed.power).toBe(true);
    expect(parsed.mode).toBe(2);
    expect(parsed.targetTemperature).toBe(24.5);
    expect(parsed.fanSpeed).toBe(60);
    expect(parsed.swingVertical).toBe(true);
    expect(parsed.swingHorizontal).toBe(false);
    expect(parsed.turbo).toBe(true);
    expect(parsed.eco).toBe(true);
    expect(parsed.auxHeat).toBe(true);
    expect(parsed.screenDisplay).toBe(false);
    expect(parsed.indoorTemperature).toBe(26.5);
    expect(parsed.outdoorTemperature).toBe(34.0);

    // 编码 0x40 设置帧并核对关键位
    const setFrame = buildAcSet({
      power: true,
      mode: 4, // heat
      targetTemperature: 21.5,
      fanSpeed: 80,
      swingVertical: true,
      swingHorizontal: true,
      eco: false,
      turbo: true,
      auxHeat: true,
      screenDisplay: true,
    });
    const parsedSet = parseMideaFrame(setFrame);
    expect(parsedSet.frameType).toBe(0x02);
    expect(parsedSet.crcValid).toBe(true);
    expect(parsedSet.body[0]).toBe(0x40);
    expect(parsedSet.body[1]! & 0x01).toBe(1);
    expect((parsedSet.body[2]! & 0xe0) >> 5).toBe(4);
    expect((parsedSet.body[2]! & 0x0f) + 16 + ((parsedSet.body[2]! & 0x10) ? 0.5 : 0)).toBe(21.5);
    expect(parsedSet.body[3]).toBe(80);
    expect(parsedSet.body[7]! & 0x0f).toBe(0x0f);
    expect(parsedSet.body[9]! & 0x08).toBe(0x08);
  });

  test("8. 0xA1 除湿机与其他家电品类 (0xFA / 0xFC / 0xE2) 帧编解码及设备映射", () => {
    expect(parseMideaFrame(buildDehumidifierQuery()).deviceType).toBe(0xa1);

    const dehState = {
      ...defaultDehumidifierState(),
      power: true,
      mode: 4 as const, // 干衣模式
      targetHumidity: 45,
      currentHumidity: 68,
      currentTemperature: 23.5,
      fanSpeed: 80,
      tankFull: true,
      ion: true,
      swing: true,
      childLock: true,
    };
    const respFrame = buildDehumidifierStatusResponseFrame(dehState);
    const parsedDeh = parseDehumidifierResponse(respFrame)!;
    expect(parsedDeh.power).toBe(true);
    expect(parsedDeh.mode).toBe(4);
    expect(parsedDeh.targetHumidity).toBe(45);
    expect(parsedDeh.currentHumidity).toBe(68);
    expect(parsedDeh.currentTemperature).toBe(23.5);
    expect(parsedDeh.fanSpeed).toBe(80);
    expect(parsedDeh.tankFull).toBe(true);
    expect(parsedDeh.ion).toBe(true);
    expect(parsedDeh.swing).toBe(true);
    expect(parsedDeh.childLock).toBe(true);

    const dehSetParsed = parseMideaFrame(buildDehumidifierSet(dehState));
    expect(dehSetParsed.body[0]).toBe(0x48);
    expect(dehSetParsed.body[7]).toBe(45);
    expect(dehSetParsed.body[8]! & 0x80).toBe(0x80);
    expect(dehSetParsed.body[9]! & 0x40).toBe(0x40);
    expect(formatMideaMetrics(parsedDeh)).toBe("23.5°C 68%");

    // 0xFA 风扇、0xFC 空气净化器、0xE2 电热水器
    expect(parseMideaFrame(buildFanSet({ power: true, fanSpeed: 12, oscillate: true })).deviceType).toBe(0xfa);
    const fanResp = buildMideaFrame(0xfa, 0x03, new Uint8Array([0, 0, 0, 0, 0x03, 12, 0, 0, 1]), { includeCrc8: false });
    expect(parseFanResponse(fanResp)).toMatchObject({ power: true, mode: 1, fanSpeed: 12, oscillate: true });

    expect(parseMideaFrame(buildPurifierSet({ power: true, mode: 0x20, fanSpeed: 60 })).deviceType).toBe(0xfc);
    const purBody = new Uint8Array(18);
    purBody[0] = 0xc8;
    purBody[1] = 1;
    purBody[2] = 0x20;
    purBody[3] = 60;
    purBody[13] = 0;
    purBody[14] = 35; // PM2.5 = 35
    const parsedPur = parsePurifierResponse(buildMideaFrame(0xfc, 0x03, purBody))!;
    expect(parsedPur.pm25).toBe(35);
    expect(formatMideaMetrics(parsedPur)).toBe("PM2.5 35 μg/m³");

    expect(parseMideaFrame(buildWaterHeaterSet({ power: true, targetTemperature: 52 })).deviceType).toBe(0xe2);
    const whResp = buildMideaFrame(0xe2, 0x03, new Uint8Array([0x01, 0x01, 0x05, 0, 41, 52]), { includeCrc8: false });
    expect(parseWaterHeaterResponse(whResp)).toMatchObject({
      power: true,
      heating: true,
      currentTemperature: 41,
      targetTemperature: 52,
    });

    // 验证 DeviceInfo 与 MijiaDeck deviceControls 的完美对接
    const acInfo = mapMideaDeviceToInfo({
      id: "1001",
      name: "客厅空调",
      type: 0xac,
      homeName: "我的家",
      roomName: "客厅",
      online: true,
      protocolVersion: 3,
      source: "hybrid",
    });
    expect(acInfo.model).toBe("midea.air-conditioner.0xac");
    expect(acInfo.spec_type).toBe("urn:midea:device:air-conditioner:0xac:1");
    expect(supportsCardPower(acInfo)).toBe(true);

    const lightInfo = mapMideaDeviceToInfo({
      id: "1002",
      name: "美的吸顶灯",
      type: 0x13,
      homeName: "我的家",
      roomName: "卧室",
      online: true,
      protocolVersion: 2,
      source: "local",
    });
    expect(isLight(lightInfo)).toBe(true);
    expect(supportsCardPower(lightInfo)).toBe(true);
  });
});

describe("Midea 局域网真实 Loopback TCP (V2 & V3) 与广播发现解析", () => {
  test("9. 真实 TCP 回路服务器测试 LAN V2 (0x5A5A) 空调查询与写入", async () => {
    let deviceState: MideaAcState = {
      ...defaultAcState(),
      power: true,
      mode: 2,
      targetTemperature: 25,
      fanSpeed: 60,
      indoorTemperature: 27.5,
      outdoorTemperature: 33.0,
    };

    const { server, port } = await startTcpServer((socket) => {
      let rx: Buffer = Buffer.alloc(0);
      socket.on("data", (chunk: Buffer) => {
        rx = Buffer.concat([rx, chunk]);
        if (rx.length < 6) return;
        const len = rx.readUInt16LE(4);
        if (rx.length < len) return;
        const decoded = MideaLocalSecurity.decode5a5a(rx.subarray(0, len));
        const appFrame = parseMideaFrame(decoded.payload);

        if (appFrame.body[0] === 0x40) {
          deviceState = {
            ...deviceState,
            power: (appFrame.body[1]! & 0x01) > 0,
            mode: (((appFrame.body[2]! & 0xe0) >> 5) || 1) as MideaAcState["mode"],
            targetTemperature:
              (appFrame.body[2]! & 0x0f) + 16 + ((appFrame.body[2]! & 0x10) ? 0.5 : 0),
            fanSpeed: appFrame.body[3]! & 0x7f,
          };
        }

        const respApp = buildAcStatusResponseFrame(deviceState);
        const respPkt = MideaLocalSecurity.encode5a5a(respApp, decoded.applianceId);
        socket.write(respPkt);
      });
    });

    const client = new MideaLanClient({ timeoutMs: 3000, retries: 0 });
    try {
      const endpoint: MideaLanDeviceEndpoint = {
        id: "152839104215234",
        ip: "127.0.0.1",
        port,
        type: 0xac,
        protocolVersion: 2,
      };

      const queryReply = await client.sendFrame(endpoint, buildAcQuery());
      const queried = parseAcResponse(queryReply)!;
      expect(queried.power).toBe(true);
      expect(queried.targetTemperature).toBe(25);
      expect(queried.indoorTemperature).toBe(27.5);

      const setReply = await client.sendFrame(
        endpoint,
        buildAcSet({ ...queried, targetTemperature: 23.5, fanSpeed: 80 }),
      );
      const updated = parseAcResponse(setReply)!;
      expect(updated.targetTemperature).toBe(23.5);
      expect(updated.fanSpeed).toBe(80);
    } finally {
      client.close();
      await closeServer(server);
    }
  });

  test("10. 真实 TCP 回路服务器测试 LAN V3 (0x8370) 握手 + 加密空调查询与控制", async () => {
    const tokenHex = MIDEA_DEFAULT_KEYS[99]!.token;
    const keyHex = MIDEA_DEFAULT_KEYS[99]!.key;
    const expectedTokenBuf = Buffer.from(tokenHex, "hex");
    const keyBuf = Buffer.from(keyHex, "hex");

    let deviceState: MideaAcState = {
      ...defaultAcState(),
      power: false,
      mode: 4,
      targetTemperature: 22.0,
      fanSpeed: 40,
      indoorTemperature: 19.5,
      outdoorTemperature: 8.0,
    };

    const { server, port } = await startTcpServer((socket) => {
      const serverSec = new MideaLocalSecurity();
      let rx: Buffer = Buffer.alloc(0);

      socket.on("data", (chunk: Buffer) => {
        rx = Buffer.concat([rx, chunk]);
        const { packets, remainder } = serverSec.decode8370(rx);
        rx = remainder;

        for (const pkt of packets) {
          if (pkt.msgType === MSGTYPE_HANDSHAKE_REQUEST) {
            expect(pkt.payload.equals(expectedTokenBuf)).toBe(true);
            const plain32 = randomBytes(32);
            const resp64 = MideaLocalSecurity.createHandshakeResponse(plain32, keyBuf);
            const tcpKey = Buffer.alloc(32);
            for (let i = 0; i < 32; i++) tcpKey[i] = plain32[i]! ^ keyBuf[i]!;
            serverSec.setTcpKey(tcpKey);
            socket.write(serverSec.encode8370(resp64, MSGTYPE_HANDSHAKE_RESPONSE));
          } else if (pkt.msgType === MSGTYPE_ENCRYPTED_REQUEST) {
            const inner5a5a = MideaLocalSecurity.decode5a5a(pkt.payload);
            const appFrame = parseMideaFrame(inner5a5a.payload);
            if (appFrame.body[0] === 0x40) {
              deviceState = {
                ...deviceState,
                power: (appFrame.body[1]! & 0x01) > 0,
                mode: (((appFrame.body[2]! & 0xe0) >> 5) || 1) as MideaAcState["mode"],
                targetTemperature:
                  (appFrame.body[2]! & 0x0f) + 16 + ((appFrame.body[2]! & 0x10) ? 0.5 : 0),
                fanSpeed: appFrame.body[3]! & 0x7f,
              };
            }
            const respApp = buildAcStatusResponseFrame(deviceState);
            const resp5a5a = MideaLocalSecurity.encode5a5a(respApp, inner5a5a.applianceId);
            socket.write(serverSec.encode8370(resp5a5a, MSGTYPE_ENCRYPTED_RESPONSE));
          }
        }
      });
    });

    const client = new MideaLanClient({ timeoutMs: 3000, retries: 0 });
    try {
      const endpoint: MideaLanDeviceEndpoint = {
        id: "98765432101234",
        ip: "127.0.0.1",
        port,
        type: 0xac,
        protocolVersion: 3,
        token: tokenHex,
        key: keyHex,
      };

      const qReply = await client.sendFrame(endpoint, buildAcQuery());
      const qState = parseAcResponse(qReply)!;
      expect(qState.power).toBe(false);
      expect(qState.mode).toBe(4);
      expect(qState.indoorTemperature).toBe(19.5);

      const sReply = await client.sendFrame(
        endpoint,
        buildAcSet({ ...qState, power: true, targetTemperature: 26.5, fanSpeed: 102 }),
      );
      const sState = parseAcResponse(sReply)!;
      expect(sState.power).toBe(true);
      expect(sState.targetTemperature).toBe(26.5);
      expect(sState.fanSpeed).toBe(102);
    } finally {
      client.close();
      await closeServer(server);
    }
  });

  test("11. 局域网广播发现响应解析器支持 V2 (0x5A5A) 与 V3 (0x8370)", () => {
    const buildPayload = (ipBytes: [number, number, number, number], sn: string, ssid: string): Buffer => {
      const buf = Buffer.alloc(64, 0);
      buf[0] = ipBytes[3];
      buf[1] = ipBytes[2];
      buf[2] = ipBytes[1];
      buf[3] = ipBytes[0];
      buf.writeUInt32LE(6444, 4);
      Buffer.from(sn, "ascii").copy(buf, 8);
      buf[40] = ssid.length;
      Buffer.from(ssid, "ascii").copy(buf, 41);
      return buf;
    };

    const payloadV2 = buildPayload([192, 168, 31, 88], "0000AC1234567890123456", "midea_ac_1234");
    const pktV2 = MideaLocalSecurity.encode5a5a(payloadV2, 112233445566n, { msgType: 0x92 });
    const parsedV2 = parseDiscoveryResponse(pktV2, "192.168.31.88")!;
    expect(parsedV2.id).toBe("112233445566");
    expect(parsedV2.ip).toBe("192.168.31.88");
    expect(parsedV2.port).toBe(6444);
    expect(parsedV2.type).toBe(0xac);
    expect(parsedV2.protocolVersion).toBe(2);
    expect(parsedV2.sn8).toBe("45678901");

    const payloadV3 = buildPayload([192, 168, 31, 99], "0000A19876543210987654", "midea_a1_5678");
    const inner5a5a = MideaLocalSecurity.encode5a5a(payloadV3, 665544332211n, { msgType: 0x92 });
    const v3Header = Buffer.from([0x83, 0x70, 0x00, inner5a5a.length, 0x20, 0x00]);
    const parsedV3 = parseDiscoveryResponse(Buffer.concat([v3Header, inner5a5a]), "192.168.31.99")!;
    expect(parsedV3.id).toBe("665544332211");
    expect(parsedV3.ip).toBe("192.168.31.99");
    expect(parsedV3.type).toBe(0xa1);
    expect(parsedV3.protocolVersion).toBe(3);
  });
});

describe("MideaCloudClient 模拟 HTTP 协议流程", () => {
  test("12. 美的美居 (Meiju) 登录、家庭/设备发现（含加密 SN 解密）、getTokens 与云端透传", async () => {
    const serverSec = new MideaCloudSecurity("meiju");
    const sessionKeyPlain = "a1b2c3d4e5f60708";
    const encryptedSessionKey = serverSec.aesEncryptWithFixedKey(sessionKeyPlain);
    serverSec.setAesKeys(sessionKeyPlain);
    const encryptedSn = serverSec.aesEncrypt("0000AC123SN888888123456");

    const acReplyFrame = buildAcStatusResponseFrame({
      ...defaultAcState(),
      power: true,
      mode: 2,
      targetTemperature: 24,
      indoorTemperature: 25.5,
    });
    const encryptedReply = serverSec.aesEncrypt(acReplyFrame.toString("hex"));

    const calls: string[] = [];
    const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push(url);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers["sign"]).toBeDefined();
      expect(headers["random"]).toBeDefined();

      if (url.includes("/v1/user/login/id/get")) {
        return jsonResponse({ code: "0", data: { loginId: "login-meiju-1" } });
      }
      if (url.includes("/mj/user/login")) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        expect(body.iotData.iampwd).toBe(serverSec.encryptIamPassword("login-meiju-1", "MyPass!99"));
        return jsonResponse({
          code: "0",
          data: {
            uid: "uid-888",
            key: encryptedSessionKey,
            mdata: { accessToken: "tok-meiju-access" },
          },
        });
      }
      if (url.includes("/v1/homegroup/list/get")) {
        expect(headers["accessToken"]).toBe("tok-meiju-access");
        return jsonResponse({
          code: "0",
          data: { homeList: [{ homegroupId: "home-1", name: "幸福之家", isDefault: "1" }] },
        });
      }
      if (url.includes("/v1/appliance/home/list/get")) {
        return jsonResponse({
          code: "0",
          data: {
            homeList: [
              {
                homegroupId: "home-1",
                name: "幸福之家",
                roomList: [
                  {
                    name: "主卧",
                    applianceList: [
                      {
                        applianceCode: "152839104215234",
                        name: "主卧变频空调",
                        type: "0xAC",
                        sn: encryptedSn,
                        modelNumber: "KFR-35GW",
                        onlineStatus: "1",
                      },
                    ],
                  },
                ],
              },
            ],
          },
        });
      }
      if (url.includes("/v1/iot/secure/getToken")) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        expect(Array.isArray(body.udplist)).toBe(true);
        expect(body.udplist.length).toBeGreaterThanOrEqual(2);
        return jsonResponse({
          code: "0",
          data: {
            tokenlist: [
              {
                udpId: body.udplist[0],
                token: "aa".repeat(64),
                key: "bb".repeat(32),
              },
            ],
          },
        });
      }
      if (url.includes("/v1/appliance/transparent/send")) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        expect(body.applianceCode).toBe("152839104215234");
        expect(body.applianceId).toBeUndefined();
        expect(body.timestamp).toBe("true");
        expect(body.isFull).toBe("false");
        return jsonResponse({ code: "0", data: { reply: encryptedReply } });
      }
      return jsonResponse({ code: "404", msg: "unknown" }, 404);
    }) as typeof fetch;

    const client = new MideaCloudClient({
      brand: "meiju",
      account: "13800138000",
      password: "MyPass!99",
      httpFetch: mockFetch,
    });

    const session = await client.login();
    expect(session.uid).toBe("uid-888");
    expect(client.isLoggedIn).toBe(true);

    const homes = await client.listHomes();
    expect(homes).toEqual([{ homeId: "home-1", name: "幸福之家", isDefault: true }]);

    const appliances = await client.listAppliances();
    expect(appliances.length).toBe(1);
    expect(appliances[0]).toMatchObject({
      id: "152839104215234",
      name: "主卧变频空调",
      type: 0xac,
      sn: "0000AC123SN888888123456",
      sn8: "SN888888",
      homeName: "幸福之家",
      roomName: "主卧",
      online: true,
    });

    const tokens = await client.getTokens("152839104215234");
    expect(tokens.length).toBe(2);
    expect(tokens[0]!.token).toBe("aa".repeat(64));
    expect(tokens[1]!.isDefaultFallback).toBe(true);
    expect(tokens[1]!.token).toBe(MIDEA_DEFAULT_KEYS[99]!.token);

    const replyBuf = await client.sendTransparentCommand("152839104215234", buildAcQuery());
    expect(replyBuf).not.toBeNull();
    expect(parseAcResponse(replyBuf!)!.indoorTemperature).toBe(25.5);
    expect(calls.length).toBeGreaterThanOrEqual(6);
  });

  test("13. NetHomePlus 旧版表单协议登录与设备拉取", async () => {
    const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const bodyStr = String(init?.body ?? "");
      expect(bodyStr).toContain("sign=");

      if (url.endsWith("/v1/user/login/id/get")) {
        return jsonResponse({ errorCode: "0", result: { loginId: "legacy-id-1" } });
      }
      if (url.endsWith("/v1/user/login")) {
        return jsonResponse({ errorCode: "0", result: { sessionId: "sess-legacy-1", userId: "u-9" } });
      }
      if (url.endsWith("/v1/appliance/user/list/get")) {
        expect(bodyStr).toContain("sessionId=sess-legacy-1");
        return jsonResponse({
          errorCode: "0",
          result: {
            list: [
              { id: "200001", name: "NetHome 除湿机", type: "0xA1", onlineStatus: "1", sn: "0000A100012345678" },
            ],
          },
        });
      }
      return jsonResponse({ errorCode: "404" }, 404);
    }) as typeof fetch;

    const client = new MideaCloudClient({
      brand: "nethomeplus",
      account: "user@nethome.test",
      password: "LegacyPassword",
      httpFetch: mockFetch,
    });

    const session = await client.login();
    expect(session.sessionId).toBe("sess-legacy-1");

    const devices = await client.listAppliances();
    expect(devices.length).toBe(1);
    expect(devices[0]!.type).toBe(0xa1);
    expect(devices[0]!.name).toBe("NetHome 除湿机");
  });
});

describe("MideaPlatformProvider 端到端集成、降级回退与凭据脱敏", () => {
  let tempDir = "";

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "mijiadeck-midea-test-"));
    setDataPathOverrides({
      dataDir: () => tempDir,
      dataFile: (filename) => path.join(tempDir, filename),
    });
  });

  afterEach(() => {
    setDataPathOverrides(null);
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = "";
    }
  });

  test("14. Hybrid 端到端：configure、listDevices、deviceDetail、writeProp、togglePower、readMetrics 与 LAN->Cloud 自动回退", async () => {
    let liveAcState: MideaAcState = {
      ...defaultAcState(),
      power: true,
      mode: 2,
      targetTemperature: 25.0,
      fanSpeed: 60,
      indoorTemperature: 26.5,
      outdoorTemperature: 32.0,
    };
    let forceLanError = false;
    const lanCalls: string[] = [];
    const cloudTransparentCalls: string[] = [];

    const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/v1/user/login/id/get")) {
        return jsonResponse({ code: "0", data: { loginId: "login-hybrid" } });
      }
      if (url.includes("/mj/user/login")) {
        return jsonResponse({
          code: "0",
          data: { uid: "u-hybrid", mdata: { accessToken: "hybrid-access-secret" } },
        });
      }
      if (url.includes("/v1/homegroup/list/get")) {
        return jsonResponse({
          code: "0",
          data: { homeList: [{ homegroupId: "h1", name: "测试家庭", isDefault: "1" }] },
        });
      }
      if (url.includes("/v1/appliance/home/list/get")) {
        return jsonResponse({
          code: "0",
          data: {
            homeList: [
              {
                homegroupId: "h1",
                name: "测试家庭",
                roomList: [
                  {
                    name: "客厅",
                    applianceList: [
                      {
                        applianceCode: "152839104215234",
                        name: "客厅美的空调",
                        type: "0xAC",
                        onlineStatus: "1",
                        modelNumber: "KFR-72LW",
                      },
                    ],
                  },
                ],
              },
            ],
          },
        });
      }
      if (url.includes("/v1/iot/secure/getToken")) {
        return jsonResponse({
          code: "0",
          data: {
            tokenlist: [{ token: "11".repeat(64), key: "22".repeat(32) }],
          },
        });
      }
      if (url.includes("/v1/appliance/transparent/send")) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        expect(body.applianceId).toBeUndefined();
        expect(body.applianceCode).toBe("152839104215234");
        cloudTransparentCalls.push(String(body.applianceCode));
        const sec = new MideaCloudSecurity("meiju");
        const signedCsv = sec.aesDecrypt(String(body.order));
        const rawBytes = Buffer.from(
          signedCsv.split(",").map((n) => Number.parseInt(n, 10) & 0xff),
        );
        const appFrame = parseMideaFrame(rawBytes);
        if (appFrame.body[0] === 0x40) {
          liveAcState = {
            ...liveAcState,
            power: (appFrame.body[1]! & 0x01) > 0,
            mode: (((appFrame.body[2]! & 0xe0) >> 5) || 1) as MideaAcState["mode"],
            targetTemperature:
              (appFrame.body[2]! & 0x0f) + 16 + ((appFrame.body[2]! & 0x10) ? 0.5 : 0),
            fanSpeed: appFrame.body[3]! & 0x7f,
          };
        }
        const replyFrame = buildAcStatusResponseFrame(liveAcState);
        return jsonResponse({ code: "0", data: { reply: replyFrame.toString("hex") } });
      }
      return jsonResponse({ code: "404" }, 404);
    }) as typeof fetch;

    const mockLan: IMideaLanTransport = {
      async sendFrame(endpoint, frame) {
        lanCalls.push(`${endpoint.ip}:v${endpoint.protocolVersion}`);
        if (forceLanError) {
          throw new Error("Simulated LAN timeout");
        }
        const appFrame = parseMideaFrame(frame);
        if (appFrame.body[0] === 0x40) {
          liveAcState = {
            ...liveAcState,
            power: (appFrame.body[1]! & 0x01) > 0,
            mode: (((appFrame.body[2]! & 0xe0) >> 5) || 1) as MideaAcState["mode"],
            targetTemperature:
              (appFrame.body[2]! & 0x0f) + 16 + ((appFrame.body[2]! & 0x10) ? 0.5 : 0),
            fanSpeed: appFrame.body[3]! & 0x7f,
          };
        }
        return buildAcStatusResponseFrame(liveAcState);
      },
      async discover() {
        return [
          {
            id: "152839104215234",
            ip: "192.168.1.201",
            port: 6444,
            type: 0xac,
            protocolVersion: 3,
            sn: "0000AC1234567890123456",
            sn8: "45678901",
          },
        ];
      },
    };

    const provider = new MideaPlatformProvider({
      httpFetch: mockFetch,
      lanTransport: mockLan,
    });

    expect(provider.id).toBe("midea");
    expect(provider.metadata).toEqual(MIDEA_PLATFORM_METADATA);

    const status = await provider.configure({
      enabled: true,
      mode: "hybrid",
      cloudBrand: "meiju",
      account: "13900139000",
      password: "SuperSecretPassword!42",
      preferLocal: true,
    });
    expect(status.connected).toBe(true);
    expect(status.authMode).toBe("hybrid");
    expect(status.configSummary["hasPassword"]).toBe(true);

    // 二次配置密码留空应保留已有密码
    const status2 = await provider.configure({
      enabled: true,
      mode: "hybrid",
      cloudBrand: "meiju",
      account: "13900139000",
      password: "",
      preferLocal: true,
    });
    expect(status2.connected).toBe(true);

    const devices = await provider.listDevices();
    expect(devices.length).toBe(1);
    expect(devices[0]).toMatchObject({
      did: "152839104215234",
      name: "客厅美的空调",
      model: "midea.air-conditioner.0xac",
      spec_type: "urn:midea:device:air-conditioner:0xac:1",
      home_name: "测试家庭",
      room_name: "客厅",
      online: true,
      platform: "midea",
    });

    const detail = await provider.deviceDetail("152839104215234");
    expect(detail.props.some((p) => p.name === "target-temperature" && p.writable)).toBe(true);
    expect(detail.props.some((p) => p.name === "mode" && p.value_list?.length === 5)).toBe(true);
    expect(detail.props.some((p) => p.name === "fan-speed" && p.value_list?.length === 6)).toBe(true);

    // 通过局域网写入目标温度、模式与风速
    await provider.writeProp("152839104215234", "target-temperature", 23.5);
    await provider.writeProp("152839104215234", "mode", 4);
    await provider.writeProp("152839104215234", "fan-speed", 80);
    expect(lanCalls.length).toBeGreaterThanOrEqual(3);
    expect(liveAcState.targetTemperature).toBe(23.5);
    expect(liveAcState.mode).toBe(4);
    expect(liveAcState.fanSpeed).toBe(80);

    // 切换电源开关
    const afterToggle = await provider.togglePower("152839104215234");
    expect(afterToggle).toBe(false);
    expect(await provider.powerState("152839104215234")).toBe(false);

    // 读取温湿度指标
    const metrics = await provider.readMetrics(["152839104215234"]);
    expect(metrics["152839104215234"]).toBe("26.5°C");

    // 模拟 LAN 超时故障 -> 自动无缝回退至 Cloud 透传
    forceLanError = true;
    await provider.writeProp("152839104215234", "target-temperature", 26.0);
    expect(cloudTransparentCalls).toContain("152839104215234");
    expect(liveAcState.targetTemperature).toBe(26.0);
  });

  test("15. 凭据脱敏、控制访问限制与 disconnect 清理", async () => {
    const secretPwd = "TopSecret_Midea_Pwd_9876";
    const secretToken = "cc".repeat(64);
    const secretKey = "dd".repeat(32);

    const provider = new MideaPlatformProvider({
      lanTransport: {
        async sendFrame(_ep, _frame) {
          return buildAcStatusResponseFrame({ ...defaultAcState(), power: true, indoorTemperature: 24 });
        },
        async discover() {
          return [];
        },
      },
    });

    const st = await provider.configure({
      enabled: true,
      mode: "local",
      localDevices: [
        {
          id: "888001",
          name: "书房空调",
          ip: "192.168.1.50",
          port: 6444,
          type: 0xac,
          protocolVersion: 3,
          token: secretToken,
          key: secretKey,
          room: "书房",
        },
      ],
      password: secretPwd,
    });

    const serializedStatus = JSON.stringify(st);
    expect(serializedStatus).not.toContain(secretPwd);
    expect(serializedStatus).not.toContain(secretToken);
    expect(serializedStatus).not.toContain(secretKey);

    const devices = await provider.listDevices();
    const report = await provider.diagnosticReport(devices[0]!);
    expect(report).not.toContain(secretPwd);
    expect(report).not.toContain(secretToken);
    expect(report).not.toContain(secretKey);

    // 控制访问限制生效
    provider.setControlAccess("当前处于只读模式");
    await expect(provider.writeProp("888001", "on", false)).rejects.toThrow("当前处于只读模式");
    provider.setControlAccess("");

    // 断开连接并清理凭据
    await provider.disconnect();
    expect(provider.isEnabled()).toBe(false);
    expect(provider.isConnected()).toBe(false);
    expect(provider.status().state).toBe("disconnected");
    expect(provider.status().configSummary["hasPassword"]).toBe(false);
  });

  test("16. MAS 透传严格使用 applianceCode（避免 1001）、Legacy 保留 applianceId、处理 1306 与 aa 开头密文", async () => {
    const serverSec = new MideaCloudSecurity("meiju");
    const sessionKeyPlain = "1122334455667788";
    const encryptedSessionKey = serverSec.aesEncryptWithFixedKey(sessionKeyPlain);
    serverSec.setAesKeys(sessionKeyPlain);

    const acReplyFrame = buildAcStatusResponseFrame({
      ...defaultAcState(),
      power: true,
      mode: 4,
      targetTemperature: 23.5,
      indoorTemperature: 21.5,
    });
    const signedCsvReply = Array.from(acReplyFrame)
      .map((b) => (b > 127 ? b - 256 : b))
      .join(",");
    const encryptedCsvReply = serverSec.aesEncrypt(signedCsvReply);

    let transparentMode: "ok" | "1306" = "ok";
    const mockMeijuFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/v1/user/login/id/get")) {
        return jsonResponse({ code: "0", data: { loginId: "login-1001" } });
      }
      if (url.includes("/mj/user/login")) {
        return jsonResponse({
          code: "0",
          data: { uid: "uid-1001", key: encryptedSessionKey, mdata: { accessToken: "tok-1001" } },
        });
      }
      if (url.includes("/v1/appliance/transparent/send")) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        // 真实美的 MAS 网关：若缺少 applianceCode 则报错 (1001): Invalid param wrong format: null
        if (!body.applianceCode || body.applianceId !== undefined) {
          return jsonResponse({ code: "1001", msg: "Invalid param wrong format: null" });
        }
        expect(body.timestamp).toBe("true");
        expect(body.isFull).toBe("false");
        if (transparentMode === "1306") {
          return jsonResponse({ code: "1306", msg: "The async reply does not exist " });
        }
        return jsonResponse({ code: "0", data: { reply: encryptedCsvReply } });
      }
      return jsonResponse({ code: "404" }, 404);
    }) as typeof fetch;

    const meijuClient = new MideaCloudClient({
      brand: "meiju",
      account: "13800138000",
      password: "Password!1",
      httpFetch: mockMeijuFetch,
    });

    // 正常加密逗号分隔字节流回复可完整解码
    const replyBuf = await meijuClient.sendTransparentCommand("210006741641007", buildAcQuery());
    expect(replyBuf).not.toBeNull();
    expect(parseAcResponse(replyBuf!)).toMatchObject({
      power: true,
      mode: 4,
      targetTemperature: 23.5,
      indoorTemperature: 21.5,
    });

    // 1306 异步应答缺失：默认抛错，写指令允许时返回 null
    transparentMode = "1306";
    await expect(
      meijuClient.sendTransparentCommand("210006741641007", buildAcQuery()),
    ).rejects.toThrow("1306");
    const tolerated = await meijuClient.sendTransparentCommand(
      "210006741641007",
      buildAcSet({ power: false }),
      { allowAsyncReplyMissing: true },
    );
    expect(tolerated).toBeNull();

    // 构造一条 AES 密文恰好以 "aa" 开头的有效回复，验证不会误判为明文 0xAA 帧
    let aaPrefixedKey = "";
    let aaPrefixedCipher = "";
    const aaFrame = buildAcStatusResponseFrame({
      ...defaultAcState(),
      power: true,
      targetTemperature: 25,
      fanSpeed: 60,
      indoorTemperature: 22,
    });
    const aaCsv = Array.from(aaFrame)
      .map((b) => (b > 127 ? b - 256 : b))
      .join(",");
    for (let k = 0; k < 4096; k++) {
      const candidateKey = `mideakey${String(k).padStart(8, "0")}`;
      const tmpSec = new MideaCloudSecurity("meiju");
      tmpSec.setAesKeys(candidateKey);
      const cipher = tmpSec.aesEncrypt(aaCsv);
      if (cipher.startsWith("aa")) {
        aaPrefixedKey = candidateKey;
        aaPrefixedCipher = cipher;
        break;
      }
    }
    expect(aaPrefixedCipher.startsWith("aa")).toBe(true);
    const aaEncryptedSessionKey = new MideaCloudSecurity("meiju").aesEncryptWithFixedKey(aaPrefixedKey);
    const aaFetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/v1/user/login/id/get")) {
        return jsonResponse({ code: "0", data: { loginId: "login-aa" } });
      }
      if (url.includes("/mj/user/login")) {
        return jsonResponse({
          code: "0",
          data: { uid: "uid-aa", key: aaEncryptedSessionKey, mdata: { accessToken: "tok-aa" } },
        });
      }
      if (url.includes("/v1/appliance/transparent/send")) {
        return jsonResponse({ code: "0", data: { reply: aaPrefixedCipher } });
      }
      return jsonResponse({ code: "404" }, 404);
    }) as typeof fetch;
    const aaClient = new MideaCloudClient({
      brand: "meiju",
      account: "13800138000",
      password: "Password!1",
      httpFetch: aaFetch,
    });
    const decodedAa = await aaClient.sendTransparentCommand("210006741641007", buildAcQuery());
    expect(decodedAa).not.toBeNull();
    expect(parseAcResponse(decodedAa!)?.indoorTemperature).toBe(22);

    // Legacy 协议仍保留 applianceId + funId=0000
    let legacyBody = "";
    const legacyFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith("/v1/user/login/id/get")) {
        return jsonResponse({ errorCode: "0", result: { loginId: "leg-1" } });
      }
      if (url.endsWith("/v1/user/login")) {
        return jsonResponse({ errorCode: "0", result: { sessionId: "sess-leg-1", userId: "u-leg" } });
      }
      if (url.endsWith("/v1/appliance/transparent/send")) {
        legacyBody = String(init?.body ?? "");
        return jsonResponse({ errorCode: "0", result: { reply: acReplyFrame.toString("hex") } });
      }
      return jsonResponse({ errorCode: "404" }, 404);
    }) as typeof fetch;
    const legacyClient = new MideaCloudClient({
      brand: "nethomeplus",
      account: "u@example.com",
      password: "LegacyPassword",
      httpFetch: legacyFetch,
    });
    const legacyReply = await legacyClient.sendTransparentCommand("300001", buildAcQuery());
    expect(legacyBody).toContain("applianceId=300001");
    expect(legacyBody).toContain("funId=0000");
    expect(parseAcResponse(legacyReply!)?.targetTemperature).toBe(23.5);
  });

  test("17. 云端 Token 失效 (40002) 自动重登并重试请求", async () => {
    let loginCount = 0;
    let statusCalls = 0;

    const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (url.includes("/v1/user/login/id/get")) {
        return jsonResponse({ code: "0", data: { loginId: `login-${loginCount + 1}` } });
      }
      if (url.includes("/mj/user/login")) {
        loginCount += 1;
        return jsonResponse({
          code: "0",
          data: { uid: "u-relogin", mdata: { accessToken: `tok-${loginCount}` } },
        });
      }
      if (url.includes("/mjl/v1/device/status/lua/get")) {
        statusCalls += 1;
        if (headers["accessToken"] === "tok-1") {
          return jsonResponse({ code: "40002", msg: "user token not exist" });
        }
        return jsonResponse({ code: "0", data: { power: "on", temperature: 25 } });
      }
      return jsonResponse({ code: "404" }, 404);
    }) as typeof fetch;

    const client = new MideaCloudClient({
      brand: "meiju",
      account: "13800138000",
      password: "Password!1",
      httpFetch: mockFetch,
    });

    const data = await client.getLuaStatus("210006741641007");
    expect(data["power"]).toBe("on");
    expect(loginCount).toBe(2);
    expect(statusCalls).toBe(2);
  });

  test("18. Cloud 模式全链路：0xDC/0xD9 走 Lua 读写，0xAC 透传 1306 回退 Lua，并发 powerStates 合并加载", async () => {
    const serverSec = new MideaCloudSecurity("meiju");
    const sessionKeyPlain = "aabbccddeeff0011";
    const encryptedSessionKey = serverSec.aesEncryptWithFixedKey(sessionKeyPlain);
    serverSec.setAesKeys(sessionKeyPlain);

    let listHomeCalls = 0;
    let acTransparentFailsWith1306 = true;
    const luaControls: Array<{ applianceCode: string; control: Record<string, unknown> }> = [];
    const transparentCodes: string[] = [];

    const luaStateByCode: Record<string, Record<string, unknown>> = {
      "210006741641007": {
        power: "on",
        mode: "cool",
        temperature: 24,
        small_temperature: 0.5,
        wind_speed: 60,
        indoor_temperature: 22.4,
        ptc: "on",
        screen_display_now: "on",
      },
      "210006738408610": {
        power: "on",
        program: "mixed_wash",
        running_status: 1,
      },
      "210006741790988": {
        db_power: "off",
        db_running_status: "off",
        db_program: "single_drying",
      },
    };

    const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const body = init?.body ? JSON.parse(String(init.body)) : {};

      if (url.includes("/v1/user/login/id/get")) {
        return jsonResponse({ code: "0", data: { loginId: "login-cloud-all" } });
      }
      if (url.includes("/mj/user/login")) {
        return jsonResponse({
          code: "0",
          data: {
            uid: "u-cloud-all",
            key: encryptedSessionKey,
            mdata: { accessToken: "tok-cloud-all" },
          },
        });
      }
      if (url.includes("/v1/homegroup/list/get")) {
        listHomeCalls += 1;
        return jsonResponse({
          code: "0",
          data: { homeList: [{ homegroupId: "h-1", name: "方寸别院", isDefault: "1" }] },
        });
      }
      if (url.includes("/v1/appliance/home/list/get")) {
        return jsonResponse({
          code: "0",
          data: {
            homeList: [
              {
                homegroupId: "h-1",
                name: "方寸别院",
                roomList: [
                  {
                    name: "客厅",
                    applianceList: [
                      {
                        applianceCode: "210006741641007",
                        name: "大空调",
                        type: "0xAC",
                        onlineStatus: "1",
                        sn8: "22251749",
                      },
                      {
                        applianceCode: "210006738408610",
                        name: "干衣机",
                        type: "0xDC",
                        onlineStatus: "1",
                        sn8: "38210481",
                      },
                      {
                        applianceCode: "210006741790988",
                        name: "美的可爱多",
                        type: "0xD9",
                        onlineStatus: "1",
                        sn8: "38135636",
                      },
                    ],
                  },
                ],
              },
            ],
          },
        });
      }
      if (url.includes("/v1/appliance/transparent/send")) {
        expect(body.applianceId).toBeUndefined();
        expect(typeof body.applianceCode).toBe("string");
        transparentCodes.push(String(body.applianceCode));
        if (acTransparentFailsWith1306) {
          return jsonResponse({ code: "1306", msg: "The async reply does not exist " });
        }
        const replyFrame = buildAcStatusResponseFrame({
          ...defaultAcState(),
          power: false,
          mode: 1,
          targetTemperature: 26,
          indoorTemperature: 22,
        });
        const csv = Array.from(replyFrame)
          .map((b) => (b > 127 ? b - 256 : b))
          .join(",");
        return jsonResponse({ code: "0", data: { reply: serverSec.aesEncrypt(csv) } });
      }
      if (url.includes("/mjl/v1/device/status/lua/get")) {
        const code = String(body.applianceCode ?? "");
        const st = luaStateByCode[code];
        if (!st) return jsonResponse({ code: "1014", msg: "lua analysis exception" });
        return jsonResponse({ code: "0", data: st });
      }
      if (url.includes("/mjl/v1/device/lua/control")) {
        const code = String(body.applianceCode ?? "");
        const ctrl = (body.command?.control ?? {}) as Record<string, unknown>;
        luaControls.push({ applianceCode: code, control: ctrl });
        luaStateByCode[code] = { ...(luaStateByCode[code] ?? {}), ...ctrl };
        return jsonResponse({ code: "0", data: luaStateByCode[code] });
      }
      return jsonResponse({ code: "404" }, 404);
    }) as typeof fetch;

    const provider = new MideaPlatformProvider({
      httpFetch: mockFetch,
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

    // 冷启动并发读取三台不同品类设备的开关状态，只应触发 1 次 listDevices/listHomes
    const states = await provider.powerStates([
      "210006741641007",
      "210006738408610",
      "210006741790988",
    ]);
    expect(listHomeCalls).toBe(1);
    expect(states).toEqual({
      "210006741641007": true, // 0xAC 透传 1306 后自动回退 Lua 拿到 power=on
      "210006738408610": true, // 0xDC 直接走 Lua 拿到 power=on
      "210006741790988": false, // 0xD9 直接走 Lua 拿到 db_power=off
    });
    // 0xDC 与 0xD9 未触发无意义的通用二进制透传
    expect(transparentCodes).toEqual(["210006741641007"]);

    // 0xAC 回退 Lua 读取实时温控属性无报错
    const acProps = await provider.readProps("210006741641007", [
      "on",
      "mode",
      "target-temperature",
      "temperature",
      "aux-heat",
    ]);
    expect(acProps).toEqual({
      on: true,
      mode: 2,
      "target-temperature": 24.5,
      temperature: 22.4,
      "aux-heat": true,
    });

    // 0xDC 与 0xD9 开关控制自动走 /mjl/v1/device/lua/control 并匹配对应键名
    await provider.setPowerState("210006738408610", false);
    await provider.setPowerState("210006741790988", true);
    expect(luaControls).toEqual([
      { applianceCode: "210006738408610", control: { power: "off" } },
      { applianceCode: "210006741790988", control: { db_power: "on" } },
    ]);

    // 0xAC 关机遇到 1306 异步应答缺失也应视作送达成功（不误报控制失败）
    await provider.setPowerState("210006741641007", false);

    // 恢复 0xAC 透传正常后，直接读取到最新 0xAA 状态帧
    acTransparentFailsWith1306 = false;
    const acAfter = await provider.readProps("210006741641007", ["on", "target-temperature", "temperature"]);
    expect(acAfter).toEqual({
      on: false,
      "target-temperature": 26,
      temperature: 22,
    });
  });
});
