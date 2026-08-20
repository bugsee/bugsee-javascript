import {
  type AdapterMechanism,
  neverThrow,
  type ReportErrorOptions,
  reportError,
} from '@bugsee/web-adapter';

// The @bugsee/svelte ERROR SEAM (frontend-adapters §7 fan-out — the F6-thin pattern for SvelteKit). Wraps
// SvelteKit's `handleError` hook (the user exports it from `src/hooks.client.ts`): report the thrown error
// to the launched Bugsee client, labeled with the navigation route id, then DELEGATE to the app's own
// handleError and forward its return (the `App.Error` shape SvelteKit renders). A STRUCTURAL PEER over the
// SvelteKit hook input shape (no `@sveltejs/kit` import) → version-agnostic + unit-testable. v1 = error +
// routing, client-side; the server `hooks.server.ts` path is a follow-up.

/** Capture mechanism for a SvelteKit error report (the `logException` mechanism vocabulary). */
export type SvelteErrorMechanism = AdapterMechanism;

/** Options for the SvelteKit error seam (client resolver + mechanism). */
export type SvelteErrorOptions = Omit<ReportErrorOptions, 'labels'>;

export interface ReportSvelteErrorOptions extends SvelteErrorOptions {
  /** The SvelteKit route id (`/users/[id]`) — attached as a searchable label. */
  routeId?: string;
}

/** The minimal `handleError` hook input we read — structurally matches SvelteKit's `HandleClientError`. */
export interface HandleErrorInput {
  error: unknown;
  event?: { route?: { id?: string | null } };
}
/** A SvelteKit `handleError` hook (returns the `App.Error` to render, or void). */
export type HandleErrorHook = (input: HandleErrorInput) => unknown;

/** Report a SvelteKit error to the launched Bugsee client, labeled with the route id. A no-op when no SDK
 *  is launched. */
export function reportSvelteError(error: unknown, options: ReportSvelteErrorOptions = {}): void {
  const labels = options.routeId !== undefined ? [`svelte.route:${options.routeId}`] : undefined;
  reportError(error, { ...options, ...(labels !== undefined ? { labels } : {}) });
}

/** Build a SvelteKit `handleError` hook that reports the error (with the route id) and then DELEGATES to the
 *  app's own handler, forwarding its return. Wire it in `src/hooks.client.ts`:
 *  `export const handleError = handleErrorWithBugsee(myHandler?)`. */
export function handleErrorWithBugsee(
  appHandler?: HandleErrorHook,
  options: SvelteErrorOptions = {},
): HandleErrorHook {
  return (input) => {
    // Contained (Wave 2.1): route extraction reads a framework-supplied object and the report follows, and
    // a throw from either used to skip the app's own handleError — which is what SvelteKit renders from.
    //
    // Route extraction gets its OWN guard, separate from the report. The route id is decoration (a
    // searchable label); the report is the artifact this hook exists to produce. Sharing one guard meant
    // that an `event` whose `route` could not be read — a throwing getter, a proxied/exotic object, the
    // very shape `host-boundary.test.ts` already exercises — silently dropped the customer's error
    // ENTIRELY rather than merely losing its label. `router.ts` has always read its navigation this way;
    // the error seam did not.
    const routeId = neverThrow(() => input.event?.route?.id, options.onError);
    neverThrow(() => {
      reportSvelteError(input.error, {
        ...options,
        ...(typeof routeId === 'string' && routeId !== '' ? { routeId } : {}),
      });
    }, options.onError);
    return appHandler?.(input); // the app keeps its own handleError (and its App.Error return)
  };
}
