// bugsee — the WORKERD entry (selected via the package `exports` "workerd" condition, listed BEFORE
// "worker" and "browser" because Cloudflare's runtime sets those too).
//
// Without it the umbrella fell through to `default`, i.e. the BROWSER entry — IndexedDB, DOM, a page
// lifecycle — none of which exists in a Worker. A thin re-export rather than an umbrella composition:
// `@bugsee/cloudflare` IS the composition root for this runtime, and edge capture is incident-driven with
// no pageload or startup transaction to wire.

export * from '@bugsee/cloudflare';
export type {
  AttributeValue,
  Breadcrumb,
  BreadcrumbInput,
  LogExceptionOptions,
} from '@bugsee/core';
