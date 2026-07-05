// @bugsee/adapter-kit — runtime-portable primitives shared by the SSR meta-framework adapters
// (@bugsee/{nextjs,remix,nuxt,sveltekit,astro}). See docs/design/meta-framework-adapters.md §3 (the
// shared kit) — P4 (server-error bridge) + P5 (trace-data). Depends only on @bugsee/core; no runtime-
// specific imports, so it is safe in node, edge, and browser graphs alike.
export { type ReportServerErrorOptions, reportServerError } from './report-server-error';
export { getTraceparent, type TraceDataOptions, traceMetaEntries } from './trace-data';
