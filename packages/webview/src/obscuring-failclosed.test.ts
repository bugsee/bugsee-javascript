import { describe, expect, it, vi } from 'vitest';
import { createObscuringChannel } from './obscuring-channel';
import { createObscuringComposer } from './obscuring-composer';
import {
  collectSecureAreas,
  createObscuringSource,
  FAIL_CLOSED_AREA,
  type SecureDocument,
} from './obscuring-source';

// Wave 1.4 — the obscuring path must fail CLOSED (docs/review/webview.md SEV1 #1 + "Obscuring fail-open
// analysis").
//
// `__bugsee_bridge.snapshot()` is the SYNCHRONOUS pull native performs at frame-capture time to learn which
// rects to mask. Declaring the `obscuring` capability is exactly what tells native to stand its legacy
// masking script down — so when this chain throws there is no second line of defence, and native renders the
// frame UNMASKED with password / cc-* / .bugsee-hide content in it. There was no `try` anywhere in
// obscuring-source.ts, obscuring-composer.ts or obscuring-channel.ts, and one line of page script
// (`document.querySelectorAll = () => { throw 0 }`) was enough to trigger it deliberately.
//
// The rule these tests pin: a failure obscures MORE, never less, and never nothing. Stale rects are NOT an
// acceptable answer — a password field added after the failure would be unmasked while the system reported
// success.

const throwingDoc = (): SecureDocument =>
  ({
    querySelectorAll: () => {
      throw new Error('DOM error at frame-capture time');
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  }) as unknown as SecureDocument;

const okDoc = (rects: Array<Record<string, number>> = []): SecureDocument =>
  ({
    querySelectorAll: (sel: string) =>
      sel.includes('password')
        ? rects.map((r) => ({ getBoundingClientRect: () => r }))
        : ([] as never),
    addEventListener: () => {},
    removeEventListener: () => {},
  }) as unknown as SecureDocument;

describe('collectSecureAreas — the collection itself', () => {
  it('reports the failure and returns a full-viewport rect when the DOM throws', () => {
    const onError = vi.fn();
    const areas = collectSecureAreas(throwingDoc(), { onError });
    expect(areas).toEqual([FAIL_CLOSED_AREA]);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('reports and fails closed when a rect measurement throws', () => {
    // A element can be removed mid-measure, or a hostile page can define a throwing getBoundingClientRect.
    const onError = vi.fn();
    const doc = {
      querySelectorAll: () => [
        {
          getBoundingClientRect: () => {
            throw new Error('detached');
          },
        },
      ],
      addEventListener: () => {},
      removeEventListener: () => {},
    } as unknown as SecureDocument;
    expect(collectSecureAreas(doc, { onError })).toEqual([FAIL_CLOSED_AREA]);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('covers the whole frame — the fail-closed rect starts at the origin and is unbounded', () => {
    // Composed into document-absolute coordinates it is offset by the scroll position, so an origin-anchored
    // rect that extends past any viewport still covers whatever native is about to capture.
    expect(FAIL_CLOSED_AREA.top).toBe(0);
    expect(FAIL_CLOSED_AREA.left).toBe(0);
    expect(FAIL_CLOSED_AREA.bottom).toBeGreaterThan(100_000);
    expect(FAIL_CLOSED_AREA.right).toBeGreaterThan(100_000);
    expect(FAIL_CLOSED_AREA.type).toBe('hidden');
  });

  it('still returns real areas when the DOM is healthy', () => {
    const areas = collectSecureAreas(okDoc([{ top: 5, left: 6, bottom: 7, right: 8 }]));
    expect(areas).toEqual([{ type: 'text', top: 5, left: 6, bottom: 7, right: 8 }]);
  });
});

describe('the source never lets a failure through, on any path', () => {
  it('fails closed on the synchronous snapshot', () => {
    const onError = vi.fn();
    const source = createObscuringSource({ document: throwingDoc(), onChange: () => {}, onError });
    expect(source.snapshot()).toEqual([FAIL_CLOSED_AREA]);
    expect(onError).toHaveBeenCalled();
  });

  it('emits the fail-closed set on a change recompute rather than going stale', () => {
    // Path 3 of the analysis: a throw inside the MutationObserver callback was swallowed by the event
    // machinery, `ownAreas` kept its previous value, and the mask silently went stale with nothing reported.
    const emitted: unknown[] = [];
    let broken = false;
    const doc = {
      querySelectorAll: (sel: string) => {
        if (broken) throw new Error('DOM went bad');
        return sel.includes('password')
          ? [{ getBoundingClientRect: () => ({ top: 1, left: 1, bottom: 2, right: 2 }) }]
          : [];
      },
      addEventListener: () => {},
      removeEventListener: () => {},
    } as unknown as SecureDocument;
    let fire = (): void => {};
    const source = createObscuringSource({
      document: doc,
      onChange: (areas) => emitted.push(areas),
      onError: () => {},
      mutationObserver: class {
        constructor(cb: () => void) {
          fire = cb;
        }
        observe(): void {}
        disconnect(): void {}
      } as never,
    });
    source.start();
    broken = true;
    fire();
    expect(emitted).toEqual([[FAIL_CLOSED_AREA]]);
  });

  it('contains a throwing consumer so it cannot escape into the event machinery', () => {
    // `onChange` runs inside the MutationObserver callback and the scroll/resize/focus listeners. A throw
    // there is swallowed by the dispatch machinery with nothing reported — the failure mode that let the
    // mask go stale and silent in the first place.
    const onError = vi.fn();
    let fire = (): void => {};
    const source = createObscuringSource({
      document: okDoc(),
      onChange: () => {
        throw new Error('consumer boom');
      },
      onError,
      mutationObserver: class {
        constructor(cb: () => void) {
          fire = cb;
        }
        observe(): void {}
        disconnect(): void {}
      } as never,
    });
    source.start();
    expect(() => fire()).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('never throws out of stop() when detaching a listener fails', () => {
    // stop() runs from the client's own stop() path; a throw there would break the host app's teardown.
    const onError = vi.fn();
    const doc = {
      querySelectorAll: () => [],
      addEventListener: () => {},
      removeEventListener: () => {
        throw new Error('detach refused');
      },
    } as unknown as SecureDocument;
    const source = createObscuringSource({ document: doc, onChange: () => {}, onError });
    source.start();
    expect(() => source.stop()).not.toThrow();
    expect(onError).toHaveBeenCalled();
  });

  it('never throws out of start() or stop()', () => {
    const onError = vi.fn();
    const doc = {
      querySelectorAll: () => [],
      addEventListener: () => {
        throw new Error('listener refused');
      },
      removeEventListener: () => {},
    } as unknown as SecureDocument;
    const source = createObscuringSource({ document: doc, onChange: () => {}, onError });
    expect(() => source.start()).not.toThrow();
    expect(() => source.stop()).not.toThrow();
    expect(onError).toHaveBeenCalled();
  });
});

describe('the channel — the boundary native actually calls', () => {
  const channel = (document: SecureDocument, onError = vi.fn()) =>
    createObscuringChannel({
      bridge: { post: () => {} } as never,
      document: document as never,
      seq: () => 1,
      wallNow: () => 0,
      now: () => 0,
      timeOrigin: 0,
      onError,
    });

  it('answers native with a fail-closed rect instead of throwing into evaluateJavascript', () => {
    const onError = vi.fn();
    const snapshot = channel(throwingDoc(), onError).snapshot();
    expect(() => JSON.parse(snapshot)).not.toThrow();
    expect(JSON.parse(snapshot)).toEqual([FAIL_CLOSED_AREA]);
    expect(onError).toHaveBeenCalled();
  });

  it('returns healthy rects as JSON when the DOM is fine', () => {
    const snapshot = channel(okDoc([{ top: 5, left: 6, bottom: 7, right: 8 }])).snapshot();
    expect(JSON.parse(snapshot)).toEqual([{ type: 'text', top: 5, left: 6, bottom: 7, right: 8 }]);
  });

  it('probe() reports whether obscuring can actually do its job', () => {
    // What gates the `obscuring` capability: declaring it is what makes native stand its own masking down,
    // so it must not be declared on a page where collection is already failing (SEV1 #2 — the protocol has
    // no way to retract it afterwards).
    expect(channel(okDoc()).probe()).toBe(true);
    expect(channel(throwingDoc()).probe()).toBe(false);
  });

  it('never throws out of start(), stop() or emit()', () => {
    const c = channel(throwingDoc());
    expect(() => c.start()).not.toThrow();
    expect(() => c.emit()).not.toThrow();
    expect(() => c.stop()).not.toThrow();
  });
});

describe('the composer fails closed too', () => {
  it('fails closed when collection throws (via the source guard)', () => {
    const onError = vi.fn();
    const composer = createObscuringComposer({
      document: throwingDoc() as never,
      isTopFrame: true,
      onError,
    });
    expect(composer.snapshot()).toEqual([FAIL_CLOSED_AREA]);
    expect(onError).toHaveBeenCalled();
  });

  it('fails closed when the COMPOSE step itself throws, not just collection', () => {
    // The previous test never reaches the composer's own guard: the source already answers a failed
    // collection with the fail-closed rect, so nothing propagates this far. Composition does its own DOM
    // reads — child-iframe rects and the top frame's scroll offsets — and those can throw independently.
    const onError = vi.fn();
    const composer = createObscuringComposer({
      document: okDoc([{ top: 1, left: 1, bottom: 2, right: 2 }]) as never,
      window: {
        addEventListener: () => {},
        removeEventListener: () => {},
        get scrollX(): number {
          throw new Error('scroll read failed');
        },
        get scrollY(): number {
          throw new Error('scroll read failed');
        },
      } as never,
      isTopFrame: true,
      onError,
    });
    expect(composer.snapshot()).toEqual([FAIL_CLOSED_AREA]);
    expect(onError).toHaveBeenCalled();
  });
});
