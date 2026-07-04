import { type ContextProvider, type RequestContext, setCarrierClient } from '@bugsee/core';
import { afterEach, describe, expect, it } from 'vitest';
import { getBugseeTraceData } from './trace-data';

const TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
const SPAN_ID = 'b7ad6b7169203331';

/** A minimal client whose ContextProviderToken provider resolves to `provider` (or null = unregistered). */
function clientWith(provider: ContextProvider | null) {
  return {
    getServiceProvider: () => ({ getImmediate: () => provider }),
  } as never;
}

/** A ContextProvider whose active context carries (or omits) a trace. */
function ctxProvider(trace: RequestContext['trace']): ContextProvider {
  return { getCurrent: () => (trace === undefined ? undefined : { contextId: 'c1', trace }) };
}

describe('getBugseeTraceData', () => {
  afterEach(() => setCarrierClient(undefined));

  it('formats the active trace as a W3C traceparent (sampled → 01)', () => {
    const client = clientWith(ctxProvider({ traceId: TRACE_ID, spanId: SPAN_ID, sampled: true }));
    expect(getBugseeTraceData({ getClient: () => client })).toEqual({
      traceparent: `00-${TRACE_ID}-${SPAN_ID}-01`,
    });
  });

  it('encodes the sampling decision in the flags (unsampled → 00)', () => {
    const client = clientWith(ctxProvider({ traceId: TRACE_ID, spanId: SPAN_ID, sampled: false }));
    expect(getBugseeTraceData({ getClient: () => client })).toEqual({
      traceparent: `00-${TRACE_ID}-${SPAN_ID}-00`,
    });
  });

  it('returns {} when no trace is active (context without a trace)', () => {
    const client = clientWith(ctxProvider(undefined));
    expect(getBugseeTraceData({ getClient: () => client })).toEqual({});
  });

  it('returns {} when no ContextProvider is registered (e.g. no per-request context)', () => {
    const client = clientWith(null);
    expect(getBugseeTraceData({ getClient: () => client })).toEqual({});
  });

  it('returns {} when no client is active', () => {
    expect(getBugseeTraceData({ getClient: () => undefined })).toEqual({});
  });

  it('never throws — a hostile client yields {} (must not break generateMetadata)', () => {
    const hostile = {
      getServiceProvider: () => {
        throw new Error('boom');
      },
    } as never;
    expect(getBugseeTraceData({ getClient: () => hostile })).toEqual({});
  });

  it('defaults to the carrier client when no getClient is provided', () => {
    // No launched client → default resolver returns undefined → {}.
    expect(getBugseeTraceData()).toEqual({});
    // Seed the carrier → the default resolver reads it and formats the active trace.
    setCarrierClient(
      clientWith(ctxProvider({ traceId: TRACE_ID, spanId: SPAN_ID, sampled: true })),
    );
    expect(getBugseeTraceData()).toEqual({ traceparent: `00-${TRACE_ID}-${SPAN_ID}-01` });
  });
});
