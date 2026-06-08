import type { PerformanceEntryLike, PerformanceObserverLike, WebVitalsEnv } from './env';

// The web-vitals observation machinery (reimplemented from Google's `web-vitals` lib/observe + lifecycle
// helpers — design reference only). `observe` wraps a PerformanceObserver with feature-detection,
// try/catch, buffered:true, and a microtask defer (Safari fires observer callbacks synchronously). The
// lifecycle helpers drive metric finalization: onHidden (visibility→hidden / pagehide — NEVER unload,
// which breaks bfcache) and onBFCacheRestore (pageshow.persisted, where each metric must reset + re-emit).

export interface ObserveOptions {
  /** Min event duration to observe (INP uses 40ms). */
  durationThreshold?: number;
}

/**
 * Observe a PerformanceObserver entry type, or return undefined if unsupported. The callback receives the
 * new entries + the observer (so the caller can takeRecords()/disconnect() on finalize), deferred a
 * microtask to work around Safari delivering the callback synchronously.
 */
export function observe(
  env: WebVitalsEnv,
  type: string,
  callback: (entries: PerformanceEntryLike[], observer: PerformanceObserverLike) => void,
  opts: ObserveOptions = {},
): PerformanceObserverLike | undefined {
  const Ctor = env.PerformanceObserver;
  if (Ctor?.supportedEntryTypes === undefined || !Ctor.supportedEntryTypes.includes(type)) {
    return undefined;
  }
  try {
    const observer = new Ctor((list) => {
      const defer = env.queueMicrotask ?? ((cb: () => void) => cb());
      defer(() => callback(list.getEntries(), observer));
    });
    observer.observe({ type, buffered: true, ...opts });
    return observer;
  } catch {
    return undefined; // an unsupported type / disallowed observe → no-op
  }
}

/** Invoke `callback` each time the page becomes hidden (visibility→hidden or pagehide). */
export function onHidden(env: WebVitalsEnv, callback: () => void): void {
  env.document?.addEventListener(
    'visibilitychange',
    () => {
      if (env.document?.visibilityState === 'hidden') callback();
    },
    { capture: true },
  );
  env.window?.addEventListener('pagehide', () => callback(), { capture: true });
}

/** Invoke `callback(restoreTimeStamp)` when the page is restored from the back/forward cache. */
export function onBFCacheRestore(
  env: WebVitalsEnv,
  callback: (restoreTimeStamp: number) => void,
): void {
  env.window?.addEventListener(
    'pageshow',
    (event) => {
      if (event.persisted === true) callback(event.timeStamp ?? 0);
    },
    { capture: true },
  );
}
