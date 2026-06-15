import { defineConfig } from 'vitest/config';

// The cross-runtime e2e harness. Unlike the unit packages this is NOT a coverage-gated suite: it spawns
// real node/bun/deno processes and asserts their uploaded bundles, so it is intentionally excluded from
// the default `pnpm test` (the root config globs *.test.ts; these are *.e2e.ts) and run on demand via
// `pnpm test:e2e`. Generous timeouts cover process spin-up + the deliberate hang/profile windows; the
// per-runtime suites spawn their processes sequentially (one beforeAll at a time), so the spawned
// runtimes never contend for CPU (which would skew the hang watchdog).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.e2e.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
