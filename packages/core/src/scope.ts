import type { AttributeValue, LogLevelName } from '@bugsee/types';
import { createRingBuffer } from './ring-buffer';

// The single, process-global scope (design §7.2: v3 removed the per-call/isolation scope API).
// Holds the identity and context merged into request.json at trigger time: user identifier,
// attributes (manifest.attrs), and the breadcrumb ring (capped at maxBreadcrumbs, §7.7).

export interface Breadcrumb {
  type?: string;
  category?: string;
  message?: string;
  level?: LogLevelName;
  data?: Record<string, unknown>;
  timestamp: number;
}

export interface Scope {
  setUserIdentifier(id: string): void;
  getUserIdentifier(): string | null;
  clearUserIdentifier(): void;

  setAttribute(key: string, value: AttributeValue): void;
  getAttribute(key: string): AttributeValue | undefined;
  clearAttribute(key: string): void;
  clearAllAttributes(): void;
  getAllAttributes(): Record<string, AttributeValue>;

  addBreadcrumb(breadcrumb: Breadcrumb): void;
  getBreadcrumbs(): Breadcrumb[];
  clearBreadcrumbs(): void;
}

export interface ScopeOptions {
  /** Breadcrumb ring capacity. Default 100 (§7.7). */
  maxBreadcrumbs?: number;
}

export function createScope(options?: ScopeOptions): Scope {
  let userIdentifier: string | null = null;
  // Map (not a plain object) so user-controlled attribute keys like `__proto__` can't pollute a
  // prototype; insertion order is preserved for getAllAttributes.
  const attributes = new Map<string, AttributeValue>();
  const breadcrumbs = createRingBuffer<Breadcrumb>(options?.maxBreadcrumbs ?? 100);

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

    addBreadcrumb(breadcrumb: Breadcrumb): void {
      breadcrumbs.push(breadcrumb);
    },
    getBreadcrumbs(): Breadcrumb[] {
      return breadcrumbs.toArray();
    },
    clearBreadcrumbs(): void {
      breadcrumbs.clear();
    },
  };
}
