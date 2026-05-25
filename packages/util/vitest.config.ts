import { defineConfig } from 'vitest/config';

// Per-package Vitest config (the pattern every package follows). Coverage is scoped to this
// package's src and enforces the binding gate (docs/implementation-standards.md §4):
// 100% line / functions / statements, >=90% branch.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/index.ts', 'src/**/*.d.ts'],
      thresholds: {
        lines: 100,
        functions: 100,
        statements: 100,
        branches: 90,
      },
    },
  },
});
