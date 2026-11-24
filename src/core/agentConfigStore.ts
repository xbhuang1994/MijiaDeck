// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * 内置 Pi Agent 与语音监听配置的本地持久化（pi_agent.json）。
 * API Key 仅存储在服务端数据目录，面向前端序列化时一律脱敏。
 */

import { dataFile, readJson, writeJson } from "./jsonStore.ts";

export const AGENT_CONFIG_VERSION = 1;
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

export type VoiceEngineMode = "auto" | "browser" | "whisper";
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
const VALID_VOICE_ENGINES = new Set<string>(["auto", "browser", "whisper"]);
const VALID_CUSTOM_APIS = new Set<string>([
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
]);

export const DEFAULT_WAKE_WORDS = ["小派", "小湃", "小π", "派派", "pi", "米家助手"] as const;

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
  wakeWindowSec: number;
  autoSpeakReply: boolean;
  continuousListen: boolean;
  vadThreshold: number;
  vadSilenceMs: number;
  sttBaseUrl: string;
  sttApiKey: string;
  sttModel: string;
}

export interface PublicAgentVoiceConfig
  extends Omit<AgentVoiceConfig, "apiKey" | "sttApiKey"> {
  hasApiKey: boolean;
  apiKeyPreview: string;
  envApiKeyDetected: boolean;
  hasSttApiKey: boolean;
  sttApiKeyPreview: string;
  effectiveSttConfigured: boolean;
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
  wakeWindowSec?: unknown;
  autoSpeakReply?: unknown;
  continuousListen?: unknown;
  vadThreshold?: unknown;
  vadSilenceMs?: unknown;
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
    wakeWindowSec: 10,
    autoSpeakReply: true,
    continuousListen: true,
    vadThreshold: 0.025,
    vadSilenceMs: 1200,
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
    wakeWindowSec: Math.round(clampNumber(raw.wakeWindowSec, 3, 60, defaults.wakeWindowSec)),
    autoSpeakReply:
      typeof raw.autoSpeakReply === "boolean" ? raw.autoSpeakReply : defaults.autoSpeakReply,
    continuousListen:
      typeof raw.continuousListen === "boolean" ? raw.continuousListen : defaults.continuousListen,
    vadThreshold: Number(clampNumber(raw.vadThreshold, 0.005, 0.3, defaults.vadThreshold).toFixed(4)),
    vadSilenceMs: Math.round(clampNumber(raw.vadSilenceMs, 400, 5000, defaults.vadSilenceMs)),
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

export function toPublicAgentVoiceConfig(config: AgentVoiceConfig): PublicAgentVoiceConfig {
  const envKey = resolveEnvApiKeyForProvider(config.provider);
  const stt = resolveEffectiveSttAuth(config);
  const effectiveSttConfigured = Boolean(
    stt.baseUrl && (stt.apiKey || isLocalEndpointUrl(stt.baseUrl)),
  );
  const { apiKey, sttApiKey, ...rest } = config;
  return {
    ...rest,
    hasApiKey: apiKey.trim().length > 0,
    apiKeyPreview: maskSecret(apiKey),
    envApiKeyDetected: Boolean(envKey),
    hasSttApiKey: sttApiKey.trim().length > 0,
    sttApiKeyPreview: maskSecret(sttApiKey),
    effectiveSttConfigured,
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
  if (patch.wakeWindowSec !== undefined) {
    nextRaw.wakeWindowSec = patch.wakeWindowSec;
  }
  if (patch.autoSpeakReply !== undefined) {
    nextRaw.autoSpeakReply = Boolean(patch.autoSpeakReply);
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
