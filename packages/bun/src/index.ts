// @bugsee/bun — Bun platform (tier 2). Bun is node-API-compatible, so this package IS @bugsee/node with
// two Bun-specific overrides: launch()/launchCore() default the system probe (platform.type 'bun' + Bun
// version) and the system-metrics sampler (guarded perf_hooks). The full node surface is re-exported; the
// explicit launch/launchCore exports below shadow node's same-named exports.

export * from '@bugsee/node';
export {
  type BunServeInterceptorOptions,
  createBunServeInterceptor,
} from './bun-serve-interceptor';
export { bunSystemProbe, createBunSystemProbe } from './environment';
// Bun's launch()/launchCore() — shadow the @bugsee/node ones re-exported by `export *` above.
export { launch, launchCore } from './launch';
// The guarded sampler (createGuardedSystemMetricsSampler + PerfHooks + GuardedSystemMetricsDeps) is now
// shared in @bugsee/node and surfaced via `export *` above — no Bun-specific copy.
