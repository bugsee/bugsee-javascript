---
'@bugsee/core': minor
---

Capture and detection providers are now started and stopped in isolation. A provider whose `start()` throws (for example because a host global is blocked in the page), or whose option gate throws, is reported through `onError` and best-effort stopped so it can release whatever state it recorded; it no longer prevents the providers registered after it from starting, and a throwing `stop()` no longer strands the others. A reporter that stops the client mid-launch now ends the launch cleanly: no further providers start and no tick timer is left running. `createCaptureCoordinator` and `createDetectionCoordinator` take an optional `onError`, which the client supplies.
