---
'@bugsee/node': minor
'@bugsee/bun': minor
'@bugsee/deno': minor
'@bugsee/electron': minor
'@bugsee/trackers': minor
---

`ram_system_free` now means memory available to new work, as on Android, instead of raw free pages. On Node it is `os.freemem()` (libuv reads `MemAvailable` on Linux and `ullAvailPhys` on Windows); on Bun and Deno it is `MemAvailable` from `/proc/meminfo` on Linux, then `os.freemem()`. On macOS `os.freemem()` still counts only free pages and undercounts reclaimable memory. The value is omitted when no source gives a finite, non-negative number not above total RAM.

The `ram_system_available` trace is removed (it was Node-only and never released in a stable version): `process.availableMemory()` equals `os.freemem()` without a cgroup limit and reads lower inside one, and it is not comparable on Bun and Deno. `@bugsee/trackers/node` drops the `availableMemory` stage and `createAvailableMemoryReader`, and gains `createSystemFreeReader`, `createProcMeminfoReader` and `parseMemAvailable`. `measuresAvailableMemory` now means "`os.freemem()` is memory available to new work" (default `true`; Bun and Deno pass `false`).
