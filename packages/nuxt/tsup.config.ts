import { defineConfig } from 'tsup';
import { baseConfig } from '../../tsup.config.base';

// @bugsee/nuxt: `index` (the Nuxt Module — U1, forthcoming) + `server` (Nitro server-error bridge, node) +
// `client` (the Vue client-plugin core, browser).
export default defineConfig({
  ...baseConfig,
  entry: ['src/index.ts', 'src/server.ts', 'src/client.ts'],
});
