// @bugsee/bun — Bun platform (tier 2). Bun is node-API-compatible, so this package IS @bugsee/node with
// two Bun-specific overrides: launch()/launchCore() default the system probe (platform.type 'bun' + Bun
// version) and the system-metrics sampler (guarded perf_hooks). The full node surface is re-exported; the
// explicit launch/launchCore exports below shadow node's same-named exports.

export * from '@bugsee/node';
export { bunSystemProbe, createBunSystemProbe } from './environment';
// Bun's launch()/launchCore() — shadow the @bugsee/node ones re-exported by `export *` above.
export { launch, launchCore } from './launch';
export {
  type BunSystemMetricsDeps,
  createBunSystemMetricsSampler,
  type PerfHooks,
} from './system-metrics';
