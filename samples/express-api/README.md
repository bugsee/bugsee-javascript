# Task API — a Bugsee `@bugsee/express` sample

A real REST API for projects and tasks, instrumented with `@bugsee/express`. It's also the exhaustive
pre-publish test for that package: every request goes through the real packed `@bugsee/express`
tarball, talking to the real Bugsee staging collector.

## Run it

```bash
cd samples/express-api
cp .env.example .env      # already filled in for this sample with the staging app token below
pnpm install
pnpm dev                  # http://127.0.0.1:5304
```

Open `http://127.0.0.1:5304/` for a small dashboard: a "try the real API" panel and a button per
scenario in `scenarios.md`, each printing its JSON response.

Other commands:

```bash
pnpm start      # same as dev, no file-watching
pnpm verify     # boots the server, drives every scenario over HTTP, prints a pass/fail table
pnpm typecheck
```

`pnpm verify` also spawns two short-lived child processes (`scripts/crash-child.ts`) to exercise
`exitOnUncaught`/`unhandledRejections` modes that would otherwise kill the long-running dev server.

## Staging app

| Key | Value |
| --- | --- |
| App key | `SEXPRESS` |
| App id | `6a86d8ef49f15abdb072ea95` |
| Type / subtype | `javascript` / `express` |
| Endpoint | `https://apidev.bugsee.com` (staging — never production) |

**Getting real data to actually arrive required three wire-level workarounds for SDK defects found
while building this sample** — see `FINDINGS.md` F-1/F-2/F-3. Without them, no report from any Node/Bun/
Deno SDK build in this monorepo can reach the staging backend at all. The workarounds live entirely in
`src/bugsee-transport.ts` (a "tee" transport that forwards every SDK call to the real endpoint, patches
the three defects on the wire, and records a parsed summary locally for verification) — nothing in
`packages/` was touched.

## What the API does

Bearer-token auth (`Authorization: Bearer task-api-dev-token`, configurable via `API_TOKEN`) protects
every `/projects` route. `/scenarios/*` is intentionally unauthenticated (a diagnostic surface, not
part of the "real" API).

| Method | Path | What it does |
| --- | --- | --- |
| `GET` | `/health` | liveness + `isLaunched()` |
| `GET` | `/projects` | list projects, paginated (`?page=&pageSize=`) |
| `POST` | `/projects` | create a project (`{name}`) |
| `GET` | `/projects/:id` | fetch one project |
| `PATCH` | `/projects/:id` | update a project's name |
| `DELETE` | `/projects/:id` | delete a project (cascades its tasks) |
| `GET` | `/projects/:id/tasks` | list a project's tasks, paginated |
| `POST` | `/projects/:id/tasks` | create a task (`{title}`); also calls the third-party "priority scoring" service |
| `GET` | `/projects/:id/tasks/:taskId` | fetch one task |
| `PATCH` | `/projects/:id/tasks/:taskId` | update a task's `title`/`done` |
| `DELETE` | `/projects/:id/tasks/:taskId` | delete a task |
| `GET` | `/scenarios/*` | the scenario panel — see `scenarios.md` |

Data is a small file-backed JSON store (`data/db.json`, gitignored) — no database, but genuinely
persists across restarts. Task creation makes a REAL outbound HTTP call to a second, deliberately
NOT-Bugsee-instrumented "third-party" service (`src/third-party.ts`, port 5305 by default) that stands
in for an external priority-scoring API — this is what exercises network capture and outbound trace
propagation against a real socket, not a mock.

A second, independent Bugsee client (`src/secondary.ts`, its own `carrier`) powers `/scenarios/alt/*`:
a small sub-app that uses the `requestHandler`/`errorHandler` middleware halves BY HAND (instead of
`setupExpress`) with `instrumentIncomingRequests: false`, to prove the adapter works completely on its
own.

## Scenario coverage

See `scenarios.md` for the full table (every scenario id → route → expected Bugsee content → verified/
unverified with evidence). Summary:

- **Covered & backend-verified** (confirmed via `list_issues`/`get_issue` against `SEXPRESS`): launch
  lifecycle, identity/attributes (before AND after an event), manual exceptions incl. dedupe, all four
  crash surfaces (route/middleware/async throw, out-of-request `setTimeout` throw, unhandled rejection),
  `exitOnUncaught` true/false, `unhandledRejections: 'warn'`, redaction (log + report-veto + report-mutate),
  the 4xx-not-reported/5xx-reported contract, the adapter-alone (`instrumentIncomingRequests:false`)
  path, and per-request concurrency isolation (verified at small scale; see below for full-scale caveat).
- **Covered & wire-verified only** (MCP doesn't expose the data — see PLAN §6.6 and FINDINGS.md F-6):
  console capture, network capture (all of S7), performance/APM (all of S9 — MCP has no performance
  issue type at all), route naming (and its regression, FINDINGS.md F-4).
- **Covered, local-only or partially verified**: the S4 storm (200) and the full 50-request concurrency
  sweep run and behave correctly locally, but the shared staging collector's real-world throughput meant
  only a fraction were individually confirmed delivered within a practical test window — see
  FINDINGS.md's "Bulk delivery throughput" note. The underlying mechanism is fully verified at smaller
  scale.
- **N/A** (with reasons in `scenarios.md`): S11 (session replay — browser-only), S13 (OpenTelemetry —
  not wired in this sample, see `browser-vanilla`/`node-service`), two-hop distributed tracing and
  multi-instance disk coexistence (need a second live Bugsee-instrumented service — `node-service` is
  the designated partner for both, per the plan), XHR/WebSocket/SSE (browser-only globals, absent on
  Node).

## Findings

`FINDINGS.md` — everything found while building this sample, including three backend-blocking SDK
defects (F-1/F-2/F-3) that prevent ANY report from reaching Bugsee staging on the packed tarball this
sample installs, a route-naming regression for nested Express routers (F-4), a missing `shouldReport`
option relative to sibling adapters (F-5), and two MCP/backend-surface gaps (F-6, F-7).
