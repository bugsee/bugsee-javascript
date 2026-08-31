# webpack-sourcemaps — Markdown Notes

A real webpack 5 app built to exercise `@bugsee/webpack-plugin` and `@bugsee/bundler-plugin-core` —
see `docs/samples/PLAN.md` §5.7 for the plan this sample was built against. Deliberately **not** a
framework: the webpack build itself, and the source-map/debug-id upload pipeline that rides on top of
it, are the subject.

## Run it

```bash
cd samples/webpack-sourcemaps
cp .env.example .env      # paste a real BUGSEE_APP_TOKEN for the SWEBPACK staging app (see below)
pnpm install
pnpm dev                  # local API on :5346 + webpack-dev-server on :5321
```

Open http://localhost:5321. `pnpm dev` runs both the local API (`server/api-server.mjs`, port 5346)
and webpack's dev server (port 5321) together via `concurrently`; `pnpm dev:api` / `pnpm dev:app` run
them separately.

**Production build** (the whole point of this sample — reads `hidden-source-map`, injects debug-IDs,
uploads real source maps to staging, then deletes the client `.map`s):

> **`pnpm build` fails on every REPEAT run today** — this is the first thing you will hit, and it is
> not a mistake in this README: it is `FINDINGS.md` F-2, a real `@bugsee/bundler-plugin-core` /
> `bugsee-cli` defect. This sample code-splits a couple of vendor chunks that never change between
> builds; once their debug-id is uploaded once, EVERY later build — even one where your own app code
> changed — fails outright the moment the CLI reaches that unchanged chunk
> (`DuplicateSymbolsFoundError`, exit code 30), because one file's rejection aborts the WHOLE upload
> batch.
>
> **Corrected (fix round 2, F-G):** this previously claimed pinning `.build-counter` to `2` and "not
> bumping it" reproduces the byte-identical main chunk from the one build that fully succeeded, framed
> as if that's what keeps `pnpm build` working. Two things were wrong with that: (1) `nextBuildCounter()`
> (`webpack.config.js`) reads-increments-and-REWRITES the file on **every** production build regardless
> of what's committed, so there is no way to actually "not bump it" — the counter cannot be pinned in
> that sense; and (2) **file-processing order inside `bugsee-cli debug-files upload` is NOT
> deterministic across builds** — confirmed empirically while fixing this by running `pnpm build` three
> times in a row against this exact source: run 1 processed `main.<hash>.js.map` FIRST (uploaded
> successfully under a fresh debug-id) then hit the unchanged vendor chunk SECOND and aborted; run 2
> (`BUGSEE_FAIL_ON_ERROR=false`, one build later) processed the vendor chunk FIRST and aborted
> immediately — main was **never even attempted** that time. So "just run `pnpm build` fresh" does NOT
> reliably get you a dist/ whose main chunk is confirmed uploaded — it depends on an ordering this
> sample cannot control.
>
> **What's actually reliable, and what to do:** reset `.build-counter` to the value that, on your NEXT
> build, reproduces byte-identical content to a main chunk you've already confirmed WAS uploaded
> successfully (check its debug-id via `list_issues`/`get_issue` on a real reported issue, or just note
> it from a prior build's CLI stderr: `identified debug_id=<uuid> ... path=.../main.<hash>.js.map`).
> Rebuilding with that same counter value reproduces the exact same bytes → the exact same debug-id →
> the exact same content the server ALREADY has — so even when this build's own upload attempt is
> rejected as a duplicate (or aborts on the vendor chunk before even reaching main, per the
> non-determinism above), the main chunk's map is still good server-side, because it was already
> uploaded by an earlier, successful run. This was re-verified while fixing this round: after resetting
> `.build-counter` to `2`, `pnpm build` (counter → 3) rebuilt `main.<hash>.js` with debug-id
> `f2cf373c-…` — the SAME debug-id a fresh `s4-error` throw against THIS exact dist/ had already
> confirmed `symbolication_status: "ready"` on the server (issue `SWEBPACK-30`) — regardless of that
> build's own upload call being rejected as a dup.
>
> Either way, `dist/` is fully written even when the CLI step fails (the plugin's upload runs after
> webpack's own emit has already completed) and the `hidden-source-map` + debug-id injection (items b/c
> above) still ran on every chunk — a non-zero `pnpm build` exit here is expected, not a setup error. If
> you want a clean (exit 0) build instead — e.g. to also exercise the `deleteMaps` step, which only runs
> after a fully clean upload batch — run `BUGSEE_FAIL_ON_ERROR=false pnpm build`; note that in that case
> the `.map` files are still NOT deleted (same gating on a clean batch), so don't rely on that flag to
> test `deleteMaps` — see F-2's Impact paragraph.

```bash
pnpm build                # real BUGSEE_APP_TOKEN from .env, failOnError: true
pnpm preview              # serves dist/ on :5322 + the local API on :5346
```

Then throw from the deployed production build and confirm the backend resolves the stack to the
original TypeScript source (see "The source-map half" below):

```bash
pnpm verify:sourcemaps
```

**Scenario sweep** (dev server, `pnpm dev` must already be running in another terminal):

```bash
pnpm verify
```

Drives the real app + every Scenario-panel control headlessly via Playwright and prints a pass/fail
table (LOCAL/WIRE level — see `scenarios.md` for the Backend/MCP verification done by hand against the
results).

**Every build-option variant** (all real webpack builds, see "Plugin options in full" below):

```bash
pnpm build:dry-run          # --dry-run: no upload, no deletion
pnpm build:disabled         # plugin fully disabled, dist ships with NO debug-id
pnpm build:keep-maps        # deleteMaps: false — .map files survive a confirmed upload
pnpm build:bad-token-loud   # bad token + failOnError: true  -> the BUILD FAILS (non-zero exit)
pnpm build:bad-token-soft   # bad token + failOnError: false -> contained, build succeeds, warns
pnpm build:signal-kill      # bugsee-cli "killed by a signal" -> the BUILD FAILS (regression guard)
```

## What the app does

**Markdown Notes** is a small, real note-taking app: a sidebar list of notes (persisted to
`localStorage`), a two-pane editor (markdown source + a live-rendered preview via `marked`), tag
editing, search/filter, a "suggest a prompt" button that fetches a random writing prompt from the
local API, and a "Backup all notes" button that POSTs the whole note set to the local API and reports
back a count. A presence WebSocket announces "someone is editing" (real bidirectional traffic for S7).
A dedicated `#/scenarios` route is the SDK **Scenario panel** — one control per scenario in
`docs/samples/PLAN.md` §4 (S10/S13 marked N/A with reasons — see `scenarios.md`). **S11 (session
replay) used to be N/A here and is not any more:** replay is now ON BY DEFAULT in `@bugsee/browser`,
so this sample records a session and uploads `replay.bin` in every bundle whether or not it asks to,
and `pnpm verify` asserts that at wire depth (the three `s11-*` rows) rather than leaving a real
recording of the page unexamined. It needs no Scenario-panel control of its own: the recording is a
property of the whole run, so the checks read the bundle an ordinary `s4-error` report uploads.

The local API (`server/api-server.mjs`, plain `node:http`, no framework) also hosts a handful of
`/api/scenario/*` routes purpose-built for S7 edge cases (4xx, 5xx, no-Content-Type, an oversized body,
SSE, the presence WebSocket).

## Staging app

- App key: **`SWEBPACK`**
- App id: **`6a8ebe68a5966a45c7e9545c`**
- Type: `javascript`
- Endpoint: `https://apidev.bugsee.com` (staging — never production)

## Ports

- `5321` — webpack-dev-server (dev)
- `5322` — `scripts/serve-dist.mjs`, a tiny static server + `/api` proxy for the PRODUCTION `dist/`
  (webpack has no built-in "preview" the way Vite does)
- `5346` — the local API (`server/api-server.mjs`)

Picked outside both the wave-1 range (5301–5305) and the low 53xx block other wave-2 samples were
building against concurrently in this environment — `lsof -ti :5306/:5307/:5336` showed those already
bound to sibling sample dev servers when this sample first tried them (see `FINDINGS.md`, not an SDK
finding, just a note for future sample authors: pick a distinctly separated block, e.g. 532x/534x, not
neighbouring wave 1 by a few numbers).

## The source-map half — the heart of this sample

`webpack.config.js` wires `bugseeWebpackPlugin` from `@bugsee/webpack-plugin` with every
`BugseePluginOptions` field reachable from an env var (see the `pnpm build:*` variants above), on top
of a production `devtool: 'hidden-source-map'` (a real `.map` is written next to each chunk, but the
shipped bundle carries NO `//# sourceMappingURL=` comment).

**End to end, verified against real staging (`SWEBPACK`):**

1. `pnpm build` — the plugin runs `bugsee-cli sourcemaps inject` (writes a `//# debugId=<uuid>` comment
   + the `_bugseeDebugIds` runtime stub into every JS chunk) then `bugsee-cli debug-files upload`
   (uploads the real maps, keyed by debug-id), then deletes the client `.map` files — **only once the
   WHOLE batch's upload succeeds**; `deleteMaps` is gated on that (`orchestrate.ts:145-152`), and the
   unchanged vendor chunk currently always prevents it — F-2. **Updated in the substrate-flip
   re-verification (2026-08-27):** the `dist/` behind this section's evidence is now build 5 —
   `main.746af8f7.js` with `//# debugId=7b429082-e493-591e-9587-9313da7d32dd` — and that id came from
   this build's OWN upload call (`uploaded debug_id=7b429082-…` in the CLI's stderr), because the
   non-deterministic file order happened to reach `main` before the unchanged vendor chunk aborted the
   batch. The counter-reset technique described in the callout above is no longer usable to reproduce
   the PRE-flip `f2cf373c-efcc-5fa0-9d48-6bba9dfd06c4`: session replay being on by default changed the
   SDK's own bytes, so no build of the current substrate can reproduce a pre-flip chunk. Re-derive
   from `dist/` (and from the CLI's stderr) after any substrate change rather than quoting this line. **Corrected claim:** this section previously said "no
   `.map` files remain after a clean, successful build" as a general statement; the `dist/assets/`
   shipped in this repo right now still has all three `.map` files next to their chunks, because
   `deleteMaps` only runs after a confirmed upload of the WHOLE batch (`orchestrate.ts:145-152`), which
   the vendor-chunk collision (F-2) currently always blocks. "No maps remain" is true only immediately
   after a build whose upload step fully succeeds end to end; it is not the general state of this
   repo's `dist/`.
2. `pnpm preview` serves that exact production bundle; `pnpm verify:sourcemaps` clicks the Scenario
   panel's `s4-error` control (throws `new Error('S4: logException(new Error(...))')` from
   `src/scenarios.ts:375`, inside the MINIFIED, hidden-source-mapped bundle) and flushes. **Corrected
   line (fix round 2, F-H):** this previously cited `:306`; edits across earlier fix rounds moved the S4
   error handler down to line 375 — re-confirmed against the file as it stands now (see step 3's fresh
   evidence, captured from this exact line).
3. **Backend verification (issue `SWEBPACK-30`, re-verified fix round 2 — supersedes the original
   `SWEBPACK-1`, whose stack cited the pre-drift line `:306`)** — `get_issue` returns:
   ```
   # Summary
   Handled Error at HTMLButtonElement.<anonymous> () (webpack://@bugsee-samples/webpack-sourcemaps/./src/scenarios.ts:375)

   # Exception
   ## Reason/message
   S4: logException(new Error(...))
   ## Stack trace
   HTMLButtonElement.<anonymous> () (webpack://@bugsee-samples/webpack-sourcemaps/./src/scenarios.ts:375) [UserFrame]
   ```
   `src/scenarios.ts:375` is the EXACT original source line of the `new Error(...)` call — not a
   minified/hashed chunk location like `assets/main.<hash>.js:1:12345`. `symbolication_status: "ready"`
   in `list_issues`. This is the whole point of the sample, fully verified at Backend depth, still true
   after every fix in this round — **and re-verified on the replay-on-by-default substrate (2026-08-27):
   the same `SWEBPACK-30` key gained a new event carrying `app.build: "5"` and the identical
   `./src/scenarios.ts:375` `[UserFrame]` stack, from a bundle whose every chunk hash had changed.**

   Counter-evidence worth keeping, because it shows what this pipeline looks like when it is NOT
   working: `SWEBPACK-36` was minted during the same pass by a probe run against a `pnpm build:dry-run`
   output — a production bundle whose maps were deliberately never uploaded. Its summary reads
   `Handled Error at at HTMLButtonElement.<anonymous> (http://localhost:5322/assets/main.788a48b5.js:1:184731)`
   — a raw minified location, and a SEPARATE issue key, because an unsymbolicated stack groups by the
   hashed chunk rather than by the original source line. That is exactly the failure mode this sample
   exists to prove does not happen on a real `pnpm build`.

**Plugin options in full** — every one of `BugseePluginOptions` (`docs/source-maps-usage.md`'s table)
was driven from a real build, not just read from the source:

| Option | Build | Observed |
| --- | --- | --- |
| `appToken` (valid) | `pnpm build` | inject + upload + delete, debug-id confirmed on disk + server |
| `appVersion` / `appBuild` | every build | `--version 1.0.0 --build <n>` forwarded to `bugsee-cli` (seen in its own stderr) |
| `endpoint` | every build | `https://apidev.bugsee.com` (staging only, never production) |
| `dryRun: true` | `build:dry-run` | no upload attempted; `.map` files survive |
| `disabled: true` | `build:disabled` | plugin does not run at all; no `debugId` comment in the shipped JS |
| `deleteMaps: false` | `build:keep-maps` | `.map` files survive a run (see F-2 below for why THIS run didn't get a confirmed upload) |
| `failOnError: true` + bad token | `build:bad-token-loud` | **the whole webpack build fails** (real exit code 2) — PLAN §5.7f |
| `failOnError: false` (library default) + bad token | `build:bad-token-soft` | contained: `onError` fires, webpack build exits 0, `.map`s are NOT deleted (privacy-safe on failure) |
| `BUGSEE_CLI_PATH` pointed at a self-SIGKILLing stand-in | `build:signal-kill` | **the whole build fails** — `code: -1` (`SIGNAL_EXIT_CODE`), `"terminated by signal SIGKILL"` — PLAN §5.7g, the `code ?? 0` regression guard confirmed still in place (`packages/bundler-plugin-core/src/run-cli.ts`'s `SIGNAL_EXIT_CODE`) |

Full detail, evidence and the two SDK defects found along the way (both real, both worked around
locally, neither fixed here) are in `FINDINGS.md`.

## Scenario coverage

See `scenarios.md` for the full table (every scenario id → control → expected Bugsee content →
verified/unverified with evidence, issue keys where applicable).

## Findings

See `FINDINGS.md`. Headline: two real defects in the shared bundler-plugin engine
(`@bugsee/bundler-plugin-core`), both reproducible from a stock webpack config with no exotic
settings — one breaks any build that also emits a CSS source map (the css-loader/
mini-css-extract-plugin default), the other makes a SECOND production build of an unchanged
vendor/dependency chunk fail forever once its debug-id has been uploaded once. Both are cross-cutting
(shared with `@bugsee/vite-plugin`); noted here per-sample, belongs in `samples/FINDINGS.md` too (not
edited here — the orchestrator aggregates).
