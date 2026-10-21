---
'@bugsee/electron': patch
'@bugsee/trackers': patch
---

Fixes from a real-Electron (44.9.3, macOS) smoke run. `launchMain` now releases its `app` `render-process-gone` listener on `client.stop()` (it used to stay and stack on relaunch; `ElectronAppLike` gains optional `removeListener`/`off`). The main control channel no longer sends to a renderer whose `webContents.isCrashed()` is true (which printed `Render frame was disposed` to stderr) and forgets it on `render-process-gone`; a reloaded webContents rejoins on its next `hello`. `electron_displays` rounds `refresh_rate_hz` and `scale_factor` to 2 decimals. Doc comments now record the verified `getAppMetrics`, `child-process-gone` and `getGPUInfo` behaviour.
