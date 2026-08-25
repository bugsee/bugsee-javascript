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
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.test-d.ts',
        'src/**/*.d.ts',
        '**/node-utils/**',
        // `src/index.ts` is a PURE re-export barrel — 19 `export … from` lines and no logic — and v8
        // instruments it non-deterministically. Locally it reports zero executable lines and passes;
        // on CI it has repeatedly reported ~19 uncovered ones and failed the package at 96.52%,
        // including on runs where `index.test.ts` imports the whole surface (it passed one run and
        // failed the next with that test in place). A gate that flips on identical code is worse than
        // no gate on a file with nothing to execute.
        //
        // The export surface is still guarded, and better than coverage ever guarded it, by
        // `src/index.test.ts` — which asserts the exact set of exports in both directions. If this
        // barrel ever gains real logic, that logic belongs in its own module, not here.
        'src/index.ts',
      ],
      thresholds: {
        lines: 100,
        functions: 100,
        statements: 100,
        branches: 90,
      },
    },
  },
});
