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
export { type BugseeLaunchOptionsWithPerformance, launch } from './launch';
