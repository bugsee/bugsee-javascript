import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig, loadEnv } from 'vite';

// (docs/samples/PLAN.md §3) Read .env into import.meta.env.VITE_* so client code can read it without
// a bundler-time secret leak — the token is a staging-only app token, never a real secret, but the
// pattern is the same one every sample follows.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [svelte()],
    server: {
      port: 5304,
      strictPort: true,
      proxy: {
        '/api': {
          target: 'http://localhost:5334',
          changeOrigin: true,
          ws: true,
        },
      },
    },
    preview: {
      port: 5304,
      strictPort: true,
      proxy: {
        '/api': {
          target: 'http://localhost:5334',
          changeOrigin: true,
          ws: true,
        },
      },
    },
    define: {
      'import.meta.env.VITE_BUGSEE_APP_TOKEN': JSON.stringify(env.BUGSEE_APP_TOKEN ?? ''),
      'import.meta.env.VITE_BUGSEE_ENDPOINT': JSON.stringify(
        env.BUGSEE_ENDPOINT ?? 'https://apidev.bugsee.com',
      ),
    },
    build: {
      sourcemap: true,
      // Vite 8's default minifier (oxc) — 'esbuild' now requires the `esbuild` package as a separate
      // dependency (vite 8 dropped the bundled copy), which this sample under test has no reason to add.
      minify: true,
    },
  };
});
