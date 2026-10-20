---
'@bugsee/browser': minor
'@bugsee/webview': minor
'@bugsee/trackers': minor
---

`PageLifecycleTracker` becomes the domain `ApplicationTracker` (`applicationTrackerFor`, `ApplicationEnv`, `ApplicationEvents`, `ApplicationState` exported from `@bugsee/trackers/browser` and re-exported by `@bugsee/browser`). It is a singleton per document (else window), gains an aggregated, de-duplicated `state` stage (`foreground`/`background`) and `current()`, and retains the last known state while no one is subscribed (DOM listeners still attach on the first subscriber and detach on the last). `AppStateProducer` consumes `state`; the `app_state` trace and the `events.system` names and shapes are unchanged. `online`/`offline`/`orientationchange` remain on it until the Connectivity and UI trackers take them.

Two behaviour changes on an UNREADABLE document (missing, non-string or throwing `visibilityState`): the `app_state` trace no longer reports `background`, and no `visibility` is emitted at all, so `process_background` is no longer recorded and the fps sampler is no longer paused on a fabricated hide. The tracker is shared per document, and the latest launch's `onError` is the reporter. An injected window without a document no longer borrows the host document in the events-source fallback.

Behaviour change for standalone `createBrowserSystemEventsSource` callers that pass NO `lifecycle`: the host-global fallback is all-or-nothing. If either `window` or `document` is injected, the other is never taken from the host globals (an injected env must not borrow the host's), so e.g. `{ document }` alone no longer also receives the host window's `pagehide`/`online`/`offline`/`orientationchange` events. Pass both, or neither, to keep full coverage. Browser and webview launch always pass a tracker and are unaffected.
