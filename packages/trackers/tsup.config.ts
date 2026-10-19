import { defineConfig } from 'tsup';
import { baseConfig } from '../../tsup.config.base';

// The root entry plus the reserved per-runtime subpath entries (dist/{index,browser,node,electron}.*).
export default defineConfig({
  ...baseConfig,
  entry: {
    index: 'src/index.ts',
    browser: 'src/browser/index.ts',
    node: 'src/node/index.ts',
    electron: 'src/electron/index.ts',
  },
});
