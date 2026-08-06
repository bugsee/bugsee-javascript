import { describe, expect, it } from 'vitest';
import { sanitizeErrorMessage, sanitizeUrl } from './url';

// Wave 1.1. Captured URLs reached disk verbatim: `?api_key=…`, `?token=…` and — node-only, because
// browsers strip it — `http://user:password@host/`. Both were recovered from a real on-disk capture in
// docs/review/node-B-http-server.md SEV1 #3 and docs/review/capture.md SEV1 #4.

describe('sanitizeUrl — query strings', () => {
  it('redacts a sensitive query value and leaves the rest byte-for-byte', () => {
    expect(sanitizeUrl('https://api.example.com/v1/x?api_key=SECRET&page=2')).toBe(
      'https://api.example.com/v1/x?api_key=%3Credacted%3E&page=2',
    );
  });

  it('redacts the OAuth callback params that arrive on a redirect', () => {
    expect(sanitizeUrl('https://app/cb?code=AUTH&id_token=JWT&state=xyz')).toBe(
      'https://app/cb?code=AUTH&id_token=%3Credacted%3E&state=xyz',
    );
  });

  it('redacts a presigned-URL signature', () => {
    const out = sanitizeUrl('https://s3/b/k?X-Amz-Signature=abc123&X-Amz-Expires=60');
    expect(out).toContain('X-Amz-Signature=%3Credacted%3E');
    expect(out).toContain('X-Amz-Expires=60');
  });

  it('redacts a WebSocket handshake token', () => {
    expect(sanitizeUrl('wss://rt.example.com/socket?token=SESSIONSECRET')).toBe(
      'wss://rt.example.com/socket?token=%3Credacted%3E',
    );
  });

  it('leaves a URL with no query untouched', () => {
    expect(sanitizeUrl('https://api.example.com/v1/x')).toBe('https://api.example.com/v1/x');
  });

  it('leaves a clean query untouched', () => {
    expect(sanitizeUrl('https://api/x?page=2&sort=asc')).toBe('https://api/x?page=2&sort=asc');
  });

  it('does not read the PATH as a query key — a clean URL survives whole', () => {
    // The path routinely contains sensitive-looking words (`/auth/`, `/session/`); only the query is a
    // key=value space, so scanning must start after `?`.
    expect(sanitizeUrl('https://api/auth/session/x?page=2')).toBe(
      'https://api/auth/session/x?page=2',
    );
  });
});

describe('sanitizeUrl — URL userinfo credentials (node-only; browsers strip these)', () => {
  it('redacts the PASSWORD and keeps the username — who authenticated is diagnostic, the secret is not', () => {
    expect(sanitizeUrl('http://alice:URLUSERINFOSECRET@127.0.0.1:8080/secure')).toBe(
      'http://alice:%3Credacted%3E@127.0.0.1:8080/secure',
    );
  });

  it('redacts the WHOLE userinfo when there is no colon — a bare userinfo is a token', () => {
    // `https://ghp_…@github.com/x` is how a PAT is smuggled into a git/registry URL. With nothing to
    // distinguish a username from a token, fail closed.
    expect(sanitizeUrl('https://ghp_16C7e42F292c6912E7710c838347Ae178B4a@github.com/o/r.git')).toBe(
      'https://%3Credacted%3E@github.com/o/r.git',
    );
  });

  it('redacts an empty password (`user:@host`) rather than leaving the shape ambiguous', () => {
    expect(sanitizeUrl('http://alice:@host/p')).toBe('http://alice:%3Credacted%3E@host/p');
  });

  it('handles userinfo AND a sensitive query in the same URL', () => {
    expect(sanitizeUrl('http://u:p@host/p?token=T')).toBe(
      'http://u:%3Credacted%3E@host/p?token=%3Credacted%3E',
    );
  });

  it('does NOT treat an `@` in the PATH as userinfo', () => {
    expect(sanitizeUrl('https://host/users/@alice/posts')).toBe('https://host/users/@alice/posts');
  });

  it('does NOT treat an `@` in the QUERY as userinfo', () => {
    expect(sanitizeUrl('https://host/s?email=bob@example.com')).toBe(
      'https://host/s?email=bob@example.com',
    );
  });

  it('does NOT treat an `@` in the FRAGMENT as userinfo', () => {
    expect(sanitizeUrl('https://host/p#@anchor')).toBe('https://host/p#@anchor');
  });

  it('takes the LAST `@` in the authority as the delimiter', () => {
    // An unencoded `@` inside userinfo is malformed but observable; the final one still delimits.
    expect(sanitizeUrl('http://user@name:pw@host/p')).toBe(
      'http://user@name:%3Credacted%3E@host/p',
    );
  });

  it('leaves a schemeless/relative URL alone apart from its query', () => {
    expect(sanitizeUrl('/api/x?token=T')).toBe('/api/x?token=%3Credacted%3E');
  });

  it('redacts a bare userinfo even when the host carries a PORT', () => {
    // The port colon sits AFTER the `@`. Mistaking it for the password separator would keep the token
    // AND corrupt the URL — the colon we split on has to be the one inside the userinfo.
    expect(sanitizeUrl('https://ghp_TOKENVALUE@github.com:443/o/r.git')).toBe(
      'https://%3Credacted%3E@github.com:443/o/r.git',
    );
  });

  it('ends the authority at `?` or `#`, not only at `/`', () => {
    // Without these arms `https://host?email=bob@example.com` reads the whole query as userinfo and becomes
    // `https://%3Credacted%3E@example.com` — destroying the URL and inventing a credential. No test reached
    // them despite the file reporting 100% branch coverage (v8 does not count `||` operands).
    expect(sanitizeUrl('https://host?email=bob@example.com')).toBe(
      'https://host?email=bob@example.com',
    );
    expect(sanitizeUrl('https://host#a@b')).toBe('https://host#a@b');
  });

  it('ignores an `@` that appears BEFORE the authority instead of mis-slicing the URL', () => {
    expect(sanitizeUrl('user@name://host/p')).toBe('user@name://host/p');
  });
});

describe('sanitizeUrl — fragments', () => {
  it('redacts an implicit-flow access token from the FRAGMENT', () => {
    // OAuth implicit flow returns the token after `#`, where it never reaches the server but is fully
    // present in the URL the SDK captures.
    expect(sanitizeUrl('https://app/cb#access_token=SECRET&token_type=bearer')).toBe(
      'https://app/cb#access_token=%3Credacted%3E&token_type=%3Credacted%3E',
    );
  });

  it('leaves an ordinary fragment untouched', () => {
    expect(sanitizeUrl('https://docs/page?v=2#installation')).toBe(
      'https://docs/page?v=2#installation',
    );
  });

  it('does not let the query scan run past `#` into the fragment', () => {
    expect(sanitizeUrl('https://a/b?page=1#token=NOTAQUERYPARAM')).toBe(
      'https://a/b?page=1#token=%3Credacted%3E',
    );
  });

  it('keeps the fragment when the QUERY ends in a redacted value', () => {
    // A query scan that ignores `#` treats `token=A#section=intro` as one pair and replaces all of it —
    // silently deleting the fragment from the captured URL.
    expect(sanitizeUrl('https://a/b?token=A#section=intro')).toBe(
      'https://a/b?token=%3Credacted%3E#section=intro',
    );
  });
});

describe('sanitizeUrl — shape pass', () => {
  it('redacts a JWT embedded in a PATH segment, where no key name exists to match', () => {
    expect(sanitizeUrl('https://api/verify/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig/next')).toBe(
      'https://api/verify/<redacted>/next',
    );
  });

  it('passes shape options through (credit cards are opt-in)', () => {
    const url = 'https://api/x?ref=4111111111111111';
    expect(sanitizeUrl(url)).toBe(url);
    expect(sanitizeUrl(url, { creditCards: true })).toBe('https://api/x?ref=<redacted>');
  });
});

describe('sanitizeUrl — robustness', () => {
  it('never throws on malformed input', () => {
    for (const bad of ['', '?', '#', '://', 'http://', '%', 'http://%zz:%@h/?%=%', 'a?b']) {
      expect(() => sanitizeUrl(bad), bad).not.toThrow();
    }
  });

  it('returns the string unchanged when there is nothing to redact', () => {
    // Value equality, not identity — see the note in pairs.test.ts.
    const url = 'https://api.example.com/v1/items?page=2';
    expect(sanitizeUrl(url)).toBe(url);
  });

  it('is idempotent — re-sanitizing changes nothing further', () => {
    const once = sanitizeUrl('http://u:p@h/x?api_key=K#access_token=T');
    expect(sanitizeUrl(once)).toBe(once);
  });
});

// A network error message routinely EMBEDS the URL it failed on — undici's "Request cannot be constructed
// from a URL that includes credentials: …", DNS/SSL failures, redirect diagnostics. So redacting `event.url`
// alone still shipped the secret, one field over; the e2e caught this after the URL fix was already in.
// Android carries the same defense (`NetworkDataSanitizer.sanitizeErrorMessage`).
describe('sanitizeErrorMessage', () => {
  it('redacts a credentialed URL embedded in free text', () => {
    expect(
      sanitizeErrorMessage(
        'Request cannot be constructed from a URL that includes credentials: http://alice:PWSECRET@127.0.0.1:52585/echo',
      ),
    ).toBe(
      'Request cannot be constructed from a URL that includes credentials: http://alice:%3Credacted%3E@127.0.0.1:52585/echo',
    );
  });

  it('redacts a query secret in an embedded absolute URL', () => {
    expect(sanitizeErrorMessage('getaddrinfo ENOTFOUND https://api/x?api_key=SECRET')).toBe(
      'getaddrinfo ENOTFOUND https://api/x?api_key=%3Credacted%3E',
    );
  });

  it('redacts a query secret in a bare PATH, which many client errors report instead of a full URL', () => {
    expect(sanitizeErrorMessage('request to /api/pay?token=SECRET failed')).toBe(
      'request to /api/pay?token=%3Credacted%3E failed',
    );
  });

  it('redacts EVERY embedded URL, not just the first', () => {
    expect(sanitizeErrorMessage('redirected http://u:P1@a/x to http://v:P2@b/y')).toBe(
      'redirected http://u:%3Credacted%3E@a/x to http://v:%3Credacted%3E@b/y',
    );
  });

  it('leaves ordinary prose alone — including a question mark and an email address', () => {
    const prose = 'Why did this fail? Contact bob@example.com about the password policy.';
    expect(sanitizeErrorMessage(prose)).toBe(prose);
  });

  it('does not mangle a prose hashtag — `#` alone does not make a token a URL', () => {
    // A token carrying a fragment but no scheme and no query is far more likely to be a hashtag than a
    // URL. A real fragment secret still gets redacted, because the URL it sits on carries `://` and is
    // matched on that.
    expect(sanitizeErrorMessage('build failed #token see log')).toBe('build failed #token see log');
    expect(sanitizeErrorMessage('failed at https://app/cb#access_token=SECRET')).toBe(
      'failed at https://app/cb#access_token=%3Credacted%3E',
    );
  });

  it('applies the shape pass to a bare token in the message', () => {
    expect(sanitizeErrorMessage(`auth failed for ghp_${'a'.repeat(36)}`)).toBe(
      'auth failed for <redacted>',
    );
  });

  it('never throws and returns the original when there is nothing to redact', () => {
    expect(sanitizeErrorMessage('')).toBe('');
    expect(sanitizeErrorMessage('socket hang up')).toBe('socket hang up');
  });
});

// Review findings (privacy reviewer SEV2 #3/#4/#5/#6/#7): each was reproduced against the real exports
// before the fix, and each is pinned here.
describe('sanitizeUrl — separators, nesting, and bounds', () => {
  it('redacts a `;`-separated query parameter (the legacy CGI/PHP separator)', () => {
    expect(sanitizeUrl('https://x.com/a?foo=1;api_key=SECRET;bar=2')).toBe(
      'https://x.com/a?foo=1;api_key=%3Credacted%3E;bar=2',
    );
  });

  it('does NOT scan into a nested URL value — an accepted gap, because the fix was a DoS', () => {
    // Handling it required recursion, which measured 2.3 s at 4 KB and 117 s at 16 KB on the app's thread
    // and threw past ~16 KB, reachable remotely via `req.url`. Documented as a limitation instead.
    const url = 'https://x.com/a?next=https://y.com/?token=SECRET';
    expect(sanitizeUrl(url)).toBe(url);
  });

  it('stays fast on a hostile query, and never throws', () => {
    const hostile = `https://api/s?q=${'?='.repeat(8000)}`;
    const started = Date.now();
    expect(() => sanitizeUrl(hostile)).not.toThrow();
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('redacts userinfo on a protocol-relative URL', () => {
    expect(sanitizeUrl('//user:pw@example.com/a')).toBe('//user:%3Credacted%3E@example.com/a');
  });

  it('redacts protocol-relative userinfo even when a `://` appears LATER in the URL', () => {
    // `indexOf('://')` was consulted first and is unbounded, so a nested absolute URL in the query moved
    // `authorityStart` into the QUERY and the real authority was never examined. That is exactly the shape
    // the protocol-relative branch was added for, so the branch was dead in its own motivating case.
    expect(sanitizeUrl('//bob:SECRET@a.io/p?next=https://c.io/d')).toBe(
      '//bob:%3Credacted%3E@a.io/p?next=https://c.io/d',
    );
  });

  it('redacts a `;`-delimited matrix / path parameter', () => {
    // `;jsessionid=` is canonical Java servlet URL rewriting, and `jsessionid` is IN the denylist — so the
    // denylist intended to catch this and the scan window (first `?` onward only) prevented it. The path is
    // scanned with `/` as an additional separator, so the value ends at the segment, not at the query.
    expect(sanitizeUrl('https://a.io/app;jsessionid=SECRETVALUE/index.jsp')).toBe(
      'https://a.io/app;jsessionid=%3Credacted%3E/index.jsp',
    );
    expect(sanitizeUrl('https://a.io/p;token=SECRETVALUE')).toBe(
      'https://a.io/p;token=%3Credacted%3E',
    );
  });

  it('redacts a matrix parameter when the QUERY carries a nested absolute URL', () => {
    // `authorityStartOf` fell back to `indexOf('://')`, which is unbounded, so for a path-only request
    // target the nested URL in the query moved the authority window into the query and `pathStart` ended
    // up past `pathEnd` — killing the scan. `?return=`/`?redirect_uri=` carrying an absolute URL is the
    // canonical login-flow shape, and it is exactly the flow that carries `;jsessionid=`.
    expect(sanitizeUrl('/checkout;jsessionid=9A2B4C6D8E?return=https://shop.example/thanks')).toBe(
      '/checkout;jsessionid=%3Credacted%3E?return=https://shop.example/thanks',
    );
    expect(sanitizeUrl('/a;token=SECRET?next=https://x.io/y')).toBe(
      '/a;token=%3Credacted%3E?next=https://x.io/y',
    );
  });

  it('redacts a matrix parameter on a path-only request target', () => {
    // What `node:http` server capture actually passes — `req.url` is a path, never absolute.
    expect(sanitizeUrl('/app;jsessionid=ABC/index.jsp')).toBe(
      '/app;jsessionid=%3Credacted%3E/index.jsp',
    );
  });

  it('does not scan the AUTHORITY as if it were a path', () => {
    // Nothing pinned where the path window starts; scanning from `indexOf('/')` alone would read the host
    // as path text and over-redact it.
    expect(sanitizeUrl('https://h;password=x/a')).toBe('https://h;password=x/a');
  });

  it('does not read an ordinary path segment as a matrix parameter', () => {
    for (const url of [
      'https://a.io/a/b/c',
      'https://a.io/files/report=final.pdf',
      'https://a.io/v1/users/42?page=2',
      'https://a.io/a;b;c/d',
    ]) {
      expect(sanitizeUrl(url)).toBe(url);
    }
  });

  it('does not spend unbounded time on a hostile URL', () => {
    // The JWT pattern backtracks per `eyJ`; 200 KB measured at 7.7 s synchronously on the app's thread.
    const hostile = `https://x/${'eyJ'.repeat(70_000)}`;
    const started = Date.now();
    const out = sanitizeUrl(hostile);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(out).toBe(hostile); // structural redaction found nothing; the shape scan was skipped
  });

  it('still shape-scans a normal-length URL', () => {
    expect(sanitizeUrl('https://api/verify/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig')).toContain(
      '<redacted>',
    );
  });
});

describe('sanitizeErrorMessage — the shapes the token gate used to miss', () => {
  it('redacts a quoted form payload with no URL around it', () => {
    expect(sanitizeErrorMessage('a=1&password=x&b=2 was the payload')).toBe(
      'a=1&password=%3Credacted%3E&b=2 was the payload',
    );
  });

  it('leaves scheme-like tokens alone — the schemeless credential form is an accepted gap', () => {
    // A `[^@/]+:[^@/]+@` branch caught `user:pw@host`, and also `npm:express@4.18.2`, `docker:nginx@sha256`,
    // `mailto:bob@example.com`, `C:\\Users\\bob@corp` and `at 10:30@worker-3` — 7 of 7 probed diagnostics
    // corrupted. Credentials inside a real URL are still redacted (that token carries `://`).
    for (const token of ['npm:express@4.18.2', 'mailto:bob@example.com', 'at 10:30@worker-3']) {
      expect(sanitizeErrorMessage(`connect ${token} failed`), token).toBe(
        `connect ${token} failed`,
      );
    }
    expect(sanitizeErrorMessage('failed http://user:pw@example.com/x')).toBe(
      'failed http://user:%3Credacted%3E@example.com/x',
    );
  });

  it('does not corrupt code quoted into a message', () => {
    // CORRECTED RATIONALE. This said "`expect(a=` fails the charset" — it does not: FORM_KEY includes `(`,
    // and `isFormSegment` tests the key WITHOUT the `=`, so `expect(a` passes the gate. What actually
    // protects this token is that `expect(a` is not a sensitive key, and that after the `&` split the
    // `passphrase)` segment carries no `=` at all. The shape gate is not what makes this case safe.
    expect(sanitizeErrorMessage('expect(a==b&&passphrase)')).toBe('expect(a==b&&passphrase)');
  });

  it('leaves a path or prose token carrying `=` alone — the shape gate’s actual job', () => {
    // The gate `isFormSegment(token)` in sanitizeErrorMessage had NO test: removing it passed the entire
    // suite while changing behaviour on real diagnostics. These are the inputs it exists for.
    for (const message of [
      'failed at src/auth/token=abc',
      'assert x<>token=1',
      'diff --git a/token=1 b/token=1',
    ]) {
      expect(sanitizeErrorMessage(message)).toBe(message);
    }
  });

  it('over-redacts config-shaped text, deliberately', () => {
    // `auth=off` IS form-shaped, so it is redacted even though nothing secret is present. That is
    // over-redaction of a non-secret, not a leak — the safe direction for a boundary that cannot tell a
    // quoted form payload from a quoted config line. Recorded so the behaviour is a decision, not a
    // surprise.
    expect(sanitizeErrorMessage('config auth=off;retries=3 applied')).toBe(
      'config auth=%3Credacted%3E;retries=3 applied',
    );
  });

  it('still leaves ordinary prose and a bare email alone', () => {
    const prose = 'Contact bob@example.com — the build failed at 12:30';
    expect(sanitizeErrorMessage(prose)).toBe(prose);
  });
});
