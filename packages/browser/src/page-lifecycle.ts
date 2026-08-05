import { guarded } from '@bugsee/core';
import type { WindowEvents } from './detection-providers';

// WAVE 6.2 — the last reliable moment to write, in a browser that never promises another one.
//
// Node gets `'exit'` and a signal; a web page gets neither. A mobile browser kills a backgrounded tab with
// NO further callbacks, and `unload`/`beforeunload` are not delivered there at all (listening to them also
// disqualifies the page from the bfcache). The Page Lifecycle API leaves exactly two signals that are
// actually delivered, and they cover different paths:
//
//   · `visibilitychange` → `hidden` — the last callback before a backgrounded tab may be discarded.
//   · `pagehide`                    — the navigation away, which `visibilitychange` does not always precede.
//
// So both are needed. They also OVERLAP on the common mobile sequence (hidden, then pagehide), which is
// why the hide is coalesced — and why the coalescing re-arms on the way back, since a page restored from
// the bfcache can be hidden and killed again any number of times.

/** The document surface this needs: `visibilitychange` plus the state to read when it fires. */
export interface VisibilityDocument extends WindowEvents {
  readonly visibilityState: DocumentVisibilityState;
}

export interface PageHideFlushEnv {
  /** The window to take `pagehide` from. Default the real global; absent (a worker) → skipped. */
  window?: WindowEvents;
  /** The document to take `visibilitychange` from. Default the real global; absent → skipped. */
  document?: VisibilityDocument;
  /** Failure sink. The flush runs in the browser's own dispatch, so it must never throw out of it. */
  onError?: (error: unknown) => void;
}

const globalWindow = (): WindowEvents | undefined =>
  (globalThis as { window?: WindowEvents }).window;
const globalDocument = (): VisibilityDocument | undefined =>
  (globalThis as { document?: VisibilityDocument }).document;

/**
 * Call `onHide` at the last moment the page is reliably alive; returns an uninstall function.
 *
 * Fires at most once per hide, and again after the page becomes visible again.
 */
export function installPageHideFlush(onHide: () => void, env: PageHideFlushEnv = {}): () => void {
  const win = 'window' in env ? env.window : globalWindow();
  const doc = 'document' in env ? env.document : globalDocument();
  // Contained here rather than at the call site: BOTH listeners run inside the browser's own event
  // dispatch, at the moment the page is going away, and a throw there is the one failure nobody sees.
  const flush = guarded(onHide, env.onError);

  let hidden = false;
  const hide = (): void => {
    if (!hidden) {
      hidden = true;
      flush();
    }
  };

  const onPageHide = (): void => hide();
  const onVisibilityChange = (): void => {
    if (doc?.visibilityState === 'hidden') {
      hide();
    } else {
      hidden = false; // back in the foreground — re-arm for the next hide (bfcache restore)
    }
  };

  win?.addEventListener('pagehide', onPageHide);
  doc?.addEventListener('visibilitychange', onVisibilityChange);

  return () => {
    win?.removeEventListener('pagehide', onPageHide);
    doc?.removeEventListener('visibilitychange', onVisibilityChange);
  };
}
