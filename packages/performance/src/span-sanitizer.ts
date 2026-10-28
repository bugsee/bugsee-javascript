import type { FilterableSpan } from '@bugsee/core';
import { isSensitiveKey, REDACTED, redactShapes } from '@bugsee/protocol';

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
  // The current GenAI semantic conventions: structured (array-of-message) content, the main reason
  // complex attributes exist at all.
  'gen_ai.input.messages',
  'gen_ai.output.messages',
  'gen_ai.system_instructions',
  'gen_ai.tool.definitions',
  'gen_ai.tool.call.arguments',
  'gen_ai.tool.call.result',
  'http.request.body',
  'http.response.body',
  'graphql.document',
  'graphql.variables',
  'messaging.message.body',
]);

/** Keys carrying a database statement, across the OTel conventions that have named it differently. */
const STATEMENT_KEYS = new Set(['db.statement', 'db.query.text']);

/** Can this character be part of an identifier (so a `$` right after it is not a dollar-quote opener)? */
const isWordChar = (ch: string | undefined): boolean =>
  ch !== undefined && /[A-Za-z0-9_$]/.test(ch);

/** End index (exclusive) of a quoted run opening at `start`; `-1` when it never closes. Backslash escapes too. */
function quotedEnd(sql: string, start: number): number {
  const quote = sql[start];
  for (let i = start + 1; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === '\\') {
      i++; // a backslash escape (MySQL, or Postgres with standard_conforming_strings = off)
    } else if (ch === quote) {
      if (sql[i + 1] !== quote) return i + 1;
      i++; // doubled quote: SQL's own escape
    }
  }
  return -1;
}

/**
 * Replace the LITERALS in a SQL statement with placeholders, keeping its shape.
 *
 * `SELECT * FROM users WHERE email = 'a@b.com'` becomes `SELECT * FROM users WHERE email = ?`, which is
 * the form that is actually useful in a report: it groups (every execution of one query looks the same)
 * and it carries no customer data.
 *
 * It TOKENISES rather than pairing quotes, because a quote that is not a string delimiter shifts the pairing
 * and leaves the next literal in the clear. Line and block comments are dropped (they can carry data and
 * their apostrophes are not delimiters); `'..'` and `".."` strings honour both doubled quotes and backslash
 * escapes; backtick identifiers are kept whole; `$tag$..$tag$` bodies are one literal. Anything that never
 * closes (including a statement cut by a length cap) fails CLOSED: it is redacted to the end. A backslash is
 * always treated as an escape, which over-redacts in dialects where it is not one: that is the safe side.
 */
export function redactSqlLiterals(statement: string): string {
  let out = '';
  let i = 0;
  while (i < statement.length) {
    const ch = statement[i] as string;
    const next = statement[i + 1];
    if (ch === '-' && next === '-') {
      const eol = statement.indexOf('\n', i);
      out += ' ';
      if (eol === -1) break;
      i = eol; // keep the newline itself
    } else if (ch === '/' && next === '*') {
      const close = statement.indexOf('*/', i + 2);
      out += ' ';
      if (close === -1) break;
      i = close + 2;
    } else if (ch === "'" || ch === '"') {
      const end = quotedEnd(statement, i);
      out += '?';
      if (end === -1) break;
      i = end;
    } else if (ch === '`') {
      const end = quotedEnd(statement, i);
      if (end === -1) {
        out += '?';
        break;
      }
      out += statement.slice(i, end);
      i = end;
    } else if (ch === '$' && !isWordChar(statement[i - 1])) {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(statement.slice(i, i + 130))?.[0];
      if (tag === undefined) {
        out += ch;
        i++;
        continue;
      }
      const close = statement.indexOf(tag, i + tag.length);
      out += '?';
      if (close === -1) break;
      i = close + tag.length;
    } else {
      out += ch;
      i++;
    }
  }
  // numeric literals, but never the digits inside an identifier like `column2`
  return out.replace(/\b\d+(?:\.\d+)?\b/g, '?');
}

/**
 * Scrub one span's attributes. Returns the SAME span when nothing needed changing, so the common case —
 * an SDK-produced span with no such attributes — copies nothing.
 *
 * Assumes BOUNDED input: nested values are walked with only a depth limit, so a raw cyclic or branching
 * object would not finish. The performance extension runs `normalizeTransactionAttributes` on every
 * transaction first; a direct caller must do the same.
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

/** How deep the nested walk goes; below it the subtree is redacted whole rather than recursed into. */
const MAX_WALK_DEPTH = 16;

/** Does this value need the nested walk (a map, or an array holding something other than scalars)? */
const isComplex = (value: unknown): boolean =>
  value !== null &&
  typeof value === 'object' &&
  !(Array.isArray(value) && value.every((item) => item === null || typeof item !== 'object'));

/**
 * The same rules as the flat path, applied to a NESTED (OpenTelemetry API 1.10 `AnyValue`) attribute: a
 * sensitive key redacts its whole value at any depth, content keys redact, statement keys keep their shape,
 * and string leaves are scanned for secret shapes. Returns the SAME value when nothing changed.
 *
 * Why this exists: `user: { password }` and `http.request.headers: { authorization }` carry exactly the data
 * the flat keys `user.password` / `http.request.headers.authorization` are redacted for, and a rule that only
 * looked at the top-level key would let them through verbatim.
 */
function sanitizeNested(value: unknown, depth: number, statement = false): unknown {
  if (typeof value === 'string') {
    // Under a statement key every string leaf is SQL: keep its shape, lose its literals.
    return redactShapes(statement ? redactSqlLiterals(value) : value);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (depth >= MAX_WALK_DEPTH) {
    return REDACTED;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const items = value.map((item) => {
      const next = sanitizeNested(item, depth + 1, statement);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? items : value;
  }
  let changed = false;
  const out: Record<string, unknown> = Object.create(null);
  for (const [key, member] of Object.entries(value)) {
    const next = sanitizeMember(key, member, depth, statement);
    if (next !== member) changed = true;
    out[key] = next;
  }
  return changed ? out : value;
}

function sanitizeMember(key: string, value: unknown, depth: number, statement: boolean): unknown {
  if (STATEMENT_KEYS.has(key)) {
    return typeof value === 'string'
      ? redactSqlLiterals(value)
      : sanitizeNested(value, depth + 1, true);
  }
  if (CONTENT_KEYS.has(key) || isSensitiveKey(key)) {
    return REDACTED;
  }
  return sanitizeNested(value, depth + 1, statement);
}

function sanitizeAttribute(key: string, value: unknown): unknown {
  // A statement keeps its SHAPE — that is what makes it worth reporting at all — while losing its data.
  if (STATEMENT_KEYS.has(key)) {
    if (typeof value === 'string') return redactSqlLiterals(value);
    // A statement carried as a map or an array: every string leaf under it is SQL.
    return isComplex(value) || Array.isArray(value) ? sanitizeNested(value, 0, true) : value;
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
  if (isSensitiveKey(key)) {
    return REDACTED;
  }
  // A nested value gets the same rules on ITS keys (see sanitizeNested).
  return isComplex(value) ? sanitizeNested(value, 0) : value;
}
