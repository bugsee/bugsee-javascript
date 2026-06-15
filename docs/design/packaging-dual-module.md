# Packaging: ESM + CJS dual-module publishing

**Status:** Design (pre-implementation), 2026-06-15. Refines `sdk-design.md` §6/§12.5 with the
implementation details + reconciles two original calls against the as-built reality. The goal of this
milestone: make every consumer-facing package installable and usable from **both `import` (ESM) and
`require` (CJS)** on Node ≥ 18 (and ESM for bundlers/browsers/edge), without losing the "no build step for
dev" workflow.

---

## 1. The gap (today)

Every package is `"type": "module"` with `exports: { ".": { "types": "./src/index.ts", "import":
"./src/index.ts" } }` — **ESM-only, pointing at raw `.ts`**. So:
- `require('@bugsee/node')` fails (ESM-only, no `require` condition).
- Even an external ESM consumer gets `.ts`, not compiled JS.

This is intentional *for dev* (the monorepo runs TS source directly via vitest/tsx/bun/deno). Nothing is
publish-ready for either format. The audit confirms the shipped code has **no ESM-only runtime patterns**
(no `import.meta`, no top-level `await`), so the code compiles to CJS cleanly — this is purely packaging.
Build tooling is already in devDeps (`tsup`, `rollup`, `@microsoft/api-extractor`).

## 2. Decisions

### D1 — Ship ALL consumer packages dual (ESM + CJS); externalize `@bugsee/*` deps. *(Refines §12.5.)*
§12.5 said "tier-0 ESM-only; tier-1+ ESM+CJS". That breaks the CJS dependency chain: a CJS build of
`@bugsee/node` that `require()`s an ESM-only `@bugsee/util` fails at runtime. Two ways out — **bundle**
workspace deps into each package (keeps tier-0 ESM-only, but duplicates core/util into every package), or
**externalize + ship every `@bugsee/*` dual** (shared via node_modules, no duplication). Choose the latter:
- It's the standard multi-package layout (npm dedupes shared deps; no N copies of `core`).
- The **dual-package hazard is already neutralized**: the SDK's process-singletons live on the **carrier
  (`globalThis`)**, not module-level state (the #47 carrier design), so two instances of a package (one
  ESM, one CJS) still share one launched client / one interceptor. tier-0 is stateless (pure libs) anyway.
- So: tier-0 also ships dual. `@bugsee/*` deps stay **external** (not bundled). Reconcile §12.5 to "all
  published packages ESM+CJS".

### D2 — Build tool: **tsup** (per package, shared preset).
Already a devDep, zero-config-ish, emits ESM + CJS + `.d.ts` in one pass over `src/index.ts`. A shared
`tsup.config.base.ts` at the root; each package a 3-line `tsup.config.ts` extending it. (Rollup stays
reserved for the separate CDN/UMD bundles, §12.6 — OUT of scope here.)

### D3 — Dev stays source-based; `publishConfig.exports` swaps to `dist` on publish.
Keep the "no build for dev" workflow: the package.json `exports` continue to point at `./src/index.ts`
(vitest/tsx/bun/deno consume source). Add a **`publishConfig.exports`** (and `publishConfig.main`/`types`)
pointing at `./dist/*` — npm applies `publishConfig` only at publish time, so the **published tarball** gets
the built dual-format exports while the **workspace** keeps source resolution. One package.json, both
worlds; no separate "dev vs prod" entry juggling.

### D4 — Types: tsup's `dts: true` per package (api-extractor reserved for a later flattening pass).
Each package emits its own `dist/index.d.ts`. api-extractor (flatten `@internal`-stripped public types) is
a nice-to-have for the user-facing packages; not required to ship — defer.

### D5 — The umbrella keeps the multi-runtime conditions; each × import/require.
`@bugsee/bugsee` already has `browser`/`node` conditions (→ `index.ts` / `index.node.ts`). Extend to the
full runtime set (`workerd`/`edge-light`/`worker`/`deno`/`bun`/`node`/`browser`) per §6, and give the
node/bun/deno/browser arms an `import`+`require` split. It stays the ONLY package with runtime conditions
(§6) — the platform packages are separate packages, single-entry, just dual-format.

## 3. Architecture

**Per-package dist + exports (the template, e.g. `@bugsee/node`):**
```
dist/index.js     (ESM)     dist/index.cjs  (CJS)     dist/index.d.ts
```
```jsonc
// dev exports (unchanged — source):
"exports": { ".": { "types": "./src/index.ts", "import": "./src/index.ts" } },
"publishConfig": {
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": {
    "types": "./dist/index.d.ts",
    "import": "./dist/index.js",
    "require": "./dist/index.cjs"
  } }
}
```
**Build wiring:** add `"build": "tsup"` to each package; the root `build` turbo task already exists
(`dependsOn: ["^build"]`, `outputs: ["dist/**"]`) so `pnpm build` builds the graph in dep order.
`@bugsee/*` deps are externalized (default for non-bundled tsup with deps listed), so each `dist` imports
its siblings via the normal module graph.

## 4. Risks / edge cases
- **Dual-package hazard** — mitigated by the carrier (D1); add a CJS-vs-ESM "same client" assertion to the
  verification smoke to lock it.
- **`node:` imports in CJS** — tsup keeps `require('node:crypto')` etc.; fine on Node ≥ 18.
- **The ANR worker eval string** — already made CJS/ESM-context-agnostic (commit 70d3061), so it survives
  whichever module format the host uses.
- **Named exports** — our packages export named (no default); tsup's CJS interop preserves
  `const { launch } = require('@bugsee/node')`. Verify.
- **Peer deps** (`express`/`fastify`) — stay external peers, never bundled.
- **Source maps** — emit them (`sourcemap: true`) so stack traces in published builds map back.
- **`exports` strictness** — once `exports` is set, deep imports are blocked; expose `./package.json` and
  any intended subpaths explicitly.
- **OUT of scope:** the CDN/UMD bundles (§12.6), api-extractor flattening (D4), per-feature replay add-ons.

## 5. Verification (the proof that closes this)
1. `pnpm build` produces `dist/{index.js,index.cjs,index.d.ts}` for each package.
2. **Real CJS smoke:** from a throwaway CJS file, `const { launch } = require('@bugsee/node')` (resolved
   against the built `dist`, e.g. via a temp `exports`-overridden copy or a packed tarball) → `launch()`
   runs + uploads a bundle (mirrors the Node-18 / Deno proofs).
3. **Real ESM smoke:** `import { launch } from '@bugsee/node'` against `dist` → same.
4. **Dual-instance:** load one package as ESM and another as CJS in the same process; assert they share one
   carrier client (no hazard).
5. The existing test suite keeps running against `src` (dev exports unchanged) — no test churn.

## 6. Rollout plan (slices — each: build wires up, gates pass, verified)
1. **Tooling** — root `tsup.config.base.ts` + `build` scripts; pick one leaf (`@bugsee/util`) → build dual
   + assert a real `require` + `import` of the built output works. De-risks the pipeline.
2. **Tier-0** (`types`/`util`/`logger`/`protocol`/`service`) — dual + publishConfig.
3. **Core** (`@bugsee/core`) — dual; verify a CJS require of the built core.
4. **Platform** (`node`/`node-utils`/`browser`/`browser-utils`/`bun`/`deno`) — dual; the real CJS+ESM
   `launch()` smoke on `@bugsee/node` (verification #2–4).
5. **Capture/performance/opentelemetry + adapters** (`express`/`fastify`) — dual.
6. **Umbrella** (`@bugsee/bugsee`) — runtime conditions × import/require (D5); verify `require('bugsee')`.

Reconcile `sdk-design.md` §12.5 (tier-0 now dual, per D1) when this lands.
