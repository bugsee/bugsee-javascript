import type { Bugsee } from '@bugsee/browser';
import { describe, expect, it, vi } from 'vitest';
import { createBugseeRenderTracker } from './render-tracker';

// A fake client whose ext('performance').getActiveSpan() returns a span recording child spans.
function fakeActive() {
  const recordChildSpan = vi.fn();
  const client = {
    ext: (name: string) =>
      name === 'performance' ? { getActiveSpan: () => ({ recordChildSpan }) } : undefined,
  } as unknown as Bugsee;
  return { client, recordChildSpan };
}

// A clock returning the given epoch-ms readings in order.
const clock = (...readings: number[]) => {
  let i = 0;
  return () => readings[i++] ?? 0;
};

describe('createBugseeRenderTracker', () => {
  it('returns a tracker with start + end', () => {
    const t = createBugseeRenderTracker('X');
    expect(typeof t.start).toBe('function');
    expect(typeof t.end).toBe('function');
  });

  it('records a `mount` ui.render span from start (ngOnInit) to end (ngAfterViewInit)', () => {
    const { client, recordChildSpan } = fakeActive();
    const t = createBugseeRenderTracker('UserProfile', {
      getClient: () => client,
      now: clock(5000, 5042),
    });
    t.start();
    t.end();
    expect(recordChildSpan).toHaveBeenCalledTimes(1);
    const [op, opts] = recordChildSpan.mock.calls[0] as [string, Record<string, unknown>];
    expect(op).toBe('ui.render');
    expect(opts.description).toBe('UserProfile');
    expect(opts.startTimestampMs).toBe(5000);
    expect(opts.endTimestampMs).toBe(5042);
    expect(opts.attributes).toMatchObject({
      'ui.render_phase': 'mount',
      'ui.render_duration_ms': 42,
    });
  });

  it('records nothing when end() is called without a prior start()', () => {
    const { client, recordChildSpan } = fakeActive();
    const t = createBugseeRenderTracker('X', { getClient: () => client, now: clock(1, 2) });
    t.end();
    expect(recordChildSpan).not.toHaveBeenCalled();
  });

  it('records once and then no-ops on a second end() (start consumed)', () => {
    const { client, recordChildSpan } = fakeActive();
    const t = createBugseeRenderTracker('X', { getClient: () => client, now: clock(10, 20, 30) });
    t.start();
    t.end(); // records 10..20
    t.end(); // no start anymore → no-op
    expect(recordChildSpan).toHaveBeenCalledTimes(1);
  });

  it('tracks separate component instances independently (one tracker each)', () => {
    const { client, recordChildSpan } = fakeActive();
    const a = createBugseeRenderTracker('A', { getClient: () => client, now: clock(1, 4) });
    const b = createBugseeRenderTracker('B', { getClient: () => client, now: clock(2, 9) });
    a.start();
    b.start();
    a.end();
    b.end();
    const calls = recordChildSpan.mock.calls.map((c) => c[1] as Record<string, unknown>);
    expect(calls[0]).toMatchObject({ description: 'A', startTimestampMs: 1, endTimestampMs: 4 });
    expect(calls[1]).toMatchObject({ description: 'B', startTimestampMs: 2, endTimestampMs: 9 });
  });

  it('uses the global performance clock by default (timeOrigin + now)', () => {
    const { client, recordChildSpan } = fakeActive();
    const t = createBugseeRenderTracker('Real', { getClient: () => client }); // no `now` → defaultNow
    t.start();
    t.end();
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
      const t = createBugseeRenderTracker('Clock', { getClient: () => client });
      t.start(); // 1000 + 5
      t.end(); // 1000 + 8
      const opts = recordChildSpan.mock.calls[0]?.[1] as {
        startTimestampMs: number;
        endTimestampMs: number;
        attributes: Record<string, unknown>;
      };
      expect(opts.startTimestampMs).toBe(1005); // pins the timeOrigin term
      expect(opts.endTimestampMs).toBe(1008); // pins the now() term
      expect(opts.attributes['ui.render_duration_ms']).toBe(3);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('falls back to a live Date.now()-anchored clock when there is NO performance global at all', () => {
    // The test below stubs `performance` to `{}` — PRESENT but empty — which never exercises the `perf?.`
    // guards, only the fallback path itself. An environment with no `performance` global (an SSR/prerender
    // pass, a non-browser test host) makes `perf` itself undefined, and `start()` is called straight from
    // `ngOnInit` with NO containment around it — so a missing guard throws out of the component's
    // lifecycle hook and takes the view down. That is the case this pins. The clock degrades to Date.now()
    // (a real, if less precise, epoch reading), NOT the pre-fix literal 0 — a 0 timestamp would mis-anchor
    // this span ~1970, decades before the real-epoch transaction it nests inside.
    const { client, recordChildSpan } = fakeActive();
    vi.stubGlobal('performance', undefined);
    const before = Date.now();
    try {
      const t = createBugseeRenderTracker('NoPerfGlobal', { getClient: () => client });
      expect(() => t.start()).not.toThrow(); // ngOnInit is unguarded — a throw here is fatal to the view
      expect(() => t.end()).not.toThrow();
      const after = Date.now();
      const opts = recordChildSpan.mock.calls[0]?.[1] as {
        startTimestampMs: number;
        endTimestampMs: number;
      };
      expect(recordChildSpan).toHaveBeenCalledTimes(1);
      expect(opts.startTimestampMs).toBeGreaterThanOrEqual(before);
      expect(opts.startTimestampMs).toBeLessThanOrEqual(after);
      expect(opts.endTimestampMs).toBeGreaterThanOrEqual(opts.startTimestampMs);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('falls back to a live Date.now()-anchored clock when the performance clock is unavailable', () => {
    const { client, recordChildSpan } = fakeActive();
    vi.stubGlobal('performance', {}); // no now / no timeOrigin
    const before = Date.now();
    try {
      const t = createBugseeRenderTracker('NoPerf', { getClient: () => client });
      t.start();
      t.end();
      const after = Date.now();
      const opts = recordChildSpan.mock.calls[0]?.[1] as {
        startTimestampMs: number;
        endTimestampMs: number;
      };
      expect(opts.startTimestampMs).toBeGreaterThanOrEqual(before);
      expect(opts.startTimestampMs).toBeLessThanOrEqual(after);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('falls back when performance.timeOrigin is NaN (typeof NaN === "number")', () => {
    // A CONSTANT `now()` (not a sequence): `defaultNow()` reads `perf.now()` twice per call — once for the
    // relative-now term, once inside `resolveTimeOrigin`'s reconstruction — so a constant reading keeps the
    // arithmetic (and thus the expected value) independent of call count.
    const { client, recordChildSpan } = fakeActive();
    vi.stubGlobal('performance', { timeOrigin: NaN, now: () => 8 });
    const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    try {
      const t = createBugseeRenderTracker('NanOrigin', { getClient: () => client });
      t.start(); // 8 + (1_000_000 - 8) = 1_000_000
      t.end(); // same computation, same mocked Date.now()
      const opts = recordChildSpan.mock.calls[0]?.[1] as {
        startTimestampMs: number;
        endTimestampMs: number;
      };
      expect(opts.startTimestampMs).toBe(1_000_000);
      expect(opts.endTimestampMs).toBe(1_000_000);
      expect(Number.isNaN(opts.startTimestampMs)).toBe(false);
      expect(dateNowSpy).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('falls back when performance.timeOrigin is a non-number arriving through an unchecked cast', () => {
    const { client, recordChildSpan } = fakeActive();
    vi.stubGlobal('performance', { timeOrigin: 'nope' as unknown as number, now: () => 3 });
    vi.spyOn(Date, 'now').mockReturnValue(2_000_000);
    try {
      const t = createBugseeRenderTracker('BadCast', { getClient: () => client });
      t.start();
      t.end();
      const opts = recordChildSpan.mock.calls[0]?.[1] as { startTimestampMs: number };
      expect(opts.startTimestampMs).toBe(2_000_000); // (2_000_000 - 3) + 3
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('falls back when performance.timeOrigin is a literal 0 (not a real epoch anchor)', () => {
    const { client, recordChildSpan } = fakeActive();
    vi.stubGlobal('performance', { timeOrigin: 0, now: () => 3 });
    vi.spyOn(Date, 'now').mockReturnValue(2_000_000);
    try {
      const t = createBugseeRenderTracker('ZeroOrigin', { getClient: () => client });
      t.start();
      t.end();
      const opts = recordChildSpan.mock.calls[0]?.[1] as { startTimestampMs: number };
      expect(opts.startTimestampMs).toBe(2_000_000); // NOT 0 + 3
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
