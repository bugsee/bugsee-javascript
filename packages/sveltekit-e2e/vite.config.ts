import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// The @bugsee/* + bugsee packages are consumed as TS SOURCE in the workspace — Vite must bundle+transpile
// them for SSR (not externalize them as pre-built JS).
export default defineConfig({
  plugins: [sveltekit()],
  ssr: { noExternal: [/@bugsee\//, 'bugsee'] },
});
