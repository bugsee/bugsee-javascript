---
'@bugsee/browser': minor
'@bugsee/webview': minor
---

Browser system traces (heap, connection, orientation) now come from trackers and producers, and `createBrowserSystemTracesSampler` / `BrowserTracesEnv` are removed.

Import `createBrowserSystemTraceProducers` (and `defaultBrowserTraceEnv`) instead. Trace names and wire values are unchanged, with these differences:

- A `systemMetricsSampler` still replaces the heap, connection and orientation traces; battery always runs.
- `connection`, `orientation` and `ram_system_advertised` are emitted when they change (and kept alive by the provider's refresh) instead of on every tick.
- On a real browser the old sampler copied `navigator` with a spread, which dropped `onLine`, `connection` and `deviceMemory`; those are now read live, so real values are reported.
