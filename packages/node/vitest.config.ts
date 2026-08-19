import { defineConfig } from 'vitest/config';

// Coverage gate per docs/implementation-standards.md §4: 100% line/functions/statements, >=90% branch.
export default defineConfig({
  test: {
    // The runner is far slower than a dev machine — roughly 7-18x under coverage instrumentation — and
    // this repo has legitimately heavy suites (IndexedDB queues, property tests, CPU profiling, linearity
    // guards). vitest's 5 s default is calibrated for fast unit tests, so on CI it converted machine load
    // into red builds: three different packages timed out on three consecutive runs, none of them for a
    // reason related to the code under test. The e2e packages already set their own timeouts for exactly
    // this reason; this extends the same convention to the rest.
    testTimeout: 30_000,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // `@bugsee/node-utils` source leaks into coverage because vitest's external-file check is a
      // string-prefix test and "node-utils" starts with this package's dir name "node". It has its
      // own suite — exclude it so only @bugsee/node's own files count.
      exclude: ['src/**/*.test.ts', 'src/**/*.test-d.ts', 'src/**/*.d.ts', '**/node-utils/**'],
      thresholds: {
        lines: 100,
        functions: 100,
        statements: 100,
        branches: 90,
      },
    },
  },
});
