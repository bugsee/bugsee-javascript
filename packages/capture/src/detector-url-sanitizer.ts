// URL normalization for detection reports (Android `DetectorUrlSanitizer` parity). A detector's text
// (summary, description, attributes, grouping label) must carry neither PII nor volatile values:
//  - the query string, fragment and `user:pass@` credentials are dropped entirely (that is where tokens
//    live, and keeping them would make every request its own issue);
//  - path segments that look like identifiers or secrets (numeric ids, UUIDs, long hex, base64/JWT-shaped
//    tokens, e-mail addresses, short ids, phone numbers, card numbers, IPs, dates) are templated, so `/users/42/orders/99` and `/users/7/orders/3` are one
//    endpoint and an e-mail address in a path can never reach a summary.
// Android templates only when a network filter is configured; this SDK templates ALWAYS, because the
// default-sanitized timeline is not what a detector reads (it sees the raw event) and a templated path is
// also what makes grouping useful. Recorded under "Kept differences" in docs/design/mobile-alignment.md.

const ALL_DIGITS = /^[0-9]+$/;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
// Either case: a SHA-1/256 digest or a Mongo id is as often upper-case as lower.
const LONG_HEX = /^[0-9a-fA-F]{16,}$/;
// base64url / JWT-shaped: at least 24 URL-safe token characters including at least one number (the number
// separates real tokens from long all-letter slugs such as `the-quick-brown-fox-jumps`).
const TOKENISH = /^[A-Za-z0-9._~-]{24,}$/;
const HAS_NUMBER = /[0-9]/;
// A mixed-case alphanumeric id of the fixed lengths the common generators emit: nanoid (21), Firebase push
// ids (20). `_` and `-` are in their alphabets.
const SHORT_ID = /^[A-Za-z0-9_-]{20,21}$/;
const HAS_UPPER = /[A-Z]/;
const HAS_LOWER = /[a-z]/;
const IPV4 = /^[0-9]{1,3}(?:\.[0-9]{1,3}){3}$/;
const IPV6_CHARS = /^[0-9a-fA-F:]+$/;
// ISO-8601 date, optionally with a time and zone: 2024-01-15, 2024-01-15T10:20:30.123Z, ...+02:00.
const ISO_DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}(?:[T ][0-9:.]+(?:Z|[+-][0-9]{2}:?[0-9]{2})?)?$/;
// A prefix (one short alphanumeric word) + `_`/`-` + 3 or more numbers: `ord_12345`, `user-9981`.
const PREFIX_HEAD = /^[A-Za-z][A-Za-z0-9]{0,15}$/;
const PREFIXED_ID_MIN_LENGTH = 3;
const FILE_EXTENSION = /^\.[A-Za-z][A-Za-z0-9]{0,4}$/;
// Word-like pieces of an identifier: a Title-cased word (`Details`, `Csv`) or a lower-case word of 3+ letters.
const WORD_PIECE = /[A-Z][a-z]{2,}|[a-z]{3,}/g;
// How much of a 16+ character segment must be made of such words before it is an identifier (`getUserDetailsV2`,
// `HTML5VideoPlayer2`) and not a random token (R4V-5). Measured with seeded random base64url tokens: a 22-character
// (128-bit) token is kept as a word in ~0.07% of cases and a 16-21 character one in well under 1% (the unavoidable
// price of not collapsing every camelCase route name; no dictionary is used).
const WORD_COVERAGE = 0.6;
const WORD_COVERAGE_LONG = 0.75; // 22 characters and up: where a 128-bit random token lives
const WORD_COVERAGE_LONG_FROM = 22;
const WORD_MIN_PIECES = 2; // words of 4+ characters
const WORD_MIN_LONGEST = 6;
const MID_DIGIT_WORD_MAX = 8; // `v1beta1`, `covid19x2`: the longest slug word with a number inside it
const WORD_MAX_STRAY_LOWER = 1; // lower-case letters outside any word (`gpt4oMini`: the `o`)
// A payment card number: 13-19 digits (Maestro to the longest PAN) with `-` or ` ` between the groups.
const CARD_MIN_LENGTH = 13;
const CARD_MAX_LENGTH = 19;
// Random tokens shorter than the 24-character floor above (base64url of 12-17 bytes): 16-23 characters.
const SHORT_TOKEN_MIN_LENGTH = 16;
const SHORT_TOKEN_MAX_LENGTH = 23;
const SHORT_TOKEN_CHARS = /^[A-Za-z0-9._~-]+$/; // the length is bounded separately, above
// A host with no dot (`localhost`, an intranet name): at least two characters, letters/numbers/hyphens.
const HOST_LABEL = /^[A-Za-z0-9][A-Za-z0-9-]+$/;
const PHONE_MIN_LENGTH = 7;
const PHONE_MAX_LENGTH = 15;
/** No real identifier is this long; a longer segment is a blob (and was never going to be a readable slug). */
const MAX_SEGMENT_LENGTH = 256;

/** npm/CDN dist-tags: `react@latest` is a package spec, not an address (R4V-6). */
const DIST_TAGS = new Set([
  'latest',
  'next',
  'beta',
  'alpha',
  'canary',
  'rc',
  'nightly',
  'stable',
  'experimental',
]);

function looksLikeEmail(segment: string): boolean {
  // The LAST `@` splits local part from host: `@alice@example.com` and `a@b@example.com` are addresses too (R4V-6).
  const at = segment.lastIndexOf('@');
  if (at <= 0 || at >= segment.length - 1) {
    return false;
  }
  // A dot in the domain part, not adjacent to '@' or the end.
  const dot = segment.indexOf('.', at + 2);
  if (dot > 0 && dot < segment.length - 1) {
    return true;
  }
  // Or a dot-less host (`user@localhost`): still an address (R3V-4). One character is not a host (`a@b`), and a
  // dist-tag is a package version, not a host.
  const host = segment.slice(at + 1);
  return HOST_LABEL.test(host) && !DIST_TAGS.has(host.toLowerCase());
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * A slug word: one or two numbers on their own, up to FOUR digits (`2024`, `8859`), or letters with at most two
 * separate runs of one or two numbers (`v2`, `covid19`, `q3`), in one case or Title-cased (`Guide`; never `tnLeEum`). A number BETWEEN letters (`v1beta1`) is only a
 * version marker when the word is short and single-case: `V1StGXR8` and `eyJhbGciOiJIUzI1NiJ9` are token pieces.
 * Linear, no regex.
 */
function isSlugWord(word: string): boolean {
  let digitRuns = 0;
  let upper = 0;
  let lower = 0;
  let run = 0;
  let midDigits = false; // a number that is followed by more letters
  for (let i = 0; i < word.length; i += 1) {
    const code = word.charCodeAt(i);
    if (code >= 48 && code <= 57) {
      run += 1;
      if (run === 1) {
        digitRuns += 1;
      }
      if (run > 2 && !(upper + lower === 0 && run <= 4)) {
        return false;
      }
    } else if (code >= 65 && code <= 90) {
      if (lower > 0) {
        return false; // an internal capital (`tnLeEumGJ`) is camelCase or random, never a slug word
      }
      upper += 1;
      midDigits = midDigits || run > 0;
      run = 0;
    } else if (code >= 97 && code <= 122) {
      lower += 1;
      midDigits = midDigits || run > 0;
      run = 0;
    } else {
      return false;
    }
  }
  if (digitRuns > 2) {
    return false;
  }
  return !midDigits || (word.length <= MID_DIGIT_WORD_MAX && (upper === 0 || lower === 0));
}

/** Three or more plain words (`quick-start-guide-2`): a readable slug, never an id. */
function isSlugLike(segment: string): boolean {
  let words = 0;
  for (const word of segment.split(/[-_.]/)) {
    if (word === '') {
      continue;
    }
    if (!isSlugWord(word)) {
      return false;
    }
    words += 1;
  }
  return words >= 3;
}

/**
 * Whether a segment READS as an identifier made of words (`getUserDetailsV2`, `HTML5VideoPlayer2`,
 * `Chapter12Section3`, `gpt4oMiniPreview`) rather than a random token (R4V-5). A random base64url string has
 * short, case-flipping runs; an identifier is mostly Title/lower-case words of 3+ letters with only digits or an
 * acronym between them. Requires: enough of the segment covered by such words, two or more words of 4+
 * characters, one of 6+, and at most one stray lower-case letter outside the words. Linear.
 */
function looksLikeWords(segment: string): boolean {
  let covered = 0;
  let words = 0;
  let longest = 0;
  let last = 0;
  let stray = 0;
  const strayLower = (from: number, to: number): void => {
    for (let i = from; i < to; i += 1) {
      const code = segment.charCodeAt(i);
      if (code >= 97 && code <= 122) {
        stray += 1;
      }
    }
  };
  for (const match of segment.matchAll(WORD_PIECE)) {
    const length = match[0].length;
    covered += length;
    words += length >= 4 ? 1 : 0;
    longest = Math.max(longest, length);
    strayLower(last, match.index);
    last = match.index + length;
  }
  strayLower(last, segment.length);
  const coverage = segment.length >= WORD_COVERAGE_LONG_FROM ? WORD_COVERAGE_LONG : WORD_COVERAGE;
  return (
    covered >= coverage * segment.length &&
    words >= WORD_MIN_PIECES &&
    longest >= WORD_MIN_LONGEST &&
    stray <= WORD_MAX_STRAY_LOWER
  );
}

/** A phone number: optional leading `+`, then 7 to 15 numbers with `()-. ` separators. Linear, no regex. */
function looksLikePhone(segment: string): boolean {
  let count = 0;
  for (let i = 0; i < segment.length; i += 1) {
    const code = segment.charCodeAt(i);
    if (code >= 48 && code <= 57) {
      count += 1;
      if (count > PHONE_MAX_LENGTH) {
        return false;
      }
      continue;
    }
    // `+` only as the first character; the usual separators anywhere.
    if (!(code === 43 ? i === 0 : ' ()-.'.includes(segment.charAt(i)))) {
      return false;
    }
  }
  return count >= PHONE_MIN_LENGTH;
}

/** A card number: 13-19 digits with only `-` / ` ` separators (no `+`, brackets or dots). Linear, no regex. */
function looksLikeCard(segment: string): boolean {
  let count = 0;
  for (let i = 0; i < segment.length; i += 1) {
    const code = segment.charCodeAt(i);
    if (code >= 48 && code <= 57) {
      count += 1;
      if (count > CARD_MAX_LENGTH) {
        return false;
      }
    } else if (code !== 45 && code !== 32) {
      return false;
    }
  }
  return count >= CARD_MIN_LENGTH;
}

/** The number of separate runs of digits in a segment: `k3j4` has two, `2015` has one. Linear. */
function digitRuns(segment: string): number {
  let runs = 0;
  let inRun = false;
  for (let i = 0; i < segment.length; i += 1) {
    const code = segment.charCodeAt(i);
    const isDigit = code >= 48 && code <= 57;
    if (isDigit && !inRun) {
      runs += 1;
    }
    inRun = isDigit;
  }
  return runs;
}

function looksLikeIp(segment: string): boolean {
  if (IPV4.test(segment)) {
    return true;
  }
  // IPv6: hex groups, with `::` compression or all eight groups. (A bare `10:20:30` is a time, not an IP.)
  return IPV6_CHARS.test(segment) && (segment.includes('::') || segment.split(':').length === 8);
}

/** One path segment, templated when it looks like an identifier or a secret; otherwise unchanged. */
export function templatePathSegment(segment: string): string {
  if (segment === '') {
    return segment;
  }
  if (segment.length > MAX_SEGMENT_LENGTH) {
    return '{token}';
  }
  // `%40` is how an e-mail address is usually encoded into a path; a phone number's space is `%20`.
  const decoded = segment.includes('%') ? safeDecode(segment) : segment;
  if (looksLikeEmail(segment) || looksLikeEmail(decoded)) {
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
  if (ISO_DATE.test(decoded)) {
    return '{date}';
  }
  if (looksLikeIp(segment)) {
    return '{ip}';
  }
  if (looksLikeCard(decoded)) {
    return '{card}';
  }
  if (looksLikePhone(decoded)) {
    return '{phone}';
  }
  // `42.json`, `<uuid>.png`: template the stem and keep the extension, so the file type still groups.
  const dot = segment.lastIndexOf('.');
  if (dot > 0 && FILE_EXTENSION.test(segment.slice(dot))) {
    const stem = templatePathSegment(segment.slice(0, dot));
    if (stem !== segment.slice(0, dot)) {
      return `${stem}${segment.slice(dot)}`;
    }
  }
  // `ord_12345`: keep the one-word prefix, template the number.
  const sep = Math.max(segment.lastIndexOf('_'), segment.lastIndexOf('-'));
  if (sep > 0) {
    const tail = segment.slice(sep + 1);
    if (
      tail.length >= PREFIXED_ID_MIN_LENGTH &&
      ALL_DIGITS.test(tail) &&
      PREFIX_HEAD.test(segment.slice(0, sep))
    ) {
      return `${segment.slice(0, sep + 1)}{id}`;
    }
  }
  if (
    TOKENISH.test(segment) &&
    HAS_NUMBER.test(segment) &&
    !isSlugLike(segment) &&
    !looksLikeWords(segment)
  ) {
    return '{token}';
  }
  if (
    SHORT_ID.test(segment) &&
    HAS_NUMBER.test(segment) &&
    HAS_UPPER.test(segment) &&
    HAS_LOWER.test(segment) &&
    !isSlugLike(segment) &&
    !looksLikeWords(segment)
  ) {
    return '{id}';
  }
  // A random token of 16-23 characters (base64url of a 12-17 byte value): mixed case with a number, or several
  // separate number runs. Ordinary words, `authentication-v2` and a lone year (`ecmascript2015modules`) are not.
  if (
    segment.length >= SHORT_TOKEN_MIN_LENGTH &&
    segment.length <= SHORT_TOKEN_MAX_LENGTH &&
    SHORT_TOKEN_CHARS.test(segment) &&
    HAS_NUMBER.test(segment) &&
    !isSlugLike(segment) &&
    !looksLikeWords(segment) &&
    ((HAS_UPPER.test(segment) && HAS_LOWER.test(segment)) || digitRuns(segment) >= 2)
  ) {
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
