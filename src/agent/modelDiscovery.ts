// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * 动态从各模型提供商 API 获取可用模型列表：
 * - OpenAI / DeepSeek / Moonshot / Xiaomi / OpenRouter / 自定义 OpenAI 兼容网关: GET {baseUrl}/models
 * - Anthropic: GET {baseUrl}/v1/models (x-api-key + anthropic-version)
 * - Google Gemini: GET {baseUrl}/models (x-goog-api-key)
 * - 内置本地引擎: 直接返回本地规划器模型
 */

import {
  getProviderPreset,
  isLocalEndpointUrl,
  resolveEffectiveApiKey,
  resolveEnvApiKeyForProvider,
  type AgentProviderMode,
  type AgentVoiceConfig,
  type CustomApiType,
} from "../core/agentConfigStore.ts";
import { createBoundedFetch, type FetchLike } from "../core/httpTimeout.ts";

export interface DiscoveredModel {
  id: string;
  name?: string;
  ownedBy?: string;
}

export interface FetchProviderModelsOptions {
  provider: AgentProviderMode;
  apiType?: CustomApiType;
  baseUrl?: string;
  apiKey?: string;
  savedConfig?: AgentVoiceConfig;
  fetcher?: FetchLike;
  timeoutMs?: number;
}

export interface FetchProviderModelsResult {
  ok: boolean;
  provider: AgentProviderMode;
  source: "api" | "builtin" | "fallback";
  models: DiscoveredModel[];
  error?: string;
}

function redactError(raw: string): string {
  return raw
    .replace(/sk-[A-Za-z0-9_\-]{8,}/g, "[REDACTED]")
    .replace(/(api[_-]?key|authorization|bearer|x-api-key|x-goog-api-key)\s*[:=]\s*[^\s,;'"&}]+/gi, "[REDACTED]")
    .trim();
}

function fallbackModelsFor(provider: AgentProviderMode): DiscoveredModel[] {
  const preset = getProviderPreset(provider);
  return preset.suggestedModels.map((id) => ({ id }));
}

function normalizeHttpUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  try {
    const u = new URL(trimmed);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    return trimmed.replace(/\/+$/, "");
  } catch {
    return "";
  }
}

function resolveKeyForDiscovery(opts: FetchProviderModelsOptions): string | undefined {
  if (opts.apiKey && opts.apiKey.trim()) {
    return opts.apiKey.trim();
  }
  if (opts.savedConfig) {
    const savedBase = opts.savedConfig.baseUrl.replace(/\/+$/, "");
    const reqBase = (opts.baseUrl ?? "").trim().replace(/\/+$/, "");
    const sameProvider = opts.savedConfig.provider === opts.provider;
    const sameBase = Boolean(savedBase && reqBase && savedBase === reqBase);
    if (sameProvider || sameBase) {
      const fromSaved = resolveEffectiveApiKey(opts.savedConfig);
      if (fromSaved) return fromSaved;
    }
  }
  return resolveEnvApiKeyForProvider(opts.provider);
}

function buildModelsEndpoint(
  provider: AgentProviderMode,
  rawBaseUrl: string,
  apiType?: CustomApiType,
): string {
  const preset = getProviderPreset(provider);
  const base = normalizeHttpUrl(rawBaseUrl) || preset.defaultBaseUrl;
  if (!base) return "";
  if (base.endsWith("/models")) return base;

  const isAnthropic =
    provider === "anthropic" || (provider === "openai-compatible" && apiType === "anthropic-messages");
  if (isAnthropic) {
    return base.endsWith("/v1") ? `${base}/models` : `${base}/v1/models`;
  }
  return `${base}/models`;
}

function parseOpenAiCompatibleModels(payload: unknown): DiscoveredModel[] {
  const out: DiscoveredModel[] = [];
  const seen = new Set<string>();
  const add = (idRaw: unknown, nameRaw?: unknown, ownedByRaw?: unknown): void => {
    const id = typeof idRaw === "string" ? idRaw.trim() : "";
    if (!id || seen.has(id)) return;
    seen.add(id);
    const item: DiscoveredModel = { id };
    if (typeof nameRaw === "string" && nameRaw.trim() && nameRaw.trim() !== id) {
      item.name = nameRaw.trim();
    }
    if (typeof ownedByRaw === "string" && ownedByRaw.trim()) {
      item.ownedBy = ownedByRaw.trim();
    }
    out.push(item);
  };

  if (Array.isArray(payload)) {
    for (const entry of payload) {
      if (typeof entry === "string") {
        add(entry);
      } else if (entry && typeof entry === "object") {
        const rec = entry as Record<string, unknown>;
        add(rec.id ?? rec.name ?? rec.model, rec.display_name ?? rec.name, rec.owned_by);
      }
    }
    return out;
  }

  if (!payload || typeof payload !== "object") return out;
  const rec = payload as Record<string, unknown>;

  // OpenAI / DeepSeek / Anthropic / OpenRouter / Magpie: { data: [...] }
  if (Array.isArray(rec.data)) {
    for (const item of rec.data) {
      if (typeof item === "string") {
        add(item);
      } else if (item && typeof item === "object") {
        const m = item as Record<string, unknown>;
        add(m.id ?? m.name, m.display_name ?? m.name, m.owned_by);
      }
    }
  }

  // Ollama / Google / custom gateways: { models: [...] }
  if (out.length === 0 && Array.isArray(rec.models)) {
    for (const item of rec.models) {
      if (typeof item === "string") {
        add(item.replace(/^models\//, ""));
      } else if (item && typeof item === "object") {
        const m = item as Record<string, unknown>;
        const methods = Array.isArray(m.supportedGenerationMethods)
          ? (m.supportedGenerationMethods as unknown[]).map((x) => String(x))
          : null;
        if (methods && methods.length > 0 && !methods.includes("generateContent")) {
          continue;
        }
        const rawId = String(m.id ?? m.model ?? m.name ?? "").replace(/^models\//, "");
        add(rawId, m.displayName ?? m.display_name ?? m.name, m.owned_by);
      }
    }
  }

  return out;
}

export async function fetchProviderModels(
  options: FetchProviderModelsOptions,
): Promise<FetchProviderModelsResult> {
  const { provider } = options;
  if (provider === "local") {
    return {
      ok: true,
      provider,
      source: "builtin",
      models: [{ id: "mijia-local-planner", name: "MijiaDeck 内置本地智能规划引擎" }],
    };
  }

  const effectiveApiType = options.apiType ?? options.savedConfig?.customApiType;
  const endpoint = buildModelsEndpoint(provider, options.baseUrl ?? "", effectiveApiType);
  if (!endpoint) {
    return {
      ok: false,
      provider,
      source: "fallback",
      models: fallbackModelsFor(provider),
      error: "请先填写有效的 API Base URL（以 http:// 或 https:// 开头）",
    };
  }

  const apiKey = resolveKeyForDiscovery(options);
  const localUrl = isLocalEndpointUrl(endpoint);
  if (!apiKey && !localUrl) {
    return {
      ok: false,
      provider,
      source: "fallback",
      models: fallbackModelsFor(provider),
      error: "尚未配置 API Key，请先填写 API Key 后自动获取在线模型列表",
    };
  }

  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (apiKey) {
    const isAnthropic =
      provider === "anthropic" ||
      (provider === "openai-compatible" && effectiveApiType === "anthropic-messages");
    const isGoogle =
      provider === "google" ||
      (provider === "openai-compatible" && effectiveApiType === "google-generative-ai");
    if (isAnthropic) {
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
    } else if (isGoogle) {
      headers["x-goog-api-key"] = apiKey;
    } else {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }
  }

  const bounded = createBoundedFetch(options.fetcher ?? globalThis.fetch, options.timeoutMs ?? 10_000);
  try {
    const res = await bounded(endpoint, {
      method: "GET",
      headers,
      timeoutMs: options.timeoutMs ?? 10_000,
    });
    const text = await res.text();
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const parsed = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
        const errText =
          typeof parsed.error === "string"
            ? parsed.error
            : parsed.error?.message || parsed.message || "";
        if (errText) detail = `${detail}: ${errText}`;
      } catch {
        // keep status code
      }
      return {
        ok: false,
        provider,
        source: "fallback",
        models: fallbackModelsFor(provider),
        error: `获取模型列表失败（${redactError(detail).slice(0, 160)}）`,
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return {
        ok: false,
        provider,
        source: "fallback",
        models: fallbackModelsFor(provider),
        error: "模型接口返回内容不是有效的 JSON",
      };
    }

    const models = parseOpenAiCompatibleModels(parsed);
    if (models.length === 0) {
      return {
        ok: false,
        provider,
        source: "fallback",
        models: fallbackModelsFor(provider),
        error: "接口未返回可用模型列表，已回退默认推荐列表",
      };
    }

    return {
      ok: true,
      provider,
      source: "api",
      models,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      provider,
      source: "fallback",
      models: fallbackModelsFor(provider),
      error: `无法连接模型列表接口（${redactError(msg).slice(0, 160)}）`,
    };
  }
}
