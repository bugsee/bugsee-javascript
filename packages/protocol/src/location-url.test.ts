import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { expectLinearIn, LINEARITY_TEST_TIMEOUT_MS } from './linear-time.test-helper';
import { sanitizeLocationName, sanitizeLocationUrl } from './location-url';
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
      'https://a.com/cb#access_token=abc&id=1',
      `https://a.com/cb#access_token=${R}&id=1`,
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
      'a relative return path with a query is sanitized too',
      'https://x.com/l?next=/path?token=S',
      `https://x.com/l?next=/path?token=${R}`,
    ],
    [
      'a percent-encoded relative return path',
      'https://x.com/l?returnTo=%2Freset%3Ftoken%3DSECRET8',
      'https://x.com/l?returnTo=%2Freset%3Ftoken%3D%253Credacted%253E',
    ],
    [
      'partial encoding: only the colon encoded',
      'https://x.com/l?u=https%3A//b/%3Ftoken%3DS',
      'https://x.com/l?u=https%3A%2F%2Fb%2F%3Ftoken%3D%253Credacted%253E',
    ],
    [
      'partial encoding: only the slashes encoded',
      'https://x.com/l?u=https:%2F%2Fb%2F%3Ftoken%3DS',
      'https://x.com/l?u=https%3A%2F%2Fb%2F%3Ftoken%3D%253Credacted%253E',
    ],
    [
      'double-encoded nested URL',
      'https://x.com/l?u=https%253A%252F%252Fb%252F%253Ftoken%253DS',
      'https://x.com/l?u=https%3A%2F%2Fb%2F%3Ftoken%3D%253Credacted%253E',
    ],
    [
      'hash-router query after a real query',
      'https://a.com/?x=1#/cb?next=https://b/?token=S',
      `https://a.com/?x=1#/cb?next=https://b/?token=${R}`,
    ],
    [
      'hash-router query without a real query',
      'https://a.com/#/cb?next=https://b/?token=S',
      `https://a.com/#/cb?next=https://b/?token=${R}`,
    ],
    [
      'extended keys: code and state',
      'https://a.com/cb?code=C1&state=S1&tab=1',
      `https://a.com/cb?code=${R}&state=${R}&tab=1`,
    ],
    [
      'extended keys: session ids, signatures, tickets',
      'https://a.com/?session=S&sessionid=S&session_id=S&sid=S&sig=S&signature=S&ticket=S&otp=S&code_verifier=S',
      `https://a.com/?session=${R}&sessionid=${R}&session_id=${R}&sid=${R}&sig=${R}&signature=${R}&ticket=${R}&otp=${R}&code_verifier=${R}`,
    ],
    [
      'extended keys are matched exactly, not as substrings',
      'https://a.com/?encoding=utf8&barcode=1&zipcode=9&country_code=US&states=2',
      'https://a.com/?encoding=utf8&barcode=1&zipcode=9&country_code=US&states=2',
    ],
    [
      '`key` and `t` are NOT redacted (too common; documented)',
      'https://a.com/?key=K&t=T',
      'https://a.com/?key=K&t=T',
    ],
    [
      'extended keys in the fragment (implicit flow)',
      'https://a.com/#code=C&state=S&id=1',
      `https://a.com/#code=${R}&state=${R}&id=1`,
    ],
    [
      'extended keys in a hash-router query',
      'https://a.com/#/nav?code=C6&tab=1',
      `https://a.com/#/nav?code=${R}&tab=1`,
    ],
    [
      'extended keys in a hash-router query after a real query',
      'https://a.com/?x=1#/nav?code=C6',
      `https://a.com/?x=1#/nav?code=${R}`,
    ],
    [
      'a second # in the fragment: access_token',
      'https://a.com/#/cb?x=1#access_token=S',
      `https://a.com/#/cb?x=1#access_token=${R}`,
    ],
    [
      'a second # in the fragment: code',
      'https://a.com/#/cb?x=1#code=S',
      `https://a.com/#/cb?x=1#code=${R}`,
    ],
    [
      'a secret with a literal # is redacted whole',
      'https://a.com/p#password=p#ss&x=1',
      `https://a.com/p#password=${R}&x=1`,
    ],
    [
      'a secret with a literal # at the end',
      'https://a.com/p#client_secret=s3#cr3t',
      `https://a.com/p#client_secret=${R}`,
    ],
    [
      'a code with a literal # (location key)',
      'https://a.com/p#code=a#b&state=1',
      `https://a.com/p#code=${R}&state=${R}`,
    ],
    [
      'a file: secret with a literal #',
      'file:///app/index.html#token=abc#def',
      `file:///…/index.html#token=${R}`,
    ],
    [
      'a leading + (URLSearchParams space) before an encoded nested URL',
      'https://a.com/?next=+https%3A%2F%2Fu%3Apw%40b%2F',
      `https://a.com/?next=+https%3A%2F%2Fu%3A%253Credacted%253E%40b%2F`,
    ],
    [
      'an encoded %2B before a nested URL stays %2B',
      'https://a.com/?next=%2Bhttps%3A%2F%2Fu%3Apw%40b%2F',
      `https://a.com/?next=%2Bhttps%3A%2F%2Fu%3A%253Credacted%253E%40b%2F`,
    ],
    [
      'a lower-case %2b stays as written',
      'https://a.com/?next=%2bhttps%3A%2F%2Fu%3Apw%40b%2F',
      `https://a.com/?next=%2bhttps%3A%2F%2Fu%3A%253Credacted%253E%40b%2F`,
    ],
    [
      'a mixed raw prefix is reused whole',
      'https://a.com/?next=%20+%2Bhttps%3A%2F%2Fu%3Apw%40b%2F',
      `https://a.com/?next=%20+%2Bhttps%3A%2F%2Fu%3A%253Credacted%253E%40b%2F`,
    ],
    [
      'a double-encoded leading space keeps its %2520',
      'https://a.com/?next=%2520https%253A%252F%252Fu%253Apw%2540b%252F',
      `https://a.com/?next=%2520https%3A%2F%2Fu%3A%253Credacted%253E%40b%2F`,
    ],
    [
      'a leading plus after double encoding keeps its %252B',
      'https://a.com/?next=%252Bhttps%253A%252F%252Fu%253Apw%2540b%252F',
      `https://a.com/?next=%252Bhttps%3A%2F%2Fu%3A%253Credacted%253E%40b%2F`,
    ],
    [
      'a literal leading space (not encoded) is kept as is',
      'https://a.com/?next= https%3A%2F%2Fu%3Apw%40b%2F',
      `https://a.com/?next= https%3A%2F%2Fu%3A%253Credacted%253E%40b%2F`,
    ],
    [
      'a leading + before a plain nested URL',
      'https://a.com/?next=+https://u:pw@b/',
      `https://a.com/?next=+https://u:${R}@b/`,
    ],
    [
      'leading blanks of both kinds are kept',
      'https://a.com/?next=+%20https%3A%2F%2Fu%3Apw%40b%2F',
      `https://a.com/?next=+%20https%3A%2F%2Fu%3A%253Credacted%253E%40b%2F`,
    ],
    [
      'a leading + before harmless text is untouched',
      'https://a.com/?q=+hello+world',
      'https://a.com/?q=+hello+world',
    ],
    [
      'a leading-space encoded nested URL with a path secret',
      'https://a.com/?next=%20https%3A%2F%2Fy.com%2Fp%3Bjsessionid%3DS',
      `https://a.com/?next=%20https%3A%2F%2Fy.com%2Fp%3Bjsessionid%3D%253Credacted%253E`,
    ],
    [
      'a third # in the fragment',
      'https://a.com/#a=1#b=2#token=S',
      `https://a.com/#a=1#b=2#token=${R}`,
    ],
    [
      'a second # in a file: fragment',
      'file:///app/index.html#/cb?x=1#code=S',
      `file:///…/index.html#/cb?x=1#code=${R}`,
    ],
    [
      'a nested value that is only a fragment',
      'https://a.com/?next=%23access_token%3DS',
      `https://a.com/?next=%23access_token%3D%253Credacted%253E`,
    ],
    [
      'a nested relative value with a fragment',
      'https://a.com/?next=cb%23code%3DS',
      `https://a.com/?next=cb%23code%3D%253Credacted%253E`,
    ],
    [
      'extended keys in a matrix segment',
      'https://a.com/app;session=S/x',
      `https://a.com/app;session=${R}/x`,
    ],
    [
      'extended keys on a nested URL',
      'https://a.com/l?next=https://b.com/?code=C',
      `https://a.com/l?next=https://b.com/?code=${R}`,
    ],
    [
      'file: hash-router query',
      'file:///app/index.html#/reset?token=T&code=C',
      `file:///…/index.html#/reset?token=${R}&code=${R}`,
    ],
    [
      'file: fragment pairs',
      'file:///app/index.html#code=C&tab=1',
      `file:///…/index.html#code=${R}&tab=1`,
    ],
    [
      'file: extended key in the query',
      'file:///app/index.html?code=C',
      `file:///…/index.html?code=${R}`,
    ],
    ['one slash after the scheme', 'https:/u:p@a.com/x', `https://u:${R}@a.com/x`],
    ['no slash after the scheme', 'https:u:p@a.com/x', `https://u:${R}@a.com/x`],
    ['backslashes for slashes', 'https:\\\\u:p@a.com\\x', `https://u:${R}@a.com/x`],
    ['wss: one slash', 'wss:/u:p@a.com/x', `wss://u:${R}@a.com/x`],
    ['ftp: one slash', 'ftp:/u:p@a.com/x', `ftp://u:${R}@a.com/x`],
    ['ws: backslashes', 'ws:\\\\u:p@a.com\\x', `ws://u:${R}@a.com/x`],
    [
      'a quoted or padded key still matches the extended list',
      'https://a.com/?%22code%22=S&%20state%20=S',
      `https://a.com/?%22code%22=${R}&%20state%20=${R}`,
    ],
    [
      'file: matrix extended key in the kept segment',
      'file:///a/b;code=C',
      `file:///…/b;code=${R}`,
    ],
    ['three slashes after the scheme', 'https:///a.com/x?token=1', `https://a.com/x?token=${R}`],
    ['file: drive path without slashes', 'file:C:\\Users\\bob\\a.html', 'file:///…/a.html'],
    ['file: UNC path with backslashes', 'file:\\\\server\\share\\bob\\x.html', 'file:///…/x.html'],
    ['file: three slashes with backslashes', 'file:///C:\\Users\\bob\\a.html', 'file:///…/a.html'],
    ['blob: the last @ wins in the authority', 'blob:https://a@b:p@c.com/x', 'blob:https://c.com'],
    ['blob: a backslash ends the origin', 'blob:https://u:p@a.com\\x', 'blob:https://a.com'],
    [
      'file: nested URL in the query',
      'file:///app/index.html?next=https://b.com/?token=SECRET',
      `file:///…/index.html?next=https://b.com/?token=${R}`,
    ],
    [
      'file: nested encoded URL in a hash route',
      'file:///app/index.html#/r?next=https%3A%2F%2Fb.com%2F%3Fcode%3DSECRET',
      `file:///…/index.html#/r?next=https%3A%2F%2Fb.com%2F%3Fcode%3D%253Credacted%253E`,
    ],
    [
      'malformed escape (a stray %) in an encoded nested URL',
      'https://a.com/?next=https%3A%2F%2Fb.com%2F%3Fq%3D100%%26token%3DSECRET',
      `https://a.com/?next=https%3A%2F%2Fb.com%2F%3Fq%3D100%25%26token%3D%253Credacted%253E`,
    ],
    [
      'invalid UTF-8 escape in an encoded nested URL',
      'https://a.com/?next=https%3A%2F%2Fb.com%2F%3Fq%3D%E0%A4%26token%3DSECRET',
      `https://a.com/?next=https%3A%2F%2Fb.com%2F%3Fq%3D%25E0%25A4%26token%3D%253Credacted%253E`,
    ],
    [
      'nested URL in a plain fragment (encoded)',
      'https://a.com/x#next=https%3A%2F%2Fb.com%2F%3Ftoken%3DSECRET',
      `https://a.com/x#next=https%3A%2F%2Fb.com%2F%3Ftoken%3D%253Credacted%253E`,
    ],
    [
      'nested URL with its own fragment in a fragment',
      'https://a.com/x#a=1&next=https://b.com/cb#access_token=SECRET',
      `https://a.com/x#a=1&next=https://b.com/cb#access_token=${R}`,
    ],
    [
      'relative return path in a fragment',
      'https://a.com/x#next=%2Fcb%3Fcode%3DSECRET',
      `https://a.com/x#next=%2Fcb%3Fcode%3D%253Credacted%253E`,
    ],
    [
      'array-style key',
      'https://a.com/?code[]=S&state%5B0%5D=S',
      `https://a.com/?code[]=${R}&state%5B0%5D=${R}`,
    ],
    ['percent-encoded array key', 'https://a.com/?code%5B%5D=S', `https://a.com/?code%5B%5D=${R}`],
    ['form-plus key', 'https://a.com/?+code=S', `https://a.com/?+code=${R}`],
    [
      'keys the shared list already catches stay redacted',
      'https://a.com/?sessionid=S&signature=S&otp=S&footprint=1',
      `https://a.com/?sessionid=${R}&signature=${R}&otp=${R}&footprint=${R}`,
    ],
    [
      'file: the shape pass runs on the kept segment',
      'file:///a/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcDEF123_-signaturepart',
      'file:///…/<redacted>',
    ],
  ];

  it.each(table)('%s', (_rule, input, expected) => {
    expect(sanitizeLocationUrl(input)).toBe(expected);
  });

  it('stops at two nested levels (a third is a documented gap, bounded so the scan stays linear)', () => {
    const url = 'https://x.com/l?a=https://y.com/?b=https://z.com/?c=https://w.com/?token=S';
    expect(sanitizeLocationUrl(url)).toBe(url);
  });

  describe('input cap', () => {
    const MARK = '%3Ctruncated%3E';
    it('a cut inside an escape drops the partial escape and cannot leak the value beside it', () => {
      const prefix = 'https://a.com/?next=https%3A%2F%2Fb.com%2F%3Ftoken%3D';
      const body = 'S'.repeat(8192 - prefix.length - 2);
      const out = sanitizeLocationUrl(`${prefix}${body}%2F%2FSECRETTAIL`);
      expect(out.endsWith(MARK)).toBe(true);
      expect(out).not.toMatch(/%[0-9A-Fa-f]%3C/);
      expect(out).not.toContain('SECRETTAIL');
      expect(out).not.toContain(body);
    });
    it('a cut inside an escape in plain text drops the partial escape', () => {
      const out = sanitizeLocationUrl(`https://a.com/${'a'.repeat(8192 - 14 - 2)}%2Fzzz`);
      expect(out.endsWith(`a${MARK}`)).toBe(true);
    });
    it('a cut right after a lone % drops it too', () => {
      const out = sanitizeLocationUrl(`https://a.com/${'a'.repeat(8192 - 14 - 1)}%2Fzzz`);
      expect(out.endsWith(`a${MARK}`)).toBe(true);
    });
    it('clips FIRST: tab padding that normalisation would strip still counts toward the 8192', () => {
      const out = sanitizeLocationUrl(`https://a.com/${'\t'.repeat(9000)}${'a'.repeat(100)}`);
      expect(out).toBe(`https://a.com/${MARK}`);
    });
    it('clips BEFORE normalising: a huge input costs the same as a clipped one', () => {
      const out = sanitizeLocationUrl(`https:${'/'.repeat(1_000_000)}a.com/x`);
      expect(out.length).toBeLessThanOrEqual(8192 + MARK.length + 8);
    });
    it('clips an over-long address to 8192 characters plus a marker', () => {
      const out = sanitizeLocationUrl(`https://a.com/${'a'.repeat(20_000)}`);
      expect(out.length).toBe(8192 + MARK.length);
      expect(out.startsWith('https://a.com/aaa')).toBe(true);
      expect(out.endsWith(MARK)).toBe(true);
    });
    it('exactly 8192 characters is not clipped and has no marker', () => {
      const url = `https://a.com/${'a'.repeat(8192 - 14)}`;
      expect(url.length).toBe(8192);
      expect(sanitizeLocationUrl(url)).toBe(url);
    });
    it('a secret past the cap never survives', () => {
      const out = sanitizeLocationUrl(`https://a.com/?${'x'.repeat(9000)}&token=SECRETXYZ`);
      expect(out).not.toContain('SECRETXYZ');
    });
    it('a huge data: URL is just the placeholder, with no marker', () => {
      expect(sanitizeLocationUrl(`data:text/plain,${'a'.repeat(100_000)}`)).toBe(`data:${R}`);
    });
    it('a clipped file: address is still a file: address', () => {
      const out = sanitizeLocationUrl(`file:///${'d/'.repeat(10_000)}x.html`);
      expect(out.startsWith('file:///…/')).toBe(true);
      expect(out.endsWith(MARK)).toBe(true);
    });
  });

  describe('nested values: tolerant reading', () => {
    it('a nested file: address two levels down is not scanned (the documented depth)', () => {
      const url = 'https://x.com/l?a=https://y.com/?b=file:///x/y.html?next=https://z.com/?token=S';
      expect(sanitizeLocationUrl(url)).toBe(
        'https://x.com/l?a=https://y.com/?b=file:///…/y.html?next=https://z.com/?token=S',
      ); // the file: path is shortened, the third-level nested query is not scanned
    });
    it('an invalid UTF-8 escape beside a valid ASCII one still decodes the ASCII (a hidden key letter)', () => {
      expect(
        sanitizeLocationUrl('https://a.com/?next=https%3A%2F%2Fb.com%2F%3F%E0%74oken%3DSECRET'),
      ).toBe(`https://a.com/?next=https%3A%2F%2Fb.com%2F%3F%25E0token%3D%253Credacted%253E`);
    });
    it('a multi-byte UTF-8 escape is decoded as ONE character', () => {
      expect(
        sanitizeLocationUrl('https://a.com/?next=https%3A%2F%2Fb.com%2F%3Fq%3D%C3%A9%26token%3DS'),
      ).toBe(
        'https://a.com/?next=https%3A%2F%2Fb.com%2F%3Fq%3D%C3%A9%26token%3D%253Credacted%253E',
      );
    });
    it('a lone surrogate in a nested value never throws and the value stays ENCODED (the shape survives)', () => {
      expect(
        sanitizeLocationUrl('https://a.com/?next=https%3A%2F%2Fb.com%2F%3Ftoken%3DS%26x%3D\ud800'),
      ).toBe(
        'https://a.com/?next=https%3A%2F%2Fb.com%2F%3Ftoken%3D%253Credacted%253E%26x%3D%EF%BF%BD',
      );
    });
    it('a well-formed surrogate pair (an emoji) is encoded as one character', () => {
      expect(
        sanitizeLocationUrl(
          'https://a.com/?next=https%3A%2F%2Fb.com%2F%3Ftoken%3DS%26x%3D%F0%9F%98%80',
        ),
      ).toBe(
        'https://a.com/?next=https%3A%2F%2Fb.com%2F%3Ftoken%3D%253Credacted%253E%26x%3D%F0%9F%98%80',
      );
    });
    it('runs of lone surrogates are each replaced', () => {
      const out = (run: string) =>
        sanitizeLocationUrl(`https://a.com/?next=https%3A%2F%2Fb.com%2F%3Ftoken%3DS%26x%3D${run}`);
      expect(out('\ud800\ud800')).toContain('%26x%3D%EF%BF%BD%EF%BF%BD');
      expect(out('\udc00\udc00')).toContain('%26x%3D%EF%BF%BD%EF%BF%BD');
      expect(out('\udc00\ud800')).toContain('%26x%3D%EF%BF%BD%EF%BF%BD');
    });
    it('a lone LOW surrogate too', () => {
      expect(
        sanitizeLocationUrl('https://a.com/?next=https%3A%2F%2Fb.com%2F%3Ftoken%3DS%26x%3D\udc00y'),
      ).toContain('%26x%3D%EF%BF%BDy');
    });
    it('a malformed escape falls back to the raw value', () => {
      expect(sanitizeLocationUrl('https://a.com/l?u=%E0%A4%A/x?token=S')).toBe(
        `https://a.com/l?u=%E0%A4%A/x?token=${R}`,
      );
      expect(sanitizeLocationUrl('https://a.com/l?u=%E0%A4%A')).toBe('https://a.com/l?u=%E0%A4%A');
    });
    it('plain values that are not addresses are untouched', () => {
      for (const url of [
        'https://a.com/l?x=10:30&y=hello%20world&z=100%25&w=a+b',
        'https://a.com/l?x=a',
      ]) {
        expect(sanitizeLocationUrl(url)).toBe(url);
      }
    });
  });

  describe('sanitizeLocationName (transaction names)', () => {
    const cases: Array<[string | undefined, string, string]> = [
      ['https://a.com/orders/42?token=S#x', '/orders/42', '/orders/42'],
      ['https://a.com', '/', '/'],
      ['https://a.com/app;jsessionid=ABC/x', '/ignored', `/app;jsessionid=${R}/x`],
      [
        'file:///Users/bob/secret/app/index.html#/orders',
        '/Users/bob/secret/app/index.html',
        '/…/index.html',
      ],
      ['blob:https://u:p@a.com/uuid', '/uuid', 'blob:https://a.com'],
      ['data:text/plain,secret', '/x', `data:${R}`],
      [undefined, '/cb?token=S&tab=1', `/cb`],
      [undefined, '/app;jsessionid=ABC/x', `/app;jsessionid=${R}/x`],
      [undefined, '/a#frag', '/a'],
      ['about:blank?code=C', '/x', 'about:blank'],
      ['view-source:https://a.com/p/q?x#y', '/x', 'view-source:https://a.com/p/q'],
    ];
    it.each(cases)('%s + %s -> %s', (href, pathname, expected) => {
      expect(sanitizeLocationName(href, pathname)).toBe(expected);
    });
    it('a query or fragment with a line separator is cut as well', () => {
      expect(sanitizeLocationName(undefined, '/a?x=1\u20282#f\u2029g')).toBe('/a');
      expect(sanitizeLocationName('https://a.com/p?x=1\u20282#f', '/ignored')).toBe('/p');
    });
  });

  it('the network sanitizer recognises the authority of a blob:/filesystem: URL (its userinfo password is redacted)', () => {
    expect(sanitizeUrl('blob:https://u:p@a.com/x')).toBe(`blob:https://u:${R}@a.com/x`);
    expect(sanitizeUrl('filesystem:https://u:p@a.com/temporary/f')).toBe(
      `filesystem:https://u:${R}@a.com/temporary/f`,
    );
    expect(sanitizeUrl('BLOB:https://tok@a.com/x?token=S')).toBe(
      `BLOB:https://${R}@a.com/x?token=${R}`,
    );
    expect(sanitizeUrl('blob:https://a.com/uuid')).toBe('blob:https://a.com/uuid');
  });

  it('otherwise leaves the network sanitizer untouched', () => {
    expect(sanitizeUrl('data:text/plain;token=abc,hello')).toBe(`data:text/plain;token=${R}`);
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
      fc.property(
        secret,
        fc.constantFrom(
          'token',
          'api_key',
          'password',
          'code',
          'state',
          'session',
          'sid',
          'sig',
          'ticket',
        ),
        (s, key) => {
          const top = `https://a.com/p?${key}=${s}`;
          const one = `https://a.com/p?next=https://b.com/?${key}=${s}`;
          const two = `https://a.com/p?a=https://b.com/?b=https://c.com/?${key}=${s}`;
          const encoded = `https://a.com/p?next=${encodeURIComponent(`https://b.com/?${key}=${s}`)}`;
          const relative = `https://a.com/p?returnTo=${encodeURIComponent(`/r?${key}=${s}`)}`;
          const doubly = `https://a.com/p?u=${encodeURIComponent(encodeURIComponent(`https://b.com/?${key}=${s}`))}`;
          const hashRouter = `https://a.com/p?x=1#/r?next=https://b.com/?${key}=${s}`;
          const file = `file:///app/index.html#/r?${key}=${s}`;
          const fileNested = `file:///app/index.html?next=${encodeURIComponent(`https://b.com/?${key}=${s}`)}`;
          const fragmentNested = `https://a.com/p#next=${encodeURIComponent(`https://b.com/?${key}=${s}`)}`;
          const stray = `https://a.com/p?next=https%3A%2F%2Fb.com%2F%3Fq%3D100%%26${key}%3D${s}`;
          for (const url of [
            top,
            one,
            two,
            encoded,
            relative,
            doubly,
            hashRouter,
            file,
            fileNested,
            fragmentNested,
            stray,
          ]) {
            expect(sanitizeLocationUrl(url)).not.toContain(s);
          }
        },
      ),
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
