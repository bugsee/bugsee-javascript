// SDK option-key translation for `environment.sdk.options` (design §2.4 / §8.6). The mobile
// contract uses colon-separated keys on the wire; SDK option keys are dotted, so dots become
// colons. Applied only inside `environment.sdk.options`.

/** Wire form of an option key: dots -> colons. */
export function optionKeyToWire(key: string): string {
  return key.replaceAll('.', ':');
}

/** Inverse of optionKeyToWire: colons -> dots. */
export function optionKeyFromWire(key: string): string {
  return key.replaceAll(':', '.');
}

/**
 * Translates an options record's keys to wire form. The result is a null-prototype object so a
 * `__proto__` key (e.g. from a JSON-sourced options bag) is stored as own data and can never
 * corrupt a prototype.
 */
export function optionsToWire<V>(options: Record<string, V>): Record<string, V> {
  const out = Object.create(null) as Record<string, V>;
  for (const [key, value] of Object.entries(options)) {
    out[optionKeyToWire(key)] = value;
  }
  return out;
}
