import { describe, expect, it } from 'vitest';
import { expectLinearIn, LINEARITY_TEST_TIMEOUT_MS, measure } from './linear-time.test-helper';
import { redactSensitivePairs } from './pairs';

// The linearity guard these tests lean on lives in `./linear-time.test-helper` — see its header for why it
// asserts a ratio rather than a wall-clock budget, and why preparing the input is not measured. It
// used to be copied into this file and into sanitize.test.ts, and only one copy ever got fixed.

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

  it('leaves the region after `end` untouched when `end` lands ON an `=`', () => {
    // The test above never places an `=` at `end`, so it does not defend its own boundary: relaxing the
    // segment check to `eq <= pairEnd` passed the whole suite while writing a marker past `end`.
    expect(redactSensitivePairs('@ password.=&x?"', 1, 11)).toBe('@ password.=&x?"');
    expect(redactSensitivePairs('a=1&password=s', 0, 12)).toBe('a=1&password=s');
  });

  it('terminates on an out-of-range window instead of spinning forever', () => {
    // `pos = pairEnd + 1` never advances when `pairEnd` is -Infinity, so the loop cannot exit. No in-repo
    // caller can produce it (all four pass computed indices), but this is an exported function and a
    // non-terminating loop in the capture path hangs the host application, not just the SDK.
    expect(redactSensitivePairs('a=1&password=x', Number.NEGATIVE_INFINITY, 14)).toBe(
      'a=1&password=%3Credacted%3E',
    );
    expect(redactSensitivePairs('a=1&password=x', -5, 99)).toBe('a=1&password=%3Credacted%3E');
    expect(redactSensitivePairs('a=1', Number.NaN, 3)).toBe('a=1');
  });

  it(
    'does not walk past the end of the string when `end` overshoots',
    () => {
      // An `end` past `length` yields the right ANSWER either way — the scan just reads `undefined` — so only
      // the cost is observable, and it has to be large enough to see: unclamped costs 31 ms at 10 million and
      // 301 ms at 100 million, against 0 ms clamped. A 10-million bound passed the assertion at 50 ms.
      const input = 'a=1&password=x';
      expect(redactSensitivePairs(input, 0, 100_000_000)).toBe('a=1&password=%3Credacted%3E');

      // NOT a linearity check like the two below: the unclamped cost grows LINEARLY with `end`, so a ratio
      // between two large bounds stays flat and proves nothing. The property here is that `end` must not
      // affect the cost AT ALL, because it is clamped to the string — so the baseline is the honest bound.
      redactSensitivePairs(input, 0, input.length); // warm-up
      const honest = measure(() => {
        redactSensitivePairs(input, 0, input.length);
      });
      const overshooting = measure(() => {
        redactSensitivePairs(input, 0, 100_000_000);
      });
      // An ABSOLUTE ceiling, deliberately, unlike the two linearity guards below. The baseline is a
      // 14-character scan that no clock resolves, so a ratio built on it would be noise — but the
      // defect costs 301 ms against ~0, and a six-order-of-magnitude gap needs no ratio to separate.
      expect(overshooting).toBeLessThan(Math.max(honest, 5) * 8);
    },
    LINEARITY_TEST_TIMEOUT_MS,
  );

  it(
    'scans a long separator run in linear time',
    () => {
      // `indexOf('=', pos)` was unbounded by `end`, so every segment in a run carrying no `=` rescanned to
      // end-of-string: 84 ms at 100 K, 1339 ms at 400 K, 8158 ms at 1 M — quadratic, and reachable through
      // `sanitizeUrl(event.url)`, which has no length cap. The header comment claimed "linear" throughout.
      const build = (n: number): string => `https://h/p?${'&'.repeat(n)}`;
      const hostile = build(400_000);
      expect(redactSensitivePairs(hostile, hostile.indexOf('?') + 1, hostile.length)).toBe(hostile);
      expectLinearIn(
        build,
        (input) => {
          redactSensitivePairs(input, input.indexOf('?') + 1, input.length);
        },
        400_000,
      );
    },
    LINEARITY_TEST_TIMEOUT_MS,
  );

  it(
    'scans a long `;` separator run in linear time too',
    () => {
      const build = (n: number): string => `https://h/p?${';'.repeat(n)}`;
      const hostile = build(400_000);
      expect(redactSensitivePairs(hostile, hostile.indexOf('?') + 1, hostile.length)).toBe(hostile);
      expectLinearIn(
        build,
        (input) => {
          redactSensitivePairs(input, input.indexOf('?') + 1, input.length);
        },
        400_000,
      );
    },
    LINEARITY_TEST_TIMEOUT_MS,
  );

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
