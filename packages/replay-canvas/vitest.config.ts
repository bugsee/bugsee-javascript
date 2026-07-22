import { defineConfig } from 'vitest/config';

// The canvas add-on's option resolver is a PURE options-builder (no DOM/rrweb), so a node env suffices.
// Coverage gate per docs/implementation-standards.md §4 (100% line/fn/stmt, >=90% branch).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/*.test-d.ts', 'src/**/*.d.ts'],
      thresholds: { lines: 100, functions: 100, statements: 100, branches: 90 },
    },
  },
});
