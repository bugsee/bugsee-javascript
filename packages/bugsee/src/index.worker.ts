// bugsee — the WEB WORKER entry (selected via the package `exports` "worker" condition that bundlers set
// for a worker build; listed AFTER "workerd"/"edge-light", which set "worker" as well, and BEFORE
// "browser", which a worker build also sets).
//
// Without it a worker build resolved the BROWSER entry, whose SDK reaches for `window`/`document` and the
// page lifecycle. `@bugsee/webworker` is the DOM-less composition for both Web Workers and Service
// Workers, and is what this re-exports.
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
export * from '@bugsee/webworker';

import { relaunchWith } from '@bugsee/core';
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

// Lifecycle parity with the node/browser entries: the status enum, the process-level getStatus(), and
// relaunch() on top of core's relaunchWith, so it re-runs THIS entry's launch (extensions re-wired).
export { BugseeStatus, getStatus } from './status';

/** Stop the running client (if any) and launch again with the same token; `options` replace the previous
 *  launch options when given. */
export const relaunch = (options?: BugseeWorkerLaunchOptions): Promise<Bugsee> =>
  relaunchWith(launch, options, options?.carrier);
