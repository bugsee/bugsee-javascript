// @bugsee/vite-plugin — the Vite entry over @bugsee/bundler-plugin-core. At build end it drives `bugsee-cli`
// to inject debug-IDs, upload the source-maps, and delete the client `.map`s (privacy). See
// docs/design/source-maps.md.
//
//   import { bugseeVitePlugin } from '@bugsee/vite-plugin';
//   export default defineConfig({ plugins: [bugseeVitePlugin({ appToken: '…' })] });
import { type BugseePluginOptions, bugseeUnplugin } from '@bugsee/bundler-plugin-core';

export type { BugseePluginOptions };

/** The Bugsee Vite plugin factory: `bugseeVitePlugin(options)` → a Vite plugin. */
export const bugseeVitePlugin = bugseeUnplugin.vite;

export default bugseeVitePlugin;
