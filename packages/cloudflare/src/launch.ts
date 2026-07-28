// REQUIRES the `nodejs_compat` compatibility flag. `globalThis.AsyncLocalStorage` does NOT exist on workerd
// under any flag — ALS is reachable ONLY through `node:async_hooks` (verified on real workerd 1.20260722.1
// across the flag x compatibility-date matrix; docs/review/cloudflare.md SEV1 #3). Importing it here is what
// makes per-request context work with ZERO user code (docs/design/cloudflare-tenant-isolation.md §7); the
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

/** Launch the Bugsee SDK on Cloudflare Workers. A per-isolate singleton; returns the started client.
 *  AsyncLocalStorage is wired automatically (see the import note) — a caller-supplied `asyncLocalStorage`
 *  still wins, since the caller's options spread AFTER the defaults. */
export function launch(appToken: string, options: BugseeEdgeLaunchOptions = {}): Bugsee {
  return launchEdge(appToken, {
    platformType: 'workers',
    asyncLocalStorage: new AsyncLocalStorage(),
    // Durable Objects for different customers share one isolate and therefore one capture ring; partition
    // by tenant so an incident in one cannot upload another's data (SEV1 #2).
    partitionCaptureByTenant: true,
    ...options,
  });
}
