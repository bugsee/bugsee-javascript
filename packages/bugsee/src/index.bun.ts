// bugsee — the BUN entry (selected via the package `exports` "bun" condition, listed BEFORE "node"
// because Bun sets both). Re-exports the server SDK surface + the umbrella launch() bound to
// @bugsee/bun's composition root, so the Bun-specific defaults are not silently lost. See ./bun.

export type { Bugsee } from '@bugsee/bun';
// Manual-instrumentation argument types — the curated public surface every adapter re-exports so users
// can type their own event()/addBreadcrumb()/logException() calls without reaching into @bugsee/core.
export type {
  AttributeValue,
  Breadcrumb,
  BreadcrumbInput,
  LogExceptionOptions,
} from '@bugsee/core';
export type { BugseeSpanProcessor } from '@bugsee/opentelemetry';
export { type BugseeBunLaunchOptions, launch } from './bun';
