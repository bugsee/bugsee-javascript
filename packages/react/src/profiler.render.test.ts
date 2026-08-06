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

const render = (element: ReturnType<typeof createElement>): (() => void) => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  return () => {
    act(() => {
      root.unmount();
    });
    container.remove();
  };
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
});
