// launchRenderer — the Electron renderer entry. Runs @bugsee/browser's full capture pipeline, but swaps its
// CaptureStore for the streaming renderer store so every entry flows UP to the main process instead of
// buffering + uploading locally (the main process owns the session/bundle). It also completes the E6
// handshake — sends `hello` up (prompting the owner's `session` reply) and subscribes to main→renderer
// control (pause/resume drop/restore the UP stream while backgrounded; flush/stop forward to the client).
// Call it from renderer code:
//
//   import { launchRenderer } from '@bugsee/electron/renderer';
//   await launchRenderer(appToken, {});           // replay is ON by default and rides the same stream (D8);
//                                                // pass `replay: false` to opt out
import { type Bugsee, type BugseeLaunchOptions, launchCore } from '@bugsee/browser';
import {
  asInternalClient,
  BlackoutToken,
  getCarrierBlackout,
  LifecycleEvents,
  resolveFailOnBoolean,
} from '@bugsee/core';
import type { BugseeElectronBridge } from './preload-bridge';
import { encodeHello } from './protocol';
import { createElectronRendererCaptureStore } from './renderer-capture-store';
import { createRendererControlHandler } from './renderer-control';
import { createElectronRendererReportPipeline } from './renderer-report-pipeline';

/** The browser `launchCore` shape, injectable for tests. */
type BrowserLaunch = typeof launchCore;

export interface LaunchRendererOptions extends BugseeLaunchOptions {
  /** The capture sink to the main process. Default: the preload-exposed `__bugseeElectron.post`. */
  post?: (raw: string) => void;
  /** The renderer↔main bridge. Default: the preload-exposed `__bugseeElectron` (lazily resolved). */
  bridge?: BugseeElectronBridge;
  /** Called with the owner's session id once the handshake completes (E6). */
  onSessionId?: (sessionId: string) => void;
  /** Test seam: the browser launch fn (default @bugsee/browser `launchCore`). */
  launch?: BrowserLaunch;
}

type MaybeBridge = Partial<BugseeElectronBridge> | undefined;

function readBridge(): MaybeBridge {
  return (globalThis as unknown as { __bugseeElectron?: MaybeBridge }).__bugseeElectron;
}

/** Resolve the default renderer→main sink: the preload-exposed `__bugseeElectron.post`, re-resolved per post
 *  (the preload may attach after this script runs). A no-op until the bridge is present. */
export function resolveRendererPost(): (raw: string) => void {
  return (raw: string): void => {
    readBridge()?.post?.(raw);
  };
}

/** Resolve the default renderer↔main bridge — each method re-resolves `__bugseeElectron` per call (late-attach
 *  safe) and is a no-op until the bridge is present, so launch never throws if the preload isn't ready. */
export function resolveRendererBridge(): BugseeElectronBridge {
  return {
    post(raw: string): void {
      readBridge()?.post?.(raw);
    },
    sendHello(raw: string): void {
      readBridge()?.sendHello?.(raw);
    },
    onControl(handler: (raw: string) => void): void {
      readBridge()?.onControl?.(handler);
    },
  };
}

// One renderer instance per page (R3V-6). A page can run this entry twice (hot module reload, a second bundle):
// two instances would register two competing three-flag blackout handlers over ONE shared blackout state and
// two control subscriptions. The slot is on `globalThis` (a reloaded module has fresh module variables) and holds
// the in-flight/finished launch plus, once known, its client so a client main has STOPPED is not handed back.
const RENDERER_SLOT = Symbol.for('bugsee.electron.renderer');
interface RendererSlot {
  readonly launch: Promise<Bugsee>;
  client?: Bugsee;
}

/**
 * Launch Bugsee in an Electron renderer: capture streams to the main process; main bundles + uploads.
 *
 * Calling it again while this page's client is live (or still launching) is a NO-OP that returns that client; the
 * repeat call's options are ignored. After main has stopped the client a new call launches a fresh one.
 */
export function launchRenderer(
  appToken: string,
  options: LaunchRendererOptions = {},
): Promise<Bugsee> {
  const page = globalThis as unknown as Record<symbol, RendererSlot | undefined>;
  const existing = page[RENDERER_SLOT];
  if (existing !== undefined && (existing.client === undefined || existing.client.isLaunched())) {
    return existing.launch;
  }
  const slot: RendererSlot = { launch: launchRendererOnce(appToken, options) };
  page[RENDERER_SLOT] = slot;
  slot.launch.then(
    (client) => {
      slot.client = client;
    },
    () => {
      // Only a launch that has not produced a client can fail, and such a slot is never replaced.
      delete page[RENDERER_SLOT];
    },
  );
  return slot.launch;
}

async function launchRendererOnce(
  appToken: string,
  options: LaunchRendererOptions,
): Promise<Bugsee> {
  const { post, bridge, onSessionId, launch, ...browserOptions } = options;
  const resolved = bridge ?? resolveRendererBridge();

  // Mutable pause flag flipped by main→renderer control (backgrounding). While paused the streaming store
  // drops entries — the UP stream stops — but incidents still report via the separate report path.
  let paused = false;
  // Flipped by the main→renderer `session` control reply: until then there is no converged session id.
  let handshaken = false;
  const captureStore = createElectronRendererCaptureStore({
    post: post ?? ((raw: string): void => resolved.post(raw)),
    paused: () => paused,
  });
  // Incidents are FORWARDED to main, never uploaded here: this renderer's capture lives in the main store,
  // so a locally-assembled bundle would be empty and land under a foreign session id
  // (docs/review/electron.md SEV1 #2). `handshaken` gates delivery — before the session handshake there is
  // no main session to attribute an incident to, so the pipeline reports failure rather than posting into
  // the void. A caller cannot override this: ours is spread AFTER the caller's options, so an override —
  // which would silently restore the broken local-upload path — is simply ignored. (An earlier version also
  // destructured the caller's value away; that was redundant, and a mutation proved it: removing the strip
  // changed nothing, because the ordering already decides.)
  const triggerPipeline = createElectronRendererReportPipeline({
    post: post ?? ((raw: string): void => resolved.post(raw)),
    canDeliver: () => handshaken,
    ...(options.onError !== undefined ? { onError: options.onError } : {}),
  });
  const carriedBlackout = getCarrierBlackout(browserOptions.carrier ?? globalThis);
  const { client } = await (launch ?? launchCore)(appToken, {
    ...browserOptions,
    captureStore,
    // AFTER the caller's options, deliberately — see above.
    triggerPipeline,
    // Born dark, released by the handshake. Main owns the blackout: until this renderer has heard the
    // session reply it cannot know whether main is blacked out, and everything captured in that window
    // (replay's opening snapshot, input) would already be in the session. Also after the caller's options:
    // a caller must not be able to switch the fail-closed start off. A SILENT hold (no lifecycle event):
    // it is bookkeeping, not a blackout the application asked for. The caller's own `startInBlackout`
    // passes through untouched in `browserOptions`.
    holdBlackout: true,
  } as never);

  // THREE separate reasons to be dark, and the renderer is dark while ANY is set:
  //   - `hold`     the launch hold, released ONLY by the session handshake;
  //   - `mainDark` main's blackout (blackout-start/end, and the handshake's `bo`);
  //   - `appDark`  this renderer's own app calling startBlackout()/endBlackout() (or startInBlackout).
  // One boolean could not tell them apart: a bo:false reply ended a blackout the app had just started, and
  // main's blackout-end ended the app's.
  let hold = true;
  let mainDark = false;
  // Same rule as the browser launch (R3V-2): the safe side is dark, so any value but boolean `false` is dark. A
  // blackout CARRIED over from a previous client (a re-run after main stopped this page's client) is the app's to
  // lift too: the new client starts in that state and the handshake must not end it (R3V-6).
  let appDark =
    resolveFailOnBoolean(
      (browserOptions as { startInBlackout?: unknown }).startInBlackout,
      false,
    ) || carriedBlackout;
  // What the application has been TOLD (BlackoutStarted/Ended): main's or the app's blackout, never the hold.
  let announced = appDark; // the browser launch announced a startInBlackout itself
  const blackoutState = client.getService(BlackoutToken);
  const apply = (): void => {
    // Every transition here is silent: this function alone decides which ones the application hears about.
    if (hold || mainDark || appDark) {
      blackoutState.start({ silent: true });
    } else {
      blackoutState.end({ silent: true });
    }
    const visible = mainDark || appDark;
    if (visible !== announced) {
      announced = visible;
      asInternalClient(client).emitLifecycleEvent(
        visible ? LifecycleEvents.BlackoutStarted : LifecycleEvents.BlackoutEnded,
      );
    }
  };
  // The application's own calls land on the app flag, not on the shared state.
  client.startBlackout = (): void => {
    if (client.isLaunched()) {
      appDark = true;
      apply();
    }
  };
  client.endBlackout = (): void => {
    if (client.isLaunched()) {
      appDark = false;
      apply();
    } else {
      // R2L-7: allowed while stopped, quietly, because it is the only way to lift a carried blackout (the next
      // launch would otherwise start dark with no event). Nothing is captured now, so the hold and the app's own
      // reason go (main's is re-derived from its own broadcasts, which set it before every apply()).
      hold = false;
      appDark = false;
      blackoutState.end({ silent: true });
    }
  };

  // Wire main→renderer control, then announce ourselves so the main assigns the session id.
  resolved.onControl(
    createRendererControlHandler({
      setPaused: (p: boolean): void => {
        paused = p;
      },
      stop: (): void => {
        void client.stop();
      },
      flush: (): void => {
        void client.flush();
      },
      onSession: (id: string): void => {
        handshaken = true;
        // The handshake, and only the handshake, releases the launch hold (the reply's blackout state was
        // applied just before this, so a dark owner keeps the renderer dark with no gap).
        hold = false;
        apply();
        onSessionId?.(id);
      },
      // The owner's blackout (broadcast, and carried by the session reply): applied through the same state
      // service `client.startBlackout()` drives, so every visual/interaction provider follows it.
      onBlackout: (active: boolean): void => {
        mainDark = active;
        apply();
      },
    }),
  );
  resolved.sendHello(encodeHello());

  return client;
}
