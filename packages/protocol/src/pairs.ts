import { isSensitiveKey, REDACTED_URL_ENCODED } from './sensitive';

// The shared `key=value&key=value` scanner (design §8.10; Android
// `NetworkDataSanitizer.redactSensitivePairs` parity). ONE implementation serves both places the shape
// occurs — a URL query string and a form-urlencoded body — so the two can never drift apart on which
// keys count as sensitive or what the replacement token is.
//
// Deliberately a STRING scan, not parse-and-reserialize: a URL round-tripped through a parser comes back
// with re-ordered params and re-normalised escapes, so the captured URL would stop matching what the app
// actually requested. Everything except a sensitive VALUE survives byte-for-byte.
//
// THREE RULES, each learned from a defect this file shipped:
//
//  1. NO RECURSION. A previous version scanned one level into a parameter value that itself held a query,
//     to catch the OAuth `redirect_uri` shape. It was mutually recursive with its own caller — depth = the
//     number of `?` in the value — turning a linear scan into a super-quadratic one: measured 72 ms at
//     1 KB, 2.3 s at 4 KB, 117 s at 16 KB, on the application's own thread, plus a RangeError past ~16 KB
//     that escaped into the app. It was REMOTELY reachable through `req.url`, with incoming-server
//     instrumentation on by default — a denial of service from one crafted GET. Nested URLs are not
//     handled here; that is a deliberate gap, not an oversight.
//
//  2. ONLY SEGMENTS THAT CARRY `=` ARE TOUCHED. Normalising a valueless `?token` to `token=<redacted>`
//     also meant a `;`-delimited value list (`?tags=running;shipping;food`) had its fragments read as
//     keys — and because key matching is by SUBSTRING, `shipping` contains `pin`, so the scanner INVENTED
//     an `=` and a redaction marker where the source had neither. A report must never assert that a
//     credential existed.
//
//  3. THE DECISION IS PER SEGMENT. Whether one segment is redactable says nothing about its neighbours.

/**
 * Body separators additionally include newlines and commas.
 *
 * Not because `.env` or CSV are forms, but because a segment is the unit of damage: without them a whole
 * `AUTH_MODE=basic\nDB_HOST=…\nDB_PORT=…` file is ONE segment whose key (`AUTH_MODE`) is form-shaped and
 * matches `auth`, so everything after the first `=` was replaced. Splitting on them keeps a mis-read
 * confined to one line or one comma-separated field. (`protein=12g,carbs=30g` hit the same wall: `protein`
 * contains `ein`.) Commas are NOT separators on the URL path, where they are ordinary value characters.
 */
const BODY_SEPARATORS = /[&;\n\r,]/;

/** Decode a percent-encoded key for matching. Malformed escapes are common in the wild and
 *  `decodeURIComponent` throws on them — a URL we merely observed must never break capture. */
function decodeKey(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * Redact the values of sensitive keys in the `key=value…` sequence spanning `[start, end)`.
 *
 * Everything else — including the whole region past `end` (e.g. a URL fragment) — is copied verbatim.
 * Returns the ORIGINAL string when nothing sensitive was found. Linear in the input length, no recursion,
 * and it never throws.
 *
 * ONE pass finds the segment end and the segment's first `=` together. The previous version searched twice —
 * `slice(pos, end).search(SEPARATORS)` for the separator and `indexOf('=', pos)` for the equals — and the
 * second search was NOT bounded by `end`. On a run of separators carrying no `=`, every iteration therefore
 * rescanned to end-of-string: 84 ms at 100 K, 1339 ms at 400 K, 8158 ms at 1 M. That is quadratic, remotely
 * reachable through `sanitizeUrl(event.url)` (no length cap), and it sat under a comment asserting linearity
 * through two review rounds — including the rewrite whose stated purpose was removing a DoS from this file.
 * The single pass is also faster on ordinary queries (18.7 ms → 13.7 ms on a 977 KB query string).
 */
export function redactSensitivePairs(input: string, start: number, end: number): string {
  let out: string | undefined;
  let copyFrom = 0;
  // Clamp into the string. `pos = pairEnd + 1` does not advance when `pairEnd` is -Infinity, so an
  // out-of-range `start` spun forever. A SYNCHRONOUS infinite loop is unrecoverable — it wedged the test
  // runner through `--testTimeout`, and in the capture path it would hang the host application with no
  // watchdog able to interrupt it. NaN falls out through the `pos < end` comparison, which is false.
  let pos = Math.max(0, start);
  const stop = Math.min(input.length, end);

  while (pos < stop) {
    let eq = -1;
    let pairEnd = pos;
    for (; pairEnd < stop; pairEnd += 1) {
      const c = input[pairEnd];
      if (c === '&' || c === ';') {
        break; // SEPARATORS, spelled out so the scan stays a single character walk
      }
      if (eq < 0 && c === '=') {
        eq = pairEnd;
      }
    }

    // Rule 2: a segment carrying no `=` is not a key/value pair, so it is left exactly as it is.
    if (eq >= 0 && isSensitiveKey(decodeKey(input.slice(pos, eq)))) {
      out ??= '';
      out += `${input.slice(copyFrom, eq)}=${REDACTED_URL_ENCODED}`;
      copyFrom = pairEnd;
    }
    pos = pairEnd + 1;
  }

  return out === undefined ? input : out + input.slice(copyFrom);
}

/** A urlencoded parameter NAME: the RFC 3986 unreserved/sub-delim set plus `%`, `[`/`]` (PHP arrays) and
 *  `+`. Deliberately excludes whitespace, quotes and angle brackets — the characters that mark prose or
 *  markup rather than a form field. */
const FORM_KEY = /^[A-Za-z0-9_.~!$'()*+,:@\-[\]%]+$/;

/**
 * Is this ONE segment shaped like a form field — `key=value` with a plausible key?
 *
 * Judged per segment, never for the body as a whole. A whole-body verdict failed OPEN in both directions:
 * requiring EVERY segment to conform meant one odd key (`contraseña=x`, `a/b=1`, an unencoded `&` inside a
 * value) skipped the entire body and shipped a real `password=hunter2` in the clear; requiring none meant
 * prose containing an `=` was read as a form and everything after the first `=` was destroyed.
 */
export function isFormSegment(segment: string): boolean {
  const eq = segment.indexOf('=');
  if (eq <= 0) {
    return false;
  }
  // Trim the wrapping a real key never carries but a quoted or spaced one does. Without this the gate was
  // applied to the SENSITIVE segment's own key, so ` password=hunter2`, `"password"=hunter2` and
  // `user.password =hunter2` shipped verbatim — the neighbour's shape no longer mattered, but the segment's
  // own still did, in the leak direction. Inner punctuation (`<config auth`, `my password`) is still
  // rejected: that is prose, and reading it as a key is what destroyed bodies in the first place.
  const key = segment
    .slice(0, eq)
    .trim()
    .replace(/^["']|["']$/g, '');
  return FORM_KEY.test(key);
}

/**
 * Redact sensitive values in a form-urlencoded body, segment by segment.
 *
 * A segment that does not look like a form field is copied verbatim; a segment that does is scanned. So a
 * `.env` file, a SQL statement or an HTML fragment keeps every byte — including the newline-separated and
 * comma-separated forms an earlier whole-body guard still destroyed — while `username=bob&password=x` is
 * redacted even when a neighbouring segment is unparseable.
 */
export function redactFormBody(body: string): string {
  if (!body.includes('=')) {
    return body;
  }
  let out = '';
  let changed = false;
  let pos = 0;
  for (;;) {
    const sepOffset = body.slice(pos).search(BODY_SEPARATORS);
    const segEnd = sepOffset === -1 ? body.length : pos + sepOffset;
    const segment = body.slice(pos, segEnd);
    if (isFormSegment(segment)) {
      const redacted = redactSensitivePairs(segment, 0, segment.length);
      changed ||= redacted !== segment;
      out += redacted;
    } else {
      out += segment;
    }
    if (segEnd >= body.length) {
      break;
    }
    out += body[segEnd]; // the separator itself, byte-for-byte
    pos = segEnd + 1;
  }
  return changed ? out : body;
}
