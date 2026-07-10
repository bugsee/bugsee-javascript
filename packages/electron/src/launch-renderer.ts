// launchRenderer — the Electron renderer entry. Runs @bugsee/browser's full capture pipeline, but swaps its
// CaptureStore for the streaming renderer store so every entry flows UP to the main process instead of
// buffering + uploading locally (the main process owns the session/bundle). Call it from renderer code:
//
//   import { launchRenderer } from '@bugsee/electron/renderer';
//   launchRenderer(appToken, { replay: true });   // replay rides the same stream (D8 default video)
import { type Bugsee, type BugseeLaunchOptions, launchCore } from '@bugsee/browser';
import { createElectronRendererCaptureStore } from './renderer-capture-store';

/** The browser `launchCore` shape, injectable for tests. */
type BrowserLaunch = typeof launchCore;

export interface LaunchRendererOptions extends BugseeLaunchOptions {
  /** The sink to the main process. Default: the preload-exposed `__bugseeElectron.post`. */
  post?: (raw: string) => void;
  /** Test seam: the browser launch fn (default @bugsee/browser `launchCore`). */
  launch?: BrowserLaunch;
}

/** Resolve the default renderer→main sink: the preload-exposed `__bugseeElectron.post`, re-resolved per post
 *  (the preload may attach after this script runs). A no-op until the bridge is present (E2 adds buffering). */
export function resolveRendererPost(): (raw: string) => void {
  return (raw: string): void => {
    const bridge = (
      globalThis as unknown as { __bugseeElectron?: { post?: (raw: string) => void } }
    ).__bugseeElectron;
    bridge?.post?.(raw);
  };
}

/** Launch Bugsee in an Electron renderer: capture streams to the main process; main bundles + uploads. */
export function launchRenderer(appToken: string, options: LaunchRendererOptions = {}): Bugsee {
  const { post, launch, ...browserOptions } = options;
  const captureStore = createElectronRendererCaptureStore({ post: post ?? resolveRendererPost() });
  return (launch ?? launchCore)(appToken, { ...browserOptions, captureStore }).client;
}
