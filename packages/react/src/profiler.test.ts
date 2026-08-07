import type { Bugsee } from '@bugsee/web-adapter';
import { type ComponentType, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { BugseeProfiler, recordReactRenderSpan, withBugseeProfiler } from './profiler';

// A fake client whose ext('performance').getActiveSpan() returns a span recording child spans.
function fakeActive() {
  const recordChildSpan = vi.fn();
  const span = { recordChildSpan };
  const client = {
    ext: (name: string) => (name === 'performance' ? { getActiveSpan: () => span } : undefined),
  } as unknown as Bugsee;
  return { client, recordChildSpan };
}

const profile = {
  id: 'Dashboard',
  phase: 'update',
  actualDuration: 12.5,
  baseDuration: 30,
  startTime: 100,
  commitTime: 118,
};

describe('recordReactRenderSpan', () => {
  it('records a `ui.render` child span on the active transaction (epoch-shifted by timeOrigin)', () => {
    const { client, recordChildSpan } = fakeActive();
    recordReactRenderSpan(profile, { getClient: () => client, timeOrigin: 1000 });
    expect(recordChildSpan).toHaveBeenCalledTimes(1);
    const [op, opts] = recordChildSpan.mock.calls[0] as [string, Record<string, unknown>];
    expect(op).toBe('ui.render');
    expect(opts.startTimestampMs).toBe(1100); // timeOrigin + startTime
    expect(opts.endTimestampMs).toBe(1118); // timeOrigin + commitTime
    expect(opts.description).toBe('Dashboard');
    expect(opts.attributes).toMatchObject({
      'ui.render_phase': 'update',
      'ui.render_duration_ms': 12.5, // React's actualDuration (the explicit durationMs)
      'ui.render_base_duration_ms': 30, // the React-specific extra routed through the shared recorder
    });
  });

  it('is a no-op when there is no active transaction', () => {
    const client = {
      ext: () => ({ getActiveSpan: () => undefined }),
    } as unknown as Bugsee;
    const recordChildSpan = vi.fn();
    expect(() => recordReactRenderSpan(profile, { getClient: () => client })).not.toThrow();
    expect(recordChildSpan).not.toHaveBeenCalled();
  });

  it('is a no-op when no SDK / performance ext is available', () => {
    expect(() => recordReactRenderSpan(profile, { getClient: () => undefined })).not.toThrow();
  });

  it('defaults timeOrigin to the global performance.timeOrigin', () => {
    const { client, recordChildSpan } = fakeActive();
    vi.stubGlobal('performance', { timeOrigin: 500 });
    try {
      recordReactRenderSpan(profile, { getClient: () => client });
      expect(
        (recordChildSpan.mock.calls[0]?.[1] as { startTimestampMs: number }).startTimestampMs,
      ).toBe(600); // 500 + 100
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('falls back to timeOrigin 0 when performance.timeOrigin is unavailable', () => {
    const { client, recordChildSpan } = fakeActive();
    vi.stubGlobal('performance', {}); // no timeOrigin
    try {
      recordReactRenderSpan(profile, { getClient: () => client });
      expect(
        (recordChildSpan.mock.calls[0]?.[1] as { startTimestampMs: number }).startTimestampMs,
      ).toBe(100); // 0 + startTime
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('BugseeProfiler', () => {
  // The direct-call test that lived here — `BugseeProfiler({...})` invoked as a plain function, asserting
  // `element.type === Profiler` and driving `props.onRender` by hand — became invalid when the component
  // gained hooks for the production fallback (Wave 4.6 / D4): calling a hook component outside a renderer
  // throws "Invalid hook call".
  //
  // Its three assertions are all covered better by `profiler.render.test.ts`, which renders through real
  // react-dom: that a span IS recorded on a dev render can only happen if a real `<Profiler>` fired, which
  // subsumes the structural check. The one thing worth keeping explicitly is that the DEV path uses
  // React's OWN timings rather than the fallback's — asserted there by the absence of `ui.render_source`.
  it('uses React’s own timings in development, not the fallback measurement', () => {
    const { client, recordChildSpan } = fakeActive();
    // Drive the recording core exactly as the live-Profiler path does: no `source`, React's numbers.
    recordReactRenderSpan(
      {
        id: 'Page',
        phase: 'mount',
        actualDuration: 5,
        baseDuration: 6,
        startTime: 10,
        commitTime: 18,
      },
      { getClient: () => client, timeOrigin: 0 },
    );
    expect(recordChildSpan).toHaveBeenCalledWith(
      'ui.render',
      expect.objectContaining({ description: 'Page', startTimestampMs: 10, endTimestampMs: 18 }),
    );
    const [, opts] = recordChildSpan.mock.calls[0] as [string, Record<string, unknown>];
    expect((opts.attributes as Record<string, unknown>)['ui.render_source']).toBeUndefined();
  });
});

describe('withBugseeProfiler', () => {
  const Wrapped: ComponentType<{ label: string }> = () => null;

  it('wraps a component in a BugseeProfiler with the given id, forwarding props', () => {
    const Hoc = withBugseeProfiler(Wrapped, 'MyView');
    const element = (Hoc as (p: { label: string }) => ReactElement)({ label: 'hi' });
    expect(element.type).toBe(BugseeProfiler); // the outer element is the profiler wrapper
    expect(element.props.id).toBe('MyView');
    const child = element.props.children as ReactElement;
    expect(child.type).toBe(Wrapped);
    expect(child.props).toEqual({ label: 'hi' });
  });

  it('derives the profiler id from displayName, then name, then "Component"', () => {
    function Panel(): ReactNode {
      return null;
    }
    expect(
      ((withBugseeProfiler(Panel) as (p: object) => ReactElement)({}) as ReactElement).props.id,
    ).toBe('Panel'); // function name

    const Named: ComponentType = () => null;
    Named.displayName = 'NamedView';
    expect(((withBugseeProfiler(Named) as () => ReactElement)() as ReactElement).props.id).toBe(
      'NamedView',
    ); // displayName wins

    const anon = withBugseeProfiler((() => null) as ComponentType);
    expect(((anon as () => ReactElement)() as ReactElement).props.id).toBe('Component'); // fallback
  });

  it('forwards the wrapped component props through', () => {
    const Hoc = withBugseeProfiler(Wrapped, 'X');
    const el = (Hoc as (p: { label: string }) => ReactElement)({ label: 'z' });
    expect((el.props.children as ReactElement).props).toEqual({ label: 'z' });
  });
});

// WAVE 4.6 — the production caveat, pinned as a contract rather than left in prose.
//
// React disables `<Profiler>` in a standard production build, so `<BugseeProfiler>` records ZERO spans in
// the build customers ship. The SDK cannot change that — it depends on which `react-dom` the APP bundles —
// so the resolution is an honest, discoverable escape hatch: `recordReactRenderSpan` is React-free and
// takes plain numbers, so an app can feed it from `react-dom/profiling` or from timings it already has.
// These tests exist so that escape hatch cannot be removed or made React-dependent without failing.
describe('the production escape hatch (Wave 4.6)', () => {
  it('recordReactRenderSpan works with NO React involved at all', () => {
    const recordChildSpan = vi.fn();
    const client = {
      ext: () => ({ getActiveSpan: () => ({ recordChildSpan }) }),
    } as unknown as Bugsee;
    recordReactRenderSpan(
      {
        id: 'Checkout',
        phase: 'update',
        actualDuration: 12,
        baseDuration: 9,
        startTime: 100,
        commitTime: 112,
      },
      { getClient: () => client, timeOrigin: 0 },
    );
    expect(recordChildSpan).toHaveBeenCalled();
  });

  it('takes plain numbers — no Profiler payload object required', () => {
    // The property that makes the escape hatch usable from a non-React timing source.
    expect(recordReactRenderSpan.length).toBeGreaterThanOrEqual(1);
    expect(() =>
      recordReactRenderSpan(
        {
          id: 'X',
          phase: 'mount',
          actualDuration: 1,
          baseDuration: 1,
          startTime: 0,
          commitTime: 1,
        },
        { getClient: () => undefined },
      ),
    ).not.toThrow();
  });
});
