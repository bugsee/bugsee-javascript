import { createBugseeSpanProcessor } from '@bugsee/opentelemetry';
import type { TransactionWire } from '@bugsee/performance';
import { describe, expect, it } from 'vitest';
import { OTEL3_SKIP_NOTE, otel3Supported } from './node-gate';

// The documented registration on OpenTelemetry JS 3.x: `new TracerProvider({ spanProcessors: [...] })` from
// `@opentelemetry/sdk-trace` (3.0 removed `sdk-trace-base`, and `BasicTracerProvider` was renamed
// `TracerProvider`). Spans are produced by the REAL SDK, not a hand-built ReadableSpan.
describe.skipIf(!otel3Supported)(
  `a real @opentelemetry/sdk-trace@3 provider (${OTEL3_SKIP_NOTE})`,
  () => {
    it('delivers a finished span to the Bugsee processor registered through spanProcessors', async () => {
      const { TracerProvider } = await import('@opentelemetry/sdk-trace');
      const transactions: TransactionWire[] = [];
      const processor = createBugseeSpanProcessor({ onTransaction: (t) => transactions.push(t) });
      const provider = new TracerProvider({ spanProcessors: [processor] });

      provider.getTracer('t').startSpan('GET /users').end();
      await provider.shutdown();

      expect(transactions).toHaveLength(1);
      expect(transactions[0]?.name).toBe('GET /users');
    });
  },
);
