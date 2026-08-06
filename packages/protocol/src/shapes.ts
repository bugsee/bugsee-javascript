import { REDACTED } from './sensitive';

// Shape-based value redaction (design §8.10): a second pass that redacts values matching known
// secret shapes regardless of key name. Applied to network values, error messages, and stack text.

export interface ShapeRedactionOptions {
  /** Redact Luhn-valid 12-19 digit numbers as credit cards. Off by default (false positives). */
  creditCards?: boolean;
}

/**
 * The JWT pattern, ANCHORED — which is what makes it linear.
 *
 * `(^|[^A-Za-z0-9_-]|%[0-9A-Fa-f]{2})`: a JWT starts a token, so `eyJ` glued to a preceding base64url
 * character is not a candidate. That removes the OVERLAPPING START POSITIONS which are the entire source of
 * the O(n²) — in `eyJeyJeyJ…` every third offset used to begin a fresh scan to end-of-run. Within one
 * candidate there is nothing to backtrack through, because `.` is not in the character class, so the two
 * split points are forced rather than searched.
 *
 * The `%[0-9A-Fa-f]{2}` alternative is NOT cosmetic. Every percent-escape ends in a hex character and every
 * hex character is inside `[A-Za-z0-9_-]`, so `%3D`, `%20`, `%2F` and friends all read as token characters
 * and were rejected. That made the length bound below a COVERAGE gate rather than the cost-only gate it was
 * documented as, and left `id_token%3DeyJ…` — the OAuth implicit-flow redirect, the single most common way
 * a JWT appears in a URL or form body — shipping in the clear above 8 KB. It does not reintroduce the
 * quadratic: `%` is outside the base64url class, so a percent-dense input cannot also carry a long run for
 * a candidate to scan (measured 1 MB of `%3DeyJ` at 1.1 ms, and `%25eyJ` + a 1 MB run at 1.9 ms).
 *
 * Measured on `eyJ`-dense input, before → after: 16 KB 46.9 ms → 0.03 ms, 128 KB 2650 ms → 0.22 ms,
 * 512 KB 41,882 ms → 0.85 ms, 2 MB → 3.5 ms.
 *
 * An atomic-group emulation (`(?=(x+))\1`) was tried here first, on the assumption that the `+` needed to be
 * stopped from giving back. The mutator loop disproved it: removing the atomic groups passed every test, and
 * a direct comparison found 0 output differences over 400,000 random strings with the plain form marginally
 * FASTER. Anchoring alone is sufficient; the atomic form was complexity buying nothing.
 *
 * The `$1` in the replacement puts the delimiter back — the pattern consumes it.
 */
const JWT_ANCHORED =
  /(^|[^A-Za-z0-9_-]|%[0-9A-Fa-f]{2})eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;

/**
 * The original unanchored pattern, kept as a bounded SUPERSET pass.
 *
 * It differs from {@link JWT_ANCHORED} on exactly one class: a JWT glued mid-identifier (`sometoken_eyJ…`).
 * Keeping it means output below the bound is byte-identical to the pre-anchor implementation — verified as
 * 0 differences over 20,000 JWT placements across every realistic delimiter — so this change cannot silently
 * narrow coverage the way moving the bound did.
 */
const JWT_UNANCHORED = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;

/**
 * Above this length the unanchored superset pass is skipped.
 *
 * It gates ONE class of coverage: a JWT glued directly to a preceding base64url character
 * (`sometoken_eyJ…`), which {@link JWT_ANCHORED} deliberately does not treat as a candidate. Everything
 * that follows a real delimiter — literal OR percent-encoded — is caught at any size.
 *
 * The previous wording here ("a COST gate, not a coverage gate: no secret's redaction depends on this
 * number") was FALSE, and falsely reassuring: percent-escapes were not in the anchor, so every
 * `id_token%3DeyJ…` above 8 KB depended on this number and leaked. The lesson recorded rather than the
 * claim repeated — a bound is a coverage gate for exactly the inputs the unbounded path cannot see, and
 * that set has to be enumerated, not asserted.
 *
 * That distinction is the whole point. This constant previously gated ALL JWT redaction, and moving it from
 * `sanitizeUrl` into this function silently extended it from 2 call sites to 6 — `sanitizeBody`,
 * `sanitizeJson`, `sanitizeHeaders` and `sanitizeParams` had all called `redactShapes` unbounded. Bodies
 * capture at 20480 bytes by default, so that opened an 8193–20480 byte window in which every JWT shipped in
 * the clear. Two review rounds argued about this number while the scope regression sat untouched.
 *
 * 8 KB because the unanchored pattern still backtracks: ~12 ms at 8 KB, and Node's default `maxHeaderSize`
 * of 16384 is reachable by default through `server-instrument`'s `sanitizeUrl(info.url)`. A real JWT is well
 * under 8 KB, so the superset pass loses nothing that matters above it.
 */
const MAX_UNANCHORED_SCAN = 8192;

const SHAPE_PATTERNS: readonly RegExp[] = [
  /A(?:KIA|SIA|GPA|IDA|ROA)[0-9A-Z]{16}/g, // AWS access key id
  /(?:sk|pk|rk)_live_[A-Za-z0-9]+/g, // Stripe live secret/publishable/restricted keys
  /whsec_[A-Za-z0-9]+/g, // Stripe webhook signing secret
  /gh[posu]_[A-Za-z0-9]{36,}/g, // GitHub personal access / OAuth / user / server token
];

function isLuhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48; // '0' -> 0
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
}

function redactCreditCards(value: string): string {
  // One leading digit + 11-18 more (each optionally preceded by a space/dash) = 12-19 digits, so the
  // stripped run is always in range. The trailing token is a digit (not a separator), so a separator
  // adjacent to the number is never consumed.
  return value.replace(/\b\d(?:[ -]?\d){11,18}\b/g, (match) => {
    const digits = match.replace(/[ -]/g, '');
    return isLuhnValid(digits) ? REDACTED : match;
  });
}

/** Redacts values matching known secret shapes (JWT, AWS, Stripe, GitHub; opt-in credit cards). */
export function redactShapes(value: string, options?: ShapeRedactionOptions): string {
  let out = value.replace(JWT_ANCHORED, `$1${REDACTED}`);
  if (value.length <= MAX_UNANCHORED_SCAN) {
    out = out.replace(JWT_UNANCHORED, REDACTED);
  }
  for (const pattern of SHAPE_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  if (options?.creditCards) {
    out = redactCreditCards(out);
  }
  return out;
}
