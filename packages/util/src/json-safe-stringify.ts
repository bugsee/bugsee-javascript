/**
 * `JSON.stringify` that never throws on circular references or BigInt values, for serializing
 * arbitrary captured data. Circular references become `"[Circular]"`; BigInt becomes its decimal
 * string. Values JSON omits at the top level (undefined, functions, symbols) yield `"null"`.
 *
 * Note: repeated (non-circular) references to the same object are also reported as `"[Circular]"`
 * — a deliberate simplification to keep this non-throwing and allocation-light.
 */
export function jsonSafeStringify(value: unknown, space?: string | number): string {
  const seen = new WeakSet<object>();
  const result = JSON.stringify(
    value,
    (_key: string, val: unknown): unknown => {
      if (typeof val === 'bigint') {
        return val.toString();
      }
      if (typeof val === 'object' && val !== null) {
        if (seen.has(val)) {
          return '[Circular]';
        }
        seen.add(val);
      }
      return val;
    },
    space,
  );
  return result ?? 'null';
}
