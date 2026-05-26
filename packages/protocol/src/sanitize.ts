import { isSensitiveHeader, isSensitiveKey, REDACTED } from './sensitive';
import { redactShapes, type ShapeRedactionOptions } from './shapes';

// Object/header/param sanitization (design §8.10): apply the key denylists (§sensitive) and the
// shape pass (§shapes). Inputs are not mutated; outputs are null-prototype so a `__proto__` key
// (e.g. from JSON.parse'd untrusted data) is stored as own data and cannot corrupt a prototype.

/** Redacts sensitive header values entirely; shape-scans the rest. Header names/casing preserved. */
export function sanitizeHeaders(
  headers: Record<string, string>,
  options?: ShapeRedactionOptions,
): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  for (const [name, value] of Object.entries(headers)) {
    out[name] = isSensitiveHeader(name) ? REDACTED : redactShapes(value, options);
  }
  return out;
}

/** Flat query/form params: sensitive key -> redacted; other values shape-scanned. */
export function sanitizeParams(
  params: Record<string, string>,
  options?: ShapeRedactionOptions,
): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  for (const [key, value] of Object.entries(params)) {
    out[key] = isSensitiveKey(key) ? REDACTED : redactShapes(value, options);
  }
  return out;
}

/**
 * Recursively sanitizes a parsed JSON value: object keys checked against the key denylist (sensitive
 * -> redacted), string values shape-scanned, arrays/objects recursed, other primitives unchanged.
 */
export function sanitizeJson(value: unknown, options?: ShapeRedactionOptions): unknown {
  if (typeof value === 'string') {
    return redactShapes(value, options);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeJson(item, options));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = Object.create(null);
    for (const [key, val] of Object.entries(value)) {
      out[key] = isSensitiveKey(key) ? REDACTED : sanitizeJson(val, options);
    }
    return out;
  }
  return value;
}
