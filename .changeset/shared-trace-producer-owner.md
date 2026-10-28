---
'@bugsee/capture': patch
---

A system trace producer instance already owned by another running client is now skipped and reported through `onError` (first owner wins, released on stop) instead of two clients silently starting and stopping the same stateful producer (#58).
