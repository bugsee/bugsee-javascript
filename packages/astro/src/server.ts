// @bugsee/astro — server (Node runtime) composition.
//
// Node-only (imports the batteries-included node umbrella) → behind the `@bugsee/astro/server` subpath,
// never the portable `.`/`./middleware` entries. The Integration's generated server-middleware module calls
// `registerServer(…)` at module-eval (so it launches for the first request of ANY route); the node
// incoming-server auto-instrumentation (a `node:http` emit-patch) then opens a per-request context that the
// middleware stitches its report + trace `<meta>` to.
import { type Bugsee, type BugseeNodeLaunchOptions, launch } from 'bugsee/node';

export type { Bugsee } from 'bugsee/node';

/** Options for the Astro server (Node) composition — the batteries-included node umbrella options. */
export interface AstroServerOptions extends BugseeNodeLaunchOptions {}

/**
 * Start Bugsee for the Astro server (Node) runtime. Returns the started client (a per-process singleton — a
 * repeat call returns the existing client).
 */
export function registerServer(appToken: string, options: AstroServerOptions = {}): Bugsee {
  return launch(appToken, options);
}
