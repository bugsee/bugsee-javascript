# angular-spa — Bugsee Expenses

A working Angular expense-report app built to exercise `@bugsee/angular` — see
`docs/samples/PLAN.md` §5.6 for the plan this sample was built against.

## Run it

```bash
cd samples/angular-spa
cp .env.example .env      # then paste the SANGULAR app token (see "Staging app" below) — .env is gitignored, never commit it
pnpm install
pnpm dev                  # local API on :5336 + Angular dev server on :5306
```

Open http://localhost:5306. `pnpm dev` runs both the local API (`server/api-server.mjs`, port 5336)
and the Angular CLI dev server (`ng serve`, port 5306) together via `concurrently`; `pnpm dev:api` /
`pnpm dev:app` run them separately. Both scripts first run `scripts/generate-environment.mjs`, which
writes the gitignored `src/environments/environment.ts` from `.env` (Angular has no built-in `.env`
support, unlike Vite's `import.meta.env` used by the other web samples — see "How the token reaches the
client" below).

**Production build + preview** (single port, API + built app served by one process):

```bash
pnpm build                # ng build (production) — see F-1 in FINDINGS.md for the externalDependencies
                           # workaround this needed
pnpm preview              # serves dist/angular-spa/browser + /api on :5306, one process
```

> **`dist/` staleness — checked, and it does not matter.** The `dist/` tree currently on disk was built
> before the round-2/round-3 source edits, so it does NOT contain them. That is harmless, for two
> reasons: `dist/` is **gitignored** (`.gitignore`), so it is a local artifact and nothing is committed
> from it; and `pnpm verify` drives `http://localhost:5306` served by **`ng serve`** (`pnpm dev`), never
> the built output — `pnpm preview` is the only consumer of `dist/`, and it rebuilds via `pnpm build`.
> The one thing to avoid is running `pnpm preview` and `pnpm verify` together without a fresh
> `pnpm build`: that WOULD verify a stale bundle, and nothing in the harness would tell you.

> **Caveat (F-3 in FINDINGS.md):** the `externalDependencies` workaround above turns a BUILD-time error
> into a SILENT RUNTIME one. `dist/angular-spa/browser/chunk-*.js` ships a literal `import("crypto")`
> that is only ever reached when `crypto.subtle` is absent from the global — i.e. **any non-secure
> browsing context**: plain `http://` on a LAN host, an internal admin tool, a staging box without TLS
> terminated in front of it. In that situation the dynamic import resolves against nothing (no bundler
> shipped a `node:crypto` shim into the browser bundle — it was marked EXTERNAL, meaning "the runtime
> will provide this," and no browser runtime does), so the SDK's upload checksum (`sha256Hex`,
> `packages/core/src/upload-pipeline.ts:77`) throws/rejects and every upload that needs it silently
> fails. Deploy this app (or any app built the same way) behind HTTPS.

**Scenario sweep:**

```bash
pnpm verify
```

Drives the app + every Scenario-panel control headlessly via Playwright and prints a pass/fail table
(LOCAL/WIRE level — see `scenarios.md` for the backend/MCP verification done by hand against the
results). **Requires `pnpm dev` running in another terminal first.** Latest full run against staging:
**70/70** (the round-7 pass split `s11-replay-restore` into `s11-replay-optout` + `s11-replay-default-on`
and added `s7-sendbeacon-wire` and `wire-upload-status`; round 6 had added `s4-options-wire` and
`s11-replay-masking-wire`; round 5 `s7-no-content-type-wire`). It takes several minutes — the post-storm quiet wait alone has run 80-97s across recent sweeps, deliberately (see
FINDINGS.md F-6: cutting that wait short is what made an earlier revision misread a correct
`flush() -> false` as an SDK defect).

## What the app does

**Bugsee Expenses** is a small expense-report app: an expenses list, a reactive form (with field-level
and cross-field validators) to submit a new expense with a receipt **file attachment** (read client-side
via `FileReader`, stored and downloadable from the expense's detail page), an **approval flow** behind a
**lazy-loaded** `/approvals` feature (its own chunk, fetched only on first visit) gated by a **route
guard** (`managerGuard`) that redirects a non-manager back to `/expenses` with a banner, a live "expense
activity" feed over a real WebSocket, and a Settings page (display name → `setUserIdentifier`, custom
attributes, a masking-target "personal access token" field). A dedicated `/scenarios` route is the SDK
**Scenario panel** — one control per scenario in `docs/samples/PLAN.md` §4, plus every
`@bugsee/angular`-specific API (`BugseeErrorHandler`, `createAngularErrorHandler`, `reportAngularError`,
the `ngOriginalError` unwrap path, `createBugseeRenderTracker`, `routePatternFromSnapshot`,
`setRouteNameFromRouter`) and a set of fixtures for an error thrown in a component, in a service, inside
an RxJS pipeline, and inside an `HttpClient` call.

The app's real CRUD (`core/expense.service.ts`) goes through Angular's `HttpClient` with the **default
XHR backend** (`provideHttpClient()` — deliberately **not** `withFetch()`, see `app.config.ts`) — a
different network-capture code path from the raw `fetch`/XHR/SSE controls in the Scenario panel, and
confirmed distinctly captured (issue `SANGULAR-7`, a `Handled HttpErrorResponse`, see `scenarios.md`).

## Staging app

- App key: **`SANGULAR`**
- App id: **`6a8ebe5bd58badbb348fbecd`**
- Type: `javascript`, subtype `angular`
- Endpoint: `https://apidev.bugsee.com` (staging — never production)

## Ports

- `5306` — Angular CLI dev/preview server (assigned to this sample; wave 1 used 5301-5305)
- `5336` — the local API (`server/api-server.mjs`)

## How the token reaches the client

Angular's `application` builder (esbuild-based, what `ng build`/`ng serve` use since Angular 17) has no
built-in equivalent of Vite's `loadEnv` + `define`. Instead, `scripts/generate-environment.mjs` reads
`.env` and writes the gitignored `src/environments/environment.ts` (a committed `environment.example.ts`
documents the shape) — run as a `pnpm dev:app` / `pnpm build` prefix step, Angular's own established
convention for environment-specific values, just driven from `.env` instead of being hand-edited and
committed. `scripts/bump-build-counter.mjs` increments a `.build-counter` file (gitignored) before every
production build so `appBuild` is identifiable in the dashboard; the dev server always uses `appBuild:
"dev"`.

## Session replay is ON by default

Worth knowing before reading anything else about S11: the browser tier records unless you pass
`replay: false` (`packages/browser/src/launch.ts:433` — `options.replay !== false && domDocument !==
undefined`). This app's own `FULL_LAUNCH_OPTIONS` carries no `replay` key, so **every bundle it uploads
contains `replay.bin`**, from the very first launch, not only after an S11 control is clicked. The S11
controls change the replay CONFIGURATION; the only one whose effect is visible in the uploaded bundle is
`replay: false`. Anything in this repo's history describing the S11 relaunch as "what turns replay on" —
or a bundle without `replay.bin` as the normal case — predates the flip and is wrong.

## Scenario coverage

See `scenarios.md` for the full table (every scenario id → control → expected Bugsee content →
verified/unverified with evidence — issue keys `SANGULAR-1` through `SANGULAR-206` across the original
build's runs and the six fix/re-verification passes' re-runs; the round-7 (current) range is
`SANGULAR-188`..`SANGULAR-206`. See `scenarios.md`'s header for which keys are current and which are
reviewer probes rather than sweep output.

## Findings

See `FINDINGS.md` for the full write-ups. Headlines:

- **F-1** — `packages/util/src/sha256.ts:31`'s `import('node:crypto')` Node fallback is guarded ONLY by
  bundler-specific ignore comments (`webpackIgnore`/`turbopackIgnore`/`@vite-ignore`), and esbuild
  understands **none** of them — it statically resolves and fails on this import under any
  `platform: 'browser'` target, **regardless of whether the specifier is spelled `crypto` or
  `node:crypto`** (measured directly: both fail identically against this repo's own esbuild). This
  breaks `ng build` (Angular CLI's `application` builder is esbuild-based) for any consumer of
  `@bugsee/core`. Worked around here via `"externalDependencies": ["crypto", "node:crypto"]` in
  `angular.json`; not fixed at the source since this sample does not touch `packages/`. *(An earlier
  draft of this finding incorrectly blamed a `node:`-prefix-stripping bug — corrected in FINDINGS.md.)*
- **F-3** — that same `externalDependencies` workaround converts the BUILD failure above into a SILENT
  RUNTIME one: see the caveat in "Run it" above — any non-secure-context deployment can silently fail to
  upload.
- **F-2** — a separate, ~30× wider `node:`-prefix-stripping defect DOES exist, just not where F-1
  originally placed it: `tsup`'s `removeNodeProtocol` defaults to `true` and every package's
  `tsup.config.base.ts` never overrides it, so 149 `node:`-prefixed imports across `packages/*/src` ship
  bare in `dist/`. Not exercised by this sample directly (highest-priority blast radius is
  `@bugsee/cloudflare`/`@bugsee/deno`, not this Angular app) — recorded for the orchestrator.
- **F-4 / F-5 / F-6** — a session-persistence race (S12), a chained-`Error#cause` message-loss gap
  (S4), and a `client.flush()` that can resolve **`true` while launch-time dead-sibling recovery is still
  running**, because `packages/browser/src/launch.ts:516` starts it as `void coexistence.recoverDeadSiblings(...)`
  — fire-and-forget, tracked by nothing that `drainPending` awaits (S1). *(F-6 has been restated TWICE.
  It first recorded a `flush(timeout) -> false` as the defect — a misreading of this sample's own
  harness, retracted. It then headlined "`true` with up to 200 bundles still queued"; that symptom is not
  reachable through `client.flush()` either — every non-report enqueue site is a sequential `await` in a
  loop, and the report path is covered by `drainPending`'s outer await over `pendingReports`. The
  untracked recovery promise is what actually remains. Severity is now **minor**: no data is lost, only
  the answer is wrong.)* See FINDINGS.md for all three.
- **F-8** — `.bugsee-unmask` on an `<input>` is honoured only when rrweb SERIALIZES the element into a
  full snapshot; a value **typed while the recorder is already running** comes back masked regardless of
  the mark. **Confirmed in round 7** — and only confirmable then: replay now records from the primary
  launch, so incremental input events exist throughout the sweep, which is exactly what made the
  experiment possible (before the flip the fixtures were typed before any recorder existed). Confirmed
  independently by `samples/svelte-spa` in the same round. It lives in the rrweb fork
  (`github:bugsee/rrweb#bugsee-dist`), NOT in `packages/replay`'s masking config, and it **fails
  closed** — more masking than asked for, never a leak. Not fixed here (cross-repo, and `packages/` is
  out of scope for a sample).
- **F-9** — a HARNESS defect, found and fixed in round 7: every "the UPLOADED bundle carries X" check
  would have passed on a bundle the backend **refused**. The tee parses bundles from the request body and
  recorded the PUT's `status`; no check ever read it. Measured with a forced 403 — a nine-file bundle,
  fully matchable, from a rejected upload. Closed by gating `waitForBundle` on a 2xx PUT plus a run-wide
  `wire-upload-status` check.
- **F-7** — `console.trace()` is **never captured, on any runtime**: the shared console interceptor's
  `DEFAULT_LEVELS` (`packages/capture/src/console-interceptor.ts:24-30`) maps only
  `log`/`info`/`debug`/`warn`/`error`, and all five platforms call `createConsoleInterceptor()` with no
  arguments, so the method is never even patched. Silent — the call succeeds and simply produces no
  capture. Visible on every sweep run in `s6-console`'s detail line (`trace:false` beside five `true`s,
  from a single uploaded `logs.json`).
