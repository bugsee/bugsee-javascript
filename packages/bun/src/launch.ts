import { getCarrierClient } from '@bugsee/core';
import {
  type Bugsee,
  type BugseeLaunchOptions,
  createGuardedSystemMetricsSampler,
  type LaunchResult,
  launchCore as nodeLaunchCore,
} from '@bugsee/node';
import { createBunServeInterceptor } from './bun-serve-interceptor';
import { bunSystemProbe } from './environment';

// @bugsee/bun launch() — the Bun composition root. Bun runs on a node-compatible API surface (node:http,
// node:fs, process, timers), so this reuses the ENTIRE @bugsee/node composition (transport, fs storage,
// node:http capture, crash detection, durable queue + capture recovery) and only swaps the two
// Bun-specific defaults: the system probe (reports platform.type 'bun' + the Bun version) and the
// system-metrics sampler (guarded perf_hooks). Both remain overridable — a caller-supplied option wins
// (it spreads AFTER the Bun defaults).

export function launchCore(appToken: string, options: BugseeLaunchOptions = {}): LaunchResult {
  return nodeLaunchCore(appToken, {
    systemProbe: bunSystemProbe,
    systemMetricsSampler: createGuardedSystemMetricsSampler(),
    ...options,
    // Bun's native serve wrap (instruments idiomatic Bun.serve({fetch}) apps that bypass node:http),
    // CONCATENATED before any caller-supplied server instrumentations — never spread-replaced, so a user
    // array does not drop it. node still installs its own node:http interceptor first when the flag is on;
    // all of it activates only when `instrumentIncomingRequests` is set. getClient binds to the carrier.
    serverInstrumentations: [
      createBunServeInterceptor({ getClient: () => getCarrierClient<Bugsee>(options.carrier) }),
      ...(options.serverInstrumentations ?? []),
    ],
  });
}

/** The public Bun composition root: the launched client. Equivalent to `launchCore(...).client`. */
export function launch(appToken: string, options: BugseeLaunchOptions = {}): Bugsee {
  return launchCore(appToken, options).client;
}
