import type { Bugsee, BugseeLaunchOptions, LaunchResult } from '@bugsee/node';
import { type UmbrellaExtensionOptions, wireUmbrella } from './wire';

// The shared umbrella launch() for every SERVER runtime — node, bun and deno (Wave 3b.1 / 4.1).
//
// All three run the same composition: a platform `launchCore`, then the on-by-default extensions via
// `wireUmbrella`. Only the `launchCore` differs, and only in its defaults — Bun swaps in the Bun identity
// probe, a guarded perf_hooks sampler and the `Bun.serve` interceptor; Deno the equivalents for `Deno.serve`.
// Factoring it here is what keeps the three entries from drifting, which matters because the drift is
// invisible: they are selected by `exports` conditions, so only the runtime that resolves a given entry
// ever executes it.
//
// A server runtime has no pageload lifecycle, so instead of a pageload transaction it records a startup
// transaction (process-start → launch, `app.start`); web-vitals and finish-on-hidden are browser-only.

export interface BugseeServerLaunchOptions extends BugseeLaunchOptions, UmbrellaExtensionOptions {
  /** Process start time (ms) for the `app.start` startup transaction. Default `Date.now() -
   *  process.uptime()*1000`; override for determinism / a custom start mark. */
  appStartTimeMs?: number;
}

/** Bind the umbrella's server launch() to one platform composition root. */
export function createServerLaunch(
  launchCore: (appToken: string, options: BugseeLaunchOptions) => LaunchResult,
): (appToken: string, options?: BugseeServerLaunchOptions) => Bugsee {
  return (appToken: string, options: BugseeServerLaunchOptions = {}): Bugsee => {
    const { client, internals } = launchCore(appToken, options);
    // No internals → a prior launch already owns the process singleton (and already wired the extensions).
    if (internals === undefined) return client;
    // Process start = now − uptime. Reached via globalThis (no node:process import → no node types needed);
    // these entries only run on server runtimes, where process.uptime always exists (Bun and Deno both
    // provide it through their node-compat layers).
    const startupAtMs =
      options.appStartTimeMs ??
      Date.now() -
        Math.round((globalThis as { process: { uptime(): number } }).process.uptime() * 1000);
    return wireUmbrella(client, internals, options, { pageload: false, startupAtMs });
  };
}
