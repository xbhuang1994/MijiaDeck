// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * 完整设备详情模态窗（支持全品类米家设备的状态查看、参数调节、动作执行、分路开关控制与规格检查）。
 */

import {
  actionRequiresConfirmation,
  choosePropertyWidget,
  classifyDeviceProps,
  deviceCategoryLabel,
  formatPropertyValue,
  friendlyLabel,
  groupPropsByService,
  percentageProgressFor,
  resolveEnumLabel,
  type ClassifiedDeviceProps,
  type DeviceChannelState,
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

function semanticToneForTelemetry(prop: PropInfo, rawValue: unknown, formatted: string): "normal" | "good" | "warn" | "danger" {
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
    if (typeof rawValue === "number" && rawValue <= 15) return "danger";
    if (typeof rawValue === "number" && rawValue <= 30) return "warn";
  }
  return "normal";
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
    this.clearPendingConfirm();
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

  private startPolling(): void {
    this.stopPolling();
    if (!this.device?.online) return;
    this.pollTimer = window.setInterval(() => {
      if (!this.device || !this.device.online) return;
      if (this.loading || this.refreshing || this.busyPower) return;
      if (this.busyProps.size > 0 || this.busyActions.size > 0 || this.draggingProps.size > 0) return;
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

    // 3. Speaker Media & Voice Hero
    const speakerHeroActionNames = new Set<string>();
    if (this.host.isSpeaker(data.device)) {
      const hero = this.buildSpeakerHero(data, speakerHeroActionNames);
      if (hero) {
        container.appendChild(hero);
        renderedAnything = true;
      }
    }

    // 4. Live Telemetry / Read-Only Status Grid
    if (classified.telemetry.length > 0) {
      container.appendChild(this.buildTelemetrySection(data, classified.telemetry));
      renderedAnything = true;
    }

    // 5. Writable Controls Grouped by Service
    if (classified.controls.length > 0) {
      container.appendChild(this.buildControlsSection(data, classified.controls));
      renderedAnything = true;
    }

    // 6. Executable Actions (excluding transport buttons already shown in Speaker Hero)
    const remainingActions = data.actions.filter((a) => !speakerHeroActionNames.has(a.name));
    if (remainingActions.length > 0) {
      container.appendChild(this.buildActionsSection(data, remainingActions));
      renderedAnything = true;
    }

    // 7. Empty / Basic-only fallback (e.g. BLE-only device without MIoT spec or simple switch)
    if (!renderedAnything) {
      const empty = document.createElement("div");
      empty.className = "dd-empty-card";
      const title = document.createElement("h3");
      title.className = "dd-empty-title";
      title.textContent = data.powerProp
        ? "基础开关设备"
        : data.specError
          ? "暂无公开控制能力"
          : "暂无更多可展示属性";
      const desc = document.createElement("p");
      desc.className = "dd-empty-desc";
      desc.textContent = data.powerProp
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

  private buildTelemetrySection(data: DeviceDetailApiResponse, telemetry: PropInfo[]): HTMLElement {
    const section = this.createSection("实时状态", `${telemetry.length} 项只读指标`);
    const grid = document.createElement("div");
    grid.className = "dd-telemetry-grid";

    for (const prop of telemetry) {
      const raw = data.values[prop.name];
      const formatted = formatPropertyValue(prop, raw);
      const tone = semanticToneForTelemetry(prop, raw, formatted);
      const progress = percentageProgressFor(prop, raw);

      const tile = document.createElement("div");
      tile.className = `dd-metric-tile tone-${tone}`;
      tile.title = `${prop.desc} (${prop.name})`;

      const labelEl = document.createElement("div");
      labelEl.className = "dd-metric-label";
      labelEl.textContent = friendlyLabel(prop.desc, prop.name);

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

  private buildControlsSection(data: DeviceDetailApiResponse, controls: PropInfo[]): HTMLElement {
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
        list.appendChild(this.buildControlRow(data, prop));
      }
      section.appendChild(list);
    }
    return section;
  }

  private buildControlRow(data: DeviceDetailApiResponse, prop: PropInfo): HTMLElement {
    const widget = choosePropertyWidget(prop);
    const raw = data.values[prop.name];
    const busy = this.busyProps.has(prop.name);
    const disabled = !data.online || busy || data.isSplitParent;

    const row = document.createElement("div");
    row.className = `dd-control-row widget-${widget}`;
    row.title = `${prop.desc} (${prop.name})`;

    const info = document.createElement("div");
    info.className = "dd-control-info";
    const nameEl = document.createElement("div");
    nameEl.className = "dd-control-name";
    nameEl.textContent = friendlyLabel(prop.desc, prop.name);

    const metaEl = document.createElement("div");
    metaEl.className = "dd-control-meta";
    const metaParts: string[] = [];
    if (prop.readable) {
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
          if (selected) return;
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
      mainLbl.textContent = friendlyLabel(prop.desc, prop.name);
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
      const label = prop ? friendlyLabel(prop.desc, prop.name) : propName;
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

  private async runAction(actionName: string, params?: unknown[]): Promise<void> {
    const data = this.data;
    if (!data || !data.online || this.busyActions.has(actionName)) return;
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
        message?: string;
      }>(`/api/devices/${encodeURIComponent(data.did)}/action`, body);
      if (gen !== this.generation || !this.data) return;
      if (res?.values && typeof res.values === "object") {
        Object.assign(this.data.values, res.values);
      }
      if (this.data.powerProp && typeof this.data.values[this.data.powerProp.name] === "boolean") {
        const pwr = this.data.values[this.data.powerProp.name] as boolean;
        this.data.powerState = pwr;
        this.host.onPowerSynced(this.data.did, pwr);
      }
      this.data.fetchedAt = Date.now();
      const act = this.data.actions.find((a) => a.name === actionName);
      const label = act ? friendlyLabel(act.desc, act.name) : actionName;
      this.host.showToast(res?.message || `已执行「${label}」`, 2200);
    } catch (err) {
      if (gen !== this.generation) return;
      const msg = err instanceof Error ? err.message : String(err);
      this.host.showToast(`执行失败：${msg}`, 3500);
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
