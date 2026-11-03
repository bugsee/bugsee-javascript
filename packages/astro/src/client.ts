// @bugsee/astro — client (browser) composition. Island-framework-AGNOSTIC: this only launches the browser
// SDK (DOM/console/network capture + web-vitals); for component-level errors the user adds the matching
// island adapter (`@bugsee/react`/`vue`/`svelte`/`solid`/`preact`) themselves (mirrors how Astro users add
// a UI renderer). The Integration injects `injectScript('page', "import { registerClient } … registerClient(…)")`.
//
// Browser-only → behind the `@bugsee/astro/client` subpath, never the portable `.`/`./middleware` entries.
import {
  type Bugsee,
  type BugseeLaunchOptionsWithPerformance,
  launch,
  relaunch as umbrellaRelaunch,
} from '@bugsee/bugsee';
import { flushQueuedAstroHydrationErrors, listenForAstroHydrationErrors } from './hydration';

/** Options for the Astro client (browser) composition — the batteries-included browser umbrella options. */
export interface AstroClientOptions extends BugseeLaunchOptionsWithPerformance {}

type HydrationInput =
  | {
      onError?: (error: unknown) => void;
      carrier?: object;
      document?: Document;
      window?: unknown;
    }
  | undefined;

// The page document the launch itself uses: an explicit `document`, else the bound window's. Undefined when neither yields one, which
// keeps the listener's default (`globalThis.document`). A hostile `window.document` getter (a sandboxed frame) counts as none.
function launchDocument(document: Document | undefined, win: unknown): Document | undefined {
  if (document !== undefined) {
    return document;
  }
  try {
    return (win as { document?: Document } | undefined)?.document;
  } catch {
    return undefined;
  }
}

// What the last registration handed in. `document` and `window` stay RAW: which one the launch uses is decided by precedence, so a
// relaunch that adds only a window must not displace a kept explicit document.
let last: {
  document?: Document;
  window?: unknown;
  onError?: (e: unknown) => void;
  carrier?: object;
} = {};

/**
 * Open the hydration listener's launch window, run `start`, and close the window in a `finally`: an error dispatched while the client is
 * (re)starting is queued, and the flush runs whether the start succeeded or failed.
 *
 * Mirrors core's `relaunchWith`, which keeps `document`, `window`, `carrier` and `onError` from the previous launch and lets an explicit
 * one win: a plain `relaunch()` must watch the same document, on the same carrier, with the same sink.
 */
async function withHydrationWindow<T>(
  options: HydrationInput,
  start: () => Promise<T>,
): Promise<T> {
  const next = { ...last };
  if (options?.document !== undefined) next.document = options.document;
  if (options?.window !== undefined) next.window = options.window;
  if (options?.onError !== undefined) next.onError = options.onError;
  if (options?.carrier !== undefined) next.carrier = options.carrier;
  last = next;
  const target = launchDocument(next.document, next.window);
  const hydration = {
    ...(next.onError !== undefined ? { onError: next.onError } : {}),
    ...(next.carrier !== undefined ? { carrier: next.carrier } : {}),
    ...(target !== undefined ? { target } : {}),
  };
  // Astro swallows an island's hydration failure into an `astro:hydration-error` event; nothing else would see it. Listen BEFORE the
  // launch resolves (an error dispatched meanwhile is queued) and flush once the client exists.
  listenForAstroHydrationErrors(hydration);
  try {
    return await start();
  } finally {
    flushQueuedAstroHydrationErrors(hydration); // success: report what queued; failure: end the window, nothing to report to
  }
}

/**
 * Start Bugsee for the Astro client (browser). Returns the started client (a per-isolate singleton — a
 * repeat call returns the existing client).
 */
export async function registerClient(
  appToken: string,
  options: AstroClientOptions = {},
): Promise<Bugsee> {
  return await withHydrationWindow(options, () => launch(appToken, options));
}

/**
 * `relaunch` from the umbrella, inside the same window: it `stop()`s the running client (clearing the carrier slot) and waits out the
 * drain before the new one is set, and an island that fails to hydrate meanwhile must not be lost.
 */
export async function relaunch(options?: Parameters<typeof umbrellaRelaunch>[0]): Promise<Bugsee> {
  return await withHydrationWindow(options, () => umbrellaRelaunch(options));
}

// API parity with the umbrella entries: the same VALUE surface, thin re-exports of the same functions.
export {
  addReportAttachment,
  BugseeStatus,
  getDefaultNetworkSanitizer,
  getStatus,
  LifecycleEvents,
  type LifecycleEventsListener,
  type LifecycleEventType,
  type ReportAttachmentInput,
} from '@bugsee/bugsee';
