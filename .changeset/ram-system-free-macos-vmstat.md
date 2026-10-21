---
'@bugsee/trackers': minor
'@bugsee/node': minor
'@bugsee/bun': minor
'@bugsee/deno': minor
---

`ram_system_free` is now reported on macOS for Node and Bun (and as the fallback on Deno when `Deno.systemMemoryInfo()` is unavailable). It reads `/usr/bin/vm_stat` asynchronously at most once per 10 seconds, and only while the system-memory stage has a listener. The value is (Pages free + File-backed pages + Pages purgeable) times the page size, the same definition as Electron's `getSystemMemoryInfo` on macOS, so Electron, Node and Bun agree. The spawn uses the absolute path with no shell or arguments, a 2 s timeout and a small output cap. It never overlaps, serves a value for at most two intervals before omitting, and any failure omits the trace and is reported once per failure streak through `onError`. The child is killed when the stage loses its last listener. `@bugsee/trackers/node` gains `createVmStatSampler` and `parseVmStat`, and `ProcessEnv` gains `readsVmStat` (default `true`; `false` opts out), `vmStat` and `vmStatExecFile`.
