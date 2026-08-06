import type { Bugsee } from '@bugsee/browser';
import { describe, expect, it, vi } from 'vitest';
import {
  RENDER_DURATION_ATTRIBUTE,
  RENDER_PHASE_ATTRIBUTE,
  RENDER_SPAN_OP,
  recordRenderSpan,
} from './render-span';

// A fake client whose ext('performance').getActiveSpan() returns a span recording child spans.
function fakeActive() {
  const recordChildSpan = vi.fn();
  const span = { recordChildSpan };
  const client = {
    ext: (name: string) => (name === 'performance' ? { getActiveSpan: () => span } : undefined),
  } as unknown as Bugsee;
  return { client, recordChildSpan };
}

const attrsOf = (recordChildSpan: ReturnType<typeof vi.fn>) =>
  (recordChildSpan.mock.calls[0]?.[1] as { attributes: Record<string, unknown> }).attributes;

describe('recordRenderSpan', () => {
  it('records a `ui.render` child span on the active transaction (duration = end - start)', () => {
    const { client, recordChildSpan } = fakeActive();
    recordRenderSpan(
      { name: 'Dashboard', startTimestampMs: 1000, endTimestampMs: 1015, phase: 'mount' },
      { getClient: () => client },
    );
    expect(recordChildSpan).toHaveBeenCalledTimes(1);
    const [op, opts] = recordChildSpan.mock.calls[0] as [string, Record<string, unknown>];
    expect(op).toBe(RENDER_SPAN_OP);
    expect(op).toBe('ui.render');
    expect(opts.startTimestampMs).toBe(1000);
    expect(opts.endTimestampMs).toBe(1015);
    expect(opts.description).toBe('Dashboard');
    expect((opts.attributes as Record<string, unknown>)[RENDER_DURATION_ATTRIBUTE]).toBe(15);
    expect((opts.attributes as Record<string, unknown>)[RENDER_PHASE_ATTRIBUTE]).toBe('mount');
  });

  it('uses an explicit durationMs when supplied (a render cost distinct from the span extent)', () => {
    const { client, recordChildSpan } = fakeActive();
    recordRenderSpan(
      { name: 'X', startTimestampMs: 100, endTimestampMs: 200, durationMs: 12.5 },
      { getClient: () => client },
    );
    expect(attrsOf(recordChildSpan)[RENDER_DURATION_ATTRIBUTE]).toBe(12.5); // not 100 (the extent)
  });

  it('omits the phase attribute entirely when no phase is given', () => {
    const { client, recordChildSpan } = fakeActive();
    recordRenderSpan(
      { name: 'X', startTimestampMs: 0, endTimestampMs: 5 },
      { getClient: () => client },
    );
    expect(RENDER_PHASE_ATTRIBUTE in attrsOf(recordChildSpan)).toBe(false);
  });

  it('keeps the canonical duration/phase AUTHORITATIVE over a colliding extra attribute', () => {
    const { client, recordChildSpan } = fakeActive();
    recordRenderSpan(
      {
        name: 'X',
        startTimestampMs: 0,
        endTimestampMs: 5,
        phase: 'mount',
        // a framework extra that COLLIDES with the canonical keys must not win
        attributes: { 'ui.render_duration_ms': 999, 'ui.render_phase': 'WRONG' },
      },
      { getClient: () => client },
    );
    expect(attrsOf(recordChildSpan)['ui.render_duration_ms']).toBe(5); // canonical extent, not 999
    expect(attrsOf(recordChildSpan)['ui.render_phase']).toBe('mount'); // canonical phase, not WRONG
  });

  it('merges extra framework-specific (non-colliding) attributes after the canonical ones', () => {
    const { client, recordChildSpan } = fakeActive();
    recordRenderSpan(
      {
        name: 'X',
        startTimestampMs: 0,
        endTimestampMs: 5,
        phase: 'update',
        attributes: { 'ui.render_base_duration_ms': 30 },
      },
      { getClient: () => client },
    );
    expect(attrsOf(recordChildSpan)).toMatchObject({
      'ui.render_duration_ms': 5,
      'ui.render_phase': 'update',
      'ui.render_base_duration_ms': 30,
    });
  });

  it('is a no-op when there is no active transaction', () => {
    const client = {
      ext: () => ({ getActiveSpan: () => undefined }),
    } as unknown as Bugsee;
    const recordChildSpan = vi.fn();
    // `onError` must stay silent. Deleting `if (active === undefined) return` calls `recordChildSpan` on
    // undefined, which throws into `neverThrow` — so the suite still saw "no throw, no span recorded" and
    // passed, while every render without an active transaction reported an SDK-internal error.
    const onError = vi.fn();
    expect(() =>
      recordRenderSpan(
        { name: 'X', startTimestampMs: 0, endTimestampMs: 1 },
        { getClient: () => client, onError },
      ),
    ).not.toThrow();
    expect(recordChildSpan).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('is a no-op when no SDK / performance ext is available', () => {
    expect(() =>
      recordRenderSpan(
        { name: 'X', startTimestampMs: 0, endTimestampMs: 1 },
        { getClient: () => undefined },
      ),
    ).not.toThrow();
  });
});
