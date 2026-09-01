// @vitest-environment jsdom
import type { Bugsee } from '@bugsee/web-adapter';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BugseeProfiler } from './profiler';

// WAVE 4.6 (decision D4: "make <BugseeProfiler> actually produce spans in PRODUCTION React builds").
//
// React disables `<Profiler>` in a standard production build — it renders children but never calls
// `onRender`. So the component recorded ZERO spans in the build customers ship, and no test could see it,
// because every test in this package called the recording core directly and never rendered anything.
//
// These tests RENDER, through real react-dom, in both worlds:
//   - development: React's Profiler fires, and its own accurate timings are used.
//   - production:  Profiler is inert, and the component's own post-commit measurement takes over.
// The production world is simulated the way React actually behaves — `onRender` simply never fires — by
// rendering a subtree whose Profiler is neutralised, rather than by mocking our own code.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function fakeActive() {
  const recordChildSpan = vi.fn();
  const client = {
    ext: (name: string) =>
      name === 'performance' ? { getActiveSpan: () => ({ recordChildSpan }) } : undefined,
  } as unknown as Bugsee;
  return { client, recordChildSpan };
}

const mount = (element: ReturnType<typeof createElement>) => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  return {
    rerender: (next: ReturnType<typeof createElement>) => {
      act(() => {
        root.render(next);
      });
    },
    cleanup: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
};

const render = (element: ReturnType<typeof createElement>): (() => void) => mount(element).cleanup;

/** The attributes of the n-th recorded span. */
const attrsOf = (spy: ReturnType<typeof vi.fn>, index: number): Record<string, unknown> =>
  (spy.mock.calls[index]?.[1] as { attributes: Record<string, unknown> }).attributes;

const optsOf = (
  spy: ReturnType<typeof vi.fn>,
  index: number,
): { startTimestampMs: number; endTimestampMs: number; description: string } =>
  spy.mock.calls[index]?.[1] as {
    startTimestampMs: number;
    endTimestampMs: number;
    description: string;
  };

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('BugseeProfiler produces spans through a real render', () => {
  it('records a span on mount when React’s Profiler IS live (development)', () => {
    const { client, recordChildSpan } = fakeActive();
    const cleanup = render(
      createElement(
        BugseeProfiler,
        { id: 'Dashboard', getClient: () => client },
        createElement('div', null, 'hi'),
      ),
    );
    expect(recordChildSpan).toHaveBeenCalled();
    const [op] = recordChildSpan.mock.calls[0] as [string];
    expect(op).toBe('ui.render');
    cleanup();
  });

  it('records that span from REACT’s Profiler, not from the fallback measurement', () => {
    // The assertion the test above is missing, and the reason four different mutations of the live path
    // survived the audit: with `onRender` neutralised — or with `<Profiler>` never rendered at all — the
    // post-commit fallback still records a `ui.render` span, so "a span was recorded" says nothing about
    // WHICH path produced it. The fallback marks itself; React's own path must therefore carry no mark,
    // and must carry the id and phase React reported.
    const { client, recordChildSpan } = fakeActive();
    const cleanup = render(
      createElement(
        BugseeProfiler,
        { id: 'Live', getClient: () => client },
        createElement('div', null, 'hi'),
      ),
    );
    expect(recordChildSpan).toHaveBeenCalledTimes(1);
    const attrs = attrsOf(recordChildSpan, 0);
    // not `toBeUndefined()`: the key must be ABSENT, not present-and-undefined — an undefined-valued
    // attribute is not a legal span attribute and would travel into the protocol as one.
    expect(attrs).not.toHaveProperty('ui.render_source');
    expect(attrs['ui.render_phase']).toBe('mount');
    expect(optsOf(recordChildSpan, 0).description).toBe('Live');
    // React reports `baseDuration` (cost without memoization) separately from `actualDuration`; the
    // fallback has no such number and reports the same value for both.
    expect(typeof attrs['ui.render_base_duration_ms']).toBe('number');
    cleanup();
  });

  it('records EXACTLY ONE span per commit — no double-report when Profiler is live', () => {
    // The fallback must stand down when React already reported. Double-counting every render would be
    // worse than the original defect: it inflates every render metric in development.
    const { client, recordChildSpan } = fakeActive();
    const cleanup = render(
      createElement(
        BugseeProfiler,
        { id: 'Once', getClient: () => client },
        createElement('div', null, 'x'),
      ),
    );
    expect(recordChildSpan).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('records a span even when Profiler NEVER fires — the production case', () => {
    // Exactly what a production React build does: children render, `onRender` is never called.
    const { client, recordChildSpan } = fakeActive();
    const cleanup = render(
      createElement(
        BugseeProfiler,
        { id: 'Prod', getClient: () => client, __profilerInert: true },
        createElement('div', null, 'x'),
      ),
    );
    expect(recordChildSpan).toHaveBeenCalledTimes(1);
    const [op, opts] = recordChildSpan.mock.calls[0] as [string, Record<string, unknown>];
    expect(op).toBe('ui.render');
    expect(opts.description).toBe('Prod');
    expect((opts.attributes as Record<string, unknown>)['ui.render_phase']).toBe('mount');
    cleanup();
  });

  it('marks the fallback measurement so it is not mistaken for React’s own timing', () => {
    // The fallback measures render-start to post-commit, which INCLUDES commit work React excludes from
    // `actualDuration`. A consumer comparing the two must be able to tell them apart.
    const { client, recordChildSpan } = fakeActive();
    const cleanup = render(
      createElement(
        BugseeProfiler,
        { id: 'Prod', getClient: () => client, __profilerInert: true },
        createElement('div', null, 'x'),
      ),
    );
    const [, opts] = recordChildSpan.mock.calls[0] as [string, Record<string, unknown>];
    expect((opts.attributes as Record<string, unknown>)['ui.render_source']).toBe('fallback');
    cleanup();
  });

  it('does not throw out of the render when the SDK fails', () => {
    // This runs inside React's commit phase; a throw there unmounts the tree.
    const hostile = {
      ext: () => {
        throw new Error('SDK internal failure');
      },
    } as unknown as Bugsee;
    expect(() => {
      const cleanup = render(
        createElement(
          BugseeProfiler,
          { id: 'X', getClient: () => hostile, __profilerInert: true },
          createElement('div', null, 'x'),
        ),
      );
      cleanup();
    }).not.toThrow();
  });

  it('measures the UPDATE phase itself when Profiler never fires — a re-render in production', () => {
    // The mount fallback was covered; the update fallback was not covered AT ALL (the audit reported the
    // `'update'` literal as unreached), so nothing defended the mounted-flag flip or the measured duration.
    const { client, recordChildSpan } = fakeActive();
    const before = Date.now();
    const view = (label: string) =>
      createElement(
        BugseeProfiler,
        { id: 'Prod', getClient: () => client, __profilerInert: true },
        createElement('div', null, label),
      );
    const { rerender, cleanup } = mount(view('a'));
    rerender(view('b'));
    const after = Date.now();

    expect(recordChildSpan).toHaveBeenCalledTimes(2);
    expect(attrsOf(recordChildSpan, 0)['ui.render_phase']).toBe('mount');
    expect(attrsOf(recordChildSpan, 1)['ui.render_phase']).toBe('update'); // NOT a second 'mount'
    for (const index of [0, 1]) {
      const { startTimestampMs, endTimestampMs } = optsOf(recordChildSpan, index);
      const attrs = attrsOf(recordChildSpan, index);
      expect(Number.isFinite(startTimestampMs)).toBe(true);
      expect(Number.isFinite(endTimestampMs)).toBe(true);
      // The fallback's duration IS its extent — render start to post-commit — for both the reported
      // duration and the base duration. A sum instead of a difference passes neither.
      // `toBeCloseTo`, not `toBe`: the component subtracts the two `performance.now()` readings, while the
      // span timestamps add `timeOrigin` (~1.7e12) to each FIRST — an addition whose ulp is ~2e-4 ms, so
      // the two differ in the low bits. The tolerance is 5e-3 ms; a SUM instead of a difference lands
      // ~1e5 x further away than that and fails comfortably.
      expect(attrs['ui.render_duration_ms']).toBeCloseTo(endTimestampMs - startTimestampMs, 2);
      expect(attrs['ui.render_base_duration_ms']).toBeCloseTo(endTimestampMs - startTimestampMs, 2);
      expect(endTimestampMs).toBeGreaterThanOrEqual(startTimestampMs);
      // and it is a real wall-clock epoch, not a value relative to some other origin: the whole span has
      // to sit inside the window this test ran in.
      //
      // CLOCK_SKEW_MS, not a 1 ms slack. `before`/`after` come from `Date.now()`, while these
      // timestamps are `performance.timeOrigin + performance.now()` — two clocks that drift apart, and
      // `Date.now()` is additionally subject to NTP steps. The 1 ms form failed on CI at 1.0046 ms past
      // `after`, which is drift, not a defect. The property being tested survives a generous tolerance
      // untouched: a timestamp on the WRONG origin is out by ~1.7e12 ms, eight orders of magnitude
      // beyond this, so nothing that this used to catch escapes it now.
      const CLOCK_SKEW_MS = 1_000;
      expect(startTimestampMs).toBeGreaterThanOrEqual(before - CLOCK_SKEW_MS);
      expect(endTimestampMs).toBeLessThanOrEqual(after + CLOCK_SKEW_MS);
    }
    cleanup();
  });

  it('re-arms the fallback after React reported a commit', () => {
    // `reportedRef` is the handshake between the two measurement paths, and it is CONSUMED, not sticky: a
    // commit React reported must not silence the fallback for every commit after it. Leaving the flag set
    // would mean an app that renders once under a live Profiler and then loses it (a lazily-loaded chunk
    // built against a production react-dom) silently stops producing render spans.
    const { client, recordChildSpan } = fakeActive();
    const { rerender, cleanup } = mount(
      createElement(
        BugseeProfiler,
        { id: 'Both', getClient: () => client },
        createElement('div', null, 'a'),
      ),
    );
    expect(recordChildSpan).toHaveBeenCalledTimes(1);
    expect(attrsOf(recordChildSpan, 0)).not.toHaveProperty('ui.render_source'); // React's

    rerender(
      createElement(
        BugseeProfiler,
        { id: 'Both', getClient: () => client, __profilerInert: true },
        createElement('div', null, 'b'),
      ),
    );
    expect(recordChildSpan).toHaveBeenCalledTimes(2);
    expect(attrsOf(recordChildSpan, 1)['ui.render_source']).toBe('fallback');
    expect(attrsOf(recordChildSpan, 1)['ui.render_phase']).toBe('update');
    cleanup();
  });

  it.each([
    ['no `performance` global at all', undefined],
    ['a `performance` without `now`', {}],
  ])('renders and still records when the host has %s', (_label, stub) => {
    // The component reads `performance.now()` from the RENDER BODY, outside any guard the recorder applies
    // — so on a host that has no `performance` (or a partial one), an unguarded read would throw straight
    // into React's render phase and unmount the tree.
    //
    // Both the component's own `now()` (start/commit, relative) and `realTimeOrigin()`'s reconstruction
    // (via `Date.now()`) degrade in the SAME direction here: with no relative reading at all, the origin
    // reconstruction collapses to plain `Date.now()`, so the recorded span sits at "now" with 0 duration —
    // a real epoch anchor, not the pre-fix literal 0 (which would have mis-anchored the span ~1970, inside
    // a transaction whose own timestamp is a real epoch value). Taking the app down is still not accepted.
    const { client, recordChildSpan } = fakeActive();
    vi.stubGlobal('performance', stub);
    const before = Date.now();
    try {
      const cleanup = render(
        createElement(
          BugseeProfiler,
          { id: 'NoPerf', getClient: () => client, __profilerInert: true },
          createElement('div', null, 'x'),
        ),
      );
      const after = Date.now();
      expect(recordChildSpan).toHaveBeenCalledTimes(1);
      const { startTimestampMs, endTimestampMs } = optsOf(recordChildSpan, 0);
      expect(startTimestampMs).toBe(endTimestampMs); // 0 relative duration → both collapse to the same origin
      expect(startTimestampMs).toBeGreaterThanOrEqual(before);
      expect(startTimestampMs).toBeLessThanOrEqual(after);
      expect(attrsOf(recordChildSpan, 0)['ui.render_duration_ms']).toBe(0);
      cleanup();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
