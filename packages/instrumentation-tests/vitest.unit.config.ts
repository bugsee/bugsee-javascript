import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const PARSER = fileURLToPath(new URL('../../scripts/spec-snapshot/parse.mjs', import.meta.url));

// The harness's OWN unit tests (test/**/*.test.ts) — currently the negative-test suite for the shared
// bundle-assertion library, which is the entire justification for trusting it.
//
// Separate from vitest.config.ts (which globs only *.e2e.ts) because these must run in CI and the e2e
// suites are a different job. They ran NOWHERE in CI until 2026-07-28: the `check` job runs
// `turbo run test:coverage` and this package had no such script, so turbo silently reported
// `<NONEXISTENT>` — the exact silent-skip the e2e CI job was written to fix.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // transform (not externalise) the repo-root scripts/ module so coverage can see it
    server: { deps: { inline: [/spec-snapshot\/parse\.mjs/] } },
    // The spec-conformance tooling is code the guard's own trustworthiness rests on, so it carries the repo's coverage
    // gate: the snapshot parser (scripts/spec-snapshot/parse.mjs) and the source scanner. `refresh.mjs` runs as a
    // subprocess in its tests (v8 cannot see into it), so it is held by its behavioural tests and the mutator loop instead.
    coverage: {
      enabled: true,
      allowExternal: true, // parse.mjs lives in the repo-root scripts/ directory
      provider: 'v8',
      include: [PARSER, 'test/support/spec-drift-lib.ts'],
      thresholds: { lines: 100, functions: 100, statements: 100, branches: 90 },
    },
  },
});
