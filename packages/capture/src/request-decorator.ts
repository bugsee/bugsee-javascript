// The interception-transformer seam (design: docs/design/opentelemetry-integration.md, D6). A capture
// interceptor is OBSERVE-ONLY on its own; a request decorator is the explicit, opt-in way the data it
// pipes through may be altered — today, adding headers to an outgoing request (the OTel `traceparent`
// propagation transformer is the first consumer). Distinct from redaction filters: redaction transforms
// what Bugsee STORES; a decorator transforms what flows THROUGH (the live request).
//
// Contract: a decorator MUST be synchronous and fast — it runs inline before the request is sent, so any
// blocking/latency would itself be a behavior change. It returns headers to ADD/override (or nothing, to
// leave the request untouched). The interceptor applies them to BOTH the outgoing request AND the
// captured event (truthful capture), and never decorates the SDK's own internal traffic.

/** The outgoing request a decorator inspects (a read-only view). */
export interface OutgoingRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
}

/** A request decorator: returns headers to add/override on the outgoing request, or nothing. SYNC only. */
export type RequestDecorator = (
  request: OutgoingRequest,
) => Record<string, string> | undefined | void;

/** An interceptor that accepts request decorators (the opt-in mutation seam; observe-only without them). */
export interface RequestDecoratable {
  /** Register a request decorator. Returns an unsubscribe that removes it. */
  addRequestDecorator(decorator: RequestDecorator): () => void;
}
