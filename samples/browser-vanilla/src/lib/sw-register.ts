// Registers the Service Worker (src/sw/service-worker.ts) that caches the app shell and runs its own
// Bugsee worker session. Also exposes scenario-panel triggers: a fetch to /__sw-throw__ (routed through
// the SW's wrapped fetch handler) and a background-sync registration attempt.

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | undefined> {
  if (!('serviceWorker' in navigator)) return undefined;
  // A Service Worker registration is a literal URL string the browser fetches directly — it isn't a
  // bundler-resolved specifier, so it needs a path that actually exists at runtime in BOTH modes.
  // Dev: Vite serves the source module straight from disk under /src/sw/. Build: vite.config.ts builds
  // it as its own unhashed top-level entry (dist/service-worker.js) for exactly this reason — a hashed
  // asset URL wouldn't be knowable ahead of time for something referenced by a plain string.
  //
  // Either way the script's own directory (/src/sw/ in dev) would otherwise cap the registrable scope
  // at that directory — server/api-plugin.ts's `Service-Worker-Allowed: /` response header (dev only;
  // harmless no-op once the prod path is already top-level) is what makes `scope: '/'` acceptable.
  const url = import.meta.env.DEV ? '/src/sw/service-worker.ts' : '/service-worker.js';
  return navigator.serviceWorker.register(url, { type: 'module', scope: '/' });
}

export async function triggerServiceWorkerThrow(): Promise<Response | undefined> {
  try {
    return await fetch('/__sw-throw__');
  } catch {
    return undefined;
  }
}

export async function triggerBackgroundSync(): Promise<'registered' | 'unsupported' | 'failed'> {
  const registration = await navigator.serviceWorker.ready;
  const syncCapable = registration as ServiceWorkerRegistration & {
    sync?: { register(tag: string): Promise<void> };
  };
  if (syncCapable.sync === undefined) return 'unsupported';
  try {
    await syncCapable.sync.register('widget-shop-sync');
    return 'registered';
  } catch {
    return 'failed';
  }
}
