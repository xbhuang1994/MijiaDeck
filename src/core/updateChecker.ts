// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * GitHub Releases 新版本检查：取最新 release 版本号与当前版本对比。
 *
 * 检查独立于 JobExecutor 串行队列执行：这是与米家无关的第三方请求，
 * 混进设备任务队列会让弱网下最长十几秒的超时连带阻塞设备加载与用户操作。
 */

import { APP_NAME, APP_VERSION, UPDATE_REPOSITORY } from "./appMeta.ts";
import { TypedEmitter } from "./contracts.ts";

export const LATEST_API = UPDATE_REPOSITORY
  ? `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases/latest`
  : "";

export const RELEASES_PAGE = UPDATE_REPOSITORY
  ? `https://github.com/${UPDATE_REPOSITORY}/releases/latest`
  : "";

const RELEASE_TAG_RE = /^[vV]?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const REQUEST_TIMEOUT_MS = 8_000;
const FALLBACK_ERROR_MESSAGE = "暂时无法连接更新服务，请稍后重试，或前往 GitHub 发布页查看。";

export interface ReleaseInfo {
  tag: string;
  url: string;
  name: string;
}

/** 版本号解析为数字段：容忍 v 前缀、预发布/构建后缀与非数字段。 */
export function versionParts(value: string): number[] {
  let core = value.trim().toLowerCase().replace(/^v+/, "");
  core = core.split(/[-+]/)[0] ?? "";
  const parts: number[] = [];
  for (const seg of core.split(".")) {
    const match = /^\d+/.exec(seg);
    parts.push(match ? Number.parseInt(match[0], 10) : 0);
  }
  return parts.length > 0 ? parts : [0];
}

/** latest 是否比 current 新；位数不等时按 0 补齐再逐段比较。 */
export function isNewer(latest: string, current: string): boolean {
  const a = versionParts(latest);
  const b = versionParts(current);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    if (ai !== bi) {
      return ai > bi;
    }
  }
  return false;
}

async function fetchWithTimeout(
  doFetch: typeof fetch,
  url: string,
  headers: Record<string, string>,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new DOMException("Update check timed out", "TimeoutError"));
  }, REQUEST_TIMEOUT_MS);
  (timer as { unref?: () => void }).unref?.();
  try {
    return await doFetch(url, {
      headers,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Prefer the API; fall back to the public latest-release redirect. */
export async function fetchLatestRelease(fetcher?: typeof fetch): Promise<ReleaseInfo> {
  if (!LATEST_API) {
    throw new Error("暂未开放更新检查");
  }

  const doFetch = fetcher ?? fetch;
  const baseHeaders = { "User-Agent": `${APP_NAME}/${APP_VERSION}` };

  try {
    const resp = await fetchWithTimeout(doFetch, LATEST_API, {
      ...baseHeaders,
      Accept: "application/vnd.github+json",
    });
    if (!resp.ok) {
      await resp.body?.cancel?.().catch(() => {});
      throw new Error(`HTTP ${resp.status}`);
    }
    const data: unknown = await resp.json();
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      throw new Error("Invalid release payload");
    }
    const record = data as Record<string, unknown>;
    const tag = String(record.tag_name ?? "").trim();
    if (!tag) {
      throw new Error("Missing release tag");
    }
    const url = String(record.html_url || RELEASES_PAGE);
    const name = String(record.name || tag);
    return { tag, url, name };
  } catch {
    // Shared public IPs can exhaust the anonymous API quota. Do not retry
    // that endpoint: the normal releases/latest page redirects to the
    // actual published tag without requiring an API token or HTML parsing.
  }

  let fallbackResp: Response | undefined;
  try {
    fallbackResp = await fetchWithTimeout(doFetch, RELEASES_PAGE, {
      ...baseHeaders,
      Accept: "text/html",
    });
    if (!fallbackResp.ok) {
      throw new Error(`HTTP ${fallbackResp.status}`);
    }
    const address = new URL(fallbackResp.url);
    const prefix = `/${UPDATE_REPOSITORY}/releases/tag/`;
    const path = decodeURIComponent(address.pathname);
    if (
      address.protocol !== "https:" ||
      address.host.toLowerCase() !== "github.com" ||
      address.username !== "" ||
      address.password !== "" ||
      !path.toLowerCase().startsWith(prefix.toLowerCase())
    ) {
      throw new Error("Unexpected release destination");
    }
    const tag = path.slice(prefix.length);
    if (!RELEASE_TAG_RE.test(tag)) {
      throw new Error("Invalid release tag");
    }
    return {
      tag,
      url: `https://github.com${prefix}${encodeURIComponent(tag)}`,
      name: `${APP_NAME} ${tag}`,
    };
  } catch {
    throw new Error(FALLBACK_ERROR_MESSAGE);
  } finally {
    await fallbackResp?.body?.cancel?.().catch(() => {});
  }
}

type UpdateCheckerEvents = {
  checkFinished: [ReleaseInfo | null, Error | null];
};

/** 异步查一次最新版本；结果通过 checkFinished 事件发出（info, error）。 */
export class UpdateChecker extends TypedEmitter<UpdateCheckerEvents> {
  async check(fetcher?: typeof fetch): Promise<void> {
    try {
      const info = await fetchLatestRelease(fetcher);
      this.emit("checkFinished", info, null);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit("checkFinished", null, error);
    }
  }
}
