---
'@bugsee/node': minor
'@bugsee/bun': minor
'@bugsee/deno': minor
'@bugsee/electron': minor
'@bugsee/trackers': minor
---

System traces are unified with Android/iOS (C15, C16). None of this has been released before, so there is no migration.

- `event_loop_utilization` is a PERCENT 0-100 with one decimal (`60` is "60% busy"), consistent with `cpu_usage_process`, not a `0..1` fraction. Bun and Deno still omit it (their `eventLoopUtilization()` answers flat zeros). The ProcessTracker `utilization` stage payload is now `{ utilizationPercent }` instead of `{ utilization }`, and an injected `eventLoopUtilization` reader must answer percent.
- **No gc traces:** `gc_count`, `gc_pause_ms` and `gc_pause_max_ms` are not written to `traces.system`.
- **New event:** garbage collection is the `gc` event in `events.system`, params `{ count, pauseMs, maxPauseMs }` (pauses rounded to 3 decimals). One event is written per 1 s interval in which at least one collection ran; a quiet interval writes nothing. Node and Electron main only: Bun and Deno never emit it (their GC observer is blind). The observer exists only while system events are captured (`captureSystemEvents`). `createNodeSystemEventsSource` gains `processTracker` and `onError` options.
- **Timers:** the GC observer and its share of the 1 s tracker sampling timer now belong to system events, so `captureSystemTraces: false` alone no longer means no sampling timer on Node (set `captureSystemEvents: false` too). A tracker stage the runtime can never answer (Bun/Deno gates) no longer keeps that timer alive.
