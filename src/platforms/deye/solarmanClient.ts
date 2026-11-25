// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: Solarman V5 本地协议客户端（德业光伏混合逆变器 TCP:8899，忠实对应 pysolarmanv5 / ha-solarman）

import * as net from "node:net";

import type { DeyeSolarmanInverterEntry } from "../configStore.ts";
import {
  DEYE_INVERTER_STATUS_LABELS,
  DEYE_SOLARMAN_READ_BLOCKS,
  DEYE_SOLARMAN_REGISTERS,
} from "./constants.ts";

export const SOLARMAN_V5_START = 0xa5;
export const SOLARMAN_V5_END = 0x15;
export const SOLARMAN_V5_CONTROL_REQUEST = 0x4510;
export const SOLARMAN_V5_CONTROL_RESPONSE = 0x1510;
export const SOLARMAN_V5_CONTROL_HEARTBEAT = 0x4710;
export const SOLARMAN_V5_FRAME_TYPE_SOLAR_INVERTER = 0x02;
export const SOLARMAN_DEFAULT_PORT = 8899;

const DEFAULT_SOLARMAN_TIMEOUT_MS = 6_000;

export class SolarmanV5Error extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SolarmanV5Error";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface DeyeInverterTelemetry {
  pv1PowerW: number;
  pv2PowerW: number;
  pvPowerW: number;
  batterySocPct: number;
  batteryVoltageV: number;
  batteryCurrentA: number;
  batteryPowerW: number;
  gridPowerW: number;
  loadPowerW: number;
  dailyProductionKwh: number;
  totalProductionKwh: number;
  inverterTempC: number;
  runningStatusCode: number;
  runningStatus: string;
}

export interface SolarmanQueryOptions {
  timeoutMs?: number;
}

export interface ISolarmanTransport {
  queryInverterTelemetry(
    entry: DeyeSolarmanInverterEntry,
    options?: SolarmanQueryOptions,
  ): Promise<DeyeInverterTelemetry>;
}

/** 标准 Modbus RTU CRC-16（多项式 0xA001，初值 0xFFFF，返回无符号 16 位整数） */
export function crc16Modbus(bytes: Uint8Array): number {
  let crc = 0xffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i]!;
    for (let bit = 0; bit < 8; bit++) {
      if ((crc & 0x0001) !== 0) {
        crc = ((crc >>> 1) ^ 0xa001) & 0xffff;
      } else {
        crc = (crc >>> 1) & 0xffff;
      }
    }
  }
  return crc & 0xffff;
}

/** Solarman V5 校验和：对帧体切片求和取模 256 */
export function solarmanV5Checksum(frameSlice: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < frameSlice.length; i++) {
    sum = (sum + frameSlice[i]!) & 0xff;
  }
  return sum;
}

/** 构建 Modbus RTU 功能码 0x03（读保持寄存器）8 字节请求帧 */
export function buildModbusReadHoldingRequest(
  slaveId: number,
  startReg: number,
  count: number,
): Uint8Array {
  const frame = new Uint8Array(8);
  frame[0] = slaveId & 0xff;
  frame[1] = 0x03;
  frame[2] = (startReg >>> 8) & 0xff;
  frame[3] = startReg & 0xff;
  frame[4] = (count >>> 8) & 0xff;
  frame[5] = count & 0xff;
  const crc = crc16Modbus(frame.subarray(0, 6));
  frame[6] = crc & 0xff;
  frame[7] = (crc >>> 8) & 0xff;
  return frame;
}

/** 构建 Modbus RTU 功能码 0x03 响应帧（可用于校验与本地测试模拟） */
export function buildModbusReadHoldingResponse(
  slaveId: number,
  registers: readonly number[],
): Uint8Array {
  const byteCount = registers.length * 2;
  const frame = new Uint8Array(3 + byteCount + 2);
  frame[0] = slaveId & 0xff;
  frame[1] = 0x03;
  frame[2] = byteCount & 0xff;
  for (let i = 0; i < registers.length; i++) {
    const val = registers[i]! & 0xffff;
    frame[3 + i * 2] = (val >>> 8) & 0xff;
    frame[3 + i * 2 + 1] = val & 0xff;
  }
  const crc = crc16Modbus(frame.subarray(0, 3 + byteCount));
  frame[3 + byteCount] = crc & 0xff;
  frame[3 + byteCount + 1] = (crc >>> 8) & 0xff;
  return frame;
}

/**
 * 构建完整 Solarman V5 读保持寄存器请求帧（忠实对应 pysolarmanv5 _v5_frame_encoder）。
 */
export function buildSolarmanV5ReadHoldingFrame(
  serial: number,
  slaveId: number,
  startReg: number,
  count: number,
  seq = 1,
): Uint8Array {
  const modbusPayload = buildModbusReadHoldingRequest(slaveId, startReg, count);
  const payloadLength = 15 + modbusPayload.length;
  const frame = new Uint8Array(13 + payloadLength);
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);

  // V5 Header (11 bytes)
  frame[0] = SOLARMAN_V5_START;
  view.setUint16(1, payloadLength, true);
  view.setUint16(3, SOLARMAN_V5_CONTROL_REQUEST, true);
  view.setUint16(5, seq & 0xffff, true);
  view.setUint32(7, serial >>> 0, true);

  // V5 Request Payload Meta (15 bytes: FrameType 1 + SensorType 2 + Working 4 + PowerOn 4 + Offset 4)
  frame[11] = SOLARMAN_V5_FRAME_TYPE_SOLAR_INVERTER;
  view.setUint16(12, 0x0000, true);
  view.setUint32(14, 0x00000000, true);
  view.setUint32(18, 0x00000000, true);
  view.setUint32(22, 0x00000000, true);

  // Embedded Modbus RTU Request
  frame.set(modbusPayload, 26);

  // V5 Trailer (Checksum + 0x15)
  frame[frame.length - 2] = solarmanV5Checksum(frame.subarray(1, frame.length - 2));
  frame[frame.length - 1] = SOLARMAN_V5_END;

  return frame;
}

/**
 * 构建完整 Solarman V5 响应帧（Control=0x1510，14 字节响应元数据 + Modbus RTU 载荷）。
 */
export function buildSolarmanV5ResponseFrame(
  serial: number,
  modbusPayload: Uint8Array,
  seq = 1,
): Uint8Array {
  const payloadLength = 14 + modbusPayload.length;
  const frame = new Uint8Array(13 + payloadLength);
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);

  // V5 Header (11 bytes)
  frame[0] = SOLARMAN_V5_START;
  view.setUint16(1, payloadLength, true);
  view.setUint16(3, SOLARMAN_V5_CONTROL_RESPONSE, true);
  frame[5] = seq & 0xff;
  frame[6] = 0x00;
  view.setUint32(7, serial >>> 0, true);

  // V5 Response Payload Meta (14 bytes: FrameType 1 + Status 1 + Working 4 + PowerOn 4 + Offset 4)
  frame[11] = SOLARMAN_V5_FRAME_TYPE_SOLAR_INVERTER;
  frame[12] = 0x01; // status OK
  view.setUint32(13, 0, true);
  view.setUint32(17, 0, true);
  view.setUint32(21, 0, true);

  // Embedded Modbus RTU Response (starts at byte 25)
  frame.set(modbusPayload, 25);

  // V5 Trailer
  frame[frame.length - 2] = solarmanV5Checksum(frame.subarray(1, frame.length - 2));
  frame[frame.length - 1] = SOLARMAN_V5_END;

  return frame;
}

export interface ParseSolarmanV5Options {
  expectedSerial?: number;
  expectedSeq?: number;
}

/**
 * 解析并校验 Solarman V5 响应帧与内嵌 Modbus RTU 保持寄存器数据。
 */
export function parseSolarmanV5Response(
  buf: Uint8Array,
  options: ParseSolarmanV5Options = {},
): number[] {
  if (buf.length < 32) {
    throw new SolarmanV5Error(`Solarman V5 响应帧过短（${buf.length} 字节）`);
  }
  if (buf[0] !== SOLARMAN_V5_START) {
    throw new SolarmanV5Error(`Solarman V5 起始字节无效：0x${buf[0]!.toString(16)}`);
  }

  const headerView = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const payloadLen = headerView.getUint16(1, true);
  const frameLen = 13 + payloadLen;
  if (buf.length < frameLen) {
    throw new SolarmanV5Error(
      `Solarman V5 帧长度不完整：期望 ${frameLen} 字节，实际 ${buf.length} 字节`,
    );
  }

  const frame = buf.subarray(0, frameLen);
  if (frame[frameLen - 1] !== SOLARMAN_V5_END) {
    throw new SolarmanV5Error(
      `Solarman V5 结束字节无效：0x${frame[frameLen - 1]!.toString(16)}`,
    );
  }

  const expectedChecksum = solarmanV5Checksum(frame.subarray(1, frameLen - 2));
  const actualChecksum = frame[frameLen - 2]!;
  if (actualChecksum !== expectedChecksum) {
    throw new SolarmanV5Error(
      `Solarman V5 校验和不匹配：期望 0x${expectedChecksum.toString(16)}，实际 0x${actualChecksum.toString(16)}`,
    );
  }

  const frameView = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const controlCode = frameView.getUint16(3, true);
  if (controlCode !== SOLARMAN_V5_CONTROL_RESPONSE) {
    throw new SolarmanV5Error(
      `Solarman V5 控制码无效：0x${controlCode.toString(16)}`,
    );
  }

  if (options.expectedSeq !== undefined && frame[5] !== (options.expectedSeq & 0xff)) {
    throw new SolarmanV5Error(
      `Solarman V5 序列号不匹配：期望 ${options.expectedSeq & 0xff}，实际 ${frame[5]}`,
    );
  }

  const serial = frameView.getUint32(7, true);
  if (options.expectedSerial !== undefined && serial !== (options.expectedSerial >>> 0)) {
    throw new SolarmanV5Error(
      `Solarman V5 采集器序列号不匹配：期望 ${options.expectedSerial >>> 0}，实际 ${serial}`,
    );
  }

  if (frame[11] !== SOLARMAN_V5_FRAME_TYPE_SOLAR_INVERTER) {
    throw new SolarmanV5Error(`Solarman V5 帧类型无效：0x${frame[11]!.toString(16)}`);
  }

  const modbus = frame.subarray(25, frameLen - 2);
  if (modbus.length < 5) {
    throw new SolarmanV5Error(`内嵌 Modbus RTU 载荷过短（${modbus.length} 字节）`);
  }

  const computedCrc = crc16Modbus(modbus.subarray(0, modbus.length - 2));
  const actualCrc = modbus[modbus.length - 2]! | (modbus[modbus.length - 1]! << 8);
  if (actualCrc !== computedCrc) {
    throw new SolarmanV5Error(
      `Modbus RTU CRC-16 校验失败：期望 0x${computedCrc.toString(16)}，实际 0x${actualCrc.toString(16)}`,
    );
  }

  const funcCode = modbus[1]!;
  if ((funcCode & 0x80) !== 0) {
    const exceptionCode = modbus[2]!;
    throw new SolarmanV5Error(`Modbus 逆变器返回异常码：0x${exceptionCode.toString(16)}`);
  }
  if (funcCode !== 0x03) {
    throw new SolarmanV5Error(`Modbus 功能码非读保持寄存器响应：0x${funcCode.toString(16)}`);
  }

  const byteCount = modbus[2]!;
  if (byteCount !== modbus.length - 5 || byteCount % 2 !== 0) {
    throw new SolarmanV5Error(`Modbus 寄存器字节计数无效：${byteCount}`);
  }

  const regCount = byteCount / 2;
  const registers: number[] = [];
  for (let i = 0; i < regCount; i++) {
    const hi = modbus[3 + i * 2]!;
    const lo = modbus[3 + i * 2 + 1]!;
    registers.push(((hi << 8) | lo) >>> 0);
  }
  return registers;
}

function toInt16(raw: number): number {
  const val = raw & 0xffff;
  return val >= 0x8000 ? val - 0x10000 : val;
}

function roundDecimal(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * 将德业混合逆变器 Modbus 保持寄存器映射表解码为结构化遥测数据。
 */
export function decodeInverterTelemetryFromRegisters(
  regMap: ReadonlyMap<number, number>,
): DeyeInverterTelemetry {
  const get = (addr: number): number => regMap.get(addr) ?? 0;

  const pv1PowerW = get(DEYE_SOLARMAN_REGISTERS.PV1_POWER);
  const pv2PowerW = get(DEYE_SOLARMAN_REGISTERS.PV2_POWER);
  const pvPowerW = pv1PowerW + pv2PowerW;

  const batterySocPct = get(DEYE_SOLARMAN_REGISTERS.BATTERY_SOC);
  const batteryVoltageV = roundDecimal(get(DEYE_SOLARMAN_REGISTERS.BATTERY_VOLTAGE) * 0.01, 2);
  const batteryCurrentA = roundDecimal(
    toInt16(get(DEYE_SOLARMAN_REGISTERS.BATTERY_CURRENT)) * 0.01,
    2,
  );
  const batteryPowerW = toInt16(get(DEYE_SOLARMAN_REGISTERS.BATTERY_POWER));

  const gridPowerW = toInt16(get(DEYE_SOLARMAN_REGISTERS.GRID_POWER));
  const loadPowerW = get(DEYE_SOLARMAN_REGISTERS.LOAD_POWER);

  const dailyProductionKwh = roundDecimal(get(DEYE_SOLARMAN_REGISTERS.DAILY_PRODUCTION) * 0.1, 1);
  const totalLow = get(DEYE_SOLARMAN_REGISTERS.TOTAL_PRODUCTION_LOW);
  const totalHigh = get(DEYE_SOLARMAN_REGISTERS.TOTAL_PRODUCTION_HIGH);
  const totalRaw = ((totalHigh << 16) | totalLow) >>> 0;
  const totalProductionKwh = roundDecimal(totalRaw * 0.1, 1);

  const acTempRaw = regMap.get(DEYE_SOLARMAN_REGISTERS.AC_TEMPERATURE);
  const dcTempRaw = regMap.get(DEYE_SOLARMAN_REGISTERS.DC_TEMPERATURE);
  const rawTemp = acTempRaw !== undefined && acTempRaw > 0 ? acTempRaw : (dcTempRaw ?? 1000);
  const inverterTempC = roundDecimal((rawTemp - 1000) * 0.1, 1);

  const runningStatusCode = get(DEYE_SOLARMAN_REGISTERS.RUNNING_STATUS);
  const runningStatus = DEYE_INVERTER_STATUS_LABELS[runningStatusCode] ?? `状态 ${runningStatusCode}`;

  return {
    pv1PowerW,
    pv2PowerW,
    pvPowerW,
    batterySocPct,
    batteryVoltageV,
    batteryCurrentA,
    batteryPowerW,
    gridPowerW,
    loadPowerW,
    dailyProductionKwh,
    totalProductionKwh,
    inverterTempC,
    runningStatusCode,
    runningStatus,
  };
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function tryExtractV5Frame(
  buffer: Uint8Array,
): { frame: Uint8Array; rest: Uint8Array } | null {
  let startIdx = 0;
  while (startIdx < buffer.length && buffer[startIdx] !== SOLARMAN_V5_START) {
    startIdx += 1;
  }
  if (startIdx >= buffer.length) {
    return null;
  }
  const viewBuf = startIdx > 0 ? buffer.subarray(startIdx) : buffer;
  if (viewBuf.length < 3) {
    return null;
  }
  const dv = new DataView(viewBuf.buffer, viewBuf.byteOffset, viewBuf.byteLength);
  const payloadLen = dv.getUint16(1, true);
  const totalLen = 13 + payloadLen;
  if (viewBuf.length < totalLen) {
    return null;
  }
  return {
    frame: viewBuf.slice(0, totalLen),
    rest: viewBuf.slice(totalLen),
  };
}

function connectSolarmanSocket(host: string, port: number, timeoutMs: number): Promise<net.Socket> {
  return new Promise<net.Socket>((resolve, reject) => {
    let settled = false;
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        socket.destroy();
        reject(new SolarmanV5Error(`连接 Solarman 采集器超时（${host}:${port}）`));
      }
    }, timeoutMs);

    socket.once("connect", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(socket);
      }
    });
    socket.once("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        reject(new SolarmanV5Error(`连接 Solarman 采集器失败：${err.message}`, { cause: err }));
      }
    });
  });
}

async function exchangeSolarmanV5OnSocket(
  socket: net.Socket,
  requestFrame: Uint8Array,
  expectedSerial: number,
  expectedSeq: number,
  timeoutMs: number,
): Promise<number[]> {
  return await new Promise<number[]>((resolve, reject) => {
    let settled = false;
    let recvBuf: Uint8Array = new Uint8Array(0);

    const cleanup = () => {
      clearTimeout(timer);
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
      socket.removeListener("close", onClose);
    };

    const fail = (err: Error) => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(err);
      }
    };

    const succeed = (regs: number[]) => {
      if (!settled) {
        settled = true;
        cleanup();
        resolve(regs);
      }
    };

    const timer = setTimeout(() => {
      fail(new SolarmanV5Error("等待 Solarman V5 逆变器响应超时"));
    }, timeoutMs);

    const onData = (chunk: Buffer | string) => {
      const chunkBytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      recvBuf = concatBytes(recvBuf, new Uint8Array(chunkBytes));
      while (true) {
        const extracted = tryExtractV5Frame(recvBuf);
        if (!extracted) {
          break;
        }
        recvBuf = extracted.rest;
        const dv = new DataView(
          extracted.frame.buffer,
          extracted.frame.byteOffset,
          extracted.frame.byteLength,
        );
        const ctrl = dv.getUint16(3, true);
        // 忽略采集器主动发送的心跳帧 (0x4710)
        if (ctrl === SOLARMAN_V5_CONTROL_HEARTBEAT) {
          continue;
        }
        try {
          const regs = parseSolarmanV5Response(extracted.frame, {
            expectedSerial,
            expectedSeq,
          });
          succeed(regs);
          return;
        } catch (err) {
          fail(err instanceof Error ? err : new SolarmanV5Error(String(err)));
          return;
        }
      }
    };

    const onError = (err: Error) => {
      fail(new SolarmanV5Error(`Solarman TCP 传输错误：${err.message}`, { cause: err }));
    };

    const onClose = () => {
      fail(new SolarmanV5Error("Solarman TCP 连接在收到响应前已关闭"));
    };

    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("close", onClose);

    socket.write(requestFrame, (err) => {
      if (err) {
        fail(new SolarmanV5Error(`发送 Solarman V5 请求失败：${err.message}`, { cause: err }));
      }
    });
  });
}

/**
 * 通过本地 TCP:8899 读取 Solarman V5 保持寄存器。
 */
export async function readSolarmanHoldingRegisters(
  entry: DeyeSolarmanInverterEntry,
  startReg: number,
  count: number,
  options: SolarmanQueryOptions = {},
): Promise<number[]> {
  const port = entry.port ?? SOLARMAN_DEFAULT_PORT;
  const slaveId = entry.slaveId ?? 1;
  const timeoutMs = options.timeoutMs ?? DEFAULT_SOLARMAN_TIMEOUT_MS;
  const socket = await connectSolarmanSocket(entry.ip, port, timeoutMs);
  try {
    const seq = 1;
    const req = buildSolarmanV5ReadHoldingFrame(entry.serial, slaveId, startReg, count, seq);
    return await exchangeSolarmanV5OnSocket(socket, req, entry.serial, seq, timeoutMs);
  } finally {
    socket.destroy();
  }
}

/**
 * 连接 Solarman V5 采集器（默认端口 8899），批量读取德业混合逆变器核心寄存器并解码遥测。
 */
export async function queryInverterTelemetry(
  entry: DeyeSolarmanInverterEntry,
  options: SolarmanQueryOptions = {},
): Promise<DeyeInverterTelemetry> {
  const port = entry.port ?? SOLARMAN_DEFAULT_PORT;
  const slaveId = entry.slaveId ?? 1;
  const timeoutMs = options.timeoutMs ?? DEFAULT_SOLARMAN_TIMEOUT_MS;

  const socket = await connectSolarmanSocket(entry.ip, port, timeoutMs);
  try {
    const regMap = new Map<number, number>();
    let seq = 1;
    for (const block of DEYE_SOLARMAN_READ_BLOCKS) {
      const req = buildSolarmanV5ReadHoldingFrame(
        entry.serial,
        slaveId,
        block.start,
        block.count,
        seq,
      );
      const values = await exchangeSolarmanV5OnSocket(
        socket,
        req,
        entry.serial,
        seq,
        timeoutMs,
      );
      for (let i = 0; i < values.length; i++) {
        regMap.set(block.start + i, values[i]!);
      }
      seq = (seq + 1) & 0xff || 1;
    }
    return decodeInverterTelemetryFromRegisters(regMap);
  } finally {
    socket.destroy();
  }
}

export class SolarmanV5Client implements ISolarmanTransport {
  private readonly _defaultTimeoutMs: number;

  constructor(options?: SolarmanQueryOptions) {
    this._defaultTimeoutMs = options?.timeoutMs ?? DEFAULT_SOLARMAN_TIMEOUT_MS;
  }

  async queryInverterTelemetry(
    entry: DeyeSolarmanInverterEntry,
    options?: SolarmanQueryOptions,
  ): Promise<DeyeInverterTelemetry> {
    return await queryInverterTelemetry(entry, {
      timeoutMs: options?.timeoutMs ?? this._defaultTimeoutMs,
    });
  }
}
