import type { FilterableSpan } from '@bugsee/core';
import { isSensitiveKey, REDACTED } from '@bugsee/protocol';

// The BUILT-IN span sanitizer, applied to every span unless the integrator installs their own filter
// (the same XOR the network sanitizer follows: a user filter REPLACES the default rather than layering).
//
// It exists because consuming OpenTelemetry now brings in whole categories of data the SDK never had a
// hand in producing: `@opentelemetry/instrumentation-pg` puts executed SQL on `db.statement` with the
// literal values still in it, the GenAI conventions carry prompts and completions verbatim, and HTTP
// instrumentation can carry bodies. Peers default all of that ON in the clear. This SDK's rule is that
// privacy-relevant data is obscured by default, so it is captured — and scrubbed on the way in.

/** Attribute keys whose VALUE is free-form user or model content, whatever it is called upstream. */
const CONTENT_KEYS = new Set([
  'gen_ai.prompt',
  'gen_ai.completion',
  'gen_ai.request.messages',
  'gen_ai.response.messages',
  'gen_ai.content.prompt',
  'gen_ai.content.completion',
  'http.request.body',
  'http.response.body',
  'graphql.document',
  'graphql.variables',
  'messaging.message.body',
]);

/** Keys carrying a database statement, across the OTel conventions that have named it differently. */
const STATEMENT_KEYS = new Set(['db.statement', 'db.query.text']);

/**
 * Replace the LITERALS in a SQL statement with placeholders, keeping its shape.
 *
 * `SELECT * FROM users WHERE email = 'a@b.com'` becomes `SELECT * FROM users WHERE email = ?`, which is
 * the form that is actually useful in a report: it groups (every execution of one query looks the same)
 * and it carries no customer data. Quoted strings go first so a number inside a string is not treated as
 * a number, and doubled quotes — SQL's own escape — are consumed as part of the string they sit in.
 */
export function redactSqlLiterals(statement: string): string {
  return (
    statement
      // '...' with '' escapes, and "..." with "" escapes
      .replace(/'(?:[^']|'')*'/g, '?')
      .replace(/"(?:[^"]|"")*"/g, '?')
      // numeric literals, but never the digits inside an identifier like `column2`
      .replace(/\b\d+(?:\.\d+)?\b/g, '?')
  );
}

/**
 * Scrub one span's attributes. Returns the SAME span when nothing needed changing, so the common case —
 * an SDK-produced span with no such attributes — copies nothing.
 */
export function sanitizeSpan(span: FilterableSpan): FilterableSpan {
  const attributes = span.attributes;
  if (attributes === undefined) {
    return span;
  }
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attributes)) {
    const scrubbed = sanitizeAttribute(key, value);
    if (scrubbed !== value) {
      changed = true;
    }
    out[key] = scrubbed;
  }
  return changed ? { ...span, attributes: out } : span;
}

function sanitizeAttribute(key: string, value: unknown): unknown {
  // A statement keeps its SHAPE — that is what makes it worth reporting at all — while losing its data.
  if (STATEMENT_KEYS.has(key) && typeof value === 'string') {
    return redactSqlLiterals(value);
  }
  // Free-form content: there is no shape worth keeping, and a prompt is as sensitive as a password.
  if (CONTENT_KEYS.has(key)) {
    return REDACTED;
  }
  // …and the general rule, through the SDK's single definition of a sensitive key rather than a list
  // restated here. `db.user` stays; `db.password` does not.
  //
  // The FULL key is enough, and deliberately so. An earlier version also tested the leaf (`password`
  // out of `db.password`) — dead code, because `isSensitiveKey` is a substring match and the leaf is a
  // substring of the key, so it can never match when the key does not. It also called
  // `isSensitiveInput({ name: leaf })`, which is a DOM-ELEMENT predicate reading `type` and `matches`:
  // handed a plain object it returns false for every input, always. A mutation run found both.
  return isSensitiveKey(key) ? REDACTED : value;
}
