// @bugsee/performance
// APM extension (Tier 3, design §0.6/§16): ext()/registerExt; owns /v2/performance/transactions, the
// Span/Transaction model + §8.8 wire, web-vitals capture, and performance.* options. Tree-shakes to
// nothing when unused; the umbrella `bugsee` package auto-registers it (passive web-vitals on by
// default, active span API opt-in). See docs/PROGRESS.md.
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
  PERFORMANCE_OPTION_DEFINITIONS,
  PerformanceOption,
  type PerformanceUploadMode,
} from './options';
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
