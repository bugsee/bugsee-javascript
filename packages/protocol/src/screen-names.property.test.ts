import { describe, expect, it } from 'vitest';
import { sanitizeRoutePattern } from './screen-names';

// Seeded, deterministic property tests for the route sanitizer: strings are built from path chunks and the characters
// that matter to it (`?` `=` `&` `(` `)` `\` `:` `@` `%40`), plus seeded secrets. The same seed always generates the same
// strings, so a failure reproduces; the failing input is in the assertion message.

const mulberry32 = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
const pick = <T>(rnd: () => number, items: readonly T[]): T =>
  items[Math.floor(rnd() * items.length)] as T;

const SECRET = 'SECRETx9f8a7b6c';
const CHUNKS = [
  '/orders',
  '/users',
  '/:id',
  '/:id?',
  '/[id]',
  '/[[lang]]',
  '/(app)',
  '/:file?.json',
  '/x.y',
  '/a-b',
  '/:a?-:b?',
  '/*',
  '/@me',
  '/p(\\d+)',
  '/:id(\\d+)?',
  '/{foo}?',
  '/api',
  '/v1.2',
  '/:id(colou?r)',
  '/files/:path*',
  '/blog/:slug+',
];
const NOISE = [
  '?',
  '=',
  '&',
  '(',
  ')',
  '\\',
  ':',
  '@',
  '%40',
  '/',
  '.',
  '-',
  '_',
  '~',
  '*',
  '+',
  'a',
  'b',
  'id',
  '1',
  '#',
  'é',
  ' ',
];

const generic = (rnd: () => number): string => {
  let out = '';
  const parts = 1 + Math.floor(rnd() * 8);
  for (let i = 0; i < parts; i++)
    out += rnd() < 0.5 ? pick(rnd, CHUNKS) : pick(rnd, NOISE).repeat(1 + Math.floor(rnd() * 2));
  if (rnd() < 0.3) out += pick(rnd, NOISE) + SECRET;
  return out;
};

describe('sanitizeRoutePattern: properties over seeded generated strings', () => {
  it('is idempotent: sanitizing the output again changes nothing', () => {
    const rnd = mulberry32(20261027);
    for (let i = 0; i < 4000; i++) {
      const input = generic(rnd);
      const once = sanitizeRoutePattern(input);
      if (once === undefined) continue;
      expect(sanitizeRoutePattern(once), JSON.stringify(input)).toBe(once);
    }
  });

  it('never leaves a `?` followed by `=` or `&` (outside regexp group syntax)', () => {
    const rnd = mulberry32(20261028);
    for (let i = 0; i < 4000; i++) {
      const input = generic(rnd);
      const out = sanitizeRoutePattern(input);
      if (out === undefined) continue;
      const withoutGroups = out.replace(/\(\?(?:[:=!]|<[=!]?)/g, '(');
      expect(
        /\?[^)?]*[=&]/.test(withoutGroups),
        `${JSON.stringify(input)} -> ${JSON.stringify(out)}`,
      ).toBe(false);
    }
  });

  it('never keeps a secret that follows a `?` which cannot be a modifier', () => {
    const rnd = mulberry32(20261029);
    // bases end in a plain word (no param token, no group close), so the `?` after one is always a query
    const bases = [
      '/orders',
      '/x.y',
      '/a-b',
      '/:id.json',
      '/a:b',
      '/index.php',
      '/:id-x',
      '/s',
      '/v1.2',
    ];
    const seps = [
      '',
      '/',
      '-',
      '_',
      '.',
      ':',
      '~',
      '*',
      '+',
      '=',
      '&',
      ')',
      '?',
      '\\',
      '%40',
      '@',
      '(',
      '/-',
      '/_',
    ];
    for (let i = 0; i < 4000; i++) {
      let prefix = '';
      for (let k = Math.floor(rnd() * 3); k > 0; k--)
        prefix += pick(rnd, ['/orders', '/:id', '/[id]', '/p(x)', '/:a?', '/*']);
      const input = `${prefix}${pick(rnd, bases)}?${pick(rnd, seps)}${pick(rnd, seps)}${SECRET}${rnd() < 0.5 ? '' : `&x=${SECRET}`}`;
      const out = sanitizeRoutePattern(input);
      expect(
        out === undefined || !out.includes('SECRET'),
        `${JSON.stringify(input)} -> ${JSON.stringify(out)}`,
      ).toBe(true);
    }
  });

  it('never keeps a secret after an escaped question mark followed by key=value', () => {
    const rnd = mulberry32(20261030);
    for (let i = 0; i < 1000; i++) {
      const input = `${pick(rnd, ['/a', '/:id', '/x.y', '/orders/:id'])}\\?${pick(rnd, ['tok', 'k', 'a.b'])}${pick(rnd, ['=', '&'])}${SECRET}`;
      const out = sanitizeRoutePattern(input);
      expect(
        out === undefined || !out.includes('SECRET'),
        `${JSON.stringify(input)} -> ${JSON.stringify(out)}`,
      ).toBe(true);
    }
  });

  it('redacts an address in a path segment, plain, encoded or non-ASCII', () => {
    const rnd = mulberry32(20261031);
    const locals = ['alice', 'a.b+c', 'josé', 'алиса', 'x_y-z', 'u1'];
    const domains = ['example.com', 'x-y.co.uk', 'b.io', 'exämple.de', 'пример.рф'];
    for (let i = 0; i < 1000; i++) {
      const at = pick(rnd, ['@', '%40']);
      const email = `${pick(rnd, locals)}${at}${pick(rnd, domains)}`;
      const input = `${pick(rnd, ['/u/', '/verify/', '/a/b/'])}${email}${pick(rnd, ['', '/orders', '/x/y'])}`;
      const out = sanitizeRoutePattern(input) as string;
      expect(
        out.includes('@') || out.includes('%40') || out.includes(email),
        `${JSON.stringify(input)} -> ${out}`,
      ).toBe(false);
    }
  });
});

describe('sanitizeRoutePattern: real framework patterns survive unchanged', () => {
  const real = [
    // react-router / Remix
    '/',
    '/users/:id',
    '/users/:id/edit',
    '/files/*',
    '/:lang?/about',
    '/docs/:section?/:page?',
    '/teams/:teamId/members/:memberId',
    // vue-router 4
    '/user/:id(\\d+)',
    '/:pathMatch(.*)*',
    '/users/:id?',
    '/:chapters+',
    '/:chapters*',
    '/files/:file(.*?\\.json)',
    '/:id(colou?r)',
    '/posts/:slug(\\w+)?',
    '/users/:userId(\\d+)/posts/:postId',
    '/(foo|bar)',
    // express 4/5 / path-to-regexp
    '/user/:id?',
    '/foo{/bar}?',
    '/:from-:to',
    '/:file.:ext',
    '/flights/:from-:to',
    '/api/v:version/items',
    '/:a?-:b?',
    '/:file?.json',
    '/*splat',
    // SvelteKit / Next / Nuxt / Astro / Angular
    '/blog/[slug]',
    '/shop/[...rest]',
    '/[[lang]]/about',
    '/(app)/dashboard',
    '/[org]/[repo]',
    '/@:username',
    '/users/@me',
    '/heroes/:id',
    '/crisis-center',
    '/orders/[id]/items/[itemId]',
    '/docs/[[...slug]]',
    '/_app/[token]',
    '/:id(\\d+)?',
    '/package/react@18.2.0',
    '/@scope/pkg@1.2.3',
    '/p/:id/*',
    '/:lang(en|de)/home',
    '/o/:org/r/:repo/issues/:n(\\d+)',
    '/cat/:name{-:id}?',
    '/static/*path',
    '/:a/:b/:c',
    '/search/:q?/page/:n?',
    '/(group)/(nested)/x',
    '/api/:v(v\\d+)/users/:id?',
  ];
  it('has at least 44 patterns', () => {
    expect(real.length).toBeGreaterThanOrEqual(44);
  });
  for (const pattern of real) {
    it(`keeps ${pattern}`, () => {
      expect(sanitizeRoutePattern(pattern)).toBe(pattern);
    });
  }
});
