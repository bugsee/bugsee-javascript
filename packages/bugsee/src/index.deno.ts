// bugsee — the DENO entry (selected via the package `exports` "deno" condition, listed BEFORE "node"
// because Deno sets both). Re-exports the server SDK surface + the umbrella launch() bound to
// @bugsee/deno's composition root, so the Deno-specific defaults are not silently lost. See ./deno.

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
// Helper form of writing `report.userAttachments` from `ReportHandler.before` (Android `Report.addAttachment`).
export {
  addReportAttachment,
  LifecycleEvents,
  type LifecycleEventsListener,
  type LifecycleEventType,
} from '@bugsee/core';
export type { BugseeSpanProcessor } from '@bugsee/opentelemetry';
// The performance facade types (the top-level startTransaction/startSpan/getActiveSpan calls exist on every
// entry, so their types must too).
export type {
  PerformanceApi,
  PerformanceFacade,
  Span,
  SpanStatus,
  StartTransactionOptions,
  Transaction,
  TransactionNameSource,
} from '@bugsee/performance';
export { type BugseeDenoLaunchOptions, launch, relaunch } from './deno';
export type { Bugsee } from './server-launch';
export { BugseeStatus, getStatus } from './status';
