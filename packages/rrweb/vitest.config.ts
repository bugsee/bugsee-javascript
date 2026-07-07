import { defineConfig } from 'vitest/config';

// jsdom — rrweb's record path touches DOM globals on import. Coverage gate per §4 (100% line/fn/stmt).
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/*.test-d.ts', 'src/**/*.d.ts'],
      thresholds: { lines: 100, functions: 100, statements: 100, branches: 90 },
    },
  },
});
