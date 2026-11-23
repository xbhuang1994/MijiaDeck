// SPDX-License-Identifier: GPL-3.0-or-later
// MijiaDeck: 米家设备的桌面控制端 (Bun + TypeScript)
// Copyright (C) 2026 MiHome-Windows contributors

/**
 * Bound SDK HTTP waits without altering global fetch or TLS policy.
 *
 * Explicit waits, including QR login's 120-second long poll, are preserved.
 * Other callers continue using globalThis.fetch unchanged.
 */

export const DEFAULT_CONNECT_TIMEOUT_MS = 3050;
export const DEFAULT_READ_TIMEOUT_MS = 8000;
export const DEFAULT_TIMEOUT_MS = 8000;

export type TimeoutFetchOptions = RequestInit & {
  timeoutMs?: number;
};

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const BOUNDED_FETCH_MARKER = Symbol.for("mijiadeck.boundedFetch");

export interface BoundedFetch {
  (input: string | URL | Request, init?: TimeoutFetchOptions): Promise<Response>;
  readonly defaultTimeoutMs: number;
  readonly [BOUNDED_FETCH_MARKER]: true;
  preconnect?: typeof fetch.preconnect;
}

export function isBoundedFetch(fn: unknown): fn is BoundedFetch {
  return typeof fn === "function" && (fn as Partial<BoundedFetch>)[BOUNDED_FETCH_MARKER] === true;
}

export function createBoundedFetch(
  baseFetch?: FetchLike,
  defaultTimeoutMs: number = DEFAULT_TIMEOUT_MS,
): BoundedFetch {
  const fn = ((
    input: string | URL | Request,
    init?: TimeoutFetchOptions,
  ): Promise<Response> => {
    const { timeoutMs, signal, ...rest } = init ?? {};
    const effectiveTimeoutMs = timeoutMs === undefined ? defaultTimeoutMs : timeoutMs;

    let effectiveSignal: AbortSignal | undefined = signal ?? undefined;
    if (
      typeof effectiveTimeoutMs === "number" &&
      Number.isFinite(effectiveTimeoutMs) &&
      effectiveTimeoutMs > 0
    ) {
      const timeoutSignal = AbortSignal.timeout(effectiveTimeoutMs);
      effectiveSignal = effectiveSignal
        ? AbortSignal.any([effectiveSignal, timeoutSignal])
        : timeoutSignal;
    }

    const nextInit: RequestInit = effectiveSignal
      ? { ...rest, signal: effectiveSignal }
      : { ...rest };

    const target: FetchLike = baseFetch ?? globalThis.fetch;
    return target(input, nextInit);
  }) as BoundedFetch;

  Object.defineProperty(fn, "defaultTimeoutMs", {
    value: defaultTimeoutMs,
    enumerable: true,
    writable: false,
  });
  Object.defineProperty(fn, BOUNDED_FETCH_MARKER, {
    value: true,
    enumerable: false,
    writable: false,
  });

  const basePreconnect =
    (baseFetch as (FetchLike & { preconnect?: typeof fetch.preconnect }) | undefined)?.preconnect ??
    globalThis.fetch.preconnect;
  if (typeof basePreconnect === "function") {
    fn.preconnect = basePreconnect.bind(baseFetch ?? globalThis.fetch);
  }

  return fn;
}

export const boundedFetch: BoundedFetch = createBoundedFetch();
