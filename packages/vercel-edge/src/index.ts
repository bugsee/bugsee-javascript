// @bugsee/vercel-edge — Vercel Edge (and the shared edge composition): WinterCG fetch transport, memory-only
// storage, incident-driven upload via ctx.waitUntil, globalThis.AsyncLocalStorage probe. Tier 2. See
// docs/design/sdk-design.md §3.x/§7.7/§12.5. Edge capture is INCIDENT-DRIVEN — a no-incident invocation
// uploads nothing (the in-memory buffer is discarded when the isolate ends).
// Re-export the core attribute type that the edge public surface uses (EdgeInvocationOptions.attributes), so
// downstream edge packages (@bugsee/cloudflare) need not depend on @bugsee/core directly.
export type { AttributeValue } from '@bugsee/core';
export {
  createEdgeUnhandledRejectionProvider,
  type EdgeGlobalEvents,
} from './detection';
export {
  AWAITED_FLUSH_TIMEOUT_MS,
  DEFERRED_FLUSH_TIMEOUT_MS,
  type EdgeInvocationOptions,
  resolveEdgeStore,
  // The generic edge-invocation core: open a per-invocation context, capture+rethrow inside it, flush via
  // waitUntil. `@bugsee/cloudflare` builds its non-fetch (scheduled/queue/email/…) wrappers on this.
  runInEdgeContext,
} from './edge-context';
export { buildEdgeEnvironment, type EdgeEnvironmentInput } from './environment';
export { type EdgeFetchHandler, requestAttributes, withBugseeFetch } from './fetch-handler';
export {
  type Bugsee,
  type BugseeEdgeLaunchOptions,
  EdgeContextStoreToken,
  // `launch` is the public composition root (consistent with @bugsee/node / @bugsee/browser); `launchEdge` is
  // the same function under its descriptive name (the shared edge composition @bugsee/cloudflare also builds on).
  launchEdge as launch,
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
