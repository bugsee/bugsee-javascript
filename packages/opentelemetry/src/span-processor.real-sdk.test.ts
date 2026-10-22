import type { TransactionWire } from '@bugsee/performance';
import { ROOT_CONTEXT, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import { describe, expect, it } from 'vitest';
import { createBugseeSpanProcessor, readableSpanToConsumed } from './span-processor';

// The REAL @opentelemetry/sdk-trace-base 2.x (the OTel 1.x/2.x peer), not a hand-built ReadableSpan. The
// OTel 3.x twin of this file is dev-packages/otel3-compat/src/provider.test.ts (sdk-trace@3 cannot share
// this install: it peers @opentelemetry/api >=1.10, sdk-trace-base@2 peers <1.10).

function boot() {
  const transactions: TransactionWire[] = [];
  const errors: unknown[] = [];
  const processor = createBugseeSpanProcessor({
    onTransaction: (t) => transactions.push(t),
    onError: (e) => errors.push(e),
  });
  const provider = new BasicTracerProvider({ spanProcessors: [processor] });
  return { transactions, errors, provider, tracer: provider.getTracer('compat', '1.0.0') };
}

describe('a real @opentelemetry/sdk-trace-base@2 provider', () => {
  it('rebuilds the span tree from nested spans through spanProcessors', async () => {
    const { provider, tracer, transactions, errors } = boot();
    const root = tracer.startSpan('GET /orders', { kind: SpanKind.SERVER });
    const rootCtx = trace.setSpan(ROOT_CONTEXT, root);
    const db = tracer.startSpan('db.query', { kind: SpanKind.CLIENT }, rootCtx);
    const driver = tracer.startSpan('driver.send', {}, trace.setSpan(rootCtx, db));
    driver.end();
    db.end();
    root.end();
    await provider.shutdown();

    expect(errors).toEqual([]);
    expect(transactions).toHaveLength(1);
    const txn = transactions[0] as TransactionWire;
    expect(txn.spanId).toBe(root.spanContext().spanId);
    const dbWire = txn.spans.find((s) => s.operation === 'db.query');
    const driverWire = txn.spans.find((s) => s.operation === 'driver.send');
    expect(dbWire?.parentSpanId).toBe(root.spanContext().spanId);
    expect(driverWire?.parentSpanId).toBe(db.spanContext().spanId);
    expect(txn.attributes?.['otel.span.kind']).toBe(SpanKind.SERVER);
  });

  it('reads the 2.x parentSpanContext (the 1.x parentSpanId field is gone) and ms times', () => {
    const seen: Parameters<typeof readableSpanToConsumed>[0][] = [];
    const provider = new BasicTracerProvider({
      spanProcessors: [
        {
          onStart() {},
          onEnd: (span) => {
            seen.push(span);
          },
          forceFlush: async () => {},
          shutdown: async () => {},
        },
      ],
    });
    const tracer = provider.getTracer('t');
    const root = tracer.startSpan('r');
    tracer.startSpan('c', {}, trace.setSpan(ROOT_CONTEXT, root)).end();

    expect('parentSpanId' in (seen[0] as object)).toBe(false);
    const consumed = readableSpanToConsumed(
      seen[0] as Parameters<typeof readableSpanToConsumed>[0],
    );
    expect(consumed.parentSpanId).toBe(root.spanContext().spanId);
    const [sec, nanos] = (seen[0] as { startTime: [number, number] }).startTime;
    expect(consumed.startTimeMs).toBe(sec * 1000 + nanos / 1e6);
    expect(consumed.startTimeMs).toBeGreaterThan(1.7e12);
  });

  it('maps status and carries primitive attributes', async () => {
    const { provider, tracer, transactions } = boot();
    const bad = tracer.startSpan('bad', { attributes: { n: 3, tags: ['a', 'b'] } });
    bad.setStatus({ code: SpanStatusCode.ERROR, message: 'TIMEOUT' });
    bad.end();
    await provider.shutdown();

    expect(transactions[0]?.status).toBe('TIMEOUT');
    expect(transactions[0]?.attributes).toMatchObject({ n: 3, tags: ['a', 'b'] });
  });

  it('treats a remote parent as a local root', async () => {
    const { provider, tracer, transactions } = boot();
    const remote = {
      traceId: '0af7651916cd43dd8448eb211c80319c',
      spanId: 'b7ad6b7169203331',
      traceFlags: 1,
      isRemote: true,
    };
    tracer.startSpan('downstream', {}, trace.setSpanContext(ROOT_CONTEXT, remote)).end();
    await provider.shutdown();

    expect(transactions).toHaveLength(1);
    expect(transactions[0]?.traceId).toBe(remote.traceId);
  });
});
