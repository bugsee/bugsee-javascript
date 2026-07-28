// Minimal ambient declaration for the ONE node builtin @bugsee/cloudflare depends on.
//
// Deliberately NOT `@types/node`. This is an edge package: pulling in the full Node typings would make
// `process`, `fs`, `Buffer` and friends typecheck here, quietly eroding the runtime-portability rule that
// keeps node-only code out of an edge bundle. Declaring only the AsyncLocalStorage surface we use keeps the
// guardrail intact and documents the exact dependency.
//
// Why the dependency exists at all: `globalThis.AsyncLocalStorage` does not exist on workerd under any
// compatibility flag; ALS is reachable only through `node:async_hooks` (docs/review/cloudflare.md SEV1 #3,
// docs/design/cloudflare-tenant-isolation.md §7). Requires the `nodejs_compat` flag at deploy time.
declare module 'node:async_hooks' {
  /** The run()-scoped subset used by the edge context store — no `enterWith`/`disable` (workerd lacks them). */
  export class AsyncLocalStorage<T> {
    getStore(): T | undefined;
    run<R>(store: T, fn: () => R): R;
  }
}
