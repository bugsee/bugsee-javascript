---
'@bugsee/electron': minor
'@bugsee/trackers': minor
---

Electron main now records power, display and window telemetry when the matching Electron object is passed to `launchMain` (`powerMonitor`, `screen`, and `BrowserWindow` next to `app`; an absent one turns that domain off). On `events.system`: `power_suspend`, `power_resume`, `power_lock`, `power_unlock`, `power_ac`, `power_battery`; `display_added`, `display_removed` and `display_metrics_changed`; `window_focus`, `window_blur`, `window_show`, `window_hide` (`{ windowId }`) and `renderer_unresponsive` / `renderer_responsive` (`{ webContentsId }`, listened for on `webContents` only so a hang is never recorded twice). The `electron_displays` system trace (`{ displays: [{ id, width, height, scale_factor?, rotation?, internal?, refresh_rate_hz? }] }`, JS-specific name) is written when the display list changes. Listeners attach only while `captureSystemEvents` / system traces are on and are removed by `client.stop()`. They come from three new per-object domain trackers in `@bugsee/trackers/electron`: `ElectronPowerTracker`, `ElectronDisplayTracker` and `ElectronApplicationTracker`.
