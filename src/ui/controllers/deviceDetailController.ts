// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * 通用设备详情状态机控制器（无界面依赖，便于单元测试与桌面控制器复用）。
 */

import { TypedEmitter, type IJobExecutor, type IMijiaService } from "../../core/contracts.ts";
import {
  actionRequiresConfirmation,
  choosePropertyWidget,
  classifyDeviceProps,
  coercePropWriteValue,
  deviceCategoryLabel,
  formatPropertyValue,
  friendlyLabel,
  groupPropsByService,
  percentageProgressFor,
  resolveEnumLabel,
  type ClassifiedDeviceProps,
  type DeviceChannelState,
  type PropertyGroup,
  type PropertyWidgetKind,
} from "../../core/deviceDetailModel.ts";
import {
  isSpeaker,
  type ActionInfo,
  type DeviceDetail,
  type DeviceInfo,
  type PropInfo,
} from "../../core/models.ts";
import { isSensitivePropertyName } from "../../core/specZh.ts";

export {
  actionRequiresConfirmation,
  choosePropertyWidget,
  classifyDeviceProps,
  coercePropWriteValue,
  deviceCategoryLabel,
  formatPropertyValue,
  friendlyLabel,
  groupPropsByService,
  percentageProgressFor,
  resolveEnumLabel,
  type ClassifiedDeviceProps,
  type DeviceChannelState,
  type PropertyGroup,
  type PropertyWidgetKind,
};

export type DeviceDetailEvents = {
  stateChanged: [];
  powerSynced: [did: string, state: boolean];
  actionCompleted: [actionName: string];
  errorOccurred: [message: string];
};

export interface DeviceDetailSnapshot {
  did: string;
  name: string;
  category: string;
  online: boolean;
  loading: boolean;
  busyProp: string | null;
  busyAction: string | null;
  specError: string | null;
  statusMessage: string;
  props: PropInfo[];
  actions: ActionInfo[];
  values: Record<string, unknown>;
  classified: ClassifiedDeviceProps;
  isSpeaker: boolean;
  isSplitParent: boolean;
}

export class DeviceDetailController extends TypedEmitter<DeviceDetailEvents> {
  readonly device: DeviceInfo;
  private readonly _service: IMijiaService;
  private readonly _jobs: IJobExecutor;

  props: PropInfo[] = [];
  actions: ActionInfo[] = [];
  values: Record<string, unknown> = {};
  loading = false;
  readPending = false;
  busyProp: string | null = null;
  busyAction: string | null = null;
  specError: string | null = null;
  statusMessage = "";
  disposed = false;

  private _generation = 0;
  private _revision = 0;
  private _draggingProps = new Set<string>();

  constructor(service: IMijiaService, jobs: IJobExecutor, device: DeviceInfo) {
    super();
    this._service = service;
    this._jobs = jobs;
    this.device = device;
  }

  get classified(): ClassifiedDeviceProps {
    return classifyDeviceProps(this.device, this.props);
  }

  setDragging(propName: string, dragging: boolean): void {
    if (dragging) {
      this._draggingProps.add(propName);
      this._revision += 1;
    } else {
      this._draggingProps.delete(propName);
    }
  }

  load(): void {
    if (this.disposed) {
      return;
    }
    this._generation += 1;
    const gen = this._generation;
    this.loading = true;
    this.specError = null;
    this.statusMessage = this.device.online ? "正在读取设备状态…" : "设备离线，仅加载功能规格…";
    this.emit("stateChanged");

    this._jobs.submit<DeviceDetail>(() => this._service.deviceDetail(this.device.did), {
      priority: 2,
      onSuccess: (detail) => {
        if (this.disposed || gen !== this._generation) {
          return;
        }
        this.props = detail.props;
        this.actions = detail.actions;
        if (!this.device.online) {
          this.loading = false;
          this.statusMessage = "设备当前离线，仅展示基本信息与功能规格";
          this.emit("stateChanged");
          return;
        }
        this._readAllReadable(gen);
      },
      onError: (err) => {
        if (this.disposed || gen !== this._generation) {
          return;
        }
        this.loading = false;
        this.specError = err.message || "无法读取设备规格";
        this.statusMessage = this.specError;
        this.emit("stateChanged");
      },
    });
  }

  refresh(): void {
    if (this.disposed || !this.device.online || this.readPending || this.busyProp || this.busyAction) {
      return;
    }
    if (this._draggingProps.size > 0) {
      return;
    }
    this._readAllReadable(this._generation);
  }

  writeProp(name: string, value: unknown): void {
    if (this.disposed || !this.device.online || this.busyProp || this.busyAction) {
      return;
    }
    const prop = this.props.find((p) => p.name === name);
    const checked = coercePropWriteValue(prop, value);
    if (!checked.ok) {
      this.statusMessage = checked.error;
      this.emit("errorOccurred", checked.error);
      this.emit("stateChanged");
      return;
    }

    const gen = this._generation;
    this._revision += 1;
    this.busyProp = name;
    this.statusMessage = "正在设置…";
    this.emit("stateChanged");

    this._jobs.submit(() => this._service.writeProp(this.device.did, name, checked.value), {
      priority: 1,
      onSuccess: () => {
        if (this.disposed || gen !== this._generation) {
          return;
        }
        this.busyProp = null;
        this.values[name] = checked.value;
        this.statusMessage = "";
        const powerProp = this.classified.powerProp;
        if (powerProp && name === powerProp.name && typeof checked.value === "boolean") {
          this.emit("powerSynced", this.device.did, checked.value);
        }
        this.emit("stateChanged");
        this._readAllReadable(gen);
      },
      onError: (err) => {
        if (this.disposed || gen !== this._generation) {
          return;
        }
        this.busyProp = null;
        this.statusMessage = err.message || "设置失败，请稍后重试";
        this.emit("errorOccurred", this.statusMessage);
        this.emit("stateChanged");
      },
    });
  }

  runAction(name: string, params?: unknown): void {
    if (this.disposed || !this.device.online || this.busyProp || this.busyAction) {
      return;
    }
    const gen = this._generation;
    this._revision += 1;
    this.busyAction = name;
    this.statusMessage = "正在执行操作…";
    this.emit("stateChanged");

    this._jobs.submit(() => this._service.runAction(this.device.did, name, params), {
      priority: 1,
      onSuccess: () => {
        if (this.disposed || gen !== this._generation) {
          return;
        }
        this.busyAction = null;
        this.statusMessage = "";
        this.emit("actionCompleted", name);
        this.emit("stateChanged");
        this._readAllReadable(gen);
      },
      onError: (err) => {
        if (this.disposed || gen !== this._generation) {
          return;
        }
        this.busyAction = null;
        this.statusMessage = err.message || "执行操作失败";
        this.emit("errorOccurred", this.statusMessage);
        this.emit("stateChanged");
      },
    });
  }

  snapshot(): DeviceDetailSnapshot {
    return {
      did: this.device.did,
      name: this.device.name,
      category: deviceCategoryLabel(this.device),
      online: this.device.online,
      loading: this.loading,
      busyProp: this.busyProp,
      busyAction: this.busyAction,
      specError: this.specError,
      statusMessage: this.statusMessage,
      props: this.props.map((p) => ({ ...p })),
      actions: this.actions.map((a) => ({ ...a })),
      values: { ...this.values },
      classified: this.classified,
      isSpeaker: isSpeaker(this.device),
      isSplitParent: this.device.switch_channels.length > 0,
    };
  }

  dispose(): void {
    this.disposed = true;
    this._generation += 1;
    this._draggingProps.clear();
    this.clear();
  }

  private _readAllReadable(gen: number): void {
    const readableNames = this.props
      .filter((p) => p.readable && !isSensitivePropertyName(p.name))
      .map((p) => p.name);
    if (readableNames.length === 0) {
      this.loading = false;
      this.readPending = false;
      this.statusMessage = "";
      this.emit("stateChanged");
      return;
    }
    const rev = this._revision;
    this.readPending = true;
    this._jobs.submit<Record<string, unknown>>(
      () => this._service.readProps(this.device.did, readableNames),
      {
        priority: 2,
        onSuccess: (vals) => {
          if (this.disposed || gen !== this._generation) {
            return;
          }
          this.readPending = false;
          this.loading = false;
          if (rev === this._revision && !this.busyProp && !this.busyAction && this._draggingProps.size === 0) {
            Object.assign(this.values, vals);
            const powerProp = this.classified.powerProp;
            if (powerProp && typeof this.values[powerProp.name] === "boolean") {
              this.emit("powerSynced", this.device.did, this.values[powerProp.name] as boolean);
            }
          }
          this.statusMessage = "";
          this.emit("stateChanged");
        },
        onError: (err) => {
          if (this.disposed || gen !== this._generation) {
            return;
          }
          this.readPending = false;
          this.loading = false;
          this.statusMessage = err.message || "读取实时状态失败";
          this.emit("stateChanged");
        },
      },
    );
  }
}
