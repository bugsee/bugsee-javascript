import { describe, expect, it } from 'vitest';
import {
  contentTypeOf,
  gateNetworkBody,
  sanitizeBody,
  sanitizeHeaders,
  sanitizeJson,
  sanitizeParams,
} from './index';
import type { NetworkEvent } from './wire';

const R = '<redacted>';
const GH = `ghp_${'a'.repeat(36)}`;

/** Build a minimal NetworkEvent with the given `custom` payload for the body-gate tests. */
function evt(custom: NetworkEvent['custom']): NetworkEvent {
  return {
    timestamp: 0,
    id: 'i',
    sequence: 's',
    mechanism: 'fetch',
    url: 'https://x/y',
    method: 'POST',
    type: 'complete',
    custom,
  };
}

describe('sanitizeHeaders', () => {
  it('redacts the value of a sensitive header, preserving its name/casing', () => {
    expect(sanitizeHeaders({ Authorization: 'Bearer x', Cookie: 'a=b' })).toEqual({
      Authorization: R,
      Cookie: R,
    });
  });

  it('shape-scans non-sensitive header values and leaves clean ones', () => {
    expect(sanitizeHeaders({ 'X-Trace': GH, 'Content-Type': 'application/json' })).toEqual({
      'X-Trace': R,
      'Content-Type': 'application/json',
    });
  });

  it('does not mutate the input', () => {
    const input = { Authorization: 'Bearer x' };
    sanitizeHeaders(input);
    expect(input).toEqual({ Authorization: 'Bearer x' });
  });

  it('keeps a __proto__ header as own data (no prototype pollution / value loss)', () => {
    const out = sanitizeHeaders(JSON.parse('{"__proto__":"x","Accept":"*/*"}')) as Record<
      string,
      unknown
    >;
    expect(Object.getOwnPropertyDescriptor(out, '__proto__')?.value).toBe('x');
    expect(out.Accept).toBe('*/*');
  });

  it('threads the creditCards option into the shape pass', () => {
    // CC shape is off by default; only redacts a non-sensitive header value when the option is on.
    expect(sanitizeHeaders({ 'X-Card': '5555555555554444' })).toEqual({
      'X-Card': '5555555555554444',
    });
    expect(sanitizeHeaders({ 'X-Card': '5555555555554444' }, { creditCards: true })).toEqual({
      'X-Card': R,
    });
  });
});

describe('sanitizeParams', () => {
  it('redacts sensitive keys and shape-scans other values', () => {
    expect(sanitizeParams({ password: 'hunter2', note: 'sk_live_x', q: 'hello' })).toEqual({
      password: R,
      note: R,
      q: 'hello',
    });
  });

  it('keeps a __proto__ param as own data (no prototype pollution / value loss)', () => {
    const out = sanitizeParams(JSON.parse('{"__proto__":"x","q":"ok"}')) as Record<string, unknown>;
    // own data property, not dropped by the prototype setter (which would happen on a plain {})
    expect(Object.getOwnPropertyDescriptor(out, '__proto__')?.value).toBe('x');
    expect(out.q).toBe('ok');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('threads the creditCards option into the shape pass', () => {
    expect(sanitizeParams({ note: '5555555555554444' }, { creditCards: true })).toEqual({
      note: R,
    });
  });
});

describe('sanitizeJson', () => {
  it('redacts sensitive keys and recurses into objects', () => {
    expect(sanitizeJson({ token: 'x', user: { name: 'a', secret: 's' } })).toEqual({
      token: R,
      user: { name: 'a', secret: R },
    });
  });

  it('recurses into arrays and shape-scans string values', () => {
    expect(sanitizeJson({ items: [GH, 'ok'] })).toEqual({ items: [R, 'ok'] });
  });

  it('recurses into objects nested inside arrays and leaves non-string elements', () => {
    expect(sanitizeJson([{ token: 'x' }, 42])).toEqual([{ token: R }, 42]);
  });

  it('threads the creditCards option into the recursive shape pass', () => {
    expect(sanitizeJson({ note: '5555555555554444' }, { creditCards: true })).toEqual({ note: R });
  });

  it('leaves non-string primitives unchanged', () => {
    expect(sanitizeJson({ n: 1, b: true, z: null })).toEqual({ n: 1, b: true, z: null });
  });

  it('shape-scans a bare string', () => {
    expect(sanitizeJson('jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dozjgNryP4J3jVmNHl0w5N')).toBe(
      `jwt ${R}`,
    );
  });

  it('keeps a __proto__ key as own data without polluting any prototype', () => {
    const out = sanitizeJson(JSON.parse('{"__proto__": {"polluted": true}, "a": "ok"}')) as Record<
      string,
      unknown
    >;
    expect(out.a).toBe('ok');
    expect(out.polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('does not mutate the input', () => {
    const input = { token: 'x', nested: { secret: 's' } };
    sanitizeJson(input);
    expect(input).toEqual({ token: 'x', nested: { secret: 's' } });
  });
});

describe('sanitizeBody', () => {
  it('redacts sensitive keys in an application/json body and re-serializes', () => {
    expect(sanitizeBody('{"password":"hunter2","q":"hi"}', 'application/json')).toBe(
      `{"password":"${R}","q":"hi"}`,
    );
  });

  it('treats a Content-Type with a charset suffix as JSON (case-insensitively)', () => {
    expect(sanitizeBody('{"token":"x"}', 'Application/JSON; charset=utf-8')).toBe(
      `{"token":"${R}"}`,
    );
  });

  it('key-redacts text/json bodies (legacy JSON media type)', () => {
    expect(sanitizeBody('{"password":"x"}', 'text/json')).toBe(`{"password":"${R}"}`);
  });

  it('key-redacts RFC 6839 +json structured-syntax suffix bodies', () => {
    // application/vnd.api+json (JSON:API), application/ld+json, application/problem+json, … are JSON.
    expect(sanitizeBody('{"password":"x"}', 'application/vnd.api+json')).toBe(
      `{"password":"${R}"}`,
    );
    expect(sanitizeBody('{"token":"x"}', 'application/problem+json; charset=utf-8')).toBe(
      `{"token":"${R}"}`,
    );
  });

  it('trims surrounding whitespace around the media type', () => {
    expect(sanitizeBody('{"token":"x"}', '  application/json  ')).toBe(`{"token":"${R}"}`);
  });

  it('key-redacts a JSON-SHAPED body whatever the media type claims', () => {
    // The type gate alone left AWS SDK v3 traffic (`application/x-amz-json-1.1`) and ndjson in the clear,
    // because the textual passes cannot read JSON at all. A label must never buy LESS redaction than the
    // content earns, so the shape decides too.
    expect(sanitizeBody('{"password":"x"}', 'application/json5')).toBe(`{"password":"${R}"}`);
    expect(sanitizeBody('{"Password":"hunter2"}', 'application/x-amz-json-1.1')).toBe(
      `{"Password":"${R}"}`,
    );
    expect(sanitizeBody('{"token":"t"}', 'text/plain')).toBe(`{"token":"${R}"}`);
  });

  it('degrades to the shape pass when a JSON body fails to parse (never throws)', () => {
    // Not valid JSON, but a JSON content-type: must not throw — falls back to redactShapes.
    expect(sanitizeBody(`not json ${GH}`, 'application/json')).toBe(`not json ${R}`);
  });

  it('shape-scans a non-JSON body (text/plain) that has no key=value structure', () => {
    expect(sanitizeBody(`hello ${GH} world`, 'text/plain')).toBe(`hello ${R} world`);
  });

  it('shape-scans a body with no Content-Type', () => {
    expect(sanitizeBody(`leak ${GH}`, undefined)).toBe(`leak ${R}`);
  });

  it('threads the creditCards option into the JSON path', () => {
    expect(
      sanitizeBody('{"note":"5555555555554444"}', 'application/json', { creditCards: true }),
    ).toBe(`{"note":"${R}"}`);
    // Off by default → the CC number survives the JSON path.
    expect(sanitizeBody('{"note":"5555555555554444"}', 'application/json')).toBe(
      '{"note":"5555555555554444"}',
    );
  });

  it('threads the creditCards option into the shape (non-JSON) path', () => {
    expect(sanitizeBody('card 5555555555554444', 'text/plain', { creditCards: true })).toBe(
      `card ${R}`,
    );
  });
});

describe('contentTypeOf', () => {
  it('returns undefined when there are no headers', () => {
    expect(contentTypeOf(undefined)).toBeUndefined();
  });

  it('finds the Content-Type case-insensitively', () => {
    expect(contentTypeOf({ 'content-type': 'text/html' })).toBe('text/html');
    expect(contentTypeOf({ 'CoNtEnT-tYpE': 'text/html' })).toBe('text/html');
  });

  it('returns undefined when no Content-Type header is present', () => {
    expect(contentTypeOf({ Accept: '*/*' })).toBeUndefined();
  });
});

describe('gateNetworkBody', () => {
  const OPTS = { maxBytes: 1024, captureWithoutType: false };

  it('leaves an event with no body unchanged (identity)', () => {
    const e = evt({ headers: { 'Content-Type': 'application/json' } });
    expect(gateNetworkBody(e, OPTS)).toBe(e);
  });

  it('leaves an event whose body is explicitly null unchanged (identity)', () => {
    const e = evt({ body: null, headers: { 'Content-Type': 'application/json' } });
    expect(gateNetworkBody(e, OPTS)).toBe(e);
  });

  it('preserves a producer-set no_body_reason without re-gating (identity)', () => {
    // Body present but the producer already declared why it is absent — leave it alone.
    const e = evt({ body: 'x'.repeat(99999), no_body_reason: 'cant_read_data' });
    expect(gateNetworkBody(e, OPTS)).toBe(e);
  });

  it('drops a body with a missing Content-Type as no_content_type', () => {
    const out = gateNetworkBody(evt({ body: 'hello' }), OPTS);
    expect(out.custom?.body).toBeNull();
    expect(out.custom?.no_body_reason).toBe('no_content_type');
  });

  it('drops a body with a blank (whitespace) Content-Type as no_content_type', () => {
    const out = gateNetworkBody(evt({ body: 'hi', headers: { 'content-type': '   ' } }), OPTS);
    expect(out.custom?.no_body_reason).toBe('no_content_type');
  });

  it('keeps a Content-Type-less body when captureWithoutType is on', () => {
    const e = evt({ body: 'hello' });
    expect(gateNetworkBody(e, { maxBytes: 1024, captureWithoutType: true })).toBe(e);
  });

  it('drops an over-size body as size_too_large', () => {
    const e = evt({ body: 'x'.repeat(11), headers: { 'Content-Type': 'text/plain' } });
    const out = gateNetworkBody(e, { maxBytes: 10, captureWithoutType: false });
    expect(out.custom?.body).toBeNull();
    expect(out.custom?.no_body_reason).toBe('size_too_large');
  });

  it('keeps a body at exactly the byte limit (identity)', () => {
    const e = evt({ body: 'x'.repeat(10), headers: { 'Content-Type': 'text/plain' } });
    expect(gateNetworkBody(e, { maxBytes: 10, captureWithoutType: false })).toBe(e);
  });

  it('measures size in UTF-8 bytes, not characters', () => {
    // '€' is 3 UTF-8 bytes; one char but over a 2-byte limit.
    const e = evt({ body: '€', headers: { 'Content-Type': 'text/plain' } });
    const out = gateNetworkBody(e, { maxBytes: 2, captureWithoutType: false });
    expect(out.custom?.no_body_reason).toBe('size_too_large');
  });

  it('finds the Content-Type header case-insensitively', () => {
    // Lower-cased header name must still be recognized as a present content type.
    const e = evt({ body: 'x'.repeat(11), headers: { 'CoNtEnT-tYpE': 'text/plain' } });
    const out = gateNetworkBody(e, { maxBytes: 10, captureWithoutType: false });
    // Recognized as present (so not no_content_type) and then dropped on size.
    expect(out.custom?.no_body_reason).toBe('size_too_large');
  });

  it('does not mutate the input event when dropping', () => {
    const e = evt({ body: 'hello' });
    gateNetworkBody(e, OPTS);
    expect(e.custom?.body).toBe('hello');
    expect(e.custom?.no_body_reason).toBeUndefined();
  });

  it('preserves the other custom fields when dropping', () => {
    const e = evt({ body: 'hello', headers: { 'X-A': '1' }, error: 'boom' });
    const out = gateNetworkBody(e, OPTS);
    expect(out.custom?.headers).toEqual({ 'X-A': '1' });
    expect(out.custom?.error).toBe('boom');
  });
});

// Wave 1.2 (docs/review/capture.md SEV1 #5). `sanitizeBody` applied the key denylist to JSON media types
// ONLY, so the canonical HTML login POST — `new URLSearchParams({username, password})` — was stored in the
// clear. Worse, @bugsee/capture STAMPS the `application/x-www-form-urlencoded` Content-Type when the caller
// set none, which is exactly what lets the body past the capture gate. Android has always redacted these
// (NetworkDataSanitizer.sanitizeBody → redactSensitiveFormBody / redactSensitiveColonLines); this is parity.
const URL_R = '%3Credacted%3E';

describe('sanitizeBody — form-urlencoded key redaction', () => {
  it('redacts the credentials in a form login POST (review probe R1a, verbatim)', () => {
    expect(
      sanitizeBody(
        'username=bob&password=hunter2&api_key=K123',
        'application/x-www-form-urlencoded;charset=UTF-8',
      ),
    ).toBe(`username=bob&password=${URL_R}&api_key=${URL_R}`);
  });

  it('redacts a urlencoded-shaped text/plain body (review probe R1c, verbatim)', () => {
    expect(sanitizeBody('password=hunter2&ssn=123-45-6789', 'text/plain')).toBe(
      `password=${URL_R}&ssn=${URL_R}`,
    );
  });

  it('redacts when the SDK captured no Content-Type at all', () => {
    expect(sanitizeBody('token=abc', undefined)).toBe(`token=${URL_R}`);
  });

  it('redacts a urlencoded body that arrived under a JSON Content-Type but is not JSON', () => {
    // The JSON parse fails; falling back to the shape pass alone would ship the credential.
    expect(sanitizeBody('password=hunter2', 'application/json')).toBe(`password=${URL_R}`);
  });

  it('leaves a body with no `=` untouched', () => {
    expect(sanitizeBody('just some prose about a password', 'text/plain')).toBe(
      'just some prose about a password',
    );
  });

  it('still applies the shape pass to the surviving values', () => {
    expect(sanitizeBody(`user=bob&note=${GH}`, 'text/plain')).toBe(`user=bob&note=${R}`);
  });

  it('does not redact non-sensitive fields', () => {
    expect(sanitizeBody('page=2&sort=asc', 'application/x-www-form-urlencoded')).toBe(
      'page=2&sort=asc',
    );
  });
});

describe('sanitizeBody — colon-delimited (STOMP / header-style) bodies', () => {
  it('redacts a STOMP CONNECT passcode', () => {
    // WebSocket frame bodies reach the report by default; STOMP puts the credential on a `key:value` line.
    expect(sanitizeBody('CONNECT\naccept-version:1.2\npasscode:s3cret\n', 'text/plain')).toBe(
      `CONNECT\naccept-version:1.2\npasscode:${R}\n`,
    );
  });

  it('leaves a non-sensitive colon line alone, including one whose value contains colons', () => {
    expect(sanitizeBody('started:12:30:01', 'text/plain')).toBe('started:12:30:01');
  });

  it('matches the key ignoring surrounding whitespace', () => {
    expect(sanitizeBody('Authorization: Bearer xyz', 'text/plain')).toBe(`Authorization:${R}`);
  });

  it('matches an INDENTED key — leading whitespace must not hide the credential', () => {
    expect(sanitizeBody('frame\n   passcode: s3cret', 'text/plain')).toBe(
      `frame\n   passcode:${R}`,
    );
  });

  it('does not redact a line that has no colon at all', () => {
    // `indexOf` returns -1 for such a line; slicing on it would read `passwordX` as the key `password`
    // and blank the whole line. Only lines that actually carry `key: value` are eligible.
    expect(sanitizeBody('passwordX\nnote: ok', 'text/plain')).toBe('passwordX\nnote: ok');
  });

  it('leaves a body with no colon untouched', () => {
    expect(sanitizeBody('plain text', 'text/plain')).toBe('plain text');
  });

  it('does not treat a leading colon as a key', () => {
    expect(sanitizeBody(':password', 'text/plain')).toBe(':password');
  });

  it('never corrupts a structured body that it cannot parse', () => {
    // `{"password"` is not a field name, and `<config auth` is not a form key. Reading either as one used to
    // replace the rest of the line/body, leaving unparseable output in the report.
    const brokenJson = '{"password": "x", }} not really json';
    expect(sanitizeBody(brokenJson, 'application/json5')).toBe(brokenJson);
    expect(sanitizeBody('<config auth="basic" retries="3" host="a.example"/>', 'text/plain')).toBe(
      '<config auth="basic" retries="3" host="a.example"/>',
    );
  });
});

// Review finding (privacy reviewer, SEV1 #1): the form pass ran on ANY non-JSON body containing `=`, so
// prose whose first `=` was preceded by a denylist substring lost everything after it. Measured across 20
// real repo files as text/plain bodies: 10 lost >90% of their bytes.
describe('sanitizeBody — the form pass never eats a body that is not a form', () => {
  const intact = [
    ['markup', '<config auth="basic" retries="3" host="a.example"/>'],
    ['SQL', 'UPDATE users SET pass_hash = $1 WHERE id = $2 RETURNING id, email'],
    ['html', '<!DOCTYPE html><p>The site is being rebuilt.</p><div class="notice">x</div>'],
    ['css', '.a { padding: 2px; } .pin { display: none; }'],
  ] as const;

  for (const [label, body] of intact) {
    it(`leaves ${label} byte-for-byte`, () => {
      expect(sanitizeBody(body, 'text/plain')).toBe(body);
    });
  }

  it('still redacts a body that IS form-shaped', () => {
    expect(sanitizeBody('username=bob&password=hunter2', 'text/plain')).toBe(
      `username=bob&password=${URL_R}`,
    );
  });

  it('redacts a form body using the legacy `;` separator', () => {
    expect(sanitizeBody('username=bob;password=hunter2', 'text/plain')).toBe(
      `username=bob;password=${URL_R}`,
    );
  });
});

// Round-2 findings against the first attempt at this guard. Each case was measured leaking or being
// destroyed before the per-segment rewrite.
describe('sanitizeBody — the form guard decides PER SEGMENT', () => {
  const leaky: Array<[string, string]> = [
    ['UTF-8 key', 'contraseña=x&password=hunter2'],
    ['cyrillic key', 'пароль=x&password=hunter2'],
    ['slash in key', 'a/b=1&password=hunter2'],
    ['question mark in key', 'a?b=1&password=hunter2'],
    ['angle brackets', '<x>=1&password=hunter2'],
    ['unencoded & in a value', 'desc=a & b&password=hunter2'],
    ['unencoded ; and space', 'note=hi; there&password=hunter2'],
    ['quote in key', 'a"b=1&password=hunter2'],
  ];
  for (const [label, body] of leaky) {
    it(`still redacts the password when a neighbouring segment has a ${label}`, () => {
      // A whole-body verdict skipped ALL of these — one odd key shipped a real credential in the clear.
      const out = sanitizeBody(body, 'application/x-www-form-urlencoded');
      expect(out, label).not.toContain('hunter2');
      expect(out, label).toContain(URL_R);
    });
  }

  const intact: Array<[string, string]> = [
    ['markup', '<config auth="basic" retries="3"/>'],
    ['SQL', 'UPDATE users SET pass_hash = $1 WHERE id = $2'],
    ['CSS', '.a { padding: 2px; } .pin { display: none; }'],
    ['a clean .env', 'DB_HOST=db.internal\nDB_PORT=5432\nREGION=us-east-1'],
  ];
  for (const [label, body] of intact) {
    it(`leaves ${label} byte-for-byte`, () => {
      expect(sanitizeBody(body, 'text/plain'), label).toBe(body);
    });
  }

  it('confines a mis-read to ONE line instead of eating the rest of the body', () => {
    // `AUTH_MODE` is form-shaped and matches `auth`, so its value is redacted — over-redaction of a config
    // value, which is the safe direction. What matters is the blast radius: without newline separators the
    // whole file after the first `=` was replaced (63% of bytes gone).
    expect(sanitizeBody('AUTH_MODE=basic\nDB_HOST=db.internal\nDB_PORT=5432', 'text/plain')).toBe(
      `AUTH_MODE=${URL_R}\nDB_HOST=db.internal\nDB_PORT=5432`,
    );
    // …and the same for spaced, comma-separated fields. Keys are trimmed before the shape gate — without
    // that, ` password=hunter2` and `"password"=hunter2` shipped verbatim, because the gate was being
    // applied to the SENSITIVE segment's own key. The cost is that spaced prose is redacted per field.
    expect(sanitizeBody('protein = 12g, carbs = 30g, fat = 5g', 'text/plain')).toBe(
      `protein =${URL_R}, carbs = 30g, fat = 5g`,
    );
    expect(sanitizeBody('protein=12g,carbs=30g,fat=5g', 'text/plain')).toBe(
      `protein=${URL_R},carbs=30g,fat=5g`,
    );
  });
});

describe('sanitizeBody — NDJSON', () => {
  it('redacts every line of a multi-line ndjson body', () => {
    // A previous commit claimed `application/x-ndjson` was covered; real ndjson never parses whole, and the
    // textual passes cannot read JSON, so it shipped byte-for-byte unredacted.
    expect(sanitizeBody('{"password":"x"}\n{"token":"y"}', 'application/x-ndjson')).toBe(
      `{"password":"${R}"}\n{"token":"${R}"}`,
    );
  });

  it('preserves blank lines in an ndjson body', () => {
    expect(sanitizeBody('{"token":"y"}\n\n{"password":"x"}', 'application/x-ndjson')).toBe(
      `{"token":"${R}"}\n\n{"password":"${R}"}`,
    );
  });

  it('leaves prose that merely starts with a brace alone', () => {
    const prose = '{not json\nstill not json';
    expect(sanitizeBody(prose, 'text/plain')).toBe(prose);
  });
});

describe('sanitizeBody — the gate is not applied to the sensitive key itself', () => {
  const wrapped = [
    ['leading space', 'foo=1& password=hunter2'],
    ['quoted key', '"password"=hunter2'],
    ['trailing space before =', 'user.password =hunter2'],
    ['tab', 'x&\tpassword=hunter2'],
  ] as const;
  for (const [label, body] of wrapped) {
    it(`redacts a sensitive key wrapped in ${label}`, () => {
      // The neighbour's shape stopped mattering in the per-segment rewrite, but the segment's OWN shape
      // still did — in the leak direction.
      expect(sanitizeBody(body, 'text/plain'), label).not.toContain('hunter2');
    });
  }

  it('still refuses to read prose or markup as a key', () => {
    for (const body of ['<config auth="basic" retries="3"/>', 'my auth token = abc']) {
      expect(sanitizeBody(body, 'text/plain'), body).toBe(body);
    }
  });
});
