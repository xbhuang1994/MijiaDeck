// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * High-level MIoT device wrapper (`MijiaDevice`, `DevProp`, `DevAction`)
 * matching mijiaAPI 5.x semantics.
 */

import { dirname } from "node:path";

import type { FetchLike } from "../core/httpTimeout.ts";
import type { PropEnumOption } from "../core/models.ts";
import {
  DeviceActionError,
  DeviceGetError,
  DeviceNotFoundError,
  DeviceSetError,
  GetDeviceInfoError,
} from "./errors.ts";
import {
  getDeviceInfo,
  type FlattenedSpec,
  type RawSpecAction,
  type RawSpecProp,
} from "./spec.ts";

export interface MijiaDeviceApi {
  authDataPath: string;
  getDevicesList(): Promise<Array<Record<string, unknown>>>;
  getDevicesProp(
    queries: Record<string, unknown> | Array<Record<string, unknown>>,
  ): Promise<unknown>;
  setDevicesProp(
    queries: Record<string, unknown> | Array<Record<string, unknown>>,
  ): Promise<unknown>;
  runAction(payload: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export class DevProp {
  readonly name: string;
  desc: string;
  readonly type: string;
  readonly rw: string;
  readonly unit: string | null;
  readonly range: [number, number, number] | [number, number] | null;
  readonly valueList: PropEnumOption[] | null;
  readonly method: { siid: number; piid: number };
  readonly service: string;
  readonly serviceDesc: string;

  constructor(raw: RawSpecProp) {
    this.name = String(raw.name ?? "");
    this.desc = String(raw.description ?? "");
    this.type = String(raw.type ?? "");
    this.rw = String(raw.rw ?? "");
    this.unit = raw.unit ?? null;
    this.range = raw.range ? ([...raw.range] as [number, number, number] | [number, number]) : null;
    this.valueList = raw["value-list"]
      ? raw["value-list"].map((entry) => ({ ...entry }))
      : null;
    this.method = {
      siid: raw.method.siid,
      piid: raw.method.piid,
    };
    this.service = typeof raw.service === "string" ? raw.service : "";
    this.serviceDesc = typeof raw.serviceDesc === "string" ? raw.serviceDesc : "";
  }

  get description(): string {
    return this.desc;
  }

  set description(value: string) {
    this.desc = value;
  }

  get value_list(): PropEnumOption[] | null {
    return this.valueList;
  }
}

export class DevAction {
  readonly name: string;
  desc: string;
  readonly method: { siid: number; aiid: number };
  readonly service: string;
  readonly serviceDesc: string;
  readonly inPiids: number[];

  constructor(raw: RawSpecAction) {
    this.name = String(raw.name ?? "");
    this.desc = String(raw.description ?? "");
    this.method = {
      siid: raw.method.siid,
      aiid: raw.method.aiid,
    };
    this.service = typeof raw.service === "string" ? raw.service : "";
    this.serviceDesc = typeof raw.serviceDesc === "string" ? raw.serviceDesc : "";
    this.inPiids = Array.isArray(raw.in)
      ? raw.in.filter((n): n is number => typeof n === "number" && Number.isInteger(n))
      : [];
  }

  get description(): string {
    return this.desc;
  }

  set description(value: string) {
    this.desc = value;
  }
}

export interface MijiaDeviceFromSpecOptions {
  did: string;
  model: string;
  name?: string;
  spec: FlattenedSpec;
  sleepTime?: number;
}

export interface MijiaDeviceCreateOptions {
  did?: string;
  devName?: string;
  sleepTime?: number;
  cachePath?: string;
  fetcher?: FetchLike;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function sleepSeconds(seconds: number): Promise<void> {
  if (seconds > 0 && Number.isFinite(seconds)) {
    await new Promise<void>((resolve) => setTimeout(resolve, seconds * 1000));
  }
}

export class MijiaDevice {
  api: MijiaDeviceApi;
  did: string;
  model: string;
  name: string;
  sleepTime: number;
  propList: Record<string, DevProp>;
  actionList: Record<string, DevAction>;

  private constructor(
    api: MijiaDeviceApi,
    did: string,
    model: string,
    name: string,
    sleepTime: number,
    propList: Record<string, DevProp>,
    actionList: Record<string, DevAction>,
  ) {
    this.api = api;
    this.did = did;
    this.model = model;
    this.name = name;
    this.sleepTime = sleepTime;
    this.propList = propList;
    this.actionList = actionList;
  }

  static fromSpec(api: MijiaDeviceApi, options: MijiaDeviceFromSpecOptions): MijiaDevice {
    const propList: Record<string, DevProp> = {};
    for (const rawProp of options.spec.properties ?? []) {
      const propObj = new DevProp(rawProp);
      propList[propObj.name] = propObj;
      if (propObj.name.includes("-")) {
        // Hyphen and underscore aliases point to the exact same DevProp instance.
        propList[propObj.name.replaceAll("-", "_")] = propObj;
      }
    }

    const actionList: Record<string, DevAction> = {};
    for (const rawAction of options.spec.actions ?? []) {
      const actionObj = new DevAction(rawAction);
      actionList[actionObj.name] = actionObj;
    }

    return new MijiaDevice(
      api,
      String(options.did),
      String(options.model ?? ""),
      options.name || options.spec.name || String(options.did),
      options.sleepTime ?? 0.5,
      propList,
      actionList,
    );
  }

  /**
   * Look up an owned device via `api.getDevicesList()` (excluding shared devices,
   * matching mijiaAPI 5.x) and initialize its MIoT spec.
   */
  static async create(
    api: MijiaDeviceApi,
    options: MijiaDeviceCreateOptions,
  ): Promise<MijiaDevice> {
    const { did, devName, sleepTime = 0.5, cachePath, fetcher } = options;
    if (!did && !devName) {
      throw new DeviceNotFoundError("Either did or devName must be provided");
    }

    const devices = await api.getDevicesList();
    const matched = devices.find((item) => {
      if (did !== undefined && did !== "") {
        return String(item["did"] ?? "") === String(did);
      }
      return String(item["name"] ?? "") === String(devName);
    });

    if (!matched) {
      throw new DeviceNotFoundError(`Device not found: ${did ?? devName}`);
    }

    const matchedDid = String(matched["did"] ?? did ?? "");
    const model = String(matched["model"] ?? "");
    const name = String(matched["name"] ?? matchedDid);
    const specType = String(matched["spec_type"] ?? "").trim();

    if (!specType) {
      throw new GetDeviceInfoError(`Device ${matchedDid} has no spec_type`);
    }

    const spec = await getDeviceInfo(specType, {
      cachePath: cachePath ?? dirname(api.authDataPath),
      fetcher,
    });

    return MijiaDevice.fromSpec(api, {
      did: matchedDid,
      model,
      name: name || spec.name || matchedDid,
      spec,
      sleepTime,
    });
  }

  async get(name: string): Promise<unknown> {
    const prop = this.propList[name];
    if (!prop) {
      throw new DeviceGetError(`Property not found: ${name}`);
    }
    if (!prop.rw.includes("r")) {
      throw new DeviceGetError(`Property ${name} is not readable`);
    }

    const query: Record<string, unknown> = {
      did: this.did,
      siid: prop.method.siid,
      piid: prop.method.piid,
    };

    const rawResult = await this.api.getDevicesProp(query);
    const item = Array.isArray(rawResult) ? rawResult[0] : rawResult;
    if (!isRecord(item) || item["code"] !== 0) {
      const code = isRecord(item) && typeof item["code"] === "number" ? item["code"] : undefined;
      const msg = isRecord(item) && item["message"] ? String(item["message"]) : "unknown error";
      throw new DeviceGetError(
        `Failed to get property ${name} on ${this.did}: ${msg}${code !== undefined ? ` (code ${code})` : ""}`,
        code,
      );
    }

    await sleepSeconds(this.sleepTime);
    return item["value"];
  }

  async set(name: string, value: unknown): Promise<void> {
    const prop = this.propList[name];
    if (!prop) {
      throw new DeviceSetError(`Property not found: ${name}`);
    }
    if (!prop.rw.includes("w")) {
      throw new DeviceSetError(`Property ${name} is not writable`);
    }

    const query: Record<string, unknown> = {
      did: this.did,
      siid: prop.method.siid,
      piid: prop.method.piid,
      value,
    };

    const rawResult = await this.api.setDevicesProp(query);
    const item = Array.isArray(rawResult) ? rawResult[0] : rawResult;
    const code = isRecord(item) && typeof item["code"] === "number" ? item["code"] : undefined;
    if (!isRecord(item) || (code !== 0 && code !== 1)) {
      const msg = isRecord(item) && item["message"] ? String(item["message"]) : "unknown error";
      throw new DeviceSetError(
        `Failed to set property ${name} on ${this.did}: ${msg}${code !== undefined ? ` (code ${code})` : ""}`,
        code,
      );
    }

    await sleepSeconds(this.sleepTime);
  }

  async runAction(
    name: string,
    params?: unknown[] | { _in?: unknown[] },
  ): Promise<unknown> {
    const action = this.actionList[name] ?? this.actionList[name.replaceAll("_", "-")];
    if (!action) {
      throw new DeviceActionError(`Action not found: ${name}`);
    }

    let inArgs: unknown[];
    if (params === undefined) {
      inArgs = [];
    } else if (Array.isArray(params)) {
      inArgs = params;
    } else if (isRecord(params) && "_in" in params) {
      const rawIn = params["_in"];
      inArgs = Array.isArray(rawIn) ? rawIn : rawIn === undefined ? [] : [rawIn];
    } else {
      inArgs = [];
    }

    const payload: Record<string, unknown> = {
      did: this.did,
      siid: action.method.siid,
      aiid: action.method.aiid,
      in: inArgs,
    };

    const res = await this.api.runAction(payload);
    const code = typeof res["code"] === "number" ? res["code"] : 0;
    if (code !== 0 && code !== 1) {
      const msg = res["message"] ? String(res["message"]) : "unknown error";
      throw new DeviceActionError(
        `Failed to run action ${name} on ${this.did}: ${msg} (code ${code})`,
        code,
      );
    }

    await sleepSeconds(this.sleepTime);
    return res;
  }
}
