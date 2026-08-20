import { fileURLToPath, URL } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { defineConfig, loadEnv } from 'vite';
import { recipeApiPlugin } from './src/api/server-plugin';

export default defineConfig(({ mode }) => {
  // Bridge the plain (unprefixed) BUGSEE_* names required by the samples convention
  // (docs/samples/PLAN.md §3) into import.meta.env.VITE_* so client code can read them, without
  // renaming the .env file itself.
  const env = loadEnv(mode, process.cwd(), '');

  return {
    plugins: [vue(), recipeApiPlugin()],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    server: {
      port: 5303,
      strictPort: true,
    },
    preview: {
      port: 5303,
      strictPort: true,
    },
    build: {
      sourcemap: true,
      rollupOptions: {
        // WORKAROUND for a packaging defect in @bugsee/replay + @bugsee/replay-canvas (see
        // samples/vue-spa/FINDINGS.md F-1): their packed tarballs still point `exports`/`main`/`types`
        // at `./src/index.ts` (the monorepo dev-mode convention — publishConfig.exports is MISSING from
        // both package.json files, unlike every other browser-family package), and only `src/index.ts`
        // itself (not its sibling modules) is included in the tarball. @bugsee/browser's dist
        // unconditionally contains `await import('@bugsee/replay')` / `('@bugsee/replay-canvas')` —
        // gated at RUNTIME by the `replay` launch option, but Vite's bundler resolves dynamic-import
        // targets at build/scan time regardless, so both `pnpm dev` and `pnpm build` fail before the
        // app ever runs unless these two are marked external. This sample launches with `replay: false`
        // (see src/bugsee.ts), so the excluded import is never actually reached at runtime.
        external: ['@bugsee/replay', '@bugsee/replay-canvas'],
      },
    },
    optimizeDeps: {
      exclude: ['@bugsee/replay', '@bugsee/replay-canvas'],
    },
    define: {
      'import.meta.env.VITE_BUGSEE_APP_TOKEN': JSON.stringify(env.BUGSEE_APP_TOKEN ?? ''),
      'import.meta.env.VITE_BUGSEE_ENDPOINT': JSON.stringify(
        env.BUGSEE_ENDPOINT ?? 'https://apidev.bugsee.com',
      ),
      'import.meta.env.VITE_BUGSEE_APP_BUILD': JSON.stringify(env.BUGSEE_APP_BUILD ?? '1'),
    },
  };
});
