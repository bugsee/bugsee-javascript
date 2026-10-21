---
'@bugsee/trackers': minor
'@bugsee/browser': minor
'@bugsee/webview': minor
---

Cleanup migrations onto the domain trackers.

**Type change in `@bugsee/trackers/browser`, and therefore in `@bugsee/browser`'s public types:** `ApplicationEvents` (the `ApplicationTracker` stages) no longer has `online` and `offline`, and the tracker no longer binds those window listeners. `@bugsee/browser` re-exports `type ApplicationEvents`, so its exported type changes too. Subscribe to the `ConnectivityTracker` instead (`connectivityTrackerFor`): the new `transition` stage (`{online}`) is one notification per DOM `online`/`offline` event, its kind taken from the event type, with no baseline; the `online`/`state` stages are unchanged. The `ConnectivityTracker` now reads the navigator and watches `navigator.connection` only while one of `online`/`networkInfo`/`state` has a listener.

`UiTracker` gains a `visualViewport` stage (`UiStages.visualViewport`, `VisualViewportState`, `UiEnv.visualViewport`, defaulting to `window.visualViewport`).

`@bugsee/browser`: the `video.aux` viewport source no longer binds its own `resize`/`visualViewport` listeners; the shared per-window `UiTracker` does, and the events it writes are unchanged. One caveat: it relies on the tracker's `screenSize` stage to notice a density-only change (a window moved to a monitor with another `devicePixelRatio`, same inner size), which needs a readable window `screen`; without one that change is not noticed. `online`/`offline` events keep their meaning (one `events.system` entry per DOM event) but are now bound once per window instead of twice. New `display_mode_changed` system event (`{mode, previousMode?}`, from the UiTracker `displayMode` stage), also emitted by `@bugsee/webview`. `createBrowserSystemEventsSource` accepts optional `connectivity`, `navigator` and `ui` seams.
