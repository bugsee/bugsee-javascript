import { getCarrierClient } from '@bugsee/core';
import {
  type Bugsee,
  type BugseeLaunchOptions,
  createNodeSystemTraceProducers,
  type LaunchResult,
  launchCore as nodeLaunchCore,
} from '@bugsee/node';
import { createBunServeInterceptor } from './bun-serve-interceptor';
import { bunSystemProbe } from './environment';

// @bugsee/bun launch() — the Bun composition root. Bun runs on a node-compatible API surface (node:http,
// node:fs, process, timers), so this reuses the ENTIRE @bugsee/node composition (transport, fs storage,
// node:http capture, crash detection, durable queue + capture recovery) and only swaps the two
// Bun-specific defaults: the system probe (reports platform.type 'bun' + the Bun version) and the
// system trace producers (guarded perf_hooks). Both remain overridable — a caller-supplied option wins
// (it spreads AFTER the Bun defaults).

export function launchCore(appToken: string, options: BugseeLaunchOptions = {}): LaunchResult {
  return nodeLaunchCore(appToken, {
    systemProbe: bunSystemProbe,
    systemTraceProducers: createNodeSystemTraceProducers({
      // JSC's heap statistics are not a V8 ceiling (`limit - used` is meaningless; ~1000x Node's cost per call),
      // so the V8 heap traces are omitted here.
      measuresV8Heap: false,
      // Bun < 1.3.13's `os.freemem()` is not MemAvailable on Linux, so `ram_system_free` reads /proc/meminfo
      // MemAvailable first there, then os.freemem() (omitted on macOS: Bun has no native available figure).
      // `process.availableMemory()` is never used.
      readsProcMeminfo: true,
      // `PerformanceObserver('gc')` is BLIND on Bun (0 entries after heavy churn — measured): a quiet-looking
      // zero would be a lie, so no observer is constructed and the gc traces are omitted.
      measuresGc: false,
      // the shared tracker's sampling timer honors an injected scheduler, and its poll errors are reported
      ...(options.scheduler !== undefined ? { scheduler: options.scheduler } : {}),
      ...(options.onError !== undefined ? { onError: options.onError } : {}),
    }),
    ...options,
    // LOCAL VARIABLES ARE OFF HERE, after `...options` so a caller cannot switch them on. Measured on
    // Bun 1.4.0: `Debugger.enable` is REFUSED — `Inspector method "Debugger.enable" requires an active
    // inspector (call inspector.open() first)` — so no pause ever arrives and the capture is inert.
    // Unlike Deno this is safe rather than dangerous (nothing freezes), but an option that is accepted
    // and silently does nothing is still a lie to whoever set it.
    //
    // Reversible the moment Bun implements the Debugger domain without `inspector.open()`; opening one
    // ourselves is not an option, since that exposes a debugger port in a production process.
    captureLocalVariables: false,
    // Bun's native serve wrap (instruments idiomatic Bun.serve({fetch}) apps that bypass node:http),
    // CONCATENATED before any caller-supplied server instrumentations — never spread-replaced, so a user
    // array does not drop it. node still installs its own node:http interceptor first when the flag is on;
    // all of it activates only when `instrumentIncomingRequests` is set. getClient binds to the carrier.
    serverInstrumentations: [
      createBunServeInterceptor({
        getClient: () => getCarrierClient<Bugsee>(options.carrier),
        ...(options.traceResponse !== undefined ? { traceResponse: options.traceResponse } : {}),
      }),
      ...(options.serverInstrumentations ?? []),
    ],
  });
}

/** The public Bun composition root: the launched client. Equivalent to `launchCore(...).client`. */
export function launch(appToken: string, options: BugseeLaunchOptions = {}): Bugsee {
  return launchCore(appToken, options).client;
}
