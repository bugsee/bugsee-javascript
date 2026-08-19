import { defineConfig } from 'vitest/config';

// Coverage gate per docs/implementation-standards.md §4: 100% line/functions/statements, >=90% branch.
// environment 'node': the React adapter is tested injection-first (the ErrorBoundary's lifecycle methods
// are exercised by direct invocation + element inspection, NOT a react-dom renderer) — the same
// injection-first discipline as the browser/node tiers.
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
      exclude: ['src/**/*.test.ts', 'src/**/*.test-d.ts', 'src/**/*.d.ts'],
      thresholds: {
        lines: 100,
        functions: 100,
        statements: 100,
        branches: 90,
      },
    },
  },
});
