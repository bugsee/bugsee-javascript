// @bugsee/nextjs — edge (Vercel Edge / edge-light runtime) composition.
//
// Reached from `register()`'s `NEXT_RUNTIME === 'edge'` branch via `await import('./edge')` (design §3,
// hard-constraint 1: no edge code in the portable `.` graph or the node `./server` graph). It composes
// the web-APIs-only, bundle-lean `@bugsee/vercel-edge` family (WinterCG fetch transport, memory storage,
// `globalThis.AsyncLocalStorage` probe, incident-driven upload via `waitUntil`).
//
// Edge capture is INCIDENT-DRIVEN: a no-incident invocation uploads nothing. The launched client is a
// per-isolate singleton registered on the carrier, so the N3 `onRequestError` bridge finds it and reports
// edge route/RSC throws.
import { type Bugsee, type BugseeEdgeLaunchOptions, launchEdge } from '@bugsee/vercel-edge';

export type { Bugsee } from '@bugsee/vercel-edge';

/** Options for the Next.js edge composition — the `@bugsee/vercel-edge` launch options. */
export interface NextjsEdgeOptions extends BugseeEdgeLaunchOptions {}

/**
 * Start Bugsee for the Next.js **edge** (Vercel Edge / edge-light) runtime. Reached via the `register()`
 * dispatcher's edge branch; not called directly. Returns the started per-isolate client.
 */
export function registerEdge(appToken: string, options: NextjsEdgeOptions = {}): Bugsee {
  return launchEdge(appToken, options);
}
