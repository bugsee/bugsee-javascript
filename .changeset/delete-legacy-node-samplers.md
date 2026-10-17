---
'@bugsee/node': minor
'@bugsee/bun': minor
'@bugsee/deno': minor
---

Removed the legacy `createNodeSystemMetricsSampler` and `createGuardedSystemMetricsSampler` (and their `NodeSystemMetricsDeps` / `GuardedSystemMetricsDeps` types). Nothing in the SDK used them; node, Bun and Deno already build their system traces from `createNodeSystemTraceProducers`. A caller-supplied `systemMetricsSampler` option still works, and `PerfHooks` is still exported.
