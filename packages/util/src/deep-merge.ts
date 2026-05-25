export type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Recursively merges `source` into a shallow copy of `target`. Plain objects are merged
 * key-by-key; everything else (arrays, primitives, class instances, null) from `source`
 * overrides. Inputs are not mutated. Used for scope/attribute/context merging (design §7.2).
 *
 * A `__proto__` key in `source` is ignored (never assigned), so untrusted data — e.g. a
 * `JSON.parse`'d attribute/context payload — cannot corrupt the result's prototype or pollute
 * `Object.prototype`. Nested non-plain values (arrays, class instances) are copied by reference,
 * not deep-cloned, so mutating them on the result also mutates them on `source`.
 */
export function deepMerge<T extends PlainObject>(target: T, source: PlainObject): T {
  const result: PlainObject = { ...target };
  for (const key of Object.keys(source)) {
    if (key === '__proto__') {
      continue;
    }
    const sourceValue = source[key];
    const targetValue = result[key];
    if (isPlainObject(sourceValue) && isPlainObject(targetValue)) {
      result[key] = deepMerge(targetValue, sourceValue);
    } else {
      result[key] = sourceValue;
    }
  }
  return result as T;
}
