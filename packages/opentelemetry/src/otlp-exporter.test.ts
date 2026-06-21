import type { HttpRequestOptions, HttpResponse, HttpTransport } from '@bugsee/core';
import type { TransactionWire } from '@bugsee/performance';
import { describe, expect, it } from 'vitest';
import { createOtlpTraceExporter } from './otlp-exporter';

const ok: HttpResponse = { status: 200, headers: {}, body: new Uint8Array() };

const txn = (over: Partial<TransactionWire> = {}): TransactionWire => ({
  traceId: '0123456789abcdef0123456789abcdef',
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
