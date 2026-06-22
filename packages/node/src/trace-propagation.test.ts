import { describe, expect, it } from 'vitest';
import { buildTracePropagationDecorator } from './trace-propagation';

const TID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SID = 'bbbbbbbbbbbbbbbb';
const req = (url: string, headers: Record<string, string> = {}) => ({
  url,
  method: 'GET',
  headers,
});
const store = (trace?: { traceId: string; spanId: string; sampled: boolean }) => ({
  getCurrent: () => (trace === undefined ? { contextId: 'c' } : { contextId: 'c', trace }),
});
const api = (sessionId = 'sess1') => ({ sessionId });

describe('buildTracePropagationDecorator', () => {
  it('returns undefined when propagateTrace is false (the kill-switch — nothing ever injected)', () => {
    expect(
      buildTracePropagationDecorator(store({ traceId: TID, spanId: SID, sampled: true }), api(), {
        propagateTrace: false,
        tracePropagationTargets: ['x'],
      }),
    ).toBeUndefined();
  });

  it('injects traceparent + bugsee= from the active per-request context for an allowlisted target', () => {
    const d = buildTracePropagationDecorator(
      store({ traceId: TID, spanId: SID, sampled: true }),
      api('sess9'),
      { tracePropagationTargets: ['internal.svc'] },
    );
    expect(d?.(req('https://internal.svc/api'))).toEqual({
      traceparent: `00-${TID}-${SID}-01`,
      tracestate: 'bugsee=r1:ssess9', // record flag + the launch session-correlation id
    });
  });

  it('does NOT propagate to a non-allowlisted (third-party) target — no trace leak (no same-origin on Node)', () => {
    const d = buildTracePropagationDecorator(
      store({ traceId: TID, spanId: SID, sampled: true }),
      api(),
      {}, // no targets → nothing is allowed on Node
    );
    expect(d?.(req('https://api.stripe.com/charge'))).toBeUndefined();
  });

  it('does nothing when no per-request trace is active', () => {
    const d = buildTracePropagationDecorator(store(undefined), api(), {
      tracePropagationTargets: ['svc'],
    });
    expect(d?.(req('https://svc.internal/'))).toBeUndefined();
  });

  it('reflects the context sampled=false in the traceparent flags (00)', () => {
    const d = buildTracePropagationDecorator(
      store({ traceId: TID, spanId: SID, sampled: false }),
      api(),
      { tracePropagationTargets: ['svc'] },
    );
    expect(d?.(req('https://svc.internal/'))?.traceparent).toBe(`00-${TID}-${SID}-00`);
  });
});
