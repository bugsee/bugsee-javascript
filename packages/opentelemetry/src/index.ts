// @bugsee/opentelemetry
// OpenTelemetry interop (a pluggable extension). Two-way bridge. BUILT: the runtime-portable
// Produce-direction mapping (Bugsee transactions → OTLP/HTTP-JSON), with hand-rolled OTLP types (no
// @opentelemetry/* dependency); the OTLP/HTTP-JSON trace exporter (a `send`-shaped function, uploader-
// compatible); and the SpanProcessor consume bridge — `createBugseeSpanProcessor` below.
// PLANNED: the interception-transformer propagation.

// Attribute normalization lives in @bugsee/performance (the redaction and wire steps need it below this
// package); re-exported so existing imports keep working.
export {
  flattenAttributes,
  MAX_ATTRIBUTE_ARRAY_LENGTH,
  MAX_ATTRIBUTE_DEPTH,
  MAX_ATTRIBUTE_JSON_LENGTH,
  MAX_ATTRIBUTE_NODES,
  MAX_ATTRIBUTE_STRING_LENGTH,
  normalizeAttributes,
  normalizeAttributeValue,
  stringifyAnyValue,
} from '@bugsee/performance';
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
  type BugseeSpanProcessor,
  type BugseeSpanProcessorOptions,
  createBugseeSpanProcessor,
  type HrTime,
  type ReadableSpanLike,
  readableSpanToConsumed,
  type SpanContextLike,
} from './span-processor';
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
export {
  createTraceAssembler,
  type TraceAssembler,
  type TraceAssemblerDeps,
} from './trace-assembler';
