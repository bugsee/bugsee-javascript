import { attachBugseeOtelProvider } from '@bugsee/nextjs/server';
import { createBugseeSpanProcessor } from '@bugsee/opentelemetry';
import type { TransactionWire } from '@bugsee/performance';
import { trace } from '@opentelemetry/api';
import { afterEach, describe, expect, it } from 'vitest';
import { OTEL3_SKIP_NOTE, otel3Supported } from './node-gate';

// `@bugsee/nextjs` registers its OWN OpenTelemetry provider when none exists (zero-config tracing for Next.js).
// Its unit tests cover the OpenTelemetry 3.x branch (`sdk-trace`'s `TracerProvider`, since 3.x removed
// `sdk-trace-base`) only with mocks. Here the real, unmodified `attachBugseeOtelProvider` runs against a REAL
// `@opentelemetry/sdk-trace@3`: vitest.config.ts aliases `sdk-trace-base` to a module that throws (as on a 3.x
// install) and points `sdk-trace` / `api` at this package's 3.x copies.

function bugsee(): {
  processor: ReturnType<typeof createBugseeSpanProcessor>;
  transactions: TransactionWire[];
  errors: unknown[];
} {
  const transactions: TransactionWire[] = [];
  const errors: unknown[] = [];
  const processor = createBugseeSpanProcessor({
    onTransaction: (t) => transactions.push(t),
    onError: (e) => errors.push(e),
  });
  return { processor, transactions, errors };
}

afterEach(() => {
  trace.disable(); // the global provider slot is process-wide; free it for the next test
});

describe.skipIf(!otel3Supported)(
  `@bugsee/nextjs zero-config provider on a real @opentelemetry/sdk-trace@3 (${OTEL3_SKIP_NOTE})`,
  () => {
    it('simulates an OpenTelemetry 3 install: no sdk-trace-base, a TracerProvider in sdk-trace', async () => {
      // @ts-expect-error not installed on OpenTelemetry 3: the alias in vitest.config.ts makes it throw like a missing module
      await expect(import('@opentelemetry/sdk-trace-base')).rejects.toThrow(/Cannot find module/);
      const sdk = await import('@opentelemetry/sdk-trace');
      expect(typeof sdk.TracerProvider).toBe('function');
      expect((sdk as Record<string, unknown>).BasicTracerProvider).toBeUndefined();
    });

    it('registers its own provider through sdk-trace and Bugsee receives the spans Next emits', async () => {
      const { processor, transactions, errors } = bugsee();
      const outcome = await attachBugseeOtelProvider(processor, { onError: (e) => errors.push(e) });

      expect(outcome).toBe('registered');
      // Registered through sdk-trace@3's TracerProvider, not a leaked 2.x BasicTracerProvider.
      const sdk = await import('@opentelemetry/sdk-trace');
      const global = trace.getTracerProvider() as unknown as { getDelegate(): unknown };
      expect(global.getDelegate()).toBeInstanceOf(sdk.TracerProvider);
      trace.getTracer('next.js').startSpan('GET /api/users').end();

      expect(errors).toEqual([]);
      expect(transactions).toHaveLength(1);
      expect(transactions[0]?.name).toBe('GET /api/users');
    });

    it('keeps an already registered provider (first wins), tells the user, and does not feed Bugsee', async () => {
      const sdk = await import('@opentelemetry/sdk-trace');
      const ownSpans: string[] = [];
      const existing = new sdk.TracerProvider({
        spanProcessors: [
          {
            onStart: () => {},
            onEnd: (span) => ownSpans.push(span.name),
            forceFlush: () => Promise.resolve(),
            shutdown: () => Promise.resolve(),
          },
        ],
      });
      expect(trace.setGlobalTracerProvider(existing)).toBe(true);

      const { processor, transactions } = bugsee();
      const notices: unknown[] = [];
      const outcome = await attachBugseeOtelProvider(processor, {
        onError: (e) => notices.push(e),
      });

      expect(outcome).toBe('existing-provider');
      expect(String(notices[0])).toMatch(/already registered/);
      trace.getTracer('next.js').startSpan('GET /still-theirs').end();
      expect(ownSpans).toEqual(['GET /still-theirs']);
      expect(transactions).toEqual([]);
    });
  },
);
