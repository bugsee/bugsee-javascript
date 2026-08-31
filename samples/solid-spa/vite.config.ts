import solid from 'vite-plugin-solid';
import { defineConfig, loadEnv } from 'vite';

// @bugsee/solid ships no bundler plugin (unlike @bugsee/react's vite-plugin/babel-plugin) — see
// docs/samples/PLAN.md §1a: this sample's ONLY package under test is @bugsee/solid itself.
export default defineConfig(({ mode }) => {
  // Bridge the plain (unprefixed) BUGSEE_* names required by the samples convention
  // (docs/samples/PLAN.md §3) into import.meta.env.VITE_* so client code can read them, without
  // renaming the .env file itself.
  const env = loadEnv(mode, process.cwd(), '');

  return {
    plugins: [solid()],
    define: {
      'import.meta.env.VITE_BUGSEE_APP_TOKEN': JSON.stringify(env.BUGSEE_APP_TOKEN ?? ''),
      'import.meta.env.VITE_BUGSEE_ENDPOINT': JSON.stringify(
        env.BUGSEE_ENDPOINT ?? 'https://apidev.bugsee.com',
      ),
      'import.meta.env.VITE_APP_BUILD': JSON.stringify(env.BUGSEE_APP_BUILD ?? 'dev'),
    },
    server: {
      port: 5307,
      strictPort: true,
      proxy: {
        '/api': {
          target: 'http://localhost:5337',
          changeOrigin: true,
          ws: true,
        },
      },
    },
    preview: {
      port: 5307,
      strictPort: true,
      proxy: {
        '/api': {
          target: 'http://localhost:5337',
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
