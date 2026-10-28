---
'@bugsee/capture': patch
---

A system trace producer instance already owned by another running client is now skipped and reported through `onError` (first owner wins, released on stop) instead of two clients silently starting and stopping the same stateful producer (#58). Caveat: without an `onError` the skip is SILENT, and the second client records none of that producer's traces for its whole session, so supply `onError` (and build a fresh producer set per client) wherever more than one client can run in a process.
