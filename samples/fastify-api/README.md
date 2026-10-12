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
the script's own comment); and `scripts/sample-rate-child.ts` is run once to prove
`performanceSampleRate: 0` suppresses every transaction on the wire — it is the
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
| `GET` | `/scenarios/*` | the scenario panel |

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
