import { describe, expect, it, vi } from 'vitest';
import { collectSecureAreas, createObscuringSource } from './obscuring-source';
import type { SecureArea } from './protocol';

// A fake element with a rect.
const el = (top: number) => ({
  getBoundingClientRect: () => ({ top, left: top + 1, bottom: top + 2, right: top + 3 }),
});

// A fake DOM document: querySelectorAll by selector + an event-listener registry.
function fakeDoc(bySelector: Record<string, ReturnType<typeof el>[]>) {
  const listeners = new Map<string, Set<() => void>>();
  return {
    querySelectorAll: (sel: string) => bySelector[sel] ?? [],
    addEventListener: (type: string, l: () => void) => {
      (listeners.get(type) ?? listeners.set(type, new Set()).get(type))?.add(l);
    },
    removeEventListener: (type: string, l: () => void) => listeners.get(type)?.delete(l),
    body: {},
    fire: (type: string) => {
      for (const l of [...(listeners.get(type) ?? [])]) l();
    },
  };
}

// The auto-detect secure-input selector EXCLUDES `.bugsee-show` (the legacy opt-out keeps such a field visible).
const SECURE_INPUT =
  'input[type=password]:not(.bugsee-show), input[autocomplete*="cc-"]:not(.bugsee-show)';
const HIDE = '.bugsee-hide';

describe('collectSecureAreas', () => {
  it('collects secure inputs (text) + .bugsee-hide elements (hidden) with viewport rects', () => {
    const doc = fakeDoc({ [SECURE_INPUT]: [el(10)], [HIDE]: [el(20)] });
    expect(collectSecureAreas(doc)).toEqual([
      { type: 'text', top: 10, left: 11, bottom: 12, right: 13 },
      { type: 'hidden', top: 20, left: 21, bottom: 22, right: 23 },
    ]);
  });

  it('dedupes an element matched by BOTH selectors (a secure input is reported once, as text)', () => {
    const shared = el(5);
    const doc = fakeDoc({ [SECURE_INPUT]: [shared], [HIDE]: [shared] });
    const areas = collectSecureAreas(doc);
    expect(areas).toHaveLength(1);
    expect(areas[0]?.type).toBe('text');
  });

  it('returns empty when nothing is secured', () => {
    expect(collectSecureAreas(fakeDoc({}))).toEqual([]);
  });
});

describe('createObscuringSource', () => {
  it('snapshot() returns the CURRENT secure areas', () => {
    const doc = fakeDoc({ [SECURE_INPUT]: [el(1)], [HIDE]: [] });
    const src = createObscuringSource({ document: doc, onChange: () => {} });
    expect(src.snapshot()).toEqual([{ type: 'text', top: 1, left: 2, bottom: 3, right: 4 }]);
  });

  it('recomputes + emits onChange on a DOM mutation (via the injected MutationObserver)', () => {
    const doc = fakeDoc({ [HIDE]: [el(7)] });
    let mutate: () => void = () => {};
    const observe = vi.fn();
    class MO {
      constructor(cb: () => void) {
        mutate = cb;
      }
      observe = observe;
      disconnect = vi.fn();
    }
    const onChange = vi.fn();
    const src = createObscuringSource({ document: doc, onChange, mutationObserver: MO as never });
    src.start();
    expect(observe).toHaveBeenCalledTimes(1); // observing on start
    expect(observe.mock.calls[0]?.[0]).toBe(doc.body); // observes the body when present
    expect(observe.mock.calls[0]?.[1]).toEqual({
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true, // a text-node change can move a secure element
    });
    mutate(); // a DOM change
    expect(onChange).toHaveBeenCalledWith([
      { type: 'hidden', top: 7, left: 8, bottom: 9, right: 10 },
    ]);
  });

  it('recomputes on window scroll/resize/orientation/load + document focus/blur, and stop() detaches', () => {
    const doc = fakeDoc({ [HIDE]: [el(0)] });
    const win = fakeDoc({});
    const onChange = vi.fn();
    const disconnectSpy = vi.fn();
    class MO {
      observe = vi.fn();
      disconnect = disconnectSpy;
    }
    const src = createObscuringSource({
      document: doc,
      window: win,
      onChange,
      mutationObserver: MO as never,
    });
    src.start();
    win.fire('scroll');
    win.fire('orientationchange');
    win.fire('load'); // a frame-tree load re-triggers compose (so a static sub-frame re-bubbles — D9)
    doc.fire('focus');
    expect(onChange).toHaveBeenCalledTimes(4);
    src.stop();
    expect(disconnectSpy).toHaveBeenCalledTimes(1); // observer disconnected
    onChange.mockClear();
    win.fire('scroll'); // detached → no more callbacks
    win.fire('load');
    doc.fire('focus');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('emits VIEWPORT rects (no scroll added — the composer applies offsets)', () => {
    const doc = fakeDoc({ [HIDE]: [el(7)] });
    let last: SecureArea[] | undefined;
    const src = createObscuringSource({
      document: doc,
      window: fakeDoc({}),
      onChange: (a) => {
        last = a;
      },
    });
    expect(src.snapshot()).toEqual([{ type: 'hidden', top: 7, left: 8, bottom: 9, right: 10 }]);
    src.start();
    doc.fire('focus');
    expect(last).toEqual([{ type: 'hidden', top: 7, left: 8, bottom: 9, right: 10 }]);
    src.stop();
  });

  it('start() is idempotent — a second start() does not double-attach (no duplicate emits)', () => {
    const doc = fakeDoc({ [HIDE]: [el(0)] });
    const onChange = vi.fn();
    const observe = vi.fn();
    class MO {
      observe = observe;
      disconnect = vi.fn();
    }
    const src = createObscuringSource({ document: doc, onChange, mutationObserver: MO as never });
    src.start();
    src.start(); // second start must be a no-op
    expect(observe).toHaveBeenCalledTimes(1); // observer attached once, not twice
    doc.fire('focus');
    expect(onChange).toHaveBeenCalledTimes(1); // a single listener ⇒ one emit, not two
    src.stop();
  });

  it('observes document.body when present, else the document itself (no-body fallback)', () => {
    const observe = vi.fn();
    class MO {
      observe = observe;
      disconnect = vi.fn();
    }
    // A document with NO `body` (the optional field omitted) → the source falls back to observing it directly.
    const { body: _drop, ...docNoBody } = fakeDoc({});
    createObscuringSource({
      document: docNoBody,
      onChange: () => {},
      mutationObserver: MO as never,
    }).start();
    expect(observe).toHaveBeenCalledTimes(1);
    expect(observe.mock.calls[0]?.[0]).toBe(docNoBody); // observed the document itself
  });

  it('degrades when no MutationObserver is available (no throw; events still work)', () => {
    const doc = fakeDoc({ [HIDE]: [el(0)] });
    const onChange = vi.fn();
    const src = createObscuringSource({ document: doc, onChange, mutationObserver: undefined });
    expect(() => src.start()).not.toThrow();
    doc.fire('focus');
    expect(onChange).toHaveBeenCalledTimes(1); // focus listener still drives recompute
    src.stop();
  });
});
