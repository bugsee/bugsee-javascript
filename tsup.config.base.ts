import type { Options } from 'tsup';

// Shared tsup preset for the dual ESM+CJS build (design: docs/design/packaging-dual-module.md).
// Each package's tsup.config.ts spreads this. @bugsee/* + declared deps are EXTERNAL by default (not
// bundled), so packages share their deps via node_modules — no duplication. Dev still consumes src
// directly (the package `exports` point at ./src); `dist` is what `publishConfig.exports` ships.
export const baseConfig: Options = {
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'], // -> dist/index.js (ESM, since type:module) + dist/index.cjs (CJS)
  dts: true, // -> dist/index.d.ts
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: 'es2022', // matches tsconfig.base.json (Node >= 18)
  outDir: 'dist',
};
