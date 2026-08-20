import { defineConfig } from 'tsup';
import { baseConfig } from '../../tsup.config.base';

// The four published entries: the shared surface plus the per-process ones (./main, ./renderer,
// ./preload). They were declared in `exports` but never built, so those three subpaths resolved to
// nothing in a published tarball.
export default defineConfig({
  ...baseConfig,
  entry: ['src/index.ts', 'src/main.ts', 'src/renderer.ts', 'src/preload.ts'],
});
