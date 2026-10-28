---
'@bugsee/trackers': minor
'@bugsee/node': minor
'@bugsee/bun': minor
'@bugsee/deno': minor
---

`process_memory_limit` now has an explicit runtime gate, `measuresConstrainedMemory` (default on). Bun and Deno enable it only on Linux, the one platform where a cgroup cap exists, so the trace is omitted elsewhere instead of relying on the value filter alone.
