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

  it('redacts a secret in a URL NESTED inside a query value (the OAuth redirect_uri shape)', () => {
    expect(sanitizeUrl('https://x.com/a?next=https://y.com/?token=SECRET')).toBe(
      'https://x.com/a?next=https://y.com/?token=%3Credacted%3E',
    );
  });

  it('redacts a secret in a PERCENT-ENCODED nested URL', () => {
    const out = sanitizeUrl('https://x.com/a?next=https%3A%2F%2Fy.com%2F%3Ftoken%3DSECRET');
    expect(out).not.toContain('SECRET');
    expect(out).toContain('next=');
  });

  it('redacts userinfo on a protocol-relative URL', () => {
    expect(sanitizeUrl('//user:pw@example.com/a')).toBe('//user:%3Credacted%3E@example.com/a');
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

  it('redacts a schemeless `user:pw@host` credential', () => {
    expect(sanitizeErrorMessage('user:pw@example.com refused the connection')).toBe(
      'user:%3Credacted%3E@example.com refused the connection',
    );
  });

  it('still leaves ordinary prose and a bare email alone', () => {
    const prose = 'Contact bob@example.com — the build failed at 12:30';
    expect(sanitizeErrorMessage(prose)).toBe(prose);
  });
});
