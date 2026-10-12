// bugsee
// Umbrella package; the batteries-included entry (Tier 5). It re-exports the platform SDK surface and
// adds launch() = the platform composition root + the on-by-default extensions (@bugsee/performance:
// web-vitals + transactions + http spans) wired in. See docs/design/sdk-design.md §5.
export type { ReportDialogOptions, ReportDialogStrings } from '@bugsee/browser';
// The built-in network redaction, for composing with a custom `setNetworkEventFilter` (which REPLACES the
// default sanitizer rather than layering on it).
export { type DefaultNetworkSanitizer, getDefaultNetworkSanitizer } from '@bugsee/capture';
// Manual-instrumentation argument types — the curated public surface every adapter re-exports so users
// can type their own event()/addBreadcrumb()/logException() calls without reaching into @bugsee/core.
export type {
  AttributeValue,
  Breadcrumb,
  BreadcrumbInput,
  LogExceptionOptions,
  ReportAttachmentInput,
  UploadOptions,
} from '@bugsee/core';
// Lifecycle events: the listener type + the event-name constants for `setLifecycleEventsListener`.
export {
  LifecycleEvents,
  type LifecycleEventsListener,
  type LifecycleEventType,
} from '@bugsee/core';
// The SpanProcessor type users receive via `onOtelSpanProcessor` to register on their TracerProvider.
export type { BugseeSpanProcessor } from '@bugsee/opentelemetry';
// The performance extension's public surface. Re-exported for a reason beyond convenience:
// @bugsee/performance declaration-merges `NameExtensionMapping` so that `client.ext('performance')`
// is typed, and TypeScript only loads that augmentation if the consumer's type graph reaches the
// package. Nothing else here referenced it, so the published .d.ts never mentioned it and
// `client.ext('performance')` had NO usable type for anyone installing from npm — it worked inside
// this monorepo only because source-based `exports` make the whole graph visible.
// The top-level performance calls (mobile parity) and the no-op-safe facade type.
export type {
  PerformanceApi,
  PerformanceFacade,
  Span,
  SpanStatus,
  StartTransactionOptions,
  Transaction,
  TransactionNameSource,
} from '@bugsee/performance';
export {
  type Bugsee,
  type BugseeLaunchOptionsWithPerformance,
  launch,
  relaunch,
} from './launch';
export { BugseeStatus, getStatus } from './status';
