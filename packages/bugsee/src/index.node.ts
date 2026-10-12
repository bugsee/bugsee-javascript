// bugsee — the NODE entry (selected via the package `exports` "node" condition). Re-exports the Node SDK
// surface + the umbrella launch() (Node composition root + on-by-default extensions). See ./node.

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
// F-6: the `HttpTransport` primitive (+ its request/response option shapes), so a custom transport (a
// proxy, a queueing shim, a test double) passed to the `transport` launch option types without an
// unsafe cast.
export type { HttpRequestOptions, HttpResponse, HttpTransport } from '@bugsee/node';
// F-5: the per-request context store — needed by app code that wants to call `store.setAttribute()`
// directly (e.g. the per-request-attribute concurrency pattern) without reaching into @bugsee/node's
// internal DI container (`client.getServiceProvider(...)`) or taking a direct dependency on it purely
// to reach this token, as every framework adapter's own hooks.ts already does internally.
export { type RequestContextStore, RequestContextStoreToken } from '@bugsee/node';
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
export { type BugseeNodeLaunchOptions, launch, relaunch } from './node';
export type { Bugsee } from './server-launch';
export { BugseeStatus, getStatus } from './status';
