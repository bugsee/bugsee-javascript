import { defineConfig } from 'tsup';
import { baseConfig } from '../../tsup.config.base';

// @bugsee/nextjs ships one entry per Next.js runtime seam so no runtime's code is bundled into
// another's graph (see docs/design/nextjs-adapter.md §3, constraint 1): `index` (portable shared
// surface) + `server` (node-only, via `await import('@bugsee/nextjs/server')`) + `client` (browser-only
// composition + @bugsee/react, imported from instrumentation-client.ts) + `edge` (Vercel Edge / edge-light
// composition, reached via the register() dispatcher's edge branch).
//
// `external` (self-subpaths): the register() dispatcher's dynamic `import('@bugsee/nextjs/server' | '/edge')`
// MUST stay external so it emits a real lazy import in BOTH esm+cjs. tsup does not externalize the package's
// OWN name by default (it isn't a declared dep), so without this it would resolve the self-import to src and
// INLINE ./server into the CJS index — hoisting `require('bugsee/node')` and leaking node into the portable
// `.` entry (#172). Keeping them external is what preserves the code-split in the (non-splitting) CJS build.
export default defineConfig({
  ...baseConfig,
  entry: ['src/index.ts', 'src/server.ts', 'src/client.ts', 'src/edge.ts', 'src/middleware.ts'],
  external: ['@bugsee/nextjs/server', '@bugsee/nextjs/edge'],
});
