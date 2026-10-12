// @bugsee/deno — Deno platform (tier 2). Deno is node-API-compatible, so this package IS @bugsee/node with
// two Deno-specific overrides: launch()/launchCore() default the system probe (platform.type 'deno' + Deno
// version) and the guarded system-metrics sampler (partial perf_hooks). The full node surface is re-exported;
// the explicit launch/launchCore exports below shadow node's same-named exports.

export * from '@bugsee/node';
export {
  createDenoServeInterceptor,
  type DenoServeInterceptorOptions,
} from './deno-serve-interceptor';
export { createDenoSystemProbe, denoSystemProbe } from './environment';
// Deno's launch()/launchCore() — shadow the @bugsee/node ones re-exported by `export *` above.
export { launch, launchCore } from './launch';
// Likewise `relaunch` re-runs THIS launch (the node one from `export *` would drop the runtime probe/gates).
export { relaunch } from './relaunch';
