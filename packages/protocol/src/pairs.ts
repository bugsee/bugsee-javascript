import { isSensitiveKey, REDACTED_URL_ENCODED } from './sensitive';

// The shared `key=value&key=value` scanner (design §8.10; Android
// `NetworkDataSanitizer.redactSensitivePairs` parity). ONE implementation serves both places the shape
// occurs — a URL query string and a form-urlencoded body — so the two can never drift apart on which
// keys count as sensitive or what the replacement token is.
//
// Deliberately a STRING scan, not parse-and-reserialize: a URL round-tripped through a parser comes back
// with re-ordered params and re-normalised escapes, so the captured URL would stop matching what the app
// actually requested. Everything except a sensitive VALUE survives byte-for-byte.

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
 * Redact the values of sensitive keys in the `key=value&…` sequence spanning `[start, end)`.
 *
 * Everything else — including the whole region past `end` (e.g. a URL fragment) — is copied verbatim.
 * Returns the ORIGINAL string instance when nothing sensitive was found, so the common case allocates
 * nothing. A sensitive key with no `=` is normalised to `key=<redacted>`: dropping the marker would hide
 * that a credential was present at all.
 */
export function redactSensitivePairs(input: string, start: number, end: number): string {
  let out: string | undefined;
  let copyFrom = 0;
  let pos = start;

  while (pos < end) {
    const amp = input.indexOf('&', pos);
    const pairEnd = amp >= 0 && amp < end ? amp : end;
    const eq = input.indexOf('=', pos);
    const nameEnd = eq >= 0 && eq < pairEnd ? eq : pairEnd;

    if (isSensitiveKey(decodeKey(input.slice(pos, nameEnd)))) {
      out ??= '';
      out += `${input.slice(copyFrom, nameEnd)}=${REDACTED_URL_ENCODED}`;
      copyFrom = pairEnd;
    }
    pos = pairEnd + 1;
  }

  return out === undefined ? input : out + input.slice(copyFrom);
}
