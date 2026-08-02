// @bugsee/astro — edge (Vercel Edge / Cloudflare) composition.
//
// Astro's middleware WRAPS `next()`, so — like SvelteKit — the edge middleware opens a REAL per-request
// context around the request via `runInEdgeContext`: correlated capture + the incident upload held past the
// Response by the resolved `waitUntil` (Cloudflare's ExecutionContext on `context.locals.runtime.ctx`, else
// Vercel Edge's global request-context symbol). It reuses the node middleware's trace injection on success.
// On a thrown route error, `runInEdgeContext` captures + rethrows (so Astro renders its error page) — so the
// edge middleware does NOT also run the node middleware's try/catch (avoids a double report).
//
// Edge subpath (composes @bugsee/vercel-edge) → never the portable `.`/`./middleware`/`./server` entries.
import { type AttributeValue, getCarrierClient } from '@bugsee/core';
import { sanitizeUrl } from '@bugsee/protocol';
import {
  type Bugsee,
  type BugseeEdgeLaunchOptions,
  type EdgeExecutionContext,
  launchEdge,
  runInEdgeContext,
} from '@bugsee/vercel-edge';
import type { AstroMiddleware, AstroMiddlewareContext } from './middleware';
import { injectTraceIntoResponse } from './middleware';

export interface AstroEdgeOptions extends BugseeEdgeLaunchOptions {
  /** Test/advanced seam: the edge launch. Default `@bugsee/vercel-edge` `launchEdge`. */
  launch?: (appToken: string, options: BugseeEdgeLaunchOptions) => Bugsee;
}

/** Start Bugsee for the Astro EDGE runtime. Returns the started client (pass it to `createEdgeMiddleware`). */
export function registerServerEdge(appToken: string, options: AstroEdgeOptions = {}): Bugsee {
  const { launch = launchEdge, ...launchOptions } = options;
  return launch(appToken, launchOptions);
}

export interface CreateEdgeMiddlewareOptions {
  /** Resolve the Bugsee client. Default: the isolate carrier singleton. */
  getClient?: () => Bugsee | undefined;
}

/** The edge context we read — Astro's `@astrojs/cloudflare` exposes the platform `ExecutionContext` (with
 *  `waitUntil`) at `context.locals.runtime.ctx`; Vercel Edge has none (the global symbol is read instead). */
interface EdgeAstroContext extends AstroMiddlewareContext {
  locals?: { runtime?: { ctx?: EdgeExecutionContext } };
}

function edgeCtxFromContext(context: EdgeAstroContext): EdgeExecutionContext | undefined {
  return context?.locals?.runtime?.ctx;
}

/** Per-request attributes stamped on the edge context. */
function edgeAttributes(context: AstroMiddlewareContext): Record<string, AttributeValue> {
  const attrs: Record<string, AttributeValue> = {};
  const method = context?.request?.method;
  const url = context?.request?.url;
  if (method !== undefined) attrs['http.method'] = method;
  // Astro exposes the FULL request URL (query included), unlike vercel-edge's pathname reduction — so it
  // needs the same scrub the network path got (Wave 1.1).
  if (url !== undefined) attrs['http.url'] = sanitizeUrl(url);
  return attrs;
}

/**
 * Build an Astro EDGE `onRequest` middleware: run `next()` inside a per-request Bugsee edge context
 * (correlated capture + incident flush via `waitUntil`) and inject the trace `<meta>` on success. Degrades
 * to a plain `next()` when no client is launched.
 */
export function createEdgeMiddleware(options: CreateEdgeMiddlewareOptions = {}): AstroMiddleware {
  const resolveClient = options.getClient ?? (() => getCarrierClient<Bugsee>());
  return (context, next) => {
    const client = resolveClient();
    if (client === undefined) return next();
    return runInEdgeContext(
      client,
      { ctx: edgeCtxFromContext(context), attributes: edgeAttributes(context) },
      async () => injectTraceIntoResponse(await next(), { getClient: () => client }),
    );
  };
}

/** The ready-made edge middleware bound to the carrier client — the `addMiddleware` entrypoint the Integration
 *  wires for edge (`{ entrypoint: '@bugsee/astro/edge', order: 'pre' }`). */
export const onRequest: AstroMiddleware = createEdgeMiddleware();
