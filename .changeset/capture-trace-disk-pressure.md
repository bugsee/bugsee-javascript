---
'@bugsee/core': minor
'@bugsee/capture': minor
'@bugsee/protocol': minor
'@bugsee/trackers': minor
'@bugsee/browser-utils': minor
'@bugsee/browser': minor
'@bugsee/node': minor
'@bugsee/electron': minor
---

New `capture` system trace and disk-pressure protection for the capture stores, behind one opt-in `captureDiskSpace` option (canonical key `com.bugsee.option.capture.disk-space`, now shared by the browser and the Node family; the node-only `com.bugsee.option.node.capture-disk-space` key is gone, the friendly name is unchanged). With it on, the SDK reads free space (Node, Bun, Deno, Electron main: `statfs` of the data directory every 5 s; browser: `navigator.storage.estimate()` headroom every 5 minutes, every 30 s under 500 MB) and, under 50 MB free, stops persisting replay, log and network data, and under 10 MB persists nothing, keeping the in-memory window so a report built from the live process stays complete (a crash loses what was never written). A state is left only 10 MB above its threshold; a hostile or missing reading never changes the state; a write failing with `QuotaExceededError` / `ENOSPC` moves to out-of-space at once. The `capture` trace (`{state}`: `active`, `blackout`, `low_disk_space`, `no_disk_space`) is written by the browser while rrweb replay runs and by Electron main with pixel video; never by Node, Bun, Deno, WebViews or Electron renderers (the latter now report `capture` as host-owned). New `@bugsee/core` exports: `createDiskPressure`, `withDiskPressure`, `DiskPressureToken`, `isOutOfSpaceError`, the threshold constants, and a `diskPressure` option on `createChunkCaptureStore` / `createFileCaptureStore` / `createIdbChunkCaptureStore`.
