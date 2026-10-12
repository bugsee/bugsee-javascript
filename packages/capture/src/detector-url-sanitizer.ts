// URL normalization for detection reports (Android `DetectorUrlSanitizer` parity). A detector's text
// (summary, description, attributes, grouping label) must carry neither PII nor volatile values:
//  - the query string, fragment and `user:pass@` credentials are dropped entirely (that is where tokens
//    live, and keeping them would make every request its own issue);
//  - path segments that look like identifiers or secrets (numeric ids, UUIDs, long hex, base64/JWT-shaped
//    tokens, e-mail addresses) are templated, so `/users/42/orders/99` and `/users/7/orders/3` are one
//    endpoint and an e-mail address in a path can never reach a summary.
// Android templates only when a network filter is configured; this SDK templates ALWAYS, because the
// default-sanitized timeline is not what a detector reads (it sees the raw event) and a templated path is
// also what makes grouping useful. Recorded under "Kept differences" in docs/design/mobile-alignment.md.

const ALL_DIGITS = /^[0-9]+$/;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const LONG_HEX = /^[0-9a-fA-F]{16,}$/;
// base64url / JWT-shaped: at least 24 URL-safe token characters including at least one digit (the digit
// separates real tokens from long all-letter slugs such as `the-quick-brown-fox-jumps`).
const TOKENISH = /^[A-Za-z0-9._~-]{24,}$/;
const HAS_DIGIT = /[0-9]/;

function looksLikeEmail(segment: string): boolean {
  const at = segment.indexOf('@');
  if (at <= 0 || at >= segment.length - 1) {
    return false;
  }
  // A dot in the domain part, not adjacent to '@' or the end.
  const dot = segment.indexOf('.', at + 2);
  return dot > 0 && dot < segment.length - 1;
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** One path segment, templated when it looks like an identifier or a secret; otherwise unchanged. */
export function templatePathSegment(segment: string): string {
  if (segment === '') {
    return segment;
  }
  // `%40` is how an e-mail address is usually encoded into a path.
  if (looksLikeEmail(segment) || looksLikeEmail(safeDecode(segment))) {
    return '{email}';
  }
  if (ALL_DIGITS.test(segment)) {
    return '{id}';
  }
  if (UUID.test(segment)) {
    return '{uuid}';
  }
  if (LONG_HEX.test(segment)) {
    return '{hex}';
  }
  if (TOKENISH.test(segment) && HAS_DIGIT.test(segment)) {
    return '{token}';
  }
  return segment;
}

/** `scheme://host/path` with credentials, query and fragment removed and identifier segments templated. */
export function sanitizeDetectorUrl(raw: string): string {
  if (raw === '') {
    return '';
  }
  const noQuery = raw.split(/[?#]/)[0] ?? '';
  const authority = /^([a-z][a-z0-9+.-]*:\/\/)(?:[^/]*@)?([^/]*)(.*)$/i.exec(noQuery);
  const prefix = authority === null ? '' : `${authority[1]}${authority[2]}`;
  const path = authority === null ? noQuery : (authority[3] ?? '');
  return prefix + path.split('/').map(templatePathSegment).join('/');
}
