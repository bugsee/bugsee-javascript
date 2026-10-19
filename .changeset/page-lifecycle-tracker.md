---
'@bugsee/browser': minor
'@bugsee/webview': minor
---

The browser and webview launches now bind the window and document lifecycle listeners once, in a shared `PageLifecycleTracker` (exported from `@bugsee/browser`). The system-events source, the connection trace and the orientation trace subscribe to it instead of each attaching their own `online`/`offline`/`orientationchange` listeners.

`createBrowserSystemEventsSource` and `createBrowserSystemTraceProducers` accept an optional `lifecycle` to share one; without it they behave as before. The browser launch now also passes the document, so `process_foreground` / `process_background` events are captured there too.
