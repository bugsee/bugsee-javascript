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
scenario, each printing its JSON response.

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

Getting real data to arrive once required three wire-level workarounds for SDK defects this sample
found — a hardcoded `x-client-type: web`, the unparsed `{ok, result}`
response envelope, and an `x-amz-checksum-sha256` header the presigned S3 url was never signed for.
**All three are fixed in `@bugsee/core` and the patching is gone.** `src/bugsee-transport.ts` remains,
but only as a "tee": it forwards every SDK call to the real endpoint untouched and records a parsed
summary locally, which is what the wire-level checks in `pnpm verify` assert against.

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
| `GET` | `/scenarios/*` | the scenario panel |

Data is a small file-backed JSON store (`data/db.json`, gitignored) — no database, but genuinely
persists across restarts. Task creation makes a REAL outbound HTTP call to a second, deliberately
NOT-Bugsee-instrumented "third-party" service (`src/third-party.ts`, port 5305 by default) that stands
in for an external priority-scoring API — this is what exercises network capture and outbound trace
propagation against a real socket, not a mock.

A second, independent Bugsee client (`src/secondary.ts`, its own `carrier`) powers `/scenarios/alt/*`:
a small sub-app that uses the `requestHandler`/`errorHandler` middleware halves BY HAND (instead of
`setupExpress`) with `instrumentIncomingRequests: false`, to prove the adapter works completely on its
own.
