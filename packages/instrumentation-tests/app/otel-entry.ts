// The OpenTelemetry battery, run in a REAL node process against the real mock collector.
//
// It installs the SDK the way a customer with an existing OTel setup does: through the `@bugsee/bugsee`
// umbrella, with `otelConsume` (Bugsee hands back a `SpanProcessor` to register on THEIR TracerProvider)
// and `otelExportUrl` (the produce tee — finished transactions are also exported as OTLP/HTTP-JSON to
// their own backend). Both directions run at once, which is the configuration nothing had ever exercised
// end to end: the unit suites drive the mapping functions with hand-built span objects, so a break in the
// wiring BETWEEN a real OTel SDK and the upload was invisible.
//
// Real `@opentelemetry/sdk-trace-base` (not a fake ReadableSpan), real span parenting, real HTTP.
import process from 'node:process';
import { launch } from '@bugsee/bugsee';
import type { BugseeSpanProcessor } from '@bugsee/opentelemetry';
import { context, SpanStatusCode, trace } from '@opentelemetry/api';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import { OTEL_CHILD_SPAN, OTEL_ROOT_SPAN } from './otel-entry-names';

async function main(): Promise<void> {
  const collectorUrl = process.env.BUGSEE_E2E_COLLECTOR;
  if (collectorUrl === undefined || collectorUrl === '') {
    console.error('[e2e] BUGSEE_E2E_COLLECTOR is not set');
    process.exit(2);
  }

  let spanProcessor: BugseeSpanProcessor | undefined;
  // Cast for the same reason `entry-umbrella.ts` casts: `@bugsee/bugsee` resolves its runtime condition
  // at RUNTIME, so this file type-checks against the umbrella's default (browser) options, which do not
  // declare the node-tier diagnostics below. They are turned off deliberately — `detectHangs` defaults to
  // true and would spawn a watchdog worker thread in a process whose whole job is to emit two spans.
  const client = await launch('e2e-app-token', {
    endpoint: collectorUrl,
    appVersion: '1.2.3',
    appBuild: '42',
    recover: false,
    detectHangs: false,
    profiling: false,
    // Consume: Bugsee gives us a SpanProcessor for OUR provider.
    otelConsume: true,
    onOtelSpanProcessor: (processor: BugseeSpanProcessor) => {
      spanProcessor = processor;
    },
    // Produce: tee every finished transaction to an OTLP/HTTP-JSON endpoint as well.
    otelExportUrl: `${collectorUrl}/v1/traces`,
    otelExportResource: { 'service.name': 'e2e-otel-service' },
    onError: (e: unknown) => console.error('[bugsee onError]', e),
  } as Parameters<typeof launch>[1]);

  if (spanProcessor === undefined) {
    throw new Error('the umbrella never handed back a SpanProcessor');
  }

  // A REAL OTel tracer provider, with Bugsee's processor registered on it exactly as documented.
  const provider = new BasicTracerProvider({ spanProcessors: [spanProcessor] });
  const tracer = provider.getTracer('e2e-tracer', '0.0.1');

  const root = tracer.startSpan(OTEL_ROOT_SPAN, { attributes: { 'http.route': '/checkout' } });
  const child = tracer.startSpan(
    OTEL_CHILD_SPAN,
    { attributes: { 'db.system': 'postgresql' } },
    trace.setSpan(context.active(), root),
  );
  child.setStatus({ code: SpanStatusCode.OK });
  child.end();
  root.end();

  // Report the ids the process actually minted, so the test asserts against THIS run rather than against
  // whatever happens to be in the payload.
  console.log(
    `[e2e] traceId=${root.spanContext().traceId} rootSpanId=${root.spanContext().spanId} childSpanId=${child.spanContext().spanId}`,
  );

  await provider.forceFlush();
  await client.flush(20_000);
  await provider.shutdown();
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error('[e2e] otel scenario failed', err);
    process.exit(3);
  },
);
