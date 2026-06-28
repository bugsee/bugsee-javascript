// @bugsee/cloudflare — Cloudflare Workers (workerd): the @bugsee/vercel-edge edge composition with the platform
// identity defaulted to 'workers'. ctx.waitUntil comes from the handler's 3rd arg `(req, env, ctx)`;
// AsyncLocalStorage needs the `nodejs_compat`/`nodejs_als` compatibility flag (degrades to a single-slot store
// + one-time warning otherwise). Tier 2. See docs/design/edge-runtime.md (C1) + the README.
//
// Re-export the ENTIRE edge surface (withBugseeFetch, buildEdgeEnvironment, createEdgeRequestContextStore,
// resolveWaitUntil, createEdgeUnhandledRejectionProvider, EdgeContextStoreToken, launchEdge, types) ...
export * from '@bugsee/vercel-edge';
// The Cloudflare handler surface: the unified `withBugsee` wrapper (fetch + scheduled/queue/email/tail) + the
// structural handler types (C2).
export type {
  Awaitable,
  EmailMessage,
  ExecutionContext,
  ExportedHandler,
  MessageBatch,
  ScheduledController,
  TraceItem,
} from './cloudflare-types';
// ... then shadow the re-exported (edge-light) `launch` with Cloudflare's, which defaults platformType to
// 'workers' (an explicit named export wins over `export *` for the same name).
export { launch } from './launch';
// request.cf geo/network enrichment (C3) — applied to fetch by `withBugsee`; exposed for manual DO-fetch use.
export { cfAttributes, cloudflareRequestAttributes } from './request-cf';
export { type BugseeWorkerConfig, withBugsee } from './with-bugsee';
