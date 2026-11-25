// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 美的云端与局域网 V2/V3 加密签名实现（纯 TypeScript + node:crypto，零外部依赖）

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { MIDEA_CLOUD_PRESETS, type MideaCloudBrand, type MideaCloudPreset } from "./constants.ts";

/**
 * `midea_ac_lan/midea/core/security.py` 局域网 AES-128-ECB 固定密钥（16 字节）。
 */
export const LOCAL_AES_KEY_BIGINT = 141661095494369103254425781617665632877n;
export const LOCAL_AES_KEY = Buffer.from(
  LOCAL_AES_KEY_BIGINT.toString(16).padStart(32, "0"),
  "hex",
);

/**
 * `midea_ac_lan/midea/core/security.py` 局域网 MD5 固定盐值（36 字节）。
 */
export const LOCAL_MD5_SALT_BIGINT =
  233912452794221312800602098970898185176935770387238278451789080441632479840061417076563n;
export const LOCAL_MD5_SALT = Buffer.from(LOCAL_MD5_SALT_BIGINT.toString(16), "hex");

export const MSGTYPE_HANDSHAKE_REQUEST = 0x0;
export const MSGTYPE_HANDSHAKE_RESPONSE = 0x1;
export const MSGTYPE_ENCRYPTED_RESPONSE = 0x3;
export const MSGTYPE_ENCRYPTED_REQUEST = 0x6;
export const MSGTYPE_ERROR = 0xf;

const ZERO_IV_16 = Buffer.alloc(16, 0);

function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function sha256Buf(data: string | Uint8Array): Buffer {
  return createHash("sha256").update(data).digest();
}

function md5Hex(data: string | Uint8Array): string {
  return createHash("md5").update(data).digest("hex");
}

function md5Buf(data: Uint8Array): Buffer {
  return createHash("md5").update(data).digest();
}

function bigIntToFixedKey16(value: bigint): Buffer {
  return Buffer.from(value.toString(16).padStart(16, "0"), "ascii");
}

function toApplianceIdBigInt(applianceId: bigint | number | string): bigint {
  if (typeof applianceId === "bigint") {
    return applianceId;
  }
  if (typeof applianceId === "number") {
    return BigInt(Math.trunc(applianceId));
  }
  const trimmed = applianceId.trim();
  if (!trimmed) {
    return 0n;
  }
  return BigInt(trimmed);
}

function writeUInt48LE(value: bigint): Buffer {
  const buf = Buffer.alloc(6);
  let v = value & 0xffffffffffffn;
  for (let i = 0; i < 6; i++) {
    buf[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return buf;
}

function writeUInt48BE(value: bigint): Buffer {
  const buf = Buffer.alloc(6);
  let v = value & 0xffffffffffffn;
  for (let i = 5; i >= 0; i--) {
    buf[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return buf;
}

function writeUInt64LE(value: bigint): Buffer {
  const buf = Buffer.alloc(8);
  let v = value & 0xffffffffffffffffn;
  for (let i = 0; i < 8; i++) {
    buf[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return buf;
}

function readUInt48LE(buf: Uint8Array, offset: number): bigint {
  let value = 0n;
  for (let i = 5; i >= 0; i--) {
    value = (value << 8n) | BigInt(buf[offset + i] ?? 0);
  }
  return value;
}

function normalizeAesKey16(key: string | Uint8Array): Buffer {
  const raw = typeof key === "string" ? Buffer.from(key, "utf-8") : Buffer.from(key);
  if (raw.length === 16) {
    return raw;
  }
  if (raw.length === 32 && typeof key === "string" && /^[0-9a-f]{32}$/i.test(key)) {
    return Buffer.from(key, "hex");
  }
  if (raw.length > 16) {
    return raw.subarray(0, 16);
  }
  const padded = Buffer.alloc(16, 0);
  raw.copy(padded);
  return padded;
}

function aes128Encrypt(
  plaintext: Uint8Array | string,
  key16: Buffer,
  iv16?: Buffer | null,
): Buffer {
  const input = typeof plaintext === "string" ? Buffer.from(plaintext, "utf-8") : Buffer.from(plaintext);
  const cipher = iv16
    ? createCipheriv("aes-128-cbc", key16, iv16)
    : createCipheriv("aes-128-ecb", key16, null);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(input), cipher.final()]);
}

function aes128Decrypt(ciphertext: Uint8Array, key16: Buffer, iv16?: Buffer | null): Buffer {
  const decipher = iv16
    ? createDecipheriv("aes-128-cbc", key16, iv16)
    : createDecipheriv("aes-128-ecb", key16, null);
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function extractUrlPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    const qIdx = url.indexOf("?");
    return qIdx >= 0 ? url.slice(0, qIdx) : url;
  }
}

/**
 * 美的云端安全加解密与签名器（支持 Meiju / MSmartHome / NetHomePlus / MideaAir）。
 */
export class MideaCloudSecurity {
  readonly preset: MideaCloudPreset;
  private _aesKey: Buffer | null = null;
  private _aesIv: Buffer | null = null;

  constructor(brandOrPreset: MideaCloudBrand | MideaCloudPreset) {
    this.preset =
      typeof brandOrPreset === "string" ? MIDEA_CLOUD_PRESETS[brandOrPreset] : brandOrPreset;
  }

  /**
   * 派生设备唯一标识：`sha256("Hello, " + account + "!").hex().slice(0, 16)`。
   */
  static getDeviceId(account: string): string {
    return sha256Hex(`Hello, ${account}!`).slice(0, 16);
  }

  getDeviceId(account: string): string {
    return MideaCloudSecurity.getDeviceId(account);
  }

  /**
   * 计算 `udpId`（忠实匹配 `midea_ac_lan` `CloudSecurity.get_udp_id`）：
   * - `method = 0`: 8 字节小端（等价 `reversed(to_bytes(8, "big"))`）
   * - `method = 1`: 6 字节小端
   * - `method = 2`: 6 字节大端
   * 随后计算 SHA-256 并将前后各 16 字节逐字节异或折叠为 16 字节（32 位小写十六进制）。
   */
  static getUdpId(applianceId: bigint | number | string, method: 0 | 1 | 2 = 0): string {
    const id = toApplianceIdBigInt(applianceId);
    let bytesId: Buffer;
    switch (method) {
      case 0:
        bytesId = writeUInt64LE(id);
        break;
      case 1:
        bytesId = writeUInt48LE(id);
        break;
      case 2:
        bytesId = writeUInt48BE(id);
        break;
      default:
        return "";
    }
    const digest = sha256Buf(bytesId);
    const folded = Buffer.alloc(16);
    for (let i = 0; i < 16; i++) {
      folded[i] = digest[i]! ^ digest[i + 16]!;
    }
    return folded.toString("hex");
  }

  getUdpId(applianceId: bigint | number | string, method: 0 | 1 | 2 = 0): string {
    return MideaCloudSecurity.getUdpId(applianceId, method);
  }

  /**
   * 云端请求签名：
   * - Meiju / MSmartHome (`mas`): `HMAC-SHA256(hmacKey, iotKey + dataString + random)`
   * - NetHomePlus / MideaAir (`legacy`): `SHA256(urlPath + sortedFormQuery + appKey)`
   */
  sign(url: string, data: Record<string, unknown> | string, random = ""): string {
    if (this.preset.protocol === "mas") {
      const payload = typeof data === "string" ? data : JSON.stringify(data);
      const iotKey = this.preset.iotKey ?? "";
      const hmacKey = this.preset.hmacKey ?? this.preset.appKey;
      return createHmac("sha256", hmacKey)
        .update(`${iotKey}${payload}${random}`, "utf-8")
        .digest("hex");
    }

    const path = extractUrlPath(url);
    let queryStr: string;
    if (typeof data === "string") {
      queryStr = data;
    } else {
      const sortedEntries = Object.entries(data)
        .filter(([, v]) => v !== undefined && v !== null)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      queryStr = sortedEntries.map(([k, v]) => `${k}=${String(v)}`).join("&");
    }
    return sha256Hex(`${path}${queryStr}${this.preset.appKey}`);
  }

  /**
   * 标准登录密码哈希：`sha256(loginId + sha256(password) + loginKey)`。
   */
  encryptPassword(loginId: string, password: string): string {
    const hashedPwd = sha256Hex(password);
    return sha256Hex(`${loginId}${hashedPwd}${this.preset.loginKey}`);
  }

  /**
   * IAM 登录密码哈希：
   * - Meiju: `md5(md5(password))`
   * - MSmartHome: `sha256(loginId + md5(md5(password)) + loginKey)`
   * - 其他品牌: 回退到 `encryptPassword`
   */
  encryptIamPassword(loginId: string, password: string): string {
    const doubleMd5 = md5Hex(md5Hex(password));
    if (this.preset.brand === "meiju") {
      return doubleMd5;
    }
    if (this.preset.brand === "msmarthome") {
      return sha256Hex(`${loginId}${doubleMd5}${this.preset.loginKey}`);
    }
    return this.encryptPassword(loginId, password);
  }

  /**
   * 返回固定 AES-128 密钥（ECB 或 CBC）。
   */
  fixedKeyBytes(): Buffer {
    if (this.preset.fixedKey !== undefined) {
      return bigIntToFixedKey16(this.preset.fixedKey);
    }
    return Buffer.from(sha256Hex(this.preset.appKey).slice(0, 16), "ascii");
  }

  fixedIvBytes(): Buffer | null {
    return this.preset.fixedIv !== undefined ? bigIntToFixedKey16(this.preset.fixedIv) : null;
  }

  /**
   * 使用品牌固定密钥/IV（Meiju 为 AES-128-ECB，MSmartHome 为 AES-128-CBC）加密数据，返回小写十六进制。
   */
  aesEncryptWithFixedKey(plaintext: string | Uint8Array): string {
    const encrypted = aes128Encrypt(plaintext, this.fixedKeyBytes(), this.fixedIvBytes());
    return encrypted.toString("hex");
  }

  /**
   * 使用品牌固定密钥/IV 解密十六进制或字节密文，返回 UTF-8 字符串。
   */
  aesDecryptWithFixedKey(cipherHexOrBytes: string | Uint8Array): string {
    const buf =
      typeof cipherHexOrBytes === "string"
        ? Buffer.from(cipherHexOrBytes, "hex")
        : Buffer.from(cipherHexOrBytes);
    const plain = aes128Decrypt(buf, this.fixedKeyBytes(), this.fixedIvBytes());
    return plain.toString("utf-8");
  }

  /**
   * 设置会话 AES 密钥与可选 IV（支持传入经固定密钥加密的密文或直接传入明文密钥）。
   */
  setAesKeys(encryptedOrPlainKey: string | Uint8Array, encryptedOrPlainIv?: string | Uint8Array): void {
    const resolveField = (raw: string | Uint8Array): Buffer => {
      if (typeof raw === "string") {
        const trimmed = raw.trim();
        if (/^[0-9a-f]+$/i.test(trimmed) && trimmed.length >= 32 && trimmed.length % 32 === 0) {
          try {
            const decrypted = this.aesDecryptWithFixedKey(trimmed);
            if (decrypted.length > 0) {
              return normalizeAesKey16(decrypted);
            }
          } catch {
            // 若并非固定密钥密文，则按原始密钥字符串规范化
          }
        }
        return normalizeAesKey16(trimmed);
      }
      return normalizeAesKey16(raw);
    };

    this._aesKey = resolveField(encryptedOrPlainKey);
    if (encryptedOrPlainIv !== undefined && encryptedOrPlainIv !== "") {
      this._aesIv = resolveField(encryptedOrPlainIv);
    } else if (this.preset.fixedIv === undefined) {
      this._aesIv = null;
    }
  }

  clearAesKeys(): void {
    this._aesKey = null;
    this._aesIv = null;
  }

  get hasSessionAesKey(): boolean {
    return this._aesKey !== null;
  }

  /**
   * 使用当前会话密钥（未设置时自动回退到固定密钥）加密，返回小写十六进制。
   */
  aesEncrypt(plaintext: string | Uint8Array): string {
    const key = this._aesKey ?? this.fixedKeyBytes();
    const iv = this._aesKey ? this._aesIv : this.fixedIvBytes();
    return aes128Encrypt(plaintext, key, iv).toString("hex");
  }

  /**
   * 使用当前会话密钥（未设置时自动回退到固定密钥）解密，返回原始字节 Buffer。
   */
  aesDecryptBytes(cipherHexOrBytes: string | Uint8Array): Buffer {
    const buf =
      typeof cipherHexOrBytes === "string"
        ? Buffer.from(cipherHexOrBytes, "hex")
        : Buffer.from(cipherHexOrBytes);
    const key = this._aesKey ?? this.fixedKeyBytes();
    const iv = this._aesKey ? this._aesIv : this.fixedIvBytes();
    return aes128Decrypt(buf, key, iv);
  }

  aesDecrypt(cipherHexOrBytes: string | Uint8Array): string {
    return this.aesDecryptBytes(cipherHexOrBytes).toString("utf-8");
  }

  /**
   * 解密云端设备列表中的加密 `sn` 字段；若本身为明文 ASCII 则直接原样返回。
   */
  tryDecryptSn(rawSn: string): string {
    const trimmed = rawSn.trim();
    if (!trimmed) {
      return "";
    }
    const isHexBlocks = /^[0-9a-f]+$/i.test(trimmed) && trimmed.length >= 32 && trimmed.length % 32 === 0;
    if (!isHexBlocks) {
      return trimmed;
    }
    // 优先使用会话密钥，其次尝试固定密钥，再次尝试 appKey 派生密钥
    const attempts: Array<() => string> = [];
    if (this._aesKey) {
      attempts.push(() => this.aesDecrypt(trimmed));
    }
    attempts.push(() => this.aesDecryptWithFixedKey(trimmed));
    attempts.push(() => {
      const legacyKey = Buffer.from(sha256Hex(this.preset.appKey).slice(0, 16), "ascii");
      return aes128Decrypt(Buffer.from(trimmed, "hex"), legacyKey, null).toString("utf-8");
    });

    for (const attempt of attempts) {
      try {
        const plain = attempt().replace(/\0+$/g, "").trim();
        if (plain && /^[\x20-\x7e]+$/.test(plain)) {
          return plain;
        }
      } catch {
        // try next key
      }
    }
    return trimmed;
  }
}

export interface Decoded5a5aPacket {
  header: Buffer;
  msgType: number;
  applianceId: bigint;
  payload: Buffer;
  rawLength: number;
  signatureValid: boolean;
}

export interface Decoded8370Packet {
  msgType: number;
  payload: Buffer;
  padding: number;
  counter?: number;
}

export interface Decode8370Result {
  packets: Decoded8370Packet[];
  remainder: Buffer;
}

/**
 * 美的局域网 V2 (`0x5A5A`) 与 V3 (`0x8370`) 协议安全编解码器。
 */
export class MideaLocalSecurity {
  private _tcpKey: Buffer | null = null;
  private _requestCount = 0;
  private _responseCount = 0;

  get tcpKey(): Buffer | null {
    return this._tcpKey ? Buffer.from(this._tcpKey) : null;
  }

  get requestCount(): number {
    return this._requestCount;
  }

  get responseCount(): number {
    return this._responseCount;
  }

  resetSession(): void {
    this._tcpKey = null;
    this._requestCount = 0;
    this._responseCount = 0;
  }

  setTcpKey(tcpKey: Uint8Array): void {
    if (tcpKey.length !== 32) {
      throw new Error(`Midea V3 会话密钥长度必须为 32 字节，收到 ${tcpKey.length} 字节`);
    }
    this._tcpKey = Buffer.from(tcpKey);
  }

  /**
   * 局域网 V2 AES-128-ECB PKCS7 加密。
   */
  static aesEncryptLocal(data: Uint8Array): Buffer {
    const cipher = createCipheriv("aes-128-ecb", LOCAL_AES_KEY, null);
    cipher.setAutoPadding(true);
    return Buffer.concat([cipher.update(data), cipher.final()]);
  }

  /**
   * 局域网 V2 AES-128-ECB 解密（优先 PKCS7 去填充，兼容无填充广播响应）。
   */
  static aesDecryptLocal(data: Uint8Array): Buffer {
    if (data.length === 0 || data.length % 16 !== 0) {
      throw new Error(`Midea AES-128-ECB 密文长度必须为 16 字节的整数倍，收到 ${data.length}`);
    }
    try {
      const decipher = createDecipheriv("aes-128-ecb", LOCAL_AES_KEY, null);
      decipher.setAutoPadding(true);
      return Buffer.concat([decipher.update(data), decipher.final()]);
    } catch {
      const decipher = createDecipheriv("aes-128-ecb", LOCAL_AES_KEY, null);
      decipher.setAutoPadding(false);
      return Buffer.concat([decipher.update(data), decipher.final()]);
    }
  }

  /**
   * 计算 V2 `0x5A5A` 数据包末尾 16 字节加盐 MD5 校验。
   */
  static sign5a5a(packetWithoutSignature: Uint8Array): Buffer {
    return md5Buf(Buffer.concat([Buffer.from(packetWithoutSignature), LOCAL_MD5_SALT]));
  }

  /**
   * 封装 V2 `0x5A5A` 数据包：40 字节包头 + AES-128-ECB(PKCS7) 负载 + 16 字节加盐 MD5。
   */
  static encode5a5a(
    payload: Uint8Array,
    applianceId: bigint | number | string = 0n,
    options?: { msgType?: number; timestamp?: Date | null; versionFlags?: [number, number] },
  ): Buffer {
    const encrypted = MideaLocalSecurity.aesEncryptLocal(payload);
    const totalLength = 40 + encrypted.length + 16;
    const header = Buffer.alloc(40, 0);

    header[0] = 0x5a;
    header[1] = 0x5a;
    header[2] = options?.versionFlags?.[0] ?? 0x01;
    header[3] = options?.versionFlags?.[1] ?? 0x11;
    header.writeUInt16LE(totalLength, 4);
    header.writeUInt16LE(options?.msgType ?? 0x20, 6);

    if (options?.timestamp !== null) {
      const now = options?.timestamp ?? new Date();
      header[12] = Math.floor(now.getMilliseconds() / 10) & 0xff;
      header[13] = now.getSeconds() & 0xff;
      header[14] = now.getMinutes() & 0xff;
      header[15] = now.getHours() & 0xff;
      header[16] = now.getDate() & 0xff;
      header[17] = (now.getMonth() + 1) & 0xff;
      header[18] = (now.getFullYear() % 100) & 0xff;
      header[19] = Math.floor(now.getFullYear() / 100) & 0xff;
    }

    writeUInt48LE(toApplianceIdBigInt(applianceId)).copy(header, 20);

    const body = Buffer.concat([header, encrypted]);
    const signature = MideaLocalSecurity.sign5a5a(body);
    return Buffer.concat([body, signature]);
  }

  /**
   * 解包并校验 V2 `0x5A5A` 数据包。
   */
  static decode5a5a(
    raw: Uint8Array,
    options?: { verifySignature?: boolean },
  ): Decoded5a5aPacket {
    const buf = Buffer.from(raw);
    if (buf.length < 72) {
      throw new Error(`Midea 0x5A5A 数据包过短：${buf.length} 字节`);
    }
    if (buf[0] !== 0x5a || buf[1] !== 0x5a) {
      throw new Error(`无效的 Midea 0x5A5A 魔数：0x${buf.subarray(0, 2).toString("hex")}`);
    }

    const declaredLen = buf.readUInt16LE(4);
    const packetLen =
      declaredLen >= 72 && declaredLen <= buf.length ? declaredLen : buf.length;
    const packet = buf.subarray(0, packetLen);

    const unsignedPart = packet.subarray(0, packetLen - 16);
    const providedSig = packet.subarray(packetLen - 16, packetLen);
    const expectedSig = MideaLocalSecurity.sign5a5a(unsignedPart);
    const signatureValid =
      providedSig.length === expectedSig.length && timingSafeEqual(providedSig, expectedSig);

    if (options?.verifySignature !== false && !signatureValid) {
      throw new Error("Midea 0x5A5A 数据包 MD5 签名校验失败");
    }

    const header = Buffer.from(packet.subarray(0, 40));
    const msgType = header.readUInt16LE(6);
    const applianceId = readUInt48LE(header, 20);
    const encryptedPayload = packet.subarray(40, packetLen - 16);
    const payload = MideaLocalSecurity.aesDecryptLocal(encryptedPayload);

    return {
      header,
      msgType,
      applianceId,
      payload,
      rawLength: packetLen,
      signatureValid,
    };
  }

  /**
   * V3 `0x8370` 握手密钥派生（忠实对齐 `midea_ac_lan` `tcp_key`）：
   * 使用 32 字节设备 `key` 以 AES-256-CBC (IV=0) 解密前 32 字节响应，
   * 校验 `sha256(plain) === response[32..64]`，返回 `plain XOR key`。
   */
  static deriveTcpKey(response: Uint8Array, key: Uint8Array): Buffer {
    const respBuf = Buffer.from(response);
    const keyBuf = Buffer.from(key);

    if (keyBuf.length !== 32) {
      throw new Error(`Midea V3 设备 key 长度必须为 32 字节，收到 ${keyBuf.length} 字节`);
    }
    if (respBuf.toString("ascii") === "ERROR") {
      throw new Error("Midea V3 设备拒绝握手（ERROR），请确认 token 与 key 是否有效");
    }
    if (respBuf.length !== 64) {
      throw new Error(`Midea V3 握手响应长度必须为 64 字节，收到 ${respBuf.length} 字节`);
    }

    const encrypted = respBuf.subarray(0, 32);
    const expectedHash = respBuf.subarray(32, 64);

    const decipher = createDecipheriv("aes-256-cbc", keyBuf, ZERO_IV_16);
    decipher.setAutoPadding(false);
    const plain = Buffer.concat([decipher.update(encrypted), decipher.final()]);

    const actualHash = sha256Buf(plain);
    if (!timingSafeEqual(actualHash, expectedHash)) {
      throw new Error("Midea V3 握手校验失败：设备密钥 (key) 不匹配或响应已损坏");
    }

    const tcpKey = Buffer.alloc(32);
    for (let i = 0; i < 32; i++) {
      tcpKey[i] = plain[i]! ^ keyBuf[i]!;
    }
    return tcpKey;
  }

  /**
   * 构造符合 V3 握手协议的 64 字节服务端响应（用于测试或本地模拟）。
   */
  static createHandshakeResponse(plain32: Uint8Array, key32: Uint8Array): Buffer {
    if (plain32.length !== 32 || key32.length !== 32) {
      throw new Error("plain32 与 key32 必须均为 32 字节");
    }
    const cipher = createCipheriv("aes-256-cbc", Buffer.from(key32), ZERO_IV_16);
    cipher.setAutoPadding(false);
    const encrypted = Buffer.concat([cipher.update(plain32), cipher.final()]);
    const digest = sha256Buf(plain32);
    return Buffer.concat([encrypted, digest]);
  }

  deriveTcpKey(response: Uint8Array, key: Uint8Array): Buffer {
    const derived = MideaLocalSecurity.deriveTcpKey(response, key);
    this._tcpKey = derived;
    this._requestCount = 0;
    this._responseCount = 0;
    return Buffer.from(derived);
  }

  /**
   * 编码 V3 `0x8370` 数据帧。
   * - 头部 6 字节：`0x83 0x70` + `uint16BE(size)` + `0x20` + `((pad << 4) | msgType)`
   * - 加密消息 (`0x3` / `0x6`)：2 字节大端计数器 + 原始数据 + 随机填充至 16 字节倍数；
   *   签名 `SHA256(header + plainWithCounterAndPad)`；AES-256-CBC(IV=0) 加密后附加 32 字节签名。
   */
  encode8370(
    data: Uint8Array,
    msgType: number,
    options?: { tcpKey?: Uint8Array; counter?: number; paddingBytes?: Uint8Array },
  ): Buffer {
    const payloadBuf = Buffer.from(data);
    const isEncrypted =
      msgType === MSGTYPE_ENCRYPTED_REQUEST || msgType === MSGTYPE_ENCRYPTED_RESPONSE;

    if (!isEncrypted) {
      const header = Buffer.alloc(6);
      header[0] = 0x83;
      header[1] = 0x70;
      header.writeUInt16BE(payloadBuf.length, 2);
      header[4] = 0x20;
      header[5] = msgType & 0x0f;
      return Buffer.concat([header, payloadBuf]);
    }

    const key = options?.tcpKey ? Buffer.from(options.tcpKey) : this._tcpKey;
    if (!key || key.length !== 32) {
      throw new Error("发送 Midea V3 加密帧前必须先完成握手并获取 32 字节 tcpKey");
    }

    let counter: number;
    if (options?.counter !== undefined) {
      counter = options.counter & 0xffff;
    } else if (msgType === MSGTYPE_ENCRYPTED_REQUEST) {
      this._requestCount = (this._requestCount + 1) & 0xffff;
      counter = this._requestCount;
    } else {
      this._responseCount = (this._responseCount + 1) & 0xffff;
      counter = this._responseCount;
    }

    const counterBuf = Buffer.alloc(2);
    counterBuf.writeUInt16BE(counter, 0);

    const rawLen = 2 + payloadBuf.length;
    const padLen = rawLen % 16 === 0 ? 0 : 16 - (rawLen % 16);
    const padBuf =
      padLen === 0
        ? Buffer.alloc(0)
        : options?.paddingBytes && options.paddingBytes.length === padLen
          ? Buffer.from(options.paddingBytes)
          : randomBytes(padLen);

    const plainWithCounterAndPad = Buffer.concat([counterBuf, payloadBuf, padBuf]);
    const size = plainWithCounterAndPad.length + 32;

    const header = Buffer.alloc(6);
    header[0] = 0x83;
    header[1] = 0x70;
    header.writeUInt16BE(size, 2);
    header[4] = 0x20;
    header[5] = ((padLen & 0x0f) << 4) | (msgType & 0x0f);

    const signature = sha256Buf(Buffer.concat([header, plainWithCounterAndPad]));
    const cipher = createCipheriv("aes-256-cbc", key, ZERO_IV_16);
    cipher.setAutoPadding(false);
    const encrypted = Buffer.concat([cipher.update(plainWithCounterAndPad), cipher.final()]);

    return Buffer.concat([header, encrypted, signature]);
  }

  /**
   * 流式解码一个或多个 V3 `0x8370` 数据帧，返回已解析帧列表与未接收完整的剩余字节。
   */
  decode8370(
    raw: Uint8Array,
    options?: { tcpKey?: Uint8Array },
  ): Decode8370Result {
    const buf = Buffer.from(raw);
    const packets: Decoded8370Packet[] = [];
    let offset = 0;

    while (offset < buf.length) {
      if (buf.length - offset < 6) {
        break;
      }
      if (buf[offset] !== 0x83 || buf[offset + 1] !== 0x70) {
        throw new Error(
          `无效的 Midea 0x8370 魔数：0x${buf.subarray(offset, offset + 2).toString("hex")}`,
        );
      }

      const size = buf.readUInt16BE(offset + 2);
      const byte5 = buf[offset + 5]!;
      const padding = (byte5 >> 4) & 0x0f;
      const msgType = byte5 & 0x0f;
      const frameLen = 6 + size;

      if (offset + frameLen > buf.length) {
        break;
      }

      const header = buf.subarray(offset, offset + 6);
      const body = buf.subarray(offset + 6, offset + frameLen);
      offset += frameLen;

      if (msgType === MSGTYPE_ENCRYPTED_RESPONSE || msgType === MSGTYPE_ENCRYPTED_REQUEST) {
        const key = options?.tcpKey ? Buffer.from(options.tcpKey) : this._tcpKey;
        if (!key || key.length !== 32) {
          throw new Error("解密 Midea V3 帧缺少 32 字节 tcpKey");
        }
        if (body.length < 48 || (body.length - 32) % 16 !== 0) {
          throw new Error(`Midea V3 加密帧体长度异常：${body.length} 字节`);
        }

        const ciphertext = body.subarray(0, body.length - 32);
        const signature = body.subarray(body.length - 32);

        const decipher = createDecipheriv("aes-256-cbc", key, ZERO_IV_16);
        decipher.setAutoPadding(false);
        const plainWithCounterAndPad = Buffer.concat([
          decipher.update(ciphertext),
          decipher.final(),
        ]);

        const expectedSig = sha256Buf(Buffer.concat([header, plainWithCounterAndPad]));
        if (!timingSafeEqual(signature, expectedSig)) {
          throw new Error("Midea V3 加密帧 SHA-256 签名校验失败");
        }

        const counter = plainWithCounterAndPad.readUInt16BE(0);
        const payloadEnd = plainWithCounterAndPad.length - padding;
        if (payloadEnd < 2) {
          throw new Error(`Midea V3 加密帧填充长度无效：padding=${padding}`);
        }
        const payload = Buffer.from(plainWithCounterAndPad.subarray(2, payloadEnd));
        packets.push({ msgType, payload, padding, counter });
      } else {
        packets.push({
          msgType,
          payload: Buffer.from(body),
          padding,
        });
      }
    }

    return {
      packets,
      remainder: Buffer.from(buf.subarray(offset)),
    };
  }
}
