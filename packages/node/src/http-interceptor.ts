import http from 'node:http';
import https from 'node:https';
import { type Interceptor, InterceptorBase } from '@bugsee/core';
import type { NetworkEvent, NetworkStage } from '@bugsee/protocol';

// Node-native HTTP capture SOURCE (design §16.2, mechanism 'http'). Wraps node:http and node:https
// `request`/`get`; libraries like axios / got / node-fetch issue requests through these and so bypass
// global `fetch`. Same metadata-first shape as the fetch source — url / method / request+response
// headers / status / timing; bodies deferred — emitting before → complete | error. The wrap is
// installed only while ACTIVE (subscriber-presence / explicit start, via InterceptorBase) and removed
// when idle. Patching both `request` and `get` never double-captures: node's `get` calls its
// lexically-scoped `request`, not the patched `exports.request`. This is a @bugsee/node source folded
// into capture's NetworkInterceptor umbrella via installNetworkCapture({ additionalSources }).

/** A node:http-like ClientRequest: an emitter exposing the `response`/`error` events we observe. */
interface ClientRequest {
  on(event: string, listener: (arg: unknown) => void): unknown;
}
type RequestFn = (...args: unknown[]) => unknown;
/** The subset of a node:http(s) module we patch — its `request` and `get` factories. */
export interface HttpModule {
  request: RequestFn;
  get: RequestFn;
}
/** The node:http and node:https modules to patch — the real ones by default, fakes in tests. */
export interface NodeHttpTarget {
  http: HttpModule;
  https: HttpModule;
}

interface HttpRequestOptions {
  protocol?: string;
  hostname?: string;
  host?: string;
  port?: string | number;
  path?: string;
  method?: string;
  headers?: unknown;
}
interface IncomingMessage {
  statusCode: number;
  statusMessage: string;
  headers: unknown;
}

// Node header bags map a name to a string, a number, or a string[] (multi-value). Flatten arrays to a
// comma-joined string; ignore non-object bags (undefined/null/primitive) → {}.
const normalizeHeaders = (headers: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  if (headers === null || typeof headers !== 'object') {
    return out;
  }
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    out[key] = Array.isArray(value) ? value.map(String).join(', ') : String(value);
  }
  return out;
};

// Reconstruct the request URL from an options object when no explicit url/URL was passed.
const buildUrl = (options: HttpRequestOptions | undefined, secure: boolean): string => {
  const protocol =
    typeof options?.protocol === 'string' ? options.protocol : secure ? 'https:' : 'http:';
  const host =
    (typeof options?.hostname === 'string' && options.hostname) ||
    (typeof options?.host === 'string' && options.host) ||
    'localhost';
  const port = options?.port !== undefined && options.port !== '' ? `:${options.port}` : '';
  const path = typeof options?.path === 'string' ? options.path : '/';
  return `${protocol}//${host}${port}${path}`;
};

// node:http(s) request/get accept (url), (url, options), (options) — each optionally trailed by a
// callback. Tease out the url (string or URL.href), method and headers; callbacks are ignored.
const resolveRequest = (
  args: readonly unknown[],
  secure: boolean,
): { url: string; method: string; headers: Record<string, string> } => {
  let urlArg: string | undefined;
  let options: HttpRequestOptions | undefined;
  const first = args[0];
  if (typeof first === 'string') {
    urlArg = first;
  } else if (first !== null && typeof first === 'object') {
    const href = (first as { href?: unknown }).href;
    if (typeof href === 'string') {
      urlArg = href; // a URL (or URL-like) object
    } else {
      options = first as HttpRequestOptions; // an options object
    }
  }
  if (options === undefined) {
    const second = args[1];
    if (second !== null && typeof second === 'object') {
      options = second as HttpRequestOptions; // (url|URL, options[, cb])
    }
  }
  const method = typeof options?.method === 'string' ? options.method.toUpperCase() : 'GET';
  return {
    url: urlArg ?? buildUrl(options, secure),
    method,
    headers: normalizeHeaders(options?.headers),
  };
};

/** Default self-isolation: skip the SDK's own outbound requests, tagged X-Bugsee-Internal (§14.6). */
const hasInternalHeader = (headers: Record<string, string>): boolean =>
  Object.keys(headers).some((key) => key.toLowerCase() === 'x-bugsee-internal');

export interface NodeHttpInterceptorOptions {
  /** Wall-clock source; injectable for tests. Default Date.now. */
  now?: () => number;
  /** Per-request id (shared by a request's before/complete/error events). Default a counter. */
  newId?: () => string;
  /** Returns true to SKIP capturing a request (SDK self-isolation). Default: X-Bugsee-Internal header. */
  isInternal?: (url: string, requestHeaders: Record<string, string>) => boolean;
  /** The node:http / node:https modules to patch — the real ones by default, fakes in tests. */
  target?: NodeHttpTarget;
}

interface Patch {
  module: HttpModule;
  key: 'request' | 'get';
  original: RequestFn;
}

class NodeHttpInterceptor extends InterceptorBase<Record<NetworkStage, NetworkEvent>> {
  readonly name = 'node-http';
  readonly #now: () => number;
  readonly #newId: () => string;
  readonly #isInternal: (url: string, headers: Record<string, string>) => boolean;
  readonly #target: NodeHttpTarget;
  #patches: Patch[] = [];
  #counter = 0;

  constructor(options: NodeHttpInterceptorOptions = {}) {
    super();
    this.#now = options.now ?? (() => Date.now());
    this.#newId =
      options.newId ??
      (() => {
        this.#counter += 1;
        return `h${this.#counter}`;
      });
    this.#isInternal = options.isInternal ?? ((_url, headers) => hasInternalHeader(headers));
    // The real node modules expose the same request/get factories we patch; their precise overload
    // types aren't structurally assignable to our minimal RequestFn, so widen through unknown.
    this.#target = options.target ?? ({ http, https } as unknown as NodeHttpTarget);
  }

  protected onActivate(): void {
    for (const [module, secure] of [
      [this.#target.http, false],
      [this.#target.https, true],
    ] as const) {
      for (const key of ['request', 'get'] as const) {
        const original = module[key];
        this.#patches.push({ module, key, original });
        module[key] = this.#wrap(original, secure);
      }
    }
  }

  protected override onDeactivate(): void {
    for (const { module, key, original } of this.#patches) {
      module[key] = original;
    }
    this.#patches = [];
  }

  #wrap(original: RequestFn, secure: boolean): RequestFn {
    return (...args: unknown[]) => {
      const req = original(...args); // always call through, unchanged
      const { url, method, headers } = resolveRequest(args, secure);
      if (this.#isInternal(url, headers)) {
        return req; // the SDK's own traffic — pass through without capturing
      }
      const id = this.#newId();
      const startedAt = this.#now();
      this.emit('before', {
        timestamp: startedAt,
        id,
        sequence: id,
        mechanism: 'http',
        url,
        method,
        type: 'before',
        custom: { headers },
      });
      (req as ClientRequest).on('response', (response) => {
        const res = response as IncomingMessage;
        this.emit('complete', {
          timestamp: this.#now(),
          id,
          sequence: id,
          mechanism: 'http',
          url,
          method,
          type: 'complete',
          status: res.statusCode,
          statusText: res.statusMessage,
          custom: {
            headers: normalizeHeaders(res.headers),
            timings: { duration: this.#now() - startedAt },
          },
        });
      });
      (req as ClientRequest).on('error', (error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.emit('error', {
          timestamp: this.#now(),
          id,
          sequence: id,
          mechanism: 'http',
          url,
          method,
          type: 'error',
          customError: message,
          custom: { error: message },
        });
      });
      return req;
    };
  }
}

export function createNodeHttpInterceptor(
  options?: NodeHttpInterceptorOptions,
): Interceptor<Record<NetworkStage, NetworkEvent>> {
  return new NodeHttpInterceptor(options);
}
