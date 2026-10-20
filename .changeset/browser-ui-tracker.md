---
'@bugsee/browser': minor
'@bugsee/webview': minor
'@bugsee/trackers': minor
---

Browser and WebView `orientation`, `screen_size` and `fps` traces and the `orientation_changed` / `dark_mode_changed` events are now fed by one per-window singleton `UiTracker` (new in `@bugsee/trackers/browser`), which also exposes `viewport`, `colorScheme`, `reducedMotion` and `displayMode` stages. Trace and event names and wire shapes are unchanged. `orientation_changed` is now de-duplicated (one event per real orientation change) and also fires when only `screen.orientation` emits `change`. In `@bugsee/trackers`, `ApplicationEvents` loses its `orientationchange` key (a type change: the UiTracker owns it) and the emitter base gains `listenerCount` and an `onListenersChanged` hook.
