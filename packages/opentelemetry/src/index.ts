// @bugsee/opentelemetry
// OpenTelemetry interop (Tier 3, pluggable extension). Two-way bridge — see
// docs/design/opentelemetry-integration.md. BUILT: Phase A — the runtime-portable Produce-direction
// mapping (Bugsee §8.8 transactions → OTLP/HTTP-JSON), with hand-rolled OTLP types (no @opentelemetry/*
// dependency). BUILT: Phase B — the OTLP/HTTP-JSON trace exporter (a `send`-shaped function, uploader-
// compatible). PLANNED: the SpanProcessor consume bridge (C), and the interception-transformer
// propagation (T/D).

export {
  type ConsumedSpan,
  consumedRootToTransaction,
  consumedSpanToSpanWire,
  fromOtlpStatus,
} from './from-otlp';
export {
  createOtlpTraceExporter,
  type OtlpTraceExporterOptions,
} from './otlp-exporter';
export {
  type OtlpAnyValue,
  type OtlpExportTraceServiceRequest,
  type OtlpKeyValue,
  type OtlpResource,
  type OtlpResourceSpans,
  type OtlpScope,
  type OtlpScopeSpans,
  type OtlpSpan,
  OtlpSpanKind,
  type OtlpStatus,
  OtlpStatusCode,
} from './otlp-wire';
export {
  deriveRootSpanId,
  spanKindFor,
  type ToOtlpOptions,
  toAnyValue,
  toKeyValues,
  toOtlpExportRequest,
  toStatus,
  toUnixNanoString,
  transactionToOtlpSpans,
} from './to-otlp';
