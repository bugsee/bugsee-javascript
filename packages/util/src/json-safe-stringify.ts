/** What a value that cannot be serialized at all becomes. Valid JSON, so the result always parses. */
const UNSERIALIZABLE = '"[Unserializable]"';

/**
 * `JSON.stringify` that NEVER throws, for serializing arbitrary captured data. Circular references
 * become `"[Circular]"`; BigInt becomes its decimal string. Values JSON omits at the top level
 * (undefined, functions, symbols) yield `"null"`. Anything that cannot be serialized at all yields
 * `"[Unserializable]"`.
 *
 * Totality is the contract, not a bonus. This runs inside the console interceptor's patched
 * `console.log`, so a throw does not merely lose one captured value — it surfaces inside the
 * APPLICATION's own call, which the SDK must never do. Circular references and BigInt were handled
 * explicitly; everything else was not, and "everything else" is reachable with ordinary application
 * objects:
 *   - a getter that throws (ORM row proxies, MobX/Vue reactives read outside their scope, detached
 *     DOM nodes) — `JSON.stringify` invokes it and propagates;
 *   - a `toJSON()` that throws, same;
 *   - a Proxy whose traps throw;
 *   - a deeply nested object, which overflows the recursion `JSON.stringify` does internally.
 *
 * Note: repeated (non-circular) references to the same object are also reported as `"[Circular]"`
 * — a deliberate simplification to keep this non-throwing and allocation-light.
 */
export function jsonSafeStringify(value: unknown, space?: string | number): string {
  const seen = new WeakSet<object>();
  try {
    return stringify(value, seen, space);
  } catch {
    // Deliberately swallowed: there is no safe way to report it from here (this is the app's call
    // stack), and the placeholder tells whoever reads the capture exactly what happened.
    return UNSERIALIZABLE;
  }
}

function stringify(value: unknown, seen: WeakSet<object>, space?: string | number): string {
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
