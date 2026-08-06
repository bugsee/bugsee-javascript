import { defineConfig } from 'tsup';
import { baseConfig } from '../../tsup.config.base';

// The umbrella ships TWO entries — a browser/default entry (index) and a node entry (index.node) —
// each built dual (ESM+CJS) -> dist/index.{js,cjs,d.ts,d.cts} + dist/index.node.{js,cjs,d.ts,d.cts}.
// The package `exports` route per-runtime (browser/node) x per-module (import/require) to the
// matching dist artifact. See docs/design/packaging-dual-module.md §D5.
export default defineConfig({
  ...baseConfig,
  entry: ['src/index.ts', 'src/index.node.ts', 'src/index.bun.ts', 'src/index.deno.ts'],
});
