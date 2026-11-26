// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * 内置 Pi Agent 与语音监听配置的本地持久化（pi_agent.json）。
 * API Key 仅存储在服务端数据目录，面向前端序列化时一律脱敏。
 */

import { SCENES_FEATURE_ENABLED } from "./featureFlags.ts";
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
export type VoicePipelineMode = "legacy" | "clearvoice" | "xfyun" | "voice-ws";
export type LocalAsrEngineMode = "auto" | "qwen3-asr" | "sensevoice";
export type TtsEngineMode = "auto" | "local" | "browser";
export type TtsVoicePreset = "gentle-zh-en" | "warm-zh-baker";
export type NoiseSuppressionMode = "auto" | "neural" | "dpdfnet" | "voxlock" | "dsp" | "off";
export type SourceSeparationMode = "auto" | "fast" | "full" | "off";
export type VadEngineMode = "silero" | "adaptive";
export type VadSensitivityMode = "aggressive" | "default" | "relaxed";
export type VoiceprintPolicyMode = "off" | "tag" | "strict";
export type AttentionMode = "smart" | "strict" | "off";
export type EchoCancellationMode = "auto" | "aggressive" | "standard" | "off";
export type SystemOneMode = "auto" | "on" | "off";
export type CavemanReplyMode = "ultra" | "full" | "lite" | "off";
export type AgentThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
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
    description: SCENES_FEATURE_ENABLED
      ? "零延迟本地智能家居规划引擎，经由 Pi Agent 工具循环执行常见开关、调光、传感器、场景与喂食指令"
      : "零延迟本地智能家居规划引擎，经由 Pi Agent 工具循环执行常见开关、调光、传感器与喂食指令",
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
const VALID_VOICE_PIPELINE_MODES = new Set<string>(["legacy", "clearvoice", "xfyun", "voice-ws"]);
const VOICE_PIPELINE_MODE_ALIASES: Readonly<Record<string, VoicePipelineMode>> = {
  legacy: "legacy",
  original: "legacy",
  old: "legacy",
  default: "legacy",
  sherpa: "legacy",
  gtcrn: "legacy",
  clearvoice: "clearvoice",
  "clearvoice-gpu": "clearvoice",
  mossformer2: "clearvoice",
  new: "clearvoice",
  xfyun: "xfyun",
  "xfyun-iat": "xfyun",
  "xfyun-iat-v2": "xfyun",
  "spark-asr-v2": "xfyun",
  spark_asr_v2: "xfyun",
  xunfei: "xfyun",
  iflytek: "xfyun",
  "voice-ws": "voice-ws",
  voice_ws: "voice-ws",
  "voice-ws-asr": "voice-ws",
  voice_ws_asr: "voice-ws",
  "voice-gateway": "voice-ws",
  voice_gateway: "voice-ws",
  "ws-asr": "voice-ws",
  ws_asr: "voice-ws",
  "unified-ws-asr": "voice-ws",
  "unified-asr": "voice-ws",
  "unified-voice": "voice-ws",
  "voice-asr-gateway": "voice-ws",
};
const VALID_LOCAL_ASR_ENGINES = new Set<string>(["auto", "qwen3-asr", "sensevoice"]);
const LOCAL_ASR_ENGINE_ALIASES: Readonly<Record<string, LocalAsrEngineMode>> = {
  auto: "auto",
  "qwen3-asr": "qwen3-asr",
  "qwen3-asr-0.6b": "qwen3-asr",
  qwen3: "qwen3-asr",
  qwen: "qwen3-asr",
  sensevoice: "sensevoice",
  "sense-voice": "sensevoice",
  sv: "sensevoice",
};
const VALID_TTS_ENGINES = new Set<string>(["auto", "local", "browser"]);
const VALID_TTS_VOICES = new Set<string>(["gentle-zh-en", "warm-zh-baker"]);
const VALID_NOISE_MODES = new Set<string>(["auto", "neural", "dpdfnet", "voxlock", "dsp", "off"]);
const VALID_SOURCE_SEP_MODES = new Set<string>(["auto", "fast", "full", "off"]);
const VALID_VAD_MODES = new Set<string>(["silero", "adaptive"]);
const VALID_VAD_SENSITIVITIES = new Set<string>(["aggressive", "default", "relaxed"]);
const VALID_VOICEPRINT_MODES = new Set<string>(["off", "tag", "strict"]);
const VALID_ATTENTION_MODES = new Set<string>(["smart", "strict", "off"]);
const VALID_ECHO_MODES = new Set<string>(["auto", "aggressive", "standard", "off"]);
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
export const DEFAULT_THINKING_LEVEL: AgentThinkingLevel = "off";
export const VALID_THINKING_LEVELS: ReadonlyArray<AgentThinkingLevel> = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
const VALID_THINKING_LEVEL_SET = new Set<string>(VALID_THINKING_LEVELS);
const THINKING_LEVEL_ALIASES: Readonly<Record<string, AgentThinkingLevel>> = {
  off: "off",
  none: "off",
  disabled: "off",
  minimal: "minimal",
  min: "minimal",
  low: "low",
  medium: "medium",
  med: "medium",
  high: "high",
  xhigh: "xhigh",
  "extra-high": "xhigh",
  extra_high: "xhigh",
  max: "max",
  maximum: "max",
};
const VALID_CUSTOM_APIS = new Set<string>([
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
]);

export const DEFAULT_WAKE_WORDS = ["小派", "小湃", "小π", "派派", "pi", "米家助手"] as const;
export const DEFAULT_WAKE_ACK_PHRASE = "嗯?";
export const DEFAULT_LOCAL_ASR_ENGINE: LocalAsrEngineMode = "auto";
export const DEFAULT_VOICE_PIPELINE_MODE: VoicePipelineMode = "legacy";
export const DEFAULT_CLEARVOICE_MODEL = "MossFormer2_SE_48K";
export const DEFAULT_QWEN3_ASR_MODEL = "Qwen/Qwen3-ASR-0.6B";
export const DEFAULT_QWEN3_STREAMING_ENABLED = true;
export const DEFAULT_XFYUN_IAT_ENDPOINT = "wss://iat.cn-huabei-1.xf-yun.com/v1";
export const DEFAULT_VOICE_WS_ASR_ENDPOINT = "wss://voice.1inch.cn:18443/v1/ws/asr";
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
  /** 语音前端降噪与切片方案：legacy（原方案 GTCRN/声源分离）/ clearvoice（在线 ClearVoice 多轨切片 -> 在线 Qwen3-ASR）/ xfyun（讯飞语音听写大模型 2.0：openWakeWord 唤醒后直推原始音频）/ voice-ws（统一流式语音听写 WebSocket 网关：openWakeWord 唤醒后直推原始音频，服务端 CPU ONNX GTCRN+Silero VAD -> GPU Qwen3-ASR） */
  voicePipelineMode: VoicePipelineMode;
  /** 在线 ClearVoice 服务地址（如 https://voice.1inch.cn:18443；仅支持在线模式） */
  clearVoiceServiceUrl: string;
  /** 在线 ClearVoice 服务授权码 / API Key（仅持久化于服务端配置文件，面向前端一律脱敏） */
  clearVoiceApiKey: string;
  /** ClearVoice 在线语音增强模型名称（默认 MossFormer2_SE_48K，亦支持 FRCRN_SE_16K / MossFormerGAN_SE_16K） */
  clearVoiceModel: string;
  /** 在线 Qwen3-ASR 语音识别服务地址（如 https://voice.1inch.cn:18443；仅支持在线模式） */
  qwen3AsrServiceUrl: string;
  /** 在线 Qwen3-ASR 服务授权码 / API Key（与 ClearVoice 同源时留空可安全复用 ClearVoice 授权码） */
  qwen3AsrApiKey: string;
  /** 在线 Qwen3-ASR 模型 ID（默认 Qwen/Qwen3-ASR-0.6B） */
  qwen3AsrModel: string;
  /** 讯飞语音听写大模型 2.0 WebSocket 服务地址（默认 wss://iat.cn-huabei-1.xf-yun.com/v1） */
  xfyunEndpointUrl: string;
  /** 讯飞语音听写大模型 2.0 APPID（仅保存于本地配置文件） */
  xfyunAppId: string;
  /** 讯飞语音听写大模型 2.0 APIKey（仅保存于服务端本地配置文件，面向前端一律脱敏） */
  xfyunApiKey: string;
  /** 讯飞语音听写大模型 2.0 APISecret（仅保存于服务端本地配置文件，面向前端一律脱敏） */
  xfyunApiSecret: string;
  /** 统一流式语音听写 WebSocket 网关地址（默认 wss://voice.1inch.cn:18443/v1/ws/asr） */
  voiceWsAsrEndpointUrl: string;
  /** 统一流式语音听写网关授权码（仅保存于服务端本地配置文件，面向前端一律脱敏） */
  voiceWsAsrAuthCode: string;
  /** 统一流式语音听写网关是否开启服务端 CPU ONNX GTCRN 降噪（默认开启） */
  voiceWsAsrDenoise: boolean;
  /** 统一流式语音听写网关指定识别语言（留空自动识别，如 zh / en / ja / yue） */
  voiceWsAsrLanguage: string;
  /** 语音转写主备策略：auto（主用在线 Qwen3-ASR-0.6B，本地 SenseVoice 自动兜底）/ qwen3-asr / sensevoice */
  localAsrEngine: LocalAsrEngineMode;
  /** 是否开启实时流式转写与智能断句（开启后边说边出字、按标点与停顿智能断句） */
  qwen3StreamingEnabled: boolean;
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
  /** 是否启用执行、播报、对话全双工异步分离管线（默认开启，互不阻塞） */
  asyncVoicePipeline: boolean;
  /** 回声消除策略：auto（硬件 AEC + 参考信号自适应 AEC + 服务端多语段语义防回声）/ aggressive / standard / off */
  echoCancellationMode: EchoCancellationMode;
  /** 双讲/插话检测时是否先平滑降音（Ducking）再决定打断（默认开启，显著降低自回声误打断） */
  bargeInDuckingEnabled: boolean;
  // SystemOne 决策模型（karpo/karpo-decision-31b）配置
  systemOneMode: SystemOneMode;
  systemOneBaseUrl: string;
  systemOneApiKey: string;
  systemOneModel: string;
  systemOneTimeoutMs: number;
  systemOneConfidenceThreshold: number;
  // Caveman 极简回复风格（参考 juliusbrussee/caveman）
  cavemanMode: CavemanReplyMode;
  /** 简单常规控制指令（如开关灯等）执行且状态核验正常后保持静默（默认开启，仅异常或需询问时回复） */
  silentSimpleControlReply: boolean;
  /** AI 思考/推理等级：off（关闭）/ minimal / low / medium / high / xhigh / max（思考过程仅展示在对话框，不语音播报） */
  thinkingLevel: AgentThinkingLevel;
  // openWakeWord 独立本地声学唤醒词优化（支持用户自定义唤醒词）
  owwEnabled: boolean;
  owwThreshold: number;
  sttBaseUrl: string;
  sttApiKey: string;
  sttModel: string;
}

export interface PublicAgentVoiceConfig
  extends Omit<
    AgentVoiceConfig,
    | "apiKey"
    | "sttApiKey"
    | "systemOneApiKey"
    | "clearVoiceApiKey"
    | "qwen3AsrApiKey"
    | "xfyunApiKey"
    | "xfyunApiSecret"
    | "voiceWsAsrAuthCode"
  > {
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
  hasClearVoiceApiKey: boolean;
  clearVoiceApiKeyPreview: string;
  effectiveClearVoiceRemoteConfigured: boolean;
  hasQwen3AsrApiKey: boolean;
  qwen3AsrApiKeyPreview: string;
  effectiveQwen3AsrRemoteConfigured: boolean;
  hasXfyunApiKey: boolean;
  xfyunApiKeyPreview: string;
  hasXfyunApiSecret: boolean;
  xfyunApiSecretPreview: string;
  effectiveXfyunConfigured: boolean;
  hasVoiceWsAsrAuthCode: boolean;
  voiceWsAsrAuthCodePreview: string;
  effectiveVoiceWsAsrConfigured: boolean;
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
  voicePipelineMode?: unknown;
  clearVoiceServiceUrl?: unknown;
  clearVoiceApiKey?: unknown;
  clearClearVoiceApiKey?: unknown;
  clearVoiceModel?: unknown;
  qwen3AsrServiceUrl?: unknown;
  qwen3AsrApiKey?: unknown;
  clearQwen3AsrApiKey?: unknown;
  qwen3AsrModel?: unknown;
  xfyunEndpointUrl?: unknown;
  xfyunAppId?: unknown;
  xfyunApiKey?: unknown;
  clearXfyunApiKey?: unknown;
  xfyunApiSecret?: unknown;
  clearXfyunApiSecret?: unknown;
  voiceWsAsrEndpointUrl?: unknown;
  voiceWsAsrAuthCode?: unknown;
  clearVoiceWsAsrAuthCode?: unknown;
  voiceWsAsrDenoise?: unknown;
  voiceWsAsrLanguage?: unknown;
  localAsrEngine?: unknown;
  qwen3StreamingEnabled?: unknown;
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
  asyncVoicePipeline?: unknown;
  echoCancellationMode?: unknown;
  bargeInDuckingEnabled?: unknown;
  systemOneMode?: unknown;
  systemOneBaseUrl?: unknown;
  systemOneApiKey?: unknown;
  clearSystemOneApiKey?: unknown;
  systemOneModel?: unknown;
  systemOneTimeoutMs?: unknown;
  systemOneConfidenceThreshold?: unknown;
  cavemanMode?: unknown;
  silentSimpleControlReply?: unknown;
  thinkingLevel?: unknown;
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
    voicePipelineMode: DEFAULT_VOICE_PIPELINE_MODE,
    clearVoiceServiceUrl: "",
    clearVoiceApiKey: "",
    clearVoiceModel: DEFAULT_CLEARVOICE_MODEL,
    qwen3AsrServiceUrl: "",
    qwen3AsrApiKey: "",
    qwen3AsrModel: DEFAULT_QWEN3_ASR_MODEL,
    xfyunEndpointUrl: DEFAULT_XFYUN_IAT_ENDPOINT,
    xfyunAppId: "",
    xfyunApiKey: "",
    xfyunApiSecret: "",
    voiceWsAsrEndpointUrl: DEFAULT_VOICE_WS_ASR_ENDPOINT,
    voiceWsAsrAuthCode: "",
    voiceWsAsrDenoise: true,
    voiceWsAsrLanguage: "",
    localAsrEngine: DEFAULT_LOCAL_ASR_ENGINE,
    qwen3StreamingEnabled: DEFAULT_QWEN3_STREAMING_ENABLED,
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
    vadSilenceMs: 1000,
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
    asyncVoicePipeline: true,
    echoCancellationMode: "auto",
    bargeInDuckingEnabled: true,
    systemOneMode: "auto",
    systemOneBaseUrl: "",
    systemOneApiKey: "",
    systemOneModel: DEFAULT_SYSTEMONE_MODEL,
    systemOneTimeoutMs: 2000,
    systemOneConfidenceThreshold: 0.65,
    cavemanMode: DEFAULT_CAVEMAN_MODE,
    silentSimpleControlReply: true,
    thinkingLevel: DEFAULT_THINKING_LEVEL,
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

function normalizeWsUrl(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
      return "";
    }
    const cleanPath = parsed.pathname && parsed.pathname !== "/" ? parsed.pathname.replace(/\/+$/, "") : "/v1";
    return `${parsed.origin}${cleanPath}`;
  } catch {
    return "";
  }
}

function normalizeVoiceWsAsrUrl(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  try {
    const parsed = new URL(trimmed);
    let protocol = parsed.protocol;
    if (protocol === "https:") {
      protocol = "wss:";
    } else if (protocol === "http:") {
      protocol = "ws:";
    } else if (protocol !== "ws:" && protocol !== "wss:") {
      return "";
    }
    const cleanPath =
      parsed.pathname && parsed.pathname !== "/"
        ? parsed.pathname.replace(/\/+$/, "")
        : "/v1/ws/asr";
    return `${protocol}//${parsed.host}${cleanPath}`;
  } catch {
    return "";
  }
}

export function normalizeLocalAsrEngine(
  value: unknown,
  fallback: LocalAsrEngineMode = DEFAULT_LOCAL_ASR_ENGINE,
): LocalAsrEngineMode {
  if (typeof value !== "string") return fallback;
  const key = value.trim().toLowerCase();
  return LOCAL_ASR_ENGINE_ALIASES[key] ?? fallback;
}

export function normalizeVoicePipelineMode(
  value: unknown,
  fallback: VoicePipelineMode = DEFAULT_VOICE_PIPELINE_MODE,
): VoicePipelineMode {
  if (typeof value !== "string") return fallback;
  const key = value.trim().toLowerCase();
  return VOICE_PIPELINE_MODE_ALIASES[key] ?? fallback;
}

export function normalizeCavemanMode(
  value: unknown,
  fallback: CavemanReplyMode = DEFAULT_CAVEMAN_MODE,
): CavemanReplyMode {
  if (typeof value !== "string") return fallback;
  const key = value.trim().toLowerCase();
  return CAVEMAN_MODE_ALIASES[key] ?? fallback;
}

export function normalizeThinkingLevel(
  value: unknown,
  fallback: AgentThinkingLevel = DEFAULT_THINKING_LEVEL,
): AgentThinkingLevel {
  if (typeof value !== "string") return fallback;
  const key = value.trim().toLowerCase();
  return THINKING_LEVEL_ALIASES[key] ?? fallback;
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

  const localAsrEngine = normalizeLocalAsrEngine(raw.localAsrEngine, defaults.localAsrEngine);
  const voicePipelineMode = normalizeVoicePipelineMode(
    raw.voicePipelineMode,
    defaults.voicePipelineMode,
  );
  const clearVoiceServiceUrl = normalizeUrl(raw.clearVoiceServiceUrl);
  const clearVoiceApiKey = typeof raw.clearVoiceApiKey === "string" ? raw.clearVoiceApiKey.trim() : "";
  const clearVoiceModelRaw =
    typeof raw.clearVoiceModel === "string" ? raw.clearVoiceModel.trim().slice(0, 128) : "";
  const clearVoiceModel = clearVoiceModelRaw || defaults.clearVoiceModel;
  const qwen3AsrServiceUrl = normalizeUrl(raw.qwen3AsrServiceUrl);
  const qwen3AsrApiKey = typeof raw.qwen3AsrApiKey === "string" ? raw.qwen3AsrApiKey.trim() : "";
  const qwen3AsrModelRaw =
    typeof raw.qwen3AsrModel === "string" ? raw.qwen3AsrModel.trim().slice(0, 128) : "";
  const qwen3AsrModel = qwen3AsrModelRaw || defaults.qwen3AsrModel;
  const xfyunEndpointUrl = normalizeWsUrl(raw.xfyunEndpointUrl) || defaults.xfyunEndpointUrl;
  const xfyunAppId = typeof raw.xfyunAppId === "string" ? raw.xfyunAppId.trim().slice(0, 64) : "";
  const xfyunApiKey = typeof raw.xfyunApiKey === "string" ? raw.xfyunApiKey.trim() : "";
  const xfyunApiSecret = typeof raw.xfyunApiSecret === "string" ? raw.xfyunApiSecret.trim() : "";
  const voiceWsAsrEndpointUrl =
    normalizeVoiceWsAsrUrl(raw.voiceWsAsrEndpointUrl) || defaults.voiceWsAsrEndpointUrl;
  const voiceWsAsrAuthCode =
    typeof raw.voiceWsAsrAuthCode === "string" ? raw.voiceWsAsrAuthCode.trim() : "";
  const voiceWsAsrDenoise =
    typeof raw.voiceWsAsrDenoise === "boolean"
      ? raw.voiceWsAsrDenoise
      : defaults.voiceWsAsrDenoise;
  const voiceWsAsrLanguage =
    typeof raw.voiceWsAsrLanguage === "string"
      ? raw.voiceWsAsrLanguage.trim().slice(0, 32)
      : defaults.voiceWsAsrLanguage;
  const qwen3StreamingEnabled =
    typeof raw.qwen3StreamingEnabled === "boolean"
      ? raw.qwen3StreamingEnabled
      : defaults.qwen3StreamingEnabled;

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

  const echoModeRaw =
    typeof raw.echoCancellationMode === "string"
      ? raw.echoCancellationMode.trim().toLowerCase()
      : defaults.echoCancellationMode;
  const echoCancellationMode: EchoCancellationMode = VALID_ECHO_MODES.has(echoModeRaw)
    ? (echoModeRaw as EchoCancellationMode)
    : defaults.echoCancellationMode;

  const sysOneModeRaw =
    typeof raw.systemOneMode === "string"
      ? raw.systemOneMode.trim().toLowerCase()
      : defaults.systemOneMode;
  const systemOneMode: SystemOneMode = VALID_SYSTEMONE_MODES.has(sysOneModeRaw)
    ? (sysOneModeRaw as SystemOneMode)
    : defaults.systemOneMode;

  const cavemanMode = normalizeCavemanMode(raw.cavemanMode, defaults.cavemanMode);
  const thinkingLevel = normalizeThinkingLevel(raw.thinkingLevel, defaults.thinkingLevel);
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
    voicePipelineMode,
    clearVoiceServiceUrl,
    clearVoiceApiKey,
    clearVoiceModel,
    qwen3AsrServiceUrl,
    qwen3AsrApiKey,
    qwen3AsrModel,
    xfyunEndpointUrl,
    xfyunAppId,
    xfyunApiKey,
    xfyunApiSecret,
    voiceWsAsrEndpointUrl,
    voiceWsAsrAuthCode,
    voiceWsAsrDenoise,
    voiceWsAsrLanguage,
    localAsrEngine,
    qwen3StreamingEnabled,
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
    asyncVoicePipeline:
      typeof raw.asyncVoicePipeline === "boolean"
        ? raw.asyncVoicePipeline
        : defaults.asyncVoicePipeline,
    echoCancellationMode,
    bargeInDuckingEnabled:
      typeof raw.bargeInDuckingEnabled === "boolean"
        ? raw.bargeInDuckingEnabled
        : defaults.bargeInDuckingEnabled,
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
    silentSimpleControlReply:
      typeof raw.silentSimpleControlReply === "boolean"
        ? raw.silentSimpleControlReply
        : defaults.silentSimpleControlReply,
    thinkingLevel,
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

function hasSameUrlOrigin(urlA: string, urlB: string): boolean {
  if (!urlA || !urlB) return false;
  try {
    return new URL(urlA).origin === new URL(urlB).origin;
  } catch {
    return false;
  }
}

export function resolveEffectiveClearVoiceAuth(config: AgentVoiceConfig): {
  serviceUrl: string;
  apiKey: string | undefined;
  model: string;
  configured: boolean;
} {
  const serviceUrl =
    normalizeUrl(config.clearVoiceServiceUrl) ||
    normalizeUrl(process.env.CLEARVOICE_SERVICE_URL ?? "");
  const explicitKey = config.clearVoiceApiKey.trim();
  const qwenUrl =
    normalizeUrl(config.qwen3AsrServiceUrl) ||
    normalizeUrl(process.env.QWEN3_ASR_SERVICE_URL ?? "");
  const sharedKey =
    !explicitKey && hasSameUrlOrigin(serviceUrl, qwenUrl) ? config.qwen3AsrApiKey.trim() : "";
  const envKey =
    process.env.CLEARVOICE_API_KEY?.trim() ||
    process.env.VOICE_GATEWAY_API_KEY?.trim() ||
    "";
  const apiKey = explicitKey || sharedKey || envKey || undefined;
  const model = config.clearVoiceModel.trim() || DEFAULT_CLEARVOICE_MODEL;
  const configured = Boolean(serviceUrl && (apiKey || isLocalEndpointUrl(serviceUrl)));
  return {
    serviceUrl,
    apiKey,
    model,
    configured,
  };
}

export function resolveEffectiveQwen3AsrAuth(config: AgentVoiceConfig): {
  serviceUrl: string;
  apiKey: string | undefined;
  model: string;
  configured: boolean;
} {
  const serviceUrl =
    normalizeUrl(config.qwen3AsrServiceUrl) ||
    normalizeUrl(process.env.QWEN3_ASR_SERVICE_URL ?? "");
  const explicitKey = config.qwen3AsrApiKey.trim();
  const cvUrl =
    normalizeUrl(config.clearVoiceServiceUrl) ||
    normalizeUrl(process.env.CLEARVOICE_SERVICE_URL ?? "");
  const sharedKey =
    !explicitKey && hasSameUrlOrigin(serviceUrl, cvUrl) ? config.clearVoiceApiKey.trim() : "";
  const envKey =
    process.env.QWEN3_ASR_API_KEY?.trim() ||
    process.env.VOICE_GATEWAY_API_KEY?.trim() ||
    "";
  const apiKey = explicitKey || sharedKey || envKey || undefined;
  const model = config.qwen3AsrModel.trim() || DEFAULT_QWEN3_ASR_MODEL;
  const configured = Boolean(serviceUrl && (apiKey || isLocalEndpointUrl(serviceUrl)));
  return {
    serviceUrl,
    apiKey,
    model,
    configured,
  };
}

export function resolveEffectiveXfyunAuth(config: AgentVoiceConfig): {
  endpointUrl: string;
  appId: string;
  apiKey: string;
  apiSecret: string;
  configured: boolean;
} {
  const endpointUrl =
    normalizeWsUrl(config.xfyunEndpointUrl) ||
    normalizeWsUrl(process.env.XFYUN_IAT_ENDPOINT ?? "") ||
    DEFAULT_XFYUN_IAT_ENDPOINT;
  const appId = config.xfyunAppId.trim() || process.env.XFYUN_APPID?.trim() || "";
  const apiKey = config.xfyunApiKey.trim() || process.env.XFYUN_API_KEY?.trim() || "";
  const apiSecret = config.xfyunApiSecret.trim() || process.env.XFYUN_API_SECRET?.trim() || "";
  const configured = Boolean(endpointUrl && appId && apiKey && apiSecret);
  return {
    endpointUrl,
    appId,
    apiKey,
    apiSecret,
    configured,
  };
}

export function resolveEffectiveVoiceWsAsrAuth(config: AgentVoiceConfig): {
  endpointUrl: string;
  authCode: string;
  denoise: boolean;
  language: string | null;
  configured: boolean;
} {
  const endpointUrl =
    normalizeVoiceWsAsrUrl(config.voiceWsAsrEndpointUrl) ||
    normalizeVoiceWsAsrUrl(process.env.VOICE_WS_ASR_ENDPOINT ?? "") ||
    DEFAULT_VOICE_WS_ASR_ENDPOINT;
  const authCode =
    config.voiceWsAsrAuthCode.trim() ||
    process.env.VOICE_WS_ASR_AUTH_CODE?.trim() ||
    process.env.VOICE_GATEWAY_AUTH_CODE?.trim() ||
    "";
  const denoise = config.voiceWsAsrDenoise !== false;
  const language = config.voiceWsAsrLanguage.trim() || null;
  const configured = Boolean(endpointUrl && authCode);
  return {
    endpointUrl,
    authCode,
    denoise,
    language,
    configured,
  };
}

export function toPublicAgentVoiceConfig(config: AgentVoiceConfig): PublicAgentVoiceConfig {
  const envKey = resolveEnvApiKeyForProvider(config.provider);
  const stt = resolveEffectiveSttAuth(config);
  const effectiveSttConfigured = Boolean(
    stt.baseUrl && (stt.apiKey || isLocalEndpointUrl(stt.baseUrl)),
  );
  const sysOne = resolveEffectiveSystemOneAuth(config);
  const cvAuth = resolveEffectiveClearVoiceAuth(config);
  const qwenAuth = resolveEffectiveQwen3AsrAuth(config);
  const xfyunAuth = resolveEffectiveXfyunAuth(config);
  const voiceWsAuth = resolveEffectiveVoiceWsAsrAuth(config);
  const {
    apiKey,
    sttApiKey,
    systemOneApiKey,
    clearVoiceApiKey,
    qwen3AsrApiKey,
    xfyunApiKey,
    xfyunApiSecret,
    voiceWsAsrAuthCode,
    ...rest
  } = config;
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
    hasClearVoiceApiKey: clearVoiceApiKey.trim().length > 0,
    clearVoiceApiKeyPreview: maskSecret(clearVoiceApiKey),
    effectiveClearVoiceRemoteConfigured: cvAuth.configured,
    hasQwen3AsrApiKey: qwen3AsrApiKey.trim().length > 0,
    qwen3AsrApiKeyPreview: maskSecret(qwen3AsrApiKey),
    effectiveQwen3AsrRemoteConfigured: qwenAuth.configured,
    hasXfyunApiKey: xfyunApiKey.trim().length > 0,
    xfyunApiKeyPreview: maskSecret(xfyunApiKey),
    hasXfyunApiSecret: xfyunApiSecret.trim().length > 0,
    xfyunApiSecretPreview: maskSecret(xfyunApiSecret),
    effectiveXfyunConfigured: xfyunAuth.configured,
    hasVoiceWsAsrAuthCode: voiceWsAsrAuthCode.trim().length > 0,
    voiceWsAsrAuthCodePreview: maskSecret(voiceWsAsrAuthCode),
    effectiveVoiceWsAsrConfigured: voiceWsAuth.configured,
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
  if (patch.voicePipelineMode !== undefined) {
    const rawMode = String(patch.voicePipelineMode).trim().toLowerCase();
    const mappedMode = VOICE_PIPELINE_MODE_ALIASES[rawMode];
    if (!mappedMode || !VALID_VOICE_PIPELINE_MODES.has(mappedMode)) {
      throw new Error(`不支持的语音降噪方案模式: ${rawMode}`);
    }
    nextRaw.voicePipelineMode = mappedMode;
  }
  if (patch.clearVoiceServiceUrl !== undefined) {
    const rawUrl = String(patch.clearVoiceServiceUrl).trim();
    if (rawUrl && !normalizeUrl(rawUrl)) {
      throw new Error("ClearVoice 在线服务地址必须是以 http:// 或 https:// 开头的有效地址");
    }
    nextRaw.clearVoiceServiceUrl = rawUrl;
  }
  if (patch.clearClearVoiceApiKey === true) {
    nextRaw.clearVoiceApiKey = "";
  } else if (typeof patch.clearVoiceApiKey === "string") {
    const trimmed = patch.clearVoiceApiKey.trim();
    if (trimmed.length > 0) {
      nextRaw.clearVoiceApiKey = trimmed;
    }
  }
  if (patch.clearVoiceModel !== undefined) {
    nextRaw.clearVoiceModel = String(patch.clearVoiceModel).trim();
  }
  if (patch.qwen3AsrServiceUrl !== undefined) {
    const rawUrl = String(patch.qwen3AsrServiceUrl).trim();
    if (rawUrl && !normalizeUrl(rawUrl)) {
      throw new Error("Qwen3-ASR 在线服务地址必须是以 http:// 或 https:// 开头的有效地址");
    }
    nextRaw.qwen3AsrServiceUrl = rawUrl;
  }
  if (patch.clearQwen3AsrApiKey === true) {
    nextRaw.qwen3AsrApiKey = "";
  } else if (typeof patch.qwen3AsrApiKey === "string") {
    const trimmed = patch.qwen3AsrApiKey.trim();
    if (trimmed.length > 0) {
      nextRaw.qwen3AsrApiKey = trimmed;
    }
  }
  if (patch.qwen3AsrModel !== undefined) {
    nextRaw.qwen3AsrModel = String(patch.qwen3AsrModel).trim();
  }
  if (patch.xfyunEndpointUrl !== undefined) {
    const rawWsUrl = String(patch.xfyunEndpointUrl).trim();
    if (rawWsUrl && !normalizeWsUrl(rawWsUrl)) {
      throw new Error("讯飞听写 WebSocket 地址必须是以 ws:// 或 wss:// 开头的有效地址");
    }
    nextRaw.xfyunEndpointUrl = rawWsUrl || DEFAULT_XFYUN_IAT_ENDPOINT;
  }
  if (patch.xfyunAppId !== undefined) {
    nextRaw.xfyunAppId = String(patch.xfyunAppId).trim().slice(0, 64);
  }
  if (patch.clearXfyunApiKey === true) {
    nextRaw.xfyunApiKey = "";
  } else if (typeof patch.xfyunApiKey === "string") {
    const trimmed = patch.xfyunApiKey.trim();
    if (trimmed.length > 0) {
      nextRaw.xfyunApiKey = trimmed;
    }
  }
  if (patch.clearXfyunApiSecret === true) {
    nextRaw.xfyunApiSecret = "";
  } else if (typeof patch.xfyunApiSecret === "string") {
    const trimmed = patch.xfyunApiSecret.trim();
    if (trimmed.length > 0) {
      nextRaw.xfyunApiSecret = trimmed;
    }
  }
  if (patch.voiceWsAsrEndpointUrl !== undefined) {
    const rawWsUrl = String(patch.voiceWsAsrEndpointUrl).trim();
    if (rawWsUrl && !normalizeVoiceWsAsrUrl(rawWsUrl)) {
      throw new Error(
        "统一流式语音听写网关地址必须是以 ws://、wss://、http:// 或 https:// 开头的有效地址",
      );
    }
    nextRaw.voiceWsAsrEndpointUrl = rawWsUrl || DEFAULT_VOICE_WS_ASR_ENDPOINT;
  }
  if (patch.clearVoiceWsAsrAuthCode === true) {
    nextRaw.voiceWsAsrAuthCode = "";
  } else if (typeof patch.voiceWsAsrAuthCode === "string") {
    const trimmed = patch.voiceWsAsrAuthCode.trim();
    if (trimmed.length > 0) {
      nextRaw.voiceWsAsrAuthCode = trimmed;
    }
  }
  if (patch.voiceWsAsrDenoise !== undefined) {
    nextRaw.voiceWsAsrDenoise = Boolean(patch.voiceWsAsrDenoise);
  }
  if (patch.voiceWsAsrLanguage !== undefined) {
    nextRaw.voiceWsAsrLanguage =
      patch.voiceWsAsrLanguage === null ? "" : String(patch.voiceWsAsrLanguage).trim().slice(0, 32);
  }
  if (patch.localAsrEngine !== undefined) {
    const rawAsr = String(patch.localAsrEngine).trim().toLowerCase();
    const mappedAsr = LOCAL_ASR_ENGINE_ALIASES[rawAsr];
    if (!mappedAsr || !VALID_LOCAL_ASR_ENGINES.has(mappedAsr)) {
      throw new Error(`不支持的语音识别方案: ${rawAsr}`);
    }
    nextRaw.localAsrEngine = mappedAsr;
  }
  if (patch.qwen3StreamingEnabled !== undefined) {
    nextRaw.qwen3StreamingEnabled = Boolean(patch.qwen3StreamingEnabled);
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
  if (patch.asyncVoicePipeline !== undefined) {
    nextRaw.asyncVoicePipeline = Boolean(patch.asyncVoicePipeline);
  }
  if (patch.echoCancellationMode !== undefined) {
    const em = String(patch.echoCancellationMode).trim().toLowerCase();
    if (!VALID_ECHO_MODES.has(em)) {
      throw new Error(`不支持的回声消除模式: ${em}`);
    }
    nextRaw.echoCancellationMode = em;
  }
  if (patch.bargeInDuckingEnabled !== undefined) {
    nextRaw.bargeInDuckingEnabled = Boolean(patch.bargeInDuckingEnabled);
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
  if (patch.silentSimpleControlReply !== undefined) {
    nextRaw.silentSimpleControlReply = Boolean(patch.silentSimpleControlReply);
  }
  if (patch.thinkingLevel !== undefined) {
    const tlRaw = String(patch.thinkingLevel).trim().toLowerCase();
    const mapped = THINKING_LEVEL_ALIASES[tlRaw];
    if (!mapped || !VALID_THINKING_LEVEL_SET.has(mapped)) {
      throw new Error(`不支持的 AI 思考等级: ${tlRaw}`);
    }
    nextRaw.thinkingLevel = mapped;
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
