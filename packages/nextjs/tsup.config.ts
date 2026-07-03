import { defineConfig } from 'tsup';
import { baseConfig } from '../../tsup.config.base';

// @bugsee/nextjs ships one entry per Next.js runtime seam so no runtime's code is bundled into
// another's graph (see docs/design/nextjs-adapter.md §3, constraint 1): `index` (shared surface) +
// `server` (node-only composition, reached via `await import('@bugsee/nextjs/server')` from the
// NEXT_RUNTIME==='nodejs' branch of instrumentation.ts). Edge + client entries are added by later slices.
export default defineConfig({
  ...baseConfig,
  entry: ['src/index.ts', 'src/server.ts'],
});
