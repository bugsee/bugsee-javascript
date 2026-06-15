import type { CaptureAggregator, CaptureDataEntry, CaptureStore } from './contracts';
import type { RequestContext } from './request-context';

// The single data adapter every provider feeds (Android BugseeCaptureAggregator parity, design §7.7).
// Data flows ONE direction: accept an entry → (optionally stamp the active request context) → transform
// (entry.serialize()) → route the serialized record to the configurable CaptureStore (in-memory / disk /
// IndexedDB). Read-back is NOT here — it belongs to the CaptureExporter (capture-exporter.ts).

export interface CaptureAggregatorOptions {
  /**
   * Reads the active request context (design: framework-adapters.md, "correlation, not isolation"). When
   * a context is active, each entry's wire payload is stamped with its correlation ids so the recording
   * can later be focused on one request. Absent (default) → no stamping; behavior is byte-identical.
   */
  getContext?: () => RequestContext | undefined;
}

export function createCaptureAggregator(
  store: CaptureStore,
  options: CaptureAggregatorOptions = {},
): CaptureAggregator {
  // Stamp the active context's correlation ids onto the entry payload (entry.data is what the bundle emits
  // per file; the wire field names mirror RequestJson.context_id in @bugsee/protocol). Only plain objects
  // can carry the keys; arrays / primitives / null are left untouched.
  //
  // Stamp onto a COPY, never the caller's object: a provider may hand us the very object the source
  // emitter broadcast to all its subscribers (and that app code may still reference), and the correlation
  // ids are an internal concern that must not leak onto it (observe-only — see the design doc / the
  // "interceptors must not alter app behavior" principle). We replace entry.data with the stamped copy.
  const stamp = (entry: CaptureDataEntry): void => {
    const context = options.getContext?.();
    if (context === undefined) {
      return;
    }
    const data = entry.data;
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      return;
    }
    const stamped: Record<string, unknown> = {
      ...(data as Record<string, unknown>),
      context_id: context.contextId,
    };
    if (context.trace !== undefined) {
      stamped.trace_id = context.trace.traceId;
      stamped.span_id = context.trace.spanId;
    }
    entry.data = stamped;
  };
  const route = (entry: CaptureDataEntry): void => {
    stamp(entry);
    store.add({ type: entry.type, timestamp: entry.timestamp, serialized: entry.serialize() });
  };
  return {
    addEntry(entry: CaptureDataEntry): void {
      route(entry);
    },
    addEntries(entries: readonly CaptureDataEntry[]): void {
      for (const entry of entries) {
        route(entry);
      }
    },
    clear(): void {
      store.clear();
    },
  };
}
