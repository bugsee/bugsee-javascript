---
'@bugsee/node': minor
'@bugsee/bun': minor
'@bugsee/deno': minor
'@bugsee/electron': minor
'@bugsee/trackers': minor
---

`ram_system_free` now means memory available to new work, in bytes as on Android (`availMem`), instead of raw free pages. Sources: Electron `process.getSystemMemoryInfo()` (macOS free + fileBacked + purgeable, Linux `available`, Windows `free`), Deno `systemMemoryInfo().available` on macOS, `/proc/meminfo` `MemAvailable` on Bun, then `os.freemem()` (libuv `MemAvailable` on Linux, `ullAvailPhys` on Windows). Node and Bun on macOS read it from a rare async `vm_stat` call (see the vm_stat changeset), because `os.freemem()` there is free pages only. The value is omitted when no source gives a finite, non-negative number not above total RAM. Inside a container it is the host's figure; the cap is `process_memory_limit`.

The `ram_system_available` trace is removed (it was Node-only and never released): `process.availableMemory()` equals `os.freemem()` without a cgroup limit and reads lower inside one, and it is not comparable on Bun and Deno. `@bugsee/trackers/node` drops the `availableMemory` stage and `createAvailableMemoryReader`, and gains `createProcMeminfoReader` and `parseMemAvailable`. The `measuresAvailableMemory` option is replaced by `readsProcMeminfo` (default `false`; only Bun sets it), and `createSystemFreeReader`, `createElectronMemoryReader`, `createDenoMemoryReader` and `firstAnswer` are exported.
