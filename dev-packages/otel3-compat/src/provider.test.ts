import {
  createBugseeSpanProcessor,
  readableSpanToConsumed,
  toOtlpExportRequest,
} from '@bugsee/opentelemetry';
import type { TransactionWire } from '@bugsee/performance';
import { type Context, ROOT_CONTEXT, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { describe, expect, it } from 'vitest';
import { OTEL3_SKIP_NOTE, otel3Supported } from './node-gate';

// The documented registration on OpenTelemetry JS 3.x: `new TracerProvider({ spanProcessors: [...] })` from
// `@opentelemetry/sdk-trace` (3.0 removed `sdk-trace-base`, and `BasicTracerProvider` was renamed
// `TracerProvider`). Spans are produced by the REAL SDK, not a hand-built ReadableSpan, so a change in the
// 3.x ReadableSpan shape (parent field, attribute widening, time encoding) fails here.

type Sdk = typeof import('@opentelemetry/sdk-trace');

async function boot(): Promise<{
  sdk: Sdk;
  transactions: TransactionWire[];
  errors: unknown[];
  provider: InstanceType<Sdk['TracerProvider']>;
  tracer: ReturnType<InstanceType<Sdk['TracerProvider']>['getTracer']>;
  seen: Parameters<ReturnType<typeof createBugseeSpanProcessor>['onEnd']>[0][];
}> {
  const sdk = await import('@opentelemetry/sdk-trace');
  const transactions: TransactionWire[] = [];
  const errors: unknown[] = [];
  const seen: Parameters<ReturnType<typeof createBugseeSpanProcessor>['onEnd']>[0][] = [];
  const inner = createBugseeSpanProcessor({
    onTransaction: (t) => transactions.push(t),
    onError: (e) => errors.push(e),
  });
  // A spy in front of the Bugsee processor records the REAL ReadableSpan the SDK hands over.
  const processor = {
    onStart: () => inner.onStart(),
    onEnd: (span: Parameters<typeof inner.onEnd>[0]) => {
      seen.push(span);
      inner.onEnd(span);
    },
    forceFlush: () => inner.forceFlush(),
    shutdown: () => inner.shutdown(),
  };
  const provider = new sdk.TracerProvider({
    resource: undefined,
    spanProcessors: [processor],
  });
  return {
    sdk,
    transactions,
    errors,
    provider,
    tracer: provider.getTracer('compat', '1.0.0'),
    seen,
  };
}

describe.skipIf(!otel3Supported)(
  `a real @opentelemetry/sdk-trace@3 provider (${OTEL3_SKIP_NOTE})`,
  () => {
    it('delivers a finished span to the Bugsee processor registered through spanProcessors', async () => {
      const { provider, tracer, transactions, errors } = await boot();

      tracer.startSpan('GET /users').end();
      await provider.shutdown();

      expect(errors).toEqual([]);
      expect(transactions).toHaveLength(1);
      expect(transactions[0]?.name).toBe('GET /users');
    });

    it('exposes the 3.x ReadableSpan shape ReadableSpanLike reads (parentSpanContext, HrTime, status)', async () => {
      const { tracer, seen } = await boot();
      const root = tracer.startSpan('root');
      const ctx = trace.setSpan(ROOT_CONTEXT, root);
      const child = tracer.startSpan('child', {}, ctx);
      child.end();
      root.end();

      const [childSpan, rootSpan] = seen;
      // 3.x: the parent is `parentSpanContext` only; the 1.x `parentSpanId` field is gone.
      expect('parentSpanId' in (childSpan as object)).toBe(false);
      expect(childSpan?.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
      expect(rootSpan?.parentSpanContext).toBeUndefined();
      expect(childSpan?.startTime).toEqual(expect.arrayContaining([expect.any(Number)]));
      expect(childSpan?.startTime).toHaveLength(2);
      expect(childSpan?.status).toEqual({ code: SpanStatusCode.UNSET });
    });

    it('rebuilds the span tree from nested spans: one transaction per trace, children linked by parent id', async () => {
      const { provider, tracer, transactions, errors } = await boot();

      const root = tracer.startSpan('GET /orders', { kind: SpanKind.SERVER });
      const rootCtx = trace.setSpan(ROOT_CONTEXT, root);
      const db = tracer.startSpan('db.query', { kind: SpanKind.CLIENT }, rootCtx);
      const dbCtx = trace.setSpan(rootCtx, db);
      const driver = tracer.startSpan('driver.send', {}, dbCtx);
      driver.end();
      db.end();
      root.end();
      await provider.shutdown();

      expect(errors).toEqual([]);
      expect(transactions).toHaveLength(1);
      const txn = transactions[0] as TransactionWire;
      expect(txn.traceId).toBe(root.spanContext().traceId);
      expect(txn.spanId).toBe(root.spanContext().spanId);
      expect(txn.name).toBe('GET /orders');
      expect(txn.spans.map((s) => s.operation).sort()).toEqual(['db.query', 'driver.send']);
      const dbWire = txn.spans.find((s) => s.operation === 'db.query');
      const driverWire = txn.spans.find((s) => s.operation === 'driver.send');
      expect(dbWire?.spanId).toBe(db.spanContext().spanId);
      expect(dbWire?.parentSpanId).toBe(root.spanContext().spanId);
      expect(driverWire?.parentSpanId).toBe(db.spanContext().spanId);
      expect(txn.attributes?.['otel.span.kind']).toBe(SpanKind.SERVER);
      expect(dbWire?.attributes?.['otel.span.kind']).toBe(SpanKind.CLIENT);
    });

    it('carries attributes of every primitive and homogeneous-array kind through unchanged', async () => {
      const { provider, tracer, transactions } = await boot();

      const span = tracer.startSpan('attrs', {
        attributes: {
          s: 'x',
          n: 3,
          f: 1.5,
          b: true,
          strs: ['a', 'b'],
          nums: [1, 2],
          bools: [true, false],
        },
      });
      span.setAttribute('late', 'set-after-start');
      span.end();
      await provider.shutdown();

      expect(transactions[0]?.attributes).toMatchObject({
        s: 'x',
        n: 3,
        f: 1.5,
        b: true,
        strs: ['a', 'b'],
        nums: [1, 2],
        bools: [true, false],
        late: 'set-after-start',
      });
    });

    it('maps span status: OK, ERROR with a message, and UNSET', async () => {
      const { provider, tracer, transactions } = await boot();

      const ok = tracer.startSpan('ok');
      ok.setStatus({ code: SpanStatusCode.OK });
      ok.end();
      const bad = tracer.startSpan('bad');
      bad.setStatus({ code: SpanStatusCode.ERROR, message: 'TIMEOUT' });
      bad.end();
      const plain = tracer.startSpan('plain');
      plain.end();
      await provider.shutdown();

      const byName = Object.fromEntries(transactions.map((t) => [t.name, t.status]));
      expect(byName).toEqual({ ok: 'OK', bad: 'TIMEOUT', plain: 'UNKNOWN' });
    });

    it('survives events, links, recordException and resource (lossy by design, never throws)', async () => {
      const { sdk, provider, tracer, transactions, errors, seen } = await boot();
      const other = tracer.startSpan('other');
      other.end();

      const span = tracer.startSpan('rich', { links: [{ context: other.spanContext() }] });
      span.addEvent('cache.miss', { key: 'k' });
      span.recordException(new Error('boom'));
      span.setStatus({ code: SpanStatusCode.ERROR, message: 'boom' });
      span.end();
      await provider.shutdown();

      const real = seen.find((s) => s.name === 'rich') as unknown as {
        events: { name: string }[];
        links: unknown[];
        resource: { attributes: Record<string, unknown> };
      };
      expect(real.events.map((e) => e.name)).toEqual(['cache.miss', 'exception']);
      expect(real.links).toHaveLength(1);
      expect(real.resource.attributes['telemetry.sdk.language']).toBe('nodejs');
      expect(errors).toEqual([]);
      const txn = transactions.find((t) => t.name === 'rich') as TransactionWire;
      expect(txn.status).toBe('ERROR');
      void sdk;
    });

    it('treats a remote parent as a local root, so a downstream service still yields a transaction', async () => {
      const { provider, tracer, transactions } = await boot();
      const remote = {
        traceId: '0af7651916cd43dd8448eb211c80319c',
        spanId: 'b7ad6b7169203331',
        traceFlags: 1,
        isRemote: true,
      };
      const ctx: Context = trace.setSpanContext(ROOT_CONTEXT, remote);

      tracer.startSpan('downstream', {}, ctx).end();
      await provider.shutdown();

      expect(transactions).toHaveLength(1);
      const txn = transactions[0] as TransactionWire;
      expect(txn.traceId).toBe(remote.traceId);
      expect(txn.parentSpanId).toBeUndefined();
    });

    it('readableSpanToConsumed on a real span: ids, ms times, kind and parent', async () => {
      const { tracer, seen } = await boot();
      const root = tracer.startSpan('r');
      const child = tracer.startSpan(
        'c',
        { kind: SpanKind.PRODUCER },
        trace.setSpan(ROOT_CONTEXT, root),
      );
      child.end();
      root.end();

      const consumed = readableSpanToConsumed(seen[0] as never);
      expect(consumed.spanId).toBe(child.spanContext().spanId);
      expect(consumed.parentSpanId).toBe(root.spanContext().spanId);
      expect(consumed.kind).toBe(SpanKind.PRODUCER);
      expect(consumed.endTimeMs).toBeGreaterThanOrEqual(consumed.startTimeMs);
      // Epoch milliseconds, not process-relative time, converted from the SDK's [seconds, nanos] HrTime.
      const [startSec, startNanos] = (seen[0] as { startTime: [number, number] }).startTime;
      const [endSec, endNanos] = (seen[0] as { endTime: [number, number] }).endTime;
      expect(consumed.startTimeMs).toBe(startSec * 1000 + startNanos / 1e6);
      expect(consumed.endTimeMs).toBe(endSec * 1000 + endNanos / 1e6);
      expect(consumed.startTimeMs).toBeGreaterThan(1.7e12);
    });

    it('feeds the OTLP export path: a consumed 3.x trace round-trips to a valid ExportTraceServiceRequest', async () => {
      const { provider, tracer, transactions } = await boot();
      const root = tracer.startSpan('GET /pay', { attributes: { 'http.route': '/pay' } });
      const child = tracer.startSpan('charge', {}, trace.setSpan(ROOT_CONTEXT, root));
      child.end();
      root.end();
      await provider.shutdown();

      const request = toOtlpExportRequest(transactions, { resource: { 'service.name': 'compat' } });
      const spans = request.resourceSpans[0]?.scopeSpans[0]?.spans ?? [];
      expect(spans).toHaveLength(2);
      const byName = Object.fromEntries(spans.map((s) => [s.name, s]));
      expect(byName['GET /pay']?.spanId).toBe(root.spanContext().spanId);
      expect(byName.charge?.parentSpanId).toBe(root.spanContext().spanId);
      expect(byName['GET /pay']?.traceId).toBe(root.spanContext().traceId);
      const keys = (byName['GET /pay']?.attributes ?? []).map((kv) => kv.key);
      expect(keys).toContain('http.route');
      expect(JSON.parse(JSON.stringify(request))).toEqual(request);
    });

    it('keeps the host span.end() alive when the Bugsee sink throws (contained boundary on the real SDK)', async () => {
      const sdk = await import('@opentelemetry/sdk-trace');
      const errors: unknown[] = [];
      const processor = createBugseeSpanProcessor({
        onTransaction: () => {
          throw new Error('sink down');
        },
        onError: (e) => errors.push(e),
      });
      const provider = new sdk.TracerProvider({ spanProcessors: [processor] });

      expect(() => provider.getTracer('t').startSpan('x').end()).not.toThrow();
      expect(errors).toHaveLength(1);
    });
  },
);
