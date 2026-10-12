import { describe, expect, it } from 'vitest';
import { sanitizeDetectorUrl, templatePathSegment } from './detector-url-sanitizer';

describe('sanitizeDetectorUrl (Android DetectorUrlSanitizer parity)', () => {
  it('returns "" for an empty input', () => {
    expect(sanitizeDetectorUrl('')).toBe('');
  });

  it('strips the query string and the fragment', () => {
    expect(sanitizeDetectorUrl('https://a.test/x?token=S#frag')).toBe('https://a.test/x');
    expect(sanitizeDetectorUrl('https://a.test/x#frag?notquery')).toBe('https://a.test/x');
  });

  it('strips userinfo, including a password that contains an @', () => {
    expect(sanitizeDetectorUrl('https://user:p@ss@a.test/x')).toBe('https://a.test/x');
    expect(sanitizeDetectorUrl('https://user:hunter2@a.test/x')).toBe('https://a.test/x');
  });

  it('templates ids, uuids, hex strings and tokens in the path so ids do not split issues', () => {
    expect(sanitizeDetectorUrl('https://a.test/users/42/orders/99')).toBe(
      'https://a.test/users/{id}/orders/{id}',
    );
    expect(sanitizeDetectorUrl('https://a.test/o/123e4567-e89b-12d3-a456-426614174000/x')).toBe(
      'https://a.test/o/{uuid}/x',
    );
    expect(sanitizeDetectorUrl('https://a.test/blob/0123456789abcdef0123/x')).toBe(
      'https://a.test/blob/{hex}/x',
    );
    expect(
      sanitizeDetectorUrl(
        'https://a.test/confirm/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijk',
      ),
    ).toBe('https://a.test/confirm/{token}');
  });

  it('templates e-mail addresses (plain and percent-encoded) so they never reach a summary', () => {
    expect(sanitizeDetectorUrl('https://a.test/users/jane.doe@example.com/profile')).toBe(
      'https://a.test/users/{email}/profile',
    );
    expect(sanitizeDetectorUrl('https://a.test/users/jane%40example.com')).toBe(
      'https://a.test/users/{email}',
    );
  });

  it('keeps ordinary segments and the scheme/authority verbatim', () => {
    expect(sanitizeDetectorUrl('https://api.a.test:8443/v1/orders/list')).toBe(
      'https://api.a.test:8443/v1/orders/list',
    );
  });

  it('leaves an authority-only URL alone', () => {
    expect(sanitizeDetectorUrl('https://a.test')).toBe('https://a.test');
  });

  it('templates the path of a scheme-less target (the whole string is the path)', () => {
    expect(sanitizeDetectorUrl('/users/42')).toBe('/users/{id}');
  });

  it('preserves empty segments (double slashes / trailing slash)', () => {
    expect(sanitizeDetectorUrl('https://a.test//users/7/')).toBe('https://a.test//users/{id}/');
  });
});

describe('templatePathSegment', () => {
  it.each([
    ['', ''],
    ['orders', 'orders'],
    ['42', '{id}'],
    ['a@b.co', '{email}'],
    ['@b.co', '@b.co'],
    ['a@', 'a@'],
    ['a@b', 'a@b'],
    ['a@.co', 'a@.co'],
    ['a@b.', 'a@b.'],
    ['123e4567-e89b-12d3-a456-426614174000', '{uuid}'],
    ['123e4567-e89b-12d3-a456-42661417400g', '{token}'], // not a uuid, but still token-shaped
    ['123e4567_e89b-12d3-a456-426614174000', '{token}'],
    ['0123456789abcdef', '{hex}'],
    ['0123456789abcde', '0123456789abcde'],
    ['abcdefabcdefabcdefabcdef', '{hex}'],
    ['abcdefghijklmnopqrstuvwx1', '{token}'],
    ['the-quick-brown-fox-jumps', 'the-quick-brown-fox-jumps'],
    ['abcdefghijklmnopqrstuv1', 'abcdefghijklmnopqrstuv1'],
    ['abcdefghijklmnopqrstuvw1!', 'abcdefghijklmnopqrstuvw1!'],
  ])('%j -> %j', (segment, expected) => {
    expect(templatePathSegment(segment)).toBe(expected);
  });

  it('survives a malformed percent escape', () => {
    expect(templatePathSegment('100%')).toBe('100%');
  });
});

// R2P-8. Short ids and PII the first rule set missed, and the over-templating it did.
describe('templatePathSegment: short ids, PII-shaped values and dates (R2P-8)', () => {
  it.each([
    // nanoid(21) and a Firebase push id (20): mixed case + digits
    ['V1StGXR8_Z5jdHi6B-myT', '{id}'],
    ['-NxK3d9fQwErTyUiOp1A', '{id}'],
    // a prefixed numeric id keeps its (non-PII) prefix
    ['ord_12345', 'ord_{id}'],
    ['user-9981', 'user-{id}'],
    // a numeric / uuid / hex stem with a file extension keeps the extension
    ['42.json', '{id}.json'],
    ['123e4567-e89b-12d3-a456-426614174000.json', '{uuid}.json'],
    ['0123456789ABCDEF0123.png', '{hex}.png'],
    // phone numbers
    ['+15551234567', '{phone}'],
    ['555-123-4567', '{phone}'],
    ['(555)%20123-4567', '{phone}'],
    // IPs
    ['192.168.0.1', '{ip}'],
    ['2001:db8::8a2e:370:7334', '{ip}'],
    ['::1', '{ip}'],
    // dates and timestamps
    ['2024-01-15', '{date}'],
    ['2024-01-15T10:20:30Z', '{date}'],
    ['2024-01-15T10:20:30.123Z', '{date}'],
    // upper-case hex is hex too (mutation survivor m13)
    ['0123456789ABCDEF', '{hex}'],
    ['ABCDEFABCDEFABCDEFABCDEF', '{hex}'],
    ['AbCdEfAbCdEfAbCdEf', '{hex}'],
  ])('%j -> %j', (segment, expected) => {
    expect(templatePathSegment(segment)).toBe(expected);
  });

  it.each([
    // long slugs that merely contain a digit are NOT tokens
    'the-quick-brown-fox-jumps-over-2-lazy-dogs',
    'release-notes-for-version-2-1-final',
    'Quick-Start-Guide-12',
    'my_long_snake_case_name_v2_final',
    // ordinary segments, versions and short words
    'v1',
    'api-v2',
    'v1.2',
    '1.2.3',
    'users',
    'sha',
    '3-2',
    'part-2',
    'a.b',
    'index.html',
    'ABCDEFGHIJKLMNOPQRST', // 20 upper-case letters: no digit, not an id
    'abcdefghijklmnopqrstu', // 21 lower-case letters
  ])('leaves %j alone', (segment) => {
    expect(templatePathSegment(segment)).toBe(segment);
  });

  it.each([
    // UUIDs in either case
    ['123E4567-E89B-12D3-A456-426614174000', '{uuid}'],
    // phone-number length bounds: 7..15 numbers, a `+` only first
    ['555-1234', '{phone}'],
    ['555-123', '555-123'],
    ['+123456789012345', '{phone}'],
    ['+1234567890123456', '+1234567890123456'],
    ['555+1234567', '555+1234567'],
    ['++15551234567', '++15551234567'],
    // IPv6 spelled out in full (no `::`); a clock time is not an address
    ['2001:0db8:85a3:0000:0000:8a2e:0370:7334', '{ip}'],
    ['10:20:30', '10:20:30'],
    ['1000.1.1.1', '{phone}'], // not an IPv4 (octet too long), still a number run
    // a date with a time, percent-encoded as it arrives in a path
    ['2024-01-15%2010:20:30', '{date}'],
    // prefixed ids need 3+ numbers
    ['ord_12', 'ord_12'],
    ['ord_123', 'ord_{id}'],
    // slug detection: 3 plain words is a slug, 2 is not
    ['abcdefghijklmnopqrstuvwx-yz-ab1', 'abcdefghijklmnopqrstuvwx-yz-ab1'],
    ['abcdefghijklmnopqrstuvwx-yz1', '{token}'],
    // fixed-length ids need a number AND both cases, and exactly 20 or 21 characters
    ['abcdefghijklmnopqrst1', 'abcdefghijklmnopqrst1'],
    ['ABCDEFGHIJKLMNOPQRST1', 'ABCDEFGHIJKLMNOPQRST1'],
    ['AbCdEfGhIjKlMnOpQrStU', 'AbCdEfGhIjKlMnOpQrStU'],
    ['AbCdEfGhIjKlMnOpQrSt1u', '{token}'], // 22 chars: past SHORT_ID, below the 24-char token floor (R3V-4)
    ['AbCdEfGhIjKlMnOpQr1', '{token}'], // 19 chars, mixed case + a digit (R3V-4)
    ['AbCdEfGhIjKlMnOpQrS1', '{id}'],
    ['AbCdEfGhIjKlMnOpQrSt1', '{id}'],
  ])('boundary: %j -> %j', (segment, expected) => {
    expect(templatePathSegment(segment)).toBe(expected);
  });

  it('templates the same ids inside a whole URL', () => {
    expect(
      sanitizeDetectorUrl(
        'https://a.test/orders/ord_12345/items/42.json/by/V1StGXR8_Z5jdHi6B-myT/on/2024-01-15/call/+15551234567/from/10.0.0.7',
      ),
    ).toBe(
      'https://a.test/orders/ord_{id}/items/{id}.json/by/{id}/on/{date}/call/{phone}/from/{ip}',
    );
  });
});

describe('no ReDoS: adversarial 1,000,000-character inputs finish in bounded time (R2P-8)', () => {
  const BIG = 1_000_000;
  const shapes: Array<[string, string]> = [
    ['digits then a letter', `${'1'.repeat(BIG)}x`],
    ['hex-ish then a non-hex', `${'a'.repeat(BIG)}!`],
    ['token chars then an invalid', `${'a1'.repeat(BIG / 2)}!`],
    ['dashes', '-'.repeat(BIG)],
    ['phone punctuation', `+${'1-'.repeat(BIG / 2)}x`],
    ['colons', ':'.repeat(BIG)],
    ['dots', '.'.repeat(BIG)],
    ['an @ run', '@'.repeat(BIG)],
    ['almost an email', `${'a'.repeat(BIG)}@b`],
    ['percent run', '%'.repeat(BIG)],
    ['date-looking', `2024-01-15T${'1:'.repeat(BIG / 2)}`],
    ['underscore words', `${'ab_'.repeat(BIG / 3)}1`],
  ];

  it.each(shapes)('segment: %s', (_name, input) => {
    const started = Date.now();
    templatePathSegment(input);
    // A generous bound: linear work is ~tens of ms; a catastrophic regex would be minutes.
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('a whole URL with a huge authority, huge userinfo and a huge path', () => {
    const started = Date.now();
    sanitizeDetectorUrl(`https://${'a'.repeat(BIG)}/x`);
    sanitizeDetectorUrl(`https://${'a:'.repeat(BIG / 2)}@h.test/${'/'.repeat(1000)}`);
    sanitizeDetectorUrl(`${'a'.repeat(BIG)}://x`);
    sanitizeDetectorUrl(`/${'1/'.repeat(BIG / 2)}`);
    expect(Date.now() - started).toBeLessThan(6000);
  });

  it('a segment past any plausible identifier length is never echoed into a summary', () => {
    expect(templatePathSegment('a'.repeat(5000))).toBe('{token}');
    expect(templatePathSegment('g'.repeat(256))).toBe('g'.repeat(256)); // the cap is exclusive
    expect(templatePathSegment('a'.repeat(257))).toBe('{token}');
  });
});

// R3V-4. Leaks the round-2 rules missed: 16-23 character tokens, card numbers with separators, and an address on a
// dot-less host. Each positive is paired with the ordinary segment it must NOT swallow.
describe('templatePathSegment: short tokens, card numbers and dot-less e-mail hosts (R3V-4)', () => {
  it.each([
    // base64url tokens of 16-23 chars: mixed case + a digit
    ['aB3dE5gH7jK9mN1pQ', '{token}'], // 17
    ['aB3dE5gH7jK9mN1pQrS', '{token}'], // 19
    ['aB3dE5gH7jK9mN1pQrStUv', '{token}'], // 22
    ['aB3dE5gH7jK9mN1pQrStUvW', '{token}'], // 23
    ['aB3dE5gH7jK9mN1p', '{token}'], // 16
    // lower-case alphanumeric with several separate digit runs
    ['k3j4h5g6f7d8s9a0q1w2', '{token}'],
    ['x9y8z7w6v5u4t3s2r1', '{token}'],
    ['abcdefgh1abcdefgh2', '{token}'], // exactly two separate digit runs
    // card numbers with separators (13-19 digits)
    ['4111-1111-1111-1111', '{card}'],
    ['4111%201111%201111%201111', '{card}'],
    ['4111 1111 1111 1111', '{card}'],
    ['3782-822463-10005', '{card}'],
    ['4111-1111-1111-1111-123', '{card}'], // 19 digits
    ['4111-1111-1111-1', '{card}'], // 13 digits
    // e-mail addresses on a host without a dot
    ['user@localhost', '{email}'],
    ['user%40localhost', '{email}'],
    ['admin@intranet', '{email}'],
  ])('%j -> %j', (segment, expected) => {
    expect(templatePathSegment(segment)).toBe(expected);
  });

  it.each([
    // ordinary segments of the same lengths / shapes stay readable
    'authentication-v2', // 17, one digit run, two words
    'ecmascript2015modules', // 21, a single digit run
    'ProductCatalogItems', // 19, mixed case, no digit
    'abcdefghijklmnop', // 16, no digit
    'internationalization', // 20
    'user-profile-settings', // 21, no digit
    'oauth2-callback-url', // 19, slug
    'api-v1-v2-compat-layer', // 22, slug of short versioned words
    'ABCDEFGHIJKLMNOPQRST1', // upper case only
    // digit runs that are not card numbers
    '2024-01', // 6
    '555-123', // 6
    // one short of each length bound, and a character outside the token alphabet
    'aB3dE5gH7jK9mN1', // 15 chars
    'aB3dE5gH7jK9mN1p!', // 17 chars, but not token-shaped
    // a@b keeps its meaning (a one-character host is not an address)
    'a@b',
    '@localhost',
    'user@',
    'logo-2x',
  ])('leaves %j alone', (segment) => {
    expect(templatePathSegment(segment)).toBe(segment);
  });

  it('twelve digits with separators are a phone number, not a card', () => {
    expect(templatePathSegment('1111-1111-1111')).toBe('{phone}');
  });

  it('a 20-digit run with separators is not a card number (and is a plain number run)', () => {
    expect(templatePathSegment('4111-1111-1111-1111-1111')).not.toBe('{card}');
  });

  it('templates all three inside a whole URL', () => {
    expect(
      sanitizeDetectorUrl(
        'https://a.test/pay/4111-1111-1111-1111/by/user@localhost/token/aB3dE5gH7jK9mN1pQrStUv?x=1',
      ),
    ).toBe('https://a.test/pay/{card}/by/{email}/token/{token}');
  });
});

describe('R3V-4 rules stay linear: 1,000,000-character adversarial inputs', () => {
  const BIG = 1_000_000;
  it.each([
    ['digits and dashes', `${'1-'.repeat(BIG / 2)}`],
    ['digits and spaces', `${'1 '.repeat(BIG / 2)}`],
    ['percent-twenty runs', `${'1%20'.repeat(BIG / 4)}`],
    ['an @ then host chars', `a@${'b'.repeat(BIG)}`],
    ['many @', `${'a@'.repeat(BIG / 2)}`],
    ['mixed token run', `${'aB1'.repeat(BIG / 3)}`],
    ['digit runs split by dash', `${'a1-'.repeat(BIG / 3)}`],
  ])('%s', (_name, input) => {
    const started = Date.now();
    templatePathSegment(input);
    templatePathSegment(input.slice(0, 22));
    templatePathSegment(input.slice(0, 200));
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
