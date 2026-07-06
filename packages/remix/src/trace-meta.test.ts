import { type ContextProvider, type RequestContext, setCarrierClient } from '@bugsee/core';
import { afterEach, describe, expect, it } from 'vitest';
import { getBugseeTraceMetaTags } from './trace-meta';

const TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
const SPAN_ID = 'b7ad6b7169203331';

function clientWith(provider: ContextProvider | null) {
  return { getServiceProvider: () => ({ getImmediate: () => provider }) } as never;
}
function ctxProvider(trace: RequestContext['trace']): ContextProvider {
  return { getCurrent: () => (trace === undefined ? undefined : { contextId: 'c1', trace }) };
}

describe('getBugseeTraceMetaTags', () => {
  afterEach(() => setCarrierClient(undefined));

  it('renders a traceparent <meta> tag for the active server trace', () => {
    const client = clientWith(ctxProvider({ traceId: TRACE_ID, spanId: SPAN_ID, sampled: true }));
    expect(getBugseeTraceMetaTags({ getClient: () => client })).toBe(
      `<meta name="traceparent" content="00-${TRACE_ID}-${SPAN_ID}-01">`,
    );
  });

  it('renders an empty string when no trace is active (no <meta> injected)', () => {
    expect(getBugseeTraceMetaTags({ getClient: () => clientWith(ctxProvider(undefined)) })).toBe(
      '',
    );
    expect(getBugseeTraceMetaTags({ getClient: () => undefined })).toBe('');
  });

  it('defaults to the carrier client', () => {
    expect(getBugseeTraceMetaTags()).toBe('');
    setCarrierClient(
      clientWith(ctxProvider({ traceId: TRACE_ID, spanId: SPAN_ID, sampled: false })),
    );
    expect(getBugseeTraceMetaTags()).toBe(
      `<meta name="traceparent" content="00-${TRACE_ID}-${SPAN_ID}-00">`,
    );
  });
});
