import { defineConfig } from 'vitest/config';

// Preact 11 compat smoke (the package `test` and `test:coverage` scripts run it after the main suite, which is what CI invokes). The same sources, with `react` /
// `react-dom` aliased to `preact/compat` exactly as a Preact app's bundler does. Kept out of the main config
// (which gates coverage against real React) via the `*.preact.test.ts` suffix.
export default defineConfig({
  resolve: {
    alias: [
      { find: /^react-dom\/client$/, replacement: 'preact/compat/client' },
      { find: /^react-dom$/, replacement: 'preact/compat' },
      { find: /^react$/, replacement: 'preact/compat' },
    ],
  },
  test: {
    testTimeout: 30_000,
    environment: 'jsdom',
    include: ['src/**/*.preact.test.ts'],
  },
});
