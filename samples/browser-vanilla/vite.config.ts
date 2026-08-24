import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { widgetShopApiPlugin } from './server/api-plugin.ts';

export default defineConfig(() => {
  return {
    root: '.',
    // BUGSEE_APP_TOKEN / BUGSEE_ENDPOINT come from .env per the sample convention
    // (docs/samples/PLAN.md §3); Vite only exposes VITE_-prefixed vars to client code by default, so
    // widen the prefix instead of renaming the documented variable names.
    envPrefix: ['VITE_', 'BUGSEE_'],
    server: { port: 5301, strictPort: true },
    preview: { port: 5301, strictPort: true },
    plugins: [widgetShopApiPlugin()],
    build: {
      sourcemap: true,
      rollupOptions: {
        input: {
          main: 'index.html',
          // A Service Worker registration takes a literal URL string, not a bundler-resolved module
          // specifier — Vite has no hashed-asset reference for it the way `new Worker(new URL(...))`
          // gets for the dedicated worker. Building it as its OWN rollup entry, forced to an unhashed
          // top-level `service-worker.js` (below), gives it a stable production URL;
          // `src/lib/sw-register.ts` picks the dev vs. prod path via `import.meta.env.DEV`.
          'service-worker': fileURLToPath(new URL('./src/sw/service-worker.ts', import.meta.url)),
        },
        output: {
          entryFileNames: (chunk) =>
            chunk.name === 'service-worker' ? 'service-worker.js' : 'assets/[name]-[hash].js',
        },
      },
    },
    worker: {
      format: 'es',
    },
  };
});
