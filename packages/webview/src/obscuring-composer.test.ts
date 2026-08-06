import { describe, expect, it, vi } from 'vitest';
import { createObscuringComposer } from './obscuring-composer';
import { FAIL_CLOSED_AREA, SECURE_INPUT_SELECTOR } from './obscuring-source';
import type { SecureArea } from './protocol';

const secureEl = (top: number) => ({
  getBoundingClientRect: () => ({ top, left: top + 1, bottom: top + 2, right: top + 3 }),
});
const iframeEl = (contentWindow: unknown, top: number, left: number) => ({
  contentWindow,
  getBoundingClientRect: () => ({ top, left, bottom: top + 100, right: left + 100 }),
});

const SECURE_INPUT = SECURE_INPUT_SELECTOR;
const HIDE = '.bugsee-hide';

// A fake DOM document: querySelectorAll by selector (secure selectors + 'iframe') + an event registry + body.
function fakeDoc(bySelector: Record<string, unknown[]> = {}) {
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  return {
    querySelectorAll: (sel: string) => (bySelector[sel] ?? []) as never,
    addEventListener: (type: string, l: (e: unknown) => void) => {
      (listeners.get(type) ?? listeners.set(type, new Set()).get(type))?.add(l);
    },
    removeEventListener: (type: string, l: (e: unknown) => void) => listeners.get(type)?.delete(l),
    body: {},
    fire: (type: string, e?: unknown) => {
      for (const l of [...(listeners.get(type) ?? [])]) l(e);
    },
  };
}
// A fake window: event registry (scroll/resize/orientation from the source + 'message' from the composer) +
// scroll offset + a parent.postMessage sink.
function fakeWin(scroll: { scrollX?: number; scrollY?: number } = {}) {
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  const postMessage = vi.fn();
  return {
    ...scroll,
    parent: { postMessage },
    addEventListener: (type: string, l: (e: unknown) => void) => {
      (listeners.get(type) ?? listeners.set(type, new Set()).get(type))?.add(l);
    },
    removeEventListener: (type: string, l: (e: unknown) => void) => listeners.get(type)?.delete(l),
    fire: (type: string, e?: unknown) => {
      for (const l of [...(listeners.get(type) ?? [])]) l(e);
    },
    postMessage,
  };
}
const BUBBLE = (areas: SecureArea[]) => ({ __bugsee_secure_bubble: 1, areas });

describe('createObscuringComposer — top frame', () => {
  it('composes own VIEWPORT areas + the page scroll into DOCUMENT-ABSOLUTE rects, on change', () => {
    const doc = fakeDoc({ [SECURE_INPUT]: [secureEl(10)] });
    const win = fakeWin({ scrollX: 100.9, scrollY: 200.1 });
    const onCompose = vi.fn();
    const c = createObscuringComposer({
      document: doc,
      window: win,
      isTopFrame: true,
      onCompose,
      mutationObserver: undefined,
    });
    c.start();
    doc.fire('focus'); // a change recomputes + emits
    // viewport {top:10,left:11,bottom:12,right:13} + floored scroll {x:100,y:200} (x→left/right, y→top/bottom)
    expect(onCompose).toHaveBeenLastCalledWith([
      { type: 'text', top: 210, left: 111, bottom: 212, right: 113 },
    ]);
    c.stop();
  });

  it('snapshot() returns the current composed + scrolled areas (the native pull)', () => {
    const doc = fakeDoc({ [HIDE]: [secureEl(0)] });
    const win = fakeWin({ scrollX: 5, scrollY: 9 });
    const c = createObscuringComposer({ document: doc, window: win, isTopFrame: true });
    expect(c.snapshot()).toEqual([{ type: 'hidden', top: 9, left: 6, bottom: 11, right: 8 }]);
  });

  it('POSTS the initial rects on start — native masks from the push, not the pull', () => {
    const doc = fakeDoc({ [HIDE]: [secureEl(0)] });
    const onCompose = vi.fn();
    const c = createObscuringComposer({
      document: doc,
      window: fakeWin(),
      isTopFrame: true,
      onCompose,
      mutationObserver: undefined,
    });
    c.start();
    // Previously this asserted the opposite. It was wrong about the product: the Android receiver masks from
    // the PUSHED `secure` messages (`BridgeSecureSink.setSecureAreas`), and the pull (`requestSnapshot`) has
    // no production caller. With no initial push, native stood its legacy masking down and then masked
    // NOTHING until the first mutation/scroll/focus — and a static page injected after `load` never pushed.
    expect(onCompose).toHaveBeenCalledTimes(1);
    expect(onCompose.mock.calls[0]?.[0]).toHaveLength(1);
    c.stop();
  });

  it('fails CLOSED when composing a child frame throws — never posts an empty set', () => {
    // compose() reads every child iframe's LIVE rect on each emit, so a detached or hostile iframe throws
    // here — below the source's own guard. Posting [] would CLEAR native's mask (setSecureAreas replaces).
    const childWin = {};
    let broken = false;
    const iframe = {
      contentWindow: childWin,
      getBoundingClientRect: () => {
        if (broken) throw new Error('iframe detached mid-compose');
        return { top: 30, left: 40, bottom: 31, right: 41 };
      },
    };
    const doc = fakeDoc({ iframe: [iframe] });
    const win = fakeWin({ scrollX: 0, scrollY: 0 });
    const onCompose = vi.fn();
    const onError = vi.fn();
    const c = createObscuringComposer({
      document: doc,
      window: win,
      isTopFrame: true,
      onCompose,
      onError,
      mutationObserver: undefined,
    });
    c.start();
    win.fire('message', {
      data: BUBBLE([{ type: 'text', top: 5, left: 6, bottom: 7, right: 8 }]),
      source: childWin,
    });
    broken = true;
    c.refresh();
    expect(onCompose).toHaveBeenLastCalledWith([FAIL_CLOSED_AREA]);
    expect(onError).toHaveBeenCalled();
    c.stop();
  });

  it('includes a child frame: a bubble from a child iframe is re-mapped by the iframe offset', () => {
    const childWin = {};
    const iframe = iframeEl(childWin, 30, 40); // the <iframe> element sits at (left:40, top:30) in this frame
    const doc = fakeDoc({ iframe: [iframe] }); // no own secure areas; one iframe
    const win = fakeWin({ scrollX: 1, scrollY: 2 });
    const onCompose = vi.fn();
    const c = createObscuringComposer({
      document: doc,
      window: win,
      isTopFrame: true,
      onCompose,
      mutationObserver: undefined,
    });
    c.start();
    // the child bubbles a viewport rect {top:5,left:6,...}; parent adds iframe offset (40,30) then scroll (1,2)
    win.fire('message', {
      data: BUBBLE([{ type: 'text', top: 5, left: 6, bottom: 7, right: 8 }]),
      source: childWin,
    });
    expect(onCompose).toHaveBeenLastCalledWith([
      { type: 'text', top: 5 + 30 + 2, left: 6 + 40 + 1, bottom: 7 + 30 + 2, right: 8 + 40 + 1 },
    ]);
    c.stop();
  });

  it('re-maps child rects with the iframe FRESH offset when this frame scrolls (no stale offset)', () => {
    const childWin = {};
    let iframeTop = 30;
    const iframe = {
      contentWindow: childWin,
      getBoundingClientRect: () => ({
        top: iframeTop,
        left: 0,
        bottom: iframeTop + 100,
        right: 100,
      }),
    };
    const doc = fakeDoc({ iframe: [iframe] });
    const win = fakeWin({ scrollX: 0, scrollY: 0 });
    const onCompose = vi.fn();
    const c = createObscuringComposer({
      document: doc,
      window: win,
      isTopFrame: true,
      onCompose,
      mutationObserver: undefined,
    });
    c.start();
    win.fire('message', {
      data: BUBBLE([{ type: 'text', top: 0, left: 0, bottom: 1, right: 1 }]),
      source: childWin,
    });
    expect(onCompose).toHaveBeenLastCalledWith([
      { type: 'text', top: 30, left: 0, bottom: 31, right: 1 },
    ]);
    iframeTop = 50; // the iframe moved (this frame scrolled / layout changed)
    doc.fire('focus'); // a recompute must re-read the iframe's CURRENT rect
    expect(onCompose).toHaveBeenLastCalledWith([
      { type: 'text', top: 50, left: 0, bottom: 51, right: 1 },
    ]);
    c.stop();
  });

  it('drops a child whose iframe was removed (stale-frame GC on compose)', () => {
    const childWin = {};
    const iframe = iframeEl(childWin, 0, 0);
    const present: { iframe: unknown[] } = { iframe: [iframe] };
    const doc = {
      querySelectorAll: (sel: string) =>
        ((present as Record<string, unknown[]>)[sel] ?? []) as never,
      addEventListener: () => {},
      removeEventListener: () => {},
      body: {},
    };
    const win = fakeWin();
    const onCompose = vi.fn();
    const c = createObscuringComposer({
      document: doc,
      window: win,
      isTopFrame: true,
      onCompose,
      mutationObserver: undefined,
    });
    c.start();
    win.fire('message', {
      data: BUBBLE([{ type: 'text', top: 1, left: 1, bottom: 2, right: 2 }]),
      source: childWin,
    });
    expect(onCompose).toHaveBeenLastCalledWith([
      { type: 'text', top: 1, left: 1, bottom: 2, right: 2 },
    ]);
    present.iframe = []; // the iframe was removed from the DOM
    c.refresh();
    expect(onCompose).toHaveBeenLastCalledWith([]); // the stale child is gone
    c.stop();
  });

  it('ignores a message from a window that is NOT a child iframe (security)', () => {
    const doc = fakeDoc({ iframe: [iframeEl({}, 0, 0)] }); // one known child (a DIFFERENT window)
    const win = fakeWin();
    const onCompose = vi.fn();
    const c = createObscuringComposer({
      document: doc,
      window: win,
      isTopFrame: true,
      onCompose,
      mutationObserver: undefined,
    });
    c.start();
    win.fire('message', {
      data: BUBBLE([{ type: 'text', top: 1, left: 1, bottom: 2, right: 2 }]),
      source: {}, // a foreign window, not the known iframe's contentWindow
    });
    expect(onCompose).toHaveBeenCalledTimes(1); // only start()'s initial push — the foreign bubble was ignored
    c.stop();
  });

  it('ignores a non-bubble message (no marker / wrong shape)', () => {
    const childWin = {};
    const doc = fakeDoc({ iframe: [iframeEl(childWin, 0, 0)] });
    const win = fakeWin();
    const onCompose = vi.fn();
    const c = createObscuringComposer({
      document: doc,
      window: win,
      isTopFrame: true,
      onCompose,
      mutationObserver: undefined,
    });
    c.start();
    win.fire('message', { data: 'hello', source: childWin });
    win.fire('message', { data: { foo: 1 }, source: childWin });
    win.fire('message', { data: { __bugsee_secure_bubble: 99, areas: [] }, source: childWin }); // wrong version
    win.fire('message', { data: null, source: childWin });
    expect(onCompose).toHaveBeenCalledTimes(1); // only start()'s initial push
    c.stop();
  });

  it('sanitizes a received bubble — drops malformed / non-finite rects (robustness/security)', () => {
    const childWin = {};
    const doc = fakeDoc({ iframe: [iframeEl(childWin, 0, 0)] });
    const win = fakeWin();
    const onCompose = vi.fn();
    const c = createObscuringComposer({
      document: doc,
      window: win,
      isTopFrame: true,
      onCompose,
      mutationObserver: undefined,
    });
    c.start();
    win.fire('message', {
      data: {
        __bugsee_secure_bubble: 1,
        areas: [
          { type: 'text', top: 1, left: 2, bottom: 3, right: 4 }, // valid → kept
          { type: 'text', top: 'evil', left: 0, bottom: 0, right: 0 }, // non-numeric → dropped
          { type: 'hidden', top: Number.NaN, left: 0, bottom: 0, right: 0 }, // NaN → dropped
          { type: 'hidden', top: Number.POSITIVE_INFINITY, left: 0, bottom: 0, right: 0 }, // Infinity → dropped
          { type: 'bad', top: 0, left: 0, bottom: 0, right: 0 }, // bad type → dropped
          { top: 0, left: 0, bottom: 0, right: 0 }, // no type → dropped
        ],
      },
      source: childWin,
    });
    expect(onCompose).toHaveBeenLastCalledWith([
      { type: 'text', top: 1, left: 2, bottom: 3, right: 4 },
    ]);
    c.stop();
  });

  it('FLOORS the iframe offset (a sub-pixel iframe position)', () => {
    const childWin = {};
    const iframe = {
      contentWindow: childWin,
      getBoundingClientRect: () => ({ top: 30.9, left: 40.9, bottom: 130, right: 140 }),
    };
    const doc = fakeDoc({ iframe: [iframe] });
    const win = fakeWin({ scrollX: 0, scrollY: 0 });
    const onCompose = vi.fn();
    const c = createObscuringComposer({
      document: doc,
      window: win,
      isTopFrame: true,
      onCompose,
      mutationObserver: undefined,
    });
    c.start();
    win.fire('message', {
      data: BUBBLE([{ type: 'text', top: 0, left: 0, bottom: 1, right: 1 }]),
      source: childWin,
    });
    // 30.9/40.9 floored → +30/+40 (consistent with the floored scroll/own-area contract)
    expect(onCompose).toHaveBeenLastCalledWith([
      { type: 'text', top: 30, left: 40, bottom: 31, right: 41 },
    ]);
    c.stop();
  });
});

describe('createObscuringComposer — child frame (bubbles to parent)', () => {
  it('bubbles its composed VIEWPORT areas to window.parent on start AND on change (no native post)', () => {
    const doc = fakeDoc({ [SECURE_INPUT]: [secureEl(10)] });
    const win = fakeWin({ scrollX: 100, scrollY: 200 }); // child scroll is NOT applied (only the top adds scroll)
    const onCompose = vi.fn();
    const c = createObscuringComposer({
      document: doc,
      window: win,
      isTopFrame: false,
      onCompose,
      mutationObserver: undefined,
    });
    c.start();
    // initial bubble on start (so static child content reaches the parent)
    expect(win.postMessage).toHaveBeenCalledWith(
      {
        __bugsee_secure_bubble: 1,
        areas: [{ type: 'text', top: 10, left: 11, bottom: 12, right: 13 }],
      },
      '*',
    );
    expect(onCompose).not.toHaveBeenCalled(); // a child NEVER posts to native
    win.postMessage.mockClear();
    doc.fire('focus');
    expect(win.postMessage).toHaveBeenCalledTimes(1); // re-bubbles on change
    c.stop();
  });

  it('a child with no parent does not throw (defensive)', () => {
    const doc = fakeDoc({ [HIDE]: [secureEl(0)] });
    const win = { ...fakeWin(), parent: undefined };
    const c = createObscuringComposer({
      document: doc,
      window: win,
      isTopFrame: false,
      mutationObserver: undefined,
    });
    expect(() => c.start()).not.toThrow();
    c.stop();
  });

  it('snapshot() of a child returns composed VIEWPORT areas (no scroll, no document-absolute mapping)', () => {
    const doc = fakeDoc({ [HIDE]: [secureEl(7)] });
    const c = createObscuringComposer({
      document: doc,
      window: fakeWin({ scrollX: 100, scrollY: 200 }), // child scroll must NOT be applied
      isTopFrame: false,
    });
    expect(c.snapshot()).toEqual([{ type: 'hidden', top: 7, left: 8, bottom: 9, right: 10 }]);
  });
});

describe('createObscuringComposer — MutationObserver', () => {
  it('forwards an injected MutationObserver to the source (a DOM mutation drives a compose)', () => {
    const doc = fakeDoc({ [HIDE]: [secureEl(0)] });
    let mutate: () => void = () => {};
    class MO {
      constructor(cb: () => void) {
        mutate = cb;
      }
      observe() {}
      disconnect() {}
    }
    const onCompose = vi.fn();
    const c = createObscuringComposer({
      document: doc,
      window: fakeWin(),
      isTopFrame: true,
      onCompose,
      mutationObserver: MO as never,
    });
    c.start();
    mutate(); // a DOM mutation observed via the injected observer
    expect(onCompose).toHaveBeenLastCalledWith([
      { type: 'hidden', top: 0, left: 1, bottom: 2, right: 3 },
    ]);
    c.stop();
  });
});

describe('createObscuringComposer — no window (document-only)', () => {
  it('works without a window: focus drives compose with scroll 0; no message listener attached', () => {
    const doc = fakeDoc({ [HIDE]: [secureEl(3)] });
    const onCompose = vi.fn();
    const c = createObscuringComposer({
      document: doc,
      isTopFrame: true,
      onCompose,
      mutationObserver: undefined,
    });
    c.start();
    expect(c.snapshot()).toEqual([{ type: 'hidden', top: 3, left: 4, bottom: 5, right: 6 }]); // scroll 0
    doc.fire('focus');
    expect(onCompose).toHaveBeenLastCalledWith([
      { type: 'hidden', top: 3, left: 4, bottom: 5, right: 6 },
    ]);
    c.stop();
  });
});

describe('createObscuringComposer — lifecycle', () => {
  it('refresh() re-emits the current composed set (the snapshot control command)', () => {
    const doc = fakeDoc({ [HIDE]: [secureEl(0)] });
    const onCompose = vi.fn();
    const c = createObscuringComposer({
      document: doc,
      window: fakeWin(),
      isTopFrame: true,
      onCompose,
      mutationObserver: undefined,
    });
    c.start();
    c.refresh();
    expect(onCompose).toHaveBeenLastCalledWith([
      { type: 'hidden', top: 0, left: 1, bottom: 2, right: 3 },
    ]);
    c.stop();
  });

  it('stop() detaches the message listener + the source (no emits after stop)', () => {
    const childWin = {};
    const doc = fakeDoc({ iframe: [iframeEl(childWin, 0, 0)] });
    const win = fakeWin();
    const onCompose = vi.fn();
    const c = createObscuringComposer({
      document: doc,
      window: win,
      isTopFrame: true,
      onCompose,
      mutationObserver: undefined,
    });
    c.start();
    c.stop();
    win.fire('message', {
      data: BUBBLE([{ type: 'text', top: 1, left: 1, bottom: 2, right: 2 }]),
      source: childWin,
    });
    doc.fire('focus');
    expect(onCompose).toHaveBeenCalledTimes(1); // only start()'s initial push
  });
});
