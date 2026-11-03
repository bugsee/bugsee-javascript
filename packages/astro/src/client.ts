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
import { getCarrier, getCarrierClient, getCarrierPendingLaunch } from '@bugsee/core';
import {
  flushQueuedAstroHydrationErrors,
  listenForAstroHydrationErrors,
  stopListeningForAstroHydrationErrors,
} from './hydration';

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

// The launch still in flight. Every call waits for it first, as core's `relaunchWith` does: only then is it known whether a client is live
// (the carrier is set at the END of a launch) and what the last launch recorded.
let inFlight: Promise<unknown> = Promise.resolve();
// The document each carrier host's last launch listened on (core's state is per host), so a launch that moves to another document can stop
// listening on the old one, unless another host still uses it.
const activeTargets = new Map<object, EventTarget>();

function release(target: EventTarget): void {
  for (const used of activeTargets.values()) {
    if (used === target) {
      return; // another carrier's client is still on this document
    }
  }
  stopListeningForAstroHydrationErrors(target);
}

// What core recorded for the last SUCCESSFUL launch on `host` (`setCarrierLastLaunch`: the kept options, `undefined` ones dropped). This
// is the very state `relaunchWith` merges from, so Astro cannot disagree with core, whichever entry point made that launch. `document` and
// `window` stay RAW: which one the launch uses is decided by precedence, so a relaunch that adds only a window must not displace a kept
// explicit document.
function recordedBy(host: object): Remembered {
  return pick(getCarrier(host).lastLaunch?.options as HydrationInput, false);
}

// Which options a call contributes. A repeat's `document` and `window` were ignored by core (the client is on the recorded ones), so only its
// `onError` and `carrier` count, and only when defined: a stated `undefined` was discarded too.
const LAUNCH_KEYS = ['document', 'window', 'onError', 'carrier'] as const;
const REPEAT_KEYS = ['onError', 'carrier'] as const;

function pick(options: HydrationInput, repeat: boolean): Remembered {
  const picked: Remembered = {};
  for (const key of repeat ? REPEAT_KEYS : LAUNCH_KEYS) {
    if (
      options !== undefined &&
      Object.hasOwn(options, key) &&
      !(repeat && options[key] === undefined)
    ) {
      (picked as Record<string, unknown>)[key] = options[key];
    }
  }
  return picked;
}

type Plan = { base: Remembered; repeat: boolean };

/**
 * Open the hydration listener's launch window, run `start`, and close the window in a `finally`: an error dispatched while the client is
 * (re)starting is queued, and the flush runs whether the start succeeded or failed. Waits for the launch in flight first (Astro's own, and
 * the one core still has pending on the carrier, as `relaunchWith` does), then asks `plan`:
 *
 * - a relaunch builds on what core recorded (core's `relaunchWith` keeps `document`, `window`, `carrier` and `onError`; an explicit key
 *   wins, even an explicit `undefined`);
 * - a fresh launch builds on nothing (core's plain launch carries nothing over);
 * - a REPEAT (a client is live, so core ignores the call and returns it) builds on what core recorded and takes only its DEFINED
 *   `onError` and `carrier`: core ignored its document and window, and discarded a stated `undefined`. Core records nothing for it.
 *
 * A start that moved the host to another document stops listening on the old one; one that failed releases the new one.
 */
function withHydrationWindow(
  options: HydrationInput,
  hostOf: () => object,
  plan: (host: object) => Plan,
  start: () => Promise<Bugsee>,
): Promise<Bugsee> {
  const previous = inFlight;
  const run = (async () => {
    await previous.then(undefined, () => undefined);
    const host = hostOf();
    await getCarrierPendingLaunch(host)?.then(undefined, () => undefined);
    return await openWindow(options, host, plan(host), start);
  })();
  inFlight = run;
  return run;
}

async function openWindow(
  options: HydrationInput,
  host: object,
  { base, repeat }: Plan,
  start: () => Promise<Bugsee>,
): Promise<Bugsee> {
  const next = { ...base, ...pick(options, repeat) };
  const target = launchDocument(next.document, next.window);
  // Where the listener really attaches: an unset target means the page document (`hydration.ts`).
  const tracked = target ?? (globalThis as { document?: EventTarget }).document;
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
    if (tracked !== undefined) {
      // The document this host's client is now on: for a repeat, the one core recorded (a client Astro did not launch, or one the umbrella
      // moved), for a launch, the one it just started on.
      const left = activeTargets.get(host);
      activeTargets.set(host, tracked);
      if (left !== undefined) {
        release(left); // the page may have moved to another document (a no-op while any host is still on `left`)
      }
    }
    return client;
  } catch (error) {
    if (!repeat && tracked !== undefined) {
      release(tracked); // opened for a launch that never happened (a no-op when some host is on it)
    }
    throw error;
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
    () => options.carrier ?? globalThis, // the carrier the launch would look at
    (host) =>
      // a client already live there: core ignores this call
      getCarrierClient(host) !== undefined
        ? { base: recordedBy(host), repeat: true }
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
    // the host core's `relaunchWith` picks: the carrier option, else the one the last launch left, else the global
    () => options?.carrier ?? getCarrier().lastHost ?? globalThis,
    (host) => ({ base: recordedBy(host), repeat: false }),
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
