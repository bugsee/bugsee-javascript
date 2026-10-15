// @bugsee/bun — Bun platform. Bun is node-API-compatible, so this package IS @bugsee/node with
// two Bun-specific overrides: launch()/launchCore() default the system probe (platform.type 'bun' + Bun
// version) and the system trace producers (createNodeSystemTraceProducers over guarded perf_hooks). The full
// node surface is re-exported; the explicit launch/launchCore exports below shadow node's same-named exports.

export * from '@bugsee/node';
export {
  type BunServeInterceptorOptions,
  createBunServeInterceptor,
} from './bun-serve-interceptor';
export { bunSystemProbe, createBunSystemProbe } from './environment';
// Bun's launch()/launchCore() — shadow the @bugsee/node ones re-exported by `export *` above.
export { launch, launchCore } from './launch';
// Likewise `relaunch` re-runs THIS launch (the node one from `export *` would drop the runtime probe/gates).
export { relaunch } from './relaunch';
// The legacy guarded sampler (createGuardedSystemMetricsSampler + PerfHooks + GuardedSystemMetricsDeps) lives in
// @bugsee/node and is surfaced via `export *` above; launch no longer uses it (it uses the trace producers), but
// it still works as a caller-supplied `systemMetricsSampler`.
