import { getCarrierClient } from '@bugsee/core';
import {
  type Bugsee,
  type BugseeLaunchOptions,
  createGuardedSystemMetricsSampler,
  type LaunchResult,
  launchCore as nodeLaunchCore,
} from '@bugsee/node';
import { createDenoServeInterceptor } from './deno-serve-interceptor';
import { denoSystemProbe } from './environment';

// @bugsee/deno launch() — the Deno composition root. Deno 2 runs on a node-compatible API surface (node:http,
// node:fs, node:process, node:worker_threads, node:inspector), so this reuses the ENTIRE @bugsee/node
// composition (transport, fs storage, node:http capture, crash detection, durable queue + capture recovery,
// CPU profiling, ANR/hang detection) and only swaps the two Deno-specific defaults: the system probe (reports
// platform.type 'deno' + the Deno version) and the guarded system-metrics sampler (partial perf_hooks).
// Diagnostics that touch a partially-supported API (node:inspector / worker_threads) are capability-guarded
// in the node tier, so they self-disable where Deno lacks them. Both defaults remain overridable (a
// caller-supplied option spreads AFTER them).

export function launchCore(appToken: string, options: BugseeLaunchOptions = {}): LaunchResult {
  return nodeLaunchCore(appToken, {
    systemProbe: denoSystemProbe,
    systemMetricsSampler: createGuardedSystemMetricsSampler(),
    ...options,
    // Deno's native serve wrap (instruments idiomatic Deno.serve apps that bypass node:http), CONCATENATED
    // before any caller-supplied server instrumentations — never spread-replaced. node still installs its
    // own node:http interceptor first when the flag is on; all of it activates only when
    // `instrumentIncomingRequests` is set. getClient binds to the carrier.
    serverInstrumentations: [
      createDenoServeInterceptor({ getClient: () => getCarrierClient<Bugsee>(options.carrier) }),
      ...(options.serverInstrumentations ?? []),
    ],
  });
}

/** The public Deno composition root: the launched client. Equivalent to `launchCore(...).client`. */
export function launch(appToken: string, options: BugseeLaunchOptions = {}): Bugsee {
  return launchCore(appToken, options).client;
}
