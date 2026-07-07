import { defineConfig } from 'vitest/config';

// Real-SvelteKit boot e2e: builds + boots a real SvelteKit app, so hooks/tests need long timeouts. Not part
// of `pnpm test` — run via `pnpm --filter @bugsee/sveltekit-e2e test:e2e`.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.e2e.ts'],
    testTimeout: 120_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
