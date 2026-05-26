import type { AttributeValue } from '@bugsee/types';

// The single global runtime state holder (Android BugseeEnvironment parity, design §7.2). Bugsee has
// no "scope" abstraction — one Environment per Client holds all state: the user identifier and custom
// attributes (→ manifest.attrs) now, and later the app/access token, options and build info, from
// which the EnvironmentEnvelope wire shape is produced.
//
// Breadcrumbs are NOT held here — they are a capture data stream produced by the breadcrumbs provider
// and routed through the aggregator like network/log entries.

export interface Environment {
  setUserIdentifier(id: string): void;
  getUserIdentifier(): string | null;
  clearUserIdentifier(): void;

  setAttribute(key: string, value: AttributeValue): void;
  getAttribute(key: string): AttributeValue | undefined;
  clearAttribute(key: string): void;
  clearAllAttributes(): void;
  getAllAttributes(): Record<string, AttributeValue>;
}

export function createEnvironment(): Environment {
  let userIdentifier: string | null = null;
  // Map (not a plain object) so user-controlled attribute keys like `__proto__` can't pollute a
  // prototype; insertion order is preserved for getAllAttributes.
  const attributes = new Map<string, AttributeValue>();

  return {
    setUserIdentifier(id: string): void {
      userIdentifier = id;
    },
    getUserIdentifier(): string | null {
      return userIdentifier;
    },
    clearUserIdentifier(): void {
      userIdentifier = null;
    },

    setAttribute(key: string, value: AttributeValue): void {
      attributes.set(key, value);
    },
    getAttribute(key: string): AttributeValue | undefined {
      return attributes.get(key);
    },
    clearAttribute(key: string): void {
      attributes.delete(key);
    },
    clearAllAttributes(): void {
      attributes.clear();
    },
    getAllAttributes(): Record<string, AttributeValue> {
      // Object.fromEntries creates own data properties (defineProperty semantics), so a `__proto__`
      // key becomes a plain own property rather than corrupting the prototype.
      return Object.fromEntries(attributes);
    },
  };
}
