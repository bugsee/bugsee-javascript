---
'@bugsee/node': minor
'@bugsee/bun': minor
'@bugsee/deno': minor
'@bugsee/trackers': minor
---

Node, Bun and Deno system traces now come from a per-process `ProcessTracker` in the new `@bugsee/trackers/node` entry, which replaces `@bugsee/node`'s `ProcessStatsTracker`. Trace names are unchanged, the GC observer and event-loop histogram now run only while their traces are enabled, and the runtime gates for Bun and Deno still omit the traces those runtimes cannot measure honestly. The `cpu_usage_*` traces no longer record a start value (it was a microsecond-window noise reading); they begin with the first sample. `@bugsee/node` (and so `@bugsee/bun` and `@bugsee/deno`, which re-export it) no longer exports `ProcessStatsTracker` and `ProcessStats`; it exports `processTrackerFor`, `resetProcessTracker` and the `ProcessTracker` type instead.
