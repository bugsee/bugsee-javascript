import { defineConfig } from 'tsup';
import { baseConfig } from '../../tsup.config.base';

// @bugsee/nuxt: `index` (the Nuxt Module — U1, forthcoming) + `server` (the Nitro server-error bridge core).
export default defineConfig({
  ...baseConfig,
  entry: ['src/index.ts', 'src/server.ts'],
});
