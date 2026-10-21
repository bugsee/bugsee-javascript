// @bugsee/performance
// APM extension: ext()/registerExt. BUILT: the Span/Transaction model + the
// transaction wire, the transaction buffer, the controller (startTransaction/getActiveSpan), the extension shell, the
// performance.* options, and the full Core Web Vitals capture (LCP/CLS/INP/FCP/TTFB) collected into a
// pageload transaction. PLANNED: the bundle performance.json emission + the continuous
// /v2/performance/transactions upload + the umbrella auto-register. Tree-shakes to nothing when unused;
// the umbrella `bugsee` package auto-registers it (passive web-vitals on by default, span API opt-in).

export { type ActiveSpanStore, createSingleSlotActiveSpanStore } from './active-span-store';
export {
  boundedBase64,
  bytesToBase64,
  flattenAttributes,
  flattenAttributeValue,
  isByteArray,
  MAX_ATTRIBUTE_ARRAY_LENGTH,
  MAX_ATTRIBUTE_DEPTH,
  MAX_ATTRIBUTE_JSON_LENGTH,
  MAX_ATTRIBUTE_NODES,
  MAX_ATTRIBUTE_STRING_LENGTH,
  MAX_ATTRIBUTE_TREE_CHARS,
  normalizeAttributes,
  normalizeAttributeValue,
  safeAnyValue,
  stringifyAnyValue,
  TRUNCATION_MARKER,
} from './attribute-value';
export {
  createPerformanceController,
  NAME_SOURCE_ATTRIBUTE,
  type PerformanceApi,
  type PerformanceControllerDeps,
  type StartTransactionOptions,
  type TransactionNameSource,
} from './controller';
export { hasDeviceIdAttribute, stampDeviceIdOnWire } from './device-id-attribute';
export {
  createPerformanceExtension,
  type PerformanceExtension,
  type PerformanceExtensionOptions,
} from './extension';
export { createNoopTransaction, createPerformanceFacade, type PerformanceFacade } from './facade';
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
export { redactSqlLiterals, sanitizeSpan } from './span-sanitizer';
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
