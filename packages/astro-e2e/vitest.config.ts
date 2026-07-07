import { defineConfig } from 'vitest/config';

// Real-Astro boot e2e: builds + boots a real Astro app, so hooks/tests need long timeouts. Not part of
// `pnpm test` — run via `pnpm --filter @bugsee/astro-e2e test:e2e`.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.e2e.ts'],
    testTimeout: 120_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
