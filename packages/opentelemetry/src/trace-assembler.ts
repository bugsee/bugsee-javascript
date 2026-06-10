import type { TransactionWire } from '@bugsee/performance';
import { type ConsumedSpan, consumedRootToTransaction, consumedSpanToSpanWire } from './from-otlp';

// Phase C2: the trace assembler. OTel spans arrive one-at-a-time (children usually before the root), so
// this buffers them by traceId and emits ONE Bugsee transaction when the trace's ROOT span ends — the
// "root-end + bounded eviction" policy. A span is the root when it has no parent; the C3 bridge normalizes
// a REMOTE parent (a downstream service's local root) to `parentSpanId: undefined`, so this rule stays
// OTel-agnostic. Bounded: a trace whose root never arrives is dropped after `maxAgeMs`, and the buffer is
// capped at `maxTraces` (oldest evicted) — so a leaked/never-closed trace can't grow memory unbounded.
// Trade-off (accepted): a child that ends AFTER its root is not part of the emitted transaction.

const DEFAULT_MAX_AGE_MS = 30_000;
const DEFAULT_MAX_TRACES = 1000;

export interface TraceAssemblerDeps {
  /** Called with the assembled Bugsee transaction when a trace's root ends. */
  onTransaction: (transaction: TransactionWire) => void;
  /** Wall-clock source for age-based eviction. */
  clock: { wallNow(): number };
  /** Drop a trace whose root never arrives after this many ms. Default 30000. */
  maxAgeMs?: number;
  /** Cap on concurrently-buffered traces (oldest evicted past it). Default 1000. */
  maxTraces?: number;
}

export interface TraceAssembler {
  /** Feed a finished (normalized) OTel span. Emits a transaction if it is its trace's root. */
  add(span: ConsumedSpan): void;
  /** The number of incomplete traces currently buffered. */
  size(): number;
  /** Drop all buffered (incomplete) traces, e.g. on shutdown. */
  clear(): void;
}

interface TraceBuffer {
  spans: ConsumedSpan[];
  firstSeenMs: number;
}

export function createTraceAssembler(deps: TraceAssemblerDeps): TraceAssembler {
  const maxAgeMs = deps.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const maxTraces = deps.maxTraces ?? DEFAULT_MAX_TRACES;
  // Insertion order == firstSeen order (a re-created traceId moves to the end), so iteration is oldest→newest.
  const traces = new Map<string, TraceBuffer>();

  const evictAged = (): void => {
    const cutoff = deps.clock.wallNow() - maxAgeMs;
    for (const [traceId, buffer] of traces) {
      if (buffer.firstSeenMs < cutoff) traces.delete(traceId);
      else break; // the rest are newer
    }
  };

  const evictOverCap = (): void => {
    // Iterate oldest→newest, dropping fronts until at/under the cap. (Deleting the current key mid-Map-
    // iteration is safe; the iterator just advances to the next.)
    for (const oldest of traces.keys()) {
      if (traces.size <= maxTraces) break;
      traces.delete(oldest);
    }
  };

  return {
    add(span) {
      evictAged();
      let buffer = traces.get(span.traceId);
      if (buffer === undefined) {
        buffer = { spans: [], firstSeenMs: deps.clock.wallNow() };
        traces.set(span.traceId, buffer);
      }
      buffer.spans.push(span);

      if (span.parentSpanId === undefined) {
        traces.delete(span.traceId); // the root ended → assemble + emit, then this trace is done
        const children = buffer.spans.filter((s) => s !== span).map(consumedSpanToSpanWire);
        deps.onTransaction(consumedRootToTransaction(span, children));
      } else {
        evictOverCap();
      }
    },
    size: () => traces.size,
    clear: () => traces.clear(),
  };
}
