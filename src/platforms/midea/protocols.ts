// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 美的家电 0xAA 串口应用层帧编解码（对齐 midea_ac_lan & mill1000/midea-msmart）

/**
 * 美的 CRC8-854 查找表（CRC-8/MAXIM-DOW，反射多项式 0x8C，与 `msmart/crc8.py` 逐字节一致）。
 */
export const CRC8_854_TABLE = new Uint8Array([
  0x00, 0x5e, 0xbc, 0xe2, 0x61, 0x3f, 0xdd, 0x83, 0xc2, 0x9c, 0x7e, 0x20, 0xa3, 0xfd, 0x1f, 0x41,
  0x9d, 0xc3, 0x21, 0x7f, 0xfc, 0xa2, 0x40, 0x1e, 0x5f, 0x01, 0xe3, 0xbd, 0x3e, 0x60, 0x82, 0xdc,
  0x23, 0x7d, 0x9f, 0xc1, 0x42, 0x1c, 0xfe, 0xa0, 0xe1, 0xbf, 0x5d, 0x03, 0x80, 0xde, 0x3c, 0x62,
  0xbe, 0xe0, 0x02, 0x5c, 0xdf, 0x81, 0x63, 0x3d, 0x7c, 0x22, 0xc0, 0x9e, 0x1d, 0x43, 0xa1, 0xff,
  0x46, 0x18, 0xfa, 0xa4, 0x27, 0x79, 0x9b, 0xc5, 0x84, 0xda, 0x38, 0x66, 0xe5, 0xbb, 0x59, 0x07,
  0xdb, 0x85, 0x67, 0x39, 0xba, 0xe4, 0x06, 0x58, 0x19, 0x47, 0xa5, 0xfb, 0x78, 0x26, 0xc4, 0x9a,
  0x65, 0x3b, 0xd9, 0x87, 0x04, 0x5a, 0xb8, 0xe6, 0xa7, 0xf9, 0x1b, 0x45, 0xc6, 0x98, 0x7a, 0x24,
  0xf8, 0xa6, 0x44, 0x1a, 0x99, 0xc7, 0x25, 0x7b, 0x3a, 0x64, 0x86, 0xd8, 0x5b, 0x05, 0xe7, 0xb9,
  0x8c, 0xd2, 0x30, 0x6e, 0xed, 0xb3, 0x51, 0x0f, 0x4e, 0x10, 0xf2, 0xac, 0x2f, 0x71, 0x93, 0xcd,
  0x11, 0x4f, 0xad, 0xf3, 0x70, 0x2e, 0xcc, 0x92, 0xd3, 0x8d, 0x6f, 0x31, 0xb2, 0xec, 0x0e, 0x50,
  0xaf, 0xf1, 0x13, 0x4d, 0xce, 0x90, 0x72, 0x2c, 0x6d, 0x33, 0xd1, 0x8f, 0x0c, 0x52, 0xb0, 0xee,
  0x32, 0x6c, 0x8e, 0xd0, 0x53, 0x0d, 0xef, 0xb1, 0xf0, 0xae, 0x4c, 0x12, 0x91, 0xcf, 0x2d, 0x73,
  0xca, 0x94, 0x76, 0x28, 0xab, 0xf5, 0x17, 0x49, 0x08, 0x56, 0xb4, 0xea, 0x69, 0x37, 0xd5, 0x8b,
  0x57, 0x09, 0xeb, 0xb5, 0x36, 0x68, 0x8a, 0xd4, 0x95, 0xcb, 0x29, 0x77, 0xf4, 0xaa, 0x48, 0x16,
  0xe9, 0xb7, 0x55, 0x0b, 0x88, 0xd6, 0x34, 0x6a, 0x2b, 0x75, 0x97, 0xc9, 0x4a, 0x14, 0xf6, 0xa8,
  0x74, 0x2a, 0xc8, 0x96, 0x15, 0x4b, 0xa9, 0xf7, 0xb6, 0xe8, 0x0a, 0x54, 0xd7, 0x89, 0x6b, 0x35,
]);

export function mideaCrc8(data: Uint8Array): number {
  let crc = 0;
  for (let i = 0; i < data.length; i++) {
    crc = CRC8_854_TABLE[(crc ^ data[i]!) & 0xff]!;
  }
  return crc & 0xff;
}

/**
 * 帧校验和：`(~sum(frame[1:-1]) + 1) & 0xFF`。
 */
export function mideaChecksum(data: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    sum = (sum + data[i]!) & 0xff;
  }
  return (~sum + 1) & 0xff;
}

export interface MideaFrameOptions {
  protocolVersion?: number;
  includeCrc8?: boolean;
}

export interface ParsedMideaFrame {
  deviceType: number;
  protocolVersion: number;
  frameType: number;
  body: Buffer;
  rawBody: Buffer;
  crcValid: boolean;
  checksumValid: boolean;
  rawFrame: Buffer;
}

/**
 * 构造美的 `0xAA` 串口协议帧：
 * - Header (10B): `[0xAA, len, deviceType, 0x00, 0x00, 0x00, 0x00, 0x00, protocolVersion, frameType]`
 * - Body + 可选 CRC8 (1B)
 * - Checksum (1B): `(~sum(frame[1:-1]) + 1) & 0xFF`
 */
export function buildMideaFrame(
  deviceType: number,
  frameType: number,
  body: Uint8Array,
  options?: MideaFrameOptions,
): Buffer {
  const includeCrc8 = options?.includeCrc8 !== false;
  const protocolVersion = options?.protocolVersion ?? 0x00;
  const bodyBuf = Buffer.from(body);
  const payloadLen = bodyBuf.length + (includeCrc8 ? 1 : 0);
  const lenBeforeChecksum = 10 + payloadLen;
  const frame = Buffer.alloc(lenBeforeChecksum + 1, 0);

  frame[0] = 0xaa;
  frame[1] = lenBeforeChecksum & 0xff;
  frame[2] = deviceType & 0xff;
  frame[3] = 0x00;
  frame[8] = protocolVersion & 0xff;
  frame[9] = frameType & 0xff;

  bodyBuf.copy(frame, 10);
  if (includeCrc8) {
    frame[10 + bodyBuf.length] = mideaCrc8(bodyBuf);
  }
  frame[lenBeforeChecksum] = mideaChecksum(frame.subarray(1, lenBeforeChecksum));
  return frame;
}

/**
 * 解析美的 `0xAA` 串口协议帧（自动定位 `0xAA` 同步头、校验 checksum 与 CRC8）。
 */
export function parseMideaFrame(raw: Uint8Array): ParsedMideaFrame {
  const buf = Buffer.from(raw);
  const start = buf.indexOf(0xaa);
  if (start < 0) {
    throw new Error("未在美的串口响应中找到 0xAA 帧头");
  }
  const sliced = buf.subarray(start);
  if (sliced.length < 12) {
    throw new Error(`美的 0xAA 帧过短：${sliced.length} 字节`);
  }

  const lenByte = sliced[1]!;
  const totalLen = lenByte + 1;
  if (totalLen < 12 || totalLen > sliced.length) {
    throw new Error(`美的 0xAA 帧长度字段异常：声明 ${totalLen} 字节，实际 ${sliced.length} 字节`);
  }

  const frame = Buffer.from(sliced.subarray(0, totalLen));
  const expectedChecksum = mideaChecksum(frame.subarray(1, totalLen - 1));
  const actualChecksum = frame[totalLen - 1]!;
  const checksumValid = expectedChecksum === actualChecksum;
  if (!checksumValid) {
    throw new Error(
      `美的 0xAA 帧校验和失败：期望 0x${expectedChecksum.toString(16)}, 实际 0x${actualChecksum.toString(16)}`,
    );
  }

  const deviceType = frame[2]!;
  const protocolVersion = frame[8]!;
  const frameType = frame[9]!;
  const rawBody = Buffer.from(frame.subarray(10, totalLen - 1));

  let crcValid = false;
  let body = rawBody;
  if (rawBody.length >= 2) {
    const candidateData = rawBody.subarray(0, rawBody.length - 1);
    const candidateCrc = rawBody[rawBody.length - 1]!;
    if (mideaCrc8(candidateData) === candidateCrc) {
      crcValid = true;
      body = Buffer.from(candidateData);
    }
  }

  return {
    deviceType,
    protocolVersion,
    frameType,
    body,
    rawBody,
    crcValid,
    checksumValid,
    rawFrame: frame,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// ---------- 0xAC 空调 ----------

export type MideaAcMode = 1 | 2 | 3 | 4 | 5;

export interface MideaAcState {
  kind: "ac";
  deviceType: number;
  power: boolean;
  /** 1=自动, 2=制冷, 3=除湿, 4=制热, 5=送风 */
  mode: MideaAcMode;
  /** 16..30°C，支持 0.5°C 步进 */
  targetTemperature: number;
  /** 102=自动, 20=静音, 40=低风, 60=中风, 80=高风, 100=强劲 */
  fanSpeed: number;
  swingVertical: boolean;
  swingHorizontal: boolean;
  eco: boolean;
  turbo: boolean;
  auxHeat: boolean;
  screenDisplay: boolean;
  indoorTemperature?: number;
  outdoorTemperature?: number;
}

export function defaultAcState(deviceType = 0xac): MideaAcState {
  return {
    kind: "ac",
    deviceType,
    power: false,
    mode: 2,
    targetTemperature: 26,
    fanSpeed: 102,
    swingVertical: false,
    swingHorizontal: false,
    eco: false,
    turbo: false,
    auxHeat: false,
    screenDisplay: true,
  };
}

export function buildAcQuery(msgId = 0x03, deviceType = 0xac): Buffer {
  const body = new Uint8Array([
    0x41, 0x81, 0x00, 0xff, 0x03, 0xff, 0x00, 0x02,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, msgId & 0xff,
  ]);
  return buildMideaFrame(deviceType, 0x03, body, { protocolVersion: 0x03, includeCrc8: true });
}

export function buildAcSet(
  state: Partial<MideaAcState>,
  options?: { promptTone?: boolean; msgId?: number; deviceType?: number },
): Buffer {
  const merged: MideaAcState = { ...defaultAcState(options?.deviceType ?? state.deviceType ?? 0xac), ...state };
  const clampedTemp = clamp(Math.round(merged.targetTemperature * 2) / 2, 16, 30);
  const intTemp = Math.floor(clampedTemp);
  const halfBit = clampedTemp - intTemp >= 0.5 ? 0x10 : 0x00;

  const body = new Uint8Array(25);
  body[0] = 0x40;
  body[1] = (merged.power ? 0x01 : 0x00) | 0x02 | (options?.promptTone ? 0x40 : 0x00);
  body[2] = ((merged.mode & 0x07) << 5) | ((intTemp - 16) & 0x0f) | halfBit;
  body[3] = merged.fanSpeed & 0x7f;
  body[7] =
    0x30 |
    (merged.swingVertical ? 0x0c : 0x00) |
    (merged.swingHorizontal ? 0x03 : 0x00);
  body[8] = merged.turbo ? 0x20 : 0x00;
  body[9] = (merged.eco ? 0x80 : 0x00) | (merged.auxHeat ? 0x08 : 0x00);
  body[10] = (merged.turbo ? 0x02 : 0x00) | (merged.eco ? 0x10 : 0x00);
  body[14] = merged.screenDisplay ? 0x00 : 0x70;
  body[24] = (options?.msgId ?? 0x04) & 0xff;

  return buildMideaFrame(merged.deviceType, 0x02, body, {
    protocolVersion: 0x03,
    includeCrc8: true,
  });
}

export function buildAcStatusResponseFrame(state: MideaAcState): Buffer {
  const clampedTemp = clamp(Math.round(state.targetTemperature * 2) / 2, 16, 30);
  const intTemp = Math.floor(clampedTemp);
  const halfBit = clampedTemp - intTemp >= 0.5 ? 0x10 : 0x00;

  const body = new Uint8Array(23);
  body[0] = 0xc0;
  body[1] = state.power ? 0x01 : 0x00;
  body[2] = ((state.mode & 0x07) << 5) | ((intTemp - 16) & 0x0f) | halfBit;
  body[3] = state.fanSpeed & 0x7f;
  body[7] =
    (state.swingVertical ? 0x0c : 0x00) | (state.swingHorizontal ? 0x03 : 0x00);
  body[8] = state.turbo ? 0x20 : 0x00;
  body[9] = (state.eco ? 0x10 : 0x00) | (state.auxHeat ? 0x08 : 0x00);
  body[10] = state.turbo ? 0x02 : 0x00;
  body[11] =
    state.indoorTemperature !== undefined
      ? clamp(Math.round(state.indoorTemperature * 2 + 50), 1, 254)
      : 0x00;
  body[12] =
    state.outdoorTemperature !== undefined
      ? clamp(Math.round(state.outdoorTemperature * 2 + 50), 1, 254)
      : 0x00;
  body[14] = state.screenDisplay ? 0x00 : 0x70;
  return buildMideaFrame(state.deviceType || 0xac, 0x03, body, {
    protocolVersion: 0x03,
    includeCrc8: true,
  });
}

export function parseAcResponse(frameOrRaw: ParsedMideaFrame | Uint8Array): MideaAcState | null {
  const frame = frameOrRaw instanceof Uint8Array ? parseMideaFrame(frameOrRaw) : frameOrRaw;
  const body = frame.body;
  if (body.length < 13 || body[0] !== 0xc0) {
    return null;
  }

  const power = (body[1]! & 0x01) > 0;
  const rawMode = (body[2]! & 0xe0) >> 5;
  const mode = (rawMode >= 1 && rawMode <= 5 ? rawMode : 1) as MideaAcMode;
  const targetTemperature = (body[2]! & 0x0f) + 16 + ((body[2]! & 0x10) > 0 ? 0.5 : 0);
  const fanSpeed = body[3]! & 0x7f;
  const swingVertical = (body[7]! & 0x0c) > 0;
  const swingHorizontal = (body[7]! & 0x03) > 0;
  const turbo = (body[8]! & 0x20) > 0 || (body[10]! & 0x02) > 0;
  const eco = (body[9]! & 0x10) > 0 || (body[9]! & 0x80) > 0;
  const auxHeat = (body[9]! & 0x08) > 0;
  const screenDisplay = body.length > 14 ? ((body[14]! >> 4) & 0x07) !== 0x07 : true;

  const indoorRaw = body[11]!;
  const outdoorRaw = body[12]!;
  const indoorTemperature =
    indoorRaw > 0 && indoorRaw < 0xff ? (indoorRaw - 50) / 2 : undefined;
  const outdoorTemperature =
    outdoorRaw > 0 && outdoorRaw < 0xff ? (outdoorRaw - 50) / 2 : undefined;

  return {
    kind: "ac",
    deviceType: frame.deviceType || 0xac,
    power,
    mode,
    targetTemperature,
    fanSpeed,
    swingVertical,
    swingHorizontal,
    eco,
    turbo,
    auxHeat,
    screenDisplay,
    ...(indoorTemperature !== undefined ? { indoorTemperature } : {}),
    ...(outdoorTemperature !== undefined ? { outdoorTemperature } : {}),
  };
}

// ---------- 0xA1 除湿机 ----------

export type MideaDehumidifierMode = 1 | 2 | 3 | 4;

export interface MideaDehumidifierState {
  kind: "dehumidifier";
  deviceType: number;
  power: boolean;
  /** 1=设定湿度, 2=连续除湿, 3=智能除湿, 4=干衣模式 */
  mode: MideaDehumidifierMode;
  /** 35..85% */
  targetHumidity: number;
  currentHumidity?: number;
  currentTemperature?: number;
  /** 40=低风, 60=中风, 80=高风 */
  fanSpeed: number;
  tankFull: boolean;
  ion: boolean;
  swing: boolean;
  childLock: boolean;
}

export function defaultDehumidifierState(): MideaDehumidifierState {
  return {
    kind: "dehumidifier",
    deviceType: 0xa1,
    power: false,
    mode: 1,
    targetHumidity: 50,
    fanSpeed: 60,
    tankFull: false,
    ion: false,
    swing: false,
    childLock: false,
  };
}

export function buildDehumidifierQuery(msgId = 0x03): Buffer {
  const body = new Uint8Array([
    0x41, 0x81, 0x00, 0xff, 0x03, 0xff, 0x00, 0x02,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, msgId & 0xff,
  ]);
  return buildMideaFrame(0xa1, 0x03, body, { protocolVersion: 0x00, includeCrc8: true });
}

export function buildDehumidifierSet(
  state: Partial<MideaDehumidifierState>,
  options?: { promptTone?: boolean; msgId?: number },
): Buffer {
  const merged: MideaDehumidifierState = { ...defaultDehumidifierState(), ...state };
  const body = new Uint8Array(22);
  body[0] = 0x48;
  body[1] = (merged.power ? 0x01 : 0x00) | (options?.promptTone ? 0x40 : 0x00);
  body[2] = merged.mode & 0x0f;
  body[3] = merged.fanSpeed & 0x7f;
  body[7] = clamp(Math.round(merged.targetHumidity), 35, 85);
  body[8] = merged.childLock ? 0x80 : 0x00;
  body[9] = merged.ion ? 0x40 : 0x00;
  body[10] = merged.swing ? 0x08 : 0x00;
  body[19] = merged.swing ? 0x20 : 0x00;
  body[21] = (options?.msgId ?? 0x04) & 0xff;
  return buildMideaFrame(0xa1, 0x02, body, { protocolVersion: 0x00, includeCrc8: true });
}

export function buildDehumidifierStatusResponseFrame(state: MideaDehumidifierState): Buffer {
  const body = new Uint8Array(22);
  body[0] = 0xc8;
  body[1] = state.power ? 0x01 : 0x00;
  body[2] = state.mode & 0x0f;
  body[3] = state.fanSpeed & 0x7f;
  body[7] = clamp(Math.round(state.targetHumidity), 35, 85);
  body[8] = state.childLock ? 0x80 : 0x00;
  body[9] = state.ion ? 0x40 : 0x00;
  body[10] = state.tankFull ? 100 : 0;
  body[16] =
    state.currentHumidity !== undefined ? clamp(Math.round(state.currentHumidity), 0, 100) : 0;
  body[17] =
    state.currentTemperature !== undefined
      ? clamp(Math.round(state.currentTemperature * 2 + 50), 1, 254)
      : 0;
  body[19] = state.swing ? 0x20 : 0x00;
  return buildMideaFrame(0xa1, 0x03, body, { protocolVersion: 0x00, includeCrc8: true });
}

export function parseDehumidifierResponse(
  frameOrRaw: ParsedMideaFrame | Uint8Array,
): MideaDehumidifierState | null {
  const frame = frameOrRaw instanceof Uint8Array ? parseMideaFrame(frameOrRaw) : frameOrRaw;
  const body = frame.body;
  if (body.length < 11 || (body[0] !== 0xc8 && body[0] !== 0xc0)) {
    return null;
  }

  const power = (body[1]! & 0x01) > 0;
  const rawMode = body[2]! & 0x0f;
  const mode = (rawMode >= 1 && rawMode <= 4 ? rawMode : 1) as MideaDehumidifierMode;
  const fanSpeed = body[3]! & 0x7f;
  const targetHumidity = clamp(body[7]! & 0x7f, 35, 85);
  const childLock = (body[8]! & 0x80) > 0;
  const ion = (body[9]! & 0x40) > 0;
  const tankRaw = body[10]!;
  const tankFull = (tankRaw & 0x7f) >= 100 || (tankRaw & 0x80) > 0;
  const currentHumidity =
    body.length > 16 && body[16]! > 0 && body[16]! <= 100 ? body[16]! : undefined;
  const currentTemperature =
    body.length > 17 && body[17]! > 0 && body[17]! < 0xff ? (body[17]! - 50) / 2 : undefined;
  const swing = body.length > 19 ? (body[19]! & 0x20) > 0 : (body[10]! & 0x08) > 0;

  return {
    kind: "dehumidifier",
    deviceType: 0xa1,
    power,
    mode,
    targetHumidity,
    fanSpeed,
    tankFull,
    ion,
    swing,
    childLock,
    ...(currentHumidity !== undefined ? { currentHumidity } : {}),
    ...(currentTemperature !== undefined ? { currentTemperature } : {}),
  };
}

// ---------- 0xFA 风扇 ----------

export interface MideaFanState {
  kind: "fan";
  deviceType: number;
  power: boolean;
  /** 1..26 档 */
  fanSpeed: number;
  oscillate: boolean;
  /** 0=正常风, 1=自然风, 2=睡眠风, 3=舒适风 */
  mode: number;
}

export function defaultFanState(): MideaFanState {
  return {
    kind: "fan",
    deviceType: 0xfa,
    power: false,
    fanSpeed: 1,
    oscillate: false,
    mode: 0,
  };
}

export function buildFanQuery(): Buffer {
  const body = new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  return buildMideaFrame(0xfa, 0x03, body, { includeCrc8: false });
}

export function buildFanSet(state: Partial<MideaFanState>): Buffer {
  const merged: MideaFanState = { ...defaultFanState(), ...state };
  const body = new Uint8Array(16);
  body[0] = 0x00;
  body[3] = (merged.power ? 0x01 : 0x00) | ((merged.mode & 0x07) << 1);
  body[4] = clamp(Math.round(merged.fanSpeed), 1, 26);
  body[8] = merged.oscillate ? 0x01 : 0x00;
  return buildMideaFrame(0xfa, 0x02, body, { includeCrc8: false });
}

export function parseFanResponse(frameOrRaw: ParsedMideaFrame | Uint8Array): MideaFanState | null {
  const frame = frameOrRaw instanceof Uint8Array ? parseMideaFrame(frameOrRaw) : frameOrRaw;
  const body = frame.rawBody;
  if (body.length < 9) {
    return null;
  }
  const power = (body[4]! & 0x01) > 0;
  const mode = (body[4]! & 0x0e) >> 1;
  const fanSpeed = clamp(body[5]! || 1, 1, 26);
  const oscillate = (body[8]! & 0x01) > 0;
  return {
    kind: "fan",
    deviceType: 0xfa,
    power,
    fanSpeed,
    oscillate,
    mode,
  };
}

// ---------- 0xFC 空气净化器 ----------

export interface MideaPurifierState {
  kind: "purifier";
  deviceType: number;
  power: boolean;
  /** 0=自动, 20=静音, 40=低风, 60=中风, 80=高风 */
  fanSpeed: number;
  /** 0x10=自动, 0x20=手动, 0x30=睡眠 */
  mode: number;
  pm25?: number;
  childLock: boolean;
  ion: boolean;
}

export function defaultPurifierState(): MideaPurifierState {
  return {
    kind: "purifier",
    deviceType: 0xfc,
    power: false,
    fanSpeed: 0,
    mode: 0x10,
    childLock: false,
    ion: false,
  };
}

export function buildPurifierQuery(msgId = 0x03): Buffer {
  const body = new Uint8Array([
    0x41, 0x81, 0x00, 0xff, 0x03, 0xff, 0x00, 0x02,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, msgId & 0xff,
  ]);
  return buildMideaFrame(0xfc, 0x03, body, { includeCrc8: true });
}

export function buildPurifierSet(state: Partial<MideaPurifierState>): Buffer {
  const merged: MideaPurifierState = { ...defaultPurifierState(), ...state };
  const body = new Uint8Array(21);
  body[0] = 0x48;
  body[1] = merged.power ? 0x01 : 0x00;
  body[2] = merged.mode & 0xf0;
  body[3] = merged.fanSpeed & 0x7f;
  body[8] = merged.childLock ? 0x80 : 0x00;
  body[9] = merged.ion ? 0x40 : 0x00;
  return buildMideaFrame(0xfc, 0x02, body, { includeCrc8: true });
}

export function parsePurifierResponse(
  frameOrRaw: ParsedMideaFrame | Uint8Array,
): MideaPurifierState | null {
  const frame = frameOrRaw instanceof Uint8Array ? parseMideaFrame(frameOrRaw) : frameOrRaw;
  const body = frame.body;
  if (body.length < 10 || (body[0] !== 0xc8 && body[0] !== 0xc0)) {
    return null;
  }
  const power = (body[1]! & 0x01) > 0;
  const mode = body[2]! & 0xf0;
  const fanSpeed = body[3]! & 0x7f;
  const childLock = (body[8]! & 0x80) > 0;
  const ion = (body[9]! & 0x40) > 0;
  const pm25 = body.length > 14 ? (body[13]! << 8) | body[14]! : undefined;
  return {
    kind: "purifier",
    deviceType: 0xfc,
    power,
    fanSpeed,
    mode: mode || 0x10,
    childLock,
    ion,
    ...(pm25 !== undefined ? { pm25 } : {}),
  };
}

// ---------- 0xFD 加湿器 ----------

export interface MideaHumidifierState {
  kind: "humidifier";
  deviceType: number;
  power: boolean;
  /** 40..80% */
  targetHumidity: number;
  currentHumidity?: number;
  fanSpeed: number;
  tankEmpty: boolean;
}

export function defaultHumidifierState(): MideaHumidifierState {
  return {
    kind: "humidifier",
    deviceType: 0xfd,
    power: false,
    targetHumidity: 55,
    fanSpeed: 60,
    tankEmpty: false,
  };
}

export function buildHumidifierQuery(msgId = 0x03): Buffer {
  const body = new Uint8Array([
    0x41, 0x81, 0x00, 0xff, 0x03, 0xff, 0x00, 0x02,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, msgId & 0xff,
  ]);
  return buildMideaFrame(0xfd, 0x03, body, { includeCrc8: true });
}

export function buildHumidifierSet(state: Partial<MideaHumidifierState>): Buffer {
  const merged: MideaHumidifierState = { ...defaultHumidifierState(), ...state };
  const body = new Uint8Array(21);
  body[0] = 0x48;
  body[1] = merged.power ? 0x01 : 0x00;
  body[3] = merged.fanSpeed & 0x7f;
  body[7] = clamp(Math.round(merged.targetHumidity), 40, 80);
  return buildMideaFrame(0xfd, 0x02, body, { includeCrc8: true });
}

export function parseHumidifierResponse(
  frameOrRaw: ParsedMideaFrame | Uint8Array,
): MideaHumidifierState | null {
  const frame = frameOrRaw instanceof Uint8Array ? parseMideaFrame(frameOrRaw) : frameOrRaw;
  const body = frame.body;
  if (body.length < 11 || (body[0] !== 0xc8 && body[0] !== 0xc0)) {
    return null;
  }
  const power = (body[1]! & 0x01) > 0;
  const fanSpeed = body[3]! & 0x7f;
  const targetHumidity = clamp(body[7]! & 0x7f, 40, 80);
  const tankEmpty = (body[10]! & 0x80) > 0 || (body[10]! & 0x7f) === 1;
  const currentHumidity =
    body.length > 16 && body[16]! > 0 && body[16]! <= 100 ? body[16]! : undefined;
  return {
    kind: "humidifier",
    deviceType: 0xfd,
    power,
    targetHumidity,
    fanSpeed,
    tankEmpty,
    ...(currentHumidity !== undefined ? { currentHumidity } : {}),
  };
}

// ---------- 0xE2 / 0xE3 热水器 ----------

export interface MideaWaterHeaterState {
  kind: "water-heater";
  deviceType: number;
  power: boolean;
  /** 30..75°C */
  targetTemperature: number;
  currentTemperature?: number;
  heating: boolean;
}

export function defaultWaterHeaterState(deviceType = 0xe2): MideaWaterHeaterState {
  return {
    kind: "water-heater",
    deviceType,
    power: false,
    targetTemperature: 45,
    heating: false,
  };
}

export function buildWaterHeaterQuery(deviceType = 0xe2): Buffer {
  const body = new Uint8Array([0x01, 0x01]);
  return buildMideaFrame(deviceType, 0x03, body, { includeCrc8: false });
}

export function buildWaterHeaterSet(
  state: Partial<MideaWaterHeaterState>,
  deviceType = 0xe2,
): Buffer {
  const merged: MideaWaterHeaterState = {
    ...defaultWaterHeaterState(state.deviceType ?? deviceType),
    ...state,
  };
  const body = new Uint8Array([
    0x04,
    0x01,
    merged.power ? 0x01 : 0x00,
    clamp(Math.round(merged.targetTemperature), 30, 75),
  ]);
  return buildMideaFrame(merged.deviceType, 0x02, body, { includeCrc8: false });
}

export function parseWaterHeaterResponse(
  frameOrRaw: ParsedMideaFrame | Uint8Array,
): MideaWaterHeaterState | null {
  const frame = frameOrRaw instanceof Uint8Array ? parseMideaFrame(frameOrRaw) : frameOrRaw;
  const body = frame.rawBody;
  if (body.length < 6) {
    return null;
  }
  const power = (body[2]! & 0x01) > 0;
  const heating = (body[2]! & 0x04) > 0;
  const currentTemperature = body[4]! > 0 && body[4]! < 100 ? body[4]! : undefined;
  const targetRaw = body.length > 11 && body[11]! >= 30 ? body[11]! : body[5]!;
  const targetTemperature = clamp(targetRaw || 45, 30, 75);
  return {
    kind: "water-heater",
    deviceType: frame.deviceType || 0xe2,
    power,
    targetTemperature,
    heating,
    ...(currentTemperature !== undefined ? { currentTemperature } : {}),
  };
}

// ---------- 通用家电回退 ----------

export interface MideaGenericState {
  kind: "generic";
  deviceType: number;
  power: boolean;
  rawHex: string;
}

export function defaultGenericState(deviceType: number): MideaGenericState {
  return {
    kind: "generic",
    deviceType,
    power: false,
    rawHex: "",
  };
}

export function buildGenericQuery(deviceType: number): Buffer {
  const body = new Uint8Array([0x01, 0x00]);
  return buildMideaFrame(deviceType, 0x03, body, { includeCrc8: false });
}

export function buildGenericPowerSet(deviceType: number, power: boolean): Buffer {
  const body = new Uint8Array([0x01, power ? 0x01 : 0x00]);
  return buildMideaFrame(deviceType, 0x02, body, { includeCrc8: false });
}

export function parseGenericResponse(
  frameOrRaw: ParsedMideaFrame | Uint8Array,
  fallbackType = 0x00,
): MideaGenericState {
  const frame = frameOrRaw instanceof Uint8Array ? parseMideaFrame(frameOrRaw) : frameOrRaw;
  const body = frame.body;
  const power = body.length > 1 ? (body[1]! & 0x01) > 0 : false;
  return {
    kind: "generic",
    deviceType: frame.deviceType || fallbackType,
    power,
    rawHex: body.toString("hex"),
  };
}

// ---------- 统一调度 ----------

export type MideaApplianceState =
  | MideaAcState
  | MideaDehumidifierState
  | MideaFanState
  | MideaPurifierState
  | MideaHumidifierState
  | MideaWaterHeaterState
  | MideaGenericState;

export function defaultApplianceState(deviceType: number): MideaApplianceState {
  switch (deviceType & 0xff) {
    case 0xac:
    case 0xcc:
      return defaultAcState(deviceType & 0xff);
    case 0xa1:
      return defaultDehumidifierState();
    case 0xfa:
      return defaultFanState();
    case 0xfc:
      return defaultPurifierState();
    case 0xfd:
      return defaultHumidifierState();
    case 0xe2:
    case 0xe3:
      return defaultWaterHeaterState(deviceType & 0xff);
    default:
      return defaultGenericState(deviceType & 0xff);
  }
}

export function buildApplianceQuery(deviceType: number): Buffer {
  switch (deviceType & 0xff) {
    case 0xac:
    case 0xcc:
      return buildAcQuery(0x03, deviceType & 0xff);
    case 0xa1:
      return buildDehumidifierQuery();
    case 0xfa:
      return buildFanQuery();
    case 0xfc:
      return buildPurifierQuery();
    case 0xfd:
      return buildHumidifierQuery();
    case 0xe2:
    case 0xe3:
      return buildWaterHeaterQuery(deviceType & 0xff);
    default:
      return buildGenericQuery(deviceType & 0xff);
  }
}

export function buildApplianceSet(deviceType: number, state: MideaApplianceState): Buffer {
  switch (state.kind) {
    case "ac":
      return buildAcSet(state, { deviceType: deviceType & 0xff });
    case "dehumidifier":
      return buildDehumidifierSet(state);
    case "fan":
      return buildFanSet(state);
    case "purifier":
      return buildPurifierSet(state);
    case "humidifier":
      return buildHumidifierSet(state);
    case "water-heater":
      return buildWaterHeaterSet(state, deviceType & 0xff);
    case "generic":
      return buildGenericPowerSet(deviceType & 0xff, state.power);
  }
}

export function parseApplianceResponse(
  deviceType: number,
  raw: Uint8Array,
): MideaApplianceState | null {
  const frame = parseMideaFrame(raw);
  const type = (deviceType || frame.deviceType) & 0xff;
  switch (type) {
    case 0xac:
    case 0xcc:
      return parseAcResponse(frame);
    case 0xa1:
      return parseDehumidifierResponse(frame);
    case 0xfa:
      return parseFanResponse(frame);
    case 0xfc:
      return parsePurifierResponse(frame);
    case 0xfd:
      return parseHumidifierResponse(frame);
    case 0xe2:
    case 0xe3:
      return parseWaterHeaterResponse(frame);
    default:
      return parseGenericResponse(frame, type);
  }
}

// ---------- 云端 Lua JSON 状态与控制转换 ----------

const DEDICATED_BINARY_PROTOCOL_TYPES = new Set<number>([
  0xac,
  0xcc,
  0xa1,
  0xfa,
  0xfc,
  0xfd,
  0xe2,
  0xe3,
]);

/** 判断设备品类是否拥有专用 0xAA 二进制帧编解码器（其余品类在云端优先使用 Lua 接口）。 */
export function hasDedicatedBinaryProtocol(deviceType: number): boolean {
  return DEDICATED_BINARY_PROTOCOL_TYPES.has(deviceType & 0xff);
}

/** 构造 `/mjl/v1/device/status/lua/get` 的默认查询参数。 */
export function buildLuaQueryParams(deviceType: number): Record<string, unknown> {
  if ((deviceType & 0xff) === 0xcf) {
    return { query_type: "0x11" };
  }
  return {};
}

function parseLuaBool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value !== 0;
  if (typeof value === "string") {
    const lower = value.trim().toLowerCase();
    if (lower === "on" || lower === "1" || lower === "true" || lower === "start") {
      return true;
    }
    if (lower === "off" || lower === "0" || lower === "false" || lower === "stop" || lower === "pause") {
      return false;
    }
  }
  return undefined;
}

function parseLuaNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const num = Number(trimmed);
    if (Number.isFinite(num)) {
      return num;
    }
  }
  return undefined;
}

function parseLuaAcMode(value: unknown): MideaAcMode | undefined {
  if (typeof value === "string") {
    switch (value.trim().toLowerCase()) {
      case "auto":
      case "1":
        return 1;
      case "cool":
      case "2":
        return 2;
      case "dry":
      case "3":
        return 3;
      case "heat":
      case "4":
        return 4;
      case "fan":
      case "fan_only":
      case "5":
        return 5;
      default:
        return undefined;
    }
  }
  const num = parseLuaNumber(value);
  if (num !== undefined && num >= 1 && num <= 5) {
    return Math.round(num) as MideaAcMode;
  }
  return undefined;
}

function parseLuaDehumidifierMode(value: unknown): MideaDehumidifierMode | undefined {
  if (typeof value === "string") {
    switch (value.trim().toLowerCase()) {
      case "set":
      case "target":
      case "1":
        return 1;
      case "continuity":
      case "continuous":
      case "2":
        return 2;
      case "auto":
      case "smart":
      case "3":
        return 3;
      case "dry_clothes":
      case "clothes_dry":
      case "4":
        return 4;
      default:
        return undefined;
    }
  }
  const num = parseLuaNumber(value);
  if (num !== undefined && num >= 1 && num <= 4) {
    return Math.round(num) as MideaDehumidifierMode;
  }
  return undefined;
}

function parseValidTemp(value: unknown): number | undefined {
  const num = parseLuaNumber(value);
  if (num === undefined || num < -40 || num > 100) {
    return undefined;
  }
  return num;
}

/**
 * 将美的云端 `/status/lua/get` 返回的 JSON 状态对象映射为统一的 `MideaApplianceState`。
 */
export function parseLuaApplianceStatus(
  deviceType: number,
  raw: Record<string, unknown>,
  existing?: MideaApplianceState | null,
): MideaApplianceState | null {
  const keys = Object.keys(raw);
  if (keys.length === 0) {
    return null;
  }
  const type = deviceType & 0xff;
  const fallback =
    existing && existing.deviceType === type ? existing : defaultApplianceState(type);

  switch (fallback.kind) {
    case "ac": {
      const power = parseLuaBool(raw["power"]);
      const mode = parseLuaAcMode(raw["mode"]);
      const baseTemp = parseLuaNumber(raw["temperature"]);
      const smallTemp = parseLuaNumber(raw["small_temperature"]) ?? 0;
      const targetTempRaw =
        baseTemp !== undefined
          ? Number.isInteger(baseTemp) && smallTemp > 0 && smallTemp < 1
            ? baseTemp + smallTemp
            : baseTemp
          : undefined;
      const indoorTemp = parseValidTemp(raw["indoor_temperature"]);
      const outdoorTemp = parseValidTemp(raw["outdoor_temperature"]);
      const fanSpeed = parseLuaNumber(raw["wind_speed"]);
      const swingVertical = parseLuaBool(raw["wind_swing_ud"]);
      const swingHorizontal = parseLuaBool(raw["wind_swing_lr"]);
      const eco = parseLuaBool(raw["eco"]);
      const turbo = parseLuaBool(raw["strong_wind"]) ?? parseLuaBool(raw["jet_cool"]);
      const auxHeat = parseLuaBool(raw["ptc"]);
      const screenDisplayNow = parseLuaBool(raw["screen_display_now"]);
      const screenDisplayNum = parseLuaNumber(raw["screen_display"]);
      const screenDisplay =
        screenDisplayNow ??
        (screenDisplayNum !== undefined
          ? screenDisplayNum > 0
          : parseLuaBool(raw["screen_display"]));

      if (
        power === undefined &&
        mode === undefined &&
        targetTempRaw === undefined &&
        indoorTemp === undefined
      ) {
        return null;
      }

      return {
        ...fallback,
        power: power ?? fallback.power,
        mode: mode ?? fallback.mode,
        targetTemperature:
          targetTempRaw !== undefined
            ? clamp(Math.round(targetTempRaw * 2) / 2, 16, 30)
            : fallback.targetTemperature,
        fanSpeed: fanSpeed !== undefined ? clamp(Math.round(fanSpeed), 1, 102) : fallback.fanSpeed,
        swingVertical: swingVertical ?? fallback.swingVertical,
        swingHorizontal: swingHorizontal ?? fallback.swingHorizontal,
        eco: eco ?? fallback.eco,
        turbo: turbo ?? fallback.turbo,
        auxHeat: auxHeat ?? fallback.auxHeat,
        screenDisplay: screenDisplay ?? fallback.screenDisplay,
        ...(indoorTemp !== undefined
          ? { indoorTemperature: indoorTemp }
          : fallback.indoorTemperature !== undefined
            ? { indoorTemperature: fallback.indoorTemperature }
            : {}),
        ...(outdoorTemp !== undefined
          ? { outdoorTemperature: outdoorTemp }
          : fallback.outdoorTemperature !== undefined
            ? { outdoorTemperature: fallback.outdoorTemperature }
            : {}),
      };
    }
    case "dehumidifier": {
      const power = parseLuaBool(raw["power"]);
      const mode = parseLuaDehumidifierMode(raw["mode"]);
      const targetHumidity = parseLuaNumber(raw["humidity"]);
      const currentHumidity = parseLuaNumber(raw["cur_humidity"]);
      const currentTemperature =
        parseValidTemp(raw["indoor_temperature"]) ?? parseValidTemp(raw["temperature"]);
      const fanSpeed = parseLuaNumber(raw["wind_speed"]);
      const tankNum = parseLuaNumber(raw["tank_status"]);
      const tankFull =
        tankNum !== undefined ? tankNum >= 100 : parseLuaBool(raw["tank_full"]);
      const ion = parseLuaBool(raw["anion"]);
      const swing = parseLuaBool(raw["wind_swing"]);
      const childLock = parseLuaBool(raw["child_lock"]);

      if (power === undefined && currentHumidity === undefined && targetHumidity === undefined) {
        return null;
      }

      return {
        ...fallback,
        power: power ?? fallback.power,
        mode: mode ?? fallback.mode,
        targetHumidity:
          targetHumidity !== undefined
            ? clamp(Math.round(targetHumidity), 35, 85)
            : fallback.targetHumidity,
        fanSpeed: fanSpeed !== undefined ? clamp(Math.round(fanSpeed), 1, 102) : fallback.fanSpeed,
        tankFull: tankFull ?? fallback.tankFull,
        ion: ion ?? fallback.ion,
        swing: swing ?? fallback.swing,
        childLock: childLock ?? fallback.childLock,
        ...(currentHumidity !== undefined && currentHumidity >= 0 && currentHumidity <= 100
          ? { currentHumidity }
          : fallback.currentHumidity !== undefined
            ? { currentHumidity: fallback.currentHumidity }
            : {}),
        ...(currentTemperature !== undefined
          ? { currentTemperature }
          : fallback.currentTemperature !== undefined
            ? { currentTemperature: fallback.currentTemperature }
            : {}),
      };
    }
    case "fan": {
      const power = parseLuaBool(raw["power"]);
      const fanSpeed = parseLuaNumber(raw["gear"]) ?? parseLuaNumber(raw["wind_speed"]);
      const swingRaw = raw["swing"];
      const oscillate =
        parseLuaBool(swingRaw) ??
        (typeof swingRaw === "string" && swingRaw.trim() !== ""
          ? swingRaw.trim().toLowerCase() !== "off"
          : undefined);
      let mode: number | undefined;
      if (typeof raw["mode"] === "string") {
        const lower = raw["mode"].trim().toLowerCase();
        if (lower === "normal") mode = 0;
        else if (lower === "natural") mode = 1;
        else if (lower === "sleep") mode = 2;
        else if (lower === "comfort") mode = 3;
      } else {
        mode = parseLuaNumber(raw["mode"]);
      }

      if (power === undefined && fanSpeed === undefined) {
        return null;
      }
      return {
        ...fallback,
        power: power ?? fallback.power,
        fanSpeed: fanSpeed !== undefined ? clamp(Math.round(fanSpeed), 1, 26) : fallback.fanSpeed,
        oscillate: oscillate ?? fallback.oscillate,
        mode: mode !== undefined ? clamp(Math.round(mode), 0, 3) : fallback.mode,
      };
    }
    case "purifier": {
      const power = parseLuaBool(raw["power"]);
      const fanSpeed = parseLuaNumber(raw["wind_speed"]);
      const pm25 = parseLuaNumber(raw["pm25"]);
      const ion = parseLuaBool(raw["anion"]);
      const childLock = parseLuaBool(raw["child_lock"]);
      let mode: number | undefined;
      if (typeof raw["mode"] === "string") {
        const lower = raw["mode"].trim().toLowerCase();
        if (lower === "auto") mode = 0x10;
        else if (lower === "manual") mode = 0x20;
        else if (lower === "sleep") mode = 0x30;
      } else {
        mode = parseLuaNumber(raw["mode"]);
      }

      if (power === undefined && pm25 === undefined) {
        return null;
      }
      return {
        ...fallback,
        power: power ?? fallback.power,
        fanSpeed: fanSpeed !== undefined ? clamp(Math.round(fanSpeed), 0, 102) : fallback.fanSpeed,
        mode: mode ?? fallback.mode,
        ion: ion ?? fallback.ion,
        childLock: childLock ?? fallback.childLock,
        ...(pm25 !== undefined
          ? { pm25: Math.round(pm25) }
          : fallback.pm25 !== undefined
            ? { pm25: fallback.pm25 }
            : {}),
      };
    }
    case "humidifier": {
      const power = parseLuaBool(raw["power"]);
      const targetHumidity = parseLuaNumber(raw["humidity"]);
      const currentHumidity = parseLuaNumber(raw["cur_humidity"]);
      const fanSpeed = parseLuaNumber(raw["wind_speed"]);
      const tankEmpty = parseLuaBool(raw["tank_status"]);

      if (power === undefined && currentHumidity === undefined && targetHumidity === undefined) {
        return null;
      }
      return {
        ...fallback,
        power: power ?? fallback.power,
        targetHumidity:
          targetHumidity !== undefined
            ? clamp(Math.round(targetHumidity), 40, 80)
            : fallback.targetHumidity,
        fanSpeed: fanSpeed !== undefined ? clamp(Math.round(fanSpeed), 1, 100) : fallback.fanSpeed,
        tankEmpty: tankEmpty ?? fallback.tankEmpty,
        ...(currentHumidity !== undefined && currentHumidity >= 0 && currentHumidity <= 100
          ? { currentHumidity }
          : fallback.currentHumidity !== undefined
            ? { currentHumidity: fallback.currentHumidity }
            : {}),
      };
    }
    case "water-heater": {
      const power = parseLuaBool(raw["power"]);
      const targetTemperature = parseLuaNumber(raw["temperature"]);
      const currentTemperature =
        parseValidTemp(raw["cur_temperature"]) ?? parseValidTemp(raw["in_temperature"]);
      const heating = parseLuaBool(raw["heat"]) ?? parseLuaBool(raw["heating"]);

      if (power === undefined && currentTemperature === undefined && targetTemperature === undefined) {
        return null;
      }
      return {
        ...fallback,
        power: power ?? fallback.power,
        targetTemperature:
          targetTemperature !== undefined
            ? clamp(Math.round(targetTemperature), 30, 75)
            : fallback.targetTemperature,
        heating: heating ?? fallback.heating,
        ...(currentTemperature !== undefined
          ? { currentTemperature }
          : fallback.currentTemperature !== undefined
            ? { currentTemperature: fallback.currentTemperature }
            : {}),
      };
    }
    case "generic": {
      const directPower = parseLuaBool(raw["power"]);
      const dbPower = parseLuaBool(raw["db_power"]);
      const daPower = parseLuaBool(raw["da_power"]);
      const ledPower = parseLuaBool(raw["led_power"]);

      let power: boolean | undefined = directPower;
      if (power === undefined) {
        if (dbPower !== undefined || daPower !== undefined) {
          power = Boolean(dbPower) || Boolean(daPower);
        } else if (ledPower !== undefined) {
          power = ledPower;
        }
      }

      if (power === undefined) {
        return null;
      }
      return {
        ...fallback,
        power,
      };
    }
  }
}

/**
 * 构造美的云端 `/lua/control` 所需的 `command.control` JSON 对象。
 */
export function buildLuaControlPayload(
  deviceType: number,
  nextState: MideaApplianceState,
  propName?: string,
  rawLuaStatus?: Record<string, unknown> | null,
): Record<string, unknown> | null {
  const key = propName ? propName.trim().toLowerCase().replaceAll("_", "-") : "on";
  const type = deviceType & 0xff;

  if (key === "on" || key === "power") {
    const val = nextState.power ? "on" : "off";
    if (nextState.kind === "generic") {
      if (rawLuaStatus && "db_power" in rawLuaStatus && !("power" in rawLuaStatus)) {
        return { db_power: val };
      }
      if (rawLuaStatus && "led_power" in rawLuaStatus && !("power" in rawLuaStatus)) {
        return { led_power: val };
      }
      if (type === 0xd9) {
        return { db_power: val };
      }
      if (type === 0x13) {
        return { led_power: val };
      }
    }
    return { power: val };
  }

  switch (nextState.kind) {
    case "ac": {
      switch (key) {
        case "mode": {
          const modeNames: Record<MideaAcMode, string> = {
            1: "auto",
            2: "cool",
            3: "dry",
            4: "heat",
            5: "fan",
          };
          return { mode: modeNames[nextState.mode] ?? "auto" };
        }
        case "target-temperature": {
          const intTemp = Math.floor(nextState.targetTemperature);
          const half = nextState.targetTemperature - intTemp >= 0.5 ? 0.5 : 0;
          return { temperature: intTemp, small_temperature: half };
        }
        case "fan-speed":
          return { wind_speed: nextState.fanSpeed };
        case "swing-vertical":
          return { wind_swing_ud: nextState.swingVertical ? "on" : "off" };
        case "swing-horizontal":
          return { wind_swing_lr: nextState.swingHorizontal ? "on" : "off" };
        case "eco":
          return { eco: nextState.eco ? "on" : "off" };
        case "turbo":
          return { strong_wind: nextState.turbo ? "on" : "off" };
        case "aux-heat":
          return { ptc: nextState.auxHeat ? "on" : "off" };
        case "screen-display":
          return { screen_display: nextState.screenDisplay ? 100 : 0 };
        default:
          return null;
      }
    }
    case "dehumidifier": {
      switch (key) {
        case "mode": {
          const modeNames: Record<MideaDehumidifierMode, string> = {
            1: "set",
            2: "continuity",
            3: "auto",
            4: "dry_clothes",
          };
          return { mode: modeNames[nextState.mode] ?? "set" };
        }
        case "target-humidity":
          return { humidity: nextState.targetHumidity };
        case "fan-speed":
          return { wind_speed: nextState.fanSpeed };
        case "ion":
          return { anion: nextState.ion ? "on" : "off" };
        case "swing":
          return { wind_swing: nextState.swing ? "on" : "off" };
        case "child-lock":
          return { child_lock: nextState.childLock ? "on" : "off" };
        default:
          return null;
      }
    }
    case "fan": {
      switch (key) {
        case "fan-speed":
        case "speed":
          return { gear: nextState.fanSpeed };
        case "oscillate":
        case "swing":
          return { swing: nextState.oscillate ? "on" : "off" };
        case "mode": {
          const modes = ["normal", "natural", "sleep", "comfort"];
          return { mode: modes[nextState.mode] ?? "normal" };
        }
        default:
          return null;
      }
    }
    case "purifier": {
      switch (key) {
        case "mode":
          return {
            mode:
              nextState.mode === 0x20 ? "manual" : nextState.mode === 0x30 ? "sleep" : "auto",
          };
        case "fan-speed":
          return { wind_speed: nextState.fanSpeed };
        case "ion":
          return { anion: nextState.ion ? "on" : "off" };
        case "child-lock":
          return { child_lock: nextState.childLock ? "on" : "off" };
        default:
          return null;
      }
    }
    case "humidifier": {
      switch (key) {
        case "target-humidity":
          return { humidity: nextState.targetHumidity };
        case "fan-speed":
          return { wind_speed: nextState.fanSpeed };
        default:
          return null;
      }
    }
    case "water-heater": {
      switch (key) {
        case "target-temperature":
          return { temperature: nextState.targetTemperature };
        default:
          return null;
      }
    }
    case "generic":
      return null;
  }
}
