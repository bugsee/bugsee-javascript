---
'@bugsee/browser': minor
'@bugsee/webview': minor
'@bugsee/trackers': patch
---

BREAKING (beta) for any consumer of the old names: the shared browser and WebView `events.system` names now follow Android. `orientation_changed` is now `OrientationChanged` with params `{current, prev?, type, angle}` (`current`/`prev` are the Android `orientation` trace values; the event carries no params when the engine cannot read both type and angle), `dark_mode_changed` is now `DarkModeChanged` (`{dark}`), `process_foreground` is now `UIApplicationDidBecomeActiveNotification` and `process_background` is now `UIApplicationDidEnterBackgroundNotification`. JavaScript-only events keep their snake_case names. Every event param key across the browser, Node and Electron sources is camelCase (no key needed changing); a conformance test now enforces it.
