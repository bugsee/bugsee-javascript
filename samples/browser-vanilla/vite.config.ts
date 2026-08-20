import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import { widgetShopApiPlugin } from './server/api-plugin.ts';
import { bugseeCorsProxyPlugin } from './server/bugsee-proxy.ts';

// SDK-defect workaround (recorded in FINDINGS.md as F-1, blocker): the packed tarballs for
// @bugsee/replay, @bugsee/replay-canvas and @bugsee/rrweb ship WITHOUT a `publishConfig` block, so
// their root `main`/`exports` still point at `./src/index.ts` (the in-monorepo dev entry) instead of
// `./dist/index.js`. The packed tarball only contains `dist/` plus the single leaf `src/index.ts`
// file, not that file's siblings (`./encoder`, `./masking`, `./recorder`, `./register`,
// `./canvas-config`), so resolving the source entry from an installed tarball fails outright — replay
// and replay-canvas are unusable as installed packages without this alias. This is a SAMPLE-LOCAL
// workaround only (no packages/ or node_modules content is touched) so the rest of the sample — and
// S11 in particular — can still be exercised end-to-end; the underlying defect is not fixed here.
// These three are transitive deps (not direct deps of this sample's package.json), so pnpm's strict
// node_modules layout does NOT hoist them to top-level `node_modules/@bugsee/<name>` — only the pnpm
// virtual store path resolves. That path's encoding of the `file:` override
// (`@bugsee+<name>@file+..+..+.local-registry+bugsee-<name>.tgz`) is pnpm's own dependency-key format,
// stable across `pnpm install` runs for as long as the override string itself doesn't change.
const distEntry = (pkg: string): string =>
  fileURLToPath(
    new URL(
      `./node_modules/.pnpm/@bugsee+${pkg}@file+..+..+.local-registry+bugsee-${pkg}.tgz/node_modules/@bugsee/${pkg}/dist/index.js`,
      import.meta.url,
    ),
  );

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'BUGSEE_');
  const realEndpoint = env.BUGSEE_ENDPOINT ?? 'https://apidev.bugsee.com';

  return {
    root: '.',
    // BUGSEE_APP_TOKEN / BUGSEE_ENDPOINT come from .env per the sample convention
    // (docs/samples/PLAN.md §3); Vite only exposes VITE_-prefixed vars to client code by default, so
    // widen the prefix instead of renaming the documented variable names.
    envPrefix: ['VITE_', 'BUGSEE_'],
    server: { port: 5301, strictPort: true },
    preview: { port: 5301, strictPort: true },
    plugins: [widgetShopApiPlugin(), bugseeCorsProxyPlugin(realEndpoint)],
    resolve: {
      alias: [
        { find: '@bugsee/replay-canvas', replacement: distEntry('replay-canvas') },
        { find: '@bugsee/replay', replacement: distEntry('replay') },
        { find: '@bugsee/rrweb', replacement: distEntry('rrweb') },
      ],
    },
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
