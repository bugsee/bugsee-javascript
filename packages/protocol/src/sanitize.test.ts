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

describe('sanitizeHeaders — a non-string value must not throw', () => {
  // `redactShapes` calls `value.length` then `value.replace`. A number throws, the throw is swallowed by
  // MultiKeyEmitterBase's dispatch, and the WHOLE network entry disappears — request headers and request
  // body both. Reachable because xhr-interceptor stored the `setRequestHeader` argument raw, where the
  // fetch and node:http interceptors both String()-coerce it. One `setRequestHeader('X-Count', 42)` — which
  // the browser itself coerces without complaint — silently deleted the request half of every such report.
  it.each([
    ['number', 42, '42'],
    ['boolean', true, 'true'],
    ['array', [1, 2], '1,2'],
    ['null', null, 'null'],
    ['undefined', undefined, 'undefined'],
    ['object', { a: 1 }, '[object Object]'],
  ])('coerces a %s header value instead of throwing', (_label, value, expected) => {
    const headers = { 'X-Odd': value } as unknown as Record<string, string>;
    expect(() => sanitizeHeaders(headers)).not.toThrow();
    expect(sanitizeHeaders(headers)['X-Odd']).toBe(expected);
  });

  it('still redacts a sensitive header whose value is not a string', () => {
    const headers = { authorization: 12345 } as unknown as Record<string, string>;
    expect(sanitizeHeaders(headers).authorization).toBe('<redacted>');
  });

  it('does not throw on a value that cannot be coerced at all', () => {
    // `String(x)` is not total. A null-prototype object, or one with a throwing `Symbol.toPrimitive`,
    // throws — and a throw here deletes the entry, which is the exact thing the coercion exists to stop.
    for (const hostile of [
      Object.create(null),
      {
        toString() {
          throw new Error('hostile');
        },
      },
      {
        [Symbol.toPrimitive]() {
          throw new Error('hostile');
        },
      },
    ]) {
      const headers = { 'X-H': hostile } as unknown as Record<string, string>;
      expect(() => sanitizeHeaders(headers)).not.toThrow();
      expect(sanitizeHeaders(headers)['X-H']).toBe('<redacted>'); // fails closed
    }
  });
});

describe('contentTypeOf — the shared accessor coerces', () => {
  it('returns a string for a non-string Content-Type', () => {
    // Both consumers assume a string and both throw on a number: `sanitizeBody` via `.toLowerCase()`,
    // `gateNetworkBody` via `.trim()`. Either throw is swallowed by the emitter and deletes the network
    // entry. Fixing only sanitizeBody's caller left the gate crashing, so the guard lives in the accessor.
    expect(contentTypeOf({ 'Content-Type': 42 } as unknown as Record<string, string>)).toBe('42');
    expect(() =>
      gateNetworkBody(
        evt({ headers: { 'Content-Type': 42 } as unknown as Record<string, string>, body: 'x' }),
        {
          maxBytes: 100,
          captureWithoutType: false,
        },
      ),
    ).not.toThrow();
    expect(() =>
      sanitizeBody(
        'password=x',
        contentTypeOf({ 'Content-Type': 42 } as unknown as Record<string, string>),
      ),
    ).not.toThrow();
  });

  it('still returns undefined when the header is absent', () => {
    expect(contentTypeOf({ Accept: '*/*' })).toBeUndefined();
    expect(contentTypeOf(undefined)).toBeUndefined();
  });
});

describe('sanitizeParams — a non-string value must not throw either', () => {
  it('coerces rather than throwing, like its sibling', () => {
    // The defense added to `sanitizeHeaders` was not swept to its structural peer, which reaches
    // `redactShapes` by the identical route.
    const params = { count: 42, ok: true } as unknown as Record<string, string>;
    expect(() => sanitizeParams(params)).not.toThrow();
    expect(sanitizeParams(params)).toEqual({ count: '42', ok: 'true' });
  });

  it('still redacts a sensitive key whose value is not a string', () => {
    expect(sanitizeParams({ token: 42 } as unknown as Record<string, string>).token).toBe(
      '<redacted>',
    );
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

  it('replaces the ENTIRE value under a sensitive key with the marker, whatever its type', () => {
    // I briefly changed this to walk the subtree and redact each leaf, so a report could show which fields
    // existed. That was wrong on three independent counts, all found in review round 5:
    //
    //  1. It opened a redaction BYPASS. Walking recurses; a deep body throws RangeError; `sanitizeBody`'s
    //     catch falls to the textual passes; and `JSON_PAIR` cannot match `"password":{` because its value
    //     alternative excludes `{`. Measured: safe at every depth before, leaking from ~4000 deep after.
    //  2. KEY NAMES became a leak channel. `{"tokens":{"eyJhbGciOiJIUzI1NiJ9.abc":true}}` emits the token,
    //     because the token IS the key. Maps keyed by a secret or an identifier are ordinary.
    //  3. It broke Android parity, which CLAUDE.md makes binding. `NetworkDataSanitizer` does
    //     `obj.put(key, REDACTED_VALUE)` unconditionally, and sdk-design.md §873 requires the sanitizer's
    //     output be byte-identical to mobile.
    //
    // Plus `{"token":{}}` came back as `{"token":{}}` — the marker vanished entirely.
    //
    // The diagnostic complaint that motivated the change is real and is ACCEPTED as the cost: inside a
    // subtree the app itself labelled `password`/`token`/`secret`, nothing survives. Showing which fields
    // existed would need a shape SUMMARY (key count, types) rather than key names, and a backend contract.
    expect(sanitizeJson({ shipping: { carrier: 'UPS', tracking: '1Z9' } })).toEqual({
      shipping: R,
    });
    expect(sanitizeJson({ token: ['a', 'b'] })).toEqual({ token: R });
    expect(sanitizeJson({ password: { pin: 1234, ok: true } })).toEqual({ password: R });
    expect(sanitizeJson({ token: {} })).toEqual({ token: R }); // the marker never disappears
    expect(sanitizeJson({ token: [] })).toEqual({ token: R });
    expect(sanitizeJson({ password: true, token: 42, secret: null })).toEqual({
      password: R,
      token: R,
      secret: R,
    });
  });

  it('never lets a key name inside a sensitive subtree reach the output', () => {
    const out = JSON.stringify(sanitizeJson({ tokens: { 'eyJhbGciOiJIUzI1NiJ9.abc': true } }));
    expect(out).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(
      JSON.stringify(sanitizeJson({ credentials: { 'alice@corp.example': 'p1' } })),
    ).not.toContain('alice@corp.example');
  });

  it('does not leak a deep body through a RangeError', () => {
    // Walking the subtree made this throw out of `sanitizeJson`, and `sanitizeBody`'s catch then shipped
    // the body verbatim. Terminating at the sensitive key means the depth is never reached.
    let deep = '{"inner":"SECRETVALUE"}';
    for (let i = 0; i < 12_000; i += 1) {
      deep = `{"a":${deep}}`;
    }
    expect(sanitizeBody(`{"password":${deep}}`, 'application/json')).not.toContain('SECRETVALUE');
  });
});

describe('sanitizeBody — JSON that does not parse', () => {
  // The textual fallbacks are structurally incapable of reading JSON: `redactFormBody` returns early (no
  // `=`) and `redactSensitiveColonLines`'s HEADER_TOKEN rejects `{"password"` as a field name. So a body
  // that LOOKS like JSON but fails JSON.parse got ZERO redaction — not partial, none.
  it.each([
    [
      'NaN (Python json.dumps allow_nan — Flask/FastAPI + numpy/pandas)',
      '{"password":"hunter2","score":NaN}',
    ],
    ['Infinity', '{"password":"hunter2","r":Infinity}'],
    ['trailing comma', '{\n  "password": "hunter2",\n}'],
    ['single quotes around the value', '{"password": \'hunter2\'}'],
    ['truncated mid-document', '{"a":1,"password":"hunter2"'],
  ])('redacts a sensitive key in unparseable JSON — %s', (_label, body) => {
    const out = sanitizeBody(body, 'application/json');
    expect(out).not.toContain('hunter2');
    expect(out).toContain('redacted');
  });

  it('redacts an unquoted value too', () => {
    expect(sanitizeBody('{"api_key":abc123,"n":NaN}', 'application/json')).not.toContain('abc123');
  });

  it('redacts a secret nested past the recursion limit', () => {
    // Deep nesting makes JSON.parse (or the recursive walk) throw RangeError; the catch then handed the
    // body to passes that cannot read JSON, so it shipped verbatim. The textual JSON pass closes it — this
    // pins that, because nothing else asserts the deep case and it was closed as a side effect.
    for (const depth of [500, 3000, 6000]) {
      let body = '{"password":"LEAKED"}';
      for (let i = 0; i < depth; i += 1) {
        body = `{"a":${body}}`;
      }
      expect(sanitizeBody(body, 'application/json'), `depth ${depth}`).not.toContain('LEAKED');
    }
  });

  it('leaves non-sensitive keys in unparseable JSON byte-for-byte alone', () => {
    const body = '{"city":"NY","score":NaN}';
    expect(sanitizeBody(body, 'application/json')).toBe(body);
  });

  it('changes only the value’s bytes, keeping the original separator', () => {
    expect(sanitizeBody('{\n  "password" :  "hunter2",\n  "n": NaN\n}', 'application/json')).toBe(
      '{\n  "password" :  "<redacted>",\n  "n": NaN\n}',
    );
  });

  it('reaches a secret nested inside an object or array', () => {
    // An unquoted-value alternative that admits `{` swallows the nested object as the OUTER key's value,
    // moving lastIndex past the nested secret entirely.
    expect(sanitizeBody('{"outer":{"password":"p"},"n":NaN}', 'application/json')).toBe(
      '{"outer":{"password":"<redacted>"},"n":NaN}',
    );
    expect(sanitizeBody('{"arr":[{"token":"t"}],"n":NaN}', 'application/json')).toBe(
      '{"arr":[{"token":"<redacted>"}],"n":NaN}',
    );
  });

  it('stays linear on hostile JSON-shaped input', () => {
    // The unanchored form of this pattern put a candidate start at every `"` — 16 ms at 8 KB, 227 ms at
    // 32 KB. I wrote it that way first, in the same review round that fixed exactly this defect one file
    // over, which is why it now has a test rather than a comment.
    const hostile = `{"${'\\"'.repeat(128_000)}`; // ~256 KB, escaped quotes, never closed
    const started = Date.now();
    sanitizeBody(hostile, 'application/json');
    expect(Date.now() - started).toBeLessThan(100);
  });

  it('does not apply the JSON pass to a body that is not JSON-shaped', () => {
    // The pass is gated on the JSON branch; prose quoting `"password": x` in a text body is not a document.
    const prose = 'the docs say "password": is required';
    expect(sanitizeBody(prose, 'text/plain')).toBe(prose);
  });
});

describe('sanitizeBody — a sensitive key wrapped in whitespace and quotes together', () => {
  // `.trim()` ran BEFORE the quote strip and removed only ONE quote per side, so any combination that
  // left whitespace inside the quotes still failed the shape gate and shipped the value.
  it.each([
    ['space inside double quotes', '" password "=hunter2'],
    ['space inside single quotes', "' password '=hunter2"],
    ['doubled quotes', '""password""=hunter2'],
    ['quote then space', '" password"=hunter2'],
    ['tab inside quotes', '"\tpassword"=hunter2'],
  ])('redacts %s', (_label, body) => {
    expect(sanitizeBody(body, 'text/plain')).not.toContain('hunter2');
  });

  it('still refuses bracket- and backtick-wrapped keys — those are prose, not form fields', () => {
    // FORM_KEY deliberately excludes markup characters. Treating `<password>=x` as a field would read a
    // template placeholder or a doc snippet as a credential, which is the class that destroyed bodies.
    for (const body of ['`password`=hunter2', '{password}=hunter2', '<password>=hunter2']) {
      expect(sanitizeBody(body, 'text/plain')).toBe(body);
    }
  });
});

describe('sanitizeBody — the colon pass preserves CRLF', () => {
  it('keeps the `\\r` of a CRLF line it redacts', () => {
    // The same defect the NDJSON path was fixed for, one function over: `split('\n')` leaves the `\r` at
    // the end of the line, and rebuilding from `line.slice(0, colon + 1)` drops it. STOMP frames are CRLF
    // by spec, so the uploaded body stopped matching the bytes on the wire.
    expect(sanitizeBody('passcode: s3cret\r\nhost: h\r\n', 'text/plain')).toBe(
      'passcode:<redacted>\r\nhost: h\r\n',
    );
  });

  it('leaves a bare-LF body on LF', () => {
    expect(sanitizeBody('passcode: s3cret\nhost: h\n', 'text/plain')).toBe(
      'passcode:<redacted>\nhost: h\n',
    );
  });
});

describe('sanitizeBody — JSON-shaped bodies that are not JSON at all', () => {
  it.each([
    ['Python str(dict) / repr', "{'password': 'hunter2', 'n': 1}"],
    ['JS object literal / JSON5', '{password: "hunter2"}'],
    ['single-quoted key, double-quoted value', '{\'password\': "hunter2"}'],
  ])('redacts a sensitive key in %s', (_label, body) => {
    // `JSON_PAIR` requires a DOUBLE-quoted key, so these got nothing. A Python service logging
    // `str(request.form)` and a JS console dump are both ordinary captured-body shapes.
    const out = sanitizeBody(body, 'application/json');
    expect(out).not.toContain('hunter2');
    expect(out).toContain('redacted');
  });

  it('leaves a non-sensitive single-quoted body byte-for-byte alone', () => {
    const body = "{'city': 'NY', 'n': 1}";
    expect(sanitizeBody(body, 'application/json')).toBe(body);
  });

  it('re-emits the key in the quoting style it arrived in', () => {
    expect(sanitizeBody("{'password': 'hunter2'}", 'application/json')).toBe(
      "{'password': '<redacted>'}",
    );
    expect(sanitizeBody('{password: "hunter2"}', 'application/json')).toBe(
      '{password: "<redacted>"}',
    );
  });

  it('stays linear after admitting single-quoted and bare keys', () => {
    // Two new alternatives went into a pattern whose UNANCHORED form was quadratic. Measured across eight
    // adversarial shapes (unterminated quotes of both kinds, bare idents, dense commas/colons/braces):
    // 1 MB worst case 8 ms. This pins the two that exercise the new branches.
    for (const hostile of [`{'${"\\'".repeat(128_000)}`, `{${'ab,'.repeat(80_000)}`]) {
      const started = Date.now();
      sanitizeBody(hostile, 'application/json');
      expect(Date.now() - started).toBeLessThan(100);
    }
  });
});

describe('sanitizeBody — XML', () => {
  // Multipart got a structural reader; XML did not, and it is a far more common enterprise wire format
  // than STOMP — which DOES have one. `<password>hunter2</password>` has no `=` for the form pass, and the
  // colon pass's HEADER_TOKEN rejects `<password>` as a field name, so every textual pass missed it.
  it.each([
    ['element text', '<login><password>hunter2</password></login>'],
    ['SOAP-ish namespaced tag', '<s:Body><s:Password>hunter2</s:Password></s:Body>'],
    ['mixed case tag', '<Login><Password>hunter2</Password></Login>'],
    ['tag with attributes', '<cred type="basic"><password lang="en">hunter2</password></cred>'],
    ['attribute value', '<user name="bob" password="hunter2"/>'],
    ['single-quoted attribute', "<user password='hunter2'/>"],
    ['xml declaration', '<?xml version="1.0"?><r><api_key>hunter2</api_key></r>'],
    ['whitespace around text', '<r><token>\n  hunter2\n</token></r>'],
  ])('redacts a sensitive %s', (_label, body) => {
    const out = sanitizeBody(body, 'application/xml');
    expect(out).not.toContain('hunter2');
    expect(out).toContain('redacted');
  });

  it('leaves non-sensitive XML byte-for-byte alone', () => {
    for (const body of [
      '<order><city>New York</city><qty>3</qty></order>',
      '<a href="https://x.io/y">link</a>',
      '<r><note>the password field is required</note></r>',
    ]) {
      expect(sanitizeBody(body, 'application/xml')).toBe(body);
    }
  });

  it('keeps the surrounding markup intact', () => {
    expect(sanitizeBody('<login><password>hunter2</password></login>', 'text/xml')).toBe(
      '<login><password>&lt;redacted&gt;</password></login>',
    );
    expect(sanitizeBody('<user name="bob" password="hunter2"/>', 'text/xml')).toBe(
      '<user name="bob" password="&lt;redacted&gt;"/>',
    );
  });

  it('does not turn indentation into a marker when a sensitive tag holds ELEMENTS', () => {
    // A sensitive tag whose content is child elements has whitespace-only text after its open tag. Without
    // the whitespace guard that indentation becomes `<redacted>`, producing a document whose structure the
    // SDK invented — and the nested values are still handled on their own iteration.
    const body =
      '<credentials>\n  <user>bob</user>\n  <password>hunter2</password>\n</credentials>';
    const out = sanitizeBody(body, 'application/xml');
    expect(out).toContain('<user>bob</user>'); // untouched, and its indentation intact
    expect(out).not.toContain('hunter2');
    expect(out).toBe(
      '<credentials>\n  <user>bob</user>\n  <password>&lt;redacted&gt;</password>\n</credentials>',
    );
  });

  it('reaches XML sent under an unhelpful Content-Type, by shape', () => {
    expect(sanitizeBody('<login><password>hunter2</password></login>', 'text/plain')).not.toContain(
      'hunter2',
    );
  });

  it('does not read HTML prose as XML fields', () => {
    // The pass is keyed on the TAG NAME being sensitive, so ordinary markup is untouched.
    const html = '<p>Enter your password below</p><div class="pin">3</div>';
    expect(sanitizeBody(html, 'text/html')).toBe(html);
  });

  it('stays linear on hostile XML-shaped input', () => {
    for (const hostile of [
      `<${'a'.repeat(200_000)}`, // an unterminated tag
      '<a>'.repeat(80_000), // many opens, never closed
      `<a ${'b="c" '.repeat(60_000)}>`, // one tag, very many attributes
    ]) {
      const started = Date.now();
      sanitizeBody(hostile, 'application/xml');
      expect(Date.now() - started).toBeLessThan(100);
    }
  });
});

describe('sanitizeBody — multipart/form-data', () => {
  const mk = (name: string, value: string) =>
    `------X\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n------X--`;

  it('redacts a sensitive part value, leaving the framing byte-exact', () => {
    // The value sits alone after a blank line with no `=` and no `:`, and the part header's own key
    // (Content-Disposition) is not sensitive, so every textual pass missed it entirely.
    //
    // Asserted whole, not with `not.toContain`: the CRLF before the closing boundary is FRAMING. Dropping
    // it still passes a "secret is gone" check while producing a body no multipart parser can read.
    expect(sanitizeBody(mk('password', 'hunter2'), 'multipart/form-data; boundary=----X')).toBe(
      '------X\r\nContent-Disposition: form-data; name="password"\r\n\r\n<redacted>\r\n------X--',
    );
  });

  it('leaves a non-sensitive part untouched, boundaries and CRLFs intact', () => {
    const body = mk('city', 'New York');
    expect(sanitizeBody(body, 'multipart/form-data; boundary=----X')).toBe(body);
  });

  it('redacts only the sensitive part in a multi-part body', () => {
    const body =
      `------X\r\nContent-Disposition: form-data; name="user"\r\n\r\nbob\r\n` +
      `------X\r\nContent-Disposition: form-data; name="password"\r\n\r\nhunter2\r\n------X--`;
    const out = sanitizeBody(body, 'multipart/form-data; boundary=----X');
    expect(out).toContain('bob');
    expect(out).not.toContain('hunter2');
  });

  it('handles a quoted boundary parameter', () => {
    const out = sanitizeBody(mk('password', 'hunter2'), 'multipart/form-data; boundary="----X"');
    expect(out).not.toContain('hunter2');
  });

  it('falls back to sniffing the delimiter when the Content-Type carries no boundary', () => {
    expect(sanitizeBody(mk('password', 'hunter2'), 'multipart/form-data')).not.toContain('hunter2');
  });

  it('still runs the form and colon passes on the OTHER parts', () => {
    // REGRESSION. `redactMultipart` returned early whenever it changed anything, so redacting one part
    // switched the form and colon passes off for the whole body — redacting one secret UN-redacted
    // another. The pre-commit build caught the `api_key:` line via the colon pass; this build shipped it.
    const body =
      `------X\r\nContent-Disposition: form-data; name="password"\r\n\r\np@ssw0rd\r\n` +
      `------X\r\nContent-Disposition: form-data; name="metadata"\r\n\r\napi_key: sk_test_LEAKED\r\n` +
      `------X\r\nContent-Disposition: form-data; name="opts"\r\n\r\ntoken=SECOND_SECRET\r\n------X--`;
    const out = sanitizeBody(body, 'multipart/form-data; boundary=----X');
    expect(out).not.toContain('p@ssw0rd'); // the part-name pass
    expect(out).not.toContain('sk_test_LEAKED'); // the colon pass, on a sibling part
    expect(out).not.toContain('SECOND_SECRET'); // the form pass, on a sibling part
  });

  it('shape-scans a multipart part with a non-sensitive name', () => {
    // Every other multipart test uses a key-NAME secret, so nothing pinned that the shape pass reaches
    // multipart at all. A JWT in a part called `note` has no key to match on.
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dozjgNryP4J3jVmNHl0w5N';
    const body = `------X\r\nContent-Disposition: form-data; name="note"\r\n\r\n${jwt}\r\n------X--`;
    expect(sanitizeBody(body, 'multipart/form-data; boundary=----X')).not.toContain(jwt);
  });

  it.each([
    ['filename before name', 'filename="a.txt"; name="password"'],
    ['unquoted name', 'name=password'],
    ['single-quoted name', "name='password'"],
  ])('finds the part name when written as %s', (_label, disposition) => {
    // `/name="([^"]*)"/ ` matched INSIDE `filename="a.txt"`, captured `a.txt`, found it non-sensitive and
    // shipped the value. RFC 7578 does not mandate parameter order, and unquoted tokens are legal.
    const body = `------X\r\nContent-Disposition: form-data; ${disposition}\r\n\r\nhunter2\r\n------X--`;
    expect(sanitizeBody(body, 'multipart/form-data; boundary=----X')).not.toContain('hunter2');
  });

  it('handles parts separated by bare LF, leaving the framing byte-exact', () => {
    // `indexOf('\r\n\r\n')` skipped the part entirely, so the value shipped. Asserted WHOLE, not with
    // `not.toContain`: a fixed 4-character gap on a 2-character separator eats the first two bytes of the
    // value, which still removes the secret and still passes a "secret is gone" check.
    const body = `------X\nContent-Disposition: form-data; name="password"\n\nhunter2\n------X--`;
    expect(sanitizeBody(body, 'multipart/form-data; boundary=----X')).toBe(
      `------X\nContent-Disposition: form-data; name="password"\n\n<redacted>\n------X--`,
    );
  });

  it('does not destroy a body whose declared boundary never appears', () => {
    // The `parts.length < 2` guard had no test: without it the whole body is read as one part and
    // everything after the first blank line is replaced.
    const body = 'Content-Disposition: form-data; name="token"\r\n\r\nline1\r\nline2\r\nline3';
    const out = sanitizeBody(body, 'multipart/form-data; boundary=----ABSENT');
    expect(out).toContain('line2');
    expect(out).toContain('line3');
  });

  it('falls through to the textual passes when the declared boundary is absent from the body', () => {
    // A mislabelled body must still get the form/colon/shape passes, not be handed to a multipart reader
    // that finds nothing and reports success.
    expect(sanitizeBody('password=hunter2', 'multipart/form-data; boundary=----X')).toBe(
      'password=%3Credacted%3E',
    );
  });

  it('does not read a `--` prefixed body with no CRLF as multipart', () => {
    // `body.indexOf('\r\n')` is -1 here, and `slice(0, -1)` would make a delimiter of the whole body minus
    // its last character — matching nothing, or worse, splitting on near-arbitrary text.
    expect(sanitizeBody('--just a dashed line, password=hunter2', 'text/plain')).toBe(
      '--just a dashed line, password=%3Credacted%3E',
    );
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
    //
    // The JSON assertion was `toBe(brokenJson)` — asserting the body came back byte-identical, secret and
    // all. That encoded the leak rather than the intent: "does not corrupt" means the STRUCTURE survives,
    // not that the value does. Only the value is replaced now; everything around it is still byte-exact.
    const brokenJson = '{"password": "x", }} not really json';
    expect(sanitizeBody(brokenJson, 'application/json5')).toBe(
      '{"password": "<redacted>", }} not really json',
    );
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

  it('preserves CRLF line endings in an ndjson body', () => {
    // `split('\n')` leaves a trailing `\r` on each line; JSON.parse tolerates it and JSON.stringify drops
    // it, so every `\r` in the body was silently deleted. A byte the SDK invented losing is still a byte
    // the report no longer matches the wire on.
    expect(sanitizeBody('{"password":"x"}\r\n{"a":1}', 'application/x-ndjson')).toBe(
      '{"password":"<redacted>"}\r\n{"a":1}',
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
