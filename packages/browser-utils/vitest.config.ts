import { defineConfig } from 'vitest/config';

// Coverage gate per docs/implementation-standards.md §4: 100% line/functions/statements, >=90% branch.
// environment 'node': browser code is tested via injected seams (fake fetch/window), not a DOM env —
// the same injection-first discipline as the node tier. (B5's IndexedDB store adds a fake-indexeddb
// setupFiles, still under 'node'.)
export default defineConfig({
  test: {
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
