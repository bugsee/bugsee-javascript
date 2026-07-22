import { defineConfig } from 'tsup';
import { baseConfig } from '../../tsup.config.base';

// @bugsee/replay-canvas: the opt-in canvas-replay add-on, lazy-loaded via `replay: { canvas }`. A pure
// options-builder (no rrweb/DOM runtime dep); @bugsee/replay is external (declared dep, types only).
export default defineConfig({
  ...baseConfig,
  entry: ['src/index.ts'],
});
