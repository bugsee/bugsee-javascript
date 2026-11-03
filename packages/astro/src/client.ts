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
import { getCarrierClient } from '@bugsee/core';
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

type Remembered = {
  document?: Document;
  window?: unknown;
  onError?: (e: unknown) => void;
  carrier?: object;
};

// What the last SUCCESSFUL launch handed in, like core's `lastLaunch`. `document` and `window` stay RAW: which one the launch uses is
// decided by precedence, so a relaunch that adds only a window must not displace a kept explicit document.
let remembered: Remembered = {};
// The launch still in flight. Every call waits for it first, as core's `relaunchWith` does: only then is it known whether a client is live
// (the carrier is set at the END of a launch) and what the last launch remembered.
let inFlight: Promise<unknown> = Promise.resolve();
// Known limit (accepted): the hydration listener of a document the page has moved away from stays attached (as before this tracking).

function pick(options: HydrationInput, definedOnly: boolean): Remembered {
  const picked: Remembered = {};
  for (const key of ['document', 'window', 'onError', 'carrier'] as const) {
    if (
      options !== undefined &&
      Object.hasOwn(options, key) &&
      !(definedOnly && options[key] === undefined)
    ) {
      (picked as Record<string, unknown>)[key] = options[key];
    }
  }
  return picked;
}

type Plan = { base: Remembered; repeat: boolean };

/**
 * Open the hydration listener's launch window, run `start`, and close the window in a `finally`: an error dispatched while the client is
 * (re)starting is queued, and the flush runs whether the start succeeded or failed. Waits for the launch in flight first, then asks `plan`:
 *
 * - a relaunch builds on the remembered options (core's `relaunchWith` keeps `document`, `window`, `carrier` and `onError`; an explicit key
 *   wins, even an explicit `undefined`);
 * - a fresh launch builds on nothing (core's plain launch carries nothing over);
 * - a REPEAT (a client is live, so core ignores the call and returns it) builds on the remembered options and takes only the DEFINED keys
 *   it was given: its stated `undefined` was discarded by core, and the listener must not lose what it has. Nothing is remembered from it.
 *
 * The remembered state moves only once a non-repeat start succeeded.
 */
function withHydrationWindow(
  options: HydrationInput,
  plan: () => Plan,
  start: () => Promise<Bugsee>,
): Promise<Bugsee> {
  const previous = inFlight;
  const run = (async () => {
    await previous.then(undefined, () => undefined);
    return await openWindow(options, plan(), start);
  })();
  inFlight = run;
  return run;
}

async function openWindow(
  options: HydrationInput,
  { base, repeat }: Plan,
  start: () => Promise<Bugsee>,
): Promise<Bugsee> {
  const next = { ...base, ...pick(options, repeat) };
  const target = launchDocument(next.document, next.window);
  // A launch states `onError` and `carrier` ALWAYS: the listener merges what it is given over what it kept, so an absent key would bring
  // back a carrier or sink that this launch no longer has. A repeat states only what it has.
  const hydration = {
    ...(repeat
      ? {
          ...(next.onError !== undefined ? { onError: next.onError } : {}),
          ...(next.carrier !== undefined ? { carrier: next.carrier } : {}),
        }
      : { onError: next.onError, carrier: next.carrier }),
    ...(target !== undefined ? { target } : {}),
  };
  // Astro swallows an island's hydration failure into an `astro:hydration-error` event; nothing else would see it. Listen BEFORE the
  // launch resolves (an error dispatched meanwhile is queued) and flush once the client exists.
  listenForAstroHydrationErrors(hydration);
  try {
    const client = await start();
    if (!repeat) {
      remembered = next;
    }
    return client;
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
  return await withHydrationWindow(
    options,
    // a client already live on the carrier the launch would look at: core ignores this call
    () =>
      getCarrierClient(options.carrier ?? globalThis) !== undefined
        ? { base: remembered, repeat: true }
        : { base: {}, repeat: false },
    () => launch(appToken, options),
  );
}

/**
 * `relaunch` from the umbrella, inside the same window: it `stop()`s the running client (clearing the carrier slot) and waits out the
 * drain before the new one is set, and an island that fails to hydrate meanwhile must not be lost.
 */
export async function relaunch(options?: Parameters<typeof umbrellaRelaunch>[0]): Promise<Bugsee> {
  return await withHydrationWindow(
    options,
    () => ({ base: remembered, repeat: false }),
    () => umbrellaRelaunch(options),
  );
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
