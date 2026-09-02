import { REDACTED } from '@bugsee/protocol';
import { describe, expect, it } from 'vitest';
import { redactSqlLiterals, sanitizeSpan } from './span-sanitizer';

const span = (attributes?: Record<string, unknown>) => ({
  spanId: 's',
  operation: 'db.query',
  status: 'OK',
  startTimestampMs: 1,
  ...(attributes !== undefined ? { attributes } : {}),
});

describe('redactSqlLiterals', () => {
  it('replaces string literals while keeping the query SHAPE', () => {
    // The shape is the whole point: every execution of one query looks the same, so it groups — and it
    // carries no customer data.
    expect(redactSqlLiterals("SELECT * FROM users WHERE email = 'a@b.com'")).toBe(
      'SELECT * FROM users WHERE email = ?',
    );
  });

  it('replaces numeric literals', () => {
    expect(redactSqlLiterals('SELECT * FROM orders WHERE id = 42 AND total > 9.99')).toBe(
      'SELECT * FROM orders WHERE id = ? AND total > ?',
    );
  });

  it("consumes SQL's own doubled-quote escape as part of its string", () => {
    // `'O''Brien'` is ONE literal. Treating the doubled quote as a terminator would leave `Brien` in the
    // statement — the exact customer data this removes.
    expect(redactSqlLiterals("SELECT * FROM users WHERE name = 'O''Brien'")).toBe(
      'SELECT * FROM users WHERE name = ?',
    );
  });

  it('does not mistake digits inside an identifier for a literal', () => {
    expect(redactSqlLiterals('SELECT column2 FROM t1')).toBe('SELECT column2 FROM t1');
  });

  it('handles a double-quoted literal', () => {
    expect(redactSqlLiterals('SELECT * FROM t WHERE a = "secret"')).toBe(
      'SELECT * FROM t WHERE a = ?',
    );
  });

  it('leaves a statement with no literals alone', () => {
    expect(redactSqlLiterals('SELECT id FROM users')).toBe('SELECT id FROM users');
  });
});

describe('sanitizeSpan', () => {
  it('redacts the literals in a db statement, under either convention name', () => {
    expect(
      sanitizeSpan(span({ 'db.statement': "SELECT * FROM u WHERE e = 'a@b.com'" })).attributes,
    ).toEqual({ 'db.statement': 'SELECT * FROM u WHERE e = ?' });
    expect(
      sanitizeSpan(span({ 'db.query.text': "SELECT 'x'" })).attributes?.['db.query.text'],
    ).toBe('SELECT ?');
  });

  it('REDACTS model prompts and completions outright', () => {
    // Unlike a query there is no shape worth keeping, and a prompt is as sensitive as a password —
    // it is whatever the user typed.
    const out = sanitizeSpan(
      span({ 'gen_ai.prompt': 'my medical history is…', 'gen_ai.completion': 'you should…' }),
    ).attributes;
    expect(out).toEqual({ 'gen_ai.prompt': REDACTED, 'gen_ai.completion': REDACTED });
  });

  it('redacts GraphQL documents and variables, and HTTP bodies', () => {
    const out = sanitizeSpan(
      span({ 'graphql.variables': '{"id":1}', 'http.request.body': '{"card":"4111..."}' }),
    ).attributes;
    expect(out).toEqual({ 'graphql.variables': REDACTED, 'http.request.body': REDACTED });
  });

  it("redacts by the SDK's single definition of a sensitive key, on the leaf name", () => {
    // Derived, never restated: the same predicate that redacts headers and query params. `db.user` is
    // an identifier worth keeping; `db.password` is not.
    const out = sanitizeSpan(
      span({ 'db.password': 'hunter2', 'db.user': 'app', 'custom.api_token': 'sk-1' }),
    ).attributes;
    expect(out).toEqual({
      'db.password': REDACTED,
      'db.user': 'app',
      'custom.api_token': REDACTED,
    });
  });

  it('matches on the whole dotted key, which subsumes any leaf check', () => {
    // Pins WHY there is no separate leaf-name test: `isSensitiveKey` is a substring match and a leaf is
    // a substring of its key, so a leaf can never match when the full key does not. A leaf clause was
    // written, SURVIVED a mutation, and was removed as dead rather than covered — it also called a
    // DOM-element predicate on a plain object, which returns false for every input.
    const out = sanitizeSpan(
      span({ 'deeply.nested.thing.secret': 'x', 'deeply.nested.thing.count': 1 }),
    ).attributes;
    expect(out).toEqual({ 'deeply.nested.thing.secret': REDACTED, 'deeply.nested.thing.count': 1 });
  });

  it('keeps ordinary attributes untouched and returns the SAME span when nothing changed', () => {
    const input = span({ 'db.system': 'postgresql', 'net.peer.port': 5432 });
    expect(sanitizeSpan(input)).toBe(input);
  });

  it('handles a span with no attributes at all', () => {
    const input = span();
    expect(sanitizeSpan(input)).toBe(input);
  });

  it('leaves a non-string statement alone rather than coercing it', () => {
    const input = span({ 'db.statement': 42 });
    expect(sanitizeSpan(input).attributes?.['db.statement']).toBe(42);
  });
});
