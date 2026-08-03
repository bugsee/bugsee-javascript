// @bugsee/web-adapter — shared plumbing for the web framework adapters (tier 4). See
// docs/design/frontend-adapters.md §7 (the depth pass).
export type { Bugsee } from '@bugsee/browser';
export type { PerformanceApi } from '@bugsee/performance';
export {
  type AdapterClientOptions,
  type AdapterMechanism,
  getPerformanceApi,
  guarded,
  neverThrow,
  type ReportErrorOptions,
  type RouteNamingOptions,
  reportError,
  resolveClient,
  setRouteName,
} from './adapter';
export {
  RENDER_DURATION_ATTRIBUTE,
  RENDER_PHASE_ATTRIBUTE,
  RENDER_SPAN_OP,
  type RenderSpanInput,
  recordRenderSpan,
} from './render-span';
