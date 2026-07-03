// @bugsee/nextjs — server (Node runtime) composition.
//
// This module is the target of `await import('@bugsee/nextjs/server')` from the
// `NEXT_RUNTIME === 'nodejs'` branch of `register()` in `instrumentation.ts` (see
// docs/design/nextjs-adapter.md §3, hard-constraint 1: no Node code reachable from the edge/client
// graph). It is a THIN composition over `@bugsee/node` `launch()` — the full server SDK (capture,
// reports, node:http interception, per-request context, durable recovery) comes from the platform;
// Next-specific server behaviour (OTel default-attach, N1b) accretes here.
import { type Bugsee, type BugseeLaunchOptions, launch } from '@bugsee/node';

export type { Bugsee } from '@bugsee/node';

/**
 * Options for the Next.js server (Node) composition. Extends the `@bugsee/node` launch options
 * verbatim; Next-specific server options are added by later slices.
 */
export interface NextjsServerOptions extends BugseeLaunchOptions {}

/**
 * Start Bugsee for the Next.js **server** (Node) runtime. Call from `register()` in
 * `instrumentation.ts` under the `NEXT_RUNTIME === 'nodejs'` branch (reached via `await import`) so
 * that no Node-only code is bundled into the edge or client graph. Returns the started client
 * (a per-process singleton — a repeat call under dev HMR returns the existing client).
 */
export function registerServer(appToken: string, options: NextjsServerOptions = {}): Bugsee {
  return launch(appToken, options);
}
