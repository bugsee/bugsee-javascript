// bugsee — the BUN entry (selected via the package `exports` "bun" condition, listed BEFORE "node"
// because Bun sets both). Re-exports the server SDK surface + the umbrella launch() bound to
// @bugsee/bun's composition root, so the Bun-specific defaults are not silently lost. See ./bun.

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
export { type BugseeBunLaunchOptions, launch, relaunch } from './bun';
export type { Bugsee, BugseeServerLaunchOptions } from './server-launch';
export { BugseeStatus, getStatus } from './status';
export type { UmbrellaExtensionOptions } from './wire';
