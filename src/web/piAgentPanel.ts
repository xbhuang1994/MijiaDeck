// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * 内置 Pi Agent 侧边控制抽屉、标题栏语音监听入口与实时语音字幕浮层控制器。
 */

import {
  VoiceListenerClient,
  type ClientVoiceConfig,
  type ClientVoiceMode,
} from "./voiceListener.ts";

export interface UiAgentToolCall {
  id: string;
  name: string;
  label: string;
  args: Record<string, unknown>;
  status: "running" | "done" | "error";
  summary: string;
  durationMs?: number;
}

export interface UiAgentTimelineEntry {
  id: string;
  role: "user" | "assistant";
  source: "text" | "voice";
  text: string;
  timestamp: number;
  status: "streaming" | "done" | "error" | "aborted";
  provider?: string;
  modelId?: string;
  toolCalls: UiAgentToolCall[];
  error?: string;
}

export interface UiProviderPreset {
  id: string;
  label: string;
  description: string;
  defaultModel: string;
  suggestedModels: string[];
  defaultBaseUrl: string;
  requiresApiKey: boolean;
}

export interface UiPublicAgentConfig extends ClientVoiceConfig {
  provider: string;
  customProviderName?: string;
  customApiType?: string;
  modelId: string;
  baseUrl: string;
  systemPromptExtra: string;
  maxHistoryTurns: number;
  sttBaseUrl: string;
  sttModel: string;
  hasApiKey: boolean;
  apiKeyPreview: string;
  envApiKeyDetected: boolean;
  hasSttApiKey: boolean;
  sttApiKeyPreview: string;
}

export interface UiPiAgentSnapshot {
  running: boolean;
  provider: string;
  providerLabel: string;
  modelId: string;
  tools: Array<{ name: string; label: string; description: string }>;
  timeline: UiAgentTimelineEntry[];
  config: UiPublicAgentConfig;
  providers: UiProviderPreset[];
  lastError: string | null;
}

export interface UiVoiceSnapshot {
  active: boolean;
  mode: ClientVoiceMode;
  engine: "browser" | "whisper" | "manual";
  interimTranscript: string;
  lastTranscript: string;
  lastCommand: string;
  awakeUntil: number | null;
  error: string | null;
  wakeWordEnabled: boolean;
  wakeWords: string[];
  autoSpeakReply: boolean;
}

export interface PiAgentPanelDeps {
  apiGet: <T>(url: string) => Promise<T>;
  apiPost: <T>(url: string, body?: unknown) => Promise<T>;
  showToast: (message: string, durationMs?: number) => void;
  openVoiceAgentSettings: () => void;
}

const QUICK_SUGGESTIONS: ReadonlyArray<string> = [
  "打开客厅吸顶灯，亮度调到 85%",
  "把客厅吸顶灯调成暖光",
  "查看卧室现在温度和湿度",
  "关闭餐厅所有灯",
  "给宠物喂食器出粮 1 份",
  "小爱音箱音量调到 55",
];

function node<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing DOM element: #${id}`);
  return el as T;
}

function asRec(val: unknown): Record<string, unknown> | null {
  return typeof val === "object" && val !== null && !Array.isArray(val)
    ? (val as Record<string, unknown>)
    : null;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function formatArgsPreview(args: Record<string, unknown>): string {
  const entries = Object.entries(args).filter(([, v]) => v !== undefined && v !== null && v !== "");
  if (entries.length === 0) return "";
  return entries
    .slice(0, 4)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" · ");
}

export class PiAgentPanelController {
  private open = false;
  private agentState: UiPiAgentSnapshot | null = null;
  private voiceState: UiVoiceSnapshot | null = null;
  private localClientState: {
    active: boolean;
    mode: ClientVoiceMode;
    engine: "browser" | "whisper";
    interimTranscript: string;
    error: string | null;
    oneShot: boolean;
  } = {
    active: false,
    mode: "idle",
    engine: "browser",
    interimTranscript: "",
    error: null,
    oneShot: false,
  };
  private audioLevel = 0;
  private livePillHideTimer: number | null = null;
  private readonly voiceClient: VoiceListenerClient;

  constructor(private readonly deps: PiAgentPanelDeps) {
    this.voiceClient = new VoiceListenerClient({
      onStatusChange: (status) => {
        this.localClientState = status;
        this.renderTitleButtons();
        this.renderVoiceStrip();
        this.renderLivePill();
      },
      onLevelChange: (level) => {
        this.audioLevel = level;
        this.updateWaveformBars();
      },
      onSyncServerState: (patch) => {
        void this.deps.apiPost("/api/voice-listen/state", patch).catch(() => {});
      },
      onTranscriptFinal: async (text, opts) => {
        try {
          const res = await this.deps.apiPost<{
            matched?: boolean;
            wokeOnly?: boolean;
            command?: string;
            reply?: string;
            agent?: UiPiAgentSnapshot;
            voiceState?: UiVoiceSnapshot;
          }>("/api/voice-listen/transcript", {
            text,
            isFinal: true,
            bypassWakeWord: opts.bypassWakeWord,
            engine: opts.engine,
          });
          if (res.agent) this.applyAgentSnapshot(res.agent);
          if (res.voiceState) this.applyVoiceSnapshot(res.voiceState);
          if (res.matched && res.wokeOnly) {
            this.flashLivePill("已唤醒，请说控制指令…", 4000);
          } else if (res.matched && res.reply) {
            this.flashLivePill(`Pi Agent：${res.reply}`, 4200);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.deps.showToast(`语音指令执行失败：${msg}`, 3500);
        }
      },
      onUploadAudio: async (blob, opts) => {
        const form = new FormData();
        form.append("audio", blob, "voice.webm");
        form.append("lang", opts.lang);
        form.append("bypassWakeWord", String(opts.bypassWakeWord));
        form.append("autoDispatch", "true");
        const response = await fetch("/api/voice-listen/transcribe", {
          method: "POST",
          body: form,
        });
        const data = (await response.json()) as {
          ok?: boolean;
          error?: string;
          text?: string;
          matched?: boolean;
          reply?: string;
          agent?: UiPiAgentSnapshot;
          voiceState?: UiVoiceSnapshot;
        };
        if (!response.ok || data.ok === false) {
          throw new Error(data.error || `转写请求失败 (${response.status})`);
        }
        if (data.agent) this.applyAgentSnapshot(data.agent);
        if (data.voiceState) this.applyVoiceSnapshot(data.voiceState);
        if (data.matched && data.reply) {
          this.flashLivePill(`Pi Agent：${data.reply}`, 4200);
        }
      },
      onToast: (msg, ms) => this.deps.showToast(msg, ms),
    });
  }

  bindEvents(): void {
    node("voice-listen-toggle-btn").addEventListener("click", () => {
      void this.toggleVoiceListening();
    });

    node("pi-agent-toggle-btn").addEventListener("click", () => {
      this.toggleDrawer();
    });

    node("pi-drawer-close-btn").addEventListener("click", () => {
      this.setOpen(false);
    });

    node("pi-drawer-settings-btn").addEventListener("click", () => {
      this.deps.openVoiceAgentSettings();
    });

    node("pi-agent-engine-badge").addEventListener("click", () => {
      this.deps.openVoiceAgentSettings();
    });

    node("pi-drawer-reset-btn").addEventListener("click", () => {
      void this.resetConversation();
    });

    node("pi-voice-start-btn").addEventListener("click", () => {
      void this.toggleVoiceListening();
    });

    node("pi-voice-oneshot-btn").addEventListener("click", () => {
      void this.triggerOneShotVoice();
    });

    node("pi-voice-wake-toggle-btn").addEventListener("click", () => {
      void this.toggleWakeWordMode();
    });

    const input = node<HTMLInputElement>("pi-agent-input");
    const submitInput = () => {
      const text = input.value.trim();
      if (!text) return;
      input.value = "";
      void this.sendTextPrompt(text);
    };

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        submitInput();
      }
    });

    node("pi-agent-send-btn").addEventListener("click", () => {
      if (this.agentState?.running) {
        void this.abortRun();
      } else {
        submitInput();
      }
    });

    // Live floating pill click opens drawer
    node("voice-live-pill").addEventListener("click", () => {
      this.setOpen(true);
    });

    // Global shortcut Alt+V for quick one-shot voice command
    document.addEventListener("keydown", (e) => {
      if (e.altKey && (e.key === "v" || e.key === "V")) {
        e.preventDefault();
        void this.triggerOneShotVoice();
      }
    });

    this.renderQuickChips();
    this.renderAll();
  }

  isOpen(): boolean {
    return this.open;
  }

  getConfig(): UiPublicAgentConfig | null {
    return this.agentState?.config ?? null;
  }

  getProviders(): UiProviderPreset[] {
    return this.agentState?.providers ?? [];
  }

  toggleDrawer(): void {
    this.setOpen(!this.open);
  }

  setOpen(next: boolean): void {
    this.open = next;
    const drawer = node("pi-agent-drawer");
    drawer.hidden = !next;
    node("pi-agent-toggle-btn").classList.toggle("active", next);
    node("pi-agent-toggle-btn").setAttribute("aria-expanded", String(next));
    // 抽屉打开时临时隐藏右下角小爱悬浮球避免重叠
    document.body.classList.toggle("pi-drawer-open", next);
    if (next) {
      this.scrollTimelineToBottom();
      window.setTimeout(() => {
        node<HTMLInputElement>("pi-agent-input").focus();
      }, 60);
    }
  }

  async toggleVoiceListening(): Promise<void> {
    await this.voiceClient.toggle();
  }

  async triggerOneShotVoice(): Promise<void> {
    this.setOpen(true);
    await this.voiceClient.startOneShot();
  }

  async toggleWakeWordMode(): Promise<void> {
    const current = this.agentState?.config.wakeWordEnabled ?? true;
    try {
      const res = await this.deps.apiPost<{
        agent?: UiPiAgentSnapshot;
        voice?: UiVoiceSnapshot;
      }>("/api/agent/config", { wakeWordEnabled: !current });
      if (res.agent) this.applyAgentSnapshot(res.agent);
      if (res.voice) this.applyVoiceSnapshot(res.voice);
      this.deps.showToast(!current ? "已开启唤醒词模式" : "已切换为免唤醒直接监听模式", 2200);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.deps.showToast(`切换失败：${msg}`, 3000);
    }
  }

  async sendTextPrompt(text: string): Promise<void> {
    try {
      const res = await this.deps.apiPost<{ agent?: UiPiAgentSnapshot }>("/api/agent/prompt", {
        text,
        source: "text",
      });
      if (res.agent) {
        this.applyAgentSnapshot(res.agent);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.deps.showToast(`Pi Agent 执行失败：${msg}`, 3500);
    }
  }

  async abortRun(): Promise<void> {
    try {
      const res = await this.deps.apiPost<{ agent?: UiPiAgentSnapshot }>("/api/agent/abort");
      if (res.agent) this.applyAgentSnapshot(res.agent);
    } catch {
      // ignore
    }
  }

  async resetConversation(): Promise<void> {
    try {
      const res = await this.deps.apiPost<{ agent?: UiPiAgentSnapshot }>("/api/agent/reset");
      if (res.agent) this.applyAgentSnapshot(res.agent);
      this.deps.showToast("已清空 Pi Agent 对话上下文", 1800);
    } catch {
      // ignore
    }
  }

  applyAgentSnapshot(raw: unknown): void {
    const rec = asRec(raw);
    if (!rec) return;
    this.agentState = rec as unknown as UiPiAgentSnapshot;
    if (this.agentState.config) {
      this.voiceClient.updateConfig(this.agentState.config);
    }
    this.renderAll();
  }

  applyVoiceSnapshot(raw: unknown): void {
    const rec = asRec(raw);
    if (!rec) return;
    this.voiceState = rec as unknown as UiVoiceSnapshot;
    this.renderTitleButtons();
    this.renderVoiceStrip();
    this.renderLivePill();
  }

  handleStreamEvent(raw: unknown): void {
    const ev = asRec(raw);
    if (!ev || !this.agentState) return;
    const kind = String(ev.kind ?? "");
    const entryId = String(ev.entryId ?? "");
    if (!entryId) return;

    if (kind === "text_delta" && typeof ev.text === "string") {
      const target = this.agentState.timeline.find((e) => e.id === entryId);
      if (target) {
        target.text = ev.text;
        const textNode = document.querySelector<HTMLElement>(`[data-agent-msg-text="${CSS.escape(entryId)}"]`);
        if (textNode) {
          textNode.textContent = ev.text;
          this.scrollTimelineToBottom();
          return;
        }
      }
      this.renderTimeline();
    }
  }

  handleSpeakEvent(text: string): void {
    if (this.localClientState.active || this.agentState?.config.autoSpeakReply) {
      this.voiceClient.speak(text);
    }
  }

  private effectiveMode(): ClientVoiceMode {
    if (this.agentState?.running || this.voiceState?.mode === "processing") return "processing";
    if (this.localClientState.active) {
      if (this.voiceState?.mode === "awake") return "awake";
      return this.localClientState.mode;
    }
    if (this.voiceState?.mode === "awake") return "awake";
    if (this.localClientState.error) return "error";
    return "idle";
  }

  private renderAll(): void {
    this.renderTitleButtons();
    this.renderHeader();
    this.renderVoiceStrip();
    this.renderTimeline();
    this.renderComposer();
    this.renderLivePill();
  }

  private renderTitleButtons(): void {
    const voiceBtn = node<HTMLButtonElement>("voice-listen-toggle-btn");
    const voiceLabel = node("voice-listen-label");
    const mode = this.effectiveMode();
    const active = this.localClientState.active || mode === "awake" || mode === "processing";

    voiceBtn.classList.toggle("active", active);
    voiceBtn.classList.toggle("is-listening", this.localClientState.active && mode === "listening");
    voiceBtn.classList.toggle("is-awake", mode === "awake");
    voiceBtn.classList.toggle("is-processing", mode === "processing");
    voiceBtn.setAttribute("aria-pressed", String(this.localClientState.active));

    if (mode === "processing") {
      voiceLabel.textContent = "执行中…";
    } else if (mode === "awake") {
      voiceLabel.textContent = this.localClientState.oneShot ? "请说话…" : "已唤醒";
    } else if (mode === "speaking") {
      voiceLabel.textContent = "播报中";
    } else if (this.localClientState.active) {
      voiceLabel.textContent = "监听中";
    } else {
      voiceLabel.textContent = "语音监听";
    }

    const agentBtn = node<HTMLButtonElement>("pi-agent-toggle-btn");
    agentBtn.classList.toggle("active", this.open);
    agentBtn.classList.toggle("is-running", Boolean(this.agentState?.running));
    agentBtn.setAttribute("aria-expanded", String(this.open));
  }

  private renderHeader(): void {
    const badge = node("pi-agent-engine-badge");
    if (!this.agentState) {
      badge.textContent = "内置本地引擎";
      return;
    }
    const shortProvider =
      this.agentState.provider === "local"
        ? "内置本地引擎"
        : `${this.agentState.providerLabel.split("（")[0]} · ${this.agentState.modelId}`;
    badge.textContent = shortProvider;
    badge.title = `当前引擎：${this.agentState.providerLabel} (${this.agentState.modelId})，点击前往设置`;
  }

  private renderVoiceStrip(): void {
    const strip = node("pi-voice-strip");
    const statusEl = node("pi-voice-status-text");
    const subEl = node("pi-voice-sub-text");
    const startBtn = node<HTMLButtonElement>("pi-voice-start-btn");
    const oneShotBtn = node<HTMLButtonElement>("pi-voice-oneshot-btn");
    const wakeBtn = node<HTMLButtonElement>("pi-voice-wake-toggle-btn");

    const mode = this.effectiveMode();
    const isListening = this.localClientState.active;
    const wakeEnabled = this.agentState?.config.wakeWordEnabled ?? true;
    const wakeWords = this.agentState?.config.wakeWords ?? ["小派", "pi"];
    const firstWake = wakeWords[0] ?? "小派";

    strip.classList.toggle("is-active", isListening || mode === "awake" || mode === "processing");
    strip.classList.toggle("is-awake", mode === "awake");
    strip.classList.toggle("is-error", mode === "error");

    startBtn.textContent = isListening ? "停止监听" : "开启持续监听";
    startBtn.classList.toggle("primary-button", !isListening);
    startBtn.classList.toggle("secondary-button", isListening);

    oneShotBtn.classList.toggle("active", this.localClientState.oneShot);
    oneShotBtn.textContent = this.localClientState.oneShot ? "正在聆听…" : "单次说话";

    wakeBtn.textContent = wakeEnabled ? `唤醒词：${firstWake}` : "免唤醒直达";
    wakeBtn.classList.toggle("active", wakeEnabled);
    wakeBtn.title = wakeEnabled
      ? `当前唤醒词：${wakeWords.join("、")}（点击切换免唤醒模式）`
      : "当前监听到的每句话都将直接交给 Pi Agent（点击开启唤醒词）";

    const interim = this.localClientState.interimTranscript || this.voiceState?.interimTranscript || "";
    const err = this.localClientState.error || this.voiceState?.error || "";

    if (err) {
      statusEl.textContent = "语音监听未就绪";
      subEl.textContent = err;
    } else if (mode === "processing") {
      statusEl.textContent = "Pi Agent 正在控制设备…";
      subEl.textContent = this.voiceState?.lastCommand
        ? `指令：“${this.voiceState.lastCommand}”`
        : "正在调度智能家居工具…";
    } else if (mode === "awake") {
      statusEl.textContent = this.localClientState.oneShot ? "请直接说出设备指令" : "已唤醒，请说控制指令";
      subEl.textContent = interim ? `实时识别：${interim}` : "例如：“把客厅吸顶灯亮度调到 80%”";
    } else if (mode === "speaking") {
      statusEl.textContent = "正在语音播报执行结果…";
      subEl.textContent = "播报期间自动静音防回声";
    } else if (isListening) {
      const engineLabel = this.localClientState.engine === "whisper" ? "Whisper VAD" : "浏览器实时识别";
      statusEl.textContent = `语音监听运行中 · ${engineLabel}`;
      subEl.textContent = interim
        ? `实时识别：${interim}`
        : wakeEnabled
          ? `说出“${firstWake}，打开客厅吸顶灯”即可控制设备`
          : "免唤醒已开启，直接说出设备控制指令即可执行";
    } else {
      statusEl.textContent = "语音监听待机中";
      subEl.textContent = wakeEnabled
        ? `点击「开启持续监听」或按 Alt+V 单次说话（唤醒词：${wakeWords.slice(0, 3).join(" / ")}）`
        : "点击「开启持续监听」或按 Alt+V 即可语音操控 Pi Agent";
    }
  }

  private renderTimeline(): void {
    const list = node("pi-agent-timeline");
    const emptyBox = node("pi-agent-empty");
    const entries = this.agentState?.timeline ?? [];

    if (entries.length === 0) {
      list.replaceChildren();
      emptyBox.hidden = false;
      return;
    }

    emptyBox.hidden = true;
    list.replaceChildren();

    for (const entry of entries) {
      const item = document.createElement("div");
      item.className = `pi-msg pi-msg-${entry.role}${entry.status === "error" ? " is-error" : ""}`;

      const meta = document.createElement("div");
      meta.className = "pi-msg-meta";
      const roleSpan = document.createElement("span");
      roleSpan.className = "pi-msg-role";
      if (entry.role === "user") {
        roleSpan.textContent = entry.source === "voice" ? "🎤 语音指令" : "⌨ 文字指令";
      } else {
        roleSpan.textContent = "π Pi Agent";
      }
      const timeSpan = document.createElement("span");
      timeSpan.className = "pi-msg-time";
      timeSpan.textContent = formatTime(entry.timestamp);
      meta.append(roleSpan, timeSpan);
      item.appendChild(meta);

      // Tool calls list (for assistant messages)
      if (entry.toolCalls.length > 0) {
        const toolsWrap = document.createElement("div");
        toolsWrap.className = "pi-tool-list";
        for (const tc of entry.toolCalls) {
          const card = document.createElement("div");
          card.className = `pi-tool-card is-${tc.status}`;

          const head = document.createElement("div");
          head.className = "pi-tool-head";
          const icon = document.createElement("span");
          icon.className = "pi-tool-badge";
          icon.textContent = tc.status === "running" ? "…" : tc.status === "error" ? "✕" : "✓";

          const title = document.createElement("span");
          title.className = "pi-tool-name";
          title.textContent = tc.label || tc.name;

          const dur = document.createElement("span");
          dur.className = "pi-tool-dur";
          dur.textContent =
            tc.status === "running"
              ? "执行中"
              : typeof tc.durationMs === "number"
                ? `${Math.max(1, Math.round(tc.durationMs))}ms`
                : "完成";

          head.append(icon, title, dur);
          card.appendChild(head);

          const argsPreview = formatArgsPreview(tc.args);
          if (argsPreview) {
            const argsEl = document.createElement("div");
            argsEl.className = "pi-tool-args";
            argsEl.textContent = argsPreview;
            card.appendChild(argsEl);
          }

          if (tc.summary) {
            const sumEl = document.createElement("div");
            sumEl.className = "pi-tool-summary";
            sumEl.textContent = tc.summary;
            card.appendChild(sumEl);
          }

          toolsWrap.appendChild(card);
        }
        item.appendChild(toolsWrap);
      }

      const bubble = document.createElement("div");
      bubble.className = "pi-msg-bubble";
      bubble.dataset.agentMsgText = entry.id;
      bubble.textContent =
        entry.text || (entry.status === "streaming" ? "正在思考并操作设备…" : "");
      item.appendChild(bubble);

      list.appendChild(item);
    }

    this.scrollTimelineToBottom();
  }

  private renderQuickChips(): void {
    const wrap = node("pi-quick-chips");
    wrap.replaceChildren();
    for (const prompt of QUICK_SUGGESTIONS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "pi-quick-chip";
      btn.textContent = prompt;
      btn.addEventListener("click", () => {
        void this.sendTextPrompt(prompt);
      });
      wrap.appendChild(btn);
    }
  }

  private renderComposer(): void {
    const running = Boolean(this.agentState?.running);
    const btn = node<HTMLButtonElement>("pi-agent-send-btn");
    btn.textContent = running ? "停止" : "发送";
    btn.classList.toggle("danger-button", running);
    btn.classList.toggle("primary-button", !running);
  }

  private updateWaveformBars(): void {
    const bars = document.querySelectorAll<HTMLElement>("#pi-voice-wave .pi-wave-bar");
    if (bars.length === 0) return;
    const active = this.localClientState.active;
    const weights = [0.55, 0.9, 1.0, 0.85, 0.6];
    bars.forEach((bar, i) => {
      const w = weights[i % weights.length] ?? 0.7;
      const pct = active ? Math.max(18, Math.min(100, Math.round((this.audioLevel * w + 0.14) * 100))) : 16;
      bar.style.height = `${pct}%`;
    });
  }

  private renderLivePill(): void {
    const pill = node("voice-live-pill");
    const textEl = node("voice-live-pill-text");
    const interim = this.localClientState.interimTranscript || this.voiceState?.interimTranscript || "";
    const mode = this.effectiveMode();

    if (this.livePillHideTimer !== null) {
      return; // 正在展示临时执行结果反馈
    }

    if (!this.open && (interim || mode === "awake" || mode === "processing")) {
      pill.hidden = false;
      pill.classList.toggle("is-awake", mode === "awake");
      pill.classList.toggle("is-processing", mode === "processing");
      if (interim) {
        textEl.textContent = `🎤 ${interim}`;
      } else if (mode === "awake") {
        textEl.textContent = "🎤 已唤醒，请说控制指令…";
      } else {
        textEl.textContent = `π Pi Agent 正在执行：${this.voiceState?.lastCommand || "设备控制…"}`;
      }
    } else {
      pill.hidden = true;
    }
  }

  private flashLivePill(message: string, durationMs = 3500): void {
    if (this.open) return;
    const pill = node("voice-live-pill");
    const textEl = node("voice-live-pill-text");
    textEl.textContent = message;
    pill.hidden = false;
    pill.classList.remove("is-awake", "is-processing");
    if (this.livePillHideTimer !== null) {
      window.clearTimeout(this.livePillHideTimer);
    }
    this.livePillHideTimer = window.setTimeout(() => {
      this.livePillHideTimer = null;
      this.renderLivePill();
    }, durationMs);
  }

  private scrollTimelineToBottom(): void {
    const scroll = node("pi-agent-scroll");
    scroll.scrollTop = scroll.scrollHeight;
  }
}
