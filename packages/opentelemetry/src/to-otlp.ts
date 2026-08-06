import type { SpanStatus, TransactionWire } from '@bugsee/performance';
import {
  OTLP_SPAN_FLAG_SAMPLED,
  type OtlpAnyValue,
  type OtlpExportTraceServiceRequest,
  type OtlpKeyValue,
  type OtlpScope,
  type OtlpSpan,
  OtlpSpanKind,
  type OtlpStatus,
  OtlpStatusCode,
} from './otlp-wire';

// The Produce-direction mapping: Bugsee performance transactions (§8.8) → the OTLP/HTTP-JSON trace wire.
// Pure + runtime-portable (no @opentelemetry/* deps). Phase A of docs/design/opentelemetry-integration.md.
//
// The §8.8 wire deliberately omits the root span's id (the root is the transaction; only children carry
// spanId/parentSpanId). OTLP needs every span to have an id and children to link to the root, so we
// DERIVE a stable root span id from the trace id and remap any "dangling" child parent (one that points
// at the dropped root, or is absent) to it — without piercing the §8.8 wire.
//
// `durationNanos` is intentionally NOT emitted: OTLP derives a span's duration from start/end, which our
// model always sets together (durationNanos is never present without endTimestampMs). The only loss is
// sub-millisecond precision — our durationNanos is monotonic-clock nanos, while OTLP's derived duration
// is integer wall-clock `end - start` ms. Acceptable for trace interop.

const DEFAULT_SCOPE_NAME = '@bugsee/opentelemetry';

/** Wall-clock ms → a decimal nanosecond string (BigInt, so values beyond 2^53 keep full precision). */
export function toUnixNanoString(ms: number): string {
  return (BigInt(Math.round(ms)) * 1_000_000n).toString();
}

/** Map a JS attribute value to an OTLP `AnyValue`; `undefined` (key dropped) for null/undefined/unencodable. */
export function toAnyValue(value: unknown): OtlpAnyValue | undefined {
  if (value === undefined || value === null) return undefined;
  switch (typeof value) {
    case 'string':
      return { stringValue: value };
    case 'boolean':
      return { boolValue: value };
    case 'bigint':
      return { intValue: value.toString() };
    case 'number':
      return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
    default: {
      const json = JSON.stringify(value); // objects/arrays → string; functions/symbols → undefined (dropped)
      return json !== undefined ? { stringValue: json } : undefined;
    }
  }
}

/** Map an attributes record to OTLP `KeyValue[]`, dropping keys whose value does not encode. */
export function toKeyValues(attributes: Record<string, unknown> | undefined): OtlpKeyValue[] {
  const out: OtlpKeyValue[] = [];
  if (attributes === undefined) return out;
  for (const [key, raw] of Object.entries(attributes)) {
    const value = toAnyValue(raw);
    if (value !== undefined) out.push({ key, value });
  }
  return out;
}

/** Map a Bugsee `SpanStatus` to an OTLP `Status` (OK→OK, UNKNOWN→UNSET, else→ERROR with the name as message). */
export function toStatus(status: SpanStatus): OtlpStatus {
  if (status === 'OK') return { code: OtlpStatusCode.OK };
  if (status === 'UNKNOWN') return { code: OtlpStatusCode.UNSET };
  return { code: OtlpStatusCode.ERROR, message: status };
}

const KIND_BY_NAME: Record<string, number> = {
  INTERNAL: OtlpSpanKind.INTERNAL,
  SERVER: OtlpSpanKind.SERVER,
  CLIENT: OtlpSpanKind.CLIENT,
  PRODUCER: OtlpSpanKind.PRODUCER,
  CONSUMER: OtlpSpanKind.CONSUMER,
};

/**
 * OTLP span kind (Profile v1 §6): an explicit `bugsee.span.kind` attribute wins; else inbound server
 * (`http.server`) → SERVER, outgoing call (`http.client`) → CLIENT, everything else → INTERNAL.
 */
export function spanKindFor(operation: string, attributes?: Record<string, unknown>): number {
  const override = attributes?.['bugsee.span.kind'];
  if (typeof override === 'string' && override in KIND_BY_NAME) {
    return KIND_BY_NAME[override] as number;
  }
  if (operation.startsWith('http.server')) return OtlpSpanKind.SERVER;
  if (operation.startsWith('http.client')) return OtlpSpanKind.CLIENT;
  return OtlpSpanKind.INTERNAL;
}

/**
 * LEGACY FALLBACK ONLY — a span id derived from the trace id, for a `TransactionWire` that predates the
 * `spanId` field. Do not use for new payloads.
 *
 * This used to produce EVERY root span id, and the reasoning above it ("collision … is ~2^-64") answered
 * the wrong question. Collision with a sibling child was never the risk; determinism was. The id it
 * returns is a pure function of the trace id, so every service in a distributed trace produced the SAME
 * root id — and, worse, `traceparent` propagates the transaction's REAL span id, so a downstream root's
 * parent pointed at a span that was never emitted. The trace broke at every boundary (Wave 5.3).
 */
export function deriveRootSpanId(traceId: string): string {
  return traceId.slice(0, 16).toLowerCase();
}

/** Map one transaction to its OTLP spans: the derived root span followed by its (tree-linked) children. */
export function transactionToOtlpSpans(txn: TransactionWire): OtlpSpan[] {
  // The transaction's REAL span id — the one `traceparent` propagates, so an upstream root and a
  // downstream `parentSpanId` actually meet. Falls back to the derived form only for a legacy wire.
  const rootSpanId = txn.spanId ?? deriveRootSpanId(txn.traceId);
  const childIds = new Set(txn.spans.map((s) => s.spanId));
  // Profile v1 §8: the OTLP span trace_flags sampled bit MUST mirror the transaction's sampling decision.
  // Every span shares that one decision (the Bugsee §8.8 transaction wire carries a single root-level
  // `sampled`, not a per-span one).
  const flags = txn.sampled ? OTLP_SPAN_FLAG_SAMPLED : 0;

  const rootAttributes: Record<string, unknown> = {
    ...txn.attributes,
    // Profile v1 §6/§10 root requirements: the transaction name, the sampling decision, the lossless
    // original status, plus the operation + app info + snapshot flag.
    'bugsee.transaction.name': txn.name,
    'bugsee.sampled': txn.sampled,
    'bugsee.span.status': txn.status,
    'bugsee.operation': txn.operation,
    ...(txn.appVersion !== undefined ? { 'bugsee.app.version': txn.appVersion } : {}),
    ...(txn.appBuild !== undefined ? { 'bugsee.app.build': txn.appBuild } : {}),
    ...(txn.isSnapshot ? { 'bugsee.snapshot': true } : {}),
  };
  const root: OtlpSpan = {
    traceId: txn.traceId,
    spanId: rootSpanId,
    // A continued transaction's root is a CHILD of the upstream span (Profile v1 §12); a standalone root has none.
    ...(txn.parentSpanId !== undefined ? { parentSpanId: txn.parentSpanId } : {}),
    name: txn.name,
    kind: spanKindFor(txn.operation, rootAttributes),
    startTimeUnixNano: toUnixNanoString(txn.startTimestampMs),
    endTimeUnixNano: toUnixNanoString(txn.endTimestampMs ?? txn.startTimestampMs),
    attributes: toKeyValues(rootAttributes),
    status: toStatus(txn.status),
    flags,
  };

  const children: OtlpSpan[] = txn.spans.map((s) => ({
    traceId: txn.traceId,
    spanId: s.spanId,
    // A parent that is itself a child stays; a dangling/absent parent (the dropped root) → the root.
    parentSpanId:
      s.parentSpanId !== undefined && childIds.has(s.parentSpanId) ? s.parentSpanId : rootSpanId,
    name: s.description ?? s.operation,
    kind: spanKindFor(s.operation, s.attributes),
    startTimeUnixNano: toUnixNanoString(s.startTimestampMs),
    endTimeUnixNano: toUnixNanoString(s.endTimestampMs ?? s.startTimestampMs),
    attributes: toKeyValues({
      ...s.attributes,
      'bugsee.operation': s.operation,
      'bugsee.span.status': s.status,
    }),
    status: toStatus(s.status),
    flags,
  }));

  return [root, ...children];
}

/** Options for {@link toOtlpExportRequest}. */
export interface ToOtlpOptions {
  /** Resource attributes (e.g. `service.name`) applied to every span in the request. */
  resource?: Record<string, unknown>;
  /** The instrumentation scope. Name defaults to `@bugsee/opentelemetry`. */
  scope?: { name?: string; version?: string };
}

/** Map a batch of transactions to an OTLP `ExportTraceServiceRequest` (the `/v1/traces` POST body). */
export function toOtlpExportRequest(
  transactions: TransactionWire[],
  options: ToOtlpOptions = {},
): OtlpExportTraceServiceRequest {
  if (transactions.length === 0) return { resourceSpans: [] };
  const spans = transactions.flatMap(transactionToOtlpSpans);
  const scope: OtlpScope = {
    name: options.scope?.name ?? DEFAULT_SCOPE_NAME,
    ...(options.scope?.version !== undefined ? { version: options.scope.version } : {}),
  };
  return {
    resourceSpans: [
      {
        // Profile v1 §4: the two profile-fixed resource constants are always present (after the caller's
        // resource, so they can't be overridden away); service.* + telemetry.sdk.language come from `resource`.
        resource: {
          attributes: toKeyValues({
            ...options.resource,
            'telemetry.sdk.name': 'bugsee',
            'bugsee.profile.version': '1',
          }),
        },
        scopeSpans: [{ scope, spans }],
      },
    ],
  };
}
