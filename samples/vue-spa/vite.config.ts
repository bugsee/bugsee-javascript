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
