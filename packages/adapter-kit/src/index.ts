// @bugsee/adapter-kit — runtime-portable primitives shared by the SSR meta-framework adapters
// (@bugsee/{nextjs,remix,nuxt,sveltekit,astro}).
// The shared kit: the server-error bridge and the trace-data primitive. Depends only on @bugsee/core; no runtime-
// specific imports, so it is safe in node, edge, and browser graphs alike.
export { type ReportServerErrorOptions, reportServerError } from './report-server-error';
export {
  getTraceparent,
  type TraceDataOptions,
  traceMetaEntries,
  traceMetaTag,
} from './trace-data';
