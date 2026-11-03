// A REAL Vue 3 app with `installBugseeErrorHandler`: an async `onMounted` hook awaits `play()` on an undecodable source. Vue attaches its own
// `.catch` to the hook's promise (so no `unhandledrejection`) and calls `app.config.errorHandler` with the SAME reason; the adapter reports
// it, and the call site recorded when `play()` was called must be in the report. Run by `test/async-origin.adapters.browser.e2e.ts`.
import { launch } from '@bugsee/browser';
import { installBugseeErrorHandler } from '@bugsee/vue';
import { createApp, onMounted } from 'vue';

interface E2EWindow extends Window {
  __E2E__: { state: 'running' | 'done' | 'failed'; error?: string; sdkErrors: string[] };
  __E2E_COLLECTOR__?: string;
}
const w = window as unknown as E2EWindow;
const bridge: E2EWindow['__E2E__'] = { state: 'running', sdkErrors: [] };
w.__E2E__ = bridge;

function playFromVueMounted(video: HTMLVideoElement): Promise<void> {
  return video.play();
}

async function main(): Promise<void> {
  const endpoint = w.__E2E_COLLECTOR__;
  if (endpoint === undefined || endpoint === '') {
    throw new Error('__E2E_COLLECTOR__ is not set');
  }
  await launch('e2e-app-token', {
    endpoint,
    appVersion: '1.0.0',
    appBuild: '1',
    persist: false,
    recover: false,
    onError: (e: unknown) => bridge.sdkErrors.push(String(e)),
  });
  const app = createApp({
    name: 'VideoPlayer',
    setup() {
      onMounted(async () => {
        const video = document.createElement('video');
        video.src = '/broken.mp4';
        await playFromVueMounted(video);
      });
      return () => null;
    },
  });
  installBugseeErrorHandler(app);
  const host = document.createElement('div');
  document.body.appendChild(host);
  app.mount(host);
  await new Promise((resolve) => setTimeout(resolve, 800));
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
