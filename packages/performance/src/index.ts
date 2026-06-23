// @bugsee/performance
// APM extension (Tier 3, design §0.6/§16): ext()/registerExt. BUILT: the Span/Transaction model + §8.8
// wire, the transaction buffer, the controller (startTransaction/getActiveSpan), the extension shell, the
// performance.* options, and the full Core Web Vitals capture (LCP/CLS/INP/FCP/TTFB) collected into a
// pageload transaction. PLANNED: the bundle performance.json emission + the continuous
// /v2/performance/transactions upload + the umbrella auto-register. Tree-shakes to nothing when unused;
// the umbrella `bugsee` package auto-registers it (passive web-vitals on by default, span API opt-in).
// See docs/PROGRESS.md.

export {
  createPerformanceController,
  type PerformanceApi,
  type PerformanceControllerDeps,
  type StartTransactionOptions,
} from './controller';
export {
  createPerformanceExtension,
  type PerformanceExtension,
  type PerformanceExtensionOptions,
} from './extension';
export {
  collectHttpSpans,
  type HttpSpanCollectorDeps,
  type NetworkSource,
} from './http-spans';
export {
  createIdleTransaction,
  type IdleTimer,
  type IdleTransactionHandle,
  type IdleTransactionOptions,
} from './idle-transaction';
export {
  type CollectInteractionsDeps,
  collectInteractions,
  type InteractionDetailLike,
  type InteractionSource,
} from './interactions';
export {
  type CollectNavigationsDeps,
  collectNavigations,
  type NavigationDetailLike,
  type NavigationSource,
} from './navigations';
export {
  PERFORMANCE_OPTION_DEFINITIONS,
  PerformanceOption,
  type PerformanceUploadMode,
} from './options';
export {
  collectLongTasks,
  collectNavigationTiming,
  collectPageLoadVitals,
  collectResourceTiming,
  type PageLoadVitalsOptions,
} from './page-load';
export {
  createPerformanceSend,
  type PerformanceSendDeps,
} from './performance-send';
export {
  createPerformanceUploader,
  type PerformanceUploader,
  type PerformanceUploaderDeps,
} from './performance-uploader';
export { createRateSampler } from './sampling';
export {
  type CreateTransactionDeps,
  createTransaction,
  defaultSpanId,
  defaultTraceId,
  type Span,
  type SpanStatus,
  type SpanWire,
  serializeTransaction,
  type Transaction,
  type TransactionOptions,
  type TransactionWire,
} from './span';
export {
  createTransactionStore,
  type TransactionStore,
  type TransactionStoreOptions,
} from './transaction-store';
export { onCLS } from './web-vitals/cls';
export { realWebVitalsEnv, type WebVitalsEnv } from './web-vitals/env';
export { onFCP } from './web-vitals/fcp';
export { type INPReportOptions, onINP } from './web-vitals/inp';
export { onLCP } from './web-vitals/lcp';
export type {
  Metric,
  MetricName,
  NavigationType,
  Rating,
} from './web-vitals/metric';
export { onTTFB } from './web-vitals/ttfb';
export type { VitalReportOptions } from './web-vitals/vitals';
export {
  type WiredPerformance,
  type WirePerformanceOptions,
  wirePerformance,
} from './wire-performance';
