---
'@bugsee/node': minor
'@bugsee/bun': minor
'@bugsee/deno': minor
'@bugsee/electron': minor
'@bugsee/trackers': minor
---

System traces are unified with Android/iOS (C15, C16). Both changes alter what the SDK writes; the SDK is in beta.

- **BREAKING value change:** `event_loop_utilization` is now a PERCENT 0-100 with one decimal (`60` is "60% busy"), consistent with `cpu_usage_process`. It was a fraction `0..1`. Bun and Deno still omit it (their `eventLoopUtilization()` answers flat zeros). The ProcessTracker `utilization` stage payload is now `{ utilizationPercent }` instead of `{ utilization }`, and an injected `eventLoopUtilization` reader must answer percent.
- **Retired traces:** `gc_count`, `gc_pause_ms` and `gc_pause_max_ms` are gone from `traces.system`.
- **New event:** garbage collection is the `gc` event in `events.system`, params `{ count, pauseMs, maxPauseMs }`. One event is written per 1 s interval in which at least one collection ran; a quiet interval writes nothing. Node and Electron main only: Bun and Deno never emit it (their GC observer is blind). The observer exists only while system events are captured (`captureSystemEvents`). `createNodeSystemEventsSource` gains `processTracker` and `onError` options.
