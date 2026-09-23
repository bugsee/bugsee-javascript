# Registering a JavaScript (formerly "web") build

Status: **BUILT (slices 1–4), 2026-09-23.** Written 2026-09-19. Closes §6 of
`docs/review/cli-js-flows.md` ("there is no build record for a web build").

> **What shipped, and where it departs from the design below** — read this first.
>
> - **The format is `js`, not `web`** (renamed 2026-09-23, bugsee-appserver#44, with migration 061
>   for the records written in between). A format names the ARTEFACT — Android's `aab`/`apk` are two
>   packagings of one platform, iOS's `ipa` a packaging — and a JavaScript build's artefact, bundles
>   plus maps, is the same shape whatever it runs on. This plugin registers browser bundles, SSR
>   server bundles (Vite `build.ssr`, Next/Nuxt server), Cloudflare/Vercel edge workers (esbuild),
>   bundled Node services and Electron's main process alike; `web` described only the first. The
>   runtime already lives on the APPLICATION (`type: javascript` with subtypes `browser`, `node`,
>   `service-worker`, …). If a build ever needs its own runtime — for instance to keep a client and a
>   server bundle of one package out of the same size baseline — it should be a separate field the
>   bundler states exactly (webpack `target`, esbuild `platform`, Vite `build.ssr`), never the format.
>   Unbundled Node/Bun (tsc, tsx) and Deno never reach this path: no bundler hook runs.
>   "Web build" throughout the ORIGINAL design below means this JavaScript build. The file keeps its
>   name because merged code in bugsee-appserver and bugsee-cli links to it.
>
> - **Four repos, not two.** The design put the `format: web` change in the CLI. The CLI never
>   validates `format`; it forwards the payload. The appserver's Build schema did, with
>   `enum: ['aab','apk','ipa']`, so a web registration failed Mongoose validation and was never
>   recorded — **bugsee-appserver#42** added it (as `web`, since renamed — see above) and derives the
>   baseline allowlist from the enum. **#43**: four MCP build tools restated the old list, so one web
>   build broke `list_builds` for its whole application; every consumer now reads
>   `dao.builds.getSupportedBuildsTypes()`.
>   The viewer's build list drew every non-`ipa` build as Android — **bugsee-web-viewer#64**.
>   CLI: **bugsee-cli#52** (register-only), released in **0.7.12** (bugsee-cli#54).
> - **D1 was not actually blocked.** The appserver treats `uuid` as an opaque dedup key — unique
>   index `(organization, application, uuid)`, replace-then-create, `uuid.v4()` when absent — and
>   nothing joins a crash to a build on it. So the only contract is "stable across a rebuild of the
>   same output". Built as designed with two refinements: the ids are read from the **bundles'**
>   `//# debugId=` comments rather than the maps (the maps are deleted after upload, so reading them
>   would force registration to run first — a privacy-ordering hazard), and the build id lives in its
>   **own** UUIDv5 namespace derived from the debug-id one, so the two kinds of id cannot collide. With
>   no ids (no maps, or a dry run) it falls back to the build's identity, as Android falls back to
>   manifest+variant. `build-id.ts`, `debug-ids.ts`.
> - **D2's signals were corrected against the bundlers' source.** Vite: resolved `isProduction`, not
>   `mode === 'production'` — `vite build --mode staging` defaults NODE_ENV to `production` and is a
>   production build. webpack: an UNSET `mode` is production — webpack never writes the default back to
>   `options.mode` but builds with `production = mode === "production" || !mode`
>   (`lib/config/defaults.js`), so reading the field alone would have skipped those builds.
> - **D3 starts at the build output**, not the process cwd: the nearest package.json above
>   `apps/site/dist` is the package that built it, while cwd in a monorepo is usually the workspace
>   root. `projectRoot` overrides it.
> - Verified end to end against the real 0.7.12 binary and a local mock collector: a dry run makes no
>   request; a real one makes exactly one `POST /v2/apps/<token>/builds` with the payload plus the
>   CLI's own `request_artifact_upload: false`.
>
> **Known limitation.** Registration is per OUTPUT DIRECTORY, because that is the unit a bundler's
> write hook reports. A build that writes two outputs (a Vite SSR config, or a meta-framework's
> client + server passes) registers two builds with different ids. No meta-framework adapter wires the
> plugin yet (§8 of the audit), so plain Vite/webpack builds are unaffected today; it needs deciding
> before one does.
>
> **Follow-up.** `@bugsee/bundler-plugin-core` still pins `@bugsee/bugsee-cli ^0.7.11`, because
> 0.7.12 was not yet on npm and a frozen-lockfile install cannot resolve an unpublished version.
> Against 0.7.11 a release build's registration fails (no `--artifact`) and is contained as a warning.
> Bump to `^0.7.12` once it is published.

Product direction (2026-09-19): **a web build SHOULD register a build, and by default only a release
one.** The Android Gradle plugin and the iOS agent are the reference for both the principles and the
wire shape; this document records what they actually do, what translates, and what has to be built
before a JS build can register at all.

## 1. What the reference implementations do

Read from `android/gradle-plugin/src/main/kotlin/...`, `ios/.../BugseeAgent`, and the CLI they both
drive. Citations are to those repos.

**Registration is ON by default, gated only on "release-like".** Neither platform asks the integrator
to opt in, neither gates on CI, and neither gates on a token being present (the CLI rejects a missing
token itself).

| | Android | iOS |
|---|---|---|
| release test | `!buildType.isDebuggable` (AGP's own flag), name fallback `!contains("debug")` — `BugseePlugin.kt:1139-1150` | `$CONFIGURATION` lowercased **starts with** `release` — `BugseeAgent:3801-3807` |
| override | `buildInfo.allBuildTypes = true` (default false) | `BUGSEE_BUILD_INFO_ALL_CONFIGURATIONS=1` |
| master switch | `buildInfo.enabled` (default **true**) | `BUGSEE_BUILD_INFO_ENABLED` (default **on**) |
| extra gate | — | archive only (`ACTION == install`), unless `BUGSEE_BUILD_INFO_ALL_ACTIONS=1` |

**Shipping the artifact's BYTES is a separate feature, default OFF.** `sizeAnalysis.enabled` /
`BUGSEE_SIZE_ANALYSIS_ENABLED` is what becomes `request_artifact_upload`. Registration without bytes
is the normal case.

**A failed registration never fails the build.** Android logs and swallows
(`BundleUploadTask.kt:770-772`); the iOS agent double-forks into a detached daemon before doing
anything, so it *cannot* fail the build. The single deliberate exception is a size-check FAIL, and it
runs AFTER the upload on purpose so the failing build still lands server-side.

**The payload** (`BundleUploadTask.kt:599-641`, `BugseeAgent:3899-3974`):
`{uuid, package_id, version, build, build_configuration, format, artifact_size,
request_artifact_upload, has_mapping?, vcs?, build_metadata?, request_*_upload?,
dependencies_summary?}`, with `dependencies.json` / `timings.json` as sidecars.

**Dedup is server-side on `uuid`** — "replace-then-create", which is why the registration POST is
retried on transport errors but never on a 5xx (`upload/build.rs:276-279`). Android's `uuid` is
deterministic (derived from `mapping.txt`, else manifest+variant+plugin version), so a rebuild of
identical bytes replaces rather than duplicates. iOS's is the linker's `LC_UUID`, so a rebuild makes
a new record. **Android's determinism is the property to copy.**

**`--sidecar NAME=PATH`** is the designed extension point — the worker tolerates unknown entry names.

## 2. What translates to a web build, and what does not

Translates cleanly: `uuid` (an opaque 32-hex string), `version`, `build_configuration`,
`artifact_size`, the whole `vcs` block (already collected — `bundler-plugin-core/src/vcs.ts`),
`build_metadata.{machine, plugin_version, build_system_version}`, and both sidecars —
`dependencies.json` maps onto a pnpm/npm lockfile, `timings.json` onto bundler phases.

Does not:

- **`format`** is only ever `aab` / `apk` / `ipa`. A web value (`web`) has to be added, and the
  size-check baseline query **hardcodes `format=ipa`** (`size_check.rs:281`), so a web build gets no
  baseline until that is parameterised.
- **`package_id`** is a reverse-DNS bundle id, and it is the size-check scoping key
  `(package_id, format, build_configuration)`. A web build has no such id. Proposal: the package name
  from the nearest `package.json` (`name`, scope included), falling back to the app token's own
  project — recorded here as **D3** because it is a backend-visible key.
- **`build`** is Android's `versionCode` / iOS's `CFBundleVersion` — a monotonic integer. The JS SDK
  already has `appBuild` (default `'0'`, from `BUGSEE_APP_BUILD`), so this slot exists; it is just
  usually unset. No change needed, but a build that never sets it registers everything under `0`.
- **`uuid`**: neither derivation exists for JS. There is no `mapping.txt` and no `LC_UUID`. See D1.
- **`has_mapping`**, **`--mapping`** (hardcoded ZIP entry `mapping.txt`), **`--icon`**,
  **`build_sdk_version`**: mobile-only, omit.

## 3. The blocker: `upload build` cannot register without shipping bytes

`upload build` requires `--artifact` (clap-required, `cli/upload.rs:80-84`) and **always** sends
`request_artifact_upload: true` — `upload.rs:252-253`:

```rust
// `upload build` exists to ship the artefact — always request it.
request_artifact_upload: true,
```

The register-only mode exists in Rust (`build::Params.request_artifact_upload`) and is used by
`xcode post-action`, but **no CLI surface exposes it**. So the normal case for every other platform —
register the build, ship no bytes — is exactly the case a web build cannot express today.

That makes the CLI work a prerequisite, not an afterthought.

## 4. Decisions

**D1 — the build `uuid` is derived from the build's debug-ids.** Sorted, then UUIDv5 over the joined
list, in the same namespace `sourcemaps inject` already uses. Deterministic (the property Android
has), needs no new bundler integration (the ids are already stamped and already uploaded), and the
membership is the natural join: every JS crash frame carries a debug-id, so a backend that records
which ids belong to a build can answer "which deploy" without a new field on the crash.
**Gated on backend confirmation** — if the join is meant to be `(version, build)` instead, this
becomes a random-per-build id and D1 is moot. Filed with [#8] (the §5 commit-SHA issue) because both
are the same conversation about what a build record is keyed by.

**D2 — release detection is the bundler's own production signal**, which is the closest analog to
AGP's `isDebuggable`: Vite `config.mode === 'production'`, webpack `compiler.options.mode ===
'production'`, otherwise `process.env.NODE_ENV === 'production'`. NOT minification, and NOT a name
match on an output directory. Override: `registerBuild: 'always' | 'release' | false`, default
`'release'` — one option rather than Android's two (`enabled` + `allBuildTypes`), because a tri-state
says the same thing without a second switch to reconcile.

**D3 — `package_id` is the package name** from the nearest `package.json`, scope included
(`@acme/web-app`). It is only a scoping key for size analysis; being stable matters more than being
reverse-DNS.

**D4 — failure is contained, exactly as on mobile.** Registration runs inside the same
`try`/`onError` the source-map upload already uses, and `failOnError` opts into a hard failure. No
size-check for web in the first slice (there is no artifact to measure, and the baseline query is
`ipa`-only anyway).

**D5 — no artifact bytes in the first slice.** `request_artifact_upload: false` always. Web bundle
size analysis is a separate feature with its own questions (which of 200 chunks is "the artifact"?),
and shipping a tarball the worker's extension-keyed parsers cannot read would be worse than shipping
nothing.

**D6 — the sidecars come later.** `dependencies.json` from a lockfile and `timings.json` from bundler
phases are additive (`--sidecar NAME=PATH`), and neither is needed for a build to exist.

## 5. Slices

1. **CLI: `upload build --no-artifact`** (or `--register-only`) — allow registration with no artifact
   path, sending `request_artifact_upload: false`. Add `web` to the accepted `format` values and
   parameterise the size-check baseline's hardcoded `ipa`. Ships in one CLI release with slice 2.
2. **CLI: `--format web`** end-to-end, with the payload fields a web build can supply and a dry-run
   golden test. (1 and 2 are one PR; they are the same change seen from two sides.)
3. **JS: `registerBuild` in `@bugsee/bundler-plugin-core`** — D2's release detection, the payload from
   `package.json` + resolved options + the VCS metadata already collected, driven through the CLI
   after the source-map upload, contained per D4.
4. **JS: wire it into the bundler plugins** (`vite-plugin`, `webpack-plugin`) so the production signal
   is read from the real bundler config rather than an env var.
5. Later, separately: sidecars (D6), and whatever the D1 conversation decides about the join key.

## 6. Open, and deliberately not decided here

- The join key (D1) needs the backend's answer; `[#8]` carries it.
- Whether a web build should participate in the Android/iOS **producer handshake**
  (`build-actions.json`, read by the fastlane plugin to avoid double work). Nothing in the JS flow
  reads or writes it today, and no second producer exists for a web build, so it is out of scope
  until one does.

[#8]: https://github.com/bugsee/bugsee-javascript/issues/8
