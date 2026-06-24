import type { Bugsee } from '@bugsee/web-adapter';
import { type ComponentType, Profiler, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  BugseeProfiler,
  type BugseeProfilerProps,
  recordReactRenderSpan,
  withBugseeProfiler,
} from './profiler';

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
      'ui.render_duration_ms': 12.5,
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
  it('renders a React Profiler wrapping the children, with an onRender that records the span', () => {
    const { client, recordChildSpan } = fakeActive();
    const element = BugseeProfiler({
      id: 'Page',
      getClient: () => client,
      timeOrigin: 0,
      children: 'CHILD',
    } as BugseeProfilerProps);
    expect(element.type).toBe(Profiler); // it's a real React Profiler
    expect(element.props.id).toBe('Page');
    expect(element.props.children).toBe('CHILD');
    // drive the onRender callback React would call → records the render span
    element.props.onRender('Page', 'mount', 5, 6, 10, 18);
    expect(recordChildSpan).toHaveBeenCalledWith(
      'ui.render',
      expect.objectContaining({ description: 'Page', startTimestampMs: 10, endTimestampMs: 18 }),
    );
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
