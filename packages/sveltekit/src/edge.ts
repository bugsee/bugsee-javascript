// @bugsee/sveltekit — edge (Vercel Edge / Cloudflare) composition.
//
// SvelteKit's `handle` hook WRAPS `resolve(event)`, so — unlike Nuxt/Nitro — the edge handle can open a
// REAL per-request context around the whole request via `runInEdgeContext`: capture is correlated, and the
// incident upload is held past the Response by the resolved `waitUntil` (Cloudflare's ExecutionContext on
// `event.platform.context`, else Vercel Edge's global request-context symbol). This is the differentiator —
// Sentry does not support SvelteKit on edge.
//
//   // hooks.server.ts (edge — adapter-vercel `runtime: 'edge'` / adapter-cloudflare)
//   const client = registerServerEdge(appToken);
//   export const handle = createEdgeHandle({ getClient: () => client });
//   export const handleError = handleErrorWithBugsee();  // reports INSIDE the edge context (correlated)
//
// Edge subpath (composes @bugsee/vercel-edge) → never the portable `.`/`./server` entries. The trace `<meta>`
// injection is reused from the node handle (a no-op on edge until per-invocation traces are minted — v2).
import { type AttributeValue, getCarrierClient } from '@bugsee/core';
import {
  type Bugsee,
  type BugseeEdgeLaunchOptions,
  type EdgeExecutionContext,
  launchEdge,
  runInEdgeContext,
} from '@bugsee/vercel-edge';
import type { SvelteKitHandle, SvelteKitResolveOptions } from './handle';
import { injectTraceMeta } from './handle';

export interface SvelteKitEdgeOptions extends BugseeEdgeLaunchOptions {
  /** Test/advanced seam: the edge launch. Default `@bugsee/vercel-edge` `launchEdge`. */
  launch?: (appToken: string, options: BugseeEdgeLaunchOptions) => Bugsee;
}

/** Start Bugsee for the SvelteKit EDGE runtime. Returns the started client (pass it to `createEdgeHandle`). */
export function registerServerEdge(appToken: string, options: SvelteKitEdgeOptions = {}): Bugsee {
  const { launch = launchEdge, ...launchOptions } = options;
  return launch(appToken, launchOptions);
}

export interface CreateEdgeHandleOptions {
  /** Resolve the Bugsee client. Default: the isolate carrier singleton. */
  getClient?: () => Bugsee | undefined;
}

/** SvelteKit's adapter-cloudflare puts the platform `ExecutionContext` (with `waitUntil`) on
 *  `event.platform.context`; Vercel Edge has none (the global symbol is read by `resolveWaitUntil`). */
function edgeCtxFromEvent(event: unknown): EdgeExecutionContext | undefined {
  return (event as { platform?: { context?: EdgeExecutionContext } } | null | undefined)?.platform
    ?.context;
}

/** Per-request attributes stamped on the edge context (merged into any incident report). */
function edgeAttributes(event: unknown): Record<string, AttributeValue> {
  const e = event as
    | { request?: { method?: string }; url?: { pathname?: string }; route?: { id?: string | null } }
    | null
    | undefined;
  const attrs: Record<string, AttributeValue> = {};
  if (e?.request?.method !== undefined) attrs['http.method'] = e.request.method;
  if (e?.url?.pathname !== undefined) attrs['http.target'] = e.url.pathname;
  if (typeof e?.route?.id === 'string' && e.route.id !== '') attrs['http.route'] = e.route.id;
  return attrs;
}

/**
 * Build a SvelteKit EDGE `handle` hook: run `resolve(event)` inside a per-request Bugsee edge context
 * (correlated capture + incident flush via `waitUntil`) and inject the trace `<meta>`. When no client is
 * launched it degrades to a plain `resolve` (no context).
 */
export function createEdgeHandle(options: CreateEdgeHandleOptions = {}): SvelteKitHandle {
  const getClient = options.getClient ?? (() => getCarrierClient<Bugsee>());
  // `getClient` is APPLICATION-supplied and needs no SDK bug to throw (a TDZ'd module binding, a lazy
  // import, a throwing getter). This handle wraps EVERY SSR request, so an unguarded throw here would turn
  // the whole site into a 500 — the SDK breaking the app it exists to observe. A failed resolve degrades to
  // "not launched", exactly like a `getClient` that returns undefined. (Same shape as the @bugsee/react
  // `report.ts` and hono `options.user` findings.)
  const resolveClient = (): Bugsee | undefined => {
    try {
      return getClient();
    } catch {
      return undefined;
    }
  };
  return ({ event, resolve }) => {
    const resolveOptions: SvelteKitResolveOptions = {
      transformPageChunk: ({ html }) => injectTraceMeta(html, { getClient: resolveClient }),
    };
    const client = resolveClient();
    if (client === undefined) return resolve(event, resolveOptions);
    return runInEdgeContext(
      client,
      { ctx: edgeCtxFromEvent(event), attributes: edgeAttributes(event) },
      () => resolve(event, resolveOptions),
    );
  };
}
