// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * 内置 Pi Agent 侧边控制抽屉、标题栏语音监听入口与实时语音字幕浮层控制器。
 */

import {
  VoiceListenerClient,
  type ClientSpeakMeta,
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

export interface UiAgentTaskUpdate {
  kind: "ack" | "verification" | "retry" | "skill_saved" | "skill_reused";
  text: string;
  timestamp: number;
  attempt?: number;
  maxAttempts?: number;
  problem?: string;
  plan?: string;
  passed?: boolean;
  skillId?: string;
  skillName?: string;
}

export interface UiAgentVerificationSummary {
  status: "passed" | "recovered" | "failed" | "unsolvable" | "skipped";
  passed: boolean;
  checked: boolean;
  solvable: boolean;
  retriesUsed: number;
  maxRetries: number;
  analysis: string;
  checks: Array<{ did?: string; deviceName?: string; toolName: string; passed: boolean; summary: string }>;
  issues: Array<{ code: string; solvable: boolean; did?: string; deviceName?: string; summary: string }>;
}

export interface UiAgentSkillEvent {
  kind: "created" | "updated" | "reused";
  skillId: string;
  skillName: string;
  pitfall?: string;
  stepsCount: number;
}

export interface UiAgentSkill {
  id: string;
  name: string;
  description: string;
  triggers: string[];
  pitfall: string;
  resolutionSummary: string;
  steps: Array<{ toolName: string; args: Record<string, unknown>; note?: string }>;
  useCount: number;
  retriesAvoided: number;
  enabled: boolean;
  updatedAt: number;
}

export interface UiCustomInstructionRule {
  id: string;
  content: string;
  rawText?: string;
  topic: string;
  source: "voice" | "text" | "manual";
  enabled: boolean;
  priority: number;
  createdAt: number;
  updatedAt: number;
}

export interface UiCustomInstructionConflict {
  ruleId: string;
  overriddenById: string;
  overriddenByPriority: number;
  overriddenByContent: string;
  topic: string;
  reason: string;
}

export interface UiReinforcementMemory {
  id: string;
  canonicalKey: string;
  sampleUtterances: string[];
  capabilityKey: string;
  speakerScope: string;
  summary: string;
  riskLevel: "L1_LOW" | "L2_MEDIUM_APPLIANCE" | "L2_SEASONAL" | "L3_HIGH_SAFETY";
  safetyLocked: boolean;
  confirmCount: number;
  confirmThreshold: number;
  autoExecCount: number;
  status: string;
  enabled: boolean;
  retention: number;
  daysSinceLastUse: number;
  uiStage: "learning" | "autonomous" | "stale" | "safety_locked" | "disabled";
  gateReason: string;
  updatedAt: number;
}

export interface UiPendingConfirmation {
  id: string;
  origin: string;
  canonicalKey: string;
  originalUtterance: string;
  questionText: string;
  summary: string;
  riskLevel: string;
  deviceName: string;
  homeName?: string;
  roomName?: string;
  drumLabel?: string;
  programLabel?: string;
  candidateLabels?: string[];
  createdAt: number;
  expiresAt: number;
}

export interface UiAgentMemoryEvent {
  kind:
    | "confirmation_requested"
    | "learned_progress"
    | "promoted_autonomous"
    | "autonomous_executed"
    | "recovered_autonomous"
    | "safety_confirmed"
    | "rejected"
    | "tainted"
    | "modified";
  memoryId?: string;
  summary: string;
  confirmCount?: number;
  confirmThreshold?: number;
  retention?: number;
  riskLevel?: string;
  reasonText?: string;
}

export interface UiAgentTimelineEntry {
  id: string;
  role: "user" | "assistant";
  source: "text" | "voice";
  text: string;
  trackIndex?: number;
  trackCount?: number;
  trackId?: string;
  speakerName?: string | null;
  speakerScore?: number;
  thinking?: string;
  thinkingActive?: boolean;
  thinkingLevel?: UiThinkingLevel;
  timestamp: number;
  status: "streaming" | "done" | "error" | "aborted";
  provider?: string;
  modelId?: string;
  toolCalls: UiAgentToolCall[];
  ackText?: string;
  taskUpdates?: UiAgentTaskUpdate[];
  verification?: UiAgentVerificationSummary | null;
  skillEvent?: UiAgentSkillEvent | null;
  memoryEvent?: UiAgentMemoryEvent | null;
  pendingConfirmation?: UiPendingConfirmation | null;
  silentCompleted?: boolean;
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
export type UiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

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
  hasClearVoiceApiKey?: boolean;
  clearVoiceApiKeyPreview?: string;
  effectiveClearVoiceRemoteConfigured?: boolean;
  hasQwen3AsrApiKey?: boolean;
  qwen3AsrApiKeyPreview?: string;
  effectiveQwen3AsrRemoteConfigured?: boolean;
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
  silentSimpleControlReply?: boolean;
  thinkingLevel?: UiThinkingLevel;
  preferLocalIntents?: boolean;
  owwEnabled?: boolean;
  owwThreshold?: number;
  maxConsecutiveSidetalk?: number;
}

export interface UiAgentActiveTask {
  taskId: string;
  entryId: string;
  command: string;
  source: "text" | "voice";
  phase: "queued" | "executing" | "verifying" | "retrying";
  startedAt: number;
}

export interface UiVoiceRuntimeLanes {
  conversation: {
    active: boolean;
    dialogState: "standby" | "conversation";
    speechActive: boolean;
    fullDuplex: boolean;
  };
  execution: {
    active: boolean;
    activeCount: number;
    tasks: UiAgentActiveTask[];
  };
  speaking: {
    active: boolean;
    utteranceId: string | null;
    text: string | null;
    queueLength: number;
    ducked: boolean;
  };
  echo: {
    mode: "auto" | "aggressive" | "standard" | "off";
    activeAec: boolean;
    erleDb: number;
    doubleTalkActive: boolean;
    suppressedCount: number;
    strippedCount: number;
    activeTtsUtterances: number;
  };
}

export interface UiPiAgentSnapshot {
  running: boolean;
  activeTaskCount?: number;
  activeTasks?: UiAgentActiveTask[];
  provider: string;
  providerLabel: string;
  modelId: string;
  tools: Array<{ name: string; label: string; description: string }>;
  skills?: UiAgentSkill[];
  customInstructions?: UiCustomInstructionRule[];
  customInstructionConflicts?: Record<string, UiCustomInstructionConflict>;
  memories?: UiReinforcementMemory[];
  pendingConfirmation?: UiPendingConfirmation | null;
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
  readyForClearVoiceGpu?: boolean;
  readyForClearVoiceBss?: boolean;
  clearVoice?: {
    gpuDetected: boolean;
    gpuName: string | null;
    vramTotalMb: number | null;
    vramFreeMb: number | null;
    runtimeReady: boolean;
    modelReady: boolean;
    ssModelReady?: boolean;
    scriptReady: boolean;
    customServiceUrl: string;
    remote?: boolean;
    hasApiKey?: boolean;
    ready: boolean;
    multiTrackReady?: boolean;
    serverRunning: boolean;
    provider: "cuda" | "cpu" | "remote" | "none";
    ssProvider?: "cuda" | "cpu" | "remote" | "none";
    modelName: string;
    ssModelName?: string;
    serviceUrl: string | null;
    lastLatencyMs: number | null;
    lastInferMs: number | null;
    lastSeparateMs?: number | null;
    lastError: string | null;
  };
  readyForVad: boolean;
  readyForVoiceprint: boolean;
  readyForQwen3Asr?: boolean;
  readyForQwen3Gpu?: boolean;
  readyForQwen3Remote?: boolean;
  activeQwen3Device?: "remote" | "gpu" | "cpu" | null;
  qwen3ComputeDevice?: "auto" | "gpu" | "cpu";
  gpu?: {
    detected: boolean;
    backend: "vulkan" | "cuda" | "metal" | "rocm" | "remote" | "none";
    remote?: boolean;
    serviceUrl?: string | null;
    modelName?: string;
    deviceId: string | null;
    deviceName: string | null;
    vramTotalMb: number | null;
    vramFreeMb: number | null;
    runtimeReady: boolean;
    modelReady: boolean;
    ready: boolean;
    serverRunning: boolean;
    lastLatencyMs?: number | null;
    lastError: string | null;
  };
  readyForSenseVoice?: boolean;
  readyForLocalAsr: boolean;
  primaryAsrEngine?: "qwen3-asr" | "sensevoice" | null;
  fallbackAsrEngine?: "sensevoice" | null;
  activeLocalAsrMode?: "auto" | "qwen3-asr" | "sensevoice";
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
    qwen3Asr?: boolean;
    qwen3AsrGpu?: boolean;
    senseVoice: boolean;
    openWakeWord?: boolean;
    localTts?: boolean;
    clearVoiceMossformer2?: boolean;
    clearVoiceMossformer2Ss?: boolean;
  };
}

export interface UiStreamingPartialTrack {
  trackId: string;
  trackIndex: number;
  text: string;
  energyRatio?: number;
}

export interface UiVoiceTrackResult {
  trackId: string;
  trackIndex: number;
  trackCount: number;
  batchId: string;
  rms?: number;
  energyRatio?: number;
  speechDetected: boolean;
  speechRatio?: number;
  durationSec?: number;
  denoiseEngine?: string;
  snrGainDb?: number;
  asrEngine?: string;
  text: string;
  acousticEvent?: string;
  voiceprint?: {
    evaluated?: boolean;
    matched?: boolean;
    speakerId?: string | null;
    speakerName?: string | null;
    role?: string | null;
    score?: number;
  } | null;
  attention?: {
    accept?: boolean;
    stage?: string;
    reason?: string;
    command?: string;
    wokeOnly?: boolean;
    passSource?: string;
    matchedCapability?: string;
  } | null;
  matched: boolean;
  wokeOnly: boolean;
  command: string;
  reply?: string;
  taskId?: string;
  entryId?: string;
  dispatchedAsync?: boolean;
  error?: string;
  timings?: {
    totalMs?: number;
    asrMs?: number;
    denoiseMs?: number;
    voiceprintMs?: number;
    attentionMs?: number;
  } | null;
  timestamp: number;
}

export interface UiVoiceTrackBatch {
  batchId: string;
  timestamp: number;
  engine: string;
  bssUsed: boolean;
  trackCount: number;
  acceptedCount: number;
  totalMs: number;
  tracks: UiVoiceTrackResult[];
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
  voicePipelineMode?: "legacy" | "clearvoice";
  clearVoiceServiceUrl?: string;
  clearVoiceModel?: string;
  qwen3AsrServiceUrl?: string;
  qwen3AsrModel?: string;
  localAsrEngine?: "auto" | "qwen3-asr" | "sensevoice";
  qwen3ComputeDevice?: "auto" | "gpu" | "cpu";
  qwen3StreamingEnabled?: boolean;
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
  asyncVoicePipeline?: boolean;
  echoCancellationMode?: "auto" | "aggressive" | "standard" | "off";
  bargeInDuckingEnabled?: boolean;
  lanes?: UiVoiceRuntimeLanes;
  localEngine?: UiLocalVoiceStatus;
  voiceprints?: UiVoiceprintProfile[];
  lastTrackBatch?: UiVoiceTrackBatch | null;
  recentTrackBatches?: UiVoiceTrackBatch[];
  lastMetrics?: {
    denoiseEngine?: string;
    snrGainDb?: number;
    vadEngine?: string;
    asrEngine?: string;
    tracks?: UiVoiceTrackResult[];
    trackBatch?: UiVoiceTrackBatch | null;
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
      passSource?: string;
      matchedCapability?: string;
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

const THINKING_LEVEL_LABELS: Readonly<Record<UiThinkingLevel, string>> = {
  off: "关闭",
  minimal: "极简",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "超高",
  max: "最大",
};

const THINKING_LEVEL_BADGE_LABELS: Readonly<Record<UiThinkingLevel, string>> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
};

function normalizeUiThinkingLevel(raw: unknown): UiThinkingLevel {
  return raw === "off" ||
    raw === "minimal" ||
    raw === "low" ||
    raw === "medium" ||
    raw === "high" ||
    raw === "xhigh" ||
    raw === "max"
    ? raw
    : "off";
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
  private skillsExpanded = false;
  private instructionsExpanded = false;
  private memoriesExpanded = false;
  private tracksExpanded = true;
  private livePartialTracks: UiStreamingPartialTrack[] = [];
  private resolvingConfirmIds = new Set<string>();
  private thinkingCollapsed = new Map<string, boolean>();
  private agentState: UiPiAgentSnapshot | null = null;
  private voiceState: UiVoiceSnapshot | null = null;
  private localClientState: {
    active: boolean;
    mode: ClientVoiceMode;
    engine: "local" | "browser" | "whisper";
    interimTranscript: string;
    error: string | null;
    oneShot: boolean;
    speaking: boolean;
    ducked: boolean;
    speakingQueueLength: number;
    speakingText: string | null;
    aecActive: boolean;
    erleDb: number;
    doubleTalk: boolean;
  } = {
    active: false,
    mode: "idle",
    engine: "local",
    interimTranscript: "",
    error: null,
    oneShot: false,
    speaking: false,
    ducked: false,
    speakingQueueLength: 0,
    speakingText: null,
    aecActive: false,
    erleDb: 0,
    doubleTalk: false,
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
            dispatchedAsync?: boolean;
            agent?: UiPiAgentSnapshot;
            voiceState?: UiVoiceSnapshot;
          }>("/api/voice-listen/transcript", {
            text,
            isFinal: true,
            bypassWakeWord: opts.bypassWakeWord,
            engine: opts.engine,
            asyncDispatch: opts.asyncDispatch ?? this.isAsyncPipelineEnabled(),
            duringTtsPlayback: opts.duringTtsPlayback ?? this.localClientState.speaking,
          });
          if (res.agent) this.applyAgentSnapshot(res.agent);
          if (res.voiceState) this.applyVoiceSnapshot(res.voiceState);
          if (res.matched && res.wokeOnly) {
            this.flashLivePill(
              res.reply ? `已唤醒「${res.reply}」` : "已唤醒，静默持续监听中…",
              4000,
            );
          } else if (res.matched && res.reply) {
            this.flashLivePill(`π ${res.reply}`, res.dispatchedAsync ? 2400 : 4200);
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
        form.append("asyncDispatch", String(opts.asyncDispatch ?? this.isAsyncPipelineEnabled()));
        form.append("duringTtsPlayback", String(opts.duringTtsPlayback ?? this.localClientState.speaking));
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

    if (kind === "partial") {
      const rawTracks = Array.isArray(ev.tracks) ? ev.tracks : [];
      const parsedTracks: UiStreamingPartialTrack[] = [];
      for (const item of rawTracks) {
        const rec = asRec(item);
        if (!rec) continue;
        const tText = typeof rec.text === "string" ? rec.text.trim() : "";
        if (!tText) continue;
        const idx = typeof rec.trackIndex === "number" ? rec.trackIndex : parsedTracks.length + 1;
        parsedTracks.push({
          trackId: typeof rec.trackId === "string" ? rec.trackId : `cv_track_${idx}`,
          trackIndex: idx,
          text: tText,
          ...(typeof rec.energyRatio === "number" ? { energyRatio: rec.energyRatio } : {}),
        });
      }
      this.livePartialTracks = parsedTracks;
      this.voiceClient.handleStreamServerEvent({ kind, text, matched });
      this.renderVoiceTracksPanel();
      this.renderLivePill();
      return;
    }

    this.voiceClient.handleStreamServerEvent({ kind, text, matched });

    if (kind === "result") {
      this.livePartialTracks = [];
      if (ev.agent) this.applyAgentSnapshot(ev.agent);
      if (ev.voiceState) this.applyVoiceSnapshot(ev.voiceState);
      this.renderVoiceTracksPanel();
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

    const laneConvBtn = document.getElementById("pi-lane-conv");
    laneConvBtn?.addEventListener("click", () => {
      void this.toggleDialogMode();
    });

    const laneExecBtn = document.getElementById("pi-lane-exec");
    laneExecBtn?.addEventListener("click", () => {
      if (this.activeTaskCount() > 0) {
        void this.abortRun();
      }
    });

    const laneSpeakBtn = document.getElementById("pi-lane-speak");
    laneSpeakBtn?.addEventListener("click", () => {
      if (this.isSpeakingNow()) {
        this.voiceClient.cancelSpeaking();
        this.deps.showToast("已停止当前语音播报（后台任务与对话保持运行）", 1800);
      }
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

    const streamingToggleBtn = document.getElementById("pi-streaming-toggle-btn");
    streamingToggleBtn?.addEventListener("click", () => {
      void this.toggleStreamingAsrMode();
    });

    const pipelineToggleBtn = document.getElementById("pi-voice-pipeline-toggle-btn");
    pipelineToggleBtn?.addEventListener("click", () => {
      void this.toggleVoicePipelineMode();
    });

    const cavemanBtn = document.getElementById("pi-caveman-toggle-btn");
    cavemanBtn?.addEventListener("click", () => {
      void this.cycleCavemanMode();
    });

    const thinkingSelect = document.getElementById(
      "pi-thinking-level-select",
    ) as HTMLSelectElement | null;
    thinkingSelect?.addEventListener("change", () => {
      const next = normalizeUiThinkingLevel(thinkingSelect.value);
      void this.setThinkingLevel(next);
    });

    const skillsToggleBtn = document.getElementById("pi-skills-toggle-btn");
    skillsToggleBtn?.addEventListener("click", () => {
      this.skillsExpanded = !this.skillsExpanded;
      this.renderSkillsBar();
      this.scrollTimelineToBottom();
    });

    const instructionsToggleBtn = document.getElementById("pi-instructions-toggle-btn");
    instructionsToggleBtn?.addEventListener("click", () => {
      this.instructionsExpanded = !this.instructionsExpanded;
      this.renderInstructionsBar();
      this.scrollTimelineToBottom();
    });

    const memoriesToggleBtn = document.getElementById("pi-memories-toggle-btn");
    memoriesToggleBtn?.addEventListener("click", () => {
      this.memoriesExpanded = !this.memoriesExpanded;
      this.renderMemoriesBar();
      this.scrollTimelineToBottom();
    });

    const tracksToggleBtn = document.getElementById("pi-tracks-toggle-btn");
    tracksToggleBtn?.addEventListener("click", () => {
      this.tracksExpanded = !this.tracksExpanded;
      this.renderVoiceTracksPanel();
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
      submitInput();
    });

    const stopBtn = document.getElementById("pi-agent-stop-btn");
    stopBtn?.addEventListener("click", () => {
      void this.abortRun();
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

  getCustomInstructions(): UiCustomInstructionRule[] {
    return this.agentState?.customInstructions ?? [];
  }

  getCustomInstructionConflicts(): Record<string, UiCustomInstructionConflict> {
    return this.agentState?.customInstructionConflicts ?? {};
  }

  getMemories(): UiReinforcementMemory[] {
    return this.agentState?.memories ?? [];
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

  async setThinkingLevel(next: UiThinkingLevel): Promise<void> {
    try {
      const res = await this.deps.apiPost<{
        agent?: UiPiAgentSnapshot;
        voice?: UiVoiceSnapshot;
      }>("/api/agent/config", { thinkingLevel: next });
      if (res.agent) this.applyAgentSnapshot(res.agent);
      if (res.voice) this.applyVoiceSnapshot(res.voice);
      this.deps.showToast(
        next === "off"
          ? "已关闭 AI 思考模式"
          : `AI 思考等级已设为：${THINKING_LEVEL_LABELS[next]}（思考过程仅展示在对话框，不语音播报）`,
        2400,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.deps.showToast(`设置 AI 思考等级失败：${msg}`, 3000);
      this.renderVoiceStrip();
    }
  }

  async triggerOneShotVoice(): Promise<void> {
    this.setOpen(true);
    await this.voiceClient.startOneShot();
  }

  async toggleStreamingAsrMode(): Promise<void> {
    const current =
      (this.voiceState?.qwen3StreamingEnabled ?? this.agentState?.config.qwen3StreamingEnabled ?? true) !==
      false;
    const next = !current;
    try {
      const res = await this.deps.apiPost<{
        agent?: UiPiAgentSnapshot;
        voice?: UiVoiceSnapshot;
      }>("/api/agent/config", { qwen3StreamingEnabled: next });
      if (res.agent) this.applyAgentSnapshot(res.agent);
      if (res.voice) this.applyVoiceSnapshot(res.voice);
      this.deps.showToast(
        next ? "已开启流式转写与智能断句" : "已关闭流式转写（切回传统整句模式）",
        2200,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.deps.showToast(`切换流式转写失败：${msg}`, 3000);
    }
  }

  async toggleVoicePipelineMode(): Promise<void> {
    const current =
      this.voiceState?.voicePipelineMode ?? this.agentState?.config.voicePipelineMode ?? "legacy";
    const next: "legacy" | "clearvoice" = current === "clearvoice" ? "legacy" : "clearvoice";
    try {
      const res = await this.deps.apiPost<{
        agent?: UiPiAgentSnapshot;
        voice?: UiVoiceSnapshot;
      }>("/api/agent/config", { voicePipelineMode: next });
      if (res.agent) this.applyAgentSnapshot(res.agent);
      if (res.voice) this.applyVoiceSnapshot(res.voice);
      this.deps.showToast(
        next === "clearvoice"
          ? "已切换新方案：ClearVoice 多轨盲源分离 + 降噪 → 分轨独立声纹/ASR/判定"
          : "已切回原方案（GTCRN + 声源分离）",
        2400,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.deps.showToast(`切换语音方案失败：${msg}`, 3000);
    }
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
        async: this.isAsyncPipelineEnabled(),
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

    if (kind === "task_ack" && typeof ev.text === "string") {
      const target = this.agentState.timeline.find((e) => e.id === entryId);
      if (target) {
        target.ackText = ev.text;
        this.renderTimeline();
      }
      this.flashLivePill(`π ${ev.text}`, 1800);
      return;
    }

    if (kind === "retry_notice" && typeof ev.text === "string") {
      const target = this.agentState.timeline.find((e) => e.id === entryId);
      if (target) {
        if (!Array.isArray(target.taskUpdates)) target.taskUpdates = [];
        const attempt = typeof ev.attempt === "number" ? ev.attempt : undefined;
        const already =
          attempt !== undefined &&
          target.taskUpdates.some((u) => u.kind === "retry" && u.attempt === attempt);
        if (!already) {
          target.taskUpdates.push({
            kind: "retry",
            attempt,
            maxAttempts: typeof ev.maxAttempts === "number" ? ev.maxAttempts : 3,
            problem: typeof ev.problem === "string" ? ev.problem : undefined,
            plan: typeof ev.plan === "string" ? ev.plan : undefined,
            text: ev.text,
            timestamp: Date.now(),
          });
        }
        this.renderTimeline();
      }
      this.flashLivePill(`↻ ${ev.text}`, 3600);
      return;
    }

    if (kind === "verification_result" && ev.verification) {
      const target = this.agentState.timeline.find((e) => e.id === entryId);
      if (target) {
        target.verification = ev.verification as UiAgentVerificationSummary;
        this.renderTimeline();
      }
      return;
    }

    if ((kind === "skill_saved" || kind === "skill_reused") && ev.skillEvent) {
      const target = this.agentState.timeline.find((e) => e.id === entryId);
      if (target) {
        target.skillEvent = ev.skillEvent as UiAgentSkillEvent;
        this.renderTimeline();
      }
      return;
    }

    if (kind === "thinking_start" || kind === "thinking_delta" || kind === "thinking_end") {
      const target = this.agentState.timeline.find((e) => e.id === entryId);
      if (target) {
        if (typeof ev.thinking === "string") {
          target.thinking = ev.thinking;
        } else if (kind === "thinking_delta" && typeof ev.delta === "string") {
          target.thinking = (target.thinking ?? "") + ev.delta;
        }
        target.thinkingActive = kind !== "thinking_end";
        if (typeof ev.thinkingLevel === "string") {
          target.thinkingLevel = normalizeUiThinkingLevel(ev.thinkingLevel);
        }

        const thinkingBody = document.querySelector<HTMLElement>(
          `[data-agent-msg-thinking="${CSS.escape(entryId)}"]`,
        );
        const thinkingCard = thinkingBody?.closest<HTMLElement>(".pi-thinking-card") ?? null;
        if (thinkingBody && thinkingCard) {
          thinkingBody.textContent = target.thinking ?? "";
          thinkingBody.scrollTop = thinkingBody.scrollHeight;
          thinkingCard.classList.toggle("is-streaming", Boolean(target.thinkingActive));
          const titleEl = thinkingCard.querySelector<HTMLElement>(".pi-thinking-title");
          if (titleEl) {
            titleEl.textContent = target.thinkingActive ? "思考中…" : "思考过程";
          }
          this.scrollTimelineToBottom();
          return;
        }
      }
      this.renderTimeline();
      return;
    }

    if (kind === "final_reply" && typeof ev.text === "string") {
      const target = this.agentState.timeline.find((e) => e.id === entryId);
      if (target) {
        target.text = ev.text;
        if (ev.silent === true) {
          target.silentCompleted = true;
        }
        if (typeof ev.thinking === "string") target.thinking = ev.thinking;
        target.thinkingActive = false;
        if (ev.verification) target.verification = ev.verification as UiAgentVerificationSummary;
        if (ev.skillEvent) target.skillEvent = ev.skillEvent as UiAgentSkillEvent;
        if (ev.memoryEvent) target.memoryEvent = ev.memoryEvent as UiAgentMemoryEvent;
        if (ev.pendingConfirmation) {
          target.pendingConfirmation = ev.pendingConfirmation as UiPendingConfirmation;
        }
        this.renderTimeline();
      }
      return;
    }

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

  handleSpeakEvent(text: string, meta?: ClientSpeakMeta): void {
    if (this.localClientState.active || this.agentState?.config.autoSpeakReply) {
      this.voiceClient.speak(text, meta);
    }
  }

  handleSpeakChunkEvent(text: string, meta?: ClientSpeakMeta): void {
    if (this.localClientState.active || this.agentState?.config.autoSpeakReply) {
      this.voiceClient.enqueueSpeakChunk(text, meta);
    }
  }

  private isAsyncPipelineEnabled(): boolean {
    return (
      (this.agentState?.config.asyncVoicePipeline ?? this.voiceState?.asyncVoicePipeline ?? true) !==
      false
    );
  }

  private activeTaskCount(): number {
    if (typeof this.agentState?.activeTaskCount === "number") {
      return Math.max(0, this.agentState.activeTaskCount);
    }
    if (typeof this.voiceState?.lanes?.execution.activeCount === "number") {
      return Math.max(0, this.voiceState.lanes.execution.activeCount);
    }
    return this.agentState?.running ? 1 : 0;
  }

  private isSpeakingNow(): boolean {
    return this.localClientState.speaking || Boolean(this.voiceState?.lanes?.speaking.active);
  }

  private effectiveMode(): ClientVoiceMode {
    const asyncOn = this.isAsyncPipelineEnabled();
    if (!asyncOn) {
      if (this.agentState?.running || this.voiceState?.mode === "processing") return "processing";
      if (this.localClientState.active) {
        if (this.localClientState.mode === "speaking" || this.localClientState.speaking) return "speaking";
        if (this.voiceState?.mode === "awake") return "awake";
        return this.localClientState.mode;
      }
    } else {
      // 全双工异步分离模式：对话收音状态不被后台执行或语音播报覆盖
      if (this.localClientState.active) {
        if (this.voiceState?.dialogState === "conversation" || this.voiceState?.mode === "awake") {
          return "awake";
        }
        return this.localClientState.mode === "speaking" ? "listening" : this.localClientState.mode;
      }
      if (this.voiceState?.dialogState === "conversation" || this.voiceState?.mode === "awake") {
        return "awake";
      }
      if (this.activeTaskCount() > 0) return "processing";
      if (this.isSpeakingNow()) return "speaking";
    }
    if (this.voiceState?.mode === "awake") return "awake";
    if (this.localClientState.error) return "error";
    return "idle";
  }

  private currentCavemanMode(): UiCavemanMode {
    const raw = this.agentState?.config.cavemanMode ?? this.voiceState?.cavemanMode;
    return normalizeUiCavemanMode(raw);
  }

  private currentThinkingLevel(): UiThinkingLevel {
    return normalizeUiThinkingLevel(this.agentState?.config.thinkingLevel);
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
    return mode === "processing" || mode === "speaking" || this.activeTaskCount() > 0 || this.isSpeakingNow();
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
    const execCount = this.activeTaskCount();
    const speaking = this.isSpeakingNow();
    if (dialogState !== "conversation") {
      return "待唤醒";
    }
    if (execCount > 0 && speaking) {
      return execCount > 1 ? `对话中 · 并行${execCount} · 播报` : "对话中 · 执行 · 播报";
    }
    if (speaking) {
      return "对话中 · 播报";
    }
    if (execCount > 0 || this.isDialogTimerPaused()) {
      return execCount > 1 ? `对话中 · 并行${execCount}` : "对话中 · 执行";
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
    const execCount = this.activeTaskCount();
    const speaking = this.isSpeakingNow();

    if (!isListening && dialogState !== "conversation") {
      return "非对话模式 · 未开启监听";
    }
    if (!wakeEnabled) {
      return "免唤醒直达 · 持续对话";
    }
    if (dialogState !== "conversation") {
      return "非对话模式 · 等待唤醒";
    }
    if (execCount > 0 && speaking) {
      return `对话模式 · 并行执行 ${execCount} 项 · 播报中`;
    }
    if (speaking) {
      return this.localClientState.ducked ? "对话模式 · 播报降音避让" : "对话模式 · 播报中（可随时说话）";
    }
    if (execCount > 0 || this.isDialogTimerPaused()) {
      return execCount > 1
        ? `对话模式 · 后台并行 ${execCount} 项（可继续对话）`
        : "对话模式 · 后台执行中（可继续对话）";
    }
    const windowSec = this.getConversationWindowSec();
    if (windowSec === 0) {
      return "免唤醒直达 · 持续对话";
    }
    return `对话模式 · 剩余 ${this.getRemainingDialogSec()}s`;
  }

  private formatLivePillConversationText(): string {
    const execCount = this.activeTaskCount();
    const speaking = this.isSpeakingNow();
    if (execCount > 0 && speaking) return `对话中 · 执行(${execCount}) · 播报中`;
    if (speaking) return "对话模式 · 播报中（可随时插话）";
    if (execCount > 0 || this.isDialogTimerPaused()) {
      return execCount > 1 ? `对话模式 · 并行执行 ${execCount} 项` : "对话模式 · 后台执行中";
    }
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
    this.renderSkillsBar();
    this.renderInstructionsBar();
    this.renderMemoriesBar();
    this.renderTimeline();
    this.renderComposer();
    this.renderLivePill();
  }

  private async toggleAgentSkill(skillId: string, enabled: boolean): Promise<void> {
    try {
      const res = await this.deps.apiPost<{ agent?: UiPiAgentSnapshot }>(
        `/api/agent/skills/${encodeURIComponent(skillId)}/toggle`,
        { enabled },
      );
      if (res.agent) this.applyAgentSnapshot(res.agent);
      this.deps.showToast(enabled ? "已启用该 Skill" : "已暂停该 Skill", 1800);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.deps.showToast(`更新 Skill 状态失败：${msg}`, 3000);
    }
  }

  private async deleteAgentSkill(skillId: string): Promise<void> {
    try {
      const res = await this.deps.apiPost<{ agent?: UiPiAgentSnapshot }>(
        `/api/agent/skills/${encodeURIComponent(skillId)}/delete`,
      );
      if (res.agent) this.applyAgentSnapshot(res.agent);
      this.deps.showToast("已删除该 Skill", 1800);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.deps.showToast(`删除 Skill 失败：${msg}`, 3000);
    }
  }

  private renderSkillsBar(): void {
    const bar = document.getElementById("pi-skills-bar");
    const countLabel = document.getElementById("pi-skills-count-label");
    const chevron = document.getElementById("pi-skills-chevron");
    const toggleBtn = document.getElementById("pi-skills-toggle-btn");
    const list = document.getElementById("pi-skills-list");
    if (!bar || !countLabel || !chevron || !toggleBtn || !list) return;

    const skills = this.agentState?.skills ?? [];
    if (skills.length === 0) {
      bar.hidden = true;
      this.skillsExpanded = false;
      list.replaceChildren();
      return;
    }

    bar.hidden = false;
    const enabledCount = skills.filter((s) => s.enabled).length;
    countLabel.textContent = `已沉淀 Skill (${enabledCount}/${skills.length})`;
    chevron.textContent = this.skillsExpanded ? "▾" : "▸";
    toggleBtn.setAttribute("aria-expanded", String(this.skillsExpanded));
    list.hidden = !this.skillsExpanded;
    list.replaceChildren();

    if (!this.skillsExpanded) return;

    for (const skill of skills) {
      const row = document.createElement("div");
      row.className = `pi-skill-item${skill.enabled ? "" : " is-disabled"}`;

      const main = document.createElement("div");
      main.className = "pi-skill-item-main";

      const title = document.createElement("div");
      title.className = "pi-skill-item-name";
      title.textContent = skill.name;
      title.title = skill.description || skill.name;

      const meta = document.createElement("div");
      meta.className = "pi-skill-item-meta";
      const metaParts: string[] = [];
      if (skill.pitfall) metaParts.push(`避坑：${skill.pitfall}`);
      metaParts.push(`${skill.steps.length} 步`);
      if (skill.useCount > 0) metaParts.push(`已复用 ${skill.useCount} 次`);
      meta.textContent = metaParts.join(" · ");

      main.append(title, meta);

      const actions = document.createElement("div");
      actions.className = "pi-skill-item-actions";

      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "pi-skill-mini-btn";
      toggle.textContent = skill.enabled ? "停用" : "启用";
      toggle.addEventListener("click", () => {
        void this.toggleAgentSkill(skill.id, !skill.enabled);
      });

      const del = document.createElement("button");
      del.type = "button";
      del.className = "pi-skill-mini-btn is-danger";
      del.textContent = "删除";
      del.addEventListener("click", () => {
        void this.deleteAgentSkill(skill.id);
      });

      actions.append(toggle, del);
      row.append(main, actions);
      list.appendChild(row);
    }
  }

  private async toggleCustomInstruction(ruleId: string, enabled: boolean): Promise<void> {
    try {
      const res = await this.deps.apiPost<{ agent?: UiPiAgentSnapshot }>(
        `/api/agent/instructions/${encodeURIComponent(ruleId)}/toggle`,
        { enabled },
      );
      if (res.agent) this.applyAgentSnapshot(res.agent);
      this.deps.showToast(enabled ? "已启用该附加指令" : "已停用该附加指令", 1800);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.deps.showToast(`更新附加指令失败：${msg}`, 3000);
    }
  }

  private async deleteCustomInstruction(ruleId: string): Promise<void> {
    try {
      const res = await this.deps.apiPost<{ agent?: UiPiAgentSnapshot }>(
        `/api/agent/instructions/${encodeURIComponent(ruleId)}/delete`,
      );
      if (res.agent) this.applyAgentSnapshot(res.agent);
      this.deps.showToast("已删除该附加指令", 1800);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.deps.showToast(`删除附加指令失败：${msg}`, 3000);
    }
  }

  private renderInstructionsBar(): void {
    const bar = document.getElementById("pi-instructions-bar");
    const countLabel = document.getElementById("pi-instructions-count-label");
    const chevron = document.getElementById("pi-instructions-chevron");
    const toggleBtn = document.getElementById("pi-instructions-toggle-btn");
    const list = document.getElementById("pi-instructions-list");
    if (!bar || !countLabel || !chevron || !toggleBtn || !list) return;

    const rules = this.agentState?.customInstructions ?? [];
    const conflicts = this.agentState?.customInstructionConflicts ?? {};
    if (rules.length === 0) {
      bar.hidden = true;
      this.instructionsExpanded = false;
      list.replaceChildren();
      return;
    }

    bar.hidden = false;
    const enabledCount = rules.filter((r) => r.enabled).length;
    countLabel.textContent = `附加指令规则 (${enabledCount}/${rules.length} · 最新优先)`;
    chevron.textContent = this.instructionsExpanded ? "▾" : "▸";
    toggleBtn.setAttribute("aria-expanded", String(this.instructionsExpanded));
    list.hidden = !this.instructionsExpanded;
    list.replaceChildren();

    if (!this.instructionsExpanded) return;

    let enabledRank = 0;
    for (const rule of rules) {
      if (rule.enabled) enabledRank += 1;
      const conflict = rule.enabled ? conflicts[rule.id] : undefined;

      const row = document.createElement("div");
      row.className = `pi-skill-item pi-inst-item${rule.enabled ? "" : " is-disabled"}${
        conflict ? " is-overridden" : ""
      }`;

      const main = document.createElement("div");
      main.className = "pi-skill-item-main";

      const title = document.createElement("div");
      title.className = "pi-inst-item-content";
      title.textContent = rule.content;
      title.title = rule.content;

      const meta = document.createElement("div");
      meta.className = "pi-inst-item-tags";

      if (rule.enabled && enabledRank === 1) {
        const latestTag = document.createElement("span");
        latestTag.className = "inst-tag inst-tag-latest";
        latestTag.textContent = "最新优先";
        meta.appendChild(latestTag);
      } else if (rule.enabled) {
        const rankTag = document.createElement("span");
        rankTag.className = "inst-tag";
        rankTag.textContent = `#${enabledRank}`;
        meta.appendChild(rankTag);
      } else {
        const offTag = document.createElement("span");
        offTag.className = "inst-tag";
        offTag.textContent = "已停用";
        meta.appendChild(offTag);
      }

      const topicTag = document.createElement("span");
      topicTag.className = "inst-tag inst-tag-topic";
      topicTag.textContent = rule.topic || "通用";
      meta.appendChild(topicTag);

      const srcTag = document.createElement("span");
      srcTag.className = `inst-tag${rule.source === "voice" ? " inst-tag-voice" : ""}`;
      srcTag.textContent = rule.source === "voice" ? "语音" : rule.source === "text" ? "对话" : "手动";
      meta.appendChild(srcTag);

      if (conflict) {
        const confTag = document.createElement("span");
        confTag.className = "inst-tag inst-tag-conflict";
        confTag.textContent = "冲突时以新规则为准";
        confTag.title = conflict.reason;
        meta.appendChild(confTag);
      }

      main.append(title, meta);

      const actions = document.createElement("div");
      actions.className = "pi-skill-item-actions";

      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "pi-skill-mini-btn";
      toggle.textContent = rule.enabled ? "停用" : "启用";
      toggle.addEventListener("click", () => {
        void this.toggleCustomInstruction(rule.id, !rule.enabled);
      });

      const del = document.createElement("button");
      del.type = "button";
      del.className = "pi-skill-mini-btn is-danger";
      del.textContent = "删除";
      del.addEventListener("click", () => {
        void this.deleteCustomInstruction(rule.id);
      });

      actions.append(toggle, del);
      row.append(main, actions);
      list.appendChild(row);
    }
  }

  private async toggleMemory(memoryId: string, enabled: boolean): Promise<void> {
    try {
      const res = await this.deps.apiPost<{ agent?: UiPiAgentSnapshot }>(
        `/api/agent/memories/${encodeURIComponent(memoryId)}/toggle`,
        { enabled },
      );
      if (res.agent) this.applyAgentSnapshot(res.agent);
      this.deps.showToast(enabled ? "已启用该强化记忆" : "已停用该强化记忆", 1800);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.deps.showToast(`更新强化记忆失败：${msg}`, 3000);
    }
  }

  private async resetMemory(memoryId: string): Promise<void> {
    try {
      const res = await this.deps.apiPost<{ agent?: UiPiAgentSnapshot }>(
        `/api/agent/memories/${encodeURIComponent(memoryId)}/reset`,
      );
      if (res.agent) this.applyAgentSnapshot(res.agent);
      this.deps.showToast("已重置该记忆，下次触发将重新确认", 2000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.deps.showToast(`重置强化记忆失败：${msg}`, 3000);
    }
  }

  private async deleteMemory(memoryId: string): Promise<void> {
    try {
      const res = await this.deps.apiPost<{ agent?: UiPiAgentSnapshot }>(
        `/api/agent/memories/${encodeURIComponent(memoryId)}/delete`,
      );
      if (res.agent) this.applyAgentSnapshot(res.agent);
      this.deps.showToast("已删除该强化决策记忆", 1800);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.deps.showToast(`删除强化记忆失败：${msg}`, 3000);
    }
  }

  private async resolveConfirmation(
    id: string,
    action: "confirm" | "cancel",
    selectedCandidateIndex?: number,
  ): Promise<void> {
    if (this.resolvingConfirmIds.has(id)) return;
    this.resolvingConfirmIds.add(id);
    this.renderTimeline();
    try {
      const res = await this.deps.apiPost<{ agent?: UiPiAgentSnapshot }>(
        `/api/agent/confirmations/${encodeURIComponent(id)}/resolve`,
        {
          action,
          ...(typeof selectedCandidateIndex === "number" ? { selectedCandidateIndex } : {}),
        },
      );
      if (res.agent) this.applyAgentSnapshot(res.agent);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.deps.showToast(`处理确认失败：${msg}`, 3000);
    } finally {
      this.resolvingConfirmIds.delete(id);
      this.renderTimeline();
    }
  }

  private renderMemoriesBar(): void {
    const bar = document.getElementById("pi-memories-bar");
    const countLabel = document.getElementById("pi-memories-count-label");
    const chevron = document.getElementById("pi-memories-chevron");
    const toggleBtn = document.getElementById("pi-memories-toggle-btn");
    const list = document.getElementById("pi-memories-list");
    if (!bar || !countLabel || !chevron || !toggleBtn || !list) return;

    const memories = this.agentState?.memories ?? [];
    if (memories.length === 0) {
      bar.hidden = true;
      this.memoriesExpanded = false;
      list.replaceChildren();
      return;
    }

    bar.hidden = false;
    const autoCount = memories.filter((m) => m.uiStage === "autonomous").length;
    countLabel.textContent = `强化决策记忆 (${memories.length} · ${autoCount} 条免确认直行)`;
    chevron.textContent = this.memoriesExpanded ? "▾" : "▸";
    toggleBtn.setAttribute("aria-expanded", String(this.memoriesExpanded));
    list.hidden = !this.memoriesExpanded;
    list.replaceChildren();

    if (!this.memoriesExpanded) return;

    for (const mem of memories) {
      const row = document.createElement("div");
      row.className = `pi-skill-item pi-inst-item${mem.enabled ? "" : " is-disabled"}`;

      const main = document.createElement("div");
      main.className = "pi-skill-item-main";

      const title = document.createElement("div");
      title.className = "pi-inst-item-content";
      title.textContent = mem.summary;

      const meta = document.createElement("div");
      meta.className = "pi-inst-item-tags";

      const stageTag = document.createElement("span");
      if (mem.uiStage === "autonomous") {
        stageTag.className = "inst-tag mem-tag-autonomous";
        stageTag.textContent = `已信任 · 免确认 (${mem.confirmCount}/${mem.confirmThreshold})`;
      } else if (mem.uiStage === "safety_locked") {
        stageTag.className = "inst-tag mem-tag-safety";
        stageTag.textContent = "安全锁 · 每次必确认";
      } else if (mem.uiStage === "stale") {
        stageTag.className = "inst-tag mem-tag-stale";
        stageTag.textContent = "休眠/变化 · 待重确认";
      } else if (mem.uiStage === "disabled") {
        stageTag.className = "inst-tag";
        stageTag.textContent = "已停用";
      } else {
        stageTag.className = "inst-tag mem-tag-learning";
        stageTag.textContent = `学习中 ${mem.confirmCount}/${mem.confirmThreshold}`;
      }
      stageTag.title = mem.gateReason || mem.summary;
      meta.appendChild(stageTag);

      const retTag = document.createElement("span");
      retTag.className = "inst-tag";
      retTag.textContent = `保留 ${Math.round((mem.retention ?? 1) * 100)}%`;
      meta.appendChild(retTag);

      if (mem.autoExecCount > 0) {
        const autoTag = document.createElement("span");
        autoTag.className = "inst-tag";
        autoTag.textContent = `直行 ${mem.autoExecCount} 次`;
        meta.appendChild(autoTag);
      }

      main.append(title, meta);

      const actions = document.createElement("div");
      actions.className = "pi-skill-item-actions";

      const resetBtn = document.createElement("button");
      resetBtn.type = "button";
      resetBtn.className = "pi-skill-mini-btn";
      resetBtn.textContent = "重置";
      resetBtn.title = "重置确认次数，下次触发重新询问";
      resetBtn.addEventListener("click", () => {
        void this.resetMemory(mem.id);
      });

      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "pi-skill-mini-btn";
      toggle.textContent = mem.enabled ? "停用" : "启用";
      toggle.addEventListener("click", () => {
        void this.toggleMemory(mem.id, !mem.enabled);
      });

      const del = document.createElement("button");
      del.type = "button";
      del.className = "pi-skill-mini-btn is-danger";
      del.textContent = "删除";
      del.addEventListener("click", () => {
        void this.deleteMemory(mem.id);
      });

      actions.append(resetBtn, toggle, del);
      row.append(main, actions);
      list.appendChild(row);
    }
  }

  private renderTitleButtons(): void {
    const voiceBtn = node<HTMLButtonElement>("voice-listen-toggle-btn");
    const voiceLabel = node("voice-listen-label");
    const mode = this.effectiveMode();
    const dialogState = this.effectiveDialogState();
    const isConv = dialogState === "conversation";
    const execCount = this.activeTaskCount();
    const speaking = this.isSpeakingNow();
    const active =
      this.localClientState.active ||
      mode === "awake" ||
      mode === "processing" ||
      isConv ||
      execCount > 0 ||
      speaking;

    voiceBtn.classList.toggle("active", active);
    voiceBtn.classList.toggle("is-listening", this.localClientState.active && mode === "listening");
    voiceBtn.classList.toggle("is-awake", mode === "awake" || isConv);
    voiceBtn.classList.toggle("is-processing", execCount > 0 || mode === "processing");
    voiceBtn.setAttribute("aria-pressed", String(this.localClientState.active));

    if (mode === "awake" || isConv) {
      voiceLabel.textContent = this.localClientState.oneShot ? "请说话…" : "对话中";
    } else if (this.localClientState.active) {
      voiceLabel.textContent = "监听中";
    } else if (execCount > 0) {
      voiceLabel.textContent = execCount > 1 ? `并行 ${execCount}` : "执行中…";
    } else if (speaking) {
      voiceLabel.textContent = "播报中";
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
    const streamingBtn = document.getElementById("pi-streaming-toggle-btn") as HTMLButtonElement | null;
    const pipelineBtn = document.getElementById("pi-voice-pipeline-toggle-btn") as HTMLButtonElement | null;
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

    if (streamingBtn) {
      const streamingOn =
        (this.voiceState?.qwen3StreamingEnabled ?? this.agentState?.config.qwen3StreamingEnabled ?? true) !==
        false;
      streamingBtn.textContent = streamingOn ? "流式：开" : "流式：关";
      streamingBtn.classList.toggle("active", streamingOn);
      streamingBtn.setAttribute("aria-pressed", String(streamingOn));
      streamingBtn.title = streamingOn
        ? "Qwen3-ASR 实时流式转写与智能断句已开启（点击切换为传统整句模式）"
        : "流式转写已关闭，当前使用传统静音判停整句识别（点击开启实时流式转写）";
    }

    if (pipelineBtn) {
      const pipelineMode =
        this.voiceState?.voicePipelineMode ?? this.agentState?.config.voicePipelineMode ?? "legacy";
      const isClearVoice = pipelineMode === "clearvoice";
      const cvInfo = this.voiceState?.localEngine?.clearVoice;
      const cvReady = Boolean(this.voiceState?.localEngine?.readyForClearVoiceGpu ?? cvInfo?.ready);
      pipelineBtn.textContent = isClearVoice
        ? cvReady
          ? "方案：ClearVoice"
          : "ClearVoice(待就绪)"
        : "方案：原方案";
      pipelineBtn.classList.toggle("active", isClearVoice);
      pipelineBtn.setAttribute("aria-pressed", String(isClearVoice));
      pipelineBtn.title = isClearVoice
        ? "当前为新方案：ClearVoice GPU 准实时切片（Silero VAD 双触发 + 0.3s 上下文 + 20ms 淡入淡出）→ Qwen3-ASR（点击切回原方案）"
        : "当前为原方案（GTCRN + Silero VAD + 声源分离），点击切换为 ClearVoice GPU 准实时切片 → Qwen3-ASR 新方案";
    }

    if (cavemanBtn) {
      const cm = this.currentCavemanMode();
      cavemanBtn.textContent = CAVEMAN_LABELS[cm];
      cavemanBtn.classList.toggle("active", cm !== "off");
      cavemanBtn.title = `当前回复风格：${CAVEMAN_LABELS[cm]}（点击循环切换 自然 / 简短 / 极简 / 温暖）`;
    }

    const thinkingSelect = document.getElementById(
      "pi-thinking-level-select",
    ) as HTMLSelectElement | null;
    if (thinkingSelect) {
      const tl = this.currentThinkingLevel();
      if (thinkingSelect.value !== tl) {
        thinkingSelect.value = tl;
      }
      thinkingSelect.classList.toggle("active", tl !== "off");
      const isLocal = this.agentState?.provider === "local";
      thinkingSelect.title = isLocal
        ? `当前 AI 思考等级：${THINKING_LEVEL_LABELS[tl]}（内置本地引擎不启用云端推理；切换云端或自定义大模型后生效，思考过程仅展示在对话框，不播报）`
        : `当前 AI 思考等级：${THINKING_LEVEL_LABELS[tl]}（思考过程显示在对话框中，不语音播报）`;
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
      const localEngine = this.voiceState?.localEngine;
      const isQwenRemote = localEngine?.activeQwen3Device === "remote";
      const qwen3DevTag =
        isQwenRemote
          ? "在线 GPU"
          : localEngine?.activeQwen3Device === "gpu"
            ? "GPU"
            : localEngine?.activeQwen3Device === "cpu"
              ? "CPU"
              : "";
      const streamingOn =
        (this.voiceState?.qwen3StreamingEnabled ?? this.agentState?.config.qwen3StreamingEnabled ?? true) !==
        false;
      const pipelineIsCv =
        (this.voiceState?.voicePipelineMode ?? this.agentState?.config.voicePipelineMode ?? "legacy") ===
        "clearvoice";
      const cvIsRemote = localEngine?.clearVoice?.provider === "remote";
      const cvPrefix = pipelineIsCv ? (cvIsRemote ? "ClearVoice 在线 → " : "ClearVoice GPU → ") : "";
      const localAsrLabel =
        localEngine?.primaryAsrEngine === "qwen3-asr"
          ? `${cvPrefix}${isQwenRemote ? "在线" : "本地"} Qwen3-ASR 0.6B${qwen3DevTag ? ` (${qwen3DevTag})` : ""}${streamingOn ? " · 流式" : ""}`
          : localEngine?.primaryAsrEngine === "sensevoice"
            ? localEngine.activeLocalAsrMode === "sensevoice"
              ? `${cvPrefix}本地 SenseVoice (备用)`
              : `${cvPrefix}本地 SenseVoice (兜底)`
            : `${cvPrefix}本地离线语音`;
      const engineLabel =
        this.localClientState.engine === "local"
          ? localAsrLabel
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
      const le = this.voiceState?.localEngine;
      const isQwenRemote = le?.activeQwen3Device === "remote";
      const devLabel =
        isQwenRemote
          ? "在线 GPU"
          : le?.activeQwen3Device === "gpu"
            ? "GPU"
            : le?.activeQwen3Device === "cpu"
              ? "CPU"
              : "";
      const streamingOn =
        (this.voiceState?.qwen3StreamingEnabled ?? this.agentState?.config.qwen3StreamingEnabled ?? true) !==
        false;
      const asrReadyPrefix =
        le?.primaryAsrEngine === "qwen3-asr"
          ? le.readyForSenseVoice
            ? `${isQwenRemote ? "在线" : "本地"} Qwen3-ASR 0.6B (${devLabel || "主"}${streamingOn ? "·流式" : ""}) · SenseVoice (备用)`
            : `${isQwenRemote ? "在线" : "本地"} Qwen3-ASR 0.6B (${devLabel || "主"}${streamingOn ? "·流式" : ""})`
          : le?.primaryAsrEngine === "sensevoice"
            ? "本地 SenseVoice (备用)"
            : "";
      const pipelineIsCv =
        (this.voiceState?.voicePipelineMode ?? this.agentState?.config.voicePipelineMode ?? "legacy") ===
        "clearvoice";
      const cvIsRemote = le?.clearVoice?.provider === "remote";
      const readyHint =
        le?.readyForLocalAsr && asrReadyPrefix
          ? pipelineIsCv
            ? `新方案 ClearVoice ${cvIsRemote ? "在线 GPU" : "GPU"} (MossFormer2 切片) → ${asrReadyPrefix} 已就绪`
            : `${asrReadyPrefix} · openWakeWord · 降噪已就绪`
          : wakeEnabled
            ? `点击「进入对话」或「开启持续监听」（唤醒词：${wakeWords.slice(0, 3).join(" / ")}）`
            : "点击「进入对话」或按 Alt+V 即可语音操控 Pi Agent";
      statusEl.textContent = "语音监听待机中";
      subEl.textContent = readyHint;
    }

    this.renderVoiceLanes();
    this.renderVoiceTelemetry();
    this.renderVoiceTracksPanel();
  }

  private renderVoiceLanes(): void {
    const convChip = document.getElementById("pi-lane-conv");
    const convVal = document.getElementById("pi-lane-conv-val");
    const execChip = document.getElementById("pi-lane-exec");
    const execVal = document.getElementById("pi-lane-exec-val");
    const speakChip = document.getElementById("pi-lane-speak");
    const speakVal = document.getElementById("pi-lane-speak-val");
    if (!convChip || !convVal || !execChip || !execVal || !speakChip || !speakVal) return;

    const isConv = this.effectiveDialogState() === "conversation";
    const isListening = this.localClientState.active;
    const execCount = this.activeTaskCount();
    const speaking = this.isSpeakingNow();
    const ducked = this.localClientState.ducked || Boolean(this.voiceState?.lanes?.speaking.ducked);
    const speakQueueLen = Math.max(
      this.localClientState.speakingQueueLength,
      this.voiceState?.lanes?.speaking.queueLength ?? 0,
    );

    convChip.classList.toggle("is-conv", isConv);
    convChip.classList.toggle("is-active", !isConv && isListening);
    convVal.textContent = isConv ? "持续对话" : isListening ? "监听待唤醒" : "待机";

    execChip.classList.toggle("is-exec", execCount > 0);
    execVal.textContent =
      execCount > 1 ? `并行 ${execCount} 项` : execCount === 1 ? "执行中" : "空闲";
    const activeTasks = this.agentState?.activeTasks ?? this.voiceState?.lanes?.execution.tasks ?? [];
    execChip.title =
      execCount > 0
        ? `当前后台任务：${activeTasks.map((t) => t.command).slice(0, 3).join(" / ") || "设备控制"}（点击中止执行，不影响对话）`
        : "执行通道空闲：下达指令后将在后台异步执行，不阻塞继续对话";

    speakChip.classList.toggle("is-speak", speaking && !ducked);
    speakChip.classList.toggle("is-ducked", speaking && ducked);
    speakVal.textContent = ducked
      ? "降音避让"
      : speaking
        ? speakQueueLen > 0
          ? `播报 +${speakQueueLen}`
          : "播报中"
        : "静音";
    speakChip.title = speaking
      ? `正在独立通道播报${this.localClientState.speakingText ? `：“${this.localClientState.speakingText.slice(0, 24)}”` : ""}（点击仅停止播报，不影响后台执行与对话）`
      : "播报通道待命：启用实时回声消除与多句防回声门控";
  }

  private renderVoiceTelemetry(): void {
    const wrap = document.getElementById("pi-voice-telemetry");
    if (!wrap) return;
    const vs = this.voiceState;
    const cfg = this.agentState?.config;
    const tags: Array<{ label: string; warn?: boolean; title?: string }> = [];

    if (vs?.localEngine?.readyForLocalAsr) {
      const streamingOn =
        (vs?.qwen3StreamingEnabled ?? cfg?.qwen3StreamingEnabled ?? true) !== false;
      if (vs.localEngine.primaryAsrEngine === "qwen3-asr") {
        const isRemote = vs.localEngine.activeQwen3Device === "remote";
        const isGpu = vs.localEngine.activeQwen3Device === "gpu";
        const gpuName = vs.localEngine.gpu?.deviceName;
        tags.push({
          label: isRemote
            ? "Qwen3-ASR 0.6B · 在线 GPU"
            : isGpu
              ? "Qwen3-ASR 0.6B · GPU"
              : "Qwen3-ASR 0.6B · CPU",
          title: isRemote
            ? `主方案在线 Qwen3-ASR-0.6B (${gpuName || "远程 GPU"})${vs.localEngine.readyForSenseVoice ? " · 本地模型热待命兜底" : ""}`
            : isGpu
              ? `主方案 Qwen3-ASR-0.6B GPU 加速 (${gpuName || "GPU"})${vs.localEngine.readyForSenseVoice ? " · SenseVoice 备用热待命" : ""}`
              : vs.localEngine.readyForSenseVoice
                ? "主方案 Qwen3-ASR-0.6B (CPU) 已就绪 · SenseVoice 备用热待命"
                : "主方案 Qwen3-ASR-0.6B (CPU) 已就绪",
        });
      } else {
        tags.push({
          label:
            vs.localEngine.activeLocalAsrMode === "sensevoice"
              ? "SenseVoice 备用"
              : "SenseVoice 兜底",
          warn: vs.localEngine.activeLocalAsrMode === "auto" && !vs.localEngine.readyForQwen3Asr,
          title:
            vs.localEngine.activeLocalAsrMode === "sensevoice"
              ? "当前已手动切换至 SenseVoice 备用方案"
              : "Qwen3-ASR 主模型尚未就绪，当前自动使用 SenseVoice 储备方案",
        });
      }
      if (streamingOn) {
        tags.push({
          label: "流式转写",
          title: "已开启实时流式转写与智能断句（可在设置中随时关闭）",
        });
      }
    }
    const owwOn = (vs?.owwEnabled ?? cfg?.owwEnabled ?? true) !== false;
    const owwReady = Boolean(vs?.localEngine?.readyForWakeWord ?? vs?.localEngine?.models?.openWakeWord);
    if (owwOn && owwReady) {
      tags.push({ label: "openWakeWord" });
    }
    const pipelineMode = vs?.voicePipelineMode ?? cfg?.voicePipelineMode ?? "legacy";
    if (pipelineMode === "clearvoice") {
      const cvStatus = vs?.localEngine?.clearVoice;
      const cvReady = Boolean(vs?.localEngine?.readyForClearVoiceGpu ?? cvStatus?.ready);
      const cvBssReady = Boolean(vs?.localEngine?.readyForClearVoiceBss ?? cvStatus?.multiTrackReady);
      const provTag =
        cvStatus?.provider === "cuda"
          ? "CUDA GPU"
          : cvStatus?.provider === "remote"
            ? "在线 GPU"
            : cvReady
              ? "CPU"
              : "未就绪";
      tags.push({
        label: cvBssReady ? `ClearVoice BSS+SE · ${provTag}` : `ClearVoice · ${provTag}`,
        warn: !cvReady,
        title: cvReady
          ? cvBssReady
            ? `ClearVoice 多轨盲源分离 (MossFormer2_SS_16K) + 分轨降噪去背景音 (MossFormer2_SE_48K · ${cvStatus?.gpuName || provTag}) → 分轨独立声纹/ASR/逻辑判定`
            : `ClearVoice MossFormer2_SE_48K 准实时切片降噪 (${cvStatus?.gpuName || provTag}) → 独立声纹/Qwen3-ASR/逻辑判定`
          : "ClearVoice GPU 运行时或 MossFormer2 模型尚未就绪（自动兜底本地降噪）",
      });
    } else if (vs?.noiseSuppressionMode !== "off") {
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

    const thinkingLevel = this.currentThinkingLevel();
    if (thinkingLevel !== "off") {
      tags.push({
        label: `思考 · ${THINKING_LEVEL_BADGE_LABELS[thinkingLevel]}`,
        title: `AI 思考等级：${THINKING_LEVEL_LABELS[thinkingLevel]}（思考过程仅展示在对话框，不语音播报）`,
      });
    }

    const vpCount = vs?.voiceprints?.length ?? 0;
    if (vs?.voiceprintMode && vs.voiceprintMode !== "off" && vpCount > 0) {
      tags.push({ label: `声纹(${vpCount})` });
    }

    if (this.isAsyncPipelineEnabled()) {
      tags.push({
        label: "异步三轨",
        title: "对话、任务执行与语音播报已异步解耦，可同时进行互不阻塞",
      });
    }
    const echoMode = cfg?.echoCancellationMode ?? vs?.echoCancellationMode ?? "auto";
    if (echoMode !== "off") {
      const erle = Math.max(this.localClientState.erleDb, vs?.lanes?.echo.erleDb ?? 0);
      const suppressed = vs?.lanes?.echo.suppressedCount ?? 0;
      const aecLabel =
        echoMode === "aggressive"
          ? erle > 1
            ? `AEC 强效 ${erle.toFixed(0)}dB`
            : "AEC 强效"
          : echoMode === "standard"
            ? "回声门控"
            : erle > 1
              ? `AEC ${erle.toFixed(0)}dB`
              : "AEC 回声消除";
      tags.push({
        label: aecLabel,
        title: `回声处理模式：${echoMode}${erle > 0 ? ` · 回声抑制比 ${erle.toFixed(1)} dB` : ""}${suppressed > 0 ? ` · 已过滤回声 ${suppressed} 次` : ""}`,
      });
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
      const passBadge =
        m.attention.passSource === "implicit_capability"
          ? "隐式设备能力"
          : m.attention.passSource === "pending_confirmation"
            ? "待确认回复"
            : m.attention.passSource === "acoustic_wake_recovery"
              ? "声学唤醒恢复"
              : "";
      const capSuffix = m.attention.matchedCapability ? ` (${m.attention.matchedCapability})` : "";
      details.push(
        m.attention.accept
          ? `✓ ${passBadge ? `[${passBadge}${capSuffix}] ` : ""}${m.attention.reason}`
          : `⊘ ${m.attention.reason}`,
      );
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

  private renderVoiceTracksPanel(): void {
    const panel = document.getElementById("pi-voice-tracks-panel");
    const list = document.getElementById("pi-tracks-list");
    const countBadge = document.getElementById("pi-tracks-count-badge");
    const engineBadge = document.getElementById("pi-tracks-engine-badge");
    const toggleBtn = document.getElementById("pi-tracks-toggle-btn");
    if (!panel || !list || !countBadge || !engineBadge || !toggleBtn) return;

    const livePartials = this.livePartialTracks;
    const batch = this.voiceState?.lastTrackBatch ?? this.voiceState?.lastMetrics?.trackBatch ?? null;

    const hasLive = livePartials.length > 0;
    const hasBatch = Boolean(batch && Array.isArray(batch.tracks) && batch.tracks.length > 0);
    if (!hasLive && !hasBatch) {
      panel.hidden = true;
      list.replaceChildren();
      return;
    }

    panel.hidden = false;
    toggleBtn.setAttribute("aria-expanded", String(this.tracksExpanded));
    toggleBtn.textContent = this.tracksExpanded ? "收起" : "展开";
    list.hidden = !this.tracksExpanded;
    list.replaceChildren();

    if (hasLive) {
      countBadge.textContent = `${livePartials.length} 轨实时转写中`;
      countBadge.classList.add("is-live");
      countBadge.classList.toggle("is-multi", livePartials.length > 1);
      engineBadge.hidden = false;
      engineBadge.textContent = "分轨流式预览";

      if (!this.tracksExpanded) return;

      for (const pt of livePartials) {
        const card = document.createElement("div");
        const colorIdx = ((pt.trackIndex - 1) % 3) + 1;
        card.className = `pi-track-card is-streaming track-color-${colorIdx}`;
        card.setAttribute("role", "listitem");
        card.dataset.trackIndex = String(pt.trackIndex);

        const head = document.createElement("div");
        head.className = "pi-track-head";

        const trackPill = document.createElement("span");
        trackPill.className = `pi-track-badge track-color-${colorIdx}`;
        trackPill.textContent = `音轨 ${pt.trackIndex}`;

        const verdict = document.createElement("span");
        verdict.className = "pi-track-verdict is-streaming";
        verdict.textContent = "… 识别中";

        head.append(trackPill, verdict);

        const body = document.createElement("div");
        body.className = "pi-track-text";
        body.textContent = pt.text;

        card.append(head, body);
        list.appendChild(card);
      }
      return;
    }

    if (!batch) return;
    const tracks = batch.tracks;
    countBadge.classList.remove("is-live");
    countBadge.classList.toggle("is-multi", tracks.length > 1);
    countBadge.textContent =
      tracks.length > 1
        ? `${tracks.length} 轨独立 · ${batch.acceptedCount} 命中`
        : batch.acceptedCount > 0
          ? "1 轨 · 已命中"
          : "1 轨";

    engineBadge.hidden = false;
    const engineLabel = batch.bssUsed ? "BSS+SE" : "SE";
    engineBadge.textContent =
      batch.totalMs > 0 ? `${engineLabel} ${Math.round(batch.totalMs)}ms` : engineLabel;

    if (!this.tracksExpanded) return;

    for (const tr of tracks) {
      const card = document.createElement("div");
      const colorIdx = ((tr.trackIndex - 1) % 3) + 1;
      const verdictClass = !tr.speechDetected
        ? "is-silent"
        : tr.matched && tr.wokeOnly
          ? "is-woke"
          : tr.matched
            ? "is-accepted"
            : "is-rejected";
      card.className = `pi-track-card ${verdictClass} track-color-${colorIdx}`;
      card.setAttribute("role", "listitem");
      card.dataset.trackIndex = String(tr.trackIndex);
      card.dataset.trackId = tr.trackId;

      const head = document.createElement("div");
      head.className = "pi-track-head";

      const leftGroup = document.createElement("div");
      leftGroup.className = "pi-track-head-left";

      const trackPill = document.createElement("span");
      trackPill.className = `pi-track-badge track-color-${colorIdx}`;
      trackPill.textContent = `音轨 ${tr.trackIndex}`;
      leftGroup.appendChild(trackPill);

      const vp = tr.voiceprint;
      if (vp?.evaluated) {
        const vpPill = document.createElement("span");
        const vpMatched = Boolean(vp.matched && vp.speakerName);
        vpPill.className = `pi-track-vp-badge${vpMatched ? " is-matched" : ""}`;
        const pct = typeof vp.score === "number" ? ` ${Math.round(vp.score * 100)}%` : "";
        vpPill.textContent = vpMatched ? `声纹: ${vp.speakerName}${pct}` : `未知声纹${pct}`;
        leftGroup.appendChild(vpPill);
      }

      const verdict = document.createElement("span");
      verdict.className = `pi-track-verdict ${verdictClass}`;
      if (!tr.speechDetected) {
        verdict.textContent = "无有效语音";
      } else if (tr.matched && tr.wokeOnly) {
        verdict.textContent = "⚡ 已唤醒";
      } else if (tr.matched) {
        verdict.textContent = tr.dispatchedAsync ? "✓ 已派发执行" : "✓ 已执行";
      } else if (tr.attention?.stage === "echo") {
        verdict.textContent = "⊘ 回声过滤";
      } else if (tr.attention?.stage === "voiceprint") {
        verdict.textContent = "⊘ 声纹拦截";
      } else if (tr.attention?.stage === "exit") {
        verdict.textContent = "↪ 退出对话";
      } else {
        verdict.textContent = "⊘ 已忽略";
      }
      if (tr.attention?.reason) {
        verdict.title = tr.attention.reason;
      }

      head.append(leftGroup, verdict);

      const body = document.createElement("div");
      body.className = `pi-track-text${!tr.text ? " is-empty" : ""}`;
      body.textContent = tr.text || "（该音轨未检测到有效语音文字）";

      const footParts: string[] = [];
      if (tr.matched && tr.command) {
        footParts.push(`指令：“${tr.command}”`);
      } else if (tr.attention?.reason && tr.speechDetected) {
        footParts.push(`判定：${tr.attention.reason}`);
      }
      if (tr.reply) {
        const shortReply = tr.reply.length > 34 ? `${tr.reply.slice(0, 34)}…` : tr.reply;
        footParts.push(`回复：${shortReply}`);
      }
      if (typeof tr.energyRatio === "number" && tracks.length > 1) {
        footParts.push(`能量 ${Math.round(tr.energyRatio * 100)}%`);
      }
      if (typeof tr.snrGainDb === "number" && tr.snrGainDb > 0) {
        footParts.push(`降噪 +${tr.snrGainDb.toFixed(1)}dB`);
      }

      card.append(head, body);
      if (footParts.length > 0) {
        const foot = document.createElement("div");
        foot.className = "pi-track-foot";
        foot.textContent = footParts.join(" · ");
        card.appendChild(foot);
      }

      list.appendChild(card);
    }
  }

  private renderTimeline(): void {
    const list = node("pi-agent-timeline");
    const emptyBox = node("pi-agent-empty");
    const entries = this.agentState?.timeline ?? [];

    if (entries.length === 0) {
      this.thinkingCollapsed.clear();
      list.replaceChildren();
      emptyBox.hidden = false;
      return;
    }

    emptyBox.hidden = true;
    list.replaceChildren();

    const activeIds = new Set(entries.map((e) => e.id));
    for (const id of this.thinkingCollapsed.keys()) {
      if (!activeIds.has(id)) {
        this.thinkingCollapsed.delete(id);
      }
    }

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
      meta.appendChild(roleSpan);
      if (entry.role === "user" && entry.source === "voice" && typeof entry.trackIndex === "number") {
        const trTag = document.createElement("span");
        const colorIdx = ((entry.trackIndex - 1) % 3) + 1;
        trTag.className = `pi-msg-track-badge track-color-${colorIdx}`;
        const countSuffix =
          typeof entry.trackCount === "number" && entry.trackCount > 1
            ? `/${entry.trackCount}`
            : "";
        const spkSuffix = entry.speakerName ? ` · ${entry.speakerName}` : "";
        trTag.textContent = `音轨 ${entry.trackIndex}${countSuffix}${spkSuffix}`;
        meta.appendChild(trTag);
      }
      const timeSpan = document.createElement("span");
      timeSpan.className = "pi-msg-time";
      timeSpan.textContent = formatTime(entry.timestamp);
      meta.appendChild(timeSpan);
      item.appendChild(meta);

      // Immediate task acknowledgement ("好的") rendered BEFORE execution & verification
      if (entry.role === "assistant" && entry.ackText) {
        const ackPill = document.createElement("div");
        ackPill.className = "pi-ack-pill";
        const ackDot = document.createElement("span");
        ackDot.className = "pi-ack-dot";
        ackDot.setAttribute("aria-hidden", "true");
        const ackSpan = document.createElement("span");
        ackSpan.textContent = entry.ackText;
        ackPill.append(ackDot, ackSpan);
        item.appendChild(ackPill);
      }

      // AI Thinking / Reasoning process (display-only in dialog box, never spoken)
      const thinkingText = typeof entry.thinking === "string" ? entry.thinking : "";
      if (entry.role === "assistant" && (thinkingText.trim().length > 0 || entry.thinkingActive)) {
        const card = document.createElement("details");
        card.className = `pi-thinking-card${entry.thinkingActive ? " is-streaming" : ""}`;
        card.open = this.thinkingCollapsed.get(entry.id) !== true;
        card.addEventListener("toggle", () => {
          this.thinkingCollapsed.set(entry.id, !card.open);
        });

        const head = document.createElement("summary");
        head.className = "pi-thinking-head";

        const dot = document.createElement("span");
        dot.className = "pi-thinking-dot";
        dot.setAttribute("aria-hidden", "true");

        const title = document.createElement("span");
        title.className = "pi-thinking-title";
        title.textContent = entry.thinkingActive ? "思考中…" : "思考过程";

        head.append(dot, title);

        const level = entry.thinkingLevel ? normalizeUiThinkingLevel(entry.thinkingLevel) : "off";
        if (level !== "off") {
          const levelTag = document.createElement("span");
          levelTag.className = "pi-thinking-level-tag";
          levelTag.textContent = THINKING_LEVEL_BADGE_LABELS[level];
          head.appendChild(levelTag);
        }

        const muteTag = document.createElement("span");
        muteTag.className = "pi-thinking-mute-tag";
        muteTag.textContent = "不播报";
        muteTag.title = "思考过程仅在对话框展示，不会语音播报";
        head.appendChild(muteTag);

        const chevron = document.createElement("span");
        chevron.className = "pi-thinking-chevron";
        chevron.setAttribute("aria-hidden", "true");
        chevron.textContent = "▾";
        head.appendChild(chevron);

        const body = document.createElement("div");
        body.className = "pi-thinking-body";
        body.dataset.agentMsgThinking = entry.id;
        body.textContent = thinkingText || "正在思考…";

        card.append(head, body);
        item.appendChild(card);
      }

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

      // Self-healing retry notices ("出了什么问题 + 准备怎么做")
      const retryUpdates = (entry.taskUpdates ?? []).filter((u) => u.kind === "retry");
      if (entry.role === "assistant" && retryUpdates.length > 0) {
        const retryWrap = document.createElement("div");
        retryWrap.className = "pi-retry-list";
        for (const ru of retryUpdates) {
          const card = document.createElement("div");
          card.className = "pi-retry-card";

          const head = document.createElement("div");
          head.className = "pi-retry-head";
          head.textContent = `↻ 第 ${ru.attempt ?? 1}/${ru.maxAttempts ?? 3} 轮自愈重试`;

          const body = document.createElement("div");
          body.className = "pi-retry-body";
          body.textContent =
            ru.problem && ru.plan
              ? `问题：${ru.problem}\n做法：${ru.plan}`
              : ru.text;

          card.append(head, body);
          retryWrap.appendChild(card);
        }
        item.appendChild(retryWrap);
      }

      // State verification, Skill & Reinforcement Memory status pills
      if (entry.role === "assistant" && (entry.verification || entry.skillEvent || entry.memoryEvent)) {
        const pillsRow = document.createElement("div");
        pillsRow.className = "pi-status-pills";

        if (entry.verification && entry.verification.status !== "skipped") {
          const v = entry.verification;
          const vPill = document.createElement("span");
          vPill.className = `pi-verify-pill is-${v.status}`;
          if (v.status === "passed") {
            vPill.textContent = entry.silentCompleted
              ? "✓ 状态检查通过 · 静默完成"
              : "✓ 状态检查通过";
          } else if (v.status === "recovered") {
            vPill.textContent = `✓ 第 ${v.retriesUsed} 轮自愈后检查通过`;
          } else if (v.status === "unsolvable") {
            vPill.textContent = "⊘ 评估不可自动解决";
          } else {
            vPill.textContent = `✕ 重试 ${v.retriesUsed}/${v.maxRetries} 轮后仍未解决`;
          }
          if (v.analysis) vPill.title = v.analysis;
          pillsRow.appendChild(vPill);
        }

        if (entry.skillEvent) {
          const sPill = document.createElement("span");
          sPill.className = "pi-skill-pill";
          sPill.textContent =
            entry.skillEvent.kind === "reused"
              ? `⚡ 已复用 Skill：${entry.skillEvent.skillName}`
              : `⚡ 已沉淀为 Skill：${entry.skillEvent.skillName}`;
          if (entry.skillEvent.pitfall) {
            sPill.title = `避坑记录：${entry.skillEvent.pitfall}`;
          }
          pillsRow.appendChild(sPill);
        }

        if (entry.memoryEvent) {
          const me = entry.memoryEvent;
          const mPill = document.createElement("span");
          const cls =
            me.kind === "autonomous_executed" ||
            me.kind === "promoted_autonomous" ||
            me.kind === "recovered_autonomous"
              ? "is-autonomous"
              : me.kind === "safety_confirmed" || me.riskLevel === "L3_HIGH_SAFETY"
                ? "is-safety"
                : "is-confirm";
          mPill.className = `pi-memory-pill ${cls}`;
          if (me.kind === "confirmation_requested") {
            mPill.textContent =
              me.riskLevel === "L3_HIGH_SAFETY"
                ? "🔒 安全确认 · 暂未执行"
                : `🧠 渐进确认 (${me.confirmCount ?? 0}/${me.confirmThreshold ?? 2})`;
          } else if (me.kind === "learned_progress") {
            mPill.textContent = `🧠 已记录决策 (${me.confirmCount ?? 1}/${me.confirmThreshold ?? 2})`;
          } else if (me.kind === "promoted_autonomous") {
            mPill.textContent = "🧠 已晋升自主执行 · 下次免问";
          } else if (me.kind === "autonomous_executed") {
            mPill.textContent = "🧠 命中强化记忆 · 免确认直行";
          } else if (me.kind === "recovered_autonomous") {
            mPill.textContent = "🧠 休眠重确认通过 · 已恢复直行";
          } else if (me.kind === "safety_confirmed") {
            mPill.textContent = "🔒 安全锁记忆 · 每次必确认";
          } else if (me.kind === "modified") {
            mPill.textContent = `🧠 已更新目标映射 (${me.confirmCount ?? 1}/${me.confirmThreshold ?? 2})`;
          } else if (me.kind === "rejected") {
            mPill.textContent = "⊘ 已重置映射偏好";
          } else {
            mPill.textContent = `🧠 ${me.reasonText || me.summary}`;
          }
          mPill.title = me.reasonText ? `${me.summary}（${me.reasonText}）` : me.summary;
          pillsRow.appendChild(mPill);
        }

        if (pillsRow.childElementCount > 0) {
          item.appendChild(pillsRow);
        }
      }

      const bubbleText =
        entry.text ||
        (entry.status === "streaming"
          ? entry.thinkingActive
            ? "正在思考中…"
            : "正在执行并核验设备状态…"
          : "");
      if (bubbleText) {
        const bubble = document.createElement("div");
        bubble.className = "pi-msg-bubble";
        bubble.dataset.agentMsgText = entry.id;
        bubble.textContent = bubbleText;
        item.appendChild(bubble);
      }

      // Inline quick confirm / cancel action buttons for the currently active pending confirmation
      const activePendingId = this.agentState?.pendingConfirmation?.id;
      if (
        entry.role === "assistant" &&
        entry.pendingConfirmation &&
        activePendingId &&
        entry.pendingConfirmation.id === activePendingId
      ) {
        const pc = entry.pendingConfirmation;
        const busy = this.resolvingConfirmIds.has(pc.id);
        const actionsBar = document.createElement("div");
        actionsBar.className = "pi-confirm-actions";

        if (pc.candidateLabels && pc.candidateLabels.length > 1) {
          pc.candidateLabels.forEach((label, idx) => {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "pi-confirm-btn is-primary";
            btn.disabled = busy;
            btn.textContent = `✓ ${label}`;
            btn.addEventListener("click", () => {
              void this.resolveConfirmation(pc.id, "confirm", idx);
            });
            actionsBar.appendChild(btn);
          });
        } else {
          const okBtn = document.createElement("button");
          okBtn.type = "button";
          okBtn.className = "pi-confirm-btn is-primary";
          okBtn.disabled = busy;
          okBtn.textContent = busy ? "执行中…" : "✓ 确认执行";
          okBtn.addEventListener("click", () => {
            void this.resolveConfirmation(pc.id, "confirm");
          });
          actionsBar.appendChild(okBtn);
        }

        const cancelBtn = document.createElement("button");
        cancelBtn.type = "button";
        cancelBtn.className = "pi-confirm-btn is-cancel";
        cancelBtn.disabled = busy;
        cancelBtn.textContent = "✕ 取消";
        cancelBtn.addEventListener("click", () => {
          void this.resolveConfirmation(pc.id, "cancel");
        });
        actionsBar.appendChild(cancelBtn);
        item.appendChild(actionsBar);
      }

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
    const execCount = this.activeTaskCount();
    const sendBtn = node<HTMLButtonElement>("pi-agent-send-btn");
    const stopBtn = document.getElementById("pi-agent-stop-btn") as HTMLButtonElement | null;
    sendBtn.textContent = "发送";
    sendBtn.classList.add("primary-button");
    sendBtn.classList.remove("danger-button");
    if (stopBtn) {
      stopBtn.hidden = execCount === 0;
      stopBtn.textContent = execCount > 1 ? `停止 (${execCount})` : "停止执行";
    }
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
      if (this.livePartialTracks.length > 1) {
        textEl.textContent = this.livePartialTracks
          .map((t) => `[轨${t.trackIndex}] ${t.text}`)
          .join("  |  ");
      } else if (interim) {
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
