import { REDACTED } from './sensitive';

// Shape-based value redaction (design §8.10): a second pass that redacts values matching known
// secret shapes regardless of key name. Applied to network values, error messages, and stack text.

export interface ShapeRedactionOptions {
  /** Redact Luhn-valid 12-19 digit numbers as credit cards. Off by default (false positives). */
  creditCards?: boolean;
}

const SHAPE_PATTERNS: readonly RegExp[] = [
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, // JWT
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

/**
 * Above this length the pattern scan is skipped.
 *
 * The JWT pattern backtracks per `eyJ` occurrence, and several inputs here have no size limit of their own
 * — a URL, an error message, a header value. Measured 7.7 s on 200 KB of `eyJ`-dense input, synchronously,
 * on the application's own thread inside the interceptor. The bound sits HERE rather than at one call site,
 * because a previous fix capped only `sanitizeUrl` and left bodies and headers unbounded. It is far above
 * any legitimate value, and structural (key-based) redaction is unaffected by it.
 */
const MAX_SHAPE_SCAN = 32_768;

/** Redacts values matching known secret shapes (JWT, AWS, Stripe, GitHub; opt-in credit cards). */
export function redactShapes(value: string, options?: ShapeRedactionOptions): string {
  if (value.length > MAX_SHAPE_SCAN) {
    return value;
  }
  let out = value;
  for (const pattern of SHAPE_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  if (options?.creditCards) {
    out = redactCreditCards(out);
  }
  return out;
}
