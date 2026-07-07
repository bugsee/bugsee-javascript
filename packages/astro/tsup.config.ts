import { defineConfig } from 'tsup';
import { baseConfig } from '../../tsup.config.base';

// @bugsee/astro: the Integration (`index`) + `middleware` (error capture + trace). client/server/edge
// entries are added as their slices land.
export default defineConfig({
  ...baseConfig,
  entry: ['src/index.ts', 'src/middleware.ts'],
});
