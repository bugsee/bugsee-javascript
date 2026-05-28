import { type Interceptor, InterceptorBase } from '@bugsee/core';
import type { NetworkEvent, NetworkStage } from '@bugsee/protocol';

// Cross-runtime fetch capture SOURCE (design §16.2): wraps `fetch` and emits NetworkEvents per stage
// (before → complete | error). global `fetch` is universal (browser/workers/Node≥18/Bun/Deno/edge),
// and wrapping it is the same technique everywhere, so this is shared. The wrap is installed only
// while ACTIVE (subscriber-presence / explicit start, via InterceptorBase) and removed when idle.
//
// Metadata-first: url / method / request+response headers / status / timing. Request/response BODIES
// are deferred (body capture, size limits, content-type rules are a follow-up). Sanitization is the
// consumer's job (networkProvider) — the interceptor emits raw events. SDK self-isolation skips the
// SDK's own outbound requests (X-Bugsee-Internal, §14.6). Subscribe via on('complete', …) / onAny.

// `fetch` is a DOM/Node lib global; this package carries no such lib types, so reach it via casts.
type FetchFn = (input: unknown, init?: unknown) => Promise<unknown>;

/** A read/replace handle for the fetch being wrapped — the global by default, or a custom impl. */
export interface FetchTarget {
  get(): FetchFn | undefined;
  set(fetchFn: FetchFn): void;
}

const globalFetchTarget: FetchTarget = {
  get: () => (globalThis as unknown as { fetch?: FetchFn }).fetch,
  set: (fetchFn) => {
    (globalThis as unknown as { fetch?: FetchFn }).fetch = fetchFn;
  },
};

const resolveUrl = (input: unknown): string => {
  if (typeof input === 'string') {
    return input;
  }
  if (input !== null && typeof input === 'object') {
    const o = input as { url?: unknown; href?: unknown };
    if (typeof o.url === 'string') {
      return o.url; // a Request
    }
    if (typeof o.href === 'string') {
      return o.href; // a URL
    }
  }
  return String(input);
};

const resolveMethod = (input: unknown, init: unknown): string => {
  const fromInit = (init as { method?: unknown } | undefined)?.method;
  if (typeof fromInit === 'string') {
    return fromInit.toUpperCase();
  }
  if (input !== null && typeof input === 'object') {
    const fromReq = (input as { method?: unknown }).method;
    if (typeof fromReq === 'string') {
      return fromReq.toUpperCase();
    }
  }
  return 'GET';
};

// Normalize headers from a Headers instance (forEach), an entries array, or a plain object.
const headersToRecord = (headers: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  if (headers === null || headers === undefined) {
    return out;
  }
  // Array of [name, value] entries first — arrays also have forEach, but with a different signature.
  if (Array.isArray(headers)) {
    for (const pair of headers as Array<[string, string]>) {
      out[pair[0]] = String(pair[1]);
    }
    return out;
  }
  const forEach = (headers as { forEach?: unknown }).forEach;
  if (typeof forEach === 'function') {
    (headers as { forEach: (cb: (value: string, key: string) => void) => void }).forEach(
      (value, key) => {
        out[key] = value;
      },
    );
    return out;
  }
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    out[key] = String(value);
  }
  return out;
};

const requestHeaders = (input: unknown, init: unknown): Record<string, string> => {
  const fromInit = (init as { headers?: unknown } | undefined)?.headers;
  if (fromInit !== undefined) {
    return headersToRecord(fromInit);
  }
  if (input !== null && typeof input === 'object') {
    return headersToRecord((input as { headers?: unknown }).headers);
  }
  return {};
};

/** Default self-isolation: skip the SDK's own outbound requests, tagged X-Bugsee-Internal (§14.6). */
const hasInternalHeader = (headers: Record<string, string>): boolean =>
  Object.keys(headers).some((key) => key.toLowerCase() === 'x-bugsee-internal');

export interface FetchInterceptorOptions {
  /** Wall-clock source; injectable for tests. Default Date.now. */
  now?: () => number;
  /** Per-request id (shared by a request's before/complete/error events). Default a counter. */
  newId?: () => string;
  /** Returns true to SKIP capturing a request (SDK self-isolation). Default: X-Bugsee-Internal header. */
  isInternal?: (url: string, requestHeaders: Record<string, string>) => boolean;
  /** Where to read/replace the wrapped fetch — the global by default, or a custom/library fetch. */
  target?: FetchTarget;
}

class FetchInterceptor extends InterceptorBase<Record<NetworkStage, NetworkEvent>> {
  readonly name = 'fetch';
  readonly #now: () => number;
  readonly #newId: () => string;
  readonly #isInternal: (url: string, headers: Record<string, string>) => boolean;
  readonly #target: FetchTarget;
  #original: FetchFn | null = null;
  #counter = 0;

  constructor(options: FetchInterceptorOptions = {}) {
    super();
    this.#now = options.now ?? (() => Date.now());
    this.#newId =
      options.newId ??
      (() => {
        this.#counter += 1;
        return `f${this.#counter}`;
      });
    this.#isInternal = options.isInternal ?? ((_url, headers) => hasInternalHeader(headers));
    this.#target = options.target ?? globalFetchTarget;
  }

  protected onActivate(): void {
    const original = this.#target.get();
    if (typeof original !== 'function') {
      return; // no fetch to wrap in this runtime / target
    }
    this.#original = original;
    this.#target.set(this.#wrap(original));
  }

  protected override onDeactivate(): void {
    if (this.#original !== null) {
      this.#target.set(this.#original);
      this.#original = null;
    }
  }

  #wrap(original: FetchFn): FetchFn {
    return (input, init) => {
      const call = original(input, init); // always call through, unchanged
      const reqHeaders = requestHeaders(input, init);
      const url = resolveUrl(input);
      if (this.#isInternal(url, reqHeaders)) {
        return call; // the SDK's own traffic — pass through without capturing
      }
      const method = resolveMethod(input, init);
      const id = this.#newId();
      const startedAt = this.#now();
      this.emit('before', {
        timestamp: startedAt,
        id,
        sequence: id,
        mechanism: 'fetch',
        url,
        method,
        type: 'before',
        custom: { headers: reqHeaders },
      });
      return call.then(
        (response) => {
          const res = response as {
            status: number;
            statusText: string;
            redirected: boolean;
            headers: unknown;
          };
          this.emit('complete', {
            timestamp: this.#now(),
            id,
            sequence: id,
            mechanism: 'fetch',
            url,
            method,
            type: 'complete',
            status: res.status,
            statusText: res.statusText,
            redirect: res.redirected,
            custom: {
              headers: headersToRecord(res.headers),
              timings: { duration: this.#now() - startedAt },
            },
          });
          return response;
        },
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          this.emit('error', {
            timestamp: this.#now(),
            id,
            sequence: id,
            mechanism: 'fetch',
            url,
            method,
            type: 'error',
            customError: message,
            custom: { error: message },
          });
          throw error;
        },
      );
    };
  }
}

export function createFetchInterceptor(
  options?: FetchInterceptorOptions,
): Interceptor<Record<NetworkStage, NetworkEvent>> {
  return new FetchInterceptor(options);
}
