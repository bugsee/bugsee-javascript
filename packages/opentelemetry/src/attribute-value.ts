// Complex attribute values (OpenTelemetry API 1.10 `AnyValue`, OTEP 4485).
//
// Before API 1.10 an attribute was a string, number, boolean or a homogeneous array of those. 1.10 widened
// `Attributes` to the spec's AnyValue: it now also carries nested maps, arrays of mixed values, byte arrays
// and null, and (verified against sdk-trace@3.0.0) the SDK keeps all of them on `ReadableSpan.attributes`
// while dropping bigint/Date/function/symbol/cyclic values itself. A third-party or older SDK can still hand
// us anything at all, and `onEnd` runs inside the customer's `span.end()`.
//
// DECISION (the Bugsee attribute model is flat and its redaction runs on strings):
//   - scalars, and homogeneous arrays of scalars, pass through UNCHANGED (a bigint, which JSON cannot carry,
//     becomes a number when exact and decimal text otherwise);
//   - everything else becomes ONE JSON STRING (a byte array becomes base64), bounded in depth, node count and
//     length, and never throwing;
//   - null/undefined/function/symbol have no value: the attribute is dropped.
// A string, not a nested object, because the span sanitizer/filter and the viewer all read attribute values
// as scalars: a `db.statement` that arrives as `{ text: 'SELECT ...' }` would otherwise sail past a
// string-keyed scrub. Flattening to dotted keys was rejected (key explosion, and arrays have no stable key
// form); dropping was rejected (silent data loss for the very attributes OTEP 4485 exists to carry).

/** Longest JSON text kept for one attribute value, in UTF-16 units (the marker included). */
export const MAX_ATTRIBUTE_JSON_LENGTH = 8192;
/** Deepest container nesting serialized; a deeper container is replaced by a marker. */
export const MAX_ATTRIBUTE_DEPTH = 8;
/** Most values (containers and scalars) visited per attribute before the rest is replaced by a marker. */
export const MAX_ATTRIBUTE_NODES = 1024;
/** Longest homogeneous scalar array passed through unchanged; a longer one goes the JSON (bounded) route. */
export const MAX_ATTRIBUTE_ARRAY_LENGTH = 1024;
/** Appended when the JSON text had to be cut. */
export const TRUNCATION_MARKER = '...[truncated]';

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** RFC 4648 base64 with padding. Hand-rolled: `btoa`/`Buffer` are runtime-specific and this package is portable. */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  const full = bytes.length - (bytes.length % 3);
  for (let i = 0; i < full; i += 3) {
    const n =
      ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8) | (bytes[i + 2] as number);
    out +=
      B64.charAt((n >> 18) & 63) +
      B64.charAt((n >> 12) & 63) +
      B64.charAt((n >> 6) & 63) +
      B64.charAt(n & 63);
  }
  const rest = bytes.length - full;
  if (rest === 1) {
    const n = (bytes[full] as number) << 16;
    out += `${B64.charAt((n >> 18) & 63)}${B64.charAt((n >> 12) & 63)}==`;
  } else if (rest === 2) {
    const n = ((bytes[full] as number) << 16) | ((bytes[full + 1] as number) << 8);
    out += `${B64.charAt((n >> 18) & 63)}${B64.charAt((n >> 12) & 63)}${B64.charAt((n >> 6) & 63)}=`;
  }
  return out;
}

/** OTLP AnyValue bytes: a `Uint8Array` (a Node `Buffer` is one). Other typed arrays are not AnyValue. */
export function isByteArray(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array;
}

const capText = (text: string): string =>
  text.length <= MAX_ATTRIBUTE_JSON_LENGTH
    ? text
    : text.slice(0, MAX_ATTRIBUTE_JSON_LENGTH - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;

/** Enough bytes that their base64 form always exceeds the text cap, so an oversize array is cut and marked. */
const MAX_BYTES_ENCODED = Math.ceil((MAX_ATTRIBUTE_JSON_LENGTH * 3) / 4) + 3;

/** Base64 of a byte array, bounded (encodes at most what could fit, then cuts with the marker). */
const boundedBase64 = (bytes: Uint8Array): string =>
  capText(
    bytesToBase64(bytes.length > MAX_BYTES_ENCODED ? bytes.subarray(0, MAX_BYTES_ENCODED) : bytes),
  );

const SKIP = Symbol('skip');

interface Budget {
  nodes: number;
}

const setOwn = (target: Record<string, unknown>, key: string, value: unknown): void => {
  // `target[key] = v` with key "__proto__" rewrites the prototype instead of adding a key.
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
};

/** Copy a value into a tree containing only JSON-safe values, within the depth/node budget. */
function toSafe(value: unknown, depth: number, budget: Budget, ancestors: Set<object>): unknown {
  if (value === null) return null;
  switch (typeof value) {
    case 'string':
      return value;
    case 'boolean':
      return value;
    case 'number':
      if (Number.isFinite(value)) return value;
      return Number.isNaN(value) ? 'NaN' : value > 0 ? 'Infinity' : '-Infinity';
    case 'bigint':
      return value.toString();
    case 'object':
      break;
    default:
      return SKIP; // undefined, function, symbol
  }
  if (isByteArray(value)) return boundedBase64(value);
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isNaN(time) ? null : new Date(time).toISOString();
  }
  if (depth >= MAX_ATTRIBUTE_DEPTH) return '[MaxDepth]';
  if (ancestors.has(value)) return '[Circular]';
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return arrayToSafe(value, depth, budget, ancestors);
    return objectToSafe(value as Record<string, unknown>, depth, budget, ancestors);
  } catch {
    return '[Unreadable]';
  } finally {
    ancestors.delete(value);
  }
}

function arrayToSafe(
  items: unknown[],
  depth: number,
  budget: Budget,
  ancestors: Set<object>,
): unknown[] {
  const out: unknown[] = [];
  budget.nodes++;
  for (let i = 0; i < items.length; i++) {
    if (budget.nodes >= MAX_ATTRIBUTE_NODES) {
      out.push('[Truncated]');
      break;
    }
    budget.nodes++;
    let item: unknown;
    try {
      item = toSafe(items[i], depth + 1, budget, ancestors);
    } catch {
      item = '[Unreadable]';
    }
    out.push(item === SKIP ? null : item);
  }
  return out;
}

function objectToSafe(
  source: Record<string, unknown>,
  depth: number,
  budget: Budget,
  ancestors: Set<object>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  budget.nodes++;
  for (const key of Object.keys(source)) {
    if (budget.nodes >= MAX_ATTRIBUTE_NODES) {
      setOwn(out, '[Truncated]', true);
      break;
    }
    budget.nodes++;
    let member: unknown;
    try {
      member = toSafe(source[key], depth + 1, budget, ancestors);
    } catch {
      member = '[Unreadable]';
    }
    if (member !== SKIP) setOwn(out, key, member);
  }
  return out;
}

/**
 * The JSON text of an AnyValue, bounded and never throwing. Byte arrays become base64, bigints decimal
 * strings, non-finite numbers the OTLP spellings; a cycle, over-deep or over-wide structure is marked, not
 * followed. Returns `undefined` when the value has no JSON form at all (undefined/function/symbol).
 */
export function stringifyAnyValue(value: unknown): string | undefined {
  let safe: unknown;
  try {
    safe = toSafe(value, 0, { nodes: 0 }, new Set());
  } catch {
    safe = '[Unreadable]';
  }
  if (safe === SKIP) return undefined;
  return capText(JSON.stringify(safe));
}

const isScalar = (v: unknown): v is string | number | boolean =>
  typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

/** A non-empty-or-empty array whose elements are all strings, all numbers or all booleans (the pre-1.10 shape). */
function isHomogeneousScalarArray(value: unknown[]): boolean {
  if (value.length > MAX_ATTRIBUTE_ARRAY_LENGTH) return false;
  if (value.length === 0) return true;
  const kind = typeof value[0];
  if (!isScalar(value[0])) return false;
  return value.every((item) => typeof item === kind);
}

/**
 * Normalize one OTel attribute value for the Bugsee attribute model (see the decision at the top of this
 * file). `undefined` means the attribute has no representation and is dropped.
 */
export function normalizeAttributeValue(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (isScalar(value)) return value;
  // A bigint is not JSON-serializable (the transaction is, later): exact as a number when safe, else decimal text.
  if (typeof value === 'bigint') {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  if (isByteArray(value)) return boundedBase64(value);
  if (Array.isArray(value) && isHomogeneousScalarArray(value)) return value;
  return stringifyAnyValue(value);
}

/**
 * Normalize an OTel attributes record: own enumerable string keys only, each value normalized, an attribute
 * whose value cannot be read (a throwing getter) skipped without losing its siblings.
 */
export function normalizeAttributes(attributes: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(attributes)) {
    try {
      const value = normalizeAttributeValue(attributes[key]);
      if (value !== undefined) setOwn(out, key, value);
    } catch {
      // unreadable attribute: skip it, keep the rest
    }
  }
  return out;
}
