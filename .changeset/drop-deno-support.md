---
'@bugsee/bugsee': minor
'@bugsee/util': minor
'@bugsee/trackers': minor
---

**Deno is no longer supported.** `@bugsee/deno` is removed (deprecate the published versions on npm; use Node.js, Bun or a browser). The `@bugsee/bugsee` umbrella keeps its `deno` export condition and `./deno` subpath only so that importing it on Deno throws a clear "Deno is no longer supported" error instead of silently resolving the Node build, which misreports the runtime, leaves `Deno.serve` uninstrumented and can freeze the process when local-variable capture is on. `isDeno` is removed from `@bugsee/util` (`isNode()` no longer excludes Deno). `@bugsee/trackers/node` no longer exports `createDenoMemoryReader`, `createDenoExecFile` or `denoVmStatGranted`, and `createVmStatSampler` no longer accepts `canSpawn` (it existed only for Deno's `run` permission). The protocol `RuntimeType` still includes `'deno'` so existing reports stay valid.
