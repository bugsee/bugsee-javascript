// REQUIRES the `nodejs_compat` compatibility flag. `globalThis.AsyncLocalStorage` does NOT exist on workerd
// under any flag — ALS is reachable ONLY through `node:async_hooks` (verified on real workerd 1.20260722.1
// across the flag x compatibility-date matrix; docs/review/cloudflare.md SEV1 #3). Importing it here is what
// makes per-request context work with ZERO user code; the
// same choice @sentry/cloudflare makes, for the same reason. A project without the flag now fails at BUILD
// with a resolver error instead of building fine and silently losing context isolation.
import { AsyncLocalStorage } from 'node:async_hooks';
import { type Bugsee, type BugseeEdgeLaunchOptions, launchEdge } from '@bugsee/vercel-edge';

// @bugsee/cloudflare launch() — the Cloudflare Workers (workerd) composition root (docs/design/edge-runtime.md
// C1). Cloudflare runs the SAME V8-isolate, Web-APIs-only edge surface as Vercel Edge, so this reuses the ENTIRE
// @bugsee/vercel-edge composition (fetch transport, in-memory capture store, run()-only ALS, console/network
// capture, unhandledrejection safety net, incident-driven upload via waitUntil) and swaps ONE default: the
// platform identity → 'workers'. The two Cloudflare specifics are already handled GENERICALLY by the shared
// code, so there is nothing platform-specific to build here:
//   - ctx.waitUntil: withBugseeFetch reads it from the handler's 3rd arg — Cloudflare passes `(req, env, ctx)`
//     (resolveWaitUntil tries the explicit ctx first, then the Vercel global symbol).
//   - AsyncLocalStorage: the context store probes `globalThis.AsyncLocalStorage`, available on Workers ONLY with
//     the `nodejs_compat` (or `nodejs_als`) compatibility flag; without it the store degrades to a single-slot
//     fallback + a one-time warning (never throws). See the README.
// platformType stays overridable — a caller-supplied option wins (it spreads AFTER the 'workers' default).

/** Isolates (carriers) that have already been told their tenant isolation is off. */
const warnedIsolates = new WeakSet<object>();

/**
 * `partitionCaptureByTenant: false` is allowed, but on Cloudflare it silently reinstates the cross-tenant leak the
 * default exists to prevent (one isolate, many customers' Durable Objects, one capture ring), so say so, once per
 * isolate. The host's sink may throw: the warning must never break launch.
 */
function warnOnceIfIsolationDisabled(options: BugseeEdgeLaunchOptions): void {
  if (options.partitionCaptureByTenant !== false) {
    return;
  }
  const isolate: object = options.carrier ?? globalThis;
  if (warnedIsolates.has(isolate)) {
    return;
  }
  warnedIsolates.add(isolate);
  try {
    options.onError?.(
      new Error(
        "Bugsee: partitionCaptureByTenant: false turns OFF per-tenant isolation on Cloudflare, so one Durable Object incident can upload another tenant's capture. Remove the option to keep isolation on.",
      ),
    );
  } catch {
    /* the host's own sink threw: nothing left to tell */
  }
}

/** Launch the Bugsee SDK on Cloudflare Workers. A per-isolate singleton; returns the started client.
 *  AsyncLocalStorage is wired automatically (see the import note) — a caller-supplied `asyncLocalStorage`
 *  still wins, since the caller's options spread AFTER the defaults. */
export function launch(appToken: string, options: BugseeEdgeLaunchOptions = {}): Bugsee {
  warnOnceIfIsolationDisabled(options);
  return launchEdge(appToken, {
    platformType: 'workers',
    asyncLocalStorage: new AsyncLocalStorage(),
    ...options,
    // Durable Objects for different customers share one isolate and therefore one capture ring; partition
    // by tenant so an incident in one cannot upload another's data. The default applies ONLY for an
    // absent/`undefined` value and is placed AFTER the spread: an explicit `{partitionCaptureByTenant: undefined}`
    // would otherwise override it. Any other value is judged by launchEdge (fail ON + onError).
    partitionCaptureByTenant:
      options.partitionCaptureByTenant === undefined ? true : options.partitionCaptureByTenant,
  });
}
