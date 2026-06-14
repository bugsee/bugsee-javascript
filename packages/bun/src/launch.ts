import {
  type Bugsee,
  type BugseeLaunchOptions,
  type LaunchResult,
  launchCore as nodeLaunchCore,
} from '@bugsee/node';
import { bunSystemProbe } from './environment';
import { createBunSystemMetricsSampler } from './system-metrics';

// @bugsee/bun launch() — the Bun composition root. Bun runs on a node-compatible API surface (node:http,
// node:fs, process, timers), so this reuses the ENTIRE @bugsee/node composition (transport, fs storage,
// node:http capture, crash detection, durable queue + capture recovery) and only swaps the two
// Bun-specific defaults: the system probe (reports platform.type 'bun' + the Bun version) and the
// system-metrics sampler (guarded perf_hooks). Both remain overridable — a caller-supplied option wins
// (it spreads AFTER the Bun defaults).

export function launchCore(appToken: string, options: BugseeLaunchOptions = {}): LaunchResult {
  return nodeLaunchCore(appToken, {
    systemProbe: bunSystemProbe,
    systemMetricsSampler: createBunSystemMetricsSampler(),
    ...options,
  });
}

/** The public Bun composition root: the launched client. Equivalent to `launchCore(...).client`. */
export function launch(appToken: string, options: BugseeLaunchOptions = {}): Bugsee {
  return launchCore(appToken, options).client;
}
