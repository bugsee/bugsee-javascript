import { defineConfig } from 'tsup';
import { baseConfig } from '../../tsup.config.base';

// @bugsee/replay: lazy-loaded via the `replay` launch option. rrweb + fflate are external (declared deps).
export default defineConfig({
  ...baseConfig,
  // `./stream-encoder` is the export encoder alone (fflate + core types): a Node/Electron main builds replay.bin with it without loading rrweb.
  entry: ['src/index.ts', 'src/stream-encoder.ts'],
});
