// The OTLP/HTTP-JSON trace wire shapes we emit (the subset of the OTLP protobuf-JSON mapping the
// produce path needs). Hand-rolled — no @opentelemetry/* dependency. Per the OTLP/JSON spec, `traceId`/
// `spanId`/`parentSpanId` are LOWERCASE-HEX strings (the documented exception to the bytes→base64 rule),
// and uint64 timestamps (`*UnixNano`) are DECIMAL STRINGS (to survive values beyond 2^53). See
// https://opentelemetry.io/docs/specs/otlp/ and the trace proto.

/** OTLP `SpanKind`. We emit INTERNAL by default, CLIENT for outgoing-call spans. */
export const OtlpSpanKind = {
  UNSPECIFIED: 0,
  INTERNAL: 1,
  SERVER: 2,
  CLIENT: 3,
  PRODUCER: 4,
  CONSUMER: 5,
} as const;

/** OTLP `Status.code`. */
export const OtlpStatusCode = {
  UNSET: 0,
  OK: 1,
  ERROR: 2,
} as const;

/**
 * The proto3 JSON representation of a non-finite double. A double is normally a JSON number, but NaN and
 * the infinities have no JSON number form, so the mapping spells them as these three exact strings —
 * serializing them as numbers yields `null`, which is not a legal double and costs the whole export.
 */
export type OtlpSpecialDouble = 'NaN' | 'Infinity' | '-Infinity';

/** OTLP `AnyValue` — a one-of over the scalar kinds we produce (uint64 `intValue` is a decimal string). */
export type OtlpAnyValue =
  | { stringValue: string }
  | { boolValue: boolean }
  | { intValue: string }
  | { doubleValue: number | OtlpSpecialDouble };

/** OTLP `KeyValue`. */
export interface OtlpKeyValue {
  key: string;
  value: OtlpAnyValue;
}

/** OTLP `Status`. */
export interface OtlpStatus {
  code: number;
  message?: string;
}

/** OTLP `Span` (trace proto subset). */
export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes?: OtlpKeyValue[];
  status?: OtlpStatus;
  /** W3C trace flags (low 8 bits): bit 0 = sampled. Profile v1 §8: the sampled bit MUST mirror `bugsee.sampled`. */
  flags?: number;
}

/** OTLP `SpanFlags`: the W3C `sampled` trace-flag bit (the low byte holds the W3C trace flags). */
export const OTLP_SPAN_FLAG_SAMPLED = 1;

/** OTLP `InstrumentationScope`. */
export interface OtlpScope {
  name: string;
  version?: string;
}

/** OTLP `ScopeSpans`. */
export interface OtlpScopeSpans {
  scope: OtlpScope;
  spans: OtlpSpan[];
}

/** OTLP `Resource`. */
export interface OtlpResource {
  attributes: OtlpKeyValue[];
}

/** OTLP `ResourceSpans`. */
export interface OtlpResourceSpans {
  resource: OtlpResource;
  scopeSpans: OtlpScopeSpans[];
}

/** OTLP `ExportTraceServiceRequest` — the POST body for `/v1/traces`. */
export interface OtlpExportTraceServiceRequest {
  resourceSpans: OtlpResourceSpans[];
}
