import { Buffer } from 'node:buffer';
import http from 'node:http';
import https from 'node:https';
import { type Interceptor, InterceptorBase } from '@bugsee/core';
import type { NetworkEvent, NetworkStage, NoBodyReason } from '@bugsee/protocol';

// Node-native HTTP capture SOURCE (design §16.2, mechanism 'http'). Wraps node:http and node:https
// `request`/`get`; libraries like axios / got / node-fetch issue requests through these and so bypass
// global `fetch`. Same metadata-first shape as the fetch source — url / method / request+response
// headers / status / timing; bodies deferred — emitting before → complete | error. The wrap is
// installed only while ACTIVE (subscriber-presence / explicit start, via InterceptorBase) and removed
// when idle. Patching both `request` and `get` never double-captures: node's `get` calls its
// lexically-scoped `request`, not the patched `exports.request`. This is a @bugsee/node source folded
// into capture's NetworkInterceptor umbrella via installNetworkCapture({ additionalSources }).

/** A node:http-like ClientRequest: the `response`/`error` events we observe + the body-writing methods
 * (`write`/`end`) we wrap per-instance to capture the OUTGOING request body. */
interface ClientRequest {
  on(event: string, listener: (arg: unknown) => void): unknown;
  listenerCount(event: string): number;
  write(...args: unknown[]): unknown;
  end(...args: unknown[]): unknown;
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
  // The Readable producer hook the HTTP parser feeds body chunks into (push(null) = EOF). We wrap it
  // per-instance to PASSIVELY observe the response body without consuming the stream or changing its
  // flow mode (a `.on('data')` would force flowing mode and break a paused / async-iterating consumer).
  push(chunk: unknown, encoding?: unknown): boolean;
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
  // Truthy guard so an unset/empty/0 port is omitted (port 0 = "any", not a real target).
  const port = options?.port ? `:${options.port}` : '';
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

/** Case-insensitive header lookup over a normalized record. */
const headerValueCI = (headers: Record<string, string>, name: string): string | undefined => {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) {
      return value;
    }
  }
  return undefined;
};

// A body chunk from node:http write/end/push is a string, a Buffer, or any ArrayBufferView (Uint8Array,
// etc.). Copy a view's RAW bytes (don't String() it — that would capture "104,105" instead of the
// bytes); a string is encoded with its declared encoding (default utf8). Never mutates the input.
const chunkToBuffer = (chunk: unknown, encoding: unknown): Buffer => {
  if (Buffer.isBuffer(chunk)) {
    return chunk;
  }
  if (ArrayBuffer.isView(chunk)) {
    return Buffer.from(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
  }
  return Buffer.from(
    String(chunk),
    typeof encoding === 'string' ? (encoding as BufferEncoding) : 'utf8',
  );
};

interface BodyAccumulator {
  /** Observe a body chunk (null/undefined and anything after the cap is ignored). */
  add(chunk: unknown, encoding: unknown): void;
  /** size_too_large if over cap; undefined if there was no body; else the decoded `{ body }`. */
  result(): { body?: string; reason?: NoBodyReason } | undefined;
}

// Accumulate body chunks up to a byte cap; over-cap drops the whole body (size_too_large). Shared by
// the request (write/end) and response (push) observers.
const createBodyAccumulator = (maxBytes: number): BodyAccumulator => {
  const chunks: Buffer[] = [];
  let total = 0;
  let overCap = false;
  return {
    add(chunk, encoding) {
      if (overCap || chunk === null || chunk === undefined) {
        return;
      }
      const buf = chunkToBuffer(chunk, encoding);
      total += buf.length;
      if (total > maxBytes) {
        overCap = true;
        chunks.length = 0; // the whole body is over-cap
        return;
      }
      chunks.push(buf);
    },
    result() {
      if (overCap) {
        return { reason: 'size_too_large' };
      }
      if (chunks.length === 0) {
        return undefined;
      }
      return { body: Buffer.concat(chunks).toString('utf8') };
    },
  };
};

export interface NodeHttpInterceptorOptions {
  /** Wall-clock source; injectable for tests. Default Date.now. */
  now?: () => number;
  /** Per-request id (shared by a request's before/complete/error events). Default a counter. */
  newId?: () => string;
  /** Returns true to SKIP capturing a request (SDK self-isolation). Default: X-Bugsee-Internal header. */
  isInternal?: (url: string, requestHeaders: Record<string, string>) => boolean;
  /** The node:http / node:https modules to patch — the real ones by default, fakes in tests. */
  target?: NodeHttpTarget;
  /** Capture the request body (observed via write/end). Default true; off skips the wrap entirely. */
  captureBodies?: boolean;
  /** Max captured request-body size in bytes (over-cap → size_too_large). Default 20480. */
  maxBodyBytes?: number;
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
  readonly #captureBodies: boolean;
  readonly #maxBodyBytes: number;
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
    this.#captureBodies = options.captureBodies ?? true;
    this.#maxBodyBytes = options.maxBodyBytes ?? 20480;
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
      if (this.#captureBodies) {
        this.#captureRequestBody(req as ClientRequest, id, url, method, headers);
      }
      (req as ClientRequest).on('response', (response) => {
        const res = response as IncomingMessage;
        const resHeaders = normalizeHeaders(res.headers);
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
            headers: resHeaders,
            timings: { duration: this.#now() - startedAt },
          },
        });
        if (this.#captureBodies) {
          this.#captureResponseBody(res, id, url, method, resHeaders);
        }
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
        // Transparency: a ClientRequest that emits 'error' with no listener THROWS (→
        // uncaughtException). Capturing must not change that — if ours is the only 'error' listener
        // (the app installed none), re-raise so the request still fails exactly as uninstrumented.
        if ((req as ClientRequest).listenerCount('error') <= 1) {
          throw error;
        }
      });
      return req;
    };
  }

  // Emit a body OVERRIDE amendment (same id) carrying the headers (so F.1's Content-Type gate works)
  // plus the body XOR no_body_reason. `before` for the request body, `complete` for the response body.
  #emitBodyAmendment(
    stage: 'before' | 'complete',
    id: string,
    url: string,
    method: string,
    headers: Record<string, string>,
    result: { body?: string; reason?: NoBodyReason },
  ): void {
    this.emit(stage, {
      timestamp: this.#now(),
      id,
      sequence: id,
      mechanism: 'http',
      url,
      method,
      type: stage,
      override: true,
      custom: {
        headers,
        ...(result.body !== undefined ? { body: result.body } : {}),
        ...(result.reason !== undefined ? { no_body_reason: result.reason } : {}),
      },
    });
  }

  // Capture the OUTGOING request body by wrapping the ClientRequest's own write/end (per-instance, not
  // the prototype) — observe each chunk, then call through unchanged (the body the app sends is never
  // altered). The body is known only once end() is called, so it is delivered as a `before` override
  // amendment (the request headers carry the Content-Type). Bounded by maxBodyBytes. A body-less request
  // emits no amendment. node:http does not imply a Content-Type (unlike fetch/xhr), so none is synthesized.
  #captureRequestBody(
    req: ClientRequest,
    id: string,
    url: string,
    method: string,
    headers: Record<string, string>,
  ): void {
    const acc = createBodyAccumulator(this.#maxBodyBytes);
    let finalized = false;
    const finalize = (): void => {
      if (finalized) {
        return;
      }
      finalized = true;
      const result = acc.result();
      if (result !== undefined) {
        this.#emitBodyAmendment('before', id, url, method, headers, result);
      }
    };
    const originalWrite = req.write.bind(req);
    const originalEnd = req.end.bind(req);
    req.write = (...args: unknown[]): unknown => {
      acc.add(args[0], args[1]);
      return originalWrite(...args);
    };
    req.end = (...args: unknown[]): unknown => {
      // end() may be called as end(), end(cb), end(chunk[, encoding][, cb]) — only a non-function first
      // arg is a body chunk.
      if (typeof args[0] !== 'function') {
        acc.add(args[0], args[1]);
      }
      finalize();
      return originalEnd(...args);
    };
  }

  // Capture the RESPONSE body by PASSIVELY wrapping the IncomingMessage's own `push` (the producer hook
  // the HTTP parser feeds body chunks into) — observe each chunk, then call through. This never adds a
  // consumer or forces flowing mode, so the app reads the stream exactly as it would uninstrumented.
  // push(null) is EOF → the body is delivered as a `complete` override amendment. A Content-Encoding
  // body (gzip/br/…) is still-encoded on the wire and can't be read as text via push → cant_read_data
  // (fetch captures decoded bodies via undici; node:http does not). Bounded by maxBodyBytes; a body-less
  // response emits no amendment.
  #captureResponseBody(
    res: IncomingMessage,
    id: string,
    url: string,
    method: string,
    headers: Record<string, string>,
  ): void {
    const encoding = headerValueCI(headers, 'content-encoding')?.trim().toLowerCase();
    if (encoding !== undefined && encoding !== '' && encoding !== 'identity') {
      this.#emitBodyAmendment('complete', id, url, method, headers, { reason: 'cant_read_data' });
      return;
    }
    const acc = createBodyAccumulator(this.#maxBodyBytes);
    let finalized = false;
    const originalPush = res.push.bind(res);
    res.push = (chunk: unknown, enc?: unknown): boolean => {
      if (chunk === null) {
        if (!finalized) {
          finalized = true;
          const result = acc.result();
          if (result !== undefined) {
            this.#emitBodyAmendment('complete', id, url, method, headers, result);
          }
        }
      } else {
        acc.add(chunk, enc);
      }
      return originalPush(chunk, enc);
    };
  }
}

export function createNodeHttpInterceptor(
  options?: NodeHttpInterceptorOptions,
): Interceptor<Record<NetworkStage, NetworkEvent>> {
  return new NodeHttpInterceptor(options);
}
