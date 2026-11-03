// `play()` on an element with NO source never settles (the browser waits for one), so both elements point at `/broken.mp4`: served as a
// video but not decodable, which is what BGSVIEWER-14's unsupported WebM looked like to the element.
// The page the async-origin e2e runs in a REAL browser (`test/async-origin.browser.e2e.ts`). Two stackless platform rejections, both
// from `HTMLMediaElement.play()` on an element with no source (BGSVIEWER-14's shape): one nobody handles (the `unhandledrejection`
// report) and one the app catches and hands to `logException`. Function names are the assertions: the report must name them.
import { launch } from '@bugsee/browser';

interface E2EWindow extends Window {
  __E2E__: {
    state: 'running' | 'done' | 'failed';
    error?: string;
    sdkErrors: string[];
    /** Whether `Promise` is still the engine's own when the scenario starts (false on a page that loaded a replacement first). */
    promiseIsNative?: boolean;
  };
  __E2E_COLLECTOR__?: string;
}
const w = window as unknown as E2EWindow;
const bridge: E2EWindow['__E2E__'] = {
  state: 'running',
  sdkErrors: [],
  // Compared with the marker a fixture page sets BEFORE loading its library (`toString` cannot tell: core-js disguises its Promise).
  promiseIsNative:
    (w as unknown as { __nativePromise?: unknown }).__nativePromise === undefined
      ? undefined
      : (w as unknown as { __nativePromise?: unknown }).__nativePromise === Promise,
};
w.__E2E__ = bridge;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function ignoredPlayFromHeroClick(): void {
  const video = document.createElement('video');
  video.id = 'hero';
  video.src = '/broken.mp4';
  document.body.appendChild(video);
  void video.play(); // never handled: unhandledrejection
}

async function caughtPlayFromPromoClick(client: {
  logException(e: unknown): Promise<unknown>;
}): Promise<void> {
  const video = document.createElement('video');
  video.id = 'promo';
  video.src = '/broken.mp4';
  document.body.appendChild(video);
  try {
    await video.play();
  } catch (error) {
    await client.logException(error);
  }
}

async function main(): Promise<void> {
  const endpoint = w.__E2E_COLLECTOR__;
  if (endpoint === undefined || endpoint === '') {
    throw new Error('__E2E_COLLECTOR__ is not set');
  }
  const client = await launch('e2e-app-token', {
    endpoint,
    appVersion: '1.0.0',
    appBuild: '1',
    persist: false,
    recover: false,
    onError: (e: unknown) => bridge.sdkErrors.push(String(e)),
  });
  await caughtPlayFromPromoClick(client);
  ignoredPlayFromHeroClick();
  await sleep(500); // let `unhandledrejection` fire and the report be built
  await client.flush();
}

main().then(
  () => {
    bridge.state = 'done';
  },
  (err: unknown) => {
    bridge.error = String(err);
    bridge.state = 'failed';
  },
);
