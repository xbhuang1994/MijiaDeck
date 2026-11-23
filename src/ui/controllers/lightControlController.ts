// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/** Small everyday light controls, without the generic device editor. */

import { TypedEmitter, type IJobExecutor, type IMijiaService, type Rect } from "../../core/contracts.ts";
import { lightControls } from "../../core/deviceControls.ts";
import type { DeviceDetail, DeviceInfo, PropInfo } from "../../core/models.ts";

export type LightControlKind = "brightness" | "temperature" | "color";
export type LightSliderKind = "brightness" | "temperature";

export interface LightSliderState {
  kind: LightSliderKind;
  label: string;
  accessibleName: string;
  value: number;
  min: number;
  max: number;
  enabled: boolean;
  sliderDown: boolean;
  previewText: string;
}

export interface LightControlTimers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface LightControlService {
  deviceDetail(did: string): DeviceDetail | Promise<DeviceDetail>;
  readProps(did: string, names: string[]): Record<string, unknown> | Promise<Record<string, unknown>>;
  writeProp(did: string, name: string, value: unknown): void | Promise<void>;
}

export interface LightControlEvents {
  [key: string]: unknown[];
  powerChanged: [state: boolean];
  finished: [result: number];
  diagnosticsRequested: [device: DeviceInfo];
  stateChanged: [];
}

export interface LightControlOptions {
  embedded?: boolean;
  parent?: boolean | Rect | null;
  parentRect?: Rect | null;
  screenArea?: Rect;
  pollIntervalMs?: number;
  timers?: Partial<LightControlTimers>;
  colorPicker?: (currentRgb: number) => number | null | undefined;
}

export interface LightControlSnapshot {
  did: string;
  title: string;
  embedded: boolean;
  modal: boolean;
  isWindow: boolean;
  hasDiagnosticsButton: boolean;
  closeAccessibleName: string;
  props: Partial<Record<LightControlKind, PropInfo>>;
  values: Record<string, unknown>;
  sliders: Partial<Record<LightSliderKind, LightSliderState>>;
  colorButtonVisible: boolean;
  colorButtonEnabled: boolean;
  powerVisible: boolean;
  powerTextVisible: boolean;
  powerState: boolean | null;
  powerEnabled: boolean;
  powerText: string;
  bodyVisible: boolean;
  bodyEnabled: boolean;
  statusText: string;
  statusVisible: boolean;
  busy: boolean;
  readPending: boolean;
  loaded: boolean;
  closed: boolean;
  visible: boolean;
  geometry: Rect;
  panelWidth: number;
  pollActive: boolean;
}

const DEFAULT_POLL_INTERVAL_MS = 2000;
const DESKTOP_WIDTH = 480;
const DESKTOP_INITIAL_HEIGHT = 152;
const DEFAULT_SCREEN_AREA: Rect = { x: 0, y: 0, width: 1920, height: 1040 };

function defaultTimers(): LightControlTimers {
  return {
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  };
}

function formatGeneral(value: number): string {
  if (Number.isInteger(value)) {
    return String(value);
  }
  return Number(value.toPrecision(6)).toString();
}

function isRect(value: unknown): value is Rect {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Rect).x === "number" &&
    typeof (value as Rect).y === "number" &&
    typeof (value as Rect).width === "number" &&
    typeof (value as Rect).height === "number"
  );
}

/**
 * Shared light controls controller: an embedded child pane inside the tray
 * quick window, or a frameless modal/non-modal dialog on desktop.
 */
export class LightControlController {
  readonly events = new TypedEmitter<LightControlEvents>();
  readonly device: DeviceInfo;
  readonly embedded: boolean;
  readonly modal: boolean;
  readonly isWindow: boolean;
  readonly hasDiagnosticsButton: boolean;
  readonly title: string;
  readonly closeAccessibleName: string;

  props: Partial<Record<LightControlKind, PropInfo>> = {};
  values: Record<string, unknown> = {};
  sliders: Partial<Record<LightSliderKind, LightSliderState>> = {};
  colorButtonVisible = false;
  colorButtonEnabled = false;
  powerProp: PropInfo | null = null;
  powerVisible = false;
  powerTextVisible = false;
  powerState: boolean | null = null;
  powerEnabled = false;
  powerText = "状态待确认";
  bodyVisible = false;
  bodyEnabled = true;
  statusText = "正在读取灯光状态…";
  statusVisible = true;
  busy = false;
  readPending = false;
  loaded = false;
  closed = false;
  visible = false;
  geometry: Rect;
  panelWidth: number;
  backdrop: unknown | null = null;

  private readonly service: LightControlService;
  private readonly jobs: IJobExecutor;
  private readonly timers: LightControlTimers;
  private readonly pollIntervalMs: number;
  private readonly defaultColorPicker?: (currentRgb: number) => number | null | undefined;

  private parentRect: Rect | null;
  private screenArea: Rect;
  private lastPower: boolean | null = null;
  private interactionRevision = 0;
  private pollHandle: unknown | null = null;

  constructor(
    service: LightControlService | IMijiaService,
    jobs: IJobExecutor,
    device: DeviceInfo,
    options: LightControlOptions = {},
  ) {
    this.service = service;
    this.jobs = jobs;
    this.device = device;
    this.embedded = Boolean(options.embedded);
    this.isWindow = !this.embedded;
    const hasParent = Boolean(options.parent || options.parentRect);
    this.modal = !this.embedded && hasParent;
    this.hasDiagnosticsButton = !this.embedded;
    this.title = device.name;
    this.closeAccessibleName = this.embedded ? "返回设备列表" : "关闭灯光控制";
    this.panelWidth = this.embedded ? 336 : 432;
    this.parentRect = options.parentRect ?? (isRect(options.parent) ? { ...options.parent } : null);
    this.screenArea = options.screenArea ? { ...options.screenArea } : { ...DEFAULT_SCREEN_AREA };
    this.geometry = this.embedded
      ? { x: 0, y: 0, width: 400, height: 480 }
      : { x: 0, y: 0, width: DESKTOP_WIDTH, height: DESKTOP_INITIAL_HEIGHT };

    const defaults = defaultTimers();
    this.timers = {
      setInterval: options.timers?.setInterval ?? defaults.setInterval,
      clearInterval: options.timers?.clearInterval ?? defaults.clearInterval,
    };
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.defaultColorPicker = options.colorPicker;
  }

  get pollActive(): boolean {
    return this.pollHandle !== null;
  }

  alive(): boolean {
    return !this.closed;
  }

  requestDiagnostics(): void {
    if (!this.hasDiagnosticsButton || !this.alive()) {
      return;
    }
    this.events.emit("diagnosticsRequested", this.device);
  }

  load(): void {
    if (this.loaded || !this.alive()) {
      return;
    }
    this.loaded = true;
    this.jobs.submit(() => this.service.deviceDetail(this.device.did), {
      onSuccess: (detail) => this.build(detail),
      onError: (err) => this.failed(err),
    });
  }

  private build(detail: DeviceDetail): void {
    if (!this.alive()) {
      return;
    }
    this.props = lightControls(detail.props);
    if (Object.keys(this.props).length === 0) {
      // A plain on/off light never needs a second page.
      this.reject();
      return;
    }
    this.powerProp =
      detail.props.find(
        (p) =>
          p.type === "bool" &&
          p.writable &&
          (p.name === "on" || p.name.startsWith("on-") || p.name.startsWith("on_")),
      ) ?? null;

    if (this.powerProp) {
      this.powerVisible = true;
      this.powerEnabled = false;
      this.powerTextVisible = true;
    }

    for (const kind of ["brightness", "temperature"] as const) {
      if (!this.props[kind]) {
        continue;
      }
      this.sliders[kind] = {
        kind,
        label: kind === "brightness" ? "亮度" : "色温",
        accessibleName: kind === "brightness" ? "灯光亮度" : "灯光色温",
        value: 0,
        min: 0,
        max: kind === "brightness" ? 100 : 1000,
        enabled: false,
        sliderDown: false,
        previewText: "—",
      };
    }

    if (this.props.color) {
      this.colorButtonVisible = true;
      this.colorButtonEnabled = false;
    }

    this.bodyVisible = true;

    if (!this.embedded) {
      const sliderCount = (this.sliders.brightness ? 1 : 0) + (this.sliders.temperature ? 1 : 0);
      const colorHeight = this.colorButtonVisible ? 58 : 0;
      const nextHeight = DESKTOP_INITIAL_HEIGHT + sliderCount * 76 + colorHeight + 8;
      this.geometry = {
        ...this.geometry,
        height: nextHeight,
      };
      this.placeCentered();
    }

    this.emitStateChanged();
    this.refresh();
    this.startPollTimer();
  }

  sliderValue(kind: LightSliderKind): number {
    const prop = this.props[kind];
    const slider = this.sliders[kind];
    if (!prop || !slider || !prop.range || prop.range.length < 2) {
      return 0;
    }
    const low = prop.range[0];
    const high = prop.range[1];
    let value =
      kind === "brightness"
        ? (high * slider.value) / 100
        : low + ((high - low) * slider.value) / slider.max;
    const step = prop.range.length > 2 && prop.range[2] ? prop.range[2] : 1;
    value = Math.max(low, Math.min(high, low + Math.round((value - low) / step) * step));
    return prop.type === "float" ? Number(value) : Math.round(value);
  }

  private preview(kind: LightSliderKind): void {
    const prop = this.props[kind];
    const slider = this.sliders[kind];
    if (!prop || !slider || !prop.range || prop.range.length < 2) {
      return;
    }
    let value = this.sliderValue(kind);
    if (kind === "brightness") {
      value = Math.round((100 * value) / prop.range[1]);
    }
    slider.previewText = formatGeneral(value) + (kind === "brightness" ? "%" : " K");
  }

  setSliderDown(kind: LightSliderKind, down: boolean): void {
    const slider = this.sliders[kind];
    if (!slider || slider.sliderDown === down) {
      return;
    }
    slider.sliderDown = down;
    if (down) {
      this.beginInteraction();
    }
    this.emitStateChanged();
  }

  setSliderValue(kind: LightSliderKind, value: number): void {
    const slider = this.sliders[kind];
    if (!slider) {
      return;
    }
    slider.value = Math.max(slider.min, Math.min(slider.max, Math.round(value)));
    this.preview(kind);
    this.emitStateChanged();
  }

  commitSlider(kind: LightSliderKind): void {
    const prop = this.props[kind];
    const slider = this.sliders[kind];
    if (!prop || !slider) {
      return;
    }
    this.write(prop.name, this.sliderValue(kind));
  }

  clickSliderTrack(kind: LightSliderKind, value: number): void {
    const slider = this.sliders[kind];
    if (!slider || !slider.enabled || !this.bodyEnabled) {
      return;
    }
    this.setSliderValue(kind, value);
    this.commitSlider(kind);
  }

  refresh(): void {
    if (!this.alive() || this.busy || this.readPending) {
      return;
    }
    if (this.anySliderDown()) {
      return;
    }
    const names = (Object.values(this.props).filter((p): p is PropInfo => Boolean(p && p.readable))).map(
      (p) => p.name,
    );
    if (this.powerProp && this.powerProp.readable) {
      names.push(this.powerProp.name);
    }
    this.readPending = true;
    const revision = this.interactionRevision;

    this.jobs.submit(() => this.service.readProps(this.device.did, names), {
      onSuccess: (values) => {
        if (!this.alive()) return;
        this.readPending = false;
        if (!this.busy && revision === this.interactionRevision && !this.anySliderDown()) {
          Object.assign(this.values, values);
          this.render();
        }
      },
      onError: (error) => {
        if (!this.alive()) return;
        this.readPending = false;
        this.failed(error);
      },
    });
  }

  render(): void {
    const enabled = this.adjustmentsAllowed();
    if (this.powerProp) {
      const raw = this.values[this.powerProp.name];
      const state = typeof raw === "boolean" ? raw : null;
      this.powerState = state;
      this.powerEnabled = state !== null && !this.busy;
      this.powerText = state === null ? "状态待确认" : state ? "已开启" : "已关闭";
      if (typeof raw === "boolean" && raw !== this.lastPower) {
        this.lastPower = raw;
        this.events.emit("powerChanged", raw);
      }
    }

    for (const kind of ["brightness", "temperature"] as const) {
      const slider = this.sliders[kind];
      const prop = this.props[kind];
      if (!slider || !prop || !prop.range || prop.range.length < 2) {
        continue;
      }
      const raw = this.values[prop.name];
      const hasNumeric = typeof raw === "number" && Number.isFinite(raw);
      slider.enabled = enabled && hasNumeric && !this.busy;
      if (!hasNumeric) {
        continue;
      }
      const [low, high] = prop.range;
      const fraction = kind === "brightness" ? raw / high : (raw - low) / (high - low);
      slider.value = Math.max(slider.min, Math.min(slider.max, Math.round(fraction * slider.max)));
      this.preview(kind);
    }

    if (this.colorButtonVisible) {
      this.colorButtonEnabled = enabled && !this.busy;
    }

    this.statusText = "";
    this.statusVisible = false;
    this.emitStateChanged();
  }

  togglePower(): void {
    if (!this.powerProp) {
      return;
    }
    const current = this.values[this.powerProp.name];
    if (typeof current === "boolean") {
      this.write(this.powerProp.name, !current);
    }
  }

  adjustmentsAllowed(): boolean {
    return (
      this.powerProp !== null &&
      this.values[this.powerProp.name] === true &&
      !this.busy
    );
  }

  chooseColor(picker?: (currentRgb: number) => number | null | undefined): void {
    if (!this.adjustmentsAllowed()) {
      return;
    }
    const prop = this.props.color;
    if (!prop) {
      return;
    }
    const current = this.values[prop.name];
    const currentRgb = typeof current === "number" && Number.isFinite(current) ? current : 0xffffff;
    const pick = picker ?? this.defaultColorPicker;
    if (!pick) {
      return;
    }
    const picked = pick(currentRgb || 0);
    if (typeof picked === "number" && Number.isFinite(picked) && this.alive()) {
      this.write(prop.name, Math.trunc(picked) & 0xffffff);
    }
  }

  setColor(rgb: number): void {
    if (!this.adjustmentsAllowed()) {
      return;
    }
    const prop = this.props.color;
    if (!prop || !this.alive()) {
      return;
    }
    this.write(prop.name, Math.trunc(rgb) & 0xffffff);
  }

  write(name: string, value: unknown): void {
    if (this.busy || !this.alive()) {
      return;
    }
    if ((this.powerProp === null || name !== this.powerProp.name) && !this.adjustmentsAllowed()) {
      return;
    }
    this.busy = true;
    this.beginInteraction();
    if (this.powerVisible) {
      this.powerEnabled = false;
    }
    this.bodyEnabled = false;
    this.statusText = "正在设置…";
    this.statusVisible = true;
    this.emitStateChanged();

    this.jobs.submit(() => this.service.writeProp(this.device.did, name, value), {
      onSuccess: () => {
        if (!this.alive()) return;
        this.busy = false;
        this.bodyEnabled = true;
        this.values[name] = value;
        this.render();
        // Some lamps turn on themselves after a brightness/temperature write.
        // Read their actual power state instead of assuming it stayed unchanged;
        // never send an implicit power command.
        this.refresh();
      },
      onError: (error) => {
        if (!this.alive()) return;
        this.busy = false;
        this.bodyEnabled = true;
        this.render();
        this.failed(error);
      },
    });
  }

  private beginInteraction(): void {
    this.interactionRevision += 1;
  }

  private failed(_error: Error): void {
    if (!this.alive()) {
      return;
    }
    this.statusText = "暂时无法读取或设置灯光，请稍后重试。";
    this.statusVisible = true;
    this.emitStateChanged();
  }

  show(): void {
    if (this.closed) return;
    this.visible = true;
    this.emitStateChanged();
  }

  showCentered(parentRect?: Rect | null, screenArea?: Rect | null): void {
    if (parentRect !== undefined) {
      this.parentRect = parentRect ? { ...parentRect } : null;
    }
    if (screenArea) {
      this.screenArea = { ...screenArea };
    }
    this.placeCentered();
    this.visible = true;
    this.emitStateChanged();
  }

  placeCentered(): void {
    if (this.embedded) {
      return;
    }
    const area = this.screenArea;
    const anchor = this.parentRect ?? area;
    const centerX = anchor.x + Math.floor(anchor.width / 2);
    const centerY = anchor.y + Math.floor(anchor.height / 2);
    const rawX = centerX - Math.floor(this.geometry.width / 2);
    const rawY = centerY - Math.floor(this.geometry.height / 2);
    const clampedX = Math.max(area.x, Math.min(rawX, area.x + area.width - this.geometry.width));
    const clampedY = Math.max(area.y, Math.min(rawY, area.y + area.height - this.geometry.height));
    this.geometry = {
      ...this.geometry,
      x: clampedX,
      y: clampedY,
    };
  }

  resize(width: number, height: number): void {
    this.geometry = {
      ...this.geometry,
      width,
      height,
    };
    if (this.embedded) {
      this.panelWidth = Math.min(336, Math.max(180, width - 40));
    }
    this.emitStateChanged();
  }

  setBackdrop(backdrop: unknown | null): void {
    this.backdrop = backdrop;
  }

  done(result: number): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.stopPollTimer();
    this.visible = false;
    this.events.emit("finished", result);
    this.emitStateChanged();
  }

  reject(): void {
    this.done(0);
  }

  handleKeyPress(key: string): boolean {
    if (key === "Escape") {
      this.reject();
      return true;
    }
    return false;
  }

  snapshot(): LightControlSnapshot {
    const slidersCopy: Partial<Record<LightSliderKind, LightSliderState>> = {};
    for (const kind of ["brightness", "temperature"] as const) {
      const s = this.sliders[kind];
      if (s) {
        slidersCopy[kind] = { ...s };
      }
    }
    return {
      did: this.device.did,
      title: this.title,
      embedded: this.embedded,
      modal: this.modal,
      isWindow: this.isWindow,
      hasDiagnosticsButton: this.hasDiagnosticsButton,
      closeAccessibleName: this.closeAccessibleName,
      props: { ...this.props },
      values: { ...this.values },
      sliders: slidersCopy,
      colorButtonVisible: this.colorButtonVisible,
      colorButtonEnabled: this.colorButtonEnabled,
      powerVisible: this.powerVisible,
      powerTextVisible: this.powerTextVisible,
      powerState: this.powerState,
      powerEnabled: this.powerEnabled,
      powerText: this.powerText,
      bodyVisible: this.bodyVisible,
      bodyEnabled: this.bodyEnabled,
      statusText: this.statusText,
      statusVisible: this.statusVisible,
      busy: this.busy,
      readPending: this.readPending,
      loaded: this.loaded,
      closed: this.closed,
      visible: this.visible,
      geometry: { ...this.geometry },
      panelWidth: this.panelWidth,
      pollActive: this.pollActive,
    };
  }

  private anySliderDown(): boolean {
    return Object.values(this.sliders).some((s) => Boolean(s?.sliderDown));
  }

  private startPollTimer(): void {
    this.stopPollTimer();
    this.pollHandle = this.timers.setInterval(() => {
      if (this.alive()) {
        this.refresh();
      }
    }, this.pollIntervalMs);
  }

  private stopPollTimer(): void {
    if (this.pollHandle !== null) {
      this.timers.clearInterval(this.pollHandle);
      this.pollHandle = null;
    }
  }

  private emitStateChanged(): void {
    this.events.emit("stateChanged");
  }
}
