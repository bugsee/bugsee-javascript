---
'@bugsee/trackers': minor
'@bugsee/core': patch
---

New internal package `@bugsee/trackers`: the foundation the domain trackers are built on. It now owns the multi-key emitter, the `Interceptor` contract, `InterceptorBase` and `createTrackerRegistry`, and reserves the `./browser`, `./node` and `./electron` entries for platform tracker implementations.

`@bugsee/core` imports it and re-exports the same names, so existing imports from `@bugsee/core` are unchanged.
