import type { NameExtensionMapping } from '@bugsee/types';

// Extension API registry (design §7.1, §16). An extension's setup() exposes its typed API via
// client.registerExt(name, api); consumers retrieve it with client.ext(name). Typed through the
// NameExtensionMapping declaration-merge target, so client.ext('performance') is fully typed only
// where the owning package's types are reachable (§16.3). The Extension lifecycle (setup/stop) is
// managed separately by the Client; this is just the typed name→API map.

export interface ExtensionRegistry {
  /** Register an extension's API under its name. Throws if the name is already registered. */
  registerExt<K extends keyof NameExtensionMapping>(name: K, api: NameExtensionMapping[K]): void;
  /** Retrieve a registered extension API. Throws if the name was never registered. */
  ext<K extends keyof NameExtensionMapping>(name: K): NameExtensionMapping[K];
  /** Whether an extension is registered under `name`. */
  hasExt<K extends keyof NameExtensionMapping>(name: K): boolean;
}

export function createExtensionRegistry(): ExtensionRegistry {
  const registry = new Map<string, unknown>();

  const registerExt = (name: string, api: unknown): void => {
    if (registry.has(name)) {
      throw new Error(`Extension "${name}" is already registered`);
    }
    registry.set(name, api);
  };

  const ext = (name: string): unknown => {
    if (!registry.has(name)) {
      throw new Error(`Extension "${name}" is not registered`);
    }
    return registry.get(name);
  };

  const hasExt = (name: string): boolean => registry.has(name);

  // The internal store is string-keyed; the public surface is typed via NameExtensionMapping.
  return { registerExt, ext, hasExt } as ExtensionRegistry;
}
