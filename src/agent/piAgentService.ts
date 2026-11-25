// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * MijiaDeck 内置 Pi Agent 服务（基于 @earendil-works/pi-agent-core 与 @earendil-works/pi-ai）。
 *
 * 负责：
 * - 实例化并托管真实的 Pi Agent 状态机与工具循环
 * - 桥接内置本地智能家居引擎与多厂商 LLM（DeepSeek / OpenAI / Anthropic / Gemini / Moonshot / Xiaomi / OpenRouter / 自定义 OpenAI 兼容网关）
 * - 实时派发流式文本增量、工具执行状态与最终语音播报事件给 WebSocket 与前端面板
 */

import {
  Agent,
  type AgentEvent,
  type AgentTool,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  normalizeContext,
  type Api,
  type AssistantMessage,
  type Model,
  type TextContent,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import {
  getProviderPreset,
  isLocalEndpointUrl,
  loadAgentVoiceConfig,
  PROVIDER_PRESETS,
  resolveEffectiveApiKey,
  toPublicAgentVoiceConfig,
  type AgentProviderMode,
  type AgentVoiceConfig,
  type ProviderPreset,
  type PublicAgentVoiceConfig,
} from "../core/agentConfigStore.ts";
import { TypedEmitter } from "../core/contracts.ts";
import { deviceCategoryLabel } from "../core/deviceDetailModel.ts";
import type { FetchLike } from "../core/httpTimeout.ts";
import {
  buildCavemanPromptBlock,
  compressCavemanReply,
  compressCavemanSpeakChunk,
  isSilentSentinel,
  type CavemanSpeakChunkState,
} from "./cavemanReplyPolicy.ts";
import {
  createLocalSmartHomeStreamFn,
  findRecentDeviceFromMessages,
  planDeterministicLocalCalls,
} from "./localPlannerStream.ts";
import { createSmartHomeTools, type SmartHomeToolDeps } from "./smartHomeTools.ts";
import {
  SystemOneClient,
  type CommandIntentChoice,
  type SystemOneHealthSnapshot,
} from "./systemOneClient.ts";

export interface AgentToolCallRecord {
  id: string;
  name: string;
  label: string;
  args: Record<string, unknown>;
  status: "running" | "done" | "error";
  summary: string;
  durationMs?: number;
}

export interface AgentTimelineEntry {
  id: string;
  role: "user" | "assistant";
  source: "text" | "voice";
  text: string;
  timestamp: number;
  status: "streaming" | "done" | "error" | "aborted";
  provider?: AgentProviderMode;
  modelId?: string;
  toolCalls: AgentToolCallRecord[];
  error?: string;
}

export interface PiAgentSnapshot {
  running: boolean;
  provider: AgentProviderMode;
  providerLabel: string;
  modelId: string;
  tools: Array<{ name: string; label: string; description: string }>;
  timeline: AgentTimelineEntry[];
  config: PublicAgentVoiceConfig;
  providers: ReadonlyArray<ProviderPreset>;
  systemOne: SystemOneHealthSnapshot | null;
  lastError: string | null;
}

export interface VoicePromptMeta {
  speakerName?: string | null;
  speakerRole?: "owner" | "member" | null;
  speakerScore?: number;
  wakeWord?: string | null;
  attentionReason?: string;
  intent?: CommandIntentChoice;
}

export interface PiAgentRunResult {
  ok: boolean;
  entryId: string;
  reply: string;
  toolCalls: AgentToolCallRecord[];
  streamedSpeakChunks?: boolean;
  error?: string;
}

export type PiAgentEvents = {
  stateChanged: [PiAgentSnapshot];
  streamEvent: [Record<string, unknown>];
  speakChunk: [{ entryId: string; text: string; final: boolean }];
  replyFinished: [{ entryId: string; text: string; source: "text" | "voice"; ok: boolean }];
};

export interface PiAgentServiceOptions {
  deps: SmartHomeToolDeps;
  initialConfig?: AgentVoiceConfig;
  customStreamFn?: StreamFn;
  customModel?: Model<Api>;
  systemOneFetcher?: FetchLike;
}

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function createErrorStream(model: Model<Api>, message: string): ReturnType<typeof createAssistantMessageEventStream> {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    const errMsg: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { ...ZERO_COST, total: 0 },
      },
      stopReason: "error",
      errorMessage: message,
      timestamp: Date.now(),
    };
    stream.push({ type: "error", reason: "error", error: errMsg });
    stream.end();
  });
  return stream;
}

function buildModelForConfig(config: AgentVoiceConfig): Model<Api> {
  const preset = getProviderPreset(config.provider);
  const modelId = config.modelId.trim() || preset.defaultModel;
  const baseUrl = config.baseUrl.trim() || preset.defaultBaseUrl;

  switch (config.provider) {
    case "local":
      return {
        id: modelId,
        name: "MijiaDeck 内置本地智能规划引擎",
        api: "openai-completions",
        provider: "mijiadeck-local",
        baseUrl: "http://127.0.0.1/local",
        input: ["text"],
        cost: ZERO_COST,
        reasoning: false,
        contextWindow: 32_768,
        maxTokens: 2048,
      };
    case "anthropic":
      return {
        id: modelId,
        name: modelId,
        api: "anthropic-messages",
        provider: "anthropic",
        baseUrl: baseUrl || "https://api.anthropic.com",
        input: ["text"],
        cost: ZERO_COST,
        reasoning: false,
        contextWindow: 200_000,
        maxTokens: 4096,
      };
    case "google":
      return {
        id: modelId,
        name: modelId,
        api: "google-generative-ai",
        provider: "google",
        baseUrl: baseUrl || "https://generativelanguage.googleapis.com/v1beta",
        input: ["text"],
        cost: ZERO_COST,
        reasoning: false,
        contextWindow: 1_000_000,
        maxTokens: 4096,
      };
    case "openai":
      return {
        id: modelId,
        name: modelId,
        api: baseUrl && baseUrl !== "https://api.openai.com/v1" ? "openai-completions" : "openai-responses",
        provider: "openai",
        baseUrl: baseUrl || "https://api.openai.com/v1",
        input: ["text"],
        cost: ZERO_COST,
        reasoning: false,
        contextWindow: 128_000,
        maxTokens: 4096,
      };
    case "openai-compatible": {
      const api = config.customApiType || "openai-completions";
      return {
        id: modelId,
        name: modelId,
        api,
        provider: config.customProviderName || "openai-compatible",
        baseUrl: baseUrl || "http://127.0.0.1:11434/v1",
        input: ["text"],
        cost: ZERO_COST,
        reasoning: false,
        contextWindow: 128_000,
        maxTokens: 4096,
      };
    }
    case "deepseek":
    case "moonshot":
    case "xiaomi":
    case "openrouter":
    default:
      return {
        id: modelId,
        name: modelId,
        api: "openai-completions",
        provider: config.provider,
        baseUrl: baseUrl || "http://127.0.0.1:11434/v1",
        input: ["text"],
        cost: ZERO_COST,
        reasoning: false,
        contextWindow: 128_000,
        maxTokens: 4096,
      };
  }
}

function redactSecretFromText(raw: string): string {
  return raw
    .replace(/sk-[A-Za-z0-9_\-]{8,}/g, "[REDACTED]")
    .replace(/(api[_-]?key|authorization|bearer)\s*[:=]\s*[^\s,;'"&}]+/gi, "[REDACTED]")
    .trim();
}

export class PiAgentService extends TypedEmitter<PiAgentEvents> {
  private readonly _deps: SmartHomeToolDeps;
  private readonly _tools: AgentTool<any>[];
  private readonly _toolLabels = new Map<string, string>();
  private readonly _localStreamFn: StreamFn;
  private readonly _customStreamFn?: StreamFn;
  private readonly _customModel?: Model<Api>;
  private readonly _systemOneFetcher?: FetchLike;

  private _config: AgentVoiceConfig;
  private _systemOne: SystemOneClient | null = null;
  private _agent: Agent;
  private _unsubAgent: (() => void) | null = null;
  private _timeline: AgentTimelineEntry[] = [];
  private _activeAssistantEntry: AgentTimelineEntry | null = null;
  private _activeSource: "text" | "voice" = "text";
  private _activeVoiceMeta: VoicePromptMeta | null = null;
  private _speakCursor = 0;
  private _rawStreamText = "";
  private _speakChunkState: CavemanSpeakChunkState = { emittedAny: false };
  private _suppressedSilent = false;
  private _emittedSpeakChunks = false;
  private _turnUseLocalFastPath = false;
  private _lastError: string | null = null;
  private _running = false;
  private _entrySeq = 0;

  // Lazy provider stream singletons
  private readonly _openaiCompletions = openAICompletionsApi();
  private readonly _openaiResponses = openAIResponsesApi();
  private readonly _anthropicApi = anthropicMessagesApi();
  private readonly _googleApi = googleGenerativeAIApi();

  constructor(options: PiAgentServiceOptions) {
    super();
    this._deps = options.deps;
    this._config = options.initialConfig ?? loadAgentVoiceConfig();
    this._customStreamFn = options.customStreamFn;
    this._customModel = options.customModel;
    this._systemOneFetcher = options.systemOneFetcher;
    this._systemOne = SystemOneClient.fromConfig(this._config, this._systemOneFetcher);
    this._tools = createSmartHomeTools(this._deps);
    for (const tool of this._tools) {
      this._toolLabels.set(tool.name, tool.label || tool.name);
    }
    this._localStreamFn = createLocalSmartHomeStreamFn({
      getDevices: () => this._deps.mainWindow.allDevices,
      getScenes: () => this._deps.mainWindow.scenes ?? [],
      getKnownPower: () => this._deps.mainWindow.knownPower,
      getCavemanMode: () => this._config.cavemanMode,
      classifyImplicitAction: async (utterance: string) => {
        const client = this._systemOne;
        if (!client?.enabled) return null;
        const recentHistory = this.recentConversationTurns(5).map((t) => ({
          role: t.role,
          text: t.text,
        }));
        const res = await client.classifyImplicitAction({ utterance, recentHistory });
        if (!res) return null;
        if (res.needsAgent) {
          return res.action === "needs_llm_agent" ? "needs_llm_agent" : null;
        }
        return res.action;
      },
    });
    this._agent = this._createAgent();
  }

  get config(): AgentVoiceConfig {
    return this._config;
  }

  get systemOneClient(): SystemOneClient | null {
    return this._systemOne;
  }

  get running(): boolean {
    return this._running;
  }

  get agent(): Agent {
    return this._agent;
  }

  private _buildSystemPrompt(): string {
    const mw = this._deps.mainWindow;
    const devices = mw.allDevices;
    const scenes = mw.scenes ?? [];

    const deviceCatalog =
      devices.length === 0
        ? "（当前尚未同步到任何设备）"
        : devices
            .slice(0, 80)
            .map((d) => {
              const pw = mw.knownPower[d.did];
              const pwText = typeof pw === "boolean" ? (pw ? "开" : "关") : "";
              const metric = mw.metrics[d.did] ?? "";
              return `- ${d.name} | 房间:${d.room_name || "未分配"} | 类型:${deviceCategoryLabel(d)} | ${
                d.online ? "在线" : "离线"
              }${pwText ? ` | 电源:${pwText}` : ""}${metric ? ` | ${metric}` : ""} | did=${d.did}`;
            })
            .join("\n");

    const sceneCatalog =
      scenes.length === 0
        ? "（无手动场景）"
        : scenes
            .slice(0, 30)
            .map((s) => `- ${s.name}${s.home_name ? ` (${s.home_name})` : ""} | id=${s.scene_id}`)
            .join("\n");

    const extra = this._config.systemPromptExtra.trim();
    const vm = this._activeVoiceMeta;
    const cavemanBlock = buildCavemanPromptBlock(this._config.cavemanMode, {
      isVoice: this._activeSource === "voice",
      speakerName: vm?.speakerName,
      speakerRole: vm?.speakerRole,
    });
    const intentHint = vm?.intent ? `Intent hint: ${vm.intent}.` : "";
    return [
      "你是 MijiaDeck 内置的智能家居控制助手（Pi Agent），专门负责响应用户的语音或文字指令，并通过工具真实地查询和控制用户的米家智能设备与手动场景。",
      "执行原则：",
      "1. 当用户要求开关设备、调节灯光亮度/色温/颜色、控制小米/小爱音箱（开关、播放指定歌曲、调节音量、静音、暂停/停止/切歌）、设置设备属性、执行动作（如喂食器出粮）、执行场景或查询传感器状态时，必须调用对应工具完成实际操作，绝不虚构操作结果。",
      "2. 控制小米/小爱音箱（包括开关音箱、播放指定音乐/歌曲、设置或增减音量、静音、暂停/停止/播放/切歌）优先使用 `control_speaker` 工具。",
      "3. 支持一次响应中包含多个工具调用（例如同时调节客厅灯亮度并关闭餐厅主灯）。",
      "4. 完成工具调用后直接告知执行结果或读取到的数据，严格遵循下方回复风格约束，不要输出内部 did/id 或冗长客套。",
      "5. 若设备离线、未登录或找不到匹配设备，诚实告知原因。",
      "",
      cavemanBlock,
      ...(intentHint ? [intentHint] : []),
      "",
      `当前家庭：${mw.currentHome || "全部"} | 房间列表：${mw.tabNames.join("、") || "全屋"}`,
      "当前设备清单：",
      deviceCatalog,
      "",
      "当前手动场景：",
      sceneCatalog,
      extra ? `\n用户附加指令：\n${extra}` : "",
    ]
      .filter((line) => line !== undefined)
      .join("\n");
  }

  private _createStreamFn(): StreamFn {
    if (this._customStreamFn) {
      return this._customStreamFn;
    }

    return (model, context, options) => {
      if (this._config.provider === "local") {
        return this._localStreamFn(model, context, options);
      }

      const apiKey = options?.apiKey || resolveEffectiveApiKey(this._config);
      const localUrl = isLocalEndpointUrl(model.baseUrl);
      const effectiveKey = apiKey || (localUrl ? "ollama" : undefined);

      if (!effectiveKey) {
        const preset = getProviderPreset(this._config.provider);
        return createErrorStream(
          model,
          `尚未配置「${preset.label}」的 API Key，请在「设置 → 语音与 Pi Agent」中填写，或切换回「内置本地引擎（免 API Key）」。`,
        );
      }

      // 借鉴 Home Assistant assist_pipeline `prefer_local_intents` 架构（默认关闭，可在设置中手动开启）：
      // 开启后即使配置了云端大模型，常规确定性智能家居指令（如“打开客厅灯”“停止播放音乐”“音量调到30”）
      // 也由本地规划器 + 工具循环零延迟执行（省去两次云端 LLM 往返 ~1.5~4s），
      // 复杂推理、口语隐式意图或开放问答无缝交由云端大模型处理。
      if (this._config.preferLocalIntents === true) {
        const msgs = context.messages;
        const lastMsg = msgs[msgs.length - 1];
        if (lastMsg && lastMsg.role === "toolResult" && this._turnUseLocalFastPath) {
          return this._localStreamFn(model, context, options);
        }
        if (lastMsg && lastMsg.role === "user") {
          const userText =
            typeof lastMsg.content === "string"
              ? lastMsg.content
              : lastMsg.content
                  .filter((b): b is TextContent => b.type === "text")
                  .map((b) => b.text)
                  .join(" ");
          const recentTarget = findRecentDeviceFromMessages(msgs.slice(0, -1));
          const deterministicCalls = planDeterministicLocalCalls(
            userText,
            {
              getDevices: () => this._deps.mainWindow.allDevices,
              getScenes: () => this._deps.mainWindow.scenes ?? [],
            },
            recentTarget,
          );
          if (deterministicCalls) {
            this._turnUseLocalFastPath = true;
            return this._localStreamFn(model, context, options);
          }
          this._turnUseLocalFastPath = false;
        }
      }

      const streamOpts = {
        ...options,
        apiKey: effectiveKey,
      };

      try {
        switch (model.api) {
          case "anthropic-messages":
            return this._anthropicApi.streamSimple(model, context, streamOpts);
          case "google-generative-ai":
            return this._googleApi.streamSimple(model, context, streamOpts);
          case "openai-responses":
            return this._openaiResponses.streamSimple(model, context, streamOpts);
          case "openai-completions":
          default:
            return this._openaiCompletions.streamSimple(model, context, streamOpts);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return createErrorStream(model, redactSecretFromText(msg) || "调用大模型接口失败");
      }
    };
  }

  private _createAgent(): Agent {
    this._unsubAgent?.();
    const model = this._customModel ?? buildModelForConfig(this._config);
    const agent = new Agent({
      initialState: {
        systemPrompt: this._buildSystemPrompt(),
        model,
        thinkingLevel: "off",
        tools: this._tools,
      },
      streamFn: this._createStreamFn(),
      getApiKey: () => resolveEffectiveApiKey(this._config),
      toolExecution: "sequential",
      prepareRequest: ({ context, model: reqModel, thinkingLevel }) => {
        // 每次请求前刷新最新设备目录到首条 system message，同时按 maxHistoryTurns 裁剪过长历史
        const msgs = [...context.messages];
        const freshPrompt = this._buildSystemPrompt();
        if (msgs.length > 0 && msgs[0]!.role === "system") {
          msgs[0] = {
            ...msgs[0]!,
            content: freshPrompt,
          };
        }
        const maxMsgs = Math.max(6, this._config.maxHistoryTurns * 4);
        let trimmed = msgs;
        if (msgs.length > maxMsgs + 1) {
          const head = msgs[0]!.role === "system" ? [msgs[0]!] : [];
          const tail = msgs.slice(-(maxMsgs));
          // 确保裁剪后不以孤立 toolResult 开头
          while (tail.length > 0 && tail[0]!.role === "toolResult") {
            tail.shift();
          }
          trimmed = [...head, ...tail];
        }
        return {
          context: { ...context, messages: trimmed },
          model: this._customModel ?? buildModelForConfig(this._config) ?? reqModel,
          thinkingLevel,
        };
      },
    });

    this._unsubAgent = agent.subscribe((event) => {
      this._handleAgentEvent(event);
    });
    return agent;
  }

  private _handleAgentEvent(event: AgentEvent): void {
    const entry = this._activeAssistantEntry;

    switch (event.type) {
      case "message_update": {
        if (!entry) break;
        const ev = event.assistantMessageEvent;
        if (ev.type === "text_delta" && ev.delta) {
          this._rawStreamText += ev.delta;
          entry.text += ev.delta;
          this.emit("streamEvent", {
            kind: "text_delta",
            entryId: entry.id,
            delta: ev.delta,
            text: entry.text,
          });
          // 流式分句语音播报：遇到句末标点立即派发，大幅降低首字播报延迟（TTFA）
          if (this._activeSource === "voice" && this._config.autoSpeakReply) {
            this._flushReadySpeakSentences(entry, false);
          }
        }
        break;
      }
      case "tool_execution_start": {
        if (!entry) break;
        const label = this._toolLabels.get(event.toolName) ?? event.toolName;
        const tc: AgentToolCallRecord = {
          id: event.toolCallId,
          name: event.toolName,
          label,
          args:
            event.args && typeof event.args === "object" && !Array.isArray(event.args)
              ? (event.args as Record<string, unknown>)
              : {},
          status: "running",
          summary: "正在执行…",
        };
        entry.toolCalls.push(tc);
        this.emit("streamEvent", {
          kind: "tool_start",
          entryId: entry.id,
          toolCall: { ...tc },
        });
        this.emit("stateChanged", this.snapshot());
        break;
      }
      case "tool_execution_end": {
        if (!entry) break;
        const existing = entry.toolCalls.find((t) => t.id === event.toolCallId);
        const detailsUiSummary =
          event.result?.details && typeof event.result.details === "object"
            ? (event.result.details as { uiSummary?: unknown }).uiSummary
            : undefined;
        const cleanUiSummary =
          typeof detailsUiSummary === "string" ? detailsUiSummary.trim() : "";
        const resultContent = Array.isArray(event.result?.content)
          ? (event.result.content as Array<{ type?: string; text?: string }>)
              .filter((c) => c.type === "text" && typeof c.text === "string")
              .map((c) => c.text)
              .join(" ")
              .trim()
          : "";
        const rawSummary = cleanUiSummary || resultContent;
        const summary = rawSummary
          ? rawSummary.length > 180
            ? `${rawSummary.slice(0, 180)}…`
            : rawSummary
          : event.isError
            ? "执行失败"
            : "执行完成";

        if (existing) {
          existing.status = event.isError ? "error" : "done";
          existing.summary = summary;
          existing.durationMs = event.durationMs;
          this.emit("streamEvent", {
            kind: "tool_end",
            entryId: entry.id,
            toolCall: { ...existing },
          });
        }
        this.emit("stateChanged", this.snapshot());
        break;
      }
      case "message_end": {
        if (!entry) break;
        const msg = event.message;
        if (msg.role === "assistant") {
          const textBlocks = msg.content
            .filter((b): b is TextContent => b.type === "text")
            .map((b) => b.text)
            .join("")
            .trim();
          if (textBlocks) {
            if (!this._rawStreamText) {
              this._rawStreamText = textBlocks;
            }
            entry.text = textBlocks;
          }
          if (msg.stopReason === "error") {
            entry.status = "error";
            entry.error = redactSecretFromText(msg.errorMessage || "Pi Agent 执行出错");
            if (!entry.text) {
              entry.text = entry.error;
            }
            this._lastError = entry.error;
          } else if (msg.stopReason === "aborted") {
            entry.status = "aborted";
            if (!entry.text) {
              entry.text = "已中断当前操作。";
            }
          } else if (entry.text) {
            if (isSilentSentinel(entry.text)) {
              entry.text = "";
              this._suppressedSilent = true;
            } else {
              entry.text = compressCavemanReply(
                entry.text,
                this._config.cavemanMode,
                this._activeSource === "voice",
              );
            }
          }
        }
        break;
      }
      default:
        break;
    }
  }

  private _flushReadySpeakSentences(entry: AgentTimelineEntry, final: boolean): void {
    const sourceText = this._rawStreamText || entry.text;
    if (!final) {
      while (this._speakCursor < sourceText.length) {
        const remaining = sourceText.slice(this._speakCursor);
        const m = /^([\s\S]*?(?:[。！？!?\n]|(?<!\d)\.(?=\s|$)))/.exec(remaining);
        if (!m) break;
        this._speakCursor += m[1]!.length;
        const filtered = compressCavemanSpeakChunk(
          m[1]!,
          this._config.cavemanMode,
          this._speakChunkState,
        );
        if (filtered.length >= 2) {
          this._emittedSpeakChunks = true;
          this.emit("speakChunk", { entryId: entry.id, text: filtered, final: false });
        }
      }
      return;
    }

    const remaining = sourceText.slice(this._speakCursor);
    this._speakCursor = sourceText.length;
    if (!remaining.trim()) return;
    const filtered = compressCavemanSpeakChunk(
      remaining,
      this._config.cavemanMode,
      this._speakChunkState,
    );
    if (filtered) {
      this._emittedSpeakChunks = true;
      this.emit("speakChunk", { entryId: entry.id, text: filtered, final: true });
    }
  }

  /**
   * 返回近期对话轮次，供唤醒词注意力门控判断当前是否处于与助手的连续对话中。
   */
  recentConversationTurns(limit = 6): Array<{ role: "user" | "assistant"; text: string; timestamp: number }> {
    return this._timeline
      .filter((e) => e.status === "done" && e.text.trim().length > 0)
      .slice(-limit)
      .map((e) => ({
        role: e.role,
        text: e.text,
        timestamp: e.timestamp,
      }));
  }

  /**
   * 轻量零工具 LLM 注意力思考调用（不污染主对话历史），供唤醒词注意力门控调用。
   */
  async evaluateAttention(promptText: string, timeoutMs = 3500): Promise<string | null> {
    if (this._config.provider === "local" && !this._customStreamFn) {
      return null;
    }
    const model = this._customModel ?? buildModelForConfig(this._config);
    const apiKey = resolveEffectiveApiKey(this._config);
    const localUrl = isLocalEndpointUrl(model.baseUrl);
    const effectiveKey = apiKey || (localUrl ? "ollama" : undefined);
    if (!effectiveKey && !this._customStreamFn) {
      return null;
    }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    (timer as { unref?: () => void }).unref?.();

    try {
      const context = normalizeContext({
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: promptText }],
            timestamp: Date.now(),
          },
        ],
      });
      const streamOpts = {
        apiKey: effectiveKey,
        signal: ac.signal,
        maxTokens: 600,
        temperature: 0,
      };
      const stream = this._customStreamFn
        ? await this._customStreamFn(model, context, streamOpts)
        : model.api === "anthropic-messages"
          ? this._anthropicApi.streamSimple(model, context, streamOpts)
          : model.api === "google-generative-ai"
            ? this._googleApi.streamSimple(model, context, streamOpts)
            : model.api === "openai-responses"
              ? this._openaiResponses.streamSimple(model, context, streamOpts)
              : this._openaiCompletions.streamSimple(model, context, streamOpts);

      let outText = "";
      for await (const ev of stream) {
        if (ev.type === "text_delta" && ev.delta) {
          outText += ev.delta;
        } else if (ev.type === "done" && ev.message) {
          const blocks = ev.message.content
            .filter((b): b is TextContent => b.type === "text")
            .map((b) => b.text)
            .join("")
            .trim();
          if (blocks) outText = blocks;
        } else if (ev.type === "error") {
          return null;
        }
      }
      return outText.trim() || null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  reconfigure(nextConfig: AgentVoiceConfig): void {
    const providerOrModelChanged =
      nextConfig.provider !== this._config.provider ||
      nextConfig.customProviderName !== this._config.customProviderName ||
      nextConfig.customApiType !== this._config.customApiType ||
      nextConfig.modelId !== this._config.modelId ||
      nextConfig.baseUrl !== this._config.baseUrl;
    this._config = nextConfig;
    this._systemOne?.reset();
    this._systemOne = SystemOneClient.fromConfig(this._config, this._systemOneFetcher);
    if (providerOrModelChanged && !this._running) {
      // 保留现有 UI timeline，但更新底层 Agent 的 model 配置
      this._agent.state.model = this._customModel ?? buildModelForConfig(this._config);
    }
    this.emit("stateChanged", this.snapshot());
  }

  async prompt(
    rawText: string,
    options: { source?: "text" | "voice"; voiceMeta?: VoicePromptMeta } = {},
  ): Promise<PiAgentRunResult> {
    const text = rawText.trim();
    if (!text) {
      return { ok: false, entryId: "", reply: "", toolCalls: [], error: "指令内容不能为空" };
    }
    if (this._running) {
      // 等待上一轮尽快收敛，或中止后立即响应最新语音指令
      this._agent.abort();
      await this._agent.waitForIdle();
    }

    const source = options.source ?? "text";
    this._activeSource = source;
    this._activeVoiceMeta = options.voiceMeta ?? null;
    this._speakCursor = 0;
    this._rawStreamText = "";
    this._speakChunkState = { emittedAny: false };
    this._suppressedSilent = false;
    this._emittedSpeakChunks = false;
    this._turnUseLocalFastPath = false;
    this._running = true;
    this._lastError = null;

    const userEntry: AgentTimelineEntry = {
      id: `msg_${Date.now()}_${++this._entrySeq}`,
      role: "user",
      source,
      text,
      timestamp: Date.now(),
      status: "done",
      toolCalls: [],
    };
    const assistantEntry: AgentTimelineEntry = {
      id: `msg_${Date.now()}_${++this._entrySeq}`,
      role: "assistant",
      source,
      text: "",
      timestamp: Date.now(),
      status: "streaming",
      provider: this._config.provider,
      modelId: this._customModel?.id ?? (this._config.modelId || getProviderPreset(this._config.provider).defaultModel),
      toolCalls: [],
    };

    this._timeline.push(userEntry, assistantEntry);
    if (this._timeline.length > 60) {
      this._timeline = this._timeline.slice(-60);
    }
    this._activeAssistantEntry = assistantEntry;
    this.emit("stateChanged", this.snapshot());

    try {
      await this._agent.prompt(text);
      await this._agent.waitForIdle();

      if (assistantEntry.status === "streaming") {
        assistantEntry.status = "done";
      }
      if (!this._suppressedSilent) {
        if (!assistantEntry.text.trim()) {
          if (assistantEntry.error) {
            assistantEntry.text = assistantEntry.error;
          } else if (assistantEntry.toolCalls.length > 0) {
            assistantEntry.text = assistantEntry.toolCalls
              .map((t) => t.summary)
              .filter(Boolean)
              .join("\n");
          } else {
            assistantEntry.text = "已完成处理。";
          }
        }
        if (this._activeSource === "voice" && this._config.autoSpeakReply && this._emittedSpeakChunks) {
          this._flushReadySpeakSentences(assistantEntry, true);
        }
      }
    } catch (err) {
      const cleaned = redactSecretFromText(err instanceof Error ? err.message : String(err));
      assistantEntry.status = "error";
      assistantEntry.error = cleaned || "Pi Agent 执行失败";
      assistantEntry.text = assistantEntry.error;
      this._lastError = assistantEntry.error;
    } finally {
      const streamedChunks = this._emittedSpeakChunks;
      this._running = false;
      this._turnUseLocalFastPath = false;
      this._activeAssistantEntry = null;
      this._activeVoiceMeta = null;
      this.emit("stateChanged", this.snapshot());
      this.emit("replyFinished", {
        entryId: assistantEntry.id,
        text: assistantEntry.text,
        source: this._activeSource,
        ok: assistantEntry.status === "done",
      });
      this._emittedSpeakChunks = streamedChunks;
    }

    return {
      ok: assistantEntry.status === "done",
      entryId: assistantEntry.id,
      reply: assistantEntry.text,
      toolCalls: assistantEntry.toolCalls.map((t) => ({ ...t })),
      streamedSpeakChunks: this._emittedSpeakChunks,
      ...(assistantEntry.error ? { error: assistantEntry.error } : {}),
    };
  }

  abort(): boolean {
    if (!this._running) {
      return false;
    }
    this._agent.abort();
    return true;
  }

  reset(): void {
    if (this._running) {
      this._agent.abort();
    }
    this._agent.reset();
    this._timeline = [];
    this._lastError = null;
    this._activeAssistantEntry = null;
    this.emit("stateChanged", this.snapshot());
  }

  snapshot(): PiAgentSnapshot {
    const preset = getProviderPreset(this._config.provider);
    const providerLabel =
      this._config.provider === "openai-compatible" && this._config.customProviderName.trim()
        ? this._config.customProviderName.trim()
        : preset.label;
    return {
      running: this._running,
      provider: this._config.provider,
      providerLabel,
      modelId: this._customModel?.id ?? (this._config.modelId || preset.defaultModel),
      tools: this._tools.map((t) => ({
        name: t.name,
        label: t.label,
        description: t.description,
      })),
      timeline: this._timeline.map((e) => ({
        ...e,
        toolCalls: e.toolCalls.map((tc) => ({ ...tc, args: { ...tc.args } })),
      })),
      config: toPublicAgentVoiceConfig(this._config),
      providers: PROVIDER_PRESETS,
      systemOne: this._systemOne ? this._systemOne.getStatus() : null,
      lastError: this._lastError,
    };
  }

  dispose(): void {
    if (this._running) {
      this._agent.abort();
    }
    this._unsubAgent?.();
    this._unsubAgent = null;
    this.clear();
  }
}
