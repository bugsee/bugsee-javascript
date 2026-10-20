import { describe, expect, it, vi } from 'vitest';
import { bindAll, ElectronStageTracker, isReleasable, reportTo } from './stage-tracker';

type L = (...a: unknown[]) => void;
function emitter() {
  const table = new Map<string, L[]>();
  return {
    table,
    on: vi.fn((e: string, l: L) => {
      table.set(e, [...(table.get(e) ?? []), l]);
    }),
    removeListener: vi.fn((e: string, l: L) => {
      table.set(
        e,
        (table.get(e) ?? []).filter((x) => x !== l),
      );
    }),
    fire: (e: string, ...a: unknown[]) => {
      for (const l of [...(table.get(e) ?? [])]) l(...a);
    },
    count: (e: string) => table.get(e)?.length ?? 0,
  };
}

describe('reportTo', () => {
  it('delivers the error to the reporter', () => {
    const fn = vi.fn();
    reportTo({ fn }, new Error('x'));
    expect(fn).toHaveBeenCalledOnce();
  });
  it('absorbs a throwing reporter, a rejecting reporter and a missing one', async () => {
    expect(() =>
      reportTo(
        {
          fn: () => {
            throw new Error('r');
          },
        },
        1,
      ),
    ).not.toThrow();
    expect(() => reportTo({ fn: () => Promise.reject(new Error('r')) }, 1)).not.toThrow();
    expect(() => reportTo({ fn: undefined }, 1)).not.toThrow();
    await new Promise((r) => setImmediate(r)); // the rejection was handled: no unhandledrejection
  });
});

const throwingProxy = (message = 'not ready') =>
  new Proxy(
    {},
    {
      get() {
        throw new Error(message);
      },
    },
  );

describe('isReleasable', () => {
  it('a source that throws on property read is NOT releasable, and the read is reported', () => {
    const report = vi.fn();
    expect(isReleasable(throwingProxy('screen'), report)).toBe(false);
    expect(report).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: 'screen' }));
    expect(() => isReleasable(throwingProxy())).not.toThrow(); // no reporter: still silent
  });

  it('needs on AND (removeListener or off)', () => {
    expect(isReleasable(undefined)).toBe(false);
    expect(isReleasable({})).toBe(false);
    expect(isReleasable({ on: () => 0 })).toBe(false);
    expect(isReleasable({ on: () => 0, removeListener: () => 0 })).toBe(true);
    expect(isReleasable({ on: () => 0, off: () => 0 })).toBe(true);
    expect(isReleasable({ removeListener: () => 0 })).toBe(false);
  });
});

describe('bindAll', () => {
  it('a source whose property reads throw: nothing attached, undefined, reported exactly once, never thrown', () => {
    const a = emitter();
    const report = vi.fn();
    const release = bindAll(
      [
        { src: throwingProxy('proxy'), event: 'x', listener: () => {} },
        { src: a, event: 'y', listener: () => {} },
      ],
      report,
    );
    expect(release).toBeUndefined();
    expect(a.on).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: 'proxy' }));
  });

  it('attaches every binding and the release removes the very wrappers it attached', () => {
    const a = emitter();
    const b = emitter();
    const seen = vi.fn();
    const release = bindAll(
      [
        { src: a, event: 'x', listener: seen },
        { src: b, event: 'y', listener: seen },
      ],
      vi.fn(),
    );
    expect(a.count('x')).toBe(1);
    expect(b.count('y')).toBe(1);
    a.fire('x', 1, 2);
    expect(seen).toHaveBeenCalledWith(1, 2);
    release?.();
    expect(a.count('x')).toBe(0);
    expect(b.count('y')).toBe(0);
  });

  it('uses `off` when there is no removeListener', () => {
    const table: L[] = [];
    const src = {
      on: (_e: string, l: L) => table.push(l),
      off: vi.fn((_e: string, l: L) => table.splice(table.indexOf(l), 1)),
    };
    bindAll([{ src, event: 'x', listener: () => {} }], vi.fn())?.();
    expect(src.off).toHaveBeenCalledOnce();
    expect(table).toHaveLength(0);
  });

  it('attaches nothing, silently, when any source cannot be released', () => {
    const a = emitter();
    const report = vi.fn();
    const release = bindAll(
      [
        { src: a, event: 'x', listener: () => {} },
        { src: { on: () => 0 }, event: 'y', listener: () => {} },
      ],
      report,
    );
    expect(release).toBeUndefined();
    expect(a.on).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
  });

  it('is all-or-nothing: a throwing attach rolls back the earlier ones and reports', () => {
    const a = emitter();
    const bad = {
      on: () => {
        throw new Error('attach');
      },
      removeListener: () => {},
    };
    const report = vi.fn();
    const release = bindAll(
      [
        { src: a, event: 'x', listener: () => {} },
        { src: bad, event: 'y', listener: () => {} },
      ],
      report,
    );
    expect(release).toBeUndefined();
    expect(a.count('x')).toBe(0);
    expect(report).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: 'attach' }));
  });

  it('a failing removal is reported and does not strand the others; a wrapper whose removal failed never fires again', () => {
    const a = emitter();
    const stuck = {
      on: vi.fn(),
      removeListener: () => {
        throw new Error('remove');
      },
    };
    const report = vi.fn();
    const seen = vi.fn();
    const release = bindAll(
      [
        { src: stuck, event: 'y', listener: seen },
        { src: a, event: 'x', listener: seen },
      ],
      report,
    );
    release?.();
    expect(a.count('x')).toBe(0);
    expect(report).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: 'remove' }));
    // the stuck wrapper is still registered on `stuck`, but disarmed
    (stuck.on.mock.calls[0]?.[1] as L)();
    expect(seen).not.toHaveBeenCalled();
  });
});

describe('ElectronStageTracker', () => {
  class T extends ElectronStageTracker<{ a: number; b: number }> {
    readonly name = 't';
    protected readonly stages = ['a', 'b'] as const;
    attached: string[] = [];
    released: string[] = [];
    refuse = new Set<string>();
    throwOnRelease = false;
    protected attachStage(stage: 'a' | 'b') {
      if (this.refuse.has(stage)) return undefined;
      this.attached.push(stage);
      return () => {
        this.released.push(stage);
        if (this.throwOnRelease) throw new Error(`rel-${stage}`);
      };
    }
    rebindReporter(fn?: () => void) {
      this.setReporter(fn);
    }
    syncNow() {
      this.sync();
    }
    dropAll() {
      this.detachAll();
    }
    failReport(e: unknown) {
      this.report(e);
    }
  }

  it('arms a stage on its first listener and releases on its last; other stages stay idle', () => {
    const t = new T();
    const off1 = t.on('a', () => {});
    const off2 = t.on('a', () => {});
    expect(t.attached).toEqual(['a']);
    off1();
    expect(t.released).toEqual([]);
    off2();
    expect(t.released).toEqual(['a']);
    expect(t.attached).toEqual(['a']);
  });

  it('retries a refused stage on the next listener change', () => {
    const t = new T();
    t.refuse.add('a');
    t.on('a', () => {});
    expect(t.attached).toEqual([]);
    t.refuse.clear();
    t.on('b', () => {});
    expect(t.attached).toEqual(['a', 'b']);
  });

  it('detachAll releases every armed stage and sync re-arms them', () => {
    const t = new T();
    t.on('a', () => {});
    t.on('b', () => {});
    t.dropAll();
    expect(t.released.sort()).toEqual(['a', 'b']);
    t.syncNow();
    expect(t.attached).toHaveLength(4);
  });

  it('a throwing release is reported and does not block the next', () => {
    const onError = vi.fn();
    const t = new T(onError);
    t.throwOnRelease = true;
    t.on('a', () => {});
    t.on('b', () => {});
    t.dropAll();
    expect(t.released).toEqual(['a', 'b']);
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it('a stage whose attach THROWS is reported, never thrown at the subscriber, and retried on the next change', () => {
    const onError = vi.fn();
    const t = new T(onError);
    let boom = true;
    const original = (t as unknown as { attachStage: (s: 'a' | 'b') => unknown }).attachStage.bind(
      t,
    );
    (t as unknown as { attachStage: (s: 'a' | 'b') => unknown }).attachStage = (stage) => {
      if (boom) throw new Error('attach');
      return original(stage);
    };
    expect(() => t.on('a', () => {})).not.toThrow();
    expect(onError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: 'attach' }));
    boom = false;
    t.on('b', () => {});
    expect(t.attached).toEqual(['a', 'b']);
  });

  it('reset drops every listener and releases', () => {
    const t = new T();
    t.on('a', () => {});
    t.reset();
    expect(t.released).toEqual(['a']);
  });

  it('a throwing subscriber is isolated to the reporter; setReporter replaces, undefined keeps', () => {
    const first = vi.fn();
    const second = vi.fn();
    const t = new T(first);
    t.rebindReporter(second);
    t.rebindReporter(undefined);
    t.on('a', () => {
      throw new Error('sub');
    });
    t.emit('a', 1);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
    t.failReport(new Error('direct'));
    expect(second).toHaveBeenCalledTimes(2);
  });

  it('a throwing reporter never escapes emit', () => {
    const t = new T(() => {
      throw new Error('r');
    });
    t.on('a', () => {
      throw new Error('sub');
    });
    expect(() => t.emit('a', 1)).not.toThrow();
  });
});
