import { defineConfig } from 'tsup';
import { baseConfig } from '../../tsup.config.base';

// @bugsee/remix ships a per-runtime entry split so no runtime's code leaks into another's graph
// (docs/design/meta-framework-adapters.md): `index` (portable — the handleError bridge, used in
// entry.server on node OR edge) + `server` (node-only composition). The client entry is added by R2.
export default defineConfig({
  ...baseConfig,
  entry: ['src/index.ts', 'src/server.ts'],
});
