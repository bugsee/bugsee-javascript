// launchRenderer — the Electron renderer entry. Runs @bugsee/browser's full capture pipeline, but swaps its
// CaptureStore for the streaming renderer store so every entry flows UP to the main process instead of
// buffering + uploading locally (the main process owns the session/bundle). It also completes the E6
// handshake — sends `hello` up (prompting the owner's `session` reply) and subscribes to main→renderer
// control (pause/resume drop/restore the UP stream while backgrounded; flush/stop forward to the client).
// Call it from renderer code:
//
//   import { launchRenderer } from '@bugsee/electron/renderer';
//   launchRenderer(appToken, { replay: true });   // replay rides the same stream (D8 default video)
import { type Bugsee, type BugseeLaunchOptions, launchCore } from '@bugsee/browser';
import type { BugseeElectronBridge } from './preload-bridge';
import { createElectronRendererCaptureStore } from './renderer-capture-store';
import { createRendererControlHandler } from './renderer-control';
import { encodeHello } from './protocol';

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

/** Launch Bugsee in an Electron renderer: capture streams to the main process; main bundles + uploads. */
export function launchRenderer(appToken: string, options: LaunchRendererOptions = {}): Bugsee {
  const { post, bridge, onSessionId, launch, ...browserOptions } = options;
  const resolved = bridge ?? resolveRendererBridge();

  // Mutable pause flag flipped by main→renderer control (backgrounding). While paused the streaming store
  // drops entries — the UP stream stops — but incidents still report via the separate report path.
  let paused = false;
  const captureStore = createElectronRendererCaptureStore({
    post: post ?? ((raw: string): void => resolved.post(raw)),
    paused: () => paused,
  });
  const client = (launch ?? launchCore)(appToken, { ...browserOptions, captureStore }).client;

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
      onSession: onSessionId,
    }),
  );
  resolved.sendHello(encodeHello());

  return client;
}
