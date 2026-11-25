// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * 内置 Pi Agent 与语音监听配置的本地持久化（pi_agent.json）。
 * API Key 仅存储在服务端数据目录，面向前端序列化时一律脱敏。
 */

import { dataFile, readJson, writeJson } from "./jsonStore.ts";

export const AGENT_CONFIG_VERSION = 2;
const FILENAME = "pi_agent.json";

export type AgentProviderMode =
  | "local"
  | "openai"
  | "anthropic"
  | "google"
  | "deepseek"
  | "moonshot"
  | "xiaomi"
  | "openrouter"
  | "openai-compatible";

export type VoiceEngineMode = "auto" | "local" | "browser" | "whisper";
export type TtsEngineMode = "auto" | "local" | "browser";
export type TtsVoicePreset = "gentle-zh-en" | "warm-zh-baker";
export type NoiseSuppressionMode = "auto" | "neural" | "dpdfnet" | "voxlock" | "dsp" | "off";
export type SourceSeparationMode = "auto" | "fast" | "full" | "off";
export type VadEngineMode = "silero" | "adaptive";
export type VadSensitivityMode = "aggressive" | "default" | "relaxed";
export type VoiceprintPolicyMode = "off" | "tag" | "strict";
export type AttentionMode = "smart" | "strict" | "off";
export type SystemOneMode = "auto" | "on" | "off";
export type CavemanReplyMode = "ultra" | "full" | "lite" | "off";
export type CustomApiType =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages"
  | "google-generative-ai";

export interface ProviderPreset {
  id: AgentProviderMode;
  label: string;
  description: string;
  defaultModel: string;
  suggestedModels: string[];
  defaultBaseUrl: string;
  requiresApiKey: boolean;
  envProvider?: string;
}

export const PROVIDER_PRESETS: ReadonlyArray<ProviderPreset> = [
  {
    id: "local",
    label: "内置本地引擎（免 API Key）",
    description: "零延迟本地智能家居规划引擎，经由 Pi Agent 工具循环执行常见开关、调光、传感器、场景与喂食指令",
    defaultModel: "mijia-local-planner",
    suggestedModels: ["mijia-local-planner"],
    defaultBaseUrl: "",
    requiresApiKey: false,
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    description: "高性价比中文大模型，适合自然语言智能家居控制",
    defaultModel: "deepseek-chat",
    suggestedModels: ["deepseek-chat", "deepseek-reasoner"],
    defaultBaseUrl: "https://api.deepseek.com",
    requiresApiKey: true,
    envProvider: "deepseek",
  },
  {
    id: "openai",
    label: "OpenAI",
    description: "OpenAI 官方接口（GPT-4o / GPT-4.1 / GPT-5 等）",
    defaultModel: "gpt-4o-mini",
    suggestedModels: ["gpt-4o-mini", "gpt-4.1-mini", "gpt-4o", "gpt-5-mini"],
    defaultBaseUrl: "https://api.openai.com/v1",
    requiresApiKey: true,
    envProvider: "openai",
  },
  {
    id: "anthropic",
    label: "Anthropic Claude",
    description: "Claude 系列模型，擅长复杂多步推理与工具编排",
    defaultModel: "claude-sonnet-4-5",
    suggestedModels: ["claude-sonnet-4-5", "claude-haiku-4-5", "claude-opus-4-1"],
    defaultBaseUrl: "https://api.anthropic.com",
    requiresApiKey: true,
    envProvider: "anthropic",
  },
  {
    id: "google",
    label: "Google Gemini",
    description: "Gemini 系列模型，响应迅速",
    defaultModel: "gemini-2.5-flash",
    suggestedModels: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.0-flash"],
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    requiresApiKey: true,
    envProvider: "google",
  },
  {
    id: "moonshot",
    label: "Moonshot / Kimi",
    description: "月之暗面 Kimi 大模型",
    defaultModel: "kimi-k2-0905-preview",
    suggestedModels: ["kimi-k2-0905-preview", "moonshot-v1-8k"],
    defaultBaseUrl: "https://api.moonshot.cn/v1",
    requiresApiKey: true,
    envProvider: "moonshotai-cn",
  },
  {
    id: "xiaomi",
    label: "小米 MiMo",
    description: "小米 MiMo 大模型开放平台",
    defaultModel: "mimo-v2-flash",
    suggestedModels: ["mimo-v2-flash"],
    defaultBaseUrl: "https://api.xiaomimimo.com/v1",
    requiresApiKey: true,
    envProvider: "xiaomi",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    description: "统一聚合网关，支持多厂商模型",
    defaultModel: "openai/gpt-4o-mini",
    suggestedModels: ["openai/gpt-4o-mini", "anthropic/claude-3.5-sonnet", "deepseek/deepseek-chat"],
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    requiresApiKey: true,
    envProvider: "openrouter",
  },
  {
    id: "openai-compatible",
    label: "自定义配置（OpenAI / Anthropic / Gemini 兼容）",
    description: "在界面中自定义提供商名称、API 协议、Base URL 与密钥，自动从接口拉取模型列表（支持代理网关、Ollama、通义千问、SiliconFlow 等）",
    defaultModel: "",
    suggestedModels: [],
    defaultBaseUrl: "",
    requiresApiKey: false,
  },
];

const VALID_PROVIDERS = new Set<string>(PROVIDER_PRESETS.map((p) => p.id));
const VALID_VOICE_ENGINES = new Set<string>(["auto", "local", "browser", "whisper"]);
const VALID_TTS_ENGINES = new Set<string>(["auto", "local", "browser"]);
const VALID_TTS_VOICES = new Set<string>(["gentle-zh-en", "warm-zh-baker"]);
const VALID_NOISE_MODES = new Set<string>(["auto", "neural", "dpdfnet", "voxlock", "dsp", "off"]);
const VALID_SOURCE_SEP_MODES = new Set<string>(["auto", "fast", "full", "off"]);
const VALID_VAD_MODES = new Set<string>(["silero", "adaptive"]);
const VALID_VAD_SENSITIVITIES = new Set<string>(["aggressive", "default", "relaxed"]);
const VALID_VOICEPRINT_MODES = new Set<string>(["off", "tag", "strict"]);
const VALID_ATTENTION_MODES = new Set<string>(["smart", "strict", "off"]);
const VALID_SYSTEMONE_MODES = new Set<string>(["auto", "on", "off"]);
const VALID_CAVEMAN_MODES = new Set<string>(["ultra", "full", "lite", "off"]);
const CAVEMAN_MODE_ALIASES: Readonly<Record<string, CavemanReplyMode>> = {
  ultra: "ultra",
  ultracave: "ultra",
  "caveman-ultra": "ultra",
  full: "full",
  caveman: "full",
  lite: "lite",
  concise: "lite",
  off: "off",
  normal: "off",
};
export const DEFAULT_SYSTEMONE_MODEL = "karpo/karpo-decision-31b";
export const DEFAULT_CAVEMAN_MODE: CavemanReplyMode = "lite";
const VALID_CUSTOM_APIS = new Set<string>([
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
]);

export const DEFAULT_WAKE_WORDS = ["小派", "小湃", "小π", "派派", "pi", "米家助手"] as const;
export const DEFAULT_WAKE_ACK_PHRASE = "嗯?";
export const DEFAULT_TTS_ENGINE: TtsEngineMode = "auto";
export const DEFAULT_TTS_VOICE: TtsVoicePreset = "gentle-zh-en";
export const DEFAULT_TTS_SPEED = 0.98;

export interface AgentVoiceConfig {
  version: number;
  provider: AgentProviderMode;
  customProviderName: string;
  customApiType: CustomApiType;
  modelId: string;
  baseUrl: string;
  apiKey: string;
  systemPromptExtra: string;
  maxHistoryTurns: number;
  voiceEnabled: boolean;
  voiceEngine: VoiceEngineMode;
  voiceLang: string;
  wakeWordEnabled: boolean;
  wakeWords: string[];
  /** 命中唤醒词时的回复短语；默认为“嗯?”，显式设为空字符串则不回复并持续监听 */
  wakeAckPhrase: string;
  wakeWindowSec: number;
  autoSpeakReply: boolean;
  ttsEngine: TtsEngineMode;
  ttsVoice: TtsVoicePreset;
  ttsSpeed: number;
  continuousListen: boolean;
  vadThreshold: number;
  vadSilenceMs: number;
  vadSensitivity: VadSensitivityMode;
  noiseSuppressionMode: NoiseSuppressionMode;
  sourceSeparationMode: SourceSeparationMode;
  vadMode: VadEngineMode;
  // 借鉴 Home Assistant prefer_local_intents：常规智能家居控制指令优先走零延迟本地规划引擎，免去云端大模型往返（默认关闭，可在设置中手动开启）
  preferLocalIntents: boolean;
  voiceprintMode: VoiceprintPolicyMode;
  voiceprintThreshold: number;
  attentionMode: AttentionMode;
  conversationWindowSec: number;
  maxConsecutiveSidetalk: number;
  bargeInEnabled: boolean;
  // SystemOne 决策模型（karpo/karpo-decision-31b）配置
  systemOneMode: SystemOneMode;
  systemOneBaseUrl: string;
  systemOneApiKey: string;
  systemOneModel: string;
  systemOneTimeoutMs: number;
  systemOneConfidenceThreshold: number;
  // Caveman 极简回复风格（参考 juliusbrussee/caveman）
  cavemanMode: CavemanReplyMode;
  // openWakeWord 独立本地声学唤醒词优化（支持用户自定义唤醒词）
  owwEnabled: boolean;
  owwThreshold: number;
  sttBaseUrl: string;
  sttApiKey: string;
  sttModel: string;
}

export interface PublicAgentVoiceConfig
  extends Omit<AgentVoiceConfig, "apiKey" | "sttApiKey" | "systemOneApiKey"> {
  hasApiKey: boolean;
  apiKeyPreview: string;
  envApiKeyDetected: boolean;
  hasSttApiKey: boolean;
  sttApiKeyPreview: string;
  effectiveSttConfigured: boolean;
  hasSystemOneApiKey: boolean;
  systemOneApiKeyPreview: string;
  effectiveSystemOneBaseUrl: string;
  effectiveSystemOneConfigured: boolean;
}

export interface AgentConfigPatch {
  provider?: unknown;
  customProviderName?: unknown;
  customApiType?: unknown;
  modelId?: unknown;
  baseUrl?: unknown;
  apiKey?: unknown;
  clearApiKey?: unknown;
  systemPromptExtra?: unknown;
  maxHistoryTurns?: unknown;
  voiceEnabled?: unknown;
  voiceEngine?: unknown;
  voiceLang?: unknown;
  wakeWordEnabled?: unknown;
  wakeWords?: unknown;
  wakeAckPhrase?: unknown;
  wakeWindowSec?: unknown;
  autoSpeakReply?: unknown;
  ttsEngine?: unknown;
  ttsVoice?: unknown;
  ttsSpeed?: unknown;
  continuousListen?: unknown;
  vadThreshold?: unknown;
  vadSilenceMs?: unknown;
  vadSensitivity?: unknown;
  noiseSuppressionMode?: unknown;
  sourceSeparationMode?: unknown;
  vadMode?: unknown;
  preferLocalIntents?: unknown;
  voiceprintMode?: unknown;
  voiceprintThreshold?: unknown;
  attentionMode?: unknown;
  conversationWindowSec?: unknown;
  maxConsecutiveSidetalk?: unknown;
  bargeInEnabled?: unknown;
  systemOneMode?: unknown;
  systemOneBaseUrl?: unknown;
  systemOneApiKey?: unknown;
  clearSystemOneApiKey?: unknown;
  systemOneModel?: unknown;
  systemOneTimeoutMs?: unknown;
  systemOneConfidenceThreshold?: unknown;
  cavemanMode?: unknown;
  owwEnabled?: unknown;
  owwThreshold?: unknown;
  sttBaseUrl?: unknown;
  sttApiKey?: unknown;
  clearSttApiKey?: unknown;
  sttModel?: unknown;
}

export function defaultAgentVoiceConfig(): AgentVoiceConfig {
  return {
    version: AGENT_CONFIG_VERSION,
    provider: "local",
    customProviderName: "",
    customApiType: "openai-completions",
    modelId: "mijia-local-planner",
    baseUrl: "",
    apiKey: "",
    systemPromptExtra: "",
    maxHistoryTurns: 12,
    voiceEnabled: true,
    voiceEngine: "auto",
    voiceLang: "zh-CN",
    wakeWordEnabled: true,
    wakeWords: [...DEFAULT_WAKE_WORDS],
    wakeAckPhrase: DEFAULT_WAKE_ACK_PHRASE,
    wakeWindowSec: 12,
    autoSpeakReply: true,
    ttsEngine: DEFAULT_TTS_ENGINE,
    ttsVoice: DEFAULT_TTS_VOICE,
    ttsSpeed: DEFAULT_TTS_SPEED,
    continuousListen: true,
    vadThreshold: 0.018,
    vadSilenceMs: 600,
    vadSensitivity: "default",
    noiseSuppressionMode: "auto",
    sourceSeparationMode: "auto",
    vadMode: "silero",
    preferLocalIntents: false,
    voiceprintMode: "tag",
    voiceprintThreshold: 0.42,
    attentionMode: "smart",
    conversationWindowSec: 25,
    maxConsecutiveSidetalk: 3,
    bargeInEnabled: true,
    systemOneMode: "auto",
    systemOneBaseUrl: "",
    systemOneApiKey: "",
    systemOneModel: DEFAULT_SYSTEMONE_MODEL,
    systemOneTimeoutMs: 2000,
    systemOneConfidenceThreshold: 0.65,
    cavemanMode: DEFAULT_CAVEMAN_MODE,
    owwEnabled: true,
    owwThreshold: 0.6,
    sttBaseUrl: "",
    sttApiKey: "",
    sttModel: "whisper-1",
  };
}

export function getProviderPreset(provider: AgentProviderMode): ProviderPreset {
  return PROVIDER_PRESETS.find((p) => p.id === provider) ?? PROVIDER_PRESETS[0]!;
}

export function maskSecret(secret: string): string {
  const trimmed = secret.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.length <= 8) {
    return "••••••";
  }
  return `${trimmed.slice(0, 4)}••••${trimmed.slice(-4)}`;
}

export function normalizeWakeWords(input: unknown): string[] {
  let parts: string[];
  if (Array.isArray(input)) {
    parts = input.map((item) => String(item ?? ""));
  } else if (typeof input === "string") {
    parts = input.split(/[,，、;\n]+/);
  } else {
    return [...DEFAULT_WAKE_WORDS];
  }
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const raw of parts) {
    const word = raw.trim();
    if (!word) continue;
    const key = word.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push(word);
  }
  return cleaned.length > 0 ? cleaned : [...DEFAULT_WAKE_WORDS];
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, num));
}

function normalizeUrl(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "";
    }
    return trimmed.replace(/\/+$/, "");
  } catch {
    return "";
  }
}

export function normalizeCavemanMode(
  value: unknown,
  fallback: CavemanReplyMode = DEFAULT_CAVEMAN_MODE,
): CavemanReplyMode {
  if (typeof value !== "string") return fallback;
  const key = value.trim().toLowerCase();
  return CAVEMAN_MODE_ALIASES[key] ?? fallback;
}

function normalizeSystemOneBaseUrl(value: unknown): string {
  const urlStr = normalizeUrl(value);
  if (!urlStr) return "";
  try {
    const parsed = new URL(urlStr);
    // Strip embedded credentials & query strings for safety
    const cleanPath = parsed.pathname.replace(/\/systemone\/?$/i, "").replace(/\/+$/, "");
    return `${parsed.origin}${cleanPath}`;
  } catch {
    return "";
  }
}

export function normalizeAgentVoiceConfig(raw: Record<string, unknown>): AgentVoiceConfig {
  const defaults = defaultAgentVoiceConfig();
  const providerRaw = typeof raw.provider === "string" ? raw.provider.trim() : defaults.provider;
  const provider: AgentProviderMode = VALID_PROVIDERS.has(providerRaw)
    ? (providerRaw as AgentProviderMode)
    : defaults.provider;
  const preset = getProviderPreset(provider);

  const modelRaw = typeof raw.modelId === "string" ? raw.modelId.trim() : "";
  const modelId = modelRaw || preset.defaultModel;

  const voiceEngineRaw =
    typeof raw.voiceEngine === "string" ? raw.voiceEngine.trim() : defaults.voiceEngine;
  const voiceEngine: VoiceEngineMode = VALID_VOICE_ENGINES.has(voiceEngineRaw)
    ? (voiceEngineRaw as VoiceEngineMode)
    : defaults.voiceEngine;

  const voiceLangRaw = typeof raw.voiceLang === "string" ? raw.voiceLang.trim() : "";
  const voiceLang = voiceLangRaw || defaults.voiceLang;

  const customApiRaw =
    typeof raw.customApiType === "string" ? raw.customApiType.trim() : defaults.customApiType;
  const customApiType: CustomApiType = VALID_CUSTOM_APIS.has(customApiRaw)
    ? (customApiRaw as CustomApiType)
    : defaults.customApiType;

  const noiseRaw =
    typeof raw.noiseSuppressionMode === "string"
      ? raw.noiseSuppressionMode.trim()
      : defaults.noiseSuppressionMode;
  const noiseSuppressionMode: NoiseSuppressionMode = VALID_NOISE_MODES.has(noiseRaw)
    ? (noiseRaw as NoiseSuppressionMode)
    : defaults.noiseSuppressionMode;

  const sepRaw =
    typeof raw.sourceSeparationMode === "string"
      ? raw.sourceSeparationMode.trim().toLowerCase()
      : defaults.sourceSeparationMode;
  const sourceSeparationMode: SourceSeparationMode = VALID_SOURCE_SEP_MODES.has(sepRaw)
    ? (sepRaw as SourceSeparationMode)
    : defaults.sourceSeparationMode;

  const vadModeRaw =
    typeof raw.vadMode === "string" ? raw.vadMode.trim() : defaults.vadMode;
  const vadMode: VadEngineMode = VALID_VAD_MODES.has(vadModeRaw)
    ? (vadModeRaw as VadEngineMode)
    : defaults.vadMode;

  const vadSensRaw =
    typeof raw.vadSensitivity === "string"
      ? raw.vadSensitivity.trim().toLowerCase()
      : defaults.vadSensitivity;
  const vadSensitivity: VadSensitivityMode = VALID_VAD_SENSITIVITIES.has(vadSensRaw)
    ? (vadSensRaw as VadSensitivityMode)
    : defaults.vadSensitivity;

  const vpModeRaw =
    typeof raw.voiceprintMode === "string"
      ? raw.voiceprintMode.trim()
      : defaults.voiceprintMode;
  const voiceprintMode: VoiceprintPolicyMode = VALID_VOICEPRINT_MODES.has(vpModeRaw)
    ? (vpModeRaw as VoiceprintPolicyMode)
    : defaults.voiceprintMode;

  const attModeRaw =
    typeof raw.attentionMode === "string"
      ? raw.attentionMode.trim()
      : defaults.attentionMode;
  const attentionMode: AttentionMode = VALID_ATTENTION_MODES.has(attModeRaw)
    ? (attModeRaw as AttentionMode)
    : defaults.attentionMode;

  const sysOneModeRaw =
    typeof raw.systemOneMode === "string"
      ? raw.systemOneMode.trim().toLowerCase()
      : defaults.systemOneMode;
  const systemOneMode: SystemOneMode = VALID_SYSTEMONE_MODES.has(sysOneModeRaw)
    ? (sysOneModeRaw as SystemOneMode)
    : defaults.systemOneMode;

  const cavemanMode = normalizeCavemanMode(raw.cavemanMode, defaults.cavemanMode);
  const sysOneModelRaw =
    typeof raw.systemOneModel === "string" ? raw.systemOneModel.trim().slice(0, 128) : "";

  const wakeAckPhrase =
    typeof raw.wakeAckPhrase === "string"
      ? raw.wakeAckPhrase.trim().slice(0, 64)
      : defaults.wakeAckPhrase;

  const ttsEngineRaw =
    typeof raw.ttsEngine === "string" ? raw.ttsEngine.trim().toLowerCase() : defaults.ttsEngine;
  const ttsEngine: TtsEngineMode = VALID_TTS_ENGINES.has(ttsEngineRaw)
    ? (ttsEngineRaw as TtsEngineMode)
    : defaults.ttsEngine;

  const ttsVoiceRaw =
    typeof raw.ttsVoice === "string" ? raw.ttsVoice.trim().toLowerCase() : defaults.ttsVoice;
  const ttsVoice: TtsVoicePreset = VALID_TTS_VOICES.has(ttsVoiceRaw)
    ? (ttsVoiceRaw as TtsVoicePreset)
    : defaults.ttsVoice;

  const ttsSpeed = Number(clampNumber(raw.ttsSpeed, 0.7, 1.4, defaults.ttsSpeed).toFixed(2));

  // v1 配置生成于本地快路径 UI 开关加入之前，当时 preferLocalIntents 默认自动写入为 true；
  // 升级到 v2 后统一默认关闭，用户可在设置中按需手动开启。
  const rawVersion = typeof raw.version === "number" ? raw.version : null;
  const preferLocalIntents =
    rawVersion !== null && rawVersion < 2
      ? false
      : typeof raw.preferLocalIntents === "boolean"
        ? raw.preferLocalIntents
        : defaults.preferLocalIntents;

  return {
    version: AGENT_CONFIG_VERSION,
    provider,
    customProviderName:
      typeof raw.customProviderName === "string" ? raw.customProviderName.trim().slice(0, 64) : "",
    customApiType,
    modelId,
    baseUrl: normalizeUrl(raw.baseUrl),
    apiKey: typeof raw.apiKey === "string" ? raw.apiKey.trim() : "",
    systemPromptExtra:
      typeof raw.systemPromptExtra === "string" ? raw.systemPromptExtra.trim().slice(0, 2000) : "",
    maxHistoryTurns: Math.round(clampNumber(raw.maxHistoryTurns, 2, 40, defaults.maxHistoryTurns)),
    voiceEnabled: typeof raw.voiceEnabled === "boolean" ? raw.voiceEnabled : defaults.voiceEnabled,
    voiceEngine,
    voiceLang,
    wakeWordEnabled:
      typeof raw.wakeWordEnabled === "boolean" ? raw.wakeWordEnabled : defaults.wakeWordEnabled,
    wakeWords: raw.wakeWords !== undefined ? normalizeWakeWords(raw.wakeWords) : defaults.wakeWords,
    wakeAckPhrase,
    wakeWindowSec: Math.round(clampNumber(raw.wakeWindowSec, 3, 60, defaults.wakeWindowSec)),
    autoSpeakReply:
      typeof raw.autoSpeakReply === "boolean" ? raw.autoSpeakReply : defaults.autoSpeakReply,
    ttsEngine,
    ttsVoice,
    ttsSpeed,
    continuousListen:
      typeof raw.continuousListen === "boolean" ? raw.continuousListen : defaults.continuousListen,
    vadThreshold: Number(clampNumber(raw.vadThreshold, 0.004, 0.3, defaults.vadThreshold).toFixed(4)),
    vadSilenceMs: Math.round(clampNumber(raw.vadSilenceMs, 300, 5000, defaults.vadSilenceMs)),
    vadSensitivity,
    noiseSuppressionMode,
    sourceSeparationMode,
    vadMode,
    preferLocalIntents,
    voiceprintMode,
    voiceprintThreshold: Number(
      clampNumber(raw.voiceprintThreshold, 0.2, 0.85, defaults.voiceprintThreshold).toFixed(2),
    ),
    attentionMode,
    conversationWindowSec: Math.round(
      clampNumber(raw.conversationWindowSec, 0, 120, defaults.conversationWindowSec),
    ),
    maxConsecutiveSidetalk: Math.round(
      clampNumber(raw.maxConsecutiveSidetalk, 1, 10, defaults.maxConsecutiveSidetalk),
    ),
    bargeInEnabled:
      typeof raw.bargeInEnabled === "boolean" ? raw.bargeInEnabled : defaults.bargeInEnabled,
    systemOneMode,
    systemOneBaseUrl: normalizeSystemOneBaseUrl(raw.systemOneBaseUrl),
    systemOneApiKey: typeof raw.systemOneApiKey === "string" ? raw.systemOneApiKey.trim() : "",
    systemOneModel: sysOneModelRaw || defaults.systemOneModel,
    systemOneTimeoutMs: Math.round(
      clampNumber(raw.systemOneTimeoutMs, 400, 8000, defaults.systemOneTimeoutMs),
    ),
    systemOneConfidenceThreshold: Number(
      clampNumber(
        raw.systemOneConfidenceThreshold,
        0.3,
        0.95,
        defaults.systemOneConfidenceThreshold,
      ).toFixed(2),
    ),
    cavemanMode,
    owwEnabled: typeof raw.owwEnabled === "boolean" ? raw.owwEnabled : defaults.owwEnabled,
    owwThreshold: Number(clampNumber(raw.owwThreshold, 0.25, 0.95, defaults.owwThreshold).toFixed(2)),
    sttBaseUrl: normalizeUrl(raw.sttBaseUrl),
    sttApiKey: typeof raw.sttApiKey === "string" ? raw.sttApiKey.trim() : "",
    sttModel:
      typeof raw.sttModel === "string" && raw.sttModel.trim()
        ? raw.sttModel.trim()
        : defaults.sttModel,
  };
}

const ENV_KEY_MAP: Readonly<Record<AgentProviderMode, readonly string[]>> = {
  local: [],
  openai: ["OPENAI_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
  google: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  moonshot: ["MOONSHOT_API_KEY"],
  xiaomi: ["XIAOMI_API_KEY", "MIMO_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  "openai-compatible": ["OPENAI_COMPATIBLE_API_KEY", "OPENAI_API_KEY"],
};

export function resolveEnvApiKeyForProvider(provider: AgentProviderMode): string | undefined {
  const vars = ENV_KEY_MAP[provider] ?? [];
  for (const name of vars) {
    const val = process.env[name]?.trim();
    if (val) return val;
  }
  return undefined;
}

export function resolveEffectiveApiKey(config: AgentVoiceConfig): string | undefined {
  if (config.apiKey.trim()) {
    return config.apiKey.trim();
  }
  return resolveEnvApiKeyForProvider(config.provider);
}

export function resolveEffectiveSttAuth(config: AgentVoiceConfig): {
  baseUrl: string;
  apiKey: string | undefined;
  model: string;
} {
  const baseUrl = config.sttBaseUrl || (config.provider === "openai" ? "https://api.openai.com/v1" : "");
  const apiKey =
    config.sttApiKey.trim() ||
    config.apiKey.trim() ||
    process.env.OPENAI_API_KEY?.trim() ||
    undefined;
  return {
    baseUrl,
    apiKey,
    model: config.sttModel || "whisper-1",
  };
}

export function isLocalEndpointUrl(urlStr: string): boolean {
  if (!urlStr) return false;
  try {
    const u = new URL(urlStr);
    return (
      u.hostname === "127.0.0.1" ||
      u.hostname === "localhost" ||
      u.hostname === "::1" ||
      u.hostname.endsWith(".local")
    );
  } catch {
    return false;
  }
}

export function resolveEffectiveSystemOneAuth(config: AgentVoiceConfig): {
  enabled: boolean;
  baseUrl: string;
  apiKey: string | undefined;
  model: string;
  timeoutMs: number;
  confidenceThreshold: number;
} {
  const model = config.systemOneModel.trim() || DEFAULT_SYSTEMONE_MODEL;
  const timeoutMs = config.systemOneTimeoutMs || 2000;
  const confidenceThreshold = config.systemOneConfidenceThreshold || 0.65;
  if (config.systemOneMode === "off") {
    return { enabled: false, baseUrl: "", apiKey: undefined, model, timeoutMs, confidenceThreshold };
  }

  const mainBaseUrl =
    config.provider === "local"
      ? ""
      : normalizeSystemOneBaseUrl(config.baseUrl) ||
        normalizeSystemOneBaseUrl(getProviderPreset(config.provider).defaultBaseUrl);
  const explicitBaseUrl = normalizeSystemOneBaseUrl(config.systemOneBaseUrl);
  const envBaseUrl = normalizeSystemOneBaseUrl(process.env.SYSTEMONE_BASE_URL ?? "");
  const effectiveBaseUrl = explicitBaseUrl || mainBaseUrl || envBaseUrl;

  let differentOriginFromMain = false;
  if (explicitBaseUrl) {
    if (!mainBaseUrl) {
      differentOriginFromMain = true;
    } else {
      try {
        differentOriginFromMain = new URL(explicitBaseUrl).origin !== new URL(mainBaseUrl).origin;
      } catch {
        differentOriginFromMain = true;
      }
    }
  }

  // 安全边界：绝不把主 LLM 提供商的 apiKey 转发到不同源的自定义 systemOneBaseUrl！
  const explicitKey = config.systemOneApiKey.trim();
  const envKey = process.env.SYSTEMONE_API_KEY?.trim() || process.env.KARPO_API_KEY?.trim() || undefined;
  const inheritedKey = !differentOriginFromMain ? resolveEffectiveApiKey(config) : undefined;
  const apiKey = explicitKey || inheritedKey || envKey || undefined;

  const enabled = Boolean(
    effectiveBaseUrl && (apiKey || isLocalEndpointUrl(effectiveBaseUrl)),
  );
  return {
    enabled,
    baseUrl: effectiveBaseUrl,
    apiKey,
    model,
    timeoutMs,
    confidenceThreshold,
  };
}

export function toPublicAgentVoiceConfig(config: AgentVoiceConfig): PublicAgentVoiceConfig {
  const envKey = resolveEnvApiKeyForProvider(config.provider);
  const stt = resolveEffectiveSttAuth(config);
  const effectiveSttConfigured = Boolean(
    stt.baseUrl && (stt.apiKey || isLocalEndpointUrl(stt.baseUrl)),
  );
  const sysOne = resolveEffectiveSystemOneAuth(config);
  const { apiKey, sttApiKey, systemOneApiKey, ...rest } = config;
  return {
    ...rest,
    hasApiKey: apiKey.trim().length > 0,
    apiKeyPreview: maskSecret(apiKey),
    envApiKeyDetected: Boolean(envKey),
    hasSttApiKey: sttApiKey.trim().length > 0,
    sttApiKeyPreview: maskSecret(sttApiKey),
    effectiveSttConfigured,
    hasSystemOneApiKey: systemOneApiKey.trim().length > 0,
    systemOneApiKeyPreview: maskSecret(systemOneApiKey),
    effectiveSystemOneBaseUrl: sysOne.baseUrl,
    effectiveSystemOneConfigured: sysOne.enabled,
  };
}

export function loadAgentVoiceConfig(): AgentVoiceConfig {
  const defaults = defaultAgentVoiceConfig();
  const raw = readJson<Record<string, unknown>>(
    dataFile(FILENAME),
    defaults as unknown as Record<string, unknown>,
  );
  return normalizeAgentVoiceConfig(raw);
}

export function saveAgentVoiceConfig(config: AgentVoiceConfig): AgentVoiceConfig {
  const normalized = normalizeAgentVoiceConfig(config as unknown as Record<string, unknown>);
  writeJson(dataFile(FILENAME), normalized as unknown as Record<string, unknown>);
  return normalized;
}

export function updateAgentVoiceConfig(patch: AgentConfigPatch): AgentVoiceConfig {
  const current = loadAgentVoiceConfig();
  const nextRaw: Record<string, unknown> = { ...current };

  if (patch.provider !== undefined) {
    const p = String(patch.provider).trim();
    if (!VALID_PROVIDERS.has(p)) {
      throw new Error(`不支持的 Pi Agent 引擎类型: ${p}`);
    }
    const providerChanged = p !== current.provider;
    nextRaw.provider = p;
    if (providerChanged && patch.modelId === undefined) {
      nextRaw.modelId = getProviderPreset(p as AgentProviderMode).defaultModel;
    }
  }

  if (patch.customProviderName !== undefined) {
    nextRaw.customProviderName = String(patch.customProviderName).trim();
  }

  if (patch.customApiType !== undefined) {
    const apiType = String(patch.customApiType).trim();
    if (!VALID_CUSTOM_APIS.has(apiType)) {
      throw new Error(`不支持的自定义 API 协议: ${apiType}`);
    }
    nextRaw.customApiType = apiType;
  }

  if (patch.modelId !== undefined) {
    nextRaw.modelId = String(patch.modelId).trim();
  }

  if (patch.baseUrl !== undefined) {
    const rawUrl = String(patch.baseUrl).trim();
    if (rawUrl && !normalizeUrl(rawUrl)) {
      throw new Error("API Base URL 必须是以 http:// 或 https:// 开头的有效地址");
    }
    nextRaw.baseUrl = rawUrl;
  }

  if (patch.clearApiKey === true) {
    nextRaw.apiKey = "";
  } else if (typeof patch.apiKey === "string") {
    const trimmed = patch.apiKey.trim();
    // 只有非空时覆盖，空字符串若未显式 clearApiKey 则保持原有密钥不变
    if (trimmed.length > 0) {
      nextRaw.apiKey = trimmed;
    }
  }

  if (patch.systemPromptExtra !== undefined) {
    nextRaw.systemPromptExtra = String(patch.systemPromptExtra);
  }
  if (patch.maxHistoryTurns !== undefined) {
    nextRaw.maxHistoryTurns = patch.maxHistoryTurns;
  }
  if (patch.voiceEnabled !== undefined) {
    nextRaw.voiceEnabled = Boolean(patch.voiceEnabled);
  }
  if (patch.voiceEngine !== undefined) {
    const eng = String(patch.voiceEngine).trim();
    if (!VALID_VOICE_ENGINES.has(eng)) {
      throw new Error(`不支持的语音识别引擎: ${eng}`);
    }
    nextRaw.voiceEngine = eng;
  }
  if (patch.voiceLang !== undefined) {
    nextRaw.voiceLang = String(patch.voiceLang).trim();
  }
  if (patch.wakeWordEnabled !== undefined) {
    nextRaw.wakeWordEnabled = Boolean(patch.wakeWordEnabled);
  }
  if (patch.wakeWords !== undefined) {
    nextRaw.wakeWords = normalizeWakeWords(patch.wakeWords);
  }
  if (patch.wakeAckPhrase !== undefined) {
    nextRaw.wakeAckPhrase =
      patch.wakeAckPhrase === null ? "" : String(patch.wakeAckPhrase).trim().slice(0, 64);
  }
  if (patch.wakeWindowSec !== undefined) {
    nextRaw.wakeWindowSec = patch.wakeWindowSec;
  }
  if (patch.autoSpeakReply !== undefined) {
    nextRaw.autoSpeakReply = Boolean(patch.autoSpeakReply);
  }
  if (patch.ttsEngine !== undefined) {
    const te = String(patch.ttsEngine).trim().toLowerCase();
    if (!VALID_TTS_ENGINES.has(te)) {
      throw new Error(`不支持的语音播报引擎: ${te}`);
    }
    nextRaw.ttsEngine = te;
  }
  if (patch.ttsVoice !== undefined) {
    const tv = String(patch.ttsVoice).trim().toLowerCase();
    if (!VALID_TTS_VOICES.has(tv)) {
      throw new Error(`不支持的语音播报音色: ${tv}`);
    }
    nextRaw.ttsVoice = tv;
  }
  if (patch.ttsSpeed !== undefined) {
    nextRaw.ttsSpeed = patch.ttsSpeed;
  }
  if (patch.continuousListen !== undefined) {
    nextRaw.continuousListen = Boolean(patch.continuousListen);
  }
  if (patch.vadThreshold !== undefined) {
    nextRaw.vadThreshold = patch.vadThreshold;
  }
  if (patch.vadSilenceMs !== undefined) {
    nextRaw.vadSilenceMs = patch.vadSilenceMs;
  }
  if (patch.vadSensitivity !== undefined) {
    const vs = String(patch.vadSensitivity).trim().toLowerCase();
    if (!VALID_VAD_SENSITIVITIES.has(vs)) {
      throw new Error(`不支持的 VAD 灵敏度档位: ${vs}`);
    }
    nextRaw.vadSensitivity = vs;
  }
  if (patch.preferLocalIntents !== undefined) {
    nextRaw.preferLocalIntents = Boolean(patch.preferLocalIntents);
  }
  if (patch.noiseSuppressionMode !== undefined) {
    const nm = String(patch.noiseSuppressionMode).trim();
    if (!VALID_NOISE_MODES.has(nm)) {
      throw new Error(`不支持的环境降噪模式: ${nm}`);
    }
    nextRaw.noiseSuppressionMode = nm;
  }
  if (patch.sourceSeparationMode !== undefined) {
    const sm = String(patch.sourceSeparationMode).trim().toLowerCase();
    if (!VALID_SOURCE_SEP_MODES.has(sm)) {
      throw new Error(`不支持的声源分离模式: ${sm}`);
    }
    nextRaw.sourceSeparationMode = sm;
  }
  if (patch.vadMode !== undefined) {
    const vm = String(patch.vadMode).trim();
    if (!VALID_VAD_MODES.has(vm)) {
      throw new Error(`不支持的 VAD 模式: ${vm}`);
    }
    nextRaw.vadMode = vm;
  }
  if (patch.voiceprintMode !== undefined) {
    const vpm = String(patch.voiceprintMode).trim();
    if (!VALID_VOICEPRINT_MODES.has(vpm)) {
      throw new Error(`不支持的声纹识别模式: ${vpm}`);
    }
    nextRaw.voiceprintMode = vpm;
  }
  if (patch.voiceprintThreshold !== undefined) {
    nextRaw.voiceprintThreshold = patch.voiceprintThreshold;
  }
  if (patch.attentionMode !== undefined) {
    const am = String(patch.attentionMode).trim();
    if (!VALID_ATTENTION_MODES.has(am)) {
      throw new Error(`不支持的唤醒词注意力模式: ${am}`);
    }
    nextRaw.attentionMode = am;
  }
  if (patch.conversationWindowSec !== undefined) {
    nextRaw.conversationWindowSec = patch.conversationWindowSec;
  }
  if (patch.maxConsecutiveSidetalk !== undefined) {
    nextRaw.maxConsecutiveSidetalk = patch.maxConsecutiveSidetalk;
  }
  if (patch.bargeInEnabled !== undefined) {
    nextRaw.bargeInEnabled = Boolean(patch.bargeInEnabled);
  }
  if (patch.systemOneMode !== undefined) {
    const sm = String(patch.systemOneMode).trim().toLowerCase();
    if (!VALID_SYSTEMONE_MODES.has(sm)) {
      throw new Error(`不支持的 SystemOne 决策模式: ${sm}`);
    }
    nextRaw.systemOneMode = sm;
  }
  if (patch.systemOneBaseUrl !== undefined) {
    const rawUrl = String(patch.systemOneBaseUrl).trim();
    if (rawUrl && !normalizeSystemOneBaseUrl(rawUrl)) {
      throw new Error("SystemOne 接口地址必须是以 http:// 或 https:// 开头的有效地址");
    }
    nextRaw.systemOneBaseUrl = rawUrl;
  }
  if (patch.clearSystemOneApiKey === true) {
    nextRaw.systemOneApiKey = "";
  } else if (typeof patch.systemOneApiKey === "string") {
    const trimmed = patch.systemOneApiKey.trim();
    if (trimmed.length > 0) {
      nextRaw.systemOneApiKey = trimmed;
    }
  }
  if (patch.systemOneModel !== undefined) {
    nextRaw.systemOneModel = String(patch.systemOneModel).trim();
  }
  if (patch.systemOneTimeoutMs !== undefined) {
    nextRaw.systemOneTimeoutMs = patch.systemOneTimeoutMs;
  }
  if (patch.systemOneConfidenceThreshold !== undefined) {
    nextRaw.systemOneConfidenceThreshold = patch.systemOneConfidenceThreshold;
  }
  if (patch.cavemanMode !== undefined) {
    const cmRaw = String(patch.cavemanMode).trim().toLowerCase();
    const mapped = CAVEMAN_MODE_ALIASES[cmRaw];
    if (!mapped || !VALID_CAVEMAN_MODES.has(mapped)) {
      throw new Error(`不支持的回复精简模式: ${cmRaw}`);
    }
    nextRaw.cavemanMode = mapped;
  }
  if (patch.owwEnabled !== undefined) {
    nextRaw.owwEnabled = Boolean(patch.owwEnabled);
  }
  if (patch.owwThreshold !== undefined) {
    nextRaw.owwThreshold = patch.owwThreshold;
  }

  if (patch.sttBaseUrl !== undefined) {
    const rawUrl = String(patch.sttBaseUrl).trim();
    if (rawUrl && !normalizeUrl(rawUrl)) {
      throw new Error("语音转写 STT 地址必须是以 http:// 或 https:// 开头的有效地址");
    }
    nextRaw.sttBaseUrl = rawUrl;
  }
  if (patch.clearSttApiKey === true) {
    nextRaw.sttApiKey = "";
  } else if (typeof patch.sttApiKey === "string") {
    const trimmed = patch.sttApiKey.trim();
    if (trimmed.length > 0) {
      nextRaw.sttApiKey = trimmed;
    }
  }
  if (patch.sttModel !== undefined) {
    nextRaw.sttModel = String(patch.sttModel).trim();
  }

  return saveAgentVoiceConfig(normalizeAgentVoiceConfig(nextRaw));
}
