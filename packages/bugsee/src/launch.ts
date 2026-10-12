import {
  type Bugsee as BrowserBugsee,
  type BugseeLaunchOptions,
  createBrowserInteractionSource,
  createBrowserNavigationSource,
  launchCore,
  readMetaTraceContinuation,
} from '@bugsee/browser';
import { BlackoutToken } from '@bugsee/core';
import type { PerformanceFacade } from '@bugsee/performance';
import { withPerformanceFacade } from './performance-facade';
import { type UmbrellaExtensionOptions, wireUmbrella } from './wire';

/** The launched client in the browser: the platform client plus the top-level performance calls. */
export type Bugsee = BrowserBugsee & PerformanceFacade;

// The `bugsee` umbrella launch() for the BROWSER — the batteries-included entry. It runs the browser
// composition root (@bugsee/browser's launchCore, which returns the client PLUS its internal wiring) and
// then wires the on-by-default extensions (@bugsee/performance + @bugsee/opentelemetry) via the shared,
// runtime-agnostic wireUmbrella. The wiring lives in the umbrella (not @bugsee/browser) so a browser-only
// build never pulls the extensions in. Returns the same public client; its stop() tears the extensions down.

export interface BugseeLaunchOptionsWithPerformance
  extends BugseeLaunchOptions,
    UmbrellaExtensionOptions {}

export async function launch(
  appToken: string,
  options: BugseeLaunchOptionsWithPerformance = {},
): Promise<Bugsee> {
  const { client, internals } = await launchCore(appToken, options);
  // No internals → a prior launch already owns the process singleton (and already wired the extensions).
  // Browser: pageload transaction. The browser-only capture sources are injected here (as factories) so
  // the shared wireUmbrella — and therefore the node umbrella entry — never imports @bugsee/browser.
  return internals === undefined
    ? withPerformanceFacade(client)
    : wireUmbrella(
        client,
        internals,
        options,
        { pageload: true },
        {
          createNavigationSource: createBrowserNavigationSource,
          createInteractionSource: () =>
            createBrowserInteractionSource({ blackout: client.getService(BlackoutToken) }),
          readMetaTraceContinuation,
        },
      );
}
