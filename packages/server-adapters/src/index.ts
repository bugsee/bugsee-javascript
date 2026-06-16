// @bugsee/server-adapters — framework-agnostic server-instrumentation engine (design:
// docs/design/generic-server-adapter.md). Open a per-request context + http.server span from PLAIN VALUES
// from any backend framework / raw http.Server; also the shared substrate the per-framework adapters use.
export {
  type BugseeRequestInfo,
  type BugseeRequestSpan,
  type BugseeServerOptions,
  defaultShouldReport,
  openBugseeContext,
  openBugseeRequest,
  startBugseeServerSpan,
} from './server';
