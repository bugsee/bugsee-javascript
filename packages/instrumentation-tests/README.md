# @bugsee/instrumentation-tests

Cross-runtime **end-to-end instrumentation harness**. It boots the *real* SDK in a *real* separate
`node` / `bun` / `deno` process — no fakes, real timers, a real outgoing `fetch`, the real V8 CPU
profiler, the real worker-thread hang watchdog — pointed at a local **mock collector**, and asserts the
actual uploaded bundle. This is the layer the in-process unit tests (which run under Node with injected
fakes) cannot reach: it proves the *assembled* SDK runs and produces the right wire output on each
runtime.

```
pnpm test:e2e                                   # from the repo root, or:
pnpm --filter @bugsee/instrumentation-tests test:e2e
```

It is **not** part of `pnpm test` (the root globs `*.test.ts`; these are `*.e2e.ts`) and has no coverage
gate — it spawns processes and is run on demand.

## What runs

One scenario module (`app/scenario.ts`) drives the SDK's public surface; three thin entries inject each
runtime's own launch (`@bugsee/node` / `@bugsee/bun` / `@bugsee/deno`). The runner (`test/`) starts the
mock collector, spawns each entry as a child process, and asserts the captured uploads.

| Runtime | Launched via | Resolves the workspace TS source by |
| --- | --- | --- |
| node | `tsx` (a devDep — the guaranteed target) | tsx's TS loader |
| bun  | `bun` (native TS) | bun's node_modules resolution |
| deno | `deno run -A --node-modules-dir=manual --sloppy-imports` | pnpm's node_modules + sloppy (extensionless) imports |

A runtime whose binary is absent is logged and skipped (so CI without bun/deno still runs the node
suite). bun/deno are probed on `PATH` and at `~/.bun/bin` / `~/.deno/bin`.

### Scenarios asserted per runtime
- **main** (exits 0): console logs → `logs.json`; a captured outgoing `/echo` → `network.json`; a
  `logException` → an **error** bundle; a rolling **V8 CPU profile** → `profile.json`; a deliberate
  event-loop block → an **AppHang** bundle from the real watchdog. Plus: exactly one session carrying
  the runtime's `platform.type` identity.
- **crash** (exits 1): an async throw → `uncaughtException` → the SDK flushes a **crash** bundle then
  `process.exit(1)`.

## The mock collector

`test/collector.ts` implements just enough of the control plane for the SDK's real upload pipeline to
deliver a bundle: `POST /v2/sessions` → access token, `POST /v2/issues` → a signed-PUT endpoint,
`PUT /upload/*` → captures the bundle (zip) bytes, and `GET /echo` → the app's captured outgoing
request. It runs in the runner process; the app reaches it over loopback HTTP, so the captured uploads
*are* the assertion channel (no IPC).

## Maintenance

The assertions encode the real wire contract (`request.json` fields, `source.mechanism` values
`programmatic` / `hang` / `uncaught`, the bundle file set). If the bundle format changes, update
`test/instrumentation.e2e.ts`. The harness is deliberately *teeth-checked*: disabling profiling/ANR in
the scenario makes the corresponding assertions fail (verified during development).
