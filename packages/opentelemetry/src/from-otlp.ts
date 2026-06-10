import type { SpanStatus, SpanWire, TransactionWire } from '@bugsee/performance';
import { OtlpStatusCode } from './otlp-wire';

// The Consume-direction mapping: a finished OTel span → the Bugsee §8.8 model (the inverse of to-otlp).
// Pure + runtime-portable; operates on a NORMALIZED `ConsumedSpan` (the OTel-SDK ReadableSpan is converted
// to this — HrTime→ms, spanContext→ids — in the Phase-C SpanProcessor bridge, keeping this file OTel-dep
// free). Native-transactions consume (the chosen shape): consumed spans land as Bugsee spans/transactions
// via the existing pipeline. Lossy on OTel-only data (events/links/resource/scope); `kind` is preserved
// as an `otel.span.kind` attribute. See docs/design/opentelemetry-integration.md (Phase C).

/** A normalized finished OTel span — the input to the consume mapping (built by the SpanProcessor bridge). */
export interface ConsumedSpan {
  traceId: string;
  spanId: string;
  /** Absent for a trace root. */
  parentSpanId?: string;
  name: string;
  /** OTel SpanKind (preserved as the `otel.span.kind` attribute). */
  kind?: number;
  startTimeMs: number;
  endTimeMs: number;
  status: { code: number; message?: string };
  attributes?: Record<string, unknown>;
}

const ERROR_STATUSES = new Set<SpanStatus>(['ERROR', 'TIMEOUT', 'CANCELLED', 'DEADLINE_EXCEEDED']);

/** Map an OTel `Status` to a Bugsee `SpanStatus` (inverse of `toStatus`: a specific error name carried in
 *  the OTel status message round-trips; OK→OK; UNSET/unknown→UNKNOWN). */
export function fromOtlpStatus(status: { code: number; message?: string }): SpanStatus {
  if (status.code === OtlpStatusCode.OK) return 'OK';
  if (status.code === OtlpStatusCode.ERROR) {
    return status.message !== undefined && ERROR_STATUSES.has(status.message as SpanStatus)
      ? (status.message as SpanStatus)
      : 'ERROR';
  }
  return 'UNKNOWN'; // UNSET or any unrecognised code
}

const durationNanos = (startMs: number, endMs: number): number =>
  Math.max(0, Math.round((endMs - startMs) * 1_000_000));

/** The §8.8 attributes for a consumed span: its attributes plus the preserved OTel kind (or undefined). */
function consumedAttributes(span: ConsumedSpan): Record<string, unknown> | undefined {
  const attributes: Record<string, unknown> = {
    ...span.attributes,
    ...(span.kind !== undefined ? { 'otel.span.kind': span.kind } : {}),
  };
  return Object.keys(attributes).length > 0 ? attributes : undefined;
}

/** Map a consumed OTel span to a Bugsee `SpanWire` (a non-root span in a transaction). */
export function consumedSpanToSpanWire(span: ConsumedSpan): SpanWire {
  const attributes = consumedAttributes(span);
  return {
    spanId: span.spanId,
    ...(span.parentSpanId !== undefined ? { parentSpanId: span.parentSpanId } : {}),
    operation: span.name,
    status: fromOtlpStatus(span.status),
    startTimestampMs: span.startTimeMs,
    endTimestampMs: span.endTimeMs,
    durationNanos: durationNanos(span.startTimeMs, span.endTimeMs),
    ...(attributes !== undefined ? { attributes } : {}),
  };
}

/** Build a Bugsee `TransactionWire` from the trace's root consumed span and its assembled child spans. */
export function consumedRootToTransaction(root: ConsumedSpan, spans: SpanWire[]): TransactionWire {
  const attributes = consumedAttributes(root);
  return {
    traceId: root.traceId,
    name: root.name,
    operation: root.name, // OTel has no separate transaction name vs operation
    status: fromOtlpStatus(root.status),
    startTimestampMs: root.startTimeMs,
    endTimestampMs: root.endTimeMs,
    durationNanos: durationNanos(root.startTimeMs, root.endTimeMs),
    isSnapshot: false,
    ...(attributes !== undefined ? { attributes } : {}),
    spans,
  };
}
