---
'@bugsee/core': minor
---

Capture and detection providers are now started and stopped in isolation. A provider whose `start()` throws (for example because a host global is blocked in the page) is reported through `onError`, best-effort stopped so nothing it half-attached leaks, and no longer prevents the providers registered after it from starting; a throwing `stop()` likewise no longer strands the others. `createCaptureCoordinator` and `createDetectionCoordinator` take an optional `onError`, which the client supplies.
