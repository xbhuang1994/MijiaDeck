// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * 完整设备详情模态窗（支持全品类米家设备的状态查看、参数调节、动作执行、分路开关控制与规格检查）。
 */

import {
  FEED_WEEKDAYS,
  actionRequiresConfirmation,
  choosePropertyWidget,
  classifyDeviceProps,
  deviceCategoryLabel,
  encodeFeedPlan,
  formatFeedDaysLabel,
  formatFeedTime,
  formatPropertyValue,
  friendlyLabel,
  friendlyPropLabel,
  groupPropsByService,
  isIrRemoteDevice,
  isPetFeederDevice,
  nextAvailableFeedPlanId,
  parseFeedPlans,
  percentageProgressFor,
  resolveEnumLabel,
  skippedPlanIdsForDate,
  type ClassifiedDeviceProps,
  type DeviceChannelState,
  type FeedPlanItem,
  type LightPropKind,
} from "../core/deviceDetailModel.ts";
import type { ActionInfo, ActionParamInfo, DeviceInfo, PropInfo } from "../core/models.ts";
import { isSensitivePropertyName, unitLabelZh } from "../core/specZh.ts";

export interface DeviceDetailApiResponse {
  ok: boolean;
  did: string;
  device: DeviceInfo;
  category: string;
  online: boolean;
  supportsPower: boolean;
  powerState: boolean | null;
  powerProp: PropInfo | null;
  isSplitParent: boolean;
  channels: DeviceChannelState[];
  lightControls: Partial<Record<LightPropKind, PropInfo>>;
  props: PropInfo[];
  actions: ActionInfo[];
  values: Record<string, unknown>;
  specError: string | null;
  readWarning: string | null;
  inTray: boolean;
  trayEligible: boolean;
  metrics: string | null;
  fetchedAt: number;
}

export interface DeviceDetailModalHost {
  apiGet<T>(url: string): Promise<T>;
  apiPost<T>(url: string, body?: unknown): Promise<T>;
  deviceIconSvg(model: string): string;
  getIconUrl(device: DeviceInfo): string | null;
  getDeviceByDid(did: string): DeviceInfo | undefined;
  isCamera(device: DeviceInfo): boolean;
  isSpeaker(device: DeviceInfo): boolean;
  deviceTitle(device: DeviceInfo): string;
  showToast(message: string, durationMs?: number): void;
  onPowerSynced(did: string, state: boolean): void;
  onTrayMembershipToggle(did: string, nextSelected: boolean): Promise<void>;
  openDiagnostics(did: string): void;
  openCameraPreview(device: DeviceInfo): void;
  openOtherDevice(device: DeviceInfo): void;
  closeSelf(): void;
}

type DetailTab = "overview" | "properties" | "info";

const LIGHT_TEMP_PRESETS: ReadonlyArray<{ label: string; kelvin: number }> = [
  { label: "暖光 2700K", kelvin: 2700 },
  { label: "舒适 3500K", kelvin: 3500 },
  { label: "自然 4500K", kelvin: 4500 },
  { label: "明亮 6000K", kelvin: 6000 },
];

const LIGHT_COLOR_PRESETS: ReadonlyArray<{ label: string; hex: string }> = [
  { label: "纯白", hex: "#ffffff" },
  { label: "暖琥珀", hex: "#ffb86c" },
  { label: "珊瑚粉", hex: "#ff7997" },
  { label: "天空蓝", hex: "#60a5fa" },
  { label: "翡翠绿", hex: "#34d399" },
  { label: "薰衣草", hex: "#a78bfa" },
];

const POWER_SVG = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"></path><line x1="12" y1="2" x2="12" y2="12"></line></svg>`;

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) {
    throw new Error(`Missing device detail DOM element: #${id}`);
  }
  return node as T;
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

function formatTimeShort(ts: number): string {
  return new Date(ts).toLocaleTimeString("zh-CN", { hour12: false });
}

function defaultActionParamValue(param: ActionParamInfo): unknown {
  if (param.type === "bool") {
    return false;
  }
  if (param.value_list && param.value_list.length > 0) {
    return param.value_list[0]!.value;
  }
  if (param.type === "int" || param.type === "uint" || param.type === "float") {
    if (param.range && param.range.length >= 2) {
      return param.range[0];
    }
    return 1;
  }
  return "";
}

function semanticToneForTelemetry(
  prop: PropInfo,
  rawValue: unknown,
  formatted: string,
  allValues?: Record<string, unknown>,
): "normal" | "good" | "warn" | "danger" {
  const name = prop.name.toLowerCase();
  if (name === "fault" || name.endsWith("-fault")) {
    if (typeof rawValue === "number" && rawValue !== 0) {
      return "danger";
    }
    if (rawValue === 0) {
      return "good";
    }
  }
  if (name === "air-quality") {
    if (rawValue === 0 || formatted.includes("优")) return "good";
    if (rawValue === 1 || formatted.includes("良")) return "normal";
    if (typeof rawValue === "number" && rawValue >= 3) return "danger";
    return "warn";
  }
  if (name === "pet-food-left-level") {
    if (formatted.includes("缺") || rawValue === 2) return "warn";
    if (formatted.includes("正常") || rawValue === 1) return "good";
  }
  if (name.includes("battery") || name.includes("life-level") || name.includes("left-level")) {
    if (name.includes("battery") && rawValue === 0 && allValues?.["status"] === 0) {
      return "normal";
    }
    if (typeof rawValue === "number" && rawValue <= 15) return "danger";
    if (typeof rawValue === "number" && rawValue <= 30) return "warn";
  }
  return "normal";
}

interface FeederPlanEditorState {
  mode: "add" | "edit";
  id: number;
  enabled: boolean;
  hour: number;
  minute: number;
  daysMask: number;
  portions: number;
}

export class DeviceDetailModalController {
  private device: DeviceInfo | null = null;
  private data: DeviceDetailApiResponse | null = null;
  private activeTab: DetailTab = "overview";
  private generation = 0;
  private revision = 0;
  private loading = false;
  private refreshing = false;
  private busyPower = false;
  private busyProps = new Set<string>();
  private busyActions = new Set<string>();
  private busyChannels = new Set<string>();
  private draggingProps = new Set<string>();
  private pendingConfirmAction: { name: string; timer: number } | null = null;
  private pollTimer: number | null = null;

  // Preserve user input drafts across poll refreshes
  private actionDrafts = new Map<string, Record<string, unknown>>();
  private speakerVoiceText = "";
  private speakerVoiceMode: "directive" | "tts" = "directive";
  private feederPortions = 2;
  private feederEditor: FeederPlanEditorState | null = null;
  private pendingDeletePlan: { id: number; timer: number } | null = null;
  private propsSearchQuery = "";
  private showAdvancedProps = false;
  private parentBackDevice: DeviceInfo | null = null;

  constructor(private readonly host: DeviceDetailModalHost) {
    this.bindStaticEvents();
  }

  currentDevice(): DeviceInfo | null {
    return this.device;
  }

  open(device: DeviceInfo, options?: { fromParent?: DeviceInfo | null }): void {
    this.close();
    this.device = device;
    this.parentBackDevice = options?.fromParent ?? null;
    this.activeTab = "overview";
    this.propsSearchQuery = "";
    this.showAdvancedProps = false;
    this.actionDrafts.clear();
    this.speakerVoiceText = "";
    this.feederPortions = 2;
    this.feederEditor = null;
    this.clearPendingDeletePlan();
    this.generation += 1;
    const gen = this.generation;

    el<HTMLInputElement>("dd-props-search").value = "";
    el<HTMLInputElement>("dd-props-show-params").checked = false;

    this.loading = true;
    this.renderHeaderShell(device);
    this.syncTabButtons();
    el("dd-loading").hidden = false;
    el("dd-loading-text").textContent = device.online
      ? "正在读取设备完整状态与能力…"
      : "正在加载离线设备信息与规格…";
    el("dd-panel-overview").hidden = true;
    el("dd-panel-properties").hidden = true;
    el("dd-panel-info").hidden = true;
    el("dd-banner").hidden = true;
    el("dd-sync-label").textContent = "加载中…";

    void this.fetchDetail(device.did, gen, true);
  }

  close(): void {
    this.generation += 1;
    this.device = null;
    this.data = null;
    this.loading = false;
    this.refreshing = false;
    this.busyPower = false;
    this.busyProps.clear();
    this.busyActions.clear();
    this.busyChannels.clear();
    this.draggingProps.clear();
    this.feederEditor = null;
    this.clearPendingConfirm();
    this.clearPendingDeletePlan();
    this.stopPolling();
  }

  syncExternalTrayMembership(inTray: boolean): void {
    if (!this.data) return;
    this.data.inTray = inTray;
    this.renderFooter();
  }

  private bindStaticEvents(): void {
    document.querySelectorAll<HTMLButtonElement>("[data-dd-tab]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const tab = btn.dataset.ddTab as DetailTab | undefined;
        if (tab === "overview" || tab === "properties" || tab === "info") {
          this.switchTab(tab);
        }
      });
    });

    el("dd-refresh-btn").addEventListener("click", () => {
      if (!this.device || this.refreshing) return;
      void this.fetchDetail(this.device.did, this.generation, false, true);
    });

    el("dd-power-btn").addEventListener("click", () => {
      void this.togglePrimaryPower();
    });

    el("dd-camera-btn").addEventListener("click", () => {
      if (!this.device) return;
      const dev = this.device;
      this.host.openCameraPreview(dev);
    });

    el("dd-diag-btn").addEventListener("click", () => {
      if (!this.device) return;
      this.host.openDiagnostics(this.device.did);
    });

    el("dd-tray-btn").addEventListener("click", async () => {
      if (!this.data) return;
      const next = !this.data.inTray;
      const btn = el<HTMLButtonElement>("dd-tray-btn");
      btn.disabled = true;
      try {
        await this.host.onTrayMembershipToggle(this.data.did, next);
        if (this.data) {
          this.data.inTray = next;
          this.renderFooter();
        }
      } finally {
        btn.disabled = false;
      }
    });

    el<HTMLInputElement>("dd-props-search").addEventListener("input", (e) => {
      this.propsSearchQuery = (e.target as HTMLInputElement).value.trim().toLowerCase();
      this.renderPropertiesTab();
    });

    el<HTMLInputElement>("dd-props-show-params").addEventListener("change", (e) => {
      this.showAdvancedProps = (e.target as HTMLInputElement).checked;
      this.renderPropertiesTab();
    });
  }

  private clearPendingConfirm(): void {
    if (this.pendingConfirmAction) {
      window.clearTimeout(this.pendingConfirmAction.timer);
      this.pendingConfirmAction = null;
    }
  }

  private clearPendingDeletePlan(): void {
    if (this.pendingDeletePlan) {
      window.clearTimeout(this.pendingDeletePlan.timer);
      this.pendingDeletePlan = null;
    }
  }

  private startPolling(): void {
    this.stopPolling();
    if (!this.device?.online) return;
    this.pollTimer = window.setInterval(() => {
      if (!this.device || !this.device.online) return;
      if (this.loading || this.refreshing || this.busyPower) return;
      if (this.busyProps.size > 0 || this.busyActions.size > 0 || this.draggingProps.size > 0) return;
      if (this.feederEditor !== null) return;
      if (this.isUserTypingInModal()) return;
      void this.fetchDetail(this.device.did, this.generation, false, false);
    }, 3500);
  }

  private stopPolling(): void {
    if (this.pollTimer !== null) {
      window.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private isUserTypingInModal(): boolean {
    const active = document.activeElement as HTMLElement | null;
    if (!active) return false;
    if (!active.closest("#modal-device-detail")) return false;
    return (
      active.tagName === "INPUT" ||
      active.tagName === "TEXTAREA" ||
      active.tagName === "SELECT"
    );
  }

  private async fetchDetail(
    did: string,
    gen: number,
    initial: boolean,
    manual = false,
  ): Promise<void> {
    const revAtStart = this.revision;
    if (!initial) {
      this.refreshing = true;
      this.syncRefreshButton();
    }
    try {
      const res = await this.host.apiGet<DeviceDetailApiResponse>(
        `/api/devices/${encodeURIComponent(did)}/detail`,
      );
      if (gen !== this.generation || !this.device) return;
      // Do not overwrite optimistic local state with a stale background poll response
      if (!initial && !manual && revAtStart !== this.revision) {
        return;
      }
      this.data = res;
      this.device = res.device;
      this.loading = false;
      this.renderAll();
      if (initial) {
        this.startPolling();
      } else if (manual) {
        this.host.showToast("已刷新设备状态", 1800);
      }
    } catch (err) {
      if (gen !== this.generation || !this.device) return;
      this.loading = false;
      el("dd-loading").hidden = true;
      const msg = err instanceof Error ? err.message : String(err);
      if (!this.data) {
        this.showBanner(`无法加载设备详情：${msg}`, "warn");
        el("dd-panel-overview").hidden = false;
        el("dd-panel-overview").innerHTML = `<div class="dd-empty-card"><p>暂时无法获取该设备的控制详情，请点击右上角刷新重试。</p></div>`;
      } else if (manual) {
        this.host.showToast(`刷新失败：${msg}`, 3000);
      }
      el("dd-sync-label").textContent = "状态读取受限";
    } finally {
      if (gen === this.generation) {
        this.refreshing = false;
        this.syncRefreshButton();
      }
    }
  }

  private switchTab(tab: DetailTab): void {
    this.activeTab = tab;
    this.syncTabButtons();
    if (this.loading) return;
    el("dd-panel-overview").hidden = tab !== "overview";
    el("dd-panel-properties").hidden = tab !== "properties";
    el("dd-panel-info").hidden = tab !== "info";
    if (tab === "properties") {
      this.renderPropertiesTab();
    } else if (tab === "info") {
      this.renderInfoTab();
    }
  }

  private syncTabButtons(): void {
    document.querySelectorAll<HTMLButtonElement>("[data-dd-tab]").forEach((btn) => {
      const active = btn.dataset.ddTab === this.activeTab;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-selected", String(active));
    });
  }

  private syncRefreshButton(): void {
    const btn = el<HTMLButtonElement>("dd-refresh-btn");
    const busy = this.loading || this.refreshing;
    btn.disabled = busy;
    btn.classList.toggle("spinning", busy);
  }

  private showBanner(text: string, kind: "warn" | "info"): void {
    const banner = el("dd-banner");
    banner.hidden = false;
    banner.className = `dd-banner is-${kind}`;
    el("dd-banner-text").textContent = text;
  }

  private renderHeaderShell(device: DeviceInfo): void {
    const iconBox = el("dd-icon-box");
    iconBox.replaceChildren();
    const iconUrl = this.host.getIconUrl(device);
    if (iconUrl) {
      const img = document.createElement("img");
      img.src = iconUrl;
      img.alt = "";
      img.addEventListener("error", () => {
        iconBox.innerHTML = this.host.deviceIconSvg(device.model);
      });
      iconBox.appendChild(img);
    } else {
      iconBox.innerHTML = this.host.deviceIconSvg(device.model);
    }

    el("dd-title").textContent = this.host.deviceTitle(device);
    const pill = el("dd-status-pill");
    pill.textContent = device.online ? "在线" : "离线";
    pill.className = `dd-status-pill ${device.online ? "is-online" : "is-offline"}`;

    el("dd-category-badge").textContent = this.data?.category || deviceCategoryLabel(device);

    const locParts = [device.home_name, device.room_name].filter(Boolean);
    if (device.model) {
      locParts.push(device.model);
    }
    el("dd-subtitle").textContent = locParts.join(" · ");

    el("dd-camera-btn").hidden = !this.host.isCamera(device);
    el<HTMLButtonElement>("dd-camera-btn").disabled = !device.online;

    const powerBtn = el<HTMLButtonElement>("dd-power-btn");
    if (this.data && this.data.supportsPower && this.data.powerProp) {
      powerBtn.hidden = false;
      const st = this.data.powerState;
      powerBtn.disabled = !device.online || this.busyPower;
      powerBtn.className = "power-btn";
      if (!device.online) {
        powerBtn.classList.add("is-offline");
      } else if (this.busyPower) {
        powerBtn.classList.add("is-busy");
      } else if (st === true) {
        powerBtn.classList.add("is-on");
      } else if (st === false) {
        powerBtn.classList.add("is-off");
      } else {
        powerBtn.classList.add("is-unknown");
      }
      powerBtn.innerHTML = POWER_SVG;
      powerBtn.title = st === true ? "关闭设备" : st === false ? "开启设备" : "切换开关";
      powerBtn.setAttribute("aria-label", powerBtn.title);
    } else {
      powerBtn.hidden = true;
    }

    this.syncRefreshButton();
  }

  private renderAll(): void {
    const data = this.data;
    if (!data) return;

    this.renderHeaderShell(data.device);
    el("dd-loading").hidden = true;
    el("dd-props-count").textContent = String(
      data.props.filter((p) => p.readable || p.writable).length,
    );

    // Banner
    if (!data.online) {
      this.showBanner("设备当前离线，仅展示基本信息与功能规格，恢复在线后可读取实时状态并控制。", "warn");
    } else if (data.specError) {
      this.showBanner(data.specError, "info");
    } else if (data.readWarning) {
      this.showBanner(`部分实时状态读取受限：${data.readWarning}`, "warn");
    } else {
      el("dd-banner").hidden = true;
    }

    this.renderOverviewTab();
    if (this.activeTab === "properties") {
      this.renderPropertiesTab();
    } else if (this.activeTab === "info") {
      this.renderInfoTab();
    }
    this.renderFooter();

    el("dd-panel-overview").hidden = this.activeTab !== "overview";
    el("dd-panel-properties").hidden = this.activeTab !== "properties";
    el("dd-panel-info").hidden = this.activeTab !== "info";
  }

  private renderFooter(): void {
    const data = this.data;
    if (!data) return;

    const syncLabel = el("dd-sync-label");
    if (this.busyPower || this.busyProps.size > 0 || this.busyActions.size > 0) {
      syncLabel.textContent = "正在下发指令…";
    } else if (!data.online) {
      syncLabel.textContent = "离线只读模式";
    } else {
      syncLabel.textContent = `最近同步 ${formatTimeShort(data.fetchedAt)} · 自动刷新`;
    }

    const trayBtn = el<HTMLButtonElement>("dd-tray-btn");
    if (data.trayEligible) {
      trayBtn.hidden = false;
      trayBtn.textContent = data.inTray ? "移出快捷托盘" : "加入快捷托盘";
    } else {
      trayBtn.hidden = true;
    }
  }

  // -------------------------------------------------------------------------
  // Tab 1: Overview (Hero + Telemetry + Writable Controls + Actions)
  // -------------------------------------------------------------------------

  private renderOverviewTab(): void {
    const data = this.data;
    const container = el("dd-panel-overview");
    container.replaceChildren();
    if (!data) return;

    const classified = classifyDeviceProps(data.device, data.props);
    let renderedAnything = false;

    // Back to parent panel link if navigated from split switch panel
    if (this.parentBackDevice) {
      const parentDev = this.parentBackDevice;
      const bar = document.createElement("div");
      bar.className = "dd-breadcrumb";
      const backBtn = document.createElement("button");
      backBtn.type = "button";
      backBtn.className = "dd-back-link";
      backBtn.textContent = `← 返回「${this.host.deviceTitle(parentDev)}」面板`;
      backBtn.addEventListener("click", () => {
        this.open(parentDev);
      });
      bar.appendChild(backBtn);
      container.appendChild(bar);
    }

    const heroConsumedActions = new Set<string>();
    const heroConsumedProps = new Set<string>();

    // 1. Split Switch Panel Hero
    if (data.isSplitParent && data.channels.length > 0) {
      container.appendChild(this.buildSwitchPanelHero(data));
      renderedAnything = true;
    }

    // 2. Adjustable Light Hero
    if (Object.keys(classified.heroLight).length > 0) {
      container.appendChild(this.buildLightHero(data, classified));
      renderedAnything = true;
    }

    // 3. Pet Feeder Dispensing & Schedule Workbench Hero
    if (isPetFeederDevice(data.device, data.props, data.actions)) {
      const feederSections = this.buildPetFeederSections(
        data,
        heroConsumedProps,
        heroConsumedActions,
      );
      for (const sec of feederSections) {
        container.appendChild(sec);
        renderedAnything = true;
      }
    }

    // 4. Speaker Media & Voice Hero
    if (this.host.isSpeaker(data.device)) {
      const hero = this.buildSpeakerHero(data, heroConsumedActions);
      if (hero) {
        container.appendChild(hero);
        renderedAnything = true;
      }
    }

    // 4b. Infrared Remote Control Panel Hero (Tuya IR amplifier / TV / AC / DIY remotes)
    const irActions = data.actions.filter((a) => a.service === "ir-remote");
    if (irActions.length > 0) {
      container.appendChild(this.buildIrRemoteHero(data, irActions, heroConsumedActions));
      renderedAnything = true;
    }

    const hasAnyReportedValue = Object.values(data.values).some(
      (v) => v !== null && v !== undefined,
    );

    // 5. Live Telemetry / Read-Only Status Grid
    const rawTelemetry = classified.telemetry.filter((p) => !heroConsumedProps.has(p.name));
    const reportedTelemetry =
      data.online && !data.readWarning && hasAnyReportedValue
        ? rawTelemetry.filter(
            (p) => data.values[p.name] !== null && data.values[p.name] !== undefined,
          )
        : rawTelemetry;
    const remainingTelemetry = reportedTelemetry.length > 0 ? reportedTelemetry : rawTelemetry;
    if (remainingTelemetry.length > 0) {
      container.appendChild(this.buildTelemetrySection(data, remainingTelemetry));
      renderedAnything = true;
    }

    // 6. Writable Controls Grouped by Service
    const remainingControls = classified.controls.filter((p) => !heroConsumedProps.has(p.name));
    if (remainingControls.length > 0) {
      container.appendChild(
        this.buildControlsSection(data, remainingControls, hasAnyReportedValue),
      );
      renderedAnything = true;
    }

    // 7. Executable Actions (excluding actions already rendered inside Hero workbenches)
    const remainingActions = data.actions.filter((a) => !heroConsumedActions.has(a.name));
    if (remainingActions.length > 0) {
      container.appendChild(this.buildActionsSection(data, remainingActions));
      renderedAnything = true;
    }

    // 7. Empty / Basic-only fallback (e.g. BLE-only device, IR hub gateway, or simple switch)
    if (!renderedAnything) {
      const isIrHub =
        (data.device.spec_type ?? "").includes(":device:ir-hub:") ||
        data.device.model.toLowerCase().includes(".wnykq.");
      const empty = document.createElement("div");
      empty.className = "dd-empty-card";
      const title = document.createElement("h3");
      title.className = "dd-empty-title";
      title.textContent = isIrHub
        ? "万能红外遥控网关"
        : data.powerProp
          ? "基础开关设备"
          : data.specError
            ? "暂无公开控制能力"
            : "暂无更多可展示属性";
      const desc = document.createElement("p");
      desc.className = "dd-empty-desc";
      desc.textContent = isIrHub
        ? "该设备为涂鸦红外发射主机，已绑定的红外遥控子设备（如音响、空调、电视等）会以独立卡片展示在设备列表中，请点击对应子设备卡片进入遥控面板。"
        : data.powerProp
          ? "可使用右上角开关按钮直接控制电源，或切换至「设备信息」查看硬件详情。"
          : "可切换至「设备信息」查看设备型号、固件与规格标识，或生成诊断报告排查能力支持情况。";
      empty.append(title, desc);
      container.appendChild(empty);
    }
  }

  private buildSwitchPanelHero(data: DeviceDetailApiResponse): HTMLElement {
    const section = this.createSection("面板分路控制", `${data.channels.length} 路独立开关`);
    const grid = document.createElement("div");
    grid.className = "dd-channel-grid";

    for (const ch of data.channels) {
      const card = document.createElement("div");
      card.className = `dd-channel-card${ch.online ? "" : " is-offline"}`;

      const info = document.createElement("div");
      info.className = "dd-channel-info";
      const name = document.createElement("div");
      name.className = "dd-channel-name";
      name.textContent = ch.name;
      const sub = document.createElement("div");
      sub.className = "dd-channel-sub";
      sub.textContent = !ch.online
        ? "离线"
        : ch.power === true
          ? "已开启"
          : ch.power === false
            ? "已关闭"
            : "状态待确认";
      info.append(name, sub);

      const right = document.createElement("div");
      right.className = "dd-channel-actions";

      const detailBtn = document.createElement("button");
      detailBtn.type = "button";
      detailBtn.className = "dd-link-btn";
      detailBtn.textContent = "详情";
      detailBtn.addEventListener("click", () => {
        const target = this.host.getDeviceByDid(ch.did);
        if (target) {
          this.open(target, { fromParent: data.device });
        }
      });

      const pwrBtn = document.createElement("button");
      pwrBtn.type = "button";
      const busy = this.busyChannels.has(ch.did);
      pwrBtn.className = `power-btn power-btn-sm ${
        !ch.online
          ? "is-offline"
          : busy
            ? "is-busy"
            : ch.power === true
              ? "is-on"
              : ch.power === false
                ? "is-off"
                : "is-unknown"
      }`;
      pwrBtn.disabled = !ch.online || busy;
      pwrBtn.innerHTML = POWER_SVG;
      pwrBtn.setAttribute("aria-label", `切换 ${ch.name}`);
      pwrBtn.addEventListener("click", () => {
        void this.toggleChannelPower(ch);
      });

      right.append(detailBtn, pwrBtn);
      card.append(info, right);
      grid.appendChild(card);
    }

    section.appendChild(grid);
    return section;
  }

  private buildLightHero(
    data: DeviceDetailApiResponse,
    classified: ClassifiedDeviceProps,
  ): HTMLElement {
    const poweredOn = data.online && (!classified.powerProp || data.powerState === true);
    const section = this.createSection(
      "灯光快捷调节",
      !data.online ? "设备离线" : poweredOn ? "实时可调" : "请先开启灯光后调节亮度与色温",
    );
    const panel = document.createElement("div");
    panel.className = "dd-light-hero";

    const brightProp = classified.heroLight.brightness;
    if (brightProp && brightProp.range && brightProp.range.length >= 2) {
      const [low, high, stepRaw] = brightProp.range;
      const step = stepRaw && stepRaw > 0 ? stepRaw : 1;
      const curVal =
        typeof data.values[brightProp.name] === "number"
          ? (data.values[brightProp.name] as number)
          : low;
      const pct = Math.round((curVal / high) * 100);

      const group = document.createElement("div");
      group.className = "dd-slider-group";
      const head = document.createElement("div");
      head.className = "dd-slider-head";
      const label = document.createElement("span");
      label.textContent = "亮度";
      const valEl = document.createElement("span");
      valEl.className = "dd-slider-val";
      valEl.textContent = typeof data.values[brightProp.name] === "number" ? `${pct}%` : "—";
      head.append(label, valEl);

      const slider = document.createElement("input");
      slider.type = "range";
      slider.className = "md-slider";
      slider.min = String(low);
      slider.max = String(high);
      slider.step = String(step);
      slider.value = String(curVal);
      slider.disabled = !poweredOn || this.busyProps.has(brightProp.name);
      slider.setAttribute("aria-label", "灯光亮度");

      slider.addEventListener("pointerdown", () => {
        this.draggingProps.add(brightProp.name);
        this.revision += 1;
      });
      slider.addEventListener("input", () => {
        const v = Number(slider.value);
        valEl.textContent = `${Math.round((v / high) * 100)}%`;
      });
      const release = () => this.draggingProps.delete(brightProp.name);
      slider.addEventListener("pointerup", release);
      slider.addEventListener("pointercancel", release);
      slider.addEventListener("change", () => {
        release();
        const v = brightProp.type === "float" ? Number(slider.value) : Math.round(Number(slider.value));
        void this.writeProp(brightProp.name, v);
      });

      group.append(head, slider);
      panel.appendChild(group);
    }

    const tempProp = classified.heroLight.temperature;
    if (tempProp && tempProp.range && tempProp.range.length >= 2) {
      const [low, high, stepRaw] = tempProp.range;
      const step = stepRaw && stepRaw > 0 ? stepRaw : 1;
      const curVal =
        typeof data.values[tempProp.name] === "number"
          ? (data.values[tempProp.name] as number)
          : Math.round((low + high) / 2);

      const group = document.createElement("div");
      group.className = "dd-slider-group";
      const head = document.createElement("div");
      head.className = "dd-slider-head";
      const label = document.createElement("span");
      label.textContent = "色温";
      const valEl = document.createElement("span");
      valEl.className = "dd-slider-val";
      valEl.textContent = typeof data.values[tempProp.name] === "number" ? `${Math.round(curVal)} K` : "—";
      head.append(label, valEl);

      const slider = document.createElement("input");
      slider.type = "range";
      slider.className = "md-slider md-slider-temp";
      slider.min = String(low);
      slider.max = String(high);
      slider.step = String(step);
      slider.value = String(curVal);
      slider.disabled = !poweredOn || this.busyProps.has(tempProp.name);
      slider.setAttribute("aria-label", "灯光色温");

      slider.addEventListener("pointerdown", () => {
        this.draggingProps.add(tempProp.name);
        this.revision += 1;
      });
      slider.addEventListener("input", () => {
        valEl.textContent = `${Math.round(Number(slider.value))} K`;
      });
      const release = () => this.draggingProps.delete(tempProp.name);
      slider.addEventListener("pointerup", release);
      slider.addEventListener("pointercancel", release);
      slider.addEventListener("change", () => {
        release();
        const v = tempProp.type === "float" ? Number(slider.value) : Math.round(Number(slider.value));
        void this.writeProp(tempProp.name, v);
      });

      group.append(head, slider);

      const validPresets = LIGHT_TEMP_PRESETS.filter((p) => p.kelvin >= low && p.kelvin <= high);
      if (validPresets.length > 0) {
        const presetRow = document.createElement("div");
        presetRow.className = "dd-preset-row";
        for (const preset of validPresets) {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = `dd-preset-chip${Math.abs(curVal - preset.kelvin) <= 150 ? " active" : ""}`;
          btn.textContent = preset.label;
          btn.disabled = !poweredOn || this.busyProps.has(tempProp.name);
          btn.addEventListener("click", () => {
            void this.writeProp(tempProp.name, preset.kelvin);
          });
          presetRow.appendChild(btn);
        }
        group.appendChild(presetRow);
      }
      panel.appendChild(group);
    }

    const colorProp = classified.heroLight.color;
    if (colorProp) {
      const rawColor = data.values[colorProp.name];
      const currentHex =
        typeof rawColor === "number" && Number.isFinite(rawColor) ? rgbIntToHex(rawColor) : "#ffffff";

      const colorWrap = document.createElement("div");
      colorWrap.className = "dd-light-color-wrap";

      const swatches = document.createElement("div");
      swatches.className = "dd-color-swatches";
      for (const preset of LIGHT_COLOR_PRESETS) {
        const sw = document.createElement("button");
        sw.type = "button";
        sw.className = `dd-color-swatch${currentHex.toLowerCase() === preset.hex ? " active" : ""}`;
        sw.style.background = preset.hex;
        sw.title = preset.label;
        sw.setAttribute("aria-label", `设置颜色为${preset.label}`);
        sw.disabled = !poweredOn || this.busyProps.has(colorProp.name);
        sw.addEventListener("click", () => {
          void this.writeProp(colorProp.name, hexToRgbInt(preset.hex));
        });
        swatches.appendChild(sw);
      }

      const pickerBtn = document.createElement("button");
      pickerBtn.type = "button";
      pickerBtn.className = "dd-color-custom-btn";
      pickerBtn.disabled = !poweredOn || this.busyProps.has(colorProp.name);
      const dot = document.createElement("span");
      dot.className = "light-color-dot";
      dot.style.background = currentHex;
      const lbl = document.createElement("span");
      lbl.textContent = `自定义颜色 ${currentHex.toUpperCase()}`;
      pickerBtn.append(dot, lbl);

      const picker = document.createElement("input");
      picker.type = "color";
      picker.className = "sr-color-input";
      picker.value = currentHex;
      pickerBtn.addEventListener("click", () => picker.click());
      picker.addEventListener("change", () => {
        void this.writeProp(colorProp.name, hexToRgbInt(picker.value));
      });

      colorWrap.append(swatches, pickerBtn, picker);
      panel.appendChild(colorWrap);
    }

    section.appendChild(panel);
    return section;
  }

  private buildSpeakerHero(
    data: DeviceDetailApiResponse,
    consumedActions: Set<string>,
  ): HTMLElement | null {
    const actionMap = new Map(data.actions.map((a) => [a.name, a]));
    const transportOrder: ReadonlyArray<{ name: string; label: string; icon: string }> = [
      { name: "previous", label: "上一首", icon: "⏮" },
      { name: "play", label: "播放", icon: "▶" },
      { name: "pause", label: "暂停", icon: "⏸" },
      { name: "stop", label: "停止", icon: "⏹" },
      { name: "next", label: "下一首", icon: "⏭" },
    ];
    const presentTransport = transportOrder.filter((t) => actionMap.has(t.name));
    const hasDirective = actionMap.has("execute-text-directive");
    const hasTts = actionMap.has("play-text");
    if (presentTransport.length === 0 && !hasDirective && !hasTts) {
      return null;
    }

    const playStateProp = data.props.find((p) => p.name === "playing-state");
    const playStateText = playStateProp
      ? formatPropertyValue(playStateProp, data.values[playStateProp.name])
      : "";

    const section = this.createSection(
      "音箱播放与小爱交互",
      playStateText && playStateText !== "—" ? `当前状态：${playStateText}` : undefined,
    );
    const card = document.createElement("div");
    card.className = "dd-speaker-hero";

    if (presentTransport.length > 0) {
      const bar = document.createElement("div");
      bar.className = "dd-transport-bar";
      for (const item of presentTransport) {
        consumedActions.add(item.name);
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = `dd-transport-btn${item.name === "play" || item.name === "pause" ? " is-primary" : ""}`;
        btn.disabled = !data.online || this.busyActions.has(item.name);
        btn.innerHTML = `<span class="dd-transport-ico">${item.icon}</span><span>${item.label}</span>`;
        btn.addEventListener("click", () => {
          void this.runAction(item.name);
        });
        bar.appendChild(btn);
      }
      card.appendChild(bar);
    }

    if (hasDirective || hasTts) {
      if (hasDirective) consumedActions.add("execute-text-directive");
      if (hasTts) consumedActions.add("play-text");
      if (!hasDirective && hasTts) {
        this.speakerVoiceMode = "tts";
      } else if (hasDirective && !hasTts) {
        this.speakerVoiceMode = "directive";
      }

      const voiceRow = document.createElement("div");
      voiceRow.className = "dd-speaker-voice-row";

      if (hasDirective && hasTts) {
        const modeSeg = document.createElement("div");
        modeSeg.className = "dd-mini-seg";
        const dirBtn = document.createElement("button");
        dirBtn.type = "button";
        dirBtn.className = `dd-mini-seg-btn${this.speakerVoiceMode === "directive" ? " active" : ""}`;
        dirBtn.textContent = "下发指令";
        const ttsBtn = document.createElement("button");
        ttsBtn.type = "button";
        ttsBtn.className = `dd-mini-seg-btn${this.speakerVoiceMode === "tts" ? " active" : ""}`;
        ttsBtn.textContent = "朗读文本";
        dirBtn.addEventListener("click", () => {
          this.speakerVoiceMode = "directive";
          this.renderOverviewTab();
        });
        ttsBtn.addEventListener("click", () => {
          this.speakerVoiceMode = "tts";
          this.renderOverviewTab();
        });
        modeSeg.append(dirBtn, ttsBtn);
        voiceRow.appendChild(modeSeg);
      }

      const input = document.createElement("input");
      input.type = "text";
      input.className = "dd-text-input";
      input.value = this.speakerVoiceText;
      input.disabled = !data.online;
      input.placeholder =
        this.speakerVoiceMode === "tts"
          ? "输入要让小爱播报的文字，例如：饭做好了"
          : "输入小爱指令，例如：明天天气怎么样 / 打开客厅灯";
      input.addEventListener("input", () => {
        this.speakerVoiceText = input.value;
      });

      const sendBtn = document.createElement("button");
      sendBtn.type = "button";
      sendBtn.className = "primary-button btn-compact";
      const actName = this.speakerVoiceMode === "tts" ? "play-text" : "execute-text-directive";
      sendBtn.disabled = !data.online || this.busyActions.has(actName);
      sendBtn.textContent = this.speakerVoiceMode === "tts" ? "播报" : "发送";

      const submit = () => {
        const text = input.value.trim();
        if (!text) return;
        this.speakerVoiceText = "";
        input.value = "";
        void this.runAction(actName, [text]);
      };
      sendBtn.addEventListener("click", submit);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          submit();
        }
      });

      voiceRow.append(input, sendBtn);
      card.appendChild(voiceRow);
    }

    section.appendChild(card);
    return section;
  }

  private irKeyIconSvg(code: string): string {
    const k = code.trim().toLowerCase();
    if (k === "poweron" || k === "power_on" || k === "poweroff" || k === "power_off" || k === "power" || k === "poweronoff") {
      return `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"></path><line x1="12" y1="2" x2="12" y2="12"></line></svg>`;
    }
    if (k === "volume+" || k === "vol+" || k === "volumeup" || k === "volume_up") {
      return `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><line x1="19" y1="9" x2="19" y2="15"></line><line x1="16" y1="12" x2="22" y2="12"></line></svg>`;
    }
    if (k === "volume-" || k === "vol-" || k === "volumedown" || k === "volume_down") {
      return `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><line x1="16" y1="12" x2="22" y2="12"></line></svg>`;
    }
    if (k === "mute") {
      return `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><line x1="23" y1="9" x2="17" y2="15"></line><line x1="17" y1="9" x2="23" y2="15"></line></svg>`;
    }
    if (k === "play") {
      return `<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><polygon points="6 4 20 12 6 20 6 4"></polygon></svg>`;
    }
    if (k === "pause") {
      return `<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><rect x="6" y="4" width="4" height="16" rx="1"></rect><rect x="14" y="4" width="4" height="16" rx="1"></rect></svg>`;
    }
    if (k === "playpause" || k === "play/pause" || k === "play_pause") {
      return `<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><polygon points="4 5 13 12 4 19 4 5"></polygon><rect x="15" y="5" width="2.5" height="14" rx="0.8"></rect><rect x="19" y="5" width="2.5" height="14" rx="0.8"></rect></svg>`;
    }
    if (k === "stop") {
      return `<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2"></rect></svg>`;
    }
    if (k === "previous" || k === "prev" || k === "previoustrack" || k === "previous_track") {
      return `<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><rect x="4" y="5" width="2.5" height="14" rx="0.8"></rect><polygon points="20 5 9 12 20 19 20 5"></polygon></svg>`;
    }
    if (k === "next" || k === "nexttrack" || k === "next_track") {
      return `<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><polygon points="4 5 15 12 4 19 4 5"></polygon><rect x="17.5" y="5" width="2.5" height="14" rx="0.8"></rect></svg>`;
    }
    if (k === "up") {
      return `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="18 15 12 9 6 15"></polyline></svg>`;
    }
    if (k === "down") {
      return `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"></polyline></svg>`;
    }
    if (k === "left") {
      return `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"></polyline></svg>`;
    }
    if (k === "right") {
      return `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"></polyline></svg>`;
    }
    return "";
  }

  private buildIrRemoteHero(
    data: DeviceDetailApiResponse,
    irActions: ActionInfo[],
    consumedActions: Set<string>,
  ): HTMLElement {
    for (const a of irActions) {
      consumedActions.add(a.name);
    }

    const hasWritableParams = data.props.some((p) => p.writable && p.name !== "on");
    const section = this.createSection(
      "红外遥控面板",
      !data.online
        ? "设备离线"
        : hasWritableParams
          ? `共 ${irActions.length} 个红外按键 · 支持下方参数精细调节`
          : `共 ${irActions.length} 个红外按键 · 点击即刻发射红外信号`,
    );

    const panel = document.createElement("div");
    panel.className = "dd-ir-panel";

    const byLower = new Map<string, ActionInfo>();
    for (const a of irActions) {
      byLower.set(a.name.trim().toLowerCase(), a);
    }
    const used = new Set<string>();

    const take = (...keys: string[]): ActionInfo | null => {
      for (const key of keys) {
        const found = byLower.get(key);
        if (found && !used.has(found.name)) {
          used.add(found.name);
          return found;
        }
      }
      return null;
    };

    const makeKeyBtn = (
      action: ActionInfo,
      extraClass = "",
      compactIconOnly = false,
    ): HTMLButtonElement => {
      const label = friendlyLabel(action.desc, action.name);
      const busy = this.busyActions.has(action.name);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `dd-ir-key${extraClass ? ` ${extraClass}` : ""}${busy ? " is-busy" : ""}`;
      btn.dataset.irKey = action.name;
      btn.disabled = !data.online || busy;
      btn.title = `${label} (${action.name})`;
      btn.setAttribute("aria-label", label);

      const iconSvg = this.irKeyIconSvg(action.name);
      if (iconSvg) {
        const ico = document.createElement("span");
        ico.className = "dd-ir-key-ico";
        ico.innerHTML = iconSvg;
        btn.appendChild(ico);
      }
      if (!compactIconOnly || !iconSvg) {
        const txt = document.createElement("span");
        txt.className = "dd-ir-key-label";
        txt.textContent = busy ? "发送中…" : label;
        btn.appendChild(txt);
      }

      btn.addEventListener("click", () => {
        void this.runAction(action.name, undefined, `已发送「${label}」红外指令`);
      });
      return btn;
    };

    // 1. 电源区（PowerOn / PowerOff / Power）
    const pwrOn = take("poweron", "power_on");
    const pwrOff = take("poweroff", "power_off");
    const pwrToggle = take("power", "poweronoff", "standby");
    if (pwrOn || pwrOff || pwrToggle) {
      const group = document.createElement("div");
      group.className = "dd-ir-group";
      const row = document.createElement("div");
      row.className = "dd-ir-row is-power";
      if (pwrOn) row.appendChild(makeKeyBtn(pwrOn, "is-power-on"));
      if (pwrOff) row.appendChild(makeKeyBtn(pwrOff, "is-power-off"));
      if (pwrToggle) row.appendChild(makeKeyBtn(pwrToggle, "is-power-toggle"));
      group.appendChild(row);
      panel.appendChild(group);
    }

    // 2. 音量与静音区（Volume- / Mute / Volume+）
    const volDown = take("volume-", "vol-", "volumedown", "volume_down");
    const mute = take("mute");
    const volUp = take("volume+", "vol+", "volumeup", "volume_up");
    if (volDown || mute || volUp) {
      const group = document.createElement("div");
      group.className = "dd-ir-group";
      const lbl = document.createElement("div");
      lbl.className = "dd-ir-group-label";
      lbl.textContent = "音量控制";
      const row = document.createElement("div");
      row.className = "dd-ir-row is-volume";
      if (volDown) row.appendChild(makeKeyBtn(volDown, "is-rocker"));
      if (mute) row.appendChild(makeKeyBtn(mute, "is-mute"));
      if (volUp) row.appendChild(makeKeyBtn(volUp, "is-rocker"));
      group.append(lbl, row);
      panel.appendChild(group);
    }

    // 3. 播放控制区（上一首 / 快退 / 播放 / 暂停 / 停止 / 快进 / 下一首）
    const mediaKeys = [
      take("previous", "prev", "previoustrack", "previous_track"),
      take("rewind", "rew"),
      take("play"),
      take("pause"),
      take("playpause", "play/pause", "play_pause"),
      take("stop"),
      take("fastforward", "ff"),
      take("next", "nexttrack", "next_track"),
    ].filter((a): a is ActionInfo => a !== null);

    if (mediaKeys.length > 0) {
      const group = document.createElement("div");
      group.className = "dd-ir-group";
      const lbl = document.createElement("div");
      lbl.className = "dd-ir-group-label";
      lbl.textContent = "播放控制";
      const row = document.createElement("div");
      row.className = "dd-ir-row is-media";
      for (const act of mediaKeys) {
        const lower = act.name.trim().toLowerCase();
        const isPrimary = lower === "play" || lower === "pause" || lower === "playpause" || lower === "play/pause";
        row.appendChild(makeKeyBtn(act, isPrimary ? "is-accent-soft" : ""));
      }
      group.append(lbl, row);
      panel.appendChild(group);
    }

    // 4. 方向键与菜单区（D-Pad + Menu/Home/Back/Exit）
    const navUp = take("up");
    const navDown = take("down");
    const navLeft = take("left");
    const navRight = take("right");
    const navOk = take("ok", "enter", "select");
    const navAux = [take("menu"), take("home"), take("back", "return"), take("exit")].filter(
      (a): a is ActionInfo => a !== null,
    );

    if (navUp || navDown || navLeft || navRight || navOk || navAux.length > 0) {
      const group = document.createElement("div");
      group.className = "dd-ir-group";
      const lbl = document.createElement("div");
      lbl.className = "dd-ir-group-label";
      lbl.textContent = "方向与导航";
      group.appendChild(lbl);

      if (navUp || navDown || navLeft || navRight || navOk) {
        const dpad = document.createElement("div");
        dpad.className = "dd-ir-dpad";
        const cell = (act: ActionInfo | null, cls = ""): HTMLElement => {
          if (!act) {
            const sp = document.createElement("div");
            sp.className = "dd-ir-dpad-empty";
            return sp;
          }
          return makeKeyBtn(act, `is-dpad ${cls}`.trim());
        };
        dpad.append(
          cell(null),
          cell(navUp),
          cell(null),
          cell(navLeft),
          cell(navOk, "is-accent-soft"),
          cell(navRight),
          cell(null),
          cell(navDown),
          cell(null),
        );
        group.appendChild(dpad);
      }

      if (navAux.length > 0) {
        const auxRow = document.createElement("div");
        auxRow.className = "dd-ir-row";
        for (const act of navAux) {
          auxRow.appendChild(makeKeyBtn(act));
        }
        group.appendChild(auxRow);
      }
      panel.appendChild(group);
    }

    // 5. 其余功能按键（频道、信号源、DIY 自定义按键等）与数字键区
    const remaining = irActions.filter((a) => !used.has(a.name));
    const digitActions = remaining.filter((a) => /^[0-9]$/.test(a.name.trim()) || a.name.trim() === "-/--");
    const otherActions = remaining.filter((a) => !digitActions.includes(a));

    if (otherActions.length > 0) {
      const group = document.createElement("div");
      group.className = "dd-ir-group";
      const lbl = document.createElement("div");
      lbl.className = "dd-ir-group-label";
      lbl.textContent = "功能按键";
      const grid = document.createElement("div");
      grid.className = "dd-ir-key-grid";
      for (const act of otherActions) {
        grid.appendChild(makeKeyBtn(act));
      }
      group.append(lbl, grid);
      panel.appendChild(group);
    }

    if (digitActions.length > 0) {
      const group = document.createElement("div");
      group.className = "dd-ir-group";
      const lbl = document.createElement("div");
      lbl.className = "dd-ir-group-label";
      lbl.textContent = "数字按键";
      const pad = document.createElement("div");
      pad.className = "dd-ir-numpad";
      for (const act of digitActions) {
        pad.appendChild(makeKeyBtn(act, "is-numpad"));
      }
      group.append(lbl, pad);
      panel.appendChild(group);
    }

    section.appendChild(panel);
    return section;
  }

  private buildPetFeederSections(
    data: DeviceDetailApiResponse,
    consumedProps: Set<string>,
    consumedActions: Set<string>,
  ): HTMLElement[] {
    const sections: HTMLElement[] = [];
    const dispenseAction = data.actions.find(
      (a) => a.name === "pet-food-out" || a.name.startsWith("pet-food-out-"),
    );
    const measureProp = data.props.find(
      (p) => p.name === "feeding-measure" || p.name.startsWith("feeding-measure-"),
    );
    const range = dispenseAction?.in?.[0]?.range ?? measureProp?.range ?? [1, 60, 1];
    const minPortions = Math.max(1, Math.round(range[0] ?? 1));
    const maxPortions = Math.max(minPortions, Math.round(range[1] ?? 60));
    const step = range.length >= 3 && range[2] && range[2] > 0 ? Math.round(range[2]) : 1;

    this.feederPortions = Math.max(minPortions, Math.min(maxPortions, Math.round(this.feederPortions)));

    // Section A: Immediate remote dispensing with portion stepper & quick chips
    if (dispenseAction) {
      consumedActions.add(dispenseAction.name);
      if (measureProp?.writable) {
        consumedProps.add(measureProp.name);
      }

      const foodLevelProp = data.props.find((p) => p.name === "pet-food-left-level");
      const modeProp = data.props.find((p) => p.name === "mode");
      const hintParts: string[] = [];
      if (!data.online) {
        hintParts.push("设备离线");
      } else {
        if (foodLevelProp && data.values[foodLevelProp.name] !== undefined) {
          hintParts.push(`余粮${formatPropertyValue(foodLevelProp, data.values[foodLevelProp.name])}`);
        }
        if (modeProp && data.values[modeProp.name] !== undefined) {
          hintParts.push(formatPropertyValue(modeProp, data.values[modeProp.name]));
        }
        if (hintParts.length === 0) {
          hintParts.push(`可调 ${minPortions}–${maxPortions} 份`);
        }
      }

      const sec = this.createSection("远程出粮", hintParts.join(" · "));
      const card = document.createElement("div");
      card.className = "dd-feeder-card";

      const mainRow = document.createElement("div");
      mainRow.className = "dd-feeder-dispense-row";

      const left = document.createElement("div");
      left.className = "dd-feeder-portion-block";
      const lbl = document.createElement("div");
      lbl.className = "dd-feeder-portion-label";
      lbl.textContent = `出粮份数（${minPortions}–${maxPortions} 份）`;

      const busy = this.busyActions.has(dispenseAction.name);
      const disabled = !data.online || busy || data.isSplitParent;

      const stepper = document.createElement("div");
      stepper.className = "dd-stepper";

      const decBtn = document.createElement("button");
      decBtn.type = "button";
      decBtn.className = "dd-stepper-btn";
      decBtn.textContent = "−";
      decBtn.setAttribute("aria-label", "减少出粮份数");
      decBtn.disabled = disabled || this.feederPortions <= minPortions;

      const numInput = document.createElement("input");
      numInput.type = "number";
      numInput.className = "dd-stepper-input";
      numInput.min = String(minPortions);
      numInput.max = String(maxPortions);
      numInput.step = String(step);
      numInput.value = String(this.feederPortions);
      numInput.disabled = disabled;
      numInput.setAttribute("aria-label", "出粮份数");

      const unitSpan = document.createElement("span");
      unitSpan.className = "dd-stepper-unit";
      unitSpan.textContent = "份";

      const incBtn = document.createElement("button");
      incBtn.type = "button";
      incBtn.className = "dd-stepper-btn";
      incBtn.textContent = "+";
      incBtn.setAttribute("aria-label", "增加出粮份数");
      incBtn.disabled = disabled || this.feederPortions >= maxPortions;

      const syncStepper = (next: number) => {
        const clamped = Math.max(minPortions, Math.min(maxPortions, Math.round(next)));
        this.feederPortions = clamped;
        numInput.value = String(clamped);
        decBtn.disabled = disabled || clamped <= minPortions;
        incBtn.disabled = disabled || clamped >= maxPortions;
        card.querySelectorAll<HTMLButtonElement>("[data-portion-chip]").forEach((chip) => {
          chip.classList.toggle("active", Number(chip.dataset.portionChip) === clamped);
        });
      };

      decBtn.addEventListener("click", () => syncStepper(this.feederPortions - step));
      incBtn.addEventListener("click", () => syncStepper(this.feederPortions + step));
      numInput.addEventListener("input", () => {
        const parsed = Number(numInput.value);
        if (Number.isFinite(parsed) && parsed >= minPortions && parsed <= maxPortions) {
          this.feederPortions = Math.round(parsed);
          decBtn.disabled = disabled || this.feederPortions <= minPortions;
          incBtn.disabled = disabled || this.feederPortions >= maxPortions;
          card.querySelectorAll<HTMLButtonElement>("[data-portion-chip]").forEach((chip) => {
            chip.classList.toggle("active", Number(chip.dataset.portionChip) === this.feederPortions);
          });
        }
      });
      numInput.addEventListener("blur", () => {
        const parsed = Number(numInput.value);
        syncStepper(Number.isFinite(parsed) ? parsed : this.feederPortions);
      });

      stepper.append(decBtn, numInput, unitSpan, incBtn);
      left.append(lbl, stepper);

      const feedBtn = document.createElement("button");
      feedBtn.type = "button";
      feedBtn.className = "primary-button dd-feeder-dispense-btn";
      feedBtn.disabled = disabled;
      feedBtn.textContent = busy ? "出粮中…" : "立即出粮";
      feedBtn.addEventListener("click", () => {
        const parsed = Number(numInput.value);
        const portions = Number.isFinite(parsed)
          ? Math.max(minPortions, Math.min(maxPortions, Math.round(parsed)))
          : this.feederPortions;
        this.feederPortions = portions;
        void this.dispensePetFood(dispenseAction, measureProp, portions);
      });

      mainRow.append(left, feedBtn);
      card.appendChild(mainRow);

      // Quick portion preset chips
      const chipCandidates = [1, 2, 3, 5, 7, 10, 15, 20].filter(
        (n) => n >= minPortions && n <= maxPortions,
      );
      const chips = chipCandidates.slice(0, 6);
      if (chips.length > 0) {
        const chipRow = document.createElement("div");
        chipRow.className = "dd-preset-row";
        for (const count of chips) {
          const chip = document.createElement("button");
          chip.type = "button";
          chip.className = `dd-preset-chip${this.feederPortions === count ? " active" : ""}`;
          chip.dataset.portionChip = String(count);
          chip.textContent = `${count} 份`;
          chip.disabled = disabled;
          chip.addEventListener("click", () => syncStepper(count));
          chipRow.appendChild(chip);
        }
        card.appendChild(chipRow);
      }

      sec.appendChild(card);
      sections.push(sec);
    }

    // Section B: Visual Feeding Schedule Manager (madv-spec:service:feed-plan)
    const feedPlanProp = data.props.find((p) => p.name === "feed-plan");
    const skippedPlanProp = data.props.find((p) => p.name === "skiped-plan");
    const planCtrlProp = data.props.find((p) => p.name === "plan-ctrl");
    const updateAction = data.actions.find((a) => a.name === "update");
    const delAction = data.actions.find((a) => a.name === "del");
    const skipAction = data.actions.find((a) => a.name === "skip");
    const reopenAction = data.actions.find((a) => a.name === "re-open");

    if (feedPlanProp || planCtrlProp || updateAction) {
      if (feedPlanProp) consumedProps.add(feedPlanProp.name);
      if (skippedPlanProp) consumedProps.add(skippedPlanProp.name);
      if (planCtrlProp) consumedProps.add(planCtrlProp.name);
      if (updateAction) consumedActions.add(updateAction.name);
      if (delAction) consumedActions.add(delAction.name);
      if (skipAction) consumedActions.add(skipAction.name);
      if (reopenAction) consumedActions.add(reopenAction.name);

      const plans = parseFeedPlans(feedPlanProp ? data.values[feedPlanProp.name] : "");
      const skippedToday = skippedPlanIdsForDate(
        skippedPlanProp ? data.values[skippedPlanProp.name] : "",
      );
      const planMasterOn = planCtrlProp ? Boolean(data.values[planCtrlProp.name]) : true;
      const enabledDailyPortions = plans
        .filter((p) => p.enabled && !skippedToday.has(p.id))
        .reduce((sum, p) => sum + p.portions, 0);

      const sec = document.createElement("section");
      sec.className = "dd-section";

      const head = document.createElement("div");
      head.className = "dd-section-head dd-feeder-plan-head";
      const titleGroup = document.createElement("div");
      titleGroup.className = "dd-feeder-plan-title-group";
      const h3 = document.createElement("h3");
      h3.className = "dd-section-title";
      h3.textContent = "定时喂食计划";
      const sub = document.createElement("span");
      sub.className = "dd-section-hint";
      sub.textContent =
        plans.length > 0
          ? `${plans.length} 条计划 · 今日预计 ${planMasterOn ? enabledDailyPortions : 0} 份`
          : "暂无定时计划";
      titleGroup.append(h3, sub);

      const headActions = document.createElement("div");
      headActions.className = "dd-feeder-plan-head-actions";

      if (planCtrlProp) {
        const masterWrap = document.createElement("label");
        masterWrap.className = "dd-feeder-master-toggle";
        const masterTxt = document.createElement("span");
        masterTxt.textContent = "总开关";
        const sw = document.createElement("label");
        sw.className = "md-switch";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = planMasterOn;
        cb.disabled = !data.online || this.busyProps.has(planCtrlProp.name) || data.isSplitParent;
        cb.setAttribute("aria-label", "定时喂食计划总开关");
        cb.addEventListener("change", () => {
          void this.writeProp(planCtrlProp.name, cb.checked);
        });
        const tr = document.createElement("span");
        tr.className = "md-switch-track";
        sw.append(cb, tr);
        masterWrap.append(masterTxt, sw);
        headActions.appendChild(masterWrap);
      }

      if (updateAction) {
        const addBtn = document.createElement("button");
        addBtn.type = "button";
        addBtn.className = "secondary-button btn-compact dd-feeder-add-btn";
        addBtn.textContent = "+ 添加计划";
        addBtn.disabled = !data.online || this.busyActions.has(updateAction.name) || data.isSplitParent;
        addBtn.addEventListener("click", () => {
          this.clearPendingDeletePlan();
          this.feederEditor = {
            mode: "add",
            id: nextAvailableFeedPlanId(plans),
            enabled: true,
            hour: 12,
            minute: 0,
            daysMask: 0x7f,
            portions: Math.max(minPortions, Math.min(maxPortions, this.feederPortions)),
          };
          this.renderOverviewTab();
        });
        headActions.appendChild(addBtn);
      }

      head.append(titleGroup, headActions);
      sec.appendChild(head);

      // Inline add/edit form
      if (this.feederEditor && updateAction) {
        sec.appendChild(
          this.buildFeederPlanEditor(
            data,
            this.feederEditor,
            updateAction.name,
            minPortions,
            maxPortions,
          ),
        );
      }

      if (!planMasterOn && plans.length > 0) {
        const pausedHint = document.createElement("div");
        pausedHint.className = "dd-feeder-paused-note";
        pausedHint.textContent = "计划总开关当前已关闭，开启后将按以下定时计划自动投喂。";
        sec.appendChild(pausedHint);
      }

      // Decoded plan items list
      const planList = document.createElement("div");
      planList.className = `dd-feeder-plan-list${planMasterOn ? "" : " is-master-off"}`;

      if (plans.length === 0) {
        const empty = document.createElement("div");
        empty.className = "dd-feeder-empty";
        empty.textContent = updateAction
          ? "尚未配置定时喂食计划，点击右上角「+ 添加计划」即可添加每日或自定义周期投喂。"
          : "当前设备暂无已启用的定时喂食计划。";
        planList.appendChild(empty);
      } else {
        for (const plan of plans) {
          planList.appendChild(
            this.buildFeederPlanRow(
              data,
              plan,
              skippedToday.has(plan.id),
              {
                updateName: updateAction?.name ?? null,
                delName: delAction?.name ?? null,
                skipName: skipAction?.name ?? null,
                reopenName: reopenAction?.name ?? null,
              },
              maxPortions,
            ),
          );
        }
      }

      sec.appendChild(planList);
      sections.push(sec);
    }

    return sections;
  }

  private buildFeederPlanEditor(
    data: DeviceDetailApiResponse,
    draft: FeederPlanEditorState,
    updateActionName: string,
    minPortions: number,
    maxPortions: number,
  ): HTMLElement {
    const busy = this.busyActions.has(updateActionName);
    const disabled = !data.online || busy;

    const card = document.createElement("div");
    card.className = "dd-feeder-editor";

    const head = document.createElement("div");
    head.className = "dd-feeder-editor-head";
    const title = document.createElement("span");
    title.className = "dd-feeder-editor-title";
    title.textContent =
      draft.mode === "add" ? "添加定时喂食计划" : `编辑定时喂食计划 #${draft.id}`;
    head.appendChild(title);
    card.appendChild(head);

    const grid = document.createElement("div");
    grid.className = "dd-feeder-editor-grid";

    // Time picker
    const timeField = document.createElement("div");
    timeField.className = "dd-feeder-editor-field";
    const timeLbl = document.createElement("label");
    timeLbl.className = "dd-action-param-label";
    timeLbl.textContent = "出粮时间";
    const timeInput = document.createElement("input");
    timeInput.type = "time";
    timeInput.className = "dd-time-input";
    timeInput.value = formatFeedTime(draft.hour, draft.minute);
    timeInput.disabled = disabled;
    timeInput.addEventListener("input", () => {
      const [hStr, mStr] = timeInput.value.split(":");
      const h = Number(hStr);
      const m = Number(mStr);
      if (Number.isInteger(h) && h >= 0 && h <= 23 && Number.isInteger(m) && m >= 0 && m <= 59) {
        draft.hour = h;
        draft.minute = m;
      }
    });
    timeField.append(timeLbl, timeInput);

    // Portions stepper
    const portionField = document.createElement("div");
    portionField.className = "dd-feeder-editor-field";
    const portionLbl = document.createElement("label");
    portionLbl.className = "dd-action-param-label";
    portionLbl.textContent = `出粮份数（${minPortions}–${maxPortions} 份）`;

    const stepper = document.createElement("div");
    stepper.className = "dd-stepper dd-stepper-sm";
    const dec = document.createElement("button");
    dec.type = "button";
    dec.className = "dd-stepper-btn";
    dec.textContent = "−";
    dec.disabled = disabled || draft.portions <= minPortions;
    const pInp = document.createElement("input");
    pInp.type = "number";
    pInp.className = "dd-stepper-input";
    pInp.min = String(minPortions);
    pInp.max = String(maxPortions);
    pInp.value = String(draft.portions);
    pInp.disabled = disabled;
    const pUnit = document.createElement("span");
    pUnit.className = "dd-stepper-unit";
    pUnit.textContent = "份";
    const inc = document.createElement("button");
    inc.type = "button";
    inc.className = "dd-stepper-btn";
    inc.textContent = "+";
    inc.disabled = disabled || draft.portions >= maxPortions;

    const setDraftPortions = (v: number) => {
      const clamped = Math.max(minPortions, Math.min(maxPortions, Math.round(v)));
      draft.portions = clamped;
      pInp.value = String(clamped);
      dec.disabled = disabled || clamped <= minPortions;
      inc.disabled = disabled || clamped >= maxPortions;
    };
    dec.addEventListener("click", () => setDraftPortions(draft.portions - 1));
    inc.addEventListener("click", () => setDraftPortions(draft.portions + 1));
    pInp.addEventListener("input", () => {
      const n = Number(pInp.value);
      if (Number.isFinite(n) && n >= minPortions && n <= maxPortions) {
        draft.portions = Math.round(n);
        dec.disabled = disabled || draft.portions <= minPortions;
        inc.disabled = disabled || draft.portions >= maxPortions;
      }
    });
    pInp.addEventListener("blur", () => {
      const n = Number(pInp.value);
      setDraftPortions(Number.isFinite(n) ? n : draft.portions);
    });

    stepper.append(dec, pInp, pUnit, inc);
    portionField.append(portionLbl, stepper);
    grid.append(timeField, portionField);
    card.appendChild(grid);

    // Repeat cycle selector
    const repeatBlock = document.createElement("div");
    repeatBlock.className = "dd-feeder-repeat-block";
    const repeatLbl = document.createElement("div");
    repeatLbl.className = "dd-action-param-label";
    repeatLbl.textContent = `重复周期 · ${formatFeedDaysLabel(draft.daysMask)}`;

    const presetRow = document.createElement("div");
    presetRow.className = "dd-preset-row";
    const cyclePresets: ReadonlyArray<{ label: string; mask: number }> = [
      { label: "每天", mask: 0x7f },
      { label: "工作日", mask: 0x1f },
      { label: "周末", mask: 0x60 },
    ];
    for (const preset of cyclePresets) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `dd-preset-chip${draft.daysMask === preset.mask ? " active" : ""}`;
      btn.textContent = preset.label;
      btn.disabled = disabled;
      btn.addEventListener("click", () => {
        draft.daysMask = preset.mask;
        this.renderOverviewTab();
      });
      presetRow.appendChild(btn);
    }

    const daysRow = document.createElement("div");
    daysRow.className = "dd-weekday-row";
    for (const day of FEED_WEEKDAYS) {
      const active = (draft.daysMask & day.bit) !== 0;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `dd-weekday-pill${active ? " active" : ""}`;
      btn.textContent = day.short;
      btn.title = day.label;
      btn.setAttribute("aria-label", day.label);
      btn.setAttribute("aria-pressed", String(active));
      btn.disabled = disabled;
      btn.addEventListener("click", () => {
        const nextMask = active ? draft.daysMask & ~day.bit : draft.daysMask | day.bit;
        if (nextMask === 0) {
          this.host.showToast("至少选择一天重复周期", 1800);
          return;
        }
        draft.daysMask = nextMask;
        this.renderOverviewTab();
      });
      daysRow.appendChild(btn);
    }

    repeatBlock.append(repeatLbl, presetRow, daysRow);
    card.appendChild(repeatBlock);

    // Footer buttons
    const footer = document.createElement("div");
    footer.className = "dd-feeder-editor-actions";

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "secondary-button btn-compact dd-feeder-cancel-btn";
    cancelBtn.textContent = "取消";
    cancelBtn.disabled = busy;
    cancelBtn.addEventListener("click", () => {
      this.feederEditor = null;
      this.renderOverviewTab();
    });

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "primary-button btn-compact";
    saveBtn.textContent = busy ? "保存中…" : "保存计划";
    saveBtn.disabled = disabled;
    saveBtn.addEventListener("click", async () => {
      const [hStr, mStr] = timeInput.value.split(":");
      const h = Number(hStr);
      const m = Number(mStr);
      if (Number.isInteger(h) && h >= 0 && h <= 23 && Number.isInteger(m) && m >= 0 && m <= 59) {
        draft.hour = h;
        draft.minute = m;
      }
      const pNum = Number(pInp.value);
      if (Number.isFinite(pNum)) {
        draft.portions = Math.max(minPortions, Math.min(maxPortions, Math.round(pNum)));
      }
      const hex = encodeFeedPlan(draft, maxPortions);
      const ok = await this.runAction(
        updateActionName,
        [hex],
        `已保存定时计划：${formatFeedTime(draft.hour, draft.minute)} · ${draft.portions} 份`,
      );
      if (ok) {
        this.feederEditor = null;
        this.renderOverviewTab();
      }
    });

    footer.append(cancelBtn, saveBtn);
    card.appendChild(footer);
    return card;
  }

  private buildFeederPlanRow(
    data: DeviceDetailApiResponse,
    plan: FeedPlanItem,
    isSkippedToday: boolean,
    actions: {
      updateName: string | null;
      delName: string | null;
      skipName: string | null;
      reopenName: string | null;
    },
    maxPortions: number,
  ): HTMLElement {
    const busyAny =
      (actions.updateName !== null && this.busyActions.has(actions.updateName)) ||
      (actions.delName !== null && this.busyActions.has(actions.delName)) ||
      (actions.skipName !== null && this.busyActions.has(actions.skipName)) ||
      (actions.reopenName !== null && this.busyActions.has(actions.reopenName));
    const disabled = !data.online || busyAny || data.isSplitParent;
    const confirmingDel = this.pendingDeletePlan?.id === plan.id;

    const row = document.createElement("div");
    row.className = `dd-feeder-plan-item${!plan.enabled ? " is-disabled" : ""}${
      isSkippedToday ? " is-skipped" : ""
    }`;

    const left = document.createElement("div");
    left.className = "dd-feeder-plan-info";

    const topLine = document.createElement("div");
    topLine.className = "dd-feeder-plan-top";
    const timeEl = document.createElement("span");
    timeEl.className = "dd-feeder-plan-time";
    timeEl.textContent = formatFeedTime(plan.hour, plan.minute);

    const portionBadge = document.createElement("span");
    portionBadge.className = "dd-feeder-portion-badge";
    portionBadge.textContent = `${plan.portions} 份`;
    topLine.append(timeEl, portionBadge);

    if (isSkippedToday) {
      const badge = document.createElement("span");
      badge.className = "dd-feeder-state-pill is-warn";
      badge.textContent = "今日已跳过";
      topLine.appendChild(badge);
    } else if (!plan.enabled) {
      const badge = document.createElement("span");
      badge.className = "dd-feeder-state-pill";
      badge.textContent = "已停用";
      topLine.appendChild(badge);
    }

    const subLine = document.createElement("div");
    subLine.className = "dd-feeder-plan-sub";
    subLine.textContent = `${formatFeedDaysLabel(plan.daysMask)} · 计划 #${plan.id}`;
    left.append(topLine, subLine);

    const right = document.createElement("div");
    right.className = "dd-feeder-plan-controls";

    if (plan.enabled && ((isSkippedToday && actions.reopenName) || (!isSkippedToday && actions.skipName))) {
      const skipBtn = document.createElement("button");
      skipBtn.type = "button";
      skipBtn.className = "dd-plan-mini-btn";
      skipBtn.textContent = isSkippedToday ? "恢复今日" : "跳过今日";
      skipBtn.disabled = disabled;
      skipBtn.addEventListener("click", () => {
        if (isSkippedToday && actions.reopenName) {
          void this.runAction(
            actions.reopenName,
            [plan.id],
            `已恢复今日 ${formatFeedTime(plan.hour, plan.minute)} 投喂计划`,
          );
        } else if (!isSkippedToday && actions.skipName) {
          void this.runAction(
            actions.skipName,
            [plan.id],
            `已跳过今日 ${formatFeedTime(plan.hour, plan.minute)} 投喂计划`,
          );
        }
      });
      right.appendChild(skipBtn);
    }

    if (actions.updateName) {
      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "dd-plan-mini-btn";
      editBtn.textContent = "编辑";
      editBtn.disabled = disabled;
      editBtn.addEventListener("click", () => {
        this.clearPendingDeletePlan();
        this.feederEditor = {
          mode: "edit",
          id: plan.id,
          enabled: plan.enabled,
          hour: plan.hour,
          minute: plan.minute,
          daysMask: plan.daysMask,
          portions: plan.portions,
        };
        this.renderOverviewTab();
      });
      right.appendChild(editBtn);
    }

    if (actions.delName) {
      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = `dd-plan-mini-btn is-danger${confirmingDel ? " is-confirming" : ""}`;
      delBtn.textContent = confirmingDel ? "确认删除" : "删除";
      delBtn.disabled = disabled;
      delBtn.addEventListener("click", () => {
        if (!confirmingDel) {
          this.clearPendingDeletePlan();
          const timer = window.setTimeout(() => {
            this.pendingDeletePlan = null;
            this.renderOverviewTab();
          }, 4000);
          this.pendingDeletePlan = { id: plan.id, timer };
          this.renderOverviewTab();
          return;
        }
        this.clearPendingDeletePlan();
        if (this.feederEditor?.id === plan.id) {
          this.feederEditor = null;
        }
        void this.runAction(
          actions.delName!,
          [plan.id],
          `已删除定时计划 ${formatFeedTime(plan.hour, plan.minute)}`,
        );
      });
      right.appendChild(delBtn);
    }

    if (actions.updateName) {
      const sw = document.createElement("label");
      sw.className = "md-switch";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = plan.enabled;
      cb.disabled = disabled;
      cb.setAttribute("aria-label", `切换定时计划 ${formatFeedTime(plan.hour, plan.minute)}`);
      cb.addEventListener("change", () => {
        const hex = encodeFeedPlan({ ...plan, enabled: cb.checked }, maxPortions);
        void this.runAction(
          actions.updateName!,
          [hex],
          cb.checked
            ? `已开启 ${formatFeedTime(plan.hour, plan.minute)} 定时计划`
            : `已停用 ${formatFeedTime(plan.hour, plan.minute)} 定时计划`,
        );
      });
      const tr = document.createElement("span");
      tr.className = "md-switch-track";
      sw.append(cb, tr);
      right.appendChild(sw);
    }

    row.append(left, right);
    return row;
  }

  private async dispensePetFood(
    dispenseAction: ActionInfo,
    measureProp: PropInfo | undefined,
    portions: number,
  ): Promise<void> {
    const hasParam = Boolean(dispenseAction.in && dispenseAction.in.length > 0);
    if (hasParam) {
      await this.runAction(dispenseAction.name, [portions], `已下发出粮指令（${portions} 份）`);
      return;
    }
    if (measureProp?.writable) {
      await this.writeProp(measureProp.name, portions);
    }
    await this.runAction(dispenseAction.name, undefined, `已下发出粮指令（${portions} 份）`);
  }

  private buildTelemetrySection(data: DeviceDetailApiResponse, telemetry: PropInfo[]): HTMLElement {
    const section = this.createSection("实时状态", `${telemetry.length} 项只读指标`);
    const grid = document.createElement("div");
    grid.className = "dd-telemetry-grid";

    for (const prop of telemetry) {
      const raw = data.values[prop.name];
      const formatted = formatPropertyValue(prop, raw);
      const tone = semanticToneForTelemetry(prop, raw, formatted, data.values);
      const progress = percentageProgressFor(prop, raw);

      const tile = document.createElement("div");
      tile.className = `dd-metric-tile tone-${tone}`;
      tile.title = `${prop.desc} (${prop.name})`;

      const labelEl = document.createElement("div");
      labelEl.className = "dd-metric-label";
      labelEl.textContent = friendlyPropLabel(prop, data.device);

      const valEl = document.createElement("div");
      valEl.className = "dd-metric-value";
      valEl.textContent = formatted;

      tile.append(labelEl, valEl);

      if (progress !== null) {
        const bar = document.createElement("div");
        bar.className = "dd-metric-bar";
        const fill = document.createElement("div");
        fill.className = "dd-metric-bar-fill";
        fill.style.width = `${progress}%`;
        bar.appendChild(fill);
        tile.appendChild(bar);
      }

      grid.appendChild(tile);
    }

    section.appendChild(grid);
    return section;
  }

  private buildControlsSection(
    data: DeviceDetailApiResponse,
    controls: PropInfo[],
    hasAnyReportedValue = false,
  ): HTMLElement {
    const section = this.createSection("参数与控制", `${controls.length} 项可调参数`);
    const groups = groupPropsByService(controls);
    const showGroupHead = groups.length > 1;

    for (const group of groups) {
      if (showGroupHead) {
        const gTitle = document.createElement("div");
        gTitle.className = "dd-group-title";
        gTitle.textContent = group.label;
        section.appendChild(gTitle);
      }
      const list = document.createElement("div");
      list.className = "dd-control-list";
      for (const prop of group.props) {
        list.appendChild(this.buildControlRow(data, prop, hasAnyReportedValue));
      }
      section.appendChild(list);
    }
    return section;
  }

  private buildControlRow(
    data: DeviceDetailApiResponse,
    prop: PropInfo,
    hasAnyReportedValue = false,
  ): HTMLElement {
    const widget = choosePropertyWidget(prop);
    const raw = data.values[prop.name];
    const busy = this.busyProps.has(prop.name);
    const disabled = !data.online || busy || data.isSplitParent;
    const isUnreported =
      data.online &&
      !data.readWarning &&
      hasAnyReportedValue &&
      prop.readable &&
      (raw === null || raw === undefined);

    const row = document.createElement("div");
    row.className = `dd-control-row widget-${widget}${isUnreported ? " is-unreported" : ""}`;
    row.title = `${prop.desc} (${prop.name})`;

    const info = document.createElement("div");
    info.className = "dd-control-info";
    const propLabel = friendlyPropLabel(prop, data.device);
    const nameEl = document.createElement("div");
    nameEl.className = "dd-control-name";
    nameEl.textContent = propLabel;

    const metaEl = document.createElement("div");
    metaEl.className = "dd-control-meta";
    const metaParts: string[] = [];
    if (isUnreported) {
      metaParts.push("当前：未上报（该型号固件可能不支持）");
    } else if (prop.readable) {
      metaParts.push(`当前：${formatPropertyValue(prop, raw)}`);
    } else {
      metaParts.push("仅支持设置");
    }
    if (prop.range && prop.range.length >= 2 && widget !== "color") {
      const unit = unitLabelZh(prop.unit);
      const unitSuffix =
        !unit ? "" : unit === "%" || unit === "°C" || unit === "°F" || unit === "°" ? unit : ` ${unit}`;
      metaParts.push(`范围 ${prop.range[0]}–${prop.range[1]}${unitSuffix}`);
    }
    metaEl.textContent = metaParts.join(" · ");
    info.append(nameEl, metaEl);

    const ctrl = document.createElement("div");
    ctrl.className = "dd-control-widget";

    if (widget === "switch") {
      const swLabel = document.createElement("label");
      swLabel.className = "md-switch";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = Boolean(raw);
      input.disabled = disabled;
      input.setAttribute("aria-label", friendlyLabel(prop.desc, prop.name));
      input.addEventListener("change", () => {
        void this.writeProp(prop.name, input.checked);
      });
      const track = document.createElement("span");
      track.className = "md-switch-track";
      swLabel.append(input, track);
      ctrl.appendChild(swLabel);
    } else if (widget === "segmented" && prop.value_list) {
      row.classList.add("is-stacked");
      const seg = document.createElement("div");
      seg.className = "dd-segmented";
      for (const opt of prop.value_list) {
        const btn = document.createElement("button");
        btn.type = "button";
        const selected = raw !== null && raw !== undefined && String(raw) === String(opt.value);
        btn.className = `dd-seg-btn${selected ? " active" : ""}`;
        btn.disabled = disabled;
        btn.textContent = resolveEnumLabel(opt.value, [opt]) ?? String(opt.value);
        btn.addEventListener("click", () => {
          if (selected && !isIrRemoteDevice(data.device, data.actions)) return;
          void this.writeProp(prop.name, opt.value);
        });
        seg.appendChild(btn);
      }
      ctrl.appendChild(seg);
    } else if (widget === "select" && prop.value_list) {
      const select = document.createElement("select");
      select.className = "md-select dd-select";
      select.disabled = disabled;
      select.setAttribute("aria-label", friendlyLabel(prop.desc, prop.name));
      let matched = false;
      for (const opt of prop.value_list) {
        const optionEl = document.createElement("option");
        optionEl.value = String(opt.value);
        optionEl.textContent = resolveEnumLabel(opt.value, [opt]) ?? String(opt.value);
        if (raw !== null && raw !== undefined && String(raw) === String(opt.value)) {
          optionEl.selected = true;
          matched = true;
        }
        select.appendChild(optionEl);
      }
      if (!matched) {
        const placeholder = document.createElement("option");
        placeholder.value = "";
        placeholder.textContent = "请选择…";
        placeholder.selected = true;
        placeholder.disabled = true;
        select.prepend(placeholder);
      }
      select.addEventListener("change", () => {
        const target = prop.value_list!.find((o) => String(o.value) === select.value);
        if (target) {
          void this.writeProp(prop.name, target.value);
        }
      });
      ctrl.appendChild(select);
    } else if (widget === "slider" && prop.range && prop.range.length >= 2) {
      row.classList.add("is-stacked");
      const [low, high, stepRaw] = prop.range;
      const step = stepRaw && stepRaw > 0 ? stepRaw : 1;
      const curNum = typeof raw === "number" && Number.isFinite(raw) ? raw : low;
      const wrap = document.createElement("div");
      wrap.className = "dd-inline-slider";
      const slider = document.createElement("input");
      slider.type = "range";
      slider.className = "md-slider";
      slider.min = String(low);
      slider.max = String(high);
      slider.step = String(step);
      slider.value = String(curNum);
      slider.disabled = disabled;
      slider.setAttribute("aria-label", friendlyLabel(prop.desc, prop.name));

      const readout = document.createElement("span");
      readout.className = "dd-inline-readout";
      readout.textContent = formatPropertyValue(prop, typeof raw === "number" ? raw : null);

      slider.addEventListener("pointerdown", () => {
        this.draggingProps.add(prop.name);
        this.revision += 1;
      });
      slider.addEventListener("input", () => {
        const n = Number(slider.value);
        readout.textContent = formatPropertyValue(prop, n);
      });
      const release = () => this.draggingProps.delete(prop.name);
      slider.addEventListener("pointerup", release);
      slider.addEventListener("pointercancel", release);
      slider.addEventListener("change", () => {
        release();
        const v = prop.type === "float" ? Number(slider.value) : Math.round(Number(slider.value));
        void this.writeProp(prop.name, v);
      });

      wrap.append(slider, readout);
      ctrl.appendChild(wrap);
    } else if (widget === "color") {
      const hex = typeof raw === "number" && Number.isFinite(raw) ? rgbIntToHex(raw) : "#ffffff";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "dd-color-custom-btn";
      btn.disabled = disabled;
      const dot = document.createElement("span");
      dot.className = "light-color-dot";
      dot.style.background = hex;
      const span = document.createElement("span");
      span.textContent = hex.toUpperCase();
      btn.append(dot, span);
      const picker = document.createElement("input");
      picker.type = "color";
      picker.className = "sr-color-input";
      picker.value = hex;
      btn.addEventListener("click", () => picker.click());
      picker.addEventListener("change", () => {
        void this.writeProp(prop.name, hexToRgbInt(picker.value));
      });
      ctrl.append(btn, picker);
    } else if (widget === "number") {
      const wrap = document.createElement("div");
      wrap.className = "dd-input-commit";
      const input = document.createElement("input");
      input.type = "number";
      input.className = "dd-num-input";
      if (prop.range && prop.range.length >= 2) {
        input.min = String(prop.range[0]);
        input.max = String(prop.range[1]);
        if (prop.range.length >= 3 && prop.range[2]) {
          input.step = String(prop.range[2]);
        }
      }
      if (typeof raw === "number" && Number.isFinite(raw)) {
        input.value = String(raw);
      }
      input.disabled = disabled;

      const applyBtn = document.createElement("button");
      applyBtn.type = "button";
      applyBtn.className = "secondary-button btn-compact";
      applyBtn.textContent = "设置";
      applyBtn.disabled = disabled;

      const commit = () => {
        const parsed = Number(input.value);
        if (!Number.isFinite(parsed)) {
          this.host.showToast("请输入有效数字", 2200);
          return;
        }
        const v = prop.type === "float" ? parsed : Math.round(parsed);
        void this.writeProp(prop.name, v);
      };
      applyBtn.addEventListener("click", commit);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        }
      });

      wrap.append(input, applyBtn);
      ctrl.appendChild(wrap);
    } else {
      // text
      const wrap = document.createElement("div");
      wrap.className = "dd-input-commit";
      const input = document.createElement("input");
      input.type = isSensitivePropertyName(prop.name) ? "password" : "text";
      input.className = "dd-text-input dd-text-input-sm";
      input.value = typeof raw === "string" && !isSensitivePropertyName(prop.name) ? raw : "";
      input.placeholder = isSensitivePropertyName(prop.name) ? "输入新值…" : "输入内容…";
      input.disabled = disabled;

      const applyBtn = document.createElement("button");
      applyBtn.type = "button";
      applyBtn.className = "secondary-button btn-compact";
      applyBtn.textContent = "设置";
      applyBtn.disabled = disabled;

      const commit = () => {
        void this.writeProp(prop.name, input.value);
      };
      applyBtn.addEventListener("click", commit);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        }
      });

      wrap.append(input, applyBtn);
      ctrl.appendChild(wrap);
    }

    row.append(info, ctrl);
    return row;
  }

  private buildActionsSection(data: DeviceDetailApiResponse, actions: ActionInfo[]): HTMLElement {
    const section = this.createSection("快捷操作", `${actions.length} 项设备动作`);
    const list = document.createElement("div");
    list.className = "dd-action-list";

    for (const action of actions) {
      const params = action.in ?? [];
      const dangerous = actionRequiresConfirmation(action);
      const busy = this.busyActions.has(action.name);
      const disabled = !data.online || busy || data.isSplitParent;
      const confirming = this.pendingConfirmAction?.name === action.name;

      const card = document.createElement("div");
      card.className = `dd-action-card${params.length > 0 ? " has-params" : ""}${dangerous ? " is-danger" : ""}`;
      card.title = `${action.desc} (${action.name})`;

      const head = document.createElement("div");
      head.className = "dd-action-head";
      const textCol = document.createElement("div");
      textCol.className = "dd-action-info";
      const title = document.createElement("div");
      title.className = "dd-action-title";
      title.textContent = friendlyLabel(action.desc, action.name);
      const sub = document.createElement("div");
      sub.className = "dd-action-sub";
      sub.textContent = action.service_desc ? `${action.service_desc} · ${action.name}` : action.name;
      textCol.append(title, sub);

      const execBtn = document.createElement("button");
      execBtn.type = "button";
      execBtn.className = dangerous
        ? confirming
          ? "dd-danger-btn is-confirming"
          : "dd-danger-btn"
        : params.length > 0
          ? "primary-button btn-compact"
          : "secondary-button btn-compact";
      execBtn.disabled = disabled;
      execBtn.textContent = busy
        ? "执行中…"
        : confirming
          ? "再次点击确认"
          : params.length > 0
            ? "执行"
            : dangerous
              ? friendlyLabel(action.desc, action.name)
              : "立即执行";

      head.append(textCol, execBtn);
      card.appendChild(head);

      // Parameter inputs (e.g. pet-food-out portions, play-text text, seek seconds)
      let draft = this.actionDrafts.get(action.name);
      if (params.length > 0) {
        if (!draft) {
          draft = {};
          for (const p of params) {
            draft[p.name] = defaultActionParamValue(p);
          }
          this.actionDrafts.set(action.name, draft);
        }

        const paramForm = document.createElement("div");
        paramForm.className = "dd-action-params";
        for (const p of params) {
          const field = document.createElement("div");
          field.className = "dd-action-param-field";
          const lbl = document.createElement("label");
          lbl.className = "dd-action-param-label";
          const unit = unitLabelZh(p.unit);
          const rangeHint =
            p.range && p.range.length >= 2 ? ` (${p.range[0]}–${p.range[1]}${unit ? ` ${unit}` : ""})` : "";
          lbl.textContent = `${friendlyLabel(p.desc, p.name)}${rangeHint}`;
          field.appendChild(lbl);

          if (p.type === "bool") {
            const sw = document.createElement("label");
            sw.className = "md-switch";
            const cb = document.createElement("input");
            cb.type = "checkbox";
            cb.checked = Boolean(draft[p.name]);
            cb.disabled = disabled;
            cb.addEventListener("change", () => {
              draft![p.name] = cb.checked;
            });
            const tr = document.createElement("span");
            tr.className = "md-switch-track";
            sw.append(cb, tr);
            field.appendChild(sw);
          } else if (p.value_list && p.value_list.length > 0) {
            const sel = document.createElement("select");
            sel.className = "md-select md-select-sm";
            sel.disabled = disabled;
            for (const opt of p.value_list) {
              const o = document.createElement("option");
              o.value = String(opt.value);
              o.textContent = resolveEnumLabel(opt.value, [opt]) ?? String(opt.value);
              if (String(draft[p.name]) === String(opt.value)) {
                o.selected = true;
              }
              sel.appendChild(o);
            }
            sel.addEventListener("change", () => {
              const found = p.value_list!.find((opt) => String(opt.value) === sel.value);
              if (found) draft![p.name] = found.value;
            });
            field.appendChild(sel);
          } else if (p.type === "int" || p.type === "uint" || p.type === "float") {
            const inp = document.createElement("input");
            inp.type = "number";
            inp.className = "dd-num-input";
            if (p.range && p.range.length >= 2) {
              inp.min = String(p.range[0]);
              inp.max = String(p.range[1]);
              if (p.range.length >= 3 && p.range[2]) inp.step = String(p.range[2]);
            }
            inp.value = String(draft[p.name] ?? "");
            inp.disabled = disabled;
            inp.addEventListener("input", () => {
              const n = Number(inp.value);
              draft![p.name] = Number.isFinite(n) ? (p.type === "float" ? n : Math.round(n)) : inp.value;
            });
            field.appendChild(inp);
          } else {
            const inp = document.createElement("input");
            inp.type = "text";
            inp.className = "dd-text-input dd-text-input-sm";
            inp.value = String(draft[p.name] ?? "");
            inp.placeholder = `输入${friendlyLabel(p.desc, p.name)}…`;
            inp.disabled = disabled;
            inp.addEventListener("input", () => {
              draft![p.name] = inp.value;
            });
            field.appendChild(inp);
          }

          paramForm.appendChild(field);
        }
        card.appendChild(paramForm);
      }

      execBtn.addEventListener("click", () => {
        if (dangerous && this.pendingConfirmAction?.name !== action.name) {
          this.clearPendingConfirm();
          const timer = window.setTimeout(() => {
            this.pendingConfirmAction = null;
            this.renderOverviewTab();
          }, 4000);
          this.pendingConfirmAction = { name: action.name, timer };
          this.renderOverviewTab();
          return;
        }
        this.clearPendingConfirm();

        if (params.length > 0 && draft) {
          const argValues: unknown[] = [];
          for (const p of params) {
            const val = draft[p.name];
            if (p.type === "string" && String(val ?? "").trim() === "") {
              this.host.showToast(`请先填写「${friendlyLabel(p.desc, p.name)}」`, 2400);
              return;
            }
            if (p.type === "int" || p.type === "uint" || p.type === "float") {
              const num = Number(val);
              if (!Number.isFinite(num)) {
                this.host.showToast(`「${friendlyLabel(p.desc, p.name)}」需要有效数字`, 2400);
                return;
              }
              if (p.range && p.range.length >= 2 && (num < p.range[0] || num > p.range[1])) {
                this.host.showToast(
                  `「${friendlyLabel(p.desc, p.name)}」需在 ${p.range[0]}–${p.range[1]} 之间`,
                  2400,
                );
                return;
              }
              argValues.push(p.type === "float" ? num : Math.round(num));
            } else if (p.type === "bool") {
              argValues.push(Boolean(val));
            } else {
              argValues.push(String(val ?? "").trim());
            }
          }
          void this.runAction(action.name, argValues);
        } else {
          void this.runAction(action.name);
        }
      });

      list.appendChild(card);
    }

    section.appendChild(list);
    return section;
  }

  // -------------------------------------------------------------------------
  // Tab 2: All Properties Inspector
  // -------------------------------------------------------------------------

  private renderPropertiesTab(): void {
    const data = this.data;
    const wrap = el("dd-props-table-wrap");
    wrap.replaceChildren();
    if (!data) return;

    const query = this.propsSearchQuery;
    const filtered = data.props.filter((p) => {
      if (!this.showAdvancedProps && !p.readable && !p.writable) {
        return false;
      }
      if (!query) return true;
      const haystack = `${p.name} ${p.desc} ${p.service ?? ""} ${p.service_desc ?? ""}`.toLowerCase();
      return haystack.includes(query);
    });

    if (filtered.length === 0) {
      const empty = document.createElement("div");
      empty.className = "dd-empty-card";
      empty.textContent =
        data.props.length === 0
          ? "该设备暂无 MIoT 属性定义"
          : "没有匹配当前筛选条件的属性";
      wrap.appendChild(empty);
      return;
    }

    const table = document.createElement("table");
    table.className = "dd-props-table";
    table.innerHTML = `
      <thead>
        <tr>
          <th>属性</th>
          <th>权限</th>
          <th>当前值</th>
          <th>规格</th>
        </tr>
      </thead>
    `;
    const tbody = document.createElement("tbody");

    for (const prop of filtered) {
      const tr = document.createElement("tr");
      const raw = data.values[prop.name];

      const tdName = document.createElement("td");
      tdName.className = "dd-td-name";
      const mainLbl = document.createElement("div");
      mainLbl.className = "dd-td-title";
      mainLbl.textContent = friendlyPropLabel(prop, data.device);
      const codeLbl = document.createElement("div");
      codeLbl.className = "dd-td-code";
      const addr =
        prop.siid !== undefined && prop.piid !== undefined ? `s${prop.siid}:p${prop.piid} · ` : "";
      codeLbl.textContent = `${addr}${prop.name}`;
      tdName.append(mainLbl, codeLbl);

      const tdRw = document.createElement("td");
      const badge = document.createElement("span");
      const rwText =
        prop.readable && prop.writable
          ? "读写"
          : prop.readable
            ? "只读"
            : prop.writable
              ? "只写"
              : "动作参数";
      badge.className = `dd-rw-badge is-${
        prop.readable && prop.writable
          ? "rw"
          : prop.readable
            ? "r"
            : prop.writable
              ? "w"
              : "param"
      }`;
      badge.textContent = rwText;
      tdRw.appendChild(badge);

      const tdVal = document.createElement("td");
      tdVal.className = "dd-td-val";
      tdVal.textContent = prop.readable ? formatPropertyValue(prop, raw) : "—";

      const tdSpec = document.createElement("td");
      tdSpec.className = "dd-td-spec";
      const specParts: string[] = [prop.type];
      const unit = unitLabelZh(prop.unit);
      if (unit) specParts.push(unit);
      if (prop.range && prop.range.length >= 2) {
        specParts.push(`[${prop.range[0]}..${prop.range[1]}]`);
      } else if (prop.value_list && prop.value_list.length > 0) {
        specParts.push(`${prop.value_list.length} 项枚举`);
      }
      tdSpec.textContent = specParts.join(" · ");

      tr.append(tdName, tdRw, tdVal, tdSpec);
      tbody.appendChild(tr);
    }

    table.appendChild(tbody);
    wrap.appendChild(table);
  }

  // -------------------------------------------------------------------------
  // Tab 3: Device Metadata Info
  // -------------------------------------------------------------------------

  private renderInfoTab(): void {
    const data = this.data;
    const container = el("dd-panel-info");
    container.replaceChildren();
    if (!data) return;

    const dev = data.device;
    const readableCount = data.props.filter((p) => p.readable).length;
    const writableCount = data.props.filter((p) => p.writable).length;

    const rows: Array<{ label: string; value: string; copyable?: boolean; mono?: boolean }> = [
      { label: "设备名称", value: this.host.deviceTitle(dev) },
      { label: "设备品类", value: data.category },
      { label: "连接状态", value: dev.online ? "在线" : "离线" },
      { label: "所属家庭", value: dev.home_name || "未分配" },
      { label: "所在房间", value: dev.room_name || "未分配房间" },
      { label: "设备型号", value: dev.model || "—", copyable: Boolean(dev.model), mono: true },
      { label: "固件版本", value: dev.firmware || "—", mono: true },
      { label: "设备标识 (DID)", value: dev.did, copyable: true, mono: true },
      {
        label: "MIoT 规格标识",
        value: dev.spec_type || "未公开规格",
        copyable: Boolean(dev.spec_type),
        mono: true,
      },
      {
        label: "功能能力统计",
        value: `${readableCount} 项可读状态 · ${writableCount} 项可调参数 · ${data.actions.length} 项快捷操作`,
      },
    ];

    const grid = document.createElement("div");
    grid.className = "dd-info-list";
    for (const item of rows) {
      const row = document.createElement("div");
      row.className = "dd-info-row";
      const lbl = document.createElement("span");
      lbl.className = "dd-info-label";
      lbl.textContent = item.label;
      const valWrap = document.createElement("div");
      valWrap.className = "dd-info-val-wrap";
      const val = document.createElement("span");
      val.className = `dd-info-val${item.mono ? " is-mono" : ""}`;
      val.textContent = item.value;
      valWrap.appendChild(val);

      if (item.copyable) {
        const cp = document.createElement("button");
        cp.type = "button";
        cp.className = "dd-copy-mini";
        cp.textContent = "复制";
        cp.addEventListener("click", async () => {
          try {
            await navigator.clipboard.writeText(item.value);
            cp.textContent = "已复制";
            window.setTimeout(() => {
              cp.textContent = "复制";
            }, 1500);
          } catch {
            this.host.showToast("复制失败", 2000);
          }
        });
        valWrap.appendChild(cp);
      }

      row.append(lbl, valWrap);
      grid.appendChild(row);
    }

    container.appendChild(grid);
  }

  // -------------------------------------------------------------------------
  // Mutations (Power / Channel / Prop / Action)
  // -------------------------------------------------------------------------

  private async togglePrimaryPower(): Promise<void> {
    const data = this.data;
    if (!data || !data.online || this.busyPower || !data.powerProp) return;
    const gen = this.generation;
    const nextState = data.powerState === true ? false : true;
    this.busyPower = true;
    this.revision += 1;
    this.renderHeaderShell(data.device);
    this.renderFooter();

    try {
      if (this.host.isCamera(data.device)) {
        await this.host.apiPost(`/api/devices/${encodeURIComponent(data.did)}/prop`, {
          name: data.powerProp.name,
          value: nextState,
        });
      } else {
        await this.host.apiPost(`/api/devices/${encodeURIComponent(data.did)}/power`, {
          state: nextState,
        });
      }
      if (gen !== this.generation || !this.data) return;
      this.data.powerState = nextState;
      this.data.values[data.powerProp.name] = nextState;
      this.data.fetchedAt = Date.now();
      this.host.onPowerSynced(data.did, nextState);
      this.host.showToast(`已${nextState ? "打开" : "关闭"}「${data.device.name}」`, 2000);
    } catch (err) {
      if (gen !== this.generation) return;
      const msg = err instanceof Error ? err.message : String(err);
      this.host.showToast(`开关失败：${msg}`, 3200);
    } finally {
      if (gen === this.generation) {
        this.busyPower = false;
        this.renderAll();
      }
    }
  }

  private async toggleChannelPower(channel: DeviceChannelState): Promise<void> {
    if (!channel.online || this.busyChannels.has(channel.did)) return;
    const gen = this.generation;
    const next = channel.power === true ? false : true;
    this.busyChannels.add(channel.did);
    this.revision += 1;
    this.renderOverviewTab();

    try {
      await this.host.apiPost(`/api/devices/${encodeURIComponent(channel.did)}/power`, {
        state: next,
      });
      if (gen !== this.generation || !this.data) return;
      channel.power = next;
      this.host.onPowerSynced(channel.did, next);
      this.host.showToast(`已${next ? "打开" : "关闭"}「${channel.name}」`, 1800);
    } catch (err) {
      if (gen !== this.generation) return;
      const msg = err instanceof Error ? err.message : String(err);
      this.host.showToast(`开关「${channel.name}」失败：${msg}`, 3000);
    } finally {
      if (gen === this.generation) {
        this.busyChannels.delete(channel.did);
        this.renderOverviewTab();
      }
    }
  }

  private async writeProp(propName: string, value: unknown): Promise<void> {
    const data = this.data;
    if (!data || !data.online || this.busyProps.has(propName)) return;
    const gen = this.generation;
    this.busyProps.add(propName);
    this.revision += 1;
    this.renderFooter();
    this.renderOverviewTab();

    try {
      const res = await this.host.apiPost<{
        ok?: boolean;
        values?: Record<string, unknown>;
      }>(`/api/devices/${encodeURIComponent(data.did)}/prop`, {
        name: propName,
        value,
      });
      if (gen !== this.generation || !this.data) return;
      this.data.values[propName] = value;
      if (res?.values && typeof res.values === "object") {
        Object.assign(this.data.values, res.values);
      }
      if (this.data.powerProp && typeof this.data.values[this.data.powerProp.name] === "boolean") {
        const pwr = this.data.values[this.data.powerProp.name] as boolean;
        this.data.powerState = pwr;
        this.host.onPowerSynced(this.data.did, pwr);
      }
      this.data.fetchedAt = Date.now();
      const prop = this.data.props.find((p) => p.name === propName);
      const label = prop ? friendlyPropLabel(prop, this.data.device) : propName;
      const formatted = prop ? formatPropertyValue(prop, this.data.values[propName]) : String(value);
      this.host.showToast(`已更新「${label}」：${formatted}`, 2000);
    } catch (err) {
      if (gen !== this.generation) return;
      const msg = err instanceof Error ? err.message : String(err);
      this.host.showToast(`设置失败：${msg}`, 3200);
    } finally {
      if (gen === this.generation) {
        this.busyProps.delete(propName);
        this.renderAll();
      }
    }
  }

  private async runAction(
    actionName: string,
    params?: unknown[],
    customSuccessToast?: string,
  ): Promise<boolean> {
    const data = this.data;
    if (!data || !data.online || this.busyActions.has(actionName)) return false;
    const gen = this.generation;
    this.busyActions.add(actionName);
    this.revision += 1;
    this.renderFooter();
    this.renderOverviewTab();

    try {
      const body: Record<string, unknown> = { name: actionName };
      if (params !== undefined) {
        body.params = params;
      }
      const res = await this.host.apiPost<{
        ok?: boolean;
        values?: Record<string, unknown>;
        powerState?: boolean | null;
        message?: string;
      }>(`/api/devices/${encodeURIComponent(data.did)}/action`, body);
      if (gen !== this.generation || !this.data) return false;
      if (res?.values && typeof res.values === "object") {
        Object.assign(this.data.values, res.values);
      }
      if (typeof res?.powerState === "boolean") {
        this.data.powerState = res.powerState;
        this.host.onPowerSynced(this.data.did, res.powerState);
      } else if (
        this.data.powerProp &&
        typeof this.data.values[this.data.powerProp.name] === "boolean"
      ) {
        const pwr = this.data.values[this.data.powerProp.name] as boolean;
        this.data.powerState = pwr;
        this.host.onPowerSynced(this.data.did, pwr);
      }
      this.data.fetchedAt = Date.now();
      const act = this.data.actions.find((a) => a.name === actionName);
      const label = act ? friendlyLabel(act.desc, act.name) : actionName;
      this.host.showToast(customSuccessToast || res?.message || `已执行「${label}」`, 2200);
      return true;
    } catch (err) {
      if (gen !== this.generation) return false;
      const msg = err instanceof Error ? err.message : String(err);
      this.host.showToast(`执行失败：${msg}`, 3500);
      return false;
    } finally {
      if (gen === this.generation) {
        this.busyActions.delete(actionName);
        this.renderAll();
      }
    }
  }

  private createSection(title: string, hint?: string): HTMLElement {
    const sec = document.createElement("section");
    sec.className = "dd-section";
    const head = document.createElement("div");
    head.className = "dd-section-head";
    const h3 = document.createElement("h3");
    h3.className = "dd-section-title";
    h3.textContent = title;
    head.appendChild(h3);
    if (hint) {
      const span = document.createElement("span");
      span.className = "dd-section-hint";
      span.textContent = hint;
      head.appendChild(span);
    }
    sec.appendChild(head);
    return sec;
  }
}
