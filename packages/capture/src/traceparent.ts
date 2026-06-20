import type { OutgoingRequest, RequestDecorator } from './request-decorator';
import {
  type BugseeTraceState,
  encodeBugseeState,
  parseTracestate,
  serializeTracestate,
  setTracestateEntry,
} from './tracestate';

// Phase D: the W3C trace-context propagation transformer — a RequestDecorator (the T seam's first
// consumer) that injects `traceparent` on outgoing requests so a frontend trace links to the backend
// trace (the Next.js / SSR story). The trace context comes from the Bugsee active transaction (its
// traceId/spanId are already W3C-shaped) — no @opentelemetry/* dependency. See
// docs/design/opentelemetry-integration.md.
//
// SECURITY: same-origin requests propagate by default; CROSS-ORIGIN requests are propagated ONLY when the
// URL matches an explicit `allowlist` — injecting `traceparent` to a third party would leak the trace
// topology. An existing `traceparent` (an upstream trace context) is never overridden.

/** The active trace this decorator propagates — a Bugsee transaction/span (structural). */
export interface TraceContextSource {
  getTraceId(): string;
  getSpanId(): string;
  /** Whether the trace is sampled (sets the traceparent flags); absent → treated as sampled. */
  isSampled?(): boolean;
}

export interface TraceparentDecoratorOptions {
  /** The active trace to propagate (e.g. the performance extension's `getActiveSpan`). */
  getActiveSpan: () => TraceContextSource | undefined;
  /** The app origin for same-origin detection. Default `globalThis.location?.origin` (undefined in Node). */
  origin?: string;
  /** Cross-origin URLs allowed to receive `traceparent` (same-origin always is). string = substring match;
   *  RegExp = test. Without it, `traceparent` is NEVER sent cross-origin. */
  allowlist?: ReadonlyArray<string | RegExp>;
  /** Resolve a URL (against `base`) to its origin; injectable for tests. Default the global `URL`. */
  resolveOrigin?: (url: string, base: string) => string | undefined;
  /**
   * The Bugsee `tracestate` payload to propagate alongside `traceparent` (record flag + the originating
   * session-correlation id; cross-project-tracing.md T4/T7). Absent or empty → no `tracestate` is added.
   * On a forwarding hop this carries the INBOUND originator's state (so the originating session id flows
   * through unchanged), set as the `bugsee=` vendor entry on any tracestate already on the outgoing request.
   */
  getBugseeState?: () => BugseeTraceState | undefined;
}

const W3C_VERSION = '00';

const TRACE_ID_RE = /^[0-9a-f]{32}$/;
const SPAN_ID_RE = /^[0-9a-f]{16}$/;
const HEX2_RE = /^[0-9a-f]{2}$/;
const ZERO_TRACE_ID = '0'.repeat(32);
const ZERO_SPAN_ID = '0'.repeat(16);

/** A parsed inbound W3C `traceparent` (for server-side trace continuation). */
export interface ParsedTraceparent {
  traceId: string;
  spanId: string;
  /** Whether the upstream sampled the trace (the low bit of the trace-flags). */
  sampled: boolean;
}

/**
 * Parse an inbound W3C `traceparent` for server-side trace CONTINUATION (the inverse of the decorator) —
 * a backend adapter adopts the trace id so the frontend↔backend traces link. Defensive (the design's
 * "trust the inbound header but parse defensively"): returns `undefined` for any non-conforming header, so
 * the caller starts a fresh trace instead of throwing. Tolerates surrounding whitespace, uppercase hex,
 * and future versions with extra fields (parses the first four); rejects the forbidden version `ff` and
 * all-zero / wrong-length ids per the spec.
 */
export function parseTraceparent(header: string | undefined): ParsedTraceparent | undefined {
  if (typeof header !== 'string') {
    return undefined;
  }
  const [version = '', traceId = '', spanId = '', flags = ''] = header
    .trim()
    .toLowerCase()
    .split('-');
  if (!HEX2_RE.test(version) || version === 'ff') {
    return undefined;
  }
  if (!TRACE_ID_RE.test(traceId) || traceId === ZERO_TRACE_ID) {
    return undefined;
  }
  if (!SPAN_ID_RE.test(spanId) || spanId === ZERO_SPAN_ID) {
    return undefined;
  }
  if (!HEX2_RE.test(flags)) {
    return undefined;
  }
  return { traceId, spanId, sampled: (Number.parseInt(flags, 16) & 1) === 1 };
}

const defaultResolveOrigin = (url: string, base: string): string | undefined => {
  const URLCtor = (
    globalThis as unknown as { URL?: new (u: string, b?: string) => { origin: string } }
  ).URL;
  if (URLCtor === undefined) {
    return undefined;
  }
  try {
    return new URLCtor(url, base).origin;
  } catch {
    return undefined; // unparseable → treated as cross-origin (allowlist only)
  }
};

const hasHeader = (headers: Readonly<Record<string, string>>, lowercaseName: string): boolean =>
  Object.keys(headers).some((key) => key.toLowerCase() === lowercaseName);

const headerValue = (
  headers: Readonly<Record<string, string>>,
  lowercaseName: string,
): string | undefined => {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lowercaseName) {
      return headers[key];
    }
  }
  return undefined;
};

export function createTraceparentDecorator(options: TraceparentDecoratorOptions): RequestDecorator {
  const origin =
    options.origin ??
    (globalThis as unknown as { location?: { origin?: string } }).location?.origin;
  const allowlist = options.allowlist ?? [];
  const resolveOrigin = options.resolveOrigin ?? defaultResolveOrigin;

  const isAllowed = (url: string): boolean => {
    // Same-origin (including relative URLs resolved against the app origin) is always allowed.
    if (origin !== undefined && resolveOrigin(url, origin) === origin) {
      return true;
    }
    // Cross-origin / unparseable / unknown app origin → ONLY an explicit allowlist match (no silent leak).
    return allowlist.some((pattern) =>
      typeof pattern === 'string' ? url.includes(pattern) : pattern.test(url),
    );
  };

  return (request: OutgoingRequest) => {
    if (hasHeader(request.headers, 'traceparent')) {
      return undefined; // respect an existing upstream trace context
    }
    if (!isAllowed(request.url)) {
      return undefined;
    }
    const span = options.getActiveSpan();
    if (span === undefined) {
      return undefined;
    }
    const flags = span.isSampled?.() === false ? '00' : '01';
    const result: Record<string, string> = {
      traceparent: `${W3C_VERSION}-${span.getTraceId()}-${span.getSpanId()}-${flags}`,
    };
    // Bugsee vendor tracestate (T4/T7): set our `bugsee=` entry on any tracestate already on the request,
    // preserving other vendors + moving ours to the front. Skipped when there is no Bugsee state to carry.
    const bugseeState = options.getBugseeState?.();
    if (bugseeState !== undefined) {
      const value = encodeBugseeState(bugseeState);
      if (value.length > 0) {
        const existing = parseTracestate(headerValue(request.headers, 'tracestate'));
        result.tracestate = serializeTracestate(setTracestateEntry(existing, 'bugsee', value));
      }
    }
    return result;
  };
}
