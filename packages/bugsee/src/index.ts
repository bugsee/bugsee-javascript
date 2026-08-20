// bugsee
// Umbrella package; the batteries-included entry (Tier 5). It re-exports the platform SDK surface and
// adds launch() = the platform composition root + the on-by-default extensions (@bugsee/performance:
// web-vitals + transactions + http spans) wired in. See docs/design/sdk-design.md §5.
export type { Bugsee } from '@bugsee/browser';
// Manual-instrumentation argument types — the curated public surface every adapter re-exports so users
// can type their own event()/addBreadcrumb()/logException() calls without reaching into @bugsee/core.
export type {
  AttributeValue,
  Breadcrumb,
  BreadcrumbInput,
  LogExceptionOptions,
} from '@bugsee/core';
// The SpanProcessor type users receive via `onOtelSpanProcessor` to register on their TracerProvider.
export type { BugseeSpanProcessor } from '@bugsee/opentelemetry';
// The performance extension's public surface. Re-exported for a reason beyond convenience:
// @bugsee/performance declaration-merges `NameExtensionMapping` so that `client.ext('performance')`
// is typed, and TypeScript only loads that augmentation if the consumer's type graph reaches the
// package. Nothing else here referenced it, so the published .d.ts never mentioned it and
// `client.ext('performance')` had NO usable type for anyone installing from npm — it worked inside
// this monorepo only because source-based `exports` make the whole graph visible.
export type {
  PerformanceApi,
  Span,
  SpanStatus,
  StartTransactionOptions,
  Transaction,
  TransactionNameSource,
} from '@bugsee/performance';
export { type BugseeLaunchOptionsWithPerformance, launch } from './launch';
