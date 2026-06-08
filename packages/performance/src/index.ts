// @bugsee/performance
// APM extension (Tier 3, design §0.6/§16): ext()/registerExt. BUILT (Phase 0): the Span/Transaction
// model + §8.8 wire, the transaction buffer, the controller (startTransaction/getActiveSpan), the
// extension shell, and the performance.* options. PLANNED (later slices): web-vitals capture, the bundle
// performance.json emission, and the continuous /v2/performance/transactions upload. Tree-shakes to
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
