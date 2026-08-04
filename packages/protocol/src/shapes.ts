import { REDACTED } from './sensitive';

// Shape-based value redaction (design §8.10): a second pass that redacts values matching known
// secret shapes regardless of key name. Applied to network values, error messages, and stack text.

export interface ShapeRedactionOptions {
  /** Redact Luhn-valid 12-19 digit numbers as credit cards. Off by default (false positives). */
  creditCards?: boolean;
}

/**
 * The JWT pattern, held separately because it is the ONLY superlinear one.
 *
 * Measured on `eyJ`-dense input: 16 KB = 50 ms, 64 KB = 786 ms, 256 KB = 14 s, 512 KB = 58 s — clean O(n²)
 * from backtracking between the two dots. Every other pattern below is sub-millisecond on the same
 * adversarial input, so bounding the whole set (as a previous version did) threw away real coverage to
 * contain one regex: 7 of 7 probed >32 KB secrets — AWS keys and Stripe tokens included — stopped being
 * redacted. The bound applies to this pattern alone.
 */
const JWT_PATTERN = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;

/**
 * Above this length the JWT scan is skipped.
 *
 * 8 KB, not 32 KB. Moving the bound from `sanitizeUrl` into this function silently RAISED it from 8192 and
 * so widened the reachable DoS window by 4×: a 16 KB `eyJ`-dense URL cost 38 ms of synchronous app-thread
 * CPU, and Node's default `maxHeaderSize` of 16384 lands exactly inside that window — reachable by default
 * through `server-instrument`'s `sanitizeUrl(info.url)` on every inbound request. 100 crafted requests
 * measured 4 s of CPU. A real JWT is well under 8 KB.
 */
const MAX_JWT_SCAN = 8192;

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
  let out = value.length > MAX_JWT_SCAN ? value : value.replace(JWT_PATTERN, REDACTED);
  for (const pattern of SHAPE_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  if (options?.creditCards) {
    out = redactCreditCards(out);
  }
  return out;
}
