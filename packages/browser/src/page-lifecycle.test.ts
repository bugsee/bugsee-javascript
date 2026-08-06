import { describe, expect, it, vi } from 'vitest';
import { installPageHideFlush } from './page-lifecycle';

// WAVE 6.2 — the browser had NO page-lifecycle flush at all.
//
// `pagehide` was already listened to, but only to RECORD a `process_exiting` system event; nothing in the
// SDK consumed it, and nothing flushed. (The comment in launch.ts claiming "the browser flushes via the
// pipeline / pagehide" described an intention, not the code.) On mobile a backgrounded tab is killed with
// no further callbacks, so whatever was still queued went with it.
//
// The Page Lifecycle contract this encodes:
//   · `visibilitychange` → hidden is the LAST callback a mobile browser reliably delivers. `unload` and
//     `beforeunload` are not delivered at all on mobile, and listening to them disables the bfcache.
//   · `pagehide` fires on the actual navigation away, which `visibilitychange` does not always precede.
// Both are needed: neither alone covers both the "backgrounded then killed" and "navigated away" paths.

/** A DOM event target that records its listeners so a test can dispatch the way the browser does. */
function fakeTarget(
  state: { visibilityState: DocumentVisibilityState } = { visibilityState: 'visible' },
) {
  const listeners = new Map<string, Array<(event: Event) => void>>();
  const target = {
    addEventListener(type: string, listener: (event: Event) => void) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    removeEventListener(type: string, listener: (event: Event) => void) {
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter((l) => l !== listener),
      );
    },
    get visibilityState() {
      return state.visibilityState;
    },
  };
  return {
    target,
    state,
    fire: (type: string) => {
      for (const l of [...(listeners.get(type) ?? [])]) l({} as Event);
    },
    count: (type: string) => (listeners.get(type) ?? []).length,
  };
}

describe('installPageHideFlush', () => {
  it('flushes on pagehide', () => {
    const onHide = vi.fn();
    const win = fakeTarget();
    installPageHideFlush(onHide, { window: win.target });
    win.fire('pagehide');
    expect(onHide).toHaveBeenCalledTimes(1);
  });

  it('flushes when the page becomes HIDDEN — the only callback a killed mobile tab gets', () => {
    const onHide = vi.fn();
    const doc = fakeTarget({ visibilityState: 'hidden' });
    installPageHideFlush(onHide, { document: doc.target });
    doc.fire('visibilitychange');
    expect(onHide).toHaveBeenCalledTimes(1);
  });

  it('does NOT flush when the page becomes VISIBLE', () => {
    // `visibilitychange` fires in both directions. Flushing on every tab focus would upload constantly.
    const onHide = vi.fn();
    const doc = fakeTarget({ visibilityState: 'visible' });
    installPageHideFlush(onHide, { document: doc.target });
    doc.fire('visibilitychange');
    expect(onHide).not.toHaveBeenCalled();
  });

  it('flushes ONCE when hidden is followed by pagehide', () => {
    // The real mobile sequence: `visibilitychange`→hidden, then `pagehide`. Both are the same hide, and
    // the second flush would have nothing to write — but it would still cost a duplicate upload attempt.
    const onHide = vi.fn();
    const win = fakeTarget();
    const doc = fakeTarget({ visibilityState: 'hidden' });
    installPageHideFlush(onHide, { window: win.target, document: doc.target });
    doc.fire('visibilitychange');
    win.fire('pagehide');
    expect(onHide).toHaveBeenCalledTimes(1);
  });

  it('RE-ARMS when the page comes back — a bfcache restore must not be a one-shot', () => {
    // A page restored from the bfcache can be hidden and killed again, any number of times. Coalescing
    // that never resets would flush the first hide of a session and silently nothing after it.
    const onHide = vi.fn();
    const doc = fakeTarget({ visibilityState: 'hidden' });
    installPageHideFlush(onHide, { document: doc.target });
    doc.fire('visibilitychange');
    doc.state.visibilityState = 'visible';
    doc.fire('visibilitychange');
    doc.state.visibilityState = 'hidden';
    doc.fire('visibilitychange');
    expect(onHide).toHaveBeenCalledTimes(2);
  });

  it('does not throw back into the browser’s dispatch when the flush fails', () => {
    // This is a host boundary (Wave 2.1): the listener runs inside the browser's own event dispatch, at
    // the exact moment the page is going away.
    const onError = vi.fn();
    const win = fakeTarget();
    installPageHideFlush(
      () => {
        throw new Error('flush blew up');
      },
      { window: win.target, onError },
    );
    expect(() => win.fire('pagehide')).not.toThrow();
    expect(onError).toHaveBeenCalled();
  });

  it('removes every listener on uninstall', () => {
    const win = fakeTarget();
    const doc = fakeTarget();
    const uninstall = installPageHideFlush(() => {}, { window: win.target, document: doc.target });
    expect(win.count('pagehide')).toBe(1);
    expect(doc.count('visibilitychange')).toBe(1);
    uninstall();
    expect(win.count('pagehide')).toBe(0);
    expect(doc.count('visibilitychange')).toBe(0);
  });

  it('degrades to a no-op where neither global exists (a worker)', () => {
    const onHide = vi.fn();
    expect(() => installPageHideFlush(onHide, {})()).not.toThrow();
    expect(onHide).not.toHaveBeenCalled();
  });
});
