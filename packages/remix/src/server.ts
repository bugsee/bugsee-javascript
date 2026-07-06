// @bugsee/remix — server (Node runtime) composition.
//
// Node-only (imports the batteries-included node umbrella) → behind the `@bugsee/remix/server` subpath,
// never the portable `.` entry. Call `registerServer(appToken)` from your Remix server preload
// (`instrument.server.mjs` loaded via `--import`) or the top of a custom Express server / `entry.server`, so
// the node incoming-server auto-instrumentation opens a per-request context + `http.server` txn (which the
// `.` `handleError` bridge then stitches its reports to). Bugsee uses a `node:http` emit-patch (not
// import-in-the-middle), so a normal top-level import suffices — no fragile loader-hook preload ordering.
import { type Bugsee, type BugseeNodeLaunchOptions, launch } from 'bugsee/node';

export type { Bugsee } from 'bugsee/node';

/** Options for the Remix server (Node) composition — the batteries-included node umbrella options. */
export interface RemixServerOptions extends BugseeNodeLaunchOptions {}

/**
 * Start Bugsee for the Remix / React Router server (Node) runtime. Returns the started client (a
 * per-process singleton — a repeat call returns the existing client).
 */
export function registerServer(appToken: string, options: RemixServerOptions = {}): Bugsee {
  return launch(appToken, options);
}
