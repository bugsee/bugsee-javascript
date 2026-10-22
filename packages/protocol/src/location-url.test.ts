import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { expectLinearIn, LINEARITY_TEST_TIMEOUT_MS } from './linear-time.test-helper';
import { sanitizeLocationUrl } from './location-url';
import { sanitizeUrl } from './url';

// `sanitizeLocationUrl` is the sanitizer for the page's OWN address (the `url` trace, navigation breadcrumbs).
// `sanitizeUrl` is the NETWORK sanitizer and is deliberately unchanged: it has no scheme handling and no nested-URL
// scan. A page address can be any scheme the browser opens, so this layer adds both, then defers to `sanitizeUrl`.

const R = '%3Credacted%3E';

describe('sanitizeLocationUrl: the rule table', () => {
  const table: Array<[string, string, string]> = [
    // [rule, input, output]
    [
      'http(s): query value',
      'https://app.example.com/orders/42?token=abc&tab=items',
      `https://app.example.com/orders/42?token=${R}&tab=items`,
    ],
    ['http(s): userinfo password', 'https://u:p@a.com/x', `https://u:${R}@a.com/x`],
    [
      'http(s): fragment',
      'https://a.com/cb#access_token=abc&state=1',
      `https://a.com/cb#access_token=${R}&state=1`,
    ],
    [
      'http(s): matrix segment',
      'https://a.com/app;jsessionid=1/x',
      `https://a.com/app;jsessionid=${R}/x`,
    ],
    [
      'http(s): nothing to redact is unchanged',
      'https://a.com/orders/42?tab=items#top',
      'https://a.com/orders/42?tab=items#top',
    ],
    ['data: payload dropped', 'data:text/plain;token=abc,hello', `data:${R}`],
    [
      'data: scheme is case-insensitive and lowercased',
      'DATA:text/html,<h1>secret</h1>',
      `data:${R}`,
    ],
    ['javascript: dropped', 'javascript:alert(document.cookie)', `javascript:${R}`],
    ['vbscript: dropped', 'vbscript:msgbox(1)', `vbscript:${R}`],
    [
      'tab/newline obfuscation of the scheme is undone first',
      'java\tscr\nipt:alert(1)',
      `javascript:${R}`,
    ],
    [
      'a carriage return is dropped from the scheme too',
      'java\rscript:alert(1)',
      `javascript:${R}`,
    ],
    [
      'a NUL and other leading controls are skipped',
      '\u0000\u001f data:text/plain,secret',
      `data:${R}`,
    ],
    [
      'leading whitespace/control characters are skipped',
      '\u0001  data:text/plain,secret',
      `data:${R}`,
    ],
    [
      'blob: keeps only the inner origin, never userinfo',
      'blob:https://u:p@a.com/x',
      'blob:https://a.com',
    ],
    [
      'blob: drops the path and query',
      'blob:https://a.com:8080/4f1c-uuid?x=1#f',
      'blob:https://a.com:8080',
    ],
    ['blob: with an opaque origin has nothing to keep', 'blob:null/4f1c-uuid', `blob:${R}`],
    [
      'filesystem: is treated like blob:',
      'filesystem:https://a.com/temporary/f.txt',
      'filesystem:https://a.com',
    ],
    [
      'view-source: sanitizes what it wraps',
      'view-source:https://u:p@a.com/x?token=1',
      `view-source:https://u:${R}@a.com/x?token=${R}`,
    ],
    [
      'file: keeps only the last path segment',
      'file:///Users/bob/secret-project/doc.html',
      'file:///…/doc.html',
    ],
    ['file: windows drive path', 'file:///C:/Users/bob/Desktop/doc.html', 'file:///…/doc.html'],
    [
      'file: the host (a UNC share) is dropped',
      'file://corp-server/share/x.pdf',
      'file:///…/x.pdf',
    ],
    ['file: a directory has no segment to keep', 'file:///Users/bob/dir/', 'file:///…/'],
    [
      'file: query and fragment survive, redacted like http',
      'file:///app/index.html?token=1&tab=2#/orders/42',
      `file:///…/index.html?token=${R}&tab=2#/orders/42`,
    ],
    [
      'file: matrix segment in the kept segment',
      'file:///a/b;jsessionid=1',
      `file:///…/b;jsessionid=${R}`,
    ],
    ['file: a host with no path keeps nothing', 'file://corp-server', 'file:///…/'],
    [
      'file: a host with only a query keeps nothing of the host',
      'file://corp-server?x=1',
      'file:///…/?x=1',
    ],
    ['file: no slashes at all', 'file:doc.html', 'file:///…/doc.html'],
    [
      'other schemes defer to the network sanitizer',
      'chrome-extension://abcd/page.html?token=x',
      `chrome-extension://abcd/page.html?token=${R}`,
    ],
    ['about:blank is unchanged', 'about:blank', 'about:blank'],
    [
      'a relative reference is sanitized, not rejected',
      '/orders/42?token=abc',
      `/orders/42?token=${R}`,
    ],
    [
      'nested URL in a query value (raw)',
      'https://x.com/login?next=https://y.com/?token=SECRET',
      `https://x.com/login?next=https://y.com/?token=${R}`,
    ],
    [
      'nested URL userinfo',
      'https://x.com/login?next=https://u:p@y.com/',
      `https://x.com/login?next=https://u:${R}@y.com/`,
    ],
    [
      'nested URL, percent-encoded',
      'https://x.com/login?next=https%3A%2F%2Fy.com%2F%3Ftoken%3DSECRET',
      `https://x.com/login?next=https%3A%2F%2Fy.com%2F%3Ftoken%3D%253Credacted%253E`,
    ],
    [
      'view-source nesting is bounded',
      'view-source:view-source:view-source:https://u:p@a.com/',
      `view-source:view-source:view-source:${R}`,
    ],
    [
      'nested URL after a `;` separator',
      'https://x.com/l?a=1;next=https://y.com/?token=S',
      `https://x.com/l?a=1;next=https://y.com/?token=${R}`,
    ],
    [
      'an untouched percent-encoded nested URL is byte-identical (not re-encoded)',
      'https://x.com/l?next=https%3a%2f%2fy.com/a%2fb?x=1',
      'https://x.com/l?next=https%3a%2f%2fy.com/a%2fb?x=1',
    ],
    [
      'nested protocol-relative URL',
      'https://x.com/l?next=//y.com/?token=SECRET',
      `https://x.com/l?next=//y.com/?token=${R}`,
    ],
    [
      'nested URL two levels deep',
      'https://x.com/l?a=https://y.com/?b=https://z.com/?token=S',
      `https://x.com/l?a=https://y.com/?b=https://z.com/?token=${R}`,
    ],
    [
      'nested URL with siblings keeps them',
      'https://x.com/l?a=1&next=https://y.com/?token=S&b=2',
      `https://x.com/l?a=1&next=https://y.com/?token=${R}&b=2`,
    ],
    [
      'a harmless nested URL is byte-identical',
      'https://x.com/l?next=https://y.com/orders?tab=1',
      'https://x.com/l?next=https://y.com/orders?tab=1',
    ],
    [
      'a non-URL value containing a slash is not read as a URL',
      'https://x.com/l?path=/a/b?token=S',
      'https://x.com/l?path=/a/b?token=S',
    ],
  ];

  it.each(table)('%s', (_rule, input, expected) => {
    expect(sanitizeLocationUrl(input)).toBe(expected);
  });

  it('stops at two nested levels (a third is a documented gap, bounded so the scan stays linear)', () => {
    const url = 'https://x.com/l?a=https://y.com/?b=https://z.com/?c=https://w.com/?token=S';
    expect(sanitizeLocationUrl(url)).toBe(url);
  });

  it('leaves the network sanitizer untouched', () => {
    expect(sanitizeUrl('data:text/plain;token=abc,hello')).toBe(`data:text/plain;token=${R}`);
    expect(sanitizeUrl('blob:https://u:p@a.com/x')).toBe('blob:https://u:p@a.com/x');
    expect(sanitizeUrl('file:///Users/bob/x')).toBe('file:///Users/bob/x');
    const nested = 'https://x.com/a?next=https://y.com/?token=SECRET';
    expect(sanitizeUrl(nested)).toBe(nested);
  });

  it('passes the shape options through (credit cards are an opt-in shape)', () => {
    const url = 'https://a.com/p/4111111111111111';
    expect(sanitizeLocationUrl(url)).toBe(url);
    expect(sanitizeLocationUrl(url, { creditCards: true })).not.toContain('4111111111111111');
  });
});

describe('sanitizeLocationUrl: never throws', () => {
  const hostile = [
    '',
    ':',
    '%',
    'https://',
    'file:',
    'blob:',
    'data:',
    'view-source:view-source:view-source:view-source:https://u:p@a.com/',
    'https://a.com/?next=%E0%A4%A',
    'https://a.com/?next=https%3A%2F%2F%E0%A4%A%3Ftoken%3Dx',
    `https://a.com/?x=${'\ud800'}`,
    `${'\ud800'}://a`,
  ];
  it.each(hostile)('survives %j', (input) => {
    expect(typeof sanitizeLocationUrl(input)).toBe('string');
  });

  it('answers the placeholder for a non-string rather than throwing', () => {
    expect(sanitizeLocationUrl(undefined as unknown as string)).toBe(R);
    expect(sanitizeLocationUrl(42 as unknown as string)).toBe(R);
  });

  it('fails CLOSED to the placeholder if the sanitizer itself throws (a hostile options getter)', () => {
    const options = {
      get creditCards(): boolean {
        throw new Error('hostile');
      },
    };
    expect(sanitizeLocationUrl('https://a.com/x', options)).toBe(R);
  });

  it('property: any input returns a string', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (input) => {
        expect(typeof sanitizeLocationUrl(input)).toBe('string');
      }),
      { numRuns: 500 },
    );
  });
});

describe('sanitizeLocationUrl: properties', () => {
  const secret = fc.stringMatching(/^SECRET[A-Za-z0-9]{10,20}$/);

  it('data:/javascript: never carry any of the input through', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('data', 'javascript', 'vbscript', 'DATA', 'JavaScript'),
        secret,
        (scheme, s) => {
          const out = sanitizeLocationUrl(`${scheme}:text/plain;${s},${s}`);
          expect(out).not.toContain(s);
          expect(out.endsWith(`:${R}`)).toBe(true);
        },
      ),
    );
  });

  it('blob: never keeps a userinfo password or a path', () => {
    fc.assert(
      fc.property(secret, secret, (password, id) => {
        const out = sanitizeLocationUrl(`blob:https://user:${password}@a.com/${id}`);
        expect(out).toBe('blob:https://a.com');
      }),
    );
  });

  it('file: never keeps a directory', () => {
    fc.assert(
      fc.property(secret, (dir) => {
        const out = sanitizeLocationUrl(`file:///Users/${dir}/work/doc.html`);
        expect(out).toBe('file:///…/doc.html');
      }),
    );
  });

  it('a secret under a sensitive key survives neither at the top level nor nested one or two levels', () => {
    fc.assert(
      fc.property(secret, fc.constantFrom('token', 'api_key', 'password'), (s, key) => {
        const top = `https://a.com/p?${key}=${s}`;
        const one = `https://a.com/p?next=https://b.com/?${key}=${s}`;
        const two = `https://a.com/p?a=https://b.com/?b=https://c.com/?${key}=${s}`;
        const encoded = `https://a.com/p?next=${encodeURIComponent(`https://b.com/?${key}=${s}`)}`;
        for (const url of [top, one, two, encoded]) {
          expect(sanitizeLocationUrl(url)).not.toContain(s);
        }
      }),
    );
  });
});

describe('sanitizeLocationUrl: bounded work', () => {
  it(
    'is linear on a hostile run of nested-looking pairs',
    () => {
      const build = (size: number): string =>
        `https://a.com/?${'x=https://a.com/?'.repeat(Math.ceil(size / 17))}`;
      expect(typeof sanitizeLocationUrl(build(200_000))).toBe('string');
      expectLinearIn(
        build,
        (input) => {
          sanitizeLocationUrl(input);
        },
        400_000,
      );
    },
    LINEARITY_TEST_TIMEOUT_MS,
  );

  it(
    'is linear on a hostile percent-encoded nested value',
    () => {
      const build = (size: number): string =>
        `https://a.com/?n=https%3A%2F%2F${'%3F'.repeat(Math.ceil(size / 3))}`;
      expect(typeof sanitizeLocationUrl(build(100_000))).toBe('string');
      expectLinearIn(
        build,
        (input) => {
          sanitizeLocationUrl(input);
        },
        200_000,
      );
    },
    LINEARITY_TEST_TIMEOUT_MS,
  );

  it(
    'is linear on a long file: path and on repeated `&` separators',
    () => {
      const file = (size: number): string => `file:///${'a/'.repeat(Math.ceil(size / 2))}x`;
      const amp = (size: number): string => `https://a.com/?${'&'.repeat(size)}`;
      for (const build of [file, amp]) {
        expectLinearIn(
          build,
          (input) => {
            sanitizeLocationUrl(input);
          },
          400_000,
        );
      }
    },
    LINEARITY_TEST_TIMEOUT_MS,
  );
});
