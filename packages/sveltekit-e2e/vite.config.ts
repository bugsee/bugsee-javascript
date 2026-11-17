import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { componentAnnotatePreprocessor } from '../svelte-plugin-component-annotate/dist/index.js';

// Kit 3 rejects `svelte.config.js`: configuration is passed through the `sveltekit(...)` plugin.
// `preprocess` mirrors the @bugsee/sveltekit README example (asserted in the e2e). The plugin is imported from
// its BUILT dist (the e2e builds it first): Kit re-loads this file in a plain-Node post-build process, which cannot
// resolve the workspace's extensionless TS source (published consumers get dist anyway).
// The @bugsee/* + bugsee packages are consumed as TS SOURCE in the workspace — Vite must bundle+transpile
// them for SSR (not externalize them as pre-built JS).
export default defineConfig({
  plugins: [sveltekit({ adapter: adapter(), preprocess: [componentAnnotatePreprocessor()] })],
  ssr: { noExternal: [/@bugsee\//, 'bugsee'] },
});
