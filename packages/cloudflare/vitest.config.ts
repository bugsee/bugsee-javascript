import { defineConfig } from 'vitest/config';

// Coverage gate per docs/implementation-standards.md §4: 100% line/functions/statements, >=90% branch.
// @bugsee/cloudflare is the @bugsee/vercel-edge composition with platformType defaulted to 'workers'; its own
// code is the thin launch wrapper + the re-export index, tested via injection (spy on launchEdge) — the heavy
// edge behavior is covered in @bugsee/vercel-edge. environment 'node' (no real workerd isolate).
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
