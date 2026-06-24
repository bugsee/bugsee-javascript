import type { Bugsee } from '@bugsee/browser';
import { describe, expect, it, vi } from 'vitest';
import { startSvelteRenderSpan } from './render-span';

// A fake client whose ext('performance').getActiveSpan() returns a span recording child spans.
function fakeActive() {
  const recordChildSpan = vi.fn();
  const client = {
    ext: (name: string) =>
      name === 'performance' ? { getActiveSpan: () => ({ recordChildSpan }) } : undefined,
  } as unknown as Bugsee;
  return { client, recordChildSpan };
}

describe('startSvelteRenderSpan', () => {
  it('captures the start at call time (init) and the end when the returned fn runs (mount)', () => {
    const { client, recordChildSpan } = fakeActive();
    let t = 700;
    // a mutable clock distinguishes "start captured at call" (700) from "start captured at mount" (760)
    const onMounted = startSvelteRenderSpan('UserCard', { getClient: () => client, now: () => t });
    expect(recordChildSpan).not.toHaveBeenCalled(); // nothing recorded until mount
    t = 760; // time passes between component init and the DOM mount
    onMounted(); // the preprocessor passes this to svelte's onMount
    expect(recordChildSpan).toHaveBeenCalledTimes(1);
    const [op, opts] = recordChildSpan.mock.calls[0] as [string, Record<string, unknown>];
    expect(op).toBe('ui.render');
    expect(opts.description).toBe('UserCard');
    expect(opts.startTimestampMs).toBe(700); // captured at startSvelteRenderSpan() call, NOT at mount
    expect(opts.endTimestampMs).toBe(760); // captured when the returned fn runs
    expect(opts.attributes).toMatchObject({
      'ui.render_phase': 'mount',
      'ui.render_duration_ms': 60,
    });
  });

  it('composes the default clock as performance.timeOrigin + performance.now() (epoch ms)', () => {
    const { client, recordChildSpan } = fakeActive();
    let n = 0;
    vi.stubGlobal('performance', { timeOrigin: 1000, now: () => [5, 8][n++] });
    try {
      startSvelteRenderSpan('Clock', { getClient: () => client })(); // start 1005, end 1008
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

  it('falls back to 0 timestamps when the performance clock is unavailable', () => {
    const { client, recordChildSpan } = fakeActive();
    vi.stubGlobal('performance', {});
    try {
      startSvelteRenderSpan('NoPerf', { getClient: () => client })();
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

  it('is a no-op when no transaction is active / no SDK (does not throw)', () => {
    expect(() => startSvelteRenderSpan('X', { getClient: () => undefined })()).not.toThrow();
  });
});
