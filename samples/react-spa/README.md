# react-spa — Kanbugsee

A working Kanban board app built to exercise `@bugsee/react`, `@bugsee/vite-plugin` and
`@bugsee/babel-plugin-component-annotate` — see `docs/samples/PLAN.md` §5.2 for the plan this sample
was built against.

## Run it

```bash
cd samples/react-spa
cp .env.example .env      # already has the staging token for this sample checked in below — see .env
pnpm install
pnpm dev                  # local API on :5330 + Vite dev server on :5302
```

Open http://localhost:5302. `pnpm dev` runs both the local API (`server/api-server.mjs`, port 5330)
and the Vite dev server (port 5302) together via `concurrently`; `pnpm dev:api` / `pnpm dev:app` run
them separately.

**Production build** — see "The source-map half" below before running this; `bugsee-cli` does not
resolve out of the box (F-6 in `FINDINGS.md`):

```bash
BUGSEE_CLI_PATH="$(pwd)/node_modules/.pnpm/@bugsee+bugsee-cli@0.7.4/node_modules/@bugsee/bugsee-cli/run-bugsee-cli.js" pnpm build
pnpm preview               # serves dist/ on :5302 + the API on :5330
```

**Scenario sweep:**

```bash
pnpm verify
```

Drives the app + every Scenario-panel control headlessly via Playwright and prints a pass/fail table
(LOCAL/WIRE level — see `scenarios.md` for the backend/MCP verification this repo's author did by hand
against the results). **Requires `pnpm dev` running in another terminal first**, and installs
diagnostic-only workarounds for four backend/SDK defects that otherwise block 100% of delivery — see
`scripts/staging-workarounds.mjs` and `FINDINGS.md` F-1..F-4. Without them every scenario would show
"blocked", not because the app is broken, but because the current staging backend rejects every JS SDK
upload today, regardless of app or scenario.

## What the app does

**Kanbugsee** is a small Kanban board: boards → lists → cards, drag-and-drop cards between lists,
a card detail view at a nested dynamic route (`/board/:id/card/:cardId`), optimistic updates (create
list/card, move a card by drag, edit/delete a card) against a small local API
(`server/api-server.mjs` — plain `node:http`, no framework, since the framework under test is on the
client), a live "board activity" feed over a real WebSocket, and a Settings page (display name →
`setUserIdentifier`, custom attributes, a masking-target "personal access token" field). A dedicated
`/scenarios` route is the SDK **Scenario panel** — one control per scenario in
`docs/samples/PLAN.md` §4, plus every `@bugsee/react`-specific API (`BugseeErrorBoundary`,
`withBugseeErrorBoundary`, `createBugseeErrorHandlers`, `BugseeProfiler`, `withBugseeProfiler`,
`recordReactRenderSpan`, `reportReactError`, `linkComponentStack`, `instrumentReactRouter`,
`instrumentRouterMatches`, `routePatternFromMatches`, `setRouteName`).

## Staging app

- App key: **`SREACT`**
- App id: **`6a86d8e8990cb94c0b8e8ef8`**
- Type: `javascript`, subtype `react`
- Endpoint: `https://apidev.bugsee.com` (staging — never production)

## The source-map half

`@bugsee/vite-plugin` does not run out of the box against a tarball install — see **F-6** in
`FINDINGS.md`: `resolveBugseeCli()` assumes `bugsee-cli` is on `PATH`, which only holds inside the
monorepo. The escape hatch is `BUGSEE_CLI_PATH` (see the build command above). Once pointed at the
real binary, the rest of the pipeline works correctly: `pnpm build` injects a `//# debugId=<uuid>`
comment + a `_bugseeDebugIds` runtime stamp into every chunk, uploads the real source maps via
`bugsee-cli`, and deletes the client-facing `.map` files. Throwing from the **minified** production
bundle (`node scripts/prod-sourcemap-check.mjs` against `pnpm preview`) and checking the resulting
issue over MCP shows the stack resolved to `.../src/routes/ScenarioPage.tsx:296` — the exact original
line — not a minified bundle location. Full detail + evidence in `FINDINGS.md`.

Note: `bugsee-cli` content-addresses source maps by debug id, so building TWICE in a row with unchanged
source (byte-identical output → the same debug id) correctly fails the second upload with
`DuplicateSymbolsFoundError` — this is the backend behaving correctly (dedup), not a defect. A fresh
build after any source change uploads normally.

`@bugsee/babel-plugin-component-annotate` is wired into `vite.config.ts` via `@vitejs/plugin-react`'s
`babel.plugins`; every host JSX element gets `data-bugsee-component="<EnclosingComponent>"`, confirmed
present in both dev and the production build.

## Ports

- `5302` — Vite dev/preview server (assigned to this sample)
- `5330` — the local API (`server/api-server.mjs`) — picked outside the plan's suggested 53xx range
  because `5301`/`5303`/`5304`/`5305` were already in use by sibling samples being built concurrently
  in this environment.

## Scenario coverage

See `scenarios.md` for the full table (every scenario id → control → expected Bugsee content →
verified/unverified with evidence).

## Findings

See `FINDINGS.md`. Headline: this repo's own sample plan (`docs/samples/PLAN.md` §6) instructs every
sample to create its staging app with `type: "javascript"` — and, as shipped, **no data from any such
app can ever reach the backend from a real browser**, for four independent, stacked reasons (CORS,
a hardcoded client-type header, a response-shape mismatch that silently corrupts the session token, and
an S3 signature mismatch on the bundle upload). `scripts/staging-workarounds.mjs` documents and bypasses
all four so the rest of the pipeline — including full source-map resolution — could still be verified.
