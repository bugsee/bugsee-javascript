---
'@bugsee/browser': minor
'@bugsee/webview': minor
'@bugsee/electron': minor
'@bugsee/bugsee': minor
---

BREAKING (beta) for any consumer of the old names: the shared browser and WebView `events.system` names now follow Android. `orientation_changed` is now `OrientationChanged` with params `{current, prev?, type, angle}` (`current`/`prev` are the Android `orientation` trace values; the event carries no params when the engine cannot read both type and angle), `dark_mode_changed` is now `DarkModeChanged` (`{dark}`), `process_foreground` is now `UIApplicationDidBecomeActiveNotification` and `process_background` is now `UIApplicationDidEnterBackgroundNotification`. `OrientationChanged` is emitted only when the Android orientation value really changes. The Electron renderer and the umbrella re-export the browser capture, so they carry the same change. JavaScript-only events keep their snake_case names. Every event param key across the browser, Node and Electron sources is camelCase (no key needed changing); a conformance test now enforces it.
