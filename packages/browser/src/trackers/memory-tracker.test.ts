import { describe, expect, it, vi } from 'vitest';
import { type MemoryState, MemoryTracker } from './memory-tracker';

function mkScheduler() {
  const timers = new Map<number, () => void>();
  let next = 1;
  return {
    setInterval: vi.fn((cb: () => void, _ms: number) => {
      const h = next++;
      timers.set(h, cb);
      return h;
    }),
    clearInterval: vi.fn((h: unknown) => void timers.delete(h as number)),
    tick: () =>
      [...timers.values()].forEach((cb) => {
        cb();
      }),
    live: () => timers.size,
  };
}
const mem = (used: number, limit = 100) => ({
  usedJSHeapSize: used,
  totalJSHeapSize: limit / 2,
  jsHeapSizeLimit: limit,
});

describe('MemoryTracker', () => {
  it('attaches nothing until the first subscriber (no timer, no read)', () => {
    const s = mkScheduler();
    const read = vi.fn(() => mem(1));
    new MemoryTracker({ memory: read, scheduler: s });
    expect(s.setInterval).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it('polls on ONE shared timer at the default 1000 ms and emits {used, limit} per tick', () => {
    const s = mkScheduler();
    let used = 10;
    const t = new MemoryTracker({ memory: () => mem(used, 200), scheduler: s });
    const a: MemoryState[] = [];
    const b: MemoryState[] = [];
    const offA = t.on('memory', (m) => a.push(m));
    const offB = t.on('memory', (m) => b.push(m));
    expect(s.setInterval).toHaveBeenCalledTimes(1);
    expect(s.setInterval.mock.calls[0]?.[1]).toBe(1000);
    used = 20;
    s.tick();
    expect(a).toEqual([{ used: 20, limit: 200 }]);
    expect(b).toEqual(a);
    offA();
    expect(s.live()).toBe(1); // still one subscriber
    offB();
    expect(s.live()).toBe(0); // last one releases the timer
  });

  it('honours intervalMs and re-arms after a stop -> start', () => {
    const s = mkScheduler();
    const t = new MemoryTracker({ memory: () => mem(1), scheduler: s, intervalMs: 250 });
    t.on('memory', () => {})();
    expect(s.setInterval.mock.calls[0]?.[1]).toBe(250);
    expect(s.live()).toBe(0);
    const off = t.on('memory', () => {});
    expect(s.setInterval).toHaveBeenCalledTimes(2);
    expect(s.live()).toBe(1);
    off();
  });

  it('current() reads the live heap, and is undefined when the engine has no performance.memory', () => {
    expect(new MemoryTracker({ memory: () => mem(7, 70) }).current()).toEqual({
      used: 7,
      limit: 70,
    });
    expect(new MemoryTracker({}).current()).toBeUndefined();
    expect(new MemoryTracker({ memory: () => undefined }).current()).toBeUndefined();
  });

  it('starts no timer at all where the engine cannot answer (Safari/Firefox)', () => {
    const s = mkScheduler();
    const t = new MemoryTracker({ memory: () => undefined, scheduler: s });
    const seen = vi.fn();
    const off = t.on('memory', seen);
    expect(s.setInterval).not.toHaveBeenCalled();
    off();
    expect(s.clearInterval).not.toHaveBeenCalled();
    expect(seen).not.toHaveBeenCalled();
  });

  it('a throwing read is reported and skips that tick; the next tick recovers', () => {
    const s = mkScheduler();
    const onError = vi.fn();
    let boom = true;
    const t = new MemoryTracker({
      memory: () => {
        if (boom) throw new Error('getter');
        return mem(5);
      },
      scheduler: s,
      onError,
    });
    const got: MemoryState[] = [];
    t.on('memory', (m) => got.push(m));
    expect(onError).toHaveBeenCalledTimes(1); // the activation probe threw: reported, timer still armed
    expect(s.live()).toBe(1);
    expect(() => s.tick()).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(2);
    expect(got).toEqual([]);
    boom = false;
    s.tick();
    expect(got).toEqual([{ used: 5, limit: 100 }]);
  });

  it('a throwing current() is reported, not thrown', () => {
    const onError = vi.fn();
    const t = new MemoryTracker({
      memory: () => {
        throw new Error('getter');
      },
      onError,
    });
    expect(t.current()).toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('defaults to the global timers (real setInterval) and releases them', () => {
    vi.useFakeTimers();
    try {
      const t = new MemoryTracker({ memory: () => mem(3) });
      const got: MemoryState[] = [];
      const off = t.on('memory', (m) => got.push(m));
      vi.advanceTimersByTime(2100);
      expect(got.length).toBe(2);
      off();
      vi.advanceTimersByTime(5000);
      expect(got.length).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases a timer exactly once: a later activation that finds no heap API must not clear a stale handle again', () => {
    const s = mkScheduler();
    let supported = true;
    const t = new MemoryTracker({ memory: () => (supported ? mem(1) : undefined), scheduler: s });
    t.on('memory', () => {})(); // activate, then deactivate
    expect(s.clearInterval).toHaveBeenCalledTimes(1);
    supported = false;
    t.on('memory', () => {})(); // activate (no timer), deactivate
    expect(s.clearInterval).toHaveBeenCalledTimes(1);
  });

  it('a throwing scheduler is reported, not thrown out of on(); a later subscriber re-arms nothing but the tracker still releases cleanly', () => {
    const onError = vi.fn();
    const t = new MemoryTracker({
      memory: () => mem(1),
      scheduler: {
        setInterval: () => {
          throw new Error('no timers');
        },
        clearInterval: vi.fn(),
      },
      onError,
    });
    let off: (() => void) | undefined;
    expect(() => {
      off = t.on('memory', () => {});
    }).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(() => off?.()).not.toThrow(); // no timer was armed, so nothing to clear
  });
});
