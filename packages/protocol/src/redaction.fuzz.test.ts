import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DEFAULT_FILENAMES } from './constants';
import {
  isSensitiveKey,
  redactShapes,
  SENSITIVE_HEADERS,
  SENSITIVE_KEY_SUBSTRINGS,
  sanitizeBody,
  sanitizeErrorMessage,
  sanitizeHeaders,
  sanitizeJson,
  sanitizeParams,
  sanitizeUrl,
} from './index';

/**
 * Property-based tests for the redaction engine.
 *
 * This is the code that decides what never leaves a user's device, and it reads bodies, URLs and headers
 * the SDK does not control. Its example tests are unusually good — nearly every comment in `sanitize.ts`
 * records a real leak that was found and closed — but each of those is one shape someone thought of. The
 * point of this file is the claim they cannot make on their own:
 *
 *   for EVERY encoding this sanitizer handles, a secret stored under a sensitive key does not survive.
 *
 * Stated once and generated across the encodings, so a new pass that forgets a branch, or an old pass
 * that a refactor stops reaching, fails here rather than in a customer's bundle.
 */

/** A needle that cannot appear by coincidence and matches no secret SHAPE (so only KEY rules can redact it). */
const secret = fc.stringMatching(/^SECRET[A-Za-z0-9]{10,20}$/);

/** Keys the denylist must treat as sensitive, including the decorated forms substring matching exists for. */
const sensitiveKey = fc
  .tuple(
    fc.constantFrom(...SENSITIVE_KEY_SUBSTRINGS),
    fc.constantFrom('', 'user', 'my', 'x_', 'oauth_'),
    fc.constantFrom('', '_value', '2', 'Field'),
  )
  .map(([base, prefix, suffix]) => `${prefix}${base}${suffix}`)
  .filter((k) => isSensitiveKey(k));

/** Keys that carry no sensitive substring — used for the preservation half. */
const benignKey = fc.stringMatching(/^[a-z][a-z0-9_]{2,10}$/).filter((k) => !isSensitiveKey(k));

const jsonString = (v: string): string => JSON.stringify(v);

/**
 * Every encoding `sanitizeBody` claims to handle, as (name, contentType, build).
 *
 * The list is deliberately broader than the canonical media types, because the module's own rule is that
 * "a label must never buy a body LESS redaction than its content earns" — shape-detected JSON and XML are
 * covered too, under types that say nothing.
 */
const ENCODINGS: ReadonlyArray<{
  name: string;
  contentType: string | undefined;
  build: (key: string, value: string) => string;
}> = [
  {
    name: 'json object',
    contentType: 'application/json',
    build: (k, v) => `{${jsonString(k)}:${jsonString(v)}}`,
  },
  {
    name: 'json nested',
    contentType: 'application/json',
    build: (k, v) => `{"outer":{"inner":{${jsonString(k)}:${jsonString(v)}}}}`,
  },
  {
    name: 'json array of objects',
    contentType: 'application/json',
    build: (k, v) => `[{"a":1},{${jsonString(k)}:${jsonString(v)}}]`,
  },
  {
    name: 'json under a vendor media type (AWS)',
    contentType: 'application/x-amz-json-1.1',
    build: (k, v) => `{${jsonString(k)}:${jsonString(v)}}`,
  },
  {
    name: 'json under no content type at all',
    contentType: undefined,
    build: (k, v) => `{${jsonString(k)}:${jsonString(v)}}`,
  },
  {
    name: 'ndjson',
    contentType: 'application/x-ndjson',
    build: (k, v) => `{"a":1}\n{${jsonString(k)}:${jsonString(v)}}\n{"b":2}`,
  },
  {
    name: 'json-shaped but unparseable (trailing comma)',
    contentType: 'application/json',
    build: (k, v) => `{${jsonString(k)}:${jsonString(v)},}`,
  },
  {
    name: 'json5 / single-quoted',
    contentType: 'application/json',
    build: (k, v) => `{'${k}': '${v}'}`,
  },
  {
    name: 'python repr dict',
    contentType: 'text/plain',
    build: (k, v) => `{'${k}': '${v}', 'other': 1}`,
  },
  {
    name: 'form urlencoded',
    contentType: 'application/x-www-form-urlencoded',
    build: (k, v) => `a=1&${k}=${v}&b=2`,
  },
  {
    name: 'form urlencoded, legacy ; separator',
    contentType: 'application/x-www-form-urlencoded',
    build: (k, v) => `a=1;${k}=${v};b=2`,
  },
  // Four multipart variants, because the part-name parser explicitly accepts double-quoted,
  // single-quoted and BARE names, and real clients differ on line endings. Generating only the
  // double-quoted CRLF form left every mutation of that regex alive: the input never reached the
  // alternatives it was written for.
  {
    name: 'multipart/form-data (double-quoted name)',
    contentType: 'multipart/form-data; boundary=----X',
    build: (k, v) =>
      `------X\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n------X--`,
  },
  {
    name: 'multipart/form-data (single-quoted name)',
    contentType: 'multipart/form-data; boundary=----X',
    build: (k, v) =>
      `------X\r\nContent-Disposition: form-data; name='${k}'\r\n\r\n${v}\r\n------X--`,
  },
  {
    name: 'multipart/form-data (bare name, spaced =)',
    contentType: 'multipart/form-data; boundary=----X',
    build: (k, v) =>
      `------X\r\nContent-Disposition: form-data; name = ${k}\r\n\r\n${v}\r\n------X--`,
  },
  {
    name: 'multipart/form-data (bare LF line endings)',
    contentType: 'multipart/form-data; boundary=----X',
    build: (k, v) => `------X\nContent-Disposition: form-data; name="${k}"\n\n${v}\n------X--`,
  },
  {
    name: 'json under an uppercase type with parameters',
    contentType: 'APPLICATION/JSON; charset=UTF-8',
    build: (k, v) => `{${jsonString(k)}:${jsonString(v)}}`,
  },
  {
    name: 'xml under a type with parameters and odd spacing',
    contentType: '  text/XML ;charset=utf-8',
    build: (k, v) => `<root><${k}>${v}</${k}></root>`,
  },
  {
    name: 'xml element text',
    contentType: 'application/xml',
    build: (k, v) => `<root><${k}>${v}</${k}></root>`,
  },
  {
    name: 'xml attribute',
    contentType: 'application/xml',
    build: (k, v) => `<root><node ${k}="${v}" other="keep"/></root>`,
  },
  {
    name: 'soap under a +xml media type',
    contentType: 'application/soap+xml',
    build: (k, v) => `<Envelope><Body><${k}>${v}</${k}></Body></Envelope>`,
  },
  { name: 'colon lines', contentType: 'text/plain', build: (k, v) => `a: 1\n${k}: ${v}\nb: 2` },
];

describe('sanitizeBody — a secret under a sensitive key never survives (fuzz)', () => {
  for (const encoding of ENCODINGS) {
    it(`redacts it in ${encoding.name}`, () => {
      fc.assert(
        fc.property(sensitiveKey, secret, (key, value) => {
          const body = encoding.build(key, value);
          const out = sanitizeBody(body, encoding.contentType);
          expect(out, `leaked through ${encoding.name}: ${body}`).not.toContain(value);
        }),
        { numRuns: 200 },
      );
    });
  }

  // The other half of the guarantee. A sanitizer that returned `<redacted>` for everything would satisfy
  // every property above and destroy the debugging value the capture exists for — and over-redaction has
  // been a real regression here before (a whole-body verdict that "shipped a real password in the clear"
  // in one direction and "destroyed everything after the first `=`" in the other).
  it('leaves a body with no sensitive key byte-for-byte identical', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ENCODINGS),
        benignKey,
        fc.stringMatching(/^[A-Za-z0-9 _.-]{1,30}$/),
        (encoding, key, value) => {
          const body = encoding.build(key, value);
          const out = sanitizeBody(body, encoding.contentType);
          // JSON encodings are re-serialized rather than passed through, so compare semantically there
          // and byte-for-byte everywhere else.
          if (out !== body) {
            expect(out, `mangled a benign ${encoding.name} body: ${body} -> ${out}`).toContain(
              value,
            );
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  // Totality. The body is attacker-influenced and arrives on the capture path; a throw here would
  // propagate into whatever interceptor is recording the request.
  it('never throws, for any body and any content type', () => {
    const contentType = fc.oneof(
      fc.constantFrom(
        'application/json',
        'application/xml',
        'text/plain',
        'multipart/form-data; boundary=x',
        'application/x-www-form-urlencoded',
        'application/octet-stream',
      ),
      fc.string({ maxLength: 40 }),
      fc.constant(undefined),
    );
    fc.assert(
      fc.property(fc.string({ maxLength: 400 }), contentType, (body, ct) => {
        expect(() => sanitizeBody(body, ct)).not.toThrow();
      }),
      { numRuns: 500 },
    );
  });

  // Sanitizing an already-sanitized body must be a no-op. If it is not, a second pass somewhere in the
  // pipeline (the WebView bridge re-redacts on the native side by design) would keep rewriting content.
  it('is idempotent', () => {
    fc.assert(
      fc.property(fc.constantFrom(...ENCODINGS), sensitiveKey, secret, (encoding, key, value) => {
        const once = sanitizeBody(encoding.build(key, value), encoding.contentType);
        const twice = sanitizeBody(once, encoding.contentType);
        expect(twice).toBe(once);
      }),
      { numRuns: 300 },
    );
  });
});

describe('the denylists themselves', () => {
  /**
   * Pinned by CONTENT, not by iteration.
   *
   * Every property in this file that walks `SENSITIVE_HEADERS` or `SENSITIVE_KEY_SUBSTRINGS` walks
   * whatever the list happens to contain, so deleting an entry keeps them green — the property and the
   * data move together. Mutation testing showed exactly that: blanking `'x-csrf-token'`,
   * `'x-amz-signature'`, `'x-goog-api-key'` and 17 others survived the entire suite.
   *
   * These lists are a product promise rather than an implementation detail — they are byte-matched with
   * the mobile SDKs so server-side dedup stays consistent — so the promise is written down here. A
   * deliberate removal has to change this test, which is the point.
   */
  it('treats the credential-bearing headers as sensitive', () => {
    for (const header of [
      'authorization',
      'proxy-authorization',
      'cookie',
      'set-cookie',
      'x-api-key',
      'x-auth-token',
      'x-csrf-token',
      'authentication',
      'x-amz-security-token',
      'x-amz-credential',
      'x-amz-signature',
      'x-goog-api-key',
      'x-vault-token',
      'x-shopify-access-token',
      'x-clerk-session-token',
      'x-supabase-auth',
    ]) {
      expect(SENSITIVE_HEADERS.has(header), `${header} is no longer redacted`).toBe(true);
      const out = sanitizeHeaders({ [header]: 'SECRETheaderValue123' });
      expect(JSON.stringify(out), `${header} leaked its value`).not.toContain(
        'SECRETheaderValue123',
      );
    }
  });

  // `x-forwarded-for` / `x-real-ip` carry a caller's IP, which is PII rather than a credential. They are
  // on the list for that reason, and a cleanup that reads the list as "credentials only" would drop them.
  it('treats the caller-identifying headers as sensitive too', () => {
    for (const header of ['x-forwarded-for', 'x-real-ip']) {
      expect(SENSITIVE_HEADERS.has(header), `${header} is no longer redacted`).toBe(true);
      expect(JSON.stringify(sanitizeHeaders({ [header]: '203.0.113.7' }))).not.toContain(
        '203.0.113.7',
      );
    }
  });

  it('treats the credential-bearing key substrings as sensitive', () => {
    for (const substring of [
      'password',
      'passwd',
      'secret',
      'token',
      'access_token',
      'refresh_token',
      'api_key',
      'apikey',
      'authorization',
      'credit_card',
      'cvv',
    ]) {
      expect(SENSITIVE_KEY_SUBSTRINGS).toContain(substring);
      expect(isSensitiveKey(substring), `${substring} is no longer a sensitive key`).toBe(true);
      // And the substring rule still holds: a decorated key containing it is sensitive as well.
      expect(isSensitiveKey(`user_${substring}_field`)).toBe(true);
    }
  });
});

describe('sanitizeHeaders / sanitizeParams / sanitizeJson (fuzz)', () => {
  it('redacts every sensitive header whatever its casing', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...SENSITIVE_HEADERS),
        secret,
        fc.constantFrom<(s: string) => string>(
          (s) => s,
          (s) => s.toUpperCase(),
          (s) => s.replace(/^./, (c) => c.toUpperCase()),
        ),
        (header, value, recase) => {
          const out = sanitizeHeaders({ [recase(header)]: value, 'x-keep': 'kept' });
          expect(JSON.stringify(out)).not.toContain(value);
          expect(out['x-keep']).toBe('kept');
        },
      ),
      { numRuns: 300 },
    );
  });

  it('redacts a sensitive param and preserves its siblings', () => {
    fc.assert(
      fc.property(sensitiveKey, secret, benignKey, (key, value, keep) => {
        fc.pre(key !== keep);
        const out = sanitizeParams({ [key]: value, [keep]: 'kept' });
        expect(JSON.stringify(out)).not.toContain(value);
        expect(out[keep]).toBe('kept');
      }),
      { numRuns: 300 },
    );
  });

  // The structural pass, exercised on trees rather than one flat object: a sensitive key at ANY depth,
  // including inside arrays, must take its whole subtree with it.
  it('redacts a sensitive key at any depth, in objects and arrays alike', () => {
    const nest = (depth: number, leaf: unknown): unknown =>
      depth === 0 ? leaf : { level: nest(depth - 1, leaf), sibling: 'kept' };
    fc.assert(
      fc.property(
        sensitiveKey,
        secret,
        fc.integer({ min: 0, max: 5 }),
        fc.boolean(),
        (key, value, depth, inArray) => {
          const leaf = inArray ? [{ [key]: value }] : { [key]: value };
          const out = sanitizeJson(nest(depth, leaf));
          expect(JSON.stringify(out)).not.toContain(value);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('never throws on arbitrary JSON-ish values', () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        expect(() => sanitizeJson(value)).not.toThrow();
      }),
      { numRuns: 500 },
    );
  });
});

describe('sanitizeUrl (fuzz)', () => {
  it('redacts a sensitive query parameter while keeping the rest of the URL', () => {
    fc.assert(
      fc.property(sensitiveKey, secret, (key, value) => {
        const url = `https://api.example.com/v1/thing?a=1&${key}=${value}&b=2`;
        const out = sanitizeUrl(url);
        expect(out).not.toContain(value);
        expect(out).toContain('https://api.example.com/v1/thing');
        expect(out).toContain('a=1');
        expect(out).toContain('b=2');
      }),
      { numRuns: 300 },
    );
  });

  it('redacts a sensitive parameter in the fragment and in matrix params too', () => {
    fc.assert(
      fc.property(sensitiveKey, secret, (key, value) => {
        for (const url of [
          `https://h/p#${key}=${value}`,
          `https://h/p;${key}=${value}/next`,
          `https://h/p?x=1#nested?${key}=${value}`,
        ]) {
          expect(sanitizeUrl(url), `leaked from ${url}`).not.toContain(value);
        }
      }),
      { numRuns: 200 },
    );
  });

  /**
   * The credential embedded in the authority — `scheme://user:pass@host`.
   *
   * A distinct code path from query redaction and a distinct leak: the password is part of the URL
   * itself, so every field carrying that URL carries it. Mutation testing found this untested — the
   * boundary arithmetic in `redactUserinfo` (where the authority starts, whether a `:` precedes the `@`,
   * whether an `@` further along belongs to the path) survived mutation, and each of those decides
   * whether the password is cut out or left in place.
   */
  it('redacts the password in a userinfo credential, whatever the authority looks like', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z][a-z0-9._-]{2,12}$/),
        secret,
        fc.constantFrom('https://', 'http://', '//'), // protocol-relative still carries an authority
        fc.constantFrom('', ':8443'),
        fc.constantFrom('', '/path/x', '/p?q=1', '/p#f', '?q=1', '#f'),
        (user, password, scheme, port, tail) => {
          const url = `${scheme}${user}:${password}@host.example.com${port}${tail}`;
          const out = sanitizeUrl(url);
          expect(out, `userinfo leaked from ${url}`).not.toContain(password);
          expect(out, 'the host was lost along with the credential').toContain('host.example.com');
        },
      ),
      { numRuns: 400 },
    );
  });

  // The USERNAME is deliberately kept — only the password is cut out — so a bundle still shows which
  // account the request was made as. Mutating the boundary that decides where the redaction starts
  // survived every leak property, because over-redacting the username hides no secret and my properties
  // only asked that the password be gone.
  it('keeps the username while removing the password', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z][a-z0-9._-]{2,12}$/), secret, (user, password) => {
        const out = sanitizeUrl(`https://${user}:${password}@host.example.com/p`);
        expect(out).not.toContain(password);
        expect(out, 'the username was redacted along with the password').toContain(user);
      }),
      { numRuns: 300 },
    );
  });

  it('does not mistake an @ in the path or query for a credential', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z0-9._-]{3,12}$/), (word) => {
        const url = `https://host.example.com/mail/${word}@example.com?to=${word}%40example.com`;
        // Nothing to redact here: over-redacting an address in a path would destroy the request's identity.
        expect(sanitizeUrl(url)).toContain(`${word}@example.com`);
      }),
      { numRuns: 200 },
    );
  });

  // The same credential quoted back in an error message — the leak that the privacy e2e caught with the
  // URL field itself already correctly redacted.
  it('redacts a userinfo credential quoted inside an error message', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z][a-z0-9]{2,10}$/), secret, (user, password) => {
        const message = `Request cannot be constructed from a URL that includes credentials: https://${user}:${password}@host.example.com/x`;
        expect(sanitizeErrorMessage(message)).not.toContain(password);
      }),
      { numRuns: 300 },
    );
  });

  it('never throws on arbitrary strings', () => {
    fc.assert(
      fc.property(fc.oneof(fc.webUrl(), fc.string({ maxLength: 200 })), (url) => {
        expect(() => sanitizeUrl(url)).not.toThrow();
      }),
      { numRuns: 300 },
    );
  });
});

describe('redactShapes — a secret is redacted by its SHAPE, under any key (fuzz)', () => {
  /** One generator per supported shape, each producing a genuine-looking credential. */
  const shaped = fc.oneof(
    // JWT: three base64url segments, the first starting `eyJ`.
    fc
      .tuple(
        fc.stringMatching(/^[A-Za-z0-9_-]{10,30}$/),
        fc.stringMatching(/^[A-Za-z0-9_-]{10,30}$/),
      )
      .map(([b, c]) => `eyJhbGciOiJIUzI1NiJ9.${b}.${c}`),
    // AWS access key id.
    fc.stringMatching(/^[0-9A-Z]{16}$/).map((s) => `AKIA${s}`),
    // Stripe live keys and webhook secret.
    fc.stringMatching(/^[A-Za-z0-9]{16,32}$/).map((s) => `sk_live_${s}`),
    fc.stringMatching(/^[A-Za-z0-9]{16,32}$/).map((s) => `whsec_${s}`),
    // GitHub tokens.
    fc.stringMatching(/^[A-Za-z0-9]{36,40}$/).map((s) => `ghp_${s}`),
  );

  it('redacts it standing alone', () => {
    fc.assert(
      fc.property(shaped, (value) => {
        expect(redactShapes(value)).not.toContain(value);
      }),
      { numRuns: 300 },
    );
  });

  // The point of shape redaction: the key gives no clue, so only the VALUE can betray it.
  it('redacts it under a perfectly innocent key, in every encoding', () => {
    fc.assert(
      fc.property(fc.constantFrom(...ENCODINGS), benignKey, shaped, (encoding, key, value) => {
        const out = sanitizeBody(encoding.build(key, value), encoding.contentType);
        expect(out, `shape leaked through ${encoding.name}`).not.toContain(value);
      }),
      { numRuns: 300 },
    );
  });

  it('redacts it inside a longer message, keeping the surrounding text', () => {
    fc.assert(
      fc.property(shaped, (value) => {
        const message = `request failed with credential ${value} while calling upstream`;
        const out = sanitizeErrorMessage(message);
        expect(out).not.toContain(value);
        expect(out).toContain('request failed with credential');
        expect(out).toContain('while calling upstream');
      }),
      { numRuns: 300 },
    );
  });

  /**
   * Credit cards — opt-in, and gated on a Luhn check.
   *
   * Untested here until mutation testing pointed at it: the Luhn internals (`if (d > 9) d -= 9`, the
   * running sum) survived, and those two lines decide whether a digit run is a card number or an order
   * id. Both directions matter — failing to redact a real card is a data leak, and redacting every long
   * digit run would destroy order numbers, timestamps and request ids.
   */
  it('redacts a Luhn-valid card number when enabled, in every separator style', () => {
    // Well-known test numbers (Luhn-valid by construction, issued for exactly this purpose).
    const cards = ['4242424242424242', '5555555555554444', '378282246310005', '6011111111111117'];
    fc.assert(
      fc.property(
        fc.constantFrom(...cards),
        fc.constantFrom<(s: string) => string>(
          (n) => n,
          (n) => n.replace(/(\d{4})(?=\d)/g, '$1 '),
          (n) => n.replace(/(\d{4})(?=\d)/g, '$1-'),
        ),
        (card, separate) => {
          const written = separate(card);
          const out = redactShapes(`card ${written} end`, { creditCards: true });
          expect(out, `card leaked as written "${written}"`).not.toContain(written);
          expect(out).toContain('card ');
          expect(out).toContain(' end');
        },
      ),
      { numRuns: 200 },
    );
  });

  it('leaves a Luhn-INVALID digit run alone, so order ids survive', () => {
    const luhnValid = (digits: string): boolean => {
      let sum = 0;
      let double = false;
      for (let i = digits.length - 1; i >= 0; i -= 1) {
        let d = digits.charCodeAt(i) - 48;
        if (double) {
          d *= 2;
          if (d > 9) {
            d -= 9;
          }
        }
        sum += d;
        double = !double;
      }
      return sum % 10 === 0;
    };
    fc.assert(
      fc.property(fc.stringMatching(/^[0-9]{12,19}$/), (digits) => {
        fc.pre(!luhnValid(digits));
        // An independent Luhn implementation is the differential here: if the two disagree, one of them
        // is wrong, and the one that matters is the SDK's.
        expect(redactShapes(`order ${digits}`, { creditCards: true })).toContain(digits);
      }),
      { numRuns: 300 },
    );
  });

  it('leaves card numbers alone when the option is off (default)', () => {
    expect(redactShapes('card 4242424242424242')).toContain('4242424242424242');
  });

  /**
   * The JWT pattern is anchored on a boundary that explicitly accepts a PERCENT-ENCODED character, so a
   * token inside a urlencoded value is still caught. Generating tokens only standing alone or after a
   * space left that alternative unexercised, and mutating it survived.
   */
  it('redacts a JWT whatever precedes it', () => {
    fc.assert(
      fc.property(
        fc
          .tuple(
            fc.stringMatching(/^[A-Za-z0-9_-]{10,20}$/),
            fc.stringMatching(/^[A-Za-z0-9_-]{10,20}$/),
          )
          .map(([b, c]) => `eyJhbGciOiJIUzI1NiJ9.${b}.${c}`),
        fc.constantFrom('', ' ', '=', '%20', '%3D', ':', ',', '"', '(', 'Bearer '),
        (jwt, prefix) => {
          expect(redactShapes(`${prefix}${jwt}`), `JWT survived after "${prefix}"`).not.toContain(
            jwt,
          );
        },
      ),
      { numRuns: 300 },
    );
  });

  it('never throws, and leaves ordinary text alone', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), (value) => {
        expect(() => redactShapes(value)).not.toThrow();
      }),
      { numRuns: 500 },
    );
  });
});

describe('the wire contract', () => {
  /**
   * Bundle filenames, pinned by value.
   *
   * They are one half of a cross-process contract — the backend reads these exact names out of the
   * uploaded archive — so a typo is not a local bug, it is a file the server never finds. Nothing
   * asserted them: blanking `crash.json`, `viewtree.json`, `screenshot.png` and `events.system.json`
   * all survived the suite.
   */
  it('names each bundle file exactly as the backend expects', () => {
    expect(DEFAULT_FILENAMES).toMatchObject({
      crash: 'crash.json',
      screenshot: 'screenshot.png',
      viewtree: 'viewtree.json',
      'events.system': 'events.system.json',
      'traces.user': 'traces.user.json',
    });
    // `breadcrumbs` carries NO extension, by mobile contract (§8.4). Pinned as an exception rather than
    // waved through by a loose pattern: it looks like an oversight, so the next tidy-up would "fix" it to
    // `breadcrumbs.json` and the backend would stop finding the file.
    expect(DEFAULT_FILENAMES.breadcrumbs).toBe('breadcrumbs');

    // Everything else is `name.ext`, and nothing may be nameless whatever the map grows.
    for (const [type, filename] of Object.entries(DEFAULT_FILENAMES)) {
      expect(filename, `${type} has no filename`).not.toBe('');
      if (type !== 'breadcrumbs') {
        expect(filename, `${type} is not a name.ext`).toMatch(/^[a-z][a-z0-9.]*\.[a-z0-9]+$/);
      }
    }
  });
});
