import { defineConfig } from 'vitest/config';

// Coverage gate per docs/implementation-standards.md §4: 100% line/functions/statements, >=90% branch.
// The real-NestJS integration test boots an actual decorated Nest app, so the transform must emit
// decorator metadata (Nest DI reads design:paramtypes). Vitest 4's oxc transform picks up
// experimentalDecorators + emitDecoratorMetadata from this package's tsconfig.json directly.
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
