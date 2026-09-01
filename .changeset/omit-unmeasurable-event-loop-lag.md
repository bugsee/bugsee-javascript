---
'@bugsee/node': minor
'@bugsee/deno': minor
---

Event-loop lag traces are now omitted on Deno, instead of reporting a healthy loop through a freeze.

`monitorEventLoopDelay()` exists on Deno, answers, and never throws — it simply never registers a
blocked loop. Measured with the histogram sampling an idle loop first, then a real 150 ms synchronous
block:

```
node  idle floor 11.067ms -> 160.956ms   (sees it)
bun   idle floor  1.016ms -> 146.634ms   (sees it)
deno  idle floor  0.022ms ->   0.065ms   (blind)
```

Reporting 0.065 ms of lag through a 150 ms freeze is the same class of wrong answer as a fabricated 0%
utilization: ~0 ms of lag is exactly what a healthy process reports. Unlike ELU there is no passive tell
— a zero `idle` gives ELU away, whereas Deno's histogram returns plausible small numbers — so the
composition root that knows the runtime declares it: `@bugsee/deno` passes `measuresEventLoopDelay:
false` and `event_loop_lag_ms`, `event_loop_lag_max_ms` and `event_loop_lag_p99_ms` are absent there.

Node and Bun are unaffected; both measure correctly. The same reader also now omits rather than zeroes
when `monitorEventLoopDelay` throws outright (partial `perf_hooks`). Every other system metric is
unchanged on all runtimes, and ANR detection never used this mechanism — it polls a SharedArrayBuffer
heartbeat from a worker thread.
