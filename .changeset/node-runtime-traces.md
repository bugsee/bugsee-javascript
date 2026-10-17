---
'@bugsee/node': minor
'@bugsee/bun': minor
'@bugsee/deno': minor
---

Node, Bun and Deno now report more runtime traces in `traces.system`:

- `v8_heap_size_limit`, `v8_heap_available`, `v8_heap_malloced`, `v8_heap_peak_malloced` and the ceiling-based `ram_js_heap_total` / `_used` / `_free` (`total` is the heap limit, not the committed heap). Node and Deno only; omitted on Bun, whose heap statistics are not a V8 ceiling.
- `process_memory_limit` (the cgroup cap), reported only for a real cap: omitted when `process.constrainedMemory()` is 0, the 2^64 sentinel, or at least total RAM.
- `process_uptime_s`.
- `ram_system_available`, on Node only: Deno's `availableMemory()` is a different quantity on the same host (measured), so it is omitted there and on Bun.

`createNodeSystemTraceProducers` gains `measuresV8Heap` and `measuresAvailableMemory` (default `true`) for runtimes that cannot answer honestly.
