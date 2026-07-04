// @bugsee/nextjs — client (browser runtime) composition.
//
// Reached from `instrumentation-client.ts` (Next 15.3), which Next bundles into the CLIENT graph. This
// module is browser-only (it composes the batteries-included browser umbrella: DOM/console/network
// capture + web-vitals) and so lives behind the `./client` subpath — never the portable `.` entry or the
// node `./server` entry (design §3, hard-constraint 1).
//
// It captures the SESSION (video/console/network/vitals) that the server-side onRequestError bridge (N3)
// stitches to a failing request — together they deliver the cross-runtime "full session that led to this
// failure" artifact.
import { getCarrierClient } from '@bugsee/core';
import { type Bugsee, type BugseeLaunchOptionsWithPerformance, launch } from 'bugsee';

// Re-export the @bugsee/react surface so a Next app gets the React error boundary + Profiler + router
// helpers from one place (`@bugsee/nextjs/client`) — these are CLIENT components the user mounts in their
// tree (registerClient does not auto-wire them). `react` is an OPTIONAL peer (server-only users don't
// need it).
export * from '@bugsee/react';
export type { Bugsee } from 'bugsee';

/** Options for the Next.js client composition — the batteries-included browser umbrella options. */
export interface NextjsClientOptions extends BugseeLaunchOptionsWithPerformance {}

/**
 * Start Bugsee for the Next.js **client** (browser) runtime. Call at the top level of
 * `instrumentation-client.ts` so it initializes as early as possible on every page. Returns the started
 * client (a per-tab singleton).
 *
 * ```ts
 * // instrumentation-client.ts
 * import { registerClient } from '@bugsee/nextjs/client';
 * registerClient(process.env.NEXT_PUBLIC_BUGSEE_TOKEN!);
 * export { onRouterTransitionStart } from '@bugsee/nextjs/client';
 * ```
 */
export function registerClient(appToken: string, options: NextjsClientOptions = {}): Bugsee {
  return launch(appToken, options);
}

/** The Next.js 15.3 `onRouterTransitionStart` client hook signature. */
export type NextRouterTransitionStart = (
  href: string,
  navigationType: 'push' | 'replace' | 'traverse',
) => void;

export interface OnRouterTransitionStartOptions {
  /** Resolve the Bugsee client. Default: the per-tab carrier singleton. */
  getClient?: () => Bugsee | undefined;
}

/**
 * Build the Next.js `onRouterTransitionStart` handler — a breadcrumb per App-Router SOFT navigation
 * (client-side route change), so the recording shows the in-app navigation trail that led to a failure.
 * Fully defensive: never throws out of Next's router, no-ops when Bugsee is not launched.
 */
export function createOnRouterTransitionStart(
  options: OnRouterTransitionStartOptions = {},
): NextRouterTransitionStart {
  const getClient = options.getClient ?? (() => getCarrierClient<Bugsee>());
  return (href, navigationType) => {
    try {
      const client = getClient();
      if (client === undefined) return;
      client.addBreadcrumb({
        type: 'navigation',
        category: 'navigation',
        message: href,
        data: { href, navigationType },
      });
    } catch {
      // Never disrupt Next's client router.
    }
  };
}

/** The ready-made hook bound to the per-tab carrier client. `export const onRouterTransitionStart = ...`. */
export const onRouterTransitionStart: NextRouterTransitionStart = createOnRouterTransitionStart();
