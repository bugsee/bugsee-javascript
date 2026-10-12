// bugsee — the VERCEL EDGE entry (selected via the package `exports` "edge-light" condition, which Vercel's
// edge runtime sets; listed before "worker"/"browser", which it also sets).
//
// Without it the umbrella fell through to `default`, i.e. the BROWSER entry, which needs IndexedDB and a
// DOM. A thin re-export: `@bugsee/vercel-edge` IS the composition root here. `launchEdge` is also exported
// as `launch` so the umbrella's entry point has the same name on every runtime.
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
export * from '@bugsee/vercel-edge';

import type { PerformanceFacade } from '@bugsee/performance';
import {
  type BugseeEdgeLaunchOptions,
  type Bugsee as EdgeBugsee,
  launchEdge,
} from '@bugsee/vercel-edge';
import { withPerformanceFacade } from './performance-facade';

// The edge runtime collects no performance data, so the top-level performance calls are no-ops here (as
// on the mobile SDKs with performance off). Explicit exports win over the `export *` above.
export type Bugsee = EdgeBugsee & PerformanceFacade;
export function launch(appToken: string, options?: BugseeEdgeLaunchOptions): Bugsee {
  return withPerformanceFacade(launchEdge(appToken, options));
}

// Helper form of writing `report.userAttachments` from `ReportHandler.before` (Android `Report.addAttachment`).
export { addReportAttachment } from '@bugsee/core';
