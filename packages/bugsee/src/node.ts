import { type Bugsee, type BugseeLaunchOptions, launchCore } from '@bugsee/node';
import { type UmbrellaExtensionOptions, wireUmbrella } from './wire';

// The `bugsee` umbrella launch() for NODE — the batteries-included server entry (selected via the package
// `exports` "node" condition). It runs the Node composition root (@bugsee/node's launchCore) and wires the
// on-by-default extensions via the shared wireUmbrella. Node has no pageload lifecycle, so instead of a
// pageload transaction it records a startup transaction (process-start → launch, `app.start`); web-vitals
// and finish-on-hidden are browser-only. Consume + produce-tee work automatically; http-spans and
// propagation attach to the active transaction the app starts per request (the span API).

export interface BugseeNodeLaunchOptions extends BugseeLaunchOptions, UmbrellaExtensionOptions {
  /** Process start time (ms) for the `app.start` startup transaction. Default `Date.now() -
   *  process.uptime()*1000`; override for determinism / a custom start mark. */
  appStartTimeMs?: number;
}

export function launch(appToken: string, options: BugseeNodeLaunchOptions = {}): Bugsee {
  const { client, internals } = launchCore(appToken, options);
  // No internals → a prior launch already owns the process singleton (and already wired the extensions).
  if (internals === undefined) return client;
  // Process start = now − uptime. Reached via globalThis (no node:process import → no node types needed);
  // this entry only runs on Node, where process.uptime always exists.
  const startupAtMs =
    options.appStartTimeMs ??
    Date.now() -
      Math.round((globalThis as { process: { uptime(): number } }).process.uptime() * 1000);
  return wireUmbrella(client, internals, options, { pageload: false, startupAtMs });
}
