// The OpenTelemetry two-way bridge, end to end: a REAL `@opentelemetry/sdk-trace-base` provider in a
// REAL node process, Bugsee's SpanProcessor registered on it, and the resulting transactions asserted on
// the wire — both on Bugsee's own performance endpoint and on the OTLP tee.
//
// What was missing. `@bugsee/opentelemetry` has thorough unit tests, but every one of them drives the
// mapping functions with hand-built `ReadableSpan` objects. Nothing exercised the path from a real OTel
// span through the umbrella's wiring to an HTTP request — and nothing at all exercised the transaction
// upload, because the mock collector had no `/v2/performance/transactions` route until this suite added
// one. Every APM batch in every previous e2e 404'd into `onError`, unseen.
//
// Node only, deliberately. The subject here is the OTel wiring, which is runtime-independent; running the
// same battery under bun and deno would re-test their `@opentelemetry/*` module resolution rather than
// anything about the bridge. The runtime matrix is covered by `instrumentation.e2e.ts`.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { type MockCollector, startMockCollector } from '@bugsee/e2e-kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OTEL_CHILD_SPAN, OTEL_ROOT_SPAN } from '../app/otel-entry-names';

const pkgRoot = fileURLToPath(new URL('..', import.meta.url));
const tsxBin = fileURLToPath(new URL('../../../node_modules/.bin/tsx', import.meta.url));
const entry = fileURLToPath(new URL('../app/otel-entry.ts', import.meta.url));

interface Run {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function runOtelProcess(collectorUrl: string): Promise<Run> {
  return new Promise<Run>((resolve, reject) => {
    const child = spawn(tsxBin, [entry], {
      cwd: pkgRoot,
      env: { ...process.env, BUGSEE_E2E_COLLECTOR: collectorUrl },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString();
    });
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString();
    });
    child.on('error', reject);
    child.on('exit', (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}

/** The trace/span ids the child process actually minted, read back from its own output. */
function idsFrom(stdout: string): { traceId: string; rootSpanId: string; childSpanId: string } {
  const match = /traceId=([0-9a-f]+) rootSpanId=([0-9a-f]+) childSpanId=([0-9a-f]+)/.exec(stdout);
  if (match === null) {
    throw new Error(`the child never reported its ids. stdout:\n${stdout}`);
  }
  return {
    traceId: match[1] as string,
    rootSpanId: match[2] as string,
    childSpanId: match[3] as string,
  };
}

/** The `TransactionWire` fields these assertions read (`@bugsee/performance`, camelCase on the wire). */
interface TransactionWireish {
  name?: string;
  traceId?: string;
  spanId?: string;
  /** A child span carries the OTel span name as `operation` — OTel has no separate name/operation split. */
  spans?: Array<{ operation?: string; spanId?: string; parentSpanId?: string }>;
  [key: string]: unknown;
}

interface OtlpRequest {
  resourceSpans?: Array<{
    resource?: { attributes?: Array<{ key: string; value: Record<string, unknown> }> };
    scopeSpans?: Array<{
      scope?: { name?: string };
      spans?: Array<{ name?: string; traceId?: string; spanId?: string; parentSpanId?: string }>;
    }>;
  }>;
}

describe('@bugsee/opentelemetry — a real OTel SDK through the umbrella, end to end', () => {
  let collector: MockCollector;
  let run: Run;
  let ids: ReturnType<typeof idsFrom>;

  beforeAll(async () => {
    collector = await startMockCollector();
    run = await runOtelProcess(collector.url);
    ids = idsFrom(run.stdout);
  }, 120_000);

  afterAll(async () => {
    await collector?.close();
  });

  it('runs to completion with no SDK-internal errors', () => {
    expect(run.exitCode, `stderr:\n${run.stderr}`).toBe(0);
    // `onError` prints with this prefix; anything here means the SDK swallowed a failure the user would
    // never see. It is the assertion that caught the 404ing performance endpoint.
    expect(run.stderr).not.toContain('[bugsee onError]');
  });

  describe('consume: the customer’s OTel spans become Bugsee transactions', () => {
    it('uploads one transaction for the trace, carrying the real trace id', () => {
      const own = (collector.transactions as TransactionWireish[]).filter(
        (t) => t.traceId === ids.traceId,
      );
      expect(
        own.length,
        `no transaction for trace ${ids.traceId}; saw ${JSON.stringify(
          (collector.transactions as TransactionWireish[]).map((t) => ({
            name: t.name,
            trace: t.traceId,
          })),
        )}`,
      ).toBe(1);
      expect(own[0]?.name).toBe(OTEL_ROOT_SPAN);
      expect(own[0]?.spanId).toBe(ids.rootSpanId);
    });

    it('keeps the child span, parented to the root — the tree, not just the root', () => {
      const own = (collector.transactions as TransactionWireish[]).find(
        (t) => t.traceId === ids.traceId,
      );
      const child = (own?.spans ?? []).find((s) => s.operation === OTEL_CHILD_SPAN);
      expect(child, `spans: ${JSON.stringify(own?.spans)}`).toBeDefined();
      expect(child?.spanId).toBe(ids.childSpanId);
      expect(child?.parentSpanId).toBe(ids.rootSpanId);
    });
  });

  describe('produce: the same transaction is teed to the OTLP endpoint', () => {
    const spansOf = (requests: OtlpRequest[]) =>
      requests.flatMap(
        (r) =>
          r.resourceSpans?.flatMap((rs) => rs.scopeSpans?.flatMap((ss) => ss.spans ?? []) ?? []) ??
          [],
      );

    it('posts OTLP/HTTP-JSON carrying the same trace', () => {
      const spans = spansOf(collector.otlpTraces as OtlpRequest[]).filter(
        (s) => s.traceId === ids.traceId,
      );
      expect(
        spans.length,
        `no OTLP span for trace ${ids.traceId} in ${collector.otlpTraces.length} export(s)`,
      ).toBeGreaterThan(0);
      expect(spans.some((s) => s.name === OTEL_ROOT_SPAN && s.spanId === ids.rootSpanId)).toBe(
        true,
      );
    });

    it('declares the Bugsee instrumentation scope and the configured resource', () => {
      const requests = collector.otlpTraces as OtlpRequest[];
      const scopes = requests.flatMap(
        (r) =>
          r.resourceSpans?.flatMap((rs) => rs.scopeSpans?.map((ss) => ss.scope?.name) ?? []) ?? [],
      );
      // Profile v1 §5: `com.bugsee.<sdk>/<providerId>`, `nodejs` on the node family.
      expect(scopes).toContain('com.bugsee.nodejs/performance');

      const resourceKeys = requests.flatMap(
        (r) =>
          r.resourceSpans?.flatMap((rs) => rs.resource?.attributes?.map((a) => a.key) ?? []) ?? [],
      );
      expect(resourceKeys).toContain('service.name');
    });

    it('is a TEE, not a redirect — Bugsee received the transaction as well', () => {
      // The failure this guards is the easy one to ship: configuring an OTLP endpoint silently diverting
      // the customer's data away from Bugsee.
      const inBugsee = (collector.transactions as TransactionWireish[]).some(
        (t) => t.traceId === ids.traceId,
      );
      const inOtlp = spansOf(collector.otlpTraces as OtlpRequest[]).some(
        (s) => s.traceId === ids.traceId,
      );
      expect({ inBugsee, inOtlp }).toEqual({ inBugsee: true, inOtlp: true });
    });
  });
});
