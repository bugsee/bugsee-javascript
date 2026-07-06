// @bugsee/remix — the `handleError` bridge (Remix v2 + React Router v7 server error hook).
//
// THE differentiator: a server-side loader / action / render throw is reported to Bugsee AND stitched to
// the session that led to it. Export the result (or the ready-made `handleError`) from `entry.server.tsx`:
// `export const handleError = handleError` (v2 / RR7 both call it as `HandleErrorFunction`). React Router
// filters expected control-flow throws (thrown `Response`/redirect) before this hook, so we only skip
// CANCELLED requests (aborted signal — RR's race/cancellation noise).
//
// RUNTIME-PORTABLE: `entry.server` runs on node OR edge, so this module uses only the portable
// `@bugsee/adapter-kit` bridge — never node/edge-specific code. Fully defensive — never throws out of the
// hook. (Server INIT — `@bugsee/node` launch — lives behind the node-only `@bugsee/remix/server` entry.)
import { reportServerError } from '@bugsee/adapter-kit';
import type { BugseeClient } from '@bugsee/core';

/** The subset of the Remix/RR7 `handleError` args we read (structural; no `react-router` dep). */
export interface RemixHandleErrorArgs {
  /** The in-flight Web `Request` (its `signal.aborted` marks a cancelled request). */
  request: Request;
  /** The matched route params, if any. */
  params?: Record<string, string | undefined>;
  context?: unknown;
}

/** The Remix / React Router v7 `handleError` hook signature (`HandleErrorFunction`). */
export type RemixHandleError = (error: unknown, args: RemixHandleErrorArgs) => void;

export interface CreateHandleErrorOptions {
  /** Resolve the Bugsee client. Default: the process/isolate carrier singleton. */
  getClient?: () => BugseeClient | undefined;
}

/** The request path (no query string — report attributes don't pass the redaction pipeline, so a secret in
 *  `?token=…` must not leak), best-effort. */
function safePath(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    return new URL(url).pathname;
  } catch {
    return undefined;
  }
}

/**
 * Build the Remix / React Router v7 `handleError` handler. Fully defensive — never throws out of the hook
 * and no-ops when Bugsee is not launched.
 */
export function createHandleError(options: CreateHandleErrorOptions = {}): RemixHandleError {
  return (error, args) => {
    try {
      // Cancelled request → RR aborts loaders/actions and surfaces the AbortError here; that's noise.
      if (args?.request?.signal?.aborted === true) return;
      const path = safePath(args?.request?.url);
      const params = args?.params;
      reportServerError(error, {
        ...(options.getClient !== undefined ? { getClient: options.getClient } : {}),
        event: {
          name: 'remix.request-error',
          params: {
            method: args?.request?.method,
            ...(path !== undefined ? { path } : {}),
            ...(params !== undefined && Object.keys(params).length > 0 ? { params } : {}),
          },
        },
        mechanism: 'http-error',
      });
    } catch {
      // Never disrupt Remix's own error handling.
    }
  };
}

/** The ready-made handler bound to the carrier client. `export const handleError = ...` in entry.server. */
export const handleError: RemixHandleError = createHandleError();
