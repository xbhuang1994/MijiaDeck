// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * Xiaomi MIoT API v2 encryption and request signing utilities
 * (protocol-compatible with mijiaAPI 5.x).
 */

import { createHash, randomBytes } from "node:crypto";

const RC4_DEFAULT_DROP = 1024;

function normalizeUri(uri: string): string {
  if (uri.startsWith("http://") || uri.startsWith("https://")) {
    const pathname = new URL(uri).pathname;
    return pathname.startsWith("/app/") ? pathname.slice(4) : pathname;
  }
  return uri.startsWith("/app/") ? uri.slice(4) : uri;
}

/**
 * Generate a 12-byte MIoT nonce (8 random bytes + 4-byte big-endian epoch minutes),
 * returned as standard Base64.
 */
export function genNonce(): string {
  const buf = Buffer.alloc(12);
  randomBytes(8).copy(buf, 0);
  const minutes = Math.floor(Date.now() / 60000) >>> 0;
  buf.writeUInt32BE(minutes, 8);
  return buf.toString("base64");
}

/**
 * Derive signed nonce: Base64(SHA-256(Base64Decode(ssecurity) || Base64Decode(nonce))).
 */
export function getSignedNonce(ssecurity: string, nonce: string): string {
  const secretBytes = Buffer.from(ssecurity, "base64");
  const nonceBytes = Buffer.from(nonce, "base64");
  return createHash("sha256")
    .update(Buffer.concat([secretBytes, nonceBytes]))
    .digest("base64");
}

/**
 * Standard RC4 KSA + PRGA discarding the first `drop` keystream bytes
 * (Xiaomi MIoT API v2 uses RC4-drop1024).
 */
export function rc4Crypt(
  key: Uint8Array,
  data: Uint8Array,
  drop: number = RC4_DEFAULT_DROP,
): Uint8Array {
  const keyLen = key.length;
  if (keyLen === 0) {
    throw new RangeError("RC4 key must not be empty");
  }

  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    s[i] = i;
  }

  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i]! + key[i % keyLen]!) & 0xff;
    const tmp = s[i]!;
    s[i] = s[j]!;
    s[j] = tmp;
  }

  let i = 0;
  j = 0;
  for (let k = 0; k < drop; k++) {
    i = (i + 1) & 0xff;
    j = (j + s[i]!) & 0xff;
    const tmp = s[i]!;
    s[i] = s[j]!;
    s[j] = tmp;
  }

  const out = new Uint8Array(data.length);
  for (let k = 0; k < data.length; k++) {
    i = (i + 1) & 0xff;
    j = (j + s[i]!) & 0xff;
    const tmp = s[i]!;
    s[i] = s[j]!;
    s[j] = tmp;
    const keystreamByte = s[(s[i]! + s[j]!) & 0xff]!;
    out[k] = data[k]! ^ keystreamByte;
  }

  return out;
}

/**
 * SHA-1 signature used in MIoT `signature` parameter:
 * Base64(SHA-1("uri&signedNonce&nonce&k1=v1&..."))
 */
export function generateSignature(
  uri: string,
  signedNonce: string,
  nonce: string,
  params: Record<string, string>,
): string {
  const parts: string[] = [normalizeUri(uri), signedNonce, nonce];
  for (const [k, v] of Object.entries(params)) {
    parts.push(`${k}=${v}`);
  }
  return createHash("sha1").update(parts.join("&"), "utf8").digest("base64");
}

/**
 * SHA-1 signature for RC4-encrypted MIoT requests:
 * Base64(SHA-1("METHOD&uri&k1=v1&...&signedNonce"))
 */
export function generateEncSignature(
  uri: string,
  method: string,
  signedNonce: string,
  params: Record<string, string>,
): string {
  const parts: string[] = [method.toUpperCase(), normalizeUri(uri)];
  for (const [k, v] of Object.entries(params)) {
    parts.push(`${k}=${v}`);
  }
  parts.push(signedNonce);
  return createHash("sha1").update(parts.join("&"), "utf8").digest("base64");
}

/**
 * Encrypt request parameters with RC4-drop1024 keyed by Base64-decoded `signedNonce`,
 * compute `rc4_hash__` and `signature`, and append `ssecurity` and `_nonce`.
 */
export function generateEncParams(
  uri: string,
  method: string,
  signedNonce: string,
  nonce: string,
  params: Record<string, string>,
  ssecurity: string,
): Record<string, string> {
  const work: Record<string, string> = { ...params };
  work["rc4_hash__"] = generateEncSignature(uri, method, signedNonce, work);

  const key = Buffer.from(signedNonce, "base64");
  const encrypted: Record<string, string> = {};
  for (const [k, v] of Object.entries(work)) {
    const plainBytes = Buffer.from(v, "utf8");
    const cipherBytes = rc4Crypt(key, plainBytes, RC4_DEFAULT_DROP);
    encrypted[k] = Buffer.from(cipherBytes).toString("base64");
  }

  encrypted["signature"] = generateEncSignature(uri, method, signedNonce, encrypted);
  encrypted["ssecurity"] = ssecurity;
  encrypted["_nonce"] = nonce;
  return encrypted;
}

/**
 * Decrypt a Base64 RC4-drop1024 MIoT API response payload and decode as UTF-8.
 */
export function decrypt(ssecurity: string, nonce: string, payload: string): string {
  const signedNonce = getSignedNonce(ssecurity, nonce);
  const key = Buffer.from(signedNonce, "base64");
  const cipherBytes = Buffer.from(payload, "base64");
  const plainBytes = rc4Crypt(key, cipherBytes, RC4_DEFAULT_DROP);
  return Buffer.from(plainBytes).toString("utf8");
}
