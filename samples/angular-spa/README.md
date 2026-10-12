# angular-spa — Bugsee Expenses

A working Angular expense-report app built to exercise `@bugsee/angular`.

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
pnpm build                # ng build (production)
pnpm preview              # serves dist/angular-spa/browser + /api on :5306, one process
```

> **`dist/` is a local artifact.** `dist/` is **gitignored** (`.gitignore`), so nothing is committed
> from it; and `pnpm verify` drives `http://localhost:5306` served by **`ng serve`** (`pnpm dev`), never
> the built output — `pnpm preview` is the only consumer of `dist/`, and it rebuilds via `pnpm build`.
> The one thing to avoid is running `pnpm preview` and `pnpm verify` together without a fresh
> `pnpm build`: that WOULD verify a stale bundle, and nothing in the harness would tell you.

**Scenario sweep:**

```bash
pnpm verify
```

Drives the app + every Scenario-panel control headlessly via Playwright and prints a pass/fail table
(LOCAL/WIRE level). **Requires `pnpm dev` running in another terminal first.** Latest full run against staging:
**70/70**. It takes several minutes: the post-storm quiet wait is deliberate, and cutting it short makes a
correct `flush() -> false` look like an SDK defect.

## What the app does

**Bugsee Expenses** is a small expense-report app: an expenses list, a reactive form (with field-level
and cross-field validators) to submit a new expense with a receipt **file attachment** (read client-side
via `FileReader`, stored and downloadable from the expense's detail page), an **approval flow** behind a
**lazy-loaded** `/approvals` feature (its own chunk, fetched only on first visit) gated by a **route
guard** (`managerGuard`) that redirects a non-manager back to `/expenses` with a banner, a live "expense
activity" feed over a real WebSocket, and a Settings page (display name → `setUserIdentifier`, custom
attributes, a masking-target "personal access token" field). A dedicated `/scenarios` route is the SDK
**Scenario panel** — one control per scenario, plus every
`@bugsee/angular`-specific API (`BugseeErrorHandler`, `createAngularErrorHandler`, `reportAngularError`,
the `ngOriginalError` unwrap path, `createBugseeRenderTracker`, `routePatternFromSnapshot`,
`setRouteNameFromRouter`) and a set of fixtures for an error thrown in a component, in a service, inside
an RxJS pipeline, and inside an `HttpClient` call.

The app's real CRUD (`core/expense.service.ts`) goes through Angular's `HttpClient` with the **default
XHR backend** (`provideHttpClient()` — deliberately **not** `withFetch()`, see `app.config.ts`) — a
different network-capture code path from the raw `fetch`/XHR/SSE controls in the Scenario panel, and
confirmed distinctly captured (a `Handled HttpErrorResponse`).

## Staging app

- App key: **`SANGULAR`**
- App id: **`6a8ebe5bd58badbb348fbecd`**
- Type: `javascript`, subtype `angular`
- Endpoint: `https://apidev.bugsee.com` (staging — never production)

## Ports

- `5306` — Angular CLI dev/preview server (assigned to this sample)
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

Worth knowing before reading anything else: the browser tier records unless you pass
`replay: false` (`packages/browser/src/launch.ts:433` — `options.replay !== false && domDocument !==
undefined`). This app's own `FULL_LAUNCH_OPTIONS` carries no `replay` key, so **every bundle it uploads
contains `replay.bin`**, from the very first launch, not only after an S11 control is clicked. The replay
controls change the replay CONFIGURATION; the only one whose effect is visible in the uploaded bundle is
`replay: false`.
