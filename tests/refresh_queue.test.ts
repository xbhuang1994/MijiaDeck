// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * Serial job priority queue and bounded HTTP timeout tests
 * (ported 1:1 from tests/refresh_queue_test.py).
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_TIMEOUT_MS,
  boundedFetch,
  createBoundedFetch,
  isBoundedFetch,
  type FetchLike,
} from "../src/core/httpTimeout.ts";
import { JobExecutor } from "../src/core/jobs.ts";

function createDeferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const origAbortTimeout = AbortSignal.timeout;

afterEach(() => {
  AbortSignal.timeout = origAbortTimeout;
});

describe("RefreshQueueTest", () => {
  test("refresh (priority 0) runs before queued decoration (priority 20) without parallel session use", async () => {
    const jobs = new JobExecutor();
    const entered = createDeferred();
    const release = createDeferred();
    const finished = createDeferred();

    const order: string[] = [];
    let activeCount = 0;
    let maxConcurrent = 0;

    const track = async (label: string, hook?: () => Promise<void>): Promise<void> => {
      activeCount += 1;
      maxConcurrent = Math.max(maxConcurrent, activeCount);
      try {
        if (hook) {
          await hook();
        }
        order.push(label);
      } finally {
        activeCount -= 1;
      }
    };

    try {
      jobs.submit(
        () =>
          track("running", async () => {
            entered.resolve();
            await release.promise;
          }),
        { priority: 20 },
      );

      await entered.promise;

      jobs.submit(() => track("icon1"), { priority: 20 });
      jobs.submit(
        () =>
          track("icon2").then(() => {
            finished.resolve();
          }),
        { priority: 20 },
      );
      jobs.submit(() => track("refresh"), { priority: 0 });

      // While `running` is in-flight, queued tasks must wait serially (never parallel).
      await Promise.resolve();
      expect(activeCount).toBe(1);
      expect(maxConcurrent).toBe(1);
      expect(order).toEqual([]);

      release.resolve();
      await finished.promise;

      expect(order).toEqual(["running", "refresh", "icon1", "icon2"]);
      expect(maxConcurrent).toBe(1);
    } finally {
      release.resolve();
      await jobs.shutdown();
    }
  });

  test("bounded fetch applies DEFAULT_TIMEOUT_MS, preserves explicit 120_000 long-poll timeout, and never mutates globalThis.fetch", async () => {
    const originalGlobalFetch = globalThis.fetch;
    const timeoutArgs: number[] = [];
    const capturedCalls: Array<{ input: string; init?: RequestInit }> = [];

    AbortSignal.timeout = ((ms: number): AbortSignal => {
      timeoutArgs.push(ms);
      return origAbortTimeout(ms);
    }) as typeof AbortSignal.timeout;

    const baseFetch: FetchLike = async (input, init) => {
      capturedCalls.push({ input: String(input), init });
      return new Response("ok", { status: 200 });
    };

    const proxy = createBoundedFetch(baseFetch);
    expect(isBoundedFetch(proxy)).toBe(true);
    expect(isBoundedFetch(boundedFetch)).toBe(true);
    expect(proxy.defaultTimeoutMs).toBe(DEFAULT_TIMEOUT_MS);

    // Omitted timeoutMs -> applies DEFAULT_TIMEOUT_MS.
    await proxy("https://example.invalid");
    expect(timeoutArgs).toEqual([DEFAULT_TIMEOUT_MS]);
    expect(capturedCalls[0]!.init?.signal).toBeInstanceOf(AbortSignal);

    // Explicit 120_000 ms (QR login long poll) -> preserved verbatim.
    await proxy("https://example.invalid", { timeoutMs: 120_000 });
    expect(timeoutArgs).toEqual([DEFAULT_TIMEOUT_MS, 120_000]);
    expect(capturedCalls[1]!.init?.signal).toBeInstanceOf(AbortSignal);

    // POST without explicit timeout -> also bounded by DEFAULT_TIMEOUT_MS.
    await proxy("https://example.invalid", { method: "POST" });
    expect(timeoutArgs).toEqual([DEFAULT_TIMEOUT_MS, 120_000, DEFAULT_TIMEOUT_MS]);
    expect(capturedCalls[2]!.init?.method).toBe("POST");
    expect(capturedCalls[2]!.init?.signal).toBeInstanceOf(AbortSignal);

    // User-provided AbortSignal composes cleanly without losing abort propagation.
    const externalController = new AbortController();
    externalController.abort(new Error("user cancelled"));
    await proxy("https://example.invalid", { signal: externalController.signal });
    expect(capturedCalls[3]!.init?.signal?.aborted).toBe(true);

    // globalThis.fetch is untouched and never replaced by boundedFetch.
    expect(globalThis.fetch).toBe(originalGlobalFetch);
    expect(isBoundedFetch(globalThis.fetch)).toBe(false);
    expect(globalThis.fetch).not.toBe(boundedFetch as unknown as typeof fetch);
  });
});
