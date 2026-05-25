// @bugsee/service — per-Client service registry (design §4.4, §7.4). Firebase @firebase/component
// pattern, renamed and reduced to single-instance: LAZY (default) + EXPLICIT instantiation modes,
// pending-Deferred late registration, clearInstance, and onInit. No global registry, no EAGER mode.

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
  isComponentSet(): boolean;
  isInitialized(): boolean;
  /** Resolves with the instance — instantiating lazily, or awaiting late registration / explicit init. */
  get(): Promise<T>;
  /** Returns the instance synchronously; throws if unavailable (or returns null when optional). */
  getImmediate(): T;
  getImmediate(opts: { optional: true }): T | null;
  /** Instantiates with init options (required for EXPLICIT services). */
  initialize(options?: unknown): T;
  /** Registers the backing service definition (called by the container). */
  setComponent(service: Service<T>): void;
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
  let component: Service<T> | null = null;
  let instance: T | null = null;
  let deferred: Deferred<T> | null = null;
  let failure: { error: unknown } | null = null;
  const onInitCallbacks = new Set<(instance: T) => void>();

  const safeInvoke = (cb: (instance: T) => void, value: T): void => {
    try {
      cb(value);
    } catch {
      // A faulty onInit callback must never break instantiation or other callbacks.
    }
  };

  // Single instantiation point: resolves/rejects the pending deferred, fires onInit, and rethrows.
  const instantiate = (options?: unknown): T => {
    const service = component as Service<T>;
    try {
      const created = service.factory(container, options);
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
    }
  };

  return {
    name,
    isComponentSet: () => component !== null,
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
      if (component !== null && component.mode === 'LAZY') {
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
      if (failure !== null) {
        if (opts?.optional) {
          return null;
        }
        throw failure.error;
      }
      if (component === null) {
        if (opts?.optional) {
          return null;
        }
        throw new Error(`Service "${name}" is not registered`);
      }
      if (component.mode === 'EXPLICIT') {
        if (opts?.optional) {
          return null;
        }
        throw new Error(`Service "${name}" must be initialized via initialize() before use`);
      }
      return instantiate();
    },

    initialize(options?: unknown): T {
      if (component === null) {
        throw new Error(`Service "${name}" is not registered`);
      }
      if (instance !== null) {
        throw new Error(`Service "${name}" is already initialized`);
      }
      return instantiate(options);
    },

    setComponent(service: Service<T>): void {
      if (component !== null) {
        throw new Error(`Service "${name}" is already registered`);
      }
      component = service;
      // Late registration: a pending get() on a LAZY service instantiates now.
      if (deferred !== null && !deferred.settled && service.mode === 'LAZY') {
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
      getOrCreate<T>(service.name).setComponent(service);
    },
    getProvider<T>(name: string): Provider<T> {
      return getOrCreate<T>(name);
    },
  };

  return container;
}
