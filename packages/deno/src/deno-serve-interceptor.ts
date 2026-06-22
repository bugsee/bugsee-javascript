import {
  type FetchHandler,
  type ServerInstallable,
  type ServerInstrumentOptions,
  wrapFetchHandler,
} from '@bugsee/node';

// Native Deno.serve instrumentation (design: docs/design/incoming-server-instrumentation.md §5.3). Replaces
// `Deno.serve` to wrap its handler — across all overloads: `Deno.serve(handler)`,
// `Deno.serve(options, handler)`, and `Deno.serve({ handler, ... })` — via the shared `wrapFetchHandler`,
// so idiomatic Deno.serve apps (which bypass node:http) get a per-request context + http.server
// transaction. Self-skips when `Deno` is absent (e.g. unit tests on Node). A throw escaping the handler is
// captured + re-thrown (Deno turns it into a 500), verified by the §8.0 spike on Deno 2.8.

type DenoHandler = FetchHandler<[info?: unknown]>;
interface DenoServeOptions {
  handler?: DenoHandler;
  [key: string]: unknown;
}
type DenoServe = (...args: unknown[]) => unknown;
interface DenoLike {
  serve: DenoServe;
}
interface DenoHost {
  Deno?: DenoLike;
}

export interface DenoServeInterceptorOptions extends ServerInstrumentOptions {
  /** The host object exposing `Deno` (default `globalThis`). Injectable for tests. */
  target?: DenoHost;
}

export function createDenoServeInterceptor(
  options: DenoServeInterceptorOptions = {},
): ServerInstallable {
  const host = options.target ?? (globalThis as DenoHost);
  const instrumentOptions: ServerInstrumentOptions = {
    ...(options.getClient !== undefined ? { getClient: options.getClient } : {}),
    ...(options.newContextId !== undefined ? { newContextId: options.newContextId } : {}),
    ...(options.shouldReport !== undefined ? { shouldReport: options.shouldReport } : {}),
    ...(options.traceResponse !== undefined ? { traceResponse: options.traceResponse } : {}),
  };
  const wrap = (handler: DenoHandler): DenoHandler => wrapFetchHandler(handler, instrumentOptions);
  let installed = false;
  let deno: DenoLike | undefined;
  let original: DenoServe | undefined;

  return {
    install() {
      if (installed) {
        return;
      }
      const target = host.Deno;
      if (target === undefined || typeof target.serve !== 'function') {
        return; // Deno absent — self-skip
      }
      installed = true;
      deno = target;
      original = target.serve;
      const orig = original;
      target.serve = function patchedServe(...args: unknown[]) {
        if (typeof args[0] === 'function') {
          return orig.call(this, wrap(args[0] as DenoHandler)); // Deno.serve(handler)
        }
        const serveOptions = (args[0] ?? {}) as DenoServeOptions;
        if (typeof args[1] === 'function') {
          return orig.call(this, serveOptions, wrap(args[1] as DenoHandler)); // Deno.serve(options, handler)
        }
        if (typeof serveOptions.handler === 'function') {
          return orig.call(this, { ...serveOptions, handler: wrap(serveOptions.handler) }); // {handler}
        }
        return orig.apply(this, args);
      };
    },
    uninstall() {
      if (!installed || deno === undefined || original === undefined) {
        return;
      }
      installed = false;
      deno.serve = original;
      deno = undefined;
      original = undefined;
    },
  };
}
