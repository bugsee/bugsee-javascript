import {
  type FetchHandler,
  type ServerInstallable,
  type ServerInstrumentOptions,
  wrapFetchHandler,
} from '@bugsee/node';

// Native Bun.serve instrumentation (design: docs/design/incoming-server-instrumentation.md §5.3). Replaces
// `Bun.serve` to wrap its `fetch` handler via the shared `wrapFetchHandler` — so idiomatic
// `Bun.serve({fetch})` apps (which bypass node:http, and so the emit-patch interceptor) get a per-request
// context + http.server transaction. Self-skips when `Bun` is absent (e.g. unit tests on Node). KNOWN GAPS
// (D9): `Bun.serve({routes})` per-route handlers + websocket are NOT wrapped, and `server.reload()` rebinds
// the handler without re-instrumenting it — both documented follow-ups.

interface BunServeOptions {
  fetch?: FetchHandler;
  [key: string]: unknown;
}
interface BunLike {
  serve: (options: BunServeOptions) => unknown;
}
interface BunHost {
  Bun?: BunLike;
}

export interface BunServeInterceptorOptions extends ServerInstrumentOptions {
  /** The host object exposing `Bun` (default `globalThis`). Injectable for tests. */
  target?: BunHost;
}

export function createBunServeInterceptor(
  options: BunServeInterceptorOptions = {},
): ServerInstallable {
  const host = options.target ?? (globalThis as BunHost);
  const instrumentOptions: ServerInstrumentOptions = {
    ...(options.getClient !== undefined ? { getClient: options.getClient } : {}),
    ...(options.newContextId !== undefined ? { newContextId: options.newContextId } : {}),
    ...(options.shouldReport !== undefined ? { shouldReport: options.shouldReport } : {}),
    ...(options.traceResponse !== undefined ? { traceResponse: options.traceResponse } : {}),
  };
  let installed = false;
  let bun: BunLike | undefined;
  let original: BunLike['serve'] | undefined;

  return {
    install() {
      if (installed) {
        return;
      }
      const target = host.Bun;
      if (target === undefined || typeof target.serve !== 'function') {
        return; // Bun absent — self-skip
      }
      installed = true;
      bun = target;
      original = target.serve;
      const orig = original;
      target.serve = function patchedServe(serveOptions) {
        if (
          serveOptions !== null &&
          typeof serveOptions === 'object' &&
          typeof serveOptions.fetch === 'function'
        ) {
          return orig.call(this, {
            ...serveOptions,
            fetch: wrapFetchHandler(serveOptions.fetch, instrumentOptions),
          });
        }
        return orig.call(this, serveOptions);
      };
    },
    uninstall() {
      if (!installed || bun === undefined || original === undefined) {
        return;
      }
      installed = false;
      bun.serve = original;
      bun = undefined;
      original = undefined;
    },
  };
}
