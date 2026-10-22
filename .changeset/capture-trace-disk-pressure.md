---
'@bugsee/core': minor
'@bugsee/capture': minor
'@bugsee/protocol': minor
'@bugsee/trackers': minor
'@bugsee/replay': minor
'@bugsee/browser-utils': minor
'@bugsee/node-utils': minor
'@bugsee/browser': minor
'@bugsee/node': minor
'@bugsee/electron': minor
---

Disk-pressure protection for the capture stores, on by default where a durable store exists (as on iOS), and a new `capture` system trace. Below 50 MiB free the on-disk (Node, Bun, Deno, Electron main: `statfs` of the data directory every 5 s) or IndexedDB (browser: `navigator.storage.estimate()` headroom, every 5 minutes, every 30 s under 500 MiB) store stops persisting replay, log and network data; below 10 MiB it persists nothing but a tiny `capture` state entry. The in-memory window is kept either way, so a report built from the live process stays complete and only a crash loses what was never written. A state is left only 10 MiB above its threshold; a hostile or missing reading never changes the state; a write failing with `QuotaExceededError` / `ENOSPC` pins out-of-space until a durable write succeeds again (not until a size reading looks healthy). `diskProtection: false` opts out. The opt-in `captureDiskSpace` option (canonical key `com.bugsee.option.capture.disk-space`, now shared by the browser and the Node family; the node-only key is gone, the friendly name is unchanged) is only the telemetry: the `capture` trace's `low_disk_space` / `no_disk_space` states and, on Node, `disk_mem_free` / `disk_mem_total`. The `capture` trace (`{state}`: `active`, `blackout`, `low_disk_space`, `no_disk_space`) is written by the browser while its rrweb recorder runs and by Electron main while pixel video runs; never by Node, Bun, Deno, WebViews, Electron renderers or a launch with `replay: false`. Fixes in the batched fs writer: `read()` includes the buffered tail of a failed flush and a chunk seal no longer drops it; the off-thread ring writer reports drain failures instead of swallowing them; a `statfs` that hangs is abandoned after 5 s. `@bugsee/replay` recorders gain `checkout()` (a fresh full snapshot, used when persistence resumes). New `@bugsee/core` exports: `createDiskPressure`, `withDiskPressure`, `DiskPressureToken`, `isOutOfSpaceError`, the threshold constants, and `diskPressure` / `onDiskWriteError` options on the chunk, file and IndexedDB stores.
