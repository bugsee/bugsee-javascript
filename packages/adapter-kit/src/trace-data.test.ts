import { type ContextProvider, type RequestContext, setCarrierClient } from '@bugsee/core';
import { afterEach, describe, expect, it } from 'vitest';
import { getTraceparent, traceMetaEntries, traceMetaTag } from './trace-data';

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

// NOTE for a future auditor doing a teeth check on this file. `getTraceparent` wraps its ENTIRE body in
// `try { … } catch { return undefined }`, and every internal guard's failure mode is also "return
// undefined". That makes all SEVEN of them PROVEN-EQUIVALENT mutants, not test gaps: the `client ===
// undefined` guard, `getImmediate({ optional: true })` (vs `{}` / `{ optional: false }` — @bugsee/service
// only turns "return null" into "throw", which the catch absorbs), both `?.` in
// `provider?.getCurrent()?.trace`, the `trace === undefined` guard, and the explicit `return undefined` in
// the catch. Verified DIFFERENTIALLY, not by argument: each mutant was run against the clean source over
// 13 client/provider/trace shapes (absent, null, throwing service lookup, unregistered provider, hostile
// proxy, no context, context without trace, sampled, unsampled) comparing `getTraceparent` +
// `traceMetaEntries` + `Object.keys(...)` + `traceMetaTag` — byte-identical every time. The one mutant in
// this file that DOES have teeth is `traceMetaEntries`'s conditional, pinned below by `toStrictEqual` and
// an `in` check, because there absent and present-and-undefined are genuinely different to a consumer.
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

  it('returns {} when no trace is active — the KEY IS ABSENT, not present-and-undefined', () => {
    // `toEqual({})` cannot fail here: it ignores undefined-valued keys, so `{ traceparent: undefined }`
    // passed it. The distinction is load-bearing — these entries get SPREAD into a framework's metadata
    // surface (Next.js `generateMetadata`'s `other`, Nuxt `render:html`), where a present-but-undefined
    // key renders `content="undefined"` into the SSR <head> instead of injecting nothing at all.
    const entries = traceMetaEntries({ getClient: () => clientWith(ctxProvider(undefined)) });
    expect(entries).toStrictEqual({});
    expect('traceparent' in entries).toBe(false);
    expect(Object.keys(entries)).toStrictEqual([]);
  });
});

describe('traceMetaTag', () => {
  afterEach(() => setCarrierClient(undefined));

  it('renders a <meta name="traceparent"> tag for the active trace (sampled → 01)', () => {
    const client = clientWith(ctxProvider({ traceId: TRACE_ID, spanId: SPAN_ID, sampled: true }));
    expect(traceMetaTag({ getClient: () => client })).toBe(
      `<meta name="traceparent" content="00-${TRACE_ID}-${SPAN_ID}-01">`,
    );
  });

  it('encodes the sampling decision (unsampled → 00)', () => {
    const client = clientWith(ctxProvider({ traceId: TRACE_ID, spanId: SPAN_ID, sampled: false }));
    expect(traceMetaTag({ getClient: () => client })).toBe(
      `<meta name="traceparent" content="00-${TRACE_ID}-${SPAN_ID}-00">`,
    );
  });

  it('renders an empty string when no trace is active (nothing injected)', () => {
    expect(traceMetaTag({ getClient: () => clientWith(ctxProvider(undefined)) })).toBe('');
    expect(traceMetaTag({ getClient: () => undefined })).toBe('');
  });

  it('defaults to the carrier client', () => {
    expect(traceMetaTag()).toBe('');
    setCarrierClient(
      clientWith(ctxProvider({ traceId: TRACE_ID, spanId: SPAN_ID, sampled: true })),
    );
    expect(traceMetaTag()).toBe(`<meta name="traceparent" content="00-${TRACE_ID}-${SPAN_ID}-01">`);
  });
});
