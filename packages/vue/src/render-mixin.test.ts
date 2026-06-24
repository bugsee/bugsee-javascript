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

  it('falls back to 0 timestamps when the performance clock is unavailable', () => {
    const { client, recordChildSpan } = fakeActive();
    vi.stubGlobal('performance', {}); // no now / no timeOrigin
    try {
      const m = createBugseeVueRenderMixin({ getClient: () => client });
      const i = inst({ $options: { name: 'NoPerf' } });
      m.beforeMount.call(i);
      m.mounted.call(i);
      const opts = recordChildSpan.mock.calls[0]?.[1] as Record<string, number>;
      expect(opts.startTimestampMs).toBe(0);
      expect(opts.endTimestampMs).toBe(0);
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
});
