import type { HttpRequestOptions, HttpResponse, HttpTransport } from '@bugsee/core';
import type { TransactionWire } from '@bugsee/performance';
import { describe, expect, it } from 'vitest';
import { createOtlpTraceExporter } from './otlp-exporter';

const ok: HttpResponse = { status: 200, headers: {}, body: new Uint8Array() };

const txn = (over: Partial<TransactionWire> = {}): TransactionWire => ({
  traceId: '0123456789abcdef0123456789abcdef',
  spanId: 'fedcba9876543210',
  name: '/checkout',
  operation: 'ui.load',
  status: 'OK',
  sampled: true,
  startTimestampMs: 1000,
  endTimestampMs: 1100,
  isSnapshot: false,
  spans: [],
  ...over,
});

describe('createOtlpTraceExporter', () => {
  it('POSTs the OTLP/JSON request to the traces endpoint with content-type + custom headers', async () => {
    let call: { url: string; opts: HttpRequestOptions } | undefined;
    const transport: HttpTransport = async (url, opts = {}) => {
      call = { url, opts };
      return ok;
    };
    const send = createOtlpTraceExporter({
      transport,
      url: 'https://collector.test/v1/traces',
      headers: { authorization: 'Bearer k', 'x-honeycomb-team': 'team' },
    });

    await send([txn()]);

    expect(call?.url).toBe('https://collector.test/v1/traces');
    expect(call?.opts.method).toBe('POST');
    expect(call?.opts.headers).toEqual({
      'content-type': 'application/json',
      authorization: 'Bearer k',
      'x-honeycomb-team': 'team',
    });
    const body = JSON.parse(call?.opts.body as string);
    // The body IS the Phase-A mapping (one resourceSpans, one root span for the childless transaction).
    expect(body.resourceSpans[0].scopeSpans[0].spans).toHaveLength(1);
    expect(body.resourceSpans[0].scopeSpans[0].spans[0].traceId).toBe(
      '0123456789abcdef0123456789abcdef',
    );
  });

  it('threads resource + scope into the request', async () => {
    let body:
      | {
          resourceSpans: {
            resource: { attributes: unknown[] };
            scopeSpans: { scope: unknown }[];
          }[];
        }
      | undefined;
    const transport: HttpTransport = async (_url, opts = {}) => {
      body = JSON.parse(opts.body as string);
      return ok;
    };
    const send = createOtlpTraceExporter({
      transport,
      url: 'https://c/v1/traces',
      resource: { 'service.name': 'web' },
      scope: { name: 'custom', version: '2.0' },
    });

    await send([txn()]);

    expect(body?.resourceSpans[0]?.resource.attributes).toEqual([
      { key: 'service.name', value: { stringValue: 'web' } },
      { key: 'telemetry.sdk.name', value: { stringValue: 'bugsee' } },
      { key: 'bugsee.profile.version', value: { stringValue: '1' } },
    ]);
    expect(body?.resourceSpans[0]?.scopeSpans[0]?.scope).toEqual({
      name: 'custom',
      version: '2.0',
    });
  });

  it('throws on a non-2xx response (so the uploader treats it as a failed batch)', async () => {
    const send = createOtlpTraceExporter({
      transport: async () => ({ status: 500, headers: {}, body: new Uint8Array() }),
      url: 'https://c/v1/traces',
    });
    await expect(send([txn()])).rejects.toThrow(/OTLP trace export failed \(500\)/);
  });

  it('resolves on any 2xx', async () => {
    const send = createOtlpTraceExporter({
      transport: async () => ({ status: 204, headers: {}, body: new Uint8Array() }),
      url: 'https://c/v1/traces',
    });
    await expect(send([txn()])).resolves.toBeUndefined();
  });

  /**
   * The success window is exactly 2xx, at both edges.
   *
   * The two boundaries were untested, so `>= 300` could have been `> 300` and `< 200` could have been
   * dropped entirely without a test noticing — and both mistakes silently REPORT SUCCESS for a rejected
   * export, which is the worst direction to fail in: the uploader's drop-on-failure machinery then
   * discards the batch as delivered and the traces are gone.
   */
  it.each([
    [100, false],
    [199, false],
    [200, true],
    [204, true],
    [299, true],
    [300, false],
    [301, false],
    [400, false],
    [503, false],
  ])('treats status %i as %s', async (status, succeeds) => {
    const send = createOtlpTraceExporter({
      transport: async () => ({ status, headers: {}, body: new Uint8Array() }),
      url: 'https://c/v1/traces',
    });
    if (succeeds) {
      await expect(send([txn()])).resolves.toBeUndefined();
    } else {
      await expect(send([txn()])).rejects.toThrow(
        new RegExp(`OTLP trace export failed \\(${status}\\)`),
      );
    }
  });

  it('does nothing for an empty batch (no transport call)', async () => {
    let called = false;
    const send = createOtlpTraceExporter({
      transport: async () => {
        called = true;
        return ok;
      },
      url: 'https://c/v1/traces',
    });
    await send([]);
    expect(called).toBe(false);
  });
});

describe('createOtlpTraceExporter survives hostile attributes (one attribute never rejects the batch)', () => {
  it('exports every transaction, including one carrying exotic attribute values', async () => {
    const bodies: string[] = [];
    const transport: HttpTransport = async (_url, opts = {}) => {
      bodies.push(String(opts.body));
      return ok;
    };
    const send = createOtlpTraceExporter({ transport, url: 'https://collector.test/v1/traces' });
    const huge = 'x'.repeat(8 * 1024 * 1024);
    const cyc: Record<string, unknown> = { a: 1 };
    cyc.self = cyc;
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('ownKeys');
        },
      },
    );

    await send([
      txn({ attributes: { cyc, big: { a: huge, b: [huge, huge] }, bytes: new Uint8Array(1e6) } }),
      txn({ spanId: '1111111111111111', attributes: hostile }),
      txn({ spanId: '2222222222222222', attributes: { ok: 'yes' } }),
    ]);

    expect(bodies).toHaveLength(1);
    const spans = (
      JSON.parse(bodies[0] as string) as {
        resourceSpans: { scopeSpans: { spans: { spanId: string }[] }[] }[];
      }
    ).resourceSpans[0]?.scopeSpans[0]?.spans;
    expect(spans?.map((s) => s.spanId)).toEqual([
      'fedcba9876543210',
      '1111111111111111',
      '2222222222222222',
    ]);
    expect(bodies[0]?.length).toBeLessThan(100_000);
  });
});
