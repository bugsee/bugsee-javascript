---
'@bugsee/node': minor
'@bugsee/bun': minor
'@bugsee/deno': minor
'@bugsee/trackers': minor
---

The opt-in `captureDiskSpace` traces (`disk_mem_free`, `disk_mem_total`) now come from a per-process `StorageTracker` in the `@bugsee/trackers/node` entry, which takes over the statfs read and its poll from `@bugsee/node`. Trace names, integer-MB wire values, the 5 s cadence and the opt-in behaviour are unchanged: the tracker polls only while the producer is subscribed, reports a failing read once per failure streak, and omits an unreadable or unsane reading instead of reporting a zero. The tracker is shared per data directory: launches over the same directory share one (its `onError` and scheduler are latest-launch-wins), launches over different directories each keep polling their own directory and reporting to their own `onError`. `@bugsee/node` (and so `@bugsee/bun` and `@bugsee/deno`, which re-export it) also exports `storageTrackerFor`, `resetStorageTracker` and the `StorageTracker` type.
