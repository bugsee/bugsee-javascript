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
// F-6: the `HttpTransport` primitive (+ its request/response option shapes), so a custom transport (a
// proxy, a queueing shim, a test double) passed to the `transport` launch option types without an
// unsafe cast.
export type { Bugsee, HttpRequestOptions, HttpResponse, HttpTransport } from '@bugsee/node';
// F-5: the per-request context store — needed by app code that wants to call `store.setAttribute()`
// directly (e.g. the per-request-attribute concurrency pattern) without reaching into @bugsee/node's
// internal DI container (`client.getServiceProvider(...)`) or taking a direct dependency on it purely
// to reach this token, as every framework adapter's own hooks.ts already does internally.
export { type RequestContextStore, RequestContextStoreToken } from '@bugsee/node';
export type { BugseeSpanProcessor } from '@bugsee/opentelemetry';
export { type BugseeNodeLaunchOptions, launch } from './node';
