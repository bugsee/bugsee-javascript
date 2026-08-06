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
} from '@bugsee/core';
export * from '@bugsee/vercel-edge';
export { launchEdge as launch } from '@bugsee/vercel-edge';
