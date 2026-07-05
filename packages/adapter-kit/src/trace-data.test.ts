import { type ContextProvider, type RequestContext, setCarrierClient } from '@bugsee/core';
import { afterEach, describe, expect, it } from 'vitest';
import { getTraceparent, traceMetaEntries } from './trace-data';

const TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
const SPAN_ID = 'b7ad6b7169203331';

function clientWith(provider: ContextProvider | null) {
  return {
    getServiceProvider: () => ({ getImmediate: () => provider }),
  } as never;
}
function ctxProvider(trace: RequestContext['trace']): ContextProvider {
  return { getCurrent: () => (trace === undefined ? undefined : { contextId: 'c1', trace }) };
}

describe('getTraceparent', () => {
  afterEach(() => setCarrierClient(undefined));

  it('formats the active trace as a W3C traceparent (sampled → 01)', () => {
    const client = clientWith(ctxProvider({ traceId: TRACE_ID, spanId: SPAN_ID, sampled: true }));
    expect(getTraceparent({ getClient: () => client })).toBe(`00-${TRACE_ID}-${SPAN_ID}-01`);
  });

  it('encodes the sampling decision in the flags (unsampled → 00)', () => {
    const client = clientWith(ctxProvider({ traceId: TRACE_ID, spanId: SPAN_ID, sampled: false }));
    expect(getTraceparent({ getClient: () => client })).toBe(`00-${TRACE_ID}-${SPAN_ID}-00`);
  });

  it('returns undefined with no active trace / no provider / no client', () => {
    expect(getTraceparent({ getClient: () => clientWith(ctxProvider(undefined)) })).toBeUndefined();
    expect(getTraceparent({ getClient: () => clientWith(null) })).toBeUndefined();
    expect(getTraceparent({ getClient: () => undefined })).toBeUndefined();
  });

  it('never throws — a hostile client yields undefined', () => {
    const hostile = {
      getServiceProvider: () => {
        throw new Error('boom');
      },
    } as never;
    expect(getTraceparent({ getClient: () => hostile })).toBeUndefined();
  });

  it('defaults to the carrier client', () => {
    expect(getTraceparent()).toBeUndefined();
    setCarrierClient(
      clientWith(ctxProvider({ traceId: TRACE_ID, spanId: SPAN_ID, sampled: true })),
    );
    expect(getTraceparent()).toBe(`00-${TRACE_ID}-${SPAN_ID}-01`);
  });
});

describe('traceMetaEntries', () => {
  afterEach(() => setCarrierClient(undefined));

  it('returns { traceparent } when a trace is active', () => {
    const client = clientWith(ctxProvider({ traceId: TRACE_ID, spanId: SPAN_ID, sampled: true }));
    expect(traceMetaEntries({ getClient: () => client })).toEqual({
      traceparent: `00-${TRACE_ID}-${SPAN_ID}-01`,
    });
  });

  it('returns {} when no trace is active', () => {
    expect(traceMetaEntries({ getClient: () => clientWith(ctxProvider(undefined)) })).toEqual({});
  });
});
