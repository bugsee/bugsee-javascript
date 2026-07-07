import { defineConfig } from 'tsup';
import { baseConfig } from '../../tsup.config.base';

// @bugsee/rrweb: the thin record-path wrapper. rrweb packages are declared deps → external (not bundled).
export default defineConfig({
  ...baseConfig,
  entry: ['src/index.ts'],
});
