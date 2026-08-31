# Metrics Ingest API — a Bugsee `@bugsee/fastify` sample

A real metrics-ingestion REST API — schema-validated events, per-metric aggregation, a nested admin
plugin — instrumented with `@bugsee/fastify`. It's also the exhaustive pre-publish test for that
package: every request goes through the real packed `@bugsee/fastify` tarball, talking to the real
Bugsee staging collector.

## Run it

```bash
cd samples/fastify-api
cp .env.example .env      # then fill in BUGSEE_APP_TOKEN — .env.example ships EMPTY (never commit a
                           # real token); create the app via the staging MCP (create_application) or
                           # ask for the SFASTIFY app's token — see "Staging app" below
pnpm install
pnpm dev                  # http://127.0.0.1:5404
```

Other commands:

```bash
pnpm start      # same as dev, no file-watching
pnpm verify     # boots the server, drives every scenario over HTTP, prints a pass/fail table
pnpm typecheck
```

`pnpm verify` also spawns five disposable child processes: `scripts/crash-child.ts` is run three times
(`uncaught-exit`/`uncaught-no-exit`/`rejection-warn`) to exercise `exitOnUncaught`/`unhandledRejections`
modes that would otherwise kill the long-running dev server; `scripts/adapter-alone-child.ts` is
run once to prove `setupFastify` works completely on its own with `instrumentIncomingRequests: false`
— in a SEPARATE process, because that option patches `http.Server.prototype.emit` process-wide (see
`FINDINGS.md`/the script's own comment); and `scripts/sample-rate-child.ts` is run once to prove
`performanceSampleRate: 0` suppresses every transaction on the wire (see `scenarios.md` S9) — it is the
rate-0 half of a two-script control paired with `adapter-alone-child.ts`'s rate-1 config.

## Staging app

| Key | Value |
| --- | --- |
| App key | `SFASTIFY` |
| App id | `6a8ebe70a5966a45c7e95465` |
| Type / subtype | `javascript` / `node` |
| Endpoint | `https://apidev.bugsee.com` (staging — never production) |

`src/bugsee-transport.ts` is a "tee" transport: it forwards every SDK call to the real staging
endpoint verbatim and separately records a parsed summary locally, which is what the wire-level checks
in `pnpm verify` assert against. It rewrites no request — the wire-contract defects an earlier sample
(`express-api`) found are already fixed in `@bugsee/core`.

"Rewrites no request" is a weaker claim than "behaves like the transport it replaces", and the two were
once conflated here. Because the tee stands in for `@bugsee/node-utils`' `httpRequest`, it must also
reproduce that transport's *behaviour*: it arms the same 30s timeout on every call (core never passes
`timeoutMs` — the transport is expected to default it) with `httpRequest`'s exact timeout error
message, it sets `redirect: 'manual'` so a 3xx surfaces as a 3xx (fetch would follow it; `http.request`
does not, and core maps a non-2xx below 500 to a PERMANENT upload failure — a following tee would turn
that into a silent success), and it keeps its own bundle parsing off the SDK's timing path. The four
parity points, and the one deliberate residual difference (a total-request deadline where node uses an
idle-socket timeout), are documented in full in the file itself.

## What the API does

Bearer-token auth (`Authorization: Bearer metrics-api-dev-token`, configurable via `API_TOKEN`)
protects every `/api/v1/metrics` route, installed as a Fastify `preHandler` hook SCOPED to that plugin
— `/scenarios/*` and `/health` are unaffected. A second, stricter hook (`x-admin-key`) is nested two
levels deep under the admin sub-plugin, layered on top of the parent's auth.

| Method | Path | What it does |
| --- | --- | --- |
| `GET` | `/health` | liveness + `isLaunched()` |
| `POST` | `/api/v1/metrics` | ingest a metric event (`{name, value, tags?}`, schema-validated); a `value` over the alert threshold makes a REAL outbound call to a mock alert webhook |
| `GET` | `/api/v1/metrics` | list events, paginated (`?name=&page=&pageSize=`) |
| `GET` | `/api/v1/metrics/:name/stats` | count/sum/avg/min/max for one metric name |
| `DELETE` | `/api/v1/metrics/:name` | delete a metric's series |
| `GET` | `/api/v1/metrics/admin/health` | admin sub-plugin (2 levels of prefix nesting), requires `x-admin-key` on top of the bearer token |
| `GET` | `/api/v1/metrics/admin/series/:name/summary` | same sub-plugin, PARAMETERIZED — the route the two-level route-naming wire check asserts on |
| `POST` | `/api/v1/metrics/admin/purge` | delete all events |
| `GET` | `/scenarios/*` | the scenario panel — see `scenarios.md` |

Data is a small file-backed JSON store (`data/db.json`) — no database, but genuinely persists across
restarts. `data/` is a RUN ARTEFACT, not evidence: it holds the store plus the tee'd wire log
(`data/verify-run.json`) that a `pnpm verify` run writes, both regenerated from scratch by the next
run, and it is gitignored in this sample's own `.gitignore` exactly as `express-api` does it. A fresh
clone therefore has no `data/` at all, which is why `scripts/verify.ts` creates the directory before it
seeds the restart series (see that seed's comment — the seed's `writeFileSync` used to be the first
writer of the path and threw `ENOENT` on a clean checkout).

Ingesting a high-value metric makes a REAL outbound HTTP call to a second,
deliberately NOT-Bugsee-instrumented "third-party" service (`src/third-party.ts`, port 5405 by
default) that stands in for an alerting webhook — this is what exercises network capture and outbound
trace propagation against a real socket, not a mock.

## Scenario coverage

See `scenarios.md` for the full table (every scenario id → route → expected Bugsee content →
verified/unverified with evidence). Summary:

- **Covered & backend-verified** (confirmed via `list_issues`/`get_issue` against `SFASTIFY` — the
  issue TOTAL is deliberately not repeated here, it lives in the issue-count home in `scenarios.md`'s
  fingerprinting note, along with why it includes stale duplicates: an edit to `src/routes/scenarios.ts`
  shifts its line numbers and re-mints a fresh issue per scenario at the new fingerprints): launch lifecycle, identity/attributes (before AND after an event, WITH the attributes
  actually visible via `get_issue(include_attributes:true)` — an MCP gap `express-api` hit is now
  fixed; the in-process getters are asserted too, `getAttribute`/`getAllAttributes` returning VALUES as
  the positive control for the clear-attributes negative pair, and the full
  `setUserIdentifier`/`getUserIdentifier`/`clearUserIdentifier` trio), manual exceptions incl. dedupe/cause-chain/severity/non-Error inputs, every crash surface
  (route/hook/async-handler/async-**plugin** throw, out-of-request `setTimeout` throw, unhandled
  rejection), `exitOnUncaught` true/false, `unhandledRejections: 'warn'`, redaction (log + breadcrumb +
  report-veto + report-mutate, with labels now visible via MCP too), the 4xx-not-reported/5xx-reported
  contract, and per-request concurrency isolation at full scale (50/50).
- **Covered & wire-verified only** (MCP doesn't expose the data): console capture, network capture (all
  of S7), performance/APM (all of S9 — MCP has no performance issue type at all), route naming
  (**Fastify resolves nested-plugin-prefix route patterns correctly at both depths tested — one level
  (`GET /api/v1/metrics/:name/stats`) and two (`GET /api/v1/metrics/admin/series/:name/summary`)** — no
  equivalent of `express-api`'s F-4 regression; each is asserted by EQUALITY against the parameterized
  pattern, because a route-naming check on a STATIC route cannot fail — the SDK's fallback for a static
  route is byte-identical to its pattern, see `scenarios.md`'s route-naming row), the first-owner-wins
  de-dup check, and the adapter-alone (`instrumentIncomingRequests:false`) path.
- **Fastify-specific findings** (`FINDINGS.md`): a genuine Fastify SCHEMA VALIDATION 4xx is reported
  exactly like a thrown 500 (F-1); `@bugsee/fastify` has no `shouldReport` option at all — the sole
  outlier among all seven backend adapters — illustrated by a `setErrorHandler` that rewrites a
  response to 200 not suppressing Bugsee's report (F-3); `setRouteName()` has no observable effect,
  two independent SDK-side mechanisms clobber it (F-4); `RequestContextStoreToken` and `HttpTransport`
  are not re-exported from the umbrella, a cross-cutting ergonomics gap shared with `express-api`
  (F-5/F-6); the SDK's `user:` identity never renders on the backend, an unresolved
  ingestion-vs-MCP-render question (F-7).
- **N/A** (with reasons in `scenarios.md`): S11 (session replay — browser-only), S13 (OpenTelemetry —
  not wired in this sample), two-hop distributed tracing and disk-recovery/multi-instance coexistence
  (need a second live Bugsee-instrumented service or a destructive kill — `node-service` is the
  designated sample for both), XHR/SSE (browser-only globals, absent on Node — WebSocket is a
  deliberate choice not to exercise, not a runtime limitation; see `scenarios.md` S7).

## Findings

`FINDINGS.md` — every SDK defect found while building this sample: `@bugsee/fastify`'s complete
absence of a `shouldReport` seam (F-1/F-3 — the sole outlier among all seven backend adapters),
`setRouteName()` being inert (F-4), two cross-cutting umbrella re-export gaps shared with
`express-api` (F-5/F-6), an unresolved user-identity render question (F-7), plus corroborating
evidence for the cross-cutting `samples/FINDINGS.md` F-X4 (logs never render via `get_issue`,
narrowed here to a backend/MCP-side gap, not an SDK one — this sample's own tee transport confirms
`logs.json` and breadcrumbs ARE present and correct in the uploaded bundle).
