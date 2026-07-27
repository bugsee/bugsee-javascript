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

The `*.e2e.ts` suites are **not** part of `pnpm test` (the root globs `*.test.ts`) and have no coverage
gate — they spawn real processes. Since 2026-07-27 they **do run in CI**, in their own `e2e` job with
`bun` and `deno` installed (`.github/workflows/ci.yml`). Before that they were outside the gate
entirely, which the adversarial review root-caused as the reason most of its ~90 SEV1 findings survived
~100% unit coverage (`docs/review/e2e-harnesses.md`).

The one exception is `test/bundle.test.ts` — the unit tests for the shared assertion library below.
Those are `*.test.ts` on purpose, so they run in the fast `pnpm test` gate.

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

## The shared bundle-assertion library (`test/bundle.ts`)

Wave V0 of `docs/review/REMEDIATION-PLAN.md`. The review's central finding about this harness layer was
that it asserted a bundle **arrived** rather than what was **in** it. These helpers exist to close
specific, confirmed defect classes, and each has a **negative** unit test proving it fails on the real
defect — an assertion library that cannot fail is the exact theater being removed.

| Helper | Closes |
| --- | --- |
| `parseBundles(source)` | shared unzip + parse of `request.json`/`manifest.json` (was duplicated per suite) |
| `readJson(bundle, name)` | throws, naming what IS present, so asserting on a never-emitted file fails loudly instead of reading `undefined` |
| `assertBundleIntegrity(bundle)` | manifest ↔ zip agreement. Catches the confirmed core Pass D defect: a recovered crash bundle declared `profile.json` while the zip held only the directory-shaped entry `profile.json/` |
| `assertNoSecrets(bundle, secrets)` | scans **every** entry, binary included, for values that must never ship. Catches the confirmed URL-query-string / body credential leaks. Exempts `apptoken`, which legitimately holds the token |

New suites and the sample apps of Wave V should use these rather than hand-rolling per-file parsing.

## Maintenance

The assertions encode the real wire contract (`request.json` fields, `source.mechanism` values
`programmatic` / `hang` / `uncaught`, the bundle file set). If the bundle format changes, update
`test/instrumentation.e2e.ts`. The harness is deliberately *teeth-checked*: disabling profiling/ANR in
the scenario makes the corresponding assertions fail (verified during development).
