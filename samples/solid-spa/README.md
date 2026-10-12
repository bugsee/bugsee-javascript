# solid-spa — Bugtrackee

A working "Bug tracker" app built to exercise `@bugsee/solid`.

## Run it

```bash
cd samples/solid-spa
cp .env.example .env      # then paste the SSOLID app token (see "Staging app" below) — .env is gitignored, never commit it
pnpm install
pnpm dev                  # local API on :5337 + Vite dev server on :5307
```

Open http://localhost:5307. `pnpm dev` runs both the local API (`server/api-server.mjs`, port 5337)
and the Vite dev server (port 5307) together via `concurrently`; `pnpm dev:api` / `pnpm dev:app` run
them separately.

**Production build:**

```bash
pnpm build
pnpm preview               # serves dist/ on :5307 + the API on :5337
```

`@bugsee/solid` ships no bundler plugin (unlike `@bugsee/react`'s vite-plugin/babel-plugin) — this
sample's only package under test is `@bugsee/solid` itself, so the build is a stock
`vite-plugin-solid` production build.

**Scenario sweep:**

```bash
pnpm verify
```

Drives the app and every Scenario-panel control headlessly via Playwright and prints a pass/fail table
(local and wire level; backend verification is done separately). **Requires `pnpm dev` running in another
terminal first.** It runs a stock Chromium against the real staging collector with no request patching.

Every check asserts on real evidence (a DOM status line, a page-error count, an actual network call), never a
bare `true`. A check never asserts on a string the app prints unconditionally: it derives the status from the
thing being claimed, or asserts on the wire. A check never pre-filters evidence down to the subset a passing
run produces. A check that claims "X never happened" must ask the system that would hold X, and a `waitFor…`
helper must be given `sinceTs` so that it reads this click's match only. Evidence that the sample's own callback
wrote into the sample's own DOM is local evidence, however specific it reads. Exactly one check
(`s1-flush-post-storm`) is a disclosed exception: it is labelled weak in its own description and accepts either
boolean outcome, because post-storm drain timing is nondeterministic by design.

Current result: **67/67**, reproduced back-to-back against real staging on the final files.

Two of those checks (`s8-report-veto-backend`, `s8-report-mutate-backend`) query staging over MCP and
need `BUGSEE_MCP_URL` in the gitignored `.env` — see `.env.example`. Without it they FAIL rather than
skip, on purpose: "the vetoed report created no issue" is not verifiable from the browser alone.

## What the app does

**Bugtrackee** is a small issue tracker: an issue list with status/severity/search filters and a
create form, an issue-detail page at a NESTED dynamic route (`/issues/:id` with two child routes,
`/issues/:id` (Overview, the index) and `/issues/:id/comments`), comments on each issue, a live
"issue activity" feed over a real WebSocket, and a Settings page (display name → `setUserIdentifier`,
custom attributes, a masking-target "personal access token" field). A dedicated `/scenarios` route is
the SDK **Scenario panel** — one control per scenario, plus every
`@bugsee/solid`-specific API: `solidErrorHandler` wired into a `<ErrorBoundary>` (both a locally-guarded
widget and an app-level one wrapping the whole router in `main.tsx`), `reportSolidError` called
directly, `routePatternFromSolidMatches` + `setRouteNameFromSolidMatches` (both auto-wired globally via
`useCurrentMatches()` in `RootLayout.tsx` and called directly with a synthetic matches array), and a
`createResource` whose fetcher rejects — reading the resource re-throws into a local `<ErrorBoundary>`.

## Staging app

- App key: **`SSOLID`**
- App id: **`6a8ebe56a5966a45c7e9544f`**
- Type: `javascript`, subtype `solid`
- Endpoint: `https://apidev.bugsee.com` (staging — never production)
- **Token:** NOT checked in. `.env` is gitignored (`.gitignore`) and `.env.example` ships
  `BUGSEE_APP_TOKEN=` empty on purpose, so a fresh clone has no token until you supply one: read the
  `SSOLID` app's `app_token` from the Bugsee staging MCP (`list_applications` / `create_application`) and
  paste it into your local `.env`. Without it the app runs but uploads nothing and `pnpm verify` fails.

## Ports

- `5307` — Vite dev/preview server (assigned to this sample;
  from 5306 in build order: svelte-spa=5306, **solid-spa=5307**, angular-spa=5308,
  webpack-sourcemaps=5309, fastify-api=5310)
- `5337` — the local API (`server/api-server.mjs`)

## `@bugsee/solid`'s surface, vs. `@bugsee/react`

`@bugsee/solid` is deliberately smaller than `@bugsee/react`: v1 is "error + routing only" (see
`packages/solid/src/index.ts`). There is no profiler/render-span API, no component-annotation babel
plugin, and no bundler plugin — so this sample has no source-map story and no render-span section,
unlike `react-spa`. What IS under test:

- `solidErrorHandler(options)` — returns an `(error) => void` you wire into Solid's own error seam
  (`<ErrorBoundary fallback={(e) => (solidErrorHandler()(e), <Fallback/>)}>`, or `catchError`/`onError`).
  Unlike React, `@bugsee/solid` ships no boundary COMPONENT of its own — Solid already has one.
- `reportSolidError(error, options)` — the direct-call form.
- `setRouteNameFromSolidMatches(matches)` / `routePatternFromSolidMatches(matches)` — a structural peer
  over `@solidjs/router`'s match shape (no `@solidjs/router` import in the package). Solid Router is
  reactive (no afterEach hook), so the app wires this once, globally, via `useCurrentMatches()` +
  `createEffect` in `src/routes/RootLayout.tsx`.
