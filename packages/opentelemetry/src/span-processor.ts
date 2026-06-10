import type { TransactionWire } from '@bugsee/performance';
import type { ConsumedSpan } from './from-otlp';
import { createTraceAssembler } from './trace-assembler';

// Phase C3: the consume bridge — a Bugsee SpanProcessor the user registers on their OTel TracerProvider.
// `onEnd(readableSpan)` normalizes the span and feeds the trace assembler, which emits one Bugsee
// transaction per trace (root-end policy). STRUCTURAL types (no @opentelemetry/* import) — robust to OTel
// SDK version churn (1.x `parentSpanId` vs 2.x `parentSpanContext`) and keeps the package install-lean;
// @opentelemetry/api + sdk-trace-base are declared as OPTIONAL peer deps (a consumer needs them for their
// TracerProvider; produce-only users do not). The returned object is structurally assignable to OTel's
// `SpanProcessor`. See docs/design/opentelemetry-integration.md (Phase C).

/** OTel `HrTime`: `[seconds, nanoseconds]` since the epoch. */
export type HrTime = [number, number];

/** The OTel `SpanContext` subset we read. */
export interface SpanContextLike {
  traceId: string;
  spanId: string;
  /** Set by OTel 2.x when the parent was propagated from a remote process. */
  isRemote?: boolean;
}

/** The OTel `ReadableSpan` subset we read (covering SDK 1.x and 2.x parent shapes). */
export interface ReadableSpanLike {
  spanContext(): SpanContextLike;
  /** OTel SDK 1.x: the parent span id (undefined for a root). */
  parentSpanId?: string;
  /** OTel SDK 2.x: the parent span context (replaces `parentSpanId`). */
  parentSpanContext?: SpanContextLike;
  name: string;
  /** OTel `SpanKind`. */
  kind?: number;
  startTime: HrTime;
  endTime: HrTime;
  status: { code: number; message?: string };
  attributes?: Record<string, unknown>;
}

const hrTimeToMs = ([seconds, nanos]: HrTime): number => seconds * 1000 + nanos / 1_000_000;

/** Normalize a finished OTel `ReadableSpan` to a `ConsumedSpan`. A REMOTE parent (a downstream service
 *  continuing a propagated trace) is treated as a LOCAL ROOT (`parentSpanId` omitted) so the assembler's
 *  root rule stays simple. */
export function readableSpanToConsumed(span: ReadableSpanLike): ConsumedSpan {
  const ctx = span.spanContext();
  const parent = span.parentSpanContext;
  const parentSpanId =
    parent?.isRemote === true ? undefined : (parent?.spanId ?? span.parentSpanId);
  return {
    traceId: ctx.traceId,
    spanId: ctx.spanId,
    ...(parentSpanId !== undefined ? { parentSpanId } : {}),
    name: span.name,
    ...(span.kind !== undefined ? { kind: span.kind } : {}),
    startTimeMs: hrTimeToMs(span.startTime),
    endTimeMs: hrTimeToMs(span.endTime),
    status: {
      code: span.status.code,
      ...(span.status.message !== undefined ? { message: span.status.message } : {}),
    },
    ...(span.attributes !== undefined ? { attributes: span.attributes } : {}),
  };
}

/** Options for {@link createBugseeSpanProcessor}. */
export interface BugseeSpanProcessorOptions {
  /** Called with each assembled Bugsee transaction (e.g. into the performance store / OTLP exporter). */
  onTransaction: (transaction: TransactionWire) => void;
  /** Wall-clock source for the assembler's eviction. Default `Date.now`. */
  clock?: { wallNow(): number };
  /** Drop a trace whose root never arrives after this many ms. Default 30000. */
  maxAgeMs?: number;
  /** Cap on concurrently-buffered traces. Default 1000. */
  maxTraces?: number;
}

/** Structurally assignable to OTel's `SpanProcessor`. */
export interface BugseeSpanProcessor {
  onStart(): void;
  onEnd(span: ReadableSpanLike): void;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

/** Build a Bugsee `SpanProcessor` — register it on your OTel `TracerProvider` to consume OTel spans. */
export function createBugseeSpanProcessor(
  options: BugseeSpanProcessorOptions,
): BugseeSpanProcessor {
  const assembler = createTraceAssembler({
    onTransaction: options.onTransaction,
    clock: options.clock ?? { wallNow: () => Date.now() },
    ...(options.maxAgeMs !== undefined ? { maxAgeMs: options.maxAgeMs } : {}),
    ...(options.maxTraces !== undefined ? { maxTraces: options.maxTraces } : {}),
  });
  return {
    onStart() {}, // we assemble on span end, not start
    onEnd(span) {
      assembler.add(readableSpanToConsumed(span));
    },
    forceFlush() {
      return Promise.resolve();
    },
    shutdown() {
      assembler.clear();
      return Promise.resolve();
    },
  };
}
