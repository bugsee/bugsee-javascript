import { type Bugsee, type BugseeLaunchOptions, launchCore } from '@bugsee/browser';
import { type UmbrellaExtensionOptions, wireUmbrella } from './wire';

// The `bugsee` umbrella launch() for the BROWSER — the batteries-included entry. It runs the browser
// composition root (@bugsee/browser's launchCore, which returns the client PLUS its internal wiring) and
// then wires the on-by-default extensions (@bugsee/performance + @bugsee/opentelemetry) via the shared,
// runtime-agnostic wireUmbrella. The wiring lives in the umbrella (not @bugsee/browser) so a browser-only
// build never pulls the extensions in. Returns the same public client; its stop() tears the extensions down.

export interface BugseeLaunchOptionsWithPerformance
  extends BugseeLaunchOptions,
    UmbrellaExtensionOptions {}

export function launch(appToken: string, options: BugseeLaunchOptionsWithPerformance = {}): Bugsee {
  const { client, internals } = launchCore(appToken, options);
  // No internals → a prior launch already owns the process singleton (and already wired the extensions).
  return internals === undefined ? client : wireUmbrella(client, internals, options);
}
