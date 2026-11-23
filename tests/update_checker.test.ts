// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * Release discovery with an exhausted shared-IP API quota, without network
 * (ported 1:1 from tests/update_checker_test.py).
 */

import { describe, expect, test } from "bun:test";
import {
  LATEST_API,
  RELEASES_PAGE,
  UpdateChecker,
  fetchLatestRelease,
  isNewer,
  versionParts,
  type ReleaseInfo,
} from "../src/core/updateChecker.ts";

interface MockResponseSpec {
  status?: number;
  tag?: string;
  url?: string;
  jsonError?: Error;
}

interface TrackedMockResponse {
  response: Response;
  jsonCalls: number;
  textCalls: number;
  cancelCalls: number;
}

function makeMockResponse(spec: MockResponseSpec = {}): TrackedMockResponse {
  const status = spec.status ?? 200;
  const tag = spec.tag ?? "v1.1.3";
  const url = spec.url ?? RELEASES_PAGE;
  const tracked: TrackedMockResponse = {
    response: null as unknown as Response,
    jsonCalls: 0,
    textCalls: 0,
    cancelCalls: 0,
  };

  const mock = {
    ok: status >= 200 && status < 300,
    status,
    url,
    body: {
      cancel: async () => {
        tracked.cancelCalls += 1;
      },
    },
    json: async () => {
      tracked.jsonCalls += 1;
      if (spec.jsonError) {
        throw spec.jsonError;
      }
      return {
        tag_name: tag,
        html_url: url,
        name: `MijiaDeck ${tag}`,
      };
    },
    text: async () => {
      tracked.textCalls += 1;
      return "<html>should not be read</html>";
    },
  };

  tracked.response = mock as unknown as Response;
  return tracked;
}

function createQueueFetcher(
  steps: Array<(() => Promise<Response> | Response) | Response | Error>,
): { fetcher: typeof fetch; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let idx = 0;
  const fetcher = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init });
    const step = steps[idx < steps.length ? idx : steps.length - 1];
    idx += 1;
    if (step instanceof Error) {
      throw step;
    }
    if (typeof step === "function") {
      return step();
    }
    return step!;
  }) as unknown as typeof fetch;

  return { fetcher, calls };
}

describe("UpdateCheckerTest", () => {
  test("healthy API does not request web page", async () => {
    const apiResp = makeMockResponse({ tag: "v1.1.3" });
    const { fetcher, calls } = createQueueFetcher([apiResp.response]);

    const info = await fetchLatestRelease(fetcher);
    expect(info.tag).toBe("v1.1.3");
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe(LATEST_API);
  });

  test("API 403/429 rate limit uses published release redirect without reading HTML body", async () => {
    for (const status of [403, 429]) {
      const limited = makeMockResponse({ status });
      const web = makeMockResponse({
        status: 200,
        url: "https://github.com/Songmanual/MijiaDeck/releases/tag/v1.1.2",
      });
      const { fetcher, calls } = createQueueFetcher([limited.response, web.response]);

      const info = await fetchLatestRelease(fetcher);
      expect(info.tag).toBe("v1.1.2");
      expect(isNewer(info.tag, "1.1.1")).toBe(true);
      expect(calls.length).toBe(2);
      expect(calls[0]!.url).toBe(LATEST_API);
      expect(calls[1]!.url).toBe(RELEASES_PAGE);
      expect(web.jsonCalls).toBe(0);
      expect(web.textCalls).toBe(0);
      expect(web.cancelCalls).toBe(1);
    }
  });

  test("API bad JSON falls back to web redirect", async () => {
    const apiResp = makeMockResponse({ jsonError: new SyntaxError("bad JSON") });
    const web = makeMockResponse({
      url: "https://github.com/Songmanual/MijiaDeck/releases/tag/v1.1.2",
    });
    const { fetcher, calls } = createQueueFetcher([apiResp.response, web.response]);

    const info = await fetchLatestRelease(fetcher);
    expect(info.tag).toBe("v1.1.2");
    expect(calls.length).toBe(2);
  });

  test("unexpected redirects are rejected with 暂时无法连接更新服务", async () => {
    const badUrls = [
      "https://github.com/login",
      "https://example.com/Songmanual/MijiaDeck/releases/tag/v1.1.2",
      "https://github.com/another/repo/releases/tag/v1.1.2",
      RELEASES_PAGE,
      "https://github.com/Songmanual/MijiaDeck/releases/tag/not-a-version",
    ];

    for (const url of badUrls) {
      const web = makeMockResponse({ url });
      const { fetcher } = createQueueFetcher([new Error("PRIVATE"), web.response]);
      await expect(fetchLatestRelease(fetcher)).rejects.toThrow("暂时无法连接更新服务");
      expect(web.cancelCalls).toBe(1);
    }
  });

  test("both requests failing produce short message without raw exception or https: URL", async () => {
    const { fetcher, calls } = createQueueFetcher([
      new Error("PRIVATE-URL https://secret.example/internal"),
      new Error("PRIVATE-URL https://secret.example/internal"),
    ]);

    let caught: Error | null = null;
    try {
      await fetchLatestRelease(fetcher);
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(calls.length).toBe(2);
    expect(caught!.message).toContain("暂时无法连接更新服务");
    expect(caught!.message).not.toContain("PRIVATE");
    expect(caught!.message).not.toContain("https:");
  });

  test("isNewer and versionParts handle v-prefix, unequal lengths, and pre-release suffixes", () => {
    // v / V prefix handling
    expect(isNewer("v1.1.3", "1.1.2")).toBe(true);
    expect(isNewer("V1.2.0", "v1.1.9")).toBe(true);
    expect(isNewer("v1.1.2", "1.1.2")).toBe(false);
    expect(isNewer("1.1.1", "v1.1.2")).toBe(false);

    // Unequal segment lengths (zero-padded)
    expect(isNewer("1.1.2.1", "1.1.2")).toBe(true);
    expect(isNewer("1.1.2", "1.1.2.0")).toBe(false);
    expect(isNewer("1.2", "1.1.9")).toBe(true);
    expect(isNewer("2", "1.9.9")).toBe(true);

    // Pre-release and build metadata suffixes
    expect(versionParts("v1.2.3-beta.1")).toEqual([1, 2, 3]);
    expect(versionParts("1.2.3+20261123")).toEqual([1, 2, 3]);
    expect(isNewer("v1.2.0-rc.1", "1.1.9")).toBe(true);
    expect(isNewer("1.1.2-beta.1", "1.1.2")).toBe(false);
    expect(isNewer("1.1.3+build.9", "1.1.2")).toBe(true);
  });

  test("UpdateChecker emits checkFinished on success and failure", async () => {
    const checker = new UpdateChecker();
    const events: Array<[ReleaseInfo | null, Error | null]> = [];
    checker.on("checkFinished", (info, err) => {
      events.push([info, err]);
    });

    const okResp = makeMockResponse({ tag: "v2.0.0" });
    await checker.check(createQueueFetcher([okResp.response]).fetcher);
    expect(events.length).toBe(1);
    expect(events[0]![0]?.tag).toBe("v2.0.0");
    expect(events[0]![1]).toBeNull();

    await checker.check(createQueueFetcher([new Error("net"), new Error("net")]).fetcher);
    expect(events.length).toBe(2);
    expect(events[1]![0]).toBeNull();
    expect(events[1]![1]?.message).toContain("暂时无法连接更新服务");
  });
});
