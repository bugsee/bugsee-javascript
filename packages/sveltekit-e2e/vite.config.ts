import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// Kit 3 no longer reads `svelte.config.js`: configuration is passed through the `sveltekit(...)` plugin.
// The @bugsee/* + bugsee packages are consumed as TS SOURCE in the workspace — Vite must bundle+transpile
// them for SSR (not externalize them as pre-built JS).
export default defineConfig({
  plugins: [sveltekit({ adapter: adapter() })],
  ssr: { noExternal: [/@bugsee\//, 'bugsee'] },
});
