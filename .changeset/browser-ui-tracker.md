---
'@bugsee/browser': minor
'@bugsee/webview': minor
'@bugsee/trackers': minor
---

Browser and WebView `orientation`, `screen_size` and `fps` traces and the `orientation_changed` / `dark_mode_changed` events are now fed by one per-window singleton `UiTracker` (new in `@bugsee/trackers/browser`), which also exposes `viewport`, `colorScheme`, `reducedMotion` and `displayMode` stages. Trace and event names and wire shapes are unchanged. `orientation_changed` is now de-duplicated: one event per real orientation change. `@bugsee/trackers` gains `listenerCount` and an `onListenersChanged` hook on its emitter base.
