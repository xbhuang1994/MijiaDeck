// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Zero-dependency browser client wired to MijiaDeck REST + WebSocket API.

import { renderQrSvg } from "../ui/qrSvg.ts";
import { DeviceDetailModalController } from "./deviceDetailModal.ts";
import {
  PiAgentPanelController,
  type UiCavemanMode,
  type UiLocalVoiceStatus,
  type UiProviderPreset,
  type UiPublicAgentConfig,
  type UiVoiceprintProfile,
  type UiWakeWordHit,
  type UiWakeWordPrototypeSummary,
} from "./piAgentPanel.ts";
import { recordShortWavSample } from "./voiceListener.ts";

// ---------------------------------------------------------------------------
// Types & Data Models
// ---------------------------------------------------------------------------

export type AccessState = "ready" | "offline" | "signed_out" | "loading" | "unavailable";
export type ThemeMode = "system" | "light" | "dark";
export type LightPropertyKind = "brightness" | "temperature" | "color";

export interface DeviceInfo {
  did: string;
  name: string;
  model: string;
  home_name: string;
  room_name: string;
  online: boolean;
  spec_type: string;
  switch_channels: string[];
  light_features: string[];
  metric_features: string[] | null;
  firmware: string;
}

export interface SceneInfo {
  scene_id: string;
  name: string;
  home_id: string;
  home_name: string;
}

export interface PropInfo {
  name: string;
  desc: string;
  type: string;
  readable: boolean;
  writable: boolean;
  range: [number, number, number] | [number, number] | null;
  value_list: Array<{ value: number | string; description?: string; desc_zh_cn?: string }> | null;
}

export interface TrayOrderItem {
  type: "device" | "scene";
  id: string;
}

export interface TraySceneSnapshot {
  scene_id: string;
  name: string;
  home_id: string;
  home_name: string;
}

export interface ReleaseInfo {
  tag: string;
  url: string;
  name?: string;
  body?: string;
}

export interface LoadingState {
  active: boolean;
  fullPage: boolean;
  showFooter: boolean;
  progress: number;
  stage: string;
  loadingDevices: boolean;
}

export interface RoomMenuEntry {
  name: string;
  count: number | null;
  selected?: boolean;
}

export interface AppSettings {
  theme: ThemeMode;
  theme_color: string;
  custom_theme_color: string;
  ui_scale: number;
  voice_fab_enabled: boolean;
  show_scene_tab: boolean;
  autostart: boolean;
  autostart_supported: boolean;
  default_speaker_did: string;
  minimize_to_tray: boolean;
  start_minimized: boolean;
  hide_no_func_devices: boolean;
  check_update_enabled: boolean;
  tray_columns: 1 | 2;
  tray_intro_seen: boolean;
}

export interface SpeakerAudioState {
  did: string | null;
  name: string;
  volume: number | null;
  muted: boolean | null;
  min: number;
  max: number;
  volName: string;
  muteName: string;
}

export interface AppState {
  version: string;
  apiVersion: string;
  demo: boolean;
  accessState: AccessState;
  loggedIn: boolean;
  networkOnline: boolean;
  loading: LoadingState;
  homes: string[];
  currentHome: string;
  rooms: string[];
  roomMenu: RoomMenuEntry[] | null;
  currentRoom: string;
  devices: DeviceInfo[];
  visibleDevices: DeviceInfo[] | null;
  scenes: SceneInfo[];
  knownPower: Record<string, boolean | null>;
  metrics: Record<string, string | null>;
  icons: Record<string, string | null>;
  trayDevices: string[];
  trayScenes: TraySceneSnapshot[];
  trayOrder: TrayOrderItem[];
  trayColumns: 1 | 2;
  trayIntroSeen: boolean;
  settings: AppSettings;
  resolvedTheme: "light" | "dark";
  resolvedAccent: string;
  release: ReleaseInfo | null;
  statusText: string;
  audio: SpeakerAudioState;
}

type ModalName =
  | "settings"
  | "device-detail"
  | "light"
  | "camera"
  | "tray-manager"
  | "login"
  | "diagnostics"
  | "tray-intro"
  | "about";

interface LightDomRefs {
  title: HTMLElement;
  powerBtn: HTMLButtonElement;
  powerText: HTMLElement;
  body: HTMLElement;
  status: HTMLElement;
  brightnessRow: HTMLElement;
  brightnessSlider: HTMLInputElement;
  brightnessVal: HTMLElement;
  tempRow: HTMLElement;
  tempSlider: HTMLInputElement;
  tempVal: HTMLElement;
  colorRow: HTMLElement;
  colorBtn: HTMLButtonElement;
  colorDot: HTMLElement;
  colorPicker: HTMLInputElement;
}

interface NormalizedLightPayload {
  props: Partial<Record<LightPropertyKind, PropInfo>>;
  powerProp: PropInfo | null;
  values: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Constants & Helpers (matching Python & TS core semantics)
// ---------------------------------------------------------------------------

const ALL_ROOMS = "全屋";
const ALL_HOMES = "全部";
const SCENE_TAB = "场景";
const UNASSIGNED_ROOM = "未分配房间";
const PTZ_MODEL = "chuangmi.camera.029a02";
const VOICE_FAB_HINT = "对小爱同学下指令，如“打开卧室灯”，回车执行";
const TRAY_VOICE_HINT = "对小爱输入“打开卧室灯”，回车执行";
const TYPE_INTERVAL_MS = 80;
const HOLD_REPLAY_MS = 1800;
const HEX_COLOR_RE = /^#[0-9a-f]{6}$/;
const PRESET_COLORS = new Set(["green", "pink", "yellow", "blue"]);

const ACCESS_MESSAGES: Record<AccessState, string> = {
  ready: "",
  signed_out: "请先登录小米账号，登录后即可控制设备",
  offline: "网络异常，请连接网络后重试。",
  loading: "正在同步设备，请稍候…",
  unavailable: "网络异常，请连接网络后重试。",
};

const CAMERA_KINDS = new Set(["camera", "ip-camera"]);
const SPEAKER_KINDS = new Set(["speaker", "wifispeaker"]);
const APPLIANCE_POWER_KINDS = new Set([
  "television",
  "tv",
  "washer",
  "washing-machine",
  "dryer",
  "air-conditioner",
  "aircondition",
  "airconditioner",
  "fan",
  "air-purifier",
  "airpurifier",
  "purifier",
  "humidifier",
  "dehumidifier",
  "heater",
  "water-heater",
]);
const SPEC_DEVICE_KIND_RE = /:device:([^:]+):/;

const LIGHT_PROP_MAP: Record<string, LightPropertyKind> = {
  brightness: "brightness",
  "color-temperature": "temperature",
  color: "color",
  rgb: "color",
};

const PTZ_LABELS: Record<number, { arrow: string; label: string; dx: number; dy: number }> = {
  1: { arrow: "←", label: "向左转动", dx: -1, dy: 0 },
  2: { arrow: "→", label: "向右转动", dx: 1, dy: 0 },
  3: { arrow: "↑", label: "向上转动", dx: 0, dy: -1 },
  4: { arrow: "↓", label: "向下转动", dx: 0, dy: 1 },
};

const CAVEMAN_PREVIEW_DESCS: Readonly<Record<UiCavemanMode, string>> = {
  full: "极简直给，去寒暄废话、保留关键数值与结果 · 例：“客厅灯已开，亮度 85%。”",
  ultra: "电报体极致压缩，语音首字播报最快 · 例：“客厅灯开 85%。”",
  lite: "精炼自然口语，保留基本礼貌与清晰表述 · 例：“好的，客厅吸顶灯已打开，亮度 85%。”",
  off: "标准自然对话回复，不做字数压缩 · 例：“好的，已经为您打开了客厅吸顶灯，并将亮度调整到了 85%。”",
};

function safeUrlHost(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) return "";
  try {
    return new URL(trimmed).host;
  } catch {
    return "";
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readStr(rec: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const val = rec[key];
    if (typeof val === "string") return val;
  }
  return undefined;
}

function readBool(rec: Record<string, unknown>, ...keys: string[]): boolean | undefined {
  for (const key of keys) {
    const val = rec[key];
    if (typeof val === "boolean") return val;
  }
  return undefined;
}

function readNum(rec: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const val = rec[key];
    if (typeof val === "number" && Number.isFinite(val)) return val;
  }
  return undefined;
}

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) {
    throw new Error(`Missing required DOM element: #${id}`);
  }
  return node as T;
}

function normalizeThemeColor(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  if (PRESET_COLORS.has(normalized) || HEX_COLOR_RE.test(normalized)) {
    return normalized;
  }
  return null;
}

function formatScalePercent(scale: number): string {
  const pct = Number((scale * 100).toPrecision(6));
  return `${pct}%`;
}

function parseScaleText(rawText: string): number | null {
  const cleaned = rawText.trim().replace(/%+$/, "").trim();
  if (!cleaned) return null;
  const num = Number(cleaned);
  if (!Number.isFinite(num)) return null;
  const scale = num / 100;
  return Math.min(Math.max(scale, 0.5), 2.0);
}

function formatNumberGeneral(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return Number(value.toPrecision(6)).toString();
}

function rgbIntToHex(rgb: number): string {
  const clamped = Math.max(0, Math.min(0xffffff, Math.trunc(rgb)));
  return `#${clamped.toString(16).padStart(6, "0")}`;
}

function hexToRgbInt(hex: string): number {
  const cleaned = hex.trim().replace(/^#/, "");
  const parsed = Number.parseInt(cleaned, 16);
  return Number.isFinite(parsed) ? parsed & 0xffffff : 0xffffff;
}

// Device role helpers mirroring src/core/deviceControls.ts
function deviceKinds(device: DeviceInfo): Set<string> {
  const parts = new Set(device.model.toLowerCase().split("."));
  const match = SPEC_DEVICE_KIND_RE.exec(device.spec_type || "");
  if (match && match[1]) {
    parts.add(match[1]);
  }
  return parts;
}

function hasAnyKind(kinds: Set<string>, targets: ReadonlySet<string>): boolean {
  for (const kind of kinds) {
    if (targets.has(kind)) return true;
  }
  return false;
}

function isSpeaker(device: Pick<DeviceInfo, "model">): boolean {
  return device.model.includes("wifispeaker");
}

function isLight(device: DeviceInfo): boolean {
  if ((device.spec_type || "").includes(":device:light:")) return true;
  const parts = device.model.split(".");
  return parts.includes("light") || parts.includes("lamp") || parts.includes("bulb");
}

function isSwitch(device: DeviceInfo): boolean {
  return (device.spec_type || "").includes(":device:switch:") || device.model.includes(".switch.");
}

function isDirectPower(device: DeviceInfo): boolean {
  if (isSwitch(device)) return true;
  const parts = device.model.split(".");
  if (parts.includes("plug") || parts.includes("outlet")) return true;
  return (device.spec_type || "").includes(":device:outlet:");
}

function isCamera(device: DeviceInfo): boolean {
  return hasAnyKind(deviceKinds(device), CAMERA_KINDS);
}

function supportsCardPower(device: DeviceInfo): boolean {
  if (device.switch_channels.length > 0) return false;
  if (isLight(device) || isDirectPower(device)) return true;
  return hasAnyKind(deviceKinds(device), APPLIANCE_POWER_KINDS);
}

function hasDeviceDetails(device: DeviceInfo): boolean {
  if (device.switch_channels.length > 0 || isDirectPower(device)) return false;
  return isLight(device) ? device.light_features.length > 0 : isCamera(device);
}

function trayEligible(device: DeviceInfo): boolean {
  if (device.switch_channels.length > 0 || supportsCardPower(device) || isCamera(device)) {
    return true;
  }
  if (hasAnyKind(deviceKinds(device), SPEAKER_KINDS)) return true;
  return Array.isArray(device.metric_features) && device.metric_features.length > 0;
}

function deviceTitle(device: DeviceInfo): string {
  if (device.switch_channels.length > 0 && !device.name.endsWith("面板")) {
    return `${device.name}面板`;
  }
  return device.name;
}

function panelStatus(device: DeviceInfo, states: Record<string, boolean | null | undefined>): string {
  const values = device.switch_channels.map((did) => states[did]);
  if (values.length === 0 || values.some((v) => v === null || v === undefined)) {
    return "状态待确认";
  }
  const count = values.filter((v) => v === true).length;
  if (count === 0) return "全部关闭";
  return count === values.length ? `全部开启 · ${count} 路` : `部分开启 · ${count} 路`;
}

function deviceSubtitle(
  device: DeviceInfo,
  metrics: string | null | undefined,
  states: Record<string, boolean | null | undefined>,
): string {
  if (!device.online) {
    return `${device.room_name} · 离线`;
  }
  if (device.switch_channels.length > 0) {
    const loc = metrics ? `${device.room_name} · 设备温度 ${metrics}` : device.room_name;
    return `${loc}\n${panelStatus(device, states)}`;
  }
  return metrics ? `${device.room_name} | ${metrics}` : device.room_name;
}

function speakerHint(devices: DeviceInfo[]): string {
  const speakers = devices.filter((d) => isSpeaker(d));
  if (speakers.length === 0) return "当前你还没有添加任何智能音箱";
  return speakers.some((d) => d.online) ? "" : "智能音箱当前离线";
}

function deviceIconSvg(model: string): string {
  const m = model.toLowerCase();
  if (m.includes("wifispeaker") || m.includes("speaker")) {
    return `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="3" width="12" height="18" rx="2.5"></rect><circle cx="12" cy="14" r="3"></circle><circle cx="12" cy="7.5" r="1"></circle></svg>`;
  }
  if (m.includes("light") || m.includes("lamp") || m.includes("bulb")) {
    return `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.87c.72.52 1.25 1.32 1.4 2.13h4.2c.15-.81.68-1.61 1.4-2.13A6 6 0 0 0 12 3z"></path></svg>`;
  }
  if (m.includes("plug") || m.includes("outlet") || m.includes("switch")) {
    return `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="4"></rect><circle cx="9.5" cy="12" r="1.2" fill="currentColor"></circle><circle cx="14.5" cy="12" r="1.2" fill="currentColor"></circle></svg>`;
  }
  if (m.includes("sensor") || m.includes("htv") || m.includes("thermometer")) {
    return `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 14.76V5a2 2 0 1 0-4 0v9.76a4 4 0 1 0 4 0z"></path></svg>`;
  }
  if (m.includes("humidifier")) {
    return `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"></path></svg>`;
  }
  if (m.includes("airpurifier") || m.includes("purifier") || m.includes("fan")) {
    return `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9.59 4.59A2 2 0 1 1 11 8H2m10.59 11.41A2 2 0 1 0 14 16H2m15.73-8.27A2.5 2.5 0 1 1 19.5 12H2"></path></svg>`;
  }
  if (m.includes("curtain")) {
    return `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5h18M5 5v14M19 5v14M9 5c0 4-1.5 7-4 9M15 5c0 4 1.5 7 4 9"></path></svg>`;
  }
  if (m.includes("feeder")) {
    return `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h12l-1 10H7L6 3z"></path><path d="M4 17a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2z"></path><path d="M9.5 17.5h5"></path></svg>`;
  }
  if (m.includes("camera")) {
    return `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M23 7l-7 5 7 5V7z"></path><rect x="1" y="5" width="15" height="14" rx="2.5"></rect></svg>`;
  }
  return `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="13" rx="2"></rect><path d="M8 21h8M12 17v4"></path></svg>`;
}

const POWER_ICON_SVG = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"></path><line x1="12" y1="2" x2="12" y2="12"></line></svg>`;
const UNKNOWN_ICON_SVG = `<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="7"></circle></svg>`;
const PLAY_OUTLINE_SVG = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><polygon points="8 5 19 12 8 19 8 5"></polygon></svg>`;
const PLAY_SOLID_SVG = `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><polygon points="8 5 19 12 8 19 8 5"></polygon></svg>`;

// ---------------------------------------------------------------------------
// Typewriter Placeholder Animator
// ---------------------------------------------------------------------------

class TypewriterPlaceholder {
  private pos = 0;
  private tickTimer: number | null = null;
  private replayTimer: number | null = null;

  constructor(
    private readonly input: HTMLInputElement,
    private readonly fullText: string,
    private readonly isVisible: () => boolean,
  ) {}

  start(): void {
    this.stop(false);
    this.pos = 0;
    this.input.placeholder = "";
    this.tickTimer = window.setInterval(() => this.tick(), TYPE_INTERVAL_MS);
  }

  stop(clear = false): void {
    if (this.tickTimer !== null) {
      window.clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.replayTimer !== null) {
      window.clearTimeout(this.replayTimer);
      this.replayTimer = null;
    }
    if (clear) {
      this.input.placeholder = "";
    }
  }

  isRunning(): boolean {
    return this.tickTimer !== null || this.replayTimer !== null;
  }

  private tick(): void {
    this.pos += 1;
    if (this.pos >= this.fullText.length) {
      this.input.placeholder = this.fullText;
      this.pos = 0;
      if (this.tickTimer !== null) {
        window.clearInterval(this.tickTimer);
        this.tickTimer = null;
      }
      this.replayTimer = window.setTimeout(() => {
        this.replayTimer = null;
        if (this.isVisible()) {
          this.start();
        }
      }, HOLD_REPLAY_MS);
      return;
    }
    this.input.placeholder = this.fullText.slice(0, this.pos);
  }
}

// ---------------------------------------------------------------------------
// REST API Helpers
// ---------------------------------------------------------------------------

async function apiRequest<T>(
  method: "GET" | "POST",
  url: string,
  body?: unknown,
): Promise<T> {
  const init: RequestInit = {
    method,
    headers: { Accept: "application/json" },
    cache: "no-store",
  };
  if (body !== undefined) {
    init.headers = {
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    init.body = JSON.stringify(body);
  }
  const response = await fetch(url, init);
  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (!response.ok) {
    const rec = asRecord(parsed);
    const errMsg =
      (rec && (readStr(rec, "error", "message", "detail") ?? undefined)) ||
      (typeof parsed === "string" && parsed.trim()) ||
      `请求失败 (${response.status})`;
    throw new Error(errMsg);
  }
  const rec = asRecord(parsed);
  if (rec && rec.ok === false) {
    throw new Error(readStr(rec, "error", "message", "detail") ?? "操作失败");
  }
  if (rec && "data" in rec && Object.keys(rec).length <= 2 && ("ok" in rec || "status" in rec)) {
    return rec.data as T;
  }
  return parsed as T;
}

function apiGet<T>(url: string): Promise<T> {
  return apiRequest<T>("GET", url);
}

function apiPost<T>(url: string, body?: unknown): Promise<T> {
  return apiRequest<T>("POST", url, body ?? {});
}

// ---------------------------------------------------------------------------
// Shared Light Control Session (Desktop Modal + Tray Embedded Sub-Page)
// ---------------------------------------------------------------------------

class LightControlSession {
  private device: DeviceInfo | null = null;
  private props: Partial<Record<LightPropertyKind, PropInfo>> = {};
  private powerProp: PropInfo | null = null;
  private values: Record<string, unknown> = {};
  private busy = false;
  private readPending = false;
  private sliderDown: Record<"brightness" | "temperature", boolean> = {
    brightness: false,
    temperature: false,
  };
  private revision = 0;
  private generation = 0;
  private pollTimer: number | null = null;

  constructor(
    private readonly dom: LightDomRefs,
    private readonly onPowerSynced: (did: string, state: boolean) => void,
    private readonly onEmptyClose: () => void,
  ) {
    this.bindEvents();
  }

  currentDevice(): DeviceInfo | null {
    return this.device;
  }

  open(device: DeviceInfo): void {
    this.close();
    this.device = device;
    this.generation += 1;
    const gen = this.generation;

    this.dom.title.textContent = device.name;
    this.dom.powerBtn.hidden = true;
    this.dom.powerBtn.disabled = true;
    this.dom.powerText.textContent = "状态待确认";
    this.dom.powerText.hidden = true;
    this.dom.body.hidden = true;
    this.dom.brightnessRow.hidden = true;
    this.dom.tempRow.hidden = true;
    this.dom.colorRow.hidden = true;
    this.dom.status.textContent = "正在读取灯光状态…";
    this.dom.status.hidden = false;

    void this.fetchInitial(device.did, gen);
  }

  close(): void {
    this.generation += 1;
    this.device = null;
    this.props = {};
    this.powerProp = null;
    this.values = {};
    this.busy = false;
    this.readPending = false;
    this.sliderDown.brightness = false;
    this.sliderDown.temperature = false;
    if (this.pollTimer !== null) {
      window.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private bindEvents(): void {
    this.dom.powerBtn.addEventListener("click", () => {
      if (!this.device || !this.powerProp || this.busy) return;
      const cur = this.values[this.powerProp.name];
      if (typeof cur === "boolean") {
        void this.writeProp(this.powerProp.name, !cur);
      }
    });

    const wireSlider = (kind: "brightness" | "temperature", slider: HTMLInputElement) => {
      slider.addEventListener("pointerdown", () => {
        this.sliderDown[kind] = true;
        this.revision += 1;
      });
      slider.addEventListener("input", () => {
        this.updateSliderPreview(kind);
      });
      slider.addEventListener("change", () => {
        this.sliderDown[kind] = false;
        const prop = this.props[kind];
        if (!prop || !this.adjustmentsAllowed()) return;
        const rawValue = this.computePropValue(kind);
        void this.writeProp(prop.name, rawValue);
      });
      slider.addEventListener("pointerup", () => {
        this.sliderDown[kind] = false;
      });
      slider.addEventListener("pointercancel", () => {
        this.sliderDown[kind] = false;
      });
    };

    wireSlider("brightness", this.dom.brightnessSlider);
    wireSlider("temperature", this.dom.tempSlider);

    this.dom.colorBtn.addEventListener("click", () => {
      if (!this.adjustmentsAllowed() || !this.props.color) return;
      const raw = this.values[this.props.color.name];
      const currentRgb = typeof raw === "number" && Number.isFinite(raw) ? raw : 0xffffff;
      this.dom.colorPicker.value = rgbIntToHex(currentRgb);
      this.dom.colorPicker.click();
    });

    this.dom.colorPicker.addEventListener("change", () => {
      if (!this.adjustmentsAllowed() || !this.props.color) return;
      const rgb = hexToRgbInt(this.dom.colorPicker.value);
      void this.writeProp(this.props.color.name, rgb);
    });
  }

  private async fetchInitial(did: string, gen: number): Promise<void> {
    this.readPending = true;
    try {
      const payload = await apiGet<unknown>(`/api/devices/${encodeURIComponent(did)}/light`);
      if (gen !== this.generation || !this.device) return;
      this.readPending = false;
      const normalized = normalizeLightPayload(payload);
      this.props = normalized.props;
      this.powerProp = normalized.powerProp;
      this.values = { ...normalized.values };

      if (Object.keys(this.props).length === 0) {
        this.onEmptyClose();
        return;
      }

      this.setupControls();
      this.render();
      this.startPolling();
    } catch {
      if (gen !== this.generation) return;
      this.readPending = false;
      this.dom.status.textContent = "暂时无法读取或设置灯光，请稍后重试。";
      this.dom.status.hidden = false;
    }
  }

  private setupControls(): void {
    if (this.powerProp) {
      this.dom.powerBtn.hidden = false;
      this.dom.powerText.hidden = false;
    }
    this.dom.brightnessRow.hidden = !this.props.brightness;
    this.dom.tempRow.hidden = !this.props.temperature;
    this.dom.colorRow.hidden = !this.props.color;
    this.dom.body.hidden = false;
  }

  private startPolling(): void {
    if (this.pollTimer !== null) {
      window.clearInterval(this.pollTimer);
    }
    this.pollTimer = window.setInterval(() => {
      void this.refresh();
    }, 2000);
  }

  private async refresh(): Promise<void> {
    if (!this.device || this.busy || this.readPending) return;
    if (this.sliderDown.brightness || this.sliderDown.temperature) return;
    const gen = this.generation;
    const rev = this.revision;
    const did = this.device.did;
    this.readPending = true;
    try {
      const payload = await apiGet<unknown>(`/api/devices/${encodeURIComponent(did)}/light`);
      if (gen !== this.generation || !this.device) return;
      this.readPending = false;
      if (
        !this.busy &&
        rev === this.revision &&
        !this.sliderDown.brightness &&
        !this.sliderDown.temperature
      ) {
        const normalized = normalizeLightPayload(payload);
        if (Object.keys(normalized.props).length > 0) {
          this.props = normalized.props;
        }
        if (normalized.powerProp) {
          this.powerProp = normalized.powerProp;
        }
        Object.assign(this.values, normalized.values);
        this.render();
      }
    } catch {
      if (gen !== this.generation) return;
      this.readPending = false;
    }
  }

  private adjustmentsAllowed(): boolean {
    if (this.busy || !this.powerProp) return false;
    return this.values[this.powerProp.name] === true;
  }

  private computePropValue(kind: "brightness" | "temperature"): number {
    const prop = this.props[kind];
    const slider = kind === "brightness" ? this.dom.brightnessSlider : this.dom.tempSlider;
    if (!prop || !prop.range || prop.range.length < 2) return 0;
    const low = prop.range[0];
    const high = prop.range[1];
    const maxSlider = Number(slider.max) || (kind === "brightness" ? 100 : 1000);
    const pos = Number(slider.value);
    let value =
      kind === "brightness" ? (high * pos) / 100 : low + ((high - low) * pos) / maxSlider;
    const step = prop.range.length > 2 && prop.range[2] ? prop.range[2] : 1;
    value = Math.max(low, Math.min(high, low + Math.round((value - low) / step) * step));
    return prop.type === "float" ? Number(value) : Math.round(value);
  }

  private updateSliderPreview(kind: "brightness" | "temperature"): void {
    const prop = this.props[kind];
    const valNode = kind === "brightness" ? this.dom.brightnessVal : this.dom.tempVal;
    if (!prop || !prop.range || prop.range.length < 2) {
      valNode.textContent = "—";
      return;
    }
    let val = this.computePropValue(kind);
    if (kind === "brightness") {
      val = Math.round((100 * val) / prop.range[1]);
    }
    valNode.textContent = `${formatNumberGeneral(val)}${kind === "brightness" ? "%" : " K"}`;
  }

  private render(): void {
    const allowed = this.adjustmentsAllowed();
    if (this.powerProp) {
      const raw = this.values[this.powerProp.name];
      const state = typeof raw === "boolean" ? raw : null;
      this.dom.powerBtn.hidden = false;
      this.dom.powerBtn.disabled = state === null || this.busy;
      this.dom.powerBtn.classList.remove("is-on", "is-off", "is-unknown", "is-busy");
      if (this.busy) {
        this.dom.powerBtn.classList.add("is-busy");
      } else if (state === true) {
        this.dom.powerBtn.classList.add("is-on");
      } else if (state === false) {
        this.dom.powerBtn.classList.add("is-off");
      } else {
        this.dom.powerBtn.classList.add("is-unknown");
      }
      this.dom.powerText.hidden = false;
      this.dom.powerText.textContent =
        state === null ? "状态待确认" : state ? "已开启" : "已关闭";
      if (typeof state === "boolean" && this.device) {
        this.onPowerSynced(this.device.did, state);
      }
    }

    for (const kind of ["brightness", "temperature"] as const) {
      const prop = this.props[kind];
      const slider = kind === "brightness" ? this.dom.brightnessSlider : this.dom.tempSlider;
      if (!prop || !prop.range || prop.range.length < 2) continue;
      const raw = this.values[prop.name];
      const hasNumeric = typeof raw === "number" && Number.isFinite(raw);
      slider.disabled = !(allowed && hasNumeric && !this.busy);
      if (hasNumeric) {
        const [low, high] = prop.range;
        const maxSlider = Number(slider.max) || (kind === "brightness" ? 100 : 1000);
        const fraction = kind === "brightness" ? raw / high : (raw - low) / (high - low);
        slider.value = String(Math.max(0, Math.min(maxSlider, Math.round(fraction * maxSlider))));
        this.updateSliderPreview(kind);
      }
    }

    if (this.props.color) {
      this.dom.colorBtn.disabled = !(allowed && !this.busy);
      const rawColor = this.values[this.props.color.name];
      if (typeof rawColor === "number" && Number.isFinite(rawColor)) {
        const hex = rgbIntToHex(rawColor);
        this.dom.colorDot.style.background = hex;
        this.dom.colorPicker.value = hex;
      }
    }

    this.dom.status.textContent = "";
    this.dom.status.hidden = true;
  }

  private async writeProp(name: string, value: unknown): Promise<void> {
    if (!this.device || this.busy) return;
    if ((!this.powerProp || name !== this.powerProp.name) && !this.adjustmentsAllowed()) {
      return;
    }
    const gen = this.generation;
    const did = this.device.did;
    this.busy = true;
    this.revision += 1;
    this.dom.powerBtn.disabled = true;
    this.dom.brightnessSlider.disabled = true;
    this.dom.tempSlider.disabled = true;
    this.dom.colorBtn.disabled = true;
    this.dom.status.textContent = "正在设置…";
    this.dom.status.hidden = false;

    try {
      await apiPost(`/api/devices/${encodeURIComponent(did)}/prop`, { name, value });
      if (gen !== this.generation || !this.device) return;
      this.busy = false;
      this.values[name] = value;
      this.render();
      void this.refresh();
    } catch {
      if (gen !== this.generation) return;
      this.busy = false;
      this.render();
      this.dom.status.textContent = "暂时无法读取或设置灯光，请稍后重试。";
      this.dom.status.hidden = false;
    }
  }
}

function normalizePropInfo(raw: unknown): PropInfo | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const name = readStr(rec, "name");
  if (!name) return null;
  const rangeRaw = rec.range;
  let range: [number, number, number] | [number, number] | null = null;
  if (Array.isArray(rangeRaw) && rangeRaw.length >= 2) {
    const a = Number(rangeRaw[0]);
    const b = Number(rangeRaw[1]);
    if (Number.isFinite(a) && Number.isFinite(b)) {
      range =
        rangeRaw.length >= 3 && Number.isFinite(Number(rangeRaw[2]))
          ? [a, b, Number(rangeRaw[2])]
          : [a, b];
    }
  }
  return {
    name,
    desc: readStr(rec, "desc") ?? name,
    type: readStr(rec, "type") ?? "uint",
    readable: readBool(rec, "readable") ?? true,
    writable: readBool(rec, "writable") ?? true,
    range,
    value_list: Array.isArray(rec.value_list) ? (rec.value_list as PropInfo["value_list"]) : null,
  };
}

function normalizeLightPayload(raw: unknown): NormalizedLightPayload {
  const rec = asRecord(raw) ?? {};
  const values: Record<string, unknown> = {};
  const rawVals = asRecord(rec.values);
  if (rawVals) {
    Object.assign(values, rawVals);
  }

  let powerProp: PropInfo | null = null;
  const rawPowerProp = normalizePropInfo(rec.powerProp ?? rec.power_prop);
  if (rawPowerProp) {
    powerProp = rawPowerProp;
  }

  const props: Partial<Record<LightPropertyKind, PropInfo>> = {};

  // Server GET /api/devices/:did/light returns pre-filtered `controls` map alongside raw `props`
  const controlsRec = asRecord(rec.controls);
  if (controlsRec) {
    for (const kind of ["brightness", "temperature", "color"] as const) {
      const parsed = normalizePropInfo(controlsRec[kind]);
      if (parsed) props[kind] = parsed;
    }
  }

  const propsField = rec.props;

  if (Array.isArray(propsField)) {
    extractLightPropsFromList(propsField, props, (p) => {
      if (!powerProp) powerProp = p;
    });
  } else {
    const propsRec = asRecord(propsField);
    if (propsRec) {
      for (const kind of ["brightness", "temperature", "color"] as const) {
        if (!(kind in props)) {
          const parsed = normalizePropInfo(propsRec[kind]);
          if (parsed) props[kind] = parsed;
        }
      }
      if (!powerProp) {
        const maybePower = normalizePropInfo(propsRec.power ?? propsRec.on);
        if (maybePower) powerProp = maybePower;
      }
    }
  }

  const detailRec = asRecord(rec.detail);
  if (detailRec && Array.isArray(detailRec.props)) {
    extractLightPropsFromList(detailRec.props, props, (p) => {
      if (!powerProp) powerProp = p;
    });
  }

  // Fallback synthesis if backend returned flat fields (power, brightness, colorTemperature, color)
  const flatPower = readBool(rec, "power", "powerState", "power_state", "on");
  if (flatPower !== undefined) {
    if (!powerProp) {
      powerProp = {
        name: "on",
        desc: "开关",
        type: "bool",
        readable: true,
        writable: true,
        range: null,
        value_list: null,
      };
    }
    if (!(powerProp.name in values)) {
      values[powerProp.name] = flatPower;
    }
  }
  const flatBright = readNum(rec, "brightness");
  if (flatBright !== undefined && !props.brightness) {
    props.brightness = {
      name: "brightness",
      desc: "亮度",
      type: "uint",
      readable: true,
      writable: true,
      range: [1, 100, 1],
      value_list: null,
    };
    values.brightness = flatBright;
  }
  const flatTemp = readNum(rec, "temperature", "color_temperature", "colorTemperature");
  if (flatTemp !== undefined && !props.temperature) {
    props.temperature = {
      name: "color-temperature",
      desc: "色温",
      type: "uint",
      readable: true,
      writable: true,
      range: [2700, 6500, 1],
      value_list: null,
    };
    values["color-temperature"] = flatTemp;
  }

  return { props, powerProp, values };
}

function extractLightPropsFromList(
  list: unknown[],
  out: Partial<Record<LightPropertyKind, PropInfo>>,
  onPower: (prop: PropInfo) => void,
): void {
  for (const item of list) {
    const prop = normalizePropInfo(item);
    if (!prop) continue;
    if (
      prop.type === "bool" &&
      prop.writable &&
      (prop.name === "on" || prop.name.startsWith("on-") || prop.name.startsWith("on_"))
    ) {
      onPower(prop);
    }
    const normalized = prop.name.replaceAll("_", "-").replace(/-[0-9]+$/, "");
    const kind = LIGHT_PROP_MAP[normalized];
    if (!kind || !prop.writable) continue;
    if (kind !== "color" && (!prop.range || prop.range.length < 2 || prop.range[0] >= prop.range[1])) {
      continue;
    }
    if (!(kind in out)) {
      out[kind] = prop;
    }
  }
}

// ---------------------------------------------------------------------------
// Main Application Client
// ---------------------------------------------------------------------------

export class MijiaDeckWebApp {
  private state: AppState;
  private activeModal: ModalName | null = null;
  private trayOpen = false;
  private trayLightOpen = false;
  private trayDraggedPos: { x: number; y: number } | null = null;
  private trayIntroTriggered = false;

  // Busy states for optimistic feedback
  private busyDevices = new Set<string>();
  private busyScenes = new Set<string>();
  private refreshing = false;

  // Toast timer
  private toastTimer: number | null = null;

  // WebSocket
  private ws: WebSocket | null = null;
  private wsReconnectTimer: number | null = null;
  private wsBackoffMs = 1000;

  // Typewriters
  private voiceFabTypewriter: TypewriterPlaceholder;
  private trayVoiceTypewriter: TypewriterPlaceholder;
  private voiceFabExpanded = false;

  // Room strip drag-to-scroll state
  private roomPress: { x: number; y: number; scrollLeft: number } | null = null;
  private roomDragged = false;
  private roomSuppressClick = false;

  // Settings draft & live preview revert snapshot
  private settingsOriginal: { mode: ThemeMode; color: string } | null = null;
  private settingsDraft: {
    tab: "appearance" | "features" | "voice-agent";
    mode: ThemeMode;
    color: string;
    customColor: string;
    uiScale: number;
  } = {
    tab: "appearance",
    mode: "system",
    color: "green",
    customColor: "#333333",
    uiScale: 1.0,
  };
  private agentConfigCache: UiPublicAgentConfig | null = null;
  private agentProvidersCache: UiProviderPreset[] = [];
  private localVoiceStatusCache: UiLocalVoiceStatus | null = null;
  private voiceprintProfilesCache: UiVoiceprintProfile[] = [];
  private owwPrototypesCache: UiWakeWordPrototypeSummary[] = [];
  private vpRecordingBusy = false;
  private owwRecordingBusy = false;
  private lastAutoFilledWakeWord = "";
  private agentClearKeyPending = false;
  private sttClearKeyPending = false;
  private agentModelsFetchGen = 0;
  private agentModelsDebounceTimer: number | null = null;

  // Tray manager draft
  private trayMgrTab: "devices" | "scenes" = "devices";
  private trayMgrView: "list" | "sort" = "list";
  private trayMgrRoom = "";
  private trayMgrCheckedDevices = new Set<string>();
  private trayMgrCheckedScenes = new Set<string>();
  private trayMgrOrder: TrayOrderItem[] = [];
  private trayMgrDragKey: string | null = null;

  // Light, full device detail & Pi Agent controllers
  private modalLightSession: LightControlSession;
  private trayLightSession: LightControlSession;
  private deviceDetailModal: DeviceDetailModalController;
  private piAgentPanel: PiAgentPanelController;

  // Camera preview state
  private cameraDevice: DeviceInfo | null = null;
  private cameraPowerState: boolean | null = null;
  private cameraPowerBusy = false;
  private cameraMuted = true;
  private cameraQuality: 0 | 1 | 2 = 1;
  private cameraFullscreen = false;
  private cameraPress: { x: number; y: number } | null = null;
  private cameraGestureSent = false;
  private cameraLastDragMs = 0;
  private cameraDragBusyUntil = 0;
  private cameraPtzOffset = { x: 0, y: 0 };
  private cameraPtzFeedbackTimer: number | null = null;
  private cameraFrameTimer: number | null = null;

  // Login modal state
  private loginGeneration = 0;

  // Diagnostics state
  private diagDevices: DeviceInfo[] = [];
  private diagGeneration = 0;

  // Audio bar drag tracking
  private audioSliderDown = false;
  private audioPollTimer: number | null = null;

  constructor() {
    this.state = this.createDefaultState();

    this.voiceFabTypewriter = new TypewriterPlaceholder(
      el<HTMLInputElement>("voice-fab-input"),
      VOICE_FAB_HINT,
      () => this.voiceFabExpanded && !el("voice-fab").hidden,
    );
    this.trayVoiceTypewriter = new TypewriterPlaceholder(
      el<HTMLInputElement>("tray-voice-input"),
      TRAY_VOICE_HINT,
      () => this.trayOpen && !this.trayLightOpen && !el("tray-voice-bar").hidden,
    );

    this.modalLightSession = new LightControlSession(
      {
        title: el("light-modal-title"),
        powerBtn: el<HTMLButtonElement>("light-power-btn"),
        powerText: el("light-power-text"),
        body: el("light-body"),
        status: el("light-status"),
        brightnessRow: el("light-brightness-row"),
        brightnessSlider: el<HTMLInputElement>("light-brightness-slider"),
        brightnessVal: el("light-brightness-val"),
        tempRow: el("light-temp-row"),
        tempSlider: el<HTMLInputElement>("light-temp-slider"),
        tempVal: el("light-temp-val"),
        colorRow: el("light-color-row"),
        colorBtn: el<HTMLButtonElement>("light-color-btn"),
        colorDot: el("light-color-dot"),
        colorPicker: el<HTMLInputElement>("light-color-picker"),
      },
      (did, state) => this.updateDevicePowerLocally(did, state),
      () => {
        if (this.activeModal === "light") this.closeModal();
      },
    );

    this.trayLightSession = new LightControlSession(
      {
        title: el("tray-light-title"),
        powerBtn: el<HTMLButtonElement>("tray-light-power-btn"),
        powerText: el("tray-light-power-text"),
        body: el("tray-light-body"),
        status: el("tray-light-status"),
        brightnessRow: el("tray-light-brightness-row"),
        brightnessSlider: el<HTMLInputElement>("tray-light-brightness-slider"),
        brightnessVal: el("tray-light-brightness-val"),
        tempRow: el("tray-light-temp-row"),
        tempSlider: el<HTMLInputElement>("tray-light-temp-slider"),
        tempVal: el("tray-light-temp-val"),
        colorRow: el("tray-light-color-row"),
        colorBtn: el<HTMLButtonElement>("tray-light-color-btn"),
        colorDot: el("tray-light-color-dot"),
        colorPicker: el<HTMLInputElement>("tray-light-color-picker"),
      },
      (did, state) => this.updateDevicePowerLocally(did, state),
      () => this.closeTrayLightPage(),
    );

    this.deviceDetailModal = new DeviceDetailModalController({
      apiGet,
      apiPost,
      deviceIconSvg,
      getIconUrl: (dev) => this.state.icons[dev.model] ?? this.state.icons[dev.did] ?? null,
      getDeviceByDid: (did) => this.state.devices.find((d) => d.did === did),
      isCamera,
      isSpeaker,
      deviceTitle,
      showToast: (msg, ms) => this.showToast(msg, ms),
      onPowerSynced: (did, st) => this.updateDevicePowerLocally(did, st),
      onTrayMembershipToggle: async (did, selected) => {
        await this.setTrayMembership("device", did, selected);
      },
      openDiagnostics: (did) => this.openDiagnosticsModal(did),
      openCameraPreview: (dev) => this.openCameraModal(dev),
      openOtherDevice: (dev) => this.openDeviceDetailModal(dev),
      closeSelf: () => {
        if (this.activeModal === "device-detail") this.closeModal();
      },
    });

    this.piAgentPanel = new PiAgentPanelController({
      apiGet,
      apiPost,
      isWsOpen: () => this.ws !== null && this.ws.readyState === WebSocket.OPEN,
      sendWsJson: (payload) => {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
        try {
          this.ws.send(JSON.stringify(payload));
          return true;
        } catch {
          return false;
        }
      },
      sendWsBinary: (buffer) => {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
        try {
          this.ws.send(buffer);
          return true;
        } catch {
          return false;
        }
      },
      showToast: (msg, ms) => this.showToast(msg, ms),
      openVoiceAgentSettings: () => {
        void this.openSettingsModal("voice-agent");
      },
    });
  }

  private createDefaultState(): AppState {
    return {
      version: "1.1.2",
      apiVersion: "",
      demo: false,
      accessState: "ready",
      loggedIn: true,
      networkOnline: true,
      loading: {
        active: false,
        fullPage: false,
        showFooter: false,
        progress: 0,
        stage: "",
        loadingDevices: false,
      },
      homes: [],
      currentHome: ALL_HOMES,
      rooms: [],
      roomMenu: null,
      currentRoom: ALL_ROOMS,
      devices: [],
      visibleDevices: null,
      scenes: [],
      knownPower: {},
      metrics: {},
      icons: {},
      trayDevices: [],
      trayScenes: [],
      trayOrder: [],
      trayColumns: 2,
      trayIntroSeen: true,
      settings: {
        theme: "system",
        theme_color: "green",
        custom_theme_color: "#333333",
        ui_scale: 1.0,
        voice_fab_enabled: true,
        show_scene_tab: true,
        autostart: false,
        autostart_supported: false,
        default_speaker_did: "",
        minimize_to_tray: true,
        start_minimized: false,
        hide_no_func_devices: false,
        check_update_enabled: true,
        tray_columns: 2,
        tray_intro_seen: true,
      },
      resolvedTheme: "dark",
      resolvedAccent: "green",
      release: null,
      statusText: "",
      audio: {
        did: null,
        name: "小爱音箱",
        volume: null,
        muted: null,
        min: 0,
        max: 100,
        volName: "volume",
        muteName: "mute-2",
      },
    };
  }

  // -------------------------------------------------------------------------
  // Boot & Lifecycle
  // -------------------------------------------------------------------------

  async init(): Promise<void> {
    this.bindGlobalEvents();
    this.bindTitleBarEvents();
    this.bindHeaderEvents();
    this.bindRoomStripDrag();
    this.bindVoiceFabEvents();
    this.bindFooterEvents();
    this.bindTrayEvents();
    this.bindModalEvents();
    this.bindSettingsEvents();
    this.bindCameraEvents();
    this.bindTrayManagerEvents();
    this.bindLoginEvents();
    this.bindDiagnosticsEvents();
    this.bindAboutEvents();
    this.piAgentPanel.bindEvents();

    this.renderAll();
    await this.fetchState();
    this.connectWebSocket();
  }

  // -------------------------------------------------------------------------
  // State Fetching & Normalization
  // -------------------------------------------------------------------------

  async fetchState(): Promise<void> {
    try {
      const raw = await apiGet<unknown>("/api/state");
      this.applyStatePatch(raw);
      if (!this.state.trayIntroSeen && !this.trayIntroTriggered && !this.activeModal) {
        this.trayIntroTriggered = true;
        this.openModal("tray-intro");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.showToast(`加载状态失败：${msg}`, 3500);
    }
  }

  private applyStatePatch(raw: unknown): void {
    const outer = asRecord(raw);
    if (!outer) return;
    const rec = asRecord(outer.state) ?? outer;

    const prevTheme = this.state.resolvedTheme;
    const prevAccent = this.state.resolvedAccent;

    const appRec = asRecord(rec.app);
    const version =
      readStr(rec, "version", "appVersion", "app_version") ??
      (appRec ? readStr(appRec, "version") : undefined);
    if (version) this.state.version = version;

    const apiVersion =
      readStr(rec, "apiVersion", "api_version") ??
      (appRec ? readStr(appRec, "apiVersion", "api_version") : undefined);
    if (apiVersion !== undefined) this.state.apiVersion = apiVersion;

    const modeStr = readStr(rec, "mode");
    const demo = readBool(rec, "demo", "isDemo", "demoMode", "demo_mode");
    if (demo !== undefined) {
      this.state.demo = demo;
    } else if (modeStr !== undefined) {
      this.state.demo = modeStr === "demo" || modeStr === "virtual-light";
    }

    const networkOnline = readBool(rec, "networkOnline", "network_online");
    if (networkOnline !== undefined) this.state.networkOnline = networkOnline;

    const loggedIn = readBool(rec, "loggedIn", "logged_in");
    const loggedOut = readBool(rec, "loggedOut", "logged_out");
    if (loggedIn !== undefined) {
      this.state.loggedIn = loggedIn;
    } else if (loggedOut !== undefined) {
      this.state.loggedIn = !loggedOut;
    }

    const accessState = readStr(rec, "accessState", "access_state");
    if (
      accessState === "ready" ||
      accessState === "offline" ||
      accessState === "signed_out" ||
      accessState === "loading" ||
      accessState === "unavailable"
    ) {
      this.state.accessState = accessState;
    } else if (!this.state.networkOnline) {
      this.state.accessState = "offline";
    } else if (!this.state.loggedIn) {
      this.state.accessState = "signed_out";
    }

    const loadingRec = asRecord(rec.loading);
    if (loadingRec) {
      this.state.loading = {
        active: readBool(loadingRec, "active", "loading") ?? this.state.loading.active,
        fullPage: readBool(loadingRec, "fullPage", "full_page") ?? this.state.loading.fullPage,
        showFooter:
          readBool(loadingRec, "showFooter", "show_footer") ?? this.state.loading.showFooter,
        progress: readNum(loadingRec, "progress", "value") ?? this.state.loading.progress,
        stage: readStr(loadingRec, "stage", "text", "message") ?? this.state.loading.stage,
        loadingDevices:
          readBool(loadingRec, "loadingDevices", "loading_devices") ??
          this.state.loading.loadingDevices,
      };
    }

    if (Array.isArray(rec.homes)) {
      this.state.homes = rec.homes.map((h) => String(h));
    }
    const currentHome = readStr(rec, "currentHome", "current_home");
    if (currentHome !== undefined) {
      this.state.currentHome = currentHome || ALL_HOMES;
    }
    if (Array.isArray(rec.rooms)) {
      this.state.rooms = rec.rooms.map((r) => String(r));
    }
    if (Array.isArray(rec.roomMenu)) {
      const entries: RoomMenuEntry[] = [];
      for (const item of rec.roomMenu) {
        const entryRec = asRecord(item);
        if (!entryRec) continue;
        const name = readStr(entryRec, "name");
        if (!name) continue;
        const countRaw = entryRec.count;
        const count =
          typeof countRaw === "number" && Number.isFinite(countRaw) ? countRaw : null;
        entries.push({
          name,
          count,
          selected: readBool(entryRec, "selected"),
        });
      }
      this.state.roomMenu = entries;
    }
    const currentRoom = readStr(rec, "currentRoom", "current_room");
    if (currentRoom !== undefined) {
      this.state.currentRoom = currentRoom || ALL_ROOMS;
    }

    if (Array.isArray(rec.devices)) {
      this.state.devices = rec.devices
        .map(normalizeDeviceInfo)
        .filter((d): d is DeviceInfo => d !== null);
    }
    if (Array.isArray(rec.visibleDevices)) {
      this.state.visibleDevices = rec.visibleDevices
        .map(normalizeDeviceInfo)
        .filter((d): d is DeviceInfo => d !== null);
    }
    if (Array.isArray(rec.scenes)) {
      this.state.scenes = rec.scenes
        .map(normalizeSceneInfo)
        .filter((s): s is SceneInfo => s !== null);
    }

    const powerObj = asRecord(rec.knownPower ?? rec.known_power ?? rec.powerStates ?? rec.power_states);
    if (powerObj) {
      const next: Record<string, boolean | null> = {};
      for (const [k, v] of Object.entries(powerObj)) {
        next[k] = typeof v === "boolean" ? v : null;
      }
      this.state.knownPower = next;
    }

    const metricsObj = asRecord(rec.metrics);
    if (metricsObj) {
      const next: Record<string, string | null> = {};
      for (const [k, v] of Object.entries(metricsObj)) {
        next[k] = typeof v === "string" ? v : null;
      }
      this.state.metrics = next;
    }

    const iconsObj = asRecord(rec.icons ?? rec.iconUrls ?? rec.icon_urls);
    if (iconsObj) {
      const next: Record<string, string | null> = {};
      for (const [k, v] of Object.entries(iconsObj)) {
        next[k] = typeof v === "string" ? v : null;
      }
      this.state.icons = next;
    }

    // Settings
    const settingsRec = asRecord(rec.settings);
    if (settingsRec) {
      this.applySettingsObject(settingsRec);
    }

    // Theme info
    const themeRec = asRecord(rec.theme);
    let themeVisualChanged = false;
    if (themeRec) {
      const resolved = readStr(themeRec, "resolved", "effective", "name", "current");
      if (resolved === "light" || resolved === "dark") {
        this.state.resolvedTheme = resolved;
        if (resolved !== prevTheme) themeVisualChanged = true;
      }
      const mode = readStr(themeRec, "mode");
      if (mode === "system" || mode === "light" || mode === "dark") {
        this.state.settings.theme = mode;
      }
      const color = readStr(themeRec, "color", "accent");
      if (color) {
        this.state.settings.theme_color = color;
        this.state.resolvedAccent = color;
        if (color !== prevAccent) themeVisualChanged = true;
      }
      const customAccent = readStr(themeRec, "customAccent", "custom_accent", "customColor");
      if (customAccent) {
        this.state.settings.custom_theme_color = customAccent;
      }
    }

    // Tray block or flat fields
    const trayRec = asRecord(rec.tray);
    if (trayRec) {
      if (Array.isArray(trayRec.devices)) {
        this.state.trayDevices = trayRec.devices.map((d) => String(d));
      }
      if (Array.isArray(trayRec.scenes)) {
        this.state.trayScenes = trayRec.scenes
          .map(normalizeSceneInfo)
          .filter((s): s is SceneInfo => s !== null);
      }
      if (Array.isArray(trayRec.order)) {
        this.state.trayOrder = normalizeTrayOrder(trayRec.order);
      }
      const cols = readNum(trayRec, "columns", "tray_columns");
      if (cols === 1 || cols === 2) {
        this.state.trayColumns = cols;
        this.state.settings.tray_columns = cols;
      }
      const introSeen = readBool(trayRec, "introSeen", "intro_seen", "tray_intro_seen");
      if (introSeen !== undefined) {
        this.state.trayIntroSeen = introSeen;
        this.state.settings.tray_intro_seen = introSeen;
      }
      const speakerDid = readStr(
        trayRec,
        "selectedSpeakerDid",
        "speakerDid",
        "speaker_did",
        "default_speaker_did",
      );
      if (speakerDid !== undefined) {
        this.state.settings.default_speaker_did = speakerDid;
      }
    }
    if (Array.isArray(rec.trayDevices ?? rec.tray_devices)) {
      this.state.trayDevices = ((rec.trayDevices ?? rec.tray_devices) as unknown[]).map((d) =>
        String(d),
      );
    }
    if (Array.isArray(rec.trayScenes ?? rec.tray_scenes)) {
      this.state.trayScenes = ((rec.trayScenes ?? rec.tray_scenes) as unknown[])
        .map(normalizeSceneInfo)
        .filter((s): s is SceneInfo => s !== null);
    }
    if (Array.isArray(rec.trayOrder ?? rec.tray_order)) {
      this.state.trayOrder = normalizeTrayOrder((rec.trayOrder ?? rec.tray_order) as unknown[]);
    }
    const flatCols = readNum(rec, "trayColumns", "tray_columns");
    if (flatCols === 1 || flatCols === 2) {
      this.state.trayColumns = flatCols;
    }
    const flatIntro = readBool(rec, "trayIntroSeen", "tray_intro_seen");
    if (flatIntro !== undefined) {
      this.state.trayIntroSeen = flatIntro;
    }

    // Footer & Release / update
    const footerRec = asRecord(rec.footer);
    if (footerRec) {
      const fStatus = readStr(footerRec, "statusText", "status_text");
      if (fStatus !== undefined) this.state.statusText = fStatus;
      if ("release" in footerRec) {
        this.state.release = normalizeReleaseInfo(footerRec.release);
      }
    }
    const updateRec = asRecord(rec.update);
    if (updateRec && "release" in updateRec) {
      this.state.release = normalizeReleaseInfo(updateRec.release);
    } else if ("release" in rec || "latestRelease" in rec) {
      this.state.release = normalizeReleaseInfo(rec.release ?? rec.latestRelease);
    }

    const statusText = readStr(rec, "statusText", "status_text");
    if (statusText !== undefined) {
      this.state.statusText = statusText;
    }

    // Audio / speaker readout (handles AudioBarSnapshot from tray.audio)
    const audioRec = asRecord(rec.audio ?? rec.speaker ?? trayRec?.audio);
    if (audioRec) {
      const vol = readNum(audioRec, "volume", "sliderValue");
      if (vol !== undefined) this.state.audio.volume = Math.trunc(vol);
      const muted = readBool(audioRec, "muted");
      if (muted !== undefined) this.state.audio.muted = muted;
      const min = readNum(audioRec, "min", "sliderMin");
      if (min !== undefined) this.state.audio.min = Math.trunc(min);
      const max = readNum(audioRec, "max", "sliderMax");
      if (max !== undefined) this.state.audio.max = Math.trunc(max);
      const volName = readStr(audioRec, "volName", "vol_name");
      if (volName) this.state.audio.volName = volName;
      const muteName = readStr(audioRec, "muteName", "mute_name");
      if (muteName) this.state.audio.muteName = muteName;
    }

    this.syncActiveSpeaker();
    if ("piAgent" in rec && rec.piAgent) {
      this.piAgentPanel.applyAgentSnapshot(rec.piAgent);
      const cfg = this.piAgentPanel.getConfig();
      if (cfg) this.agentConfigCache = cfg;
      const provs = this.piAgentPanel.getProviders();
      if (provs.length > 0) this.agentProvidersCache = provs;
    }
    if ("voiceListen" in rec && rec.voiceListen) {
      this.piAgentPanel.applyVoiceSnapshot(rec.voiceListen);
    }
    if (themeVisualChanged) {
      this.reloadThemeStylesheet();
    }
    this.renderAll();
  }

  private applySettingsObject(rec: Record<string, unknown>): void {
    const s = this.state.settings;
    const mode = readStr(rec, "theme", "themeMode", "theme_mode");
    if (mode === "system" || mode === "light" || mode === "dark") s.theme = mode;
    const color = readStr(rec, "theme_color", "themeColor");
    if (color) s.theme_color = color;
    const custom = readStr(rec, "custom_theme_color", "customThemeColor");
    if (custom) s.custom_theme_color = custom;
    const scale = readNum(rec, "ui_scale", "uiScale");
    if (scale !== undefined) s.ui_scale = scale;
    const fab = readBool(rec, "voice_fab_enabled", "voiceFabEnabled");
    if (fab !== undefined) s.voice_fab_enabled = fab;
    const sceneTab = readBool(rec, "show_scene_tab", "showSceneTab");
    if (sceneTab !== undefined) s.show_scene_tab = sceneTab;
    const autostart = readBool(rec, "autostart");
    if (autostart !== undefined) s.autostart = autostart;
    const autostartSup = readBool(rec, "autostart_supported", "autostartSupported");
    if (autostartSup !== undefined) s.autostart_supported = autostartSup;
    const defSpk = readStr(rec, "default_speaker_did", "defaultSpeakerDid");
    if (defSpk !== undefined) s.default_speaker_did = defSpk;
    const minTray = readBool(rec, "minimize_to_tray", "minimizeToTray");
    if (minTray !== undefined) s.minimize_to_tray = minTray;
    const startMin = readBool(rec, "start_minimized", "startMinimized");
    if (startMin !== undefined) s.start_minimized = startMin;
    const hideNoFunc = readBool(rec, "hide_no_func_devices", "hideNoFuncDevices");
    if (hideNoFunc !== undefined) s.hide_no_func_devices = hideNoFunc;
    const checkUpd = readBool(rec, "check_update_enabled", "checkUpdateEnabled");
    if (checkUpd !== undefined) s.check_update_enabled = checkUpd;
    const cols = readNum(rec, "tray_columns", "trayColumns");
    if (cols === 1 || cols === 2) {
      s.tray_columns = cols;
      this.state.trayColumns = cols;
    }
    const intro = readBool(rec, "tray_intro_seen", "trayIntroSeen");
    if (intro !== undefined) {
      s.tray_intro_seen = intro;
      this.state.trayIntroSeen = intro;
    }
  }

  private syncActiveSpeaker(): void {
    const spk = this.pickActiveSpeaker();
    if (!spk) {
      this.state.audio.did = null;
      this.state.audio.name = "小爱音箱";
      return;
    }
    const changed = this.state.audio.did !== spk.did;
    this.state.audio.did = spk.did;
    this.state.audio.name = spk.name;
    if (changed && this.state.audio.volume === null) {
      this.state.audio.volume = 50;
    }
  }

  private pickActiveSpeaker(): DeviceInfo | null {
    if (this.state.accessState !== "ready") return null;
    const pref = this.state.settings.default_speaker_did;
    if (pref) {
      const found = this.state.devices.find((d) => d.did === pref && isSpeaker(d) && d.online);
      if (found) return found;
    }
    return this.state.devices.find((d) => isSpeaker(d) && d.online) ?? null;
  }

  private devicesInCurrentHome(): DeviceInfo[] {
    const home = this.state.currentHome;
    return this.state.devices.filter((d) => !home || home === ALL_HOMES || d.home_name === home);
  }

  private computeRoomTabs(): string[] {
    if (this.state.rooms.length > 0) {
      return [...this.state.rooms];
    }
    const inHome = this.devicesInCurrentHome();
    const roomSet = new Set<string>();
    for (const d of inHome) {
      if (d.room_name) roomSet.add(d.room_name);
    }
    const rooms = [...roomSet].sort((a, b) => a.localeCompare(b, "zh-CN"));
    const tabs: string[] = [];
    if (this.state.settings.show_scene_tab) {
      tabs.push(SCENE_TAB);
    }
    tabs.push(ALL_ROOMS, ...rooms);
    return tabs;
  }

  // -------------------------------------------------------------------------
  // WebSocket Live Synchronization
  // -------------------------------------------------------------------------

  private connectWebSocket(): void {
    this.setWsStatus("reconnecting", "连接中…");
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${window.location.host}/ws`;

    try {
      const ws = new WebSocket(url);
      this.ws = ws;

      ws.addEventListener("open", () => {
        this.wsBackoffMs = 1000;
        this.setWsStatus("connected", "实时同步");
      });

      ws.addEventListener("message", (event) => {
        try {
          const msg = JSON.parse(String(event.data)) as unknown;
          this.handleWsMessage(msg);
        } catch {
          // ignore malformed ws frame
        }
      });

      ws.addEventListener("close", () => {
        if (this.ws === ws) this.ws = null;
        this.scheduleWsReconnect();
      });

      ws.addEventListener("error", () => {
        ws.close();
      });
    } catch {
      this.scheduleWsReconnect();
    }
  }

  private scheduleWsReconnect(): void {
    this.setWsStatus("reconnecting", "重连中…");
    if (this.wsReconnectTimer !== null) return;
    const delay = this.wsBackoffMs;
    this.wsBackoffMs = Math.min(10000, this.wsBackoffMs * 2);
    this.wsReconnectTimer = window.setTimeout(() => {
      this.wsReconnectTimer = null;
      this.connectWebSocket();
    }, delay);
  }

  private setWsStatus(cls: "connected" | "reconnecting" | "offline", label: string): void {
    const dot = el("ws-dot");
    dot.className = `ws-dot ${cls}`;
    el("ws-label").textContent = label;
  }

  private handleWsMessage(raw: unknown): void {
    const msg = asRecord(raw);
    if (!msg) return;
    const type = readStr(msg, "type", "event") ?? "";
    const payload = msg.state ?? msg.payload ?? msg.data ?? msg;

    switch (type) {
      case "state":
      case "snapshot":
      case "sync":
      case "state_changed":
        this.applyStatePatch(payload);
        break;
      case "toast":
      case "notify": {
        const p = asRecord(payload) ?? msg;
        const text = readStr(p, "message", "text");
        if (text) {
          this.showToast(text, readNum(p, "durationMs", "duration") ?? 3000);
        }
        break;
      }
      case "theme":
      case "theme_changed": {
        const p = asRecord(payload) ?? msg;
        const resolved = readStr(p, "resolved", "theme", "name");
        if (resolved === "light" || resolved === "dark") {
          this.state.resolvedTheme = resolved;
        }
        this.reloadThemeStylesheet();
        this.renderTitleBar();
        break;
      }
      case "power":
      case "power_states": {
        const p = asRecord(payload);
        if (p) {
          const statesRec = asRecord(p.states ?? p.powerStates) ?? p;
          for (const [did, val] of Object.entries(statesRec)) {
            if (typeof val === "boolean" || val === null) {
              this.state.knownPower[did] = val;
            }
          }
          this.renderGrid();
          if (this.trayOpen && !this.trayLightOpen) this.renderTrayCards();
        }
        break;
      }
      case "metrics": {
        const p = asRecord(payload);
        if (p) {
          const mRec = asRecord(p.metrics) ?? p;
          for (const [did, val] of Object.entries(mRec)) {
            if (typeof val === "string" || val === null) {
              this.state.metrics[did] = val;
            }
          }
          this.renderGrid();
          if (this.trayOpen && !this.trayLightOpen) this.renderTrayCards();
        }
        break;
      }
      case "loading":
      case "progress": {
        const p = asRecord(payload) ?? msg;
        this.state.loading = {
          active: readBool(p, "active") ?? true,
          fullPage: readBool(p, "fullPage", "full_page") ?? this.state.loading.fullPage,
          showFooter: readBool(p, "showFooter", "show_footer") ?? true,
          progress: readNum(p, "progress", "value") ?? this.state.loading.progress,
          stage: readStr(p, "stage", "text", "message") ?? this.state.loading.stage,
          loadingDevices:
            readBool(p, "loadingDevices", "loading_devices") ??
            this.state.loading.loadingDevices,
        };
        this.renderLoadingAndFooter();
        break;
      }
      case "tray":
      case "tray_changed":
        this.applyStatePatch({ tray: payload });
        break;
      case "update":
      case "release":
        this.state.release = normalizeReleaseInfo(payload);
        this.renderLoadingAndFooter();
        break;
      case "agent_state":
        this.piAgentPanel.applyAgentSnapshot(payload);
        {
          const cfg = this.piAgentPanel.getConfig();
          if (cfg) this.agentConfigCache = cfg;
          const provs = this.piAgentPanel.getProviders();
          if (provs.length > 0) this.agentProvidersCache = provs;
        }
        break;
      case "agent_event":
        this.piAgentPanel.handleStreamEvent(payload);
        break;
      case "voice_state":
        this.piAgentPanel.applyVoiceSnapshot(payload);
        if (this.activeModal === "settings" && this.settingsDraft.tab === "voice-agent") {
          const snap = this.piAgentPanel.getVoiceSnapshot();
          if (snap?.localEngine) this.localVoiceStatusCache = snap.localEngine;
          if (Array.isArray(snap?.wakeWordPrototypes)) {
            this.owwPrototypesCache = snap.wakeWordPrototypes;
            this.renderOwwPrototypes();
          }
          this.renderVoicePipelineStatus();
          this.syncSystemOneStatusDesc();
        }
        break;
      case "agent_speak": {
        const p = asRecord(payload) ?? msg;
        const text = readStr(p, "text", "message");
        if (text) {
          this.piAgentPanel.handleSpeakEvent(text);
        }
        break;
      }
      case "agent_speak_chunk": {
        const p = asRecord(payload) ?? msg;
        const text = readStr(p, "text", "message");
        if (text) {
          this.piAgentPanel.handleSpeakChunkEvent(text);
        }
        break;
      }
      case "voice_stream_event":
        this.piAgentPanel.handleVoiceStreamEvent(msg);
        break;
      default:
        // If server sends raw state object without a `type` wrapper
        if ("devices" in msg || "accessState" in msg || "access_state" in msg) {
          this.applyStatePatch(msg);
        }
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Theme Reload (Zero-Flicker Stylesheet Swap)
  // -------------------------------------------------------------------------

  reloadThemeStylesheet(): void {
    const existingLinks = Array.from(
      document.querySelectorAll<HTMLLinkElement>('link#theme-stylesheet, link[data-md-theme-sheet="1"]'),
    );
    const anchor = existingLinks[existingLinks.length - 1] ?? null;
    const nextHref = `/theme.css?t=${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const nextLink = document.createElement("link");
    nextLink.rel = "stylesheet";
    nextLink.dataset.mdThemeSheet = "1";
    nextLink.href = nextHref;
    nextLink.addEventListener("load", () => {
      for (const old of existingLinks) {
        old.remove();
      }
      nextLink.id = "theme-stylesheet";
      this.detectResolvedThemeFromCss();
    });
    nextLink.addEventListener("error", () => {
      nextLink.remove();
    });
    if (anchor) {
      anchor.insertAdjacentElement("afterend", nextLink);
    } else {
      document.head.prepend(nextLink);
    }
  }

  private detectResolvedThemeFromCss(): void {
    const bg = getComputedStyle(document.documentElement)
      .getPropertyValue("--window-bg")
      .trim() ||
      getComputedStyle(document.documentElement)
        .getPropertyValue("--md-window-bg")
        .trim();
    if (bg.startsWith("#") && bg.length >= 7) {
      const r = Number.parseInt(bg.slice(1, 3), 16);
      const g = Number.parseInt(bg.slice(3, 5), 16);
      const b = Number.parseInt(bg.slice(5, 7), 16);
      const lightness = (Math.max(r, g, b) + Math.min(r, g, b)) / 2;
      this.state.resolvedTheme = lightness >= 128 ? "light" : "dark";
      this.renderTitleBar();
    }
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  private renderAll(): void {
    this.renderTitleBar();
    this.renderLoadingAndFooter();
    this.renderHeader();
    this.renderRoomTabs();
    this.renderAccessAndGrid();
    this.renderVoiceFab();
    if (this.trayOpen) {
      this.renderTrayWindow();
    }
  }

  private renderTitleBar(): void {
    el("demo-badge").hidden = !this.state.demo;
    const isLightTheme = this.state.resolvedTheme === "light";
    el("theme-icon-sun").hidden = isLightTheme;
    el("theme-icon-moon").hidden = !isLightTheme;

    const trayBtn = el<HTMLButtonElement>("tray-toggle-btn");
    trayBtn.classList.toggle("active", this.trayOpen);
    trayBtn.setAttribute("aria-expanded", String(this.trayOpen));
  }

  private renderLoadingAndFooter(): void {
    const fullLoad = this.state.loading.active && this.state.loading.fullPage;
    el("loading-page").hidden = !fullLoad;
    el("main-workspace").hidden = fullLoad;
    el("footer-bar").hidden = fullLoad;

    if (fullLoad) {
      const pct = Math.max(0, Math.min(100, Math.round(this.state.loading.progress)));
      el("loading-progress-fill").style.width = `${pct}%`;
      el("loading-progress-bar").setAttribute("aria-valuenow", String(pct));
      el("loading-status").textContent = this.state.loading.stage || "正在准备设备…";
      return;
    }

    // Footer bar (matches FooterBarController._syncStatus)
    const inlineLoading = this.state.loading.active && this.state.loading.showFooter;
    const statusText = inlineLoading ? this.state.loading.stage : this.state.statusText;

    el("footer-version-btn").textContent = `当前版本号:v${this.state.version}`;
    el("footer-version-btn").hidden = Boolean(statusText) || inlineLoading;

    const updateBtn = el("footer-update-btn");
    if (this.state.release) {
      updateBtn.textContent = `发现新版 ${this.state.release.tag}`;
      updateBtn.hidden = Boolean(statusText) || inlineLoading;
    } else {
      updateBtn.hidden = true;
    }

    el("footer-progress-wrap").hidden = !inlineLoading;
    if (inlineLoading) {
      const pct = Math.max(0, Math.min(100, Math.round(this.state.loading.progress)));
      el("footer-progress-chunk").style.width = `${pct}%`;
      el("footer-progress-bar").setAttribute("aria-valuenow", String(pct));
    }

    const statusEl = el("footer-status");
    statusEl.textContent = statusText;
    statusEl.hidden = !statusText;

    el("footer-account-btn").textContent = this.state.loggedIn ? "退出登录" : "登录账号";
  }

  private renderHeader(): void {
    const ready = this.state.accessState === "ready";
    el("home-switcher-btn").hidden = !ready;
    el("device-summary").hidden = !ready;

    const homeLabel = this.state.currentHome || (this.state.homes.length > 1 ? ALL_HOMES : "我的家庭");
    el("home-switcher-text").textContent = homeLabel;

    const inHome = this.devicesInCurrentHome();
    const onlineCount = inHome.filter((d) => d.online).length;
    el("device-total-count").textContent = String(inHome.length);
    el("device-online-count").textContent = String(onlineCount);

    const refreshBtn = el<HTMLButtonElement>("refresh-btn");
    const busy = this.refreshing || this.state.loading.active || this.state.loading.loadingDevices;
    refreshBtn.disabled = busy;
    refreshBtn.classList.toggle("spinning", busy);
    refreshBtn.setAttribute("aria-label", busy ? "正在刷新…" : "刷新设备");
  }

  private renderRoomTabs(): void {
    const ready = this.state.accessState === "ready";
    el("room-bar").hidden = !ready;
    if (!ready) return;

    const tabs = this.computeRoomTabs();
    if (!tabs.includes(this.state.currentRoom)) {
      this.state.currentRoom = ALL_ROOMS;
    }

    const strip = el("room-strip");
    strip.replaceChildren();
    for (const name of tabs) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "room-tab";
      if (name === this.state.currentRoom) {
        btn.classList.add("active");
      }
      btn.setAttribute("role", "tab");
      btn.setAttribute("aria-selected", String(name === this.state.currentRoom));
      btn.textContent = name;
      btn.addEventListener("click", () => {
        if (this.roomSuppressClick) {
          this.roomSuppressClick = false;
          return;
        }
        void this.selectRoom(name);
      });
      strip.appendChild(btn);
    }
  }

  private renderAccessAndGrid(): void {
    const state = this.state.accessState;
    const ready = state === "ready";
    const banner = el("access-banner");
    const bannerText = el("access-banner-text");
    const bannerAction = el<HTMLButtonElement>("access-banner-action");
    const scroll = el("card-grid-scroll");

    if (!ready) {
      scroll.hidden = true;
      banner.hidden = false;
      banner.classList.add("full-center");
      bannerText.textContent = ACCESS_MESSAGES[state] || "设备暂不可用";
      if (state === "signed_out") {
        bannerAction.hidden = false;
        bannerAction.textContent = "扫码登录小米账号";
        bannerAction.onclick = () => this.openLoginModal();
      } else if (state === "offline" || state === "unavailable") {
        bannerAction.hidden = false;
        bannerAction.textContent = "重新连接";
        bannerAction.onclick = () => void this.refreshDevices();
      } else {
        bannerAction.hidden = true;
      }
      return;
    }

    scroll.hidden = false;
    banner.classList.remove("full-center");
    const spkHint = this.state.devices.length > 0 ? speakerHint(this.state.devices) : "";
    if (spkHint) {
      banner.hidden = false;
      bannerText.textContent = spkHint;
      bannerAction.hidden = true;
    } else {
      banner.hidden = true;
    }

    this.renderGrid();
  }

  private renderGrid(): void {
    const grid = el("card-grid");
    const emptyBox = el("grid-empty");
    const emptyTitle = el("grid-empty-title");
    const emptyDetail = el("grid-empty-detail");

    grid.replaceChildren();

    if (this.state.currentRoom === SCENE_TAB) {
      const home = this.state.currentHome;
      const scenes = this.state.scenes.filter(
        (s) => !home || home === ALL_HOMES || !s.home_name || s.home_name === home,
      );
      if (scenes.length === 0) {
        grid.hidden = true;
        emptyBox.hidden = false;
        emptyTitle.textContent = "暂无手动场景";
        emptyDetail.textContent = "可在米家 APP「智能」中创建手动场景后点击右上角刷新";
        return;
      }
      grid.hidden = false;
      emptyBox.hidden = true;
      for (const scene of scenes) {
        grid.appendChild(this.createSceneCard(scene));
      }
      return;
    }

    const inHome = this.devicesInCurrentHome();
    const room = this.state.currentRoom;
    const source = this.state.visibleDevices !== null ? this.state.visibleDevices : inHome;
    const filtered = source
      .filter((d) => room === ALL_ROOMS || d.room_name === room)
      .sort((a, b) => {
        if (a.online !== b.online) return a.online ? -1 : 1;
        return a.name.localeCompare(b.name, "zh-CN");
      });

    if (filtered.length === 0) {
      grid.hidden = true;
      emptyBox.hidden = false;
      emptyTitle.textContent = "当前房间暂无设备";
      emptyDetail.textContent = "切换其他房间或点击右上角刷新按钮同步最新设备";
      return;
    }

    grid.hidden = false;
    emptyBox.hidden = true;
    for (const device of filtered) {
      grid.appendChild(this.createDeviceCard(device));
    }
  }

  private createDeviceCard(device: DeviceInfo): HTMLElement {
    const card = document.createElement("article");
    card.className = "device-card clickable";
    if (!device.online) card.classList.add("offline");
    card.dataset.did = device.did;
    card.title = device.online ? "点击查看设备详情与完整操作" : "设备离线，点击查看设备信息与规格";

    // Corner tags
    if (isCamera(device)) {
      const tag = document.createElement("span");
      tag.className = "corner-tag corner-tag-camera";
      tag.textContent = "摄像头";
      tag.setAttribute("aria-label", "摄像头 CAMERA");
      card.appendChild(tag);
    } else if (isLight(device) && hasDeviceDetails(device)) {
      const tag = document.createElement("span");
      tag.className = "corner-tag corner-tag-led";
      tag.textContent = "LED";
      tag.setAttribute("aria-label", "可调灯光 LED");
      card.appendChild(tag);
    }

    // Device icon
    const iconBox = document.createElement("div");
    iconBox.className = "device-card-icon";
    const iconUrl = this.state.icons[device.model] ?? this.state.icons[device.did];
    if (iconUrl) {
      const img = document.createElement("img");
      img.src = iconUrl;
      img.alt = "";
      img.loading = "lazy";
      img.addEventListener("error", () => {
        iconBox.innerHTML = deviceIconSvg(device.model);
      });
      iconBox.appendChild(img);
    } else {
      iconBox.innerHTML = deviceIconSvg(device.model);
    }
    card.appendChild(iconBox);

    // Name & subtitle
    const textCol = document.createElement("div");
    textCol.className = "device-card-text";
    const nameEl = document.createElement("div");
    nameEl.className = "device-card-name";
    nameEl.textContent = deviceTitle(device);
    const subEl = document.createElement("div");
    subEl.className = "device-card-sub";
    subEl.textContent = deviceSubtitle(
      device,
      device.online ? this.state.metrics[device.did] : null,
      this.state.knownPower,
    );
    textCol.append(nameEl, subEl);
    card.appendChild(textCol);

    // Right action button (Power or Camera Play)
    if (isCamera(device)) {
      const playBtn = document.createElement("button");
      playBtn.type = "button";
      playBtn.className = "camera-play-btn";
      playBtn.disabled = !device.online;
      playBtn.setAttribute("aria-label", device.online ? "查看摄像头画面" : "摄像头离线");
      playBtn.innerHTML = PLAY_OUTLINE_SVG;
      playBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (device.online) this.openCameraModal(device);
      });
      card.appendChild(playBtn);
    } else if (supportsCardPower(device)) {
      const powerState = this.state.knownPower[device.did];
      if (powerState !== undefined || !device.online) {
        const powerBtn = this.createPowerButton(device, powerState ?? null, false);
        card.appendChild(powerBtn);
      }
    }

    // Card click opens camera preview (for online cameras) or full device detail modal
    card.addEventListener("click", () => {
      if (isCamera(device) && device.online) {
        this.openCameraModal(device);
      } else {
        this.openDeviceDetailModal(device);
      }
    });

    // Right-click context menu: view details, tray membership (when eligible), diagnostics
    card.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const menuItems: Array<{ label: string; onClick: () => void }> = [
        {
          label: "查看详情与操作",
          onClick: () => this.openDeviceDetailModal(device),
        },
      ];
      if (isCamera(device) && device.online) {
        menuItems.push({
          label: "打开摄像头画面",
          onClick: () => this.openCameraModal(device),
        });
      }
      if (trayEligible(device)) {
        const inTray = this.state.trayDevices.includes(device.did);
        menuItems.push({
          label: inTray ? "从托盘窗口移除" : "添加到托盘窗口",
          onClick: () => void this.setTrayMembership("device", device.did, !inTray),
        });
      }
      menuItems.push({
        label: "设备诊断报告",
        onClick: () => this.openDiagnosticsModal(device.did),
      });
      this.showContextMenu(e.clientX, e.clientY, menuItems);
    });

    return card;
  }

  private createPowerButton(
    device: DeviceInfo,
    powerState: boolean | null,
    small: boolean,
  ): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = small ? "power-btn power-btn-sm" : "power-btn";
    const busy = this.busyDevices.has(device.did);

    if (!device.online) {
      btn.classList.add("is-offline");
      btn.disabled = true;
      btn.innerHTML = POWER_ICON_SVG;
      btn.setAttribute("aria-label", `${device.name} 离线`);
    } else if (busy) {
      btn.classList.add("is-busy");
      btn.disabled = true;
      btn.innerHTML = POWER_ICON_SVG;
      btn.setAttribute("aria-label", `${device.name} 正在切换`);
    } else if (powerState === null) {
      btn.classList.add("is-unknown");
      btn.innerHTML = UNKNOWN_ICON_SVG;
      btn.setAttribute("aria-label", `切换 ${device.name} 开关`);
    } else if (powerState) {
      btn.classList.add("is-on");
      btn.innerHTML = POWER_ICON_SVG;
      btn.setAttribute("aria-label", `关闭 ${device.name}`);
    } else {
      btn.classList.add("is-off");
      btn.innerHTML = POWER_ICON_SVG;
      btn.setAttribute("aria-label", `开启 ${device.name}`);
    }

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!device.online || this.busyDevices.has(device.did)) return;
      void this.toggleDevicePower(device);
    });
    return btn;
  }

  private createSceneCard(scene: SceneInfo): HTMLElement {
    const card = document.createElement("article");
    card.className = "scene-card";
    card.dataset.sceneId = scene.scene_id;

    const textCol = document.createElement("div");
    textCol.className = "device-card-text";
    const nameEl = document.createElement("div");
    nameEl.className = "scene-card-name";
    nameEl.textContent = scene.name;
    const subEl = document.createElement("div");
    subEl.className = "scene-card-sub";
    subEl.textContent = scene.home_name || "手动场景";
    textCol.append(nameEl, subEl);

    const runBtn = document.createElement("button");
    runBtn.type = "button";
    runBtn.className = "scene-run-btn";
    const busy = this.busyScenes.has(scene.scene_id);
    if (busy) runBtn.classList.add("is-busy");
    runBtn.disabled = busy;
    runBtn.setAttribute("aria-label", `执行场景 ${scene.name}`);
    runBtn.innerHTML = PLAY_SOLID_SVG;
    runBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.runScene(scene);
    });

    card.append(textCol, runBtn);

    card.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const inTray = this.state.trayScenes.some((s) => s.scene_id === scene.scene_id);
      this.showContextMenu(e.clientX, e.clientY, [
        {
          label: inTray ? "从托盘窗口移除" : "添加到托盘窗口",
          onClick: () => void this.setTrayMembership("scene", scene.scene_id, !inTray),
        },
      ]);
    });

    return card;
  }

  private renderVoiceFab(): void {
    const fullLoad = this.state.loading.active && this.state.loading.fullPage;
    const ready = this.state.accessState === "ready";
    const hasSpeaker = this.state.devices.some((d) => isSpeaker(d) && d.online);
    const shouldShow =
      !fullLoad && ready && hasSpeaker && this.state.settings.voice_fab_enabled;

    const fab = el("voice-fab");
    fab.hidden = !shouldShow;
    el("toast-card").classList.toggle("no-fab", !shouldShow);

    if (!shouldShow && this.voiceFabExpanded) {
      this.collapseVoiceFab();
    }
  }

  // -------------------------------------------------------------------------
  // Tray Quick Window Rendering & Interactions
  // -------------------------------------------------------------------------

  private toggleTrayWindow(force?: boolean): void {
    const next = force !== undefined ? force : !this.trayOpen;
    this.trayOpen = next;
    const win = el("tray-quick-window");
    win.hidden = !next;

    if (next) {
      if (this.trayDraggedPos) {
        win.style.left = `${this.trayDraggedPos.x}px`;
        win.style.top = `${this.trayDraggedPos.y}px`;
        win.style.right = "auto";
        win.style.bottom = "auto";
      }
      this.renderTrayWindow();
      this.startTrayAudioPolling();
    } else {
      this.closeTrayLightPage();
      this.trayVoiceTypewriter.stop(true);
      this.stopTrayAudioPolling();
    }
    this.renderTitleBar();
  }

  private renderTrayWindow(): void {
    el("tray-overview-page").hidden = this.trayLightOpen;
    el("tray-light-page").hidden = !this.trayLightOpen;
    if (this.trayLightOpen) {
      this.trayVoiceTypewriter.stop(false);
      return;
    }

    const ready = this.state.accessState === "ready";
    const speaker = this.pickActiveSpeaker();
    const showAudio = ready && speaker !== null;

    el("tray-audio-bar").hidden = !showAudio;
    el("tray-audio-divider").hidden = !showAudio;
    el("tray-quick-drag-handle").hidden = showAudio;
    el("tray-drag-header").hidden = !ready;

    if (showAudio && speaker) {
      el("tray-speaker-name").textContent = speaker.name;
      this.renderTrayAudioControls();
    }

    // Columns button icon & tooltip
    const cols = this.state.trayColumns;
    const colsBtn = el<HTMLButtonElement>("tray-cols-btn");
    const tip = cols === 1 ? "单列显示，点击切换双列" : "双列显示，点击切换单列";
    colsBtn.title = tip;
    colsBtn.setAttribute("aria-label", tip);
    el("tray-cols-icon-2").hidden = cols === 1;
    el("tray-cols-icon-1").hidden = cols === 2;

    this.renderTrayCards();

    // Speaker hint & Voice bar
    const hint = ready && this.state.devices.length > 0 ? speakerHint(this.state.devices) : "";
    const hintEl = el("tray-speaker-hint");
    hintEl.textContent = hint;
    hintEl.hidden = !hint;

    const voiceBar = el("tray-voice-bar");
    const showVoice = ready && speaker !== null;
    const wasHidden = voiceBar.hidden;
    voiceBar.hidden = !showVoice;
    if (showVoice && (wasHidden || !this.trayVoiceTypewriter.isRunning())) {
      this.trayVoiceTypewriter.start();
    } else if (!showVoice) {
      this.trayVoiceTypewriter.stop(true);
    }
  }

  private renderTrayAudioControls(): void {
    const { volume, muted, min, max } = this.state.audio;
    const playBtn = el<HTMLButtonElement>("tray-audio-play");
    const isMuted = muted === true;
    el("tray-icon-play").hidden = !isMuted;
    el("tray-icon-pause").hidden = isMuted;
    const label = isMuted ? "播放" : "暂停";
    playBtn.title = label;
    playBtn.setAttribute("aria-label", label);

    const slider = el<HTMLInputElement>("tray-volume-slider");
    slider.min = String(min);
    slider.max = String(max);
    if (!this.audioSliderDown) {
      const displayVal = volume !== null ? Math.max(min, Math.min(max, volume)) : Math.round((min + max) / 2);
      slider.value = String(displayVal);
      this.updateTrayVolumeVisual(displayVal, volume !== null ? String(volume) : "—");
    }
  }

  private updateTrayVolumeVisual(numericValue: number, textLabel: string): void {
    const min = this.state.audio.min;
    const max = this.state.audio.max;
    const span = Math.max(1, max - min);
    const pct = Math.max(0, Math.min(100, ((numericValue - min) / span) * 100));
    el("tray-volume-fill").style.width = `${pct}%`;
    el("tray-volume-thumb").style.left = `${pct}%`;
    el("tray-volume-readout").textContent = textLabel;
  }

  private renderTrayCards(): void {
    const listScroll = el("tray-list-scroll");
    const list = el("tray-card-list");
    const empty = el("tray-empty");
    list.replaceChildren();
    list.className = `tray-card-list cols-${this.state.trayColumns}`;

    if (this.state.accessState !== "ready") {
      listScroll.hidden = true;
      empty.hidden = false;
      empty.textContent = ACCESS_MESSAGES[this.state.accessState] || "设备暂不可用";
      return;
    }

    const devMap = new Map(this.state.devices.map((d) => [d.did, d]));
    const trayDevSet = new Set(this.state.trayDevices);
    const sceneMap = new Map<string, SceneInfo>();
    for (const s of this.state.trayScenes) sceneMap.set(s.scene_id, s);
    for (const s of this.state.scenes) {
      if (sceneMap.has(s.scene_id)) sceneMap.set(s.scene_id, s);
    }

    const items: Array<{ type: "device"; device: DeviceInfo } | { type: "scene"; scene: SceneInfo }> =
      [];
    const seen = new Set<string>();

    for (const item of this.state.trayOrder) {
      const key = `${item.type}:${item.id}`;
      if (seen.has(key)) continue;
      if (item.type === "device" && trayDevSet.has(item.id)) {
        const dev = devMap.get(item.id);
        if (dev && trayEligible(dev)) {
          items.push({ type: "device", device: dev });
          seen.add(key);
        }
      } else if (item.type === "scene") {
        const scene = sceneMap.get(item.id);
        if (scene) {
          items.push({ type: "scene", scene });
          seen.add(key);
        }
      }
    }

    for (const did of this.state.trayDevices) {
      const key = `device:${did}`;
      if (seen.has(key)) continue;
      const dev = devMap.get(did);
      if (dev && trayEligible(dev)) {
        items.push({ type: "device", device: dev });
        seen.add(key);
      }
    }
    for (const scene of this.state.trayScenes) {
      const key = `scene:${scene.scene_id}`;
      if (seen.has(key)) continue;
      items.push({ type: "scene", scene: sceneMap.get(scene.scene_id) ?? scene });
      seen.add(key);
    }

    if (items.length === 0) {
      listScroll.hidden = true;
      empty.hidden = false;
      empty.innerHTML = "暂无卡片<br>点击右上角编辑图标添加";
      return;
    }

    listScroll.hidden = false;
    empty.hidden = true;

    for (const entry of items) {
      if (entry.type === "device") {
        list.appendChild(this.createTrayDeviceRow(entry.device));
      } else {
        list.appendChild(this.createTraySceneRow(entry.scene));
      }
    }
  }

  private createTrayDeviceRow(device: DeviceInfo): HTMLElement {
    const row = document.createElement("div");
    const cam = isCamera(device);
    const adjLight = isLight(device) && hasDeviceDetails(device);
    const clickable = hasDeviceDetails(device) && device.online;

    row.className = "tray-card";
    if (!device.online) row.classList.add("offline");
    if (clickable) row.classList.add("clickable");
    if (cam || adjLight) row.classList.add("has-tag");

    if (cam) {
      const tag = document.createElement("span");
      tag.className = "corner-tag corner-tag-camera";
      tag.textContent = "摄像头";
      row.appendChild(tag);
    } else if (adjLight) {
      const tag = document.createElement("span");
      tag.className = "corner-tag corner-tag-led";
      tag.textContent = "LED";
      row.appendChild(tag);
    }

    const dot = document.createElement("span");
    dot.className = `tray-status-dot${device.online ? "" : " offline"}`;
    row.appendChild(dot);

    const textCol = document.createElement("div");
    textCol.className = "tray-card-text";
    const nameEl = document.createElement("div");
    nameEl.className = "tray-card-name";
    nameEl.textContent = deviceTitle(device);
    const subEl = document.createElement("div");
    subEl.className = "tray-card-sub";
    subEl.textContent = deviceSubtitle(
      device,
      device.online ? this.state.metrics[device.did] : null,
      this.state.knownPower,
    ).replaceAll("\n", " · ");
    textCol.append(nameEl, subEl);
    row.appendChild(textCol);

    if (cam) {
      const playBtn = document.createElement("button");
      playBtn.type = "button";
      playBtn.className = "camera-play-btn sm";
      playBtn.disabled = !device.online;
      playBtn.setAttribute("aria-label", device.online ? "查看摄像头画面" : "摄像头离线");
      playBtn.innerHTML = PLAY_OUTLINE_SVG;
      playBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (device.online) this.openCameraModal(device);
      });
      row.appendChild(playBtn);
    } else if (supportsCardPower(device)) {
      const known = this.state.knownPower[device.did];
      if (known !== undefined || !device.online) {
        row.appendChild(this.createPowerButton(device, known ?? null, true));
      }
    }

    row.classList.add("clickable");
    row.addEventListener("click", () => {
      if (cam && device.online) {
        this.openCameraModal(device);
      } else if (adjLight && device.online) {
        this.openTrayLightPage(device);
      } else {
        this.openDeviceDetailModal(device);
      }
    });

    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.showContextMenu(e.clientX, e.clientY, [
        {
          label: "查看详情与操作",
          onClick: () => this.openDeviceDetailModal(device),
        },
        {
          label: "从托盘窗口移除",
          onClick: () => void this.setTrayMembership("device", device.did, false),
        },
      ]);
    });

    return row;
  }

  private createTraySceneRow(scene: SceneInfo): HTMLElement {
    const row = document.createElement("div");
    row.className = "tray-card";

    const dot = document.createElement("span");
    dot.className = "tray-status-dot scene";
    row.appendChild(dot);

    const textCol = document.createElement("div");
    textCol.className = "tray-card-text";
    const nameEl = document.createElement("div");
    nameEl.className = "tray-card-name";
    nameEl.textContent = scene.name;
    const subEl = document.createElement("div");
    subEl.className = "tray-card-sub";
    subEl.textContent = scene.home_name || "手动场景";
    textCol.append(nameEl, subEl);
    row.appendChild(textCol);

    const runBtn = document.createElement("button");
    runBtn.type = "button";
    runBtn.className = "scene-run-btn sm";
    const busy = this.busyScenes.has(scene.scene_id);
    if (busy) runBtn.classList.add("is-busy");
    runBtn.disabled = busy;
    runBtn.setAttribute("aria-label", `执行场景 ${scene.name}`);
    runBtn.innerHTML = PLAY_SOLID_SVG;
    runBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.runScene(scene);
    });
    row.appendChild(runBtn);

    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.showContextMenu(e.clientX, e.clientY, [
        {
          label: "从托盘窗口移除",
          onClick: () => void this.setTrayMembership("scene", scene.scene_id, false),
        },
      ]);
    });

    return row;
  }

  private openTrayLightPage(device: DeviceInfo): void {
    this.trayLightOpen = true;
    this.renderTrayWindow();
    this.trayLightSession.open(device);
  }

  private closeTrayLightPage(): void {
    if (!this.trayLightOpen) return;
    this.trayLightOpen = false;
    this.trayLightSession.close();
    if (this.trayOpen) {
      this.renderTrayWindow();
    }
  }

  private startTrayAudioPolling(): void {
    this.stopTrayAudioPolling();
    this.audioPollTimer = window.setInterval(() => {
      if (this.trayOpen && !this.trayLightOpen && !this.audioSliderDown && this.state.audio.did) {
        void this.fetchState();
      }
    }, 5000);
  }

  private stopTrayAudioPolling(): void {
    if (this.audioPollTimer !== null) {
      window.clearInterval(this.audioPollTimer);
      this.audioPollTimer = null;
    }
  }

  // -------------------------------------------------------------------------
  // Actions (REST API Calls)
  // -------------------------------------------------------------------------

  private async refreshDevices(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    this.renderHeader();
    try {
      const res = await apiPost<unknown>("/api/devices/refresh");
      const rec = asRecord(res);
      if (rec) {
        this.applyStatePatch(rec);
        const summary = readStr(rec, "summary", "message");
        if (summary) this.showToast(summary, 2800);
      } else {
        await this.fetchState();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.showToast(`刷新设备失败：${msg}`, 3500);
    } finally {
      this.refreshing = false;
      this.renderHeader();
    }
  }

  private async toggleDevicePower(device: DeviceInfo, explicitState?: boolean): Promise<void> {
    if (this.busyDevices.has(device.did)) return;
    this.busyDevices.add(device.did);
    this.renderGrid();
    if (this.trayOpen && !this.trayLightOpen) this.renderTrayCards();

    try {
      const body = explicitState !== undefined ? { state: explicitState } : {};
      const res = await apiPost<unknown>(
        `/api/devices/${encodeURIComponent(device.did)}/power`,
        body,
      );
      const rec = asRecord(res);
      const nextState =
        (rec && readBool(rec, "state", "power", "on")) ??
        (explicitState !== undefined
          ? explicitState
          : typeof this.state.knownPower[device.did] === "boolean"
            ? !this.state.knownPower[device.did]
            : true);
      this.state.knownPower[device.did] = nextState;
      if (rec && "devices" in rec) {
        this.applyStatePatch(rec);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.showToast(`开关「${device.name}」失败：${msg}`, 3500);
    } finally {
      this.busyDevices.delete(device.did);
      this.renderGrid();
      if (this.trayOpen && !this.trayLightOpen) this.renderTrayCards();
    }
  }

  private updateDevicePowerLocally(did: string, state: boolean): void {
    if (this.state.knownPower[did] !== state) {
      this.state.knownPower[did] = state;
      this.renderGrid();
      if (this.trayOpen && !this.trayLightOpen) this.renderTrayCards();
    }
  }

  private async runScene(scene: SceneInfo): Promise<void> {
    if (this.busyScenes.has(scene.scene_id)) return;
    this.busyScenes.add(scene.scene_id);
    this.renderGrid();
    if (this.trayOpen && !this.trayLightOpen) this.renderTrayCards();

    try {
      await apiPost(`/api/scenes/${encodeURIComponent(scene.scene_id)}/run`, {
        homeId: scene.home_id,
        home_id: scene.home_id,
        name: scene.name,
      });
      this.showToast(`已执行场景「${scene.name}」`, 2200);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.showToast(`执行场景「${scene.name}」失败：${msg}`, 4000);
    } finally {
      this.busyScenes.delete(scene.scene_id);
      this.renderGrid();
      if (this.trayOpen && !this.trayLightOpen) this.renderTrayCards();
    }
  }

  private async submitVoiceCommand(rawText: string, explicitDid?: string): Promise<void> {
    const text = rawText.trim();
    if (!text) return;
    const did = explicitDid ?? this.pickActiveSpeaker()?.did;
    try {
      const res = await apiPost<unknown>("/api/voice", did ? { text, did } : { text });
      const rec = asRecord(res);
      const reply = rec && readStr(rec, "message", "toast");
      this.showToast(reply || `已告诉小爱同学：${text}`, 3000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.showToast(`执行失败：${msg}`, 4000);
    }
  }

  private async selectHome(home: string): Promise<void> {
    this.closeAllMenus();
    const target = home || ALL_HOMES;
    this.state.currentHome = target;
    this.state.currentRoom = ALL_ROOMS;
    this.state.visibleDevices = null;
    this.state.rooms = [];
    this.state.roomMenu = null;
    this.renderHeader();
    this.renderRoomTabs();
    this.renderAccessAndGrid();
    try {
      const res = await apiPost<unknown>("/api/home", { home: target });
      if (asRecord(res)) this.applyStatePatch(res);
    } catch {
      // optimistic UI already applied
    }
  }

  private async selectRoom(room: string): Promise<void> {
    this.closeAllMenus();
    if (this.state.currentRoom === room) return;
    this.state.currentRoom = room;
    this.state.visibleDevices = null;
    this.renderRoomTabs();
    this.renderGrid();
    try {
      const res = await apiPost<unknown>("/api/room", { room });
      if (asRecord(res)) this.applyStatePatch(res);
    } catch {
      // optimistic UI already applied
    }
  }

  private async setTrayMembership(
    kind: "device" | "scene",
    id: string,
    selected: boolean,
  ): Promise<void> {
    try {
      const res = await apiPost<unknown>("/api/tray/membership", { kind, id, selected });
      const rec = asRecord(res);
      if (rec && ("state" in rec || "tray" in rec || "trayDevices" in rec)) {
        this.applyStatePatch(rec);
      } else {
        this.applyLocalTrayMembership(kind, id, selected);
      }
      this.showToast(selected ? "已添加到托盘快捷窗口" : "已从托盘快捷窗口移除", 2200);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.showToast(`更新托盘项目失败：${msg}`, 3000);
    }
  }

  private applyLocalTrayMembership(
    kind: "device" | "scene",
    id: string,
    selected: boolean,
  ): void {
    if (kind === "device") {
      if (selected) {
        if (!this.state.trayDevices.includes(id)) this.state.trayDevices.push(id);
        if (!this.state.trayOrder.some((o) => o.type === "device" && o.id === id)) {
          this.state.trayOrder.push({ type: "device", id });
        }
      } else {
        this.state.trayDevices = this.state.trayDevices.filter((d) => d !== id);
        this.state.trayOrder = this.state.trayOrder.filter(
          (o) => !(o.type === "device" && o.id === id),
        );
      }
    } else {
      if (selected) {
        const scene = this.state.scenes.find((s) => s.scene_id === id);
        if (scene && !this.state.trayScenes.some((s) => s.scene_id === id)) {
          this.state.trayScenes.push({ ...scene });
        }
        if (!this.state.trayOrder.some((o) => o.type === "scene" && o.id === id)) {
          this.state.trayOrder.push({ type: "scene", id });
        }
      } else {
        this.state.trayScenes = this.state.trayScenes.filter((s) => s.scene_id !== id);
        this.state.trayOrder = this.state.trayOrder.filter(
          (o) => !(o.type === "scene" && o.id === id),
        );
      }
    }
    if (this.trayOpen) this.renderTrayWindow();
  }

  private async toggleTrayColumns(): Promise<void> {
    const next: 1 | 2 = this.state.trayColumns === 2 ? 1 : 2;
    this.state.trayColumns = next;
    this.state.settings.tray_columns = next;
    this.renderTrayWindow();
    try {
      await apiPost("/api/tray/columns", { columns: next });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.showToast(`切换列数失败：${msg}`, 2500);
    }
  }

  private async selectTraySpeaker(did: string): Promise<void> {
    this.closeAllMenus();
    this.state.settings.default_speaker_did = did;
    this.syncActiveSpeaker();
    this.renderTrayWindow();
    try {
      const res = await apiPost<unknown>("/api/tray/speaker", { did });
      if (asRecord(res)) this.applyStatePatch(res);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.showToast(`切换音箱失败：${msg}`, 2500);
    }
  }

  private async triggerSpeakerStep(direction: "previous" | "next"): Promise<void> {
    const did = this.state.audio.did;
    if (!did) return;
    const btn = el<HTMLButtonElement>(
      direction === "previous" ? "tray-audio-prev" : "tray-audio-next",
    );
    btn.disabled = true;
    try {
      try {
        await apiPost(`/api/devices/${encodeURIComponent(did)}/action`, { name: direction });
      } catch {
        // Fallback to voice directive if backend exposes only /api/voice
        await apiPost("/api/voice", {
          text: direction === "previous" ? "上一首" : "下一首",
          did,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.showToast(`操作失败：${msg}`, 2500);
    } finally {
      btn.disabled = false;
    }
  }

  private async toggleSpeakerMute(): Promise<void> {
    const did = this.state.audio.did;
    if (!did) return;
    const btn = el<HTMLButtonElement>("tray-audio-play");
    const nextMuted = typeof this.state.audio.muted === "boolean" ? !this.state.audio.muted : true;
    btn.disabled = true;
    try {
      await apiPost(`/api/devices/${encodeURIComponent(did)}/prop`, {
        name: this.state.audio.muteName || "mute-2",
        value: nextMuted,
      });
      this.state.audio.muted = nextMuted;
      this.renderTrayAudioControls();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.showToast(`静音切换失败：${msg}`, 2500);
    } finally {
      btn.disabled = false;
    }
  }

  private async commitSpeakerVolume(volume: number): Promise<void> {
    const did = this.state.audio.did;
    if (!did) return;
    const oldVol = this.state.audio.volume;
    try {
      await apiPost(`/api/devices/${encodeURIComponent(did)}/prop`, {
        name: this.state.audio.volName || "volume",
        value: volume,
      });
      this.state.audio.volume = volume;
      this.updateTrayVolumeVisual(volume, String(volume));
    } catch (err) {
      if (oldVol !== null) {
        el<HTMLInputElement>("tray-volume-slider").value = String(oldVol);
        this.updateTrayVolumeVisual(oldVol, String(oldVol));
      }
      const msg = err instanceof Error ? err.message : String(err);
      this.showToast(`音量设置失败：${msg}`, 2500);
    }
  }

  private async checkUpdate(manual: boolean): Promise<void> {
    const aboutBtn = el<HTMLButtonElement>("about-check-update-btn");
    const prevText = aboutBtn.textContent ?? "检测更新";
    if (manual) {
      aboutBtn.disabled = true;
      aboutBtn.textContent = "检查中…";
    }
    try {
      const res = await apiGet<unknown>("/api/update/check");
      const rec = asRecord(res);
      const release = normalizeReleaseInfo(rec?.release ?? (rec && "tag" in rec ? rec : null));
      const available =
        (rec && readBool(rec, "available", "hasUpdate", "has_update")) ?? Boolean(release);
      if (available && release) {
        this.state.release = release;
        this.renderLoadingAndFooter();
        if (manual) {
          this.showToast(`发现新版本 ${release.tag}，点击底栏即可前往下载`, 4000);
        }
      } else if (manual) {
        this.showToast("当前已是最新版本", 2500);
      }
    } catch (err) {
      if (manual) {
        const msg = err instanceof Error ? err.message : String(err);
        this.showToast(`检查更新失败：${msg}`, 4000);
      }
    } finally {
      aboutBtn.disabled = false;
      aboutBtn.textContent = prevText;
    }
  }

  // -------------------------------------------------------------------------
  // Toast & Menus
  // -------------------------------------------------------------------------

  showToast(message: string, durationMs = 3000): void {
    const card = el("toast-card");
    el("toast-text").textContent = message;
    card.hidden = false;
    if (this.toastTimer !== null) {
      window.clearTimeout(this.toastTimer);
    }
    if (durationMs > 0) {
      this.toastTimer = window.setTimeout(() => {
        card.hidden = true;
        this.toastTimer = null;
      }, durationMs);
    }
  }

  private closeAllMenus(): void {
    el("home-menu").hidden = true;
    el("home-switcher-btn").setAttribute("aria-expanded", "false");
    el("more-menu").hidden = true;
    el("more-menu-btn").setAttribute("aria-expanded", "false");
    el("room-menu").hidden = true;
    el("room-menu-btn").setAttribute("aria-expanded", "false");
    el("tray-speaker-menu").hidden = true;
    el("tray-speaker-btn").setAttribute("aria-expanded", "false");
    el("camera-quality-menu").hidden = true;
    el("camera-quality-btn").setAttribute("aria-expanded", "false");
    el("context-menu").hidden = true;
  }

  private showContextMenu(
    clientX: number,
    clientY: number,
    items: Array<{ label: string; onClick: () => void }>,
  ): void {
    this.closeAllMenus();
    const menu = el("context-menu");
    menu.replaceChildren();
    for (const item of items) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "popup-menu-item";
      btn.setAttribute("role", "menuitem");
      btn.textContent = item.label;
      btn.addEventListener("click", () => {
        menu.hidden = true;
        item.onClick();
      });
      menu.appendChild(btn);
    }
    menu.hidden = false;
    const rect = menu.getBoundingClientRect();
    const x = Math.min(clientX, Math.max(8, window.innerWidth - rect.width - 8));
    const y = Math.min(clientY, Math.max(8, window.innerHeight - rect.height - 8));
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
  }

  // -------------------------------------------------------------------------
  // Modal Lifecycle
  // -------------------------------------------------------------------------

  private openModal(name: ModalName): void {
    this.closeAllMenus();
    if (this.activeModal && this.activeModal !== name) {
      this.cleanupModal(this.activeModal);
    }
    const allModals: ModalName[] = [
      "settings",
      "device-detail",
      "light",
      "camera",
      "tray-manager",
      "login",
      "diagnostics",
      "tray-intro",
      "about",
    ];
    for (const m of allModals) {
      el(`modal-${m}`).hidden = m !== name;
    }
    this.activeModal = name;
    el("modal-backdrop").hidden = false;
  }

  private closeModal(): void {
    if (!this.activeModal) return;
    const closing = this.activeModal;
    this.cleanupModal(closing);
    el(`modal-${closing}`).hidden = true;
    this.activeModal = null;
    el("modal-backdrop").hidden = true;
  }

  private cleanupModal(name: ModalName): void {
    if (name === "settings" && this.settingsOriginal) {
      void this.revertSettingsPreview();
    } else if (name === "device-detail") {
      this.deviceDetailModal.close();
    } else if (name === "light") {
      this.modalLightSession.close();
    } else if (name === "camera") {
      this.stopCameraPreview();
    } else if (name === "login") {
      this.loginGeneration += 1;
    } else if (name === "diagnostics") {
      this.diagGeneration += 1;
    }
  }

  // -------------------------------------------------------------------------
  // Settings Dialog Logic (with live preview & cancel revert)
  // -------------------------------------------------------------------------

  private async openSettingsModal(
    initialTab: "appearance" | "features" | "voice-agent" = "appearance",
  ): Promise<void> {
    try {
      const raw = await apiGet<unknown>("/api/settings");
      const rec = asRecord(raw);
      const settingsObj = asRecord(rec?.settings) ?? rec;
      if (settingsObj) this.applySettingsObject(settingsObj);
    } catch {
      // use cached state.settings
    }
    try {
      const rawAgent = await apiGet<{
        config?: UiPublicAgentConfig;
        providers?: UiProviderPreset[];
      }>("/api/agent/config");
      if (rawAgent?.config) this.agentConfigCache = rawAgent.config;
      if (Array.isArray(rawAgent?.providers)) this.agentProvidersCache = rawAgent.providers;
    } catch {
      // use cached agent config
    }
    try {
      const pipe = await apiGet<{
        localEngine?: UiLocalVoiceStatus;
        voiceprints?: UiVoiceprintProfile[];
      }>("/api/voice/pipeline/status");
      if (pipe?.localEngine) this.localVoiceStatusCache = pipe.localEngine;
      if (Array.isArray(pipe?.voiceprints)) this.voiceprintProfilesCache = pipe.voiceprints;
    } catch {
      // use cached pipeline status
    }
    try {
      const oww = await apiGet<{
        ok?: boolean;
        engineStatus?: Record<string, unknown>;
        prototypes?: UiWakeWordPrototypeSummary[];
        lastWakeHit?: UiWakeWordHit | null;
      }>("/api/voice/wakewords/prototypes");
      if (Array.isArray(oww?.prototypes)) {
        this.owwPrototypesCache = oww.prototypes;
      }
    } catch {
      // use cached voice snapshot prototypes
    }

    const s = this.state.settings;
    this.settingsOriginal = { mode: s.theme, color: s.theme_color };
    this.settingsDraft = {
      tab: initialTab,
      mode: s.theme,
      color: s.theme_color,
      customColor: s.theme_color.startsWith("#") ? s.theme_color : s.custom_theme_color,
      uiScale: s.ui_scale,
    };
    this.agentClearKeyPending = false;
    this.sttClearKeyPending = false;

    this.populateSettingsForm(initialTab);
    this.openModal("settings");
  }

  private populateSettingsForm(
    initialTab: "appearance" | "features" | "voice-agent" = "appearance",
  ): void {
    const s = this.state.settings;
    const hasSpeaker = this.state.devices.some((d) => isSpeaker(d) && d.online);

    this.switchSettingsTab(initialTab);

    el<HTMLSelectElement>("set-theme-mode").value = this.settingsDraft.mode;
    this.syncSettingsColorUi();

    el<HTMLInputElement>("set-ui-scale").value = formatScalePercent(this.settingsDraft.uiScale);

    // Voice FAB
    const fabToggle = el<HTMLInputElement>("set-voice-fab");
    fabToggle.disabled = !hasSpeaker;
    fabToggle.checked = hasSpeaker ? s.voice_fab_enabled : false;
    el("setting-row-voice-fab").classList.toggle("is-disabled", !hasSpeaker);

    el<HTMLInputElement>("set-show-scene-tab").checked = s.show_scene_tab;

    // Autostart
    const autoToggle = el<HTMLInputElement>("set-autostart");
    autoToggle.disabled = !s.autostart_supported;
    autoToggle.checked = s.autostart_supported ? s.autostart : false;
    el("setting-row-autostart").classList.toggle("is-disabled", !s.autostart_supported);
    el("set-autostart-desc").textContent = s.autostart_supported
      ? "开启后，Windows 登录时自动启动米家（可与「以系统托盘方式启动」搭配静默运行）"
      : "仅构建版（独立可执行包）支持；当前为源码运行模式，保存设置时将清除残留的自启动注册项";

    // Default Speaker select
    const spkSelect = el<HTMLSelectElement>("set-default-speaker");
    spkSelect.replaceChildren();
    const autoOpt = document.createElement("option");
    autoOpt.value = "";
    autoOpt.textContent = "自动（第一个在线音箱）";
    spkSelect.appendChild(autoOpt);
    const speakers = this.state.devices
      .filter((d) => isSpeaker(d))
      .sort((a, b) => {
        if (a.online !== b.online) return a.online ? -1 : 1;
        return a.name.localeCompare(b.name, "zh-CN");
      });
    for (const spk of speakers) {
      const opt = document.createElement("option");
      opt.value = spk.did;
      opt.textContent = `${spk.name}（${spk.room_name}）${spk.online ? "" : " · 离线"}`;
      spkSelect.appendChild(opt);
    }
    spkSelect.disabled = !hasSpeaker;
    spkSelect.value =
      hasSpeaker && speakers.some((d) => d.did === s.default_speaker_did)
        ? s.default_speaker_did
        : "";
    el("setting-row-speaker").classList.toggle("is-disabled", !hasSpeaker);

    // Tray toggles
    const trayToggle = el<HTMLInputElement>("set-minimize-to-tray");
    const startMinToggle = el<HTMLInputElement>("set-start-minimized");
    trayToggle.checked = s.minimize_to_tray;
    startMinToggle.checked = s.start_minimized;
    startMinToggle.disabled = !s.minimize_to_tray;
    el("setting-row-start-min").classList.toggle("is-disabled", !s.minimize_to_tray);

    el<HTMLInputElement>("set-hide-no-func").checked = s.hide_no_func_devices;
    el<HTMLInputElement>("set-check-update").checked = s.check_update_enabled;

    this.populateVoiceAgentSettings();
  }

  private populateVoiceAgentSettings(): void {
    const cfg = this.agentConfigCache ?? this.piAgentPanel.getConfig();
    const providers =
      this.agentProvidersCache.length > 0 ? this.agentProvidersCache : this.piAgentPanel.getProviders();

    const provSelect = el<HTMLSelectElement>("set-agent-provider");
    provSelect.replaceChildren();
    const list: UiProviderPreset[] =
      providers.length > 0
        ? providers
        : [
            {
              id: "local",
              label: "内置本地引擎（免 API Key）",
              description: "免 API Key 本地智能家居规划引擎",
              defaultModel: "mijia-local-planner",
              suggestedModels: ["mijia-local-planner"],
              defaultBaseUrl: "",
              requiresApiKey: false,
            },
          ];
    for (const p of list) {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.label;
      provSelect.appendChild(opt);
    }

    const activeProvider = cfg?.provider || "local";
    provSelect.value = list.some((p) => p.id === activeProvider) ? activeProvider : "local";

    el<HTMLInputElement>("set-agent-custom-name").value = cfg?.customProviderName || "";
    el<HTMLSelectElement>("set-agent-api-type").value = cfg?.customApiType || "openai-completions";
    el<HTMLInputElement>("set-agent-model").value = cfg?.modelId || "";
    el<HTMLInputElement>("set-agent-base-url").value = cfg?.baseUrl || "";
    const keyInput = el<HTMLInputElement>("set-agent-api-key");
    keyInput.value = "";
    keyInput.placeholder = cfg?.hasApiKey
      ? `已保存密钥 (${cfg.apiKeyPreview})，留空保持不变`
      : cfg?.envApiKeyDetected
        ? "已检测到环境变量密钥，也可在此覆盖"
        : "输入新的 API Key（留空保持不变）";
    el("set-agent-clear-key-btn").hidden = !cfg?.hasApiKey;
    el<HTMLSelectElement>("set-agent-caveman-mode").value = cfg?.cavemanMode || "full";
    this.syncCavemanDesc();
    el<HTMLTextAreaElement>("set-agent-system-prompt").value = cfg?.systemPromptExtra || "";

    el<HTMLSelectElement>("set-voice-engine").value = cfg?.voiceEngine || "auto";
    el<HTMLSelectElement>("set-voice-lang").value = cfg?.voiceLang || "zh-CN";
    el<HTMLSelectElement>("set-voice-noise-mode").value = cfg?.noiseSuppressionMode || "auto";
    el<HTMLSelectElement>("set-voice-vad-mode").value = cfg?.vadMode || "silero";
    el<HTMLInputElement>("set-voice-vad-silence").value = String(cfg?.vadSilenceMs ?? 750);
    const wakeEnabled = cfg?.wakeWordEnabled ?? true;
    el<HTMLInputElement>("set-voice-wake-enabled").checked = wakeEnabled;
    el("setting-row-wake-words").classList.toggle("is-disabled", !wakeEnabled);
    const wakeList = cfg?.wakeWords && cfg.wakeWords.length > 0 ? cfg.wakeWords : ["小派", "pi"];
    el<HTMLInputElement>("set-voice-wake-words").value = wakeList.join(", ");
    el<HTMLInputElement>("set-voice-wake-ack-phrase").value =
      cfg?.wakeAckPhrase !== undefined ? cfg.wakeAckPhrase : "嗯?";
    el<HTMLInputElement>("set-voice-conv-window").value = String(cfg?.conversationWindowSec ?? 25);

    el<HTMLInputElement>("set-oww-enabled").checked = cfg?.owwEnabled ?? true;
    el<HTMLInputElement>("set-oww-threshold").value = (cfg?.owwThreshold ?? 0.6).toFixed(2);
    const firstWake = wakeList[0] ?? "Neo";
    el<HTMLInputElement>("oww-target-word").value = firstWake;
    this.lastAutoFilledWakeWord = firstWake;

    el<HTMLSelectElement>("set-systemone-mode").value = cfg?.systemOneMode || "auto";
    el<HTMLSelectElement>("set-voice-attention-mode").value = cfg?.attentionMode || "smart";
    el<HTMLInputElement>("set-voice-sidetalk-limit").value = String(cfg?.maxConsecutiveSidetalk ?? 3);
    el<HTMLInputElement>("set-systemone-model").value =
      cfg?.systemOneModel || "karpo/karpo-decision-31b";
    el<HTMLInputElement>("set-systemone-base-url").value = cfg?.systemOneBaseUrl || "";
    this.syncSystemOneStatusDesc();

    el<HTMLSelectElement>("set-voiceprint-mode").value = cfg?.voiceprintMode || "tag";
    el<HTMLInputElement>("set-voiceprint-threshold").value = String(cfg?.voiceprintThreshold ?? 0.42);
    el<HTMLInputElement>("set-voice-barge-in").checked = cfg?.bargeInEnabled ?? true;
    el<HTMLInputElement>("set-voice-auto-speak").checked = cfg?.autoSpeakReply ?? true;
    el<HTMLSelectElement>("set-voice-tts-engine").value = cfg?.ttsEngine || "auto";
    el<HTMLSelectElement>("set-voice-tts-voice").value = cfg?.ttsVoice || "gentle-zh-en";
    el<HTMLInputElement>("set-voice-tts-speed").value = (cfg?.ttsSpeed ?? 0.98).toFixed(2);

    el<HTMLInputElement>("set-stt-base-url").value = cfg?.sttBaseUrl || "";
    el<HTMLInputElement>("set-stt-model").value = cfg?.sttModel || "whisper-1";
    const sttKeyInput = el<HTMLInputElement>("set-stt-api-key");
    sttKeyInput.value = "";
    sttKeyInput.placeholder = cfg?.hasSttApiKey
      ? `已保存 STT 密钥 (${cfg.sttApiKeyPreview})，留空保持不变`
      : "STT API Key（留空则复用上方 Key 或环境变量）";
    el("set-stt-clear-key-btn").hidden = !cfg?.hasSttApiKey;

    this.renderVoicePipelineStatus();
    this.renderOwwPrototypes();
    this.renderVoiceprintProfiles();
    this.syncAgentProviderFormHints(false);
  }

  private renderVoicePipelineStatus(): void {
    const status =
      this.localVoiceStatusCache ?? this.piAgentPanel.getVoiceSnapshot()?.localEngine ?? null;
    const setBadge = (id: string, label: string, ready: boolean) => {
      const node = document.getElementById(id);
      if (!node) return;
      node.textContent = `${ready ? "✓" : "○"} ${label}`;
      node.classList.toggle("is-ready", ready);
      node.classList.toggle("is-missing", !ready);
    };

    const gtcrnOk = Boolean(status?.readyForDenoise);
    const dpdfOk = Boolean(status?.readyForDpdfnet);
    const voxOk = Boolean(status?.readyForVoxlock);
    const vadOk = Boolean(status?.readyForVad);
    const vpOk = Boolean(status?.readyForVoiceprint);
    const asrOk = Boolean(status?.readyForLocalAsr);
    const owwOk = Boolean(status?.readyForWakeWord ?? status?.models?.openWakeWord);
    const ttsOk = Boolean(status?.readyForLocalTts ?? status?.models?.localTts);

    setBadge("badge-model-gtcrn", "GTCRN 降噪", gtcrnOk);
    setBadge("badge-model-dpdfnet", "DPDFNet4 强噪", dpdfOk);
    setBadge("badge-model-voxlock", "VoxLock 声纹提取", voxOk);
    setBadge("badge-model-vad", "Silero VAD", vadOk);
    setBadge("badge-model-vp", "3D-Speaker 声纹", vpOk);
    setBadge("badge-model-asr", "SenseVoice 识别", asrOk);
    setBadge("badge-model-oww", "openWakeWord 唤醒", owwOk);
    setBadge("badge-model-tts", "Matcha 温柔女声", ttsOk);

    const coreReady = gtcrnOk && vadOk && vpOk && asrOk;
    const allReady = coreReady && owwOk && ttsOk;
    const dlBtn = document.getElementById("voice-download-models-btn") as HTMLButtonElement | null;
    if (dlBtn) {
      dlBtn.hidden = allReady || !status?.addonAvailable;
      dlBtn.disabled = Boolean(status?.downloading);
      dlBtn.textContent = status?.downloading ? "下载中…" : "一键补齐模型";
    }
    const desc = document.getElementById("voice-pipeline-status-desc");
    if (desc) {
      desc.textContent = allReady
        ? "本地流式语音 AI 管线已就绪（WebSocket 连续流 + openWakeWord 唤醒 + 双轨抗音乐/强噪融合 + Silero VAD + 3D-Speaker 声纹 + SenseVoice 离线识别）"
        : coreReady
          ? "核心离线语音模型已就绪（openWakeWord 声学唤醒模型未下载时将自动使用 SenseVoice 唤醒兜底，可一键补齐）"
          : "本地离线语音模型尚未完全就绪，可点击「一键补齐模型」自动下载，未就绪项将自动使用 DSP/云端降级";
    }
  }

  private syncCavemanDesc(): void {
    const sel = document.getElementById("set-agent-caveman-mode") as HTMLSelectElement | null;
    const desc = document.getElementById("set-agent-caveman-desc");
    if (!sel || !desc) return;
    const raw = sel.value;
    const mode: UiCavemanMode =
      raw === "ultra" || raw === "full" || raw === "lite" || raw === "off" ? raw : "full";
    desc.textContent = CAVEMAN_PREVIEW_DESCS[mode];
  }

  private syncSystemOneStatusDesc(): void {
    const desc = document.getElementById("set-systemone-status-desc");
    const modeSel = document.getElementById("set-systemone-mode") as HTMLSelectElement | null;
    if (!desc || !modeSel) return;
    const mode = modeSel.value;
    const cfg = this.agentConfigCache ?? this.piAgentPanel.getConfig();
    const health = this.piAgentPanel.getVoiceSnapshot()?.systemOneHealth ?? null;

    if (mode === "off") {
      desc.textContent = "已关闭 SystemOne 决策模型，仅使用本地规则与注意力门控判定旁白";
      return;
    }
    if (health?.circuitState === "open") {
      desc.textContent = `SystemOne 熔断保护中（${health.openReason || "近期请求异常"}），已自动降级规则门控；连续旁白达上限自动退回待唤醒`;
      return;
    }
    if (health?.enabled) {
      const host = health.endpointHost ? ` · ${health.endpointHost}` : "";
      const lat = typeof health.lastLatencyMs === "number" ? ` · 最近 ${Math.round(health.lastLatencyMs)}ms` : "";
      desc.textContent = `SystemOne 已启用（${health.model}${host}${lat}）· 对话中实时区分定向指令与旁白`;
      return;
    }
    if (cfg?.effectiveSystemOneConfigured) {
      const host = safeUrlHost(cfg.effectiveSystemOneBaseUrl || "");
      desc.textContent = `SystemOne 已配置${host ? `（${host}）` : ""}，对话模式下自动拦截他人旁白并在连续旁白达上限后退回待唤醒`;
      return;
    }
    desc.textContent =
      "在对话模式中由决策模型判定语音是指令还是旁白（配置主网关或下方 Base URL 后自动生效）；连续旁白达上限自动退回待唤醒";
  }

  private parseConfiguredWakeWords(): string[] {
    const raw = (document.getElementById("set-voice-wake-words") as HTMLInputElement | null)?.value ?? "";
    const seen = new Set<string>();
    const list: string[] = [];
    for (const part of raw.split(/[,，、;\n]+/)) {
      const word = part.trim();
      if (!word) continue;
      const key = word.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      list.push(word);
    }
    return list;
  }

  private renderOwwPrototypes(): void {
    const listEl = document.getElementById("oww-prototype-list");
    if (!listEl) return;
    const prototypes =
      this.owwPrototypesCache.length > 0
        ? this.owwPrototypesCache
        : (this.piAgentPanel.getVoiceSnapshot()?.wakeWordPrototypes ?? []);

    listEl.replaceChildren();
    if (prototypes.length === 0) {
      const empty = document.createElement("span");
      empty.className = "oww-proto-empty";
      empty.textContent = "暂无已建库唤醒词模板（录制样本或点击「重新合成」即可生成）";
      listEl.appendChild(empty);
      return;
    }

    for (const proto of prototypes) {
      const chip = document.createElement("div");
      chip.className = "oww-proto-chip";

      const labelBtn = document.createElement("button");
      labelBtn.type = "button";
      labelBtn.className = "oww-proto-label-btn";
      labelBtn.textContent = `${proto.wakeWord} · 已录 ${proto.enrolledCount} / 合成 ${proto.ttsCount}`;
      labelBtn.title = `点击选中「${proto.wakeWord}」继续录制样本`;
      labelBtn.addEventListener("click", () => {
        const input = document.getElementById("oww-target-word") as HTMLInputElement | null;
        if (input) {
          input.value = proto.wakeWord;
          input.focus();
        }
      });

      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "oww-proto-del-btn";
      delBtn.textContent = "×";
      delBtn.title = `删除「${proto.wakeWord}」声学模板`;
      delBtn.setAttribute("aria-label", `删除 ${proto.wakeWord} 声学模板`);
      delBtn.addEventListener("click", () => {
        void this.deleteOwwPrototype(proto.wakeWord);
      });

      chip.append(labelBtn, delBtn);
      listEl.appendChild(chip);
    }
  }

  private setOwwControlsDisabled(disabled: boolean): void {
    const ids = ["oww-record-sample-btn", "oww-test-sample-btn", "oww-bootstrap-btn"];
    for (const id of ids) {
      const btn = document.getElementById(id) as HTMLButtonElement | null;
      if (btn) btn.disabled = disabled;
    }
  }

  private async handleRecordOwwSample(): Promise<void> {
    if (this.owwRecordingBusy || this.vpRecordingBusy) return;
    const wordInput = el<HTMLInputElement>("oww-target-word");
    const configured = this.parseConfiguredWakeWords();
    const wakeWord = wordInput.value.trim() || configured[0] || "Neo";
    wordInput.value = wakeWord;

    const btn = el<HTMLButtonElement>("oww-record-sample-btn");
    const statusEl = el("oww-status-line");
    const meter = el("oww-level-meter");
    const fill = el("oww-level-fill");
    const prevLabel = btn.textContent || "录制样本 (1.8s)";

    this.owwRecordingBusy = true;
    this.setOwwControlsDisabled(true);
    meter.hidden = false;
    fill.style.width = "6%";
    statusEl.textContent = `正在为「${wakeWord}」录制 1.8 秒样本，请清晰喊出“${wakeWord}”…`;

    try {
      const wavBlob = await recordShortWavSample(1800, (ratio, level) => {
        const rem = Math.max(0.1, (1 - ratio) * 1.8);
        btn.textContent = `录音中 ${rem.toFixed(1)}s…`;
        const pct = Math.max(6, Math.min(100, Math.round(level * 100)));
        fill.style.width = `${pct}%`;
      });
      btn.textContent = "提取特征…";
      const form = new FormData();
      form.append("audio", wavBlob, "wakeword.wav");
      form.append("wakeWord", wakeWord);

      const res = await fetch("/api/voice/wakewords/enroll", { method: "POST", body: form });
      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        summary?: UiWakeWordPrototypeSummary;
        prototypes?: UiWakeWordPrototypeSummary[];
        voice?: unknown;
      };
      if (!res.ok || data.ok === false) {
        throw new Error(data.error || `唤醒词录制失败 (${res.status})`);
      }
      if (Array.isArray(data.prototypes)) {
        this.owwPrototypesCache = data.prototypes;
      }
      if (data.voice) {
        this.piAgentPanel.applyVoiceSnapshot(data.voice);
      }
      this.renderOwwPrototypes();
      const s = data.summary;
      statusEl.textContent = s
        ? `✓ 已录制「${s.wakeWord}」样本（已录 ${s.enrolledCount} / 合成 ${s.ttsCount}），建议录制 2~3 条不同语速`
        : `✓ 已为「${wakeWord}」保存声学唤醒样本`;
      this.showToast(`唤醒词样本已保存：${wakeWord}`, 2400);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      statusEl.textContent = `录制失败：${msg}`;
      this.showToast(`唤醒词样本录制失败：${msg}`, 3500);
    } finally {
      this.owwRecordingBusy = false;
      meter.hidden = true;
      fill.style.width = "0%";
      this.setOwwControlsDisabled(false);
      btn.textContent = prevLabel;
    }
  }

  private async handleTestOwwSample(): Promise<void> {
    if (this.owwRecordingBusy || this.vpRecordingBusy) return;
    const btn = el<HTMLButtonElement>("oww-test-sample-btn");
    const statusEl = el("oww-status-line");
    const meter = el("oww-level-meter");
    const fill = el("oww-level-fill");
    const prevLabel = btn.textContent || "试喊测试";

    this.owwRecordingBusy = true;
    this.setOwwControlsDisabled(true);
    meter.hidden = false;
    fill.style.width = "6%";
    statusEl.textContent = "请自然喊出你的唤醒词（录制 1.8 秒进行声学匹配测试）…";

    try {
      const wavBlob = await recordShortWavSample(1800, (ratio, level) => {
        const rem = Math.max(0.1, (1 - ratio) * 1.8);
        btn.textContent = `测试中 ${rem.toFixed(1)}s…`;
        const pct = Math.max(6, Math.min(100, Math.round(level * 100)));
        fill.style.width = `${pct}%`;
      });
      btn.textContent = "比对中…";
      const form = new FormData();
      form.append("audio", wavBlob, "verify-wake.wav");

      const res = await fetch("/api/voice/wakewords/verify", { method: "POST", body: form });
      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        matched?: boolean;
        hit?: { wakeWord: string; score: number; threshold?: number; source?: string } | null;
        threshold?: number;
        latencyMs?: number;
      };
      if (!res.ok || data.ok === false) {
        throw new Error(data.error || `试喊测试失败 (${res.status})`);
      }
      const thresh = data.hit?.threshold ?? data.threshold ?? 0.6;
      const lat = typeof data.latencyMs === "number" ? ` · ${Math.round(data.latencyMs)}ms` : "";
      if (data.matched && data.hit) {
        statusEl.textContent = `✓ 命中「${data.hit.wakeWord}」· 得分 ${data.hit.score.toFixed(2)} ≥ 阈值 ${thresh.toFixed(2)}${lat}`;
      } else if (data.hit) {
        statusEl.textContent = `✕ 未触发唤醒 · 最高「${data.hit.wakeWord}」得分 ${data.hit.score.toFixed(2)} < 阈值 ${thresh.toFixed(2)}${lat}`;
      } else {
        statusEl.textContent = `✕ 未检测到匹配唤醒词（阈值 ${thresh.toFixed(2)}${lat}），可先录制样本或点击「重新合成」`;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      statusEl.textContent = `试喊测试失败：${msg}`;
      this.showToast(`试喊测试失败：${msg}`, 3500);
    } finally {
      this.owwRecordingBusy = false;
      meter.hidden = true;
      fill.style.width = "0%";
      this.setOwwControlsDisabled(false);
      btn.textContent = prevLabel;
    }
  }

  private async handleBootstrapOww(): Promise<void> {
    if (this.owwRecordingBusy || this.vpRecordingBusy) return;
    const btn = el<HTMLButtonElement>("oww-bootstrap-btn");
    const statusEl = el("oww-status-line");
    const prevLabel = btn.textContent || "重新合成";
    const wakeWords = this.parseConfiguredWakeWords();

    this.owwRecordingBusy = true;
    this.setOwwControlsDisabled(true);
    btn.textContent = "合成中…";
    statusEl.textContent = "正在为当前唤醒词列表生成声学模板，请稍候…";

    try {
      const res = await apiPost<{
        ok?: boolean;
        bootstrapped?: string[] | number;
        skipped?: string[] | number;
        durationMs?: number;
        prototypes?: UiWakeWordPrototypeSummary[];
        voice?: unknown;
      }>("/api/voice/wakewords/bootstrap", {
        wakeWords: wakeWords.length > 0 ? wakeWords : undefined,
        force: true,
      });
      if (Array.isArray(res.prototypes)) {
        this.owwPrototypesCache = res.prototypes;
      }
      if (res.voice) {
        this.piAgentPanel.applyVoiceSnapshot(res.voice);
      }
      this.renderOwwPrototypes();
      const bCount = Array.isArray(res.bootstrapped)
        ? res.bootstrapped.length
        : Number(res.bootstrapped ?? 0);
      const dur = typeof res.durationMs === "number" ? ` · ${Math.round(res.durationMs)}ms` : "";
      statusEl.textContent = `✓ 声学模板已更新（合成 ${bCount} 个唤醒词${dur}）`;
      this.showToast("唤醒词声学模板重新合成完成", 2400);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      statusEl.textContent = `合成失败：${msg}`;
      this.showToast(`重新合成失败：${msg}`, 3500);
    } finally {
      this.owwRecordingBusy = false;
      this.setOwwControlsDisabled(false);
      btn.textContent = prevLabel;
    }
  }

  private async deleteOwwPrototype(wakeWord: string): Promise<void> {
    try {
      const res = await fetch(
        `/api/voice/wakewords/prototypes/${encodeURIComponent(wakeWord)}`,
        { method: "DELETE" },
      );
      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        deleted?: number;
        prototypes?: UiWakeWordPrototypeSummary[];
        voice?: unknown;
      };
      if (!res.ok || data.ok === false) {
        throw new Error(data.error || `删除失败 (${res.status})`);
      }
      if (Array.isArray(data.prototypes)) {
        this.owwPrototypesCache = data.prototypes;
      }
      if (data.voice) {
        this.piAgentPanel.applyVoiceSnapshot(data.voice);
      }
      this.renderOwwPrototypes();
      el("oww-status-line").textContent = `已删除「${wakeWord}」的声学模板`;
      this.showToast(`已删除唤醒词模板：${wakeWord}`, 2200);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.showToast(`删除唤醒词模板失败：${msg}`, 3000);
    }
  }

  private renderVoiceprintProfiles(): void {
    const listEl = document.getElementById("vp-profile-list");
    if (!listEl) return;
    const profiles =
      this.voiceprintProfilesCache.length > 0
        ? this.voiceprintProfilesCache
        : (this.piAgentPanel.getVoiceSnapshot()?.voiceprints ?? []);
    listEl.replaceChildren();

    if (profiles.length === 0) {
      const empty = document.createElement("div");
      empty.className = "vp-profile-empty";
      empty.textContent = "尚未注册任何声纹档案；输入名字后点击「录制声纹 (3s)」朗读一句日常指令即可完成注册（建议同人录制 2~3 次提升准确率）";
      listEl.appendChild(empty);
      return;
    }

    for (const p of profiles) {
      const item = document.createElement("div");
      item.className = "vp-profile-item";

      const info = document.createElement("div");
      info.className = "vp-profile-info";
      const nameSpan = document.createElement("strong");
      nameSpan.textContent = p.name;
      const roleSpan = document.createElement("span");
      roleSpan.className = "vp-role-tag";
      roleSpan.textContent = p.role === "owner" ? "主人" : "成员";
      const metaSpan = document.createElement("span");
      metaSpan.className = "vp-profile-meta";
      metaSpan.textContent = `${p.sampleCount} 条样本 · ${p.engine === "3dspeaker-campplus" ? "3D-Speaker" : p.engine}`;
      info.append(nameSpan, roleSpan, metaSpan);

      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "secondary-button btn-compact";
      delBtn.textContent = "删除";
      delBtn.addEventListener("click", () => {
        void this.deleteVoiceprintProfile(p.id, p.name);
      });

      item.append(info, delBtn);
      listEl.appendChild(item);
    }
  }

  private async downloadMissingVoiceModels(): Promise<void> {
    const btn = el<HTMLButtonElement>("voice-download-models-btn");
    btn.disabled = true;
    btn.textContent = "正在下载模型…";
    try {
      const res = await apiPost<{ localEngine?: UiLocalVoiceStatus; voice?: unknown }>(
        "/api/voice/pipeline/download",
      );
      if (res.localEngine) this.localVoiceStatusCache = res.localEngine;
      if (res.voice) this.piAgentPanel.applyVoiceSnapshot(res.voice);
      this.renderVoicePipelineStatus();
      this.showToast("本地语音 AI 模型已准备就绪", 3000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.showToast(`下载本地模型失败：${msg}`, 4000);
    } finally {
      this.renderVoicePipelineStatus();
    }
  }

  private async handleRecordEnrollVoiceprint(): Promise<void> {
    if (this.vpRecordingBusy || this.owwRecordingBusy) return;
    const nameInput = el<HTMLInputElement>("vp-enroll-name");
    const name = nameInput.value.trim() || "主人";
    const role = el<HTMLSelectElement>("vp-enroll-role").value === "member" ? "member" : "owner";
    const btn = el<HTMLButtonElement>("vp-record-enroll-btn");
    const statusEl = el("vp-status-text");

    this.vpRecordingBusy = true;
    btn.disabled = true;
    const prevLabel = btn.textContent || "录制声纹 (3s)";
    statusEl.textContent = `正在为「${name}」录制 3 秒声纹，请清晰说出：“小派，打开客厅吸顶灯”…`;

    try {
      const wavBlob = await recordShortWavSample(3200, (ratio) => {
        btn.textContent = `录音中 ${Math.max(1, Math.ceil((1 - ratio) * 3.2))}s…`;
      });
      btn.textContent = "提取声纹…";
      const form = new FormData();
      form.append("audio", wavBlob, "enroll.wav");
      form.append("name", name);
      form.append("role", role);
      const res = await fetch("/api/voiceprints/enroll", { method: "POST", body: form });
      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        profile?: UiVoiceprintProfile;
        profiles?: UiVoiceprintProfile[];
        snrGainDb?: number;
        voice?: unknown;
      };
      if (!res.ok || !data.ok) {
        throw new Error(data.error || `声纹注册失败 (${res.status})`);
      }
      if (Array.isArray(data.profiles)) this.voiceprintProfilesCache = data.profiles;
      if (data.voice) this.piAgentPanel.applyVoiceSnapshot(data.voice);
      this.renderVoiceprintProfiles();
      const snrNote = typeof data.snrGainDb === "number" && data.snrGainDb > 0 ? `（降噪 +${data.snrGainDb.toFixed(1)}dB）` : "";
      statusEl.textContent = `✓ 已为「${data.profile?.name || name}」保存声纹（共 ${data.profile?.sampleCount ?? 1} 条样本）${snrNote}`;
      this.showToast(`声纹注册成功：${data.profile?.name || name}`, 2600);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      statusEl.textContent = `声纹注册失败：${msg}`;
      this.showToast(`声纹注册失败：${msg}`, 3500);
    } finally {
      this.vpRecordingBusy = false;
      btn.disabled = false;
      btn.textContent = prevLabel;
    }
  }

  private async handleRecordVerifyVoiceprint(): Promise<void> {
    if (this.vpRecordingBusy || this.owwRecordingBusy) return;
    const btn = el<HTMLButtonElement>("vp-record-verify-btn");
    const statusEl = el("vp-status-text");
    this.vpRecordingBusy = true;
    btn.disabled = true;
    const prevLabel = btn.textContent || "声纹测试";
    statusEl.textContent = "正在录制 3 秒验证语音，请自然说一句话…";

    try {
      const wavBlob = await recordShortWavSample(3000, (ratio) => {
        btn.textContent = `测试录音 ${Math.max(1, Math.ceil((1 - ratio) * 3))}s…`;
      });
      btn.textContent = "比对中…";
      const form = new FormData();
      form.append("audio", wavBlob, "verify.wav");
      const res = await fetch("/api/voiceprints/verify", { method: "POST", body: form });
      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        snrGainDb?: number;
        result?: {
          evaluated: boolean;
          matched: boolean;
          speakerName: string | null;
          score: number;
          threshold: number;
        };
      };
      if (!res.ok || !data.ok) {
        throw new Error(data.error || `声纹测试失败 (${res.status})`);
      }
      const r = data.result;
      if (!r?.evaluated) {
        statusEl.textContent = "请先注册至少一位说话人声纹后再进行测试";
      } else if (r.matched) {
        statusEl.textContent = `✓ 声纹验证通过：识别为「${r.speakerName}」（相似度 ${Math.round(r.score * 100)}%，阈值 ${Math.round(r.threshold * 100)}%）`;
      } else {
        statusEl.textContent = `✕ 声纹未匹配（最高相似度 ${Math.round(r.score * 100)}% < 阈值 ${Math.round(r.threshold * 100)}%）`;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      statusEl.textContent = `声纹测试失败：${msg}`;
      this.showToast(`声纹测试失败：${msg}`, 3500);
    } finally {
      this.vpRecordingBusy = false;
      btn.disabled = false;
      btn.textContent = prevLabel;
    }
  }

  private async deleteVoiceprintProfile(id: string, name: string): Promise<void> {
    try {
      const res = await fetch(`/api/voiceprints/${encodeURIComponent(id)}`, { method: "DELETE" });
      const data = (await res.json()) as {
        ok?: boolean;
        profiles?: UiVoiceprintProfile[];
        voice?: unknown;
      };
      if (res.ok && data.ok) {
        if (Array.isArray(data.profiles)) this.voiceprintProfilesCache = data.profiles;
        if (data.voice) this.piAgentPanel.applyVoiceSnapshot(data.voice);
        this.renderVoiceprintProfiles();
        this.showToast(`已删除「${name}」的声纹档案`, 2200);
      }
    } catch {
      this.showToast("删除声纹档案失败", 2500);
    }
  }

  private syncAgentProviderFormHints(resetDefaultsOnSwitch: boolean): void {
    const provId = el<HTMLSelectElement>("set-agent-provider").value;
    const providers =
      this.agentProvidersCache.length > 0 ? this.agentProvidersCache : this.piAgentPanel.getProviders();
    const preset = providers.find((p) => p.id === provId);
    const isLocal = provId === "local";
    const isCustom = provId === "openai-compatible";

    el("setting-row-agent-custom-meta").hidden = !isCustom;
    el("setting-row-agent-model").hidden = isLocal;
    el("setting-row-agent-baseurl").hidden = isLocal;
    el("setting-row-agent-apikey").hidden = isLocal;

    if (preset) {
      el("set-agent-provider-desc").textContent = preset.description;
      if (resetDefaultsOnSwitch) {
        el<HTMLInputElement>("set-agent-model").value = preset.defaultModel;
        if (isCustom && this.agentConfigCache?.provider !== "openai-compatible") {
          el<HTMLInputElement>("set-agent-base-url").value = "";
        }
      }
      this.renderDiscoveredModels(
        preset.suggestedModels.map((id) => ({ id })),
        false,
      );
      el<HTMLInputElement>("set-agent-base-url").placeholder =
        preset.defaultBaseUrl || "https://your-gateway/v1 或 http://127.0.0.1:11434/v1";
    }

    if (!isLocal) {
      void this.fetchAgentModelsFromApi(false);
    }
  }

  private renderDiscoveredModels(
    models: Array<{ id: string; name?: string }>,
    autoSelectIfEmpty: boolean,
  ): void {
    const modelInput = el<HTMLInputElement>("set-agent-model");
    const select = el<HTMLSelectElement>("set-agent-model-select");
    const datalist = el("set-agent-model-list");
    const currentVal = modelInput.value.trim();

    datalist.replaceChildren();
    select.replaceChildren();

    const ids = new Set<string>();
    for (const m of models) {
      const id = String(m.id ?? "").trim();
      if (!id || ids.has(id)) continue;
      ids.add(id);

      const dOpt = document.createElement("option");
      dOpt.value = id;
      datalist.appendChild(dOpt);

      const sOpt = document.createElement("option");
      sOpt.value = id;
      sOpt.textContent = m.name && m.name !== id ? `${id} (${m.name})` : id;
      select.appendChild(sOpt);
    }

    if (currentVal && !ids.has(currentVal)) {
      const customOpt = document.createElement("option");
      customOpt.value = currentVal;
      customOpt.textContent = `${currentVal}（当前自定义）`;
      select.prepend(customOpt);
    }

    if (currentVal) {
      select.value = currentVal;
    } else if (autoSelectIfEmpty && models.length > 0 && models[0]?.id) {
      select.value = models[0].id;
      modelInput.value = models[0].id;
    }
  }

  private scheduleFetchAgentModels(): void {
    if (this.agentModelsDebounceTimer !== null) {
      window.clearTimeout(this.agentModelsDebounceTimer);
    }
    this.agentModelsDebounceTimer = window.setTimeout(() => {
      this.agentModelsDebounceTimer = null;
      void this.fetchAgentModelsFromApi(false);
    }, 450);
  }

  private async fetchAgentModelsFromApi(showToastOnError: boolean): Promise<void> {
    const provider = el<HTMLSelectElement>("set-agent-provider").value;
    if (!provider || provider === "local") return;

    const gen = ++this.agentModelsFetchGen;
    const statusEl = el("set-agent-models-status");
    const refreshBtn = el<HTMLButtonElement>("set-agent-refresh-models-btn");
    const baseUrl = el<HTMLInputElement>("set-agent-base-url").value.trim();
    const apiKey = el<HTMLInputElement>("set-agent-api-key").value.trim();
    const customApiType = el<HTMLSelectElement>("set-agent-api-type").value;

    statusEl.classList.remove("is-success", "is-warn");
    statusEl.textContent = "正在从 API 自动获取可用模型列表…";
    refreshBtn.disabled = true;

    try {
      const payload: Record<string, unknown> = { provider };
      if (provider === "openai-compatible") payload.customApiType = customApiType;
      if (baseUrl) payload.baseUrl = baseUrl;
      if (apiKey) payload.apiKey = apiKey;

      const res = await apiPost<{
        fetched?: boolean;
        source?: string;
        models?: Array<{ id: string; name?: string }>;
        error?: string;
      }>("/api/agent/models", payload);

      if (gen !== this.agentModelsFetchGen) return;

      const list = Array.isArray(res.models) ? res.models : [];
      if (list.length > 0) {
        this.renderDiscoveredModels(list, !el<HTMLInputElement>("set-agent-model").value.trim());
      }

      if (res.fetched && res.source === "api") {
        statusEl.classList.add("is-success");
        statusEl.textContent = `✓ 已自动从 API 获取 ${list.length} 个可用模型，可直接下拉选择或手动输入`;
      } else {
        if (list.length === 0) {
          this.renderDiscoveredModels([], false);
        }
        statusEl.classList.add("is-warn");
        statusEl.textContent = res.error || "未能从接口拉取模型列表，请检查 Base URL 与 API Key";
        if (showToastOnError && res.error) {
          this.showToast(res.error, 3200);
        }
      }
    } catch (err) {
      if (gen !== this.agentModelsFetchGen) return;
      const msg = err instanceof Error ? err.message : String(err);
      statusEl.classList.add("is-warn");
      statusEl.textContent = `获取模型列表失败：${msg}`;
      if (showToastOnError) {
        this.showToast(`获取模型列表失败：${msg}`, 3200);
      }
    } finally {
      if (gen === this.agentModelsFetchGen) {
        refreshBtn.disabled = false;
      }
    }
  }

  private switchSettingsTab(tab: "appearance" | "features" | "voice-agent"): void {
    this.settingsDraft.tab = tab;
    el("settings-page-appearance").hidden = tab !== "appearance";
    el("settings-page-features").hidden = tab !== "features";
    el("settings-page-voice-agent").hidden = tab !== "voice-agent";
    document.querySelectorAll<HTMLButtonElement>("[data-settings-tab]").forEach((btn) => {
      const active = btn.dataset.settingsTab === tab;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-selected", String(active));
    });
  }

  private syncSettingsColorUi(): void {
    const color = this.settingsDraft.color;
    document.querySelectorAll<HTMLButtonElement>(".color-preset-btn").forEach((btn) => {
      btn.classList.toggle("checked", btn.dataset.color === color);
    });
    const hexInput = el<HTMLInputElement>("set-custom-hex");
    const swatch = el("set-custom-swatch");
    const picker = el<HTMLInputElement>("set-custom-picker");

    if (document.activeElement !== hexInput) {
      hexInput.value = this.settingsDraft.customColor;
    }
    const normalized = normalizeThemeColor(hexInput.value);
    const valid = Boolean(normalized && normalized.startsWith("#"));
    const displayHex = valid && normalized ? normalized : this.settingsDraft.customColor;
    swatch.style.background = displayHex;
    swatch.title = `点击打开取色色盘 · ${displayHex}`;
    picker.value = displayHex;
    hexInput.classList.toggle("active", color.startsWith("#"));
    hexInput.classList.toggle("invalid", !valid);
    hexInput.title = valid ? "" : "请输入完整的 #RRGGBB，例如 #333333";
  }

  private async previewTheme(partial: { mode?: ThemeMode; color?: string }): Promise<void> {
    try {
      await apiPost("/api/theme/preview", partial);
      this.reloadThemeStylesheet();
    } catch {
      // ignore preview errors
    }
  }

  private async revertSettingsPreview(): Promise<void> {
    const orig = this.settingsOriginal;
    this.settingsOriginal = null;
    if (!orig) return;
    if (orig.mode !== this.settingsDraft.mode || orig.color !== this.settingsDraft.color) {
      await this.previewTheme({ mode: orig.mode, color: orig.color });
    }
  }

  private async saveSettings(): Promise<void> {
    const hexInput = el<HTMLInputElement>("set-custom-hex");
    if (this.settingsDraft.color.startsWith("#")) {
      const norm = normalizeThemeColor(hexInput.value);
      if (!norm || !norm.startsWith("#")) {
        hexInput.focus();
        this.showToast("请输入完整的 #RRGGBB，例如 #333333", 2500);
        return;
      }
      this.settingsDraft.color = norm;
      this.settingsDraft.customColor = norm;
    }

    const scaleInput = el<HTMLInputElement>("set-ui-scale");
    const parsedScale = parseScaleText(scaleInput.value);
    if (parsedScale !== null) {
      this.settingsDraft.uiScale = parsedScale;
      scaleInput.value = formatScalePercent(parsedScale);
    }

    const minimizeToTray = el<HTMLInputElement>("set-minimize-to-tray").checked;
    const startMinimized = minimizeToTray ? el<HTMLInputElement>("set-start-minimized").checked : false;
    const voiceFabEnabled = el<HTMLInputElement>("set-voice-fab").checked;
    const showSceneTab = el<HTMLInputElement>("set-show-scene-tab").checked;
    const autostart = el<HTMLInputElement>("set-autostart").checked;
    const defaultSpeakerDid = el<HTMLSelectElement>("set-default-speaker").value;
    const hideNoFunc = el<HTMLInputElement>("set-hide-no-func").checked;
    const checkUpdate = el<HTMLInputElement>("set-check-update").checked;

    const payload = {
      theme: this.settingsDraft.mode,
      themeMode: this.settingsDraft.mode,
      theme_color: this.settingsDraft.color,
      themeColor: this.settingsDraft.color,
      custom_theme_color: this.settingsDraft.customColor,
      customThemeColor: this.settingsDraft.customColor,
      ui_scale: this.settingsDraft.uiScale,
      uiScale: this.settingsDraft.uiScale,
      voice_fab_enabled: voiceFabEnabled,
      voiceFabEnabled,
      show_scene_tab: showSceneTab,
      showSceneTab,
      autostart,
      default_speaker_did: defaultSpeakerDid,
      defaultSpeakerDid,
      minimize_to_tray: minimizeToTray,
      minimizeToTray,
      start_minimized: startMinimized,
      startMinimized,
      hide_no_func_devices: hideNoFunc,
      hideNoFuncDevices: hideNoFunc,
      check_update_enabled: checkUpdate,
      checkUpdateEnabled: checkUpdate,
    };

    const convWindowRaw = Number(el<HTMLInputElement>("set-voice-conv-window").value);
    const conversationWindowSec = Number.isFinite(convWindowRaw)
      ? Math.min(120, Math.max(5, Math.round(convWindowRaw)))
      : 25;
    const sidetalkRaw = Number(el<HTMLInputElement>("set-voice-sidetalk-limit").value);
    const maxConsecutiveSidetalk = Number.isFinite(sidetalkRaw)
      ? Math.min(10, Math.max(1, Math.round(sidetalkRaw)))
      : 3;
    const owwThreshRaw = Number(el<HTMLInputElement>("set-oww-threshold").value);
    const owwThreshold = Number.isFinite(owwThreshRaw)
      ? Number(Math.min(0.95, Math.max(0.25, owwThreshRaw)).toFixed(2))
      : 0.6;
    const ttsSpeedRaw = Number(el<HTMLInputElement>("set-voice-tts-speed").value);
    const ttsSpeed = Number.isFinite(ttsSpeedRaw)
      ? Number(Math.min(1.4, Math.max(0.7, ttsSpeedRaw)).toFixed(2))
      : 0.98;

    const agentPayload: Record<string, unknown> = {
      provider: el<HTMLSelectElement>("set-agent-provider").value,
      customProviderName: el<HTMLInputElement>("set-agent-custom-name").value.trim(),
      customApiType: el<HTMLSelectElement>("set-agent-api-type").value,
      modelId: el<HTMLInputElement>("set-agent-model").value.trim(),
      baseUrl: el<HTMLInputElement>("set-agent-base-url").value.trim(),
      cavemanMode: el<HTMLSelectElement>("set-agent-caveman-mode").value,
      systemPromptExtra: el<HTMLTextAreaElement>("set-agent-system-prompt").value.trim(),
      voiceEngine: el<HTMLSelectElement>("set-voice-engine").value,
      voiceLang: el<HTMLSelectElement>("set-voice-lang").value,
      noiseSuppressionMode: el<HTMLSelectElement>("set-voice-noise-mode").value,
      vadMode: el<HTMLSelectElement>("set-voice-vad-mode").value,
      vadSilenceMs: Number(el<HTMLInputElement>("set-voice-vad-silence").value) || 750,
      wakeWordEnabled: el<HTMLInputElement>("set-voice-wake-enabled").checked,
      wakeWords: el<HTMLInputElement>("set-voice-wake-words").value,
      wakeAckPhrase: el<HTMLInputElement>("set-voice-wake-ack-phrase").value.trim(),
      conversationWindowSec,
      maxConsecutiveSidetalk,
      owwEnabled: el<HTMLInputElement>("set-oww-enabled").checked,
      owwThreshold,
      attentionMode: el<HTMLSelectElement>("set-voice-attention-mode").value,
      systemOneMode: el<HTMLSelectElement>("set-systemone-mode").value,
      systemOneModel: el<HTMLInputElement>("set-systemone-model").value.trim(),
      systemOneBaseUrl: el<HTMLInputElement>("set-systemone-base-url").value.trim(),
      voiceprintMode: el<HTMLSelectElement>("set-voiceprint-mode").value,
      voiceprintThreshold: Number(el<HTMLInputElement>("set-voiceprint-threshold").value) || 0.42,
      bargeInEnabled: el<HTMLInputElement>("set-voice-barge-in").checked,
      autoSpeakReply: el<HTMLInputElement>("set-voice-auto-speak").checked,
      ttsEngine: el<HTMLSelectElement>("set-voice-tts-engine").value,
      ttsVoice: el<HTMLSelectElement>("set-voice-tts-voice").value,
      ttsSpeed,
      sttBaseUrl: el<HTMLInputElement>("set-stt-base-url").value.trim(),
      sttModel: el<HTMLInputElement>("set-stt-model").value.trim(),
    };
    const newApiKey = el<HTMLInputElement>("set-agent-api-key").value.trim();
    if (this.agentClearKeyPending) {
      agentPayload.clearApiKey = true;
    } else if (newApiKey) {
      agentPayload.apiKey = newApiKey;
    }
    const newSttKey = el<HTMLInputElement>("set-stt-api-key").value.trim();
    if (this.sttClearKeyPending) {
      agentPayload.clearSttApiKey = true;
    } else if (newSttKey) {
      agentPayload.sttApiKey = newSttKey;
    }

    try {
      const agentRes = await apiPost<{
        config?: UiPublicAgentConfig;
        agent?: unknown;
        voice?: unknown;
      }>("/api/agent/config", agentPayload);
      const res = await apiPost<unknown>("/api/settings", payload);
      this.settingsOriginal = null;
      this.agentClearKeyPending = false;
      this.sttClearKeyPending = false;
      if (asRecord(res)) {
        this.applyStatePatch(res);
      } else {
        this.applySettingsObject(payload);
        this.renderAll();
      }
      if (agentRes?.config) this.agentConfigCache = agentRes.config;
      if (agentRes?.agent) this.piAgentPanel.applyAgentSnapshot(agentRes.agent);
      if (agentRes?.voice) this.piAgentPanel.applyVoiceSnapshot(agentRes.voice);
      this.reloadThemeStylesheet();
      this.closeModal();
      this.showToast("设置已保存", 2200);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.showToast(`保存设置失败：${msg}`, 3500);
    }
  }

  // -------------------------------------------------------------------------
  // Full Device Detail Modal & Light Control Popup Modal
  // -------------------------------------------------------------------------

  private openDeviceDetailModal(device: DeviceInfo): void {
    this.openModal("device-detail");
    this.deviceDetailModal.open(device);
  }

  private openLightModal(device: DeviceInfo): void {
    this.openModal("light");
    this.modalLightSession.open(device);
  }

  // -------------------------------------------------------------------------
  // Camera Preview Window (16:9 Canvas + PTZ Drag Gesture + Controls)
  // -------------------------------------------------------------------------

  private openCameraModal(device: DeviceInfo): void {
    this.cameraDevice = device;
    this.cameraMuted = true;
    this.cameraQuality = 1; // Always starts with smooth stream, never persisted
    this.cameraFullscreen = false;
    this.cameraPress = null;
    this.cameraGestureSent = false;
    this.cameraDragBusyUntil = 0;
    this.cameraPtzOffset = { x: 0, y: 0 };

    const knownPower = this.state.knownPower[device.did];
    this.cameraPowerState = typeof knownPower === "boolean" ? knownPower : true;

    el("camera-modal-title").textContent = device.name;
    el("camera-modal-room").textContent = device.room_name;

    const ptzSupported = device.model === PTZ_MODEL || isCamera(device);
    el("camera-drag-hint").hidden = !ptzSupported;
    this.updateCameraQualityMenuLabels(device.model === PTZ_MODEL);
    this.syncCameraControlsUi();

    this.openModal("camera");
    this.startCameraCanvasLoop();
  }

  private stopCameraPreview(): void {
    if (this.cameraFrameTimer !== null) {
      window.clearInterval(this.cameraFrameTimer);
      this.cameraFrameTimer = null;
    }
    if (this.cameraPtzFeedbackTimer !== null) {
      window.clearTimeout(this.cameraPtzFeedbackTimer);
      this.cameraPtzFeedbackTimer = null;
    }
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
    }
    el("camera-stage").classList.remove("is-fullscreen", "ptz-ready", "ptz-dragging", "ptz-busy");
    this.cameraDevice = null;
  }

  private updateCameraQualityMenuLabels(knownModel: boolean): void {
    const items = document.querySelectorAll<HTMLButtonElement>("#camera-quality-menu [data-quality]");
    items.forEach((item) => {
      const q = Number(item.dataset.quality);
      if (q === 0) item.textContent = "自动";
      else if (q === 1) item.textContent = knownModel ? "360P 流畅" : "流畅";
      else if (q === 2) item.textContent = knownModel ? "2K 高清" : "高清";
      item.classList.toggle("checked", q === this.cameraQuality);
    });
  }

  private syncCameraControlsUi(): void {
    const device = this.cameraDevice;
    if (!device) return;

    const powerBtn = el<HTMLButtonElement>("camera-power-btn");
    powerBtn.disabled = !device.online || this.cameraPowerBusy;
    powerBtn.classList.remove("is-on", "is-off", "is-unknown", "is-offline", "is-busy");
    if (!device.online) {
      powerBtn.classList.add("is-offline");
    } else if (this.cameraPowerBusy) {
      powerBtn.classList.add("is-busy");
    } else if (this.cameraPowerState === true) {
      powerBtn.classList.add("is-on");
      powerBtn.title = "让摄像头休眠";
    } else if (this.cameraPowerState === false) {
      powerBtn.classList.add("is-off");
      powerBtn.title = "唤醒摄像头";
    } else {
      powerBtn.classList.add("is-unknown");
      powerBtn.title = "摄像头开关";
    }

    const active = device.online && this.cameraPowerState !== false;
    const notice = el("camera-notice");
    const noticeText = el("camera-notice-text");
    if (!device.online) {
      notice.hidden = false;
      noticeText.textContent = "摄像头已离线";
    } else if (this.cameraPowerState === false) {
      notice.hidden = false;
      noticeText.textContent = "摄像机已休眠";
    } else {
      notice.hidden = true;
    }

    const muteBtn = el<HTMLButtonElement>("camera-mute-btn");
    muteBtn.disabled = !active;
    muteBtn.title = this.cameraMuted ? "开启声音" : "静音";
    muteBtn.setAttribute("aria-label", muteBtn.title);
    el("camera-icon-muted").hidden = !this.cameraMuted;
    el("camera-icon-sound").hidden = this.cameraMuted;

    const qualityBtn = el<HTMLButtonElement>("camera-quality-btn");
    qualityBtn.disabled = !active;
    qualityBtn.textContent =
      this.cameraQuality === 0 ? "自动" : this.cameraQuality === 2 ? "2K 高清" : "360P 流畅";

    const fsBtn = el<HTMLButtonElement>("camera-fullscreen-btn");
    fsBtn.title = this.cameraFullscreen ? "退出全屏（Esc）" : "全屏观看";
    fsBtn.setAttribute("aria-label", fsBtn.title);
    el("camera-icon-fs-enter").hidden = this.cameraFullscreen;
    el("camera-icon-fs-exit").hidden = !this.cameraFullscreen;

    const stage = el("camera-stage");
    const now = performance.now();
    const ptzBusy = now < this.cameraDragBusyUntil;
    stage.classList.toggle("ptz-ready", active && !ptzBusy && !this.cameraPress);
    stage.classList.toggle("ptz-busy", active && ptzBusy);
  }

  private startCameraCanvasLoop(): void {
    if (this.cameraFrameTimer !== null) {
      window.clearInterval(this.cameraFrameTimer);
    }
    this.drawCameraCanvasFrame();
    this.cameraFrameTimer = window.setInterval(() => {
      this.drawCameraCanvasFrame();
      if (this.cameraDragBusyUntil > 0 && performance.now() >= this.cameraDragBusyUntil) {
        this.cameraDragBusyUntil = 0;
        this.syncCameraControlsUi();
      }
    }, 1000);
  }

  private drawCameraCanvasFrame(): void {
    const canvas = el<HTMLCanvasElement>("camera-canvas");
    const ctx = canvas.getContext("2d");
    const device = this.cameraDevice;
    if (!ctx || !device) return;

    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    // Rich dark preview stage backdrop
    const grad = ctx.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, "#151922");
    grad.addColorStop(0.55, "#1b212e");
    grad.addColorStop(1, "#11151d");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    if (!device.online || this.cameraPowerState === false) {
      return;
    }

    // Subtle pan/tilt perspective grid shifted by PTZ offset
    const ox = this.cameraPtzOffset.x * 28;
    const oy = this.cameraPtzOffset.y * 22;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.06)";
    ctx.lineWidth = 1;
    for (let x = -120; x <= w + 120; x += 64) {
      ctx.beginPath();
      ctx.moveTo(x + ox, 0);
      ctx.lineTo(x + ox, h);
      ctx.stroke();
    }
    for (let y = -120; y <= h + 120; y += 64) {
      ctx.beginPath();
      ctx.moveTo(0, y + oy);
      ctx.lineTo(w, y + oy);
      ctx.stroke();
    }

    // Center camera reticle + lens indicator
    const cx = w / 2 + ox;
    const cy = h / 2 + oy;
    ctx.strokeStyle = "rgba(61, 187, 164, 0.45)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, 42, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - 56, cy);
    ctx.lineTo(cx - 28, cy);
    ctx.moveTo(cx + 28, cy);
    ctx.lineTo(cx + 56, cy);
    ctx.moveTo(cx, cy - 56);
    ctx.lineTo(cx, cy - 28);
    ctx.moveTo(cx, cy + 28);
    ctx.lineTo(cx, cy + 56);
    ctx.stroke();

    // Top-left live status badge + timestamp
    const nowStr = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    const resLabel = this.cameraQuality === 2 ? "2304 × 1296 · 2K" : "640 × 360 · 流畅";
    ctx.fillStyle = "rgba(0, 0, 0, 0.48)";
    ctx.beginPath();
    ctx.roundRect(18, 16, 224, 30, 8);
    ctx.fill();
    ctx.fillStyle = "#3dbba4";
    ctx.beginPath();
    ctx.arc(32, 31, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#eef2f8";
    ctx.font = '600 13px "Microsoft YaHei UI", sans-serif';
    ctx.fillText(`实时预览 · ${nowStr}`, 44, 36);

    ctx.fillStyle = "rgba(0, 0, 0, 0.48)";
    ctx.beginPath();
    ctx.roundRect(w - 178, 16, 160, 30, 8);
    ctx.fill();
    ctx.fillStyle = "rgba(238, 242, 248, 0.88)";
    ctx.font = '500 12px "Microsoft YaHei UI", sans-serif';
    ctx.fillText(resLabel, w - 164, 35);

    ctx.fillStyle = "rgba(238, 242, 248, 0.55)";
    ctx.font = '400 13px "Microsoft YaHei UI", sans-serif';
    ctx.textAlign = "center";
    ctx.fillText(
      `${device.name} · 按住画面拖动可控制云台方向`,
      w / 2,
      h - 86,
    );
    ctx.textAlign = "start";
  }

  private async sendCameraPtz(direction: number): Promise<void> {
    const device = this.cameraDevice;
    if (!device || !device.online || this.cameraPowerState === false) return;
    const info = PTZ_LABELS[direction];
    if (!info) return;

    this.cameraDragBusyUntil = performance.now() + 1500;
    this.cameraPtzOffset.x = Math.max(-4, Math.min(4, this.cameraPtzOffset.x + info.dx));
    this.cameraPtzOffset.y = Math.max(-3, Math.min(3, this.cameraPtzOffset.y + info.dy));
    this.syncCameraControlsUi();
    this.drawCameraCanvasFrame();

    const fb = el("camera-ptz-feedback");
    el("camera-ptz-arrow").textContent = info.arrow;
    el("camera-ptz-label").textContent = info.label;
    fb.hidden = false;
    if (this.cameraPtzFeedbackTimer !== null) {
      window.clearTimeout(this.cameraPtzFeedbackTimer);
    }
    this.cameraPtzFeedbackTimer = window.setTimeout(() => {
      fb.hidden = true;
      this.cameraPtzFeedbackTimer = null;
    }, 1100);

    try {
      await apiPost(`/api/camera/${encodeURIComponent(device.did)}/ptz`, { direction });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.showToast(`云台控制失败：${msg}`, 2500);
    }
  }

  private async toggleCameraPower(): Promise<void> {
    const device = this.cameraDevice;
    if (!device || !device.online || this.cameraPowerBusy) return;
    const target = this.cameraPowerState === false;
    this.cameraPowerBusy = true;
    this.syncCameraControlsUi();
    try {
      await apiPost(`/api/devices/${encodeURIComponent(device.did)}/power`, { state: target });
      this.cameraPowerState = target;
      this.state.knownPower[device.did] = target;
      this.renderGrid();
    } catch {
      this.showToast("摄像头开关操作失败，请重试", 3000);
    } finally {
      this.cameraPowerBusy = false;
      this.syncCameraControlsUi();
      this.drawCameraCanvasFrame();
    }
  }

  private toggleCameraFullscreen(): void {
    const stage = el("camera-stage");
    if (this.cameraFullscreen) {
      if (document.fullscreenElement) {
        void document.exitFullscreen().catch(() => {});
      }
      stage.classList.remove("is-fullscreen");
      this.cameraFullscreen = false;
      this.syncCameraControlsUi();
      return;
    }
    this.cameraFullscreen = true;
    stage.classList.add("is-fullscreen");
    if (typeof stage.requestFullscreen === "function") {
      void stage.requestFullscreen().catch(() => {
        // CSS fullscreen fallback remains active
      });
    }
    this.syncCameraControlsUi();
  }

  // -------------------------------------------------------------------------
  // Tray Manager Dialog (Devices/Scenes + Room Filter + Drag-and-Drop Sort)
  // -------------------------------------------------------------------------

  private openTrayManagerModal(): void {
    this.trayMgrTab = "devices";
    this.trayMgrView = "list";
    this.trayMgrRoom = "";
    this.trayMgrCheckedDevices = new Set(this.state.trayDevices);
    this.trayMgrCheckedScenes = new Set(this.state.trayScenes.map((s) => s.scene_id));
    this.trayMgrOrder = this.state.trayOrder.map((o) => ({ ...o }));

    this.populateTrayManagerRoomFilter();
    this.renderTrayManager();
    this.openModal("tray-manager");
  }

  private populateTrayManagerRoomFilter(): void {
    const eligible = this.state.devices.filter((d) => trayEligible(d));
    const rooms = [...new Set(eligible.map((d) => d.room_name || UNASSIGNED_ROOM))].sort((a, b) =>
      a.localeCompare(b, "zh-CN"),
    );
    const select = el<HTMLSelectElement>("tray-mgr-room-filter");
    select.replaceChildren();
    const allOpt = document.createElement("option");
    allOpt.value = "";
    allOpt.textContent = "全部房间";
    select.appendChild(allOpt);
    for (const room of rooms) {
      const opt = document.createElement("option");
      opt.value = room;
      opt.textContent = room;
      select.appendChild(opt);
    }
    select.value = this.trayMgrRoom;
  }

  private renderTrayManager(): void {
    const isList = this.trayMgrView === "list";
    const isDev = this.trayMgrTab === "devices";

    el("tray-mgr-tabs").hidden = !isList;
    el("tray-mgr-sort-btn").textContent = isList ? "排序" : "返回";
    el("tray-mgr-room-filter").hidden = !(isList && isDev);

    if (!isList) {
      el("tray-mgr-subtitle").textContent = "长按拖拽调整托盘项目的显示顺序";
    } else if (isDev) {
      el("tray-mgr-subtitle").textContent = "勾选加入托盘快捷窗口";
    } else {
      el("tray-mgr-subtitle").textContent = "勾选加入托盘快捷窗口，点击行内按钮可立即执行场景";
    }

    document.querySelectorAll<HTMLButtonElement>("[data-tm-tab]").forEach((btn) => {
      const active = btn.dataset.tmTab === this.trayMgrTab;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-selected", String(active));
    });

    const list = el("tray-mgr-list");
    list.replaceChildren();

    if (!isList) {
      this.renderTrayManagerSortRows(list);
      return;
    }

    if (isDev) {
      const eligible = this.state.devices.filter((d) => trayEligible(d));
      const devMap = new Map(eligible.map((d) => [d.did, d]));
      const ordered: DeviceInfo[] = [];
      for (const did of this.state.trayDevices) {
        const dev = devMap.get(did);
        if (dev) ordered.push(dev);
      }
      const orderedSet = new Set(ordered.map((d) => d.did));
      const rest = eligible
        .filter((d) => !orderedSet.has(d.did))
        .sort((a, b) => {
          if (a.online !== b.online) return a.online ? -1 : 1;
          return a.name.localeCompare(b.name, "zh-CN");
        });
      const rows = [...ordered, ...rest].filter((d) => {
        if (!this.trayMgrRoom) return true;
        return (d.room_name || UNASSIGNED_ROOM) === this.trayMgrRoom;
      });

      if (rows.length === 0) {
        const empty = document.createElement("div");
        empty.className = "tray-mgr-empty";
        empty.textContent = "当前房间暂无可添加的设备";
        list.appendChild(empty);
        return;
      }

      for (const dev of rows) {
        const checked = this.trayMgrCheckedDevices.has(dev.did);
        const row = document.createElement("div");
        row.className = `tray-mgr-row${dev.online ? "" : " offline"}`;

        const label = document.createElement("span");
        label.className = "tray-mgr-row-label";
        label.textContent = `${deviceTitle(dev)}  ·  ${dev.room_name || UNASSIGNED_ROOM}`;

        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = `tray-mgr-toggle-btn${checked ? " checked" : ""}`;
        toggle.textContent = checked ? "✓" : "+";
        toggle.setAttribute("aria-pressed", String(checked));
        toggle.addEventListener("click", () => {
          if (this.trayMgrCheckedDevices.has(dev.did)) {
            this.trayMgrCheckedDevices.delete(dev.did);
          } else {
            this.trayMgrCheckedDevices.add(dev.did);
          }
          this.renderTrayManager();
        });

        row.append(label, toggle);
        list.appendChild(row);
      }
      return;
    }

    // Scenes tab
    if (!this.state.settings.show_scene_tab) {
      const empty = document.createElement("div");
      empty.className = "tray-mgr-empty";
      empty.textContent =
        "场景功能未开启\n请先在 设置 → 主题界面 中开启「显示场景选项卡」，再回到此处添加场景";
      list.appendChild(empty);
      return;
    }
    if (this.state.scenes.length === 0) {
      const empty = document.createElement("div");
      empty.className = "tray-mgr-empty";
      empty.textContent = "暂无场景\n可在米家 APP「智能」中创建手动场景后再回来添加";
      list.appendChild(empty);
      return;
    }

    const sortedScenes = [...this.state.scenes].sort((a, b) =>
      a.name.localeCompare(b.name, "zh-CN"),
    );
    for (const scene of sortedScenes) {
      const checked = this.trayMgrCheckedScenes.has(scene.scene_id);
      const row = document.createElement("div");
      row.className = "tray-mgr-row";

      const label = document.createElement("span");
      label.className = "tray-mgr-row-label";
      label.textContent = scene.home_name ? `${scene.name}  ·  ${scene.home_name}` : scene.name;

      const runBtn = document.createElement("button");
      runBtn.type = "button";
      runBtn.className = "scene-run-btn sm";
      runBtn.title = "立即执行";
      runBtn.setAttribute("aria-label", `执行场景 ${scene.name}`);
      runBtn.innerHTML = PLAY_SOLID_SVG;
      runBtn.addEventListener("click", () => void this.runScene(scene));

      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = `tray-mgr-toggle-btn${checked ? " checked" : ""}`;
      toggle.textContent = checked ? "✓" : "+";
      toggle.setAttribute("aria-pressed", String(checked));
      toggle.addEventListener("click", () => {
        if (this.trayMgrCheckedScenes.has(scene.scene_id)) {
          this.trayMgrCheckedScenes.delete(scene.scene_id);
        } else {
          this.trayMgrCheckedScenes.add(scene.scene_id);
        }
        this.renderTrayManager();
      });

      row.append(label, runBtn, toggle);
      list.appendChild(row);
    }
  }

  private buildNormalizedDraftOrder(): TrayOrderItem[] {
    const checked: TrayOrderItem[] = [];
    for (const did of this.trayMgrCheckedDevices) {
      checked.push({ type: "device", id: did });
    }
    for (const sid of this.trayMgrCheckedScenes) {
      checked.push({ type: "scene", id: sid });
    }
    const checkedKeys = new Set(checked.map((c) => `${c.type}:${c.id}`));
    const result = this.trayMgrOrder.filter((it) => checkedKeys.has(`${it.type}:${it.id}`));
    const seen = new Set(result.map((it) => `${it.type}:${it.id}`));
    for (const it of checked) {
      const k = `${it.type}:${it.id}`;
      if (!seen.has(k)) {
        result.push(it);
        seen.add(k);
      }
    }
    this.trayMgrOrder = result;
    return result;
  }

  private renderTrayManagerSortRows(list: HTMLElement): void {
    const order = this.buildNormalizedDraftOrder();
    if (order.length === 0) {
      const empty = document.createElement("div");
      empty.className = "tray-mgr-empty";
      empty.textContent = "暂无已加入托盘的项目\n先在设备或场景页勾选添加";
      list.appendChild(empty);
      return;
    }

    const devMap = new Map(this.state.devices.map((d) => [d.did, d]));
    const sceneMap = new Map<string, SceneInfo>();
    for (const s of this.state.trayScenes) sceneMap.set(s.scene_id, s);
    for (const s of this.state.scenes) sceneMap.set(s.scene_id, s);

    for (const item of order) {
      const key = `${item.type}:${item.id}`;
      let labelText = item.id;
      let online = true;
      if (item.type === "device") {
        const dev = devMap.get(item.id);
        if (!dev) continue;
        labelText = `${deviceTitle(dev)}  ·  ${dev.room_name || UNASSIGNED_ROOM}`;
        online = dev.online;
      } else {
        const sc = sceneMap.get(item.id);
        if (!sc) continue;
        labelText = sc.home_name ? `${sc.name}  ·  ${sc.home_name}` : sc.name;
      }

      const row = document.createElement("div");
      row.className = `tray-mgr-row sortable${online ? "" : " offline"}`;
      row.draggable = true;
      row.dataset.sortKey = key;

      const handle = document.createElement("span");
      handle.className = "tray-mgr-drag-icon";
      handle.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="9" x2="20" y2="9"></line><line x1="4" y1="15" x2="20" y2="15"></line></svg>`;

      const pill = document.createElement("span");
      pill.className = `tray-mgr-type-pill${item.type === "scene" ? " scene" : ""}`;
      pill.textContent = item.type === "scene" ? "场景" : "设备";

      const label = document.createElement("span");
      label.className = "tray-mgr-row-label";
      label.textContent = labelText;

      row.append(handle, pill, label);

      row.addEventListener("dragstart", (e) => {
        this.trayMgrDragKey = key;
        row.classList.add("dragging");
        e.dataTransfer?.setData("text/plain", key);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      });
      row.addEventListener("dragend", () => {
        this.trayMgrDragKey = null;
        row.classList.remove("dragging");
        list
          .querySelectorAll(".drag-over-top, .drag-over-bottom")
          .forEach((n) => n.classList.remove("drag-over-top", "drag-over-bottom"));
      });
      row.addEventListener("dragover", (e) => {
        e.preventDefault();
        if (!this.trayMgrDragKey || this.trayMgrDragKey === key) return;
        const rect = row.getBoundingClientRect();
        const after = e.clientY > rect.top + rect.height / 2;
        row.classList.toggle("drag-over-top", !after);
        row.classList.toggle("drag-over-bottom", after);
      });
      row.addEventListener("dragleave", () => {
        row.classList.remove("drag-over-top", "drag-over-bottom");
      });
      row.addEventListener("drop", (e) => {
        e.preventDefault();
        const dragKey = this.trayMgrDragKey || e.dataTransfer?.getData("text/plain") || "";
        row.classList.remove("drag-over-top", "drag-over-bottom");
        if (!dragKey || dragKey === key) return;
        const rect = row.getBoundingClientRect();
        const after = e.clientY > rect.top + rect.height / 2;
        this.reorderTrayDraft(dragKey, key, after);
      });

      list.appendChild(row);
    }
  }

  private reorderTrayDraft(dragKey: string, targetKey: string, after: boolean): void {
    const order = this.buildNormalizedDraftOrder();
    const srcIdx = order.findIndex((it) => `${it.type}:${it.id}` === dragKey);
    if (srcIdx < 0) return;
    const [moved] = order.splice(srcIdx, 1);
    let dstIdx = order.findIndex((it) => `${it.type}:${it.id}` === targetKey);
    if (dstIdx < 0) {
      order.splice(srcIdx, 0, moved);
      return;
    }
    if (after) dstIdx += 1;
    order.splice(dstIdx, 0, moved);
    this.trayMgrOrder = order;
    this.renderTrayManager();
  }

  private async saveTrayManager(): Promise<void> {
    const order = this.buildNormalizedDraftOrder();
    const devices = order.filter((o) => o.type === "device").map((o) => o.id);
    const sceneLookup = new Map<string, TraySceneSnapshot>();
    for (const s of this.state.trayScenes) sceneLookup.set(s.scene_id, s);
    for (const s of this.state.scenes) {
      sceneLookup.set(s.scene_id, {
        scene_id: s.scene_id,
        name: s.name,
        home_id: s.home_id,
        home_name: s.home_name,
      });
    }
    const scenes: TraySceneSnapshot[] = order
      .filter((o) => o.type === "scene")
      .map((o) => sceneLookup.get(o.id))
      .filter((s): s is TraySceneSnapshot => s !== undefined);

    try {
      const res = await apiPost<unknown>("/api/tray/save", { devices, scenes, order });
      const rec = asRecord(res);
      if (rec && ("state" in rec || "tray" in rec || "trayDevices" in rec)) {
        this.applyStatePatch(rec);
      } else {
        this.state.trayDevices = devices;
        this.state.trayScenes = scenes;
        this.state.trayOrder = order;
      }
      if (this.trayOpen) this.renderTrayWindow();
      this.closeModal();
      this.showToast("已保存托盘快捷卡片", 2200);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.showToast(`保存失败：${msg}`, 3500);
    }
  }

  // -------------------------------------------------------------------------
  // QR Login Modal
  // -------------------------------------------------------------------------

  private openLoginModal(): void {
    this.openModal("login");
    void this.beginQrLogin();
  }

  private async beginQrLogin(): Promise<void> {
    this.loginGeneration += 1;
    const gen = this.loginGeneration;
    const qrBox = el("login-qr-box");
    const status = el("login-status");
    const retryBtn = el<HTMLButtonElement>("login-retry-btn");

    retryBtn.hidden = true;
    status.classList.remove("error");
    status.textContent = "正在获取登录二维码…";
    qrBox.innerHTML = `<span class="login-qr-placeholder">正在获取…</span>`;

    try {
      const res = await apiPost<unknown>("/api/auth/qr/begin");
      if (gen !== this.loginGeneration || this.activeModal !== "login") return;
      const rec = asRecord(res);
      if (
        res === null ||
        (rec && (readBool(rec, "alreadyLoggedIn", "already_logged_in", "refreshed") === true))
      ) {
        this.closeModal();
        await this.fetchState();
        this.showToast("登录成功", 2500);
        return;
      }

      const svgText = rec ? readStr(rec, "svg", "qrSvg", "qr_svg") : undefined;
      const loginDataObj = rec ? asRecord(rec.loginData ?? rec.data) : null;
      const loginUrl =
        (rec ? readStr(rec, "loginUrl", "login_url") : undefined) ??
        (loginDataObj ? readStr(loginDataObj, "loginUrl", "login_url") : undefined);

      if (svgText) {
        this.renderSafeSvg(qrBox, svgText);
      } else if (loginUrl) {
        this.renderSafeSvg(qrBox, renderQrSvg(loginUrl, 224));
      } else {
        throw new Error("未返回有效的登录二维码");
      }

      status.textContent = "请使用米家 APP 扫描二维码";
      const waitBody = loginDataObj ? { loginData: loginDataObj } : { loginData: rec ?? {} };
      const waitRes = await apiPost<unknown>("/api/auth/qr/wait", waitBody);
      if (gen !== this.loginGeneration || this.activeModal !== "login") return;

      this.closeModal();
      if (asRecord(waitRes)) {
        this.applyStatePatch(waitRes);
      }
      await this.fetchState();
      this.showToast("米家账号登录成功", 2500);
    } catch (err) {
      if (gen !== this.loginGeneration || this.activeModal !== "login") return;
      const msg = err instanceof Error ? err.message : String(err);
      status.classList.add("error");
      status.textContent = msg || "扫码登录失败，请重试";
      retryBtn.hidden = false;
    }
  }

  private renderSafeSvg(container: HTMLElement, svgMarkup: string): void {
    const parser = new DOMParser();
    const doc = parser.parseFromString(svgMarkup, "image/svg+xml");
    const svg = doc.querySelector("svg");
    container.replaceChildren();
    if (svg) {
      container.appendChild(document.importNode(svg, true));
    } else {
      const span = document.createElement("span");
      span.className = "login-qr-placeholder";
      span.textContent = "二维码渲染失败";
      container.appendChild(span);
    }
  }

  private async handleAccountAction(): Promise<void> {
    if (!this.state.loggedIn) {
      this.openLoginModal();
      return;
    }
    try {
      const res = await apiPost<unknown>("/api/auth/logout");
      if (asRecord(res)) {
        this.applyStatePatch(res);
      } else {
        this.state.loggedIn = false;
        this.state.accessState = "signed_out";
        this.state.devices = [];
        this.state.scenes = [];
        this.renderAll();
      }
      this.showToast("已退出登录", 2500);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.showToast(`退出登录失败：${msg}`, 3500);
    }
  }

  // -------------------------------------------------------------------------
  // Diagnostic Report Modal (explicit copy only!)
  // -------------------------------------------------------------------------

  private openDiagnosticsModal(preselectedDid?: string): void {
    this.diagDevices = [...this.state.devices];
    const select = el<HTMLSelectElement>("diag-device-select");
    select.replaceChildren();
    for (const dev of this.diagDevices) {
      const opt = document.createElement("option");
      opt.value = dev.did;
      opt.textContent = `${dev.name} · ${dev.model}`;
      select.appendChild(opt);
    }
    if (preselectedDid && this.diagDevices.some((d) => d.did === preselectedDid)) {
      select.value = preselectedDid;
    }

    el<HTMLButtonElement>("diag-regen-btn").disabled = this.diagDevices.length === 0;
    this.openModal("diagnostics");
    void this.generateDiagnosticsReport();
  }

  private async generateDiagnosticsReport(): Promise<void> {
    const select = el<HTMLSelectElement>("diag-device-select");
    const preview = el<HTMLTextAreaElement>("diag-preview");
    const status = el("diag-status");
    const regenBtn = el<HTMLButtonElement>("diag-regen-btn");
    const copyBtn = el<HTMLButtonElement>("diag-copy-btn");

    if (this.diagDevices.length === 0) {
      preview.value = "";
      copyBtn.disabled = true;
      copyBtn.textContent = "复制诊断报告";
      status.textContent = "当前没有可诊断的设备，请先登录并刷新设备。";
      return;
    }

    this.diagGeneration += 1;
    const gen = this.diagGeneration;
    const did = select.value || this.diagDevices[0].did;

    preview.value = "";
    copyBtn.disabled = true;
    copyBtn.textContent = "复制诊断报告";
    regenBtn.disabled = true;
    status.textContent = "正在获取设备能力定义，不会操作设备…";

    try {
      const res = await apiPost<unknown>("/api/diagnostics", { did });
      if (gen !== this.diagGeneration || this.activeModal !== "diagnostics") return;
      let reportText = "";
      if (typeof res === "string") {
        reportText = res;
      } else {
        const rec = asRecord(res);
        if (rec && typeof rec.report === "string") {
          reportText = rec.report;
        } else if (rec && rec.report !== undefined) {
          reportText = JSON.stringify(rec.report, null, 2);
        } else {
          reportText = JSON.stringify(res, null, 2);
        }
      }
      preview.value = reportText;
      copyBtn.disabled = reportText.length === 0;
      regenBtn.disabled = false;
      status.textContent =
        "报告已生成。能力定义不代表功能已支持；未尝试的连接不会被记为成功。";
    } catch {
      if (gen !== this.diagGeneration || this.activeModal !== "diagnostics") return;
      regenBtn.disabled = false;
      copyBtn.disabled = true;
      status.textContent = "报告生成失败，请重试。未复制任何内容。";
    }
  }

  private async copyDiagnosticsReport(): Promise<void> {
    const preview = el<HTMLTextAreaElement>("diag-preview");
    const copyBtn = el<HTMLButtonElement>("diag-copy-btn");
    if (copyBtn.disabled || !preview.value) return;
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
        await navigator.clipboard.writeText(preview.value);
      } else {
        preview.focus();
        preview.select();
        document.execCommand("copy");
      }
      copyBtn.textContent = "已复制";
    } catch {
      this.showToast("复制失败，请手动全选文本框复制", 3000);
    }
  }

  // -------------------------------------------------------------------------
  // Event Binding
  // -------------------------------------------------------------------------

  private bindGlobalEvents(): void {
    document.addEventListener("click", (e) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (
        !target.closest(".menu-anchor") &&
        !target.closest("#context-menu")
      ) {
        this.closeAllMenus();
      }
    });

    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (!el("context-menu").hidden) {
        this.closeAllMenus();
        return;
      }
      if (this.activeModal === "camera" && this.cameraFullscreen) {
        this.toggleCameraFullscreen();
        return;
      }
      if (this.activeModal) {
        this.closeModal();
        return;
      }
      if (this.trayLightOpen) {
        this.closeTrayLightPage();
        return;
      }
      if (this.piAgentPanel.isOpen()) {
        this.piAgentPanel.setOpen(false);
        return;
      }
      if (this.voiceFabExpanded) {
        this.collapseVoiceFab();
      }
    });

    document.addEventListener("fullscreenchange", () => {
      if (!document.fullscreenElement && this.cameraFullscreen) {
        this.cameraFullscreen = false;
        el("camera-stage").classList.remove("is-fullscreen");
        this.syncCameraControlsUi();
      }
    });
  }

  private bindTitleBarEvents(): void {
    el("tray-toggle-btn").addEventListener("click", () => {
      this.toggleTrayWindow();
    });

    el("theme-quick-btn").addEventListener("click", async () => {
      const nextMode: ThemeMode = this.state.resolvedTheme === "dark" ? "light" : "dark";
      this.state.settings.theme = nextMode;
      this.state.resolvedTheme = nextMode;
      this.renderTitleBar();
      try {
        await apiPost("/api/settings", { theme: nextMode, themeMode: nextMode });
        this.reloadThemeStylesheet();
      } catch {
        await this.previewTheme({ mode: nextMode });
      }
    });
  }

  private bindHeaderEvents(): void {
    el("home-switcher-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      const menu = el("home-menu");
      const open = menu.hidden;
      this.closeAllMenus();
      if (!open) return;

      menu.replaceChildren();
      const hasAll = this.state.homes.includes(ALL_HOMES);
      const entries =
        this.state.homes.length > 1
          ? hasAll
            ? [...this.state.homes]
            : [ALL_HOMES, ...this.state.homes]
          : this.state.homes.length === 1
            ? [this.state.homes[0]]
            : ["我的家庭"];
      const current =
        this.state.currentHome || (this.state.homes.length > 1 ? ALL_HOMES : entries[0]);

      for (const name of entries) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = `popup-menu-item${name === current ? " checked" : ""}`;
        btn.setAttribute("role", "menuitem");
        const span = document.createElement("span");
        span.textContent = name;
        btn.appendChild(span);
        if (name === current) {
          const chk = document.createElement("span");
          chk.className = "menu-check";
          chk.textContent = "✓";
          btn.appendChild(chk);
        }
        btn.addEventListener("click", () => void this.selectHome(name));
        menu.appendChild(btn);
      }

      menu.hidden = false;
      el("home-switcher-btn").setAttribute("aria-expanded", "true");
    });

    el("refresh-btn").addEventListener("click", () => {
      void this.refreshDevices();
    });

    el("more-menu-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      const menu = el("more-menu");
      const open = menu.hidden;
      this.closeAllMenus();
      if (open) {
        menu.hidden = false;
        el("more-menu-btn").setAttribute("aria-expanded", "true");
      }
    });

    el("more-menu").addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement | null)?.closest<HTMLButtonElement>("[data-action]");
      if (!btn) return;
      this.closeAllMenus();
      switch (btn.dataset.action) {
        case "tray-manager":
          this.openTrayManagerModal();
          break;
        case "settings":
          void this.openSettingsModal();
          break;
        case "diagnostics":
          this.openDiagnosticsModal();
          break;
        case "about":
          this.openAboutModal();
          break;
      }
    });

    el("room-menu-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      const menu = el("room-menu");
      const open = menu.hidden;
      this.closeAllMenus();
      if (!open) return;

      menu.replaceChildren();
      const tabs = this.computeRoomTabs();
      const inHome = this.devicesInCurrentHome();
      const serverMenu = this.state.roomMenu;
      const entries: RoomMenuEntry[] =
        serverMenu && serverMenu.length > 0
          ? serverMenu
          : tabs.map((name) => ({
              name,
              count:
                name === SCENE_TAB
                  ? null
                  : name === ALL_ROOMS
                    ? inHome.length
                    : inHome.filter((d) => d.room_name === name).length,
            }));
      for (const { name, count } of entries) {
        const selected = name === this.state.currentRoom;
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = `popup-menu-item room-popup-item${selected ? " checked" : ""}`;
        btn.setAttribute("role", "menuitem");
        btn.setAttribute("aria-label", count !== null ? `${name}，${count} 台设备` : name);

        const title = document.createElement("span");
        title.textContent = name;
        const num = document.createElement("span");
        num.className = "room-popup-count";
        num.textContent = count === null ? "" : String(count);

        btn.append(title, num);
        btn.addEventListener("click", () => void this.selectRoom(name));
        menu.appendChild(btn);
      }

      menu.hidden = false;
      el("room-menu-btn").setAttribute("aria-expanded", "true");
    });
  }

  private bindRoomStripDrag(): void {
    const strip = el("room-strip");

    strip.addEventListener(
      "wheel",
      (e) => {
        if (strip.scrollWidth <= strip.clientWidth) return;
        const delta = e.deltaX || e.deltaY;
        if (delta) {
          e.preventDefault();
          strip.scrollLeft += delta;
        }
      },
      { passive: false },
    );

    strip.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      this.roomPress = { x: e.clientX, y: e.clientY, scrollLeft: strip.scrollLeft };
      this.roomDragged = false;
      this.roomSuppressClick = false;
    });

    window.addEventListener("mousemove", (e) => {
      if (!this.roomPress) return;
      const dx = e.clientX - this.roomPress.x;
      const dy = e.clientY - this.roomPress.y;
      if (
        !this.roomDragged &&
        strip.scrollWidth > strip.clientWidth &&
        Math.abs(dx) >= 10 &&
        Math.abs(dx) > Math.abs(dy)
      ) {
        this.roomDragged = true;
        strip.classList.add("is-dragging");
      }
      if (this.roomDragged) {
        strip.scrollLeft = this.roomPress.scrollLeft - dx;
      }
    });

    window.addEventListener("mouseup", () => {
      if (!this.roomPress) return;
      if (this.roomDragged) {
        this.roomSuppressClick = true;
        window.setTimeout(() => {
          this.roomSuppressClick = false;
        }, 0);
      }
      this.roomPress = null;
      this.roomDragged = false;
      strip.classList.remove("is-dragging");
    });
  }

  private bindVoiceFabEvents(): void {
    el("voice-fab-ball").addEventListener("click", () => {
      if (this.voiceFabExpanded) {
        this.collapseVoiceFab();
      } else {
        this.expandVoiceFab();
      }
    });

    const input = el<HTMLInputElement>("voice-fab-input");
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const text = input.value.trim();
        if (!text) return;
        this.collapseVoiceFab();
        void this.submitVoiceCommand(text);
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.collapseVoiceFab();
      }
    });
  }

  private expandVoiceFab(): void {
    this.voiceFabExpanded = true;
    const fab = el("voice-fab");
    fab.classList.add("expanded");
    el("voice-fab-panel").setAttribute("aria-hidden", "false");
    el("voice-fab-ball").setAttribute("aria-expanded", "true");
    const input = el<HTMLInputElement>("voice-fab-input");
    input.value = "";
    input.focus();
    this.voiceFabTypewriter.start();
  }

  private collapseVoiceFab(): void {
    this.voiceFabExpanded = false;
    el("voice-fab").classList.remove("expanded");
    el("voice-fab-panel").setAttribute("aria-hidden", "true");
    el("voice-fab-ball").setAttribute("aria-expanded", "false");
    this.voiceFabTypewriter.stop(true);
    el<HTMLInputElement>("voice-fab-input").value = "";
  }

  private bindFooterEvents(): void {
    el("footer-version-btn").addEventListener("click", () => {
      void this.checkUpdate(true);
    });
    el("footer-update-btn").addEventListener("click", () => {
      if (this.state.release?.url) {
        window.open(this.state.release.url, "_blank", "noopener,noreferrer");
      }
    });
    el("footer-account-btn").addEventListener("click", () => {
      void this.handleAccountAction();
    });
  }

  private bindTrayEvents(): void {
    el("tray-close-btn").addEventListener("click", () => this.toggleTrayWindow(false));
    el("tray-cols-btn").addEventListener("click", () => void this.toggleTrayColumns());
    el("tray-edit-btn").addEventListener("click", () => this.openTrayManagerModal());
    el("tray-light-close-btn").addEventListener("click", () => this.closeTrayLightPage());

    // Speaker selector menu
    el("tray-speaker-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      const menu = el("tray-speaker-menu");
      const open = menu.hidden;
      this.closeAllMenus();
      if (!open) return;

      menu.replaceChildren();
      const pref = this.state.settings.default_speaker_did;
      const speakers = this.state.devices
        .filter((d) => isSpeaker(d))
        .sort((a, b) => {
          if (a.online !== b.online) return a.online ? -1 : 1;
          return a.name.localeCompare(b.name, "zh-CN");
        });

      const options = [
        { did: "", label: "自动（第一个在线音箱）", enabled: true },
        ...speakers.map((s) => ({
          did: s.did,
          label: `${s.name}（${s.room_name}）${s.online ? "" : " · 离线"}`,
          enabled: s.online,
        })),
      ];

      for (const opt of options) {
        const btn = document.createElement("button");
        btn.type = "button";
        const checked = opt.did === pref;
        btn.className = `popup-menu-item${checked ? " checked" : ""}`;
        btn.disabled = !opt.enabled;
        btn.setAttribute("role", "menuitem");
        const span = document.createElement("span");
        span.textContent = opt.label;
        btn.appendChild(span);
        if (checked) {
          const chk = document.createElement("span");
          chk.className = "menu-check";
          chk.textContent = "✓";
          btn.appendChild(chk);
        }
        btn.addEventListener("click", () => void this.selectTraySpeaker(opt.did));
        menu.appendChild(btn);
      }

      menu.hidden = false;
      el("tray-speaker-btn").setAttribute("aria-expanded", "true");
    });

    // Audio playback controls
    el("tray-audio-prev").addEventListener("click", () => void this.triggerSpeakerStep("previous"));
    el("tray-audio-play").addEventListener("click", () => void this.toggleSpeakerMute());
    el("tray-audio-next").addEventListener("click", () => void this.triggerSpeakerStep("next"));

    const volSlider = el<HTMLInputElement>("tray-volume-slider");
    volSlider.addEventListener("pointerdown", () => {
      this.audioSliderDown = true;
    });
    volSlider.addEventListener("input", () => {
      const val = Math.trunc(Number(volSlider.value));
      this.updateTrayVolumeVisual(val, String(val));
    });
    volSlider.addEventListener("change", () => {
      this.audioSliderDown = false;
      const val = Math.trunc(Number(volSlider.value));
      void this.commitSpeakerVolume(val);
    });
    volSlider.addEventListener("pointerup", () => {
      this.audioSliderDown = false;
    });

    // Bottom tray voice input
    const voiceInput = el<HTMLInputElement>("tray-voice-input");
    const submitTrayVoice = () => {
      const text = voiceInput.value.trim();
      if (!text) return;
      voiceInput.value = "";
      void this.submitVoiceCommand(text, this.state.audio.did ?? undefined);
    };
    voiceInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submitTrayVoice();
      } else if (e.key === "Escape") {
        voiceInput.value = "";
      }
    });
    el("tray-voice-send-btn").addEventListener("click", submitTrayVoice);

    // Floating tray drag movement by headers
    const win = el("tray-quick-window");
    let dragStart: { mx: number; my: number; x: number; y: number } | null = null;
    const startDrag = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest("button")) return;
      const rect = win.getBoundingClientRect();
      dragStart = { mx: e.clientX, my: e.clientY, x: rect.left, y: rect.top };
    };
    el("tray-audio-drag-header").addEventListener("mousedown", startDrag);
    el("tray-drag-header").addEventListener("mousedown", startDrag);
    window.addEventListener("mousemove", (e) => {
      if (!dragStart) return;
      const rect = win.getBoundingClientRect();
      const nx = Math.max(8, Math.min(window.innerWidth - rect.width - 8, dragStart.x + (e.clientX - dragStart.mx)));
      const ny = Math.max(52, Math.min(window.innerHeight - rect.height - 46, dragStart.y + (e.clientY - dragStart.my)));
      this.trayDraggedPos = { x: nx, y: ny };
      win.style.left = `${nx}px`;
      win.style.top = `${ny}px`;
      win.style.right = "auto";
      win.style.bottom = "auto";
    });
    window.addEventListener("mouseup", () => {
      dragStart = null;
    });
  }

  private bindModalEvents(): void {
    const backdrop = el("modal-backdrop");
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop && this.activeModal !== "tray-intro") {
        this.closeModal();
      }
    });

    document.querySelectorAll<HTMLButtonElement>("[data-close-modal]").forEach((btn) => {
      btn.addEventListener("click", () => this.closeModal());
    });

    el("light-diag-btn").addEventListener("click", () => {
      const dev = this.modalLightSession.currentDevice();
      this.openDiagnosticsModal(dev?.did);
    });

    el("tray-intro-dismiss-btn").addEventListener("click", async () => {
      this.state.trayIntroSeen = true;
      this.state.settings.tray_intro_seen = true;
      this.closeModal();
      try {
        await apiPost("/api/tray/intro/dismiss");
      } catch {
        // ignore dismiss error
      }
    });
  }

  private bindSettingsEvents(): void {
    document.querySelectorAll<HTMLButtonElement>("[data-settings-tab]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const raw = btn.dataset.settingsTab;
        const tab: "appearance" | "features" | "voice-agent" =
          raw === "features" ? "features" : raw === "voice-agent" ? "voice-agent" : "appearance";
        this.switchSettingsTab(tab);
      });
    });

    el<HTMLSelectElement>("set-agent-provider").addEventListener("change", () => {
      this.syncAgentProviderFormHints(true);
    });

    el<HTMLSelectElement>("set-agent-api-type").addEventListener("change", () => {
      void this.fetchAgentModelsFromApi(false);
    });

    el<HTMLSelectElement>("set-agent-model-select").addEventListener("change", (e) => {
      const val = (e.target as HTMLSelectElement).value.trim();
      if (val) {
        el<HTMLInputElement>("set-agent-model").value = val;
      }
    });

    el<HTMLInputElement>("set-agent-model").addEventListener("input", (e) => {
      const val = (e.target as HTMLInputElement).value.trim();
      const sel = el<HTMLSelectElement>("set-agent-model-select");
      if ([...sel.options].some((o) => o.value === val)) {
        sel.value = val;
      }
    });

    el("set-agent-refresh-models-btn").addEventListener("click", () => {
      void this.fetchAgentModelsFromApi(true);
    });

    el<HTMLInputElement>("set-agent-base-url").addEventListener("input", () => {
      this.scheduleFetchAgentModels();
    });
    el<HTMLInputElement>("set-agent-base-url").addEventListener("change", () => {
      void this.fetchAgentModelsFromApi(false);
    });

    el<HTMLInputElement>("set-agent-api-key").addEventListener("input", () => {
      this.scheduleFetchAgentModels();
    });
    el<HTMLInputElement>("set-agent-api-key").addEventListener("change", () => {
      void this.fetchAgentModelsFromApi(false);
    });

    el<HTMLSelectElement>("set-agent-caveman-mode").addEventListener("change", () => {
      this.syncCavemanDesc();
    });

    el<HTMLInputElement>("set-voice-wake-enabled").addEventListener("change", (e) => {
      const enabled = (e.target as HTMLInputElement).checked;
      el("setting-row-wake-words").classList.toggle("is-disabled", !enabled);
    });

    el<HTMLInputElement>("set-voice-wake-words").addEventListener("input", () => {
      const first = this.parseConfiguredWakeWords()[0] ?? "";
      const target = el<HTMLInputElement>("oww-target-word");
      if (first && (!target.value.trim() || target.value.trim() === this.lastAutoFilledWakeWord)) {
        target.value = first;
        this.lastAutoFilledWakeWord = first;
      }
    });

    el<HTMLSelectElement>("set-systemone-mode").addEventListener("change", () => {
      this.syncSystemOneStatusDesc();
    });

    el("oww-record-sample-btn").addEventListener("click", () => {
      void this.handleRecordOwwSample();
    });

    el("oww-test-sample-btn").addEventListener("click", () => {
      void this.handleTestOwwSample();
    });

    el("oww-bootstrap-btn").addEventListener("click", () => {
      void this.handleBootstrapOww();
    });

    el("voice-download-models-btn").addEventListener("click", () => {
      void this.downloadMissingVoiceModels();
    });

    const readDraftTtsOptions = () => {
      const eng = el<HTMLSelectElement>("set-voice-tts-engine").value;
      const voice = el<HTMLSelectElement>("set-voice-tts-voice").value;
      const speedRaw = Number(el<HTMLInputElement>("set-voice-tts-speed").value);
      return {
        ttsEngine: (eng === "local" || eng === "browser" ? eng : "auto") as
          | "auto"
          | "local"
          | "browser",
        ttsVoice: (voice === "warm-zh-baker" ? "warm-zh-baker" : "gentle-zh-en") as
          | "gentle-zh-en"
          | "warm-zh-baker",
        ttsSpeed: Number.isFinite(speedRaw) ? Math.min(1.4, Math.max(0.7, speedRaw)) : 0.98,
      };
    };

    el("set-voice-wake-ack-preview-btn").addEventListener("click", () => {
      const phrase = el<HTMLInputElement>("set-voice-wake-ack-phrase").value.trim();
      if (!phrase) {
        this.showToast("当前回复短语为空：触发唤醒词将静默进入持续监听，不播报语音", 2800);
        return;
      }
      this.piAgentPanel.previewVoice(phrase, readDraftTtsOptions());
    });

    el("set-voice-tts-preview-btn").addEventListener("click", () => {
      const phrase = el<HTMLInputElement>("set-voice-wake-ack-phrase").value.trim();
      const sample = phrase
        ? `${phrase} 客厅吸顶灯已开，亮度调至80%。`
        : "嗯？客厅吸顶灯已开，亮度调至80%。";
      this.piAgentPanel.previewVoice(sample, readDraftTtsOptions());
    });

    el("vp-record-enroll-btn").addEventListener("click", () => {
      void this.handleRecordEnrollVoiceprint();
    });

    el("vp-record-verify-btn").addEventListener("click", () => {
      void this.handleRecordVerifyVoiceprint();
    });

    el("set-agent-clear-key-btn").addEventListener("click", () => {
      this.agentClearKeyPending = true;
      const input = el<HTMLInputElement>("set-agent-api-key");
      input.value = "";
      input.placeholder = "将在保存设置后清除已保存的 API Key";
      el("set-agent-clear-key-btn").hidden = true;
    });

    el("set-stt-clear-key-btn").addEventListener("click", () => {
      this.sttClearKeyPending = true;
      const input = el<HTMLInputElement>("set-stt-api-key");
      input.value = "";
      input.placeholder = "将在保存设置后清除已保存的 STT Key";
      el("set-stt-clear-key-btn").hidden = true;
    });

    el<HTMLSelectElement>("set-theme-mode").addEventListener("change", (e) => {
      const mode = (e.target as HTMLSelectElement).value as ThemeMode;
      this.settingsDraft.mode = mode;
      void this.previewTheme({ mode, color: this.settingsDraft.color });
    });

    document.querySelectorAll<HTMLButtonElement>(".color-preset-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const color = btn.dataset.color ?? "green";
        this.settingsDraft.color = color;
        this.syncSettingsColorUi();
        void this.previewTheme({ mode: this.settingsDraft.mode, color });
      });
    });

    const hexInput = el<HTMLInputElement>("set-custom-hex");
    const colorPicker = el<HTMLInputElement>("set-custom-picker");

    el("set-custom-swatch").addEventListener("click", () => {
      colorPicker.value = this.settingsDraft.customColor;
      colorPicker.click();
    });

    colorPicker.addEventListener("input", () => {
      const picked = colorPicker.value.toLowerCase();
      hexInput.value = picked;
      this.settingsDraft.customColor = picked;
      this.settingsDraft.color = picked;
      this.syncSettingsColorUi();
      void this.previewTheme({ mode: this.settingsDraft.mode, color: picked });
    });

    hexInput.addEventListener("input", () => {
      const norm = normalizeThemeColor(hexInput.value);
      if (norm && norm.startsWith("#")) {
        this.settingsDraft.customColor = norm;
        this.settingsDraft.color = norm;
        void this.previewTheme({ mode: this.settingsDraft.mode, color: norm });
      }
      this.syncSettingsColorUi();
    });

    const scaleInput = el<HTMLInputElement>("set-ui-scale");
    scaleInput.addEventListener("blur", () => {
      const parsed = parseScaleText(scaleInput.value);
      if (parsed !== null) {
        this.settingsDraft.uiScale = parsed;
      }
      scaleInput.value = formatScalePercent(this.settingsDraft.uiScale);
    });

    el<HTMLInputElement>("set-minimize-to-tray").addEventListener("change", (e) => {
      const enabled = (e.target as HTMLInputElement).checked;
      el<HTMLInputElement>("set-start-minimized").disabled = !enabled;
      el("setting-row-start-min").classList.toggle("is-disabled", !enabled);
    });

    el("settings-cancel-btn").addEventListener("click", () => this.closeModal());
    el("settings-save-btn").addEventListener("click", () => void this.saveSettings());
  }

  private bindCameraEvents(): void {
    el("camera-power-btn").addEventListener("click", () => void this.toggleCameraPower());
    el("camera-detail-btn").addEventListener("click", () => {
      if (this.cameraDevice) {
        this.openDeviceDetailModal(this.cameraDevice);
      }
    });
    el("camera-diag-btn").addEventListener("click", () => {
      this.openDiagnosticsModal(this.cameraDevice?.did);
    });
    el("camera-mute-btn").addEventListener("click", () => {
      if (!this.cameraDevice || !this.cameraDevice.online || this.cameraPowerState === false) return;
      this.cameraMuted = !this.cameraMuted;
      this.syncCameraControlsUi();
    });
    el("camera-fullscreen-btn").addEventListener("click", () => this.toggleCameraFullscreen());

    el("camera-quality-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      const menu = el("camera-quality-menu");
      const open = menu.hidden;
      this.closeAllMenus();
      if (open) {
        menu.hidden = false;
        el("camera-quality-btn").setAttribute("aria-expanded", "true");
      }
    });

    el("camera-quality-menu").addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement | null)?.closest<HTMLButtonElement>("[data-quality]");
      if (!btn) return;
      const q = Number(btn.dataset.quality);
      if (q === 0 || q === 1 || q === 2) {
        this.cameraQuality = q;
        this.updateCameraQualityMenuLabels(this.cameraDevice?.model === PTZ_MODEL);
        this.syncCameraControlsUi();
        this.drawCameraCanvasFrame();
      }
      this.closeAllMenus();
    });

    // PTZ Drag Gesture on Camera Canvas (12px threshold + 400ms debounce + 1500ms cooldown)
    const stage = el("camera-stage");
    const handleStep = (clientX: number, clientY: number) => {
      if (!this.cameraPress || this.cameraGestureSent) return;
      const now = performance.now();
      if (now < this.cameraDragBusyUntil) return;
      if (now - this.cameraLastDragMs < 400) return;

      const dx = clientX - this.cameraPress.x;
      const dy = clientY - this.cameraPress.y;
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 12) return;

      const direction = Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 2 : 1) : dy > 0 ? 4 : 3;
      this.cameraGestureSent = true;
      this.cameraLastDragMs = now;
      void this.sendCameraPtz(direction);
    };

    stage.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      if ((e.target as HTMLElement | null)?.closest(".camera-overlay-bar")) return;
      if (performance.now() < this.cameraDragBusyUntil) return;
      this.cameraPress = { x: e.clientX, y: e.clientY };
      this.cameraGestureSent = false;
      stage.classList.add("ptz-dragging");
      stage.classList.remove("ptz-ready");
    });

    window.addEventListener("mousemove", (e) => {
      if (!this.cameraPress) return;
      if ((e.buttons & 1) === 0) return;
      handleStep(e.clientX, e.clientY);
    });

    window.addEventListener("mouseup", (e) => {
      if (!this.cameraPress) return;
      handleStep(e.clientX, e.clientY);
      this.cameraPress = null;
      stage.classList.remove("ptz-dragging");
      this.syncCameraControlsUi();
    });
  }

  private bindTrayManagerEvents(): void {
    document.querySelectorAll<HTMLButtonElement>("[data-tm-tab]").forEach((btn) => {
      btn.addEventListener("click", () => {
        this.trayMgrTab = btn.dataset.tmTab === "scenes" ? "scenes" : "devices";
        this.renderTrayManager();
      });
    });

    el("tray-mgr-sort-btn").addEventListener("click", () => {
      this.trayMgrView = this.trayMgrView === "list" ? "sort" : "list";
      this.renderTrayManager();
    });

    el<HTMLSelectElement>("tray-mgr-room-filter").addEventListener("change", (e) => {
      this.trayMgrRoom = (e.target as HTMLSelectElement).value;
      this.renderTrayManager();
    });

    el("tray-mgr-cancel-btn").addEventListener("click", () => this.closeModal());
    el("tray-mgr-save-btn").addEventListener("click", () => void this.saveTrayManager());
  }

  private bindLoginEvents(): void {
    el("login-retry-btn").addEventListener("click", () => void this.beginQrLogin());
  }

  private bindDiagnosticsEvents(): void {
    el<HTMLSelectElement>("diag-device-select").addEventListener("change", () => {
      this.diagGeneration += 1;
      el<HTMLTextAreaElement>("diag-preview").value = "";
      const copyBtn = el<HTMLButtonElement>("diag-copy-btn");
      copyBtn.disabled = true;
      copyBtn.textContent = "复制诊断报告";
      el("diag-status").textContent = "点击“重新生成”获取所选设备的报告。";
      el<HTMLButtonElement>("diag-regen-btn").disabled = this.diagDevices.length === 0;
    });

    el("diag-regen-btn").addEventListener("click", () => void this.generateDiagnosticsReport());
    el("diag-copy-btn").addEventListener("click", () => void this.copyDiagnosticsReport());
  }

  private bindAboutEvents(): void {
    el("about-check-update-btn").addEventListener("click", () => void this.checkUpdate(true));
  }

  private openAboutModal(): void {
    const ver = this.state.apiVersion
      ? `版本 v${this.state.version} | mijiaAPI ${this.state.apiVersion}`
      : `版本 v${this.state.version}`;
    el("about-version").textContent = ver;
    this.openModal("about");
  }
}

// ---------------------------------------------------------------------------
// Data Normalizers
// ---------------------------------------------------------------------------

function normalizeDeviceInfo(raw: unknown): DeviceInfo | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const did = readStr(rec, "did");
  if (!did) return null;
  return {
    did,
    name: readStr(rec, "name") ?? did,
    model: readStr(rec, "model") ?? "",
    home_name: readStr(rec, "home_name", "homeName") ?? "",
    room_name: readStr(rec, "room_name", "roomName") ?? "",
    online: readBool(rec, "online") ?? false,
    spec_type: readStr(rec, "spec_type", "specType") ?? "",
    switch_channels: Array.isArray(rec.switch_channels ?? rec.switchChannels)
      ? ((rec.switch_channels ?? rec.switchChannels) as unknown[]).map((c) => String(c))
      : [],
    light_features: Array.isArray(rec.light_features ?? rec.lightFeatures)
      ? ((rec.light_features ?? rec.lightFeatures) as unknown[]).map((f) => String(f))
      : [],
    metric_features: Array.isArray(rec.metric_features ?? rec.metricFeatures)
      ? ((rec.metric_features ?? rec.metricFeatures) as unknown[]).map((f) => String(f))
      : null,
    firmware: readStr(rec, "firmware") ?? "",
  };
}

function normalizeSceneInfo(raw: unknown): SceneInfo | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const sceneId = readStr(rec, "scene_id", "sceneId", "id");
  if (!sceneId) return null;
  return {
    scene_id: sceneId,
    name: readStr(rec, "name") ?? sceneId,
    home_id: readStr(rec, "home_id", "homeId") ?? "",
    home_name: readStr(rec, "home_name", "homeName") ?? "",
  };
}

function normalizeTrayOrder(list: unknown[]): TrayOrderItem[] {
  const result: TrayOrderItem[] = [];
  for (const item of list) {
    const rec = asRecord(item);
    if (!rec) continue;
    const type = readStr(rec, "type", "kind");
    const id = readStr(rec, "id");
    if ((type === "device" || type === "scene") && id) {
      result.push({ type, id });
    }
  }
  return result;
}

function normalizeReleaseInfo(raw: unknown): ReleaseInfo | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const tag = readStr(rec, "tag", "tag_name", "version");
  if (!tag) return null;
  return {
    tag,
    url: readStr(rec, "url", "html_url") ?? "https://github.com/Songmanual/MijiaDeck/releases/latest",
    name: readStr(rec, "name"),
    body: readStr(rec, "body"),
  };
}

// ---------------------------------------------------------------------------
// Auto-Bootstrap in Browser
// ---------------------------------------------------------------------------

export function bootMijiaDeckWeb(): MijiaDeckWebApp {
  const app = new MijiaDeckWebApp();
  void app.init();
  return app;
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      bootMijiaDeckWeb();
    });
  } else {
    bootMijiaDeckWeb();
  }
}
