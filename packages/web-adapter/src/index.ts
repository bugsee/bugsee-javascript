// @bugsee/web-adapter — shared plumbing for the web framework adapters (tier 4). See
// docs/design/frontend-adapters.md §7 (the depth pass).
export type { Bugsee } from '@bugsee/browser';
export type { PerformanceApi } from '@bugsee/performance';
// Re-exported so every render-span integration (React Profiler / Vue mixin / Angular tracker / Svelte
// init-span) resolves `performance.timeOrigin` through the ONE policy, instead of each restating its own
// `?? 0` (which admits NaN and a same-clock-in-1970 timeOrigin, mis-anchoring a span nested inside a
// real-epoch transaction) — see `@bugsee/util`'s `resolveTimeOrigin` for the full reasoning.
export { resolveTimeOrigin } from '@bugsee/util';
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
