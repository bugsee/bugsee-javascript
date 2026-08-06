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
} from '@bugsee/core';
export * from '@bugsee/webworker';
