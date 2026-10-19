import { describe, expect, it, vi } from 'vitest';
import { createTrackerRegistry } from './tracker-registry';

class Thing {
  resets = 0;
  reset(): void {
    this.resets += 1;
  }
}

describe('createTrackerRegistry (one tracker per window object — a singleton scoped to what the SDK is bound to)', () => {
  it('creates a tracker on first use for a key and returns the SAME instance afterwards', () => {
    const registry = createTrackerRegistry<Thing>();
    const win = {};
    const create = vi.fn(() => new Thing());
    const a = registry.for(win, create);
    expect(registry.for(win, create)).toBe(a);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('calls rebind on EVERY request after the first (a relaunch rebinds per-launch config to the shared tracker), never on creation', () => {
    const registry = createTrackerRegistry<{ sink: string }>();
    const win = {};
    const calls: string[] = [];
    const rebind = (sink: string) => (tracker: { sink: string }) => {
      calls.push(sink);
      tracker.sink = sink;
    };
    const first = registry.for(win, () => ({ sink: 'created-with-A' }), rebind('A'));
    expect(calls).toEqual([]); // creation already used launch A's config
    expect(registry.for(win, () => ({ sink: 'unused' }), rebind('B'))).toBe(first);
    expect(first.sink).toBe('B');
    expect(registry.for(win, () => ({ sink: 'unused' }))).toBe(first); // no rebind callback: untouched
    expect(first.sink).toBe('B');
    expect(calls).toEqual(['B']);
  });

  it('a caller whose factory lost a re-entrant race still gets its rebind applied to the singleton it receives', () => {
    const registry = createTrackerRegistry<{ id: string; sink?: string }>();
    const win = {};
    const result = registry.for(
      win,
      (key) => {
        registry.for(key, () => ({ id: 'inner' })); // installs the singleton first
        return { id: 'outer-discarded', sink: 'B' };
      },
      (tracker) => {
        tracker.sink = 'B';
      },
    );
    expect(result.id).toBe('inner');
    expect(result.sink).toBe('B'); // the outer caller's config reached the instance it got
    // and a throwing rebind on that path still returns the singleton
    const w2 = {};
    expect(
      registry.for(
        w2,
        (key) => {
          registry.for(key, () => ({ id: 'inner2' }));
          return { id: 'x' };
        },
        () => {
          throw new Error('boom');
        },
      ).id,
    ).toBe('inner2');
  });

  it('a throwing rebind never breaks the request: the tracker is still returned', () => {
    const registry = createTrackerRegistry<Thing>();
    const win = {};
    const t = registry.for(win, () => new Thing());
    expect(
      registry.for(
        win,
        () => new Thing(),
        () => {
          throw new Error('rebind failed');
        },
      ),
    ).toBe(t);
  });

  it('keeps separate trackers per key (an injected window never shares state with the host window)', () => {
    const registry = createTrackerRegistry<Thing>();
    const w1 = {};
    const w2 = {};
    expect(registry.for(w1, () => new Thing())).not.toBe(registry.for(w2, () => new Thing()));
  });

  it('passes the key to the factory so the tracker binds to exactly that window', () => {
    const registry = createTrackerRegistry<{ owner: object }>();
    const win = {};
    expect(registry.for(win, (key) => ({ owner: key })).owner).toBe(win);
  });

  it('peek returns the existing tracker without creating one', () => {
    const registry = createTrackerRegistry<Thing>();
    const win = {};
    expect(registry.peek(win)).toBeUndefined();
    const t = registry.for(win, () => new Thing());
    expect(registry.peek(win)).toBe(t);
  });

  it('reset(key) drops that key only, detaching the tracker and then calling its reset(), and the next use creates a fresh one', () => {
    const registry = createTrackerRegistry<Thing>();
    const w1 = {};
    const w2 = {};
    const t1 = registry.for(w1, () => new Thing());
    const t2 = registry.for(w2, () => new Thing());
    registry.reset(w1);
    expect(t1.resets).toBe(1);
    expect(t2.resets).toBe(0);
    expect(registry.peek(w1)).toBeUndefined();
    expect(registry.peek(w2)).toBe(t2);
    expect(registry.for(w1, () => new Thing())).not.toBe(t1);
  });

  it('reset() of an unknown key is a no-op; a tracker without reset() is simply dropped; a throwing reset() cannot block the drop', () => {
    const registry = createTrackerRegistry<{ x: number; reset?: () => void }>();
    expect(() => registry.reset({})).not.toThrow();
    const a = {};
    registry.for(a, () => ({ x: 1 }));
    registry.reset(a);
    expect(registry.peek(a)).toBeUndefined();
    const b = {};
    registry.for(b, () => ({
      x: 2,
      reset: () => {
        throw new Error('reset failed');
      },
    }));
    expect(() => registry.reset(b)).not.toThrow();
    expect(registry.peek(b)).toBeUndefined();
  });

  it('holds keys WEAKLY: the registry stores through a WeakMap (never a Map, which would leak every injected window)', () => {
    const set = vi.spyOn(WeakMap.prototype, 'set');
    const mapSet = vi.spyOn(Map.prototype, 'set');
    try {
      const registry = createTrackerRegistry<Thing>();
      const win = {};
      registry.for(win, () => new Thing());
      expect(set.mock.calls.some(([key]) => key === win)).toBe(true);
      expect(mapSet.mock.calls.some(([key]) => key === win)).toBe(false);
    } finally {
      set.mockRestore();
      mapSet.mockRestore();
    }
  });

  it('is re-entrancy safe: a factory that asks for the same key gets, and leaves, ONE tracker (the inner one)', () => {
    const registry = createTrackerRegistry<{ id: string }>();
    const win = {};
    const created: string[] = [];
    const outer = registry.for(win, (key) => {
      const inner = registry.for(key, () => {
        created.push('inner');
        return { id: 'inner' };
      });
      created.push('outer');
      return { id: inner.id === 'inner' ? 'outer' : 'x' };
    });
    expect(created).toEqual(['inner', 'outer']);
    expect(registry.for(win, () => ({ id: 'never' }))).toBe(outer);
    expect(registry.peek(win)).toBe(outer);
    // the singleton is whichever instance the registry holds, and every caller got that same one
    const inner = registry.peek(win);
    expect(inner?.id).toBe('inner');
    expect(outer).toBe(inner);
  });

  it('during reset() the tracker is already detached (a listener asking for the key sees no half-reset tracker)', () => {
    const registry = createTrackerRegistry<{ reset(): void }>();
    const win = {};
    let during: unknown = 'unset';
    registry.for(win, () => ({
      reset: () => {
        during = registry.peek(win);
      },
    }));
    registry.reset(win);
    expect(during).toBeUndefined();
  });

  it('reset(key) leaves the key EMPTY even if the tracker reset() re-requests it (or throws)', () => {
    const registry = createTrackerRegistry<{ reset(): void }>();
    const win = {};
    registry.for(win, () => ({
      reset: () => {
        registry.for(win, () => ({ reset: () => {} })); // a reset that re-creates itself
      },
    }));
    registry.reset(win);
    expect(registry.peek(win)).toBeUndefined();

    const w2 = {};
    registry.for(w2, () => ({
      reset: () => {
        registry.for(w2, () => ({ reset: () => {} }));
        throw new Error('then fails');
      },
    }));
    expect(() => registry.reset(w2)).not.toThrow();
    expect(registry.peek(w2)).toBeUndefined();
  });
});
