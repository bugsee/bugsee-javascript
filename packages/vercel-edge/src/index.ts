// @bugsee/vercel-edge — Vercel Edge (and the shared edge composition): WinterCG fetch transport, memory-only
// storage, incident-driven upload via ctx.waitUntil, globalThis.AsyncLocalStorage probe. Tier 2. See
// docs/design/sdk-design.md §3.x/§7.7/§12.5. Edge capture is INCIDENT-DRIVEN — a no-incident invocation
// uploads nothing (the in-memory buffer is discarded when the isolate ends).
export { buildEdgeEnvironment, type EdgeEnvironmentInput } from './environment';
export { type EdgeFetchHandler, withBugseeFetch } from './fetch-handler';
export {
  type Bugsee,
  type BugseeEdgeLaunchOptions,
  EdgeContextStoreToken,
  launchEdge,
} from './launch';
export {
  createEdgeRequestContextStore,
  type EdgeContextStoreLogger,
  type EdgeRequestContextStore,
  type EdgeRequestContextStoreOptions,
  type RunScopedStore,
} from './request-context-store';
export {
  type EdgeExecutionContext,
  resolveWaitUntil,
  type WaitUntil,
} from './wait-until';
