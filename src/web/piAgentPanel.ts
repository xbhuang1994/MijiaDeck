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

export type UiSystemOneMode = "auto" | "on" | "off";
export type UiCavemanMode = "ultra" | "full" | "lite" | "off";

export interface UiWakeWordPrototypeSummary {
  wakeWord: string;
  enrolledCount: number;
  ttsCount: number;
  totalCount: number;
  sampleIds: string[];
  enrolledIds: string[];
  updatedAt: number | null;
}

export interface UiSystemOneHealth {
  enabled: boolean;
  model: string;
  endpointHost: string;
  circuitState: "closed" | "open" | "half-open";
  openReason: string | null;
  lastLatencyMs: number | null;
  totalCalls: number;
  cacheHits: number;
}

export interface UiWakeWordHit {
  wakeWord: string;
  score: number;
  threshold: number;
  source: "enrolled" | "tts-bootstrap" | "asr";
  timestamp: number;
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
  systemOneMode?: UiSystemOneMode;
  systemOneBaseUrl?: string;
  systemOneModel?: string;
  systemOneTimeoutMs?: number;
  systemOneConfidenceThreshold?: number;
  hasSystemOneApiKey?: boolean;
  systemOneApiKeyPreview?: string;
  effectiveSystemOneBaseUrl?: string;
  effectiveSystemOneConfigured?: boolean;
  cavemanMode?: UiCavemanMode;
  owwEnabled?: boolean;
  owwThreshold?: number;
  maxConsecutiveSidetalk?: number;
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

export interface UiLocalVoiceStatus {
  addonAvailable: boolean;
  readyForDenoise: boolean;
  readyForDpdfnet?: boolean;
  readyForVoxlock?: boolean;
  readyForVad: boolean;
  readyForVoiceprint: boolean;
  readyForLocalAsr: boolean;
  readyForWakeWord?: boolean;
  readyForLocalTts?: boolean;
  tts?: {
    addonAvailable: boolean;
    ready: boolean;
    readyVoices: Array<"gentle-zh-en" | "warm-zh-baker">;
    activeVoice: "gentle-zh-en" | "warm-zh-baker" | null;
    models?: {
      matchaZhEn: boolean;
      vocos16k: boolean;
      matchaZhBaker: boolean;
      vocos22k: boolean;
    };
  };
  downloading?: boolean;
  models?: {
    gtcrn: boolean;
    dpdfnet4?: boolean;
    voxlock?: boolean;
    sileroVad: boolean;
    speakerCampp: boolean;
    senseVoice: boolean;
    openWakeWord?: boolean;
    localTts?: boolean;
  };
}

export interface UiVoiceprintProfile {
  id: string;
  name: string;
  role: "owner" | "member";
  engine: string;
  dim: number;
  sampleCount: number;
}

export interface UiVoiceSnapshot {
  active: boolean;
  mode: ClientVoiceMode;
  engine: "local" | "browser" | "whisper" | "manual";
  interimTranscript: string;
  lastTranscript: string;
  lastCommand: string;
  awakeUntil: number | null;
  conversationUntil?: number | null;
  dialogState?: "standby" | "conversation";
  conversationWindowSec?: number;
  conversationRemainingMs?: number;
  serverNow?: number;
  timerPaused?: boolean;
  consecutiveSidetalkCount?: number;
  maxConsecutiveSidetalk?: number;
  lastTransitionReason?: string | null;
  cavemanMode?: UiCavemanMode;
  systemOneHealth?: UiSystemOneHealth | null;
  owwEnabled?: boolean;
  owwThreshold?: number;
  wakeWordPrototypes?: UiWakeWordPrototypeSummary[];
  lastWakeHit?: UiWakeWordHit | null;
  error: string | null;
  wakeWordEnabled: boolean;
  wakeWords: string[];
  wakeAckPhrase?: string;
  autoSpeakReply: boolean;
  ttsEngine?: "auto" | "local" | "browser";
  ttsVoice?: "gentle-zh-en" | "warm-zh-baker";
  ttsSpeed?: number;
  attentionMode?: "smart" | "strict" | "off";
  noiseSuppressionMode?: "auto" | "neural" | "dpdfnet" | "voxlock" | "dsp" | "off";
  voiceprintMode?: "off" | "tag" | "strict";
  localEngine?: UiLocalVoiceStatus;
  voiceprints?: UiVoiceprintProfile[];
  lastMetrics?: {
    denoiseEngine?: string;
    snrGainDb?: number;
    vadEngine?: string;
    asrEngine?: string;
    voiceprint?: {
      evaluated?: boolean;
      matched?: boolean;
      speakerName?: string | null;
      score?: number;
    } | null;
    attention?: {
      accept?: boolean;
      stage?: string;
      reason?: string;
      usedLlm?: boolean;
    } | null;
    timings?: {
      totalMs?: number;
      asrMs?: number;
      denoiseMs?: number;
      attentionMs?: number;
    } | null;
  } | null;
}

export interface PiAgentPanelDeps {
  apiGet: <T>(url: string) => Promise<T>;
  apiPost: <T>(url: string, body?: unknown) => Promise<T>;
  isWsOpen?: () => boolean;
  sendWsJson?: (payload: Record<string, unknown>) => boolean;
  sendWsBinary?: (buffer: ArrayBuffer) => boolean;
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

const CAVEMAN_CYCLE_ORDER: ReadonlyArray<UiCavemanMode> = ["lite", "full", "ultra", "off"];
const CAVEMAN_LABELS: Readonly<Record<UiCavemanMode, string>> = {
  lite: "自然 · Lite",
  full: "简短 · Full",
  ultra: "极简 · Ultra",
  off: "温暖对话",
};

function normalizeUiCavemanMode(raw: unknown): UiCavemanMode {
  return raw === "ultra" || raw === "full" || raw === "lite" || raw === "off" ? raw : "lite";
}

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
    engine: "local" | "browser" | "whisper";
    interimTranscript: string;
    error: string | null;
    oneShot: boolean;
  } = {
    active: false,
    mode: "idle",
    engine: "local",
    interimTranscript: "",
    error: null,
    oneShot: false,
  };
  private audioLevel = 0;
  private livePillHideTimer: number | null = null;
  private serverClockOffsetMs = 0;
  private conversationDeadlineServerMs: number | null = null;
  private frozenRemainingMs: number | null = null;
  private dialogTimerInterval: number | null = null;
  private wakeFlashTimer: number | null = null;
  private lastSyncPromise: Promise<unknown> = Promise.resolve();
  private readonly voiceClient: VoiceListenerClient;

  constructor(private readonly deps: PiAgentPanelDeps) {
    this.voiceClient = new VoiceListenerClient({
      onStatusChange: (status) => {
        this.localClientState = status;
        this.syncDialogTimer();
        this.renderTitleButtons();
        this.renderVoiceStrip();
        this.renderLivePill();
      },
      onLevelChange: (level) => {
        this.audioLevel = level;
        this.updateWaveformBars();
      },
      onSyncServerState: (patch) => {
        this.lastSyncPromise = this.deps
          .apiPost("/api/voice-listen/state", patch)
          .catch(() => {});
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
            this.flashLivePill(
              res.reply ? `已唤醒「${res.reply}」` : "已唤醒，静默持续监听中…",
              4000,
            );
          } else if (res.matched && res.reply) {
            this.flashLivePill(`π ${res.reply}`, 4200);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.deps.showToast(`语音指令执行失败：${msg}`, 3500);
        }
      },
      onUploadAudio: async (blob, opts) => {
        const form = new FormData();
        form.append("audio", blob, opts.filename || "voice.wav");
        form.append("lang", opts.lang);
        form.append("engine", opts.engine);
        form.append("bypassWakeWord", String(opts.bypassWakeWord));
        form.append("autoDispatch", "true");
        const response = await fetch("/api/voice/audio", {
          method: "POST",
          body: form,
        });
        const data = (await response.json()) as {
          ok?: boolean;
          error?: string;
          text?: string;
          matched?: boolean;
          wokeOnly?: boolean;
          reply?: string;
          attention?: { accept?: boolean; reason?: string; stage?: string };
          agent?: UiPiAgentSnapshot;
          voiceState?: UiVoiceSnapshot;
        };
        if (!response.ok || data.ok === false) {
          throw new Error(data.error || `识别请求失败 (${response.status})`);
        }
        if (data.agent) this.applyAgentSnapshot(data.agent);
        if (data.voiceState) this.applyVoiceSnapshot(data.voiceState);
        if (data.matched && data.wokeOnly) {
          this.flashLivePill(
            data.reply ? `已唤醒「${data.reply}」` : "已唤醒，静默持续监听中…",
            4000,
          );
        } else if (data.matched && data.reply) {
          this.flashLivePill(`π ${data.reply}`, 4200);
        } else if (
          data.text &&
          data.attention &&
          data.attention.accept === false &&
          (data.attention.stage === "llm-attention" ||
            data.attention.stage === "systemone-attention" ||
            data.attention.stage === "acoustic-veto" ||
            data.attention.stage === "exit" ||
            data.attention.stage === "pragmatic-reject" ||
            data.attention.stage === "voiceprint")
        ) {
          this.flashLivePill(
            data.attention.stage === "exit"
              ? "已退出对话模式，回到待机"
              : `已忽略：${data.attention.reason || "非定向呼唤"}`,
            2800,
          );
        }
      },
      isVoiceStreamReady: () => Boolean(this.deps.isWsOpen?.()),
      sendVoiceStreamControl: (msg) => Boolean(this.deps.sendWsJson?.(msg)),
      sendVoiceStreamPcm: (buf) => Boolean(this.deps.sendWsBinary?.(buf)),
      onToast: (msg, ms) => this.deps.showToast(msg, ms),
    });
  }

  handleVoiceStreamEvent(raw: unknown): void {
    const ev = asRec(raw);
    if (!ev) return;
    const kind = String(ev.kind ?? "");
    const text = typeof ev.text === "string" ? ev.text : "";
    const matched = ev.matched === true;
    const wokeOnly = ev.wokeOnly === true;
    const reply = typeof ev.reply === "string" ? ev.reply : "";
    const attention = asRec(ev.attention);

    if (kind === "wake_spot") {
      const wakeWord = typeof ev.wakeWord === "string" ? ev.wakeWord.trim() : "";
      const score = typeof ev.score === "number" && Number.isFinite(ev.score) ? ev.score : undefined;
      const threshold =
        typeof ev.threshold === "number" && Number.isFinite(ev.threshold) ? ev.threshold : undefined;
      const source = typeof ev.source === "string" ? ev.source : undefined;

      this.voiceClient.handleStreamServerEvent({ kind, wakeWord, score, threshold, source });

      if (ev.voiceState) {
        this.applyVoiceSnapshot(ev.voiceState);
      } else if (wakeWord && typeof score === "number") {
        const hitSource: UiWakeWordHit["source"] =
          source === "enrolled" || source === "tts-bootstrap" || source === "asr"
            ? source
            : "enrolled";
        if (this.voiceState) {
          this.voiceState = {
            ...this.voiceState,
            lastWakeHit: {
              wakeWord,
              score,
              threshold: threshold ?? this.voiceState.owwThreshold ?? 0.6,
              source: hitSource,
              timestamp: Date.now(),
            },
          };
        }
      }

      this.triggerWakeSpotGlow();
      const pillText = wakeWord ? `⚡ 已唤醒「${wakeWord}」` : "⚡ 已唤醒";
      this.flashLivePill(pillText, 2600, true);
      this.renderTitleButtons();
      this.renderVoiceStrip();
      return;
    }

    this.voiceClient.handleStreamServerEvent({ kind, text, matched });

    if (kind === "result") {
      if (ev.agent) this.applyAgentSnapshot(ev.agent);
      if (ev.voiceState) this.applyVoiceSnapshot(ev.voiceState);
      if (matched && wokeOnly) {
        this.flashLivePill(
          reply ? `已唤醒「${reply}」` : "已唤醒，静默持续监听中…",
          4000,
        );
      } else if (matched && reply) {
        this.flashLivePill(`π ${reply}`, 4200);
      } else if (
        text &&
        attention &&
        attention.accept === false &&
        (attention.stage === "llm-attention" ||
          attention.stage === "systemone-attention" ||
          attention.stage === "acoustic-veto" ||
          attention.stage === "exit" ||
          attention.stage === "pragmatic-reject" ||
          attention.stage === "voiceprint")
      ) {
        this.flashLivePill(
          attention.stage === "exit"
            ? "已退出对话模式，回到待机"
            : `已忽略：${typeof attention.reason === "string" ? attention.reason : "非定向呼唤"}`,
          2800,
        );
      }
    }
  }

  bindEvents(): void {
    node("voice-listen-toggle-btn").addEventListener("click", () => {
      void this.toggleVoiceListening();
    });

    const titleDialogBtn = document.getElementById("voice-dialog-badge-btn");
    titleDialogBtn?.addEventListener("click", () => {
      void this.toggleDialogMode();
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

    const dialogModeBtn = document.getElementById("pi-dialog-mode-btn");
    dialogModeBtn?.addEventListener("click", () => {
      void this.toggleDialogMode();
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

    const cavemanBtn = document.getElementById("pi-caveman-toggle-btn");
    cavemanBtn?.addEventListener("click", () => {
      void this.cycleCavemanMode();
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
    this.renderLivePill();
  }

  async toggleVoiceListening(): Promise<void> {
    await this.voiceClient.toggle();
  }

  async toggleDialogMode(forcedAction?: "enter" | "exit" | "toggle"): Promise<void> {
    const current = this.effectiveDialogState();
    const action: "enter" | "exit" =
      forcedAction === "enter" || forcedAction === "exit"
        ? forcedAction
        : current === "conversation"
          ? "exit"
          : "enter";

    if (action === "enter" && !this.localClientState.active) {
      await this.voiceClient.start({ oneShot: false });
      if (!this.voiceClient.isActive()) {
        return;
      }
      await this.lastSyncPromise;
    }

    if (action === "exit") {
      this.voiceClient.cancelSpeaking();
    }

    const sentWs = Boolean(
      this.deps.isWsOpen?.() &&
        this.deps.sendWsJson?.({ type: "voice_dialog_control", action }),
    );
    if (!sentWs) {
      try {
        const res = await this.deps.apiPost<{ ok?: boolean; voice?: UiVoiceSnapshot }>(
          "/api/voice-listen/dialog",
          { action },
        );
        if (res.voice) this.applyVoiceSnapshot(res.voice);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.deps.showToast(`切换对话模式失败：${msg}`, 3000);
      }
    }
  }

  async cycleCavemanMode(): Promise<void> {
    const current = this.currentCavemanMode();
    const idx = CAVEMAN_CYCLE_ORDER.indexOf(current);
    const next = CAVEMAN_CYCLE_ORDER[(idx + 1) % CAVEMAN_CYCLE_ORDER.length] ?? "lite";
    try {
      const res = await this.deps.apiPost<{
        agent?: UiPiAgentSnapshot;
        voice?: UiVoiceSnapshot;
      }>("/api/agent/config", { cavemanMode: next });
      if (res.agent) this.applyAgentSnapshot(res.agent);
      if (res.voice) this.applyVoiceSnapshot(res.voice);
      this.deps.showToast(`回复风格已切换：${CAVEMAN_LABELS[next]}`, 2000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.deps.showToast(`切换回复风格失败：${msg}`, 3000);
    }
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
      this.voiceClient.updateConfig({
        ...this.agentState.config,
        localAsrReady: Boolean(this.voiceState?.localEngine?.readyForLocalAsr),
        localTtsReady: this.voiceState?.localEngine?.readyForLocalTts,
      });
    }
    this.renderAll();
  }

  applyVoiceSnapshot(raw: unknown): void {
    const rec = asRec(raw);
    if (!rec) return;
    const vs = rec as unknown as UiVoiceSnapshot;
    this.voiceState = vs;

    if (typeof vs.serverNow === "number" && Number.isFinite(vs.serverNow)) {
      this.serverClockOffsetMs = vs.serverNow - Date.now();
    }
    const anchorServerNow =
      typeof vs.serverNow === "number" && Number.isFinite(vs.serverNow)
        ? vs.serverNow
        : Date.now() + this.serverClockOffsetMs;
    if (typeof vs.conversationRemainingMs === "number" && Number.isFinite(vs.conversationRemainingMs)) {
      this.frozenRemainingMs = Math.max(0, vs.conversationRemainingMs);
      this.conversationDeadlineServerMs = anchorServerNow + this.frozenRemainingMs;
    } else if (typeof vs.conversationUntil === "number" && Number.isFinite(vs.conversationUntil)) {
      this.conversationDeadlineServerMs = vs.conversationUntil;
      this.frozenRemainingMs = Math.max(0, vs.conversationUntil - anchorServerNow);
    } else {
      this.conversationDeadlineServerMs = null;
      this.frozenRemainingMs = null;
    }

    if (this.voiceState.localEngine) {
      this.voiceClient.updateConfig({
        localAsrReady: Boolean(this.voiceState.localEngine.readyForLocalAsr),
        localTtsReady: Boolean(this.voiceState.localEngine.readyForLocalTts),
      });
    }
    this.syncDialogTimer();
    this.renderTitleButtons();
    this.renderVoiceStrip();
    this.renderLivePill();
  }

  previewVoice(
    text: string,
    overrides?: {
      ttsEngine?: "auto" | "local" | "browser";
      ttsVoice?: "gentle-zh-en" | "warm-zh-baker";
      ttsSpeed?: number;
    },
  ): void {
    this.voiceClient.previewVoice(text, overrides);
  }

  getVoiceSnapshot(): UiVoiceSnapshot | null {
    return this.voiceState;
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

  handleSpeakChunkEvent(text: string): void {
    if (this.localClientState.active || this.agentState?.config.autoSpeakReply) {
      this.voiceClient.enqueueSpeakChunk(text);
    }
  }

  private effectiveMode(): ClientVoiceMode {
    if (this.agentState?.running || this.voiceState?.mode === "processing") return "processing";
    if (this.localClientState.active) {
      if (this.localClientState.mode === "speaking") return "speaking";
      if (this.voiceState?.mode === "awake") return "awake";
      return this.localClientState.mode;
    }
    if (this.voiceState?.mode === "awake") return "awake";
    if (this.localClientState.error) return "error";
    return "idle";
  }

  private currentCavemanMode(): UiCavemanMode {
    const raw = this.agentState?.config.cavemanMode ?? this.voiceState?.cavemanMode;
    return normalizeUiCavemanMode(raw);
  }

  private isWakeWordEnabled(): boolean {
    if (typeof this.agentState?.config.wakeWordEnabled === "boolean") {
      return this.agentState.config.wakeWordEnabled;
    }
    if (typeof this.voiceState?.wakeWordEnabled === "boolean") {
      return this.voiceState.wakeWordEnabled;
    }
    return true;
  }

  private getConversationWindowSec(): number {
    const raw =
      this.voiceState?.conversationWindowSec ?? this.agentState?.config.conversationWindowSec ?? 25;
    return Number.isFinite(raw) ? Math.max(0, Math.round(raw)) : 25;
  }

  private effectiveDialogState(): "standby" | "conversation" {
    if (this.voiceState?.dialogState === "conversation") return "conversation";
    if (this.voiceState?.dialogState === "standby") return "standby";
    // 向后兼容未下发 dialogState 的旧快照
    if (this.voiceState?.mode === "awake") return "conversation";
    if (
      typeof this.conversationDeadlineServerMs === "number" &&
      this.conversationDeadlineServerMs > Date.now() + this.serverClockOffsetMs
    ) {
      return "conversation";
    }
    return "standby";
  }

  private isDialogTimerPaused(): boolean {
    if (this.voiceState?.timerPaused === true) return true;
    const mode = this.effectiveMode();
    return mode === "processing" || mode === "speaking" || Boolean(this.agentState?.running);
  }

  private getRemainingDialogMs(): number {
    if (this.effectiveDialogState() !== "conversation") return 0;
    const windowMs = this.getConversationWindowSec() * 1000;
    if (windowMs <= 0) return 0;
    if (this.isDialogTimerPaused()) {
      return this.frozenRemainingMs !== null ? Math.max(0, this.frozenRemainingMs) : windowMs;
    }
    if (this.conversationDeadlineServerMs !== null) {
      const estServerNow = Date.now() + this.serverClockOffsetMs;
      return Math.max(0, this.conversationDeadlineServerMs - estServerNow);
    }
    if (this.frozenRemainingMs !== null) {
      return Math.max(0, this.frozenRemainingMs);
    }
    return windowMs;
  }

  private getRemainingDialogSec(): number {
    return Math.max(0, Math.ceil(this.getRemainingDialogMs() / 1000));
  }

  private syncDialogTimer(): void {
    const shouldTick =
      this.effectiveDialogState() === "conversation" &&
      !this.isDialogTimerPaused() &&
      this.isWakeWordEnabled() &&
      this.getConversationWindowSec() > 0;

    if (shouldTick) {
      if (this.dialogTimerInterval === null) {
        this.dialogTimerInterval = window.setInterval(() => {
          this.updateCountdownElements();
        }, 250);
      }
    } else if (this.dialogTimerInterval !== null) {
      window.clearInterval(this.dialogTimerInterval);
      this.dialogTimerInterval = null;
    }
  }

  private formatTitleDialogBadgeLabel(): string {
    const dialogState = this.effectiveDialogState();
    const mode = this.effectiveMode();
    if (dialogState !== "conversation") {
      return "待唤醒";
    }
    if (mode === "speaking") {
      return "对话中 · 播报";
    }
    if (this.isDialogTimerPaused()) {
      return "对话中 · 执行";
    }
    if (!this.isWakeWordEnabled() || this.getConversationWindowSec() === 0) {
      return "对话中";
    }
    return `对话中 · ${this.getRemainingDialogSec()}s`;
  }

  private formatBannerStateLabel(): string {
    const isListening = this.localClientState.active;
    const dialogState = this.effectiveDialogState();
    const wakeEnabled = this.isWakeWordEnabled();
    const mode = this.effectiveMode();

    if (!isListening && dialogState !== "conversation") {
      return "非对话模式 · 未开启监听";
    }
    if (!wakeEnabled) {
      return "免唤醒直达 · 持续对话";
    }
    if (dialogState !== "conversation") {
      return "非对话模式 · 等待唤醒";
    }
    if (mode === "speaking") {
      return "对话模式 · 播报中";
    }
    if (this.isDialogTimerPaused()) {
      return "对话模式 · 执行中";
    }
    const windowSec = this.getConversationWindowSec();
    if (windowSec === 0) {
      return "免唤醒直达 · 持续对话";
    }
    return `对话模式 · 剩余 ${this.getRemainingDialogSec()}s`;
  }

  private formatLivePillConversationText(): string {
    const mode = this.effectiveMode();
    if (mode === "speaking") return "对话模式 · 播报中";
    if (this.isDialogTimerPaused()) return "对话模式 · 执行中";
    if (!this.isWakeWordEnabled() || this.getConversationWindowSec() === 0) {
      return "免唤醒直达 · 持续对话";
    }
    return `对话模式 · 剩余 ${this.getRemainingDialogSec()}s`;
  }

  private updateCountdownElements(): void {
    const dialogState = this.effectiveDialogState();
    if (dialogState !== "conversation") {
      this.syncDialogTimer();
      return;
    }

    const titleLabel = document.getElementById("voice-dialog-badge-label");
    if (titleLabel) {
      titleLabel.textContent = this.formatTitleDialogBadgeLabel();
    }

    const bannerBadge = document.getElementById("pi-dialog-state-badge");
    if (bannerBadge) {
      bannerBadge.textContent = this.formatBannerStateLabel();
    }

    const fill = document.getElementById("pi-dialog-timer-fill");
    const windowMs = Math.max(1000, this.getConversationWindowSec() * 1000);
    const remMs = this.getRemainingDialogMs();
    if (fill) {
      const pct = Math.max(0, Math.min(100, (remMs / windowMs) * 100));
      fill.style.width = `${pct.toFixed(1)}%`;
      fill.classList.toggle("is-urgent", !this.isDialogTimerPaused() && remMs > 0 && remMs <= 5000);
    }

    if (!this.open && this.livePillHideTimer === null) {
      const pill = document.getElementById("voice-live-pill");
      const pillText = document.getElementById("voice-live-pill-text");
      if (pill && !pill.hidden && pill.classList.contains("is-conversation") && pillText) {
        pillText.textContent = this.formatLivePillConversationText();
      }
    }
  }

  private triggerWakeSpotGlow(): void {
    const strip = document.getElementById("pi-voice-strip");
    const badge = document.getElementById("voice-dialog-badge-btn");
    strip?.classList.add("is-wake-flash");
    badge?.classList.add("is-wake-flash");
    if (this.wakeFlashTimer !== null) {
      window.clearTimeout(this.wakeFlashTimer);
    }
    this.wakeFlashTimer = window.setTimeout(() => {
      this.wakeFlashTimer = null;
      strip?.classList.remove("is-wake-flash");
      badge?.classList.remove("is-wake-flash");
    }, 1350);
  }

  private renderAll(): void {
    this.syncDialogTimer();
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
    const dialogState = this.effectiveDialogState();
    const isConv = dialogState === "conversation";
    const active = this.localClientState.active || mode === "awake" || mode === "processing" || isConv;

    voiceBtn.classList.toggle("active", active);
    voiceBtn.classList.toggle("is-listening", this.localClientState.active && mode === "listening");
    voiceBtn.classList.toggle("is-awake", mode === "awake" || isConv);
    voiceBtn.classList.toggle("is-processing", mode === "processing");
    voiceBtn.setAttribute("aria-pressed", String(this.localClientState.active));

    if (mode === "processing") {
      voiceLabel.textContent = "执行中…";
    } else if (mode === "speaking") {
      voiceLabel.textContent = "播报中";
    } else if (mode === "awake" || isConv) {
      voiceLabel.textContent = this.localClientState.oneShot ? "请说话…" : "已唤醒";
    } else if (this.localClientState.active) {
      voiceLabel.textContent = "监听中";
    } else {
      voiceLabel.textContent = "语音监听";
    }

    const dialogBadge = document.getElementById("voice-dialog-badge-btn") as HTMLButtonElement | null;
    const dialogBadgeLabel = document.getElementById("voice-dialog-badge-label");
    if (dialogBadge && dialogBadgeLabel) {
      const hideBadge = !this.localClientState.active && mode === "idle" && !isConv;
      dialogBadge.hidden = hideBadge;
      dialogBadge.classList.toggle("is-conversation", isConv);
      dialogBadge.classList.toggle("is-standby", !isConv);
      dialogBadge.classList.toggle("is-paused", isConv && this.isDialogTimerPaused());
      dialogBadge.setAttribute("aria-pressed", String(isConv));
      dialogBadgeLabel.textContent = this.formatTitleDialogBadgeLabel();
      dialogBadge.title = isConv
        ? "当前处于对话模式，点击立即退回待唤醒（保持麦克风监听）"
        : "当前处于待唤醒模式，点击立即进入免唤醒对话模式";
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
    const cavemanBtn = document.getElementById("pi-caveman-toggle-btn") as HTMLButtonElement | null;

    const mode = this.effectiveMode();
    const isListening = this.localClientState.active;
    const dialogState = this.effectiveDialogState();
    const isConv = dialogState === "conversation";
    const paused = this.isDialogTimerPaused();
    const wakeEnabled = this.isWakeWordEnabled();
    const wakeWords = this.agentState?.config.wakeWords ?? this.voiceState?.wakeWords ?? ["小派", "pi"];
    const firstWake = wakeWords[0] ?? "小派";
    const windowSec = this.getConversationWindowSec();

    strip.classList.toggle("is-active", isListening || mode === "awake" || mode === "processing" || isConv);
    strip.classList.toggle("is-awake", mode === "awake" || isConv);
    strip.classList.toggle("is-conversation", isConv);
    strip.classList.toggle("is-error", mode === "error");

    // Dual-State Header Banner inside #pi-voice-strip
    const banner = document.getElementById("pi-dialog-banner");
    const stateBadge = document.getElementById("pi-dialog-state-badge");
    const modeBtn = document.getElementById("pi-dialog-mode-btn") as HTMLButtonElement | null;
    const timerTrack = document.getElementById("pi-dialog-timer-track");
    const timerFill = document.getElementById("pi-dialog-timer-fill");

    if (banner) {
      banner.classList.toggle("is-conversation", isConv);
      banner.classList.toggle("is-standby", !isConv);
      banner.classList.toggle("is-paused", isConv && paused);
    }
    if (stateBadge) {
      stateBadge.textContent = this.formatBannerStateLabel();
    }
    if (modeBtn) {
      modeBtn.textContent = isConv ? "退出对话" : "进入对话";
      modeBtn.classList.toggle("is-exit", isConv);
      modeBtn.title = isConv
        ? "退回待唤醒模式（保持麦克风监听开启）"
        : isListening
          ? "立即进入免唤醒持续对话模式"
          : "自动开启麦克风并进入持续对话模式";
    }
    if (timerTrack && timerFill) {
      const showTimer = isConv && wakeEnabled && windowSec > 0;
      timerTrack.hidden = !showTimer;
      if (showTimer) {
        const remMs = this.getRemainingDialogMs();
        const totalMs = Math.max(1000, windowSec * 1000);
        const pct = Math.max(0, Math.min(100, (remMs / totalMs) * 100));
        timerFill.style.width = `${pct.toFixed(1)}%`;
        timerFill.classList.toggle("is-paused", paused);
        timerFill.classList.toggle("is-urgent", !paused && remMs > 0 && remMs <= 5000);
      }
    }

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

    if (cavemanBtn) {
      const cm = this.currentCavemanMode();
      cavemanBtn.textContent = CAVEMAN_LABELS[cm];
      cavemanBtn.classList.toggle("active", cm !== "off");
      cavemanBtn.title = `当前回复风格：${CAVEMAN_LABELS[cm]}（点击循环切换 自然 / 简短 / 极简 / 温暖）`;
    }

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
    } else if (mode === "speaking") {
      statusEl.textContent = "正在语音播报执行结果…";
      subEl.textContent = "播报期间自动防回声，说话可随时打断";
    } else if (mode === "awake" || (isConv && isListening)) {
      statusEl.textContent = this.localClientState.oneShot
        ? "请直接说出设备指令"
        : "对话模式中，请直接说指令";
      subEl.textContent = interim ? `${interim}` : "可直接连续追问，无需重复喊唤醒词";
    } else if (isListening) {
      const engineLabel =
        this.localClientState.engine === "local"
          ? "本地 SenseVoice"
          : this.localClientState.engine === "whisper"
            ? "Whisper 降噪转写"
            : "浏览器实时识别";
      statusEl.textContent = `语音监听运行中 · ${engineLabel}`;
      subEl.textContent = interim
        ? `${interim}`
        : wakeEnabled
          ? `说出“${firstWake}，打开客厅吸顶灯”即可唤醒`
          : "免唤醒已开启，直接说出设备控制指令即可执行";
    } else {
      const readyHint = this.voiceState?.localEngine?.readyForLocalAsr
        ? "本地 SenseVoice · openWakeWord · 降噪 · SystemOne 已就绪"
        : wakeEnabled
          ? `点击「进入对话」或「开启持续监听」（唤醒词：${wakeWords.slice(0, 3).join(" / ")}）`
          : "点击「进入对话」或按 Alt+V 即可语音操控 Pi Agent";
      statusEl.textContent = "语音监听待机中";
      subEl.textContent = readyHint;
    }

    this.renderVoiceTelemetry();
  }

  private renderVoiceTelemetry(): void {
    const wrap = document.getElementById("pi-voice-telemetry");
    if (!wrap) return;
    const vs = this.voiceState;
    const cfg = this.agentState?.config;
    const tags: Array<{ label: string; warn?: boolean; title?: string }> = [];

    if (vs?.localEngine?.readyForLocalAsr) {
      tags.push({ label: "离线 SenseVoice" });
    }
    const owwOn = (vs?.owwEnabled ?? cfg?.owwEnabled ?? true) !== false;
    const owwReady = Boolean(vs?.localEngine?.readyForWakeWord ?? vs?.localEngine?.models?.openWakeWord);
    if (owwOn && owwReady) {
      tags.push({ label: "openWakeWord" });
    }
    if (vs?.noiseSuppressionMode !== "off") {
      const nMode = vs?.noiseSuppressionMode;
      const nLabel =
        nMode === "dpdfnet" && vs?.localEngine?.readyForDpdfnet
          ? "DPDFNet4 降噪"
          : nMode === "voxlock" && vs?.localEngine?.readyForVoxlock
            ? "VoxLock 降噪"
            : vs?.localEngine?.readyForDenoise
              ? "GTCRN 降噪"
              : "DSP 降噪";
      tags.push({ label: nLabel });
    }

    const s1Health = vs?.systemOneHealth ?? null;
    const s1Active = Boolean(
      s1Health?.enabled || (cfg?.systemOneMode !== "off" && cfg?.effectiveSystemOneConfigured),
    );
    if (s1Active) {
      if (s1Health?.circuitState === "open") {
        tags.push({
          label: "SystemOne 31B · 降级",
          warn: true,
          title: s1Health.openReason || "SystemOne 熔断保护中，暂由规则兜底",
        });
      } else {
        tags.push({
          label: "SystemOne 31B",
          title: s1Health
            ? `模型 ${s1Health.model} · 调用 ${s1Health.totalCalls} 次 · 缓存命中 ${s1Health.cacheHits} 次`
            : "SystemOne 决策门控已启用",
        });
      }
    } else if (vs?.attentionMode && vs.attentionMode !== "off") {
      tags.push({ label: vs.attentionMode === "strict" ? "严格注意力" : "智能注意力" });
    }

    const cavemanMode = this.currentCavemanMode();
    if (cavemanMode === "ultra" || cavemanMode === "full") {
      tags.push({
        label: cavemanMode === "ultra" ? "电报极简" : "简短回复",
        title: `回复风格：${CAVEMAN_LABELS[cavemanMode]}`,
      });
    } else if (cavemanMode === "lite") {
      tags.push({
        label: "自然回复",
        title: `回复风格：${CAVEMAN_LABELS[cavemanMode]}`,
      });
    }

    const vpCount = vs?.voiceprints?.length ?? 0;
    if (vs?.voiceprintMode && vs.voiceprintMode !== "off" && vpCount > 0) {
      tags.push({ label: `声纹(${vpCount})` });
    }

    const m = vs?.lastMetrics;
    const details: string[] = [];

    if (vs?.lastWakeHit?.wakeWord) {
      const hit = vs.lastWakeHit;
      const prefix = hit.source === "asr" ? "⚡ 唤醒" : "⚡ openWakeWord";
      details.push(`${prefix}「${hit.wakeWord}」${hit.score.toFixed(2)}`);
    }
    if (m?.voiceprint?.evaluated) {
      details.push(
        m.voiceprint.matched && m.voiceprint.speakerName
          ? `声纹:${m.voiceprint.speakerName} ${Math.round((m.voiceprint.score ?? 0) * 100)}%`
          : `声纹未匹配 ${Math.round((m.voiceprint.score ?? 0) * 100)}%`,
      );
    }
    if (typeof m?.snrGainDb === "number" && m.snrGainDb > 0) {
      details.push(`降噪 +${m.snrGainDb.toFixed(1)}dB`);
    }
    if (m?.attention?.reason) {
      if (!m.attention.accept && vs?.lastTranscript) {
        const heard = vs.lastTranscript.trim();
        const preview = heard.length > 26 ? `${heard.slice(0, 26)}…` : heard;
        details.push(`听到：“${preview}”`);
      }
      details.push(m.attention.accept ? `✓ ${m.attention.reason}` : `⊘ ${m.attention.reason}`);
    }
    if (typeof m?.timings?.totalMs === "number" && m.timings.totalMs > 0) {
      details.push(`${Math.round(m.timings.totalMs)}ms`);
    } else if (typeof s1Health?.lastLatencyMs === "number" && s1Health.lastLatencyMs > 0) {
      details.push(`S1 ${Math.round(s1Health.lastLatencyMs)}ms`);
    }

    if (tags.length === 0 && details.length === 0) {
      wrap.hidden = true;
      return;
    }
    wrap.hidden = false;
    wrap.replaceChildren();

    const pillBar = document.createElement("div");
    pillBar.className = "pi-voice-pill-row";
    for (const t of tags) {
      const sp = document.createElement("span");
      sp.className = `pi-voice-mini-tag${t.warn ? " is-warn" : ""}`;
      sp.textContent = t.label;
      if (t.title) sp.title = t.title;
      pillBar.appendChild(sp);
    }
    wrap.appendChild(pillBar);

    if (details.length > 0) {
      const meta = document.createElement("div");
      meta.className = "pi-voice-meta-line";
      meta.textContent = details.join(" · ");
      wrap.appendChild(meta);
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
    const isConv = this.effectiveDialogState() === "conversation";

    if (this.livePillHideTimer !== null) {
      return; // 正在展示临时执行结果或唤醒命中反馈
    }

    if (!this.open && (interim || mode === "awake" || mode === "processing" || isConv)) {
      pill.hidden = false;
      pill.classList.remove("is-wake-flash");
      pill.classList.toggle("is-awake", mode === "awake");
      pill.classList.toggle("is-processing", mode === "processing");
      pill.classList.toggle("is-conversation", isConv && !interim && mode !== "processing");
      if (interim) {
        textEl.textContent = interim.startsWith("⚡") ? interim : `🎤 ${interim}`;
      } else if (mode === "processing") {
        textEl.textContent = `π Pi Agent 正在执行：${this.voiceState?.lastCommand || "设备控制…"}`;
      } else if (isConv) {
        textEl.textContent = this.formatLivePillConversationText();
      } else {
        textEl.textContent = "🎤 已唤醒，请说控制指令…";
      }
    } else {
      pill.hidden = true;
      pill.classList.remove("is-conversation", "is-wake-flash");
    }
  }

  private flashLivePill(message: string, durationMs = 3500, wakeGlow = false): void {
    if (this.open) return;
    const pill = node("voice-live-pill");
    const textEl = node("voice-live-pill-text");
    textEl.textContent = message;
    pill.hidden = false;
    pill.classList.remove("is-awake", "is-processing", "is-conversation");
    pill.classList.toggle("is-wake-flash", wakeGlow);
    if (this.livePillHideTimer !== null) {
      window.clearTimeout(this.livePillHideTimer);
    }
    this.livePillHideTimer = window.setTimeout(() => {
      this.livePillHideTimer = null;
      pill.classList.remove("is-wake-flash");
      this.renderLivePill();
    }, durationMs);
  }

  private scrollTimelineToBottom(): void {
    const scroll = node("pi-agent-scroll");
    scroll.scrollTop = scroll.scrollHeight;
  }
}
