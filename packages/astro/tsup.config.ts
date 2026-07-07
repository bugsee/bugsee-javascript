import { defineConfig } from 'tsup';
import { baseConfig } from '../../tsup.config.base';

// @bugsee/astro: the Integration (`index`) + `middleware` (error capture + trace) + `server`/`client`/`edge`
// launch entries.
export default defineConfig({
  ...baseConfig,
  entry: ['src/index.ts', 'src/middleware.ts', 'src/server.ts', 'src/client.ts', 'src/edge.ts'],
});
