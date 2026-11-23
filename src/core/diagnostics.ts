// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/** Explicit, read-only device samples. Never serialize a device/API object. */

import os from "node:os";

import { APP_VERSION } from "./appMeta.ts";
import { deviceKinds } from "./deviceControls.ts";
import type { DeviceInfo } from "./models.ts";

const IDENTIFIER_RE = /^[A-Za-z0-9_.:-]+$/;
const NON_PRINTABLE_RE = /^(?:\p{C}|\p{Zl}|\p{Zp}|(?! )\p{Zs})$/u;
const PUBLIC_SPEC_ENDPOINT = "https://miot-spec.org/miot-spec-v2/instance";
const MAX_PUBLIC_SPEC_BYTES = 2_000_000;
const PUBLIC_SPEC_TIMEOUT_MS = 6_000;
const MAX_ELAPSED_MS = 86_400_000;

const REGIONS = ["de", "us", "sg", "ru", "in", "i2", "tw"] as const;

export const STAGES: ReadonlySet<string> = new Set([
  "idle",
  "power",
  "authorization",
  "relay",
  "session_auth",
  "media",
  "decode",
  "playing",
  "stream",
]);

export const CODES: ReadonlySet<string> = new Set([
  "NONE",
  "NOT_ATTEMPTED",
  "UNKNOWN",
  "VENDOR_UNSUPPORTED",
  "AUTH_FIELDS",
  "AUTH_KEY",
  "CLOUD_REJECTED",
  "HTTP_ERROR",
  "REQUEST_FAILED",
  "CONFIG",
  "RELAY",
  "AUTH",
  "MEDIA",
  "STREAM",
  "HELPER_EXIT",
  "TIMEOUT",
  "DECODE",
  "CANCELLED",
  "OFFLINE",
  "POWER_UNKNOWN",
  "POWER_READ_FAILED",
  "AUDIO_UNSUPPORTED",
  "CONTROL_FAILED",
  "PLAYER_RESOURCE",
  "PLAYER_FORMAT",
  "PLAYER_NETWORK",
  "PLAYER_ACCESS",
]);

export interface BuildReportOptions {
  spec?: Record<string, unknown> | null;
  cachedSpec?: Record<string, unknown> | null;
  specStatus?: string;
  region?: string;
  observation?: Record<string, unknown> | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTimeoutError(err: unknown, aborted: boolean): boolean {
  if (aborted) {
    return true;
  }
  if (err instanceof Error) {
    return err.name === "TimeoutError" || err.name === "AbortError";
  }
  return false;
}

export function identifier(value: unknown, limit = 240): string | null {
  return typeof value === "string" && value.length <= limit && IDENTIFIER_RE.test(value)
    ? value
    : null;
}

export function safeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1e16
    ? value
    : null;
}

export function safeNumbers(values: unknown): number[] {
  if (!Array.isArray(values)) {
    return [];
  }
  const result: number[] = [];
  for (const item of values.slice(0, 64)) {
    const n = safeNumber(item);
    if (n !== null) {
      result.push(n);
    }
  }
  return result;
}

export function safeLabel(value: unknown): string {
  // Only used for descriptions fetched from the public MIoT specification.
  if (typeof value !== "string") {
    return "";
  }
  const chars = Array.from(value).slice(0, 160);
  let out = "";
  for (const ch of chars) {
    if (!NON_PRINTABLE_RE.test(ch)) {
      out += ch;
    }
  }
  return out;
}

export function safeItems<T>(value: unknown, limit: number): T[] {
  return Array.isArray(value) ? (value.slice(0, limit) as T[]) : [];
}

export async function fetchPublicSpec(
  specType: string,
  fetcher?: typeof fetch,
): Promise<[Record<string, unknown> | null, string]> {
  if (!identifier(specType) || !specType.startsWith("urn:miot-spec-v2:device:")) {
    return [null, "no_public_spec_type"];
  }

  const doFetch = fetcher ?? fetch;
  const url = new URL(PUBLIC_SPEC_ENDPOINT);
  url.searchParams.set("type", specType);

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new DOMException("Public spec lookup timed out", "TimeoutError"));
  }, PUBLIC_SPEC_TIMEOUT_MS);
  (timer as { unref?: () => void }).unref?.();

  try {
    const response = await doFetch(url.toString(), { signal: controller.signal });
    if (!response.ok) {
      await response.body?.cancel?.().catch(() => {});
      return [null, "public_spec_unavailable"];
    }

    let bytes: Uint8Array;
    if (response.body) {
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          if (value) {
            total += value.byteLength;
            if (total > MAX_PUBLIC_SPEC_BYTES) {
              await reader.cancel().catch(() => {});
              return [null, "public_spec_too_large"];
            }
            chunks.push(value);
          }
        }
      } finally {
        reader.releaseLock();
      }
      bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
    } else {
      const buf = new Uint8Array(await response.arrayBuffer());
      if (buf.byteLength > MAX_PUBLIC_SPEC_BYTES) {
        return [null, "public_spec_too_large"];
      }
      bytes = buf;
    }

    const text = new TextDecoder().decode(bytes);
    const raw: unknown = JSON.parse(text);
    if (!isPlainObject(raw) || !Array.isArray(raw.services)) {
      return [null, "invalid_public_spec"];
    }
    return [raw, "ok"];
  } catch (err) {
    if (isTimeoutError(err, controller.signal.aborted)) {
      return [null, "public_spec_timeout"];
    }
    return [null, "public_spec_unavailable"];
  } finally {
    clearTimeout(timer);
  }
}

/** Keep public service/property/action/event definitions, never current values. */
export function publicCapabilities(raw: Record<string, unknown>): Array<Record<string, unknown>> {
  const services: Array<Record<string, unknown>> = [];
  for (const service of safeItems<unknown>(raw.services, 80)) {
    if (!isPlainObject(service)) {
      continue;
    }
    const entry: Record<string, unknown> = {
      siid: safeNumber(service.iid),
      type: identifier(service.type),
      description: safeLabel(service.description),
    };
    const kinds: ReadonlyArray<readonly [string, string]> = [
      ["properties", "piid"],
      ["actions", "aiid"],
      ["events", "eiid"],
    ];
    for (const [kind, idKey] of kinds) {
      const definitions: Array<Record<string, unknown>> = [];
      for (const item of safeItems<unknown>(service[kind], 160)) {
        if (!isPlainObject(item)) {
          continue;
        }
        const clean: Record<string, unknown> = {
          [idKey]: safeNumber(item.iid),
          type: identifier(item.type),
          description: safeLabel(item.description),
        };
        if (kind === "properties") {
          clean.format = identifier(item.format);
          clean.unit = identifier(item.unit);
          clean.access = safeItems<unknown>(item.access, 8).filter(
            (x): x is string => x === "read" || x === "write" || x === "notify",
          );
          clean.range = safeNumbers(item["value-range"]);
          clean.enum = safeItems<unknown>(item["value-list"], 64)
            .filter(isPlainObject)
            .map((v) => ({
              value: safeNumber(v.value),
              description: safeLabel(v.description),
            }));
        } else if (kind === "actions") {
          clean.inputs = safeNumbers(item.in);
          clean.outputs = safeNumbers(item.out);
        } else {
          clean.arguments = safeNumbers(item.arguments);
        }
        definitions.push(clean);
      }
      entry[kind] = definitions;
    }
    services.push(entry);
  }
  return services;
}

/** The SDK flattens specs and drops events/notify/input/output information. */
export function cachedCapabilities(
  raw: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const source = isPlainObject(raw) ? raw : {};
  const result: Record<string, unknown> = {};
  const kinds: ReadonlyArray<readonly [string, string]> = [
    ["properties", "piid"],
    ["actions", "aiid"],
  ];
  for (const [kind, iid] of kinds) {
    result[kind] = safeItems<unknown>(source[kind], 400)
      .filter(isPlainObject)
      .map((p) => {
        const method = isPlainObject(p.method) ? p.method : {};
        const rw = typeof p.rw === "string" ? p.rw : "";
        return {
          name: identifier(p.name),
          siid: safeNumber(method.siid),
          [iid]: safeNumber(method[iid]),
          format: identifier(p.type),
          access: (["r", "w"] as const).filter((c) => rw.includes(c)),
          range: safeNumbers(p.range),
        };
      });
  }
  result.events = "unavailable_in_sdk_cache";
  return result;
}

export function safeObservation(raw: unknown): Record<string, unknown> {
  const source = isPlainObject(raw) ? raw : {};
  const result: Record<string, unknown> = {};

  for (const key of ["attempted", "power_readable", "video_received", "gop_bootstrap"] as const) {
    if (typeof source[key] === "boolean") {
      result[key] = source[key];
    }
  }
  for (const key of ["vendor_id", "http_status", "cloud_code", "width", "height", "player_error"] as const) {
    const n = safeNumber(source[key]);
    if (n !== null) {
      result[key] = n;
    }
  }

  result.stage =
    typeof source.stage === "string" && STAGES.has(source.stage) ? source.stage : "idle";
  result.error_code =
    typeof source.error_code === "string" && CODES.has(source.error_code)
      ? source.error_code
      : source.attempted
        ? "UNKNOWN"
        : "NOT_ATTEMPTED";

  if (source.protocol === "CS2" || source.protocol === "unrecognized") {
    result.protocol = source.protocol;
  }
  if (source.video_codec === "H264" || source.video_codec === "H265") {
    result.video_codec = source.video_codec;
  }
  if (isPlainObject(source.authorization_fields_present)) {
    const authFields: Record<string, boolean> = {};
    for (const key of ["p2p_id", "init_string", "public_key", "sign"] as const) {
      if (typeof source.authorization_fields_present[key] === "boolean") {
        authFields[key] = source.authorization_fields_present[key] as boolean;
      }
    }
    result.authorization_fields_present = authFields;
  }
  if (typeof source.elapsed_ms === "number" && Number.isInteger(source.elapsed_ms)) {
    result.elapsed_ms = Math.max(0, Math.min(source.elapsed_ms, MAX_ELAPSED_MS));
  }

  const rawTimeline = safeItems<unknown>(source.timeline, 1000).slice(-24);
  result.timeline = rawTimeline.filter(isPlainObject).map((entry) => ({
    stage: typeof entry.stage === "string" && STAGES.has(entry.stage) ? entry.stage : "idle",
    elapsed_ms:
      typeof entry.elapsed_ms === "number" && Number.isInteger(entry.elapsed_ms)
        ? Math.max(0, Math.min(entry.elapsed_ms, MAX_ELAPSED_MS))
        : 0,
    code: typeof entry.code === "string" && CODES.has(entry.code) ? entry.code : null,
  }));

  return result;
}

export function regionFromUrl(url: unknown): string {
  if (typeof url !== "string") {
    return "unknown";
  }
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return "unknown";
  }
  if (host === "api.io.mi.com") {
    return "cn";
  }
  for (const region of REGIONS) {
    if (host === `${region}.api.io.mi.com`) {
      return region;
    }
  }
  return "unknown";
}

function osName(): string {
  const name = os.type();
  return name === "Windows_NT" ? "Windows" : name;
}

export function buildReport(device: DeviceInfo, options: BuildReportOptions = {}): string {
  const {
    spec = null,
    cachedSpec = null,
    specStatus = "not_requested",
    region = "unknown",
    observation = null,
  } = options;

  const hasSpec = spec !== null && spec !== undefined;
  const hasCachedSpec = isPlainObject(cachedSpec) && Object.keys(cachedSpec).length > 0;
  // Invalid/untrusted role strings are never copied from model metadata.
  const kinds = [...deviceKinds(device)].sort().filter((x) => identifier(x, 64) !== null);

  const data = {
    schema: "mijiadeck-device-diagnostic/1",
    generated_at_utc: new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00"),
    application: {
      version: APP_VERSION,
      os: osName(),
      os_release: os.release(),
      os_build: os.version(),
      architecture: os.arch(),
    },
    device: {
      model: identifier(device.model),
      spec_type: identifier(device.spec_type ?? ""),
      firmware: identifier(device.firmware ?? "", 80),
      online: Boolean(device.online),
      kinds,
      cloud_region: region,
    },
    capabilities: {
      source: hasSpec ? "public_miot_spec" : hasCachedSpec ? "sdk_cache" : "unavailable",
      fetch_status: specStatus,
      declared_only: true,
      definitions: hasSpec ? publicCapabilities(spec) : cachedCapabilities(cachedSpec),
    },
    observation: safeObservation(observation),
    limits: [
      "声明存在不代表 MijiaDeck 已实现或实机验证；事件定义不代表已收到事件。",
      "未采集当前属性值、历史事件、媒体地址或摄像头画面；未执行任何设备动作。",
      "未尝试视频连接时，无法仅凭 MIoT 规格确定实际视频传输协议。",
    ],
  };

  const content = JSON.stringify(data, null, 2).replaceAll("`", "\\u0060");
  return (
    "### MijiaDeck 设备诊断报告\n\n" +
    "请补充：想实现的功能／操作步骤／实际现象／米家 APP 中是否正常。\n\n" +
    "```json\n" +
    content +
    "\n```\n"
  );
}
