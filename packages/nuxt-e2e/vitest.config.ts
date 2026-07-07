import { defineConfig } from 'vitest/config';

// Real-Nuxt boot e2e: builds + boots a real Nuxt app, so hooks/tests need long timeouts. Not part of
// `pnpm test` — run via `pnpm --filter @bugsee/nuxt-e2e test:e2e`.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.e2e.ts'],
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
