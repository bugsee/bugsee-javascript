const MAX_STRING = 60;

/**
 * A short diagnostic text for a value the host supplied (an invalid option, ...). NEVER throws and never invokes
 * host code beyond a `name` read: `JSON.stringify` throws on a BigInt, `String(Object.create(null))` throws, and a
 * revoked proxy throws on `Array.isArray`, so a warning built from them could take the launch down with it (R5V-5).
 */
export function describeValue(value: unknown): string {
  try {
    switch (typeof value) {
      case 'string':
        return JSON.stringify(
          value.length > MAX_STRING ? `${value.slice(0, MAX_STRING - 3)}...` : value,
        );
      case 'bigint':
        return `${value}n`;
      case 'symbol':
        return value.toString();
      case 'function':
        return value.name === '' ? 'function' : `function ${value.name}`;
      case 'object':
        if (value === null) {
          return 'null';
        }
        return Array.isArray(value)
          ? `array(${value.length})`
          : Object.prototype.toString.call(value);
      default:
        return String(value);
    }
  } catch {
    return typeof value === 'function' ? 'function' : '[object]';
  }
}
