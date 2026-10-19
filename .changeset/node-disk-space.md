---
'@bugsee/node': minor
'@bugsee/bun': minor
'@bugsee/deno': minor
---

New opt-in `captureDiskSpace` option: reports `disk_mem_free` and `disk_mem_total` (integer binary MB, Android parity) in `traces.system` for the filesystem the SDK's data directory lives on, polled every 5 s off the event loop (not held, so a failing statfs leaves a gap rather than a stale value). It is omitted when there is no data directory (in-memory or degraded launch) rather than falling back to `/` or the working directory, and when a reading is not sane rather than reported as 0. Default off.
