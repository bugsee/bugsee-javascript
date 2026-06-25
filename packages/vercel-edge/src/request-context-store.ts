import type { AttributeValue, ContextProvider, RequestContext } from '@bugsee/core';

// The EDGE request-context binding — the portable, run()-ONLY counterpart to node's AsyncLocalStorage store
// (docs/design/edge-runtime.md E2). It realizes the core ContextProvider seam so each request's context
// follows its async chain and stays isolated across concurrent requests in one isolate. Two reasons it can't
// reuse the node store: (1) node statically `import`s `node:async_hooks` (breaks an edge bundle); (2) the
// WinterCG/Workers AsyncLocalStorage subset has **no `enterWith()`** (nor `disable()`), so this store is
// `run()`-scoped only. It probes `globalThis.AsyncLocalStorage` (built-in on Vercel Edge; on Cloudflare it
// needs the `nodejs_compat`/`nodejs_als` flag) and DEGRADES to a single-slot store + a one-time warning when
// it's absent — NEVER throwing at import (a missing ACS must not crash the SDK).

/** The run()-scoped async store subset we use (WinterCG/Workers AsyncLocalStorage — NO enterWith/disable). */
export interface RunScopedStore<T> {
  getStore(): T | undefined;
  run<R>(store: T, fn: () => R): R;
}

/** Minimal diagnostic-logger surface (the launch passes its `debug` logger). */
export interface EdgeContextStoreLogger {
  warnOnce(message: string): void;
}

/** The edge context store: the core ContextProvider + a `run()` opener + the per-context mutators (no
 *  `enterWith` — unavailable on the edge ALS subset; the fetch-handler wrapper opens contexts via `run`). */
export interface EdgeRequestContextStore extends ContextProvider {
  /** Run `fn` with `context` active for its (a)synchronous call-chain. */
  run<T>(context: RequestContext, fn: () => T): T;
  /** Set the end-user identity on the active context (no-op when none is open). */
  setUser(user: string): void;
  /** Set a custom attribute on the active context (no-op when none is open). */
  setAttribute(key: string, value: AttributeValue): void;
  /** Set the active W3C trace on the active context (no-op when none is open). */
  setTrace(trace: { traceId: string; spanId: string; sampled: boolean }): void;
}

const ALS_UNAVAILABLE_WARNING =
  'AsyncLocalStorage unavailable; per-request context isolation across awaits will not work. ' +
  'On Cloudflare add the "nodejs_compat" (or "nodejs_als") compatibility flag to wrangler.toml.';

/** A single-slot fallback: a plain variable with save/restore around `run`. No cross-await isolation (a
 *  concurrent request can transiently observe another's context between awaits) — hence the one-time warning. */
function createSingleSlotStore<T>(): RunScopedStore<T> {
  let slot: T | undefined;
  return {
    getStore: () => slot,
    run(store, fn) {
      const prev = slot;
      slot = store;
      try {
        return fn();
      } finally {
        slot = prev;
      }
    },
  };
}

/** Probe `globalThis.AsyncLocalStorage`; construct one if present (run()-only is all we use), else degrade to
 *  the single-slot fallback + warn once. Never throws (a throwing constructor degrades too). */
function probeRunScopedStore<T>(logger?: EdgeContextStoreLogger): RunScopedStore<T> {
  const ALS = (globalThis as { AsyncLocalStorage?: new () => RunScopedStore<T> }).AsyncLocalStorage;
  if (ALS !== undefined) {
    try {
      return new ALS();
    } catch {
      // a present-but-unusable constructor (e.g. compat flag missing) — degrade below
    }
  }
  logger?.warnOnce(ALS_UNAVAILABLE_WARNING);
  return createSingleSlotStore<T>();
}

export interface EdgeRequestContextStoreOptions {
  /** Diagnostic logger for the one-time "ALS unavailable" warning. */
  logger?: EdgeContextStoreLogger;
  /** The run()-scoped backing store. Default: probe `globalThis.AsyncLocalStorage` / single-slot fallback. */
  storage?: RunScopedStore<RequestContext>;
}

export function createEdgeRequestContextStore(
  options: EdgeRequestContextStoreOptions = {},
): EdgeRequestContextStore {
  const storage = options.storage ?? probeRunScopedStore<RequestContext>(options.logger);
  return {
    getCurrent: () => storage.getStore(),
    run: (context, fn) => storage.run(context, fn),
    setUser(user) {
      const current = storage.getStore();
      if (current !== undefined) {
        current.user = user;
      }
    },
    setAttribute(key, value) {
      const current = storage.getStore();
      if (current === undefined) {
        return;
      }
      if (current.attributes === undefined) {
        current.attributes = {};
      }
      current.attributes[key] = value;
    },
    setTrace(trace) {
      const current = storage.getStore();
      if (current !== undefined) {
        current.trace = trace;
      }
    },
  };
}
