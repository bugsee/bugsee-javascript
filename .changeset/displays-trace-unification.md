---
'@bugsee/browser': minor
'@bugsee/webview': minor
'@bugsee/electron': minor
'@bugsee/trackers': minor
---

BREAKING (beta): the browser `screen_size` trace and the Electron `electron_displays` trace are retired and replaced by `displays`, the mobile-layout list (a bare array of display objects, snake_case keys).

- Browser: one entry `{id: 0, state: "on", width, height, scale, rotation?}` with `width`/`height` in device pixels (`round(screen.width * devicePixelRatio)`), `scale` the ratio used and `rotation` the screen-orientation angle in quarter turns. Approximate under Chromium page zoom. Not written by WebViews or Electron renderers (the host writes it): new `hostOwnedTraces` browser launch option, set by `launchRenderer` and the WebView launch.
- Electron main: one entry per display (`id` stable per-session index with the primary first, `native_id`, `state` on the primary, `type`, device-pixel `width`/`height`, `natural_width`/`natural_height`, `scale`, `max_fps`, `rotation` in quarter turns).
- `display_added`, `display_removed` and `display_metrics_changed` event params are now the same keys in camelCase: `id`, `nativeId`, `width`, `height`, `naturalWidth`, `naturalHeight`, `scale`, `maxFps`, `rotation`, `type` (plus `changed`). The old `scaleFactor`, `internal` and `refreshRate` params are gone, and `width`/`height` are device pixels rather than DIP.
- `@bugsee/trackers`: the Electron display tracker's `DisplayInfo` has the new shape (`mapDisplay` returns `MappedDisplay`).
