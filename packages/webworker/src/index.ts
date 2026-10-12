// @bugsee/webworker — DOM-less browser-family SDK for Web Workers + Service Workers. Capture: console→log +
// network (fetch/ws). Detection: global `error`/`unhandledrejection` on the worker `self`. No DOM, no ALS /
// per-request context, memory-only (IndexedDB persistence is a follow-up).

// API parity with the umbrella entries: the same VALUE surface, thin re-exports.
export { type DefaultNetworkSanitizer, getDefaultNetworkSanitizer } from '@bugsee/capture';
export {
  addReportAttachment,
  BugseeStatus,
  getProcessStatus as getStatus,
  LifecycleEvents,
  type LifecycleEventsListener,
  type LifecycleEventType,
  type ReportAttachmentInput,
} from '@bugsee/core';
export {
  buildWorkerEnvironment,
  realWorkerProbe,
  type WorkerEnvironmentInput,
  type WorkerPlatformType,
  type WorkerProbe,
} from './environment';
// Service Worker event flush — keep the SW alive until an incident upload completes (the SW analog of edge's
// ctx.waitUntil). Unneeded for a long-lived Web Worker.
export {
  type BugseeEventOptions,
  type ExtendableEventLike,
  type ServiceWorkerEventHandler,
  SW_FLUSH_TIMEOUT_MS,
  withBugseeEvent,
} from './event';
export { type Bugsee, type BugseeWorkerLaunchOptions, launch } from './launch';
export { relaunch } from './relaunch';
