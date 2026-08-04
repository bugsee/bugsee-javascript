import { describe, expect, it } from 'vitest';
import { redactSensitivePairs } from './pairs';

// The shared `key=value&key=value` scanner behind BOTH URL-query redaction and form-body redaction
// (Android NetworkDataSanitizer.redactSensitivePairs parity). Everything outside a sensitive value —
// including the region past `end`, e.g. a URL fragment — must survive byte-for-byte.
const all = (input: string): string => redactSensitivePairs(input, 0, input.length);

describe('redactSensitivePairs — what it redacts', () => {
  it('replaces a sensitive value with the URL-ENCODED token, not the bare one', () => {
    // The bare `<redacted>` would be invalid in a URL and would re-encode differently per consumer.
    expect(all('api_key=SECRET')).toBe('api_key=%3Credacted%3E');
  });

  it('leaves a non-sensitive pair byte-for-byte', () => {
    expect(all('plain=VALUE')).toBe('plain=VALUE');
  });

  it('redacts only the sensitive pairs in a mixed sequence', () => {
    expect(all('user=bob&password=hunter2&page=2&api_key=K')).toBe(
      'user=bob&password=%3Credacted%3E&page=2&api_key=%3Credacted%3E',
    );
  });

  it('matches key names case-insensitively', () => {
    expect(all('API_KEY=x&Password=y')).toBe('API_KEY=%3Credacted%3E&Password=%3Credacted%3E');
  });

  it('matches by substring, so `userPassword` is caught', () => {
    expect(all('userPassword=x')).toBe('userPassword=%3Credacted%3E');
  });

  it('decodes a percent-encoded key name before matching', () => {
    // `api%5Fkey` is `api_key`; matching the raw form would miss it.
    expect(all('api%5Fkey=SECRET')).toBe('api%5Fkey=%3Credacted%3E');
  });

  it('redacts the WHOLE value when the value itself contains `=`', () => {
    // Only the FIRST `=` separates name from value — a base64 signature ending in `=` must not survive.
    expect(all('signature=abc=def')).toBe('signature=%3Credacted%3E');
  });

  it('redacts an empty sensitive value (the key is still evidence, the shape is preserved)', () => {
    expect(all('token=')).toBe('token=%3Credacted%3E');
  });

  it('leaves a VALUELESS segment alone — it must never invent a credential', () => {
    // Normalising `?token` to `token=<redacted>` also made a `;`-delimited value list read as keys, and
    // because matching is by substring (`shipping` contains `pin`) the scanner INVENTED an `=` and a marker
    // where the source had neither. A report must not assert that a credential existed.
    expect(all('token&page=2')).toBe('token&page=2');
    expect(all('tags=running;shipping;food')).toBe('tags=running;shipping;food');
    expect(all('name=Robert;Pinter')).toBe('name=Robert;Pinter');
  });

  it('handles a sensitive pair in the LAST position', () => {
    expect(all('page=2&token=abc')).toBe('page=2&token=%3Credacted%3E');
  });
});

describe('redactSensitivePairs — what it must NOT touch', () => {
  it('returns the input unchanged when nothing is sensitive', () => {
    // NOTE: `toBe` on a string is value equality, so this cannot assert instance identity — an earlier
    // version claimed to (`return input.split('').join('')` survived it). Value equality is the property
    // that actually matters; the allocation-avoidance is an implementation detail, not a contract.
    const input = 'a=1&b=2';
    expect(all(input)).toBe(input);
  });

  it('leaves the region BEFORE `start` untouched', () => {
    const input = 'https://h/p?token=abc';
    expect(redactSensitivePairs(input, input.indexOf('?') + 1, input.length)).toBe(
      'https://h/p?token=%3Credacted%3E',
    );
  });

  it('does not let the text before `start` be READ as a key — that would destroy clean URLs', () => {
    // Scanning from 0 makes the first "key" the whole `https://h/auth/p?page` prefix, which contains
    // `auth` and is therefore sensitive — so a URL with NOTHING sensitive in its query would be
    // wholesale-redacted. The previous test cannot catch this: there, both readings happen to agree.
    const input = 'https://h/auth/p?page=2';
    expect(redactSensitivePairs(input, input.indexOf('?') + 1, input.length)).toBe(input);
  });

  it('leaves the region AFTER `end` untouched — a URL fragment survives verbatim', () => {
    const input = 'token=abc#Section?token=notascanned';
    expect(redactSensitivePairs(input, 0, input.indexOf('#'))).toBe(
      'token=%3Credacted%3E#Section?token=notascanned',
    );
  });

  it('never throws on a malformed percent escape in the key', () => {
    // decodeURIComponent('%zz') throws; a URL we merely observed must never break capture.
    expect(() => all('%zz=v')).not.toThrow();
    expect(all('%zz=v')).toBe('%zz=v');
  });

  it('still matches a sensitive key that also carries a malformed escape', () => {
    expect(all('token%zz=v')).toBe('token%zz=%3Credacted%3E');
  });

  it('is a no-op on an empty range', () => {
    expect(redactSensitivePairs('token=abc', 0, 0)).toBe('token=abc');
  });
});

describe('redactSensitivePairs — idempotence', () => {
  it('re-scanning an already-redacted string changes nothing further', () => {
    const once = all('password=hunter2&q=1');
    expect(all(once)).toBe(once);
  });
});

describe('redactSensitivePairs — no nesting, by design', () => {
  it('does NOT scan into a nested URL value, and stays linear on hostile input', () => {
    // A previous version did, via mutual recursion with its caller: 72 ms at 1 KB, 2.3 s at 4 KB, 117 s at
    // 16 KB on the app's own thread, plus a RangeError past ~16 KB — remotely reachable through `req.url`.
    // The OAuth `redirect_uri` shape is therefore an accepted gap; a DoS is not an acceptable price for it.
    const nested = 'next=https://y.com/?token=SECRET';
    expect(all(nested)).toBe(nested);
    const hostile = `q=${'?='.repeat(4000)}`;
    const started = Date.now();
    expect(() => all(hostile)).not.toThrow();
    expect(Date.now() - started).toBeLessThan(500);
  });
});
