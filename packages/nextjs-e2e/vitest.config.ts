import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.e2e.ts'],
    // A real `next build` is slow — this budget is for the build, not for any assertion.
    testTimeout: 600_000,
    hookTimeout: 600_000,
    fileParallelism: false,
  },
});
