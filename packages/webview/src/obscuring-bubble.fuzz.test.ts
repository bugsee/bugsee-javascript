import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import {
  type ComposerDocument,
  type ComposerWindow,
  createObscuringComposer,
} from './obscuring-composer';
import type { SecureArea } from './protocol';

/**
 * Property-based tests for the cross-frame obscuring bubble.
 *
 * This is the SDK's only genuinely UNTRUSTED input surface in the browser tier: a `message` listener that
 * anything with a handle to the window can post to — a cross-origin iframe, a popup, an opener, an
 * unrelated page in the same tab group. Whatever arrives is attacker-shaped by definition.
 *
 * The handler's job is to accept exactly one thing — a current-version bubble from a VERIFIED child
 * iframe of this frame — and to ignore everything else without throwing, since a throw inside a
 * `message` listener happens in the application's page.
 */

const BUBBLE_KEY = '__bugsee_secure_bubble';
const BUBBLE_VERSION = 1;

const area = (n: number): SecureArea => ({
  type: 'text',
  top: n,
  left: n,
  bottom: n + 10,
  right: n + 10,
});

/** A window whose `message` listeners the test can fire, standing in for the real frame. */
const fakeWindow = () => {
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  return {
    scrollX: 0,
    scrollY: 0,
    parent: { postMessage: vi.fn() },
    addEventListener: (type: string, l: (e: unknown) => void) => {
      (listeners.get(type) ?? listeners.set(type, new Set()).get(type))?.add(l);
    },
    removeEventListener: (type: string, l: (e: unknown) => void) => listeners.get(type)?.delete(l),
    fire: (type: string, e: unknown) => {
      for (const l of [...(listeners.get(type) ?? [])]) {
        l(e);
      }
    },
  };
};

/** A document holding exactly one `<iframe>` whose contentWindow is `childWindow`. */
const fakeDocument = (childWindow: unknown) => ({
  querySelectorAll: (selector: string) =>
    (selector === 'iframe'
      ? [
          {
            contentWindow: childWindow,
            getBoundingClientRect: () => ({ top: 100, left: 200, bottom: 300, right: 400 }),
          },
        ]
      : []) as never,
  addEventListener: () => {},
  removeEventListener: () => {},
  body: {},
});

const setup = () => {
  const childWindow = { name: 'the-verified-child' };
  const win = fakeWindow();
  const onCompose = vi.fn();
  const onError = vi.fn();
  const composer = createObscuringComposer({
    document: fakeDocument(childWindow) as unknown as ComposerDocument,
    window: win as unknown as ComposerWindow,
    isTopFrame: true,
    onCompose,
    onError,
    mutationObserver: undefined,
  });
  composer.start();
  return { composer, win, childWindow, onCompose, onError };
};

const composedAreas = (onCompose: ReturnType<typeof vi.fn>): SecureArea[] =>
  (onCompose.mock.calls.at(-1)?.[0] as SecureArea[] | undefined) ?? [];

describe('obscuring bubble — untrusted message handling (fuzz)', () => {
  /**
   * A bubble is only accepted from a window that is the `contentWindow` of an iframe in THIS document.
   * Any other sender is ignored — that is the check the module marks SECURITY.
   */
  it('ignores a bubble from any window that is not a verified child iframe', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<unknown>(
          undefined,
          null,
          { name: 'a-stranger' },
          { name: 'the-opener' },
          'not-even-a-window',
          42,
        ),
        fc.integer({ min: 1, max: 50 }),
        (stranger, n) => {
          const { win, onCompose } = setup();
          const before = onCompose.mock.calls.length;
          win.fire('message', {
            data: { [BUBBLE_KEY]: BUBBLE_VERSION, areas: [area(n)] },
            source: stranger,
          });
          // Nothing composed, so nothing from an unverified sender reached the payload.
          expect(onCompose.mock.calls.length, 'a stranger’s bubble was accepted').toBe(before);
        },
      ),
      { numRuns: 400 },
    );
  });

  it('accepts a bubble from the verified child, re-mapped by the iframe offset', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 50 }), (n) => {
        const { win, childWindow, onCompose } = setup();
        win.fire('message', {
          data: { [BUBBLE_KEY]: BUBBLE_VERSION, areas: [area(n)] },
          source: childWindow,
        });
        const composed = composedAreas(onCompose);
        expect(composed, 'the verified child’s bubble was dropped').toHaveLength(1);
        // The iframe sits at (left 200, top 100), so the child's viewport rect moves by that much.
        expect(composed[0]).toMatchObject({ top: n + 100, left: n + 200 });
      }),
      { numRuns: 300 },
    );
  });

  /**
   * Everything that is not a current-version bubble is ignored, and nothing throws.
   *
   * A throw here lands in the application's `message` dispatch, so totality is the load-bearing half:
   * whatever a hostile frame posts, the page must be unaffected.
   */
  it('ignores arbitrary message payloads without throwing', () => {
    const hostile = fc.oneof(
      fc.anything(),
      fc.constant({ [BUBBLE_KEY]: 999, areas: [area(1)] }), // wrong version
      fc.constant({ [BUBBLE_KEY]: BUBBLE_VERSION }), // no areas
      fc.constant({ [BUBBLE_KEY]: BUBBLE_VERSION, areas: 'not-an-array' }),
      fc.constant({ [BUBBLE_KEY]: BUBBLE_VERSION, areas: null }),
      fc.constant({ areas: [area(1)] }), // no key at all
    );
    fc.assert(
      fc.property(hostile, (data) => {
        const { win, childWindow, onCompose } = setup();
        const before = onCompose.mock.calls.length;
        expect(() => win.fire('message', { data, source: childWindow })).not.toThrow();
        // A non-bubble contributes nothing. (A well-formed bubble would, and is tested above.)
        const isBubble =
          typeof data === 'object' &&
          data !== null &&
          (data as Record<string, unknown>)[BUBBLE_KEY] === BUBBLE_VERSION &&
          Array.isArray((data as Record<string, unknown>).areas);
        if (!isBubble) {
          expect(onCompose.mock.calls.length, 'a non-bubble payload was accepted').toBe(before);
        }
      }),
      { numRuns: 600 },
    );
  });

  /**
   * Coordinates from a child are SANITIZED: a buggy or hostile frame must not inject NaN/Infinity or
   * non-numeric rects into the payload native masks with. A malformed rect is dropped, and well-formed
   * siblings in the same bubble still land.
   */
  it('drops malformed rects and keeps the well-formed ones in the same bubble', () => {
    const malformed = fc.constantFrom<unknown>(
      { type: 'text', top: Number.NaN, left: 0, bottom: 1, right: 1 },
      { type: 'text', top: Number.POSITIVE_INFINITY, left: 0, bottom: 1, right: 1 },
      { type: 'text', top: '0', left: 0, bottom: 1, right: 1 },
      { type: 'bogus', top: 0, left: 0, bottom: 1, right: 1 },
      { top: 0, left: 0, bottom: 1, right: 1 }, // no type
      null,
      'not-an-area',
      42,
    );
    fc.assert(
      fc.property(malformed, fc.integer({ min: 1, max: 40 }), (bad, n) => {
        const { win, childWindow, onCompose } = setup();
        win.fire('message', {
          data: { [BUBBLE_KEY]: BUBBLE_VERSION, areas: [bad, area(n)] },
          source: childWindow,
        });
        const composed = composedAreas(onCompose);
        expect(composed, 'a malformed rect survived sanitisation').toHaveLength(1);
        for (const a of composed) {
          for (const coord of [a.top, a.left, a.bottom, a.right]) {
            expect(Number.isFinite(coord), 'a non-finite coordinate reached the payload').toBe(
              true,
            );
          }
          expect(['text', 'hidden']).toContain(a.type);
        }
      }),
      { numRuns: 400 },
    );
  });

  // A child that bubbles an EMPTY list is withdrawing its own rects, which is legitimate — but it must
  // not be able to withdraw anything beyond its own.
  it('lets a child withdraw only its own areas', () => {
    const { win, childWindow, composer, onCompose } = setup();
    win.fire('message', {
      data: { [BUBBLE_KEY]: BUBBLE_VERSION, areas: [area(5)] },
      source: childWindow,
    });
    expect(composedAreas(onCompose)).toHaveLength(1);
    win.fire('message', { data: { [BUBBLE_KEY]: BUBBLE_VERSION, areas: [] }, source: childWindow });
    expect(composedAreas(onCompose)).toHaveLength(0);
    composer.stop();
  });
});
