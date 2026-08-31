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
  // tsup defaults this to true, which runs esbuild's nodeProtocolPlugin: an onResolve hook
  // (filter /^node:/) that rewrites a `node:`-prefixed built-in to a bare specifier wherever esbuild's
  // bundler can SEE the import/require/dynamic-import as a literal specifier reachable through the
  // module graph — static `import from 'node:x'`, top-level or in-function `require('node:x')`, and
  // `import('node:x')` are all rewritten alike. Bare specifiers are ambiguous for bundlers and
  // UNRESOLVABLE on edge runtimes that require the explicit form (e.g. workerd only exposes
  // AsyncLocalStorage via `node:async_hooks`, never bare `async_hooks` — see
  // packages/cloudflare/src/launch.ts). Setting this false skips that hook, so those call sites keep
  // the prefix exactly as authored.
  // NOT covered either way, because esbuild never resolves them as imports in the first place: (a) a
  // specifier reached through an aliased/indirect `require` reference (`const req = require; req('node:x')`)
  // or built from a non-literal expression (`require(someVar)`) — invisible to the static resolver, so it
  // passes through completely unexamined; (b) `node:`-prefixed text embedded in a plain string, e.g. the
  // worker-thread bootstrap scripts assembled as JS-source template literals and run via `{ eval: true }`
  // (packages/node/src/liveness-heartbeat.ts's `WORKER_SCRIPT`, packages/node/src/event-loop-watchdog.ts,
  // packages/node-utils/src/worker-ring-worker.ts) — that text is just characters to the bundler, not a
  // resolvable import, so it is preserved (or would be stripped) only by accident of not being code.
  removeNodeProtocol: false,
};
