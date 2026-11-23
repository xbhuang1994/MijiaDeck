// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * MIoT 服务适配层——全项目唯一直接协调 MijiaApiClient / MijiaDevice 的模块。
 *
 * 界面层与任务层通过 IMijiaService 合约交互，不感知底层协议与第三方类型细节。
 */

import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  DeviceNotFoundError,
  GetDeviceInfoError,
  MIJIA_API_VERSION,
  MijiaApiClient,
  MijiaApiError,
  MijiaDevice,
  getDeviceInfo,
  type DevProp,
  type FlattenedSpec,
  type MijiaApiClientOptions,
} from "../mijia/index.ts";
import * as accountStore from "./accountStore.ts";
import { buildCameraSource, type CameraSource } from "./cameraAccess.ts";
import { CameraPreviewError } from "./cameraPreview.ts";
import type { IMijiaService, ProgressCallback, QrLoginData } from "./contracts.ts";
import {
  isLight,
  isStatusCandidate,
  lightControls,
  prepareDeviceCards,
  supportsCardPower,
} from "./deviceControls.ts";
import { buildReport, fetchPublicSpec, regionFromUrl, safeObservation } from "./diagnostics.ts";
import * as iconStore from "./iconStore.ts";
import {
  createDeviceInfo,
  createPropInfo,
  createSceneInfo,
  type ActionInfo,
  type DeviceDetail,
  type DeviceInfo,
  type PropInfo,
  type SceneInfo,
} from "./models.ts";
import * as specZh from "./specZh.ts";

/** 单次批量属性读取的设备数上限，防止请求体过大被网关拒绝。 */
export const BATCH_SIZE = 15;

/** spec 并发拉取数；目标是 miot-spec.org 的独立请求，无会话竞争。 */
export const SPEC_WORKERS = 8;

const SPLIT_DID_RE = /^(.+)\.s([0-9]+)$/;
const CJK_RE = /[\u4e00-\u9fff]/;
const PRODUCT_PAGE_SCRIPT_RE =
  /<script data-page="app" type="application\/json">([\s\S]*?)<\/script>/;

const CAMERA_PER_ATTEMPT_FIELDS = [
  "vendor_id",
  "protocol",
  "authorization_fields_present",
  "cloud_code",
  "http_status",
  "video_codec",
  "gop_bootstrap",
  "player_error",
  "width",
  "height",
] as const;

const TEXT_DIRECTIVE_ACTIONS = new Set([
  "execute-text-directive",
  "play-text",
  "play-music",
  "play-radio",
]);

/** 携带用户可直接阅读的中文信息，界面层直接展示 message 即可。 */
export class ServiceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ServiceError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface MijiaServiceOptions {
  api?: MijiaApiClient;
  apiFactory?: (options?: MijiaApiClientOptions) => MijiaApiClient;
  specFetcher?: (specType: string, options?: { cachePath?: string }) => Promise<FlattenedSpec>;
  publicSpecFetcher?: (specType: string) => Promise<[Record<string, unknown> | null, string]>;
  httpFetch?: typeof fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFsError(err: unknown): boolean {
  return err instanceof Error && typeof (err as NodeJS.ErrnoException).code === "string";
}

function wrapError(err: unknown, context: string): ServiceError {
  const detail = err instanceof Error ? err.message : String(err);
  return new ServiceError(`${context}: ${detail}`, { cause: err });
}

function hasCjk(text: string): boolean {
  return CJK_RE.test(text);
}

function compareStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function formatTemp(value: number): string {
  // SI 规范里 temperature 常以 0.1 摄氏度步进的整数存储（283 = 28.3），
  // 按合理室温范围启发式区分真实值与 0.1 度整数值
  const adjusted = Math.abs(value) > 60 ? value / 10 : value;
  return `${adjusted.toFixed(1)}°C`;
}

function formatHumidity(value: number): string {
  // 湿度同样存在 0.1% 步进的整数存储（683 = 68.3%）
  const adjusted = value > 100 ? value / 10 : value;
  return `${adjusted.toFixed(0)}%`;
}

/**
 * 温湿度展示文案（如 "28.3°C 60%"）；两项都无效时返回 null。
 *
 * 卡片副标题与详情面板回读共用，避免量纲启发式两处漂移。
 */
export function formatMetricsText(temp: unknown, hum: unknown): string | null {
  const parts: string[] = [];
  if (temp !== null && temp !== undefined) {
    const n = toFiniteNumber(temp);
    if (n !== null) {
      parts.push(formatTemp(n));
    }
  }
  if (hum !== null && hum !== undefined) {
    const n = toFiniteNumber(hum);
    if (n !== null) {
      parts.push(formatHumidity(n));
    }
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

/**
 * Split MIoT service cards use parent hardware ID + service instance ID.
 *
 * Xiaomi's ha_xiaomi_home miot_cloud.py likewise separates .sN sub-devices;
 * spec RPCs address the parent DID and the corresponding SIID.
 */
export function deviceAddress(did: string): [string, number | null] {
  const match = SPLIT_DID_RE.exec(did);
  return match ? [match[1]!, Number.parseInt(match[2]!, 10)] : [did, null];
}

/**
 * Filter a flattened spec to a single split channel SIID without mutating
 * the shared spec cache.
 */
export function channelSpec(info: FlattenedSpec, did: string): FlattenedSpec {
  const [, siid] = deviceAddress(did);
  if (siid === null) {
    return info;
  }
  return {
    ...info,
    properties: (info.properties ?? []).filter((item) => item?.method?.siid === siid),
    actions: (info.actions ?? []).filter((item) => item?.method?.siid === siid),
  };
}

export class MijiaService implements IMijiaService {
  private _api: MijiaApiClient;
  private readonly _apiFactory: (options?: MijiaApiClientOptions) => MijiaApiClient;
  private readonly _specFetcher: (
    specType: string,
    options?: { cachePath?: string },
  ) => Promise<FlattenedSpec>;
  private readonly _hasCustomSpecFetcher: boolean;
  private readonly _publicSpecFetcher: (
    specType: string,
  ) => Promise<[Record<string, unknown> | null, string]>;
  private readonly _httpFetch: typeof fetch;

  private _deviceCache = new Map<string, MijiaDevice>();
  /** did -> [model, spec_type, name] 索引，自有与共享设备都在其中。 */
  private _deviceIndex = new Map<string, [string, string, string]>();
  private _panelParents: Set<string> | null = null;
  /** spec_type -> spec 内存缓存，轮询命中后不再读文件/打网络。 */
  private _specCache = new Map<string, FlattenedSpec | null>();
  /** model -> 中文名或 null（已确认无中文名，不再重查）。 */
  private _productPageNames = new Map<string, string | null>();
  /** model -> 图标 URL 或 null（拉取失败，会话内不再重试）。 */
  private _iconCache: Map<string, string | null>;
  /** 家庭名 -> 家庭 ID 映射，场景列表按家庭过滤用；懒加载缓存。 */
  private _homeIds: Map<string, string> | null = null;
  private _cameraObservations = new Map<string, Record<string, unknown>>();
  private _controlBlockReason = "";

  constructor(options?: MijiaServiceOptions) {
    this._apiFactory = options?.apiFactory ?? ((opts) => new MijiaApiClient(opts));
    this._hasCustomSpecFetcher = options?.specFetcher !== undefined;
    this._specFetcher =
      options?.specFetcher ?? ((specType, opts) => getDeviceInfo(specType, opts));
    this._httpFetch = options?.httpFetch ?? fetch;
    this._publicSpecFetcher =
      options?.publicSpecFetcher ?? ((specType) => fetchPublicSpec(specType, this._httpFetch));

    this._api = this._initApi(options);
    this._iconCache = new Map<string, string | null>(Object.entries(iconStore.loadUrls()));
  }

  // Test & introspection accessors

  get api(): MijiaApiClient {
    return this._api;
  }

  set api(value: MijiaApiClient) {
    this._api = value;
  }

  get deviceCache(): Map<string, MijiaDevice> {
    return this._deviceCache;
  }

  get deviceIndex(): Map<string, [string, string, string]> {
    return this._deviceIndex;
  }

  get specCache(): Map<string, FlattenedSpec | null> {
    return this._specCache;
  }

  get homeIds(): Map<string, string> | null {
    return this._homeIds;
  }

  set homeIds(value: Map<string, string> | null) {
    this._homeIds = value;
  }

  get panelParents(): Set<string> | null {
    return this._panelParents;
  }

  set panelParents(value: Set<string> | null) {
    this._panelParents = value;
  }

  get cameraObservations(): Map<string, Record<string, unknown>> {
    return this._cameraObservations;
  }

  setControlAccess(message = ""): void {
    this._controlBlockReason = message;
  }

  protected _requireControlAccess(): void {
    if (this._controlBlockReason) {
      throw new ServiceError(this._controlBlockReason);
    }
  }

  private _initApi(options?: MijiaServiceOptions): MijiaApiClient {
    if (options?.api) {
      return options.api;
    }
    try {
      return this._apiFactory();
    } catch (err) {
      if (err instanceof SyntaxError || err instanceof TypeError || isFsError(err)) {
        const authPath = join(homedir(), ".config", "mijia-api", "auth.json");
        const corruptPath = join(dirname(authPath), "auth.json.corrupt");
        try {
          renameSync(authPath, corruptPath);
        } catch {
          // ignore quarantine failure
        }
        console.warn("认证文件损坏已隔离为 auth.json.corrupt，请重新扫码登录:", err);
        return this._apiFactory();
      }
      throw err;
    }
  }

  static apiVersion(): string {
    return MIJIA_API_VERSION;
  }

  apiVersion(): string {
    return MijiaService.apiVersion();
  }

  // ---------- 登录 ----------

  accountId(): string {
    const uid = this._api?.authData?.["userId"];
    return uid === undefined || uid === null || uid === "" ? "" : String(uid);
  }

  async logout(): Promise<void> {
    const accountId = this.accountId();
    accountStore.activate(accountId);
    accountStore.deactivate();
    const authPath = this._api.authDataPath;
    try {
      unlinkSync(authPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        accountStore.activate(accountId);
        throw new ServiceError("退出账号失败，请检查登录文件的访问权限", { cause: err });
      }
    }
    if (typeof this._api.close === "function") {
      this._api.close();
    }
    if (this._api.authData && typeof this._api.authData === "object") {
      for (const key of Object.keys(this._api.authData)) {
        delete this._api.authData[key];
      }
    }
    this._api = this._apiFactory({ authDataPath: authPath });
    this._deviceCache.clear();
    this._deviceIndex.clear();
    this._cameraObservations.clear();
    this._panelParents = null;
    this._homeIds = null;
  }

  loginStatus(): boolean {
    try {
      return Boolean(this._api.available);
    } catch {
      return false;
    }
  }

  async qrLoginBegin(): Promise<QrLoginData | null> {
    let data: QrLoginData;
    try {
      data = await this._api.getQrLoginData();
    } catch (err) {
      throw wrapError(err, "获取登录二维码失败");
    }
    if (data?.refreshed) {
      return null;
    }
    return data;
  }

  async qrLoginWait(loginData: QrLoginData): Promise<void> {
    try {
      await this._api.completeQrLogin(loginData);
    } catch (err) {
      throw wrapError(err, "扫码登录未完成");
    }
  }

  // ---------- 设备列表 ----------

  async listDevices(progress?: ProgressCallback): Promise<DeviceInfo[]> {
    let homes: Array<Record<string, unknown>>;
    let devices: Array<Record<string, unknown>>;
    try {
      progress?.(8, "正在获取家庭信息…");
      homes = await this._api.getHomesList();
      progress?.(25, "正在读取设备列表…");
      const owned = await this._api.getDevicesList();
      progress?.(45, "正在读取共享设备…");
      const shared = await this._api.getSharedDevicesList();
      devices = [...owned, ...shared];
    } catch (err) {
      throw wrapError(err, "获取设备列表失败");
    }

    progress?.(55, "正在整理房间和设备…");
    const location = new Map<string, [string, string]>();
    for (const home of homes) {
      const homeName = String(home["name"] ?? "");
      const roomlist = Array.isArray(home["roomlist"]) ? home["roomlist"] : [];
      for (const room of roomlist) {
        if (!isRecord(room)) {
          continue;
        }
        const roomName = String(room["name"] ?? "");
        const dids = Array.isArray(room["dids"]) ? room["dids"] : [];
        for (const did of dids) {
          location.set(String(did), [homeName, roomName]);
        }
      }
    }

    const result: DeviceInfo[] = [];
    for (const d of devices) {
      const did = String(d["did"]);
      const model =
        typeof d["model"] === "string" ? d["model"] : d["model"] != null ? String(d["model"]) : "";
      const specType = typeof d["spec_type"] === "string" ? d["spec_type"] : "";
      const hasName = d["name"] !== undefined && d["name"] !== null;
      const indexName = hasName ? String(d["name"]) : "";
      const displayName = hasName ? String(d["name"]) : did;

      this._deviceIndex.set(did, [model, specType, indexName]);
      const [homeName, roomName] = location.get(did) ?? ["未知", "未知"];
      const extra = isRecord(d["extra"]) ? d["extra"] : null;
      const firmware =
        extra && typeof extra["fw_version"] === "string" ? extra["fw_version"] : "";

      result.push(
        createDeviceInfo({
          did,
          name: displayName,
          model,
          home_name: homeName,
          room_name: roomName,
          online: Boolean(d["isOnline"]),
          spec_type: specType,
          firmware,
        }),
      );
    }

    const candidates = result.filter((device) => isLight(device) || isStatusCandidate(device));
    progress?.(65, "正在识别灯光控制能力…");
    const specs =
      candidates.length > 0 ? await this.specsFor(candidates.map((device) => device.did)) : {};

    for (const device of candidates) {
      const spec = specs[device.did];
      const props: PropInfo[] = (spec?.properties ?? []).map((p) =>
        createPropInfo({
          name: p.name,
          desc: p.description ?? "",
          type: p.type ?? "",
          readable: (p.rw ?? "").includes("r"),
          writable: (p.rw ?? "").includes("w"),
          range: p.range ?? null,
          value_list: p["value-list"] ?? null,
        }),
      );
      if (isLight(device)) {
        device.light_features = Object.keys(lightControls(props));
      }
      if (spec !== null && spec !== undefined) {
        device.metric_features = props
          .filter(
            (p) =>
              p.readable &&
              (p.name === "temperature" ||
                p.name === "relative-humidity" ||
                p.name === "humidity"),
          )
          .map((p) => p.name);
      }
    }

    prepareDeviceCards(result);
    this._panelParents = new Set(
      result.filter((device) => device.switch_channels.length > 0).map((device) => device.did),
    );
    progress?.(75, "设备列表已就绪…");
    return result.sort(
      (a, b) =>
        compareStr(a.home_name, b.home_name) ||
        compareStr(a.room_name, b.room_name) ||
        compareStr(a.name, b.name),
    );
  }

  // ---------- 摄像头与诊断 ----------

  async prepareCameraSource(device: DeviceInfo): Promise<CameraSource> {
    this._requireControlAccess();
    if (!device.online) {
      throw new CameraPreviewError("摄像头当前离线，请先确认电源和网络。");
    }
    if (!this._cameraObservations.has(device.did) && this._cameraObservations.size >= 64) {
      const oldestKey = this._cameraObservations.keys().next().value;
      if (oldestKey !== undefined) {
        this._cameraObservations.delete(oldestKey);
      }
    }
    let entry = this._cameraObservations.get(device.did);
    if (!entry) {
      entry = {};
      this._cameraObservations.set(device.did, entry);
    }
    for (const field of CAMERA_PER_ATTEMPT_FIELDS) {
      delete entry[field];
    }
    const record = (fields: Record<string, unknown>): void => {
      Object.assign(entry, fields);
    };
    return buildCameraSource(
      device.did,
      device.model,
      (uri, data) => this._cameraCloudRequest(uri, data, record),
      record,
    );
  }

  recordDeviceObservation(did: string, observation: Record<string, unknown>): void {
    if (!this._cameraObservations.has(did) && this._cameraObservations.size >= 64) {
      const oldestKey = this._cameraObservations.keys().next().value;
      if (oldestKey !== undefined) {
        this._cameraObservations.delete(oldestKey);
      }
    }
    let entry = this._cameraObservations.get(did);
    if (!entry) {
      entry = {};
      this._cameraObservations.set(did, entry);
    }
    Object.assign(entry, safeObservation(observation));
  }

  async deviceDiagnosticReport(
    device: DeviceInfo,
    observation: Record<string, unknown> | null = null,
  ): Promise<string> {
    const specType = device.spec_type ?? "";
    let raw: Record<string, unknown> | null = null;
    let status = "offline_or_not_authorized";
    if (device.online && !this._controlBlockReason) {
      [raw, status] = await this._publicSpecFetcher(specType);
    }
    const cached = this._specCache.get(specType) ?? null;
    const observed: Record<string, unknown> = {
      ...(this._cameraObservations.get(device.did) ?? {}),
      ...(observation ?? {}),
    };
    return buildReport(device, {
      spec: raw,
      cachedSpec: cached as Record<string, unknown> | null,
      specStatus: status,
      region: regionFromUrl(this._api?.apiBaseUrl ?? ""),
      observation: observed,
    });
  }

  private async _cameraCloudRequest(
    uri: string,
    data: Record<string, unknown>,
    diagnostic: (fields: Record<string, unknown>) => void = () => {},
  ): Promise<Record<string, unknown>> {
    this._requireControlAccess();
    try {
      const payload = await this._api.postEncrypted(uri, data, {
        timeoutMs: 8000,
        rawResponse: true,
      });
      diagnostic({ http_status: 200 });
      if (
        !isRecord(payload) ||
        (payload["code"] !== undefined && payload["code"] !== 0) ||
        !isRecord(payload["result"])
      ) {
        const cloudCode = isRecord(payload) ? payload["code"] : undefined;
        diagnostic({ cloud_code: cloudCode });
        throw new CameraPreviewError(
          "米家暂未授权摄像头视频连接，请确认账号权限和摄像头状态后重试。",
          "CLOUD_REJECTED",
        );
      }
      diagnostic({ cloud_code: payload["code"] ?? 0 });
      return payload["result"];
    } catch (err) {
      if (err instanceof CameraPreviewError) {
        throw err;
      }
      if (err instanceof MijiaApiError && typeof err.code === "number") {
        diagnostic({ http_status: err.code });
      }
      throw new CameraPreviewError(
        "摄像头视频授权请求失败，请检查网络后重试。",
        "REQUEST_FAILED",
      );
    }
  }

  // ---------- 设备控制 ----------

  async deviceDetail(did: string): Promise<DeviceDetail> {
    const dev = await this._getDevice(did);
    const seen = new Set<DevProp>();
    const props: PropInfo[] = [];
    for (const prop of Object.values(dev.propList)) {
      if (seen.has(prop)) {
        continue;
      }
      seen.add(prop);
      props.push(
        createPropInfo({
          name: prop.name,
          desc: prop.desc || prop.name,
          type: prop.type,
          readable: prop.rw.includes("r"),
          writable: prop.rw.includes("w"),
          range: prop.range
            ? ([...prop.range] as [number, number, number] | [number, number])
            : null,
          value_list: prop.valueList ? prop.valueList.map((entry) => ({ ...entry })) : null,
        }),
      );
    }
    const actions: ActionInfo[] = Object.values(dev.actionList).map((a) => ({
      name: a.name,
      desc: a.desc || a.name,
    }));
    return {
      did,
      name: dev.name,
      model: dev.model,
      props,
      actions,
    };
  }

  async readProp(did: string, name: string): Promise<unknown> {
    this._requireControlAccess();
    const dev = await this._getDevice(did);
    try {
      return await dev.get(name);
    } catch (err) {
      throw wrapError(err, `读取属性 ${name} 失败`);
    }
  }

  async readProps(did: string, names: string[]): Promise<Record<string, unknown>> {
    this._requireControlAccess();
    const dev = await this._getDevice(did);
    const queries: Array<Record<string, unknown>> = [];
    const keyToName = new Map<string, string>();
    for (const name of names) {
      const prop = dev.propList[name];
      if (!prop || !prop.rw.includes("r")) {
        continue;
      }
      queries.push({
        siid: prop.method.siid,
        piid: prop.method.piid,
        did: dev.did,
      });
      keyToName.set(`${prop.method.siid}:${prop.method.piid}`, name);
    }

    const result: Record<string, unknown> = {};
    for (const name of keyToName.values()) {
      result[name] = null;
    }

    for (let start = 0; start < queries.length; start += BATCH_SIZE) {
      const batch = queries.slice(start, start + BATCH_SIZE);
      let rawRets: unknown;
      try {
        rawRets = await this._api.getDevicesProp(batch);
      } catch (err) {
        throw wrapError(err, "批量读取属性失败");
      }
      const rets = Array.isArray(rawRets) ? rawRets : [];
      for (const item of rets) {
        if (!isRecord(item)) {
          continue;
        }
        const key = `${item["siid"]}:${item["piid"]}`;
        const name = keyToName.get(key);
        if (name === undefined) {
          continue;
        }
        result[name] = item["code"] === 0 ? item["value"] : null;
      }
    }
    return result;
  }

  async writeProp(did: string, name: string, value: unknown): Promise<void> {
    this._requireControlAccess();
    const dev = await this._getDevice(did);
    if (this._isSplitParent(did)) {
      throw new ServiceError("面板本体仅展示信息，请操作对应灯路");
    }
    try {
      await dev.set(name, value);
    } catch (err) {
      throw wrapError(err, `设置属性 ${name} 失败`);
    }
  }

  async runAction(did: string, name: string, params?: unknown): Promise<void> {
    this._requireControlAccess();
    const dev = await this._getDevice(did);
    if (this._isSplitParent(did)) {
      throw new ServiceError("面板本体仅展示信息，请操作对应灯路");
    }
    try {
      if (params !== undefined && params !== null) {
        if (TEXT_DIRECTIVE_ACTIONS.has(name)) {
          let inVal: unknown[] = Array.isArray(params) ? [...params] : [params];
          if (name === "execute-text-directive" && inVal.length === 1) {
            inVal = [inVal[0], 0];
          }
          await dev.runAction(name, { _in: inVal });
        } else if (Array.isArray(params)) {
          await dev.runAction(name, params);
        } else {
          await dev.runAction(name, [params]);
        }
      } else {
        if (name === "execute-text-directive" || name === "play-text") {
          throw new ServiceError(`动作 ${name} 需要文本参数`);
        }
        await dev.runAction(name);
      }
    } catch (err) {
      if (err instanceof ServiceError) {
        throw err;
      }
      throw wrapError(err, `执行动作 ${name} 失败`);
    }
  }

  private async _getDevice(did: string): Promise<MijiaDevice> {
    const cached = this._deviceCache.get(did);
    if (cached) {
      return cached;
    }

    if (!this._deviceIndex.has(did)) {
      await this._refreshDeviceIndex();
    }
    const entry = this._deviceIndex.get(did);
    if (entry !== undefined && !entry[1]) {
      throw new ServiceError(
        "该设备无公开的功能规格（常见于仅蓝牙连接的产品），无法提供控制面板",
      );
    }

    let dev: MijiaDevice;
    try {
      if (deviceAddress(did)[1] !== null) {
        dev = await this._buildSharedDevice(did);
      } else if (this._hasCustomSpecFetcher) {
        dev = await this._createOwnedDeviceWithCustomSpec(did);
      } else {
        dev = await MijiaDevice.create(this._api, { did });
      }
    } catch (err) {
      if (err instanceof DeviceNotFoundError) {
        dev = await this._buildSharedDevice(did);
      } else if (err instanceof GetDeviceInfoError) {
        throw new ServiceError(
          "该设备无公开的功能规格（常见于仅蓝牙连接的产品），无法提供控制面板",
          { cause: err },
        );
      } else if (err instanceof ServiceError) {
        throw err;
      } else {
        throw wrapError(err, "加载设备信息失败");
      }
    }

    MijiaService._patchDeviceZh(dev);
    this._deviceCache.set(did, dev);
    return dev;
  }

  private async _createOwnedDeviceWithCustomSpec(did: string): Promise<MijiaDevice> {
    const devices = await this._api.getDevicesList();
    const matched = devices.find((item) => String(item["did"] ?? "") === did);
    if (!matched) {
      throw new DeviceNotFoundError(`Device not found: ${did}`);
    }
    const matchedDid = String(matched["did"] ?? did);
    const model = String(matched["model"] ?? "");
    const name = String(matched["name"] ?? matchedDid);
    const specType = String(matched["spec_type"] ?? "").trim();
    if (!specType) {
      throw new GetDeviceInfoError(`Device ${matchedDid} has no spec_type`);
    }
    const spec = await this._specFetcher(specType, {
      cachePath: dirname(this._api.authDataPath),
    });
    return MijiaDevice.fromSpec(this._api, {
      did: matchedDid,
      model,
      name: name || spec.name || matchedDid,
      spec,
      sleepTime: 0.5,
    });
  }

  private static _patchDeviceZh(dev: MijiaDevice): void {
    const seen = new Set<DevProp>();
    for (const prop of Object.values(dev.propList)) {
      if (seen.has(prop)) {
        continue;
      }
      seen.add(prop);
      prop.desc = specZh.propDescZh(prop.name, prop.desc);
    }
    for (const act of Object.values(dev.actionList)) {
      act.desc = specZh.actionDescZh(act.name, act.desc);
    }
  }

  private async _buildSharedDevice(did: string): Promise<MijiaDevice> {
    if (!this._deviceIndex.has(did)) {
      await this._refreshDeviceIndex();
    }
    const [model, specType, name] = this._deviceIndex.get(did) ?? ["", "", ""];
    if (!model) {
      throw new ServiceError(`未找到设备 ${did}`);
    }
    if (!specType) {
      throw new ServiceError(
        "该设备无公开的功能规格（常见于仅蓝牙连接的产品），无法提供控制面板",
      );
    }

    let devInfo: FlattenedSpec;
    try {
      devInfo = await this._specFetcher(specType, {
        cachePath: dirname(this._api.authDataPath),
      });
    } catch (err) {
      if (err instanceof GetDeviceInfoError) {
        throw new ServiceError(
          "该设备无公开的功能规格（常见于仅蓝牙连接的产品），无法提供控制面板",
          { cause: err },
        );
      }
      throw wrapError(err, "加载设备信息失败");
    }

    const filtered = channelSpec(devInfo, did);
    const [hardwareDid] = deviceAddress(did);
    return MijiaDevice.fromSpec(this._api, {
      did: hardwareDid,
      model,
      name: name || filtered.name || did,
      spec: filtered,
      sleepTime: 0.5,
    });
  }

  // ---------- 开关状态（卡片快速控制用） ----------

  async powerState(did: string): Promise<boolean | null> {
    const states = await this.powerStates([did]);
    return states[did] ?? null;
  }

  async togglePower(did: string): Promise<boolean> {
    const current = await this.powerState(did);
    if (current === null) {
      throw new ServiceError("设备不支持开关控制或已离线");
    }
    const newState = !current;
    await this.setPowerState(did, newState);
    return newState;
  }

  async setPowerState(did: string, state: boolean): Promise<void> {
    this._requireControlAccess();
    if (!this._deviceIndex.has(did)) {
      await this._refreshDeviceIndex();
    }
    if (!this._supportsCardPower(did)) {
      throw new ServiceError("该设备仅展示信息，不提供快捷电源控制");
    }
    const info = (await this.specsFor([did]))[did];
    const method = info ? MijiaService._findOnMethod(info) : null;
    if (method === null) {
      throw new ServiceError("设备不支持开关控制");
    }

    let rets: unknown;
    try {
      rets = await this._api.setDevicesProp([
        { did: deviceAddress(did)[0], siid: method.siid, piid: method.piid, value: state },
      ]);
    } catch (err) {
      throw wrapError(err, "设置开关状态失败");
    }

    const items = Array.isArray(rets) ? rets : [rets];
    for (const item of items) {
      if (!isRecord(item)) {
        continue;
      }
      const code = item["code"];
      if (code === 0 || code === 1) {
        continue;
      }
      const message = item["message"] ?? "未知错误";
      throw new ServiceError(`设置失败（${String(message)}，错误码 ${String(code)}）`);
    }
  }

  async powerStates(dids: string[]): Promise<Record<string, boolean | null>> {
    this._requireControlAccess();
    if (dids.some((did) => !this._deviceIndex.has(did))) {
      await this._refreshDeviceIndex();
    }
    const eligible = dids.filter((did) => this._supportsCardPower(did));
    const specMap = await this.specsFor(eligible);

    const queries: Array<Record<string, unknown>> = [];
    const result: Record<string, boolean | null> = {};
    for (const did of dids) {
      result[did] = null;
    }
    const targets = new Map<string, string[]>();

    for (const did of dids) {
      const info = specMap[did];
      const method =
        info && !this._isSplitParent(did) ? MijiaService._findOnMethod(info) : null;
      if (method === null) {
        result[did] = null;
      } else {
        const [hardware] = deviceAddress(did);
        const key = `${hardware}:${method.siid}:${method.piid}`;
        if (!targets.has(key)) {
          queries.push({ did: hardware, siid: method.siid, piid: method.piid });
          targets.set(key, []);
        }
        targets.get(key)!.push(did);
      }
    }

    for (let start = 0; start < queries.length; start += BATCH_SIZE) {
      const batch = queries.slice(start, start + BATCH_SIZE);
      let rawRets: unknown;
      try {
        rawRets = await this._api.getDevicesProp(batch);
      } catch (err) {
        throw wrapError(err, "批量读取设备状态失败");
      }
      const rets = Array.isArray(rawRets) ? rawRets : [];
      for (const item of rets) {
        if (!isRecord(item)) {
          continue;
        }
        const key = `${String(item["did"])}:${item["siid"]}:${item["piid"]}`;
        const matchedDids = targets.get(key);
        if (!matchedDids) {
          continue;
        }
        const value = item["code"] === 0 && "value" in item ? Boolean(item["value"]) : null;
        for (const did of matchedDids) {
          result[did] = value;
        }
      }
    }
    return result;
  }

  private async _fetchSpec(specType: string, cacheDir: string): Promise<FlattenedSpec | null> {
    if (!specType) {
      return null;
    }
    let info: FlattenedSpec;
    try {
      info = await this._specFetcher(specType, { cachePath: cacheDir });
    } catch (err) {
      if (err instanceof SyntaxError) {
        try {
          unlinkSync(join(cacheDir, `${specType.replaceAll(":", "_")}.json`));
        } catch (unlinkErr) {
          if ((unlinkErr as NodeJS.ErrnoException)?.code !== "ENOENT") {
            return null;
          }
        }
        try {
          info = await this._specFetcher(specType, { cachePath: cacheDir });
        } catch {
          return null;
        }
      } else {
        return null;
      }
    }
    specZh.applyFallback(info);
    return info;
  }

  private static _findOnMethod(info: FlattenedSpec): { siid: number; piid: number } | null {
    for (const prop of info.properties ?? []) {
      if (
        prop.type === "bool" &&
        (prop.rw ?? "").includes("w") &&
        (prop.name === "on" || prop.name.replaceAll("_", "-").startsWith("on-"))
      ) {
        return { siid: prop.method.siid, piid: prop.method.piid };
      }
    }
    return null;
  }

  private _isSplitParent(did: string): boolean {
    if (this._panelParents !== null) {
      return this._panelParents.has(did);
    }
    const [model, specType] = this._deviceIndex.get(did) ?? ["", "", ""];
    if (!model.includes(".switch.") && !specType.includes(":device:switch:")) {
      return false;
    }
    for (const child of this._deviceIndex.keys()) {
      if (child !== did && deviceAddress(child)[0] === did) {
        return true;
      }
    }
    return false;
  }

  private _supportsCardPower(did: string): boolean {
    if (this._isSplitParent(did)) {
      return false;
    }
    const [model, specType, name] = this._deviceIndex.get(did) ?? ["", "", ""];
    return supportsCardPower(
      createDeviceInfo({
        did,
        name,
        model,
        home_name: "",
        room_name: "",
        online: true,
        spec_type: specType,
      }),
    );
  }

  // ---------- 环境读数（卡片副标题展示用） ----------

  async readMetrics(dids: string[]): Promise<Record<string, string | null>> {
    this._requireControlAccess();
    const specMap = await this.specsFor(dids);
    const queries: Array<Record<string, unknown>> = [];
    const keyToMetric = new Map<string, [string, "temperature" | "humidity"]>();
    const result: Record<string, string | null> = {};

    for (const did of dids) {
      const info = specMap[did];
      const found = new Map<"temperature" | "humidity", { siid: number; piid: number }>();
      if (info) {
        for (const prop of info.properties ?? []) {
          const name = prop.name;
          const metric: "temperature" | "humidity" | null =
            name === "temperature"
              ? "temperature"
              : name === "relative-humidity" || name === "humidity"
                ? "humidity"
                : null;
          if (metric && (prop.rw ?? "").includes("r") && !found.has(metric)) {
            found.set(metric, { siid: prop.method.siid, piid: prop.method.piid });
          }
        }
      }
      if (found.size === 0) {
        result[did] = null;
        continue;
      }
      for (const [metric, method] of found.entries()) {
        queries.push({ did, siid: method.siid, piid: method.piid });
        keyToMetric.set(`${did}:${method.siid}:${method.piid}`, [did, metric]);
      }
    }

    const temps = new Map<string, number>();
    const hums = new Map<string, number>();
    for (let start = 0; start < queries.length; start += BATCH_SIZE) {
      const batch = queries.slice(start, start + BATCH_SIZE);
      let rawRets: unknown;
      try {
        rawRets = await this._api.getDevicesProp(batch);
      } catch {
        const empty: Record<string, string | null> = {};
        for (const did of dids) {
          empty[did] = null;
        }
        return empty;
      }
      const rets = Array.isArray(rawRets) ? rawRets : [];
      for (const item of rets) {
        if (!isRecord(item)) {
          continue;
        }
        const entry = keyToMetric.get(`${String(item["did"])}:${item["siid"]}:${item["piid"]}`);
        if (!entry || item["code"] !== 0) {
          continue;
        }
        const [did, metric] = entry;
        const value = toFiniteNumber(item["value"]);
        if (value === null) {
          continue;
        }
        if (metric === "temperature") {
          temps.set(did, value);
        } else {
          hums.set(did, value);
        }
      }
    }

    for (const did of dids) {
      result[did] = formatMetricsText(temps.get(did) ?? null, hums.get(did) ?? null);
    }
    return result;
  }

  async specsFor(dids: string[]): Promise<Record<string, FlattenedSpec | null>> {
    if (dids.some((d) => !this._deviceIndex.has(d))) {
      await this._refreshDeviceIndex();
    }

    const rawResult = new Map<string, FlattenedSpec | null>();
    const toFetchSet = new Set<string>();
    for (const did of dids) {
      const specType = this._deviceIndex.get(did)?.[1] ?? "";
      if (!specType) {
        rawResult.set(did, null);
      } else if (this._specCache.has(specType)) {
        rawResult.set(did, this._specCache.get(specType) ?? null);
      } else {
        toFetchSet.add(specType);
      }
    }

    const toFetch = [...toFetchSet];
    if (toFetch.length > 0) {
      const cacheDir = dirname(this._api.authDataPath);
      const workerCount = Math.min(SPEC_WORKERS, toFetch.length);
      let nextIndex = 0;
      const workers: Promise<void>[] = [];
      for (let i = 0; i < workerCount; i++) {
        workers.push(
          (async () => {
            while (nextIndex < toFetch.length) {
              const idx = nextIndex++;
              const specType = toFetch[idx]!;
              const spec = await this._fetchSpec(specType, cacheDir);
              this._specCache.set(specType, spec);
            }
          })(),
        );
      }
      await Promise.all(workers);

      for (const did of dids) {
        if (!rawResult.has(did)) {
          const specType = this._deviceIndex.get(did)?.[1] ?? "";
          rawResult.set(did, specType ? (this._specCache.get(specType) ?? null) : null);
        }
      }
    }

    const result: Record<string, FlattenedSpec | null> = {};
    for (const [did, info] of rawResult.entries()) {
      result[did] = info ? channelSpec(info, did) : null;
    }
    return result;
  }

  private async _refreshDeviceIndex(): Promise<void> {
    let allDevices: Array<Record<string, unknown>>;
    try {
      const owned = await this._api.getDevicesList();
      const shared = await this._api.getSharedDevicesList();
      allDevices = [...owned, ...shared];
    } catch (err) {
      throw wrapError(err, "获取设备列表失败");
    }

    const panelParents = new Set<string>();
    for (const d of allDevices) {
      const did = String(d["did"]);
      const model =
        typeof d["model"] === "string" ? d["model"] : d["model"] != null ? String(d["model"]) : "";
      const specType = typeof d["spec_type"] === "string" ? d["spec_type"] : "";
      const name = typeof d["name"] === "string" ? d["name"] : "";
      this._deviceIndex.set(did, [model, specType, name]);

      const [parentDid, siid] = deviceAddress(did);
      if (
        siid !== null &&
        (model.includes(".switch.") || specType.includes(":device:switch:"))
      ) {
        panelParents.add(parentDid);
      }
    }
    this._panelParents = panelParents;
  }

  // ---------- 场景（手动控制） ----------

  private async _homeIdsMap(): Promise<Map<string, string>> {
    if (this._homeIds === null) {
      let homes: Array<Record<string, unknown>>;
      try {
        homes = await this._api.getHomesList();
      } catch (err) {
        throw wrapError(err, "获取家庭列表失败");
      }
      const map = new Map<string, string>();
      for (const h of homes) {
        map.set(String(h["name"] ?? ""), String(h["id"] ?? ""));
      }
      this._homeIds = map;
    }
    return this._homeIds;
  }

  async sceneList(homeName?: string | null): Promise<SceneInfo[]> {
    let homeId: string | null = null;
    if (homeName !== undefined && homeName !== null) {
      const homeIds = await this._homeIdsMap();
      const matched = homeIds.get(homeName);
      if (matched === undefined) {
        return [];
      }
      homeId = matched;
    }

    let scenes: Array<Record<string, unknown>>;
    try {
      scenes = await this._api.getScenesList(homeId);
    } catch (err) {
      throw wrapError(err, "获取场景列表失败");
    }

    const homeIds = await this._homeIdsMap();
    const idToName = new Map<string, string>();
    for (const [k, v] of homeIds.entries()) {
      idToName.set(v, k);
    }

    return scenes.map((s) => {
      const resolvedHomeId = String(s["home_id"] || homeId || "");
      return createSceneInfo({
        scene_id: String(s["scene_id"] || ""),
        name: String(s["name"] || "未命名场景"),
        home_id: resolvedHomeId,
        home_name: idToName.get(resolvedHomeId) ?? "",
      });
    });
  }

  async runScene(scene: SceneInfo): Promise<void> {
    this._requireControlAccess();
    let ok: boolean;
    try {
      ok = await this._api.runScene(scene.scene_id, scene.home_id);
    } catch (err) {
      throw wrapError(err, `执行场景「${scene.name}」失败`);
    }
    if (!ok) {
      throw new ServiceError(`执行场景「${scene.name}」失败`);
    }
  }

  // ---------- 设备图标 ----------

  async iconUrls(models: string[]): Promise<Record<string, string | null>> {
    if (models.length === 0) {
      return {};
    }
    const missing = models.filter((m) => !this._iconCache.has(m));
    if (missing.length > 0) {
      for (const model of missing) {
        if (!this._iconCache.has(model)) {
          this._iconCache.set(model, await this._fetchIconUrl(model));
        }
      }
      const toSave: Record<string, string> = {};
      for (const [k, v] of this._iconCache.entries()) {
        if (v) {
          toSave[k] = v;
        }
      }
      iconStore.saveUrls(toSave);
    }

    const result: Record<string, string | null> = {};
    for (const m of models) {
      const url = this._iconCache.get(m);
      if (url) {
        result[m] = url;
      }
    }
    return result;
  }

  private async _fetchIconUrl(model: string): Promise<string | null> {
    try {
      return await this._api.fetchIconRedirect(model);
    } catch (err) {
      console.warn(`获取设备图标失败 ${model}:`, err);
      return null;
    }
  }

  async iconFile(model: string, url: string): Promise<string | null> {
    const filePath = iconStore.iconPath(model);
    if (existsSync(filePath)) {
      return filePath;
    }
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 6000);
      (timer as { unref?: () => void }).unref?.();
      let res: Response;
      try {
        res = await this._httpFetch(url, { signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
      if (res.status !== 200) {
        console.warn(`下载设备图标失败 ${model}: HTTP ${res.status}`);
        return null;
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.byteLength === 0) {
        console.warn(`下载设备图标失败 ${model}: HTTP ${res.status}`);
        return null;
      }
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, bytes);
      return filePath;
    } catch (err) {
      console.warn(`下载设备图标失败 ${model}:`, err);
      return null;
    }
  }

  // ---------- 产品名与规格查询 ----------

  hasProductPageName(model: string): boolean {
    return this._productPageNames.has(model);
  }

  cachedProductPageNames(models: string[]): Record<string, string> {
    const result: Record<string, string> = {};
    for (const model of models) {
      const name = this._productPageNames.get(model);
      if (name && hasCjk(name)) {
        result[model] = name;
      }
    }
    return result;
  }

  async productPageName(model: string): Promise<string | null> {
    if (this._productPageNames.has(model)) {
      return this._productPageNames.get(model) ?? null;
    }
    let name: string | null = null;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      (timer as { unref?: () => void }).unref?.();
      let res: Response;
      try {
        res = await this._httpFetch(`https://home.miot-spec.com/p/${model}`, {
          headers: { "User-Agent": "Mozilla/5.0" },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (res.status === 200) {
        const text = await res.text();
        const match = PRODUCT_PAGE_SCRIPT_RE.exec(text);
        if (match && match[1]) {
          const parsed: unknown = JSON.parse(match[1]);
          const props = isRecord(parsed) && isRecord(parsed["props"]) ? parsed["props"] : null;
          const product = props && isRecord(props["product"]) ? props["product"] : null;
          const rawName = product && typeof product["name"] === "string" ? product["name"] : null;
          name = rawName || null;
          if (name !== null && !hasCjk(name)) {
            name = null;
          }
        }
      }
    } catch (err) {
      console.warn(`产品页名称查询失败 ${model}:`, err);
    }
    this._productPageNames.set(model, name);
    return name;
  }

  specHasPublishedFunctions(specType: string): boolean | null {
    if (!specType) {
      return false;
    }
    if (!this._specCache.has(specType)) {
      return null;
    }
    const spec = this._specCache.get(specType);
    return Boolean(spec && Array.isArray(spec.properties) && spec.properties.length > 0);
  }

  localizedProductNames(dids: string[], names: Record<string, string>): Record<string, string> {
    const result: Record<string, string> = {};
    for (const did of dids) {
      const name = names[did] ?? "";
      if (!name || hasCjk(name)) {
        continue;
      }
      const specType = this._deviceIndex.get(did)?.[1] ?? "";
      const spec = specType ? this._specCache.get(specType) : null;
      if (!spec) {
        continue;
      }
      const specName = String(spec.name || "");
      if (specName && hasCjk(specName) && specName !== name) {
        result[did] = specName;
      }
    }
    return result;
  }
}
