// Span attribute values: bounding, safe copying and the wire flattening of complex values.
//
// Context. Before OpenTelemetry API 1.10 an attribute was a string, number, boolean or a homogeneous array of
// those. 1.10 widened `Attributes` to the spec's AnyValue (OTEP 4485): nested maps, arrays of mixed values,
// byte arrays and null. `sdk-trace@3.0.0` keeps all of those on `ReadableSpan.attributes` (and itself drops
// bigint/Date/function/symbol/cyclic values); an older or third-party SDK can hand us anything. The consume
// bridge (`@bugsee/opentelemetry`) runs inside the customer's `span.end()`, so this module is TOTAL (it never
// throws) and BOUNDED in work and in memory, not only in output size.
//
// THE PIPELINE (normalize LATE, flatten at the wire):
//   1. consume    `normalizeAttributeValue`: scalars and homogeneous scalar arrays pass through (strings
//                 capped); everything else becomes a bounded, JSON-safe COPY of the tree (maps stay maps,
//                 bytes become base64, bigint exact-or-decimal-text). It is NOT stringified here.
//   2. redaction  the span filter / default sanitizer sees the TREE, so key-based redaction works on nested
//                 keys (`user: { password }`, `http.request.headers: { authorization }`). Stringifying first
//                 would hide those keys inside text the key-based scrub cannot read.
//   3. wire       `flattenTransactionAttributes` (run by the performance extension AFTER the filter) turns any
//                 remaining complex value into one bounded JSON string, because the Bugsee attribute model
//                 and viewer read scalar attribute values. Produce-direction OTLP therefore sees strings.
// Rejected: flattening to dotted keys (key explosion, no stable form for arrays) and dropping (silent loss of
// exactly the data OTEP 4485 exists to carry).

/** Longest JSON text kept for one attribute value, in UTF-16 units (the marker included). */
export const MAX_ATTRIBUTE_JSON_LENGTH = 8192;
/** Deepest container nesting copied; a deeper container is replaced by a marker. */
export const MAX_ATTRIBUTE_DEPTH = 8;
/** Most values (containers and scalars) visited per attribute before the rest is replaced by a marker. */
export const MAX_ATTRIBUTE_NODES = 1024;
/** Longest homogeneous scalar array passed through unchanged; a longer one goes the bounded tree route. */
export const MAX_ATTRIBUTE_ARRAY_LENGTH = 1024;
/**
 * Longest scalar string attribute kept, in UTF-16 units. A scalar is passed through otherwise unchanged, but
 * an unbounded string would make the cost of `span.end()` proportional to whatever instrumentation recorded
 * (a request body, a prompt). 32 KiB keeps ordinary SQL statements and URLs whole.
 */
export const MAX_ATTRIBUTE_STRING_LENGTH = 32768;
/** Most characters of string leaves and keys copied into one tree before the rest is marked truncated. */
export const MAX_ATTRIBUTE_TREE_CHARS = 32768;
/** Appended when text had to be cut. */
export const TRUNCATION_MARKER = '...[truncated]';

/** Longest single leaf string or key in a tree (leaves a little room for the JSON around it). */
const MAX_LEAF_LENGTH = MAX_ATTRIBUTE_JSON_LENGTH - 64;

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** RFC 4648 base64 with padding. Hand-rolled: `btoa`/`Buffer` are runtime-specific and this is portable. */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  const full = bytes.length - (bytes.length % 3);
  for (let i = 0; i < full; i += 3) {
    const n =
      ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8) | (bytes[i + 2] as number);
    out += B64.charAt((n >> 18) & 63) + B64.charAt((n >> 12) & 63);
    out += B64.charAt((n >> 6) & 63) + B64.charAt(n & 63);
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

const capText = (text: string, max: number): string =>
  text.length <= max ? text : text.slice(0, max - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;

/** Enough bytes that their base64 form always exceeds the text cap, so an oversize array is cut and marked. */
const MAX_BYTES_ENCODED = Math.ceil((MAX_ATTRIBUTE_JSON_LENGTH * 3) / 4) + 3;

/** Base64 of a byte array, bounded in work (encodes at most what could fit) and in length. */
export function boundedBase64(bytes: Uint8Array): string {
  const head = bytes.length > MAX_BYTES_ENCODED ? bytes.subarray(0, MAX_BYTES_ENCODED) : bytes;
  return capText(bytesToBase64(head), MAX_ATTRIBUTE_JSON_LENGTH);
}

const SKIP = Symbol('skip');

interface Budget {
  nodes: number;
  chars: number;
}

const exhausted = (budget: Budget): boolean =>
  budget.nodes >= MAX_ATTRIBUTE_NODES || budget.chars >= MAX_ATTRIBUTE_TREE_CHARS;

const setOwn = (target: Record<string, unknown>, key: string, value: unknown): void => {
  // `target[key] = v` with key "__proto__" rewrites the prototype instead of adding a key.
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
};

/** A string leaf or key, cut at the leaf cap and counted against the tree's character budget. */
function leafText(text: string, budget: Budget): string {
  const cut = capText(text, MAX_LEAF_LENGTH);
  budget.chars += cut.length;
  return cut;
}

/** Copy a value into a tree containing only JSON-safe values, within the depth/node/character budget. */
function toSafe(value: unknown, depth: number, budget: Budget, ancestors: Set<object>): unknown {
  if (value === null) return null;
  switch (typeof value) {
    case 'string':
      return leafText(value, budget);
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
  if (isByteArray(value)) return leafText(boundedBase64(value), budget);
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isNaN(time) ? null : new Date(time).toISOString();
  }
  if (depth >= MAX_ATTRIBUTE_DEPTH) return '[MaxDepth]';
  if (ancestors.has(value)) return '[Circular]';
  ancestors.add(value);
  try {
    // A typed array that is not a byte array (Float32Array embeddings, ...) is a list of numbers; reading it
    // by index is bounded by the node budget, where Object.keys would allocate every index string.
    if (Array.isArray(value) || ArrayBuffer.isView(value)) {
      return listToSafe(value as ArrayLike<unknown>, depth, budget, ancestors);
    }
    return objectToSafe(value as Record<string, unknown>, depth, budget, ancestors);
  } catch {
    return '[Unreadable]';
  } finally {
    ancestors.delete(value);
  }
}

function listToSafe(
  items: ArrayLike<unknown>,
  depth: number,
  budget: Budget,
  ancestors: Set<object>,
): unknown[] {
  const out: unknown[] = [];
  budget.nodes++;
  for (let i = 0; i < items.length; i++) {
    if (exhausted(budget)) {
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
    if (exhausted(budget)) {
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
    if (member !== SKIP) setOwn(out, leafText(key, budget), member);
  }
  return out;
}

/**
 * A bounded, JSON-safe COPY of an AnyValue, or `undefined` when it has no representation at all
 * (undefined/function/symbol). Never throws; never follows a cycle; bytes become base64, bigint decimal text,
 * non-finite numbers the OTLP spellings, `toJSON` and other user code is never called.
 */
export function safeAnyValue(value: unknown): unknown {
  let safe: unknown;
  try {
    safe = toSafe(value, 0, { nodes: 0, chars: 0 }, new Set());
  } catch {
    safe = '[Unreadable]';
  }
  return safe === SKIP ? undefined : safe;
}

/**
 * The JSON text of an AnyValue, bounded and never throwing (see {@link safeAnyValue}). Returns `undefined`
 * when the value has no JSON form at all.
 */
export function stringifyAnyValue(value: unknown): string | undefined {
  try {
    const safe = safeAnyValue(value);
    return safe === undefined
      ? undefined
      : capText(JSON.stringify(safe), MAX_ATTRIBUTE_JSON_LENGTH);
  } catch {
    return capText('"[Unreadable]"', MAX_ATTRIBUTE_JSON_LENGTH);
  }
}

const isScalar = (v: unknown): v is string | number | boolean =>
  typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

/** An array whose elements are all strings, all numbers or all booleans (the pre-1.10 shape), and small. */
function isPassThroughArray(value: unknown[]): boolean {
  if (value.length > MAX_ATTRIBUTE_ARRAY_LENGTH) return false;
  if (value.length === 0) return true;
  const kind = typeof value[0];
  if (!isScalar(value[0])) return false;
  let chars = 0;
  for (const item of value) {
    if (typeof item !== kind) return false;
    if (typeof item === 'string') {
      chars += item.length;
      if (chars > MAX_ATTRIBUTE_STRING_LENGTH) return false;
    }
  }
  return true;
}

/**
 * Normalize one OTel attribute value for the Bugsee attribute model (the pipeline at the top of this file).
 * Scalars pass through (a string is capped at {@link MAX_ATTRIBUTE_STRING_LENGTH}; a bigint becomes a number
 * when exact, decimal text otherwise); a small homogeneous scalar array passes through; a byte array becomes
 * base64; everything else becomes a bounded JSON-safe tree. `undefined` means no representation: the
 * attribute is dropped.
 */
export function normalizeAttributeValue(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') return capText(value, MAX_ATTRIBUTE_STRING_LENGTH);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  if (isByteArray(value)) return boundedBase64(value);
  if (Array.isArray(value) && isPassThroughArray(value)) return value;
  return safeAnyValue(value);
}

/**
 * Normalize an attributes record: own enumerable string keys only, each value normalized. One attribute that
 * cannot be read (a throwing getter) is skipped without losing its siblings, and a record whose keys cannot
 * be listed (a Proxy with a throwing `ownKeys`) yields no attributes rather than throwing.
 */
export function normalizeAttributes(attributes: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let keys: string[];
  try {
    keys = Object.keys(attributes);
  } catch {
    return out;
  }
  for (const key of keys) {
    try {
      const value = normalizeAttributeValue(attributes[key]);
      if (value !== undefined) setOwn(out, key, value);
    } catch {
      // unreadable attribute: skip it, keep the rest
    }
  }
  return out;
}

/**
 * The wire form of one attribute value: scalars and small homogeneous scalar arrays unchanged, anything else
 * one bounded JSON string. Total: never throws. `undefined` = drop the attribute.
 */
export function flattenAttributeValue(value: unknown): unknown {
  const normal = normalizeAttributeValue(value);
  if (normal === null || typeof normal !== 'object') return normal;
  return Array.isArray(normal) && isPassThroughArray(normal) ? normal : stringifyAnyValue(normal);
}

/** Flatten an attributes record for the wire. Returns the SAME record when nothing needed changing. */
export function flattenAttributes(attributes: Record<string, unknown>): Record<string, unknown> {
  let changed = false;
  const out: Record<string, unknown> = {};
  let keys: string[];
  try {
    keys = Object.keys(attributes);
  } catch {
    return {};
  }
  for (const key of keys) {
    try {
      const raw = attributes[key];
      const flat = flattenAttributeValue(raw);
      if (flat !== raw) changed = true;
      if (flat !== undefined) setOwn(out, key, flat);
    } catch {
      changed = true; // unreadable attribute: dropped
    }
  }
  return changed ? out : attributes;
}
