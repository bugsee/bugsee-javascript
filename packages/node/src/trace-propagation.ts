import { createTraceparentDecorator, type RequestDecorator } from '@bugsee/capture';

// Native trace-context propagation (cross-project-tracing.md X3; Bugsee OTLP Profile v1 §12). Builds the
// outgoing-request decorator that injects `traceparent` + the `bugsee=` tracestate from the ACTIVE per-request
// context — NOT the performance extension's `getActiveSpan`. That remains the right call after D2 part 2
// (which made the controller's slot request-scoped on Node): this decorator lives in the BASE
// @bugsee/node launch, so it must work with the opt-in APM extension absent entirely, and the request
// context is the source that is always present. Propagation works without the OTel extension too.
//
// Node has no same-origin concept (no `location.origin`), so propagation is ALLOWLIST-DRIVEN: without
// `tracePropagationTargets` nothing is injected — a backend must not leak its trace topology to the
// third-party APIs it calls. `propagateTrace: false` disables it entirely.

/** The per-request trace the decorator reads (the node RequestContextStore's current context trace). */
interface TraceSource {
  getCurrent(): { trace?: { traceId: string; spanId: string; sampled: boolean } } | undefined;
}

export interface TracePropagationOptions {
  /** Master switch (default true). `false` → no decorator (nothing is ever injected). */
  propagateTrace?: boolean;
  /** Targets allowed to receive `traceparent` (substring or RegExp). Node has no same-origin default, so
   *  without this nothing is propagated. */
  tracePropagationTargets?: ReadonlyArray<string | RegExp>;
}

/**
 * Build the native propagation decorator, or `undefined` when disabled. Sourced from the per-request
 * context; carries the launch's session-correlation id (`bugsee=s<id>`) + the record flag.
 */
export function buildTracePropagationDecorator(
  store: TraceSource,
  api: { readonly sessionId: string },
  options: TracePropagationOptions,
): RequestDecorator | undefined {
  if (options.propagateTrace === false) {
    return undefined;
  }
  return createTraceparentDecorator({
    getActiveSpan: () => {
      // Fail-safe: this decorator runs inline in the wrapped fetch/XHR (before the original), so a
      // throwing custom store would propagate synchronously out of the APPLICATION's own request.
      // Degrade to "no active trace" instead — the headers are enrichment, never the request.
      let trace: { traceId: string; spanId: string; sampled: boolean } | undefined;
      try {
        trace = store.getCurrent()?.trace;
      } catch {
        return undefined;
      }
      return trace === undefined
        ? undefined
        : {
            getTraceId: () => trace.traceId,
            getSpanId: () => trace.spanId,
            isSampled: () => trace.sampled,
          };
    },
    getBugseeState: () => ({ record: true, sessionId: api.sessionId }),
    ...(options.tracePropagationTargets !== undefined
      ? { allowlist: options.tracePropagationTargets }
      : {}),
  });
}
