# Bugsee JavaScript SDK — Dev Environment & Tooling

**Status:** v1.1 (2026-05-30) — *in use*. The repo is bootstrapped: pnpm + turbo workspace, Vitest + Biome + tsc + madge wired, 53 packages (all implemented — see `docs/PROGRESS.md`), with a GitHub Actions CI gate (`.github/workflows/ci.yml`: lint → typecheck → cycles → per-package coverage). This file consolidates the toolchain decided in `docs/design/sdk-design.md` (§12.1, §12.3, §12.5, §5.3) and `docs/implementation-standards.md` (§13). Source of truth for the live commands is the **Commands** section below.

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

Tooling runs on Node; the SDK is **built for and smoke-tested on** each target runtime separately (coverage is measured per runtime — see Testing). Tier-1: browsers, Node ≥18, Bun ≥1.1.13, Deno ≥1.36. Tier-2: Cloudflare Workers, Vercel Edge, Web/Service Workers. Electron ships in v1 (`@bugsee/electron`, main + renderer + native). Module format: **ESM-only** for tier-0; **ESM+CJS** for core/platform/framework/umbrella (design §12.5).

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

Package manager: **pnpm 11.3.0** (declared in root `package.json` `packageManager`). Task runner: **turbo** (`turbo.json`). All commands run from the repo root unless noted.

### Install

```bash
pnpm install                              # install workspace dependencies
```

### Build

```bash
pnpm build                                # turbo run build (all packages)
pnpm --filter @bugsee/<pkg> build         # build one package
```

> Packages currently export their TypeScript source directly via `exports: { ".": { "import": "./src/index.ts" } }`, so the monorepo CONSUMES source — no build step is required to develop or test inside the repo. `pnpm build` produces `dist/` for publishing.

### Test (Vitest)

```bash
pnpm test                                 # all packages, one run
pnpm test:watch                           # vitest watch mode
pnpm test:coverage                        # all packages with coverage
pnpm --filter @bugsee/<pkg> exec vitest run             # one package
pnpm --filter @bugsee/<pkg> exec vitest run src/<file>.test.ts   # one file
pnpm --filter @bugsee/<pkg> exec vitest run -t "<test name fragment>"  # one test
pnpm --filter @bugsee/<pkg> exec vitest run --coverage  # one package with coverage
```

**Coverage gate per package (vitest v8 thresholds):** **100% line / function / statement, ≥90% branch (aggregate)**. Failing the gate fails the run.

### Type-check

**Vitest does NOT typecheck.** Always run `tsc` per package before committing.

```bash
pnpm typecheck                            # turbo run typecheck → tsc --noEmit per package
pnpm --filter @bugsee/<pkg> exec tsc --noEmit           # one package
```

### Lint & format (Biome)

```bash
pnpm lint                                 # biome check . (read-only)
pnpm lint:fix                             # biome check --write . (auto-fix safe issues; unsafe fixes — e.g. unused-import removal — stay as warnings, fix manually)
pnpm format                               # biome format --write .
```

### Cycles

```bash
pnpm check:cycles                         # madge --circular --extensions ts packages
```

### Mutation testing (Stryker, opt-in)

```bash
pnpm mutation                             # turbo run mutation (per-package Stryker run)
```

> Mutation testing is **not** a blocking gate. The always-on discipline is the per-entity **mutator loop** in `docs/implementation-standards.md` §2 (inject a bug → confirm a test catches it → restore). Stryker is run on demand to audit test strength.

### Per-runtime smoke + Node-version matrix

- **Cross-runtime e2e:** `pnpm test:e2e` (`@bugsee/instrumentation-tests`) boots the REAL SDK in separate node (via tsx) / bun / deno processes against a mock collector and asserts the uploaded bundles (logs/network/profile/ANR/crash/server-context/disk-recovery/off-thread-worker). A runtime whose binary is absent is skipped.
- **Cross-Node-version matrix:** `pnpm test:matrix` (`scripts/test-matrix.sh`, nvm-based, CI-agnostic) runs a vitest-free scenario smoke (`smoke.ts`) via `tsx` under each installed Node version — covering **Node 18**, where vitest 4 cannot load (`rolldown`'s `node:util.styleText`). `pnpm test:matrix 18 20` picks a subset; `--full` also runs `pnpm test` on each Node ≥ 20. (Complementary axes: `pnpm test` is the host-Node unit suite; `pnpm test:e2e` is the cross-runtime axis.)
- The Node SDK's in-process e2e coverage is also in `packages/node/src/launch.integration.test.ts` (real loopback `http.createServer`, full session → issue → signed PUT → durable-queue recovery).

### Pre-commit checklist

Before committing, run all four gates:

```bash
pnpm lint && pnpm typecheck && pnpm check:cycles && pnpm test
```

The repo currently has no git pre-commit hook installed — these gates are operated manually.

> Mirror any change to these commands into `CLAUDE.md` "Current state" so a fresh agent session sees the same picture.
