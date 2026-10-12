// bugsee — the WEB WORKER entry (selected via the package `exports` "worker" condition that bundlers set
// for a worker build; listed AFTER "workerd"/"edge-light", which set "worker" as well, and BEFORE
// "browser", which a worker build also sets).
//
// Without it a worker build resolved the BROWSER entry, whose SDK reaches for `window`/`document` and the
// page lifecycle. `@bugsee/webworker` is the DOM-less composition for both Web Workers and Service
// Workers, and is what this re-exports.
// The built-in network redaction, for composing with a custom `setNetworkEventFilter` (which REPLACES the
// default sanitizer rather than layering on it).
export { type DefaultNetworkSanitizer, getDefaultNetworkSanitizer } from '@bugsee/capture';
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
export * from '@bugsee/webworker';

import type { PerformanceFacade } from '@bugsee/performance';
import {
  type BugseeWorkerLaunchOptions,
  launch as launchWorker,
  type Bugsee as WorkerBugsee,
} from '@bugsee/webworker';
import { withPerformanceFacade } from './performance-facade';

// Workers collect no performance data, so the top-level performance calls are no-ops here (as on the
// mobile SDKs with performance off). They exist so one code base can call them on every runtime.
// Explicit exports win over the `export *` above.
export type Bugsee = WorkerBugsee & PerformanceFacade;
export function launch(appToken: string, options?: BugseeWorkerLaunchOptions): Bugsee {
  return withPerformanceFacade(launchWorker(appToken, options));
}
