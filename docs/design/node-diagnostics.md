# Node diagnostics — CPU profiling + ANR / event-loop-block detection

Status: **DESIGNED (2026-06-14), build in progress.** Closes the two "in-depth" gaps vs Sentry on
Node/Bun (we lead on network-body capture + durable crash delivery; profiling + ANR were the real
diagnostic gaps). Build these before going "in-breadth" (framework adapters / more runtimes).

## Why these two, and why together

A competitive pass (Sentry `@node`/`@bun`, Bugsnag-node, Google Cloud Error Reporting; Firebase
Crashlytics is mobile-only) put our Node/Bun gaps at: CPU profiling, ANR/event-loop-block stack capture,
framework adapters, source-map tooling. CPU profiling and ANR **compose**: V8's sampling profiler runs on
its own thread, so it **keeps sampling during a synchronous event-loop block** → the CPU profile pinpoints
the blocking frames. So ANR detection fires the report and the CPU profile in that same bundle *is* the
blocking-stack mechanism — no fragile worker↔inspector `Debugger.pause` protocol needed.

## Benchmark (Apple M4 Pro, ~400 ms runs, min-of-21, drift-corrected; `/tmp/anr-bench/bench.mjs`)

| Condition | Node 24 CPU ovh | Node mem | Bun 1.3 CPU ovh | Bun mem |
| --- | --- | --- | --- | --- |
| Detection (worker + SAB heartbeat) | ~0% | +12.5 MB | ~0% | +4.9 MB |
| CPU profile @1 ms | <1% | ~0.05 MB gz / 60 s | <1% | ~0.09 MB gz / 60 s |
| CPU profile @10 ms | <1% | — | <1% | — |
| CPU profile @100 µs | +3.5–4.7% | — | +7.3% | — |
| `Debugger.enable` attached (live-stack path) | ~0% | — | **UNSUPPORTED** | — |

**Findings:** (1) detection is effectively free — cost is just the worker isolate's RSS (~12 MB Node /
~5 MB Bun); (2) CPU profiling @1 ms is sub-1% on M-series (cheaper than the 1–5% rule of thumb), @100 µs is
the only costly rate; (3) a 60 s profile is ~0.05 MB gzipped — negligible on the wire; (4) bare
`Debugger.enable` is ~0% steady-state on modern V8 (the live-stack path's cost is complexity, not
throughput); (5) **the decisive fact — Bun supports the inspector `Profiler` but NOT the `Debugger`
domain**, so CPU profiling works on both runtimes while a live-inspector ANR stack would be Node-only.

## Decision log

- **Profile-based ANR stack, both runtimes** (chosen over a Node-only live-inspector stack). The benchmark
  shows the two are equivalent on steady-state overhead; the differentiator is that profile-based works on
  Node AND Bun and avoids the cross-thread Debugger protocol. The precise live-inspector stack is a possible
  Node-only refinement later (Bun would fall back to profile-based anyway).
- **Placement: both in `@bugsee/node`** (deeply runtime-specific: `node:inspector`, `worker_threads`),
  beside the existing crash detection providers. Bun inherits via reuse, **capability-guarded** (degrade to
  no-op where Bun lacks an API — same pattern as our guarded perf_hooks sampler). Not a new package (YAGNI).
- **ANR detection: default ON** — the benchmark shows it is ~free (the worker heartbeat adds 0% CPU); a
  better OOTB experience than Android (which defaults its hang detector off for mobile-battery reasons).
- **CPU profiling: opt-in** (`profiling` off by default) — even though @1 ms is <1%, profiling is the kind
  of thing teams opt into; default-off matches Sentry's `profilesSampleRate=0`. Sampling interval
  configurable (default 1 ms).
- **Android-canonical for ANR** (`BugseeDetectionHang`): escalating thresholds **Fair 3000 / Medium 5000 /
  Severe 10000 ms**, domains `AppHang::Fair|Medium|Severe`, reported as an **Error** ("Main thread hang
  detected"), per-session dedup on (call-site, domain). No new issue/trigger type — the domain is a string
  attribute. Option `com.bugsee.option.detect.hang` + three `.level.*` int thresholds.
- **CPU profile = a new `profile` bundle file** (`profile.json`), the bare V8 `.cpuprofile` object (directly
  loadable in DevTools / speedscope). Captured at report time via the existing at-report snapshot pull-seam
  (same mechanism as the viewtree DOM snapshot); the live profile is rolling-bounded to the recording window.

## Feature 1 — CPU profiling (Node + Bun)

- `createCpuProfiler({ session?, samplingIntervalMicros? })` over `node:inspector` `Session`:
  `Profiler.enable` → `Profiler.setSamplingInterval` → `Profiler.start` / `Profiler.stop` (returns the V8
  Profile). Capability-guarded: if `Session`/`Profiler` is unavailable, every method no-ops and `stop()`
  returns `undefined`. Injectable `session` for deterministic tests (a fake post() router).
- A profiler controller + at-report snapshot source: at report, `stop()` the current segment, hand it back
  as a `profile` snapshot, then `start()` the next. A rolling restart timer (every `maxRecordingTime`) keeps
  the live profile bounded so a long-running process never accumulates an unbounded profile.
- Gated by `profiling` (default off). Wired in `node/launch.ts`. Bun: the Profiler works (benchmarked).

## Feature 2 — ANR / event-loop-block detection (Android-canonical hang)

- `createEventLoopWatchdog({ thresholdsMs, onHang, clock?, workerFactory? })`: spawns a watchdog worker;
  the main thread writes `Atomics.store(sab, BigInt(now))` on a ~heartbeat timer; the worker polls the SAB
  and, when `now - last ≥ threshold`, reports the stall + level back. A blocked loop simply stops updating
  the SAB → the worker sees staleness (the robust part). Injectable worker/clock/timer for tests.
- `createHangDetectionProvider(...)` wraps it as a `DetectionProvider`: on a stall ≥ a level threshold →
  `createErrorReport({ mechanism: 'anr', summary: 'Main thread hang detected' })` with `domain` =
  `AppHang::{Fair|Medium|Severe}` + the stall duration as attributes; per-session dedup. The blocking stack
  comes from the CPU profile in the bundle (when profiling is enabled). Gated by `detectHang` (default ON).
- Capability-guarded for Bun (worker_threads + SharedArrayBuffer are supported on Bun — benchmarked).

## Slice plan (each: test-first → mutator loop → multi-agent review → commit)

1. **P1 — protocol `profile` FileType.** `'profile'` in the `FileType` union + `DEFAULT_FILENAMES.profile`;
   assembler serializes `profile` as the bare object (`payloads[0]`), like the `performance` special-case.
2. **C1 — CPU profiler controller** (`@bugsee/node`): `createCpuProfiler` over an injectable inspector
   Session; capability-guarded; fake-session tests.
3. **C2 — CPU profile at-report integration**: rolling profiler + the at-report snapshot pull-seam →
   `profile.json`; `profiling` option; node launch wiring.
4. **A1 — event-loop watchdog primitive** (`@bugsee/node`): worker + SAB heartbeat with injectable seams.
5. **A2 — hang detection provider**: Android-canonical thresholds/domains/dedup → Error report; `detectHang`
   option (default on); node launch wiring.
6. **B — Bun verification + guards**: confirm profiler + watchdog work under Bun; capability guards; reuse
   tests.

## Deferred
- **Node-only live-inspector ANR stack** (worker → `Debugger.pause` → `callFrames`): a precise single
  blocked stack on Node; Bun keeps the profile-based stack. Only if the profile-based stack proves
  insufficient.
- **Main-thread-misuse** (sync I/O on the loop) and **frozen-UI** (browser): Android has these as siblings
  of hang; out of scope for the Node v1.
- **Continuous profiling product** (always-on, server-side aggregation) — v1 is incident-bundle-scoped.
