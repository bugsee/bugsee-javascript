---
'@bugsee/trackers': minor
'@bugsee/browser': minor
'@bugsee/webview': minor
---

Cleanup migrations onto the domain trackers.

**Type change in `@bugsee/trackers/browser`:** `ApplicationEvents` (the `ApplicationTracker` stages) no longer has `online` and `offline`, and the tracker no longer binds those window listeners. Subscribe to the `ConnectivityTracker` `online` stage (`connectivityTrackerFor`) instead. `UiTracker` gains a `visualViewport` stage (`UiStages.visualViewport`, `VisualViewportState`, `UiEnv.visualViewport`).

`@bugsee/browser`: the `video.aux` viewport source no longer binds its own `resize`/`visualViewport` listeners; the shared per-window `UiTracker` does (events are unchanged). The `online`/`offline` events come from the `ConnectivityTracker`: only a change of `navigator.onLine` is an event, and `online`/`offline` are bound once per window instead of twice. New `display_mode_changed` system event (`{mode, previousMode?}`, from the UiTracker `displayMode` stage), also emitted by `@bugsee/webview`. `createBrowserSystemEventsSource` accepts optional `connectivity` and `navigator` seams.
