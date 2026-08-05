import { describe, expect, it, vi } from 'vitest';
import { createBugseeSpanProcessor } from './span-processor';

// WAVE 2.1/2.2 — the host-boundary contract for the OTel SpanProcessor.
//
// This is the most exposed seam in the package: `onEnd` is called BY THE HOST'S OWN TRACING SDK, inside
// `span.end()`, which application code calls directly. A throw here does not cost one Bugsee trace — it
// propagates out of the customer's `span.end()` call, in their request path, because Bugsee is installed.
// `forceFlush` and `shutdown` are likewise invoked by the SDK during its own lifecycle.
//
// The span object is entirely host-supplied: it comes from whatever OTel version and exporter chain the
// application configured, so every property read on it is a chance to throw.

/** A ReadableSpan whose every property access throws — an exotic/proxied span from a foreign SDK build. */
const WELL_FORMED = {
  name: 'GET /users',
  spanContext: () => ({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) }),
  parentSpanId: undefined,
  startTime: [1, 0],
  endTime: [2, 0],
  attributes: {},
  status: { code: 0 },
  kind: 1,
  events: [],
  links: [],
  resource: { attributes: {} },
  instrumentationLibrary: { name: 'test' },
};

const hostileSpan = (): never =>
  new Proxy({} as never, {
    get() {
      throw new Error('hostile span');
    },
  });

describe('the OTel SpanProcessor is a contained host boundary', () => {
  it('onEnd does not throw into the host’s span.end()', () => {
    const onError = vi.fn();
    const processor = createBugseeSpanProcessor({ onTransaction: () => {}, onError });
    expect(() => processor.onEnd(hostileSpan())).not.toThrow();
    expect(onError).toHaveBeenCalled(); // contained, not silently discarded
  });

  it('onEnd does not throw when the TRANSACTION SINK throws', () => {
    // `onTransaction` is application-supplied — the app decides what to do with an assembled transaction,
    // and that code runs inside the host's own `span.end()` just the same.
    const processor = createBugseeSpanProcessor({
      onTransaction: () => {
        throw new Error('app sink failed');
      },
    });
    expect(() => processor.onEnd(WELL_FORMED as never)).not.toThrow();
  });

  it('forceFlush and shutdown resolve rather than reject into the SDK lifecycle', async () => {
    const processor = createBugseeSpanProcessor({ onTransaction: () => {} });
    await expect(processor.forceFlush()).resolves.toBeUndefined();
    await expect(processor.shutdown()).resolves.toBeUndefined();
  });

  it('still assembles a WELL-FORMED span — the guard must not swallow real work', () => {
    // The canary. Without this, "does not throw" would also be satisfied by an onEnd that does nothing.
    const onTransaction = vi.fn();
    const processor = createBugseeSpanProcessor({ onTransaction });
    processor.onEnd({
      name: 'GET /users',
      spanContext: () => ({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) }),
      parentSpanId: undefined,
      startTime: [1, 0],
      endTime: [2, 0],
      attributes: {},
      status: { code: 0 },
      kind: 1,
      events: [],
      links: [],
      resource: { attributes: {} },
      instrumentationLibrary: { name: 'test' },
    } as never);
    expect(onTransaction).toHaveBeenCalled();
  });
});
