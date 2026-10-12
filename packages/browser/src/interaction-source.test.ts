import { createBlackoutState } from '@bugsee/core';
import { describe, expect, it } from 'vitest';
import {
  createBrowserInteractionSource,
  type InteractionDetail,
  type InteractionEnv,
} from './interaction-source';

// A fake PerformanceObserver: records the observe() options and lets the test push Event Timing entries.
interface EntryLike {
  name: string;
  duration: number;
  startTime?: number;
  interactionId?: number;
  target?: unknown;
}
function fakeObserver(opts: { supported?: string[]; throwOnObserve?: boolean } = {}) {
  const instances: FakeObserver[] = [];
  class FakeObserver {
    readonly cb: (list: { getEntries(): EntryLike[] }) => void;
    observed: { type: string; buffered?: boolean; durationThreshold?: number } | undefined;
    disconnected = false;
    constructor(cb: (list: { getEntries(): EntryLike[] }) => void) {
      this.cb = cb;
      instances.push(this);
    }
    observe(o: { type: string; buffered?: boolean; durationThreshold?: number }): void {
      if (opts.throwOnObserve) throw new Error('observe not allowed');
      this.observed = o;
    }
    disconnect(): void {
      this.disconnected = true;
    }
    push(entries: EntryLike[]): void {
      this.cb({ getEntries: () => entries });
    }
  }
  (FakeObserver as unknown as { supportedEntryTypes?: string[] }).supportedEntryTypes =
    opts.supported ?? ['event', 'first-input'];
  return { Ctor: FakeObserver as unknown as InteractionEnv['PerformanceObserver'], instances };
}

// Subscribe (which activates the source) and collect emitted interactions.
function wire(env: InteractionEnv) {
  const source = createBrowserInteractionSource(env);
  const seen: InteractionDetail[] = [];
  const off = source.on('interact', (d) => seen.push(d));
  return { source, seen, off };
}

describe('createBrowserInteractionSource', () => {
  it('emits one interact per qualifying interaction (type, duration, target selector, id)', () => {
    const { Ctor, instances } = fakeObserver();
    const { seen } = wire({ PerformanceObserver: Ctor });
    instances[0]?.push([
      {
        name: 'click',
        duration: 120,
        interactionId: 14,
        target: { tagName: 'BUTTON', id: 'submit' },
      },
    ]);
    expect(seen).toEqual([
      { interactionType: 'click', target: 'button#submit', duration: 120, interactionId: 14 },
    ]);
  });

  it('observes the `event` type buffered, with the default 40ms durationThreshold', () => {
    const { Ctor, instances } = fakeObserver();
    wire({ PerformanceObserver: Ctor });
    expect(instances[0]?.observed).toEqual({
      type: 'event',
      buffered: true,
      durationThreshold: 40,
    });
  });

  it('forwards a custom durationThreshold to observe', () => {
    const { Ctor, instances } = fakeObserver();
    wire({ PerformanceObserver: Ctor, durationThreshold: 100 });
    expect(instances[0]?.observed?.durationThreshold).toBe(100);
  });

  it('dedupes an interaction by interactionId — many entries, one emit (latency from the first)', () => {
    const { Ctor, instances } = fakeObserver();
    const { seen } = wire({ PerformanceObserver: Ctor });
    // pointerup + click of ONE tap share interactionId 21; only the first (above threshold) emits.
    instances[0]?.push([
      { name: 'pointerup', duration: 90, interactionId: 21, target: { tagName: 'A' } },
      { name: 'click', duration: 110, interactionId: 21, target: { tagName: 'A' } },
    ]);
    expect(seen).toEqual([
      { interactionType: 'pointerup', target: 'a', duration: 90, interactionId: 21 },
    ]);
  });

  it('skips non-interaction entries (interactionId 0 or undefined)', () => {
    const { Ctor, instances } = fakeObserver();
    const { seen } = wire({ PerformanceObserver: Ctor });
    instances[0]?.push([
      { name: 'keydown', duration: 50, interactionId: 0, target: { tagName: 'INPUT' } },
      { name: 'click', duration: 50, target: { tagName: 'DIV' } }, // interactionId undefined
    ]);
    expect(seen).toEqual([]);
  });

  it('emits for each distinct interaction; a repeat/lower id is skipped (monotonic high-water mark)', () => {
    const { Ctor, instances } = fakeObserver();
    const { seen } = wire({ PerformanceObserver: Ctor });
    instances[0]?.push([
      { name: 'click', duration: 60, interactionId: 7, target: { tagName: 'B' } },
    ]);
    instances[0]?.push([
      { name: 'click', duration: 70, interactionId: 14, target: { tagName: 'B' } },
    ]);
    instances[0]?.push([
      { name: 'click', duration: 80, interactionId: 7, target: { tagName: 'B' } },
    ]); // stale repeat
    expect(seen.map((s) => s.interactionId)).toEqual([7, 14]);
  });

  it('labels a masked target by its tag only (no selector/value leaks)', () => {
    const { Ctor, instances } = fakeObserver();
    const { seen } = wire({ PerformanceObserver: Ctor });
    instances[0]?.push([
      {
        name: 'keydown',
        duration: 50,
        interactionId: 30,
        target: { tagName: 'INPUT', type: 'password' },
      },
    ]);
    expect(seen[0]?.target).toBe('input'); // describeTarget masks the password → { tag, masked }
  });

  it('forwards a custom maskSelector to describeTarget (a matched subtree collapses to its tag)', () => {
    const { Ctor, instances } = fakeObserver();
    const { seen } = wire({ PerformanceObserver: Ctor, maskSelector: '[data-secret]' });
    instances[0]?.push([
      {
        name: 'click',
        duration: 50,
        interactionId: 50,
        // describeTarget masks when `closest(maskSelector)` matches → tag only, no id/selector.
        target: {
          tagName: 'BUTTON',
          id: 'pay',
          closest: (s: string) => (s === '[data-secret]' ? {} : null),
        },
      },
    ]);
    expect(seen[0]?.target).toBe('button'); // masked via the CUSTOM selector → tag only (no '#pay')
  });

  it('still emits (target omitted, no throw) when the target read throws (invalid maskSelector)', () => {
    const { Ctor, instances } = fakeObserver();
    const { seen } = wire({ PerformanceObserver: Ctor, maskSelector: ':::not-a-selector' });
    expect(() =>
      instances[0]?.push([
        {
          name: 'click',
          duration: 60,
          interactionId: 60,
          // describeTarget calls el.closest(maskSelector) → throws SyntaxError on an invalid selector.
          target: {
            tagName: 'BUTTON',
            closest: () => {
              throw new SyntaxError('bad selector');
            },
          },
        },
      ]),
    ).not.toThrow(); // observe-only: the throw is swallowed at the target read
    expect(seen[0]).toEqual({ interactionType: 'click', duration: 60, interactionId: 60 }); // emitted, no target
  });

  it('resolves the nearest annotated component name (data-bugsee-component)', () => {
    const { Ctor, instances } = fakeObserver();
    const { seen } = wire({ PerformanceObserver: Ctor });
    instances[0]?.push([
      {
        name: 'click',
        duration: 70,
        interactionId: 70,
        target: {
          tagName: 'BUTTON',
          id: 'go',
          // the annotated component boundary (the build plugin would have stamped this)
          closest: (s: string) =>
            s === '[data-bugsee-component]' ? { getAttribute: () => 'Toolbar' } : null,
        },
      },
    ]);
    expect(seen[0]?.component).toBe('Toolbar');
    expect(seen[0]?.target).toBe('button#go'); // (still also the PII-safe selector)
  });

  it('omits component when the target has no annotated ancestor', () => {
    const { Ctor, instances } = fakeObserver();
    const { seen } = wire({ PerformanceObserver: Ctor });
    instances[0]?.push([
      { name: 'click', duration: 50, interactionId: 71, target: { tagName: 'DIV' } }, // no closest → none
    ]);
    expect(seen[0] && 'component' in seen[0]).toBe(false);
  });

  it('omits target for a non-element target', () => {
    const { Ctor, instances } = fakeObserver();
    const { seen } = wire({ PerformanceObserver: Ctor });
    instances[0]?.push([{ name: 'click', duration: 50, interactionId: 40, target: null }]);
    expect(seen[0]).toEqual({ interactionType: 'click', duration: 50, interactionId: 40 });
    expect(seen[0] && 'target' in seen[0]).toBe(false);
  });

  it('self-skips when the Event Timing API is unsupported (no observer constructed, no emit)', () => {
    const { Ctor, instances } = fakeObserver({ supported: ['paint', 'first-input'] }); // no 'event'
    const { seen } = wire({ PerformanceObserver: Ctor });
    expect(instances).toHaveLength(0); // never constructed an observer
    expect(seen).toEqual([]);
  });

  it('self-skips when there is no PerformanceObserver at all (does not throw)', () => {
    expect(() => wire({ PerformanceObserver: undefined })).not.toThrow();
  });

  it('swallows an observe() that throws; a later deactivate does not disconnect the failed observer', () => {
    const { Ctor, instances } = fakeObserver({ throwOnObserve: true });
    let off: (() => void) | undefined;
    expect(() => {
      off = wire({ PerformanceObserver: Ctor }).off;
    }).not.toThrow();
    expect(instances).toHaveLength(1); // an instance was constructed, but its observe threw
    off?.(); // deactivate — #observer was cleared in the catch, so disconnect() must NOT be called
    expect(instances[0]?.disconnected).toBe(false); // pins `this.#observer = undefined` in the catch
  });

  it('disconnects the observer when the last subscriber unsubscribes (deactivate)', () => {
    const { Ctor, instances } = fakeObserver();
    const { off } = wire({ PerformanceObserver: Ctor });
    expect(instances[0]?.disconnected).toBe(false);
    off();
    expect(instances[0]?.disconnected).toBe(true);
  });

  it('emits nothing during a blackout, and an entry seen then is not replayed after it ends', () => {
    const { Ctor, instances } = fakeObserver();
    const blackout = createBlackoutState();
    const { seen } = wire({ PerformanceObserver: Ctor, blackout });
    const click = (id: number) => ({
      name: 'click',
      duration: 90,
      interactionId: id,
      target: { tagName: 'BUTTON', id: `b${id}` },
    });
    instances[0]?.push([click(1)]);
    blackout.start();
    instances[0]?.push([click(2)]);
    blackout.end();
    instances[0]?.push([click(2), click(3)]); // 2 was consumed during the blackout
    expect(seen.map((d) => d.interactionId)).toEqual([1, 3]);
  });

  describe('blackout is judged by EVENT time, not delivery time', () => {
    const click = (id: number, startTime: number, duration = 90) => ({
      name: 'click',
      duration,
      startTime,
      interactionId: id,
      target: { tagName: 'BUTTON', id: `b${id}` },
    });
    const setup = () => {
      const { Ctor, instances } = fakeObserver();
      const blackout = createBlackoutState();
      let t = 0;
      const wired = wire({ PerformanceObserver: Ctor, blackout, now: () => t });
      return {
        ...wired,
        instances,
        blackout,
        at: (ms: number) => {
          t = ms;
        },
      };
    };

    it('drops an interaction that happened DURING a blackout even when it is delivered after it ended', () => {
      const h = setup();
      h.at(1000);
      h.blackout.start();
      h.at(2000);
      h.blackout.end();
      // Delivered (3000) well after the blackout ended; the click itself was at 1500, inside the span.
      h.at(3000);
      h.instances[0]?.push([click(1, 1500), click(2, 2500)]);
      expect(h.seen.map((d) => d.interactionId)).toEqual([2]);
    });

    it('drops an interaction that STARTED before the blackout but was still processing when it began', () => {
      const h = setup();
      h.at(1000);
      h.blackout.start();
      h.at(2000);
      h.blackout.end();
      h.at(3000);
      h.instances[0]?.push([click(1, 950, 100)]); // 950..1050 overlaps the span start
      expect(h.seen).toEqual([]);
    });

    it('keeps interactions that ended before the blackout began and ones that started after it ended', () => {
      const h = setup();
      h.at(1000);
      h.blackout.start();
      h.at(2000);
      h.blackout.end();
      h.at(3000);
      h.instances[0]?.push([click(1, 800, 100), click(2, 2000.5)]);
      expect(h.seen.map((d) => d.interactionId)).toEqual([1, 2]);
    });

    it('a span still OPEN at delivery covers entries from its start onward', () => {
      const h = setup();
      h.at(1000);
      h.blackout.start();
      h.at(1200);
      h.instances[0]?.push([click(1, 1100)]);
      expect(h.seen).toEqual([]);
    });

    it('remembers several spans', () => {
      const h = setup();
      h.at(100);
      h.blackout.start();
      h.at(200);
      h.blackout.end();
      h.at(300);
      h.blackout.start();
      h.at(400);
      h.blackout.end();
      h.at(500);
      h.instances[0]?.push([click(1, 150, 10), click(2, 250, 10), click(3, 350, 10)]);
      expect(h.seen.map((d) => d.interactionId)).toEqual([2]);
    });

    it('a blackout already in force when the source is built covers everything before it ends', () => {
      const { Ctor, instances } = fakeObserver();
      const blackout = createBlackoutState();
      blackout.start();
      let t = 5000;
      const { seen } = wire({ PerformanceObserver: Ctor, blackout, now: () => t });
      t = 6000;
      blackout.end();
      t = 7000;
      instances[0]?.push([click(1, 10), click(2, 5500), click(3, 6500)]);
      expect(seen.map((d) => d.interactionId)).toEqual([3]);
    });

    it('forgets spans long past (bounded memory) but still drops entries from a recent one', () => {
      const h = setup();
      for (let i = 0; i < 200; i += 1) {
        h.at(1000 + i * 10_000);
        h.blackout.start();
        h.at(1005 + i * 10_000);
        h.blackout.end();
      }
      const last = 1000 + 199 * 10_000;
      h.at(last + 100);
      h.instances[0]?.push([click(1, 1002), click(2, last + 2)]);
      // 1002 sits in the very first span, forgotten after the 5 min retention (the whole point of the
      // bound); the recent span is still enforced.
      expect(h.seen.map((d) => d.interactionId)).toEqual([1]);
    });

    it('caps the number of remembered spans (a blackout storm cannot grow memory)', () => {
      const h = setup();
      for (let i = 0; i < 100; i += 1) {
        h.at(i * 10);
        h.blackout.start();
        h.at(i * 10 + 5);
        h.blackout.end();
      }
      h.at(2000);
      // 64 newest spans are kept (i = 36..99); span 0 (0..5) was evicted, span 99 (990..995) remains.
      h.instances[0]?.push([click(1, 1, 1), click(2, 991, 1)]);
      expect(h.seen.map((d) => d.interactionId)).toEqual([1]);
    });

    it('treats the span edges as INSIDE (an interaction touching the blackout is dropped)', () => {
      const h = setup();
      h.at(1000);
      h.blackout.start();
      h.at(2000);
      h.blackout.end();
      h.at(3000);
      // 910..1000 ends exactly where the span starts; 2000..2001 starts exactly where it ends.
      h.instances[0]?.push([click(1, 910, 90), click(2, 2000, 1)]);
      expect(h.seen).toEqual([]);
    });

    it('forgets a span older than the retention window (5 min) even when few spans exist', () => {
      const h = setup();
      h.at(1000);
      h.blackout.start();
      h.at(1005);
      h.blackout.end();
      h.at(1000 + 6 * 60_000);
      h.blackout.start(); // a later blackout prunes the long-dead first span
      h.at(1005 + 6 * 60_000);
      h.blackout.end();
      h.instances[0]?.push([click(1, 1002, 1)]);
      expect(h.seen.map((d) => d.interactionId)).toEqual([1]);
    });

    it('an entry without a startTime falls back to the delivery-time gate', () => {
      const h = setup();
      h.blackout.start();
      h.instances[0]?.push([{ name: 'click', duration: 90, interactionId: 1, target: {} }]);
      h.blackout.end();
      expect(h.seen).toEqual([]);
    });
  });
});
