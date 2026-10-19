---
'@bugsee/node': minor
'@bugsee/bun': minor
'@bugsee/deno': minor
---

Node now reports garbage-collection activity in `traces.system`: `gc_count`, `gc_pause_ms` (summed pause) and `gc_pause_max_ms`, each per sampling interval, from a `PerformanceObserver` that exists only while system traces are running. A quiet interval reports a true zero.

Bun and Deno omit these traces: their GC observer sees no collections (measured), so a zero there would be false. `createNodeSystemTraceProducers` gains `measuresGc` (default `true`); with `false` no observer is constructed.
