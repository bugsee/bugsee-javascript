// @bugsee/nextjs — the `onRequestError` bridge (Next.js 15 `instrumentation.ts` hook).
//
// This is THE differentiator: a server-side RSC / route-handler / server-action throw is reported to
// Bugsee AND stitched to the full session that led to it (video/console/network/logs). Correlation is
// automatic — `logException` merges the active per-request context (the node/edge incoming
// instrumentation opens it), so the incident carries the session it belongs to.
//
// RUNTIME-PORTABLE: `onRequestError` is exported ONCE from `instrumentation.ts` and Next invokes it on
// whichever runtime the error occurred (node OR edge), so this module must not statically import any
// node/edge-specific code. It reaches the active client via the portable core carrier and attaches route
// attribution via portable client capture APIs (`event`) — NOT the node-only RequestContextStore.
//
// NOTE: `onRequestError` does NOT catch middleware errors (Next bug #83404) — those get their own path
// (`withBugseeMiddleware`, N5).
import { type BugseeClient, getCarrierClient } from '@bugsee/core';

/** The `request` argument Next passes to `onRequestError` (the subset we read; structural, no `next` dep). */
export interface NextRequestErrorRequest {
  path: string;
  method: string;
  headers: Record<string, string | string[] | undefined>;
}

/** The `context` argument Next passes to `onRequestError` (Next 15; structural, no `next` dep). */
export interface NextRequestErrorContext {
  routerKind: 'Pages Router' | 'App Router';
  routePath: string;
  routeType: 'render' | 'route' | 'action' | 'middleware';
  renderSource?: 'react-server-components' | 'react-server-components-payload' | 'server-rendering';
  revalidateReason?: 'on-demand' | 'stale';
  renderType?: 'dynamic' | 'dynamic-resume';
}

/** The Next.js `instrumentation.ts` `onRequestError` hook signature (Next 15 allows a promise return). */
export type NextOnRequestError = (
  error: unknown,
  request: NextRequestErrorRequest,
  context: NextRequestErrorContext,
) => void | Promise<void>;

export interface OnRequestErrorOptions {
  /** Resolve the Bugsee client to report against. Default: the process-carrier singleton. */
  getClient?: () => BugseeClient | undefined;
}

/**
 * Build the Next.js `onRequestError` handler. Export the result (or the ready-made {@link onRequestError})
 * from `instrumentation.ts` as `export const onRequestError = ...`. Fully defensive — it never throws out
 * of Next's hook and no-ops when Bugsee is not launched.
 */
export function createOnRequestError(options: OnRequestErrorOptions = {}): NextOnRequestError {
  const getClient = options.getClient ?? (() => getCarrierClient<BugseeClient>());
  return (error, request, context) => {
    try {
      const client = getClient();
      if (client === undefined) return;
      // Route attribution as a captured event — portable (rides the incident bundle on any runtime) and
      // correlated to the active session/request via the same context `logException` merges.
      client.event('next.request-error', {
        routerKind: context.routerKind,
        routePath: context.routePath,
        routeType: context.routeType,
        ...(context.renderSource !== undefined ? { renderSource: context.renderSource } : {}),
        method: request.method,
        path: request.path,
      });
      void client.logException(error, { mechanism: 'http-error' });
    } catch {
      // Never replace / disrupt Next's own error handling.
    }
  };
}

/** The ready-made handler bound to the process-carrier client. `export const onRequestError = ...`. */
export const onRequestError: NextOnRequestError = createOnRequestError();
