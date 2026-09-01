import type { Bugsee } from '@bugsee/browser';
import { describe, expect, it, vi } from 'vitest';
import { createBugseeVueRenderMixin, type VueRenderInstanceLike } from './render-mixin';

// A fake client whose ext('performance').getActiveSpan() returns a span recording child spans.
function fakeActive() {
  const recordChildSpan = vi.fn();
  const client = {
    ext: (name: string) =>
      name === 'performance' ? { getActiveSpan: () => ({ recordChildSpan }) } : undefined,
  } as unknown as Bugsee;
  return { client, recordChildSpan };
}

const inst = (over: Record<string, unknown>): VueRenderInstanceLike =>
  over as VueRenderInstanceLike;
// A monotonic epoch-ms clock returning the given readings in order (begin, end, begin, end, …).
const clock = (...readings: number[]) => {
  let i = 0;
  return () => readings[i++] ?? 0;
};

describe('createBugseeVueRenderMixin', () => {
  it('returns a mixin with the four render lifecycle hooks', () => {
    const m = createBugseeVueRenderMixin();
    expect(typeof m.beforeMount).toBe('function');
    expect(typeof m.mounted).toBe('function');
    expect(typeof m.beforeUpdate).toBe('function');
    expect(typeof m.updated).toBe('function');
  });

  it('records a `mount` ui.render span bracketing beforeMount→mounted', () => {
    const { client, recordChildSpan } = fakeActive();
    const m = createBugseeVueRenderMixin({ getClient: () => client, now: clock(1000, 1015) });
    const i = inst({ $options: { name: 'UserCard' } });
    m.beforeMount.call(i);
    m.mounted.call(i);
    expect(recordChildSpan).toHaveBeenCalledTimes(1);
    const [op, opts] = recordChildSpan.mock.calls[0] as [string, Record<string, unknown>];
    expect(op).toBe('ui.render');
    expect(opts.description).toBe('UserCard');
    expect(opts.startTimestampMs).toBe(1000);
    expect(opts.endTimestampMs).toBe(1015);
    expect(opts.attributes).toMatchObject({
      'ui.render_phase': 'mount',
      'ui.render_duration_ms': 15,
    });
  });

  it('records an `update` ui.render span bracketing beforeUpdate→updated', () => {
    const { client, recordChildSpan } = fakeActive();
    const m = createBugseeVueRenderMixin({ getClient: () => client, now: clock(2000, 2008) });
    const i = inst({ $: { type: { __name: 'Dashboard' } } });
    m.beforeUpdate.call(i);
    m.updated.call(i);
    const opts = recordChildSpan.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(opts.description).toBe('Dashboard');
    expect(opts.attributes).toMatchObject({
      'ui.render_phase': 'update',
      'ui.render_duration_ms': 8,
    });
  });

  it('does not record a span for a nameless component', () => {
    const { client, recordChildSpan } = fakeActive();
    const m = createBugseeVueRenderMixin({ getClient: () => client, now: clock(1, 2) });
    const i = inst({ $options: {} });
    m.beforeMount.call(i);
    m.mounted.call(i);
    expect(recordChildSpan).not.toHaveBeenCalled();
  });

  it('records nothing when the after-hook fires with no matching begin (no start captured)', () => {
    const { client, recordChildSpan } = fakeActive();
    const m = createBugseeVueRenderMixin({ getClient: () => client, now: clock(1, 2) });
    m.mounted.call(inst({ $options: { name: 'X' } })); // mounted with no prior beforeMount
    expect(recordChildSpan).not.toHaveBeenCalled();
  });

  it('skips a render faster than minDurationMs (volume control)', () => {
    const { client, recordChildSpan } = fakeActive();
    const m = createBugseeVueRenderMixin({
      getClient: () => client,
      now: clock(100, 103), // 3ms render
      minDurationMs: 5,
    });
    const i = inst({ $options: { name: 'Fast' } });
    m.beforeMount.call(i);
    m.mounted.call(i);
    expect(recordChildSpan).not.toHaveBeenCalled();
    // a render at/over the threshold IS recorded
    const m2 = createBugseeVueRenderMixin({
      getClient: () => client,
      now: clock(0, 5),
      minDurationMs: 5,
    });
    const j = inst({ $options: { name: 'Slow' } });
    m2.beforeMount.call(j);
    m2.mounted.call(j);
    expect(recordChildSpan).toHaveBeenCalledTimes(1);
  });

  it('tracks two component instances independently (per-instance start times)', () => {
    const { client, recordChildSpan } = fakeActive();
    const m = createBugseeVueRenderMixin({ getClient: () => client, now: clock(10, 20, 30, 90) });
    const a = inst({ $options: { name: 'A' } });
    const b = inst({ $options: { name: 'B' } });
    // interleaved: A begins, B begins, A ends, B ends (parent/child mount ordering)
    m.beforeMount.call(a); // 10
    m.beforeMount.call(b); // 20
    m.mounted.call(a); // 30 → A: 10..30
    m.mounted.call(b); // 90 → B: 20..90
    const calls = recordChildSpan.mock.calls.map((c) => c[1] as Record<string, unknown>);
    expect(calls[0]).toMatchObject({ description: 'A', startTimestampMs: 10, endTimestampMs: 30 });
    expect(calls[1]).toMatchObject({ description: 'B', startTimestampMs: 20, endTimestampMs: 90 });
  });

  it('uses the global performance clock by default (timeOrigin + now)', () => {
    const { client, recordChildSpan } = fakeActive();
    const m = createBugseeVueRenderMixin({ getClient: () => client }); // no `now` → the real defaultNow
    const i = inst({ $options: { name: 'Real' } });
    m.beforeMount.call(i);
    m.mounted.call(i);
    expect(recordChildSpan).toHaveBeenCalledTimes(1);
    const opts = recordChildSpan.mock.calls[0]?.[1] as {
      startTimestampMs: number;
      endTimestampMs: number;
    };
    expect(typeof opts.startTimestampMs).toBe('number');
    expect(opts.endTimestampMs).toBeGreaterThanOrEqual(opts.startTimestampMs);
  });

  it('composes the default clock as performance.timeOrigin + performance.now() (epoch ms)', () => {
    const { client, recordChildSpan } = fakeActive();
    let n = 0;
    vi.stubGlobal('performance', { timeOrigin: 1000, now: () => [5, 8][n++] });
    try {
      const m = createBugseeVueRenderMixin({ getClient: () => client });
      const i = inst({ $options: { name: 'Clock' } });
      m.beforeMount.call(i); // 1000 + 5
      m.mounted.call(i); // 1000 + 8
      const opts = recordChildSpan.mock.calls[0]?.[1] as {
        startTimestampMs: number;
        endTimestampMs: number;
      };
      expect(opts.startTimestampMs).toBe(1005); // pins the timeOrigin term
      expect(opts.endTimestampMs).toBe(1008); // pins the now() term
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('falls back to a live Date.now()-anchored clock when the performance clock is unavailable', () => {
    const { client, recordChildSpan } = fakeActive();
    vi.stubGlobal('performance', {}); // no now / no timeOrigin
    const before = Date.now();
    try {
      const m = createBugseeVueRenderMixin({ getClient: () => client });
      const i = inst({ $options: { name: 'NoPerf' } });
      m.beforeMount.call(i);
      m.mounted.call(i);
      const after = Date.now();
      const opts = recordChildSpan.mock.calls[0]?.[1] as Record<string, number>;
      expect(opts.startTimestampMs).toBeGreaterThanOrEqual(before);
      expect(opts.startTimestampMs).toBeLessThanOrEqual(after);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('falls back when performance.timeOrigin is NaN (typeof NaN === "number")', () => {
    // A CONSTANT `now()`: `defaultNow()` reads `perf.now()` twice per call — once for the relative-now
    // term, once inside `resolveTimeOrigin`'s reconstruction — so a constant reading keeps the arithmetic
    // independent of call count.
    const { client, recordChildSpan } = fakeActive();
    vi.stubGlobal('performance', { timeOrigin: NaN, now: () => 8 });
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    try {
      const m = createBugseeVueRenderMixin({ getClient: () => client });
      const i = inst({ $options: { name: 'NanOrigin' } });
      m.beforeMount.call(i);
      m.mounted.call(i);
      const opts = recordChildSpan.mock.calls[0]?.[1] as Record<string, number>;
      expect(opts.startTimestampMs).toBe(1_000_000); // 8 + (1_000_000 - 8)
      expect(opts.endTimestampMs).toBe(1_000_000);
      expect(Number.isNaN(opts.startTimestampMs)).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('falls back when performance.timeOrigin is a non-number arriving through an unchecked cast', () => {
    const { client, recordChildSpan } = fakeActive();
    vi.stubGlobal('performance', { timeOrigin: 'nope' as unknown as number, now: () => 3 });
    vi.spyOn(Date, 'now').mockReturnValue(2_000_000);
    try {
      const m = createBugseeVueRenderMixin({ getClient: () => client });
      const i = inst({ $options: { name: 'BadCast' } });
      m.beforeMount.call(i);
      m.mounted.call(i);
      const opts = recordChildSpan.mock.calls[0]?.[1] as Record<string, number>;
      expect(opts.startTimestampMs).toBe(2_000_000);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('falls back when performance.timeOrigin is a literal 0 (not a real epoch anchor)', () => {
    const { client, recordChildSpan } = fakeActive();
    vi.stubGlobal('performance', { timeOrigin: 0, now: () => 3 });
    vi.spyOn(Date, 'now').mockReturnValue(2_000_000);
    try {
      const m = createBugseeVueRenderMixin({ getClient: () => client });
      const i = inst({ $options: { name: 'ZeroOrigin' } });
      m.beforeMount.call(i);
      m.mounted.call(i);
      const opts = recordChildSpan.mock.calls[0]?.[1] as Record<string, number>;
      expect(opts.startTimestampMs).toBe(2_000_000); // NOT 0 + 3
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('is observe-only — a throwing $options getter never breaks the lifecycle hook', () => {
    const { client } = fakeActive();
    const m = createBugseeVueRenderMixin({ getClient: () => client, now: clock(1, 2) });
    const hostile = {
      get $options(): { name?: unknown } {
        throw new Error('hostile');
      },
    } as VueRenderInstanceLike;
    m.beforeMount.call(hostile); // begin() only stamps the clock — it never reads $options
    expect(() => m.mounted.call(hostile)).not.toThrow(); // end() reads the name → throws → swallowed
  });

  it('deletes the start BEFORE the name-read, so a stale start cannot leak into a later after-hook', () => {
    const { client, recordChildSpan } = fakeActive();
    const m = createBugseeVueRenderMixin({ getClient: () => client, now: clock(1, 2, 3) });
    let reads = 0;
    const flaky = {
      get $options(): { name?: unknown } {
        reads += 1;
        if (reads === 1) throw new Error('hostile once'); // throws on the mount read, recovers after
        return { name: 'Recovered' };
      },
    } as VueRenderInstanceLike;
    m.beforeMount.call(flaky);
    expect(() => m.mounted.call(flaky)).not.toThrow(); // name-read throws → swallowed; the start must be gone
    m.updated.call(flaky); // no beforeUpdate → with the start deleted, this is a no-op
    // a lingering stale start would have produced a (wrong, too-early) span here.
    expect(recordChildSpan).not.toHaveBeenCalled();
  });

  it('degrades to a live Date.now() reading — without throwing into Vue — on a host with no `performance`', () => {
    // The default clock is the only part of this mixin that reads a runtime global, and it reads it from
    // `beforeMount`, which is OUTSIDE the try/catch that guards the after-hooks. On a host that has no
    // `performance` (or a partial one), an unguarded read would throw straight out of a Vue lifecycle hook
    // and fail the component's mount — the SDK breaking the app, which the binding rule forbids. The clock
    // degrades to Date.now() (a real, if less precise, epoch reading), NOT the pre-fix literal 0 — a 0
    // timestamp would mis-anchor this span ~1970, decades before the real-epoch transaction it nests in.
    const { client, recordChildSpan } = fakeActive();
    const m = createBugseeVueRenderMixin({ getClient: () => client }); // no injected clock → the default
    const i = inst({ $options: { name: 'UserCard' } });
    vi.stubGlobal('performance', undefined);
    const before = Date.now();
    try {
      expect(() => m.beforeMount.call(i)).not.toThrow();
      expect(() => m.mounted.call(i)).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
    const after = Date.now();
    expect(recordChildSpan).toHaveBeenCalledTimes(1);
    const [, opts] = recordChildSpan.mock.calls[0] as [string, Record<string, unknown>];
    expect(opts.startTimestampMs as number).toBeGreaterThanOrEqual(before);
    expect(opts.startTimestampMs as number).toBeLessThanOrEqual(after);
    expect(opts.endTimestampMs as number).toBeGreaterThanOrEqual(opts.startTimestampMs as number);
  });
});
