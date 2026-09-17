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
export type RequestDecorator = (request: OutgoingRequest) => Record<string, string> | undefined;

/** An interceptor that accepts request decorators (the opt-in mutation seam; observe-only without them). */
export interface RequestDecoratable {
  /** Register a request decorator. Returns an unsubscribe that removes it. */
  addRequestDecorator(decorator: RequestDecorator): () => void;
}

/** A registry of request decorators — the shared `addRequestDecorator` + `run` used by each interceptor. */
export interface RequestDecoratorRegistry extends RequestDecoratable {
  /** Run every registered decorator synchronously; the merged header additions, or undefined if none. */
  run(request: OutgoingRequest): Record<string, string> | undefined;
}

/** An RFC 9110 `token`: the only header names `setRequestHeader`/`Headers` accept. */
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
/**
 * A field value the platform accepts: a ByteString (every code unit ≤ U+00FF — `Headers` throws
 * otherwise) with no CR, LF or NUL. Tabs, spaces and obs-text (U+0080–U+00FF) are fine.
 */
const HEADER_VALUE = /^[^\r\n\0\u0100-\uffff]*$/;

/**
 * One decorator's additions, or undefined when it contributes nothing.
 *
 * ISOLATED, because a decorator runs INLINE in the app's own `fetch()` / `xhr.send()`: a throw from it —
 * or from reading what it returned (a hostile getter, a Proxy) — used to propagate out of the patched
 * call, so the app's request failed because of Bugsee. That includes our own propagation decorator,
 * which reads the active span through the performance extension. The result is copied in full before
 * any of it is used, so a read that throws half way contributes NOTHING rather than a partial set.
 *
 * Headers the platform would REJECT synchronously are dropped one by one (measured on Chromium 151: `new
 * Headers` throws TypeError and `setRequestHeader` SyntaxError for exactly these, and both accept tabs,
 * obs-text and other control characters) — an invalid name, a value
 * carrying CR/LF/NUL, a non-string — since passing one through fails the request exactly as a throw
 * does. Failures are swallowed like every other internal capture failure: there is no error sink at
 * this layer, and the request must go out regardless.
 */
function additionsOf(
  decorate: RequestDecorator,
  request: OutgoingRequest,
): Array<[string, string]> | undefined {
  let entries: Array<[string, unknown]>;
  try {
    const out = decorate(request);
    if (out === null || typeof out !== 'object') {
      return undefined;
    }
    entries = Object.entries(out);
  } catch {
    return undefined;
  }
  const valid = entries.filter(
    (entry): entry is [string, string] =>
      HEADER_NAME.test(entry[0]) && typeof entry[1] === 'string' && HEADER_VALUE.test(entry[1]),
  );
  return valid.length > 0 ? valid : undefined;
}

/** Create a decorator registry (one per interceptor): hosts the decorators and merges their outputs. */
export function createRequestDecoratorRegistry(): RequestDecoratorRegistry {
  const decorators: RequestDecorator[] = [];
  return {
    addRequestDecorator(decorator) {
      decorators.push(decorator);
      return () => {
        const index = decorators.indexOf(decorator);
        if (index >= 0) {
          decorators.splice(index, 1);
        }
      };
    },
    run(request) {
      const additions: Record<string, string> = {};
      let any = false;
      // A snapshot: a decorator that unsubscribes itself mid-run must not make its neighbour skipped.
      for (const decorate of [...decorators]) {
        const entries = additionsOf(decorate, request);
        if (entries !== undefined) {
          for (const [name, value] of entries) {
            additions[name] = value;
          }
          any = true;
        }
      }
      return any ? additions : undefined;
    },
  };
}
