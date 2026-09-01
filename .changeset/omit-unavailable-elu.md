---
'@bugsee/node': minor
---

Event-loop utilization is now omitted on runtimes that cannot measure it, instead of reported as 0%.

`performance.eventLoopUtilization()` exists on Bun and Deno and does not throw — it simply answers
`{idle: 0, active: 0, utilization: 0}` for ever. The SDK's guard only caught *throws*, so every sample
carried a confident 0%, which reads exactly like a perfectly healthy idle process to whoever opens the
report. Measured after a 120 ms CPU burn plus a 60 ms sleep:

```
node  {"idle":61.0,"active":0.118,"utilization":0.0019}
bun   {"idle":0,"active":0,"utilization":0}
deno  {"idle":0,"active":0,"utilization":0}
```

The `event_loop_utilization` trace is now absent on Bun and Deno and unchanged on Node. The
discriminator is `idle`, not `utilization`: idle accumulates wall-clock time between samples on any
honest implementation, so it cannot be zero at the sampler's 1 s cadence — while a process that
genuinely did nothing reports utilization 0 with a non-zero idle, and that reading is true and kept.

Every other event-loop metric is unaffected on all runtimes.
