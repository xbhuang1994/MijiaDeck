// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * Local-only virtual services. No login, cloud, hardware, or persistent auth data.
 *
 * - `VirtualLightService`: exact 1:1 port of `tools/test_light_controls.py` for isolated light testing.
 * - `VirtualDemoService`: interactive multi-device showcase for `bun run demo`.
 */

import { MIJIA_API_VERSION } from "../mijia/index.ts";
import { CameraSource, generateX25519KeyPair } from "./cameraAccess.ts";
import { CameraPreviewError } from "./cameraPreview.ts";
import type { IMijiaService, ProgressCallback, QrLoginData } from "./contracts.ts";
import { prepareDeviceCards, supportsCardPower } from "./deviceControls.ts";
import { buildReport, safeObservation } from "./diagnostics.ts";
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
import { ServiceError, formatMetricsText } from "./service.ts";

export const DEMO_DID = "local-virtual-color-light";

export const DEMO_PROPS: PropInfo[] = [
  createPropInfo({
    name: "on",
    desc: "开关",
    type: "bool",
    readable: true,
    writable: true,
  }),
  createPropInfo({
    name: "brightness",
    desc: "亮度",
    type: "uint",
    readable: true,
    writable: true,
    range: [1, 100, 1],
  }),
  createPropInfo({
    name: "color-temperature",
    desc: "色温",
    type: "uint",
    readable: true,
    writable: true,
    range: [2700, 6500, 1],
  }),
  createPropInfo({
    name: "color",
    desc: "颜色",
    type: "uint",
    readable: true,
    writable: true,
    range: [0, 0xffffff, 1],
  }),
];

function cloneProp(prop: PropInfo): PropInfo {
  return createPropInfo({
    name: prop.name,
    desc: prop.desc,
    type: prop.type,
    readable: prop.readable,
    writable: prop.writable,
    range: prop.range
      ? ([...prop.range] as [number, number, number] | [number, number])
      : null,
    value_list: prop.value_list ? prop.value_list.map((v) => ({ ...v })) : null,
  });
}

function compareStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Isolated single-light test service.
 * Deliberately does NOT construct MijiaApiClient or expose an `_api`/`api` property.
 */
export class VirtualLightService implements IMijiaService {
  values: Record<string, unknown>;
  device: DeviceInfo;

  private _controlBlockReason = "";
  private _observations = new Map<string, Record<string, unknown>>();

  constructor() {
    // Deliberately do not construct MijiaApiClient or read authentication files.
    this.values = {
      on: true,
      brightness: 65,
      "color-temperature": 4000,
      color: 0xffb86c,
    };
    this.device = createDeviceInfo({
      did: DEMO_DID,
      name: "虚拟调光调色灯",
      model: "local.light.demo",
      home_name: "本地测试",
      room_name: "测试房间",
      online: true,
      light_features: ["brightness", "temperature", "color"],
    });
  }

  setControlAccess(message = ""): void {
    this._controlBlockReason = message;
  }

  private _requireControlAccess(): void {
    if (this._controlBlockReason) {
      throw new ServiceError(this._controlBlockReason);
    }
  }

  private _check(did: string): void {
    this._requireControlAccess();
    if (did !== DEMO_DID) {
      throw new ServiceError("本地测试只允许操作虚拟灯");
    }
  }

  apiVersion(): string {
    return MIJIA_API_VERSION;
  }

  accountId(): string {
    return "local-virtual-light-test";
  }

  loginStatus(): boolean {
    return true;
  }

  async logout(): Promise<void> {
    throw new ServiceError("这是免登录的虚拟测试，请直接退出测试程序");
  }

  async qrLoginBegin(): Promise<QrLoginData | null> {
    return null;
  }

  async qrLoginWait(_loginData: QrLoginData): Promise<void> {
    // No-op in local virtual light mode.
  }

  async listDevices(progress?: ProgressCallback): Promise<DeviceInfo[]> {
    progress?.(65, "正在准备虚拟灯光设备…");
    return [createDeviceInfo(this.device)];
  }

  async deviceDetail(did: string): Promise<DeviceDetail> {
    this._check(did);
    return {
      did,
      name: this.device.name,
      model: this.device.model,
      props: DEMO_PROPS.map(cloneProp),
      actions: [],
    };
  }

  async readProp(did: string, name: string): Promise<unknown> {
    this._check(did);
    if (!(name in this.values)) {
      throw new ServiceError(`读取属性 ${name} 失败`);
    }
    return this.values[name];
  }

  async readProps(did: string, names: string[]): Promise<Record<string, unknown>> {
    this._check(did);
    const result: Record<string, unknown> = {};
    for (const name of names) {
      result[name] = name in this.values ? this.values[name] : null;
    }
    return result;
  }

  async writeProp(did: string, name: string, value: unknown): Promise<void> {
    this._check(did);
    const prop = DEMO_PROPS.find((p) => p.name === name);
    if (
      !prop ||
      (prop.range &&
        (typeof value !== "number" ||
          !Number.isFinite(value) ||
          value < prop.range[0] ||
          value > prop.range[1]))
    ) {
      throw new ServiceError("无效的虚拟灯参数");
    }
    this.values[name] = prop.type === "bool" ? Boolean(value) : value;
  }

  async runAction(did: string, name: string, _params?: unknown): Promise<void> {
    this._check(did);
    throw new ServiceError(`执行动作 ${name} 失败: 虚拟灯不支持该动作`);
  }

  async powerState(did: string): Promise<boolean | null> {
    const states = await this.powerStates([did]);
    return states[did] ?? null;
  }

  async togglePower(did: string): Promise<boolean> {
    const current = await this.powerState(did);
    if (current === null) {
      throw new ServiceError("设备不支持开关控制或已离线");
    }
    const next = !current;
    await this.setPowerState(did, next);
    return next;
  }

  async setPowerState(did: string, state: boolean): Promise<void> {
    this._check(did);
    this.values["on"] = Boolean(state);
  }

  async powerStates(dids: string[]): Promise<Record<string, boolean | null>> {
    const result: Record<string, boolean | null> = {};
    for (const did of dids) {
      this._check(did);
      result[did] = Boolean(this.values["on"]);
    }
    return result;
  }

  async readMetrics(dids: string[]): Promise<Record<string, string | null>> {
    const result: Record<string, string | null> = {};
    for (const did of dids) {
      result[did] = null;
    }
    return result;
  }

  async sceneList(_homeName?: string | null): Promise<SceneInfo[]> {
    return [];
  }

  async runScene(scene: SceneInfo): Promise<void> {
    this._requireControlAccess();
    throw new ServiceError(`执行场景「${scene.name}」失败`);
  }

  async iconUrls(_models: string[]): Promise<Record<string, string | null>> {
    return {};
  }

  async iconFile(_model: string, _url: string): Promise<string | null> {
    return null;
  }

  hasProductPageName(_model: string): boolean {
    return false;
  }

  cachedProductPageNames(_models: string[]): Record<string, string> {
    return {};
  }

  async productPageName(_model: string): Promise<string | null> {
    return null;
  }

  specHasPublishedFunctions(specType: string): boolean | null {
    return specType ? true : false;
  }

  localizedProductNames(
    _dids: string[],
    _names: Record<string, string>,
  ): Record<string, string> {
    return {};
  }

  async prepareCameraSource(device: DeviceInfo): Promise<CameraSource> {
    this._check(device.did);
    throw new CameraPreviewError(
      "当前远程预览仅支持 CS2 摄像头，该设备的视频传输方式暂未接入。",
      "VENDOR_UNSUPPORTED",
    );
  }

  recordDeviceObservation(did: string, observation: Record<string, unknown>): void {
    const entry = this._observations.get(did) ?? {};
    Object.assign(entry, safeObservation(observation));
    this._observations.set(did, entry);
  }

  async deviceDiagnosticReport(
    device: DeviceInfo,
    observation: Record<string, unknown> | null = null,
  ): Promise<string> {
    const observed: Record<string, unknown> = {
      ...(this._observations.get(device.did) ?? {}),
      ...(observation ?? {}),
    };
    return buildReport(device, {
      specStatus: "offline_or_not_authorized",
      region: "unknown",
      observation: observed,
    });
  }
}

interface DemoDeviceState {
  device: DeviceInfo;
  props: PropInfo[];
  actions: ActionInfo[];
  values: Record<string, unknown>;
  powerProp?: string;
}

const DEMO_HOME_ID = "demo-home-1";
const DEMO_HOME_NAME = "示例之家";

/**
 * Interactive local demo service for `bun run demo`.
 * Includes living room light, 3-channel split switch panel + channels,
 * temperature/humidity sensor, XiaoAI speaker, CS2 demo camera, router,
 * and 2 manual scenes — zero real account or network access required.
 */
export class VirtualDemoService implements IMijiaService {
  private readonly _entries = new Map<string, DemoDeviceState>();
  private readonly _scenes: SceneInfo[];
  private readonly _observations = new Map<string, Record<string, unknown>>();
  private _controlBlockReason = "";
  lastDirective = "";

  constructor() {
    const livingLight = createDeviceInfo({
      did: "demo-light-living",
      name: "客厅吸顶灯",
      model: "yeelink.light.ceiling1",
      home_name: DEMO_HOME_NAME,
      room_name: "客厅",
      online: true,
      spec_type: "urn:miot-spec-v2:device:light:0000A001:yeelink-ceiling1:1",
      light_features: ["brightness", "temperature", "color"],
      metric_features: [],
      firmware: "2.1.4_0032",
    });

    const switchParent = createDeviceInfo({
      did: "demo-switch-bar",
      name: "吧台",
      model: "xiaomi.switch.w3",
      home_name: DEMO_HOME_NAME,
      room_name: "餐厅",
      online: true,
      spec_type: "urn:miot-spec-v2:device:switch:0000A003:xiaomi-w3:1",
      metric_features: ["temperature"],
      firmware: "1.0.8_0015",
    });

    const switchS2 = createDeviceInfo({
      did: "demo-switch-bar.s2",
      name: "餐厅主灯",
      model: "xiaomi.switch.w3",
      home_name: DEMO_HOME_NAME,
      room_name: "餐厅",
      online: true,
      spec_type: "urn:miot-spec-v2:device:switch:0000A003:xiaomi-w3:1",
      metric_features: [],
      firmware: "1.0.8_0015",
    });

    const switchS3 = createDeviceInfo({
      did: "demo-switch-bar.s3",
      name: "吧台射灯",
      model: "xiaomi.switch.w3",
      home_name: DEMO_HOME_NAME,
      room_name: "餐厅",
      online: true,
      spec_type: "urn:miot-spec-v2:device:switch:0000A003:xiaomi-w3:1",
      metric_features: [],
      firmware: "1.0.8_0015",
    });

    const switchS4 = createDeviceInfo({
      did: "demo-switch-bar.s4",
      name: "餐边灯带",
      model: "xiaomi.switch.w3",
      home_name: DEMO_HOME_NAME,
      room_name: "餐厅",
      online: true,
      spec_type: "urn:miot-spec-v2:device:switch:0000A003:xiaomi-w3:1",
      metric_features: [],
      firmware: "1.0.8_0015",
    });

    const sensorHt = createDeviceInfo({
      did: "demo-sensor-ht",
      name: "卧室米家温湿度计",
      model: "miaomiaoce.sensor_ht.t2",
      home_name: DEMO_HOME_NAME,
      room_name: "卧室",
      online: true,
      spec_type: "urn:miot-spec-v2:device:temperature-humidity-sensor:0000A00A:miaomiaoce-t2:1",
      metric_features: ["temperature", "relative-humidity"],
      firmware: "1.0.0_0109",
    });

    const speaker = createDeviceInfo({
      did: "demo-speaker-xiaoai",
      name: "小爱音箱 Pro",
      model: "xiaomi.wifispeaker.lx06",
      home_name: DEMO_HOME_NAME,
      room_name: "客厅",
      online: true,
      spec_type: "urn:miot-spec-v2:device:speaker:0000A015:xiaomi-lx06:1",
      metric_features: [],
      firmware: "1.82.10",
    });

    const camera = createDeviceInfo({
      did: "demo-camera-cs2",
      name: "阳台智能摄像机",
      model: "chuangmi.camera.029a02",
      home_name: DEMO_HOME_NAME,
      room_name: "阳台",
      online: true,
      spec_type: "urn:miot-spec-v2:device:camera:0000A01C:chuangmi-029a02:1",
      metric_features: [],
      firmware: "4.3.2_0210",
    });

    const router = createDeviceInfo({
      did: "demo-router-be6500",
      name: "小米路由器 BE6500",
      model: "xiaomi.router.rd15",
      home_name: DEMO_HOME_NAME,
      room_name: "书房",
      online: true,
      spec_type: "urn:miot-spec-v2:device:router:0000A036:xiaomi-rd15:1",
      metric_features: [],
      firmware: "1.0.72",
    });

    const allDevices = [
      livingLight,
      switchParent,
      switchS2,
      switchS3,
      switchS4,
      sensorHt,
      speaker,
      camera,
      router,
    ];
    prepareDeviceCards(allDevices);

    this._entries.set(livingLight.did, {
      device: livingLight,
      props: DEMO_PROPS.map(cloneProp),
      actions: [],
      values: {
        on: true,
        brightness: 72,
        "color-temperature": 4200,
        color: 0xffb86c,
      },
      powerProp: "on",
    });

    this._entries.set(switchParent.did, {
      device: switchParent,
      props: [
        createPropInfo({
          name: "temperature",
          desc: "温度",
          type: "float",
          readable: true,
          writable: false,
        }),
      ],
      actions: [],
      values: { temperature: 28.5 },
    });

    this._entries.set(switchS2.did, {
      device: switchS2,
      props: [
        createPropInfo({
          name: "on-2",
          desc: "开关",
          type: "bool",
          readable: true,
          writable: true,
        }),
      ],
      actions: [{ name: "toggle-2", desc: "切换" }],
      values: { "on-2": true },
      powerProp: "on-2",
    });

    this._entries.set(switchS3.did, {
      device: switchS3,
      props: [
        createPropInfo({
          name: "on-3",
          desc: "开关",
          type: "bool",
          readable: true,
          writable: true,
        }),
      ],
      actions: [{ name: "toggle-3", desc: "切换" }],
      values: { "on-3": false },
      powerProp: "on-3",
    });

    this._entries.set(switchS4.did, {
      device: switchS4,
      props: [
        createPropInfo({
          name: "on-4",
          desc: "开关",
          type: "bool",
          readable: true,
          writable: true,
        }),
      ],
      actions: [{ name: "toggle-4", desc: "切换" }],
      values: { "on-4": true },
      powerProp: "on-4",
    });

    this._entries.set(sensorHt.did, {
      device: sensorHt,
      props: [
        createPropInfo({
          name: "temperature",
          desc: "温度",
          type: "float",
          readable: true,
          writable: false,
        }),
        createPropInfo({
          name: "relative-humidity",
          desc: "湿度",
          type: "float",
          readable: true,
          writable: false,
        }),
        createPropInfo({
          name: "battery-level",
          desc: "电池电量",
          type: "uint",
          readable: true,
          writable: false,
          range: [0, 100, 1],
        }),
      ],
      actions: [],
      values: {
        temperature: 23.6,
        "relative-humidity": 54,
        "battery-level": 92,
      },
    });

    this._entries.set(speaker.did, {
      device: speaker,
      props: [
        createPropInfo({
          name: "volume",
          desc: "音量",
          type: "uint",
          readable: true,
          writable: true,
          range: [0, 100, 1],
        }),
        createPropInfo({
          name: "mute",
          desc: "静音",
          type: "bool",
          readable: true,
          writable: true,
        }),
        createPropInfo({
          name: "playing-state",
          desc: "播放状态",
          type: "uint",
          readable: true,
          writable: false,
          value_list: [
            { value: 0, description: "Idle", desc_zh_cn: "空闲" },
            { value: 1, description: "Playing", desc_zh_cn: "播放中" },
            { value: 2, description: "Paused", desc_zh_cn: "已暂停" },
          ],
        }),
      ],
      actions: [
        { name: "play", desc: "播放" },
        { name: "pause", desc: "暂停" },
        { name: "next", desc: "下一首" },
        { name: "previous", desc: "上一首" },
        { name: "play-text", desc: "朗读文本" },
        { name: "execute-text-directive", desc: "执行文本指令" },
      ],
      values: {
        volume: 45,
        mute: false,
        "playing-state": 1,
      },
    });

    this._entries.set(camera.did, {
      device: camera,
      props: [
        createPropInfo({
          name: "on",
          desc: "开关",
          type: "bool",
          readable: true,
          writable: true,
        }),
      ],
      actions: [],
      values: { on: true },
    });

    this._entries.set(router.did, {
      device: router,
      props: [
        createPropInfo({
          name: "connected-device-number",
          desc: "连接设备数",
          type: "uint",
          readable: true,
          writable: false,
        }),
        createPropInfo({
          name: "download-speed",
          desc: "下载速度",
          type: "uint",
          readable: true,
          writable: false,
        }),
      ],
      actions: [],
      values: {
        "connected-device-number": 14,
        "download-speed": 12480,
      },
    });

    this._scenes = [
      createSceneInfo({
        scene_id: "demo-scene-home",
        name: "回家模式",
        home_id: DEMO_HOME_ID,
        home_name: DEMO_HOME_NAME,
      }),
      createSceneInfo({
        scene_id: "demo-scene-sleep",
        name: "晚安模式",
        home_id: DEMO_HOME_ID,
        home_name: DEMO_HOME_NAME,
      }),
    ];
  }

  setControlAccess(message = ""): void {
    this._controlBlockReason = message;
  }

  private _requireControlAccess(): void {
    if (this._controlBlockReason) {
      throw new ServiceError(this._controlBlockReason);
    }
  }

  private _getEntry(did: string): DemoDeviceState {
    const entry = this._entries.get(did);
    if (!entry) {
      throw new ServiceError(`未找到设备 ${did}`);
    }
    return entry;
  }

  private _findProp(entry: DemoDeviceState, name: string): PropInfo | undefined {
    const normalized = name.replaceAll("_", "-");
    return entry.props.find((p) => p.name === name || p.name === normalized);
  }

  apiVersion(): string {
    return MIJIA_API_VERSION;
  }

  accountId(): string {
    return "local-demo-account";
  }

  loginStatus(): boolean {
    return true;
  }

  async logout(): Promise<void> {
    throw new ServiceError("这是免登录的本地演示模式，请直接退出程序");
  }

  async qrLoginBegin(): Promise<QrLoginData | null> {
    return null;
  }

  async qrLoginWait(_loginData: QrLoginData): Promise<void> {
    // No-op in local demo mode.
  }

  async listDevices(progress?: ProgressCallback): Promise<DeviceInfo[]> {
    progress?.(8, "正在获取家庭信息…");
    progress?.(45, "正在读取示例设备…");
    progress?.(65, "正在识别灯光控制能力…");
    const list = [...this._entries.values()]
      .map((entry) => createDeviceInfo(entry.device))
      .sort(
        (a, b) =>
          compareStr(a.home_name, b.home_name) ||
          compareStr(a.room_name, b.room_name) ||
          compareStr(a.name, b.name),
      );
    progress?.(75, "设备列表已就绪…");
    return list;
  }

  async deviceDetail(did: string): Promise<DeviceDetail> {
    const entry = this._getEntry(did);
    return {
      did,
      name: entry.device.name,
      model: entry.device.model,
      props: entry.props.map(cloneProp),
      actions: entry.actions.map((a) => ({ ...a })),
    };
  }

  async readProp(did: string, name: string): Promise<unknown> {
    this._requireControlAccess();
    const entry = this._getEntry(did);
    const prop = this._findProp(entry, name);
    if (!prop || !prop.readable) {
      throw new ServiceError(`读取属性 ${name} 失败`);
    }
    return entry.values[prop.name];
  }

  async readProps(did: string, names: string[]): Promise<Record<string, unknown>> {
    this._requireControlAccess();
    const entry = this._getEntry(did);
    const result: Record<string, unknown> = {};
    for (const name of names) {
      const prop = this._findProp(entry, name);
      if (!prop || !prop.readable) {
        continue;
      }
      result[name] = prop.name in entry.values ? entry.values[prop.name] : null;
    }
    return result;
  }

  async writeProp(did: string, name: string, value: unknown): Promise<void> {
    this._requireControlAccess();
    const entry = this._getEntry(did);
    if (entry.device.switch_channels.length > 0) {
      throw new ServiceError("面板本体仅展示信息，请操作对应灯路");
    }
    const prop = this._findProp(entry, name);
    if (!prop || !prop.writable) {
      throw new ServiceError(`设置属性 ${name} 失败`);
    }
    if (
      prop.range &&
      (typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < prop.range[0] ||
        value > prop.range[1])
    ) {
      throw new ServiceError(`设置属性 ${name} 失败: 参数超出范围`);
    }
    entry.values[prop.name] = prop.type === "bool" ? Boolean(value) : value;
  }

  async runAction(did: string, name: string, params?: unknown): Promise<void> {
    this._requireControlAccess();
    const entry = this._getEntry(did);
    if (entry.device.switch_channels.length > 0) {
      throw new ServiceError("面板本体仅展示信息，请操作对应灯路");
    }
    const action = entry.actions.find(
      (a) => a.name === name || a.name === name.replaceAll("_", "-"),
    );
    if (!action) {
      throw new ServiceError(`执行动作 ${name} 失败: 未找到动作`);
    }
    if (action.name === "execute-text-directive" || action.name === "play-text") {
      const text = Array.isArray(params) ? params[0] : params;
      if (text === undefined || text === null || String(text).trim() === "") {
        throw new ServiceError(`动作 ${action.name} 需要文本参数`);
      }
      this.lastDirective = String(text);
      return;
    }
    if (action.name === "play") {
      entry.values["playing-state"] = 1;
      return;
    }
    if (action.name === "pause") {
      entry.values["playing-state"] = 2;
      return;
    }
    if (action.name.startsWith("toggle-") && entry.powerProp) {
      entry.values[entry.powerProp] = !Boolean(entry.values[entry.powerProp]);
    }
  }

  async powerState(did: string): Promise<boolean | null> {
    const states = await this.powerStates([did]);
    return states[did] ?? null;
  }

  async togglePower(did: string): Promise<boolean> {
    const current = await this.powerState(did);
    if (current === null) {
      throw new ServiceError("设备不支持开关控制或已离线");
    }
    const next = !current;
    await this.setPowerState(did, next);
    return next;
  }

  async setPowerState(did: string, state: boolean): Promise<void> {
    this._requireControlAccess();
    const entry = this._getEntry(did);
    if (!supportsCardPower(entry.device)) {
      throw new ServiceError("该设备仅展示信息，不提供快捷电源控制");
    }
    if (!entry.powerProp) {
      throw new ServiceError("设备不支持开关控制");
    }
    entry.values[entry.powerProp] = Boolean(state);
  }

  async powerStates(dids: string[]): Promise<Record<string, boolean | null>> {
    this._requireControlAccess();
    const result: Record<string, boolean | null> = {};
    for (const did of dids) {
      const entry = this._entries.get(did);
      if (!entry || !supportsCardPower(entry.device) || !entry.powerProp) {
        result[did] = null;
      } else {
        result[did] = Boolean(entry.values[entry.powerProp]);
      }
    }
    return result;
  }

  async readMetrics(dids: string[]): Promise<Record<string, string | null>> {
    this._requireControlAccess();
    const result: Record<string, string | null> = {};
    for (const did of dids) {
      const entry = this._entries.get(did);
      if (!entry) {
        result[did] = null;
        continue;
      }
      const temp = "temperature" in entry.values ? entry.values["temperature"] : null;
      const hum =
        "relative-humidity" in entry.values
          ? entry.values["relative-humidity"]
          : "humidity" in entry.values
            ? entry.values["humidity"]
            : null;
      result[did] = formatMetricsText(temp, hum);
    }
    return result;
  }

  async sceneList(homeName?: string | null): Promise<SceneInfo[]> {
    if (homeName !== undefined && homeName !== null && homeName !== DEMO_HOME_NAME) {
      return [];
    }
    return this._scenes.map((scene) => createSceneInfo(scene));
  }

  async runScene(scene: SceneInfo): Promise<void> {
    this._requireControlAccess();
    if (scene.scene_id === "demo-scene-home") {
      const light = this._entries.get("demo-light-living");
      if (light) {
        light.values["on"] = true;
        light.values["brightness"] = 80;
        light.values["color-temperature"] = 4500;
      }
      const s2 = this._entries.get("demo-switch-bar.s2");
      if (s2) {
        s2.values["on-2"] = true;
      }
      return;
    }
    if (scene.scene_id === "demo-scene-sleep") {
      const light = this._entries.get("demo-light-living");
      if (light) {
        light.values["on"] = false;
      }
      for (const [did, prop] of [
        ["demo-switch-bar.s2", "on-2"],
        ["demo-switch-bar.s3", "on-3"],
        ["demo-switch-bar.s4", "on-4"],
      ] as const) {
        const channel = this._entries.get(did);
        if (channel) {
          channel.values[prop] = false;
        }
      }
      return;
    }
    throw new ServiceError(`执行场景「${scene.name}」失败`);
  }

  async iconUrls(_models: string[]): Promise<Record<string, string | null>> {
    return {};
  }

  async iconFile(_model: string, _url: string): Promise<string | null> {
    return null;
  }

  hasProductPageName(_model: string): boolean {
    return false;
  }

  cachedProductPageNames(_models: string[]): Record<string, string> {
    return {};
  }

  async productPageName(_model: string): Promise<string | null> {
    return null;
  }

  specHasPublishedFunctions(specType: string): boolean | null {
    return specType ? true : false;
  }

  localizedProductNames(
    _dids: string[],
    _names: Record<string, string>,
  ): Record<string, string> {
    return {};
  }

  async prepareCameraSource(device: DeviceInfo): Promise<CameraSource> {
    this._requireControlAccess();
    if (!device.online) {
      throw new CameraPreviewError("摄像头当前离线，请先确认电源和网络。");
    }
    if (device.did !== "demo-camera-cs2") {
      throw new CameraPreviewError(
        "当前远程预览仅支持 CS2 摄像头，该设备的视频传输方式暂未接入。",
        "VENDOR_UNSUPPORTED",
      );
    }
    const { publicHex, privateHex } = generateX25519KeyPair();
    this.recordDeviceObservation(device.did, {
      attempted: true,
      stage: "authorization",
      error_code: "NONE",
      vendor_id: 4,
      protocol: "CS2",
      http_status: 200,
      cloud_code: 0,
      authorization_fields_present: {
        p2p_id: true,
        init_string: true,
        public_key: true,
        sign: true,
      },
    });
    // "A" decodes to an empty rendezvous list so demo mode never contacts external servers.
    return new CameraSource(
      "DEMO-CS2-CAMERA-0001",
      "A",
      publicHex,
      privateHex,
      "ab".repeat(32),
      "demo-ephemeral-sign",
    );
  }

  recordDeviceObservation(did: string, observation: Record<string, unknown>): void {
    const entry = this._observations.get(did) ?? {};
    Object.assign(entry, safeObservation(observation));
    this._observations.set(did, entry);
  }

  async deviceDiagnosticReport(
    device: DeviceInfo,
    observation: Record<string, unknown> | null = null,
  ): Promise<string> {
    const entry = this._entries.get(device.did);
    const cachedSpec = entry
      ? {
          properties: entry.props.map((p, idx) => ({
            name: p.name,
            type: p.type,
            rw: `${p.readable ? "r" : ""}${p.writable ? "w" : ""}`,
            range: p.range,
            method: { siid: 2, piid: idx + 1 },
          })),
          actions: entry.actions.map((a, idx) => ({
            name: a.name,
            method: { siid: 2, aiid: idx + 1 },
          })),
        }
      : null;
    const observed: Record<string, unknown> = {
      ...(this._observations.get(device.did) ?? {}),
      ...(observation ?? {}),
    };
    return buildReport(device, {
      cachedSpec,
      specStatus: "offline_or_not_authorized",
      region: "unknown",
      observation: observed,
    });
  }
}
