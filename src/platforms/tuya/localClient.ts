// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 涂鸦 LocalTuya / TinyTuya 局域网 TCP:6668 客户端与 UDP 6666/6667 发现

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createSocket, type Socket as UdpSocket } from "node:dgram";
import { createConnection, type Socket as TcpSocket } from "node:net";
import type { TuyaLocalDeviceEntry } from "../configStore.ts";
import type { DiscoveredLocalDevice } from "../types.ts";
import {
  TUYA_LOCAL_CMD,
  TUYA_LOCAL_DEFAULT_PORT,
  TUYA_UDP_PORT_V31,
  TUYA_UDP_PORT_V33,
} from "./constants.ts";
import {
  decryptUdpBroadcast,
  deriveTuyaSessionKey,
  packTuyaLocalMessage,
  tryExtractTuyaFrame,
  unpackTuyaLocalMessage,
  type TuyaLocalVersion,
  type UnpackedTuyaLocalMessage,
} from "./crypto.ts";

export class TuyaLocalError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TuyaLocalError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface TuyaLocalClientConfig {
  id: string;
  ip: string;
  port?: number;
  localKey: string;
  version: TuyaLocalVersion;
  timeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractDpsFromPayload(json: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!json) return null;
  if (isRecord(json.dps)) {
    return { ...json.dps };
  }
  if (isRecord(json.data) && isRecord(json.data.dps)) {
    return { ...json.data.dps };
  }
  return null;
}

/**
 * 内部单次 TCP 连接会话管理器：支持帧重组、超时期限、v3.4/v3.5 三次握手会话密钥协商与安全销毁。
 */
class TuyaTcpSession {
  private readonly _cfg: Required<Pick<TuyaLocalClientConfig, "id" | "ip" | "port" | "localKey" | "version" | "timeoutMs">>;
  private _socket: TcpSocket | null = null;
  private _rxBuffer: Buffer = Buffer.alloc(0);
  private _frameQueue: Buffer[] = [];
  private _waiter:
    | {
        resolve: (frame: Buffer) => void;
        reject: (err: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    | null = null;
  private _closedError: Error | null = null;
  private _seqno = 1;
  private _sessionKey: Buffer | null = null;

  constructor(cfg: TuyaLocalClientConfig) {
    this._cfg = {
      id: cfg.id,
      ip: cfg.ip,
      port: cfg.port ?? TUYA_LOCAL_DEFAULT_PORT,
      localKey: cfg.localKey,
      version: cfg.version,
      timeoutMs: cfg.timeoutMs ?? 5000,
    };
  }

  private _nextSeq(): number {
    const s = this._seqno;
    this._seqno += 1;
    return s;
  }

  private get _activeKey(): Buffer {
    return this._sessionKey ?? Buffer.from(this._cfg.localKey, "utf8");
  }

  async connect(): Promise<void> {
    if (this._cfg.version !== "3.1" && Buffer.from(this._cfg.localKey, "utf8").length !== 16) {
      throw new TuyaLocalError("涂鸦局域网设备 LocalKey 长度必须为 16 字节");
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const socket = createConnection({
        host: this._cfg.ip,
        port: this._cfg.port,
      });
      this._socket = socket;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(new TuyaLocalError(`连接局域网设备 ${this._cfg.ip}:${this._cfg.port} 超时`));
      }, this._cfg.timeoutMs);

      const onConnect = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.setNoDelay(true);
        resolve();
      };

      const onError = (err: Error): void => {
        const wrapped = new TuyaLocalError(
          `局域网设备 ${this._cfg.ip}:${this._cfg.port} 通信失败: ${err.message}`,
          { cause: err },
        );
        this._closedError = wrapped;
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(wrapped);
        } else if (this._waiter) {
          const w = this._waiter;
          this._waiter = null;
          clearTimeout(w.timer);
          w.reject(wrapped);
        }
      };

      const onClose = (): void => {
        const closedErr = this._closedError ?? new TuyaLocalError("局域网设备连接已关闭");
        this._closedError = closedErr;
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(closedErr);
        } else if (this._waiter) {
          const w = this._waiter;
          this._waiter = null;
          clearTimeout(w.timer);
          w.reject(closedErr);
        }
      };

      const onData = (chunk: Buffer): void => {
        this._rxBuffer =
          this._rxBuffer.length > 0 ? Buffer.concat([this._rxBuffer, chunk]) : Buffer.from(chunk);
        try {
          while (this._rxBuffer.length > 0) {
            const extracted = tryExtractTuyaFrame(this._rxBuffer);
            if (!extracted) break;
            this._rxBuffer = Buffer.from(extracted.remainder);
            if (this._waiter) {
              const w = this._waiter;
              this._waiter = null;
              clearTimeout(w.timer);
              w.resolve(extracted.frame);
            } else {
              this._frameQueue.push(extracted.frame);
            }
          }
        } catch (err) {
          const parseErr =
            err instanceof TuyaLocalError
              ? err
              : new TuyaLocalError(
                  `局域网报文解析失败: ${err instanceof Error ? err.message : String(err)}`,
                  { cause: err },
                );
          this._rxBuffer = Buffer.alloc(0);
          if (this._waiter) {
            const w = this._waiter;
            this._waiter = null;
            clearTimeout(w.timer);
            w.reject(parseErr);
          }
        }
      };

      socket.once("connect", onConnect);
      socket.on("data", onData);
      socket.on("error", onError);
      socket.on("close", onClose);
    });
  }

  private async _sendRaw(buf: Buffer): Promise<void> {
    const socket = this._socket;
    if (!socket || socket.destroyed) {
      throw new TuyaLocalError("局域网设备未建立连接");
    }
    await new Promise<void>((resolve, reject) => {
      socket.write(buf, (err) => {
        if (err) {
          reject(new TuyaLocalError(`发送局域网报文失败: ${err.message}`, { cause: err }));
        } else {
          resolve();
        }
      });
    });
  }

  private async _recvFrame(timeoutMs = this._cfg.timeoutMs): Promise<Buffer> {
    if (this._frameQueue.length > 0) {
      return this._frameQueue.shift()!;
    }
    if (this._closedError) {
      throw this._closedError;
    }
    return await new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this._waiter) {
          this._waiter = null;
          reject(new TuyaLocalError(`等待局域网设备 ${this._cfg.ip} 响应超时`));
        }
      }, timeoutMs);
      this._waiter = { resolve, reject, timer };
    });
  }

  private async _recvUnpacked(
    key: Buffer,
    hasRetcode?: boolean,
  ): Promise<UnpackedTuyaLocalMessage> {
    const frame = await this._recvFrame();
    return unpackTuyaLocalMessage(frame, {
      key,
      version: this._cfg.version,
      hasRetcode,
    });
  }

  /**
   * LocalTuya v3.4 / v3.5 三次握手会话密钥协商：
   * `SESS_KEY_NEG_START (0x03)` -> `SESS_KEY_NEG_RESP (0x04)` -> `SESS_KEY_NEG_FINISH (0x05)`
   */
  async negotiateSessionKey(): Promise<Buffer> {
    if (this._cfg.version !== "3.4" && this._cfg.version !== "3.5") {
      return this._activeKey;
    }
    const localKeyBuf = Buffer.from(this._cfg.localKey, "utf8");
    const clientNonce = randomBytes(16);

    // Step 1: SESS_KEY_NEG_START (0x03)
    const startFrame = packTuyaLocalMessage({
      cmd: TUYA_LOCAL_CMD.SESS_KEY_NEG_START,
      seqno: this._nextSeq(),
      payload: clientNonce,
      key: localKeyBuf,
      version: this._cfg.version,
      includeVersionHeader: false,
    });
    await this._sendRaw(startFrame);

    // Step 2: SESS_KEY_NEG_RESP (0x04)
    const resp = await this._recvUnpacked(localKeyBuf, true);
    if (resp.cmd !== TUYA_LOCAL_CMD.SESS_KEY_NEG_RESP) {
      throw new TuyaLocalError(`局域网握手返回异常命令码: 0x${resp.cmd.toString(16)}`);
    }
    if (resp.payload.length < 48) {
      throw new TuyaLocalError(`局域网握手响应载荷长度不足 (${resp.payload.length} 字节)`);
    }

    const remoteNonce = resp.payload.subarray(0, 16);
    const remoteHmac = resp.payload.subarray(16, 48);
    const expectedHmac = createHmac("sha256", localKeyBuf).update(clientNonce).digest();
    if (!timingSafeEqual(remoteHmac, expectedHmac)) {
      throw new TuyaLocalError("局域网设备握手 HMAC 校验失败，请确认 LocalKey 是否正确");
    }

    // Step 3: SESS_KEY_NEG_FINISH (0x05)
    const clientFinishHmac = createHmac("sha256", localKeyBuf).update(remoteNonce).digest();
    const finishFrame = packTuyaLocalMessage({
      cmd: TUYA_LOCAL_CMD.SESS_KEY_NEG_FINISH,
      seqno: this._nextSeq(),
      payload: clientFinishHmac,
      key: localKeyBuf,
      version: this._cfg.version,
      includeVersionHeader: false,
    });
    await this._sendRaw(finishFrame);

    // Derive per-session AES-128 key
    const sessionKey = deriveTuyaSessionKey(
      localKeyBuf,
      clientNonce,
      remoteNonce,
      this._cfg.version,
    );
    this._sessionKey = sessionKey;
    return sessionKey;
  }

  async queryDps(): Promise<Record<string, unknown>> {
    if (this._cfg.version === "3.4" || this._cfg.version === "3.5") {
      await this.negotiateSessionKey();
      const frame = packTuyaLocalMessage({
        cmd: TUYA_LOCAL_CMD.DP_QUERY_NEW,
        seqno: this._nextSeq(),
        payload: "{}",
        key: this._activeKey,
        version: this._cfg.version,
        includeVersionHeader: false,
      });
      await this._sendRaw(frame);
      const resp = await this._recvUnpacked(this._activeKey, true);
      if (resp.retcode !== 0) {
        throw new TuyaLocalError(`局域网查询状态失败 (retcode=${resp.retcode})`);
      }
      return extractDpsFromPayload(resp.json) ?? {};
    }

    // v3.1 / v3.3
    const payload = JSON.stringify({
      gwId: this._cfg.id,
      devId: this._cfg.id,
      uid: this._cfg.id,
      t: String(Math.floor(Date.now() / 1000)),
    });
    const frame = packTuyaLocalMessage({
      cmd: TUYA_LOCAL_CMD.DP_QUERY,
      seqno: this._nextSeq(),
      payload,
      key: this._activeKey,
      version: this._cfg.version,
      includeVersionHeader: false,
      encrypt: this._cfg.version !== "3.1",
    });
    await this._sendRaw(frame);
    const resp = await this._recvUnpacked(this._activeKey, true);
    if (resp.retcode !== 0) {
      throw new TuyaLocalError(`局域网查询状态失败 (retcode=${resp.retcode})`);
    }
    return extractDpsFromPayload(resp.json) ?? {};
  }

  async setDps(dps: Record<string, unknown>): Promise<Record<string, unknown>> {
    const nowSec = Math.floor(Date.now() / 1000);
    if (this._cfg.version === "3.4" || this._cfg.version === "3.5") {
      await this.negotiateSessionKey();
      const payload = JSON.stringify({
        protocol: 5,
        t: nowSec,
        data: { dps },
      });
      const frame = packTuyaLocalMessage({
        cmd: TUYA_LOCAL_CMD.CONTROL_NEW,
        seqno: this._nextSeq(),
        payload,
        key: this._activeKey,
        version: this._cfg.version,
        includeVersionHeader: true,
      });
      await this._sendRaw(frame);
      const resp = await this._recvUnpacked(this._activeKey, true);
      if (resp.retcode !== 0) {
        throw new TuyaLocalError(`局域网下发控制指令失败 (retcode=${resp.retcode})`);
      }
      return extractDpsFromPayload(resp.json) ?? { ...dps };
    }

    // v3.1 / v3.3
    const payload = JSON.stringify({
      devId: this._cfg.id,
      uid: this._cfg.id,
      t: String(nowSec),
      dps,
    });
    const frame = packTuyaLocalMessage({
      cmd: TUYA_LOCAL_CMD.CONTROL,
      seqno: this._nextSeq(),
      payload,
      key: this._activeKey,
      version: this._cfg.version,
      includeVersionHeader: this._cfg.version === "3.3",
      encrypt: this._cfg.version !== "3.1",
    });
    await this._sendRaw(frame);
    const resp = await this._recvUnpacked(this._activeKey, true);
    if (resp.retcode !== 0) {
      throw new TuyaLocalError(`局域网下发控制指令失败 (retcode=${resp.retcode})`);
    }
    return extractDpsFromPayload(resp.json) ?? { ...dps };
  }

  async heartbeat(): Promise<boolean> {
    if (this._cfg.version === "3.4" || this._cfg.version === "3.5") {
      await this.negotiateSessionKey();
    }
    const frame = packTuyaLocalMessage({
      cmd: TUYA_LOCAL_CMD.HEART_BEAT,
      seqno: this._nextSeq(),
      payload: Buffer.alloc(0),
      key: this._activeKey,
      version: this._cfg.version,
      includeVersionHeader: false,
    });
    await this._sendRaw(frame);
    const resp = await this._recvUnpacked(this._activeKey, true);
    return resp.retcode === 0;
  }

  close(): void {
    if (this._waiter) {
      clearTimeout(this._waiter.timer);
      this._waiter = null;
    }
    if (this._socket) {
      this._socket.removeAllListeners();
      this._socket.destroy();
      this._socket = null;
    }
  }
}

export class TuyaLocalClient {
  private readonly _config: TuyaLocalClientConfig;

  constructor(config: TuyaLocalClientConfig) {
    this._config = { ...config };
  }

  static fromEntry(entry: TuyaLocalDeviceEntry, timeoutMs = 5000): TuyaLocalClient {
    return new TuyaLocalClient({
      id: entry.id,
      ip: entry.ip,
      port: entry.port ?? TUYA_LOCAL_DEFAULT_PORT,
      localKey: entry.localKey,
      version: entry.version,
      timeoutMs,
    });
  }

  async queryDps(timeoutMs?: number): Promise<Record<string, unknown>> {
    const session = new TuyaTcpSession({
      ...this._config,
      timeoutMs: timeoutMs ?? this._config.timeoutMs ?? 5000,
    });
    try {
      await session.connect();
      return await session.queryDps();
    } finally {
      session.close();
    }
  }

  async setDps(
    dps: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<Record<string, unknown>> {
    const session = new TuyaTcpSession({
      ...this._config,
      timeoutMs: timeoutMs ?? this._config.timeoutMs ?? 5000,
    });
    try {
      await session.connect();
      return await session.setDps(dps);
    } finally {
      session.close();
    }
  }

  async heartbeat(timeoutMs?: number): Promise<boolean> {
    const session = new TuyaTcpSession({
      ...this._config,
      timeoutMs: timeoutMs ?? this._config.timeoutMs ?? 5000,
    });
    try {
      await session.connect();
      return await session.heartbeat();
    } finally {
      session.close();
    }
  }
}

/**
 * 监听涂鸦局域网 UDP 6666 / 6667 设备广播（兼容 v3.1 明文、v3.3/3.4 ECB 与 v3.5 GCM）。
 * 若端口被占用（EADDRINUSE）或无权限则优雅降级返回空列表，绝不抛异常。
 */
export async function discoverTuyaLanDevices(
  timeoutMs = 3000,
  ports: readonly number[] = [TUYA_UDP_PORT_V31, TUYA_UDP_PORT_V33],
): Promise<DiscoveredLocalDevice[]> {
  const discovered = new Map<string, DiscoveredLocalDevice>();
  const sockets: UdpSocket[] = [];

  const bindPort = async (port: number): Promise<UdpSocket | null> => {
    return await new Promise<UdpSocket | null>((resolve) => {
      let settled = false;
      const sock = createSocket({ type: "udp4", reuseAddr: true });

      const finish = (result: UdpSocket | null): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      sock.on("error", () => {
        try {
          sock.close();
        } catch {
          // ignore close errors
        }
        finish(null);
      });

      sock.on("message", (msg, rinfo) => {
        const parsed = decryptUdpBroadcast(msg);
        if (!parsed) return;
        const id = String(parsed.gwId ?? parsed.id ?? "").trim();
        if (!id) return;
        const ip = typeof parsed.ip === "string" && parsed.ip.trim() ? parsed.ip.trim() : rinfo.address;
        const version = typeof parsed.version === "string" && parsed.version.trim() ? parsed.version.trim() : "3.3";
        const productKey = typeof parsed.productKey === "string" ? parsed.productKey.trim() : "";
        const rawName = typeof parsed.name === "string" && parsed.name.trim() ? parsed.name.trim() : "";
        discovered.set(id, {
          platform: "tuya",
          id,
          name: rawName || `涂鸦设备 ${id.slice(-6)}`,
          ip,
          port: TUYA_LOCAL_DEFAULT_PORT,
          protocolVersion: version,
          ...(productKey ? { model: `tuya.${productKey}` } : {}),
          requiresCredentials: true,
          meta: {
            productKey,
            active: parsed.active,
            ability: parsed.ablilty ?? parsed.ability,
            encrypt: parsed.encrypt,
            udpPort: port,
          },
        });
      });

      try {
        sock.bind(port, () => {
          try {
            sock.setBroadcast(true);
          } catch {
            // ignore broadcast flag failure
          }
          finish(sock);
        });
      } catch {
        try {
          sock.close();
        } catch {
          // ignore
        }
        finish(null);
      }
    });
  };

  const bound = await Promise.all(ports.map((p) => bindPort(p)));
  for (const s of bound) {
    if (s) sockets.push(s);
  }

  if (sockets.length === 0) {
    return [];
  }

  await new Promise<void>((resolve) => {
    setTimeout(resolve, Math.max(50, timeoutMs));
  });

  for (const sock of sockets) {
    try {
      sock.removeAllListeners();
      sock.close();
    } catch {
      // ignore close errors
    }
  }

  return [...discovered.values()];
}
