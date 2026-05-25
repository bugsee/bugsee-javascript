# Bugsee JavaScript SDK — Dev Environment & Tooling

**Status:** v1 (2026-05-25) — *planned*. The repo has no `package.json`/tooling config yet; this consolidates the toolchain decided in `docs/design/sdk-design.md` (§12.1, §12.3, §12.5, §5.3) and `docs/implementation-standards.md` (§13). Update the **Commands** section below when code lands.

---

## Prerequisites

| Tool | Version | Required for |
|---|---|---|
| **Node.js** | **≥18** | Baseline tooling runtime: pnpm, Vitest, Rollup, tsup, lint, type-check |
| **pnpm** | **≥9** | Package manager (strict node_modules, monorepo workspaces) |
| Bun | ≥1.1.13 | Building/smoke-testing `@bugsee/bun`; optional otherwise |
| Deno | ≥1.36 | Smoke-testing `@bugsee/deno` (`--allow-net`, `--allow-write`) |
| Wrangler (Cloudflare) | current | Smoke-testing `@bugsee/cloudflare` (`wrangler dev`) |
| Vercel CLI | current | Smoke-testing `@bugsee/vercel-edge` |
| Playwright browsers | current | Browser e2e (`npx playwright install`) |

Node + pnpm are the only hard requirements for general development; the others are needed only when working on (or smoke-testing) their respective platform packages.

## Target runtimes

Tooling runs on Node; the SDK is **built for and smoke-tested on** each target runtime separately (coverage is measured per runtime — see Testing). Tier-1: browsers, Node ≥18, Bun ≥1.1.13, Deno ≥1.36. Tier-2: Cloudflare Workers, Vercel Edge, Web/Service Workers. Electron is a stub in v1. Module format: **ESM-only** for tier-0; **ESM+CJS** for core/platform/framework/umbrella (design §12.5).

## Package manager & monorepo

| Concern | Tool | Notes |
|---|---|---|
| Package manager | **pnpm ≥9** | Workspaces; exact-pin `@bugsee/protocol` across consumers, caret ranges elsewhere |
| Monorepo orchestration | **Turborepo** | Mandatory **remote cache** from day one (provider OPEN — R2 self-hosted vs Vercel, §18.21). Pipeline: `build:types` ∥ `build:transpile` → `build:bundle` → `build:size-check` |
| Versioning + changelog | **Changesets** | Independent per-package versioning; `--snapshot` for PR preview publishes (`pnpm add @bugsee/browser@pr-1234`) |

## Build & bundling

| Layer | Tool | Why |
|---|---|---|
| Tier-0 packages | **tsup** | Simple; no bundle-size optimization needed |
| Platform / framework / replay | **Rollup 4** + shared `@bugsee/rollup-utils` | Conditional exports, tree-shaking, `__BUGSEE_DEBUG__` replacement, sourcemaps |
| Transpiler | **swc** | Fast; native decorators/JSX |
| Minifier | **Terser** | DCEs the `DEBUG_BUILD && …` form; prod `global_defs: { __BUGSEE_DEBUG__: false }` |
| Public type rollup | `tsc --emitDeclarationOnly` + **api-extractor** | Flattens public types for `@bugsee/browser`, `@bugsee/node`, framework adapters, umbrella |

`__BUGSEE_DEBUG__` defaults to **`false`** in published npm artifacts; **`@bugsee/vite-plugin` / `@bugsee/webpack-plugin` are required at v1** to inject `define: { __BUGSEE_DEBUG__: false }`, else Vite/Next dev throws `ReferenceError` (§12.3, §18.23).

## Lint, format & static checks

| Tool | Use |
|---|---|
| **Biome** | Formatting + base lints |
| **Oxlint** | Type-aware lint rules in CI |
| **madge `--circular`** | No circular / dev-dep cycles (e.g. `@bugsee/service` must not import `@bugsee/replay`, §5.3) |

## Testing & quality

Methodology (test-first TDD + per-entity **mutator loop** + integration tests at every boundary) is binding — see `docs/implementation-standards.md`.

| Tool | Use |
|---|---|
| **Vitest** | Unit + integration; `--typecheck` for type-level contract tests |
| **Vitest + v8 coverage** | Coverage gate **100% line / ≥90% branch, per runtime** (CI-blocking); exclusions only via annotated `/* v8 ignore */` + justification |
| **Stryker Mutator** (Vitest runner) | Mutation testing — **opt-in** (on-demand/nightly), not a blocking gate |
| **Playwright** | Browser e2e |
| Per-runtime smoke harnesses | `bun test` / `deno test` / `wrangler dev` / Vercel CLI, under `dev-packages/` |
| **Verdaccio** + ~10 fixture apps | Framework e2e |
| Bundler tests (`dev-packages/bundler-tests/`) | Tree-shake regression across webpack/rollup/vite/esbuild/turbopack/parcel |
| **size-limit** + **bundlemon** | Bundle-size budgets (CI-blocking); PR comments |
| Wire snapshots (`dev-packages/wire-snapshots/`) | Wire-format compatibility; snapshot update requires a `backend-ref: <PR>` commit line |

## CI gates

**Blocking:** coverage (100% line / ≥90% branch, per runtime), size-limit budgets, `madge --circular`, Oxlint type-aware rules, type tests, wire-format snapshots.
**Non-blocking:** Stryker mutation run (opt-in / nightly).

## Versioning & release

Changesets, independent versioning. `@bugsee/protocol` exact-pinned by every consumer (protocol drift is dangerous); others use caret ranges. Release: `pnpm changeset` → `pnpm version-packages` → `pnpm release` (CI publishes from `main` after tag). CDN bundles publish **SRI hashes** per release; Rollup build fails if `eval`/`Function()`/`setTimeout(string)` appears (§12.6/§12.9).

## Open / unconfirmed tooling decisions

- **Turbo remote-cache provider** — R2 self-hosted (recommended) vs Vercel free tier (§18.21).
- **`fflate`** — depend (recommended, ~13 KB MIT) vs vendor (§18.25).
- **CDN host** — `cdn.bugsee.com`? coordinate with infra (§18.26).
- **License** — open-source vs proprietary; affects contribution model (§18.27).

## Commands

> **TODO (fill when code lands):** install, build, build a single package, test, test a single file, lint, format, type-check, coverage, run mutation testing, per-runtime smoke. Mirror these into `CLAUDE.md` "Current state".
