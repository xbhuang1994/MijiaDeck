// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 美的局域网 V2 (0x5A5A) & V3 (0x8370) TCP:6444 客户端与 UDP 6445/20086 广播发现

import dgram from "node:dgram";
import net from "node:net";
import {
  DISCOVERY_MSG,
  DISCOVERY_MSG_LEGACY,
  MIDEA_DEFAULT_FALLBACK_KEYPAIR,
  MIDEA_DISCOVERY_PORTS,
  MIDEA_LAN_TCP_PORT,
} from "./constants.ts";
import {
  MSGTYPE_ENCRYPTED_REQUEST,
  MSGTYPE_ENCRYPTED_RESPONSE,
  MSGTYPE_ERROR,
  MSGTYPE_HANDSHAKE_REQUEST,
  MSGTYPE_HANDSHAKE_RESPONSE,
  MideaLocalSecurity,
} from "./security.ts";

export interface MideaLanDeviceEndpoint {
  id: string;
  ip: string;
  port?: number;
  type: number;
  protocolVersion: 2 | 3;
  token?: string;
  key?: string;
}

export interface MideaLanDiscoveredDevice {
  id: string;
  ip: string;
  port: number;
  type: number;
  protocolVersion: 2 | 3;
  sn: string;
  sn8: string;
  ssid?: string;
}

export interface MideaLanDiscoveryOptions {
  timeoutMs?: number;
  broadcastAddress?: string;
  ports?: readonly number[];
}

export interface IMideaLanTransport {
  sendFrame(endpoint: MideaLanDeviceEndpoint, frame: Uint8Array): Promise<Buffer>;
  discover?(options?: MideaLanDiscoveryOptions): Promise<MideaLanDiscoveredDevice[]>;
  close?(id?: string): void;
}

export interface MideaLanClientOptions {
  timeoutMs?: number;
  retries?: number;
}

export class MideaLanError extends Error {
  readonly isAuthError: boolean;

  constructor(message: string, isAuthError = false, options?: ErrorOptions) {
    super(message, options);
    this.name = "MideaLanError";
    this.isAuthError = isAuthError;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function hexToBuffer(hex: string, expectedBytes: number, fieldName: string): Buffer {
  const clean = hex.trim();
  if (!/^[0-9a-f]+$/i.test(clean) || clean.length !== expectedBytes * 2) {
    throw new MideaLanError(
      `美的 V3 ${fieldName} 格式无效：应为 ${expectedBytes * 2} 位十六进制字符串`,
      true,
    );
  }
  return Buffer.from(clean, "hex");
}

function unwrapApplicationFrame(inner: Buffer): Buffer {
  if (inner.length >= 72 && inner[0] === 0x5a && inner[1] === 0x5a) {
    const decoded = MideaLocalSecurity.decode5a5a(inner);
    return decoded.payload;
  }
  if (inner.includes(0xaa)) {
    return inner.subarray(inner.indexOf(0xaa));
  }
  return inner;
}

function extractTypeFromSsidOrSn(ssid: string, sn: string): number {
  const ssidMatch = /(?:midea|net)_([0-9a-f]{2})_/i.exec(ssid);
  if (ssidMatch?.[1]) {
    return Number.parseInt(ssidMatch[1], 16) & 0xff;
  }
  // 部分模组 SN 第 2..4 位直接编码品类十六进制（如 "0000AC..." 或 "P00000000..."）
  const snMatch = /^0{4}([0-9a-f]{2})/i.exec(sn);
  if (snMatch?.[1]) {
    return Number.parseInt(snMatch[1], 16) & 0xff;
  }
  return 0xac;
}

/**
 * 解析美的局域网 UDP 发现响应（同时支持 V2 `0x5A5A` 与 V3 `0x8370` 响应帧）。
 */
export function parseDiscoveryResponse(
  raw: Uint8Array,
  remoteIp: string,
): MideaLanDiscoveredDevice | null {
  const buf = Buffer.from(raw);
  if (buf.length < 72) {
    return null;
  }

  let protocolVersion: 2 | 3 = 2;
  let packet5a5a: Buffer | null = null;

  if (buf[0] === 0x5a && buf[1] === 0x5a) {
    protocolVersion = 2;
    packet5a5a = buf;
  } else if (buf[0] === 0x83 && buf[1] === 0x70) {
    protocolVersion = 3;
    const innerOffset = buf.indexOf(Buffer.from([0x5a, 0x5a]), 6);
    if (innerOffset >= 6 && buf.length - innerOffset >= 72) {
      packet5a5a = buf.subarray(innerOffset);
    } else {
      return null;
    }
  } else {
    return null;
  }

  let decoded;
  try {
    decoded = MideaLocalSecurity.decode5a5a(packet5a5a, { verifySignature: true });
  } catch {
    try {
      decoded = MideaLocalSecurity.decode5a5a(packet5a5a, { verifySignature: false });
    } catch {
      return null;
    }
  }

  const payload = decoded.payload;
  if (payload.length < 40) {
    return null;
  }

  // payload[0..4] 为倒序 IPv4（如 [100, 1, 168, 192] -> 192.168.1.100）
  const parsedIp = `${payload[3]}.${payload[2]}.${payload[1]}.${payload[0]}`;
  const ip = parsedIp === "0.0.0.0" || parsedIp === "255.255.255.255" ? remoteIp : parsedIp;
  const rawPort = payload.readUInt32LE(4);
  const port = rawPort > 0 && rawPort <= 65535 ? rawPort : MIDEA_LAN_TCP_PORT;

  const sn = payload
    .subarray(8, 40)
    .toString("ascii")
    .replace(/\0+$/g, "")
    .trim();
  const sn8 = sn.length >= 17 ? sn.slice(9, 17) : "";

  let ssid = "";
  let type = 0xac;
  if (payload.length > 41) {
    const ssidLen = payload[40]!;
    if (ssidLen > 0 && 41 + ssidLen <= payload.length) {
      ssid = payload
        .subarray(41, 41 + ssidLen)
        .toString("ascii")
        .replace(/\0+$/g, "")
        .trim();
    }
    const typeIdx = 41 + ssidLen + 3;
    if (ssid) {
      type = extractTypeFromSsidOrSn(ssid, sn);
    } else if (typeIdx < payload.length && payload[typeIdx]! > 0) {
      type = payload[typeIdx]!;
    } else {
      type = extractTypeFromSsidOrSn("", sn);
    }
  } else {
    type = extractTypeFromSsidOrSn("", sn);
  }

  const id = decoded.applianceId.toString(10);
  if (!id || id === "0") {
    return null;
  }

  return {
    id,
    ip,
    port,
    type,
    protocolVersion,
    sn,
    sn8,
    ...(ssid ? { ssid } : {}),
  };
}

/**
 * 局域网 UDP 广播发现美的设备（向 `255.255.255.255:6445` 与 `20086` 广播发现帧）。
 */
export function discoverMideaLanDevices(
  options?: MideaLanDiscoveryOptions,
): Promise<MideaLanDiscoveredDevice[]> {
  const timeoutMs = Math.max(200, Math.min(options?.timeoutMs ?? 2500, 15_000));
  const broadcastAddress = options?.broadcastAddress ?? "255.255.255.255";
  const ports = options?.ports ?? MIDEA_DISCOVERY_PORTS;

  return new Promise<MideaLanDiscoveredDevice[]>((resolve) => {
    const found = new Map<string, MideaLanDiscoveredDevice>();
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let socket: dgram.Socket | null = null;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (socket) {
        try {
          socket.close();
        } catch {
          // ignore close failure
        }
        socket = null;
      }
      resolve([...found.values()]);
    };

    try {
      socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    } catch {
      finish();
      return;
    }

    socket.on("error", () => {
      finish();
    });

    socket.on("message", (msg, rinfo) => {
      const parsed = parseDiscoveryResponse(msg, rinfo.address);
      if (parsed) {
        found.set(parsed.id, parsed);
      }
    });

    socket.bind(0, () => {
      if (!socket || settled) return;
      try {
        socket.setBroadcast(true);
      } catch {
        // continue best-effort
      }

      const probes = [Buffer.from(DISCOVERY_MSG), Buffer.from(DISCOVERY_MSG_LEGACY)];
      for (const port of ports) {
        for (const probe of probes) {
          try {
            socket.send(probe, 0, probe.length, port, broadcastAddress, () => {
              // ignore individual UDP send error
            });
          } catch {
            // ignore
          }
        }
      }
    });

    timer = setTimeout(finish, timeoutMs);
  });
}

/**
 * 纯 TypeScript 美的局域网 TCP:6444 客户端（同时支持 V2 `0x5A5A` 与 V3 `0x8370` 加密会话）。
 */
export class MideaLanClient implements IMideaLanTransport {
  private readonly _timeoutMs: number;
  private readonly _retries: number;
  private readonly _activeSockets = new Set<net.Socket>();

  constructor(options?: MideaLanClientOptions) {
    this._timeoutMs = options?.timeoutMs ?? 5_000;
    this._retries = Math.max(0, options?.retries ?? 1);
  }

  close(): void {
    for (const sock of [...this._activeSockets]) {
      try {
        sock.destroy();
      } catch {
        // ignore
      }
    }
    this._activeSockets.clear();
  }

  async discover(options?: MideaLanDiscoveryOptions): Promise<MideaLanDiscoveredDevice[]> {
    return await discoverMideaLanDevices(options);
  }

  async sendFrame(endpoint: MideaLanDeviceEndpoint, frame: Uint8Array): Promise<Buffer> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this._retries; attempt++) {
      try {
        if (endpoint.protocolVersion === 2) {
          return await this._exchangeV2(endpoint, frame);
        }
        return await this._exchangeV3(endpoint, frame);
      } catch (err) {
        lastError = err;
        if (err instanceof MideaLanError && err.isAuthError) {
          throw err;
        }
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new MideaLanError(`美的局域网通信失败：${String(lastError)}`);
  }

  private _openSocket(host: string, port: number): Promise<net.Socket> {
    return new Promise<net.Socket>((resolve, reject) => {
      const socket = net.createConnection({ host, port });
      this._activeSockets.add(socket);

      let settled = false;
      const cleanup = (): void => {
        socket.removeListener("connect", onConnect);
        socket.removeListener("error", onError);
        socket.removeListener("timeout", onTimeout);
      };

      const onConnect = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        socket.setTimeout(this._timeoutMs);
        resolve(socket);
      };

      const onError = (err: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        this._destroySocket(socket);
        reject(new MideaLanError(`无法连接美的设备 ${host}:${port}：${err.message}`, false, { cause: err }));
      };

      const onTimeout = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        this._destroySocket(socket);
        reject(new MideaLanError(`连接美的设备 ${host}:${port} 超时`));
      };

      socket.setTimeout(this._timeoutMs);
      socket.once("connect", onConnect);
      socket.once("error", onError);
      socket.once("timeout", onTimeout);
    });
  }

  private _destroySocket(socket: net.Socket): void {
    this._activeSockets.delete(socket);
    try {
      socket.destroy();
    } catch {
      // ignore
    }
  }

  private _exchangeV2(endpoint: MideaLanDeviceEndpoint, frame: Uint8Array): Promise<Buffer> {
    const port = endpoint.port ?? MIDEA_LAN_TCP_PORT;
    const packet = MideaLocalSecurity.encode5a5a(frame, endpoint.id);

    return this._openSocket(endpoint.ip, port).then(
      (socket) =>
        new Promise<Buffer>((resolve, reject) => {
          let buffer: Buffer = Buffer.alloc(0);
          let settled = false;

          const finish = (err?: Error, data?: Buffer): void => {
            if (settled) return;
            settled = true;
            this._destroySocket(socket);
            if (err) reject(err);
            else resolve(data!);
          };

          socket.on("data", (chunk: Buffer) => {
            buffer = Buffer.concat([buffer, chunk]);
            if (buffer.length < 6) return;
            if (buffer[0] !== 0x5a || buffer[1] !== 0x5a) {
              finish(new MideaLanError("美的 V2 设备返回无效帧头（非 0x5A5A）"));
              return;
            }
            const declaredLen = buffer.readUInt16LE(4);
            if (declaredLen < 72) {
              finish(new MideaLanError(`美的 V2 响应长度字段无效：${declaredLen}`));
              return;
            }
            if (buffer.length < declaredLen) {
              return;
            }
            try {
              const decoded = MideaLocalSecurity.decode5a5a(buffer.subarray(0, declaredLen));
              finish(undefined, decoded.payload);
            } catch (err) {
              finish(
                new MideaLanError(
                  `美的 V2 响应解密或校验失败：${err instanceof Error ? err.message : String(err)}`,
                  false,
                  { cause: err },
                ),
              );
            }
          });

          socket.once("error", (err) => {
            finish(new MideaLanError(`美的 V2 通信异常：${err.message}`, false, { cause: err }));
          });

          socket.once("timeout", () => {
            finish(new MideaLanError(`等待美的 V2 设备 ${endpoint.ip}:${port} 响应超时`));
          });

          socket.once("close", () => {
            finish(new MideaLanError("美的 V2 设备在返回响应前关闭了连接"));
          });

          socket.write(packet);
        }),
    );
  }

  private _exchangeV3(endpoint: MideaLanDeviceEndpoint, frame: Uint8Array): Promise<Buffer> {
    const port = endpoint.port ?? MIDEA_LAN_TCP_PORT;
    const tokenHex = endpoint.token?.trim() || MIDEA_DEFAULT_FALLBACK_KEYPAIR.token;
    const keyHex = endpoint.key?.trim() || MIDEA_DEFAULT_FALLBACK_KEYPAIR.key;
    const tokenBuf = hexToBuffer(tokenHex, 64, "token");
    const keyBuf = hexToBuffer(keyHex, 32, "key");

    const security = new MideaLocalSecurity();
    const handshakePacket = security.encode8370(tokenBuf, MSGTYPE_HANDSHAKE_REQUEST);
    const inner5a5a = MideaLocalSecurity.encode5a5a(frame, endpoint.id);

    return this._openSocket(endpoint.ip, port).then(
      (socket) =>
        new Promise<Buffer>((resolve, reject) => {
          let stage: "handshake" | "command" = "handshake";
          let rxBuffer: Buffer = Buffer.alloc(0);
          let settled = false;

          const finish = (err?: Error, data?: Buffer): void => {
            if (settled) return;
            settled = true;
            this._destroySocket(socket);
            if (err) reject(err);
            else resolve(data!);
          };

          socket.on("data", (chunk: Buffer) => {
            rxBuffer = Buffer.concat([rxBuffer, chunk]);
            try {
              const { packets, remainder } = security.decode8370(rxBuffer);
              rxBuffer = remainder;

              for (const pkt of packets) {
                if (pkt.msgType === MSGTYPE_ERROR) {
                  finish(
                    new MideaLanError(
                      `美的 V3 设备返回错误帧：${pkt.payload.toString("ascii") || "ERROR"}`,
                      stage === "handshake",
                    ),
                  );
                  return;
                }

                if (stage === "handshake") {
                  if (pkt.msgType !== MSGTYPE_HANDSHAKE_RESPONSE) {
                    continue;
                  }
                  security.deriveTcpKey(pkt.payload, keyBuf);
                  stage = "command";
                  const encryptedCmd = security.encode8370(inner5a5a, MSGTYPE_ENCRYPTED_REQUEST);
                  socket.write(encryptedCmd);
                  continue;
                }

                if (pkt.msgType === MSGTYPE_ENCRYPTED_RESPONSE) {
                  const appFrame = unwrapApplicationFrame(pkt.payload);
                  finish(undefined, appFrame);
                  return;
                }
              }
            } catch (err) {
              const isAuth = stage === "handshake";
              finish(
                new MideaLanError(
                  `美的 V3 ${isAuth ? "握手认证" : "协议通信"}失败：${err instanceof Error ? err.message : String(err)}`,
                  isAuth,
                  { cause: err },
                ),
              );
            }
          });

          socket.once("error", (err) => {
            finish(new MideaLanError(`美的 V3 通信异常：${err.message}`, false, { cause: err }));
          });

          socket.once("timeout", () => {
            finish(new MideaLanError(`等待美的 V3 设备 ${endpoint.ip}:${port} 响应超时`));
          });

          socket.once("close", () => {
            finish(new MideaLanError("美的 V3 设备在完成交互前关闭了连接"));
          });

          socket.write(handshakePacket);
        }),
    );
  }
}
