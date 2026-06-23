import { parseTraceparent } from '@bugsee/capture';

// Pageload trace continuation from a server-injected `<meta name="traceparent">` (frontend-adapters D4).
// On a top-level document navigation the browser sends NO trace header, so the SSR/backend instead injects
// `<meta name="traceparent" content="00-<traceId>-<spanId>-<flags>">` into the rendered HTML (the universal
// industry pattern — OTel `document-load`, Sentry `getTraceMetaTags()`). On boot the client reads it and
// CONTINUES that trace for the `pageload` transaction (adopting the trace id + making the pageload a child of
// the server span, X2 continuation) instead of starting a fresh root — so the SSR request and the client
// pageload are one trace. Absent/invalid → undefined (a fresh root). Fully guarded: a hostile document /
// querySelector / getAttribute must never break launch.

/** The minimal document surface read (a `<meta>` lookup). */
export interface MetaTraceEnv {
  document?: {
    querySelector(selectors: string): { getAttribute(name: string): string | null } | null;
  };
}

/** A continuation the performance controller's `startTransaction({ continuation })` consumes (X2). */
export interface MetaTraceContinuation {
  traceId: string;
  parentSpanId: string;
  sampled: boolean;
}

const g = globalThis as unknown as MetaTraceEnv;

export function readMetaTraceContinuation(
  env: MetaTraceEnv = {},
): MetaTraceContinuation | undefined {
  const doc = env.document ?? g.document;
  if (doc === undefined) return undefined; // SSR / worker → no document
  let content: string | undefined;
  try {
    content = doc.querySelector('meta[name="traceparent"]')?.getAttribute('content') ?? undefined;
  } catch {
    return undefined; // a hostile document/querySelector/getAttribute must never break launch
  }
  const parsed = parseTraceparent(content);
  if (parsed === undefined) return undefined; // no/invalid traceparent → a fresh root pageload trace
  // The pageload becomes a CHILD of the server's span, adopting its trace id + sampling decision (D4/X2).
  return { traceId: parsed.traceId, parentSpanId: parsed.spanId, sampled: parsed.sampled };
}
