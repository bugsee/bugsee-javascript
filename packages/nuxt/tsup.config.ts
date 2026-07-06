import { defineConfig } from 'tsup';
import { baseConfig } from '../../tsup.config.base';

// @bugsee/nuxt: the Nuxt Module (`index`) + `server` (Nitro server-error bridge, node) + `client` (the Vue
// client-plugin core, browser) + the shipped `runtime/nitro-plugin` (referenced by the module via
// `addServerPlugin(resolve('./runtime/nitro-plugin'))`, so it must build to `dist/runtime/`).
//
// `@nuxt/kit` + `nitropack` are devDeps (build-time/Nitro runtime), and the self-subpaths
// `@bugsee/nuxt/{server,client}` must stay external in BOTH formats (never inlined — see #172), so the
// module + runtime bundles reference the node/browser cores instead of bundling them.
export default defineConfig({
  ...baseConfig,
  entry: ['src/index.ts', 'src/server.ts', 'src/client.ts', 'src/runtime/nitro-plugin.ts'],
  external: ['@nuxt/kit', 'nitropack', 'nitropack/runtime', '@bugsee/nuxt/server', '@bugsee/nuxt/client'],
});
