# Source-map upload tooling (task #158)

Status: **Draft v2** (2026-07-09). Rewritten after finding the existing Rust `bugsee-cli`. Read alongside
`docs/design/sdk-design.md` + the framework/meta-framework adapter docs (their P6 "build integration" depends on this).

## 1. Problem

Production JS ships minified. To symbolicate a captured stack trace, Bugsee's backend needs the build's
source-maps, uploaded out-of-band, and a **join key** tying a runtime stack frame to the right map. The SDK runtime
never uploads maps — this is a build-tool concern.

## 2. The engine already exists: the Rust `bugsee-cli`

**`bugsee-cli` v0.7.1** (`/Users/alexeykarimov/Projects/Bugsee/bugsee-cli`, binary `bugsee-cli`, npm-distributed via
cargo-dist under the `@bugsee` scope — the `@sentry/cli` model) already does the **entire** pipeline:

- **`bugsee-cli sourcemaps inject <dir…> [--dry-run]`** — injects debug-IDs: appends `//# debugId=<uuid>` to each
  `.js`/`.cjs`/`.mjs`, embeds `debug_id`+`debugId` into each `.map`, and emits the runtime stub
  `globalThis._bugseeDebugIds[Error().stack] = <uuid>`. The debug-ID is a **deterministic UUIDv5 content hash** →
  reproducible → idempotent.
- **`bugsee-cli [--app-token <t>] [--endpoint <url>] debug-files upload <dir…> --type sourcemaps --version <v>
  --build <b> [--uuid <id>] [--no-zstd] [--force] [--dry-run]`** — discovers `.map`s, reads the debug-ID + sha1, packs a
  zstd zip, and runs the two-stage `POST /v2/apps/{token}/symbols {uuid,version,build,hash}` → presigned `PUT`,
  `16004`-idempotent.
- Global `--app-token` (env `BUGSEE_APP_TOKEN`) + `--endpoint` (env `BUGSEE_ENDPOINT`, default `https://api.bugsee.com`).

**Decision (D0): the JS side does NOT reimplement any of this.** No JS upload/discovery/pack/inject. The plugins
**collect context and SPAWN `bugsee-cli`** — exactly like `@sentry/webpack-plugin` shells out to the Rust `sentry-cli`.
(An earlier v1 draft reimplemented upload+discovery in a `@bugsee/cli` JS package; that was removed once `bugsee-cli`
was found — it duplicated the Rust engine and collided on the npm name.)

## 3. Identity model (decided)

**Debug-ID-primary** (what `bugsee-cli` injects/uploads) with an `appVersion`/`appBuild` fallback. Rationale
(competitive research, v1 §2): debug-IDs are the TC39 standards-track key, natively supported by every major bundler,
and the web analog of Android's `BUILD_UUID` — a per-build UUID reported at runtime, matched server-side, slotting into
the existing `/v2/apps/{token}/symbols` envelope as `uuid`. `bugsee-cli` already computes it as a UUIDv5 content hash.

## 4. Architecture (spawn model)

```
 build (vite/webpack)
   │  @bugsee/vite-plugin | @bugsee/webpack-plugin  (thin unplugin entries)
   │     └─ @bugsee/bundler-plugin-core  (unplugin factory)
   │           ├─ collect context { outDir, appToken, appVersion, appBuild, endpoint, deleteMaps, dryRun }
   │           ├─ resolve the bugsee-cli binary (dep @bugsee/bugsee-cli, or PATH / BUGSEE_CLI_PATH)
   │           ├─ after the bundle is written:  spawn `bugsee-cli sourcemaps inject <outDir>`
   │           ├─ then:                          spawn `bugsee-cli debug-files upload <outDir> --type sourcemaps …`
   │           └─ delete client `.map`s by default (privacy)
   ▼
 bugsee-cli (Rust) — the engine: inject → discover → pack → POST /v2/apps/{token}/symbols → presigned PUT
```

**Runtime side (SDK, JS):** the one piece `bugsee-cli` can't do — read the injected `globalThis._bugseeDebugIds`
registration (maps a script's own `Error().stack` → its debug-ID) and stamp `debugId` onto each captured `StackFrame`
so the report carries it and the server matches per frame. `StackFrame` gains an optional `debugId`. No plugin ⇒ no
debugId ⇒ server falls back to `appVersion`/`appBuild`.

**Packages:**
- `@bugsee/bundler-plugin-core` — unplugin factory + a `bugsee-cli` **resolver/spawner** (`runBugseeCli(args, opts)`)
  + context collection + the inject→upload→delete orchestration. `@bugsee/bugsee-cli` (the cargo-dist binary) is an
  optional dependency; also resolvable from PATH / `BUGSEE_CLI_PATH`.
- `@bugsee/vite-plugin` / `@bugsee/webpack-plugin` — per-bundler entry points (`unplugin/vite`, `unplugin/webpack`).

## 5. Decisions

| # | Decision | Why |
|---|---|---|
| **D0** | Spawn the existing Rust `bugsee-cli`; **no JS reimplementation** | The engine exists + is npm-distributed; user's architecture (plugins collect, CLI packs+uploads). |
| **D1** | Debug-ID-primary + appVersion/appBuild fallback | §3 — standards-track, bundler-native, Android-aligned; what `bugsee-cli` already does. |
| **D2** | Plugins built on `unplugin` over a shared `@bugsee/bundler-plugin-core` | One core, many bundlers (vite/webpack now; rollup/esbuild/rspack later — meta-framework adapters need rollup). |
| **D3** | Injection = `bugsee-cli sourcemaps inject` run after the bundle is written | The CLI owns injection (single owner, no double-inject). |
| **D4** | Delete client `.map`s by default after upload | Privacy. Opt-out flag. |
| **D5** | Binary resolution: `@bugsee/bugsee-cli` dep → `BUGSEE_CLI_PATH` → PATH; a clear error if unresolved | Works in CI + local; spawn-only (no JS fallback, per decision). |
| **D6** | The runtime debug-ID attach is a SEPARATE, SDK-side slice | It's the only piece the CLI can't do; keep it decoupled from the build tooling. |

## 6. Slice plan (each: design → red test → green → per-entity mutator loop → review → commit)

- **SM-A — `@bugsee/bundler-plugin-core`.** (a) `runBugseeCli(args, {token, endpoint, cwd, dryRun})` — resolve the binary
  (`@bugsee/bugsee-cli` → `BUGSEE_CLI_PATH` → PATH), spawn via an injectable `spawn` seam, surface exit code/stderr;
  (b) `uploadSourcemaps(context)` — orchestrate `sourcemaps inject` → `debug-files upload --type sourcemaps` → delete
  `.map`s; (c) the unplugin factory that wires build-end → `uploadSourcemaps`. Test-first with a fake spawn (no real
  binary): assert argv + ordering + delete + error handling.
- **SM-B — `@bugsee/vite-plugin`** — vite entry over the core (`unplugin/vite`). Resolve outDir/version from vite config.
- **SM-C — `@bugsee/webpack-plugin`** — webpack entry over the core (`unplugin/webpack`).
- **SM7 — runtime debugId attach.** `StackFrame.debugId`; core reads `globalThis._bugseeDebugIds` (the injected stub) and
  stamps frames; report carries it; wire protocol. Fallback: no plugin ⇒ no debugId.
- **SM8 — e2e.** Build a fixture with the plugin; run against a **fake `bugsee-cli`** (a stub script that records argv +
  writes a marker) to assert the plugin drives inject+upload correctly without needing the real Rust binary; plus a
  runtime test that a report carries a debugId injected into a fixture bundle.

## 7. Deferred
- A real-`bugsee-cli` integration e2e (needs the built Rust binary in the harness) — follow-up once CI has it.
- Turbopack loader for Next.js (`turbopack.rules`) — Next-adapter follow-up.
- rollup/esbuild/rspack plugin entries (trivial once the core exists — meta-framework adapters' P6 wires them).
- Tunnel option (proxy uploads through the app origin) — opt-in, hardened, later.
