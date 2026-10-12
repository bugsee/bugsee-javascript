// bugsee — the WORKERD entry (selected via the package `exports` "workerd" condition, listed BEFORE
// "worker" and "browser" because Cloudflare's runtime sets those too).
//
// Without it the umbrella fell through to `default`, i.e. the BROWSER entry — IndexedDB, DOM, a page
// lifecycle — none of which exists in a Worker. A thin re-export rather than an umbrella composition:
// `@bugsee/cloudflare` IS the composition root for this runtime, and edge capture is incident-driven with
// no pageload or startup transaction to wire.

export * from '@bugsee/cloudflare';
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

import {
  type BugseeEdgeLaunchOptions,
  type Bugsee as CloudflareBugsee,
  launch as launchCloudflare,
} from '@bugsee/cloudflare';
import { relaunchWith } from '@bugsee/core';
import type { PerformanceFacade } from '@bugsee/performance';
import { withPerformanceFacade } from './performance-facade';

// The workerd runtime collects no performance data, so the top-level performance calls are no-ops here (as
// on the mobile SDKs with performance off). Explicit exports win over the `export *` above.
export type Bugsee = CloudflareBugsee & PerformanceFacade;
export function launch(appToken: string, options?: BugseeEdgeLaunchOptions): Bugsee {
  return withPerformanceFacade(launchCloudflare(appToken, options));
}
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
// Helper form of writing `report.userAttachments` from `ReportHandler.before` (Android `Report.addAttachment`).
export {
  addReportAttachment,
  LifecycleEvents,
  type LifecycleEventsListener,
  type LifecycleEventType,
} from '@bugsee/core';

// Lifecycle parity with the node/browser entries: the status enum, the process-level getStatus(), and
// relaunch() on top of core's relaunchWith, so it re-runs THIS entry's launch (extensions re-wired).
export { BugseeStatus, getStatus } from './status';

/** Stop the running client (if any) and launch again with the same token; `options` replace the previous
 *  launch options when given. */
export const relaunch = (options?: BugseeEdgeLaunchOptions): Promise<Bugsee> =>
  relaunchWith(launch, options, options?.carrier);
