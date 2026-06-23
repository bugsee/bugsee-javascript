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

  it('swallows an observe() that throws (no observer left, no throw to the app)', () => {
    const { Ctor, instances } = fakeObserver({ throwOnObserve: true });
    expect(() => wire({ PerformanceObserver: Ctor })).not.toThrow();
    instances[0]?.disconnect(); // sanity: an instance was constructed but its observe threw
  });

  it('disconnects the observer when the last subscriber unsubscribes (deactivate)', () => {
    const { Ctor, instances } = fakeObserver();
    const { off } = wire({ PerformanceObserver: Ctor });
    expect(instances[0]?.disconnected).toBe(false);
    off();
    expect(instances[0]?.disconnected).toBe(true);
  });
});
