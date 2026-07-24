// bugsee — the NODE entry (selected via the package `exports` "node" condition). Re-exports the Node SDK
// surface + the umbrella launch() (Node composition root + on-by-default extensions). See ./node.

// Manual-instrumentation argument types — the curated public surface every adapter re-exports so users
// can type their own event()/addBreadcrumb()/logException() calls without reaching into @bugsee/core.
export type {
  AttributeValue,
  Breadcrumb,
  BreadcrumbInput,
  LogExceptionOptions,
} from '@bugsee/core';
export type { Bugsee } from '@bugsee/node';
export type { BugseeSpanProcessor } from '@bugsee/opentelemetry';
export { type BugseeNodeLaunchOptions, launch } from './node';
