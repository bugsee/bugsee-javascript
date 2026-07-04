import { defineConfig } from 'tsup';
import { baseConfig } from '../../tsup.config.base';

// @bugsee/nextjs ships one entry per Next.js runtime seam so no runtime's code is bundled into
// another's graph (see docs/design/nextjs-adapter.md §3, constraint 1): `index` (portable shared
// surface) + `server` (node-only composition, via `await import('@bugsee/nextjs/server')`) + `client`
// (browser-only composition + @bugsee/react, imported from instrumentation-client.ts). The edge entry
// is added by N2.
export default defineConfig({
  ...baseConfig,
  entry: ['src/index.ts', 'src/server.ts', 'src/client.ts'],
});
