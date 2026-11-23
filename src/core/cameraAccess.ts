// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * Fresh video authorization for CS2 remote relay; never requires a LAN address.
 */

import { createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { CameraPreviewError } from "./cameraPreview.ts";

const X25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");
const HEX_64_RE = /^[0-9a-fA-F]{64}$/;
const INSPECT_CUSTOM = Symbol.for("nodejs.util.inspect.custom");

export class CameraSource {
  readonly uid: string;
  readonly init_string: string;
  readonly client_public: string;
  readonly client_private: string;
  readonly device_public: string;
  readonly sign: string;

  constructor(
    uid: string,
    init_string: string,
    client_public: string,
    client_private: string,
    device_public: string,
    sign: string,
  ) {
    this.uid = uid;
    this.init_string = init_string;
    this.client_public = client_public;
    this.client_private = client_private;
    this.device_public = device_public;
    this.sign = sign;
  }

  toString(): string {
    return `CameraSource(uid=${this.uid})`;
  }

  toJSON(): { uid: string } {
    return { uid: this.uid };
  }

  [INSPECT_CUSTOM](): string {
    return `CameraSource(uid=${this.uid})`;
  }
}

export function generateX25519KeyPair(): { publicHex: string; privateHex: string } {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  const spkiDer = publicKey.export({ format: "der", type: "spki" });
  const pkcs8Der = privateKey.export({ format: "der", type: "pkcs8" });
  const publicHex = Buffer.from(spkiDer).subarray(-32).toString("hex");
  const privateHex = Buffer.from(pkcs8Der).subarray(-32).toString("hex");
  return { publicHex, privateHex };
}

export function deriveX25519PublicHex(privateSeedHex: string): string {
  if (!HEX_64_RE.test(privateSeedHex)) {
    throw new RangeError("X25519 private seed must be a 64-character hex string");
  }
  const seed = Buffer.from(privateSeedHex, "hex");
  const pkcs8Der = Buffer.concat([X25519_PKCS8_PREFIX, seed]);
  const privateKey = createPrivateKey({
    key: pkcs8Der,
    format: "der",
    type: "pkcs8",
  });
  const publicKey = createPublicKey(privateKey);
  const spkiDer = publicKey.export({ format: "der", type: "spki" });
  return Buffer.from(spkiDer).subarray(-32).toString("hex");
}

export type CloudRequestFn = (
  uri: string,
  data: Record<string, unknown>,
) => Promise<Record<string, unknown>> | Record<string, unknown>;

export type CameraDiagnosticRecorder = (fields: Record<string, unknown>) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function buildCameraSource(
  did: string,
  model: string,
  cloudRequest: CloudRequestFn,
  diagnostic: CameraDiagnosticRecorder = () => {},
): Promise<CameraSource> {
  void model;
  const { publicHex, privateHex } = generateX25519KeyPair();

  const rawResponse = await cloudRequest("/v2/device/miss_get_vendor", {
    did: String(did),
    app_pubkey: publicHex,
    support_vendors: "TUTK_CS2_MTP",
  });

  const response = isRecord(rawResponse) ? rawResponse : {};
  const vendor = isRecord(response.vendor) ? response.vendor : {};
  const params = isRecord(vendor.vendor_params) ? vendor.vendor_params : {};
  const vendorId = vendor.vendor;

  diagnostic({
    vendor_id: vendorId,
    protocol: vendorId === 4 ? "CS2" : "unrecognized",
    authorization_fields_present: {
      p2p_id: Boolean(params.p2p_id),
      init_string: Boolean(params.init_string),
      public_key: Boolean(response.public_key),
      sign: Boolean(response.sign),
    },
  });

  if (vendorId !== 4) {
    throw new CameraPreviewError(
      "当前远程预览仅支持 CS2 摄像头，该设备的视频传输方式暂未接入。",
      "VENDOR_UNSUPPORTED",
    );
  }

  const values: unknown[] = [
    params.p2p_id,
    params.init_string,
    publicHex,
    privateHex,
    response.public_key,
    response.sign,
  ];

  if (
    values.some(
      (v) =>
        typeof v !== "string" ||
        v.length === 0 ||
        v.length > 16384 ||
        v.includes("\n") ||
        v.includes("\r"),
    )
  ) {
    throw new CameraPreviewError(
      "米家未返回完整的远程视频授权或中继地址，请确认摄像头在线后重试。",
      "AUTH_FIELDS",
    );
  }

  const [uid, initString, clientPublic, clientPrivate, devicePublic, sign] =
    values as [string, string, string, string, string, string];

  if (!HEX_64_RE.test(devicePublic)) {
    throw new CameraPreviewError("米家返回的视频密钥格式不完整，请重试。", "AUTH_KEY");
  }

  return new CameraSource(uid, initString, clientPublic, clientPrivate, devicePublic, sign);
}
