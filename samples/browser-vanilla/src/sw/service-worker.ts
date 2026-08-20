// Service Worker: caches the app shell (real caching, not a scenario prop) AND runs a Bugsee worker
// session with `withBugseeEvent` wrapping the fetch/message/sync handlers so an incident's upload
// completes before the (idle-terminated) worker is killed (event.waitUntil), with the durable IDB
// bundle queue (`persist`, default ON for 'service-worker') recovering anything left behind by a kill
// between capture and upload.
import { launch, withBugseeEvent } from '@bugsee/webworker';

// Workers run in their own global scope; cast rather than pull in the WebWorker lib (which conflicts
// with the app's DOM lib in one shared tsconfig — see tsconfig.json).
const sw = self as unknown as ServiceWorkerGlobalScope;

const CACHE_NAME = 'widget-shop-shell-v1';
const SHELL_ASSETS = ['/'];

const token = import.meta.env.BUGSEE_APP_TOKEN;
// See server/bugsee-proxy.ts + FINDINGS.md F-2 (blocker): apidev.bugsee.com's CORS config rejects
// every third-party origin, so every session in this sample — including the Service Worker's own —
// goes through the same-origin reverse proxy instead of the raw BUGSEE_ENDPOINT.
const endpoint = `${sw.location.origin}/bugsee-proxy`;

const client =
  token !== undefined && token.length > 0
    ? launch(token, {
        endpoint,
        // See FINDINGS.md F-3: the packed SDK version (0.0.0) is below the backend's accepted floor.
        sdkVersion: '1.0.0',
        appVersion: '1.0.0',
        appBuild: '7',
        onError: (error) => {
          // eslint-disable-next-line no-console
          console.warn('[service-worker bugsee onError]', error);
        },
      })
    : undefined;

client?.setAttribute('sample', 'browser-vanilla:service-worker');

sw.addEventListener('install', (event: ExtendableEvent) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => sw.skipWaiting()),
  );
});

sw.addEventListener('activate', (event: ExtendableEvent) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => sw.clients.claim()),
  );
});

// The fetch handler: cache-first for the app shell, network passthrough for everything else
// (API/HMR/module requests) — genuinely caches, and is wrapped so a handler throw is captured +
// flushed before the SW might be killed.
const handleFetch = withBugseeEvent(
  client ?? ({} as ReturnType<typeof launch>),
  (event: FetchEvent) => {
    const url = new URL(event.request.url);
    // Scenario-panel trigger: a special path throws synchronously inside the wrapped handler.
    if (url.pathname === '/__sw-throw__') {
      throw new Error('service-worker: deliberate throw inside fetch handler (scenario panel)');
    }
    if (url.pathname !== '/' || event.request.method !== 'GET') {
      return; // let the browser handle it natively (network)
    }
    event.respondWith(
      caches.match(event.request).then((cached) => cached ?? fetch(event.request)),
    );
  },
  (error) => console.warn('[service-worker] onError', error),
);

sw.addEventListener('fetch', (event: FetchEvent) => {
  try {
    handleFetch(event);
  } catch {
    // withBugseeEvent rethrows after capturing — swallow here so an uninstrumented path is never
    // broken by the scenario-panel trigger; the throw above already reached Bugsee.
  }
});

// Background sync — real registration is exercised from the app (registration.sync.register), wrapped
// the same way so a sync-handler failure is captured + flushed before the worker dies.
sw.addEventListener(
  'sync' as 'message',
  withBugseeEvent(client ?? ({} as ReturnType<typeof launch>), (event: SyncEvent) => {
    console.log(`[service-worker] background sync fired: ${event.tag}`);
  }) as EventListener,
);

export {};
