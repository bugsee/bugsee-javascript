# Adversarial review — @bugsee/bugsee (umbrella)

**Reviewed:** 2026-07-27 · **Scope:** packages/bugsee (impl 371 LOC across `index.ts`/`index.node.ts`/`launch.ts`/`node.ts`/`wire.ts`, tests 801 LOC across 3 files, 34 tests, 100% line/branch/fn coverage)
**Verdict:** The two claims I was asked to re-verify both hold: the `wire.ts` → `@bugsee/browser` leak is genuinely fixed (a fresh build of `index.node.{js,cjs}` pulls in `@bugsee/node` only — the `dist/` currently sitting in the repo is a **stale pre-fix artifact** from Jul 23, one day older than the fix commit `5fb6fe3`), and the dual-package hazard is genuinely neutralized by the carrier (empirically: `require()` and `import()` yield two different `launch` functions but converge on one client, and a directly-installed `@bugsee/node` converges on it too). What is *not* right is the resolution matrix. The `exports` map implements 3 of the 7 conditions the design spec prescribes (`docs/design/sdk-design.md:346-364`): `bun`, `deno`, `workerd`, `edge-light`, and `worker` are all absent. Bun and Deno therefore silently load the plain Node SDK — empirically verified on bun 1.3.14 and deno 2.8.3, where the wire reports `platform.type:"node"` with the *node-compat* version (Bun 1.3.14 reports itself as Node 24.3.0) and `Bun.serve` is left unwrapped. Worse, **nothing can catch this class of defect**: I pointed the `node` condition at the browser entry — the single most consequential mutation possible in this package — and all 34 umbrella tests, the react/express single-install tests, and `tsc --noEmit` passed. The package's one job is unverified. Separately, APM is on by default here and ships `@bugsee/performance`'s single-slot `getActiveSpan` into Node, where `instrumentIncomingRequests` (also default-on) opens one transaction per incoming request; I reproduced two concurrent `http.server` transactions collapsing into one slot through the umbrella's own install path. Three packages in the umbrella's install closure (`replay`, `replay-canvas`, `rrweb`) have no `publishConfig`, so their published `exports` point at `./src/` which `files:["dist"]` never ships — bundling the browser entry fails to resolve today. OTel is correctly opt-in, so the `traceId.slice(0,16)` defect is *not* shipped by default.

## SEV1

### 1. No `bun`/`deno`/`workerd`/`edge-light`/`worker` exports conditions — Bun and Deno silently get the Node SDK
- **Where:** `packages/bugsee/package.json:10-29` (dev map) and `packages/bugsee/package.json:44-87` (`publishConfig`, the map that actually ships)
- **What:** The map defines exactly three conditions — `browser`, `node`, `default`. `docs/design/sdk-design.md:346-364` prescribes seven, in a specific priority order (`workerd`, `edge-light`, `worker`, `deno`, `bun`, `node`, `browser`), and explicitly states the umbrella "routes to `@bugsee/browser` or `@bugsee/node` or `@bugsee/cloudflare` based on the consumer's bundler conditions". Five of those seven are missing. `@bugsee/bun` and `@bugsee/deno` are unreachable from the umbrella by construction.
- **Why it matters:** `@bugsee/bun/src/launch.ts:20-35` and `@bugsee/deno/src/launch.ts:21-36` each contribute exactly two things the node composition cannot: the runtime **identity probe** (`platformType()` → `'bun'`/`'deno'` plus the real runtime version) and the **native serve interceptor** (`createBunServeInterceptor` / `createDenoServeInterceptor`), concatenated into `serverInstrumentations`. Via the umbrella both are skipped. `packages/node/src/environment.ts:31-33` hardcodes `platformType: () => 'node'` and `runtimeVersion: () => process.versions.node`. So every Bun/Deno session is mis-attributed on the wire, and any idiomatic `Bun.serve({fetch})` / `Deno.serve()` app — which never touches `node:http` — gets **no incoming-request instrumentation at all** (no per-request context, no `http.server` transaction), despite `instrumentIncomingRequests` being documented as default-on.
- **Evidence (empirical, real binaries):**
  - Synthetic probe against the exact `publishConfig` map: node ESM/CJS, **bun 1.3.14**, and **deno 2.8.3** all resolve `.` → `index.node.*`. Bun and Deno both match the `node` condition.
  - Real built package, staged as npm would publish it, `import('@bugsee/bugsee')`:
    - bun → `platform = {"type":"node","version":"24.3.0",…}` (running Bun 1.3.14)
    - deno → `platform = {"type":"node","version":"24.15.0",…}` (running Deno 2.8.3)
    - node → `platform = {"type":"node","version":"24.15.0",…}`
  - Under bun, `String(Bun.serve).includes('native code') === true` after `launch()` — the wrap is absent.
  - esbuild condition probes: `workerd,worker,browser` → BROWSER entry; `edge-light,worker,browser` → BROWSER entry; `worker,browser` → BROWSER entry; `react-native` → BROWSER entry. A Cloudflare/Vercel-Edge/Web-Worker consumer who reaches for the umbrella gets the full DOM browser SDK rather than `@bugsee/cloudflare` / `@bugsee/vercel-edge` / `@bugsee/webworker`.

### 2. Nothing in the repo can detect a broken `exports` condition
- **Where:** `packages/bugsee/src/public-api.test.ts:5-6` (`from './index'`), `packages/bugsee/src/launch.test.ts` (`from './launch'`), `packages/bugsee/src/node.test.ts:5` (`from './node'`)
- **What:** Every test in the package imports by **relative path**, which bypasses the `exports` map entirely. The map is the package's sole reason to exist, and no test — here or anywhere in the monorepo — asserts that a given condition set lands on the intended entry.
- **Why it matters:** This is the mechanism by which finding #1 shipped unnoticed, and it leaves the door open for any future edit to the map to silently re-point a whole runtime family.
- **Evidence (mutation, applied then fully reverted):** I rewrote `exports["."].node` to `{"types":"./src/index.ts","import":"./src/index.ts"}` — i.e. **every Node consumer silently receives the browser SDK**:

  | check | result |
  |---|---|
  | `pnpm --filter @bugsee/bugsee exec vitest run` | 34 passed |
  | `@bugsee/react` reexport test | 2 passed |
  | `@bugsee/express` reexport test | 1 passed |
  | `pnpm --filter @bugsee/bugsee exec tsc --noEmit` | clean |
  | `pnpm --filter @bugsee/express exec tsc --noEmit` | clean |

  **Control proving the harness works:** deleting the `"./node"` subpath instead produces `Error: "./node" is not exported under the conditions ["node","development","import"]` and fails the express suite immediately. So the harness detects *structural* breakage but is blind to a *mis-targeted* condition.

### 3. APM is on by default and ships `@bugsee/performance`'s single-slot `getActiveSpan` into Node
- **Where:** `packages/bugsee/src/wire.ts:205-221` (`wirePerformance` unconditionally, `monitoring` defaulting true), `packages/bugsee/src/node.ts:27` (`{ pageload: false, startupAtMs }`), `packages/bugsee/src/wire.ts:214` (`networkSource: internals.network.interceptor`)
- **What:** The umbrella's whole value proposition is that `launch()` turns the extensions on. On Node that means the performance extension is registered for every consumer who never asked for APM, and it is wired to the network interceptor for http client spans.
- **Why it matters:** `packages/performance/src/controller.ts:118-128` holds a **single** module-level `active` slot; `startTransaction` overwrites it and `getActiveSpan()` returns only the most recent. `packages/node/src/server-instrument.ts:126` resolves `client.ext('performance')` and `:396` calls `perf.startTransaction(...)` per incoming request, and `packages/node/src/launch.ts:784` makes that default-on (`instrumentIncomingRequests !== false`). Under any concurrency the in-flight request's transaction is displaced, so child spans and any span-sourced correlation attach to the wrong request. This is a confirmed upstream SEV1 that the umbrella turns on for everybody.
- **Evidence (through the real staged package, node ESM):**
  ```
  APM extension present without asking for it: true
  after 2 concurrent server txns, getActiveSpan() is: GET /b
    === B (the LATER request)? true
    === A (the request still in flight)? false
  ```
- **Note (clean):** the umbrella is *correct* not to wire the perf-sourced traceparent decorator on Node — `wire.ts:261` gates it on `platform.pageload`, with an explicit comment explaining the concurrency hazard, and `node.test.ts:173-206` asserts it. That guard is the right instinct; it just was not extended to the transaction slot itself.

## SEV2

### 4. `tsc` under `moduleResolution: bundler` gives Node consumers the **browser** types while the runtime resolves the **node** entry
- **Where:** `packages/bugsee/package.json:11-24` — condition order `browser` → `node` → `default`; TypeScript's bundler mode applies neither `browser` nor `node`, so it falls through to `default`, which points at the browser entry.
- **What:** Confirmed by `--traceResolution`: `bundler` → `Saw non-matching condition 'browser'. Saw non-matching condition 'node'. Matched 'exports' condition 'default'.` → `dist/index.d.ts` (browser). `node16`/`nodenext` → `Matched 'exports' condition 'node'` → `dist/index.node.d.ts` (correct). `node10` → falls back to the top-level `"types": "./dist/index.d.ts"` (browser) while `"main": "./dist/index.node.cjs"` loads the **node** runtime.
- **Why it matters:** This is a silent, bidirectional DX failure for a Node app configured with `moduleResolution: bundler` (the repo's own `tsconfig.base.json:6` default, and the default in most Vite/Next app templates). Verified against the real built `.d.ts`:
  ```
  moduleResolution=bundler:  ts/app.ts: error TS2353: 'dataDir' does not exist in type
                             'BugseeLaunchOptionsWithPerformance'      <- a REAL, supported Node option rejected
                             ts/app2.ts: (compiles)  replay:{blockAllMedia:true}  <- a browser-only option ACCEPTED,
                                                                                    does nothing on Node
  moduleResolution=nodenext: ts/app.ts: (compiles)
                             ts/app2.ts: error TS2353: 'replay' does not exist in type 'BugseeNodeLaunchOptions'
  ```
  The `/node` subpath is the documented workaround and it does work (`./node` has no `browser` condition, so every resolver lands on the node entry) — but only backend *adapters* use it. A consumer importing `@bugsee/bugsee` directly in server code has no signal that the types they see describe a different platform than the code they run. Adding an explicit `"types"` fallback ordered *before* `default`, or ordering `node` before `browser`, would close it.

### 5. Three packages in the umbrella's install closure have no `publishConfig` — published `exports` point at `./src/`, which is never shipped
- **Where:** `packages/replay/package.json`, `packages/replay-canvas/package.json`, `packages/rrweb/package.json` — all three declare `"exports": {".": {"types":"./src/index.ts","import":"./src/index.ts"}}` and `"files": ["dist"]`, with **no `publishConfig`** to swap them at publish time. The other 15 packages in the closure all have one.
- **What / Why it matters:** All three are runtime `dependencies` of `@bugsee/browser` (`packages/browser/package.json`), so they land in every frontend consumer's install tree via the umbrella. `packages/browser/src/launch.ts:454` does `void import('@bugsee/replay')` and `:449-455` a nested `import('@bugsee/replay-canvas')`. A bundler resolves dynamic-import specifiers **statically, regardless of the runtime gate**, so this breaks the build for every browser consumer whether or not they enable replay.
- **Evidence:** Staging the closure exactly as npm would publish it (applying `publishConfig` where present) and bundling the browser entry with esbuild:
  ```
  ✘ [ERROR] Could not resolve "@bugsee/replay-canvas"
      node_modules/@bugsee/browser/dist/index.js:708:51
  ```
  Everything is currently `"private": true` at version `0.0.0`, so nothing is live — this is a latent defect that blocks the first publish rather than a shipped one. Ranked SEV2 for that reason; it becomes SEV1 the moment publishing is attempted.

### 6. The frontend adapters' single-install tests exercise the **node** entry, not the browser entry they ship
- **Where:** `packages/react/src/reexport.test.ts:1` (`import * as umbrella from '@bugsee/bugsee'`), identically in `vue`/`svelte`/`solid`/`angular`; `packages/react/vitest.config.ts` (`environment: 'node'`)
- **What:** Under vitest the resolver applies conditions `["node","development","import"]` (visible verbatim in the M4 control error above), so the bare `@bugsee/bugsee` specifier resolves to `src/index.node.ts` — the entry a React app will *never* load.
- **Evidence (mutation, reverted):** removing `launch` from `src/index.node.ts` **only** (leaving the browser `src/index.ts` untouched) fails the **React** suite:
  ```
  FAIL src/reexport.test.ts > @bugsee/react single-install re-export
  AssertionError: expected 'undefined' to be 'function'
  ```
  A browser-entry-only defect is the mirror image: it would pass. The tests are self-consistent (`adapter` and `umbrella` resolve the same way), which is exactly why they cannot detect a divergence.
- **Why it matters:** combined with #2, the browser entry `src/index.ts` → `src/launch.ts` → `@bugsee/browser` is verified only via the umbrella's own relative-path imports. No test anywhere reaches it through the specifier a customer uses.

### 7. Node umbrella `launch()` changes host-process semantics with no granular opt-out
- **Where:** `packages/bugsee/src/node.ts:18` → `packages/node/src/launch.ts:635-636`; `packages/node/src/detection-providers.ts:78-80` (`UnhandledRejectionProvider.controllingOption = BugseeOption.DetectCrash`)
- **What:** Registering *any* `unhandledRejection` listener suppresses Node's default crash. The provider's `controllingOption` is shared with `UncaughtExceptionProvider`, so the only way to opt out is `detectCrashes: false` (`packages/core/src/options.ts:78`, default `true`), which also disables crash reporting entirely. The umbrella surfaces no separate option — `BugseeNodeLaunchOptions` (`packages/bugsee/src/node.ts:11`) only extends `BugseeLaunchOptions`.
- **Evidence (through `import { launch } from '@bugsee/bugsee'`):**
  ```
  --- WITHOUT SDK ---            exit code = 1     (process crashes, as Node intends)
  --- WITH umbrella launch() --- exit code = 0     "STILL ALIVE after unhandled rejection"

  --- process pinning ---        PROCESS STILL RUNNING after 8s -> PINNED
  ```
  A script that would exit immediately never exits after `launch()`. Both are `@bugsee/node` defects; the umbrella is the vehicle that ships them and the place a customer would look for the knob.

## SEV3

### 8. Dead, duplicated defaults in `wire.ts` — two mutations survived
- **Where:** `packages/bugsee/src/wire.ts:210-212`
  ```ts
  monitoring:      perf.options.get(PerformanceOption.Monitoring,    true),
  sampleRate:      perf.options.get(PerformanceOption.SampleRate,    1),
  flushIntervalMs: perf.options.get(PerformanceOption.FlushIntervalMs, 30000),
  ```
- **What:** `packages/performance/src/options.ts:32-39` already supplies `Monitoring: true`, `SampleRate: 1`, `FlushIntervalMs: 30000` in `PERFORMANCE_OPTION_DEFINITIONS`, which `resolveLaunchOptions` applies. The inline fallbacks are therefore unreachable — and if they ever drift from the canonical definitions, nothing notices.
- **Evidence:** flipping `Monitoring, true` → `Monitoring, false` and `SampleRate, 1` → `SampleRate, 0` each left **34/34 passing**. Both survived precisely because the value never comes from that argument. (Contrast: 8 other `wire.ts` mutations were all caught — see below.)

### 9. The startup transaction's duration is never asserted
- **Where:** `packages/bugsee/src/wire.ts:238`; test at `packages/bugsee/src/node.test.ts:117-122`
- **Evidence:** replacing `durationNanos: Math.max(0, Math.round((endTimestampMs - platform.startupAtMs) * 1_000_000))` with `durationNanos: 0` left 34/34 passing. The test's `toMatchObject` checks `startTimestampMs`/`endTimestampMs` but not the derived duration — the one field the code actually computes.

### 10. The README of the package customers install still says "stub"
- **Where:** `packages/bugsee/README.md:1-5` — 182 bytes, titled `# bugsee` (the pre-rename name, superseded by `5fb6fe3`), and `**Status:** stub.` This is the first thing anyone lands on.

### 11. `@bugsee/integration-shims` (dead code) rides into every consumer's install tree
- **Where:** declared as a runtime dependency in `packages/browser/package.json` and `packages/node/package.json` (also `packages/vercel-edge/package.json`); imported nowhere — the only occurrence of the string in any `src/*.ts` is its own `packages/integration-shims/src/index.ts:1`.
- **What:** It is in the umbrella's transitive `dependencies` closure (18 packages), so `npm i @bugsee/bugsee` installs it on both the browser and node paths. No runtime cost (never imported, and every package sets `sideEffects:false`), install-weight only.

### 12. Inconsistent legacy field triple in `publishConfig`
- **Where:** `packages/bugsee/package.json:41-43` — `"main": "./dist/index.node.cjs"` (node), `"module": "./dist/index.js"` (browser), `"types": "./dist/index.d.ts"` (browser).
- **What:** Three legacy fields pointing at two different platforms. Any `exports`-unaware consumer gets a mismatched pair: an old bundler following `module` on a Node target gets the browser build; `moduleResolution: node10` gets browser types over a node runtime (see #4).

## Resolution matrix

Verified against the exact `publishConfig.exports` map. Runtime rows use real binaries; bundler rows use esbuild 0.25.12 with the condition sets those toolchains apply; `tsc` rows use `--traceResolution` (TypeScript 6.0.3).

| runtime / tool | resolves to | correct? | evidence |
|---|---|---|---|
| browser bundler (`platform=browser`) | `dist/index.js` (browser ESM) | ✅ | esbuild probe |
| Node ESM | `dist/index.node.js` | ✅ | `node t.mjs` → `NODE-ESM` |
| Node CJS | `dist/index.node.cjs` | ✅ | `node t.cjs` → `NODE-CJS` |
| SSR bundler (`platform=node`) | `dist/index.node.js` | ✅ | esbuild probe |
| **Bun 1.3.14** | `dist/index.node.js` | ❌ **SEV1** | matches `node`; `@bugsee/bun` bypassed → `platform.type:"node"`, version `24.3.0`, `Bun.serve` unwrapped |
| **Deno 2.8.3** | `dist/index.node.js` | ❌ **SEV1** | matches `node`; `@bugsee/deno` bypassed → `platform.type:"node"`, version `24.15.0` |
| **Cloudflare `workerd`** | `dist/index.js` (browser) | ❌ | `workerd,worker,browser` → browser; spec prescribes a `workerd` condition; `@bugsee/cloudflare` unreachable |
| **Vercel Edge (`edge-light`)** | `dist/index.js` (browser) | ❌ | `edge-light,worker,browser` → browser; `@bugsee/vercel-edge` unreachable |
| **Web/Service Worker (`worker`)** | `dist/index.js` (browser) | ❌ | `worker,browser` → browser; `@bugsee/webworker` unreachable |
| Electron main | `dist/index.node.js` | ✅ (for the node half) | `electron,node` → node. `@bugsee/electron` is a separate documented install; the umbrella is not the Electron path |
| Electron renderer | `dist/index.js` (browser) | ✅ (for the renderer half) | `electron,browser` → browser |
| React Native / Metro | `dist/index.js` (browser) | n/a | `react-native` → browser; RN is not a supported target |
| **`tsc` `moduleResolution: bundler`** | `dist/index.d.ts` (**browser types**) | ❌ **SEV2** | `Saw non-matching 'browser'. Saw non-matching 'node'. Matched 'default'.` — types disagree with the runtime on Node |
| `tsc` `node16` / `nodenext` | `dist/index.node.d.ts` | ✅ | `Matched 'exports' condition 'node'` |
| `tsc` `node10` | `dist/index.d.ts` (**browser types**) | ❌ | falls back to top-level `"types"`, while `"main"` is the node build |
| `@bugsee/bugsee/node` (all of the above) | `dist/index.node.*` | ✅ | no `browser` condition on the subpath; every resolver agrees |

## Dual-package-hazard verdict

**Neutralized — the carrier does what it claims.** Verified empirically in one Node process against the real built dists staged as npm would publish them:

```
CJS entry loaded, launch typeof = function
ESM entry loaded, launch typeof = function
same launch fn across ESM/CJS?          false   <- two distinct module copies, as expected
carrier slots:                          [ '0.0.0' ]
carrier has client?                     true
SAME CLIENT INSTANCE (c1===c2)?         true    <- the hazard is neutralized
c2 === carrier.client?                  true
interceptor names on carrier:           console,fetch,node-http,sse,websocket,webtransport,xhr
direct @bugsee/node launch === umbrella client?  true   <- umbrella + platform pkg converge too
```

The mechanism is `packages/core/src/carrier.ts` — `globalThis.__BUGSEE__[BUGSEE_SDK_VERSION]` holds `client` and the interceptor registry, reached only through a `globalThis` cast, so duplicate module copies at the same SDK version rendezvous on one slot. `packages/bugsee/src/node.ts:20` and `packages/bugsee/src/launch.ts:26` then return early when `launchCore` reports `internals === undefined`, so the second `launch()` neither re-wires the performance extension nor double-registers the OTLP tee. One interceptor per global name is confirmed by the registry listing above (seven names, no duplicates). This holds for the mixed case a real user hits — umbrella *and* a directly-installed `@bugsee/node` — which is the harder scenario.

Two residual notes, neither a hazard: (a) the ESM build code-splits `wire.ts` into a shared chunk imported by both entries, while the CJS build inlines a copy into each — harmless, since all mutable state lives on the carrier, not in module scope; (b) the carrier key is the literal `BUGSEE_SDK_VERSION = '0.0.0'` (`packages/core/src/carrier.ts`), so version-keyed isolation is untested in practice until real versions ship.

## On-by-default inventory

`launch()` from the umbrella, with no options:

| subsystem | on by default? | confirmed defects it ships | opt-out available? | file:line |
|---|---|---|---|---|
| `@bugsee/performance` (APM) | **yes**, both entries | **SEV1 single-slot `getActiveSpan`** → cross-request misattribution on Node | `performanceMonitoring: false` | `wire.ts:205-221`, `performance/src/options.ts:32` |
| head sampling (`sampleRate: 1`, keep all) | **yes** | — | `performanceSampleRate` | `wire.ts:211`, `performance/src/options.ts:33` |
| pageload transaction + web-vitals | yes (browser only) | — | via `performanceMonitoring` | `launch.ts:32` (`pageload: true`) |
| `app.start` startup transaction | yes (node only) | duration never asserted (#9) | via `performanceMonitoring` | `wire.ts:228-242`, `node.ts:27` |
| SPA navigation transactions | yes (browser only) | — | `traceNavigations: false` | `wire.ts:186-189` |
| interaction transactions | yes (browser only) | — | `traceInteractions: false` | `wire.ts:194-197` |
| http client spans | yes (rides `networkSource`) | inherits the single-slot defect | via `performanceMonitoring` | `wire.ts:214` |
| **incoming-server instrumentation** | **yes** (`@bugsee/node`) | one `http.server` txn per request into the single slot | `instrumentIncomingRequests: false` | `node/src/launch.ts:784` |
| crash detection + `process.exit(1)` | yes | — | `detectCrashes:false` / `exitOnUncaught:false` | `node/src/launch.ts:739-756` |
| **`unhandledRejection` listener** | **yes** | **converts host crash (exit 1) → exit 0** | only via `detectCrashes:false`, which also kills crash reporting | `node/src/detection-providers.ts:78-80` |
| OTel **consume** | **no** — opt-in | (would ship the `traceId.slice(0,16)` root-span-id fabrication) | requires `otelConsume:true` **and** `onOtelSpanProcessor` | `wire.ts:247` |
| OTel **OTLP export tee** | **no** — opt-in | as above | requires `otelExportUrl` | `wire.ts:167-180`, `opentelemetry/src/to-otlp.ts:99` |
| traceparent propagation | **no** on browser (`?? false`); node owns its own | umbrella correctly declines to wire the perf-sourced one on Node | `propagateTrace` | `wire.ts:261` |
| session replay | no — option-driven | — | `replay` option | `browser/src/launch.ts:449` |
| node diagnostics (CPU profiling / ANR) | no — opt-in | — | — | `node/src/launch.ts` |

**Called out explicitly:** APM is an on-by-default subsystem carrying a confirmed SEV1, and `instrumentIncomingRequests` (also default-on) is what feeds it on the server. Every Node customer of the umbrella who never asked for APM gets both. OTel, by contrast, is correctly opt-in on both the produce and consume paths, so the `traceId.slice(0,16)` defect is **not** shipped to everyone — that one is clean.

## Public-surface audit

**Core internals: not leaked.** Both entries re-export exactly four names from `@bugsee/core` — `AttributeValue`, `Breadcrumb`, `BreadcrumbInput`, `LogExceptionOptions` (`index.ts:8-13`, `index.node.ts:6-11`) — all via `export type`, so they are fully erased. The built `dist/index.js` imports only `./chunk-*.js` and `@bugsee/browser`; `dist/index.node.js` only `./chunk-*.js` and `@bugsee/node`. No `@bugsee/core` value crosses the boundary. `@bugsee/core`'s 54-export index stays internal, as the rule requires.

**Runtime surface, enumerated from the built package:**
```
NODE entry runtime exports: launch
```
Exactly one runtime value. Every other export is type-only. I iterated all keys accessing each — **no export throws on access** (the `@bugsee/rrweb` defect class does not reproduce here).

**Types match the runtime implementations** *per entry*: `index.node.d.ts` declares `launch(appToken, options?: BugseeNodeLaunchOptions): Bugsee` with `Bugsee` from `@bugsee/node`; `index.d.ts` declares it with `BugseeLaunchOptionsWithPerformance` and `Bugsee` from `@bugsee/browser`. Both match their `.js`. The defect is not in the declarations — it is that `tsc`'s default condition set picks the wrong *pair* (finding #4).

**Entry symmetry** is correct-by-design: `.` exports `BugseeLaunchOptionsWithPerformance`, `./node` exports `BugseeNodeLaunchOptions` (plus `appStartTimeMs`). The four core types, `Bugsee`, `BugseeSpanProcessor` and `launch` are common to both. Nothing exported from one entry is missing from the other where it should be shared.

**`wire.ts` leak — verified fixed, not regressed.** The `dist/` in the repo is stale (Jul 23 05:33) and predates the fix (`5fb6fe3`, Jul 24 17:19); it does contain `require('@bugsee/browser')` in `index.node.cjs`, which is what a casual grep would flag. A fresh build proves the fix holds:

| artifact | stale `dist/` (pre-fix) | fresh build |
|---|---|---|
| `index.node.cjs` requires | `@bugsee/browser`, capture, core, node, otel, performance | capture, core, **node**, otel, performance — **no browser** |
| shared ESM chunk imports | **`@bugsee/browser`**, capture, core, otel, performance | capture, core, otel, performance — **no browser** |

`wire.ts:42-51` types `UmbrellaInternals` against runtime-neutral packages only and `wire.ts:57-61` takes the browser sources as injected **factories**, which is what keeps the graph clean. Both ESM and CJS node entries are browser-free.

**Single-install adapter contract:** across all 12 leaf adapters I diffed each adapter's own export names against the umbrella surface it `export *`s — **zero collisions**, so nothing is silently dropped by ESM's ambiguous-star rule and nothing shadows an adapter's own exports. The 5 frontend adapters correctly star `'@bugsee/bugsee'`; the 7 backend adapters correctly star `'@bugsee/bugsee/node'`. Tree-shaking is not defeated: all 18 packages in the closure declare `sideEffects: false` (only the third-party `@bugsee/rrweb-record` omits it), and tsup externalizes `@bugsee/*` so the re-export specifier survives to the consumer's bundler, which then applies its own conditions.

## What the tests cannot see

- **The `exports` map.** All 34 umbrella tests import relative paths (`./index`, `./launch`, `./node`). Re-pointing the `node` condition at the browser entry is invisible to the entire suite, to the adapter suites, and to `tsc`. This is the dominant blind spot for an umbrella package and it is total.
- **The browser entry, through the specifier a browser consumer uses.** Proven by mutation: removing `launch` from `src/index.node.ts` breaks the **React** adapter's test, because vitest resolves `'@bugsee/bugsee'` with conditions `["node","development","import"]`. Every single-install re-export test — frontend and backend alike — exercises the node entry.
- **The CJS path.** No test loads `require('@bugsee/bugsee')` or `require('@bugsee/bugsee/node')`. The dual-package hazard, the carrier rendezvous, and the CJS build's inlined `wire.ts` copy are all unexercised in CI. (I verified them by hand; they pass — but a regression would ship silently.)
- **Bun/Deno resolution.** `@bugsee/instrumentation-tests` boots real bun/deno processes, but against the platform packages directly, never through the umbrella specifier — which is exactly why finding #1 survived.
- **The defaults the umbrella is *for*.** `performanceMonitoring` and `performanceSampleRate` defaults can be flipped in `wire.ts` with no test failure (#8), because the values come from `PERFORMANCE_OPTION_DEFINITIONS` and nothing in this package asserts the composed result.
- **The startup transaction's computed duration** (#9).

**Mutation results — 8 of 10 `wire.ts` mutations were caught** (baseline 34/34; each applied, measured, and restored from a `cp` backup):

| # | mutation | outcome |
|---|---|---|
| W1 | scope name always `webjs` | caught (1 failed) |
| W2 | `propagateTrace` defaults to `true` | caught |
| W3 | drop the `pageload` gate on propagation | caught |
| W4 | `teeSend` swallows failures | caught |
| W5 | `stop()` no longer tears perf down | caught |
| W6 | startup txn `durationNanos: 0` | **survived** |
| W7 | `sampleRate` default `1` → `0` | **survived** (dead default) |
| W8 | `monitoring` default `true` → `false` | **survived** (dead default) |
| W9 | `traceNavigations` defaults off | caught |
| W10 | `otelConsume` gate inverted | caught (2 failed) |
| M3 | `exports["."].node` → browser entry | **survived everything** |
| M4 | delete the `./node` subpath (control) | caught — proves the harness works |
| M5 | remove `launch` from `index.node.ts` | caught — by react **and** express, revealing #6 |

## Checked and found clean

- **The `wire.ts` → `@bugsee/browser` leak is genuinely fixed and has not regressed** — verified by a fresh build of both ESM and CJS node entries (the repo's `dist/` is a stale pre-fix artifact and should not be trusted; it is gitignored, so nothing is committed).
- **Dual-package hazard is neutralized** — empirically, including the umbrella + directly-installed-platform-package case.
- **No `@bugsee/core` internals leak**; all four core re-exports are type-only and fully erased from the built JS.
- **No export throws on access**; the runtime surface is exactly `launch`.
- **No name collisions** across all 12 single-install adapters' `export *`; tree-shaking intact (`sideEffects:false` throughout).
- **The `./node` subpath is correct on every resolver tested** (node ESM/CJS, bun, deno, esbuild, `tsc` bundler/node16/nodenext) — the documented backend workaround does what it claims.
- **OTel is correctly opt-in** on both produce (`otelExportUrl`) and consume (`otelConsume` **and** `onOtelSpanProcessor`), so `to-otlp.ts:99`'s fabricated root span id is not shipped by default.
- **The umbrella correctly declines to wire the perf-sourced traceparent decorator on Node** (`wire.ts:261`), with an accurate comment and a real regression test (`node.test.ts:173-206`) — the one place the single-slot hazard was anticipated and guarded.
- **Repeat-launch handling is correct** on both entries (`launch.ts:26`, `node.ts:20`): `internals === undefined` short-circuits, so extensions are never double-wired.
- **`stop()` composition is in-place** (`wire.ts:280-286`), keeping the carrier singleton, a repeat launch, and the returned value one consistent object; mutation W5 confirms it is tested.
- **Coverage gate genuinely met**: 100% statements/branches/functions/lines (44/44, 66/66, 11/11, 39/39) — and unusually for a 100% package, 8 of 10 targeted mutations were caught, so the coverage is mostly real rather than executed-but-unasserted.
- `@bugsee/integration-shims` is **not** a direct dependency of the umbrella (it arrives transitively via `browser`/`node` — #11).
- Repo left byte-identical: `git status --short packages/` is empty; every mutated file was restored from a `cp` backup, never via `git checkout`.
