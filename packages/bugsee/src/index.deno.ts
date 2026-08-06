// bugsee — the DENO entry (selected via the package `exports` "deno" condition, listed BEFORE "node"
// because Deno sets both). Re-exports the server SDK surface + the umbrella launch() bound to
// @bugsee/deno's composition root, so the Deno-specific defaults are not silently lost. See ./deno.

// Manual-instrumentation argument types — the curated public surface every adapter re-exports so users
// can type their own event()/addBreadcrumb()/logException() calls without reaching into @bugsee/core.
export type {
  AttributeValue,
  Breadcrumb,
  BreadcrumbInput,
  LogExceptionOptions,
} from '@bugsee/core';
export type { Bugsee } from '@bugsee/deno';
export type { BugseeSpanProcessor } from '@bugsee/opentelemetry';
export { type BugseeDenoLaunchOptions, launch } from './deno';
