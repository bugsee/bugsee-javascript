// @bugsee/sveltekit — client (browser) composition.
//
// Browser-only (imports the batteries-included browser umbrella + @bugsee/svelte) → behind the
// `@bugsee/sveltekit/client` subpath, never the portable `.` entry. Two things go in your app:
//   1. `src/hooks.client.ts`: `export const handleError = handleErrorWithBugsee(myHandler?)` — reports a
//      client-side load/render throw (labeled with the route id) via @bugsee/svelte's client error seam;
//   2. init: `registerClient(appToken)` at the top of the client entry / root `+layout` — launches the
//      browser SDK (DOM/console/network capture + web-vitals) that the error hook reports to.
import { type Bugsee, type BugseeLaunchOptionsWithPerformance, launch } from '@bugsee/bugsee';

// Re-export the @bugsee/svelte client surface (handleErrorWithBugsee, reportSvelteError, navigation naming).
export * from '@bugsee/svelte';

/** Options for the SvelteKit client (browser) composition — the batteries-included browser umbrella options. */
export interface SvelteKitClientOptions extends BugseeLaunchOptionsWithPerformance {}

/**
 * Start Bugsee for the SvelteKit client (browser). Returns the started client (a per-isolate singleton — a
 * repeat call returns the existing client).
 */
export function registerClient(appToken: string, options: SvelteKitClientOptions = {}): Bugsee {
  return launch(appToken, options);
}
