---
'@bugsee/trackers': minor
'@bugsee/node': minor
'@bugsee/bun': minor
'@bugsee/deno': minor
'@bugsee/electron': minor
---

Zero versus omit on the Node family: a non-finite `event_loop_lag_*` histogram field is now omitted (that one trace is not written) instead of written as `0`, and `cpu_usage_process` is omitted on a zero-length or backwards wall window instead of `0`. Exported types change: `ProcessEvents.cpu.processPct` and the `ProcessEvents.eventLoop` fields are now optional, and `EventLoopSource.read` may return partial fields. `cpu_usage_user` / `cpu_usage_system` still carry the real deltas.
