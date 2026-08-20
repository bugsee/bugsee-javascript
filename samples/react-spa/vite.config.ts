import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { bugseeVitePlugin } from '@bugsee/vite-plugin';
import { defineConfig, loadEnv } from 'vite';

// A build counter so every production build we upload source maps for is identifiable in the
// dashboard (README §Run it / scenarios.md S1's appVersion/appBuild requirement). Persisted to a
// dotfile so `pnpm build` run twice in a row produces two distinct appBuild values.
const buildCounterFile = fileURLToPath(new URL('./.build-counter', import.meta.url));
function nextBuildCounter(): string {
  let n = 0;
  try {
    n = Number.parseInt(readFileSync(buildCounterFile, 'utf8').trim(), 10) || 0;
  } catch {
    // first build
  }
  n += 1;
  try {
    writeFileSync(buildCounterFile, String(n));
  } catch {
    // best-effort; a missing counter file just restarts at 1 next time
  }
  return String(n);
}

export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const appBuild = command === 'build' ? nextBuildCounter() : 'dev';

  return {
    plugins: [
      react({
        babel: {
          // @bugsee/babel-plugin-component-annotate under test: stamps every host JSX element with
          // data-bugsee-component="<EnclosingComponent>" so @bugsee/browser's D2 runtime can attribute
          // clicks/errors to a component name that survives minification.
          plugins: ['@bugsee/babel-plugin-component-annotate'],
        },
      }),
      // @bugsee/vite-plugin under test: injects debug-IDs + uploads source maps via bugsee-cli at the
      // end of a PRODUCTION build only — a dev server has no bundle to symbolicate.
      bugseeVitePlugin({
        appToken: env.BUGSEE_APP_TOKEN,
        endpoint: env.BUGSEE_ENDPOINT,
        appVersion: '1.0.0',
        appBuild,
        disabled: command !== 'build',
        failOnError: true,
        onError: (error) => {
          // eslint-disable-next-line no-console
          console.error('[bugsee-vite-plugin] source-map upload failed:', error);
        },
      }),
    ],
    define: {
      // Handed to the client at build time (see src/bugsee.ts) — never committed, read from .env.
      'import.meta.env.VITE_BUGSEE_APP_TOKEN': JSON.stringify(env.BUGSEE_APP_TOKEN ?? ''),
      'import.meta.env.VITE_BUGSEE_ENDPOINT': JSON.stringify(
        env.BUGSEE_ENDPOINT ?? 'https://apidev.bugsee.com',
      ),
      'import.meta.env.VITE_APP_BUILD': JSON.stringify(appBuild),
    },
    server: {
      port: 5302,
      strictPort: true,
      proxy: {
        '/api': {
          target: 'http://localhost:5330',
          changeOrigin: true,
          ws: true,
        },
      },
    },
    preview: {
      port: 5302,
      strictPort: true,
      proxy: {
        '/api': {
          target: 'http://localhost:5330',
          changeOrigin: true,
          ws: true,
        },
      },
    },
    build: {
      sourcemap: true,
      minify: 'esbuild',
    },
  };
});
