import { defineConfig } from 'vitest/config';

// Root Vitest config. Per-runtime / per-package projects are introduced as packages
// are implemented (see docs/implementation-standards.md §4 — coverage gate is 100% line /
// >=90% branch, enforced per runtime). `passWithNoTests` keeps the skeleton green while
// packages are still stubs.
export default defineConfig({
  test: {
    passWithNoTests: true,
    include: ['packages/*/{src,test}/**/*.{test,spec}.ts'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/*.d.ts'],
      // Binding gate (docs/implementation-standards.md): activated per package as code lands.
      thresholds: {
        lines: 100,
        functions: 100,
        statements: 100,
        branches: 90,
      },
    },
  },
});
