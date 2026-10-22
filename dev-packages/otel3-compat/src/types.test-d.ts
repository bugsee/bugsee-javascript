import type { ReadableSpanLike } from '@bugsee/opentelemetry';
import { createBugseeSpanProcessor, readableSpanToConsumed } from '@bugsee/opentelemetry';
import type { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace';

// Type-level drift guard against the REAL OpenTelemetry JS 3.x contract (the 2.x twin is
// packages/opentelemetry/src/span-processor.test-d.ts). `tsc --noEmit` fails here the moment 3.x's
// `ReadableSpan` stops satisfying our structural `ReadableSpanLike`, or our processor stops being a valid
// 3.x `SpanProcessor` (so `new TracerProvider({ spanProcessors: [processor] })` would no longer compile).

declare const realSpan: ReadableSpan;

// A real 3.x ReadableSpan is accepted wherever we read a ReadableSpanLike. Its `attributes` is the API 1.10
// `Attributes`, widened with AnyValue (OTEP 4485).
const asLike: ReadableSpanLike = realSpan;
const consumed = readableSpanToConsumed(realSpan);

// Our processor is assignable to 3.x's SpanProcessor (onStart(span, parentContext), optional onEnding, ...).
const asProcessor: SpanProcessor = createBugseeSpanProcessor({ onTransaction: () => {} });

void asLike;
void consumed;
void asProcessor;
