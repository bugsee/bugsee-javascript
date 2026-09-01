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

  it('falls back to a live Date.now()-anchored clock when there is NO performance global at all', () => {
    // The test below stubs `performance` to `{}` — PRESENT but empty — which exercises only the fallback
    // path, never the `perf?.` guards. The preprocessor injects `startSvelteRenderSpan()` at the top of
    // EVERY component's script with no containment around it, so in an environment without a `performance`
    // global (SvelteKit's SSR/prerender pass) a missing guard throws during component init and fails the
    // render outright. That is the case this pins. The clock degrades to Date.now() (a real, if less
    // precise, epoch reading), NOT the pre-fix literal 0 — a 0 timestamp would mis-anchor this span ~1970,
    // decades before the real-epoch transaction it nests inside.
    const { client, recordChildSpan } = fakeActive();
    vi.stubGlobal('performance', undefined);
    const before = Date.now();
    try {
      let onMounted!: () => void;
      expect(() => {
        onMounted = startSvelteRenderSpan('NoPerfGlobal', { getClient: () => client });
      }).not.toThrow(); // component init is unguarded — a throw here fails the render
      expect(() => onMounted()).not.toThrow();
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
    vi.stubGlobal('performance', {});
    const before = Date.now();
    try {
      startSvelteRenderSpan('NoPerf', { getClient: () => client })();
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
    // A CONSTANT `now()`: `defaultNow()` reads `perf.now()` twice per call — once for the relative-now
    // term, once inside `resolveTimeOrigin`'s reconstruction — so a constant reading keeps the arithmetic
    // independent of call count.
    const { client, recordChildSpan } = fakeActive();
    vi.stubGlobal('performance', { timeOrigin: NaN, now: () => 8 });
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    try {
      const onMounted = startSvelteRenderSpan('NanOrigin', { getClient: () => client });
      onMounted();
      const opts = recordChildSpan.mock.calls[0]?.[1] as {
        startTimestampMs: number;
        endTimestampMs: number;
      };
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
      startSvelteRenderSpan('BadCast', { getClient: () => client })();
      const opts = recordChildSpan.mock.calls[0]?.[1] as { startTimestampMs: number };
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
      startSvelteRenderSpan('ZeroOrigin', { getClient: () => client })();
      const opts = recordChildSpan.mock.calls[0]?.[1] as { startTimestampMs: number };
      expect(opts.startTimestampMs).toBe(2_000_000); // NOT 0 + 3
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('is a no-op when no transaction is active / no SDK (does not throw)', () => {
    expect(() => startSvelteRenderSpan('X', { getClient: () => undefined })()).not.toThrow();
  });
});
