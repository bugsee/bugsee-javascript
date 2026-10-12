# webpack-sourcemaps — Markdown Notes

A real webpack 5 app built to exercise `@bugsee/webpack-plugin` and `@bugsee/bundler-plugin-core` —
Deliberately **not** a
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

> **Repeat builds work as of `bugsee-cli` 0.7.8.** Before it,
> every build after the first failed: an unchanged vendor chunk's already-uploaded map was a hard error
> (`DuplicateSymbolsFoundError`, exit 30) that aborted the whole upload batch, and a CSS source map did the
> same (exit 11), which is why this sample used to turn CSS source maps off in production. 0.7.8 skips a
> map the server already has and skips `.css.map` files, so the batch completes and `deleteMaps` runs.
> Re-verified against staging 2026-09-17 with CSS source maps ON: two consecutive production builds both
> exited 0 and left no `.map` in `dist/`, and a manual upload of a kept-maps build logged
> `skipping a stylesheet / type-declaration map … main.<hash>.css.map` and
> `upload complete uploaded=0 already_existed=3 skipped=1`.
>
> pnpm 11 refuses packages published less than a day ago, so until 2026-09-18 a clean install resolves
> an OLDER `bugsee-cli` (0.7.6 at the time of writing) — install with
> `pnpm install --config.minimum-release-age=0` to get 0.7.8 before then.

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
table (LOCAL/WIRE level, plus the Backend/MCP verification done by hand against the
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
back a count. A presence WebSocket announces "someone is editing" (real bidirectional traffic).
A dedicated `#/scenarios` route is the SDK **Scenario panel** — one control per scenario. **Session
replay is covered too:** replay is now ON BY DEFAULT in `@bugsee/browser`,
so this sample records a session and uploads `replay.bin` in every bundle whether or not it asks to,
and `pnpm verify` asserts that at wire depth rather than leaving a real
recording of the page unexamined. It needs no Scenario-panel control of its own: the recording is a
property of the whole run, so the checks read the bundle an ordinary `s4-error` report uploads.

The local API (`server/api-server.mjs`, plain `node:http`, no framework) also hosts a handful of
`/api/scenario/*` routes purpose-built for network-capture edge cases (4xx, 5xx, no-Content-Type, an oversized body,
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

## The source-map half — the heart of this sample

`webpack.config.js` wires `bugseeWebpackPlugin` from `@bugsee/webpack-plugin` with every
`BugseePluginOptions` field reachable from an env var (see the `pnpm build:*` variants above), on top
of a production `devtool: 'hidden-source-map'` (a real `.map` is written next to each chunk, but the
shipped bundle carries NO `//# sourceMappingURL=` comment).

**End to end, verified against real staging (`SWEBPACK`):**

1. `pnpm build` — the plugin runs `bugsee-cli sourcemaps inject` (writes a `//# debugId=<uuid>` comment
   + the `_bugseeDebugIds` runtime stub into every JS chunk) then `bugsee-cli debug-files upload`
   (uploads the real maps, keyed by debug-id), then deletes the client `.map` files — **only once the
   WHOLE batch's upload succeeds**. A build whose upload fails therefore keeps its `.map` files on disk.
2. `pnpm preview` serves that exact production bundle; `pnpm verify:sourcemaps` clicks the Scenario
   panel's `s4-error` control (it throws `new Error('S4: logException(new Error(...))')` from
   `src/scenarios.ts`, inside the minified, hidden-source-mapped bundle) and flushes.
3. The backend shows the issue symbolicated to the original source line, not to a hashed chunk location:

   ```
   # Summary
   Handled Error at HTMLButtonElement.<anonymous> () (webpack://@bugsee-samples/webpack-sourcemaps/./src/scenarios.ts:375)
   ```

   `symbolication_status` is `ready`. The same issue gained a new event from a bundle whose every chunk hash
   had changed, with the same original-source frame.

For contrast, a probe run against a `pnpm build:dry-run` output (a production bundle whose maps were
deliberately never uploaded) produces a summary with a raw minified location such as
`assets/main.<hash>.js:1:184731`, under a separate issue. An unsymbolicated stack groups by the hashed chunk
rather than by the original source line; that is the failure this sample exists to show does not happen on a
real `pnpm build`.

**Plugin options in full** — every one of `BugseePluginOptions`
**as of the source-map milestone** was driven from a real build, not just read from the source. The five
VCS options added later (`vcs`, `commit`, `allowDirtyCommit`, `projectRoot`, `onNotice`) are covered by
unit + real-git tests in `@bugsee/bundler-plugin-core` but are **not** exercised here yet:

| Option | Build | Observed |
| --- | --- | --- |
| `appToken` (valid) | `pnpm build` | inject + upload + delete, debug-id confirmed on disk + server |
| `appVersion` / `appBuild` | every build | `--version 1.0.0 --build <n>` forwarded to `bugsee-cli` (seen in its own stderr) |
| `endpoint` | every build | `https://apidev.bugsee.com` (staging only, never production) |
| `dryRun: true` | `build:dry-run` | no upload attempted; `.map` files survive |
| `disabled: true` | `build:disabled` | plugin does not run at all; no `debugId` comment in the shipped JS |
| `deleteMaps: false` | `build:keep-maps` | `.map` files survive a run |
| `failOnError: true` + bad token | `build:bad-token-loud` | **the whole webpack build fails** (real exit code 2) |
| `failOnError: false` (library default) + bad token | `build:bad-token-soft` | contained: `onError` fires, webpack build exits 0, `.map`s are NOT deleted (privacy-safe on failure) |
| `BUGSEE_CLI_PATH` pointed at a self-SIGKILLing stand-in | `build:signal-kill` | **the whole build fails** — `code: -1` (`SIGNAL_EXIT_CODE`), `"terminated by signal SIGKILL"` — the `code ?? 0` regression guard is in place (`packages/bundler-plugin-core/src/run-cli.ts`'s `SIGNAL_EXIT_CODE`) |
