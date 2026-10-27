import { describe, expect, it } from 'vitest';
import { expectLinearIn, LINEARITY_TEST_TIMEOUT_MS } from './linear-time.test-helper';
import {
  MAX_ROUTE_CHARS,
  MAX_VIEW_FIELD_CHARS,
  normalizeView,
  sanitizeRoutePattern,
  VIEW_NONE,
} from './screen-names';

const R = '%3Credacted%3E';
const MARK = '%3Ctruncated%3E';

describe('sanitizeRoutePattern', () => {
  it.each([
    ['/orders/:id', '/orders/:id'],
    ['/orders/[id]', '/orders/[id]'],
    ['/(app)/[[lang]]/x', '/(app)/[[lang]]/x'],
    ['/user/:id(\\d+)?/edit', '/user/:id(\\d+)?/edit'], // an optional-param `?` is pattern syntax, not a query
    ['/user/:id?', '/user/:id?'],
    ['/a/:b?/:c?', '/a/:b?/:c?'],
    ['/:p(\\d+?)/x', '/:p(\\d+?)/x'], // `?` before `)` is regexp syntax inside a param pattern
    ['/post/:slug+', '/post/:slug+'],
    // real vue-router / path-to-regexp patterns whose `?` is regexp or modifier syntax
    ['/:id(colou?r)', '/:id(colou?r)'],
    ['/:file(.*?\\.json)', '/:file(.*?\\.json)'],
    ['/:file?.json', '/:file?.json'],
    ['/:a?-:b?', '/:a?-:b?'],
    ['/(a(b?)c)/x', '/(a(b?)c)/x'],
    ['/:id(a\\)b?c)/x', '/:id(a\\)b?c)/x'], // an escaped `)` does not close the group, so this `?` is regexp syntax
    ['/:a??', '/:a??'],
    [':name@:domain', ':name@:domain'],
    ['/:id(\\(x?)/y', '/:id(\\(x?)/y'], // an escaped paren does not change the depth
    ['/', '/'],
  ])('keeps the pattern %s as given', (input, expected) => {
    expect(sanitizeRoutePattern(input)).toBe(expected);
  });

  it.each([
    ['/x?token=abc', '/x'],
    ['/x?tab=items', '/x'],
    ['/a/:b?/c?x=1', '/a/:b?/c'],
    ['/x#frag', '/x'],
    ['/x#access_token=abc', '/x'],
    ['/x?a=1#b', '/x'],
    ['/x#a?b=1', '/x'],
    ['/x?token', '/x'], // a bare key is a query too
    ['/a?/next=/home&email=alice@example.com', '/a'], // `?` before `/` but a real query: `=` / `&` follow
    ['/a?x=1/(b?c)', '/a'],
    ['/a?/x&y', '/a'], // `&` alone makes it a query
    ['/a?/n=1', '/a'], // `=` alone too
    ['/(a?)b)', '/(a'], // unbalanced: the depth is not trusted, and a `?` after a plain character is a query
    ['/a)((b?c)', '/a)((b'], // a stray `)` makes the depth untrustworthy: the `?` is still a query
    ['/a)(b?c))', '/a)(b'], // parentheses after the query start do not hide it
    ['/a(?x=secret', '/a('], // an unbalanced paren: depth is not trusted, the query is cut
  ])('never keeps a query or fragment: %s', (input, expected) => {
    expect(sanitizeRoutePattern(input)).toBe(expected);
  });

  it('redacts a secret-shaped token in the path (the shared sanitizer runs on the pathname fallback)', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk';
    expect(sanitizeRoutePattern(`/a/${jwt}`)).toBe('/a/<redacted>');
  });

  it('redacts a sensitive matrix segment', () => {
    expect(sanitizeRoutePattern('/app;jsessionid=1/x')).toBe(`/app;jsessionid=${R}/x`);
  });

  it('returns undefined for a non-string, empty or whitespace-only route, or one that is only a query', () => {
    for (const bad of [
      undefined,
      null,
      5,
      {},
      ['/x'],
      '',
      '   ',
      '?a=1',
      '#x',
      '?',
      '?/orders/1',
    ]) {
      expect(sanitizeRoutePattern(bad)).toBeUndefined();
    }
  });

  it('trims surrounding whitespace', () => {
    expect(sanitizeRoutePattern('  /x/:id \n')).toBe('/x/:id');
  });

  it('clips at MAX_ROUTE_CHARS and marks the clip', () => {
    expect(MAX_ROUTE_CHARS).toBe(1024);
    const exact = `/${'a'.repeat(MAX_ROUTE_CHARS - 1)}`;
    expect(sanitizeRoutePattern(exact)).toBe(exact);
    const over = `${exact}b`;
    expect(sanitizeRoutePattern(over)).toBe(`${exact}${MARK}`);
  });

  it('is linear-ish on huge input (bounded work)', () => {
    const out = sanitizeRoutePattern(`/${'a'.repeat(5_000_000)}`);
    expect(out?.length).toBe(MAX_ROUTE_CHARS + MARK.length);
  });
});

describe('normalizeView', () => {
  it('maps null to the "$$none" sentinel', () => {
    expect(VIEW_NONE).toBe('$$none');
    expect(normalizeView(null)).toBe('$$none');
  });

  it('maps a string to {name}', () => {
    expect(normalizeView('OrderDetail')).toEqual({ name: 'OrderDetail' });
  });

  it('keeps name and type of an object, and drops an unusable type', () => {
    expect(normalizeView({ name: 'OrderDetail', type: 'angular' })).toEqual({
      name: 'OrderDetail',
      type: 'angular',
    });
    expect(normalizeView({ name: 'A1', type: '' })).toStrictEqual({ name: 'A1' });
    expect(normalizeView({ name: 'A1', type: 5 as never })).toStrictEqual({ name: 'A1' });
    expect(normalizeView({ name: 'A1', type: undefined })).toStrictEqual({ name: 'A1' });
    expect(normalizeView('A1')).toStrictEqual({ name: 'A1' }); // no `type` key at all
  });

  it('writes keys in a fixed order (name, type) so equal views serialize equally', () => {
    const v = normalizeView({ type: 'vue', name: 'X1' } as never);
    expect(Object.keys(v as object)).toEqual(['name', 'type']);
  });

  it('returns undefined for anything that is not a usable view', () => {
    for (const bad of [
      undefined,
      5,
      true,
      '',
      '   ',
      {},
      { name: '' },
      { name: 5 },
      { type: 'x' },
      [],
    ]) {
      expect(normalizeView(bad as never)).toBeUndefined();
    }
  });

  it('runs name and type through the shared sanitizer', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk';
    expect(normalizeView(jwt)).toEqual({ name: '<redacted>' });
    expect(normalizeView({ name: 'ok', type: jwt })).toEqual({ name: 'ok', type: '<redacted>' });
    expect(normalizeView('javascript:alert(1)')).toEqual({ name: `javascript:${R}` });
  });

  it('keeps ordinary names with spaces and punctuation', () => {
    expect(normalizeView('Order Detail (v2)')).toEqual({ name: 'Order Detail (v2)' });
  });

  it('clips each field at MAX_VIEW_FIELD_CHARS and marks the clip', () => {
    expect(MAX_VIEW_FIELD_CHARS).toBe(256);
    const exact = 'a'.repeat(MAX_VIEW_FIELD_CHARS);
    expect(normalizeView(exact)).toEqual({ name: exact });
    expect(normalizeView({ name: `${exact}b`, type: `${exact}c` })).toEqual({
      name: exact + MARK,
      type: exact + MARK,
    });
  });
});

describe('sanitizeRoutePattern: credentials and personal data', () => {
  it.each([
    ['https://alice:hunter2@host.com/x', 'https://host.com/x'],
    ['https://alice@host.com/x', 'https://host.com/x'],
    ['http://a:b@c:8080/p/:id', 'http://c:8080/p/:id'],
    ['alice:pw@host/x', 'host/x'],
    ['//u:p@host/x', '//host/x'],
    ['https:/u:p@a.com/x', 'https://a.com/x'],
  ])('strips the userinfo of %s', (input, expected) => {
    expect(sanitizeRoutePattern(input)).toBe(expected);
  });

  it('keeps router syntax that merely contains an @ (a handle route, a param before @)', () => {
    expect(sanitizeRoutePattern('/@:username')).toBe('/@:username');
    expect(sanitizeRoutePattern('/users/@me')).toBe('/users/@me');
    expect(sanitizeRoutePattern('@me/profile')).toBe('@me/profile');
    expect(sanitizeRoutePattern('/:name@:domain')).toBe('/:name@:domain');
  });

  it('an EMPTY userinfo is dropped too (so the output is stable: the shared sanitizer would redact it, and a second pass would strip that)', () => {
    expect(sanitizeRoutePattern('https://@host/x')).toBe('https://host/x');
    expect(sanitizeRoutePattern('//@host/x')).toBe('//host/x');
    expect(sanitizeRoutePattern('//@@host/x')).toBe('//host/x'); // every leading userinfo, so a second pass finds none
    expect(sanitizeRoutePattern('https://a@b@host/x')).toBe('https://host/x');
    expect(sanitizeRoutePattern('//\\@@+x')).toBe('//+x'); // a backslash is a slash to the shared sanitizer
    expect(sanitizeRoutePattern('https:\\\\u:p@h/x')).toBe('https://h/x');
  });

  it('redacts an e-mail address in a path segment', () => {
    expect(sanitizeRoutePattern('/verify/alice@example.com/done')).toBe(`/verify/${R}/done`);
    expect(sanitizeRoutePattern('/u/a.b+c@x-y.co.uk')).toBe(`/u/${R}`);
  });
});

describe('sanitizeRoutePattern: a secret is never half-kept at the length limit', () => {
  const token = `ghp_${'Ab3dEf6hIj9'.repeat(4).slice(0, 36)}`;

  it('redacts a token that straddles the cut (the whole string is sanitized, then clipped)', () => {
    for (const pad of [MAX_ROUTE_CHARS - 12, MAX_ROUTE_CHARS - 20, MAX_ROUTE_CHARS - 40]) {
      const out = sanitizeRoutePattern(`/${'x'.repeat(pad)}/${token}/tail`) as string;
      expect(out).not.toContain('ghp_');
      expect(out).not.toContain('Ab3dEf6');
    }
  });

  it('still clips the sanitized result to the limit and marks it', () => {
    const out = sanitizeRoutePattern(`/${'x'.repeat(2000)}/${token}`) as string;
    expect(out.endsWith(MARK)).toBe(true);
    expect(out.length).toBe(MAX_ROUTE_CHARS + MARK.length);
  });

  it('a view name straddling the cut is redacted too', () => {
    const name = `${'n'.repeat(MAX_VIEW_FIELD_CHARS - 10)} ${token}`;
    const v = normalizeView(name) as { name: string };
    expect(v.name).not.toContain('ghp_');
    expect(v.name).not.toContain('Ab3dEf6');
  });
});

describe('normalizeView: a view value is informational (no e-mail or query treatment)', () => {
  it('keeps what the shared sanitizer keeps: a component name is not an address or a URL', () => {
    expect(normalizeView('Profile?tab=1')).toEqual({ name: 'Profile?tab=1' });
    expect(normalizeView('alice@example.com')).toEqual({ name: 'alice@example.com' });
  });
});

describe('sanitizeRoutePattern: documented limits', () => {
  it('an optional literal character is read as a query (fail closed): `/ab?cd` is `/ab`', () => {
    expect(sanitizeRoutePattern('/ab?cd')).toBe('/ab');
  });
});

describe('normalizeView: a hostile argument', () => {
  it('lets a throwing getter propagate to the caller of the pure function (the client contains it)', () => {
    const hostile = {
      get name(): never {
        throw new Error('boom');
      },
    };
    expect(() => normalizeView(hostile)).toThrow('boom');
  });
});

describe('sanitizeRoutePattern: a `?` is a modifier only after a param token', () => {
  it.each([
    ['/?/orders/123', '/'],
    ['/index.php?/controller/action', '/index.php'],
    ['/orders?/abc123secret', '/orders'],
    ['/s?-token9f8a', '/s'],
    ['/s?.hidden', '/s'],
    ['/s?:tok', '/s'],
    ['/s?~x', '/s'],
    ['/reset?_k9f8a7b6c5d4e3f2', '/reset'],
    ['/s?*x', '/s'],
    ['/s?+x', '/s'],
    ['/s??x', '/s'],
    ['/a/b?/c', '/a/b'],
    ['/:id?token9', '/:id'], // after a param, but what follows is a word: a query
    // a separator after the param is a query unless it joins another param or is an extension (round 3)
    ['/:id.json?_SECRET', '/:id.json'],
    ['/:id-x?~SECRET', '/:id-x'],
    ['/:a?-SECRETVALUE', '/:a'],
    ['/:a?~x', '/:a'],
    ['/a)?_SECRETVAL123', '/a)'],
    ['/:a?/x&y', '/:a'],
    ['/:a?/x=y', '/:a'],
    ['/a:b?/x', '/a:b'], // a colon after a word character is not a param
    ['/:a\\d?/y', '/:a\\d'], // an escape inside the name: not a bare param
    ['/:a(b)?/y', '/:a(b)?/y'], // after `)`: a modifier of the group
    ['/:a/b?/x', '/:a/b'], // the param ended at the `/`
    ['/:a?.abcdefg', '/:a'], // an "extension" of seven characters is a word
    ['/:f?.json?x=1', '/:f?.json'], // the extension may be followed by another `?` (the second is the query)
    ['/:a?.ab?', '/:a?.ab'],
    ['/:a?)', '/:a'],
    ['/x#frag\nSECRET', '/x'], // a fragment runs to the end, newlines included
    [' \t//u:p@host/x', '//host/x'], // surrounding whitespace is trimmed BEFORE the userinfo is looked for
    ['/:a?./x', '/:a'], // a `.` with no extension after it
    ['/:a?.', '/:a'],
    ['/:a(b?/x', '/:a(b'], // unclosed: the param ended at the `(`
    ['/:a)b?/x', '/:a)b'], // and at the `)`
    ['/a(b?c', '/a(b'], // an unclosed group: the depth is not trusted
    ['/:a:b?/x', '/:a:b'], // the second colon follows a word character
    ['/x:a?/y', '/x:a'],
    ['/:a-b?/x', '/:a-b'], // `-b` is not part of a param name: the `?` follows a literal
    ['/:a?.SECRETLONGVALUE', '/:a'], // `.` and then more than an extension
    // an escaped `\?` followed by key=value is a query too
    ['/a\\?tok=SECRETVAL', '/a'],
    ['/:id\\?tok=SECRETVAL', '/:id'],
    ['/a\\?x&y', '/a'],
  ])('cuts the query in %s', (input, expected) => {
    expect(sanitizeRoutePattern(input)).toBe(expected);
  });

  it.each([
    ['/:id?', '/:id?'],
    ['/:id?/edit', '/:id?/edit'],
    ['/a/:b?/:c?', '/a/:b?/:c?'],
    ['/:file?.json', '/:file?.json'],
    ['/:a?-:b?', '/:a?-:b?'],
    ['/:a?_:b', '/:a?_:b'],
    ['/x/:a?:b', '/x/:a?:b'],
    ['/:id(\\d+)?', '/:id(\\d+)?'], // after `)`
    ['/foo{/bar}?', '/foo{/bar}?'], // after `}`
    ['/foo[bar]?', '/foo[bar]?'], // after `]`
    [':id?', ':id?'], // a route with no leading slash: the colon is at the start
    [':id?/x', ':id?/x'],
    ['/:a?-:b', '/:a?-:b'],
    ['/:a?_:b', '/:a?_:b'],
    ['/:a?~:b', '/:a?~:b'],
    ['/:a?.:b', '/:a?.:b'],
    ['/:f?.json/x', '/:f?.json/x'],
    ['/:f?.abcdef', '/:f?.abcdef'], // an extension of six characters
    ['/a\\?b', '/a\\?b'], // an escaped `?` with no key=value after it is a literal
    ['/:x(a\\?b=c)', '/:x(a\\?b=c)'], // inside a group an escaped `?` is regexp
    ['/p\\d=x', '/p\\d=x'], // only `\?` is special: other escapes are not queries
    ['/a(b?c)=d', '/a(b?c)=d'], // an `=` after the group's `)` does not belong to the group
    ['/files/*?', '/files/*?'], // after `*`
    ['/:a*?/x', '/:a*?/x'],
    ['/(a|b)?/x', '/(a|b)?/x'], // after `)` that closes a plain group, no param token
    ['/foo(bar)?', '/foo(bar)?'],
  ])('keeps the modifier in %s', (input, expected) => {
    expect(sanitizeRoutePattern(input)).toBe(expected);
  });

  it('a modifier-looking `?` followed by a key=value is still a query', () => {
    expect(sanitizeRoutePattern('/:a?/next=/home&x=1')).toBe('/:a');
  });
});

describe('sanitizeRoutePattern: a query inside balanced parentheses', () => {
  it.each([
    ['/cb(?name=bob)', '/cb('],
    ['/cb(?q=alice%20smith)', '/cb('],
    ['/cb(?x)', '/cb('],
    ['/a(b)(?c=d)/e', '/a(b)('],
    ['/cb(?abc)', '/cb('],
    ['/cb(x?name=bob)', '/cb(x'],
    ['/wiki/Foo_(bar?user=alice&id=42)', '/wiki/Foo_(bar'],
    ['/files/report(1?sid=SECRETVAL)', '/files/report(1'],
    ['/cb(x?a&b)', '/cb(x'],
    ['/x(?', '/x('], // `(?` at the very end introduces nothing
  ])('cuts %s', (input, expected) => {
    expect(sanitizeRoutePattern(input)).toBe(expected);
  });

  it.each([
    '/:id(?:a|b)',
    '/x(?=y)z',
    '/x(?!y)z',
    '/x(?<n>y)z',
    '/x(?<=y)z',
    '/x(?<!y)z',
    '/:id(colou?r)',
    '/:file(.*?\\.json)',
    '/a(b?c)d(e?f)',
    '/x(?=a=b)',
  ])('keeps the regexp group syntax in %s', (input) => {
    expect(sanitizeRoutePattern(input)).toBe(input);
  });
});

describe('sanitizeRoutePattern: encoded and non-ASCII e-mail addresses', () => {
  it('redacts a percent-encoded address', () => {
    expect(sanitizeRoutePattern('/u/alice%40example.com')).toBe(`/u/${R}`);
    expect(sanitizeRoutePattern('/u/alice%40example.com/orders')).toBe(`/u/${R}/orders`);
    expect(sanitizeRoutePattern('/u/a.b%40x-y.co.uk')).toBe(`/u/${R}`);
  });

  it('redacts an address whose local part holds an encoded character', () => {
    expect(sanitizeRoutePattern('/u/a%2Bb@example.com')).toBe(`/u/${R}`);
    expect(sanitizeRoutePattern('/u/a%2Bb%40example.com')).toBe(`/u/${R}`);
  });

  it('keeps an encoded @ that is not an address', () => {
    expect(sanitizeRoutePattern('/pkg/react%4018.2.0')).toBe('/pkg/react%4018.2.0');
    expect(sanitizeRoutePattern('/a%40b')).toBe('/a%40b');
    expect(sanitizeRoutePattern('/:user%40:domain')).toBe('/:user%40:domain');
  });

  it('redacts a non-ASCII address (any script)', () => {
    expect(sanitizeRoutePattern('/u/алиса@пример.рф')).toBe(`/u/${R}`);
    expect(sanitizeRoutePattern('/u/josé@exämple.de/x')).toBe(`/u/${R}/x`);
    expect(sanitizeRoutePattern('/u/алиса%40пример.рф')).toBe(`/u/${R}`);
  });

  it('keeps a non-ASCII name that is not an address', () => {
    expect(sanitizeRoutePattern('/u/алиса@2.0')).toBe('/u/алиса@2.0');
  });
});

describe('sanitizeRoutePattern: real pathnames that look like e-mail addresses', () => {
  it.each([
    '/package/react@18.2.0',
    '/@scope/pkg@1.2.3',
    '/@scope/pkg',
    '/a/b@c.d/e',
    '/profile/@me',
    '/:user@:domain',
    '/u/:name@:host',
    '/[pkg]@[version]',
    '/x/pkg@1.2.3-beta.1',
  ])('keeps %s', (input) => {
    expect(sanitizeRoutePattern(input)).toBe(input);
  });

  it('still redacts an address with an alphabetic top-level domain', () => {
    expect(sanitizeRoutePattern('/verify/alice@example.com/done')).toBe(`/verify/${R}/done`);
    expect(sanitizeRoutePattern('/u/a.b+c@x-y.co.uk')).toBe(`/u/${R}`);
    expect(sanitizeRoutePattern('/u/a@b.io')).toBe(`/u/${R}`);
  });

  it('a name followed by more word characters after the top-level domain is not an address', () => {
    expect(sanitizeRoutePattern('/u/a@b.com1')).toBe('/u/a@b.com1');
  });

  it('known limit: an @2x image name has an alphabetic extension and is redacted', () => {
    expect(sanitizeRoutePattern('/img/logo@2x.png')).toBe(`/img/${R}`);
  });
});

describe('sanitizeRoutePattern: linear time (bounded input, relative ratio)', () => {
  const builds: Record<string, (size: number) => string> = {
    'one long run, no @': (size) => `/${'a'.repeat(size)}`,
    'a long run that ends in @': (size) => `/${'a'.repeat(size)}@`,
    'repeated local@': (size) => `/${'a@'.repeat(Math.ceil(size / 2))}`,
    'repeated e-mail-shaped tokens': (size) => `/${'a@b.co/'.repeat(Math.ceil(size / 7))}`,
    'a long domain without a top-level domain': (size) => `/a@${'b.'.repeat(Math.ceil(size / 2))}1`,
    'many question marks': (size) => `/${'?'.repeat(size)}`,
    'many modifiers': (size) => `/${':a?'.repeat(Math.ceil(size / 3))}`,
    'many open groups': (size) => `/${'(?'.repeat(Math.ceil(size / 2))}`,
    'many unbalanced parens': (size) => `/${')?('.repeat(Math.ceil(size / 3))}`,
    'repeated encoded @': (size) => `/${'a%40'.repeat(Math.ceil(size / 4))}`,
    'encoded address shapes': (size) => `/${'a%40b.co/'.repeat(Math.ceil(size / 9))}`,
    'many escaped question marks': (size) => `/${'\\\\?'.repeat(Math.ceil(size / 2))}`,
    'many params then ?': (size) => `/${':a'.repeat(Math.ceil(size / 2))}${'?'.repeat(size / 2)}`,
    'one param name then many ?': (size) => `/:${'a'.repeat(size / 2)}${'?'.repeat(size / 2)}`,
    'one group with many ?': (size) => `/(${'x?'.repeat(Math.ceil(size / 2))})`,
    'nested groups with ?': (size) => `/${'(a?'.repeat(Math.ceil(size / 3))}`,
  };
  for (const [name, build] of Object.entries(builds)) {
    it(
      `is linear on ${name}`,
      () => {
        expect(typeof sanitizeRoutePattern(build(8192))).toBe('string');
        expectLinearIn(
          build,
          (input) => {
            sanitizeRoutePattern(input);
          },
          8192,
        );
      },
      LINEARITY_TEST_TIMEOUT_MS,
    );
  }
});
