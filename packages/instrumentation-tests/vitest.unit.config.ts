import { defineConfig } from 'vitest/config';

// The harness's OWN unit tests (test/**/*.test.ts) — currently the negative-test suite for the shared
// bundle-assertion library, which is the entire justification for trusting it.
//
// Separate from vitest.config.ts (which globs only *.e2e.ts) because these must run in CI and the e2e
// suites are a different job. They ran NOWHERE in CI until 2026-07-28: the `check` job runs
// `turbo run test:coverage` and this package had no such script, so turbo silently reported
// `<NONEXISTENT>` — the exact silent-skip the e2e CI job was written to fix
// (docs/review/session-changes-review.md SEV2 #4).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
