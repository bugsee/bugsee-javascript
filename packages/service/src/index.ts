// @bugsee/service — per-Client service registry (design §4.4, §7.4). Firebase @firebase/component
// pattern, renamed (Component -> Service, §0 item 1 / §4.4) and reduced to single-instance: LAZY (default) +
// EXPLICIT instantiation modes, pending-Deferred late registration, clearInstance, and onInit.
// No global registry, no EAGER mode.

import { createDeferred, type Deferred } from '@bugsee/util';

export type InstantiationMode = 'LAZY' | 'EXPLICIT';

/** Creates a service instance; `container` lets it resolve its own dependencies. */
export type ServiceFactory<T> = (container: ServiceContainer, options?: unknown) => T;

export interface Service<T = unknown> {
  readonly name: string;
  readonly factory: ServiceFactory<T>;
  readonly mode: InstantiationMode;
}

/** Defines a service. Default mode is LAZY (instantiated on first access). */
export function defineService<T>(
  name: string,
  factory: ServiceFactory<T>,
  mode: InstantiationMode = 'LAZY',
): Service<T> {
  return { name, factory, mode };
}

export interface Provider<T> {
  readonly name: string;
  isServiceSet(): boolean;
  isInitialized(): boolean;
  /**
   * Resolves with the instance — instantiating lazily, or awaiting late registration / explicit init.
   * A pending get() is rejected if `clearInstance()` runs first, so callers must handle the promise.
   */
  get(): Promise<T>;
  /** Returns the instance synchronously; throws if unavailable (or returns null when optional). */
  getImmediate(): T;
  getImmediate(opts: { optional: true }): T | null;
  /** Instantiates with init options (required for EXPLICIT services). */
  initialize(options?: unknown): T;
  /** Registers the backing service definition (called by the container). */
  setService(service: Service<T>): void;
  /** Drops the instance and rejects any pending get(). */
  clearInstance(): void;
  /** Runs `cb` when the instance is created (immediately if it already exists); returns unsubscribe. */
  onInit(cb: (instance: T) => void): () => void;
}

export interface ServiceContainer {
  addService<T>(service: Service<T>): void;
  getProvider<T>(name: string): Provider<T>;
}

function createProvider<T>(name: string, container: ServiceContainer): Provider<T> {
  let service: Service<T> | null = null;
  let instance: T | null = null;
  let deferred: Deferred<T> | null = null;
  let failure: { error: unknown } | null = null;
  let instantiating = false;
  const onInitCallbacks = new Set<(instance: T) => void>();

  const safeInvoke = (cb: (instance: T) => void, value: T): void => {
    try {
      cb(value);
    } catch {
      // A faulty onInit callback must never break instantiation or other callbacks.
    }
  };

  const circularError = (): Error =>
    new Error(`Service "${name}" has a circular dependency on itself during creation`);

  // Single instantiation point: resolves/rejects the pending deferred, fires onInit, rethrows.
  const instantiate = (options?: unknown): T => {
    const definition = service as Service<T>;
    if (instantiating) {
      throw circularError();
    }
    instantiating = true;
    try {
      const created = definition.factory(container, options);
      instance = created;
      deferred?.resolve(created);
      for (const cb of [...onInitCallbacks]) {
        safeInvoke(cb, created);
      }
      return created;
    } catch (error) {
      failure = { error };
      deferred?.reject(error);
      throw error;
    } finally {
      instantiating = false;
    }
  };

  return {
    name,
    isServiceSet: () => service !== null,
    isInitialized: () => instance !== null,

    get(): Promise<T> {
      if (instance !== null) {
        return Promise.resolve(instance);
      }
      if (failure !== null) {
        return Promise.reject(failure.error);
      }
      if (deferred === null) {
        deferred = createDeferred<T>();
      }
      if (service !== null && service.mode === 'LAZY') {
        try {
          instantiate();
        } catch {
          // failure recorded + deferred rejected inside instantiate
        }
      }
      return deferred.promise;
    },

    getImmediate(opts?: { optional?: boolean }): T | null {
      if (instance !== null) {
        return instance;
      }
      // A re-entrant getImmediate() during this provider's own construction is a self-cycle,
      // regardless of mode — surface it as a circular-dependency error, not "must be initialized".
      if (instantiating) {
        throw circularError();
      }
      if (failure !== null) {
        if (opts?.optional) {
          return null;
        }
        throw failure.error;
      }
      if (service === null) {
        if (opts?.optional) {
          return null;
        }
        throw new Error(`Service "${name}" is not registered`);
      }
      if (service.mode === 'EXPLICIT') {
        if (opts?.optional) {
          return null;
        }
        throw new Error(`Service "${name}" must be initialized via initialize() before use`);
      }
      return instantiate();
    },

    initialize(options?: unknown): T {
      if (failure !== null) {
        throw failure.error;
      }
      if (service === null) {
        throw new Error(`Service "${name}" is not registered`);
      }
      if (instance !== null) {
        throw new Error(`Service "${name}" is already initialized`);
      }
      return instantiate(options);
    },

    setService(definition: Service<T>): void {
      if (service !== null) {
        throw new Error(`Service "${name}" is already registered`);
      }
      service = definition;
      // Late registration: a pending get() on a LAZY service instantiates now. (A deferred present
      // here is always unsettled: before registration nothing instantiates, and clearInstance nulls it.)
      if (deferred !== null && definition.mode === 'LAZY') {
        try {
          instantiate();
        } catch {
          // failure recorded + deferred rejected inside instantiate
        }
      }
    },

    clearInstance(): void {
      if (deferred !== null && !deferred.settled) {
        deferred.reject(new Error(`Service "${name}" was cleared before it initialized`));
      }
      instance = null;
      deferred = null;
      failure = null;
    },

    onInit(cb: (instance: T) => void): () => void {
      onInitCallbacks.add(cb);
      if (instance !== null) {
        safeInvoke(cb, instance);
      }
      return () => {
        onInitCallbacks.delete(cb);
      };
    },
  } as Provider<T>;
}

export function createServiceContainer(): ServiceContainer {
  const providers = new Map<string, Provider<unknown>>();

  const getOrCreate = <T>(name: string): Provider<T> => {
    let provider = providers.get(name);
    if (provider === undefined) {
      provider = createProvider<unknown>(name, container);
      providers.set(name, provider);
    }
    return provider as Provider<T>;
  };

  const container: ServiceContainer = {
    addService<T>(service: Service<T>): void {
      getOrCreate<T>(service.name).setService(service);
    },
    getProvider<T>(name: string): Provider<T> {
      return getOrCreate<T>(name);
    },
  };

  return container;
}
