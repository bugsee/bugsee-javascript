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

// Review round 1 (webview reviewer, SEV1 #1/#2/#3). The previous fix hardened the PULL
// (`__bugsee_bridge.snapshot()`) while leaving the push able to emit nothing — and the push is what a
// receiver acts on, whichever generation it is: an older one masks from the payload directly, a current
// one (Android D-A9) discards the payload and re-pulls on receipt. Either way a push that fails silently
// leaves the mask stale, so every claim below is about what native actually receives.
describe('the PUSH path — what native acts on — also fails closed', () => {
  const composerWith = (doc: SecureDocument, onError = vi.fn()) => {
    const posted: unknown[][] = [];
    const composer = createObscuringComposer({
      document: doc as never,
      isTopFrame: true,
      onCompose: (areas) => posted.push(areas),
      onError,
    });
    return { composer, posted, onError };
  };

  it('pushes the initial rects at start, instead of leaving native with nothing', () => {
    // With no initial push, native masked NOTHING until the first mutation/scroll/focus — and a static page
    // injected after `load` never pushed at all.
    //
    // The original framing — "declaring the `obscuring` capability stands native's own masking down" — is
    // superseded (D-A7). Native never stands its masking down for anything the page claims, because a
    // decision that REDUCES masking cannot be authorised by the party being masked. The initial push still
    // matters for the reason above, not that one.
    const { composer, posted } = composerWith(okDoc([{ top: 5, left: 6, bottom: 7, right: 8 }]));
    composer.start();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toEqual([{ type: 'text', top: 5, left: 6, bottom: 7, right: 8 }]);
    composer.stop();
  });

  it('pushes the full-frame rect when a refresh fails, rather than posting nothing', () => {
    // Posting nothing leaves native's PREVIOUS rects in place — the "stale rects report success" state the
    // policy explicitly rejects, on the live path.
    //
    // The failure has to occur in the COMPOSE/emit step, not in collection: `source.snapshot()` already
    // fails closed on its own, so a throwing `querySelectorAll` never reaches this catch and a test built on
    // one passes whether or not the catch exists. Reading the scroll offset throws inside `emit()`.
    let broken = false;
    const posted: unknown[][] = [];
    const onError = vi.fn();
    const composer = createObscuringComposer({
      document: okDoc([{ top: 5, left: 6, bottom: 7, right: 8 }]) as never,
      window: {
        addEventListener: () => {},
        removeEventListener: () => {},
        get scrollX(): number {
          if (broken) throw new Error('scroll read failed');
          return 0;
        },
        get scrollY(): number {
          if (broken) throw new Error('scroll read failed');
          return 0;
        },
      } as never,
      isTopFrame: true,
      onCompose: (areas) => posted.push(areas),
      onError,
    });
    composer.start();
    const before = posted.length;
    broken = true;
    composer.refresh();
    expect(posted.length).toBe(before + 1);
    expect(posted[posted.length - 1]).toEqual([FAIL_CLOSED_AREA]);
    expect(onError).toHaveBeenCalled();
    composer.stop();
  });

  it('pushes the full-frame rect when start() itself fails', () => {
    // A swallowed start() failure left `obscuring` declared while the bubble listener was never attached —
    // native stood down and every SUB-FRAME became invisible, undetectably. The failure must be in the
    // ATTACH step for the same layering reason as above.
    const posted: unknown[][] = [];
    const onError = vi.fn();
    const composer = createObscuringComposer({
      document: okDoc() as never,
      window: {
        addEventListener: () => {
          throw new Error('hostile page replaced addEventListener');
        },
        removeEventListener: () => {},
        scrollX: 0,
        scrollY: 0,
      } as never,
      isTopFrame: true,
      onCompose: (areas) => posted.push(areas),
      onError,
    });
    composer.start();
    expect(posted[posted.length - 1]).toEqual([FAIL_CLOSED_AREA]);
    expect(onError).toHaveBeenCalled();
    composer.stop();
  });
});

describe('a SUB-frame fails closed to its parent, and never throws into the page', () => {
  it('bubbles the full-frame rect to the parent when start() fails', () => {
    const bubbles: unknown[] = [];
    const onError = vi.fn();
    const composer = createObscuringComposer({
      document: okDoc() as never,
      window: {
        addEventListener: () => {
          throw new Error('hostile page');
        },
        removeEventListener: () => {},
        parent: { postMessage: (m: unknown) => bubbles.push(m) },
      } as never,
      isTopFrame: false,
      onError,
    });
    composer.start();
    expect((bubbles[bubbles.length - 1] as { areas: unknown[] }).areas).toEqual([FAIL_CLOSED_AREA]);
    composer.stop();
  });

  it('does not throw into the page when even the fail-closed post fails', () => {
    // `window.parent` is [Replaceable] — one line of page script makes postMessage throw. Reporting the
    // failure is all that is left; taking the host page down with us is not an option.
    const onError = vi.fn();
    const composer = createObscuringComposer({
      document: throwingDoc() as never,
      window: {
        addEventListener: () => {
          throw new Error('hostile page');
        },
        removeEventListener: () => {},
        parent: {
          postMessage: () => {
            throw new Error('hostile parent');
          },
        },
      } as never,
      isTopFrame: false,
      onError,
    });
    expect(() => composer.start()).not.toThrow();
    expect(onError).toHaveBeenCalled();
    composer.stop();
  });
});
