// Resolving `waitUntil` — the load-bearing edge mechanism (docs/design/edge-runtime.md §2.1.1). An edge
// isolate freezes the instant the `Response` is returned, so a fire-and-forget upload `fetch` is silently
// dropped. `ctx.waitUntil(promise)` extends the isolate's life until the promise settles. The catch:
//   • Cloudflare passes an ExecutionContext `ctx` as the handler's 3rd arg → use `ctx.waitUntil`.
//   • Vercel Edge has NO `ctx` param — the per-request context lives on the `@vercel/request-context` GLOBAL
//     symbol (Vercel's own `@vercel/functions` `waitUntil` is just sugar over this). Gated on `EdgeRuntime`.
//   • Otherwise (not on edge / no active request) → a no-op; the upload is best-effort.

export type WaitUntil = (promise: Promise<unknown>) => void;

/** The subset of an edge ExecutionContext we use (Cloudflare's `fetch(request, env, ctx)` 3rd argument). */
export interface EdgeExecutionContext {
  waitUntil?: (promise: Promise<unknown>) => void;
}

// Vercel sets `globalThis[Symbol.for('@vercel/request-context')] = { get(): { waitUntil } }` per request.
const VERCEL_REQUEST_CONTEXT = Symbol.for('@vercel/request-context');

type VercelRequestContextHolder = { get?: () => EdgeExecutionContext | undefined } | undefined;

/** Resolve the `waitUntil` for the current request: an explicit `ctx` (Cloudflare), else the Vercel Edge
 *  request-context global symbol, else a no-op. The returned fn keeps the isolate alive until its promise
 *  settles — pass it `client.flush()` so an incident upload completes before the isolate suspends. */
export function resolveWaitUntil(ctx?: EdgeExecutionContext): WaitUntil {
  if (typeof ctx?.waitUntil === 'function') {
    return ctx.waitUntil.bind(ctx);
  }
  // Read the Vercel symbol only on Vercel Edge (gate on EdgeRuntime — the symbol is meaningless elsewhere).
  if (typeof (globalThis as { EdgeRuntime?: unknown }).EdgeRuntime === 'string') {
    const holder = (globalThis as Record<symbol, VercelRequestContextHolder>)[
      VERCEL_REQUEST_CONTEXT
    ];
    const requestContext = holder?.get?.();
    if (typeof requestContext?.waitUntil === 'function') {
      return requestContext.waitUntil.bind(requestContext);
    }
  }
  return () => {};
}
