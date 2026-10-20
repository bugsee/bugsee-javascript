---
'@bugsee/electron': minor
'@bugsee/trackers': minor
'@bugsee/node': minor
---

Electron main now reports per-process CPU and memory and child-process crashes. The `app_metrics` system trace (`{ processes: [{ type, pid, cpu_percent?, working_set_mb?, peak_working_set_mb?, private_mb? }] }`; `cpu_percent` is the share of the whole machine and is omitted on a process's first appearance; polled from `app.getAppMetrics()` when the `app` passed to `launchMain` has it; fields Electron does not supply are omitted) is emitted next to the existing node traces, and a `child_process_gone` system event (`{ type, reason, exitCode?, name? }`) is recorded when a GPU or utility process dies, only while `captureSystemEvents` is on. Both come from a new per-`app` `ElectronProcessTracker` in `@bugsee/trackers/electron`, which also takes over the `app.getGPUInfo` read behind `environment.hardware.gpu`: same `hardware.gpu` output, but a later launch now asks again when the earlier read failed or a different `gpuInfoType` is requested. `@bugsee/node` gains the advanced `wrapSystemEventsSource` launch option, which lets a platform mux extra events into the single `events.system` provider.
