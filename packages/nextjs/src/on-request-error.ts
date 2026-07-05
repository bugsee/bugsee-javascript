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
//
// The report itself (event + logException + defensiveness) is the shared `@bugsee/adapter-kit`
// `reportServerError` (P4) — Next only maps its error context to the capture event.
import { reportServerError } from '@bugsee/adapter-kit';
import type { BugseeClient } from '@bugsee/core';

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
  return (error, request, context) => {
    // Route attribution rides a captured event (portable, correlated to the active session via the
    // context `logException` merges); the kit does the defensive report + carrier default.
    reportServerError(error, {
      ...(options.getClient !== undefined ? { getClient: options.getClient } : {}),
      event: {
        name: 'next.request-error',
        params: {
          routerKind: context.routerKind,
          routePath: context.routePath,
          routeType: context.routeType,
          ...(context.renderSource !== undefined ? { renderSource: context.renderSource } : {}),
          method: request.method,
          path: request.path,
        },
      },
      mechanism: 'http-error',
    });
  };
}

/** The ready-made handler bound to the process-carrier client. `export const onRequestError = ...`. */
export const onRequestError: NextOnRequestError = createOnRequestError();
