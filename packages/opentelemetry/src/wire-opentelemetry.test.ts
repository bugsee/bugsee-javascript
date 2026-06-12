import type { OutgoingRequest, RequestDecorator, TraceContextSource } from '@bugsee/capture';
import { describe, expect, it } from 'vitest';
import { wireOpenTelemetry } from './wire-opentelemetry';

const TID = '0123456789abcdef0123456789abcdef';
const SID = 'aaaaaaaaaaaaaaaa';
const ctx: TraceContextSource = {
  getTraceId: () => TID,
  getSpanId: () => SID,
  isSampled: () => true,
};
const req = (url: string): OutgoingRequest => ({ url, method: 'GET', headers: {} });

function fakeNetworkSource() {
  const decorators: RequestDecorator[] = [];
  let unsubscribes = 0;
  return {
    source: {
      addRequestDecorator(decorator: RequestDecorator) {
        decorators.push(decorator);
        return () => {
          unsubscribes += 1;
        };
      },
    },
    decorators,
    unsubscribes: () => unsubscribes,
  };
}

describe('wireOpenTelemetry', () => {
  it('does nothing when propagate is off', () => {
    const { source, decorators } = fakeNetworkSource();
    expect(
      wireOpenTelemetry({ networkSource: source, getActiveSpan: () => ctx, propagate: false }),
    ).toBeUndefined();
    expect(decorators).toHaveLength(0);
  });

  it('registers a traceparent decorator on the network source when propagate is on', () => {
    const { source, decorators } = fakeNetworkSource();
    const wired = wireOpenTelemetry({
      networkSource: source,
      getActiveSpan: () => ctx,
      propagate: true,
      origin: 'https://app.test',
    });
    expect(wired).toBeDefined();
    expect(decorators).toHaveLength(1);
    // The registered decorator propagates the active trace on a same-origin request.
    expect(decorators[0]?.(req('https://app.test/x'))).toEqual({
      traceparent: `00-${TID}-${SID}-01`,
    });
  });

  it('threads the allowlist (cross-origin propagated only when allowlisted)', () => {
    const { source, decorators } = fakeNetworkSource();
    wireOpenTelemetry({
      networkSource: source,
      getActiveSpan: () => ctx,
      propagate: true,
      origin: 'https://app.test',
      allowlist: ['api.internal.test'],
    });
    const d = decorators[0];
    expect(d?.(req('https://api.internal.test/x'))).toBeDefined();
    expect(d?.(req('https://third-party.test/x'))).toBeUndefined();
  });

  it('threads getActiveSpan (no active trace → no traceparent)', () => {
    const { source, decorators } = fakeNetworkSource();
    wireOpenTelemetry({
      networkSource: source,
      getActiveSpan: () => undefined,
      propagate: true,
      origin: 'https://app.test',
    });
    expect(decorators[0]?.(req('https://app.test/x'))).toBeUndefined();
  });

  it('omits origin when not provided (the decorator falls back to the global location)', () => {
    const { source, decorators } = fakeNetworkSource();
    // No `origin` → in Node `globalThis.location` is undefined → same-origin undeterminable → allowlist governs.
    wireOpenTelemetry({
      networkSource: source,
      getActiveSpan: () => ctx,
      propagate: true,
      allowlist: ['app.test'],
    });
    expect(decorators[0]?.(req('https://app.test/x'))).toBeDefined();
    expect(decorators[0]?.(req('https://other.test/x'))).toBeUndefined();
  });

  it('stop() unsubscribes the decorator', () => {
    const { source, unsubscribes } = fakeNetworkSource();
    const wired = wireOpenTelemetry({
      networkSource: source,
      getActiveSpan: () => ctx,
      propagate: true,
      origin: 'https://app.test',
    });
    wired?.stop();
    expect(unsubscribes()).toBe(1);
  });
});
