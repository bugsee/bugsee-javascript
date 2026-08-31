# solid-spa — Bugtrackee

A working "Bug tracker" app built to exercise `@bugsee/solid` — see `docs/samples/PLAN.md` §5.5 for
the plan this sample was built against.

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

Drives the app + every Scenario-panel control headlessly via Playwright and prints a pass/fail table
(LOCAL/WIRE level — see `scenarios.md` for the backend/MCP verification this repo's author did by hand
against the results). **Requires `pnpm dev` running in another terminal first.** Runs a stock Chromium
against the real staging collector with no request patching — the wire-contract + CORS defects that
once blocked every browser sample are fixed (see `samples/FINDINGS.md` F-X6/F-X10).

Every check asserts on real evidence (a DOM status line, a page-error count, an actual network call) —
never a bare `true` (see `FINDINGS.md` F-3/F-5 for why that discipline matters: it's what caught this
sample's own stale-client-reference bug and a verify-script race). Two further rules, each learned from
a check that was green while blind: a check never asserts on a string the app prints
UNCONDITIONALLY (it derives the status from the thing being claimed, or asserts on the wire), and it
never pre-filters evidence down to the subset a passing run produces before asserting a property of
that subset. Three more, added in round 4 and swept across every check rather than only where each was
found: a check that claims "X never happened" must ask the system that would HOLD X (the S8 report-veto
row claimed "no issue created" while only counting browser requests — and staging had the issue); a
`waitFor…` helper without `sinceTs` reads the earliest match in the whole run, not this click's; and
evidence the sample's own callback wrote into the sample's own DOM is LOCAL evidence, however specific
it reads (the S8 network rows now read the SDK's own uploaded bundle instead). Exactly one check
(`s1-flush-post-storm`) is a disclosed exception, explicitly labelled WEAK in its own description, and
accepts either boolean outcome (post-storm drain timing is nondeterministic by design). Current result:
**67/67**, reproduced three times back-to-back against real staging on the final files. The count moved
from 61 in round 5, when session replay became ON BY DEFAULT in `@bugsee/browser`: six checks were added
(`s11-replay-default-on`, `s11-replay-optout-wire`, `s11-replay-masking-off-control`,
`s11-replay-masking-content`, `s7-send-beacon`, `s7-send-beacon-bundle-wire`), one was replaced
(`s11-replay-bundle-wire`, which had started passing for the wrong reason — see `FINDINGS.md` F-8), and
one was re-pointed (`s11-unmask-mark-typed-value`).

Two of those checks (`s8-report-veto-backend`, `s8-report-mutate-backend`) query staging over MCP and
need `BUGSEE_MCP_URL` in the gitignored `.env` — see `.env.example`. Without it they FAIL rather than
skip, on purpose: "the vetoed report created no issue" is not verifiable from the browser alone.

## What the app does

**Bugtrackee** is a small issue tracker: an issue list with status/severity/search filters and a
create form, an issue-detail page at a NESTED dynamic route (`/issues/:id` with two child routes,
`/issues/:id` (Overview, the index) and `/issues/:id/comments`), comments on each issue, a live
"issue activity" feed over a real WebSocket, and a Settings page (display name → `setUserIdentifier`,
custom attributes, a masking-target "personal access token" field). A dedicated `/scenarios` route is
the SDK **Scenario panel** — one control per scenario in `docs/samples/PLAN.md` §4, plus every
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

- `5307` — Vite dev/preview server (assigned to this sample; wave-1 used 5301–5305, wave-2 continues
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

## Scenario coverage

See `scenarios.md` for the full table (every scenario id → control → expected Bugsee content →
verified/unverified with evidence).

## Findings

See `FINDINGS.md`. This pass found **two major SDK defects** plus one confirmed-but-deliberate
behaviour worth documenting, going past "no throw" to actual wire (PLAN §6.6) and backend evidence:

- **Finding A** — `setRouteNameFromSolidMatches`, wired the documented way (`useCurrentMatches()` +
  `createEffect`), never renames its own navigation's transaction — `@solidjs/router` flushes
  `matches()` before committing history, so the effect always fires one navigation early. Worse than a
  no-op: two navigations inside the 1s idle-transaction window can mislabel an EARLIER transaction with
  a LATER route's pattern, so a latency dashboard grouped by transaction name would attribute one
  route's timing to another. This is the one feature `@bugsee/solid` exists for beyond error reporting.
- **Finding B** — a crash recovered across a reload is delivered via TWO independent recovery paths
  (`recoverSiblingBundleQueue` + core `recoverReports`, both inside one `recoverDeadSiblings` call with
  no de-duplication) and uploaded **twice, deterministically** — `events_count: 2` from a single click
  (`SSOLID-80`), reproduced at every reload delay tried inside the vulnerable window — from ~40ms (the
  durable queue has taken its copy) up to the incident's own upload settling (~3.5s here: the
  `POST /v2/issues` leaves at +1835ms, the bundle PUT settles at +3486ms). Both edges yield 1: the 5ms
  this sample's own control used to use reloads before the bundle ever reaches the durable queue, and a
  reload past the settle time finds the marker already cleared. (`angular-spa` and `react-spa` reload at
  5 ms, i.e. they sit on the LOWER edge and see ONE delivery — an earlier version of this line
  attributed angular's single delivery to its ~180 s quiet wait and to the UPPER edge; that was wrong on
  both counts: angular's quiet wait precedes its S12 click, not the reload, and its reload delay is
  5 ms.) The same root cause (a `@bugsee/core` marker held open until the network upload settles, not
  just until the durable queue owns delivery) can also mean a badly-timed sweep starves recovery of
  rate-limiter budget and delivers it ZERO times instead.
- **Finding C (re-graded to a docs gap)** — installing ANY `setNetworkEventFilter` disables the
  built-in PII sanitizer (`packages/capture/src/network-provider.ts:151-160` replaces it rather than
  composing with it), so an app that installs a filter for one narrow case loses URL/credential
  scrubbing on every other request. Confirmed at wire level here — literally so since round 4:
  `s8-sanitizer-disabled-bundle-wire` finds the unredacted `token=` param inside `network.json` in the
  bundle the SDK actually uploaded, not just in the sample's own filter callback — but this is the
  deliberate **Android XOR rule** (named as such at `network-provider.ts:137-139`, recorded intentional in
  `docs/PROGRESS.md`, and already triaged in `docs/review/capture.md:216`), and Android is the binding
  parity target. What is genuinely missing is the public-docs line that review asked for.

- **Finding D (minor, fails closed)** — `.bugsee-unmask` on an `<input>` is honoured only on replay's
  FULL-SNAPSHOT path: a value typed into the field *during* recording stays masked. Measured with a
  distinct probe per path inside one decoded `replay.bin`; independently reported by two peer samples,
  so it is documented here rather than re-diagnosed. It lives in the rrweb fork, not in
  `packages/replay/src/masking.ts`, and it errs toward MORE masking than asked for.

Plus a re-graded **F-1** (`setNetworkEventFilter`'s veto is per-`NetworkStage`-entry, not per-request —
a request-body veto rule leaks the response half of the same request through un-vetoed; upgraded from
minor to major) and a rewritten **F-2** (the real defect isn't the `window.onerror`/`unhandledrejection`
classification split, which is by design — it's that ONE uploaded report's `crash.json` says
`handled: false` while its displayed type says "Handled error", confirmed by unzipping the actual
bundle). Every documented `@bugsee/solid` API surface (`solidErrorHandler`, `reportSolidError`,
`routePatternFromSolidMatches`, and `setRouteNameFromSolidMatches`'s DIRECT-call form) otherwise works
correctly against real backend evidence — the defect in Finding A is specifically in the LIVE router
wiring, not the underlying primitive. Also recorded: seven sample-side bugs this build found and fixed
in itself (F-3/F-4/F-5 — a Solid-specific stale-closure gotcha, an `<A>`-outside-`<Router>` fallback
bug, and a verify-script race that read a status line before its own triggering click handler had
finished; F-6 — an unguarded veto control; and, from round 5, F-7/F-8/F-9/F-10), none an SDK defect.

**Round 5 — re-verified against a changed SDK substrate.** Session replay became ON BY DEFAULT
(`packages/browser/src/launch.ts`: `options.replay !== false && domDocument !== undefined`; `replay:
false` is the opt-out, and a DOM-less host self-skips silently). Nothing in the sweep broke — it ran
61/61 on the new packages — but four things were WRONG-BUT-GREEN and are fixed: the sample's
"Restore (replay off)" control no longer turned replay off (F-8), the replay wire row it fed had become
a tautology now that `replay.bin` rides every bundle (F-8), the S11 opt-out input carried the wrong
privacy class (F-7), and every "the uploaded bundle contains X" row was reading what the SDK SENT
rather than what the collector ACCEPTED (F-9). The same round closed the coverage hole left by the new
`sendBeacon` interceptor, which this sample called nowhere.
