import { defineConfig } from 'tsup';
import { baseConfig } from '../../tsup.config.base';

// @bugsee/replay: lazy-loaded via the `replay` launch option. rrweb + fflate are external (declared deps).
export default defineConfig({
  ...baseConfig,
  entry: ['src/index.ts'],
});
