// W3C `tracestate` codec (https://www.w3.org/TR/trace-context/#tracestate-header) + the Bugsee vendor entry.
// `tracestate` is the OTel-legal vendor channel that rides alongside `traceparent` (cross-project-tracing.md,
// T4/T7): a comma-separated, ORDERED (most-recently-mutated first) list of `key=value` members. We parse it
// defensively (skip malformed members, never throw — we're reading headers minted by others), and when we
// mutate it we move our entry to the front and cap the list, per the spec.

/** One `key=value` member of a `tracestate` header. */
export interface TracestateEntry {
  key: string;
  value: string;
}

// W3C SHOULD: at most 32 entries. (We don't enforce the 512-byte soft cap — the entry cap bounds it and our
// own `bugsee=` value is tiny; a byte cap is a later refinement.)
const MAX_ENTRIES = 32;
// A permissive lowercase key (covers simple vendor keys + the `tenant@vendor` form's chars); strict enough to
// drop garbage members, lenient enough to preserve real third-party entries.
const KEY_RE = /^[a-z0-9][a-z0-9_\-*/@]*$/;

/** Parse a `tracestate` header into ordered entries — defensively (skips malformed, dedupes, caps at 32). */
export function parseTracestate(header: string | undefined): TracestateEntry[] {
  if (typeof header !== 'string') {
    return [];
  }
  const out: TracestateEntry[] = [];
  const seen = new Set<string>();
  for (const raw of header.split(',')) {
    if (out.length >= MAX_ENTRIES) {
      break;
    }
    const member = raw.trim();
    const eq = member.indexOf('=');
    if (eq <= 0) {
      continue; // no '=' (eq -1) or an empty key (eq 0) → malformed, skip
    }
    const key = member.slice(0, eq);
    const value = member.slice(eq + 1);
    if (value.length === 0 || !KEY_RE.test(key) || seen.has(key)) {
      continue; // empty value / invalid key / duplicate (first occurrence wins)
    }
    seen.add(key);
    out.push({ key, value });
  }
  return out;
}

/** Serialize ordered entries back to a `tracestate` header value. */
export function serializeTracestate(entries: readonly TracestateEntry[]): string {
  return entries.map((entry) => `${entry.key}=${entry.value}`).join(',');
}

/**
 * Set/replace this vendor's entry, moving it to the FRONT (W3C: the most-recently-mutated entry is first),
 * preserving every other vendor's entry in order, and capping the result at 32 (drops the oldest).
 */
export function setTracestateEntry(
  entries: readonly TracestateEntry[],
  key: string,
  value: string,
): TracestateEntry[] {
  const rest = entries.filter((entry) => entry.key !== key);
  return [{ key, value }, ...rest].slice(0, MAX_ENTRIES);
}

/** The Bugsee `tracestate` payload (cross-project-tracing.md): a record flag + a session-correlation id. */
export interface BugseeTraceState {
  /** The originator is recording/replaying this trace (distinct from the W3C sampled bit). */
  record?: boolean;
  /** The client-minted per-launch session id of the trace's originator (for FE-session↔BE-trace join). */
  sessionId?: string;
}

/** Encode the Bugsee state into a `bugsee=` value: `r<0|1>` then `s<id>`, colon-delimited, present fields only. */
export function encodeBugseeState(state: BugseeTraceState): string {
  const fields: string[] = [];
  if (state.record !== undefined) {
    fields.push(`r${state.record ? 1 : 0}`);
  }
  if (state.sessionId !== undefined) {
    fields.push(`s${state.sessionId}`);
  }
  return fields.join(':');
}

/** Decode a `bugsee=` value defensively: colon-delimited single-char-keyed fields; unknown fields ignored. */
export function decodeBugseeState(value: string): BugseeTraceState {
  const state: BugseeTraceState = {};
  for (const token of value.split(':')) {
    if (token.length === 0) {
      continue;
    }
    const field = token[0];
    const rest = token.slice(1);
    if (field === 'r') {
      state.record = rest === '1';
    } else if (field === 's') {
      state.sessionId = rest;
    }
  }
  return state;
}
