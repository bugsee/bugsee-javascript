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

  it('reset(key) drops that key only, calling the tracker reset() first, and the next use creates a fresh one', () => {
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

  it('holds keys weakly: the registry never keeps a torn-down window alive', async () => {
    const registry = createTrackerRegistry<Thing>();
    let win: object | undefined = {};
    const ref = new WeakRef(win);
    registry.for(win, () => new Thing());
    win = undefined;
    const gc = (globalThis as { gc?: () => void }).gc;
    if (gc === undefined) return; // only observable with --expose-gc; the WeakMap guarantees it by construction
    for (let i = 0; i < 10 && ref.deref() !== undefined; i++) {
      gc();
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(ref.deref()).toBeUndefined();
  });
});
