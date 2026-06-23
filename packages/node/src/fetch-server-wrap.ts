import {
  runServerRequest,
  type ServerInstrumentOptions,
  type ServerRequestSpan,
} from './server-instrument';

// Shared fetch-style server instrumentation (design: docs/design/incoming-server-instrumentation.md §5.3).
// A `Request → Response` handler is the native server shape on Bun (`Bun.serve({fetch})`) and Deno
// (`Deno.serve(handler)`) — and a future edge/Workers runtime. `wrapFetchHandler` decorates such a handler
// so it opens a per-request context + an http.server transaction via the shared `runServerRequest` core
// (run-scoped), finishes from the returned Response's status, and — unlike the node:http emit path — CAN
// capture a thrown handler error (it round-trips through this wrap; verified on Bun 1.3 + Deno 2.0+). The
// error is re-thrown so the runtime's own handling (a 500, or the user's error/onError callback) still
// runs. @bugsee/bun and @bugsee/deno reuse this; they only differ in how they reach + replace their global.

/** The minimal structural `Request` the wrap reads (no DOM/undici import). */
export interface FetchRequestLike {
  method: string;
  url: string;
  headers: { get(name: string): string | null };
}
/** The minimal structural `Response` the wrap reads (its status) + the mutable `headers` it may decorate
 * with the BE→FE return headers. A real `Response`'s `headers` is a mutable `Headers` (guard "response")
 * exposing both `set` (replace) and `append` (add to the list). */
export interface FetchResponseLike {
  status: number;
  headers?: { set(name: string, value: string): void; append?(name: string, value: string): void };
}

/** The multi-valued list response headers we APPEND (coexisting with any entry the app already set —
 * binding: interceptors must not alter app behavior) rather than `set` (replace). `traceresponse` is a
 * singleton → set. `Server-Timing` + the F0 CORS-exposure headers (`Timing-Allow-Origin`,
 * `Access-Control-Expose-Headers`) are comma-lists. */
const LIST_RESPONSE_HEADERS = new Set([
  'Server-Timing',
  'Timing-Allow-Origin',
  'Access-Control-Expose-Headers',
]);

/** Decorate the returned Response with the span's configured return headers (Profile v1 §12). Guarded: a
 * Response with no/immutable headers, or a hostile `set`/`append`, must never break the response — the
 * headers are best-effort RUM correlation. Set just before the runtime sends the Response, so streaming is
 * unaffected. List headers are appended (coexist with the app's); singletons are set. */
const applyReturnHeaders = (span: ServerRequestSpan, res: FetchResponseLike | undefined): void => {
  try {
    const target = res?.headers;
    if (target === undefined) {
      return;
    }
    for (const [name, value] of Object.entries(span.responseHeaders())) {
      if (LIST_RESPONSE_HEADERS.has(name) && typeof target.append === 'function') {
        target.append(name, value);
      } else {
        target.set(name, value);
      }
    }
  } catch {
    // best-effort: never break the response over a correlation header
  }
};
/** A native fetch-style server handler: `(request, ...runtimeArgs) => Response`. */
export type FetchHandler<A extends unknown[] = unknown[]> = (
  req: FetchRequestLike,
  ...rest: A
) => FetchResponseLike | Promise<FetchResponseLike>;

/**
 * Wrap a native fetch handler so each request is instrumented. Returns a drop-in replacement that opens
 * the context + http.server transaction, runs the handler inside it, finishes from the Response status,
 * and captures + re-throws a handler error (sync or async) as `ERROR`/500. A no-op passthrough when no
 * client is launched.
 */
export function wrapFetchHandler<A extends unknown[]>(
  handler: FetchHandler<A>,
  options: ServerInstrumentOptions = {},
): FetchHandler<A> {
  return (req, ...rest) =>
    runServerRequest(
      {
        method: req.method,
        url: req.url,
        traceparent: req.headers.get('traceparent') ?? undefined,
      },
      options,
      (span) => {
        let result: FetchResponseLike | Promise<FetchResponseLike>;
        try {
          result = handler(req, ...rest);
        } catch (err) {
          // synchronous throw from the handler
          span.captureError(err);
          span.finish(500, 'ERROR');
          throw err;
        }
        return Promise.resolve(result).then(
          (res) => {
            // Decorate before finishing — the Response is not yet sent, so the return headers ride with it.
            applyReturnHeaders(span, res);
            span.finish(typeof res?.status === 'number' ? res.status : 200);
            return res;
          },
          (err) => {
            // the handler's returned promise rejected
            span.captureError(err);
            span.finish(500, 'ERROR');
            throw err;
          },
        );
      },
    );
}
