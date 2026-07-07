// @bugsee/sveltekit — the `handleError` bridge (SvelteKit's server error hook, `HandleServerError`).
//
// THE differentiator: a server-side load/action/render throw is reported to Bugsee AND stitched to the
// session that led to it. Wire it in `src/hooks.server.ts`:
//   export const handleError = handleErrorWithBugsee(myHandler?);   // reports + keeps your own handler
// SvelteKit only calls `handleError` for UNEXPECTED errors (thrown `error()` control-flow is handled before
// this hook); we additionally skip a <500 `status` (a 404 not-found) as expected.
//
// RUNTIME-PORTABLE: `hooks.server.ts` runs on node OR edge, so this uses only the portable
// `@bugsee/adapter-kit` bridge — never node/edge-specific code. Fully defensive — never throws out of the
// hook. (Server INIT — `@bugsee/node`/edge launch — lives behind the `@bugsee/sveltekit/server`|`/edge`
// entries.)
import { reportServerError } from '@bugsee/adapter-kit';
import type { BugseeClient } from '@bugsee/core';

/** The subset of SvelteKit's `HandleServerError` input we read (structural; no `@sveltejs/kit` import). */
export interface SvelteKitServerErrorInput {
  error: unknown;
  event?: {
    route?: { id?: string | null };
    request?: { method?: string };
    /** SvelteKit's `event.url` — `pathname` is already query-stripped (no secret-in-`?token=` leak). */
    url?: { pathname?: string };
  };
  status?: number;
  message?: string;
}

/** A SvelteKit `handleError` hook (returns the `App.Error` to render, or void). */
export type SvelteKitHandleServerError = (input: SvelteKitServerErrorInput) => unknown;

export interface CreateHandleServerErrorOptions {
  /** Resolve the Bugsee client. Default: the process/isolate carrier singleton. */
  getClient?: () => BugseeClient | undefined;
}

/** Report a SvelteKit server error (skipping expected <500), with route/method/path attribution. Fully
 *  defensive — never throws. */
function reportSvelteKitServerError(
  input: SvelteKitServerErrorInput,
  options: CreateHandleServerErrorOptions,
): void {
  try {
    // handleError fires for unexpected errors; a <500 status (e.g. 404 not-found) is expected, not a crash.
    if (typeof input?.status === 'number' && input.status < 500) return;
    const routeId = input?.event?.route?.id;
    const method = input?.event?.request?.method;
    const path = input?.event?.url?.pathname;
    reportServerError(input.error, {
      ...(options.getClient !== undefined ? { getClient: options.getClient } : {}),
      event: {
        name: 'sveltekit.server-error',
        params: {
          ...(method !== undefined ? { method } : {}),
          ...(path !== undefined ? { path } : {}),
          ...(typeof routeId === 'string' && routeId !== '' ? { routeId } : {}),
        },
      },
      mechanism: 'http-error',
    });
  } catch {
    // Never disrupt SvelteKit's own error handling.
  }
}

/** Build a SvelteKit `handleError` handler that reports the error (with attribution) and returns `undefined`
 *  (SvelteKit then renders the default error). No-ops when Bugsee is not launched. */
export function createHandleServerError(
  options: CreateHandleServerErrorOptions = {},
): SvelteKitHandleServerError {
  return (input) => {
    reportSvelteKitServerError(input, options);
    return undefined;
  };
}

/** Build a SvelteKit `handleError` handler that reports the error, then DELEGATES to the app's own handler,
 *  forwarding its return (the `App.Error` shape SvelteKit renders). Wire it in `src/hooks.server.ts`:
 *  `export const handleError = handleErrorWithBugsee(myHandler?)`. */
export function handleErrorWithBugsee(
  appHandler?: SvelteKitHandleServerError,
  options: CreateHandleServerErrorOptions = {},
): SvelteKitHandleServerError {
  return (input) => {
    reportSvelteKitServerError(input, options);
    return appHandler?.(input); // the app keeps its own handleError (and its App.Error return)
  };
}

/** The ready-made handler bound to the carrier client. `export const handleError = ...` in hooks.server. */
export const handleError: SvelteKitHandleServerError = createHandleServerError();
