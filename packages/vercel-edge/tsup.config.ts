import { defineConfig } from 'tsup';
import { baseConfig } from '../../tsup.config.base';

// `relaunch-edge` is a separate entry (not re-exported from the index): see its header (R5H-4).
export default defineConfig({
  ...baseConfig,
  entry: ['src/index.ts', 'src/relaunch-edge.ts'],
});
