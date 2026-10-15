import { describe, expect, it, vi } from 'vitest';
import { PageLifecycleTracker } from './page-lifecycle-tracker';

function mkTarget() {
  const l = new Map<string, Set<(e: unknown) => void>>();
  return {
    addEventListener: (t: string, f: (e: unknown) => void) => {
      const s = l.get(t) ?? new Set<(e: unknown) => void>();
      s.add(f);
      l.set(t, s);
    },
    removeEventListener: (t: string, f: (e: unknown) => void) => void l.get(t)?.delete(f),
    fire: (t: string, e: unknown = {}) =>
      l.get(t)?.forEach((f) => {
        f(e);
      }),
    count: (t?: string) =>
      t === undefined ? [...l.values()].reduce((n, s) => n + s.size, 0) : (l.get(t)?.size ?? 0),
  };
}

function mkEnv() {
  const win = mkTarget();
  const doc = Object.assign(mkTarget(), { visibilityState: 'visible' as string });
  return { win, doc };
}

describe('PageLifecycleTracker', () => {
  it('attaches nothing until the first subscriber', () => {
    const { win, doc } = mkEnv();
    new PageLifecycleTracker({ window: win, document: doc });
    expect(win.count() + doc.count()).toBe(0);
  });

  it('attaches pagehide/online/offline/orientationchange on window and visibilitychange on document', () => {
    const { win, doc } = mkEnv();
    const t = new PageLifecycleTracker({ window: win, document: doc });
    t.on('online', () => {});
    for (const type of ['pagehide', 'online', 'offline', 'orientationchange']) {
      expect(win.count(type)).toBe(1);
    }
    expect(doc.count('visibilitychange')).toBe(1);
  });

  it('releases everything on the last unsubscribe and re-attaches on the next subscriber', () => {
    const { win, doc } = mkEnv();
    const t = new PageLifecycleTracker({ window: win, document: doc });
    const offA = t.on('online', () => {});
    const offB = t.on('offline', () => {});
    offA();
    expect(win.count() + doc.count()).toBe(5);
    offB();
    expect(win.count() + doc.count()).toBe(0);
    t.on('online', () => {});
    expect(win.count() + doc.count()).toBe(5);
  });

  it('removes each listener exactly once per activation cycle (no stale entries replayed on a later stop)', () => {
    const { win, doc } = mkEnv();
    const removes = vi.fn();
    const realRemove = win.removeEventListener;
    win.removeEventListener = (t, f) => {
      removes(t);
      realRemove(t, f);
    };
    const t = new PageLifecycleTracker({ window: win, document: doc });
    t.on('online', () => {})();
    t.on('online', () => {})();
    expect(removes).toHaveBeenCalledTimes(8);
  });

  it('emits typed events', () => {
    const { win, doc } = mkEnv();
    const t = new PageLifecycleTracker({ window: win, document: doc });
    const seen: unknown[] = [];
    t.on('pagehide', (e) => seen.push(['pagehide', e]));
    t.on('visibility', (e) => seen.push(['visibility', e]));
    t.on('online', () => seen.push(['online']));
    t.on('offline', () => seen.push(['offline']));
    t.on('orientationchange', () => seen.push(['orientationchange']));
    win.fire('pagehide', { persisted: true });
    win.fire('pagehide', {});
    doc.visibilityState = 'hidden';
    doc.fire('visibilitychange');
    doc.visibilityState = 'visible';
    doc.fire('visibilitychange');
    win.fire('online');
    win.fire('offline');
    win.fire('orientationchange');
    expect(seen).toEqual([
      ['pagehide', { persisted: true }],
      ['pagehide', { persisted: false }],
      ['visibility', { visible: false }],
      ['visibility', { visible: true }],
      ['online'],
      ['offline'],
      ['orientationchange'],
    ]);
  });

  it('works with no document and with no window', () => {
    const { win, doc } = mkEnv();
    const onlyWin = new PageLifecycleTracker({ window: win });
    onlyWin.on('online', () => {})();
    const onlyDoc = new PageLifecycleTracker({ document: doc });
    onlyDoc.on('visibility', () => {});
    expect(doc.count('visibilitychange')).toBe(1);
    expect(() => new PageLifecycleTracker({}).on('online', () => {})()).not.toThrow();
  });

  it('a missing visibilityState counts as not visible', () => {
    const win = mkTarget();
    const doc = mkTarget();
    const t = new PageLifecycleTracker({ window: win, document: doc });
    const seen: unknown[] = [];
    t.on('visibility', (e) => seen.push(e));
    doc.fire('visibilitychange');
    expect(seen).toEqual([{ visible: false }]);
  });

  it('a throwing getter in the event path is reported, never thrown into dispatch', () => {
    const win = mkTarget();
    const onError = vi.fn();
    const doc = mkTarget();
    Object.defineProperty(doc, 'visibilityState', {
      get(): never {
        throw new Error('getter');
      },
    });
    const t = new PageLifecycleTracker({ window: win, document: doc }, onError);
    t.on('visibility', () => {});
    expect(() => doc.fire('visibilitychange')).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('a throwing addEventListener is reported and what attached is still released', () => {
    const win = mkTarget();
    const onError = vi.fn();
    const doc = mkTarget();
    doc.addEventListener = () => {
      throw new Error('detached');
    };
    const t = new PageLifecycleTracker({ window: win, document: doc }, onError);
    const off = t.on('online', () => {});
    expect(onError).toHaveBeenCalledTimes(1);
    off();
    expect(win.count()).toBe(0);
  });

  it('a throwing removeEventListener does not leak the others', () => {
    const win = mkTarget();
    const doc = mkTarget();
    doc.removeEventListener = () => {
      throw new Error('detached');
    };
    const t = new PageLifecycleTracker({ window: win, document: doc });
    const off = t.on('online', () => {});
    expect(() => off()).not.toThrow();
    expect(win.count()).toBe(0);
  });

  it('tolerates targets without addEventListener', () => {
    const t = new PageLifecycleTracker({
      window: {} as never,
      document: { visibilityState: 'visible' } as never,
    });
    expect(() => t.on('online', () => {})()).not.toThrow();
  });
});
