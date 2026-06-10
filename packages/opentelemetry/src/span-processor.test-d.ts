import type { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { createBugseeSpanProcessor, type ReadableSpanLike } from './span-processor';

// Type-level drift guard for the STRUCTURAL OTel types (which deliberately carry no @opentelemetry/*
// runtime import). These assignments only compile while our hand-rolled shapes stay compatible with the
// real OTel SDK contract — so an SDK version bump (or drift in our types) that breaks consumer integration
// fails `tsc --noEmit` here. @opentelemetry/* are DEV-only (the pinned test version); consumers still need
// only the OPTIONAL peer deps. No runtime test — tsc checks the assignments.

// A real OTel ReadableSpan must be accepted wherever we read a ReadableSpanLike (we consume a subset).
declare const realSpan: ReadableSpan;
const _asLike: ReadableSpanLike = realSpan;

// Our processor must be assignable to OTel's SpanProcessor, so `provider.addSpanProcessor(...)` typechecks.
const _asProcessor: SpanProcessor = createBugseeSpanProcessor({ onTransaction: () => {} });

void _asLike;
void _asProcessor;
