import { describe, expect, it, vi } from 'vitest';
import {
  ApplicationTracker,
  applicationTrackerFor,
  resetApplicationTracker,
} from './application-tracker';

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

describe('ApplicationTracker', () => {
  it('attaches nothing until the first subscriber', () => {
    const { win, doc } = mkEnv();
    new ApplicationTracker({ window: win, document: doc });
    expect(win.count() + doc.count()).toBe(0);
  });

  it('attaches pagehide/online/offline/orientationchange on window and visibilitychange on document', () => {
    const { win, doc } = mkEnv();
    const t = new ApplicationTracker({ window: win, document: doc });
    t.on('online', () => {});
    for (const type of ['pagehide', 'online', 'offline', 'orientationchange']) {
      expect(win.count(type)).toBe(1);
    }
    expect(doc.count('visibilitychange')).toBe(1);
  });

  it('freeze and resume are Page Lifecycle events on the DOCUMENT (they do not bubble to window)', () => {
    const { win, doc } = mkEnv();
    const t = new ApplicationTracker({ window: win, document: doc });
    const seen: string[] = [];
    t.on('freeze', () => seen.push('freeze'));
    t.on('resume', () => seen.push('resume'));
    expect(doc.count('freeze')).toBe(1);
    expect(doc.count('resume')).toBe(1);
    expect(win.count('freeze')).toBe(0);
    expect(win.count('resume')).toBe(0);
    win.fire('freeze'); // a window listener beside pagehide would never see these: nothing happens
    doc.fire('freeze');
    doc.fire('resume');
    expect(seen).toEqual(['freeze', 'resume']);
  });

  it('freeze/resume without a document attach nothing (not on the window either) and do not throw', () => {
    const { win } = mkEnv();
    const t = new ApplicationTracker({ window: win });
    let off: (() => void) | undefined;
    expect(() => {
      off = t.on('freeze', () => {});
    }).not.toThrow();
    expect(win.count('freeze')).toBe(0); // checked while SUBSCRIBED
    expect(win.count('resume')).toBe(0);
    expect(win.count()).toBe(4); // only the window's own pagehide/online/offline/orientationchange
    off?.();
  });

  it('a document that refuses only freeze/resume still delivers visibility', () => {
    const { win, doc } = mkEnv();
    const realAdd = doc.addEventListener;
    doc.addEventListener = (type, f) => {
      if (type === 'freeze' || type === 'resume') throw new Error('newer types refused');
      realAdd(type, f);
    };
    const errors: unknown[] = [];
    const t = new ApplicationTracker({ window: win, document: doc }, (e) => errors.push(e));
    const seen: boolean[] = [];
    t.on('visibility', (e) => seen.push(e.visible));
    doc.visibilityState = 'hidden';
    doc.fire('visibilitychange');
    expect(seen).toEqual([false]);
    expect(errors).toHaveLength(1);
  });

  it('releases everything on the last unsubscribe and re-attaches on the next subscriber', () => {
    const { win, doc } = mkEnv();
    const t = new ApplicationTracker({ window: win, document: doc });
    const offA = t.on('online', () => {});
    const offB = t.on('offline', () => {});
    offA();
    expect(win.count() + doc.count()).toBe(7);
    offB();
    expect(win.count() + doc.count()).toBe(0);
    t.on('online', () => {});
    expect(win.count() + doc.count()).toBe(7);
  });

  it('removes each listener exactly once per activation cycle (no stale entries replayed on a later stop)', () => {
    const { win, doc } = mkEnv();
    const removes = vi.fn();
    const realRemove = win.removeEventListener;
    win.removeEventListener = (t, f) => {
      removes(t);
      realRemove(t, f);
    };
    const t = new ApplicationTracker({ window: win, document: doc });
    t.on('online', () => {})();
    t.on('online', () => {})();
    expect(removes).toHaveBeenCalledTimes(8);
  });

  it('emits typed events', () => {
    const { win, doc } = mkEnv();
    const t = new ApplicationTracker({ window: win, document: doc });
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
    const onlyWin = new ApplicationTracker({ window: win });
    onlyWin.on('online', () => {})();
    const onlyDoc = new ApplicationTracker({ document: doc });
    onlyDoc.on('visibility', () => {});
    expect(doc.count('visibilitychange')).toBe(1);
    expect(() => new ApplicationTracker({}).on('online', () => {})()).not.toThrow();
  });

  it('a missing visibilityState emits NO visibility (it would fabricate a hide)', () => {
    const win = mkTarget();
    const doc = mkTarget();
    const t = new ApplicationTracker({ window: win, document: doc });
    const seen: unknown[] = [];
    t.on('visibility', (e) => seen.push(e));
    doc.fire('visibilitychange');
    expect(seen).toEqual([]);
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
    const t = new ApplicationTracker({ window: win, document: doc }, onError);
    t.on('visibility', () => {});
    expect(() => doc.fire('visibilitychange')).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(2); // the activation read + the event read, each reported once
  });

  it('a throwing addEventListener is reported and what attached is still released', () => {
    const win = mkTarget();
    const onError = vi.fn();
    const doc = mkTarget();
    doc.addEventListener = () => {
      throw new Error('detached');
    };
    const t = new ApplicationTracker({ window: win, document: doc }, onError);
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
    const t = new ApplicationTracker({ window: win, document: doc });
    const off = t.on('online', () => {});
    expect(() => off()).not.toThrow();
    expect(win.count()).toBe(0);
  });

  it('tolerates targets without addEventListener', () => {
    const t = new ApplicationTracker({
      window: {} as never,
      document: { visibilityState: 'visible' } as never,
    });
    expect(() => t.on('online', () => {})()).not.toThrow();
  });

  it('a throwing consumer is reported and the other consumers still receive the event', () => {
    const { win, doc } = mkEnv();
    const onError = vi.fn();
    const t = new ApplicationTracker({ window: win, document: doc }, onError);
    const seen: string[] = [];
    t.on('online', () => {
      throw new Error('consumer');
    });
    t.on('online', () => seen.push('second'));
    expect(() => win.fire('online')).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(['second']);
  });

  it('a throwing onError never escapes: not from a failed read, a throwing consumer, or a failed attach', () => {
    const onError = vi.fn(() => {
      throw new Error('reporter');
    });
    const win = mkTarget();
    const doc = mkTarget();
    Object.defineProperty(doc, 'visibilityState', {
      get(): never {
        throw new Error('getter');
      },
    });
    const t = new ApplicationTracker({ window: win, document: doc }, onError);
    t.on('online', () => {
      throw new Error('consumer');
    });
    t.on('visibility', () => {});
    expect(() => doc.fire('visibilitychange')).not.toThrow();
    expect(() => win.fire('online')).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(3); // activation read, event read, throwing consumer

    const bad = mkTarget();
    bad.addEventListener = () => {
      throw new Error('detached');
    };
    const t2 = new ApplicationTracker({ window: bad }, onError);
    expect(() => t2.on('online', () => {})).not.toThrow();
  });
});

describe('ApplicationTracker: aggregated state', () => {
  const states = (t: ApplicationTracker) => {
    const seen: unknown[] = [];
    t.on('state', (e) => seen.push(e.state));
    return seen;
  };

  it('current() answers before any event, from the document, without subscribing or attaching', () => {
    const { win, doc } = mkEnv();
    const t = new ApplicationTracker({ window: win, document: doc });
    expect(t.current()).toBe('foreground');
    doc.visibilityState = 'hidden';
    expect(t.current()).toBe('background');
    doc.visibilityState = 'prerender';
    expect(t.current()).toBe('background');
    expect(win.count() + doc.count()).toBe(0);
  });

  it('current() is undefined with no document, and keeps the last known value when the document becomes unreadable', () => {
    expect(new ApplicationTracker({ window: mkTarget() }).current()).toBeUndefined();
    const doc = Object.assign(mkTarget(), { visibilityState: 'hidden' as string | undefined });
    const t = new ApplicationTracker({ document: doc });
    t.on('visibility', () => {}); // activation retains 'background'
    doc.visibilityState = undefined;
    expect(t.current()).toBe('background');
  });

  it('emits `state` on a visibility change that changes it, and de-duplicates repeats', () => {
    const { win, doc } = mkEnv();
    const t = new ApplicationTracker({ window: win, document: doc });
    const seen = states(t);
    const visibility: boolean[] = [];
    t.on('visibility', (e) => visibility.push(e.visible));
    for (const v of ['hidden', 'hidden', 'visible', 'visible', 'prerender']) {
      doc.visibilityState = v;
      doc.fire('visibilitychange');
    }
    expect(seen).toEqual(['background', 'foreground', 'background']);
    expect(visibility).toEqual([false, false, true, true, false]); // `visibility` itself is never de-duplicated
  });

  it('the first change after activation is compared against the document state at activation', () => {
    const { win, doc } = mkEnv();
    const t = new ApplicationTracker({ window: win, document: doc });
    const seen = states(t); // activation retains 'foreground'
    doc.fire('visibilitychange'); // still visible: no change
    expect(seen).toEqual([]);
  });

  it('an unreadable document emits neither state nor visibility (never a fabricated background)', () => {
    const doc = mkTarget(); // no visibilityState
    const t = new ApplicationTracker({ document: doc });
    const seen = states(t);
    const visibility: unknown[] = [];
    t.on('visibility', (e) => visibility.push(e));
    doc.fire('visibilitychange');
    expect(seen).toEqual([]);
    expect(visibility).toEqual([]);
  });

  it('a document that becomes unreadable after a known state emits no state and keeps the retained one', () => {
    const doc = Object.assign(mkTarget(), { visibilityState: 'visible' as string | undefined });
    const t = new ApplicationTracker({ document: doc });
    const seen = states(t);
    doc.visibilityState = undefined;
    doc.fire('visibilitychange');
    expect(seen).toEqual([]);
    expect(t.current()).toBe('foreground');
  });

  it('a non-string visibilityState (null/number) is unreadable, not a background', () => {
    const doc = Object.assign(mkTarget(), {
      visibilityState: null as unknown as string | undefined,
    });
    const t = new ApplicationTracker({ document: doc });
    expect(t.current()).toBeUndefined();
    doc.visibilityState = 0 as unknown as string;
    expect(t.current()).toBeUndefined();
  });

  it('retention: listeners detach on the last unsubscribe, the state survives, and the first subscriber after the gap is correct at once', () => {
    const { win, doc } = mkEnv();
    const t = new ApplicationTracker({ window: win, document: doc });
    const offFirst = t.on('state', () => {});
    expect(doc.count('visibilitychange')).toBe(1);
    offFirst();
    expect(win.count() + doc.count()).toBe(0);
    doc.visibilityState = 'hidden'; // happens while NOBODY listens
    expect(t.current()).toBe('background');
    const seen = states(t); // re-activation recomputes the baseline silently
    expect(seen).toEqual([]);
    doc.visibilityState = 'visible';
    doc.fire('visibilitychange');
    expect(seen).toEqual(['foreground']); // not swallowed by a stale baseline
  });

  it('retention: the state is kept across the gap even when the document cannot be read at re-activation', () => {
    const doc = Object.assign(mkTarget(), { visibilityState: 'hidden' as string | undefined });
    const t = new ApplicationTracker({ document: doc });
    t.on('state', () => {})();
    doc.visibilityState = undefined;
    const seen = states(t);
    doc.visibilityState = 'hidden';
    doc.fire('visibilitychange'); // same as the retained background: no emission
    expect(seen).toEqual([]);
  });

  it('a hostile pagehide event (throwing `persisted` getter) is reported, never thrown into dispatch', () => {
    const { win, doc } = mkEnv();
    const onError = vi.fn();
    const t = new ApplicationTracker({ window: win, document: doc }, onError);
    const seen: unknown[] = [];
    t.on('pagehide', (e) => seen.push(e));
    const hostile = {};
    Object.defineProperty(hostile, 'persisted', {
      get(): never {
        throw new Error('persisted');
      },
    });
    expect(() => win.fire('pagehide', hostile)).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([]);
  });

  it('a throwing visibilityState getter is reported on every read path and never thrown', () => {
    const doc = mkTarget();
    Object.defineProperty(doc, 'visibilityState', {
      get(): never {
        throw new Error('getter');
      },
    });
    const onError = vi.fn();
    const t = new ApplicationTracker({ document: doc }, onError);
    expect(t.current()).toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('reset() detaches, drops subscribers (a later event reaches nobody) and forgets the retained state', () => {
    const { win, doc } = mkEnv();
    const t = new ApplicationTracker({ window: win, document: doc });
    const seen = states(t);
    const online = vi.fn();
    t.on('online', online);
    t.reset();
    expect(win.count() + doc.count()).toBe(0);
    doc.visibilityState = 'hidden';
    doc.fire('visibilitychange');
    win.fire('online');
    expect(seen).toEqual([]);
    expect(online).not.toHaveBeenCalled();
    // subscribing again re-attaches and works
    const again = states(t);
    doc.visibilityState = 'visible';
    doc.fire('visibilitychange');
    expect(again).toEqual(['foreground']);
    const doc2 = Object.assign(mkTarget(), { visibilityState: 'hidden' as string | undefined });
    const t2 = new ApplicationTracker({ document: doc2 });
    t2.on('state', () => {});
    doc2.visibilityState = undefined;
    expect(t2.current()).toBe('background');
    t2.reset();
    expect(t2.current()).toBeUndefined();
  });
});

describe('applicationTrackerFor (singleton per key)', () => {
  it('returns the SAME instance for the same document, whichever window is passed (latest request wins)', () => {
    const { win, doc } = mkEnv();
    const a = applicationTrackerFor({ window: win, document: doc });
    expect(applicationTrackerFor({ window: win, document: doc })).toBe(a);
    expect(applicationTrackerFor({ window: mkTarget(), document: doc })).toBe(a);
    expect(applicationTrackerFor({ document: doc })).toBe(a);
    resetApplicationTracker({ document: doc });
  });

  it('keys by the window when there is no document, and distinct keys get distinct instances', () => {
    const w1 = mkTarget();
    const w2 = mkTarget();
    const a = applicationTrackerFor({ window: w1 });
    expect(applicationTrackerFor({ window: w1 })).toBe(a);
    expect(applicationTrackerFor({ window: w2 })).not.toBe(a);
    const d = mkEnv().doc;
    expect(applicationTrackerFor({ window: w1, document: d })).not.toBe(a); // the document is the key when given
    resetApplicationTracker({ window: w1 });
    resetApplicationTracker({ window: w2 });
    resetApplicationTracker({ document: d });
  });

  it('an env with neither shares one instance', () => {
    const a = applicationTrackerFor({});
    expect(applicationTrackerFor({})).toBe(a);
    resetApplicationTracker({});
  });

  it("latest launch wins: a relaunch's onError replaces the reporter; one without onError keeps it", () => {
    const { win, doc } = mkEnv();
    const a = vi.fn();
    const b = vi.fn();
    const t = applicationTrackerFor({ window: win, document: doc }, a);
    const off = t.on('online', () => {
      throw new Error('x');
    });
    win.fire('online');
    expect(a).toHaveBeenCalledTimes(1);
    off();
    expect(applicationTrackerFor({ window: win, document: doc }, b)).toBe(t);
    t.on('online', () => {
      throw new Error('y');
    });
    win.fire('online');
    expect(b).toHaveBeenCalledTimes(1);
    expect(a).toHaveBeenCalledTimes(1);
    applicationTrackerFor({ window: win, document: doc }); // no onError: keeps b
    win.fire('online');
    expect(b).toHaveBeenCalledTimes(2);
    resetApplicationTracker({ document: doc });
  });

  it('while IDLE a new request re-binds the window, so the tracker listens on the new one', () => {
    const w1 = mkTarget();
    const w2 = mkTarget();
    const doc = mkEnv().doc;
    const t = applicationTrackerFor({ window: w1, document: doc });
    t.on('online', () => {})();
    expect(applicationTrackerFor({ window: w2, document: doc })).toBe(t);
    const seen: string[] = [];
    t.on('online', () => seen.push('online'));
    expect(w1.count()).toBe(0);
    expect(w2.count('online')).toBe(1);
    w2.fire('online');
    expect(seen).toEqual(['online']);
    resetApplicationTracker({ document: doc });
  });

  it('while ACTIVE the binding is kept and a different window is reported once', () => {
    const w1 = mkTarget();
    const w2 = mkTarget();
    const doc = mkEnv().doc;
    const t = applicationTrackerFor({ window: w1, document: doc });
    t.on('online', () => {});
    const onError = vi.fn();
    applicationTrackerFor({ window: w2, document: doc }, onError);
    applicationTrackerFor({ window: w2, document: doc }, onError);
    expect(w2.count()).toBe(0);
    expect(w1.count('online')).toBe(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(String((onError.mock.calls[0]?.[0] as Error).message)).toContain('already bound');
    applicationTrackerFor({ window: w1, document: doc }, onError); // the same binding is not a mismatch
    expect(onError).toHaveBeenCalledTimes(1);
    resetApplicationTracker({ document: doc });
  });

  it('a differing document while active is also a mismatch', () => {
    const w = mkTarget();
    const d1 = mkEnv().doc;
    const onError = vi.fn();
    const t = new ApplicationTracker({ window: w, document: d1 }, onError);
    t.on('online', () => {});
    t.rebind({ window: w, document: mkEnv().doc });
    expect(onError).toHaveBeenCalledTimes(1);
    t.rebind({ window: w, document: d1 });
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('an idle rebind with a partial env keeps the targets it does not supply (merge, never drop)', () => {
    const w1 = mkTarget();
    const w2 = mkTarget();
    const d1 = mkEnv().doc;
    const d2 = mkEnv().doc;
    const t = new ApplicationTracker({ window: w1, document: d1 });
    t.rebind({ window: w2 }); // no document supplied: d1 stays
    let off = t.on('online', () => {});
    expect(w2.count('online')).toBe(1);
    expect(w1.count('online')).toBe(0);
    expect(d1.count('visibilitychange')).toBe(1);
    off();
    t.rebind({ document: d2 }); // no window supplied: w2 stays
    off = t.on('online', () => {});
    expect(w2.count('online')).toBe(1);
    expect(d2.count('visibilitychange')).toBe(1);
    expect(d1.count('visibilitychange')).toBe(0);
    off();
  });

  it('the mismatch is reported again after an idle gap (a fresh activation)', () => {
    const w1 = mkTarget();
    const w2 = mkTarget();
    const doc = mkEnv().doc;
    const onError = vi.fn();
    const t = applicationTrackerFor({ window: w1, document: doc }, onError);
    let off = t.on('online', () => {});
    applicationTrackerFor({ window: w2, document: doc });
    expect(onError).toHaveBeenCalledTimes(1);
    off();
    applicationTrackerFor({ window: w1, document: doc }); // idle: rebinds w1
    off = t.on('online', () => {});
    applicationTrackerFor({ window: w2, document: doc });
    expect(onError).toHaveBeenCalledTimes(2);
    resetApplicationTracker({ document: doc });
  });

  it('resetApplicationTracker detaches the old instance and the next request builds a fresh one', () => {
    const { win, doc } = mkEnv();
    const a = applicationTrackerFor({ window: win, document: doc });
    a.on('online', () => {});
    expect(win.count()).toBe(4);
    resetApplicationTracker({ window: win, document: doc });
    expect(win.count() + doc.count()).toBe(0);
    expect(applicationTrackerFor({ window: win, document: doc })).not.toBe(a);
    resetApplicationTracker({ document: doc });
  });
});
