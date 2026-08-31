import { defineConfig } from 'vitest/config';

// Root Vitest config.
//
// `projects` — NOT a flat `include` glob. Each package owns a `vitest.config.ts` that declares the
// environment its tests actually need (`jsdom` for the DOM tiers, the default `node` elsewhere). A single
// merged run cannot honour those: it applies ONE environment to every file it collects, and the root has
// no `environment` set, so everything ran under `node`. Any test touching a real `document` therefore
// failed at the root while passing in its own package — `packages/replay/src/masking.fuzz.test.ts` built
// DOM nodes to exercise the masking resolver and threw `ReferenceError: document is not defined` on 11 of
// its 16 cases, red at the root and green under `pnpm --filter @bugsee/replay`.
//
// That divergence went unnoticed because the CI gate is `turbo run test:coverage`, which runs each
// package separately and so was always correct. Only the root command was lying, which is worse than a
// plain failure: `pnpm test` is the command CLAUDE.md points a reader at, and it reported a defect that
// did not exist while proving nothing about the ones that did.
//
// The two packages with no config of their own (`types`, `e2e-kit`) contain no test files.
export default defineConfig({
  test: {
    projects: [
      'packages/*',
      // The four framework harnesses run REAL `next build` / `nuxi build` / Astro / SvelteKit builds and
      // each binds a FIXED port (scripts/free-e2e-ports.sh). Collecting them here would (a) turn the unit
      // gate into a multi-minute build, (b) duplicate `pnpm test:e2e` outright, and (c) make `pnpm test`
      // and `pnpm test:e2e` race each other to EADDRINUSE on a healthy tree.
      '!packages/*-e2e',
      // `instrumentation-tests` ships TWO configs. Its default globs only `*.e2e.ts` (same reasons as
      // above — it spawns real node/bun/deno processes), while `vitest.unit.config.ts` holds the harness's
      // own unit suite: the negative tests for the shared bundle-assertion library, i.e. the thing that
      // justifies trusting every e2e assertion. Selecting the package by directory picks the DEFAULT
      // config and silently drops that suite, so name the unit config explicitly.
      '!packages/instrumentation-tests',
      './packages/instrumentation-tests/vitest.unit.config.ts',
    ],
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/*.d.ts'],
      // The BINDING gate is per package (docs/implementation-standards.md §4, enforced in CI by
      // `turbo run test:coverage`). This merged root report is a convenience view, not the gate — a
      // merged threshold reads scaffolding and per-runtime-excluded branches as shortfall.
      thresholds: {
        lines: 100,
        functions: 100,
        statements: 100,
        branches: 90,
      },
    },
  },
});
