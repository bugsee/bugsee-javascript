---
'@bugsee/node': minor
'@bugsee/bun': patch
'@bugsee/deno': patch
'@bugsee/trackers': minor
---

Node, Bun and Deno system traces now come from a per-process `ProcessTracker` in the new `@bugsee/trackers/node` entry, which replaces `@bugsee/node`'s `ProcessStatsTracker`. Trace names and values are unchanged; the GC observer and event-loop histogram now run only while their traces are enabled, and the runtime gates for Bun and Deno still omit the traces those runtimes cannot measure honestly. `@bugsee/node` no longer exports `ProcessStatsTracker` and `ProcessStats`; it now exports `processTrackerFor`, `resetProcessTracker` and the `ProcessTracker` type instead.
