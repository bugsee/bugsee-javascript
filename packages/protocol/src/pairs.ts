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
    const pairEnd = nextSeparator(input, pos, end);
    const eq = input.indexOf('=', pos);
    const nameEnd = eq >= 0 && eq < pairEnd ? eq : pairEnd;

    if (isSensitiveKey(decodeKey(input.slice(pos, nameEnd)))) {
      out ??= '';
      out += `${input.slice(copyFrom, nameEnd)}=${REDACTED_URL_ENCODED}`;
      copyFrom = pairEnd;
    } else if (nameEnd < pairEnd) {
      // A NON-sensitive key can still carry a whole URL as its value — the OAuth `redirect_uri` / `next` /
      // `returnTo` shape, usually percent-encoded. Scan one level into it so `?next=https%3A…%3Ftoken%3DX`
      // does not sail through because the outer key is innocuous.
      const redacted = redactNestedValue(input.slice(nameEnd + 1, pairEnd));
      if (redacted !== undefined) {
        out ??= '';
        out += `${input.slice(copyFrom, nameEnd + 1)}${redacted}`;
        copyFrom = pairEnd;
      }
    }
    pos = pairEnd + 1;
  }

  return out === undefined ? input : out + input.slice(copyFrom);
}

/** `&` or the legacy `;` separator (PHP's configurable `arg_separator`, the old CGI/HTML form). */
function nextSeparator(input: string, from: number, end: number): number {
  const amp = input.indexOf('&', from);
  const semi = input.indexOf(';', from);
  let best = end;
  if (amp >= 0 && amp < best) best = amp;
  if (semi >= 0 && semi < best) best = semi;
  return best;
}

/**
 * Redact one level into a parameter VALUE that itself carries query pairs. Returns the rewritten value, or
 * undefined when nothing changed (so the caller keeps the original bytes). Bounded to one level: a nested
 * value is decoded at most once, so this cannot recurse on hostile input.
 */
function redactNestedValue(value: string): string | undefined {
  if (value === '') {
    return undefined;
  }
  const decoded = decodeKey(value); // guarded decode; returns the raw value on a malformed escape
  const query = decoded.indexOf('?');
  if (query < 0 || query >= decoded.length - 1) {
    return undefined;
  }
  const scanned = redactSensitivePairs(decoded, query + 1, decoded.length);
  if (scanned === decoded) {
    return undefined;
  }
  // Re-encode only when we decoded something, so an already-plain nested URL keeps its shape.
  return decoded === value ? scanned : encodeURIComponent(scanned);
}
