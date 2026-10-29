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
    expect(clean("INSERT INTO t VALUES ('O\\'Brien','secretC')")).toBe('INSERT INTO t VALUES (??');
    expect(clean('SELECT "a\\"b secret"')).toBe('SELECT ??');
  });

  it('fails closed on dollar-quoted bodies (only some dialects have them), keeping the agreed prefix', () => {
    expect(clean("SELECT $$it's$$, 'secretD'")).toBe('SELECT ?');
    expect(clean("SELECT $q$it's $$ x$q$, 'secretE'")).toBe('SELECT ?');
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

  it('keeps a backtick identifier whole', () => {
    expect(clean("SELECT `a b` FROM t WHERE a = 'secretF'")).toBe(
      'SELECT `a b` FROM t WHERE a = ?',
    );
  });

  it('fails closed on a backtick run containing a quote (a quote delimiter in other dialects)', () => {
    expect(clean("SELECT `it's` FROM t WHERE a = 'secretF'")).toBe('SELECT ?');
    expect(clean("SELECT * FROM t WHERE a = `x AND b = 'secret' AND c = `")).toBe(
      'SELECT * FROM t WHERE a = ?',
    );
  });

  it('fails closed on a double quote inside a backtick run', () => {
    expect(clean('SELECT `a"b` FROM t WHERE x = "secretD"')).toBe('SELECT ?');
  });

  it('fails closed on an unterminated backtick identifier', () => {
    expect(clean("SELECT `it's 'secret")).toBe('SELECT ?');
  });

  it('does not treat a lone dash or slash as a comment', () => {
    expect(clean('SELECT a-b, c/d FROM t')).toBe('SELECT a-b, c/d FROM t');
  });

  it('fails closed on a literal ending in a backslash (standard SQL: complete; MySQL: escape)', () => {
    expect(clean("SELECT * FROM t WHERE a = 'C:\\' AND b = 'secretP'")).toBe(
      'SELECT * FROM t WHERE a = ??',
    );
    expect(clean("a = 'C:\\temp\\' AND b = 'secretQ' AND c = 1")).toBe('a = ??');
  });

  it('does not read a backslash in a backtick identifier as an escape', () => {
    expect(clean("SELECT `a\\` = 'secretB' AND `x` FROM t")).toBe(
      'SELECT `a\\` = ? AND `x` FROM t',
    );
  });

  it('fails closed on a # (a MySQL comment, a Postgres operator)', () => {
    expect(clean("SELECT 1 # it's\nFROM t WHERE x = 'secretH'")).toBe('SELECT ? ?');
  });

  it('handles nested block comments', () => {
    // MySQL ends the comment at the first `*/`, Postgres at the second: the readings disagree, so cut.
    expect(clean("/* outer /* inner */ it's */ SELECT * FROM t WHERE x = 'secretN'")).toBe(' ?');
    // ...and when nesting makes no difference the comment is simply dropped.
    expect(clean("/* a */ SELECT 'secretM' /* b */")).toBe('  SELECT ?  ');
    expect(clean("SELECT 1 /* a /* b */ 'secret")).toBe('SELECT ?  ?');
  });

  it('does not let a dollar-quote tag of any length slip through', () => {
    const tag = `$${'a'.repeat(140)}$`;
    expect(clean(`SELECT ${tag}it's${tag}, 'secretT'`)).toBe('SELECT ?');
  });

  it('redacts exponent and hex numeric literals', () => {
    expect(clean('SELECT 1e10, 2.5E-3, 0xDEADBEEF, c1 FROM t1')).toBe('SELECT ?, ?, ?, c1 FROM t1');
  });

  it.each([
    // each leaked under a one-dialect reading of `#`, `--`, nested comments or dollar quotes
    ["SELECT data #>> '{a}' FROM t WHERE note = 'line1\nsecretline2'", 'secretline2'],
    ["UPDATE t SET flags = flags # 4, note = 'Dear J,\nSSN hunter'", 'hunter'],
    ["SELECT 1--'abc\nsecret'", 'secret'],
    ["SELECT /* a /* b */ x = 'p */ secret'", 'secret'],
    ["SELECT $a$ FROM t WHERE x = 'p$a$ ' AND y = 'secret'", 'secret'],
  ])('never lets literal data through under any dialect reading: %j', (sql, secret) => {
    expect(clean(sql)).not.toContain(secret);
  });

  it('keeps `--` followed by whitespace as an ordinary comment in every dialect', () => {
    expect(clean("SELECT 1 -- it's\nFROM t WHERE x = 'secret'")).toBe(
      'SELECT ?  \nFROM t WHERE x = ?',
    );
    expect(clean('SELECT 1 --\nFROM t')).toBe('SELECT ?  \nFROM t');
  });

  it.each([
    ["SELECT 1 -- c\r, 'x\nsecret1', 'secret2'", 'secret'],
    [
      "INSERT INTO u (note, dir, email) VALUES (E'x\\', ', 'alice\\', 'alice@example.com')",
      'alice',
    ],
    ['SELECT $é$secret data$é$, $tag$ok$tag$', 'secret'],
  ])('never lets literal data through: %j', (sql, secret) => {
    expect(clean(sql)).not.toContain(secret);
  });

  it('cuts at a lone carriage return after a -- comment (Postgres ends it there, MySQL does not)', () => {
    expect(clean("SELECT 1 -- it's\r, 'secret'")).toBe('SELECT ?  ?');
  });

  it('lexes a MySQL executable comment body as code, so a `*/` inside its string cannot hide a literal', () => {
    expect(clean("SELECT /*!50000 'a*/b' */ x FROM t WHERE p = 'secret'")).not.toContain('secret');
    expect(clean("SELECT 1 /*M!100000 + LENGTH('*/z') */ AS y, 'secret2'")).not.toContain(
      'secret2',
    );
    expect(clean("SELECT /*+ SET_VAR(x='*/y') */ 1, 'secret3'")).not.toContain('secret3');
  });

  it('ends # and -- comments at LF only for MySQL and SQLite, so a CR cannot hide a literal', () => {
    expect(clean("SELECT c FROM t -- see\r it's\n WHERE a = 'k' AND p = 'secret'")).toBe(
      'SELECT c FROM t  ?',
    );
  });

  it.each([
    // SQL Server `[..]` identifiers, Oracle `q'..'` / `nq'..'` quoting, BigQuery triple quotes: a quote inside
    // them shifts the pairing in the plain readings, so the readings disagree and the tail is cut.
    ["SELECT [it's] FROM t WHERE a = 'secret1' AND b = 'x'", 'secret1', 'SELECT [it?'],
    ["SELECT q'[O'Brien secret2]' FROM dual WHERE a = 'secret2b'", 'secret2', 'SELECT q??'],
    ["SELECT nq'{O'Brien secret3}', 'secret3b' FROM dual", 'secret3', 'SELECT nq??'],
    ["SELECT '''it's secret4''' FROM t WHERE a = 'secret4b'", 'secret4', 'SELECT ??'],
    ['SELECT """it"s secret5""" FROM t WHERE a = "secret5b"', 'secret5', 'SELECT ??'],
    ["SELECT [a]]b'c] , 'secret6'", 'secret6', 'SELECT [a]]b?'],
  ])('fails closed on bracket, q-quote and triple-quote constructs: %j', (sql, secret, out) => {
    expect(clean(sql)).not.toContain(secret);
    expect(clean(sql)).toBe(out);
  });

  it('fails closed on an unterminated bracket run, q-quote or triple quote', () => {
    expect(clean("SELECT [abc 'secret7")).toBe('SELECT ?');
    expect(clean("SELECT q'[abc secret8")).toBe('SELECT q?');
    expect(clean("SELECT '''abc secret9")).toBe('SELECT ?');
    expect(clean("SELECT '''abc\\'''secret10")).toBe('SELECT ??');
  });

  it('keeps ordinary bracketed identifiers, subscripts and q-lookalikes intact', () => {
    expect(clean('SELECT [col] FROM [t] WHERE arr[2] = x')).toBe(
      'SELECT [col] FROM [t] WHERE arr[?] = x',
    );
    expect(clean("SELECT '' FROM t WHERE a = 'x'")).toBe('SELECT ? FROM t WHERE a = ?');
    expect(clean("SELECT faq'x' FROM t")).toBe('SELECT faq? FROM t');
    expect(clean("SELECT q' x' FROM t")).toBe('SELECT q? FROM t');
  });

  it.each([
    ['SELECT * FROM t WHERE ssn=123456789AND x=1', '123456789'],
    ['SELECT * FROM t WHERE ssn=123456789OR x=1', '123456789'],
    ['SELECT * FROM t WHERE x=0xDEADBEEFAND y=1', 'DEADBEEF'],
    ['SELECT * FROM t WHERE x=1e5AND y=1', '1e5'],
  ])('redacts a number glued to a following keyword: %j', (sql, secret) => {
    expect(clean(sql)).not.toContain(secret);
  });

  it('reads well-formed q-quotes and triple quotes without cutting the statement', () => {
    expect(clean("SELECT q'(abc)', q'<d>', Q'{e}', q'[f]', nq'!g!' FROM t WHERE a = 'x'")).toBe(
      'SELECT q?, q?, Q?, q?, nq? FROM t WHERE a = ?',
    );
    expect(clean("SELECT Q'{O'B secret13}' , 'secret14' FROM t")).not.toMatch(/secret1[34]/);
    expect(clean("SELECT q'' , 'a' FROM t")).toBe('SELECT q? , ? FROM t');
    expect(clean("SELECT '''abc''' FROM t WHERE a = 'x'")).toBe('SELECT ? FROM t WHERE a = ?');
    expect(clean('SELECT """abc""" FROM t WHERE a = "x"')).toBe('SELECT ? FROM t WHERE a = ?');
  });

  it('does not end a triple-quoted body at a backslash-escaped quote', () => {
    const out = clean("SELECT '''a\\''' secret11''' FROM t WHERE b = 'secret12'");
    expect(out).not.toContain('secret11');
    expect(out).not.toContain('secret12');
  });

  it('still leaves digits inside identifiers alone', () => {
    expect(clean('SELECT a1b2, _3, t.c4, col12, x345 FROM t5')).toBe(
      'SELECT a1b2, _3, t.c4, col12, x345 FROM t5',
    );
  });

  it('never lets a literal survive: randomised well-formed statements in each dialect', () => {
    let seed = 12345;
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const pick = <T>(items: readonly T[]): T => items[rnd(items.length)] as T;
    // nasty text that is plain content inside whichever construct it is generated for
    const junk = ['[', ']', '--', '/*', '*/', '#', '$$', '"', '`', ' ', 'x', '{', '}', '(', ')'];
    const body = (extra: readonly string[], marker: string, drop: RegExp): string => {
      const parts = [marker];
      for (let n = rnd(6); n > 0; n--) {
        parts.splice(rnd(parts.length + 1), 0, pick([...junk, ...extra]).replace(drop, ''));
      }
      return parts.join('');
    };
    const T1 = "'".repeat(3);
    const makers: ((marker: string) => string)[] = [
      (m) => `'${body(["''"], m, /^$/)}'`,
      (m) => `'${body(["\\'", '\\\\'], m, /^$/)}'`,
      (m) => `E'${body(["\\'", "''"], m, /^$/)}'`,
      (m) => `$t$${body(["'"], m, /^$/)}$t$`,
      // a bracketed identifier is kept by design, so it carries no marker: only what FOLLOWS it must stay redacted
      () => `[${body(["'"], 'id', /\]/)}]`,
      (m) => `q'[${body(["'"], m, /\]/)}]'`,
      (m) => `nq'{${body(["'"], m, /\}/)}}'`,
      (m) => `${T1}${body(["'", '"', "\\'"], m, /^$/).replaceAll(T1, 'x')}${T1}`,
      (m) => `"${body(["''"], m, /"/)}"`,
      (m) => `/* ${body(["'"], m, /\*\//)} */`,
      (m) => `-- ${body(["'"], m, /^$/)}\n`,
    ];
    for (let run = 0; run < 3000; run++) {
      const markers: string[] = [];
      let sql = 'SELECT ';
      for (let n = rnd(3) + 1; n > 0; n--) {
        const marker = `zq${run}k${n}z`;
        markers.push(marker);
        sql += `${pick(makers)(marker)}${pick([' ', ' = ', ', ', ' AND '])}`;
      }
      const digits = `9${run}7${rnd(1000)}1`;
      markers.push(digits);
      sql += `x = ${digits}${pick(['AND', ' AND', 'OR'])} y = 'zqend'`;
      const out = clean(sql);
      for (const marker of markers) expect(out, sql).not.toContain(marker);
      expect(out, sql).not.toContain('zqend');
    }
  });

  it('redacts underscore-separated, binary and octal numeric literals', () => {
    expect(clean('SELECT 1 WHERE a = 4111_1111_1111_1111 OR b = 0b1010 OR c = 0o777')).toBe(
      'SELECT ? WHERE a = ? OR b = ? OR c = ?',
    );
  });

  it.each([
    ['SELECT `$$`, secret, `$$` FROM t', 'secret'],
    ['SELECT a `$$secret$$` b FROM t', 'secret'],
    ['SELECT 1$$secret$$', 'secret'],
    ['SELECT * FROM t WHERE a = $1$$secret$$', 'secret'],
  ])('fails closed on a dollar quote after a backtick or a digit: %j', (sql, secret) => {
    expect(clean(sql)).not.toContain(secret);
  });

  it.each([
    ['SELECT `a $$ secret ` $$', 'secret'],
    ["SELECT ` -- secret `\n FROM t WHERE a = 'x'", 'secret'],
    ['SELECT ` /* secret */ ` FROM t', 'secret'],
    ["SELECT ` # secret `\n FROM t WHERE a = 'x'", 'secret'],
  ])('fails closed on a comment or dollar opener inside a backtick run: %j', (sql, secret) => {
    expect(clean(sql)).not.toContain(secret);
  });

  it('pins the known shape losses of the cross-dialect cut (safe side: no literal survives)', () => {
    expect(clean("SELECT data #> '{a}' FROM t WHERE id = 5")).toBe('SELECT data ?');
    expect(clean("SELECT * FROM #tmp WHERE id = 5 AND n = 'x'")).toBe('SELECT * FROM ?');
    expect(clean("SELECT 1 /*+ IndexScan(t) */ FROM t WHERE a = 'x'")).toBe('SELECT ? ?');
  });

  it('compares the readings by SOURCE position, so a suffix that only prints the same is cut', () => {
    // MySQL: `'a\'secretZ'` is one literal and `tail` an alias; Postgres/standard: `'a\'`, code `secretZ`, then an
    // unterminated literal. The readings print `?tail` and `?secretZ?`, so the cut is after the first `?`.
    expect(clean("SELECT 'a\\'secretZ'tail")).toBe('SELECT ??');
    // Here the readings print the SAME word, but it comes from different parts of the input (MySQL: the trailing
    // word, where the first is literal content; Postgres: the first). Comparing printed text alone kept it.
    expect(clean("SELECT 'a\\'PASSWORD'PASSWORD")).toBe('SELECT ??');
    expect(clean("SELECT 'x\\'SECRET'SECRET FROM t")).toBe('SELECT ??');
    expect(clean("SELECT 'a\\'hunter2'hunter2 FROM t WHERE id = 5")).toBe('SELECT ??');
  });

  it('redacts an exponent after a decimal point with no fraction digits', () => {
    expect(clean('SELECT 1.e5 FROM t')).toBe('SELECT ? FROM t');
    expect(clean('SELECT 123.e45, .5e3, 1.5e+3 FROM t')).toBe('SELECT ?, .?, ? FROM t');
    expect(clean('SELECT 12.E-7')).toBe('SELECT ?');
    expect(clean('SELECT 1..2, a1.e FROM t')).toBe('SELECT ?.?, a1.e FROM t');
  });

  it('redacts an exponent with underscore separators', () => {
    expect(clean('SELECT 1e1_000')).toBe('SELECT ?');
  });

  it('pins the exact output of truncated and minimal executable comments', () => {
    expect(clean('/*!')).toBe('?');
    expect(clean('/*M')).toBe(' ');
    expect(clean('/*M!')).toBe('?');
    expect(clean('/*!12')).toBe('?');
    expect(clean('a$$$')).toBe('a$$$');
  });
});
