import { isFormSegment, redactSensitivePairs } from './pairs';
import { REDACTED_URL_ENCODED } from './sensitive';
import { redactShapes, type ShapeRedactionOptions } from './shapes';

// URL sanitization (design §8.10; Android `NetworkDataSanitizer.sanitizeUrl` parity + two documented
// supersets). Captured URLs are stored and uploaded verbatim, so every secret carried IN the URL — not in
// a header or a body — reached disk in the clear until this existed (docs/review/node-B-http-server.md
// SEV1 #3, docs/review/capture.md SEV1 #4, both reproduced against a real on-disk capture).
//
// Three passes, all string-level so the URL still matches what the app actually requested:
//
//  1. QUERY   — Android parity: redact the values of sensitive keys between `?` and `#`.
//  2. USERINFO — SUPERSET, node-specific. `node:http` fully supports `http://user:pass@host` and it is
//     routine for private registries, proxies and service-to-service calls; browsers strip it, which is
//     why Android never needed this. The username is kept (diagnostic: WHICH principal), the password
//     redacted. A userinfo with NO colon is redacted whole — `https://ghp_…@github.com` is how a token is
//     smuggled into a URL, and nothing distinguishes it from a username, so it fails closed.
//  3. FRAGMENT — SUPERSET. OAuth implicit flow returns `#access_token=…`, which never reaches the server
//     but is fully present in the URL we capture. Same pair scanner, applied after `#`.
//
// Then the shape pass, which catches a credential with no key name to match — a JWT sitting in a path
// segment. Never throws: pure string work, and the one call that can throw (`decodeURIComponent`, inside
// the pair scanner) is guarded there.

/** Redact the userinfo credential in `scheme://user:pass@host/…`, if any. */
function redactUserinfo(url: string): string {
  // `scheme://` or a protocol-relative `//host` — the latter still carries a real authority, and its
  // userinfo was surviving because only `://` was recognised.
  const schemeEnd = url.indexOf('://');
  const authorityStart = schemeEnd >= 0 ? schemeEnd + 3 : url.startsWith('//') ? 2 : -1;
  if (authorityStart < 0) {
    return url; // relative or schemeless — no authority, so no userinfo
  }
  // The authority ends at the first `/`, `?` or `#`; an `@` past that point is path/query/fragment text.
  let authorityEnd = url.length;
  for (let i = authorityStart; i < url.length; i += 1) {
    const c = url[i];
    if (c === '/' || c === '?' || c === '#') {
      authorityEnd = i;
      break;
    }
  }
  const at = url.lastIndexOf('@', authorityEnd - 1);
  if (at < authorityStart) {
    return url; // no userinfo in the authority
  }
  const colon = url.indexOf(':', authorityStart);
  const keepUntil = colon >= 0 && colon < at ? colon + 1 : authorityStart;
  return url.slice(0, keepUntil) + REDACTED_URL_ENCODED + url.slice(at);
}

/**
 * Redact secrets carried in free text that EMBEDS a URL — a network error message.
 *
 * Redacting `event.url` is not enough on its own: the failure message routinely quotes the URL back
 * ("Request cannot be constructed from a URL that includes credentials: http://user:pw@host/…", DNS/TLS
 * failures, redirect diagnostics), so the credential ships one field over. The privacy e2e caught exactly
 * that, with the URL field already correctly redacted. Android carries the same defense
 * (`NetworkDataSanitizer.sanitizeErrorMessage`).
 *
 * Works token-wise: every whitespace-delimited token that could be a URL is passed through
 * {@link sanitizeUrl}, so EVERY embedded URL is covered, and prose is left alone — a sentence's `?` or an
 * email address cannot be read as a query string, because a token is not a query and carries no pairs.
 */
export function sanitizeErrorMessage(message: string, options?: ShapeRedactionOptions): string {
  const scrubbed = message.replace(/\S+/g, (token) => {
    if (token.includes('://') || token.includes('?')) {
      return sanitizeUrl(token, options);
    }
    // A form payload quoted into the message. NOTE: a SCHEMELESS `user:pw@host` is deliberately NOT handled
    // — the branch that did corrupted 7 of 7 probed diagnostics (`npm:express@4.18.2`, `mailto:`,
    // `C:\Users\bob@corp`, `at 10:30@worker-3`). Credentials inside a real `://` URL are still redacted.
    // Gated on segment SHAPE, so `expect(a==b&&pass)` is untouched; `config auth=off` IS redacted, which is
    // over-redaction of a non-secret and the safe direction (asserted by name in url.test.ts).
    if (token.includes('=') && isFormSegment(token)) {
      return redactSensitivePairs(token, 0, token.length);
    }
    return token;
  });
  return redactShapes(scrubbed, options); // tokens that were not URL-ish still get the shape pass
}

/**
 * Redact secrets carried in a URL: sensitive query and fragment parameter values, and any userinfo
 * credential. Returns the original string when there is nothing to redact.
 */
export function sanitizeUrl(url: string, options?: ShapeRedactionOptions): string {
  let out = redactUserinfo(url);

  // The FIRST `?` only. A nested query (`?next=https://y/?token=SECRET`) is deliberately NOT scanned — the
  // version that did was mutually recursive and became a remote DoS. Asserted as a known gap in url.test.ts.
  const query = out.indexOf('?');
  if (query >= 0) {
    const hash = out.indexOf('#', query);
    out = redactSensitivePairs(out, query + 1, hash >= 0 ? hash : out.length);
  }

  const fragment = out.indexOf('#');
  if (fragment >= 0) {
    out = redactSensitivePairs(out, fragment + 1, out.length);
  }

  return redactShapes(out, options);
}
