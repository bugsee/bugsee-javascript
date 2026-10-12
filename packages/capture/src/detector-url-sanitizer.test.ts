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
