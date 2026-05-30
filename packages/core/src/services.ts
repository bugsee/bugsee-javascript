import type { Provider, Service } from '@bugsee/service';
import type { NameServiceMapping } from '@bugsee/types';

// The typed service facade over the generic @bugsee/service container (design §7.4/§302). The Client's
// per-process ServiceContainer is the "internal aggregated object" (BugseeInternal parity); these typed
// methods key into the declaration-merged NameServiceMapping so a platform/extension package registers a
// service and core resolves it WITHOUT importing the concrete impl. Lives in this leaf module so both
// client.ts and carrier.ts can reference ServiceResolver without a client↔carrier import cycle.

/** The NameServiceMapping-typed read surface over the container (the Client implements it). */
export interface ServiceResolver {
  /** The resolved service instance (instantiated lazily on first access); throws if unregistered. */
  getService<K extends keyof NameServiceMapping>(name: K): NameServiceMapping[K];
  /** The provider for a service (async `get`, late registration, onInit). */
  getServiceProvider<K extends keyof NameServiceMapping>(name: K): Provider<NameServiceMapping[K]>;
}

/** Registers a contract-first component into the internal container (the Client implements it). */
export interface ServiceRegistrar {
  addService<K extends keyof NameServiceMapping>(service: Service<NameServiceMapping[K]>): void;
}
