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

describe('sanitizeSpan on nested (AnyValue) attributes', () => {
  // OTel API 1.10 lets an attribute be a map. The key-based rule must see INTO it: `user.password` is
  // redacted as a flat key, so `user: { password }` has to be redacted too.
  it('redacts sensitive keys inside a nested map, keeping the rest', () => {
    const out = sanitizeSpan(
      span({ user: { name: 'ann', password: 'hunter2', authorization: 'Bearer abc' } }),
    );
    expect(out.attributes?.user).toEqual({
      name: 'ann',
      password: REDACTED,
      authorization: REDACTED,
    });
  });

  it('redacts header maps and keys at any depth, including inside arrays', () => {
    const out = sanitizeSpan(
      span({
        'http.request.headers': { authorization: 'Bearer abc', cookie: 'sid=1', accept: 'x' },
        calls: [{ meta: { token: 't', ok: 1 } }],
      }),
    );
    expect(out.attributes?.['http.request.headers']).toEqual({
      authorization: REDACTED,
      cookie: REDACTED,
      accept: 'x',
    });
    expect(out.attributes?.calls).toEqual([{ meta: { token: REDACTED, ok: 1 } }]);
  });

  it('applies the content-key and statement rules to nested keys', () => {
    const out = sanitizeSpan(
      span({
        payload: {
          'http.request.body': 'secret body',
          'db.statement': "SELECT * FROM users WHERE email = 'a@b.com'",
        },
      }),
    );
    expect(out.attributes?.payload).toEqual({
      'http.request.body': REDACTED,
      'db.statement': 'SELECT * FROM users WHERE email = ?',
    });
  });

  it('scans nested string leaves for secret shapes', () => {
    const out = sanitizeSpan(span({ ctx: { note: 'key AKIAIOSFODNN7EXAMPLE end' } }));
    expect(JSON.stringify(out.attributes?.ctx)).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('is bounded: a tree deeper than the walk limit is redacted whole, never recursed into', () => {
    let deep: unknown = { password: 'p' };
    for (let i = 0; i < 5000; i++) deep = { n: deep };
    const out = sanitizeSpan(span({ deep }));
    expect(JSON.stringify(out.attributes?.deep)).not.toContain('"p"');
    expect(JSON.stringify(out.attributes?.deep)).toContain(REDACTED);
  });

  it('returns the SAME span when a nested value needs no change', () => {
    const attrs = { ctx: { a: 1, b: ['x'] }, flat: 'ok' };
    const input = span(attrs);
    expect(sanitizeSpan(input)).toBe(input);
  });

  it('leaves null-prototype maps and non-plain leaves alone', () => {
    const map = Object.assign(Object.create(null) as Record<string, unknown>, {
      k: 1,
      password: 'p',
    });
    const out = sanitizeSpan(span({ map }));
    expect(out.attributes?.map).toEqual({ k: 1, password: REDACTED });
  });
});

describe('sanitizeSpan: current GenAI content conventions', () => {
  it.each([
    'gen_ai.input.messages',
    'gen_ai.output.messages',
    'gen_ai.system_instructions',
    'gen_ai.tool.definitions',
    'gen_ai.tool.call.arguments',
    'gen_ai.tool.call.result',
  ])('redacts %s by default, flat and nested', (key) => {
    const flat = sanitizeSpan(span({ [key]: [{ role: 'user', parts: [{ content: 'secret' }] }] }));
    expect(flat.attributes?.[key]).toBe(REDACTED);
    const nested = sanitizeSpan(span({ wrapper: { [key]: 'secret prompt' } }));
    expect(nested.attributes?.wrapper).toEqual({ [key]: REDACTED });
  });
});

describe('sanitizeSpan: a statement key whose value is not a plain string', () => {
  const SQL = "SELECT * FROM users WHERE email = 'a@b.com' AND id = 42";
  const SHAPE = 'SELECT * FROM users WHERE email = ? AND id = ?';

  it('redacts the literals in string leaves under a statement key (map, array, nested)', () => {
    const out = sanitizeSpan(
      span({
        'db.statement': { text: SQL, rows: 3 },
        'db.query.text': [SQL, SQL],
        wrapper: { 'db.statement': { inner: SQL } },
      }),
    );
    const attrs = out.attributes as Record<string, unknown>;
    expect(attrs['db.statement']).toEqual({ text: SHAPE, rows: 3 });
    expect(attrs['db.query.text']).toEqual([SHAPE, SHAPE]);
    expect(attrs.wrapper).toEqual({ 'db.statement': { inner: SHAPE } });
    expect(JSON.stringify(out.attributes)).not.toContain('a@b.com');
  });

  it('still returns the same span for a statement-keyed value that has nothing to redact', () => {
    const input = span({ 'db.statement': ['SELECT x FROM t'] });
    expect(sanitizeSpan(input)).toBe(input);
  });
});

describe('redactSqlLiterals on a statement that was CUT inside a literal', () => {
  // Length caps run before redaction, so a long INSERT is cut mid-string. A closed-quote match alone would
  // leave the open literal (and everything after its opening quote) in the clear.
  it('replaces an unterminated trailing literal', () => {
    expect(redactSqlLiterals("INSERT INTO t (doc) VALUES ('patient1@x.example;secret")).toBe(
      'INSERT INTO t (doc) VALUES (?',
    );
    expect(redactSqlLiterals('SELECT "col FROM t')).toBe('SELECT ?');
  });

  it('handles closed literals followed by an unterminated one, and a doubled quote before the cut', () => {
    expect(redactSqlLiterals("a = 'x' AND b = 'cd")).toBe('a = ? AND b = ?');
    // `it''s a sec` is ONE literal (doubled quote = escape) that never closes: all of it goes.
    expect(redactSqlLiterals("a = 'it''s a sec")).toBe('a = ?');
  });

  it('leaves a statement without any quote alone', () => {
    expect(redactSqlLiterals('SELECT x FROM t')).toBe('SELECT x FROM t');
  });
});

describe('redactSqlLiterals: quotes that are not string delimiters (#109)', () => {
  const clean = (sql: string): string => redactSqlLiterals(sql);

  it('ignores an apostrophe in a block comment and drops the comment', () => {
    expect(clean("/* don't */ SELECT * FROM t WHERE a = 'secretA'")).toBe(
      '  SELECT * FROM t WHERE a = ?',
    );
    expect(clean('SELECT/* x */1')).toBe('SELECT ?');
  });

  it('fails closed on an unterminated block comment', () => {
    expect(clean("SELECT 1 /* it's 'secret")).toBe('SELECT ?  ');
  });

  it('ignores an apostrophe in a line comment, keeping the newline', () => {
    expect(clean("-- it's\nSELECT * FROM t WHERE a = 'secretB'")).toBe(
      ' \nSELECT * FROM t WHERE a = ?',
    );
    expect(clean("SELECT 1 -- it's")).toBe('SELECT ?  ');
  });

  it('honours backslash-escaped quotes', () => {
    // A backslash-escaped quote makes the literal's end dialect-dependent: fail closed, nothing survives.
    expect(clean("INSERT INTO t VALUES ('O\\'Brien','secretC')")).toBe('INSERT INTO t VALUES (?');
    expect(clean('SELECT "a\\"b secret"')).toBe('SELECT ?');
  });

  it('treats dollar-quoted bodies as one literal, tagged or not', () => {
    expect(clean("SELECT $$it's$$, 'secretD'")).toBe('SELECT ?, ?');
    expect(clean("SELECT $q$it's $$ x$q$, 'secretE'")).toBe('SELECT ?, ?');
  });

  it('fails closed on an unterminated dollar quote', () => {
    expect(clean("SELECT $$it's secret")).toBe('SELECT ?');
  });

  it('does not open a dollar quote on a positional parameter or inside an identifier', () => {
    // (the digit after `$` is still a numeric literal, as before: harmless, and it groups)
    expect(clean('SELECT * FROM t WHERE a = $1 AND b = $2')).toBe(
      'SELECT * FROM t WHERE a = $? AND b = $?',
    );
    expect(clean('SELECT a$b$ FROM t')).toBe('SELECT a$b$ FROM t');
    expect(clean('SELECT $ FROM t')).toBe('SELECT $ FROM t');
  });

  it('keeps a backtick identifier whole, even with a quote inside it', () => {
    expect(clean("SELECT `it's` FROM t WHERE a = 'secretF'")).toBe(
      "SELECT `it's` FROM t WHERE a = ?",
    );
  });

  it('fails closed on an unterminated backtick identifier', () => {
    expect(clean("SELECT `it's 'secret")).toBe('SELECT ?');
  });

  it('does not treat a lone dash or slash as a comment', () => {
    expect(clean('SELECT a-b, c/d FROM t')).toBe('SELECT a-b, c/d FROM t');
  });

  it('fails closed on a literal ending in a backslash (standard SQL: complete; MySQL: escape)', () => {
    expect(clean("SELECT * FROM t WHERE a = 'C:\\' AND b = 'secretP'")).toBe(
      'SELECT * FROM t WHERE a = ?',
    );
    expect(clean("a = 'C:\\temp\\' AND b = 'secretQ' AND c = 1")).toBe('a = ?');
  });

  it('does not read a backslash in a backtick identifier as an escape', () => {
    expect(clean("SELECT `a\\` = 'secretB' AND `x` FROM t")).toBe(
      'SELECT `a\\` = ? AND `x` FROM t',
    );
  });

  it('drops a MySQL # comment', () => {
    expect(clean("SELECT 1 # it's\nFROM t WHERE x = 'secretH'")).toBe(
      'SELECT ?  \nFROM t WHERE x = ?',
    );
  });

  it('honours nested block comments', () => {
    expect(clean("/* outer /* inner */ it's */ SELECT * FROM t WHERE x = 'secretN'")).toBe(
      '  SELECT * FROM t WHERE x = ?',
    );
    expect(clean("SELECT 1 /* a /* b */ 'secret")).toBe('SELECT ?  ');
  });

  it('recognises a dollar-quote tag of any length', () => {
    const tag = `$${'a'.repeat(140)}$`;
    expect(clean(`SELECT ${tag}it's${tag}, 'secretT'`)).toBe('SELECT ?, ?');
  });

  it('redacts exponent and hex numeric literals', () => {
    expect(clean('SELECT 1e10, 2.5E-3, 0xDEADBEEF, c1 FROM t1')).toBe('SELECT ?, ?, ?, c1 FROM t1');
  });
});
