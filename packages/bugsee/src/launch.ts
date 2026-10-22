import {
  type Bugsee as BrowserBugsee,
  type BugseeLaunchOptions,
  createBrowserInteractionSource,
  launchCore,
  navigationSourceFor,
  readMetaTraceContinuation,
} from '@bugsee/browser';
import { BlackoutToken, relaunchWith } from '@bugsee/core';
import type { PerformanceFacade } from '@bugsee/performance';
import { withPerformanceFacade } from './performance-facade';
import { type UmbrellaExtensionOptions, wireUmbrella } from './wire';

type LocationLike = { pathname?: string; href?: string };

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
  // The window the SDK is bound to (the launch's own `window` option, else the host's).
  const boundWindow = options.window ?? (globalThis as { window?: object }).window;
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
          // ONE navigation source per window, shared (through the carrier) with the `url` trace, so `history` is patched once.
          createNavigationSource: () =>
            navigationSourceFor(boundWindow, {
              ...(options.carrier !== undefined ? { carrier: options.carrier } : {}),
              ...(options.onError !== undefined ? { onError: options.onError } : {}),
            }),
          createInteractionSource: () =>
            createBrowserInteractionSource({ blackout: client.getService(BlackoutToken) }),
          readMetaTraceContinuation,
          // The pageload name comes from the window the SDK is bound to, like the navigation source above.
          readLocation: () =>
            (boundWindow as { location?: LocationLike } | undefined)?.location ??
            (globalThis as { location?: LocationLike }).location,
        },
      );
}

/** Stop the running client (if any) and launch again with the same token, re-wiring the on-by-default
 *  extensions; `options` replace the previous launch options when given. */
export function relaunch(options?: BugseeLaunchOptionsWithPerformance): Promise<Bugsee> {
  return relaunchWith(launch, options, options?.carrier);
}
