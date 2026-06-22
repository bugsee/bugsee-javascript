import { createTraceparentDecorator, type RequestDecorator } from '@bugsee/capture';

// Native trace-context propagation (cross-project-tracing.md X3; Bugsee OTLP Profile v1 §12). Builds the
// outgoing-request decorator that injects `traceparent` + the `bugsee=` tracestate from the ACTIVE per-request
// context — NOT the performance extension's single-slot `getActiveSpan` (which is wrong under server
// concurrency). Lives in the base @bugsee/node launch, so propagation works without the OTel extension.
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
      const trace = store.getCurrent()?.trace;
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
