---
'@bugsee/trackers': patch
'@bugsee/node': patch
---

Zero versus omit on the Node family: a non-finite `event_loop_lag_*` histogram field is now omitted (that one trace is not written) instead of written as `0`, and `cpu_usage_process` is omitted on a zero-length wall window instead of `0`. `ProcessEvents.cpu.processPct` and the `eventLoop` fields are now optional; `cpu_usage_user` / `cpu_usage_system` still carry the real deltas.
