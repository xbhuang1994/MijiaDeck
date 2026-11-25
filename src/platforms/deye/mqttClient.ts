// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 零依赖纯 TypeScript MQTT 3.1.1 编解码器与德业 Classic / Combo 客户端

import { Buffer } from "node:buffer";
import * as net from "node:net";
import * as tls from "node:tls";

import type { DeyeClassicMqttInfo } from "./cloudClient.ts";
import { QUERY_DEVICE_STATE_COMMAND_CLASSIC } from "./constants.ts";
import { parseClassicStateHex, type DeyeDeviceState } from "./deviceState.ts";

export const MQTT_PACKET_TYPE = {
  CONNECT: 1,
  CONNACK: 2,
  PUBLISH: 3,
  PUBACK: 4,
  SUBSCRIBE: 8,
  SUBACK: 9,
  PINGREQ: 12,
  PINGRESP: 13,
  DISCONNECT: 14,
} as const;

export interface MqttConnectOptions {
  clientId: string;
  username?: string;
  password?: string;
  keepAliveSec?: number;
  cleanSession?: boolean;
}

export interface MqttConnackPacket {
  sessionPresent: boolean;
  returnCode: number;
}

export interface MqttSubackPacket {
  packetId: number;
  returnCodes: number[];
}

export interface MqttPublishOptions {
  qos?: 0 | 1;
  retain?: boolean;
  dup?: boolean;
  packetId?: number;
}

export interface MqttPublishPacket {
  topic: string;
  payload: Uint8Array;
  qos: number;
  retain: boolean;
  dup: boolean;
  packetId?: number;
}

export interface DeyeMqttRequestOptions {
  timeoutMs?: number;
  useTls?: boolean;
  rejectUnauthorized?: boolean;
}

export interface IDeyeClassicMqttTransport {
  queryDeviceState(
    mqttInfo: DeyeClassicMqttInfo,
    productId: string,
    deviceId: string,
    options?: DeyeMqttRequestOptions,
  ): Promise<DeyeDeviceState>;
  publishCommand(
    mqttInfo: DeyeClassicMqttInfo,
    productId: string,
    deviceId: string,
    payloads: Uint8Array[],
    options?: DeyeMqttRequestOptions,
  ): Promise<void>;
}

const MAX_REMAINING_LENGTH = 268_435_455;
const DEFAULT_MQTT_TIMEOUT_MS = 10_000;

function concatUint8Arrays(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) {
    total += chunk.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** 编码 MQTT 3.1.1 变长 Remaining Length（1..4 字节） */
export function encodeRemainingLength(length: number): Uint8Array {
  if (!Number.isInteger(length) || length < 0 || length > MAX_REMAINING_LENGTH) {
    throw new Error(`MQTT Remaining Length 越界：${length}`);
  }
  const out: number[] = [];
  let x = length;
  do {
    let encodedByte = x % 128;
    x = Math.floor(x / 128);
    if (x > 0) {
      encodedByte |= 0x80;
    }
    out.push(encodedByte);
  } while (x > 0);
  return new Uint8Array(out);
}

/**
 * 解码 MQTT 3.1.1 变长 Remaining Length。
 * 若缓冲区字节尚不足以完成解码，返回 `null` 以便流式读取继续等待。
 */
export function decodeRemainingLength(
  buf: Uint8Array,
  offset = 0,
): { value: number; bytesRead: number } | null {
  let multiplier = 1;
  let value = 0;
  let bytesRead = 0;

  while (true) {
    if (offset + bytesRead >= buf.length) {
      return null;
    }
    const encodedByte = buf[offset + bytesRead]!;
    bytesRead += 1;
    value += (encodedByte & 0x7f) * multiplier;
    if ((encodedByte & 0x80) === 0) {
      return { value, bytesRead };
    }
    if (bytesRead >= 4) {
      throw new Error("MQTT Remaining Length 编码无效（超过 4 字节）");
    }
    multiplier *= 128;
  }
}

/** 编码 MQTT 3.1.1 长度前缀 UTF-8 字符串 */
export function encodeMqttString(str: string): Uint8Array {
  const bytes = Buffer.from(str, "utf8");
  if (bytes.length > 0xffff) {
    throw new Error(`MQTT UTF-8 字符串过长：${bytes.length}`);
  }
  const out = new Uint8Array(2 + bytes.length);
  out[0] = (bytes.length >> 8) & 0xff;
  out[1] = bytes.length & 0xff;
  out.set(bytes, 2);
  return out;
}

/** 编码 MQTT 3.1.1 CONNECT 报文 */
export function encodeConnectPacket(options: MqttConnectOptions): Uint8Array {
  const cleanSession = options.cleanSession ?? true;
  const keepAliveSec = options.keepAliveSec ?? 60;
  const hasUsername = options.username !== undefined && options.username.length > 0;
  const hasPassword = hasUsername && options.password !== undefined;

  let connectFlags = 0;
  if (cleanSession) {
    connectFlags |= 0x02;
  }
  if (hasUsername) {
    connectFlags |= 0x80;
  }
  if (hasPassword) {
    connectFlags |= 0x40;
  }

  const variableHeader = new Uint8Array([
    0x00,
    0x04,
    0x4d, // 'M'
    0x51, // 'Q'
    0x54, // 'T'
    0x54, // 'T'
    0x04, // Protocol Level 4 (MQTT 3.1.1)
    connectFlags,
    (keepAliveSec >> 8) & 0xff,
    keepAliveSec & 0xff,
  ]);

  const payloadParts: Uint8Array[] = [encodeMqttString(options.clientId)];
  if (hasUsername) {
    payloadParts.push(encodeMqttString(options.username!));
  }
  if (hasPassword) {
    payloadParts.push(encodeMqttString(options.password!));
  }
  const payload = concatUint8Arrays(payloadParts);
  const remaining = encodeRemainingLength(variableHeader.length + payload.length);

  return concatUint8Arrays([new Uint8Array([0x10]), remaining, variableHeader, payload]);
}

/** 解码 MQTT 3.1.1 CONNACK 报文 */
export function decodeConnackPacket(packet: Uint8Array): MqttConnackPacket {
  if (packet.length < 4 || packet[0] !== 0x20 || packet[1] !== 0x02) {
    throw new Error("无效的 MQTT CONNACK 报文");
  }
  return {
    sessionPresent: (packet[2]! & 0x01) !== 0,
    returnCode: packet[3]!,
  };
}

/** 编码 MQTT 3.1.1 SUBSCRIBE 报文 */
export function encodeSubscribePacket(
  packetId: number,
  topic: string,
  qos: 0 | 1 = 0,
): Uint8Array {
  const topicBytes = encodeMqttString(topic);
  const body = new Uint8Array(2 + topicBytes.length + 1);
  body[0] = (packetId >> 8) & 0xff;
  body[1] = packetId & 0xff;
  body.set(topicBytes, 2);
  body[2 + topicBytes.length] = qos & 0x03;

  const remaining = encodeRemainingLength(body.length);
  return concatUint8Arrays([new Uint8Array([0x82]), remaining, body]);
}

/** 解码 MQTT 3.1.1 SUBACK 报文 */
export function decodeSubackPacket(packet: Uint8Array): MqttSubackPacket {
  if (packet.length < 4 || (packet[0]! & 0xf0) !== 0x90) {
    throw new Error("无效的 MQTT SUBACK 报文");
  }
  const lenInfo = decodeRemainingLength(packet, 1);
  if (!lenInfo || packet.length < 1 + lenInfo.bytesRead + lenInfo.value || lenInfo.value < 3) {
    throw new Error("MQTT SUBACK 报文长度不完整");
  }
  const headerLen = 1 + lenInfo.bytesRead;
  const packetId = ((packet[headerLen]! << 8) | packet[headerLen + 1]!) >>> 0;
  const returnCodes = [...packet.subarray(headerLen + 2, headerLen + lenInfo.value)];
  return { packetId, returnCodes };
}

/** 编码 MQTT 3.1.1 PUBLISH 报文 */
export function encodePublishPacket(
  topic: string,
  payload: Uint8Array | string,
  options: MqttPublishOptions = {},
): Uint8Array {
  const qos = options.qos ?? 0;
  const retain = options.retain ?? false;
  const dup = options.dup ?? false;
  const headerByte = 0x30 | (dup ? 0x08 : 0) | ((qos & 0x03) << 1) | (retain ? 0x01 : 0);

  const topicBytes = encodeMqttString(topic);
  const payloadBytes =
    typeof payload === "string" ? new Uint8Array(Buffer.from(payload, "utf8")) : payload;

  const parts: Uint8Array[] = [topicBytes];
  if (qos > 0) {
    const pid = options.packetId ?? 1;
    parts.push(new Uint8Array([(pid >> 8) & 0xff, pid & 0xff]));
  }
  parts.push(payloadBytes);

  const body = concatUint8Arrays(parts);
  const remaining = encodeRemainingLength(body.length);
  return concatUint8Arrays([new Uint8Array([headerByte]), remaining, body]);
}

/** 解码 MQTT 3.1.1 PUBLISH 报文 */
export function decodePublishPacket(packet: Uint8Array): MqttPublishPacket {
  if (packet.length < 4 || (packet[0]! & 0xf0) !== 0x30) {
    throw new Error("无效的 MQTT PUBLISH 报文");
  }
  const flags = packet[0]! & 0x0f;
  const dup = (flags & 0x08) !== 0;
  const qos = (flags >> 1) & 0x03;
  const retain = (flags & 0x01) !== 0;

  const lenInfo = decodeRemainingLength(packet, 1);
  if (!lenInfo) {
    throw new Error("MQTT PUBLISH Remaining Length 不完整");
  }
  const bodyStart = 1 + lenInfo.bytesRead;
  const bodyEnd = bodyStart + lenInfo.value;
  if (packet.length < bodyEnd || lenInfo.value < 2) {
    throw new Error("MQTT PUBLISH 报文内容截断");
  }

  const topicLen = ((packet[bodyStart]! << 8) | packet[bodyStart + 1]!) >>> 0;
  const topicStart = bodyStart + 2;
  const topicEnd = topicStart + topicLen;
  if (topicEnd > bodyEnd) {
    throw new Error("MQTT PUBLISH 主题长度越界");
  }
  const topic = Buffer.from(packet.subarray(topicStart, topicEnd)).toString("utf8");

  let payloadStart = topicEnd;
  let packetId: number | undefined;
  if (qos > 0) {
    if (payloadStart + 2 > bodyEnd) {
      throw new Error("MQTT PUBLISH 缺少 QoS Packet Identifier");
    }
    packetId = ((packet[payloadStart]! << 8) | packet[payloadStart + 1]!) >>> 0;
    payloadStart += 2;
  }

  const payload = packet.slice(payloadStart, bodyEnd);
  return packetId !== undefined
    ? { topic, payload, qos, retain, dup, packetId }
    : { topic, payload, qos, retain, dup };
}

/** 编码 MQTT 3.1.1 PINGREQ 报文 */
export function encodePingreqPacket(): Uint8Array {
  return new Uint8Array([0xc0, 0x00]);
}

/** 编码 MQTT 3.1.1 DISCONNECT 报文 */
export function encodeDisconnectPacket(): Uint8Array {
  return new Uint8Array([0xe0, 0x00]);
}

/** 从流式缓冲中拆分出一个完整的 MQTT 控制报文 */
export function tryExtractMqttPacket(
  buffer: Uint8Array,
): { packet: Uint8Array; rest: Uint8Array } | null {
  if (buffer.length < 2) {
    return null;
  }
  const lenInfo = decodeRemainingLength(buffer, 1);
  if (!lenInfo) {
    return null;
  }
  const totalLength = 1 + lenInfo.bytesRead + lenInfo.value;
  if (buffer.length < totalLength) {
    return null;
  }
  return {
    packet: buffer.slice(0, totalLength),
    rest: buffer.slice(totalLength),
  };
}

/** 构建德业 Classic / Combo 主题前缀 */
export function classicTopicPrefix(
  endpoint: string | undefined,
  productId: string,
  deviceId: string,
): string {
  const cleanEndpoint = (endpoint ?? "").trim().replace(/^\/+|\/+$/g, "");
  return cleanEndpoint ? `${cleanEndpoint}/${productId}/${deviceId}` : `${productId}/${deviceId}`;
}

function extractClassicHexFromMqttPayload(payload: Uint8Array): string {
  const text = Buffer.from(payload).toString("utf8").trim();
  if (text.startsWith("{")) {
    const parsed: unknown = JSON.parse(text);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>)["data"] === "string"
    ) {
      return (parsed as Record<string, string>)["data"]!;
    }
    throw new Error("德业 Classic MQTT 状态 JSON 缺少字符串 data 字段");
  }
  if (/^[0-9a-fA-F\s]+$/.test(text) && text.replace(/\s+/g, "").length >= 36) {
    return text;
  }
  // 兼容直接下发原始二进制字节的代理
  if (payload.length >= 18) {
    return Buffer.from(payload).toString("hex");
  }
  throw new Error("无法识别的德业 Classic MQTT 状态载荷");
}

function connectSocket(
  host: string,
  port: number,
  useTls: boolean,
  timeoutMs: number,
  rejectUnauthorized = true,
): Promise<net.Socket> {
  return new Promise<net.Socket>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        socket.destroy();
        reject(new Error(`连接德业 MQTT 服务器超时（${host}:${port}）`));
      }
    }, timeoutMs);

    const onConnect = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        socket.removeListener("error", onError);
        resolve(socket);
      }
    };

    const onError = (err: Error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        reject(new Error(`连接德业 MQTT 服务器失败：${err.message}`));
      }
    };

    const socket: net.Socket = useTls
      ? tls.connect({
          host,
          port,
          servername: host,
          rejectUnauthorized,
        })
      : net.createConnection({ host, port });

    socket.once(useTls ? "secureConnect" : "connect", onConnect);
    socket.once("error", onError);
  });
}

class MqttPacketStream {
  private _buf: Uint8Array = new Uint8Array(0);
  private readonly _queue: Uint8Array[] = [];
  private _waiter:
    | { resolve: (pkt: Uint8Array) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }
    | null = null;
  private _closedError: Error | null = null;

  constructor(private readonly _socket: net.Socket) {
    this._socket.on("data", this._onData);
    this._socket.on("error", this._onError);
    this._socket.on("close", this._onClose);
  }

  private readonly _onData = (chunk: Buffer): void => {
    this._buf = concatUint8Arrays([this._buf, new Uint8Array(chunk)]);
    try {
      while (true) {
        const extracted = tryExtractMqttPacket(this._buf);
        if (!extracted) {
          break;
        }
        this._buf = extracted.rest;
        if (this._waiter) {
          const waiter = this._waiter;
          this._waiter = null;
          clearTimeout(waiter.timer);
          waiter.resolve(extracted.packet);
        } else {
          this._queue.push(extracted.packet);
        }
      }
    } catch (err) {
      this._fail(err instanceof Error ? err : new Error(String(err)));
    }
  };

  private readonly _onError = (err: Error): void => {
    this._fail(new Error(`德业 MQTT 传输错误：${err.message}`));
  };

  private readonly _onClose = (): void => {
    this._fail(new Error("德业 MQTT 连接意外关闭"));
  };

  private _fail(err: Error): void {
    if (!this._closedError) {
      this._closedError = err;
    }
    if (this._waiter) {
      const waiter = this._waiter;
      this._waiter = null;
      clearTimeout(waiter.timer);
      waiter.reject(this._closedError);
    }
  }

  nextPacket(timeoutMs: number): Promise<Uint8Array> {
    if (this._queue.length > 0) {
      return Promise.resolve(this._queue.shift()!);
    }
    if (this._closedError) {
      return Promise.reject(this._closedError);
    }
    return new Promise<Uint8Array>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this._waiter) {
          this._waiter = null;
          reject(new Error("等待德业 MQTT 响应超时"));
        }
      }, timeoutMs);
      this._waiter = { resolve, reject, timer };
    });
  }

  detach(): void {
    this._socket.removeListener("data", this._onData);
    this._socket.removeListener("error", this._onError);
    this._socket.removeListener("close", this._onClose);
    if (this._waiter) {
      clearTimeout(this._waiter.timer);
      this._waiter = null;
    }
  }
}

function writePacket(socket: net.Socket, data: Uint8Array): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    socket.write(data, (err) => {
      if (err) {
        reject(new Error(`发送 MQTT 报文失败：${err.message}`));
      } else {
        resolve();
      }
    });
  });
}

/**
 * 德业 Classic / Combo 平台轻量级 MQTT 3.1.1 客户端（零第三方依赖）。
 */
export class DeyeClassicMqttClient implements IDeyeClassicMqttTransport {
  private readonly _defaultTimeoutMs: number;

  constructor(options?: { timeoutMs?: number }) {
    this._defaultTimeoutMs = options?.timeoutMs ?? DEFAULT_MQTT_TIMEOUT_MS;
  }

  private async _openSession(
    mqttInfo: DeyeClassicMqttInfo,
    options?: DeyeMqttRequestOptions,
  ): Promise<{ socket: net.Socket; stream: MqttPacketStream; timeoutMs: number }> {
    const timeoutMs = options?.timeoutMs ?? this._defaultTimeoutMs;
    const useTls =
      options?.useTls !== undefined ? options.useTls : Number(mqttInfo.sslport) > 0;
    const port = useTls ? Number(mqttInfo.sslport) : Number(mqttInfo.mqttport);
    if (!mqttInfo.mqtthost || !Number.isFinite(port) || port <= 0) {
      throw new Error("德业 Classic MQTT 服务器地址或端口无效");
    }

    const socket = await connectSocket(
      mqttInfo.mqtthost,
      port,
      useTls,
      timeoutMs,
      options?.rejectUnauthorized ?? true,
    );
    const stream = new MqttPacketStream(socket);

    try {
      const clientId =
        mqttInfo.clientid || `mijiadeck-deye-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      await writePacket(
        socket,
        encodeConnectPacket({
          clientId,
          username: mqttInfo.loginname,
          password: mqttInfo.password,
          keepAliveSec: 30,
          cleanSession: true,
        }),
      );

      const connackRaw = await stream.nextPacket(timeoutMs);
      const connack = decodeConnackPacket(connackRaw);
      if (connack.returnCode !== 0) {
        throw new Error(`德业 MQTT 认证被拒绝（CONNACK 返回码 ${connack.returnCode}）`);
      }
      return { socket, stream, timeoutMs };
    } catch (err) {
      stream.detach();
      socket.destroy();
      throw err;
    }
  }

  private async _closeSession(socket: net.Socket, stream: MqttPacketStream): Promise<void> {
    stream.detach();
    if (socket.destroyed) {
      return;
    }
    try {
      if (socket.writable) {
        await new Promise<void>((resolve) => {
          let done = false;
          const finish = () => {
            if (!done) {
              done = true;
              clearTimeout(timer);
              resolve();
            }
          };
          const timer = setTimeout(() => {
            socket.destroy();
            finish();
          }, 500);
          socket.once("close", finish);
          socket.once("error", finish);
          socket.end(encodeDisconnectPacket());
        });
      }
    } catch {
      // ignore disconnect write failure
    } finally {
      if (!socket.destroyed) {
        socket.destroy();
      }
    }
  }

  /**
   * 订阅 `<prefix>/status/hex`、发布 `0x00 0x01` 状态查询指令到 `<prefix>/command/hex`，
   * 并等待解析最新 Classic 状态帧。
   */
  async queryDeviceState(
    mqttInfo: DeyeClassicMqttInfo,
    productId: string,
    deviceId: string,
    options?: DeyeMqttRequestOptions,
  ): Promise<DeyeDeviceState> {
    const { socket, stream, timeoutMs } = await this._openSession(mqttInfo, options);
    const prefix = classicTopicPrefix(mqttInfo.endpoint, productId, deviceId);
    const statusTopic = `${prefix}/status/hex`;
    const commandTopic = `${prefix}/command/hex`;

    try {
      await writePacket(socket, encodeSubscribePacket(1, statusTopic, 0));
      const deadline = Date.now() + timeoutMs;

      // 等待 SUBACK
      while (true) {
        const remain = deadline - Date.now();
        if (remain <= 0) {
          throw new Error("等待德业 MQTT SUBACK 确认超时");
        }
        const pkt = await stream.nextPacket(remain);
        const type = (pkt[0]! >> 4) & 0x0f;
        if (type === MQTT_PACKET_TYPE.SUBACK) {
          decodeSubackPacket(pkt);
          break;
        }
        if (type === MQTT_PACKET_TYPE.PUBLISH) {
          const pub = decodePublishPacket(pkt);
          if (pub.topic === statusTopic) {
            return parseClassicStateHex(extractClassicHexFromMqttPayload(pub.payload));
          }
        }
      }

      // 发布 00 01 查询指令
      await writePacket(
        socket,
        encodePublishPacket(commandTopic, QUERY_DEVICE_STATE_COMMAND_CLASSIC, { qos: 0 }),
      );

      // 等待匹配主题的 PUBLISH
      while (true) {
        const remain = deadline - Date.now();
        if (remain <= 0) {
          throw new Error("等待德业 Classic 设备状态回报超时");
        }
        const pkt = await stream.nextPacket(remain);
        const type = (pkt[0]! >> 4) & 0x0f;
        if (type === MQTT_PACKET_TYPE.PUBLISH) {
          const pub = decodePublishPacket(pkt);
          if (pub.topic === statusTopic) {
            return parseClassicStateHex(extractClassicHexFromMqttPayload(pub.payload));
          }
        }
      }
    } finally {
      await this._closeSession(socket, stream);
    }
  }

  /**
   * 向 `<prefix>/command/hex` 发布一条或多条控制指令载荷
   * （Classic 10 字节指令或 Combo 4 字节单属性帧）。
   */
  async publishCommand(
    mqttInfo: DeyeClassicMqttInfo,
    productId: string,
    deviceId: string,
    payloads: Uint8Array[],
    options?: DeyeMqttRequestOptions,
  ): Promise<void> {
    if (payloads.length === 0) {
      return;
    }
    const { socket, stream } = await this._openSession(mqttInfo, options);
    const prefix = classicTopicPrefix(mqttInfo.endpoint, productId, deviceId);
    const commandTopic = `${prefix}/command/hex`;

    try {
      for (const payload of payloads) {
        await writePacket(socket, encodePublishPacket(commandTopic, payload, { qos: 0 }));
      }
    } finally {
      await this._closeSession(socket, stream);
    }
  }
}
