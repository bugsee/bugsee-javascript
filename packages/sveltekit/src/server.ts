// @bugsee/sveltekit — server (Node runtime) composition.
//
// Node-only (imports the batteries-included node umbrella) → behind the `@bugsee/sveltekit/server` subpath,
// never the portable `.` entry. Call `registerServer(appToken)` at the top of `src/hooks.server.ts` (or an
// `instrumentation.server.ts`); the node incoming-server auto-instrumentation opens a per-request context +
// `http.server` txn (which the `.` `handleError`/`handle` hooks then stitch reports + the trace `<meta>` to).
// Bugsee uses a `node:http` emit-patch (not import-in-the-middle), so a normal top-level import suffices.
import { type Bugsee, type BugseeNodeLaunchOptions, launch } from '@bugsee/bugsee/node';

export type { Bugsee } from '@bugsee/bugsee/node';

/** Options for the SvelteKit server (Node) composition — the batteries-included node umbrella options. */
export interface SvelteKitServerOptions extends BugseeNodeLaunchOptions {}

/**
 * Start Bugsee for the SvelteKit server (Node) runtime. Returns the started client (a per-process singleton
 * — a repeat call returns the existing client).
 */
export function registerServer(appToken: string, options: SvelteKitServerOptions = {}): Bugsee {
  return launch(appToken, options);
}
