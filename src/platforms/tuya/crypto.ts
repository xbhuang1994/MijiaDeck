// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 涂鸦智能密码学与局域网封包实现 (纯 Node/Bun node:crypto，零外部依赖)

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from "node:crypto";
import {
  TUYA_LOCAL_CMD,
  TUYA_PREFIX_55AA,
  TUYA_PREFIX_6699,
  TUYA_SHARING_NONCE_ALPHABET,
  TUYA_SHARING_SIGN_HEADERS,
  TUYA_SUFFIX_9966,
  TUYA_SUFFIX_AA55,
  UDP_BROADCAST_KEY,
} from "./constants.ts";

// ============================================================================
// 1. Home Assistant Device Sharing SDK (tuya_sharing/customerapi.py)
// ============================================================================

/** `md5(rid + refreshToken)` lowercase hex */
export function tuyaSharingHashKey(rid: string, refreshToken: string): string {
  return createHash("md5").update(`${rid}${refreshToken}`, "utf8").digest("hex");
}

/**
 * 对应 `tuya_sharing/customerapi.py` 中的 `_secret_generating(rid, sid, hash_key)`：
 * `HMAC-SHA256(key=rid, msg=message).hex().slice(0, 16)`
 */
export function tuyaSharingSecret(rid: string, sid: string, hashKey: string): string {
  const message = sid ? `${hashKey}${sid}` : hashKey;
  return createHmac("sha256", Buffer.from(rid, "utf8"))
    .update(message, "utf8")
    .digest("hex")
    .slice(0, 16);
}

/** 生成 12 字节 ASCII 随机 Nonce（与 tuya-device-sharing-sdk 字符表一致） */
export function randomTuyaSharingNonce(length = 12): string {
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += TUYA_SHARING_NONCE_ALPHABET[randomInt(0, TUYA_SHARING_NONCE_ALPHABET.length)]!;
  }
  return out;
}

/**
 * HA Device Sharing AES-128-GCM 加密：
 * 使用 12 字节 ASCII nonce 与 16 字节 UTF-8 secret，
 * 返回 `base64(nonce) + base64(ciphertext || authTag)`。
 * 由于 12 字节恰好为 3 的整数倍，拼接后等价于单段 `base64(nonce || ciphertext || authTag)`。
 */
export function tuyaSharingAesGcmEncrypt(
  rawJson: string,
  secret: string,
  nonceOverride?: string,
): string {
  const keyBuf = Buffer.from(secret, "utf8");
  if (keyBuf.length !== 16) {
    throw new Error(`Tuya Sharing AES-128-GCM key must be 16 bytes, got ${keyBuf.length}`);
  }
  const nonceStr = nonceOverride ?? randomTuyaSharingNonce(12);
  const nonceBuf = Buffer.from(nonceStr, "utf8");
  if (nonceBuf.length !== 12) {
    throw new Error(`Tuya Sharing AES-GCM nonce must be 12 bytes, got ${nonceBuf.length}`);
  }

  const cipher = createCipheriv("aes-128-gcm", keyBuf, nonceBuf);
  const ciphertext = Buffer.concat([cipher.update(rawJson, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return nonceBuf.toString("base64") + Buffer.concat([ciphertext, authTag]).toString("base64");
}

/**
 * HA Device Sharing AES-128-GCM 解密：
 * `raw = base64Decode(cipherBase64)`，拆分为 `nonce[0..12]`、`ciphertext[12..-16]`、`tag[-16..]`。
 */
export function tuyaSharingAesGcmDecrypt(cipherBase64: string, secret: string): string {
  const keyBuf = Buffer.from(secret, "utf8");
  if (keyBuf.length !== 16) {
    throw new Error(`Tuya Sharing AES-128-GCM key must be 16 bytes, got ${keyBuf.length}`);
  }
  const raw = Buffer.from(cipherBase64, "base64");
  if (raw.length < 28) {
    throw new Error(`Tuya Sharing AES-GCM payload too short (${raw.length} bytes)`);
  }
  const nonce = raw.subarray(0, 12);
  const ciphertext = raw.subarray(12, raw.length - 16);
  const authTag = raw.subarray(raw.length - 16);

  const decipher = createDecipheriv("aes-128-gcm", keyBuf, nonce);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

/**
 * HA Device Sharing RESTful 请求签名：
 * 按顺序拼接非空的 `["X-appKey", "X-requestId", "X-sid", "X-time", "X-token"]` 为 `k=v||...`（无尾随 `||`），
 * 追加 `queryEncdata + bodyEncdata`，再做 `HMAC-SHA256(hashKey, signStr).hex()`。
 */
export function tuyaSharingRestfulSign(
  hashKey: string,
  queryEncdata: string,
  bodyEncdata: string,
  headers: Readonly<Record<string, string | undefined>>,
): string {
  const parts: string[] = [];
  for (const key of TUYA_SHARING_SIGN_HEADERS) {
    const val = headers[key];
    if (val !== undefined && val !== "") {
      parts.push(`${key}=${val}`);
    }
  }
  const signStr = `${parts.join("||")}${queryEncdata}${bodyEncdata}`;
  return createHmac("sha256", Buffer.from(hashKey, "utf8"))
    .update(signStr, "utf8")
    .digest("hex");
}

// ============================================================================
// 2. Tuya Cloud OpenAPI v2.0 签名
// ============================================================================

export function sha256Hex(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

/** 规范化 OpenAPI URL：保留路径，若含查询参数则按参数名 ASCII 升序排列。 */
export function canonicalizeOpenApiUrl(urlOrPath: string): string {
  let pathWithQuery = urlOrPath;
  if (/^https?:\/\//i.test(urlOrPath)) {
    const parsed = new URL(urlOrPath);
    pathWithQuery = `${parsed.pathname}${parsed.search}`;
  }
  const qIndex = pathWithQuery.indexOf("?");
  if (qIndex === -1) {
    return pathWithQuery;
  }
  const pathname = pathWithQuery.slice(0, qIndex);
  const rawQuery = pathWithQuery.slice(qIndex + 1);
  if (!rawQuery) {
    return pathname;
  }
  const pairs = rawQuery
    .split("&")
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const eq = entry.indexOf("=");
      if (eq === -1) return [entry, ""] as const;
      return [entry.slice(0, eq), entry.slice(eq + 1)] as const;
    })
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  return `${pathname}?${pairs.map(([k, v]) => `${k}=${v}`).join("&")}`;
}

export interface TuyaOpenApiSignInput {
  clientId: string;
  secret: string;
  method: string;
  url: string;
  body?: string;
  accessToken?: string;
  t: string;
  nonce?: string;
  signatureHeaders?: string;
}

export interface TuyaOpenApiSignResult {
  sign: string;
  stringToSign: string;
  contentHash: string;
  canonicalUrl: string;
}

/**
 * Tuya Cloud OpenAPI v2.0 HMAC-SHA256 签名：
 * `stringToSign = [METHOD, sha256Hex(body), "", canonicalUrlWithSortedQuery].join("\n")`
 * `signStr = clientId + (accessToken || "") + t + nonce + stringToSign`
 * `sign = HMAC-SHA256(secret, signStr).hex().toUpperCase()`
 */
export function tuyaOpenApiSign(input: TuyaOpenApiSignInput): TuyaOpenApiSignResult {
  const method = input.method.toUpperCase();
  const contentHash = sha256Hex(input.body ?? "");
  const canonicalUrl = canonicalizeOpenApiUrl(input.url);
  const stringToSign = [method, contentHash, input.signatureHeaders ?? "", canonicalUrl].join("\n");
  const signStr = `${input.clientId}${input.accessToken ?? ""}${input.t}${input.nonce ?? ""}${stringToSign}`;
  const sign = createHmac("sha256", Buffer.from(input.secret, "utf8"))
    .update(signStr, "utf8")
    .digest("hex")
    .toUpperCase();

  return {
    sign,
    stringToSign,
    contentHash,
    canonicalUrl,
  };
}

// ============================================================================
// 3. LocalTuya / TinyTuya 局域网加密与帧协议 (v3.1 / v3.3 / v3.4 / v3.5)
// ============================================================================

export type TuyaLocalVersion = "3.1" | "3.3" | "3.4" | "3.5";

const CRC32_TABLE = new Uint32Array(256);
(() => {
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let j = 0; j < 8; j += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    CRC32_TABLE[i] = c >>> 0;
  }
})();

/** 标准 IEEE 802.3 CRC-32（返回无符号 32 位整数） */
export function crc32(buf: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc = CRC32_TABLE[(crc ^ buf[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function toKeyBuffer(key: string | Buffer): Buffer {
  const buf = typeof key === "string" ? Buffer.from(key, "utf8") : Buffer.from(key);
  if (buf.length !== 16) {
    throw new Error(`Tuya AES-128 key must be 16 bytes, got ${buf.length}`);
  }
  return buf;
}

export function aes128EcbEncrypt(
  plaintext: Buffer,
  key: string | Buffer,
  autoPadding = true,
): Buffer {
  const cipher = createCipheriv("aes-128-ecb", toKeyBuffer(key), null);
  cipher.setAutoPadding(autoPadding);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

export function aes128EcbDecrypt(
  ciphertext: Buffer,
  key: string | Buffer,
  autoPadding = true,
): Buffer {
  const decipher = createDecipheriv("aes-128-ecb", toKeyBuffer(key), null);
  decipher.setAutoPadding(autoPadding);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * LocalTuya / TinyTuya v3.4 & v3.5 会话密钥派生：
 * 将 16 字节 clientNonce 与 remoteNonce 按位异或后，
 * - v3.4: 使用 AES-128-ECB(localKey) 加密取前 16 字节
 * - v3.5: 使用 AES-128-GCM(localKey, iv=clientNonce[0..12]) 加密取前 16 字节
 */
export function deriveTuyaSessionKey(
  localKey: string | Buffer,
  clientNonce: Buffer,
  remoteNonce: Buffer,
  version: "3.4" | "3.5",
): Buffer {
  if (clientNonce.length !== 16 || remoteNonce.length !== 16) {
    throw new Error(
      `Tuya session key nonces must be 16 bytes each (got ${clientNonce.length}, ${remoteNonce.length})`,
    );
  }
  const keyBuf = toKeyBuffer(localKey);
  const xorNonce = Buffer.alloc(16);
  for (let i = 0; i < 16; i += 1) {
    xorNonce[i] = clientNonce[i]! ^ remoteNonce[i]!;
  }

  if (version === "3.4") {
    return aes128EcbEncrypt(xorNonce, keyBuf, false).subarray(0, 16);
  }
  const cipher = createCipheriv("aes-128-gcm", keyBuf, clientNonce.subarray(0, 12));
  return Buffer.concat([cipher.update(xorNonce), cipher.final()]).subarray(0, 16);
}

function makeVersionHeader(version: "3.3" | "3.4" | "3.5"): Buffer {
  const buf = Buffer.alloc(15, 0);
  buf.write(version, 0, "ascii");
  return buf;
}

function hasVersionHeaderPrefix(buf: Buffer, version: "3.3" | "3.4" | "3.5"): boolean {
  return buf.length >= 15 && buf.subarray(0, 3).toString("ascii") === version;
}

export interface PackTuyaLocalMessageOptions {
  cmd: number;
  seqno: number;
  payload: Buffer | string;
  key: string | Buffer;
  version: TuyaLocalVersion;
  /** 仅用于设备端回包（或测试服务端）时注入 4 字节 retcode */
  retcode?: number;
  /** 显式控制是否附加 15 字节协议版本头（如 `3.3\0...` / `3.4\0...` / `3.5\0...`） */
  includeVersionHeader?: boolean;
  /** 仅 v3.5 可选自定义 12 字节 IV（用于确定性测试） */
  iv?: Buffer;
  /** 是否加密载荷（默认 true；v3.1 明文查询可设 false） */
  encrypt?: boolean;
}

/**
 * 封装 LocalTuya / TinyTuya 局域网帧：
 * - v3.1 / v3.3: `0x000055AA` + AES-128-ECB + CRC32 + `0x0000AA55`
 * - v3.4: `0x000055AA` + AES-128-ECB + 32B HMAC-SHA256 + `0x0000AA55`
 * - v3.5: `0x00006699` + 12B IV + AES-128-GCM(AAD=header[4..18]) + 16B Tag + `0x00009966`
 */
export function packTuyaLocalMessage(options: PackTuyaLocalMessageOptions): Buffer {
  const { cmd, seqno, version, retcode } = options;
  const keyBuf = toKeyBuffer(options.key);
  const rawPayload =
    typeof options.payload === "string"
      ? Buffer.from(options.payload, "utf8")
      : Buffer.from(options.payload);
  const shouldEncrypt = options.encrypt !== false;

  if (version === "3.5") {
    const addVerHeader =
      options.includeVersionHeader ??
      (cmd === TUYA_LOCAL_CMD.CONTROL_NEW && retcode === undefined);
    const bodyParts: Buffer[] = [];
    if (retcode !== undefined) {
      const rc = Buffer.alloc(4);
      rc.writeUInt32BE(retcode >>> 0, 0);
      bodyParts.push(rc);
    }
    if (addVerHeader) {
      bodyParts.push(makeVersionHeader("3.5"));
    }
    bodyParts.push(rawPayload);
    const plaintext = Buffer.concat(bodyParts);

    const iv = options.iv ? Buffer.from(options.iv) : randomBytes(12);
    if (iv.length !== 12) {
      throw new Error(`Tuya v3.5 AES-GCM IV must be 12 bytes, got ${iv.length}`);
    }

    const payloadLength = 12 + plaintext.length + 16;
    const header = Buffer.alloc(18);
    header.writeUInt32BE(TUYA_PREFIX_6699, 0);
    header.writeUInt16BE(0x0000, 4);
    header.writeUInt32BE(seqno >>> 0, 6);
    header.writeUInt32BE(cmd >>> 0, 10);
    header.writeUInt32BE(payloadLength >>> 0, 14);

    const aad = header.subarray(4, 18);
    const cipher = createCipheriv("aes-128-gcm", keyBuf, iv);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();

    const suffix = Buffer.alloc(4);
    suffix.writeUInt32BE(TUYA_SUFFIX_9966, 0);
    return Buffer.concat([header, iv, ciphertext, tag, suffix]);
  }

  if (version === "3.4") {
    const addVerHeader =
      options.includeVersionHeader ??
      (cmd === TUYA_LOCAL_CMD.CONTROL_NEW && retcode === undefined);
    const plain = addVerHeader
      ? Buffer.concat([makeVersionHeader("3.4"), rawPayload])
      : rawPayload;
    const encrypted = plain.length > 0 && shouldEncrypt ? aes128EcbEncrypt(plain, keyBuf, true) : plain;

    const bodyParts: Buffer[] = [];
    if (retcode !== undefined) {
      const rc = Buffer.alloc(4);
      rc.writeUInt32BE(retcode >>> 0, 0);
      bodyParts.push(rc);
    }
    bodyParts.push(encrypted);
    const body = Buffer.concat(bodyParts);

    const length = body.length + 32 + 4;
    const header = Buffer.alloc(16);
    header.writeUInt32BE(TUYA_PREFIX_55AA, 0);
    header.writeUInt32BE(seqno >>> 0, 4);
    header.writeUInt32BE(cmd >>> 0, 8);
    header.writeUInt32BE(length >>> 0, 12);

    const headerAndBody = Buffer.concat([header, body]);
    const hmac = createHmac("sha256", keyBuf).update(headerAndBody).digest();
    const suffix = Buffer.alloc(4);
    suffix.writeUInt32BE(TUYA_SUFFIX_AA55, 0);
    return Buffer.concat([headerAndBody, hmac, suffix]);
  }

  // v3.3 & v3.1 (0x000055AA + CRC32 + 0x0000AA55)
  const addVerHeader =
    version === "3.3" &&
    (options.includeVersionHeader ??
      (cmd === TUYA_LOCAL_CMD.CONTROL && retcode === undefined));
  let encodedPayload: Buffer = rawPayload;
  if (rawPayload.length > 0 && shouldEncrypt && version === "3.3") {
    const encrypted = aes128EcbEncrypt(rawPayload, keyBuf, true);
    encodedPayload = addVerHeader
      ? Buffer.concat([makeVersionHeader("3.3"), encrypted])
      : encrypted;
  }

  const bodyParts: Buffer[] = [];
  if (retcode !== undefined) {
    const rc = Buffer.alloc(4);
    rc.writeUInt32BE(retcode >>> 0, 0);
    bodyParts.push(rc);
  }
  bodyParts.push(encodedPayload);
  const body = Buffer.concat(bodyParts);

  const length = body.length + 4 + 4;
  const header = Buffer.alloc(16);
  header.writeUInt32BE(TUYA_PREFIX_55AA, 0);
  header.writeUInt32BE(seqno >>> 0, 4);
  header.writeUInt32BE(cmd >>> 0, 8);
  header.writeUInt32BE(length >>> 0, 12);

  const headerAndBody = Buffer.concat([header, body]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(headerAndBody), 0);
  const suffix = Buffer.alloc(4);
  suffix.writeUInt32BE(TUYA_SUFFIX_AA55, 0);
  return Buffer.concat([headerAndBody, crcBuf, suffix]);
}

export interface UnpackTuyaLocalMessageOptions {
  key: string | Buffer;
  version: TuyaLocalVersion;
  /** 显式指定帧是否包含 4 字节 retcode；缺省时按协议规则自动识别 */
  hasRetcode?: boolean;
}

export interface UnpackedTuyaLocalMessage {
  prefix: number;
  seqno: number;
  cmd: number;
  retcode: number;
  payload: Buffer;
  payloadText: string;
  json: Record<string, unknown> | null;
  consumedBytes: number;
}

/** 从 TCP 流缓冲中切分出一个完整 Tuya 帧；数据不完整时返回 null。 */
export function tryExtractTuyaFrame(
  buffer: Buffer,
): { frame: Buffer; remainder: Buffer } | null {
  if (buffer.length < 4) return null;
  const prefix = buffer.readUInt32BE(0);
  if (prefix === TUYA_PREFIX_55AA) {
    if (buffer.length < 16) return null;
    const length = buffer.readUInt32BE(12);
    const total = 16 + length;
    if (length < 8 || total > 1024 * 1024) {
      throw new Error(`Invalid Tuya 55AA frame length: ${length}`);
    }
    if (buffer.length < total) return null;
    return {
      frame: buffer.subarray(0, total),
      remainder: buffer.subarray(total),
    };
  }
  if (prefix === TUYA_PREFIX_6699) {
    if (buffer.length < 18) return null;
    const length = buffer.readUInt32BE(14);
    const total = 18 + length + 4;
    if (length < 28 || total > 1024 * 1024) {
      throw new Error(`Invalid Tuya 6699 frame length: ${length}`);
    }
    if (buffer.length < total) return null;
    return {
      frame: buffer.subarray(0, total),
      remainder: buffer.subarray(total),
    };
  }
  throw new Error(`Unknown Tuya frame prefix: 0x${prefix.toString(16).padStart(8, "0")}`);
}

function tryParseJsonRecord(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/** 解包并校验 LocalTuya / TinyTuya 局域网帧（支持 v3.1 / v3.3 / v3.4 / v3.5） */
export function unpackTuyaLocalMessage(
  packet: Buffer,
  options: UnpackTuyaLocalMessageOptions,
): UnpackedTuyaLocalMessage {
  const keyBuf = toKeyBuffer(options.key);
  const { version, hasRetcode } = options;

  if (packet.length < 4) {
    throw new Error(`Tuya frame too short (${packet.length} bytes)`);
  }
  const prefix = packet.readUInt32BE(0);

  if (prefix === TUYA_PREFIX_6699) {
    if (packet.length < 18 + 28 + 4) {
      throw new Error(`Tuya 6699 frame too short (${packet.length} bytes)`);
    }
    const seqno = packet.readUInt32BE(6);
    const cmd = packet.readUInt32BE(10);
    const length = packet.readUInt32BE(14);
    const total = 18 + length + 4;
    if (packet.length < total) {
      throw new Error(`Tuya 6699 frame truncated: expected ${total}, got ${packet.length}`);
    }
    const suffix = packet.readUInt32BE(total - 4);
    if (suffix !== TUYA_SUFFIX_9966) {
      throw new Error(`Invalid Tuya 6699 suffix: 0x${suffix.toString(16)}`);
    }

    const aad = packet.subarray(4, 18);
    const iv = packet.subarray(18, 30);
    const ciphertext = packet.subarray(30, total - 20);
    const tag = packet.subarray(total - 20, total - 4);

    const decipher = createDecipheriv("aes-128-gcm", keyBuf, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    let decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

    let retcode = 0;
    const isHandshakeReq =
      cmd === TUYA_LOCAL_CMD.SESS_KEY_NEG_START || cmd === TUYA_LOCAL_CMD.SESS_KEY_NEG_FINISH;
    const detectedRetcode =
      hasRetcode !== undefined
        ? hasRetcode
        : !isHandshakeReq &&
          decrypted.length >= 4 &&
          (cmd === TUYA_LOCAL_CMD.SESS_KEY_NEG_RESP
            ? decrypted.length === 52
            : decrypted[0] !== 0x7b &&
              !hasVersionHeaderPrefix(decrypted, "3.5") &&
              (decrypted.length === 4 ||
                decrypted[4] === 0x7b ||
                hasVersionHeaderPrefix(decrypted.subarray(4), "3.5") ||
                decrypted.readUInt32BE(0) === 0));

    if (detectedRetcode && decrypted.length >= 4) {
      retcode = decrypted.readUInt32BE(0);
      decrypted = decrypted.subarray(4);
    }

    if (
      cmd !== TUYA_LOCAL_CMD.SESS_KEY_NEG_START &&
      cmd !== TUYA_LOCAL_CMD.SESS_KEY_NEG_RESP &&
      cmd !== TUYA_LOCAL_CMD.SESS_KEY_NEG_FINISH &&
      hasVersionHeaderPrefix(decrypted, "3.5")
    ) {
      decrypted = decrypted.subarray(15);
    }

    const payloadText = decrypted.toString("utf8");
    return {
      prefix,
      seqno,
      cmd,
      retcode,
      payload: decrypted,
      payloadText,
      json: tryParseJsonRecord(payloadText),
      consumedBytes: total,
    };
  }

  if (prefix !== TUYA_PREFIX_55AA) {
    throw new Error(`Invalid Tuya frame prefix: 0x${prefix.toString(16)}`);
  }
  if (packet.length < 24) {
    throw new Error(`Tuya 55AA frame too short (${packet.length} bytes)`);
  }

  const seqno = packet.readUInt32BE(4);
  const cmd = packet.readUInt32BE(8);
  const length = packet.readUInt32BE(12);
  const total = 16 + length;
  if (packet.length < total) {
    throw new Error(`Tuya 55AA frame truncated: expected ${total}, got ${packet.length}`);
  }
  const suffix = packet.readUInt32BE(total - 4);
  if (suffix !== TUYA_SUFFIX_AA55) {
    throw new Error(`Invalid Tuya 55AA suffix: 0x${suffix.toString(16)}`);
  }

  if (version === "3.4") {
    if (length < 36) {
      throw new Error(`Tuya v3.4 frame too short for HMAC (${length} bytes)`);
    }
    const signedData = packet.subarray(0, total - 36);
    const actualHmac = packet.subarray(total - 36, total - 4);
    const expectedHmac = createHmac("sha256", keyBuf).update(signedData).digest();
    if (!timingSafeEqual(actualHmac, expectedHmac)) {
      throw new Error("Tuya v3.4 HMAC-SHA256 verification failed");
    }

    const body = packet.subarray(16, total - 36);
    let retcode = 0;
    let encrypted = body;
    const detectedRetcode =
      hasRetcode !== undefined
        ? hasRetcode
        : body.length >= 4 && (body.length - 4) % 16 === 0;
    if (detectedRetcode && body.length >= 4) {
      retcode = body.readUInt32BE(0);
      encrypted = body.subarray(4);
    }

    let decrypted = encrypted.length > 0 ? aes128EcbDecrypt(encrypted, keyBuf, true) : Buffer.alloc(0);
    if (
      cmd !== TUYA_LOCAL_CMD.SESS_KEY_NEG_START &&
      cmd !== TUYA_LOCAL_CMD.SESS_KEY_NEG_RESP &&
      cmd !== TUYA_LOCAL_CMD.SESS_KEY_NEG_FINISH &&
      hasVersionHeaderPrefix(decrypted, "3.4")
    ) {
      decrypted = decrypted.subarray(15);
    }
    const payloadText = decrypted.toString("utf8");
    return {
      prefix,
      seqno,
      cmd,
      retcode,
      payload: decrypted,
      payloadText,
      json: tryParseJsonRecord(payloadText),
      consumedBytes: total,
    };
  }

  // v3.3 / v3.1 (CRC32)
  const signedData = packet.subarray(0, total - 8);
  const actualCrc = packet.readUInt32BE(total - 8);
  const expectedCrc = crc32(signedData);
  if (actualCrc !== expectedCrc) {
    throw new Error(
      `Tuya CRC32 mismatch: expected 0x${expectedCrc.toString(16)}, got 0x${actualCrc.toString(16)}`,
    );
  }

  const body = packet.subarray(16, total - 8);
  let retcode = 0;
  let rest = body;

  if (hasRetcode === true && body.length >= 4) {
    retcode = body.readUInt32BE(0);
    rest = body.subarray(4);
  } else if (hasRetcode === undefined && body.length >= 4) {
    if (hasVersionHeaderPrefix(body.subarray(4), "3.3")) {
      retcode = body.readUInt32BE(0);
      rest = body.subarray(4);
    } else if (!hasVersionHeaderPrefix(body, "3.3") && body[0] !== 0x7b) {
      if ((body.length - 4) % 16 === 0 || body[4] === 0x7b) {
        retcode = body.readUInt32BE(0);
        rest = body.subarray(4);
      }
    }
  }

  if (hasVersionHeaderPrefix(rest, "3.3")) {
    rest = rest.subarray(15);
  }

  let decrypted: Buffer;
  if (rest.length === 0) {
    decrypted = Buffer.alloc(0);
  } else if (rest[0] === 0x7b && rest[rest.length - 1] === 0x7d) {
    decrypted = rest;
  } else {
    decrypted = aes128EcbDecrypt(rest, keyBuf, true);
  }

  const payloadText = decrypted.toString("utf8");
  return {
    prefix,
    seqno,
    cmd,
    retcode,
    payload: decrypted,
    payloadText,
    json: tryParseJsonRecord(payloadText),
    consumedBytes: total,
  };
}

/**
 * 解密涂鸦局域网 UDP 6666/6667 广播发现报文：
 * - `0x000055AA`: 明文 JSON（v3.1/6666）或 AES-128-ECB + `md5("yGAdlopoPVldABfn")`（v3.3/3.4/6667）
 * - `0x00006699`: AES-128-GCM + `md5("yGAdlopoPVldABfn")`（v3.5）
 */
export function decryptUdpBroadcast(packet: Buffer): Record<string, unknown> | null {
  if (packet.length < 24) return null;
  try {
    const prefix = packet.readUInt32BE(0);
    if (prefix === TUYA_PREFIX_6699) {
      const unpacked = unpackTuyaLocalMessage(packet, {
        key: UDP_BROADCAST_KEY,
        version: "3.5",
      });
      return unpacked.json;
    }
    if (prefix === TUYA_PREFIX_55AA) {
      const unpacked = unpackTuyaLocalMessage(packet, {
        key: UDP_BROADCAST_KEY,
        version: "3.3",
      });
      return unpacked.json;
    }
    // 兼容极少数直接广播原始 JSON 的固件
    if (packet[0] === 0x7b) {
      return tryParseJsonRecord(packet.toString("utf8"));
    }
    return null;
  } catch {
    return null;
  }
}
