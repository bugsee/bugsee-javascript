import { BugseeError, type HttpTransport } from '@bugsee/core';
import type { TransactionWire } from '@bugsee/performance';
import { toOtlpExportRequest } from './to-otlp';

// Phase B (Produce): the lightweight OTLP/HTTP-JSON trace exporter. Maps a batch of Bugsee transactions
// (via the Phase-A mapping) to an OTLP ExportTraceServiceRequest and POSTs it as application/json to the
// user's collector/endpoint. It returns a `send`-shaped function — drop-in for the performance uploader's
// injected `send` — so the uploader's drain/flush/drop-on-failure machinery delivers to OTLP backends.
// Hand-rolled (no @opentelemetry/* dependency); the transport is injected (node:http / fetch / a fake).

export interface OtlpTraceExporterOptions {
  transport: HttpTransport;
  /** The full OTLP/HTTP traces endpoint, e.g. `https://collector.example/v1/traces`. */
  url: string;
  /**
   * Extra request headers (e.g. `authorization`, `x-honeycomb-team`, `api-key`). Use lowercase keys —
   * the merge is case-sensitive, so a lowercase `content-type` overrides the default while a
   * differently-cased duplicate would be sent alongside it.
   */
  headers?: Record<string, string>;
  /** Resource attributes (e.g. `service.name`) applied to every exported span. */
  resource?: Record<string, unknown>;
  /** Instrumentation scope override (name defaults to `@bugsee/opentelemetry`). */
  scope?: { name?: string; version?: string };
}

export function createOtlpTraceExporter(
  options: OtlpTraceExporterOptions,
): (transactions: TransactionWire[]) => Promise<void> {
  return async (transactions) => {
    if (transactions.length === 0) return; // nothing to export
    const request = toOtlpExportRequest(transactions, {
      ...(options.resource !== undefined ? { resource: options.resource } : {}),
      ...(options.scope !== undefined ? { scope: options.scope } : {}),
    });
    const response = await options.transport(options.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...options.headers },
      body: JSON.stringify(request),
    });
    if (response.status < 200 || response.status >= 300) {
      throw new BugseeError(`OTLP trace export failed (${response.status})`, response.status);
    }
  };
}
