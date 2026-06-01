import type { Provider, Service, ServiceToken } from '@bugsee/service';

// The token-typed service facade over the generic @bugsee/service container (design §7.4/§302). The
// Client's per-process ServiceContainer is the "internal aggregated object" (BugseeInternal parity);
// these methods resolve/register by a contract's ServiceToken, so a platform/extension package supplies
// an impl and core resolves it WITHOUT importing the concrete impl — the token carries the type. Lives
// in this leaf module so both client.ts and carrier.ts can reference ServiceResolver without a
// client↔carrier import cycle.

/** The token-typed read surface over the container (the Client implements it). */
export interface ServiceResolver {
  /** The resolved service instance (instantiated lazily on first access); throws if unregistered. */
  getService<T>(token: ServiceToken<T>): T;
  /** The provider for a service (async `get`, late registration, onInit). */
  getServiceProvider<T>(token: ServiceToken<T>): Provider<T>;
}

/** Registers a contract-first component into the internal container (the Client implements it). */
export interface ServiceRegistrar {
  addService<T>(service: Service<T>): void;
}
