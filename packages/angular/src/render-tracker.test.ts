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

  it('falls back to 0 timestamps when the performance clock is unavailable', () => {
    const { client, recordChildSpan } = fakeActive();
    vi.stubGlobal('performance', {}); // no now / no timeOrigin
    try {
      const t = createBugseeRenderTracker('NoPerf', { getClient: () => client });
      t.start();
      t.end();
      const opts = recordChildSpan.mock.calls[0]?.[1] as {
        startTimestampMs: number;
        endTimestampMs: number;
      };
      expect(opts.startTimestampMs).toBe(0);
      expect(opts.endTimestampMs).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
